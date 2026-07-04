/**
 * portalService.ts
 * Data-access layer for the Guardian/Student portal (§10 Phase 6 — Guardian/student portal).
 *
 * Read-only by design — this service contains no write functions. The portal's entire
 * purpose is §4.9: results, attendance, fees, announcements, and calendar, all scoped
 * to the signed-in guardian's linked children (or the student's own record), with context
 * on every figure (never an isolated number).
 *
 * Identity resolution follows the same app_identities pattern used by every other
 * service in this project (financeService.recordPayment, hrService.reviewLeaveRequest,
 * announcementsService.createAnnouncement) — resolve actor_record_id once, then scope
 * every subsequent query through it.
 *
 * No browser-only APIs — React Native safe per §5.1.
 */

import { supabase } from '../lib/supabase'
import { getSchoolDayMap, countSchoolDaysInRange, getEffectiveTermEndDate } from './attendanceService'

/**
 * Unwraps a PostgREST embedded relation, whether it comes back as a single
 * object, an array, or null/undefined. This file previously assumed every
 * embed "always returns an array from PostgREST even for a single FK" (a
 * pattern borrowed from libraryService.ts's Session 21 fix) and cast
 * accordingly with `as unknown as {...}[] | null)?.[0]` at five separate call
 * sites. That assumption turned out to be wrong for at least one of them —
 * confirmed via a live debug log (PRD Session 15, item 4): fee_assignments'
 * `fee_heads ( name )` embed came back as a plain object (`{ name: "PTA" }`),
 * not `[{ name: "PTA" }]`, so `?.[0]` silently resolved to `undefined` and
 * every fee-head name fell through to the 'Fee' fallback. Rather than assume
 * the other four sites are safe just because they hadn't been reported as
 * broken, all five now go through this one shape-agnostic unwrap instead of
 * repeating (or half-fixing) the same fragile assumption.
 */
function unwrapEmbed<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null
  if (Array.isArray(value)) return (value[0] as T) ?? null
  return value as T
}

// ─── Types ─────────────────────────────────────────────────────────────────

export interface PortalChild {
  id: string
  full_name: string
  gender: string | null
  date_of_birth: string | null
  class_node_id: string | null
  class_path_label: string
  status: string
}

export interface PortalSession {
  id: string
  name: string
  start_date: string
  end_date: string
}

export interface PortalTerm {
  id: string
  name: string
  sequence: number
  start_date: string
  end_date: string
}

/**
 * Term/session progress — Session 29 (PRD Problem 6.7), surfaced read-only to
 * guardians/students. Mirrors exactly what the admin Settings screen shows
 * (SettingsModule.tsx's CalendarTab), reusing the same
 * attendanceService.getEffectiveTermEndDate() rather than a second
 * implementation, so a parent and an admin never see two different "days
 * remaining" numbers for the same term.
 *
 * scopeLabel/scopeStartDate/scopeEndDate describe whichever the school
 * actually uses — the current term when uses_terms is true, otherwise the
 * whole session. effectiveEndDate may be later than baseEndDate when one or
 * more school-day calendar entries in range are marked extends_term=true;
 * equal to it otherwise (no reload needed to reflect an admin's edit next
 * time this is called).
 */
export interface TermProgress {
  scopeLabel: string
  scopeStartDate: string
  baseEndDate: string
  effectiveEndDate: string
  totalDays: number
  elapsedDays: number
  remainingDays: number
  percentElapsed: number // 0–100, clamped, based on today vs [scopeStartDate, effectiveEndDate]
  isExtended: boolean
}

export interface AttendanceSummary {
  present: number
  absent: number
  late: number
  excused: number
  totalMarkable: number // present + absent + late (excused is not counted against the student)
  totalSchoolDays: number // real calendar-aware school-day count in range (school_calendar_days
                           // overrides, falling back to school_week_days) — NOT just dates that
                           // happen to have a record, so a day the teacher forgot to mark still
                           // counts against the denominator instead of silently vanishing from it
  percent: number | null // null when there is nothing to compute yet
  classAveragePercent: number | null // this child's class-wide average % presence over the same
                                      // range, for "how does this compare" context (§4.4/§4.9) —
                                      // null when the child has no class_node_id or the class has
                                      // no markable days yet
}

