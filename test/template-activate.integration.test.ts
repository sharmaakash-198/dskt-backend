/**
 * Activate Template Revision integration tests for Ticket 10.
 *
 * Seam: HTTP API + PostgreSQL for current-revision ownership, transactional
 * switching, revision numbering, immutability of revision rows, concurrent
 * selection, and authorization.
 */
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { asc, eq } from 'drizzle-orm';
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
const SECRET = 'template-activate-test-secret-32chars!!';
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
  const name = `dskt_act_${randomUUID().replaceAll('-', '')}`;
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

const taller = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 20 },
  { x: 0, y: 20 },
];

async function createTemplateWithRevision(
  app: Awaited<ReturnType<typeof buildApp>>,
  headers: { cookie: string },
  opts?: { code?: string; vertices?: typeof rectangle },
): Promise<{ templateId: string; revisionId: string; categoryId: string }> {
  const category = await app.inject({
    method: 'POST',
    url: '/element-categories',
    headers,
    payload: { code: opts?.code ?? 'DESK', name: 'Desk' },
  });
  expect(category.statusCode).toBe(201);
  const categoryId = category.json().id as string;

  const template = await app.inject({
    method: 'POST',
    url: `/element-categories/${categoryId}/templates`,
    headers,
    payload: { code: 'A', name: 'Desk A' },
  });
  expect(template.statusCode).toBe(201);
  const templateId = template.json().id as string;

  const revision = await app.inject({
    method: 'POST',
    url: `/element-templates/${templateId}/revisions`,
    headers,
    payload: {
      spatialClass: 'PHYSICAL',
      assignable: true,
      borderColor: '#112233',
      fillColor: '#aabbcc',
      vertices: opts?.vertices ?? rectangle,
    },
  });
  expect(revision.statusCode).toBe(201);
  return { templateId, revisionId: revision.json().id as string, categoryId };
}

