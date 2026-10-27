import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { RoleCode } from '../src/auth/principal.js';
import type { AppConfig } from '../src/config.js';
import { applyMigrations } from '../src/db/migrate.js';
import {
  appUserIdentities,
  appUserRoles,
  appUsers,
  auditEvents,
  buildings,
  departments,
  elementCategories,
  elementTemplateRevisionVertices,
  elementTemplateRevisions,
  elementTemplates,
  employees,
  floorPlanRevisionBoundaryVertices,
  floorPlanRevisions,
  floorPlans,
  floors,
  localAuthCredentials,
  organizations,
  placedElements,
  placementIdentities,
  roles,
  sites,
} from '../src/db/schema.js';

const databaseUrl = process.env.DATABASE_URL;
const SECRET = 'end-inspect-assignments-secret-32b!';
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
  const name = `dskt_end_assignments_${randomUUID().replaceAll('-', '')}`;
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

describe.skipIf(!databaseUrl)('Ticket 27: End and inspect assignments', () => {
  it('verifies state classification, valid/invalid end times, retry, role projections, history preservation, and audit persistence through HTTP/PostgreSQL', async () => {
    await withTestDatabase(databaseUrl!, async (url) => {
      await applyMigrations(url);
      const pool = new pg.Pool({ connectionString: url });
      try {
        const db = drizzle(pool);

      // 1. Seed organization & roles
      const [org] = await db
        .insert(organizations)
        .values({ name: 'Acme Space Org' })
        .returning();

      const allRoles = await db.select().from(roles);
      const roleByCode = new Map(allRoles.map((r) => [r.code, r.id]));

      async function createUser(email: string, displayName: string, roleCodes: RoleCode[]) {
        const [user] = await db
          .insert(appUsers)
          .values({
            organizationId: org!.id,
            email,
            displayName,
            active: true,
          })
          .returning();

        const hash = await argon2.hash(PASSWORD);
        await db.insert(localAuthCredentials).values({
          appUserId: user!.id,
          username: email,
          passwordHash: hash,
        });

        await db.insert(appUserIdentities).values({
          appUserId: user!.id,
          provider: 'LOCAL',
          providerSubject: email,
        });

        for (const code of roleCodes) {
          const roleId = roleByCode.get(code);
          if (roleId) {
            await db.insert(appUserRoles).values({
              appUserId: user!.id,
              roleId,
              grantedByUserId: user!.id,
            });
          }
        }
        return user!;
      }

      const facilitiesUser = await createUser('fac@acme.com', 'Facilities Admin', ['FACILITIES_ADMIN']);
      const plannerUser = await createUser('planner@acme.com', 'Workplace Planner', ['WORKPLACE_PLANNER']);
      await createUser('viewer@acme.com', 'Viewer', ['VIEWER']);
      await createUser('admin@acme.com', 'System Admin', ['SYSTEM_ADMIN']);

      // 2. Build fastify app
      const app = await buildApp({
        config: configFor(url),
        pool,
      });

      async function login(email: string): Promise<string> {
        const res = await app.inject({
          method: 'POST',
          url: '/auth/local/sign-in',
          payload: { username: email, password: PASSWORD },
        });
        expect(res.statusCode).toBe(200);
        const cookie = res.cookies.find((c) => c.name === 'dskt_session');
        return cookie!.value;
      }

      const plannerCookie = await login('planner@acme.com');
      const facilitiesCookie = await login('fac@acme.com');
      const viewerCookie = await login('viewer@acme.com');
      const adminCookie = await login('admin@acme.com');

      // 3. Seed site, building, floor
      const [site] = await db
        .insert(sites)
        .values({
          organizationId: org!.id,
          code: 'SFO',
          name: 'San Francisco HQ',
          timeZone: 'America/Los_Angeles',
        })
        .returning();

      const [building] = await db
        .insert(buildings)
        .values({
          siteId: site!.id,
          code: 'HQ-B1',
          name: 'Building 1',
        })
        .returning();

      const [floor] = await db
        .insert(floors)
        .values({
          buildingId: building!.id,
          code: 'FL-01',
          name: 'Floor 1',
        })
        .returning();

      // Seed department & employees
      const [dept] = await db
        .insert(departments)
        .values({
          code: 'ENG',
          name: 'Engineering',
        })
        .returning();

      const [emp1] = await db
        .insert(employees)
        .values({
          employeeId: 'EMP-001',
          fullName: 'Alice Johnson',
          email: 'alice@acme.com',
          departmentId: dept!.id,
          preferredSiteId: site!.id,
          employmentStatus: 'FULL_TIME',
          active: true,
        })
        .returning();

      const [emp2] = await db
        .insert(employees)
        .values({
          employeeId: 'EMP-002',
          fullName: 'Bob Smith',
          email: 'bob@acme.com',
          departmentId: dept!.id,
          preferredSiteId: site!.id,
          employmentStatus: 'FULL_TIME',
          active: true,
        })
        .returning();

      // Seed templates: assignable PHYSICAL workstation
      const [category] = await db
        .insert(elementCategories)
        .values({
          organizationId: org!.id,
          name: 'Furniture',
          code: 'FURN',
        })
        .returning();

      const [template] = await db
        .insert(elementTemplates)
        .values({
          categoryId: category!.id,
          name: 'Standard Desk',
          code: 'DESK-STD',
        })
        .returning();

      const [templateRev] = await db
        .insert(elementTemplateRevisions)
        .values({
          elementTemplateId: template!.id,
          revisionNumber: 1,
          assignable: true,
          spatialClass: 'PHYSICAL',
          borderColor: '#000000',
          fillColor: '#cccccc',
          createdByUserId: facilitiesUser.id,
        })
        .returning();

      await db.insert(elementTemplateRevisionVertices).values([
        { elementTemplateRevisionId: templateRev!.id, sequence: 0, x: 0, y: 0 },
        { elementTemplateRevisionId: templateRev!.id, sequence: 1, x: 2, y: 0 },
        { elementTemplateRevisionId: templateRev!.id, sequence: 2, x: 2, y: 2 },
        { elementTemplateRevisionId: templateRev!.id, sequence: 3, x: 0, y: 2 },
      ]);

      await db
        .update(elementTemplates)
        .set({ currentRevisionId: templateRev!.id })
        .where(eq(elementTemplates.id, template!.id));

      // Seed Floor Plan & Published Revision
      const [plan] = await db
        .insert(floorPlans)
        .values({ floorId: floor!.id })
        .returning();

      const [publishedRev] = await db
        .insert(floorPlanRevisions)
        .values({
          floorPlanId: plan!.id,
          revisionNumber: 1,
          lifecycleState: 'PUBLISHED',
          editingScale: 1,
          concurrencyVersion: 1,
          createdByUserId: facilitiesUser.id,
          publishedByUserId: facilitiesUser.id,
          publishedAt: new Date(),
        })
        .returning();

      await db.insert(floorPlanRevisionBoundaryVertices).values([
        { floorPlanRevisionId: publishedRev!.id, sequence: 0, x: 0, y: 0 },
        { floorPlanRevisionId: publishedRev!.id, sequence: 1, x: 100, y: 0 },
        { floorPlanRevisionId: publishedRev!.id, sequence: 2, x: 100, y: 100 },
        { floorPlanRevisionId: publishedRev!.id, sequence: 3, x: 0, y: 100 },
      ]);

      // Seed 2 placement identities
      const [placementId1] = await db
        .insert(placementIdentities)
        .values({ floorPlanId: plan!.id })
        .returning();

      const [placementId2] = await db
        .insert(placementIdentities)
        .values({ floorPlanId: plan!.id })
        .returning();

      await db.insert(placedElements).values([
        {
          floorPlanRevisionId: publishedRev!.id,
          elementTemplateRevisionId: templateRev!.id,
          placementIdentityId: placementId1!.id,
          label: 'WS-01',
          positionX: 10,
          positionY: 10,
          rotationDegrees: 0,
        },
        {
          floorPlanRevisionId: publishedRev!.id,
          elementTemplateRevisionId: templateRev!.id,
          placementIdentityId: placementId2!.id,
          label: 'WS-02',
          positionX: 20,
          positionY: 10,
          rotationDegrees: 0,
        },
      ]);

      // 4. Create an active (CURRENT) assignment for emp1 on WS-01
      const pastStart = new Date(Date.now() - 3600 * 1000 * 24 * 30).toISOString(); // 30 days ago
      const createRes1 = await app.inject({
        method: 'POST',
        url: '/assignments',
        cookies: { dskt_session: plannerCookie },
        payload: {
          employeeId: emp1!.id,
          placementIdentityId: placementId1!.id,
          startedAt: pastStart,
          clientCommandId: 'cmd-create-1',
        },
      });
      expect(createRes1.statusCode).toBe(201);
      const assignment1 = createRes1.json();
      expect(assignment1.status).toBe('CURRENT');
      expect(assignment1.assignedByUserId).toBe(plannerUser.id);
      expect(assignment1.endedByUserId).toBeNull();
      expect(assignment1.endedAt).toBeNull();

      // Create a FUTURE assignment for emp2 on WS-02
      const futureStart = new Date(Date.now() + 3600 * 1000 * 24 * 7).toISOString(); // 7 days in future
      const futureEnd = new Date(Date.now() + 3600 * 1000 * 24 * 14).toISOString(); // 14 days in future
      const createRes2 = await app.inject({
        method: 'POST',
        url: '/assignments',
        cookies: { dskt_session: plannerCookie },
        payload: {
          employeeId: emp2!.id,
          placementIdentityId: placementId2!.id,
          startedAt: futureStart,
          endedAt: futureEnd,
          clientCommandId: 'cmd-create-2',
        },
      });
      expect(createRes2.statusCode).toBe(201);
      const assignment2 = createRes2.json();
      expect(assignment2.status).toBe('FUTURE');

      // -----------------------------------------------------------------------
      // AC 4: Role Projections for GET /assignments
      // Viewer sees ONLY permitted current occupancy!
      // -----------------------------------------------------------------------
      const viewerListRes = await app.inject({
        method: 'GET',
        url: '/assignments',
        cookies: { dskt_session: viewerCookie },
      });
      expect(viewerListRes.statusCode).toBe(200);
      const viewerAssignments = viewerListRes.json();
      // Viewer should see assignment1 (CURRENT), but NOT assignment2 (FUTURE)
      expect(viewerAssignments).toHaveLength(1);
      expect(viewerAssignments[0].id).toBe(assignment1.id);
      expect(viewerAssignments[0].status).toBe('CURRENT');

      // Facilities Admin & Workplace Planner see both CURRENT and FUTURE
      const plannerListRes = await app.inject({
        method: 'GET',
        url: '/assignments',
        cookies: { dskt_session: plannerCookie },
      });
      expect(plannerListRes.statusCode).toBe(200);
      const plannerAssignments = plannerListRes.json();
      expect(plannerAssignments).toHaveLength(2);

      // -----------------------------------------------------------------------
      // AC 5: Assignment history is inaccessible to unauthorized roles
      // Viewer calling /assignments/history -> 403 Forbidden!
      // -----------------------------------------------------------------------
      const viewerHistoryRes = await app.inject({
        method: 'GET',
        url: '/assignments/history',
        cookies: { dskt_session: viewerCookie },
      });
      expect(viewerHistoryRes.statusCode).toBe(403);
      expect(viewerHistoryRes.json()).toEqual({ error: 'forbidden' });

      // Facilities Admin CAN read assignment history (read-only summary access)
      const facHistoryRes = await app.inject({
        method: 'GET',
        url: '/assignments/history',
        cookies: { dskt_session: facilitiesCookie },
      });
      expect(facHistoryRes.statusCode).toBe(200);
      expect(facHistoryRes.json().items).toHaveLength(0); // none ended yet

      // -----------------------------------------------------------------------
      // AC 2 & 6: Workplace Planner can end an assignment transactionally & audited
      // Unauthorized roles cannot end an assignment:
      // Facilities Admin -> 403
      // Viewer -> 403
      // System Admin -> 403
      // -----------------------------------------------------------------------
      const facEndRes = await app.inject({
        method: 'POST',
        url: `/assignments/${assignment1.id}/end`,
        cookies: { dskt_session: facilitiesCookie },
        payload: {},
      });
      expect(facEndRes.statusCode).toBe(403);

      const viewerEndRes = await app.inject({
        method: 'POST',
        url: `/assignments/${assignment1.id}/end`,
        cookies: { dskt_session: viewerCookie },
        payload: {},
      });
      expect(viewerEndRes.statusCode).toBe(403);

      const adminEndRes = await app.inject({
        method: 'POST',
        url: `/assignments/${assignment1.id}/end`,
        cookies: { dskt_session: adminCookie },
        payload: {},
      });
      expect(adminEndRes.statusCode).toBe(403);

      // -----------------------------------------------------------------------
      // AC 3: Ending cannot create an invalid period (endedAt <= startedAt)
      // -----------------------------------------------------------------------
      const invalidEndRes = await app.inject({
        method: 'POST',
        url: `/assignments/${assignment1.id}/end`,
        cookies: { dskt_session: plannerCookie },
        payload: {
          endedAt: new Date(new Date(pastStart).getTime() - 1000).toISOString(),
        },
      });
      expect(invalidEndRes.statusCode).toBe(400);
      expect(invalidEndRes.json().error).toBe('invalid_assignment_period');

      // Equal timestamp also invalid
      const equalEndRes = await app.inject({
        method: 'POST',
        url: `/assignments/${assignment1.id}/end`,
        cookies: { dskt_session: plannerCookie },
        payload: {
          endedAt: pastStart,
        },
      });
      expect(equalEndRes.statusCode).toBe(400);
      expect(equalEndRes.json().error).toBe('invalid_assignment_period');

      // -----------------------------------------------------------------------
      // AC 2: Valid ending of active assignment while preserving creation details
      // -----------------------------------------------------------------------
      const validEndTime = new Date(Date.now() - 3600 * 1000 * 24).toISOString(); // ended yesterday
      const endRes = await app.inject({
        method: 'POST',
        url: `/assignments/${assignment1.id}/end`,
        cookies: { dskt_session: plannerCookie },
        payload: {
          endedAt: validEndTime,
          clientCommandId: 'cmd-end-1',
        },
      });
      expect(endRes.statusCode).toBe(200);
      const endedView = endRes.json();
      expect(endedView.id).toBe(assignment1.id);
      expect(endedView.status).toBe('ENDED');
      expect(endedView.startedAt).toBe(assignment1.startedAt); // preserved
      expect(endedView.assignedByUserId).toBe(plannerUser.id); // preserved original creator
      expect(endedView.endedByUserId).toBe(plannerUser.id); // recorded who ended
      expect(endedView.endedAt).toBe(validEndTime);
      expect(endedView.createdAt).toBe(assignment1.createdAt); // preserved

      // Audit log persistence
      const auditLog = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.action, 'assignment.ended'));
      expect(auditLog).toHaveLength(1);
      expect(auditLog[0]!.targetId).toBe(assignment1.id);
      expect(auditLog[0]!.actorUserId).toBe(plannerUser.id);
      expect(auditLog[0]!.correlationId).toBe('cmd-end-1');
      expect(auditLog[0]!.summary).toContain('Alice Johnson');

      // -----------------------------------------------------------------------
      // AC 6: Idempotent retry with same clientCommandId returns ended assignment
      // Payload mismatch with different endedAt returns 409
      // -----------------------------------------------------------------------
      const retryRes = await app.inject({
        method: 'POST',
        url: `/assignments/${assignment1.id}/end`,
        cookies: { dskt_session: plannerCookie },
        payload: {
          endedAt: validEndTime,
          clientCommandId: 'cmd-end-1',
        },
      });
      expect(retryRes.statusCode).toBe(200);
      expect(retryRes.json().id).toBe(assignment1.id);

      // Mismatch
      const mismatchRes = await app.inject({
        method: 'POST',
        url: `/assignments/${assignment1.id}/end`,
        cookies: { dskt_session: plannerCookie },
        payload: {
          endedAt: new Date().toISOString(),
          clientCommandId: 'cmd-end-1',
        },
      });
      expect(mismatchRes.statusCode).toBe(409);
      expect(mismatchRes.json().error).toBe('command_id_payload_mismatch');

      // -----------------------------------------------------------------------
      // AC 3: Ending cannot rewrite an already historical assignment silently
      // Attempting to end an already ended assignment without matching command -> 409
      // -----------------------------------------------------------------------
      const historicalRewriteRes = await app.inject({
        method: 'POST',
        url: `/assignments/${assignment1.id}/end`,
        cookies: { dskt_session: plannerCookie },
        payload: {
          endedAt: new Date().toISOString(),
          clientCommandId: 'cmd-end-different',
        },
      });
      expect(historicalRewriteRes.statusCode).toBe(409);
      expect(historicalRewriteRes.json().error).toBe('assignment_already_ended');

      // -----------------------------------------------------------------------
      // AC 5: Paginated history inspection
      // -----------------------------------------------------------------------
      const historyListRes = await app.inject({
        method: 'GET',
        url: '/assignments/history?limit=10&offset=0',
        cookies: { dskt_session: plannerCookie },
      });
      expect(historyListRes.statusCode).toBe(200);
      const historyData = historyListRes.json();
      expect(historyData.total).toBe(1);
      expect(historyData.limit).toBe(10);
      expect(historyData.offset).toBe(0);
      expect(historyData.items).toHaveLength(1);
      expect(historyData.items[0].id).toBe(assignment1.id);
      expect(historyData.items[0].status).toBe('ENDED');
      expect(historyData.items[0].endedByUserId).toBe(plannerUser.id);

      // -----------------------------------------------------------------------
      // Ending a FUTURE assignment
      // Must be ended at a valid timestamp > startedAt
      // -----------------------------------------------------------------------
      const futureEndedAt = new Date(new Date(futureStart).getTime() + 3600 * 1000 * 24 * 3).toISOString(); // 3 days after futureStart
      const endFutureRes = await app.inject({
        method: 'POST',
        url: `/assignments/${assignment2.id}/end`,
        cookies: { dskt_session: plannerCookie },
        payload: {
          endedAt: futureEndedAt,
        },
      });
      expect(endFutureRes.statusCode).toBe(200);
      expect(endFutureRes.json().id).toBe(assignment2.id);
      expect(endFutureRes.json().endedAt).toBe(futureEndedAt);
      expect(endFutureRes.json().status).toBe('FUTURE'); // still starts in the future

      // Verify Viewer now sees 0 current assignments (assignment1 ended, assignment2 future)
      const viewerListAfter = await app.inject({
        method: 'GET',
        url: '/assignments',
        cookies: { dskt_session: viewerCookie },
      });
      expect(viewerListAfter.statusCode).toBe(200);
      expect(viewerListAfter.json()).toHaveLength(0);
      } finally {
        await pool.end();
      }
    });
  });
});
