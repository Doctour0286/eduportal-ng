/**
 * attendanceService.ts
 * Data access layer for the attendance module.
 * No browser-only APIs. No UI imports. React Native compatible.
 *
 * Read exports:
 *   loadCurrentSession()          — re-exported from timetableService pattern; kept here
 *                                   so AttendanceModule has a single import target
 *   loadAllLeafClasses()          — all leaf nodes (everyone picks freely)
 *   loadStudentsForClass()        — active students enrolled in a class node
 *   loadAttendanceRecords()       — all records for a class+date
 *   loadAttendanceHistory()       — 30-day rolling summary per student (calendar strip)
 *
 * Write exports:
 *   saveAttendanceRecord()        — upsert one student's status; offline-queue aware
 *   saveBatchAttendance()         — mark all students in one call (batch mark-all)
 *   flushAttendanceQueue()        — drain the offline queue when connectivity returns
 *
 * Pure helpers:
 *   buildAttendanceMap()          — index records by studentId
 *   getAttendanceSummary()        — present/absent/excused/late counts for a class+date
 *
 * School calendar / analytics (2026-07-03, PRD Tier 5 / Problem 5.4 + Session 17-19
 * design, school_calendar_days migrated same session as this code):
 *   isSchoolDay()                  — single-date check against school_calendar_days,
 *                                    falling back to school_week_days when no row exists
 *   countSchoolDaysInRange()       — school-day count over a date range (the % denominator)
 *   getSchoolAttendanceAnalytics() — whole-school present/absent/excused/late/not-marked
 *                                    totals + % presence for day/week/term/session scope
 *
 * Per-period marking removed (2026-07-03, owner decision): `attendance_settings`
 * had zero rows for any granularity in this school — every one of the 4 leaf
 * classes was already implicitly running on the code-level 'daily' fallback,
 * and `per_period` had never been turned on anywhere. Its nullable `period_id`
 * dimension was also the direct, confirmed root cause of a real data-integrity
 * bug: the old unique constraint (school_id, student_id, date, period_id)
 * never actually enforced uniqueness when period_id was NULL (Postgres treats
 * every NULL in a unique constraint as distinct from every other NULL), so
 * every whole-day upsert's `onConflict` silently found no match and inserted
 * a fresh duplicate row instead of updating — confirmed live via 8 duplicate
 * rows across two students on one date. Rather than narrowly patch that one
 * bug and leave the unused nullable-period_id hazard in place for a future
 * write path to trip over again, the owner chose to remove per-period marking
 * entirely and enforce "one attendance record per student per day" as a real,
 * simple, always-correct DB constraint: UNIQUE (school_id, student_id, date).
 * `attendance_settings`/`periods`/`class_nodes` were left untouched at the
 * schema level (no destructive drop), but this file no longer reads or
 * branches on granularity, and attendance_records.period_id is no longer
 * written by any function here — it now always writes NULL.
 */

import { supabase } from '../lib/supabase'
import { queueWrite, getQueue, clearFromQueue } from '../lib/offlineQueue'

// ─── Types ────────────────────────────────────────────────────────────────────

export type AttendanceStatus = 'present' | 'absent' | 'excused' | 'late'

export interface ClassNode {
  id: string
  name: string
  parent_id: string | null
  sort_order: number
  path_label: string   // e.g. "JSS 1 · JSS 1A" — built client-side, not in DB
}

export interface Student {
  id: string
  full_name: string
  class_node_id: string
}

export interface AttendanceRecord {
  id: string
  student_id: string
  date: string         // 'YYYY-MM-DD'
  status: AttendanceStatus
  notes: string | null
  marked_by: string    // staff.id
}

// Keyed by studentId — one record per student per day, no period dimension.
// Used by the UI to look up a student's status without a linear scan every render.
export type AttendanceMap = Map<string, AttendanceRecord>

// One calendar-strip day for a single student.
export interface AttendanceDaySummary {
  date: string
  status: AttendanceStatus | null   // null = not marked
  // Added 2026-07-03 (owner request) — lets the history-strip UI render
  // weekends/holidays visually distinct from a genuinely missed school day,
  // both of which otherwise land on status: null. Sourced from
  // school_calendar_days/school_week_days via getSchoolDayMap().
  isSchoolDay: boolean
}

