/**
 * Floor Plan and Revision service.
 *
 * Implements stable Floor Plan identity for Floors and immutable revisions.
 * Enforces:
 * - A Floor can have at most one Floor Plan identity.
 * - Creation produces revision 1 in Draft state with permitted 2ⁿ editing scale and non-negative concurrency version.
 * - Idempotent retry with the same key returns the existing plan and revision.
 * - Empty floor yields empty revision list without error.
 * - Boundary editing: integer world coordinates (1 unit = 10 cm), normalized ordered vertices, implicit closure.
 * - Rejects edits to non-Draft revisions or stale concurrency versions.
 * - Changing editing scale updates scale/version without mutating physical geometry.
 */
import { and, asc, eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import {
  GeometryValidationError,
  validateOrthogonalPolygon,
  type GeometryDiagnostic,
  type Vertex,
} from '../geometry/orthogonal.js';
import {
  floorPlanRevisionBoundaryVertices,
  floorPlanRevisions,
  floorPlans,
  floors,
} from '../db/schema.js';

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
  boundary: Vertex[];
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
      | 'revision_not_found'
      | 'revision_not_draft'
      | 'concurrency_conflict'
      | 'invalid_editing_scale'
      | 'invalid_geometry',
    readonly diagnostics: GeometryDiagnostic[] = [],
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

function toRevisionView(
  row: typeof floorPlanRevisions.$inferSelect,
  boundary: Vertex[] = [],
): FloorPlanRevisionView {
  return {
    id: row.id,
    floorPlanId: row.floorPlanId,
    revisionNumber: row.revisionNumber,
    lifecycleState: row.lifecycleState as FloorPlanLifecycleState,
    editingScale: row.editingScale,
    concurrencyVersion: row.concurrencyVersion,
    boundary,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class FloorPlanService {
  private readonly db: NodePgDatabase;

  constructor(pool: pg.Pool) {
    this.db = drizzle(pool);
  }

  private async fetchBoundary(tx: NodePgDatabase, revisionId: string): Promise<Vertex[]> {
    const rows = await tx
      .select({
        sequence: floorPlanRevisionBoundaryVertices.sequence,
        x: floorPlanRevisionBoundaryVertices.x,
        y: floorPlanRevisionBoundaryVertices.y,
      })
      .from(floorPlanRevisionBoundaryVertices)
      .where(eq(floorPlanRevisionBoundaryVertices.floorPlanRevisionId, revisionId))
      .orderBy(asc(floorPlanRevisionBoundaryVertices.sequence));

    return rows.map((r) => ({ x: r.x, y: r.y }));
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
            const boundary = await this.fetchBoundary(tx, revisions[0].id);
            return {
              floorPlan: toPlanView(existing),
              revision: toRevisionView(revisions[0], boundary),
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
        revision: toRevisionView(revision, []),
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

    const results: FloorPlanRevisionView[] = [];
    for (const row of rows) {
      const boundary = await this.fetchBoundary(this.db, row.id);
      results.push(toRevisionView(row, boundary));
    }
    return results;
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

    const active = revisions[revisions.length - 1];
    let activeBoundary: Vertex[] = [];
    if (active) {
      activeBoundary = await this.fetchBoundary(this.db, active.id);
    }

    return {
      floorPlan: toPlanView(plan),
      activeRevision: active ? toRevisionView(active, activeBoundary) : null,
    };
  }

  async updateRevisionBoundary(input: {
    floorId: string;
    revisionId: string;
    concurrencyVersion: number;
    editingScale?: number;
    vertices: Vertex[];
  }): Promise<FloorPlanRevisionView> {
    return this.db.transaction(async (tx) => {
      await this.requireActiveFloor(tx, input.floorId);

      const revisionRows = await tx
        .select()
        .from(floorPlanRevisions)
        .where(eq(floorPlanRevisions.id, input.revisionId));

      const revision = revisionRows[0];
      if (!revision) {
        throw new FloorPlanError('revision_not_found');
      }

      if (revision.lifecycleState !== 'DRAFT') {
        throw new FloorPlanError('revision_not_draft');
      }

      if (revision.concurrencyVersion !== input.concurrencyVersion) {
        throw new FloorPlanError('concurrency_conflict');
      }

      const scale = input.editingScale ?? revision.editingScale;
      if (!isPermittedScale(scale)) {
        throw new FloorPlanError('invalid_editing_scale');
      }

      let normalizedVertices: Vertex[];
      try {
        normalizedVertices = validateOrthogonalPolygon(input.vertices);
      } catch (error) {
        if (error instanceof GeometryValidationError) {
          throw new FloorPlanError('invalid_geometry', error.diagnostics);
        }
        throw error;
      }

      // Delete old boundary vertices
      await tx
        .delete(floorPlanRevisionBoundaryVertices)
        .where(eq(floorPlanRevisionBoundaryVertices.floorPlanRevisionId, revision.id));

      // Insert validated normalized boundary vertices
      for (let i = 0; i < normalizedVertices.length; i++) {
        await tx.insert(floorPlanRevisionBoundaryVertices).values({
          floorPlanRevisionId: revision.id,
          sequence: i,
          x: normalizedVertices[i]!.x,
          y: normalizedVertices[i]!.y,
        });
      }

      // Update concurrency version, editing scale, and timestamp
      const updated = await tx
        .update(floorPlanRevisions)
        .set({
          concurrencyVersion: revision.concurrencyVersion + 1,
          editingScale: scale,
          updatedAt: new Date(),
        })
        .where(eq(floorPlanRevisions.id, revision.id))
        .returning();

      return toRevisionView(updated[0]!, normalizedVertices);
    });
  }

  async updateRevisionScale(input: {
    floorId: string;
    revisionId: string;
    concurrencyVersion: number;
    editingScale: number;
  }): Promise<FloorPlanRevisionView> {
    if (!isPermittedScale(input.editingScale)) {
      throw new FloorPlanError('invalid_editing_scale');
    }

    return this.db.transaction(async (tx) => {
      await this.requireActiveFloor(tx, input.floorId);

      const revisionRows = await tx
        .select()
        .from(floorPlanRevisions)
        .where(eq(floorPlanRevisions.id, input.revisionId));

      const revision = revisionRows[0];
      if (!revision) {
        throw new FloorPlanError('revision_not_found');
      }

      if (revision.lifecycleState !== 'DRAFT') {
        throw new FloorPlanError('revision_not_draft');
      }

      if (revision.concurrencyVersion !== input.concurrencyVersion) {
        throw new FloorPlanError('concurrency_conflict');
      }

      const boundary = await this.fetchBoundary(tx, revision.id);

      const updated = await tx
        .update(floorPlanRevisions)
        .set({
          concurrencyVersion: revision.concurrencyVersion + 1,
          editingScale: input.editingScale,
          updatedAt: new Date(),
        })
        .where(eq(floorPlanRevisions.id, revision.id))
        .returning();

      return toRevisionView(updated[0]!, boundary);
    });
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
