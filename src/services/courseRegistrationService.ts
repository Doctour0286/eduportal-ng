/**
 * courseRegistrationService.ts
 * Data-access layer for the course registration workflow (PRD Tier 8 /
 * Problem 8.7, SESSION 57).
 *
 * Scope: given a real, currently-placed student, resolve the curriculum
 * for their programme/level/term, pre-populate any outstanding carryover,
 * let an admin/course-adviser pick electives, enforce the school's
 * configured credit-load cap, and write the resulting course_registrations
 * rows. Deliberately its own service/module (not folded into
 * settingsService.ts/SettingsModule.tsx) — registration is operational,
 * per-session, per-student work, not settings/configuration, the same
 * "definition vs. per-target assignment" split already drawn between
 * CurriculumTab (defines a programme/level/term's course list once) and
 * this file (assigns real students against that list every session).
 *
 * Tables touched (all live as of SESSION 56):
 *   students, student_programme_placements, programme_curriculum,
 *   courses, course_registrations, programmes, terms, sessions
 *
 * Pattern rules (consistent with settingsService.ts):
 *   - {data, error} / {error} return shape throughout
 *   - Joined relations cast through unknown → array before plucking [0]
 *   - schoolId threaded on every call — never inferred client-side
 *   - No hard deletes on course_registrations that have ever been saved
 *     as part of a real registration batch except pre-save (draft) rows —
 *     see registerStudent()'s replace-in-place note below.
 */

import { supabase } from '../lib/supabase'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface StudentCurrentPlacement {
  student_id: string
  student_name: string
  student_matric_number: string | null
  programme_id: string
  programme_name: string
  programme_level_id: string
  level_label: string
  min_credit_load: number | null
  max_credit_load: number | null
  session_id: string
}

export interface RegistrableCourse {
  course_id: string
  course_code: string
  course_title: string
  credit_units: number
  requirement_type: 'core' | 'elective'
  prerequisite_course_id: string | null
  prerequisite_course_code: string | null
}

export interface CarryoverCourse {
  original_registration_id: string
  course_id: string
  course_code: string
  course_title: string
  credit_units: number
  from_session_id: string
  from_session_name: string
}

export interface ExistingRegistration {
  id: string
  course_id: string
  course_code: string
  course_title: string
  credit_units: number
  status: 'registered' | 'carryover' | 'withdrawn'
  is_carryover: boolean
}

// ─── Resolve the currently-authenticated student's own student_id ─────────

// SESSION 69 addition: the student self-service registration portal needs
// its own student_id, resolved the same authoritative way the new RLS
// write policy on course_registrations resolves it server-side
// (app_identities.actor_record_id where auth_user_id = auth.uid() and
// actor_type = 'student') -- not a second, possibly-stale notion of
// "current student" threaded loosely from wherever the portal shell
// happens to already store one. Client-side RLS still applies on this
// read (app_identities' own self-read policy), so this can never resolve
// to someone else's identity even if called incorrectly.
export async function loadCurrentStudentId(): Promise<{ data: string | null; error: string | null }> {
  const { data: authData, error: authErr } = await supabase.auth.getUser()
  if (authErr) return { data: null, error: authErr.message }
  const authUserId = authData.user?.id
  if (!authUserId) return { data: null, error: 'Not signed in.' }

  const { data, error } = await supabase
    .from('app_identities')
    .select('actor_record_id, actor_type')
    .eq('auth_user_id', authUserId)
    .eq('actor_type', 'student')
    .maybeSingle()
  if (error) return { data: null, error: error.message }
  if (!data) return { data: null, error: 'No student identity found for this account.' }
  return { data: data.actor_record_id, error: null }
}

// ─── Resolve a student's current placement ─────────────────────────────────

