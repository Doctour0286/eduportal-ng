// src/routes/TeacherDashboard.tsx
// Phase 6 — Teacher Dashboard (PRD Tier 4 / Problem 4.1 / SESSION 14,
// expanded SESSION 17 per owner follow-up: collapsible cards + payslip access)
//
// Structural model: AdminDashboard.tsx (header/greeting, section labels,
// stat cards, quick actions, announcements) for overall page rhythm — but
// the "cards before Quick Actions" section requested this session is a new
// pattern for this file: collapsible rectangular cards, one per topic,
// closed by default except "My Schedule Today" during an active session.
//
// The schedule card's expand/collapse + live countdown behavior is
// deliberately modeled on the PRD's own documented spec for
// LivePeriodWidget.tsx (Problem 6.4 / SESSION 26 — `.live-banner`, dot
// indicator, live countdown, tick off Date.now() against already-fetched
// data, no per-second network calls, prefers-reduced-motion respected) —
// that widget is separate, later, timetable-module-wide scope (shows every
// class at once); this card is a smaller, teacher-scoped instance of the
// same interaction language, built now because the owner asked for it here.
// When SESSION 26 ships the real widget, both should be checked for a
// possible shared-hook extraction — not done preemptively here since that
// widget doesn't exist yet to share code with.
//
// Data sources, each reused from its owning service, never re-derived:
//   - Their assigned classes:      hrService.ts's loadStaffTeachingAssignments()
//   - Their pending score submissions: scores where entered_by = self (§7.14)
//   - Today's + full-week timetable: timetableService.ts's loadTimetableData(),
//     getCurrentPeriod(), dayName() — reused, not re-derived
//   - School announcements:        announcementsService.ts's loadAnnouncements()
//   - Payslip visibility + own payslips: hrService.ts's Session 17 additions
//     (loadPayrollVisibilitySettings, loadMyPayslips, setMyPayslipCardHidden)
//
// No browser-only APIs. Zustand only for cross-cutting state (school),
// per §5 — matches AdminDashboard.tsx's own useSchoolStore usage exactly.

import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useSchoolStore } from '../stores/schoolStore';
import { useAuthStore } from '../stores/authStore';
import { Icon } from '../components/icons';
import {
  loadTimetableData,
  loadCurrentSession,
  getCurrentPeriod,
  dayName,
  type TimetableEntry,
  type Period,
  type WeekDay,
} from '../services/timetableService';
import {
  loadStaffTeachingAssignments,
  loadPayrollVisibilitySettings,
  loadMyPayslips,
  setMyPayslipCardHidden,
  type TeachingAssignment,
  type Payslip,
} from '../services/hrService';
import { loadAnnouncements, type Announcement as ServiceAnnouncement } from '../services/announcementsService';
import { loadTermProgress, type TermProgress } from '../services/portalService';
import { TermProgressCard } from '../components/TermProgressCard';

// ─── Types ────────────────────────────────────────────────────────────────────

interface TeacherStats {
  classCount: number;          // distinct class_node_id among this teacher's current-session assignments
  subjectCount: number;        // distinct subject_id among the same
  pendingScoreCount: number;   // scores.entered_by = self, approved_at is null
}

// Local, dashboard-sized shape — announcementsService.ts's Announcement type
// carries more fields (class_node_name, posted_by_name, is_expired, etc.)
// than this card needs; narrowed here the same way AdminDashboard.tsx defines
// its own local Announcement interface rather than importing the full one.
interface DashAnnouncement {
  id: string;
  title: string;
  body: string;
  audience: string;
  posted_at: string;
}

// A pending-score group, one row per subject+class the teacher still has
// unapproved entries for — computed client-side from `scores`, not a stored
// view (§7.14's own convention: "computed values are views, not columns").
interface PendingScoreGroup {
  subject_id: string;
  subject_name: string;
  class_node_id: string;
  class_name: string;
  count: number;
}

// ─── Skeleton (same convention as AdminDashboard.tsx) ─────────────────────────

