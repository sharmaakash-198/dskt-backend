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
  const name = `dskt_workforce_${randomUUID().replaceAll('-', '')}`;
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
  boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW',
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
  options?: { sheetName?: string; withFormula?: boolean; formulaRowIndex?: number },
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
      row.getCell(2).value = { formula: 'CONCAT("Formula","Injection")', result: 'FormulaInjection' };
    }
  }

  const uint8 = await wb.xlsx.writeBuffer();
  return Buffer.from(uint8);
}

describe('Ticket 21: Preview an Employee workbook', () => {
  beforeEach(() => {
    expect(databaseUrl, 'DATABASE_URL is required for employee import tests').toBeTruthy();
  });

  it('enforces that only Workplace Planner can upload workbooks', async () => {
    await withTestDatabase(databaseUrl!, async (url) => {
      const pool = createPool(url);
      const app = await buildApp({ config: configFor(url), pool });
      await app.ready();

      try {
        await seedUser(pool, { username: 'planner', password: PASSWORD, roleCodes: ['WORKPLACE_PLANNER'] });
        await seedUser(pool, { username: 'facadmin', password: PASSWORD, roleCodes: ['FACILITIES_ADMIN'] });
        await seedUser(pool, { username: 'sysadmin', password: PASSWORD, roleCodes: ['SYSTEM_ADMIN'] });
        await seedUser(pool, { username: 'viewer', password: PASSWORD, roleCodes: ['VIEWER'] });

        const plannerCookie = await signInCookie(app, 'planner');
        const facadminCookie = await signInCookie(app, 'facadmin');
        const sysadminCookie = await signInCookie(app, 'sysadmin');
        const viewerCookie = await signInCookie(app, 'viewer');

        const validBuffer = await buildWorkbookBuffer([
          { employeeId: 'EMP-001', fullName: 'Alice Smith', employmentStatus: 'ACTIVE' },
        ]);
        const multipart = createMultipartPayload('employees.xlsx', validBuffer);

        // 1. Unauthenticated -> 401
        const unauthRes = await app.inject({
          method: 'POST',
          url: '/employee-imports/preview',
          headers: multipart.headers,
          payload: multipart.payload,
        });
        expect(unauthRes.statusCode).toBe(401);

        // 2. Facilities Admin -> 403
        const facRes = await app.inject({
          method: 'POST',
          url: '/employee-imports/preview',
          headers: { ...multipart.headers, cookie: `dskt_session=${facadminCookie}` },
          payload: multipart.payload,
        });
        expect(facRes.statusCode).toBe(403);

        // 3. System Admin -> 403
        const sysRes = await app.inject({
          method: 'POST',
          url: '/employee-imports/preview',
          headers: { ...multipart.headers, cookie: `dskt_session=${sysadminCookie}` },
          payload: multipart.payload,
        });
        expect(sysRes.statusCode).toBe(403);

        // 4. Viewer -> 403
        const viewRes = await app.inject({
          method: 'POST',
          url: '/employee-imports/preview',
          headers: { ...multipart.headers, cookie: `dskt_session=${viewerCookie}` },
          payload: multipart.payload,
        });
        expect(viewRes.statusCode).toBe(403);

        // 5. Workplace Planner -> 200 OK
        const plannerRes = await app.inject({
          method: 'POST',
          url: '/employee-imports/preview',
          headers: { ...multipart.headers, cookie: `dskt_session=${plannerCookie}` },
          payload: multipart.payload,
        });
        expect(plannerRes.statusCode).toBe(200);
        const data = plannerRes.json();
        expect(data.status).toBe('READY');
        expect(data.totalRows).toBe(1);
        expect(data.createCount).toBe(1);
      } finally {
        await app.close();
        await pool.end();
      }
    });
  });

  it('rejects unsupported file formats, macro workbooks, and files with missing headers', async () => {
    await withTestDatabase(databaseUrl!, async (url) => {
      const pool = createPool(url);
      const app = await buildApp({ config: configFor(url), pool });
      await app.ready();

      try {
        await seedUser(pool, { username: 'planner', password: PASSWORD, roleCodes: ['WORKPLACE_PLANNER'] });
        const cookie = await signInCookie(app, 'planner');

        // 1. Non-xlsx file (e.g. .csv)
        const csvPayload = createMultipartPayload('employees.csv', Buffer.from('id,name,status\n1,Alice,ACTIVE'));
        const csvRes = await app.inject({
          method: 'POST',
          url: '/employee-imports/preview',
          headers: { ...csvPayload.headers, cookie: `dskt_session=${cookie}` },
          payload: csvPayload.payload,
        });
        expect(csvRes.statusCode).toBe(400);
        expect(csvRes.json().error).toBe('unsupported_file_format');

        // 2. Macro-enabled .xlsm workbook
        const xlsmPayload = createMultipartPayload('employees.xlsm', Buffer.from('dummy-xlsm'));
        const xlsmRes = await app.inject({
          method: 'POST',
          url: '/employee-imports/preview',
          headers: { ...xlsmPayload.headers, cookie: `dskt_session=${cookie}` },
          payload: xlsmPayload.payload,
        });
        expect(xlsmRes.statusCode).toBe(400);
        expect(xlsmRes.json().error).toBe('macro_not_permitted');

        // 3. Corrupted workbook
        const corruptPayload = createMultipartPayload('corrupted.xlsx', Buffer.from('not-a-valid-zip-or-excel'));
        const corruptRes = await app.inject({
          method: 'POST',
          url: '/employee-imports/preview',
          headers: { ...corruptPayload.headers, cookie: `dskt_session=${cookie}` },
          payload: corruptPayload.payload,
        });
        expect(corruptRes.statusCode).toBe(400);
        expect(corruptRes.json().error).toBe('invalid_workbook');

        // 4. Missing required headers
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet('Sheet1');
        ws.addRow(['Employee ID', 'Email']); // missing Full Name and Employment Status
        ws.addRow(['EMP-01', 'emp1@test.com']);
        const missingHeaderBuffer = Buffer.from(await wb.xlsx.writeBuffer());
        const missingHeaderPayload = createMultipartPayload('missing.xlsx', missingHeaderBuffer);
        const missingHeaderRes = await app.inject({
          method: 'POST',
          url: '/employee-imports/preview',
          headers: { ...missingHeaderPayload.headers, cookie: `dskt_session=${cookie}` },
          payload: missingHeaderPayload.payload,
        });
        expect(missingHeaderRes.statusCode).toBe(400);
        expect(missingHeaderRes.json().error).toBe('missing_required_headers');
      } finally {
        await app.close();
        await pool.end();
      }
    });
  });

  it('rejects formula cells, detects invalid rows, and persists relational staging with zero JSONB', async () => {
    await withTestDatabase(databaseUrl!, async (url) => {
      const pool = createPool(url);
      const app = await buildApp({ config: configFor(url), pool });
      await app.ready();

      try {
        await seedUser(pool, { username: 'planner', password: PASSWORD, roleCodes: ['WORKPLACE_PLANNER'] });
        const cookie = await signInCookie(app, 'planner');

        // Add an active site in database so preferred_site_code can be verified
        const orgRes = await pool.query<{ id: string }>('SELECT id FROM dskt.organizations LIMIT 1');
        await pool.query(
          `INSERT INTO dskt.sites (organization_id, code, name, time_zone) VALUES ($1, 'LON', 'London HQ', 'Europe/London')`,
          [orgRes.rows[0]!.id],
        );

        // Build workbook with:
        // Row 1: Valid row
        // Row 2: Formula injection in cell
        // Row 3: Missing Full Name
        // Row 4: Malformed Email
        // Row 5: Unknown Site Code
        const syntheticRows = [
          { employeeId: 'EMP-001', fullName: 'Alice Smith', employmentStatus: 'ACTIVE', email: 'alice@example.com', preferredSiteCode: 'LON' },
          { employeeId: 'EMP-002', fullName: 'Bob Jones', employmentStatus: 'ACTIVE' }, // will have formula injected
          { employeeId: 'EMP-003', fullName: '', employmentStatus: 'ACTIVE' }, // missing name
          { employeeId: 'EMP-004', fullName: 'Diana Prince', employmentStatus: 'ACTIVE', email: 'not-an-email' }, // bad email
          { employeeId: 'EMP-005', fullName: 'Evan Wright', employmentStatus: 'ACTIVE', preferredSiteCode: 'UNKNOWN_SITE' }, // unknown site
        ];

        const buffer = await buildWorkbookBuffer(syntheticRows, {
          withFormula: true,
          formulaRowIndex: 3, // row 3 is EMP-002
        });

        const multipart = createMultipartPayload('preview_test.xlsx', buffer);
        const res = await app.inject({
          method: 'POST',
          url: '/employee-imports/preview',
          headers: { ...multipart.headers, cookie: `dskt_session=${cookie}` },
          payload: multipart.payload,
        });

        expect(res.statusCode).toBe(200);
        const summary = res.json();
        expect(summary.totalRows).toBe(5);
        expect(summary.validRows).toBe(1);
        expect(summary.invalidRows).toBe(4);
        expect(summary.createCount).toBe(1);
        expect(summary.invalidCount).toBe(4);
        expect(summary.status).toBe('INVALID');
        expect(summary.fileSha256).toMatch(/^[a-f0-9]{64}$/);

        // Verify relational staging tables in PostgreSQL:
        // 1. Ensure NO json / jsonb column exists on dskt.employee_import_rows
        const jsonbColumnsCheck = await pool.query<{ column_name: string; data_type: string }>(`
          SELECT column_name, data_type 
          FROM information_schema.columns 
          WHERE table_schema = 'dskt' 
            AND table_name = 'employee_import_rows' 
            AND data_type IN ('json', 'jsonb')
        `);
        expect(jsonbColumnsCheck.rows.length).toBe(0);

        // 2. Verify rows in database
        const rowsQuery = await pool.query<{
          row_number: number;
          action: string;
          is_valid: boolean;
          employee_id: string;
          full_name: string;
        }>(
          `SELECT row_number, action, is_valid, employee_id, full_name FROM dskt.employee_import_rows WHERE employee_import_id = $1 ORDER BY row_number ASC`,
          [summary.id],
        );
        expect(rowsQuery.rows.length).toBe(5);

        // Row 2 is valid CREATE
        expect(rowsQuery.rows[0]!.action).toBe('CREATE');
        expect(rowsQuery.rows[0]!.is_valid).toBe(true);

        // Rows 3, 4, 5, 6 are INVALID
        expect(rowsQuery.rows[1]!.action).toBe('INVALID');
        expect(rowsQuery.rows[2]!.action).toBe('INVALID');
        expect(rowsQuery.rows[3]!.action).toBe('INVALID');
        expect(rowsQuery.rows[4]!.action).toBe('INVALID');

        // Check persisted errors
        const errorsRes = await pool.query<{ error_code: string; message: string }>(
          `SELECT e.error_code, e.message 
           FROM dskt.employee_import_row_errors e
           JOIN dskt.employee_import_rows r ON e.employee_import_row_id = r.id
           WHERE r.employee_import_id = $1
           ORDER BY r.row_number ASC`,
          [summary.id],
        );
        const codes = errorsRes.rows.map((e) => e.error_code);
        expect(codes).toContain('FORMULA_NOT_PERMITTED');
        expect(codes).toContain('MISSING_FULL_NAME');
        expect(codes).toContain('INVALID_EMAIL');
        expect(codes).toContain('UNKNOWN_SITE_CODE');

        // 3. Inspect staging rows via GET endpoint
        const getRowsRes = await app.inject({
          method: 'GET',
          url: `/employee-imports/${summary.id}/rows`,
          headers: { cookie: `dskt_session=${cookie}` },
        });
        expect(getRowsRes.statusCode).toBe(200);
        const getRowsData = getRowsRes.json();
        expect(getRowsData.totalRows).toBe(5);
        expect(getRowsData.rows.length).toBe(5);

        // Filter by action=INVALID
        const invalidRowsRes = await app.inject({
          method: 'GET',
          url: `/employee-imports/${summary.id}/rows?action=INVALID`,
          headers: { cookie: `dskt_session=${cookie}` },
        });
        expect(invalidRowsRes.statusCode).toBe(200);
        expect(invalidRowsRes.json().totalRows).toBe(4);
        expect(invalidRowsRes.json().rows.length).toBe(4);

        // Filter by action=CREATE
        const createRowsRes = await app.inject({
          method: 'GET',
          url: `/employee-imports/${summary.id}/rows?action=CREATE`,
          headers: { cookie: `dskt_session=${cookie}` },
        });
        expect(createRowsRes.statusCode).toBe(200);
        expect(createRowsRes.json().totalRows).toBe(1);
        expect(createRowsRes.json().rows[0].employeeId).toBe('EMP-001');
      } finally {
        await app.close();
        await pool.end();
      }
    });
  });

  it('accurately classifies CREATE, UPDATE, and UNCHANGED against existing employee data without mutating domain tables', async () => {
    await withTestDatabase(databaseUrl!, async (url) => {
      const pool = createPool(url);
      const app = await buildApp({ config: configFor(url), pool });
      await app.ready();

      try {
        await seedUser(pool, { username: 'planner', password: PASSWORD, roleCodes: ['WORKPLACE_PLANNER'] });
        const cookie = await signInCookie(app, 'planner');

        // Seed reference data and existing employees in domain tables
        await pool.query(`INSERT INTO dskt.departments (code, name) VALUES ('ENG', 'Engineering')`);
        await pool.query(`INSERT INTO dskt.teams (code, name) VALUES ('BACKEND', 'Backend Team')`);

        // Seed existing employee 1: will be UNCHANGED
        await pool.query(`
          INSERT INTO dskt.employees (
            employee_id, full_name, email, employment_status, job_title, active
          ) VALUES (
            'EMP-UNCHANGED', 'Carol Danvers', 'carol@example.com', 'ACTIVE', 'Staff Engineer', true
          )
        `);

        // Seed existing employee 2: will be UPDATED (job_title and active will change)
        await pool.query(`
          INSERT INTO dskt.employees (
            employee_id, full_name, email, employment_status, job_title, active
          ) VALUES (
            'EMP-UPDATE', 'Peter Parker', 'peter@example.com', 'ACTIVE', 'Junior Dev', true
          )
        `);

        // Snapshot domain tables before preview
        const countBefore = await pool.query<{ count: string }>('SELECT COUNT(*) as count FROM dskt.employees');
        expect(parseInt(countBefore.rows[0]!.count, 10)).toBe(2);

        // Upload workbook with 3 rows:
        // 1. EMP-NEW: new -> CREATE
        // 2. EMP-UNCHANGED: exact same fields -> UNCHANGED
        // 3. EMP-UPDATE: modified title ('Senior Dev') -> UPDATE
        const syntheticRows = [
          {
            employeeId: 'EMP-NEW',
            fullName: 'Miles Morales',
            employmentStatus: 'ACTIVE',
            email: 'miles@example.com',
            jobTitle: 'Apprentice',
            active: 'true',
          },
          {
            employeeId: 'EMP-UNCHANGED',
            fullName: 'Carol Danvers',
            employmentStatus: 'ACTIVE',
            email: 'carol@example.com',
            jobTitle: 'Staff Engineer',
            active: 'true',
          },
          {
            employeeId: 'EMP-UPDATE',
            fullName: 'Peter Parker',
            employmentStatus: 'ACTIVE',
            email: 'peter@example.com',
            jobTitle: 'Senior Dev', // changed
            active: 'true',
          },
        ];

        const buffer = await buildWorkbookBuffer(syntheticRows);
        const multipart = createMultipartPayload('classification_test.xlsx', buffer);

        const res = await app.inject({
          method: 'POST',
          url: '/employee-imports/preview',
          headers: { ...multipart.headers, cookie: `dskt_session=${cookie}` },
          payload: multipart.payload,
        });

        expect(res.statusCode).toBe(200);
        const summary = res.json();
        expect(summary.status).toBe('READY');
        expect(summary.totalRows).toBe(3);
        expect(summary.validRows).toBe(3);
        expect(summary.invalidRows).toBe(0);
        expect(summary.createCount).toBe(1);
        expect(summary.unchangedCount).toBe(1);
        expect(summary.updateCount).toBe(1);
        expect(summary.invalidCount).toBe(0);

        // CRUCIAL: Verify that domain tables REMAIN 100% UNCHANGED during preview!
        const countAfter = await pool.query<{ count: string }>('SELECT COUNT(*) as count FROM dskt.employees');
        expect(parseInt(countAfter.rows[0]!.count, 10)).toBe(2);

        const peterRecord = await pool.query<{ job_title: string }>(
          `SELECT job_title FROM dskt.employees WHERE employee_id = 'EMP-UPDATE'`,
        );
        expect(peterRecord.rows[0]!.job_title).toBe('Junior Dev'); // NOT 'Senior Dev'

        const milesRecord = await pool.query(
          `SELECT * FROM dskt.employees WHERE employee_id = 'EMP-NEW'`,
        );
        expect(milesRecord.rows.length).toBe(0); // NOT inserted

        // Check GET /employee-imports/:importId
        const getImportRes = await app.inject({
          method: 'GET',
          url: `/employee-imports/${summary.id}`,
          headers: { cookie: `dskt_session=${cookie}` },
        });
        expect(getImportRes.statusCode).toBe(200);
        expect(getImportRes.json().createCount).toBe(1);
        expect(getImportRes.json().updateCount).toBe(1);
        expect(getImportRes.json().unchangedCount).toBe(1);
      } finally {
        await app.close();
        await pool.end();
      }
    });
  });
});
