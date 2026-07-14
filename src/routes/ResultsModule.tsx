/**
 * ResultsModule.tsx
 * Score entry, approval, and results review for teachers and admins.
 *
 * Props (same pattern as TimetableModule / AttendanceModule):
 *   schoolId  — passed from App.tsx via TabContent
 *   isAdmin   — true for staff/platform_admin actor types; retained for
 *               view-scope (all assignments vs. own) and cosmetic empty-state
 *               copy only — does NOT gate score entry (see below)
 *
 * Flow:
 *   1. Load current session (+ uses_terms flag) + teaching assignments in parallel
 *   2. Teacher/admin picks an assignment (subject + class combination)
 *   3. If uses_terms → show term selector
 *   4. Load students + score components + existing scores in parallel
 *   5. Show score entry grid: one row per student, one column per component
 *   6. Each cell is an inline numeric input — optimistic save on blur/enter
 *   7. Running weighted total + grade shown per student (computed client-side)
 *   8. Admin: Approve / Un-approve button for the whole subject set
 *   9. Approved rows show a lock icon; cells are read-only once approved
 *
 * UX contract (§4):
 *   - Grid loads instantly from cache on repeat visits
 *   - Every score save confirms immediately (optimistic), syncs in background
 *   - Offline: queued writes show ☁ indicator; flush on reconnect
 *   - Approved scores are visually distinct and non-editable
 *   - Empty states are actionable
 *   - Errors show plain English + Retry
 *
 * Updated (Session 10, PRD Problem 3.1, Goal 5): score-entry cells previously
 * had NO permission gate at all — readOnly only checked approval-lock and
 * in-flight-save, not authorization. Any signed-in actor who could reach a
 * teaching assignment (which for non-admins is already scoped to their own
 * assignments via loadMyTeachingAssignments) could edit scores regardless of
 * whether they held academics.scores.enter. Same class of pre-existing gap
 * Session 9 found and fixed in AttendanceModule.tsx.
 *
 * Fixed with canForClass('academics.scores.enter', classNodeId) rather than
 * a flat can() check — this is a class-scoped permission by design (see
 * §7.3/§12: staff_permission_class_scope / role_permission_class_scope), so
 * a teacher can hold academics.scores.enter generally but still be scoped to
 * specific classes, and an admin can grant a specific staff member an
 * override for a class outside their normal assignments without touching
 * their role. Admin bypass is automatic (canForClass takes the same
 * isAdminRole short-circuit as can()). academics.scores.approve (exact
 * catalog match) gates the Approve/Un-approve bar — a school-wide action,
 * not class-scoped, so plain can() applies there, not canForClass().
 * academics.scores.view_all gates the assignment-list scope (all
 * assignments vs. own) — a view-scope decision, not a write gate, same
 * shape as HRModule.tsx's hr.leave.view_all conversion.
 *
 * Updated (Tier 8, launch-blocking fix): staffId was previously resolved via
 * a raw supabase.auth.getUser() call (auth.users.id), but
 * teaching_assignments.staff_id / scores.entered_by / scores.approved_by are
 * all FKs to staff(id) — a different row. This made loadMyTeachingAssignments
 * always return empty for a real teacher (reported symptom: "isn't assigned
 * any subject in this session," despite correct assignments showing in
 * Timetable/TeacherDashboard, which both already resolved the right id).
 * Fixed by reading actorRecordId from authStore instead — same fix pattern
 * as Session 9's AttendanceModule.tsx markedBy bug and Finance's
 * received_by/approved_by bug.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { useAuthStore } from '../stores/authStore'
import { Icon } from '../components/icons'
import {
  loadCurrentSession,
  loadTermsForSession,
  loadMyTeachingAssignments,
  loadAllTeachingAssignments,
  loadScoreComponents,
  loadStudentsForClass,
  loadScores,
  loadGradeScale,
  saveScore,
  approveScores,
  unapproveScores,
  flushScoresQueue,
  buildScoreMap,
  computeWeightedTotal,
  getGradeLabel,
  isScoreSetComplete,
  isAnyScoreApproved,
  type Session,
  type Term,
  type TeachingAssignment,
  type ScoreComponent,
  type Student,
  type Score,
  type GradeBand,
  type ScoreMap,
} from '../services/resultsService'

// ─── Props ────────────────────────────────────────────────────────────────────

interface ResultsModuleProps {
  schoolId: string
  isAdmin: boolean
}

// ─── Load state machine ───────────────────────────────────────────────────────

type LoadState = 'booting' | 'loading' | 'ready' | 'empty' | 'error'

// ─── Component ────────────────────────────────────────────────────────────────

export default function ResultsModule({ schoolId, isAdmin }: ResultsModuleProps) {
  // ── Permissions (Session 10, PRD Problem 3.1) ────────────────────────────
  const can         = useAuthStore((s) => s.can)
  const canForClass = useAuthStore((s) => s.canForClass)
  const canViewAllAssignments = can('academics.scores.view_all')
  const canApproveScores      = can('academics.scores.approve')

  // ── Staff identity (Tier 8 fix — see PRD row) ─────────────────────────────
  // staff.id (actorRecordId), NOT auth.users.id. teaching_assignments.staff_id,
  // scores.entered_by, and scores.approved_by are all FKs to staff(id) — a
  // different row than the Supabase Auth user, joined only via
  // app_identities.auth_user_id -> actor_record_id. This file previously
  // resolved staffId via a raw supabase.auth.getUser() call (see removed
  // effect below), which meant loadMyTeachingAssignments(staffId, sessionId)
  // was always filtering staff_id against the wrong UUID -> always empty for
  // a real teacher, even though teaching_assignments had correct rows (this
  // is why Timetable/TeacherDashboard, which both correctly resolve
  // actorRecordId, showed the same assignments fine). Same bug class Session 9
  // found and fixed in AttendanceModule.tsx's markedBy, and Finance found and
  // fixed in payments.received_by / fee_discounts.approved_by.
  const staffId = useAuthStore((s) => s.actorRecordId) ?? ''

  // ── Session + assignments ─────────────────────────────────────────────────
  const [session,        setSession]        = useState<Session | null>(null)
  const [assignments,    setAssignments]    = useState<TeachingAssignment[]>([])
  const [selectedAssign, setSelectedAssign] = useState<TeachingAssignment | null>(null)
  const [bootState,      setBootState]      = useState<LoadState>('booting')
  const [bootError,      setBootError]      = useState('')

  // ── Terms ─────────────────────────────────────────────────────────────────
  const [terms,         setTerms]         = useState<Term[]>([])
  const [selectedTerm,  setSelectedTerm]  = useState<Term | null>(null)

  // ── Score components ──────────────────────────────────────────────────────
  const [components, setComponents] = useState<ScoreComponent[]>([])

  // ── Students + scores ─────────────────────────────────────────────────────
  const [students,   setStudents]   = useState<Student[]>([])
  const [scoreMap,   setScoreMap]   = useState<ScoreMap>(new Map())
  const [gradeBands, setGradeBands] = useState<GradeBand[]>([])
  const [gridState,  setGridState]  = useState<LoadState>('booting')
  const [gridError,  setGridError]  = useState('')

  // ── Optimistic / offline state ────────────────────────────────────────────
  // savingKeys: `${studentId}|${componentId}` → cell mid-save
  // errorKeys:  same key → error message (auto-clears 3s)
  // queuedKeys: same key → queued offline
  const [savingKeys, setSavingKeys] = useState<Set<string>>(new Set())
  const [errorKeys,  setErrorKeys]  = useState<Map<string, string>>(new Map())
  const [queuedKeys, setQueuedKeys] = useState<Set<string>>(new Set())
  const [isOnline,   setIsOnline]   = useState(true)
  const errorTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  // ── Approval ──────────────────────────────────────────────────────────────
  const [approving,   setApproving]   = useState(false)
  const [approveErr,  setApproveErr]  = useState('')

  // ─── Online / offline detection ────────────────────────────────────────────

  useEffect(() => {
    const handleOnline  = () => { setIsOnline(true);  flushScoresQueue() }
    const handleOffline = () => setIsOnline(false)
    window.addEventListener('online',  handleOnline)
    window.addEventListener('offline', handleOffline)
    return () => {
      window.removeEventListener('online',  handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])

  // ─── Boot: session + assignments + components + grade scale ───────────────

  useEffect(() => {
    let cancelled = false
    async function boot() {
      setBootState('loading')

      const sessionRes = await loadCurrentSession()
      if (cancelled) return
      if (!sessionRes.ok) {
        setBootError(sessionRes.error)
        setBootState('error')
        return
      }
      setSession(sessionRes.data)

      const [assignRes, compRes, gradeRes] = await Promise.all([
        (canViewAllAssignments || isAdmin)
          ? loadAllTeachingAssignments(sessionRes.data.id)
          : loadMyTeachingAssignments(staffId || '__pending__', sessionRes.data.id),
        loadScoreComponents(),
        loadGradeScale(),
      ])
      if (cancelled) return

      if (!assignRes.ok) { setBootError(assignRes.error); setBootState('error'); return }
      if (!compRes.ok)   { setBootError(compRes.error);   setBootState('error'); return }
      if (!gradeRes.ok)  { setBootError(gradeRes.error);  setBootState('error'); return }

      setAssignments(assignRes.data)
      setComponents(compRes.data)
      setGradeBands(gradeRes.data)

      if (sessionRes.data.uses_terms) {
        const termsRes = await loadTermsForSession(sessionRes.data.id)
        if (cancelled) return
        if (termsRes.ok) {
          setTerms(termsRes.data)
          setSelectedTerm(termsRes.data[0] ?? null)
        }
      }

      setBootState(assignRes.data.length === 0 ? 'empty' : 'ready')
    }
    // Wait for staffId before booting for teacher view
    if (isAdmin || staffId) boot()
    return () => { cancelled = true }
  }, [isAdmin, staffId, canViewAllAssignments])

  // ─── Load students + scores when assignment / term changes ────────────────

  const loadGrid = useCallback(async () => {
    if (!selectedAssign || !session) return
    setGridState('loading')
    setStudents([])
    setScoreMap(new Map())

    const [studentsRes, scoresRes] = await Promise.all([
      loadStudentsForClass(selectedAssign.class_node_id),
      loadScores({
        classNodeId: selectedAssign.class_node_id,
        subjectId:   selectedAssign.subject_id,
        sessionId:   session.id,
        termId:      selectedTerm?.id ?? null,
      }),
    ])

    if (!studentsRes.ok) { setGridError(studentsRes.error); setGridState('error'); return }
    if (!scoresRes.ok)   { setGridError(scoresRes.error);   setGridState('error'); return }

    setStudents(studentsRes.data)
    setScoreMap(buildScoreMap(scoresRes.data))
    setGridState(studentsRes.data.length === 0 ? 'empty' : 'ready')
  }, [selectedAssign, session, selectedTerm])

  useEffect(() => {
    if (selectedAssign && session) loadGrid()
  }, [loadGrid])

  // ─── Score cell save (optimistic) ─────────────────────────────────────────

  const handleScoreSave = useCallback(async (
    student: Student,
    component: ScoreComponent,
    rawValue: string,
  ) => {
    if (!selectedAssign || !session || !staffId) return

    const key = `${student.id}|${component.id}`

    if (!canForClass('academics.scores.enter', selectedAssign.class_node_id)) {
      // Fail gracefully per §4.12 — a revoked/never-granted permission must
      // produce a visible, plain-English message, not a silent no-op or a
      // silent success. Reuses the existing per-cell error-key UI (auto-
      // clears after 3s, same as any other save failure).
      setErrorKeys(prev => new Map(prev).set(key, 'You do not have permission to enter scores for this class.'))
      const timer = setTimeout(() => {
        setErrorKeys(prev => { const n = new Map(prev); n.delete(key); return n })
        errorTimers.current.delete(key)
      }, 3000)
      if (errorTimers.current.has(key)) clearTimeout(errorTimers.current.get(key)!)
      errorTimers.current.set(key, timer)
      return
    }

    const numValue = parseFloat(rawValue)
    if (isNaN(numValue) || numValue < 0 || numValue > 100) return

    const existing = scoreMap.get(key)

    // Skip save if value unchanged
    if (existing && existing.value === numValue) return

    // 1. Optimistic update
    const optimistic: Score = {
      id:                 existing?.id ?? crypto.randomUUID(),
      student_id:         student.id,
      subject_id:         selectedAssign.subject_id,
      term_id:            selectedTerm?.id ?? null,
      session_id:         session.id,
      score_component_id: component.id,
      value:              numValue,
      entered_by:         staffId,
      approved_by:        null,   // edit clears approval
      approved_at:        null,
    }
    setScoreMap(prev => new Map(prev).set(key, optimistic))

    // 2. Mark as saving
    setSavingKeys(prev => new Set(prev).add(key))

    // 3. Background write
    const result = await saveScore({
      schoolId:          schoolId,
      studentId:         student.id,
      subjectId:         selectedAssign.subject_id,
      sessionId:         session.id,
      termId:            selectedTerm?.id ?? null,
      scoreComponentId:  component.id,
      value:             numValue,
      enteredBy:         staffId,
    })

    setSavingKeys(prev => { const n = new Set(prev); n.delete(key); return n })

    if (result.queued) {
      setQueuedKeys(prev => new Set(prev).add(key))
      return
    }

    if (!result.ok) {
      // Revert
      setScoreMap(prev => {
        const next = new Map(prev)
        if (existing) next.set(key, existing)
        else next.delete(key)
        return next
      })
      setErrorKeys(prev => new Map(prev).set(key, result.error ?? 'Save failed'))
      const timer = setTimeout(() => {
        setErrorKeys(prev => { const n = new Map(prev); n.delete(key); return n })
        errorTimers.current.delete(key)
      }, 3000)
      if (errorTimers.current.has(key)) clearTimeout(errorTimers.current.get(key)!)
      errorTimers.current.set(key, timer)
    }
  }, [selectedAssign, session, selectedTerm, staffId, schoolId, scoreMap, canForClass])

  // ─── Approval ──────────────────────────────────────────────────────────────

  const handleApprove = useCallback(async () => {
    if (!selectedAssign || !session || !staffId) return
    if (!canApproveScores) {
      setApproveErr('You do not have permission to approve scores. Contact an administrator.')
      return
    }
    setApproving(true)
    setApproveErr('')

    const studentIds = students.map(s => s.id)
    const alreadyApproved = isAnyScoreApproved(studentIds, components, scoreMap)

    const result = alreadyApproved
      ? await unapproveScores({
          subjectId:  selectedAssign.subject_id,
          sessionId:  session.id,
          termId:     selectedTerm?.id ?? null,
          studentIds,
        })
      : await approveScores({
          classNodeId: selectedAssign.class_node_id,
          subjectId:   selectedAssign.subject_id,
          sessionId:   session.id,
          termId:      selectedTerm?.id ?? null,
          approvedBy:  staffId,
          studentIds,
        })

    setApproving(false)

    if (!result.ok) {
      setApproveErr(result.error ?? 'Failed')
      return
    }

    // Reload scores to reflect new approved_at values
    await loadGrid()
  }, [selectedAssign, session, selectedTerm, staffId, students, components, scoreMap, loadGrid, canApproveScores])

  // ─── Derived state ─────────────────────────────────────────────────────────

  const studentIds       = students.map(s => s.id)
  const isComplete       = isScoreSetComplete(studentIds, components, scoreMap)
  const anyApproved      = isAnyScoreApproved(studentIds, components, scoreMap)
  const allApproved      = students.length > 0 && students.every(s =>
    components.every(c => scoreMap.get(`${s.id}|${c.id}`)?.approved_at)
  )

  // ─── Render helpers ────────────────────────────────────────────────────────

  function renderAssignmentSelector() {
    if (bootState === 'loading' || bootState === 'booting') {
      return <div className="res-selector-skel skeleton" />
    }
    if (bootState === 'error') {
      return (
        <div className="res-error-state">
          <span className="res-error-icon"><Icon name="alert-triangle" style={{ color: 'var(--color-warning, #d97706)' }} /></span>
          <p className="res-error-msg">{bootError}</p>
          <button className="res-retry-btn" onClick={() => window.location.reload()}>Retry</button>
        </div>
      )
    }
    if (bootState === 'empty') {
      return (
        <div className="res-empty-state">
          <span className="res-empty-icon"><Icon name="book" /></span>
          <p className="res-empty-msg">
            {isAdmin
              ? 'No teaching assignments set up for this session yet.'
              : "You don't have any teaching assignments for this session."}
          </p>
          {isAdmin && <p className="res-empty-sub">Add assignments in the Setup guide.</p>}
        </div>
      )
    }
    return (
      <div className="res-selector-wrap">
        <label className="res-selector-label">Subject · Class</label>
        <select
          className="res-selector"
          value={selectedAssign?.id ?? ''}
          onChange={e => {
            const found = assignments.find(a => a.id === e.target.value) ?? null
            setSelectedAssign(found)
          }}
        >
          <option value="">— pick a subject and class —</option>
          {assignments.map(a => (
            <option key={a.id} value={a.id}>
              {a.subject_name} — {a.class_node_name}
            </option>
          ))}
        </select>
      </div>
    )
  }

  function renderTermSelector() {
    if (!session?.uses_terms || terms.length === 0) return null
    return (
      <div className="res-term-bar">
        {terms.map(t => (
          <button
            key={t.id}
            className={['res-term-btn', selectedTerm?.id === t.id ? 'res-term-btn--active' : ''].join(' ')}
            onClick={() => setSelectedTerm(t)}
          >
            {t.name}
          </button>
        ))}
      </div>
    )
  }

  function renderApproveBar() {
    if (!selectedAssign || gridState !== 'ready' || students.length === 0) return null
    if (!canApproveScores) return null

    return (
      <div className="res-approve-bar">
        <div className="res-approve-status">
          {allApproved && <span className="res-approve-badge res-approve-badge--locked"><Icon name="lock" size={14} /> Approved</span>}
          {!allApproved && isComplete && <span className="res-approve-badge res-approve-badge--ready"><Icon name="circle-check" size={14} style={{ color: 'var(--color-success, #16a34a)' }} /> Ready to approve</span>}
          {!allApproved && !isComplete && <span className="res-approve-badge res-approve-badge--incomplete"><Icon name="alert-triangle" size={14} style={{ color: 'var(--color-warning, #d97706)' }} /> Incomplete</span>}
        </div>
        <button
          className={['res-approve-btn', anyApproved ? 'res-approve-btn--unapprove' : 'res-approve-btn--approve'].join(' ')}
          disabled={approving || (!isComplete && !anyApproved)}
          onClick={handleApprove}
        >
          {approving ? '…' : anyApproved ? 'Un-approve' : 'Approve'}
        </button>
        {approveErr && <span className="res-approve-err">{approveErr}</span>}
      </div>
    )
  }

  function renderScoreCell(student: Student, component: ScoreComponent) {
    const key      = `${student.id}|${component.id}`
    const score    = scoreMap.get(key)
    const isSaving = savingKeys.has(key)
    const isQueued = queuedKeys.has(key)
    const errMsg   = errorKeys.get(key)
    const isLocked = !!score?.approved_at
    const canEdit  = selectedAssign
      ? canForClass('academics.scores.enter', selectedAssign.class_node_id)
      : false

    return (
      <td key={component.id} className="res-score-cell">
        <div className="res-score-cell-inner">
          {isSaving && <span className="res-cell-saving" aria-label="Saving"><Icon name="refresh-cw" size={14} /></span>}
          {errMsg   && <span className="res-cell-error" role="img" aria-label={errMsg} title={errMsg}><Icon name="x" size={14} style={{ color: 'var(--color-error, #dc2626)' }} /></span>}
          {isQueued && !isSaving && <span className="res-cell-queued" role="img" aria-label="Saved offline, will sync when reconnected" title="Saved offline — will sync when reconnected"><Icon name="cloud" size={14} /></span>}
          <input
            type="number"
            className={[
              'res-score-input',
              isLocked    ? 'res-score-input--locked'  : '',
              errMsg      ? 'res-score-input--error'   : '',
              isSaving    ? 'res-score-input--saving'  : '',
            ].join(' ')}
            min={0}
            max={100}
            step={0.5}
            defaultValue={score?.value ?? ''}
            readOnly={isLocked || isSaving || !canEdit}
            onBlur={e  => handleScoreSave(student, component, e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
            aria-label={`${student.full_name} — ${component.name}`}
            title={!canEdit ? 'You do not have permission to enter scores for this class' : undefined}
          />
          {isLocked && <span className="res-lock-icon" role="img" aria-label="Approved, locked" title="Approved — locked"><Icon name="lock" size={14} /></span>}
        </div>
      </td>
    )
  }

  function renderTotalCell(student: Student) {
    const total = computeWeightedTotal(student.id, components, scoreMap)
    const grade = getGradeLabel(total, gradeBands)
    return (
      <td className="res-total-cell">
        {total !== null ? (
          <span className="res-total">
            <span className="res-total-value">{total.toFixed(1)}</span>
            {grade && <span className="res-grade-pill">{grade}</span>}
          </span>
        ) : (
          <span className="res-total-empty">—</span>
        )}
      </td>
    )
  }

  function renderGrid() {
    if (!selectedAssign) {
      return (
        <div className="res-empty-state res-empty-state--prompt">
          <span className="res-empty-icon"><Icon name="bar-chart" /></span>
          <p className="res-empty-msg">Select a subject and class above to enter scores.</p>
        </div>
      )
    }

    if (gridState === 'loading' || gridState === 'booting') {
      return (
        <div className="res-grid-skel">
          {[1, 2, 3, 4, 5].map(i => (
            <div key={i} className="res-row-skel skeleton" />
          ))}
        </div>
      )
    }

    if (gridState === 'error') {
      return (
        <div className="res-error-state">
          <span className="res-error-icon"><Icon name="alert-triangle" style={{ color: 'var(--color-warning, #d97706)' }} /></span>
          <p className="res-error-msg">{gridError}</p>
          <button className="res-retry-btn" onClick={loadGrid}>Retry</button>
        </div>
      )
    }

    if (gridState === 'empty') {
      return (
        <div className="res-empty-state">
          <span className="res-empty-icon"><Icon name="users" /></span>
          <p className="res-empty-msg">No students enrolled in {selectedAssign.class_node_name} yet.</p>
          {isAdmin && <p className="res-empty-sub">Add students in the Students module.</p>}
        </div>
      )
    }

    return (
      <div className="res-table-wrap">
        <table className="res-table">
          <thead>
            <tr>
              <th className="res-th res-th--name">Student</th>
              {components.map(c => (
                <th key={c.id} className="res-th res-th--component">
                  <span className="res-th-name">{c.name}</span>
                  <span className="res-th-weight">{c.weight_pct}%</span>
                </th>
              ))}
              <th className="res-th res-th--total">Total</th>
            </tr>
          </thead>
          <tbody>
            {students.map(student => (
              <tr key={student.id} className="res-student-row">
                <td className="res-td res-td--name">{student.full_name}</td>
                {components.map(c => renderScoreCell(student, c))}
                {renderTotalCell(student)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="res-root">
      {/* Header */}
      <div className="res-header">
        <div className="res-header-top">
          <h2 className="res-title">Results</h2>
          {session && <span className="res-session-label">{session.name}</span>}
          {!isOnline && <span className="res-offline-badge"><Icon name="cloud" size={14} /> offline</span>}
        </div>

        {/* Assignment selector */}
        {renderAssignmentSelector()}

        {/* Term tabs — only when school uses terms */}
        {selectedAssign && renderTermSelector()}

        {/* Approve / un-approve bar */}
        {renderApproveBar()}
      </div>

      {/* Score entry grid */}
      <div className="res-body">
        {renderGrid()}
      </div>
    </div>
  )
}