function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton ${className}`} />;
}

// ─── Stat Card (identical component contract to AdminDashboard.tsx's) ─────────

interface StatCardProps {
  label: string;
  value: string | number;
  sub?: string;
  icon: React.ReactNode;
  loading?: boolean;
  accent?: 'green' | 'blue' | 'amber' | 'purple';
}

function StatCard({ label, value, sub, icon, loading, accent = 'blue' }: StatCardProps) {
  return (
    <div className={`dash-stat-card dash-stat-card--${accent}`}>
      <div className="dash-stat-icon">{icon}</div>
      <div className="dash-stat-body">
        <div className="dash-stat-label">{label}</div>
        {loading ? (
          <Skeleton className="dash-stat-value-skel" />
        ) : (
          <div className="dash-stat-value">{value}</div>
        )}
        {sub && !loading && <div className="dash-stat-sub">{sub}</div>}
      </div>
    </div>
  );
}

// ─── Action Badge (reused pattern — pending scores' collapsed summary reuses
// this same visual language as its "needs attention" trigger) ─────────────

interface ActionItem {
  label: string;
  count: number;
  urgency: 'normal' | 'warning' | 'urgent';
  route: DashboardNavTarget;
}

function ActionBadge({ item, onClick }: { item: ActionItem; onClick: () => void }) {
  if (item.count === 0) return null;
  return (
    <button
      className={`dash-action-badge dash-action-badge--${item.urgency}`}
      onClick={onClick}
      type="button"
    >
      <span className="dash-action-count">{item.count}</span>
      <span className="dash-action-label">{item.label}</span>
      <span className="dash-action-arrow">›</span>
    </button>
  );
}

// ─── Quick Action Button (identical component contract to AdminDashboard.tsx's) ─

interface QuickActionProps {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}

function QuickAction({ icon, label, onClick }: QuickActionProps) {
  return (
    <button className="dash-quick-action" type="button" onClick={onClick}>
      <span className="dash-quick-icon">{icon}</span>
      <span className="dash-quick-label">{label}</span>
    </button>
  );
}

// ─── Announcement Card (identical markup/classes to AdminDashboard.tsx's, so
// the two dashboards' announcement sections are visually indistinguishable) ──

function AnnouncementCard({ ann }: { ann: DashAnnouncement }) {
  const audienceLabel: Record<string, string> = {
    all: 'Everyone',
    staff: 'Staff',
    guardians: 'Parents',
    students: 'Students',
    class_node: 'Class',
  };
  const when = new Date(ann.posted_at);
  const relativeTime = formatRelative(when);

  return (
    <div className="dash-ann-card">
      <div className="dash-ann-header">
        <span className="dash-ann-audience">{audienceLabel[ann.audience] ?? ann.audience}</span>
        <span className="dash-ann-time">{relativeTime}</span>
      </div>
      <div className="dash-ann-title">{ann.title}</div>
      <div className="dash-ann-body">{ann.body}</div>
    </div>
  );
}

// ─── Collapsible Card — the shared shell every card in this session's new
// section uses. Rectangular header row (icon, title, optional right-side
// summary chip, chevron) + a body that mounts only while expanded. Deliberately
// local to this file (not extracted to components/) — if a second dashboard
// needs the same shell later, that's the point to extract it, not before. ────

interface CollapsibleCardProps {
  icon: React.ReactNode;
  title: string;
  summary?: string;               // right-aligned chip text, shown collapsed or expanded
  summaryTone?: 'normal' | 'warning' | 'urgent';
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}

function CollapsibleCard({
  icon,
  title,
  summary,
  summaryTone = 'normal',
  expanded,
  onToggle,
  children,
}: CollapsibleCardProps) {
  return (
    <div className={`dash-collapse-card${expanded ? ' dash-collapse-card--open' : ''}`}>
      <button
        className="dash-collapse-header"
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <span className="dash-collapse-icon">{icon}</span>
        <span className="dash-collapse-title">{title}</span>
        {summary && (
          <span className={`dash-collapse-summary dash-collapse-summary--${summaryTone}`}>
            {summary}
          </span>
        )}
        <span className="dash-collapse-chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && <div className="dash-collapse-body">{children}</div>}
    </div>
  );
}

// ─── Helpers (identical to AdminDashboard.tsx's — kept local rather than
// extracted to a shared util, matching that file's own choice not to) ──────

function formatRelative(date: Date): string {
  const now = new Date();
  const diff = Math.floor((now.getTime() - date.getTime()) / 1000);
  if (diff < 60) return 'Just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return date.toLocaleDateString('en-NG', { day: 'numeric', month: 'short' });
}

function formatNaira(amount: number): string {
  if (amount >= 1_000_000) return `₦${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `₦${(amount / 1_000).toFixed(0)}k`;
  return `₦${amount.toLocaleString('en-NG')}`;
}

