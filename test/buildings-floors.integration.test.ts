/**
 * Buildings and Floors integration tests for Ticket 06.
 *
 * Seam: HTTP API + PostgreSQL for hierarchy CRUD, uniqueness, archival
 * guards, role matrix, and audit events.
 */
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { and, eq } from 'drizzle-orm';
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
  floors,
  localAuthCredentials,
  organizations,
  roles,
} from '../src/db/schema.js';

const databaseUrl = process.env.DATABASE_URL;
const SECRET = 'buildings-floors-test-secret-32chars!!';
const PASSWORD = 'correct-horse-battery-staple';
const CORRELATION = 'corr-ticket-06-buildings-floors';

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
  const name = `dskt_bld_${randomUUID().replaceAll('-', '')}`;
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

async function createActiveSite(
  app: Awaited<ReturnType<typeof buildApp>>,
  headers: Record<string, string>,
  code = 'BLR',
): Promise<string> {
  const created = await app.inject({
    method: 'POST',
    url: '/sites',
    headers,
    payload: {
      code,
      name: 'Bengaluru',
      timeZone: 'Asia/Kolkata',
    },
  });
  expect(created.statusCode).toBe(201);
  return created.json().id as string;
}

describe('manage buildings and floors', () => {
  beforeEach(() => {
    expect(databaseUrl, 'DATABASE_URL is required for buildings/floors integration tests').toBeTruthy();
  });

  it('facilities admin creates, lists, updates, and archives buildings and floors with audit', async () => {
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
      const siteId = await createActiveSite(app, headers);

      const emptyBuildings = await app.inject({
        method: 'GET',
        url: `/sites/${siteId}/buildings`,
        headers,
      });
      expect(emptyBuildings.statusCode).toBe(200);
      expect(emptyBuildings.json()).toEqual({ buildings: [] });

      const buildingCreated = await app.inject({
        method: 'POST',
        url: `/sites/${siteId}/buildings`,
        headers,
        payload: { code: 'a', name: 'Building A' },
      });
      expect(buildingCreated.statusCode).toBe(201);
      expect(buildingCreated.json().code).toBe('A');
      expect(buildingCreated.json().name).toBe('Building A');
      expect(buildingCreated.json().siteId).toBe(siteId);
      const buildingId = buildingCreated.json().id as string;

      const secondBuilding = await app.inject({
        method: 'POST',
        url: `/sites/${siteId}/buildings`,
        headers,
        payload: { code: 'B', name: 'Building B' },
      });
      expect(secondBuilding.statusCode).toBe(201);

      const listedBuildings = await app.inject({
        method: 'GET',
        url: `/sites/${siteId}/buildings`,
        headers,
      });
      expect(listedBuildings.statusCode).toBe(200);
      expect(listedBuildings.json().buildings.map((b: { code: string }) => b.code)).toEqual([
        'A',
        'B',
      ]);

      const buildingUpdated = await app.inject({
        method: 'PATCH',
        url: `/buildings/${buildingId}`,
        headers,
        payload: { name: 'Building A North' },
      });
      expect(buildingUpdated.statusCode).toBe(200);
      expect(buildingUpdated.json().name).toBe('Building A North');
      expect(buildingUpdated.json().code).toBe('A');

      const emptyFloors = await app.inject({
        method: 'GET',
        url: `/buildings/${buildingId}/floors`,
        headers,
      });
      expect(emptyFloors.statusCode).toBe(200);
      expect(emptyFloors.json()).toEqual({ floors: [] });

      const floorCreated = await app.inject({
        method: 'POST',
        url: `/buildings/${buildingId}/floors`,
        headers,
        payload: { code: 'l1', name: 'Level 1' },
      });
      expect(floorCreated.statusCode).toBe(201);
      expect(floorCreated.json().code).toBe('L1');
      expect(floorCreated.json().name).toBe('Level 1');
      expect(floorCreated.json().buildingId).toBe(buildingId);
      const floorId = floorCreated.json().id as string;

      const secondFloor = await app.inject({
        method: 'POST',
        url: `/buildings/${buildingId}/floors`,
        headers,
        payload: { code: 'L2', name: 'Level 2' },
      });
      expect(secondFloor.statusCode).toBe(201);

      const listedFloors = await app.inject({
        method: 'GET',
        url: `/buildings/${buildingId}/floors`,
        headers,
      });
      expect(listedFloors.statusCode).toBe(200);
      expect(listedFloors.json().floors.map((f: { code: string }) => f.code)).toEqual(['L1', 'L2']);

      const floorUpdated = await app.inject({
        method: 'PATCH',
        url: `/floors/${floorId}`,
        headers,
        payload: { name: 'Ground / Level 1' },
      });
      expect(floorUpdated.statusCode).toBe(200);
      expect(floorUpdated.json().name).toBe('Ground / Level 1');
      expect(floorUpdated.json().code).toBe('L1');

      const floorArchived = await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/archive`,
        headers,
      });
      expect(floorArchived.statusCode).toBe(200);
      expect(floorArchived.json().id).toBe(floorId);

      const floorsAfter = await app.inject({
        method: 'GET',
        url: `/buildings/${buildingId}/floors`,
        headers,
      });
      expect(floorsAfter.json().floors.map((f: { code: string }) => f.code)).toEqual(['L2']);

      const remainingFloorId = floorsAfter.json().floors[0].id as string;
      const remainingArchived = await app.inject({
        method: 'POST',
        url: `/floors/${remainingFloorId}/archive`,
        headers,
      });
      expect(remainingArchived.statusCode).toBe(200);

      const buildingArchived = await app.inject({
        method: 'POST',
        url: `/buildings/${buildingId}/archive`,
        headers,
      });
      expect(buildingArchived.statusCode).toBe(200);

      const buildingsAfter = await app.inject({
        method: 'GET',
        url: `/sites/${siteId}/buildings`,
        headers,
      });
      expect(buildingsAfter.json().buildings.map((b: { code: string }) => b.code)).toEqual(['B']);

      const db = drizzle(pool);
      const retainedBuilding = await db
        .select({ id: buildings.id, code: buildings.code, archivedAt: buildings.archivedAt })
        .from(buildings)
        .where(eq(buildings.id, buildingId));
      expect(retainedBuilding[0]?.code).toBe('A');
      expect(retainedBuilding[0]?.archivedAt).toBeTruthy();

      const retainedFloor = await db
        .select({ id: floors.id, code: floors.code, archivedAt: floors.archivedAt })
        .from(floors)
        .where(eq(floors.id, floorId));
      expect(retainedFloor[0]?.code).toBe('L1');
      expect(retainedFloor[0]?.archivedAt).toBeTruthy();

      const buildingAudits = await db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.action, 'building.archived'),
            eq(auditEvents.correlationId, CORRELATION),
          ),
        );
      expect(buildingAudits).toHaveLength(1);
      expect(buildingAudits[0]?.targetType).toBe('building');
      expect(buildingAudits[0]?.targetId).toBe(buildingId);

      const floorAudits = await db
        .select()
        .from(auditEvents)
        .where(
          and(eq(auditEvents.action, 'floor.archived'), eq(auditEvents.correlationId, CORRELATION)),
        );
      expect(floorAudits.length).toBeGreaterThanOrEqual(1);
      expect(floorAudits.some((row) => row.targetId === floorId)).toBe(true);

      await app.close();
      await pool.end();
    });
  });

  it('rejects uniqueness conflicts, archived parents, and archive with active children', async () => {
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
      const siteId = await createActiveSite(app, headers);

      const building = await app.inject({
        method: 'POST',
        url: `/sites/${siteId}/buildings`,
        headers,
        payload: { code: 'A', name: 'Building A' },
      });
      expect(building.statusCode).toBe(201);
      const buildingId = building.json().id as string;

      const duplicateBuilding = await app.inject({
        method: 'POST',
        url: `/sites/${siteId}/buildings`,
        headers,
        payload: { code: 'a', name: 'Other A' },
      });
      expect(duplicateBuilding.statusCode).toBe(409);
      expect(duplicateBuilding.json()).toEqual({ error: 'building_code_taken' });

      const badBuildingCode = await app.inject({
        method: 'POST',
        url: `/sites/${siteId}/buildings`,
        headers,
        payload: { code: 'bad code!', name: 'Nope' },
      });
      expect(badBuildingCode.statusCode).toBe(400);
      expect(badBuildingCode.json()).toEqual({ error: 'invalid_building_code' });

      const floor = await app.inject({
        method: 'POST',
        url: `/buildings/${buildingId}/floors`,
        headers,
        payload: { code: 'L1', name: 'Level 1' },
      });
      expect(floor.statusCode).toBe(201);
      const floorId = floor.json().id as string;

      const duplicateFloor = await app.inject({
        method: 'POST',
        url: `/buildings/${buildingId}/floors`,
        headers,
        payload: { code: 'l1', name: 'Other L1' },
      });
      expect(duplicateFloor.statusCode).toBe(409);
      expect(duplicateFloor.json()).toEqual({ error: 'floor_code_taken' });

      const blockedBuildingArchive = await app.inject({
        method: 'POST',
        url: `/buildings/${buildingId}/archive`,
        headers,
      });
      expect(blockedBuildingArchive.statusCode).toBe(409);
      expect(blockedBuildingArchive.json()).toEqual({ error: 'building_has_active_floors' });

      await app.inject({
        method: 'POST',
        url: `/floors/${floorId}/archive`,
        headers,
      });

      const archivedBuilding = await app.inject({
        method: 'POST',
        url: `/buildings/${buildingId}/archive`,
        headers,
      });
      expect(archivedBuilding.statusCode).toBe(200);

      const floorOnArchivedBuilding = await app.inject({
        method: 'POST',
        url: `/buildings/${buildingId}/floors`,
        headers,
        payload: { code: 'L3', name: 'Level 3' },
      });
      expect(floorOnArchivedBuilding.statusCode).toBe(409);
      expect(floorOnArchivedBuilding.json()).toEqual({ error: 'building_archived' });

      const siteArchiveBlocked = await app.inject({
        method: 'POST',
        url: `/sites/${siteId}/archive`,
        headers,
      });
      // Building A archived; no active buildings remain after we archive B if any —
      // only building A existed and is now archived, so site archive should succeed.
      expect(siteArchiveBlocked.statusCode).toBe(200);

      const otherSiteId = await createActiveSite(app, headers, 'HYD');
      await app.inject({
        method: 'POST',
        url: `/sites/${otherSiteId}/archive`,
        headers,
      });

      const buildingOnArchivedSite = await app.inject({
        method: 'POST',
        url: `/sites/${otherSiteId}/buildings`,
        headers,
        payload: { code: 'C', name: 'Building C' },
      });
      expect(buildingOnArchivedSite.statusCode).toBe(409);
      expect(buildingOnArchivedSite.json()).toEqual({ error: 'site_archived' });

      await app.close();
      await pool.end();
    });
  });

  it('enforces the buildings and floors role matrix', async () => {
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
      const siteId = await createActiveSite(app, faHeaders);

      const building = await app.inject({
        method: 'POST',
        url: `/sites/${siteId}/buildings`,
        headers: faHeaders,
        payload: { code: 'A', name: 'Building A' },
      });
      expect(building.statusCode).toBe(201);
      const buildingId = building.json().id as string;

      const floor = await app.inject({
        method: 'POST',
        url: `/buildings/${buildingId}/floors`,
        headers: faHeaders,
        payload: { code: 'L1', name: 'Level 1' },
      });
      expect(floor.statusCode).toBe(201);
      const floorId = floor.json().id as string;

      for (const username of ['planner', 'viewer'] as const) {
        const cookie = await signInCookie(app, username);
        const headers = { cookie: `dskt_session=${cookie}` };

        const listBuildings = await app.inject({
          method: 'GET',
          url: `/sites/${siteId}/buildings`,
          headers,
        });
        expect(listBuildings.statusCode).toBe(200);
        expect(listBuildings.json().buildings).toHaveLength(1);

        const listFloors = await app.inject({
          method: 'GET',
          url: `/buildings/${buildingId}/floors`,
          headers,
        });
        expect(listFloors.statusCode).toBe(200);
        expect(listFloors.json().floors).toHaveLength(1);

        const createBuilding = await app.inject({
          method: 'POST',
          url: `/sites/${siteId}/buildings`,
          headers,
          payload: { code: 'Z', name: 'Denied' },
        });
        expect(createBuilding.statusCode).toBe(403);

        const patchBuilding = await app.inject({
          method: 'PATCH',
          url: `/buildings/${buildingId}`,
          headers,
          payload: { name: 'Denied' },
        });
        expect(patchBuilding.statusCode).toBe(403);

        const archiveBuilding = await app.inject({
          method: 'POST',
          url: `/buildings/${buildingId}/archive`,
          headers,
        });
        expect(archiveBuilding.statusCode).toBe(403);

        const createFloor = await app.inject({
          method: 'POST',
          url: `/buildings/${buildingId}/floors`,
          headers,
          payload: { code: 'Z1', name: 'Denied' },
        });
        expect(createFloor.statusCode).toBe(403);

        const patchFloor = await app.inject({
          method: 'PATCH',
          url: `/floors/${floorId}`,
          headers,
          payload: { name: 'Denied' },
        });
        expect(patchFloor.statusCode).toBe(403);

        const archiveFloor = await app.inject({
          method: 'POST',
          url: `/floors/${floorId}/archive`,
          headers,
        });
        expect(archiveFloor.statusCode).toBe(403);
      }

      const sysCookie = await signInCookie(app, 'sysadmin');
      const sysHeaders = { cookie: `dskt_session=${sysCookie}` };
      const sysBuildings = await app.inject({
        method: 'GET',
        url: `/sites/${siteId}/buildings`,
        headers: sysHeaders,
      });
      expect(sysBuildings.statusCode).toBe(403);

      const unauth = await app.inject({
        method: 'GET',
        url: `/sites/${siteId}/buildings`,
      });
      expect(unauth.statusCode).toBe(401);

      await app.close();
      await pool.end();
    });
  });
});
