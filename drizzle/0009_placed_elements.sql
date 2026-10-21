-- Placement Identities and Placed Elements
CREATE TABLE dskt.placement_identities (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  floor_plan_id UUID NOT NULL REFERENCES dskt.floor_plans(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE dskt.placed_elements (
  id                           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  floor_plan_revision_id       UUID NOT NULL REFERENCES dskt.floor_plan_revisions(id) ON DELETE CASCADE,
  placement_identity_id        UUID NOT NULL REFERENCES dskt.placement_identities(id) ON DELETE CASCADE,
  element_template_revision_id UUID NOT NULL REFERENCES dskt.element_template_revisions(id),
  position_x                   INTEGER NOT NULL,
  position_y                   INTEGER NOT NULL,
  rotation_degrees             INTEGER NOT NULL CHECK (rotation_degrees IN (0, 90, 180, 270)),
  label                        TEXT,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (floor_plan_revision_id, placement_identity_id)
);

CREATE UNIQUE INDEX placed_elements_revision_label_unique
  ON dskt.placed_elements (floor_plan_revision_id, label)
  WHERE label IS NOT NULL;
