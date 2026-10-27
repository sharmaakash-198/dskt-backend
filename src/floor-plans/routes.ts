/**
 * Floor Plan and Revision HTTP routes.
 *
 * Implements Tickets 11 & 12:
 * - Create Draft Floor Plan identity and initial revision.
 * - Draw and edit Draft Floor Boundary in integer world coordinates.
 * - Update Editing Scale independently from Viewport/Zoom.
 * - Concurrency protection: rejects non-Draft edits and stale concurrency versions.
 * - Only Facilities Admins can create or edit Draft Floor Plan details.
 */
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import type { LocalAuthProvider } from '../auth/local-provider.js';
import { requireAnyRole, requirePrincipal } from '../auth/permissions.js';
import type { GeometryDiagnostic } from '../geometry/orthogonal.js';
import {
  FloorPlanError,
  FloorPlanService,
  type PublicationValidationError,
} from './service.js';

const unauthorizedResponse = z
  .object({ error: z.literal('unauthorized') })
  .meta({ description: 'Not authenticated or session expired/revoked.' });

const forbiddenResponse = z
  .object({ error: z.literal('forbidden') })
  .meta({ description: 'Authenticated but missing a required application role.' });

const vertexSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
});

const placedElementView = z
  .object({
    id: z.string().uuid(),
    floorPlanRevisionId: z.string().uuid(),
    placementIdentityId: z.string().uuid(),
    elementTemplateRevisionId: z.string().uuid(),
    templateId: z.string().uuid(),
    templateCode: z.string(),
    templateName: z.string(),
    templateRevisionNumber: z.number().int(),
    assignable: z.boolean(),
    spatialClass: z.enum(['PHYSICAL', 'ZONE', 'OBSTACLE']),
    borderColor: z.string(),
    fillColor: z.string(),
    positionX: z.number().int(),
    positionY: z.number().int(),
    rotationDegrees: z.number().int(),
    label: z.string().nullable(),
    vertices: z.array(vertexSchema),
    localVertices: z.array(vertexSchema),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ description: 'Placed element representation on a floor plan revision.' });

const placementsListResponse = z
  .object({
    placements: z.array(placedElementView),
  })
  .meta({ description: 'List of placed elements on a floor plan revision.' });

