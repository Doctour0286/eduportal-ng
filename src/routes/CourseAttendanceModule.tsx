/**
 * CourseAttendanceModule.tsx
 * Per-course attendance register for lecturers/admins — higher-ed track.
 * PRD Tier 8 / Problem 8.7, SESSION 58.
 *
 * Deliberately NOT a copy of AttendanceModule.tsx's full feature set. This
 * mirrors ONLY what SESSION 58's card actually asks for: offering picker →
 * register (computed live from course_registrations) → optimistic
 * mark/batch-mark → offline queue → eligibility %. The secondary-school
 * module's whole-school analytics panel, two-tier parent/class picker,
 * history strip, and after-hours edit lock are all out of scope here — none
 * of them were asked for, and course_attendance_records has no equivalent
 * "school hours end" concept to lock against. Adding them speculatively
 * would be scope creep, not reuse.
 *
 * What IS reused, exactly as-is, per the card's explicit instruction:
 *   - Optimistic-update → saving-id → background-write → revert-on-failure
 *     -with-3s-badge → offline-queue shape, ported from handleStatusTap()/
 *     handleBatchMark() in AttendanceModule.tsx.
 *   - isSchoolDay() (imported via courseAttendanceService.ts, which itself
 *     imports it from attendanceService.ts — not reimplemented anywhere)
 *     gates ensureCourseAttendanceSession(), refusing to open a session on
 *     a non-school day. Failure to reach this check at all (network error
 *     on the isSchoolDay query) fails open, matching attendanceService.ts's
 *     own stated convention — a hard block on a service hiccup would be
 *     worse than a rare false-positive session open.
 *   - marked_by sourced from useAuthStore's actorRecordId (staff.id), NOT
 *     supabase.auth.getUser() — the exact bug attendanceService.ts's header
 *     documents fixing once already; not repeating it here.
 *
 * Permissions: academics.course_attendance.mark gates marking (useAuthStore's
 * can()). Lacking it shows a visible notice, not a silently-disabled button
 * (§4.3 — same convention as AttendanceModule.tsx).
 *
 * Register composition: computed live from course_registrations for the
 * selected offering (status <> 'withdrawn') via loadRegisteredStudents() —
 * never stored redundantly, per §7.27.3's own design note.
 *
 * Eligibility %: informational only this session, not wired to block exam
 * entry — exactly as SESSION 58's card states. Shown per-student in the
 * register (lecturer view) via a small badge, computed by
 * loadAttendanceEligibility().
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { useAuthStore } from '../stores/authStore'
import { Icon } from '../components/icons'
import {
  loadCourseOfferingsForStaff,
  loadRegisteredStudents,
  loadCourseAttendanceSessions,
  ensureCourseAttendanceSession,
  loadCourseAttendanceRecords,
  saveCourseAttendanceRecord,
  saveBatchCourseAttendance,
  flushCourseAttendanceQueue,
  loadAttendanceEligibility,
  buildCourseAttendanceMap,
  getCourseAttendanceSummary,
  type CourseOffering,
  type RegisteredStudent,
  type CourseAttendanceSession,
  type CourseAttendanceMap,
  type CourseAttendanceStatus,
  type CourseAttendanceEligibility,
  type CourseAttendanceUpsertParams,
} from '../services/courseAttendanceService'
// loadCurrentSession is a general session lookup, not attendance-specific —
// attendanceService.ts's own header notes it's "duplicated here so
// AttendanceModule has one import source," identical to timetableService's
// version. Reused directly rather than re-implemented, and rather than
// asking App.tsx's TabContent to thread a sessionId prop no other route in
// this codebase currently needs to pass down (AttendanceModule.tsx and
// CourseRegistrationModule.tsx both resolve their own current session
// internally the same way).
import { loadCurrentSession } from '../services/attendanceService'

// ─── Props ──────────────────────────────────────────────────────────────────

interface CourseAttendanceModuleProps {
  schoolId: string
  isAdmin: boolean
  schoolType: string | null | undefined
}

// Same higher-ed set App.tsx's own isHigherEd check uses (MoreSheetContent) —
// duplicated here as CourseRegistrationModule's own local copy already is,
// since it's not exported from anywhere shared. This is the actual
// defense-in-depth gate the App.tsx TabContent comment for course_attendance
// refers to — the nav entry hides the link via isHigherEd, but the route
// itself had no second gate until this. Without it, stale nav state or a
// deep link could land a secondary-school context here, where
// course_offerings queries would just come back empty with no explanation
// of why, rather than the honest "not available for this school type"
// message this gate now gives instead.
function isHigherInstitutionSchoolType(schoolType: string | null | undefined): boolean {
  return !!schoolType && ['university', 'polytechnic', 'college_of_education', 'other'].includes(schoolType)
}

// ─── Load state machine ────────────────────────────────────────────────────

type LoadState = 'booting' | 'ready' | 'loading' | 'empty' | 'error'

// ─── Status display config ─────────────────────────────────────────────────
// Same visual language as AttendanceModule.tsx's STATUS_CONFIG — reusing the
// existing .att-btn--* tokens directly rather than inventing parallel ones,
// since these are generic status colors, not secondary-attendance-specific.

const STATUS_CONFIG: Record<CourseAttendanceStatus, { label: string; short: string; cls: string }> = {
  present: { label: 'Present', short: 'P', cls: 'att-btn--present' },
  absent:  { label: 'Absent',  short: 'A', cls: 'att-btn--absent'  },
  excused: { label: 'Excused', short: 'E', cls: 'att-btn--excused' },
  late:    { label: 'Late',    short: 'L', cls: 'att-btn--late'    },
}

const STATUS_ORDER: CourseAttendanceStatus[] = ['present', 'absent', 'excused', 'late']

function todayDateString(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function CourseAttendanceModule({ schoolId, isAdmin, schoolType }: CourseAttendanceModuleProps) {
  const actorRecordId = useAuthStore(s => s.actorRecordId)
  const canMark = useAuthStore(s => s.can('academics.course_attendance.mark'))
  const markedBy = actorRecordId ?? null

  // Defense-in-depth gate — see isHigherInstitutionSchoolType's comment
  // above. Checked before any data loading starts, not just at render time,
  // so a secondary-school context never fires a single course_offerings
  // query in the first place.
  const isHigherEd = isHigherInstitutionSchoolType(schoolType)

  // ── Current session — resolved internally, matching AttendanceModule.tsx's
  // own boot pattern via the same loadCurrentSession() (attendanceService.ts).
  // Offerings can't load until this resolves, so offeringsState stays
  // 'booting' until sessionId is set (see the boot effect below).
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [sessionErr, setSessionErr] = useState<string>('')

  // ── Offering picker ────────────────────────────────────────────────────
  const [offerings, setOfferings] = useState<CourseOffering[]>([])
  const [offeringsState, setOfferingsState] = useState<LoadState>('booting')
  const [offeringsErr, setOfferingsErr] = useState<string>('')
  const [selectedOffering, setSelectedOffering] = useState<CourseOffering | null>(null)
  const [pickerExpanded, setPickerExpanded] = useState(true)

  // ── Register (registered students for the selected offering) ─────────
  const [students, setStudents] = useState<RegisteredStudent[]>([])
  const [studentsState, setStudentsState] = useState<LoadState>('ready')
  const [studentsErr, setStudentsErr] = useState<string>('')

  // ── Session picker (which contact-hour date) ───────────────────────────
  const [existingSessions, setExistingSessions] = useState<CourseAttendanceSession[]>([])
  const [selectedDate, setSelectedDate] = useState<string>(todayDateString())
  const [activeSession, setActiveSession] = useState<CourseAttendanceSession | null>(null)
  const [sessionOpenErr, setSessionOpenErr] = useState<string>('')
  const [sessionOpening, setSessionOpening] = useState(false)

  // ── Attendance marks for the active session ────────────────────────────
  const [attMap, setAttMap] = useState<CourseAttendanceMap>(new Map())
  const [recordsState, setRecordsState] = useState<LoadState>('ready')
  const [recordsErr, setRecordsErr] = useState<string>('')

  // ── Optimistic / offline state — mirrors AttendanceModule.tsx exactly ──
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set())
  const [errorIds, setErrorIds] = useState<Map<string, string>>(new Map())
  const [queuedIds, setQueuedIds] = useState<Set<string>>(new Set())
  const [isOnline, setIsOnline] = useState<boolean>(true)
  const errorTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const [batchSaving, setBatchSaving] = useState(false)

  // ── Eligibility (per student, lazily computed) ──────────────────────────
  const [eligibility, setEligibility] = useState<Map<string, CourseAttendanceEligibility>>(new Map())
  const [eligibilityLoading, setEligibilityLoading] = useState<Set<string>>(new Set())

  // ─── Boot: current session ────────────────────────────────────────────────

  useEffect(() => {
    if (!isHigherEd) return
    let cancelled = false

    async function boot() {
      const result = await loadCurrentSession()
      if (cancelled) return
      if (!result.ok || !result.sessionId) {
        setOfferingsState('error')
        setSessionErr(result.error ?? 'No current session found.')
        return
      }
      setSessionId(result.sessionId)
    }

    boot()
    return () => { cancelled = true }
  }, [isHigherEd])

  // ─── Boot: offerings for this staff member (or all, if admin) ───────────
  // Waits on sessionId resolving above — course_offerings is keyed to a
  // session, same tuple loadRegisteredStudents() itself matches against.

  useEffect(() => {
    if (!sessionId) return
    if (!actorRecordId && !isAdmin) return
    let cancelled = false

    async function loadOfferings() {
      setOfferingsState('loading')
      const result = await loadCourseOfferingsForStaff({
        schoolId,
        staffId: actorRecordId ?? '',
        isAdmin,
        sessionId: sessionId!,
      })
      if (cancelled) return
      if (!result.ok) {
        setOfferingsState('error')
        setOfferingsErr(result.error)
        return
      }
      setOfferings(result.data)
      setOfferingsState(result.data.length === 0 ? 'empty' : 'ready')
    }

    loadOfferings()
    return () => { cancelled = true }
  }, [schoolId, actorRecordId, isAdmin, sessionId])

  // ─── Online / offline detection — mirrors AttendanceModule.tsx exactly ──

  useEffect(() => {
    const handleOnline = () => { setIsOnline(true); flushCourseAttendanceQueue() }
    const handleOffline = () => setIsOnline(false)
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])

  // ─── Load register when an offering is selected ──────────────────────────

  useEffect(() => {
    if (!selectedOffering) {
      setStudents([])
      return
    }
    let cancelled = false

    async function loadRegister() {
      setStudentsState('loading')
      const result = await loadRegisteredStudents(selectedOffering!.id)
      if (cancelled) return
      if (!result.ok) {
        setStudentsState('error')
        setStudentsErr(result.error)
        return
      }
      setStudents(result.data)
      setStudentsState(result.data.length === 0 ? 'empty' : 'ready')
    }

    loadRegister()
    return () => { cancelled = true }
  }, [selectedOffering])

  // ─── Load existing sessions (date list) when an offering is selected ────

  useEffect(() => {
    if (!selectedOffering) {
      setExistingSessions([])
      return
    }
    let cancelled = false

    async function loadSessions() {
      const result = await loadCourseAttendanceSessions(selectedOffering!.id)
      if (cancelled) return
      if (result.ok) setExistingSessions(result.data)
    }

    loadSessions()
    return () => { cancelled = true }
  }, [selectedOffering])

  // ─── Open (get-or-create) the session for selectedDate ───────────────────
  // Refuses on a non-school day — isSchoolDay() reused as-is via
  // courseAttendanceService.ts. A failure to even reach that check (network
  // error) surfaces as sessionOpenErr rather than silently blocking, so the
  // lecturer sees an actionable message instead of a mysterious no-op.

  useEffect(() => {
    if (!selectedOffering) {
      setActiveSession(null)
      return
    }
    let cancelled = false

    async function openSession() {
      setSessionOpening(true)
      setSessionOpenErr('')
      setActiveSession(null)
      setAttMap(new Map())

      const result = await ensureCourseAttendanceSession({
        courseOfferingId: selectedOffering!.id,
        date: selectedDate,
        schoolId,
      })
      if (cancelled) return
      setSessionOpening(false)

      if (!result.ok) {
        setSessionOpenErr(result.error)
        return
      }
      setActiveSession(result.data)
    }

    openSession()
    return () => { cancelled = true }
  }, [selectedOffering, selectedDate, schoolId])

  // ─── Load marks for the active session ────────────────────────────────────

  useEffect(() => {
    if (!activeSession) return
    let cancelled = false

    async function loadRecords() {
      setRecordsState('loading')
      const result = await loadCourseAttendanceRecords(activeSession!.id)
      if (cancelled) return
      if (!result.ok) {
        setRecordsState('error')
        setRecordsErr(result.error)
        return
      }
      setAttMap(buildCourseAttendanceMap(result.data))
      setRecordsState('ready')
    }

    loadRecords()
    return () => { cancelled = true }
  }, [activeSession])

  // ─── Optimistic status tap — mirrors handleStatusTap() exactly ──────────

  const handleStatusTap = useCallback(async (
    student: RegisteredStudent,
    status: CourseAttendanceStatus,
    markedByStaffId: string,
  ) => {
    if (!activeSession) return

    const key = student.student_id
    const current = attMap.get(key)
    if (current?.status === status) return

    // 1. Optimistic update
    const optimisticRecord = {
      id: current?.id ?? crypto.randomUUID(),
      course_attendance_session_id: activeSession.id,
      student_id: student.student_id,
      status,
      marked_by: markedByStaffId,
    }
    setAttMap(prev => {
      const next = new Map(prev)
      next.set(key, optimisticRecord)
      return next
    })

    // 2. Mark as saving
    setSavingIds(prev => new Set(prev).add(key))

    // 3. Background write
    const params: CourseAttendanceUpsertParams = {
      courseAttendanceSessionId: activeSession.id,
      studentId: student.student_id,
      markedBy: markedByStaffId,
      status,
    }

    const result = await saveCourseAttendanceRecord(params)

    setSavingIds(prev => {
      const next = new Set(prev)
      next.delete(key)
      return next
    })

    if (result.queued) {
      setQueuedIds(prev => new Set(prev).add(key))
      return
    }

    if (!result.ok) {
      // Revert optimistic update
      setAttMap(prev => {
        const next = new Map(prev)
        if (current) next.set(key, current)
        else next.delete(key)
        return next
      })
      setErrorIds(prev => new Map(prev).set(key, result.error ?? 'Save failed'))
      if (errorTimers.current.has(key)) {
        clearTimeout(errorTimers.current.get(key)!)
      }
      const timer = setTimeout(() => {
        setErrorIds(prev => {
          const next = new Map(prev)
          next.delete(key)
          return next
        })
        errorTimers.current.delete(key)
      }, 3000)
      errorTimers.current.set(key, timer)
    }
  }, [activeSession, attMap])

  // ─── Batch mark-all — mirrors handleBatchMark() exactly ──────────────────

  const handleBatchMark = useCallback(async (status: CourseAttendanceStatus, markedByStaffId: string) => {
    if (!activeSession || students.length === 0) return

    setBatchSaving(true)

    const targets = students.filter(s => attMap.get(s.student_id)?.status !== status)

    // Optimistic update for every target
    setAttMap(prev => {
      const next = new Map(prev)
      for (const s of targets) {
        next.set(s.student_id, {
          id: next.get(s.student_id)?.id ?? crypto.randomUUID(),
          course_attendance_session_id: activeSession.id,
          student_id: s.student_id,
          status,
          marked_by: markedByStaffId,
        })
      }
      return next
    })

    const result = await saveBatchCourseAttendance({
      records: targets.map(s => ({
        courseAttendanceSessionId: activeSession.id,
        studentId: s.student_id,
        markedBy: markedByStaffId,
        status,
      })),
    })

    setBatchSaving(false)

    if (result.queued) {
      setQueuedIds(prev => {
        const next = new Set(prev)
        targets.forEach(s => next.add(s.student_id))
        return next
      })
      return
    }

    if (!result.ok) {
      setRecordsErr(result.error ?? 'Batch save failed')
    }
  }, [activeSession, students, attMap])

  // ─── Eligibility: load on demand for a student row ────────────────────────

  const loadEligibilityFor = useCallback(async (studentId: string) => {
    if (!selectedOffering || eligibility.has(studentId) || eligibilityLoading.has(studentId)) return
    setEligibilityLoading(prev => new Set(prev).add(studentId))
    const result = await loadAttendanceEligibility({
      courseOfferingId: selectedOffering.id,
      studentId,
    })
    setEligibilityLoading(prev => {
      const next = new Set(prev)
      next.delete(studentId)
      return next
    })
    if (result.ok) {
      setEligibility(prev => new Map(prev).set(studentId, result.data))
    }
  }, [selectedOffering, eligibility, eligibilityLoading])

  // Load eligibility for every visible student once the register is ready —
  // informational display, not gating anything (per the card's "informational
  // only this session" instruction).
  useEffect(() => {
    if (studentsState !== 'ready') return
    students.forEach(s => loadEligibilityFor(s.student_id))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studentsState, students])

  const summary = getCourseAttendanceSummary(attMap)
  const unmarkedCount = Math.max(0, students.length - summary.total)

  // ─── Render: offering picker ────────────────────────────────────────────

  function renderOfferingPicker() {
    if (offeringsState === 'booting' || offeringsState === 'loading') {
      return <div className="att-register-skel" aria-hidden="true" />
    }
    if (offeringsState === 'error') {
      return (
        <div className="att-error-state">
          <span className="att-error-icon"><Icon name="alert-triangle" size={32} style={{ color: 'var(--color-warning, #d97706)' }} /></span>
          <p className="att-error-msg">{sessionErr || offeringsErr || 'Failed to load course offerings.'}</p>
        </div>
      )
    }
    if (offeringsState === 'empty') {
      return (
        <div className="att-empty-state">
          <span className="att-empty-icon"><Icon name="book-open" size={28} /></span>
          <p className="att-empty-msg">No course offerings assigned to you yet.</p>
          <p className="att-empty-sub">Offerings appear here once you're assigned as lecturer for a course.</p>
        </div>
      )
    }

    if (selectedOffering && !pickerExpanded) {
      return (
        <button className="catt-picker-summary" onClick={() => setPickerExpanded(true)}>
          <span className="catt-picker-summary-code">{selectedOffering.course_code}</span>
          <span className="catt-picker-summary-title">{selectedOffering.course_title}</span>
          <Icon name="chevron-down" size={16} />
        </button>
      )
    }

    return (
      <div className="att-pill-row">
        {offerings.map(o => (
          <button
            key={o.id}
            className={['att-pill', selectedOffering?.id === o.id ? 'att-pill--active' : ''].join(' ')}
            onClick={() => {
              setSelectedOffering(o)
              setPickerExpanded(false)
            }}
          >
            <span className="catt-pill-code">{o.course_code}</span> {o.course_title}
            {isAdmin && o.staff_name && <span className="catt-pill-staff"> · {o.staff_name}</span>}
          </button>
        ))}
      </div>
    )
  }

  // ─── Render: date bar + session picker ────────────────────────────────────

  function renderDateBar() {
    if (!selectedOffering) return null
    return (
      <div className="att-date-bar">
        <input
          type="date"
          className="att-date-input"
          value={selectedDate}
          max={todayDateString()}
          onChange={e => setSelectedDate(e.target.value)}
        />
        {existingSessions.length > 0 && (
          <span className="catt-session-count">
            {existingSessions.length} session{existingSessions.length === 1 ? '' : 's'} recorded
          </span>
        )}
      </div>
    )
  }

  // ─── Render: summary + batch bar ───────────────────────────────────────────

  function renderSummaryBar() {
    if (students.length === 0) return null
    return (
      <div className="att-summary-bar">
        {summary.present > 0 && <span className="att-sum att-sum--present">{summary.present} present</span>}
        {summary.absent > 0 && <span className="att-sum att-sum--absent">{summary.absent} absent</span>}
        {summary.late > 0 && <span className="att-sum att-sum--late">{summary.late} late</span>}
        {summary.excused > 0 && <span className="att-sum att-sum--excused">{summary.excused} excused</span>}
        {unmarkedCount > 0 && <span className="att-sum att-sum--unmarked">{unmarkedCount} unmarked</span>}
        {!isOnline && <span className="att-sum att-sum--offline"><Icon name="cloud" size={14} /> offline</span>}
      </div>
    )
  }

  function renderBatchBar() {
    if (students.length === 0 || !markedBy || !canMark || !activeSession) return null
    return (
      <div className="att-batch-bar">
        <span className="att-batch-label">Mark all:</span>
        <button
          className="att-batch-btn att-batch-btn--present"
          disabled={batchSaving}
          onClick={() => handleBatchMark('present', markedBy)}
        >
          {batchSaving ? '…' : 'Present'}
        </button>
        <button
          className="att-batch-btn att-batch-btn--absent"
          disabled={batchSaving}
          onClick={() => handleBatchMark('absent', markedBy)}
        >
          {batchSaving ? '…' : 'Absent'}
        </button>
      </div>
    )
  }

  // ─── Render: one student row ────────────────────────────────────────────

  function renderStudentRow(student: RegisteredStudent) {
    const record = attMap.get(student.student_id)
    const isSaving = savingIds.has(student.student_id)
    const isQueued = queuedIds.has(student.student_id)
    const rowError = errorIds.get(student.student_id)
    const elig = eligibility.get(student.student_id)

    return (
      <div key={student.student_id} className="att-student-row">
        <div className="att-student-main">
          <div className="catt-student-name-block">
            <span className="att-student-name">{student.student_name}</span>
            {student.student_matric_number && (
              <span className="catt-row-matric">{student.student_matric_number}</span>
            )}
            {student.is_carryover && <span className="catt-carryover-badge">Carryover</span>}
            {elig && elig.percent !== null && (
              <span
                className={[
                  'catt-elig-badge',
                  elig.meetsThreshold === false ? 'catt-elig-badge--below' : '',
                ].join(' ')}
                title={
                  elig.thresholdPct !== null
                    ? `${elig.percent}% attendance (threshold ${elig.thresholdPct}%)`
                    : `${elig.percent}% attendance`
                }
              >
                {elig.percent}%
              </span>
            )}
          </div>

          <div className="att-btn-group">
            {isSaving && <span className="att-saving-indicator" aria-label="Saving…">⟳</span>}
            {rowError && !isSaving && (
              <span className="att-error-badge" title={rowError} role="img" aria-label={rowError}>
                <Icon name="x" size={14} style={{ color: 'var(--color-error, #dc2626)' }} />
              </span>
            )}
            {isQueued && !isSaving && (
              <span
                className="att-queued-badge"
                title="Saved offline — will sync when reconnected"
                role="img"
                aria-label="Saved offline — will sync when reconnected"
              >
                <Icon name="cloud" size={14} />
              </span>
            )}
            {STATUS_ORDER.map(status => (
              <button
                key={status}
                disabled={isSaving || !markedBy || !canMark || !activeSession}
                className={[
                  'att-btn',
                  STATUS_CONFIG[status].cls,
                  record?.status === status ? 'att-btn--active' : '',
                ].join(' ')}
                aria-label={STATUS_CONFIG[status].label}
                onClick={() => markedBy && canMark && handleStatusTap(student, status, markedBy)}
              >
                {STATUS_CONFIG[status].short}
              </button>
            ))}
          </div>
        </div>
      </div>
    )
  }

  // ─── Render: register ──────────────────────────────────────────────────────

  function renderRegister() {
    if (!selectedOffering) return null

    if (sessionOpening) {
      return <div className="att-register-skel" aria-hidden="true" />
    }

    if (sessionOpenErr) {
      return (
        <div className="att-empty-state">
          <span className="att-empty-icon"><Icon name="calendar" size={28} /></span>
          <p className="att-empty-msg">No school today</p>
          <p className="att-empty-sub">{sessionOpenErr}</p>
        </div>
      )
    }

    if (studentsState === 'loading' || recordsState === 'loading') {
      return <div className="att-register-skel" aria-hidden="true" />
    }

    if (studentsState === 'error') {
      return (
        <div className="att-error-state">
          <span className="att-error-icon"><Icon name="alert-triangle" size={32} style={{ color: 'var(--color-warning, #d97706)' }} /></span>
          <p className="att-error-msg">{studentsErr || 'Failed to load the register.'}</p>
        </div>
      )
    }

    if (studentsState === 'empty') {
      return (
        <div className="att-empty-state">
          <span className="att-empty-icon"><Icon name="users" size={28} /></span>
          <p className="att-empty-msg">No students registered for this course offering yet.</p>
          <p className="att-empty-sub">Students appear here once they have a live course registration.</p>
        </div>
      )
    }

    if (!canMark) {
      return (
        <div className="att-empty-state att-empty-state--prompt">
          <span className="att-empty-icon"><Icon name="lock" size={28} /></span>
          <p className="att-empty-msg">You don't have permission to mark this register.</p>
        </div>
      )
    }

    if (recordsState === 'error') {
      return (
        <div className="att-error-state">
          <span className="att-error-icon"><Icon name="alert-triangle" size={32} style={{ color: 'var(--color-warning, #d97706)' }} /></span>
          <p className="att-error-msg">{recordsErr || 'Failed to load attendance records.'}</p>
        </div>
      )
    }

    return (
      <div className="att-register">
        {students.map(renderStudentRow)}
      </div>
    )
  }

  // ─── Top-level render ───────────────────────────────────────────────────

  if (!isHigherEd) {
    return (
      <div className="att-root">
        <div className="att-empty-state">
          <span className="att-empty-icon"><Icon name="book-open" size={28} /></span>
          <p className="att-empty-msg">Course attendance isn't available for this school type.</p>
          <p className="att-empty-sub">This feature is for higher institutions (university, polytechnic, or college of education).</p>
        </div>
      </div>
    )
  }

  return (
    <div className="att-root">
      <div className="att-header">
        <div className="att-header-top">
          <h2 className="att-title">Course Attendance</h2>
        </div>

        {renderOfferingPicker()}
        {selectedOffering && renderDateBar()}
        {selectedOffering && renderSummaryBar()}
        {selectedOffering && renderBatchBar()}
      </div>

      <div className="att-body">
        {!selectedOffering && offeringsState === 'ready' && (
          <div className="att-empty-state att-empty-state--prompt">
            <span className="att-empty-icon"><Icon name="clipboard-list" size={40} /></span>
            <p className="att-empty-msg">Select a course above to start marking attendance.</p>
          </div>
        )}
        {renderRegister()}
      </div>
    </div>
  )
}
