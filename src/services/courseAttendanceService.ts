/**
 * courseAttendanceService.ts
 * Data access layer for per-course attendance (PRD Tier 8 / Problem 8.7,
 * SESSION 58). Reuses attendanceService.ts's exact optimistic-write/
 * offline-queue pattern (Result<T> shape, saveX/saveBatchX/flushXQueue
 * three-function write family, network-vs-RLS error distinction) — this is
 * the piece SESSION 58's card explicitly says to reuse "as-is," not
 * re-derive, so this file's write path intentionally matches
 * attendanceService.ts's conventions rather than courseRegistrationService.ts's
 * {data, error} shape (SESSION 57's own convention, used instead for reads
 * that are genuinely new to the registration domain, not being reused from
 * anywhere).
 *
 * No browser-only APIs. No UI imports. React Native compatible — matching
 * attendanceService.ts's own stated constraint exactly, since this file
 * sits in the same conceptual family.
 *
 * Read exports:
 *   loadCourseOfferingsForStaff() — offerings a lecturer is assigned to
 *     (staff_id match) or, for an admin, every offering in the school —
 *     the picker equivalent of loadAllLeafClasses() for this domain.
 *   loadRegisteredStudents()      — students with a LIVE course_registrations
 *     row for a given offering (status <> 'withdrawn') — register
 *     composition computed live, never stored redundantly, per §7.27.3's
 *     own design note.
 *   loadCourseAttendanceSessions() — existing contact-hour session rows for
 *     an offering (the date picker / "session N of M" list).
 *   loadCourseAttendanceRecords()  — marks for one course_attendance_session.
 *   loadAttendanceEligibility()    — computed present/total % for one
 *     student on one offering, checked against the offering's own
 *     attendance_eligibility_threshold_pct (nullable — no hardcoded 75%).
 *
 * Write exports (mirrors attendanceService.ts's three-function family):
 *   ensureCourseAttendanceSession() — get-or-create today's (or a given
 *     date's) session row for an offering; refuses to create one on a
 *     non-school day (isSchoolDay(), reused from attendanceService.ts
 *     as-is, not re-implemented — per SESSION 58's own card instruction).
 *   saveCourseAttendanceRecord()   — upsert one student's mark; offline-
 *     queue aware, same contract as saveAttendanceRecord().
 *   saveBatchCourseAttendance()    — mark-all, same contract as
 *     saveBatchAttendance().
 *   flushCourseAttendanceQueue()   — drains the offline queue, same
 *     contract as flushAttendanceQueue().
 *
 * Pure helpers:
 *   buildCourseAttendanceMap()     — index records by studentId, mirrors
 *     buildAttendanceMap() exactly.
 *   getCourseAttendanceSummary()   — present/absent/excused/late counts,
 *     mirrors getAttendanceSummary() exactly.
 */

import { supabase } from '../lib/supabase'
import { queueWrite, getQueue, clearFromQueue } from '../lib/offlineQueue'
import { isSchoolDay } from './attendanceService'

// ─── Types ──────────────────────────────────────────────────────────────────

// Same status set as attendance_records / course_attendance_records' own
// check constraint — not redeclared as a new union, reused verbatim so a
// value can never silently diverge between the two attendance families.
export type CourseAttendanceStatus = 'present' | 'absent' | 'excused' | 'late'

export interface CourseOffering {
  id: string
  course_id: string
  course_code: string
  course_title: string
  credit_units: number
  session_id: string
  term_id: string | null
  staff_id: string | null
  staff_name: string | null
  attendance_eligibility_threshold_pct: number | null
}

export interface RegisteredStudent {
  student_id: string
  student_name: string
  student_matric_number: string | null
  registration_id: string   // course_registrations.id — not written back to,
                             // but kept for traceability / future carryover
                             // cross-reference (e.g. a lecturer wanting to
                             // see "is this student here on a carryover?")
  is_carryover: boolean
}

export interface CourseAttendanceSession {
  id: string
  course_offering_id: string
  session_date: string   // 'YYYY-MM-DD'
  week_number: number | null
}

export interface CourseAttendanceRecord {
  id: string
  course_attendance_session_id: string
  student_id: string
  status: CourseAttendanceStatus
  marked_by: string   // staff.id
}