export interface AttendanceDay {
  date: string
  status: 'present' | 'absent' | 'late' | 'excused' | 'unmarked' | 'no_school'
}

export interface ResultComponentScore {
  component_name: string
  weight_pct: number
  value: number
}

export interface SubjectResultRow {
  subject_id: string
  subject_name: string
  components: ResultComponentScore[]
  weighted_total: number | null
  grade_label: string | null
  position_in_class: number | null
  class_size: number | null
}

export interface FeeHeadBreakdown {
  fee_head_id: string
  fee_head_name: string
  billed: number
  discount: number
  paid: number
  balance: number
}

export interface FeeSummary {
  totalBilled: number
  totalDiscount: number
  totalPaid: number
  balance: number
  breakdown: FeeHeadBreakdown[]
}

export interface PaymentHistoryRow {
  id: string
  amount: number
  method: string
  paid_at: string
  notes: string | null
  fee_head_name: string | null
}

export interface PortalAnnouncement {
  id: string
  title: string
  body: string
  posted_at: string
  expires_at: string | null
  is_expired: boolean
}

// ─── Identity resolution ───────────────────────────────────────────────────

/**
 * Resolves the signed-in auth user to either:
 *  - a guardian and their linked children (actor_type = 'guardian'), or
 *  - a single student record representing the signed-in student themself (actor_type = 'student')
 *
 * Mirrors the same app_identities lookup pattern used across every other service
 * in this project (financeService.recordPayment, hrService.reviewLeaveRequest, etc).
 *
 * Also resolves the signed-in person's own display name (`selfName`) — needed for
 * the portal's greeting header (PRD Session 15, item 1: "boldly greeting the
 * Guardian by first name just like in Teacher's and Admin's dashboards"). For a
 * student-self login this is just the child's own `full_name` (they're the same
 * person); for a guardian, `guardians.full_name` was never previously fetched
 * anywhere in this file, so it's a new read here — the guardian's own name is not
 * the same thing as any child's name and can't be derived from `PortalChild`.
 */
export async function loadPortalIdentity(
  authUserId: string,
  schoolId: string
): Promise<
  | { kind: 'guardian'; guardianId: string; selfName: string; children: PortalChild[] }
  | { kind: 'student'; child: PortalChild }
  | { kind: 'none' }
> {
  const { data: identity, error: identityErr } = await supabase
    .from('app_identities')
    .select('actor_type, actor_record_id')
    .eq('auth_user_id', authUserId)
    .eq('school_id', schoolId)
    .maybeSingle()

  if (identityErr || !identity) return { kind: 'none' }

  if (identity.actor_type === 'student') {
    const child = await loadChildRecord(identity.actor_record_id)
    if (!child) return { kind: 'none' }
    return { kind: 'student', child }
  }

  if (identity.actor_type === 'guardian') {
    const guardianId = identity.actor_record_id
    const { data: guardianRow } = await supabase
      .from('guardians')
      .select('full_name')
      .eq('id', guardianId)
      .maybeSingle()

    const { data: links, error: linksErr } = await supabase
      .from('student_guardians')
      .select('student_id')
      .eq('guardian_id', guardianId)
      .eq('school_id', schoolId)

    if (linksErr || !links || links.length === 0) {
      return { kind: 'guardian', guardianId, selfName: guardianRow?.full_name ?? '', children: [] }
    }

    const children = await Promise.all(
      links.map((l) => loadChildRecord(l.student_id))
    )
    return {
      kind: 'guardian',
      guardianId,
      selfName: guardianRow?.full_name ?? '',
      children: children.filter((c): c is PortalChild => c !== null),
    }
  }

  return { kind: 'none' }
}

