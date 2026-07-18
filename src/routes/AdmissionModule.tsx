/**
 * AdmissionModule.tsx
 * Student admission — pipeline-based application intake and stage progression
 * (PRD Tier 8 / Problem 8.7a, SESSION 65a/65b — rebuild of SESSION 65's
 * original single-screen admit flow, owner walkthrough 2026-07-17,
 * MASTER_PLAN.md §12 "SESSION 65a" rows).
 *
 * What this replaces and why: SESSION 65 shipped a single screen that
 * created a real `students` row at the moment of admission — via a
 * search-existing-or-create-new-student step — then attached a matric
 * number and placement to it directly. Two owner-reported defects traced
 * straight back to that shape: matric numbers generating before a programme
 * was actually settled, and a cramped single-screen UI with no room for
 * screening/decision/clearance steps schools actually run in practice. This
 * file's rebuild moves the real "does this person become a student" decision
 * to admit_from_application() (migration_session_65a.sql) and makes this
 * screen a pipeline: Applications → Screening → Decision → Clearance →
 * Admitted/Rejected, with tabs shown only for stages the school's active
 * pipelines actually use (§7 of the redesign proposal — "union of stages
 * actually used across the school's active pipelines").
 *
 * What moved OUT of this file:
 *   - The search-or-create-student step and its New Student sub-form — gone
 *     entirely. A real students row is only ever created by
 *     admit_from_application(), never picked/typed here.
 *   - The inline matric-number-format editor — relocated to Settings.
 *     SESSION 65c has since built the Admission Settings tab (pipelines,
 *     field settings, matric format, retention window) — this file still
 *     calls admitStudent()'s sibling admitFromApplication(), which needs a
 *     format to already exist; if a school has none, the RPC's own
 *     friendly error surfaces here at the point of admitting, same
 *     convention as before.
 *
 * What this turn (65b) deliberately stubbed, per the agreed scope: the new
 * application intake form (Applications tab) still captures only core
 * fields — identity + programme intent + entry_mode. SESSION 65c built the
 * *authoring* side (admission_field_settings: which JAMB/O'Level/
 * Direct-Entry fields are enabled/required, plus custom fields), but this
 * form was never wired to actually read that config and render the
 * dynamic fields. That consumer-side wiring is still a real, open gap —
 * not closed by 65c, and not silently forgotten either.
 *
 * Pipeline assignment on application creation, previously flagged here as
 * an unbuilt gap, is now closed: migration_session_65b_pipeline_assignment.sql
 * adds assign_admission_pipeline(), a BEFORE INSERT trigger on
 * admission_applications, so pipeline_id is set server-side per §4.2's
 * applies_to matching rule the moment an application is created — the
 * client never computes or duplicates that rule (see admissionService.ts's
 * createApplication() comment for the trigger's exact matching/fallback
 * order). pipeline_id can still legitimately be null — a school that has
 * authored no pipelines yet, or none that match and none marked default —
 * and that remains a visible, handled UI state (see the empty-pipeline
 * notice on stage tabs below), not an error.
 *
 * Nav entry, route, and permission key (academics.admission.manage) are
 * already wired in App.tsx from SESSION 65 — unchanged by this rebuild, per
 * the PRD's own scope note that only this module's internal content is
 * rebuilt.
 *
 * CSS prefix: adm-* (existing, SESSION 65). Reuses adm-tab-switcher/
 * adm-tab-btn (previously the search/create toggle) for the new top-level
 * tab bar, and adm-section/adm-list-row/adm-empty-hint/adm-hint-text etc.
 * throughout — no new prefix introduced.
 * SESSION 65e (owner audit, 2026-07-18) — three real gaps found and closed:
 *   1. Every component a school could enable in Admission Settings
 *      (screening: document_review/jamb_verification/olevel_verification/
 *      interview/aptitude_test; decision: committee_review/
 *      programme_confirmation; clearance: fee_payment/medical_clearance/
 *      document_submission) is now actually rendered here — previously
 *      only a notes box (screening) and two decision fields were wired,
 *      and one of those two was checked under the WRONG key
 *      ('programme_override', which has never existed in
 *      SettingsModule.tsx's real component vocabulary — the correct key is
 *      'programme_confirmation'), so it silently never rendered even when
 *      enabled. Checklist-only components (no dedicated column) persist
 *      into custom_field_values._admission_checklist, since the schema
 *      reserves real columns for screening_notes, the decision_ fields,
 *      and clearance_completed_at — not one column per checklist item.
 *   2. A real, on-device deadlock is now closed: an application could
 *      reach Clearance with no programme/level ever set, correctly fail
 *      admission there, and then have no way forward OR backward.
 *      migration_session_65e_decision_gate_and_revert.sql adds a hard DB
 *      block on leaving Decision without a resolvable programme/level, and
 *      a new revert_admission_application() RPC that steps an application
 *      back exactly one stage (owner decision: one step at a time, not an
 *      arbitrary jump). The "Move back" button here is shown only
 *      contextually — when stuck at Decision with no programme/level, or
 *      at Clearance with an unfinished checklist item — not as a general
 *      always-available control.
 *   3. This module previously had no awareness of the admission_pipeline_
 *      enabled master switch at all — turning it off in Settings did
 *      nothing here, even though the DB-side direct-add lock (students
 *      table trigger) already correctly reacted to it. This screen now
 *      reads that switch and renders blank with a note when off, instead
 *      of staying fully live and usable while direct student-add is
 *      simultaneously blocked elsewhere.
 * A fourth, larger item was raised in the same audit — an admission
 * scheduler/window concept (blur tabs when the switch is on but no
 * admission period is currently active, optionally per-stage) — and was
 * deliberately NOT built here; it's real net-new schema+UI, logged as its
 * own follow-up session rather than folded into this pass.
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { Icon } from '../components/icons'
import {
  loadProgrammes,
  loadProgrammeLevels,
  loadCurrentSession,
  type Programme,
  type ProgrammeLevel,
} from '../services/settingsService'
import {
  loadApplications,
  createApplication,
  updateApplicationFields,
  loadActivePipelines,
  computeAdmissionTabs,
  advanceApplication,
  revertApplication,
  admitFromApplication,
  rejectApplication,
  loadAdmissionMasterSettings,
  type AdmissionApplication,
  type AdmissionPipeline,
  type PipelineStageType,
  type EntryMode,
  type AdmitStudentResult,
} from '../services/admissionService'

export interface AdmissionModuleProps {
  schoolId: string
}

type TopTab = 'application' | PipelineStageType | 'closed'

export default function AdmissionModule({ schoolId }: AdmissionModuleProps) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [programmes, setProgrammes] = useState<Programme[]>([])
  const [levelsByProgramme, setLevelsByProgramme] = useState<Record<string, ProgrammeLevel[]>>({})
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)
  const [currentSessionName, setCurrentSessionName] = useState<string | null>(null)

  const [pipelines, setPipelines] = useState<AdmissionPipeline[]>([])
  const stageTabs = useMemo(() => computeAdmissionTabs(pipelines), [pipelines])
  const [pipelineEnabled, setPipelineEnabled] = useState(false)

  const [activeTab, setActiveTab] = useState<TopTab>('application')

  // Applications loaded per-tab, refetched on tab switch and after any
  // mutating action, rather than one big cross-stage load — each tab's list
  // is genuinely a different stage filter and can be sizeable during a real
  // admission period.
  const [applications, setApplications] = useState<AdmissionApplication[]>([])
  const [listLoading, setListLoading] = useState(false)
  const [listError, setListError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const [pRes, sessRes, pipeRes, masterRes] = await Promise.all([
      loadProgrammes(schoolId),
      loadCurrentSession(schoolId),
      loadActivePipelines(schoolId),
      loadAdmissionMasterSettings(schoolId),
    ])
    if (pRes.error) { setError(pRes.error); setLoading(false); return }
    if (pipeRes.error) { setError(pipeRes.error); setLoading(false); return }
    setProgrammes(pRes.data)
    const levelEntries = await Promise.all(
      pRes.data.map(async (prog) => [prog.id, (await loadProgrammeLevels(prog.id)).data] as const),
    )
    setLevelsByProgramme(Object.fromEntries(levelEntries))
    if (!sessRes.error && sessRes.data) {
      setCurrentSessionId(sessRes.data.id)
      setCurrentSessionName(sessRes.data.name)
    }
    setPipelines(pipeRes.data)
    // Master-switch read failing outright (e.g. a permissions edge case) is
    // treated as "not enabled" rather than blocking the whole screen on a
    // secondary read — the switch is a display/gate concern here, not the
    // page's core data.
    setPipelineEnabled(!masterRes.error && (masterRes.data?.admission_pipeline_enabled ?? false))
    setLoading(false)
  }, [schoolId])

  useEffect(() => { load() }, [load])

  const loadList = useCallback(async () => {
    setListLoading(true)
    setListError(null)
    const stage = activeTab === 'application' ? 'application' : activeTab === 'closed' ? undefined : activeTab
    const res = await loadApplications(schoolId, stage as any)
    if (res.error) { setListError(res.error); setListLoading(false); return }
    const rows = activeTab === 'closed'
      ? res.data.filter(a => a.stage === 'admitted' || a.stage === 'rejected')
      : res.data
    setApplications(rows)
    setListLoading(false)
  }, [schoolId, activeTab])

  useEffect(() => { if (!loading) loadList() }, [loading, loadList])

  function refreshAfterAction() {
    loadList()
  }

  if (loading) {
    return (
      <div className="adm-module">
        <h1 className="adm-page-title">Admission</h1>
        <Skeleton lines={6} />
      </div>
    )
  }

  if (error) {
    return (
      <div className="adm-module">
        <h1 className="adm-page-title">Admission</h1>
        <ErrorState message={error} onRetry={load} />
      </div>
    )
  }

  if (!pipelineEnabled) {
    return (
      <div className="adm-module">
        <h1 className="adm-page-title">Admission</h1>
        <p className="adm-empty-hint">
          The admission pipeline isn't enabled for this school right now. Students are
          currently added directly through the Students module instead. An admin can turn
          this on in Settings → Admission if this school is ready to run a formal
          admission process.
        </p>
      </div>
    )
  }

  const tabDefs: { key: TopTab; label: string }[] = [
    { key: 'application', label: 'Applications' },
    ...stageTabs.map((s) => ({ key: s, label: STAGE_LABELS[s] })),
    { key: 'closed', label: 'Admitted & Rejected' },
  ]

  return (
    <div className="adm-module">
      <h1 className="adm-page-title">
        Admission
        {currentSessionName && <span className="adm-page-subtitle"> · {currentSessionName}</span>}
      </h1>

      {!currentSessionId && (
        <p className="adm-empty-hint">No current session is set for this school — set one in Settings → Sessions first.</p>
      )}

      <div className="adm-tab-switcher" role="group">
        {tabDefs.map((t) => (
          <button
            key={t.key}
            className={`adm-tab-btn${activeTab === t.key ? ' adm-tab-btn--active' : ''}`}
            onClick={() => setActiveTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === 'application' && (
        <ApplicationsTab
          schoolId={schoolId}
          programmes={programmes}
          levelsByProgramme={levelsByProgramme}
          sessionId={currentSessionId}
          applications={applications}
          listLoading={listLoading}
          listError={listError}
          onCreated={refreshAfterAction}
          onAdvance={async (id, target) => {
            const res = await advanceApplication(id, target)
            if (!res.error) refreshAfterAction()
            return res
          }}
        />
      )}

      {(activeTab === 'screening' || activeTab === 'decision' || activeTab === 'clearance') && (
        <StageTab
          stage={activeTab}
          applications={applications}
          pipelines={pipelines}
          programmes={programmes}
          levelsByProgramme={levelsByProgramme}
          listLoading={listLoading}
          listError={listError}
          onSaveFields={async (id, fields) => {
            const res = await updateApplicationFields(id, fields)
            if (!res.error) refreshAfterAction()
            return res
          }}
          onAdvance={async (id, target) => {
            const res = await advanceApplication(id, target)
            if (!res.error) refreshAfterAction()
            return res
          }}
          onRevert={async (id) => {
            const res = await revertApplication(id)
            if (!res.error) refreshAfterAction()
            return res
          }}
          onReject={async (id, note) => {
            const res = await rejectApplication(id, note)
            if (!res.error) refreshAfterAction()
            return res
          }}
          onAdmit={async (id) => {
            const res = await admitFromApplication(id)
            if (!res.error) refreshAfterAction()
            return res
          }}
        />
      )}

      {activeTab === 'closed' && (
        <ClosedTab applications={applications} listLoading={listLoading} listError={listError} />
      )}
    </div>
  )
}

const STAGE_LABELS: Record<PipelineStageType, string> = {
  screening: 'Screening',
  decision: 'Decision',
  clearance: 'Clearance',
}

// Fixed real-world order this screen walks applicants through — mirrors
// advance_admission_application()'s own v_fixed_order exactly (migration
// migration_session_65a.sql §6). Kept here only for the UI's own "what's
// the next stage" button label; the DB is still the real authority on
// whether a given advance is actually valid.
const FIXED_ORDER: (PipelineStageType | 'clearance')[] = ['screening', 'decision', 'clearance']

// ─── Applications tab ────────────────────────────────────────────────────

function ApplicationsTab({
  schoolId,
  programmes,
  levelsByProgramme,
  sessionId,
  applications,
  listLoading,
  listError,
  onCreated,
  onAdvance,
}: {
  schoolId: string
  programmes: Programme[]
  levelsByProgramme: Record<string, ProgrammeLevel[]>
  sessionId: string | null
  applications: AdmissionApplication[]
  listLoading: boolean
  listError: string | null
  onCreated: () => void
  onAdvance: (id: string, target: 'screening' | 'decision' | 'clearance') => Promise<{ error: string | null }>
}) {
  const [showForm, setShowForm] = useState(false)

  return (
    <section className="adm-section">
      <div className="adm-section-header">
        <SectionLabel>Applications</SectionLabel>
        <button className="adm-save-btn" onClick={() => setShowForm(true)} disabled={!sessionId}>
          + New application
        </button>
      </div>

      {showForm && (
        <NewApplicationForm
          schoolId={schoolId}
          programmes={programmes}
          levelsByProgramme={levelsByProgramme}
          sessionId={sessionId as string}
          onDone={() => { setShowForm(false); onCreated() }}
          onCancel={() => setShowForm(false)}
        />
      )}

      {listError && <p className="adm-form-error">{listError}</p>}
      {listLoading ? (
        <Skeleton lines={3} />
      ) : applications.length === 0 ? (
        <p className="adm-empty-hint">No applications yet.</p>
      ) : (
        applications.map((a) => (
          <div key={a.id} className="adm-list-row">
            <div className="adm-list-row-info">
              <p className="adm-list-row-name">{a.full_name}</p>
              <p className="adm-list-row-meta">
                {a.entry_mode === 'direct_entry' ? 'Direct Entry' : 'UTME'}
                {!a.pipeline_id && ' · No pipeline assigned yet'}
              </p>
            </div>
            <button
              className="adm-add-sub-btn"
              onClick={async () => {
                const first = FIXED_ORDER[0] as 'screening'
                await onAdvance(a.id, first)
              }}
            >
              Move to next stage
            </button>
          </div>
        ))
      )}
    </section>
  )
}

function NewApplicationForm({
  schoolId,
  programmes,
  levelsByProgramme,
  sessionId,
  onDone,
  onCancel,
}: {
  schoolId: string
  programmes: Programme[]
  levelsByProgramme: Record<string, ProgrammeLevel[]>
  sessionId: string
  onDone: () => void
  onCancel: () => void
}) {
  const [fullName, setFullName] = useState('')
  const [gender, setGender] = useState('')
  const [dob, setDob] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [entryMode, setEntryMode] = useState<EntryMode>('utme')
  const [programmeId, setProgrammeId] = useState('')
  const [levelId, setLevelId] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const levels = programmeId ? (levelsByProgramme[programmeId] ?? []) : []

  async function handleSave() {
    if (!fullName.trim()) { setSaveError('Full name is required.'); return }
    setSaving(true)
    setSaveError(null)
    const res = await createApplication({
      schoolId,
      fullName: fullName.trim(),
      gender: gender || null,
      dateOfBirth: dob || null,
      phone: phone || null,
      email: email || null,
      programmeId: programmeId || null,
      entryLevelId: levelId || null,
      entryMode,
      sessionId,
    })
    setSaving(false)
    if (res.error) { setSaveError(res.error); return }
    onDone()
  }

  return (
    <div className="adm-admit-panel">
      <p className="adm-hint-text">
        Core fields only for now — JAMB/O'Level/Direct-Entry detail capture and
        school-configured custom fields are set up in Admission Settings, but this
        form doesn't render them yet. That wiring is still an open follow-up.
      </p>
      <FieldRow label="Full name"><Input value={fullName} onChange={setFullName} placeholder="Applicant's full name" /></FieldRow>
      <FieldRow label="Gender (optional)">
        <select className="adm-select" value={gender} onChange={e => setGender(e.target.value)}>
          <option value="">Not specified</option>
          <option value="male">Male</option>
          <option value="female">Female</option>
        </select>
      </FieldRow>
      <FieldRow label="Date of birth (optional)"><Input value={dob} onChange={setDob} type="date" /></FieldRow>
      <FieldRow label="Phone (optional)"><Input value={phone} onChange={setPhone} placeholder="Phone number" /></FieldRow>
      <FieldRow label="Email (optional)"><Input value={email} onChange={setEmail} placeholder="Email address" type="email" /></FieldRow>
      <FieldRow label="Entry mode">
        <div className="adm-tab-switcher" role="group">
          <button
            className={`adm-tab-btn${entryMode === 'utme' ? ' adm-tab-btn--active' : ''}`}
            onClick={() => setEntryMode('utme')}
          >
            UTME
          </button>
          <button
            className={`adm-tab-btn${entryMode === 'direct_entry' ? ' adm-tab-btn--active' : ''}`}
            onClick={() => setEntryMode('direct_entry')}
          >
            Direct Entry
          </button>
        </div>
      </FieldRow>
      <FieldRow label="Programme applied for (optional)">
        <select className="adm-select" value={programmeId} onChange={e => { setProgrammeId(e.target.value); setLevelId('') }}>
          <option value="">Not specified</option>
          {programmes.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </FieldRow>
      {programmeId && (
        <FieldRow label="Entry level (optional)">
          <select className="adm-select" value={levelId} onChange={e => setLevelId(e.target.value)}>
            <option value="">Not specified</option>
            {levels.map(l => <option key={l.id} value={l.id}>{l.level_label}</option>)}
          </select>
        </FieldRow>
      )}
      {saveError && <p className="adm-form-error">{saveError}</p>}
      <div className="adm-panel-footer">
        <button className="adm-cancel-btn" onClick={onCancel}>Cancel</button>
        <button className="adm-save-btn" onClick={handleSave} disabled={saving}>
          {saving ? 'Creating…' : 'Create application'}
        </button>
      </div>
    </div>
  )
}

// ─── Screening / Decision / Clearance tabs ──────────────────────────────
// Per §7 of the proposal: a single shared tab per stage type — not one tab
// per pipeline — rendering, for each applicant, only the components that
// applicant's own pipeline enabled for this stage.

function StageTab({
  stage,
  applications,
  pipelines,
  programmes,
  levelsByProgramme,
  listLoading,
  listError,
  onSaveFields,
  onAdvance,
  onRevert,
  onReject,
  onAdmit,
}: {
  stage: PipelineStageType
  applications: AdmissionApplication[]
  pipelines: AdmissionPipeline[]
  programmes: Programme[]
  levelsByProgramme: Record<string, ProgrammeLevel[]>
  listLoading: boolean
  listError: string | null
  onSaveFields: (id: string, fields: Partial<AdmissionApplication>) => Promise<{ error: string | null }>
  onAdvance: (id: string, target: 'screening' | 'decision' | 'clearance') => Promise<{ error: string | null }>
  onRevert: (id: string) => Promise<{ error: string | null }>
  onReject: (id: string, note?: string) => Promise<{ error: string | null }>
  onAdmit: (id: string) => Promise<{ data: AdmitStudentResult | null; error: string | null }>
}) {
  const pipelineById = useMemo(
    () => Object.fromEntries(pipelines.map((p) => [p.id, p])),
    [pipelines],
  )

  function nextStageAfter(current: PipelineStageType): 'decision' | 'clearance' | null {
    const idx = FIXED_ORDER.indexOf(current)
    const next = FIXED_ORDER[idx + 1]
    return (next as 'decision' | 'clearance') ?? null
  }

  return (
    <section className="adm-section">
      <div className="adm-section-header">
        <SectionLabel>{STAGE_LABELS[stage]}</SectionLabel>
      </div>
      {listError && <p className="adm-form-error">{listError}</p>}
      {listLoading ? (
        <Skeleton lines={3} />
      ) : applications.length === 0 ? (
        <p className="adm-empty-hint">No applications at this stage.</p>
      ) : (
        applications.map((a) => {
          const pipeline = a.pipeline_id ? pipelineById[a.pipeline_id] : null
          const stageRow = pipeline?.stages.find((s) => s.stage === stage)
          const components = stageRow?.components ?? {}
          return (
            <StageApplicantCard
              key={a.id}
              application={a}
              stage={stage}
              components={components}
              programmes={programmes}
              levelsByProgramme={levelsByProgramme}
              nextStage={nextStageAfter(stage)}
              onSaveFields={onSaveFields}
              onAdvance={onAdvance}
              onRevert={onRevert}
              onReject={onReject}
              onAdmit={onAdmit}
            />
          )
        })
      )}
    </section>
  )
}

function StageApplicantCard({
  application,
  stage,
  components,
  programmes,
  levelsByProgramme,
  nextStage,
  onSaveFields,
  onAdvance,
  onRevert,
  onReject,
  onAdmit,
}: {
  application: AdmissionApplication
  stage: PipelineStageType
  components: Record<string, boolean>
  programmes: Programme[]
  levelsByProgramme: Record<string, ProgrammeLevel[]>
  nextStage: 'decision' | 'clearance' | null
  onSaveFields: (id: string, fields: Partial<AdmissionApplication>) => Promise<{ error: string | null }>
  onAdvance: (id: string, target: 'screening' | 'decision' | 'clearance') => Promise<{ error: string | null }>
  onRevert: (id: string) => Promise<{ error: string | null }>
  onReject: (id: string, note?: string) => Promise<{ error: string | null }>
  onAdmit: (id: string) => Promise<{ data: AdmitStudentResult | null; error: string | null }>
}) {
  const [notes, setNotes] = useState(application.screening_notes ?? '')
  const [decisionProgrammeId, setDecisionProgrammeId] = useState(application.decision_programme_id ?? '')
  const [decisionLevelId, setDecisionLevelId] = useState(application.decision_level_id ?? '')
  const [decisionNote, setDecisionNote] = useState(application.decision_note ?? '')
  // Local checklist state for the components that are pure "mark as done"
  // toggles with no other field attached (document_review, jamb_verification,
  // olevel_verification, interview, aptitude_test, committee_review,
  // fee_payment, medical_clearance, document_submission). Persisted into
  // custom_field_values under an "_admission_checklist" key, since none of
  // these have a dedicated column of their own — the schema's real,
  // per-stage columns are reserved for screening_notes, the decision_
  // fields, and clearance_completed_at — not one column per checklist item.
  const existingChecklist = (application.custom_field_values?._admission_checklist as Record<string, boolean>) ?? {}
  const [checklist, setChecklist] = useState<Record<string, boolean>>(existingChecklist)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [admitResult, setAdmitResult] = useState<AdmitStudentResult | null>(null)

  const enabledKeys = Object.entries(components).filter(([, v]) => v).map(([k]) => k)
  const levels = decisionProgrammeId ? (levelsByProgramme[decisionProgrammeId] ?? []) : []

  // Mirrors the new DB-side gate in advance_admission_application() exactly
  // (migration_session_65e): a resolvable programme AND level, decision
  // override if set, otherwise the original application values. Used here
  // only to decide whether to surface the "Move back" escape hatch and a
  // clear warning before the person hits the real DB error — the DB call
  // itself remains the actual authority, this is UI-side foresight only.
  const resolvedProgrammeId = decisionProgrammeId || application.programme_id
  const resolvedLevelId = decisionLevelId || application.entry_level_id
  const missingProgrammeOrLevel = stage === 'decision' && (!resolvedProgrammeId || !resolvedLevelId)

  // Checklist-based components enabled for this stage but not yet ticked.
  // "Genuinely stuck" for screening/clearance (no DB-level gate exists for
  // these, unlike decision) is treated as: at least one enabled checklist
  // item still unticked, giving the admin a way back rather than forcing
  // them to advance with something left undone.
  const checklistKeys = enabledKeys.filter((k) => CHECKLIST_ONLY_KEYS.has(k))
  const hasUnfinishedChecklist = checklistKeys.some((k) => !checklist[k])
  const canGoBack = stage !== 'screening' && (missingProgrammeOrLevel || (stage === 'clearance' && hasUnfinishedChecklist))

  function toggleChecklist(key: string) {
    setChecklist((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  async function handleAdvanceOrAdmit() {
    setBusy(true)
    setActionError(null)
    const nextChecklist = { ...existingChecklist, ...checklist }
    if (stage === 'screening') {
      await onSaveFields(application.id, {
        screening_notes: notes,
        custom_field_values: { ...application.custom_field_values, _admission_checklist: nextChecklist },
      })
    }
    if (stage === 'decision') {
      await onSaveFields(application.id, {
        decision_programme_id: decisionProgrammeId || null,
        decision_level_id: decisionLevelId || null,
        decision_note: decisionNote || null,
        custom_field_values: { ...application.custom_field_values, _admission_checklist: nextChecklist },
      })
    }
    if (stage === 'clearance') {
      await onSaveFields(application.id, {
        custom_field_values: { ...application.custom_field_values, _admission_checklist: nextChecklist },
      })
    }
    if (nextStage) {
      const res = await onAdvance(application.id, nextStage)
      if (res.error) setActionError(res.error)
    } else {
      const res = await onAdmit(application.id)
      if (res.error) setActionError(res.error)
      else setAdmitResult(res.data)
    }
    setBusy(false)
  }

  async function handleReject() {
    setBusy(true)
    setActionError(null)
    const res = await onReject(application.id, decisionNote || undefined)
    if (res.error) setActionError(res.error)
    setBusy(false)
  }

  async function handleRevert() {
    setBusy(true)
    setActionError(null)
    const res = await onRevert(application.id)
    if (res.error) setActionError(res.error)
    setBusy(false)
  }

  if (admitResult) {
    return (
      <div className="adm-admit-panel">
        <p className="adm-hint-text">
          {admitResult.generated_new_number
            ? 'Applicant admitted. Matric number generated:'
            : 'Placement created. This applicant already had a matric number, so it was kept:'}
        </p>
        <p className="adm-matric-result"><code>{admitResult.matric_number}</code></p>
      </div>
    )
  }

  return (
    <div className="adm-list-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
      <div className="adm-list-row-info">
        <p className="adm-list-row-name">{application.full_name}</p>
        <p className="adm-list-row-meta">{application.entry_mode === 'direct_entry' ? 'Direct Entry' : 'UTME'}</p>
      </div>

      {enabledKeys.length === 0 && (
        <p className="adm-empty-hint">This applicant's pipeline has no components enabled for this stage.</p>
      )}

      {checklistKeys.length > 0 && (
        <div className="adm-field-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          {checklistKeys.map((key) => (
            <label key={key} className="adm-field-row" style={{ cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={!!checklist[key]}
                onChange={() => toggleChecklist(key)}
              />
              <span className="adm-field-label" style={{ marginLeft: 8 }}>{CHECKLIST_LABELS[key] ?? key}</span>
            </label>
          ))}
        </div>
      )}

      {stage === 'screening' && enabledKeys.includes('jamb_verification') && (
        <FieldRow label="JAMB score on record">
          <p className="adm-hint-text">{application.jamb_score ?? 'Not captured yet on this application'}</p>
        </FieldRow>
      )}

      {stage === 'screening' && enabledKeys.includes('olevel_verification') && (
        <FieldRow label="O'Level sittings on record">
          <p className="adm-hint-text">
            {(application.olevel_sitting_1?.length ?? 0) + (application.olevel_sitting_2?.length ?? 0) > 0
              ? `${(application.olevel_sitting_1?.length ?? 0) + (application.olevel_sitting_2?.length ?? 0)} subject result(s) on record`
              : 'Not captured yet on this application'}
          </p>
        </FieldRow>
      )}

      {stage === 'screening' && enabledKeys.length > 0 && (
        <FieldRow label="Screening notes">
          <textarea className="adm-input" value={notes} onChange={e => setNotes(e.target.value)} rows={2} />
        </FieldRow>
      )}

      {stage === 'decision' && enabledKeys.includes('programme_confirmation') && (
        <>
          <FieldRow label="Confirm/override programme">
            <select className="adm-select" value={decisionProgrammeId} onChange={e => { setDecisionProgrammeId(e.target.value); setDecisionLevelId('') }}>
              <option value="">{application.programme_id ? 'Keep applied-for programme' : 'Not specified'}</option>
              {programmes.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </FieldRow>
          {decisionProgrammeId && (
            <FieldRow label="Level">
              <select className="adm-select" value={decisionLevelId} onChange={e => setDecisionLevelId(e.target.value)}>
                <option value="">Not specified</option>
                {levels.map(l => <option key={l.id} value={l.id}>{l.level_label}</option>)}
              </select>
            </FieldRow>
          )}
        </>
      )}

      {stage === 'decision' && (
        <FieldRow label="Decision note">
          <textarea className="adm-input" value={decisionNote} onChange={e => setDecisionNote(e.target.value)} rows={2} />
        </FieldRow>
      )}

      {missingProgrammeOrLevel && (
        <p className="adm-form-error">
          No programme/level is on record for this applicant (neither the original application nor a
          confirmed override above). Advancing past Decision will be blocked until one is set here, or
          this applicant can be moved back to Screening if a programme was never meant to be decided yet.
        </p>
      )}

      {actionError && <p className="adm-form-error">{actionError}</p>}
      <div className="adm-panel-footer">
        {canGoBack && (
          <button className="adm-cancel-btn" onClick={handleRevert} disabled={busy}>
            {busy ? 'Saving…' : 'Move back'}
          </button>
        )}
        {stage === 'decision' && (
          <button className="adm-cancel-btn" onClick={handleReject} disabled={busy}>Reject</button>
        )}
        <button className="adm-save-btn" onClick={handleAdvanceOrAdmit} disabled={busy}>
          {busy ? 'Saving…' : nextStage ? `Move to ${STAGE_LABELS[nextStage]}` : 'Admit'}
        </button>
      </div>
    </div>
  )
}

// Canonical component keys, matching SettingsModule.tsx's PIPELINE_STAGE_
// TYPES exactly (the only writer of admission_pipeline_stages.components).
// Split into "checklist-only" (plain mark-as-done toggles, no other field)
// vs. the handful with dedicated UI/columns already handled inline above
// (programme_confirmation has its own picker; decision_note is always
// shown once Decision is reached, matching how a note is useful regardless
// of whether it was specifically enabled — jamb_verification/
// olevel_verification get their own read-only "on record" rows above,
// then still appear here as a checklist item for the actual act of
// verifying).
const CHECKLIST_ONLY_KEYS = new Set([
  'document_review', 'jamb_verification', 'olevel_verification', 'interview', 'aptitude_test',
  'committee_review',
  'fee_payment', 'medical_clearance', 'document_submission',
])

const CHECKLIST_LABELS: Record<string, string> = {
  document_review: 'Document review complete',
  jamb_verification: 'JAMB details verified',
  olevel_verification: "O'Level results verified",
  interview: 'Interview conducted',
  aptitude_test: 'Aptitude test conducted',
  committee_review: 'Committee review complete',
  fee_payment: 'Fee payment confirmed',
  medical_clearance: 'Medical clearance confirmed',
  document_submission: 'Original documents submitted',
}

// ─── Admitted & Rejected tab ─────────────────────────────────────────────

function ClosedTab({
  applications,
  listLoading,
  listError,
}: {
  applications: AdmissionApplication[]
  listLoading: boolean
  listError: string | null
}) {
  return (
    <section className="adm-section">
      <div className="adm-section-header">
        <SectionLabel>Admitted & Rejected</SectionLabel>
      </div>
      {listError && <p className="adm-form-error">{listError}</p>}
      {listLoading ? (
        <Skeleton lines={3} />
      ) : applications.length === 0 ? (
        <p className="adm-empty-hint">No admitted or rejected applications yet.</p>
      ) : (
        applications.map((a) => (
          <div key={a.id} className="adm-list-row">
            <div className="adm-list-row-info">
              <p className="adm-list-row-name">{a.full_name}</p>
              <p className="adm-list-row-meta">
                {a.stage === 'admitted' ? 'Admitted' : 'Rejected'}
                {a.stage === 'rejected' && a.purge_at && ` · Data purged ${new Date(a.purge_at).toLocaleDateString()}`}
              </p>
            </div>
            <span className="adm-type-chip">{a.stage === 'admitted' ? 'Admitted' : 'Rejected'}</span>
          </div>
        ))
      )}
    </section>
  )
}

// ── Small local UI primitives ───────────────────────────────────────────
// Duplicated from SettingsModule.tsx rather than imported — that file
// defines these locally, not as shared exports, same convention the
// original SESSION 65 version of this file already followed.
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
