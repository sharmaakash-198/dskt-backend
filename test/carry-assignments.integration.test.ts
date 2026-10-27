import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { and, eq } from 'drizzle-orm';
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
  assignments,
  auditEvents,
  buildings,
  departments,
  elementCategories,
  elementTemplateRevisionVertices,
  elementTemplateRevisions,
  elementTemplates,
  employees,
  floorPlanRevisions,
  floors,
  localAuthCredentials,
  organizations,
  placedElements,
  roles,
  sites,
} from '../src/db/schema.js';

const databaseUrl = process.env.DATABASE_URL;
const SECRET = 'carry-assignments-secret-32-bytes!';
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
  const name = `dskt_carry_${randomUUID().replaceAll('-', '')}`;
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

describe.skipIf(!databaseUrl)('Ticket 28: Carry Assignments into a replacement revision', () => {
  it('implements draft branching, stable placement identities, carried assignments, actionable pre-publication blockers, and complete rollback against PostgreSQL', async () => {
    await withTestDatabase(databaseUrl!, async (url) => {
      await applyMigrations(url);
      const pool = new pg.Pool({ connectionString: url });
      const db = drizzle(pool);

      // 1. Seed organization & roles
      const [org] = await db
        .insert(organizations)
        .values({ name: 'Acme Test Org' })
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
      await createUser('planner@acme.com', 'Workplace Planner', ['WORKPLACE_PLANNER']);
      await createUser('viewer@acme.com', 'Viewer', ['VIEWER']);

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

      const facilitiesCookie = await login('fac@acme.com');
      const plannerCookie = await login('planner@acme.com');
      const viewerCookie = await login('viewer@acme.com');

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
          code: 'B1',
          name: 'Building One',
        })
        .returning();

      const [floor] = await db
        .insert(floors)
        .values({
          buildingId: building!.id,
          code: 'L1',
          name: 'Level 1',
        })
        .returning();

      // 4. Seed element categories and physical templates (one assignable, one non-assignable)
      const [category] = await db
        .insert(elementCategories)
        .values({
          organizationId: org!.id,
          code: 'WORKSTATIONS',
          name: 'Workstations',
        })
        .returning();

      // Assignable workstation template
      const [assignableTemplate] = await db
        .insert(elementTemplates)
        .values({
          categoryId: category!.id,
          code: 'DESK-STD',
          name: 'Standard Desk',
        })
        .returning();

      const [assignableRev] = await db
        .insert(elementTemplateRevisions)
        .values({
          elementTemplateId: assignableTemplate!.id,
          revisionNumber: 1,
          spatialClass: 'PHYSICAL',
          assignable: true,
          borderColor: '#333333',
          fillColor: '#E0E0E0',
          createdByUserId: facilitiesUser.id,
        })
        .returning();

      await db
        .update(elementTemplates)
        .set({ currentRevisionId: assignableRev!.id })
        .where(eq(elementTemplates.id, assignableTemplate!.id));

      await db.insert(elementTemplateRevisionVertices).values([
        { elementTemplateRevisionId: assignableRev!.id, sequence: 0, x: 0, y: 0 },
        { elementTemplateRevisionId: assignableRev!.id, sequence: 1, x: 10, y: 0 },
        { elementTemplateRevisionId: assignableRev!.id, sequence: 2, x: 10, y: 10 },
        { elementTemplateRevisionId: assignableRev!.id, sequence: 3, x: 0, y: 10 },
      ]);

      // Non-assignable physical template (e.g. Storage / Column)
      const [nonAssignableTemplate] = await db
        .insert(elementTemplates)
        .values({
          categoryId: category!.id,
          code: 'STORAGE-UNIT',
          name: 'Storage Unit',
        })
        .returning();

      const [nonAssignableRev] = await db
        .insert(elementTemplateRevisions)
        .values({
          elementTemplateId: nonAssignableTemplate!.id,
          revisionNumber: 1,
          spatialClass: 'PHYSICAL',
          assignable: false,
          borderColor: '#555555',
          fillColor: '#888888',
          createdByUserId: facilitiesUser.id,
        })
        .returning();

      await db
        .update(elementTemplates)
        .set({ currentRevisionId: nonAssignableRev!.id })
        .where(eq(elementTemplates.id, nonAssignableTemplate!.id));

      await db.insert(elementTemplateRevisionVertices).values([
        { elementTemplateRevisionId: nonAssignableRev!.id, sequence: 0, x: 0, y: 0 },
        { elementTemplateRevisionId: nonAssignableRev!.id, sequence: 1, x: 10, y: 0 },
        { elementTemplateRevisionId: nonAssignableRev!.id, sequence: 2, x: 10, y: 10 },
        { elementTemplateRevisionId: nonAssignableRev!.id, sequence: 3, x: 0, y: 10 },
      ]);

      // 5. Seed employees
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
          fullName: 'Alice Walker',
          email: 'alice@acme.com',
          departmentId: dept!.id,
          employmentStatus: 'FULL_TIME',
          active: true,
        })
        .returning();

      const [activeEmp2] = await db
        .insert(employees)
        .values({
          employeeId: 'EMP-002',
          fullName: 'Bob Roberts',
          email: 'bob@acme.com',
          departmentId: dept!.id,
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
          employmentStatus: 'TERMINATED',
          active: false,
        })
        .returning();

      // 6. Create Floor Plan Revision 1 (Draft)
      const createPlanRes = await app.inject({
        method: 'POST',
        url: `/floors/${floor!.id}/floor-plan`,
        headers: { Cookie: `dskt_session=${facilitiesCookie}` },
        payload: { editingScale: 1 },
      });
      expect(createPlanRes.statusCode).toBe(201);
      const planData = createPlanRes.json();
      const rev1Id = planData.revision.id;

      // Acquire lease on Rev 1
      const leaseRes = await app.inject({
        method: 'POST',
        url: `/floors/${floor!.id}/floor-plan/revisions/${rev1Id}/lease`,
        headers: { Cookie: `dskt_session=${facilitiesCookie}` },
      });
      expect(leaseRes.statusCode).toBe(200);
      const leaseToken = leaseRes.json().token;

      // Define orthogonal boundary for Rev 1 (0,0) -> (100,0) -> (100,100) -> (0,100)
      const boundaryRes = await app.inject({
        method: 'PUT',
        url: `/floors/${floor!.id}/floor-plan/revisions/${rev1Id}/boundary`,
        headers: {
          Cookie: `dskt_session=${facilitiesCookie}`,
          'x-lease-token': leaseToken,
        },
        payload: {
          concurrencyVersion: 0,
          vertices: [
            { x: 0, y: 0 },
            { x: 100, y: 0 },
            { x: 100, y: 100 },
            { x: 0, y: 100 },
          ],
        },
      });
      expect(boundaryRes.statusCode).toBe(200);

      // Place 3 desks in Rev 1:
      // Desk 1 at (10, 10), label "D-101"
      const p1Res = await app.inject({
        method: 'POST',
        url: `/floors/${floor!.id}/floor-plan/revisions/${rev1Id}/placements`,
        headers: {
          Cookie: `dskt_session=${facilitiesCookie}`,
          'x-lease-token': leaseToken,
        },
        payload: {
          templateRevisionId: assignableRev!.id,
          positionX: 10,
          positionY: 10,
          rotationDegrees: 0,
          label: 'D-101',
          concurrencyVersion: 1,
        },
      });
      expect(p1Res.statusCode).toBe(201);
      const p1Data = p1Res.json();
      const p1PlacementIdentityId = p1Data.placementIdentityId;

      // Desk 2 at (30, 10), label "D-102"
      const p2Res = await app.inject({
        method: 'POST',
        url: `/floors/${floor!.id}/floor-plan/revisions/${rev1Id}/placements`,
        headers: {
          Cookie: `dskt_session=${facilitiesCookie}`,
          'x-lease-token': leaseToken,
        },
        payload: {
          templateRevisionId: assignableRev!.id,
          positionX: 30,
          positionY: 10,
          rotationDegrees: 0,
          label: 'D-102',
          concurrencyVersion: 2,
        },
      });
      expect(p2Res.statusCode).toBe(201);
      const p2Data = p2Res.json();
      const p2PlacementIdentityId = p2Data.placementIdentityId;

      // Desk 3 at (50, 10), label "D-103"
      const p3Res = await app.inject({
        method: 'POST',
        url: `/floors/${floor!.id}/floor-plan/revisions/${rev1Id}/placements`,
        headers: {
          Cookie: `dskt_session=${facilitiesCookie}`,
          'x-lease-token': leaseToken,
        },
        payload: {
          templateRevisionId: assignableRev!.id,
          positionX: 50,
          positionY: 10,
          rotationDegrees: 0,
          label: 'D-103',
          concurrencyVersion: 3,
        },
      });
      expect(p3Res.statusCode).toBe(201);
      const p3PlacementIdentityId = p3Res.json().placementIdentityId;

      // Publish Revision 1
      const pub1Res = await app.inject({
        method: 'POST',
        url: `/floors/${floor!.id}/floor-plan/revisions/${rev1Id}/publish`,
        headers: {
          Cookie: `dskt_session=${facilitiesCookie}`,
          'x-lease-token': leaseToken,
        },
        payload: {
          concurrencyVersion: 4,
          clientCommandId: 'pub-cmd-1',
        },
      });
      expect(pub1Res.statusCode).toBe(200);
      expect(pub1Res.json().revision.lifecycleState).toBe('PUBLISHED');

      // 7. Workplace Planner creates assignments in Revision 1:
      // Assign activeEmp1 to Desk 1 (ongoing)
      const assign1Res = await app.inject({
        method: 'POST',
        url: '/assignments',
        headers: { Cookie: `dskt_session=${plannerCookie}` },
        payload: {
          employeeId: activeEmp1!.id,
          placementIdentityId: p1PlacementIdentityId,
          startedAt: '2026-01-01T08:00:00.000Z',
          clientCommandId: 'assign-cmd-1',
        },
      });
      expect(assign1Res.statusCode).toBe(201);
      expect(assign1Res.json().spaceLabel).toBe('D-101');

      // Assign activeEmp2 to Desk 2 (future)
      const assign2Res = await app.inject({
        method: 'POST',
        url: '/assignments',
        headers: { Cookie: `dskt_session=${plannerCookie}` },
        payload: {
          employeeId: activeEmp2!.id,
          placementIdentityId: p2PlacementIdentityId,
          startedAt: '2026-11-01T08:00:00.000Z',
          endedAt: '2026-12-31T17:00:00.000Z',
          clientCommandId: 'assign-cmd-2',
        },
      });
      expect(assign2Res.statusCode).toBe(201);
      expect(assign2Res.json().spaceLabel).toBe('D-102');

      // -----------------------------------------------------------------------
      // TEST 1: Role Authorization on branching replacement draft
      // -----------------------------------------------------------------------
      const viewerBranchRes = await app.inject({
        method: 'POST',
        url: `/floors/${floor!.id}/floor-plan/revisions`,
        headers: { Cookie: `dskt_session=${viewerCookie}` },
      });
      expect(viewerBranchRes.statusCode).toBe(403);

      const plannerBranchRes = await app.inject({
        method: 'POST',
        url: `/floors/${floor!.id}/floor-plan/revisions`,
        headers: { Cookie: `dskt_session=${plannerCookie}` },
      });
      expect(plannerBranchRes.statusCode).toBe(403);

      // -----------------------------------------------------------------------
      // TEST 2: Facilities Admin branches new Draft (Revision 2) from Published Revision 1
      // -----------------------------------------------------------------------
      const branchRes = await app.inject({
        method: 'POST',
        url: `/floors/${floor!.id}/floor-plan/revisions`,
        headers: { Cookie: `dskt_session=${facilitiesCookie}` },
      });
      expect(branchRes.statusCode).toBe(201);
      const rev2 = branchRes.json();
      expect(rev2.revisionNumber).toBe(2);
      expect(rev2.lifecycleState).toBe('DRAFT');
      expect(rev2.concurrencyVersion).toBe(0);

      // Verify immutable source: Revision 1 is still PUBLISHED in DB
      const [dbRev1] = await db
        .select()
        .from(floorPlanRevisions)
        .where(eq(floorPlanRevisions.id, rev1Id));
      expect(dbRev1!.lifecycleState).toBe('PUBLISHED');

      // Verify stable placement identities connect corresponding placements across revisions
      expect(rev2.placements.length).toBe(3);
      const rev2P1 = rev2.placements.find((p: { placementIdentityId: string }) => p.placementIdentityId === p1PlacementIdentityId);
      const rev2P2 = rev2.placements.find((p: { placementIdentityId: string }) => p.placementIdentityId === p2PlacementIdentityId);
      const rev2P3 = rev2.placements.find((p: { placementIdentityId: string }) => p.placementIdentityId === p3PlacementIdentityId);
      expect(rev2P1).toBeDefined();
      expect(rev2P2).toBeDefined();
      expect(rev2P3).toBeDefined();

      // Placed element IDs in Revision 2 are distinct from Revision 1, but placementIdentityIds match exactly!
      expect(rev2P1.id).not.toBe(p1Data.id);
      expect(rev2P1.placementIdentityId).toBe(p1PlacementIdentityId);
      expect(rev2P1.label).toBe('D-101');

      // Attempting to create another draft while one already exists returns 409 draft_already_exists
      const conflictBranchRes = await app.inject({
        method: 'POST',
        url: `/floors/${floor!.id}/floor-plan/revisions`,
        headers: { Cookie: `dskt_session=${facilitiesCookie}` },
      });
      expect(conflictBranchRes.statusCode).toBe(409);
      expect(conflictBranchRes.json().error).toBe('draft_already_exists');

      // -----------------------------------------------------------------------
      // TEST 3: Actionable Pre-Publication Errors & Rollback on Removed Target
      // -----------------------------------------------------------------------
      // Acquire lease on Rev 2
      const lease2Res = await app.inject({
        method: 'POST',
        url: `/floors/${floor!.id}/floor-plan/revisions/${rev2.id}/lease`,
        headers: { Cookie: `dskt_session=${facilitiesCookie}` },
      });
      expect(lease2Res.statusCode).toBe(200);
      const leaseToken2 = lease2Res.json().token;

      // Delete Desk 1 (which has active assignment for Alice Walker) from Rev 2
      const delP1Res = await app.inject({
        method: 'DELETE',
        url: `/floors/${floor!.id}/floor-plan/revisions/${rev2.id}/placements/${rev2P1.id}`,
        headers: {
          Cookie: `dskt_session=${facilitiesCookie}`,
          'x-lease-token': leaseToken2,
        },
        payload: { concurrencyVersion: 0 },
      });
      expect(delP1Res.statusCode).toBe(200);

      // Validate Rev 2 for publication -> should report assignment_target_removed blocker
      const valRemovedRes = await app.inject({
        method: 'POST',
        url: `/floors/${floor!.id}/floor-plan/revisions/${rev2.id}/validate`,
        headers: { Cookie: `dskt_session=${facilitiesCookie}` },
      });
      expect(valRemovedRes.statusCode).toBe(200);
      const valRemovedBody = valRemovedRes.json();
      expect(valRemovedBody.ready).toBe(false);
      const removedError = valRemovedBody.errors.find(
        (e: { code: string }) => e.code === 'assignment_target_removed',
      );
      expect(removedError).toBeDefined();
      expect(removedError.category).toBe('ASSIGNMENT');
      expect(removedError.message).toContain('Alice Walker');
      expect(removedError.correctiveAction).toContain('Reassign or end');

      // Attempt publication of Rev 2 -> rejected with publication_validation_failed and full rollback
      const pubBlockedRes = await app.inject({
        method: 'POST',
        url: `/floors/${floor!.id}/floor-plan/revisions/${rev2.id}/publish`,
        headers: {
          Cookie: `dskt_session=${facilitiesCookie}`,
          'x-lease-token': leaseToken2,
        },
        payload: {
          concurrencyVersion: 1,
          clientCommandId: 'pub-cmd-blocked-1',
        },
      });
      expect(pubBlockedRes.statusCode).toBe(400);
      expect(pubBlockedRes.json().error).toBe('publication_validation_failed');

      // Verify rollback: Rev 1 is still PUBLISHED, Rev 2 is still DRAFT
      const [checkRev1] = await db
        .select()
        .from(floorPlanRevisions)
        .where(eq(floorPlanRevisions.id, rev1Id));
      expect(checkRev1!.lifecycleState).toBe('PUBLISHED');

      const [checkRev2] = await db
        .select()
        .from(floorPlanRevisions)
        .where(eq(floorPlanRevisions.id, rev2.id));
      expect(checkRev2!.lifecycleState).toBe('DRAFT');

      // -----------------------------------------------------------------------
      // TEST 4: Actionable Pre-Publication Errors on Non-Assignable Target
      // -----------------------------------------------------------------------
      // Restore Desk 1 in Rev 2 with same placementIdentityId, but change its template to non-assignable!
      const restoreP1NonAssignableRes = await app.inject({
        method: 'POST',
        url: `/floors/${floor!.id}/floor-plan/revisions/${rev2.id}/placements`,
        headers: {
          Cookie: `dskt_session=${facilitiesCookie}`,
          'x-lease-token': leaseToken2,
        },
        payload: {
          templateRevisionId: nonAssignableRev!.id, // non-assignable storage unit!
          positionX: 10,
          positionY: 10,
          rotationDegrees: 0,
          label: 'D-101-NONASSIGN',
          concurrencyVersion: 1,
        },
      });
      expect(restoreP1NonAssignableRes.statusCode).toBe(201);
      const newP1 = restoreP1NonAssignableRes.json();

      // To test non-assignable target error on the assigned placement identity, update DB placement_identity_id
      // to match p1PlacementIdentityId
      await db
        .update(placedElements)
        .set({ placementIdentityId: p1PlacementIdentityId })
        .where(eq(placedElements.id, newP1.id));

      const valNonAssignRes = await app.inject({
        method: 'POST',
        url: `/floors/${floor!.id}/floor-plan/revisions/${rev2.id}/validate`,
        headers: { Cookie: `dskt_session=${facilitiesCookie}` },
      });
      expect(valNonAssignRes.statusCode).toBe(200);
      const nonAssignError = valNonAssignRes.json().errors.find(
        (e: { code: string }) => e.code === 'assignment_target_not_assignable',
      );
      expect(nonAssignError).toBeDefined();
      expect(nonAssignError.category).toBe('ASSIGNMENT');
      expect(nonAssignError.message).toContain('Alice Walker');
      expect(nonAssignError.correctiveAction).toContain('assignable physical template');

      // -----------------------------------------------------------------------
      // TEST 4b: Actionable Pre-Publication Errors on Inactive Employee & Conflicting Targets
      // -----------------------------------------------------------------------
      // 1) Inactive employee assignment:
      const [badEmpAssignment] = await db
        .insert(assignments)
        .values({
          placementIdentityId: p3PlacementIdentityId,
          employeeId: inactiveEmp!.id,
          assignedByUserId: facilitiesUser.id,
          startedAt: new Date('2026-01-01T08:00:00Z'),
          endedAt: null,
        })
        .returning();

      const valInactiveRes = await app.inject({
        method: 'POST',
        url: `/floors/${floor!.id}/floor-plan/revisions/${rev2.id}/validate`,
        headers: { Cookie: `dskt_session=${facilitiesCookie}` },
      });
      expect(valInactiveRes.statusCode).toBe(200);
      const inactiveError = valInactiveRes.json().errors.find(
        (e: { code: string }) => e.code === 'assignment_target_invalid',
      );
      expect(inactiveError).toBeDefined();
      expect(inactiveError.message).toContain('Charlie Inactive');

      // Clean up inactive employee test assignment
      await db.delete(assignments).where(eq(assignments.id, badEmpAssignment!.id));

      // -----------------------------------------------------------------------
      // TEST 5: Successful publication carrying unchanged & moved targets forward
      // -----------------------------------------------------------------------
      // Fix Desk 1 template back to assignable template
      await db
        .update(placedElements)
        .set({
          elementTemplateRevisionId: assignableRev!.id,
          label: 'D-101-MOVED',
          positionX: 15, // moved from 10 to 15!
          positionY: 15,
        })
        .where(eq(placedElements.id, newP1.id));

      // Validate Rev 2 -> now valid and ready!
      const valValidRes = await app.inject({
        method: 'POST',
        url: `/floors/${floor!.id}/floor-plan/revisions/${rev2.id}/validate`,
        headers: { Cookie: `dskt_session=${facilitiesCookie}` },
      });
      expect(valValidRes.statusCode).toBe(200);
      expect(valValidRes.json().ready).toBe(true);
      expect(valValidRes.json().errors.length).toBe(0);

      // Publish Revision 2 in single atomic transaction
      const pubSuccessRes = await app.inject({
        method: 'POST',
        url: `/floors/${floor!.id}/floor-plan/revisions/${rev2.id}/publish`,
        headers: {
          Cookie: `dskt_session=${facilitiesCookie}`,
          'x-lease-token': leaseToken2,
        },
        payload: {
          concurrencyVersion: 2,
          clientCommandId: 'pub-cmd-success-rev2',
        },
      });
      expect(pubSuccessRes.statusCode).toBe(200);
      const pubView = pubSuccessRes.json().revision;
      expect(pubView.lifecycleState).toBe('PUBLISHED');
      expect(pubView.revisionNumber).toBe(2);

      // Verify prior revision 1 was archived in the same transaction
      const [archivedRev1] = await db
        .select()
        .from(floorPlanRevisions)
        .where(eq(floorPlanRevisions.id, rev1Id));
      expect(archivedRev1!.lifecycleState).toBe('ARCHIVED');

      // Verify audit log includes carried assignments count
      const [pubAudit] = await db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.action, 'floor_plan.published'),
            eq(auditEvents.targetId, rev2.id),
          ),
        );
      expect(pubAudit).toBeDefined();
      expect(pubAudit!.summary).toContain('Carried forward 2 active/future assignment(s)');

      // Query assignments on the floor via GET /assignments:
      // Both assignments now resolve against the newly published Revision 2!
      const listAssignmentsRes = await app.inject({
        method: 'GET',
        url: `/assignments?floorId=${floor!.id}`,
        headers: { Cookie: `dskt_session=${plannerCookie}` },
      });
      expect(listAssignmentsRes.statusCode).toBe(200);
      const assignmentsList = listAssignmentsRes.json();
      expect(assignmentsList.length).toBe(2);

      // Desk 1 assignment for Alice Walker now reflects moved label 'D-101-MOVED'
      const aliceAssignment = assignmentsList.find(
        (a: { employeeName: string }) => a.employeeName === 'Alice Walker',
      );
      expect(aliceAssignment).toBeDefined();
      expect(aliceAssignment.spaceLabel).toBe('D-101-MOVED');

      // Desk 2 assignment for Bob Roberts remains intact
      const bobAssignment = assignmentsList.find(
        (a: { employeeName: string }) => a.employeeName === 'Bob Roberts',
      );
      expect(bobAssignment).toBeDefined();
      expect(bobAssignment.spaceLabel).toBe('D-102');

      await app.close();
      await pool.end();
    });
  });
});
