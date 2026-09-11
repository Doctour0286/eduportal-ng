-- ============================================================================
-- migration_tier8_s84_remarks_class_scope_fix.sql
-- PRD Tier 8 / Problem 8.4 (Session 84) — closes a real permission-scoping
-- gap found while wiring the guardian portal's form-master card.
--
-- THE GAP: assessment_window_student_remarks' write policy (awsr_write,
-- from migration_tier8_s49_remarks_bands.sql) gates on
-- `current_is_admin() or current_has_permission('academics.remarks.manage')`
-- — and current_has_permission(perm_key text) takes ONLY the permission
-- key, no row/class parameter. It cannot know which class a given WRITE
-- targets, so it cannot distinguish "holds this key for class A" from
-- "holds this key for class B" — a staff member scoped (via
-- staff_permission_class_scope) to ONE class's remarks could write remarks
-- for ANY class's students, at the database level, not just through the
-- app's UI. This predates today's work (staff_permission_class_scope was
-- confirmed empty until the Session 81 form-master feature started using
-- it for real) and is a genuine, live gap now that real scoped grants
-- exist. The owner confirmed the database is reachable outside the app UI
-- (the Supabase anon key is necessarily public in any client-side bundle;
-- RLS is the real enforcement boundary, not UI gating) — so this is fixed
-- at the database layer, not just the app.
--
-- THE FIX: awsr_write now ALSO allows a write when the target row's
-- student belongs to a class the current staff member holds a
-- staff_permission_class_scope grant for (key = 'academics.remarks.manage'),
-- checked directly against the student's real class_node_id — not
-- delegated to current_has_permission(), whose exact internal handling of
-- scoped-only grants isn't known from this codebase's own history (see
-- this file's own research before writing this: the function's signature
-- takes no class parameter, but its internal resolution order isn't
-- independently confirmed) — this policy is self-sufficient and correct
-- regardless of that function's internals, by checking the scope table
-- directly.
--
-- current_has_permission('academics.remarks.manage') is KEPT (not
-- removed) for the unscoped/school-wide case — a staff member who holds
-- the key with no scope restriction at all (the pre-Session-81 default
-- shape, e.g. an academic-affairs officer who isn't a form master but
-- manages remarks school-wide) must keep working exactly as before.
--
-- Run order: after migration_tier8_s81_report_card_overhaul.sql (needs
-- staff_permission_class_scope, class_form_masters' own permission model,
-- to exist). Idempotent: safe to re-run.
-- ============================================================================

drop policy if exists awsr_write on assessment_window_student_remarks;
create policy awsr_write on assessment_window_student_remarks
  for all using (
    school_id = current_school_id()
    and (
      current_is_admin()
      or current_has_permission('academics.remarks.manage')
      or exists (
        select 1
        from students s
        join staff_permission_class_scope spcs
          on spcs.class_id = s.class_node_id
        where s.id = assessment_window_student_remarks.student_id
          and spcs.school_id = current_school_id()
          and spcs.permission_key = 'academics.remarks.manage'
          and spcs.staff_id = (select actor_record_id from app_identities where auth_user_id = auth.uid() and actor_type = 'staff')
      )
    )
  )
  with check (
    school_id = current_school_id()
    and (
      current_is_admin()
      or current_has_permission('academics.remarks.manage')
      or exists (
        select 1
        from students s
        join staff_permission_class_scope spcs
          on spcs.class_id = s.class_node_id
        where s.id = assessment_window_student_remarks.student_id
          and spcs.school_id = current_school_id()
          and spcs.permission_key = 'academics.remarks.manage'
          and spcs.staff_id = (select actor_record_id from app_identities where auth_user_id = auth.uid() and actor_type = 'staff')
      )
    )
  );
