import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const pool = createPool(config.DATABASE_URL);
  const app = await buildApp({ config, pool });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    app.markDraining();
    await app.close();
    await pool.end();
  };

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  await app.listen({ host: config.HOST, port: config.PORT });
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : 'Startup failed.';
  console.error(message);
  process.exit(1);
}
