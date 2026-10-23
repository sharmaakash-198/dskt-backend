/**
 * Floor Plan and Draft Revision integration tests for Ticket 11.
 *
 * Verifies:
 * - Uniqueness: A floor can have at most one floor plan identity.
 * - Initial state: revision 1 in DRAFT with permitted 2ⁿ scale and non-negative concurrency version.
 * - Revision list: handles empty floor and clearly exposes lifecycle state.
 * - Idempotency: repeated retry with same key does not duplicate plan or revision.
 * - Authorization: Facilities Admin only; System Admin, Workplace Planner, Viewer denied (403).
 */
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
  floorPlanRevisions,
  floorPlans,
  floors,
  localAuthCredentials,
  organizations,
  roles,
  sites,
} from '../src/db/schema.js';

const databaseUrl = process.env.DATABASE_URL;
const SECRET = 'floor-plan-test-secret-32chars!!';
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
  const name = `dskt_fp_${randomUUID().replaceAll('-', '')}`;
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
  const signIn = await app.inject({
    method: 'POST',
    url: '/auth/local/sign-in',
    payload: { username, password: PASSWORD },
  });
  expect(signIn.statusCode).toBe(200);
  return extractCookie(signIn.headers)!;
}

async function seedFloor(pool: pg.Pool): Promise<string> {
  const db = drizzle(pool);
  const org = (await db.select({ id: organizations.id }).from(organizations))[0]!;
  const site = (
    await db
      .insert(sites)
      .values({
        organizationId: org.id,
        code: 'SITE1',
        name: 'Site One',
        timeZone: 'UTC',
      })
      .returning({ id: sites.id })
  )[0]!;
  const building = (
    await db
      .insert(buildings)
      .values({
        siteId: site.id,
        code: 'BLD1',
        name: 'Building One',
      })
      .returning({ id: buildings.id })
  )[0]!;
  const floor = (
    await db
      .insert(floors)
      .values({
        buildingId: building.id,
        code: 'FLR1',
        name: 'Floor One',
      })
      .returning({ id: floors.id })
  )[0]!;
  return floor.id;
}

