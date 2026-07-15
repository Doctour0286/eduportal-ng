/**
 * courseResultsService.ts
 * Data-access layer for the higher-ed scoring workflow (PRD Tier 8.7,
 * SESSION 60). Deliberately its own service, not folded into
 * resultsService.ts — that file is entirely secondary-school-shaped
 * (scores / score_components / subject_results, keyed by class_node +
 * subject_id). course_results is a different anchor object entirely
 * (course_registration_id, one row per registration, no CA-component
 * breakdown) — same "different anchor, not a variation" reasoning
 * courseRegistrationService.ts's own header already gives for why it
 * isn't folded into settingsService.ts.
 *
 * Pattern rules (consistent with courseRegistrationService.ts, since this
 * is the same higher-ed domain, not resultsService.ts's Result<T> shape):
 *   - {data, error} / {error} return shape throughout
 *   - Joined relations cast through unknown -> array before plucking [0]
 *   - No schoolId param where the id chain already scopes correctly and
 *     RLS is the real boundary (course_offerings has no school_id column,
 *     confirmed in settingsService.ts's loadCourseOfferings; course_results
 *     has none either, scoped via course_registration_id -> students.school_id)
 *
 * Tables touched: course_offerings, course_registrations, courses,
 * students, course_results, cgpa_policy, grade_scales (higher-ed columns),
 * student_gpa_snapshots
 */

import { supabase } from '../lib/supabase'
import type { RollupMethod, RetakeTreatment } from './gpaService'

// ─── Types ──────────────────────────────────────────────────────────────────

/** One student's registration against a specific course offering, ready to score. */
export interface ScorableRegistration {
  registration_id: string
  student_id: string
  student_name: string
  student_matric_number: string | null
  course_id: string
  course_code: string
  course_title: string
  credit_units: number
  status: 'registered' | 'carryover' | 'withdrawn'
  is_carryover: boolean
  original_registration_id: string | null
  // Existing result, if any — null fields mean not yet scored.
  score: number | null
  letter_grade: string | null
  grade_point: number | null
  finalized_at: string | null
}

export interface CgpaPolicy {
  school_id: string
  rollup_method: RollupMethod
  retake_treatment: RetakeTreatment
}

/**
 * SESSION 60a — a school-wide CA/exam component definition (e.g. "CA" 40%,
 * "Exam" 60%). Column-for-column the same shape as resultsService.ts's own
 * ScoreComponent, renamed to this domain — confirmed against that file's
 * real type (id, name, weight_pct, sort_order) before writing this, per
 * SESSION 60a's own card instruction to verify the real shape rather than
 * assume one. Write access is ADMIN-ONLY at the RLS layer (migration_
 * session_60a.sql, academics.course_result_components.manage) — a genuine
 * deviation from cgpa_policy's own plain-[STD] precedent, recorded in that
 * migration's header, not repeated here.
 */
export interface CourseResultComponent {
  id: string
  school_id: string
  /**
   * SESSION 60c: null = school-wide (SESSION 60a's original meaning,
   * unchanged). Set = course-specific override/addition for that course
   * only. Folded into this same table/type rather than a second
   * "override" table/type — see migration_session_60c.sql's header for
   * why the original two-table design was abandoned before it shipped
   * (a real FK bug: course_result_component_scores can only reference
   * course_result_components(id), so an override living in its own table
   * with its own id-space could never be scored against).
   */
  course_id: string | null
  name: string
  weight_pct: number
  sort_order: number
}

/**
 * One entered value for one (registration, component) pair — the higher-ed
 * equivalent of resultsService.ts's Score row, minus approved_by/approved_at
 * (course_results has no approval-gate concept yet; see saveComponentScore()
 * below for why that's not introduced here).
 */
export interface ComponentScore {
  id: string
  course_registration_id: string
  course_result_component_id: string
  value: number
  entered_by: string
}

// ─── Read: scorable registrations for a course offering ───────────────────

