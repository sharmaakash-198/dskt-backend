-- Migration 0013: Employee import confirmation idempotency support
ALTER TABLE dskt.employee_imports ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
CREATE INDEX IF NOT EXISTS employee_imports_idempotency_key_idx ON dskt.employee_imports (idempotency_key);
