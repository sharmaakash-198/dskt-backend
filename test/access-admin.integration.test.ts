/**
 * Access-administration integration tests for Ticket 04.
 *
 * Seam: HTTP API + PostgreSQL for System Admin user/role operations,
 * authorization denial, deactivation, lease reclaim eligibility, and audit.
 */
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { and, eq, isNull } from 'drizzle-orm';
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
  editorLeases,
  localAuthCredentials,
  organizations,
  roles,
} from '../src/db/schema.js';

const databaseUrl = process.env.DATABASE_URL;
const SECRET = 'access-admin-test-secret-at-least-32ch!';
const PASSWORD = 'correct-horse-battery-staple';
const CORRELATION = 'corr-ticket-04-access-admin';

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
  const name = `dskt_access_${randomUUID().replaceAll('-', '')}`;
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
  pool.on('error', () => {
    // suppress errors when test database is torn down
  });
  return pool;
}

async function seedUser(
  pool: pg.Pool,
  opts: { username: string; password: string; active?: boolean; roleCodes?: RoleCode[] },
): Promise<string> {
  const db = drizzle(pool);
  const inserted = await db
    .insert(organizations)
    .values({ name: 'Arrise' })
    .onConflictDoNothing()
    .returning({ id: organizations.id });

  let orgId: string;
  if (inserted.length > 0) {
    orgId = inserted[0]!.id;
  } else {
    const existing = await db.select({ id: organizations.id }).from(organizations);
    orgId = existing[0]!.id;
  }

  const insertedUsers = await db
    .insert(appUsers)
    .values({
      organizationId: orgId,
      email: `${opts.username}@test.local`,
      displayName: opts.username,
      active: opts.active ?? true,
    })
    .returning({ id: appUsers.id });
  const userId = insertedUsers[0]!.id;

  await db.insert(appUserIdentities).values({
    appUserId: userId,
    provider: 'LOCAL',
    providerSubject: opts.username.toLowerCase(),
  });

  const passwordHash = await argon2.hash(opts.password, { type: argon2.argon2id });
  await db.insert(localAuthCredentials).values({
    appUserId: userId,
    username: opts.username.toLowerCase(),
    passwordHash,
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
  const match = header.match(/dskt_session=([^;]+)/);
  return match ? match[1] : undefined;
}

async function signInCookie(
  app: Awaited<ReturnType<typeof buildApp>>,
  username: string,
): Promise<string> {
  const signIn = await app.inject({
    method: 'POST',
    url: '/auth/local/sign-in',
    payload: { username, password: PASSWORD },
  });
  expect(signIn.statusCode).toBe(200);
  const cookie = extractCookie(signIn.headers);
  expect(cookie).toBeTruthy();
  return cookie!;
}

describe('manage local users and roles', () => {
  beforeEach(() => {
    expect(databaseUrl, 'DATABASE_URL is required for access-admin integration tests').toBeTruthy();
  });

  it('system admin creates a local user, grants and revokes roles, and audits changes', async () => {
    await withTestDatabase(databaseUrl as string, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url, 3);
      const adminId = await seedUser(pool, {
        username: 'sysadmin',
        password: PASSWORD,
        roleCodes: ['SYSTEM_ADMIN'],
      });

      const app = await buildApp({ config: configFor(url), pool });
      const cookie = await signInCookie(app, 'sysadmin');
      const headers = {
        cookie: `dskt_session=${cookie}`,
        'x-correlation-id': CORRELATION,
      };

      const created = await app.inject({
        method: 'POST',
        url: '/access-admin/users',
        headers,
        payload: {
          email: 'planner@test.local',
          displayName: 'Workplace Planner',
          username: 'planner',
          password: 'initial-out-of-band-password',
        },
      });
      expect(created.statusCode).toBe(201);
      const createdBody = created.json();
      expect(createdBody.user.email).toBe('planner@test.local');
      expect(createdBody.user.displayName).toBe('Workplace Planner');
      expect(createdBody.user.active).toBe(true);
      expect(createdBody.roles).toEqual([]);
      expect(createdBody).not.toHaveProperty('password');
      expect(createdBody).not.toHaveProperty('passwordHash');
      expect(JSON.stringify(createdBody)).not.toMatch(/argon2|password_hash|dskt_session/i);

      const userId = createdBody.user.id as string;

      const grant = await app.inject({
        method: 'POST',
        url: `/access-admin/users/${userId}/roles`,
        headers,
        payload: { role: 'WORKPLACE_PLANNER' },
      });
      expect(grant.statusCode).toBe(200);
      expect(grant.json().roles.sort()).toEqual(['WORKPLACE_PLANNER']);

      const duplicate = await app.inject({
        method: 'POST',
        url: `/access-admin/users/${userId}/roles`,
        headers,
        payload: { role: 'WORKPLACE_PLANNER' },
      });
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json()).toEqual({ error: 'role_already_granted' });

      const grantViewer = await app.inject({
        method: 'POST',
        url: `/access-admin/users/${userId}/roles`,
        headers,
        payload: { role: 'VIEWER' },
      });
      expect(grantViewer.statusCode).toBe(200);

      const grantFacilities = await app.inject({
        method: 'POST',
        url: `/access-admin/users/${userId}/roles`,
        headers,
        payload: { role: 'FACILITIES_ADMIN' },
      });
      expect(grantFacilities.statusCode).toBe(200);
      expect(grantFacilities.json().roles.sort()).toEqual([
        'FACILITIES_ADMIN',
        'VIEWER',
        'WORKPLACE_PLANNER',
      ]);

      const revoke = await app.inject({
        method: 'DELETE',
        url: `/access-admin/users/${userId}/roles/WORKPLACE_PLANNER`,
        headers,
      });
      expect(revoke.statusCode).toBe(200);
      expect(revoke.json().roles.sort()).toEqual(['FACILITIES_ADMIN', 'VIEWER']);

      const db = drizzle(pool);
      const history = await db
        .select({
          roleId: appUserRoles.roleId,
          revokedAt: appUserRoles.revokedAt,
        })
        .from(appUserRoles)
        .where(eq(appUserRoles.appUserId, userId));
      expect(history.length).toBe(3);
      expect(history.filter((row) => row.revokedAt === null).length).toBe(2);
      expect(history.filter((row) => row.revokedAt !== null).length).toBe(1);

      const audits = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.correlationId, CORRELATION));
      const actions = audits.map((row) => row.action).sort();
      expect(actions).toEqual(
        [
          'role.granted',
          'role.granted',
          'role.granted',
          'role.revoked',
          'user.created',
        ].sort(),
      );
      for (const row of audits) {
        expect(row.actorUserId).toBe(adminId);
        expect(row.targetId).toBe(userId);
        expect(row.correlationId).toBe(CORRELATION);
        expect(row.occurredAt).toBeInstanceOf(Date);
        expect(JSON.stringify(row)).not.toMatch(/argon2|password|token/i);
      }

      await app.close();
      await pool.end();
    });
  });

  it('deactivation blocks the next request and permits editor lease reclaim', async () => {
    await withTestDatabase(databaseUrl as string, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url, 3);
      await seedUser(pool, {
        username: 'sysadmin',
        password: PASSWORD,
        roleCodes: ['SYSTEM_ADMIN'],
      });
      const targetId = await seedUser(pool, {
        username: 'target',
        password: PASSWORD,
        roleCodes: ['FACILITIES_ADMIN'],
      });

      const db = drizzle(pool);
      await db.insert(editorLeases).values({
        appUserId: targetId,
        resourceKey: 'draft:fixture-floor',
        expiresAt: new Date(Date.now() + 60_000),
      });

      const app = await buildApp({ config: configFor(url), pool });
      const adminCookie = await signInCookie(app, 'sysadmin');
      const targetCookie = await signInCookie(app, 'target');

      const before = await app.inject({
        method: 'GET',
        url: '/workspace/facilities',
        headers: { cookie: `dskt_session=${targetCookie}` },
      });
      expect(before.statusCode).toBe(200);

      const deactivate = await app.inject({
        method: 'POST',
        url: `/access-admin/users/${targetId}/deactivate`,
        headers: {
          cookie: `dskt_session=${adminCookie}`,
          'x-correlation-id': CORRELATION,
        },
      });
      expect(deactivate.statusCode).toBe(200);
      expect(deactivate.json().user.active).toBe(false);
      expect(deactivate.json().editorLeasesReclaimable).toBe(true);

      const blocked = await app.inject({
        method: 'GET',
        url: '/workspace/facilities',
        headers: { cookie: `dskt_session=${targetCookie}` },
      });
      expect(blocked.statusCode).toBe(401);
      expect(blocked.json()).toEqual({ error: 'unauthorized' });

      const reclaim = await app.inject({
        method: 'POST',
        url: `/access-admin/users/${targetId}/editor-leases/reclaim`,
        headers: {
          cookie: `dskt_session=${adminCookie}`,
          'x-correlation-id': CORRELATION,
        },
      });
      expect(reclaim.statusCode).toBe(200);
      expect(reclaim.json()).toEqual({ reclaimed: 1 });

      const leases = await db
        .select()
        .from(editorLeases)
        .where(and(eq(editorLeases.appUserId, targetId), isNull(editorLeases.releasedAt)));
      expect(leases).toEqual([]);

      const audits = await db
        .select({ action: auditEvents.action })
        .from(auditEvents)
        .where(eq(auditEvents.correlationId, CORRELATION));
      expect(audits.map((row) => row.action).sort()).toEqual(
        ['editor_lease.reclaimed', 'user.deactivated'].sort(),
      );

      await app.close();
      await pool.end();
    });
  });

  it.each([
    { username: 'facilities', roleCodes: ['FACILITIES_ADMIN'] as RoleCode[] },
    { username: 'workplace', roleCodes: ['WORKPLACE_PLANNER'] as RoleCode[] },
    { username: 'viewer', roleCodes: ['VIEWER'] as RoleCode[] },
  ])('$username cannot administer access', async ({ username, roleCodes }) => {
    await withTestDatabase(databaseUrl as string, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url, 3);
      await seedUser(pool, { username, password: PASSWORD, roleCodes });
      const targetId = await seedUser(pool, {
        username: 'target',
        password: PASSWORD,
        roleCodes: ['VIEWER'],
      });

      const app = await buildApp({ config: configFor(url), pool });
      const cookie = await signInCookie(app, username);

      const create = await app.inject({
        method: 'POST',
        url: '/access-admin/users',
        headers: { cookie: `dskt_session=${cookie}` },
        payload: {
          email: 'x@test.local',
          displayName: 'X',
          username: 'xuser',
          password: 'out-of-band-password',
        },
      });
      expect(create.statusCode).toBe(403);
      expect(create.json()).toEqual({ error: 'forbidden' });

      const grant = await app.inject({
        method: 'POST',
        url: `/access-admin/users/${targetId}/roles`,
        headers: { cookie: `dskt_session=${cookie}` },
        payload: { role: 'VIEWER' },
      });
      expect(grant.statusCode).toBe(403);

      await app.close();
      await pool.end();
    });
  });

  it('system admin alone cannot enter domain workspaces', async () => {
    await withTestDatabase(databaseUrl as string, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url, 3);
      await seedUser(pool, {
        username: 'sysadmin',
        password: PASSWORD,
        roleCodes: ['SYSTEM_ADMIN'],
      });

      const app = await buildApp({ config: configFor(url), pool });
      const cookie = await signInCookie(app, 'sysadmin');

      for (const path of ['/workspace/facilities', '/workspace/workplace', '/workspace/viewer']) {
        const res = await app.inject({
          method: 'GET',
          url: path,
          headers: { cookie: `dskt_session=${cookie}` },
        });
        expect(res.statusCode).toBe(403);
      }

      const list = await app.inject({
        method: 'GET',
        url: '/access-admin/users',
        headers: { cookie: `dskt_session=${cookie}` },
      });
      expect(list.statusCode).toBe(200);
      expect(list.json().users).toHaveLength(1);
      expect(JSON.stringify(list.json())).not.toMatch(/argon2|password_hash|dskt_session/i);

      await app.close();
      await pool.end();
    });
  });
});
