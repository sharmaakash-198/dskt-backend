-- audit_events: immutable access and domain audit trail (safe summaries only)
CREATE TABLE dskt.audit_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor_user_id   UUID NOT NULL REFERENCES dskt.app_users(id),
  action          TEXT NOT NULL,
  target_type     TEXT NOT NULL,
  target_id       TEXT NOT NULL,
  correlation_id  TEXT NOT NULL,
  summary         TEXT NOT NULL
);

CREATE INDEX audit_events_actor_user_id_idx ON dskt.audit_events(actor_user_id);
CREATE INDEX audit_events_correlation_id_idx ON dskt.audit_events(correlation_id);
CREATE INDEX audit_events_occurred_at_idx ON dskt.audit_events(occurred_at);

-- editor_leases: minimal lease rows so deactivation can permit reclaim before Floor Plans exist
CREATE TABLE dskt.editor_leases (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_user_id     UUID NOT NULL REFERENCES dskt.app_users(id),
  resource_key    TEXT NOT NULL,
  acquired_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL,
  released_at     TIMESTAMPTZ,
  reclaimable_at  TIMESTAMPTZ
);

CREATE INDEX editor_leases_app_user_id_idx ON dskt.editor_leases(app_user_id);
CREATE INDEX editor_leases_active_idx
  ON dskt.editor_leases(app_user_id)
  WHERE released_at IS NULL;
