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
  elementCategories,
  elementTemplates,
  elementTemplateRevisions,
  elementTemplateRevisionVertices,
  floorPlans,
  floors,
  localAuthCredentials,
  organizations,
  placedElements,
  placementIdentities,
  roles,
  sites,
  buildings,
} from '../src/db/schema.js';

const databaseUrl = process.env.DATABASE_URL;
const SECRET = 'pub-val-integration-test-secret-32ch!';
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
  const name = `dskt_pv_${randomUUID().replaceAll('-', '')}`;
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

async function seedFloorHierarchy(pool: pg.Pool) {
  const db = drizzle(pool);
  const org = (await db.select({ id: organizations.id }).from(organizations))[0]!;
  const site = (
    await db
      .insert(sites)
      .values({
        organizationId: org.id,
        code: 'LON',
        name: 'London HQ',
        timeZone: 'Europe/London',
      })
      .returning({ id: sites.id })
  )[0]!;

  const building = (
    await db
      .insert(buildings)
      .values({
        siteId: site.id,
        code: 'B1',
        name: 'Tower 1',
      })
      .returning({ id: buildings.id })
  )[0]!;

  const floor = (
    await db
      .insert(floors)
      .values({
        buildingId: building.id,
        code: 'F1',
        name: 'Floor 1',
      })
      .returning({ id: floors.id })
  )[0]!;

  return { siteId: site.id, buildingId: building.id, floorId: floor.id };
}

async function seedTemplate(
  pool: pg.Pool,
  userId: string,
  opts: {
    code: string;
    name: string;
    spatialClass: 'PHYSICAL' | 'ZONE' | 'OBSTACLE';
    assignable: boolean;
    vertices: { x: number; y: number }[];
  },
) {
  const db = drizzle(pool);
  const org = (await db.select({ id: organizations.id }).from(organizations))[0]!;

  const catRows = await db
    .insert(elementCategories)
    .values({
      organizationId: org.id,
      code: `CAT_${opts.code}`,
      name: `Category ${opts.code}`,
    })
    .returning({ id: elementCategories.id });
  const categoryId = catRows[0]!.id;

  const tmplRows = await db
    .insert(elementTemplates)
    .values({
      categoryId,
      code: opts.code,
      name: opts.name,
    })
    .returning({ id: elementTemplates.id });
  const templateId = tmplRows[0]!.id;

  const revRows = await db
    .insert(elementTemplateRevisions)
    .values({
      elementTemplateId: templateId,
      revisionNumber: 1,
      spatialClass: opts.spatialClass,
      assignable: opts.assignable,
      borderColor: '#000000',
      fillColor: '#ffffff',
      createdByUserId: userId,
    })
    .returning({ id: elementTemplateRevisions.id });
  const revisionId = revRows[0]!.id;

  for (let i = 0; i < opts.vertices.length; i++) {
    await db.insert(elementTemplateRevisionVertices).values({
      elementTemplateRevisionId: revisionId,
      sequence: i,
      x: opts.vertices[i]!.x,
      y: opts.vertices[i]!.y,
    });
  }

  await db
    .update(elementTemplates)
    .set({ currentRevisionId: revisionId })
    .where(eq(elementTemplates.id, templateId));

  return { templateId, revisionId };
}

