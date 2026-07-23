/**
 * GuardianPortal.tsx
 * Read-only Guardian/Student portal — §10 Phase 6, §4.9.
 *
 * Renders for actorType 'guardian' or 'student'. First screen is always the child's
 * summary (attendance %, fee balance, latest announcement), never a menu — per §4.4:
 * "First screen after login = their child's summary, not a menu."
 *
 * Guardians with more than one linked child get a switcher at the top; students see
 * only their own data with no switcher.
 *
 * Props: { schoolId, schoolName, actorType, authUserId, initialTab? }
 * initialTab (added for the Schedule bottom-nav slot): lets App.tsx mount
 * this component already open on a specific internal tab — e.g. 'schedule'
 * when the guardian/student taps the relabelled Schedule bottom-nav button,
 * instead of always landing on 'summary'.
 */

import { useEffect, useState, useCallback, useRef, type TouchEvent as ReactTouchEvent } from 'react'
import { Icon } from '../components/icons'
import {
  loadPortalIdentity,
  loadCurrentSession,
  loadTermsForSession,
  loadSchoolUsesTerms,
  loadTermProgress,
  loadAttendanceSummary,
  loadAttendanceCalendarStrip,
  loadStudentResults,
  loadFeeSummary,
  loadPaymentHistory,
  loadPortalAnnouncements,
  formatNaira,
  todayDateString,
  type PortalChild,
  type PortalSession,
  type PortalTerm,
  type TermProgress,
  type AttendanceSummary,
  type AttendanceDay,
  type SubjectResultRow,
  type FeeSummary,
  type PaymentHistoryRow,
  type PortalAnnouncement,
} from '../services/portalService'
import {
  loadStudentTranscript,
  type StudentTranscript,
} from '../services/courseResultsService'
import { downloadTranscriptPdf } from '../services/transcriptPdf'
import { initiateFeesPayment, checkPaymentStatus } from '../services/remitaPortalService'
import { downloadReceiptPdf } from '../services/receiptPdf'
import { loadStudentCourseAttendance, type StudentCourseAttendanceRow } from '../services/courseAttendanceService'
import {
  loadTimetableData,
  loadCurrentSession as loadTimetableCurrentSession,
  getCurrentPeriod,
  dayName,
  type TimetableEntry,
  type Period,
  type WeekDay,
} from '../services/timetableService'
import { TermProgressCard } from '../components/TermProgressCard'
// SESSION 69: reused byte-for-byte from the admin flow, not reimplemented --
// see RegistrationTab below for why reuse (not a leaner rebuild) is required.
import { RegistrationStep } from './CourseRegistrationModule'
import { type StudentSearchResult, loadCurrentSession as loadSettingsCurrentSession } from '../services/settingsService'
// FIX (higher-ed Schedule tab routing gap, then owner-revised 2026-07-23):
// the Schedule tab previously called TimetableModuleHigherEd directly
// (that component's own student-facing path was already fully built and
// wired to loadOfferingsForStudent(), but nothing in this file ever
// rendered it -- ScheduleTab below unconditionally called the
// SECONDARY-school timetableService.ts and filtered by child.class_node_id,
// which is always null for a higher-ed student, SESSION 64 -- so every
// higher-ed student/guardian permanently saw "isn't assigned to a class
// yet"). Reusing TimetableModuleHigherEd's full grid+edit+Modal component
// tree here is what then surfaced a real, separate bug (App.tsx's
// GuardianPortal call sites had no key prop, so React never remounted
// between bottom-nav taps -- fixed at its own root in App.tsx). Per the
// owner's explicit direction afterward: rather than keep depending on that
// whole component tree for a read-only view, fetch only the display fields
// a student/guardian actually needs (day, course, time, lecturer, venue)
// via loadStudentSchedule() and render a small dedicated UI here instead --
// see HigherEdScheduleTab below. TimetableModuleHigherEd itself is
// untouched and still serves its own real audience (admin/lecturer), just
// no longer imported into this file.
import { loadStudentSchedule, type StudentScheduleEntry } from '../services/courseOfferingTimetableService'

// SESSION 60b: 'results' is the secondary-school subject/CA/exam view
// (loadStudentResults -> scores/subject_results). 'transcript' is its
// higher-ed replacement (loadStudentTranscript -> course_results/
// student_gpa_snapshots) — the two are mutually exclusive per school, per
// the owner's explicit direction this session ("replace... entirely for
// higher-ed schools", not add alongside). PORTAL_TABS below is built
// per-render from schoolType rather than being a fixed array, since which
// of the two tabs exists depends on which academic engine this school
// runs — see buildPortalTabs() below.
type PortalTab = 'summary' | 'results' | 'transcript' | 'attendance' | 'fees' | 'schedule' | 'announcements' | 'registration'

interface GuardianPortalProps {
  schoolId: string
  schoolName: string
  actorType: 'guardian' | 'student' | 'staff' | 'platform_admin' | null
  authUserId: string
  /**
   * Which internal port-tab to open on mount. Defaults to 'summary'.
   * Added so App.tsx's bottom-nav 'timetable' slot (relabelled "Schedule"
   * for guardian/student in BottomNav.tsx) can route straight into this
   * component's own 'schedule' tab instead of the staff TimetableModule —
   * GuardianPortal is a single mounted instance per Home/Schedule tap, not
   * a route per se, so "which tab" has to travel in as a prop.
   */
  initialTab?: PortalTab
  /**
   * SESSION 60b, new: same school_type value App.tsx already threads into
   * ResultsModule/SettingsModule/CourseRegistrationModule/
   * CourseAttendanceModule (see isHigherEd below, matching those files'
   * own duplicated ['university','polytechnic','college_of_education',
   * 'other'] check — that list isn't exported anywhere shared per those
   * files' own comments, so this is the same deliberate duplication, not
   * a missed import). Optional/nullable because this prop did not exist
   * before this session — every App.tsx call site must be updated to pass
   * it, and until all four are, this component still needs to degrade
   * gracefully to the secondary-school 'results' tab rather than crash.
   */
  schoolType?: string | null
}

type BootState = 'loading' | 'ready' | 'no-children' | 'error'

