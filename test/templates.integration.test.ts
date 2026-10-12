/**
 * Element Category / Template identity tests for Ticket 07.
 *
 * Seam: HTTP API + PostgreSQL for ordering, uniqueness, empty revision,
 * and role matrix.
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
  elementTemplates,
  localAuthCredentials,
  organizations,
  roles,
} from '../src/db/schema.js';

const databaseUrl = process.env.DATABASE_URL;
const SECRET = 'templates-test-secret-at-least-32-chars!';
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
  const name = `dskt_tpl_${randomUUID().replaceAll('-', '')}`;
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
  opts: { username: string; password: string; roleCodes?: RoleCode[] },
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
      active: true,
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

describe('element template identity', () => {
  beforeEach(() => {
    expect(databaseUrl, 'DATABASE_URL is required for template integration tests').toBeTruthy();
  });

  it('creates ordered categories and template identity without a revision', async () => {
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

      const empty = await app.inject({ method: 'GET', url: '/element-categories', headers });
      expect(empty.statusCode).toBe(200);
      expect(empty.json()).toEqual({ categories: [] });

      const desk = await app.inject({
        method: 'POST',
        url: '/element-categories',
        headers,
        payload: { code: 'desk', name: 'Desk' },
      });
      expect(desk.statusCode).toBe(201);
      expect(desk.json().code).toBe('DESK');
      const deskId = desk.json().id as string;

      const plant = await app.inject({
        method: 'POST',
        url: '/element-categories',
        headers,
        payload: { code: 'PLANT', name: 'Plant' },
      });
      expect(plant.statusCode).toBe(201);
      const plantId = plant.json().id as string;

      const listed = await app.inject({ method: 'GET', url: '/element-categories', headers });
      expect(listed.json().categories.map((c: { code: string }) => c.code)).toEqual([
        'DESK',
        'PLANT',
      ]);

      const reordered = await app.inject({
        method: 'PUT',
        url: '/element-categories/order',
        headers,
        payload: { categoryIds: [plantId, deskId] },
      });
      expect(reordered.statusCode).toBe(200);
      expect(reordered.json().categories.map((c: { code: string }) => c.code)).toEqual([
        'PLANT',
        'DESK',
      ]);

      const template = await app.inject({
        method: 'POST',
        url: `/element-categories/${deskId}/templates`,
        headers,
        payload: {
          code: 'std-desk',
          name: 'Standard Desk',
          description: '1200mm desk',
        },
      });
      expect(template.statusCode).toBe(201);
      expect(template.json()).toMatchObject({
        code: 'STD-DESK',
        name: 'Standard Desk',
        description: '1200mm desk',
        currentRevisionId: null,
        placeable: false,
        archivedAt: null,
      });
      const templateId = template.json().id as string;

      const templates = await app.inject({
        method: 'GET',
        url: `/element-categories/${deskId}/templates`,
        headers,
      });
      expect(templates.statusCode).toBe(200);
      expect(templates.json().templates).toHaveLength(1);

      const db = drizzle(pool);
      const rows = await db.select().from(elementTemplates).where(eq(elementTemplates.id, templateId));
      expect(rows).toHaveLength(1);
      // No revision table exists yet; identity row alone proves no revision was created.
      expect(rows[0]?.code).toBe('STD-DESK');

      const duplicateCategory = await app.inject({
        method: 'POST',
        url: '/element-categories',
        headers,
        payload: { code: 'desk', name: 'Other' },
      });
      expect(duplicateCategory.statusCode).toBe(409);
      expect(duplicateCategory.json()).toEqual({ error: 'category_code_taken' });

      const duplicateTemplate = await app.inject({
        method: 'POST',
        url: `/element-categories/${deskId}/templates`,
        headers,
        payload: { code: 'STD-DESK', name: 'Clone' },
      });
      expect(duplicateTemplate.statusCode).toBe(409);
      expect(duplicateTemplate.json()).toEqual({ error: 'template_code_taken' });

      const archived = await app.inject({
        method: 'POST',
        url: `/element-categories/${deskId}/archive`,
        headers,
      });
      expect(archived.statusCode).toBe(200);
      expect(archived.json().archivedAt).toBeTruthy();

      const createOnArchived = await app.inject({
        method: 'POST',
        url: `/element-categories/${deskId}/templates`,
        headers,
        payload: { code: 'X', name: 'Nope' },
      });
      expect(createOnArchived.statusCode).toBe(409);
      expect(createOnArchived.json()).toEqual({ error: 'category_archived' });

      await app.close();
      await pool.end();
    });
  });

  it('enforces the template catalog role matrix', async () => {
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
      const faHeaders = { cookie: `dskt_session=${faCookie}` };

      const category = await app.inject({
        method: 'POST',
        url: '/element-categories',
        headers: faHeaders,
        payload: { code: 'DESK', name: 'Desk' },
      });
      expect(category.statusCode).toBe(201);
      const categoryId = category.json().id as string;

      await app.inject({
        method: 'POST',
        url: `/element-categories/${categoryId}/templates`,
        headers: faHeaders,
        payload: { code: 'A', name: 'Desk A' },
      });

      for (const username of ['planner', 'viewer'] as const) {
        const cookie = await signInCookie(app, username);
        const headers = { cookie: `dskt_session=${cookie}` };

        const list = await app.inject({ method: 'GET', url: '/element-categories', headers });
        expect(list.statusCode).toBe(200);
        expect(list.json().categories).toHaveLength(1);

        const templates = await app.inject({
          method: 'GET',
          url: `/element-categories/${categoryId}/templates`,
          headers,
        });
        expect(templates.statusCode).toBe(200);
        expect(templates.json().templates[0].placeable).toBe(false);

        const mutate = await app.inject({
          method: 'POST',
          url: '/element-categories',
          headers,
          payload: { code: 'X', name: 'Denied' },
        });
        expect(mutate.statusCode).toBe(403);

        const createTemplate = await app.inject({
          method: 'POST',
          url: `/element-categories/${categoryId}/templates`,
          headers,
          payload: { code: 'Z', name: 'Denied' },
        });
        expect(createTemplate.statusCode).toBe(403);
      }

      const sysCookie = await signInCookie(app, 'sysadmin');
      const sysList = await app.inject({
        method: 'GET',
        url: '/element-categories',
        headers: { cookie: `dskt_session=${sysCookie}` },
      });
      expect(sysList.statusCode).toBe(403);

      await app.close();
      await pool.end();
    });
  });
});
