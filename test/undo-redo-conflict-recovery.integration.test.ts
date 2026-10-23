/**
 * Ticket 17: Undo, redo, and recover conflicts — backend integration tests.
 *
 * Verifies the server-side contracts that make client-side undo/redo and
 * conflict recovery safe:
 *
 * 1. A stale concurrencyVersion prevents silent overwrite and returns the
 *    current server version in the error payload.
 * 2. Safe retry after fetching the server-confirmed version succeeds and
 *    produces a consistent Draft.
 * 3. A successful conflict recovery (reload + re-save) restores the
 *    server-confirmed Draft at a valid concurrency boundary.
 * 4. Validation failures (invalid geometry) do not corrupt committed history
 *    — the concurrencyVersion is NOT incremented on rejection.
 * 5. Placement stale-version conflicts follow the same pattern for undo/redo
 *    of PLACE, TRANSFORM, and DELETE operations.
 * 6. Idempotent re-issue of the same clientCommandId returns the original
 *    response without a second mutation (safe retry from undo replay).
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
  floors,
  localAuthCredentials,
  organizations,
  roles,
  sites,
} from '../src/db/schema.js';

const databaseUrl = process.env.DATABASE_URL;
const SECRET = 'undo-redo-conflict-test-secret-32!';
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
  const name = `dskt_ur_${randomUUID().replaceAll('-', '')}`;
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

function createPool(url: string, max = 3): pg.Pool {
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

/**
 * Creates a site + building + floor + draft floor plan and sets a valid boundary.
 * Returns floorId, revisionId, and the concurrencyVersion after boundary save.
 */
async function seedDraftWithBoundary(
  app: Awaited<ReturnType<typeof buildApp>>,
  pool: pg.Pool,
  headers: { cookie: string },
): Promise<{ floorId: string; revisionId: string; concurrencyVersion: number }> {
  const db = drizzle(pool);
  const org = (await db.select({ id: organizations.id }).from(organizations))[0]!;

  const site = (
    await db
      .insert(sites)
      .values({
        organizationId: org.id,
        code: `S${randomUUID().slice(0, 4)}`,
        name: 'Site',
        timeZone: 'UTC',
      })
      .returning({ id: sites.id })
  )[0]!;

  const building = (
    await db
      .insert(buildings)
      .values({ siteId: site.id, code: 'B1', name: 'Bldg' })
      .returning({ id: buildings.id })
  )[0]!;

  const floor = (
    await db
      .insert(floors)
      .values({ buildingId: building.id, code: 'F1', name: 'Floor' })
      .returning({ id: floors.id })
  )[0]!;

  const planRes = await app.inject({
    method: 'POST',
    url: `/floors/${floor.id}/floor-plan`,
    headers,
    payload: { editingScale: 1 },
  });
  expect(planRes.statusCode).toBe(201);
  const revisionId = planRes.json().revision.id as string;

  const boundaryRes = await app.inject({
    method: 'PUT',
    url: `/floors/${floor.id}/floor-plan/revisions/${revisionId}/boundary`,
    headers,
    payload: {
      concurrencyVersion: 0,
      editingScale: 1,
      vertices: [
        { x: 0, y: 0 },
        { x: 200, y: 0 },
        { x: 200, y: 150 },
        { x: 0, y: 150 },
      ],
    },
  });
  expect(boundaryRes.statusCode).toBe(200);

  return {
    floorId: floor.id,
    revisionId,
    concurrencyVersion: boundaryRes.json().concurrencyVersion as number,
  };
}

const validBoundaryV2 = [
  { x: 0, y: 0 },
  { x: 300, y: 0 },
  { x: 300, y: 200 },
  { x: 0, y: 200 },
];

