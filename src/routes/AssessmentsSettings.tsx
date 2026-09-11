/**
 * AssessmentsSettings.tsx
 * PRD Tier 8 / Problem 8.4 (Sessions 46–50) — admin configuration surfaces
 * for the Assessment Window system and secondary-school promotion, rendered
 * inside SettingsModule as two tabs:
 *
 *   AssessmentsTab        — sub-sectioned: Windows | Exams & venues | Grading
 *   PromotionTabSecondary — promotion rules + the run-preview/apply flow
 *
 * Lives outside SettingsModule.tsx deliberately: that file is already the
 * largest in the codebase, and both surfaces are substantial standalone CRUD
 * screens that consume their own domain services (assessmentService /
 * promotionService). SettingsModule wires them exactly like every other tab.
 *
 * All writes go through the services; RLS (admin-or-permission-key) remains
 * the real gate per §3.2. Every destructive action confirms first.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { Icon } from '../components/icons'
import { supabase } from '../lib/supabase'
import { useAuthStore } from '../stores/authStore'
import {
  loadWindows,
  createWindow,
  updateWindow,
  deleteWindow,
  loadWindowSummaries,
  loadWindowClasses,
  attachClassesToWindow,
  updateWindowClass,
  detachClassFromWindow,
  loadProfiles,
  saveProfile,
  deleteProfile,
  loadComponents,
  saveComponent,
  deleteComponent,
  loadVenues,
  saveVenue,
  deleteVenue,
  loadExamEntries,
  saveExamEntry,
  deleteExamEntry,
  setEntryInvigilators,
  findExamClashes,
  loadGradeBands,
  saveGradeBand,
  deleteGradeBand,
  loadAggregateBands,
  saveAggregateBand,
  deleteAggregateBand,
  loadAllFormMasters,
  assignFormMaster,
  uploadFormMasterSignature,
  loadReportCardSettings,
  saveReportCardSettings,
  loadMostRecentReportCardSettings,
  type AssessmentWindow,
  type ComponentProfile,
  type ScoreComponentWithMax,
  type AssessmentWindowClassRow,
  type Venue,
  type ExamEntry,
  type SecondaryGradeBand,
  type AggregateRemarkBand,
  type ClassFormMaster,
} from '../services/assessmentService'
import {
  loadPromotionRules,
  savePromotionRule,
  deletePromotionRule,
  type SecondaryPromotionRule,
} from '../services/promotionService'
import {
  loadSessions,
  loadTerms,
  loadClassNodes,
  loadSubjects,
  loadStaffWithRoles,
  type Session,
  type Term,
  type ClassNode,
  type Subject,
  type StaffListItem,
} from '../services/settingsService'

// ─── Shared bits ──────────────────────────────────────────────────────────────

const STATUS_ORDER: Array<AssessmentWindow['status']> = ['draft', 'open', 'closed', 'finalized']

function StatusChip({ status }: { status: AssessmentWindow['status'] }) {
  return <span className={`asw-chip asw-chip--${status}`}>{status}</span>
}

function SectionHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="set-section-header">
      <p className="set-section-label">{title}</p>
      {action}
    </div>
  )
}

// ─── Tab 1: Assessments ───────────────────────────────────────────────────────

export function AssessmentsTab({ schoolId }: { schoolId: string }) {
  const [section, setSection] = useState<'windows' | 'exams' | 'grading' | 'reportcards'>('windows')
  return (
    <div className="set-tab-content">
      <div className="asw-subnav" role="tablist">
        {([
          ['windows', 'Windows'],
          ['exams', 'Exams & venues'],
          ['grading', 'Grading & remarks'],
          ['reportcards', 'Report cards'],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={section === id}
            className={['asw-subnav-btn', section === id ? 'asw-subnav-btn--active' : ''].join(' ')}
            onClick={() => setSection(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {section === 'windows' && <WindowsSection schoolId={schoolId} />}
      {section === 'exams'   && <ExamsSection schoolId={schoolId} />}
      {section === 'grading' && <GradingSection schoolId={schoolId} />}
      {section === 'reportcards' && <ReportCardsSettingsSection schoolId={schoolId} />}
    </div>
  )
}

// ─── Windows section ──────────────────────────────────────────────────────────

function WindowsSection({ schoolId }: { schoolId: string }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [windows, setWindows] = useState<Array<AssessmentWindow & { session_name: string; term_name: string | null }>>([])
  const [summaries, setSummaries] = useState<Map<string, { classes: number; profiles: number }>>(new Map())
  const [sessionsList, setSessionsList] = useState<Session[]>([])
  const [termsList, setTermsList] = useState<Term[]>([])

  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<AssessmentWindow | null>(null)
  const [wName, setWName] = useState('')
  const [wSessionId, setWSessionId] = useState('')
  const [wTermId, setWTermId] = useState<string | null>(null)
  const [wScope, setWScope] = useState<AssessmentWindow['scope']>('whole_school')
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const [detailWindowId, setDetailWindowId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const [winRes, sessRes] = await Promise.all([loadWindows(schoolId), loadSessions(schoolId)])
    if (winRes.ok === false) { setError(winRes.error); setLoading(false); return }
    setWindows(winRes.data)
    setSessionsList(sessRes.data ?? [])
    if (sessRes.error) setError(sessRes.error)

    if (winRes.data.length > 0) {
      const sRes = await loadWindowSummaries(winRes.data.map(w => w.id))
      if (sRes.ok) setSummaries(sRes.data)
    }

    // Terms load per selected session — a uses_terms=false school has none,
    // so the form's term select simply never appears for it (§3.6 duality:
    // null term_id = whole-session window).
    const cur = (sessRes.data ?? []).find(s => s.is_current)
    if (cur) {
      const tRes = await loadTerms(schoolId, cur.id)
      setTermsList(tRes.data ?? [])
    }
    setLoading(false)
  }, [schoolId])

  useEffect(() => { load() }, [load])

  async function loadTermsForSession(sessionId: string) {
    const res = await loadTerms(schoolId, sessionId)
    setTermsList(res.data ?? [])
  }

  function openCreate() {
    setEditing(null)
    setWName('')
    const current = sessionsList.find(s => (s as any).is_current) ?? sessionsList[0]
    setWSessionId(current?.id ?? '')
    setWTermId(null)
    setWScope('whole_school')
    setFormError(null)
    setShowForm(true)
    if (current) void loadTermsForSession(current.id)
  }

  function openEdit(w: AssessmentWindow) {
    setEditing(w)
    setWName(w.name)
    setWSessionId(w.session_id)
    setWTermId(w.term_id)
    setWScope(w.scope)
    setFormError(null)
    setShowForm(true)
    void loadTermsForSession(w.session_id)
  }

  async function handleSave() {
    if (!wName.trim()) { setFormError('Give this window a name, e.g. "First Term Exams".'); return }
    if (!wSessionId) { setFormError('Pick a session.'); return }
    setSaving(true)
    setFormError(null)
    try {
      if (editing) {
        const res = await updateWindow(editing.id, {
          name: wName.trim(),
          scope: wScope,
        })
        if (!res.ok) { setFormError(res.error); setSaving(false); return }
      } else {
        // created_by references auth.users (§7 conventions) — the auth user id
        // comes straight from the session; null is legal on the column.
        const uid = (await supabase.auth.getUser()).data.user?.id ?? null
        const res = await createWindow({
          schoolId,
          sessionId: wSessionId,
          termId: wTermId,
          name: wName.trim(),
          scope: wScope,
          createdBy: uid as string,
        })
        if (!res.ok) { setFormError(res.error); setSaving(false); return }
      }
      setShowForm(false)
      await load()
    } finally {
      setSaving(false)
    }
  }

  async function advanceStatus(w: AssessmentWindow, dir: 1 | -1) {
    const idx = STATUS_ORDER.indexOf(w.status)
    const next = STATUS_ORDER[Math.min(Math.max(idx + dir, 0), STATUS_ORDER.length - 1)]
    if (next === w.status) return
    if (next === 'finalized' && !confirm(`Finalize "${w.name}"? Scores become permanently read-only.`)) return
    if (next === 'open' && !confirm(`Open "${w.name}" for score entry?`)) return
    const res = await updateWindow(w.id, { status: next })
    if (!res.ok) { alert(res.error); return }
    await load()
  }

  async function handleDelete(w: AssessmentWindow) {
    if (!confirm(`Delete "${w.name}"? Its weight profiles, attached classes, exam timetable entries, and student remarks are removed too.`)) return
    const res = await deleteWindow(w.id)
    if (!res.ok) { alert(res.error); return }
    await load()
  }

  if (loading) return <Skeletonish />

  return (
    <div>
      {error && <ErrorBoxish message={error} onRetry={load} />}

      <SectionHeader
        title="Assessment windows"
        action={<button className="set-add-btn" onClick={openCreate}>+ New window</button>}
      />
      {!error && windows.length === 0 && (
        <div className="asw-guide-empty">
          <span className="asw-guide-empty-icon"><Icon name="clipboard-list" size={22} /></span>
          <p className="asw-guide-empty-title">Set up your first assessment window</p>
          <p className="asw-guide-empty-sub">
            A window is one round of assessment — e.g. "First Term 2026/2027".
            You'll pick the classes, choose how scores are weighted (CA / Exam), then open it for teachers to enter scores.
          </p>
          <button className="set-save-btn" onClick={openCreate}>+ Create a window</button>
        </div>
      )}
      {windows.map(w => {
        const sum = summaries.get(w.id)
        const hint =
          w.status === 'draft'
            ? (sum && sum.profiles > 0
                ? 'Review the weighting and attached classes, then open it.'
                : 'Next: add score columns (e.g. CA 40% · Exam 60%), then open.')
            : w.status === 'open'
              ? 'Open — teachers can enter scores now.'
              : w.status === 'closed'
                ? 'Closed — review and approve results, then finalize to lock.'
                : 'Finalized — permanently locked.'
        return (
          <div key={w.id} className={`asw-window-card asw-window-card--${w.status}`}>
            <div className="asw-window-top">
              <div className="asw-window-title-wrap">
                <p className="set-list-row-name">{w.name} <StatusChip status={w.status} /></p>
                <p className="set-list-row-meta">
                  {w.session_name}{w.term_name ? ` · ${w.term_name}` : ''} · {' '}
                  {w.scope === 'whole_school' ? 'Whole school' : 'Selected classes'}
                </p>
              </div>
              {(w.status === 'draft' || w.status === 'closed') && (
                <button className="set-save-btn asw-window-primary" onClick={() => advanceStatus(w, 1)}>
                  {w.status === 'draft' ? 'Open for entry' : 'Finalize & lock'}
                </button>
              )}
              {w.status === 'open' && (
                <button className="set-cancel-btn asw-window-primary" onClick={() => advanceStatus(w, 1)}>
                  Close entry
                </button>
              )}
            </div>

            <div className="asw-window-progress">
              <span className={['asw-step', (sum?.classes ?? 0) > 0 || w.scope === 'whole_school' ? 'asw-step--done' : ''].join(' ')}>
                <Icon name={(sum?.classes ?? 0) > 0 || w.scope === 'whole_school' ? 'circle-check' : 'tag'} size={13} />
                {' '}{w.scope === 'whole_school' ? 'All classes' : `${sum?.classes ?? 0} class${(sum?.classes ?? 0) === 1 ? '' : 'es'}`}
              </span>
              <span className={['asw-step', (sum?.profiles ?? 0) > 0 ? 'asw-step--done' : ''].join(' ')}>
                <Icon name={(sum?.profiles ?? 0) > 0 ? 'circle-check' : 'bar-chart'} size={13} />
                {' '}{sum?.profiles ?? 0} weighting{(sum?.profiles ?? 0) === 1 ? '' : 's'}
              </span>
            </div>
            <p className="asw-window-hint">{hint}</p>

            <div className="asw-window-actions">
              <button className="set-edit-btn" onClick={() => setDetailWindowId(w.id)}>
                <Icon name="settings" size={13} /> Setup
              </button>
              <button className="set-edit-btn" onClick={() => openEdit(w)}>Rename</button>
              {w.status !== 'draft' && w.status !== 'finalized' && (
                <button className="set-edit-btn" onClick={() => advanceStatus(w, -1)}>Revert step</button>
              )}
              <button
                className="set-delete-btn asw-window-delete"
                onClick={() => handleDelete(w)}
                aria-label={`Delete ${w.name}`}
              >
                <Icon name="x" size={16} />
              </button>
            </div>
          </div>
        )
      })}

      {showForm && (
        <div className="set-overlay" onClick={() => setShowForm(false)}>
          <div className="set-sheet" onClick={e => e.stopPropagation()}>
            <h2 className="set-sheet-title">{editing ? 'Edit assessment window' : 'New assessment window'}</h2>

            <FieldRowish label="Name">
              <Inputish value={wName} onChange={setWName} placeholder='e.g. "First Term 2026/2027"' />
            </FieldRowish>

            <FieldRowish label="Session">
              <select className="set-select" value={wSessionId} onChange={e => {
                setWSessionId(e.target.value)
                setWTermId(null)
                void loadTermsForSession(e.target.value)
              }}>
                <option value="">Select a session…</option>
                {sessionsList.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </FieldRowish>

            {termsList.length > 0 && (
              <FieldRowish label="Term">
                <select className="set-select" value={wTermId ?? ''} onChange={e => setWTermId(e.target.value || null)}>
                  <option value="">Whole session (no term)</option>
                  {termsList.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </FieldRowish>
            )}

            <FieldRowish label="Scope">
              <select className="set-select" value={wScope} onChange={e => setWScope(e.target.value as AssessmentWindow['scope'])}>
                <option value="whole_school">Whole school — every class</option>
                <option value="selected_classes">Selected classes only</option>
              </select>
            </FieldRowish>

            {formError && <p className="set-form-error">{formError}</p>}
            <div className="set-sheet-footer">
              <button className="set-cancel-btn" onClick={() => setShowForm(false)}>Cancel</button>
              <button className="set-save-btn" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save window'}
              </button>
            </div>
          </div>
        </div>
      )}

      {detailWindowId && (
        <WindowDetailSheet
          schoolId={schoolId}
          windowRow={windows.find(w => w.id === detailWindowId) ?? null}
          onClose={() => setDetailWindowId(null)}
        />
      )}
    </div>
  )
}

// ─── Window detail sheet (classes + profiles + components) ───────────────────

function WindowDetailSheet({ schoolId, windowRow, onClose }: {
  schoolId: string
  windowRow: (AssessmentWindow & { session_name: string; term_name: string | null }) | null
  onClose: () => void
}) {
  const [profiles, setProfiles] = useState<ComponentProfile[]>([])
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null)
  const [components, setComponents] = useState<ScoreComponentWithMax[]>([])
  const [attached, setAttached] = useState<AssessmentWindowClassRow[]>([])
  const [allLeafClasses, setAllLeafClasses] = useState<ClassNode[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Profile add/rename
  const [profileDraft, setProfileDraft] = useState('')
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null)
  // Component form
  const [compForm, setCompForm] = useState<{ id?: string; name: string; weightPct: string; maxScore: string } | null>(null)
  // Attach selection
  const [attachSelection, setAttachSelection] = useState<Set<string>>(new Set())

  const loadAll = useCallback(async () => {
    if (!windowRow) return
    setLoading(true)
    setError(null)
    const [profRes, awcRes, clsRes] = await Promise.all([
      loadProfiles(windowRow.id),
      loadWindowClasses(windowRow.id),
      loadClassNodes(schoolId),
    ])
    if (!profRes.ok) { setError(profRes.error); setLoading(false); return }
    if (!awcRes.ok) { setError(awcRes.error); setLoading(false); return }
    setProfiles(profRes.data)
    setAttached(awcRes.data)
    setAllLeafClasses((clsRes.data ?? []).filter(c => c.is_leaf_enrollable))
    setActiveProfileId(prev => prev ?? profRes.data[0]?.id ?? null)
    setLoading(false)
  }, [windowRow, schoolId])

  useEffect(() => { loadAll() }, [loadAll])

  useEffect(() => {
    if (!activeProfileId) { setComponents([]); return }
    let cancelled = false
    loadComponents(activeProfileId).then(res => {
      if (!cancelled && res.ok) setComponents(res.data)
      if (!cancelled && !res.ok) setError(res.error)
    })
    return () => { cancelled = true }
  }, [activeProfileId])

  if (!windowRow) return null

  const weightSum = components.reduce((a, c) => a + c.weight_pct, 0)
  const attachedIds = new Set(attached.map(a => a.class_node_id))
  const attachable = allLeafClasses.filter(c => !attachedIds.has(c.id))

  async function handleAttach() {
    if (!activeProfileId || attachSelection.size === 0) return
    const res = await attachClassesToWindow(windowRow!.id, [...attachSelection], activeProfileId)
    if (!res.ok) { setError(res.error); return }
    setAttachSelection(new Set())
    await loadAll()
  }

  async function handleSaveComponent() {
    if (!compForm || !activeProfileId) return
    if (!compForm.name.trim()) { setError('Component name is required.'); return }
    const weight = parseFloat(compForm.weightPct)
    const max = parseFloat(compForm.maxScore || '100')
    if (isNaN(weight) || weight < 0 || weight > 100) { setError('Weight must be between 0 and 100.'); return }
    if (isNaN(max) || max <= 0) { setError("Max score must be a positive number."); return }
    const res = await saveComponent(schoolId, activeProfileId, {
      id: compForm.id,
      name: compForm.name.trim(),
      weightPct: weight,
      maxScore: max,
      sortOrder: compForm.id ? (components.find(c => c.id === compForm.id)?.sort_order ?? 0) : components.length,
    })
    if (!res.ok) { setError(res.error); return }
    setCompForm(null)
    setError(null)
    const refreshed = await loadComponents(activeProfileId)
    if (refreshed.ok) setComponents(refreshed.data)
  }

  return (
    <div className="set-overlay" onClick={onClose}>
      <div className="set-sheet set-sheet--wide" onClick={e => e.stopPropagation()}>
        <h2 className="set-sheet-title">{windowRow.name}</h2>
        <p className="asw-sheet-sub">
          {windowRow.session_name}{windowRow.term_name ? ` · ${windowRow.term_name}` : ''}
          {' · '}{windowRow.scope === 'whole_school' ? 'Whole school' : 'Selected classes'}
          {' '}<StatusChip status={windowRow.status} />
        </p>
        {loading && <Skeletonish />}

        {/* Weighting profiles */}
        <SectionHeader
          title="1 · Weighting profiles — one per class group that scores differently"
          action={
            editingProfileId === '__new__' ? null : (
              <button className="set-add-btn" onClick={() => { setEditingProfileId('__new__'); setProfileDraft('') }}>+ Add</button>
            )
          }
        />
        <div className="asw-profile-row">
          {profiles.map(p => (
            <span key={p.id} className={['asw-chip', p.id === activeProfileId ? 'asw-chip--open' : ''].join(' ')}>
              <button className="asw-profile-pick" onClick={() => setActiveProfileId(p.id)}>{p.name}</button>
              <button
                className="asw-profile-rename"
                aria-label={`Rename ${p.name}`}
                onClick={() => { setEditingProfileId(p.id); setProfileDraft(p.name) }}
              >
                <Icon name="pencil" size={12} />
              </button>
              {profiles.length > 1 && (
                <button
                  className="asw-profile-rename"
                  aria-label={`Delete ${p.name}`}
                  onClick={async () => {
                    if (!confirm(`Delete weighting "${p.name}"? Its score columns go with it.`)) return
                    const res = await deleteProfile(p.id)
                    if (!res.ok) { setError(res.error); return }
                    if (activeProfileId === p.id) setActiveProfileId(null)
                    await loadAll()
                  }}
                >
                  <Icon name="x" size={12} />
                </button>
              )}
            </span>
          ))}
          {profiles.length === 0 && <span className="set-empty-hint">No profiles yet.</span>}
        </div>

        {editingProfileId && (
          <div className="asw-inline-form">
            <Inputish
              value={profileDraft}
              onChange={setProfileDraft}
              placeholder={editingProfileId === '__new__' ? 'e.g. "Primary weighting"' : 'Profile name'}
            />
            <button
              className="set-save-btn"
              onClick={async () => {
                if (!profileDraft.trim()) return
                const res = await saveProfile(
                  schoolId,
                  editingProfileId === '__new__'
                    ? { name: profileDraft.trim(), windowId: windowRow!.id }
                    : { id: editingProfileId, name: profileDraft.trim() },
                )
                if (!res.ok) { setError(res.error); return }
                setEditingProfileId(null)
                setProfileDraft('')
                if (res.ok && 'id' in res.data) setActiveProfileId(res.data.id)
                await loadAll()
              }}
            >
              Save
            </button>
            <button className="set-cancel-btn" onClick={() => { setEditingProfileId(null); setProfileDraft('') }}>Cancel</button>
          </div>
        )}

        {/* Components of the active profile */}
        {activeProfileId && (
          <>
            <SectionHeader
              title={`2 · Score columns for "${activeProfileName(profiles, activeProfileId)}" — weights should total 100%`}
              action={<button className="set-add-btn" onClick={() => setCompForm({ name: '', weightPct: '', maxScore: '100' })}>+ Add column</button>}
            />
            {components.length === 0 && (
              <p className="set-empty-hint">
                No score columns yet — e.g. "1st CA" (20%), "2nd CA" (20%), "Exam" (60%).
              </p>
            )}
            {components.map(c => (
              <div key={c.id} className="set-list-row">
                <div className="set-list-row-info">
                  <p className="set-list-row-name">{c.name}</p>
                  <p className="set-list-row-meta">{c.weight_pct}% weight · scored out of {c.max_score}</p>
                </div>
                <div className="set-list-row-actions">
                  <button
                    className="set-edit-btn"
                    onClick={() => setCompForm({ id: c.id, name: c.name, weightPct: String(c.weight_pct), maxScore: String(c.max_score) })}
                  >
                    Edit
                  </button>
                  <button
                    className="set-delete-btn"
                    aria-label={`Delete ${c.name}`}
                    onClick={async () => {
                      if (!confirm(`Delete column "${c.name}"? Existing scores under it stay in the database but lose their column.`)) return
                      const res = await deleteComponent(c.id)
                      if (!res.ok) { setError(res.error); return }
                      const refreshed = await loadComponents(activeProfileId)
                      if (refreshed.ok) setComponents(refreshed.data)
                    }}
                  >
                    <Icon name="x" size={16} />
                  </button>
                </div>
              </div>
            ))}
            {components.length > 0 && Math.abs(weightSum - 100) > 0.01 && (
              <p className="asw-weight-warn">Weights total {weightSum}% — expected 100%.</p>
            )}

            {compForm && (
              <div className="asw-inline-form asw-inline-form--stack">
                <FieldRowish label="Column name">
                  <Inputish value={compForm.name} onChange={v => setCompForm({ ...compForm, name: v })} placeholder='e.g. "1st CA"' />
                </FieldRowish>
                <FieldRowish label="Weight %">
                  <Inputish value={compForm.weightPct} onChange={v => setCompForm({ ...compForm, weightPct: v })} placeholder="e.g. 30" type="number" />
                </FieldRowish>
                <FieldRowish label="Scored out of">
                  <Inputish value={compForm.maxScore} onChange={v => setCompForm({ ...compForm, maxScore: v })} placeholder="e.g. 20" type="number" />
                </FieldRowish>
                <div className="set-sheet-footer">
                  <button className="set-cancel-btn" onClick={() => setCompForm(null)}>Cancel</button>
                  <button className="set-save-btn" onClick={handleSaveComponent}>Save column</button>
                </div>
              </div>
            )}
          </>
        )}

        {/* Attached classes */}
        <SectionHeader
          title={windowRow.scope === 'whole_school'
            ? '3 · Classes — whole-school window covers every class automatically'
            : '3 · Classes covered by this window'}
        />
        {attached.length === 0 && (
          <p className="set-empty-hint">
            {windowRow.scope === 'whole_school'
              ? 'Whole-school window — every class is covered automatically.'
              : 'No classes attached yet.'}
          </p>
        )}
        {windowRow.scope === 'selected_classes' && attached.map(a => (
          <div key={a.id} className="asw-class-row">
            <span className="asw-class-name">{a.class_node_name}</span>
            <select
              className="set-select asw-class-select"
              value={a.score_component_profile_id}
              onChange={async e => {
                const res = await updateWindowClass(a.id, { score_component_profile_id: e.target.value })
                if (!res.ok) { setError(res.error); return }
                await loadAll()
              }}
              aria-label={`Weighting for ${a.class_node_name}`}
            >
              {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <label className="asw-check">
              <input
                type="checkbox"
                checked={a.is_promotional}
                onChange={async e => {
                  const res = await updateWindowClass(a.id, { is_promotional: e.target.checked })
                  if (!res.ok) { setError(res.error); return }
                  await loadAll()
                }}
              />
              Promotional
            </label>
            <label className="asw-check">
              <input
                type="checkbox"
                checked={a.sits_exam}
                onChange={async e => {
                  const res = await updateWindowClass(a.id, { sits_exam: e.target.checked })
                  if (!res.ok) { setError(res.error); return }
                  await loadAll()
                }}
              />
              Exam class
            </label>
            <button
              className="set-delete-btn"
              aria-label={`Remove ${a.class_node_name}`}
              onClick={async () => {
                const res = await detachClassFromWindow(a.id)
                if (!res.ok) { setError(res.error); return }
                await loadAll()
              }}
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        ))}

        {windowRow.scope === 'selected_classes' && attachable.length > 0 && activeProfileId && (
          <>
            <SectionHeader title="Attach classes" />
            <div className="asw-attach-grid">
              {attachable.map(c => (
                <label key={c.id} className="asw-check">
                  <input
                    type="checkbox"
                    checked={attachSelection.has(c.id)}
                    onChange={e => {
                      const next = new Set(attachSelection)
                      if (e.target.checked) next.add(c.id)
                      else next.delete(c.id)
                      setAttachSelection(next)
                    }}
                  />
                  {c.name}
                </label>
              ))}
            </div>
            <button className="set-save-btn" onClick={handleAttach} disabled={attachSelection.size === 0}>
              Attach {attachSelection.size > 0 ? `${attachSelection.size} class${attachSelection.size > 1 ? 'es' : ''}` : ''}
            </button>
          </>
        )}

        {error && <p className="set-form-error">{error}</p>}
        <div className="set-sheet-footer">
          <button className="set-cancel-btn" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}

