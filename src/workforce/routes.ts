import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type pg from 'pg';
import { z } from 'zod/v4';
import type { LocalAuthProvider } from '../auth/local-provider.js';
import { requireAnyRole, requirePrincipal } from '../auth/permissions.js';
import { WorkforceError, WorkforceService } from './service.js';

const unauthorizedResponse = z
  .object({ error: z.literal('unauthorized') })
  .meta({ description: 'Not authenticated or session expired/revoked.' });

const forbiddenResponse = z
  .object({ error: z.literal('forbidden') })
  .meta({ description: 'Authenticated but missing the Workplace Planner role.' });

const notFoundResponse = z
  .object({ error: z.literal('not_found') })
  .meta({ description: 'The requested employee import was not found.' });

const badRequestResponse = z
  .object({
    error: z.string(),
    message: z.string().optional(),
  })
  .meta({ description: 'Workbook validation or upload structure error.' });

const employeeImportSummarySchema = z
  .object({
    id: z.string().uuid(),
    originalFilename: z.string(),
    fileSha256: z.string(),
    status: z.enum(['VALIDATING', 'INVALID', 'READY', 'APPLYING', 'APPLIED', 'FAILED']),
    totalRows: z.number().int(),
    validRows: z.number().int(),
    invalidRows: z.number().int(),
    createCount: z.number().int(),
    updateCount: z.number().int(),
    unchangedCount: z.number().int(),
    invalidCount: z.number().int(),
    createdAt: z.string(),
    appliedAt: z.string().nullable(),
  })
  .meta({ description: 'Employee import preview metadata and summary counts.' });

const employeeImportRowErrorSchema = z
  .object({
    columnName: z.string().nullable(),
    errorCode: z.string(),
    message: z.string(),
  })
  .meta({ description: 'Specific validation error encountered for an import row.' });

const employeeImportRowViewSchema = z
  .object({
    id: z.string().uuid(),
    rowNumber: z.number().int(),
    action: z.enum(['CREATE', 'UPDATE', 'UNCHANGED', 'INVALID']),
    isValid: z.boolean(),
    employeeId: z.string().nullable(),
    fullName: z.string().nullable(),
    email: z.string().nullable(),
    employmentStatus: z.string().nullable(),
    managerEmployeeId: z.string().nullable(),
    teamCode: z.string().nullable(),
    teamName: z.string().nullable(),
    departmentCode: z.string().nullable(),
    departmentName: z.string().nullable(),
    preferredSiteCode: z.string().nullable(),
    jobTitle: z.string().nullable(),
    active: z.boolean().nullable(),
    errors: z.array(employeeImportRowErrorSchema),
  })
  .meta({ description: 'Normalized relational staging row for preview.' });

const employeeImportRowsResponseSchema = z
  .object({
    importId: z.string().uuid(),
    totalRows: z.number().int(),
    rows: z.array(employeeImportRowViewSchema),
  })
  .meta({ description: 'Paginated staging rows for an employee import.' });

export type WorkforceRoutesOptions = {
  provider: LocalAuthProvider;
  pool: pg.Pool;
};

