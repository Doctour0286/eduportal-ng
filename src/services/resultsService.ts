/**
 * resultsService.ts
 * Data access layer for the Results module.
 * No browser-only APIs. No UI imports. React Native compatible.
 *
 * Read exports:
 *   loadCurrentSession()         — current session id + name + uses_terms flag
 *   loadTermsForSession()        — terms for session (empty if uses_terms=false)
 *   loadMyTeachingAssignments()  — subjects + classes this staff member is assigned to
 *   loadAllTeachingAssignments() — same but unrestricted (admin view)
 *   loadScoreComponents()        — CA components with weights, sorted
 *   loadStudentsForClass()       — active students in a class node, alpha
 *   loadScores()                 — all score rows for a class+subject+session(+term)
 *   loadGradeScale()             — grade bands for the school
 *   loadSubjectResults()         — weighted totals + grades from the computed view
 *
 * Write exports:
 *   saveScore()                  — upsert one score row; offline-queue aware
 *   approveScores()              — bulk approve: sets approved_by + approved_at
 *   unapproveScores()            — bulk un-approve: clears approved_by + approved_at
 *
 * Pure helpers:
 *   buildScoreMap()              — O(1) lookup map keyed by studentId+componentId
 *   computeWeightedTotal()       — weighted sum from score map
 *   getGradeLabel()              — resolve grade label from a weighted total
 *   todayDateString()            — local date string (React Native safe)
 */

import { supabase } from '../lib/supabase'
import { queueWrite, getQueue, clearFromQueue } from '../lib/offlineQueue'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Session {
  id: string
  name: string
  uses_terms: boolean   // from schools.uses_terms — joined through session
}

export interface Term {
  id: string
  name: string
  sequence: number
}

export interface TeachingAssignment {
  id: string
  staff_id: string
  subject_id: string
  subject_name: string
  class_node_id: string
  class_node_name: string
  class_path_label: string  // built client-side
  session_id: string
}

export interface ScoreComponent {
  id: string
  name: string
  weight_pct: number
  /** Tier 8 / Problem 8.4: teachers enter "out of max_score" directly
   *  (e.g. 16 out of 20); weighting normalizes value/max_score × weight_pct. */
  max_score: number
  sort_order: number
}

export interface Student {
  id: string
  full_name: string
  class_node_id: string
}

export interface Score {
  id: string
  student_id: string
  subject_id: string
  term_id: string | null
  session_id: string
  score_component_id: string
  value: number
  entered_by: string
  approved_by: string | null
  approved_at: string | null
}

export interface GradeBand {
  id: string
  min_score: number
  max_score: number
  grade_label: string
  remark: string | null
  sort_order: number
}

export interface SubjectResult {
  student_id: string
  subject_id: string
  term_id: string | null
  session_id: string
  weighted_total: number
  grade_label: string | null
  position_in_class: number
}

// Keyed by `${studentId}|${componentId}` — O(1) lookup in the score entry grid
export type ScoreMap = Map<string, Score>

// Result shape consistent with attendanceService / timetableService conventions
type Ok<T>    = { ok: true; data: T }
type Err      = { ok: false; error: string }
type Result<T> = Ok<T> | Err

// ─── Session ──────────────────────────────────────────────────────────────────

/**
 * Loads the current session AND the school's uses_terms flag.
 * Both are needed before anything else can render.
 */
export async function loadCurrentSession(): Promise<Result<Session>> {
  try {
    // Join schools through sessions — sessions has no direct uses_terms column;
    // uses_terms lives on the schools row. We pull it through the FK.
    const { data, error } = await supabase
      .from('sessions')
      .select(`
        id,
        name,
        schools ( uses_terms )
      `)
      .eq('is_current', true)
      .maybeSingle()

    if (error) return { ok: false, error: error.message }
    if (!data)  return { ok: false, error: 'No current session found. Set up a session in settings.' }

    return {
      ok: true,
      data: {
        id: data.id,
        name: data.name,
        uses_terms: (data.schools as any)?.uses_terms ?? false,
      },
    }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load session' }
  }
}

