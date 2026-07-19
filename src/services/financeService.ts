/**
 * financeService.ts
 * Data access layer for the Finance module.
 * No browser-only APIs. No UI imports. React Native compatible.
 *
 * Read exports:
 *   loadFeeHeads()               — all fee heads for the school
 *   loadSessions()               — all sessions (for selector)
 *   loadCurrentSession()         — the current session (is_current = true)
 *   loadTermsForSession()        — terms for a session (when uses_terms = true)
 *   loadFeeAssignments()         — fee assignments for a session/term, with fee head name
 *   loadStudentBalance()         — per-student fee summary: assigned, discounts, paid, balance
 *   loadStudentPayments()        — payment history for a student
 *   loadStudentDiscounts()       — discounts for a student in a session
 *   loadLeafClasses()            — leaf class nodes (for assignment target picker)
 *   loadProgrammeLevels()        — programme/level options, higher-ed (for assignment target picker)
 *
 * Write exports:
 *   createFeeHead()              — create a new fee head
 *   createFeeAssignment()        — assign a fee to school-wide / class / student
 *   recordPayment()              — record a cash/bank/card payment for a student
 *   createDiscount()             — apply a discount or waiver to a student's fee
 *
 * Pure helpers:
 *   formatNaira()                — format numeric(14,2) as ₦1,234.00
 *   todayDateString()            — local YYYY-MM-DD, React Native safe
 */

import { supabase } from '../lib/supabase'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FeeHead {
  id: string
  name: string
  is_recurring: boolean
  default_amount: number | null
  currency: string
}

export interface Session {
  id: string
  name: string
  is_current: boolean
  start_date: string
  end_date: string
}

export interface Term {
  id: string
  name: string
  sequence: number
}

export interface FeeAssignment {
  id: string
  fee_head_id: string
  fee_head_name: string
  session_id: string
  term_id: string | null
  target_type: 'school_wide' | 'class_node' | 'student' | 'programme_level'
  class_node_id: string | null
  class_node_name: string | null
  student_id: string | null
  student_name: string | null
  programme_id: string | null
  programme_name: string | null
  programme_level_id: string | null
  programme_level_label: string | null
  amount: number
  currency: string
  due_date: string | null
}

/**
 * Per-student fee balance summary.
 * All figures are in the same currency (NGN by default).
 * balance = assigned - discount_total - paid_total
 * A positive balance means the student still owes money.
 */
export interface StudentBalance {
  student_id: string
  student_name: string
  class_node_id: string | null
  class_path_label: string | null
  // Populated only for higher-ed students (resolved via their current
  // student_programme_placements row); null for secondary-school students,
  // mirroring how class_node_id/class_path_label are null for higher-ed ones.
  programme_level_id: string | null
  programme_level_label: string | null
  assigned_total: number    // sum of fee_assignments that apply to this student
  discount_total: number    // sum of approved fee_discounts
  paid_total: number        // sum of completed payments
  balance: number           // assigned - discount - paid
}

export interface Payment {
  id: string
  student_id: string
  fee_assignment_id: string | null
  fee_head_name: string | null
  amount: number
  currency: string
  method: string
  provider_reference: string | null
  status: 'pending' | 'completed' | 'failed' | 'refunded'
  received_by_name: string | null
  paid_at: string | null
  notes: string | null
}

export interface Discount {
  id: string
  student_id: string
  fee_assignment_id: string | null
  fee_head_name: string | null
  discount_type: 'percentage' | 'fixed_amount' | 'full_waiver'
  value: number | null
  reason: string | null
  approved_by_name: string | null
  created_at: string
  // resolved_amount computed client-side from fee assignment amount + discount_type + value
  resolved_amount: number | null
}

export interface ClassNode {
  id: string
  name: string
  parent_id: string | null
  sort_order: number
  path_label: string
}

// Payment methods a school can accept
export type PaymentMethod = 'cash' | 'bank_transfer' | 'card' | 'paystack' | 'flutterwave' | 'ussd' | 'remita'