// 30-day history for a single student — fed into the calendar strip.
export interface StudentAttendanceHistory {
  student_id: string
  student_name: string
  days: AttendanceDaySummary[]
}

// What the UI needs for the batch/optimistic write path.
export interface AttendanceUpsertParams {
  schoolId: string
  studentId: string
  classNodeId: string
  markedBy: string     // staff.id of the person marking
  date: string         // 'YYYY-MM-DD'
  status: AttendanceStatus
  notes?: string
}

// Result shape every function returns — mirrors timetableService conventions.
type Ok<T> = { ok: true; data: T }
type Err   = { ok: false; error: string }
type Result<T> = Ok<T> | Err

// ─── School calendar / analytics types ────────────────────────────────────────

export type CalendarDayType = 'school_day' | 'holiday' | 'exam_day' | 'break'

export interface SchoolDayCheck {
  isSchoolDay: boolean
  dayType: CalendarDayType | null   // null = no explicit row, weekday-only inference
  label: string | null              // e.g. "Eid al-Fitr" — present for non-school days when set
}

export type AttendanceAnalyticsScope = 'day' | 'week' | 'term' | 'session'

export interface SchoolAttendanceAnalytics {
  scope: AttendanceAnalyticsScope
  startDate: string
  endDate: string
  schoolDaysInRange: number          // denominator for % presence
  totalActiveStudents: number
  present: number
  absent: number
  excused: number
  late: number
  notMarked: number                  // active students × school days, minus records
  presentPercent: number             // present / (present+absent+excused+late+notMarked), 0-100
  // Small addition beyond the PRD's literal spec (§4.11 "actionable data, not
  // just raw tables") — a same-length array of per-day present-counts for the
  // scope's date range, cheap to derive from the same query, feeds an optional
  // sparkline per §4.11's bar-chart guidance. Empty for scope 'day'.
  dailyPresentTrend: { date: string; present: number }[]
}

// ─── Current session ──────────────────────────────────────────────────────────
// Identical query to timetableService.loadCurrentSession().
// Duplicated here so AttendanceModule has one import source.

export async function loadCurrentSession(): Promise<{
  ok: boolean
  sessionId?: string
  sessionName?: string
  // Additive (2026-07-03, analytics scope resolution) — existing callers that
  // only read sessionId/sessionName are unaffected.
  sessionStartDate?: string
  sessionEndDate?: string
  error?: string
}> {
  try {
    const { data, error } = await supabase
      .from('sessions')
      .select('id, name, start_date, end_date')
      .eq('is_current', true)
      .maybeSingle()

    if (error) return { ok: false, error: error.message }
    if (!data)  return { ok: false, error: 'No current session found. Set up a session in settings.' }
    return {
      ok: true,
      sessionId: data.id,
      sessionName: data.name,
      sessionStartDate: data.start_date,
      sessionEndDate: data.end_date,
    }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load session' }
  }
}

/**
 * The current term for a school that uses terms — the current session's term
 * whose date range contains today. Returns ok:true, data:null when the school
 * doesn't use terms or no term row covers today (caller falls back to session
 * range in either case).
 */
export async function loadCurrentTerm(
  sessionId: string,
): Promise<Result<{ id: string; name: string; startDate: string; endDate: string } | null>> {
  try {
    const today = todayDateString()
    const { data, error } = await supabase
      .from('terms')
      .select('id, name, start_date, end_date')
      .eq('session_id', sessionId)
      .lte('start_date', today)
      .gte('end_date', today)
      .maybeSingle()

    if (error) return { ok: false, error: error.message }
    if (!data) return { ok: true, data: null }

    return {
      ok: true,
      data: { id: data.id, name: data.name, startDate: data.start_date, endDate: data.end_date },
    }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load current term' }
  }
}

// ─── Class loaders ────────────────────────────────────────────────────────────

// Shared path-label builder — same logic as timetableService.loadClassNodes().
function attachPathLabels(nodes: ClassNode[]): ClassNode[] {
  const byId: Record<string, ClassNode> = {}
  nodes.forEach(n => { byId[n.id] = n })
  nodes.forEach(n => {
    if (n.parent_id && byId[n.parent_id]) {
      n.path_label = `${byId[n.parent_id].name} · ${n.name}`
    } else {
      n.path_label = n.name
    }
  })
  return nodes
}

