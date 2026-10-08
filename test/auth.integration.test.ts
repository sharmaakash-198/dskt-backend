/**
 * Auth integration tests.
 *
 * Exercises the sign-in → session → sign-out flow at the HTTP boundary
 * against a real empty PostgreSQL database.
 *
 * Requires DATABASE_URL pointing at a local Postgres instance.
 */
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { applyMigrations } from '../src/db/migrate.js';
import {
  appUserIdentities,
  appUsers,
  localAuthCredentials,
  organizations,
} from '../src/db/schema.js';

const databaseUrl = process.env.DATABASE_URL;

const SECRET = 'auth-test-secret-that-is-at-least-32ch!!';

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
  const name = `dskt_auth_${randomUUID().replaceAll('-', '')}`;
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

/** Seed a synthetic user and return their username/password */
async function seedUser(
  pool: pg.Pool,
  opts: { username: string; password: string; active?: boolean },
): Promise<void> {
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

describe('local auth', () => {
  beforeEach(async () => {
    expect(databaseUrl, 'DATABASE_URL is required for auth integration tests').toBeTruthy();
  });

  it('valid credentials create a session; GET /auth/session returns the user; sign-out revokes', async () => {
    await withTestDatabase(databaseUrl as string, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url, 3);
      await seedUser(pool, { username: 'alice', password: 'correct-horse-battery-staple' });

      const app = await buildApp({ config: configFor(url), pool });

      // Sign in with correct credentials
      const signIn = await app.inject({
        method: 'POST',
        url: '/auth/local/sign-in',
        payload: { username: 'alice', password: 'correct-horse-battery-staple' },
      });
      expect(signIn.statusCode).toBe(200);
      expect(signIn.json().user.email).toBe('alice@test.local');
      expect(signIn.body).not.toContain('password');

      const cookie = extractCookie(signIn.headers);
      expect(cookie).toBeTruthy();
      expect(cookie!.length).toBeGreaterThan(20);

      // Session restoration
      const session = await app.inject({
        method: 'GET',
        url: '/auth/session',
        headers: { cookie: `dskt_session=${cookie}` },
      });
      expect(session.statusCode).toBe(200);
      expect(session.json().user.email).toBe('alice@test.local');

      // Sign out
      const signOut = await app.inject({
        method: 'POST',
        url: '/auth/sign-out',
        headers: { cookie: `dskt_session=${cookie}` },
      });
      expect(signOut.statusCode).toBe(200);
      expect(signOut.json().ok).toBe(true);

      // Token is now revoked
      const after = await app.inject({
        method: 'GET',
        url: '/auth/session',
        headers: { cookie: `dskt_session=${cookie}` },
      });
      expect(after.statusCode).toBe(401);
      expect(after.json().error).toBe('unauthorized');

      await app.close();
      await pool.end();
    });
  });

  it('wrong password returns 401 with a generic error; does not reveal username existence', async () => {
    await withTestDatabase(databaseUrl as string, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url, 2);
      await seedUser(pool, { username: 'bob', password: 'correct-password' });

      const app = await buildApp({ config: configFor(url), pool });

      const wrong = await app.inject({
        method: 'POST',
        url: '/auth/local/sign-in',
        payload: { username: 'bob', password: 'wrong' },
      });
      expect(wrong.statusCode).toBe(401);
      expect(wrong.json().error).toBe('invalid_credentials');

      const missing = await app.inject({
        method: 'POST',
        url: '/auth/local/sign-in',
        payload: { username: 'nonexistent', password: 'anything' },
      });
      expect(missing.statusCode).toBe(401);
      expect(missing.json().error).toBe('invalid_credentials');

      // Responses must be identical (no timing oracle via different errors)
      expect(wrong.json()).toEqual(missing.json());

      await app.close();
      await pool.end();
    });
  });

  it('rejects session for inactive user', async () => {
    await withTestDatabase(databaseUrl as string, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url, 2);
      await seedUser(pool, { username: 'carol', password: 'password123', active: false });

      const app = await buildApp({ config: configFor(url), pool });

      const signIn = await app.inject({
        method: 'POST',
        url: '/auth/local/sign-in',
        payload: { username: 'carol', password: 'password123' },
      });
      expect(signIn.statusCode).toBe(401);

      await app.close();
      await pool.end();
    });
  });

  it('session without cookie returns 401', async () => {
    await withTestDatabase(databaseUrl as string, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url, 2);

      const app = await buildApp({ config: configFor(url), pool });

      const session = await app.inject({ method: 'GET', url: '/auth/session' });
      expect(session.statusCode).toBe(401);
      expect(session.json().error).toBe('unauthorized');

      await app.close();
      await pool.end();
    });
  });

  it('malformed session token returns 401', async () => {
    await withTestDatabase(databaseUrl as string, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url, 2);

      const app = await buildApp({ config: configFor(url), pool });

      const session = await app.inject({
        method: 'GET',
        url: '/auth/session',
        headers: { cookie: 'dskt_session=notavalidtoken' },
      });
      expect(session.statusCode).toBe(401);

      await app.close();
      await pool.end();
    });
  });

  it('sign-out without cookie still returns 200', async () => {
    await withTestDatabase(databaseUrl as string, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url, 2);

      const app = await buildApp({ config: configFor(url), pool });

      const res = await app.inject({ method: 'POST', url: '/auth/sign-out' });
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);

      await app.close();
      await pool.end();
    });
  });

  it('cookie and credential values are absent from the 200 response body', async () => {
    await withTestDatabase(databaseUrl as string, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url, 2);
      await seedUser(pool, { username: 'dave', password: 'secret-password-value' });

      const app = await buildApp({ config: configFor(url), pool });

      const signIn = await app.inject({
        method: 'POST',
        url: '/auth/local/sign-in',
        payload: { username: 'dave', password: 'secret-password-value' },
      });
      expect(signIn.statusCode).toBe(200);
      expect(signIn.body).not.toContain('secret-password-value');
      expect(signIn.body).not.toContain('dskt_session');
      expect(signIn.body).not.toContain('password_hash');

      await app.close();
      await pool.end();
    });
  });
});