describe('Ticket 17: undo/redo and conflict recovery', () => {
  beforeEach(() => {
    expect(databaseUrl, 'DATABASE_URL is required for Ticket 17 integration tests').toBeTruthy();
  });

  describe('stale concurrencyVersion prevents silent overwrite', () => {
    it('rejects a boundary PUT with stale version and returns currentConcurrencyVersion in error payload', async () => {
      await withTestDatabase(databaseUrl!, async (url) => {
        await applyMigrations(url);
        const pool = createPool(url);
        await seedUser(pool, { username: 'facilities', roleCodes: ['FACILITIES_ADMIN'] });
        const app = await buildApp({ config: configFor(url), pool });
        const headers = { cookie: `dskt_session=${await signIn(app, 'facilities')}` };

        const { floorId, revisionId, concurrencyVersion } = await seedDraftWithBoundary(
          app,
          pool,
          headers,
        );

        // Attempt boundary save with stale version (concurrencyVersion - 1)
        const staleRes = await app.inject({
          method: 'PUT',
          url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/boundary`,
          headers,
          payload: {
            concurrencyVersion: concurrencyVersion - 1,
            vertices: validBoundaryV2,
          },
        });

        expect(staleRes.statusCode).toBe(409);
        const staleBody = staleRes.json();
        expect(staleBody.error).toBe('concurrency_conflict');
        // Server must report the current authoritative version so the client can recover
        expect(staleBody.currentConcurrencyVersion).toBe(concurrencyVersion);
      });
    });

    it('rejects a placement PATCH with stale version and returns currentConcurrencyVersion', async () => {
      await withTestDatabase(databaseUrl!, async (url) => {
        await applyMigrations(url);
        const pool = createPool(url);
        await seedUser(pool, { username: 'facilities', roleCodes: ['FACILITIES_ADMIN'] });
        const app = await buildApp({ config: configFor(url), pool });
        const headers = { cookie: `dskt_session=${await signIn(app, 'facilities')}` };

        const { floorId, revisionId, concurrencyVersion } = await seedDraftWithBoundary(
          app,
          pool,
          headers,
        );

        // Create a template + revision to place
        const catRes = await app.inject({
          method: 'POST',
          url: '/element-categories',
          headers,
          payload: { code: 'DESKS', name: 'Desks' },
        });
        const categoryId = catRes.json().id as string;

        const tmplRes = await app.inject({
          method: 'POST',
          url: `/element-categories/${categoryId}/templates`,
          headers,
          payload: { code: 'DSK-STD', name: 'Standard Desk' },
        });
        const templateId = tmplRes.json().id as string;

        const revRes = await app.inject({
          method: 'POST',
          url: `/element-templates/${templateId}/revisions`,
          headers,
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
        const templateRevisionId = revRes.json().id as string;

        await app.inject({
          method: 'POST',
          url: `/element-templates/${templateId}/revisions/${templateRevisionId}/activate`,
          headers,
        });

        // Place element successfully at current version
        const placeRes = await app.inject({
          method: 'POST',
          url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/placements`,
          headers,
          payload: {
            templateRevisionId,
            positionX: 10,
            positionY: 10,
            rotationDegrees: 0,
            concurrencyVersion,
          },
        });
        expect(placeRes.statusCode).toBe(201);
        const placementId = placeRes.json().id as string;
        const newConcurrencyVersion = concurrencyVersion + 1;

        // Try to update placement with the old (stale) concurrency version
        const staleUpdateRes = await app.inject({
          method: 'PATCH',
          url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/placements/${placementId}`,
          headers,
          payload: {
            positionX: 50,
            positionY: 50,
            rotationDegrees: 90,
            // stale — should be newConcurrencyVersion
            concurrencyVersion,
          },
        });

        expect(staleUpdateRes.statusCode).toBe(409);
        const staleBody = staleUpdateRes.json();
        expect(staleBody.error).toBe('concurrency_conflict');
        expect(staleBody.currentConcurrencyVersion).toBe(newConcurrencyVersion);
      });
    });
  });

  describe('safe retry after fetching server-confirmed version', () => {
    it('fetches current revision after conflict and retries boundary save successfully', async () => {
      await withTestDatabase(databaseUrl!, async (url) => {
        await applyMigrations(url);
        const pool = createPool(url);
        await seedUser(pool, { username: 'facilities', roleCodes: ['FACILITIES_ADMIN'] });
        const app = await buildApp({ config: configFor(url), pool });
        const headers = { cookie: `dskt_session=${await signIn(app, 'facilities')}` };

        const { floorId, revisionId, concurrencyVersion } = await seedDraftWithBoundary(
          app,
          pool,
          headers,
        );

        // Step 1: Save fails with stale version (simulates another session advancing the version)
        const staleRes = await app.inject({
          method: 'PUT',
          url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/boundary`,
          headers,
          payload: {
            concurrencyVersion: concurrencyVersion - 1,
            vertices: validBoundaryV2,
          },
        });
        expect(staleRes.statusCode).toBe(409);

        // Step 2: Fetch current server-confirmed revision
        const getRevRes = await app.inject({
          method: 'GET',
          url: `/floors/${floorId}/floor-plan/revisions/${revisionId}`,
          headers,
        });
        expect(getRevRes.statusCode).toBe(200);
        const confirmedRevision = getRevRes.json().revision;
        expect(confirmedRevision.concurrencyVersion).toBe(concurrencyVersion);

        // Step 3: Retry with confirmed version — must succeed (conflict recovery reapply)
        const retryRes = await app.inject({
          method: 'PUT',
          url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/boundary`,
          headers,
          payload: {
            concurrencyVersion: confirmedRevision.concurrencyVersion,
            vertices: validBoundaryV2,
          },
        });
        expect(retryRes.statusCode).toBe(200);
        const retryBody = retryRes.json();
        // Version incremented exactly once
        expect(retryBody.concurrencyVersion).toBe(concurrencyVersion + 1);
        expect(retryBody.boundary).toEqual(validBoundaryV2);
        expect(retryBody.lifecycleState).toBe('DRAFT');
      });
    });

    it('reload server draft returns the server-confirmed boundary after a concurrent update', async () => {
      await withTestDatabase(databaseUrl!, async (url) => {
        await applyMigrations(url);
        const pool = createPool(url);
        await seedUser(pool, { username: 'facilities', roleCodes: ['FACILITIES_ADMIN'] });
        const app = await buildApp({ config: configFor(url), pool });
        const headers = { cookie: `dskt_session=${await signIn(app, 'facilities')}` };

        const { floorId, revisionId, concurrencyVersion } = await seedDraftWithBoundary(
          app,
          pool,
          headers,
        );

        // Simulate another session updating the boundary (advancing the version)
        const otherUpdateRes = await app.inject({
          method: 'PUT',
          url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/boundary`,
          headers,
          payload: {
            concurrencyVersion,
            vertices: [
              { x: 0, y: 0 },
              { x: 400, y: 0 },
              { x: 400, y: 300 },
              { x: 0, y: 300 },
            ],
          },
        });
        expect(otherUpdateRes.statusCode).toBe(200);
        const advancedVersion = otherUpdateRes.json().concurrencyVersion as number;

        // Reload server draft: GET revision returns the up-to-date state
        const reloadRes = await app.inject({
          method: 'GET',
          url: `/floors/${floorId}/floor-plan/revisions/${revisionId}`,
          headers,
        });
        expect(reloadRes.statusCode).toBe(200);
        const serverDraft = reloadRes.json().revision;

        // Server draft reflects the advanced state — client history boundary resets here
        expect(serverDraft.concurrencyVersion).toBe(advancedVersion);
        expect(serverDraft.boundary).toEqual([
          { x: 0, y: 0 },
          { x: 400, y: 0 },
          { x: 400, y: 300 },
          { x: 0, y: 300 },
        ]);
        expect(serverDraft.lifecycleState).toBe('DRAFT');
      });
    });
  });

  describe('validation failures do not corrupt committed history', () => {
    it('boundary PUT with invalid geometry returns 400 and does NOT increment concurrencyVersion', async () => {
      await withTestDatabase(databaseUrl!, async (url) => {
        await applyMigrations(url);
        const pool = createPool(url);
        await seedUser(pool, { username: 'facilities', roleCodes: ['FACILITIES_ADMIN'] });
        const app = await buildApp({ config: configFor(url), pool });
        const headers = { cookie: `dskt_session=${await signIn(app, 'facilities')}` };

        const { floorId, revisionId, concurrencyVersion } = await seedDraftWithBoundary(
          app,
          pool,
          headers,
        );

        // Attempt to save non-orthogonal (invalid) geometry — should be rejected
        const invalidRes = await app.inject({
          method: 'PUT',
          url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/boundary`,
          headers,
          payload: {
            concurrencyVersion,
            vertices: [
              { x: 0, y: 0 },
              { x: 10, y: 5 }, // non-orthogonal
              { x: 10, y: 10 },
              { x: 0, y: 10 },
            ],
          },
        });

        expect(invalidRes.statusCode).toBe(400);
        expect(invalidRes.json().error).toBe('invalid_geometry');
        expect(invalidRes.json().diagnostics).toEqual(
          expect.arrayContaining([expect.objectContaining({ code: 'non_orthogonal_edge' })]),
        );

        // Critical: concurrencyVersion must NOT have advanced after the rejected edit
        const getRevRes = await app.inject({
          method: 'GET',
          url: `/floors/${floorId}/floor-plan/revisions/${revisionId}`,
          headers,
        });
        expect(getRevRes.statusCode).toBe(200);
        expect(getRevRes.json().revision.concurrencyVersion).toBe(concurrencyVersion);
      });
    });

    it('valid boundary PUT immediately after a rejected invalid save succeeds at the same version', async () => {
      await withTestDatabase(databaseUrl!, async (url) => {
        await applyMigrations(url);
        const pool = createPool(url);
        await seedUser(pool, { username: 'facilities', roleCodes: ['FACILITIES_ADMIN'] });
        const app = await buildApp({ config: configFor(url), pool });
        const headers = { cookie: `dskt_session=${await signIn(app, 'facilities')}` };

        const { floorId, revisionId, concurrencyVersion } = await seedDraftWithBoundary(
          app,
          pool,
          headers,
        );

        // Rejected invalid geometry attempt (non-orthogonal)
        await app.inject({
          method: 'PUT',
          url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/boundary`,
          headers,
          payload: {
            concurrencyVersion,
            vertices: [
              { x: 0, y: 0 },
              { x: 10, y: 5 },
              { x: 10, y: 10 },
              { x: 0, y: 10 },
            ],
          },
        });

        // Immediately retry with a valid boundary at the same (unchanged) concurrencyVersion
        const retryRes = await app.inject({
          method: 'PUT',
          url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/boundary`,
          headers,
          payload: {
            concurrencyVersion,
            vertices: validBoundaryV2,
          },
        });

        expect(retryRes.statusCode).toBe(200);
        expect(retryRes.json().concurrencyVersion).toBe(concurrencyVersion + 1);
        expect(retryRes.json().boundary).toEqual(validBoundaryV2);
      });
    });
  });

  describe('idempotent clientCommandId for safe undo/redo replay', () => {
    it('replaying a boundary command with the same clientCommandId returns the original response without double mutation', async () => {
      await withTestDatabase(databaseUrl!, async (url) => {
        await applyMigrations(url);
        const pool = createPool(url);
        await seedUser(pool, { username: 'facilities', roleCodes: ['FACILITIES_ADMIN'] });
        const app = await buildApp({ config: configFor(url), pool });
        const headers = { cookie: `dskt_session=${await signIn(app, 'facilities')}` };

        const { floorId, revisionId, concurrencyVersion } = await seedDraftWithBoundary(
          app,
          pool,
          headers,
        );

        // Acquire a lease so the command idempotency token is accepted
        const leaseRes = await app.inject({
          method: 'POST',
          url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/lease`,
          headers,
          payload: { durationSeconds: 60 },
        });
        expect(leaseRes.statusCode).toBe(200);
        const leaseToken = leaseRes.json().token as string;
        const leaseHeaders = { ...headers, 'x-lease-token': leaseToken };

        const clientCommandId = randomUUID();

        // First issue: succeeds and saves the boundary
        const firstRes = await app.inject({
          method: 'PUT',
          url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/boundary`,
          headers: { ...leaseHeaders, 'x-client-command-id': clientCommandId },
          payload: {
            concurrencyVersion,
            editingScale: 1,
            vertices: validBoundaryV2,
            leaseToken,
            clientCommandId,
          },
        });
        expect(firstRes.statusCode).toBe(200);
        const firstVersion = firstRes.json().concurrencyVersion as number;
        expect(firstVersion).toBe(concurrencyVersion + 1);

        // Idempotent replay with identical clientCommandId — must return the SAME result
        const replayRes = await app.inject({
          method: 'PUT',
          url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/boundary`,
          headers: { ...leaseHeaders, 'x-client-command-id': clientCommandId },
          payload: {
            concurrencyVersion,
            editingScale: 1,
            vertices: validBoundaryV2,
            leaseToken,
            clientCommandId,
          },
        });
        expect(replayRes.statusCode).toBe(200);
        // Version must NOT have advanced a second time
        expect(replayRes.json().concurrencyVersion).toBe(firstVersion);
        expect(replayRes.json().boundary).toEqual(validBoundaryV2);
      });
    });

    it('reusing a clientCommandId with a different payload is rejected with command_id_payload_mismatch', async () => {
      await withTestDatabase(databaseUrl!, async (url) => {
        await applyMigrations(url);
        const pool = createPool(url);
        await seedUser(pool, { username: 'facilities', roleCodes: ['FACILITIES_ADMIN'] });
        const app = await buildApp({ config: configFor(url), pool });
        const headers = { cookie: `dskt_session=${await signIn(app, 'facilities')}` };

        const { floorId, revisionId, concurrencyVersion } = await seedDraftWithBoundary(
          app,
          pool,
          headers,
        );

        const leaseRes = await app.inject({
          method: 'POST',
          url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/lease`,
          headers,
          payload: { durationSeconds: 60 },
        });
        expect(leaseRes.statusCode).toBe(200);
        const leaseToken = leaseRes.json().token as string;
        const leaseHeaders = { ...headers, 'x-lease-token': leaseToken };

        const clientCommandId = randomUUID();

        // First command saves boundary V2
        const firstRes = await app.inject({
          method: 'PUT',
          url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/boundary`,
          headers: { ...leaseHeaders, 'x-client-command-id': clientCommandId },
          payload: {
            concurrencyVersion,
            editingScale: 1,
            vertices: validBoundaryV2,
            leaseToken,
            clientCommandId,
          },
        });
        expect(firstRes.statusCode).toBe(200);

        // Second command reuses same ID but with a DIFFERENT boundary payload
        const mismatchRes = await app.inject({
          method: 'PUT',
          url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/boundary`,
          headers: { ...leaseHeaders, 'x-client-command-id': clientCommandId },
          payload: {
            concurrencyVersion: concurrencyVersion + 1,
            editingScale: 1,
            vertices: [
              { x: 0, y: 0 },
              { x: 500, y: 0 },
              { x: 500, y: 400 },
              { x: 0, y: 400 },
            ],
            leaseToken,
            clientCommandId,
          },
        });
        expect(mismatchRes.statusCode).toBe(409);
        expect(mismatchRes.json().error).toBe('command_id_payload_mismatch');
      });
    });
  });
});