// ─── Terms ────────────────────────────────────────────────────────────────────

/**
 * Terms for the current session, sorted by sequence.
 * Returns an empty array if the school doesn't use terms —
 * callers should check Session.uses_terms before calling this.
 */
export async function loadTermsForSession(
  sessionId: string,
): Promise<Result<Term[]>> {
  try {
    const { data, error } = await supabase
      .from('terms')
      .select('id, name, sequence')
      .eq('session_id', sessionId)
      .order('sequence')

    if (error) return { ok: false, error: error.message }
    return {
      ok: true,
      data: (data ?? []).map((t: any) => ({
        id: t.id,
        name: t.name,
        sequence: t.sequence,
      })),
    }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load terms' }
  }
}

// ─── Teaching assignments ─────────────────────────────────────────────────────

/**
 * All teaching assignments for a specific staff member in the current session.
 * Used to populate the subject+class selector for a teacher entering scores.
 * RLS already scopes to the school; staff_id narrows to their own assignments.
 */
export async function loadMyTeachingAssignments(
  staffId: string,
  sessionId: string,
): Promise<Result<TeachingAssignment[]>> {
  return _loadAssignments({ staffId, sessionId })
}

/**
 * All teaching assignments in the school for the current session (admin view).
 * Same shape as loadMyTeachingAssignments — admin picks any assignment to review.
 */
export async function loadAllTeachingAssignments(
  sessionId: string,
): Promise<Result<TeachingAssignment[]>> {
  return _loadAssignments({ sessionId })
}

async function _loadAssignments(opts: {
  sessionId: string
  staffId?: string
}): Promise<Result<TeachingAssignment[]>> {
  try {
    let query = supabase
      .from('teaching_assignments')
      .select(`
        id,
        staff_id,
        subject_id,
        class_node_id,
        session_id,
        subjects ( name ),
        class_nodes ( name, parent_id )
      `)
      .eq('session_id', opts.sessionId)

    if (opts.staffId) {
      query = query.eq('staff_id', opts.staffId)
    }

    const { data, error } = await query.order('subject_id')

    if (error) return { ok: false, error: error.message }

    // Build flat list with path labels (parent · child)
    // For deeper trees this is a best-effort 2-level label —
    // sufficient for the selector; a full tree traversal is not needed.
    const rows = (data ?? []).map((r: any) => ({
      id: r.id,
      staff_id: r.staff_id,
      subject_id: r.subject_id,
      subject_name: r.subjects?.name ?? '',
      class_node_id: r.class_node_id,
      class_node_name: r.class_nodes?.name ?? '',
      class_path_label: r.class_nodes?.name ?? '',  // enriched below if parent data available
      session_id: r.session_id,
    })) as TeachingAssignment[]

    return { ok: true, data: rows }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load teaching assignments' }
  }
}

// ─── Score components ─────────────────────────────────────────────────────────
// Tier 8 / Problem 8.4: components are now PROFILE-scoped (per window, per
// class weighting) — the old school-wide loadScoreComponents() is gone.
// Resolution lives in assessmentService.resolveWindowForClass() +
// assessmentService.loadComponents(); ResultsModule wires them per selected
// class + term.

// ─── Students ─────────────────────────────────────────────────────────────────

/**
 * Active students enrolled in a class node, alpha order.
 * Identical to attendanceService.loadStudentsForClass() — duplicated here
 * so ResultsModule has a single import source.
 */
export async function loadStudentsForClass(
  classNodeId: string,
): Promise<Result<Student[]>> {
  try {
    const { data, error } = await supabase
      .from('students')
      .select('id, full_name, class_node_id')
      .eq('class_node_id', classNodeId)
      .eq('status', 'active')
      .order('full_name')

    if (error) return { ok: false, error: error.message }
    return { ok: true, data: (data ?? []) as Student[] }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load students' }
  }
}

