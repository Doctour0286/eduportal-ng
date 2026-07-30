/**
 * courseOfferingTimetableService.ts
 * Data access layer for the higher-ed course-offering timetable
 * (PRD Tier 8 / Problem 8.7a, SESSION 68).
 *
 * Deliberately a separate service from timetableService.ts, not an
 * extension of it — mirrors the same "parallel schema, not a bolt-on"
 * discipline §7.27's header already established for the rest of the
 * higher-ed model (course_registrations vs class_nodes, course_results vs
 * scores, etc). course_offering_timetable_entries has its own time-range
 * shape (own start_time/end_time per row, no periods FK — see §7.27.6's
 * reasoning) and its own anchor object (course_offering_id, not
 * class_node_id + period_id), so sharing one file with the secondary
 * timetable's period-grid logic would force an artificial common shape
 * neither domain actually has.
 *
 * Result<T> shape and offering-picker pattern both deliberately match
 * courseAttendanceService.ts's own conventions (loadCourseOfferingsForStaff,
 * the courses!inner school-scoping join, the Ok/Err discriminated union) —
 * this is the same conceptual family (a lecturer viewing/managing something
 * scoped to their own course offerings), so the same shape is reused, not
 * re-derived. Uses {data, error} instead only where directly wrapping
 * settingsService.ts's own upsert/delete functions' existing shape, which
 * this file does NOT do — its own writes are original to this file, so
 * they follow Result<T> throughout for internal consistency.
 *
 * No browser-only APIs. No UI imports. React Native compatible.
 *
 * Read exports:
 *   loadOfferingTimetable()      — every course_offering_timetable_entries
 *     row for a set of offering ids, joined for display (course code/title,
 *     lecturer name) — the single query TimetableModuleHigherEd's admin,
 *     lecturer, and student views all read from, filtered client-side by
 *     which offerings each view cares about (mirrors timetableService.ts's
 *     own loadTimetableData() — one broad load, filtered in memory, not a
 *     separate query per view).
 *   loadOfferingsForTimetableAdmin() — every offering in the school for the
 *     given session/term, for the admin setup picker (thin wrapper over
 *     settingsService.ts's loadCourseOfferings(), re-exported under this
 *     file's own Result<T> shape so admin-setup callers don't need to
 *     import two different result conventions in the same component).
 *   loadOfferingsForLecturer()   — offerings a given lecturer is assigned to
 *     — thin wrapper over courseAttendanceService.ts's own
 *     loadCourseOfferingsForStaff(), reused as-is rather than re-queried,
 *     since it already does exactly this (staff_id match, admin-sees-all).
 *   loadOfferingsForStudent()    — offerings a given student is currently
 *     registered for (status <> 'withdrawn'), scoped to the current
 *     session/term — the student timetable view's source list.
 *
 * Write exports (admin setup only):
 *   upsertOfferingTimetableEntry() — create or update one day/time/venue
 *     slot for a course offering.
 *   deleteOfferingTimetableEntry() — remove one slot.
 *   assignOfferingLecturer()     — TIER 9 / PROBLEM (owner walkthrough,
 *     2026-07-30): reassign a course offering's staff_id from directly
 *     inside the timetable's add/edit-slot form, for the case where an
 *     offering was set up with no lecturer yet. Thin wrapper over
 *     settingsService.ts's own upsertCourseOffering() — deliberately reads
 *     the full existing CourseOffering row and re-sends every field
 *     unchanged except staff_id, since upsertCourseOffering()'s update
 *     path is a full-row write (a partial payload would silently null out
 *     programme_id/programme_level_id/attendance_eligibility_threshold_pct
 *     on every reassignment) — not a new write primitive, no schema change.
 *
 * Schedule-tab sync (TIER 9 / PROBLEM, owner walkthrough 2026-07-30):
 *   loadPeriodsForTimetable()    — thin wrapper over settingsService.ts's
 *     loadPeriods(), re-exported under this file's own Period name so the
 *     add/edit-slot form can offer the school's already-configured Schedule-
 *     tab periods as a pick-a-period shortcut (auto-filling start/end time)
 *     without a second admin having to duplicate that setup here. Does NOT
 *     change course_offering_timetable_entries' own schema or storage —
 *     Section 7.27.6's "no periods FK, native start_time/end_time per row"
 *     decision stands, since one offering can still legitimately meet at a
 *     time that matches no saved period (a 2-hour block spanning two
 *     periods, a one-off makeup class). A period is offered as a
 *     convenience default that pre-fills the same two time inputs already
 *     on the form, never a constraint — manual override after picking (or
 *     instead of picking) remains fully supported, matching every other
 *     soft-default precedent in this codebase rather than forcing every
 *     slot to snap to one of a fixed list.
 *   loadLecturersForAssignment() — thin wrapper over settingsService.ts's
 *     loadStaffWithRoles(), narrowed to {id, full_name}, active staff only
 *     — the data source for the in-form lecturer picker when an offering
 *     has no staff_id yet.
 *
 * Pure helpers:
 *   findLecturerConflicts()      — which loaded entries double-book a
 *     lecturer (same staff_id, same day_of_week, overlapping time range).
 *     Mirrors timetableService.ts's findConflictingEntryIds() in spirit
 *     (a live, in-memory computation, not a stored flag — §7.12's
 *     precedent, restated for §7.27.6 in the schema notes) but keyed on
 *     time-range OVERLAP rather than exact period_id equality, since this
 *     table has no discrete period to compare — two ranges conflict when
 *     start_a < end_b AND start_b < end_a, the standard interval-overlap
 *     test, not naive boundary equality (which would miss a genuine
 *     partial overlap, e.g. 9:00-11:00 vs 10:00-12:00).
 *   findCohortConflicts()        — SESSION 69. A different category from
 *     findLecturerConflicts(): a lecturer double-booking is a certain
 *     fact; a cohort clash (two offerings at the same programme_level_id,
 *     overlapping time) only *possibly* affects overlapping students,
 *     depending on each offering's course's requirement_type
 *     (core/elective) on that level's curriculum. Three severities —
 *     'core' (every student at the level affected), 'elective' (only
 *     students registered for both), 'unknown' (the course isn't on any
 *     programme_curriculum row for that level/term, so impact can't be
 *     determined) — all soft, confirm-to-proceed warnings, never a block,
 *     differentiated only by wording so the admin has one interaction
 *     model to learn, not three. Requires loadCurriculumSeverity() to
 *     resolve requirement_type per (course_id, programme_level_id,
 *     term_id) — deliberately scoped to all three together, never
 *     course_id alone, per the fan-out trap already found and fixed once
 *     in courseRegistrationService.ts's loadCurriculum() (PRD SESSION 57
 *     on-device finding) — restated here as a standing rule for this
 *     table family, not re-derived from scratch.
 */

