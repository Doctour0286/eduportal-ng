-- ============================================================================
-- migration_fee_mass_actions.sql
-- Supports editing fee assignments and mass actions (edit amount, waive,
-- exempt, unassign) with an audit trail and undo.
--
--  * fee_assignments.voided_at   — "unassign" is a soft void: the row stays
--      (history, payments keep pointing at it) but every reader ignores it.
--  * fee_discounts.voided_at / action_id — undoing a waiver voids the rows.
--  * fee_exemptions              — a student who should never have been billed
--      for an assignment. Different from a full waiver: nothing is billed, so
--      nothing shows as "waived". Honoured by the balance calculation.
--  * fee_action_log              — one row per mass action: who, when, why,
--      scope, and the data needed to undo it.
--
-- Overpayments need no new column: when waiving/exempting leaves a student
-- having paid more than they now owe, the balance calculation reports the
-- difference as a credit.
--
-- Permissions follow the existing finance keys: fees.manage for amount
-- edits / unassign / exempt, discounts.apply for waivers.
-- Idempotent: safe to re-run.
-- ============================================================================

alter table fee_assignments add column if not exists voided_at timestamptz;
alter table fee_assignments add column if not exists voided_by uuid references staff(id);
alter table fee_assignments add column if not exists updated_at timestamptz;

alter table fee_discounts add column if not exists voided_at timestamptz;
alter table fee_discounts add column if not exists action_id uuid;

create table if not exists fee_action_log (
  id                   uuid primary key default gen_random_uuid(),
  school_id            uuid not null references schools(id),
  action               text not null check (action in ('edit_amount', 'waive', 'exempt', 'unassign')),
  scope                jsonb not null default '{}'::jsonb,   -- { type: 'student'|'class'|'school', ... }
  assignments_count    int not null default 0,
  students_count       int not null default 0,
  total_amount         numeric(14,2),                        -- naira affected (waived/exempted/removed/delta)
  reason               text not null,
  details              jsonb not null default '{}'::jsonb,   -- data needed to undo
  performed_by         uuid references staff(id),
  performed_at         timestamptz not null default now(),
  undone_at            timestamptz,
  undone_by            uuid references staff(id)
);
create index if not exists idx_fal_school on fee_action_log(school_id, performed_at desc);

create table if not exists fee_exemptions (
  id                 uuid primary key default gen_random_uuid(),
  school_id          uuid not null references schools(id),
  fee_assignment_id  uuid not null references fee_assignments(id),
  student_id         uuid not null references students(id) on delete cascade,
  reason             text,
  action_id          uuid references fee_action_log(id),
  created_by         uuid references staff(id),
  created_at         timestamptz not null default now(),
  voided_at          timestamptz
);
create unique index if not exists uq_fee_exemptions_active
  on fee_exemptions(fee_assignment_id, student_id) where voided_at is null;
create index if not exists idx_fee_exemptions_student on fee_exemptions(student_id);

alter table fee_action_log enable row level security;
alter table fee_exemptions enable row level security;

-- Who may read finance structure (fees view or manage, or admin).
drop policy if exists fal_select on fee_action_log;
create policy fal_select on fee_action_log for select using (
  school_id = current_school_id()
  and (current_is_admin() or current_has_permission('finance.fees.view') or current_has_permission('finance.fees.manage'))
);
drop policy if exists fal_insert on fee_action_log;
create policy fal_insert on fee_action_log for insert with check (
  school_id = current_school_id()
  and (current_is_admin() or current_has_permission('finance.fees.manage') or current_has_permission('finance.discounts.apply'))
);
drop policy if exists fal_update on fee_action_log;
create policy fal_update on fee_action_log for update using (
  school_id = current_school_id()
  and (current_is_admin() or current_has_permission('finance.fees.manage') or current_has_permission('finance.discounts.apply'))
);

drop policy if exists fex_select on fee_exemptions;
create policy fex_select on fee_exemptions for select using (
  school_id = current_school_id()
  and (current_is_admin() or current_has_permission('finance.fees.view') or current_has_permission('finance.fees.manage')
       or current_has_permission('finance.payments.view_all'))
);
drop policy if exists fex_write on fee_exemptions;
create policy fex_write on fee_exemptions for all using (
  school_id = current_school_id()
  and (current_is_admin() or current_has_permission('finance.fees.manage'))
) with check (
  school_id = current_school_id()
  and (current_is_admin() or current_has_permission('finance.fees.manage'))
);

-- Editing / voiding assignments and voiding discounts (permissive additions;
-- existing policies keep working).
drop policy if exists fa_mass_update on fee_assignments;
create policy fa_mass_update on fee_assignments for update using (
  school_id = current_school_id()
  and (current_is_admin() or current_has_permission('finance.fees.manage'))
) with check (school_id = current_school_id());

drop policy if exists fd_mass_update on fee_discounts;
create policy fd_mass_update on fee_discounts for update using (
  school_id = current_school_id()
  and (current_is_admin() or current_has_permission('finance.discounts.apply') or current_has_permission('finance.fees.manage'))
) with check (school_id = current_school_id());
