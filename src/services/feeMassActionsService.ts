/**
 * feeMassActionsService.ts — edit and mass-action fee assignments:
 *   edit_amount  change the amount on the selected assignments
 *   waive        full / percentage / fixed discount per student per fee
 *   exempt       the student is not billed for the fee at all
 *   unassign     void the assignment (soft — payments and history stay)
 *
 * Every action is previewed first (what changes, how many students, how much
 * money, who ends up with a credit), requires a reason, is logged with who and
 * when, and can be undone. See migration_fee_mass_actions.sql.
 *
 * Overpayment rule: when an action leaves a student having paid more than
 * they now owe, the difference is reported as a CREDIT on their account (the
 * balance calculation exposes it) — never silently dropped and never shown as
 * a negative debt.
 */
import { supabase } from '../lib/supabase'
import type { FeeAssignment } from './financeService'

type Ok<T> = { ok: true; data: T }
type Err = { ok: false; error: string }
type Result<T> = Ok<T> | Err

export type MassAction = 'edit_amount' | 'waive' | 'exempt' | 'unassign'

export type StudentScope =
  | { type: 'school' }
  | { type: 'class'; classNodeId: string; label: string }
  | { type: 'student'; studentId: string; label: string }

export type WaiveSpec =
  | { kind: 'full' }
  | { kind: 'percentage'; value: number }
  | { kind: 'fixed'; value: number }

export type AmountSpec =
  | { mode: 'set'; value: number }
  | { mode: 'adjust_percent'; value: number }   // +10 or -10
  | { mode: 'adjust_fixed'; value: number }     // +2000 or -2000

export interface MassRequest {
  schoolId: string
  action: MassAction
  assignments: FeeAssignment[]          // the selected assignments
  scope: StudentScope                   // who it applies to (waive / exempt)
  waive?: WaiveSpec
  amount?: AmountSpec
  reason: string
}

export interface MassPreview {
  action: MassAction
  assignmentsCount: number
  studentsCount: number
  pairsCount: number
  totalAmount: number                   // naira waived / exempted / removed / net change
  creditTotal: number                   // new credit created for overpaid students
  creditStudents: number
  blocked: { assignment: FeeAssignment; reason: string }[]
  notes: string[]
}

export interface FeeActionLogRow {
  id: string
  action: MassAction
  scopeLabel: string
  assignments_count: number
  students_count: number
  total_amount: number | null
  reason: string
  performed_by_name: string | null
  performed_at: string
  undone_at: string | null
  undone_by_name: string | null
  failed: boolean
}

interface Pair { assignment: FeeAssignment; studentId: string }

// ─── Resolve which (assignment, student) pairs an action touches ─────────────

async function classDescendants(schoolId: string, rootId: string): Promise<Set<string>> {
  const { data } = await supabase.from('class_nodes').select('id, parent_id').eq('school_id', schoolId)
  const kids = new Map<string, string[]>()
  for (const n of data ?? []) {
    if (!n.parent_id) continue
    kids.set(n.parent_id, [...(kids.get(n.parent_id) ?? []), n.id])
  }
  const out = new Set<string>([rootId])
  const stack = [rootId]
  while (stack.length) {
    const cur = stack.pop()!
    for (const k of kids.get(cur) ?? []) if (!out.has(k)) { out.add(k); stack.push(k) }
  }
  return out
}

async function resolvePairs(schoolId: string, assignments: FeeAssignment[], scope: StudentScope): Promise<Pair[]> {
  const { data: students, error } = await supabase
    .from('students')
    .select('id, class_node_id')
    .eq('school_id', schoolId)
    .eq('status', 'active')
  if (error) throw new Error(error.message)
  const active = (students ?? []) as Array<{ id: string; class_node_id: string | null }>

  const needsPlacements = assignments.some(a => a.target_type === 'programme_level')
  const placement = new Map<string, string>()
  if (needsPlacements) {
    const { data: pl } = await supabase
      .from('student_programme_placements')
      .select('student_id, programme_level_id')
      .eq('is_current', true)
    for (const p of pl ?? []) placement.set(p.student_id as string, p.programme_level_id as string)
  }

  const classSet = scope.type === 'class' ? await classDescendants(schoolId, scope.classNodeId) : null
  const inScope = (s: { id: string; class_node_id: string | null }) => {
    if (scope.type === 'student') return s.id === scope.studentId
    if (scope.type === 'class') return !!s.class_node_id && classSet!.has(s.class_node_id)
    return true
  }

  const pairs: Pair[] = []
  for (const a of assignments) {
    for (const s of active) {
      let applies = false
      if (a.target_type === 'school_wide') applies = true
      else if (a.target_type === 'class_node') applies = a.class_node_id === s.class_node_id
      else if (a.target_type === 'student') applies = a.student_id === s.id
      else if (a.target_type === 'programme_level') applies = a.programme_level_id !== null && placement.get(s.id) === a.programme_level_id
      if (applies && inScope(s)) pairs.push({ assignment: a, studentId: s.id })
    }
  }
  return pairs
}