/**
 * All leaf nodes in the school, sorted by sort_order.
 * Every user (teacher or admin) picks freely from this list —
 * there is no per-teacher class restriction on attendance.
 * Mirrors timetableService.loadClassNodes() but filtered to is_leaf_enrollable.
 */
export async function loadAllLeafClasses(): Promise<Result<ClassNode[]>> {
  try {
    const { data, error } = await supabase
      .from('class_nodes')
      .select('id, name, parent_id, sort_order, is_leaf_enrollable')
      .eq('is_leaf_enrollable', true)
      .order('sort_order')

    if (error) return { ok: false, error: error.message }

    const nodes: ClassNode[] = (data ?? []).map((n: any) => ({
      id: n.id,
      name: n.name,
      parent_id: n.parent_id ?? null,
      sort_order: n.sort_order,
      path_label: n.name,   // attachPathLabels fills in the 2-level label
    }))

    return { ok: true, data: attachPathLabels(nodes) }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load classes' }
  }
}

// ─── Students ─────────────────────────────────────────────────────────────────

/**
 * Active students enrolled in a specific class node.
 * Ordered alphabetically — consistent with how teachers read a register.
 * Only 'active' status students; alumni/transferred/inactive excluded.
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

// ─── Attendance records ───────────────────────────────────────────────────────

/**
 * Loads all attendance records for a class on a given date.
 * One row per student per day, enforced by a real DB constraint
 * (school_id, student_id, date) — no period dimension.
 *
 * RLS guarantees school scoping — no explicit school_id filter needed here.
 */
export async function loadAttendanceRecords(params: {
  classNodeId: string
  date: string          // 'YYYY-MM-DD'
}): Promise<Result<AttendanceRecord[]>> {
  try {
    // We filter by student.class_node_id via a join — attendance_records doesn't
    // store class_node_id directly (students carry their own enrollment column).
    // The join approach avoids a subquery and lets Supabase optimize with the index.
    const { data, error } = await supabase
      .from('attendance_records')
      .select(`
        id,
        student_id,
        date,
        status,
        notes,
        marked_by,
        students!inner ( class_node_id )
      `)
      .eq('date', params.date)
      .eq('students.class_node_id', params.classNodeId)

    if (error) return { ok: false, error: error.message }

    const records: AttendanceRecord[] = (data ?? []).map((r: any) => ({
      id: r.id,
      student_id: r.student_id,
      date: r.date,
      status: r.status as AttendanceStatus,
      notes: r.notes ?? null,
      marked_by: r.marked_by,
    }))

    return { ok: true, data: records }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load attendance records' }
  }
}

// ─── Attendance history (calendar strip) ─────────────────────────────────────

/**
 * Loads a 30-day rolling attendance history for every student in a class.
 * Used to render the calendar strip beneath each student row.
 *
 * One query for all students in the class over the date range.
 * Returns per-student arrays of {date, status} in ascending date order.
 * Days with no record come back as status: null — the UI renders them as grey.
 */
export async function loadAttendanceHistory(
  classNodeId: string,
  schoolId: string,
  referenceDate: Date = new Date(),
): Promise<Result<StudentAttendanceHistory[]>> {
  try {
    // Build a 30-day window ending on referenceDate
    const endDate   = formatDate(referenceDate)
    const startDate = formatDate(new Date(referenceDate.getTime() - 29 * 24 * 60 * 60 * 1000))

    // Step 1: get the student list for this class (to build the day arrays)
    const studentsResult = await loadStudentsForClass(classNodeId)
    if (!studentsResult.ok) return { ok: false, error: studentsResult.error }
    const students = studentsResult.data

    if (students.length === 0) return { ok: true, data: [] }

    const studentIds = students.map(s => s.id)

    // Step 2: load all records in range for those students, and the school-day
    // map for the same range (owner request, 2026-07-03 — the strip needs to
    // tell "no school that day" apart from "school day, nobody marked it").
    const [{ data, error }, schoolDayMapRes] = await Promise.all([
      supabase
        .from('attendance_records')
        .select('student_id, date, status')
        .in('student_id', studentIds)
        .gte('date', startDate)
        .lte('date', endDate)
        .order('date'),
      getSchoolDayMap(startDate, endDate, schoolId),
    ])

    if (error) return { ok: false, error: error.message }
    if (!schoolDayMapRes.ok) return { ok: false, error: schoolDayMapRes.error }
    const schoolDayMap = schoolDayMapRes.data

    // Build a lookup: studentId → Map<date, status>. One row per student per
    // day is now a DB-enforced guarantee, so no first-wins collapsing needed.
    const recordsByStudent = new Map<string, Map<string, AttendanceStatus>>()
    for (const r of (data ?? [])) {
      if (!recordsByStudent.has(r.student_id)) {
        recordsByStudent.set(r.student_id, new Map())
      }
      recordsByStudent.get(r.student_id)!.set(r.date, r.status as AttendanceStatus)
    }

    // Generate the 30-day date range in order
    const dateRange = buildDateRange(startDate, endDate)

    // Assemble per-student histories
    const histories: StudentAttendanceHistory[] = students.map(s => ({
      student_id: s.id,
      student_name: s.full_name,
      days: dateRange.map(date => ({
        date,
        status: recordsByStudent.get(s.id)?.get(date) ?? null,
        isSchoolDay: schoolDayMap.get(date) ?? true,   // default true if lookup somehow missed a date
      })),
    }))

    return { ok: true, data: histories }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load attendance history' }
  }
}

