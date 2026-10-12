/**
 * Building HTTP routes for the location hierarchy.
 *
 * Facilities Admins may create, update, and archive Buildings under an active
 * Site. Workplace Planners and Viewers may list active Buildings.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod/v4';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { LocalAuthProvider } from '../auth/local-provider.js';
import { requireAnyRole, requirePrincipal } from '../auth/permissions.js';
import { BuildingError, BuildingService } from './service.js';

const unauthorizedResponse = z
  .object({ error: z.literal('unauthorized') })
  .meta({ description: 'Not authenticated or session expired/revoked.' });

const forbiddenResponse = z
  .object({ error: z.literal('forbidden') })
  .meta({ description: 'Authenticated but missing a required application role.' });

const buildingView = z
  .object({
    id: z.string().uuid(),
    siteId: z.string().uuid(),
    code: z.string(),
    name: z.string(),
  })
  .meta({ description: 'Active or archived Building projection.' });

const buildingListResponse = z
  .object({
    buildings: z.array(buildingView),
  })
  .meta({ description: 'Active Buildings ordered by stable code.' });

const createBuildingBody = z.object({
  code: z.string().min(1).max(32),
  name: z.string().trim().min(1).max(200),
});

const updateBuildingBody = z.object({
  name: z.string().trim().min(1).max(200),
});

const conflictResponse = z.object({
  error: z.enum([
    'building_code_taken',
    'building_archived',
    'building_has_active_floors',
    'site_archived',
  ]),
});

const notFoundResponse = z.object({
  error: z.enum(['building_not_found', 'site_not_found']),
});

const badRequestResponse = z.object({
  error: z.enum(['invalid_building_code', 'invalid_building_name']),
});

export type BuildingRouteOptions = {
  provider: LocalAuthProvider;
  pool: import('pg').Pool;
};

function buildingErrorHttp(error: BuildingError): {
  status: 400 | 404 | 409;
  body: { error: BuildingError['code'] };
} {
  switch (error.code) {
    case 'building_not_found':
    case 'site_not_found':
      return { status: 404, body: { error: error.code } };
    case 'building_code_taken':
    case 'building_archived':
    case 'building_has_active_floors':
    case 'site_archived':
      return { status: 409, body: { error: error.code } };
    case 'invalid_building_code':
    case 'invalid_building_name':
      return { status: 400, body: { error: error.code } };
  }
}

export const buildingRoutes: FastifyPluginAsync<BuildingRouteOptions> = async (app, opts) => {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  const authenticate = requirePrincipal(opts.provider);
  const requireReader = requireAnyRole('FACILITIES_ADMIN', 'WORKPLACE_PLANNER', 'VIEWER');
  const requireFacilities = requireAnyRole('FACILITIES_ADMIN');
  const service = new BuildingService(opts.pool);

  typedApp.get(
    '/sites/:siteId/buildings',
    {
      preHandler: [authenticate, requireReader],
      schema: {
        operationId: 'listBuildings',
        tags: ['buildings'],
        summary: 'List active Buildings for a Site',
        description:
          'Lists active Buildings under an active Site in stable code order for Facilities ' +
          'Admin, Workplace Planner, and Viewer callers.',
        security: [],
        params: z.object({ siteId: z.string().uuid() }),
        response: {
          200: buildingListResponse,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          404: notFoundResponse,
          409: conflictResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        return { buildings: await service.listActiveBuildings(request.params.siteId) };
      } catch (error) {
        if (error instanceof BuildingError) {
          const mapped = buildingErrorHttp(error);
          reply.statusCode = mapped.status;
          return mapped.body as never;
        }
        throw error;
      }
    },
  );

  typedApp.post(
    '/sites/:siteId/buildings',
    {
      preHandler: [authenticate, requireFacilities],
      schema: {
        operationId: 'createBuilding',
        tags: ['buildings'],
        summary: 'Create a Building',
        description:
          'Creates a Building under an active Site with a validated stable code and name. ' +
          'Building codes are unique within the Site.',
        security: [],
        params: z.object({ siteId: z.string().uuid() }),
        body: createBuildingBody,
        response: {
          201: buildingView,
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
        const building = await service.createBuilding({
          actorUserId: request.principal!.appUserId,
          correlationId: request.id,
          siteId: request.params.siteId,
          ...request.body,
        });
        return reply.code(201).send(building);
      } catch (error) {
        if (error instanceof BuildingError) {
          const mapped = buildingErrorHttp(error);
          reply.statusCode = mapped.status;
          return mapped.body as never;
        }
        throw error;
      }
    },
  );

  typedApp.patch(
    '/buildings/:buildingId',
    {
      preHandler: [authenticate, requireFacilities],
      schema: {
        operationId: 'updateBuilding',
        tags: ['buildings'],
        summary: 'Update a Building',
        description: 'Updates the name of an active Building. The stable code is immutable.',
        security: [],
        params: z.object({ buildingId: z.string().uuid() }),
        body: updateBuildingBody,
        response: {
          200: buildingView,
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
        return await service.updateBuilding({
          actorUserId: request.principal!.appUserId,
          correlationId: request.id,
          buildingId: request.params.buildingId,
          ...request.body,
        });
      } catch (error) {
        if (error instanceof BuildingError) {
          const mapped = buildingErrorHttp(error);
          reply.statusCode = mapped.status;
          return mapped.body as never;
        }
        throw error;
      }
    },
  );

  typedApp.post(
    '/buildings/:buildingId/archive',
    {
      preHandler: [authenticate, requireFacilities],
      schema: {
        operationId: 'archiveBuilding',
        tags: ['buildings'],
        summary: 'Archive a Building',
        description:
          'Archives an active Building without deleting historical identity. Rejected while ' +
          'active Floors remain; no cascading archive.',
        security: [],
        params: z.object({ buildingId: z.string().uuid() }),
        response: {
          200: buildingView,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          404: notFoundResponse,
          409: conflictResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        return await service.archiveBuilding({
          actorUserId: request.principal!.appUserId,
          correlationId: request.id,
          buildingId: request.params.buildingId,
        });
      } catch (error) {
        if (error instanceof BuildingError) {
          const mapped = buildingErrorHttp(error);
          reply.statusCode = mapped.status;
          return mapped.body as never;
        }
        throw error;
      }
    },
  );
};