/**
 * Loads every non-withdrawn registration against the given course offering
 * (matched by course_id + session_id + term_id, since course_offerings is
 * the assignment record but course_registrations is what students actually
 * hold — same relationship loadCourseOfferings/loadRegistrableCourses
 * already establish elsewhere), joined with each registration's current
 * course_results row if one exists.
 *
 * Mirrors courseRegistrationService.ts's loadExistingRegistrations() join
 * shape (course_registrations -> courses(code,title,credit_units)), with
 * students(full_name, matric_number) added per loadStudentPlacement()'s
 * own precedent for that join.
 */
export async function loadScorableRegistrations(params: {
  courseId: string
  sessionId: string
  termId: string | null
}): Promise<{ data: ScorableRegistration[]; error: string | null }> {
  let q = supabase
    .from('course_registrations')
    .select(`
      id, student_id, course_id, status, is_carryover, original_registration_id,
      courses(code, title, credit_units),
      students(full_name, matric_number),
      course_results(score, letter_grade, grade_point, finalized_at)
    `)
    .eq('course_id', params.courseId)
    .eq('session_id', params.sessionId)
    .neq('status', 'withdrawn')

  q = params.termId ? q.eq('term_id', params.termId) : q.is('term_id', null)

  const { data, error } = await q
  if (error) return { data: [], error: error.message }

  const mapped = (data ?? []).map((row: any) => {
    const course = (Array.isArray(row.courses) ? row.courses[0] : row.courses) as
      | { code: string; title: string; credit_units: number }
      | undefined
    const student = (Array.isArray(row.students) ? row.students[0] : row.students) as
      | { full_name: string; matric_number: string | null }
      | undefined
    // course_results is 0-or-1 rows per registration (no unique constraint
    // enforced here in TS, but the write path — saveCourseResult below —
    // upserts on course_registration_id, so in practice it's at most one).
    const resultRows = Array.isArray(row.course_results) ? row.course_results : (row.course_results ? [row.course_results] : [])
    const result = resultRows[0] as
      | { score: number | null; letter_grade: string | null; grade_point: number | null; finalized_at: string | null }
      | undefined

    return {
      registration_id: row.id,
      student_id: row.student_id,
      student_name: student?.full_name ?? 'Unknown student',
      student_matric_number: student?.matric_number ?? null,
      course_id: row.course_id,
      course_code: course?.code ?? '—',
      course_title: course?.title ?? 'Unknown course',
      credit_units: course?.credit_units ?? 0,
      status: row.status,
      is_carryover: row.is_carryover,
      original_registration_id: row.original_registration_id,
      score: result?.score === undefined || result?.score === null ? null : Number(result.score),
      letter_grade: result?.letter_grade ?? null,
      grade_point: result?.grade_point === undefined || result?.grade_point === null ? null : Number(result.grade_point),
      finalized_at: result?.finalized_at ?? null,
    }
  })

  return { data: mapped as ScorableRegistration[], error: null }
}

// ─── Read: cgpa_policy ──────────────────────────────────────────────────────

/**
 * Loads the school's CGPA policy. Returns { data: null } (not an error) if
 * no row exists yet — this is a real, expected state (SESSION 59's Grading
 * tab may not have been used yet), and callers must handle it explicitly
 * rather than assume a default rollup_method/retake_treatment. Per
 * §7.27.4/PRD Log row 49: both fields are mandatory school-level settings,
 * never assumed or hardcoded in code.
 */
export async function loadCgpaPolicy(
  schoolId: string,
): Promise<{ data: CgpaPolicy | null; error: string | null }> {
  const { data, error } = await supabase
    .from('cgpa_policy')
    .select('school_id, rollup_method, retake_treatment')
    .eq('school_id', schoolId)
    .maybeSingle()

  if (error) return { data: null, error: error.message }
  if (!data) return { data: null, error: null }

  return {
    data: {
      school_id: data.school_id,
      rollup_method: data.rollup_method as RollupMethod,
      retake_treatment: data.retake_treatment as RetakeTreatment,
    },
    error: null,
  }
}