interface Money {
  paid: Map<string, number>          // `${assignmentId}|${studentId}` → completed payments
  paidByAssignment: Map<string, number>
  discount: Map<string, number>      // existing active discount per pair (resolved to naira)
  exempt: Set<string>                // pairs already exempt
}

async function loadMoney(assignments: FeeAssignment[]): Promise<Money> {
  const ids = assignments.map(a => a.id)
  const amountOf = new Map(assignments.map(a => [a.id, a.amount]))
  const paid = new Map<string, number>()
  const paidByAssignment = new Map<string, number>()
  const discount = new Map<string, number>()
  const exempt = new Set<string>()
  if (ids.length === 0) return { paid, paidByAssignment, discount, exempt }

  const [payRes, discRes, exRes] = await Promise.all([
    supabase.from('payments').select('student_id, fee_assignment_id, amount').in('fee_assignment_id', ids).eq('status', 'completed'),
    supabase.from('fee_discounts').select('student_id, fee_assignment_id, discount_type, value').in('fee_assignment_id', ids).is('voided_at', null),
    supabase.from('fee_exemptions').select('student_id, fee_assignment_id').in('fee_assignment_id', ids).is('voided_at', null),
  ])
  if (payRes.error) throw new Error(payRes.error.message)
  if (discRes.error) throw new Error(discRes.error.message)
  if (exRes.error) throw new Error(exRes.error.message)

  for (const p of payRes.data ?? []) {
    const k = `${p.fee_assignment_id}|${p.student_id}`
    paid.set(k, (paid.get(k) ?? 0) + Number(p.amount))
    paidByAssignment.set(p.fee_assignment_id as string, (paidByAssignment.get(p.fee_assignment_id as string) ?? 0) + Number(p.amount))
  }
  for (const d of discRes.data ?? []) {
    const base = amountOf.get(d.fee_assignment_id as string) ?? 0
    const v = Number(d.value ?? 0)
    const naira = d.discount_type === 'full_waiver' ? base : d.discount_type === 'percentage' ? (base * v) / 100 : v
    const k = `${d.fee_assignment_id}|${d.student_id}`
    discount.set(k, (discount.get(k) ?? 0) + naira)
  }
  for (const e of exRes.data ?? []) exempt.add(`${e.fee_assignment_id}|${e.student_id}`)
  return { paid, paidByAssignment, discount, exempt }
}

const key = (p: Pair) => `${p.assignment.id}|${p.studentId}`
const creditOf = (amount: number, discount: number, paid: number) => Math.max(0, paid + discount - amount)

export function newAmountFor(old: number, spec: AmountSpec): number {
  const raw =
    spec.mode === 'set' ? spec.value
    : spec.mode === 'adjust_percent' ? old * (1 + spec.value / 100)
    : old + spec.value
  return Math.max(0, Math.round(raw * 100) / 100)
}

export function validateRequest(r: MassRequest): string | null {
  if (r.assignments.length === 0) return 'Select at least one fee assignment.'
  if (r.reason.trim().length < 3) return 'Give a reason — it is kept in the audit log.'
  if (r.action === 'waive') {
    if (!r.waive) return 'Choose how to waive.'
    if (r.waive.kind === 'percentage' && !(r.waive.value > 0 && r.waive.value <= 100)) return 'Percentage must be between 1 and 100.'
    if (r.waive.kind === 'fixed' && !(r.waive.value > 0)) return 'Enter a waiver amount above zero.'
  }
  if (r.action === 'edit_amount') {
    if (!r.amount) return 'Choose how to change the amount.'
    if (!Number.isFinite(r.amount.value)) return 'Enter a valid number.'
    if (r.amount.mode === 'set' && r.amount.value < 0) return 'Amount cannot be negative.'
  }
  if ((r.action === 'waive' || r.action === 'exempt') && r.scope.type !== 'school' && !('label' in r.scope)) return 'Choose who this applies to.'
  return null
}

// ─── Preview ─────────────────────────────────────────────────────────────────