// Consistent Result shape (same as all other service files)
type Ok<T>     = { ok: true; data: T }
type Err       = { ok: false; error: string }
type Result<T> = Ok<T> | Err

// ─── Load fee heads ───────────────────────────────────────────────────────────

export async function loadFeeHeads(): Promise<Result<FeeHead[]>> {
  try {
    const { data, error } = await supabase
      .from('fee_heads')
      .select('id, name, is_recurring, default_amount, currency')
      .order('name')

    if (error) return { ok: false, error: error.message }

    return {
      ok: true,
      data: (data ?? []).map((r: any) => ({
        id:             r.id,
        name:           r.name,
        is_recurring:   r.is_recurring,
        default_amount: r.default_amount ?? null,
        currency:       r.currency ?? 'NGN',
      })),
    }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load fee heads' }
  }
}

// ─── Load sessions ────────────────────────────────────────────────────────────

export async function loadSessions(): Promise<Result<Session[]>> {
  try {
    const { data, error } = await supabase
      .from('sessions')
      .select('id, name, is_current, start_date, end_date')
      .order('start_date', { ascending: false })

    if (error) return { ok: false, error: error.message }

    return {
      ok: true,
      data: (data ?? []).map((r: any) => ({
        id:         r.id,
        name:       r.name,
        is_current: r.is_current,
        start_date: r.start_date,
        end_date:   r.end_date,
      })),
    }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load sessions' }
  }
}

export async function loadCurrentSession(): Promise<Result<Session | null>> {
  try {
    const { data, error } = await supabase
      .from('sessions')
      .select('id, name, is_current, start_date, end_date')
      .eq('is_current', true)
      .maybeSingle()

    if (error) return { ok: false, error: error.message }
    if (!data)  return { ok: true, data: null }

    return {
      ok: true,
      data: {
        id:         data.id,
        name:       data.name,
        is_current: data.is_current,
        start_date: data.start_date,
        end_date:   data.end_date,
      },
    }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load current session' }
  }
}

// ─── Load terms for a session ──────────────────────────────────────────────────

export async function loadTermsForSession(sessionId: string): Promise<Result<Term[]>> {
  try {
    const { data, error } = await supabase
      .from('terms')
      .select('id, name, sequence')
      .eq('session_id', sessionId)
      .order('sequence')

    if (error) return { ok: false, error: error.message }

    return {
      ok: true,
      data: (data ?? []).map((r: any) => ({
        id:       r.id,
        name:     r.name,
        sequence: r.sequence,
      })),
    }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load terms' }
  }
}

// ─── Load fee assignments ──────────────────────────────────────────────────────

/**
 * Loads all fee assignments for a session (and optionally a term).
 * Joins fee_heads for name, class_nodes for name, students for name.
 * Returns them enriched with human-readable labels.
 */
export async function loadFeeAssignments(params: {
  sessionId: string
  termId?: string | null
}): Promise<Result<FeeAssignment[]>> {
  try {
    let query = supabase
      .from('fee_assignments')
      .select(`
        id,
        fee_head_id,
        session_id,
        term_id,
        target_type,
        class_node_id,
        student_id,
        programme_id,
        programme_level_id,
        amount,
        due_date,
        fee_heads ( name ),
        class_nodes ( name ),
        students ( full_name ),
        programmes ( name ),
        programme_levels ( level_label )
      `)
      .eq('session_id', params.sessionId)
      .order('created_at', { ascending: false })

    if (params.termId) {
      query = query.eq('term_id', params.termId)
    }

    const { data, error } = await query

    if (error) return { ok: false, error: error.message }

    return {
      ok: true,
      data: (data ?? []).map((r: any) => ({
        id:                     r.id,
        fee_head_id:            r.fee_head_id,
        fee_head_name:          r.fee_heads?.name ?? '—',
        session_id:             r.session_id,
        term_id:                r.term_id ?? null,
        target_type:            r.target_type,
        class_node_id:          r.class_node_id ?? null,
        class_node_name:        r.class_nodes?.name ?? null,
        student_id:             r.student_id ?? null,
        student_name:           r.students?.full_name ?? null,
        programme_id:           r.programme_id ?? null,
        programme_name:         r.programmes?.name ?? null,
        programme_level_id:     r.programme_level_id ?? null,
        programme_level_label:  r.programme_levels?.level_label ?? null,
        amount:                 Number(r.amount),
        currency:               'NGN',
        due_date:               r.due_date ?? null,
      })),
    }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load fee assignments' }
  }
}