// 'HH:MM:SS' → minutes since midnight
function timeToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function formatClock(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, '0')} ${period}`;
}

// Countdown string for the currently-running period, ticked off Date.now()
// against already-fetched period boundaries — no per-second network calls,
// matching §4.1 and the documented LivePeriodWidget.tsx convention this
// card's interaction is modeled on.
function countdownLabel(period: Period, now: Date): string {
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const endMinutes = timeToMinutes(period.end_time);
  const remaining = Math.max(0, endMinutes - nowMinutes);
  const hrs = Math.floor(remaining / 60);
  const mins = remaining % 60;
  if (hrs > 0) return `${hrs}h ${mins}m left`;
  if (mins > 0) return `${mins}m left`;
  return 'Ending now';
}

// ─── Main Component ──────────────────────────────────────────────────────────

// DashboardNavTarget intentionally mirrors only the subset of App.tsx's NavTab
// union this component actually navigates to — same rationale/comment as
// AdminDashboard.tsx's own DashboardNavTarget, kept independently rather than
// imported to avoid a circular dependency back into App.tsx.
type DashboardNavTarget = 'timetable' | 'attendance' | 'results' | 'announcements' | 'hr'

export default function TeacherDashboard({
  staffId,
  onNavigate,
}: {
  // Resolved once in App.tsx via app_identities and threaded down as
  // currentStaffId — same value HRModule already receives for a non-admin
  // staff member's own leave requests. Required here (not optional) because
  // every query in this component is staff-scoped; there is nothing useful
  // to render without it.
  staffId: string
  onNavigate: (tab: DashboardNavTarget) => void
}) {
  const school = useSchoolStore((s) => s.school);
  const session = useAuthStore((s) => s.session);

  const [stats, setStats] = useState<TeacherStats | null>(null);
  const [pendingScoreGroups, setPendingScoreGroups] = useState<PendingScoreGroup[]>([]);
  const [assignments, setAssignments] = useState<TeachingAssignment[]>([]);
  const [weekEntries, setWeekEntries] = useState<TimetableEntry[]>([]);
  const [periods, setPeriods] = useState<Period[]>([]);
  const [weekDays, setWeekDays] = useState<WeekDay[]>([]);
  const [announcements, setAnnouncements] = useState<DashAnnouncement[]>([]);

  // Payslip visibility (Session 17) — school switch + own preference, loaded
  // together since the card can't decide what to render without both.
  const [payslipSchoolEnabled, setPayslipSchoolEnabled] = useState(false);
  const [payslipSelfHidden, setPayslipSelfHidden] = useState(false);
  const [myPayslips, setMyPayslips] = useState<Payslip[]>([]);
  const [payslipsLoaded, setPayslipsLoaded] = useState(false);
  const [payslipsLoading, setPayslipsLoading] = useState(false);
  const [payslipHideBusy, setPayslipHideBusy] = useState(false);

  const [dataLoading, setDataLoading] = useState(true);
  const [annsLoading, setAnnsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Term/session progress card (Session 29, PRD Problem 6.7 — dashboard
  // placement piece of the visual spec, previously portal-only). Same
  // loadTermProgress() call AdminDashboard.tsx and the guardian portal use —
  // one shared computation, so a teacher, an admin, and a parent can never
  // see three different "days remaining" figures for the same term. Allowed
  // to fail silently to null, same convention as every other card here.
  const [termProgress, setTermProgress] = useState<TermProgress | null>(null);

  // A tick counter, re-rendered once a minute, purely to keep the countdown
  // label fresh while "My Schedule Today" is expanded — no network calls
  // fire from this, matching §4.1 / the LivePeriodWidget.tsx spec's own
  // "tick off Date.now(), no per-second network calls" requirement. Rounded
  // to a minute (not a second) since the countdown label itself is
  // minute-grained — a faster tick would re-render for no visible change.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);

  // ── Card expand/collapse state ────────────────────────────────────────────
  // "My Schedule Today" auto-expands once we know a session is currently
  // active (set in the data-load effect below, then left under the user's
  // own control — re-collapsing manually doesn't get silently reopened on
  // the next tick, only on the next full data load / day change).
  const [scheduleExpanded, setScheduleExpanded] = useState(false);
  const scheduleAutoOpenedRef = useRef(false);
  const [timetableExpanded, setTimetableExpanded] = useState(false);
  const [scoresExpanded, setScoresExpanded] = useState(false);
  const [payslipExpanded, setPayslipExpanded] = useState(false);

  // Derive greeting name from session user metadata — same pattern as
  // AdminDashboard.tsx, defaulting to a role-appropriate fallback.
  const staffName = (session?.user?.user_metadata?.full_name as string | undefined) ?? 'Teacher';
  const firstName = staffName.split(' ')[0];

  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    return 'Good evening';
  })();

  useEffect(() => {
    if (!school || !staffId) return;
    loadDashboardData();
    loadAnns();
    loadPayslipVisibility();
    loadTermProgress(school.id).then(setTermProgress).catch(() => setTermProgress(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [school?.id, staffId]);

  async function loadDashboardData() {
    setDataLoading(true);
    setError(null);
    try {
      // 1. This teacher's teaching assignments (all sessions — the service
      //    function's own documented scope) — filtered to the current
      //    session for the dashboard's "assigned classes" stat, per SESSION
      //    14's own instruction ("their assigned classes"), not the full
      //    career history a future teacher-summary screen would want.
      const [assignmentsRes, currentSessionRes] = await Promise.all([
        loadStaffTeachingAssignments(staffId),
        loadCurrentSession(),
      ]);

      if (!assignmentsRes.ok) {
        setError(assignmentsRes.error);
        setDataLoading(false);
        return;
      }

      const currentSessionId = currentSessionRes.ok ? currentSessionRes.sessionId ?? null : null;
      const currentAssignments = currentSessionId
        ? assignmentsRes.data.filter((a) => a.session_id === currentSessionId)
        : assignmentsRes.data;

      setAssignments(currentAssignments);

      const classCount = new Set(currentAssignments.map((a) => a.class_node_id)).size;
      const subjectCount = new Set(currentAssignments.map((a) => a.subject_id)).size;

      // 2. Pending score submissions — scores this teacher entered that
      //    haven't been approved yet (§7.14: approved_at is null = draft,
      //    invisible to guardians/students until approved), grouped by
      //    subject+class so the expanded card can show a real breakdown,
      //    not just a bare count. No existing service export scopes this to
      //    one teacher, so queried directly — same direct-supabase pattern
      //    AdminDashboard.tsx itself uses for its own school-wide version
      //    of this stat.
      const { data: pendingRows, error: scoresErr } = await supabase
        .from('scores')
        .select('id, subject_id, subjects ( name ), student_id, students ( class_node_id, class_nodes ( name ) )')
        .eq('entered_by', staffId)
        .is('approved_at', null);

      if (scoresErr) throw scoresErr;

      const groupMap = new Map<string, PendingScoreGroup>();
      for (const r of (pendingRows ?? []) as any[]) {
        const subjectId = r.subject_id as string;
        const classNodeId = r.students?.class_node_id as string | undefined;
        if (!classNodeId) continue;
        const key = `${subjectId}|${classNodeId}`;
        const existing = groupMap.get(key);
        if (existing) {
          existing.count += 1;
        } else {
          groupMap.set(key, {
            subject_id: subjectId,
            subject_name: r.subjects?.name ?? '—',
            class_node_id: classNodeId,
            class_name: r.students?.class_nodes?.name ?? '—',
            count: 1,
          });
        }
      }
      const groups = [...groupMap.values()].sort((a, b) => b.count - a.count);
      setPendingScoreGroups(groups);

      setStats({
        classCount,
        subjectCount,
        pendingScoreCount: (pendingRows ?? []).length,
      });

      // 3. Full-week timetable entries for this teacher — reuses
      //    loadTimetableData() + getCurrentPeriod() from timetableService.ts
      //    exactly as they exist; does not re-derive "what period is it now"
      //    independently (SESSION 14's own instruction, and the same
      //    function Problem 6.4's live-period widget is required to reuse
      //    per its own dependency note). Loaded once for the whole week —
      //    "My Timetable" (all days) and "My Schedule Today" (today's subset)
      //    both read from this same fetch rather than two separate queries.
      if (currentSessionId) {
        const timetableRes = await loadTimetableData(currentSessionId);
        if (timetableRes.ok && timetableRes.data) {
          setPeriods(timetableRes.data.periods);
          setWeekDays(timetableRes.data.weekDays);
          setWeekEntries(timetableRes.data.entries.filter((e) => e.staff_id === staffId));

          const { periodId } = getCurrentPeriod(timetableRes.data.periods, timetableRes.data.weekDays);
          const isTeachingRightNow =
            periodId !== null &&
            timetableRes.data.entries.some(
              (e) => e.staff_id === staffId && e.period_id === periodId
            );
          if (isTeachingRightNow && !scheduleAutoOpenedRef.current) {
            setScheduleExpanded(true);
            scheduleAutoOpenedRef.current = true;
          }
        }
      }
    } catch (err) {
      console.error('Teacher dashboard data error:', err);
      setError('Could not load your dashboard. Check your connection and try again.');
    } finally {
      setDataLoading(false);
    }
  }

  async function loadAnns() {
    setAnnsLoading(true);
    try {
      // Reuses announcementsService.ts's loadAnnouncements() — audience
      // filtering (staff/all/class_node visible to this teacher) is enforced
      // by RLS at the query layer, same as every other consumer of this
      // service; nothing extra to filter client-side here.
      if (!school) return;
      const res = await loadAnnouncements(school.id, { pageSize: 3 });
      if (res.ok) {
        setAnnouncements(
          res.data.announcements.map((a: ServiceAnnouncement) => ({
            id: a.id,
            title: a.title,
            body: a.body,
            audience: a.audience,
            posted_at: a.posted_at,
          }))
        );
      } else {
        setAnnouncements([]);
      }
    } catch {
      // Non-fatal — dashboard still works without announcements, same
      // tolerance AdminDashboard.tsx applies to its own announcements load.
      setAnnouncements([]);
    } finally {
      setAnnsLoading(false);
    }
  }

  // Session 17 — school-wide switch + this teacher's own hide preference.
  // Deliberately does NOT fetch payslip rows here — that only happens once
  // the card is actually expanded (see loadPayslipsIfNeeded), matching the
  // app's existing lazy-load discipline (same pattern as HRModule.tsx's
  // "Who's due for payment" panel).
  async function loadPayslipVisibility() {
    if (!school) return;
    const res = await loadPayrollVisibilitySettings(school.id, staffId);
    if (res.ok) {
      setPayslipSchoolEnabled(res.data.schoolEnabled);
      setPayslipSelfHidden(res.data.selfHidden);
    }
    // Non-fatal on failure — card simply doesn't render, same tolerance as
    // every other optional dashboard section here.
  }

  async function loadPayslipsIfNeeded() {
    if (payslipsLoaded || payslipsLoading) return;
    setPayslipsLoading(true);
    const res = await loadMyPayslips(staffId);
    if (res.ok) {
      setMyPayslips(res.data);
      setPayslipsLoaded(true);
    }
    setPayslipsLoading(false);
  }

  // "Hide" needs no extra step — a teacher choosing to hide their own card
  // is not a sensitive action. Un-hiding is handled entirely in Account
  // preferences (re-auth gate), not here — this card only ever offers Hide,
  // never Show, per the owner's confirmed design.
  async function handleHidePayslipCard() {
    setPayslipHideBusy(true);
    const res = await setMyPayslipCardHidden(staffId, true);
    if (res.ok) setPayslipSelfHidden(true);
    setPayslipHideBusy(false);
  }

  // ── Derived values ──────────────────────────────────────────────────────────

  const now = new Date();
  const { periodId: currentPeriodId, dayOfWeek: currentDayOfWeek } = useMemo(
    () => (periods.length > 0 ? getCurrentPeriod(periods, weekDays, now) : { periodId: null, dayOfWeek: now.getDay() }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [periods, weekDays]
  );

  const todaysEntries = useMemo(
    () =>
      weekEntries
        .filter((e) => e.day_of_week === currentDayOfWeek)
        .map((e) => ({ entry: e, period: periods.find((p) => p.id === e.period_id) ?? null }))
        .filter((x) => x.period !== null)
        .sort((a, b) => (a.period!.sort_order ?? 0) - (b.period!.sort_order ?? 0)),
    [weekEntries, periods, currentDayOfWeek]
  );

  const currentPeriodEntry = currentPeriodId
    ? todaysEntries.find((x) => x.entry.period_id === currentPeriodId) ?? null
    : null;

  const todayLabel = currentDayOfWeek !== null ? dayName(currentDayOfWeek) : null;

  // Full week, grouped by day for "My Timetable" — only days that have at
  // least one entry for this teacher are shown, in weekDays' own sort order.
  const weekGrouped = useMemo(() => {
    return weekDays
      .slice()
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((wd) => ({
        dayOfWeek: wd.day_of_week,
        entries: weekEntries
          .filter((e) => e.day_of_week === wd.day_of_week)
          .map((e) => ({ entry: e, period: periods.find((p) => p.id === e.period_id) ?? null }))
          .filter((x) => x.period !== null)
          .sort((a, b) => (a.period!.sort_order ?? 0) - (b.period!.sort_order ?? 0)),
      }))
      .filter((d) => d.entries.length > 0);
  }, [weekDays, weekEntries, periods]);

  const actionItems: ActionItem[] = ([
    {
      label: 'scores waiting for approval',
      count: stats?.pendingScoreCount ?? 0,
      urgency: 'normal' as const,
      route: 'results' as const,
    },
  ] as ActionItem[]).filter((a) => a.count > 0);

  const showPayslipCard = payslipSchoolEnabled && !payslipSelfHidden;

  const latestPayslip = myPayslips[0] ?? null;

  // ── Render ──────────────────────────────────────────────────────────────────

  if (error) {
    return (
      <div className="dash-error-state">
        <div className="dash-error-icon"><Icon name="alert-triangle" style={{ color: 'var(--color-warning, #d97706)' }} /></div>
        <div className="dash-error-msg">{error}</div>
        <button
          className="btn btn--primary"
          onClick={() => { loadDashboardData(); loadAnns(); }}
          type="button"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="dash-root">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="dash-header">
        <div className="dash-greeting">
          <span className="dash-greeting-line">{greeting},</span>
          <span className="dash-greeting-name">{firstName}</span>
        </div>
        <div className="dash-school-name">{school?.name}</div>
      </div>

      {/* ── Term/session progress (Session 29, PRD Problem 6.7) ────────────── */}
      <TermProgressCard progress={termProgress} />

      {/* ── Action Items (only rendered if there are pending items) ─────────── */}
      {!dataLoading && actionItems.length > 0 && (
        <div className="dash-section">
          <div className="dash-section-label">Needs attention</div>
          <div className="dash-action-list">
            {actionItems.map((item) => (
              <ActionBadge
                key={item.route}
                item={item}
                onClick={() => onNavigate(item.route)}
              />
            ))}
          </div>
        </div>
      )}

      {/* ── Stat Cards ──────────────────────────────────────────────────────── */}
      <div className="dash-section">
        <div className="dash-section-label">Your teaching load</div>
        <div className="dash-stat-grid">
          <StatCard
            label="Classes"
            value={stats?.classCount ?? 0}
            sub="this session"
            icon={<Icon name="school" />}
            loading={dataLoading}
            accent="blue"
          />
          <StatCard
            label="Subjects"
            value={stats?.subjectCount ?? 0}
            sub="you teach"
            icon={<Icon name="book-open" />}
            loading={dataLoading}
            accent="purple"
          />
          <StatCard
            label="Pending scores"
            value={stats?.pendingScoreCount ?? 0}
            sub="awaiting approval"
            icon={<Icon name="pencil" />}
            loading={dataLoading}
            accent={(stats?.pendingScoreCount ?? 0) > 0 ? 'amber' : 'green'}
          />
        </div>
      </div>

      {/* ── Collapsible cards ─────────────────────────────────────────────────
          New this session: one rectangular card per topic, closed by default
          except "My Schedule Today" while a session is actively running. */}
      <div className="dash-section">
        <div className="dash-section-label">At a glance</div>
        <div className="dash-collapse-list">

          {/* My Schedule Today */}
          <CollapsibleCard
            icon={<Icon name="clock" />}
            title="My Schedule Today"
            summary={
              dataLoading
                ? undefined
                : currentPeriodEntry
                ? countdownLabel(currentPeriodEntry.period!, now)
                : todaysEntries.length > 0
                ? `${todaysEntries.length} period${todaysEntries.length === 1 ? '' : 's'}`
                : 'No lessons today'
            }
            summaryTone={currentPeriodEntry ? 'warning' : 'normal'}
            expanded={scheduleExpanded}
            onToggle={() => setScheduleExpanded((v) => !v)}
          >
            {dataLoading ? (
              <Skeleton className="dash-ann-skel" />
            ) : todaysEntries.length === 0 ? (
              <div className="dash-empty-state">
                <div className="dash-empty-icon"><Icon name="clock" /></div>
                <div className="dash-empty-msg">
                  {todayLabel ? `No class scheduled for you, ${todayLabel}` : 'No lesson scheduled today'}
                </div>
              </div>
            ) : (
              <div className="dash-schedule-list">
                {todaysEntries.map(({ entry, period }) => {
                  const isNow = entry.period_id === currentPeriodId;
                  return (
                    <div
                      key={entry.id}
                      className={`dash-schedule-row${isNow ? ' dash-schedule-row--now' : ''}`}
                    >
                      <div className="dash-schedule-time">
                        {formatClock(period!.start_time)} – {formatClock(period!.end_time)}
                      </div>
                      <div className="dash-schedule-body">
                        <div className="dash-schedule-subject">{entry.subject_name ?? 'Free period'}</div>
                        <div className="dash-schedule-class">{entry.class_node_name}</div>
                      </div>
                      {isNow && (
                        <div className="dash-schedule-live">
                          <span className="dash-schedule-live-dot" aria-hidden="true" />
                          {countdownLabel(period!, now)}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </CollapsibleCard>

          {/* My Timetable View */}
          <CollapsibleCard
            icon={<Icon name="calendar" />}
            title="My Timetable View"
            summary={dataLoading ? undefined : `${assignments.length} assignment${assignments.length === 1 ? '' : 's'}`}
            expanded={timetableExpanded}
            onToggle={() => setTimetableExpanded((v) => !v)}
          >
            {dataLoading ? (
              <Skeleton className="dash-ann-skel" />
            ) : weekGrouped.length === 0 ? (
              <div className="dash-empty-state">
                <div className="dash-empty-icon"><Icon name="calendar" /></div>
                <div className="dash-empty-msg">No timetable entries yet this session</div>
              </div>
            ) : (
              <div className="dash-timetable-week">
                {weekGrouped.map((day) => (
                  <div key={day.dayOfWeek} className="dash-timetable-day">
                    <div className="dash-timetable-day-label">{dayName(day.dayOfWeek)}</div>
                    <div className="dash-schedule-list">
                      {day.entries.map(({ entry, period }) => (
                        <div key={entry.id} className="dash-schedule-row">
                          <div className="dash-schedule-time">
                            {formatClock(period!.start_time)} – {formatClock(period!.end_time)}
                          </div>
                          <div className="dash-schedule-body">
                            <div className="dash-schedule-subject">{entry.subject_name ?? 'Free period'}</div>
                            <div className="dash-schedule-class">{entry.class_node_name}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <button
              className="btn btn--ghost dash-collapse-action"
              type="button"
              onClick={() => onNavigate('timetable')}
            >
              Open full timetable →
            </button>
          </CollapsibleCard>

          {/* Pending Scores */}
          <CollapsibleCard
            icon={<Icon name="pencil" />}
            title="Pending Scores"
            summary={
              dataLoading
                ? undefined
                : (stats?.pendingScoreCount ?? 0) > 0
                ? `${stats?.pendingScoreCount} awaiting approval`
                : 'All caught up'
            }
            summaryTone={(stats?.pendingScoreCount ?? 0) > 0 ? 'warning' : 'normal'}
            expanded={scoresExpanded}
            onToggle={() => setScoresExpanded((v) => !v)}
          >
            {dataLoading ? (
              <Skeleton className="dash-ann-skel" />
            ) : pendingScoreGroups.length === 0 ? (
              <div className="dash-empty-state">
                <div className="dash-empty-icon"><Icon name="circle-check" style={{ color: 'var(--color-success, #16a34a)' }} /></div>
                <div className="dash-empty-msg">No scores waiting for approval</div>
              </div>
            ) : (
              <div className="dash-score-group-list">
                {pendingScoreGroups.map((g) => (
                  <div key={`${g.subject_id}|${g.class_node_id}`} className="dash-score-group-row">
                    <div className="dash-schedule-body">
                      <div className="dash-schedule-subject">{g.subject_name}</div>
                      <div className="dash-schedule-class">{g.class_name}</div>
                    </div>
                    <div className="dash-score-group-count">{g.count}</div>
                  </div>
                ))}
              </div>
            )}
            <button
              className="btn btn--ghost dash-collapse-action"
              type="button"
              onClick={() => onNavigate('results')}
            >
              Go to Results →
            </button>
          </CollapsibleCard>

          {/* My Payslip — Session 17. Only rendered at all when the
              school-wide switch is on AND this teacher hasn't hidden it. */}
          {showPayslipCard && (
            <CollapsibleCard
              icon={<Icon name="wallet" />}
              title="My Payslip"
              summary={
                payslipExpanded && payslipsLoading
                  ? undefined
                  : latestPayslip
                  ? formatNaira(latestPayslip.net_amount)
                  : payslipsLoaded
                  ? 'No payslips yet'
                  : undefined
              }
              expanded={payslipExpanded}
              onToggle={() => {
                setPayslipExpanded((v) => {
                  const next = !v;
                  if (next) loadPayslipsIfNeeded();
                  return next;
                });
              }}
            >
              {payslipsLoading ? (
                <Skeleton className="dash-ann-skel" />
              ) : myPayslips.length === 0 ? (
                <div className="dash-empty-state">
                  <div className="dash-empty-icon"><Icon name="wallet" /></div>
                  <div className="dash-empty-msg">No payslips on file yet</div>
                </div>
              ) : (
                <>
                  <div className="dash-payslip-latest">
                    <div className="dash-payslip-latest-label">Most recent</div>
                    <div className="dash-payslip-latest-amount">{formatNaira(latestPayslip!.net_amount)}</div>
                    <div className="dash-payslip-latest-status">
                      {latestPayslip!.payment_status === 'paid'
                        ? 'Paid in full'
                        : latestPayslip!.payment_status === 'partially_paid'
                        ? `Partially paid (${formatNaira(latestPayslip!.amount_paid)} of ${formatNaira(latestPayslip!.net_amount)})`
                        : 'Not yet paid'}
                    </div>
                  </div>
                  {myPayslips.length > 1 && (
                    <div className="dash-payslip-history">
                      <div className="dash-collapse-subtitle">History</div>
                      {myPayslips.slice(1).map((p) => (
                        <div key={p.id} className="dash-payslip-history-row">
                          <div>{formatNaira(p.net_amount)}</div>
                          <div className="dash-payslip-history-status">{p.payment_status.replace('_', ' ')}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
              <div className="dash-payslip-actions">
                <button
                  className="btn btn--ghost dash-payslip-hide-btn"
                  type="button"
                  disabled={payslipHideBusy}
                  onClick={handleHidePayslipCard}
                >
                  {payslipHideBusy ? 'Hiding…' : 'Hide this card'}
                </button>
              </div>
              <div className="dash-payslip-hide-hint">
                You can show it again from Account preferences — you'll be asked to confirm your password.
              </div>
            </CollapsibleCard>
          )}

        </div>
      </div>

      {/* ── Quick Actions ───────────────────────────────────────────────────── */}
      <div className="dash-section">
        <div className="dash-section-label">Quick actions</div>
        <div className="dash-quick-grid">
          <QuickAction
            icon={<Icon name="clipboard-list" />}
            label="Mark attendance"
            onClick={() => onNavigate('attendance')}
          />
          <QuickAction
            icon={<Icon name="calendar" />}
            label="View timetable"
            onClick={() => onNavigate('timetable')}
          />
          <QuickAction
            icon={<Icon name="pencil" />}
            label="Enter scores"
            onClick={() => onNavigate('results')}
          />
        </div>
      </div>

      {/* ── Announcements ───────────────────────────────────────────────────── */}
      <div className="dash-section dash-section--last">
        <div className="dash-section-header">
          <div className="dash-section-label">Announcements</div>
        </div>

        {annsLoading ? (
          <div className="dash-ann-list">
            <Skeleton className="dash-ann-skel" />
            <Skeleton className="dash-ann-skel" />
          </div>
        ) : announcements.length === 0 ? (
          <div className="dash-empty-state">
            <div className="dash-empty-icon"><Icon name="megaphone" /></div>
            <div className="dash-empty-msg">No announcements yet</div>
          </div>
        ) : (
          <div className="dash-ann-list">
            {announcements.map((ann) => (
              <AnnouncementCard key={ann.id} ann={ann} />
            ))}
          </div>
        )}
      </div>

    </div>
  );
}
