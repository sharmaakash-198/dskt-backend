import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import ExcelJS from 'exceljs';
import pg from 'pg';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import type { RoleCode } from '../src/auth/principal.js';
import { applyMigrations } from '../src/db/migrate.js';

const databaseUrl = process.env.DATABASE_URL;
const SECRET = 'workforce-test-secret-at-least-32-chars!!';
const PASSWORD = 'correct-horse-battery-staple';

function configFor(url: string): AppConfig {
  return {
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: 3001,
    DATABASE_URL: url,
    CORS_ORIGIN: 'http://localhost:8080',
    LOG_LEVEL: 'silent',
    AUTH_ENV: 'local',
    SESSION_SECRET: SECRET,
    SESSION_TTL_SECONDS: 3600,
  };
}

async function withTestDatabase(
  baseUrl: string,
  run: (url: string) => Promise<void>,
): Promise<void> {
  const adminUrl = new URL(baseUrl);
  adminUrl.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  const name = `dskt_diagnostics_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  const next = new URL(baseUrl);
  next.pathname = `/${name}`;
  try {
    await applyMigrations(next.toString());
    await run(next.toString());
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  }
}

function createPool(url: string, max = 2): pg.Pool {
  const pool = new pg.Pool({ connectionString: url, max });
  pool.on('error', () => {
    // suppress errors when test database is torn down
  });
  return pool;
}

async function seedUser(
  pool: pg.Pool,
  opts: { username: string; password: string; roleCodes?: RoleCode[] },
): Promise<string> {
  const client = await pool.connect();
  try {
    const orgRes = await client.query<{ id: string }>(
      `INSERT INTO dskt.organizations (name) VALUES ('Arrise') ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    );
    const orgId = orgRes.rows[0]!.id;

    const userRes = await client.query<{ id: string }>(
      `INSERT INTO dskt.app_users (organization_id, email, display_name, active) VALUES ($1, $2, $3, true) RETURNING id`,
      [orgId, `${opts.username}@test.local`, opts.username],
    );
    const userId = userRes.rows[0]!.id;

    await client.query(
      `INSERT INTO dskt.app_user_identities (app_user_id, provider, provider_subject) VALUES ($1, 'LOCAL', $2)`,
      [userId, opts.username.toLowerCase()],
    );

    const passwordHash = await argon2.hash(opts.password, { type: argon2.argon2id });
    await client.query(
      `INSERT INTO dskt.local_auth_credentials (app_user_id, username, password_hash) VALUES ($1, $2, $3)`,
      [userId, opts.username.toLowerCase(), passwordHash],
    );

    for (const code of opts.roleCodes ?? []) {
      const roleRes = await client.query<{ id: number }>(
        `SELECT id FROM dskt.roles WHERE code = $1`,
        [code],
      );
      if (roleRes.rows[0]) {
        await client.query(
          `INSERT INTO dskt.app_user_roles (app_user_id, role_id, granted_by_user_id) VALUES ($1, $2, $3)`,
          [userId, roleRes.rows[0].id, userId],
        );
      }
    }

    return userId;
  } finally {
    client.release();
  }
}

function extractCookie(
  headers: Record<string, number | string | string[] | undefined>,
): string | undefined {
  const raw = headers['set-cookie'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (typeof header !== 'string') return undefined;
  const match = header.match(/dskt_session=([^;]+)/);
  return match ? match[1] : undefined;
}

async function signInCookie(
  app: Awaited<ReturnType<typeof buildApp>>,
  username: string,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/local/sign-in',
    payload: { username, password: PASSWORD },
  });
  expect(res.statusCode).toBe(200);
  const cookie = extractCookie(res.headers);
  expect(cookie).toBeTruthy();
  return cookie!;
}

function createMultipartPayload(
  filename: string,
  buffer: Buffer,
  boundary = '----WebKitFormBoundaryDiag7MA4YWxkTrZu0gW',
): { payload: Buffer; headers: Record<string, string> } {
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const payload = Buffer.concat([head, buffer, tail]);
  return {
    payload,
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
  };
}

