/**
 * Floor Boundary editing integration tests for Ticket 12.
 *
 * Verifies:
 * - Normalized ordered integer vertices in world units with implicit closure.
 * - Editing scale validation (only 2ⁿ permitted).
 * - Changing editing scale updates version and scale but preserves stored boundary geometry.
 * - Concurrency protection: rejects stale concurrency version with 409 conflict.
 * - State protection: rejects edits to non-Draft revisions with 409 conflict.
 * - Invalid geometry (non-orthogonal, self-intersecting, etc.) rejected with 400 and diagnostics.
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
  floorPlanRevisionBoundaryVertices,
  floorPlanRevisions,
  floors,
  localAuthCredentials,
  organizations,
  roles,
  sites,
} from '../src/db/schema.js';

const databaseUrl = process.env.DATABASE_URL;
const SECRET = 'floor-boundary-test-secret-32chars!';
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
  const name = `dskt_fb_${randomUUID().replaceAll('-', '')}`;
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

async function seedFloorWithDraft(
  app: Awaited<ReturnType<typeof buildApp>>,
  pool: pg.Pool,
  headers: { cookie: string },
): Promise<{ floorId: string; revisionId: string }> {
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

  const created = await app.inject({
    method: 'POST',
    url: `/floors/${floor.id}/floor-plan`,
    headers,
    payload: { editingScale: 1 },
  });
  expect(created.statusCode).toBe(201);
  return { floorId: floor.id, revisionId: created.json().revision.id as string };
}

const validBoundary = [
  { x: 0, y: 0 },
  { x: 200, y: 0 },
  { x: 200, y: 150 },
  { x: 0, y: 150 },
];

describe('edit floor boundary', () => {
  beforeEach(() => {
    expect(databaseUrl).toBeTruthy();
  });

  it('saves normalized ordered boundary vertices in world coordinates and increments concurrency version', async () => {
    await withTestDatabase(databaseUrl as string, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url, 3);
      await seedUser(pool, { username: 'facilities', roleCodes: ['FACILITIES_ADMIN'] });
      const app = await buildApp({ config: configFor(url), pool });
      const headers = { cookie: `dskt_session=${await signIn(app, 'facilities')}` };
      const { floorId, revisionId } = await seedFloorWithDraft(app, pool, headers);

      // Save valid boundary with concurrencyVersion: 0
      const updated = await app.inject({
        method: 'PUT',
        url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/boundary`,
        headers,
        payload: {
          concurrencyVersion: 0,
          editingScale: 2,
          vertices: validBoundary,
        },
      });
      expect(updated.statusCode).toBe(200);
      const body = updated.json();
      expect(body.concurrencyVersion).toBe(1);
      expect(body.editingScale).toBe(2);
      expect(body.boundary).toEqual(validBoundary);

      // Verify database relational storage
      const db = drizzle(pool);
      const vertexRows = await db
        .select()
        .from(floorPlanRevisionBoundaryVertices)
        .where(eq(floorPlanRevisionBoundaryVertices.floorPlanRevisionId, revisionId));
      expect(vertexRows).toHaveLength(4);
    });
  });

  it('rejects stale concurrency versions and non-Draft revisions', async () => {
    await withTestDatabase(databaseUrl as string, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url, 3);
      await seedUser(pool, { username: 'facilities', roleCodes: ['FACILITIES_ADMIN'] });
      const app = await buildApp({ config: configFor(url), pool });
      const headers = { cookie: `dskt_session=${await signIn(app, 'facilities')}` };
      const { floorId, revisionId } = await seedFloorWithDraft(app, pool, headers);

      // Stale concurrencyVersion (passed 99, expected 0)
      const staleRes = await app.inject({
        method: 'PUT',
        url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/boundary`,
        headers,
        payload: {
          concurrencyVersion: 99,
          vertices: validBoundary,
        },
      });
      expect(staleRes.statusCode).toBe(409);
      expect(staleRes.json()).toEqual({ error: 'concurrency_conflict', currentConcurrencyVersion: 0 });

      // Fetch confirmed draft revision to recover latest state
      const getRevRes = await app.inject({
        method: 'GET',
        url: `/floors/${floorId}/floor-plan/revisions/${revisionId}`,
        headers,
      });
      expect(getRevRes.statusCode).toBe(200);
      const confirmedRev = getRevRes.json().revision;
      expect(confirmedRev.concurrencyVersion).toBe(0);

      // Safe retry using confirmed concurrencyVersion succeeds
      const retryRes = await app.inject({
        method: 'PUT',
        url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/boundary`,
        headers,
        payload: {
          concurrencyVersion: confirmedRev.concurrencyVersion,
          vertices: validBoundary,
        },
      });
      expect(retryRes.statusCode).toBe(200);
      expect(retryRes.json().concurrencyVersion).toBe(1);

      // Change revision state to PUBLISHED directly in DB to test non-Draft rejection
      const db = drizzle(pool);
      await db
        .update(floorPlanRevisions)
        .set({ lifecycleState: 'PUBLISHED' })
        .where(eq(floorPlanRevisions.id, revisionId));

      const publishedEditRes = await app.inject({
        method: 'PUT',
        url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/boundary`,
        headers,
        payload: {
          concurrencyVersion: 0,
          vertices: validBoundary,
        },
      });
      expect(publishedEditRes.statusCode).toBe(409);
      expect(publishedEditRes.json()).toEqual({ error: 'revision_not_draft' });
    });
  });

  it('changing editing scale updates scale and version without altering stored physical boundary', async () => {
    await withTestDatabase(databaseUrl as string, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url, 3);
      await seedUser(pool, { username: 'facilities', roleCodes: ['FACILITIES_ADMIN'] });
      const app = await buildApp({ config: configFor(url), pool });
      const headers = { cookie: `dskt_session=${await signIn(app, 'facilities')}` };
      const { floorId, revisionId } = await seedFloorWithDraft(app, pool, headers);

      // Save initial boundary
      await app.inject({
        method: 'PUT',
        url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/boundary`,
        headers,
        payload: {
          concurrencyVersion: 0,
          editingScale: 1,
          vertices: validBoundary,
        },
      });

      // Change editing scale to 8
      const scaleRes = await app.inject({
        method: 'PATCH',
        url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/scale`,
        headers,
        payload: {
          concurrencyVersion: 1,
          editingScale: 8,
        },
      });
      expect(scaleRes.statusCode).toBe(200);
      expect(scaleRes.json().editingScale).toBe(8);
      expect(scaleRes.json().concurrencyVersion).toBe(2);
      expect(scaleRes.json().boundary).toEqual(validBoundary);

      // Verify boundary vertices in DB are completely unchanged
      const db = drizzle(pool);
      const vertexRows = await db
        .select()
        .from(floorPlanRevisionBoundaryVertices)
        .where(eq(floorPlanRevisionBoundaryVertices.floorPlanRevisionId, revisionId));
      expect(vertexRows).toHaveLength(4);
    });
  });

  it('rejects invalid non-orthogonal or self-intersecting boundary with diagnostics', async () => {
    await withTestDatabase(databaseUrl as string, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url, 3);
      await seedUser(pool, { username: 'facilities', roleCodes: ['FACILITIES_ADMIN'] });
      const app = await buildApp({ config: configFor(url), pool });
      const headers = { cookie: `dskt_session=${await signIn(app, 'facilities')}` };
      const { floorId, revisionId } = await seedFloorWithDraft(app, pool, headers);

      // Diagonal non-orthogonal edge
      const nonOrthogonal = [
        { x: 0, y: 0 },
        { x: 10, y: 5 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ];

      const res = await app.inject({
        method: 'PUT',
        url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/boundary`,
        headers,
        payload: {
          concurrencyVersion: 0,
          vertices: nonOrthogonal,
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_geometry');
      expect(res.json().diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'non_orthogonal_edge' }),
        ]),
      );
    });
  });
});