// ─── Load student balance ─────────────────────────────────────────────────────

/**
 * Computes a fee balance summary for every active student in the school
 * (or a specific class if classNodeId is provided) for the given session.
 *
 * Algorithm (client-side, not a DB view):
 *   1. Load all active students (optionally filtered by class).
 *   2. Load all fee_assignments for the session that apply to each student:
 *      - target_type = 'school_wide': applies to all students
 *      - target_type = 'class_node' + matching class_node_id: applies to that class
 *      - target_type = 'student' + matching student_id: applies to that individual
 *   3. Load all fee_discounts for these students in this session.
 *   4. Load all completed payments for these students in this session.
 *   5. Compute per-student totals.
 *
 * This is deliberately a three-query approach rather than a complex single JOIN
 * because PostgREST doesn't support the multi-target-type logic cleanly,
 * and the volumes involved (hundreds of students, tens of fee rows) are trivial
 * for client-side aggregation.
 *
 * Limitation: this function returns all students; the caller should paginate or
 * filter the rendered list for large schools (>200 students).
 */
export async function loadStudentBalances(params: {
  sessionId: string
  classNodeId?: string | null
  classPathMap: Map<string, string>
  // Higher-ed params — mirrors studentsService.ts's loadStudents() SESSION 64
  // branch: class_node_id has no meaning for a higher-ed student, so this
  // function must resolve programme/level via student_programme_placements
  // instead when isHigherEd is true.
  isHigherEd?: boolean
  programmeLevelIds?: string[]
  programmeLevelLabelMap?: Map<string, string>
}): Promise<Result<StudentBalance[]>> {
  try {
    // Step 1: load students
    let studentQuery = supabase
      .from('students')
      .select('id, full_name, class_node_id')
      .eq('status', 'active')
      .order('full_name')

    if (!params.isHigherEd && params.classNodeId) {
      studentQuery = studentQuery.eq('class_node_id', params.classNodeId)
    }

    const { data: studentData, error: studentError } = await studentQuery
    if (studentError) return { ok: false, error: studentError.message }

    const students = (studentData ?? []) as Array<{
      id: string
      full_name: string
      class_node_id: string | null
    }>

    if (students.length === 0) {
      return { ok: true, data: [] }
    }

    const studentIds = students.map(s => s.id)

    // Step 1b (higher-ed only): resolve each student's current programme_level_id
    // via student_programme_placements (is_current = true). class_node_id is
    // meaningless for these students, mirroring studentsService.ts's own
    // isHigherEd branch (SESSION 64) exactly, not a second, diverging read.
    let placementByStudent = new Map<string, string>() // student_id -> programme_level_id
    if (params.isHigherEd) {
      let placementQuery = supabase
        .from('student_programme_placements')
        .select('student_id, programme_level_id')
        .eq('is_current', true)
        .in('student_id', studentIds)

      // Empty-array-means-no-filter Postgrest trap: only apply the
      // programme-level filter when a real, non-empty list was supplied —
      // same guard SESSION 64 already established for this exact trap.
      if (params.programmeLevelIds && params.programmeLevelIds.length > 0) {
        placementQuery = placementQuery.in('programme_level_id', params.programmeLevelIds)
      }

      const { data: placementData, error: placementError } = await placementQuery
      if (placementError) return { ok: false, error: placementError.message }

      for (const p of (placementData ?? []) as Array<{ student_id: string; programme_level_id: string }>) {
        placementByStudent.set(p.student_id, p.programme_level_id)
      }

      // If a programme/level filter was supplied, narrow the student set to
      // only those with a matching current placement — mirrors the
      // classNodeId filter's effect on the secondary-school path above,
      // since that filter had to happen at the students query and this one
      // can't (class_node_id isn't how a higher-ed student is scoped).
      if (params.programmeLevelIds && params.programmeLevelIds.length > 0) {
        const allowed = new Set(placementByStudent.keys())
        const filtered = students.filter(s => allowed.has(s.id))
        if (filtered.length === 0) return { ok: true, data: [] }
        // Replace in place so the rest of the function below is unaffected
        // by which branch produced the final student list.
        students.length = 0
        students.push(...filtered)
      }
    }

    // Step 2: load applicable fee assignments
    // We load all four target_type sets in one query and filter client-side
    const { data: assignmentData, error: assignmentError } = await supabase
      .from('fee_assignments')
      .select('id, target_type, class_node_id, student_id, programme_id, programme_level_id, amount')
      .eq('session_id', params.sessionId)

    if (assignmentError) return { ok: false, error: assignmentError.message }
    const assignments = (assignmentData ?? []) as Array<{
      id: string
      target_type: string
      class_node_id: string | null
      student_id: string | null
      programme_id: string | null
      programme_level_id: string | null
      amount: string
    }>

    // Step 3: load discounts for these students
    const { data: discountData, error: discountError } = await supabase
      .from('fee_discounts')
      .select('student_id, fee_assignment_id, discount_type, value')
      .in('student_id', studentIds)

    if (discountError) return { ok: false, error: discountError.message }
    const discounts = (discountData ?? []) as Array<{
      student_id: string
      fee_assignment_id: string | null
      discount_type: string
      value: string | null
    }>

    // Step 4: load completed payments for these students in this session date range
    // We join through session dates to scope payments — but payments don't have session_id,
    // so we scope by paid_at being within the session's date range. Simpler: just load all
    // payments for these students and let the UI show them — the balance view is always
    // "for this session's assignments" so we sum all payments against those assignments.
    const { data: paymentData, error: paymentError } = await supabase
      .from('payments')
      .select('student_id, fee_assignment_id, amount, status')
      .in('student_id', studentIds)
      .eq('status', 'completed')

    if (paymentError) return { ok: false, error: paymentError.message }
    const payments = (paymentData ?? []) as Array<{
      student_id: string
      fee_assignment_id: string | null
      amount: string
      status: string
    }>

    // Step 5: compute per-student totals
    const sessionAssignmentIds = new Set(assignments.map(a => a.id))

    const balances: StudentBalance[] = students.map(student => {
      const studentProgrammeLevelId = params.isHigherEd
        ? (placementByStudent.get(student.id) ?? null)
        : null

      // Assignments that apply to this student
      const applicable = assignments.filter(a => {
        if (a.target_type === 'school_wide') return true
        if (a.target_type === 'class_node' && a.class_node_id === student.class_node_id) return true
        if (a.target_type === 'student' && a.student_id === student.id) return true
        if (a.target_type === 'programme_level' &&
            studentProgrammeLevelId !== null &&
            a.programme_level_id === studentProgrammeLevelId) return true
        return false
      })
      const applicableIds = new Set(applicable.map(a => a.id))

      const assigned_total = applicable.reduce((sum, a) => sum + Number(a.amount), 0)

      // Discounts for this student scoped to applicable assignments
      const studentDiscounts = discounts.filter(
        d => d.student_id === student.id &&
             (!d.fee_assignment_id || applicableIds.has(d.fee_assignment_id))
      )
      const discount_total = studentDiscounts.reduce((sum, d) => {
        if (d.discount_type === 'full_waiver') {
          // Resolve full_waiver to the assignment amount
          const assignment = d.fee_assignment_id
            ? applicable.find(a => a.id === d.fee_assignment_id)
            : null
          return sum + (assignment ? Number(assignment.amount) : 0)
        }
        if (d.discount_type === 'fixed_amount') return sum + Number(d.value ?? 0)
        if (d.discount_type === 'percentage') {
          // Percentage discount: apply to linked assignment amount or total if unlinked
          const assignment = d.fee_assignment_id
            ? applicable.find(a => a.id === d.fee_assignment_id)
            : null
          const base = assignment ? Number(assignment.amount) : assigned_total
          return sum + (base * Number(d.value ?? 0)) / 100
        }
        return sum
      }, 0)

      // Payments for this student scoped to applicable assignments (or unscoped)
      const paid_total = payments
        .filter(p => p.student_id === student.id &&
                     (!p.fee_assignment_id || sessionAssignmentIds.has(p.fee_assignment_id)))
        .reduce((sum, p) => sum + Number(p.amount), 0)

      const balance = Math.max(0, assigned_total - discount_total - paid_total)

      return {
        student_id:            student.id,
        student_name:          student.full_name,
        class_node_id:         params.isHigherEd ? null : student.class_node_id,
        class_path_label:      params.isHigherEd
          ? null
          : (student.class_node_id ? (params.classPathMap.get(student.class_node_id) ?? null) : null),
        programme_level_id:    studentProgrammeLevelId,
        programme_level_label: studentProgrammeLevelId
          ? (params.programmeLevelLabelMap?.get(studentProgrammeLevelId) ?? null)
          : null,
        assigned_total,
        discount_total,
        paid_total,
        balance,
      }
    })

    return { ok: true, data: balances }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load student balances' }
  }
}

