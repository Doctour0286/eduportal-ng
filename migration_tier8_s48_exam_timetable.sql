-- ============================================================================
-- migration_tier8_s48_exam_timetable.sql
-- PRD Tier 8 / Problem 8.4 (Session 48) — exam timetable, venues, invigilators.
--
-- Run order: SECOND of the four Tier 8 migrations (after s46).
-- Idempotent: safe to re-run.
--
-- Design notes:
--   * venues is genuinely new to the platform (Problem 8.4 flagged this).
--   * exam_timetable_entries surfaces READ-ONLY inside TimetableModuleSecondary
--     for dates in the displayed week; authoring lives in Settings > Assessments
--     with client-side clash checks at save time (class double-booked, staff
--     double-invigilated, venue over-capacity) per Problem 8.4's "checked at
--     save rather than as hard schema constraints for v1".
--   * exam_invigilators carries no school_id of its own — scoping flows through
--     the entry → window → school chain, same convention as other child tables.
-- ============================================================================

-- ── venues ──────────────────────────────────────────────────────────────────

create table if not exists venues (
  id         uuid primary key default gen_random_uuid(),
  school_id  uuid not null references schools(id),
  name       text not null,
  capacity   int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (school_id, name)
);

drop trigger if exists set_updated_at_venues on venues;
create trigger set_updated_at_venues before update on venues
  for each row execute function set_updated_at();

drop policy if exists ven_select on venues;
create policy ven_select on venues
  for select using (school_id = current_school_id());

drop policy if exists ven_insert on venues;
create policy ven_insert on venues
  for insert with check (
    school_id = current_school_id()
    and (current_is_admin() or current_has_permission('academics.exam_timetable.manage'))
  );

drop policy if exists ven_update on venues;
create policy ven_update on venues
  for update using (
    school_id = current_school_id()
    and (current_is_admin() or current_has_permission('academics.exam_timetable.manage'))
  )
  with check (school_id = current_school_id());

drop policy if exists ven_delete on venues;
create policy ven_delete on venues
  for delete using (
    school_id = current_school_id()
    and (current_is_admin() or current_has_permission('academics.exam_timetable.manage'))
  );

-- ── exam_timetable_entries ──────────────────────────────────────────────────

create table if not exists exam_timetable_entries (
  id                   uuid primary key default gen_random_uuid(),
  assessment_window_id uuid not null references assessment_windows(id) on delete cascade,
  class_node_id        uuid not null references class_nodes(id),
  subject_id           uuid not null references subjects(id),
  exam_date            date not null,
  start_time           time not null,
  end_time             time not null,
  check (end_time > start_time),
  venue_id             uuid references venues(id),
  created_by           uuid references auth.users(id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists exam_entries_window_idx on exam_timetable_entries (assessment_window_id);
create index if not exists exam_entries_date_idx on exam_timetable_entries (exam_date);

drop trigger if exists set_updated_at_exam_timetable_entries on exam_timetable_entries;
create trigger set_updated_at_exam_timetable_entries before update on exam_timetable_entries
  for each row execute function set_updated_at();

drop policy if exists ete_select on exam_timetable_entries;
create policy ete_select on exam_timetable_entries
  for select using (
    exists (
      select 1 from assessment_windows w
      where w.id = assessment_window_id
        and w.school_id = current_school_id()
    )
  );

drop policy if exists ete_write on exam_timetable_entries;
create policy ete_write on exam_timetable_entries
  for all using (
    exists (
      select 1 from assessment_windows w
      where w.id = assessment_window_id
        and w.school_id = current_school_id()
        and (current_is_admin() or current_has_permission('academics.exam_timetable.manage'))
    )
  )
  with check (
    exists (
      select 1 from assessment_windows w
      where w.id = assessment_window_id
        and w.school_id = current_school_id()
        and (current_is_admin() or current_has_permission('academics.exam_timetable.manage'))
    )
  );

-- ── exam_invigilators ───────────────────────────────────────────────────────

create table if not exists exam_invigilators (
  id                      uuid primary key default gen_random_uuid(),
  exam_timetable_entry_id uuid not null references exam_timetable_entries(id) on delete cascade,
  staff_id                uuid not null references staff(id),
  role                    text not null default 'assistant'
                          check (role in ('lead','assistant')),
  created_at              timestamptz not null default now(),
  unique (exam_timetable_entry_id, staff_id)
);

drop policy if exists ei_select on exam_invigilators;
create policy ei_select on exam_invigilators
  for select using (
    exists (
      select 1
      from exam_timetable_entries e
      join assessment_windows w on w.id = e.assessment_window_id
      where e.id = exam_timetable_entry_id
        and w.school_id = current_school_id()
    )
  );

drop policy if exists ei_write on exam_invigilators;
create policy ei_write on exam_invigilators
  for all using (
    exists (
      select 1
      from exam_timetable_entries e
      join assessment_windows w on w.id = e.assessment_window_id
      where e.id = exam_timetable_entry_id
        and w.school_id = current_school_id()
        and (current_is_admin() or current_has_permission('academics.exam_timetable.manage'))
    )
  )
  with check (
    exists (
      select 1
      from exam_timetable_entries e
      join assessment_windows w on w.id = e.assessment_window_id
      where e.id = exam_timetable_entry_id
        and w.school_id = current_school_id()
        and (current_is_admin() or current_has_permission('academics.exam_timetable.manage'))
    )
  );