// ─── Write: score + finalize ────────────────────────────────────────────────

/**
 * Upserts a course_results row for one registration and marks it finalized
 * (sets finalized_at = now()). course_results has no unique constraint
 * declared in §7.27.4's schema text beyond the primary key, so this reads
 * the existing row (if any) via course_registration_id first rather than
 * relying on an onConflict upsert — matching the fact that this table,
 * unlike scores/course_offerings, was not given an explicit unique
 * constraint in the schema as written.
 *
 * letter_grade/grade_point are computed by the caller via gpaService.ts's
 * findGradeBand() before calling this — this function only persists,
 * it does not itself look up the grade scale, keeping the pure/impure
 * split gpaService.ts's own header documents.
 */
export async function saveCourseResult(params: {
  registrationId: string
  score: number
  letterGrade: string
  gradePoint: number
}): Promise<{ error: string | null }> {
  const { data: existing, error: findErr } = await supabase
    .from('course_results')
    .select('id')
    .eq('course_registration_id', params.registrationId)
    .maybeSingle()

  if (findErr) return { error: findErr.message }

  const payload = {
    course_registration_id: params.registrationId,
    score: params.score,
    letter_grade: params.letterGrade,
    grade_point: params.gradePoint,
    finalized_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }

  if (existing) {
    const { error } = await supabase.from('course_results').update(payload).eq('id', existing.id)
    if (error) return { error: error.message }
  } else {
    const { error } = await supabase.from('course_results').insert(payload)
    if (error) return { error: error.message }
  }

  return { error: null }
}

// ─── Read: every finalized attempt for a student (for GPA/CGPA recompute) ──

/**
 * Loads every finalized course_results row for a student across every
 * session, joined back through course_registrations for credit_units,
 * session_id, term_id, is_carryover/original_registration_id — everything
 * gpaService.ts's CourseAttempt/ScoreAttempt shape needs. This is the
 * function recompute-on-finalize (below) calls before handing off to
 * gpaService.ts's pure computeStudentGpaSummary().
 *
 * Deliberately NOT scoped to one session — CGPA under either rollup_method
 * needs the student's full history, not just the session just scored.
 */
export async function loadFinalizedAttemptsForStudent(studentId: string): Promise<{
  data: Array<{
    registration_id: string
    original_registration_id: string | null
    is_carryover: boolean
    session_id: string
    term_id: string | null
    credit_units: number
    score: number
  }>
  error: string | null
}> {
  const { data, error } = await supabase
    .from('course_registrations')
    .select(`
      id, original_registration_id, is_carryover, session_id, term_id,
      courses(credit_units),
      course_results!inner(score, finalized_at)
    `)
    .eq('student_id', studentId)
    .neq('status', 'withdrawn')
    .not('course_results.finalized_at', 'is', null)

  if (error) return { data: [], error: error.message }

  const mapped = (data ?? []).map((row: any) => {
    const course = (Array.isArray(row.courses) ? row.courses[0] : row.courses) as
      | { credit_units: number }
      | undefined
    const resultRows = Array.isArray(row.course_results) ? row.course_results : [row.course_results]
    const result = resultRows[0] as { score: number } | undefined

    return {
      registration_id: row.id,
      original_registration_id: row.original_registration_id,
      is_carryover: row.is_carryover,
      session_id: row.session_id,
      term_id: row.term_id,
      credit_units: course?.credit_units ?? 0,
      score: Number(result?.score ?? 0),
    }
  })

  return { data: mapped, error: null }
}

// ─── Write: recompute-and-cache into student_gpa_snapshots ─────────────────