// ─── Load payment history for a student ───────────────────────────────────────

export async function loadStudentPayments(
  studentId: string,
): Promise<Result<Payment[]>> {
  try {
    const { data, error } = await supabase
      .from('payments')
      .select(`
        id,
        student_id,
        fee_assignment_id,
        amount,
        currency,
        method,
        provider_reference,
        status,
        paid_at,
        created_at,
        notes,
        fee_assignments ( fee_heads ( name ) ),
        staff ( full_name )
      `)
      .eq('student_id', studentId)
      .order('created_at', { ascending: false })

    if (error) return { ok: false, error: error.message }

    return {
      ok: true,
      data: (data ?? []).map((r: any) => ({
        id:                 r.id,
        student_id:         r.student_id,
        fee_assignment_id:  r.fee_assignment_id ?? null,
        fee_head_name:      r.fee_assignments?.fee_heads?.name ?? null,
        amount:             Number(r.amount),
        currency:           r.currency ?? 'NGN',
        method:             r.method,
        provider_reference: r.provider_reference ?? null,
        status:             r.status,
        received_by_name:   r.staff?.full_name ?? null,
        paid_at:            r.paid_at,
        notes:              r.notes ?? null,
      })),
    }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load payments' }
  }
}

// ─── Load discounts for a student in a session ────────────────────────────────

