-- ============================================================================
-- migration_tier8_s46_assessment_windows.sql
-- PRD Tier 8 / Problem 8.4 — Assessment Window system, CORE tables.
-- (Sessions 45+46: schema accepted into master plan §7.14a; core migration.)
--
-- Run order: FIRST of the four Tier 8 migrations (s46 → s48 → s49 → s50).
-- Idempotent: safe to re-run (add-column-if-not-exists / drop-policy-if-
-- exists / on-conflict-do-nothing throughout), per the Tier 9 lesson that a
-- partially-applied migration must never wedge a second run.
--
-- What this does:
--   1. assessment_windows        — the shell (one round of assessment)
--   2. score_component_profiles  — per-window weighting formulas ("Primary weighting")
--   3. assessment_window_classes — which classes the window covers + per-class overrides
--   4. score_components          — RE-SCOPED from school-wide to profile-scoped
--                                  (+ max_score so teachers enter "out of 20" directly,
--                                  + updated_at per §7 conventions)
--   5. subject_results view      — recreated with max_score normalization
--                                  (value * weight_pct / max_score). Identical results
--                                  while max_score = 100, which is every row today.
--   6. scores gating trigger     — INSERT/UPDATE blocked unless an OPEN window covers
--                                  the student's class + session + term. Legacy-tolerant:
--                                  schools with ZERO windows keep working exactly as
--                                  before until they adopt their first window.
--   7. Permission keys           — 4 new catalog rows (academics.*), no-op if present.
--
-- SAFE-BY-CONSTRUCTION notes:
--   - score_components is confirmed EMPTY platform-wide (PRD Problem 8.3 SQL check),
--     so re-scoping it loses nothing.
--   - The pre-existing RLS policies on score_components (Phase 2, exact policy text
--     not visible from here) are left in place — permissive Postgres policies OR
--     together, so this migration's new stricter write policy can only narrow via
--     the trigger below, never silently widen anything. Owner follow-up: review
--     pg_policies on score_components after running and drop any stale Phase-2
--     write policy if one exists (flagged in PRD, not done blind here).
-- ============================================================================

-- ── 1. assessment_windows ───────────────────────────────────────────────────

create table if not exists assessment_windows (
  id                         uuid primary key default gen_random_uuid(),
  school_id                  uuid not null references schools(id),
  session_id                 uuid not null references sessions(id),
  term_id                    uuid references terms(id),          -- null = whole session (uses_terms=false, §3.6 duality)
  name                       text not null,
  scope                      text not null default 'whole_school'
                             check (scope in ('whole_school','selected_classes')),
  status                     text not null default 'draft'
                             check (status in ('draft','open','closed','finalized')),
  -- Default dates for attached classes; per-class overrides live on
  -- assessment_window_classes. Informational/displayed — `status` is what
  -- actually gates entry (see trigger below).
  scores_open_at             timestamptz,
  scores_submission_deadline timestamptz,
  scores_close_at            timestamptz,
  created_by                 uuid references auth.users(id),
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);

drop trigger if exists set_updated_at_assessment_windows on assessment_windows;
create trigger set_updated_at_assessment_windows before update on assessment_windows
  for each row execute function set_updated_at();

drop policy if exists asw_select on assessment_windows;
create policy asw_select on assessment_windows
  for select using (school_id = current_school_id());

drop policy if exists asw_insert on assessment_windows;
create policy asw_insert on assessment_windows
  for insert with check (
    school_id = current_school_id()
    and (current_is_admin() or current_has_permission('academics.assessment_windows.manage'))
  );

drop policy if exists asw_update on assessment_windows;
create policy asw_update on assessment_windows
  for update using (
    school_id = current_school_id()
    and (current_is_admin() or current_has_permission('academics.assessment_windows.manage'))
  )
  with check (school_id = current_school_id());

drop policy if exists asw_delete on assessment_windows;
create policy asw_delete on assessment_windows
  for delete using (
    school_id = current_school_id()
    and (current_is_admin() or current_has_permission('academics.assessment_windows.manage'))
  );

-- ── 2. score_component_profiles ─────────────────────────────────────────────

create table if not exists score_component_profiles (
  id                   uuid primary key default gen_random_uuid(),
  assessment_window_id uuid not null references assessment_windows(id) on delete cascade,
  name                 text not null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (assessment_window_id, name)
);

drop trigger if exists set_updated_at_score_component_profiles on score_component_profiles;
create trigger set_updated_at_score_component_profiles before update on score_component_profiles
  for each row execute function set_updated_at();

drop policy if exists scp_select on score_component_profiles;
create policy scp_select on score_component_profiles
  for select using (
    exists (
      select 1 from assessment_windows w
      where w.id = assessment_window_id
        and w.school_id = current_school_id()
    )
  );

