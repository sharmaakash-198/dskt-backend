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
import { createHash, randomBytes } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import {
  GeometryValidationError,
  validateOrthogonalPolygon,
  diagnoseOrthogonalPolygon,
  transformVertices,
  isPolygonInsideBoundary,
  doPolygonsOverlap,
  doSpatialClassesCollide,
  checkSpatialCollision,
  type SpatialClass,
  type GeometryDiagnostic,
  type GeometryErrorCode,
  type Vertex,
} from '../geometry/orthogonal.js';
import {
  computeBatchPreviewToken,
  detectLabelConflicts,
  generateBatchLabels,
  orderPlacements,
  type BatchPlacementInput,
  type LabelConflict,
  type OrderingStrategy,
  type ProposedAssignment,
} from './batch-labels.js';
import { hasAnyRole, type RequestPrincipal } from '../auth/principal.js';
import {
  appUsers,
  assignments,
  auditEvents,
  buildings,
  elementTemplateRevisionVertices,
  elementTemplateRevisions,
  elementTemplates,
  employees,
  floorPlanEditorLeases,
  floorPlanRevisionBoundaryVertices,
  floorPlanRevisions,
  floorPlans,
  floors,
  placedElements,
  placementIdentities,
  processedCommands,
  sites,
} from '../db/schema.js';

export const PERMITTED_EDITING_SCALES = [1, 2, 4, 8, 16, 32, 64, 128, 256] as const;
export type PermittedEditingScale = (typeof PERMITTED_EDITING_SCALES)[number];

export type FloorPlanLifecycleState = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';

export type LeaseHolderView = {
  id: string;
  displayName: string;
  email: string;
};

export type FloorPlanLeaseView = {
  floorPlanRevisionId: string;
  token?: string;
  acquiredAt: string;
  expiresAt: string;
  renewedAt: string;
  releasedAt: string | null;
  isExpired: boolean;
  owner: LeaseHolderView;
};

export type FloorPlanLeaseStateView = {
  hasActiveLease: boolean;
  isCurrentHolder: boolean;
  lease: FloorPlanLeaseView | null;
};

export type FloorPlanView = {
  id: string;
  floorId: string;
  createdAt: string;
  updatedAt: string;
};

export type PlacedElementView = {
  id: string;
  floorPlanRevisionId: string;
  placementIdentityId: string;
  elementTemplateRevisionId: string;
  templateId: string;
  templateCode: string;
  templateName: string;
  templateRevisionNumber: number;
  assignable: boolean;
  spatialClass: 'PHYSICAL' | 'ZONE' | 'OBSTACLE';
  borderColor: string;
  fillColor: string;
  positionX: number;
  positionY: number;
  rotationDegrees: number;
  label: string | null;
  vertices: Vertex[];
  localVertices: Vertex[];
  createdAt: string;
  updatedAt: string;
};

export type PlaceElementInput = {
  floorId: string;
  revisionId: string;
  actorUserId?: string;
  templateRevisionId: string;
  positionX: number;
  positionY: number;
  rotationDegrees?: number;
  label?: string | null;
  concurrencyVersion?: number;
  leaseToken?: string | null;
  clientCommandId?: string | null;
};

export type UpdatePlacementInput = {
  floorId: string;
  revisionId: string;
  actorUserId?: string;
  placementId: string;
  concurrencyVersion?: number;
  positionX?: number;
  positionY?: number;
  rotationDegrees?: number;
  label?: string | null;
  leaseToken?: string | null;
  clientCommandId?: string | null;
};

export type DeletePlacementInput = {
  floorId: string;
  revisionId: string;
  actorUserId?: string;
  placementId: string;
  concurrencyVersion?: number;
  leaseToken?: string | null;
  clientCommandId?: string | null;
};

export type UpdateBoundaryInput = {
  floorId: string;
  revisionId: string;
  actorUserId?: string;
  concurrencyVersion: number;
  editingScale?: number;
  vertices: Vertex[];
  leaseToken?: string | null;
  clientCommandId?: string | null;
};

export type UpdateScaleInput = {
  floorId: string;
  revisionId: string;
  actorUserId?: string;
  concurrencyVersion: number;
  editingScale: number;
  leaseToken?: string | null;
  clientCommandId?: string | null;
};

export type FloorPlanRevisionView = {
  id: string;
  floorPlanId: string;
  revisionNumber: number;
  lifecycleState: FloorPlanLifecycleState;
  editingScale: number;
  concurrencyVersion: number;
  publishedByUserId?: string | null;
  publishedAt?: string | null;
  boundary: Vertex[];
  placements: PlacedElementView[];
  createdAt: string;
  updatedAt: string;
};

export type PublicationValidationErrorCode =
  | 'missing_boundary'
  | 'outside_boundary'
  | 'placement_collision'
  | 'template_archived'
  | 'template_revision_not_found'
  | 'duplicate_label'
  | 'invalid_label'
  | 'revision_not_draft'
  | 'floor_archived'
  | 'assignment_target_removed'
  | 'assignment_target_not_assignable'
  | 'assignment_target_conflict'
  | 'assignment_target_invalid'
  | GeometryErrorCode;

export type PublicationValidationCategory =
  | 'BOUNDARY'
  | 'CONTAINMENT'
  | 'COLLISION'
  | 'TEMPLATE'
  | 'LABEL'
  | 'LIFECYCLE'
  | 'ASSIGNMENT';

export type PublicationValidationError = {
  code: PublicationValidationErrorCode;
  category: PublicationValidationCategory;
  entityType: 'BOUNDARY' | 'PLACEMENT' | 'REVISION' | 'FLOOR' | 'ASSIGNMENT';
  entityId: string;
  conflictingEntityId?: string;
  message: string;
  correctiveAction: string;
  vertexIndex?: number;
  edgeIndex?: number;
  details?: Record<string, unknown>;
};

export type PublicationValidationResult = {
  isValid: boolean;
  ready: boolean;
  floorId: string;
  revisionId: string;
  concurrencyVersion: number;
  summary: string;
  errors: PublicationValidationError[];
  warnings: PublicationValidationError[];
};

export type ValidateDraftInput = {
  floorId: string;
  revisionId: string;
  concurrencyVersion?: number;
  actorUserId?: string;
};

export type PublishRevisionInput = {
  floorId: string;
  revisionId: string;
  concurrencyVersion: number;
  actorUserId: string;
  leaseToken?: string | null;
  clientCommandId?: string | null;
};

export class FloorPlanError extends Error {
  constructor(
    readonly code:
      | 'floor_not_found'
      | 'floor_archived'
      | 'building_archived'
      | 'site_archived'
      | 'floor_plan_not_found'
      | 'floor_plan_already_exists'
      | 'draft_already_exists'
      | 'revision_not_found'
      | 'published_revision_not_found'
      | 'revision_not_draft'
      | 'forbidden'
      | 'concurrency_conflict'
      | 'invalid_editing_scale'
      | 'invalid_geometry'
      | 'invalid_coordinates'
      | 'invalid_rotation'
      | 'outside_boundary'
      | 'template_revision_not_found'
      | 'template_archived'
      | 'template_revision_not_current'
      | 'template_revision_not_physical'
      | 'placement_collision'
      | 'duplicate_label'
      | 'placement_not_found'
      | 'lease_conflict'
      | 'lease_invalid_token'
      | 'lease_expired'
      | 'lease_not_found'
      | 'command_id_payload_mismatch'
      | 'publication_validation_failed'
      | 'revision_not_published'
      | 'stale_revision'
      | 'invalid_preview_token'
      | 'label_collision',
    readonly diagnostics: GeometryDiagnostic[] = [],
    readonly details?: Record<string, unknown>,
  ) {
    super(code);
    this.name = 'FloorPlanError';
  }
}

export type PreviewBatchLabelsInput = {
  floorId: string;
  revisionId: string;
  placementIds: string[];
  prefix: string;
  startNumber: number;
  width: number;
  ordering: OrderingStrategy;
  concurrencyVersion: number;
};

export type ProposedLabelView = {
  placementId: string;
  placementIdentityId: string;
  currentLabel: string | null;
  proposedLabel: string;
  positionX: number;
  positionY: number;
};

export type PreviewBatchLabelsResult = {
  ok: true;
  previewToken: string;
  concurrencyVersion: number;
  proposedLabels: ProposedLabelView[];
  conflicts: LabelConflict[];
  canConfirm: boolean;
};

export type ConfirmBatchLabelsInput = {
  floorId: string;
  revisionId: string;
  previewToken: string;
  concurrencyVersion: number;
  assignments: ProposedAssignment[];
  clientCommandId: string;
  actorUserId: string;
};

export type ConfirmBatchLabelsResult = {
  ok: true;
  revisionId: string;
  updatedCount: number;
  concurrencyVersion: number;
};

function canonicalJson(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return `[${obj.map(canonicalJson).join(',')}]`;
  }
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((obj as Record<string, unknown>)[k])}`).join(',')}}`;
}