export async function loadStudentDiscounts(
  studentId: string,
  _sessionId: string,
): Promise<Result<Discount[]>> {
  try {
    // Load discounts joined to fee_assignments scoped to this session
    const { data, error } = await supabase
      .from('fee_discounts')
      .select(`
        id,
        student_id,
        fee_assignment_id,
        discount_type,
        value,
        reason,
        created_at,
        fee_assignments ( amount, fee_heads ( name ) ),
        staff ( full_name )
      `)
      .eq('student_id', studentId)

    if (error) return { ok: false, error: error.message }

    // Filter to assignments belonging to this session (no direct session_id on fee_discounts)
    // We accept all discounts where fee_assignment is null or belongs to a session assignment.
    // The UI will show all discounts for this student — the session filter is advisory.
    return {
      ok: true,
      data: (data ?? []).map((r: any) => {
        const assignmentAmount = r.fee_assignments?.amount
          ? Number(r.fee_assignments.amount)
          : null

        let resolved_amount: number | null = null
        if (r.discount_type === 'full_waiver' && assignmentAmount !== null) {
          resolved_amount = assignmentAmount
        } else if (r.discount_type === 'fixed_amount') {
          resolved_amount = Number(r.value ?? 0)
        } else if (r.discount_type === 'percentage' && assignmentAmount !== null) {
          resolved_amount = (assignmentAmount * Number(r.value ?? 0)) / 100
        }

        return {
          id:                r.id,
          student_id:        r.student_id,
          fee_assignment_id: r.fee_assignment_id ?? null,
          fee_head_name:     r.fee_assignments?.fee_heads?.name ?? null,
          discount_type:     r.discount_type,
          value:             r.value !== null ? Number(r.value) : null,
          reason:            r.reason ?? null,
          approved_by_name:  r.staff?.full_name ?? null,
          created_at:        r.created_at,
          resolved_amount,
        }
      }),
    }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load discounts' }
  }
}

