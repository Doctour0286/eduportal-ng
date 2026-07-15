/**
 * gpaService.ts
 * Pure computation functions for GPA/CGPA, per master plan §7.27.4
 * ("Computation" note — written out there so it is never reinvented ad hoc
 * in code; this file is the single implementation of that spec).
 *
 * Deliberately has NO Supabase calls and NO knowledge of course_results /
 * course_registrations table shapes beyond the minimal fields listed below.
 * Callers (resultsService.ts / ResultsModule.tsx) are responsible for
 * fetching rows and mapping them into CourseAttempt[] before calling in.
 * This keeps the actual GPA math unit-testable in isolation, and keeps a
 * single place to fix if §7.27.4's spec is ever revisited.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Matches settingsService.ts's GradeScaleBand shape (the higher-ed columns only). */
export interface GradeBand {
  min_score: number
  max_score: number
  grade_label: string
  grade_point: number
}

export type RollupMethod = 'weighted_all_attempts' | 'average_of_semester_gpas'
export type RetakeTreatment = 'replacement' | 'dilution'

/**
 * One scored course attempt, already joined with courses.credit_units
 * (credit_units lives only on `courses`, confirmed via live schema —
 * never on course_registrations or course_results — so callers must join
 * through course_registrations.course_id, same pattern
 * courseRegistrationService.ts already uses in three places).
 */
export interface CourseAttempt {
  registrationId: string
  /** Self-FK per §7.27.2: null for an original attempt, set to the original
   *  registration's id for a carryover re-registration. */
  originalRegistrationId: string | null
  isCarryover: boolean
  sessionId: string
  /** Matches course_registrations.term_id — null when the school doesn't
   *  use terms (session.uses_terms = false), same nullability convention
   *  as course_registrations/course_offerings/programme_curriculum. */
  termId: string | null
  creditUnits: number
  score: number | null
  /** Only attempts with finalized_at set (and therefore a score) count
   *  toward GPA/CGPA. Callers should not pass unfinalized rows in, but this
   *  is re-checked defensively inside the compute functions. */
  finalized: boolean
}

export interface ScoredAttempt extends CourseAttempt {
  gradeLabel: string
  gradePoint: number
  qualityPoints: number
}

export interface SemesterGpaResult {
  sessionId: string
  termId: string | null
  totalUnitsAttempted: number
  totalQualityPoints: number
  gpa: number | null // null if zero units attempted (avoid divide-by-zero)
}

export interface CgpaResult {
  cgpa: number | null
  totalUnitsAttempted: number
  totalQualityPoints: number
}

// ---------------------------------------------------------------------------
// Band lookup — score -> {grade_label, grade_point}
// ---------------------------------------------------------------------------

/**
 * Finds the grade band whose [min_score, max_score] range contains `score`.
 * Bands are assumed inclusive on both ends, matching how they're authored
 * in the Grading tab (SESSION 59) — adjacent bands should not overlap, but
 * this does not enforce that; it takes the first match in sort_order.
 * Returns null if no band matches (score out of configured range, or no
 * grade scale configured at all) — callers must handle this, never
 * silently default to a grade point of 0.
 */
export function findGradeBand(score: number, bands: GradeBand[]): GradeBand | null {
  return bands.find((b) => score >= b.min_score && score <= b.max_score) ?? null
}

/**
 * Attaches grade_label/grade_point/quality_points to a raw CourseAttempt by
 * looking up its score against the school's grade scale. Throws if the
 * score falls outside every band — this is treated as a configuration
 * error (grade scale doesn't cover the full 0-100 range) that must surface,
 * not silently produce a wrong GPA.
 */
export function scoreAttempt(attempt: CourseAttempt, bands: GradeBand[]): ScoredAttempt {
  if (attempt.score === null) {
    throw new Error(`Cannot score attempt ${attempt.registrationId}: no score recorded`)
  }
  const band = findGradeBand(attempt.score, bands)
  if (!band) {
    throw new Error(
      `Cannot score attempt ${attempt.registrationId}: score ${attempt.score} matches no configured grade band`,
    )
  }
  return {
    ...attempt,
    gradeLabel: band.grade_label,
    gradePoint: band.grade_point,
    qualityPoints: band.grade_point * attempt.creditUnits,
  }
}

