-- Floor Plan Revision Boundary Vertices
CREATE TABLE dskt.floor_plan_revision_boundary_vertices (
  floor_plan_revision_id UUID NOT NULL REFERENCES dskt.floor_plan_revisions(id) ON DELETE CASCADE,
  sequence               INTEGER NOT NULL,
  x                      INTEGER NOT NULL,
  y                      INTEGER NOT NULL,
  PRIMARY KEY (floor_plan_revision_id, sequence),
  UNIQUE (floor_plan_revision_id, x, y)
);
