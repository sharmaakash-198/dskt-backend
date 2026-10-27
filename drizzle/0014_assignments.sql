-- Migration 0014: Employee space assignments
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS dskt.assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  placement_identity_id uuid NOT NULL REFERENCES dskt.placement_identities(id) ON DELETE RESTRICT,
  employee_id uuid NOT NULL REFERENCES dskt.employees(id) ON DELETE RESTRICT,
  assigned_by_user_id uuid NOT NULL REFERENCES dskt.app_users(id),
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  client_command_id text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assignments_end_after_start CHECK (ended_at IS NULL OR ended_at > started_at),
  CONSTRAINT assignments_placement_period_excl EXCLUDE USING gist (
    placement_identity_id WITH =,
    tstzrange(started_at, COALESCE(ended_at, 'infinity'::timestamptz), '[)') WITH &&
  )
);

CREATE INDEX IF NOT EXISTS assignments_employee_id_idx ON dskt.assignments (employee_id);
CREATE INDEX IF NOT EXISTS assignments_placement_identity_idx ON dskt.assignments (placement_identity_id);
CREATE INDEX IF NOT EXISTS assignments_client_command_id_idx ON dskt.assignments (client_command_id);