import { supabase } from '../lib/supabase'
import {
  loadCourseOfferings as loadCourseOfferingsAdmin,
  upsertCourseOffering,
  loadPeriods,
  loadStaffWithRoles,
  type CourseOffering as AdminCourseOffering,
  type Period as SchedulePeriod,
} from './settingsService'
import { loadCourseOfferingsForStaff } from './courseAttendanceService'

// ─── Result shape — matches courseAttendanceService.ts's own convention ──────

type Ok<T> = { ok: true; data: T }
type Err = { ok: false; error: string }
type Result<T> = Ok<T> | Err

// ─── Types ────────────────────────────────────────────────────────────────

export interface OfferingTimetableEntry {
  id: string
  course_offering_id: string
  course_id: string
  course_code: string
  course_title: string
  staff_id: string | null
  staff_name: string | null
  // SESSION 69: carried straight through from course_offerings for cohort
  // clash grouping (findCohortConflicts() below) — both null is a real,
  // permanent state (unassigned or genuinely shared offering, §7.27.2
  // amendment), not an error; entries with either null are simply excluded
  // from cohort grouping, since there is no level to group them under.
  programme_id: string | null
  programme_level_id: string | null
  term_id: string | null
  day_of_week: number   // 0=Sun … 6=Sat, same convention as §7.10/§7.12
  start_time: string    // 'HH:MM:SS'
  end_time: string
  venue: string | null
}