// ─── Scores ───────────────────────────────────────────────────────────────────

/**
 * All score rows for a class + subject + session (+ optional term).
 *
 * Returns both approved and unapproved rows — the teacher sees everything
 * they've entered. The approval state is shown per-row in the UI.
 * Guardians never call this function — they use loadSubjectResults() which
 * reads the `subject_results` view (approved rows only).
 *
 * Filters via students!inner(class_node_id) to avoid a two-step query.
 * Same approach as attendanceService.loadAttendanceRecords() — same
 * fallback applies: if the Postgrest foreign-table filter fails against
 * the live schema, swap to loadStudentsForClass() + .in('student_id', ids).
 */
export async function loadScores(params: {
  classNodeId: string
  subjectId: string
  sessionId: string
  termId?: string | null
}): Promise<Result<Score[]>> {
  try {
    let query = supabase
      .from('scores')
      .select(`
        id,
        student_id,
        subject_id,
        term_id,
        session_id,
        score_component_id,
        value,
        entered_by,
        approved_by,
        approved_at,
        students!inner ( class_node_id )
      `)
      .eq('subject_id', params.subjectId)
      .eq('session_id', params.sessionId)
      .eq('students.class_node_id', params.classNodeId)

    if (params.termId) {
      query = query.eq('term_id', params.termId)
    } else {
      query = query.is('term_id', null)
    }

    const { data, error } = await query

    if (error) return { ok: false, error: error.message }

    const scores: Score[] = (data ?? []).map((r: any) => ({
      id: r.id,
      student_id: r.student_id,
      subject_id: r.subject_id,
      term_id: r.term_id ?? null,
      session_id: r.session_id,
      score_component_id: r.score_component_id,
      value: Number(r.value),
      entered_by: r.entered_by,
      approved_by: r.approved_by ?? null,
      approved_at: r.approved_at ?? null,
    }))

    return { ok: true, data: scores }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load scores' }
  }
}

// ─── Grade scale ──────────────────────────────────────────────────────────────

/**
 * Grade bands for the school, sorted by sort_order.
 * Used to resolve a weighted total → grade label in the UI
 * (mirrors what the subject_results view does server-side).
 */
export async function loadGradeScale(): Promise<Result<GradeBand[]>> {
  try {
    const { data, error } = await supabase
      .from('grade_scales')
      .select('id, min_score, max_score, grade_label, remark, sort_order')
      .order('sort_order')

    if (error) return { ok: false, error: error.message }
    return {
      ok: true,
      data: (data ?? []).map((g: any) => ({
        id: g.id,
        min_score: Number(g.min_score),
        max_score: Number(g.max_score),
        grade_label: g.grade_label,
        remark: g.remark ?? null,
        sort_order: g.sort_order,
      })),
    }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load grade scale' }
  }
}

// ─── Subject results (computed view) ─────────────────────────────────────────

/**
 * Reads the `subject_results` view — approved scores only, with
 * weighted totals, grade labels, and class positions computed by Postgres.
 *
 * Used for:
 *   - Admin approval review (are scores fully entered and looking correct?)
 *   - Guardian/student read view (they only ever see this view, never raw scores)
 *   - Report card generation input
 *
 * Note: position_in_class from this view is partitioned by school_id + subject_id
 * + term_id + class_node_id (via subquery in the view definition). It is correct
 * but only reflects approved scores — a partially-approved class will show skewed
 * positions. This is expected behaviour per the schema design.
 */
