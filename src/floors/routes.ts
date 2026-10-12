/**
 * Floor HTTP routes for the location hierarchy.
 *
 * Facilities Admins may create, update, and archive Floors under an active
 * Building. Workplace Planners and Viewers may list active Floors.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod/v4';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { LocalAuthProvider } from '../auth/local-provider.js';
import { requireAnyRole, requirePrincipal } from '../auth/permissions.js';
import { FloorError, FloorService } from './service.js';

const unauthorizedResponse = z
  .object({ error: z.literal('unauthorized') })
  .meta({ description: 'Not authenticated or session expired/revoked.' });

const forbiddenResponse = z
  .object({ error: z.literal('forbidden') })
  .meta({ description: 'Authenticated but missing a required application role.' });

const floorView = z
  .object({
    id: z.string().uuid(),
    buildingId: z.string().uuid(),
    code: z.string(),
    name: z.string(),
  })
  .meta({ description: 'Active or archived Floor projection.' });

const floorListResponse = z
  .object({
    floors: z.array(floorView),
  })
  .meta({ description: 'Active Floors ordered by stable code.' });

const createFloorBody = z.object({
  code: z.string().min(1).max(32),
  name: z.string().trim().min(1).max(200),
});

const updateFloorBody = z.object({
  name: z.string().trim().min(1).max(200),
});

const conflictResponse = z.object({
  error: z.enum(['floor_code_taken', 'floor_archived', 'building_archived']),
});

const notFoundResponse = z.object({
  error: z.enum(['floor_not_found', 'building_not_found']),
});

const badRequestResponse = z.object({
  error: z.enum(['invalid_floor_code', 'invalid_floor_name']),
});

export type FloorRouteOptions = {
  provider: LocalAuthProvider;
  pool: import('pg').Pool;
};

function floorErrorHttp(error: FloorError): {
  status: 400 | 404 | 409;
  body: { error: FloorError['code'] };
} {
  switch (error.code) {
    case 'floor_not_found':
    case 'building_not_found':
      return { status: 404, body: { error: error.code } };
    case 'floor_code_taken':
    case 'floor_archived':
    case 'building_archived':
      return { status: 409, body: { error: error.code } };
    case 'invalid_floor_code':
    case 'invalid_floor_name':
      return { status: 400, body: { error: error.code } };
  }
}

export const floorRoutes: FastifyPluginAsync<FloorRouteOptions> = async (app, opts) => {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  const authenticate = requirePrincipal(opts.provider);
  const requireReader = requireAnyRole('FACILITIES_ADMIN', 'WORKPLACE_PLANNER', 'VIEWER');
  const requireFacilities = requireAnyRole('FACILITIES_ADMIN');
  const service = new FloorService(opts.pool);

  typedApp.get(
    '/buildings/:buildingId/floors',
    {
      preHandler: [authenticate, requireReader],
      schema: {
        operationId: 'listFloors',
        tags: ['floors'],
        summary: 'List active Floors for a Building',
        description:
          'Lists active Floors under an active Building in stable code order for Facilities ' +
          'Admin, Workplace Planner, and Viewer callers.',
        security: [],
        params: z.object({ buildingId: z.string().uuid() }),
        response: {
          200: floorListResponse,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          404: notFoundResponse,
          409: conflictResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        return { floors: await service.listActiveFloors(request.params.buildingId) };
      } catch (error) {
        if (error instanceof FloorError) {
          const mapped = floorErrorHttp(error);
          reply.statusCode = mapped.status;
          return mapped.body as never;
        }
        throw error;
      }
    },
  );

  typedApp.post(
    '/buildings/:buildingId/floors',
    {
      preHandler: [authenticate, requireFacilities],
      schema: {
        operationId: 'createFloor',
        tags: ['floors'],
        summary: 'Create a Floor',
        description:
          'Creates a Floor under an active Building with a validated stable code and name. ' +
          'Floor codes are unique within the Building.',
        security: [],
        params: z.object({ buildingId: z.string().uuid() }),
        body: createFloorBody,
        response: {
          201: floorView,
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
        const floor = await service.createFloor({
          actorUserId: request.principal!.appUserId,
          correlationId: request.id,
          buildingId: request.params.buildingId,
          ...request.body,
        });
        return reply.code(201).send(floor);
      } catch (error) {
        if (error instanceof FloorError) {
          const mapped = floorErrorHttp(error);
          reply.statusCode = mapped.status;
          return mapped.body as never;
        }
        throw error;
      }
    },
  );

  typedApp.patch(
    '/floors/:floorId',
    {
      preHandler: [authenticate, requireFacilities],
      schema: {
        operationId: 'updateFloor',
        tags: ['floors'],
        summary: 'Update a Floor',
        description: 'Updates the name of an active Floor. The stable code is immutable.',
        security: [],
        params: z.object({ floorId: z.string().uuid() }),
        body: updateFloorBody,
        response: {
          200: floorView,
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
        return await service.updateFloor({
          actorUserId: request.principal!.appUserId,
          correlationId: request.id,
          floorId: request.params.floorId,
          ...request.body,
        });
      } catch (error) {
        if (error instanceof FloorError) {
          const mapped = floorErrorHttp(error);
          reply.statusCode = mapped.status;
          return mapped.body as never;
        }
        throw error;
      }
    },
  );

  typedApp.post(
    '/floors/:floorId/archive',
    {
      preHandler: [authenticate, requireFacilities],
      schema: {
        operationId: 'archiveFloor',
        tags: ['floors'],
        summary: 'Archive a Floor',
        description:
          'Archives an active Floor without deleting historical identity. No cascading archive.',
        security: [],
        params: z.object({ floorId: z.string().uuid() }),
        response: {
          200: floorView,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          404: notFoundResponse,
          409: conflictResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        return await service.archiveFloor({
          actorUserId: request.principal!.appUserId,
          correlationId: request.id,
          floorId: request.params.floorId,
        });
      } catch (error) {
        if (error instanceof FloorError) {
          const mapped = floorErrorHttp(error);
          reply.statusCode = mapped.status;
          return mapped.body as never;
        }
        throw error;
      }
    },
  );
};