// ---------------------------------------------------------------------------
// Retake resolution — §7.27.4's replacement vs dilution rule
// ---------------------------------------------------------------------------

/**
 * Applies the school's retake_treatment to a full list of scored attempts
 * for one student, returning the subset that should actually enter the
 * GPA/CGPA arithmetic.
 *
 * - 'dilution': every finalized attempt counts, permanently. No filtering.
 * - 'replacement': for any attempt chain (an original registration and its
 *   carryover re-registrations, linked via originalRegistrationId), only
 *   the most recent PASSING attempt counts if one exists; otherwise the
 *   most recent attempt of any kind counts (so an unresolved carryover
 *   still contributes its — failing — quality points until retaken).
 *   Earlier attempts in the chain are excluded from the calculation, but
 *   this function does not delete or alter them — callers still display
 *   the full history on the transcript, annotated superseded, per spec.
 *
 * A "chain" is grouped by walking originalRegistrationId back to its root:
 * every attempt with the same root registration id is one chain, ordered
 * by session for recency (course_registrations doesn't carry an explicit
 * attempt-number column, so session order is the only ordering signal
 * available; ties broken by array input order as a stable fallback).
 *
 * `isPassing` is required from the caller rather than inferred here, since
 * "passing" is grade-scale-defined (varies by school), not a fixed cutoff
 * this function should hardcode.
 */
export function resolveAttemptsForCalculation(
  attempts: ScoredAttempt[],
  retakeTreatment: RetakeTreatment,
  isPassing: (attempt: ScoredAttempt) => boolean,
  sessionOrder: (sessionId: string) => number,
): ScoredAttempt[] {
  if (retakeTreatment === 'dilution') {
    return attempts
  }

  // 'replacement': group into chains by root registration id.
  const rootOf = (a: ScoredAttempt): string => {
    let current = a
    // originalRegistrationId points at another attempt in `attempts`; walk
    // until we hit an attempt whose originalRegistrationId is null (the
    // true original), or until we can't find the parent in-set (defensive
    // — treat as its own root rather than looping/crashing).
    const seen = new Set<string>()
    while (current.originalRegistrationId && !seen.has(current.registrationId)) {
      seen.add(current.registrationId)
      const parent = attempts.find((x) => x.registrationId === current.originalRegistrationId)
      if (!parent) break
      current = parent
    }
    return current.registrationId
  }

  const chains = new Map<string, ScoredAttempt[]>()
  for (const a of attempts) {
    const root = rootOf(a)
    const list = chains.get(root) ?? []
    list.push(a)
    chains.set(root, list)
  }

  const resolved: ScoredAttempt[] = []
  for (const chainAttempts of chains.values()) {
    const bySessionDesc = [...chainAttempts].sort(
      (a, b) => sessionOrder(b.sessionId) - sessionOrder(a.sessionId),
    )
    const mostRecentPass = bySessionDesc.find(isPassing)
    resolved.push(mostRecentPass ?? bySessionDesc[0])
  }
  return resolved
}

// ---------------------------------------------------------------------------
// Semester GPA
// ---------------------------------------------------------------------------

/**
 * Groups already-resolved (retake-filtered) attempts by (sessionId, termId)
 * and computes GPA = Σquality_points ÷ Σcredit_units per group.
 * A null `termId` groups together as one bucket per session — the correct
 * behavior for a school with session.uses_terms = false, where "semester"
 * and "session" are the same period.
 */