// Re-exported under this file's own name so callers only ever import one
// CourseOffering shape from this file, rather than reaching into
// settingsService.ts directly and risking a second, slightly-different
// local type creeping in (the exact drift this project's own precedent —
// e.g. §7.27.2's course_registrations self-read policy copy-paste bug —
// has been caught doing more than once).
export type CourseOffering = AdminCourseOffering

// Re-exported the same way as CourseOffering above, so a caller only ever
// imports one Period shape from this file rather than reaching into
// settingsService.ts directly for it.
export type Period = SchedulePeriod

const DAY_NAMES_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DAY_NAMES_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export function dayName(dayOfWeek: number, short = false): string {
  return short ? DAY_NAMES_SHORT[dayOfWeek] : DAY_NAMES_FULL[dayOfWeek]
}

// ─── Load timetable entries for a set of offerings ───────────────────────
//
// One query for every entry belonging to the given offering ids, joined for
// display. Callers (admin/lecturer/student views) each pass in whichever
// offering-id list is relevant to them — the query itself doesn't know or
// care which view is asking, matching timetableService.ts's own "one load,
// filtered client-side per view" shape rather than three separate queries.

export async function loadOfferingTimetable(
  courseOfferingIds: string[],
): Promise<Result<OfferingTimetableEntry[]>> {
  if (courseOfferingIds.length === 0) {
    // Empty-array-means-no-filter is a real Postgrest trap this project has
    // been bitten by before (SESSION 64's studentsService.ts fix) — guard
    // explicitly rather than let .in('course_offering_id', []) silently
    // return every row in the table.
    return { ok: true, data: [] }
  }

  try {
    const { data, error } = await supabase
      .from('course_offering_timetable_entries')
      .select(`
        id, course_offering_id, day_of_week, start_time, end_time, venue,
        course_offerings (
          course_id, staff_id, term_id, programme_id, programme_level_id,
          courses ( code, title ),
          staff ( full_name )
        )
      `)
      .in('course_offering_id', courseOfferingIds)
      .order('day_of_week')
      .order('start_time')

    if (error) return { ok: false, error: error.message }

    const entries: OfferingTimetableEntry[] = (data ?? []).map((row: any) => {
      const offering = Array.isArray(row.course_offerings) ? row.course_offerings[0] : row.course_offerings
      const course = Array.isArray(offering?.courses) ? offering.courses[0] : offering?.courses
      const staff = Array.isArray(offering?.staff) ? offering.staff[0] : offering?.staff
      return {
        id: row.id,
        course_offering_id: row.course_offering_id,
        course_id: offering?.course_id ?? '',
        course_code: course?.code ?? '',
        course_title: course?.title ?? '',
        staff_id: offering?.staff_id ?? null,
        staff_name: staff?.full_name ?? null,
        programme_id: offering?.programme_id ?? null,
        programme_level_id: offering?.programme_level_id ?? null,
        term_id: offering?.term_id ?? null,
        day_of_week: row.day_of_week,
        start_time: row.start_time,
        end_time: row.end_time,
        venue: row.venue ?? null,
      }
    })

    return { ok: true, data: entries }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load the timetable' }
  }
}

// ─── Offering pickers, one per audience ──────────────────────────────────

// Admin setup screen — every offering in the school for a session/term.
// Thin wrapper over settingsService.ts's real, already-working
// loadCourseOfferings(), re-shaped into this file's Result<T> convention
// rather than re-queried, per this file's own stated reuse discipline.
export async function loadOfferingsForTimetableAdmin(
  sessionId: string,
  termId?: string | null,
): Promise<Result<CourseOffering[]>> {
  const { data, error } = await loadCourseOfferingsAdmin(sessionId, termId ?? undefined)
  if (error) return { ok: false, error }
  return { ok: true, data }
}