function hashPayload(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
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
  placements: PlacedElementView[] = [],
): FloorPlanRevisionView {
  return {
    id: row.id,
    floorPlanId: row.floorPlanId,
    revisionNumber: row.revisionNumber,
    lifecycleState: row.lifecycleState as FloorPlanLifecycleState,
    editingScale: row.editingScale,
    concurrencyVersion: row.concurrencyVersion,
    publishedByUserId: row.publishedByUserId ?? null,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    boundary,
    placements,
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

  async createDraftRevision(input: {
    floorId: string;
    actorUserId: string;
    idempotencyKey?: string | null;
  }): Promise<FloorPlanRevisionView> {
    return this.db.transaction(async (tx) => {
      // 1. Verify floor exists and is not archived
      const floorRows = await tx
        .select()
        .from(floors)
        .where(eq(floors.id, input.floorId));
      const floor = floorRows[0];
      if (!floor) {
        throw new FloorPlanError('floor_not_found');
      }
      if (floor.archivedAt !== null) {
        throw new FloorPlanError('floor_archived');
      }

      // 2. Lock floor plan row for update
      const planRows = await tx
        .select()
        .from(floorPlans)
        .where(eq(floorPlans.floorId, input.floorId))
        .for('update');
      const plan = planRows[0];
      if (!plan) {
        throw new FloorPlanError('floor_plan_not_found');
      }

      // 3. Ensure no existing DRAFT revision exists
      const existingDraftRows = await tx
        .select()
        .from(floorPlanRevisions)
        .where(
          and(
            eq(floorPlanRevisions.floorPlanId, plan.id),
            eq(floorPlanRevisions.lifecycleState, 'DRAFT'),
          ),
        );
      if (existingDraftRows.length > 0) {
        throw new FloorPlanError('draft_already_exists');
      }

      // 4. Find active PUBLISHED revision
      const publishedRows = await tx
        .select()
        .from(floorPlanRevisions)
        .where(
          and(
            eq(floorPlanRevisions.floorPlanId, plan.id),
            eq(floorPlanRevisions.lifecycleState, 'PUBLISHED'),
          ),
        );
      const publishedRev = publishedRows[0];
      if (!publishedRev) {
        throw new FloorPlanError('published_revision_not_found');
      }

      // 5. Query all revisions to find max revision number
      const allRevs = await tx
        .select({ revisionNumber: floorPlanRevisions.revisionNumber })
        .from(floorPlanRevisions)
        .where(eq(floorPlanRevisions.floorPlanId, plan.id));
      const maxRevNum = Math.max(...allRevs.map((r) => r.revisionNumber), 0);
      const nextRevisionNumber = maxRevNum + 1;

      // 6. Insert new draft revision
      const insertedRevisions = await tx
        .insert(floorPlanRevisions)
        .values({
          floorPlanId: plan.id,
          revisionNumber: nextRevisionNumber,
          lifecycleState: 'DRAFT',
          editingScale: publishedRev.editingScale,
          concurrencyVersion: 0,
          createdByUserId: input.actorUserId,
        })
        .returning();
      const newDraft = insertedRevisions[0]!;

      // 7. Copy boundary vertices from published revision
      const publishedVertices = await tx
        .select()
        .from(floorPlanRevisionBoundaryVertices)
        .where(eq(floorPlanRevisionBoundaryVertices.floorPlanRevisionId, publishedRev.id))
        .orderBy(asc(floorPlanRevisionBoundaryVertices.sequence));

      if (publishedVertices.length > 0) {
        await tx.insert(floorPlanRevisionBoundaryVertices).values(
          publishedVertices.map((v) => ({
            floorPlanRevisionId: newDraft.id,
            sequence: v.sequence,
            x: v.x,
            y: v.y,
          })),
        );
      }

      // 8. Copy placed elements from published revision, strictly preserving stable placement identities
      const publishedPlacements = await tx
        .select()
        .from(placedElements)
        .where(eq(placedElements.floorPlanRevisionId, publishedRev.id));

      if (publishedPlacements.length > 0) {
        await tx.insert(placedElements).values(
          publishedPlacements.map((p) => ({
            floorPlanRevisionId: newDraft.id,
            placementIdentityId: p.placementIdentityId,
            elementTemplateRevisionId: p.elementTemplateRevisionId,
            positionX: p.positionX,
            positionY: p.positionY,
            rotationDegrees: p.rotationDegrees,
            label: p.label,
          })),
        );
      }

      // 9. Audit event
      const userRows = await tx
        .select({ displayName: appUsers.displayName })
        .from(appUsers)
        .where(eq(appUsers.id, input.actorUserId));
      const userDisplayName = userRows[0]?.displayName ?? 'Facilities Admin';

      await tx.insert(auditEvents).values({
        actorUserId: input.actorUserId,
        action: 'floor_plan.draft_created',
        targetType: 'FLOOR_PLAN_REVISION',
        targetId: newDraft.id,
        correlationId: newDraft.id,
        summary: `User ${userDisplayName} created draft revision ${newDraft.revisionNumber} based on published revision ${publishedRev.revisionNumber} for floor "${floor.name}" (${floor.code})`,
      });

      // 10. Return view
      const boundary = await this.fetchBoundary(tx, newDraft.id);
      const placements = await this.listPlacementsInternal(tx, newDraft.id);
      return toRevisionView(newDraft, boundary, placements);
    });
  }

  async listRevisions(
    floorId: string,
    callerPrincipal?: RequestPrincipal,
  ): Promise<FloorPlanRevisionView[]> {
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

    const isFacilitiesAdmin = callerPrincipal
      ? hasAnyRole(callerPrincipal, ['FACILITIES_ADMIN'])
      : true;

    const baseWhere = isFacilitiesAdmin
      ? eq(floorPlanRevisions.floorPlanId, plan.id)
      : and(
          eq(floorPlanRevisions.floorPlanId, plan.id),
          eq(floorPlanRevisions.lifecycleState, 'PUBLISHED'),
        );

    const rows = await this.db
      .select()
      .from(floorPlanRevisions)
      .where(baseWhere)
      .orderBy(asc(floorPlanRevisions.revisionNumber));

    const results: FloorPlanRevisionView[] = [];
    for (const row of rows) {
      const boundary = await this.fetchBoundary(this.db, row.id);
      const placements = await this.listPlacementsInternal(this.db, row.id);
      results.push(toRevisionView(row, boundary, placements));
    }
    return results;
  }

  async getFloorPlan(
    floorId: string,
    callerPrincipal?: RequestPrincipal,
  ): Promise<{
    floorPlan: FloorPlanView | null;
    activeRevision: FloorPlanRevisionView | null;
    publishedRevision?: FloorPlanRevisionView | null;
  }> {
    await this.requireActiveFloor(this.db, floorId);

    const planRows = await this.db
      .select()
      .from(floorPlans)
      .where(eq(floorPlans.floorId, floorId));

    const plan = planRows[0];
    if (!plan) {
      return { floorPlan: null, activeRevision: null, publishedRevision: null };
    }

    const revisions = await this.db
      .select()
      .from(floorPlanRevisions)
      .where(eq(floorPlanRevisions.floorPlanId, plan.id))
      .orderBy(asc(floorPlanRevisions.revisionNumber));

    const publishedRow = revisions.find((r) => r.lifecycleState === 'PUBLISHED');
    const draftRow = revisions.find((r) => r.lifecycleState === 'DRAFT');

    let publishedRevisionView: FloorPlanRevisionView | null = null;
    if (publishedRow) {
      const publishedBoundary = await this.fetchBoundary(this.db, publishedRow.id);
      const publishedPlacements = await this.listPlacementsInternal(this.db, publishedRow.id);
      publishedRevisionView = toRevisionView(publishedRow, publishedBoundary, publishedPlacements);
    }

    const isFacilitiesAdmin = callerPrincipal
      ? hasAnyRole(callerPrincipal, ['FACILITIES_ADMIN'])
      : true;

    let activeRevisionView: FloorPlanRevisionView | null;
    if (isFacilitiesAdmin) {
      if (draftRow) {
        const draftBoundary = await this.fetchBoundary(this.db, draftRow.id);
        const draftPlacements = await this.listPlacementsInternal(this.db, draftRow.id);
        activeRevisionView = toRevisionView(draftRow, draftBoundary, draftPlacements);
      } else {
        activeRevisionView = publishedRevisionView;
      }
    } else {
      activeRevisionView = publishedRevisionView;
    }

    return {
      floorPlan: toPlanView(plan),
      activeRevision: activeRevisionView,
      publishedRevision: publishedRevisionView,
    };
  }

  async getPublishedFloorPlan(
    floorId: string,
  ): Promise<{ floorPlan: FloorPlanView; revision: FloorPlanRevisionView }> {
    await this.requireActiveFloor(this.db, floorId);

    const planRows = await this.db
      .select()
      .from(floorPlans)
      .where(eq(floorPlans.floorId, floorId));

    const plan = planRows[0];
    if (!plan) {
      throw new FloorPlanError('floor_plan_not_found');
    }

    const pubRows = await this.db
      .select()
      .from(floorPlanRevisions)
      .where(
        and(
          eq(floorPlanRevisions.floorPlanId, plan.id),
          eq(floorPlanRevisions.lifecycleState, 'PUBLISHED'),
        ),
      );

    const published = pubRows[0];
    if (!published) {
      throw new FloorPlanError('published_revision_not_found');
    }

    const boundary = await this.fetchBoundary(this.db, published.id);
    const placements = await this.listPlacementsInternal(this.db, published.id);
    return {
      floorPlan: toPlanView(plan),
      revision: toRevisionView(published, boundary, placements),
    };
  }

  async getRevision(
    floorId: string,
    revisionId: string,
    callerPrincipal?: RequestPrincipal,
  ): Promise<FloorPlanRevisionView> {
    await this.requireActiveFloor(this.db, floorId);

    const planRows = await this.db
      .select({ id: floorPlans.id })
      .from(floorPlans)
      .where(eq(floorPlans.floorId, floorId));

    const plan = planRows[0];
    if (!plan) {
      throw new FloorPlanError('floor_plan_not_found');
    }

    const revRows = await this.db
      .select()
      .from(floorPlanRevisions)
      .where(
        and(
          eq(floorPlanRevisions.id, revisionId),
          eq(floorPlanRevisions.floorPlanId, plan.id),
        ),
      );

    const revision = revRows[0];
    if (!revision) {
      throw new FloorPlanError('revision_not_found');
    }

    const isFacilitiesAdmin = callerPrincipal
      ? hasAnyRole(callerPrincipal, ['FACILITIES_ADMIN'])
      : true;

    if (!isFacilitiesAdmin) {
      if (revision.lifecycleState === 'DRAFT' || revision.lifecycleState === 'ARCHIVED') {
        throw new FloorPlanError('forbidden');
      }
    }

    const boundary = await this.fetchBoundary(this.db, revision.id);
    const placements = await this.listPlacementsInternal(this.db, revision.id);
    return toRevisionView(revision, boundary, placements);
  }

  private async requireDraftRevision(
    tx: NodePgDatabase,
    floorId: string,
    revisionId: string,
  ): Promise<typeof floorPlanRevisions.$inferSelect> {
    const planRows = await tx
      .select()
      .from(floorPlans)
      .where(eq(floorPlans.floorId, floorId));
    const plan = planRows[0];
    if (!plan) throw new FloorPlanError('floor_plan_not_found');

    const revRows = await tx
      .select()
      .from(floorPlanRevisions)
      .where(
        and(
          eq(floorPlanRevisions.id, revisionId),
          eq(floorPlanRevisions.floorPlanId, plan.id),
        ),
      )
      .for('update');
    const revision = revRows[0];
    if (!revision) throw new FloorPlanError('revision_not_found');
    if (revision.lifecycleState !== 'DRAFT') {
      throw new FloorPlanError('revision_not_draft');
    }
    return revision;
  }

  private async checkLeaseAndCommand(
    tx: NodePgDatabase,
    params: {
      revisionId: string;
      actorUserId?: string;
      leaseToken?: string | null;
      clientCommandId?: string | null;
      commandType: string;
      requestPayload: unknown;
    },
  ): Promise<
    | { isReplay: true; response: unknown }
    | {
        isReplay: false;
        recordSuccess: (responseStatus: number, responseBody: unknown) => Promise<void>;
      }
  > {
    const { revisionId, actorUserId, leaseToken, clientCommandId, commandType, requestPayload } = params;

    // 1. Check lease if one exists
    const leaseRows = await tx
      .select({
        floorPlanRevisionId: floorPlanEditorLeases.floorPlanRevisionId,
        appUserId: floorPlanEditorLeases.appUserId,
        leaseTokenHash: floorPlanEditorLeases.leaseTokenHash,
        acquiredAt: floorPlanEditorLeases.acquiredAt,
        expiresAt: floorPlanEditorLeases.expiresAt,
        renewedAt: floorPlanEditorLeases.renewedAt,
        releasedAt: floorPlanEditorLeases.releasedAt,
        userActive: appUsers.active,
        userDisplayName: appUsers.displayName,
        userEmail: appUsers.email,
      })
      .from(floorPlanEditorLeases)
      .innerJoin(appUsers, eq(floorPlanEditorLeases.appUserId, appUsers.id))
      .where(eq(floorPlanEditorLeases.floorPlanRevisionId, revisionId));

    const lease = leaseRows[0];
    const now = new Date();
    const isActive =
      lease &&
      lease.releasedAt === null &&
      lease.expiresAt > now &&
      lease.userActive;

    if (isActive) {
      if (actorUserId && lease.appUserId !== actorUserId) {
        throw new FloorPlanError('lease_conflict', [], {
          holder: {
            id: lease.appUserId,
            displayName: lease.userDisplayName,
            email: lease.userEmail,
          },
          expiresAt: lease.expiresAt.toISOString(),
        });
      }
      if (!leaseToken || hashToken(leaseToken) !== lease.leaseTokenHash) {
        throw new FloorPlanError('lease_invalid_token');
      }
    }

    // 2. Check client command ID for idempotent retry
    if (clientCommandId) {
      const existingCmds = await tx
        .select()
        .from(processedCommands)
        .where(
          and(
            eq(processedCommands.floorPlanRevisionId, revisionId),
            eq(processedCommands.clientCommandId, clientCommandId),
          ),
        );

      const existingCmd = existingCmds[0];
      if (existingCmd) {
        const computedHash = hashPayload(requestPayload);
        if (existingCmd.requestHash !== computedHash) {
          throw new FloorPlanError('command_id_payload_mismatch');
        }
        return {
          isReplay: true,
          response: JSON.parse(existingCmd.responseBody),
        };
      }
    }

    return {
      isReplay: false,
      recordSuccess: async (status: number, body: unknown) => {
        if (clientCommandId && actorUserId) {
          const reqHash = hashPayload(requestPayload);
          await tx
            .insert(processedCommands)
            .values({
              floorPlanRevisionId: revisionId,
              clientCommandId,
              appUserId: actorUserId,
              commandType,
              requestHash: reqHash,
              responseStatus: status,
              responseBody: JSON.stringify(body),
            })
            .onConflictDoNothing();
        }
      },
    };
  }

  async acquireLease(input: {
    floorId: string;
    revisionId: string;
    actorUserId: string;
    durationSeconds?: number;
  }): Promise<{ lease: FloorPlanLeaseView; token: string }> {
    const duration = input.durationSeconds ?? 60;
    return this.db.transaction(async (tx) => {
      await this.requireActiveFloor(tx, input.floorId);
      const planRows = await tx
        .select()
        .from(floorPlans)
        .where(eq(floorPlans.floorId, input.floorId));
      const plan = planRows[0];
      if (!plan) throw new FloorPlanError('floor_plan_not_found');
      const revision = await this.requireDraftRevision(tx, input.floorId, input.revisionId);

      const userRows = await tx
        .select()
        .from(appUsers)
        .where(eq(appUsers.id, input.actorUserId));
      const user = userRows[0];
      if (!user || !user.active) {
        throw new FloorPlanError('floor_not_found');
      }

      const existingLeaseRows = await tx
        .select({
          floorPlanRevisionId: floorPlanEditorLeases.floorPlanRevisionId,
          appUserId: floorPlanEditorLeases.appUserId,
          leaseTokenHash: floorPlanEditorLeases.leaseTokenHash,
          acquiredAt: floorPlanEditorLeases.acquiredAt,
          expiresAt: floorPlanEditorLeases.expiresAt,
          renewedAt: floorPlanEditorLeases.renewedAt,
          releasedAt: floorPlanEditorLeases.releasedAt,
          userActive: appUsers.active,
          userDisplayName: appUsers.displayName,
          userEmail: appUsers.email,
        })
        .from(floorPlanEditorLeases)
        .innerJoin(appUsers, eq(floorPlanEditorLeases.appUserId, appUsers.id))
        .where(eq(floorPlanEditorLeases.floorPlanRevisionId, revision.id))
        .for('update');

      const existing = existingLeaseRows[0];
      const now = new Date();

      if (existing && existing.releasedAt === null && existing.expiresAt > now && existing.userActive) {
        if (existing.appUserId !== input.actorUserId) {
          throw new FloorPlanError('lease_conflict', [], {
            holder: {
              id: existing.appUserId,
              displayName: existing.userDisplayName,
              email: existing.userEmail,
            },
            expiresAt: existing.expiresAt.toISOString(),
          });
        }
      }

      const rawToken = randomBytes(32).toString('hex');
      const tokenHash = hashToken(rawToken);
      const expiresAt = new Date(now.getTime() + duration * 1000);

      await tx
        .insert(floorPlanEditorLeases)
        .values({
          floorPlanRevisionId: revision.id,
          appUserId: input.actorUserId,
          leaseTokenHash: tokenHash,
          acquiredAt: now,
          renewedAt: now,
          expiresAt,
          releasedAt: null,
        })
        .onConflictDoUpdate({
          target: floorPlanEditorLeases.floorPlanRevisionId,
          set: {
            appUserId: input.actorUserId,
            leaseTokenHash: tokenHash,
            acquiredAt: now,
            renewedAt: now,
            expiresAt,
            releasedAt: null,
          },
        });

      await tx.insert(auditEvents).values({
        actorUserId: input.actorUserId,
        action: 'ACQUIRE_LEASE',
        targetType: 'FLOOR_PLAN_REVISION',
        targetId: revision.id,
        correlationId: revision.id,
        summary: `User ${user.displayName} acquired editor lease on draft revision ${revision.revisionNumber}`,
      });

      return {
        lease: {
          floorPlanRevisionId: revision.id,
          token: rawToken,
          acquiredAt: now.toISOString(),
          expiresAt: expiresAt.toISOString(),
          renewedAt: now.toISOString(),
          releasedAt: null,
          isExpired: false,
          owner: {
            id: user.id,
            displayName: user.displayName,
            email: user.email,
          },
        },
        token: rawToken,
      };
    });
  }

  async getLease(input: {
    floorId: string;
    revisionId: string;
    actorUserId?: string;
  }): Promise<FloorPlanLeaseStateView> {
    return this.db.transaction(async (tx) => {
      const leaseRows = await tx
        .select({
          floorPlanRevisionId: floorPlanEditorLeases.floorPlanRevisionId,
          appUserId: floorPlanEditorLeases.appUserId,
          acquiredAt: floorPlanEditorLeases.acquiredAt,
          expiresAt: floorPlanEditorLeases.expiresAt,
          renewedAt: floorPlanEditorLeases.renewedAt,
          releasedAt: floorPlanEditorLeases.releasedAt,
          userActive: appUsers.active,
          userDisplayName: appUsers.displayName,
          userEmail: appUsers.email,
        })
        .from(floorPlanEditorLeases)
        .innerJoin(appUsers, eq(floorPlanEditorLeases.appUserId, appUsers.id))
        .where(eq(floorPlanEditorLeases.floorPlanRevisionId, input.revisionId));

      const lease = leaseRows[0];
      if (!lease) {
        return {
          hasActiveLease: false,
          isCurrentHolder: false,
          lease: null,
        };
      }

      const now = new Date();
      const isExpired = lease.expiresAt <= now;
      const isActive = lease.releasedAt === null && !isExpired && lease.userActive;

      return {
        hasActiveLease: isActive,
        isCurrentHolder: isActive && lease.appUserId === input.actorUserId,
        lease: {
          floorPlanRevisionId: lease.floorPlanRevisionId,
          acquiredAt: lease.acquiredAt.toISOString(),
          expiresAt: lease.expiresAt.toISOString(),
          renewedAt: lease.renewedAt.toISOString(),
          releasedAt: lease.releasedAt ? lease.releasedAt.toISOString() : null,
          isExpired,
          owner: {
            id: lease.appUserId,
            displayName: lease.userDisplayName,
            email: lease.userEmail,
          },
        },
      };
    });
  }

  async renewLease(input: {
    floorId: string;
    revisionId: string;
    actorUserId: string;
    leaseToken: string;
    durationSeconds?: number;
  }): Promise<FloorPlanLeaseView> {
    const duration = input.durationSeconds ?? 60;
    return this.db.transaction(async (tx) => {
      await this.requireActiveFloor(tx, input.floorId);
      const planRows = await tx
        .select()
        .from(floorPlans)
        .where(eq(floorPlans.floorId, input.floorId));
      const plan = planRows[0];
      if (!plan) throw new FloorPlanError('floor_plan_not_found');
      const revision = await this.requireDraftRevision(tx, input.floorId, input.revisionId);

      const leaseRows = await tx
        .select({
          floorPlanRevisionId: floorPlanEditorLeases.floorPlanRevisionId,
          appUserId: floorPlanEditorLeases.appUserId,
          leaseTokenHash: floorPlanEditorLeases.leaseTokenHash,
          acquiredAt: floorPlanEditorLeases.acquiredAt,
          expiresAt: floorPlanEditorLeases.expiresAt,
          renewedAt: floorPlanEditorLeases.renewedAt,
          releasedAt: floorPlanEditorLeases.releasedAt,
          userActive: appUsers.active,
          userDisplayName: appUsers.displayName,
          userEmail: appUsers.email,
        })
        .from(floorPlanEditorLeases)
        .innerJoin(appUsers, eq(floorPlanEditorLeases.appUserId, appUsers.id))
        .where(eq(floorPlanEditorLeases.floorPlanRevisionId, revision.id))
        .for('update');

      const lease = leaseRows[0];
      if (!lease) {
        throw new FloorPlanError('lease_not_found');
      }

      if (lease.appUserId !== input.actorUserId || hashToken(input.leaseToken) !== lease.leaseTokenHash) {
        throw new FloorPlanError('lease_invalid_token');
      }

      if (lease.releasedAt !== null) {
        throw new FloorPlanError('lease_invalid_token');
      }

      const now = new Date();
      const expiresAt = new Date(now.getTime() + duration * 1000);

      await tx
        .update(floorPlanEditorLeases)
        .set({
          renewedAt: now,
          expiresAt,
        })
        .where(eq(floorPlanEditorLeases.floorPlanRevisionId, revision.id));

      return {
        floorPlanRevisionId: revision.id,
        token: input.leaseToken,
        acquiredAt: lease.acquiredAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        renewedAt: now.toISOString(),
        releasedAt: null,
        isExpired: false,
        owner: {
          id: lease.appUserId,
          displayName: lease.userDisplayName,
          email: lease.userEmail,
        },
      };
    });
  }

  async releaseLease(input: {
    floorId: string;
    revisionId: string;
    actorUserId: string;
    leaseToken: string;
  }): Promise<{ ok: true }> {
    return this.db.transaction(async (tx) => {
      await this.requireActiveFloor(tx, input.floorId);
      const planRows = await tx
        .select()
        .from(floorPlans)
        .where(eq(floorPlans.floorId, input.floorId));
      const plan = planRows[0];
      if (!plan) throw new FloorPlanError('floor_plan_not_found');
      const revision = await this.requireDraftRevision(tx, input.floorId, input.revisionId);

      const leaseRows = await tx
        .select()
        .from(floorPlanEditorLeases)
        .where(eq(floorPlanEditorLeases.floorPlanRevisionId, revision.id))
        .for('update');

      const lease = leaseRows[0];
      if (!lease) {
        return { ok: true };
      }

      if (lease.appUserId !== input.actorUserId || hashToken(input.leaseToken) !== lease.leaseTokenHash) {
        throw new FloorPlanError('lease_invalid_token');
      }

      const now = new Date();
      await tx
        .update(floorPlanEditorLeases)
        .set({ releasedAt: now })
        .where(eq(floorPlanEditorLeases.floorPlanRevisionId, revision.id));

      await tx.insert(auditEvents).values({
        actorUserId: input.actorUserId,
        action: 'RELEASE_LEASE',
        targetType: 'FLOOR_PLAN_REVISION',
        targetId: revision.id,
        correlationId: revision.id,
        summary: `User released editor lease on draft revision ${revision.revisionNumber}`,
      });

      return { ok: true };
    });
  }

  async takeoverLease(input: {
    floorId: string;
    revisionId: string;
    actorUserId: string;
    reason?: string;
    durationSeconds?: number;
  }): Promise<{ lease: FloorPlanLeaseView; token: string }> {
    const duration = input.durationSeconds ?? 60;
    return this.db.transaction(async (tx) => {
      await this.requireActiveFloor(tx, input.floorId);
      const planRows = await tx
        .select()
        .from(floorPlans)
        .where(eq(floorPlans.floorId, input.floorId));
      const plan = planRows[0];
      if (!plan) throw new FloorPlanError('floor_plan_not_found');
      const revision = await this.requireDraftRevision(tx, input.floorId, input.revisionId);

      const userRows = await tx
        .select()
        .from(appUsers)
        .where(eq(appUsers.id, input.actorUserId));
      const user = userRows[0];
      if (!user || !user.active) {
        throw new FloorPlanError('floor_not_found');
      }

      const leaseRows = await tx
        .select({
          floorPlanRevisionId: floorPlanEditorLeases.floorPlanRevisionId,
          appUserId: floorPlanEditorLeases.appUserId,
          leaseTokenHash: floorPlanEditorLeases.leaseTokenHash,
          acquiredAt: floorPlanEditorLeases.acquiredAt,
          expiresAt: floorPlanEditorLeases.expiresAt,
          renewedAt: floorPlanEditorLeases.renewedAt,
          releasedAt: floorPlanEditorLeases.releasedAt,
          userActive: appUsers.active,
          userDisplayName: appUsers.displayName,
          userEmail: appUsers.email,
        })
        .from(floorPlanEditorLeases)
        .innerJoin(appUsers, eq(floorPlanEditorLeases.appUserId, appUsers.id))
        .where(eq(floorPlanEditorLeases.floorPlanRevisionId, revision.id))
        .for('update');

      const priorLease = leaseRows[0];
      const now = new Date();

      // Check if prior lease is still active and valid (not expired, not released, holder active)
      if (
        priorLease &&
        priorLease.releasedAt === null &&
        priorLease.expiresAt > now &&
        priorLease.userActive
      ) {
        if (priorLease.appUserId !== input.actorUserId) {
          throw new FloorPlanError('lease_conflict', [], {
            holder: {
              id: priorLease.appUserId,
              displayName: priorLease.userDisplayName,
              email: priorLease.userEmail,
            },
            expiresAt: priorLease.expiresAt.toISOString(),
          });
        }
      }

      const rawToken = randomBytes(32).toString('hex');
      const tokenHash = hashToken(rawToken);
      const expiresAt = new Date(now.getTime() + duration * 1000);

      await tx
        .insert(floorPlanEditorLeases)
        .values({
          floorPlanRevisionId: revision.id,
          appUserId: input.actorUserId,
          leaseTokenHash: tokenHash,
          acquiredAt: now,
          renewedAt: now,
          expiresAt,
          releasedAt: null,
        })
        .onConflictDoUpdate({
          target: floorPlanEditorLeases.floorPlanRevisionId,
          set: {
            appUserId: input.actorUserId,
            leaseTokenHash: tokenHash,
            acquiredAt: now,
            renewedAt: now,
            expiresAt,
            releasedAt: null,
          },
        });

      const priorInfo = priorLease
        ? ` (prior holder: ${priorLease.userDisplayName} <${priorLease.userEmail}>)`
        : '';
      const reasonInfo = input.reason ? ` - Reason: ${input.reason}` : '';

      await tx.insert(auditEvents).values({
        actorUserId: input.actorUserId,
        action: 'TAKEOVER_LEASE',
        targetType: 'FLOOR_PLAN_REVISION',
        targetId: revision.id,
        correlationId: revision.id,
        summary: `User ${user.displayName} took over editor lease on draft revision ${revision.revisionNumber}${priorInfo}${reasonInfo}`,
      });

      return {
        lease: {
          floorPlanRevisionId: revision.id,
          token: rawToken,
          acquiredAt: now.toISOString(),
          expiresAt: expiresAt.toISOString(),
          renewedAt: now.toISOString(),
          releasedAt: null,
          isExpired: false,
          owner: {
            id: user.id,
            displayName: user.displayName,
            email: user.email,
          },
        },
        token: rawToken,
      };
    });
  }

  async updateRevisionBoundary(input: UpdateBoundaryInput): Promise<FloorPlanRevisionView> {
    return this.db.transaction(async (tx) => {
      await this.requireActiveFloor(tx, input.floorId);
      const planRows = await tx
        .select()
        .from(floorPlans)
        .where(eq(floorPlans.floorId, input.floorId));
      const plan = planRows[0];
      if (!plan) throw new FloorPlanError('floor_plan_not_found');
      const revision = await this.requireDraftRevision(tx, input.floorId, input.revisionId);

      const check = await this.checkLeaseAndCommand(tx, {
        revisionId: revision.id,
        actorUserId: input.actorUserId,
        leaseToken: input.leaseToken,
        clientCommandId: input.clientCommandId,
        commandType: 'update_boundary',
        requestPayload: {
          concurrencyVersion: input.concurrencyVersion,
          editingScale: input.editingScale,
          vertices: input.vertices,
        },
      });

      if (check.isReplay) {
        return check.response as FloorPlanRevisionView;
      }

      if (revision.concurrencyVersion !== input.concurrencyVersion) {
        throw new FloorPlanError('concurrency_conflict', [], { currentConcurrencyVersion: revision.concurrencyVersion });
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

      const placements = await this.listPlacementsInternal(tx, revision.id);

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

      const result = toRevisionView(updated[0]!, normalizedVertices, placements);
      await check.recordSuccess(200, result);
      return result;
    });
  }

  async updateRevisionScale(input: UpdateScaleInput): Promise<FloorPlanRevisionView> {
    if (!isPermittedScale(input.editingScale)) {
      throw new FloorPlanError('invalid_editing_scale');
    }

    return this.db.transaction(async (tx) => {
      await this.requireActiveFloor(tx, input.floorId);
      const planRows = await tx
        .select()
        .from(floorPlans)
        .where(eq(floorPlans.floorId, input.floorId));
      const plan = planRows[0];
      if (!plan) throw new FloorPlanError('floor_plan_not_found');
      const revision = await this.requireDraftRevision(tx, input.floorId, input.revisionId);

      const check = await this.checkLeaseAndCommand(tx, {
        revisionId: revision.id,
        actorUserId: input.actorUserId,
        leaseToken: input.leaseToken,
        clientCommandId: input.clientCommandId,
        commandType: 'update_scale',
        requestPayload: {
          concurrencyVersion: input.concurrencyVersion,
          editingScale: input.editingScale,
        },
      });

      if (check.isReplay) {
        return check.response as FloorPlanRevisionView;
      }

      if (revision.concurrencyVersion !== input.concurrencyVersion) {
        throw new FloorPlanError('concurrency_conflict', [], { currentConcurrencyVersion: revision.concurrencyVersion });
      }

      const boundary = await this.fetchBoundary(tx, revision.id);
      const placements = await this.listPlacementsInternal(tx, revision.id);

      const updated = await tx
        .update(floorPlanRevisions)
        .set({
          concurrencyVersion: revision.concurrencyVersion + 1,
          editingScale: input.editingScale,
          updatedAt: new Date(),
        })
        .where(eq(floorPlanRevisions.id, revision.id))
        .returning();

      const result = toRevisionView(updated[0]!, boundary, placements);
      await check.recordSuccess(200, result);
      return result;
    });
  }

  private async requireActiveFloor(tx: NodePgDatabase, floorId: string): Promise<void> {
    const rows = await tx
      .select({
        id: floors.id,
        archivedAt: floors.archivedAt,
        buildingArchivedAt: buildings.archivedAt,
        siteArchivedAt: sites.archivedAt,
      })
      .from(floors)
      .innerJoin(buildings, eq(floors.buildingId, buildings.id))
      .innerJoin(sites, eq(buildings.siteId, sites.id))
      .where(eq(floors.id, floorId));
    const floor = rows[0];
    if (!floor) {
      throw new FloorPlanError('floor_not_found');
    }
    if (floor.archivedAt) {
      throw new FloorPlanError('floor_archived');
    }
    if (floor.siteArchivedAt) {
      throw new FloorPlanError('site_archived');
    }
    if (floor.buildingArchivedAt) {
      throw new FloorPlanError('building_archived');
    }
  }

  async placeElement(input: PlaceElementInput): Promise<PlacedElementView> {
    const rotationDegrees = input.rotationDegrees ?? 0;
    if (!Number.isInteger(input.positionX) || !Number.isInteger(input.positionY)) {
      throw new FloorPlanError('invalid_coordinates');
    }
    if (![0, 90, 180, 270].includes(rotationDegrees)) {
      throw new FloorPlanError('invalid_rotation');
    }

    return this.db.transaction(async (tx) => {
      await this.requireActiveFloor(tx, input.floorId);
      const planRows = await tx
        .select()
        .from(floorPlans)
        .where(eq(floorPlans.floorId, input.floorId));
      const plan = planRows[0];
      if (!plan) throw new FloorPlanError('floor_plan_not_found');
      const revision = await this.requireDraftRevision(tx, input.floorId, input.revisionId);

      const check = await this.checkLeaseAndCommand(tx, {
        revisionId: revision.id,
        actorUserId: input.actorUserId,
        leaseToken: input.leaseToken,
        clientCommandId: input.clientCommandId,
        commandType: 'place_element',
        requestPayload: {
          templateRevisionId: input.templateRevisionId,
          positionX: input.positionX,
          positionY: input.positionY,
          rotationDegrees,
          label: input.label,
        },
      });

      if (check.isReplay) {
        return check.response as PlacedElementView;
      }

      if (input.concurrencyVersion !== undefined && revision.concurrencyVersion !== input.concurrencyVersion) {
        throw new FloorPlanError('concurrency_conflict', [], { currentConcurrencyVersion: revision.concurrencyVersion });
      }

      const boundary = await this.fetchBoundary(tx, revision.id);
      if (boundary.length < 4) {
        throw new FloorPlanError('outside_boundary');
      }

      const tmplRevRows = await tx
        .select({
          id: elementTemplateRevisions.id,
          templateId: elementTemplateRevisions.elementTemplateId,
          revisionNumber: elementTemplateRevisions.revisionNumber,
          assignable: elementTemplateRevisions.assignable,
          spatialClass: elementTemplateRevisions.spatialClass,
          borderColor: elementTemplateRevisions.borderColor,
          fillColor: elementTemplateRevisions.fillColor,
          templateCode: elementTemplates.code,
          templateName: elementTemplates.name,
          currentRevisionId: elementTemplates.currentRevisionId,
          templateArchivedAt: elementTemplates.archivedAt,
        })
        .from(elementTemplateRevisions)
        .innerJoin(elementTemplates, eq(elementTemplateRevisions.elementTemplateId, elementTemplates.id))
        .where(eq(elementTemplateRevisions.id, input.templateRevisionId));
      const tmplRev = tmplRevRows[0];
      if (!tmplRev) throw new FloorPlanError('template_revision_not_found');
      if (tmplRev.templateArchivedAt) throw new FloorPlanError('template_archived');
      if (tmplRev.currentRevisionId !== tmplRev.id) {
        throw new FloorPlanError('template_revision_not_current');
      }

      const localVertRows = await tx
        .select({ x: elementTemplateRevisionVertices.x, y: elementTemplateRevisionVertices.y })
        .from(elementTemplateRevisionVertices)
        .where(eq(elementTemplateRevisionVertices.elementTemplateRevisionId, tmplRev.id))
        .orderBy(asc(elementTemplateRevisionVertices.sequence));
      if (localVertRows.length < 4) {
        throw new FloorPlanError('invalid_geometry');
      }

      const transformed = transformVertices(
        localVertRows,
        { x: input.positionX, y: input.positionY },
        rotationDegrees,
      );

      if (!isPolygonInsideBoundary(transformed, boundary)) {
        throw new FloorPlanError('outside_boundary');
      }

      const existingPlacements = await this.listPlacementsInternal(tx, revision.id);
      const cleanLabel = input.label?.trim() || null;
      if (cleanLabel) {
        if (existingPlacements.some((p) => p.label && p.label.toLowerCase() === cleanLabel.toLowerCase())) {
          throw new FloorPlanError('duplicate_label');
        }
      }

      if (
        checkSpatialCollision(
          { spatialClass: tmplRev.spatialClass as SpatialClass, vertices: transformed },
          existingPlacements,
        )
      ) {
        throw new FloorPlanError('placement_collision');
      }

      const insertedIdentity = await tx
        .insert(placementIdentities)
        .values({ floorPlanId: plan.id })
        .returning();
      const identity = insertedIdentity[0]!;

      const insertedPlaced = await tx
        .insert(placedElements)
        .values({
          floorPlanRevisionId: revision.id,
          placementIdentityId: identity.id,
          elementTemplateRevisionId: tmplRev.id,
          positionX: input.positionX,
          positionY: input.positionY,
          rotationDegrees,
          label: cleanLabel,
        })
        .returning();
      const placed = insertedPlaced[0]!;

      await tx
        .update(floorPlanRevisions)
        .set({
          concurrencyVersion: revision.concurrencyVersion + 1,
          updatedAt: new Date(),
        })
        .where(eq(floorPlanRevisions.id, revision.id));

      const result = {
        id: placed.id,
        floorPlanRevisionId: revision.id,
        placementIdentityId: identity.id,
        elementTemplateRevisionId: tmplRev.id,
        templateId: tmplRev.templateId,
        templateCode: tmplRev.templateCode,
        templateName: tmplRev.templateName,
        templateRevisionNumber: tmplRev.revisionNumber,
        assignable: tmplRev.assignable,
        spatialClass: tmplRev.spatialClass as 'PHYSICAL' | 'ZONE' | 'OBSTACLE',
        borderColor: tmplRev.borderColor,
        fillColor: tmplRev.fillColor,
        positionX: placed.positionX,
        positionY: placed.positionY,
        rotationDegrees: placed.rotationDegrees,
        label: placed.label,
        vertices: transformed,
        localVertices: localVertRows,
        createdAt: placed.createdAt.toISOString(),
        updatedAt: placed.updatedAt.toISOString(),
      };
      await check.recordSuccess(201, result);
      return result;
    });
  }

  async updatePlacement(input: UpdatePlacementInput): Promise<PlacedElementView> {
    if (input.positionX !== undefined && !Number.isInteger(input.positionX)) {
      throw new FloorPlanError('invalid_coordinates');
    }
    if (input.positionY !== undefined && !Number.isInteger(input.positionY)) {
      throw new FloorPlanError('invalid_coordinates');
    }
    if (input.rotationDegrees !== undefined && ![0, 90, 180, 270].includes(input.rotationDegrees)) {
      throw new FloorPlanError('invalid_rotation');
    }

    return this.db.transaction(async (tx) => {
      await this.requireActiveFloor(tx, input.floorId);
      const planRows = await tx
        .select()
        .from(floorPlans)
        .where(eq(floorPlans.floorId, input.floorId));
      const plan = planRows[0];
      if (!plan) throw new FloorPlanError('floor_plan_not_found');
      const revision = await this.requireDraftRevision(tx, input.floorId, input.revisionId);

      const check = await this.checkLeaseAndCommand(tx, {
        revisionId: revision.id,
        actorUserId: input.actorUserId,
        leaseToken: input.leaseToken,
        clientCommandId: input.clientCommandId,
        commandType: 'update_placement',
        requestPayload: {
          placementId: input.placementId,
          concurrencyVersion: input.concurrencyVersion,
          positionX: input.positionX,
          positionY: input.positionY,
          rotationDegrees: input.rotationDegrees,
          label: input.label,
        },
      });

      if (check.isReplay) {
        return check.response as PlacedElementView;
      }

      if (input.concurrencyVersion !== undefined && revision.concurrencyVersion !== input.concurrencyVersion) {
        throw new FloorPlanError('concurrency_conflict', [], { currentConcurrencyVersion: revision.concurrencyVersion });
      }

      if (input.concurrencyVersion !== undefined && revision.concurrencyVersion !== input.concurrencyVersion) {
        throw new FloorPlanError('concurrency_conflict', [], { currentConcurrencyVersion: revision.concurrencyVersion });
      }

      const placedRows = await tx
        .select({
          id: placedElements.id,
          floorPlanRevisionId: placedElements.floorPlanRevisionId,
          placementIdentityId: placedElements.placementIdentityId,
          elementTemplateRevisionId: placedElements.elementTemplateRevisionId,
          positionX: placedElements.positionX,
          positionY: placedElements.positionY,
          rotationDegrees: placedElements.rotationDegrees,
          label: placedElements.label,
          createdAt: placedElements.createdAt,
          templateId: elementTemplates.id,
          templateCode: elementTemplates.code,
          templateName: elementTemplates.name,
          templateRevisionNumber: elementTemplateRevisions.revisionNumber,
          assignable: elementTemplateRevisions.assignable,
          spatialClass: elementTemplateRevisions.spatialClass,
          borderColor: elementTemplateRevisions.borderColor,
          fillColor: elementTemplateRevisions.fillColor,
        })
        .from(placedElements)
        .innerJoin(
          elementTemplateRevisions,
          eq(placedElements.elementTemplateRevisionId, elementTemplateRevisions.id),
        )
        .innerJoin(
          elementTemplates,
          eq(elementTemplateRevisions.elementTemplateId, elementTemplates.id),
        )
        .where(
          and(
            eq(placedElements.id, input.placementId),
            eq(placedElements.floorPlanRevisionId, revision.id),
          ),
        );

      const target = placedRows[0];
      if (!target) throw new FloorPlanError('placement_not_found');

      const newPosX = input.positionX !== undefined ? input.positionX : target.positionX;
      const newPosY = input.positionY !== undefined ? input.positionY : target.positionY;
      const newRot = input.rotationDegrees !== undefined ? input.rotationDegrees : target.rotationDegrees;
      const cleanLabel = input.label !== undefined ? (input.label?.trim() || null) : target.label;

      const boundary = await this.fetchBoundary(tx, revision.id);
      if (boundary.length < 4) {
        throw new FloorPlanError('outside_boundary');
      }

      const localVertRows = await tx
        .select({ x: elementTemplateRevisionVertices.x, y: elementTemplateRevisionVertices.y })
        .from(elementTemplateRevisionVertices)
        .where(eq(elementTemplateRevisionVertices.elementTemplateRevisionId, target.elementTemplateRevisionId))
        .orderBy(asc(elementTemplateRevisionVertices.sequence));

      const transformed = transformVertices(
        localVertRows,
        { x: newPosX, y: newPosY },
        newRot,
      );

      if (!isPolygonInsideBoundary(transformed, boundary)) {
        throw new FloorPlanError('outside_boundary');
      }

      const existingPlacements = await this.listPlacementsInternal(tx, revision.id);
      if (cleanLabel) {
        if (
          existingPlacements.some(
            (p) =>
              p.id !== target.id &&
              p.label &&
              p.label.toLowerCase() === cleanLabel.toLowerCase(),
          )
        ) {
          throw new FloorPlanError('duplicate_label');
        }
      }

      const otherPlacements = existingPlacements.filter((p) => p.id !== target.id);
      if (
        checkSpatialCollision(
          { spatialClass: target.spatialClass as SpatialClass, vertices: transformed },
          otherPlacements,
        )
      ) {
        throw new FloorPlanError('placement_collision');
      }

      const updatedPlaced = await tx
        .update(placedElements)
        .set({
          positionX: newPosX,
          positionY: newPosY,
          rotationDegrees: newRot,
          label: cleanLabel,
          updatedAt: new Date(),
        })
        .where(eq(placedElements.id, target.id))
        .returning();
      const placed = updatedPlaced[0]!;

      await tx
        .update(floorPlanRevisions)
        .set({
          concurrencyVersion: revision.concurrencyVersion + 1,
          updatedAt: new Date(),
        })
        .where(eq(floorPlanRevisions.id, revision.id));

      const result = {
        id: placed.id,
        floorPlanRevisionId: revision.id,
        placementIdentityId: target.placementIdentityId,
        elementTemplateRevisionId: target.elementTemplateRevisionId,
        templateId: target.templateId,
        templateCode: target.templateCode,
        templateName: target.templateName,
        templateRevisionNumber: target.templateRevisionNumber,
        assignable: target.assignable,
        spatialClass: target.spatialClass as 'PHYSICAL' | 'ZONE' | 'OBSTACLE',
        borderColor: target.borderColor,
        fillColor: target.fillColor,
        positionX: placed.positionX,
        positionY: placed.positionY,
        rotationDegrees: placed.rotationDegrees,
        label: placed.label,
        vertices: transformed,
        localVertices: localVertRows,
        createdAt: target.createdAt.toISOString(),
        updatedAt: placed.updatedAt.toISOString(),
      };
      await check.recordSuccess(200, result);
      return result;
    });
  }

  async deletePlacement(
    input: DeletePlacementInput,
  ): Promise<{ ok: true; concurrencyVersion: number }> {
    return this.db.transaction(async (tx) => {
      await this.requireActiveFloor(tx, input.floorId);
      const planRows = await tx
        .select()
        .from(floorPlans)
        .where(eq(floorPlans.floorId, input.floorId));
      const plan = planRows[0];
      if (!plan) throw new FloorPlanError('floor_plan_not_found');
      const revision = await this.requireDraftRevision(tx, input.floorId, input.revisionId);

      const check = await this.checkLeaseAndCommand(tx, {
        revisionId: revision.id,
        actorUserId: input.actorUserId,
        leaseToken: input.leaseToken,
        clientCommandId: input.clientCommandId,
        commandType: 'delete_placement',
        requestPayload: {
          placementId: input.placementId,
          concurrencyVersion: input.concurrencyVersion,
        },
      });

      if (check.isReplay) {
        return check.response as { ok: true; concurrencyVersion: number };
      }

      if (input.concurrencyVersion !== undefined && revision.concurrencyVersion !== input.concurrencyVersion) {
        throw new FloorPlanError('concurrency_conflict', [], { currentConcurrencyVersion: revision.concurrencyVersion });
      }

      const placedRows = await tx
        .select({ id: placedElements.id })
        .from(placedElements)
        .where(
          and(
            eq(placedElements.id, input.placementId),
            eq(placedElements.floorPlanRevisionId, revision.id),
          ),
        );
      if (placedRows.length === 0) {
        throw new FloorPlanError('placement_not_found');
      }

      // Delete only the placed_elements row on this revision (preserving placement_identities)
      await tx
        .delete(placedElements)
        .where(
          and(
            eq(placedElements.id, input.placementId),
            eq(placedElements.floorPlanRevisionId, revision.id),
          ),
        );

      const nextConcurrency = revision.concurrencyVersion + 1;
      await tx
        .update(floorPlanRevisions)
        .set({
          concurrencyVersion: nextConcurrency,
          updatedAt: new Date(),
        })
        .where(eq(floorPlanRevisions.id, revision.id));

      const result = { ok: true as const, concurrencyVersion: nextConcurrency };
      await check.recordSuccess(200, result);
      return result;
    });
  }

  async listPlacements(floorId: string, revisionId: string): Promise<PlacedElementView[]> {
    return this.db.transaction(async (tx) => {
      const planRows = await tx
        .select()
        .from(floorPlans)
        .where(eq(floorPlans.floorId, floorId));
      const plan = planRows[0];
      if (!plan) throw new FloorPlanError('floor_plan_not_found');

      const revRows = await tx
        .select()
        .from(floorPlanRevisions)
        .where(
          and(
            eq(floorPlanRevisions.id, revisionId),
            eq(floorPlanRevisions.floorPlanId, plan.id),
          ),
        );
      if (revRows.length === 0) throw new FloorPlanError('revision_not_found');

      return this.listPlacementsInternal(tx, revisionId);
    });
  }

  private async listPlacementsInternal(
    tx: NodePgDatabase,
    revisionId: string,
  ): Promise<PlacedElementView[]> {
    const rows = await tx
      .select({
        id: placedElements.id,
        floorPlanRevisionId: placedElements.floorPlanRevisionId,
        placementIdentityId: placedElements.placementIdentityId,
        elementTemplateRevisionId: placedElements.elementTemplateRevisionId,
        positionX: placedElements.positionX,
        positionY: placedElements.positionY,
        rotationDegrees: placedElements.rotationDegrees,
        label: placedElements.label,
        createdAt: placedElements.createdAt,
        updatedAt: placedElements.updatedAt,
        templateId: elementTemplates.id,
        templateCode: elementTemplates.code,
        templateName: elementTemplates.name,
        templateRevisionNumber: elementTemplateRevisions.revisionNumber,
        assignable: elementTemplateRevisions.assignable,
        spatialClass: elementTemplateRevisions.spatialClass,
        borderColor: elementTemplateRevisions.borderColor,
        fillColor: elementTemplateRevisions.fillColor,
      })
      .from(placedElements)
      .innerJoin(
        elementTemplateRevisions,
        eq(placedElements.elementTemplateRevisionId, elementTemplateRevisions.id),
      )
      .innerJoin(
        elementTemplates,
        eq(elementTemplateRevisions.elementTemplateId, elementTemplates.id),
      )
      .where(eq(placedElements.floorPlanRevisionId, revisionId))
      .orderBy(asc(placedElements.createdAt));

    if (rows.length === 0) {
      return [];
    }

    const templateRevIds = [...new Set(rows.map((r) => r.elementTemplateRevisionId))];
    const verticesByRevId = new Map<string, Vertex[]>();
    for (const revId of templateRevIds) {
      const vRows = await tx
        .select({
          x: elementTemplateRevisionVertices.x,
          y: elementTemplateRevisionVertices.y,
        })
        .from(elementTemplateRevisionVertices)
        .where(eq(elementTemplateRevisionVertices.elementTemplateRevisionId, revId))
        .orderBy(asc(elementTemplateRevisionVertices.sequence));
      verticesByRevId.set(revId, vRows);
    }

    return rows.map((row) => {
      const localVertices = verticesByRevId.get(row.elementTemplateRevisionId) ?? [];
      const vertices = transformVertices(
        localVertices,
        { x: row.positionX, y: row.positionY },
        row.rotationDegrees,
      );
      return {
        id: row.id,
        floorPlanRevisionId: row.floorPlanRevisionId,
        placementIdentityId: row.placementIdentityId,
        elementTemplateRevisionId: row.elementTemplateRevisionId,
        templateId: row.templateId,
        templateCode: row.templateCode,
        templateName: row.templateName,
        templateRevisionNumber: row.templateRevisionNumber,
        assignable: row.assignable,
        spatialClass: row.spatialClass as 'PHYSICAL' | 'ZONE' | 'OBSTACLE',
        borderColor: row.borderColor,
        fillColor: row.fillColor,
        positionX: row.positionX,
        positionY: row.positionY,
        rotationDegrees: row.rotationDegrees,
        label: row.label,
        vertices,
        localVertices,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  }


  private async validateDraftForPublicationInternal(
    tx: NodePgDatabase,
    params: {
      floor: typeof floors.$inferSelect;
      revision: typeof floorPlanRevisions.$inferSelect;
    },
  ): Promise<PublicationValidationResult> {
    const { floor, revision } = params;
    const errors: PublicationValidationError[] = [];
    const warnings: PublicationValidationError[] = [];

    // Lifecycle Preconditions
    if (floor.archivedAt !== null) {
      errors.push({
        code: 'floor_archived',
        category: 'LIFECYCLE',
        entityType: 'FLOOR',
        entityId: floor.id,
        message: `Floor "${floor.name}" (${floor.code}) is archived.`,
        correctiveAction: 'Restore the floor before attempting publication.',
      });
    }

    if (revision.lifecycleState !== 'DRAFT') {
      errors.push({
        code: 'revision_not_draft',
        category: 'LIFECYCLE',
        entityType: 'REVISION',
        entityId: revision.id,
        message: `Revision ${revision.revisionNumber} is in ${revision.lifecycleState} state and cannot be published.`,
        correctiveAction: 'Only Draft revisions can be published. Create a new draft if further edits are required.',
      });
    }

    // Floor Boundary structure
    const boundaryVertices = await this.fetchBoundary(tx, revision.id);
    let boundaryIsValid = false;

    if (boundaryVertices.length === 0) {
      errors.push({
        code: 'missing_boundary',
        category: 'BOUNDARY',
        entityType: 'BOUNDARY',
        entityId: revision.id,
        message: 'The floor boundary is missing. A closed orthogonal boundary is required for publication.',
        correctiveAction: 'Use the boundary editor to define and save a closed orthogonal floor boundary.',
      });
    } else {
      const diagnostics = diagnoseOrthogonalPolygon(boundaryVertices);
      if (diagnostics.length > 0) {
        for (const diag of diagnostics) {
          errors.push({
            code: diag.code,
            category: 'BOUNDARY',
            entityType: 'BOUNDARY',
            entityId: revision.id,
            vertexIndex: diag.vertexIndex,
            edgeIndex: diag.edgeIndex,
            message: `Boundary geometry error: ${diag.message}`,
            correctiveAction: 'Adjust the boundary vertices to ensure all edges are orthogonal, non-zero length, and non-self-intersecting in counter-clockwise order.',
          });
        }
      } else {
        boundaryIsValid = true;
      }
    }

    // Placed Elements, Template references, containment & collision
    const placements = await this.listPlacementsInternal(tx, revision.id);

    for (const p of placements) {
      // Template existence and active state check
      const tmpl = await tx
        .select({
          id: elementTemplates.id,
          code: elementTemplates.code,
          name: elementTemplates.name,
          archivedAt: elementTemplates.archivedAt,
        })
        .from(elementTemplates)
        .where(eq(elementTemplates.id, p.templateId));

      if (!tmpl[0]) {
        errors.push({
          code: 'template_revision_not_found',
          category: 'TEMPLATE',
          entityType: 'PLACEMENT',
          entityId: p.id,
          message: `Placement references template "${p.templateName}" which was not found.`,
          correctiveAction: 'Reassign or remove this placement from the draft.',
        });
      } else if (tmpl[0].archivedAt !== null) {
        errors.push({
          code: 'template_archived',
          category: 'TEMPLATE',
          entityType: 'PLACEMENT',
          entityId: p.id,
          details: { templateId: tmpl[0].id, templateCode: tmpl[0].code },
          message: `Placement references archived element template "${tmpl[0].name}" (${tmpl[0].code}).`,
          correctiveAction: 'Restore the template in the Element Catalog or remove this placement from the draft.',
        });
      }

      // Integer coordinate check
      if (!Number.isInteger(p.positionX) || !Number.isInteger(p.positionY)) {
        errors.push({
          code: 'invalid_vertex_coordinates',
          category: 'CONTAINMENT',
          entityType: 'PLACEMENT',
          entityId: p.id,
          message: `Placement "${p.label || p.templateName}" has non-integer coordinates (${p.positionX}, ${p.positionY}).`,
          correctiveAction: 'Snap the placement to integer coordinates aligned with the editing scale.',
        });
      }

      // Boundary containment check
      if (boundaryIsValid) {
        if (!isPolygonInsideBoundary(p.vertices, boundaryVertices)) {
          errors.push({
            code: 'outside_boundary',
            category: 'CONTAINMENT',
            entityType: 'PLACEMENT',
            entityId: p.id,
            message: `Placement "${p.label || p.templateName}" extends outside the floor boundary.`,
            correctiveAction: 'Move or rotate the space so it is completely contained within the floor boundary.',
          });
        }
      }
    }

    // Spatial collisions between placements
    for (let i = 0; i < placements.length; i++) {
      const pA = placements[i]!;
      for (let j = i + 1; j < placements.length; j++) {
        const pB = placements[j]!;
        if (doSpatialClassesCollide(pA.spatialClass, pB.spatialClass)) {
          if (doPolygonsOverlap(pA.vertices, pB.vertices)) {
            errors.push({
              code: 'placement_collision',
              category: 'COLLISION',
              entityType: 'PLACEMENT',
              entityId: pA.id,
              conflictingEntityId: pB.id,
              message: `Placement "${pA.label || pA.templateName}" collides with "${pB.label || pB.templateName}".`,
              correctiveAction: 'Reposition spaces so that physical elements and obstacles do not intersect each other.',
            });
          }
        }
      }
    }

    // Label uniqueness and validity
    const labelsSeen = new Map<string, string>();
    for (const p of placements) {
      if (p.label !== null) {
        const trimmed = p.label.trim();
        if (trimmed.length === 0) {
          errors.push({
            code: 'invalid_label',
            category: 'LABEL',
            entityType: 'PLACEMENT',
            entityId: p.id,
            message: `Placement has an empty or whitespace-only label.`,
            correctiveAction: 'Provide a meaningful non-empty label or remove the label.',
          });
        } else {
          const normalized = trimmed.toLowerCase();
          const existingId = labelsSeen.get(normalized);
          if (existingId) {
            errors.push({
              code: 'duplicate_label',
              category: 'LABEL',
              entityType: 'PLACEMENT',
              entityId: p.id,
              conflictingEntityId: existingId,
              message: `Duplicate label "${p.label}" is used on multiple placements.`,
              correctiveAction: 'Change the label so that each labeled space has a unique identifier.',
            });
          } else {
            labelsSeen.set(normalized, p.id);
          }
        }
      }
    }

    // Assignment Reconciliation: verify that active & future assignments carry forward safely
    const now = new Date();
    const activeAssignments = await tx
      .select({
        id: assignments.id,
        placementIdentityId: assignments.placementIdentityId,
        employeeId: assignments.employeeId,
        employeeName: employees.fullName,
        employeeCode: employees.employeeId,
        employeeActive: employees.active,
        startedAt: assignments.startedAt,
        endedAt: assignments.endedAt,
      })
      .from(assignments)
      .innerJoin(employees, eq(employees.id, assignments.employeeId))
      .innerJoin(
        placementIdentities,
        eq(placementIdentities.id, assignments.placementIdentityId),
      )
      .where(
        and(
          eq(placementIdentities.floorPlanId, revision.floorPlanId),
          sql`(${assignments.endedAt} IS NULL OR ${assignments.endedAt} > ${now})`,
        ),
      );

    const assignmentsByPlacementId = new Map<string, typeof activeAssignments>();
    for (const a of activeAssignments) {
      const list = assignmentsByPlacementId.get(a.placementIdentityId) ?? [];
      list.push(a);
      assignmentsByPlacementId.set(a.placementIdentityId, list);
    }

    for (const [placementIdentityId, assignedList] of assignmentsByPlacementId.entries()) {
      const draftPlacement = placements.find(
        (p) => p.placementIdentityId === placementIdentityId,
      );

      if (!draftPlacement) {
        for (const a of assignedList) {
          errors.push({
            code: 'assignment_target_removed',
            category: 'ASSIGNMENT',
            entityType: 'PLACEMENT',
            entityId: placementIdentityId,
            message: `Active or future assignment for ${a.employeeName} (${a.employeeCode}) cannot be carried forward: the assigned space was removed in this draft revision.`,
            correctiveAction:
              'Reassign or end the employee assignment before publishing, or restore the space in the draft editor.',
            details: {
              assignmentId: a.id,
              employeeId: a.employeeId,
              placementIdentityId,
            },
          });
        }
        continue;
      }

      if (!draftPlacement.assignable || draftPlacement.spatialClass !== 'PHYSICAL') {
        for (const a of assignedList) {
          errors.push({
            code: 'assignment_target_not_assignable',
            category: 'ASSIGNMENT',
            entityType: 'PLACEMENT',
            entityId: draftPlacement.id,
            message: `Active or future assignment for ${a.employeeName} (${a.employeeCode}) cannot be carried forward: space "${draftPlacement.label || 'unlabeled'}" is not an assignable physical space.`,
            correctiveAction:
              'Assign an assignable physical template to this space, or reassign/end the assignment before publishing.',
            details: {
              assignmentId: a.id,
              employeeId: a.employeeId,
              placementIdentityId,
            },
          });
        }
      }

      for (const a of assignedList) {
        if (!a.employeeActive) {
          errors.push({
            code: 'assignment_target_invalid',
            category: 'ASSIGNMENT',
            entityType: 'ASSIGNMENT',
            entityId: a.id,
            message: `Active or future assignment for inactive employee ${a.employeeName} (${a.employeeCode}) cannot be reconciled.`,
            correctiveAction:
              'End or remove the assignment for the inactive employee before publishing.',
            details: {
              assignmentId: a.id,
              employeeId: a.employeeId,
              placementIdentityId,
            },
          });
        }
      }

      // Check for overlapping assignment periods on this placement target
      if (assignedList.length > 1) {
        for (let i = 0; i < assignedList.length; i++) {
          const a1 = assignedList[i]!;
          const a1Start = a1.startedAt.getTime();
          const a1End = a1.endedAt ? a1.endedAt.getTime() : Infinity;
          for (let j = i + 1; j < assignedList.length; j++) {
            const a2 = assignedList[j]!;
            const a2Start = a2.startedAt.getTime();
            const a2End = a2.endedAt ? a2.endedAt.getTime() : Infinity;
            if (a1Start < a2End && a1End > a2Start) {
              errors.push({
                code: 'assignment_target_conflict',
                category: 'ASSIGNMENT',
                entityType: 'PLACEMENT',
                entityId: draftPlacement.id,
                message: `Space "${draftPlacement.label || 'unlabeled'}" has conflicting overlapping assignments for ${a1.employeeName} and ${a2.employeeName}.`,
                correctiveAction:
                  'Adjust assignment dates so they do not overlap before publishing.',
                details: {
                  assignmentIdA: a1.id,
                  assignmentIdB: a2.id,
                  placementIdentityId,
                },
              });
            }
          }
        }
      }
    }

    const isValid = errors.length === 0;
    const ready = isValid;
    const summary = ready
      ? 'Draft revision is valid and ready for publication.'
      : `Validation found ${errors.length} blocker(s) preventing publication.`;

    return {
      isValid,
      ready,
      floorId: floor.id,
      revisionId: revision.id,
      concurrencyVersion: revision.concurrencyVersion,
      summary,
      errors,
      warnings,
    };
  }

  async validateDraftForPublication(
    input: ValidateDraftInput,
  ): Promise<PublicationValidationResult> {
    return this.db.transaction(async (tx) => {
      // 1. Verify Floor exists
      const floorRows = await tx
        .select()
        .from(floors)
        .where(eq(floors.id, input.floorId));
      const floor = floorRows[0];
      if (!floor) {
        throw new FloorPlanError('floor_not_found');
      }

      // 2. Verify Floor Plan exists
      const planRows = await tx
        .select()
        .from(floorPlans)
        .where(eq(floorPlans.floorId, input.floorId));
      const plan = planRows[0];
      if (!plan) {
        throw new FloorPlanError('floor_plan_not_found');
      }

      // 3. Verify Revision exists
      const revRows = await tx
        .select()
        .from(floorPlanRevisions)
        .where(
          and(
            eq(floorPlanRevisions.id, input.revisionId),
            eq(floorPlanRevisions.floorPlanId, plan.id),
          ),
        );
      const revision = revRows[0];
      if (!revision) {
        throw new FloorPlanError('revision_not_found');
      }

      // 4. Stale concurrency check (if requested)
      if (
        input.concurrencyVersion !== undefined &&
        revision.concurrencyVersion !== input.concurrencyVersion
      ) {
        throw new FloorPlanError('concurrency_conflict', [], {
          currentConcurrencyVersion: revision.concurrencyVersion,
        });
      }

      return await this.validateDraftForPublicationInternal(tx, { floor, revision });
    });
  }

  async publishRevision(input: PublishRevisionInput): Promise<FloorPlanRevisionView> {
    return await this.db.transaction(async (tx) => {
      // 1. Verify Floor exists and is not archived
      const floorRows = await tx
        .select()
        .from(floors)
        .where(eq(floors.id, input.floorId));
      const floor = floorRows[0];
      if (!floor) {
        throw new FloorPlanError('floor_not_found');
      }
      if (floor.archivedAt !== null) {
        throw new FloorPlanError('floor_archived');
      }

      // 2. Lock Floor Plan row for update
      const planRows = await tx
        .select()
        .from(floorPlans)
        .where(eq(floorPlans.floorId, input.floorId))
        .for('update');
      const plan = planRows[0];
      if (!plan) {
        throw new FloorPlanError('floor_plan_not_found');
      }

      // 3. Lock target revision row for update
      const revRows = await tx
        .select()
        .from(floorPlanRevisions)
        .where(
          and(
            eq(floorPlanRevisions.id, input.revisionId),
            eq(floorPlanRevisions.floorPlanId, plan.id),
          ),
        )
        .for('update');
      const revision = revRows[0];
      if (!revision) {
        throw new FloorPlanError('revision_not_found');
      }

      // 4. Check lease and clientCommandId
      const commandCheck = await this.checkLeaseAndCommand(tx, {
        revisionId: revision.id,
        actorUserId: input.actorUserId,
        leaseToken: input.leaseToken,
        clientCommandId: input.clientCommandId,
        commandType: 'PUBLISH',
        requestPayload: {
          floorId: input.floorId,
          revisionId: input.revisionId,
          concurrencyVersion: input.concurrencyVersion,
        },
      });

      if (commandCheck.isReplay) {
        return commandCheck.response as FloorPlanRevisionView;
      }

      // 5. Idempotent check: if already PUBLISHED, safe retry returns published view
      if (revision.lifecycleState === 'PUBLISHED') {
        const boundary = await this.fetchBoundary(tx, revision.id);
        const placements = await this.listPlacementsInternal(tx, revision.id);
        return toRevisionView(revision, boundary, placements);
      }

      if (revision.lifecycleState !== 'DRAFT') {
        throw new FloorPlanError('revision_not_draft');
      }

      // 6. Concurrency version check
      if (revision.concurrencyVersion !== input.concurrencyVersion) {
        throw new FloorPlanError('concurrency_conflict', [], {
          currentConcurrencyVersion: revision.concurrencyVersion,
        });
      }

      // 7. Authoritative publication validation
      const validation = await this.validateDraftForPublicationInternal(tx, { floor, revision });
      if (!validation.ready || validation.errors.length > 0) {
        throw new FloorPlanError('publication_validation_failed', [], {
          errors: validation.errors,
          validationResult: validation,
        });
      }

      // 8. Lifecycle transition: archive previous Published revision if present
      const priorPublishedRows = await tx
        .select()
        .from(floorPlanRevisions)
        .where(
          and(
            eq(floorPlanRevisions.floorPlanId, plan.id),
            eq(floorPlanRevisions.lifecycleState, 'PUBLISHED'),
          ),
        )
        .for('update');
      const priorPublished = priorPublishedRows[0];

      const now = new Date();

      if (priorPublished) {
        await tx
          .update(floorPlanRevisions)
          .set({
            lifecycleState: 'ARCHIVED',
            updatedAt: now,
          })
          .where(eq(floorPlanRevisions.id, priorPublished.id));
      }

      // 9. Mark Draft as PUBLISHED with incremented concurrency version and publication metadata
      const nextConcurrencyVersion = revision.concurrencyVersion + 1;
      const updatedDraftRows = await tx
        .update(floorPlanRevisions)
        .set({
          lifecycleState: 'PUBLISHED',
          concurrencyVersion: nextConcurrencyVersion,
          publishedByUserId: input.actorUserId,
          publishedAt: now,
          updatedAt: now,
        })
        .where(eq(floorPlanRevisions.id, revision.id))
        .returning();
      const publishedRevision = updatedDraftRows[0]!;

      // 10. Cleanly release editor lease on this revision if one exists
      await tx
        .update(floorPlanEditorLeases)
        .set({ releasedAt: now })
        .where(eq(floorPlanEditorLeases.floorPlanRevisionId, revision.id));

      // 11. Emit audit event
      const userRows = await tx
        .select({ displayName: appUsers.displayName })
        .from(appUsers)
        .where(eq(appUsers.id, input.actorUserId));
      const userDisplayName = userRows[0]?.displayName ?? 'Facilities Admin';

      // Count carried assignments
      const carriedCountQuery = await tx
        .select({ count: sql<number>`count(*)` })
        .from(assignments)
        .innerJoin(placementIdentities, eq(placementIdentities.id, assignments.placementIdentityId))
        .where(
          and(
            eq(placementIdentities.floorPlanId, plan.id),
            sql`(${assignments.endedAt} IS NULL OR ${assignments.endedAt} > ${now})`,
          ),
        );
      const carriedCount = Number(carriedCountQuery[0]?.count ?? 0);
      const carriedText = carriedCount > 0 ? `. Carried forward ${carriedCount} active/future assignment(s).` : '';

      await tx.insert(auditEvents).values({
        actorUserId: input.actorUserId,
        action: 'floor_plan.published',
        targetType: 'FLOOR_PLAN_REVISION',
        targetId: revision.id,
        correlationId: revision.id,
        summary: `User ${userDisplayName} published revision ${revision.revisionNumber} for floor "${floor.name}" (${floor.code})${carriedText}`,
      });

      // 12. Build view and record processed command
      const boundary = await this.fetchBoundary(tx, revision.id);
      const placements = await this.listPlacementsInternal(tx, revision.id);
      const view = toRevisionView(publishedRevision, boundary, placements);

      if (!commandCheck.isReplay) {
        await commandCheck.recordSuccess(200, view);
      }

      return view;
    });
  }

  /**
   * Preview batch labels for selected placements on a Published floor plan revision.
   * Deterministic and purely read-only (does NOT mutate database records).
   */
  async previewBatchLabels(input: PreviewBatchLabelsInput): Promise<PreviewBatchLabelsResult> {
    await this.requireActiveFloor(this.db, input.floorId);
    const revs = await this.db
      .select()
      .from(floorPlanRevisions)
      .where(eq(floorPlanRevisions.id, input.revisionId));
    const revision = revs[0];
    if (!revision) {
      throw new FloorPlanError('revision_not_found');
    }
    if (revision.lifecycleState !== 'PUBLISHED') {
      throw new FloorPlanError('revision_not_published');
    }

    // Fetch all placements on this revision joined with element template revision for spatialClass
    const rows = await this.db
      .select({
        id: placedElements.id,
        placementIdentityId: placedElements.placementIdentityId,
        positionX: placedElements.positionX,
        positionY: placedElements.positionY,
        label: placedElements.label,
        spatialClass: elementTemplateRevisions.spatialClass,
      })
      .from(placedElements)
      .innerJoin(
        elementTemplateRevisions,
        eq(placedElements.elementTemplateRevisionId, elementTemplateRevisions.id),
      )
      .where(eq(placedElements.floorPlanRevisionId, input.revisionId));

    const allPlacements: BatchPlacementInput[] = rows.map((r) => ({
      id: r.id,
      placementIdentityId: r.placementIdentityId,
      positionX: r.positionX,
      positionY: r.positionY,
      spatialClass: r.spatialClass as 'PHYSICAL' | 'ZONE' | 'OBSTACLE',
      currentLabel: r.label,
    }));

    const placementMap = new Map(allPlacements.map((p) => [p.id, p]));
    const selectedPlacements: BatchPlacementInput[] = [];
    const missingOrIneligibleConflicts: LabelConflict[] = [];

    for (const id of input.placementIds) {
      const p = placementMap.get(id);
      if (!p) {
        missingOrIneligibleConflicts.push({
          type: 'ineligible_space',
          placementId: id,
          message: `Placement ${id} was not found on revision ${input.revisionId}.`,
        });
      } else {
        selectedPlacements.push(p);
      }
    }

    // Check stale revision
    const conflicts: LabelConflict[] = [...missingOrIneligibleConflicts];
    if (revision.concurrencyVersion !== input.concurrencyVersion) {
      conflicts.push({
        type: 'stale_revision',
        message: `Revision concurrency version mismatch: expected ${input.concurrencyVersion}, current is ${revision.concurrencyVersion}.`,
      });
    }

    // Order placements
    const ordered = orderPlacements(selectedPlacements, input.ordering, input.placementIds);

    // Generate labels
    const proposedAssignments = generateBatchLabels(ordered, {
      prefix: input.prefix,
      startNumber: input.startNumber,
      width: input.width,
    });

    // Detect other conflicts
    const otherConflicts = detectLabelConflicts({
      selectedPlacements,
      proposedAssignments,
      existingRevisionPlacements: allPlacements,
    });
    conflicts.push(...otherConflicts);

    const canConfirm = conflicts.length === 0;
    const previewToken = canConfirm
      ? computeBatchPreviewToken(input.revisionId, revision.concurrencyVersion, proposedAssignments)
      : '';

    const proposedLabels: ProposedLabelView[] = proposedAssignments.map((a) => {
      const pl = placementMap.get(a.placementId);
      return {
        placementId: a.placementId,
        placementIdentityId: pl?.placementIdentityId ?? '',
        currentLabel: pl?.currentLabel ?? null,
        proposedLabel: a.label,
        positionX: pl?.positionX ?? 0,
        positionY: pl?.positionY ?? 0,
      };
    });

    return {
      ok: true,
      previewToken,
      concurrencyVersion: revision.concurrencyVersion,
      proposedLabels,
      conflicts,
      canConfirm,
    };
  }

  /**
   * Apply accepted preview batch labels transactionally and idempotently.
   */
  async confirmBatchLabels(input: ConfirmBatchLabelsInput): Promise<ConfirmBatchLabelsResult> {
    return await this.db.transaction(async (tx) => {
      // 1. Check idempotency via processedCommands
      const requestPayload = {
        previewToken: input.previewToken,
        concurrencyVersion: input.concurrencyVersion,
        assignments: input.assignments,
      };
      const reqHash = hashPayload(requestPayload);

      const existingCmds = await tx
        .select()
        .from(processedCommands)
        .where(
          and(
            eq(processedCommands.floorPlanRevisionId, input.revisionId),
            eq(processedCommands.clientCommandId, input.clientCommandId),
          ),
        );

      const existingCmd = existingCmds[0];
      if (existingCmd) {
        if (existingCmd.requestHash !== reqHash) {
          throw new FloorPlanError('command_id_payload_mismatch');
        }
        return JSON.parse(existingCmd.responseBody) as ConfirmBatchLabelsResult;
      }

      // 2. Validate floor and revision
      await this.requireActiveFloor(tx, input.floorId);
      const revs = await tx
        .select()
        .from(floorPlanRevisions)
        .where(eq(floorPlanRevisions.id, input.revisionId));
      const revision = revs[0];
      if (!revision) {
        throw new FloorPlanError('revision_not_found');
      }
      if (revision.lifecycleState !== 'PUBLISHED') {
        throw new FloorPlanError('revision_not_published');
      }
      if (revision.concurrencyVersion !== input.concurrencyVersion) {
        throw new FloorPlanError('stale_revision', [], {
          currentConcurrencyVersion: revision.concurrencyVersion,
        });
      }

      // 3. Verify previewToken
      const expectedToken = computeBatchPreviewToken(
        input.revisionId,
        revision.concurrencyVersion,
        input.assignments,
      );
      if (input.previewToken !== expectedToken) {
        throw new FloorPlanError('invalid_preview_token');
      }

      // 4. Validate placements and collisions
      const rows = await tx
        .select({
          id: placedElements.id,
          placementIdentityId: placedElements.placementIdentityId,
          positionX: placedElements.positionX,
          positionY: placedElements.positionY,
          label: placedElements.label,
          spatialClass: elementTemplateRevisions.spatialClass,
        })
        .from(placedElements)
        .innerJoin(
          elementTemplateRevisions,
          eq(placedElements.elementTemplateRevisionId, elementTemplateRevisions.id),
        )
        .where(eq(placedElements.floorPlanRevisionId, input.revisionId));

      const allPlacements: BatchPlacementInput[] = rows.map((r) => ({
        id: r.id,
        placementIdentityId: r.placementIdentityId,
        positionX: r.positionX,
        positionY: r.positionY,
        spatialClass: r.spatialClass as 'PHYSICAL' | 'ZONE' | 'OBSTACLE',
        currentLabel: r.label,
      }));

      const selectedPlacements = input.assignments
        .map((a) => allPlacements.find((p) => p.id === a.placementId))
        .filter((p): p is BatchPlacementInput => Boolean(p));

      if (selectedPlacements.length !== input.assignments.length) {
        throw new FloorPlanError('placement_not_found');
      }

      const conflicts = detectLabelConflicts({
        selectedPlacements,
        proposedAssignments: input.assignments,
        existingRevisionPlacements: allPlacements,
      });
      if (conflicts.length > 0) {
        throw new FloorPlanError('label_collision');
      }

      // 5. Update placement records in this transaction
      for (const assignment of input.assignments) {
        await tx
          .update(placedElements)
          .set({
            label: assignment.label,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(placedElements.id, assignment.placementId),
              eq(placedElements.floorPlanRevisionId, input.revisionId),
            ),
          );
      }

      const nextConcurrencyVersion = revision.concurrencyVersion + 1;
      await tx
        .update(floorPlanRevisions)
        .set({
          concurrencyVersion: nextConcurrencyVersion,
          updatedAt: new Date(),
        })
        .where(eq(floorPlanRevisions.id, revision.id));

      // 6. Audit event
      await tx.insert(auditEvents).values({
        actorUserId: input.actorUserId,
        action: 'batch_label_applied',
        targetType: 'floor_plan_revision',
        targetId: revision.id,
        correlationId: input.clientCommandId,
        summary: `Applied batch labels to ${input.assignments.length} physical spaces on floor ${input.floorId} revision ${revision.revisionNumber}`,
      });

      const response: ConfirmBatchLabelsResult = {
        ok: true,
        revisionId: revision.id,
        updatedCount: input.assignments.length,
        concurrencyVersion: nextConcurrencyVersion,
      };

      // 7. Record processed command for idempotent replay
      await tx.insert(processedCommands).values({
        floorPlanRevisionId: revision.id,
        clientCommandId: input.clientCommandId,
        appUserId: input.actorUserId,
        commandType: 'batch_labels_confirm',
        requestHash: reqHash,
        responseStatus: 200,
        responseBody: JSON.stringify(response),
      });

      return response;
    });
  }
}
