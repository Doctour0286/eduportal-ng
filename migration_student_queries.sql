-- ============================================================================
-- migration_student_queries.sql
-- Lets staff query / fine / task a student WITHOUT suspending or reactivating
-- them. Reuses student_obligations (the table already behind reactivation
-- fines and tasks) rather than a parallel table:
--   * kind gains 'query' (a formal query awaiting the student's response)
--   * origin records where the item came from: 'reactivation' | 'direct'
-- A fine still requires an amount; a task or query does not.
-- Idempotent: safe to re-run.
-- ============================================================================

-- Replace the old kind/amount CHECK constraints (names were auto-generated).
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'student_obligations'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%kind%'
  loop
    execute format('alter table student_obligations drop constraint %I', c.conname);
  end loop;
end $$;

alter table student_obligations
  add constraint student_obligations_kind_check
  check (kind in ('fine', 'task', 'query'));

alter table student_obligations
  add constraint student_obligations_fine_amount_check
  check (kind <> 'fine' or amount is not null);

alter table student_obligations
  add column if not exists origin text not null default 'reactivation';

alter table student_obligations drop constraint if exists student_obligations_origin_check;
alter table student_obligations
  add constraint student_obligations_origin_check
  check (origin in ('reactivation', 'direct'));
