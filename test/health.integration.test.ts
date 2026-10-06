import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { applyMigrations } from '../src/db/migrate.js';

const databaseUrl = process.env.DATABASE_URL;

function configFor(url: string): AppConfig {
  return {
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: 3000,
    DATABASE_URL: url,
    CORS_ORIGIN: 'http://localhost:8080',
    LOG_LEVEL: 'silent',
  };
}

async function withEmptyDatabase(
  baseUrl: string,
  run: (url: string) => Promise<void>,
): Promise<void> {
  const adminUrl = new URL(baseUrl);
  adminUrl.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  const name = `dskt_empty_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  const next = new URL(baseUrl);
  next.pathname = `/${name}`;
  try {
    await run(next.toString());
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  }
}

describe('health and migrations', () => {
  const pools: pg.Pool[] = [];

  afterEach(async () => {
    await Promise.all(pools.splice(0).map((pool) => pool.end()));
  });

  it('applies the baseline migration on an empty database and separates liveness from readiness', async () => {
    expect(databaseUrl, 'DATABASE_URL is required for PostgreSQL integration tests').toBeTruthy();
    await withEmptyDatabase(databaseUrl as string, async (emptyUrl) => {
      await applyMigrations(emptyUrl);

      const check = new pg.Client({ connectionString: emptyUrl });
      await check.connect();
      const schemas = await check.query<{ schema_name: string }>(
        "select schema_name from information_schema.schemata where schema_name = 'dskt'",
      );
      await check.end();
      expect(schemas.rowCount).toBe(1);

      const pool = new pg.Pool({ connectionString: emptyUrl, max: 2 });
      pools.push(pool);
      const app = await buildApp({ config: configFor(emptyUrl), pool });
      const live = await app.inject({ method: 'GET', url: '/health/live' });
      const ready = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(live.statusCode).toBe(200);
      expect(live.json()).toEqual({ status: 'live' });
      expect(live.headers['x-correlation-id']).toEqual(expect.any(String));
      expect(ready.statusCode).toBe(200);
      expect(ready.json()).toEqual({ status: 'ready' });
      expect(JSON.stringify(ready.json())).not.toContain('postgres');
      await app.close();
      const index = pools.indexOf(pool);
      if (index !== -1) {
        pools.splice(index, 1);
      }
      await pool.end();
    });
  });

  it('reports the process live when PostgreSQL cannot be reached', async () => {
    const pool = new pg.Pool({
      connectionString: 'postgres://dskt:dskt-local-only@127.0.0.1:1/dskt',
      connectionTimeoutMillis: 500,
      max: 1,
    });
    pools.push(pool);
    const app = await buildApp({
      config: configFor('postgres://dskt:dskt-local-only@127.0.0.1:1/dskt'),
      pool,
    });
    const live = await app.inject({ method: 'GET', url: '/health/live' });
    const ready = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ status: 'live' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({ status: 'not_ready' });
    expect(ready.body).not.toContain('127.0.0.1');
    expect(ready.body).not.toContain('dskt-local-only');
    await app.close();
  });
});