function activeProfileName(profiles: ComponentProfile[], id: string): string {
  return profiles.find(p => p.id === id)?.name ?? ''
}

function groupEntriesByDate(entries: ExamEntry[]): Array<{ date: string; entries: ExamEntry[] }> {
  const byDate = new Map<string, ExamEntry[]>()
  for (const e of entries) {
    const list = byDate.get(e.exam_date) ?? []
    list.push(e)
    byDate.set(e.exam_date, list)
  }
  return [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, list]) => ({ date, entries: list }))
}

function formatDayLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00`)
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' })
}

// ─── Exams & venues section ───────────────────────────────────────────────────

function ExamsSection({ schoolId }: { schoolId: string }) {
  const [windowsList, setWindowsList] = useState<Array<AssessmentWindow & { session_name: string; term_name: string | null }>>([])
  const [selectedWindowId, setSelectedWindowId] = useState('')
  const [venues, setVenues] = useState<Venue[]>([])
  const [entries, setEntries] = useState<ExamEntry[]>([])
  const [subjects, setSubjects] = useState<Subject[]>([])
  const [leafClasses, setLeafClasses] = useState<ClassNode[]>([])
  const [staffList, setStaffList] = useState<StaffListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [venueForm, setVenueForm] = useState<{ name: string; capacity: string } | null>(null)
  const [entryForm, setEntryForm] = useState<{
    id?: string
    classNodeId: string
    subjectId: string
    date: string
    start: string
    end: string
    venueId: string | null
    invigilators: Set<string>
  } | null>(null)
  const [clashMsg, setClashMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const loadBase = useCallback(async () => {
    setLoading(true)
    setError(null)
    const [winRes, venRes, subjRes, staffRes, clsRes] = await Promise.all([
      loadWindows(schoolId),
      loadVenues(schoolId),
      loadSubjects(schoolId),
      loadStaffWithRoles(schoolId),
      loadClassNodes(schoolId),
    ])
    if (!winRes.ok) { setError(winRes.error); setLoading(false); return }
    setWindowsList(winRes.data)
    setVenues(venRes.ok ? venRes.data : [])
    setSubjects(subjRes.data ?? [])
    setLeafClasses((clsRes.data ?? []).filter(c => c.is_leaf_enrollable))
    setStaffList(staffRes.data ?? [])
    if (subjRes.error) setError(subjRes.error)
    setLoading(false)
  }, [schoolId])

  useEffect(() => { loadBase() }, [loadBase])

  const loadEntries = useCallback(async (windowId: string) => {
    if (!windowId) { setEntries([]); return }
    const res = await loadExamEntries({ schoolId, windowId })
    if (!res.ok) { setError(res.error); return }
    setEntries(res.data)
  }, [schoolId])

  useEffect(() => { void loadEntries(selectedWindowId) }, [selectedWindowId, loadEntries])

  /** Recheck clashes live as the form changes. */
  function recomputeClash(form: NonNullable<typeof entryForm>): string | null {
    if (!form.classNodeId || !form.date || !form.start || !form.end) return null
    const report = findExamClashes({
      excludeEntryId: form.id,
      classNodeId: form.classNodeId,
      examDate: form.date,
      startTime: form.start,
      endTime: form.end,
      venueId: form.venueId,
      invigilatorStaffIds: [...form.invigilators],
    }, entries.filter(e => e.assessment_window_id === selectedWindowId))
    const parts: string[] = []
    if (report.classClash) parts.push(`${report.classClash.class_node_name} already has ${report.classClash.subject_name} at that time`)
    if (report.venueClash) parts.push(`${report.venueClash.venue_name ?? 'The venue'} is booked then by ${report.venueClash.class_node_name}`)
    for (const sc of report.staffClashes.slice(0, 2)) {
      const name = sc.entry.invigilators.find(i => i.staff_id === sc.staffId)?.staff_name ?? 'An invigilator'
      parts.push(`${name} is already invigilating ${sc.entry.subject_name} (${sc.entry.class_node_name}) then`)
    }
    return parts.length > 0 ? `Clash: ${parts.join('; ')}.` : null
  }

  function openEntryForm(entry?: ExamEntry) {
    setClashMsg(null)
    if (entry) {
      setEntryForm({
        id: entry.id,
        classNodeId: entry.class_node_id,
        subjectId: entry.subject_id,
        date: entry.exam_date,
        start: entry.start_time,
        end: entry.end_time,
        venueId: entry.venue_id,
        invigilators: new Set(entry.invigilators.map(i => i.staff_id)),
      })
    } else {
      setEntryForm({ classNodeId: '', subjectId: '', date: '', start: '', end: '', venueId: null, invigilators: new Set() })
    }
  }

  async function handleSaveEntry() {
    if (!entryForm) return
    if (!entryForm.classNodeId || !entryForm.subjectId || !entryForm.date || !entryForm.start || !entryForm.end) {
      setClashMsg('Class, subject, date, and both times are required.')
      return
    }
    if (recomputeClash(entryForm)) { setClashMsg(recomputeClash(entryForm)); return }
    setBusy(true)
    const res = await saveExamEntry({
      id: entryForm.id,
      assessmentWindowId: selectedWindowId,
      classNodeId: entryForm.classNodeId,
      subjectId: entryForm.subjectId,
      examDate: entryForm.date,
      startTime: entryForm.start,
      endTime: entryForm.end,
      venueId: entryForm.venueId,
      createdBy: (await supabase.auth.getUser()).data.user?.id ?? null,
    })
    if (!res.ok) { setClashMsg(res.error); setBusy(false); return }
    await setEntryInvigilators(res.data, [...entryForm.invigilators].map(sid => ({
      staff_id: sid,
      role: 'assistant' as const,
    })))
    setBusy(false)
    setEntryForm(null)
    await loadEntries(selectedWindowId)
  }

  if (loading) return <Skeletonish />

  return (
    <div>
      {error && <ErrorBoxish message={error} onRetry={loadBase} />}

      <FieldRowish label="Assessment window">
        <select
          className="set-select"
          value={selectedWindowId}
          onChange={e => setSelectedWindowId(e.target.value)}
        >
          <option value="">Select a window…</option>
          {windowsList.map(w => (
            <option key={w.id} value={w.id}>
              {w.name}{w.term_name ? ` · ${w.term_name}` : ''}
            </option>
          ))}
        </select>
      </FieldRowish>

      {selectedWindowId && (
        <>
          <SectionHeader
            title="Exam timetable"
            action={<button className="set-add-btn" onClick={() => openEntryForm()} disabled={!selectedWindowId}>+ Add exam</button>}
          />
          {entries.length === 0 && (
            <p className="set-empty-hint">No exams scheduled in this window yet. They appear on the Timetable module for the dates they fall on.</p>
          )}
          {groupEntriesByDate(entries).map(group => (
            <div key={group.date} className="asw-exam-day">
              <p className="asw-exam-day-label">{formatDayLabel(group.date)}</p>
              {group.entries.map(en => (
                <div key={en.id} className="asw-exam-row">
                  <span className="asw-exam-time">{en.start_time}</span>
                  <div className="set-list-row-info">
                    <p className="set-list-row-name">{en.subject_name} — {en.class_node_name}</p>
                    <p className="set-list-row-meta">
                      {en.start_time}–{en.end_time}
                      {en.venue_name ? ` · ${en.venue_name}` : ''}
                      {en.invigilators.length > 0 ? ` · ${en.invigilators.length} invigilator${en.invigilators.length > 1 ? 's' : ''}` : ''}
                    </p>
                  </div>
                  <div className="set-list-row-actions">
                    <button className="set-edit-btn" onClick={() => openEntryForm(en)}>Edit</button>
                    <button
                      className="set-delete-btn"
                      aria-label="Delete exam entry"
                      onClick={async () => {
                        if (!confirm(`Delete the ${en.subject_name} exam for ${en.class_node_name} on ${en.exam_date}?`)) return
                        const res = await deleteExamEntry(en.id)
                        if (!res.ok) { alert(res.error); return }
                        await loadEntries(selectedWindowId)
                      }}
                    >
                      <Icon name="x" size={16} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </>
      )}

      <SectionHeader
        title="Exam venues"
        action={<button className="set-add-btn" onClick={() => setVenueForm({ name: '', capacity: '' })}>+ Add venue</button>}
      />
      {venues.length === 0 && <p className="set-empty-hint">No venues yet — exam halls, labs, etc.</p>}
      {venues.map(v => (
        <div key={v.id} className="set-list-row">
          <div className="set-list-row-info">
            <p className="set-list-row-name">{v.name}</p>
            <p className="set-list-row-meta">Capacity {v.capacity}</p>
          </div>
          <div className="set-list-row-actions">
            <button
              className="set-delete-btn"
              aria-label={`Delete venue ${v.name}`}
              onClick={async () => {
                if (!confirm(`Delete venue "${v.name}"?`)) return
                const res = await deleteVenue(v.id)
                if (!res.ok) { alert(res.error); return }
                await loadBase()
              }}
            >
              <Icon name="x" size={16} />
            </button>
          </div>
        </div>
      ))}

      {venueForm && (
        <div className="set-overlay" onClick={() => setVenueForm(null)}>
          <div className="set-sheet" onClick={e => e.stopPropagation()}>
            <h2 className="set-sheet-title">Add venue</h2>
            <FieldRowish label="Name"><Inputish value={venueForm.name} onChange={v => setVenueForm({ ...venueForm, name: v })} placeholder='e.g. "Main Hall"' /></FieldRowish>
            <FieldRowish label="Capacity"><Inputish value={venueForm.capacity} onChange={v => setVenueForm({ ...venueForm, capacity: v })} type="number" placeholder="e.g. 120" /></FieldRowish>
            <div className="set-sheet-footer">
              <button className="set-cancel-btn" onClick={() => setVenueForm(null)}>Cancel</button>
              <button
                className="set-save-btn"
                onClick={async () => {
                  if (!venueForm.name.trim()) return
                  const cap = parseInt(venueForm.capacity || '0', 10)
                  const res = await saveVenue(schoolId, { name: venueForm.name.trim(), capacity: isNaN(cap) ? 0 : cap })
                  if (!res.ok) { alert(res.error); return }
                  setVenueForm(null)
                  await loadBase()
                }}
              >
                Save venue
              </button>
            </div>
          </div>
        </div>
      )}

      {entryForm && (
        <div className="set-overlay" onClick={() => setEntryForm(null)}>
          <div className="set-sheet set-sheet--wide" onClick={e => e.stopPropagation()}>
            <h2 className="set-sheet-title">{entryForm.id ? 'Edit exam' : 'Add exam'}</h2>

            <FieldRowish label="Class">
              <select className="set-select" value={entryForm.classNodeId} onChange={e => {
                const updated = { ...entryForm, classNodeId: e.target.value }
                setEntryForm(updated)
                setClashMsg(recomputeClash(updated))
              }}>
                <option value="">Select a class…</option>
                {leafClasses.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </FieldRowish>
            <FieldRowish label="Subject">
              <select className="set-select" value={entryForm.subjectId} onChange={e => setEntryForm({ ...entryForm, subjectId: e.target.value })}>
                <option value="">Select a subject…</option>
                {subjects.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </FieldRowish>
            <FieldRowish label="Date"><Inputish value={entryForm.date} onChange={v => setEntryForm({ ...entryForm, date: v })} type="date" /></FieldRowish>
            <FieldRowish label="Start"><Inputish value={entryForm.start} onChange={v => setEntryForm({ ...entryForm, start: v })} type="time" /></FieldRowish>
            <FieldRowish label="End"><Inputish value={entryForm.end} onChange={v => setEntryForm({ ...entryForm, end: v })} type="time" /></FieldRowish>
            <FieldRowish label="Venue">
              <select className="set-select" value={entryForm.venueId ?? ''} onChange={e => setEntryForm({ ...entryForm, venueId: e.target.value || null })}>
                <option value="">None</option>
                {venues.map(vn => <option key={vn.id} value={vn.id}>{vn.name} ({vn.capacity})</option>)}
              </select>
            </FieldRowish>
            <FieldRowish label="Invigilators">
              <div className="asw-attach-grid">
                {staffList.filter(s => s.status === 'active').map(st => (
                  <label key={st.id} className="asw-check">
                    <input
                      type="checkbox"
                      checked={entryForm.invigilators.has(st.id)}
                      onChange={e => {
                        const next = new Set(entryForm.invigilators)
                        if (e.target.checked) next.add(st.id)
                        else next.delete(st.id)
                        const updated = { ...entryForm, invigilators: next }
                        setEntryForm(updated)
                        setClashMsg(recomputeClash(updated))
                      }}
                    />
                    {st.full_name}
                  </label>
                ))}
              </div>
            </FieldRowish>

            {clashMsg && <p className="set-form-error">{clashMsg}</p>}
            <div className="set-sheet-footer">
              <button className="set-cancel-btn" onClick={() => setEntryForm(null)}>Cancel</button>
              <button className="set-save-btn" onClick={handleSaveEntry} disabled={busy}>{busy ? 'Saving…' : 'Save exam'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Grading & remarks section (grade bands + aggregate bands) ───────────────

function GradingSection({ schoolId }: { schoolId: string }) {
  const [bands, setBands] = useState<SecondaryGradeBand[]>([])
  const [aggBands, setAggBands] = useState<AggregateRemarkBand[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [bandForm, setBandForm] = useState<{ id?: string; min: string; max: string; label: string; remark: string } | null>(null)
  const [aggForm, setAggForm] = useState<{ id?: string; min: string; max: string; remark: string } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const [gRes, aRes] = await Promise.all([
      loadGradeBands(schoolId),          // secondary-safe write/read pair —
      loadAggregateBands(schoolId),      // NOT settingsService's higher-ed one
    ])
    if (!gRes.ok) { setError(gRes.error); setLoading(false); return }
    setBands(gRes.data)
    if (aRes.ok) setAggBands(aRes.data)
    setLoading(false)
  }, [schoolId])

  useEffect(() => { load() }, [load])

  if (loading) return <Skeletonish />

  return (
    <div>
      {error && <ErrorBoxish message={error} onRetry={load} />}

      <SectionHeader
        title="Grade bands (subject totals)"
        action={<button className="set-add-btn" onClick={() => setBandForm({ min: '', max: '', label: '', remark: '' })}>+ Add band</button>}
      />
      {bands.length === 0 && (
        <p className="set-empty-hint">No bands yet — without these, totals show no grade (A/B/C…) on reports.</p>
      )}
      {bands.map(b => (
        <div key={b.id} className="set-list-row">
          <div className="set-list-row-info">
            <p className="set-list-row-name">{b.grade_label} · {b.min_score}–{b.max_score}</p>
            {b.remark && <p className="set-list-row-meta">{b.remark}</p>}
          </div>
          <div className="set-list-row-actions">
            <button
              className="set-edit-btn"
              onClick={() => setBandForm({ id: b.id, min: String(b.min_score), max: String(b.max_score), label: b.grade_label, remark: b.remark ?? '' })}
            >
              Edit
            </button>
            <button
              className="set-delete-btn"
              aria-label={`Delete band ${b.grade_label}`}
              onClick={async () => {
                if (!confirm(`Delete band "${b.grade_label}"?`)) return
                const res = await deleteGradeBand(b.id)
                if (!res.ok) { alert(res.error); return }
                await load()
              }}
            >
              <Icon name="x" size={16} />
            </button>
          </div>
        </div>
      ))}

      <SectionHeader
        title="Overall remark bands (average across subjects)"
        action={<button className="set-add-btn" onClick={() => setAggForm({ min: '', max: '', remark: '' })}>+ Add band</button>}
      />
      {aggBands.length === 0 && (
        <p className="set-empty-hint">e.g. 75–100 "Excellent", 60–74 "Very Good", 40–59 "Pass", below 40 "Fail".</p>
      )}
      {aggBands.map(b => (
        <div key={b.id} className="set-list-row">
          <div className="set-list-row-info">
            <p className="set-list-row-name">{b.remark}</p>
            <p className="set-list-row-meta">{b.min_average}–{b.max_average} average</p>
          </div>
          <div className="set-list-row-actions">
            <button
              className="set-edit-btn"
              onClick={() => setAggForm({ id: b.id, min: String(b.min_average), max: String(b.max_average), remark: b.remark })}
            >
              Edit
            </button>
            <button
              className="set-delete-btn"
              aria-label={`Delete band ${b.remark}`}
              onClick={async () => {
                if (!confirm(`Delete overall band "${b.remark}"?`)) return
                const res = await deleteAggregateBand(b.id)
                if (!res.ok) { alert(res.error); return }
                await load()
              }}
            >
              <Icon name="x" size={16} />
            </button>
          </div>
        </div>
      ))}

      {bandForm && (
        <Sheetish title={bandForm.id ? 'Edit grade band' : 'Add grade band'} onClose={() => setBandForm(null)}>
          <FieldRowish label="Label"><Inputish value={bandForm.label} onChange={v => setBandForm({ ...bandForm, label: v })} placeholder='e.g. "A1"' /></FieldRowish>
          <FieldRowish label="Min total"><Inputish value={bandForm.min} onChange={v => setBandForm({ ...bandForm, min: v })} type="number" /></FieldRowish>
          <FieldRowish label="Max total"><Inputish value={bandForm.max} onChange={v => setBandForm({ ...bandForm, max: v })} type="number" /></FieldRowish>
          <FieldRowish label="Remark"><Inputish value={bandForm.remark} onChange={v => setBandForm({ ...bandForm, remark: v })} placeholder='e.g. "Excellent"' /></FieldRowish>
          <SheetFooterish
            onCancel={() => setBandForm(null)}
            onSave={async () => {
              const min = parseFloat(bandForm.min)
              const max = parseFloat(bandForm.max)
              if (!bandForm.label.trim() || isNaN(min) || isNaN(max)) { alert('Label, min, and max are required.'); return }
              const res = await saveGradeBand(schoolId, {
                id: bandForm.id,
                minScore: min,
                maxScore: max,
                label: bandForm.label.trim(),
                remark: bandForm.remark.trim() || null,
                sortOrder: bandForm.id ? (bands.find(b => b.id === bandForm.id)?.sort_order ?? 0) : bands.length,
              })
              if (!res.ok) { alert(res.error); return }
              setBandForm(null)
              await load()
            }}
            saving={false}
          />
        </Sheetish>
      )}

      {aggForm && (
        <Sheetish title={aggForm.id ? 'Edit overall band' : 'Add overall band'} onClose={() => setAggForm(null)}>
          <FieldRowish label="Remark"><Inputish value={aggForm.remark} onChange={v => setAggForm({ ...aggForm, remark: v })} placeholder='e.g. "Excellent"' /></FieldRowish>
          <FieldRowish label="Min average"><Inputish value={aggForm.min} onChange={v => setAggForm({ ...aggForm, min: v })} type="number" /></FieldRowish>
          <FieldRowish label="Max average"><Inputish value={aggForm.max} onChange={v => setAggForm({ ...aggForm, max: v })} type="number" /></FieldRowish>
          <SheetFooterish
            onCancel={() => setAggForm(null)}
            onSave={async () => {
              const min = parseFloat(aggForm.min)
              const max = parseFloat(aggForm.max)
              if (!aggForm.remark.trim() || isNaN(min) || isNaN(max)) { alert('Remark, min, and max are required.'); return }
              const res = await saveAggregateBand(schoolId, {
                id: aggForm.id,
                minAverage: min,
                maxAverage: max,
                remark: aggForm.remark.trim(),
                sortOrder: aggBands.length,
              })
              if (!res.ok) { alert(res.error); return }
              setAggForm(null)
              await load()
            }}
            saving={false}
          />
        </Sheetish>
      )}
    </div>
  )
}

// ─── Tab 2: Promotion (secondary) ─────────────────────────────────────────────

export function PromotionTabSecondary({ schoolId }: { schoolId: string }) {
  const [rules, setRules] = useState<SecondaryPromotionRule[]>([])
  const [leafClasses, setLeafClasses] = useState<ClassNode[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [ruleForm, setRuleForm] = useState<{
    id?: string
    fromClassId: string
    toClassId: string | null
    graduates: boolean
    cutoff: string
  } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const [rRes, cRes] = await Promise.all([
      loadPromotionRules(schoolId),
      loadClassNodes(schoolId),
    ])
    if (!rRes.ok) { setError(rRes.error); setLoading(false); return }
    setRules(rRes.data)
    setLeafClasses((cRes.data ?? []).filter(c => c.is_leaf_enrollable))
    setLoading(false)
  }, [schoolId])

  useEffect(() => { load() }, [load])

  if (loading) return <Skeletonish />

  return (
    <div>
      {error && <ErrorBoxish message={error} onRetry={load} />}

      <SectionHeader
        title="Promotion rules"
        action={<button className="set-add-btn" onClick={() => setRuleForm({ fromClassId: '', toClassId: null, graduates: false, cutoff: '' })}>+ Add rule</button>}
      />
      {rules.length === 0 && (
        <p className="set-empty-hint">
          One rule per class: where its students go next (or graduate), and the average they need. No rule = that class cannot be promoted.
        </p>
      )}
      {rules.map(r => (
        <div key={r.id} className="set-list-row">
          <div className="set-list-row-info">
            <p className="set-list-row-name">{r.from_class_name} → {r.to_class_name ?? 'Graduate (alumni)'}</p>
            <p className="set-list-row-meta">{r.min_average_pct === null ? 'No cutoff' : `${r.min_average_pct}% average required`}</p>
          </div>
          <div className="set-list-row-actions">
            <button
              className="set-edit-btn"
              onClick={() => setRuleForm({ id: r.id, fromClassId: r.from_class_node_id, toClassId: r.to_class_node_id, graduates: r.to_class_node_id === null, cutoff: r.min_average_pct === null ? '' : String(r.min_average_pct) })}
            >
              Edit
            </button>
            <button
              className="set-delete-btn"
              aria-label={`Delete rule for ${r.from_class_name}`}
              onClick={async () => {
                if (!confirm(`Delete the promotion rule for ${r.from_class_name}?`)) return
                const res = await deletePromotionRule(r.id)
                if (!res.ok) { alert(res.error); return }
                await load()
              }}
            >
              <Icon name="x" size={16} />
            </button>
          </div>
        </div>
      ))}

      {ruleForm && (
        <Sheetish title={ruleForm.id ? 'Edit promotion rule' : 'Add promotion rule'} onClose={() => setRuleForm(null)}>
          <FieldRowish label="From class">
            <select className="set-select" value={ruleForm.fromClassId} onChange={e => setRuleForm({ ...ruleForm, fromClassId: e.target.value })}>
              <option value="">Select class…</option>
              {leafClasses.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </FieldRowish>
          <div className="asw-inline-form">
            <label className="asw-check">
              <input
                type="checkbox"
                checked={ruleForm.graduates}
                onChange={e => setRuleForm({ ...ruleForm, graduates: e.target.checked, toClassId: e.target.checked ? null : ruleForm.toClassId })}
              />
              Final class — students graduate (become alumni)
            </label>
          </div>
          {!ruleForm.graduates && (
            <FieldRowish label="To class">
              <select className="set-select" value={ruleForm.toClassId ?? ''} onChange={e => setRuleForm({ ...ruleForm, toClassId: e.target.value || null })}>
                <option value="">Select destination…</option>
                {leafClasses.filter(c => c.id !== ruleForm.fromClassId).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </FieldRowish>
          )}
          <FieldRowish label="Minimum average % (leave blank for no cutoff)">
            <Inputish value={ruleForm.cutoff} onChange={v => setRuleForm({ ...ruleForm, cutoff: v })} type="number" placeholder='e.g. 40' />
          </FieldRowish>
          <SheetFooterish
            onCancel={() => setRuleForm(null)}
            onSave={async () => {
              if (!ruleForm.fromClassId) { alert('Pick the from-class.'); return }
              if (!ruleForm.graduates && !ruleForm.toClassId) { alert('Pick a destination class, or mark the class as final.'); return }
              const cutoff = ruleForm.cutoff.trim() === '' ? null : parseFloat(ruleForm.cutoff)
              if (cutoff !== null && (isNaN(cutoff) || cutoff < 0 || cutoff > 100)) { alert('Cutoff must be between 0 and 100.'); return }
              const res = await savePromotionRule(schoolId, {
                id: ruleForm.id,
                fromClassNodeId: ruleForm.fromClassId,
                toClassNodeId: ruleForm.graduates ? null : ruleForm.toClassId,
                minAveragePct: cutoff,
              })
              if (!res.ok) { alert(res.error); return }
              setRuleForm(null)
              await load()
            }}
            saving={false}
          />
        </Sheetish>
      )}
    </div>
  )
}

// ─── Local micro-primitives (mirror SettingsModule's private helpers) ─────────

// ─── Report cards section (Session 84 — Phase 3 of the Session 81 report
// card overhaul: admin UI for the tables/services built back then, which
// until now had no screen anywhere to actually configure them from) ────────
//
// Two independent CRUD surfaces sharing one section, same as Grading's own
// two-band-types-in-one-section precedent above:
//   1. Form master assignment — one staff member per class, with contact
//      info/notes for the guardian portal and an uploadable signature.
//      Assigning ALSO grants that staff a class-scoped permission (handled
//      entirely inside assignFormMaster() — this UI just calls it).
//   2. Report card print settings — resumption date / next-term fees /
//      notice, per class+session+term, with a "copy from last term" action.

function ReportCardsSettingsSection({ schoolId }: { schoolId: string }) {
  const [subsection, setSubsection] = useState<'formmasters' | 'printsettings'>('formmasters')
  return (
    <div>
      <div className="asw-subnav" role="tablist" style={{ marginBottom: 'var(--space-3)' }}>
        {([
          ['formmasters', 'Form masters'],
          ['printsettings', 'Print settings'],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={subsection === id}
            className={['asw-subnav-btn', subsection === id ? 'asw-subnav-btn--active' : ''].join(' ')}
            onClick={() => setSubsection(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {subsection === 'formmasters' && <FormMastersSection schoolId={schoolId} />}
      {subsection === 'printsettings' && <ReportCardPrintSettingsSection schoolId={schoolId} />}
    </div>
  )
}

function FormMastersSection({ schoolId }: { schoolId: string }) {
  const actorRecordId = useAuthStore(s => s.actorRecordId)

  const [leafClasses, setLeafClasses] = useState<ClassNode[]>([])
  const [staffList, setStaffList] = useState<StaffListItem[]>([])
  const [formMasters, setFormMasters] = useState<ClassFormMaster[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [assignForm, setAssignForm] = useState<{
    classNodeId: string
    staffId: string
    contactPhone: string
    contactEmail: string
    notesForParents: string
  } | null>(null)
  const [saving, setSaving] = useState(false)

  // Signature upload — separate from the assign form itself, since a
  // signature can only be uploaded for a class that ALREADY has a form
  // master assigned (the upload path keys off class_node_id on an
  // existing class_form_masters row — see uploadFormMasterSignature).
  const signatureInputRef = useRef<HTMLInputElement>(null)
  const [signatureUploadClassId, setSignatureUploadClassId] = useState<string | null>(null)
  const [signatureUploading, setSignatureUploading] = useState(false)
  const [signatureError, setSignatureError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const [clsRes, staffRes, fmRes] = await Promise.all([
      loadClassNodes(schoolId),
      loadStaffWithRoles(schoolId),
      loadAllFormMasters(schoolId),
    ])
    if (clsRes.error) { setError(clsRes.error); setLoading(false); return }
    setLeafClasses((clsRes.data ?? []).filter(c => c.is_leaf_enrollable))
    if (staffRes.error) { setError(staffRes.error); setLoading(false); return }
    setStaffList(staffRes.data)
    if (!fmRes.ok) { setError(fmRes.error); setLoading(false); return }
    setFormMasters(fmRes.data)
    setLoading(false)
  }, [schoolId])

  useEffect(() => { load() }, [load])

  if (loading) return <Skeletonish />

  const formMasterByClassId = new Map(formMasters.map(fm => [fm.class_node_id, fm]))
  const classById = new Map(leafClasses.map(c => [c.id, c]))

  function handleSignatureButtonClick(classNodeId: string) {
    setSignatureUploadClassId(classNodeId)
    setSignatureError(null)
    signatureInputRef.current?.click()
  }

  async function handleSignatureSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-selecting the same file later
    if (!file || !signatureUploadClassId) return
    setSignatureUploading(true)
    setSignatureError(null)
    const res = await uploadFormMasterSignature({ schoolId, classNodeId: signatureUploadClassId, file })
    setSignatureUploading(false)
    if (!res.ok) { setSignatureError(res.error); return }
    await load()
  }

  return (
    <div>
      {error && <ErrorBoxish message={error} onRetry={load} />}
      {signatureError && <p className="set-form-error">{signatureError}</p>}

      <input
        ref={signatureInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={handleSignatureSelected}
      />

      <SectionHeader
        title="Form masters / class coordinators"
        action={
          <button
            className="set-add-btn"
            onClick={() => setAssignForm({ classNodeId: leafClasses[0]?.id ?? '', staffId: staffList[0]?.id ?? '', contactPhone: '', contactEmail: '', notesForParents: '' })}
          >
            + Assign form master
          </button>
        }
      />
      <p className="set-empty-hint">
        A form master can edit remarks and upload a signature for their own class's report cards, and their
        contact details/notes show on the guardian and student portal for that class.
      </p>

      {leafClasses.length === 0 && (
        <p className="set-empty-hint">No classes set up yet — add classes in the Classes tab first.</p>
      )}

      {leafClasses.map(cls => {
        const fm = formMasterByClassId.get(cls.id)
        return (
          <div key={cls.id} className="set-list-row">
            <div className="set-list-row-info">
              <p className="set-list-row-name">{cls.name}</p>
              {fm ? (
                <>
                  <p className="set-list-row-meta">{fm.staff_name}</p>
                  {(fm.contact_phone || fm.contact_email) && (
                    <p className="set-list-row-meta">
                      {[fm.contact_phone, fm.contact_email].filter(Boolean).join('  •  ')}
                    </p>
                  )}
                </>
              ) : (
                <p className="set-list-row-meta">No form master assigned</p>
              )}
            </div>
            <div className="set-list-row-actions">
              {fm && (
                <button
                  className="set-edit-btn"
                  onClick={() => handleSignatureButtonClick(cls.id)}
                  disabled={signatureUploading && signatureUploadClassId === cls.id}
                >
                  {signatureUploading && signatureUploadClassId === cls.id
                    ? 'Uploading…'
                    : fm.signature_url ? 'Change signature' : 'Upload signature'}
                </button>
              )}
              <button
                className="set-edit-btn"
                onClick={() => setAssignForm({
                  classNodeId: cls.id,
                  staffId: fm?.staff_id ?? staffList[0]?.id ?? '',
                  contactPhone: fm?.contact_phone ?? '',
                  contactEmail: fm?.contact_email ?? '',
                  notesForParents: fm?.notes_for_parents ?? '',
                })}
              >
                {fm ? 'Reassign / edit' : 'Assign'}
              </button>
            </div>
          </div>
        )
      })}

      {assignForm && (
        <Sheetish
          title={classById.get(assignForm.classNodeId)?.name
            ? `Form master for ${classById.get(assignForm.classNodeId)!.name}`
            : 'Assign form master'}
          onClose={() => setAssignForm(null)}
        >
          <FieldRowish label="Class">
            <select
              className="set-input"
              value={assignForm.classNodeId}
              onChange={e => setAssignForm({ ...assignForm, classNodeId: e.target.value })}
            >
              {leafClasses.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </FieldRowish>
          <FieldRowish label="Staff member">
            <select
              className="set-input"
              value={assignForm.staffId}
              onChange={e => setAssignForm({ ...assignForm, staffId: e.target.value })}
            >
              {staffList.map(s => <option key={s.id} value={s.id}>{s.full_name}</option>)}
            </select>
          </FieldRowish>
          <FieldRowish label="Contact phone (for parents)">
            <Inputish
              value={assignForm.contactPhone}
              onChange={v => setAssignForm({ ...assignForm, contactPhone: v })}
              placeholder="If different from their staff record"
            />
          </FieldRowish>
          <FieldRowish label="Contact email (for parents)">
            <Inputish
              value={assignForm.contactEmail}
              onChange={v => setAssignForm({ ...assignForm, contactEmail: v })}
              placeholder="If different from their staff record"
            />
          </FieldRowish>
          <FieldRowish label="Notes for parents">
            <textarea
              className="set-input"
              rows={3}
              value={assignForm.notesForParents}
              onChange={e => setAssignForm({ ...assignForm, notesForParents: e.target.value })}
              placeholder="Shown on the guardian/student portal for this class"
            />
          </FieldRowish>
          <SheetFooterish
            onCancel={() => setAssignForm(null)}
            saving={saving}
            onSave={async () => {
              if (!assignForm.classNodeId || !assignForm.staffId) { alert('Class and staff member are required.'); return }
              if (!actorRecordId) { alert('Could not identify the current user.'); return }
              setSaving(true)
              const res = await assignFormMaster({
                schoolId,
                classNodeId: assignForm.classNodeId,
                staffId: assignForm.staffId,
                contactPhone: assignForm.contactPhone.trim() || null,
                contactEmail: assignForm.contactEmail.trim() || null,
                notesForParents: assignForm.notesForParents.trim() || null,
                assignedBy: actorRecordId,
              })
              setSaving(false)
              if (!res.ok) { alert(res.error); return }
              setAssignForm(null)
              await load()
            }}
          />
        </Sheetish>
      )}
    </div>
  )
}

function ReportCardPrintSettingsSection({ schoolId }: { schoolId: string }) {
  const actorRecordId = useAuthStore(s => s.actorRecordId)

  const [leafClasses, setLeafClasses] = useState<ClassNode[]>([])
  const [sessions, setSessions] = useState<Session[]>([])
  const [terms, setTerms] = useState<Term[]>([])
  const [selectedClassId, setSelectedClassId] = useState('')
  const [selectedSessionId, setSelectedSessionId] = useState('')
  const [selectedTermId, setSelectedTermId] = useState<string>('') // '' = whole session (uses_terms=false schools, or explicit "no term" choice)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [form, setForm] = useState({ resumptionDate: '', nextTermFees: '', notice: '' })
  const [formLoaded, setFormLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  const [hasPrevious, setHasPrevious] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const [clsRes, sessRes] = await Promise.all([
      loadClassNodes(schoolId),
      loadSessions(schoolId),
    ])
    if (clsRes.error) { setError(clsRes.error); setLoading(false); return }
    const leaves = (clsRes.data ?? []).filter(c => c.is_leaf_enrollable)
    setLeafClasses(leaves)
    if (sessRes.error) { setError(sessRes.error); setLoading(false); return }
    setSessions(sessRes.data)
    setSelectedClassId(prev => prev || leaves[0]?.id || '')
    setSelectedSessionId(prev => prev || sessRes.data.find(s => s.is_current)?.id || sessRes.data[0]?.id || '')
    setLoading(false)
  }, [schoolId])

  useEffect(() => { load() }, [load])

  // Load terms whenever the selected session changes.
  useEffect(() => {
    if (!selectedSessionId) { setTerms([]); return }
    let cancelled = false
    loadTerms(schoolId, selectedSessionId).then(res => {
      if (cancelled) return
      if (!res.error) {
        setTerms(res.data)
        setSelectedTermId(res.data[0]?.id ?? '')
      }
    })
    return () => { cancelled = true }
  }, [schoolId, selectedSessionId])

  // Load the settings row (if any) whenever class/session/term selection changes.
  useEffect(() => {
    if (!selectedClassId || !selectedSessionId) return
    let cancelled = false
    setFormLoaded(false)
    setSaveMsg(null);
    (async () => {
      const res = await loadReportCardSettings({
        classNodeId: selectedClassId,
        sessionId: selectedSessionId,
        termId: selectedTermId || null,
      })
      if (cancelled) return
      if (res.ok && res.data) {
        setForm({
          resumptionDate: res.data.resumption_date ?? '',
          nextTermFees: res.data.next_term_fees != null ? String(res.data.next_term_fees) : '',
          notice: res.data.notice ?? '',
        })
      } else {
        setForm({ resumptionDate: '', nextTermFees: '', notice: '' })
      }
      const prevRes = await loadMostRecentReportCardSettings({
        classNodeId: selectedClassId,
        excludeSessionId: selectedSessionId,
        excludeTermId: selectedTermId || null,
      })
      if (cancelled) return
      setHasPrevious(!!(prevRes.ok && prevRes.data))
      setFormLoaded(true)
    })()
    return () => { cancelled = true }
  }, [selectedClassId, selectedSessionId, selectedTermId])

  async function handleCopyFromLastTerm() {
    const prevRes = await loadMostRecentReportCardSettings({
      classNodeId: selectedClassId,
      excludeSessionId: selectedSessionId,
      excludeTermId: selectedTermId || null,
    })
    if (!prevRes.ok || !prevRes.data) { alert('No previous settings found for this class.'); return }
    setForm({
      resumptionDate: prevRes.data.resumption_date ?? '',
      nextTermFees: prevRes.data.next_term_fees != null ? String(prevRes.data.next_term_fees) : '',
      notice: prevRes.data.notice ?? '',
    })
  }

  async function handleSave() {
    if (!actorRecordId) { alert('Could not identify the current user.'); return }
    const fees = form.nextTermFees.trim() ? parseFloat(form.nextTermFees) : null
    if (form.nextTermFees.trim() && isNaN(fees as number)) { alert('Next term fees must be a number.'); return }
    setSaving(true)
    setSaveMsg(null)
    const res = await saveReportCardSettings({
      schoolId,
      classNodeId: selectedClassId,
      sessionId: selectedSessionId,
      termId: selectedTermId || null,
      resumptionDate: form.resumptionDate || null,
      nextTermFees: fees,
      notice: form.notice.trim() || null,
      createdBy: actorRecordId,
    })
    setSaving(false)
    if (!res.ok) { alert(res.error); return }
    setSaveMsg('Saved.')
  }

  if (loading) return <Skeletonish />

  return (
    <div>
      {error && <ErrorBoxish message={error} onRetry={load} />}

      <SectionHeader title="Report card print settings" />
      <p className="set-empty-hint">
        Resumption date, next term's fees, and a notice — printed on report cards for the class and term
        selected below. Set once per class per term; nothing prints if a field is left blank.
      </p>

      <FieldRowish label="Class">
        <select className="set-input" value={selectedClassId} onChange={e => setSelectedClassId(e.target.value)}>
          {leafClasses.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </FieldRowish>
      <FieldRowish label="Session">
        <select className="set-input" value={selectedSessionId} onChange={e => setSelectedSessionId(e.target.value)}>
          {sessions.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </FieldRowish>
      {terms.length > 0 && (
        <FieldRowish label="Term">
          <select className="set-input" value={selectedTermId} onChange={e => setSelectedTermId(e.target.value)}>
            {terms.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </FieldRowish>
      )}

      {formLoaded && (
        <>
          <div className="set-section-header" style={{ marginTop: 'var(--space-4)' }}>
            <p className="set-section-label">Settings for this class + term</p>
            {hasPrevious && (
              <button className="set-add-btn" onClick={handleCopyFromLastTerm}>Copy from last term</button>
            )}
          </div>

          <FieldRowish label="Next resumption date">
            <Inputish type="date" value={form.resumptionDate} onChange={v => setForm({ ...form, resumptionDate: v })} />
          </FieldRowish>
          <FieldRowish label="Next term fees (₦)">
            <Inputish type="number" value={form.nextTermFees} onChange={v => setForm({ ...form, nextTermFees: v })} placeholder="e.g. 65000" />
          </FieldRowish>
          <FieldRowish label="Notice">
            <textarea
              className="set-input"
              rows={3}
              value={form.notice}
              onChange={e => setForm({ ...form, notice: e.target.value })}
              placeholder="e.g. All outstanding fees must be cleared before resumption."
            />
          </FieldRowish>

          <div className="set-sheet-footer" style={{ justifyContent: 'flex-end', alignItems: 'center' }}>
            {saveMsg && <span className="set-list-row-meta" style={{ marginRight: 'auto' }}>{saveMsg}</span>}
            <button className="set-save-btn" onClick={handleSave} disabled={saving} style={{ flex: '0 0 auto' }}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </>
      )}
    </div>
  )
}

function Skeletonish() {
  return (
    <div className="set-skel">
      {[70, 50, 85, 60].map((w, i) => (
        <div key={i} className="set-skel-line skeleton" style={{ width: `${w}%` }} />
      ))}
    </div>
  )
}

function ErrorBoxish({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="set-error-state">
      <span className="set-error-icon"><Icon name="alert-triangle" style={{ color: 'var(--color-warning, #d97706)' }} /></span>
      <p className="set-error-msg">{message}</p>
      <button className="set-retry-btn" onClick={onRetry}>Retry</button>
    </div>
  )
}

function FieldRowish({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="set-field-row">
      <label className="set-field-label">{label}</label>
      <div className="set-field-control">{children}</div>
    </div>
  )
}

function Inputish({ value, onChange, placeholder, type = 'text' }: { value: string; onChange: (v: string) => void; placeholder?: string; type?: string }) {
  return (
    <input
      type={type}
      className="set-input"
      value={value}
      placeholder={placeholder}
      onChange={e => onChange(e.target.value)}
    />
  )
}

function Sheetish({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="set-overlay" onClick={onClose}>
      <div className="set-sheet" onClick={e => e.stopPropagation()}>
        <h2 className="set-sheet-title">{title}</h2>
        {children}
      </div>
    </div>
  )
}

function SheetFooterish({ onCancel, onSave, saving }: { onCancel: () => void; onSave: () => void; saving: boolean }) {
  return (
    <div className="set-sheet-footer">
      <button className="set-cancel-btn" onClick={onCancel}>Cancel</button>
      <button className="set-save-btn" onClick={onSave} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
    </div>
  )
}