async function loadChildRecord(studentId: string): Promise<PortalChild | null> {
  const { data, error } = await supabase
    .from('students')
    .select(
      `
      id, full_name, gender, date_of_birth, status, class_node_id,
      class_nodes ( id, name, parent_id )
    `
    )
    .eq('id', studentId)
    .maybeSingle()

  if (error || !data) return null

  // Shape-agnostic unwrap — see unwrapEmbed()'s own doc comment for why this
  // file no longer assumes every embed is always an array.
  const node = unwrapEmbed<{ id: string; name: string; parent_id: string | null }>(data.class_nodes)

  return {
    id: data.id,
    full_name: data.full_name,
    gender: data.gender,
    date_of_birth: data.date_of_birth,
    class_node_id: data.class_node_id,
    class_path_label: node?.name ?? 'Unassigned',
    status: data.status,
  }
}

// ─── Calendar ───────────────────────────────────────────────────────────────

export async function loadCurrentSession(schoolId: string): Promise<PortalSession | null> {
  const { data } = await supabase
    .from('sessions')
    .select('id, name, start_date, end_date')
    .eq('school_id', schoolId)
    .eq('is_current', true)
    .maybeSingle()
  return data ?? null
}

export async function loadTermsForSession(sessionId: string): Promise<PortalTerm[]> {
  const { data } = await supabase
    .from('terms')
    .select('id, name, sequence, start_date, end_date')
    .eq('session_id', sessionId)
    .order('sequence', { ascending: true })
  return data ?? []
}

export async function loadSchoolUsesTerms(schoolId: string): Promise<boolean> {
  const { data } = await supabase
    .from('schools')
    .select('uses_terms')
    .eq('id', schoolId)
    .maybeSingle()
  return data?.uses_terms ?? true
}

/**
 * Resolves the school's current term-or-session progress for the guardian
 * portal's term-progress card. Picks whichever term's [start_date, end_date]
 * actually contains today (falls back to the last term if today is past
 * every term's base end date, so a school that hasn't yet added next term's
 * dates doesn't just show nothing); when uses_terms is false, uses the
 * current session directly. Returns null when there's no current session at
 * all (nothing sensible to show) or the resolved scope's own dates are
 * missing/invalid.
 */
export async function loadTermProgress(schoolId: string): Promise<TermProgress | null> {
  const session = await loadCurrentSession(schoolId)
  if (!session) return null

  const usesTerms = await loadSchoolUsesTerms(schoolId)
  const today = todayDateString()

  let scopeLabel: string
  let scopeStartDate: string
  let baseEndDate: string

  if (usesTerms) {
    const terms = await loadTermsForSession(session.id)
    if (terms.length === 0) {
      // uses_terms is on but no terms exist yet for this session — fall back
      // to the session itself rather than returning null, so the card still
      // shows something sensible instead of silently disappearing.
      scopeLabel = session.name
      scopeStartDate = session.start_date
      baseEndDate = session.end_date
    } else {
      const current = terms.find(t => today >= t.start_date && today <= t.end_date)
      const chosen = current ?? terms[terms.length - 1]
      scopeLabel = chosen.name
      scopeStartDate = chosen.start_date
      baseEndDate = chosen.end_date
    }
  } else {
    scopeLabel = session.name
    scopeStartDate = session.start_date
    baseEndDate = session.end_date
  }

  if (!scopeStartDate || !baseEndDate) return null

  const effectiveRes = await getEffectiveTermEndDate(scopeStartDate, baseEndDate, schoolId)
  const effectiveEndDate = effectiveRes.ok ? effectiveRes.data : baseEndDate

  const start = new Date(scopeStartDate + 'T00:00:00')
  const effectiveEnd = new Date(effectiveEndDate + 'T00:00:00')
  const now = new Date(today + 'T00:00:00')

  const msPerDay = 24 * 60 * 60 * 1000
  const totalDays = Math.max(1, Math.round((effectiveEnd.getTime() - start.getTime()) / msPerDay) + 1)
  const rawElapsed = Math.round((now.getTime() - start.getTime()) / msPerDay) + 1
  const elapsedDays = Math.min(totalDays, Math.max(0, rawElapsed))
  const remainingDays = Math.max(0, totalDays - elapsedDays)
  const percentElapsed = Math.min(100, Math.max(0, Math.round((elapsedDays / totalDays) * 100)))

  return {
    scopeLabel,
    scopeStartDate,
    baseEndDate,
    effectiveEndDate,
    totalDays,
    elapsedDays,
    remainingDays,
    percentElapsed,
    isExtended: effectiveEndDate !== baseEndDate,
  }
}

