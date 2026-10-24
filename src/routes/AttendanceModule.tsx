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
 *
 * Whole-school register (2026-07-10, Session 32 follow-up, owner request:
 * "mark random attendance across the entire school"): a third selection
 * kind alongside selectedClass/selectedGroup — selectedAllSchool, picked
 * via a dedicated "All classes (whole school)" pill in tier 2. Reuses the
 * same combined-register-grouped-by-arm rendering Session 31 built for
 * selectedGroup (no separate flat-merge code path), sourcing its leaf-id
 * list from the already-loaded `classes` array (every leaf in the school)
 * rather than a new query. Same collapse-on-select and search behavior as
 * every other selection kind — nothing about those two features is
 * selection-kind-specific.
 *
 * After-hours edit lock (2026-07-10, Session 31, owner request): once a
 * given date's school hours end (per attendanceService.ts's
 * getSchoolHoursEndMoment(), the latest non-break period's end_time),
 * changing an EXISTING mark for that date is blocked — permanently, not
 * just until the next day, per the owner's explicit "permanent history"
 * framing. A student with no mark yet can still receive a first mark at any
 * time, however late — the lock only governs edits to a mark that already
 * exists (see handleStatusTap's own comment for the exact reasoning). This
 * followed directly from a real bug fix: retapping a second status used to
 * silently revert (see attendanceService.ts's header for the confirmed root
 * cause — a stray set_updated_at trigger with no matching column — and
 * migration_session_31_attendance_updated_at.sql for the fix).
 */


import { useState, useEffect, useCallback, useRef } from 'react'
import { useAuthStore } from '../stores/authStore'
import { Icon } from '../components/icons'
import { updateStudentStatus } from '../services/studentsService'
import ObligationFields from '../components/ObligationFields'
import {
  loadPendingObligations,
  createObligation,
  obligationBadge,
  validateObligationDraft,
  type Obligation,
  type ObligationDraft,
} from '../services/obligationsService'
import { loadRulesContext, resolveEffectiveRule, type RulesContext } from '../services/attendanceRules'
import {
  loadAttendanceDeactivationSettings,
  type AttendanceDeactivationSettings,
} from '../services/settingsService'
import {
  loadCurrentSession,
  loadCurrentTerm,
  loadAllLeafClasses,
  loadParentClassGroups,
  loadStudentsForClass,
  loadAttendanceRecords,
  loadAttendanceHistory,
  loadSuspendedStudents,
  loadSuspensionDetail,
  saveAttendanceRecord,
  saveBatchAttendance,
  flushAttendanceQueue,
  getPendingAttendanceForDate,
  buildAttendanceMap,
  getAttendanceSummary,
  getSchoolAttendanceAnalytics,
  resolveAnalyticsScopeRange,
  isSchoolDay,
  getSchoolHoursEndMoment,
  isWithinEditWindow,
  todayDateString,
  type ClassNode,
  type Student,
  type AttendanceRecord,
  type AttendanceMap,
  type AttendanceStatus,
  type StudentAttendanceHistory,
  type SuspendedStudent,
  type SuspensionDetail,
  type AttendanceUpsertParams,
  type AttendanceAnalyticsScope,
  type SchoolAttendanceAnalytics,
  type SchoolDayCheck,
  type ParentClassGroup,
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

  // ── Suspended students (per class, under the active register) ─────────────
  // Auto-deactivated students, most recently suspended first. The evidence
  // preview (calendar strip, days inactive, history) is loaded and shown
  // only once someone starts a reactivation — not for the whole list.
  const canManageStudents = useAuthStore(s => s.can('students.records.manage'))
  const [suspended,        setSuspended]        = useState<SuspendedStudent[]>([])
  const [suspendedRule,    setSuspendedRule]    = useState<AttendanceDeactivationSettings | null>(null)
  const [suspendedOpen,    setSuspendedOpen]    = useState<Set<string>>(new Set())  // class ids expanded
  const [reactivateId,     setReactivateId]     = useState<string | null>(null)
  const [reactivateNote,   setReactivateNote]   = useState('')
  const [reactivateSaving, setReactivateSaving] = useState(false)
  const [reactivateError,  setReactivateError]  = useState('')
  const [detail,           setDetail]           = useState<SuspensionDetail | null>(null)
  const [detailLoading,    setDetailLoading]    = useState(false)
  const [studentsReloadTick, setStudentsReloadTick] = useState(0)
  const [rulesCtx,         setRulesCtx]         = useState<RulesContext | null>(null)
  const [obligationDraft,  setObligationDraft]  = useState<ObligationDraft | null>(null)
  const [pendingObl,       setPendingObl]       = useState<Map<string, Obligation[]>>(new Map())
  const [reactivateNotice, setReactivateNotice] = useState('')

  const reloadSuspended = useCallback(async () => {
    if (!canManageStudents) return
    const [res, rule, ctxRes, oblRes] = await Promise.all([
      loadSuspendedStudents(schoolId),
      loadAttendanceDeactivationSettings(schoolId),
      loadRulesContext(schoolId),
      loadPendingObligations(schoolId),
    ])
    if (res.ok) setSuspended(res.data)
    setSuspendedRule(rule.data)
    if (ctxRes.ok) setRulesCtx(ctxRes.data)
    if (oblRes.ok) setPendingObl(oblRes.data)
  }, [schoolId, canManageStudents])

  useEffect(() => { void reloadSuspended() }, [reloadSuspended])

  function toggleSuspendedClass(classId: string) {
    setSuspendedOpen(prev => {
      const next = new Set(prev)
      if (next.has(classId)) next.delete(classId); else next.add(classId)
      return next
    })
  }

  async function startReactivate(s: SuspendedStudent) {
    if (reactivateId === s.student_id) { setReactivateId(null); return }
    setReactivateId(s.student_id)
    setReactivateNote('')
    setReactivateError('')
    setObligationDraft(null)
    setDetail(null)
    setDetailLoading(true)
    const res = await loadSuspensionDetail(schoolId, s.student_id, s.last_absent_date)
    setDetailLoading(false)
    if (res.ok) setDetail(res.data)
    else setReactivateError(res.error)
  }

  async function confirmReactivate(studentId: string) {
    if (obligationDraft) {
      const problem = validateObligationDraft(obligationDraft)
      if (problem) { setReactivateError(problem); return }
    }
    setReactivateSaving(true)
    setReactivateError('')
    const res = await updateStudentStatus(studentId, 'active', reactivateNote)
    if (!res.ok) { setReactivateSaving(false); setReactivateError(res.error); return }

    // Reactivation succeeded. The fine/task is a second write — if it fails
    // the student is still reactivated, so say so plainly rather than
    // leaving the preview open on a student who is no longer suspended.
    if (obligationDraft) {
      const ob = await createObligation({
        schoolId, studentId, draft: obligationDraft, createdBy: actorRecordId ?? null,
      })
      if (!ob.ok) {
        setReactivateNotice(`The student was reactivated, but the fine/task could not be saved: ${ob.error}. Add it from Students → Status.`)
      }
    }
    setReactivateSaving(false)
    setReactivateId(null)
    setReactivateNote('')
    setObligationDraft(null)
    setDetail(null)
    setSuspended(prev => prev.filter(x => x.student_id !== studentId))
    void reloadSuspended()
    // The reactivated student belongs back in the active register.
    setStudentsReloadTick(t => t + 1)
  }

  // ── Class selector ────────────────────────────────────────────────────────
  // Two-tier picker (owner request, Session 31: "filter by a parent class as
  // a whole"), matching StudentsModule.tsx's Session 12 pill pattern rather
  // than inventing a new interaction. selectedClass keeps its original
  // meaning (a single leaf class picked) unchanged — every one of its
  // existing ~20 read/write call sites still works exactly as before when a
  // single class is picked. selectedGroup is new and mutually exclusive with
  // it: picking "whole parent" sets selectedGroup and clears selectedClass;
  // picking a single class does the reverse. Only one of the two is ever
  // non-null at a time — see selectClass()/selectGroup() below, the only two
  // places either setter is called together.
  const [classes,         setClasses]         = useState<ClassNode[]>([])
  const [selectedClass,   setSelectedClass]   = useState<ClassNode | null>(null)
  const [classLoadState,  setClassLoadState]  = useState<LoadState>('booting')
  const [parentGroups,        setParentGroups]        = useState<ParentClassGroup[]>([])
  const [selectedParentId,    setSelectedParentId]    = useState<string | null>(null)
  const [selectedGroup,       setSelectedGroup]       = useState<ParentClassGroup | null>(null)
  // Session 32 follow-up (owner: "mark random attendance across the entire
  // school") — a third, school-wide selection kind, mutually exclusive with
  // both selectedClass and selectedGroup (see selectAllSchool() below, the
  // only place that sets it true alongside clearing the other two). No new
  // query needed: `classes` (above) already holds every leaf in the school
  // from the boot load, so this is effectively "the biggest possible
  // selectedGroup" without a real ParentClassGroup object behind it — a
  // plain boolean is simpler than inventing a synthetic group with no real
  // parent_id to key off.
  const [selectedAllSchool,   setSelectedAllSchool] = useState(false)
  // Collapse-on-select (owner request, Session 31 follow-up: economize phone
  // screen space) — once a class/group is picked, the two pill rows above
  // fold into one compact summary bar; tapping it re-expands the pills to
  // change the selection. Starts expanded (true) so first-time pickers still
  // see the full picker with nothing chosen yet.
  const [pickerExpanded,      setPickerExpanded]      = useState(true)
  // Search-within-register (owner request, same follow-up: "mark students
  // randomly" — jump straight to one name in a big class/combined register
  // rather than scrolling). Scoped to the currently selected class/group's
  // already-loaded student list, not an app-wide student search — a fresh
  // query per keystroke against the DB would be wasted cost for data that's
  // already sitting in `students`. Cleared on every class/group change (see
  // selectClass/selectGroup below) so a stale filter never survives across
  // a class switch.
  const [studentSearch,       setStudentSearch]       = useState('')

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

  // ── After-hours edit lock (PRD row 31 / owner request, Session 31) ────────
  // The moment selectedDate's school hours end, per getSchoolHoursEndMoment()
  // — null while unresolved/unconfigured (fails open, see that function's own
  // doc comment). Re-fetched whenever selectedDate changes; deliberately NOT
  // re-fetched on a timer, since re-render already happens naturally on every
  // status tap/save and that's the only time this value is actually read.
  const [editWindowEnd, setEditWindowEnd] = useState<Date | null>(null)

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

      const [sessionRes, classRes, groupsRes] = await Promise.all([
        loadCurrentSession(),
        loadAllLeafClasses(schoolId),
        loadParentClassGroups(schoolId),
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

      // Parent groups are additive UI sugar for the two-tier picker — fail
      // soft (empty list, no error state) rather than blocking the whole
      // class-load boot on this, since a school with no parent-level class
      // nodes at all (a flat class list) is a legitimate, common shape and
      // should just show single-class pills with no parent tier above them.
      if (groupsRes.ok) {
        setParentGroups(groupsRes.data)
      }

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

  // Online/offline detection effect is declared further below, after
  // loadRecords() exists — it needs to call loadRecords() on reconnect,
  // see "Online / offline detection" near the offline-queue flush.

  // ── Two-tier selection helpers ────────────────────────────────────────────
  // Single source of truth for "what's actually picked right now," whichever
  // tier it came from — every downstream effect/handler below reads THIS,
  // not selectedClass/selectedGroup directly, so there's exactly one place
  // that knows how to combine the two mutually-exclusive selection shapes.
  // Declared here, before any effect that reads it (moved after an initial
  // draft placed it lower and tripped a genuine "used before declaration"
  // error against the students-load effect right below — caught by a
  // tsc pass before this ever reached the device, not left for on-device
  // testing to find).
  const effectiveClassIds: string[] = selectedAllSchool
    ? classes.map(c => c.id)
    : selectedGroup
      ? selectedGroup.leafIds
      : selectedClass
        ? [selectedClass.id]
        : []
  const effectiveSelectionKey: string | null = selectedAllSchool
    ? 'all-school'
    : selectedGroup
      ? `group:${selectedGroup.id}`
      : selectedClass
        ? `class:${selectedClass.id}`
        : null
  // path_label already carries "Parent · Class" (attachPathLabels' own
  // fixed output, Session 31) — reused directly here rather than
  // re-deriving the parent name a second way, so the collapsed summary
  // bar shows which grade a class belongs to, not just the bare class
  // name (owner follow-up: "the label that remains should indicate the
  // parent class as well"). Falls back to .name for any orphan leaf with
  // no parent, where path_label and name are already identical.
  const effectiveLabel: string = selectedAllSchool
    ? 'All classes (whole school)'
    : selectedGroup
      ? `${selectedGroup.name} (all classes)`
      : selectedClass?.path_label ?? selectedClass?.name ?? ''
  const hasSelection = effectiveClassIds.length > 0

  function selectClass(c: ClassNode | null) {
    setSelectedGroup(null)
    setSelectedAllSchool(false)
    setSelectedClass(c)
    setStudentSearch('')
    setPickerExpanded(c === null)
  }

  function selectGroup(g: ParentClassGroup | null) {
    setSelectedClass(null)
    setSelectedAllSchool(false)
    setSelectedGroup(g)
    setStudentSearch('')
    setPickerExpanded(g === null)
  }

  // Session 32 follow-up — "mark random attendance across the entire
  // school": the whole-school equivalent of selectGroup(), same shape
  // (clear the other two selection kinds, reset search, collapse the
  // picker) but with no ParentClassGroup object to store.
  function selectAllSchool() {
    setSelectedClass(null)
    setSelectedGroup(null)
    setSelectedAllSchool(true)
    setStudentSearch('')
    setPickerExpanded(false)
  }

  // ─── Load students when class changes ───────────────────────────────────────

  useEffect(() => {
    if (!hasSelection) return
    let cancelled = false

    async function loadClassData() {
      setLoadState('loading')
      setStudents([])
      setAttMap(new Map())
      setHistoryOpen(new Set())
      setHistoryData(new Map())

      // Single id when one class is picked, array when a whole parent is —
      // loadStudentsForClass's own .eq()/.in() branch (Session 31) handles
      // both from the same call, so no branching needed here.
      const studentsRes = await loadStudentsForClass(
        effectiveClassIds.length === 1 ? effectiveClassIds[0] : effectiveClassIds,
      )

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
  }, [effectiveSelectionKey, studentsReloadTick])

  // Derived: does the currently selected date look like a real school day?
  // Fails open (true) while loading, on error, or before the first check has
  // resolved — same reasoning as the checkDay() error branch above: an
  // unconfirmed "no school" is worse than briefly showing the normal bars.
  const isSelectedDateSchoolDay = schoolDayLoading || !schoolDayCheck || schoolDayCheckErr
    ? true
    : schoolDayCheck.isSchoolDay

  // Derived: has selectedDate's school-hours-end moment passed? Pure check
  // against editWindowEnd (see the effect below that resolves it) — this is
  // read fresh on every render, so it naturally flips from unlocked to
  // locked the instant the real-world clock crosses that moment, without
  // needing its own timer (the component already re-renders on other state
  // changes at a normal human-interaction cadence, which is all this needs).
  const isDateLocked = !isWithinEditWindow(editWindowEnd)

  // ─── School-day check when date / class changes ─────────────────────────────
  // Runs alongside loadRecords() below rather than inside it: this check must
  // resolve (and gate the register) even in load states where loadRecords()
  // itself no-ops (see its own guard on loadState), and keeping it a separate
  // effect avoids coupling the gate's fetch to the records fetch's retry/error
  // handling, which serves a different purpose (§4.3 — actionable empty state
  // is its own concern, not a side effect of the records load succeeding).

  useEffect(() => {
    if (!hasSelection) {
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
  }, [effectiveSelectionKey, selectedDate, schoolId])

  // ─── After-hours edit-lock window when date changes ─────────────────────────
  // Deliberately keyed on [selectedDate, schoolId] only, not selectedClass —
  // periods.end_time is school-wide (no class_node_id on that table per §7.10's
  // schema), so re-fetching on a class change alone would be a wasted query for
  // a value that can't have changed. Fails open (null) on error — see
  // getSchoolHoursEndMoment()'s own doc comment for why that's the right
  // default here, same reasoning as the school-day check above.

  useEffect(() => {
    let cancelled = false

    async function loadEditWindow() {
      const result = await getSchoolHoursEndMoment(selectedDate, schoolId)
      if (cancelled) return
      setEditWindowEnd(result.ok ? result.data : null)
    }

    loadEditWindow()
    return () => { cancelled = true }
  }, [selectedDate, schoolId])

  // ─── Load attendance records when date / class changes ─────────────────────

  const loadRecords = useCallback(async () => {
    if (!hasSelection || loadState === 'loading' || loadState === 'booting') return

    const recordsRes = await loadAttendanceRecords({
      classNodeId: effectiveClassIds.length === 1 ? effectiveClassIds[0] : effectiveClassIds,
      date: selectedDate,
    })

    const base = recordsRes.ok ? buildAttendanceMap(recordsRes.data) : new Map()
    if (!recordsRes.ok) {
      // Non-fatal: show synced records as empty rather than crashing the
      // whole view — queued-but-unsynced rows below still get merged in.
    }

    // Merge in anything still sitting in the offline queue for this date —
    // these haven't reached the server yet, so loadAttendanceRecords() above
    // can't see them, but they're real pending writes and must keep showing
    // (with the queued/cloud badge) across a reload rather than vanishing.
    const pending = await getPendingAttendanceForDate(selectedDate)
    const merged: AttendanceMap = new Map(base)
    const stillQueued = new Set<string>()
    pending.forEach((record, studentId) => {
      merged.set(studentId, record)
      stillQueued.add(studentId)
    })

    setAttMap(merged)
    setQueuedIds(stillQueued)
  }, [effectiveSelectionKey, selectedDate, loadState])

  useEffect(() => {
    if (loadState === 'ready') loadRecords()
  }, [loadRecords, loadState, selectedDate])

  // ─── Online / offline detection ────────────────────────────────────────────
  // Uses window events but only for UI feedback — the offline queue logic in
  // the service layer has no window references (React Native safe).

  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true)
      // Fire-and-forget from the browser event's point of view, but the
      // async work inside still runs to completion and updates state when
      // it resolves — this is not discarded, just not blocking the handler.
      void (async () => {
        await flushAttendanceQueue()
        // Re-derive queuedIds/attMap from what's still actually pending
        // rather than assuming the flush cleared everything: some items can
        // fail (e.g. reconnected briefly, one row hit a real server error)
        // and must keep showing the queued badge; anything that DID sync
        // needs its badge cleared and, since it's no longer in the queue,
        // will now come from the next loadRecords()/server read instead.
        const stillPending = await getPendingAttendanceForDate(selectedDate)
        setQueuedIds(new Set(stillPending.keys()))
        // Refresh from the server so newly-synced rows (and their real
        // server ids) replace the placeholder queued entries in attMap.
        await loadRecords()
      })()
    }
    const handleOffline = () => setIsOnline(false)
    window.addEventListener('online',  handleOnline)
    window.addEventListener('offline', handleOffline)
    return () => {
      window.removeEventListener('online',  handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [selectedDate, loadRecords])

  // ─── Status tap handler (optimistic) ──────────────────────────────────────

  const handleStatusTap = useCallback(async (
    student: Student,
    status: AttendanceStatus,
    markedBy: string,
  ) => {
    if (!hasSelection || !sessionId) return

    // Don't re-tap same status that's already saved
    const key = student.id
    const current = attMap.get(key)
    if (current?.status === status) return

    // After-hours edit lock (owner request, Session 31): a FIRST mark on a
    // previously-unmarked student is always allowed, however late — this
    // only blocks CHANGING a mark that already exists, once selectedDate's
    // school hours have passed. `current` being truthy is exactly "a mark
    // already exists for this student today," so that's the right and only
    // condition to gate on here — deliberately not gating on isDateLocked
    // alone, which would also wrongly block a legitimate late first mark.
    if (current && isDateLocked) return

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
    // Uses student.class_node_id, NOT selectedClass.id (Session 31 fix,
    // whole-parent view): each student belongs to exactly one leaf class
    // regardless of what's selected in the picker above — for a single-class
    // selection these are identical, but for a combined parent-group
    // register they can differ per row, and getting this wrong would
    // silently mis-file every write from a combined register under the
    // wrong class.
    const params: AttendanceUpsertParams = {
      schoolId,
      studentId: student.id,
      classNodeId: student.class_node_id,
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
  }, [hasSelection, sessionId, selectedDate, attMap, schoolId, isDateLocked])

  // ─── Batch mark-all ────────────────────────────────────────────────────────

  const handleBatchMark = useCallback(async (
    status: AttendanceStatus,
    markedBy: string,
  ) => {
    if (!hasSelection || !sessionId || students.length === 0) return

    // After-hours edit lock, same rule as handleStatusTap: a student with no
    // existing mark is always eligible for mark-all (a batch action is still
    // just "first marks" for them); a student who's already marked is only
    // eligible if selectedDate isn't locked yet. Silently skipping locked
    // students here (rather than aborting the whole batch) matches the
    // per-tap behavior — one locked student shouldn't block marking everyone
    // else who's still eligible.
    const eligibleStudents = students.filter(s => {
      const current = attMap.get(s.id)
      return !current || !isDateLocked
    })
    if (eligibleStudents.length === 0) return

    setBatchSaving(true)

    // Optimistic: update all eligible rows immediately
    const nextMap: AttendanceMap = new Map(attMap)
    eligibleStudents.forEach(s => {
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

    // Each student's own class_node_id, not selectedClass.id — same
    // reasoning as handleStatusTap's write path above.
    const records: AttendanceUpsertParams[] = eligibleStudents.map(s => ({
      schoolId,
      studentId: s.id,
      classNodeId: s.class_node_id,
      markedBy,
      date: selectedDate,
      status,
    }))

    const result = await saveBatchAttendance({ records })
    setBatchSaving(false)

    if (result.queued) {
      const qIds = new Set(queuedIds)
      eligibleStudents.forEach(s => qIds.add(s.id))
      setQueuedIds(qIds)
      return
    }

    if (!result.ok) {
      // Revert to previous map on batch failure
      setAttMap(attMap)
    }
  }, [hasSelection, sessionId, students, selectedDate, attMap, schoolId, queuedIds, isDateLocked])

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

      // student.class_node_id, not selectedClass.id — same Session 31
      // reasoning as the write paths above; also narrower/cheaper than
      // passing the whole effectiveClassIds array for a single student's
      // history strip.
      const result = await loadAttendanceHistory(student.class_node_id, schoolId)
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
  }, [historyOpen, historyData, schoolId])

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

  function renderSuspendedForClass(classId: string) {
    if (!canManageStudents) return null
    const list = suspended.filter(x => x.class_node_id === classId)
    if (list.length === 0) return null

    const isOpen = suspendedOpen.has(classId)
    const schoolRule = {
      mode: suspendedRule?.mode ?? 'consecutive',
      consecutive_threshold: suspendedRule?.consecutive_threshold ?? 5,
      cumulative_threshold: suspendedRule?.cumulative_threshold ?? 5,
    } as const
    const fmtDate = (d: string) =>
      new Date(d.length > 10 ? d : d + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
    const fmtShort = (d: string) =>
      new Date(d + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
    const daysSince = (iso: string) =>
      Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000))
    const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

    return (
      <div className="att-susp-panel">
        <button
          type="button"
          className="att-susp-head"
          onClick={() => toggleSuspendedClass(classId)}
          aria-expanded={isOpen}
        >
          <span className="att-susp-title">Suspended students</span>
          <span className="att-susp-count">{list.length}</span>
          <span className="att-susp-chevron" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
        </button>

        {isOpen && (
          <ul className="att-susp-list">
            {list.map(st => {
              const eff = rulesCtx
                ? resolveEffectiveRule(st.class_node_id, rulesCtx, schoolRule)
                : resolveEffectiveRule(null, { rules: new Map(), parentById: new Map() }, schoolRule)
              const mode = eff.mode
              const threshold = eff.threshold
              const count = mode === 'consecutive' ? st.consecutive_count : st.cumulative_count
              const pct = Math.min(100, Math.round((count / Math.max(1, threshold)) * 100))
              const open = reactivateId === st.student_id
              const days = daysSince(st.inactivated_at)
              return (
                <li key={st.student_id} className="att-susp-item">
                  <div className="att-susp-row">
                    <div className="att-susp-who">
                      <span className="att-susp-name">{st.full_name}</span>
                      <span className="att-susp-class">
                        Suspended {fmtDate(st.inactivated_at)}{st.inactivated_approx ? ' (approx.)' : ''}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      onClick={() => void startReactivate(st)}
                    >
                      {open ? 'Cancel' : 'Reactivate'}
                    </button>
                  </div>

                  {open && (
                    <div className="att-susp-preview">
                      <p className="att-susp-days">
                        Inactive for <strong>{plural(days, 'day')}</strong>
                      </p>

                      <div className="att-susp-bar" role="img"
                        aria-label={`${count} of ${threshold} ${mode} absences`}>
                        <div className="att-susp-bar-fill" style={{ width: `${pct}%` }} />
                      </div>
                      <p className="att-susp-reason">
                        {count} of {threshold} {mode === 'consecutive' ? 'consecutive' : 'total'} absences
                        {st.last_absent_date ? ` · last absent ${fmtShort(st.last_absent_date)}` : ''}
                      </p>

                      {detailLoading && <div className="att-history-skel skeleton" />}

                      {detail && (
                        <>
                          <div className="att-susp-strip" aria-label="Recent school days">
                            {detail.days.map(d => (
                              <span
                                key={d.date}
                                className={[
                                  'att-dot',
                                  d.status ? HISTORY_DOT_CLS[d.status] : 'att-dot--unmarked',
                                ].join(' ')}
                                title={`${fmtShort(d.date)}: ${d.status ?? 'not marked'}`}
                              />
                            ))}
                          </div>

                          <h4 className="att-susp-subhead">Suspension history</h4>
                          {detail.history.length === 0 ? (
                            <p className="att-susp-reason">No history recorded yet.</p>
                          ) : (
                            <ul className="att-susp-history">
                              {detail.history.map(h => (
                                <li key={h.id} className="att-susp-hist-item">
                                  <span className="att-susp-hist-top">
                                    <strong>{h.event === 'inactivated' ? 'Suspended' : 'Reactivated'}</strong>
                                    {' · '}{fmtDate(h.created_at)}{h.approximate ? ' (approx.)' : ''}
                                  </span>
                                  <span className="att-susp-hist-body">
                                    {h.event === 'inactivated'
                                      ? (h.reason === 'attendance_auto'
                                          ? `Automatic — ${h.consecutive_count ?? 0} consecutive / ${h.cumulative_count ?? 0} total absences`
                                          : `Manual${h.note ? ` — ${h.note}` : ''}`)
                                      : (h.note ?? 'No note')}
                                  </span>
                                  <span className="att-susp-hist-by">
                                    {h.changed_by_name
                                      ? `Recorded by ${h.changed_by_name}`
                                      : 'Recorder not available'}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </>
                      )}

                      <ObligationFields
                        value={obligationDraft}
                        onChange={setObligationDraft}
                        disabled={reactivateSaving}
                      />

                      <div className="att-susp-form">
                        <input
                          className="att-susp-note"
                          type="text"
                          value={reactivateNote}
                          onChange={e => setReactivateNote(e.target.value)}
                          placeholder="Why is this student being reactivated?"
                          autoFocus
                        />
                        <button
                          type="button"
                          className="btn btn--primary btn--sm"
                          disabled={reactivateSaving || !reactivateNote.trim()}
                          onClick={() => void confirmReactivate(st.student_id)}
                        >
                          {reactivateSaving ? 'Saving…' : 'Confirm'}
                        </button>
                        {reactivateError && <p className="att-susp-error">{reactivateError}</p>}
                      </div>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    )
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
    // ── Two-tier pill picker (Session 31, owner-locked design) ─────────────
    // Tier 1: parent pills (only rendered when parentGroups is non-empty —
    // a school with a flat, one-level class list has nothing to group by,
    // so this tier is skipped entirely and tier 2 shows every leaf, exactly
    // matching the old <select>'s behavior for that shape of school).
    // Tier 2: class pills, filtered to the selected parent's leaves once one
    // is picked — plus a "whole parent" pill as one more option at that
    // tier (owner-approved Option 2 from this feature's own design pass),
    // never mixed into the same list as individual classes as a synthetic
    // <option> would be in a native <select>.
    // A leaf with no parent_id (parent_id: null) never appears grouped under
    // any parentGroups entry — it always shows in tier 2's "all classes"
    // view (no parent selected) so it's never unreachable.
    //
    // Session 32 follow-up (owner: match/better StudentsModule's own
    // parent-vs-class visual distinction) — tier 1 pills now carry
    // att-pill--parent (compact, uppercase, surface-tinted, left accent
    // bar when active) so which level you're tapping is visually obvious,
    // not just positionally. Tier 2 stays plain .att-pill.
    const visibleLeaves = selectedParentId
      ? classes.filter(c => c.parent_id === selectedParentId)
      : classes
    const activeParent = parentGroups.find(g => g.id === selectedParentId) ?? null

    // ── Collapsed summary bar (Session 31 follow-up: economize phone
    // screen space) — once something's picked and the picker isn't
    // explicitly reopened, show one compact row with the current selection
    // and a "Change" affordance instead of both pill rows. This is the
    // common case on a repeat visit (a teacher almost always wants the same
    // class they marked last time), so collapsing by default here is what
    // actually saves space day to day, not just on first pick.
    if (hasSelection && !pickerExpanded) {
      return (
        <div className="att-selector-wrap">
          <button
            type="button"
            className="att-selector-summary"
            onClick={() => setPickerExpanded(true)}
          >
            <span className="att-selector-summary-label">{effectiveLabel}</span>
            <span className="att-selector-summary-change">
              Change <Icon name="chevron-down" size={14} />
            </span>
          </button>
        </div>
      )
    }

    return (
      <div className="att-selector-wrap">
        <label className="att-selector-label">Class</label>

        {parentGroups.length > 0 && (
          <div className="att-pill-row att-pill-row--parent" role="tablist" aria-label="Filter by grade">
            <button
              type="button"
              className={`att-pill att-pill--parent${selectedParentId === null ? ' att-pill--active' : ''}`}
              onClick={() => setSelectedParentId(null)}
            >
              All
            </button>
            {parentGroups.map(g => (
              <button
                key={g.id}
                type="button"
                className={`att-pill att-pill--parent${selectedParentId === g.id ? ' att-pill--active' : ''}`}
                onClick={() => setSelectedParentId(g.id)}
              >
                {g.name}
              </button>
            ))}
          </div>
        )}

        <div className="att-pill-row att-pill-row--class">
          {/* Session 32 follow-up — whole-school "All classes" pill, the
              school-wide sibling of the "All of {parent}" pill below. Only
              shown when tier 1 isn't narrowed to one parent (selectedParentId
              === null) — once a specific grade is selected, "all classes"
              at the school level doesn't make sense as an option in that
              same row; the "All" pill in tier 1 is how you get back there. */}
          {selectedParentId === null && (
            <button
              type="button"
              className={`att-pill att-pill--group${selectedAllSchool ? ' att-pill--active' : ''}`}
              onClick={selectAllSchool}
            >
              <Icon name="school" size={14} /> All classes (whole school)
            </button>
          )}
          {activeParent && (
            <button
              type="button"
              className={`att-pill att-pill--group${selectedGroup?.id === activeParent.id ? ' att-pill--active' : ''}`}
              onClick={() => selectGroup(activeParent)}
            >
              <Icon name="users" size={14} /> All of {activeParent.name}
            </button>
          )}
          {visibleLeaves.map(c => (
            <button
              key={c.id}
              type="button"
              className={`att-pill${selectedClass?.id === c.id ? ' att-pill--active' : ''}`}
              onClick={() => selectClass(c)}
            >
              {activeParent ? c.name : c.path_label}
            </button>
          ))}
        </div>
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

  // Deliberately NOT disabled by isDateLocked — handleBatchMark() already
  // filters to only students still eligible (unmarked, or marked-but-not-yet-
  // locked) per the same after-hours rule renderStudentRow's buttons use.
  // Hiding this whole bar once the date locks would wrongly block "mark all
  // present" from catching any student someone forgot to mark that day.
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
    // After-hours edit lock (Session 31): only relevant once a mark already
    // exists — an unmarked student is never locked, per the owner's explicit
    // "first mark always allowed" rule (see handleStatusTap's own comment).
    const isRowLocked = !!record && isDateLocked

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
          {(() => {
            const b = canManageStudents ? obligationBadge(pendingObl.get(student.id)) : null
            return b ? <span className="obl-badge" title={b.title}>{b.label}</span> : null
          })()}

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
            {/* Visible lock notice, not a silently-disabled button (§4.3) —
                the whole point of Session 31's fix was making a rejected tap
                visible instead of a mysterious revert. */}
            {isRowLocked && !isSaving && (
              <span
                className="att-locked-badge"
                title="This day's school hours have ended — the mark is now permanent."
                role="img"
                aria-label="Locked: this day's school hours have ended, the mark is now permanent"
              >
                <Icon name="lock" size={14} />
              </span>
            )}
            {STATUS_ORDER.map(status => (
              <button
                key={status}
                disabled={isSaving || !markedBy || !canMark || isRowLocked}
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
    if (!hasSelection) return null

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
          <p className="att-empty-msg">No students enrolled in {effectiveLabel} yet.</p>
          {isAdmin && <p className="att-empty-sub">Add students in the Students module.</p>}
          {effectiveClassIds.map(id => (
            <div key={id} className="att-arm-group">{renderSuspendedForClass(id)}</div>
          ))}
        </div>
      )
    }

    // ── Search-within-register (owner request, Session 31 follow-up:
    // "mark students randomly" — jump straight to one name rather than
    // scrolling a long or combined register). Client-side filter over the
    // already-loaded `students` array — cheap, and correct scope per the
    // owner's own choice: search only within what's currently on screen,
    // not an app-wide student search. Applied to both the flat and grouped
    // (whole-parent) branches below via the same `matchesSearch` filter,
    // so search behaves identically regardless of which view is active.
    const trimmedSearch = studentSearch.trim().toLowerCase()
    const matchesSearch = (s: Student) =>
      trimmedSearch === '' || s.full_name.toLowerCase().includes(trimmedSearch)

    const searchBar = students.length > 5 && (
      <div className="att-search-wrap">
        <span className="att-search-icon" aria-hidden="true">
          <Icon name="search" size={16} />
        </span>
        <input
          type="text"
          className="att-search-input"
          placeholder={`Search in ${effectiveLabel}...`}
          value={studentSearch}
          onChange={e => setStudentSearch(e.target.value)}
        />
        {studentSearch !== '' && (
          <button
            type="button"
            className="att-search-clear"
            aria-label="Clear search"
            onClick={() => setStudentSearch('')}
          >
            <Icon name="x" size={14} />
          </button>
        )}
      </div>
    )

    // Whole-parent view (Session 31, owner-locked design: "one combined
    // register, grouped by arm with sub-headings" — not a flat merge, see
    // this file's own header comment for the full reasoning): group the
    // already-loaded flat student list by class_node_id and render one
    // sub-heading per leaf class, in the same order `classes` (the leaf
    // list) is already sorted in, rather than re-deriving a separate order.
    // Session 32 follow-up extends this same grouped treatment to the new
    // whole-school selection — a school-wide register is the same shape of
    // problem as a whole-parent one (a flat merge across many classes would
    // be unreadable), just with every leaf in the school as the arm list
    // instead of one parent's leafIds.
    if (selectedGroup || selectedAllSchool) {
      const armLeafIds = selectedAllSchool
        ? classes.map(c => c.id)
        : selectedGroup!.leafIds
      const byClassId = new Map<string, Student[]>()
      students.filter(matchesSearch).forEach(s => {
        const arr = byClassId.get(s.class_node_id) ?? []
        arr.push(s)
        byClassId.set(s.class_node_id, arr)
      })
      const arms = armLeafIds
        .filter(id => byClassId.has(id) || suspended.some(x => x.class_node_id === id))
        .map(id => ({
          id,
          name: classes.find(c => c.id === id)?.path_label ?? classes.find(c => c.id === id)?.name ?? 'Class',
          students: byClassId.get(id) ?? [],
        }))

      return (
        <div className="att-register">
          {searchBar}
          {markedBy && !canMark && (
            <div className="att-permission-notice">
              You don't have permission to mark attendance. You can view this register, but changes won't be saved. Contact your admin if this seems wrong.
            </div>
          )}
          {trimmedSearch !== '' && arms.length === 0 && (
            <p className="att-empty-sub">No students match "{studentSearch}".</p>
          )}
          {arms.map(arm => (
            <div key={arm.id} className="att-arm-group">
              <h3 className="att-arm-heading">{arm.name}</h3>
              {arm.students.map(renderStudentRow)}
              {renderSuspendedForClass(arm.id)}
            </div>
          ))}
        </div>
      )
    }

    const filteredStudents = students.filter(matchesSearch)

    return (
      <div className="att-register">
        {searchBar}
        {markedBy && !canMark && (
          <div className="att-permission-notice">
            You don't have permission to mark attendance. You can view this class's register, but changes won't be saved. Contact your admin if this seems wrong.
          </div>
        )}
        {trimmedSearch !== '' && filteredStudents.length === 0 && (
          <p className="att-empty-sub">No students match "{studentSearch}".</p>
        )}
        {filteredStudents.map(renderStudentRow)}
        {selectedClass && renderSuspendedForClass(selectedClass.id)}
      </div>
    )
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="att-root">
      {/* Whole-school analytics — independent of class/date selection below */}
      {renderAnalyticsPanel()}

      {reactivateNotice && (
        <div className="att-permission-notice" role="alert">
          {reactivateNotice}{' '}
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => setReactivateNotice('')}>
            Dismiss
          </button>
        </div>
      )}

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
        {hasSelection && renderDateBar()}

        {/* Summary bar — hidden on a confirmed non-school day (Session 19):
            "0 present" reads as a real gap on a holiday when it isn't one. */}
        {hasSelection && isSelectedDateSchoolDay && renderSummaryBar()}

        {/* Batch mark-all — same reasoning: marking attendance on a holiday
            shouldn't be offered as an action in the first place. */}
        {hasSelection && loadState === 'ready' && isSelectedDateSchoolDay && renderBatchBar()}
      </div>

      {/* Register */}
      <div className="att-body">
        {!hasSelection && classLoadState === 'ready' && (
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