export async function previewMassAction(r: MassRequest): Promise<Result<MassPreview>> {
  try {
    const problem = validateRequest(r)
    if (problem) return { ok: false, error: problem }
    const money = await loadMoney(r.assignments)
    const notes: string[] = []
    const blocked: MassPreview['blocked'] = []

    // Edit amount and unassign act on the assignments themselves, so they
    // affect everyone those assignments cover regardless of the scope picker.
    const scope: StudentScope = r.action === 'edit_amount' || r.action === 'unassign' ? { type: 'school' } : r.scope
    let working = r.assignments
    if (r.action === 'unassign') {
      working = []
      for (const a of r.assignments) {
        if ((money.paidByAssignment.get(a.id) ?? 0) > 0) {
          blocked.push({ assignment: a, reason: 'Payments already recorded against it' })
        } else working.push(a)
      }
      if (blocked.length > 0) notes.push('Fees with payments cannot be unassigned. Waive or exempt them instead, so the payments become credit.')
    }
    const pairs = await resolvePairs(r.schoolId, working, scope)
    const students = new Set(pairs.map(p => p.studentId))

    let total = 0, creditTotal = 0
    const creditStudents = new Set<string>()
    const addCredit = (studentId: string, before: number, after: number) => {
      if (after > before) { creditTotal += after - before; creditStudents.add(studentId) }
    }

    for (const p of pairs) {
      const a = p.assignment, k = key(p)
      const paid = money.paid.get(k) ?? 0
      const disc = money.discount.get(k) ?? 0
      const wasExempt = money.exempt.has(k)
      const before = wasExempt ? paid : creditOf(a.amount, disc, paid)

      if (r.action === 'waive') {
        if (wasExempt) continue
        const w = r.waive!.kind === 'full' ? a.amount - disc
          : r.waive!.kind === 'percentage' ? Math.min((a.amount * r.waive!.value) / 100, a.amount - disc)
          : Math.min(r.waive!.value, a.amount - disc)
        const add = Math.max(0, w)
        total += add
        addCredit(p.studentId, before, creditOf(a.amount, disc + add, paid))
      } else if (r.action === 'exempt') {
        if (wasExempt) continue
        total += Math.max(0, a.amount - disc)
        addCredit(p.studentId, before, paid)
      } else if (r.action === 'edit_amount') {
        const next = newAmountFor(a.amount, r.amount!)
        total += next - a.amount
        addCredit(p.studentId, before, creditOf(next, disc, paid))
      } else {
        total += a.amount
      }
    }

    if (r.action === 'waive' || r.action === 'exempt') {
      const skipped = pairs.filter(p => money.exempt.has(key(p))).length
      if (skipped > 0) notes.push(`${skipped} student-fee pair${skipped === 1 ? ' is' : 's are'} already exempt and will be skipped.`)
    }
    if (r.action === 'edit_amount') notes.push('Percentage and fixed discounts already given on these fees are recalculated from the new amount.')
    if (creditStudents.size > 0) notes.push(`${creditStudents.size} student${creditStudents.size === 1 ? '' : 's'} had already paid more than they will now owe — the difference is held as a credit on their account.`)

    return {
      ok: true,
      data: {
        action: r.action,
        assignmentsCount: working.length,
        studentsCount: students.size,
        pairsCount: pairs.length,
        totalAmount: Math.round(total * 100) / 100,
        creditTotal: Math.round(creditTotal * 100) / 100,
        creditStudents: creditStudents.size,
        blocked,
        notes,
      },
    }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Could not prepare the preview' }
  }
}

// ─── Apply ───────────────────────────────────────────────────────────────────

const CHUNK = 400


