/**
 * Element Category and Template HTTP routes for the Facilities catalog.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod/v4';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { LocalAuthProvider } from '../auth/local-provider.js';
import { requireAnyRole, requirePrincipal } from '../auth/permissions.js';
import { TemplateError, TemplateService } from './service.js';

const unauthorizedResponse = z
  .object({ error: z.literal('unauthorized') })
  .meta({ description: 'Not authenticated or session expired/revoked.' });

const forbiddenResponse = z
  .object({ error: z.literal('forbidden') })
  .meta({ description: 'Authenticated but missing a required application role.' });

const categoryView = z
  .object({
    id: z.string().uuid(),
    code: z.string(),
    name: z.string(),
    sortOrder: z.number().int(),
    archivedAt: z.string().datetime().nullable(),
  })
  .meta({ description: 'Element Category projection.' });

const templateView = z
  .object({
    id: z.string().uuid(),
    categoryId: z.string().uuid(),
    code: z.string(),
    name: z.string(),
    description: z.string(),
    currentRevisionId: z.string().uuid().nullable(),
    placeable: z.boolean(),
    archivedAt: z.string().datetime().nullable(),
  })
  .meta({
    description:
      'Element Template identity. Placeable only when a current revision is selected.',
  });

const revisionView = z
  .object({
    id: z.string().uuid(),
    templateId: z.string().uuid(),
    revisionNumber: z.number().int().positive(),
    assignable: z.boolean(),
    spatialClass: z.enum(['PHYSICAL', 'ZONE', 'OBSTACLE']),
    borderColor: z.string(),
    fillColor: z.string(),
    vertices: z.array(z.object({ x: z.number().int(), y: z.number().int() })),
    isCurrent: z.boolean(),
  })
  .meta({
    description:
      'Immutable Template Revision. New revisions are not current until explicitly activated.',
  });

const categoryListResponse = z.object({ categories: z.array(categoryView) });
const templateListResponse = z.object({ templates: z.array(templateView) });
const revisionListResponse = z.object({ revisions: z.array(revisionView) });

const conflictResponse = z.object({
  error: z.enum([
    'category_code_taken',
    'category_archived',
    'template_code_taken',
    'template_archived',
  ]),
});

const notFoundResponse = z.object({
  error: z.enum(['category_not_found', 'template_not_found']),
});

const geometryDiagnostic = z.object({
  code: z.enum([
    'invalid_vertex_coordinates',
    'invalid_vertex_count',
    'non_orthogonal_edge',
    'zero_length_edge',
    'duplicate_closing_vertex',
    'repeated_vertex',
    'self_intersecting',
    'not_anticlockwise',
    'degenerate_polygon',
  ]),
  message: z.string(),
  vertexIndex: z.number().int().nonnegative().optional(),
  edgeIndex: z.number().int().nonnegative().optional(),
});

const badRequestResponse = z.object({
  error: z.enum([
    'invalid_category_code',
    'invalid_category_name',
    'invalid_category_order',
    'invalid_template_code',
    'invalid_template_name',
    'organization_missing',
    'invalid_spatial_class',
    'invalid_assignability',
    'invalid_color',
    'invalid_geometry',
  ]),
  diagnostics: z.array(geometryDiagnostic).optional(),
});

export type TemplateRouteOptions = {
  provider: LocalAuthProvider;
  pool: import('pg').Pool;
};

function templateErrorHttp(error: TemplateError): {
  status: 400 | 404 | 409;
  body: { error: TemplateError['code']; diagnostics?: TemplateError['diagnostics'] };
} {
  switch (error.code) {
    case 'category_not_found':
    case 'template_not_found':
      return { status: 404, body: { error: error.code } };
    case 'category_code_taken':
    case 'category_archived':
    case 'template_code_taken':
    case 'template_archived':
      return { status: 409, body: { error: error.code } };
    case 'invalid_geometry':
      return {
        status: 400,
        body: { error: error.code, diagnostics: error.diagnostics },
      };
    default:
      return { status: 400, body: { error: error.code } };
  }
}

export const templateRoutes: FastifyPluginAsync<TemplateRouteOptions> = async (app, opts) => {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  const authenticate = requirePrincipal(opts.provider);
  const requireReader = requireAnyRole('FACILITIES_ADMIN', 'WORKPLACE_PLANNER', 'VIEWER');
  const requireFacilities = requireAnyRole('FACILITIES_ADMIN');
  const service = new TemplateService(opts.pool);

  typedApp.get(
    '/element-categories',
    {
      preHandler: [authenticate, requireReader],
      schema: {
        operationId: 'listElementCategories',
        tags: ['templates'],
        summary: 'List active Element Categories',
        description: 'Lists active Element Categories in catalog order.',
        security: [],
        response: {
          200: categoryListResponse,
          401: unauthorizedResponse,
          403: forbiddenResponse,
        },
      },
    },
    async () => ({ categories: await service.listCategories() }),
  );

  typedApp.post(
    '/element-categories',
    {
      preHandler: [authenticate, requireFacilities],
      schema: {
        operationId: 'createElementCategory',
        tags: ['templates'],
        summary: 'Create an Element Category',
        description: 'Creates an Element Category with a stable code unique within Arrise.',
        security: [],
        body: z.object({
          code: z.string().min(1).max(32),
          name: z.string().trim().min(1).max(200),
        }),
        response: {
          201: categoryView,
          400: badRequestResponse,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          409: conflictResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        const category = await service.createCategory(request.body);
        return reply.code(201).send(category);
      } catch (error) {
        if (error instanceof TemplateError) {
          const mapped = templateErrorHttp(error);
          reply.statusCode = mapped.status;
          return mapped.body as never;
        }
        throw error;
      }
    },
  );

  typedApp.put(
    '/element-categories/order',
    {
      preHandler: [authenticate, requireFacilities],
      schema: {
        operationId: 'reorderElementCategories',
        tags: ['templates'],
        summary: 'Reorder Element Categories',
        description: 'Sets catalog order for all active Element Categories.',
        security: [],
        body: z.object({
          categoryIds: z.array(z.string().uuid()).min(0),
        }),
        response: {
          200: categoryListResponse,
          400: badRequestResponse,
          401: unauthorizedResponse,
          403: forbiddenResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        return { categories: await service.reorderCategories(request.body.categoryIds) };
      } catch (error) {
        if (error instanceof TemplateError) {
          const mapped = templateErrorHttp(error);
          reply.statusCode = mapped.status;
          return mapped.body as never;
        }
        throw error;
      }
    },
  );

  typedApp.post(
    '/element-categories/:categoryId/archive',
    {
      preHandler: [authenticate, requireFacilities],
      schema: {
        operationId: 'archiveElementCategory',
        tags: ['templates'],
        summary: 'Archive an Element Category',
        description: 'Soft-archives an Element Category without deleting history.',
        security: [],
        params: z.object({ categoryId: z.string().uuid() }),
        response: {
          200: categoryView,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          404: notFoundResponse,
          409: conflictResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        return await service.archiveCategory(request.params.categoryId);
      } catch (error) {
        if (error instanceof TemplateError) {
          const mapped = templateErrorHttp(error);
          reply.statusCode = mapped.status;
          return mapped.body as never;
        }
        throw error;
      }
    },
  );

  typedApp.get(
    '/element-categories/:categoryId/templates',
    {
      preHandler: [authenticate, requireReader],
      schema: {
        operationId: 'listElementTemplates',
        tags: ['templates'],
        summary: 'List active Element Templates in a Category',
        description: 'Lists active Template identities for a Category.',
        security: [],
        params: z.object({ categoryId: z.string().uuid() }),
        response: {
          200: templateListResponse,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          404: notFoundResponse,
          409: conflictResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        return { templates: await service.listTemplates(request.params.categoryId) };
      } catch (error) {
        if (error instanceof TemplateError) {
          const mapped = templateErrorHttp(error);
          reply.statusCode = mapped.status;
          return mapped.body as never;
        }
        throw error;
      }
    },
  );

  typedApp.post(
    '/element-categories/:categoryId/templates',
    {
      preHandler: [authenticate, requireFacilities],
      schema: {
        operationId: 'createElementTemplate',
        tags: ['templates'],
        summary: 'Create an Element Template identity',
        description:
          'Creates a Template identity with category-scoped unique code. Does not create a ' +
          'geometry revision; the Template is not placeable until a revision exists.',
        security: [],
        params: z.object({ categoryId: z.string().uuid() }),
        body: z.object({
          code: z.string().min(1).max(32),
          name: z.string().trim().min(1).max(200),
          description: z.string().max(2000).optional(),
        }),
        response: {
          201: templateView,
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
        const template = await service.createTemplate({
          categoryId: request.params.categoryId,
          ...request.body,
        });
        return reply.code(201).send(template);
      } catch (error) {
        if (error instanceof TemplateError) {
          const mapped = templateErrorHttp(error);
          reply.statusCode = mapped.status;
          return mapped.body as never;
        }
        throw error;
      }
    },
  );

  typedApp.get(
    '/element-templates/:templateId/revisions',
    {
      preHandler: [authenticate, requireReader],
      schema: {
        operationId: 'listElementTemplateRevisions',
        tags: ['templates'],
        summary: 'List Template Revisions',
        description: 'Lists immutable revisions for a Template. New revisions are not current by default.',
        security: [],
        params: z.object({ templateId: z.string().uuid() }),
        response: {
          200: revisionListResponse,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          404: notFoundResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        return { revisions: await service.listRevisions(request.params.templateId) };
      } catch (error) {
        if (error instanceof TemplateError) {
          const mapped = templateErrorHttp(error);
          reply.statusCode = mapped.status;
          return mapped.body as never;
        }
        throw error;
      }
    },
  );

  typedApp.post(
    '/element-templates/:templateId/revisions',
    {
      preHandler: [authenticate, requireFacilities],
      schema: {
        operationId: 'createElementTemplateRevision',
        tags: ['templates'],
        summary: 'Create an immutable Template Revision',
        description:
          'Atomically creates the next revision number and normalized orthogonal vertices. ' +
          'The revision is immutable and is not selected as current until activation.',
        security: [],
        params: z.object({ templateId: z.string().uuid() }),
        body: z.object({
          spatialClass: z.enum(['PHYSICAL', 'ZONE', 'OBSTACLE']),
          assignable: z.boolean(),
          borderColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
          fillColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
          vertices: z.array(z.object({ x: z.number().int(), y: z.number().int() })).min(4).max(100),
        }),
        response: {
          201: revisionView,
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
        const revision = await service.createRevision({
          actorUserId: request.principal!.appUserId,
          templateId: request.params.templateId,
          ...request.body,
        });
        return reply.code(201).send(revision);
      } catch (error) {
        if (error instanceof TemplateError) {
          const mapped = templateErrorHttp(error);
          reply.statusCode = mapped.status;
          return mapped.body as never;
        }
        throw error;
      }
    },
  );
};