// Keyed by studentId — mirrors AttendanceMap exactly.
export type CourseAttendanceMap = Map<string, CourseAttendanceRecord>

export interface CourseAttendanceEligibility {
  studentId: string
  totalSessions: number
  presentCount: number      // 'present' + 'late' both count as attended —
                             // matches this school's own status semantics
                             // (late is still attendance, just tardy); a
                             // school with a different policy can configure
                             // via the threshold itself, not by redefining
                             // what "present" means here
  percent: number | null    // null when totalSessions === 0 — no sessions
                             // held yet, not 0% (0% would wrongly read as
                             // "attended none of many," not "none held yet")
  thresholdPct: number | null   // from course_offerings — nullable, no
                                 // hardcoded fallback such as 75%
  meetsThreshold: boolean | null   // null when either percent or threshold
                                    // is null — "not yet determinable," not
                                    // a silent false
}

// What the write path needs — mirrors AttendanceUpsertParams exactly.
export interface CourseAttendanceUpsertParams {
  courseAttendanceSessionId: string
  studentId: string
  markedBy: string   // staff.id of the person marking
  status: CourseAttendanceStatus
}

// Result shape — mirrors attendanceService.ts's Result<T> exactly, not
// courseRegistrationService.ts's {data, error} shape. See file header.
type Ok<T> = { ok: true; data: T }
type Err = { ok: false; error: string }
type Result<T> = Ok<T> | Err

// ─── Course offerings (picker) ─────────────────────────────────────────────

/**
 * Offerings a lecturer is assigned to (staff_id match on course_offerings),
 * or every offering in the school for an admin — the register picker's
 * source list, playing the role loadAllLeafClasses() plays for the
 * secondary-attendance module.
 *
 * schoolId scopes via courses.school_id (course_offerings itself carries no
 * school_id column, same non-redundant-scoping shape course_registrations
 * already uses) — RLS also enforces this independently, this filter is
 * belt-and-braces, matching courseRegistrationService.ts's own stated
 * convention of always threading schoolId explicitly rather than relying on
 * RLS alone to narrow a list-shaped query.
 */
export async function loadCourseOfferingsForStaff(params: {
  schoolId: string
  staffId: string
  isAdmin: boolean
  sessionId: string
}): Promise<Result<CourseOffering[]>> {
  try {
    let query = supabase
      .from('course_offerings')
      .select(`
        id, course_id, session_id, term_id, staff_id,
        attendance_eligibility_threshold_pct,
        courses!inner ( code, title, credit_units, school_id ),
        staff ( full_name )
      `)
      .eq('session_id', params.sessionId)
      .eq('courses.school_id', params.schoolId)

    if (!params.isAdmin) {
      query = query.eq('staff_id', params.staffId)
    }

    const { data, error } = await query

    if (error) return { ok: false, error: error.message }

    const offerings: CourseOffering[] = (data ?? []).map((row: any) => {
      const course = Array.isArray(row.courses) ? row.courses[0] : row.courses
      const staff = Array.isArray(row.staff) ? row.staff[0] : row.staff
      return {
        id: row.id,
        course_id: row.course_id,
        course_code: course?.code ?? '',
        course_title: course?.title ?? '',
        credit_units: course?.credit_units ?? 0,
        session_id: row.session_id,
        term_id: row.term_id ?? null,
        staff_id: row.staff_id ?? null,
        staff_name: staff?.full_name ?? null,
        attendance_eligibility_threshold_pct: row.attendance_eligibility_threshold_pct ?? null,
      }
    })

    return { ok: true, data: offerings }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load course offerings' }
  }
}

// ─── Registered students (register composition) ───────────────────────────

/**
 * Students with a LIVE course_registrations row for this offering —
 * computed live from course_registrations (matched on course_id + session_id
 * + term_id, the same tuple course_offerings itself is keyed on), never
 * stored redundantly, per §7.27.3's own explicit design note. status <>
 * 'withdrawn' excludes anyone who dropped the course after registering —
 * a withdrawn student should not appear on the register at all, not appear
 * greyed-out (this school's course_registrations has no soft-delete-visible
 * state for "was here, isn't anymore" beyond the status column itself).
 *
 * Ordered alphabetically, matching loadStudentsForClass()'s own convention.
 */