// ─── Attendance (§4.9 — percentage, count relative to total, calendar strip) ──

/**
 * Returns the child's attendance summary for a date range (default: current session)
 * plus the school-wide total number of days that had any attendance recorded at all
 * (the denominator parents need for "out of 45 school days" context — §4.4).
 *
 * One row per (school, student, date) is a real, DB-enforced constraint
 * (added 2026-07-03, owner decision — per-period marking removed entirely
 * after being confirmed unused across every class in this school and
 * confirmed as the root cause of a real duplicate-row data-integrity bug).
 * No collapsing/dedup needed here — each row already is one day's status.
 */
export async function loadAttendanceSummary(
  schoolId: string,
  studentId: string,
  startDate: string,
  endDate: string
): Promise<AttendanceSummary> {
  const { data: studentRow } = await supabase
    .from('students')
    .select('class_node_id')
    .eq('id', studentId)
    .maybeSingle()
  const classNodeId = studentRow?.class_node_id ?? null

  const [{ data: studentRows }, schoolDaysRes, classAvgRes] = await Promise.all([
    supabase
      .from('attendance_records')
      .select('status, date')
      .eq('school_id', schoolId)
      .eq('student_id', studentId)
      .gte('date', startDate)
      .lte('date', endDate),
    countSchoolDaysInRange(startDate, endDate, schoolId),
    // Class-average % presence over the same range, for comparison context.
    // NOT a raw table select — attendance_records_guardian_select RLS only
    // lets a guardian read their own linked child's rows, by design
    // (classmates' individual attendance should never be client-queryable
    // by a guardian). This calls a SECURITY DEFINER RPC that computes the
    // aggregate server-side and returns one rounded percentage — no
    // per-student rows ever reach the client. The RPC re-derives school_id
    // from the caller's session and verifies the caller is a guardian
    // actually linked to a student in this exact class, so it can't be
    // pointed at another class or another school. See
    // migration_class_attendance_average_rpc.sql.
    classNodeId
      ? supabase.rpc('get_class_attendance_average', {
          p_class_node_id: classNodeId,
          p_start_date: startDate,
          p_end_date: endDate,
        })
      : Promise.resolve({ data: null, error: null }),
  ])

  let present = 0, absent = 0, late = 0, excused = 0
  for (const r of studentRows ?? []) {
    if (r.status === 'present') present++
    else if (r.status === 'absent') absent++
    else if (r.status === 'late') late++
    else if (r.status === 'excused') excused++
  }

  const totalMarkable = present + absent + late
  // Real calendar-aware count (school_calendar_days overrides, falling back to
  // school_week_days) — same logic the staff-facing analytics panel uses, so a
  // parent and a teacher never see two different denominators for the same range.
  const totalSchoolDays = schoolDaysRes.ok ? schoolDaysRes.data : 0

  // classAvgRes.data is an array (Postgres table-returning function via
  // PostgREST) with 0 or 1 rows. A missing row, an RPC error (e.g. the
  // RPC's own authorization check fails), or a null class_average_percent
  // (no markable records yet for the class) all safely collapse to "don't
  // show the comparison," matching the existing render guard downstream.
  const classAvgRow = Array.isArray(classAvgRes?.data) ? classAvgRes.data[0] : null
  const classAveragePercent: number | null =
    classAvgRow && classAvgRow.class_average_percent !== null
      ? Number(classAvgRow.class_average_percent)
      : null

  return {
    present,
    absent,
    late,
    excused,
    totalMarkable,
    totalSchoolDays,
    percent: totalMarkable > 0 ? Math.round((present / totalMarkable) * 1000) / 10 : null,
    classAveragePercent,
  }
}

