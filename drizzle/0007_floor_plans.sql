-- Floor Plans and Revisions
CREATE TABLE dskt.floor_plans (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  floor_id        UUID NOT NULL REFERENCES dskt.floors(id),
  idempotency_key TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (floor_id)
);

CREATE TABLE dskt.floor_plan_revisions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  floor_plan_id       UUID NOT NULL REFERENCES dskt.floor_plans(id),
  revision_number     INTEGER NOT NULL,
  lifecycle_state     TEXT NOT NULL CHECK (lifecycle_state IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
  editing_scale       INTEGER NOT NULL CHECK (editing_scale IN (1, 2, 4, 8, 16, 32, 64, 128, 256)),
  concurrency_version INTEGER NOT NULL DEFAULT 0 CHECK (concurrency_version >= 0),
  created_by_user_id  UUID NOT NULL REFERENCES dskt.app_users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (floor_plan_id, revision_number)
);
