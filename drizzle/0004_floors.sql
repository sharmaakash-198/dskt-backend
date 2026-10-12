-- Floors within buildings for the location hierarchy
CREATE TABLE dskt.floors (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  building_id  UUID NOT NULL REFERENCES dskt.buildings(id),
  code         TEXT NOT NULL,
  name         TEXT NOT NULL,
  archived_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (building_id, code)
);

CREATE INDEX floors_active_building_idx
  ON dskt.floors(building_id)
  WHERE archived_at IS NULL;
