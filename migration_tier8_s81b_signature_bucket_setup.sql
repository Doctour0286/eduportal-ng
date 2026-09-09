-- ============================================================================
-- migration_tier8_s81b_signature_bucket_setup.sql
-- PRD Tier 8 / Problem 8.4 (Session 81) — Storage bucket for class form
-- master signatures, uploaded via assessmentService.ts's
-- uploadFormMasterSignature()/getFormMasterSignatureSignedUrl().
--
-- Mirrors the student-photos bucket's proven pattern as closely as this
-- session can reconstruct it (that file, student_photos_bucket_setup.sql,
-- is not present in this repo to copy directly — confirmed by search before
-- writing this from scratch): private bucket, path shape
-- <school_id>/<class_node_id>/<filename>, RLS enforced directly against
-- storage.objects using the real current_has_permission()/current_is_admin()
-- helper functions already confirmed live in this schema (see
-- MASTER_PLAN.md §3.2's own note that these are the only SQL-side
-- permission-check helpers that exist — current_school_id(),
-- current_actor_type(), current_is_admin(), is_platform_admin(), plus
-- current_has_permission(perm_key) added specifically for this kind of
-- Storage policy in an earlier session).
--
-- IMPORTANT — path-parsing caveat specific to this bucket, different from
-- student-photos: storage.objects.name for an object uploaded to
-- "<school_id>/<class_node_id>/signature.jpg" is the full path string; the
-- school_id segment is extracted via split_part(name, '/', 1) and the
-- class_node_id segment via split_part(name, '/', 2), then compared against
-- the caller's real school scope and the specific class they're allowed to
-- act on. A class-scoped form master (staff_permission_class_scope grant,
-- not admin) may therefore upload a signature ONLY for their own assigned
-- class's path segment.
--
-- Run order: after migration_tier8_s81_report_card_overhaul.sql (needs
-- class_form_masters + staff_permission_class_scope to exist for the
-- policies below to reference). Idempotent: safe to re-run.
-- ============================================================================

insert into storage.buckets (id, name, public)
values ('class-form-master-signatures', 'class-form-master-signatures', false)
on conflict (id) do nothing;

-- SELECT: any authenticated school member of the SAME school as the path's
-- first segment may read a signature — needed so the report-card PDF
-- generator (any staff member downloading a card) and the guardian/student
-- portal (showing the form master's signature, if ever surfaced there) can
-- both resolve a signed URL, not just admins.
drop policy if exists cfm_sig_select on storage.objects;
create policy cfm_sig_select on storage.objects
  for select using (
    bucket_id = 'class-form-master-signatures'
    and split_part(name, '/', 1) = current_school_id()::text
  );

-- INSERT/UPDATE: admin, OR a staff member holding academics.remarks.manage
-- scoped (via staff_permission_class_scope) to the exact class_node_id in
-- the path's second segment, OR holding it unscoped school-wide.
-- current_has_permission() alone (school-wide only, per its own
-- documented resolution order) would incorrectly ALSO grant a form master
-- scoped to a DIFFERENT class the ability to overwrite this class's
-- signature — the explicit staff_permission_class_scope EXISTS check below
-- is what makes this genuinely class-scoped, not current_has_permission()
-- on its own.
drop policy if exists cfm_sig_insert on storage.objects;
create policy cfm_sig_insert on storage.objects
  for insert with check (
    bucket_id = 'class-form-master-signatures'
    and split_part(name, '/', 1) = current_school_id()::text
    and (
      current_is_admin()
      or exists (
        select 1 from staff_permission_class_scope spcs
        where spcs.school_id = current_school_id()
          and spcs.permission_key = 'academics.remarks.manage'
          and spcs.class_id::text = split_part(name, '/', 2)
          and spcs.staff_id = (select actor_record_id from app_identities where auth_user_id = auth.uid() and actor_type = 'staff')
      )
      or current_has_permission('academics.remarks.manage')
    )
  );

drop policy if exists cfm_sig_update on storage.objects;
create policy cfm_sig_update on storage.objects
  for update using (
    bucket_id = 'class-form-master-signatures'
    and split_part(name, '/', 1) = current_school_id()::text
    and (
      current_is_admin()
      or exists (
        select 1 from staff_permission_class_scope spcs
        where spcs.school_id = current_school_id()
          and spcs.permission_key = 'academics.remarks.manage'
          and spcs.class_id::text = split_part(name, '/', 2)
          and spcs.staff_id = (select actor_record_id from app_identities where auth_user_id = auth.uid() and actor_type = 'staff')
      )
      or current_has_permission('academics.remarks.manage')
    )
  );

-- DELETE: admin only — a form master can replace their signature (upsert,
-- handled as an update-in-place by the app's upload call, upsert: true) but
-- should not need standalone delete capability; keeping this admin-only is
-- the more conservative default and can be loosened later if a real need
-- for self-service delete surfaces.
drop policy if exists cfm_sig_delete on storage.objects;
create policy cfm_sig_delete on storage.objects
  for delete using (
    bucket_id = 'class-form-master-signatures'
    and split_part(name, '/', 1) = current_school_id()::text
    and current_is_admin()
  );
