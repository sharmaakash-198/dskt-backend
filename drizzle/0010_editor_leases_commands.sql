-- Floor Plan Editor Leases and Processed Commands
CREATE TABLE dskt.floor_plan_editor_leases (
  floor_plan_revision_id UUID PRIMARY KEY REFERENCES dskt.floor_plan_revisions(id) ON DELETE CASCADE,
  app_user_id            UUID NOT NULL REFERENCES dskt.app_users(id),
  lease_token_hash       TEXT NOT NULL,
  acquired_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at             TIMESTAMPTZ NOT NULL,
  renewed_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_at            TIMESTAMPTZ
);

CREATE INDEX floor_plan_editor_leases_app_user_idx
  ON dskt.floor_plan_editor_leases (app_user_id);

CREATE TABLE dskt.processed_commands (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  floor_plan_revision_id UUID NOT NULL REFERENCES dskt.floor_plan_revisions(id) ON DELETE CASCADE,
  client_command_id      TEXT NOT NULL,
  app_user_id            UUID NOT NULL REFERENCES dskt.app_users(id),
  command_type           TEXT NOT NULL,
  request_hash           TEXT NOT NULL,
  response_status        INTEGER NOT NULL,
  response_body          TEXT NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (floor_plan_revision_id, client_command_id)
);

CREATE INDEX processed_commands_revision_cmd_idx
  ON dskt.processed_commands (floor_plan_revision_id, client_command_id);
