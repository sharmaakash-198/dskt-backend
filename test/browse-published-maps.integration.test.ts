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
  buildings,
  elementCategories,
  elementTemplateRevisionVertices,
  elementTemplateRevisions,
  elementTemplates,
  floorPlanRevisions,
  floors,
  localAuthCredentials,
  organizations,
  roles,
  sites,
} from '../src/db/schema.js';

const databaseUrl = process.env.DATABASE_URL;
const SECRET = 'browse-published-maps-secret-32-bytes!';
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
  const name = `dskt_browse_${randomUUID().replaceAll('-', '')}`;
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

  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  await db.insert(localAuthCredentials).values({
    appUserId: userId,
    username: opts.username.toLowerCase(),
    passwordHash: hash,
  });

  for (const code of opts.roleCodes ?? []) {
    const roleRow = (
      await db.select({ id: roles.id }).from(roles).where(eq(roles.code, code))
    )[0];
    if (roleRow) {
      await db
        .insert(appUserRoles)
        .values({ appUserId: userId, roleId: roleRow.id, grantedByUserId: userId })
        .onConflictDoNothing();
    }
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
  return `dskt_session=${extractCookie(res.headers)!}`;
}

async function seedFloorHierarchy(pool: pg.Pool) {
  const db = drizzle(pool);
  const org = (await db.select({ id: organizations.id }).from(organizations))[0]!;
  const site = (
    await db
      .insert(sites)
      .values({
        organizationId: org.id,
        code: `SITE_${randomUUID().slice(0, 6)}`,
        name: 'Test Site',
        timeZone: 'Europe/London',
      })
      .returning({ id: sites.id })
  )[0]!;

  const building = (
    await db
      .insert(buildings)
      .values({
        siteId: site.id,
        code: `BLD_${randomUUID().slice(0, 6)}`,
        name: 'Test Building',
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
      code: `CAT_${randomUUID().slice(0, 8)}`,
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

describe('Ticket 20: Browse Published maps and revision history', () => {
  beforeEach(() => {
    if (!databaseUrl) {
      throw new Error('DATABASE_URL must be set to run integration tests.');
    }
  });

  it('Facilities Admin, Workplace Planner, and Viewer can all open the current Published map for an active Floor', async () => {
    await withTestDatabase(databaseUrl!, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url);

      const facUser = await seedUser(pool, { username: 'fac_admin', roleCodes: ['FACILITIES_ADMIN'] });
      await seedUser(pool, { username: 'wp_planner', roleCodes: ['WORKPLACE_PLANNER'] });
      await seedUser(pool, { username: 'viewer_user', roleCodes: ['VIEWER'] });

      const { floorId } = await seedFloorHierarchy(pool);

      const deskTmpl = await seedTemplate(pool, facUser, {
        code: 'DESK-STD',
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

      const zoneTmpl = await seedTemplate(pool, facUser, {
        code: 'ZONE-QUIET',
        name: 'Quiet Zone',
        spatialClass: 'ZONE',
        assignable: false,
        vertices: [
          { x: 0, y: 0 },
          { x: 40, y: 0 },
          { x: 40, y: 40 },
          { x: 0, y: 40 },
        ],
      });

      const obsTmpl = await seedTemplate(pool, facUser, {
        code: 'OBS-PILLAR',
        name: 'Pillar',
        spatialClass: 'OBSTACLE',
        assignable: false,
        vertices: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
          { x: 0, y: 10 },
        ],
      });

      const app = await buildApp({ config: configFor(url), pool });
      const facCookie = await signIn(app, 'fac_admin');
      const wpCookie = await signIn(app, 'wp_planner');
      const viewerCookie = await signIn(app, 'viewer_user');

      // Create draft floor plan
      const planRes = await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan`,
        headers: { cookie: facCookie },
        payload: { editingScale: 1 },
      });
      const revisionId = planRes.json().revision.id;

      // Set boundary
      await app.inject({
        method: 'PUT',
        url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/boundary`,
        headers: { cookie: facCookie },
        payload: {
          editingScale: 1,
          concurrencyVersion: 0,
          vertices: [
            { x: 0, y: 0 },
            { x: 100, y: 0 },
            { x: 100, y: 100 },
            { x: 0, y: 100 },
          ],
        },
      });

      // Place zone
      await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/placements`,
        headers: { cookie: facCookie },
        payload: {
          templateRevisionId: zoneTmpl.revisionId,
          positionX: 10,
          positionY: 10,
          rotationDegrees: 0,
          label: 'Zone 1',
          concurrencyVersion: 1,
        },
      });

      // Place desk inside zone
      await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/placements`,
        headers: { cookie: facCookie },
        payload: {
          templateRevisionId: deskTmpl.revisionId,
          positionX: 10,
          positionY: 10,
          rotationDegrees: 0,
          label: 'Desk 1',
          concurrencyVersion: 2,
        },
      });

      // Place obstacle outside zone
      await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/placements`,
        headers: { cookie: facCookie },
        payload: {
          templateRevisionId: obsTmpl.revisionId,
          positionX: 60,
          positionY: 60,
          rotationDegrees: 0,
          label: 'Pillar 1',
          concurrencyVersion: 3,
        },
      });

      // Publish the revision
      const pubRes = await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/publish`,
        headers: { cookie: facCookie },
        payload: { concurrencyVersion: 4 },
      });
      expect(pubRes.statusCode).toBe(200);

      // 1. Facilities Admin opens published map
      const facPub = await app.inject({
        method: 'GET',
        url: `/floors/${floorId}/floor-plan/published`,
        headers: { cookie: facCookie },
      });
      expect(facPub.statusCode).toBe(200);
      const facData = facPub.json();
      expect(facData.revision.lifecycleState).toBe('PUBLISHED');
      expect(facData.revision.boundary).toHaveLength(4);
      expect(facData.revision.placements).toHaveLength(3);

      const classes = facData.revision.placements.map((p: { spatialClass: string }) => p.spatialClass);
      expect(classes).toContain('ZONE');
      expect(classes).toContain('PHYSICAL');
      expect(classes).toContain('OBSTACLE');

      // 2. Workplace Planner opens published map
      const wpPub = await app.inject({
        method: 'GET',
        url: `/floors/${floorId}/floor-plan/published`,
        headers: { cookie: wpCookie },
      });
      expect(wpPub.statusCode).toBe(200);
      expect(wpPub.json().revision.lifecycleState).toBe('PUBLISHED');
      expect(wpPub.json().revision.placements).toHaveLength(3);

      // 3. Viewer opens published map
      const viewerPub = await app.inject({
        method: 'GET',
        url: `/floors/${floorId}/floor-plan/published`,
        headers: { cookie: viewerCookie },
      });
      expect(viewerPub.statusCode).toBe(200);
      expect(viewerPub.json().revision.lifecycleState).toBe('PUBLISHED');
      expect(viewerPub.json().revision.placements).toHaveLength(3);

      // 4. GET /floors/:floorId/floor-plan returns published revision to Workplace Planner and Viewer
      const wpPlan = await app.inject({
        method: 'GET',
        url: `/floors/${floorId}/floor-plan`,
        headers: { cookie: wpCookie },
      });
      expect(wpPlan.statusCode).toBe(200);
      expect(wpPlan.json().activeRevision.lifecycleState).toBe('PUBLISHED');
      expect(wpPlan.json().publishedRevision.lifecycleState).toBe('PUBLISHED');

      const viewerPlan = await app.inject({
        method: 'GET',
        url: `/floors/${floorId}/floor-plan`,
        headers: { cookie: viewerCookie },
      });
      expect(viewerPlan.statusCode).toBe(200);
      expect(viewerPlan.json().activeRevision.lifecycleState).toBe('PUBLISHED');

      await app.close();
      await pool.end();
    });
  });

  it('Role-specific projections: Facilities Admin sees Draft while Workplace Planner and Viewer see only Published', async () => {
    await withTestDatabase(databaseUrl!, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url);

      const facUser = await seedUser(pool, { username: 'fac_admin', roleCodes: ['FACILITIES_ADMIN'] });
      await seedUser(pool, { username: 'wp_planner', roleCodes: ['WORKPLACE_PLANNER'] });
      await seedUser(pool, { username: 'viewer_user', roleCodes: ['VIEWER'] });

      const { floorId } = await seedFloorHierarchy(pool);

      const app = await buildApp({ config: configFor(url), pool });
      const facCookie = await signIn(app, 'fac_admin');
      const wpCookie = await signIn(app, 'wp_planner');
      const viewerCookie = await signIn(app, 'viewer_user');

      // Create Revision 1 and publish it
      const planRes = await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan`,
        headers: { cookie: facCookie },
      });
      const rev1Id = planRes.json().revision.id;

      await app.inject({
        method: 'PUT',
        url: `/floors/${floorId}/floor-plan/revisions/${rev1Id}/boundary`,
        headers: { cookie: facCookie },
        payload: {
          editingScale: 1,
          concurrencyVersion: 0,
          vertices: [
            { x: 0, y: 0 },
            { x: 50, y: 0 },
            { x: 50, y: 50 },
            { x: 0, y: 50 },
          ],
        },
      });

      await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan/revisions/${rev1Id}/publish`,
        headers: { cookie: facCookie },
        payload: { concurrencyVersion: 1 },
      });

      // Insert Revision 2 as DRAFT
      const db = drizzle(pool);
      const rev2Rows = await db
        .insert(floorPlanRevisions)
        .values({
          floorPlanId: planRes.json().floorPlan.id,
          revisionNumber: 2,
          lifecycleState: 'DRAFT',
          editingScale: 2,
          concurrencyVersion: 0,
          createdByUserId: facUser,
        })
        .returning();
      const rev2Id = rev2Rows[0]!.id;

      // 1. Facilities Admin GET /floors/:floorId/floor-plan: activeRevision is DRAFT, publishedRevision is rev1
      const facPlan = await app.inject({
        method: 'GET',
        url: `/floors/${floorId}/floor-plan`,
        headers: { cookie: facCookie },
      });
      expect(facPlan.statusCode).toBe(200);
      expect(facPlan.json().activeRevision.id).toBe(rev2Id);
      expect(facPlan.json().activeRevision.lifecycleState).toBe('DRAFT');
      expect(facPlan.json().publishedRevision.id).toBe(rev1Id);
      expect(facPlan.json().publishedRevision.lifecycleState).toBe('PUBLISHED');

      // 2. Workplace Planner GET /floors/:floorId/floor-plan: activeRevision MUST be rev1 (PUBLISHED)
      const wpPlan = await app.inject({
        method: 'GET',
        url: `/floors/${floorId}/floor-plan`,
        headers: { cookie: wpCookie },
      });
      expect(wpPlan.statusCode).toBe(200);
      expect(wpPlan.json().activeRevision.id).toBe(rev1Id);
      expect(wpPlan.json().activeRevision.lifecycleState).toBe('PUBLISHED');
      expect(wpPlan.json().publishedRevision.id).toBe(rev1Id);

      // 3. Viewer GET /floors/:floorId/floor-plan: activeRevision MUST be rev1 (PUBLISHED)
      const viewerPlan = await app.inject({
        method: 'GET',
        url: `/floors/${floorId}/floor-plan`,
        headers: { cookie: viewerCookie },
      });
      expect(viewerPlan.statusCode).toBe(200);
      expect(viewerPlan.json().activeRevision.id).toBe(rev1Id);
      expect(viewerPlan.json().activeRevision.lifecycleState).toBe('PUBLISHED');

      // 4. Draft access denial: Workplace Planner and Viewer requesting rev2Id directly
      const wpDraftReq = await app.inject({
        method: 'GET',
        url: `/floors/${floorId}/floor-plan/revisions/${rev2Id}`,
        headers: { cookie: wpCookie },
      });
      expect(wpDraftReq.statusCode).toBe(403);
      expect(wpDraftReq.json().error).toBe('forbidden');

      const viewerDraftReq = await app.inject({
        method: 'GET',
        url: `/floors/${floorId}/floor-plan/revisions/${rev2Id}`,
        headers: { cookie: viewerCookie },
      });
      expect(viewerDraftReq.statusCode).toBe(403);
      expect(viewerDraftReq.json().error).toBe('forbidden');

      // Facilities Admin CAN access rev2Id
      const facDraftReq = await app.inject({
        method: 'GET',
        url: `/floors/${floorId}/floor-plan/revisions/${rev2Id}`,
        headers: { cookie: facCookie },
      });
      expect(facDraftReq.statusCode).toBe(200);
      expect(facDraftReq.json().revision.id).toBe(rev2Id);

      // 5. Revision list filtering:
      // Facilities Admin sees both revisions (Draft and Published)
      const facRevList = await app.inject({
        method: 'GET',
        url: `/floors/${floorId}/floor-plan/revisions`,
        headers: { cookie: facCookie },
      });
      expect(facRevList.statusCode).toBe(200);
      expect(facRevList.json().revisions).toHaveLength(2);

      // Workplace Planner and Viewer ONLY see the Published revision
      const wpRevList = await app.inject({
        method: 'GET',
        url: `/floors/${floorId}/floor-plan/revisions`,
        headers: { cookie: wpCookie },
      });
      expect(wpRevList.statusCode).toBe(200);
      expect(wpRevList.json().revisions).toHaveLength(1);
      expect(wpRevList.json().revisions[0].lifecycleState).toBe('PUBLISHED');

      const viewerRevList = await app.inject({
        method: 'GET',
        url: `/floors/${floorId}/floor-plan/revisions`,
        headers: { cookie: viewerCookie },
      });
      expect(viewerRevList.statusCode).toBe(200);
      expect(viewerRevList.json().revisions).toHaveLength(1);
      expect(viewerRevList.json().revisions[0].lifecycleState).toBe('PUBLISHED');

      await app.close();
      await pool.end();
    });
  });

  it('Draft and Archived access denial through HTTP for Workplace Planner and Viewer', async () => {
    await withTestDatabase(databaseUrl!, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url);

      const facUser = await seedUser(pool, { username: 'fac_admin', roleCodes: ['FACILITIES_ADMIN'] });
      await seedUser(pool, { username: 'wp_planner', roleCodes: ['WORKPLACE_PLANNER'] });
      await seedUser(pool, { username: 'viewer_user', roleCodes: ['VIEWER'] });

      const { floorId } = await seedFloorHierarchy(pool);

      const app = await buildApp({ config: configFor(url), pool });
      const facCookie = await signIn(app, 'fac_admin');
      const wpCookie = await signIn(app, 'wp_planner');
      const viewerCookie = await signIn(app, 'viewer_user');

      // 1. Create Revision 1 and publish it
      const planRes = await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan`,
        headers: { cookie: facCookie },
      });
      const rev1Id = planRes.json().revision.id;

      await app.inject({
        method: 'PUT',
        url: `/floors/${floorId}/floor-plan/revisions/${rev1Id}/boundary`,
        headers: { cookie: facCookie },
        payload: {
          editingScale: 1,
          concurrencyVersion: 0,
          vertices: [
            { x: 0, y: 0 },
            { x: 40, y: 0 },
            { x: 40, y: 40 },
            { x: 0, y: 40 },
          ],
        },
      });

      await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan/revisions/${rev1Id}/publish`,
        headers: { cookie: facCookie },
        payload: { concurrencyVersion: 1 },
      });

      // 2. Insert Revision 2 (Draft), set boundary, and publish it -> Rev 1 becomes ARCHIVED, Rev 2 becomes PUBLISHED
      const db = drizzle(pool);
      const rev2Rows = await db
        .insert(floorPlanRevisions)
        .values({
          floorPlanId: planRes.json().floorPlan.id,
          revisionNumber: 2,
          lifecycleState: 'DRAFT',
          editingScale: 1,
          concurrencyVersion: 0,
          createdByUserId: facUser,
        })
        .returning();
      const rev2Id = rev2Rows[0]!.id;

      await app.inject({
        method: 'PUT',
        url: `/floors/${floorId}/floor-plan/revisions/${rev2Id}/boundary`,
        headers: { cookie: facCookie },
        payload: {
          editingScale: 1,
          concurrencyVersion: 0,
          vertices: [
            { x: 0, y: 0 },
            { x: 60, y: 0 },
            { x: 60, y: 60 },
            { x: 0, y: 60 },
          ],
        },
      });

      await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan/revisions/${rev2Id}/publish`,
        headers: { cookie: facCookie },
        payload: { concurrencyVersion: 1 },
      });

      // Rev 1 is ARCHIVED, Rev 2 is PUBLISHED
      const r1 = await db.select().from(floorPlanRevisions).where(eq(floorPlanRevisions.id, rev1Id));
      expect(r1[0]!.lifecycleState).toBe('ARCHIVED');
      const r2 = await db.select().from(floorPlanRevisions).where(eq(floorPlanRevisions.id, rev2Id));
      expect(r2[0]!.lifecycleState).toBe('PUBLISHED');

      // 3. Test Archived revision access denial:
      // Facilities Admin can inspect Rev 1 (ARCHIVED)
      const facArchivedReq = await app.inject({
        method: 'GET',
        url: `/floors/${floorId}/floor-plan/revisions/${rev1Id}`,
        headers: { cookie: facCookie },
      });
      expect(facArchivedReq.statusCode).toBe(200);
      expect(facArchivedReq.json().revision.lifecycleState).toBe('ARCHIVED');

      // Workplace Planner is DENIED access to Rev 1 (ARCHIVED)
      const wpArchivedReq = await app.inject({
        method: 'GET',
        url: `/floors/${floorId}/floor-plan/revisions/${rev1Id}`,
        headers: { cookie: wpCookie },
      });
      expect(wpArchivedReq.statusCode).toBe(403);
      expect(wpArchivedReq.json().error).toBe('forbidden');

      // Viewer is DENIED access to Rev 1 (ARCHIVED)
      const viewerArchivedReq = await app.inject({
        method: 'GET',
        url: `/floors/${floorId}/floor-plan/revisions/${rev1Id}`,
        headers: { cookie: viewerCookie },
      });
      expect(viewerArchivedReq.statusCode).toBe(403);
      expect(viewerArchivedReq.json().error).toBe('forbidden');

      // All roles CAN inspect Rev 2 (PUBLISHED)
      const wpPublishedReq = await app.inject({
        method: 'GET',
        url: `/floors/${floorId}/floor-plan/revisions/${rev2Id}`,
        headers: { cookie: wpCookie },
      });
      expect(wpPublishedReq.statusCode).toBe(200);
      expect(wpPublishedReq.json().revision.lifecycleState).toBe('PUBLISHED');

      const viewerPublishedReq = await app.inject({
        method: 'GET',
        url: `/floors/${floorId}/floor-plan/revisions/${rev2Id}`,
        headers: { cookie: viewerCookie },
      });
      expect(viewerPublishedReq.statusCode).toBe(200);
      expect(viewerPublishedReq.json().revision.lifecycleState).toBe('PUBLISHED');

      await app.close();
      await pool.end();
    });
  });

  it('Empty, unpublished, archived-location, and unavailable states are explicit', async () => {
    await withTestDatabase(databaseUrl!, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url);

      await seedUser(pool, { username: 'fac_admin', roleCodes: ['FACILITIES_ADMIN'] });
      await seedUser(pool, { username: 'viewer_user', roleCodes: ['VIEWER'] });

      const { siteId, buildingId, floorId: floor1Id } = await seedFloorHierarchy(pool);

      const db = drizzle(pool);
      const floor2Rows = await db
        .insert(floors)
        .values({
          buildingId,
          code: 'F2',
          name: 'Floor 2 (Unpublished)',
        })
        .returning({ id: floors.id });
      const floor2Id = floor2Rows[0]!.id;

      const app = await buildApp({ config: configFor(url), pool });
      const facCookie = await signIn(app, 'fac_admin');
      const viewerCookie = await signIn(app, 'viewer_user');

      // 1. Empty floor: Floor 1 has no floor plan
      const emptyGet = await app.inject({
        method: 'GET',
        url: `/floors/${floor1Id}/floor-plan`,
        headers: { cookie: viewerCookie },
      });
      expect(emptyGet.statusCode).toBe(200);
      expect(emptyGet.json().floorPlan).toBeNull();
      expect(emptyGet.json().activeRevision).toBeNull();

      const emptyPub = await app.inject({
        method: 'GET',
        url: `/floors/${floor1Id}/floor-plan/published`,
        headers: { cookie: viewerCookie },
      });
      expect(emptyPub.statusCode).toBe(404);
      expect(emptyPub.json().error).toBe('floor_plan_not_found');

      // 2. Unpublished floor: Floor 2 has draft floor plan but no published revision
      await app.inject({
        method: 'POST',
        url: `/floors/${floor2Id}/floor-plan`,
        headers: { cookie: facCookie },
      });

      const unpubViewer = await app.inject({
        method: 'GET',
        url: `/floors/${floor2Id}/floor-plan`,
        headers: { cookie: viewerCookie },
      });
      expect(unpubViewer.statusCode).toBe(200);
      expect(unpubViewer.json().floorPlan).not.toBeNull();
      expect(unpubViewer.json().activeRevision).toBeNull(); // No published revision, so null for viewer
      expect(unpubViewer.json().publishedRevision).toBeNull();

      const unpubPub = await app.inject({
        method: 'GET',
        url: `/floors/${floor2Id}/floor-plan/published`,
        headers: { cookie: viewerCookie },
      });
      expect(unpubPub.statusCode).toBe(404);
      expect(unpubPub.json().error).toBe('published_revision_not_found');

      // 3. Archived Floor: Archive Floor 2
      await app.inject({
        method: 'POST',
        url: `/floors/${floor2Id}/archive`,
        headers: { cookie: facCookie },
      });

      const archivedFloorReq = await app.inject({
        method: 'GET',
        url: `/floors/${floor2Id}/floor-plan/published`,
        headers: { cookie: viewerCookie },
      });
      expect(archivedFloorReq.statusCode).toBe(409);
      expect(archivedFloorReq.json().error).toBe('floor_archived');

      // 4. Archived Building
      const floor3Rows = await db
        .insert(floors)
        .values({
          buildingId,
          code: 'F3',
          name: 'Floor 3',
        })
        .returning({ id: floors.id });
      const floor3Id = floor3Rows[0]!.id;

      // Archive building directly in db to test building_archived check
      await db.update(buildings).set({ archivedAt: new Date() }).where(eq(buildings.id, buildingId));

      const archivedBldgReq = await app.inject({
        method: 'GET',
        url: `/floors/${floor3Id}/floor-plan/published`,
        headers: { cookie: viewerCookie },
      });
      expect(archivedBldgReq.statusCode).toBe(409);
      expect(archivedBldgReq.json().error).toBe('building_archived');

      // 5. Archived Site
      await db.update(sites).set({ archivedAt: new Date() }).where(eq(sites.id, siteId));

      const archivedSiteReq = await app.inject({
        method: 'GET',
        url: `/floors/${floor3Id}/floor-plan/published`,
        headers: { cookie: viewerCookie },
      });
      expect(archivedSiteReq.statusCode).toBe(409);
      expect(archivedSiteReq.json().error).toBe('site_archived');

      await app.close();
      await pool.end();
    });
  });

  it('No editing controls or mutation endpoints are available to Workplace Planner or Viewer', async () => {
    await withTestDatabase(databaseUrl!, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url);

      await seedUser(pool, { username: 'fac_admin', roleCodes: ['FACILITIES_ADMIN'] });
      await seedUser(pool, { username: 'wp_planner', roleCodes: ['WORKPLACE_PLANNER'] });
      await seedUser(pool, { username: 'viewer_user', roleCodes: ['VIEWER'] });

      const { floorId } = await seedFloorHierarchy(pool);

      const app = await buildApp({ config: configFor(url), pool });
      const facCookie = await signIn(app, 'fac_admin');
      const wpCookie = await signIn(app, 'wp_planner');
      const viewerCookie = await signIn(app, 'viewer_user');

      const planRes = await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan`,
        headers: { cookie: facCookie },
      });
      const revisionId = planRes.json().revision.id;

      // Workplace Planner and Viewer attempt mutation endpoints
      for (const cookie of [wpCookie, viewerCookie]) {
        // 1. Create floor plan
        const mut1 = await app.inject({
          method: 'POST',
          url: `/floors/${floorId}/floor-plan`,
          headers: { cookie },
        });
        expect(mut1.statusCode).toBe(403);

        // 2. Edit boundary
        const mut2 = await app.inject({
          method: 'PUT',
          url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/boundary`,
          headers: { cookie },
          payload: {
            editingScale: 1,
            concurrencyVersion: 0,
            vertices: [
              { x: 0, y: 0 },
              { x: 10, y: 0 },
              { x: 10, y: 10 },
              { x: 0, y: 10 },
            ],
          },
        });
        expect(mut2.statusCode).toBe(403);

        // 3. Acquire lease
        const mut3 = await app.inject({
          method: 'POST',
          url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/lease`,
          headers: { cookie },
        });
        expect(mut3.statusCode).toBe(403);

        // 4. Place element
        const mut4 = await app.inject({
          method: 'POST',
          url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/placements`,
          headers: { cookie },
          payload: { templateRevisionId: randomUUID(), positionX: 0, positionY: 0 },
        });
        expect(mut4.statusCode).toBe(403);

        // 5. Publish revision
        const mut5 = await app.inject({
          method: 'POST',
          url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/publish`,
          headers: { cookie },
          payload: { concurrencyVersion: 0 },
        });
        expect(mut5.statusCode).toBe(403);
      }

      await app.close();
      await pool.end();
    });
  });
});