/**
 * Writes (upserts) the student's per-semester GPA rows plus one
 * null-term running-CGPA row into student_gpa_snapshots, replacing any
 * prior snapshot rows for this student. Called after saveCourseResult()
 * finalizes a new score, per §4.1's caching discipline ("never derived
 * live on every read").
 *
 * NOTE: writes term_id, not the old semester:text column — this assumes
 * the semester -> term_id migration (flagged separately, pending owner
 * confirmation) has been applied. Do not run this against an unmigrated
 * student_gpa_snapshots table.
 */
export async function saveGpaSnapshots(params: {
  studentId: string
  semesterGpas: Array<{ sessionId: string; termId: string | null; totalUnitsAttempted: number; totalQualityPoints: number; gpa: number | null }>
  cgpa: { totalUnitsAttempted: number; totalQualityPoints: number; cgpa: number | null }
  currentSessionId: string
}): Promise<{ error: string | null }> {
  // Replace-in-place: delete this student's existing snapshot rows, then
  // insert the freshly computed set. Simpler and safer than a per-row
  // upsert here since the set of (session,term) rows can shrink under
  // 'replacement' retake_treatment (a superseded semester can lose its
  // only attempt) — a delete-then-insert can't leave a stale row behind
  // the way a keyed upsert could.
  const { error: delErr } = await supabase
    .from('student_gpa_snapshots')
    .delete()
    .eq('student_id', params.studentId)

  if (delErr) return { error: delErr.message }

  const rows = [
    ...params.semesterGpas.map((s) => ({
      student_id: params.studentId,
      session_id: s.sessionId,
      term_id: s.termId,
      gpa: s.gpa,
      cgpa: null,
      total_units_attempted: s.totalUnitsAttempted,
      total_quality_points: s.totalQualityPoints,
    })),
    {
      student_id: params.studentId,
      session_id: params.currentSessionId,
      term_id: null, // null term_id = the running CGPA snapshot row, per §7.27.4
      gpa: null,
      cgpa: params.cgpa.cgpa,
      total_units_attempted: params.cgpa.totalUnitsAttempted,
      total_quality_points: params.cgpa.totalQualityPoints,
    },
  ]

  const { error: insErr } = await supabase.from('student_gpa_snapshots').insert(rows)
  if (insErr) return { error: insErr.message }

  return { error: null }
}

// ═══════════════════════════════════════════════════════════════════════════
// SESSION 60a/60c — CA/exam component breakdown for course_results, with
// optional per-course overrides folded into the SAME table (course_id
// nullable — see migration_session_60c.sql's header for why the earlier
// two-table override design was replaced before it ever shipped).
// (owner-directed follow-up, not in original Phase 4 scope)
// ═══════════════════════════════════════════════════════════════════════════

// ─── Read/write: course_result_components (school-wide + course-specific) ──

/**
 * Loads every SCHOOL-WIDE component (course_id IS NULL) — mirrors
 * resultsService.ts's loadScoreComponents() shape, with an explicit
 * .eq('school_id', ...) added (that file relies on RLS alone to scope its
 * equivalent read, confirmed live — this file adds the filter anyway for
 * defense-in-depth). Does NOT return course-specific rows — use
 * loadCourseSpecificComponents() or resolveCourseResultComponents() for
 * those.
 */
export async function loadCourseResultComponents(
  schoolId: string,
): Promise<{ data: CourseResultComponent[]; error: string | null }> {
  const { data, error } = await supabase
    .from('course_result_components')
    .select('id, school_id, course_id, name, weight_pct, sort_order')
    .eq('school_id', schoolId)
    .is('course_id', null)
    .order('sort_order')

  if (error) return { data: [], error: error.message }
  return {
    data: (data ?? []).map((c: any) => ({
      id: c.id,
      school_id: c.school_id,
      course_id: c.course_id,
      name: c.name,
      weight_pct: Number(c.weight_pct),
      sort_order: c.sort_order,
    })),
    error: null,
  }
}

/**
 * Loads every COURSE-SPECIFIC component (course_id = the given course) for
 * one course, sorted by sort_order — same shape/convention as
 * loadCourseResultComponents(), filtered the other way.
 */