// A registration is always built against the student's *current* placement
// (student_programme_placements where is_current = true) — matching
// upsertPlacement()'s own demote-then-insert convention in
// settingsService.ts. If a student has no current placement at all (not
// yet admitted into a level), registration cannot proceed; the caller
// surfaces that rather than guessing a level.
export async function loadStudentPlacement(
  studentId: string,
): Promise<{ data: StudentCurrentPlacement | null; error: string | null }> {
  const { data, error } = await supabase
    .from('student_programme_placements')
    .select(`
      student_id, programme_level_id, session_id,
      students(full_name, matric_number),
      programme_levels(level_label, programme_id,
        programmes(name, min_credit_load, max_credit_load))
    `)
    .eq('student_id', studentId)
    .eq('is_current', true)
    .maybeSingle()
  if (error) return { data: null, error: error.message }
  if (!data) return { data: null, error: null }

  // Joined relations cast through unknown → array before plucking [0], per
  // settingsService.ts's own established convention.
  const row = data as any
  const student = (Array.isArray(row.students) ? row.students[0] : row.students) as
    | { full_name: string; matric_number: string | null }
    | undefined
  const level = (Array.isArray(row.programme_levels) ? row.programme_levels[0] : row.programme_levels) as
    | { level_label: string; programme_id: string; programmes: any }
    | undefined
  const programme = (Array.isArray(level?.programmes) ? level?.programmes[0] : level?.programmes) as
    | { name: string; min_credit_load: number | null; max_credit_load: number | null }
    | undefined

  if (!student || !level || !programme) return { data: null, error: null }

  return {
    data: {
      student_id: row.student_id,
      student_name: student.full_name,
      student_matric_number: student.matric_number,
      programme_id: level.programme_id,
      programme_name: programme.name,
      programme_level_id: row.programme_level_id,
      level_label: level.level_label,
      min_credit_load: programme.min_credit_load,
      max_credit_load: programme.max_credit_load,
      session_id: row.session_id,
    },
    error: null,
  }
}

// ─── Curriculum for that placement, scoped to a term ───────────────────────

// Mirrors settingsService.ts's loadCurriculum() exactly (same query shape,
// same FK-disambiguation hints) rather than importing it, since that
// function returns CurriculumEntry (a definition-time shape keyed by its
// own programme_curriculum row id) where this file needs a
// registration-time shape keyed by course_id instead. Kept as a intentional,
// narrow duplication rather than overloading one type for two purposes.
export async function loadRegistrableCourses(
  programmeLevelId: string,
  termId: string | null,
): Promise<{ data: RegistrableCourse[]; error: string | null }> {
  let query = supabase
    .from('programme_curriculum')
    .select(`
      course_id, requirement_type, prerequisite_course_id,
      courses!programme_curriculum_course_id_fkey(code, title, credit_units),
      prerequisite:courses!programme_curriculum_prerequisite_course_id_fkey(code)
    `)
    .eq('programme_level_id', programmeLevelId)
  query = termId ? query.eq('term_id', termId) : query.is('term_id', null)
  const { data, error } = await query
  if (error) return { data: [], error: error.message }

  const mapped = (data ?? []).map((row: any) => {
    const course = (Array.isArray(row.courses) ? row.courses[0] : row.courses) as
      | { code: string; title: string; credit_units: number }
      | undefined
    const prereq = (Array.isArray(row.prerequisite) ? row.prerequisite[0] : row.prerequisite) as
      | { code: string }
      | undefined
    return {
      course_id: row.course_id,
      course_code: course?.code ?? '—',
      course_title: course?.title ?? 'Unknown course',
      credit_units: course?.credit_units ?? 0,
      requirement_type: row.requirement_type,
      prerequisite_course_id: row.prerequisite_course_id,
      prerequisite_course_code: prereq?.code ?? null,
    }
  })
  return { data: mapped as RegistrableCourse[], error: null }
}

// ─── Outstanding carryover for this student ────────────────────────────────

// Deliberately NOT scoped by session_id or term_id — a carryover is, by
// definition, a course_registrations row from a *prior* session that still
// needs resolving, so this looks across the student's entire history.
// original_registration_id stays null on these rows (they ARE the
// original failed attempt, not yet re-registered); the row created when
// the carryover is re-registered this session is the one that gets
// original_registration_id set, per §7.27.2's self-FK design.
export async function loadOutstandingCarryover(
  studentId: string,
): Promise<{ data: CarryoverCourse[]; error: string | null }> {
  const { data, error } = await supabase
    .from('course_registrations')
    .select(`
      id, course_id, session_id,
      courses(code, title, credit_units),
      sessions(name)
    `)
    .eq('student_id', studentId)
    .eq('status', 'carryover')
    .is('original_registration_id', null)
  if (error) return { data: [], error: error.message }

  const mapped = (data ?? []).map((row: any) => {
    const course = (Array.isArray(row.courses) ? row.courses[0] : row.courses) as
      | { code: string; title: string; credit_units: number }
      | undefined
    const session = (Array.isArray(row.sessions) ? row.sessions[0] : row.sessions) as
      | { name: string }
      | undefined
    return {
      original_registration_id: row.id,
      course_id: row.course_id,
      course_code: course?.code ?? '—',
      course_title: course?.title ?? 'Unknown course',
      credit_units: course?.credit_units ?? 0,
      from_session_id: row.session_id,
      from_session_name: session?.name ?? 'Prior session',
    }
  })
  return { data: mapped as CarryoverCourse[], error: null }
}

// ─── Existing registrations for this student/session/term ─────────────────

