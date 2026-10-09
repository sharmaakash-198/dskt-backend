/**
 * Sites integration tests for Ticket 05.
 *
 * Seam: HTTP API + PostgreSQL for Site persistence, uniqueness, archival,
 * role matrix, validation errors, and audit events.
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
  buildings,
  localAuthCredentials,
  organizations,
  roles,
  sites,
} from '../src/db/schema.js';

const databaseUrl = process.env.DATABASE_URL;
const SECRET = 'sites-test-secret-at-least-32-chars!!';
const PASSWORD = 'correct-horse-battery-staple';
const CORRELATION = 'corr-ticket-05-manage-sites';

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
  const name = `dskt_sites_${randomUUID().replaceAll('-', '')}`;
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

const validSite = {
  code: 'blr',
  name: 'Bengaluru',
  timeZone: 'Asia/Kolkata',
  addressLine1: 'Manyata Tech Park',
  city: 'Bengaluru',
  region: 'KA',
  postalCode: '560045',
  country: 'IN',
};

describe('manage sites', () => {
  beforeEach(() => {
    expect(databaseUrl, 'DATABASE_URL is required for sites integration tests').toBeTruthy();
  });

  it('facilities admin creates, lists, updates, and archives a site with audit', async () => {
    await withTestDatabase(databaseUrl as string, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url, 3);
      await seedUser(pool, {
        username: 'facilities',
        password: PASSWORD,
        roleCodes: ['FACILITIES_ADMIN'],
      });

      const app = await buildApp({ config: configFor(url), pool });
      const cookie = await signInCookie(app, 'facilities');
      const headers = {
        cookie: `dskt_session=${cookie}`,
        'x-correlation-id': CORRELATION,
      };

      const empty = await app.inject({ method: 'GET', url: '/sites', headers });
      expect(empty.statusCode).toBe(200);
      expect(empty.json()).toEqual({ sites: [] });

      const created = await app.inject({
        method: 'POST',
        url: '/sites',
        headers,
        payload: validSite,
      });
      expect(created.statusCode).toBe(201);
      const createdBody = created.json();
      expect(createdBody.code).toBe('BLR');
      expect(createdBody.name).toBe('Bengaluru');
      expect(createdBody.timeZone).toBe('Asia/Kolkata');
      expect(createdBody.address).toEqual({
        addressLine1: 'Manyata Tech Park',
        addressLine2: null,
        city: 'Bengaluru',
        region: 'KA',
        postalCode: '560045',
        country: 'IN',
      });
      const siteId = createdBody.id as string;

      const second = await app.inject({
        method: 'POST',
        url: '/sites',
        headers,
        payload: {
          code: 'HYD',
          name: 'Hyderabad',
          timeZone: 'Asia/Kolkata',
        },
      });
      expect(second.statusCode).toBe(201);

      const listed = await app.inject({ method: 'GET', url: '/sites', headers });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().sites.map((s: { code: string }) => s.code)).toEqual(['BLR', 'HYD']);

      const withLine2 = await app.inject({
        method: 'PATCH',
        url: `/sites/${siteId}`,
        headers,
        payload: {
          name: 'Bengaluru',
          timeZone: 'Asia/Kolkata',
          addressLine2: 'Block B',
        },
      });
      expect(withLine2.statusCode).toBe(200);
      expect(withLine2.json().address.addressLine2).toBe('Block B');

      const updated = await app.inject({
        method: 'PATCH',
        url: `/sites/${siteId}`,
        headers,
        payload: {
          name: 'Bengaluru Campus',
          timeZone: 'Asia/Kolkata',
          city: 'Bengaluru',
          country: 'IN',
        },
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json().name).toBe('Bengaluru Campus');
      expect(updated.json().code).toBe('BLR');
      expect(updated.json().address.addressLine2).toBe('Block B');
      expect(updated.json().address.addressLine1).toBe('Manyata Tech Park');

      const archived = await app.inject({
        method: 'POST',
        url: `/sites/${siteId}/archive`,
        headers,
      });
      expect(archived.statusCode).toBe(200);
      expect(archived.json().id).toBe(siteId);

      const afterArchive = await app.inject({ method: 'GET', url: '/sites', headers });
      expect(afterArchive.json().sites.map((s: { code: string }) => s.code)).toEqual(['HYD']);

      const db = drizzle(pool);
      const retained = await db
        .select({ id: sites.id, code: sites.code, archivedAt: sites.archivedAt })
        .from(sites)
        .where(eq(sites.id, siteId));
      expect(retained[0]?.code).toBe('BLR');
      expect(retained[0]?.archivedAt).toBeTruthy();

      const audits = await db
        .select()
        .from(auditEvents)
        .where(
          and(eq(auditEvents.action, 'site.archived'), eq(auditEvents.correlationId, CORRELATION)),
        );
      expect(audits).toHaveLength(1);
      expect(audits[0]?.targetType).toBe('site');
      expect(audits[0]?.targetId).toBe(siteId);
      expect(audits[0]?.summary).toContain('BLR');

      await app.close();
      await pool.end();
    });
  });

  it('rejects duplicate codes, invalid input, and archive with active buildings', async () => {
    await withTestDatabase(databaseUrl as string, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url, 3);
      await seedUser(pool, {
        username: 'facilities',
        password: PASSWORD,
        roleCodes: ['FACILITIES_ADMIN'],
      });

      const app = await buildApp({ config: configFor(url), pool });
      const cookie = await signInCookie(app, 'facilities');
      const headers = { cookie: `dskt_session=${cookie}` };

      const created = await app.inject({
        method: 'POST',
        url: '/sites',
        headers,
        payload: validSite,
      });
      expect(created.statusCode).toBe(201);
      const siteId = created.json().id as string;

      const duplicate = await app.inject({
        method: 'POST',
        url: '/sites',
        headers,
        payload: { ...validSite, code: 'blr' },
      });
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json()).toEqual({ error: 'site_code_taken' });

      const badCode = await app.inject({
        method: 'POST',
        url: '/sites',
        headers,
        payload: { ...validSite, code: 'bad code!' },
      });
      expect(badCode.statusCode).toBe(400);
      expect(badCode.json()).toEqual({ error: 'invalid_site_code' });

      const badTz = await app.inject({
        method: 'POST',
        url: '/sites',
        headers,
        payload: { ...validSite, code: 'PUN', timeZone: 'Not/AZone' },
      });
      expect(badTz.statusCode).toBe(400);
      expect(badTz.json()).toEqual({ error: 'invalid_time_zone' });

      const db = drizzle(pool);
      await db.insert(buildings).values({
        siteId,
        code: 'A',
        name: 'Building A',
      });

      const blocked = await app.inject({
        method: 'POST',
        url: `/sites/${siteId}/archive`,
        headers,
      });
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json()).toEqual({ error: 'site_has_active_buildings' });

      const stillActive = await app.inject({ method: 'GET', url: '/sites', headers });
      expect(stillActive.json().sites).toHaveLength(1);

      await db
        .update(buildings)
        .set({ archivedAt: new Date() })
        .where(and(eq(buildings.siteId, siteId), isNull(buildings.archivedAt)));

      const allowed = await app.inject({
        method: 'POST',
        url: `/sites/${siteId}/archive`,
        headers,
      });
      expect(allowed.statusCode).toBe(200);

      await app.close();
      await pool.end();
    });
  });

  it('enforces the site role matrix', async () => {
    await withTestDatabase(databaseUrl as string, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url, 4);
      await seedUser(pool, {
        username: 'facilities',
        password: PASSWORD,
        roleCodes: ['FACILITIES_ADMIN'],
      });
      await seedUser(pool, {
        username: 'planner',
        password: PASSWORD,
        roleCodes: ['WORKPLACE_PLANNER'],
      });
      await seedUser(pool, {
        username: 'viewer',
        password: PASSWORD,
        roleCodes: ['VIEWER'],
      });
      await seedUser(pool, {
        username: 'sysadmin',
        password: PASSWORD,
        roleCodes: ['SYSTEM_ADMIN'],
      });

      const app = await buildApp({ config: configFor(url), pool });
      const faCookie = await signInCookie(app, 'facilities');
      const created = await app.inject({
        method: 'POST',
        url: '/sites',
        headers: { cookie: `dskt_session=${faCookie}` },
        payload: validSite,
      });
      expect(created.statusCode).toBe(201);
      const siteId = created.json().id as string;

      for (const username of ['planner', 'viewer'] as const) {
        const cookie = await signInCookie(app, username);
        const headers = { cookie: `dskt_session=${cookie}` };
        const list = await app.inject({ method: 'GET', url: '/sites', headers });
        expect(list.statusCode).toBe(200);
        expect(list.json().sites).toHaveLength(1);

        const mutate = await app.inject({
          method: 'POST',
          url: '/sites',
          headers,
          payload: { code: 'DEL', name: 'Delhi', timeZone: 'Asia/Kolkata' },
        });
        expect(mutate.statusCode).toBe(403);
        expect(mutate.json()).toEqual({ error: 'forbidden' });

        const archive = await app.inject({
          method: 'POST',
          url: `/sites/${siteId}/archive`,
          headers,
        });
        expect(archive.statusCode).toBe(403);

        const patch = await app.inject({
          method: 'PATCH',
          url: `/sites/${siteId}`,
          headers,
          payload: { name: 'Denied', timeZone: 'Asia/Kolkata' },
        });
        expect(patch.statusCode).toBe(403);
      }

      const sysCookie = await signInCookie(app, 'sysadmin');
      const sysHeaders = { cookie: `dskt_session=${sysCookie}` };
      const sysList = await app.inject({ method: 'GET', url: '/sites', headers: sysHeaders });
      expect(sysList.statusCode).toBe(403);

      const unauth = await app.inject({ method: 'GET', url: '/sites' });
      expect(unauth.statusCode).toBe(401);

      await app.close();
      await pool.end();
    });
  });
});
