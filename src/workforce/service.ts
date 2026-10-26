import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import type pg from 'pg';

export class WorkforceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'WorkforceError';
  }
}

export type RowError = {
  columnName: string | null;
  errorCode: string;
  message: string;
};

export type ParsedRow = {
  rowNumber: number;
  action: 'CREATE' | 'UPDATE' | 'UNCHANGED' | 'INVALID';
  isValid: boolean;
  employeeId: string | null;
  fullName: string | null;
  email: string | null;
  employmentStatus: string | null;
  managerEmployeeId: string | null;
  teamCode: string | null;
  teamName: string | null;
  departmentCode: string | null;
  departmentName: string | null;
  preferredSiteCode: string | null;
  jobTitle: string | null;
  active: boolean | null;
  errors: RowError[];
};

export type EmployeeImportSummary = {
  id: string;
  originalFilename: string;
  fileSha256: string;
  status: 'VALIDATING' | 'INVALID' | 'READY' | 'APPLYING' | 'APPLIED' | 'FAILED';
  totalRows: number;
  validRows: number;
  invalidRows: number;
  createCount: number;
  updateCount: number;
  unchangedCount: number;
  invalidCount: number;
  createdAt: string;
  appliedAt: string | null;
};

export type EmployeeImportRowView = {
  id: string;
  rowNumber: number;
  action: 'CREATE' | 'UPDATE' | 'UNCHANGED' | 'INVALID';
  isValid: boolean;
  employeeId: string | null;
  fullName: string | null;
  email: string | null;
  employmentStatus: string | null;
  managerEmployeeId: string | null;
  teamCode: string | null;
  teamName: string | null;
  departmentCode: string | null;
  departmentName: string | null;
  preferredSiteCode: string | null;
  jobTitle: string | null;
  active: boolean | null;
  errors: RowError[];
};

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_ROW_COUNT = 5_000;

const VALID_EMPLOYMENT_STATUSES = new Set([
  'ACTIVE',
  'INACTIVE',
  'TERMINATED',
  'DEPARTED',
  'ON_LEAVE',
  'CONTRACTOR',
  'PROBATION',
]);

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function getCellString(cell: ExcelJS.Cell): string {
  if (cell.value === null || cell.value === undefined) {
    return '';
  }
  if (typeof cell.value === 'object') {
    if ('text' in cell.value && typeof cell.value.text === 'string') {
      return cell.value.text.trim();
    }
    if ('result' in cell.value && cell.value.result !== null && cell.value.result !== undefined) {
      return String(cell.value.result).trim();
    }
  }
  return String(cell.value).trim();
}

function parseBoolean(val: string): boolean | null {
  const lower = val.toLowerCase().trim();
  if (['true', '1', 'yes', 'y'].includes(lower)) return true;
  if (['false', '0', 'no', 'n'].includes(lower)) return false;
  return null;
}

export const DEFAULT_OPERATIONAL_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours

export class WorkforceService {
  private readonly uploadArtifactsDir: string;

  constructor(
    private readonly pool: pg.Pool,
    options?: { uploadArtifactsDir?: string },
  ) {
    this.uploadArtifactsDir =
      options?.uploadArtifactsDir ??
      path.resolve(process.cwd(), '.uploads/workforce');
  }

  async saveUploadArtifact(importId: string, buffer: Buffer): Promise<string> {
    await mkdir(this.uploadArtifactsDir, { recursive: true });
    const filePath = path.join(this.uploadArtifactsDir, `${importId}.xlsx`);
    await writeFile(filePath, buffer);
    return filePath;
  }

