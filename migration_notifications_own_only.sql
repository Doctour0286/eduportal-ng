-- ============================================================================
-- migration_notifications_own_only.sql
-- Pegs notifications to the account they were sent to. Until now the table
-- relied on school scoping alone, so a signed-in account could read (and
-- "mark all read") other accounts' notifications in the same school.
--
-- RESTRICTIVE policies are ANDed with whatever permissive policies already
-- exist, so inserts and every existing policy keep working; reads and updates
-- are additionally limited to rows addressed to the caller's own identity.
-- Idempotent: safe to re-run.
-- ============================================================================

drop policy if exists notifications_own_only_select on notifications;
create policy notifications_own_only_select on notifications
  as restrictive
  for select
  using (
    recipient_identity_id in (
      select id from app_identities where auth_user_id = auth.uid()
    )
  );

drop policy if exists notifications_own_only_update on notifications;
create policy notifications_own_only_update on notifications
  as restrictive
  for update
  using (
    recipient_identity_id in (
      select id from app_identities where auth_user_id = auth.uid()
    )
  );
