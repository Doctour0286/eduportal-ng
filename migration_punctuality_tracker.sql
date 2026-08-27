-- ============================================================================
-- migration_punctuality_tracker.sql
-- Feature 1: Teacher Punctuality Tracker — Proctor-recorded attendance model.
--
-- Tracks whether each teacher was present during their scheduled timetable
-- periods, recorded by an authorized staff member (proctor). Teachers must
-- never see this data — RLS excludes teacher-role identities entirely.
--
-- Tables:
--   1. teacher_punctuality_records — per-period, per-teacher presence records
--
-- Permission keys (3 new):
--   academics.punctuality.view    — read punctuality reports (admin/HR)
--   academics.punctuality.record  — mark teacher presence (proctors)
--   academics.punctuality.manage  — admin-only (assign proctors, override)
--
-- Idempotent: safe to re-run (drop-if-exists / on-conflict-do-nothing).
-- ============================================================================

-- ── 1. teacher_punctuality_records ─────────────────────────────────────────

create table if not exists teacher_punctuality_records (
  id                uuid primary key default gen_random_uuid(),
  school_id         uuid not null references schools(id),
  timetable_entry_id uuid not null references timetable_entries(id),
  staff_id          uuid not null references staff(id),  -- denormalized for fast date-range queries
  recorded_by       uuid not null references staff(id),  -- the proctor who marked this
  status            text not null check (status in ('present', 'absent')),
  record_date       date not null,                        -- denormalized: timetable_entries has day_of_week, not a date
  recording_source  text not null default 'period_override'
                      check (recording_source in ('day_shortcut', 'period_override')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique(school_id, timetable_entry_id)  -- one record per entry per school
);

comment on table teacher_punctuality_records is
  'Proctor-recorded teacher presence per timetable period. '
  'Teachers are excluded from SELECT via RLS — this data is admin/HR only.';

-- updated_at trigger
drop trigger if exists set_updated_at_teacher_punctuality_records on teacher_punctuality_records;
create trigger set_updated_at_teacher_punctuality_records
  before update on teacher_punctuality_records
  for each row execute function set_updated_at();

-- Indexes for date-range and per-teacher queries
create index if not exists idx_punctuality_school_date
  on teacher_punctuality_records(school_id, record_date);
create index if not exists idx_punctuality_staff_date
  on teacher_punctuality_records(school_id, staff_id, record_date);
create index if not exists idx_punctuality_recorded_by
  on teacher_punctuality_records(school_id, recorded_by);

-- ── RLS ────────────────────────────────────────────────────────────────────
-- Privacy model:
--   - Teachers have NO permission key for punctuality. No policy grants
--     them SELECT — RLS returns zero rows, even if they inspect network.
--   - Admins bypass via current_is_admin() (per codebase convention).
--   - Proctors with academics.punctuality.record can INSERT/UPDATE.
--   - No DELETE policy — audit trail, records are never deleted.

alter table teacher_punctuality_records enable row level security;

-- SELECT: admins + punctuality viewers only (teachers excluded)
drop policy if exists ptr_select on teacher_punctuality_records;
create policy ptr_select on teacher_punctuality_records
  for select using (
    school_id = current_school_id()
    and (
      current_is_admin()
      or current_has_permission('academics.punctuality.view')
    )
  );

-- INSERT: admins + proctors with record permission
drop policy if exists ptr_insert on teacher_punctuality_records;
create policy ptr_insert on teacher_punctuality_records
  for insert with check (
    school_id = current_school_id()
    and (
      current_is_admin()
      or current_has_permission('academics.punctuality.record')
    )
  );

-- UPDATE: admins + proctors with record permission
drop policy if exists ptr_update on teacher_punctuality_records;
create policy ptr_update on teacher_punctuality_records
  for update using (
    school_id = current_school_id()
    and (
      current_is_admin()
      or current_has_permission('academics.punctuality.record')
    )
  )
  with check (school_id = current_school_id());

-- No DELETE policy — audit trail preserved

-- ── Permission catalog additions ───────────────────────────────────────────

insert into permissions (key, module, description) values
  ('academics.punctuality.view',   'academics', 'View teacher punctuality reports and analytics'),
  ('academics.punctuality.record', 'academics', 'Record teacher presence/absence during timetable periods'),
  ('academics.punctuality.manage', 'academics', 'Manage punctuality settings, assign proctors, override records')
on conflict (key) do nothing;

-- ============================================================================
-- PRIVACY TEST (run after migration to confirm teacher exclusion):
--
-- Step 1: Identify a teacher-role identity:
--   SELECT ai.id, ai.actor_record_id, s.full_name, r.name as role_name
--   FROM app_identities ai
--   JOIN staff s ON s.id = ai.actor_record_id
--   JOIN staff_roles sr ON sr.staff_id = s.id
--   JOIN roles r ON r.id = sr.role_id
--   WHERE ai.actor_type = 'staff' AND r.is_admin_role = false
--   LIMIT 1;
--
-- Step 2: Impersonate that teacher and test SELECT:
--   SET LOCAL role TO authenticated;
--   SELECT set_config('request.jwt.claims',
--     json_build_object(
--       'sub', '<auth_user_id_from_step_1>',
--       'role', 'authenticated'
--     )::text, true);
--
--   SELECT count(*) FROM teacher_punctuality_records;
--   -- Must return 0 (RLS blocks all rows)
--
-- Step 3: Confirm admin CAN read:
--   -- (run as admin identity)
--   SELECT count(*) FROM teacher_punctuality_records;
--   -- Must return the full count (or 0 if table is empty)
-- ============================================================================
