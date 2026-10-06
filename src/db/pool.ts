import pg from 'pg';

export function createPool(databaseUrl: string): pg.Pool {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 10_000,
  });

  pool.on('error', (_err) => {
    // Prevent unhandled errors from terminating the process when idle clients disconnect.
  });

  return pool;
}