// Used to show what's already registered (e.g. re-opening a partially
// completed registration) and to exclude those courses from being offered
// again as a fresh pick in the elective/core list.
export async function loadExistingRegistrations(
  studentId: string,
  sessionId: string,
  termId: string | null,
): Promise<{ data: ExistingRegistration[]; error: string | null }> {
  let query = supabase
    .from('course_registrations')
    .select(`
      id, course_id, status, is_carryover,
      courses(code, title, credit_units)
    `)
    .eq('student_id', studentId)
    .eq('session_id', sessionId)
    .neq('status', 'withdrawn')
  query = termId ? query.eq('term_id', termId) : query.is('term_id', null)
  const { data, error } = await query
  if (error) return { data: [], error: error.message }

  const mapped = (data ?? []).map((row: any) => {
    const course = (Array.isArray(row.courses) ? row.courses[0] : row.courses) as
      | { code: string; title: string; credit_units: number }
      | undefined
    return {
      id: row.id,
      course_id: row.course_id,
      course_code: course?.code ?? '—',
      course_title: course?.title ?? 'Unknown course',
      credit_units: course?.credit_units ?? 0,
      status: row.status,
      is_carryover: row.is_carryover,
    }
  })
  return { data: mapped as ExistingRegistration[], error: null }
}

// ─── Currently-registered summary (PRD Tier 9 / Problem 9.6) ──────────────

// Deliberately a thin wrapper over loadExistingRegistrations() rather than
// a new query — that function's ExistingRegistration shape (code, title,
// units, status, is_carryover) is already exactly what the "Currently
// registered" summary view needs to render. Kept as its own named export
// (rather than calling loadExistingRegistrations() directly from the UI)
// so the summary view's intent — "does this student already have an
// active registration for this term" — reads clearly at the call site,
// and so a future divergence in what the summary needs vs. what the
// picker's pre-check needs has a natural seam to split from.
export interface CurrentRegistrationRow {
  id: string
  course_id: string
  course_code: string
  course_title: string
  credit_units: number
  is_carryover: boolean
  term_id: string | null
  term_name: string | null
}

// ─── Currently-registered summary (PRD Tier 9 / Problem 9.6) ──────────────

// Deliberately its OWN query, not a call-through to loadExistingRegistrations()
// (which this function originally was). Reason for the split, found while
// tracing a real on-device bug: a student can end up with active
// course_registrations rows spread across more than one term_id for the
// same session — confirmed directly via SQL on a real student (two rows
// with term_id null, one with a real term_id, all status='registered',
// same session_id). This happens because registerStudent()'s withdraw-diff
// only ever reconciles rows within the exact (session_id, term_id) it's
// called with — it has no way to know about, and so never withdraws, that
// same student's active rows sitting under a DIFFERENT term_id in the same
// session. loadExistingRegistrations() being exact-term-scoped (by design,
// for the picker's own pre-check purpose) meant the "Currently registered"
// summary — which is supposed to answer "what does this student currently
// have active, full stop" — could only ever see whichever single term the
// caller happened to resolve, silently hiding the rest. This function
// instead loads every active row for the student+session regardless of
// term, and returns each row's own term_id/term_name so the UI can label
// multi-term registrations clearly rather than pretending they don't exist.
//
// This does NOT change registerStudent()'s own save/withdraw behavior —
// that per-term reconciliation gap is a separate, flagged decision
// requiring its own sign-off before touching the write path. This is a
// read-side fix only: show the true current state accurately, whatever it is.
export async function loadCurrentRegistration(
  studentId: string,
  sessionId: string,
): Promise<{ data: CurrentRegistrationRow[]; error: string | null }> {
  const { data, error } = await supabase
    .from('course_registrations')
    .select(`
      id, course_id, is_carryover, term_id,
      courses(code, title, credit_units),
      terms(name)
    `)
    .eq('student_id', studentId)
    .eq('session_id', sessionId)
    .neq('status', 'withdrawn')
  if (error) return { data: [], error: error.message }

  const mapped = (data ?? []).map((row: any) => {
    const course = (Array.isArray(row.courses) ? row.courses[0] : row.courses) as
      | { code: string; title: string; credit_units: number }
      | undefined
    const term = (Array.isArray(row.terms) ? row.terms[0] : row.terms) as
      | { name: string }
      | undefined
    return {
      id: row.id,
      course_id: row.course_id,
      course_code: course?.code ?? '—',
      course_title: course?.title ?? 'Unknown course',
      credit_units: course?.credit_units ?? 0,
      is_carryover: row.is_carryover,
      term_id: row.term_id,
      term_name: term?.name ?? null,
    }
  })
  return { data: mapped as CurrentRegistrationRow[], error: null }
}

