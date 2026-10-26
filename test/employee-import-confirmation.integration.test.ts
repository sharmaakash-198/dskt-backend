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
  const name = `dskt_confirm_${randomUUID().replaceAll('-', '')}`;
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
    // suppress connection teardown errors
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
      `INSERT INTO dskt.organizations (name) VALUES ('Arrise Corp') ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
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
  boundary = '----WebKitFormBoundaryConfirmX987123',
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
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Employees');

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

  for (const r of rows) {
    ws.addRow([
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
  }

  const arrayBuf = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuf);
}

describe('Ticket 23: Confirm an Employee import', () => {
  beforeEach(() => {
    expect(databaseUrl, 'DATABASE_URL is required for integration tests').toBeTruthy();
  });

  it('confirms a ready preview atomically: creates, updates, managers, teams, departments, sites, audit event', async () => {
    await withTestDatabase(databaseUrl!, async (url) => {
      const pool = createPool(url);
      const app = await buildApp({ config: configFor(url), pool });

      try {
        const plannerId = await seedUser(pool, {
          username: 'planner1',
          password: PASSWORD,
          roleCodes: ['WORKPLACE_PLANNER'],
        });

        // Seed an active site and existing department/team/employee
        const client = await pool.connect();
        try {
          const orgRes = await client.query<{ id: string }>('SELECT id FROM dskt.organizations LIMIT 1');
          const orgId = orgRes.rows[0]!.id;

          await client.query(`
            INSERT INTO dskt.sites (id, organization_id, name, code, time_zone)
            VALUES (gen_random_uuid(), $1, 'London HQ', 'LON', 'Europe/London')
          `, [orgId]);

          await client.query(`
            INSERT INTO dskt.departments (id, code, name)
            VALUES (gen_random_uuid(), 'EXEC', 'Executive')
          `);

          await client.query(`
            INSERT INTO dskt.employees (id, employee_id, full_name, email, employment_status, job_title, active)
            VALUES (gen_random_uuid(), 'EMP-MGR', 'Big Boss', 'boss@arrise.com', 'ACTIVE', 'CEO', true)
          `);

          // Seed existing employee to be updated
          await client.query(`
            INSERT INTO dskt.employees (id, employee_id, full_name, email, employment_status, job_title, active)
            VALUES (gen_random_uuid(), 'EMP-UPD', 'Update Target', 'upd.old@arrise.com', 'ACTIVE', 'Junior Dev', true)
          `);
        } finally {
          client.release();
        }

        const cookie = await signInCookie(app, 'planner1');

        // Workbook contains:
        // 1. EMP-001 (New, manager is EMP-002 which is defined LATER in the workbook!)
        // 2. EMP-002 (New, manager is EMP-MGR which is in DB)
        // 3. EMP-UPD (Existing, updated email and new team/department ENG / TECH)
        const wbBuffer = await buildWorkbookBuffer([
          {
            employeeId: 'EMP-001',
            fullName: 'Junior Dev One',
            employmentStatus: 'ACTIVE',
            email: 'dev1@arrise.com',
            managerEmployeeId: 'EMP-002', // Defined in next row
            teamCode: 'ENG',
            teamName: 'Engineering',
            departmentCode: 'TECH',
            departmentName: 'Technology',
            preferredSiteCode: 'LON',
            jobTitle: 'Software Engineer',
            active: 'true',
          },
          {
            employeeId: 'EMP-002',
            fullName: 'Lead Engineer',
            employmentStatus: 'ACTIVE',
            email: 'lead@arrise.com',
            managerEmployeeId: 'EMP-MGR',
            teamCode: 'ENG',
            teamName: 'Engineering',
            departmentCode: 'TECH',
            departmentName: 'Technology',
            preferredSiteCode: 'LON',
            jobTitle: 'Team Lead',
            active: 'true',
          },
          {
            employeeId: 'EMP-UPD',
            fullName: 'Update Target Promoted',
            employmentStatus: 'ACTIVE',
            email: 'upd.new@arrise.com',
            managerEmployeeId: 'EMP-002',
            teamCode: 'ENG',
            teamName: 'Engineering',
            departmentCode: 'TECH',
            departmentName: 'Technology',
            preferredSiteCode: 'LON',
            jobTitle: 'Senior Dev',
            active: 'true',
          },
        ]);

        const uploadData = createMultipartPayload('staff.xlsx', wbBuffer);
        const previewRes = await app.inject({
          method: 'POST',
          url: '/employee-imports/preview',
          headers: {
            cookie: `dskt_session=${cookie}`,
            ...uploadData.headers,
          },
          payload: uploadData.payload,
        });

        expect(previewRes.statusCode).toBe(200);
        const previewJson = previewRes.json();
        expect(previewJson.status).toBe('READY');
        expect(previewJson.createCount).toBe(2);
        expect(previewJson.updateCount).toBe(1);
        expect(previewJson.invalidCount).toBe(0);

        const importId = previewJson.id;

        // Confirm the import with idempotency key and expectedFileSha256
        const confirmRes = await app.inject({
          method: 'POST',
          url: `/employee-imports/${importId}/confirm`,
          headers: {
            cookie: `dskt_session=${cookie}`,
            'idempotency-key': 'idemp-confirm-001',
          },
          payload: {
            idempotencyKey: 'idemp-confirm-001',
            expectedFileSha256: previewJson.fileSha256,
          },
        });

        expect(confirmRes.statusCode).toBe(200);
        const confirmJson = confirmRes.json();
        expect(confirmJson.status).toBe('APPLIED');
        expect(confirmJson.appliedAt).toBeTruthy();

        // Verify PostgreSQL domain data
        const verifyClient = await pool.connect();
        try {
          // Departments and teams created
          const deptRes = await verifyClient.query<{ code: string; name: string }>(
            `SELECT code, name FROM dskt.departments WHERE code = 'TECH'`,
          );
          expect(deptRes.rows.length).toBe(1);
          expect(deptRes.rows[0]!.name).toBe('Technology');

          const teamRes = await verifyClient.query<{ code: string; name: string }>(
            `SELECT code, name FROM dskt.teams WHERE code = 'ENG'`,
          );
          expect(teamRes.rows.length).toBe(1);
          expect(teamRes.rows[0]!.name).toBe('Engineering');

          // Employees created & updated
          const emp1Res = await verifyClient.query<{
            employee_id: string;
            full_name: string;
            manager_employee_id: string;
            job_title: string;
            last_import_id: string;
          }>(`SELECT employee_id, full_name, manager_employee_id, job_title, last_import_id FROM dskt.employees WHERE employee_id = 'EMP-001'`);
          expect(emp1Res.rows.length).toBe(1);
          expect(emp1Res.rows[0]!.full_name).toBe('Junior Dev One');
          // Forward manager reference resolved correctly!
          expect(emp1Res.rows[0]!.manager_employee_id).toBe('EMP-002');
          expect(emp1Res.rows[0]!.last_import_id).toBe(importId);

          const emp2Res = await verifyClient.query<{
            manager_employee_id: string;
          }>(`SELECT manager_employee_id FROM dskt.employees WHERE employee_id = 'EMP-002'`);
          expect(emp2Res.rows[0]!.manager_employee_id).toBe('EMP-MGR');

          const updRes = await verifyClient.query<{
            full_name: string;
            email: string;
            job_title: string;
          }>(`SELECT full_name, email, job_title FROM dskt.employees WHERE employee_id = 'EMP-UPD'`);
          expect(updRes.rows[0]!.full_name).toBe('Update Target Promoted');
          expect(updRes.rows[0]!.email).toBe('upd.new@arrise.com');
          expect(updRes.rows[0]!.job_title).toBe('Senior Dev');

          // Import metadata applied
          const impRes = await verifyClient.query<{
            status: string;
            applied_at: Date | null;
            idempotency_key: string | null;
          }>(`SELECT status, applied_at, idempotency_key FROM dskt.employee_imports WHERE id = $1`, [importId]);
          expect(impRes.rows[0]!.status).toBe('APPLIED');
          expect(impRes.rows[0]!.applied_at).toBeTruthy();
          expect(impRes.rows[0]!.idempotency_key).toBe('idemp-confirm-001');

          // Audit event emitted without row contents or employee PII
          const auditRes = await verifyClient.query<{
            action: string;
            actor_user_id: string;
            target_type: string;
            target_id: string;
            summary: string;
          }>(`SELECT action, actor_user_id, target_type, target_id, summary FROM dskt.audit_events WHERE target_id = $1`, [importId]);
          expect(auditRes.rows.length).toBe(1);
          expect(auditRes.rows[0]!.action).toBe('employee_import.confirmed');
          expect(auditRes.rows[0]!.actor_user_id).toBe(plannerId);
          expect(auditRes.rows[0]!.target_type).toBe('employee_import');
          // Safe summary without employee personal names / PII rows
          expect(auditRes.rows[0]!.summary).not.toContain('Junior Dev One');
          expect(auditRes.rows[0]!.summary).not.toContain('dev1@arrise.com');
          expect(auditRes.rows[0]!.summary).toContain(importId);
        } finally {
          verifyClient.release();
        }
      } finally {
        await app.close();
        await pool.end();
      }
    });
  });

  it('leaves omitted employees active and unchanged', async () => {
    await withTestDatabase(databaseUrl!, async (url) => {
      const pool = createPool(url);
      const app = await buildApp({ config: configFor(url), pool });

      try {
        await seedUser(pool, {
          username: 'planner2',
          password: PASSWORD,
          roleCodes: ['WORKPLACE_PLANNER'],
        });

        // Seed omitted employee
        const client = await pool.connect();
        try {
          await client.query(`
            INSERT INTO dskt.employees (id, employee_id, full_name, email, employment_status, job_title, active)
            VALUES (gen_random_uuid(), 'OMITTED-001', 'Omitted Person', 'omitted@arrise.com', 'ACTIVE', 'Auditor', true)
          `);
        } finally {
          client.release();
        }

        const cookie = await signInCookie(app, 'planner2');

        // Workbook only contains EMP-NEW
        const wbBuffer = await buildWorkbookBuffer([
          {
            employeeId: 'EMP-NEW',
            fullName: 'New Person',
            employmentStatus: 'ACTIVE',
            email: 'new@arrise.com',
            active: 'true',
          },
        ]);

        const uploadData = createMultipartPayload('new_only.xlsx', wbBuffer);
        const previewRes = await app.inject({
          method: 'POST',
          url: '/employee-imports/preview',
          headers: {
            cookie: `dskt_session=${cookie}`,
            ...uploadData.headers,
          },
          payload: uploadData.payload,
        });
        const importId = previewRes.json().id;

        const confirmRes = await app.inject({
          method: 'POST',
          url: `/employee-imports/${importId}/confirm`,
          headers: { cookie: `dskt_session=${cookie}` },
        });
        expect(confirmRes.statusCode).toBe(200);

        // Verify omitted employee was NOT touched or deactivated
        const verifyClient = await pool.connect();
        try {
          const omittedRes = await verifyClient.query<{
            employee_id: string;
            full_name: string;
            active: boolean;
            last_import_id: string | null;
          }>(`SELECT employee_id, full_name, active, last_import_id FROM dskt.employees WHERE employee_id = 'OMITTED-001'`);
          expect(omittedRes.rows.length).toBe(1);
          expect(omittedRes.rows[0]!.active).toBe(true);
          expect(omittedRes.rows[0]!.full_name).toBe('Omitted Person');
          expect(omittedRes.rows[0]!.last_import_id).toBeNull();
        } finally {
          verifyClient.release();
        }
      } finally {
        await app.close();
        await pool.end();
      }
    });
  });

  it('supports idempotent retry with the same key and rejects duplicate retry with different/missing key', async () => {
    await withTestDatabase(databaseUrl!, async (url) => {
      const pool = createPool(url);
      const app = await buildApp({ config: configFor(url), pool });

      try {
        await seedUser(pool, {
          username: 'planner3',
          password: PASSWORD,
          roleCodes: ['WORKPLACE_PLANNER'],
        });

        const cookie = await signInCookie(app, 'planner3');

        const wbBuffer = await buildWorkbookBuffer([
          {
            employeeId: 'EMP-IDEMP',
            fullName: 'Idemp Test',
            employmentStatus: 'ACTIVE',
            email: 'idemp@arrise.com',
          },
        ]);

        const uploadData = createMultipartPayload('idemp.xlsx', wbBuffer);
        const previewRes = await app.inject({
          method: 'POST',
          url: '/employee-imports/preview',
          headers: {
            cookie: `dskt_session=${cookie}`,
            ...uploadData.headers,
          },
          payload: uploadData.payload,
        });
        const importId = previewRes.json().id;

        // First confirm with key
        const firstConfirm = await app.inject({
          method: 'POST',
          url: `/employee-imports/${importId}/confirm`,
          headers: {
            cookie: `dskt_session=${cookie}`,
            'idempotency-key': 'retry-key-999',
          },
        });
        expect(firstConfirm.statusCode).toBe(200);
        expect(firstConfirm.json().status).toBe('APPLIED');

        // Second confirm with SAME key -> returns 200 OK without re-applying
        const secondConfirm = await app.inject({
          method: 'POST',
          url: `/employee-imports/${importId}/confirm`,
          headers: {
            cookie: `dskt_session=${cookie}`,
            'idempotency-key': 'retry-key-999',
          },
        });
        expect(secondConfirm.statusCode).toBe(200);
        expect(secondConfirm.json().status).toBe('APPLIED');

        // Third confirm with DIFFERENT key -> 400 already_applied
        const thirdConfirm = await app.inject({
          method: 'POST',
          url: `/employee-imports/${importId}/confirm`,
          headers: {
            cookie: `dskt_session=${cookie}`,
            'idempotency-key': 'retry-key-DIFFERENT',
          },
        });
        expect(thirdConfirm.statusCode).toBe(400);
        expect(thirdConfirm.json().error).toBe('already_applied');

        // Fourth confirm with NO key -> 400 already_applied
        const fourthConfirm = await app.inject({
          method: 'POST',
          url: `/employee-imports/${importId}/confirm`,
          headers: {
            cookie: `dskt_session=${cookie}`,
          },
        });
        expect(fourthConfirm.statusCode).toBe(400);
        expect(fourthConfirm.json().error).toBe('already_applied');
      } finally {
        await app.close();
        await pool.end();
      }
    });
  });

  it('rejects stale preview when checksum mismatches or referenced site was archived', async () => {
    await withTestDatabase(databaseUrl!, async (url) => {
      const pool = createPool(url);
      const app = await buildApp({ config: configFor(url), pool });

      try {
        await seedUser(pool, {
          username: 'planner4',
          password: PASSWORD,
          roleCodes: ['WORKPLACE_PLANNER'],
        });

        const client = await pool.connect();
        let siteId: string;
        try {
          const orgRes = await client.query<{ id: string }>('SELECT id FROM dskt.organizations LIMIT 1');
          const siteRes = await client.query<{ id: string }>(`
            INSERT INTO dskt.sites (id, organization_id, name, code, time_zone)
            VALUES (gen_random_uuid(), $1, 'Paris Office', 'PAR', 'Europe/Paris')
            RETURNING id
          `, [orgRes.rows[0]!.id]);
          siteId = siteRes.rows[0]!.id;
        } finally {
          client.release();
        }

        const cookie = await signInCookie(app, 'planner4');

        const wbBuffer = await buildWorkbookBuffer([
          {
            employeeId: 'EMP-PARIS',
            fullName: 'Pierre Paris',
            employmentStatus: 'ACTIVE',
            preferredSiteCode: 'PAR',
          },
        ]);

        const uploadData = createMultipartPayload('paris.xlsx', wbBuffer);
        const previewRes = await app.inject({
          method: 'POST',
          url: '/employee-imports/preview',
          headers: {
            cookie: `dskt_session=${cookie}`,
            ...uploadData.headers,
          },
          payload: uploadData.payload,
        });
        const importId = previewRes.json().id;

        // 1. Mismatched SHA256 should be rejected with stale_preview
        const mismatchRes = await app.inject({
          method: 'POST',
          url: `/employee-imports/${importId}/confirm`,
          headers: { cookie: `dskt_session=${cookie}` },
          payload: { expectedFileSha256: '0000000000000000000000000000000000000000000000000000000000000000' },
        });
        expect(mismatchRes.statusCode).toBe(400);
        expect(mismatchRes.json().error).toBe('stale_preview');

        // 2. Archive the site before confirmation -> stale_preview
        const archClient = await pool.connect();
        try {
          await archClient.query(`UPDATE dskt.sites SET archived_at = NOW() WHERE id = $1`, [siteId]);
        } finally {
          archClient.release();
        }

        const staleSiteRes = await app.inject({
          method: 'POST',
          url: `/employee-imports/${importId}/confirm`,
          headers: { cookie: `dskt_session=${cookie}` },
        });
        expect(staleSiteRes.statusCode).toBe(400);
        expect(staleSiteRes.json().error).toBe('stale_preview');
      } finally {
        await app.close();
        await pool.end();
      }
    });
  });

  it('rolls back completely on unexpected error and leaves import in a diagnosable FAILED state', async () => {
    await withTestDatabase(databaseUrl!, async (url) => {
      const pool = createPool(url);
      const app = await buildApp({ config: configFor(url), pool });

      try {
        await seedUser(pool, {
          username: 'planner5',
          password: PASSWORD,
          roleCodes: ['WORKPLACE_PLANNER'],
        });

        const cookie = await signInCookie(app, 'planner5');

        const wbBuffer = await buildWorkbookBuffer([
          {
            employeeId: 'EMP-FAIL-1',
            fullName: 'Will Fail',
            employmentStatus: 'ACTIVE',
          },
        ]);

        const uploadData = createMultipartPayload('fail.xlsx', wbBuffer);
        const previewRes = await app.inject({
          method: 'POST',
          url: '/employee-imports/preview',
          headers: {
            cookie: `dskt_session=${cookie}`,
            ...uploadData.headers,
          },
          payload: uploadData.payload,
        });
        const importId = previewRes.json().id;

        // Install a trigger that causes an error during employee insertion
        const triggerClient = await pool.connect();
        try {
          await triggerClient.query(`
            CREATE OR REPLACE FUNCTION fail_employee_insert() RETURNS trigger AS $$
            BEGIN
              IF NEW.employee_id = 'EMP-FAIL-1' THEN
                RAISE EXCEPTION 'Simulated database failure during employee insert';
              END IF;
              RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;

            CREATE TRIGGER trg_fail_emp
            BEFORE INSERT ON dskt.employees
            FOR EACH ROW EXECUTE FUNCTION fail_employee_insert();
          `);
        } finally {
          triggerClient.release();
        }

        // Attempt confirm
        const failConfirmRes = await app.inject({
          method: 'POST',
          url: `/employee-imports/${importId}/confirm`,
          headers: { cookie: `dskt_session=${cookie}` },
        });

        // 400 or 500
        expect(failConfirmRes.statusCode).toBeGreaterThanOrEqual(400);

        // Verify total rollback of employees
        const verifyClient = await pool.connect();
        try {
          const empRes = await verifyClient.query(`SELECT * FROM dskt.employees WHERE employee_id = 'EMP-FAIL-1'`);
          expect(empRes.rows.length).toBe(0);

          // Import status is marked as FAILED (diagnosable state)
          const impRes = await verifyClient.query<{ status: string }>(
            `SELECT status FROM dskt.employee_imports WHERE id = $1`,
            [importId],
          );
          expect(impRes.rows[0]!.status).toBe('FAILED');
        } finally {
          verifyClient.release();
        }
      } finally {
        await app.close();
        await pool.end();
      }
    });
  });

  it('enforces authorization matrix for confirmation endpoint', async () => {
    await withTestDatabase(databaseUrl!, async (url) => {
      const pool = createPool(url);
      const app = await buildApp({ config: configFor(url), pool });

      try {
        await seedUser(pool, {
          username: 'planner_auth',
          password: PASSWORD,
          roleCodes: ['WORKPLACE_PLANNER'],
        });
        await seedUser(pool, {
          username: 'facilities_auth',
          password: PASSWORD,
          roleCodes: ['FACILITIES_ADMIN'],
        });
        await seedUser(pool, {
          username: 'viewer_auth',
          password: PASSWORD,
          roleCodes: ['VIEWER'],
        });

        const plannerCookie = await signInCookie(app, 'planner_auth');
        const facilitiesCookie = await signInCookie(app, 'facilities_auth');
        const viewerCookie = await signInCookie(app, 'viewer_auth');

        const wbBuffer = await buildWorkbookBuffer([
          {
            employeeId: 'EMP-AUTH-1',
            fullName: 'Auth Test',
            employmentStatus: 'ACTIVE',
          },
        ]);

        const uploadData = createMultipartPayload('auth.xlsx', wbBuffer);
        const previewRes = await app.inject({
          method: 'POST',
          url: '/employee-imports/preview',
          headers: {
            cookie: `dskt_session=${plannerCookie}`,
            ...uploadData.headers,
          },
          payload: uploadData.payload,
        });
        const importId = previewRes.json().id;

        // Facilities Admin -> 403
        const facRes = await app.inject({
          method: 'POST',
          url: `/employee-imports/${importId}/confirm`,
          headers: { cookie: `dskt_session=${facilitiesCookie}` },
        });
        expect(facRes.statusCode).toBe(403);

        // Viewer -> 403
        const viewerRes = await app.inject({
          method: 'POST',
          url: `/employee-imports/${importId}/confirm`,
          headers: { cookie: `dskt_session=${viewerCookie}` },
        });
        expect(viewerRes.statusCode).toBe(403);

        // Unauthenticated -> 401
        const unauthRes = await app.inject({
          method: 'POST',
          url: `/employee-imports/${importId}/confirm`,
        });
        expect(unauthRes.statusCode).toBe(401);

        // Planner -> 200
        const planRes = await app.inject({
          method: 'POST',
          url: `/employee-imports/${importId}/confirm`,
          headers: { cookie: `dskt_session=${plannerCookie}` },
        });
        expect(planRes.statusCode).toBe(200);
        expect(planRes.json().status).toBe('APPLIED');
      } finally {
        await app.close();
        await pool.end();
      }
    });
  });
});