export async function loadSubjectResults(params: {
  classNodeId: string
  subjectId: string
  sessionId: string
  termId?: string | null
}): Promise<Result<SubjectResult[]>> {
  try {
    let query = supabase
      .from('subject_results')
      .select('student_id, subject_id, term_id, session_id, weighted_total, grade_label, position_in_class')
      .eq('subject_id', params.subjectId)
      .eq('session_id', params.sessionId)

    if (params.termId) {
      query = query.eq('term_id', params.termId)
    } else {
      query = query.is('term_id', null)
    }

    const { data, error } = await query

    if (error) return { ok: false, error: error.message }

    // subject_results doesn't have class_node_id directly — filter client-side
    // using the student IDs we already have from loadStudentsForClass().
    // Caller is expected to pass in studentIds for filtering if needed.
    // For simplicity we return all rows for subject+session and let the UI
    // cross-reference with the student list it already holds.
    return {
      ok: true,
      data: (data ?? []).map((r: any) => ({
        student_id: r.student_id,
        subject_id: r.subject_id,
        term_id: r.term_id ?? null,
        session_id: r.session_id,
        weighted_total: Number(r.weighted_total),
        grade_label: r.grade_label ?? null,
        position_in_class: Number(r.position_in_class),
      })),
    }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load subject results' }
  }
}

// ─── Write: single score ──────────────────────────────────────────────────────

export interface ScoreUpsertParams {
  schoolId: string
  studentId: string
  subjectId: string
  sessionId: string
  termId: string | null
  scoreComponentId: string
  value: number          // 0–100; component max is enforced in the UI, not the DB
  enteredBy: string      // staff.id
}

/**
 * Upserts a single score row.
 *
 * Optimistic-UI contract: caller updates local state immediately, calls this
 * in the background, reverts on error.
 *
 * The unique constraint is (school_id, student_id, subject_id, term_id,
 * score_component_id) — re-entering the same cell overwrites the previous value.
 *
 * Offline handling: network failures queue and return { ok: true, queued: true }.
 * RLS/constraint failures return { ok: false, error } so the UI can revert.
 *
 * Note: saving a score clears approved_at (a new value invalidates prior approval).
 * This is enforced by setting approved_by and approved_at to null in the payload.
 */
export async function saveScore(
  params: ScoreUpsertParams,
): Promise<{ ok: boolean; queued?: boolean; error?: string }> {
  const payload: Record<string, unknown> = {
    school_id:           params.schoolId,
    student_id:          params.studentId,
    subject_id:          params.subjectId,
    session_id:          params.sessionId,
    term_id:             params.termId,
    score_component_id:  params.scoreComponentId,
    value:               params.value,
    entered_by:          params.enteredBy,
    approved_by:         null,   // editing clears approval
    approved_at:         null,
  }

  try {
    const { error } = await supabase
      .from('scores')
      .upsert(payload, {
        onConflict: 'school_id,student_id,subject_id,term_id,score_component_id',
      })

    if (error) {
      if (isNetworkError(error.message)) {
        await queueWrite('scores', 'insert', payload)
        return { ok: true, queued: true }
      }
      return { ok: false, error: friendlyError(error.message) }
    }

    return { ok: true }
  } catch (err: any) {
    await queueWrite('scores', 'insert', payload)
    return { ok: true, queued: true }
  }
}

// ─── Write: approve / unapprove ───────────────────────────────────────────────

/**
 * Bulk-approves all scores for a class + subject + session (+ optional term).
 * Sets approved_by = staffId, approved_at = now() on every row in the set.
 *
 * Only rows that have a value (i.e. were actually entered) are approved.
 * This does NOT create missing rows — unentered cells stay null.
 *
 * Approval is admin-only in the UI; RLS on the scores table enforces this
 * via the `teaching_assignments` check (admin bypasses via role permission).
 */
export async function approveScores(params: {
  classNodeId: string
  subjectId: string
  sessionId: string
  termId: string | null
  approvedBy: string   // staff.id of approver
  studentIds: string[] // list of students in the class — used for the .in() filter
}): Promise<{ ok: boolean; error?: string }> {
  if (params.studentIds.length === 0) return { ok: true }

  try {
    let query = supabase
      .from('scores')
      .update({
        approved_by: params.approvedBy,
        approved_at: new Date().toISOString(),
      })
      .in('student_id', params.studentIds)
      .eq('subject_id', params.subjectId)
      .eq('session_id', params.sessionId)

    if (params.termId) {
      query = query.eq('term_id', params.termId)
    } else {
      query = query.is('term_id', null)
    }

    const { error } = await query

    if (error) return { ok: false, error: friendlyError(error.message) }
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to approve scores' }
  }
}

