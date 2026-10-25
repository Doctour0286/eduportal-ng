-- ============================================================================
-- migration_first_day_of_week.sql
-- Lets each school choose which day its week starts on (0 = Sunday ... 6 =
-- Saturday). Display-ordering only: it does not change which days are school
-- days (that is school_week_days). Default Monday.
-- Idempotent: safe to re-run.
-- ============================================================================
alter table schools
  add column if not exists first_day_of_week smallint not null default 1;

alter table schools drop constraint if exists schools_first_day_of_week_check;
alter table schools
  add constraint schools_first_day_of_week_check
  check (first_day_of_week between 0 and 6);
