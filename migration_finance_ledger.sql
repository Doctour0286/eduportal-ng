-- ============================================================================
-- migration_finance_ledger.sql
-- Double-entry ledger (master plan §7.17), switchable per school with
-- schools.uses_ledger. Fee collection works with or without it.
--
--   chart_of_accounts / journal_entries / journal_lines   (created if missing)
--   * Every entry must balance — enforced by a deferred constraint trigger.
--   * Entries are never edited or deleted. Corrections are REVERSALS
--     (a new, opposite entry), so the history stays whole.
--   * Posting goes through post_journal_entry() so an entry and all of its
--     lines are written in one transaction and permission-checked.
--   * Completed payments auto-post (cash basis): debit Cash or Bank, credit
--     School fees income. A payment later marked refunded posts the reverse.
--     If the database ALREADY has a payment->ledger trigger, this one is not
--     added, so nothing is ever posted twice.
--
-- Permissions: finance.ledger.view to read, finance.ledger.post to post.
-- Idempotent: safe to re-run.
-- ============================================================================

alter table schools add column if not exists uses_ledger boolean not null default false;

create table if not exists chart_of_accounts (
  id                uuid primary key default gen_random_uuid(),
  school_id         uuid not null references schools(id),
  code              text not null,
  name              text not null,
  account_type      text not null check (account_type in ('asset','liability','equity','income','expense')),
  parent_account_id uuid references chart_of_accounts(id),
  is_active         boolean not null default true,
  created_at        timestamptz not null default now(),
  unique (school_id, code)
);

create table if not exists journal_entries (
  id          uuid primary key default gen_random_uuid(),
  school_id   uuid not null references schools(id),
  entry_date  date not null,
  description text not null,
  source_type text,
  source_id   uuid,
  created_by  uuid references staff(id),
  created_at  timestamptz not null default now()
);

create table if not exists journal_lines (
  id               uuid primary key default gen_random_uuid(),
  journal_entry_id uuid not null references journal_entries(id),
  school_id        uuid not null references schools(id),
  account_id       uuid not null references chart_of_accounts(id),
  debit            numeric(14,2) not null default 0,
  credit           numeric(14,2) not null default 0,
  memo             text,
  check (debit = 0 or credit = 0),
  check (debit >= 0 and credit >= 0)
);

create index if not exists idx_je_school_date on journal_entries(school_id, entry_date desc);
create index if not exists idx_jl_entry on journal_lines(journal_entry_id);
create index if not exists idx_jl_account on journal_lines(account_id);

-- One automatic entry per payment, one reversal per payment, one reversal per entry.
create unique index if not exists uq_je_payment on journal_entries(source_id) where source_type = 'payment';
create unique index if not exists uq_je_payment_refund on journal_entries(source_id) where source_type = 'payment_refund';
create unique index if not exists uq_je_reversal on journal_entries(source_id) where source_type = 'reversal';

-- ── Balance enforcement ─────────────────────────────────────────────────────
create or replace function enforce_journal_balance()
returns trigger language plpgsql as $$
declare v_entry uuid; v_d numeric; v_c numeric;
begin
  v_entry := coalesce(new.journal_entry_id, old.journal_entry_id);
  select coalesce(sum(debit), 0), coalesce(sum(credit), 0) into v_d, v_c
  from journal_lines where journal_entry_id = v_entry;
  if v_d <> v_c then
    raise exception 'Journal entry does not balance: debits % vs credits %', v_d, v_c;
  end if;
  return null;
end $$;

drop trigger if exists trg_journal_balance on journal_lines;
create constraint trigger trg_journal_balance
  after insert or update or delete on journal_lines
  deferrable initially deferred
  for each row execute function enforce_journal_balance();

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table chart_of_accounts enable row level security;
alter table journal_entries   enable row level security;
alter table journal_lines     enable row level security;

drop policy if exists coa_select on chart_of_accounts;
create policy coa_select on chart_of_accounts for select using (
  school_id = current_school_id()
  and (current_is_admin() or current_has_permission('finance.ledger.view') or current_has_permission('finance.ledger.post'))
);
drop policy if exists coa_write on chart_of_accounts;
create policy coa_write on chart_of_accounts for all using (
  school_id = current_school_id() and (current_is_admin() or current_has_permission('finance.ledger.post'))
) with check (
  school_id = current_school_id() and (current_is_admin() or current_has_permission('finance.ledger.post'))
);

drop policy if exists je_select on journal_entries;
create policy je_select on journal_entries for select using (
  school_id = current_school_id()
  and (current_is_admin() or current_has_permission('finance.ledger.view') or current_has_permission('finance.ledger.post'))
);
drop policy if exists jl_select on journal_lines;
create policy jl_select on journal_lines for select using (
  school_id = current_school_id()
  and (current_is_admin() or current_has_permission('finance.ledger.view') or current_has_permission('finance.ledger.post'))
);
-- No insert/update/delete policies on entries or lines: they are written only
-- by the functions below, and are never edited or deleted.

