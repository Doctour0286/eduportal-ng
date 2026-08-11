/**
 * CourseRegistrationModule.tsx
 * Admin/course-adviser-facing course registration workflow (PRD Tier 8 /
 * Problem 8.7, SESSION 57).
 *
 * Flow: search + pick a student → resolve their current programme/level
 * placement → pick a term (if the school uses terms) → core courses
 * auto-populate, electives are chosen, any outstanding carryover is
 * offered for inclusion → credit-load cap enforced live → save.
 *
 * Deliberately a separate top-level module from SettingsModule.tsx (own
 * route, own service file, own CSS namespace `reg-*`), matching this
 * project's existing split between operational modules
 * (AttendanceModule.tsx, StudentsModule.tsx) and the settings/config
 * module — registering a student each session is day-to-day operational
 * work, not configuration, the same distinction already drawn between
 * CurriculumTab (defines a curriculum once) and this screen (assigns real
 * students against it repeatedly).
 *
 * NOT YET WIRED INTO APP.TSX — App.tsx was not included in this session's
 * uploads, so the route/nav entry for this module could not be added.
 * Needs: a route entry pointing here (mirroring how SettingsModule is
 * mounted) and a nav-bar/menu link, gated the same way Institution/
 * Curriculum are gated in SettingsModule.tsx (higher-ed school types only).
 *
 * Pattern rules (consistent with SettingsModule.tsx):
 *   - schoolId threaded on every call — never inferred client-side
 *   - Joined relations cast through unknown → array before plucking [0]
 *     (inside courseRegistrationService.ts, not duplicated here)
 *   - No silently-disabled buttons — a disabled action always has a
 *     visible reason (title/hint text), not just a greyed-out state
 */

import { useState, useEffect, useCallback } from 'react'
import {
  searchStudents, loadCurrentSession, loadTerms,
  type StudentSearchResult, type Term,
} from '../services/settingsService'
import {
  loadStudentPlacement, loadRegistrableCourses, loadOutstandingCarryover,
  loadExistingRegistrations, loadCurrentRegistration, checkCreditLoad, registerStudent,
  type StudentCurrentPlacement, type RegistrableCourse, type CarryoverCourse,
  type CurrentRegistrationRow,
} from '../services/courseRegistrationService'

// Duplicated intentionally from SettingsModule.tsx's own private
// (unexported) copy — that list is not importable across module
// boundaries as written. If a third module ever needs this same gate,
// worth promoting to a shared lib/schoolType.ts rather than a third copy.
const HIGHER_INSTITUTION_SCHOOL_TYPES = ['university', 'polytechnic', 'college_of_education', 'other']
function isHigherInstitutionSchoolType(schoolType: string | null | undefined): boolean {
  return !!schoolType && HIGHER_INSTITUTION_SCHOOL_TYPES.includes(schoolType)
}

// ─── Small shared primitives (local to this module — see header note) ─────

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="reg-field-row">
      <label className="reg-field-label">{label}</label>
      <div className="reg-field-control">{children}</div>
    </div>
  )
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(t)
  }, [value, delayMs])
  return debounced
}

// ─── Root component ─────────────────────────────────────────────────────────

export default function CourseRegistrationModule({ schoolId, isAdmin, schoolType }: {
  schoolId: string
  isAdmin: boolean
  schoolType?: string | null
}) {
  if (!isAdmin) return null
  if (!isHigherInstitutionSchoolType(schoolType)) return null

  const [step, setStep] = useState<'search' | 'register'>('search')
  const [selectedStudent, setSelectedStudent] = useState<StudentSearchResult | null>(null)

  return (
    <div className="reg-root">
      <div className="reg-header">
        <h1 className="reg-title">Course Registration</h1>
        <p className="reg-subtitle">Register a student's courses for the current session</p>
      </div>
      {step === 'search' ? (
        <StudentSearchStep
          schoolId={schoolId}
          onPick={(s) => { setSelectedStudent(s); setStep('register') }}
        />
      ) : selectedStudent ? (
        <RegistrationStep
          schoolId={schoolId}
          student={selectedStudent}
          onBack={() => { setStep('search'); setSelectedStudent(null) }}
        />
      ) : null}
    </div>
  )
}

// ─── Step 1: find the student ───────────────────────────────────────────────