export async function loadCourseSpecificComponents(
  courseId: string,
): Promise<{ data: CourseResultComponent[]; error: string | null }> {
  const { data, error } = await supabase
    .from('course_result_components')
    .select('id, school_id, course_id, name, weight_pct, sort_order')
    .eq('course_id', courseId)
    .order('sort_order')

  if (error) return { data: [], error: error.message }
  return {
    data: (data ?? []).map((c: any) => ({
      id: c.id,
      school_id: c.school_id,
      course_id: c.course_id,
      name: c.name,
      weight_pct: Number(c.weight_pct),
      sort_order: c.sort_order,
    })),
    error: null,
  }
}

/**
 * Creates or updates one component — school-wide (courseId omitted/null)
 * or course-specific (courseId set), same table either way per SESSION
 * 60c's folded design. ADMIN-ONLY — enforced at the RLS layer (migration_
 * session_60a.sql; unchanged by migration_session_60c.sql, see that file's
 * header for why no RLS changes were needed), not just in the UI; this
 * function itself performs no permission check of its own.
 *
 * Sum-to-100 validation is NOT performed here — see migration_session_60a.
 * sql's own header on why that cross-row invariant isn't a DB-level CHECK,
 * and SettingsModule.tsx's projectedWeightSum()/projectedMergedWeightSum()
 * headers for the client-side, warn-don't-block posture. The real hard
 * stop is finalizeWeightedCourseResult() below.
 */
export async function upsertCourseResultComponent(
  schoolId: string,
  component: { id?: string; name: string; weight_pct: number; sort_order: number; courseId?: string | null },
): Promise<{ error: string | null }> {
  const payload = {
    school_id: schoolId,
    course_id: component.courseId ?? null,
    name: component.name,
    weight_pct: component.weight_pct,
    sort_order: component.sort_order,
    updated_at: new Date().toISOString(),
  }

  if (component.id) {
    const { error } = await supabase.from('course_result_components').update(payload).eq('id', component.id)
    if (error) return { error: error.message }
  } else {
    const { error } = await supabase.from('course_result_components').insert(payload)
    if (error) return { error: error.message }
  }

  return { error: null }
}

/**
 * Hard delete — ADMIN-ONLY per RLS. Matching settingsService.ts's own
 * catalogue/config-data carve-out (deletePeriod/deleteRole/
 * deleteStudentRole/deleteHigherEdGradeBand precedent) rather than this
 * file's no-hard-deletes-by-default convention elsewhere, since a
 * component definition is catalogue data, not a person or financial
 * record. Does NOT cascade-check course_result_component_scores first —
 * the FK on that table has no explicit ON DELETE clause in migration_
 * session_60a.sql, so Postgres will reject this delete with a foreign-key
 * violation if any score rows reference this component (school-wide or
 * course-specific — same table, same FK, same behavior either way). That
 * is the correct behavior (silently orphaning entered marks would be
 * worse than a blocked delete with a clear error) and is surfaced to the
 * caller as a normal { error } rather than specially detected/rephrased
 * here.
 */
export async function deleteCourseResultComponent(componentId: string): Promise<{ error: string | null }> {
  const { error } = await supabase.from('course_result_components').delete().eq('id', componentId)
  if (error) return { error: error.message }
  return { error: null }
}

/**
 * One row of a course's EFFECTIVE component set — the result of merging
 * the school-wide set with that course's course-specific rows (see
 * mergeCourseResultComponents()/resolveCourseResultComponents() below).
 * `source` tells the caller whether this row came from the school-wide
 * set untouched or was replaced/added by a course-specific row —
 * CourseResultsModule.tsx's scoring grid doesn't currently need to
 * distinguish the two (a lecturer scores whatever is in the effective
 * set, regardless of where it came from), but SettingsModule.tsx's
 * per-course admin UI does, to know which rows are editable from that
 * screen (course-specific only — school-wide rows shown for context are
 * edited from the school-wide section instead).
 */
