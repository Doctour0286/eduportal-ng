-- ============================================================================
-- migration_attendance_class_rules_and_obligations.sql
-- 1. Per-class attendance-deactivation rules (exempt a class, or give it its
--    own mode / threshold). A rule on a parent class node applies to every
--    class below it unless a more specific node has its own rule. No rule
--    anywhere up the tree = the school-wide setting applies.
-- 2. Fines / tasks assigned to a student (typically on reactivation), with a
--    pending -> fulfilled / waived lifecycle and the staff responsible at
--    each step.
--
-- Idempotent: safe to re-run.
-- ============================================================================

-- ── 1. Class rules ──────────────────────────────────────────────────────────

create table if not exists attendance_deactivation_class_rules (
  id                    uuid primary key default gen_random_uuid(),
  school_id             uuid not null references schools(id),
  class_node_id         uuid not null references class_nodes(id) on delete cascade,
  exempt                boolean not null default false,
  -- null = inherit the school-wide value for that field
  mode                  text check (mode in ('consecutive', 'cumulative')),
  consecutive_threshold int check (consecutive_threshold > 0),
  cumulative_threshold  int check (cumulative_threshold > 0),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (school_id, class_node_id)
);

alter table attendance_deactivation_class_rules enable row level security;

-- Read: admins + anyone who runs/inspects the check (students.records.manage).
drop policy if exists adcr_select on attendance_deactivation_class_rules;
create policy adcr_select on attendance_deactivation_class_rules
  for select using (
    school_id = current_school_id()
    and (current_is_admin() or current_has_permission('students.records.manage'))
  );

-- Write: admins only, same as the school-wide setting.
drop policy if exists adcr_write on attendance_deactivation_class_rules;
create policy adcr_write on attendance_deactivation_class_rules
  for all using (school_id = current_school_id() and current_is_admin())
  with check (school_id = current_school_id() and current_is_admin());

-- ── 2. Fines / tasks ────────────────────────────────────────────────────────

create table if not exists student_obligations (
  id              uuid primary key default gen_random_uuid(),
  school_id       uuid not null references schools(id),
  student_id      uuid not null references students(id) on delete cascade,
  kind            text not null check (kind in ('fine', 'task')),
  description     text not null,
  amount          numeric(12,2) check (amount >= 0),     -- fines only; recorded, not billed
  due_date        date,
  status          text not null default 'pending'
                    check (status in ('pending', 'fulfilled', 'waived')),
  created_by      uuid references staff(id),
  created_at      timestamptz not null default now(),
  resolved_by     uuid references staff(id),
  resolved_at     timestamptz,
  resolution_note text,
  check (kind = 'task' or amount is not null)
);

create index if not exists idx_so_student on student_obligations(student_id, created_at desc);
create index if not exists idx_so_pending on student_obligations(school_id) where status = 'pending';

alter table student_obligations enable row level security;

drop policy if exists so_select on student_obligations;
create policy so_select on student_obligations
  for select using (
    school_id = current_school_id()
    and (current_is_admin() or current_has_permission('students.records.manage'))
  );

drop policy if exists so_insert on student_obligations;
create policy so_insert on student_obligations
  for insert with check (
    school_id = current_school_id()
    and (current_is_admin() or current_has_permission('students.records.manage'))
  );

drop policy if exists so_update on student_obligations;
create policy so_update on student_obligations
  for update using (
    school_id = current_school_id()
    and (current_is_admin() or current_has_permission('students.records.manage'))
  )
  with check (school_id = current_school_id());

-- No DELETE policy — audit trail.