export async function loadRegisteredStudents(
  courseOfferingId: string,
): Promise<Result<RegisteredStudent[]>> {
  try {
    const { data: offering, error: offeringErr } = await supabase
      .from('course_offerings')
      .select('course_id, session_id, term_id')
      .eq('id', courseOfferingId)
      .maybeSingle()

    if (offeringErr) return { ok: false, error: offeringErr.message }
    if (!offering) return { ok: false, error: 'Course offering not found.' }

    let query = supabase
      .from('course_registrations')
      .select(`
        id, is_carryover,
        students ( id, full_name, matric_number )
      `)
      .eq('course_id', offering.course_id)
      .eq('session_id', offering.session_id)
      .neq('status', 'withdrawn')

    // term_id nullability follows §7.4's own established fallback: match it
    // exactly (including matching null-to-null) rather than using .eq() on
    // a possibly-null value, which would silently exclude every term-less
    // registration — the same nullable-term_id convention course_registrations
    // itself already documents.
    query = offering.term_id
      ? query.eq('term_id', offering.term_id)
      : query.is('term_id', null)

    const { data, error } = await query

    if (error) return { ok: false, error: error.message }

    const students: RegisteredStudent[] = (data ?? [])
      .map((row: any) => {
        const student = Array.isArray(row.students) ? row.students[0] : row.students
        if (!student) return null
        return {
          student_id: student.id,
          student_name: student.full_name,
          student_matric_number: student.matric_number ?? null,
          registration_id: row.id,
          is_carryover: !!row.is_carryover,
        }
      })
      .filter((s: RegisteredStudent | null): s is RegisteredStudent => s !== null)
      .sort((a: RegisteredStudent, b: RegisteredStudent) => a.student_name.localeCompare(b.student_name))

    return { ok: true, data: students }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load registered students' }
  }
}

// ─── Attendance sessions (contact-hours) ───────────────────────────────────

/**
 * Existing course_attendance_sessions rows for an offering, most recent
 * first — the "which lecture/date am I marking" list.
 */
export async function loadCourseAttendanceSessions(
  courseOfferingId: string,
): Promise<Result<CourseAttendanceSession[]>> {
  try {
    const { data, error } = await supabase
      .from('course_attendance_sessions')
      .select('id, course_offering_id, session_date, week_number')
      .eq('course_offering_id', courseOfferingId)
      .order('session_date', { ascending: false })

    if (error) return { ok: false, error: error.message }
    return { ok: true, data: (data ?? []) as CourseAttendanceSession[] }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load attendance sessions' }
  }
}

/**
 * Get-or-create the course_attendance_session row for a given offering+date.
 * Refuses to create one on a non-school day — reuses isSchoolDay() from
 * attendanceService.ts exactly as-is (imported, not re-implemented), per
 * SESSION 58's own card instruction. week_number is left null on create —
 * this schema has no term/session-relative week-numbering source of truth
 * to derive it from automatically (unlike total_weeks elsewhere in this
 * project, which is teacher-set, not derived); a future session can add
 * that if a real need surfaces, not invented speculatively here.
 *
 * Returns the existing row untouched if one already exists for this
 * offering+date. A real unique constraint on (course_offering_id,
 * session_date) — added via migration_session_58b.sql, 2026-07-14, a
 * follow-up found while writing this function — makes the get-or-create
 * pattern genuinely race-safe, not just safe under normal single-user
 * retry via the maybeSingle() check above.
 */
