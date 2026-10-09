/**
 * Workspace entry routes.
 *
 * Each product workspace is entered through a protected operation that
 * re-checks active PostgreSQL roles. Frontend navigation is not authoritative.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod/v4';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { LocalAuthProvider } from '../auth/local-provider.js';
import { requireAnyRole, requirePrincipal } from '../auth/permissions.js';
import type { NavigationKey, RoleCode } from '../auth/principal.js';

const unauthorizedResponse = z
  .object({ error: z.literal('unauthorized') })
  .meta({ description: 'Not authenticated or session expired/revoked.' });

const forbiddenResponse = z
  .object({ error: z.literal('forbidden') })
  .meta({ description: 'Authenticated but missing the required application role.' });

const workspaceEntryResponse = z
  .object({
    workspace: z.enum(['facilities', 'workplace', 'viewer', 'access_admin']),
    title: z.string(),
    emptyState: z.string(),
  })
  .meta({ description: 'Empty role-appropriate workspace shell.' });

type WorkspaceDefinition = {
  key: NavigationKey;
  path: string;
  operationId: string;
  summary: string;
  requiredRole: RoleCode;
  title: string;
  emptyState: string;
};

const WORKSPACES: WorkspaceDefinition[] = [
  {
    key: 'facilities',
    path: '/workspace/facilities',
    operationId: 'enterFacilitiesWorkspace',
    summary: 'Enter Facilities workspace',
    requiredRole: 'FACILITIES_ADMIN',
    title: 'Facilities',
    emptyState:
      'No sites yet. Create a site to begin modeling buildings, floors, and draft plans.',
  },
  {
    key: 'workplace',
    path: '/workspace/workplace',
    operationId: 'enterWorkplaceWorkspace',
    summary: 'Enter Workplace workspace',
    requiredRole: 'WORKPLACE_PLANNER',
    title: 'Workplace',
    emptyState:
      'No published floors ready for assignment. Import employees and assign seats when maps are available.',
  },
  {
    key: 'viewer',
    path: '/workspace/viewer',
    operationId: 'enterViewerWorkspace',
    summary: 'Enter Viewer workspace',
    requiredRole: 'VIEWER',
    title: 'Viewer',
    emptyState: 'No published maps to browse yet. Search for employees once workplace data is available.',
  },
  {
    key: 'access_admin',
    path: '/workspace/access-admin',
    operationId: 'enterAccessAdminWorkspace',
    summary: 'Enter Access administration workspace',
    requiredRole: 'SYSTEM_ADMIN',
    title: 'Access administration',
    emptyState: 'Manage local users, role grants, and deactivation from this workspace.',
  },
];

export type WorkspaceRouteOptions = {
  provider: LocalAuthProvider;
};

export const workspaceRoutes: FastifyPluginAsync<WorkspaceRouteOptions> = async (app, opts) => {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  const authenticate = requirePrincipal(opts.provider);

  for (const workspace of WORKSPACES) {
    typedApp.get(
      workspace.path,
      {
        preHandler: [authenticate, requireAnyRole(workspace.requiredRole)],
        schema: {
          operationId: workspace.operationId,
          tags: ['workspace'],
          summary: workspace.summary,
          description:
            `Returns the empty ${workspace.title} workspace when the caller holds the ` +
            `${workspace.requiredRole} role. Authorization is evaluated from active PostgreSQL grants.`,
          security: [],
          response: {
            200: workspaceEntryResponse,
            401: unauthorizedResponse,
            403: forbiddenResponse,
          },
        },
      },
      async () => ({
        workspace: workspace.key,
        title: workspace.title,
        emptyState: workspace.emptyState,
      }),
    );
  }
};