  /**
   * Remove raw upload artifacts older than the documented operational retention window.
   * Safe metadata in dskt.employee_imports and relational diagnostics in
   * dskt.employee_import_row_errors remain permanently retained for auditing and analysis.
   */
  async purgeExpiredUploadArtifacts(
    retentionWindowMs = DEFAULT_OPERATIONAL_RETENTION_MS,
  ): Promise<{ purgedCount: number; remainingCount: number }> {
    try {
      await mkdir(this.uploadArtifactsDir, { recursive: true });
      const files = await readdir(this.uploadArtifactsDir);
      const now = Date.now();
      let purgedCount = 0;
      let remainingCount = 0;

      for (const file of files) {
        if (!file.endsWith('.xlsx')) continue;
        const filePath = path.join(this.uploadArtifactsDir, file);
        try {
          const fileStat = await stat(filePath);
          const ageMs = now - fileStat.mtimeMs;
          if (ageMs >= retentionWindowMs) {
            await unlink(filePath);
            purgedCount++;
          } else {
            remainingCount++;
          }
        } catch {
          // File might have been concurrently deleted
        }
      }

      return { purgedCount, remainingCount };
    } catch {
      return { purgedCount: 0, remainingCount: 0 };
    }
  }

  /**
   * Attempt confirmation of an import. Denies confirmation if the import has any
   * blocking errors, is not in a READY state, or was already applied.
   */
  async confirmImport(importId: string): Promise<EmployeeImportSummary> {
    const importRecord = await this.getImport(importId);
    if (!importRecord) {
      throw new WorkforceError('not_found', 'Employee import not found.');
    }
    if (importRecord.status === 'INVALID' || importRecord.invalidRows > 0) {
      throw new WorkforceError(
        'cannot_confirm_invalid_import',
        'An import with blocking errors cannot be confirmed.',
      );
    }
    if (importRecord.status === 'APPLIED') {
      throw new WorkforceError('already_applied', 'Import has already been applied.');
    }
    if (importRecord.status !== 'READY') {
      throw new WorkforceError(
        'import_not_ready',
        'Import is not in a ready state for confirmation.',
      );
    }
    return importRecord;
  }

  /**
   * Parse and validate an uploaded employee workbook, storing normalized relational
   * staging rows and returning preview summary counts without altering domain data.
   */
  async previewEmployeeWorkbook(
    uploadedByUserId: string,
    originalFilename: string,
    buffer: Buffer,
  ): Promise<EmployeeImportSummary> {
    // 1. Extension & file bounds validation
    const lowerName = originalFilename.toLowerCase();
    if (!lowerName.endsWith('.xlsx')) {
      if (lowerName.endsWith('.xlsm')) {
        throw new WorkforceError(
          'macro_not_permitted',
          'Macro-enabled workbooks (.xlsm) are rejected and never executed.',
        );
      }
      throw new WorkforceError(
        'unsupported_file_format',
        'Only .xlsx workbooks are supported.',
      );
    }

    if (buffer.length > MAX_FILE_SIZE_BYTES) {
      throw new WorkforceError(
        'file_too_large',
        `Workbook exceeds maximum allowed size of 5 MB (${buffer.length} bytes).`,
      );
    }

    // Check for macro signatures inside the zip archive
    if (buffer.includes(Buffer.from('vbaProject.bin'))) {
      throw new WorkforceError(
        'macro_not_permitted',
        'Macro-enabled workbooks are rejected and never executed.',
      );
    }

    // 2. Compute SHA-256
    const fileSha256 = createHash('sha256').update(buffer).digest('hex');

    // 3. Load Excel workbook
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(
        buffer as unknown as Parameters<typeof workbook.xlsx.load>[0],
      );
    } catch {
      throw new WorkforceError(
        'invalid_workbook',
        'Unable to parse workbook. The file may be corrupted or not a valid .xlsx file.',
      );
    }

    if (workbook.worksheets.length === 0) {
      throw new WorkforceError('empty_workbook', 'Workbook contains no worksheets.');
    }

    const worksheet =
      workbook.worksheets.find(
        (ws) => ws.name.toLowerCase() === 'employees' || ws.name.toLowerCase() === 'employee',
      ) ?? workbook.worksheets[0]!;

    if (worksheet.rowCount < 2) {
      throw new WorkforceError(
        'empty_worksheet',
        'Worksheet contains no data rows.',
      );
    }

