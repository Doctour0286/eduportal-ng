-- ============================================================================
-- migration_tier8_s85_reusable_score_profiles.sql
-- PRD Tier 8 / Problem 8.4 (Session 85 — owner request: "I want the
-- profiles to be usable across Windows").
--
-- ROOT CAUSE: score_component_profiles.assessment_window_id was `not null
-- references assessment_windows(id) on delete cascade` — every profile
-- belonged to exactly ONE window at the schema level, so a profile
-- created for Window A could never be attached to Window B, and deleting
-- a window destroyed all of its profiles (and, transitively, their
-- score_components) even if an admin wanted to reuse that weighting
-- scheme again later.
--
-- Confirmed while investigating that this codebase was ALREADY mid-way
-- through this exact change before this session: ComponentProfile's own
-- TypeScript type already declared assessment_window_id as `string |
-- null`, saveProfile() already accepted an optional/nullable windowId,
-- and a loadSchoolProfiles(schoolId) function already existed — all
-- clearly written in anticipation of this migration, but never wired
-- into the UI and never actually applied to the database. This migration
-- is that missing piece, not a new design.
--
-- WHAT CHANGES:
--   1. assessment_window_id becomes nullable, and its cascade-delete is
--      dropped (a profile now survives window deletion) — the column
--      stays on the table for historical/legacy rows created before this
--      migration.
--   2. Uniqueness moves from (assessment_window_id, name) to
--      (school_id, name) — a school shouldn't have two profiles with the
--      same name regardless of which window either was created under;
--      this is the natural "namespace" for a profile once it's no longer
--      scoped to one window.
--   3. Existing profiles are NOT retroactively detached from their
--      current window (assessment_window_id keeps its existing value for
--      every pre-migration row) — only NEWLY created profiles going
--      forward will have assessment_window_id = null. This is a
--      deliberately conservative choice: an existing profile still shows
--      which window it was originally created under (useful history),
--      while being newly eligible for attachment to OTHER windows too —
--      nothing about a non-null assessment_window_id ever blocked that;
--      assessment_window_classes.score_component_profile_id's own
--      foreign key only requires the profile to exist, not that it
--      belong to the same window being attached to.
--
-- Run order: after all prior tier8 migrations. Idempotent: safe to re-run
-- (every constraint add is preceded by a matching drop-if-exists, so a
-- prior partial run — e.g. one that got through the FK change but failed
-- on the uniqueness constraint, or vice versa — can be safely re-run to
-- completion without manual cleanup first).
-- ============================================================================

-- Drop the old cascade-delete FK and the old per-window uniqueness.
alter table score_component_profiles
  drop constraint if exists score_component_profiles_assessment_window_id_fkey;

alter table score_component_profiles
  drop constraint if exists score_component_profiles_assessment_window_id_name_key;

-- Re-add the FK without cascade delete, and allow null.
alter table score_component_profiles
  alter column assessment_window_id drop not null;

alter table score_component_profiles
  drop constraint if exists score_component_profiles_assessment_window_id_fkey;

alter table score_component_profiles
  add constraint score_component_profiles_assessment_window_id_fkey
  foreign key (assessment_window_id) references assessment_windows(id) on delete set null;

-- New school-scoped uniqueness. If any pre-existing school happens to
-- have two profiles with the same name under different windows, this ADD
-- CONSTRAINT will fail loudly rather than silently drop or rename one —
-- intentional, since silently altering an admin's existing data to force
-- uniqueness is not a call this migration should make on its own. If it
-- fails, the conflicting profile names must be resolved by hand (rename
-- one) before re-running this migration.
alter table score_component_profiles
  drop constraint if exists score_component_profiles_school_id_name_key;

alter table score_component_profiles
  add constraint score_component_profiles_school_id_name_key
  unique (school_id, name);