export async function applyMassAction(
  r: MassRequest,
  staffId: string | null,
): Promise<Result<{ logId: string; summary: string }>> {
  const prev = await previewMassAction(r)
  if (!prev.ok) return prev
  const pv = prev.data
  if (pv.pairsCount === 0 && r.action !== 'edit_amount' && r.action !== 'unassign') {
    return { ok: false, error: 'Nothing to change — no students match this selection.' }
  }
  if (pv.assignmentsCount === 0) return { ok: false, error: 'Nothing to change — every selected fee was blocked.' }

  const effectiveScope: StudentScope = r.action === 'edit_amount' || r.action === 'unassign' ? { type: 'school' } : r.scope
  const blockedIds = new Set(pv.blocked.map(b => b.assignment.id))
  const working = r.assignments.filter(a => !blockedIds.has(a.id))

  // Log first (the discount/exemption rows reference it); finalised below.
  const { data: logRow, error: logErr } = await supabase
    .from('fee_action_log')
    .insert({
      school_id: r.schoolId,
      action: r.action,
      scope: effectiveScope,
      assignments_count: pv.assignmentsCount,
      students_count: pv.studentsCount,
      total_amount: pv.totalAmount,
      reason: r.reason.trim(),
      details: { status: 'in_progress', assignmentIds: working.map(a => a.id) },
      performed_by: staffId,
    })
    .select('id')
    .single()
  if (logErr || !logRow) return { ok: false, error: logErr?.message ?? 'Could not record the action.' }
  const logId = logRow.id as string
  const now = new Date().toISOString()
  const touchedIds = working.map(a => a.id)
  const finish = (details: Record<string, unknown>) =>
    supabase.from('fee_action_log').update({ details: { assignmentIds: touchedIds, ...details } }).eq('id', logId)

  try {
    const money = await loadMoney(working)

    if (r.action === 'edit_amount') {
      const changes = working
        .map(a => ({ id: a.id, from: a.amount, to: newAmountFor(a.amount, r.amount!) }))
        .filter(c => c.from !== c.to)
      const byNew = new Map<number, string[]>()
      for (const c of changes) byNew.set(c.to, [...(byNew.get(c.to) ?? []), c.id])
      for (const [amount, ids] of byNew) {
        const { error } = await supabase.from('fee_assignments').update({ amount, updated_at: now }).in('id', ids)
        if (error) throw new Error(error.message)
      }
      await finish({ status: 'done', changes })
      return { ok: true, data: { logId, summary: `${changes.length} fee assignment${changes.length === 1 ? '' : 's'} updated.` } }
    }

    if (r.action === 'unassign') {
      const ids = working.map(a => a.id)
      const { error } = await supabase
        .from('fee_assignments')
        .update({ voided_at: now, voided_by: staffId })
        .in('id', ids)
        .is('voided_at', null)
      if (error) throw new Error(error.message)
      await finish({ status: 'done', assignmentIds: ids })
      return { ok: true, data: { logId, summary: `${ids.length} fee assignment${ids.length === 1 ? '' : 's'} unassigned.` } }
    }

    const pairs = await resolvePairs(r.schoolId, working, effectiveScope)

    if (r.action === 'waive') {
      const rows = pairs
        .filter(p => !money.exempt.has(key(p)))
        .map(p => {
          const a = p.assignment
          const existing = money.discount.get(key(p)) ?? 0
          const room = Math.max(0, a.amount - existing)
          if (room <= 0) return null
          const w = r.waive!
          const base = {
            school_id: r.schoolId,
            student_id: p.studentId,
            fee_assignment_id: a.id,
            reason: r.reason.trim(),
            approved_by: staffId,
            action_id: logId,
          }
          if (w.kind === 'full') return { ...base, discount_type: 'full_waiver', value: null }
          if (w.kind === 'percentage') return { ...base, discount_type: 'percentage', value: w.value }
          return { ...base, discount_type: 'fixed_amount', value: Math.min(w.value, room) }
        })
        .filter(Boolean) as Record<string, unknown>[]
      for (let i = 0; i < rows.length; i += CHUNK) {
        const { error } = await supabase.from('fee_discounts').insert(rows.slice(i, i + CHUNK))
        if (error) throw new Error(error.message)
      }
      await finish({ status: 'done', created: rows.length })
      return { ok: true, data: { logId, summary: `${rows.length} waiver${rows.length === 1 ? '' : 's'} applied.` } }
    }

    // exempt
    const rows = pairs
      .filter(p => !money.exempt.has(key(p)))
      .map(p => ({
        school_id: r.schoolId,
        fee_assignment_id: p.assignment.id,
        student_id: p.studentId,
        reason: r.reason.trim(),
        action_id: logId,
        created_by: staffId,
      }))
    for (let i = 0; i < rows.length; i += CHUNK) {
      const { error } = await supabase.from('fee_exemptions').insert(rows.slice(i, i + CHUNK))
      if (error) throw new Error(error.message)
    }
    await finish({ status: 'done', created: rows.length })
    return { ok: true, data: { logId, summary: `${rows.length} exemption${rows.length === 1 ? '' : 's'} applied.` } }
  } catch (err: any) {
    // Partial effects keep this action's id, so Undo can still reverse them.
    await finish({ status: 'failed', error: err?.message ?? 'unknown error' })
    return { ok: false, error: `${err?.message ?? 'The action failed'}. It was logged as failed; use Undo in the history to reverse anything that was applied.` }
  }
}