/**
 * Reverses a bulk approval — clears approved_by and approved_at.
 * Used when an admin needs to re-open a locked result set for corrections.
 */
export async function unapproveScores(params: {
  subjectId: string
  sessionId: string
  termId: string | null
  studentIds: string[]
}): Promise<{ ok: boolean; error?: string }> {
  if (params.studentIds.length === 0) return { ok: true }

  try {
    let query = supabase
      .from('scores')
      .update({ approved_by: null, approved_at: null })
      .in('student_id', params.studentIds)
      .eq('subject_id', params.subjectId)
      .eq('session_id', params.sessionId)

    if (params.termId) {
      query = query.eq('term_id', params.termId)
    } else {
      query = query.is('term_id', null)
    }

    const { error } = await query

    if (error) return { ok: false, error: friendlyError(error.message) }
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to un-approve scores' }
  }
}

// ─── Read pending (queued-but-unsynced) writes ─────────────────────────────

/**
 * Returns queued score writes for one subject/session/term scope, keyed the
 * same way as buildScoreMap() ("${studentId}|${scoreComponentId}").
 *
 * Same reasoning as attendanceService.getPendingAttendanceForDate(): a score
 * saved while offline never reaches the `scores` table until
 * flushScoresQueue() successfully runs — until then it only exists in the
 * local offline queue. loadScores() can't see it, so without this a score
 * entered offline shows correctly right up until the next reload, at which
 * point it silently disappears from the grid even though the write itself
 * is still safely queued and will sync once flushed.
 *
 * Filtered by subjectId/sessionId/termId (not classNodeId — the queued
 * payload has no class_node_id, since `scores` doesn't store one; loadScores()
 * only joins through `students` to filter by class). This is still the
 * correct scope: ResultsModule loads one subject+session+term at a time, and
 * a stray queued score for a different student in the same subject/term but
 * a different class would simply not match any row currently rendered in
 * the grid, so merging it in has no visible effect there.
 */
export async function getPendingScoresForScope(params: {
  subjectId: string
  sessionId: string
  termId: string | null
}): Promise<ScoreMap> {
  const pending = (await getQueue()).filter(item => item.table === 'scores')
  const map: ScoreMap = new Map()

  for (const item of pending) {
    const payload = item.payload as {
      student_id?: string
      subject_id?: string
      term_id?: string | null
      session_id?: string
      score_component_id?: string
      value?: number
      entered_by?: string
      approved_by?: string | null
      approved_at?: string | null
    }
    if (
      !payload.student_id ||
      !payload.score_component_id ||
      payload.subject_id !== params.subjectId ||
      payload.session_id !== params.sessionId ||
      (payload.term_id ?? null) !== params.termId
    ) {
      continue
    }

    map.set(`${payload.student_id}|${payload.score_component_id}`, {
      id: item.id, // no server id yet — the queue item's own id stands in
      student_id: payload.student_id,
      subject_id: payload.subject_id,
      term_id: payload.term_id ?? null,
      session_id: payload.session_id,
      score_component_id: payload.score_component_id,
      value: Number(payload.value ?? 0),
      entered_by: payload.entered_by ?? '',
      approved_by: payload.approved_by ?? null,
      approved_at: payload.approved_at ?? null,
    })
  }

  return map
}

// ─── Flush offline queue ──────────────────────────────────────────────────────

