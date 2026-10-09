/**
 * Authorization integration tests for Ticket 03.
 *
 * Exercises workspace-entry operations for every role combination at the
 * HTTP/PostgreSQL seam. Backend authorization is authoritative.
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
  localAuthCredentials,
  organizations,
  roles,
} from '../src/db/schema.js';

const databaseUrl = process.env.DATABASE_URL;
const SECRET = 'authz-test-secret-that-is-at-least-32ch!';
const PASSWORD = 'correct-horse-battery-staple';

const WORKSPACE_PATHS = {
  facilities: '/workspace/facilities',
  workplace: '/workspace/workplace',
  viewer: '/workspace/viewer',
  access_admin: '/workspace/access-admin',
} as const;

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
  const name = `dskt_authz_${randomUUID().replaceAll('-', '')}`;
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

describe('role-authorized workspace', () => {
  beforeEach(() => {
    expect(databaseUrl, 'DATABASE_URL is required for authorization integration tests').toBeTruthy();
  });

  it('session returns the union of active roles and permitted navigation', async () => {
    await withTestDatabase(databaseUrl as string, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url, 3);
      await seedUser(pool, {
        username: 'multi',
        password: PASSWORD,
        roleCodes: ['FACILITIES_ADMIN', 'VIEWER'],
      });

      const app = await buildApp({ config: configFor(url), pool });
      const signIn = await app.inject({
        method: 'POST',
        url: '/auth/local/sign-in',
        payload: { username: 'multi', password: PASSWORD },
      });

      expect(signIn.statusCode).toBe(200);
      const body = signIn.json();
      expect(body.roles.sort()).toEqual(['FACILITIES_ADMIN', 'VIEWER']);
      expect(body.navigation).toEqual(['facilities', 'viewer']);
      expect(body.user.email).toBe('multi@test.local');
      expect(body).not.toHaveProperty('provider');

      await app.close();
      await pool.end();
    });
  });

  it.each([
    {
      username: 'facilities',
      roleCodes: ['FACILITIES_ADMIN'] as RoleCode[],
      allowed: ['facilities'] as const,
      denied: ['workplace', 'viewer', 'access_admin'] as const,
      navigation: ['facilities'],
    },
    {
      username: 'workplace',
      roleCodes: ['WORKPLACE_PLANNER'] as RoleCode[],
      allowed: ['workplace'] as const,
      denied: ['facilities', 'viewer', 'access_admin'] as const,
      navigation: ['workplace'],
    },
    {
      username: 'viewer',
      roleCodes: ['VIEWER'] as RoleCode[],
      allowed: ['viewer'] as const,
      denied: ['facilities', 'workplace', 'access_admin'] as const,
      navigation: ['viewer'],
    },
    {
      username: 'sysadmin',
      roleCodes: ['SYSTEM_ADMIN'] as RoleCode[],
      allowed: ['access_admin'] as const,
      denied: ['facilities', 'workplace', 'viewer'] as const,
      navigation: ['access_admin'],
    },
    {
      username: 'combo',
      roleCodes: ['FACILITIES_ADMIN', 'WORKPLACE_PLANNER', 'VIEWER'] as RoleCode[],
      allowed: ['facilities', 'workplace', 'viewer'] as const,
      denied: ['access_admin'] as const,
      navigation: ['facilities', 'workplace', 'viewer'],
    },
  ])(
    '$username can enter granted workspaces and is denied elsewhere',
    async ({ username, roleCodes, allowed, denied, navigation }) => {
      await withTestDatabase(databaseUrl as string, async (url) => {
        await applyMigrations(url);
        const pool = createPool(url, 3);
        await seedUser(pool, { username, password: PASSWORD, roleCodes });

        const app = await buildApp({ config: configFor(url), pool });
        const cookie = await signInCookie(app, username);

        const session = await app.inject({
          method: 'GET',
          url: '/auth/session',
          headers: { cookie: `dskt_session=${cookie}` },
        });
        expect(session.statusCode).toBe(200);
        expect(session.json().navigation).toEqual(navigation);

        for (const key of allowed) {
          const res = await app.inject({
            method: 'GET',
            url: WORKSPACE_PATHS[key],
            headers: { cookie: `dskt_session=${cookie}` },
          });
          expect(res.statusCode).toBe(200);
          expect(res.json().workspace).toBe(key);
          expect(res.json().emptyState).toBeTruthy();
          expect(res.body).not.toContain('password');
        }

        for (const key of denied) {
          const res = await app.inject({
            method: 'GET',
            url: WORKSPACE_PATHS[key],
            headers: { cookie: `dskt_session=${cookie}` },
          });
          expect(res.statusCode).toBe(403);
          expect(res.json()).toEqual({ error: 'forbidden' });
        }

        await app.close();
        await pool.end();
      });
    },
  );

  it('no-role user authenticates but cannot enter any workspace', async () => {
    await withTestDatabase(databaseUrl as string, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url, 3);
      await seedUser(pool, { username: 'norole', password: PASSWORD, roleCodes: [] });

      const app = await buildApp({ config: configFor(url), pool });
      const cookie = await signInCookie(app, 'norole');

      const session = await app.inject({
        method: 'GET',
        url: '/auth/session',
        headers: { cookie: `dskt_session=${cookie}` },
      });
      expect(session.statusCode).toBe(200);
      expect(session.json().roles).toEqual([]);
      expect(session.json().navigation).toEqual([]);

      for (const path of Object.values(WORKSPACE_PATHS)) {
        const res = await app.inject({
          method: 'GET',
          url: path,
          headers: { cookie: `dskt_session=${cookie}` },
        });
        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: 'forbidden' });
      }

      await app.close();
      await pool.end();
    });
  });

  it('unauthenticated callers receive 401 without workspace data', async () => {
    await withTestDatabase(databaseUrl as string, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url, 2);
      const app = await buildApp({ config: configFor(url), pool });

      for (const path of Object.values(WORKSPACE_PATHS)) {
        const res = await app.inject({ method: 'GET', url: path });
        expect(res.statusCode).toBe(401);
        expect(res.json()).toEqual({ error: 'unauthorized' });
        expect(res.body).not.toContain('emptyState');
      }

      await app.close();
      await pool.end();
    });
  });

  it('inactive users cannot enter workspaces even with a prior cookie', async () => {
    await withTestDatabase(databaseUrl as string, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url, 3);
      await seedUser(pool, {
        username: 'inactive',
        password: PASSWORD,
        roleCodes: ['VIEWER'],
      });

      const app = await buildApp({ config: configFor(url), pool });
      const cookie = await signInCookie(app, 'inactive');

      await pool.query(`UPDATE dskt.app_users SET active = FALSE WHERE email = 'inactive@test.local'`);

      const res = await app.inject({
        method: 'GET',
        url: WORKSPACE_PATHS.viewer,
        headers: { cookie: `dskt_session=${cookie}` },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'unauthorized' });

      await app.close();
      await pool.end();
    });
  });

  it('revoked roles take effect on the next request', async () => {
    await withTestDatabase(databaseUrl as string, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url, 3);
      const userId = await seedUser(pool, {
        username: 'revoked',
        password: PASSWORD,
        roleCodes: ['FACILITIES_ADMIN'],
      });

      const app = await buildApp({ config: configFor(url), pool });
      const cookie = await signInCookie(app, 'revoked');

      const before = await app.inject({
        method: 'GET',
        url: WORKSPACE_PATHS.facilities,
        headers: { cookie: `dskt_session=${cookie}` },
      });
      expect(before.statusCode).toBe(200);

      const db = drizzle(pool);
      await db
        .update(appUserRoles)
        .set({ revokedAt: new Date() })
        .where(and(eq(appUserRoles.appUserId, userId), isNull(appUserRoles.revokedAt)));

      const after = await app.inject({
        method: 'GET',
        url: WORKSPACE_PATHS.facilities,
        headers: { cookie: `dskt_session=${cookie}` },
      });
      expect(after.statusCode).toBe(403);
      expect(after.json()).toEqual({ error: 'forbidden' });

      const session = await app.inject({
        method: 'GET',
        url: '/auth/session',
        headers: { cookie: `dskt_session=${cookie}` },
      });
      expect(session.statusCode).toBe(200);
      expect(session.json().roles).toEqual([]);
      expect(session.json().navigation).toEqual([]);

      await app.close();
      await pool.end();
    });
  });
});
