/**
 * ledgerService.ts — double-entry ledger (migration_finance_ledger.sql).
 * Entries are never edited or deleted; mistakes are corrected with a
 * reversal. All writes go through database functions so an entry and its
 * lines are saved together and permission-checked.
 */
import { supabase } from '../lib/supabase'

type Ok<T> = { ok: true; data: T }
type Err = { ok: false; error: string }
type Result<T> = Ok<T> | Err

export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense'

export interface Account {
  id: string
  code: string
  name: string
  account_type: AccountType
  is_active: boolean
}

export interface JournalLine {
  id: string
  debit: number
  credit: number
  memo: string | null
  account_code: string
  account_name: string
}

export interface JournalEntry {
  id: string
  entry_date: string
  description: string
  source_type: string | null
  created_at: string
  lines: JournalLine[]
  total: number
}

export interface TrialRow {
  account_id: string
  code: string
  name: string
  account_type: AccountType
  debit: number
  credit: number
}

export interface StatementLine {
  entry_date: string
  description: string
  memo: string | null
  debit: number
  credit: number
  balance: number
}

export interface DraftLine { account_id: string; debit: string; credit: string; memo: string }

const fail = (e: any): Err => ({ ok: false, error: e?.message ?? 'Something went wrong' })
const num = (v: unknown) => Number(v ?? 0)

export async function loadLedgerEnabled(schoolId: string): Promise<boolean> {
  const { data } = await supabase.from('schools').select('uses_ledger').eq('id', schoolId).maybeSingle()
  return !!data?.uses_ledger
}

export async function setLedgerEnabled(enabled: boolean): Promise<Result<void>> {
  const { error } = await supabase.rpc('enable_ledger', { p_enable: enabled })
  return error ? fail(error) : { ok: true, data: undefined }
}

export async function loadAccounts(schoolId: string): Promise<Result<Account[]>> {
  const { data, error } = await supabase
    .from('chart_of_accounts')
    .select('id, code, name, account_type, is_active')
    .eq('school_id', schoolId)
    .order('code')
  if (error) return fail(error)
  return { ok: true, data: (data ?? []) as Account[] }
}

export async function saveAccount(
  schoolId: string,
  a: { id?: string; code: string; name: string; account_type: AccountType; is_active?: boolean },
): Promise<Result<void>> {
  if (!a.code.trim() || !a.name.trim()) return { ok: false, error: 'Give the account a code and a name.' }
  const row = { code: a.code.trim(), name: a.name.trim(), account_type: a.account_type, ...(a.is_active === undefined ? {} : { is_active: a.is_active }) }
  const { error } = a.id
    ? await supabase.from('chart_of_accounts').update(row).eq('id', a.id)
    : await supabase.from('chart_of_accounts').insert({ school_id: schoolId, ...row })
  if (error) return fail(error.code === '23505' ? { message: `An account with code ${a.code.trim()} already exists.` } : error)
  return { ok: true, data: undefined }
}

export async function loadJournal(schoolId: string, from: string, to: string): Promise<Result<JournalEntry[]>> {
  const { data, error } = await supabase
    .from('journal_entries')
    .select('id, entry_date, description, source_type, created_at, journal_lines ( id, debit, credit, memo, chart_of_accounts ( code, name ) )')
    .eq('school_id', schoolId)
    .gte('entry_date', from)
    .lte('entry_date', to)
    .order('entry_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(300)
  if (error) return fail(error)
  const one = (x: any) => (Array.isArray(x) ? x[0] : x)
  return {
    ok: true,
    data: (data ?? []).map((e: any) => {
      const lines: JournalLine[] = (e.journal_lines ?? []).map((l: any) => ({
        id: l.id, debit: num(l.debit), credit: num(l.credit), memo: l.memo ?? null,
        account_code: one(l.chart_of_accounts)?.code ?? '', account_name: one(l.chart_of_accounts)?.name ?? '',
      }))
      return {
        id: e.id, entry_date: e.entry_date, description: e.description, source_type: e.source_type,
        created_at: e.created_at, lines, total: lines.reduce((n, l) => n + l.debit, 0),
      }
    }),
  }
}

export function draftTotals(lines: DraftLine[]) {
  const debit = lines.reduce((n, l) => n + (Number(l.debit) || 0), 0)
  const credit = lines.reduce((n, l) => n + (Number(l.credit) || 0), 0)
  return { debit, credit, balanced: debit > 0 && Math.abs(debit - credit) < 0.005 }
}

export async function postEntry(date: string, description: string, lines: DraftLine[]): Promise<Result<void>> {
  const used = lines.filter(l => l.account_id && (Number(l.debit) > 0 || Number(l.credit) > 0))
  if (used.length < 2) return { ok: false, error: 'An entry needs at least two lines with an account and an amount.' }
  if (used.some(l => Number(l.debit) > 0 && Number(l.credit) > 0)) return { ok: false, error: 'A line is either a debit or a credit, not both.' }
  if (!draftTotals(used).balanced) return { ok: false, error: 'Debits and credits must be equal.' }
  const { error } = await supabase.rpc('post_journal_entry', {
    p_date: date,
    p_description: description,
    p_lines: used.map(l => ({ account_id: l.account_id, debit: Number(l.debit) || 0, credit: Number(l.credit) || 0, memo: l.memo })),
  })
  return error ? fail(error) : { ok: true, data: undefined }
}

export async function reverseEntry(entryId: string): Promise<Result<void>> {
  const { error } = await supabase.rpc('reverse_journal_entry', { p_entry: entryId })
  return error ? fail(error) : { ok: true, data: undefined }
}

export async function backfillPayments(): Promise<Result<number>> {
  const { data, error } = await supabase.rpc('backfill_ledger_payments')
  return error ? fail(error) : { ok: true, data: Number(data ?? 0) }
}

export async function trialBalance(from: string, to: string): Promise<Result<TrialRow[]>> {
  const { data, error } = await supabase.rpc('ledger_trial_balance', { p_from: from, p_to: to })
  if (error) return fail(error)
  return {
    ok: true,
    data: (data ?? []).map((r: any) => ({
      account_id: r.account_id, code: r.code, name: r.name, account_type: r.account_type,
      debit: num(r.debit), credit: num(r.credit),
    })),
  }
}

/** One account's lines in date order with a running balance (natural side by type). */
export async function accountStatement(account: Account, from: string, to: string): Promise<Result<StatementLine[]>> {
  const { data, error } = await supabase
    .from('journal_lines')
    .select('debit, credit, memo, journal_entries!inner ( entry_date, description, created_at )')
    .eq('account_id', account.id)
    .gte('journal_entries.entry_date', from)
    .lte('journal_entries.entry_date', to)
    .limit(1000)
  if (error) return fail(error)
  const one = (x: any) => (Array.isArray(x) ? x[0] : x)
  const raw = (data ?? []).map((l: any) => ({
    entry_date: one(l.journal_entries)?.entry_date as string,
    created_at: one(l.journal_entries)?.created_at as string,
    description: one(l.journal_entries)?.description as string,
    memo: (l.memo as string | null) ?? null,
    debit: num(l.debit), credit: num(l.credit),
  })).sort((a, b) => a.entry_date.localeCompare(b.entry_date) || a.created_at.localeCompare(b.created_at))
  const debitNormal = account.account_type === 'asset' || account.account_type === 'expense'
  let bal = 0
  return {
    ok: true,
    data: raw.map(r => {
      bal += debitNormal ? r.debit - r.credit : r.credit - r.debit
      return { entry_date: r.entry_date, description: r.description, memo: r.memo, debit: r.debit, credit: r.credit, balance: bal }
    }),
  }
}
