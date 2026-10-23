-- Migration 0011: Publication metadata and partial unique indexes for floor plan revisions
ALTER TABLE dskt.floor_plan_revisions
  ADD COLUMN IF NOT EXISTS published_by_user_id UUID REFERENCES dskt.app_users(id),
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS floor_plan_revisions_one_draft_idx
  ON dskt.floor_plan_revisions (floor_plan_id)
  WHERE lifecycle_state = 'DRAFT';

CREATE UNIQUE INDEX IF NOT EXISTS floor_plan_revisions_one_published_idx
  ON dskt.floor_plan_revisions (floor_plan_id)
  WHERE lifecycle_state = 'PUBLISHED';
