import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { buildApp } from './app.js';
import type { AppConfig } from './config.js';

const contractPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../contract/openapi.json',
);

const config: AppConfig = {
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: 3000,
  DATABASE_URL: 'postgres://dskt:local@127.0.0.1:1/dskt',
  CORS_ORIGIN: 'http://localhost:8080',
  LOG_LEVEL: 'silent',
};

const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 1 });
const app = await buildApp({ config, pool });
await app.ready();
const document = JSON.stringify(app.swagger(), null, 2) + '\n';
await app.close();
await pool.end();

const check = process.argv.includes('--check');
if (check) {
  const current = await readFile(contractPath, 'utf8');
  if (current !== document) {
    console.error('OpenAPI contract is out of date. Run npm run openapi:generate.');
    process.exit(1);
  }
  console.log('OpenAPI contract matches the routes.');
} else {
  await mkdir(path.dirname(contractPath), { recursive: true });
  await writeFile(contractPath, document);
  console.log(`Wrote ${contractPath}`);
}
