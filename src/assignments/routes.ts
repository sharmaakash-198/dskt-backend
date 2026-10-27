import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type pg from 'pg';
import { z } from 'zod/v4';
import type { LocalAuthProvider } from '../auth/local-provider.js';
import { requireAnyRole, requirePrincipal } from '../auth/permissions.js';
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
  .meta({ description: 'Space period overlap or command idempotency payload conflict.' });

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
    buildingName: z.string(),
    siteName: z.string(),
    startedAt: z.string(),
    endedAt: z.string().nullable(),
    assignedByUserId: z.string().uuid(),
    clientCommandId: z.string().nullable().optional(),
    createdAt: z.string(),
  })
  .meta({ description: 'Time-bounded space assignment details with employee and candidate space context.' });

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
              return reply.code(404).send({ error: error.code, message: error.message });
            case 'space_already_assigned':
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

  // 2. Query assignments (Facilities Admin, Workplace Planner, Viewer)
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
          'Query assignments filtered by employeeId, placementIdentityId, or floorId.',
        querystring: z.object({
          employeeId: z.string().uuid().optional(),
          placementIdentityId: z.string().uuid().optional(),
          floorId: z.string().uuid().optional(),
        }),
        response: {
          200: z.array(assignmentViewSchema),
          401: unauthorizedResponse,
          403: forbiddenResponse,
        },
      },
    },
    async (request, reply) => {
      const assignments = await service.getAssignments({
        employeeId: request.query.employeeId,
        placementIdentityId: request.query.placementIdentityId,
        floorId: request.query.floorId,
      });

      return reply.code(200).send(assignments);
    },
  );
};