function StudentSearchStep({ schoolId, onPick }: {
  schoolId: string
  onPick: (student: StudentSearchResult) => void
}) {
  const [query, setQuery] = useState('')
  const debouncedQuery = useDebouncedValue(query, 300)
  const [results, setResults] = useState<StudentSearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (debouncedQuery.trim().length < 2) { setResults([]); return }
    let cancelled = false
    setLoading(true)
    searchStudents(schoolId, debouncedQuery.trim()).then(res => {
      if (cancelled) return
      setLoading(false)
      if (res.error) { setError(res.error); return }
      setError(null)
      setResults(res.data)
    })
    return () => { cancelled = true }
  }, [schoolId, debouncedQuery])

  return (
    <div className="reg-tab-content">
      <FieldRow label="Find student">
        <input
          className="reg-input"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Name or matric number…"
          autoFocus
        />
      </FieldRow>
      {error && <p className="reg-form-error">{error}</p>}
      {loading && <p className="reg-hint-text">Searching…</p>}
      {!loading && debouncedQuery.trim().length >= 2 && results.length === 0 && !error && (
        <p className="reg-empty-hint">No students found matching "{debouncedQuery.trim()}".</p>
      )}
      {results.map(s => (
        <button key={s.id} className="reg-list-row reg-list-row--button" onClick={() => onPick(s)}>
          <div className="reg-list-row-info">
            <p className="reg-list-row-name">{s.full_name}</p>
            <p className="reg-list-row-meta">{s.matric_number ?? 'No matric number assigned'}</p>
          </div>
        </button>
      ))}
    </div>
  )
}

// ─── Step 2: resolve placement, pick term, build registration ─────────────