// Lecturer's own timetable — thin wrapper over courseAttendanceService.ts's
// loadCourseOfferingsForStaff(), reused as-is (staff_id match, admin sees
// every offering) rather than re-implemented, since it already does exactly
// this lookup for the same actor/offering relationship.
export async function loadOfferingsForLecturer(params: {
  schoolId: string
  staffId: string
  isAdmin: boolean
  sessionId: string
}): Promise<Result<CourseOffering[]>> {
  const res = await loadCourseOfferingsForStaff(params)
  if (!res.ok) return res
  // courseAttendanceService.ts's CourseOffering carries one extra field
  // (credit_units) this file's re-exported type doesn't declare — narrowing
  // here rather than widening this file's own type for a field the
  // timetable view never displays.
  return { ok: true, data: res.data }
}

// Student's own timetable — offerings the student currently holds a live
// (non-withdrawn) course_registrations row for, scoped to session/term the
// same way loadRegisteredStudents() (courseAttendanceService.ts) scopes the
// reverse direction (offering -> students). Deliberately queried directly
// here rather than reusing a courseAttendanceService.ts export, since no
// existing function returns "this student's offerings" — the closest is
// the opposite direction (an offering's registered students).
export async function loadOfferingsForStudent(params: {
  studentId: string
  sessionId: string
  termId?: string | null
}): Promise<Result<CourseOffering[]>> {
  try {
    // FIX (confirmed on-device, 2026-07-23): the previous version of this
    // query embedded course_offerings directly off course_registrations
    // via `course_offerings!inner (...)`. PostgREST's `!inner`/`!left` embed
    // syntax can only auto-join across a REAL declared foreign key -- and
    // per this schema's own DDL (master plan §7.27.2), course_registrations
    // has no such column at all: its only FKs are student_id, course_id,
    // session_id, term_id, and a self-FK (original_registration_id). The
    // real relationship to course_offerings is via course_id (+
    // session_id/term_id), a composite match, which PostgREST cannot
    // auto-detect for an embed -- confirmed live via the "Could not find a
    // relationship between 'course_registrations' and 'course_offerings' in
    // the schema cache" error, surfaced for the first time once
    // GuardianPortal.tsx's Schedule tab was wired to actually call this
    // function. Fixed by resolving the two tables in two steps instead of
    // one embedded query: (1) which course_ids is this student registered
    // for this session/term, (2) which course_offerings match those
    // course_ids for the same session/term. No new FK added to the schema
    // -- course_offerings has none of its own (§7.27.2's own RLS note:
    // "unlike course_offerings, which has none of its own [school_id]"),
    // matching that table's existing join-based-scoping precedent rather
    // than introducing a direct FK this session didn't call for.

    let regQuery = supabase
      .from('course_registrations')
      .select('course_id')
      .eq('student_id', params.studentId)
      .eq('session_id', params.sessionId)
      .neq('status', 'withdrawn')

    regQuery = params.termId
      ? regQuery.eq('term_id', params.termId)
      : regQuery.is('term_id', null)

    const { data: regRows, error: regErr } = await regQuery
    if (regErr) return { ok: false, error: regErr.message }

    const courseIds = Array.from(
      new Set((regRows ?? []).map((r: { course_id: string }) => r.course_id))
    )
    if (courseIds.length === 0) return { ok: true, data: [] }

    let offeringsQuery = supabase
      .from('course_offerings')
      .select(`
        id, course_id, session_id, term_id, staff_id,
        programme_id, programme_level_id,
        attendance_eligibility_threshold_pct,
        courses ( code, title ),
        staff ( full_name )
      `)
      .in('course_id', courseIds)
      .eq('session_id', params.sessionId)

    offeringsQuery = params.termId
      ? offeringsQuery.eq('term_id', params.termId)
      : offeringsQuery.is('term_id', null)

    const { data, error } = await offeringsQuery
    if (error) return { ok: false, error: error.message }

    const offerings: CourseOffering[] = (data ?? [])
      .map((offering: any): CourseOffering | null => {
        if (!offering) return null
        const course = Array.isArray(offering.courses) ? offering.courses[0] : offering.courses
        const staff = Array.isArray(offering.staff) ? offering.staff[0] : offering.staff
        return {
          id: offering.id,
          course_id: offering.course_id,
          course_code: course?.code ?? '',
          course_title: course?.title ?? '',
          session_id: offering.session_id,
          term_id: offering.term_id ?? null,
          staff_id: offering.staff_id ?? null,
          staff_name: staff?.full_name ?? null,
          programme_id: offering.programme_id ?? null,
          programme_level_id: offering.programme_level_id ?? null,
          attendance_eligibility_threshold_pct:
            offering.attendance_eligibility_threshold_pct === null
              ? null
              : Number(offering.attendance_eligibility_threshold_pct),
        }
      })
      .filter((o: CourseOffering | null): o is CourseOffering => o !== null)

    return { ok: true, data: offerings }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load your timetable' }
  }
}

