/**
 * AttendanceModule.tsx
 * Attendance marking and history for teachers and admins.
 *
 * Props (same pattern as TimetableModule):
 *   schoolId  — passed from App.tsx via TabContent
 *   isAdmin   — true for staff/platform_admin actor types; used only for two
 *               cosmetic empty-state hints, not as a write gate (see below)
 *   intent    — optional 'mark_attendance', carried from AdminDashboard's
 *               quick action via App.tsx's NavIntent. Accepted for type
 *               compatibility only; not yet wired to any behavior — open
 *               item, not an oversight (see MASTER_PROJECT_PLAN.md §11).
 *
 * Permissions (PRD Tier 3 / Session 9, 2026-07-01):
 *   Marking/batch-marking attendance requires `academics.attendance.mark`,
 *   read via useAuthStore's can(). `actorRecordId` (also from authStore) is
 *   used as attendance_records.marked_by — previously this was incorrectly
 *   derived from supabase.auth.getUser(), which returns the Auth user id,
 *   not staff.id (the actual FK target); see MASTER_PROJECT_PLAN.md §11.
 *   Class-list filtering (academics.attendance.view_all / canForClass) is
 *   NOT implemented here yet — every staff member currently sees every
 *   class regardless of scope; logged as a known gap, not an oversight.
 *
 * Flow:
 *   1. Load all leaf classes → show class selector
 *   2. On class select → load students for that class
 *   3. Show register: one row per student, four status buttons (P/A/E/L)
 *   4. Optimistic updates on every tap; offline queue on network failure
 *   5. "Mark all present" / "Mark all absent" batch shortcut in header
 *   6. History strip (30-day calendar) toggleable per student row
 *
 * UX contract (§4):
 *   - Class list loads instantly from cache on repeat visits
 *   - Every status tap confirms immediately (optimistic), syncs in background
 *   - Offline: queued writes show a ☁ indicator; flush on reconnect
 *   - Empty states are actionable ("No students enrolled in this class yet")
 *   - Errors show plain English + Retry, never raw Postgres messages
 *   - Lacking academics.attendance.mark shows a visible notice, not a
 *     silently-disabled button (§4.3)
 *
 * Per-period marking removed (2026-07-03, owner decision — see
 * attendanceService.ts's file header for the full root-cause writeup):
 * attendance_settings had zero rows for any granularity anywhere in this
 * school, per_period had never been turned on by anyone, and its nullable
 * period_id dimension was the confirmed root cause of a live duplicate-row
 * data-integrity bug. One attendance record per student per day is now a
 * real DB constraint, not just a convention — the period selector, the
 * granularity branch, and every periodId reference below are gone.
 *
 * Whole-school analytics panel (2026-07-03, PRD Tier 5 / Problem 5.4
 * follow-on scope, owner request during the same session): a Day/Week/Term/
 * Session panel sits above the class selector, independent of
 * selectedClass/selectedDate. It answers "how is the whole school doing" —
 * a different question from renderSummaryBar()'s "how is this class doing
 * today," so the two are kept deliberately separate rather than merged.
 * Backed by attendanceService.ts's getSchoolAttendanceAnalytics(), which is
 * itself calendar-aware (school_calendar_days/school_week_days) so % presence,
 * "not marked," and the sparkline all exclude non-school days from their
 * denominators. The 30-day per-student history strip below each name is
 * calendar-aware too — a weekend/holiday with no record renders as a faded
 * "no school" dot, visually distinct from a genuine missed mark.
 */


import { useState, useEffect, useCallback, useRef } from 'react'
import { useAuthStore } from '../stores/authStore'
import { Icon } from '../components/icons'
import {
  loadCurrentSession,
  loadCurrentTerm,
  loadAllLeafClasses,
  loadStudentsForClass,
  loadAttendanceRecords,
  loadAttendanceHistory,
  saveAttendanceRecord,
  saveBatchAttendance,
  flushAttendanceQueue,
  buildAttendanceMap,
  getAttendanceSummary,
  getSchoolAttendanceAnalytics,
  resolveAnalyticsScopeRange,
  isSchoolDay,
  todayDateString,
  type ClassNode,
  type Student,
  type AttendanceRecord,
  type AttendanceMap,
  type AttendanceStatus,
  type StudentAttendanceHistory,
  type AttendanceUpsertParams,
  type AttendanceAnalyticsScope,
  type SchoolAttendanceAnalytics,
  type SchoolDayCheck,
} from '../services/attendanceService'

