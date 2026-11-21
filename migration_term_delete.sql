-- ============================================================================
-- migration_term_delete.sql
-- Lets an administrator delete a term / semester that nothing uses.
-- Until now there was no delete anywhere: the screen could only add or edit.
--
-- Safety: the app checks what depends on the term first and refuses if
-- anything does; the foreign keys on fee assignments, offerings, scores etc.
-- are the final guard, so a term in use can never be removed from under data.
-- Idempotent: safe to re-run.
-- ============================================================================
drop policy if exists terms_admin_delete on terms;
create policy terms_admin_delete on terms
  for delete using (school_id = current_school_id() and current_is_admin());