// ─── Credit-load check (pure — no network) ─────────────────────────────────

// Deliberately pure and synchronous so the UI can validate on every
// selection change without a round trip. programmes.min/max_credit_load
// are both nullable (§7.27.1) — a school that hasn't configured a cap is
// not silently assigned one (e.g. not defaulted to a made-up number like
// 24); the check simply has nothing to enforce on that side, matching
// this project's "no hardcoded defaults where the schema says nullable"
// discipline (see attendance_eligibility_threshold_pct, §7.27.2).
export interface CreditLoadCheck {
  totalUnits: number
  underMin: boolean
  overMax: boolean
  message: string | null
}

export function checkCreditLoad(
  totalUnits: number,
  minCreditLoad: number | null,
  maxCreditLoad: number | null,
): CreditLoadCheck {
  const underMin = minCreditLoad != null && totalUnits < minCreditLoad
  const overMax = maxCreditLoad != null && totalUnits > maxCreditLoad
  let message: string | null = null
  if (overMax) {
    message = `${totalUnits} units exceeds this programme's maximum of ${maxCreditLoad}. Remove a course before saving.`
  } else if (underMin) {
    message = `${totalUnits} units is below this programme's minimum of ${minCreditLoad}. You can still save, but this student will be under-loaded.`
  }
  return { totalUnits, underMin, overMax, message }
}

// ─── Save a registration batch ──────────────────────────────────────────────

// Registers a student for a full set of courses in one call: core courses
// (auto-populated by the caller from loadRegistrableCourses), chosen
// electives, and any outstanding carryover the caller chose to include.
// Replace-in-place, not additive: any of this student's non-withdrawn
// registrations for this exact session+term that are NOT in the new set
// are marked 'withdrawn' (soft, matching this project's no-hard-delete
// discipline — see settingsService.ts header) rather than deleted, so a
// re-opened registration screen behaves like an edit, not an accumulator.
// Carryover rows being re-registered get a NEW course_registrations row
// with original_registration_id pointing back at the old one (status
// 'registered', is_carryover true); the original carryover row's own
// status is left as 'carryover' as the historical record of the failed
// attempt, per §7.27.2's self-FK design — it is never overwritten.
export async function registerStudent(params: {
  school_id: string
  student_id: string
  session_id: string
  term_id: string | null
  courses: { course_id: string; is_carryover_reregistration?: string | null }[]
  // is_carryover_reregistration, when set, is the original carryover
  // registration's id — becomes original_registration_id on the new row.
}): Promise<{ error: string | null }> {
  if (params.courses.length === 0) {
    return { error: 'Choose at least one course before saving.' }
  }

  // Withdraw anything previously registered for this session+term that
  // is not part of the new set, rather than deleting — same soft-status
  // discipline as the rest of this codebase.
  let existingQuery = supabase
    .from('course_registrations')
    .select('id, course_id')
    .eq('student_id', params.student_id)
    .eq('session_id', params.session_id)
    .neq('status', 'withdrawn')
  existingQuery = params.term_id ? existingQuery.eq('term_id', params.term_id) : existingQuery.is('term_id', null)
  const { data: existingRows, error: existingErr } = await existingQuery
  if (existingErr) return { error: existingErr.message }

  const newCourseIds = new Set(params.courses.map(c => c.course_id))
  const toWithdraw = (existingRows ?? []).filter((r: any) => !newCourseIds.has(r.course_id)).map((r: any) => r.id)
  if (toWithdraw.length > 0) {
    const { error: withdrawErr } = await supabase
      .from('course_registrations')
      .update({ status: 'withdrawn', updated_at: new Date().toISOString() })
      .in('id', toWithdraw)
    if (withdrawErr) return { error: withdrawErr.message }
  }

  // Only insert rows for courses not already actively registered this
  // session+term (re-saving an unchanged selection should not create
  // duplicate rows).
  const alreadyRegisteredIds = new Set((existingRows ?? []).map((r: any) => r.course_id))
  const toInsert = params.courses.filter(c => !alreadyRegisteredIds.has(c.course_id))
  if (toInsert.length === 0) return { error: null }

  const payload = toInsert.map(c => ({
    student_id: params.student_id,
    course_id: c.course_id,
    session_id: params.session_id,
    term_id: params.term_id,
    status: 'registered' as const,
    is_carryover: !!c.is_carryover_reregistration,
    original_registration_id: c.is_carryover_reregistration ?? null,
  }))

  const { error: insertErr } = await supabase
    .from('course_registrations')
    .insert(payload)
  return { error: insertErr?.message ?? null }
}
