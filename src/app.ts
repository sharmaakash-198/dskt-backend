import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod/v4';
import type { AppConfig } from './config.js';

declare module 'fastify' {
  interface FastifyInstance {
    markDraining: () => void;
  }
}

const liveResponse = z
  .object({
    status: z.literal('live'),
  })
  .meta({ description: 'The API process can serve requests.' });

const readyResponse = z
  .object({
    status: z.literal('ready'),
  })
  .meta({ description: 'Required dependencies accepted a readiness check.' });

const notReadyResponse = z
  .object({
    status: z.literal('not_ready'),
  })
  .meta({ description: 'A required dependency did not accept a readiness check.' });

export type AppDependencies = {
  config: AppConfig;
  pool: pg.Pool;
};

export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  let draining = false;
  const app = Fastify({
    logger: {
      level: deps.config.LOG_LEVEL,
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    requestIdHeader: 'x-correlation-id',
    logController: new LogController({ requestIdLogLabel: 'correlationId' }),
    genReqId: (request) => {
      const incoming = request.headers['x-correlation-id'];
      if (typeof incoming === 'string' && incoming.length > 0 && incoming.length <= 200) {
        return incoming;
      }
      return randomUUID();
    },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-correlation-id', request.id);
  });

  app.decorate('markDraining', () => {
    draining = true;
  });

  await app.register(cors, {
    origin: deps.config.CORS_ORIGIN,
    allowedHeaders: ['Content-Type', 'X-Correlation-Id'],
    exposedHeaders: ['X-Correlation-Id'],
  });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'DSKT API',
        version: '0.1.0',
        description: 'DSKT backend contract. Health operations expose no connection details.',
      },
      servers: [{ url: 'http://localhost:3000', description: 'Local backend' }],
    },
    transform: jsonSchemaTransform,
    transformObject: jsonSchemaTransformObject,
  });

  app.get(
    '/health/live',
    {
      schema: {
        operationId: 'getLiveness',
        tags: ['health'],
        summary: 'Process liveness',
        description: 'Reports whether this API process can serve. It does not check PostgreSQL.',
        security: [],
        response: {
          200: liveResponse,
        },
      },
    },
    async () => ({ status: 'live' as const }),
  );

  app.get(
    '/health/ready',
    {
      schema: {
        operationId: 'getReadiness',
        tags: ['health'],
        summary: 'Database readiness',
        description:
          'Checks that PostgreSQL accepts a query. The response contains no connection details.',
        security: [],
        response: {
          200: readyResponse,
          503: notReadyResponse,
        },
      },
    },
    async (_request, reply) => {
      if (draining) {
        return reply.code(503).send({ status: 'not_ready' });
      }
      try {
        await deps.pool.query('select 1');
        return { status: 'ready' as const };
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? String(error.code) : 'unknown';
        app.log.warn({ dependency: 'postgres', code }, 'database readiness check failed');
        return reply.code(503).send({ status: 'not_ready' });
      }
    },
  );

  app.addHook('onClose', async () => {
    draining = true;
  });

  return app;
}