describe('activate template revision', () => {
  beforeEach(() => {
    expect(databaseUrl).toBeTruthy();
  });

  it('activates only a revision owned by the template and makes it placeable', async () => {
    await withTestDatabase(databaseUrl as string, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url, 3);
      await seedUser(pool, { username: 'facilities', roleCodes: ['FACILITIES_ADMIN'] });
      const app = await buildApp({ config: configFor(url), pool });
      const headers = { cookie: `dskt_session=${await signIn(app, 'facilities')}` };

      const { templateId, revisionId, categoryId } = await createTemplateWithRevision(
        app,
        headers,
      );

      const activated = await app.inject({
        method: 'POST',
        url: `/element-templates/${templateId}/revisions/${revisionId}/activate`,
        headers,
      });
      expect(activated.statusCode).toBe(200);
      expect(activated.json()).toMatchObject({
        id: templateId,
        currentRevisionId: revisionId,
        placeable: true,
      });

      const listed = await app.inject({
        method: 'GET',
        url: `/element-templates/${templateId}/revisions`,
        headers,
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().revisions).toEqual([
        expect.objectContaining({ id: revisionId, isCurrent: true, revisionNumber: 1 }),
      ]);

      const templates = await app.inject({
        method: 'GET',
        url: `/element-categories/${categoryId}/templates`,
        headers,
      });
      expect(templates.json().templates[0]).toMatchObject({
        currentRevisionId: revisionId,
        placeable: true,
      });

      await app.close();
      await pool.end();
    });
  });

  it('rejects foreign or missing revisions without changing the prior current revision', async () => {
    await withTestDatabase(databaseUrl as string, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url, 3);
      await seedUser(pool, { username: 'facilities', roleCodes: ['FACILITIES_ADMIN'] });
      const app = await buildApp({ config: configFor(url), pool });
      const headers = { cookie: `dskt_session=${await signIn(app, 'facilities')}` };

      const first = await createTemplateWithRevision(app, headers, { code: 'ONE' });
      const second = await createTemplateWithRevision(app, headers, { code: 'TWO' });

      const activateFirst = await app.inject({
        method: 'POST',
        url: `/element-templates/${first.templateId}/revisions/${first.revisionId}/activate`,
        headers,
      });
      expect(activateFirst.statusCode).toBe(200);

      const foreign = await app.inject({
        method: 'POST',
        url: `/element-templates/${first.templateId}/revisions/${second.revisionId}/activate`,
        headers,
      });
      expect(foreign.statusCode).toBe(404);
      expect(foreign.json()).toEqual({ error: 'revision_not_found' });

      const missing = await app.inject({
        method: 'POST',
        url: `/element-templates/${first.templateId}/revisions/${randomUUID()}/activate`,
        headers,
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toEqual({ error: 'revision_not_found' });

      const db = drizzle(pool);
      const templateRow = await db
        .select()
        .from(elementTemplates)
        .where(eq(elementTemplates.id, first.templateId));
      expect(templateRow[0]?.currentRevisionId).toBe(first.revisionId);

      await app.close();
      await pool.end();
    });
  });

  it('switches current revision without mutating revision metadata or vertices', async () => {
    await withTestDatabase(databaseUrl as string, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url, 3);
      await seedUser(pool, { username: 'facilities', roleCodes: ['FACILITIES_ADMIN'] });
      const app = await buildApp({ config: configFor(url), pool });
      const headers = { cookie: `dskt_session=${await signIn(app, 'facilities')}` };

      const { templateId, revisionId: firstId } = await createTemplateWithRevision(app, headers);

      const activateFirst = await app.inject({
        method: 'POST',
        url: `/element-templates/${templateId}/revisions/${firstId}/activate`,
        headers,
      });
      expect(activateFirst.statusCode).toBe(200);

      const second = await app.inject({
        method: 'POST',
        url: `/element-templates/${templateId}/revisions`,
        headers,
        payload: {
          spatialClass: 'ZONE',
          assignable: false,
          borderColor: '#000000',
          fillColor: '#ffffff',
          vertices: taller,
        },
      });
      expect(second.statusCode).toBe(201);
      expect(second.json()).toMatchObject({
        revisionNumber: 2,
        isCurrent: false,
      });
      const secondId = second.json().id as string;

      const db = drizzle(pool);
      const firstMetaBefore = await db
        .select()
        .from(elementTemplateRevisions)
        .where(eq(elementTemplateRevisions.id, firstId));
      const firstVertsBefore = await db
        .select()
        .from(elementTemplateRevisionVertices)
        .where(eq(elementTemplateRevisionVertices.elementTemplateRevisionId, firstId))
        .orderBy(asc(elementTemplateRevisionVertices.sequence));

      const activateSecond = await app.inject({
        method: 'POST',
        url: `/element-templates/${templateId}/revisions/${secondId}/activate`,
        headers,
      });
      expect(activateSecond.statusCode).toBe(200);
      expect(activateSecond.json()).toMatchObject({
        currentRevisionId: secondId,
        placeable: true,
      });

      const listed = await app.inject({
        method: 'GET',
        url: `/element-templates/${templateId}/revisions`,
        headers,
      });
      expect(listed.json().revisions.map((r: { id: string; isCurrent: boolean }) => ({
        id: r.id,
        isCurrent: r.isCurrent,
      }))).toEqual([
        { id: secondId, isCurrent: true },
        { id: firstId, isCurrent: false },
      ]);

      const firstMetaAfter = await db
        .select()
        .from(elementTemplateRevisions)
        .where(eq(elementTemplateRevisions.id, firstId));
      const firstVertsAfter = await db
        .select()
        .from(elementTemplateRevisionVertices)
        .where(eq(elementTemplateRevisionVertices.elementTemplateRevisionId, firstId))
        .orderBy(asc(elementTemplateRevisionVertices.sequence));

      expect(firstMetaAfter).toEqual(firstMetaBefore);
      expect(firstVertsAfter).toEqual(firstVertsBefore);

      // Existing placements would pin element_template_revision_id; pointer change
      // must leave historical revision rows intact for that pin to remain valid.
      expect(firstMetaAfter[0]?.revisionNumber).toBe(1);
      expect(firstVertsAfter.map((v) => ({ x: v.x, y: v.y }))).toEqual([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 8 },
        { x: 0, y: 8 },
      ]);

      await app.close();
      await pool.end();
    });
  });

  it('serializes concurrent activations so exactly one current revision remains', async () => {
    await withTestDatabase(databaseUrl as string, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url, 6);
      await seedUser(pool, { username: 'facilities', roleCodes: ['FACILITIES_ADMIN'] });
      const app = await buildApp({ config: configFor(url), pool });
      const headers = { cookie: `dskt_session=${await signIn(app, 'facilities')}` };

      const { templateId, revisionId: firstId } = await createTemplateWithRevision(app, headers);
      const second = await app.inject({
        method: 'POST',
        url: `/element-templates/${templateId}/revisions`,
        headers,
        payload: {
          spatialClass: 'PHYSICAL',
          assignable: false,
          borderColor: '#111111',
          fillColor: '#222222',
          vertices: taller,
        },
      });
      const secondId = second.json().id as string;

      const [a, b] = await Promise.all([
        app.inject({
          method: 'POST',
          url: `/element-templates/${templateId}/revisions/${firstId}/activate`,
          headers,
        }),
        app.inject({
          method: 'POST',
          url: `/element-templates/${templateId}/revisions/${secondId}/activate`,
          headers,
        }),
      ]);
      expect(a.statusCode).toBe(200);
      expect(b.statusCode).toBe(200);

      const currentIds = new Set([a.json().currentRevisionId, b.json().currentRevisionId]);
      expect(currentIds.size).toBeGreaterThanOrEqual(1);

      const db = drizzle(pool);
      const templateRow = await db
        .select()
        .from(elementTemplates)
        .where(eq(elementTemplates.id, templateId));
      expect([firstId, secondId]).toContain(templateRow[0]?.currentRevisionId);

      const listed = await app.inject({
        method: 'GET',
        url: `/element-templates/${templateId}/revisions`,
        headers,
      });
      const currentFlags = listed
        .json()
        .revisions.filter((r: { isCurrent: boolean }) => r.isCurrent);
      expect(currentFlags).toHaveLength(1);
      expect(currentFlags[0].id).toBe(templateRow[0]?.currentRevisionId);

      await app.close();
      await pool.end();
    });
  });

  it('denies activation to System Admin, Workplace Planner, and Viewer', async () => {
    await withTestDatabase(databaseUrl as string, async (url) => {
      await applyMigrations(url);
      const pool = createPool(url, 5);
      await seedUser(pool, { username: 'facilities', roleCodes: ['FACILITIES_ADMIN'] });
      await seedUser(pool, { username: 'sysadmin', roleCodes: ['SYSTEM_ADMIN'] });
      await seedUser(pool, { username: 'planner', roleCodes: ['WORKPLACE_PLANNER'] });
      await seedUser(pool, { username: 'viewer', roleCodes: ['VIEWER'] });
      const app = await buildApp({ config: configFor(url), pool });
      const faHeaders = { cookie: `dskt_session=${await signIn(app, 'facilities')}` };

      const { templateId, revisionId } = await createTemplateWithRevision(app, faHeaders);

      for (const username of ['sysadmin', 'planner', 'viewer'] as const) {
        const headers = { cookie: `dskt_session=${await signIn(app, username)}` };
        const activate = await app.inject({
          method: 'POST',
          url: `/element-templates/${templateId}/revisions/${revisionId}/activate`,
          headers,
        });
        expect(activate.statusCode).toBe(403);
      }

      const db = drizzle(pool);
      const templateRow = await db
        .select()
        .from(elementTemplates)
        .where(eq(elementTemplates.id, templateId));
      expect(templateRow[0]?.currentRevisionId).toBeNull();

      await app.close();
      await pool.end();
    });
  });
});