export const workforceRoutes: FastifyPluginAsync<WorkforceRoutesOptions> = async (
  app,
  options,
) => {
  const service = new WorkforceService(options.pool);

  // 1. Upload workbook for preview
  app.withTypeProvider<ZodTypeProvider>().post(
    '/employee-imports/preview',
    {
      preHandler: [requirePrincipal(options.provider), requireAnyRole('WORKPLACE_PLANNER')],
      schema: {
        operationId: 'previewEmployeeWorkbook',
        tags: ['workforce'],
        summary: 'Preview an employee workbook',
        description:
          'Upload a bounded .xlsx workbook to generate a preview of proposed employee changes without altering domain data.',
        response: {
          200: employeeImportSummarySchema,
          400: badRequestResponse,
          401: unauthorizedResponse,
          403: forbiddenResponse,
        },
      },
    },
    async (request, reply) => {
      const principal = request.principal!;

      const fileData = await request.file();
      if (!fileData) {
        return reply.code(400).send({
          error: 'missing_file',
          message: 'An Excel workbook file (.xlsx) must be provided in the multipart request.',
        });
      }

      const originalFilename = fileData.filename;
      const buffer = await fileData.toBuffer();

      try {
        const summary = await service.previewEmployeeWorkbook(
          principal.appUserId,
          originalFilename,
          buffer,
        );

        request.log.info(
          {
            importId: summary.id,
            fileSha256: summary.fileSha256,
            totalRows: summary.totalRows,
            validRows: summary.validRows,
            invalidRows: summary.invalidRows,
            uploadedByUserId: principal.appUserId,
          },
          'Employee workbook preview generated',
        );

        return reply.code(200).send(summary);
      } catch (error) {
        if (error instanceof WorkforceError) {
          return reply.code(400).send({
            error: error.code,
            message: error.message,
          });
        }
        throw error;
      }
    },
  );

  // 2. Get import summary
  app.withTypeProvider<ZodTypeProvider>().get(
    '/employee-imports/:importId',
    {
      preHandler: [requirePrincipal(options.provider), requireAnyRole('WORKPLACE_PLANNER')],
      schema: {
        operationId: 'getEmployeeImport',
        tags: ['workforce'],
        summary: 'Get employee import summary',
        description: 'Retrieve preview metadata and summary counts for an import.',
        params: z.object({
          importId: z.string().uuid(),
        }),
        response: {
          200: employeeImportSummarySchema,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          404: notFoundResponse,
        },
      },
    },
    async (request, reply) => {
      const summary = await service.getImport(request.params.importId);
      if (!summary) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return reply.code(200).send(summary);
    },
  );

  // 3. List import staging rows
  app.withTypeProvider<ZodTypeProvider>().get(
    '/employee-imports/:importId/rows',
    {
      preHandler: [requirePrincipal(options.provider), requireAnyRole('WORKPLACE_PLANNER')],
      schema: {
        operationId: 'listEmployeeImportRows',
        tags: ['workforce'],
        summary: 'List employee import staging rows',
        description:
          'List normalized relational staging rows for preview with optional action filter and pagination.',
        params: z.object({
          importId: z.string().uuid(),
        }),
        querystring: z.object({
          action: z.enum(['ALL', 'CREATE', 'UPDATE', 'UNCHANGED', 'INVALID']).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
          offset: z.coerce.number().int().min(0).optional(),
        }),
        response: {
          200: employeeImportRowsResponseSchema,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          404: notFoundResponse,
        },
      },
    },
    async (request, reply) => {
      const importRecord = await service.getImport(request.params.importId);
      if (!importRecord) {
        return reply.code(404).send({ error: 'not_found' });
      }

      const { totalRows, rows } = await service.listImportRows(
        request.params.importId,
        request.query,
      );

      return reply.code(200).send({
        importId: request.params.importId,
        totalRows,
        rows,
      });
    },
  );

  // 4. Confirm employee import (atomically applies proposed employee changes)
  app.withTypeProvider<ZodTypeProvider>().post(
    '/employee-imports/:importId/confirm',
    {
      preHandler: [requirePrincipal(options.provider), requireAnyRole('WORKPLACE_PLANNER')],
      schema: {
        operationId: 'confirmEmployeeImport',
        tags: ['workforce'],
        summary: 'Confirm employee import',
        description:
          'Confirm a ready employee import preview and atomically apply all proposed employee changes. Rejects invalid, stale, or already applied imports.',
        params: z.object({
          importId: z.string().uuid(),
        }),
        body: z
          .object({
            idempotencyKey: z.string().min(1).max(255).optional(),
            expectedFileSha256: z.string().optional(),
          })
          .nullable()
          .optional(),
        response: {
          200: employeeImportSummarySchema,
          400: badRequestResponse,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          404: notFoundResponse,
        },
      },
    },
    async (request, reply) => {
      const principal = request.principal!;
      const idempotencyKey =
        (request.headers['idempotency-key'] as string | undefined) ||
        request.body?.idempotencyKey;
      const expectedFileSha256 = request.body?.expectedFileSha256;

      try {
        const summary = await service.confirmImport(
          request.params.importId,
          principal.appUserId,
          {
            idempotencyKey,
            expectedFileSha256,
          },
        );

        request.log.info(
          {
            importId: summary.id,
            status: summary.status,
            confirmedByUserId: principal.appUserId,
            totalRows: summary.totalRows,
            createCount: summary.createCount,
            updateCount: summary.updateCount,
          },
          'Employee import confirmed',
        );

        return reply.code(200).send(summary);
      } catch (error) {
        if (error instanceof WorkforceError) {
          if (error.code === 'not_found') {
            return reply.code(404).send({ error: 'not_found' });
          }
          return reply.code(400).send({
            error: error.code,
            message: error.message,
          });
        }
        throw error;
      }
    },
  );
};
