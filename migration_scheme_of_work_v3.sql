-- ============================================================================
-- migration_scheme_of_work_v3.sql
-- Schema changes for the two-kind template system:
--   1. curriculum_templates — add is_placeholder (board templates)
--   2. school_curriculum_templates — new table (school-owned templates)
--   3. school_curriculum_template_weeks — new table (week content)
-- ============================================================================

-- ── 1. Add is_placeholder to curriculum_templates ────────────────────────────

alter table curriculum_templates
  add column if not exists is_placeholder boolean not null default true;

-- All existing board templates are placeholder data
update curriculum_templates set is_placeholder = true where is_placeholder is false;

-- ── 2. school_curriculum_templates ──────────────────────────────────────────

create table if not exists school_curriculum_templates (
  id                uuid primary key default gen_random_uuid(),
  school_id         uuid not null references schools(id),
  name              text not null,
  subject_label     text,          -- optional plain-text label, NOT a FK
  class_level_label text,          -- optional plain-text label, NOT a FK
  created_by        uuid references auth.users(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table school_curriculum_templates is
  'School-owned reusable curriculum templates. Built by admin from scratch, '
  'not tied to any board/class/subject/term until adoption.';

-- updated_at trigger
drop trigger if exists set_updated_at_school_curriculum_templates on school_curriculum_templates;
create trigger set_updated_at_school_curriculum_templates
  before update on school_curriculum_templates
  for each row execute function set_updated_at();

-- Indexes
create index if not exists idx_school_tpl_school
  on school_curriculum_templates(school_id);

-- ── 3. school_curriculum_template_weeks ─────────────────────────────────────

create table if not exists school_curriculum_template_weeks (
  id                uuid primary key default gen_random_uuid(),
  template_id       uuid not null references school_curriculum_templates(id) on delete cascade,
  school_id         uuid not null references schools(id),
  week_number       integer not null,
  topic             text not null,
  objectives        text,
  activities        text,
  resources         text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique(template_id, week_number)
);

comment on table school_curriculum_template_weeks is
  'Weekly content for a school-owned curriculum template.';

-- updated_at trigger
drop trigger if exists set_updated_at_school_curriculum_template_weeks on school_curriculum_template_weeks;
create trigger set_updated_at_school_curriculum_template_weeks
  before update on school_curriculum_template_weeks
  for each row execute function set_updated_at();

-- Indexes
create index if not exists idx_school_tpl_weeks_template
  on school_curriculum_template_weeks(template_id);

-- ── 4. RLS — school_curriculum_templates ────────────────────────────────────

alter table school_curriculum_templates enable row level security;

-- SELECT: any school member can read their school's templates
drop policy if exists school_tpl_select on school_curriculum_templates;
create policy school_tpl_select on school_curriculum_templates
  for select using (
    school_id = current_school_id()
  );

-- INSERT: admin or manage permission
drop policy if exists school_tpl_insert on school_curriculum_templates;
create policy school_tpl_insert on school_curriculum_templates
  for insert with check (
    school_id = current_school_id()
    and (
      current_is_admin()
      or current_has_permission('academics.scheme_of_work.manage')
    )
  );

-- UPDATE: admin or manage permission
drop policy if exists school_tpl_update on school_curriculum_templates;
create policy school_tpl_update on school_curriculum_templates
  for update using (
    school_id = current_school_id()
    and (
      current_is_admin()
      or current_has_permission('academics.scheme_of_work.manage')
    )
  )
  with check (school_id = current_school_id());

-- DELETE: admin only (school templates are managed by admin)
drop policy if exists school_tpl_delete on school_curriculum_templates;
create policy school_tpl_delete on school_curriculum_templates
  for delete using (
    school_id = current_school_id()
    and current_is_admin()
  );

-- ── 5. RLS — school_curriculum_template_weeks ───────────────────────────────

alter table school_curriculum_template_weeks enable row level security;

-- SELECT: any school member can read their school's template weeks
drop policy if exists school_tpl_weeks_select on school_curriculum_template_weeks;
create policy school_tpl_weeks_select on school_curriculum_template_weeks
  for select using (
    school_id = current_school_id()
  );

-- INSERT: admin or manage permission
drop policy if exists school_tpl_weeks_insert on school_curriculum_template_weeks;
create policy school_tpl_weeks_insert on school_curriculum_template_weeks
  for insert with check (
    school_id = current_school_id()
    and (
      current_is_admin()
      or current_has_permission('academics.scheme_of_work.manage')
    )
  );

-- UPDATE: admin or manage permission
drop policy if exists school_tpl_weeks_update on school_curriculum_template_weeks;
create policy school_tpl_weeks_update on school_curriculum_template_weeks
  for update using (
    school_id = current_school_id()
    and (
      current_is_admin()
      or current_has_permission('academics.scheme_of_work.manage')
    )
  )
  with check (school_id = current_school_id());

-- DELETE: admin or manage permission (cascade handles weeks when template is deleted)
drop policy if exists school_tpl_weeks_delete on school_curriculum_template_weeks;
create policy school_tpl_weeks_delete on school_curriculum_template_weeks
  for delete using (
    school_id = current_school_id()
    and (
      current_is_admin()
      or current_has_permission('academics.scheme_of_work.manage')
    )
  );
