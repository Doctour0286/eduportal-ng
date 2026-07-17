/**
 * AdmissionModule.tsx
 * Student admission — matric-number format setup + the one real, atomic
 * admission flow (PRD Tier 8 / Problem 8.7a, SESSION 65; relocated out of
 * SettingsModule.tsx/InstitutionTab in the same session's correction pass,
 * §12 decision 2026-07-17).
 *
 * Why this is its own top-level module, not a Settings tab: admission is a
 * high-frequency operational workflow, potentially exercised by several
 * staff during a real admission period, not a rarely-touched config screen.
 * Three concrete problems the old placement created (not just tidiness) are
 * recorded in MASTER_PLAN.md §12 — permission-key mismatch with
 * institution-structure edits, load-lifecycle collision with Settings'
 * load-once-and-idle pattern, and discoverability (an admin digging through
 * Settings during an admission rush is bad information architecture).
 *
 * NOT YET WIRED: this file has no route/nav entry yet — App.tsx was not
 * available when this file was built (not uploaded to this session), so the
 * actual `<Route>`/nav-item addition and this module's real permission key
 * (deliberately NOT reusing academics.institution_structure.manage, per the
 * §12 decision) still need to be added there. See the bottom of this file's
 * header comment continuation, "WIRING NEEDED", for the exact touch points.
 *
 * Props: { schoolId } — same minimal shape InstitutionTab already used for
 * this same data; no isAdmin prop consumed directly, matching this
 * codebase's Session-10-era convention of gating via useAuthStore's can()
 * inside the component rather than a boolean prop (see WIRING NEEDED below
 * for the permission key this needs once added to the catalog).
 *
 * CSS prefix: adm-* (new — every existing top-level module already has its
 * own short prefix: stu-/set-/reg-/port-/etc.; adm- was unused, confirmed by
 * grep across index.css before choosing it).
 *
 * WIRING NEEDED (left for the session that has App.tsx):
 *   1. Add a permission key (e.g. academics.admission.manage) to the
 *      permissions catalog, distinct from academics.institution_structure.manage
 *      — this is the entire point of the §12 correction; do not reuse the
 *      institution-structure key here.
 *   2. Add a route + nav entry for this module (alongside Students, not
 *      inside Settings).
 *   3. Gate this component's render behind that new key via useAuthStore's
 *      can(), the same pattern StudentsModule.tsx/CourseRegistrationModule.tsx
 *      already use — not yet added here since the permission key itself
 *      doesn't exist in the catalog yet.
 *   4. If a level→admission deep link is wanted (InstitutionTab's own
 *      "+ Admit student" button per programme level now navigates here, see
 *      that file's own updated button), thread an optional
 *      `initialProgrammeLevelId`/`initialLevelLabel` prop through from
 *      whatever navigation mechanism App.tsx uses (NavIntent-style, matching
 *      StudentsModule.tsx's own `intent` prop convention) so the picker below
 *      can pre-select instead of the admin re-choosing a level they already
 *      picked once in Settings.
 */

import { useState, useEffect, useCallback } from 'react'
import { Icon } from '../components/icons'
import {
  loadFaculties,
  loadDepartments,
  loadProgrammes,
  loadProgrammeLevels,
  loadCurrentSession,
  searchStudents,
  loadPlacementsForProgramme,
  type Department,
  type Programme,
  type ProgrammeLevel,
  type StudentSearchResult,
  type StudentProgrammePlacement,
} from '../services/settingsService'
import {
  loadMatricNumberFormat,
  saveMatricNumberFormat,
  hasAnyMatricAdmissions,
  admitStudent,
  type MatricNumberComponent,
  type AdmitStudentResult,
} from '../services/admissionService'
import { createStudent, type StudentUpsertParams } from '../services/studentsService'

export interface AdmissionModuleProps {
  schoolId: string
  // See header's WIRING NEEDED item 4 — optional deep-link from
  // InstitutionTab's level rows, wired once App.tsx's navigation mechanism
  // is known.
  initialProgrammeLevelId?: string
  initialLevelLabel?: string
}

