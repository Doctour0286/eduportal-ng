-- ============================================================================
-- migration_student_status_history.sql
-- Records every inactivation / reactivation of a student: when, why, the
-- attendance counts at that moment, the note, and the staff member who
-- triggered it. Powers the per-class "Suspended students" list on the
-- Attendance page (days inactive, sort by most recently suspended, history).
--
-- Written by a trigger on students.status so EVERY path is captured
-- (automatic rule, Students screen, Attendance screen) with no client code
-- able to forget it. Staff identity is resolved the codebase's proven way:
-- app_identities (auth_user_id = auth.uid(), actor_type = 'staff').
-- The automatic rule fires from the signed-in staff member's browser, so
-- changed_by is whoever's session ran the check, not a system user.
--
-- Idempotent: safe to re-run.
-- ============================================================================

create table if not exists student_status_history (
  id                 uuid primary key default gen_random_uuid(),
  school_id          uuid not null references schools(id),
  student_id         uuid not null references students(id) on delete cascade,
  event              text not null check (event in ('inactivated', 'reactivated')),
  reason             text not null check (reason in ('attendance_auto', 'manual')),
  note               text,
  consecutive_count  int,
  cumulative_count   int,
  last_absent_date   date,
  changed_by         uuid references staff(id),
  approximate        boolean not null default false,  -- true for backfilled rows (exact time unknown)
  created_at         timestamptz not null default now()
);

create index if not exists idx_ssh_student on student_status_history(student_id, created_at desc);
create index if not exists idx_ssh_school  on student_status_history(school_id, created_at desc);

alter table student_status_history enable row level security;

drop policy if exists ssh_select on student_status_history;
create policy ssh_select on student_status_history
  for select using (
    school_id = current_school_id()
    and (current_is_admin() or current_has_permission('students.records.manage'))
  );
-- No insert/update/delete policies: rows are written only by the trigger
-- below (security definer) and are never edited — audit trail.

create or replace function log_student_status_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid;
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  select actor_record_id into v_actor
  from app_identities
  where auth_user_id = auth.uid() and actor_type = 'staff'
  limit 1;

  if new.status = 'inactive' then
    insert into student_status_history
      (school_id, student_id, event, reason, note,
       consecutive_count, cumulative_count, last_absent_date, changed_by)
    values
      (new.school_id, new.id, 'inactivated',
       case when new.deactivation_reason = 'attendance_auto' then 'attendance_auto' else 'manual' end,
       case when new.deactivation_reason = 'attendance_auto' then null else new.status_change_note end,
       new.consecutive_absent_count, new.cumulative_absent_count, new.last_absent_date, v_actor);
  elsif old.status = 'inactive' and new.status = 'active' then
    insert into student_status_history
      (school_id, student_id, event, reason, note,
       consecutive_count, cumulative_count, last_absent_date, changed_by)
    values
      (new.school_id, new.id, 'reactivated', 'manual', new.status_change_note,
       old.consecutive_absent_count, old.cumulative_absent_count, old.last_absent_date, v_actor);
  end if;

  return new;
end;
$$;

drop trigger if exists trg_log_student_status_change on students;
create trigger trg_log_student_status_change
  after update of status on students
  for each row execute function log_student_status_change();

-- Backfill: students already suspended by the attendance rule have no
-- history yet. Approximate the suspension time from their last absence so
-- they sort and show days-inactive sensibly; flagged approximate = true.
insert into student_status_history
  (school_id, student_id, event, reason, consecutive_count, cumulative_count,
   last_absent_date, created_at, approximate)
select s.school_id, s.id, 'inactivated', 'attendance_auto',
       s.consecutive_absent_count, s.cumulative_absent_count, s.last_absent_date,
       coalesce(s.last_absent_date::timestamp + interval '12 hours', now()), true
from students s
where s.status = 'inactive'
  and s.deactivation_reason = 'attendance_auto'
  and not exists (select 1 from student_status_history h where h.student_id = s.id);