/**
 * 30-day rolling calendar strip — same shape as the staff-facing AttendanceModule
 * history view. One row per date, already guaranteed by the DB constraint —
 * no collapsing needed (see loadAttendanceSummary's doc comment above).
 */
export async function loadAttendanceCalendarStrip(
  schoolId: string,
  studentId: string
): Promise<AttendanceDay[]> {
  const since = new Date()
  since.setDate(since.getDate() - 30)
  const sinceStr = since.toISOString().slice(0, 10)
  const todayStr = todayDateString()

  const [{ data }, dayMapRes] = await Promise.all([
    supabase
      .from('attendance_records')
      .select('date, status')
      .eq('school_id', schoolId)
      .eq('student_id', studentId)
      .gte('date', sinceStr)
      .order('date', { ascending: true }),
    getSchoolDayMap(sinceStr, todayStr, schoolId),
  ])

  const statusByDate = new Map<string, AttendanceDay['status']>()
  for (const r of data ?? []) {
    statusByDate.set(r.date, r.status as AttendanceDay['status'])
  }

  // Walk every calendar date in the window, not just dates with a record —
  // otherwise a genuinely missed mark and a weekend/holiday both just vanish
  // from the strip, identically invisible. Same fix as the staff-facing
  // AttendanceModule history strip: distinguish "no school that day" from
  // "school happened and nobody marked it."
  const schoolDayMap = dayMapRes.ok ? dayMapRes.data : new Map<string, boolean>()
  const result: AttendanceDay[] = []
  for (const date of buildDateRangeInclusive(sinceStr, todayStr)) {
    const recorded = statusByDate.get(date)
    if (recorded) {
      result.push({ date, status: recorded })
    } else if (schoolDayMap.get(date) === false) {
      result.push({ date, status: 'no_school' })
    } else {
      result.push({ date, status: 'unmarked' })
    }
  }
  return result
}

function buildDateRangeInclusive(startDate: string, endDate: string): string[] {
  const dates: string[] = []
  const cur = new Date(startDate + 'T00:00:00')
  const end = new Date(endDate + 'T00:00:00')
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10))
    cur.setDate(cur.getDate() + 1)
  }
  return dates
}

// ─── Results (§4.9 — grade, class position, component breakdown) ──────────

/**
 * Loads only approved results (approved_at is not null) — drafts are never shown to
 * guardians/students, per §7.14's approval gate. Reads from the subject_results
 * computed view for weighted_total/grade_label/position_in_class, and joins back to
 * `scores` for the raw component-by-component breakdown that §4.9 requires
 * ("with component breakdown").
 */