// ─── History + undo ──────────────────────────────────────────────────────────

const LOG_COLS = 'id, action, scope, assignments_count, students_count, total_amount, reason, details, performed_by, performed_at, undone_at, undone_by'

async function mapLogRows(data: any[]): Promise<FeeActionLogRow[]> {
  const ids = [...new Set(data.flatMap(r => [r.performed_by, r.undone_by]).filter(Boolean))] as string[]
  const names = new Map<string, string>()
  if (ids.length) {
    const { data: staff } = await supabase.from('staff').select('id, full_name').in('id', ids)
    for (const st of staff ?? []) names.set(st.id as string, st.full_name as string)
  }
  return data.map((r: any) => ({
    id: r.id,
    action: r.action,
    scopeLabel: r.scope?.type === 'class' ? `Class: ${r.scope.label}` : r.scope?.type === 'student' ? `Student: ${r.scope.label}` : 'All students',
    assignments_count: r.assignments_count,
    students_count: r.students_count,
    total_amount: r.total_amount === null ? null : Number(r.total_amount),
    reason: r.reason,
    performed_by_name: r.performed_by ? (names.get(r.performed_by) ?? null) : null,
    performed_at: r.performed_at,
    undone_at: r.undone_at,
    undone_by_name: r.undone_by ? (names.get(r.undone_by) ?? null) : null,
    failed: r.details?.status === 'failed',
  }))
}

export async function loadFeeActionLog(schoolId: string): Promise<Result<FeeActionLogRow[]>> {
  try {
    const { data, error } = await supabase
      .from('fee_action_log')
      .select(LOG_COLS)
      .eq('school_id', schoolId)
      .order('performed_at', { ascending: false })
      .limit(30)
    if (error) return { ok: false, error: error.message }
    return { ok: true, data: await mapLogRows(data ?? []) }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Could not load the history' }
  }
}

/** Mass actions that touched one assignment (actions logged before this existed won't appear). */
export async function loadAssignmentActivity(schoolId: string, assignmentId: string): Promise<Result<FeeActionLogRow[]>> {
  try {
    const { data, error } = await supabase
      .from('fee_action_log')
      .select(LOG_COLS)
      .eq('school_id', schoolId)
      .contains('details', { assignmentIds: [assignmentId] })
      .order('performed_at', { ascending: false })
      .limit(30)
    if (error) return { ok: false, error: error.message }
    return { ok: true, data: await mapLogRows(data ?? []) }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Could not load activity' }
  }
}

// ─── Who an assignment covers, and where each student stands ────────────────

export interface CoverageRow {
  studentId: string
  name: string
  className: string | null
  discount: number
  paid: number
  exempt: boolean
  owed: number        // what they still owe on this fee
  credit: number      // overpaid on this fee
  status: 'exempt' | 'paid' | 'part' | 'unpaid' | 'waived' | 'credit'
}

export async function loadAssignmentCoverage(schoolId: string, a: FeeAssignment): Promise<Result<CoverageRow[]>> {
  try {
    const pairs = await resolvePairs(schoolId, [a], { type: 'school' })
    if (pairs.length === 0) return { ok: true, data: [] }
    const money = await loadMoney([a])
    const ids = pairs.map(p => p.studentId)
    const { data: students, error } = await supabase
      .from('students')
      .select('id, full_name, class_node_id')
      .in('id', ids)
    if (error) return { ok: false, error: error.message }
    const classIds = [...new Set((students ?? []).map(x => x.class_node_id).filter(Boolean))] as string[]
    const classNames = new Map<string, string>()
    if (classIds.length) {
      const { data: nodes } = await supabase.from('class_nodes').select('id, name').in('id', classIds)
      for (const n of nodes ?? []) classNames.set(n.id as string, n.name as string)
    }
    const rows: CoverageRow[] = (students ?? []).map(st => {
      const k = `${a.id}|${st.id}`
      const exempt = money.exempt.has(k)
      const paid = money.paid.get(k) ?? 0
      const discount = money.discount.get(k) ?? 0
      const owed = exempt ? 0 : Math.max(0, a.amount - discount - paid)
      const credit = exempt ? paid : creditOf(a.amount, discount, paid)
      const status: CoverageRow['status'] =
        exempt ? 'exempt'
        : credit > 0 ? 'credit'
        : owed === 0 && discount >= a.amount ? 'waived'
        : owed === 0 ? 'paid'
        : paid > 0 ? 'part' : 'unpaid'
      return {
        studentId: st.id as string,
        name: st.full_name as string,
        className: st.class_node_id ? (classNames.get(st.class_node_id as string) ?? null) : null,
        discount, paid, exempt, owed, credit, status,
      }
    }).sort((x, y) => x.name.localeCompare(y.name))
    return { ok: true, data: rows }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Could not load who this fee covers' }
  }
}

