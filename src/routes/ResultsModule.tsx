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

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useAuthStore } from '../stores/authStore'
import { Icon } from '../components/icons'
import {
  loadCurrentSession,
  loadTermsForSession,
  loadMyTeachingAssignments,
  loadAllTeachingAssignments,
  loadStudentsForClass,
  loadScores,
  loadGradeScale,
  saveScore,
  approveScores,
  unapproveScores,
  flushScoresQueue,
  getPendingScoresForScope,
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
import {
  resolveWindowForClass,
  loadComponents,
  type AssessmentWindow,
  type AssessmentWindowClassRow,
} from '../services/assessmentService'
import CourseResultsModule from './CourseResultsModule'
import ReportCardsPanel from './ReportCardsPanel'
import type { NavIntent } from '../App'
import { supabase } from '../lib/supabase'
import {
  previewPromotion,
  applyPromotions,
  type PromotionPreviewRow,
  type PromotionDecision,
} from '../services/promotionService'

// ─── Props ────────────────────────────────────────────────────────────────────

interface ResultsModuleProps {
  schoolId: string
  isAdmin: boolean
  /** Session 60: threaded through from App.tsx (school.school_type), same as
   *  CourseRegistrationModule/CourseAttendanceModule two tabs over. Used only
   *  to pick which of the two entirely-separate render paths below runs —
   *  never passed further down into the secondary-school path's own tree. */
  schoolType: string | null
  /** Intent passed from navigation — e.g. deep-link to pending approvals. */
  intent?: NavIntent
}

// Duplicated intentionally from SettingsModule.tsx's own private (unexported)
// copy, same as CourseRegistrationModule.tsx already does — see that file's
// own comment on this: "if a third module ever needs this same gate, worth
// promoting to a shared lib/schoolType.ts rather than a third copy." This is
// that third copy; promoting all three is a good follow-up, out of scope here.
const HIGHER_INSTITUTION_SCHOOL_TYPES = ['university', 'polytechnic', 'college_of_education', 'other']
function isHigherInstitutionSchoolType(schoolType: string | null | undefined): boolean {
  return !!schoolType && HIGHER_INSTITUTION_SCHOOL_TYPES.includes(schoolType)
}

// ─── Load state machine ───────────────────────────────────────────────────────

type LoadState = 'booting' | 'loading' | 'ready' | 'empty' | 'error'

// ─── Component ────────────────────────────────────────────────────────────────

export default function ResultsModule({ schoolId, isAdmin, schoolType, intent }: ResultsModuleProps) {
  // Session 60: higher-ed schools get a completely separate component, not a
  // rendering-time fork lower down. This is deliberate — the secondary path's
  // boot effect (below) unconditionally calls loadMyTeachingAssignments/
  // loadGradeScale, which are meaningless (and wasteful) queries for a
  // higher-ed school. (Tier 8 note: window/component resolution moved INTO
  // the per-class grid load — see loadGrid — so there is nothing school-wide
  // to preload here anymore.) Branching here, before that effect ever
  // runs, avoids firing them at all — same reasoning CourseRegistrationModule/
  // CourseAttendanceModule already apply by being their own top-level modules
  // rather than branches inside a shared one.
  if (isHigherInstitutionSchoolType(schoolType)) {
    return <CourseResultsModule schoolId={schoolId} isAdmin={isAdmin} />
  }

  return <ResultsModuleSecondary schoolId={schoolId} isAdmin={isAdmin} intent={intent} />
}

// ─── Secondary-school path (pre-existing, unmodified below this point) ────────

function ResultsModuleSecondary({ schoolId, isAdmin, intent }: { schoolId: string; isAdmin: boolean; intent?: NavIntent }) {
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
  const [selectedClassNodeId, setSelectedClassNodeId] = useState<string | null>(null)
  const [bootState,      setBootState]      = useState<LoadState>('booting')
  const [bootError,      setBootError]      = useState('')

  // ── Terms ─────────────────────────────────────────────────────────────────
  const [terms,         setTerms]         = useState<Term[]>([])
  const [selectedTerm,  setSelectedTerm]  = useState<Term | null>(null)

  // ── Score components + window (resolved per class+term, Tier 8 / 8.4) ─────
  const [components, setComponents] = useState<ScoreComponent[]>([])
  const [winInfo, setWinInfo] = useState<{ window: AssessmentWindow; windowClass: AssessmentWindowClassRow | null } | null>(null)
  const [resState, setResState] = useState<LoadState>('booting')
  const [resError, setResError] = useState('')

  // ── Mode: score entry vs report cards vs promotion (Session 49 surface) ────
  const canManageRemarks = useAuthStore((s) => s.can('academics.remarks.manage'))
  const [mode, setMode] = useState<'scores' | 'reports' | 'promotion'>('scores')

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

  // ── Promotion (moved from AssessmentsSettings — Session 67) ───────────────
  const [promoPreview, setPromoPreview] = useState<PromotionPreviewRow[]>([])
  const [promoDecisions, setPromoDecisions] = useState<Map<string, PromotionDecision>>(new Map())
  const [promoLoading, setPromoLoading] = useState(false)
  const [promoApplying, setPromoApplying] = useState(false)
  const [promoResult, setPromoResult] = useState<{ promoted: number; retained: number; demoted: number; graduated: number } | null>(null)
  const [promoError, setPromoError] = useState('')
  const [promoClassId, setPromoClassId] = useState<string | null>(null)

  // ── Class-first filter: unique classes, subjects per selected class ─────────
  const uniqueClasses = useMemo(() => {
    const seen = new Map<string, { classNodeId: string; className: string }>()
    for (const a of assignments) {
      if (!seen.has(a.class_node_id)) {
        seen.set(a.class_node_id, { classNodeId: a.class_node_id, className: a.class_node_name })
      }
    }
    return Array.from(seen.values()).sort((a, b) => a.className.localeCompare(b.className))
  }, [assignments])

  const subjectsForClass = useMemo(() => {
    if (!selectedClassNodeId) return []
    return assignments
      .filter(a => a.class_node_id === selectedClassNodeId)
      .sort((a, b) => a.subject_name.localeCompare(b.subject_name))
  }, [assignments, selectedClassNodeId])

  // ── Pill-picker collapse state (matching AttendanceModule.tsx's own
  // two-tier picker precedent — see that file's "Class selector" block).
  // Results only has one real tier of grouping (class → subject, a genuine
  // cascade) rather than Attendance's parent-group/leaf split, so there is
  // no separate "parent pill" row here — just Class pills, then Subject
  // pills once a class is picked, then collapse to one summary bar once
  // both are chosen. Re-expands on tap, same as Attendance's "Change".
  const [resPickerExpanded, setResPickerExpanded] = useState(true)
  const resHasFullSelection = !!selectedClassNodeId && !!selectedAssign
  const resSelectorLabel = selectedAssign
    ? `${selectedAssign.class_node_name} · ${selectedAssign.subject_name}`
    : ''

  function selectResultsClass(classNodeId: string) {
    setSelectedClassNodeId(classNodeId)
    setSelectedAssign(null)
    // Stay expanded — picking a class is only step 1; the subject pills for
    // it need to render right away so the two-step flow feels continuous.
  }

  function selectResultsAssign(a: TeachingAssignment) {
    setSelectedAssign(a)
    setResPickerExpanded(false)
  }

  // Online/offline detection effect is declared further below, after
  // loadGrid() exists — it needs to call loadGrid() on reconnect, see
  // "Online / offline detection" near the offline-queue flush.

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

      const [assignRes, gradeRes] = await Promise.all([
        (canViewAllAssignments || isAdmin)
          ? loadAllTeachingAssignments(sessionRes.data.id)
          : loadMyTeachingAssignments(staffId || '__pending__', sessionRes.data.id),
        loadGradeScale(schoolId),
      ])
      if (cancelled) return

      if (!assignRes.ok) { setBootError(assignRes.error); setBootState('error'); return }
      if (!gradeRes.ok)  { setBootError(gradeRes.error);  setBootState('error'); return }

      setAssignments(assignRes.data)
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

  // ─── Intent: auto-select class+subject for pending approvals ──────────────
  // When navigated here with pendingApprovals intent (e.g. from dashboard
  // action badge), find the first class with unapproved scores and auto-select
  // it so the user lands directly on actionable content.
  useEffect(() => {
    if (!intent?.pendingApprovals || bootState !== 'ready' || assignments.length === 0 || !session) return
    if (selectedClassNodeId) return // already selected, don't override

    let cancelled = false
    async function autoSelectPending() {
      // Find classes that have unapproved scores
      const { data: pendingScores } = await supabase
        .from('scores')
        .select('student_id, subject_id, students!inner(class_node_id)', { count: 'exact' })
        .eq('school_id', schoolId)
        .eq('session_id', session!.id)
        .is('approved_at', null)

      if (cancelled || !pendingScores || pendingScores.length === 0) return

      // Group by class_node_id to find the class with the most pending scores
      const classCounts = new Map<string, number>()
      const classSubjects = new Map<string, Set<string>>()
      for (const row of pendingScores as any[]) {
        const clsId = row.students?.class_node_id
        if (!clsId) continue
        classCounts.set(clsId, (classCounts.get(clsId) ?? 0) + 1)
        if (!classSubjects.has(clsId)) classSubjects.set(clsId, new Set())
        classSubjects.get(clsId)!.add(row.subject_id)
      }

      // Pick the class with the most pending scores
      let bestClass = ''
      let bestCount = 0
      for (const [clsId, count] of classCounts) {
        if (count > bestCount) { bestClass = clsId; bestCount = count }
      }
      if (!bestClass) return

      setSelectedClassNodeId(bestClass)

      // Find the first subject for this class that has a matching assignment
      const subjectsForCls = classSubjects.get(bestClass)
      const matchingAssignment = assignments.find(
        a => a.class_node_id === bestClass && subjectsForCls?.has(a.subject_id)
      )
      if (matchingAssignment) {
        setSelectedAssign(matchingAssignment)
      }
    }
    autoSelectPending()
    return () => { cancelled = true }
  }, [intent, bootState, assignments, session, schoolId, selectedClassNodeId])

  // ─── Load students + scores when assignment / term changes ────────────────

  const loadGrid = useCallback(async () => {
    if (!selectedAssign || !session) return
    setGridState('loading')
    setResState('loading')
    setStudents([])
    setScoreMap(new Map())

    // Tier 8 / Problem 8.4: resolve THE window covering this class+term and
    // load its class-specific component columns. Components are profile-
    // scoped now — there is no school-wide set anymore.
    const winRes = await resolveWindowForClass({
      sessionId: session.id,
      termId:    selectedTerm?.id ?? null,
      classNodeId: selectedAssign.class_node_id,
    })
    if (!winRes.ok) { setResError(winRes.error); setResState('error'); return }
    setWinInfo(winRes.data)

    let comps: ScoreComponent[] = []
    const profileId = winRes.data?.windowClass?.score_component_profile_id
    if (winRes.data && profileId) {
      const compRes = await loadComponents(profileId)
      if (!compRes.ok) { setResError(compRes.error); setResState('error'); return }
      comps = compRes.data
    }
    setComponents(comps)
    setResState('ready')

    const [studentsRes, scoresRes] = await Promise.all([
      loadStudentsForClass(selectedAssign.class_node_id),
      loadScores({
        schoolId,
        classNodeId: selectedAssign.class_node_id,
        subjectId:   selectedAssign.subject_id,
        sessionId:   session.id,
        termId:      selectedTerm?.id ?? null,
      }),
    ])

    if (!studentsRes.ok) { setGridError(studentsRes.error); setGridState('error'); return }
    if (!scoresRes.ok)   { setGridError(scoresRes.error);   setGridState('error'); return }

    const base = buildScoreMap(scoresRes.data)

    // Merge in anything still sitting in the offline queue for this
    // subject/session/term scope — these haven't reached the server yet, so
    // loadScores() above can't see them, but they're real pending writes and
    // must keep showing (with the queued/cloud badge) across a reload rather
    // than vanishing.
    const pending = await getPendingScoresForScope({
      subjectId: selectedAssign.subject_id,
      sessionId: session.id,
      termId:    selectedTerm?.id ?? null,
    })
    const merged: ScoreMap = new Map(base)
    const stillQueued = new Set<string>()
    pending.forEach((score, key) => {
      merged.set(key, score)
      stillQueued.add(key)
    })

    setStudents(studentsRes.data)
    setScoreMap(merged)
    setQueuedKeys(stillQueued)
    setGridState(studentsRes.data.length === 0 ? 'empty' : 'ready')
  }, [selectedAssign, session, selectedTerm])

  useEffect(() => {
    if (selectedAssign && session) loadGrid()
  }, [loadGrid])

  // ─── Online / offline detection ────────────────────────────────────────────

  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true)
      // Fire-and-forget from the browser event's point of view, but the
      // async work inside still runs to completion and updates state when
      // it resolves — this is not discarded, just not blocking the handler.
      void (async () => {
        await flushScoresQueue()
        if (!selectedAssign || !session) return
        // Re-derive queuedKeys/scoreMap from what's still actually pending
        // rather than assuming the flush cleared everything: some items can
        // fail (e.g. reconnected briefly, one row hit a real server error)
        // and must keep showing the queued badge; anything that DID sync
        // needs its badge cleared and, since it's no longer in the queue,
        // will now come from the next loadGrid()/server read instead.
        const stillPending = await getPendingScoresForScope({
          subjectId: selectedAssign.subject_id,
          sessionId: session.id,
          termId:    selectedTerm?.id ?? null,
        })
        setQueuedKeys(new Set(stillPending.keys()))
        // Refresh from the server so newly-synced rows (and their real
        // server ids) replace the placeholder queued entries in scoreMap.
        await loadGrid()
      })()
    }
    const handleOffline = () => setIsOnline(false)
    window.addEventListener('online',  handleOnline)
    window.addEventListener('offline', handleOffline)
    return () => {
      window.removeEventListener('online',  handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [selectedAssign, session, selectedTerm, loadGrid])

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
    if (isNaN(numValue) || numValue < 0 || numValue > component.max_score) return

    // Tier 8: entry is only permitted while the covering window is open —
    // mirrored server-side by the scores trigger; this guard just avoids
    // a doomed round trip and shows the reason immediately.
    if (winInfo && winInfo.window.status !== 'open') {
      setErrorKeys(prev => new Map(prev).set(key,
        winInfo.window.status === 'draft'
          ? 'Score entry has not opened yet for this assessment.'
          : 'Score entry is closed for this assessment.'))
      const timer = setTimeout(() => {
        setErrorKeys(prev => { const n = new Map(prev); n.delete(key); return n })
        errorTimers.current.delete(key)
      }, 3000)
      if (errorTimers.current.has(key)) clearTimeout(errorTimers.current.get(key)!)
      errorTimers.current.set(key, timer)
      return
    }

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
  }, [selectedAssign, session, selectedTerm, staffId, schoolId, scoreMap, canForClass, winInfo])

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
  // Entry is only possible while the covering window is open — the DB trigger
  // enforces it; this drives the read-only rendering and banner copy.
  const windowOpen       = winInfo?.window.status === 'open'
  const canUseApproveBar = !!winInfo && (winInfo.window.status === 'open' || winInfo.window.status === 'closed')

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
    // Collapsed summary bar — same pattern and classnames as
    // AttendanceModule.tsx's .att-selector-summary, once both a class and a
    // subject are picked and the picker isn't explicitly reopened.
    if (resHasFullSelection && !resPickerExpanded) {
      return (
        <div className="res-selector-wrap">
          <button
            type="button"
            className="att-selector-summary"
            onClick={() => setResPickerExpanded(true)}
          >
            <span className="att-selector-summary-label">{resSelectorLabel}</span>
            <span className="att-selector-summary-change">
              Change <Icon name="chevron-down" size={14} />
            </span>
          </button>
        </div>
      )
    }

    return (
      <div className="res-selector-wrap">
        <label className="att-selector-label">Class</label>
        <div className="att-pill-row att-pill-row--class">
          {uniqueClasses.map(c => (
            <button
              key={c.classNodeId}
              type="button"
              className={`att-pill${selectedClassNodeId === c.classNodeId ? ' att-pill--active' : ''}`}
              onClick={() => selectResultsClass(c.classNodeId)}
            >
              {c.className}
            </button>
          ))}
        </div>

        {selectedClassNodeId && (
          <>
            <label className="att-selector-label">Subject</label>
            {subjectsForClass.length === 0 ? (
              <p className="res-empty-sub">No subjects assigned for this class yet.</p>
            ) : (
              <div className="att-pill-row att-pill-row--class">
                {subjectsForClass.map(a => (
                  <button
                    key={a.id}
                    type="button"
                    className={`att-pill${selectedAssign?.id === a.id ? ' att-pill--active' : ''}`}
                    onClick={() => selectResultsAssign(a)}
                  >
                    {a.subject_name}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
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
    // No covering window, or one that is draft/finalized: the server trigger
    // refuses approval writes — don't render a control that cannot work.
    if (!canUseApproveBar) return null

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
            max={component.max_score}
            step={0.5}
            defaultValue={score?.value ?? ''}
            readOnly={isLocked || isSaving || !canEdit || !windowOpen}
            onBlur={e  => handleScoreSave(student, component, e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
            aria-label={`${student.full_name} — ${component.name}`}
            title={!windowOpen
              ? (winInfo?.window.status === 'draft'
                  ? 'Score entry has not opened yet for this assessment'
                  : 'Score entry is closed for this assessment')
              : !canEdit ? 'You do not have permission to enter scores for this class' : undefined}
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

  function renderWindowBanner() {
    if (!selectedAssign || resState === 'booting') return null
    if (resState === 'loading') {
      return <div className="res-win-banner-skel skeleton" />
    }
    if (resState === 'error') {
      return (
        <div className="res-error-state">
          <span className="res-error-icon"><Icon name="alert-triangle" style={{ color: 'var(--color-warning, #d97706)' }} /></span>
          <p className="res-error-msg">{resError}</p>
          <button className="res-retry-btn" onClick={loadGrid}>Retry</button>
        </div>
      )
    }

    // No covering window at all — the actionable empty state (§4.3). This is
    // exactly Problem 8.3's original symptom, now explained instead of silent.
    if (!winInfo) {
      return (
        <div className="res-win-banner res-win-banner--none">
          <span className="res-win-icon"><Icon name="calendar" size={16} /></span>
          <div className="res-win-copy">
            <p className="res-win-title">
              No assessment window covers {selectedAssign.class_node_name}{selectedTerm ? ` — ${selectedTerm.name}` : ''} yet.
            </p>
            <p className="res-win-sub">
              {isAdmin
                ? 'Create one in Settings > Assessments to open score entry for this class.'
                : 'Ask your administrator to set up an assessment window first.'}
            </p>
          </div>
        </div>
      )
    }

    const w = winInfo.window
    if (w.status !== 'open') {
      return (
        <div className={`res-win-banner res-win-banner--${w.status}`}>
          <span className="res-win-icon"><Icon name={w.status === 'draft' ? 'clock' : 'lock'} size={16} /></span>
          <div className="res-win-copy">
            <p className="res-win-title">{w.name} · {w.status}</p>
            <p className="res-win-sub">
              {w.status === 'draft'
                ? 'Score entry opens once this assessment is opened.'
                : w.status === 'closed'
                  ? 'Score entry has closed. Results can still be approved, then finalized.'
                  : 'This assessment is finalized — scores are read-only.'}
            </p>
          </div>
        </div>
      )
    }

    // Open — but surface a misconfigured weighting rather than letting bad
    // totals ship silently (the old schema comment's "app enforces = 100").
    const weightSum = components.reduce((acc, c) => acc + c.weight_pct, 0)
    const deadline = w.scores_submission_deadline
      ? new Date(w.scores_submission_deadline)
      : null
    const deadlineLabel = deadline
      ? deadline.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : null
    return (
      <div>
        <div className="res-win-banner res-win-banner--open res-win-banner--prominent">
          <span className="res-win-icon"><Icon name="circle-check" size={20} style={{ color: 'var(--color-success, #16a34a)' }} /></span>
          <div className="res-win-copy">
            <p className="res-win-title res-win-title--lg">{w.name}</p>
            <p className="res-win-sub">
              Score entry is open
              {deadlineLabel && <> — submission deadline {deadlineLabel}</>}
              {winInfo.windowClass && winInfo.window.scope === 'selected_classes'
                ? <> for {selectedAssign.class_node_name}</>
                : ''}
              .
            </p>
          </div>
        </div>
        {components.length > 0 && Math.abs(weightSum - 100) > 0.01 && (
          <p className="res-weight-warn">
            <Icon name="alert-triangle" size={13} style={{ color: 'var(--color-warning, #d97706)' }} />
            {' '}Component weights total {weightSum}% — expected 100%.
          </p>
        )}
      </div>
    )
  }

  function renderGrid() {
    if (!selectedAssign) {
      return (
        <div className="res-empty-state res-empty-state--prompt">
          <span className="res-empty-icon"><Icon name="bar-chart" /></span>
          <p className="res-empty-msg">Select a class and subject above to enter scores.</p>
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

    // Window not open → render the grid read-only (values visible, nothing
    // editable) rather than hiding it — admins reviewing a closed window
    // still need to see what was entered.
    const gridReadonly = !windowOpen

    return (
      <div className={['res-table-wrap', gridReadonly ? 'res-table-wrap--readonly' : ''].join(' ')}>
        <table className="res-table">
          <thead>
            <tr>
              <th className="res-th res-th--name">Student</th>
              {components.map(c => (
                <th key={c.id} className="res-th res-th--component">
                  <span className="res-th-name">{c.name}</span>
                  <span className="res-th-weight">{c.weight_pct}% · /{c.max_score}</span>
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

        {/* Assignment selector — hidden in promotion AND reports mode (both
            have their own class picker; reports also drops the subject
            dimension entirely per the owner's explicit request — Session 81). */}
        {mode !== 'promotion' && mode !== 'reports' && renderAssignmentSelector()}

        {/* Term tabs — only when school uses terms; hidden in promotion/reports for the same reason as above */}
        {mode !== 'promotion' && mode !== 'reports' && selectedAssign && renderTermSelector()}

        {/* Mode switcher — report cards need a window + remark permission */}
        {(isAdmin || canManageRemarks) && (
          <div className="res-mode-tabs" role="tablist">
            <button
              role="tab"
              aria-selected={mode === 'scores'}
              className={['res-mode-tab', mode === 'scores' ? 'res-mode-tab--active' : ''].join(' ')}
              onClick={() => setMode('scores')}
            >
              <Icon name="pencil" size={14} /> Enter scores
            </button>
            <button
              role="tab"
              aria-selected={mode === 'reports'}
              className={['res-mode-tab', mode === 'reports' ? 'res-mode-tab--active' : ''].join(' ')}
              onClick={() => setMode('reports')}
            >
              <Icon name="file-text" size={14} /> Report cards
            </button>
            {isAdmin && (
              <button
                role="tab"
                aria-selected={mode === 'promotion'}
                className={['res-mode-tab', mode === 'promotion' ? 'res-mode-tab--active' : ''].join(' ')}
                onClick={() => setMode('promotion')}
              >
                <Icon name="arrow-up-circle" size={14} /> Promotion
              </button>
            )}
          </div>
        )}

        {/* Approve / un-approve bar (scores mode only) */}
        {mode === 'scores' && renderApproveBar()}
      </div>

      {/* Body */}
      <div className="res-body">
        {mode === 'promotion' && isAdmin ? (
          <PromotionPanel
            session={session}
            selectedTerm={selectedTerm}
            staffId={staffId}
            uniqueClasses={uniqueClasses}
            promoPreview={promoPreview}
            setPromoPreview={setPromoPreview}
            promoDecisions={promoDecisions}
            setPromoDecisions={setPromoDecisions}
            promoLoading={promoLoading}
            setPromoLoading={setPromoLoading}
            promoApplying={promoApplying}
            setPromoApplying={setPromoApplying}
            promoResult={promoResult}
            setPromoResult={setPromoResult}
            promoError={promoError}
            setPromoError={setPromoError}
            promoClassId={promoClassId}
            setPromoClassId={setPromoClassId}
          />
        ) : mode === 'reports' && (isAdmin || canManageRemarks) ? (
          <ReportCardsPanel
            schoolId={schoolId}
            isAdmin={isAdmin}
          />
        ) : (
          <>
            {/* Window state banner — explains WHY the grid is/isn't editable */}
            {renderWindowBanner()}
            {renderGrid()}
          </>
        )}
      </div>
    </div>
  )
}

// ─── Promotion Panel (moved from AssessmentsSettings — Session 67) ──────────
// Only the "Run promotion" action lives here. Rule CRUD stays in Settings.

function PromotionPanel({
  session,
  selectedTerm,
  staffId,
  uniqueClasses,
  promoPreview,
  setPromoPreview,
  promoDecisions,
  setPromoDecisions,
  promoLoading,
  setPromoLoading,
  promoApplying,
  setPromoApplying,
  promoResult,
  setPromoResult,
  promoError,
  setPromoError,
  promoClassId,
  setPromoClassId,
}: {
  session: Session | null
  selectedTerm: Term | null
  staffId: string
  uniqueClasses: { classNodeId: string; className: string }[]
  promoPreview: PromotionPreviewRow[]
  setPromoPreview: (rows: PromotionPreviewRow[]) => void
  promoDecisions: Map<string, PromotionDecision>
  setPromoDecisions: (fn: (prev: Map<string, PromotionDecision>) => Map<string, PromotionDecision>) => void
  promoLoading: boolean
  setPromoLoading: (v: boolean) => void
  promoApplying: boolean
  setPromoApplying: (v: boolean) => void
  promoResult: { promoted: number; retained: number; demoted: number; graduated: number } | null
  setPromoResult: (r: { promoted: number; retained: number; demoted: number; graduated: number } | null) => void
  promoError: string
  setPromoError: (e: string) => void
  promoClassId: string | null
  setPromoClassId: (id: string | null) => void
}) {
  const [promoTermId, setPromoTermId] = useState<string | null>(selectedTerm?.id ?? null)

  useEffect(() => {
    setPromoTermId(selectedTerm?.id ?? null)
  }, [selectedTerm])

  async function loadPreview() {
    if (!session || !promoClassId) return
    setPromoLoading(true)
    setPromoResult(null)
    setPromoError('')
    const res = await previewPromotion({
      sessionId: session.id,
      termId: promoTermId,
      fromClassNodeId: promoClassId,
    })
    setPromoLoading(false)
    if (!res.ok) { setPromoError(res.error); return }
    setPromoPreview(res.data)
  }

  async function handleApply() {
    if (!session || !staffId || promoPreview.length === 0) return
    const payload: PromotionDecision[] = promoPreview.map(r => {
      const dec = promoDecisions.get(r.student_id)
      return {
        student_id: r.student_id,
        action: dec?.action ?? (r.suggested === 'promote' ? 'promote' : 'retain'),
        mode: 'manual' as const,
        to_class_node_id: dec?.to_class_node_id,
      }
    })
    const promotes = payload.filter(d => d.action === 'promote').length
    const retains = payload.filter(d => d.action === 'retain').length
    const demotes = payload.filter(d => d.action === 'demote').length
    if (!confirm(`Apply now? ${promotes} promoted, ${retains} retained, ${demotes} demoted.`)) return

    setPromoApplying(true)
    const res = await applyPromotions({
      sessionId: session.id,
      fromClassNodeId: promoClassId!,
      decisions: payload,
      decidedBy: staffId,
    })
    setPromoApplying(false)
    if (!res.ok) { setPromoError(res.error); return }
    setPromoResult(res.data)
    setPromoPreview([])
  }

  if (!session) {
    return (
      <div className="res-win-banner res-win-banner--none">
        <span className="res-win-icon"><Icon name="calendar" size={16} /></span>
        <div className="res-win-copy">
          <p className="res-win-title">No active session</p>
          <p className="res-win-sub">Cannot run promotion without a current session.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="res-promo-panel">
      <div className="res-win-banner res-win-banner--none" style={{ marginBottom: 'var(--space-4)' }}>
        <span className="res-win-icon"><Icon name="arrow-up-circle" size={16} /></span>
        <div className="res-win-copy">
          <p className="res-win-title">Run Promotion</p>
          <p className="res-win-sub">
            Preview promotion outcomes for a class, adjust decisions, then apply.
            Rules are configured in Settings &gt; Assessments.
          </p>
        </div>
      </div>

      {promoError && (
        <div className="res-win-banner" style={{ borderColor: 'var(--color-error, #dc2626)', background: 'var(--color-error-subtle, #fef2f2)', marginBottom: 'var(--space-3)' }}>
          <span className="res-win-icon"><Icon name="alert-triangle" size={16} style={{ color: 'var(--color-error, #dc2626)' }} /></span>
          <div className="res-win-copy">
            <p className="res-win-title" style={{ color: 'var(--color-error, #dc2626)' }}>{promoError}</p>
          </div>
        </div>
      )}

      {promoResult && (
        <div className="res-win-banner res-win-banner--open" style={{ marginBottom: 'var(--space-3)' }}>
          <span className="res-win-icon"><Icon name="circle-check" size={16} style={{ color: 'var(--color-success, #16a34a)' }} /></span>
          <div className="res-win-copy">
            <p className="res-win-title">
              Done — {promoResult.promoted} promoted ({promoResult.graduated} graduated), {promoResult.retained} retained, {promoResult.demoted} demoted.
            </p>
          </div>
        </div>
      )}

      <div className="res-promo-form">
        <div className="res-selector-group" style={{ maxWidth: 280 }}>
          <label className="res-selector-label">Class to promote</label>
          <select
            className="res-selector"
            value={promoClassId ?? ''}
            onChange={e => { setPromoClassId(e.target.value || null); setPromoPreview([]) }}
          >
            <option value="">— pick a class —</option>
            {uniqueClasses.map(c => (
              <option key={c.classNodeId} value={c.classNodeId}>{c.className}</option>
            ))}
          </select>
        </div>

        <button
          className="btn btn-primary"
          onClick={loadPreview}
          disabled={!promoClassId || promoLoading}
          style={{ alignSelf: 'flex-end' }}
        >
          {promoLoading ? 'Loading…' : 'Load preview'}
        </button>
      </div>

      {promoPreview.length > 0 && (
        <div className="res-promo-results">
          <p className="res-promo-count">{promoPreview.length} students</p>
          {promoPreview.map(r => {
            const dec = promoDecisions.get(r.student_id)
            const effective = dec?.action ?? (r.suggested === 'promote' ? 'promote' : 'retain')
            return (
              <div key={r.student_id} className="res-promo-row">
                <div className="res-promo-row-main">
                  <p className="res-promo-name">{r.full_name}</p>
                  <p className="res-promo-meta">
                    {r.average !== null ? `Avg ${r.average.toFixed(1)}` : 'No results'}
                    {' · '}
                    {r.to_class_name ?? (r.graduating ? 'Graduates' : '—')}
                    {' · '}
                    {r.reason}
                  </p>
                </div>
                <select
                  className="res-selector res-promo-decision"
                  value={effective}
                  onChange={e => setPromoDecisions(prev => {
                    const next = new Map(prev)
                    next.set(r.student_id, {
                      student_id: r.student_id,
                      action: e.target.value as 'promote' | 'retain' | 'demote',
                      mode: 'manual',
                      to_class_node_id: prev.get(r.student_id)?.to_class_node_id,
                    })
                    return next
                  })}
                >
                  <option value="promote">Promote{r.suggested === 'promote' ? ' ✓' : ''}</option>
                  <option value="retain">Retain{r.suggested === 'review' ? ' ✓' : ''}</option>
                  <option value="demote">Demote</option>
                </select>
              </div>
            )
          })}
          <button
            className="btn btn-primary"
            onClick={handleApply}
            disabled={promoApplying || !staffId}
            style={{ marginTop: 'var(--space-3)' }}
          >
            {promoApplying ? 'Applying…' : 'Apply promotion'}
          </button>
          <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', marginTop: 'var(--space-2)' }}>
            Senior classes first — a destination class still holding undecided students blocks the run.
          </p>
        </div>
      )}
    </div>
  )
}
