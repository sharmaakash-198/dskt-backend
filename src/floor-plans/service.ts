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
import { and, asc, eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import {
  GeometryValidationError,
  validateOrthogonalPolygon,
  transformVertices,
  isPolygonInsideBoundary,
  checkSpatialCollision,
  type SpatialClass,
  type GeometryDiagnostic,
  type Vertex,
} from '../geometry/orthogonal.js';
import {
  appUsers,
  auditEvents,
  elementTemplateRevisionVertices,
  elementTemplateRevisions,
  elementTemplates,
  floorPlanEditorLeases,
  floorPlanRevisionBoundaryVertices,
  floorPlanRevisions,
  floorPlans,
  floors,
  placedElements,
  placementIdentities,
  processedCommands,
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
  boundary: Vertex[];
  placements: PlacedElementView[];
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
      | 'command_id_payload_mismatch',
    readonly diagnostics: GeometryDiagnostic[] = [],
    readonly details?: Record<string, unknown>,
  ) {
    super(code);
    this.name = 'FloorPlanError';
  }
}

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
      const placements = await this.listPlacementsInternal(this.db, row.id);
      results.push(toRevisionView(row, boundary, placements));
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
    let activePlacements: PlacedElementView[] = [];
    if (active) {
      activeBoundary = await this.fetchBoundary(this.db, active.id);
      activePlacements = await this.listPlacementsInternal(this.db, active.id);
    }

    return {
      floorPlan: toPlanView(plan),
      activeRevision: active ? toRevisionView(active, activeBoundary, activePlacements) : null,
    };
  }

  async getRevision(floorId: string, revisionId: string): Promise<FloorPlanRevisionView> {
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
}