// ─── Load leaf classes (for assignment picker) ────────────────────────────────

export async function loadLeafClasses(): Promise<Result<ClassNode[]>> {
  try {
    const { data, error } = await supabase
      .from('class_nodes')
      .select('id, name, parent_id, sort_order, is_leaf_enrollable')
      .order('sort_order')

    if (error) return { ok: false, error: error.message }

    const all = (data ?? []) as Array<{
      id: string
      name: string
      parent_id: string | null
      sort_order: number
      is_leaf_enrollable: boolean
    }>

    const nameMap = new Map<string, string>(all.map(n => [n.id, n.name]))

    const leaves: ClassNode[] = all
      .filter(n => n.is_leaf_enrollable)
      .map(n => ({
        id:         n.id,
        name:       n.name,
        parent_id:  n.parent_id,
        sort_order: n.sort_order,
        path_label: n.parent_id
          ? `${nameMap.get(n.parent_id) ?? ''} · ${n.name}`
          : n.name,
      }))

    return { ok: true, data: leaves }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load classes' }
  }
}

// ─── Load programme levels (for higher-ed assignment picker) ─────────────────

export interface ProgrammeLevelOption {
  id: string                  // programme_levels.id
  programme_id: string
  programme_name: string
  level_label: string
  sequence_order: number
  path_label: string          // "<Programme name> · <Level label>", mirrors ClassNode.path_label
}

/**
 * All programme levels across every programme in the school, flattened for
 * the fee-assignment target picker — mirrors loadLeafClasses()'s shape so
 * FinanceModule.tsx's picker UI can follow the same list/search/empty-state
 * pattern already established for the class picker, per this project's own
 * "extend the existing peer, don't invent a second shape" discipline.
 */
export async function loadProgrammeLevels(): Promise<Result<ProgrammeLevelOption[]>> {
  try {
    const { data, error } = await supabase
      .from('programme_levels')
      .select(`
        id,
        programme_id,
        level_label,
        sequence_order,
        programmes ( name )
      `)
      .order('sequence_order')

    if (error) return { ok: false, error: error.message }

    const levels: ProgrammeLevelOption[] = (data ?? []).map((r: any) => ({
      id:             r.id,
      programme_id:   r.programme_id,
      programme_name: r.programmes?.name ?? '—',
      level_label:    r.level_label,
      sequence_order: r.sequence_order,
      path_label:     `${r.programmes?.name ?? '—'} · ${r.level_label}`,
    }))

    return { ok: true, data: levels }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load programme levels' }
  }
}

// ─── Write: create fee head ───────────────────────────────────────────────────

export async function createFeeHead(params: {
  schoolId: string
  name: string
  is_recurring: boolean
  default_amount: number | null
}): Promise<Result<{ id: string }>> {
  try {
    const { data, error } = await supabase
      .from('fee_heads')
      .insert({
        school_id:      params.schoolId,
        name:           params.name.trim(),
        is_recurring:   params.is_recurring,
        default_amount: params.default_amount ?? null,
        currency:       'NGN',
      })
      .select('id')
      .single()

    if (error) return { ok: false, error: friendlyFeeHeadError(error.message) }
    return { ok: true, data: { id: data.id } }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to create fee head' }
  }
}

// ─── Write: update fee head ────────────────────────────────────────────────────

export async function updateFeeHead(params: {
  id: string
  name: string
  is_recurring: boolean
  default_amount: number | null
}): Promise<Result<void>> {
  try {
    const { error } = await supabase
      .from('fee_heads')
      .update({
        name:           params.name.trim(),
        is_recurring:   params.is_recurring,
        default_amount: params.default_amount ?? null,
      })
      .eq('id', params.id)

    if (error) return { ok: false, error: friendlyFeeHeadError(error.message) }
    return { ok: true, data: undefined }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to update fee head' }
  }
}



