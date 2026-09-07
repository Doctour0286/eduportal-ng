-- ============================================================================
-- migration_decouple_profiles.sql
-- Decouple score_component_profiles from assessment_windows so profiles become
-- school-level reusable entities. Each profile gets a school_id; the
-- assessment_window_id FK becomes nullable (existing window-scoped profiles
-- retain their link for backward compatibility).
--
-- Run order: AFTER migration_tier8_s46_assessment_windows.sql
-- Idempotent: safe to re-run (IF EXISTS / IF NOT EXISTS throughout).
--
-- What this does:
--   1. Adds school_id to score_component_profiles
--   2. Backfills school_id from the linked assessment_window
--   3. Makes assessment_window_id nullable
--   4. Replaces UNIQUE(assessment_window_id, name) with UNIQUE(school_id, name)
--   5. Rewrites all 5 RLS policies to scope via school_id directly
--   6. Adds a new RLS policy for orphan profiles (no window link)
-- ============================================================================

-- ── 1. Add school_id column ─────────────────────────────────────────────────

ALTER TABLE score_component_profiles
  ADD COLUMN IF NOT EXISTS school_id uuid REFERENCES schools(id);

-- ── 2. Backfill school_id from assessment_windows ───────────────────────────

UPDATE score_component_profiles scp
SET school_id = w.school_id
FROM assessment_windows w
WHERE scp.assessment_window_id = w.id
  AND scp.school_id IS NULL;

-- ── 3. Make assessment_window_id nullable ───────────────────────────────────

-- Drop the NOT NULL constraint (safe: column already allows writes via the
-- existing RLS policies, and new rows will supply school_id directly).
ALTER TABLE score_component_profiles
  ALTER COLUMN assessment_window_id DROP NOT NULL;

-- ── 4. Replace unique constraint ────────────────────────────────────────────

-- Old: unique(assessment_window_id, name) — broken when assessment_window_id
-- is NULL (NULL != NULL means duplicates slip through).
-- New: unique(school_id, name) — two profiles in the same school cannot share
-- a name, regardless of whether they're attached to a window or orphan.
ALTER TABLE score_component_profiles
  DROP CONSTRAINT IF EXISTS score_component_profiles_assessment_window_id_name_key;

ALTER TABLE score_component_profiles
  ADD CONSTRAINT score_component_profiles_school_id_name_key
  UNIQUE (school_id, name);

-- ── 5. Set school_id NOT NULL (after backfill) ─────────────────────────────

ALTER TABLE score_component_profiles
  ALTER COLUMN school_id SET NOT NULL;

-- ── 6. Rewrite RLS policies ─────────────────────────────────────────────────
-- Old policies joined through assessment_windows to resolve school membership.
-- New policies read school_id directly — simpler, faster, and works for both
-- window-linked and orphan profiles.

DROP POLICY IF EXISTS scp_select ON score_component_profiles;
CREATE POLICY scp_select ON score_component_profiles
  FOR SELECT USING (school_id = current_school_id());

DROP POLICY IF EXISTS scp_insert ON score_component_profiles;
CREATE POLICY scp_insert ON score_component_profiles
  FOR INSERT WITH CHECK (
    school_id = current_school_id()
    AND (current_is_admin() OR current_has_permission('academics.assessment_windows.manage'))
  );

DROP POLICY IF EXISTS scp_update ON score_component_profiles;
CREATE POLICY scp_update ON score_component_profiles
  FOR UPDATE USING (
    school_id = current_school_id()
    AND (current_is_admin() OR current_has_permission('academics.assessment_windows.manage'))
  )
  WITH CHECK (school_id = current_school_id());

DROP POLICY IF EXISTS scp_delete ON score_component_profiles;
CREATE POLICY scp_delete ON score_component_profiles
  FOR DELETE USING (
    school_id = current_school_id()
    AND (current_is_admin() OR current_has_permission('academics.assessment_windows.manage'))
  );