// ─── Student's own weekly schedule, read-only, list-shaped ─────────────────
//
// Owner request (2026-07-23): rather than reuse TimetableModuleHigherEd's
// full grid+edit+Modal component tree inside GuardianPortal.tsx (which is
// what surfaced the stuck-tab/stray-modal bug fixed this session — see
// App.tsx's own key= fix note on its four GuardianPortal call sites), fetch
// only the fields a read-only student view actually needs (day, course,
// time, lecturer, venue) and let GuardianPortal render its own dedicated
// UI. This function composes the two already-correct, already-shipped
// pieces above rather than introducing a third query shape:
//   1. loadOfferingsForStudent() — resolves which course_offering_ids this
//      student is (non-withdrawn) registered for this session/term.
//   2. loadOfferingTimetable() — the same generic, view-agnostic entries
//      loader TimetableModuleHigherEd itself calls internally, joined on
//      the real course_offering_id FK (not the broken embed this session
//      already found and fixed in loadOfferingsForStudent()).
// No Modal, no admin/lecturer/edit state, no dependency on
// TimetableModuleHigherEd at all — a genuinely separate, minimal read path.

export interface StudentScheduleEntry {
  id: string
  day_of_week: number
  start_time: string
  end_time: string
  course_code: string
  course_title: string
  staff_name: string | null
  venue: string | null
}

export async function loadStudentSchedule(params: {
  studentId: string
  sessionId: string
  termId?: string | null
}): Promise<Result<StudentScheduleEntry[]>> {
  const offeringsResult = await loadOfferingsForStudent(params)
  if (!offeringsResult.ok) return offeringsResult

  const offeringIds = offeringsResult.data.map(o => o.id)
  if (offeringIds.length === 0) return { ok: true, data: [] }

  const entriesResult = await loadOfferingTimetable(offeringIds)
  if (!entriesResult.ok) return entriesResult

  // Already ordered by day_of_week, start_time via loadOfferingTimetable()'s
  // own query — re-shaped here to the minimal display fields only, per the
  // owner's explicit request, rather than handing the full
  // OfferingTimetableEntry (which also carries ids/term/programme fields a
  // read-only student list has no use for).
  const schedule: StudentScheduleEntry[] = entriesResult.data.map(e => ({
    id: e.id,
    day_of_week: e.day_of_week,
    start_time: e.start_time,
    end_time: e.end_time,
    course_code: e.course_code,
    course_title: e.course_title,
    staff_name: e.staff_name,
    venue: e.venue,
  }))

  return { ok: true, data: schedule }
}

// ─── Write: one slot ───────────────────────────────────────────────────────

export async function upsertOfferingTimetableEntry(params: {
  id?: string
  schoolId: string
  courseOfferingId: string
  dayOfWeek: number
  startTime: string   // 'HH:MM' or 'HH:MM:SS'
  endTime: string
  venue: string | null
}): Promise<Result<{ id: string }>> {
  try {
    const payload = {
      school_id: params.schoolId,
      course_offering_id: params.courseOfferingId,
      day_of_week: params.dayOfWeek,
      start_time: params.startTime,
      end_time: params.endTime,
      venue: params.venue,
    }

    if (params.id) {
      const { data, error } = await supabase
        .from('course_offering_timetable_entries')
        .update({ ...payload, updated_at: new Date().toISOString() })
        .eq('id', params.id)
        .select('id')
        .single()
      if (error) return { ok: false, error: error.message }
      return { ok: true, data: { id: data.id } }
    }

    const { data, error } = await supabase
      .from('course_offering_timetable_entries')
      .insert(payload)
      .select('id')
      .single()
    if (error) return { ok: false, error: error.message }
    return { ok: true, data: { id: data.id } }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to save the lesson' }
  }
}

