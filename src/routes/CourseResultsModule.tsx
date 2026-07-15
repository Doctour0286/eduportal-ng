/**
 * CourseResultsModule.tsx
 * Session 60 — lecturer-facing scoring UI + GPA/CGPA display for
 * higher-institution schools. Mounted by ResultsModule.tsx when
 * isHigherInstitutionSchoolType(schoolType) is true — see that file's
 * top-level dispatcher. Entirely separate component, not a branch inside
 * the secondary-school grid, since course_results/course_registrations is
 * a structurally different anchor object (one score per registration, no
 * CA-component breakdown) — same "new file, not extension" reasoning
 * gpaService.ts/courseResultsService.ts's own headers give.
 *
 * Staff identity: resolves staffId via authStore.actorRecordId — Problem
 * 8.1's fix, reused as-is per SESSION 60's card, not re-derived.
 *
 * Flow: pick session/term -> pick a course offering (mine, unless admin,
 * matching loadMyTeachingAssignments/loadAllTeachingAssignments's own
 * mine-vs-all split in the secondary path) -> load scorable registrations
 * for that offering -> enter/save score per student -> on finalize, look
 * up the grade band, persist to course_results, then recompute and cache
 * that student's full GPA/CGPA into student_gpa_snapshots.
 *
 * SESSION 60a addition (CA/exam component breakdown): if the school has
 * defined course_result_components (Grading settings, admin-only), each
 * scorable registration renders one input per component plus a live
 * weighted-total preview, and finalizing calls
 * finalizeWeightedCourseResult() (sums components server-side, cache-on-
 * finalize per that function's own header) instead of the plain
 * saveCourseResult() path. If NO components are defined yet, the original
 * SESSION 60 single-score-input path renders unchanged — this is a real,
 * legitimate state (a school that hasn't adopted CA/exam breakdown yet),
 * not a degraded fallback, matching SESSION 60b's own card language for
 * the equivalent transcript case. gpaService.ts and the GPA/CGPA recompute
 * path are completely unaffected either way — both only ever consume the
 * already-finalized score/grade_point columns on course_results.
 */

import { useState, useEffect, useCallback } from 'react'
import { useAuthStore } from '../stores/authStore'
import { Icon } from '../components/icons'
import {
  loadCurrentSession, loadTerms, loadCourseOfferings,
  type Session, type Term, type CourseOffering,
} from '../services/settingsService'
import {
  loadScorableRegistrations, loadCgpaPolicy, saveCourseResult,
  loadFinalizedAttemptsForStudent, saveGpaSnapshots,
  resolveCourseResultComponents, loadComponentScoresForRegistrations,
  saveComponentScore, finalizeWeightedCourseResult,
  type ScorableRegistration, type CgpaPolicy,
  type ResolvedCourseResultComponent,
} from '../services/courseResultsService'
import {
  findGradeBand, resolveAttemptsForCalculation,
  computeSemesterGpas, computeCgpaWeightedAllAttempts, computeCgpaAverageOfSemesterGpas,
  type GradeBand, type ScoredAttempt,
} from '../services/gpaService'
import { supabase } from '../lib/supabase'

// ─── Props ──────────────────────────────────────────────────────────────────

interface CourseResultsModuleProps {
  schoolId: string
  isAdmin: boolean
}

type LoadState = 'booting' | 'loading' | 'ready' | 'empty' | 'error'

// ─── Component ──────────────────────────────────────────────────────────────

