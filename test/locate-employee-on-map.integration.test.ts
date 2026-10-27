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
import type { EmployeeActiveAssignment, EmployeeDirectoryItem } from '../src/workforce/service.js';

const databaseUrl = process.env.DATABASE_URL;
const SECRET = 'locate-employee-secret-32-bytes!';
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
  const name = `dskt_locate_${randomUUID().replaceAll('-', '')}`;
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

describe('Ticket 29: Locate an Employee on the map (Integration)', () => {
  it('resolves active assignments, communications of unassigned/single/multiple states, replacement revisions, archived locations, and role projections', async () => {
    if (!databaseUrl) {
      throw new Error('DATABASE_URL is required for integration tests');
    }

    await withTestDatabase(databaseUrl, async (url) => {
      await applyMigrations(url);

      const pool = new pg.Pool({ connectionString: url });
      const db = drizzle(pool);

      const app = await buildApp({
        config: configFor(url),
        pool,
      });

      try {
        // 1. Seed Organization, roles, users
      const [org] = await db.insert(organizations).values({ name: 'Acme Corp' }).returning();
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

      const plannerUser = await createUser('planner@acme.com', 'Planner', ['WORKPLACE_PLANNER']);
      await createUser('viewer@acme.com', 'Viewer', ['VIEWER']);

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
      const viewerCookie = await login('viewer@acme.com');

      // 2. Seed Sites, Buildings, Floors
      const [site1] = await db
        .insert(sites)
        .values({
          organizationId: org!.id,
          code: 'NYC',
          name: 'New York HQ',
          timeZone: 'America/New_York',
        })
        .returning();

      const [building1] = await db
        .insert(buildings)
        .values({
          siteId: site1!.id,
          code: 'HQ1',
          name: 'Main Tower',
        })
        .returning();

      const [floor1] = await db
        .insert(floors)
        .values({
          buildingId: building1!.id,
          code: 'FL1',
          name: 'Floor 1',
        })
        .returning();

      const [floor2] = await db
        .insert(floors)
        .values({
          buildingId: building1!.id,
          code: 'FL2',
          name: 'Floor 2',
        })
        .returning();

      // 3. Seed department and employees
      const [dept] = await db
        .insert(departments)
        .values({
          code: 'ENG',
          name: 'Engineering',
        })
        .returning();

      // Employee 1: Single active assignment
      const [emp1] = await db
        .insert(employees)
        .values({
          departmentId: dept!.id,
          employeeId: 'EMP-001',
          fullName: 'Alice Walker',
          email: 'alice@acme.test',
          jobTitle: 'Senior Software Engineer',
          employmentStatus: 'FULL_TIME',
          active: true,
        })
        .returning();

      // Employee 2: Multiple active assignments
      const [emp2] = await db
        .insert(employees)
        .values({
          departmentId: dept!.id,
          employeeId: 'EMP-002',
          fullName: 'Bob Smith',
          email: 'bob@acme.test',
          jobTitle: 'Principal Architect',
          employmentStatus: 'FULL_TIME',
          active: true,
        })
        .returning();

      // Employee 3: Unassigned
      const [emp3] = await db
        .insert(employees)
        .values({
          departmentId: dept!.id,
          employeeId: 'EMP-003',
          fullName: 'Carol Danvers',
          email: 'carol@acme.test',
          jobTitle: 'Systems Engineer',
          employmentStatus: 'FULL_TIME',
          active: true,
        })
        .returning();

      // 4. Seed template, floor plans and published revisions
      const [cat] = await db
        .insert(elementCategories)
        .values({
          organizationId: org!.id,
          code: 'WORK',
          name: 'Workspaces',
        })
        .returning();

      const [template] = await db
        .insert(elementTemplates)
        .values({
          categoryId: cat!.id,
          code: 'DESK-STD',
          name: 'Standard Desk',
        })
        .returning();

      const [templateRev] = await db
        .insert(elementTemplateRevisions)
        .values({
          elementTemplateId: template!.id,
          revisionNumber: 1,
          assignable: true,
          spatialClass: 'PHYSICAL',
          borderColor: '#1e3a8a',
          fillColor: '#93c5fd',
          createdByUserId: plannerUser.id,
        })
        .returning();

      await db.insert(elementTemplateRevisionVertices).values([
        { elementTemplateRevisionId: templateRev!.id, sequence: 0, x: 0, y: 0 },
        { elementTemplateRevisionId: templateRev!.id, sequence: 1, x: 100, y: 0 },
        { elementTemplateRevisionId: templateRev!.id, sequence: 2, x: 100, y: 100 },
        { elementTemplateRevisionId: templateRev!.id, sequence: 3, x: 0, y: 100 },
      ]);

      // Floor 1 Plan & Published Revision
      const [floorPlan1] = await db
        .insert(floorPlans)
        .values({ floorId: floor1!.id })
        .returning();

      const [rev1] = await db
        .insert(floorPlanRevisions)
        .values({
          floorPlanId: floorPlan1!.id,
          revisionNumber: 1,
          lifecycleState: 'PUBLISHED',
          editingScale: 1,
          concurrencyVersion: 1,
          createdByUserId: plannerUser.id,
          publishedByUserId: plannerUser.id,
          publishedAt: new Date(),
        })
        .returning();

      await db.insert(floorPlanRevisionBoundaryVertices).values([
        { floorPlanRevisionId: rev1!.id, sequence: 0, x: 0, y: 0 },
        { floorPlanRevisionId: rev1!.id, sequence: 1, x: 1000, y: 0 },
        { floorPlanRevisionId: rev1!.id, sequence: 2, x: 1000, y: 1000 },
        { floorPlanRevisionId: rev1!.id, sequence: 3, x: 0, y: 1000 },
      ]);

      const [pi1] = await db
        .insert(placementIdentities)
        .values({ floorPlanId: floorPlan1!.id })
        .returning();

      const [pi2] = await db
        .insert(placementIdentities)
        .values({ floorPlanId: floorPlan1!.id })
        .returning();

      await db.insert(placedElements).values([
        {
          floorPlanRevisionId: rev1!.id,
          placementIdentityId: pi1!.id,
          elementTemplateRevisionId: templateRev!.id,
          positionX: 100,
          positionY: 100,
          rotationDegrees: 0,
          label: 'Desk 101',
        },
        {
          floorPlanRevisionId: rev1!.id,
          placementIdentityId: pi2!.id,
          elementTemplateRevisionId: templateRev!.id,
          positionX: 300,
          positionY: 100,
          rotationDegrees: 0,
          label: 'Desk 102',
        },
      ]);

      // Floor 2 Plan & Published Revision
      const [floorPlan2] = await db
        .insert(floorPlans)
        .values({ floorId: floor2!.id })
        .returning();

      const [rev2] = await db
        .insert(floorPlanRevisions)
        .values({
          floorPlanId: floorPlan2!.id,
          revisionNumber: 1,
          lifecycleState: 'PUBLISHED',
          editingScale: 1,
          concurrencyVersion: 1,
          createdByUserId: plannerUser.id,
          publishedByUserId: plannerUser.id,
          publishedAt: new Date(),
        })
        .returning();

      await db.insert(floorPlanRevisionBoundaryVertices).values([
        { floorPlanRevisionId: rev2!.id, sequence: 0, x: 0, y: 0 },
        { floorPlanRevisionId: rev2!.id, sequence: 1, x: 1000, y: 0 },
        { floorPlanRevisionId: rev2!.id, sequence: 2, x: 1000, y: 1000 },
        { floorPlanRevisionId: rev2!.id, sequence: 3, x: 0, y: 1000 },
      ]);

      const [pi3] = await db
        .insert(placementIdentities)
        .values({ floorPlanId: floorPlan2!.id })
        .returning();

      await db.insert(placedElements).values([
        {
          floorPlanRevisionId: rev2!.id,
          placementIdentityId: pi3!.id,
          elementTemplateRevisionId: templateRev!.id,
          positionX: 100,
          positionY: 100,
          rotationDegrees: 0,
          label: 'Desk 201',
        },
      ]);

      // 5. Assign Alice to Desk 101 on Floor 1 (Single Active)
      const past = new Date(Date.now() - 3600000);
      const future = new Date(Date.now() + 86400000 * 30);

      const assignAliceRes = await app.inject({
        method: 'POST',
        url: '/assignments',
        cookies: { dskt_session: plannerCookie },
        payload: {
          employeeId: emp1!.id,
          placementIdentityId: pi1!.id,
          startedAt: past.toISOString(),
          endedAt: future.toISOString(),
        },
      });
      expect(assignAliceRes.statusCode).toBe(201);

      // Assign Bob to Desk 102 on Floor 1 AND Desk 201 on Floor 2 (Multiple Active)
      const assignBob1Res = await app.inject({
        method: 'POST',
        url: '/assignments',
        cookies: { dskt_session: plannerCookie },
        payload: {
          employeeId: emp2!.id,
          placementIdentityId: pi2!.id,
          startedAt: past.toISOString(),
          endedAt: null, // ongoing
        },
      });
      expect(assignBob1Res.statusCode).toBe(201);

      const assignBob2Res = await app.inject({
        method: 'POST',
        url: '/assignments',
        cookies: { dskt_session: plannerCookie },
        payload: {
          employeeId: emp2!.id,
          placementIdentityId: pi3!.id,
          startedAt: past.toISOString(),
          endedAt: null,
        },
      });
      expect(assignBob2Res.statusCode).toBe(201);

      // 6. Test Search Results communicates unassigned, single, and multiple states
      // Query Viewer directory search
      const searchRes = await app.inject({
        method: 'GET',
        url: '/employees?limit=10',
        cookies: { dskt_session: viewerCookie },
      });
      expect(searchRes.statusCode).toBe(200);
      const searchData = JSON.parse(searchRes.body);
      expect(searchData.total).toBe(3);

      const items = searchData.items as EmployeeDirectoryItem[];
      const aliceSearch = items.find((i) => i.id === emp1!.id)!;
      const bobSearch = items.find((i) => i.id === emp2!.id)!;
      const carolSearch = items.find((i) => i.id === emp3!.id)!;

      // Alice: 1 active space
      expect(aliceSearch.activeAssignmentCount).toBe(1);
      expect(aliceSearch.activeAssignments).toHaveLength(1);
      expect(aliceSearch.activeAssignments![0]!.spaceLabel).toBe('Desk 101');
      expect(aliceSearch.activeAssignments![0]!.floorName).toBe('Floor 1');
      expect(aliceSearch.activeAssignments![0]!.buildingName).toBe('Main Tower');
      expect(aliceSearch.activeAssignments![0]!.siteName).toBe('New York HQ');
      expect(aliceSearch.activeAssignments![0]!.siteId).toBe(site1!.id);
      expect(aliceSearch.activeAssignments![0]!.buildingId).toBe(building1!.id);
      expect(aliceSearch.activeAssignments![0]!.floorId).toBe(floor1!.id);
      expect(aliceSearch.activeAssignments![0]!.placementIdentityId).toBe(pi1!.id);
      expect(aliceSearch.activeAssignments![0]!.isAccessible).toBe(true);

      // Bob: multiple active spaces
      expect(bobSearch.activeAssignmentCount).toBe(2);
      expect(bobSearch.activeAssignments).toHaveLength(2);
      const bobLabels = bobSearch.activeAssignments!.map((a) => a.spaceLabel).sort();
      expect(bobLabels).toEqual(['Desk 102', 'Desk 201']);

      // Carol: unassigned
      expect(carolSearch.activeAssignmentCount).toBe(0);
      expect(carolSearch.activeAssignments).toEqual([]);

      // 7. Direct Employee lookup by Viewer
      const getAliceRes = await app.inject({
        method: 'GET',
        url: `/employees/${emp1!.id}`,
        cookies: { dskt_session: viewerCookie },
      });
      expect(getAliceRes.statusCode).toBe(200);
      const aliceDetail = JSON.parse(getAliceRes.body) as EmployeeDirectoryItem;
      expect(aliceDetail.activeAssignmentCount).toBe(1);
      expect(aliceDetail.activeAssignments![0]!.spaceLabel).toBe('Desk 101');
      // Viewer projection: only approved directory fields
      expect(aliceDetail.fullName).toBe('Alice Walker');
      expect(aliceDetail.email).toBe('alice@acme.test');
      expect(aliceDetail.manager).toBeUndefined();
      expect(aliceDetail.employmentStatus).toBeUndefined();
      expect(aliceDetail.active).toBeUndefined();

      // 8. Test GET /assignments for Viewer returns navigation IDs and excludes private fields
      const listAssignmentsRes = await app.inject({
        method: 'GET',
        url: `/assignments?employeeId=${emp1!.id}`,
        cookies: { dskt_session: viewerCookie },
      });
      expect(listAssignmentsRes.statusCode).toBe(200);
      const assignmentsList = JSON.parse(listAssignmentsRes.body);
      expect(assignmentsList).toHaveLength(1);
      const aliceAssignment = assignmentsList[0];
      expect(aliceAssignment.placementIdentityId).toBe(pi1!.id);
      expect(aliceAssignment.floorId).toBe(floor1!.id);
      expect(aliceAssignment.buildingId).toBe(building1!.id);
      expect(aliceAssignment.siteId).toBe(site1!.id);
      expect(aliceAssignment.spaceLabel).toBe('Desk 101');
      expect(aliceAssignment.status).toBe('CURRENT');
      expect(aliceAssignment.isAccessible).toBe(true);
      // Sensitive audit / management IDs stripped for Viewer
      expect(aliceAssignment.assignedByUserId).toBeUndefined();
      expect(aliceAssignment.endedByUserId).toBeUndefined();
      expect(aliceAssignment.clientCommandId).toBeUndefined();

      // 9. Test Carry forward with replacement revision (Ticket 28 carry)
      // Mark rev1 as archived before publishing rev1_2
      await db
        .update(floorPlanRevisions)
        .set({ lifecycleState: 'ARCHIVED' })
        .where(eq(floorPlanRevisions.id, rev1!.id));

      const [rev1_2] = await db
        .insert(floorPlanRevisions)
        .values({
          floorPlanId: floorPlan1!.id,
          revisionNumber: 2,
          lifecycleState: 'PUBLISHED',
          editingScale: 1,
          concurrencyVersion: 2,
          createdByUserId: plannerUser.id,
          publishedByUserId: plannerUser.id,
          publishedAt: new Date(),
        })
        .returning();

      // Carry pi1 into rev1_2
      await db.insert(placedElements).values([
        {
          floorPlanRevisionId: rev1_2!.id,
          placementIdentityId: pi1!.id,
          elementTemplateRevisionId: templateRev!.id,
          positionX: 25,
          positionY: 25,
          rotationDegrees: 90,
          label: 'Desk 101-Moved',
        },
      ]);

      // Query again - should resolve to the newly published revision's label Desk 101-Moved
      const searchAfterCarry = await app.inject({
        method: 'GET',
        url: `/employees?q=Alice`,
        cookies: { dskt_session: viewerCookie },
      });
      expect(searchAfterCarry.statusCode).toBe(200);
      const aliceAfterCarry = JSON.parse(searchAfterCarry.body).items[0];
      expect(aliceAfterCarry.activeAssignments[0].spaceLabel).toBe('Desk 101-Moved');
      expect(aliceAfterCarry.activeAssignments[0].isAccessible).toBe(true);

      // 10. Archived Location: Archive Floor 2 -> Bob's assignment on Floor 2 becomes inaccessible
      await db
        .update(floors)
        .set({ archivedAt: new Date() })
        .where(eq(floors.id, floor2!.id));

      const searchBobAfterArchive = await app.inject({
        method: 'GET',
        url: `/employees?q=Bob`,
        cookies: { dskt_session: viewerCookie },
      });
      expect(searchBobAfterArchive.statusCode).toBe(200);
      const bobAfterArchive = JSON.parse(searchBobAfterArchive.body).items[0] as EmployeeDirectoryItem;
      const floor2Assignment = bobAfterArchive.activeAssignments!.find(
        (a: EmployeeActiveAssignment) => a.floorId === floor2!.id,
      );
      expect(floor2Assignment).toBeDefined();
      expect(floor2Assignment!.isAccessible).toBe(false);

      } finally {
        await app.close().catch(() => {});
        await pool.end().catch(() => {});
      }
    });
  });
});
