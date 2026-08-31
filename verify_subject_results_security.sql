-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFICATION TEST for subject_results security fix (C1)
--
-- Run this AFTER applying migration_fix_subject_results_security.sql
--
-- Test strategy:
--   1. Confirm the view has security_invoker = true
--   2. Confirm get_subject_results() function exists
--   3. Test cross-school isolation: call get_subject_results() with a
--      school_id that is NOT the caller's current_school_id() — expect 0 rows
--   4. Test same-school access: call with the caller's own school_id — expect rows
--
-- Run as an authenticated user (not service_role) to test RLS behavior.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Test 1: Confirm security_invoker is set on the view ─────────────────────
-- Expected: reloptions should contain 'security_invoker=1'

select
  c.relname as view_name,
  c.reloptions
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where c.relname = 'subject_results'
  and n.nspname = 'public';

-- ── Test 2: Confirm function exists ─────────────────────────────────────────

select
  p.proname as function_name,
  l.lanname as language,
  p.prosecdef as security_definer
from pg_proc p
join pg_language l on l.oid = p.prolang
where p.proname = 'get_subject_results';

-- ── Test 3: Cross-school isolation (FAIL EXPECTED) ─────────────────────────
-- Replace '<OTHER_SCHOOL_UUID>' with a school_id that is NOT the caller's.
-- If the caller is from School A, use School B's UUID here.
-- Expected: 0 rows (function validates school membership)

select count(*) as cross_school_row_count
from get_subject_results('<OTHER_SCHOOL_UUID>'::uuid);

-- ── Test 4: Same-school access (PASS EXPECTED) ─────────────────────────────
-- Replace with the caller's own school_id.
-- Expected: rows returned (if approved scores exist for this school)

select count(*) as same_school_row_count
from get_subject_results('<YOUR_SCHOOL_UUID>'::uuid);

-- ── Test 5: Direct view query without school_id (defense-in-depth) ─────────
-- With security_invoker, RLS on scores is enforced. The caller should only
-- see their own school's rows through the view.
-- Expected: only caller's school rows (RLS on scores enforces this)

select
  school_id,
  count(*) as row_count
from subject_results
group by school_id;

-- If this returns rows from multiple schools, the RLS on scores is not
-- properly enforced and the WHERE clause approach is needed.
