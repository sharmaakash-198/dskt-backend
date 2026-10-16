/**
 * Floor Plan and Revision HTTP routes.
 *
 * Implements Ticket 11: Create a Draft Floor Plan.
 * Only Facilities Admins can create or read Draft Floor Plan details.
 */
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import type { LocalAuthProvider } from '../auth/local-provider.js';
import { requireAnyRole, requirePrincipal } from '../auth/permissions.js';
import { FloorPlanError, FloorPlanService } from './service.js';

const unauthorizedResponse = z
  .object({ error: z.literal('unauthorized') })
  .meta({ description: 'Not authenticated or session expired/revoked.' });

const forbiddenResponse = z
  .object({ error: z.literal('forbidden') })
  .meta({ description: 'Authenticated but missing a required application role.' });

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

const floorPlanRevisionsResponse = z
  .object({
    revisions: z.array(floorPlanRevisionView),
  })
  .meta({ description: 'List of Floor Plan Revisions, or empty if floor has no plan.' });

const floorPlanDetailResponse = z
  .object({
    floorPlan: floorPlanView.nullable(),
    activeRevision: floorPlanRevisionView.nullable(),
  })
  .meta({ description: 'Floor Plan and its active revision, or nulls if floor has no plan.' });

const notFoundResponse = z.object({
  error: z.enum(['floor_not_found', 'floor_plan_not_found']),
});

const conflictResponse = z.object({
  error: z.enum(['floor_archived', 'floor_plan_already_exists']),
});

const badRequestResponse = z.object({
  error: z.enum(['invalid_editing_scale']),
});

export type FloorPlanRouteOptions = {
  provider: LocalAuthProvider;
  pool: import('pg').Pool;
};

function floorPlanErrorHttp(error: FloorPlanError): {
  status: 400 | 404 | 409;
  body: { error: FloorPlanError['code'] };
} {
  switch (error.code) {
    case 'floor_not_found':
    case 'floor_plan_not_found':
      return { status: 404, body: { error: error.code } };
    case 'floor_archived':
    case 'floor_plan_already_exists':
      return { status: 409, body: { error: error.code } };
    case 'invalid_editing_scale':
      return { status: 400, body: { error: error.code } };
  }
}

export const floorPlanRoutes: FastifyPluginAsync<FloorPlanRouteOptions> = async (app, opts) => {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  const authenticate = requirePrincipal(opts.provider);
  const requireFacilities = requireAnyRole('FACILITIES_ADMIN');
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
      preHandler: [authenticate, requireFacilities],
      schema: {
        operationId: 'listFloorPlanRevisions',
        tags: ['floor-plans'],
        summary: 'List Floor Plan Revisions',
        description:
          'Lists all revisions for a floor plan with lifecycle states (Draft, Published, Archived). ' +
          'Returns an empty list for an empty floor without error.',
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
        const revisions = await service.listRevisions(request.params.floorId);
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
    '/floors/:floorId/floor-plan',
    {
      preHandler: [authenticate, requireFacilities],
      schema: {
        operationId: 'getFloorPlan',
        tags: ['floor-plans'],
        summary: 'Get Floor Plan details and active revision',
        description:
          'Retrieves the Floor Plan identity and active revision for a floor. ' +
          'Returns null values if the floor has no floor plan yet.',
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
        return await service.getFloorPlan(request.params.floorId);
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