export default function AdmissionModule({ schoolId, initialProgrammeLevelId, initialLevelLabel }: AdmissionModuleProps) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)


  const [departments, setDepartments] = useState<Department[]>([])
  const [programmes, setProgrammes] = useState<Programme[]>([])
  const [levelsByProgramme, setLevelsByProgramme] = useState<Record<string, ProgrammeLevel[]>>({})
  const [placementsByLevel, setPlacementsByLevel] = useState<Record<string, StudentProgrammePlacement[]>>({})

  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)
  const [currentSessionName, setCurrentSessionName] = useState<string | null>(null)
  const [currentSessionStartYear, setCurrentSessionStartYear] = useState<number | null>(null)

  // ── Matric number format (§12, SESSION 65 + correction pass) ───────────
  const [matricComponents, setMatricComponents] = useState<MatricNumberComponent[]>([])
  const [matricSaving, setMatricSaving] = useState(false)
  const [matricError, setMatricError] = useState<string | null>(null)
  const [matricSaved, setMatricSaved] = useState(false)
  // Soft-lock (§12 correction, 2026-07-17): true once any student has
  // genuinely been admitted under this school's format. Does not block
  // saving — Save always works — it only changes the copy shown so an
  // admin understands the consequence before confirming, matching the
  // decision's own "not blocked outright, just no longer casual" framing.
  const [hasRealAdmissions, setHasRealAdmissions] = useState(false)
  const [showLockConfirm, setShowLockConfirm] = useState(false)

  // ── Programme/level picker for the active admission ─────────────────────
  const [pickedLevelId, setPickedLevelId] = useState<string | null>(initialProgrammeLevelId ?? null)
  const [pickedLevelLabel, setPickedLevelLabel] = useState(initialLevelLabel ?? '')

  // ── Admit form ────────────────────────────────────────────────────────
  const [admitMode, setAdmitMode] = useState<'search' | 'create'>('search')
  const [studentQuery, setStudentQuery] = useState('')
  const debouncedStudentQuery = useDebouncedValue(studentQuery, 300)
  const [studentResults, setStudentResults] = useState<StudentSearchResult[]>([])
  const [studentSearching, setStudentSearching] = useState(false)
  const [selectedStudent, setSelectedStudent] = useState<StudentSearchResult | null>(null)
  const [newStudentName, setNewStudentName] = useState('')
  const [newStudentGender, setNewStudentGender] = useState('')
  const [newStudentDob, setNewStudentDob] = useState('')
  const [plSaving, setPlSaving] = useState(false)
  const [plError, setPlError] = useState<string | null>(null)
  const [admitResult, setAdmitResult] = useState<AdmitStudentResult | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const [fRes, dRes, pRes, sessRes, mfRes, lockRes] = await Promise.all([
      loadFaculties(schoolId),
      loadDepartments(schoolId),
      loadProgrammes(schoolId),
      loadCurrentSession(schoolId),
      loadMatricNumberFormat(schoolId),
      hasAnyMatricAdmissions(schoolId),
    ])
    if (fRes.error) { setError(fRes.error); setLoading(false); return }
    if (dRes.error) { setError(dRes.error); setLoading(false); return }
    if (pRes.error) { setError(pRes.error); setLoading(false); return }
    // mfRes.error is deliberately not a hard blocker — "no format configured
    // yet" is a normal state (same convention loadCgpaPolicy() established),
    // and admitStudent() itself surfaces a clear error at admit-time if a
    // school somehow reaches this screen with no format saved.
    if (!mfRes.error && mfRes.data) {
      setMatricComponents(mfRes.data.components)
    }
    if (!lockRes.error) {
      setHasRealAdmissions(lockRes.data)
    }
    if (!sessRes.error && sessRes.data) {
      setCurrentSessionId(sessRes.data.id)
      setCurrentSessionName(sessRes.data.name)
      // Admission year for the matric-number sequence's reset scope (§12
      // decision, 2026-07-17) — derived from the current session's real
      // start_date, same as the original SESSION 65 design.
      const startYear = new Date(sessRes.data.start_date).getFullYear()
      setCurrentSessionStartYear(Number.isFinite(startYear) ? startYear : null)
    }
    setDepartments(dRes.data)
    setProgrammes(pRes.data)
    const levelEntries = await Promise.all(
      pRes.data.map(async (prog) => [prog.id, (await loadProgrammeLevels(prog.id)).data] as const),
    )
    setLevelsByProgramme(Object.fromEntries(levelEntries))
    const allLevelIds = Object.values(Object.fromEntries(levelEntries)).flat().map(l => l.id)
    if (allLevelIds.length > 0) {
      const placementEntries = await Promise.all(
        allLevelIds.map(async (levelId) => [levelId, (await loadPlacementsForProgramme(levelId)).data] as const),
      )
      setPlacementsByLevel(Object.fromEntries(placementEntries))
    }
    setLoading(false)
  }, [schoolId])

  useEffect(() => { load() }, [load])

  // Debounced student search — only fires once the query settles, and only
  // against this school's own students (searchStudents scopes by schoolId
  // itself).
  useEffect(() => {
    if (!debouncedStudentQuery || debouncedStudentQuery.trim().length < 2) {
      setStudentResults([])
      return
    }
    let cancelled = false
    setStudentSearching(true)
    searchStudents(schoolId, debouncedStudentQuery).then(res => {
      if (cancelled) return
      setStudentResults(res.error ? [] : res.data)
      setStudentSearching(false)
    })
    return () => { cancelled = true }
  }, [schoolId, debouncedStudentQuery])

  function pickLevel(levelId: string, levelLabel: string) {
    setPickedLevelId(levelId)
    setPickedLevelLabel(levelLabel)
    setAdmitMode('search')
    setStudentQuery('')
    setStudentResults([])
    setSelectedStudent(null)
    setNewStudentName('')
    setNewStudentGender('')
    setNewStudentDob('')
    setPlError(null)
    setAdmitResult(null)
  }

  function clearPickedLevel() {
    setPickedProgrammeId(null)
    setPickedLevelId(null)
    setPickedLevelLabel('')
    setAdmitResult(null)
  }

  // SESSION 65 (PRD Problem 8.7a, items 1 and 7) — the one real, atomic
  // admission flow. Branches only on whether the student already exists
  // (search) or needs creating (create) — everything after that point
  // (matric-number generation + placement write) is the same single
  // admitStudent() call either way.
  async function handleAdmit() {
    if (!pickedLevelId) { setPlError('Choose a programme level first.'); return }
    if (!currentSessionId || currentSessionStartYear == null) {
      // Real, current constraint, not something to silently work around —
      // see settingsService.ts's original SESSION 65 note on why there is
      // deliberately no "no session" fallback here.
      setPlError('This school has no current session set. Set one in the Sessions tab before admitting students.')
      return
    }

    let studentId: string
    if (admitMode === 'search') {
      if (!selectedStudent) { setPlError('Search for and select a student, or switch to "New student".'); return }
      studentId = selectedStudent.id
    } else {
      if (!newStudentName.trim()) { setPlError('Enter the student\u2019s full name.'); return }
      setPlSaving(true)
      const createRes = await createStudent({
        schoolId,
        full_name: newStudentName,
        date_of_birth: newStudentDob || null,
        gender: newStudentGender || null,
        class_node_id: null,        // higher-ed admission — class_node_id is secondary-only (§7.5)
        admission_date: todayDateStringAdmission(),
        student_code: null,
        blood_group: null, address: null, medical_notes: null,
        emergency_contact_name: null, emergency_contact_phone: null,
        hobbies: null, email: null, phone: null,
      } as StudentUpsertParams)
      if (!createRes.ok) { setPlError(createRes.error); setPlSaving(false); return }
      studentId = createRes.data.id
    }

    setPlSaving(true)
    setPlError(null)
    const res = await admitStudent({
      schoolId,
      studentId,
      programmeLevelId: pickedLevelId,
      sessionId: currentSessionId,
      admissionYear: currentSessionStartYear,
    })
    if (res.error || !res.data) { setPlError(res.error ?? 'Admission failed.'); setPlSaving(false); return }
    setAdmitResult(res.data)
    await load()
    setPlSaving(false)
  }

  // ── Matric number format builder (§12, SESSION 65 + correction pass) ───
  function addMatricComponent(type: MatricNumberComponent['type']) {
    setMatricSaved(false)
    const next: MatricNumberComponent = { type, separator: matricComponents.length > 0 ? '/' : null }
    if (type === 'sequence') next.digits = 3
    if (type === 'session_year') next.year_format = '2digit'
    if (type === 'constant') next.value = ''
    setMatricComponents([...matricComponents, next])
  }

  function updateMatricComponent(index: number, patch: Partial<MatricNumberComponent>) {
    setMatricSaved(false)
    setMatricComponents(matricComponents.map((c, i) => (i === index ? { ...c, ...patch } : c)))
  }

  function removeMatricComponent(index: number) {
    setMatricSaved(false)
    setMatricComponents(matricComponents.filter((_, i) => i !== index))
  }

  function moveMatricComponent(index: number, direction: -1 | 1) {
    const target = index + direction
    if (target < 0 || target >= matricComponents.length) return
    setMatricSaved(false)
    const next = [...matricComponents]
    ;[next[index], next[target]] = [next[target], next[index]]
    setMatricComponents(next)
  }

  function requestSaveMatricFormat() {
    if (matricComponents.length === 0) {
      setMatricError('Add at least one component before saving.')
      return
    }
    if (!matricComponents.some(c => c.type === 'sequence')) {
      // Not a DB constraint — a real, deliberate UI-level guard: a format
      // with no sequence component would generate the identical matric
      // number for every student in the same programme/year.
      setMatricError('The format needs a sequence component, or every student in the same programme/year would get the same number.')
      return
    }
    setMatricError(null)
    // Soft-lock (§12 correction, 2026-07-17): once real admissions exist,
    // saving must go through an explicit confirm step rather than a plain
    // click — the confirm dialog names the real consequence
    // (matric_number_formats is now versioned, so past students keep their
    // already-generated numbers; only future admissions use the new shape).
    if (hasRealAdmissions) {
      setShowLockConfirm(true)
      return
    }
    void handleSaveMatricFormat()
  }

  async function handleSaveMatricFormat() {
    setShowLockConfirm(false)
    setMatricSaving(true)
    setMatricError(null)
    const res = await saveMatricNumberFormat(schoolId, matricComponents)
    if (res.error) { setMatricError(res.error); setMatricSaving(false); return }
    setMatricSaving(false)
    setMatricSaved(true)
    // A new version is now active — re-check the lock state (harmless if it
    // was already true; guards against a same-session double-save race
    // where the first save is what actually created the "real admissions"
    // condition, which cannot happen here since saving a format doesn't
    // admit anyone, but kept consistent with load()'s own re-fetch pattern
    // rather than assumed unchanged).
    const lockRes = await hasAnyMatricAdmissions(schoolId)
    if (!lockRes.error) setHasRealAdmissions(lockRes.data)
  }

  if (loading) return <Skeleton />
  if (error) return <ErrorState message={error} onRetry={load} />

  return (
    <div className="adm-page">
      <div className="adm-header">
        <h1 className="adm-title">Admission</h1>
        <p className="adm-subtitle">
          {currentSessionName ? `Current session: ${currentSessionName}` : 'No current session set — set one in Settings → Sessions.'}
        </p>
      </div>

      {/* ── Matric number format ──────────────────────────────────────── */}
      <section className="adm-section">
        <div className="adm-section-header">
          <SectionLabel>Matric number format</SectionLabel>
        </div>
        <p className="adm-hint-text">
          Build the shape of this school's matriculation numbers from components, in order. Each component after the first has its own separator.
        </p>
        {hasRealAdmissions && (
          <p className="adm-lock-notice">
            {/* 'lock' is not a confirmed icon name in this codebase's registry
                (components/icons.tsx wasn't available to check) — reusing
                'alert-triangle', already confirmed in use in this same file's
                ErrorState, rather than guessing at an unverified name. */}
            <Icon name="alert-triangle" style={{ width: 14, height: 14 }} />
            Students have already been admitted under the current format. Their numbers won't change — a new save only affects admissions from now on.
          </p>
        )}
        {matricComponents.length === 0 ? (
          <p className="adm-empty-hint">No format set up yet — add components below, then Save.</p>
        ) : (
          <div className="adm-matric-preview">
            <span className="adm-hint-text">Preview shape: </span>
            <code>{previewMatricFormat(matricComponents)}</code>
          </div>
        )}
        {matricComponents.map((c, i) => (
          <div key={i} className="adm-list-row adm-matric-row">
            <div className="adm-matric-row-fields">
              {i > 0 && (
                <input
                  type="text"
                  className="adm-input adm-matric-sep-input"
                  value={c.separator ?? ''}
                  onChange={e => updateMatricComponent(i, { separator: e.target.value || null })}
                  placeholder="/"
                  aria-label="Separator before this component"
                />
              )}
              <span className="adm-type-chip">{MATRIC_COMPONENT_LABELS[c.type]}</span>
              {c.type === 'constant' && (
                <input
                  type="text"
                  className="adm-input adm-matric-const-input"
                  value={c.value ?? ''}
                  onChange={e => updateMatricComponent(i, { value: e.target.value })}
                  placeholder="e.g. SCH"
                  aria-label="Fixed text value"
                />
              )}
              {c.type === 'session_year' && (
                <select
                  className="adm-select adm-select--sm"
                  value={c.year_format ?? '2digit'}
                  onChange={e => updateMatricComponent(i, { year_format: e.target.value as '2digit' | '4digit' })}
                >
                  <option value="2digit">2 digits (e.g. 26)</option>
                  <option value="4digit">4 digits (e.g. 2026)</option>
                </select>
              )}
              {c.type === 'sequence' && (
                <span className="adm-matric-digits-field">
                  <label className="adm-field-label" htmlFor={`matric-digits-${i}`}>Digits</label>
                  <input
                    id={`matric-digits-${i}`}
                    type="number"
                    className="adm-input adm-matric-digits-input"
                    value={String(c.digits ?? 3)}
                    onChange={e => updateMatricComponent(i, { digits: Math.max(1, Number(e.target.value) || 1) })}
                    min={1}
                  />
                </span>
              )}
            </div>
            <div className="adm-list-row-actions">
              <button className="adm-edit-btn" onClick={() => moveMatricComponent(i, -1)} disabled={i === 0}>↑</button>
              <button className="adm-edit-btn" onClick={() => moveMatricComponent(i, 1)} disabled={i === matricComponents.length - 1}>↓</button>
              <button className="adm-edit-btn" onClick={() => removeMatricComponent(i)}>Remove</button>
            </div>
          </div>
        ))}
        <div className="adm-section-header">
          <SectionLabel>Add component</SectionLabel>
          <div className="adm-add-btn-group">
            <select
              className="adm-select adm-select--sm"
              value=""
              onChange={e => { if (e.target.value) addMatricComponent(e.target.value as MatricNumberComponent['type']) }}
            >
              <option value="">Choose type…</option>
              {(Object.keys(MATRIC_COMPONENT_LABELS) as MatricNumberComponent['type'][]).map(t => (
                <option key={t} value={t}>{MATRIC_COMPONENT_LABELS[t]}</option>
              ))}
            </select>
            <button className="adm-save-btn" onClick={requestSaveMatricFormat} disabled={matricSaving}>
              {matricSaving ? 'Saving…' : 'Save format'}
            </button>
          </div>
        </div>
        {matricError && <p className="adm-form-error">{matricError}</p>}
        {matricSaved && !matricError && <p className="adm-hint-text">Saved.</p>}
      </section>

      {/* ── Programme / level picker ──────────────────────────────────── */}
      <section className="adm-section">
        <div className="adm-section-header">
          <SectionLabel>Admit a student</SectionLabel>
        </div>
        {!pickedLevelId ? (
          departments.length === 0 || programmes.length === 0 ? (
            <p className="adm-empty-hint">Set up at least one department and programme in Settings → Institution first.</p>
          ) : (
            programmes.map(p => (
              <div key={p.id} className="adm-class-node">
                <div className="adm-class-node-row">
                  <div className="adm-class-node-info">
                    <span className="adm-class-node-name">{p.name}</span>
                    <span className="adm-type-chip">{p.award_type}</span>
                  </div>
                </div>
                {(levelsByProgramme[p.id] ?? []).map(l => (
                  <div key={l.id} className="adm-class-node" style={{ marginLeft: 16 }}>
                    <div className="adm-class-node-row">
                      <div className="adm-class-node-info">
                        <span className="adm-class-node-name">{l.level_label}</span>
                        {(placementsByLevel[l.id] ?? []).length > 0 && (
                          <span className="adm-type-chip">{(placementsByLevel[l.id] ?? []).length} placed</span>
                        )}
                      </div>
                      <button className="adm-add-sub-btn" onClick={() => pickLevel(l.id, l.level_label)}>Admit into this level</button>
                    </div>
                  </div>
                ))}
              </div>
            ))
          )
        ) : (
          <div className="adm-admit-panel">
            <div className="adm-admit-panel-header">
              <p className="adm-list-row-name">{pickedLevelLabel}</p>
              <button className="adm-edit-btn" onClick={clearPickedLevel}>Change level</button>
            </div>

            {admitResult ? (
              <>
                <p className="adm-hint-text">
                  {admitResult.generated_new_number
                    ? 'Student admitted. Matric number generated:'
                    : 'Placement created. This student already had a matric number, so it was kept:'}
                </p>
                <p className="adm-matric-result"><code>{admitResult.matric_number}</code></p>
                <div className="adm-panel-footer">
                  <button className="adm-save-btn" onClick={() => setAdmitResult(null)}>Admit another</button>
                </div>
              </>
            ) : (
              <>
                <p className="adm-hint-text">
                  {currentSessionName
                    ? `This admits the student into ${pickedLevelLabel} for the current session (${currentSessionName}).`
                    : 'No current session is set for this school — set one in Settings → Sessions first.'}
                </p>

                <div className="adm-tab-switcher" role="group">
                  <button
                    className={`adm-tab-btn${admitMode === 'search' ? ' adm-tab-btn--active' : ''}`}
                    onClick={() => { setAdmitMode('search'); setPlError(null) }}
                  >
                    Existing student
                  </button>
                  <button
                    className={`adm-tab-btn${admitMode === 'create' ? ' adm-tab-btn--active' : ''}`}
                    onClick={() => { setAdmitMode('create'); setPlError(null) }}
                  >
                    New student
                  </button>
                </div>

                {admitMode === 'search' ? (
                  <FieldRow label="Student">
                    {selectedStudent ? (
                      <div className="adm-list-row">
                        <div className="adm-list-row-info">
                          <p className="adm-list-row-name">{selectedStudent.full_name}</p>
                          <p className="adm-list-row-meta">{selectedStudent.matric_number ?? 'No matric number yet'}</p>
                        </div>
                        <button className="adm-edit-btn" onClick={() => { setSelectedStudent(null); setStudentQuery('') }}>Change</button>
                      </div>
                    ) : (
                      <>
                        <input
                          type="text"
                          className="adm-input adm-search-input"
                          placeholder="Search by name or matric number…"
                          value={studentQuery}
                          onChange={e => setStudentQuery(e.target.value)}
                        />
                        {studentSearching && <p className="adm-hint-text">Searching…</p>}
                        {!studentSearching && studentQuery.trim().length >= 2 && studentResults.length === 0 && (
                          <p className="adm-empty-hint">No students match.</p>
                        )}
                        {studentResults.map(s => (
                          <div key={s.id} className="adm-list-row" onClick={() => setSelectedStudent(s)} style={{ cursor: 'pointer' }}>
                            <div className="adm-list-row-info">
                              <p className="adm-list-row-name">{s.full_name}</p>
                              <p className="adm-list-row-meta">{s.matric_number ?? 'No matric number yet'}</p>
                            </div>
                          </div>
                        ))}
                      </>
                    )}
                  </FieldRow>
                ) : (
                  <>
                    <FieldRow label="Full name"><Input value={newStudentName} onChange={setNewStudentName} placeholder="Student's full name" /></FieldRow>
                    <FieldRow label="Gender (optional)">
                      <select className="adm-select" value={newStudentGender} onChange={e => setNewStudentGender(e.target.value)}>
                        <option value="">Not specified</option>
                        <option value="male">Male</option>
                        <option value="female">Female</option>
                      </select>
                    </FieldRow>
                    <FieldRow label="Date of birth (optional)"><Input value={newStudentDob} onChange={setNewStudentDob} type="date" /></FieldRow>
                    <p className="adm-hint-text">Other details (address, guardians, photo, etc.) can be filled in afterward from the Students module.</p>
                  </>
                )}

                {plError && <p className="adm-form-error">{plError}</p>}
                <div className="adm-panel-footer">
                  <button className="adm-save-btn" onClick={handleAdmit} disabled={plSaving || !currentSessionId}>
                    {plSaving ? 'Admitting…' : 'Admit'}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </section>

      {/* ── Soft-lock confirm (§12 correction, 2026-07-17) ──────────────── */}
      {showLockConfirm && (
        <div className="adm-overlay" onClick={() => setShowLockConfirm(false)}>
          <div className="adm-sheet" onClick={e => e.stopPropagation()}>
            <h2 className="adm-sheet-title">Save a new matric number format?</h2>
            <p className="adm-hint-text">
              Students already admitted keep the matric numbers they were given — those don't change.
              Every admission from now on will use this new format instead of the current one.
            </p>
            <div className="adm-sheet-footer">
              <button className="adm-cancel-btn" onClick={() => setShowLockConfirm(false)}>Cancel</button>
              <button className="adm-save-btn" onClick={handleSaveMatricFormat} disabled={matricSaving}>
                {matricSaving ? 'Saving…' : 'Save new format'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// Display labels for each selectable matric-number-format component, and a
// pure client-side preview of the shape (not a real generated number — that
// only ever happens server-side, build_matric_number(),
// migration_session_65.sql/65b.sql — this just shows the admin the pattern
// they're building, e.g. "NSC/DEPT/26/0001").
const MATRIC_COMPONENT_LABELS: Record<MatricNumberComponent['type'], string> = {
  programme_code: 'Programme code',
  faculty_code: 'Faculty code',
  department_code: 'Department code',
  session_year: 'Admission year',
  constant: 'Fixed text',
  sequence: 'Sequence number',
}

function previewMatricFormat(components: MatricNumberComponent[]): string {
  return components
    .map((c, i) => {
      const sep = i > 0 ? (c.separator ?? '') : ''
      let piece = ''
      switch (c.type) {
        case 'programme_code': piece = 'NSC'; break
        case 'faculty_code': piece = 'MED'; break
        case 'department_code': piece = 'DEPT'; break
        case 'session_year': piece = c.year_format === '4digit' ? '2026' : '26'; break
        case 'constant': piece = c.value || '—'; break
        case 'sequence': piece = '1'.padStart(c.digits ?? 3, '0'); break
      }
      return sep + piece
    })
    .join('')
}

// ── Small local UI primitives ───────────────────────────────────────────
// Duplicated from SettingsModule.tsx rather than imported — that file
// defines these locally, not as shared exports, and this module is small
// enough that a shared-components extraction is out of this session's scope
// (flagged, not silently worked around).
function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="adm-section-label">{children}</p>
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="adm-field-row">
      <label className="adm-field-label">{label}</label>
      <div className="adm-field-control">{children}</div>
    </div>
  )
}

function Input({ value, onChange, placeholder, type = 'text' }: { value: string; onChange: (v: string) => void; placeholder?: string; type?: string }) {
  return (
    <input
      type={type}
      className="adm-input"
      value={value}
      placeholder={placeholder}
      onChange={e => onChange(e.target.value)}
    />
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

// Local date-string helper, matching studentsService.ts's own
// todayDateString() (local YYYY-MM-DD, no window/navigator dependency,
// React Native safe) rather than importing a function this file didn't
// otherwise need — same reasoning SettingsModule.tsx's own
// todayDateStringSettings() already used.
function todayDateStringAdmission(): string {
  const d = new Date()
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function Skeleton({ lines = 4 }: { lines?: number }) {
  return (
    <div className="adm-skel">
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className="adm-skel-line" style={{ width: i % 3 === 0 ? '70%' : i % 3 === 1 ? '50%' : '85%' }} />
      ))}
    </div>
  )
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="adm-error-state">
      <span className="adm-error-icon"><Icon name="alert-triangle" style={{ color: 'var(--color-warning, #d97706)' }} /></span>
      <p className="adm-error-msg">{message}</p>
      <button className="adm-retry-btn" onClick={onRetry}>Retry</button>
    </div>
  )
}
