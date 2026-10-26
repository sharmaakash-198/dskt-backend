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
const SECRET = 'directory-search-test-secret-32-chars!';
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
  const name = `dskt_search_${randomUUID().replaceAll('-', '')}`;
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
      `INSERT INTO dskt.organizations (name) VALUES ('Acme Corp') ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
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
  boundary = '----WebKitFormBoundarySearchTest123',
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

async function seedDirectoryData(pool: pg.Pool) {
  const orgRes = await pool.query<{ id: string }>(
    `INSERT INTO dskt.organizations (name) VALUES ('Acme Corp') RETURNING id`,
  );
  const orgId = orgRes.rows[0]!.id;

  const siteRes = await pool.query<{ id: string }>(
    `INSERT INTO dskt.sites (organization_id, code, name, time_zone)
     VALUES ($1, 'NYC', 'New York Office', 'America/New_York')
     RETURNING id`,
    [orgId],
  );
  const siteId = siteRes.rows[0]!.id;

  const deptEngRes = await pool.query<{ id: string }>(
    `INSERT INTO dskt.departments (code, name) VALUES ('ENG', 'Engineering') RETURNING id`,
  );
  const engDeptId = deptEngRes.rows[0]!.id;

  const deptHrRes = await pool.query<{ id: string }>(
    `INSERT INTO dskt.departments (code, name) VALUES ('HR', 'Human Resources') RETURNING id`,
  );
  const hrDeptId = deptHrRes.rows[0]!.id;

  const teamFrontRes = await pool.query<{ id: string }>(
    `INSERT INTO dskt.teams (department_id, code, name) VALUES ($1, 'FE', 'Frontend Team') RETURNING id`,
    [engDeptId],
  );
  const teamFrontId = teamFrontRes.rows[0]!.id;

  const teamPeopleRes = await pool.query<{ id: string }>(
    `INSERT INTO dskt.teams (department_id, code, name) VALUES ($1, 'PEOPLE', 'People Ops') RETURNING id`,
    [hrDeptId],
  );
  const teamPeopleId = teamPeopleRes.rows[0]!.id;

  // Insert manager: Alice Smith (EMP-001)
  await pool.query(
    `INSERT INTO dskt.employees (
      employee_id, full_name, email, job_title, department_id, team_id, preferred_site_id,
      employment_status, active
    ) VALUES (
      'EMP-001', 'Alice Smith', 'alice@acme.com', 'VP Engineering', $1, $2, $3, 'FULL_TIME', true
    )`,
    [engDeptId, teamFrontId, siteId],
  );

  // Insert Bob Jones (EMP-002) reporting to Alice
  await pool.query(
    `INSERT INTO dskt.employees (
      employee_id, full_name, email, job_title, department_id, team_id, preferred_site_id,
      employment_status, active, manager_employee_id
    ) VALUES (
      'EMP-002', 'Bob Jones', 'bob@acme.com', 'Staff Engineer', $1, $2, $3, 'FULL_TIME', true, 'EMP-001'
    )`,
    [engDeptId, teamFrontId, siteId],
  );

  // Insert Charlie Brown (EMP-003) in HR
  await pool.query(
    `INSERT INTO dskt.employees (
      employee_id, full_name, email, job_title, department_id, team_id, preferred_site_id,
      employment_status, active
    ) VALUES (
      'EMP-003', 'Charlie Brown', 'charlie@acme.com', 'HR Specialist', $1, $2, $3, 'CONTRACTOR', true
    )`,
    [hrDeptId, teamPeopleId, siteId],
  );

  // Insert Inactive Employee: Dave Miller (EMP-004)
  await pool.query(
    `INSERT INTO dskt.employees (
      employee_id, full_name, email, job_title, department_id, team_id, preferred_site_id,
      employment_status, active, manager_employee_id
    ) VALUES (
      'EMP-004', 'Dave Miller', 'dave@acme.com', 'Former Engineer', $1, $2, $3, 'DEPARTED', false, 'EMP-001'
    )`,
    [engDeptId, teamFrontId, siteId],
  );
}

describe('Employee directory search and inspection (Ticket 24)', () => {
  beforeEach(() => {
    if (!databaseUrl) {
      throw new Error('DATABASE_URL environment variable is required for tests');
    }
  });

  it('verifies search matching, pagination, and role-based field projections', async () => {
    await withTestDatabase(databaseUrl!, async (url) => {
      const pool = createPool(url);
      const app = await buildApp({ config: configFor(url), pool });

      try {
        await seedDirectoryData(pool);

        await seedUser(pool, { username: 'planner', password: PASSWORD, roleCodes: ['WORKPLACE_PLANNER'] });
        await seedUser(pool, { username: 'facilities', password: PASSWORD, roleCodes: ['FACILITIES_ADMIN'] });
        await seedUser(pool, { username: 'viewer', password: PASSWORD, roleCodes: ['VIEWER'] });
        await seedUser(pool, { username: 'sysadmin', password: PASSWORD, roleCodes: ['SYSTEM_ADMIN'] });

        const plannerCookie = await signInCookie(app, 'planner');
        const facilitiesCookie = await signInCookie(app, 'facilities');
        const viewerCookie = await signInCookie(app, 'viewer');
        const sysadminCookie = await signInCookie(app, 'sysadmin');

        // 1. Authorization checks:
        // System Admin without domain role is forbidden (403)
        const sysadminRes = await app.inject({
          method: 'GET',
          url: '/employees',
          cookies: { dskt_session: sysadminCookie },
        });
        expect(sysadminRes.statusCode).toBe(403);

        // Unauthenticated is unauthorized (401)
        const unauthRes = await app.inject({
          method: 'GET',
          url: '/employees',
        });
        expect(unauthRes.statusCode).toBe(401);

        // 2. Workplace Planner search and projection:
        const plannerSearchRes = await app.inject({
          method: 'GET',
          url: '/employees?q=bob',
          cookies: { dskt_session: plannerCookie },
        });
        expect(plannerSearchRes.statusCode).toBe(200);
        const plannerData = plannerSearchRes.json();
        expect(plannerData.total).toBe(1);
        expect(plannerData.items).toHaveLength(1);
        const bobPlanner = plannerData.items[0];
        expect(bobPlanner.employeeId).toBe('EMP-002');
        expect(bobPlanner.fullName).toBe('Bob Jones');
        expect(bobPlanner.email).toBe('bob@acme.com');
        expect(bobPlanner.employmentStatus).toBe('FULL_TIME');
        expect(bobPlanner.active).toBe(true);
        expect(bobPlanner.managerEmployeeId).toBe('EMP-001');
        expect(bobPlanner.manager).toEqual({
          employeeId: 'EMP-001',
          fullName: 'Alice Smith',
        });
        expect(bobPlanner.department).toEqual(expect.objectContaining({ code: 'ENG', name: 'Engineering' }));
        expect(bobPlanner.team).toEqual(expect.objectContaining({ code: 'FE', name: 'Frontend Team' }));
        expect(bobPlanner.preferredSite).toEqual(expect.objectContaining({ code: 'NYC', name: 'New York Office' }));

        // 3. Viewer search and projection (approved directory fields only):
        const viewerSearchRes = await app.inject({
          method: 'GET',
          url: '/employees?q=bob',
          cookies: { dskt_session: viewerCookie },
        });
        expect(viewerSearchRes.statusCode).toBe(200);
        const viewerData = viewerSearchRes.json();
        expect(viewerData.total).toBe(1);
        const bobViewer = viewerData.items[0];
        expect(bobViewer.employeeId).toBe('EMP-002');
        expect(bobViewer.fullName).toBe('Bob Jones');
        expect(bobViewer.email).toBe('bob@acme.com');
        expect(bobViewer.jobTitle).toBe('Staff Engineer');
        expect(bobViewer.department).toEqual(expect.objectContaining({ code: 'ENG', name: 'Engineering' }));
        expect(bobViewer.team).toEqual(expect.objectContaining({ code: 'FE', name: 'Frontend Team' }));
        expect(bobViewer.preferredSite).toEqual(expect.objectContaining({ code: 'NYC', name: 'New York Office' }));
        // Sensitive planner-only fields must NOT be present
        expect(bobViewer.managerEmployeeId).toBeUndefined();
        expect(bobViewer.manager).toBeUndefined();
        expect(bobViewer.employmentStatus).toBeUndefined();
        expect(bobViewer.active).toBeUndefined();

        // 4. Facilities Admin search and projection (map context summary only):
        const facilitiesSearchRes = await app.inject({
          method: 'GET',
          url: '/employees?q=bob',
          cookies: { dskt_session: facilitiesCookie },
        });
        expect(facilitiesSearchRes.statusCode).toBe(200);
        const facilitiesData = facilitiesSearchRes.json();
        expect(facilitiesData.total).toBe(1);
        const bobFacilities = facilitiesData.items[0];
        expect(bobFacilities.employeeId).toBe('EMP-002');
        expect(bobFacilities.fullName).toBe('Bob Jones');
        expect(bobFacilities.jobTitle).toBe('Staff Engineer');
        expect(bobFacilities.department).toEqual(expect.objectContaining({ code: 'ENG' }));
        expect(bobFacilities.team).toEqual(expect.objectContaining({ code: 'FE' }));
        expect(bobFacilities.preferredSite).toEqual(expect.objectContaining({ code: 'NYC' }));
        // Email, manager, and employment state must NOT be present
        expect(bobFacilities.email).toBeUndefined();
        expect(bobFacilities.managerEmployeeId).toBeUndefined();
        expect(bobFacilities.manager).toBeUndefined();
        expect(bobFacilities.employmentStatus).toBeUndefined();
        expect(bobFacilities.active).toBeUndefined();

        // 5. Inactive visibility rules:
        // Default search excludes inactive employees (3 active employees total)
        const defaultListRes = await app.inject({
          method: 'GET',
          url: '/employees',
          cookies: { dskt_session: plannerCookie },
        });
        expect(defaultListRes.statusCode).toBe(200);
        expect(defaultListRes.json().total).toBe(3);

        // Planner requesting includeInactive gets all 4 employees
        const plannerInactiveRes = await app.inject({
          method: 'GET',
          url: '/employees?includeInactive=true',
          cookies: { dskt_session: plannerCookie },
        });
        expect(plannerInactiveRes.statusCode).toBe(200);
        expect(plannerInactiveRes.json().total).toBe(4);
        const dave = plannerInactiveRes.json().items.find((i: { employeeId: string }) => i.employeeId === 'EMP-004');
        expect(dave).toBeDefined();
        expect(dave.active).toBe(false);
        expect(dave.employmentStatus).toBe('DEPARTED');

        // Viewer requesting includeInactive is ignored / denied inactive visibility (still receives only 3 active)
        const viewerInactiveRes = await app.inject({
          method: 'GET',
          url: '/employees?includeInactive=true',
          cookies: { dskt_session: viewerCookie },
        });
        expect(viewerInactiveRes.statusCode).toBe(200);
        expect(viewerInactiveRes.json().total).toBe(3);
        expect(viewerInactiveRes.json().items.some((i: { employeeId: string }) => i.employeeId === 'EMP-004')).toBe(false);

        // Facilities Admin also never sees inactive employees
        const facilitiesInactiveRes = await app.inject({
          method: 'GET',
          url: '/employees?includeInactive=true',
          cookies: { dskt_session: facilitiesCookie },
        });
        expect(facilitiesInactiveRes.statusCode).toBe(200);
        expect(facilitiesInactiveRes.json().total).toBe(3);

        // 6. Direct employee inspection by ID / employeeId (/employees/:id):
        const inspectRes = await app.inject({
          method: 'GET',
          url: '/employees/EMP-002',
          cookies: { dskt_session: plannerCookie },
        });
        expect(inspectRes.statusCode).toBe(200);
        expect(inspectRes.json().employeeId).toBe('EMP-002');
        expect(inspectRes.json().manager).toEqual({
          employeeId: 'EMP-001',
          fullName: 'Alice Smith',
        });

        // Inactive inspection: Planner sees 200, Viewer sees 404
        const inspectInactivePlanner = await app.inject({
          method: 'GET',
          url: '/employees/EMP-004',
          cookies: { dskt_session: plannerCookie },
        });
        expect(inspectInactivePlanner.statusCode).toBe(200);

        const inspectInactiveViewer = await app.inject({
          method: 'GET',
          url: '/employees/EMP-004',
          cookies: { dskt_session: viewerCookie },
        });
        expect(inspectInactiveViewer.statusCode).toBe(404);

        // 7. Search criteria filtering:
        // Filter by department code 'HR'
        const hrFilterRes = await app.inject({
          method: 'GET',
          url: '/employees?departmentCode=HR',
          cookies: { dskt_session: plannerCookie },
        });
        expect(hrFilterRes.statusCode).toBe(200);
        expect(hrFilterRes.json().total).toBe(1);
        expect(hrFilterRes.json().items[0].employeeId).toBe('EMP-003');

        // Filter by team code 'FE'
        const feFilterRes = await app.inject({
          method: 'GET',
          url: '/employees?teamCode=FE',
          cookies: { dskt_session: plannerCookie },
        });
        expect(feFilterRes.statusCode).toBe(200);
        expect(feFilterRes.json().total).toBe(2);

        // Filter by site code 'NYC'
        const siteFilterRes = await app.inject({
          method: 'GET',
          url: '/employees?siteCode=NYC',
          cookies: { dskt_session: plannerCookie },
        });
        expect(siteFilterRes.statusCode).toBe(200);
        expect(siteFilterRes.json().total).toBe(3);

        // 8. Bounded pagination:
        const paginatedRes = await app.inject({
          method: 'GET',
          url: '/employees?limit=2&offset=1',
          cookies: { dskt_session: plannerCookie },
        });
        expect(paginatedRes.statusCode).toBe(200);
        expect(paginatedRes.json().total).toBe(3);
        expect(paginatedRes.json().limit).toBe(2);
        expect(paginatedRes.json().offset).toBe(1);
        expect(paginatedRes.json().items).toHaveLength(2);

        // Bounded inputs rejection
        const oversizedQueryRes = await app.inject({
          method: 'GET',
          url: `/employees?q=${'a'.repeat(101)}`,
          cookies: { dskt_session: plannerCookie },
        });
        expect(oversizedQueryRes.statusCode).toBe(400);

        const oversizedLimitRes = await app.inject({
          method: 'GET',
          url: '/employees?limit=101',
          cookies: { dskt_session: plannerCookie },
        });
        expect(oversizedLimitRes.statusCode).toBe(400);
      } finally {
        await app.close();
        await pool.end();
      }
    });
  });

  it('browser-ready flow: finding a synthetic employee after workbook preview and confirmation import', async () => {
    await withTestDatabase(databaseUrl!, async (url) => {
      const pool = createPool(url);
      const app = await buildApp({ config: configFor(url), pool });

      try {
        // Seed initial site
        const orgRes = await pool.query<{ id: string }>(
          `INSERT INTO dskt.organizations (name) VALUES ('Acme Corp') RETURNING id`,
        );
        const orgId = orgRes.rows[0]!.id;
        await pool.query(
          `INSERT INTO dskt.sites (organization_id, code, name, time_zone)
           VALUES ($1, 'NYC', 'New York Office', 'America/New_York')`,
          [orgId],
        );

        await seedUser(pool, { username: 'planner', password: PASSWORD, roleCodes: ['WORKPLACE_PLANNER'] });
        await seedUser(pool, { username: 'viewer', password: PASSWORD, roleCodes: ['VIEWER'] });

        const plannerCookie = await signInCookie(app, 'planner');
        const viewerCookie = await signInCookie(app, 'viewer');

        // 1. Build synthetic workbook
        const workbookBuffer = await buildWorkbookBuffer([
          {
            employeeId: 'EMP-SYNTH-99',
            fullName: 'Grace Hopper',
            employmentStatus: 'ACTIVE',
            email: 'grace.hopper@acme.com',
            teamCode: 'COMPILER',
            teamName: 'Compiler Tech',
            departmentCode: 'ENG',
            departmentName: 'Engineering',
            preferredSiteCode: 'NYC',
            jobTitle: 'Distinguished Architect',
            active: true,
          },
        ]);

        // 2. Upload for preview
        const multipart = createMultipartPayload('synthetic-workforce.xlsx', workbookBuffer);
        const previewRes = await app.inject({
          method: 'POST',
          url: '/employee-imports/preview',
          headers: multipart.headers,
          payload: multipart.payload,
          cookies: { dskt_session: plannerCookie },
        });
        expect(previewRes.statusCode).toBe(200);
        const previewData = previewRes.json();
        expect(previewData.status).toBe('READY');
        expect(previewData.validRows).toBe(1);

        // 3. Confirm import
        const confirmRes = await app.inject({
          method: 'POST',
          url: `/employee-imports/${previewData.id}/confirm`,
          payload: {
            expectedFileSha256: previewData.fileSha256,
          },
          cookies: { dskt_session: plannerCookie },
        });
        expect(confirmRes.statusCode).toBe(200);
        expect(confirmRes.json().status).toBe('APPLIED');

        // 4. Search directory for synthetic employee by name
        const searchByNameRes = await app.inject({
          method: 'GET',
          url: '/employees?q=Hopper',
          cookies: { dskt_session: viewerCookie },
        });
        expect(searchByNameRes.statusCode).toBe(200);
        const searchResults = searchByNameRes.json();
        expect(searchResults.total).toBe(1);
        expect(searchResults.items).toHaveLength(1);
        expect(searchResults.items[0].employeeId).toBe('EMP-SYNTH-99');
        expect(searchResults.items[0].fullName).toBe('Grace Hopper');
        expect(searchResults.items[0].email).toBe('grace.hopper@acme.com');
        expect(searchResults.items[0].jobTitle).toBe('Distinguished Architect');
        expect(searchResults.items[0].department.name).toBe('Engineering');
        expect(searchResults.items[0].team.name).toBe('Compiler Tech');
        expect(searchResults.items[0].preferredSite.code).toBe('NYC');

        // 5. Search directory by Employee ID
        const searchByIdRes = await app.inject({
          method: 'GET',
          url: '/employees?q=SYNTH-99',
          cookies: { dskt_session: plannerCookie },
        });
        expect(searchByIdRes.statusCode).toBe(200);
        expect(searchByIdRes.json().total).toBe(1);

        // 6. Inspect directly via /employees/:id
        const inspectRes = await app.inject({
          method: 'GET',
          url: '/employees/EMP-SYNTH-99',
          cookies: { dskt_session: plannerCookie },
        });
        expect(inspectRes.statusCode).toBe(200);
        expect(inspectRes.json().fullName).toBe('Grace Hopper');
        expect(inspectRes.json().employmentStatus).toBe('ACTIVE');
        expect(inspectRes.json().active).toBe(true);
      } finally {
        await app.close();
        await pool.end();
      }
    });
  });
});