// ─── Props ────────────────────────────────────────────────────────────────────

interface AttendanceModuleProps {
  schoolId: string
  isAdmin: boolean
  // Carried from AdminDashboard's quick actions via App.tsx's NavIntent.
  // Typed as the full union (matching NavIntent['intent']) because App.tsx
  // passes intent.intent through unnarrowed at every module call site —
  // only 'mark_attendance' is meaningful here, the others are inert.
  // Accepted for type compatibility only; not yet wired to any behavior —
  // open item, not an oversight (see MASTER_PROJECT_PLAN.md §11).
  intent?: 'add_student' | 'record_payment' | 'mark_attendance'
}

// ─── Load state machine ───────────────────────────────────────────────────────

type LoadState = 'booting' | 'ready' | 'loading' | 'empty' | 'error'

// ─── Status display config ────────────────────────────────────────────────────

const STATUS_CONFIG: Record<AttendanceStatus, { label: string; short: string; cls: string }> = {
  present: { label: 'Present', short: 'P', cls: 'att-btn--present' },
  absent:  { label: 'Absent',  short: 'A', cls: 'att-btn--absent'  },
  excused: { label: 'Excused', short: 'E', cls: 'att-btn--excused' },
  late:    { label: 'Late',    short: 'L', cls: 'att-btn--late'    },
}

const STATUS_ORDER: AttendanceStatus[] = ['present', 'absent', 'excused', 'late']

// History strip: colour dot per status
const HISTORY_DOT_CLS: Record<AttendanceStatus, string> = {
  present: 'att-dot--present',
  absent:  'att-dot--absent',
  excused: 'att-dot--excused',
  late:    'att-dot--late',
}

// School-day gate (Session 19): fallback sub-label per day_type when the
// calendar entry has no custom label set. 'school_day' is intentionally
// absent — that dayType never reaches this UI (isSchoolDay would be true).
const NOSCHOOL_REASON_LABEL: Partial<Record<SchoolDayCheck['dayType'] & string, string>> = {
  holiday:  'Marked as a holiday on the school calendar.',
  exam_day: 'Marked as an exam day on the school calendar.',
  break:    'Marked as a school break.',
}

