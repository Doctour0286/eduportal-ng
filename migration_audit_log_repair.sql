-- ============================================================================
-- migration_audit_log_repair.sql
-- Makes the audit log dependable (master plan §7.24).
--
-- What this fixes:
--  * The viewer read a column called created_at while the documented table
--    uses occurred_at; whichever one is missing is now added as an alias, so
--    either name works.
--  * audit_row_change() assumed every audited table has an id and a
--    school_id column, and would FAIL the write on one that doesn't
--    (role_permissions, staff_roles ...). It now reads those from the row's
--    JSON, and an auditing problem can never block the real change.
--  * It runs as SECURITY DEFINER so logging works for every role.
--  * Triggers are (re)attached to the documented tables, plus the tables added
--    for fee actions, queries/fines and the ledger. A table that already has
--    an audit trigger is left alone, so nothing is logged twice.
--  * Rows can never be updated or deleted (no policies, privileges revoked).
--
-- Idempotent: safe to re-run.
-- ============================================================================

create table if not exists audit_log (
  id          uuid primary key default gen_random_uuid(),
  school_id   uuid,
  actor_id    uuid,
  actor_type  text,
  table_name  text not null,
  record_id   uuid not null,
  action      text not null check (action in ('INSERT','UPDATE','DELETE')),
  old_data    jsonb,
  new_data    jsonb,
  occurred_at timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'audit_log' and column_name = 'occurred_at')
     and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'audit_log' and column_name = 'created_at') then
    alter table audit_log add column occurred_at timestamptz generated always as (created_at) stored;
  elsif not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'audit_log' and column_name = 'created_at') then
    alter table audit_log add column created_at timestamptz generated always as (occurred_at) stored;
  end if;
end $$;

create index if not exists idx_audit_school_time on audit_log(school_id, occurred_at desc);
create index if not exists idx_audit_table on audit_log(school_id, table_name);

create or replace function audit_row_change()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  j_new jsonb := case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end;
  j_old jsonb := case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end;
  j jsonb := coalesce(j_new, j_old);
  v_school uuid; v_record uuid; v_actor_type text;
begin
  begin v_school := nullif(j->>'school_id', '')::uuid; exception when others then v_school := null; end;
  begin v_record := nullif(j->>'id', '')::uuid;        exception when others then v_record := null; end;
  begin v_actor_type := current_actor_type();           exception when others then v_actor_type := null; end;
  begin
    insert into audit_log (school_id, actor_id, actor_type, table_name, record_id, action, old_data, new_data)
    values (v_school, auth.uid(), v_actor_type, tg_table_name, coalesce(v_record, gen_random_uuid()), tg_op, j_old, j_new);
  exception when others then
    raise warning 'audit_log write skipped for %: %', tg_table_name, sqlerrm;
  end;
  return coalesce(new, old);
end $$;

alter table audit_log enable row level security;
drop policy if exists audit_log_admin_read on audit_log;
create policy audit_log_admin_read on audit_log for select using (
  (school_id = current_school_id() and current_is_admin()) or is_platform_admin()
);
revoke update, delete on audit_log from anon, authenticated;

do $$
declare t text; tables text[] := array[
  'scores','attendance_records','payments','fee_discounts','fee_assignments','fee_exemptions',
  'student_obligations','journal_entries','chart_of_accounts','leave_requests','payroll_runs',
  'role_permissions','staff_roles','student_subject_overrides','promotion_history'];
begin
  foreach t in array tables loop
    if to_regclass('public.' || t) is not null
       and not exists (
         select 1 from pg_trigger tg join pg_proc p on p.oid = tg.tgfoid
         where tg.tgrelid = to_regclass('public.' || t) and not tg.tgisinternal and p.proname = 'audit_row_change')
    then
      execute format('create trigger trg_audit_%1$s after insert or update or delete on public.%1$I for each row execute function audit_row_change()', t);
    end if;
  end loop;
end $$;
