-- Location hierarchy: sites and buildings (buildings required for archive guards)
CREATE TABLE dskt.sites (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES dskt.organizations(id),
  code            TEXT NOT NULL,
  name            TEXT NOT NULL,
  time_zone       TEXT NOT NULL,
  address_line1   TEXT,
  address_line2   TEXT,
  city            TEXT,
  region          TEXT,
  postal_code     TEXT,
  country         TEXT,
  archived_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, code)
);

CREATE INDEX sites_active_code_idx
  ON dskt.sites(organization_id, code)
  WHERE archived_at IS NULL;

CREATE TABLE dskt.buildings (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id      UUID NOT NULL REFERENCES dskt.sites(id),
  code         TEXT NOT NULL,
  name         TEXT NOT NULL,
  archived_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (site_id, code)
);

CREATE INDEX buildings_active_site_idx
  ON dskt.buildings(site_id)
  WHERE archived_at IS NULL;