export async function createFeeAssignment(params: {
  schoolId: string
  fee_head_id: string
  session_id: string
  term_id: string | null
  target_type: 'school_wide' | 'class_node' | 'student' | 'programme_level'
  class_node_id: string | null
  student_id: string | null
  programme_id: string | null
  programme_level_id: string | null
  amount: number
  due_date: string | null
}): Promise<Result<{ id: string }>> {
  try {
    const { data, error } = await supabase
      .from('fee_assignments')
      .insert({
        school_id:           params.schoolId,
        fee_head_id:         params.fee_head_id,
        session_id:          params.session_id,
        term_id:             params.term_id ?? null,
        target_type:         params.target_type,
        class_node_id:       params.class_node_id ?? null,
        student_id:          params.student_id ?? null,
        programme_id:        params.programme_id ?? null,
        programme_level_id:  params.programme_level_id ?? null,
        amount:              params.amount,
        due_date:            params.due_date ?? null,
      })
      .select('id')
      .single()

    if (error) return { ok: false, error: friendlyAssignmentError(error.message) }
    return { ok: true, data: { id: data.id } }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to create fee assignment' }
  }
}

// ─── Write: record payment ────────────────────────────────────────────────────

/**
 * Records a manual payment (cash, bank transfer, card).
 *
 * For online payment providers (Paystack, Flutterwave), the payment row is
 * created server-side by the provider webhook — not here. This function is
 * for staff recording offline payments.
 *
 * `received_by` is the staff member recording the payment — sourced from the
 * auth session on the server side via RLS, but we pass it explicitly here so
 * the service doesn't need to import useAuthStore (no UI deps in service layer).
 */
export async function recordPayment(params: {
  schoolId: string
  studentId: string
  feeAssignmentId: string | null
  amount: number
  method: PaymentMethod
  authUserId: string           // auth.users.id from the session — we resolve staff.id ourselves
  paidAt: string               // ISO datetime string
  providerReference?: string
  notes?: string | null
}): Promise<Result<{ id: string }>> {
  try {
    // Resolve the staff.id for received_by.
    // payments.received_by is a FK to staff.id, NOT auth.users.id.
    // We look up the actor_record_id in app_identities using the auth user's id.
    let staffId: string | null = null
    if (params.authUserId) {
      const { data: identity } = await supabase
        .from('app_identities')
        .select('actor_record_id, actor_type')
        .eq('auth_user_id', params.authUserId)
        .maybeSingle()
      if (identity?.actor_type === 'staff') {
        staffId = identity.actor_record_id
      }
      // platform_admin won't have a staff row — leave staffId null (column is nullable)
    }

    const { data, error } = await supabase
      .from('payments')
      .insert({
        school_id:          params.schoolId,
        student_id:         params.studentId,
        fee_assignment_id:  params.feeAssignmentId ?? null,
        amount:             params.amount,
        currency:           'NGN',
        method:             params.method,
        provider_reference: params.providerReference ?? null,
        status:             'completed',
        received_by:        staffId,
        paid_at:            params.paidAt,
        notes:              params.notes?.trim() || null,
      })
      .select('id')
      .single()

    if (error) return { ok: false, error: friendlyPaymentError(error.message) }
    return { ok: true, data: { id: data.id } }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to record payment' }
  }
}

// ─── Write: create discount / waiver ─────────────────────────────────────────

/**
 * Applies a discount or full waiver to a student's fee assignment.
 *
 * `approved_by` is required by the schema (not null). The UI must confirm the
 * logged-in staff member is the approver — pass their staff.id.
 *
 * For full_waiver: value is null (the waiver amount is derived from the
 * fee_assignment.amount at read time).
 * For percentage: value is 0–100.
 * For fixed_amount: value is the discount amount in NGN.
 */