describe('floor plans and draft revisions', () => {
  beforeEach(() => {
    expect(databaseUrl).toBeTruthy();
  });

  it('creates revision 1 in Draft state with permitted 2ⁿ scale and handles empty floor queries', async () => {
    await withTestDatabase(databaseUrl as string, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url, 3);
      await seedUser(pool, { username: 'facilities', roleCodes: ['FACILITIES_ADMIN'] });
      const floorId = await seedFloor(pool);
      const app = await buildApp({ config: configFor(url), pool });
      const headers = { cookie: `dskt_session=${await signIn(app, 'facilities')}` };

      // Empty floor handling
      const emptyRevisions = await app.inject({
        method: 'GET',
        url: `/floors/${floorId}/floor-plan/revisions`,
        headers,
      });
      expect(emptyRevisions.statusCode).toBe(200);
      expect(emptyRevisions.json()).toEqual({ revisions: [] });

      const emptyDetail = await app.inject({
        method: 'GET',
        url: `/floors/${floorId}/floor-plan`,
        headers,
      });
      expect(emptyDetail.statusCode).toBe(200);
      expect(emptyDetail.json()).toEqual({ floorPlan: null, activeRevision: null, publishedRevision: null });

      // Create draft floor plan with scale 4 (permitted 2ⁿ)
      const created = await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan`,
        headers,
        payload: { editingScale: 4 },
      });
      expect(created.statusCode).toBe(201);
      const body = created.json();
      expect(body.floorPlan).toMatchObject({
        id: expect.any(String),
        floorId,
      });
      expect(body.revision).toMatchObject({
        id: expect.any(String),
        floorPlanId: body.floorPlan.id,
        revisionNumber: 1,
        lifecycleState: 'DRAFT',
        editingScale: 4,
        concurrencyVersion: 0,
      });

      // Revision list returns the created revision
      const revisions = await app.inject({
        method: 'GET',
        url: `/floors/${floorId}/floor-plan/revisions`,
        headers,
      });
      expect(revisions.statusCode).toBe(200);
      expect(revisions.json().revisions).toHaveLength(1);
      expect(revisions.json().revisions[0]).toMatchObject({
        revisionNumber: 1,
        lifecycleState: 'DRAFT',
        editingScale: 4,
        concurrencyVersion: 0,
      });
    });
  });

  it('enforces floor plan uniqueness per floor and rejects non-permitted editing scales', async () => {
    await withTestDatabase(databaseUrl as string, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url, 3);
      await seedUser(pool, { username: 'facilities', roleCodes: ['FACILITIES_ADMIN'] });
      const floorId = await seedFloor(pool);
      const app = await buildApp({ config: configFor(url), pool });
      const headers = { cookie: `dskt_session=${await signIn(app, 'facilities')}` };

      // Reject non-2ⁿ editing scale
      const invalidScale = await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan`,
        headers,
        payload: { editingScale: 3 },
      });
      expect(invalidScale.statusCode).toBe(400);
      expect(invalidScale.json()).toEqual({ error: 'invalid_editing_scale' });

      // Create initial floor plan
      const created = await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan`,
        headers,
      });
      expect(created.statusCode).toBe(201);

      // Attempt to create second floor plan for the same floor fails (409)
      const duplicate = await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan`,
        headers,
      });
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json()).toEqual({ error: 'floor_plan_already_exists' });
    });
  });

  it('supports idempotent retry with the same key without duplicating plan or revisions', async () => {
    await withTestDatabase(databaseUrl as string, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url, 3);
      await seedUser(pool, { username: 'facilities', roleCodes: ['FACILITIES_ADMIN'] });
      const floorId = await seedFloor(pool);
      const app = await buildApp({ config: configFor(url), pool });
      const headers = {
        cookie: `dskt_session=${await signIn(app, 'facilities')}`,
        'idempotency-key': 'test-idem-key-12345',
      };

      // First call: 201 created
      const first = await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan`,
        headers,
        payload: { editingScale: 2 },
      });
      expect(first.statusCode).toBe(201);
      const firstBody = first.json();

      // Second call with same idempotency key: 200 replayed with same ids
      const second = await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan`,
        headers,
        payload: { editingScale: 2 },
      });
      expect(second.statusCode).toBe(200);
      expect(second.json().floorPlan.id).toBe(firstBody.floorPlan.id);
      expect(second.json().revision.id).toBe(firstBody.revision.id);

      // Verify row counts in database
      const db = drizzle(pool);
      const planCount = await db.select().from(floorPlans).where(eq(floorPlans.floorId, floorId));
      expect(planCount).toHaveLength(1);
      const revisionCount = await db
        .select()
        .from(floorPlanRevisions)
        .where(eq(floorPlanRevisions.floorPlanId, firstBody.floorPlan.id));
      expect(revisionCount).toHaveLength(1);
    });
  });

  it('enforces that only Facilities Admin can create or read draft floor plans', async () => {
    await withTestDatabase(databaseUrl as string, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url, 3);
      await seedUser(pool, { username: 'facilities', roleCodes: ['FACILITIES_ADMIN'] });
      await seedUser(pool, { username: 'sysadmin', roleCodes: ['SYSTEM_ADMIN'] });
      await seedUser(pool, { username: 'planner', roleCodes: ['WORKPLACE_PLANNER'] });
      await seedUser(pool, { username: 'viewer', roleCodes: ['VIEWER'] });
      const floorId = await seedFloor(pool);
      const app = await buildApp({ config: configFor(url), pool });

      const facHeaders = { cookie: `dskt_session=${await signIn(app, 'facilities')}` };
      const sysHeaders = { cookie: `dskt_session=${await signIn(app, 'sysadmin')}` };
      const planHeaders = { cookie: `dskt_session=${await signIn(app, 'planner')}` };
      const viewHeaders = { cookie: `dskt_session=${await signIn(app, 'viewer')}` };

      // Creation denied to non-facilities
      for (const headers of [sysHeaders, planHeaders, viewHeaders]) {
        const createRes = await app.inject({
          method: 'POST',
          url: `/floors/${floorId}/floor-plan`,
          headers,
        });
        expect(createRes.statusCode).toBe(403);
      }

      // Facilities creates the plan
      const created = await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/floor-plan`,
        headers: facHeaders,
      });
      expect(created.statusCode).toBe(201);

      const draftRevId = created.json().revision.id;

      // System Admin cannot read floor plans (requires FACILITIES_ADMIN, WORKPLACE_PLANNER, or VIEWER)
      const sysGetRes = await app.inject({
        method: 'GET',
        url: `/floors/${floorId}/floor-plan`,
        headers: sysHeaders,
      });
      expect(sysGetRes.statusCode).toBe(403);

      const sysListRes = await app.inject({
        method: 'GET',
        url: `/floors/${floorId}/floor-plan/revisions`,
        headers: sysHeaders,
      });
      expect(sysListRes.statusCode).toBe(403);

      // Workplace Planner and Viewer can call floor-plan endpoints, but draft geometry is NEVER exposed
      for (const headers of [planHeaders, viewHeaders]) {
        const getRes = await app.inject({
          method: 'GET',
          url: `/floors/${floorId}/floor-plan`,
          headers,
        });
        expect(getRes.statusCode).toBe(200);
        // Active revision is null for planner/viewer because only draft exists, no published revision
        expect(getRes.json().activeRevision).toBeNull();
        expect(getRes.json().publishedRevision).toBeNull();

        const listRes = await app.inject({
          method: 'GET',
          url: `/floors/${floorId}/floor-plan/revisions`,
          headers,
        });
        expect(listRes.statusCode).toBe(200);
        expect(listRes.json().revisions).toEqual([]);

        // Direct access to draft revision geometry is strictly forbidden (403)
        const draftGetRes = await app.inject({
          method: 'GET',
          url: `/floors/${floorId}/floor-plan/revisions/${draftRevId}`,
          headers,
        });
        expect(draftGetRes.statusCode).toBe(403);
      }
    });
  });
});
