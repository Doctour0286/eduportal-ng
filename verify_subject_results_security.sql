-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFICATION TEST for subject_results security fix (C1)
-- Run AFTER applying migration_fix_subject_results_security.sql
-- Run as authenticated user (not service_role) to test RLS behavior.
-- ═══════════════════════════════════════════════════════════════════════════

-- Test 1: Confirm security_invoker is set on the view
-- Expected: reloptions should contain 'security_invoker=1'
select relname, reloptions from pg_class where relname = 'subject_results';

-- Test 2: Confirm function exists
select proname, prosecdef from pg_proc where proname = 'get_subject_results';

-- Test 3: Cross-school isolation (FAIL EXPECTED — expect 0 rows)
-- Replace the UUID below with a school_id that is NOT the caller's own school
-- select count(*) from get_subject_results('00000000-0000-0000-0000-000000000000'::uuid);

-- Test 4: Same-school access (PASS EXPECTED — expect rows if approved scores exist)
-- Replace with the caller's own school_id
-- select count(*) from get_subject_results('<YOUR_SCHOOL_UUID>'::uuid);

-- Test 5: Direct view query — group by school_id to check isolation
-- Expected: only the caller's school rows (RLS on scores enforces this)
select school_id, count(*) as row_count from subject_results group by school_id;
