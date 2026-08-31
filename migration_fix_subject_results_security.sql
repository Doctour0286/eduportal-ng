-- ═══════════════════════════════════════════════════════════════════════════
-- FIX: subject_results tenant isolation (PHASE1_AUDIT finding C1)
--
-- Problem:
--   subject_results is a plain view with no security_invoker and no school_id
--   enforcement. RLS on underlying scores is not enforced through the view.
--   3 of 4 client consumers don't filter by school_id — any direct query
--   returns every school's approved results.
--
-- Fix (two-pronged):
--   1. Recreate the view with security_invoker = true so RLS on the underlying
--      scores table IS enforced when querying through the view. No WHERE clause
--      on the view itself — the promotion RPC (preview_secondary_promotion) is
--      SECURITY DEFINER and needs cross-school access; a WHERE clause would
--      break it by restricting to the calling user's school.
--
--   2. Create get_subject_results(p_school_id) SECURITY DEFINER function as
--      the primary secure access path for client code. It:
--      - Validates the caller belongs to the requested school
--      - Returns only that school's rows
--      - Provides explicit school boundary (not dependent on RLS propagation)
--
--   The grade_scales subquery in the view has no RLS and could return labels
--   from other schools when queried via the view. The function avoids this by
--   scoping its output to p_school_id. This is another reason the function is
--   the preferred interface.
--
-- Defense-in-depth: client-side .eq('school_id', ...) filters are also added
-- to all 3 unfiltered consumers (assessmentService, ReportCardsPanel,
-- resultsService) as redundant protection.
--
-- PG version: Supabase runs PG 15+ which supports security_invoker on views.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Recreate the view with security_invoker ─────────────────────────────
-- security_invoker = true: RLS on scores/score_components/students is
-- enforced when the view is queried. The view itself does NOT filter by
-- school_id — this preserves backward compatibility with the promotion RPC
-- which is SECURITY DEFINER and needs cross-school data access.

drop view if exists subject_results;

create view subject_results with (security_invoker = true) as
with calc as (
  select
    s.student_id, s.subject_id, s.term_id, s.session_id, s.school_id,
    (select st.class_node_id from students st where st.id = s.student_id) as class_node_id,
    sum(s.value * sc.weight_pct / coalesce(sc.max_score, 100)) as weighted_total
  from scores s
  join score_components sc on sc.id = s.score_component_id
  where s.approved_at is not null
  group by s.student_id, s.subject_id, s.term_id, s.session_id, s.school_id
)
select
  c.student_id, c.subject_id, c.term_id, c.session_id, c.school_id,
  c.weighted_total,
  (
    select g.grade_label
    from grade_scales g
    where g.school_id = c.school_id
      and c.weighted_total >= g.min_score
      and c.weighted_total <= g.max_score
    order by g.sort_order
    limit 1
  ) as grade_label,
  rank() over (
    partition by c.school_id, c.subject_id, c.term_id, c.class_node_id
    order by c.weighted_total desc
  ) as position_in_class
from calc c;

-- ── 2. Secure access function (primary interface for client queries) ────────
-- SECURITY DEFINER: runs with function owner privileges (bypasses view RLS).
-- Explicitly validates school access and filters to p_school_id.
-- Returns the same column set as the view.

create or replace function get_subject_results(p_school_id uuid)
returns table (
  student_id       uuid,
  subject_id       uuid,
  term_id          uuid,
  session_id       uuid,
  school_id        uuid,
  weighted_total   numeric,
  grade_label      text,
  position_in_class bigint
)
language sql
security definer
stable
as $$
  -- Gate 1: caller must belong to the requested school
  select *
  from subject_results sr
  where sr.school_id = p_school_id
    and exists (
      select 1 from app_identities
      where auth_user_id = auth.uid()
        and school_id = p_school_id
    );
$$;

-- Grant execute to authenticated role (RLS-like gate is inside the function)
grant execute on function get_subject_results(uuid) to authenticated;

-- ── 3. Comment documentation ───────────────────────────────────────────────

comment on view subject_results is
  'Subject-level results with grades and class position. '
  'Uses security_invoker = true so RLS on underlying scores table is enforced. '
  'Does NOT filter by school_id — the promotion RPC needs cross-school access. '
  'For client queries, use get_subject_results(p_school_id) instead.';

comment on function get_subject_results(uuid) is
  'Secure access to subject_results with explicit school_id parameter. '
  'Validates caller belongs to the school, returns only that school''s rows. '
  'Primary interface for all client-side queries (replaces direct view access).';