// ─── Clear one slot ─────────────────────────────────────────────────────────

export async function deleteOfferingTimetableEntry(entryId: string): Promise<Result<null>> {
  try {
    const { error } = await supabase
      .from('course_offering_timetable_entries')
      .delete()
      .eq('id', entryId)
    if (error) return { ok: false, error: error.message }
    return { ok: true, data: null }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to remove the lesson' }
  }
}

// ─── Schedule-tab period sync (TIER 9 / PROBLEM, 2026-07-30) ─────────────
//
// Thin wrapper over settingsService.ts's own loadPeriods() — no new query,
// no new table. Lets the add/edit-slot form offer the school's already-
// configured Schedule-tab periods as a pick-a-period shortcut. Ordered by
// sort_order, matching how ScheduleTab itself displays them, so "Period 1"
// really does mean the school's own first period, not an arbitrary order.

export async function loadPeriodsForTimetable(schoolId: string): Promise<Result<Period[]>> {
  const { data, error } = await loadPeriods(schoolId)
  if (error) return { ok: false, error }
  return { ok: true, data }
}

// ─── Lecturer assignment from the timetable form (TIER 9 / PROBLEM) ──────
//
// A course offering can be created with no lecturer yet (staff_id null —
// a real, permitted state per §7.27.2). Previously the only way to attach
// one was to leave the timetable screen and go back into Curriculum/
// Offerings setup. This lets the admin set it right from the add/edit-slot
// form instead. Takes the full CourseOffering the form already has loaded
// (not just an id + new staff_id) and re-sends every field unchanged
// except staff_id, since upsertCourseOffering()'s update path is a
// full-row write — sending a partial object would silently null out
// programme_id/programme_level_id/attendance_eligibility_threshold_pct.

export async function assignOfferingLecturer(
  offering: CourseOffering,
  staffId: string | null,
): Promise<Result<null>> {
  const { error } = await upsertCourseOffering({
    id: offering.id,
    course_id: offering.course_id,
    session_id: offering.session_id,
    term_id: offering.term_id,
    staff_id: staffId,
    programme_id: offering.programme_id,
    programme_level_id: offering.programme_level_id,
    attendance_eligibility_threshold_pct: offering.attendance_eligibility_threshold_pct,
  })
  if (error) return { ok: false, error }
  return { ok: true, data: null }
}

// Data source for the in-form lecturer picker — active staff only, id +
// display name, narrowed from settingsService.ts's own loadStaffWithRoles()
// rather than a new query (that function already loads every staff member
// with their role names for the Staff settings tab; the form only needs
// the name).

export interface LecturerOption {
  id: string
  full_name: string
}

export async function loadLecturersForAssignment(schoolId: string): Promise<Result<LecturerOption[]>> {
  const { data, error } = await loadStaffWithRoles(schoolId)
  if (error) return { ok: false, error }
  return {
    ok: true,
    data: data
      .filter(s => s.status === 'active')
      .map(s => ({ id: s.id, full_name: s.full_name })),
  }
}

// ─── Conflict detection — live, in-memory, time-range overlap ────────────
//
// Same "computed live, not a stored flag" discipline timetableService.ts's
// findConflictingEntryIds() already established for §7.12 — restated here
// for §7.27.6 rather than shared, since the comparison itself is genuinely
// different: exact period_id equality there, time-range OVERLAP here (this
// table has no discrete period to compare). Two ranges conflict when
// start_a < end_b AND start_b < end_a — the standard interval-overlap test,
// not naive boundary equality, which would miss a real partial overlap
// (e.g. 9:00-11:00 vs 10:00-12:00 share an hour but have no equal boundary).

function toMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}

// Exported (SESSION 69 follow-up) so TimetableModuleHigherEd's pre-save
// check can test a not-yet-saved pending entry against already-loaded
// entries using the exact same overlap test findLecturerConflicts() and
// findCohortConflicts() both already use — one definition, not a second
// one re-derived in the component.
export function rangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  const as = toMinutes(aStart)
  const ae = toMinutes(aEnd)
  const bs = toMinutes(bStart)
  const be = toMinutes(bEnd)
  return as < be && bs < ae
}

