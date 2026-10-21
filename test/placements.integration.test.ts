import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import type { RoleCode } from '../src/auth/principal.js';
import { applyMigrations } from '../src/db/migrate.js';
import {
  appUserIdentities,
  appUserRoles,
  appUsers,
  localAuthCredentials,
  organizations,
  placedElements,
  placementIdentities,
  roles,
} from '../src/db/schema.js';

const databaseUrl = process.env.DATABASE_URL;
const SECRET = 'placements-integration-test-secret-32ch!';
const PASSWORD = 'correct-horse-battery-staple';

function configFor(url: string): AppConfig {
  return {
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: 3001,
    DATABASE_URL: url,
    CORS_ORIGIN: 'http://localhost:8080',
    LOG_LEVEL: 'silent',
    AUTH_ENV: 'local',
    SESSION_SECRET: SECRET,
    SESSION_TTL_SECONDS: 3600,
  };
}

async function withTestDatabase(
  baseUrl: string,
  run: (url: string) => Promise<void>,
): Promise<void> {
  const adminUrl = new URL(baseUrl);
  adminUrl.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  const name = `dskt_pl_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  const next = new URL(baseUrl);
  next.pathname = `/${name}`;
  try {
    await run(next.toString());
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  }
}

function createPool(url: string, max = 2): pg.Pool {
  const pool = new pg.Pool({ connectionString: url, max });
  pool.on('error', () => undefined);
  return pool;
}

async function seedUser(
  pool: pg.Pool,
  opts: { username: string; roleCodes?: RoleCode[] },
): Promise<string> {
  const db = drizzle(pool);
  const inserted = await db
    .insert(organizations)
    .values({ name: 'Arrise' })
    .onConflictDoNothing()
    .returning({ id: organizations.id });
  const orgId =
    inserted[0]?.id ??
    (await db.select({ id: organizations.id }).from(organizations))[0]!.id;

  const userId = (
    await db
      .insert(appUsers)
      .values({
        organizationId: orgId,
        email: `${opts.username}@test.local`,
        displayName: opts.username,
        active: true,
      })
      .returning({ id: appUsers.id })
  )[0]!.id;

  await db.insert(appUserIdentities).values({
    appUserId: userId,
    provider: 'LOCAL',
    providerSubject: opts.username.toLowerCase(),
  });
  await db.insert(localAuthCredentials).values({
    appUserId: userId,
    username: opts.username.toLowerCase(),
    passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }),
  });
  for (const code of opts.roleCodes ?? []) {
    const roleRows = await db.select({ id: roles.id }).from(roles).where(eq(roles.code, code));
    await db.insert(appUserRoles).values({
      appUserId: userId,
      roleId: roleRows[0]!.id,
      grantedByUserId: userId,
    });
  }
  return userId;
}

function extractCookie(
  headers: Record<string, number | string | string[] | undefined>,
): string | undefined {
  const raw = headers['set-cookie'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (typeof header !== 'string') return undefined;
  return header.match(/dskt_session=([^;]+)/)?.[1];
}

async function signIn(
  app: Awaited<ReturnType<typeof buildApp>>,
  username: string,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/local/sign-in',
    payload: { username, password: PASSWORD },
  });
  expect(res.statusCode).toBe(200);
  return extractCookie(res.headers)!;
}

describe('place physical space', () => {
  beforeEach(() => {
    expect(databaseUrl, 'DATABASE_URL is required for placements integration tests').toBeTruthy();
  });

  it('places a current physical template revision within draft floor boundary and pins it', async () => {
    await withTestDatabase(databaseUrl!, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url);
      try {
        await seedUser(pool, { username: 'facilities', roleCodes: ['FACILITIES_ADMIN'] });

        const app = await buildApp({ config: configFor(url), pool });
        try {
          const cookie = await signIn(app, 'facilities');

          // 1. Create Site, Building, Floor
          const siteRes = await app.inject({
            method: 'POST',
            url: '/sites',
            headers: { cookie: `dskt_session=${cookie}` },
            payload: { code: 'PL-SITE-1', name: 'Placement Site', timeZone: 'America/New_York' },
          });
          const siteId = siteRes.json().id;

          const bldRes = await app.inject({
            method: 'POST',
            url: `/sites/${siteId}/buildings`,
            headers: { cookie: `dskt_session=${cookie}` },
            payload: { code: 'B1', name: 'Building 1' },
          });
          const buildingId = bldRes.json().id;

          const floorRes = await app.inject({
            method: 'POST',
            url: `/buildings/${buildingId}/floors`,
            headers: { cookie: `dskt_session=${cookie}` },
            payload: { code: 'F1', name: 'Floor 1' },
          });
          const floorId = floorRes.json().id;

          // 2. Create Draft Floor Plan with boundary [0,0] to [200, 150]
          const planRes = await app.inject({
            method: 'POST',
            url: `/floors/${floorId}/floor-plan`,
            headers: { cookie: `dskt_session=${cookie}` },
            payload: { editingScale: 16 },
          });
          const revisionId = planRes.json().revision.id;

          const boundaryRes = await app.inject({
            method: 'PUT',
            url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/boundary`,
            headers: { cookie: `dskt_session=${cookie}` },
            payload: {
              concurrencyVersion: 0,
              vertices: [
                { x: 0, y: 0 },
                { x: 200, y: 0 },
                { x: 200, y: 150 },
                { x: 0, y: 150 },
              ],
            },
          });
          expect(boundaryRes.statusCode).toBe(200);

          // 3. Create Template, Revision 1, and activate it
          const catRes = await app.inject({
            method: 'POST',
            url: '/element-categories',
            headers: { cookie: `dskt_session=${cookie}` },
            payload: { code: 'WORKSTATIONS', name: 'Workstations' },
          });
          const categoryId = catRes.json().id;

          const tmplRes = await app.inject({
            method: 'POST',
            url: `/element-categories/${categoryId}/templates`,
            headers: { cookie: `dskt_session=${cookie}` },
            payload: { code: 'DESK-STD', name: 'Standard Desk' },
          });
          const templateId = tmplRes.json().id;

          const rev1Res = await app.inject({
            method: 'POST',
            url: `/element-templates/${templateId}/revisions`,
            headers: { cookie: `dskt_session=${cookie}` },
            payload: {
              spatialClass: 'PHYSICAL',
              assignable: true,
              borderColor: '#1E3A8A',
              fillColor: '#93C5FD',
              vertices: [
                { x: 0, y: 0 },
                { x: 20, y: 0 },
                { x: 20, y: 10 },
                { x: 0, y: 10 },
              ],
            },
          });
          expect(rev1Res.statusCode).toBe(201);
          const templateRev1Id = rev1Res.json().id;

          // Activate Revision 1
          const act1 = await app.inject({
            method: 'POST',
            url: `/element-templates/${templateId}/revisions/${templateRev1Id}/activate`,
            headers: { cookie: `dskt_session=${cookie}` },
          });
          expect(act1.statusCode).toBe(200);

          // 4. Place element at position (10, 10) with rotation 0
          const placeRes = await app.inject({
            method: 'POST',
            url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/placements`,
            headers: { cookie: `dskt_session=${cookie}` },
            payload: {
              templateRevisionId: templateRev1Id,
              positionX: 10,
              positionY: 10,
              rotationDegrees: 0,
              label: 'D-101',
            },
          });
          expect(placeRes.statusCode).toBe(201);
          const placed = placeRes.json();
          expect(placed.placementIdentityId).toBeTruthy();
          expect(placed.elementTemplateRevisionId).toBe(templateRev1Id);
          expect(placed.positionX).toBe(10);
          expect(placed.positionY).toBe(10);
          expect(placed.rotationDegrees).toBe(0);
          expect(placed.label).toBe('D-101');
          expect(placed.spatialClass).toBe('PHYSICAL');
          // Transformed vertices in world coords: (10, 10), (30, 10), (30, 20), (10, 20)
          expect(placed.vertices).toEqual([
            { x: 10, y: 10 },
            { x: 30, y: 10 },
            { x: 30, y: 20 },
            { x: 10, y: 20 },
          ]);

          // 5. Verify Template Pinning: create revision 2, activate revision 2, placed element remains pinned to revision 1
          const rev2Res = await app.inject({
            method: 'POST',
            url: `/element-templates/${templateId}/revisions`,
            headers: { cookie: `dskt_session=${cookie}` },
            payload: {
              spatialClass: 'PHYSICAL',
              assignable: true,
              borderColor: '#047857',
              fillColor: '#a7f3d0',
              vertices: [
                { x: 0, y: 0 },
                { x: 30, y: 0 },
                { x: 30, y: 15 },
                { x: 0, y: 15 },
              ],
            },
          });
          const templateRev2Id = rev2Res.json().id;

          const act2 = await app.inject({
            method: 'POST',
            url: `/element-templates/${templateId}/revisions/${templateRev2Id}/activate`,
            headers: { cookie: `dskt_session=${cookie}` },
          });
          expect(act2.statusCode).toBe(200);

          // List placements: original placement is still pinned to revision 1
          const listRes = await app.inject({
            method: 'GET',
            url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/placements`,
            headers: { cookie: `dskt_session=${cookie}` },
          });
          expect(listRes.statusCode).toBe(200);
          expect(listRes.json().placements).toHaveLength(1);
          expect(listRes.json().placements[0].elementTemplateRevisionId).toBe(templateRev1Id);
          expect(listRes.json().placements[0].vertices).toEqual([
            { x: 10, y: 10 },
            { x: 30, y: 10 },
            { x: 30, y: 20 },
            { x: 10, y: 20 },
          ]);
        } finally {
          await app.close();
        }
      } finally {
        await pool.end();
      }
    });
  });

  it('rejects placement outside boundary, non-current templates, collision, and unauthorized roles', async () => {
    await withTestDatabase(databaseUrl!, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url);
      try {
        await seedUser(pool, { username: 'facilities', roleCodes: ['FACILITIES_ADMIN'] });
        await seedUser(pool, { username: 'workplace', roleCodes: ['WORKPLACE_PLANNER'] });
        await seedUser(pool, { username: 'viewer', roleCodes: ['VIEWER'] });

        const app = await buildApp({ config: configFor(url), pool });
        try {
          const facilitiesCookie = await signIn(app, 'facilities');
          const workplaceCookie = await signIn(app, 'workplace');
          const viewerCookie = await signIn(app, 'viewer');

          // Create Site, Building, Floor
          const siteRes = await app.inject({
            method: 'POST',
            url: '/sites',
            headers: { cookie: `dskt_session=${facilitiesCookie}` },
            payload: { code: 'PL-SITE-2', name: 'Placement Site 2', timeZone: 'America/New_York' },
          });
          const siteId = siteRes.json().id;

          const bldRes = await app.inject({
            method: 'POST',
            url: `/sites/${siteId}/buildings`,
            headers: { cookie: `dskt_session=${facilitiesCookie}` },
            payload: { code: 'B2', name: 'Building 2' },
          });
          const buildingId = bldRes.json().id;

          const floorRes = await app.inject({
            method: 'POST',
            url: `/buildings/${buildingId}/floors`,
            headers: { cookie: `dskt_session=${facilitiesCookie}` },
            payload: { code: 'F2', name: 'Floor 2' },
          });
          const floorId = floorRes.json().id;

          // Create Draft Floor Plan with boundary [0,0] to [100, 100]
          const planRes = await app.inject({
            method: 'POST',
            url: `/floors/${floorId}/floor-plan`,
            headers: { cookie: `dskt_session=${facilitiesCookie}` },
            payload: { editingScale: 16 },
          });
          const revisionId = planRes.json().revision.id;

          await app.inject({
            method: 'PUT',
            url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/boundary`,
            headers: { cookie: `dskt_session=${facilitiesCookie}` },
            payload: {
              concurrencyVersion: 0,
              vertices: [
                { x: 0, y: 0 },
                { x: 100, y: 0 },
                { x: 100, y: 100 },
                { x: 0, y: 100 },
              ],
            },
          });

          // Create Template and revision (not activated yet)
          const catRes = await app.inject({
            method: 'POST',
            url: '/element-categories',
            headers: { cookie: `dskt_session=${facilitiesCookie}` },
            payload: { code: 'OFFICES', name: 'Offices' },
          });
          const categoryId = catRes.json().id;

          const tmplRes = await app.inject({
            method: 'POST',
            url: `/element-categories/${categoryId}/templates`,
            headers: { cookie: `dskt_session=${facilitiesCookie}` },
            payload: { code: 'OFFICE-STD', name: 'Standard Office' },
          });
          const templateId = tmplRes.json().id;

          const revRes = await app.inject({
            method: 'POST',
            url: `/element-templates/${templateId}/revisions`,
            headers: { cookie: `dskt_session=${facilitiesCookie}` },
            payload: {
              spatialClass: 'PHYSICAL',
              assignable: true,
              borderColor: '#1E3A8A',
              fillColor: '#93C5FD',
              vertices: [
                { x: 0, y: 0 },
                { x: 40, y: 0 },
                { x: 40, y: 30 },
                { x: 0, y: 30 },
              ],
            },
          });
          const templateRevId = revRes.json().id;

          // 1. Rejects placement because revision is NOT current
          const notCurrentRes = await app.inject({
            method: 'POST',
            url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/placements`,
            headers: { cookie: `dskt_session=${facilitiesCookie}` },
            payload: {
              templateRevisionId: templateRevId,
              positionX: 10,
              positionY: 10,
            },
          });
          expect(notCurrentRes.statusCode).toBe(400);
          expect(notCurrentRes.json().error).toBe('template_revision_not_current');

          // Now activate it
          const actRes = await app.inject({
            method: 'POST',
            url: `/element-templates/${templateId}/revisions/${templateRevId}/activate`,
            headers: { cookie: `dskt_session=${facilitiesCookie}` },
          });
          expect(actRes.statusCode).toBe(200);

          // 2. Rejects placement outside boundary
          const outsideRes = await app.inject({
            method: 'POST',
            url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/placements`,
            headers: { cookie: `dskt_session=${facilitiesCookie}` },
            payload: {
              templateRevisionId: templateRevId,
              positionX: 80, // [80, 120] exceeds boundary width 100!
              positionY: 10,
            },
          });
          expect(outsideRes.statusCode).toBe(400);
          expect(outsideRes.json().error).toBe('outside_boundary');

          // 3. Successful placement at (10, 10)
          const successRes = await app.inject({
            method: 'POST',
            url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/placements`,
            headers: { cookie: `dskt_session=${facilitiesCookie}` },
            payload: {
              templateRevisionId: templateRevId,
              positionX: 10,
              positionY: 10,
            },
          });
          expect(successRes.statusCode).toBe(201);

          // 4. Rejects collision (overlapping interior) with existing space at (10, 10)
          const collideRes = await app.inject({
            method: 'POST',
            url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/placements`,
            headers: { cookie: `dskt_session=${facilitiesCookie}` },
            payload: {
              templateRevisionId: templateRevId,
              positionX: 20, // Overlaps with [10, 50] x [10, 40]
              positionY: 20,
            },
          });
          expect(collideRes.statusCode).toBe(400);
          expect(collideRes.json().error).toBe('placement_collision');

          // 5. Authorization: Workplace Planner and Viewer are denied
          const wpRes = await app.inject({
            method: 'POST',
            url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/placements`,
            headers: { cookie: `dskt_session=${workplaceCookie}` },
            payload: {
              templateRevisionId: templateRevId,
              positionX: 55,
              positionY: 10,
            },
          });
          expect(wpRes.statusCode).toBe(403);

          const viewerRes = await app.inject({
            method: 'POST',
            url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/placements`,
            headers: { cookie: `dskt_session=${viewerCookie}` },
            payload: {
              templateRevisionId: templateRevId,
              positionX: 55,
              positionY: 10,
            },
          });
          expect(viewerRes.statusCode).toBe(403);
        } finally {
          await app.close();
        }
      } finally {
        await pool.end();
      }
    });
  });

  it('transforms placed spaces with translation, quarter-turns, concurrency protection, rejection of resize, and preserves identity on removal', async () => {
    if (!databaseUrl) {
      expect(true).toBe(true);
      return;
    }

    await withTestDatabase(databaseUrl, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url);
      try {
        await seedUser(pool, { username: 'fac-1', roleCodes: ['FACILITIES_ADMIN'] });
        await seedUser(pool, { username: 'wp-1', roleCodes: ['WORKPLACE_PLANNER'] });

        const app = await buildApp({ config: configFor(url), pool });
        try {
          const facilitiesCookie = await signIn(app, 'fac-1');

          // Setup Site, Building, Floor
          const siteRes = await app.inject({
            method: 'POST',
            url: '/sites',
            headers: { cookie: `dskt_session=${facilitiesCookie}` },
            payload: { code: 'SITE-1', name: 'Main Campus', timeZone: 'America/New_York' },
          });
          const siteId = siteRes.json().id;

          const bldgRes = await app.inject({
            method: 'POST',
            url: `/sites/${siteId}/buildings`,
            headers: { cookie: `dskt_session=${facilitiesCookie}` },
            payload: { code: 'BLDG-A', name: 'Building A' },
          });
          const buildingId = bldgRes.json().id;

          const floorRes = await app.inject({
            method: 'POST',
            url: `/buildings/${buildingId}/floors`,
            headers: { cookie: `dskt_session=${facilitiesCookie}` },
            payload: { code: 'FL-1', name: 'Floor 1' },
          });
          expect(floorRes.statusCode).toBe(201);
          const floorId = floorRes.json().id;

          // Create Draft Floor Plan
          const planRes = await app.inject({
            method: 'POST',
            url: `/floors/${floorId}/floor-plan`,
            headers: { cookie: `dskt_session=${facilitiesCookie}` },
            payload: { editingScale: 1 },
          });
          const revisionId = planRes.json().revision.id;

          // Save 200x150 Boundary
          await app.inject({
            method: 'PUT',
            url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/boundary`,
            headers: { cookie: `dskt_session=${facilitiesCookie}` },
            payload: {
              concurrencyVersion: 0,
              vertices: [
                { x: 0, y: 0 },
                { x: 200, y: 0 },
                { x: 200, y: 150 },
                { x: 0, y: 150 },
              ],
            },
          });

          // Create Template and activate
          const catRes = await app.inject({
            method: 'POST',
            url: '/element-categories',
            headers: { cookie: `dskt_session=${facilitiesCookie}` },
            payload: { code: 'ROOMS', name: 'Rooms' },
          });
          const categoryId = catRes.json().id;

          const tmplRes = await app.inject({
            method: 'POST',
            url: `/element-categories/${categoryId}/templates`,
            headers: { cookie: `dskt_session=${facilitiesCookie}` },
            payload: { code: 'OFFICE-STD', name: 'Standard Office' },
          });
          const templateId = tmplRes.json().id;

          const revRes = await app.inject({
            method: 'POST',
            url: `/element-templates/${templateId}/revisions`,
            headers: { cookie: `dskt_session=${facilitiesCookie}` },
            payload: {
              spatialClass: 'PHYSICAL',
              assignable: true,
              borderColor: '#1E3A8A',
              fillColor: '#93C5FD',
              vertices: [
                { x: 0, y: 0 },
                { x: 40, y: 0 },
                { x: 40, y: 30 },
                { x: 0, y: 30 },
              ],
            },
          });
          const templateRevId = revRes.json().id;

          await app.inject({
            method: 'POST',
            url: `/element-templates/${templateId}/revisions/${templateRevId}/activate`,
            headers: { cookie: `dskt_session=${facilitiesCookie}` },
          });

          // Place element at (10, 10)
          const placeRes = await app.inject({
            method: 'POST',
            url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/placements`,
            headers: { cookie: `dskt_session=${facilitiesCookie}` },
            payload: {
              templateRevisionId: templateRevId,
              positionX: 10,
              positionY: 10,
              rotationDegrees: 0,
              label: 'Office 101',
            },
          });
          expect(placeRes.statusCode).toBe(201);
          const placed = placeRes.json();
          expect(placed.positionX).toBe(10);
          expect(placed.positionY).toBe(10);
          expect(placed.rotationDegrees).toBe(0);
          expect(placed.assignable).toBe(true);
          expect(placed.templateRevisionNumber).toBe(1);
          const placementId = placed.id;
          const placementIdentityId = placed.placementIdentityId;

          // 1. Translate placement: move to (50, 60)
          const transRes = await app.inject({
            method: 'PATCH',
            url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/placements/${placementId}`,
            headers: { cookie: `dskt_session=${facilitiesCookie}` },
            payload: {
              positionX: 50,
              positionY: 60,
              concurrencyVersion: 2, // 0 -> 1 (boundary) -> 2 (place)
            },
          });
          expect(transRes.statusCode).toBe(200);
          const translated = transRes.json();
          expect(translated.positionX).toBe(50);
          expect(translated.positionY).toBe(60);
          expect(translated.rotationDegrees).toBe(0);
          expect(translated.vertices).toEqual([
            { x: 50, y: 60 },
            { x: 90, y: 60 },
            { x: 90, y: 90 },
            { x: 50, y: 90 },
          ]);

          // 2. Rotate placement: quarter-turn to 90 degrees
          const rotRes = await app.inject({
            method: 'PATCH',
            url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/placements/${placementId}`,
            headers: { cookie: `dskt_session=${facilitiesCookie}` },
            payload: {
              rotationDegrees: 90,
              concurrencyVersion: 3,
            },
          });
          expect(rotRes.statusCode).toBe(200);
          const rotated = rotRes.json();
          expect(rotated.rotationDegrees).toBe(90);
          expect(rotated.vertices).toEqual([
            { x: 50, y: 60 },
            { x: 50, y: 100 },
            { x: 20, y: 100 },
            { x: 20, y: 60 },
          ]);

          // 3. Reject invalid rotation (e.g. 45 degrees)
          const invRotRes = await app.inject({
            method: 'PATCH',
            url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/placements/${placementId}`,
            headers: { cookie: `dskt_session=${facilitiesCookie}` },
            payload: {
              rotationDegrees: 45,
            },
          });
          expect(invRotRes.statusCode).toBe(400);

          // 4. Reject attempt to resize (unrecognized properties forbidden by schema)
          const resizeRes = await app.inject({
            method: 'PATCH',
            url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/placements/${placementId}`,
            headers: { cookie: `dskt_session=${facilitiesCookie}` },
            payload: {
              positionX: 50,
              width: 100,
              height: 100,
            },
          });
          expect(resizeRes.statusCode).toBe(400);

          // 5. Concurrency protection: stale concurrencyVersion returns 409
          const conflictRes = await app.inject({
            method: 'PATCH',
            url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/placements/${placementId}`,
            headers: { cookie: `dskt_session=${facilitiesCookie}` },
            payload: {
              positionX: 60,
              positionY: 60,
              concurrencyVersion: 1, // Stale! Current is 4
            },
          });
          expect(conflictRes.statusCode).toBe(409);
          expect(conflictRes.json().error).toBe('concurrency_conflict');

          // 6. Delete placement from Draft
          const delRes = await app.inject({
            method: 'DELETE',
            url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/placements/${placementId}?concurrencyVersion=4`,
            headers: { cookie: `dskt_session=${facilitiesCookie}` },
          });
          expect(delRes.statusCode).toBe(200);

          // Verify placement no longer listed in this draft revision
          const listRes = await app.inject({
            method: 'GET',
            url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/placements`,
            headers: { cookie: `dskt_session=${facilitiesCookie}` },
          });
          expect(listRes.json().placements).toEqual([]);

          // 7. Verify stable placement identity record is PRESERVED in PostgreSQL
          const db = drizzle(pool);
          const identityRows = await db
            .select()
            .from(placementIdentities)
            .where(eq(placementIdentities.id, placementIdentityId));
          expect(identityRows.length).toBe(1);
          expect(identityRows[0]!.id).toBe(placementIdentityId);

          // Verify placed_elements row is deleted
          const placedRows = await db
            .select()
            .from(placedElements)
            .where(eq(placedElements.id, placementId));
          expect(placedRows.length).toBe(0);
        } finally {
          await app.close();
        }
      } finally {
        await pool.end();
      }
    });
  });

  describe('place zones and obstacles', () => {
    it('places ZONE and OBSTACLE templates, allows zones to overlap and contain physicals/obstacles, and rejects boundary violations or mutual collisions', async () => {
      await withTestDatabase(databaseUrl!, async (url) => {
        await applyMigrations(url);
        const pool = createPool(url);
        try {
          await seedUser(pool, { username: 'facilities', roleCodes: ['FACILITIES_ADMIN'] });
          await seedUser(pool, { username: 'workplace', roleCodes: ['WORKPLACE_PLANNER'] });
          await seedUser(pool, { username: 'viewer', roleCodes: ['VIEWER'] });

          const app = await buildApp({ config: configFor(url), pool });
          try {
            const facilitiesCookie = await signIn(app, 'facilities');
            const workplaceCookie = await signIn(app, 'workplace');
            const viewerCookie = await signIn(app, 'viewer');

            // 1. Setup Site, Building, Floor, and Draft Floor Plan [0,0] to [300, 200]
            const siteRes = await app.inject({
              method: 'POST',
              url: '/sites',
              headers: { cookie: `dskt_session=${facilitiesCookie}` },
              payload: { code: 'ZO-SITE', name: 'Zones Obstacles Site', timeZone: 'America/New_York' },
            });
            const siteId = siteRes.json().id;

            const bldRes = await app.inject({
              method: 'POST',
              url: `/sites/${siteId}/buildings`,
              headers: { cookie: `dskt_session=${facilitiesCookie}` },
              payload: { code: 'B1', name: 'Building 1' },
            });
            const buildingId = bldRes.json().id;

            const floorRes = await app.inject({
              method: 'POST',
              url: `/buildings/${buildingId}/floors`,
              headers: { cookie: `dskt_session=${facilitiesCookie}` },
              payload: { code: 'F1', name: 'Floor 1' },
            });
            const floorId = floorRes.json().id;

            const planRes = await app.inject({
              method: 'POST',
              url: `/floors/${floorId}/floor-plan`,
              headers: { cookie: `dskt_session=${facilitiesCookie}` },
              payload: { editingScale: 16 },
            });
            const revisionId = planRes.json().revision.id;

            await app.inject({
              method: 'PUT',
              url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/boundary`,
              headers: { cookie: `dskt_session=${facilitiesCookie}` },
              payload: {
                concurrencyVersion: 0,
                vertices: [
                  { x: 0, y: 0 },
                  { x: 300, y: 0 },
                  { x: 300, y: 200 },
                  { x: 0, y: 200 },
                ],
              },
            });

            // 2. Setup Categories and Templates for ZONE, OBSTACLE, and PHYSICAL
            const catRes = await app.inject({
              method: 'POST',
              url: '/element-categories',
              headers: { cookie: `dskt_session=${facilitiesCookie}` },
              payload: { code: 'MIXED-CAT', name: 'Mixed Elements' },
            });
            const catId = catRes.json().id;

            // ZONE Template: 100 x 80
            const zoneTmplRes = await app.inject({
              method: 'POST',
              url: `/element-categories/${catId}/templates`,
              headers: { cookie: `dskt_session=${facilitiesCookie}` },
              payload: { code: 'ZONE-TEAM', name: 'Team Zone' },
            });
            const zoneTmplId = zoneTmplRes.json().id;
            const zoneRevRes = await app.inject({
              method: 'POST',
              url: `/element-templates/${zoneTmplId}/revisions`,
              headers: { cookie: `dskt_session=${facilitiesCookie}` },
              payload: {
                spatialClass: 'ZONE',
                assignable: false,
                borderColor: '#047857',
                fillColor: '#D1FAE5',
                vertices: [
                  { x: 0, y: 0 },
                  { x: 100, y: 0 },
                  { x: 100, y: 80 },
                  { x: 0, y: 80 },
                ],
              },
            });
            const zoneRevId = zoneRevRes.json().id;
            await app.inject({
              method: 'POST',
              url: `/element-templates/${zoneTmplId}/revisions/${zoneRevId}/activate`,
              headers: { cookie: `dskt_session=${facilitiesCookie}` },
            });

            // OBSTACLE Template: 20 x 20
            const obsTmplRes = await app.inject({
              method: 'POST',
              url: `/element-categories/${catId}/templates`,
              headers: { cookie: `dskt_session=${facilitiesCookie}` },
              payload: { code: 'COL-PILLAR', name: 'Structural Column' },
            });
            const obsTmplId = obsTmplRes.json().id;
            const obsRevRes = await app.inject({
              method: 'POST',
              url: `/element-templates/${obsTmplId}/revisions`,
              headers: { cookie: `dskt_session=${facilitiesCookie}` },
              payload: {
                spatialClass: 'OBSTACLE',
                assignable: false,
                borderColor: '#B91C1C',
                fillColor: '#FEE2E2',
                vertices: [
                  { x: 0, y: 0 },
                  { x: 20, y: 0 },
                  { x: 20, y: 20 },
                  { x: 0, y: 20 },
                ],
              },
            });
            const obsRevId = obsRevRes.json().id;
            await app.inject({
              method: 'POST',
              url: `/element-templates/${obsTmplId}/revisions/${obsRevId}/activate`,
              headers: { cookie: `dskt_session=${facilitiesCookie}` },
            });

            // PHYSICAL Template: 30 x 20
            const physTmplRes = await app.inject({
              method: 'POST',
              url: `/element-categories/${catId}/templates`,
              headers: { cookie: `dskt_session=${facilitiesCookie}` },
              payload: { code: 'DESK-PL', name: 'Standard Desk' },
            });
            const physTmplId = physTmplRes.json().id;
            const physRevRes = await app.inject({
              method: 'POST',
              url: `/element-templates/${physTmplId}/revisions`,
              headers: { cookie: `dskt_session=${facilitiesCookie}` },
              payload: {
                spatialClass: 'PHYSICAL',
                assignable: true,
                borderColor: '#1D4ED8',
                fillColor: '#DBEAFE',
                vertices: [
                  { x: 0, y: 0 },
                  { x: 30, y: 0 },
                  { x: 30, y: 20 },
                  { x: 0, y: 20 },
                ],
              },
            });
            const physRevId = physRevRes.json().id;
            await app.inject({
              method: 'POST',
              url: `/element-templates/${physTmplId}/revisions/${physRevId}/activate`,
              headers: { cookie: `dskt_session=${facilitiesCookie}` },
            });

            // 3. Place Zone 1 at (10, 10)
            const zone1Res = await app.inject({
              method: 'POST',
              url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/placements`,
              headers: { cookie: `dskt_session=${facilitiesCookie}` },
              payload: {
                templateRevisionId: zoneRevId,
                positionX: 10,
                positionY: 10,
                label: 'Engineering Zone',
              },
            });
            expect(zone1Res.statusCode).toBe(201);
            expect(zone1Res.json().spatialClass).toBe('ZONE');
            const zone1Id = zone1Res.json().id;

            // 4. Place Zone 2 at (50, 50) - Overlaps Zone 1 (Valid: Zones can overlap zones)
            const zone2Res = await app.inject({
              method: 'POST',
              url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/placements`,
              headers: { cookie: `dskt_session=${facilitiesCookie}` },
              payload: {
                templateRevisionId: zoneRevId,
                positionX: 50,
                positionY: 50,
                label: 'Collaboration Zone',
              },
            });
            expect(zone2Res.statusCode).toBe(201);
            expect(zone2Res.json().spatialClass).toBe('ZONE');

            // 5. Place Physical desk at (20, 20) - Contained inside Zone 1 (Valid: Zones contain physical)
            const phys1Res = await app.inject({
              method: 'POST',
              url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/placements`,
              headers: { cookie: `dskt_session=${facilitiesCookie}` },
              payload: {
                templateRevisionId: physRevId,
                positionX: 20,
                positionY: 20,
                label: 'Desk 1',
              },
            });
            expect(phys1Res.statusCode).toBe(201);
            expect(phys1Res.json().spatialClass).toBe('PHYSICAL');

            // 6. Place Obstacle column at (60, 60) - Inside Zone 1 & Zone 2 (Valid: Zones contain obstacles)
            const obs1Res = await app.inject({
              method: 'POST',
              url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/placements`,
              headers: { cookie: `dskt_session=${facilitiesCookie}` },
              payload: {
                templateRevisionId: obsRevId,
                positionX: 60,
                positionY: 60,
                label: 'Column 1',
              },
            });
            expect(obs1Res.statusCode).toBe(201);
            expect(obs1Res.json().spatialClass).toBe('OBSTACLE');
            const obs1Id = obs1Res.json().id;

            // 7. Mutual collision: Physical overlaps Obstacle -> 400
            // Obstacle is at [60, 80] x [60, 80]. Trying to place Physical (30x20) at (50, 70) overlaps interior.
            const physColRes = await app.inject({
              method: 'POST',
              url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/placements`,
              headers: { cookie: `dskt_session=${facilitiesCookie}` },
              payload: {
                templateRevisionId: physRevId,
                positionX: 50,
                positionY: 70,
              },
            });
            expect(physColRes.statusCode).toBe(400);
            expect(physColRes.json().error).toBe('placement_collision');

            // 8. Mutual collision: Obstacle overlaps Physical -> 400
            // Physical is at [20, 50] x [20, 40]. Trying to place Obstacle (20x20) at (30, 25) overlaps interior.
            const obsColRes = await app.inject({
              method: 'POST',
              url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/placements`,
              headers: { cookie: `dskt_session=${facilitiesCookie}` },
              payload: {
                templateRevisionId: obsRevId,
                positionX: 30,
                positionY: 25,
              },
            });
            expect(obsColRes.statusCode).toBe(400);
            expect(obsColRes.json().error).toBe('placement_collision');

            // 9. Mutual collision: Obstacle overlaps Obstacle -> 400
            // Obstacle is at [60, 80] x [60, 80]. Trying to place Obstacle at (70, 70) overlaps interior.
            const obsObsColRes = await app.inject({
              method: 'POST',
              url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/placements`,
              headers: { cookie: `dskt_session=${facilitiesCookie}` },
              payload: {
                templateRevisionId: obsRevId,
                positionX: 70,
                positionY: 70,
              },
            });
            expect(obsObsColRes.statusCode).toBe(400);
            expect(obsObsColRes.json().error).toBe('placement_collision');

            // 10. Touching edges without interior intersection is permitted:
            // Physical is at [20, 50] x [20, 40]. Place Obstacle (20x20) at (50, 20) -> touches right edge at x=50.
            const touchRes = await app.inject({
              method: 'POST',
              url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/placements`,
              headers: { cookie: `dskt_session=${facilitiesCookie}` },
              payload: {
                templateRevisionId: obsRevId,
                positionX: 50,
                positionY: 20,
              },
            });
            expect(touchRes.statusCode).toBe(201);

            // 11. Boundary containment: ZONE outside boundary -> 400 outside_boundary
            // Floor boundary is [0,0] to [300, 200]. Zone (100x80) placed at (250, 150) reaches (350, 230).
            const zoneOutRes = await app.inject({
              method: 'POST',
              url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/placements`,
              headers: { cookie: `dskt_session=${facilitiesCookie}` },
              payload: {
                templateRevisionId: zoneRevId,
                positionX: 250,
                positionY: 150,
              },
            });
            expect(zoneOutRes.statusCode).toBe(400);
            expect(zoneOutRes.json().error).toBe('outside_boundary');

            // 12. Boundary containment: OBSTACLE outside boundary -> 400 outside_boundary
            const obsOutRes = await app.inject({
              method: 'POST',
              url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/placements`,
              headers: { cookie: `dskt_session=${facilitiesCookie}` },
              payload: {
                templateRevisionId: obsRevId,
                positionX: 290,
                positionY: 190,
              },
            });
            expect(obsOutRes.statusCode).toBe(400);
            expect(obsOutRes.json().error).toBe('outside_boundary');

            // 13. Quarter-turn transforms and translations on ZONE and OBSTACLE
            // Rotate Zone 1 by 90 degrees (translated to position (100, 10) so rotated footprint [20,100]x[10,110] stays inside boundary)
            const zoneRotRes = await app.inject({
              method: 'PATCH',
              url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/placements/${zone1Id}`,
              headers: { cookie: `dskt_session=${facilitiesCookie}` },
              payload: {
                positionX: 100,
                positionY: 10,
                rotationDegrees: 90,
              },
            });
            expect(zoneRotRes.statusCode).toBe(200);
            expect(zoneRotRes.json().rotationDegrees).toBe(90);
            expect(zoneRotRes.json().positionX).toBe(100);

            // Rotate Obstacle 1 by 180 degrees and translate
            const obsPatchRes = await app.inject({
              method: 'PATCH',
              url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/placements/${obs1Id}`,
              headers: { cookie: `dskt_session=${facilitiesCookie}` },
              payload: {
                positionX: 120,
                positionY: 120,
                rotationDegrees: 180,
              },
            });
            expect(obsPatchRes.statusCode).toBe(200);
            expect(obsPatchRes.json().positionX).toBe(120);
            expect(obsPatchRes.json().positionY).toBe(120);
            expect(obsPatchRes.json().rotationDegrees).toBe(180);

            // 14. Authorization: Workplace Planner and Viewer denied mutations
            const wpPlaceZone = await app.inject({
              method: 'POST',
              url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/placements`,
              headers: { cookie: `dskt_session=${workplaceCookie}` },
              payload: { templateRevisionId: zoneRevId, positionX: 100, positionY: 100 },
            });
            expect(wpPlaceZone.statusCode).toBe(403);

            const viewerPlaceObs = await app.inject({
              method: 'POST',
              url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/placements`,
              headers: { cookie: `dskt_session=${viewerCookie}` },
              payload: { templateRevisionId: obsRevId, positionX: 100, positionY: 100 },
            });
            expect(viewerPlaceObs.statusCode).toBe(403);

            const wpPatchZone = await app.inject({
              method: 'PATCH',
              url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/placements/${zone1Id}`,
              headers: { cookie: `dskt_session=${workplaceCookie}` },
              payload: { positionX: 15 },
            });
            expect(wpPatchZone.statusCode).toBe(403);

            const viewerDeleteObs = await app.inject({
              method: 'DELETE',
              url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/placements/${obs1Id}`,
              headers: { cookie: `dskt_session=${viewerCookie}` },
            });
            expect(viewerDeleteObs.statusCode).toBe(403);

            // 15. Listing placements as Workplace Planner and Viewer returns all classes
            const wpList = await app.inject({
              method: 'GET',
              url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/placements`,
              headers: { cookie: `dskt_session=${workplaceCookie}` },
            });
            expect(wpList.statusCode).toBe(200);
            const returnedClasses = (wpList.json().placements as Array<{ spatialClass: string }>).map((p) => p.spatialClass);
            expect(returnedClasses).toContain('ZONE');
            expect(returnedClasses).toContain('OBSTACLE');
            expect(returnedClasses).toContain('PHYSICAL');
          } finally {
            await app.close();
          }
        } finally {
          await pool.end();
        }
      });
    });
  });
});