export interface ResolvedCourseResultComponent {
  id: string
  name: string
  weight_pct: number
  sort_order: number
  source: 'school' | 'course'
}

/**
 * Merges the school-wide component set with a course's course-specific
 * rows, BY NAME — a course-specific row replaces the school-wide
 * component of the same name (weight/sort_order taken from the
 * course-specific row), and any school-wide component with no matching
 * course-specific name is inherited unchanged. A course-specific name with
 * no school-wide counterpart is a pure addition (e.g. "Practical" for a
 * lab course that has no school-wide equivalent).
 *
 * This is the ONE place the merge happens — both the admin UI's preview
 * and finalizeWeightedCourseResult()'s authoritative sum call this same
 * function, so the two can never disagree about what a course's effective
 * component set is. Matching is case-sensitive and exact on `name`; a
 * near-miss ("CA " vs "CA") is treated as a distinct, additional
 * component rather than fuzzy-matched — silently guessing a match would
 * be worse than an admin noticing an unexpected extra row.
 */
export function mergeCourseResultComponents(
  schoolWide: CourseResultComponent[],
  courseSpecific: CourseResultComponent[],
): ResolvedCourseResultComponent[] {
  const courseByName = new Map(courseSpecific.map((c) => [c.name, c]))
  const merged: ResolvedCourseResultComponent[] = []

  for (const c of schoolWide) {
    const cs = courseByName.get(c.name)
    if (cs) {
      merged.push({ id: cs.id, name: cs.name, weight_pct: cs.weight_pct, sort_order: cs.sort_order, source: 'course' })
      courseByName.delete(c.name)
    } else {
      merged.push({ id: c.id, name: c.name, weight_pct: c.weight_pct, sort_order: c.sort_order, source: 'school' })
    }
  }
  // Remaining course-specific rows had no school-wide counterpart — pure additions.
  for (const cs of courseByName.values()) {
    merged.push({ id: cs.id, name: cs.name, weight_pct: cs.weight_pct, sort_order: cs.sort_order, source: 'course' })
  }

  return merged.sort((a, b) => a.sort_order - b.sort_order)
}

/**
 * Resolves the effective component set for one course: loads the school's
 * school-wide rows (course_id IS NULL) and that course's course-specific
 * rows (course_id = courseId) in parallel — TWO QUERIES against the SAME
 * table, not two tables — then merges them via
 * mergeCourseResultComponents(). This is what finalizeWeightedCourseResult()
 * and CourseResultsModule.tsx's scoring grid should call instead of
 * loadCourseResultComponents() directly, once a specific course is known —
 * loadCourseResultComponents() alone is still correct for the admin UI's
 * school-wide list, which has no single course in scope.
 */
export async function resolveCourseResultComponents(
  schoolId: string,
  courseId: string,
): Promise<{
  data: ResolvedCourseResultComponent[]
  error: string | null
}> {
  const [schoolRes, courseRes] = await Promise.all([
    loadCourseResultComponents(schoolId),
    loadCourseSpecificComponents(courseId),
  ])
  if (schoolRes.error) return { data: [], error: schoolRes.error }
  if (courseRes.error) return { data: [], error: courseRes.error }
  return { data: mergeCourseResultComponents(schoolRes.data, courseRes.data), error: null }
}

// ─── Read/write: course_result_component_scores (entered marks) ───────────

/**
 * Loads every entered component score for a given course offering's
 * scorable registrations, keyed for O(1) lookup exactly like
 * resultsService.ts's buildScoreMap() — same `${registrationId}|${componentId}`
 * key shape, adapted to this domain's identifiers.
 *
 * Scoped by registration ids rather than by offering directly, since
 * course_result_component_scores has no course_offering_id column of its
 * own (mirrors course_results' own shape — scoped one hop further back,
 * through course_registrations).
 */