export async function loadStudentResults(
  schoolId: string,
  studentId: string,
  sessionId: string,
  termId: string | null
): Promise<SubjectResultRow[]> {
  let scoreQuery = supabase
    .from('scores')
    .select(
      `
      subject_id, value, approved_at,
      subjects ( name ),
      score_components ( name, weight_pct )
    `
    )
    .eq('school_id', schoolId)
    .eq('student_id', studentId)
    .eq('session_id', sessionId)
    .not('approved_at', 'is', null)

  scoreQuery = termId ? scoreQuery.eq('term_id', termId) : scoreQuery.is('term_id', null)

  const { data: scoreRows } = await scoreQuery
  if (!scoreRows || scoreRows.length === 0) return []

  let viewQuery = supabase
    .from('subject_results')
    .select('subject_id, weighted_total, grade_label, position_in_class')
    .eq('school_id', schoolId)
    .eq('student_id', studentId)
    .eq('session_id', sessionId)

  viewQuery = termId ? viewQuery.eq('term_id', termId) : viewQuery.is('term_id', null)
  const { data: viewRows } = await viewQuery

  // Class size per subject — needed so "3rd in class" has the context §4.9 requires
  // ("never show a number without context"). Resolved via the student's class_node_id.
  const { data: studentRow } = await supabase
    .from('students')
    .select('class_node_id')
    .eq('id', studentId)
    .maybeSingle()
  const classNodeId = studentRow?.class_node_id ?? null

  let classSize: number | null = null
  if (classNodeId) {
    const { count } = await supabase
      .from('students')
      .select('id', { count: 'exact', head: true })
      .eq('school_id', schoolId)
      .eq('class_node_id', classNodeId)
      .eq('status', 'active')
    classSize = count ?? null
  }

  const viewBySubject = new Map(
    (viewRows ?? []).map((v) => [v.subject_id, v])
  )

  const bySubject = new Map<string, SubjectResultRow>()
  for (const r of scoreRows) {
    const subjectRel = unwrapEmbed<{ name: string }>(r.subjects)
    const componentRel = unwrapEmbed<{ name: string; weight_pct: number }>(r.score_components)
    if (!bySubject.has(r.subject_id)) {
      const viewRow = viewBySubject.get(r.subject_id)
      bySubject.set(r.subject_id, {
        subject_id: r.subject_id,
        subject_name: subjectRel?.name ?? 'Subject',
        components: [],
        weighted_total: viewRow?.weighted_total ?? null,
        grade_label: viewRow?.grade_label ?? null,
        position_in_class: viewRow?.position_in_class ?? null,
        class_size: classSize,
      })
    }
    if (componentRel) {
      bySubject.get(r.subject_id)!.components.push({
        component_name: componentRel.name,
        weight_pct: componentRel.weight_pct,
        value: r.value,
      })
    }
  }

  return Array.from(bySubject.values()).sort((a, b) =>
    a.subject_name.localeCompare(b.subject_name)
  )
}

// ─── Fees (§4.9 — what was billed, what was paid, balance, breakdown, history) ─

/**
 * Resolves fee assignments that apply to this student (school_wide, their class_node,
 * or them individually — per §7.16's target_type), nets out discounts, and nets out
 * completed payments, all per fee head. Mirrors the balance computation financeService
 * does for the staff-facing Finance module, but scoped read-only to one student.
 */
