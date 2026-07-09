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
  loadTimetableData,
  loadCurrentSession as loadTimetableCurrentSession,
  getCurrentPeriod,
  dayName,
  type TimetableEntry,
  type Period,
  type WeekDay,
} from '../services/timetableService'
import { TermProgressCard } from '../components/TermProgressCard'

type PortalTab = 'summary' | 'results' | 'attendance' | 'fees' | 'schedule' | 'announcements'

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
}

type BootState = 'loading' | 'ready' | 'no-children' | 'error'

export default function GuardianPortal({ schoolId, authUserId, initialTab }: GuardianPortalProps) {
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
          child={selectedChild}
          session={session}
          terms={terms}
          usesTerms={usesTerms}
          termProgress={termProgress}
          tab={tab}
          onTabChange={setTab}
        />
      )}
    </div>
  )
}

// ─── Per-child detail (summary + 4 tabs) ───────────────────────────────────

const PORTAL_TABS: PortalTab[] = ['summary', 'results', 'attendance', 'schedule', 'fees', 'announcements']
const PORTAL_TAB_LABELS: Record<PortalTab, string> = {
  summary: 'Summary',
  results: 'Results',
  attendance: 'Attendance',
  schedule: 'Schedule',
  fees: 'Fees',
  announcements: 'News',
}

// Minimum horizontal drag (px) before a swipe commits to switching tabs,
// rather than being treated as a scroll/tap. Vertical drags beyond this
// same threshold cancel the swipe entirely, so vertical page-scrolling
// inside a tab (e.g. a long results list) isn't hijacked.
const SWIPE_COMMIT_PX = 50

function ChildDetail({
  schoolId,
  child,
  session,
  terms,
  usesTerms,
  termProgress,
  tab,
  onTabChange,
}: {
  schoolId: string
  child: PortalChild
  session: PortalSession | null
  terms: PortalTerm[]
  usesTerms: boolean
  termProgress: TermProgress | null
  tab: PortalTab
  onTabChange: (t: PortalTab) => void
}) {
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
                <SummaryTab schoolId={schoolId} child={child} session={session} termProgress={termProgress} onSeeAll={onTabChange} />
              ) : t === 'results' ? (
                <ResultsTab schoolId={schoolId} child={child} session={session} terms={terms} usesTerms={usesTerms} />
              ) : t === 'attendance' ? (
                <AttendanceTab schoolId={schoolId} child={child} session={session} />
              ) : t === 'schedule' ? (
                <ScheduleTab child={child} />
              ) : t === 'fees' ? (
                <FeesTab schoolId={schoolId} child={child} session={session} />
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
}: {
  schoolId: string
  child: PortalChild
  session: PortalSession | null
  termProgress: TermProgress | null
  onSeeAll: (t: PortalTab) => void
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

      <button className="port-summary-card port-summary-card--muted" onClick={() => onSeeAll('results')}>
        <p className="port-summary-card-label">Results</p>
        <p className="port-summary-card-context">View {child.full_name.split(' ')[0]}'s latest scores and grades →</p>
      </button>
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

// ─── Fees tab (§4.9 — billed, paid, balance, breakdown, payment history) ──

function FeesTab({
  schoolId,
  child,
  session,
}: {
  schoolId: string
  child: PortalChild
  session: PortalSession | null
}) {
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [summary, setSummary] = useState<FeeSummary | null>(null)
  const [history, setHistory] = useState<PaymentHistoryRow[]>([])
  const [showHistory, setShowHistory] = useState(false)

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
          loadFeeSummary(schoolId, child.id, session.id),
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
  }, [schoolId, child.id, session])

  if (!session) {
    return <p className="port-empty-inline">No active session yet.</p>
  }

  if (loadState === 'loading') {
    return <div className="port-skel-card" />
  }

  if (loadState === 'error') {
    return <p className="port-form-error">Couldn't load fees — check your connection and try again.</p>
  }

  if (!summary || summary.breakdown.length === 0) {
    return <p className="port-empty-inline">No fees assigned yet this session.</p>
  }

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
      </div>

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
            <p className={`port-fee-row-balance ${b.balance > 0 ? 'port-fee-row-balance--warn' : 'port-fee-row-balance--ok'}`}>
              {formatNaira(b.balance)}
            </p>
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
                  {p.fee_head_name ?? 'Payment'} · {formatDate(p.paid_at)} · {methodLabel(p.method)}
                </p>
                {p.notes && <p className="port-fee-history-notes">{p.notes}</p>}
              </div>
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
  }
  return labels[method] ?? method
}
