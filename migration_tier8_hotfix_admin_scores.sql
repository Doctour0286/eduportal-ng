-- ============================================================================
-- migration_tier8_hotfix_admin_scores.sql
-- Tier 8 hotfix (owner report, 2026-08-26): admins could not approve scores
-- while assignment-holding staff could. Root cause: the Phase-2-era RLS on
-- `scores` permits insert/update ONLY through a matching teaching_assignments
-- row (§7.14's original design) and carries no admin carve-out — and admins
-- generally hold no teaching assignments. The app-side permission
-- (academics.scores.approve, admin-bypassed) passed; the database refused.
--
-- Fix is purely ADDITIVE: Postgres permissive policies are OR-combined, so
-- granting admins here succeeds regardless of what the legacy policy says —
-- no need to see or rewrite it (it stays as the teacher-path gate).
-- Owner directive recorded in §12: admins are unrestricted on scores.
--
-- Idempotent. Run once in SQL Editor.
-- ============================================================================

drop policy if exists scores_admin_full on scores;
create policy scores_admin_full on scores
  for all to authenticated
  using (current_is_admin() or is_platform_admin())
  with check (current_is_admin() or is_platform_admin());

-- Verification (run after):
--   select policyname, cmd from pg_policies where tablename = 'scores' order by 1;
--   -- must list scores_admin_full alongside the pre-existing policies