// ─── Attendance ring ──────────────────────────────────────────────────────────
// SVG stroke-dashoffset ring, ported to match GuardianPortal.tsx's
// AttendanceRing exactly (owner preference, flagged 2026-07-07) — replaces
// the previous conic-gradient .att-analytics-ring, which read as a flat,
// low-contrast donut compared to this. Same component shape/props as the
// portal's version; kept as a local copy rather than a shared import since
// AttendanceModule.tsx and GuardianPortal.tsx don't currently share a
// components file (not introducing a new shared module for one component).
function AttendanceRing({ percent }: { percent: number | null }) {
  const pct = percent ?? 0
  const r = 28
  const circumference = 2 * Math.PI * r
  const offset = circumference * (1 - pct / 100)
  return (
    <svg viewBox="0 0 70 70" className="att-ring">
      <circle cx="35" cy="35" r={r} className="att-ring-bg" />
      {percent !== null && (
        <circle
          cx="35"
          cy="35"
          r={r}
          className="att-ring-fg"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
        />
      )}
      <text x="35" y="40" textAnchor="middle" className="att-ring-text">
        {percent !== null ? `${percent}%` : '—'}
      </text>
    </svg>
  )
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function AttendanceModule({ schoolId, isAdmin, intent: _intent }: AttendanceModuleProps) {
  // ── Session ──────────────────────────────────────────────────────────────
  const [sessionId,   setSessionId]   = useState<string | null>(null)
  const [sessionName, setSessionName] = useState<string>('')
  // Date bounds + current term — needed to resolve week/term/session ranges
  // for the whole-school analytics panel below (2026-07-03).
  const [sessionRange, setSessionRange] = useState<{ sessionStartDate: string; sessionEndDate: string } | null>(null)
  const [currentTerm,  setCurrentTerm]  = useState<{ id: string; name: string; startDate: string; endDate: string } | null>(null)

  // ── Whole-school analytics panel ──────────────────────────────────────────
  // Independent of selectedClass/selectedDate — answers "how is the school
  // doing," not "how is this class doing today" (that's renderSummaryBar()).
  const [analyticsScope,   setAnalyticsScope]   = useState<AttendanceAnalyticsScope>('day')
  const [analyticsData,    setAnalyticsData]    = useState<SchoolAttendanceAnalytics | null>(null)
  const [analyticsLoading, setAnalyticsLoading] = useState(false)
  const [analyticsError,   setAnalyticsError]   = useState<string>('')

  // ── Class selector ────────────────────────────────────────────────────────
  const [classes,         setClasses]         = useState<ClassNode[]>([])
  const [selectedClass,   setSelectedClass]   = useState<ClassNode | null>(null)
  const [classLoadState,  setClassLoadState]  = useState<LoadState>('booting')

  // ── Students ──────────────────────────────────────────────────────────────
  const [students,     setStudents]     = useState<Student[]>([])

  // ── Date ──────────────────────────────────────────────────────────────────
  const [selectedDate, setSelectedDate] = useState<string>(todayDateString())

  // ── School-day gate (PRD Tier 5 / Problem 5.2 / Session 19) ───────────────
  // Whether selectedDate is a real school day for this school, per
  // school_calendar_days (override) falling back to school_week_days
  // (weekday). Gates the register itself — see renderRegister() — not just
  // the history-strip display (that part already existed, see
  // renderHistoryStrip()'s isNonSchoolUnmarked).
  const [schoolDayCheck,     setSchoolDayCheck]     = useState<SchoolDayCheck | null>(null)
  const [schoolDayLoading,   setSchoolDayLoading]   = useState(false)
  const [schoolDayCheckErr,  setSchoolDayCheckErr]  = useState<string>('')

  // ── Attendance data ───────────────────────────────────────────────────────
  const [attMap,      setAttMap]      = useState<AttendanceMap>(new Map())
  const [loadState,   setLoadState]   = useState<LoadState>('booting')
  const [errorMsg,    setErrorMsg]    = useState<string>('')

  // ── Optimistic / offline state ────────────────────────────────────────────
  // savingIds: student IDs mid-save (shows spinner on that row's buttons)
  // errorIds:  student IDs whose last save failed (shows red ✕; auto-clears 3s)
  // queuedIds: student IDs whose write was queued offline
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set())
  const [errorIds,  setErrorIds]  = useState<Map<string, string>>(new Map())
  const [queuedIds, setQueuedIds] = useState<Set<string>>(new Set())
  const [isOnline,  setIsOnline]  = useState<boolean>(true)
  const errorTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  // ── History strip ─────────────────────────────────────────────────────────
  const [historyOpen,    setHistoryOpen]    = useState<Set<string>>(new Set())
  const [historyData,    setHistoryData]    = useState<Map<string, StudentAttendanceHistory>>(new Map())
  const [historyLoading, setHistoryLoading] = useState<Set<string>>(new Set())

  // ── Batch mark-all ────────────────────────────────────────────────────────
  const [batchSaving, setBatchSaving] = useState(false)

  // ─── Boot: session + classes ───────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false

    async function boot() {
      setClassLoadState('loading')

      const [sessionRes, classRes] = await Promise.all([
        loadCurrentSession(),
        loadAllLeafClasses(),
      ])

      if (cancelled) return

      if (!sessionRes.ok) {
        setClassLoadState('error')
        setErrorMsg(sessionRes.error ?? 'Failed to load session')
        return
      }
      setSessionId(sessionRes.sessionId ?? null)
      setSessionName(sessionRes.sessionName ?? '')

      if (sessionRes.sessionStartDate && sessionRes.sessionEndDate) {
        setSessionRange({
          sessionStartDate: sessionRes.sessionStartDate,
          sessionEndDate: sessionRes.sessionEndDate,
        })
      }

      if (!classRes.ok) {
        setClassLoadState('error')
        setErrorMsg(classRes.error)
        return
      }

      const leafClasses = classRes.data
      setClasses(leafClasses)
      setClassLoadState(leafClasses.length === 0 ? 'empty' : 'ready')

      // Current term — best-effort. A school that doesn't use terms, or has
      // no term row covering today, just falls back to the session range in
      // resolveAnalyticsScopeRange(); no error state needed for that case.
      if (sessionRes.sessionId) {
        const termRes = await loadCurrentTerm(sessionRes.sessionId)
        if (!cancelled && termRes.ok) {
          setCurrentTerm(termRes.data)
        }
      }
    }

    boot()
    return () => { cancelled = true }
  }, [])

  // ─── Whole-school analytics: load on scope change ──────────────────────────
  // Independent of selectedClass/selectedDate on purpose — this is the "how
  // is the whole school doing" panel, not the per-class register. Waits for
  // sessionRange since resolveAnalyticsScopeRange() needs it as a fallback
  // even for 'day'/'week' scopes that don't otherwise use it.

  useEffect(() => {
    if (!sessionRange) return
    let cancelled = false

    async function loadAnalytics() {
      setAnalyticsLoading(true)
      setAnalyticsError('')

      const { startDate, endDate } = resolveAnalyticsScopeRange(
        analyticsScope,
        sessionRange!,
        currentTerm,
      )

      const result = await getSchoolAttendanceAnalytics({
        schoolId,
        scope: analyticsScope,
        startDate,
        endDate,
      })

      if (cancelled) return

      if (!result.ok) {
        setAnalyticsError(result.error)
        setAnalyticsData(null)
      } else {
        setAnalyticsData(result.data)
      }
      setAnalyticsLoading(false)
    }

    loadAnalytics()
    return () => { cancelled = true }
  }, [analyticsScope, sessionRange, currentTerm, schoolId])

  // ─── Online / offline detection ────────────────────────────────────────────
  // Uses window events but only for UI feedback — the offline queue logic in
  // the service layer has no window references (React Native safe).

  useEffect(() => {
    const handleOnline  = () => { setIsOnline(true);  flushAttendanceQueue() }
    const handleOffline = () => setIsOnline(false)
    window.addEventListener('online',  handleOnline)
    window.addEventListener('offline', handleOffline)
    return () => {
      window.removeEventListener('online',  handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])

  // ─── Load students when class changes ───────────────────────────────────────

  useEffect(() => {
    if (!selectedClass) return
    let cancelled = false

    async function loadClassData() {
      setLoadState('loading')
      setStudents([])
      setAttMap(new Map())
      setHistoryOpen(new Set())
      setHistoryData(new Map())

      const studentsRes = await loadStudentsForClass(selectedClass!.id)

      if (cancelled) return

      if (!studentsRes.ok) {
        setLoadState('error')
        setErrorMsg(studentsRes.error)
        return
      }

      setStudents(studentsRes.data)

      if (studentsRes.data.length === 0) {
        setLoadState('empty')
      } else {
        setLoadState('ready')
      }
    }

    loadClassData()
    return () => { cancelled = true }
  }, [selectedClass])

  // Derived: does the currently selected date look like a real school day?
  // Fails open (true) while loading, on error, or before the first check has
  // resolved — same reasoning as the checkDay() error branch above: an
  // unconfirmed "no school" is worse than briefly showing the normal bars.
  const isSelectedDateSchoolDay = schoolDayLoading || !schoolDayCheck || schoolDayCheckErr
    ? true
    : schoolDayCheck.isSchoolDay

  // ─── School-day check when date / class changes ─────────────────────────────
  // Runs alongside loadRecords() below rather than inside it: this check must
  // resolve (and gate the register) even in load states where loadRecords()
  // itself no-ops (see its own guard on loadState), and keeping it a separate
  // effect avoids coupling the gate's fetch to the records fetch's retry/error
  // handling, which serves a different purpose (§4.3 — actionable empty state
  // is its own concern, not a side effect of the records load succeeding).

  useEffect(() => {
    if (!selectedClass) {
      setSchoolDayCheck(null)
      return
    }
    let cancelled = false

    async function checkDay() {
      setSchoolDayLoading(true)
      setSchoolDayCheckErr('')

      const result = await isSchoolDay(selectedDate, schoolId)

      if (cancelled) return

      if (!result.ok) {
        // Non-fatal: fail open (treat as a school day) rather than blocking
        // the whole register behind a transient network error — a false
        // "no school" empty state would be worse than occasionally showing
        // the register on a day that turns out to be a holiday.
        setSchoolDayCheckErr(result.error)
        setSchoolDayCheck(null)
      } else {
        setSchoolDayCheck(result.data)
      }
      setSchoolDayLoading(false)
    }

    checkDay()
    return () => { cancelled = true }
  }, [selectedClass, selectedDate, schoolId])

  // ─── Load attendance records when date / class changes ─────────────────────

  const loadRecords = useCallback(async () => {
    if (!selectedClass || loadState === 'loading' || loadState === 'booting') return

    const recordsRes = await loadAttendanceRecords({
      classNodeId: selectedClass.id,
      date: selectedDate,
    })

    if (!recordsRes.ok) {
      // Non-fatal: show records as empty rather than crashing the whole view
      setAttMap(new Map())
      return
    }

    setAttMap(buildAttendanceMap(recordsRes.data))
  }, [selectedClass, selectedDate, loadState])

  useEffect(() => {
    if (loadState === 'ready') loadRecords()
  }, [loadRecords, loadState, selectedDate])

  // ─── Status tap handler (optimistic) ──────────────────────────────────────

  const handleStatusTap = useCallback(async (
    student: Student,
    status: AttendanceStatus,
    markedBy: string,
  ) => {
    if (!selectedClass || !sessionId) return

    // Don't re-tap same status that's already saved
    const key = student.id
    const current = attMap.get(key)
    if (current?.status === status) return

    // 1. Optimistic update
    const optimisticRecord: AttendanceRecord = {
      id: current?.id ?? crypto.randomUUID(),
      student_id: student.id,
      date: selectedDate,
      status,
      notes: null,
      marked_by: markedBy,
    }
    setAttMap(prev => {
      const next = new Map(prev)
      next.set(key, optimisticRecord)
      return next
    })

    // 2. Mark as saving
    setSavingIds(prev => new Set(prev).add(student.id))

    // 3. Background write
    const params: AttendanceUpsertParams = {
      schoolId,
      studentId: student.id,
      classNodeId: selectedClass.id,
      markedBy,
      date: selectedDate,
      status,
    }

    const result = await saveAttendanceRecord(params)

    setSavingIds(prev => {
      const next = new Set(prev)
      next.delete(student.id)
      return next
    })

    if (result.queued) {
      setQueuedIds(prev => new Set(prev).add(student.id))
      return
    }

    if (!result.ok) {
      // Revert optimistic update
      setAttMap(prev => {
        const next = new Map(prev)
        if (current) {
          next.set(key, current)
        } else {
          next.delete(key)
        }
        return next
      })
      // Show error badge for 3 s
      setErrorIds(prev => new Map(prev).set(student.id, result.error ?? 'Save failed'))
      const timer = setTimeout(() => {
        setErrorIds(prev => {
          const next = new Map(prev)
          next.delete(student.id)
          return next
        })
        errorTimers.current.delete(student.id)
      }, 3000)
      // Clear any previous timer for this student
      if (errorTimers.current.has(student.id)) {
        clearTimeout(errorTimers.current.get(student.id)!)
      }
      errorTimers.current.set(student.id, timer)
    }
  }, [selectedClass, sessionId, selectedDate, attMap, schoolId])

  // ─── Batch mark-all ────────────────────────────────────────────────────────

  const handleBatchMark = useCallback(async (
    status: AttendanceStatus,
    markedBy: string,
  ) => {
    if (!selectedClass || !sessionId || students.length === 0) return

    setBatchSaving(true)

    // Optimistic: update all rows immediately
    const nextMap: AttendanceMap = new Map(attMap)
    students.forEach(s => {
      nextMap.set(s.id, {
        id: nextMap.get(s.id)?.id ?? crypto.randomUUID(),
        student_id: s.id,
        date: selectedDate,
        status,
        notes: null,
        marked_by: markedBy,
      })
    })
    setAttMap(nextMap)

    const records: AttendanceUpsertParams[] = students.map(s => ({
      schoolId,
      studentId: s.id,
      classNodeId: selectedClass.id,
      markedBy,
      date: selectedDate,
      status,
    }))

    const result = await saveBatchAttendance({ records })
    setBatchSaving(false)

    if (result.queued) {
      const qIds = new Set(queuedIds)
      students.forEach(s => qIds.add(s.id))
      setQueuedIds(qIds)
      return
    }

    if (!result.ok) {
      // Revert to previous map on batch failure
      setAttMap(attMap)
    }
  }, [selectedClass, sessionId, students, selectedDate, attMap, schoolId, queuedIds])

  // ─── History strip toggle ──────────────────────────────────────────────────

  const toggleHistory = useCallback(async (student: Student) => {
    const isOpen = historyOpen.has(student.id)

    if (isOpen) {
      setHistoryOpen(prev => {
        const next = new Set(prev)
        next.delete(student.id)
        return next
      })
      return
    }

    // Open: load if not cached
    setHistoryOpen(prev => new Set(prev).add(student.id))

    if (!historyData.has(student.id)) {
      setHistoryLoading(prev => new Set(prev).add(student.id))

      const result = await loadAttendanceHistory(selectedClass!.id, schoolId)
      if (result.ok) {
        const map = new Map(historyData)
        result.data.forEach(h => map.set(h.student_id, h))
        setHistoryData(map)
      }

      setHistoryLoading(prev => {
        const next = new Set(prev)
        next.delete(student.id)
        return next
      })
    }
  }, [historyOpen, historyData, selectedClass, schoolId])

  // ─── Summary counts ────────────────────────────────────────────────────────

  const summary = getAttendanceSummary(attMap)
  const unmarkedCount = students.length - attMap.size

  // ─── Auth: staff id + permission gate ──────────────────────────────────────
  // markedBy must be staff.id (attendance_records.marked_by is a FK to it) —
  // previously derived from supabase.auth.getUser(), which returns the
  // Auth *user* id, not staff.id; those are different rows, joined only via
  // app_identities. actorRecordId in authStore already resolves the correct
  // one for staff actors. PRD Tier 3 / Session 9, 2026-07-01.
  const actorRecordId  = useAuthStore(s => s.actorRecordId)
  const canMark         = useAuthStore(s => s.can('academics.attendance.mark'))
  const markedBy = actorRecordId ?? ''

  // ─── Render helpers ────────────────────────────────────────────────────────

  const ANALYTICS_SCOPE_LABEL: Record<AttendanceAnalyticsScope, string> = {
    day: 'Today',
    week: 'This Week',
    term: currentTerm ? currentTerm.name : 'This Term',
    session: 'This Session',
  }

  function renderAnalyticsPanel() {
    const data = analyticsData

    return (
      <div className="att-analytics-panel">
        <div className="att-analytics-head">
          <h3 className="att-analytics-title">School Attendance</h3>
          <div className="att-analytics-tabs" role="tablist">
            {(['day', 'week', 'term', 'session'] as AttendanceAnalyticsScope[]).map(scope => (
              <button
                key={scope}
                role="tab"
                aria-selected={analyticsScope === scope}
                className={[
                  'att-analytics-tab',
                  analyticsScope === scope ? 'att-analytics-tab--active' : '',
                ].join(' ')}
                onClick={() => setAnalyticsScope(scope)}
              >
                {scope === 'day' ? 'Day' : scope === 'week' ? 'Week' : scope === 'term' ? 'Term' : 'Session'}
              </button>
            ))}
          </div>
        </div>

        {analyticsLoading && !data && (
          <div className="att-analytics-skel skeleton" />
        )}

        {analyticsError && !analyticsLoading && (
          <p className="att-analytics-error">{analyticsError}</p>
        )}

        {data && (
          <div className="att-analytics-body">
            <div className="att-analytics-ring-row">
              <AttendanceRing percent={data.presentPercent} />

              <div className="att-analytics-chips">
                <span className="att-sum att-sum--present">{data.present} present</span>
                <span className="att-sum att-sum--absent">{data.absent} absent</span>
                <span className="att-sum att-sum--late">{data.late} late</span>
                <span className="att-sum att-sum--excused">{data.excused} excused</span>
                <span className="att-sum att-sum--unmarked">{data.notMarked} not marked</span>
              </div>
            </div>

            <p className="att-analytics-context">
              {ANALYTICS_SCOPE_LABEL[analyticsScope]} · {data.totalActiveStudents} active students · {data.schoolDaysInRange} school day{data.schoolDaysInRange === 1 ? '' : 's'}
            </p>

            {data.dailyPresentTrend.length > 0 && (
              <div className="att-sparkline" aria-hidden="true">
                {data.dailyPresentTrend.map(pt => {
                  const max = Math.max(1, ...data.dailyPresentTrend.map(d => d.present))
                  const heightPct = Math.round((pt.present / max) * 100)
                  return (
                    <div
                      key={pt.date}
                      className="att-sparkline-bar"
                      style={{ height: `${Math.max(4, heightPct)}%` }}
                      title={`${pt.date}: ${pt.present} present`}
                    />
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  function renderClassSelector() {
    if (classLoadState === 'loading' || classLoadState === 'booting') {
      return (
        <div className="att-selector-wrap">
          <div className="att-selector-skel skeleton" />
        </div>
      )
    }
    if (classLoadState === 'error') {
      return (
        <div className="att-error-state">
          <span className="att-error-icon"><Icon name="alert-triangle" size={32} style={{ color: 'var(--color-warning, #d97706)' }} /></span>
          <p className="att-error-msg">{errorMsg}</p>
          <button className="att-retry-btn" onClick={() => window.location.reload()}>Retry</button>
        </div>
      )
    }
    if (classLoadState === 'empty') {
      return (
        <div className="att-empty-state">
          <span className="att-empty-icon"><Icon name="school" size={40} /></span>
          <p className="att-empty-msg">No classes have been set up yet.</p>
          {isAdmin && <p className="att-empty-sub">Add classes in the Setup guide.</p>}
        </div>
      )
    }
    return (
      <div className="att-selector-wrap">
        <label className="att-selector-label">Class</label>
        <select
          className="att-selector"
          value={selectedClass?.id ?? ''}
          onChange={e => {
            const found = classes.find(c => c.id === e.target.value) ?? null
            setSelectedClass(found)
          }}
        >
          <option value="">— pick a class —</option>
          {classes.map(c => (
            <option key={c.id} value={c.id}>{c.path_label}</option>
          ))}
        </select>
      </div>
    )
  }

  function renderDateBar() {
    return (
      <div className="att-date-bar">
        <input
          type="date"
          className="att-date-input"
          value={selectedDate}
          max={todayDateString()}
          onChange={e => setSelectedDate(e.target.value)}
        />
      </div>
    )
  }

  function renderSummaryBar() {
    if (students.length === 0) return null
    return (
      <div className="att-summary-bar">
        {summary.present > 0  && <span className="att-sum att-sum--present">{summary.present} present</span>}
        {summary.absent > 0   && <span className="att-sum att-sum--absent">{summary.absent} absent</span>}
        {summary.late > 0     && <span className="att-sum att-sum--late">{summary.late} late</span>}
        {summary.excused > 0  && <span className="att-sum att-sum--excused">{summary.excused} excused</span>}
        {unmarkedCount > 0    && <span className="att-sum att-sum--unmarked">{unmarkedCount} unmarked</span>}
        {!isOnline && <span className="att-sum att-sum--offline"><Icon name="cloud" size={14} /> offline</span>}
      </div>
    )
  }

  function renderBatchBar() {
    if (students.length === 0 || !markedBy || !canMark) return null
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

  function renderHistoryStrip(student: Student) {
    const isOpen    = historyOpen.has(student.id)
    const isLoading = historyLoading.has(student.id)
    const history   = historyData.get(student.id)

    if (!isOpen) return null

    if (isLoading) {
      return (
        <div className="att-history-strip">
          <div className="att-history-skel skeleton" />
        </div>
      )
    }

    if (!history) return null

    return (
      <div className="att-history-strip">
        {history.days.map(day => {
          // A day with no record renders as a genuine "missed" dot only when
          // it was actually a school day. Weekends/holidays/exam days/breaks
          // get a visually distinct faded dot instead — same grey base color,
          // no red flag, so a teacher's eye doesn't read a holiday as a
          // missed mark (owner request, 2026-07-03). A day WITH a status
          // always renders its real status color regardless of isSchoolDay,
          // since a genuine record (e.g. marked before a day was later set
          // as a holiday) still means something happened.
          const isNonSchoolUnmarked = !day.status && !day.isSchoolDay
          const isToday = day.date === todayDateString()
          return (
            <div
              key={day.date}
              className={['att-history-day', isToday ? 'att-history-day--today' : ''].join(' ').trim()}
              title={isNonSchoolUnmarked ? `${day.date} — no school` : day.date}
            >
              <div
                className={[
                  'att-dot',
                  day.status
                    ? HISTORY_DOT_CLS[day.status]
                    : isNonSchoolUnmarked
                      ? 'att-dot--no-school'
                      : 'att-dot--unmarked',
                  isToday ? 'att-dot--today' : '',
                ].join(' ').trim()}
              />
              <span className="att-history-date-label">
                {day.date.slice(8)}  {/* day-of-month only */}
              </span>
            </div>
          )
        })}
      </div>
    )
  }

  function renderStudentRow(student: Student) {
    const record    = attMap.get(student.id)
    const isSaving  = savingIds.has(student.id)
    const errMsg    = errorIds.get(student.id)
    const isQueued  = queuedIds.has(student.id)
    const isHistOpen = historyOpen.has(student.id)

    return (
      <div key={student.id} className="att-student-row">
        <div className="att-student-main">
          {/* Name + history toggle */}
          <button
            className="att-student-name"
            onClick={() => toggleHistory(student)}
            aria-expanded={isHistOpen}
          >
            {student.full_name}
            <span className="att-history-chevron">{isHistOpen ? '▲' : '▼'}</span>
          </button>

          {/* Status buttons */}
          <div className="att-btn-group">
            {isSaving && (
              <span className="att-saving-indicator" aria-label="Saving…">⟳</span>
            )}
            {errMsg && (
              <span
                className="att-error-badge"
                title={errMsg}
                role="img"
                aria-label={`Save failed: ${errMsg}`}
              >
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
                disabled={isSaving || !markedBy || !canMark}
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

        {/* History strip (collapsible) */}
        {renderHistoryStrip(student)}
      </div>
    )
  }

  function renderRegister() {
    if (!selectedClass) return null

    // ── School-day gate (PRD Tier 5 / Problem 5.2 / Session 19) ─────────────
    // Checked before the normal load-state branches below: a holiday/break
    // date should show an actionable "no school" state regardless of
    // whether students/records happen to have already loaded for it (§4.3 —
    // do not just disable the UI silently). schoolDayLoading intentionally
    // does not block rendering the skeleton/register below it — the register
    // itself still depends on loadState, so there's no flash of the wrong
    // empty state; this only prevents rendering the gate on stale/undefined
    // data. A failed check (schoolDayCheckErr set) fails open, showing the
    // normal register rather than a possibly-wrong "no school" state.
    if (!isSelectedDateSchoolDay && schoolDayCheck) {
      return (
        <div className="att-noschool-state">
          <span className="att-noschool-icon"><Icon name="calendar" size={40} /></span>
          <p className="att-noschool-msg">
            No school today{schoolDayCheck.label ? ` — ${schoolDayCheck.label}` : ''}
          </p>
          {schoolDayCheck.dayType && (
            <p className="att-noschool-sub">
              {NOSCHOOL_REASON_LABEL[schoolDayCheck.dayType] ?? 'Marked as a non-school day.'}
            </p>
          )}
        </div>
      )
    }

    if (loadState === 'loading' || loadState === 'booting') {
      return (
        <div className="att-register-skel">
          {[1, 2, 3, 4, 5].map(i => (
            <div key={i} className="att-student-row-skel skeleton" />
          ))}
        </div>
      )
    }

    if (loadState === 'error') {
      return (
        <div className="att-error-state">
          <span className="att-error-icon"><Icon name="alert-triangle" size={32} style={{ color: 'var(--color-warning, #d97706)' }} /></span>
          <p className="att-error-msg">{errorMsg}</p>
          <button className="att-retry-btn" onClick={loadRecords}>Retry</button>
        </div>
      )
    }

    if (loadState === 'empty') {
      return (
        <div className="att-empty-state">
          <span className="att-empty-icon"><Icon name="users" size={40} /></span>
          <p className="att-empty-msg">No students enrolled in {selectedClass.name} yet.</p>
          {isAdmin && <p className="att-empty-sub">Add students in the Students module.</p>}
        </div>
      )
    }

    return (
      <div className="att-register">
        {markedBy && !canMark && (
          <div className="att-permission-notice">
            You don't have permission to mark attendance. You can view this class's register, but changes won't be saved. Contact your admin if this seems wrong.
          </div>
        )}
        {students.map(renderStudentRow)}
      </div>
    )
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="att-root">
      {/* Whole-school analytics — independent of class/date selection below */}
      {renderAnalyticsPanel()}

      {/* Header */}
      <div className="att-header">
        <div className="att-header-top">
          <h2 className="att-title">Attendance</h2>
          {sessionName && (
            <span className="att-session-label">{sessionName}</span>
          )}
        </div>

        {/* Class selector */}
        {renderClassSelector()}

        {/* Date + period row — only show once a class is picked */}
        {selectedClass && renderDateBar()}

        {/* Summary bar — hidden on a confirmed non-school day (Session 19):
            "0 present" reads as a real gap on a holiday when it isn't one. */}
        {selectedClass && isSelectedDateSchoolDay && renderSummaryBar()}

        {/* Batch mark-all — same reasoning: marking attendance on a holiday
            shouldn't be offered as an action in the first place. */}
        {selectedClass && loadState === 'ready' && isSelectedDateSchoolDay && renderBatchBar()}
      </div>

      {/* Register */}
      <div className="att-body">
        {!selectedClass && classLoadState === 'ready' && (
          <div className="att-empty-state att-empty-state--prompt">
            <span className="att-empty-icon"><Icon name="clipboard-list" size={40} /></span>
            <p className="att-empty-msg">Select a class above to start marking attendance.</p>
          </div>
        )}
        {renderRegister()}
      </div>
    </div>
  )
}