export function findLecturerConflicts(entries: OfferingTimetableEntry[]): Set<string> {
  const conflicting = new Set<string>()

  // Group by staff_id + day_of_week first (cheap partition), then check
  // every pair within a group for a time overlap — free/no-lecturer-assigned
  // entries (staff_id null) can't conflict with anything, same as
  // timetableService.ts's own "free/supervised periods can't conflict" rule.
  const byStaffDay: Record<string, OfferingTimetableEntry[]> = {}
  for (const e of entries) {
    if (!e.staff_id) continue
    const key = `${e.staff_id}|${e.day_of_week}`
    if (!byStaffDay[key]) byStaffDay[key] = []
    byStaffDay[key].push(e)
  }

  for (const group of Object.values(byStaffDay)) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]
        const b = group[j]
        // A lecturer's own two offerings can legitimately share a
        // course_offering_id row split across entries, but never two
        // DIFFERENT offerings at an overlapping time — only flag when the
        // offerings differ, matching timetableService.ts's own
        // distinctClasses.size > 1 discriminator (different anchor object,
        // same underlying "same person, two places at once" check).
        if (a.course_offering_id === b.course_offering_id) continue
        if (rangesOverlap(a.start_time, a.end_time, b.start_time, b.end_time)) {
          conflicting.add(a.id)
          conflicting.add(b.id)
        }
      }
    }
  }

  return conflicting
}

// ─── Cohort clash detection — SESSION 69 ──────────────────────────────────
//
// A different category from findLecturerConflicts() above: a lecturer
// double-booking is a certain fact (one person, two places). A cohort
// clash — two offerings at the same programme_level_id, overlapping time —
// only POSSIBLY affects overlapping students, and how likely/severe that is
// depends on each side's requirement_type on that level's curriculum. See
// this file's own header and the §7.27.2 SESSION 69 amendment for the full
// reasoning on why this is three soft severities, never a hard block.

export type CohortClashSeverity = 'core' | 'elective' | 'unknown'

export interface CohortConflict {
  entryId: string
  conflictsWithEntryId: string
  severity: CohortClashSeverity
  otherCourseCode: string
  otherCourseTitle: string
}

// Resolves requirement_type for a set of (course_id, programme_level_id,
// term_id) triples in one query. Deliberately scoped to all three columns
// together, never course_id alone — joining programme_curriculum on
// course_id alone fans out when a course appears under more than one
// programme/level/term, the exact bug already found and fixed once in
// courseRegistrationService.ts's loadCurriculum() (PRD SESSION 57
// on-device finding, see §7.27.2 amendment notes). Returns a lookup map
// keyed by `${course_id}|${programme_level_id}|${term_id ?? 'null'}` so
// callers can do an exact-triple lookup rather than re-filtering an array.
async function loadCurriculumSeverity(
  triples: Array<{ courseId: string; programmeLevelId: string; termId: string | null }>,
): Promise<Result<Map<string, 'core' | 'elective'>>> {
  if (triples.length === 0) return { ok: true, data: new Map() }

  const levelIds = Array.from(new Set(triples.map(t => t.programmeLevelId)))
  const courseIds = Array.from(new Set(triples.map(t => t.courseId)))

  try {
    const { data, error } = await supabase
      .from('programme_curriculum')
      .select('course_id, programme_level_id, term_id, requirement_type')
      .in('programme_level_id', levelIds)
      .in('course_id', courseIds)

    if (error) return { ok: false, error: error.message }

    const map = new Map<string, 'core' | 'elective'>()
    for (const row of data ?? []) {
      const key = `${row.course_id}|${row.programme_level_id}|${row.term_id ?? 'null'}`
      map.set(key, row.requirement_type)
    }
    return { ok: true, data: map }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to resolve curriculum requirement types' }
  }
}

