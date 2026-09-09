-- ============================================================================
-- migration_tier8_s81_report_card_overhaul.sql
-- PRD Tier 8 / Problem 8.4 (Session 81) — owner-requested report card
-- overhaul: class/term-scoped report cards (no subject selector), school
-- logo + student passport photo on the printed card, admin-configurable
-- per-class-per-term print fields (resumption date, next term fees, notice),
-- form master / class coordinator assignment with contact details + upload
-- signature, and a principal/head remark field (mirrors the existing
-- class-teacher remark, which lives in assessment_window_student_remarks —
-- see migration_tier8_s49_remarks_bands.sql D4a/D4b. That migration's own
-- comment explicitly flagged "no form-teacher concept exists yet... future
-- scope" — this migration is that future scope arriving.
--
-- Run order: after s49 (aggregate_remark_bands, assessment_window_student_
-- remarks) and s50 (promotion). Idempotent: safe to re-run.
--
-- Decisions locked before writing this (owner, this session):
--   - Form master permission: NOT a new permission key. Reuses the existing
--     academics.remarks.manage key via the already-built, already-wired
--     staff_permission_class_scope table + canForClass() resolution
--     (permissionsService.ts) — confirmed real and already correctly
--     implementing "grant key X, scoped to class Y" before this migration
--     was written. Assigning a form master INSERTS a scoped grant row here;
--     it does not require a new permission concept.
--   - Bulk remarks (class-teacher AND principal, independently): NOT a rules
--     table. A one-time bulk-apply action (whole class / whole school /
--     average-range) writing the same text into every matching student's
--     row. No new schema for this — implemented entirely in the service
--     layer against the remark tables below.
--   - report_card_settings: keyed directly on
--     (class_node_id, session_id, term_id), not through an assessment
--     window — this is standing per-term configuration (resumption date,
--     fees, notice), not an assessment-cycle fact, and the owner's own
--     answer was "per class per term, but reusable" (a copy-from-last-term
--     action reads the most recent prior row for the same class client-side
--     — no separate template table needed for that).
--   - Signature storage: mirrors student_photos_bucket_setup.sql's proven
--     pattern exactly (private bucket, <school_id>/<class_node_id>/
--     signature.jpg path, store the path not a URL, resolve via
--     createSignedUrl() at display/PDF time) — see class_form_masters.
--   - Staff self-identity in RLS resolved via the proven existing pattern
--     (select actor_record_id from app_identities where auth_user_id =
--     auth.uid() and actor_type = 'staff') — confirmed real via
--     migration_scheme_of_work.sql before use here, NOT a fabricated
--     current_staff_id() helper (no such function exists in this schema).
-- ============================================================================

-- ── report_card_settings ─────────────────────────────────────────────────────
-- Admin-configurable extra fields that print on the report card for a given
-- class + term. All nullable — a school can set some fields and leave
-- others blank; blank fields simply don't render on the PDF.

create table if not exists report_card_settings (
  id                 uuid primary key default gen_random_uuid(),
  school_id          uuid not null references schools(id),
  class_node_id      uuid not null references class_nodes(id),
  session_id         uuid not null references sessions(id),
  term_id            uuid references terms(id),  -- null = whole session (uses_terms=false, same duality as assessment_windows.term_id)
  resumption_date    date,
  next_term_fees     numeric(12,2),
  notice             text,
  created_by         uuid references staff(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (class_node_id, session_id, term_id)
);

drop trigger if exists set_updated_at_report_card_settings on report_card_settings;
create trigger set_updated_at_report_card_settings before update on report_card_settings
  for each row execute function set_updated_at();

drop policy if exists rcs_select on report_card_settings;
create policy rcs_select on report_card_settings
  for select using (school_id = current_school_id());

-- Write: admin, or a form master scoped to this exact class (reuses the
-- same academics.remarks.manage key a form master already gets scoped
-- access to — see class_form_masters below — rather than inventing a
-- second permission key for what is conceptually the same "I run this
-- class's report cards" authority).
drop policy if exists rcs_write on report_card_settings;
create policy rcs_write on report_card_settings
  for all using (
    school_id = current_school_id()
    and (
      current_is_admin()
      or exists (
        select 1 from staff_permission_class_scope spcs
        where spcs.school_id = report_card_settings.school_id
          and spcs.permission_key = 'academics.remarks.manage'
          and spcs.class_id = report_card_settings.class_node_id
          and spcs.staff_id = (select actor_record_id from app_identities where auth_user_id = auth.uid() and actor_type = 'staff')
      )
      or current_has_permission('academics.remarks.manage')
    )
  )
  with check (
    school_id = current_school_id()
    and (
      current_is_admin()
      or exists (
        select 1 from staff_permission_class_scope spcs
        where spcs.school_id = report_card_settings.school_id
          and spcs.permission_key = 'academics.remarks.manage'
          and spcs.class_id = report_card_settings.class_node_id
          and spcs.staff_id = (select actor_record_id from app_identities where auth_user_id = auth.uid() and actor_type = 'staff')
      )
      or current_has_permission('academics.remarks.manage')
    )
  );

-- ── class_form_masters ───────────────────────────────────────────────────────
-- Assigns one staff member as form master / class coordinator / level
-- coordinator for a class. Owns the profile facts a form master needs for
-- parent correspondence and report-card signing — NOT the permission grant
-- itself (that's a staff_permission_class_scope row, inserted alongside this
-- one by the service layer, not duplicated as columns here).
--
-- One row per (school_id, class_node_id) — a class has exactly one current
-- form master at a time. Re-assigning updates this row (and the app is
-- responsible for removing the old staff member's scoped permission grant
-- and inserting the new one in the same transaction-equivalent call).

create table if not exists class_form_masters (
  id                 uuid primary key default gen_random_uuid(),
  school_id          uuid not null references schools(id),
  class_node_id      uuid not null references class_nodes(id),
  staff_id           uuid not null references staff(id),
  contact_phone      text,     -- may differ from staff.phone — a teacher may want a separate number for parent contact
  contact_email      text,     -- may differ from staff.email, same reasoning
  notes_for_parents  text,     -- free text shown on the guardian/student portal
  signature_url      text,     -- Storage PATH (not a URL — see file header), <school_id>/<class_node_id>/signature.jpg in the class-form-master-signatures bucket
  assigned_at        timestamptz not null default now(),
  assigned_by        uuid references staff(id),
  updated_at         timestamptz not null default now(),
  unique (class_node_id)
);

drop trigger if exists set_updated_at_class_form_masters on class_form_masters;
create trigger set_updated_at_class_form_masters before update on class_form_masters
  for each row execute function set_updated_at();

-- Select: school-wide readable — the guardian/student portal needs to show
-- the form master's contact details and notes to parents, and RLS for
-- portal identities already resolves school scope the same way staff does
-- (per the existing [STD] convention this table follows).
drop policy if exists cfm_select on class_form_masters;
create policy cfm_select on class_form_masters
  for select using (school_id = current_school_id());

-- Write: admin only. Assigning/reassigning a form master also changes who
-- holds a scoped permission grant, which is an admin-level action even
-- though the form master's own subsequent remark/signature edits (below)
-- are not.
drop policy if exists cfm_write on class_form_masters;
create policy cfm_write on class_form_masters
  for all using (
    school_id = current_school_id() and current_is_admin()
  )
  with check (
    school_id = current_school_id() and current_is_admin()
  );

-- The assigned form master themselves may update ONLY their own contact
-- info, notes, and signature — not reassign the class to someone else
-- (staff_id stays admin-only via cfm_write above; this policy is additive
-- for the same rows, and Postgres RLS unions permissive policies, so a form
-- master can UPDATE within this narrower policy even without
-- current_is_admin()).
drop policy if exists cfm_self_update on class_form_masters;
create policy cfm_self_update on class_form_masters
  for update using (
    school_id = current_school_id()
    and staff_id = (select actor_record_id from app_identities where auth_user_id = auth.uid() and actor_type = 'staff')
  )
  with check (
    school_id = current_school_id()
    and staff_id = (select actor_record_id from app_identities where auth_user_id = auth.uid() and actor_type = 'staff')
  );

-- ── assessment_window_student_remarks: add principal/head remark ───────────
-- Mirrors the existing `remark` column (class-teacher's remark) exactly —
-- same table, same (window, student) row, so the two remarks for a given
-- student in a given period are always read/written together and can never
-- drift into two different rows. Nullable/defaulted empty like its sibling.

alter table assessment_window_student_remarks
  add column if not exists principal_remark text not null default '';

alter table assessment_window_student_remarks
  add column if not exists principal_remark_entered_by uuid references staff(id);

-- Existing awsr_write policy already gates ALL writes to this table on
-- academics.remarks.manage (or admin) — deliberately not narrowed further
-- for principal_remark specifically. A school that wants only its head
-- teacher writing principal remarks enforces that via who it grants
-- academics.remarks.manage to (school-wide or class-scoped), same as it
-- already does for the class-teacher remark; adding a second permission key
-- here would let the two remarks silently drift onto different staff sets
-- with no real benefit, since both remarks read from and write to the exact
-- same row.