export async function flushScoresQueue(): Promise<{
  flushed: number
  failed: Array<{ payload: Record<string, unknown>; error: string }>
}> {
  const pending = (await getQueue()).filter(item => item.table === 'scores')
  let flushed = 0
  const failed: Array<{ payload: Record<string, unknown>; error: string }> = []

  for (const item of pending) {
    try {
      const { error } = await supabase
        .from('scores')
        .upsert(item.payload as Record<string, unknown>, {
          onConflict: 'school_id,student_id,subject_id,term_id,score_component_id',
        })

      if (error) {
        failed.push({ payload: item.payload, error: friendlyError(error.message) })
      } else {
        await clearFromQueue(item.id)
        flushed++
      }
    } catch {
      break  // still offline — stop and retry later
    }
  }

  return { flushed, failed }
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Indexes a flat list of Score objects into a Map for O(1) UI lookups.
 * Key: `${studentId}|${componentId}`
 */
export function buildScoreMap(scores: Score[]): ScoreMap {
  const map: ScoreMap = new Map()
  for (const s of scores) {
    map.set(`${s.student_id}|${s.score_component_id}`, s)
  }
  return map
}

/**
 * Computes a weighted total (out of 100) for one student from the score map.
 * Each component contributes value / max_score × weight_pct — so a 16/20 CA
 * worth 30% adds exactly 24. Returns null if the student has no scores at all.
 */
export function computeWeightedTotal(
  studentId: string,
  components: ScoreComponent[],
  scoreMap: ScoreMap,
): number | null {
  let total = 0
  let hasAny = false
  for (const comp of components) {
    const score = scoreMap.get(`${studentId}|${comp.id}`)
    if (score) {
      const max = comp.max_score > 0 ? comp.max_score : 100
      total += (score.value / max) * comp.weight_pct
      hasAny = true
    }
  }
  return hasAny ? total : null
}

/**
 * Resolves a weighted total to a grade label using the school's grade scale.
 * Returns null if no band matches or total is null.
 */
export function getGradeLabel(
  total: number | null,
  gradeBands: GradeBand[],
): string | null {
  if (total === null) return null
  for (const band of gradeBands) {
    if (total >= band.min_score && total <= band.max_score) {
      return band.grade_label
    }
  }
  return null
}

/**
 * Checks if every student in a list has all components entered.
 * Used to decide whether to show the "Approve" button as active.
 */
export function isScoreSetComplete(
  studentIds: string[],
  components: ScoreComponent[],
  scoreMap: ScoreMap,
): boolean {
  for (const studentId of studentIds) {
    for (const comp of components) {
      if (!scoreMap.has(`${studentId}|${comp.id}`)) return false
    }
  }
  return true
}

/**
 * Checks if any score for the given students is approved.
 * Used to decide whether to show Approve vs Un-approve.
 */
export function isAnyScoreApproved(
  studentIds: string[],
  components: ScoreComponent[],
  scoreMap: ScoreMap,
): boolean {
  for (const studentId of studentIds) {
    for (const comp of components) {
      const s = scoreMap.get(`${studentId}|${comp.id}`)
      if (s?.approved_at) return true
    }
  }
  return false
}

// ─── Internal utilities ───────────────────────────────────────────────────────

function isNetworkError(message: string): boolean {
  const lower = message.toLowerCase()
  return (
    lower.includes('failed to fetch') ||
    lower.includes('network') ||
    lower.includes('timeout') ||
    lower.includes('offline') ||
    lower.includes('econnrefused') ||
    lower.includes('load failed')
  )
}

function friendlyError(message: string): string {
  // Tier 8 window-gating trigger raises plain-English messages by design —
  // surface them verbatim instead of burying them under a generic line.
  if (message.includes('assessment window') || message.includes('Score entry for')) {
    return message
  }
  if (message.includes('violates row-level security')) {
    return "You don't have permission to enter scores for this subject or class."
  }
  if (message.includes('violates foreign key')) {
    return 'Student, subject, or component not found. Please refresh and try again.'
  }
  if (message.includes('violates unique constraint')) {
    return 'Score already exists. Please refresh and try again.'
  }
  return 'Failed to save score. Please try again.'
}