// Groups loaded entries by programme_level_id + day_of_week, checks every
// pair within a group for a time overlap (reuses rangesOverlap() as-is,
// same interval-overlap test findLecturerConflicts() uses), then resolves
// a severity per clashing pair via loadCurriculumSeverity(). Entries with
// no programme_level_id (unassigned or genuinely shared offerings, §7.27.2
// amendment) are excluded — there is no cohort to group them under, so
// they simply can't produce a cohort clash, not an error state.
export async function findCohortConflicts(
  entries: OfferingTimetableEntry[],
): Promise<Result<CohortConflict[]>> {
  const byLevelDay: Record<string, OfferingTimetableEntry[]> = {}
  for (const e of entries) {
    if (!e.programme_level_id) continue
    const key = `${e.programme_level_id}|${e.day_of_week}`
    if (!byLevelDay[key]) byLevelDay[key] = []
    byLevelDay[key].push(e)
  }

  type Pair = { a: OfferingTimetableEntry; b: OfferingTimetableEntry }
  const pairs: Pair[] = []
  for (const group of Object.values(byLevelDay)) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]
        const b = group[j]
        // Two entries under the SAME offering (e.g. lecture + tutorial for
        // one course) never "clash" with themselves.
        if (a.course_offering_id === b.course_offering_id) continue
        if (rangesOverlap(a.start_time, a.end_time, b.start_time, b.end_time)) {
          pairs.push({ a, b })
        }
      }
    }
  }

  if (pairs.length === 0) return { ok: true, data: [] }

  const triples: Array<{ courseId: string; programmeLevelId: string; termId: string | null }> = []
  for (const { a, b } of pairs) {
    triples.push({ courseId: a.course_id, programmeLevelId: a.programme_level_id!, termId: a.term_id })
    triples.push({ courseId: b.course_id, programmeLevelId: b.programme_level_id!, termId: b.term_id })
  }

  const sevRes = await loadCurriculumSeverity(triples)
  if (!sevRes.ok) return sevRes
  const severityMap = sevRes.data

  function severityOf(e: OfferingTimetableEntry): 'core' | 'elective' | null {
    const key = `${e.course_id}|${e.programme_level_id}|${e.term_id ?? 'null'}`
    return severityMap.get(key) ?? null
  }

  const conflicts: CohortConflict[] = []
  for (const { a, b } of pairs) {
    const sevA = severityOf(a)
    const sevB = severityOf(b)
    // Either side unresolved on the curriculum -> can't tell who's
    // affected. Deliberately its own 'unknown' severity, not defaulted to
    // 'elective' — defaulting would assert a false fact (known-elective)
    // instead of the true one (impact undetermined). See §7.27.2 amendment.
    const severity: CohortClashSeverity =
      sevA === null || sevB === null ? 'unknown'
      : sevA === 'core' || sevB === 'core' ? 'core'
      : 'elective'

    conflicts.push({
      entryId: a.id,
      conflictsWithEntryId: b.id,
      severity,
      otherCourseCode: b.course_code,
      otherCourseTitle: b.course_title,
    })
    conflicts.push({
      entryId: b.id,
      conflictsWithEntryId: a.id,
      severity,
      otherCourseCode: a.course_code,
      otherCourseTitle: a.course_title,
    })
  }

  return { ok: true, data: conflicts }
}

// Builds the confirm-to-proceed message for a single cohort conflict,
// worded per severity per the §7.27.2 amendment's table — one shared
// builder so the wording only lives in one place.
export function cohortConflictMessage(conflict: CohortConflict): string {
  const course = `${conflict.otherCourseCode} — ${conflict.otherCourseTitle}`
  switch (conflict.severity) {
    case 'core':
      return `This clashes with ${course}, also core for this level. Every student at this level will be affected.`
    case 'elective':
      return `This may clash with ${course} for students who register for both.`
    case 'unknown':
      return `This clashes with ${course}, but it isn't on any programme's curriculum yet — we can't tell which students it affects.`
  }
}

// ─── Time format helper — matches timetableService.ts's own convention ────

export function formatTime(t: string): string {
  const [hStr, mStr] = t.split(':')
  let h = Number(hStr)
  const m = mStr
  const suffix = h >= 12 ? 'PM' : 'AM'
  h = h % 12
  if (h === 0) h = 12
  return `${h}:${m} ${suffix}`
}
