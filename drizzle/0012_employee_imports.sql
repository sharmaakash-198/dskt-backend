-- Migration 0012: Workforce and Employee Imports staging tables

-- 1. Departments
CREATE TABLE IF NOT EXISTS dskt.departments (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  active     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS departments_code_idx ON dskt.departments (code);

-- 2. Teams
CREATE TABLE IF NOT EXISTS dskt.teams (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id UUID REFERENCES dskt.departments(id),
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS teams_code_idx ON dskt.teams (code);
CREATE INDEX IF NOT EXISTS teams_department_id_idx ON dskt.teams (department_id);

-- 3. Employee imports metadata
CREATE TABLE IF NOT EXISTS dskt.employee_imports (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uploaded_by_user_id UUID NOT NULL REFERENCES dskt.app_users(id),
  original_filename   TEXT NOT NULL,
  file_sha256         TEXT NOT NULL,
  status              TEXT NOT NULL,
  total_rows          INTEGER NOT NULL DEFAULT 0,
  valid_rows          INTEGER NOT NULL DEFAULT 0,
  invalid_rows        INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS employee_imports_file_sha256_idx ON dskt.employee_imports (file_sha256);
CREATE INDEX IF NOT EXISTS employee_imports_uploaded_by_idx ON dskt.employee_imports (uploaded_by_user_id);

-- 4. Employees
CREATE TABLE IF NOT EXISTS dskt.employees (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id         TEXT NOT NULL UNIQUE,
  full_name           TEXT NOT NULL,
  email               TEXT UNIQUE,
  manager_employee_id TEXT REFERENCES dskt.employees(employee_id),
  team_id             UUID REFERENCES dskt.teams(id),
  department_id       UUID REFERENCES dskt.departments(id),
  preferred_site_id   UUID REFERENCES dskt.sites(id),
  job_title           TEXT,
  employment_status   TEXT NOT NULL,
  active              BOOLEAN NOT NULL DEFAULT true,
  last_import_id      UUID REFERENCES dskt.employee_imports(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS employees_employee_id_idx ON dskt.employees (employee_id);
CREATE INDEX IF NOT EXISTS employees_email_idx ON dskt.employees (email);
CREATE INDEX IF NOT EXISTS employees_team_id_idx ON dskt.employees (team_id);
CREATE INDEX IF NOT EXISTS employees_department_id_idx ON dskt.employees (department_id);

-- 5. Employee import rows (Normalized relational staging - strictly NO JSONB / NO generic payload column)
CREATE TABLE IF NOT EXISTS dskt.employee_import_rows (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_import_id  UUID NOT NULL REFERENCES dskt.employee_imports(id) ON DELETE CASCADE,
  row_number          INTEGER NOT NULL,
  action              TEXT NOT NULL,
  is_valid            BOOLEAN NOT NULL DEFAULT true,
  employee_id         TEXT,
  full_name           TEXT,
  email               TEXT,
  employment_status   TEXT,
  manager_employee_id TEXT,
  team_code           TEXT,
  team_name           TEXT,
  department_code     TEXT,
  department_name     TEXT,
  preferred_site_code TEXT,
  job_title           TEXT,
  active              BOOLEAN,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (employee_import_id, row_number)
);

CREATE INDEX IF NOT EXISTS employee_import_rows_import_idx ON dskt.employee_import_rows (employee_import_id);
CREATE INDEX IF NOT EXISTS employee_import_rows_action_idx ON dskt.employee_import_rows (employee_import_id, action);

-- 6. Employee import row errors
CREATE TABLE IF NOT EXISTS dskt.employee_import_row_errors (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_import_row_id UUID NOT NULL REFERENCES dskt.employee_import_rows(id) ON DELETE CASCADE,
  column_name            TEXT,
  error_code             TEXT NOT NULL,
  message                TEXT NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS employee_import_row_errors_row_idx ON dskt.employee_import_row_errors (employee_import_row_id);