drop policy if exists scp_select on score_component_profiles;
create policy scp_select on score_component_profiles
  for select using (
    exists (
      select 1 from assessment_windows w
      where w.id = assessment_window_id
        and w.school_id = current_school_id()
    )
  );

drop policy if exists scp_insert on score_component_profiles;
create policy scp_insert on score_component_profiles
  for insert with check (
    exists (
      select 1 from assessment_windows w
      where w.id = assessment_window_id
        and w.school_id = current_school_id()
        and (current_is_admin() or current_has_permission('academics.assessment_windows.manage'))
    )
  );

drop policy if exists scp_update on score_component_profiles;
create policy scp_update on score_component_profiles
  for update using (
    exists (
      select 1 from assessment_windows w
      where w.id = assessment_window_id
        and w.school_id = current_school_id()
        and (current_is_admin() or current_has_permission('academics.assessment_windows.manage'))
    )
  )
  with check (
    exists (
      select 1 from assessment_windows w
      where w.id = assessment_window_id
        and w.school_id = current_school_id()
    )
  );

drop policy if exists scp_delete on score_component_profiles;
create policy scp_delete on score_component_profiles
  for delete using (
    exists (
      select 1 from assessment_windows w
      where w.id = assessment_window_id
        and w.school_id = current_school_id()
        and (current_is_admin() or current_has_permission('academics.assessment_windows.manage'))
    )
  );

-- ── 3. score_components — re-scoped under profiles ──────────────────────────

alter table score_components add column if not exists score_component_profile_id uuid references score_component_profiles(id);
alter table score_components add column if not exists max_score numeric(5,2) not null default 100;
alter table score_components add column if not exists updated_at timestamptz not null default now();

drop trigger if exists set_updated_at_score_components on score_components;
create trigger set_updated_at_score_components before update on score_components
  for each row execute function set_updated_at();

-- Empty-table-safe NOT NULL (confirmed zero rows platform-wide, PRD 8.3).
alter table score_components alter column score_component_profile_id set not null;

-- New write policies (admin or manage key). Reads stay [STD] via school_id,
-- which is retained on this table deliberately: components are read by every
-- teacher rendering the entry grid, and scoping reads through the profile→
-- window join in RLS would make every grid load a 3-table chain.
drop policy if exists sc_select on score_components;
create policy sc_select on score_components
  for select using (school_id = current_school_id());

drop policy if exists sc_insert on score_components;
create policy sc_insert on score_components
  for insert with check (
    school_id = current_school_id()
    and (current_is_admin() or current_has_permission('academics.assessment_windows.manage'))
  );

drop policy if exists sc_update on score_components;
create policy sc_update on score_components
  for update using (
    school_id = current_school_id()
    and (current_is_admin() or current_has_permission('academics.assessment_windows.manage'))
  )
  with check (school_id = current_school_id());

drop policy if exists sc_delete on score_components;
create policy sc_delete on score_components
  for delete using (
    school_id = current_school_id()
    and (current_is_admin() or current_has_permission('academics.assessment_windows.manage'))
  );

-- ── 4. assessment_window_classes ────────────────────────────────────────────

create table if not exists assessment_window_classes (
  id                        uuid primary key default gen_random_uuid(),
  assessment_window_id      uuid not null references assessment_windows(id) on delete cascade,
  class_node_id             uuid not null references class_nodes(id),
  score_component_profile_id uuid not null references score_component_profiles(id),
  is_promotional            boolean not null default true,   -- admin unchecks exam classes (JSS3/SS3)
  sits_exam                 boolean not null default false,  -- WAEC/BECE-track class marker
  scores_open_at            timestamptz,                     -- per-class overrides of the window defaults
  scores_submission_deadline timestamptz,
  scores_close_at           timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (assessment_window_id, class_node_id)
);

drop trigger if exists set_updated_at_assessment_window_classes on assessment_window_classes;
create trigger set_updated_at_assessment_window_classes before update on assessment_window_classes
  for each row execute function set_updated_at();

drop policy if exists awc_select on assessment_window_classes;
create policy awc_select on assessment_window_classes
  for select using (
    exists (
      select 1 from assessment_windows w
      where w.id = assessment_window_id
        and w.school_id = current_school_id()
    )
  );

drop policy if exists awc_select on assessment_window_classes;
create policy awc_select on assessment_window_classes
  for select using (
    exists (
      select 1 from assessment_windows w
      where w.id = assessment_window_id
        and w.school_id = current_school_id()
    )
  );

drop policy if exists awc_insert on assessment_window_classes;
create policy awc_insert on assessment_window_classes
  for insert with check (
    exists (
      select 1 from assessment_windows w
      where w.id = assessment_window_id
        and w.school_id = current_school_id()
        and (current_is_admin() or current_has_permission('academics.assessment_windows.manage'))
    )
  );