export async function createDiscount(params: {
  schoolId: string
  studentId: string
  feeAssignmentId: string | null
  discountType: 'percentage' | 'fixed_amount' | 'full_waiver'
  value: number | null
  reason: string | null
  authUserId: string           // auth.users.id — we resolve staff.id ourselves
}): Promise<Result<{ id: string }>> {
  try {
    // Resolve staff.id for approved_by (required, not null).
    // fee_discounts.approved_by is a FK to staff.id, NOT auth.users.id.
    let staffId: string | null = null
    if (params.authUserId) {
      const { data: identity } = await supabase
        .from('app_identities')
        .select('actor_record_id, actor_type')
        .eq('auth_user_id', params.authUserId)
        .maybeSingle()
      if (identity?.actor_type === 'staff') {
        staffId = identity.actor_record_id
      }
    }
    if (!staffId) {
      return { ok: false, error: "Could not identify staff member. Only staff can approve discounts." }
    }

    const { data, error } = await supabase
      .from('fee_discounts')
      .insert({
        school_id:        params.schoolId,
        student_id:       params.studentId,
        fee_assignment_id: params.feeAssignmentId ?? null,
        discount_type:    params.discountType,
        value:            params.value ?? null,
        reason:           params.reason?.trim() || null,
        approved_by:      staffId,
      })
      .select('id')
      .single()

    if (error) return { ok: false, error: friendlyDiscountError(error.message) }
    return { ok: true, data: { id: data.id } }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to apply discount' }
  }
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Formats a numeric value as Nigerian Naira.
 * e.g. 15000 → "₦15,000.00"
 */
export function formatNaira(amount: number): string {
  return '₦' + amount.toLocaleString('en-NG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

/**
 * Builds an O(1) map of classNodeId → path_label.
 */
export function buildClassPathMap(classes: ClassNode[]): Map<string, string> {
  return new Map(classes.map(c => [c.id, c.path_label]))
}

/**
 * Returns today's date as a local ISO string (YYYY-MM-DD).
 * React Native safe — no window/navigator.
 */
export function todayDateString(): string {
  const d = new Date()
  const yyyy = d.getFullYear()
  const mm   = String(d.getMonth() + 1).padStart(2, '0')
  const dd   = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

/**
 * Returns a human-readable label for a payment method.
 */
export function methodLabel(method: string): string {
  switch (method) {
    case 'cash':          return 'Cash'
    case 'bank_transfer': return 'Bank transfer'
    case 'card':          return 'Card'
    case 'paystack':      return 'Paystack'
    case 'flutterwave':   return 'Flutterwave'
    case 'ussd':          return 'USSD'
    default:              return method
  }
}

/**
 * Returns a human-readable label for a discount type.
 */
export function discountTypeLabel(type: string): string {
  switch (type) {
    case 'percentage':    return 'Percentage'
    case 'fixed_amount':  return 'Fixed amount'
    case 'full_waiver':   return 'Full waiver'
    default:              return type
  }
}

// ─── Internal error helpers ────────────────────────────────────────────────────

function friendlyFeeHeadError(message: string): string {
  if (message.includes('unique') || message.includes('duplicate')) {
    return 'A fee head with this name already exists.'
  }
  if (message.includes('violates row-level security')) {
    return "You don't have permission to manage fee heads."
  }
  return `Failed to save fee head: ${message}`
}

function friendlyAssignmentError(message: string): string {
  if (message.includes('violates row-level security')) {
    return "You don't have permission to create fee assignments."
  }
  if (message.includes('violates foreign key')) {
    return 'The selected fee head, session, or class no longer exists. Please refresh and try again.'
  }
  if (message.includes('fee_assignments_target_type_check')) {
    return 'Select the class, student, or programme/level that matches the assignment type chosen.'
  }
  return `Failed to create fee assignment: ${message}`
}

function friendlyPaymentError(message: string): string {
  if (message.includes('violates row-level security')) {
    return "You don't have permission to record payments."
  }
  if (message.includes('violates foreign key')) {
    return 'The student or fee assignment no longer exists. Please refresh and try again.'
  }
  return `Failed to record payment: ${message}`
}

function friendlyDiscountError(message: string): string {
  if (message.includes('violates row-level security')) {
    return "You don't have permission to apply discounts."
  }
  return `Failed to apply discount: ${message}`
}