-- ── Helpers ─────────────────────────────────────────────────────────────────
create or replace function _ledger_staff_id() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select actor_record_id from app_identities where auth_user_id = auth.uid() and actor_type = 'staff' limit 1
$$;

create or replace function _ledger_seed_accounts(p_school uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into chart_of_accounts (school_id, code, name, account_type) values
    (p_school, '1000', 'Cash on hand',          'asset'),
    (p_school, '1010', 'Bank',                  'asset'),
    (p_school, '1100', 'Fees receivable',       'asset'),
    (p_school, '2000', 'Student credits / advance fees', 'liability'),
    (p_school, '2100', 'Accounts payable',      'liability'),
    (p_school, '3000', 'Retained earnings',     'equity'),
    (p_school, '4000', 'School fees income',    'income'),
    (p_school, '4100', 'Other income',          'income'),
    (p_school, '5000', 'Salaries and wages',    'expense'),
    (p_school, '5100', 'Utilities',             'expense'),
    (p_school, '5200', 'Teaching supplies',     'expense'),
    (p_school, '5300', 'Repairs and maintenance','expense'),
    (p_school, '5900', 'General expenses',      'expense')
  on conflict (school_id, code) do nothing;
end $$;

-- Switch the ledger on/off for the caller's school (admin only). Turning it on
-- seeds a starter chart of accounts if the school has none yet.
create or replace function enable_ledger(p_enable boolean) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_school uuid := current_school_id();
begin
  if not current_is_admin() then raise exception 'Only an administrator can switch the ledger on or off.'; end if;
  update schools set uses_ledger = p_enable where id = v_school;
  if p_enable and not exists (select 1 from chart_of_accounts where school_id = v_school) then
    perform _ledger_seed_accounts(v_school);
  end if;
  return p_enable;
end $$;

-- Post one balanced entry (all lines in one transaction).
create or replace function post_journal_entry(
  p_date date, p_description text, p_lines jsonb,
  p_source_type text default 'manual', p_source_id uuid default null
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_school uuid := current_school_id(); v_entry uuid; v_line jsonb; v_acc uuid;
begin
  if not (current_is_admin() or current_has_permission('finance.ledger.post')) then
    raise exception 'You do not have permission to post journal entries.';
  end if;
  if not exists (select 1 from schools where id = v_school and uses_ledger) then
    raise exception 'The ledger is not switched on for this school.';
  end if;
  if p_description is null or length(trim(p_description)) < 2 then raise exception 'A description is required.'; end if;
  if p_lines is null or jsonb_array_length(p_lines) < 2 then raise exception 'An entry needs at least two lines.'; end if;

  insert into journal_entries (school_id, entry_date, description, source_type, source_id, created_by)
  values (v_school, p_date, trim(p_description), coalesce(p_source_type, 'manual'), p_source_id, _ledger_staff_id())
  returning id into v_entry;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_acc := (v_line->>'account_id')::uuid;
    if not exists (select 1 from chart_of_accounts where id = v_acc and school_id = v_school and is_active) then
      raise exception 'A line uses an account that does not exist or is switched off.';
    end if;
    insert into journal_lines (journal_entry_id, school_id, account_id, debit, credit, memo)
    values (v_entry, v_school, v_acc,
            coalesce((v_line->>'debit')::numeric, 0), coalesce((v_line->>'credit')::numeric, 0), nullif(v_line->>'memo', ''));
  end loop;
  return v_entry;
end $$;

-- Correct a mistake by posting the opposite entry (never by editing).
create or replace function reverse_journal_entry(p_entry uuid, p_date date default current_date) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_school uuid := current_school_id(); v_orig journal_entries; v_new uuid;
begin
  if not (current_is_admin() or current_has_permission('finance.ledger.post')) then
    raise exception 'You do not have permission to post journal entries.';
  end if;
  select * into v_orig from journal_entries where id = p_entry and school_id = v_school;
  if v_orig.id is null then raise exception 'Entry not found.'; end if;
  if v_orig.source_type = 'reversal' then raise exception 'A reversal cannot itself be reversed.'; end if;
  if exists (select 1 from journal_entries where source_type = 'reversal' and source_id = p_entry) then
    raise exception 'This entry has already been reversed.';
  end if;
  insert into journal_entries (school_id, entry_date, description, source_type, source_id, created_by)
  values (v_school, p_date, 'Reversal of: ' || v_orig.description, 'reversal', p_entry, _ledger_staff_id())
  returning id into v_new;
  insert into journal_lines (journal_entry_id, school_id, account_id, debit, credit, memo)
  select v_new, school_id, account_id, credit, debit, memo from journal_lines where journal_entry_id = p_entry;
  return v_new;
end $$;

-- Trial balance for a date range (RLS applies; the caller sees only their school).
create or replace function ledger_trial_balance(p_from date, p_to date)
returns table (account_id uuid, code text, name text, account_type text, debit numeric, credit numeric)
language sql stable as $$
  select a.id, a.code, a.name, a.account_type,
         coalesce(sum(x.debit), 0)::numeric, coalesce(sum(x.credit), 0)::numeric
  from chart_of_accounts a
  left join (
    select l.account_id, l.debit, l.credit
    from journal_lines l join journal_entries e on e.id = l.journal_entry_id
    where e.entry_date between p_from and p_to
  ) x on x.account_id = a.id
  where a.school_id = current_school_id()
  group by a.id, a.code, a.name, a.account_type
  order by a.code
$$;

-- ── Automatic posting of payments (cash basis) ──────────────────────────────
create or replace function ledger_post_payment(p_payment uuid) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  p payments; v_cash uuid; v_bank uuid; v_income uuid; v_debit uuid; v_entry uuid;
begin
  select * into p from payments where id = p_payment;
  if p.id is null or p.status <> 'completed' then return null; end if;
  if not coalesce((select uses_ledger from schools where id = p.school_id), false) then return null; end if;
  if exists (select 1 from journal_entries where source_type = 'payment' and source_id = p.id) then return null; end if;

  select id into v_cash   from chart_of_accounts where school_id = p.school_id and code = '1000';
  select id into v_bank   from chart_of_accounts where school_id = p.school_id and code = '1010';
  select id into v_income from chart_of_accounts where school_id = p.school_id and code = '4000';
  if v_income is null or (v_cash is null and v_bank is null) then return null; end if;
  v_debit := case when p.method = 'cash' then coalesce(v_cash, v_bank) else coalesce(v_bank, v_cash) end;

  insert into journal_entries (school_id, entry_date, description, source_type, source_id)
  values (p.school_id, coalesce(p.paid_at::date, current_date), 'Fee payment received', 'payment', p.id)
  returning id into v_entry;
  insert into journal_lines (journal_entry_id, school_id, account_id, debit, credit, memo)
  values (v_entry, p.school_id, v_debit, p.amount, 0, p.method),
         (v_entry, p.school_id, v_income, 0, p.amount, null);
  return v_entry;
end $$;

create or replace function trg_post_payment_to_ledger() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_orig uuid; v_entry uuid;
begin
  begin
    if new.status = 'completed' and (tg_op = 'INSERT' or old.status is distinct from 'completed') then
      perform ledger_post_payment(new.id);
    elsif tg_op = 'UPDATE' and new.status = 'refunded' and old.status = 'completed' then
      select id into v_orig from journal_entries where source_type = 'payment' and source_id = new.id;
      if v_orig is not null and not exists (select 1 from journal_entries where source_type = 'payment_refund' and source_id = new.id) then
        insert into journal_entries (school_id, entry_date, description, source_type, source_id)
        values (new.school_id, current_date, 'Fee payment refunded', 'payment_refund', new.id) returning id into v_entry;
        insert into journal_lines (journal_entry_id, school_id, account_id, debit, credit, memo)
        select v_entry, school_id, account_id, credit, debit, memo from journal_lines where journal_entry_id = v_orig;
      end if;
    end if;
  exception when others then
    -- Bookkeeping must never stop a payment from being recorded.
    raise warning 'ledger auto-post skipped for payment %: %', new.id, sqlerrm;
  end;
  return new;
end $$;

do $$
declare v_existing int;
begin
  select count(*) into v_existing
  from pg_trigger t join pg_proc p on p.oid = t.tgfoid
  where t.tgrelid = 'payments'::regclass and not t.tgisinternal
    and t.tgname <> 'trg_payments_to_ledger'
    and pg_get_functiondef(p.oid) ilike '%journal_entries%';
  if v_existing = 0 then
    drop trigger if exists trg_payments_to_ledger on payments;
    create trigger trg_payments_to_ledger after insert or update of status on payments
      for each row execute function trg_post_payment_to_ledger();
  else
    raise notice 'A payment->ledger trigger already exists; not adding a second one.';
  end if;
end $$;

-- Post payments that were completed before the ledger was switched on.
create or replace function backfill_ledger_payments() returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_school uuid := current_school_id(); r record; n int := 0;
begin
  if not (current_is_admin() or current_has_permission('finance.ledger.post')) then
    raise exception 'You do not have permission to post journal entries.';
  end if;
  for r in select id from payments where school_id = v_school and status = 'completed'
           and not exists (select 1 from journal_entries e where e.source_type = 'payment' and e.source_id = payments.id)
  loop
    if ledger_post_payment(r.id) is not null then n := n + 1; end if;
  end loop;
  return n;
end $$;