export async function loadComponentScoresForRegistrations(
  registrationIds: string[],
): Promise<{ data: Map<string, ComponentScore>; error: string | null }> {
  if (registrationIds.length === 0) return { data: new Map(), error: null }

  const { data, error } = await supabase
    .from('course_result_component_scores')
    .select('id, course_registration_id, course_result_component_id, value, entered_by')
    .in('course_registration_id', registrationIds)

  if (error) return { data: new Map(), error: error.message }

  const map = new Map<string, ComponentScore>()
  for (const row of (data ?? []) as any[]) {
    const score: ComponentScore = {
      id: row.id,
      course_registration_id: row.course_registration_id,
      course_result_component_id: row.course_result_component_id,
      value: Number(row.value),
      entered_by: row.entered_by,
    }
    map.set(`${score.course_registration_id}|${score.course_result_component_id}`, score)
  }
  return { data: map, error: null }
}

/**
 * Upserts one component score. Not yet a "finalize" action on its own —
 * entering a CA mark doesn't finalize the course_results row; only
 * finalizeWeightedCourseResult() below does that, by design (a lecturer
 * should be able to enter CA now and Exam weeks later without either
 * write prematurely finalizing a result).
 *
 * onConflict targets the table's own unique(course_registration_id,
 * course_result_component_id) constraint (migration_session_60a.sql),
 * mirroring saveScore()'s onConflict pattern in resultsService.ts.
 */
export async function saveComponentScore(params: {
  registrationId: string
  componentId: string
  value: number
  enteredBy: string
}): Promise<{ error: string | null }> {
  const payload = {
    course_registration_id: params.registrationId,
    course_result_component_id: params.componentId,
    value: params.value,
    entered_by: params.enteredBy,
    updated_at: new Date().toISOString(),
  }

  const { error } = await supabase
    .from('course_result_component_scores')
    .upsert(payload, { onConflict: 'course_registration_id,course_result_component_id' })

  if (error) return { error: error.message }
  return { error: null }
}

// ─── Write: finalize from weighted components ──────────────────────────────

/**
 * SESSION 60a card step 4's decision, recorded here as instructed rather
 * than left to be re-litigated: course_results.score/letter_grade/
 * grade_point become populated by SUMMING course_result_component_scores
 * AT FINALIZE TIME (cache-on-finalize), not as a live view.
 *
 * Why cache-on-finalize over a live view (unlike subject_results, which IS
 * a view on the secondary side): student_gpa_snapshots already established
 * the "cache, recomputed on finalize, never derived live on every read"
 * precedent in §4.1/SESSION 60, and course_results itself already IS a
 * cached table (SESSION 60 populates score/letter_grade/grade_point on
 * finalizeScore(), not via a view) — a live view here would mean two
 * different derivation strategies for the same table depending on whether
 * 60a has landed for a given school, which is worse than one consistent
 * strategy throughout. It also keeps gpaService.ts and
 * loadFinalizedAttemptsForStudent() completely untouched, since both only
 * ever read the already-finalized score/grade_point columns regardless of
 * how they were produced — the boundary SESSION 60 already designed for.
 *
 * Requires every defined component to have a score entered for this
 * registration before finalizing — a partial weighted sum (e.g. only CA
 * entered, Exam still missing) would silently understate the total rather
 * than surface as incomplete. Returns a specific error naming which
 * component(s) are missing rather than a generic failure, so the caller
 * can show the lecturer exactly what's outstanding.
 *
 * Does NOT itself look up the grade band — same pure/impure split
 * gpaService.ts's header already documents for saveCourseResult(); the
 * caller resolves the band via findGradeBand() and passes letterGrade/
 * gradePoint through, exactly like saveCourseResult() already requires.
 */