// ─── Write: single record ─────────────────────────────────────────────────────

/**
 * Upserts one student's attendance record for one day.
 *
 * Optimistic-UI contract (called by the component):
 *   1. UI updates its local state immediately (caller's responsibility).
 *   2. This function is called in the background.
 *   3. On failure, caller reads the returned error and reverts the optimistic update.
 *
 * Offline handling:
 *   If the device is offline, the write is queued and { ok: true, queued: true }
 *   is returned so the UI can show an "offline" indicator without blocking the user.
 *   Call flushAttendanceQueue() when connectivity returns.
 *
 * The real unique constraint (school_id, student_id, date) — added after
 * removing per-period marking — makes this genuinely safe to re-call on tap:
 * repeated taps cycle status via a real onConflict match, never duplicate rows.
 * (This is the guarantee the old comment here claimed but the old, nullable-
 * period_id constraint never actually delivered — see this file's header.)
 */
export async function saveAttendanceRecord(
  params: AttendanceUpsertParams,
): Promise<{ ok: boolean; queued?: boolean; error?: string }> {
  const payload: Record<string, unknown> = {
    school_id:  params.schoolId,
    student_id: params.studentId,
    date:       params.date,
    period_id:  null,
    status:     params.status,
    notes:      params.notes ?? null,
    marked_by:  params.markedBy,
  }

  try {
    const { error } = await supabase
      .from('attendance_records')
      .upsert(payload, {
        onConflict: 'school_id,student_id,date',
      })

    if (error) {
      // Network error vs. constraint/RLS error — queue only on network failure.
      // RLS rejection (e.g. teacher marking a class they're not assigned to)
      // should surface as a real error, not be silently queued.
      if (isNetworkError(error.message)) {
        queueWrite('attendance_records', 'insert', payload)
        return { ok: true, queued: true }
      }
      return { ok: false, error: friendlyError(error.message) }
    }

    return { ok: true }
  } catch (err: any) {
    // Caught here = fetch never completed (offline, DNS failure, etc.)
    queueWrite('attendance_records', 'insert', payload)
    return { ok: true, queued: true }
  }
}

// ─── Write: batch (mark-all) ──────────────────────────────────────────────────

/**
 * Marks all students in a class with the same status in a single upsert.
 * Used by the "Mark all present" / "Mark all absent" shortcut.
 *
 * Sends one upsert with multiple rows — one round-trip, not N round-trips.
 * The real (school_id, student_id, date) constraint means onConflict now
 * genuinely resolves every row, unlike the old nullable-period_id constraint.
 * Offline behaviour: same as saveAttendanceRecord() — queue each row individually
 * so they can be retried independently if some succeed and some don't.
 */
export async function saveBatchAttendance(params: {
  records: AttendanceUpsertParams[]
}): Promise<{ ok: boolean; queued?: boolean; error?: string }> {
  if (params.records.length === 0) return { ok: true }

  const rows = params.records.map(p => ({
    school_id:  p.schoolId,
    student_id: p.studentId,
    date:       p.date,
    period_id:  null,
    status:     p.status,
    notes:      p.notes ?? null,
    marked_by:  p.markedBy,
  }))

  try {
    const { error } = await supabase
      .from('attendance_records')
      .upsert(rows, {
        onConflict: 'school_id,student_id,date',
      })

    if (error) {
      if (isNetworkError(error.message)) {
        rows.forEach(row => queueWrite('attendance_records', 'insert', row))
        return { ok: true, queued: true }
      }
      return { ok: false, error: friendlyError(error.message) }
    }

    return { ok: true }
  } catch (err: any) {
    rows.forEach(row => queueWrite('attendance_records', 'insert', row))
    return { ok: true, queued: true }
  }
}

