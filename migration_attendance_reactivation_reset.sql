-- ============================================================================
-- migration_attendance_reactivation_reset.sql
-- Fix: a manually reactivated student was auto-deactivated again on the next
-- attendance write, because recompute_attendance_deactivation_counts()
-- re-derived both counters from ALL absences since the setting's
-- activated_at, ignoring the reset done at reactivation.
--
-- Adds students.attendance_count_start (date). updateStudentStatus() sets it
-- to the day AFTER reactivation; the trigger ignores attendance rows dated
-- before max(activated_at::date, attendance_count_start).
--
-- Idempotent: safe to re-run.
-- ============================================================================

alter table students
  add column if not exists attendance_count_start date;

comment on column students.attendance_count_start is
  'Earliest attendance date that counts toward auto-deactivation for this student. Set on manual reactivation to the following day so older absences are never recounted.';

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
  v_start      date;
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

  if v_settings is null or not v_settings.enabled or v_settings.activated_at is null then
    return coalesce(new, old);
  end if;

  -- Counting window starts at the later of: setting activation, or this
  -- student's last manual reactivation baseline.
  select greatest(v_settings.activated_at::date, coalesce(s.attendance_count_start, v_settings.activated_at::date))
  into v_start
  from students s
  where s.id = v_student_id;

  if v_start is null then
    v_start := v_settings.activated_at::date;
  end if;

  update students
  set cumulative_absent_count = sub.cnt,
      last_absent_date        = sub.last_date
  from (
    select count(*) as cnt, max(date) as last_date
    from attendance_records
    where student_id = v_student_id
      and status = 'absent'
      and date >= v_start
  ) sub
  where students.id = v_student_id;

  v_cursor := current_date;

  while v_cursor >= v_start loop
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
        exit;
      end if;
    end if;

    v_cursor := v_cursor - 1;
  end loop;

  update students
  set consecutive_absent_count = v_streak
  where id = v_student_id;

  return coalesce(new, old);
end;
$$;