export async function ensureCourseAttendanceSession(params: {
  courseOfferingId: string
  date: string
  schoolId: string
}): Promise<Result<CourseAttendanceSession>> {
  try {
    const { data: existing, error: existingErr } = await supabase
      .from('course_attendance_sessions')
      .select('id, course_offering_id, session_date, week_number')
      .eq('course_offering_id', params.courseOfferingId)
      .eq('session_date', params.date)
      .maybeSingle()

    if (existingErr) return { ok: false, error: existingErr.message }
    if (existing) return { ok: true, data: existing as CourseAttendanceSession }

    const dayCheck = await isSchoolDay(params.date, params.schoolId)
    if (!dayCheck.ok) return { ok: false, error: dayCheck.error }
    if (!dayCheck.data.isSchoolDay) {
      return {
        ok: false,
        error: dayCheck.data.label
          ? `${params.date} is marked as a non-school day (${dayCheck.data.label}) on the school calendar.`
          : `${params.date} is not a school day on the school calendar.`,
      }
    }

    const { data: created, error: createErr } = await supabase
      .from('course_attendance_sessions')
      .insert({
        course_offering_id: params.courseOfferingId,
        session_date: params.date,
        week_number: null,
      })
      .select('id, course_offering_id, session_date, week_number')
      .single()

    if (createErr) return { ok: false, error: createErr.message }
    return { ok: true, data: created as CourseAttendanceSession }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to open attendance session' }
  }
}

// ─── Attendance records ────────────────────────────────────────────────────

export async function loadCourseAttendanceRecords(
  courseAttendanceSessionId: string,
): Promise<Result<CourseAttendanceRecord[]>> {
  try {
    const { data, error } = await supabase
      .from('course_attendance_records')
      .select('id, course_attendance_session_id, student_id, status, marked_by')
      .eq('course_attendance_session_id', courseAttendanceSessionId)

    if (error) return { ok: false, error: error.message }
    return { ok: true, data: (data ?? []) as CourseAttendanceRecord[] }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load attendance records' }
  }
}

// ─── Write: single record ──────────────────────────────────────────────────
// Mirrors saveAttendanceRecord() exactly — same optimistic-UI contract, same
// network-vs-RLS error distinction, same offline-queue behavior. The real
// (course_attendance_session_id, student_id) unique constraint (added to
// this table specifically so this pattern would work — see migration_
// session_58.sql and master-plan §7.27.3) makes onConflict genuinely safe
// to re-call on tap, same guarantee attendance_records' own
// (school_id, student_id, date) constraint provides for the original.

export async function saveCourseAttendanceRecord(
  params: CourseAttendanceUpsertParams,
): Promise<{ ok: boolean; queued?: boolean; error?: string }> {
  const payload: Record<string, unknown> = {
    course_attendance_session_id: params.courseAttendanceSessionId,
    student_id: params.studentId,
    status: params.status,
    marked_by: params.markedBy,
  }

  try {
    const { error } = await supabase
      .from('course_attendance_records')
      .upsert(payload, {
        onConflict: 'course_attendance_session_id,student_id',
      })

    if (error) {
      if (isNetworkError(error.message)) {
        queueWrite('course_attendance_records', 'insert', payload)
        return { ok: true, queued: true }
      }
      return { ok: false, error: friendlyError(error.message) }
    }

    return { ok: true }
  } catch (err: any) {
    queueWrite('course_attendance_records', 'insert', payload)
    return { ok: true, queued: true }
  }
}

// ─── Write: batch (mark-all) ───────────────────────────────────────────────
// Mirrors saveBatchAttendance() exactly.

export async function saveBatchCourseAttendance(params: {
  records: CourseAttendanceUpsertParams[]
}): Promise<{ ok: boolean; queued?: boolean; error?: string }> {
  if (params.records.length === 0) return { ok: true }

  const rows = params.records.map(p => ({
    course_attendance_session_id: p.courseAttendanceSessionId,
    student_id: p.studentId,
    status: p.status,
    marked_by: p.markedBy,
  }))

  try {
    const { error } = await supabase
      .from('course_attendance_records')
      .upsert(rows, {
        onConflict: 'course_attendance_session_id,student_id',
      })

    if (error) {
      if (isNetworkError(error.message)) {
        rows.forEach(row => queueWrite('course_attendance_records', 'insert', row))
        return { ok: true, queued: true }
      }
      return { ok: false, error: friendlyError(error.message) }
    }

    return { ok: true }
  } catch (err: any) {
    rows.forEach(row => queueWrite('course_attendance_records', 'insert', row))
    return { ok: true, queued: true }
  }
}

// ─── Flush offline queue ───────────────────────────────────────────────────
// Mirrors flushAttendanceQueue() exactly.

