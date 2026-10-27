import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type pg from 'pg';
import { z } from 'zod/v4';
import type { LocalAuthProvider } from '../auth/local-provider.js';
import { requireAnyRole, requirePrincipal } from '../auth/permissions.js';
import type { RoleCode } from '../auth/principal.js';
import { AssignmentService } from './service.js';
import { AssignmentError } from './types.js';

const unauthorizedResponse = z
  .object({ error: z.literal('unauthorized') })
  .meta({ description: 'Not authenticated or session expired/revoked.' });

const forbiddenResponse = z
  .object({ error: z.literal('forbidden') })
  .meta({ description: 'Caller lacks the required role.' });

const notFoundResponse = z
  .object({
    error: z.string(),
    message: z.string().optional(),
  })
  .meta({ description: 'Target entity not found.' });

const badRequestResponse = z
  .object({
    error: z.string(),
    message: z.string().optional(),
  })
  .meta({ description: 'Invalid assignment parameters or non-assignable space.' });

const conflictResponse = z
  .object({
    error: z.string(),
    message: z.string().optional(),
  })
  .meta({ description: 'Space period overlap, historical rewrite conflict, or command idempotency payload conflict.' });

export const assignmentViewSchema = z
  .object({
    id: z.string().uuid(),
    placementIdentityId: z.string().uuid(),
    employeeId: z.string().uuid(),
    employeeName: z.string(),
    employeeCode: z.string(),
    employeeEmail: z.string().email().nullable().optional(),
    departmentName: z.string().nullable().optional(),
    spaceLabel: z.string().nullable().optional(),
    floorId: z.string().uuid(),
    floorName: z.string(),
    buildingId: z.string().uuid().optional(),
    buildingName: z.string(),
    siteId: z.string().uuid().optional(),
    siteName: z.string(),
    startedAt: z.string(),
    endedAt: z.string().nullable(),
    status: z.enum(['CURRENT', 'FUTURE', 'ENDED']),
    isAccessible: z.boolean().optional(),
    assignedByUserId: z.string().uuid().optional(),
    endedByUserId: z.string().uuid().nullable().optional(),
    clientCommandId: z.string().nullable().optional(),
    createdAt: z.string(),
  })
  .meta({ description: 'Time-bounded space assignment details with employee and candidate space context.' });

export const paginatedAssignmentHistorySchema = z
  .object({
    total: z.number().int(),
    limit: z.number().int(),
    offset: z.number().int(),
    items: z.array(assignmentViewSchema),
  })
  .meta({ description: 'Paginated historical assignment records.' });

function resolveEffectiveAssignmentRole(roles: RoleCode[]): RoleCode | null {
  if (roles.includes('WORKPLACE_PLANNER')) {
    return 'WORKPLACE_PLANNER';
  }
  if (roles.includes('FACILITIES_ADMIN')) {
    return 'FACILITIES_ADMIN';
  }
  if (roles.includes('VIEWER')) {
    return 'VIEWER';
  }
  return null;
}