export async function finalizeWeightedCourseResult(params: {
  registrationId: string
  letterGrade: string
  gradePoint: number
}): Promise<{ data: { score: number } | null; error: string | null }> {
  // Step 1: resolve this registration's school_id AND course_id (via the
  // same course_registrations -> students join every RLS policy in this
  // domain already uses, plus course_registrations.course_id directly).
  // course_id is needed as of SESSION 60c to resolve this specific
  // course's effective component set (school-wide + its overrides), not
  // just the school-wide set alone.
  const { data: regRow, error: regErr } = await supabase
    .from('course_registrations')
    .select('course_id, students(school_id)')
    .eq('id', params.registrationId)
    .maybeSingle()

  if (regErr) return { data: null, error: regErr.message }
  if (!regRow) return { data: null, error: 'Registration not found.' }

  const studentRel = (Array.isArray((regRow as any).students) ? (regRow as any).students[0] : (regRow as any).students) as
    | { school_id: string }
    | undefined
  const schoolId = studentRel?.school_id
  const courseId = (regRow as any).course_id as string | undefined
  if (!schoolId) return { data: null, error: 'Could not resolve school for this registration.' }
  if (!courseId) return { data: null, error: 'Could not resolve course for this registration.' }

  // Step 2: resolve this course's effective (merged) component set — SESSION
  // 60c's resolveCourseResultComponents(), not the raw school-wide load —
  // and this registration's entered scores, in parallel.
  const [componentsRes, scoresRes] = await Promise.all([
    resolveCourseResultComponents(schoolId, courseId),
    supabase
      .from('course_result_component_scores')
      .select('course_result_component_id, value')
      .eq('course_registration_id', params.registrationId),
  ])

  if (componentsRes.error) return { data: null, error: componentsRes.error }
  if (scoresRes.error) return { data: null, error: scoresRes.error.message }

  const components = componentsRes.data
  if (components.length === 0) {
    return { data: null, error: 'No CA/exam components configured for this school yet — define them in Grading settings before finalizing.' }
  }

  const scoreByComponentId = new Map<string, number>(
    ((scoresRes.data ?? []) as Array<{ course_result_component_id: string; value: number }>).map(
      (s) => [s.course_result_component_id, Number(s.value)],
    ),
  )

  // Every defined component must have a value before finalizing — a
  // partial sum (e.g. CA entered, Exam missing) would silently understate
  // the total rather than surface as incomplete, per this function's own
  // header.
  const missing = components.filter((c) => !scoreByComponentId.has(c.id))
  if (missing.length > 0) {
    return {
      data: null,
      error: `Missing score for: ${missing.map((c) => c.name).join(', ')}. Enter all components before finalizing.`,
    }
  }

  // Weight-sum guard, added alongside SettingsModule.tsx's admin UI no
  // longer blocking a save at every intermediate (not-yet-100%) state —
  // see that file's projectedWeightSum() header for why the save-time
  // block was removed (it made incremental set-building impossible). This
  // is now the one place that actually stops a misconfigured set (weights
  // summing to e.g. 90 or 110) from silently producing a mis-scaled score;
  // same floating-point tolerance as the admin UI previously used, so a
  // genuinely-correct 33.33×3 split isn't rejected on representation error.
  const weightSum = components.reduce((sum, c) => sum + c.weight_pct, 0)
  if (Math.abs(weightSum - 100) > 0.01) {
    return {
      data: null,
      error: `This school's CA/exam components sum to ${weightSum.toFixed(2)}%, not 100% — an admin must fix the weights in Grading settings before scores can be finalized.`,
    }
  }

  const weightedScore = components.reduce((sum, c) => {
    const value = scoreByComponentId.get(c.id) ?? 0
    return sum + value * (c.weight_pct / 100)
  }, 0)

  const saveRes = await saveCourseResult({
    registrationId: params.registrationId,
    score: weightedScore,
    letterGrade: params.letterGrade,
    gradePoint: params.gradePoint,
  })
  if (saveRes.error) return { data: null, error: saveRes.error }

  return { data: { score: weightedScore }, error: null }
}
