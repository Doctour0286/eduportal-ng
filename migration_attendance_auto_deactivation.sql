-- ============================================================================
-- migration_attendance_auto_deactivation.sql
-- Feature: auto-deactivate a student after N absences while this setting is
-- turned on for the school. Owner-specified rules (chat design session):
--
--   - Client-triggered, not a real server-side cron job ("looks automatic" —
--     the actual status flip happens the next time a staff member with
--     students.records.manage opens a screen that runs the check, after the
--     qualifying school day has ended). No new hosting/scheduling
--     infrastructure required.
--   - Two selectable modes, per school: 'consecutive' (N school days absent
--     in a row) or 'cumulative' (N absences total since the setting was last
--     turned on). Both thresholds are stored even when only one mode is
--     live, so switching modes never loses the other number.
--   - Only 'absent' counts. present/late/excused all break a consecutive
--     streak (excused breaks it too — an excused absence is the system
--     giving credit for a legitimate reason to be away, so it must not be
--     treated as if it extends an unexcused streak). An unmarked day is
--     ignored entirely: it neither breaks nor extends a streak.
--   - Absences before the setting's activated_at never count, even if a
--     student was already mid-streak when it was turned on — the streak
--     effectively starts at zero for everyone at the moment of activation.
--   - Cumulative mode does NOT reset at a term boundary ("roll across terms
--     if not deactivated before a term change") — it only resets when the
--     setting is deactivated and later re-activated (a fresh activated_at),
--     or when a student is reactivated after being auto-deactivated.
--   - Reactivating a student (existing updateStudentStatus() flow) requires
--     a note and resets both counters to zero.
--
-- Tables:
--   1. attendance_deactivation_settings — one row per school
--   2. students — 5 new columns (counters + last-absent date + reason/note)
--
-- Trigger:
--   recompute_attendance_deactivation_counts() on attendance_records,
--   AFTER INSERT OR UPDATE — see its own header comment below for why this
--   recomputes both counters from scratch on every write rather than a naive
--   increment/decrement, and why it must be SECURITY DEFINER.
--
-- No new permission keys — settings management reuses current_is_admin()
-- (SettingsModule.tsx is already fully admin-gated, per its own isAdmin
-- prop), and the actual deactivation write reuses updateStudentStatus()'s
-- existing students.records.manage-gated path client-side, with no bypass
-- introduced here for that call.
--
-- Idempotent: safe to re-run (drop-if-exists / add-column-if-not-exists).
-- ============================================================================

-- ── 1. attendance_deactivation_settings ─────────────────────────────────────

create table if not exists attendance_deactivation_settings (
  school_id             uuid primary key references schools(id),
  enabled               boolean not null default false,
  mode                  text not null default 'consecutive'
                          check (mode in ('consecutive', 'cumulative')),
  consecutive_threshold int not null default 5 check (consecutive_threshold > 0),
  cumulative_threshold  int not null default 5 check (cumulative_threshold > 0),
  -- Set (or re-set) every time `enabled` transitions false -> true. Null
  -- while never yet activated. The counter-recompute trigger below treats
  -- any attendance_records date before this as "doesn't count," and
  -- saveAttendanceDeactivationSettings() (settingsService.ts) zeroes every
  -- active student's counters in the same call that sets a fresh value here
  -- — see that function's own comment for why toggling off-then-on is
  -- treated as a brand-new activation rather than resuming old counts.
  activated_at          timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

comment on table attendance_deactivation_settings is
  'One row per school. Configures the optional rule that auto-sets a '
  'student to inactive after too many absences while this is turned on. '
  'See this file''s header comment for the full rule set.';

drop trigger if exists set_updated_at_attendance_deactivation_settings on attendance_deactivation_settings;
create trigger set_updated_at_attendance_deactivation_settings
  before update on attendance_deactivation_settings
  for each row execute function set_updated_at();

alter table attendance_deactivation_settings enable row level security;

-- SELECT: admins (SettingsModule) + anyone who can actually manage student
-- status (StudentsModule needs to read enabled/mode/threshold to run the
-- client-side check).
drop policy if exists ads_select on attendance_deactivation_settings;
create policy ads_select on attendance_deactivation_settings
  for select using (
    school_id = current_school_id()
    and (current_is_admin() or current_has_permission('students.records.manage'))
  );

-- INSERT/UPDATE: admin-only, matching SettingsModule.tsx's own admin gate —
-- there is no dedicated "manage this setting" permission key, deliberately,
-- since every other setting on that same page is admin-only the same way.
drop policy if exists ads_insert on attendance_deactivation_settings;
create policy ads_insert on attendance_deactivation_settings
  for insert with check (school_id = current_school_id() and current_is_admin());

drop policy if exists ads_update on attendance_deactivation_settings;
create policy ads_update on attendance_deactivation_settings
  for update using (school_id = current_school_id() and current_is_admin());

-- No DELETE policy — a school either has zero rows (never configured) or
-- exactly one, toggled via UPDATE/UPSERT. Same "no hard deletes" convention
-- this project uses elsewhere (status flips, not row removal).

-- ── 2. students: new columns ────────────────────────────────────────────────

alter table students
  add column if not exists consecutive_absent_count int not null default 0,
  add column if not exists cumulative_absent_count  int not null default 0,
  -- Most recent date this student was marked 'absent' on or after the
  -- setting's activated_at. Lets the client-side check (studentsService.ts's
  -- runAttendanceAutoDeactivationCheck()) know whether the qualifying school
  -- day has actually ended yet, reusing attendanceService.ts's existing
  -- getSchoolHoursEndMoment()/isWithinEditWindow() — deactivation must wait
  -- until that day is over, giving staff the rest of the day to correct a
  -- mis-tap before it becomes a status change.
  add column if not exists last_absent_date         date,
  -- Distinguishes an auto-deactivation from every other reason a student
  -- might be set to inactive, without guessing from audit_log diffs. Only
  -- value used today is 'attendance_auto'; null for every other case
  -- (manual deactivation, alumni, transfer, never deactivated).
  add column if not exists deactivation_reason       text
                              check (deactivation_reason in ('attendance_auto') or deactivation_reason is null),
  -- Free-text note captured on a status change. Required by the UI on
  -- reactivation (StudentsModule.tsx); optional elsewhere. Generic on
  -- purpose rather than a reactivation-specific column, so any future
  -- status-change flow can reuse it the same way.
  add column if not exists status_change_note        text;

comment on column students.consecutive_absent_count is
  'Current run of consecutive school-day absences since attendance_deactivation_settings.activated_at. Maintained by recompute_attendance_deactivation_counts(); never written directly by application code.';
comment on column students.cumulative_absent_count is
  'Total absences since attendance_deactivation_settings.activated_at (does not reset at term boundaries — only on reactivation or the setting being re-activated). Maintained by recompute_attendance_deactivation_counts(); never written directly by application code.';
comment on column students.deactivation_reason is
  '''attendance_auto'' if this student''s current inactive status was set by the attendance auto-deactivation check; null otherwise.';

create index if not exists idx_students_attendance_deactivation
  on students(school_id, status, consecutive_absent_count, cumulative_absent_count);

-- ── 3. Counter-maintenance trigger ──────────────────────────────────────────

/**
 * Recomputes (not increments) both absence counters for one student every
 * time one of their attendance_records rows is written.
 *
 * Why recompute instead of a simple +1/-1 counter:
 *
 *   cumulative_absent_count is order-independent — a plain count of
 *   'absent' rows since activated_at is always correct and can never drift,
 *   so it's just recomputed fresh every time. Cheap: bounded by the current
 *   activation window, which resets to empty every time the setting is
 *   re-activated.
 *
 *   consecutive_absent_count is NOT order-independent. A naive "+1 on
 *   absent, reset to 0 on present" counter breaks the moment a staff member
 *   corrects a mid-streak record (e.g. absent/absent/absent -> a teacher
 *   fixes the middle day to present after realizing it was a mis-tap): the
 *   correct new streak as of today depends on the whole sequence, not on
 *   adding or subtracting 1 from whatever the counter previously held. So
 *   this function walks backward one school day at a time from today,
 *   stopping at the first present/late/excused day it finds (or at
 *   activated_at's date, whichever comes first), skipping any unmarked day
 *   without breaking or extending the streak, per the owner's explicit
 *   "unmarked is ignored" rule.
 *
 * IMPORTANT — kept in sync by hand, not shared code: the school-day check
 * below (school_calendar_days override, falling back to school_week_days)
 * duplicates the exact logic attendanceService.ts's isSchoolDay() and
 * getSchoolDayMap() implement in JS, because there is no practical way to
 * share one implementation across a Postgres trigger and the frontend. If
 * that fallback logic is ever changed in attendanceService.ts, this
 * function must be updated to match, or the two will silently disagree
 * about which days count.
 *
 * Also worth knowing: current_date here uses the database's own session
 * timezone, not any per-school timezone (this schema has no per-school
 * timezone column anywhere today). For a school far from that timezone,
 * the boundary between "today" and "yesterday" in this function could
 * differ by a few hours from what the school's own clock would say late at
 * night. Not fixed here — flagging it as a known limitation rather than a
 * silent assumption.
 *
 * SECURITY DEFINER is required: this trigger fires on every attendance
 * write, including ones made by a teacher whose role only carries
 * academics.attendance.mark — not students.records.manage — so it must run
 * with elevated privilege to write these two derived columns on `students`,
 * the same way a teacher is already trusted to write attendance_records
 * itself. It does NOT touch students.status — the actual deactivation
 * decision and write stay entirely in application code, gated by
 * students.records.manage, exactly as before this migration.
 */
create or replace function recompute_attendance_deactivation_counts()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_student_id uuid := coalesce(new.student_id, old.student_id);
  v_school_id  uuid := coalesce(new.school_id, old.school_id);
  v_settings   record;
  v_cursor     date;
  v_status     text;
  v_override   text;
  v_weekday    int;
  v_is_school_day boolean;
  v_streak     int := 0;
begin
  select * into v_settings
  from attendance_deactivation_settings
  where school_id = v_school_id;

  -- Never configured, or currently turned off: leave whatever the counters
  -- already hold untouched. saveAttendanceDeactivationSettings() is what
  -- zeroes them out on the next activation, not this trigger.
  if v_settings is null or not v_settings.enabled or v_settings.activated_at is null then
    return coalesce(new, old);
  end if;

  -- Cumulative: simple recomputed total, order doesn't matter.
  update students
  set cumulative_absent_count = sub.cnt,
      last_absent_date        = sub.last_date
  from (
    select
      count(*) as cnt,
      max(date) as last_date
    from attendance_records
    where student_id = v_student_id
      and status = 'absent'
      and date >= v_settings.activated_at::date
  ) sub
  where students.id = v_student_id;

  -- Consecutive: walk backward one school day at a time from today.
  v_cursor := current_date;

  while v_cursor >= v_settings.activated_at::date loop
    select day_type into v_override
    from school_calendar_days
    where school_id = v_school_id and calendar_date = v_cursor;

    if v_override is not null then
      v_is_school_day := (v_override = 'school_day');
    else
      v_weekday := extract(dow from v_cursor);
      select exists(
        select 1 from school_week_days
        where school_id = v_school_id and day_of_week = v_weekday
      ) into v_is_school_day;
    end if;

    if v_is_school_day then
      select status into v_status
      from attendance_records
      where student_id = v_student_id and date = v_cursor;

      if v_status = 'absent' then
        v_streak := v_streak + 1;
      elsif v_status is not null then
        exit; -- present/late/excused: streak stops here
      end if;
      -- v_status is null (unmarked school day): ignored, keep walking back
    end if;

    v_cursor := v_cursor - 1;
  end loop;

  update students
  set consecutive_absent_count = v_streak
  where id = v_student_id;

  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_attendance_deactivation_counts on attendance_records;
create trigger trg_attendance_deactivation_counts
  after insert or update on attendance_records
  for each row execute function recompute_attendance_deactivation_counts();