export default function CourseResultsModule({ schoolId, isAdmin }: CourseResultsModuleProps) {
  const staffId = useAuthStore((s) => s.actorRecordId) ?? ''

  const [session, setSession] = useState<Session | null>(null)
  const [terms, setTerms] = useState<Term[]>([])
  const [selectedTerm, setSelectedTerm] = useState<Term | null>(null)
  const [usesTerms, setUsesTerms] = useState(false)

  const [offerings, setOfferings] = useState<CourseOffering[]>([])
  const [selectedOffering, setSelectedOffering] = useState<CourseOffering | null>(null)

  const [gradeBands, setGradeBands] = useState<GradeBand[]>([])
  const [cgpaPolicy, setCgpaPolicy] = useState<CgpaPolicy | null>(null)

  // SESSION 60a/60c: this course offering's EFFECTIVE component set —
  // school-wide rows merged with this course's own overrides/additions via
  // resolveCourseResultComponents(). Resolved per-offering inside
  // loadGrid(), NOT at boot — SESSION 60c added per-course overrides
  // (migration_session_60c.sql, folded into course_result_components via
  // a nullable course_id), so "this school's components" is no longer a
  // single boot-time value; it depends on which course is selected.
  // Loading it at boot (the SESSION 60a original) meant a course with its
  // own override/addition (e.g. a lab course's "Practical" component)
  // never rendered an input for it, and finalizeWeightedCourseResult()
  // would then correctly-but-confusingly refuse to finalize for a
  // component the lecturer was never shown — this is the fix for that bug.
  // Empty array (not null) still means "no components configured for this
  // course" — a real, legitimate state (see module header) that keeps the
  // original single-score-input path rendering, not an error/loading state.
  const [components, setComponents] = useState<ResolvedCourseResultComponent[]>([])

  const [registrations, setRegistrations] = useState<ScorableRegistration[]>([])
  const [scoreDrafts, setScoreDrafts] = useState<Map<string, string>>(new Map())
  // SESSION 60a: per-(registrationId|componentId) draft values, same key
  // shape as courseResultsService.ts's loadComponentScoresForRegistrations()
  // map, so drafts can be seeded directly from a loaded ComponentScore map
  // without re-keying.
  const [componentDrafts, setComponentDrafts] = useState<Map<string, string>>(new Map())
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set())
  const [rowErrors, setRowErrors] = useState<Map<string, string>>(new Map())

  const [bootState, setBootState] = useState<LoadState>('booting')
  const [bootError, setBootError] = useState('')
  const [gridState, setGridState] = useState<LoadState>('booting')
  const [gridError, setGridError] = useState('')

  // ─── Boot: current session, terms, grade scale, cgpa policy ───────────────

  useEffect(() => {
    let cancelled = false
    async function boot() {
      setBootState('loading')
      const [sessRes, gradeRes, policyRes] = await Promise.all([
        loadCurrentSession(schoolId),
        loadHigherEdGradeScale(schoolId),
        loadCgpaPolicy(schoolId),
      ])
      if (cancelled) return

      if (sessRes.error || !sessRes.data) {
        setBootError(sessRes.error ?? 'No current session configured for this school.')
        setBootState('error')
        return
      }
      if (gradeRes.error) { setBootError(gradeRes.error); setBootState('error'); return }
      if (policyRes.error) { setBootError(policyRes.error); setBootState('error'); return }

      setSession(sessRes.data)
      setGradeBands(gradeRes.data)
      setCgpaPolicy(policyRes.data)

      const termsRes = await loadTerms(schoolId, sessRes.data.id)
      if (cancelled) return
      const hasTerms = !termsRes.error && termsRes.data.length > 0
      setUsesTerms(hasTerms)
      if (hasTerms) {
        setTerms(termsRes.data)
        setSelectedTerm(termsRes.data[0] ?? null)
      }

      const offRes = await loadCourseOfferings(sessRes.data.id, hasTerms ? (termsRes.data[0]?.id ?? null) : null)
      if (cancelled) return
      if (offRes.error) { setBootError(offRes.error); setBootState('error'); return }

      const mine = isAdmin ? offRes.data : offRes.data.filter((o) => o.staff_id === staffId)
      setOfferings(mine)
      setBootState(mine.length === 0 ? 'empty' : 'ready')
    }
    if (isAdmin || staffId) boot()
    return () => { cancelled = true }
  }, [schoolId, isAdmin, staffId])

  // ─── Reload offerings when term changes ────────────────────────────────────

  useEffect(() => {
    if (!session || !usesTerms || !selectedTerm) return
    let cancelled = false
    ;(async () => {
      const offRes = await loadCourseOfferings(session.id, selectedTerm.id)
      if (cancelled) return
      if (!offRes.error) {
        const mine = isAdmin ? offRes.data : offRes.data.filter((o) => o.staff_id === staffId)
        setOfferings(mine)
        setSelectedOffering(null)
      }
    })()
    return () => { cancelled = true }
  }, [selectedTerm, session, usesTerms, isAdmin, staffId])

  // ─── Load scorable registrations when offering changes ────────────────────

  const loadGrid = useCallback(async () => {
    if (!selectedOffering || !session) return
    setGridState('loading')

    const [regRes, componentsRes] = await Promise.all([
      loadScorableRegistrations({
        courseId: selectedOffering.course_id,
        sessionId: session.id,
        termId: usesTerms ? (selectedTerm?.id ?? null) : null,
      }),
      // SESSION 60c: resolve THIS course's effective set (school-wide rows
      // merged with this course's own overrides/additions), not just the
      // school-wide list — must be re-resolved on every offering change
      // since different courses can have different overrides.
      resolveCourseResultComponents(schoolId, selectedOffering.course_id),
    ])

    if (regRes.error) { setGridError(regRes.error); setGridState('error'); return }

    // A components fetch error is surfaced but not grid-fatal — fall back
    // to an empty set (original single-score-input path) rather than
    // blocking the whole grid; the registrations themselves loaded fine.
    const resolvedComponents = componentsRes.error ? [] : componentsRes.data
    setComponents(resolvedComponents)

    setRegistrations(regRes.data)
    setScoreDrafts(new Map(regRes.data.map((r) => [r.registration_id, r.score === null ? '' : String(r.score)])))

    // SESSION 60a: only fetch component scores when components exist for
    // this course — avoids a meaningless query for schools/courses that
    // haven't adopted CA/exam breakdown yet (mirrors ResultsModule.tsx's
    // own dispatcher reasoning for not firing secondary-only queries
    // against a higher-ed school).
    if (resolvedComponents.length > 0) {
      const compScoresRes = await loadComponentScoresForRegistrations(regRes.data.map((r) => r.registration_id))
      if (!compScoresRes.error) {
        const drafts = new Map<string, string>()
        for (const r of regRes.data) {
          for (const c of resolvedComponents) {
            const key = `${r.registration_id}|${c.id}`
            const existing = compScoresRes.data.get(key)
            drafts.set(key, existing ? String(existing.value) : '')
          }
        }
        setComponentDrafts(drafts)
      }
      // A component-score fetch error is deliberately non-fatal to the
      // grid — the registrations themselves loaded fine; component inputs
      // simply start blank, same graceful-degradation the rest of this
      // function already applies to informational reads elsewhere in this
      // file (e.g. eligibility badges in the sibling attendance module).
    }

    setGridState(regRes.data.length === 0 ? 'empty' : 'ready')
  }, [selectedOffering, session, usesTerms, selectedTerm, schoolId])

  useEffect(() => { loadGrid() }, [loadGrid])

  // ─── Finalize a plain (no-components) score — SESSION 60's original path ──

  async function finalizeScore(reg: ScorableRegistration) {
    const raw = scoreDrafts.get(reg.registration_id) ?? ''
    const score = Number(raw)
    setRowErrors((prev) => { const m = new Map(prev); m.delete(reg.registration_id); return m })

    if (raw.trim() === '' || Number.isNaN(score) || score < 0 || score > 100) {
      setRowErrors((prev) => new Map(prev).set(reg.registration_id, 'Enter a score between 0 and 100'))
      return
    }
    const band = findGradeBand(score, gradeBands)
    if (!band) {
      setRowErrors((prev) => new Map(prev).set(reg.registration_id, 'Score matches no configured grade band — check Grading settings'))
      return
    }
    if (!cgpaPolicy) {
      setRowErrors((prev) => new Map(prev).set(reg.registration_id, 'No CGPA policy configured for this school yet — set one in Grading settings before finalizing scores'))
      return
    }

    setSavingIds((prev) => new Set(prev).add(reg.registration_id))
    try {
      const saveRes = await saveCourseResult({
        registrationId: reg.registration_id,
        score,
        letterGrade: band.grade_label,
        gradePoint: band.grade_point,
      })
      if (saveRes.error) {
        setRowErrors((prev) => new Map(prev).set(reg.registration_id, saveRes.error as string))
        return
      }

      // Recompute and cache this student's full GPA/CGPA — §4.1 caching
      // discipline: never derived live on every read, recomputed here at
      // the one point it actually changes (a new finalized score).
      await recomputeAndCacheGpa(reg.student_id, cgpaPolicy, session?.id ?? '')

      setRegistrations((prev) => prev.map((r) =>
        r.registration_id === reg.registration_id
          ? { ...r, score, letter_grade: band.grade_label, grade_point: band.grade_point, finalized_at: new Date().toISOString() }
          : r
      ))
    } finally {
      setSavingIds((prev) => { const s = new Set(prev); s.delete(reg.registration_id); return s })
    }
  }

  // ─── SESSION 60a: save one component draft (does NOT finalize) ────────────
  // Entering a CA mark shouldn't prematurely finalize the course_results
  // row — a lecturer may enter CA now and Exam weeks later. See
  // courseResultsService.ts's saveComponentScore() header.

  async function saveComponentDraft(reg: ScorableRegistration, component: ResolvedCourseResultComponent) {
    const key = `${reg.registration_id}|${component.id}`
    const raw = componentDrafts.get(key) ?? ''
    const value = Number(raw)
    setRowErrors((prev) => { const m = new Map(prev); m.delete(reg.registration_id); return m })

    if (raw.trim() === '' || Number.isNaN(value) || value < 0) {
      setRowErrors((prev) => new Map(prev).set(reg.registration_id, `Enter a valid ${component.name} score`))
      return
    }

    setSavingIds((prev) => new Set(prev).add(reg.registration_id))
    try {
      const res = await saveComponentScore({
        registrationId: reg.registration_id,
        componentId: component.id,
        value,
        enteredBy: staffId,
      })
      if (res.error) {
        setRowErrors((prev) => new Map(prev).set(reg.registration_id, res.error as string))
      }
    } finally {
      setSavingIds((prev) => { const s = new Set(prev); s.delete(reg.registration_id); return s })
    }
  }

  // ─── SESSION 60a: finalize from weighted components ────────────────────────

  function weightedPreviewFor(reg: ScorableRegistration): number | null {
    let total = 0
    let hasAny = false
    for (const c of components) {
      const raw = componentDrafts.get(`${reg.registration_id}|${c.id}`) ?? ''
      const value = Number(raw)
      if (raw.trim() !== '' && !Number.isNaN(value)) {
        total += value * (c.weight_pct / 100)
        hasAny = true
      }
    }
    return hasAny ? total : null
  }

  async function finalizeWeightedScore(reg: ScorableRegistration) {
    setRowErrors((prev) => { const m = new Map(prev); m.delete(reg.registration_id); return m })

    if (!cgpaPolicy) {
      setRowErrors((prev) => new Map(prev).set(reg.registration_id, 'No CGPA policy configured for this school yet — set one in Grading settings before finalizing scores'))
      return
    }

    const preview = weightedPreviewFor(reg)
    if (preview === null) {
      setRowErrors((prev) => new Map(prev).set(reg.registration_id, 'Enter all component scores before finalizing'))
      return
    }
    const band = findGradeBand(preview, gradeBands)
    if (!band) {
      setRowErrors((prev) => new Map(prev).set(reg.registration_id, 'Weighted total matches no configured grade band — check Grading settings'))
      return
    }

    setSavingIds((prev) => new Set(prev).add(reg.registration_id))
    try {
      // finalizeWeightedCourseResult() re-reads and re-sums the persisted
      // component scores server-side (not the client's live drafts) — the
      // preview above is used only to pick a grade band optimistically and
      // fail fast; the authoritative sum is whatever is actually saved via
      // saveComponentDraft(). If a draft was typed but never saved (blurred
      // without saving, network drop, etc.), the server-side sum will
      // legitimately differ, and finalize will report a missing component
      // rather than silently trusting the client's unsent draft.
      const finalizeRes = await finalizeWeightedCourseResult({
        registrationId: reg.registration_id,
        letterGrade: band.grade_label,
        gradePoint: band.grade_point,
      })
      if (finalizeRes.error || !finalizeRes.data) {
        setRowErrors((prev) => new Map(prev).set(reg.registration_id, finalizeRes.error ?? 'Failed to finalize.'))
        return
      }

      // Re-resolve the grade band against the server's authoritative sum —
      // it may differ slightly from the client preview if a draft wasn't
      // saved yet (see comment above), so don't reuse `band` blindly.
      const finalBand = findGradeBand(finalizeRes.data.score, gradeBands) ?? band

      await recomputeAndCacheGpa(reg.student_id, cgpaPolicy, session?.id ?? '')

      setRegistrations((prev) => prev.map((r) =>
        r.registration_id === reg.registration_id
          ? {
              ...r,
              score: finalizeRes.data!.score,
              letter_grade: finalBand.grade_label,
              grade_point: finalBand.grade_point,
              finalized_at: new Date().toISOString(),
            }
          : r
      ))
    } finally {
      setSavingIds((prev) => { const s = new Set(prev); s.delete(reg.registration_id); return s })
    }
  }

  // ─── Render ─────────────────────────────────────────────────────────────────

  if (bootState === 'booting' || bootState === 'loading') {
    return <div className="crs-root"><p className="crs-loading">Loading…</p></div>
  }
  if (bootState === 'error') {
    return (
      <div className="crs-root">
        <p className="crs-error"><Icon name="alert-triangle" style={{ color: 'var(--color-warning, #d97706)' }} /> {bootError}</p>
      </div>
    )
  }
  if (bootState === 'empty') {
    return (
      <div className="crs-root">
        <p className="crs-empty"><Icon name="book" /> No course offerings assigned to you for this session{usesTerms ? '/term' : ''} yet.</p>
      </div>
    )
  }

  return (
    <div className="crs-root">
      <div className="crs-header">
        <h2 className="crs-title">Course Results</h2>
        {session && <span className="crs-session-label">{session.name}</span>}
      </div>

      {usesTerms && terms.length > 0 && (
        <div className="crs-term-tabs">
          {terms.map((t) => (
            <button
              key={t.id}
              className={`crs-term-tab${selectedTerm?.id === t.id ? ' crs-term-tab--active' : ''}`}
              onClick={() => setSelectedTerm(t)}
            >
              {t.name}
            </button>
          ))}
        </div>
      )}

      <div className="crs-offering-select">
        <label className="crs-field-label">Course</label>
        <select
          className="crs-select"
          value={selectedOffering?.id ?? ''}
          onChange={(e) => setSelectedOffering(offerings.find((o) => o.id === e.target.value) ?? null)}
        >
          <option value="">Select a course…</option>
          {offerings.map((o) => (
            <option key={o.id} value={o.id}>{o.course_code} — {o.course_title}</option>
          ))}
        </select>
      </div>

      {!cgpaPolicy && (
        <p className="crs-warning">
          <Icon name="alert-triangle" size={14} style={{ color: 'var(--color-warning, #d97706)' }} />
          {' '}No CGPA policy configured for this school yet. Scores can't be finalized until one is set in Grading settings.
        </p>
      )}

      {selectedOffering && (
        <div className="crs-grid-wrap">
          {gridState === 'loading' && <p className="crs-loading">Loading students…</p>}
          {gridState === 'error' && <p className="crs-error"><Icon name="alert-triangle" style={{ color: 'var(--color-warning, #d97706)' }} /> {gridError}</p>}
          {gridState === 'empty' && <p className="crs-empty"><Icon name="users" /> No registered students for this course yet.</p>}
          {gridState === 'ready' && components.length === 0 && (
            // SESSION 60 original path — no components configured for this
            // school yet, a real/legitimate state, not a fallback. See
            // module header.
            <table className="crs-table">
              <thead>
                <tr>
                  <th className="crs-th">Student</th>
                  <th className="crs-th">Matric No.</th>
                  <th className="crs-th">Status</th>
                  <th className="crs-th">Score</th>
                  <th className="crs-th">Grade</th>
                  <th className="crs-th">GP</th>
                  <th className="crs-th"></th>
                </tr>
              </thead>
              <tbody>
                {registrations.map((r) => {
                  const isSaving = savingIds.has(r.registration_id)
                  const rowErr = rowErrors.get(r.registration_id)
                  const isFinalized = !!r.finalized_at
                  return (
                    <tr key={r.registration_id} className="crs-row">
                      <td className="crs-td">{r.student_name}</td>
                      <td className="crs-td">{r.student_matric_number ?? '—'}</td>
                      <td className="crs-td">
                        {r.is_carryover
                          ? <span className="crs-badge crs-badge--carryover">Carryover</span>
                          : <span className="crs-badge">{r.status}</span>}
                      </td>
                      <td className="crs-td">
                        <input
                          className="crs-score-input"
                          type="number"
                          min={0}
                          max={100}
                          value={scoreDrafts.get(r.registration_id) ?? ''}
                          disabled={isSaving}
                          onChange={(e) => setScoreDrafts((prev) => new Map(prev).set(r.registration_id, e.target.value))}
                        />
                        {rowErr && <p className="crs-row-error">{rowErr}</p>}
                      </td>
                      <td className="crs-td">{r.letter_grade ?? '—'}</td>
                      <td className="crs-td">{r.grade_point ?? '—'}</td>
                      <td className="crs-td">
                        <button
                          className="crs-finalize-btn"
                          disabled={isSaving}
                          onClick={() => finalizeScore(r)}
                        >
                          {isSaving ? <Icon name="refresh-cw" size={14} /> : isFinalized ? 'Update' : 'Finalize'}
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}

          {gridState === 'ready' && components.length > 0 && (
            // SESSION 60a/60c path — one input column per this course's
            // effective (merged) component, plus a live weighted-total
            // preview column, ordered by sort_order (components state is
            // already sorted by mergeCourseResultComponents(), called
            // inside resolveCourseResultComponents() in loadGrid()).
            <table className="crs-table crs-table--components">
              <thead>
                <tr>
                  <th className="crs-th">Student</th>
                  <th className="crs-th">Matric No.</th>
                  <th className="crs-th">Status</th>
                  {components.map((c) => (
                    <th key={c.id} className="crs-th">{c.name} <span className="crs-th-weight">({c.weight_pct}%)</span></th>
                  ))}
                  <th className="crs-th">Total</th>
                  <th className="crs-th">Grade</th>
                  <th className="crs-th">GP</th>
                  <th className="crs-th"></th>
                </tr>
              </thead>
              <tbody>
                {registrations.map((r) => {
                  const isSaving = savingIds.has(r.registration_id)
                  const rowErr = rowErrors.get(r.registration_id)
                  const isFinalized = !!r.finalized_at
                  const preview = weightedPreviewFor(r)
                  return (
                    <tr key={r.registration_id} className="crs-row">
                      <td className="crs-td">{r.student_name}</td>
                      <td className="crs-td">{r.student_matric_number ?? '—'}</td>
                      <td className="crs-td">
                        {r.is_carryover
                          ? <span className="crs-badge crs-badge--carryover">Carryover</span>
                          : <span className="crs-badge">{r.status}</span>}
                      </td>
                      {components.map((c) => {
                        const key = `${r.registration_id}|${c.id}`
                        return (
                          <td key={c.id} className="crs-td">
                            <input
                              className="crs-score-input crs-score-input--component"
                              type="number"
                              min={0}
                              disabled={isSaving}
                              value={componentDrafts.get(key) ?? ''}
                              onChange={(e) => setComponentDrafts((prev) => new Map(prev).set(key, e.target.value))}
                              onBlur={() => saveComponentDraft(r, c)}
                            />
                          </td>
                        )
                      })}
                      <td className="crs-td crs-td--total">
                        {preview === null ? '—' : preview.toFixed(2)}
                        {rowErr && <p className="crs-row-error">{rowErr}</p>}
                      </td>
                      <td className="crs-td">{r.letter_grade ?? '—'}</td>
                      <td className="crs-td">{r.grade_point ?? '—'}</td>
                      <td className="crs-td">
                        <button
                          className="crs-finalize-btn"
                          disabled={isSaving}
                          onClick={() => finalizeWeightedScore(r)}
                        >
                          {isSaving ? <Icon name="refresh-cw" size={14} /> : isFinalized ? 'Update' : 'Finalize'}
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * settingsService.ts's higher-ed grade scale rows (grade_scales table's
 * higher-ed columns per §7.27.1/7.27.4) mapped into gpaService.ts's
 * GradeBand shape. Kept local to this file rather than re-exported from
 * settingsService.ts, since gpaService.ts's GradeBand is intentionally a
 * minimal subset (min_score/max_score/grade_label/grade_point only) —
 * decoupled from whatever extra columns settingsService.ts's own
 * GradeScaleBand type carries for the Grading settings UI.
 */
async function loadHigherEdGradeScale(schoolId: string): Promise<{ data: GradeBand[]; error: string | null }> {
  const { data, error } = await supabase
    .from('grade_scales')
    .select('min_score, max_score, grade_label, grade_point')
    .eq('school_id', schoolId)
    .order('min_score', { ascending: false })
  if (error) return { data: [], error: error.message }
  return {
    data: (data ?? []).map((b: any) => ({
      min_score: Number(b.min_score),
      max_score: Number(b.max_score),
      grade_label: b.grade_label,
      grade_point: Number(b.grade_point),
    })),
    error: null,
  }
}

/**
 * Full recompute-and-cache cycle for one student, called right after
 * saveCourseResult finalizes a new score. Loads every finalized attempt
 * for the student, resolves retakes per the school's retake_treatment,
 * computes semester GPAs + CGPA under the school's rollup_method, and
 * persists via saveGpaSnapshots.
 *
 * Isolated as its own function (rather than inlined in finalizeScore)
 * since SESSION 61/62's evaluation flow will likely need to trigger the
 * same recompute from a different call site (session-end evaluation) —
 * worth keeping this reusable now rather than re-extracting later.
 */
async function recomputeAndCacheGpa(
  studentId: string,
  policy: CgpaPolicy,
  currentSessionId: string,
): Promise<void> {
  const attemptsRes = await loadFinalizedAttemptsForStudent(studentId)
  if (attemptsRes.error || attemptsRes.data.length === 0) return

  // Uses the grade_point already persisted on course_results at the time
  // each attempt was finalized, rather than re-deriving from score against
  // the *current* grade scale — correct even if the scale is edited later,
  // since a finalized result's grade shouldn't silently drift.
  const { data: resultRows, error: resErr } = await supabase
    .from('course_results')
    .select('course_registration_id, grade_point')
    .in('course_registration_id', attemptsRes.data.map((a) => a.registration_id))
  if (resErr) return

  const gradePointByRegId = new Map<string, number>(
    (resultRows ?? []).map((r: any) => [r.course_registration_id, Number(r.grade_point)]),
  )

  const scored: ScoredAttempt[] = attemptsRes.data.map((a) => ({
    registrationId: a.registration_id,
    originalRegistrationId: a.original_registration_id,
    isCarryover: a.is_carryover,
    sessionId: a.session_id,
    termId: a.term_id,
    creditUnits: a.credit_units,
    score: a.score,
    finalized: true,
    gradeLabel: '', // not needed downstream; grade_point is what the math uses
    gradePoint: gradePointByRegId.get(a.registration_id) ?? 0,
    qualityPoints: (gradePointByRegId.get(a.registration_id) ?? 0) * a.credit_units,
  }))

  // isPassing: gradePoint > 0 is the only school-agnostic definition
  // available without a separate "passing_grade_point" setting, which
  // §7.27.4 doesn't define. Matches gpaService.ts's own worked-example
  // convention (F = 0.0 = failing, everything else passing).
  const isPassing = (a: ScoredAttempt) => a.gradePoint > 0

  // Session ordering: real chronological order (start_date), not creation
  // order — needed for "most recent attempt" in resolveAttemptsForCalculation.
  const sessionIds = Array.from(new Set(scored.map((a) => a.sessionId)))
  const { data: sessionRows } = await supabase
    .from('sessions')
    .select('id, start_date')
    .in('id', sessionIds)
  const startDateBySession = new Map<string, number>(
    (sessionRows ?? []).map((s: any) => [s.id, new Date(s.start_date).getTime()]),
  )
  const sessionOrder = (sessionId: string) => startDateBySession.get(sessionId) ?? 0

  const resolved = resolveAttemptsForCalculation(scored, policy.retake_treatment, isPassing, sessionOrder)
  const semesterGpas = computeSemesterGpas(resolved)
  const cgpa =
    policy.rollup_method === 'weighted_all_attempts'
      ? computeCgpaWeightedAllAttempts(resolved)
      : computeCgpaAverageOfSemesterGpas(semesterGpas)

  await saveGpaSnapshots({
    studentId,
    semesterGpas: semesterGpas.map((s) => ({
      sessionId: s.sessionId,
      termId: s.termId,
      totalUnitsAttempted: s.totalUnitsAttempted,
      totalQualityPoints: s.totalQualityPoints,
      gpa: s.gpa,
    })),
    cgpa,
    currentSessionId,
  })
}