// ─── Flush offline queue ──────────────────────────────────────────────────────

/**
 * Drains all queued attendance writes when connectivity returns.
 * Call this when the app detects it's back online (e.g. via a network event
 * handler in App.tsx — the service itself has no window/navigator references).
 *
 * Returns the number of records successfully flushed and a list of any that
 * failed so the UI can warn the user.
 */
export async function flushAttendanceQueue(): Promise<{
  flushed: number
  failed: Array<{ payload: Record<string, unknown>; error: string }>
}> {
  const pending = getQueue().filter(item => item.table === 'attendance_records')

  let flushed = 0
  const failed: Array<{ payload: Record<string, unknown>; error: string }> = []

  for (const item of pending) {
    try {
      const { error } = await supabase
        .from('attendance_records')
        .upsert(item.payload as Record<string, unknown>, {
          onConflict: 'school_id,student_id,date',
        })

      if (error) {
        failed.push({ payload: item.payload, error: friendlyError(error.message) })
      } else {
        clearFromQueue(item.id)
        flushed++
      }
    } catch (err: any) {
      // Still offline — stop trying; we'll retry next flush call
      break
    }
  }

  return { flushed, failed }
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Indexes a flat list of AttendanceRecord objects into a Map for O(1) UI lookups.
 * Keyed by studentId — one record per student per day, no period dimension.
 *
 * The UI calls this after loadAttendanceRecords() and stores the result in state.
 * On every optimistic update it adds/replaces the entry directly in the Map
 * (or builds a new Map — caller's choice) rather than re-querying.
 */
// ─── School calendar ──────────────────────────────────────────────────────────

/**
 * Is `date` a school day? Checks school_calendar_days first (explicit
 * holiday/exam_day/break/school_day override); if no row exists, falls back
 * to school_week_days for the weekday. PRD Tier 5 / Problem 5.2 / Session 19
 * spec, exact fallback order as written there.
 */
export async function isSchoolDay(
  date: string,          // 'YYYY-MM-DD'
  schoolId: string,
): Promise<Result<SchoolDayCheck>> {
  try {
    const { data: calRow, error: calErr } = await supabase
      .from('school_calendar_days')
      .select('day_type, label')
      .eq('school_id', schoolId)
      .eq('calendar_date', date)
      .maybeSingle()

    if (calErr) return { ok: false, error: calErr.message }

    if (calRow) {
      const dayType = calRow.day_type as CalendarDayType
      return {
        ok: true,
        data: {
          isSchoolDay: dayType === 'school_day',
          dayType,
          label: calRow.label ?? null,
        },
      }
    }

    // No explicit row — fall back to the weekday configuration.
    const weekday = new Date(date + 'T00:00:00').getDay()   // 0=Sunday..6=Saturday
    const { data: weekRow, error: weekErr } = await supabase
      .from('school_week_days')
      .select('day_of_week')
      .eq('school_id', schoolId)
      .eq('day_of_week', weekday)
      .maybeSingle()

    if (weekErr) return { ok: false, error: weekErr.message }

    return {
      ok: true,
      data: { isSchoolDay: !!weekRow, dayType: null, label: null },
    }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to check school day' }
  }
}

/**
 * Fetches calendar overrides + weekday config for a range and returns a
 * Map<date, isSchoolDay> covering every date in [startDate, endDate]. Shared
 * by countSchoolDaysInRange(), the analytics not-marked/sparkline math,
 * loadAttendanceHistory()'s per-day school-day flag, and (exported)
 * portalService.ts's guardian-facing summary/calendar-strip — one place for
 * the override-then-weekday-fallback logic instead of duplicating it per file.
 */
export async function getSchoolDayMap(
  startDate: string,
  endDate: string,
  schoolId: string,
): Promise<Result<Map<string, boolean>>> {
  try {
    const [{ data: calRows, error: calErr }, { data: weekRows, error: weekErr }] =
      await Promise.all([
        supabase
          .from('school_calendar_days')
          .select('calendar_date, day_type')
          .eq('school_id', schoolId)
          .gte('calendar_date', startDate)
          .lte('calendar_date', endDate),
        supabase
          .from('school_week_days')
          .select('day_of_week')
          .eq('school_id', schoolId),
      ])

    if (calErr)  return { ok: false, error: calErr.message }
    if (weekErr) return { ok: false, error: weekErr.message }

    const overrideByDate = new Map<string, CalendarDayType>()
    for (const r of calRows ?? []) {
      overrideByDate.set(r.calendar_date, r.day_type as CalendarDayType)
    }
    const schoolWeekdays = new Set((weekRows ?? []).map((r: any) => r.day_of_week))

    const result = new Map<string, boolean>()
    for (const date of buildDateRange(startDate, endDate)) {
      const override = overrideByDate.get(date)
      if (override) {
        result.set(date, override === 'school_day')
      } else {
        const weekday = new Date(date + 'T00:00:00').getDay()
        result.set(date, schoolWeekdays.has(weekday))
      }
    }

    return { ok: true, data: result }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load school calendar' }
  }
}

/**
 * Counts school days in [startDate, endDate] inclusive — the denominator for
 * week/term/session % presence.
 */
export async function countSchoolDaysInRange(
  startDate: string,
  endDate: string,
  schoolId: string,
): Promise<Result<number>> {
  const mapRes = await getSchoolDayMap(startDate, endDate, schoolId)
  if (!mapRes.ok) return mapRes

  let count = 0
  for (const isDay of mapRes.data.values()) {
    if (isDay) count++
  }
  return { ok: true, data: count }
}

/**
 * Computes a term's (or session's, when uses_terms=false) *effective* end
 * date — the base end_date plus one day for every school-day calendar entry
 * marked extends_term=true that falls within [baseStartDate, effectiveEndDate].
 *
 * Deliberately live-computed, never stored: this is what makes inserting and
 * deleting an extending holiday symmetric for free (delete the entry, the
 * next call to this function naturally reverts the effective date — no
 * separate "undo" logic, no risk of a stored value drifting out of sync with
 * the entries that justified it). Owner-requested refinement over the
 * original PRD Problem 6.7 spec (which assumed every school-day holiday
 * uniformly extends a term): here it's a per-entry admin choice
 * (extends_term), so a single stray public holiday doesn't push a term out,
 * while a planned multi-week break can.
 *
 * Iterates rather than computing in one shot because an extension pushes the
 * search window itself forward — an extending entry that falls *after* the
 * base end date (inside a window already extended by an earlier entry) must
 * still count. Converges in at most (number of extending entries + 1) passes.
 *
 * Only entries whose specific date would otherwise have been a real school
 * day count (per school_week_days/other overrides) — marking an already-off
 * Saturday as "holiday, extends term" shouldn't add a day that was never
 * going to be taught anyway. This also means a bulk date-range entry
 * attributes only its real school-day dates toward extension, not every
 * calendar date in the range.
 */
export async function getEffectiveTermEndDate(
  baseStartDate: string,
  baseEndDate: string,
  schoolId: string,
): Promise<Result<string>> {
  try {
    const { data: weekRows, error: weekErr } = await supabase
      .from('school_week_days')
      .select('day_of_week')
      .eq('school_id', schoolId)

    if (weekErr) return { ok: false, error: weekErr.message }
    const schoolWeekdays = new Set((weekRows ?? []).map((r: any) => r.day_of_week))

    let searchEnd = baseEndDate
    let previousCount = -1

    // Loop until the count of qualifying entries within the (possibly
    // growing) window stops changing — handles an extending entry that
    // itself falls inside a window only opened up by an earlier extension.
    for (let iterations = 0; iterations < 366; iterations++) {
      const { data: calRows, error: calErr } = await supabase
        .from('school_calendar_days')
        .select('calendar_date, day_type')
        .eq('school_id', schoolId)
        .eq('extends_term', true)
        .neq('day_type', 'school_day')
        .gte('calendar_date', baseStartDate)
        .lte('calendar_date', searchEnd)

      if (calErr) return { ok: false, error: calErr.message }

      const candidateDates = (calRows ?? []).map((r: any) => r.calendar_date as string)
      if (candidateDates.length === 0) {
        return { ok: true, data: searchEnd }
      }

      // Only dates that would otherwise have been real school days count —
      // check each candidate against the school's weekday configuration
      // directly (not getSchoolDayMap's per-date value, which would say
      // "not a school day" for the override itself; we want "would this
      // date have been a school day if it weren't marked as a holiday").
      let qualifyingCount = 0
      for (const date of candidateDates) {
        const weekday = new Date(date + 'T00:00:00').getDay()
        if (schoolWeekdays.has(weekday)) qualifyingCount++
      }

      if (qualifyingCount === previousCount) {
        return { ok: true, data: searchEnd }
      }

      previousCount = qualifyingCount
      const base = new Date(baseEndDate + 'T00:00:00')
      base.setDate(base.getDate() + qualifyingCount)
      searchEnd = base.toISOString().slice(0, 10)
    }

    // Should be unreachable in practice (366 extending entries in one term
    // would be a data problem, not a logic one) — fail safe rather than loop
    // forever.
    return { ok: false, error: 'Term extension calculation did not converge' }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to compute effective term end date' }
  }
}

/**
 * Turns a scope into concrete [startDate, endDate] bounds, capped at today
 * so a mid-term/mid-session query never counts future school days as
 * "not marked" (that would misreport a real gap as one that doesn't exist
 * yet). 'week' uses Mon-Sun containing today, clipped to today.
 */
export function resolveAnalyticsScopeRange(
  scope: AttendanceAnalyticsScope,
  session: { sessionStartDate: string; sessionEndDate: string },
  term: { startDate: string; endDate: string } | null,
): { startDate: string; endDate: string } {
  const today = todayDateString()

  if (scope === 'day') return { startDate: today, endDate: today }

  if (scope === 'week') {
    const now = new Date(today + 'T00:00:00')
    const dayOfWeek = now.getDay()               // 0=Sunday..6=Saturday
    const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek
    const monday = new Date(now)
    monday.setDate(now.getDate() + diffToMonday)
    return { startDate: formatDate(monday), endDate: today }
  }

  if (scope === 'term' && term) {
    return { startDate: term.startDate, endDate: today < term.endDate ? today : term.endDate }
  }

  // scope === 'session', or 'term' requested but school doesn't use terms /
  // no term covers today — fall back to the session range.
  return {
    startDate: session.sessionStartDate,
    endDate: today < session.sessionEndDate ? today : session.sessionEndDate,
  }
}

// ─── Whole-school attendance analytics ────────────────────────────────────────

/**
 * Aggregates attendance across the WHOLE SCHOOL (every class combined) for a
 * given scope. Independent of the register's selectedClass/selectedDate —
 * this answers "how is the school doing," not "how is this class doing today"
 * (that's what the existing per-class getAttendanceSummary() strip is for).
 *
 * PRD Tier 5 / Problem 5.4 follow-on scope (owner request, 2026-07-03): the
 * original Session 22 spec only covered a per-class "today" strip using
 * getAttendanceSummary(); day/week/term/session scope and % presence needed
 * a real date-range DB aggregation, which is what this function adds.
 *
 * Cost note (§4.1 — cheap/cached queries): this issues 2 queries regardless
 * of range size (one count of active students, one grouped count of records
 * in range) plus countSchoolDaysInRange's 2 queries — 4 total, not one row
 * fetch per day. The caller (AttendanceModule) should call this once per
 * scope change, not on every render.
 */
export async function getSchoolAttendanceAnalytics(params: {
  schoolId: string
  scope: AttendanceAnalyticsScope
  // Caller resolves the actual date bounds for the scope (today; this week;
  // the current term's start_date/end_date; the current session's), since
  // that resolution depends on uses_terms/current term/session lookups that
  // already exist elsewhere (loadCurrentSession() here, ResultsModule's term
  // pattern) — this function just aggregates over whatever range it's given.
  startDate: string
  endDate: string
}): Promise<Result<SchoolAttendanceAnalytics>> {
  try {
    const { schoolId, scope, startDate, endDate } = params

    const [studentCountRes, recordsRes, schoolDayMapRes] = await Promise.all([
      supabase
        .from('students')
        .select('id', { count: 'exact', head: true })
        .eq('school_id', schoolId)
        .eq('status', 'active'),
      supabase
        .from('attendance_records')
        .select('date, status')
        .eq('school_id', schoolId)
        .gte('date', startDate)
        .lte('date', endDate),
      getSchoolDayMap(startDate, endDate, schoolId),
    ])

    if (studentCountRes.error) return { ok: false, error: studentCountRes.error.message }
    if (recordsRes.error)      return { ok: false, error: recordsRes.error.message }
    if (!schoolDayMapRes.ok)   return { ok: false, error: schoolDayMapRes.error }

    const totalActiveStudents = studentCountRes.count ?? 0
    const schoolDayMap = schoolDayMapRes.data
    let schoolDaysInRange = 0
    for (const isDay of schoolDayMap.values()) if (isDay) schoolDaysInRange++

    let present = 0, absent = 0, excused = 0, late = 0
    const trendByDate = new Map<string, number>()
    for (const r of recordsRes.data ?? []) {
      if (r.status === 'present') present++
      else if (r.status === 'absent') absent++
      else if (r.status === 'excused') excused++
      else if (r.status === 'late') late++
      if (r.status === 'present') {
        trendByDate.set(r.date, (trendByDate.get(r.date) ?? 0) + 1)
      }
    }

    const marked = present + absent + excused + late
    const expectedMarks = totalActiveStudents * schoolDaysInRange
    const notMarked = Math.max(0, expectedMarks - marked)

    const denominator = marked + notMarked
    const presentPercent = denominator > 0
      ? Math.round((present / denominator) * 1000) / 10   // one decimal place
      : 0

    // Sparkline: school days only — a holiday shouldn't render as a 0-present
    // dip indistinguishable from a genuinely missed school day (owner request,
    // 2026-07-03, same session this whole-school panel was added).
    const dailyPresentTrend = scope === 'day'
      ? []
      : buildDateRange(startDate, endDate)
          .filter(date => schoolDayMap.get(date) === true)
          .map(date => ({ date, present: trendByDate.get(date) ?? 0 }))

    return {
      ok: true,
      data: {
        scope,
        startDate,
        endDate,
        schoolDaysInRange,
        totalActiveStudents,
        present,
        absent,
        excused,
        late,
        notMarked,
        presentPercent,
        dailyPresentTrend,
      },
    }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load attendance analytics' }
  }
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

export function buildAttendanceMap(records: AttendanceRecord[]): AttendanceMap {
  const map: AttendanceMap = new Map()
  for (const r of records) {
    map.set(r.student_id, r)
  }
  return map
}

/**
 * Computes present / absent / excused / late counts from an AttendanceMap.
 * Used for the header summary bar ("22 present · 3 absent · 1 late").
 */
export function getAttendanceSummary(map: AttendanceMap): {
  present: number
  absent: number
  excused: number
  late: number
  unmarked: number
  total: number
} {
  let present = 0, absent = 0, excused = 0, late = 0
  for (const r of map.values()) {
    if (r.status === 'present') present++
    else if (r.status === 'absent') absent++
    else if (r.status === 'excused') excused++
    else if (r.status === 'late') late++
  }
  const total = map.size
  const unmarked = 0   // caller subtracts (studentCount - total) if needed
  return { present, absent, excused, late, unmarked, total }
}

/**
 * Returns today's date as 'YYYY-MM-DD' without any timezone conversion.
 * Uses local time — teachers mark attendance in their own timezone.
 * Safe to call in React Native (no window/navigator reference).
 */
export function todayDateString(): string {
  return formatDate(new Date())
}

// ─── Internal utilities ───────────────────────────────────────────────────────

function formatDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function buildDateRange(startDate: string, endDate: string): string[] {
  const dates: string[] = []
  const current = new Date(startDate + 'T00:00:00')   // force local midnight
  const end     = new Date(endDate   + 'T00:00:00')
  while (current <= end) {
    dates.push(formatDate(current))
    current.setDate(current.getDate() + 1)
  }
  return dates
}

/** Heuristic: treat these message patterns as transient network failures. */
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

/** Converts raw Supabase/Postgres error messages into plain-English UI strings. */
function friendlyError(message: string): string {
  if (message.includes('violates row-level security')) {
    return "You don't have permission to mark attendance for this class."
  }
  if (message.includes('violates foreign key')) {
    return 'Student or staff record not found. Please refresh and try again.'
  }
  if (message.includes('violates unique constraint')) {
    // Should never surface — upsert handles this — but just in case
    return 'Record already exists. Please refresh and try again.'
  }
  return 'Failed to save attendance. Please try again.'
}