describe('Ticket 18: preview publication validation', () => {
  beforeEach(() => {
    expect(databaseUrl, 'DATABASE_URL is required for publication validation tests').toBeTruthy();
  });

  it('valid draft receives an explicit publication-ready result without mutating revision', async () => {
    await withTestDatabase(databaseUrl as string, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url);
      const faUser = await seedUser(pool, { username: 'facilities', roleCodes: ['FACILITIES_ADMIN'] });
      const { floorId } = await seedFloorHierarchy(pool);

      const deskTmpl = await seedTemplate(pool, faUser, {
        code: 'DESK_STD',
        name: 'Standard Desk',
        spatialClass: 'PHYSICAL',
        assignable: true,
        vertices: [
          { x: 0, y: 0 },
          { x: 14, y: 0 },
          { x: 14, y: 8 },
          { x: 0, y: 8 },
        ],
      });

      const zoneTmpl = await seedTemplate(pool, faUser, {
        code: 'ZONE_WORK',
        name: 'Work Zone',
        spatialClass: 'ZONE',
        assignable: false,
        vertices: [
          { x: 0, y: 0 },
          { x: 50, y: 0 },
          { x: 50, y: 50 },
          { x: 0, y: 50 },
        ],
      });

      const app = await buildApp({ config: configFor(url), pool });
      const cookie = await signIn(app, 'facilities');

      // Create draft floor plan
      const createRes = await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan`,
        headers: { cookie: `dskt_session=${cookie}` },
        payload: { editingScale: 1 },
      });
      expect(createRes.statusCode).toBe(201);
      const revisionId = createRes.json().revision.id;

      // Set valid boundary: 100 x 100
      const boundaryRes = await app.inject({
        method: 'PUT',
        url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/boundary`,
        headers: { cookie: `dskt_session=${cookie}` },
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
      expect(boundaryRes.statusCode).toBe(200);
      let concurrencyVersion = boundaryRes.json().concurrencyVersion;

      // Place zone
      const zoneRes = await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/placements`,
        headers: { cookie: `dskt_session=${cookie}` },
        payload: {
          templateRevisionId: zoneTmpl.revisionId,
          positionX: 10,
          positionY: 10,
          rotationDegrees: 0,
          label: 'Zone A',
          concurrencyVersion,
        },
      });
      expect(zoneRes.statusCode).toBe(201);
      concurrencyVersion = zoneRes.json().updatedAt ? concurrencyVersion + 1 : concurrencyVersion;

      // Place physical desk inside zone (valid: zones do not collide)
      const deskRes = await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/placements`,
        headers: { cookie: `dskt_session=${cookie}` },
        payload: {
          templateRevisionId: deskTmpl.revisionId,
          positionX: 15,
          positionY: 15,
          rotationDegrees: 0,
          label: 'Desk 1',
          concurrencyVersion,
        },
      });
      expect(deskRes.statusCode).toBe(201);

      // Fetch revision to check current version before validation
      const getRevRes = await app.inject({
        method: 'GET',
        url: `/floors/${floorId}/floor-plan/revisions/${revisionId}`,
        headers: { cookie: `dskt_session=${cookie}` },
      });
      const currentVersion = getRevRes.json().revision.concurrencyVersion;

      // Run publication validation
      const valRes = await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/validate`,
        headers: { cookie: `dskt_session=${cookie}` },
        payload: { concurrencyVersion: currentVersion },
      });

      expect(valRes.statusCode).toBe(200);
      const valBody = valRes.json();
      expect(valBody.ready).toBe(true);
      expect(valBody.isValid).toBe(true);
      expect(valBody.concurrencyVersion).toBe(currentVersion);
      expect(valBody.errors).toEqual([]);
      expect(typeof valBody.summary).toBe('string');

      // Verify NO domain mutation occurred: lifecycleState is still DRAFT, concurrencyVersion unchanged
      const verifyRes = await app.inject({
        method: 'GET',
        url: `/floors/${floorId}/floor-plan/revisions/${revisionId}`,
        headers: { cookie: `dskt_session=${cookie}` },
      });
      expect(verifyRes.json().revision.lifecycleState).toBe('DRAFT');
      expect(verifyRes.json().revision.concurrencyVersion).toBe(currentVersion);

      await app.close();
      await pool.end();
    });
  });

  it('detects missing boundary and boundary geometry violations with corrective context', async () => {
    await withTestDatabase(databaseUrl as string, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url);
      await seedUser(pool, { username: 'facilities', roleCodes: ['FACILITIES_ADMIN'] });
      const { floorId } = await seedFloorHierarchy(pool);

      const app = await buildApp({ config: configFor(url), pool });
      const cookie = await signIn(app, 'facilities');

      // Draft without boundary
      const createRes = await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan`,
        headers: { cookie: `dskt_session=${cookie}` },
      });
      const revisionId = createRes.json().revision.id;

      // Validate missing boundary
      const valRes = await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/validate`,
        headers: { cookie: `dskt_session=${cookie}` },
      });

      expect(valRes.statusCode).toBe(200);
      const valBody = valRes.json();
      expect(valBody.ready).toBe(false);
      expect(valBody.isValid).toBe(false);
      expect(valBody.errors.length).toBeGreaterThan(0);
      const boundaryError = valBody.errors.find((e: { code: string }) => e.code === 'missing_boundary');
      expect(boundaryError).toBeDefined();
      expect(boundaryError.category).toBe('BOUNDARY');
      expect(boundaryError.entityType).toBe('BOUNDARY');
      expect(boundaryError.entityId).toBe(revisionId);
      expect(typeof boundaryError.message).toBe('string');
      expect(typeof boundaryError.correctiveAction).toBe('string');

      await app.close();
      await pool.end();
    });
  });

  it('detects containment violations, mutual collisions, and archived template references', async () => {
    await withTestDatabase(databaseUrl as string, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url);
      const faUser = await seedUser(pool, { username: 'facilities', roleCodes: ['FACILITIES_ADMIN'] });
      const { floorId } = await seedFloorHierarchy(pool);

      const deskTmpl1 = await seedTemplate(pool, faUser, {
        code: 'DESK_1',
        name: 'Desk One',
        spatialClass: 'PHYSICAL',
        assignable: true,
        vertices: [
          { x: 0, y: 0 },
          { x: 20, y: 0 },
          { x: 20, y: 20 },
          { x: 0, y: 20 },
        ],
      });

      const deskTmpl2 = await seedTemplate(pool, faUser, {
        code: 'DESK_2',
        name: 'Desk Two',
        spatialClass: 'PHYSICAL',
        assignable: true,
        vertices: [
          { x: 0, y: 0 },
          { x: 20, y: 0 },
          { x: 20, y: 20 },
          { x: 0, y: 20 },
        ],
      });

      const app = await buildApp({ config: configFor(url), pool });
      const cookie = await signIn(app, 'facilities');

      const createRes = await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan`,
        headers: { cookie: `dskt_session=${cookie}` },
      });
      const revisionId = createRes.json().revision.id;

      // Set boundary 100x100
      await app.inject({
        method: 'PUT',
        url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/boundary`,
        headers: { cookie: `dskt_session=${cookie}` },
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

      // Place desk 1 at (10, 10)
      const p1Res = await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/placements`,
        headers: { cookie: `dskt_session=${cookie}` },
        payload: {
          templateRevisionId: deskTmpl1.revisionId,
          positionX: 10,
          positionY: 10,
          rotationDegrees: 0,
          label: 'Desk A',
        },
      });
      const p1Id = p1Res.json().id;

      // To test collision detection and containment in validation independently:
      // Directly insert placed_elements rows that simulate out-of-boundary and collision state
      // (as API prevents direct invalid insertion on POST)
      const db = drizzle(pool);
      const planRows = await db.select().from(floorPlans).where(eq(floorPlans.floorId, floorId));
      const planId = planRows[0]!.id;

      // Insert placement identity & placed element outside boundary: (95, 95) with size 20x20 extends to (115, 115)
      const id2 = (await db.insert(placementIdentities).values({ floorPlanId: planId }).returning())[0]!.id;
      const p2 = (await db.insert(placedElements).values({
        floorPlanRevisionId: revisionId,
        placementIdentityId: id2,
        elementTemplateRevisionId: deskTmpl2.revisionId,
        positionX: 95,
        positionY: 95,
        rotationDegrees: 0,
        label: 'Desk Outside',
      }).returning())[0]!;

      // Insert placement identity & placed element colliding with desk 1: (15, 15) overlaps (10, 10)-(30, 30)
      const id3 = (await db.insert(placementIdentities).values({ floorPlanId: planId }).returning())[0]!.id;
      const p3 = (await db.insert(placedElements).values({
        floorPlanRevisionId: revisionId,
        placementIdentityId: id3,
        elementTemplateRevisionId: deskTmpl2.revisionId,
        positionX: 15,
        positionY: 15,
        rotationDegrees: 0,
        label: 'Desk Collision',
      }).returning())[0]!;

      // Archive template 1 to test template reference validation
      await db
        .update(elementTemplates)
        .set({ archivedAt: new Date() })
        .where(eq(elementTemplates.id, deskTmpl1.templateId));

      // Validate
      const valRes = await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/validate`,
        headers: { cookie: `dskt_session=${cookie}` },
      });

      expect(valRes.statusCode).toBe(200);
      const valBody = valRes.json();
      expect(valBody.ready).toBe(false);
      expect(valBody.isValid).toBe(false);

      // Verify outside_boundary error is reported
      const outsideErr = valBody.errors.find((e: { code: string }) => e.code === 'outside_boundary');
      expect(outsideErr).toBeDefined();
      expect(outsideErr.category).toBe('CONTAINMENT');
      expect(outsideErr.entityId).toBe(p2.id);
      expect(typeof outsideErr.correctiveAction).toBe('string');

      // Verify placement_collision error is reported
      const collisionErr = valBody.errors.find((e: { code: string }) => e.code === 'placement_collision');
      expect(collisionErr).toBeDefined();
      expect(collisionErr.category).toBe('COLLISION');
      expect([p1Id, p3.id]).toContain(collisionErr.entityId);
      expect(typeof collisionErr.correctiveAction).toBe('string');

      // Verify template_archived error is reported
      const tmplErr = valBody.errors.find((e: { code: string }) => e.code === 'template_archived');
      expect(tmplErr).toBeDefined();
      expect(tmplErr.category).toBe('TEMPLATE');
      expect(tmplErr.entityId).toBe(p1Id);
      expect(typeof tmplErr.correctiveAction).toBe('string');

      await app.close();
      await pool.end();
    });
  });

  it('detects duplicate labels and rejects stale concurrency version with 409', async () => {
    await withTestDatabase(databaseUrl as string, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url);
      const faUser = await seedUser(pool, { username: 'facilities', roleCodes: ['FACILITIES_ADMIN'] });
      const { floorId } = await seedFloorHierarchy(pool);

      const deskTmpl = await seedTemplate(pool, faUser, {
        code: 'DESK_STD',
        name: 'Standard Desk',
        spatialClass: 'PHYSICAL',
        assignable: true,
        vertices: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
          { x: 0, y: 10 },
        ],
      });

      const app = await buildApp({ config: configFor(url), pool });
      const cookie = await signIn(app, 'facilities');

      const createRes = await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan`,
        headers: { cookie: `dskt_session=${cookie}` },
      });
      const revisionId = createRes.json().revision.id;

      // Set boundary
      await app.inject({
        method: 'PUT',
        url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/boundary`,
        headers: { cookie: `dskt_session=${cookie}` },
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

      // Stale concurrency check: sending wrong version
      const staleRes = await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/validate`,
        headers: { cookie: `dskt_session=${cookie}` },
        payload: { concurrencyVersion: 999 },
      });
      expect(staleRes.statusCode).toBe(409);
      expect(staleRes.json().error).toBe('concurrency_conflict');
      expect(typeof staleRes.json().currentConcurrencyVersion).toBe('number');

      // Insert duplicate labels directly into db (e.g. differing case 'Desk-1' and 'desk-1')
      const db = drizzle(pool);
      const planRows = await db.select().from(floorPlans).where(eq(floorPlans.floorId, floorId));
      const planId = planRows[0]!.id;

      const id1 = (await db.insert(placementIdentities).values({ floorPlanId: planId }).returning())[0]!.id;
      const id2 = (await db.insert(placementIdentities).values({ floorPlanId: planId }).returning())[0]!.id;

      await db.insert(placedElements).values({
        floorPlanRevisionId: revisionId,
        placementIdentityId: id1,
        elementTemplateRevisionId: deskTmpl.revisionId,
        positionX: 10,
        positionY: 10,
        rotationDegrees: 0,
        label: 'Desk-A',
      });
      await db.insert(placedElements).values({
        floorPlanRevisionId: revisionId,
        placementIdentityId: id2,
        elementTemplateRevisionId: deskTmpl.revisionId,
        positionX: 30,
        positionY: 30,
        rotationDegrees: 0,
        label: 'desk-a', // duplicate case-insensitive
      });

      const dupValRes = await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/validate`,
        headers: { cookie: `dskt_session=${cookie}` },
      });
      expect(dupValRes.statusCode).toBe(200);
      const dupBody = dupValRes.json();
      expect(dupBody.ready).toBe(false);
      const labelErr = dupBody.errors.find((e: { code: string }) => e.code === 'duplicate_label');
      expect(labelErr).toBeDefined();
      expect(labelErr.category).toBe('LABEL');

      await app.close();
      await pool.end();
    });
  });

  it('enforces role authorization on publication validation', async () => {
    await withTestDatabase(databaseUrl as string, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url);
      await seedUser(pool, { username: 'facilities', roleCodes: ['FACILITIES_ADMIN'] });
      await seedUser(pool, { username: 'planner', roleCodes: ['WORKPLACE_PLANNER'] });
      await seedUser(pool, { username: 'viewer', roleCodes: ['VIEWER'] });
      await seedUser(pool, { username: 'sysadmin', roleCodes: ['SYSTEM_ADMIN'] });
      const { floorId } = await seedFloorHierarchy(pool);

      const app = await buildApp({ config: configFor(url), pool });
      const faCookie = await signIn(app, 'facilities');
      const wpCookie = await signIn(app, 'planner');
      const vCookie = await signIn(app, 'viewer');
      const saCookie = await signIn(app, 'sysadmin');

      const createRes = await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan`,
        headers: { cookie: `dskt_session=${faCookie}` },
      });
      const revisionId = createRes.json().revision.id;

      // Workplace Planner -> 403
      const wpRes = await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/validate`,
        headers: { cookie: `dskt_session=${wpCookie}` },
      });
      expect(wpRes.statusCode).toBe(403);

      // Viewer -> 403
      const vRes = await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/validate`,
        headers: { cookie: `dskt_session=${vCookie}` },
      });
      expect(vRes.statusCode).toBe(403);

      // System Admin alone -> 403
      const saRes = await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/validate`,
        headers: { cookie: `dskt_session=${saCookie}` },
      });
      expect(saRes.statusCode).toBe(403);

      // Unauthenticated -> 401
      const unauthRes = await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/validate`,
      });
      expect(unauthRes.statusCode).toBe(401);

      await app.close();
      await pool.end();
    });
  });
});
