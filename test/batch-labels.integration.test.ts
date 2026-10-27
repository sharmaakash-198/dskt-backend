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
  elementCategories,
  elementTemplateRevisionVertices,
  elementTemplateRevisions,
  elementTemplates,
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
const SECRET = 'batch-labels-secret-32-bytes-long!';
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
  const name = `dskt_batch_labels_${randomUUID().replaceAll('-', '')}`;
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

describe.skipIf(!databaseUrl)('Ticket 25: Preview and confirm batch labels', () => {
  it('implements preview immutability, atomic confirmation, conflicts, idempotency, role authorization, and audit persistence', async () => {
    await withTestDatabase(databaseUrl!, async (url) => {
      await applyMigrations(url);
      const pool = new pg.Pool({ connectionString: url });
      const db = drizzle(pool);

      // Seed organization
      const [org] = await db
        .insert(organizations)
        .values({ name: 'Acme Test Org' })
        .returning();

      // Seed roles
      const allRoles = await db.select().from(roles);
      const roleByCode = new Map(allRoles.map((r) => [r.code, r.id]));

      // Helper to create users
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

      const planner = await createUser('planner@example.com', 'Planner User', ['WORKPLACE_PLANNER']);
      const facilities = await createUser('facilities@example.com', 'Facilities User', ['FACILITIES_ADMIN']);
      await createUser('viewer@example.com', 'Viewer User', ['VIEWER']);
      await createUser('sysadmin@example.com', 'Sys Admin User', ['SYSTEM_ADMIN']);

      // Seed site, building, floor
      const [site] = await db
        .insert(sites)
        .values({
          organizationId: org!.id,
          code: 'LON',
          name: 'London',
          timeZone: 'Europe/London',
        })
        .returning();
      const [bld] = await db.insert(buildings).values({ siteId: site!.id, code: 'HQ', name: 'Headquarters' }).returning();
      const [flr] = await db.insert(floors).values({ buildingId: bld!.id, code: 'L2', name: 'Level 2' }).returning();

      // Seed template category and templates (1 PHYSICAL, 1 ZONE)
      const [cat] = await db.insert(elementCategories).values({
        organizationId: org!.id,
        code: 'FURN',
        name: 'Furniture',
      }).returning();
      const [tmplPhysical] = await db.insert(elementTemplates).values({ categoryId: cat!.id, code: 'DESK-STD', name: 'Standard Desk' }).returning();
      const [tmplZone] = await db.insert(elementTemplates).values({ categoryId: cat!.id, code: 'ZONE-TEAM', name: 'Team Zone' }).returning();

      const [tmplRevPhysical] = await db.insert(elementTemplateRevisions).values({
        elementTemplateId: tmplPhysical!.id,
        revisionNumber: 1,
        assignable: true,
        spatialClass: 'PHYSICAL',
        fillColor: '#93c5fd',
        borderColor: '#1e3a8a',
        createdByUserId: facilities.id,
      }).returning();

      const [tmplRevZone] = await db.insert(elementTemplateRevisions).values({
        elementTemplateId: tmplZone!.id,
        revisionNumber: 1,
        assignable: false,
        spatialClass: 'ZONE',
        fillColor: '#d1fae5',
        borderColor: '#059669',
        createdByUserId: facilities.id,
      }).returning();

      // Add template vertices
      for (const [x, y, order] of [[0, 0, 0], [100, 0, 1], [100, 60, 2], [0, 60, 3]] as [number, number, number][]) {
        await db.insert(elementTemplateRevisionVertices).values({
          elementTemplateRevisionId: tmplRevPhysical!.id,
          x,
          y,
          sequence: order,
        });
      }
      for (const [x, y, order] of [[0, 0, 0], [500, 0, 1], [500, 500, 2], [0, 500, 3]] as [number, number, number][]) {
        await db.insert(elementTemplateRevisionVertices).values({
          elementTemplateRevisionId: tmplRevZone!.id,
          x,
          y,
          sequence: order,
        });
      }

      // Seed floor plan
      const [floorPlan] = await db.insert(floorPlans).values({ floorId: flr!.id }).returning();

      // Seed Published revision
      const [pubRev] = await db.insert(floorPlanRevisions).values({
        floorPlanId: floorPlan!.id,
        revisionNumber: 1,
        lifecycleState: 'PUBLISHED',
        editingScale: 1,
        concurrencyVersion: 1,
        createdByUserId: facilities.id,
        publishedAt: new Date(),
      }).returning();

      // Boundary vertices
      for (const [x, y, order] of [[0, 0, 0], [1000, 0, 1], [1000, 1000, 2], [0, 1000, 3]] as [number, number, number][]) {
        await db.insert(floorPlanRevisionBoundaryVertices).values({
          floorPlanRevisionId: pubRev!.id,
          x,
          y,
          sequence: order,
        });
      }

      // Placements on the Published revision:
      // Space 1: PHYSICAL at (100, 100)
      // Space 2: PHYSICAL at (200, 100)
      // Space 3: PHYSICAL at (100, 200), currently labeled 'EXISTING-99'
      // Space 4: ZONE at (0, 0)
      const [pi1] = await db.insert(placementIdentities).values({ floorPlanId: floorPlan!.id }).returning();
      const [pi2] = await db.insert(placementIdentities).values({ floorPlanId: floorPlan!.id }).returning();
      const [pi3] = await db.insert(placementIdentities).values({ floorPlanId: floorPlan!.id }).returning();
      const [pi4] = await db.insert(placementIdentities).values({ floorPlanId: floorPlan!.id }).returning();

      const [p1] = await db.insert(placedElements).values({
        floorPlanRevisionId: pubRev!.id,
        placementIdentityId: pi1!.id,
        elementTemplateRevisionId: tmplRevPhysical!.id,
        positionX: 100,
        positionY: 100,
        rotationDegrees: 0,
        label: null,
      }).returning();

      const [p2] = await db.insert(placedElements).values({
        floorPlanRevisionId: pubRev!.id,
        placementIdentityId: pi2!.id,
        elementTemplateRevisionId: tmplRevPhysical!.id,
        positionX: 200,
        positionY: 100,
        rotationDegrees: 0,
        label: null,
      }).returning();

      await db.insert(placedElements).values({
        floorPlanRevisionId: pubRev!.id,
        placementIdentityId: pi3!.id,
        elementTemplateRevisionId: tmplRevPhysical!.id,
        positionX: 100,
        positionY: 200,
        rotationDegrees: 0,
        label: 'EXISTING-99',
      }).returning();

      const [p4] = await db.insert(placedElements).values({
        floorPlanRevisionId: pubRev!.id,
        placementIdentityId: pi4!.id,
        elementTemplateRevisionId: tmplRevZone!.id,
        positionX: 0,
        positionY: 0,
        rotationDegrees: 0,
        label: null,
      }).returning();

      const app = await buildApp({ config: configFor(url), pool });

      // Sign-in helper
      async function signIn(email: string) {
        const res = await app.inject({
          method: 'POST',
          url: '/auth/local/sign-in',
          payload: { username: email, password: PASSWORD },
        });
        expect(res.statusCode).toBe(200);
        const cookieHeader = res.headers['set-cookie'];
        const cookie = Array.isArray(cookieHeader) ? cookieHeader[0]! : (cookieHeader as string);
        return cookie.split(';')[0]!;
      }

      const plannerCookie = await signIn('planner@example.com');
      const facilitiesCookie = await signIn('facilities@example.com');
      const viewerCookie = await signIn('viewer@example.com');
      const sysadminCookie = await signIn('sysadmin@example.com');

      const previewUrl = `/floors/${flr!.id}/floor-plan/revisions/${pubRev!.id}/batch-labels/preview`;
      const confirmUrl = `/floors/${flr!.id}/floor-plan/revisions/${pubRev!.id}/batch-labels/confirm`;

      // 1. Role authorization check
      // Unauthenticated -> 401
      const unauthRes = await app.inject({
        method: 'POST',
        url: previewUrl,
        payload: {
          placementIds: [p1!.id, p2!.id],
          prefix: 'D-',
          startNumber: 1,
          width: 3,
          ordering: 'SELECTION',
          concurrencyVersion: 1,
        },
      });
      expect(unauthRes.statusCode).toBe(401);

      // Facilities Admin alone -> 403
      const facRes = await app.inject({
        method: 'POST',
        url: previewUrl,
        headers: { cookie: facilitiesCookie },
        payload: {
          placementIds: [p1!.id, p2!.id],
          prefix: 'D-',
          startNumber: 1,
          width: 3,
          ordering: 'SELECTION',
          concurrencyVersion: 1,
        },
      });
      expect(facRes.statusCode).toBe(403);

      // Viewer -> 403
      const viewRes = await app.inject({
        method: 'POST',
        url: previewUrl,
        headers: { cookie: viewerCookie },
        payload: {
          placementIds: [p1!.id, p2!.id],
          prefix: 'D-',
          startNumber: 1,
          width: 3,
          ordering: 'SELECTION',
          concurrencyVersion: 1,
        },
      });
      expect(viewRes.statusCode).toBe(403);

      // Sysadmin -> 403
      const sysRes = await app.inject({
        method: 'POST',
        url: previewUrl,
        headers: { cookie: sysadminCookie },
        payload: {
          placementIds: [p1!.id, p2!.id],
          prefix: 'D-',
          startNumber: 1,
          width: 3,
          ordering: 'SELECTION',
          concurrencyVersion: 1,
        },
      });
      expect(sysRes.statusCode).toBe(403);

      // 2. Workplace Planner preview is deterministic and does NOT mutate database
      const validPreviewRes = await app.inject({
        method: 'POST',
        url: previewUrl,
        headers: { cookie: plannerCookie },
        payload: {
          placementIds: [p2!.id, p1!.id],
          prefix: 'D-',
          startNumber: 101,
          width: 3,
          ordering: 'ROW_MAJOR',
          concurrencyVersion: 1,
        },
      });
      expect(validPreviewRes.statusCode).toBe(200);
      const previewData = validPreviewRes.json();
      expect(previewData.ok).toBe(true);
      expect(previewData.canConfirm).toBe(true);
      expect(previewData.conflicts).toHaveLength(0);
      expect(previewData.previewToken).toBeDefined();
      // ROW_MAJOR: p1 at (100, 100) comes before p2 at (200, 100)
      expect(previewData.proposedLabels).toEqual([
        expect.objectContaining({ placementId: p1!.id, proposedLabel: 'D-101' }),
        expect.objectContaining({ placementId: p2!.id, proposedLabel: 'D-102' }),
      ]);

      // Database immutability verification: placement records must remain unchanged
      const dbPlacementsBefore = await db.select().from(placedElements).where(eq(placedElements.floorPlanRevisionId, pubRev!.id));
      const p1Db = dbPlacementsBefore.find((p) => p.id === p1!.id);
      expect(p1Db?.label).toBeNull();

      // 3. Conflict detection: Ineligible space (selecting ZONE space p4)
      const ineligibleRes = await app.inject({
        method: 'POST',
        url: previewUrl,
        headers: { cookie: plannerCookie },
        payload: {
          placementIds: [p1!.id, p4!.id],
          prefix: 'D-',
          startNumber: 1,
          width: 2,
          ordering: 'SELECTION',
          concurrencyVersion: 1,
        },
      });
      expect(ineligibleRes.statusCode).toBe(200);
      const ineligibleData = ineligibleRes.json();
      expect(ineligibleData.canConfirm).toBe(false);
      expect(ineligibleData.conflicts).toContainEqual(
        expect.objectContaining({ type: 'ineligible_space', placementId: p4!.id }),
      );

      // 4. Conflict detection: Collision with existing label (p3 already has 'EXISTING-99')
      const collisionRes = await app.inject({
        method: 'POST',
        url: previewUrl,
        headers: { cookie: plannerCookie },
        payload: {
          placementIds: [p1!.id],
          prefix: 'EXISTING-',
          startNumber: 99,
          width: 2,
          ordering: 'SELECTION',
          concurrencyVersion: 1,
        },
      });
      expect(collisionRes.statusCode).toBe(200);
      const collisionData = collisionRes.json();
      expect(collisionData.canConfirm).toBe(false);
      expect(collisionData.conflicts).toContainEqual(
        expect.objectContaining({ type: 'collision', label: 'EXISTING-99' }),
      );

      // 5. Conflict detection: Stale revision
      const staleRes = await app.inject({
        method: 'POST',
        url: previewUrl,
        headers: { cookie: plannerCookie },
        payload: {
          placementIds: [p1!.id],
          prefix: 'D-',
          startNumber: 1,
          width: 3,
          ordering: 'SELECTION',
          concurrencyVersion: 999, // stale version
        },
      });
      expect(staleRes.statusCode).toBe(200);
      const staleData = staleRes.json();
      expect(staleData.canConfirm).toBe(false);
      expect(staleData.conflicts).toContainEqual(
        expect.objectContaining({ type: 'stale_revision' }),
      );

      // 6. Confirmation: Atomic application of exact accepted preview
      const cmdId = randomUUID();
      const confirmPayload = {
        previewToken: previewData.previewToken,
        concurrencyVersion: 1,
        assignments: [
          { placementId: p1!.id, label: 'D-101' },
          { placementId: p2!.id, label: 'D-102' },
        ],
        clientCommandId: cmdId,
      };

      const confirmRes = await app.inject({
        method: 'POST',
        url: confirmUrl,
        headers: { cookie: plannerCookie },
        payload: confirmPayload,
      });
      expect(confirmRes.statusCode).toBe(200);
      const confirmData = confirmRes.json();
      expect(confirmData.ok).toBe(true);
      expect(confirmData.updatedCount).toBe(2);
      expect(confirmData.concurrencyVersion).toBe(2);

      // Check that DB was updated
      const dbPlacementsAfter = await db.select().from(placedElements).where(eq(placedElements.floorPlanRevisionId, pubRev!.id));
      const p1After = dbPlacementsAfter.find((p) => p.id === p1!.id);
      const p2After = dbPlacementsAfter.find((p) => p.id === p2!.id);
      expect(p1After?.label).toBe('D-101');
      expect(p2After?.label).toBe('D-102');

      // 7. Idempotency: Replaying exact same command returns identical result
      const replayRes = await app.inject({
        method: 'POST',
        url: confirmUrl,
        headers: { cookie: plannerCookie },
        payload: confirmPayload,
      });
      expect(replayRes.statusCode).toBe(200);
      expect(replayRes.json()).toEqual(confirmData);

      // Idempotency: Same commandId with different payload returns 409 conflict
      const mismatchRes = await app.inject({
        method: 'POST',
        url: confirmUrl,
        headers: { cookie: plannerCookie },
        payload: {
          ...confirmPayload,
          assignments: [{ placementId: p1!.id, label: 'DIFFERENT' }],
        },
      });
      expect(mismatchRes.statusCode).toBe(409);

      // 8. Stale state on confirmation: Attempting to confirm with old concurrencyVersion (1) now fails
      const staleConfirmRes = await app.inject({
        method: 'POST',
        url: confirmUrl,
        headers: { cookie: plannerCookie },
        payload: {
          previewToken: previewData.previewToken,
          concurrencyVersion: 1, // stale! now at version 2
          assignments: [
            { placementId: p1!.id, label: 'D-101' },
          ],
          clientCommandId: randomUUID(),
        },
      });
      expect(staleConfirmRes.statusCode).toBe(409);
      expect(staleConfirmRes.json()).toMatchObject({ error: expect.stringMatching(/stale_revision|concurrency_conflict/) });

      // 9. Audit event was written
      const auditRows = await db.select().from(auditEvents).where(eq(auditEvents.action, 'batch_label_applied'));
      expect(auditRows.length).toBeGreaterThanOrEqual(1);
      const row = auditRows.find((r) => r.correlationId === cmdId);
      expect(row).toBeDefined();
      expect(row?.actorUserId).toBe(planner.id);
      expect(row?.targetType).toBe('floor_plan_revision');
      expect(row?.targetId).toBe(pubRev!.id);

      // 10. Check that GET /floors/:floorId/floor-plan/published exposes the new labels
      const getPublishedRes = await app.inject({
        method: 'GET',
        url: `/floors/${flr!.id}/floor-plan/published`,
        headers: { cookie: plannerCookie },
      });
      expect(getPublishedRes.statusCode).toBe(200);
      const pubData = getPublishedRes.json();
      const pubPlacements = pubData.revision.placements as { id: string; label: string | null }[];
      const pubP1 = pubPlacements.find((p) => p.id === p1!.id);
      expect(pubP1?.label).toBe('D-101');

      await app.close();
      await pool.end();
    });
  });
});