drop policy if exists awc_update on assessment_window_classes;
create policy awc_update on assessment_window_classes
  for update using (
    exists (
      select 1 from assessment_windows w
      where w.id = assessment_window_id
        and w.school_id = current_school_id()
        and (current_is_admin() or current_has_permission('academics.assessment_windows.manage'))
    )
  )
  with check (
    exists (
      select 1 from assessment_windows w
      where w.id = assessment_window_id
        and w.school_id = current_school_id()
    )
  );

drop policy if exists awc_delete on assessment_window_classes;
create policy awc_delete on assessment_window_classes
  for delete using (
    exists (
      select 1 from assessment_windows w
      where w.id = assessment_window_id
        and w.school_id = current_school_id()
        and (current_is_admin() or current_has_permission('academics.assessment_windows.manage'))
    )
  );

-- ── 5. subject_results — recreate with max_score normalization ──────────────
-- Column set preserved exactly (student_id, subject_id, term_id, session_id,
-- school_id, weighted_total, grade_label, position_in_class) — every consumer
-- (resultsService.ts, portalService.ts) selects these fixed columns.
-- Formula change: value * weight_pct / COALESCE(max_score, 100). With the
-- shipped default max_score = 100 this reproduces the old numbers exactly.

create or replace view subject_results as
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

-- ── 6. scores window-gating trigger ─────────────────────────────────────────
-- Enforcement model:
--   * School has ZERO assessment_windows rows → legacy tolerance, everything
--     passes (schools that never adopt windows see zero behavior change).
--   * INSERT of a score → requires an OPEN window covering the student's
--     class + session + term (whole_school scope covers every class;
--     selected_classes scope requires an attach row).
--   * UPDATE changing value → same OPEN requirement (entry/edit).
--   * UPDATE only touching approval columns → allowed while open OR closed
--     (approval happens after entry closes); blocked when finalized.
--   * Any write against a draft or finalized window → blocked.
-- Errors are plain English (§4.3) because they surface in the app UI.

create or replace function enforce_assessment_window_scores()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_class_node_id uuid;
  v_window record;
  v_value_changing boolean;
begin
  -- Legacy tolerance: school has never adopted windows → old behavior.
  if not exists (select 1 from assessment_windows where school_id = new.school_id) then
    return new;
  end if;

  select class_node_id into v_class_node_id
  from students where id = new.student_id;

  if v_class_node_id is null then
    return new;  -- orphaned legacy row; let existing constraints decide
  end if;

  -- Find the covering window: term-matched (null matches null), either
  -- whole_school scope or selected_classes with an attach row for this class.
  select w.* into v_window
  from assessment_windows w
  where w.school_id = new.school_id
    and w.session_id = new.session_id
    and w.term_id is not distinct from new.term_id
    and (
      w.scope = 'whole_school'
      or exists (
        select 1 from assessment_window_classes awc
        where awc.assessment_window_id = w.id
          and awc.class_node_id = v_class_node_id
      )
    )
  limit 1;

  if v_window is null then
    raise exception 'No assessment window covers this class for this term yet. Ask your administrator to create one in Settings > Assessments.';
  end if;

  -- OLD does not exist on INSERT — must branch before touching it (plpgsql
  -- raises "record old is not assigned" if an INSERT trigger reads OLD).
  if tg_op = 'INSERT' then
    v_value_changing := true;
  else
    v_value_changing := old.value is distinct from new.value;
  end if;

  if v_value_changing then
    if v_window.status <> 'open' then
      raise exception 'Score entry for "%" is closed (window status: %).', v_window.name, v_window.status;
    end if;
  else
    -- Approval-only update: permitted while open or closed, never draft/finalized.
    if v_window.status not in ('open', 'closed') then
      raise exception 'Scores for "%" are locked (window status: %).', v_window.name, v_window.status;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enforce_assessment_window_scores on scores;
create trigger trg_enforce_assessment_window_scores
  before insert or update on scores
  for each row execute function enforce_assessment_window_scores();

-- ── 7. Permission catalog additions ─────────────────────────────────────────

insert into permissions (key, module, description) values
  ('academics.assessment_windows.manage', 'academics', 'Create and configure assessment windows, weight profiles, and score components'),
  ('academics.exam_timetable.manage',     'academics', 'Manage exam timetable entries, venues, and invigilator assignments'),
  ('academics.remarks.manage',            'academics', 'Enter students'' report-card remarks (class teacher''s remark)'),
  ('academics.promotion.run',             'academics', 'Run end-of-session promotion and record manual promotion decisions')
on conflict (key) do nothing;