export default function GuardianPortal({ schoolId, schoolName, authUserId, initialTab, schoolType }: GuardianPortalProps) {
  // Same isHigherEd check App.tsx's MoreSheetContent/CourseRegistrationModule/
  // CourseAttendanceModule already duplicate locally (see this file's own
  // header note on schoolType above for why it's not a shared import).
  const isHigherEd = !!schoolType && ['university', 'polytechnic', 'college_of_education', 'other'].includes(schoolType)

  const [bootState, setBootState] = useState<BootState>('loading')
  const [isStudentSelf, setIsStudentSelf] = useState(false)
  const [selfName, setSelfName] = useState('')
  const [children, setChildren] = useState<PortalChild[]>([])
  const [selectedChildId, setSelectedChildId] = useState<string | null>(null)
  const [session, setSession] = useState<PortalSession | null>(null)
  const [terms, setTerms] = useState<PortalTerm[]>([])
  const [usesTerms, setUsesTerms] = useState(true)
  const [termProgress, setTermProgress] = useState<TermProgress | null>(null)
  const [tab, setTab] = useState<PortalTab>(initialTab ?? 'summary')

  const boot = useCallback(async () => {
    setBootState('loading')
    try {
      const identity = await loadPortalIdentity(authUserId, schoolId)
      const [sess, terms_] = await Promise.all([
        loadCurrentSession(schoolId),
        loadSchoolUsesTerms(schoolId),
      ])
      setSession(sess)
      setUsesTerms(terms_)
      if (sess && terms_) {
        setTerms(await loadTermsForSession(sess.id))
      }
      // School-wide, not per-child (a term/session applies to the whole
      // school) — fetched once here rather than inside SummaryTab, so it
      // doesn't re-fetch on every child switch. Failure here shouldn't sink
      // the whole portal boot, since every other summary card already
      // degrades gracefully on its own — TermProgressCard itself renders
      // nothing when passed null.
      loadTermProgress(schoolId).then(setTermProgress).catch(() => setTermProgress(null))

      if (identity.kind === 'student') {
        setIsStudentSelf(true)
        setSelfName(identity.child.full_name)
        setChildren([identity.child])
        setSelectedChildId(identity.child.id)
        setBootState('ready')
      } else if (identity.kind === 'guardian') {
        setIsStudentSelf(false)
        setSelfName(identity.selfName)
        setChildren(identity.children)
        setSelectedChildId(identity.children[0]?.id ?? null)
        setBootState(identity.children.length === 0 ? 'no-children' : 'ready')
      } else {
        setBootState('error')
      }
    } catch {
      setBootState('error')
    }
  }, [authUserId, schoolId])

  useEffect(() => {
    boot()
  }, [boot])

  const selectedChild = children.find((c) => c.id === selectedChildId) ?? null

  if (bootState === 'loading') {
    return (
      <div className="port-root">
        <div className="port-skel-header" />
        <div className="port-skel-card" />
        <div className="port-skel-card" />
      </div>
    )
  }

  if (bootState === 'error') {
    return (
      <div className="port-error-state">
        <span className="port-error-icon"><Icon name="alert-triangle" size={32} style={{ color: 'var(--color-warning, #d97706)' }} /></span>
        <p className="port-error-text">Couldn't load your portal. Check your connection, then try again.</p>
        <button className="port-retry-btn" onClick={boot}>Retry</button>
      </div>
    )
  }

  if (bootState === 'no-children') {
    return (
      <div className="port-empty-state">
        <span className="port-empty-icon"><Icon name="users" size={40} /></span>
        <p className="port-empty-title">No linked children yet</p>
        <p className="port-empty-desc">
          Once the school links a student to your account, their results, attendance, and fees will appear here.
        </p>
      </div>
    )
  }

  return (
    <div className="port-root">
      <div className="dash-greeting">
        <span className="dash-greeting-line">{getGreeting()},</span>
        <span className="dash-greeting-name">{selfName.split(' ')[0] || (isStudentSelf ? 'there' : 'there')}</span>
      </div>

      {!isStudentSelf && children.length > 1 && (
        <div className="port-child-switcher">
          {children.map((c) => (
            <button
              key={c.id}
              className={`port-child-chip ${c.id === selectedChildId ? 'port-child-chip--active' : ''}`}
              onClick={() => setSelectedChildId(c.id)}
            >
              {c.full_name.split(' ')[0]}
            </button>
          ))}
        </div>
      )}

      {selectedChild && (
        <ChildDetail
          schoolId={schoolId}
          schoolName={schoolName}
          child={selectedChild}
          session={session}
          terms={terms}
          usesTerms={usesTerms}
          termProgress={termProgress}
          tab={tab}
          onTabChange={setTab}
          isHigherEd={isHigherEd}
          isStudentSelf={isStudentSelf}
        />
      )}
    </div>
  )
}

// ─── Per-child detail (summary + tabs) ─────────────────────────────────────

// SESSION 60b: 'results' and 'transcript' are mutually exclusive — a
// school runs one academic engine or the other (§3.16's single-branch-
// point rule), so building the tab list per-render off isHigherEd is the
// correct shape here, not a fixed array with a tab hidden/disabled. Order
// otherwise unchanged from the pre-existing array.
// SESSION 69: 'registration' is added only when isHigherEd (secondary schools
// have no self-service course registration concept -- their subject/class
// assignment is admin-driven) AND only isStudentSelf (a guardian must never
// register courses on a child's behalf -- this is the student's own academic
// decision, matching the same "student, not guardian" restriction the new
// RLS write policy on course_registrations already enforces server-side;
// this tab visibility is the client-side mirror of that same boundary, not
// a substitute for it).
function buildPortalTabs(isHigherEd: boolean, isStudentSelf: boolean): PortalTab[] {
  const base: PortalTab[] = ['summary', isHigherEd ? 'transcript' : 'results', 'attendance', 'schedule', 'fees', 'announcements']
  if (isHigherEd && isStudentSelf) {
    // Placed right after 'transcript' -- a student's two academic-record
    // actions (see grades, manage registration) sit next to each other,
    // ahead of the more logistical attendance/fees/news tabs.
    base.splice(2, 0, 'registration')
  }
  return base
}

const PORTAL_TAB_LABELS: Record<PortalTab, string> = {
  summary: 'Summary',
  results: 'Results',
  transcript: 'Transcript',
  attendance: 'Attendance',
  schedule: 'Schedule',
  fees: 'Fees',
  announcements: 'News',
  registration: 'Register',
}

// Minimum horizontal drag (px) before a swipe commits to switching tabs,
// rather than being treated as a scroll/tap. Vertical drags beyond this
// same threshold cancel the swipe entirely, so vertical page-scrolling
// inside a tab (e.g. a long results list) isn't hijacked.
const SWIPE_COMMIT_PX = 50