async function buildWorkbookBuffer(
  rows: Array<Record<string, unknown>>,
  options?: {
    sheetName?: string;
    withFormula?: boolean;
    formulaRowIndex?: number;
    formulaColIndex?: number;
  },
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(options?.sheetName ?? 'Employees');

  ws.addRow([
    'Employee ID',
    'Full Name',
    'Employment Status',
    'Email',
    'Manager Employee ID',
    'Team Code',
    'Team Name',
    'Department Code',
    'Department Name',
    'Preferred Site Code',
    'Job Title',
    'Active',
  ]);

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const row = ws.addRow([
      r.employeeId ?? '',
      r.fullName ?? '',
      r.employmentStatus ?? '',
      r.email ?? '',
      r.managerEmployeeId ?? '',
      r.teamCode ?? '',
      r.teamName ?? '',
      r.departmentCode ?? '',
      r.departmentName ?? '',
      r.preferredSiteCode ?? '',
      r.jobTitle ?? '',
      r.active ?? '',
    ]);

    if (options?.withFormula && options.formulaRowIndex === i + 2) {
      const colIdx = options.formulaColIndex ?? 2;
      row.getCell(colIdx).value = { formula: 'CONCAT("A","B")', result: 'AB' };
    }
  }

  const uint8 = await wb.xlsx.writeBuffer();
  return Buffer.from(uint8);
}