const floorPlanView = z
  .object({
    id: z.string().uuid(),
    floorId: z.string().uuid(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ description: 'Floor Plan identity projection.' });

const floorPlanRevisionView = z
  .object({
    id: z.string().uuid(),
    floorPlanId: z.string().uuid(),
    revisionNumber: z.number().int(),
    lifecycleState: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']),
    editingScale: z.number().int(),
    concurrencyVersion: z.number().int(),
    publishedByUserId: z.string().uuid().nullable().optional(),
    publishedAt: z.string().nullable().optional(),
    boundary: z.array(vertexSchema).default([]),
    placements: z.array(placedElementView).default([]),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ description: 'Floor Plan Revision projection.' });

const createFloorPlanResponse = z
  .object({
    floorPlan: floorPlanView,
    revision: floorPlanRevisionView,
  })
  .meta({ description: 'Created or replayed Floor Plan identity and draft revision.' });

const floorPlanRevisionDetailResponse = z
  .object({
    revision: floorPlanRevisionView,
  })
  .meta({ description: 'Floor Plan Revision details.' });

const floorPlanRevisionsResponse = z
  .object({
    revisions: z.array(floorPlanRevisionView),
  })
  .meta({ description: 'List of Floor Plan Revisions, or empty if floor has no plan.' });

const floorPlanDetailResponse = z
  .object({
    floorPlan: floorPlanView.nullable(),
    activeRevision: floorPlanRevisionView.nullable(),
    publishedRevision: floorPlanRevisionView.nullable().optional(),
  })
  .meta({ description: 'Floor Plan and its active and published revisions, or nulls if floor has no plan.' });

const publishedFloorPlanResponse = z
  .object({
    floorPlan: floorPlanView,
    revision: floorPlanRevisionView,
  })
  .meta({ description: 'Current Published Floor Plan and revision.' });

const geometryDiagnosticSchema = z.object({
  code: z.string(),
  message: z.string(),
  vertexIndex: z.number().int().optional(),
  edgeIndex: z.number().int().optional(),
});

const publicationValidationErrorSchema = z.object({
  code: z.string(),
  category: z.enum(['BOUNDARY', 'CONTAINMENT', 'COLLISION', 'TEMPLATE', 'LABEL', 'LIFECYCLE']),
  entityType: z.enum(['BOUNDARY', 'PLACEMENT', 'REVISION', 'FLOOR']),
  entityId: z.string(),
  conflictingEntityId: z.string().optional(),
  message: z.string(),
  correctiveAction: z.string(),
  vertexIndex: z.number().int().optional(),
  edgeIndex: z.number().int().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

const badRequestResponse = z.object({
  error: z.string(),
  diagnostics: z.array(geometryDiagnosticSchema).optional(),
  validationErrors: z.array(publicationValidationErrorSchema).optional(),
});

const notFoundResponse = z.object({
  error: z.enum([
    'floor_not_found',
    'floor_plan_not_found',
    'revision_not_found',
    'published_revision_not_found',
    'template_revision_not_found',
    'placement_not_found',
    'lease_not_found',
  ]),
});

const conflictResponse = z.object({
  error: z.enum([
    'floor_archived',
    'building_archived',
    'site_archived',
    'template_archived',
    'floor_plan_already_exists',
    'revision_not_draft',
    'revision_not_published',
    'stale_revision',
    'invalid_preview_token',
    'label_collision',
    'concurrency_conflict',
    'duplicate_label',
    'lease_conflict',
    'lease_invalid_token',
    'lease_expired',
    'command_id_payload_mismatch',
  ]),
  currentConcurrencyVersion: z.number().int().optional(),
});

const labelConflictSchema = z.object({
  type: z.enum(['duplicate', 'collision', 'ineligible_space', 'stale_revision']),
  placementId: z.string().optional(),
  label: z.string().optional(),
  message: z.string(),
});

const proposedLabelViewSchema = z.object({
  placementId: z.string(),
  placementIdentityId: z.string(),
  currentLabel: z.string().nullable(),
  proposedLabel: z.string(),
  positionX: z.number().int(),
  positionY: z.number().int(),
});

const previewBatchLabelsResponseSchema = z.object({
  ok: z.literal(true),
  previewToken: z.string(),
  concurrencyVersion: z.number().int(),
  proposedLabels: z.array(proposedLabelViewSchema),
  conflicts: z.array(labelConflictSchema),
  canConfirm: z.boolean(),
});

const confirmBatchLabelsResponseSchema = z.object({
  ok: z.literal(true),
  revisionId: z.string().uuid(),
  updatedCount: z.number().int(),
  concurrencyVersion: z.number().int(),
});

const leaseHolderViewSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string(),
  email: z.string().email(),
});

const floorPlanLeaseViewSchema = z
  .object({
    floorPlanRevisionId: z.string().uuid(),
    token: z.string().optional(),
    acquiredAt: z.string(),
    expiresAt: z.string(),
    renewedAt: z.string(),
    releasedAt: z.string().nullable(),
    isExpired: z.boolean(),
    owner: leaseHolderViewSchema,
  })
  .meta({ description: 'Floor plan editor lease details including optional raw token.' });

const floorPlanLeaseStateViewSchema = z
  .object({
    hasActiveLease: z.boolean(),
    isCurrentHolder: z.boolean(),
    lease: floorPlanLeaseViewSchema.nullable(),
  })
  .meta({ description: 'State of an editor lease relative to the caller.' });

const publicationValidationResponse = z
  .object({
    isValid: z.boolean(),
    ready: z.boolean(),
    floorId: z.string().uuid(),
    revisionId: z.string().uuid(),
    concurrencyVersion: z.number().int(),
    summary: z.string(),
    errors: z.array(publicationValidationErrorSchema),
    warnings: z.array(publicationValidationErrorSchema),
  })
  .meta({ description: 'Authoritative publication validation result for a draft floor plan revision.' });

export type FloorPlanRouteOptions = {
  provider: LocalAuthProvider;
  pool: import('pg').Pool;
};

function floorPlanErrorHttp(error: FloorPlanError): {
  status: 400 | 403 | 404 | 409;
  body: {
    error: FloorPlanError['code'];
    diagnostics?: GeometryDiagnostic[];
    currentConcurrencyVersion?: number;
    validationErrors?: PublicationValidationError[];
  };
} {
  switch (error.code) {
    case 'floor_not_found':
    case 'floor_plan_not_found':
    case 'revision_not_found':
    case 'published_revision_not_found':
    case 'template_revision_not_found':
    case 'placement_not_found':
    case 'lease_not_found':
      return { status: 404, body: { error: error.code } };
    case 'forbidden':
      return { status: 403, body: { error: error.code } };
    case 'concurrency_conflict':
      return {
        status: 409,
        body: {
          error: error.code,
          currentConcurrencyVersion:
            typeof error.details?.currentConcurrencyVersion === 'number'
              ? error.details.currentConcurrencyVersion
              : undefined,
        },
      };
    case 'floor_archived':
    case 'building_archived':
    case 'site_archived':
    case 'template_archived':
    case 'floor_plan_already_exists':
    case 'revision_not_draft':
    case 'revision_not_published':
    case 'stale_revision':
    case 'invalid_preview_token':
    case 'label_collision':
    case 'duplicate_label':
    case 'lease_conflict':
    case 'lease_invalid_token':
    case 'lease_expired':
    case 'command_id_payload_mismatch':
      return { status: 409, body: { error: error.code } };
    case 'invalid_editing_scale':
    case 'invalid_coordinates':
    case 'invalid_rotation':
    case 'outside_boundary':
    case 'template_revision_not_current':
    case 'template_revision_not_physical':
    case 'placement_collision':
      return { status: 400, body: { error: error.code } };
    case 'invalid_geometry':
      return { status: 400, body: { error: error.code, diagnostics: error.diagnostics } };
    case 'publication_validation_failed':
      return {
        status: 400,
        body: {
          error: error.code,
          validationErrors: Array.isArray(error.details?.errors)
            ? (error.details.errors as PublicationValidationError[])
            : undefined,
        },
      };
  }
}

export const floorPlanRoutes: FastifyPluginAsync<FloorPlanRouteOptions> = async (app, opts) => {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  const authenticate = requirePrincipal(opts.provider);
  const requireFacilities = requireAnyRole('FACILITIES_ADMIN');
  const requireReader = requireAnyRole('FACILITIES_ADMIN', 'WORKPLACE_PLANNER', 'VIEWER');
  const service = new FloorPlanService(opts.pool);

  typedApp.post(
    '/floors/:floorId/floor-plan',
    {
      preHandler: [authenticate, requireFacilities],
      schema: {
        operationId: 'createFloorPlan',
        tags: ['floor-plans'],
        summary: 'Create Floor Plan identity and initial draft revision',
        description:
          'Creates the unique Floor Plan identity for a Floor and its initial Draft revision (revision 1) ' +
          'with a permitted 2ⁿ editing scale. Repeated calls with the same idempotency key return the existing plan.',
        security: [],
        params: z.object({ floorId: z.string().uuid() }),
        body: z
          .object({
            editingScale: z.number().int().optional(),
            idempotencyKey: z.string().min(1).max(255).optional(),
          })
          .nullable()
          .optional(),
        response: {
          200: createFloorPlanResponse,
          201: createFloorPlanResponse,
          400: badRequestResponse,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          404: notFoundResponse,
          409: conflictResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        const idempotencyKey =
          (request.headers['idempotency-key'] as string | undefined) ||
          request.body?.idempotencyKey;

        const result = await service.createFloorPlan({
          actorUserId: request.principal!.appUserId,
          floorId: request.params.floorId,
          editingScale: request.body?.editingScale,
          idempotencyKey,
        });

        const status = result.isReplay ? 200 : 201;
        return reply.code(status).send({
          floorPlan: result.floorPlan,
          revision: result.revision,
        });
      } catch (error) {
        if (error instanceof FloorPlanError) {
          const mapped = floorPlanErrorHttp(error);
          reply.statusCode = mapped.status;
          return mapped.body as never;
        }
        throw error;
      }
    },
  );

  typedApp.get(
    '/floors/:floorId/floor-plan/revisions',
    {
      preHandler: [authenticate, requireReader],
      schema: {
        operationId: 'listFloorPlanRevisions',
        tags: ['floor-plans'],
        summary: 'List Floor Plan Revisions',
        description:
          'Lists revisions for a floor plan with lifecycle states (Draft, Published, Archived). ' +
          'Facilities Admin can inspect Draft, Published, and Archived revisions. Workplace Planner and Viewer ' +
          'receive only permitted immutable Published revisions. Returns an empty list for an empty floor without error.',
        security: [],
        params: z.object({ floorId: z.string().uuid() }),
        response: {
          200: floorPlanRevisionsResponse,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          404: notFoundResponse,
          409: conflictResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        const revisions = await service.listRevisions(request.params.floorId, request.principal);
        return { revisions };
      } catch (error) {
        if (error instanceof FloorPlanError) {
          const mapped = floorPlanErrorHttp(error);
          reply.statusCode = mapped.status;
          return mapped.body as never;
        }
        throw error;
      }
    },
  );

  typedApp.get(
    '/floors/:floorId/floor-plan/revisions/:revisionId',
    {
      preHandler: [authenticate, requireReader],
      schema: {
        operationId: 'getFloorPlanRevision',
        tags: ['floor-plans'],
        summary: 'Get Floor Plan revision details',
        description:
          'Retrieves a single floor plan revision with boundary and placements. ' +
          'Workplace Planner and Viewer callers can access the Published revision; Draft and Archived revisions are denied (403).',
        security: [],
        params: z.object({
          floorId: z.string().uuid(),
          revisionId: z.string().uuid(),
        }),
        response: {
          200: floorPlanRevisionDetailResponse,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          404: notFoundResponse,
          409: conflictResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        const revision = await service.getRevision(
          request.params.floorId,
          request.params.revisionId,
          request.principal,
        );
        return { revision };
      } catch (error) {
        if (error instanceof FloorPlanError) {
          const mapped = floorPlanErrorHttp(error);
          reply.statusCode = mapped.status;
          return mapped.body as never;
        }
        throw error;
      }
    },
  );

  typedApp.post(
    '/floors/:floorId/floor-plan/revisions/:revisionId/validate',
    {
      preHandler: [authenticate, requireFacilities],
      schema: {
        operationId: 'validateFloorPlanDraft',
        tags: ['floor-plans'],
        summary: 'Run authoritative publication validation on a draft floor plan revision',
        description:
          'Evaluates floor boundary structure, transformed placement geometry, containment, mutual collisions, ' +
          'template references, labels, and lifecycle preconditions without mutating the revision.',
        security: [],
        params: z.object({
          floorId: z.string().uuid(),
          revisionId: z.string().uuid(),
        }),
        body: z
          .object({
            concurrencyVersion: z.number().int().optional(),
          })
          .nullable()
          .optional(),
        response: {
          200: publicationValidationResponse,
          400: badRequestResponse,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          404: notFoundResponse,
          409: conflictResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await service.validateDraftForPublication({
          floorId: request.params.floorId,
          revisionId: request.params.revisionId,
          concurrencyVersion: request.body?.concurrencyVersion,
          actorUserId: request.principal!.appUserId,
        });

        return reply.code(200).send(result);
      } catch (error) {
        if (error instanceof FloorPlanError) {
          const mapped = floorPlanErrorHttp(error);
          reply.statusCode = mapped.status;
          return mapped.body as never;
        }
        throw error;
      }
    },
  );

  typedApp.post(
    '/floors/:floorId/floor-plan/revisions/:revisionId/publish',
    {
      preHandler: [authenticate, requireFacilities],
      schema: {
        operationId: 'publishFloorPlanRevision',
        tags: ['floor-plans'],
        summary: 'Publish a draft floor plan revision as the immutable published revision',
        description:
          'Authoritatively validates the draft, archives any prior published revision, and transitions this draft to Published in a single transaction.',
        security: [],
        params: z.object({
          floorId: z.string().uuid(),
          revisionId: z.string().uuid(),
        }),
        headers: z
          .object({
            'x-lease-token': z.string().optional(),
            'x-client-command-id': z.string().optional(),
          })
          .passthrough()
          .optional(),
        body: z.object({
          concurrencyVersion: z.number().int(),
          leaseToken: z.string().optional(),
          clientCommandId: z.string().optional(),
        }),
        response: {
          200: floorPlanRevisionDetailResponse,
          400: badRequestResponse,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          404: notFoundResponse,
          409: conflictResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        const leaseToken =
          request.body?.leaseToken ||
          (request.headers['x-lease-token'] as string | undefined);
        const clientCommandId =
          request.body?.clientCommandId ||
          (request.headers['x-client-command-id'] as string | undefined);

        const revision = await service.publishRevision({
          floorId: request.params.floorId,
          revisionId: request.params.revisionId,
          concurrencyVersion: request.body.concurrencyVersion,
          actorUserId: request.principal!.appUserId,
          leaseToken,
          clientCommandId,
        });

        return reply.code(200).send({ revision });
      } catch (error) {
        if (error instanceof FloorPlanError) {
          const mapped = floorPlanErrorHttp(error);
          reply.statusCode = mapped.status;
          return mapped.body as never;
        }
        throw error;
      }
    },
  );

  typedApp.get(
    '/floors/:floorId/floor-plan',
    {
      preHandler: [authenticate, requireReader],
      schema: {
        operationId: 'getFloorPlan',
        tags: ['floor-plans'],
        summary: 'Get Floor Plan details and active revision',
        description:
          'Retrieves the Floor Plan identity, active revision, and published revision for a floor. ' +
          'For Facilities Admin, activeRevision defaults to Draft if present. For Workplace Planner and Viewer, ' +
          'activeRevision is the Published revision (Draft geometry is never exposed). Returns null values if floor has no plan.',
        security: [],
        params: z.object({ floorId: z.string().uuid() }),
        response: {
          200: floorPlanDetailResponse,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          404: notFoundResponse,
          409: conflictResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        return await service.getFloorPlan(request.params.floorId, request.principal);
      } catch (error) {
        if (error instanceof FloorPlanError) {
          const mapped = floorPlanErrorHttp(error);
          reply.statusCode = mapped.status;
          return mapped.body as never;
        }
        throw error;
      }
    },
  );

  typedApp.get(
    '/floors/:floorId/floor-plan/published',
    {
      preHandler: [authenticate, requireReader],
      schema: {
        operationId: 'getPublishedFloorPlan',
        tags: ['floor-plans'],
        summary: 'Get current Published Floor Plan and revision',
        description:
          'Retrieves the immutable Published Floor Plan revision for an active floor. ' +
          'Available to Facilities Admin, Workplace Planner, and Viewer callers.',
        security: [],
        params: z.object({ floorId: z.string().uuid() }),
        response: {
          200: publishedFloorPlanResponse,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          404: notFoundResponse,
          409: conflictResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        return await service.getPublishedFloorPlan(request.params.floorId);
      } catch (error) {
        if (error instanceof FloorPlanError) {
          const mapped = floorPlanErrorHttp(error);
          reply.statusCode = mapped.status;
          return mapped.body as never;
        }
        throw error;
      }
    },
  );

  typedApp.post(
    '/floors/:floorId/floor-plan/revisions/:revisionId/lease',
    {
      preHandler: [authenticate, requireFacilities],
      schema: {
        operationId: 'acquireFloorPlanLease',
        tags: ['floor-plans'],
        summary: 'Acquire exclusive edit lease for a draft floor plan revision',
        description:
          'Acquires an exclusive, time-limited lease to edit a draft floor plan revision. ' +
          'Returns a secure lease token. If another active user holds the lease, returns 409 lease_conflict.',
        security: [],
        params: z.object({
          floorId: z.string().uuid(),
          revisionId: z.string().uuid(),
        }),
        body: z
          .object({
            durationSeconds: z.number().int().min(10).max(3600).optional(),
          })
          .nullable()
          .optional(),
        response: {
          200: floorPlanLeaseViewSchema,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          404: notFoundResponse,
          409: conflictResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        return (
          await service.acquireLease({
            floorId: request.params.floorId,
            revisionId: request.params.revisionId,
            actorUserId: request.principal!.appUserId,
            durationSeconds: request.body?.durationSeconds,
          })
        ).lease;
      } catch (error) {
        if (error instanceof FloorPlanError) {
          const mapped = floorPlanErrorHttp(error);
          reply.statusCode = mapped.status;
          return mapped.body as never;
        }
        throw error;
      }
    },
  );

  typedApp.get(
    '/floors/:floorId/floor-plan/revisions/:revisionId/lease',
    {
      preHandler: [authenticate, requireAnyRole('FACILITIES_ADMIN', 'WORKPLACE_PLANNER', 'VIEWER')],
      schema: {
        operationId: 'getFloorPlanLease',
        tags: ['floor-plans'],
        summary: 'Get active lease state for a floor plan revision',
        description:
          'Returns active lease info (owner, expiry) without revealing the secret token. ' +
          'Indicates whether the revision is currently leased and whether the caller holds it.',
        security: [],
        params: z.object({
          floorId: z.string().uuid(),
          revisionId: z.string().uuid(),
        }),
        response: {
          200: floorPlanLeaseStateViewSchema,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          404: notFoundResponse,
          409: conflictResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        return await service.getLease({
          floorId: request.params.floorId,
          revisionId: request.params.revisionId,
          actorUserId: request.principal!.appUserId,
        });
      } catch (error) {
        if (error instanceof FloorPlanError) {
          const mapped = floorPlanErrorHttp(error);
          reply.statusCode = mapped.status;
          return mapped.body as never;
        }
        throw error;
      }
    },
  );

  typedApp.post(
    '/floors/:floorId/floor-plan/revisions/:revisionId/lease/renew',
    {
      preHandler: [authenticate, requireFacilities],
      schema: {
        operationId: 'renewFloorPlanLease',
        tags: ['floor-plans'],
        summary: 'Renew an active edit lease',
        description:
          'Extends the expiry of an existing edit lease held by the caller.',
        security: [],
        params: z.object({
          floorId: z.string().uuid(),
          revisionId: z.string().uuid(),
        }),
        headers: z.object({
          'x-lease-token': z.string().min(1).optional(),
        }),
        body: z
          .object({
            leaseToken: z.string().min(1).optional(),
            durationSeconds: z.number().int().min(10).max(3600).optional(),
          })
          .nullable()
          .optional(),
        response: {
          200: floorPlanLeaseViewSchema,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          404: notFoundResponse,
          409: conflictResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        const leaseToken =
          request.body?.leaseToken ||
          (request.headers['x-lease-token'] as string | undefined);
        if (!leaseToken) {
          return reply.code(409).send({ error: 'lease_invalid_token' });
        }
        return await service.renewLease({
          floorId: request.params.floorId,
          revisionId: request.params.revisionId,
          actorUserId: request.principal!.appUserId,
          leaseToken,
          durationSeconds: request.body?.durationSeconds,
        });
      } catch (error) {
        if (error instanceof FloorPlanError) {
          const mapped = floorPlanErrorHttp(error);
          reply.statusCode = mapped.status;
          return mapped.body as never;
        }
        throw error;
      }
    },
  );

  typedApp.post(
    '/floors/:floorId/floor-plan/revisions/:revisionId/lease/release',
    {
      preHandler: [authenticate, requireFacilities],
      schema: {
        operationId: 'releaseFloorPlanLease',
        tags: ['floor-plans'],
        summary: 'Release an active edit lease',
        description:
          'Releases an active edit lease held by the caller so another user can immediately acquire it.',
        security: [],
        params: z.object({
          floorId: z.string().uuid(),
          revisionId: z.string().uuid(),
        }),
        headers: z.object({
          'x-lease-token': z.string().min(1).optional(),
        }),
        body: z
          .object({
            leaseToken: z.string().min(1).optional(),
          })
          .nullable()
          .optional(),
        response: {
          200: z.object({ ok: z.literal(true) }),
          401: unauthorizedResponse,
          403: forbiddenResponse,
          404: notFoundResponse,
          409: conflictResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        const leaseToken =
          request.body?.leaseToken ||
          (request.headers['x-lease-token'] as string | undefined);
        if (!leaseToken) {
          return reply.code(409).send({ error: 'lease_invalid_token' });
        }
        await service.releaseLease({
          floorId: request.params.floorId,
          revisionId: request.params.revisionId,
          actorUserId: request.principal!.appUserId,
          leaseToken,
        });
        return { ok: true as const };
      } catch (error) {
        if (error instanceof FloorPlanError) {
          const mapped = floorPlanErrorHttp(error);
          reply.statusCode = mapped.status;
          return mapped.body as never;
        }
        throw error;
      }
    },
  );

  typedApp.post(
    '/floors/:floorId/floor-plan/revisions/:revisionId/lease/takeover',
    {
      preHandler: [authenticate, requireFacilities],
      schema: {
        operationId: 'takeoverFloorPlanLease',
        tags: ['floor-plans'],
        summary: 'Take over an expired or deactivated user edit lease',
        description:
          'Allows a Facilities Admin to take over an edit lease that has expired or belongs to an inactive user. Logs an audited TAKEOVER_LEASE event.',
        security: [],
        params: z.object({
          floorId: z.string().uuid(),
          revisionId: z.string().uuid(),
        }),
        body: z
          .object({
            reason: z.string().optional(),
            durationSeconds: z.number().int().min(10).max(3600).optional(),
          })
          .nullable()
          .optional(),
        response: {
          200: floorPlanLeaseViewSchema,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          404: notFoundResponse,
          409: conflictResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        return (
          await service.takeoverLease({
            floorId: request.params.floorId,
            revisionId: request.params.revisionId,
            actorUserId: request.principal!.appUserId,
            reason: request.body?.reason,
            durationSeconds: request.body?.durationSeconds,
          })
        ).lease;
      } catch (error) {
        if (error instanceof FloorPlanError) {
          const mapped = floorPlanErrorHttp(error);
          reply.statusCode = mapped.status;
          return mapped.body as never;
        }
        throw error;
      }
    },
  );

  typedApp.put(
    '/floors/:floorId/floor-plan/revisions/:revisionId/boundary',
    {
      preHandler: [authenticate, requireFacilities],
      schema: {
        operationId: 'updateFloorPlanRevisionBoundary',
        tags: ['floor-plans'],
        summary: 'Update Draft Floor Plan boundary geometry',
        description:
          'Saves the orthogonal boundary in integer world units for a Draft Floor Plan revision. ' +
          'Requires an active editor lease token and client command ID for idempotent autosave. ' +
          'Increments concurrency version and rejects non-Draft revisions and stale concurrency versions.',
        security: [],
        params: z.object({
          floorId: z.string().uuid(),
          revisionId: z.string().uuid(),
        }),
        headers: z.object({
          'x-lease-token': z.string().min(1).optional(),
          'x-client-command-id': z.string().min(1).optional(),
        }),
        body: z.object({
          concurrencyVersion: z.number().int().min(0),
          editingScale: z.number().int().optional(),
          vertices: z.array(vertexSchema).min(4).max(100),
          leaseToken: z.string().min(1).optional(),
          clientCommandId: z.string().min(1).optional(),
        }),
        response: {
          200: floorPlanRevisionView,
          400: badRequestResponse,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          404: notFoundResponse,
          409: conflictResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        const leaseToken =
          request.body.leaseToken ||
          (request.headers['x-lease-token'] as string | undefined);
        const clientCommandId =
          request.body.clientCommandId ||
          (request.headers['x-client-command-id'] as string | undefined);

        return await service.updateRevisionBoundary({
          floorId: request.params.floorId,
          revisionId: request.params.revisionId,
          concurrencyVersion: request.body.concurrencyVersion,
          editingScale: request.body.editingScale,
          vertices: request.body.vertices,
          actorUserId: request.principal!.appUserId,
          leaseToken,
          clientCommandId,
        });
      } catch (error) {
        if (error instanceof FloorPlanError) {
          const mapped = floorPlanErrorHttp(error);
          reply.statusCode = mapped.status;
          return mapped.body as never;
        }
        throw error;
      }
    },
  );

  typedApp.patch(
    '/floors/:floorId/floor-plan/revisions/:revisionId/scale',
    {
      preHandler: [authenticate, requireFacilities],
      schema: {
        operationId: 'updateFloorPlanRevisionScale',
        tags: ['floor-plans'],
        summary: 'Update Editing Scale of a Draft Floor Plan revision',
        description:
          'Updates the editing scale of a Draft revision without changing stored geometry. ' +
          'Requires active editor lease token and client command ID for idempotent autosave. ' +
          'Increments concurrency version and rejects stale versions or non-Draft revisions.',
        security: [],
        params: z.object({
          floorId: z.string().uuid(),
          revisionId: z.string().uuid(),
        }),
        headers: z.object({
          'x-lease-token': z.string().min(1).optional(),
          'x-client-command-id': z.string().min(1).optional(),
        }),
        body: z.object({
          concurrencyVersion: z.number().int().min(0),
          editingScale: z.number().int(),
          leaseToken: z.string().min(1).optional(),
          clientCommandId: z.string().min(1).optional(),
        }),
        response: {
          200: floorPlanRevisionView,
          400: badRequestResponse,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          404: notFoundResponse,
          409: conflictResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        const leaseToken =
          request.body.leaseToken ||
          (request.headers['x-lease-token'] as string | undefined);
        const clientCommandId =
          request.body.clientCommandId ||
          (request.headers['x-client-command-id'] as string | undefined);

        return await service.updateRevisionScale({
          floorId: request.params.floorId,
          revisionId: request.params.revisionId,
          concurrencyVersion: request.body.concurrencyVersion,
          editingScale: request.body.editingScale,
          actorUserId: request.principal!.appUserId,
          leaseToken,
          clientCommandId,
        });
      } catch (error) {
        if (error instanceof FloorPlanError) {
          const mapped = floorPlanErrorHttp(error);
          reply.statusCode = mapped.status;
          return mapped.body as never;
        }
        throw error;
      }
    },
  );

  typedApp.post(
    '/floors/:floorId/floor-plan/revisions/:revisionId/placements',
    {
      preHandler: [authenticate, requireFacilities],
      schema: {
        operationId: 'createPlacedElement',
        tags: ['floor-plans'],
        summary: 'Place a physical space template revision on a draft floor plan',
        description:
          'Places an immutable current physical template revision at integer world coordinates with quarter-turn rotation. ' +
          'Requires active editor lease token and client command ID. ' +
          'Validates boundary containment and non-overlapping interior for physical spaces.',
        security: [],
        params: z.object({
          floorId: z.string().uuid(),
          revisionId: z.string().uuid(),
        }),
        headers: z.object({
          'x-lease-token': z.string().min(1).optional(),
          'x-client-command-id': z.string().min(1).optional(),
        }),
        body: z.object({
          templateRevisionId: z.string().uuid(),
          positionX: z.number().int(),
          positionY: z.number().int(),
          rotationDegrees: z.number().int().optional().default(0),
          label: z.string().nullable().optional(),
          concurrencyVersion: z.number().int().optional(),
          leaseToken: z.string().min(1).optional(),
          clientCommandId: z.string().min(1).optional(),
        }),
        response: {
          201: placedElementView,
          400: badRequestResponse,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          404: notFoundResponse,
          409: conflictResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        const leaseToken =
          request.body.leaseToken ||
          (request.headers['x-lease-token'] as string | undefined);
        const clientCommandId =
          request.body.clientCommandId ||
          (request.headers['x-client-command-id'] as string | undefined);

        const placed = await service.placeElement({
          floorId: request.params.floorId,
          revisionId: request.params.revisionId,
          templateRevisionId: request.body.templateRevisionId,
          positionX: request.body.positionX,
          positionY: request.body.positionY,
          rotationDegrees: request.body.rotationDegrees,
          label: request.body.label,
          concurrencyVersion: request.body.concurrencyVersion,
          actorUserId: request.principal!.appUserId,
          leaseToken,
          clientCommandId,
        });
        return reply.code(201).send(placed);
      } catch (error) {
        if (error instanceof FloorPlanError) {
          const mapped = floorPlanErrorHttp(error);
          reply.statusCode = mapped.status;
          return mapped.body as never;
        }
        throw error;
      }
    },
  );

  typedApp.get(
    '/floors/:floorId/floor-plan/revisions/:revisionId/placements',
    {
      preHandler: [authenticate, requireAnyRole('FACILITIES_ADMIN', 'WORKPLACE_PLANNER', 'VIEWER')],
      schema: {
        operationId: 'listPlacedElements',
        tags: ['floor-plans'],
        summary: 'List placed elements on a floor plan revision',
        description:
          'Lists all placed elements pinned to immutable template revisions on a floor plan revision, reconstructing world geometry.',
        security: [],
        params: z.object({
          floorId: z.string().uuid(),
          revisionId: z.string().uuid(),
        }),
        response: {
          200: placementsListResponse,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          404: notFoundResponse,
          409: conflictResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        const placements = await service.listPlacements(
          request.params.floorId,
          request.params.revisionId,
        );
        return { placements };
      } catch (error) {
        if (error instanceof FloorPlanError) {
          const mapped = floorPlanErrorHttp(error);
          reply.statusCode = mapped.status;
          return mapped.body as never;
        }
        throw error;
      }
    },
  );

  typedApp.patch(
    '/floors/:floorId/floor-plan/revisions/:revisionId/placements/:placementId',
    {
      preHandler: [authenticate, requireAnyRole('FACILITIES_ADMIN')],
      schema: {
        operationId: 'updatePlacedElement',
        tags: ['floor-plans'],
        summary: 'Update or transform a placed space',
        description:
          'Translates or quarter-turns an existing placed physical space without resizing it. ' +
          'Requires active editor lease token and client command ID. ' +
          'Enforces boundary containment, non-collision, and optimistic concurrency version checking.',
        security: [],
        params: z.object({
          floorId: z.string().uuid(),
          revisionId: z.string().uuid(),
          placementId: z.string().uuid(),
        }),
        headers: z.object({
          'x-lease-token': z.string().min(1).optional(),
          'x-client-command-id': z.string().min(1).optional(),
        }),
        body: z.strictObject({
          concurrencyVersion: z.number().int().min(0).optional(),
          positionX: z.number().int().optional(),
          positionY: z.number().int().optional(),
          rotationDegrees: z.number().int().optional(),
          label: z.string().nullable().optional(),
          leaseToken: z.string().min(1).optional(),
          clientCommandId: z.string().min(1).optional(),
        }),
        response: {
          200: placedElementView,
          400: badRequestResponse,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          404: notFoundResponse,
          409: conflictResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        const leaseToken =
          request.body.leaseToken ||
          (request.headers['x-lease-token'] as string | undefined);
        const clientCommandId =
          request.body.clientCommandId ||
          (request.headers['x-client-command-id'] as string | undefined);

        const updated = await service.updatePlacement({
          floorId: request.params.floorId,
          revisionId: request.params.revisionId,
          placementId: request.params.placementId,
          concurrencyVersion: request.body.concurrencyVersion,
          positionX: request.body.positionX,
          positionY: request.body.positionY,
          rotationDegrees: request.body.rotationDegrees,
          label: request.body.label,
          actorUserId: request.principal!.appUserId,
          leaseToken,
          clientCommandId,
        });
        return reply.code(200).send(updated);
      } catch (error) {
        if (error instanceof FloorPlanError) {
          const mapped = floorPlanErrorHttp(error);
          reply.statusCode = mapped.status;
          return mapped.body as never;
        }
        throw error;
      }
    },
  );

  typedApp.delete(
    '/floors/:floorId/floor-plan/revisions/:revisionId/placements/:placementId',
    {
      preHandler: [authenticate, requireAnyRole('FACILITIES_ADMIN')],
      schema: {
        operationId: 'deletePlacedElement',
        tags: ['floor-plans'],
        summary: 'Remove a placed space from a draft floor plan revision',
        description:
          'Removes a placed space from the current draft floor plan revision without deleting its stable placement identity or historical records. ' +
          'Requires active editor lease token and client command ID.',
        security: [],
        params: z.object({
          floorId: z.string().uuid(),
          revisionId: z.string().uuid(),
          placementId: z.string().uuid(),
        }),
        headers: z.object({
          'x-lease-token': z.string().min(1).optional(),
          'x-client-command-id': z.string().min(1).optional(),
        }),
        querystring: z.object({
          concurrencyVersion: z.coerce.number().int().min(0).optional(),
          leaseToken: z.string().min(1).optional(),
          clientCommandId: z.string().min(1).optional(),
        }),
        response: {
          200: z.object({
            ok: z.literal(true),
            concurrencyVersion: z.number().int(),
          }),
          400: badRequestResponse,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          404: notFoundResponse,
          409: conflictResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        const leaseToken =
          request.query.leaseToken ||
          (request.headers['x-lease-token'] as string | undefined);
        const clientCommandId =
          request.query.clientCommandId ||
          (request.headers['x-client-command-id'] as string | undefined);

        const result = await service.deletePlacement({
          floorId: request.params.floorId,
          revisionId: request.params.revisionId,
          placementId: request.params.placementId,
          concurrencyVersion: request.query.concurrencyVersion,
          actorUserId: request.principal!.appUserId,
          leaseToken,
          clientCommandId,
        });
        return reply.code(200).send(result);
      } catch (error) {
        if (error instanceof FloorPlanError) {
          const mapped = floorPlanErrorHttp(error);
          reply.statusCode = mapped.status;
          return mapped.body as never;
        }
        throw error;
      }
    },
  );

  typedApp.post(
    '/floors/:floorId/floor-plan/revisions/:revisionId/batch-labels/preview',
    {
      preHandler: [authenticate, requireAnyRole('WORKPLACE_PLANNER')],
      schema: {
        operationId: 'previewBatchLabels',
        tags: ['floor-plans'],
        summary: 'Generate deterministic batch label proposal for selected Published physical spaces',
        description:
          'Proposes sequential labels according to prefix, starting number, width, and ordering strategy without mutating placement records. ' +
          'Detects duplicate, collision, ineligible-space, and stale-revision conflicts.',
        security: [],
        params: z.object({
          floorId: z.string().uuid(),
          revisionId: z.string().uuid(),
        }),
        body: z.object({
          placementIds: z.array(z.string().uuid()),
          prefix: z.string(),
          startNumber: z.number().int().min(0),
          width: z.number().int().min(1),
          ordering: z.enum(['SELECTION', 'ROW_MAJOR', 'COLUMN_MAJOR']),
          concurrencyVersion: z.number().int(),
        }),
        response: {
          200: previewBatchLabelsResponseSchema,
          400: badRequestResponse,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          404: notFoundResponse,
          409: conflictResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await service.previewBatchLabels({
          floorId: request.params.floorId,
          revisionId: request.params.revisionId,
          placementIds: request.body.placementIds,
          prefix: request.body.prefix,
          startNumber: request.body.startNumber,
          width: request.body.width,
          ordering: request.body.ordering,
          concurrencyVersion: request.body.concurrencyVersion,
        });
        return reply.code(200).send(result);
      } catch (error) {
        if (error instanceof FloorPlanError) {
          const mapped = floorPlanErrorHttp(error);
          reply.statusCode = mapped.status;
          return mapped.body as never;
        }
        throw error;
      }
    },
  );

  typedApp.post(
    '/floors/:floorId/floor-plan/revisions/:revisionId/batch-labels/confirm',
    {
      preHandler: [authenticate, requireAnyRole('WORKPLACE_PLANNER')],
      schema: {
        operationId: 'confirmBatchLabels',
        tags: ['floor-plans'],
        summary: 'Apply accepted preview batch labels transactionally and idempotently',
        description:
          'Applies the exact accepted preview labels to Published physical spaces in a single transaction. ' +
          'Enforces concurrency control, preview token validation, idempotency via clientCommandId, and audit logging.',
        security: [],
        params: z.object({
          floorId: z.string().uuid(),
          revisionId: z.string().uuid(),
        }),
        body: z.object({
          previewToken: z.string().min(1),
          concurrencyVersion: z.number().int(),
          assignments: z.array(
            z.object({
              placementId: z.string().uuid(),
              label: z.string().min(1),
            }),
          ),
          clientCommandId: z.string().min(1),
        }),
        response: {
          200: confirmBatchLabelsResponseSchema,
          400: badRequestResponse,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          404: notFoundResponse,
          409: conflictResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await service.confirmBatchLabels({
          floorId: request.params.floorId,
          revisionId: request.params.revisionId,
          previewToken: request.body.previewToken,
          concurrencyVersion: request.body.concurrencyVersion,
          assignments: request.body.assignments,
          clientCommandId: request.body.clientCommandId,
          actorUserId: request.principal!.appUserId,
        });
        return reply.code(200).send(result);
      } catch (error) {
        if (error instanceof FloorPlanError) {
          const mapped = floorPlanErrorHttp(error);
          reply.statusCode = mapped.status;
          return mapped.body as never;
        }
        throw error;
      }
    },
  );
};
