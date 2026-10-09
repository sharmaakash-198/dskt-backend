/**
 * Site HTTP routes for the location hierarchy.
 *
 * Facilities Admins may create, update, and archive Sites. Workplace Planners
 * and Viewers may list active Sites. System Admin alone has no domain access.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod/v4';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { LocalAuthProvider } from '../auth/local-provider.js';
import { requireAnyRole, requirePrincipal } from '../auth/permissions.js';
import { SiteError, SiteService } from './service.js';

const unauthorizedResponse = z
  .object({ error: z.literal('unauthorized') })
  .meta({ description: 'Not authenticated or session expired/revoked.' });

const forbiddenResponse = z
  .object({ error: z.literal('forbidden') })
  .meta({ description: 'Authenticated but missing a required application role.' });

const addressSchema = z
  .object({
    addressLine1: z.string().nullable(),
    addressLine2: z.string().nullable(),
    city: z.string().nullable(),
    region: z.string().nullable(),
    postalCode: z.string().nullable(),
    country: z.string().nullable(),
  })
  .meta({ description: 'Optional postal address fields for a Site.' });

const siteView = z
  .object({
    id: z.string().uuid(),
    code: z.string(),
    name: z.string(),
    timeZone: z.string(),
    address: addressSchema,
  })
  .meta({ description: 'Active or archived Site projection.' });

const siteListResponse = z
  .object({
    sites: z.array(siteView),
  })
  .meta({ description: 'Active Sites ordered by stable code.' });

const optionalAddressField = z.string().max(200).nullable().optional();

const createSiteBody = z.object({
  code: z.string().min(1).max(32),
  name: z.string().trim().min(1).max(200),
  timeZone: z.string().min(1).max(100),
  addressLine1: optionalAddressField,
  addressLine2: optionalAddressField,
  city: optionalAddressField,
  region: optionalAddressField,
  postalCode: optionalAddressField,
  country: optionalAddressField,
});

const updateSiteBody = z.object({
  name: z.string().trim().min(1).max(200),
  timeZone: z.string().min(1).max(100),
  addressLine1: optionalAddressField,
  addressLine2: optionalAddressField,
  city: optionalAddressField,
  region: optionalAddressField,
  postalCode: optionalAddressField,
  country: optionalAddressField,
});

const conflictResponse = z.object({
  error: z.enum(['site_code_taken', 'site_has_active_buildings', 'site_archived']),
});

const notFoundResponse = z.object({
  error: z.literal('site_not_found'),
});

const badRequestResponse = z.object({
  error: z.enum([
    'invalid_site_code',
    'invalid_site_name',
    'invalid_time_zone',
    'organization_missing',
  ]),
});

export type SiteRouteOptions = {
  provider: LocalAuthProvider;
  pool: import('pg').Pool;
};

function siteErrorHttp(error: SiteError): {
  status: 400 | 404 | 409;
  body: { error: SiteError['code'] };
} {
  switch (error.code) {
    case 'site_not_found':
      return { status: 404, body: { error: error.code } };
    case 'site_code_taken':
    case 'site_has_active_buildings':
    case 'site_archived':
      return { status: 409, body: { error: error.code } };
    case 'invalid_site_code':
    case 'invalid_site_name':
    case 'invalid_time_zone':
    case 'organization_missing':
      return { status: 400, body: { error: error.code } };
  }
}

export const siteRoutes: FastifyPluginAsync<SiteRouteOptions> = async (app, opts) => {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  const authenticate = requirePrincipal(opts.provider);
  const requireReader = requireAnyRole('FACILITIES_ADMIN', 'WORKPLACE_PLANNER', 'VIEWER');
  const requireFacilities = requireAnyRole('FACILITIES_ADMIN');
  const service = new SiteService(opts.pool);

  typedApp.get(
    '/sites',
    {
      preHandler: [authenticate, requireReader],
      schema: {
        operationId: 'listSites',
        tags: ['sites'],
        summary: 'List active Sites',
        description:
          'Lists active Arrise Sites in stable code order for Facilities Admin, ' +
          'Workplace Planner, and Viewer callers.',
        security: [],
        response: {
          200: siteListResponse,
          401: unauthorizedResponse,
          403: forbiddenResponse,
        },
      },
    },
    async () => ({ sites: await service.listActiveSites() }),
  );

  typedApp.post(
    '/sites',
    {
      preHandler: [authenticate, requireFacilities],
      schema: {
        operationId: 'createSite',
        tags: ['sites'],
        summary: 'Create a Site',
        description:
          'Creates a Site with a validated stable code, name, IANA time zone, and ' +
          'optional address fields. Site codes are unique within Arrise.',
        security: [],
        body: createSiteBody,
        response: {
          201: siteView,
          400: badRequestResponse,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          409: conflictResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        const site = await service.createSite({
          actorUserId: request.principal!.appUserId,
          correlationId: request.id,
          ...request.body,
        });
        return reply.code(201).send(site);
      } catch (error) {
        if (error instanceof SiteError) {
          const mapped = siteErrorHttp(error);
          reply.statusCode = mapped.status;
          return mapped.body as never;
        }
        throw error;
      }
    },
  );

  typedApp.patch(
    '/sites/:siteId',
    {
      preHandler: [authenticate, requireFacilities],
      schema: {
        operationId: 'updateSite',
        tags: ['sites'],
        summary: 'Update a Site',
        description:
          'Updates name, time zone, and address fields for an active Site. The stable code is immutable.',
        security: [],
        params: z.object({ siteId: z.string().uuid() }),
        body: updateSiteBody,
        response: {
          200: siteView,
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
        return await service.updateSite({
          actorUserId: request.principal!.appUserId,
          correlationId: request.id,
          siteId: request.params.siteId,
          ...request.body,
        });
      } catch (error) {
        if (error instanceof SiteError) {
          const mapped = siteErrorHttp(error);
          reply.statusCode = mapped.status;
          return mapped.body as never;
        }
        throw error;
      }
    },
  );

  typedApp.post(
    '/sites/:siteId/archive',
    {
      preHandler: [authenticate, requireFacilities],
      schema: {
        operationId: 'archiveSite',
        tags: ['sites'],
        summary: 'Archive a Site',
        description:
          'Archives an active Site without deleting historical identity. Rejected while ' +
          'active Buildings remain; no cascading archive.',
        security: [],
        params: z.object({ siteId: z.string().uuid() }),
        response: {
          200: siteView,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          404: notFoundResponse,
          409: conflictResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        return await service.archiveSite({
          actorUserId: request.principal!.appUserId,
          correlationId: request.id,
          siteId: request.params.siteId,
        });
      } catch (error) {
        if (error instanceof SiteError) {
          const mapped = siteErrorHttp(error);
          reply.statusCode = mapped.status;
          return mapped.body as never;
        }
        throw error;
      }
    },
  );
};