/** Reverse one student's exemption on one assignment. */
export async function removeExemption(
  a: FeeAssignment, studentId: string,
): Promise<Result<void>> {
  const now = new Date().toISOString()
  const { error } = await supabase
    .from('fee_exemptions')
    .update({ voided_at: now })
    .eq('fee_assignment_id', a.id)
    .eq('student_id', studentId)
    .is('voided_at', null)
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: undefined }
}

/**
 * Edit an assignment's amount, due date and term. An amount change goes
 * through the logged path (so it shows in history and can be undone); date
 * and term are plain updates.
 */
export async function updateAssignmentDetails(params: {
  schoolId: string
  assignment: FeeAssignment
  amount: number
  dueDate: string | null
  termId: string | null
  reason: string
  staffId: string | null
}): Promise<Result<string>> {
  const { assignment: a } = params
  if (!(params.amount >= 0)) return { ok: false, error: 'Enter a valid amount.' }
  const changedAmount = params.amount !== a.amount
  if (changedAmount && params.reason.trim().length < 3) return { ok: false, error: 'Give a reason for changing the amount.' }

  if (changedAmount) {
    const res = await applyMassAction(
      { schoolId: params.schoolId, action: 'edit_amount', assignments: [a], scope: { type: 'school' }, amount: { mode: 'set', value: params.amount }, reason: params.reason },
      params.staffId,
    )
    if (!res.ok) return res
  }
  if ((params.dueDate ?? null) !== (a.due_date ?? null) || (params.termId ?? null) !== (a.term_id ?? null)) {
    const { error } = await supabase
      .from('fee_assignments')
      .update({ due_date: params.dueDate, term_id: params.termId, updated_at: new Date().toISOString() })
      .eq('id', a.id)
    if (error) return { ok: false, error: error.message }
  }
  return { ok: true, data: 'Saved.' }
}

export async function undoMassAction(logId: string, staffId: string | null): Promise<Result<string>> {
  try {
    const { data: row, error } = await supabase
      .from('fee_action_log')
      .select('id, action, details, undone_at')
      .eq('id', logId)
      .maybeSingle()
    if (error || !row) return { ok: false, error: error?.message ?? 'Action not found.' }
    if (row.undone_at) return { ok: false, error: 'This action was already undone.' }
    const now = new Date().toISOString()
    let message = 'Undone.'

    if (row.action === 'waive') {
      const { error: e } = await supabase.from('fee_discounts').update({ voided_at: now }).eq('action_id', logId).is('voided_at', null)
      if (e) return { ok: false, error: e.message }
    } else if (row.action === 'exempt') {
      const { error: e } = await supabase.from('fee_exemptions').update({ voided_at: now }).eq('action_id', logId).is('voided_at', null)
      if (e) return { ok: false, error: e.message }
    } else if (row.action === 'unassign') {
      const ids = (row.details?.assignmentIds ?? []) as string[]
      if (ids.length) {
        const { error: e } = await supabase.from('fee_assignments').update({ voided_at: null, voided_by: null }).in('id', ids)
        if (e) return { ok: false, error: e.message }
      }
    } else if (row.action === 'edit_amount') {
      const changes = (row.details?.changes ?? []) as Array<{ id: string; from: number; to: number }>
      let restored = 0, skipped = 0
      for (const c of changes) {
        // Only restore when the amount is still what this action set; if
        // someone edited it since, leave their newer change alone.
        const { data: upd, error: e } = await supabase
          .from('fee_assignments')
          .update({ amount: c.from, updated_at: now })
          .eq('id', c.id)
          .eq('amount', c.to)
          .select('id')
        if (e) return { ok: false, error: e.message }
        if (upd && upd.length > 0) restored += 1; else skipped += 1
      }
      message = skipped > 0
        ? `Restored ${restored}; skipped ${skipped} that were changed again since.`
        : `Restored ${restored} amount${restored === 1 ? '' : 's'}.`
    }

    await supabase.from('fee_action_log').update({ undone_at: now, undone_by: staffId }).eq('id', logId)
    return { ok: true, data: message }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Undo failed' }
  }
}
