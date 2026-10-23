import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { and, eq } from 'drizzle-orm';
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
  auditEvents,
  buildings,
  elementCategories,
  elementTemplateRevisionVertices,
  elementTemplateRevisions,
  elementTemplates,
  floorPlanEditorLeases,
  floorPlanRevisions,
  floors,
  localAuthCredentials,
  organizations,
  roles,
  sites,
} from '../src/db/schema.js';

const databaseUrl = process.env.DATABASE_URL;
const SECRET = 'publish-integration-test-secret-32!';
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
  const name = `dskt_pub_${randomUUID().replaceAll('-', '')}`;
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

describe('Ticket 19: publish a floor plan', () => {
  beforeEach(() => {
    expect(databaseUrl, 'DATABASE_URL is required for publish tests').toBeTruthy();
  });

  it('publishes valid draft as immutable published revision with audit and lease release', async () => {
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

      // Acquire an editor lease
      const leaseRes = await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/lease`,
        headers: { cookie: `dskt_session=${cookie}` },
        payload: { durationSeconds: 60 },
      });
      expect(leaseRes.statusCode).toBe(200);
      const leaseToken = leaseRes.json().token;
      expect(leaseToken).toBeTruthy();

      // Set valid boundary: 100 x 100
      const boundaryRes = await app.inject({
        method: 'PUT',
        url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/boundary`,
        headers: {
          cookie: `dskt_session=${cookie}`,
          'x-lease-token': leaseToken,
        },
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
      const versionAfterBoundary = boundaryRes.json().concurrencyVersion;

      // Place a desk inside boundary
      const placeRes = await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/placements`,
        headers: {
          cookie: `dskt_session=${cookie}`,
          'x-lease-token': leaseToken,
        },
        payload: {
          templateRevisionId: deskTmpl.revisionId,
          positionX: 10,
          positionY: 10,
          rotationDegrees: 0,
          label: 'Desk 1',
          concurrencyVersion: versionAfterBoundary,
        },
      });
      expect(placeRes.statusCode).toBe(201);

      // Fetch draft to get latest concurrency version
      const getRevRes = await app.inject({
        method: 'GET',
        url: `/floors/${floorId}/floor-plan/revisions/${revisionId}`,
        headers: { cookie: `dskt_session=${cookie}` },
      });
      const currentVersion = getRevRes.json().revision.concurrencyVersion;

      // Publish the draft
      const publishRes = await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/publish`,
        headers: {
          cookie: `dskt_session=${cookie}`,
          'x-lease-token': leaseToken,
        },
        payload: {
          concurrencyVersion: currentVersion,
        },
      });

      expect(publishRes.statusCode).toBe(200);
      const pubBody = publishRes.json();
      expect(pubBody.revision.id).toBe(revisionId);
      expect(pubBody.revision.lifecycleState).toBe('PUBLISHED');
      expect(pubBody.revision.concurrencyVersion).toBe(currentVersion + 1);
      expect(pubBody.revision.publishedByUserId).toBe(faUser);
      expect(typeof pubBody.revision.publishedAt).toBe('string');
      expect(pubBody.revision.boundary.length).toBe(4);
      expect(pubBody.revision.placements.length).toBe(1);

      // Verify lease is marked released
      const db = drizzle(pool);
      const leaseRows = await db
        .select()
        .from(floorPlanEditorLeases)
        .where(eq(floorPlanEditorLeases.floorPlanRevisionId, revisionId));
      expect(leaseRows[0]?.releasedAt).not.toBeNull();

      // Verify audit event persisted
      const auditRows = await db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.targetId, revisionId),
            eq(auditEvents.action, 'floor_plan.published'),
          ),
        );
      expect(auditRows.length).toBe(1);
      expect(auditRows[0]!.actorUserId).toBe(faUser);
      expect(auditRows[0]!.targetType).toBe('FLOOR_PLAN_REVISION');

      await app.close();
      await pool.end();
    });
  });

  it('archives previous Published revision when new draft is published and preserves invariant', async () => {
    await withTestDatabase(databaseUrl as string, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url);
      const faUser = await seedUser(pool, { username: 'facilities', roleCodes: ['FACILITIES_ADMIN'] });
      const { floorId } = await seedFloorHierarchy(pool);

      const app = await buildApp({ config: configFor(url), pool });
      const cookie = await signIn(app, 'facilities');

      // Create first draft
      const createRes1 = await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan`,
        headers: { cookie: `dskt_session=${cookie}` },
        payload: { editingScale: 1 },
      });
      const rev1Id = createRes1.json().revision.id;

      // Set boundary on rev 1
      await app.inject({
        method: 'PUT',
        url: `/floors/${floorId}/floor-plan/revisions/${rev1Id}/boundary`,
        headers: { cookie: `dskt_session=${cookie}` },
        payload: {
          concurrencyVersion: 0,
          vertices: [
            { x: 0, y: 0 },
            { x: 50, y: 0 },
            { x: 50, y: 50 },
            { x: 0, y: 50 },
          ],
        },
      });

      // Publish revision 1
      const pub1Res = await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan/revisions/${rev1Id}/publish`,
        headers: { cookie: `dskt_session=${cookie}` },
        payload: { concurrencyVersion: 1 },
      });
      expect(pub1Res.statusCode).toBe(200);
      expect(pub1Res.json().revision.lifecycleState).toBe('PUBLISHED');

      // Create a second revision directly (as a new draft)
      const db = drizzle(pool);
      const floorPlanId = createRes1.json().floorPlan.id;
      const rev2Rows = await db
        .insert(floorPlanRevisions)
        .values({
          floorPlanId,
          revisionNumber: 2,
          lifecycleState: 'DRAFT',
          editingScale: 1,
          concurrencyVersion: 0,
          createdByUserId: faUser,
        })
        .returning({ id: floorPlanRevisions.id });
      const rev2Id = rev2Rows[0]!.id;

      // Set boundary on rev 2
      await app.inject({
        method: 'PUT',
        url: `/floors/${floorId}/floor-plan/revisions/${rev2Id}/boundary`,
        headers: { cookie: `dskt_session=${cookie}` },
        payload: {
          concurrencyVersion: 0,
          vertices: [
            { x: 0, y: 0 },
            { x: 80, y: 0 },
            { x: 80, y: 80 },
            { x: 0, y: 80 },
          ],
        },
      });

      // Publish revision 2
      const pub2Res = await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan/revisions/${rev2Id}/publish`,
        headers: { cookie: `dskt_session=${cookie}` },
        payload: { concurrencyVersion: 1 },
      });
      expect(pub2Res.statusCode).toBe(200);
      expect(pub2Res.json().revision.lifecycleState).toBe('PUBLISHED');

      // Verify DB invariant:
      // Revision 1 is ARCHIVED
      // Revision 2 is PUBLISHED
      // Exactly 1 PUBLISHED, 0 DRAFT
      const allRevs = await db
        .select()
        .from(floorPlanRevisions)
        .where(eq(floorPlanRevisions.floorPlanId, floorPlanId));

      const rev1InDb = allRevs.find((r) => r.id === rev1Id);
      const rev2InDb = allRevs.find((r) => r.id === rev2Id);

      expect(rev1InDb?.lifecycleState).toBe('ARCHIVED');
      expect(rev2InDb?.lifecycleState).toBe('PUBLISHED');

      const publishedCount = allRevs.filter((r) => r.lifecycleState === 'PUBLISHED').length;
      const draftCount = allRevs.filter((r) => r.lifecycleState === 'DRAFT').length;
      expect(publishedCount).toBe(1);
      expect(draftCount).toBe(0);

      await app.close();
      await pool.end();
    });
  });

  it('rolls back completely on publication validation failure', async () => {
    await withTestDatabase(databaseUrl as string, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url);
      await seedUser(pool, { username: 'facilities', roleCodes: ['FACILITIES_ADMIN'] });
      const { floorId } = await seedFloorHierarchy(pool);

      const app = await buildApp({ config: configFor(url), pool });
      const cookie = await signIn(app, 'facilities');

      // Draft with NO boundary
      const createRes = await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan`,
        headers: { cookie: `dskt_session=${cookie}` },
        payload: { editingScale: 1 },
      });
      const revisionId = createRes.json().revision.id;

      // Attempt to publish without boundary
      const publishRes = await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/publish`,
        headers: { cookie: `dskt_session=${cookie}` },
        payload: { concurrencyVersion: 0 },
      });

      expect(publishRes.statusCode).toBe(400);
      const body = publishRes.json();
      expect(body.error).toBe('publication_validation_failed');
      expect(body.validationErrors).toBeDefined();
      expect(body.validationErrors.some((e: { code: string }) => e.code === 'missing_boundary')).toBe(true);

      // Verify transaction rolled back: revision is still DRAFT, concurrency version 0
      const db = drizzle(pool);
      const revRows = await db
        .select()
        .from(floorPlanRevisions)
        .where(eq(floorPlanRevisions.id, revisionId));
      expect(revRows[0]!.lifecycleState).toBe('DRAFT');
      expect(revRows[0]!.concurrencyVersion).toBe(0);

      // No audit event was written
      const auditRows = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.targetId, revisionId));
      expect(auditRows.length).toBe(0);

      await app.close();
      await pool.end();
    });
  });

  it('rejects stale concurrency version with 409 conflict', async () => {
    await withTestDatabase(databaseUrl as string, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url);
      await seedUser(pool, { username: 'facilities', roleCodes: ['FACILITIES_ADMIN'] });
      const { floorId } = await seedFloorHierarchy(pool);

      const app = await buildApp({ config: configFor(url), pool });
      const cookie = await signIn(app, 'facilities');

      // Create draft
      const createRes = await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan`,
        headers: { cookie: `dskt_session=${cookie}` },
        payload: { editingScale: 1 },
      });
      const revisionId = createRes.json().revision.id;

      // Set boundary -> concurrencyVersion becomes 1
      await app.inject({
        method: 'PUT',
        url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/boundary`,
        headers: { cookie: `dskt_session=${cookie}` },
        payload: {
          concurrencyVersion: 0,
          vertices: [
            { x: 0, y: 0 },
            { x: 50, y: 0 },
            { x: 50, y: 50 },
            { x: 0, y: 50 },
          ],
        },
      });

      // Submit publish with stale version 0
      const publishRes = await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/publish`,
        headers: { cookie: `dskt_session=${cookie}` },
        payload: { concurrencyVersion: 0 },
      });

      expect(publishRes.statusCode).toBe(409);
      expect(publishRes.json().error).toBe('concurrency_conflict');
      expect(publishRes.json().currentConcurrencyVersion).toBe(1);

      await app.close();
      await pool.end();
    });
  });

  it('is idempotent on safe retry and supports clientCommandId deduplication', async () => {
    await withTestDatabase(databaseUrl as string, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url);
      await seedUser(pool, { username: 'facilities', roleCodes: ['FACILITIES_ADMIN'] });
      const { floorId } = await seedFloorHierarchy(pool);

      const app = await buildApp({ config: configFor(url), pool });
      const cookie = await signIn(app, 'facilities');

      // Create draft and boundary
      const createRes = await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan`,
        headers: { cookie: `dskt_session=${cookie}` },
        payload: { editingScale: 1 },
      });
      const revisionId = createRes.json().revision.id;

      await app.inject({
        method: 'PUT',
        url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/boundary`,
        headers: { cookie: `dskt_session=${cookie}` },
        payload: {
          concurrencyVersion: 0,
          vertices: [
            { x: 0, y: 0 },
            { x: 60, y: 0 },
            { x: 60, y: 60 },
            { x: 0, y: 60 },
          ],
        },
      });

      const clientCmdId = 'cmd-publish-123';

      // 1. Publish with clientCommandId
      const pub1 = await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/publish`,
        headers: { cookie: `dskt_session=${cookie}` },
        payload: {
          concurrencyVersion: 1,
          clientCommandId: clientCmdId,
        },
      });
      expect(pub1.statusCode).toBe(200);
      expect(pub1.json().revision.lifecycleState).toBe('PUBLISHED');

      // 2. Retry with same clientCommandId and same payload -> exact replay (200)
      const pub2 = await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/publish`,
        headers: { cookie: `dskt_session=${cookie}` },
        payload: {
          concurrencyVersion: 1,
          clientCommandId: clientCmdId,
        },
      });
      expect(pub2.statusCode).toBe(200);
      expect(pub2.json().revision.lifecycleState).toBe('PUBLISHED');

      // 3. Retry without clientCommandId on already published revision -> safe retry (200)
      const pub3 = await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/publish`,
        headers: { cookie: `dskt_session=${cookie}` },
        payload: { concurrencyVersion: 2 },
      });
      expect(pub3.statusCode).toBe(200);
      expect(pub3.json().revision.lifecycleState).toBe('PUBLISHED');

      // 4. Reusing clientCommandId with different payload -> 409 command_id_payload_mismatch
      const pub4 = await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/publish`,
        headers: { cookie: `dskt_session=${cookie}` },
        payload: {
          concurrencyVersion: 99,
          clientCommandId: clientCmdId,
        },
      });
      expect(pub4.statusCode).toBe(409);
      expect(pub4.json().error).toBe('command_id_payload_mismatch');

      await app.close();
      await pool.end();
    });
  });

  it('enforces immutability: published revision rejects geometry and placement mutations', async () => {
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

      const app = await buildApp({ config: configFor(url), pool });
      const cookie = await signIn(app, 'facilities');

      // Create draft and publish
      const createRes = await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan`,
        headers: { cookie: `dskt_session=${cookie}` },
        payload: { editingScale: 1 },
      });
      const revisionId = createRes.json().revision.id;

      await app.inject({
        method: 'PUT',
        url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/boundary`,
        headers: { cookie: `dskt_session=${cookie}` },
        payload: {
          concurrencyVersion: 0,
          vertices: [
            { x: 0, y: 0 },
            { x: 50, y: 0 },
            { x: 50, y: 50 },
            { x: 0, y: 50 },
          ],
        },
      });

      const pubRes = await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/publish`,
        headers: { cookie: `dskt_session=${cookie}` },
        payload: { concurrencyVersion: 1 },
      });
      expect(pubRes.statusCode).toBe(200);
      const publishedVersion = pubRes.json().revision.concurrencyVersion;

      // 1. Attempt boundary mutation on published revision -> 409 revision_not_draft
      const boundaryMutationRes = await app.inject({
        method: 'PUT',
        url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/boundary`,
        headers: { cookie: `dskt_session=${cookie}` },
        payload: {
          concurrencyVersion: publishedVersion,
          vertices: [
            { x: 0, y: 0 },
            { x: 60, y: 0 },
            { x: 60, y: 60 },
            { x: 0, y: 60 },
          ],
        },
      });
      expect(boundaryMutationRes.statusCode).toBe(409);
      expect(boundaryMutationRes.json().error).toBe('revision_not_draft');

      // 2. Attempt placement creation on published revision -> 409 revision_not_draft
      const placeMutationRes = await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/placements`,
        headers: { cookie: `dskt_session=${cookie}` },
        payload: {
          templateRevisionId: deskTmpl.revisionId,
          positionX: 5,
          positionY: 5,
          rotationDegrees: 0,
          label: 'Desk X',
          concurrencyVersion: publishedVersion,
        },
      });
      expect(placeMutationRes.statusCode).toBe(409);
      expect(placeMutationRes.json().error).toBe('revision_not_draft');

      await app.close();
      await pool.end();
    });
  });

  it('enforces role-based authorization matrix for publication endpoint', async () => {
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
      const plannerCookie = await signIn(app, 'planner');
      const viewerCookie = await signIn(app, 'viewer');
      const adminCookie = await signIn(app, 'sysadmin');

      // Create draft by facilities admin
      const createRes = await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan`,
        headers: { cookie: `dskt_session=${faCookie}` },
        payload: { editingScale: 1 },
      });
      const revisionId = createRes.json().revision.id;

      // 1. Unauthenticated -> 401
      const unauthRes = await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/publish`,
        payload: { concurrencyVersion: 0 },
      });
      expect(unauthRes.statusCode).toBe(401);

      // 2. Workplace Planner -> 403
      const plannerRes = await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/publish`,
        headers: { cookie: `dskt_session=${plannerCookie}` },
        payload: { concurrencyVersion: 0 },
      });
      expect(plannerRes.statusCode).toBe(403);

      // 3. Viewer -> 403
      const viewerRes = await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/publish`,
        headers: { cookie: `dskt_session=${viewerCookie}` },
        payload: { concurrencyVersion: 0 },
      });
      expect(viewerRes.statusCode).toBe(403);

      // 4. System Admin -> 403
      const adminRes = await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/publish`,
        headers: { cookie: `dskt_session=${adminCookie}` },
        payload: { concurrencyVersion: 0 },
      });
      expect(adminRes.statusCode).toBe(403);

      await app.close();
      await pool.end();
    });
  });
});
