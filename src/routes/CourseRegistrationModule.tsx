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
  loadExistingRegistrations, checkCreditLoad, registerStudent,
  type StudentCurrentPlacement, type RegistrableCourse, type CarryoverCourse,
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
export function RegistrationStep({ schoolId, student, onBack }: {
  schoolId: string
  student: StudentSearchResult
  onBack: () => void
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

  if (loading) return <div className="reg-tab-content"><p className="reg-hint-text">Loading…</p></div>
  if (error) {
    return (
      <div className="reg-tab-content">
        <button className="reg-back-btn" onClick={onBack}>← Back to search</button>
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
  }

  const readyToShowCurriculum = terms.length === 0 || !!selectedTermId

  return (
    <div className="reg-tab-content">
      <button className="reg-back-btn" onClick={onBack}>← Back to search</button>

      <div className="reg-student-banner">
        <p className="reg-list-row-name">{placement.student_name}</p>
        <p className="reg-list-row-meta">
          {placement.student_matric_number ?? 'No matric number'} · {placement.programme_name} · Level {placement.level_label}
        </p>
      </div>

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

      {readyToShowCurriculum && !curriculumLoading && curriculum.length === 0 && carryover.length === 0 && (
        <p className="reg-empty-hint">
          No curriculum defined yet for {placement.programme_name} / Level {placement.level_label}
          {terms.length > 0 ? ' for this semester' : ''} — define it in the Curriculum tab first.
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
