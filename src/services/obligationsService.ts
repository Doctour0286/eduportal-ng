/**
 * obligationsService.ts — fines / tasks assigned to a student, typically at
 * reactivation (migration_attendance_class_rules_and_obligations.sql).
 *
 * A fine's amount is RECORDED here, not billed — there is no automatic link
 * to the Finance module. Lifecycle: pending -> fulfilled | waived, each step
 * stamped with the staff member responsible and the time.
 */
import { supabase } from '../lib/supabase'

type Ok<T> = { ok: true; data: T }
type Err = { ok: false; error: string }
type Result<T> = Ok<T> | Err

export type ObligationKind = 'fine' | 'task'
export type ObligationStatus = 'pending' | 'fulfilled' | 'waived'

export interface Obligation {
  id: string
  student_id: string
  kind: ObligationKind
  description: string
  amount: number | null
  due_date: string | null
  status: ObligationStatus
  created_by_name: string | null
  created_at: string
  resolved_by_name: string | null
  resolved_at: string | null
  resolution_note: string | null
}

/** Form state for "add a fine or task" — amount kept as text while typing. */
export interface ObligationDraft {
  kind: ObligationKind
  description: string
  amount: string
  dueDate: string
}

export const EMPTY_OBLIGATION_DRAFT: ObligationDraft = {
  kind: 'fine', description: '', amount: '', dueDate: '',
}

export function validateObligationDraft(d: ObligationDraft): string | null {
  if (!d.description.trim()) return 'Describe the fine or task.'
  if (d.kind === 'fine') {
    const n = Number(d.amount)
    if (!d.amount.trim() || !Number.isFinite(n) || n < 0) return 'Enter a valid fine amount.'
  }
  return null
}

export function formatObligationAmount(n: number): string {
  return `₦${n.toLocaleString('en-NG', { maximumFractionDigits: 2 })}`
}

export interface ObligationBadgeInfo {
  id: string
  kind: ObligationKind
  label: string
  title: string
}

const BADGE_TEXT_MAX = 26

/**
 * One badge per pending item, specific about what it is: a fine shows its
 * amount ("₦5,000 fine"), a task shows its text ("Task: Clean the lab").
 */
export function obligationBadges(list: Obligation[] | undefined): ObligationBadgeInfo[] {
  if (!list) return []
  return list.map(o => {
    const text = o.description.length > BADGE_TEXT_MAX
      ? o.description.slice(0, BADGE_TEXT_MAX - 1).trimEnd() + '…'
      : o.description
    return {
      id: o.id,
      kind: o.kind,
      label: o.kind === 'fine' ? `${formatObligationAmount(o.amount ?? 0)} fine` : `Task: ${text}`,
      title: o.kind === 'fine' ? `Fine ${formatObligationAmount(o.amount ?? 0)} — ${o.description}` : o.description,
    }
  })
}

/** Human status wording that fits the kind: fines are paid, tasks are done. */
export function obligationStatusLabel(o: Pick<Obligation, 'kind' | 'status'>): string {
  if (o.status === 'waived') return 'Waived'
  if (o.status === 'pending') return o.kind === 'fine' ? 'Unpaid' : 'Not done'
  return o.kind === 'fine' ? 'Paid' : 'Done'
}

async function staffNames(ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))] as string[]
  const out = new Map<string, string>()
  if (unique.length === 0) return out
  const { data } = await supabase.from('staff').select('id, full_name').in('id', unique)
  for (const s of data ?? []) out.set(s.id, s.full_name)
  return out
}

function mapRow(r: any, names: Map<string, string>): Obligation {
  return {
    id: r.id,
    student_id: r.student_id,
    kind: r.kind,
    description: r.description,
    amount: r.amount === null || r.amount === undefined ? null : Number(r.amount),
    due_date: r.due_date ?? null,
    status: r.status,
    created_by_name: r.created_by ? (names.get(r.created_by) ?? null) : null,
    created_at: r.created_at,
    resolved_by_name: r.resolved_by ? (names.get(r.resolved_by) ?? null) : null,
    resolved_at: r.resolved_at ?? null,
    resolution_note: r.resolution_note ?? null,
  }
}

const COLS =
  'id, student_id, kind, description, amount, due_date, status, created_by, created_at, resolved_by, resolved_at, resolution_note'

/** Every pending item in the school, grouped by student — for list badges. */
export async function loadPendingObligations(
  schoolId: string,
): Promise<Result<Map<string, Obligation[]>>> {
  try {
    const { data, error } = await supabase
      .from('student_obligations')
      .select(COLS)
      .eq('school_id', schoolId)
      .eq('status', 'pending')
      .order('created_at')
    if (error) return { ok: false, error: error.message }
    const names = await staffNames((data ?? []).map(r => r.created_by))
    const out = new Map<string, Obligation[]>()
    for (const r of data ?? []) {
      const o = mapRow(r, names)
      const arr = out.get(o.student_id) ?? []
      arr.push(o)
      out.set(o.student_id, arr)
    }
    return { ok: true, data: out }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load fines and tasks' }
  }
}

/** Full history (all statuses, newest first) for one student, with staff names. */
export async function loadStudentObligations(studentId: string): Promise<Result<Obligation[]>> {
  try {
    const { data, error } = await supabase
      .from('student_obligations')
      .select(COLS)
      .eq('student_id', studentId)
      .order('created_at', { ascending: false })
    if (error) return { ok: false, error: error.message }
    const names = await staffNames((data ?? []).flatMap(r => [r.created_by, r.resolved_by]))
    return { ok: true, data: (data ?? []).map(r => mapRow(r, names)) }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load fines and tasks' }
  }
}

export async function createObligation(params: {
  schoolId: string
  studentId: string
  draft: ObligationDraft
  createdBy: string | null   // staff.id (actorRecordId)
}): Promise<Result<void>> {
  const problem = validateObligationDraft(params.draft)
  if (problem) return { ok: false, error: problem }
  const { error } = await supabase.from('student_obligations').insert({
    school_id: params.schoolId,
    student_id: params.studentId,
    kind: params.draft.kind,
    description: params.draft.description.trim(),
    amount: params.draft.kind === 'fine' ? Number(params.draft.amount) : null,
    due_date: params.draft.dueDate || null,
    created_by: params.createdBy,
  })
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: undefined }
}

export async function resolveObligation(params: {
  id: string
  status: 'fulfilled' | 'waived'
  note: string
  resolvedBy: string | null   // staff.id (actorRecordId)
}): Promise<Result<void>> {
  const { error } = await supabase
    .from('student_obligations')
    .update({
      status: params.status,
      resolved_by: params.resolvedBy,
      resolved_at: new Date().toISOString(),
      resolution_note: params.note.trim() || null,
    })
    .eq('id', params.id)
    .eq('status', 'pending')   // never overwrite an already-resolved item
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: undefined }
}
