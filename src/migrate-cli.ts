import { loadConfig } from './config.js';
import { applyMigrations } from './db/migrate.js';

try {
  const config = loadConfig(process.env);
  await applyMigrations(config.DATABASE_URL);
  console.log('Migrations applied.');
} catch (error) {
  const message = error instanceof Error ? error.message : 'Migration failed.';
  console.error(message);
  process.exit(1);
}