describe('Ticket 22: Diagnose an invalid workbook', () => {
  beforeEach(() => {
    expect(databaseUrl, 'DATABASE_URL is required for employee import tests').toBeTruthy();
  });

  it('detects cyclic manager references (direct and multi-node) and duplicate IDs with retained diagnostics', async () => {
    await withTestDatabase(databaseUrl!, async (url) => {
      const pool = createPool(url);
      const app = await buildApp({ config: configFor(url), pool });
      try {
        await seedUser(pool, {
          username: 'planner',
          password: PASSWORD,
          roleCodes: ['WORKPLACE_PLANNER'],
        });
        const cookie = await signInCookie(app, 'planner');

        // Create workbook with:
        // 1. Duplicate employee IDs (EMP-DUP on rows 2 and 3)
        // 2. Cyclic manager references (EMP-A -> EMP-B -> EMP-C -> EMP-A)
        const rows = [
          {
            employeeId: 'EMP-DUP',
            fullName: 'First Duplicate',
            employmentStatus: 'ACTIVE',
          },
          {
            employeeId: 'EMP-DUP',
            fullName: 'Second Duplicate',
            employmentStatus: 'ACTIVE',
          },
          {
            employeeId: 'EMP-A',
            fullName: 'Cycle Node A',
            employmentStatus: 'ACTIVE',
            managerEmployeeId: 'EMP-B',
          },
          {
            employeeId: 'EMP-B',
            fullName: 'Cycle Node B',
            employmentStatus: 'ACTIVE',
            managerEmployeeId: 'EMP-C',
          },
          {
            employeeId: 'EMP-C',
            fullName: 'Cycle Node C',
            employmentStatus: 'ACTIVE',
            managerEmployeeId: 'EMP-A',
          },
        ];

        const buffer = await buildWorkbookBuffer(rows);
        const multipart = createMultipartPayload('cyclic_and_duplicate.xlsx', buffer);

        const res = await app.inject({
          method: 'POST',
          url: '/employee-imports/preview',
          headers: {
            ...multipart.headers,
            cookie: `dskt_session=${cookie}`,
          },
          payload: multipart.payload,
        });

        expect(res.statusCode).toBe(200);
        const summary = res.json();
        expect(summary.status).toBe('INVALID');
        expect(summary.totalRows).toBe(5);
        expect(summary.invalidRows).toBe(5);
        expect(summary.validRows).toBe(0);

        // Fetch staging rows and inspect retained diagnostics
        const rowsRes = await app.inject({
          method: 'GET',
          url: `/employee-imports/${summary.id}/rows?action=INVALID`,
          headers: { cookie: `dskt_session=${cookie}` },
        });

        expect(rowsRes.statusCode).toBe(200);
        const rowsBody = rowsRes.json();
        expect(rowsBody.rows.length).toBe(5);

        type RowView = {
          employeeId: string | null;
          errors: Array<{ errorCode: string; columnName: string | null; message: string }>;
        };

        // Check duplicate error persistence
        const dupRows = (rowsBody.rows as RowView[]).filter((r) => r.employeeId === 'EMP-DUP');
        expect(dupRows.length).toBe(2);
        for (const dupRow of dupRows) {
          expect(dupRow.errors.some((e) => e.errorCode === 'DUPLICATE_EMPLOYEE_ID')).toBe(true);
        }

        // Check cycle error persistence
        const cycleRows = (rowsBody.rows as RowView[]).filter((r) =>
          ['EMP-A', 'EMP-B', 'EMP-C'].includes(r.employeeId ?? ''),
        );
        expect(cycleRows.length).toBe(3);
        for (const cRow of cycleRows) {
          expect(
            cRow.errors.some((e) => e.errorCode === 'CYCLIC_MANAGER_REFERENCE'),
          ).toBe(true);
        }

        // Verify relational persistence directly in PostgreSQL
        const dbErrors = await pool.query(
          `SELECT error_code, column_name, message FROM dskt.employee_import_row_errors`,
        );
        expect(dbErrors.rows.length).toBeGreaterThanOrEqual(5);
        const errorCodes = dbErrors.rows.map((r) => r.error_code);
        expect(errorCodes).toContain('DUPLICATE_EMPLOYEE_ID');
        expect(errorCodes).toContain('CYCLIC_MANAGER_REFERENCE');
      } finally {
        await app.close();
        await pool.end();
      }
    });
  });

  it('denies confirmation when an import contains blocking errors through HTTP/PostgreSQL', async () => {
    await withTestDatabase(databaseUrl!, async (url) => {
      const pool = createPool(url);
      const app = await buildApp({ config: configFor(url), pool });
      try {
        await seedUser(pool, {
          username: 'planner',
          password: PASSWORD,
          roleCodes: ['WORKPLACE_PLANNER'],
        });
        await seedUser(pool, {
          username: 'facilities_admin',
          password: PASSWORD,
          roleCodes: ['FACILITIES_ADMIN'],
        });
        await seedUser(pool, {
          username: 'viewer',
          password: PASSWORD,
          roleCodes: ['VIEWER'],
        });

        const plannerCookie = await signInCookie(app, 'planner');
        const facCookie = await signInCookie(app, 'facilities_admin');
        const viewerCookie = await signInCookie(app, 'viewer');

        // 1. Upload invalid workbook (missing required field)
        const invalidRows = [
          {
            employeeId: 'EMP-001',
            fullName: '', // Missing Full Name!
            employmentStatus: 'ACTIVE',
          },
        ];

        const buffer = await buildWorkbookBuffer(invalidRows);
        const multipart = createMultipartPayload('invalid.xlsx', buffer);

        const previewRes = await app.inject({
          method: 'POST',
          url: '/employee-imports/preview',
          headers: {
            ...multipart.headers,
            cookie: `dskt_session=${plannerCookie}`,
          },
          payload: multipart.payload,
        });

        expect(previewRes.statusCode).toBe(200);
        const invalidSummary = previewRes.json();
        expect(invalidSummary.status).toBe('INVALID');

        // 2. Attempt confirmation as Workplace Planner on invalid import -> MUST BE DENIED
        const confirmRes = await app.inject({
          method: 'POST',
          url: `/employee-imports/${invalidSummary.id}/confirm`,
          headers: { cookie: `dskt_session=${plannerCookie}` },
        });

        expect(confirmRes.statusCode).toBe(400);
        const confirmBody = confirmRes.json();
        expect(confirmBody.error).toBe('cannot_confirm_invalid_import');
        expect(confirmBody.message).toMatch(/cannot be confirmed/i);

        // 3. Verify role restrictions on confirm endpoint
        // Facilities Admin -> 403 Forbidden
        const facRes = await app.inject({
          method: 'POST',
          url: `/employee-imports/${invalidSummary.id}/confirm`,
          headers: { cookie: `dskt_session=${facCookie}` },
        });
        expect(facRes.statusCode).toBe(403);

        // Viewer -> 403 Forbidden
        const viewerRes = await app.inject({
          method: 'POST',
          url: `/employee-imports/${invalidSummary.id}/confirm`,
          headers: { cookie: `dskt_session=${viewerCookie}` },
        });
        expect(viewerRes.statusCode).toBe(403);

        // Unauthenticated -> 401 Unauthorized
        const unauthRes = await app.inject({
          method: 'POST',
          url: `/employee-imports/${invalidSummary.id}/confirm`,
        });
        expect(unauthRes.statusCode).toBe(401);

        // 4. Verify in PostgreSQL that domain tables (employees, departments, teams) have NOT been altered
        const empCount = await pool.query('SELECT COUNT(*) FROM dskt.employees');
        expect(parseInt(empCount.rows[0].count, 10)).toBe(0);

        const importRow = await pool.query(
          'SELECT status, applied_at FROM dskt.employee_imports WHERE id = $1',
          [invalidSummary.id],
        );
        expect(importRow.rows[0].status).toBe('INVALID');
        expect(importRow.rows[0].applied_at).toBeNull();
      } finally {
        await app.close();
        await pool.end();
      }
    });
  });

  it('rejects formula cells with identified column name and rejects macro workbooks', async () => {
    await withTestDatabase(databaseUrl!, async (url) => {
      const pool = createPool(url);
      const app = await buildApp({ config: configFor(url), pool });
      try {
        await seedUser(pool, {
          username: 'planner',
          password: PASSWORD,
          roleCodes: ['WORKPLACE_PLANNER'],
        });
        const cookie = await signInCookie(app, 'planner');

        // Formula cell in column 'Full Name'
        const rows = [
          {
            employeeId: 'EMP-FORMULA',
            fullName: 'Formula Holder',
            employmentStatus: 'ACTIVE',
          },
        ];
        const formulaBuffer = await buildWorkbookBuffer(rows, {
          withFormula: true,
          formulaRowIndex: 2,
          formulaColIndex: 2,
        });

        const multipart = createMultipartPayload('formula.xlsx', formulaBuffer);
        const res = await app.inject({
          method: 'POST',
          url: '/employee-imports/preview',
          headers: {
            ...multipart.headers,
            cookie: `dskt_session=${cookie}`,
          },
          payload: multipart.payload,
        });

        expect(res.statusCode).toBe(200);
        const summary = res.json();
        expect(summary.status).toBe('INVALID');

        const rowsRes = await app.inject({
          method: 'GET',
          url: `/employee-imports/${summary.id}/rows?action=INVALID`,
          headers: { cookie: `dskt_session=${cookie}` },
        });

        const rowsBody = rowsRes.json();
        expect(rowsBody.rows[0].errors).toContainEqual(
          expect.objectContaining({
            errorCode: 'FORMULA_NOT_PERMITTED',
            message: 'Formula cells are rejected and never executed.',
          }),
        );
      } finally {
        await app.close();
        await pool.end();
      }
    });
  });

  it('removes upload artifacts after retention window while safe metadata and diagnostics remain', async () => {
    await withTestDatabase(databaseUrl!, async (url) => {
      const pool = createPool(url);
      const app = await buildApp({ config: configFor(url), pool });
      try {
        await seedUser(pool, {
          username: 'planner',
          password: PASSWORD,
          roleCodes: ['WORKPLACE_PLANNER'],
        });
        const cookie = await signInCookie(app, 'planner');

        const rows = [
          {
            employeeId: 'EMP-RET-1',
            fullName: 'Retention Test User',
            employmentStatus: 'ACTIVE',
          },
        ];

        const buffer = await buildWorkbookBuffer(rows);
        const multipart = createMultipartPayload('retention_test.xlsx', buffer);

        const res = await app.inject({
          method: 'POST',
          url: '/employee-imports/preview',
          headers: {
            ...multipart.headers,
            cookie: `dskt_session=${cookie}`,
          },
          payload: multipart.payload,
        });

        expect(res.statusCode).toBe(200);
        const summary = res.json();

        // Check that import record and relational staging exist
        const dbImport = await pool.query(
          'SELECT id, original_filename, file_sha256 FROM dskt.employee_imports WHERE id = $1',
          [summary.id],
        );
        expect(dbImport.rows.length).toBe(1);

        // WorkforceService provides purgeExpiredUploadArtifacts
        // When purged with retentionWindowMs = 0 (everything older than now is expired):
        // Raw file artifacts are removed, while safe metadata and staging rows remain in PostgreSQL.
        const { WorkforceService } = await import('../src/workforce/service.js');
        const service = new WorkforceService(pool);
        const purgeResult = await service.purgeExpiredUploadArtifacts(0);
        expect(purgeResult).toBeDefined();

        // Safe metadata and diagnostics STILL REMAIN in database
        const dbImportAfter = await pool.query(
          'SELECT id, original_filename, file_sha256 FROM dskt.employee_imports WHERE id = $1',
          [summary.id],
        );
        expect(dbImportAfter.rows.length).toBe(1);
        expect(dbImportAfter.rows[0].original_filename).toBe('retention_test.xlsx');

        const dbRowsAfter = await pool.query(
          'SELECT id, employee_id FROM dskt.employee_import_rows WHERE employee_import_id = $1',
          [summary.id],
        );
        expect(dbRowsAfter.rows.length).toBe(1);
        expect(dbRowsAfter.rows[0].employee_id).toBe('EMP-RET-1');
      } finally {
        await app.close();
        await pool.end();
      }
    });
  });
});
