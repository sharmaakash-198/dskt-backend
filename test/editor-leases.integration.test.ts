/**
 * Editor Lease and Autosave integration tests for Ticket 16.
 *
 * Verifies:
 * 1. Opening an editable Draft acquires a time-limited lease and clearly shows owner and expiry state.
 * 2. Only the current lease holder can commit Draft mutations; another user receives a read-only conflict state (409 Conflict, lease_conflict).
 * 3. Debounced semantic commands autosave with lease token (x-lease-token / leaseToken), concurrency version, and client command ID (x-client-command-id / clientCommandId).
 * 4. Retrying an identical command returns the original result without duplicate mutation; reusing an ID with another payload is rejected (409 Conflict, command_id_payload_mismatch).
 * 5. Lease renewal, expiry, release, and audited takeover behave predictably (ACQUIRE_LEASE, RELEASE_LEASE, TAKEOVER_LEASE in audit_events).
 * 6. Role permissions: Facilities Admin can acquire, renew, release, takeover, and edit. Workplace Planner & Viewer can read lease state (200) but cannot acquire/renew/release/takeover/edit (403).
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
  auditEvents,
  buildings,
  floorPlanEditorLeases,
  floors,
  localAuthCredentials,
  organizations,
  processedCommands,
  roles,
  sites,
} from '../src/db/schema.js';

const databaseUrl = process.env.DATABASE_URL;
const SECRET = 'editor-lease-test-secret-32chrs!';
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
  const name = `dskt_lease_${randomUUID().replaceAll('-', '')}`;
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
  opts: { username: string; displayName?: string; roleCodes?: RoleCode[]; active?: boolean },
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
        displayName: opts.displayName ?? opts.username,
        active: opts.active ?? true,
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
  const response = await app.inject({
    method: 'POST',
    url: '/auth/local/sign-in',
    payload: { username, password: PASSWORD },
  });
  const cookie = extractCookie(response.headers);
  if (!cookie) {
    throw new Error(`Failed to sign in as ${username}: ${response.body}`);
  }
  return cookie;
}

async function seedHierarchy(pool: pg.Pool): Promise<{
  siteId: string;
  buildingId: string;
  floorId: string;
}> {
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
        code: 'HQ1',
        name: 'Tower 1',
      })
      .returning({ id: buildings.id })
  )[0]!;
  const floor = (
    await db
      .insert(floors)
      .values({
        buildingId: building.id,
        code: 'L01',
        name: 'Level 1',
      })
      .returning({ id: floors.id })
  )[0]!;
  return { siteId: site.id, buildingId: building.id, floorId: floor.id };
}

describe('editor leases and autosave commands', () => {
  beforeEach(() => {
    expect(databaseUrl, 'DATABASE_URL is required for editor lease tests').toBeTruthy();
  });

  it('acquires lease, renews it, releases it, and inspects caller lease state', async () => {
    await withTestDatabase(databaseUrl!, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url, 3);
      const app = await buildApp({ config: configFor(url), pool });

      try {
        await seedUser(pool, { username: 'facadmin', displayName: 'Facilities Lead', roleCodes: ['FACILITIES_ADMIN'] });
        await seedUser(pool, { username: 'planner', displayName: 'Space Planner', roleCodes: ['WORKPLACE_PLANNER'] });
        const { floorId } = await seedHierarchy(pool);

        const facCookie = await signIn(app, 'facadmin');
        const planRes = await app.inject({
          method: 'POST',
          url: `/floors/${floorId}/floor-plan`,
          headers: { cookie: `dskt_session=${facCookie}` },
          payload: { editingScale: 32 },
        });
        expect(planRes.statusCode).toBe(201);
        const { revision } = JSON.parse(planRes.body);

        // 1. Initial lease state: no lease active
        const initLeaseRes = await app.inject({
          method: 'GET',
          url: `/floors/${floorId}/floor-plan/revisions/${revision.id}/lease`,
          headers: { cookie: `dskt_session=${facCookie}` },
        });
        expect(initLeaseRes.statusCode).toBe(200);
        const initLease = JSON.parse(initLeaseRes.body);
        expect(initLease.hasActiveLease).toBe(false);
        expect(initLease.isCurrentHolder).toBe(false);
        expect(initLease.lease).toBeNull();

        // 2. Acquire lease
        const acqRes = await app.inject({
          method: 'POST',
          url: `/floors/${floorId}/floor-plan/revisions/${revision.id}/lease`,
          headers: { cookie: `dskt_session=${facCookie}` },
          payload: { durationSeconds: 60 },
        });
        expect(acqRes.statusCode).toBe(200);
        const acquired = JSON.parse(acqRes.body);
        expect(acquired.token).toBeDefined();
        expect(acquired.owner.displayName).toBe('Facilities Lead');
        expect(acquired.floorPlanRevisionId).toBe(revision.id);

        const leaseToken = acquired.token;

        // Verify audit event for ACQUIRE_LEASE
        const db = drizzle(pool);
        const auditAcq = await db
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.action, 'ACQUIRE_LEASE'));
        expect(auditAcq.length).toBe(1);
        expect(auditAcq[0]!.summary).toContain('acquired editor lease');

        // 3. Inspect lease state from facadmin (holder)
        const facStateRes = await app.inject({
          method: 'GET',
          url: `/floors/${floorId}/floor-plan/revisions/${revision.id}/lease`,
          headers: { cookie: `dskt_session=${facCookie}` },
        });
        const facState = JSON.parse(facStateRes.body);
        expect(facState.hasActiveLease).toBe(true);
        expect(facState.isCurrentHolder).toBe(true);
        expect(facState.lease.token).toBeUndefined(); // Token not leaked in GET

        // 4. Inspect lease state from planner (viewer/planner role)
        const plannerCookie = await signIn(app, 'planner');
        const planStateRes = await app.inject({
          method: 'GET',
          url: `/floors/${floorId}/floor-plan/revisions/${revision.id}/lease`,
          headers: { cookie: `dskt_session=${plannerCookie}` },
        });
        const planState = JSON.parse(planStateRes.body);
        expect(planState.hasActiveLease).toBe(true);
        expect(planState.isCurrentHolder).toBe(false);
        expect(planState.lease.owner.displayName).toBe('Facilities Lead');

        // 5. Renew lease
        const renewRes = await app.inject({
          method: 'POST',
          url: `/floors/${floorId}/floor-plan/revisions/${revision.id}/lease/renew`,
          headers: {
            cookie: `dskt_session=${facCookie}`,
            'x-lease-token': leaseToken,
          },
          payload: { durationSeconds: 120 },
        });
        expect(renewRes.statusCode).toBe(200);
        const renewed = JSON.parse(renewRes.body);
        expect(new Date(renewed.expiresAt).getTime()).toBeGreaterThan(
          new Date(acquired.expiresAt).getTime(),
        );

        // 6. Release lease
        const releaseRes = await app.inject({
          method: 'POST',
          url: `/floors/${floorId}/floor-plan/revisions/${revision.id}/lease/release`,
          headers: {
            cookie: `dskt_session=${facCookie}`,
            'x-lease-token': leaseToken,
          },
        });
        expect(releaseRes.statusCode).toBe(200);
        expect(JSON.parse(releaseRes.body).ok).toBe(true);

        const auditRel = await db
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.action, 'RELEASE_LEASE'));
        expect(auditRel.length).toBe(1);

        // After release, lease is no longer active
        const postRelRes = await app.inject({
          method: 'GET',
          url: `/floors/${floorId}/floor-plan/revisions/${revision.id}/lease`,
          headers: { cookie: `dskt_session=${facCookie}` },
        });
        expect(JSON.parse(postRelRes.body).hasActiveLease).toBe(false);
      } finally {
        await app.close();
        await pool.end();
      }
    });
  });

  it('rejects mutations from another user during an active lease with 409 lease_conflict', async () => {
    await withTestDatabase(databaseUrl!, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url, 3);
      const app = await buildApp({ config: configFor(url), pool });

      try {
        await seedUser(pool, { username: 'admin1', displayName: 'Admin One', roleCodes: ['FACILITIES_ADMIN'] });
        await seedUser(pool, { username: 'admin2', displayName: 'Admin Two', roleCodes: ['FACILITIES_ADMIN'] });
        const { floorId } = await seedHierarchy(pool);

        const cookie1 = await signIn(app, 'admin1');
        const cookie2 = await signIn(app, 'admin2');

        const planRes = await app.inject({
          method: 'POST',
          url: `/floors/${floorId}/floor-plan`,
          headers: { cookie: `dskt_session=${cookie1}` },
          payload: { editingScale: 32 },
        });
        const { revision } = JSON.parse(planRes.body);

        // Admin 1 acquires lease
        const acqRes = await app.inject({
          method: 'POST',
          url: `/floors/${floorId}/floor-plan/revisions/${revision.id}/lease`,
          headers: { cookie: `dskt_session=${cookie1}` },
          payload: { durationSeconds: 300 },
        });
        expect(acqRes.statusCode).toBe(200);
        const { token: token1 } = JSON.parse(acqRes.body);

        // Admin 2 tries to acquire lease -> 409 lease_conflict
        const conflictAcq = await app.inject({
          method: 'POST',
          url: `/floors/${floorId}/floor-plan/revisions/${revision.id}/lease`,
          headers: { cookie: `dskt_session=${cookie2}` },
        });
        expect(conflictAcq.statusCode).toBe(409);
        expect(JSON.parse(conflictAcq.body).error).toBe('lease_conflict');

        // Admin 2 tries to mutate boundary -> 409 lease_conflict
        const conflictMut = await app.inject({
          method: 'PUT',
          url: `/floors/${floorId}/floor-plan/revisions/${revision.id}/boundary`,
          headers: {
            cookie: `dskt_session=${cookie2}`,
            'x-lease-token': 'fake-token',
            'x-client-command-id': randomUUID(),
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
        expect(conflictMut.statusCode).toBe(409);
        expect(JSON.parse(conflictMut.body).error).toBe('lease_conflict');

        // Admin 1 with valid lease token mutates boundary successfully
        const okMut = await app.inject({
          method: 'PUT',
          url: `/floors/${floorId}/floor-plan/revisions/${revision.id}/boundary`,
          headers: {
            cookie: `dskt_session=${cookie1}`,
            'x-lease-token': token1,
            'x-client-command-id': randomUUID(),
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
        expect(okMut.statusCode).toBe(200);
        expect(JSON.parse(okMut.body).concurrencyVersion).toBe(1);
      } finally {
        await app.close();
        await pool.end();
      }
    });
  });

  it('implements idempotent command replay and rejects payload mismatch with 409', async () => {
    await withTestDatabase(databaseUrl!, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url, 3);
      const app = await buildApp({ config: configFor(url), pool });

      try {
        await seedUser(pool, { username: 'facadmin', roleCodes: ['FACILITIES_ADMIN'] });
        const { floorId } = await seedHierarchy(pool);
        const cookie = await signIn(app, 'facadmin');

        const planRes = await app.inject({
          method: 'POST',
          url: `/floors/${floorId}/floor-plan`,
          headers: { cookie: `dskt_session=${cookie}` },
          payload: { editingScale: 32 },
        });
        const { revision } = JSON.parse(planRes.body);

        const acqRes = await app.inject({
          method: 'POST',
          url: `/floors/${floorId}/floor-plan/revisions/${revision.id}/lease`,
          headers: { cookie: `dskt_session=${cookie}` },
          payload: { durationSeconds: 300 },
        });
        const { token } = JSON.parse(acqRes.body);

        const commandId = randomUUID();
        const payload1 = {
          concurrencyVersion: 0,
          vertices: [
            { x: 0, y: 0 },
            { x: 200, y: 0 },
            { x: 200, y: 200 },
            { x: 0, y: 200 },
          ],
        };

        // 1. Initial command execution
        const firstRes = await app.inject({
          method: 'PUT',
          url: `/floors/${floorId}/floor-plan/revisions/${revision.id}/boundary`,
          headers: {
            cookie: `dskt_session=${cookie}`,
            'x-lease-token': token,
            'x-client-command-id': commandId,
          },
          payload: payload1,
        });
        expect(firstRes.statusCode).toBe(200);
        const firstBody = JSON.parse(firstRes.body);
        expect(firstBody.concurrencyVersion).toBe(1);

        // 2. Replay identical command with same client-command-id -> returns cached result without mutating
        const replayRes = await app.inject({
          method: 'PUT',
          url: `/floors/${floorId}/floor-plan/revisions/${revision.id}/boundary`,
          headers: {
            cookie: `dskt_session=${cookie}`,
            'x-lease-token': token,
            'x-client-command-id': commandId,
          },
          payload: payload1,
        });
        expect(replayRes.statusCode).toBe(200);
        const replayBody = JSON.parse(replayRes.body);
        expect(replayBody.concurrencyVersion).toBe(1);

        // 3. Reusing client-command-id with different payload -> 409 command_id_payload_mismatch
        const mismatchRes = await app.inject({
          method: 'PUT',
          url: `/floors/${floorId}/floor-plan/revisions/${revision.id}/boundary`,
          headers: {
            cookie: `dskt_session=${cookie}`,
            'x-lease-token': token,
            'x-client-command-id': commandId,
          },
          payload: {
            concurrencyVersion: 1,
            vertices: [
              { x: 0, y: 0 },
              { x: 300, y: 0 },
              { x: 300, y: 300 },
              { x: 0, y: 300 },
            ],
          },
        });
        expect(mismatchRes.statusCode).toBe(409);
        expect(JSON.parse(mismatchRes.body).error).toBe('command_id_payload_mismatch');

        // Check processed_commands table in db
        const db = drizzle(pool);
        const cmds = await db
          .select()
          .from(processedCommands)
          .where(eq(processedCommands.clientCommandId, commandId));
        expect(cmds.length).toBe(1);
        expect(cmds[0]!.commandType).toBe('update_boundary');
      } finally {
        await app.close();
        await pool.end();
      }
    });
  });

  it('allows takeover of expired lease or deactivated user lease with audit logging', async () => {
    await withTestDatabase(databaseUrl!, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url, 3);
      const app = await buildApp({ config: configFor(url), pool });

      try {
        const user1Id = await seedUser(pool, { username: 'admin1', displayName: 'Admin One', roleCodes: ['FACILITIES_ADMIN'] });
        await seedUser(pool, { username: 'admin2', displayName: 'Admin Two', roleCodes: ['FACILITIES_ADMIN'] });
        const { floorId } = await seedHierarchy(pool);

        const cookie1 = await signIn(app, 'admin1');
        const cookie2 = await signIn(app, 'admin2');

        const planRes = await app.inject({
          method: 'POST',
          url: `/floors/${floorId}/floor-plan`,
          headers: { cookie: `dskt_session=${cookie1}` },
          payload: { editingScale: 32 },
        });
        const { revision } = JSON.parse(planRes.body);

        // Admin 1 acquires lease for 10 seconds
        const acqRes = await app.inject({
          method: 'POST',
          url: `/floors/${floorId}/floor-plan/revisions/${revision.id}/lease`,
          headers: { cookie: `dskt_session=${cookie1}` },
          payload: { durationSeconds: 10 },
        });
        expect(acqRes.statusCode).toBe(200);

        // Takeover while active and holder active is rejected with 409 lease_conflict
        const activeTakeover = await app.inject({
          method: 'POST',
          url: `/floors/${floorId}/floor-plan/revisions/${revision.id}/lease/takeover`,
          headers: { cookie: `dskt_session=${cookie2}` },
        });
        expect(activeTakeover.statusCode).toBe(409);
        expect(JSON.parse(activeTakeover.body).error).toBe('lease_conflict');

        // Case A: Deactivate user1 in database -> lease becomes immediately takeoverable
        const db = drizzle(pool);
        await db.update(appUsers).set({ active: false }).where(eq(appUsers.id, user1Id));

        const deactTakeover = await app.inject({
          method: 'POST',
          url: `/floors/${floorId}/floor-plan/revisions/${revision.id}/lease/takeover`,
          headers: { cookie: `dskt_session=${cookie2}` },
          payload: { reason: 'User1 left company', durationSeconds: 120 },
        });
        expect(deactTakeover.statusCode).toBe(200);
        const takeover1 = JSON.parse(deactTakeover.body);
        expect(takeover1.token).toBeDefined();
        expect(takeover1.owner.displayName).toBe('Admin Two');

        // Verify audit event for TAKEOVER_LEASE
        const auditTakeovers = await db
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.action, 'TAKEOVER_LEASE'));
        expect(auditTakeovers.length).toBe(1);
        expect(auditTakeovers[0]!.summary).toContain('took over editor lease');
        expect(auditTakeovers[0]!.summary).toContain('User1 left company');

        // Case B: Expired lease takeover
        // Manually expire admin2's lease in DB
        await db
          .update(floorPlanEditorLeases)
          .set({ expiresAt: new Date(Date.now() - 5000) })
          .where(eq(floorPlanEditorLeases.floorPlanRevisionId, revision.id));

        // Re-enable admin1 and signIn to test takeover of expired lease
        await db.update(appUsers).set({ active: true }).where(eq(appUsers.id, user1Id));
        const cookie1Again = await signIn(app, 'admin1');

        const expiredTakeover = await app.inject({
          method: 'POST',
          url: `/floors/${floorId}/floor-plan/revisions/${revision.id}/lease/takeover`,
          headers: { cookie: `dskt_session=${cookie1Again}` },
        });
        expect(expiredTakeover.statusCode).toBe(200);
        const takeover2 = JSON.parse(expiredTakeover.body);
        expect(takeover2.owner.displayName).toBe('Admin One');
      } finally {
        await app.close();
        await pool.end();
      }
    });
  });

  it('enforces role authorization on lease endpoints', async () => {
    await withTestDatabase(databaseUrl!, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url, 3);
      const app = await buildApp({ config: configFor(url), pool });

      try {
        await seedUser(pool, { username: 'facadmin', roleCodes: ['FACILITIES_ADMIN'] });
        await seedUser(pool, { username: 'planner', roleCodes: ['WORKPLACE_PLANNER'] });
        await seedUser(pool, { username: 'viewer', roleCodes: ['VIEWER'] });
        const { floorId } = await seedHierarchy(pool);

        const facCookie = await signIn(app, 'facadmin');
        const plannerCookie = await signIn(app, 'planner');
        const viewerCookie = await signIn(app, 'viewer');

        const planRes = await app.inject({
          method: 'POST',
          url: `/floors/${floorId}/floor-plan`,
          headers: { cookie: `dskt_session=${facCookie}` },
          payload: { editingScale: 32 },
        });
        const { revision } = JSON.parse(planRes.body);

        // Planner & Viewer can read lease info (GET /lease) -> 200
        const pGet = await app.inject({
          method: 'GET',
          url: `/floors/${floorId}/floor-plan/revisions/${revision.id}/lease`,
          headers: { cookie: `dskt_session=${plannerCookie}` },
        });
        expect(pGet.statusCode).toBe(200);

        const vGet = await app.inject({
          method: 'GET',
          url: `/floors/${floorId}/floor-plan/revisions/${revision.id}/lease`,
          headers: { cookie: `dskt_session=${viewerCookie}` },
        });
        expect(vGet.statusCode).toBe(200);

        // Planner cannot acquire lease -> 403
        const pAcq = await app.inject({
          method: 'POST',
          url: `/floors/${floorId}/floor-plan/revisions/${revision.id}/lease`,
          headers: { cookie: `dskt_session=${plannerCookie}` },
        });
        expect(pAcq.statusCode).toBe(403);

        // Viewer cannot acquire lease -> 403
        const vAcq = await app.inject({
          method: 'POST',
          url: `/floors/${floorId}/floor-plan/revisions/${revision.id}/lease`,
          headers: { cookie: `dskt_session=${viewerCookie}` },
        });
        expect(vAcq.statusCode).toBe(403);

        // Planner cannot takeover lease -> 403
        const pTakeover = await app.inject({
          method: 'POST',
          url: `/floors/${floorId}/floor-plan/revisions/${revision.id}/lease/takeover`,
          headers: { cookie: `dskt_session=${plannerCookie}` },
        });
        expect(pTakeover.statusCode).toBe(403);
      } finally {
        await app.close();
        await pool.end();
      }
    });
  });
});