    // 4. Map Header Row
    const headerRow = worksheet.getRow(1);
    const headerMap = new Map<string, number>(); // fieldKey -> colNumber

    headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const text = getCellString(cell).toLowerCase().replace(/[\s_-]+/g, '');
      if (text === 'employeeid') headerMap.set('employeeId', colNumber);
      else if (text === 'fullname' || text === 'name') headerMap.set('fullName', colNumber);
      else if (text === 'employmentstatus' || text === 'status')
        headerMap.set('employmentStatus', colNumber);
      else if (text === 'email') headerMap.set('email', colNumber);
      else if (text === 'manageremployeeid' || text === 'managerid')
        headerMap.set('managerEmployeeId', colNumber);
      else if (text === 'teamcode') headerMap.set('teamCode', colNumber);
      else if (text === 'teamname') headerMap.set('teamName', colNumber);
      else if (text === 'departmentcode') headerMap.set('departmentCode', colNumber);
      else if (text === 'departmentname') headerMap.set('departmentName', colNumber);
      else if (text === 'preferredsitecode' || text === 'sitecode')
        headerMap.set('preferredSiteCode', colNumber);
      else if (text === 'jobtitle' || text === 'title') headerMap.set('jobTitle', colNumber);
      else if (text === 'active') headerMap.set('active', colNumber);
    });

    if (
      !headerMap.has('employeeId') ||
      !headerMap.has('fullName') ||
      !headerMap.has('employmentStatus')
    ) {
      throw new WorkforceError(
        'missing_required_headers',
        'Workbook must contain required columns: Employee ID, Full Name, and Employment Status.',
      );
    }

    // 5. Query active reference data for validation
    const client = await this.pool.connect();
    let existingSites: Set<string>;
    let existingTeamDepartments: Map<string, string>;
    let existingEmployees: Map<
      string,
      {
        id: string;
        employeeId: string;
        fullName: string;
        email: string | null;
        employmentStatus: string;
        managerEmployeeId: string | null;
        jobTitle: string | null;
        active: boolean;
        departmentCode: string | null;
        teamCode: string | null;
        siteCode: string | null;
      }
    >;

    try {
      const sitesResult = await client.query<{ code: string }>(
        'SELECT code FROM dskt.sites WHERE archived_at IS NULL',
      );
      existingSites = new Set(sitesResult.rows.map((r) => r.code));

      const teamsResult = await client.query<{ team_code: string; department_code: string }>(`
        SELECT t.code as team_code, d.code as department_code
        FROM dskt.teams t
        JOIN dskt.departments d ON t.department_id = d.id
      `);
      existingTeamDepartments = new Map(
        teamsResult.rows.map((r) => [r.team_code, r.department_code]),
      );

      const employeesResult = await client.query<{
        id: string;
        employee_id: string;
        full_name: string;
        email: string | null;
        employment_status: string;
        manager_employee_id: string | null;
        job_title: string | null;
        active: boolean;
        department_code: string | null;
        team_code: string | null;
        site_code: string | null;
      }>(`
        SELECT 
          e.id,
          e.employee_id,
          e.full_name,
          e.email,
          e.employment_status,
          e.manager_employee_id,
          e.job_title,
          e.active,
          d.code as department_code,
          t.code as team_code,
          s.code as site_code
        FROM dskt.employees e
        LEFT JOIN dskt.departments d ON e.department_id = d.id
        LEFT JOIN dskt.teams t ON e.team_id = t.id
        LEFT JOIN dskt.sites s ON e.preferred_site_id = s.id
      `);

      existingEmployees = new Map(
        employeesResult.rows.map((r) => [
          r.employee_id,
          {
            id: r.id,
            employeeId: r.employee_id,
            fullName: r.full_name,
            email: r.email,
            employmentStatus: r.employment_status,
            managerEmployeeId: r.manager_employee_id,
            jobTitle: r.job_title,
            active: r.active,
            departmentCode: r.department_code,
            teamCode: r.team_code,
            siteCode: r.site_code,
          },
        ]),
      );
    } finally {
      client.release();
    }

    // 6. Parse and validate rows
    const parsedRows: ParsedRow[] = [];
    const seenEmployeeIds = new Map<string, number[]>(); // employeeId -> array of indices in parsedRows
    let processedRowCount = 0;

    for (let r = 2; r <= worksheet.rowCount; r++) {
      const row = worksheet.getRow(r);

      // Check if row is completely empty
      let hasAnyValue = false;
      row.eachCell({ includeEmpty: false }, (cell) => {
        if (getCellString(cell).length > 0) hasAnyValue = true;
      });
      if (!hasAnyValue) {
        continue;
      }

      processedRowCount++;
      if (processedRowCount > MAX_ROW_COUNT) {
        throw new WorkforceError(
          'too_many_rows',
          `Workbook exceeds maximum limit of ${MAX_ROW_COUNT} rows.`,
        );
      }

      const rowErrors: RowError[] = [];

      // Formula inspection (reject and never execute)
      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        if (
          cell.type === ExcelJS.ValueType.Formula ||
          (typeof cell.value === 'object' && cell.value !== null && 'formula' in cell.value)
        ) {
          let colName: string | null = null;
          for (const [key, num] of headerMap.entries()) {
            if (num === colNumber) {
              colName = key;
              break;
            }
          }
          rowErrors.push({
            columnName: colName,
            errorCode: 'FORMULA_NOT_PERMITTED',
            message: 'Formula cells are rejected and never executed.',
          });
        }
      });

      // Extract raw values
      const getVal = (key: string): string => {
        const col = headerMap.get(key);
        if (!col) return '';
        const cell = row.getCell(col);
        return getCellString(cell);
      };

      const rawEmployeeId = getVal('employeeId');
      const rawFullName = getVal('fullName');
      const rawEmploymentStatus = getVal('employmentStatus');
      const rawEmail = getVal('email');
      const rawManagerEmployeeId = getVal('managerEmployeeId');
      const rawTeamCode = getVal('teamCode');
      const rawTeamName = getVal('teamName');
      const rawDepartmentCode = getVal('departmentCode');
      const rawDepartmentName = getVal('departmentName');
      const rawPreferredSiteCode = getVal('preferredSiteCode');
      const rawJobTitle = getVal('jobTitle');
      const rawActive = getVal('active');

      // Employee ID validation
      const employeeId = rawEmployeeId.length > 0 ? rawEmployeeId : null;
      if (!employeeId) {
        rowErrors.push({
          columnName: 'Employee ID',
          errorCode: 'MISSING_EMPLOYEE_ID',
          message: 'Employee ID is required.',
        });
      } else {
        const list = seenEmployeeIds.get(employeeId) ?? [];
        list.push(parsedRows.length);
        seenEmployeeIds.set(employeeId, list);
      }

      // Full Name validation
      const fullName = rawFullName.length > 0 ? rawFullName : null;
      if (!fullName) {
        rowErrors.push({
          columnName: 'Full Name',
          errorCode: 'MISSING_FULL_NAME',
          message: 'Full Name is required.',
        });
      }

      // Employment Status validation
      const normalizedStatus = rawEmploymentStatus.toUpperCase().trim();
      let employmentStatus: string | null = null;
      if (normalizedStatus.length === 0) {
        rowErrors.push({
          columnName: 'Employment Status',
          errorCode: 'MISSING_EMPLOYMENT_STATUS',
          message: 'Employment Status is required.',
        });
      } else if (!VALID_EMPLOYMENT_STATUSES.has(normalizedStatus)) {
        rowErrors.push({
          columnName: 'Employment Status',
          errorCode: 'UNSUPPORTED_STATUS',
          message: `Unsupported employment status '${rawEmploymentStatus}'.`,
        });
      } else {
        employmentStatus = normalizedStatus;
      }

      // Email validation
      let email: string | null = null;
      if (rawEmail.length > 0) {
        const lowerEmail = rawEmail.toLowerCase().trim();
        if (!EMAIL_REGEX.test(lowerEmail)) {
          rowErrors.push({
            columnName: 'Email',
            errorCode: 'INVALID_EMAIL',
            message: `Malformed email address '${rawEmail}'.`,
          });
        } else {
          email = lowerEmail;
        }
      }

      // Preferred Site Code validation
      let preferredSiteCode: string | null = null;
      if (rawPreferredSiteCode.length > 0) {
        const siteCode = rawPreferredSiteCode.trim();
        if (!existingSites.has(siteCode)) {
          rowErrors.push({
            columnName: 'Preferred Site Code',
            errorCode: 'UNKNOWN_SITE_CODE',
            message: `Unknown Site code '${siteCode}'.`,
          });
        } else {
          preferredSiteCode = siteCode;
        }
      }

      // Active flag derivation
      let active: boolean;
      if (rawActive.length > 0) {
        const parsed = parseBoolean(rawActive);
        if (parsed !== null) {
          active = parsed;
        } else {
          active = employmentStatus === 'ACTIVE';
        }
      } else {
        active = employmentStatus === 'ACTIVE';
      }

      const managerEmployeeId = rawManagerEmployeeId.length > 0 ? rawManagerEmployeeId.trim() : null;
      if (managerEmployeeId && employeeId && managerEmployeeId === employeeId) {
        rowErrors.push({
          columnName: 'Manager Employee ID',
          errorCode: 'SELF_MANAGER_REFERENCE',
          message: 'Employee cannot be their own manager.',
        });
      }

      const teamCode = rawTeamCode.length > 0 ? rawTeamCode.trim() : null;
      const teamName = rawTeamName.length > 0 ? rawTeamName.trim() : null;
      const departmentCode = rawDepartmentCode.length > 0 ? rawDepartmentCode.trim() : null;
      const departmentName = rawDepartmentName.length > 0 ? rawDepartmentName.trim() : null;
      const jobTitle = rawJobTitle.length > 0 ? rawJobTitle.trim() : null;

      parsedRows.push({
        rowNumber: r,
        action: 'INVALID', // to be evaluated
        isValid: rowErrors.length === 0,
        employeeId,
        fullName,
        email,
        employmentStatus,
        managerEmployeeId,
        teamCode,
        teamName,
        departmentCode,
        departmentName,
        preferredSiteCode,
        jobTitle,
        active,
        errors: rowErrors,
      });
    }

    // 7. Duplicate employee IDs across the workbook
    for (const [empId, indices] of seenEmployeeIds.entries()) {
      if (indices.length > 1) {
        for (const idx of indices) {
          const targetRow = parsedRows[idx]!;
          targetRow.errors.push({
            columnName: 'Employee ID',
            errorCode: 'DUPLICATE_EMPLOYEE_ID',
            message: `Duplicate Employee ID '${empId}' within the workbook.`,
          });
          targetRow.isValid = false;
        }
      }
    }

    // 8. Cross-row manager reference and cycle validation
    // All referenced managers must exist in either the workbook or existingEmployees
    const workbookEmployeeIds = new Set(
      parsedRows.map((p) => p.employeeId).filter((id): id is string => id !== null),
    );

    for (const row of parsedRows) {
      if (!row.managerEmployeeId) continue;
      const mgrId = row.managerEmployeeId;
      const existsInWorkbook = workbookEmployeeIds.has(mgrId);
      const existsInDb = existingEmployees.has(mgrId);

      if (!existsInWorkbook && !existsInDb) {
        row.errors.push({
          columnName: 'Manager Employee ID',
          errorCode: 'UNRESOLVED_MANAGER',
          message: `Manager Employee ID '${mgrId}' cannot be resolved in existing data or workbook.`,
        });
        row.isValid = false;
      }
    }

    // Cycle detection for managers
    const managerGraph = new Map<string, string>(); // employeeId -> managerEmployeeId
    for (const [id, e] of existingEmployees.entries()) {
      if (e.managerEmployeeId) {
        managerGraph.set(id, e.managerEmployeeId);
      }
    }
    for (const row of parsedRows) {
      if (row.employeeId && row.managerEmployeeId) {
        managerGraph.set(row.employeeId, row.managerEmployeeId);
      }
    }

    for (const row of parsedRows) {
      if (!row.employeeId || !row.managerEmployeeId) continue;
      const visited = new Set<string>();
      let curr: string | undefined = row.employeeId;
      let cycleFound = false;

      while (curr && managerGraph.has(curr)) {
        if (visited.has(curr)) {
          cycleFound = true;
          break;
        }
        visited.add(curr);
        curr = managerGraph.get(curr);
      }

      if (cycleFound) {
        row.errors.push({
          columnName: 'Manager Employee ID',
          errorCode: 'CYCLIC_MANAGER_REFERENCE',
          message: `Manager relationship forms a cycle involving Employee ID '${row.employeeId}'.`,
        });
        row.isValid = false;
      }
    }

    // 9. Team and department consistency validation
    const workbookTeamDepartments = new Map<string, string>(); // teamCode -> departmentCode
    for (const row of parsedRows) {
      if (row.teamCode && row.departmentCode) {
        const existingDept = existingTeamDepartments.get(row.teamCode);
        if (existingDept && existingDept !== row.departmentCode) {
          row.errors.push({
            columnName: 'Team Code',
            errorCode: 'CONFLICTING_TEAM_DEPARTMENT',
            message: `Team '${row.teamCode}' belongs to department '${existingDept}', but was specified under department '${row.departmentCode}'.`,
          });
          row.isValid = false;
        }

        const wbDept = workbookTeamDepartments.get(row.teamCode);
        if (wbDept && wbDept !== row.departmentCode) {
          row.errors.push({
            columnName: 'Team Code',
            errorCode: 'CONFLICTING_TEAM_DEPARTMENT',
            message: `Team '${row.teamCode}' is assigned to conflicting departments in the workbook.`,
          });
          row.isValid = false;
        } else {
          workbookTeamDepartments.set(row.teamCode, row.departmentCode);
        }
      }
    }

    // 10. Determine proposed action: CREATE, UPDATE, UNCHANGED, or INVALID
    let createCount = 0;
    let updateCount = 0;
    let unchangedCount = 0;
    let invalidCount = 0;

    for (const row of parsedRows) {
      if (row.errors.length > 0 || !row.isValid || !row.employeeId || !row.fullName || !row.employmentStatus) {
        row.action = 'INVALID';
        row.isValid = false;
        invalidCount++;
        continue;
      }

      const existing = existingEmployees.get(row.employeeId);
      if (!existing) {
        row.action = 'CREATE';
        createCount++;
      } else {
        // Compare all imported fields against existing domain data
        const isIdentical =
          row.fullName === existing.fullName &&
          (row.email ?? null) === (existing.email ?? null) &&
          row.employmentStatus === existing.employmentStatus &&
          (row.managerEmployeeId ?? null) === (existing.managerEmployeeId ?? null) &&
          (row.jobTitle ?? null) === (existing.jobTitle ?? null) &&
          row.active === existing.active &&
          (row.departmentCode ?? null) === (existing.departmentCode ?? null) &&
          (row.teamCode ?? null) === (existing.teamCode ?? null) &&
          (row.preferredSiteCode ?? null) === (existing.siteCode ?? null);

        if (isIdentical) {
          row.action = 'UNCHANGED';
          unchangedCount++;
        } else {
          row.action = 'UPDATE';
          updateCount++;
        }
      }
    }

    const totalRows = parsedRows.length;
    const validRows = createCount + updateCount + unchangedCount;
    const status = invalidCount > 0 ? 'INVALID' : 'READY';
    const importId = randomUUID();

    // Save temporary raw workbook artifact for the operational retention window
    await this.saveUploadArtifact(importId, buffer);

    // 9. Persist metadata and normalized relational staging rows in a transaction
    // Strictly NO JSONB / NO generic payload column
    const dbClient = await this.pool.connect();
    let createdAt: Date;

    try {
      await dbClient.query('BEGIN');

      const importInsertResult = await dbClient.query<{ created_at: Date }>(
        `
        INSERT INTO dskt.employee_imports (
          id, uploaded_by_user_id, original_filename, file_sha256,
          status, total_rows, valid_rows, invalid_rows, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
        RETURNING created_at
      `,
        [
          importId,
          uploadedByUserId,
          originalFilename,
          fileSha256,
          status,
          totalRows,
          validRows,
          invalidCount,
        ],
      );

      createdAt = importInsertResult.rows[0]!.created_at;

      // Insert staging rows
      for (const row of parsedRows) {
        const rowId = randomUUID();
        await dbClient.query(
          `
          INSERT INTO dskt.employee_import_rows (
            id, employee_import_id, row_number, action, is_valid,
            employee_id, full_name, email, employment_status,
            manager_employee_id, team_code, team_name,
            department_code, department_name, preferred_site_code,
            job_title, active, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW())
        `,
          [
            rowId,
            importId,
            row.rowNumber,
            row.action,
            row.isValid,
            row.employeeId,
            row.fullName,
            row.email,
            row.employmentStatus,
            row.managerEmployeeId,
            row.teamCode,
            row.teamName,
            row.departmentCode,
            row.departmentName,
            row.preferredSiteCode,
            row.jobTitle,
            row.active,
          ],
        );

        // Insert row errors
        for (const err of row.errors) {
          await dbClient.query(
            `
            INSERT INTO dskt.employee_import_row_errors (
              id, employee_import_row_id, column_name, error_code, message, created_at
            ) VALUES ($1, $2, $3, $4, $5, NOW())
          `,
            [randomUUID(), rowId, err.columnName, err.errorCode, err.message],
          );
        }
      }

      await dbClient.query('COMMIT');
    } catch (err) {
      await dbClient.query('ROLLBACK');
      throw err;
    } finally {
      dbClient.release();
    }

    return {
      id: importId,
      originalFilename,
      fileSha256,
      status,
      totalRows,
      validRows,
      invalidRows: invalidCount,
      createCount,
      updateCount,
      unchangedCount,
      invalidCount,
      createdAt: createdAt.toISOString(),
      appliedAt: null,
    };
  }

  /**
   * Retrieve import metadata and summary.
   */
  async getImport(importId: string): Promise<EmployeeImportSummary | null> {
    const result = await this.pool.query<{
      id: string;
      original_filename: string;
      file_sha256: string;
      status: 'VALIDATING' | 'INVALID' | 'READY' | 'APPLYING' | 'APPLIED' | 'FAILED';
      total_rows: number;
      valid_rows: number;
      invalid_rows: number;
      created_at: Date;
      applied_at: Date | null;
      create_count: string;
      update_count: string;
      unchanged_count: string;
      invalid_count: string;
    }>(
      `
      SELECT 
        i.id,
        i.original_filename,
        i.file_sha256,
        i.status,
        i.total_rows,
        i.valid_rows,
        i.invalid_rows,
        i.created_at,
        i.applied_at,
        COUNT(CASE WHEN r.action = 'CREATE' THEN 1 END) as create_count,
        COUNT(CASE WHEN r.action = 'UPDATE' THEN 1 END) as update_count,
        COUNT(CASE WHEN r.action = 'UNCHANGED' THEN 1 END) as unchanged_count,
        COUNT(CASE WHEN r.action = 'INVALID' THEN 1 END) as invalid_count
      FROM dskt.employee_imports i
      LEFT JOIN dskt.employee_import_rows r ON i.id = r.employee_import_id
      WHERE i.id = $1
      GROUP BY i.id
    `,
      [importId],
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0]!;
    return {
      id: row.id,
      originalFilename: row.original_filename,
      fileSha256: row.file_sha256,
      status: row.status,
      totalRows: row.total_rows,
      validRows: row.valid_rows,
      invalidRows: row.invalid_rows,
      createCount: parseInt(row.create_count, 10),
      updateCount: parseInt(row.update_count, 10),
      unchangedCount: parseInt(row.unchanged_count, 10),
      invalidCount: parseInt(row.invalid_count, 10),
      createdAt: row.created_at.toISOString(),
      appliedAt: row.applied_at ? row.applied_at.toISOString() : null,
    };
  }

  /**
   * List staging rows for an import with optional action filter and pagination.
   */
  async listImportRows(
    importId: string,
    filter?: {
      action?: 'ALL' | 'CREATE' | 'UPDATE' | 'UNCHANGED' | 'INVALID';
      limit?: number;
      offset?: number;
    },
  ): Promise<{ totalRows: number; rows: EmployeeImportRowView[] }> {
    const action = filter?.action && filter.action !== 'ALL' ? filter.action : null;
    const limit = Math.min(Math.max(filter?.limit ?? 50, 1), 200);
    const offset = Math.max(filter?.offset ?? 0, 0);

    const countResult = await this.pool.query<{ count: string }>(
      `
      SELECT COUNT(*) as count
      FROM dskt.employee_import_rows
      WHERE employee_import_id = $1
      ${action ? 'AND action = $2' : ''}
    `,
      action ? [importId, action] : [importId],
    );

    const totalRows = parseInt(countResult.rows[0]?.count ?? '0', 10);

    const rowsResult = await this.pool.query<{
      id: string;
      row_number: number;
      action: 'CREATE' | 'UPDATE' | 'UNCHANGED' | 'INVALID';
      is_valid: boolean;
      employee_id: string | null;
      full_name: string | null;
      email: string | null;
      employment_status: string | null;
      manager_employee_id: string | null;
      team_code: string | null;
      team_name: string | null;
      department_code: string | null;
      department_name: string | null;
      preferred_site_code: string | null;
      job_title: string | null;
      active: boolean | null;
    }>(
      `
      SELECT 
        id, row_number, action, is_valid,
        employee_id, full_name, email, employment_status,
        manager_employee_id, team_code, team_name,
        department_code, department_name, preferred_site_code,
        job_title, active
      FROM dskt.employee_import_rows
      WHERE employee_import_id = $1
      ${action ? 'AND action = $2' : ''}
      ORDER BY row_number ASC
      LIMIT $${action ? 3 : 2} OFFSET $${action ? 4 : 3}
    `,
      action ? [importId, action, limit, offset] : [importId, limit, offset],
    );

    // Fetch errors for these rows
    const rowIds = rowsResult.rows.map((r) => r.id);
    const errorsByRowId = new Map<string, RowError[]>();

    if (rowIds.length > 0) {
      const errorsResult = await this.pool.query<{
        employee_import_row_id: string;
        column_name: string | null;
        error_code: string;
        message: string;
      }>(
        `
        SELECT employee_import_row_id, column_name, error_code, message
        FROM dskt.employee_import_row_errors
        WHERE employee_import_row_id = ANY($1)
      `,
        [rowIds],
      );

      for (const err of errorsResult.rows) {
        const list = errorsByRowId.get(err.employee_import_row_id) ?? [];
        list.push({
          columnName: err.column_name,
          errorCode: err.error_code,
          message: err.message,
        });
        errorsByRowId.set(err.employee_import_row_id, list);
      }
    }

    const rows: EmployeeImportRowView[] = rowsResult.rows.map((r) => ({
      id: r.id,
      rowNumber: r.row_number,
      action: r.action,
      isValid: r.is_valid,
      employeeId: r.employee_id,
      fullName: r.full_name,
      email: r.email,
      employmentStatus: r.employment_status,
      managerEmployeeId: r.manager_employee_id,
      teamCode: r.team_code,
      teamName: r.team_name,
      departmentCode: r.department_code,
      departmentName: r.department_name,
      preferredSiteCode: r.preferred_site_code,
      jobTitle: r.job_title,
      active: r.active,
      errors: errorsByRowId.get(r.id) ?? [],
    }));

    return { totalRows, rows };
  }
}