export async function flushCourseAttendanceQueue(): Promise<{
  flushed: number
  failed: Array<{ payload: Record<string, unknown>; error: string }>
}> {
  const pending = getQueue().filter(item => item.table === 'course_attendance_records')

  let flushed = 0
  const failed: Array<{ payload: Record<string, unknown>; error: string }> = []

  for (const item of pending) {
    try {
      const { error } = await supabase
        .from('course_attendance_records')
        .upsert(item.payload as Record<string, unknown>, {
          onConflict: 'course_attendance_session_id,student_id',
        })

      if (error) {
        failed.push({ payload: item.payload, error: friendlyError(error.message) })
      } else {
        clearFromQueue(item.id)
        flushed++
      }
    } catch (err: any) {
      break
    }
  }

  return { flushed, failed }
}

// ─── Attendance eligibility ────────────────────────────────────────────────

/**
 * Computed present/total % for one student on one offering, checked against
 * that offering's own attendance_eligibility_threshold_pct. 'present' and
 * 'late' both count toward presentCount (see CourseAttendanceEligibility's
 * own doc comment for why); 'excused' does not count as present but is also
 * not counted as a negative mark either way — this function only reports
 * the raw present/total ratio, deliberately not building excused-aware
 * policy branches (e.g. "excused absences don't count against you") that
 * were never specified anywhere in §7.27.3 or the PRD — informational only
 * this session, not yet wired to block exam entry, exactly as SESSION 58's
 * card states.
 */
export async function loadAttendanceEligibility(params: {
  courseOfferingId: string
  studentId: string
}): Promise<Result<CourseAttendanceEligibility>> {
  try {
    const { data: offering, error: offeringErr } = await supabase
      .from('course_offerings')
      .select('attendance_eligibility_threshold_pct')
      .eq('id', params.courseOfferingId)
      .maybeSingle()

    if (offeringErr) return { ok: false, error: offeringErr.message }
    if (!offering) return { ok: false, error: 'Course offering not found.' }

    const { data: sessions, error: sessionsErr } = await supabase
      .from('course_attendance_sessions')
      .select('id')
      .eq('course_offering_id', params.courseOfferingId)

    if (sessionsErr) return { ok: false, error: sessionsErr.message }

    const sessionIds = (sessions ?? []).map((s: any) => s.id)
    const totalSessions = sessionIds.length

    if (totalSessions === 0) {
      return {
        ok: true,
        data: {
          studentId: params.studentId,
          totalSessions: 0,
          presentCount: 0,
          percent: null,
          thresholdPct: offering.attendance_eligibility_threshold_pct ?? null,
          meetsThreshold: null,
        },
      }
    }

    const { data: records, error: recordsErr } = await supabase
      .from('course_attendance_records')
      .select('status')
      .eq('student_id', params.studentId)
      .in('course_attendance_session_id', sessionIds)

    if (recordsErr) return { ok: false, error: recordsErr.message }

    const presentCount = (records ?? []).filter(
      (r: any) => r.status === 'present' || r.status === 'late',
    ).length

    const percent = Math.round((presentCount / totalSessions) * 1000) / 10
    const thresholdPct = offering.attendance_eligibility_threshold_pct ?? null
    const meetsThreshold = thresholdPct === null ? null : percent >= thresholdPct

    return {
      ok: true,
      data: {
        studentId: params.studentId,
        totalSessions,
        presentCount,
        percent,
        thresholdPct,
        meetsThreshold,
      },
    }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to compute attendance eligibility' }
  }
}

// ─── Cross-course attendance summary (one student, all offerings) ─────────

export interface StudentOverallAttendance {
  totalSessions: number       // summed across every course the student is
                               // currently (non-withdrawn) registered for
  presentCount: number        // 'present' + 'late', same semantics as
                               // loadAttendanceEligibility() above
  percent: number | null      // null when totalSessions === 0 — no sessions
                               // held yet across any course, not 0%
  courseCount: number         // how many distinct offerings fed this number
                               // — shown alongside the percent so a 100% on
                               // one course doesn't read as "everything," if
                               // e.g. the student has 3 registrations but
                               // only 1 course has held any sessions yet
}

