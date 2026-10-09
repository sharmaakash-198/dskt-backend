/**
 * Access-administration HTTP routes (System Administrator only).
 *
 * Responses never include password hashes or session tokens.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod/v4';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { LocalAuthProvider } from '../auth/local-provider.js';
import { requireAnyRole, requirePrincipal } from '../auth/permissions.js';
import { ROLE_CODES } from '../auth/principal.js';
import {
  AccessAdminError,
  AccessAdminService,
  GRANTABLE_ROLES,
  isGrantableRole,
} from './service.js';

const unauthorizedResponse = z
  .object({ error: z.literal('unauthorized') })
  .meta({ description: 'Not authenticated or session expired/revoked.' });

const forbiddenResponse = z
  .object({ error: z.literal('forbidden') })
  .meta({ description: 'Authenticated but missing SYSTEM_ADMIN.' });

const managedUser = z
  .object({
    id: z.string().uuid(),
    email: z.string(),
    displayName: z.string(),
    active: z.boolean(),
  })
  .meta({ description: 'Application user without credentials.' });

const roleCode = z.enum(ROLE_CODES);
const grantableRole = z.enum(GRANTABLE_ROLES);

const managedUserView = z
  .object({
    user: managedUser,
    roles: z.array(roleCode),
  })
  .meta({ description: 'Application user with active role grants.' });

const userListResponse = z
  .object({
    users: z.array(managedUserView),
  })
  .meta({ description: 'Local application users visible to System Administrators.' });

const createUserBody = z.object({
  email: z.string().email().min(3),
  displayName: z.string().min(1).max(200),
  username: z.string().min(1).max(100),
  password: z.string().min(8).max(200),
});

const grantRoleBody = z.object({
  role: grantableRole,
});

const deactivateResponse = managedUserView.extend({
  editorLeasesReclaimable: z.boolean(),
});

const reclaimResponse = z
  .object({
    reclaimed: z.number().int().nonnegative(),
  })
  .meta({ description: 'Number of editor leases reclaimed for the deactivated user.' });

const conflictResponse = z.object({
  error: z.enum([
    'role_already_granted',
    'role_not_granted',
    'username_taken',
    'email_taken',
    'user_already_inactive',
    'user_still_active',
  ]),
});

const notFoundResponse = z.object({
  error: z.literal('user_not_found'),
});

const badRequestResponse = z.object({
  error: z.enum(['role_not_grantable', 'organization_missing']),
});

export type AccessAdminRouteOptions = {
  provider: LocalAuthProvider;
  pool: import('pg').Pool;
};

function accessAdminErrorHttp(error: AccessAdminError): {
  status: 400 | 404 | 409;
  body: { error: AccessAdminError['code'] };
} {
  switch (error.code) {
    case 'user_not_found':
      return { status: 404, body: { error: error.code } };
    case 'role_already_granted':
    case 'role_not_granted':
    case 'username_taken':
    case 'email_taken':
    case 'user_already_inactive':
    case 'user_still_active':
      return { status: 409, body: { error: error.code } };
    case 'role_not_grantable':
    case 'organization_missing':
      return { status: 400, body: { error: error.code } };
  }
}

export const accessAdminRoutes: FastifyPluginAsync<AccessAdminRouteOptions> = async (
  app,
  opts,
) => {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  const authenticate = requirePrincipal(opts.provider);
  const requireAdmin = requireAnyRole('SYSTEM_ADMIN');
  const service = new AccessAdminService(opts.pool);

  typedApp.get(
    '/access-admin/users',
    {
      preHandler: [authenticate, requireAdmin],
      schema: {
        operationId: 'listAccessAdminUsers',
        tags: ['access-admin'],
        summary: 'List application users',
        description:
          'Lists application users and active roles for System Administrators. ' +
          'Never returns password hashes or session tokens.',
        security: [],
        response: {
          200: userListResponse,
          401: unauthorizedResponse,
          403: forbiddenResponse,
        },
      },
    },
    async () => ({ users: await service.listUsers() }),
  );

  typedApp.post(
    '/access-admin/users',
    {
      preHandler: [authenticate, requireAdmin],
      schema: {
        operationId: 'createAccessAdminUser',
        tags: ['access-admin'],
        summary: 'Create local application user',
        description:
          'Creates a provider-neutral application user with a local identity and an ' +
          'out-of-band initial password. The password is hashed; it is never returned.',
        security: [],
        body: createUserBody,
        response: {
          201: managedUserView,
          400: badRequestResponse,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          409: conflictResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        const view = await service.createLocalUser({
          actorUserId: request.principal!.appUserId,
          correlationId: request.id,
          ...request.body,
        });
        return reply.code(201).send(view);
      } catch (error) {
        if (error instanceof AccessAdminError) {
          const mapped = accessAdminErrorHttp(error);
          reply.statusCode = mapped.status;
          return mapped.body as never;
        }
        throw error;
      }
    },
  );

  typedApp.post(
    '/access-admin/users/:userId/roles',
    {
      preHandler: [authenticate, requireAdmin],
      schema: {
        operationId: 'grantAccessAdminRole',
        tags: ['access-admin'],
        summary: 'Grant a product role',
        description:
          'Grants Facilities Admin, Workplace Planner, or Viewer. At most one active ' +
          'grant exists per user-role pair; historical grants are retained.',
        security: [],
        params: z.object({ userId: z.string().uuid() }),
        body: grantRoleBody,
        response: {
          200: managedUserView,
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
        return await service.grantRole({
          actorUserId: request.principal!.appUserId,
          correlationId: request.id,
          targetUserId: request.params.userId,
          role: request.body.role,
        });
      } catch (error) {
        if (error instanceof AccessAdminError) {
          const mapped = accessAdminErrorHttp(error);
          reply.statusCode = mapped.status;
          return mapped.body as never;
        }
        throw error;
      }
    },
  );

  typedApp.delete(
    '/access-admin/users/:userId/roles/:role',
    {
      preHandler: [authenticate, requireAdmin],
      schema: {
        operationId: 'revokeAccessAdminRole',
        tags: ['access-admin'],
        summary: 'Revoke a product role',
        description: 'Revokes an active Facilities Admin, Workplace Planner, or Viewer grant.',
        security: [],
        params: z.object({
          userId: z.string().uuid(),
          role: z.string(),
        }),
        response: {
          200: managedUserView,
          400: badRequestResponse,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          404: notFoundResponse,
          409: conflictResponse,
        },
      },
    },
    async (request, reply) => {
      if (!isGrantableRole(request.params.role)) {
        return reply.code(400).send({ error: 'role_not_grantable' });
      }
      try {
        return await service.revokeRole({
          actorUserId: request.principal!.appUserId,
          correlationId: request.id,
          targetUserId: request.params.userId,
          role: request.params.role,
        });
      } catch (error) {
        if (error instanceof AccessAdminError) {
          const mapped = accessAdminErrorHttp(error);
          reply.statusCode = mapped.status;
          return mapped.body as never;
        }
        throw error;
      }
    },
  );

  typedApp.post(
    '/access-admin/users/:userId/deactivate',
    {
      preHandler: [authenticate, requireAdmin],
      schema: {
        operationId: 'deactivateAccessAdminUser',
        tags: ['access-admin'],
        summary: 'Deactivate an application user',
        description:
          'Deactivates a user, revokes local sessions, and marks active editor leases reclaimable.',
        security: [],
        params: z.object({ userId: z.string().uuid() }),
        response: {
          200: deactivateResponse,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          404: notFoundResponse,
          409: conflictResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        return await service.deactivateUser({
          actorUserId: request.principal!.appUserId,
          correlationId: request.id,
          targetUserId: request.params.userId,
        });
      } catch (error) {
        if (error instanceof AccessAdminError) {
          const mapped = accessAdminErrorHttp(error);
          reply.statusCode = mapped.status;
          return mapped.body as never;
        }
        throw error;
      }
    },
  );

  typedApp.post(
    '/access-admin/users/:userId/editor-leases/reclaim',
    {
      preHandler: [authenticate, requireAdmin],
      schema: {
        operationId: 'reclaimAccessAdminEditorLeases',
        tags: ['access-admin'],
        summary: 'Reclaim editor leases for a deactivated user',
        description:
          'Reclaims active editor leases owned by a deactivated user so another editor may acquire them.',
        security: [],
        params: z.object({ userId: z.string().uuid() }),
        response: {
          200: reclaimResponse,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          404: notFoundResponse,
          409: conflictResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        return await service.reclaimEditorLeases({
          actorUserId: request.principal!.appUserId,
          correlationId: request.id,
          targetUserId: request.params.userId,
        });
      } catch (error) {
        if (error instanceof AccessAdminError) {
          const mapped = accessAdminErrorHttp(error);
          reply.statusCode = mapped.status;
          return mapped.body as never;
        }
        throw error;
      }
    },
  );
};