export const assignmentRoutes: FastifyPluginAsync<{
  provider: LocalAuthProvider;
  pool: pg.Pool;
}> = async (app, options) => {
  const service = new AssignmentService(options.pool);

  // 1. Create assignment (Workplace Planner only)
  app.withTypeProvider<ZodTypeProvider>().post(
    '/assignments',
    {
      preHandler: [
        requirePrincipal(options.provider),
        requireAnyRole('WORKPLACE_PLANNER'),
      ],
      schema: {
        operationId: 'createAssignment',
        tags: ['assignments'],
        summary: 'Assign an employee to a space',
        description:
          'Create a time-bounded space assignment for an employee to an assignable space in the active Published floor plan revision. Enforces non-overlapping periods, idempotency, and audit logging.',
        body: z.object({
          employeeId: z.string().uuid(),
          placementIdentityId: z.string().uuid(),
          startedAt: z.string(),
          endedAt: z.string().nullable().optional(),
          clientCommandId: z.string().min(1).optional(),
        }),
        response: {
          201: assignmentViewSchema,
          400: badRequestResponse,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          404: notFoundResponse,
          409: conflictResponse,
        },
      },
    },
    async (request, reply) => {
      const principal = request.principal!;
      const clientCommandId =
        request.body.clientCommandId ||
        (request.headers['x-client-command-id'] as string | undefined);

      try {
        const assignment = await service.createAssignment({
          employeeId: request.body.employeeId,
          placementIdentityId: request.body.placementIdentityId,
          startedAt: request.body.startedAt,
          endedAt: request.body.endedAt ?? null,
          clientCommandId: clientCommandId ?? null,
          actorUserId: principal.appUserId,
        });

        return reply.code(201).send(assignment);
      } catch (error) {
        if (error instanceof AssignmentError) {
          switch (error.code) {
            case 'employee_not_found':
            case 'space_not_found':
            case 'assignment_not_found':
              return reply.code(404).send({ error: error.code, message: error.message });
            case 'space_already_assigned':
            case 'assignment_already_ended':
            case 'command_id_payload_mismatch':
              return reply.code(409).send({ error: error.code, message: error.message });
            case 'unauthorized':
              return reply.code(401).send({ error: 'unauthorized' });
            case 'forbidden':
              return reply.code(403).send({ error: 'forbidden' });
            case 'invalid_assignment_period':
            case 'space_not_assignable':
            case 'revision_not_published':
            case 'location_archived':
            case 'employee_inactive':
            default:
              return reply.code(400).send({ error: error.code, message: error.message });
          }
        }
        throw error;
      }
    },
  );

  // 2. End assignment (Workplace Planner only)
  app.withTypeProvider<ZodTypeProvider>().post(
    '/assignments/:id/end',
    {
      preHandler: [
        requirePrincipal(options.provider),
        requireAnyRole('WORKPLACE_PLANNER'),
      ],
      schema: {
        operationId: 'endAssignment',
        tags: ['assignments'],
        summary: 'End an active or future assignment',
        description:
          'End an active or future space assignment at a valid timestamp while preserving original creation details and recording an audit event. Rejects attempts to silently rewrite already historical assignments.',
        params: z.object({
          id: z.string().uuid(),
        }),
        body: z.object({
          endedAt: z.string().optional(),
          clientCommandId: z.string().min(1).optional(),
        }),
        response: {
          200: assignmentViewSchema,
          400: badRequestResponse,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          404: notFoundResponse,
          409: conflictResponse,
        },
      },
    },
    async (request, reply) => {
      const principal = request.principal!;
      const clientCommandId =
        request.body.clientCommandId ||
        (request.headers['x-client-command-id'] as string | undefined);

      try {
        const assignment = await service.endAssignment({
          assignmentId: request.params.id,
          endedAt: request.body.endedAt,
          clientCommandId: clientCommandId ?? null,
          actorUserId: principal.appUserId,
        });

        return reply.code(200).send(assignment);
      } catch (error) {
        if (error instanceof AssignmentError) {
          switch (error.code) {
            case 'assignment_not_found':
            case 'employee_not_found':
            case 'space_not_found':
              return reply.code(404).send({ error: error.code, message: error.message });
            case 'assignment_already_ended':
            case 'space_already_assigned':
            case 'command_id_payload_mismatch':
              return reply.code(409).send({ error: error.code, message: error.message });
            case 'unauthorized':
              return reply.code(401).send({ error: 'unauthorized' });
            case 'forbidden':
              return reply.code(403).send({ error: 'forbidden' });
            case 'invalid_assignment_period':
            default:
              return reply.code(400).send({ error: error.code, message: error.message });
          }
        }
        throw error;
      }
    },
  );

  // 3. Paginated assignment history (Facilities Admin and Workplace Planner; Viewer forbidden)
  app.withTypeProvider<ZodTypeProvider>().get(
    '/assignments/history',
    {
      preHandler: [
        requirePrincipal(options.provider),
        requireAnyRole('FACILITIES_ADMIN', 'WORKPLACE_PLANNER'),
      ],
      schema: {
        operationId: 'getAssignmentHistory',
        tags: ['assignments'],
        summary: 'Get paginated assignment history',
        description:
          'Inspect historical assignment records with bounded pagination. Inaccessible to Viewer role.',
        querystring: z.object({
          employeeId: z.string().uuid().optional(),
          placementIdentityId: z.string().uuid().optional(),
          floorId: z.string().uuid().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(20),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        response: {
          200: paginatedAssignmentHistorySchema,
          401: unauthorizedResponse,
          403: forbiddenResponse,
        },
      },
    },
    async (request, reply) => {
      const history = await service.getAssignmentHistory(request.query);
      return reply.code(200).send(history);
    },
  );

  // 4. Query assignments (Facilities Admin, Workplace Planner, Viewer)
  app.withTypeProvider<ZodTypeProvider>().get(
    '/assignments',
    {
      preHandler: [
        requirePrincipal(options.provider),
        requireAnyRole('FACILITIES_ADMIN', 'WORKPLACE_PLANNER', 'VIEWER'),
      ],
      schema: {
        operationId: 'listAssignments',
        tags: ['assignments'],
        summary: 'List space assignments',
        description:
          'Query assignments filtered by employeeId, placementIdentityId, floorId, or status. Viewers receive strictly permitted current occupancy.',
        querystring: z.object({
          employeeId: z.string().uuid().optional(),
          placementIdentityId: z.string().uuid().optional(),
          floorId: z.string().uuid().optional(),
          status: z.enum(['CURRENT', 'FUTURE', 'ENDED', 'ALL']).optional(),
        }),
        response: {
          200: z.array(assignmentViewSchema),
          401: unauthorizedResponse,
          403: forbiddenResponse,
        },
      },
    },
    async (request, reply) => {
      const principal = request.principal!;
      const effectiveRole = resolveEffectiveAssignmentRole(principal.roles);
      if (!effectiveRole) {
        return reply.code(403).send({ error: 'forbidden' });
      }

      try {
        const assignments = await service.getAssignments(request.query, effectiveRole);
        return reply.code(200).send(assignments);
      } catch (error) {
        if (error instanceof AssignmentError && error.code === 'forbidden') {
          return reply.code(403).send({ error: 'forbidden' });
        }
        throw error;
      }
    },
  );
};