/**
 * Rolls up a student's attendance across every course they're currently
 * registered for (status <> 'withdrawn'), for the current session — the
 * cross-course number a student-detail summary card needs, which nothing
 * else in this file computes (loadAttendanceEligibility() above is
 * deliberately per-offering, for the lecturer-facing eligibility badge).
 *
 * Built from the same three real tables loadAttendanceEligibility() reads
 * (course_registrations → course_attendance_sessions →
 * course_attendance_records), just fanned out across every live
 * registration instead of one. No new table, no new policy — course_
 * registrations already grants student self-read (§7.27.2), and this
 * function is called from an admin/staff context here regardless.
 *
 * sessionId is required (not optional) because course_registrations has no
 * meaningful "current" concept without it — matching every other query in
 * this file that scopes through course_offerings' own session_id/term_id.
 */
export async function loadStudentOverallAttendance(params: {
  studentId: string
  sessionId: string
}): Promise<Result<StudentOverallAttendance>> {
  try {
    const { data: registrations, error: regErr } = await supabase
      .from('course_registrations')
      .select('course_id')
      .eq('student_id', params.studentId)
      .eq('session_id', params.sessionId)
      .neq('status', 'withdrawn')

    if (regErr) return { ok: false, error: regErr.message }

    const courseIds = Array.from(new Set((registrations ?? []).map((r: any) => r.course_id)))
    if (courseIds.length === 0) {
      return {
        ok: true,
        data: { totalSessions: 0, presentCount: 0, percent: null, courseCount: 0 },
      }
    }

    const { data: offerings, error: offErr } = await supabase
      .from('course_offerings')
      .select('id')
      .eq('session_id', params.sessionId)
      .in('course_id', courseIds)

    if (offErr) return { ok: false, error: offErr.message }

    const offeringIds = (offerings ?? []).map((o: any) => o.id)
    if (offeringIds.length === 0) {
      return {
        ok: true,
        data: { totalSessions: 0, presentCount: 0, percent: null, courseCount: courseIds.length },
      }
    }

    const { data: sessions, error: sessErr } = await supabase
      .from('course_attendance_sessions')
      .select('id')
      .in('course_offering_id', offeringIds)

    if (sessErr) return { ok: false, error: sessErr.message }

    const sessionIds = (sessions ?? []).map((s: any) => s.id)
    const totalSessions = sessionIds.length

    if (totalSessions === 0) {
      return {
        ok: true,
        data: { totalSessions: 0, presentCount: 0, percent: null, courseCount: courseIds.length },
      }
    }

    const { data: records, error: recErr } = await supabase
      .from('course_attendance_records')
      .select('status')
      .eq('student_id', params.studentId)
      .in('course_attendance_session_id', sessionIds)

    if (recErr) return { ok: false, error: recErr.message }

    const presentCount = (records ?? []).filter(
      (r: any) => r.status === 'present' || r.status === 'late',
    ).length

    const percent = Math.round((presentCount / totalSessions) * 1000) / 10

    return {
      ok: true,
      data: { totalSessions, presentCount, percent, courseCount: courseIds.length },
    }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load overall attendance' }
  }
}

// ─── Pure helpers ───────────────────────────────────────────────────────────
// Mirror buildAttendanceMap()/getAttendanceSummary() exactly.

export function buildCourseAttendanceMap(records: CourseAttendanceRecord[]): CourseAttendanceMap {
  const map: CourseAttendanceMap = new Map()
  for (const r of records) {
    map.set(r.student_id, r)
  }
  return map
}

export function getCourseAttendanceSummary(map: CourseAttendanceMap): {
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

// ─── Internal utilities ─────────────────────────────────────────────────────
// Mirrors attendanceService.ts's own internal helpers exactly.

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
  if (message.includes('violates row-level security')) {
    return "You don't have permission to mark attendance for this course."
  }
  if (message.includes('violates foreign key')) {
    return 'Student or session record not found. Please refresh and try again.'
  }
  if (message.includes('violates unique constraint')) {
    return 'Record already exists. Please refresh and try again.'
  }
  return 'Failed to save attendance. Please try again.'
}
