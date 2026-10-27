-- Migration 0015: Assignment ended by user
ALTER TABLE dskt.assignments ADD COLUMN IF NOT EXISTS ended_by_user_id uuid REFERENCES dskt.app_users(id);
