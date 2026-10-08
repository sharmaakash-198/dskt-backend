-- Enable citext extension (idempotent)
CREATE EXTENSION IF NOT EXISTS citext;

-- organizations
CREATE TABLE dskt.organizations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL UNIQUE,
  archived_at  TIMESTAMPTZ
);

-- app_users
CREATE TABLE dskt.app_users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES dskt.organizations(id),
  email           CITEXT NOT NULL UNIQUE,
  display_name    TEXT NOT NULL,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- app_user_identities
CREATE TABLE dskt.app_user_identities (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_user_id     UUID NOT NULL REFERENCES dskt.app_users(id),
  provider        TEXT NOT NULL CHECK (provider IN ('LOCAL', 'ENTRA')),
  provider_subject TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, provider_subject),
  UNIQUE (app_user_id, provider)
);

-- local_auth_credentials (development only)
CREATE TABLE dskt.local_auth_credentials (
  app_user_id        UUID PRIMARY KEY REFERENCES dskt.app_users(id),
  username           CITEXT NOT NULL UNIQUE,
  password_hash      TEXT NOT NULL,
  password_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  disabled_at        TIMESTAMPTZ
);

-- local_auth_sessions (development only)
CREATE TABLE dskt.local_auth_sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_user_id  UUID NOT NULL REFERENCES dskt.app_users(id),
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ
);

CREATE INDEX local_auth_sessions_app_user_id_idx ON dskt.local_auth_sessions(app_user_id);
CREATE INDEX local_auth_sessions_expires_at_idx  ON dskt.local_auth_sessions(expires_at);

-- roles
CREATE TABLE dskt.roles (
  id   SMALLINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL
);

INSERT INTO dskt.roles (code, name) VALUES
  ('SYSTEM_ADMIN',      'System Administrator'),
  ('FACILITIES_ADMIN',  'Facilities Admin'),
  ('WORKPLACE_PLANNER', 'Workplace Planner'),
  ('VIEWER',            'Viewer');

-- app_user_roles
CREATE TABLE dskt.app_user_roles (
  app_user_id       UUID NOT NULL REFERENCES dskt.app_users(id),
  role_id           SMALLINT NOT NULL REFERENCES dskt.roles(id),
  granted_by_user_id UUID NOT NULL REFERENCES dskt.app_users(id),
  granted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at        TIMESTAMPTZ,
  PRIMARY KEY (app_user_id, role_id, granted_at)
);

CREATE UNIQUE INDEX app_user_roles_active_uniq
  ON dskt.app_user_roles(app_user_id, role_id)
  WHERE revoked_at IS NULL;
