-- Immutable Element Template Revisions with relational vertex storage
ALTER TABLE dskt.element_templates
  ADD COLUMN current_revision_id UUID;

CREATE TABLE dskt.element_template_revisions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  element_template_id UUID NOT NULL REFERENCES dskt.element_templates(id),
  revision_number     INTEGER NOT NULL,
  assignable          BOOLEAN NOT NULL,
  spatial_class       TEXT NOT NULL CHECK (spatial_class IN ('PHYSICAL', 'ZONE', 'OBSTACLE')),
  border_color        TEXT NOT NULL,
  fill_color          TEXT NOT NULL,
  created_by_user_id  UUID NOT NULL REFERENCES dskt.app_users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (element_template_id, revision_number),
  CHECK (NOT assignable OR spatial_class = 'PHYSICAL')
);

ALTER TABLE dskt.element_templates
  ADD CONSTRAINT element_templates_current_revision_id_fkey
  FOREIGN KEY (current_revision_id)
  REFERENCES dskt.element_template_revisions(id);

CREATE TABLE dskt.element_template_revision_vertices (
  element_template_revision_id UUID NOT NULL REFERENCES dskt.element_template_revisions(id),
  sequence                     INTEGER NOT NULL,
  x                            INTEGER NOT NULL,
  y                            INTEGER NOT NULL,
  PRIMARY KEY (element_template_revision_id, sequence),
  UNIQUE (element_template_revision_id, x, y)
);
