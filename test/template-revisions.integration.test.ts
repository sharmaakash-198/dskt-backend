/**
 * Template Revision integration tests for Ticket 08.
 *
 * Seam: HTTP API + PostgreSQL for atomic revision creation, numbering,
 * immutability (not current), geometry validation, and authorization.
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
  elementTemplateRevisionVertices,
  elementTemplateRevisions,
  elementTemplates,
  localAuthCredentials,
  organizations,
  roles,
} from '../src/db/schema.js';

const databaseUrl = process.env.DATABASE_URL;
const SECRET = 'template-revisions-test-secret-32chars!';
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
  const name = `dskt_rev_${randomUUID().replaceAll('-', '')}`;
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

const rectangle = [
  { x: 2, y: 2 },
  { x: 12, y: 2 },
  { x: 12, y: 10 },
  { x: 2, y: 10 },
];

describe('immutable template revisions', () => {
  beforeEach(() => {
    expect(databaseUrl).toBeTruthy();
  });

  it('creates numbered immutable revisions without selecting them as current', async () => {
    await withTestDatabase(databaseUrl as string, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url, 3);
      await seedUser(pool, { username: 'facilities', roleCodes: ['FACILITIES_ADMIN'] });
      const app = await buildApp({ config: configFor(url), pool });
      const headers = { cookie: `dskt_session=${await signIn(app, 'facilities')}` };

      const category = await app.inject({
        method: 'POST',
        url: '/element-categories',
        headers,
        payload: { code: 'DESK', name: 'Desk' },
      });
      const categoryId = category.json().id as string;
      const template = await app.inject({
        method: 'POST',
        url: `/element-categories/${categoryId}/templates`,
        headers,
        payload: { code: 'A', name: 'Desk A' },
      });
      const templateId = template.json().id as string;
      expect(template.json().placeable).toBe(false);
      expect(template.json().currentRevisionId).toBeNull();

      const created = await app.inject({
        method: 'POST',
        url: `/element-templates/${templateId}/revisions`,
        headers,
        payload: {
          spatialClass: 'PHYSICAL',
          assignable: true,
          borderColor: '#112233',
          fillColor: '#aabbcc',
          vertices: rectangle,
        },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({
        revisionNumber: 1,
        assignable: true,
        spatialClass: 'PHYSICAL',
        isCurrent: false,
        vertices: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 8 },
          { x: 0, y: 8 },
        ],
      });
      const revisionId = created.json().id as string;

      const second = await app.inject({
        method: 'POST',
        url: `/element-templates/${templateId}/revisions`,
        headers,
        payload: {
          spatialClass: 'ZONE',
          assignable: false,
          borderColor: '#000000',
          fillColor: '#ffffff',
          vertices: rectangle,
        },
      });
      expect(second.statusCode).toBe(201);
      expect(second.json().revisionNumber).toBe(2);
      expect(second.json().isCurrent).toBe(false);

      const listed = await app.inject({
        method: 'GET',
        url: `/element-templates/${templateId}/revisions`,
        headers,
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().revisions.map((r: { revisionNumber: number }) => r.revisionNumber)).toEqual([
        2, 1,
      ]);

      const templates = await app.inject({
        method: 'GET',
        url: `/element-categories/${categoryId}/templates`,
        headers,
      });
      expect(templates.json().templates[0].currentRevisionId).toBeNull();
      expect(templates.json().templates[0].placeable).toBe(false);

      const db = drizzle(pool);
      const templateRow = await db
        .select()
        .from(elementTemplates)
        .where(eq(elementTemplates.id, templateId));
      expect(templateRow[0]?.currentRevisionId).toBeNull();

      const verts = await db
        .select()
        .from(elementTemplateRevisionVertices)
        .where(eq(elementTemplateRevisionVertices.elementTemplateRevisionId, revisionId));
      expect(verts).toHaveLength(4);

      const deniedAssignable = await app.inject({
        method: 'POST',
        url: `/element-templates/${templateId}/revisions`,
        headers,
        payload: {
          spatialClass: 'ZONE',
          assignable: true,
          borderColor: '#000000',
          fillColor: '#ffffff',
          vertices: rectangle,
        },
      });
      expect(deniedAssignable.statusCode).toBe(400);
      expect(deniedAssignable.json()).toEqual({ error: 'invalid_assignability' });

      const diagonal = await app.inject({
        method: 'POST',
        url: `/element-templates/${templateId}/revisions`,
        headers,
        payload: {
          spatialClass: 'PHYSICAL',
          assignable: false,
          borderColor: '#000000',
          fillColor: '#ffffff',
          vertices: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 8, y: 8 },
            { x: 0, y: 8 },
          ],
        },
      });
      expect(diagonal.statusCode).toBe(400);
      expect(diagonal.json().error).toBe('invalid_geometry');
      expect(diagonal.json().diagnostics[0].code).toBe('non_orthogonal_edge');
      expect(diagonal.json().diagnostics[0].edgeIndex).toBe(1);

      // Failure must not create a partial revision number gap from the diagonal attempt.
      const afterFail = await db
        .select()
        .from(elementTemplateRevisions)
        .where(eq(elementTemplateRevisions.elementTemplateId, templateId));
      expect(afterFail).toHaveLength(2);

      await app.close();
      await pool.end();
    });
  });

  it('denies revision mutation to Workplace Planner and Viewer', async () => {
    await withTestDatabase(databaseUrl as string, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url, 4);
      await seedUser(pool, { username: 'facilities', roleCodes: ['FACILITIES_ADMIN'] });
      await seedUser(pool, { username: 'planner', roleCodes: ['WORKPLACE_PLANNER'] });
      await seedUser(pool, { username: 'viewer', roleCodes: ['VIEWER'] });
      const app = await buildApp({ config: configFor(url), pool });
      const faHeaders = { cookie: `dskt_session=${await signIn(app, 'facilities')}` };

      const category = await app.inject({
        method: 'POST',
        url: '/element-categories',
        headers: faHeaders,
        payload: { code: 'DESK', name: 'Desk' },
      });
      const template = await app.inject({
        method: 'POST',
        url: `/element-categories/${category.json().id}/templates`,
        headers: faHeaders,
        payload: { code: 'A', name: 'Desk A' },
      });
      const templateId = template.json().id as string;

      for (const username of ['planner', 'viewer'] as const) {
        const headers = { cookie: `dskt_session=${await signIn(app, username)}` };
        const list = await app.inject({
          method: 'GET',
          url: `/element-templates/${templateId}/revisions`,
          headers,
        });
        expect(list.statusCode).toBe(200);

        const create = await app.inject({
          method: 'POST',
          url: `/element-templates/${templateId}/revisions`,
          headers,
          payload: {
            spatialClass: 'PHYSICAL',
            assignable: true,
            borderColor: '#000000',
            fillColor: '#ffffff',
            vertices: rectangle,
          },
        });
        expect(create.statusCode).toBe(403);
      }

      await app.close();
      await pool.end();
    });
  });
});