export function computeSemesterGpas(attempts: ScoredAttempt[]): SemesterGpaResult[] {
  const groups = new Map<string, { sessionId: string; termId: string | null; attempts: ScoredAttempt[] }>()
  for (const a of attempts) {
    const key = `${a.sessionId}::${a.termId ?? ''}`
    const g = groups.get(key) ?? { sessionId: a.sessionId, termId: a.termId, attempts: [] }
    g.attempts.push(a)
    groups.set(key, g)
  }

  return Array.from(groups.values()).map((g) => {
    const totalUnitsAttempted = g.attempts.reduce((sum, a) => sum + a.creditUnits, 0)
    const totalQualityPoints = g.attempts.reduce((sum, a) => sum + a.qualityPoints, 0)
    return {
      sessionId: g.sessionId,
      termId: g.termId,
      totalUnitsAttempted,
      totalQualityPoints,
      gpa: totalUnitsAttempted > 0 ? totalQualityPoints / totalUnitsAttempted : null,
    }
  })
}

// ---------------------------------------------------------------------------
// CGPA
// ---------------------------------------------------------------------------

/**
 * Computes running CGPA under the school's configured rollup_method.
 *
 * - 'weighted_all_attempts': Σquality_points ÷ Σcredit_units across every
 *   attempt passed in directly (already retake-resolved by the caller via
 *   resolveAttemptsForCalculation).
 * - 'average_of_semester_gpas': arithmetic mean of each completed
 *   semester's GPA. Semesters with zero units attempted (gpa === null) are
 *   excluded from the average rather than treated as 0, since a semester
 *   with no finalized results isn't "completed" and averaging in a 0 would
 *   incorrectly punish the student.
 *
 * Takes already-resolved ScoredAttempt[] for 'weighted_all_attempts', and
 * already-computed SemesterGpaResult[] for 'average_of_semester_gpas' —
 * two different shapes because the two methods genuinely operate on
 * different units of aggregation; forcing one signature would hide that.
 */
export function computeCgpaWeightedAllAttempts(attempts: ScoredAttempt[]): CgpaResult {
  const totalUnitsAttempted = attempts.reduce((sum, a) => sum + a.creditUnits, 0)
  const totalQualityPoints = attempts.reduce((sum, a) => sum + a.qualityPoints, 0)
  return {
    totalUnitsAttempted,
    totalQualityPoints,
    cgpa: totalUnitsAttempted > 0 ? totalQualityPoints / totalUnitsAttempted : null,
  }
}

export function computeCgpaAverageOfSemesterGpas(semesterGpas: SemesterGpaResult[]): CgpaResult {
  const completed = semesterGpas.filter((s) => s.gpa !== null)
  const totalUnitsAttempted = completed.reduce((sum, s) => sum + s.totalUnitsAttempted, 0)
  const totalQualityPoints = completed.reduce((sum, s) => sum + s.totalQualityPoints, 0)
  const cgpa =
    completed.length > 0
      ? completed.reduce((sum, s) => sum + (s.gpa as number), 0) / completed.length
      : null
  return { totalUnitsAttempted, totalQualityPoints, cgpa }
}

/**
 * Single entry point tying the above together: given every finalized
 * attempt for a student (already scored), the school's policy, a passing
 * predicate, and a session-ordering function, returns both the semester
 * breakdown and the running CGPA — everything callers need to write a
 * student_gpa_snapshots row (one per-semester row plus one null-semester
 * running-CGPA row, per that table's documented shape).
 */
export function computeStudentGpaSummary(
  allAttempts: ScoredAttempt[],
  rollupMethod: RollupMethod,
  retakeTreatment: RetakeTreatment,
  isPassing: (attempt: ScoredAttempt) => boolean,
  sessionOrder: (sessionId: string) => number,
): { semesterGpas: SemesterGpaResult[]; cgpa: CgpaResult } {
  const resolved = resolveAttemptsForCalculation(allAttempts, retakeTreatment, isPassing, sessionOrder)
  const semesterGpas = computeSemesterGpas(resolved)
  const cgpa =
    rollupMethod === 'weighted_all_attempts'
      ? computeCgpaWeightedAllAttempts(resolved)
      : computeCgpaAverageOfSemesterGpas(semesterGpas)
  return { semesterGpas, cgpa }
}