function ChildDetail({
  schoolId,
  schoolName,
  child,
  session,
  terms,
  usesTerms,
  termProgress,
  tab,
  onTabChange,
  isHigherEd,
  isStudentSelf,
}: {
  schoolId: string
  schoolName: string
  child: PortalChild
  session: PortalSession | null
  terms: PortalTerm[]
  usesTerms: boolean
  termProgress: TermProgress | null
  tab: PortalTab
  onTabChange: (t: PortalTab) => void
  isHigherEd: boolean
  isStudentSelf: boolean
}) {
  const PORTAL_TABS = buildPortalTabs(isHigherEd, isStudentSelf)
  const activeIndex = PORTAL_TABS.indexOf(tab)

  // Tracks which tabs have ever been opened. A tab's panel only mounts (and
  // therefore only fires its data-loading effect) the first time it's
  // visited — same cost as today's conditional render — but once mounted it
  // stays mounted so swiping between visited tabs doesn't re-fetch and has
  // real rendered content to slide against instead of an empty pane.
  const [visited, setVisited] = useState<Set<PortalTab>>(() => new Set([tab]))
  useEffect(() => {
    setVisited((prev) => (prev.has(tab) ? prev : new Set(prev).add(tab)))
  }, [tab])

  const [dragX, setDragX] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [startRef, setStartRef] = useState<{ x: number; y: number } | null>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const tabsScrollRef = useRef<HTMLDivElement | null>(null)
  // One ref per tab button, so the underline can slide to each button's real
  // measured position instead of assuming equal-width tabs — labels like
  // "Attendance" and "News" differ enough in width that a uniform-fraction
  // underline would visibly drift out from under the text.
  const tabBtnRefs = useRef<Record<PortalTab, HTMLButtonElement | null>>({} as Record<PortalTab, HTMLButtonElement | null>)

  const onTouchStart = useCallback((e: ReactTouchEvent<HTMLDivElement>) => {
    const t = e.touches[0]
    setStartRef({ x: t.clientX, y: t.clientY })
    setDragging(true)
  }, [setStartRef])

  const onTouchMove = useCallback((e: ReactTouchEvent<HTMLDivElement>) => {
    if (!startRef) return
    const t = e.touches[0]
    const dx = t.clientX - startRef.x
    const dy = t.clientY - startRef.y
    // Vertical intent beats horizontal — let the page scroll normally.
    if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 10) return
    // Don't allow dragging past the first/last tab.
    const atStart = activeIndex === 0 && dx > 0
    const atEnd = activeIndex === PORTAL_TABS.length - 1 && dx < 0
    setDragX(atStart || atEnd ? dx / 3 : dx)
  }, [startRef, activeIndex])

  const onTouchEnd = useCallback(() => {
    if (Math.abs(dragX) > SWIPE_COMMIT_PX) {
      const dir = dragX < 0 ? 1 : -1
      const nextIndex = activeIndex + dir
      if (nextIndex >= 0 && nextIndex < PORTAL_TABS.length) {
        onTabChange(PORTAL_TABS[nextIndex])
      }
    }
    setDragX(0)
    setDragging(false)
    setStartRef(null)
  }, [dragX, activeIndex, onTabChange, setStartRef])

  const trackOffset = `calc(${-activeIndex * 100}% + ${dragX}px)`

  // Continuous drag progress toward the neighboring tab, in [-1, 1]. Driving
  // both the underline position and the header text-color preview from this
  // same value (rather than a separate 50px on/off threshold) is what makes
  // the header visually track the finger 1:1, in sync with the body — a
  // threshold-only header stayed frozen until the exact commit point, then
  // jumped, while the body moved continuously from the first pixel of drag.
  const viewportWidth = viewportRef.current?.offsetWidth || 1
  const dragT = Math.max(-1, Math.min(1, dragX / viewportWidth))
  const neighborIndex = dragT < 0 ? activeIndex + 1 : activeIndex - 1
  const previewTab =
    Math.abs(dragT) > 0.5 && neighborIndex >= 0 && neighborIndex < PORTAL_TABS.length
      ? PORTAL_TABS[neighborIndex]
      : tab

  const activeBtn = tabBtnRefs.current[tab]
  const neighborBtn =
    neighborIndex >= 0 && neighborIndex < PORTAL_TABS.length ? tabBtnRefs.current[PORTAL_TABS[neighborIndex]] : null
  const progress = Math.abs(dragT)
  const underlineLeft =
    activeBtn && neighborBtn
      ? activeBtn.offsetLeft + (neighborBtn.offsetLeft - activeBtn.offsetLeft) * progress
      : activeBtn?.offsetLeft ?? 0
  const underlineWidth =
    activeBtn && neighborBtn
      ? activeBtn.offsetWidth + (neighborBtn.offsetWidth - activeBtn.offsetWidth) * progress
      : activeBtn?.offsetWidth ?? 0

  // The header strip scrolls horizontally on its own (more tabs than fit on
  // a narrow screen). Swiping the body can land on — or preview — a tab
  // whose label isn't currently scrolled into view in that strip, which is
  // exactly the gap being fixed here: the underline/text-color already
  // track the right tab, but the header itself needs to physically scroll
  // so that tab's label is visible too, not just its indicator.
  useEffect(() => {
    const container = tabsScrollRef.current
    const btn = tabBtnRefs.current[previewTab]
    if (!container || !btn) return
    const containerLeft = container.scrollLeft
    const containerRight = containerLeft + container.clientWidth
    const btnLeft = btn.offsetLeft
    const btnRight = btnLeft + btn.offsetWidth
    if (btnLeft < containerLeft) {
      container.scrollTo({ left: btnLeft - 12, behavior: dragging ? 'auto' : 'smooth' })
    } else if (btnRight > containerRight) {
      container.scrollTo({ left: btnRight - container.clientWidth + 12, behavior: dragging ? 'auto' : 'smooth' })
    }
  }, [previewTab, dragging])

  return (
    <div className="port-child-detail">
      <div className="port-child-header">
        <div className="port-child-avatar">{child.full_name.charAt(0)}</div>
        <div>
          <p className="port-child-name">{child.full_name}</p>
          <p className="port-child-meta">{child.class_path_label}</p>
        </div>
      </div>

      <div className="port-tabs" ref={tabsScrollRef}>
        <div className="port-tabs-scroll">
          {PORTAL_TABS.map((t) => (
            <button
              key={t}
              ref={(el) => { tabBtnRefs.current[t] = el }}
              className={`port-tab ${previewTab === t ? 'port-tab--active' : ''}`}
              onClick={() => onTabChange(t)}
            >
              {PORTAL_TAB_LABELS[t]}
            </button>
          ))}
          <div
            className="port-tab-underline"
            style={{
              transform: `translateX(${underlineLeft}px)`,
              width: `${underlineWidth}px`,
              transition: dragging ? 'none' : 'transform 0.15s ease, width 0.15s ease',
            }}
          />
        </div>
      </div>

      <div className="port-tab-viewport" ref={viewportRef}>
        <div
          className={`port-tab-track ${dragging ? 'port-tab-track--dragging' : ''}`}
          style={{ transform: `translateX(${trackOffset})` }}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
        >
          {PORTAL_TABS.map((t) => (
            <div className="port-tab-content" key={t} aria-hidden={tab !== t} inert={tab !== t}>
              {!visited.has(t) ? null : t === 'summary' ? (
                <SummaryTab schoolId={schoolId} child={child} session={session} termProgress={termProgress} onSeeAll={onTabChange} isHigherEd={isHigherEd} />
              ) : t === 'results' ? (
                <ResultsTab schoolId={schoolId} child={child} session={session} terms={terms} usesTerms={usesTerms} />
              ) : t === 'transcript' ? (
                <TranscriptTab schoolName={schoolName} child={child} />
              ) : t === 'registration' ? (
                <RegistrationTab schoolId={schoolId} child={child} />
              ) : t === 'attendance' ? (
                isHigherEd ? (
                  <CourseAttendanceTab child={child} session={session} />
                ) : (
                  <AttendanceTab schoolId={schoolId} child={child} session={session} />
                )
              ) : t === 'schedule' ? (
                isHigherEd ? (
                  // child.id is students.id for both a guardian and a
                  // student-self viewer -- safe under migration 002's
                  // guardian-read RLS policy on course_registrations/
                  // course_offering_timetable_entries (scoped through
                  // student_guardians), same as before. No isStudentSelf
                  // branching needed here at all: HigherEdScheduleTab is a
                  // plain read-only view with no admin/lecturer concept to
                  // accidentally fall into (unlike TimetableModuleHigherEd,
                  // which this replaced -- see this file's own import-block
                  // note for the full history).
                  <HigherEdScheduleTab schoolId={schoolId} child={child} />
                ) : (
                  <ScheduleTab child={child} />
                )
              ) : t === 'fees' ? (
                <FeesTab schoolId={schoolId} schoolName={schoolName} child={child} session={session} isStudentSelf={isStudentSelf} isHigherEd={isHigherEd} />
              ) : (
                <AnnouncementsTab schoolId={schoolId} />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Summary tab — the first thing a parent sees (§4.4) ───────────────────

function SummaryTab({
  schoolId,
  child,
  session,
  termProgress,
  onSeeAll,
  isHigherEd,
}: {
  schoolId: string
  child: PortalChild
  session: PortalSession | null
  termProgress: TermProgress | null
  onSeeAll: (t: PortalTab) => void
  isHigherEd: boolean
}) {
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [attendance, setAttendance] = useState<AttendanceSummary | null>(null)
  const [fees, setFees] = useState<FeeSummary | null>(null)
  const [latestAnnouncement, setLatestAnnouncement] = useState<PortalAnnouncement | null>(null)

  useEffect(() => {
    let cancelled = false
    async function run() {
      if (!session) {
        setLoadState('ready')
        return
      }
      setLoadState('loading')
      try {
        const [att, fee, anns] = await Promise.all([
          loadAttendanceSummary(schoolId, child.id, session.start_date, todayCapped(session.end_date)),
          loadFeeSummary(schoolId, child.id, session.id),
          loadPortalAnnouncements(schoolId, 1),
        ])
        if (cancelled) return
        setAttendance(att)
        setFees(fee)
        setLatestAnnouncement(anns[0] ?? null)
        setLoadState('ready')
      } catch {
        if (!cancelled) setLoadState('error')
      }
    }
    run()
    return () => { cancelled = true }
  }, [schoolId, child.id, session])

  if (loadState === 'loading') {
    return (
      <div className="port-summary">
        <TermProgressCard progress={termProgress} />
        <div className="port-skel-card" />
        <div className="port-skel-card" />
      </div>
    )
  }

  if (loadState === 'error') {
    return <p className="port-form-error">Couldn't load summary — check your connection and try again.</p>
  }

  return (
    <div className="port-summary">
      <TermProgressCard progress={termProgress} />

      <button className="port-summary-card" onClick={() => onSeeAll('attendance')}>
        <p className="port-summary-card-label">Attendance this session</p>
        {attendance && attendance.totalMarkable > 0 ? (
          <>
            <p className="port-summary-card-value">{attendance.percent}%</p>
            <p className="port-summary-card-context">
              Present {attendance.present} of {attendance.totalMarkable} marked days
              {attendance.totalSchoolDays > 0 && ` (out of ${attendance.totalSchoolDays} school days so far)`}
            </p>
          </>
        ) : (
          <p className="port-summary-card-context">No attendance recorded yet this session.</p>
        )}
        <span className="port-summary-card-arrow">›</span>
      </button>

      <button className="port-summary-card" onClick={() => onSeeAll('fees')}>
        <p className="port-summary-card-label">Fee balance</p>
        {fees && fees.totalBilled > 0 ? (
          <>
            <p className={`port-summary-card-value ${fees.balance > 0 ? 'port-summary-card-value--warn' : 'port-summary-card-value--ok'}`}>
              {formatNaira(fees.balance)}
            </p>
            <p className="port-summary-card-context">
              {formatNaira(fees.totalPaid)} paid of {formatNaira(fees.totalBilled - fees.totalDiscount)} billed
            </p>
          </>
        ) : (
          <p className="port-summary-card-context">No fees assigned yet this session.</p>
        )}
        <span className="port-summary-card-arrow">›</span>
      </button>

      <button className="port-summary-card" onClick={() => onSeeAll('announcements')}>
        <p className="port-summary-card-label">Latest announcement</p>
        {latestAnnouncement ? (
          <>
            <p className="port-summary-card-value port-summary-card-value--text">{latestAnnouncement.title}</p>
            <p className="port-summary-card-context">{relativeTime(latestAnnouncement.posted_at)}</p>
          </>
        ) : (
          <p className="port-summary-card-context">No announcements yet.</p>
        )}
        <span className="port-summary-card-arrow">›</span>
      </button>

      {isHigherEd ? (
        <button className="port-summary-card port-summary-card--muted" onClick={() => onSeeAll('transcript')}>
          <p className="port-summary-card-label">Transcript</p>
          <p className="port-summary-card-context">View {child.full_name.split(' ')[0]}'s courses, grades, and CGPA →</p>
        </button>
      ) : (
        <button className="port-summary-card port-summary-card--muted" onClick={() => onSeeAll('results')}>
          <p className="port-summary-card-label">Results</p>
          <p className="port-summary-card-context">View {child.full_name.split(' ')[0]}'s latest scores and grades →</p>
        </button>
      )}
    </div>
  )
}

// ─── Results tab (§4.9 — grade, position, component breakdown) ────────────

function ResultsTab({
  schoolId,
  child,
  session,
  terms,
  usesTerms,
}: {
  schoolId: string
  child: PortalChild
  session: PortalSession | null
  terms: PortalTerm[]
  usesTerms: boolean
}) {
  const [selectedTermId, setSelectedTermId] = useState<string | null>(terms[0]?.id ?? null)
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [results, setResults] = useState<SubjectResultRow[]>([])
  const [expandedSubject, setExpandedSubject] = useState<string | null>(null)

  useEffect(() => {
    if (terms.length > 0 && !selectedTermId) setSelectedTermId(terms[0].id)
  }, [terms, selectedTermId])

  useEffect(() => {
    let cancelled = false
    async function run() {
      if (!session || (usesTerms && terms.length > 0 && !selectedTermId)) return
      setLoadState('loading')
      try {
        const rows = await loadStudentResults(schoolId, child.id, session.id, usesTerms ? selectedTermId : null)
        if (!cancelled) {
          setResults(rows)
          setLoadState('ready')
        }
      } catch {
        if (!cancelled) setLoadState('error')
      }
    }
    run()
    return () => { cancelled = true }
  }, [schoolId, child.id, session, selectedTermId, usesTerms, terms.length])

  if (!session) {
    return <p className="port-empty-inline">No active session yet — results will appear once the school sets one up.</p>
  }

  return (
    <div className="port-results">
      {usesTerms && terms.length > 0 && (
        <div className="port-term-bar">
          {terms.map((t) => (
            <button
              key={t.id}
              className={`port-term-pill ${t.id === selectedTermId ? 'port-term-pill--active' : ''}`}
              onClick={() => setSelectedTermId(t.id)}
            >
              {t.name}
            </button>
          ))}
        </div>
      )}

      {loadState === 'loading' && (
        <>
          <div className="port-skel-card" />
          <div className="port-skel-card" />
        </>
      )}

      {loadState === 'error' && (
        <p className="port-form-error">Couldn't load results — check your connection and try again.</p>
      )}

      {loadState === 'ready' && results.length === 0 && (
        <p className="port-empty-inline">
          No approved results yet for this {usesTerms ? 'term' : 'session'}. They'll appear here once the school publishes them.
        </p>
      )}

      {loadState === 'ready' &&
        results.map((r) => (
          <div key={r.subject_id} className="port-result-card">
            <button
              className="port-result-card-header"
              onClick={() => setExpandedSubject(expandedSubject === r.subject_id ? null : r.subject_id)}
            >
              <div>
                <p className="port-result-subject">{r.subject_name}</p>
                {r.position_in_class !== null && r.class_size !== null && (
                  <p className="port-result-position">
                    {ordinal(r.position_in_class)} of {r.class_size} in class
                  </p>
                )}
              </div>
              <div className="port-result-score-block">
                {r.weighted_total !== null && (
                  <p className="port-result-score">{r.weighted_total.toFixed(1)}</p>
                )}
                {r.grade_label && <span className="port-result-grade-pill">{r.grade_label}</span>}
              </div>
            </button>
            {expandedSubject === r.subject_id && (
              <div className="port-result-breakdown">
                {r.components.map((c, i) => (
                  <div key={i} className="port-result-component-row">
                    <span className="port-result-component-name">
                      {c.component_name} <span className="port-result-component-weight">({c.weight_pct}%)</span>
                    </span>
                    <span className="port-result-component-value">{c.value}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
    </div>
  )
}

// ─── Transcript tab (SESSION 60b — higher-ed replacement for Results) ─────
//
// Screen + PDF, course/grade/GP/CGPA only, per that session's own scope.
// Deliberately excluded here (see SESSION 60b's card): CA/exam component
// breakdown (depends on whether a school has configured SESSION 60a's
// per-component weighting — showing final grade/GP only is a legitimate
// transcript format on its own, not a placeholder) and any academic-
// standing/status line (SESSION 61/62's own scope — CGPA is an objective
// computed fact, standing is a policy judgment requiring human review,
// kept as two separate concerns per standard registrar practice).
//
// No new computation performed anywhere in this component —
// loadStudentTranscript() only re-displays student_gpa_snapshots/
// course_results rows SESSION 60's finalize flow already computed and
// cached, per §4.1's caching discipline.

function TranscriptTab({
  schoolName,
  child,
}: {
  schoolName: string
  child: PortalChild
}) {
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [transcript, setTranscript] = useState<StudentTranscript | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function run() {
      setLoadState('loading')
      try {
        const { data, error } = await loadStudentTranscript(child.id)
        if (cancelled) return
        if (error || !data) {
          setLoadState('error')
          return
        }
        setTranscript(data)
        setLoadState('ready')
      } catch {
        if (!cancelled) setLoadState('error')
      }
    }
    run()
    return () => { cancelled = true }
  }, [child.id])

  const handleDownload = () => {
    if (!transcript) return
    setDownloadError(null)
    setDownloading(true)
    try {
      downloadTranscriptPdf({ schoolName, transcript })
    } catch {
      setDownloadError("Couldn't generate the PDF — try again.")
    } finally {
      setDownloading(false)
    }
  }

  if (loadState === 'loading') {
    return (
      <>
        <div className="port-skel-card" />
        <div className="port-skel-card" />
      </>
    )
  }

  if (loadState === 'error') {
    return <p className="port-form-error">Couldn't load the transcript — check your connection and try again.</p>
  }

  if (!transcript) return null

  return (
    <div className="port-transcript">
      <div className="port-transcript-header">
        <div>
          <p className="port-transcript-student">{transcript.student_name}</p>
          <p className="port-transcript-matric">Matric No: {transcript.matric_number ?? '—'}</p>
        </div>
        <button
          className="port-transcript-download-btn"
          onClick={handleDownload}
          disabled={downloading}
        >
          <Icon name="graduation-cap" size={16} />
          {downloading ? 'Preparing…' : 'Download PDF'}
        </button>
      </div>
      {downloadError && <p className="port-form-error">{downloadError}</p>}

      <div className="port-transcript-cgpa-card">
        <p className="port-transcript-cgpa-label">Cumulative GPA (CGPA)</p>
        <p className="port-transcript-cgpa-value">
          {transcript.cgpa === null ? '—' : transcript.cgpa.toFixed(2)}
        </p>
        {transcript.cgpa !== null && (
          <p className="port-transcript-cgpa-detail">
            Units attempted: {transcript.cgpa_total_units_attempted ?? '—'} · Quality points:{' '}
            {transcript.cgpa_total_quality_points?.toFixed(2) ?? '—'}
          </p>
        )}
      </div>

      {transcript.semesters.length === 0 && (
        <p className="port-empty-inline">
          No finalized courses yet. They'll appear here once your lecturer finalizes a score.
        </p>
      )}

      {transcript.semesters.map((semester) => (
        <div key={`${semester.session_id}|${semester.term_id ?? ''}`} className="port-transcript-semester-card">
          <div className="port-transcript-semester-header">
            <p className="port-transcript-semester-title">
              {semester.term_name ? `${semester.session_name} — ${semester.term_name}` : semester.session_name}
            </p>
            <p className="port-transcript-semester-gpa">
              {semester.gpa === null ? 'GPA: —' : `GPA: ${semester.gpa.toFixed(2)}`}
            </p>
          </div>
          <div className="port-transcript-course-list">
            {semester.courses.map((c) => (
              <div
                key={c.registration_id}
                className={`port-transcript-course-row ${c.is_superseded ? 'port-transcript-course-row--superseded' : ''}`}
              >
                <div className="port-transcript-course-main">
                  <span className="port-transcript-course-code">{c.course_code}</span>
                  <span className="port-transcript-course-title">{c.course_title}</span>
                </div>
                <div className="port-transcript-course-meta">
                  <span>{c.credit_units} units</span>
                  {c.letter_grade && <span className="port-transcript-course-grade-pill">{c.letter_grade}</span>}
                  {c.grade_point !== null && <span>{c.grade_point.toFixed(2)} GP</span>}
                </div>
                {(c.is_carryover || c.is_superseded) && (
                  <div className="port-transcript-course-tags">
                    {c.is_carryover && <span className="port-transcript-tag">Carryover</span>}
                    {c.is_superseded && <span className="port-transcript-tag port-transcript-tag--superseded">Superseded</span>}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Registration tab (SESSION 69 — higher-ed self-service course registration) ──

// A thin adapter, not a reimplementation: RegistrationStep (imported from
// CourseRegistrationModule, exported there for exactly this reuse) already
// contains every rule this needs -- placement resolution, term selection,
// core/elective/carryover curriculum logic, credit-load cap checking, and
// the save call itself. That reuse is load-bearing, not just convenient:
// registerStudent() replaces the student's full registration set for the
// session+term with whatever course list it's given, silently withdrawing
// anything left out -- safe only because RegistrationStep's own mount
// effect loads and pre-checks existing registrations before any save is
// possible, so the diff it computes always matches what the student
// actually saw. A leaner rebuild here would risk silently dropping that
// load-existing-state step and turning a normal save into silent data loss.
//
// child comes from loadPortalIdentity() (via GuardianPortal's boot()),
// already scoped to this school_id and already confirmed to be the signed-in
// student's own record when isStudentSelf is true -- no second identity
// resolution needed here. Only { id, full_name } are read anywhere inside
// RegistrationStep (confirmed by direct inspection of that file); matric_number
// is read only by StudentSearchStep, which this tab never renders, since a
// student doesn't search for themselves.
function RegistrationTab({
  schoolId,
  child,
}: {
  schoolId: string
  child: PortalChild
}) {
  // NOTE: matric_number's exact type (required string vs. nullable) can't be
  // confirmed without settingsService.ts, where StudentSearchResult is
  // actually declared -- not uploaded to this session. Using `null` here
  // is a real, unverified assumption, not a safe placeholder: if that field
  // is a required non-null string, this line will fail to compile (correctly),
  // and if it's optional/nullable, this line is fine as-is. Left uncast
  // deliberately so `npm run build` surfaces the true answer rather than
  // this comment silently papering over a real mismatch.
  const selfAsStudent: StudentSearchResult = { id: child.id, full_name: child.full_name, matric_number: null }

  return (
    <div className="port-registration">
      <RegistrationStep schoolId={schoolId} student={selfAsStudent} onBack={() => {}} />
    </div>
  )
}

// ─── Attendance tab (§4.9 — percentage, count relative to total, calendar strip) ──

function AttendanceTab({
  schoolId,
  child,
  session,
}: {
  schoolId: string
  child: PortalChild
  session: PortalSession | null
}) {
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [summary, setSummary] = useState<AttendanceSummary | null>(null)
  const [strip, setStrip] = useState<AttendanceDay[]>([])
  const [compareOpen, setCompareOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function run() {
      if (!session) {
        setLoadState('ready')
        return
      }
      setLoadState('loading')
      try {
        const [sum, days] = await Promise.all([
          loadAttendanceSummary(schoolId, child.id, session.start_date, todayCapped(session.end_date)),
          loadAttendanceCalendarStrip(schoolId, child.id),
        ])
        if (cancelled) return
        setSummary(sum)
        setStrip(days)
        setLoadState('ready')
      } catch {
        if (!cancelled) setLoadState('error')
      }
    }
    run()
    return () => { cancelled = true }
  }, [schoolId, child.id, session])

  if (!session) {
    return <p className="port-empty-inline">No active session yet.</p>
  }

  if (loadState === 'loading') {
    return <div className="port-skel-card" />
  }

  if (loadState === 'error') {
    return <p className="port-form-error">Couldn't load attendance — check your connection and try again.</p>
  }

  return (
    <div className="port-attendance">
      <div className="port-attendance-ring-card">
        <AttendanceRing percent={summary?.percent ?? null} />
        <div>
          {summary && summary.totalMarkable > 0 ? (
            <>
              <p className="port-attendance-headline">
                Present {summary.present} out of {summary.totalMarkable} marked days
                {summary.totalSchoolDays > 0 && ` (${summary.totalSchoolDays} school days this session so far)`}
              </p>
              <p className="port-attendance-breakdown">
                {summary.absent} absent · {summary.late} late · {summary.excused} excused
              </p>
            </>
          ) : (
            <p className="port-attendance-headline">No attendance recorded yet this session.</p>
          )}
        </div>
      </div>

      {summary && summary.totalMarkable > 0 && summary.classAveragePercent !== null && (
        <ClassComparisonChip
          childPercent={summary.percent}
          classAveragePercent={summary.classAveragePercent}
          open={compareOpen}
          onToggle={() => setCompareOpen((o) => !o)}
        />
      )}

      {strip.length > 0 && (
        <div className="port-strip">
          <p className="port-strip-label">Last 30 days</p>
          <div className="port-strip-row">
            {strip.map((d) => {
              const isToday = d.date === todayDateString()
              return (
                <div key={d.date} className="port-strip-day">
                  <span
                    className={[
                      'port-strip-dot',
                      `port-strip-dot--${d.status}`,
                      isToday ? 'port-strip-dot--today' : '',
                    ].join(' ').trim()}
                    title={`${d.date}: ${stripDotTitle(d.status)}`}
                  />
                  <span className={['port-strip-date-label', isToday ? 'port-strip-date-label--today' : ''].join(' ').trim()}>
                    {d.date.slice(8)}{/* day-of-month only, matches staff-side att-history-date-label */}
                  </span>
                </div>
              )
            })}
          </div>
          <div className="port-strip-legend">
            <span><i className="port-strip-dot port-strip-dot--present" /> Present</span>
            <span><i className="port-strip-dot port-strip-dot--absent" /> Absent</span>
            <span><i className="port-strip-dot port-strip-dot--late" /> Late</span>
            <span><i className="port-strip-dot port-strip-dot--excused" /> Excused</span>
            <span><i className="port-strip-dot port-strip-dot--no_school" /> No school</span>
          </div>
        </div>
      )}
    </div>
  )
}

function CourseAttendanceTab({
  child,
  session,
}: {
  child: PortalChild
  session: PortalSession | null
}) {
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [rows, setRows] = useState<StudentCourseAttendanceRow[]>([])

  useEffect(() => {
    let cancelled = false
    async function run() {
      if (!session) {
        setLoadState('ready')
        return
      }
      setLoadState('loading')
      // FIX (tsc build error, confirmed pre-existing before this session's
      // own changes): this previously destructured { ok, data, error } as
      // a flat object, but Result<T> here is the same discriminated union
      // every other service in this file uses (Ok<T> | Err) — data only
      // exists on the ok:true branch, error only on ok:false. Matches the
      // if (!res.ok) { ...; return } pattern already used correctly a few
      // dozen lines below in HigherEdScheduleTab, rather than a fresh
      // pattern invented here.
      const res = await loadStudentCourseAttendance({
        studentId: child.id,
        sessionId: session.id,
      })
      if (cancelled) return
      if (!res.ok) {
        console.error('loadStudentCourseAttendance failed:', res.error)
        setLoadState('error')
        return
      }
      setRows(res.data)
      setLoadState('ready')
    }
    run()
    return () => { cancelled = true }
  }, [child.id, session])

  if (!session) {
    return <p className="port-empty-inline">No active session yet.</p>
  }

  if (loadState === 'loading') {
    return (
      <>
        <div className="port-skel-card" />
        <div className="port-skel-card" />
      </>
    )
  }

  if (loadState === 'error') {
    return <p className="port-form-error">Couldn't load attendance — check your connection and try again.</p>
  }

  if (rows.length === 0) {
    return <p className="port-empty-inline">No courses registered for the current session yet.</p>
  }

  return (
    <div className="port-course-attendance">
      <p className="port-fee-section-title">This session's courses</p>
      <div className="port-course-attendance-list">
        {rows.map((r) => (
          <div key={r.courseOfferingId} className="port-course-attendance-row">
            <div className="port-course-attendance-info">
              <p className="port-course-attendance-title">
                {r.courseCode} · {r.courseTitle}
              </p>
              <p className="port-course-attendance-lecturer">
                {r.lecturerName ?? 'Lecturer not yet assigned'}
              </p>
              <p className="port-course-attendance-meta">
                {r.totalSessions === 0
                  ? 'No sessions held yet'
                  : `${r.presentCount} of ${r.totalSessions} sessions attended`}
                {r.thresholdPct !== null && r.percent !== null && (
                  <> · Threshold {r.thresholdPct}%</>
                )}
              </p>
            </div>
            <div
              className={[
                'port-course-attendance-percent',
                r.meetsThreshold === false ? 'port-course-attendance-percent--warn' : '',
                r.meetsThreshold === true ? 'port-course-attendance-percent--ok' : '',
              ].join(' ').trim()}
            >
              {r.percent === null ? '—' : `${r.percent}%`}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function stripDotTitle(status: AttendanceDay['status']): string {
  if (status === 'no_school') return 'no school that day'
  if (status === 'unmarked') return 'not marked yet'
  return status
}

// ─── Class comparison chip — "how does this compare" context (§4.4/§4.9) ──

function ClassComparisonChip({
  childPercent,
  classAveragePercent,
  open,
  onToggle,
}: {
  childPercent: number | null
  classAveragePercent: number
  open: boolean
  onToggle: () => void
}) {
  if (childPercent === null) return null
  const diff = Math.round((childPercent - classAveragePercent) * 10) / 10
  const tone = diff > 0.5 ? 'port-compare--above' : diff < -0.5 ? 'port-compare--below' : 'port-compare--even'
  const label =
    diff > 0.5
      ? `${diff}% above the class average`
      : diff < -0.5
        ? `${Math.abs(diff)}% below the class average`
        : `about even with the class average`

  return (
    <button
      type="button"
      className={`port-compare ${tone} ${open ? 'port-compare--open' : ''}`}
      onClick={onToggle}
      aria-expanded={open}
    >
      <span className="port-compare-label">Compared to class</span>
      {open ? (
        <span className="port-compare-value">
          {label} <span className="port-compare-sub">({classAveragePercent}% class average)</span>
        </span>
      ) : (
        <span className="port-compare-value port-compare-value--collapsed">Tap to see how this compares to the class</span>
      )}
      <span className="port-compare-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
    </button>
  )
}

function AttendanceRing({ percent }: { percent: number | null }) {
  const pct = percent ?? 0
  const r = 28
  const circumference = 2 * Math.PI * r
  const offset = circumference * (1 - pct / 100)
  return (
    <svg viewBox="0 0 70 70" className="port-ring">
      <circle cx="35" cy="35" r={r} className="port-ring-bg" />
      {percent !== null && (
        <circle
          cx="35"
          cy="35"
          r={r}
          className="port-ring-fg"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
        />
      )}
      <text x="35" y="40" textAnchor="middle" className="port-ring-text">
        {percent !== null ? `${percent}%` : '—'}
      </text>
    </svg>
  )
}

// ─── Schedule tab — read-only timetable for the child's own class ─────────
// Reuses timetableService.ts as-is (loadTimetableData/getCurrentPeriod/dayName)
// rather than a new service file. loadTimetableData() returns entries for the
// whole school; filtered client-side to the child's class_node_id, same
// "no new query, filter what's already loaded" pattern findConflictingEntryIds
// already uses in that file. No edit chrome, no teacher-view toggle — a
// guardian only ever sees one class's week, never the admin grid.

function ScheduleTab({ child }: { child: PortalChild }) {
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [periods, setPeriods] = useState<Period[]>([])
  const [weekDays, setWeekDays] = useState<WeekDay[]>([])
  const [entries, setEntries] = useState<TimetableEntry[]>([])
  const [live, setLive] = useState<{ periodId: string | null; dayOfWeek: number } | null>(null)

  const classNodeId = child.class_node_id

  useEffect(() => {
    let cancelled = false
    async function run() {
      if (!classNodeId) {
        setLoadState('ready')
        return
      }
      setLoadState('loading')
      try {
        const sess = await loadTimetableCurrentSession()
        if (!sess.ok || !sess.sessionId) {
          if (!cancelled) setLoadState('ready')
          return
        }
        const tt = await loadTimetableData(sess.sessionId)
        if (cancelled) return
        if (!tt.ok || !tt.data) {
          setLoadState('error')
          return
        }
        setPeriods(tt.data.periods)
        setWeekDays(tt.data.weekDays)
        setEntries(tt.data.entries.filter((e) => e.class_node_id === classNodeId))
        setLive(getCurrentPeriod(tt.data.periods, tt.data.weekDays))
        setLoadState('ready')
      } catch {
        if (!cancelled) setLoadState('error')
      }
    }
    run()
    return () => { cancelled = true }
  }, [classNodeId])

  if (!classNodeId) {
    return <p className="port-empty-inline">{child.full_name.split(' ')[0]} isn't assigned to a class yet.</p>
  }

  if (loadState === 'loading') {
    return <div className="port-skel-card" />
  }

  if (loadState === 'error') {
    return <p className="port-form-error">Couldn't load the timetable — check your connection and try again.</p>
  }

  const teachingDays = weekDays
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((wd) => wd.day_of_week)

  if (teachingDays.length === 0 || entries.length === 0) {
    return <p className="port-empty-inline">No timetable has been set up for this class yet.</p>
  }

  const nonBreakPeriods = periods.filter((p) => !p.is_break).sort((a, b) => a.sort_order - b.sort_order)

  return (
    <div className="port-schedule">
      {teachingDays.map((dow) => {
        const dayEntries = entries.filter((e) => e.day_of_week === dow)
        const isToday = live?.dayOfWeek === dow
        if (dayEntries.length === 0) return null
        return (
          <div key={dow} className={`port-sched-day ${isToday ? 'port-sched-day--today' : ''}`}>
            <p className="port-sched-day-label">{dayName(dow)}{isToday && <span className="port-sched-today-chip">Today</span>}</p>
            <div className="port-sched-list">
              {nonBreakPeriods.map((p) => {
                const entry = dayEntries.find((e) => e.period_id === p.id)
                if (!entry) return null
                const isLive = isToday && live?.periodId === p.id
                return (
                  <div key={p.id} className={`port-sched-row ${isLive ? 'port-sched-row--live' : ''}`}>
                    <span className="port-sched-time">{formatTime(p.start_time)}</span>
                    <div className="port-sched-row-main">
                      <p className="port-sched-subject">{entry.subject_name ?? 'Free period'}</p>
                      {entry.staff_name && <p className="port-sched-teacher">{entry.staff_name}</p>}
                    </div>
                    {isLive && <span className="port-sched-live-dot" aria-hidden="true" />}
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function formatTime(hhmmss: string): string {
  const [h, m] = hhmmss.split(':').map(Number)
  const period = h < 12 ? 'am' : 'pm'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${String(m).padStart(2, '0')}${period}`
}

// ─── Higher-ed schedule tab (owner request, 2026-07-23) ────────────────────
//
// Deliberately NOT a reuse of TimetableModuleHigherEd here — that component
// carries the full admin/lecturer grid, edit chrome, conflict-detection
// state, and its own Modal, none of which a read-only student/guardian view
// needs. Reusing it inside GuardianPortal's tab tree is what surfaced the
// stuck-tab/stray-modal bug this session already found and fixed at its
// real root (App.tsx's GuardianPortal call sites, missing key props) — but
// per the owner's explicit direction, the simpler, correct long-term shape
// is to fetch only the display fields a read-only view needs (day, course,
// time, lecturer, venue) via loadStudentSchedule() (new, composed from two
// already-correct existing functions — see courseOfferingTimetableService.ts)
// and render a small dedicated UI here instead, matching the layout/CSS
// classes ScheduleTab (the secondary-school sibling) already established —
// port-schedule/port-sched-day/port-sched-row family — plus one new class,
// port-sched-venue, for the one field ScheduleTab never had a need for.
//
// No "current period" live-highlight here (unlike ScheduleTab): a
// higher-ed school has no fixed shared period grid to compute "the current
// period" against (§7.27's own schema note — course_offering_timetable_entries
// stores arbitrary, non-period-aligned start/end times per entry), so
// "isLive" isn't a coherent concept for this view; each entry's own
// start/end time is shown directly instead.

function HigherEdScheduleTab({ schoolId, child }: { schoolId: string; child: PortalChild }) {
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading')
  const [errorMsg, setErrorMsg] = useState('')
  const [entries, setEntries] = useState<StudentScheduleEntry[]>([])
  // Owner request (2026-07-23): rows collapsed by default, tap to reveal
  // lecturer/venue -- a plain Set of expanded entry ids rather than a
  // single "which one" value, since more than one day's rows can
  // reasonably be open at once (this is a list, not an accordion where
  // opening one should close another).
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())

  function toggleExpanded(entryId: string) {
    setExpandedIds(prev => {
      const next = new Set(prev)
      if (next.has(entryId)) next.delete(entryId)
      else next.add(entryId)
      return next
    })
  }

  useEffect(() => {
    let cancelled = false
    async function run() {
      setLoadState('loading')
      setErrorMsg('')

      const sessionRes = await loadSettingsCurrentSession(schoolId)
      if (cancelled) return
      if (sessionRes.error) {
        setLoadState('error')
        setErrorMsg(sessionRes.error)
        return
      }
      if (!sessionRes.data) {
        setLoadState('error')
        setErrorMsg('No current session found.')
        return
      }

      // Matches TimetableModuleHigherEd's own student-path call shape
      // exactly — sessionId only, no termId — see this file's own note
      // where HigherEdScheduleTab is wired in for why that isn't silently
      // changed here.
      const res = await loadStudentSchedule({
        studentId: child.id,
        sessionId: sessionRes.data.id,
      })
      if (cancelled) return
      if (!res.ok) {
        setLoadState('error')
        setErrorMsg(res.error)
        return
      }
      setEntries(res.data)
      setLoadState(res.data.length > 0 ? 'ready' : 'empty')
    }
    run()
    return () => { cancelled = true }
  }, [schoolId, child.id])

  if (loadState === 'loading') {
    return <div className="port-skel-card" />
  }

  if (loadState === 'error') {
    return <p className="port-form-error">Couldn't load the timetable — {errorMsg || 'check your connection and try again.'}</p>
  }

  if (loadState === 'empty') {
    return <p className="port-empty-inline">No timetable has been set up for {child.full_name.split(' ')[0]}'s registered courses yet.</p>
  }

  const teachingDays = Array.from(new Set(entries.map(e => e.day_of_week))).sort((a, b) => a - b)

  return (
    <div className="port-schedule">
      {teachingDays.map((dow) => {
        const dayEntries = entries
          .filter((e) => e.day_of_week === dow)
          .sort((a, b) => a.start_time.localeCompare(b.start_time))
        if (dayEntries.length === 0) return null
        return (
          <div key={dow} className="port-sched-day">
            <p className="port-sched-day-label">{dayName(dow)}</p>
            <div className="port-sched-list">
              {dayEntries.map((entry) => {
                // Nothing to reveal for an entry with neither field set —
                // no expand affordance shown at all rather than a chevron
                // that opens onto an empty panel.
                const hasDetail = !!entry.staff_name || !!entry.venue
                const isExpanded = hasDetail && expandedIds.has(entry.id)
                return (
                  <div key={entry.id} className={`port-sched-row ${hasDetail ? 'port-sched-row--expandable' : ''} ${isExpanded ? 'port-sched-row--expanded' : ''}`}>
                    <button
                      type="button"
                      className="port-sched-row-summary"
                      onClick={hasDetail ? () => toggleExpanded(entry.id) : undefined}
                      aria-expanded={hasDetail ? isExpanded : undefined}
                      disabled={!hasDetail}
                    >
                      <span className="port-sched-time">{formatTime(entry.start_time)} – {formatTime(entry.end_time)}</span>
                      <p className="port-sched-subject">{entry.course_code} — {entry.course_title}</p>
                      {hasDetail && (
                        <span className="port-sched-row-chevron" aria-hidden="true">{isExpanded ? '▾' : '▸'}</span>
                      )}
                    </button>
                    {isExpanded && (
                      <div className="port-sched-row-detail">
                        {entry.staff_name && <p className="port-sched-teacher">{entry.staff_name}</p>}
                        {entry.venue && <p className="port-sched-venue">{entry.venue}</p>}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── Fees tab (§4.9 — billed, paid, balance, breakdown, payment history) ──

function FeesTab({
  schoolId,
  schoolName,
  child,
  session,
  isStudentSelf,
  isHigherEd,
}: {
  schoolId: string
  schoolName: string
  child: PortalChild
  session: PortalSession | null
  isStudentSelf: boolean
  isHigherEd: boolean
}) {
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [summary, setSummary] = useState<FeeSummary | null>(null)
  const [history, setHistory] = useState<PaymentHistoryRow[]>([])
  const [showHistory, setShowHistory] = useState(false)
  // Pay Now is gated to isStudentSelf — matching the owner's locked
  // self-service-only decision (master plan §12): a guardian can view a
  // child's fees but must never trigger a payment on their behalf, since
  // remita-initiate-payment itself rejects any caller that doesn't resolve
  // to actor_type='student' anyway — this is the client-side mirror of that
  // same server-side boundary, not a substitute for it.
  const [payState, setPayState] = useState<'idle' | 'starting' | 'error'>('idle')
  const [payError, setPayError] = useState<string | null>(null)
  const [checkingRrr, setCheckingRrr] = useState<string | null>(null)

  const reload = useCallback(async () => {
    if (!session) {
      setLoadState('ready')
      return
    }
    setLoadState('loading')
    try {
      const [sum, hist] = await Promise.all([
        loadFeeSummary(schoolId, child.id, session.id, isHigherEd),
        loadPaymentHistory(schoolId, child.id),
      ])
      setSummary(sum)
      setHistory(hist)
      setLoadState('ready')
    } catch {
      setLoadState('error')
    }
  }, [schoolId, child.id, session, isHigherEd])

  useEffect(() => {
    let cancelled = false
    async function run() {
      if (!session) {
        setLoadState('ready')
        return
      }
      setLoadState('loading')
      try {
        const [sum, hist] = await Promise.all([
          loadFeeSummary(schoolId, child.id, session.id, isHigherEd),
          loadPaymentHistory(schoolId, child.id),
        ])
        if (cancelled) return
        setSummary(sum)
        setHistory(hist)
        setLoadState('ready')
      } catch {
        if (!cancelled) setLoadState('error')
      }
    }
    run()
    return () => { cancelled = true }
  }, [schoolId, child.id, session, isHigherEd])

  async function handlePayNow(feeAssignmentIds: string[]) {
    setPayState('starting')
    setPayError(null)
    try {
      const result = await initiateFeesPayment(feeAssignmentIds)
      // Real navigation, not a fetch — the payment page is Remita's own
      // hosted checkout (card/USSD/bank-transfer/eNaira channel selection),
      // not something this app renders itself.
      window.location.href = result.paymentPageUrl
    } catch (e) {
      setPayState('error')
      setPayError(e instanceof Error ? e.message : 'Could not start payment. Please try again.')
    }
  }

  async function handleCheckStatus(rrr: string) {
    setCheckingRrr(rrr)
    try {
      await checkPaymentStatus(rrr)
    } catch {
      // Swallowed deliberately: whether verification resolved it or not,
      // reload() below re-fetches the real current state from the DB —
      // that's the source of truth, not whatever this call returned. A
      // transient network failure here shouldn't block the refresh.
    } finally {
      await reload()
      setCheckingRrr(null)
    }
  }

  if (!session) {
    return <p className="port-empty-inline">No active session yet.</p>
  }

  if (loadState === 'loading') {
    return <div className="port-skel-card" />
  }

  if (loadState === 'error') {
    return <p className="port-form-error">Couldn't load fees — check your connection and try again.</p>
  }

  if (!summary || (summary.breakdown.length === 0 && summary.pendingPayments.length === 0)) {
    return <p className="port-empty-inline">No fees assigned yet this session.</p>
  }

  // Every payable assignment across every fee head with an outstanding
  // balance — this is what "Pay all outstanding" sends in one RRR.
  const allPayableIds = summary.breakdown.flatMap((b) => b.payableAssignments.map((p) => p.fee_assignment_id))

  return (
    <div className="port-fees">
      <div className="port-fee-balance-card">
        <p className="port-fee-balance-label">Balance</p>
        <p className={`port-fee-balance-value ${summary.balance > 0 ? 'port-fee-balance-value--warn' : 'port-fee-balance-value--ok'}`}>
          {formatNaira(summary.balance)}
        </p>
        <p className="port-fee-balance-context">
          Billed {formatNaira(summary.totalBilled)}
          {summary.totalDiscount > 0 && ` · Discount ${formatNaira(summary.totalDiscount)}`}
          {' · '}Paid {formatNaira(summary.totalPaid)}
        </p>
        {isStudentSelf && summary.balance > 0 && allPayableIds.length > 0 && (
          <button
            className="port-fee-pay-now-btn"
            disabled={payState === 'starting'}
            onClick={() => handlePayNow(allPayableIds)}
          >
            {payState === 'starting' ? 'Starting payment…' : `Pay ${formatNaira(summary.balance)} now`}
          </button>
        )}
        {payState === 'error' && payError && (
          <p className="port-form-error">{payError}</p>
        )}
      </div>

      {summary.pendingPayments.length > 0 && (
        <div className="port-fee-pending-card">
          <p className="port-fee-section-title">Awaiting confirmation</p>
          {summary.pendingPayments.map((p) => (
            <div key={p.id} className="port-fee-pending-row">
              <div>
                <p className="port-fee-pending-amount">{formatNaira(p.amount)}</p>
                <p className="port-fee-pending-meta">
                  {p.fee_head_name ?? 'Payment'} · Ref {p.provider_reference ?? '—'} · Started {formatDate(p.created_at)}
                </p>
              </div>
              {isStudentSelf && p.provider_reference && (
                <button
                  className="port-fee-check-status-btn"
                  disabled={checkingRrr === p.provider_reference}
                  onClick={() => handleCheckStatus(p.provider_reference!)}
                >
                  {checkingRrr === p.provider_reference ? 'Checking…' : 'Check status'}
                </button>
              )}
            </div>
          ))}
          <p className="port-fee-pending-hint">
            Paid at a bank counter, USSD, or transfer? Tap "Check status" to confirm it — this can take a few minutes to reflect.
          </p>
        </div>
      )}

      <p className="port-fee-section-title">By fee</p>
      <div className="port-fee-list">
        {summary.breakdown.map((b) => (
          <div key={b.fee_head_id} className="port-fee-row">
            <div>
              <p className="port-fee-row-name">{b.fee_head_name}</p>
              <p className="port-fee-row-meta">
                Billed {formatNaira(b.billed)}
                {b.discount > 0 && ` · Discount ${formatNaira(b.discount)}`}
                {' · '}Paid {formatNaira(b.paid)}
              </p>
            </div>
            <div className="port-fee-row-right">
              <p className={`port-fee-row-balance ${b.balance > 0 ? 'port-fee-row-balance--warn' : 'port-fee-row-balance--ok'}`}>
                {formatNaira(b.balance)}
              </p>
              {isStudentSelf && b.balance > 0 && b.payableAssignments.length > 0 && (
                <button
                  className="port-fee-row-pay-btn"
                  disabled={payState === 'starting'}
                  onClick={() => handlePayNow(b.payableAssignments.map((p) => p.fee_assignment_id))}
                >
                  Pay
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      <button className="port-fee-history-toggle" onClick={() => setShowHistory((s) => !s)}>
        {showHistory ? 'Hide payment history' : `Show payment history (${history.length})`}
      </button>

      {showHistory && (
        <div className="port-fee-history-list">
          {history.length === 0 && <p className="port-empty-inline">No payments recorded yet.</p>}
          {history.map((p) => (
            <div key={p.id} className="port-fee-history-row">
              <div>
                <p className="port-fee-history-amount">{formatNaira(p.amount)}</p>
                <p className="port-fee-history-meta">
                  {p.fee_head_name ?? 'Payment'} · {p.paid_at ? formatDate(p.paid_at) : 'Pending'} · {methodLabel(p.method)}
                </p>
                {p.notes && <p className="port-fee-history-notes">{p.notes}</p>}
              </div>
              <button
                className="port-fee-receipt-btn"
                onClick={() =>
                  downloadReceiptPdf({
                    schoolName,
                    studentName: child.full_name,
                    payment: p,
                  })
                }
              >
                Receipt
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Announcements tab (§4.9 — filtered to their audience) ─────────────────

function AnnouncementsTab({ schoolId }: { schoolId: string }) {
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [items, setItems] = useState<PortalAnnouncement[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function run() {
      setLoadState('loading')
      try {
        const data = await loadPortalAnnouncements(schoolId, 30)
        if (!cancelled) {
          setItems(data)
          setLoadState('ready')
        }
      } catch {
        if (!cancelled) setLoadState('error')
      }
    }
    run()
    return () => { cancelled = true }
  }, [schoolId])

  if (loadState === 'loading') {
    return <div className="port-skel-card" />
  }
  if (loadState === 'error') {
    return <p className="port-form-error">Couldn't load announcements — check your connection and try again.</p>
  }
  if (items.length === 0) {
    return <p className="port-empty-inline">No announcements yet.</p>
  }

  return (
    <div className="port-ann-list">
      {items.map((a) => (
        <button
          key={a.id}
          className="port-ann-row"
          onClick={() => setExpanded(expanded === a.id ? null : a.id)}
        >
          <div className="port-ann-row-top">
            <p className="port-ann-row-title">{a.title}</p>
            {a.is_expired && <span className="port-ann-expired-chip">Expired</span>}
          </div>
          <p className="port-ann-row-time">{relativeTime(a.posted_at)}</p>
          {expanded === a.id && <p className="port-ann-row-body">{a.body}</p>}
        </button>
      ))}
    </div>
  )
}

// ─── Pure formatting helpers ────────────────────────────────────────────────

function getGreeting(): string {
  const hour = new Date().getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 17) return 'Good afternoon'
  return 'Good evening'
}

function todayCapped(endDate: string): string {
  const today = todayDateString()
  return today < endDate ? today : endDate
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diffMs / 60000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(iso).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-NG', { day: '2-digit', month: 'short', year: 'numeric' })
}

function methodLabel(method: string): string {
  const labels: Record<string, string> = {
    cash: 'Cash',
    bank_transfer: 'Bank transfer',
    card: 'Card',
    paystack: 'Paystack',
    flutterwave: 'Flutterwave',
    ussd: 'USSD',
    remita: 'Remita',
  }
  return labels[method] ?? method
}
