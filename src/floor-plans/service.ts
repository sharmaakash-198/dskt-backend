/**
 * Floor Plan and Revision service.
 *
 * Implements stable Floor Plan identity for Floors and immutable revisions.
 * Enforces:
 * - A Floor can have at most one Floor Plan identity.
 * - Creation produces revision 1 in Draft state with permitted 2ⁿ editing scale and non-negative concurrency version.
 * - Idempotent retry with the same key returns the existing plan and revision.
 * - Empty floor yields empty revision list without error.
 */
import { and, asc, eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { floorPlanRevisions, floorPlans, floors } from '../db/schema.js';

export const PERMITTED_EDITING_SCALES = [1, 2, 4, 8, 16, 32, 64, 128, 256] as const;
export type PermittedEditingScale = (typeof PERMITTED_EDITING_SCALES)[number];

export type FloorPlanLifecycleState = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';

export type FloorPlanView = {
  id: string;
  floorId: string;
  createdAt: string;
  updatedAt: string;
};

export type FloorPlanRevisionView = {
  id: string;
  floorPlanId: string;
  revisionNumber: number;
  lifecycleState: FloorPlanLifecycleState;
  editingScale: number;
  concurrencyVersion: number;
  createdAt: string;
  updatedAt: string;
};

export class FloorPlanError extends Error {
  constructor(
    readonly code:
      | 'floor_not_found'
      | 'floor_archived'
      | 'floor_plan_not_found'
      | 'floor_plan_already_exists'
      | 'invalid_editing_scale',
  ) {
    super(code);
    this.name = 'FloorPlanError';
  }
}

function isPermittedScale(scale: number): scale is PermittedEditingScale {
  return (PERMITTED_EDITING_SCALES as readonly number[]).includes(scale);
}

function toPlanView(row: typeof floorPlans.$inferSelect): FloorPlanView {
  return {
    id: row.id,
    floorId: row.floorId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toRevisionView(row: typeof floorPlanRevisions.$inferSelect): FloorPlanRevisionView {
  return {
    id: row.id,
    floorPlanId: row.floorPlanId,
    revisionNumber: row.revisionNumber,
    lifecycleState: row.lifecycleState as FloorPlanLifecycleState,
    editingScale: row.editingScale,
    concurrencyVersion: row.concurrencyVersion,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class FloorPlanService {
  private readonly db: NodePgDatabase;

  constructor(pool: pg.Pool) {
    this.db = drizzle(pool);
  }

  async createFloorPlan(input: {
    actorUserId: string;
    floorId: string;
    editingScale?: number;
    idempotencyKey?: string | null;
  }): Promise<{ floorPlan: FloorPlanView; revision: FloorPlanRevisionView; isReplay: boolean }> {
    const scale = input.editingScale ?? 1;
    if (!isPermittedScale(scale)) {
      throw new FloorPlanError('invalid_editing_scale');
    }

    return this.db.transaction(async (tx) => {
      await this.requireActiveFloor(tx, input.floorId);

      // Check if floor plan already exists for this floor
      const existingPlans = await tx
        .select()
        .from(floorPlans)
        .where(eq(floorPlans.floorId, input.floorId));

      const existing = existingPlans[0];
      if (existing) {
        if (
          input.idempotencyKey &&
          existing.idempotencyKey &&
          existing.idempotencyKey === input.idempotencyKey
        ) {
          // Idempotent retry with matching key: return existing plan and revision 1
          const revisions = await tx
            .select()
            .from(floorPlanRevisions)
            .where(
              and(
                eq(floorPlanRevisions.floorPlanId, existing.id),
                eq(floorPlanRevisions.revisionNumber, 1),
              ),
            );
          if (revisions[0]) {
            return {
              floorPlan: toPlanView(existing),
              revision: toRevisionView(revisions[0]),
              isReplay: true,
            };
          }
        }
        throw new FloorPlanError('floor_plan_already_exists');
      }

      // Create new floor plan identity
      const insertedPlans = await tx
        .insert(floorPlans)
        .values({
          floorId: input.floorId,
          idempotencyKey: input.idempotencyKey ?? null,
        })
        .returning();
      const plan = insertedPlans[0]!;

      // Create initial revision 1 in DRAFT state
      const insertedRevisions = await tx
        .insert(floorPlanRevisions)
        .values({
          floorPlanId: plan.id,
          revisionNumber: 1,
          lifecycleState: 'DRAFT',
          editingScale: scale,
          concurrencyVersion: 0,
          createdByUserId: input.actorUserId,
        })
        .returning();
      const revision = insertedRevisions[0]!;

      return {
        floorPlan: toPlanView(plan),
        revision: toRevisionView(revision),
        isReplay: false,
      };
    });
  }

  async listRevisions(floorId: string): Promise<FloorPlanRevisionView[]> {
    await this.requireActiveFloor(this.db, floorId);

    const planRows = await this.db
      .select({ id: floorPlans.id })
      .from(floorPlans)
      .where(eq(floorPlans.floorId, floorId));

    const plan = planRows[0];
    if (!plan) {
      // Empty floor: return empty revision list
      return [];
    }

    const rows = await this.db
      .select()
      .from(floorPlanRevisions)
      .where(eq(floorPlanRevisions.floorPlanId, plan.id))
      .orderBy(asc(floorPlanRevisions.revisionNumber));

    return rows.map(toRevisionView);
  }

  async getFloorPlan(
    floorId: string,
  ): Promise<{ floorPlan: FloorPlanView | null; activeRevision: FloorPlanRevisionView | null }> {
    await this.requireActiveFloor(this.db, floorId);

    const planRows = await this.db
      .select()
      .from(floorPlans)
      .where(eq(floorPlans.floorId, floorId));

    const plan = planRows[0];
    if (!plan) {
      return { floorPlan: null, activeRevision: null };
    }

    const revisions = await this.db
      .select()
      .from(floorPlanRevisions)
      .where(eq(floorPlanRevisions.floorPlanId, plan.id))
      .orderBy(asc(floorPlanRevisions.revisionNumber));

    // For now, return the latest revision (revision 1)
    const active = revisions[revisions.length - 1];
    return {
      floorPlan: toPlanView(plan),
      activeRevision: active ? toRevisionView(active) : null,
    };
  }

  private async requireActiveFloor(tx: NodePgDatabase, floorId: string): Promise<void> {
    const rows = await tx
      .select({ id: floors.id, archivedAt: floors.archivedAt })
      .from(floors)
      .where(eq(floors.id, floorId));
    const floor = rows[0];
    if (!floor) {
      throw new FloorPlanError('floor_not_found');
    }
    if (floor.archivedAt) {
      throw new FloorPlanError('floor_archived');
    }
  }
}
