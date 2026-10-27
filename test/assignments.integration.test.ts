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
const SECRET = 'assignments-test-secret-32-bytes!';
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
  const name = `dskt_assignments_${randomUUID().replaceAll('-', '')}`;
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

describe.skipIf(!databaseUrl)('Ticket 26: Assign an Employee to a space', () => {
  it('implements boundary-touching periods, true overlap, concurrent creation, employee multi-assignment, retry, and role denial against PostgreSQL', async () => {
    await withTestDatabase(databaseUrl!, async (url) => {
      await applyMigrations(url);
      const pool = new pg.Pool({ connectionString: url });
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

      const [activeEmp1] = await db
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

      const [activeEmp2] = await db
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

      const [inactiveEmp] = await db
        .insert(employees)
        .values({
          employeeId: 'EMP-003',
          fullName: 'Charlie Inactive',
          email: 'charlie@acme.com',
          departmentId: dept!.id,
          preferredSiteId: site!.id,
          employmentStatus: 'TERMINATED',
          active: false,
        })
        .returning();

      // Seed templates:
      // Template A: assignable PHYSICAL desk
      const [cat] = await db
        .insert(elementCategories)
        .values({
          organizationId: org!.id,
          code: 'FURN',
          name: 'Furniture',
        })
        .returning();

      const [deskTemplate] = await db
        .insert(elementTemplates)
        .values({
          categoryId: cat!.id,
          code: 'DESK-STD',
          name: 'Standard Desk',
        })
        .returning();

      const [deskRev] = await db
        .insert(elementTemplateRevisions)
        .values({
          elementTemplateId: deskTemplate!.id,
          revisionNumber: 1,
          assignable: true,
          spatialClass: 'PHYSICAL',
          borderColor: '#1e3a8a',
          fillColor: '#93c5fd',
          createdByUserId: facilitiesUser.id,
        })
        .returning();

      await db.insert(elementTemplateRevisionVertices).values([
        { elementTemplateRevisionId: deskRev!.id, sequence: 0, x: 0, y: 0 },
        { elementTemplateRevisionId: deskRev!.id, sequence: 1, x: 100, y: 0 },
        { elementTemplateRevisionId: deskRev!.id, sequence: 2, x: 100, y: 60 },
        { elementTemplateRevisionId: deskRev!.id, sequence: 3, x: 0, y: 60 },
      ]);

      // Template B: non-assignable PHYSICAL printer
      const [printerTemplate] = await db
        .insert(elementTemplates)
        .values({
          categoryId: cat!.id,
          code: 'PRINTER-STD',
          name: 'Shared Printer',
        })
        .returning();

      const [printerRev] = await db
        .insert(elementTemplateRevisions)
        .values({
          elementTemplateId: printerTemplate!.id,
          revisionNumber: 1,
          assignable: false,
          spatialClass: 'PHYSICAL',
          borderColor: '#374151',
          fillColor: '#9ca3af',
          createdByUserId: facilitiesUser.id,
        })
        .returning();

      await db.insert(elementTemplateRevisionVertices).values([
        { elementTemplateRevisionId: printerRev!.id, sequence: 0, x: 0, y: 0 },
        { elementTemplateRevisionId: printerRev!.id, sequence: 1, x: 80, y: 0 },
        { elementTemplateRevisionId: printerRev!.id, sequence: 2, x: 80, y: 80 },
        { elementTemplateRevisionId: printerRev!.id, sequence: 3, x: 0, y: 80 },
      ]);

      // Seed floor plan & published revision
      const [floorPlan] = await db
        .insert(floorPlans)
        .values({ floorId: floor!.id })
        .returning();

      const [pubRev] = await db
        .insert(floorPlanRevisions)
        .values({
          floorPlanId: floorPlan!.id,
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
        { floorPlanRevisionId: pubRev!.id, sequence: 0, x: 0, y: 0 },
        { floorPlanRevisionId: pubRev!.id, sequence: 1, x: 1000, y: 0 },
        { floorPlanRevisionId: pubRev!.id, sequence: 2, x: 1000, y: 1000 },
        { floorPlanRevisionId: pubRev!.id, sequence: 3, x: 0, y: 1000 },
      ]);

      // Placement 1: assignable desk (Space 1)
      const [pIdentity1] = await db
        .insert(placementIdentities)
        .values({ floorPlanId: floorPlan!.id })
        .returning();

      await db.insert(placedElements).values({
        floorPlanRevisionId: pubRev!.id,
        placementIdentityId: pIdentity1!.id,
        elementTemplateRevisionId: deskRev!.id,
        positionX: 100,
        positionY: 100,
        rotationDegrees: 0,
        label: 'WS-101',
      });

      // Placement 2: assignable desk (Space 2)
      const [pIdentity2] = await db
        .insert(placementIdentities)
        .values({ floorPlanId: floorPlan!.id })
        .returning();

      await db.insert(placedElements).values({
        floorPlanRevisionId: pubRev!.id,
        placementIdentityId: pIdentity2!.id,
        elementTemplateRevisionId: deskRev!.id,
        positionX: 300,
        positionY: 100,
        rotationDegrees: 0,
        label: 'WS-102',
      });

      // Placement 3: non-assignable printer (Space 3)
      const [pIdentity3] = await db
        .insert(placementIdentities)
        .values({ floorPlanId: floorPlan!.id })
        .returning();

      await db.insert(placedElements).values({
        floorPlanRevisionId: pubRev!.id,
        placementIdentityId: pIdentity3!.id,
        elementTemplateRevisionId: printerRev!.id,
        positionX: 600,
        positionY: 100,
        rotationDegrees: 0,
        label: 'PRINTER-01',
      });

      // -------------------------------------------------------------
      // Test 1: Role-based Authorization Matrix
      // -------------------------------------------------------------
      const validPayload = {
        employeeId: activeEmp1!.id,
        placementIdentityId: pIdentity1!.id,
        startedAt: '2026-11-01T09:00:00.000Z',
        endedAt: '2026-11-01T17:00:00.000Z',
        clientCommandId: 'cmd-auth-test-1',
      };

      // Unauthenticated -> 401
      const unauthRes = await app.inject({
        method: 'POST',
        url: '/assignments',
        payload: validPayload,
      });
      expect(unauthRes.statusCode).toBe(401);

      // Facilities Admin alone -> 403
      const facRes = await app.inject({
        method: 'POST',
        url: '/assignments',
        cookies: { dskt_session: facilitiesCookie },
        payload: validPayload,
      });
      expect(facRes.statusCode).toBe(403);

      // Viewer alone -> 403
      const viewerRes = await app.inject({
        method: 'POST',
        url: '/assignments',
        cookies: { dskt_session: viewerCookie },
        payload: validPayload,
      });
      expect(viewerRes.statusCode).toBe(403);

      // System Admin alone -> 403
      const adminRes = await app.inject({
        method: 'POST',
        url: '/assignments',
        cookies: { dskt_session: adminCookie },
        payload: validPayload,
      });
      expect(adminRes.statusCode).toBe(403);

      // -------------------------------------------------------------
      // Test 2: Input & Assignability Validations
      // -------------------------------------------------------------
      // Inactive employee -> 400 employee_inactive
      const inactiveRes = await app.inject({
        method: 'POST',
        url: '/assignments',
        cookies: { dskt_session: plannerCookie },
        payload: {
          ...validPayload,
          employeeId: inactiveEmp!.id,
          clientCommandId: 'cmd-inactive-emp',
        },
      });
      expect(inactiveRes.statusCode).toBe(400);
      expect(inactiveRes.json().error).toBe('employee_inactive');

      // Non-existent employee -> 404 employee_not_found
      const noEmpRes = await app.inject({
        method: 'POST',
        url: '/assignments',
        cookies: { dskt_session: plannerCookie },
        payload: {
          ...validPayload,
          employeeId: randomUUID(),
          clientCommandId: 'cmd-no-emp',
        },
      });
      expect(noEmpRes.statusCode).toBe(404);
      expect(noEmpRes.json().error).toBe('employee_not_found');

      // Non-existent placement identity -> 404 space_not_found
      const noSpaceRes = await app.inject({
        method: 'POST',
        url: '/assignments',
        cookies: { dskt_session: plannerCookie },
        payload: {
          ...validPayload,
          placementIdentityId: randomUUID(),
          clientCommandId: 'cmd-no-space',
        },
      });
      expect(noSpaceRes.statusCode).toBe(404);
      expect(noSpaceRes.json().error).toBe('space_not_found');

      // Non-assignable space (printer) -> 400 space_not_assignable
      const nonAssignableRes = await app.inject({
        method: 'POST',
        url: '/assignments',
        cookies: { dskt_session: plannerCookie },
        payload: {
          ...validPayload,
          placementIdentityId: pIdentity3!.id,
          clientCommandId: 'cmd-non-assignable',
        },
      });
      expect(nonAssignableRes.statusCode).toBe(400);
      expect(nonAssignableRes.json().error).toBe('space_not_assignable');

      // End date before start date -> 400 invalid_assignment_period
      const badDateRes1 = await app.inject({
        method: 'POST',
        url: '/assignments',
        cookies: { dskt_session: plannerCookie },
        payload: {
          ...validPayload,
          startedAt: '2026-11-01T17:00:00.000Z',
          endedAt: '2026-11-01T09:00:00.000Z',
          clientCommandId: 'cmd-bad-date-1',
        },
      });
      expect(badDateRes1.statusCode).toBe(400);
      expect(badDateRes1.json().error).toBe('invalid_assignment_period');

      // End date equal to start date -> 400 invalid_assignment_period
      const badDateRes2 = await app.inject({
        method: 'POST',
        url: '/assignments',
        cookies: { dskt_session: plannerCookie },
        payload: {
          ...validPayload,
          startedAt: '2026-11-01T09:00:00.000Z',
          endedAt: '2026-11-01T09:00:00.000Z',
          clientCommandId: 'cmd-bad-date-2',
        },
      });
      expect(badDateRes2.statusCode).toBe(400);
      expect(badDateRes2.json().error).toBe('invalid_assignment_period');

      // -------------------------------------------------------------
      // Test 3: Successful Assignment & Boundary-Touching Periods
      // -------------------------------------------------------------
      // Period 1: [09:00, 17:00) on Space 1
      const assign1Res = await app.inject({
        method: 'POST',
        url: '/assignments',
        cookies: { dskt_session: plannerCookie },
        payload: {
          employeeId: activeEmp1!.id,
          placementIdentityId: pIdentity1!.id,
          startedAt: '2026-11-01T09:00:00.000Z',
          endedAt: '2026-11-01T17:00:00.000Z',
          clientCommandId: 'cmd-assign-1',
        },
      });
      expect(assign1Res.statusCode).toBe(201);
      const assign1 = assign1Res.json();
      expect(assign1.id).toBeDefined();
      expect(assign1.employeeName).toBe('Alice Johnson');
      expect(assign1.spaceLabel).toBe('WS-101');
      expect(assign1.floorName).toBe('Floor 1');
      expect(assign1.buildingName).toBe('Building 1');
      expect(assign1.siteName).toBe('San Francisco HQ');

      // Period 2: [17:00, 21:00) on Space 1 -> Boundary-touching period (17:00 = 17:00) MUST SUCCEED
      const assign2Res = await app.inject({
        method: 'POST',
        url: '/assignments',
        cookies: { dskt_session: plannerCookie },
        payload: {
          employeeId: activeEmp2!.id,
          placementIdentityId: pIdentity1!.id,
          startedAt: '2026-11-01T17:00:00.000Z',
          endedAt: '2026-11-01T21:00:00.000Z',
          clientCommandId: 'cmd-assign-boundary-touch',
        },
      });
      expect(assign2Res.statusCode).toBe(201);
      expect(assign2Res.json().employeeName).toBe('Bob Smith');

      // -------------------------------------------------------------
      // Test 4: True Overlap Rejection
      // -------------------------------------------------------------
      // Overlap case A: [16:00, 18:00) overlaps with both [09:00, 17:00) and [17:00, 21:00) -> 409
      const overlapRes1 = await app.inject({
        method: 'POST',
        url: '/assignments',
        cookies: { dskt_session: plannerCookie },
        payload: {
          employeeId: activeEmp1!.id,
          placementIdentityId: pIdentity1!.id,
          startedAt: '2026-11-01T16:00:00.000Z',
          endedAt: '2026-11-01T18:00:00.000Z',
          clientCommandId: 'cmd-overlap-1',
        },
      });
      expect(overlapRes1.statusCode).toBe(409);
      expect(overlapRes1.json().error).toBe('space_already_assigned');

      // Overlap case B: Enclosed [10:00, 12:00) inside [09:00, 17:00) -> 409
      const overlapRes2 = await app.inject({
        method: 'POST',
        url: '/assignments',
        cookies: { dskt_session: plannerCookie },
        payload: {
          employeeId: activeEmp2!.id,
          placementIdentityId: pIdentity1!.id,
          startedAt: '2026-11-01T10:00:00.000Z',
          endedAt: '2026-11-01T12:00:00.000Z',
          clientCommandId: 'cmd-overlap-2',
        },
      });
      expect(overlapRes2.statusCode).toBe(409);
      expect(overlapRes2.json().error).toBe('space_already_assigned');

      // -------------------------------------------------------------
      // Test 5: Employee Multi-Assignment (Overlapping to different spaces)
      // -------------------------------------------------------------
      // Alice already has Space 1 from 09:00 to 17:00.
      // She is now assigned Space 2 from 09:00 to 17:00.
      // Criteria: "An Employee may hold overlapping Assignments to different spaces."
      const multiSpaceRes = await app.inject({
        method: 'POST',
        url: '/assignments',
        cookies: { dskt_session: plannerCookie },
        payload: {
          employeeId: activeEmp1!.id,
          placementIdentityId: pIdentity2!.id,
          startedAt: '2026-11-01T09:00:00.000Z',
          endedAt: '2026-11-01T17:00:00.000Z',
          clientCommandId: 'cmd-multi-space-alice',
        },
      });
      expect(multiSpaceRes.statusCode).toBe(201);
      expect(multiSpaceRes.json().spaceLabel).toBe('WS-102');

      // -------------------------------------------------------------
      // Test 6: Retry & Idempotency
      // -------------------------------------------------------------
      // Retrying identical commandId -> 201 with identical assignment ID
      const retryRes = await app.inject({
        method: 'POST',
        url: '/assignments',
        cookies: { dskt_session: plannerCookie },
        payload: {
          employeeId: activeEmp1!.id,
          placementIdentityId: pIdentity1!.id,
          startedAt: '2026-11-01T09:00:00.000Z',
          endedAt: '2026-11-01T17:00:00.000Z',
          clientCommandId: 'cmd-assign-1',
        },
      });
      expect(retryRes.statusCode).toBe(201);
      expect(retryRes.json().id).toBe(assign1.id);

      // Reusing commandId with mismatched payload -> 409 command_id_payload_mismatch
      const mismatchRes = await app.inject({
        method: 'POST',
        url: '/assignments',
        cookies: { dskt_session: plannerCookie },
        payload: {
          employeeId: activeEmp2!.id,
          placementIdentityId: pIdentity1!.id,
          startedAt: '2026-11-01T09:00:00.000Z',
          endedAt: '2026-11-01T17:00:00.000Z',
          clientCommandId: 'cmd-assign-1',
        },
      });
      expect(mismatchRes.statusCode).toBe(409);
      expect(mismatchRes.json().error).toBe('command_id_payload_mismatch');

      // -------------------------------------------------------------
      // Test 7: Audit Trail Persistence
      // -------------------------------------------------------------
      const audits = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.action, 'assignment.created'));
      expect(audits.length).toBeGreaterThanOrEqual(3);
      const auditForAssign1 = audits.find((a) => a.targetId === assign1.id);
      expect(auditForAssign1).toBeDefined();
      expect(auditForAssign1!.actorUserId).toBe(plannerUser.id);
      expect(auditForAssign1!.correlationId).toBe('cmd-assign-1');
      expect(auditForAssign1!.summary).toContain('Alice Johnson (EMP-001)');
      expect(auditForAssign1!.summary).toContain('WS-101');

      // -------------------------------------------------------------
      // Test 8: Concurrent Creation Race
      // -------------------------------------------------------------
      // Two concurrent calls attempting to assign Space 2 on [2026-11-02T10:00:00Z, 2026-11-02T12:00:00Z)
      const race1Promise = app.inject({
        method: 'POST',
        url: '/assignments',
        cookies: { dskt_session: plannerCookie },
        payload: {
          employeeId: activeEmp1!.id,
          placementIdentityId: pIdentity2!.id,
          startedAt: '2026-11-02T10:00:00.000Z',
          endedAt: '2026-11-02T12:00:00.000Z',
          clientCommandId: 'cmd-race-1',
        },
      });

      const race2Promise = app.inject({
        method: 'POST',
        url: '/assignments',
        cookies: { dskt_session: plannerCookie },
        payload: {
          employeeId: activeEmp2!.id,
          placementIdentityId: pIdentity2!.id,
          startedAt: '2026-11-02T10:00:00.000Z',
          endedAt: '2026-11-02T12:00:00.000Z',
          clientCommandId: 'cmd-race-2',
        },
      });

      const [r1, r2] = await Promise.all([race1Promise, race2Promise]);
      const statusCodes = [r1.statusCode, r2.statusCode].sort();
      expect(statusCodes).toEqual([201, 409]);

      // -------------------------------------------------------------
      // Test 9: Querying Assignments
      // -------------------------------------------------------------
      // By employee: Alice Johnson has 2 assignments (WS-101 and WS-102)
      const empQueryRes = await app.inject({
        method: 'GET',
        url: `/assignments?employeeId=${activeEmp1!.id}`,
        cookies: { dskt_session: plannerCookie },
      });
      expect(empQueryRes.statusCode).toBe(200);
      const aliceAssignments = empQueryRes.json();
      expect(aliceAssignments.length).toBeGreaterThanOrEqual(2);
      expect(aliceAssignments[0].employeeCode).toBe('EMP-001');

      // By floor:
      const floorQueryRes = await app.inject({
        method: 'GET',
        url: `/assignments?floorId=${floor!.id}`,
        cookies: { dskt_session: plannerCookie },
      });
      expect(floorQueryRes.statusCode).toBe(200);
      const floorAssignments = floorQueryRes.json();
      expect(floorAssignments.length).toBeGreaterThanOrEqual(3);

      // Viewers can query assignments without error
      const viewerQueryRes = await app.inject({
        method: 'GET',
        url: `/assignments?floorId=${floor!.id}`,
        cookies: { dskt_session: viewerCookie }, // Viewers can query assignments
      });
      expect(viewerQueryRes.statusCode).toBe(200);

      await pool.end();
    });
  });
});