export async function loadFeeSummary(
  schoolId: string,
  studentId: string,
  sessionId: string
): Promise<FeeSummary> {
  const { data: studentRow } = await supabase
    .from('students')
    .select('class_node_id')
    .eq('id', studentId)
    .maybeSingle()
  const classNodeId = studentRow?.class_node_id ?? null

  const { data: assignments } = await supabase
    .from('fee_assignments')
    .select('id, fee_head_id, amount, target_type, class_node_id, student_id, fee_heads ( name )')
    .eq('school_id', schoolId)
    .eq('session_id', sessionId)

  const applicable = (assignments ?? []).filter((a) => {
    if (a.target_type === 'school_wide') return true
    if (a.target_type === 'class_node') return a.class_node_id === classNodeId
    if (a.target_type === 'student') return a.student_id === studentId
    return false
  })

  const { data: discounts } = await supabase
    .from('fee_discounts')
    .select('fee_assignment_id, discount_type, value')
    .eq('school_id', schoolId)
    .eq('student_id', studentId)

  const { data: payments } = await supabase
    .from('payments')
    .select('amount, fee_assignment_id, method, paid_at, notes, fee_assignments ( fee_head_id, fee_heads ( name ) )')
    .eq('school_id', schoolId)
    .eq('student_id', studentId)
    .eq('status', 'completed')
    .order('paid_at', { ascending: false })

  const discountByAssignment = new Map<string, number>()
  for (const d of discounts ?? []) {
    if (!d.fee_assignment_id) continue
    const assignment = applicable.find((a) => a.id === d.fee_assignment_id)
    const baseAmount = assignment?.amount ?? 0
    let discountValue = 0
    if (d.discount_type === 'full_waiver') discountValue = baseAmount
    else if (d.discount_type === 'percentage') discountValue = (baseAmount * (d.value ?? 0)) / 100
    else if (d.discount_type === 'fixed_amount') discountValue = d.value ?? 0
    discountByAssignment.set(
      d.fee_assignment_id,
      (discountByAssignment.get(d.fee_assignment_id) ?? 0) + discountValue
    )
  }

  const paidByAssignment = new Map<string, number>()
  for (const p of payments ?? []) {
    if (!p.fee_assignment_id) continue
    paidByAssignment.set(
      p.fee_assignment_id,
      (paidByAssignment.get(p.fee_assignment_id) ?? 0) + p.amount
    )
  }

  const breakdownByHead = new Map<string, FeeHeadBreakdown>()
  for (const a of applicable) {
    const headRel = unwrapEmbed<{ name: string }>(a.fee_heads)
    const headName = headRel?.name ?? 'Fee'
    const discount = discountByAssignment.get(a.id) ?? 0
    const paid = paidByAssignment.get(a.id) ?? 0
    const existing = breakdownByHead.get(a.fee_head_id)
    if (existing) {
      existing.billed += a.amount
      existing.discount += discount
      existing.paid += paid
      existing.balance = existing.billed - existing.discount - existing.paid
    } else {
      breakdownByHead.set(a.fee_head_id, {
        fee_head_id: a.fee_head_id,
        fee_head_name: headName,
        billed: a.amount,
        discount,
        paid,
        balance: a.amount - discount - paid,
      })
    }
  }

  const breakdown = Array.from(breakdownByHead.values())
  const totalBilled = breakdown.reduce((sum, b) => sum + b.billed, 0)
  const totalDiscount = breakdown.reduce((sum, b) => sum + b.discount, 0)
  const totalPaid = breakdown.reduce((sum, b) => sum + b.paid, 0)

  return {
    totalBilled,
    totalDiscount,
    totalPaid,
    balance: totalBilled - totalDiscount - totalPaid,
    breakdown,
  }
}

export async function loadPaymentHistory(
  schoolId: string,
  studentId: string
): Promise<PaymentHistoryRow[]> {
  const { data } = await supabase
    .from('payments')
    .select('id, amount, method, paid_at, notes, fee_assignments ( fee_heads ( name ) )')
    .eq('school_id', schoolId)
    .eq('student_id', studentId)
    .eq('status', 'completed')
    .order('paid_at', { ascending: false })

  return (data ?? []).map((p) => {
    const assignmentRel = unwrapEmbed<{ fee_heads: unknown }>(p.fee_assignments)
    const headRel = unwrapEmbed<{ name: string }>(assignmentRel?.fee_heads)
    return {
      id: p.id,
      amount: p.amount,
      method: p.method,
      paid_at: p.paid_at,
      notes: p.notes,
      fee_head_name: headRel?.name ?? null,
    }
  })
}

// ─── Announcements (§4.9 — filtered to their audience) ─────────────────────

/**
 * Audience filtering mirrors announcementsService's RLS-backed read: RLS already
 * restricts rows to `audience in ('all', actor_type)` plus any matching class_node_id
 * for the student's own class, so this is a plain ordered select — no extra filter
 * needed client-side beyond expiry, which is derived the same way announcementsService
 * derives `is_expired` (client-side comparison against `expires_at`).
 */
export async function loadPortalAnnouncements(
  schoolId: string,
  limit = 10
): Promise<PortalAnnouncement[]> {
  const { data } = await supabase
    .from('announcements')
    .select('id, title, body, posted_at, expires_at')
    .eq('school_id', schoolId)
    .order('posted_at', { ascending: false })
    .limit(limit)

  const now = new Date()
  return (data ?? []).map((a) => ({
    ...a,
    is_expired: a.expires_at ? new Date(a.expires_at) < now : false,
  }))
}

// ─── Pure helpers (no browser APIs — React Native safe) ───────────────────

export function formatNaira(amount: number): string {
  return `₦${amount.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function todayDateString(): string {
  return new Date().toISOString().slice(0, 10)
}