// Exported (SESSION 69): GuardianPortal's new RegistrationTab reuses this
// component byte-for-byte for the student self-service flow -- see that
// file's RegistrationTab for why reuse, not reimplementation, is required
// here (registerStudent()'s withdraw-diff behavior is only safe when the
// caller has first seen and edited the existing registration set, which
// this component's own mount effect already guarantees).
//
// PRD Tier 9 / Problem 9.6: this component now forks on mount between two
// views once a placement is resolved — a "Currently registered" summary
// (default, whenever loadCurrentRegistration() returns any active rows)
// and the original curriculum-picker form (first-time registration, or
// reached via the summary's own "Add course" entry point). readOnly hides
// every write control (Drop/Add) for the student self-service caller —
// GuardianPortal's RegistrationTab passes readOnly, plus an optional
// coreAcceptBanner slot it renders above the summary for the one
// student-side additive exception (see that file for the banner itself).
export function RegistrationStep({ schoolId, student, onBack, readOnly = false, renderAboveSummary, onSummaryTermFilterChange }: {
  schoolId: string
  student: StudentSearchResult
  onBack: () => void
  readOnly?: boolean
  renderAboveSummary?: (ctx: { onCourseAdded: () => void }) => React.ReactNode
  // Owner-requested (2026-08-06): lets a caller (GuardianPortal.tsx's
  // RegistrationTab) mirror the summary's own semester filter into its
  // own separate download button, so "download PDF" respects whatever
  // semester the student is currently looking at rather than always
  // downloading everything. Fired with the resolved term's id+name (or
  // null for "All semesters") on every change, including the initial
  // mount default. Deliberately a callback, not a lifted/controlled
  // prop — CourseRegistrationModule.tsx's own admin usage of this same
  // component doesn't want this filter at all, so keeping the state
  // internal here and only reporting it outward avoids forcing every
  // caller to manage state it doesn't need.
  onSummaryTermFilterChange?: (filter: { termId: string | null; termName: string | null }) => void
}) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [placement, setPlacement] = useState<StudentCurrentPlacement | null>(null)
  const [terms, setTerms] = useState<Term[]>([])
  const [selectedTermId, setSelectedTermId] = useState<string | null>(null)

  const [curriculum, setCurriculum] = useState<RegistrableCourse[]>([])
  const [carryover, setCarryover] = useState<CarryoverCourse[]>([])
  const [curriculumLoading, setCurriculumLoading] = useState(false)

  const [selectedElectiveIds, setSelectedElectiveIds] = useState<Set<string>>(new Set())
  const [includedCarryoverIds, setIncludedCarryoverIds] = useState<Set<string>>(new Set())

  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  // Currently-registered summary state (Problem 9.6). currentRegistration
  // is null while unresolved, [] once resolved with no active rows (first-
  // time registration — go straight to the picker), non-empty once an
  // active registration exists (show the summary first). view toggles
  // between the summary and the picker form for the admin's "Add course"
  // entry point; readOnly callers never leave 'summary' since they have
  // no write path into the picker at all.
  //
  // CurrentRegistrationRow (not ExistingRegistration) — this summary is
  // session-scoped only, not term-scoped, per the fix below.
  const [currentRegistration, setCurrentRegistration] = useState<CurrentRegistrationRow[] | null>(null)
  const [registrationLoading, setRegistrationLoading] = useState(false)
  const [view, setView] = useState<'summary' | 'picker'>('summary')
  const [dropTarget, setDropTarget] = useState<CurrentRegistrationRow | null>(null)
  const [dropping, setDropping] = useState(false)
  const [dropError, setDropError] = useState<string | null>(null)

  // Summary-view semester filter (owner-requested, 2026-08-06) — separate
  // from selectedTermId above on purpose. selectedTermId drives the
  // PICKER (which term's curriculum to register a student INTO — a
  // write-path concern), while this drives which of the student's already-
  // saved rows the summary/PDF actually DISPLAY — a pure read-side filter.
  // Conflating the two would mean opening "Add course" for one term could
  // silently change what the summary shows, or vice versa; kept
  // independent so each screen's term choice only affects that screen.
  // null = "All semesters" (default — show everything, matching how the
  // summary behaved before this filter existed).
  const [summaryTermFilter, setSummaryTermFilter] = useState<string | null>(null)

  // Caller (GuardianPortal.tsx) is expected to pass a useCallback-memoized
  // onSummaryTermFilterChange — see that file's own usage — so this effect
  // can safely include it in its dependency array without an infinite
  // refire loop from a fresh inline function identity every render.
  useEffect(() => {
    if (!onSummaryTermFilterChange) return
    const termName = terms.find(t => t.id === summaryTermFilter)?.name ?? null
    onSummaryTermFilterChange({ termId: summaryTermFilter, termName })
  }, [summaryTermFilter, terms, onSummaryTermFilterChange])

  // Load placement + session + terms once, on mount.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    ;(async () => {
      const [placementRes, sessRes] = await Promise.all([
        loadStudentPlacement(student.id),
        loadCurrentSession(schoolId),
      ])
      if (cancelled) return
      if (placementRes.error) { setError(placementRes.error); setLoading(false); return }
      if (!placementRes.data) {
        setError(`${student.full_name} has no current programme/level placement. Place them in the Institution tab first, then come back to register courses.`)
        setLoading(false)
        return
      }
      setPlacement(placementRes.data)
      if (!sessRes.error && sessRes.data) {
        const tRes = await loadTerms(schoolId, sessRes.data.id)
        if (!cancelled && !tRes.error) setTerms(tRes.data)
      }
      if (!cancelled) setLoading(false)
    })()
    return () => { cancelled = true }
  }, [schoolId, student.id, student.full_name])

  // Load curriculum/carryover/existing once we know the placement (and,
  // if this school has terms, once a term is chosen — same "term picker
  // only appears when terms exist, otherwise scoped by session alone"
  // rule CurriculumTab already established).
  const loadForTerm = useCallback(async () => {
    if (!placement) return
    if (terms.length > 0 && !selectedTermId) { setCurriculum([]); return }
    setCurriculumLoading(true)
    const termId = terms.length > 0 ? selectedTermId : null
    const [curRes, carryRes, existRes] = await Promise.all([
      loadRegistrableCourses(placement.programme_level_id, termId),
      loadOutstandingCarryover(student.id),
      loadExistingRegistrations(student.id, placement.session_id, termId),
    ])
    if (!curRes.error) setCurriculum(curRes.data)
    if (!carryRes.error) setCarryover(carryRes.data)
    if (!existRes.error) {
      // Pre-check electives that are already actively registered, so
      // re-opening this screen reflects the real saved state rather than
      // resetting selections every time. Note: includedCarryoverIds is
      // keyed by original_registration_id, but an existing re-registered
      // carryover row's course_id is what's in existRes — both are safe
      // to compare here since a student cannot have two outstanding
      // carryover rows for the same course_id at once (each carryover
      // resolves before a new one for that course could exist).
      setSelectedElectiveIds(new Set(existRes.data.filter(e => !e.is_carryover).map(e => e.course_id)))
      const registeredCarryoverCourseIds = new Set(existRes.data.filter(e => e.is_carryover).map(e => e.course_id))
      setIncludedCarryoverIds(new Set(
        carryRes.error ? [] : carryRes.data.filter(c => registeredCarryoverCourseIds.has(c.course_id)).map(c => c.original_registration_id),
      ))
    }
    setCurriculumLoading(false)
  }, [placement, terms.length, selectedTermId, student.id])

  useEffect(() => { loadForTerm() }, [loadForTerm])

  // Load the "currently registered" summary once we know the placement.
  // Deliberately session-scoped only (no term dependency, no readiness
  // gate on selectedTermId) — this is the fix for the real on-device bug
  // traced via direct SQL: a student can have active course_registrations
  // rows spread across more than one term_id (including null) for the
  // same session, because registerStudent()'s withdraw-diff only
  // reconciles within the exact term it's called with. Gating this on
  // selectedTermId (as the term-scoped picker/curriculum load must) would
  // silently re-introduce the same bug — showing only whichever term the
  // admin happens to have selected, hiding the rest. loadCurrentRegistration()
  // itself now loads every active row for student+session regardless of
  // term, so this effect only needs to wait on placement.
  const refreshCurrentRegistration = useCallback(async () => {
    if (!placement) return
    setRegistrationLoading(true)
    const res = await loadCurrentRegistration(student.id, placement.session_id)
    if (!res.error) setCurrentRegistration(res.data)
    setRegistrationLoading(false)
  }, [placement, student.id])

  useEffect(() => { refreshCurrentRegistration() }, [refreshCurrentRegistration])

  // Admin-only: drop one course from the active registration. Per the
  // design-fork decision (see courseRegistrationService.ts's
  // registerStudent() header), this is a full-set resubmit, not a
  // surgical delete — but registerStudent() reconciles within exactly one
  // (session_id, term_id) at a time, and currentRegistration can now
  // legitimately span MULTIPLE term_id values for the same student+session
  // (the real data-integrity gap this whole fix traces back to — see
  // loadCurrentRegistration()'s header). Resubmitting every remaining row
  // under a single term_id (e.g. whatever the admin's picker term happens
  // to be) would silently REWRITE the term_id of rows that belong to a
  // different term — real data corruption, not a drop. So this groups the
  // remaining rows by their own term_id and issues one registerStudent()
  // call per group, each under its own real term_id, leaving every other
  // term's rows genuinely untouched.
  async function confirmDrop() {
    if (!dropTarget || !placement) return
    setDropping(true)
    setDropError(null)
    const remaining = (currentRegistration ?? []).filter(r => r.id !== dropTarget.id)

    const groups = new Map<string | null, CurrentRegistrationRow[]>()
    for (const row of remaining) {
      const key = row.term_id
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(row)
    }
    // The dropped course's own term must still be resubmitted even if it
    // ends up empty after removal — an empty group for that one term_id
    // is what actually withdraws it; a group that simply never appears in
    // `groups` (because every row under that term_id was just removed)
    // needs an explicit empty-resubmit, not a skip.
    if (!groups.has(dropTarget.term_id)) groups.set(dropTarget.term_id, [])

    let sawError: string | null = null
    for (const [termId, rows] of groups) {
      const coursesToSave = rows.map(r => ({
        course_id: r.course_id,
        is_carryover_reregistration: null as string | null,
      }))
      // registerStudent() requires at least one course — dropping the
      // last remaining course under a given term is a real, valid admin
      // action, so route that case through a hard withdraw-all for just
      // that term's rows instead of a call the function itself would
      // reject.
      const res = coursesToSave.length > 0
        ? await registerStudent({
            school_id: schoolId,
            student_id: student.id,
            session_id: placement.session_id,
            term_id: termId,
            courses: coursesToSave,
          })
        : await withdrawAllActiveForTerm(termId)
      if (res.error) { sawError = res.error; break }
    }

    setDropping(false)
    if (sawError) { setDropError(sawError); return }
    setDropTarget(null)
    await refreshCurrentRegistration()
    await loadForTerm()
  }

  // Withdraws every currently-active row under one specific term_id only
  // (never all of currentRegistration — that would cross the same
  // per-term boundary confirmDrop's grouping exists to respect). Used
  // when a drop empties out one term's group entirely; registerStudent()
  // refuses an empty course list outright (it exists to save a
  // registration, not clear one), so the last-course-in-a-term case is
  // handled here directly against the same soft-withdraw convention
  // registerStudent() itself uses.
  async function withdrawAllActiveForTerm(termId: string | null): Promise<{ error: string | null }> {
    const ids = (currentRegistration ?? [])
      .filter(r => r.term_id === termId)
      .map(r => r.id)
    if (ids.length === 0) return { error: null }
    const { supabase } = await import('../lib/supabase')
    const { error } = await supabase
      .from('course_registrations')
      .update({ status: 'withdrawn', updated_at: new Date().toISOString() })
      .in('id', ids)
    return { error: error?.message ?? null }
  }

  if (loading) return <div className="reg-tab-content"><p className="reg-hint-text">Loading…</p></div>
  if (error) {
    return (
      <div className="reg-tab-content">
        {/* No back button for the readOnly (student self-service) caller —
            this screen has no "search" step to return to for a student
            (it's reached via the portal's own top tab bar, which is
            already the navigation), and onBack is wired as a genuine
            no-op from GuardianPortal.tsx for that caller. A visible
            button with no real destination reads as broken, so it's
            simply not rendered rather than shown disabled or dead. */}
        {!readOnly && <button className="reg-back-btn" onClick={onBack}>← Back to search</button>}
        <p className="reg-form-error">{error}</p>
      </div>
    )
  }
  if (!placement) return null

  const coreCourses = curriculum.filter(c => c.requirement_type === 'core')
  const electiveCourses = curriculum.filter(c => c.requirement_type === 'elective')

  // Full set this save would produce: every core course (auto-populated,
  // not optional), chosen electives, chosen carryover re-registrations.
  const finalCourseIds = new Set<string>([
    ...coreCourses.map(c => c.course_id),
    ...electiveCourses.filter(c => selectedElectiveIds.has(c.course_id)).map(c => c.course_id),
  ])
  const finalCarryover = carryover.filter(c => includedCarryoverIds.has(c.original_registration_id))

  const totalUnits =
    coreCourses.reduce((sum, c) => sum + c.credit_units, 0) +
    electiveCourses.filter(c => selectedElectiveIds.has(c.course_id)).reduce((sum, c) => sum + c.credit_units, 0) +
    finalCarryover.reduce((sum, c) => sum + c.credit_units, 0)

  const loadCheck = checkCreditLoad(totalUnits, placement.min_credit_load, placement.max_credit_load)

  function toggleElective(courseId: string) {
    setSelectedElectiveIds(prev => {
      const next = new Set(prev)
      if (next.has(courseId)) next.delete(courseId); else next.add(courseId)
      return next
    })
  }

  function toggleCarryover(originalRegistrationId: string) {
    setIncludedCarryoverIds(prev => {
      const next = new Set(prev)
      if (next.has(originalRegistrationId)) next.delete(originalRegistrationId); else next.add(originalRegistrationId)
      return next
    })
  }

  async function handleSave() {
    if (!placement) return
    if (loadCheck.overMax) { setSaveError(loadCheck.message); return }
    setSaving(true)
    setSaveError(null)
    setSaved(false)

    const coursesToSave = [
      ...Array.from(finalCourseIds).map(course_id => ({ course_id, is_carryover_reregistration: null as string | null })),
      ...finalCarryover.map(c => ({ course_id: c.course_id, is_carryover_reregistration: c.original_registration_id })),
    ]

    const res = await registerStudent({
      school_id: schoolId,
      student_id: student.id,
      session_id: placement.session_id,
      term_id: terms.length > 0 ? selectedTermId : null,
      courses: coursesToSave,
    })
    setSaving(false)
    if (res.error) { setSaveError(res.error); return }
    setSaved(true)
    await loadForTerm()
    await refreshCurrentRegistration()
    // Admin "Add course" flow returns to the summary after a successful
    // save, matching progressive-disclosure (§4.3) — the picker is the
    // deeper, occasional action, the summary is what the screen should
    // settle back on. First-time registration (no readOnly, no prior
    // summary to return to) has no summary to bounce to yet, so this is a
    // no-op there — refreshCurrentRegistration() above will populate one
    // on the next render, and the summary fork below picks it up
    // naturally without an explicit view change being required.
    setView('summary')
  }

  const readyToShowCurriculum = terms.length === 0 || !!selectedTermId

  const studentBanner = (
    <div className="reg-student-banner">
      <p className="reg-list-row-name">{placement.student_name}</p>
      <p className="reg-list-row-meta">
        {placement.student_matric_number ?? 'No matric number'} · {placement.programme_name} · Level {placement.level_label}
      </p>
    </div>
  )

  // ─── "Currently registered" summary (Problem 9.6) ───────────────────────
  // Shown whenever an active registration exists for the student+session,
  // regardless of term selection — and regardless of whether the school
  // uses terms at all.
  //
  // BUG FOUND on-device, 2026-08-06 (owner report: a student with a real,
  // saved registration was landing on the picker instead of the summary
  // whenever the school uses terms): this condition used to also require
  // readyToShowCurriculum (terms.length === 0 || !!selectedTermId).
  // readyToShowCurriculum exists to gate the CURRICULUM fetch (loadForTerm
  // is genuinely term-scoped, correctly refuses to run until a term is
  // picked) — but reusing it here coupled the summary's visibility to
  // term selection too, even though loadCurrentRegistration() was
  // deliberately rewritten to be session-only, not term-scoped (see that
  // function's own header in courseRegistrationService.ts). Since
  // selectedTermId starts null and no term is pre-selected on mount, any
  // school that uses terms had readyToShowCurriculum=false on first
  // render — which forced EVERY returning student straight into the
  // picker, no matter how many active courses they already had, because
  // the summary branch could never even be reached to check
  // hasActiveRegistration in the first place. Confirmed directly via SQL
  // against a real student with 3 active current-session rows whose
  // placement/summary state should have shown him the summary and did not.
  //
  // Fix: drop readyToShowCurriculum from this gate entirely. The summary
  // only depends on currentRegistration, which is already independently
  // loaded (see refreshCurrentRegistration above, gated only on
  // `placement`, not on any term selection).
  const hasActiveRegistration = (currentRegistration?.length ?? 0) > 0

  // ─── Summary semester filter — selectable options + filtered rows ───────
  // "Ahead of current" terms are excluded from the filter entirely
  // (owner-specified, 2026-08-06): a term is filterable if it has already
  // started (start_date <= today) — past AND current terms both qualify,
  // only genuinely future terms are excluded. This is a display-only
  // exclusion (which options the dropdown OFFERS); it does not hide any
  // row a student actually has — see nullTermRowsExist below for why
  // null-term rows are never excluded by this filter regardless of which
  // option is picked.
  //
  // Deliberately built from `terms` (the school's full term list for the
  // resolved session) rather than only terms actually present in
  // currentRegistration — a student might have zero rows in the current
  // term yet (e.g. hasn't registered this semester yet) and should still
  // be able to select it to see that it's empty, not have it silently
  // absent from the list.
  const today = new Date().toISOString().slice(0, 10) // 'YYYY-MM-DD', matches DATE column comparison
  const selectableSummaryTerms = terms.filter(t => t.start_date <= today)

  // Rows with term_id === null are a known, pre-existing data gap (see
  // loadCurrentRegistration()'s header in courseRegistrationService.ts) —
  // they aren't "ahead of current," they're simply unscoped, so they stay
  // visible under every filter selection including a specific term,
  // rather than being hideable by picking a term they don't belong to.
  const filteredRegistration = (currentRegistration ?? []).filter(r =>
    summaryTermFilter === null || r.term_id === summaryTermFilter || r.term_id === null,
  )

  if (view === 'summary' && (registrationLoading || hasActiveRegistration)) {
    const totalUnits = filteredRegistration.reduce((sum, r) => sum + r.credit_units, 0)
    return (
      <div className="reg-tab-content">
        {/* Same reasoning as the error-state return above: no back button
            for the readOnly student caller — nothing to go "back" to. */}
        {!readOnly && (
          <button className="reg-back-btn" onClick={onBack}>← Back to search</button>
        )}
        {studentBanner}

        {renderAboveSummary?.({ onCourseAdded: async () => { await refreshCurrentRegistration(); await loadForTerm() } })}

        <p className="reg-section-label">Currently registered</p>

        {/* Owner-requested (2026-08-06): a semester filter for the summary
            itself, separate from selectedTermId (the picker's own term
            choice — see summaryTermFilter's declaration above for why
            these are deliberately independent state). Only rendered when
            the school actually uses terms, matching every other term-
            related control in this component (the picker's own Semester
            field, CurriculumTab's own convention) — a termless school
            never sees term UI anywhere. Future terms (start_date after
            today) are intentionally absent from the option list — a
            student can look back at a past semester's registration but
            can't select a semester that hasn't started yet, since it can
            only ever be empty. */}
        {terms.length > 0 && (
          <FieldRow label="Semester">
            <select
              className="reg-select"
              value={summaryTermFilter ?? ''}
              onChange={e => setSummaryTermFilter(e.target.value || null)}
            >
              <option value="">All semesters</option>
              {selectableSummaryTerms.map(t => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </FieldRow>
        )}

        {registrationLoading && <p className="reg-hint-text">Loading…</p>}

        {!registrationLoading && filteredRegistration.length === 0 && (
          <p className="reg-empty-hint">
            No courses registered for {selectableSummaryTerms.find(t => t.id === summaryTermFilter)?.name ?? 'this semester'} yet.
          </p>
        )}

        {!registrationLoading && filteredRegistration.map(r => (
          <div key={r.id}>
            <div className="reg-list-row">
              <div className="reg-list-row-info">
                <p className="reg-list-row-name">{r.course_code} — {r.course_title}</p>
                <p className="reg-list-row-meta">
                  {r.credit_units} unit{r.credit_units === 1 ? '' : 's'}
                  {r.term_name ? ` · ${r.term_name}` : ''}
                  {r.is_carryover ? ' · Carryover' : ''}
                </p>
              </div>
              {!readOnly && dropTarget?.id !== r.id && (
                <button
                  className="reg-drop-btn"
                  onClick={() => { setDropTarget(r); setDropError(null) }}
                >
                  Drop
                </button>
              )}
            </div>
            {/* Drop confirmation — same inline-banner shape as StudentsModule.tsx's
                stu-confirm-banner (this codebase's established destructive-confirm
                pattern), rendered directly below the row it targets rather than as
                an overlay/modal, which nothing else in this project uses. */}
            {dropTarget?.id === r.id && (
              <div className="reg-drop-confirm-banner">
                <p className="reg-drop-confirm-text">
                  Drop {dropTarget.course_code} — {dropTarget.course_title} ({dropTarget.credit_units} unit{dropTarget.credit_units === 1 ? '' : 's'})? This does not affect any other registered course.
                </p>
                {dropError && <p className="reg-form-error">{dropError}</p>}
                <div className="reg-drop-confirm-actions">
                  <button className="reg-drop-confirm-cancel" onClick={() => { setDropTarget(null); setDropError(null) }} disabled={dropping}>
                    Keep
                  </button>
                  <button className="reg-drop-confirm-danger" onClick={confirmDrop} disabled={dropping}>
                    {dropping ? 'Dropping…' : 'Drop course'}
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}

        {!registrationLoading && (
          <div className="reg-summary-bar">
            <p className="reg-summary-ok">
              {totalUnits} total credit units
              {summaryTermFilter ? ` · ${selectableSummaryTerms.find(t => t.id === summaryTermFilter)?.name ?? ''}` : ''}
            </p>
          </div>
        )}

        {!readOnly && !registrationLoading && (
          <button className="reg-save-btn" onClick={() => setView('picker')}>
            + Add course
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="reg-tab-content">
      {!readOnly && (
        <button className="reg-back-btn" onClick={onBack}>← Back to search</button>
      )}

      {studentBanner}

      {!readOnly && hasActiveRegistration && (
        <button className="reg-back-btn" onClick={() => setView('summary')}>← Back to current registration</button>
      )}

      {/* SESSION 67 follow-up: "Semester" not "Term" — this module only
          ever renders for a higher-ed school (gated by
          isHigherInstitutionSchoolType at the very top of this
          component), so no branching is needed here, just the same
          straight wording fix already applied to SettingsModule.tsx's
          CurriculumTab/OfferingsTab. */}
      {terms.length > 0 && (
        <FieldRow label="Semester">
          <select
            className="reg-select"
            value={selectedTermId ?? ''}
            onChange={e => setSelectedTermId(e.target.value || null)}
          >
            <option value="">Choose a semester</option>
            {terms.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </FieldRow>
      )}

      {!readyToShowCurriculum && (
        <p className="reg-empty-hint">Choose a semester to build this student's registration.</p>
      )}

      {readyToShowCurriculum && curriculumLoading && <p className="reg-hint-text">Loading curriculum…</p>}

      {/* PRD Tier 9 follow-up (owner-reported, 2026-08-05): the original
          message here ("...define it in the Curriculum tab first") is
          admin-facing instruction language — it tells the reader to go
          configure something, which is meaningless and confusing to a
          student self-service caller who has no access to a Curriculum
          tab at all and isn't the person who could act on it anyway.
          readOnly (this component's own student-vs-admin signal, already
          used throughout this file for write-control gating) is reused
          here for copy, not just permissions — a student sees a plain
          status statement, an admin still sees the actionable instruction
          aimed at them. */}
      {readyToShowCurriculum && !curriculumLoading && curriculum.length === 0 && carryover.length === 0 && (
        <p className="reg-empty-hint">
          {readOnly
            ? <>Course registration for {placement.programme_name} / Level {placement.level_label}{terms.length > 0 ? ' this semester' : ''} hasn't been set up yet. Check back later, or contact your school.</>
            : <>No curriculum defined yet for {placement.programme_name} / Level {placement.level_label}{terms.length > 0 ? ' for this semester' : ''} — define it in the Curriculum tab first.</>}
        </p>
      )}

      {readyToShowCurriculum && !curriculumLoading && coreCourses.length > 0 && (
        <>
          <p className="reg-section-label">Core courses (auto-populated)</p>
          {coreCourses.map(c => (
            <div key={c.course_id} className="reg-list-row">
              <div className="reg-list-row-info">
                <p className="reg-list-row-name">{c.course_code} — {c.course_title}</p>
                <p className="reg-list-row-meta">{c.credit_units} unit{c.credit_units === 1 ? '' : 's'} · Core</p>
              </div>
            </div>
          ))}
        </>
      )}

      {readyToShowCurriculum && !curriculumLoading && electiveCourses.length > 0 && (
        <>
          <p className="reg-section-label">Electives — choose any</p>
          {electiveCourses.map(c => (
            <label key={c.course_id} className="reg-list-row reg-list-row--checkable">
              <input
                type="checkbox"
                checked={selectedElectiveIds.has(c.course_id)}
                onChange={() => toggleElective(c.course_id)}
              />
              <div className="reg-list-row-info">
                <p className="reg-list-row-name">{c.course_code} — {c.course_title}</p>
                <p className="reg-list-row-meta">
                  {c.credit_units} unit{c.credit_units === 1 ? '' : 's'}
                  {c.prerequisite_course_code ? ` · Prerequisite: ${c.prerequisite_course_code}` : ''}
                </p>
              </div>
            </label>
          ))}
        </>
      )}

      {readyToShowCurriculum && !curriculumLoading && carryover.length > 0 && (
        <>
          <p className="reg-section-label">Outstanding carryover</p>
          {carryover.map(c => (
            <label key={c.original_registration_id} className="reg-list-row reg-list-row--checkable">
              <input
                type="checkbox"
                checked={includedCarryoverIds.has(c.original_registration_id)}
                onChange={() => toggleCarryover(c.original_registration_id)}
              />
              <div className="reg-list-row-info">
                <p className="reg-list-row-name">{c.course_code} — {c.course_title}</p>
                <p className="reg-list-row-meta">
                  {c.credit_units} unit{c.credit_units === 1 ? '' : 's'} · From {c.from_session_name}
                </p>
              </div>
            </label>
          ))}
        </>
      )}

      {readyToShowCurriculum && !curriculumLoading && (coreCourses.length > 0 || electiveCourses.length > 0 || carryover.length > 0) && (
        <div className="reg-summary-bar">
          <p className={loadCheck.overMax ? 'reg-summary-error' : loadCheck.underMin ? 'reg-summary-warning' : 'reg-summary-ok'}>
            {totalUnits} total credit units
            {loadCheck.message ? ` — ${loadCheck.message}` : ''}
          </p>
        </div>
      )}

      {saveError && <p className="reg-form-error">{saveError}</p>}
      {saved && !saveError && <p className="reg-save-confirmation">Registration saved.</p>}

      {readyToShowCurriculum && !curriculumLoading && (coreCourses.length > 0 || electiveCourses.length > 0 || carryover.length > 0) && (
        <button
          className="reg-save-btn"
          onClick={handleSave}
          disabled={saving || loadCheck.overMax}
          title={loadCheck.overMax ? loadCheck.message ?? undefined : undefined}
        >
          {saving ? 'Saving…' : 'Save registration'}
        </button>
      )}
    </div>
  )
}
