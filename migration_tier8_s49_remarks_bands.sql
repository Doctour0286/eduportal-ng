-- ============================================================================
-- migration_tier8_s49_remarks_bands.sql
-- PRD Tier 8 / Problem 8.4 (Session 49) — aggregate remark bands +
-- class-teacher remark per student per window.
--
-- Run order: THIRD of the four Tier 8 migrations (after s48).
-- Idempotent: safe to re-run.
--
-- Decisions recorded here (master plan §12):
--   D4a — the class teacher's remark is ONE field per student per assessment
--         window (not per subject), matching how it physically appears on a
--         Nigerian report card. Placement decision (the PRD left this open
--         "at build time"): its own table, keyed (window, student), rather
--         than a column on scores (per-subject) or promotion_history (wrong
--         lifecycle). school_id retained on the row so RLS stays a simple [STD].
--   D4b — who may write it: any staff holding academics.remarks.manage
--         (inserted by the s46 migration) or an admin. There is no form-teacher
--         concept in this schema yet; modeling one would be a separate,
--         larger design (flagged in §12 as future scope, not silently built).
-- ============================================================================

-- ── aggregate_remark_bands ──────────────────────────────────────────────────

create table if not exists aggregate_remark_bands (
  id          uuid primary key default gen_random_uuid(),
  school_id   uuid not null references schools(id),
  min_average numeric(5,2) not null,
  max_average numeric(5,2) not null,
  check (max_average >= min_average),
  remark      text not null,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

drop trigger if exists set_updated_at_aggregate_remark_bands on aggregate_remark_bands;
create trigger set_updated_at_aggregate_remark_bands before update on aggregate_remark_bands
  for each row execute function set_updated_at();

drop policy if exists arb_select on aggregate_remark_bands;
create policy arb_select on aggregate_remark_bands
  for select using (school_id = current_school_id());

drop policy if exists arb_write on aggregate_remark_bands;
create policy arb_write on aggregate_remark_bands
  for all using (
    school_id = current_school_id()
    and (current_is_admin() or current_has_permission('academics.assessment_windows.manage'))
  )
  with check (
    school_id = current_school_id()
    and (current_is_admin() or current_has_permission('academics.assessment_windows.manage'))
  );

-- ── assessment_window_student_remarks ───────────────────────────────────────

create table if not exists assessment_window_student_remarks (
  id                   uuid primary key default gen_random_uuid(),
  school_id            uuid not null references schools(id),
  assessment_window_id uuid not null references assessment_windows(id) on delete cascade,
  student_id           uuid not null references students(id),
  remark               text not null default '',
  entered_by           uuid references staff(id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (assessment_window_id, student_id)
);

drop trigger if exists set_updated_at_assessment_window_student_remarks on assessment_window_student_remarks;
create trigger set_updated_at_assessment_window_student_remarks before update on assessment_window_student_remarks
  for each row execute function set_updated_at();

drop policy if exists awsr_select on assessment_window_student_remarks;
create policy awsr_select on assessment_window_student_remarks
  for select using (school_id = current_school_id());

drop policy if exists awsr_write on assessment_window_student_remarks;
create policy awsr_write on assessment_window_student_remarks
  for all using (
    school_id = current_school_id()
    and (current_is_admin() or current_has_permission('academics.remarks.manage'))
  )
  with check (
    school_id = current_school_id()
    and (current_is_admin() or current_has_permission('academics.remarks.manage'))
  );
