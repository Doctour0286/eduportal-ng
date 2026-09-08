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
--   3. Deduplicates profiles with same (school_id, name) — keeps the profile
--      with the most score_components linked (or newest if tied), re-points
--      orphaned score_components before deleting
--   4. Makes assessment_window_id nullable
--   5. Replaces UNIQUE(assessment_window_id, name) with UNIQUE(school_id, name)
--   6. Rewrites all 5 RLS policies to scope via school_id directly
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

-- ── 3. Deduplicate profiles with same (school_id, name) ────────────────────
-- Multiple profiles may share a name under the same school (e.g. "Default
-- weighting" created for different windows). Keep the one with the most
-- score_components linked; if tied, keep the newest (highest created_at).
-- Re-point any score_components from profiles we'll delete to the kept one.

-- Step 3a: Create a mapping table — duplicate_id → keep_id
CREATE TEMP TABLE _scp_dedup_map AS
WITH ranked AS (
  SELECT
    scp.id,
    scp.school_id,
    scp.name,
    ROW_NUMBER() OVER (
      PARTITION BY scp.school_id, scp.name
      ORDER BY
        (SELECT count(*) FROM score_components sc WHERE sc.score_component_profile_id = scp.id) DESC,
        scp.created_at DESC NULLS LAST,
        scp.id
    ) AS rn
  FROM score_component_profiles scp
  WHERE scp.school_id IS NOT NULL
)
SELECT dups.id AS duplicate_id, keeps.id AS keep_id
FROM ranked dups
JOIN ranked keeps
  ON keeps.school_id = dups.school_id
  AND keeps.name = dups.name
  AND keeps.rn = 1
WHERE dups.rn > 1;

-- Step 3b: Re-point score_components from duplicate profiles to the kept one
UPDATE score_components sc
SET score_component_profile_id = m.keep_id
FROM _scp_dedup_map m
WHERE sc.score_component_profile_id = m.duplicate_id;

-- Step 3b2: Re-point assessment_window_classes from duplicate profiles to kept one.
-- If the kept profile is already linked to the same window+class, delete the
-- duplicate row instead (the unique constraint on (assessment_window_id,
-- class_node_id) would otherwise block the UPDATE).
DELETE FROM assessment_window_classes awc
USING _scp_dedup_map m
WHERE awc.score_component_profile_id = m.duplicate_id
  AND EXISTS (
    SELECT 1 FROM assessment_window_classes existing
    WHERE existing.assessment_window_id = awc.assessment_window_id
      AND existing.class_node_id = awc.class_node_id
      AND existing.score_component_profile_id = m.keep_id
  );

UPDATE assessment_window_classes awc
SET score_component_profile_id = m.keep_id
FROM _scp_dedup_map m
WHERE awc.score_component_profile_id = m.duplicate_id;

-- Step 3c: Delete the duplicate profiles
DELETE FROM score_component_profiles
WHERE id IN (SELECT duplicate_id FROM _scp_dedup_map);

DROP TABLE _scp_dedup_map;

-- ── 4. Make assessment_window_id nullable ───────────────────────────────────

ALTER TABLE score_component_profiles
  ALTER COLUMN assessment_window_id DROP NOT NULL;

-- ── 5. Replace unique constraint ────────────────────────────────────────────

ALTER TABLE score_component_profiles
  DROP CONSTRAINT IF EXISTS score_component_profiles_assessment_window_id_name_key;

ALTER TABLE score_component_profiles
  ADD CONSTRAINT score_component_profiles_school_id_name_key
  UNIQUE (school_id, name);

-- ── 6. Set school_id NOT NULL (after backfill + dedup) ──────────────────────

ALTER TABLE score_component_profiles
  ALTER COLUMN school_id SET NOT NULL;

-- ── 7. Rewrite RLS policies ─────────────────────────────────────────────────

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
