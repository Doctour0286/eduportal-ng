-- ============================================================================
-- migration_reactivation_counter_reset_trigger.sql
-- Guarantee: whenever a student becomes active again — from ANY code path
-- (Students screen, Attendance screen, future code, a manual SQL edit) —
-- their attendance counters reset to zero and old absences stop counting.
--
-- The app already does this in updateStudentStatus(); this makes the database
-- enforce it too, so no path can reactivate a student and leave stale counts
-- that would suspend them again at the next attendance write.
--
-- Counting restarts the day AFTER reactivation. If the app already supplied a
-- (local-time) start date, the later of that and the database's tomorrow is
-- kept, so the baseline can never move earlier than the app set it.
--
-- Idempotent: safe to re-run.
-- ============================================================================

create or replace function reset_attendance_counts_on_reactivation()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'active' and old.status is distinct from 'active' then
    new.consecutive_absent_count := 0;
    new.cumulative_absent_count  := 0;
    new.last_absent_date         := null;
    new.deactivation_reason      := null;
    new.attendance_count_start   := greatest(
      coalesce(new.attendance_count_start, current_date + 1),
      current_date + 1
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_reset_attendance_counts_on_reactivation on students;
create trigger trg_reset_attendance_counts_on_reactivation
  before update of status on students
  for each row execute function reset_attendance_counts_on_reactivation();
