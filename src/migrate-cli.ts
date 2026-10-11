import { applyMigrations } from './db/migrate.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || !/^postgres(ql)?:\/\//.test(databaseUrl)) {
  console.error('DATABASE_URL must be set to a postgres:// URL.');
  process.exit(1);
}

try {
  await applyMigrations(databaseUrl);
  console.log('Migrations applied.');
} catch (error) {
  const message = error instanceof Error ? error.message : 'Migration failed.';
  console.error(message);
  process.exit(1);
}
