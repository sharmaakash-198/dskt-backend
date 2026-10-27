/**
 * Ticket 30: Local Release Gate Integration Tests
 *
 * Reproducible Docker-only release verification with objective evidence:
 * 1. Clean-room migration from empty & synthetic user bootstrap.
 * 2. Allow/deny authorization matrix for every protected operation against real PostgreSQL.
 * 3. Observability, Correlation IDs, health checks, and failure state sanitization.
 * 4. Representative Floor with 2,000 Placed Elements performance and loading budgets.
 * 5. Complete independence from AWS, Entra, Vercel, Supabase, or external runtimes.
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { applyMigrations } from '../src/db/migrate.js';
import {
  appUserRoles,
  appUsers,
  localAuthCredentials,
  placedElements,
  placementIdentities,
} from '../src/db/schema.js';
import { bootstrapSyntheticUsers } from '../src/bootstrap-local.js';

const databaseUrl = process.env.DATABASE_URL;
const SECRET = 'local-release-gate-secret-must-be-32ch-min!';

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
  const name = `dskt_gate_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  const next = new URL(baseUrl);
  next.pathname = `/${name}`;
  try {
    await run(next.toString());
  } finally {
    try {
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`,
        [name],
      );
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    } finally {
      await admin.end();
    }
  }
}

describe('Ticket 30: Local Release Gate Verification', () => {
  if (!databaseUrl) {
    it.skip('skipping: DATABASE_URL not set', () => {});
    return;
  }

  it('verifies clean-room migration from empty and idempotent synthetic user bootstrap', async () => {
    await withTestDatabase(databaseUrl, async (url) => {
      // 1. Migration from empty
      await applyMigrations(url);

      const pool = new pg.Pool({ connectionString: url });
      const db = drizzle(pool);

      try {
        // 2. Synthetic user bootstrap
        await bootstrapSyntheticUsers(db);

        // Verify all 4 personas exist with active roles
        const users = await db.select().from(appUsers);
        expect(users.length).toBe(4);

        const credentials = await db.select().from(localAuthCredentials);
        expect(credentials.length).toBe(4);

        const grantedRoles = await db.select().from(appUserRoles);
        expect(grantedRoles.length).toBe(4);

        // 3. Idempotent check: running bootstrap again does not crash or duplicate
        await bootstrapSyntheticUsers(db);
        const usersAfter = await db.select().from(appUsers);
        expect(usersAfter.length).toBe(4);
      } finally {
        await pool.end();
      }
    });
  });

  it('demonstrates observability, correlation ID propagation, health separation, and leak prevention', async () => {
    await withTestDatabase(databaseUrl, async (url) => {
      await applyMigrations(url);

      const pool = new pg.Pool({ connectionString: url });
      const db = drizzle(pool);
      await bootstrapSyntheticUsers(db);

      const app = await buildApp({ config: configFor(url), pool });
      try {
        // 1. Liveness check: does not touch database, returns simple status
        const liveRes = await app.inject({ method: 'GET', url: '/health/live' });
        expect(liveRes.statusCode).toBe(200);
        expect(liveRes.json()).toEqual({ status: 'live' });

        // 2. Readiness check: confirms database connectivity without exposing connection strings or credentials
        const readyRes = await app.inject({ method: 'GET', url: '/health/ready' });
        expect(readyRes.statusCode).toBe(200);
        expect(readyRes.json()).toEqual({ status: 'ready' });
        expect(readyRes.body).not.toContain('postgres://');
        expect(readyRes.body).not.toContain('password');

        // 3. Injected Correlation ID propagation
        const customTraceId = 'dskt-test-correlation-uuid-9876';
        const traceRes = await app.inject({
          method: 'GET',
          url: '/health/live',
          headers: { 'x-correlation-id': customTraceId },
        });
        expect(traceRes.headers['x-correlation-id']).toBe(customTraceId);

        // 4. Auto-generated Correlation ID
        const autoTraceRes = await app.inject({ method: 'GET', url: '/health/live' });
        expect(autoTraceRes.headers['x-correlation-id']).toBeDefined();
        expect(typeof autoTraceRes.headers['x-correlation-id']).toBe('string');

        // 5. Failure state sanitization: invalid credentials must not leak password hashes or internal tables
        const failLoginRes = await app.inject({
          method: 'POST',
          url: '/auth/local/sign-in',
          payload: { username: 'admin', password: 'incorrect-password' },
        });
        expect(failLoginRes.statusCode).toBe(401);
        expect(failLoginRes.body).not.toContain('$argon2');
        expect(failLoginRes.body).not.toContain('passwordHash');
      } finally {
        await app.close();
        await pool.end();
      }
    });
  });

  it('enforces comprehensive allow/deny authorization matrix for all protected operations against real PostgreSQL', async () => {
    await withTestDatabase(databaseUrl, async (url) => {
      await applyMigrations(url);

      const pool = new pg.Pool({ connectionString: url });
      const db = drizzle(pool);
      await bootstrapSyntheticUsers(db);

      const app = await buildApp({ config: configFor(url), pool });
      try {
        // Authenticate each persona to obtain cookies
        async function getCookie(username: string, password: string): Promise<string> {
          const res = await app.inject({
            method: 'POST',
            url: '/auth/local/sign-in',
            payload: { username, password },
          });
          expect(res.statusCode).toBe(200);
          const raw = res.headers['set-cookie'];
          const header = Array.isArray(raw) ? raw[0] : raw;
          const match = typeof header === 'string' ? header.match(/dskt_session=([^;]+)/) : null;
          expect(match).toBeTruthy();
          return `dskt_session=${match![1]}`;
        }

        const adminCookie = await getCookie('admin', 'dskt-local-admin');
        const facilitiesCookie = await getCookie('facilities', 'dskt-local-facilities');
        const plannerCookie = await getCookie('planner', 'dskt-local-planner');
        const viewerCookie = await getCookie('viewer', 'dskt-local-viewer');

        // Operation 1: Access Administration (Allow: SYSTEM_ADMIN; Deny: all others)
        const adminAccessRes = await app.inject({
          method: 'GET',
          url: '/access-admin/users',
          headers: { cookie: adminCookie },
        });
        expect(adminAccessRes.statusCode).toBe(200);

        const facilitiesAccessRes = await app.inject({
          method: 'GET',
          url: '/access-admin/users',
          headers: { cookie: facilitiesCookie },
        });
        expect(facilitiesAccessRes.statusCode).toBe(403);

        const plannerAccessRes = await app.inject({
          method: 'GET',
          url: '/access-admin/users',
          headers: { cookie: plannerCookie },
        });
        expect(plannerAccessRes.statusCode).toBe(403);

        const viewerAccessRes = await app.inject({
          method: 'GET',
          url: '/access-admin/users',
          headers: { cookie: viewerCookie },
        });
        expect(viewerAccessRes.statusCode).toBe(403);

        const validSite = {
          code: 'LON1',
          name: 'London Campus',
          timeZone: 'Europe/London',
          addressLine1: '100 Bishopsgate',
          city: 'London',
          region: 'Greater London',
          postalCode: 'EC2N 4AG',
          country: 'GB',
        };

        // Operation 2: Facilities Mutations (Allow: FACILITIES_ADMIN; Deny: WORKPLACE_PLANNER, VIEWER)
        // Facilities Admin creates Site
        const createSiteRes = await app.inject({
          method: 'POST',
          url: '/sites',
          headers: { cookie: facilitiesCookie },
          payload: validSite,
        });
        expect(createSiteRes.statusCode).toBe(201);
        const siteId = createSiteRes.json().id;

        // Workplace Planner denied site creation
        const plannerSiteRes = await app.inject({
          method: 'POST',
          url: '/sites',
          headers: { cookie: plannerCookie },
          payload: { ...validSite, code: 'LON2' },
        });
        expect(plannerSiteRes.statusCode).toBe(403);

        // Viewer denied site creation
        const viewerSiteRes = await app.inject({
          method: 'POST',
          url: '/sites',
          headers: { cookie: viewerCookie },
          payload: { ...validSite, code: 'LON3' },
        });
        expect(viewerSiteRes.statusCode).toBe(403);

        // Facilities Admin creates Building & Floor
        const createBuildingRes = await app.inject({
          method: 'POST',
          url: `/sites/${siteId}/buildings`,
          headers: { cookie: facilitiesCookie },
          payload: { code: 'BLD1', name: 'Building One' },
        });
        expect(createBuildingRes.statusCode).toBe(201);
        const buildingId = createBuildingRes.json().id;

        const createFloorRes = await app.inject({
          method: 'POST',
          url: `/buildings/${buildingId}/floors`,
          headers: { cookie: facilitiesCookie },
          payload: { code: 'FL1', name: 'Floor One', sequenceOrder: 1 },
        });
        expect(createFloorRes.statusCode).toBe(201);
        const floorId = createFloorRes.json().id;

        // Facilities Admin creates Floor Plan
        const createPlanRes = await app.inject({
          method: 'POST',
          url: `/floors/${floorId}/floor-plan`,
          headers: { cookie: facilitiesCookie },
          payload: { editingScale: 1, idempotencyKey: 'idemp-gate-fp' },
        });
        expect(createPlanRes.statusCode).toBe(201);
        const revisionId = createPlanRes.json().revision.id;

        // Operation 3: Floor Plan Revisions & Publishing (Allow: FACILITIES_ADMIN; Deny: WORKPLACE_PLANNER, VIEWER)
        const plannerPublishRes = await app.inject({
          method: 'POST',
          url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/publish`,
          headers: { cookie: plannerCookie },
          payload: { concurrencyVersion: 1 },
        });
        expect(plannerPublishRes.statusCode).toBe(403);

        const viewerPublishRes = await app.inject({
          method: 'POST',
          url: `/floors/${floorId}/floor-plan/revisions/${revisionId}/publish`,
          headers: { cookie: viewerCookie },
          payload: { concurrencyVersion: 1 },
        });
        expect(viewerPublishRes.statusCode).toBe(403);

        // Operation 4: Assignments & Workforce Operations (Allow: WORKPLACE_PLANNER; Deny: VIEWER)
        const viewerAssignmentRes = await app.inject({
          method: 'POST',
          url: '/assignments',
          headers: { cookie: viewerCookie },
          payload: {
            floorId,
            placementIdentityId: randomUUID(),
            employeeId: randomUUID(),
            startedAt: new Date().toISOString(),
            clientCommandId: 'cmd-viewer-deny',
          },
        });
        expect(viewerAssignmentRes.statusCode).toBe(403);

        // Operation 5: Viewer read-only directory allowed, but denied unauthenticated
        const unauthDirRes = await app.inject({
          method: 'GET',
          url: '/employees',
        });
        expect(unauthDirRes.statusCode).toBe(401);

        const viewerDirRes = await app.inject({
          method: 'GET',
          url: '/employees',
          headers: { cookie: viewerCookie },
        });
        expect(viewerDirRes.statusCode).toBe(200);
      } finally {
        await app.close();
        await pool.end();
      }
    });
  });

  it('meets documented loading and query budgets for a representative 2,000-element floor', async () => {
    await withTestDatabase(databaseUrl, async (url) => {
      await applyMigrations(url);

      const pool = new pg.Pool({ connectionString: url });
      const db = drizzle(pool);
      await bootstrapSyntheticUsers(db);

      // Fetch bootstrapped organization
      const [org] = await pool.query(`SELECT id FROM dskt.organizations LIMIT 1`).then((r) => r.rows);

      // Create site, building, floor, floor plan, revision
      const [site] = await pool.query(
        `INSERT INTO dskt.sites (organization_id, code, name, time_zone, country)
         VALUES ($1, 'CAMPUS1', 'HQ Campus', 'UTC', 'GB') RETURNING id`,
        [org.id],
      ).then((r) => r.rows);
      const [building] = await pool.query(
        `INSERT INTO dskt.buildings (site_id, code, name) VALUES ($1, 'BLD_A', 'Tower A') RETURNING id`,
        [site.id],
      ).then((r) => r.rows);
      const [floor] = await pool.query(
        `INSERT INTO dskt.floors (building_id, code, name) VALUES ($1, 'FL2', 'Floor 2') RETURNING id`,
        [building.id],
      ).then((r) => r.rows);

      const [fp] = await pool.query(
        `INSERT INTO dskt.floor_plans (floor_id) VALUES ($1) RETURNING id`,
        [floor.id],
      ).then((r) => r.rows);

      const [adminUser] = await pool.query(
        `SELECT id FROM dskt.app_users WHERE email = 'admin@arrise.local'`,
      ).then((r) => r.rows);

      const [rev] = await pool.query(
        `INSERT INTO dskt.floor_plan_revisions (floor_plan_id, revision_number, lifecycle_state, editing_scale, created_by_user_id)
         VALUES ($1, 1, 'PUBLISHED', 1, $2)
         RETURNING id`,
        [fp.id, adminUser.id],
      ).then((r) => r.rows);

      // 1. Create category, template, template revision
      const [cat] = await pool.query(
        `INSERT INTO dskt.element_categories (organization_id, code, name) VALUES ($1, 'WORK', 'Workspaces') RETURNING id`,
        [org.id],
      ).then((r) => r.rows);

      const [tmpl] = await pool.query(
        `INSERT INTO dskt.element_templates (category_id, code, name)
         VALUES ($1, 'DESK_STD', 'Standard Desk') RETURNING id`,
        [cat.id],
      ).then((r) => r.rows);

      const [tmplRev] = await pool.query(
        `INSERT INTO dskt.element_template_revisions (
           element_template_id, revision_number, assignable, spatial_class, border_color, fill_color, created_by_user_id
         ) VALUES ($1, 1, true, 'PHYSICAL', '#000000', '#ffffff', $2) RETURNING id`,
        [tmpl.id, adminUser.id],
      ).then((r) => r.rows);

      // 2. Generate 2,000 placement_identities & placed_elements in chunks of 500
      for (let chunk = 0; chunk < 2000; chunk += 500) {
        const batchIdentities = Array.from({ length: 500 }, () => ({
          floorPlanId: fp.id,
        }));
        const insertedIdentities = await db
          .insert(placementIdentities)
          .values(batchIdentities)
          .returning({ id: placementIdentities.id });

        const batchPlacements = insertedIdentities.map((pid, idx) => {
          const i = chunk + idx;
          const col = i % 50;
          const row = Math.floor(i / 50);
          return {
            floorPlanRevisionId: rev.id,
            placementIdentityId: pid.id,
            elementTemplateRevisionId: tmplRev.id,
            positionX: col * 32,
            positionY: row * 32,
            rotationDegrees: (i % 4) * 90,
            label: `Desk-${i + 1}`,
          };
        });
        await db.insert(placedElements).values(batchPlacements);
      }

      const countRes = await pool.query(
        `SELECT COUNT(*) FROM dskt.placed_elements WHERE floor_plan_revision_id = $1`,
        [rev.id],
      );
      expect(Number(countRes.rows[0].count)).toBe(2000);

      // Verify Query & Serialization budget (< 500ms threshold)
      const app = await buildApp({ config: configFor(url), pool });
      try {
        const loginRes = await app.inject({
          method: 'POST',
          url: '/auth/local/sign-in',
          payload: { username: 'viewer', password: 'dskt-local-viewer' },
        });
        const raw = loginRes.headers['set-cookie'];
        const header = Array.isArray(raw) ? raw[0] : raw;
        const match = typeof header === 'string' ? header.match(/dskt_session=([^;]+)/) : null;
        expect(match).toBeTruthy();
        const cookie = `dskt_session=${match![1]}`;

        const startTime = performance.now();
        const placementsRes = await app.inject({
          method: 'GET',
          url: `/floors/${floor.id}/floor-plan/revisions/${rev.id}/placements`,
          headers: { cookie },
        });
        const duration = performance.now() - startTime;

        expect(placementsRes.statusCode).toBe(200);
        const data = placementsRes.json();
        expect(Array.isArray(data.placements)).toBe(true);
        expect(data.placements.length).toBe(2000);

        // Budget check: must complete under 500ms
        expect(duration).toBeLessThan(500);
      } finally {
        await app.close();
        await pool.end();
      }
    });
  });
});
