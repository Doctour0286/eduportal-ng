// src/routes/AdminDashboard.tsx
// Phase 6 — Admin Dashboard
// Queries: students, staff, attendance_records (today), payments (session),
//          scores (pending approval), leave_requests (pending), announcements (recent)
// All queries are school-scoped automatically via RLS.

import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useSchoolStore } from '../stores/schoolStore';
import { useAuthStore } from '../stores/authStore';

// ─── Types ────────────────────────────────────────────────────────────────────

interface DashboardStats {
  totalStudents: number;
  totalStaff: number;
  todayAttendanceMarked: number;   // how many students have a record today
  todayAttendanceTotal: number;    // total active students (denominator)
  todayPresentCount: number;
  sessionPaymentsTotal: number;    // sum of completed payments this session
  pendingScoreApprovals: number;
  pendingLeaveRequests: number;
}

interface Announcement {
  id: string;
  title: string;
  body: string;
  audience: string;
  posted_at: string;
  is_public: boolean;
}

interface ActionItem {
  label: string;
  count: number;
  urgency: 'normal' | 'warning' | 'urgent';
  route: string;  // future: used when we navigate to that module
}

// ─── Skeleton ────────────────────────────────────────────────────────────────

function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton ${className}`} />;
}

// ─── Stat Card ───────────────────────────────────────────────────────────────

interface StatCardProps {
  label: string;
  value: string | number;
  sub?: string;
  icon: string;
  loading: boolean;
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

// ─── Action Item Row ─────────────────────────────────────────────────────────

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

// ─── Quick Action Button ──────────────────────────────────────────────────────

interface QuickActionProps {
  icon: string;
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

// ─── Announcement Card ───────────────────────────────────────────────────────

function AnnouncementCard({ ann }: { ann: Announcement }) {
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

function todayDateString(): string {
  return new Date().toISOString().split('T')[0];
}

// ─── Main Component ──────────────────────────────────────────────────────────

// NavTab here intentionally mirrors only the subset of App.tsx's NavTab union
// this component actually navigates to — not the full union — so this file
// doesn't need to import App.tsx's type and create a circular dependency.
// Every value here must stay in sync with App.tsx's NavTab values by name.
type DashboardNavTarget = 'students' | 'finance' | 'attendance' | 'timetable' | 'results' | 'hr' | 'announcements'

// Mirrors App.tsx's NavIntent shape — kept as a local subset for the same
// reason DashboardNavTarget is local (avoid a circular import). Only the
// three intents wired in this file are listed; additive, non-breaking change
// to the onNavigate signature per PRD Problem 2.2c.
type DashboardNavIntent = { intent?: 'add_student' | 'record_payment' | 'mark_attendance' }

export default function AdminDashboard({
  onNavigate,
}: {
  onNavigate: (tab: DashboardNavTarget, intent?: DashboardNavIntent) => void
}) {
  const school = useSchoolStore((s) => s.school);
  const session = useAuthStore((s) => s.session);

  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [statsLoading, setStatsLoading] = useState(true);
  const [annsLoading, setAnnsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Derive greeting name from session user metadata
  const staffName = (session?.user?.user_metadata?.full_name as string | undefined) ?? 'Admin';
  const firstName = staffName.split(' ')[0];

  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    return 'Good evening';
  })();

  useEffect(() => {
    if (!school) return;
    loadStats();
    loadAnnouncements();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [school?.id]);

  async function loadStats() {
    setStatsLoading(true);
    setError(null);
    try {
      const today = todayDateString();

      // Run all queries in parallel — each is a simple count/sum, fast on 3G
      const [
        studentsRes,
        staffRes,
        attendanceTodayRes,
        presentTodayRes,
        _sessionRes,
        pendingScoresRes,
        pendingLeaveRes,
        _placeholder,
      ] = await Promise.all([
        // 1. Total active students
        supabase
          .from('students')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'active'),

        // 2. Total active staff
        supabase
          .from('staff')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'active'),

        // 3. How many students have an attendance record today (any status)
        supabase
          .from('attendance_records')
          .select('id', { count: 'exact', head: true })
          .eq('date', today),

        // 4. Present count today
        supabase
          .from('attendance_records')
          .select('id', { count: 'exact', head: true })
          .eq('date', today)
          .eq('status', 'present'),

        // 5. Current session (for payments filter)
        supabase
          .from('sessions')
          .select('id')
          .eq('is_current', true)
          .maybeSingle(),

        // 6. Pending score approvals (approved_at is null)
        supabase
          .from('scores')
          .select('id', { count: 'exact', head: true })
          .is('approved_at', null),

        // 7. Pending leave requests
        supabase
          .from('leave_requests')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'pending'),

        // placeholder — resolved after session query
        Promise.resolve(null),
      ]);

      // 8. Sum all completed payments (school-scoped via RLS)
      // payments links to fee_assignments → session, but for dashboard we sum all completed
      const { data: allPayments } = await supabase
        .from('payments')
        .select('amount')
        .eq('status', 'completed');

      const paymentsTotal = (allPayments ?? []).reduce(
        (sum, p) => sum + parseFloat(p.amount),
        0
      );

      setStats({
        totalStudents: studentsRes.count ?? 0,
        totalStaff: staffRes.count ?? 0,
        todayAttendanceMarked: attendanceTodayRes.count ?? 0,
        todayAttendanceTotal: studentsRes.count ?? 0,
        todayPresentCount: presentTodayRes.count ?? 0,
        sessionPaymentsTotal: paymentsTotal,
        pendingScoreApprovals: pendingScoresRes.count ?? 0,
        pendingLeaveRequests: pendingLeaveRes.count ?? 0,
      });
    } catch (err) {
      console.error('Dashboard stats error:', err);
      setError('Could not load dashboard data. Check your connection and try again.');
    } finally {
      setStatsLoading(false);
    }
  }

  async function loadAnnouncements() {
    setAnnsLoading(true);
    try {
      const { data, error: err } = await supabase
        .from('announcements')
        .select('id, title, body, audience, posted_at, is_public')
        .order('posted_at', { ascending: false })
        .limit(3);

      if (err) throw err;
      setAnnouncements(data ?? []);
    } catch {
      // Non-fatal — dashboard still works without announcements
      setAnnouncements([]);
    } finally {
      setAnnsLoading(false);
    }
  }

  // ── Derived values ──────────────────────────────────────────────────────────

  const attendancePct =
    stats && stats.todayAttendanceTotal > 0
      ? Math.round((stats.todayPresentCount / stats.todayAttendanceTotal) * 100)
      : null;

  const attendanceSub =
    stats && stats.todayAttendanceMarked > 0
      ? `${stats.todayPresentCount} of ${stats.todayAttendanceTotal} students`
      : undefined;

  const actionItems: ActionItem[] = ([
    {
      label: 'scores waiting for approval',
      count: stats?.pendingScoreApprovals ?? 0,
      urgency: ((stats?.pendingScoreApprovals ?? 0) > 10 ? 'urgent' : 'warning') as ActionItem['urgency'],
      route: 'results',
    },
    {
      label: 'leave requests pending',
      count: stats?.pendingLeaveRequests ?? 0,
      urgency: 'normal' as const,
      route: 'hr',
    },
  ] as ActionItem[]).filter((a) => a.count > 0);

  // ── Render ──────────────────────────────────────────────────────────────────

  if (error) {
    return (
      <div className="dash-error-state">
        <div className="dash-error-icon">⚠️</div>
        <div className="dash-error-msg">{error}</div>
        <button
          className="btn btn-primary"
          onClick={() => { loadStats(); loadAnnouncements(); }}
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

      {/* ── Action Items (only rendered if there are pending items) ─────────── */}
      {!statsLoading && actionItems.length > 0 && (
        <div className="dash-section">
          <div className="dash-section-label">Needs attention</div>
          <div className="dash-action-list">
            {actionItems.map((item) => (
              <ActionBadge
                key={item.route}
                item={item}
                onClick={() => onNavigate(item.route as DashboardNavTarget)}
              />
            ))}
          </div>
        </div>
      )}

      {/* ── Stat Cards ──────────────────────────────────────────────────────── */}
      <div className="dash-section">
        <div className="dash-section-label">Today at a glance</div>
        <div className="dash-stat-grid">
          <StatCard
            label="Students"
            value={stats?.totalStudents ?? 0}
            sub="enrolled and active"
            icon="🎓"
            loading={statsLoading}
            accent="blue"
          />
          <StatCard
            label="Staff"
            value={stats?.totalStaff ?? 0}
            sub="active members"
            icon="👩‍🏫"
            loading={statsLoading}
            accent="purple"
          />
          <StatCard
            label="Attendance today"
            value={statsLoading ? '—' : stats?.todayAttendanceMarked === 0 ? 'Not marked' : attendancePct !== null ? `${attendancePct}%` : '—'}
            sub={attendanceSub}
            icon="✅"
            loading={statsLoading}
            accent={
              attendancePct === null
                ? 'amber'
                : attendancePct >= 80
                ? 'green'
                : 'amber'
            }
          />
          <StatCard
            label="Fees collected"
            value={statsLoading ? '—' : formatNaira(stats?.sessionPaymentsTotal ?? 0)}
            sub="all completed payments"
            icon="💰"
            loading={statsLoading}
            accent="green"
          />
        </div>
      </div>

      {/* ── Quick Actions ───────────────────────────────────────────────────── */}
      <div className="dash-section">
        <div className="dash-section-label">Quick actions</div>
        <div className="dash-quick-grid">
          <QuickAction
            icon="➕"
            label="Add student"
            onClick={() => onNavigate('students', { intent: 'add_student' })}
          />
          <QuickAction
            icon="💳"
            label="Record payment"
            onClick={() => onNavigate('finance', { intent: 'record_payment' })}
          />
          <QuickAction
            icon="📋"
            label="Mark attendance"
            onClick={() => onNavigate('attendance', { intent: 'mark_attendance' })}
          />
          <QuickAction
            icon="📅"
            label="View timetable"
            onClick={() => onNavigate('timetable')}
          />
        </div>
      </div>

      {/* ── Announcements ───────────────────────────────────────────────────── */}
      <div className="dash-section dash-section--last">
        <div className="dash-section-header">
          <div className="dash-section-label">Announcements</div>
          <button
            className="dash-compose-btn"
            type="button"
            onClick={() => onNavigate('announcements')}
          >
            + Post
          </button>
        </div>

        {annsLoading ? (
          <div className="dash-ann-list">
            <Skeleton className="dash-ann-skel" />
            <Skeleton className="dash-ann-skel" />
          </div>
        ) : announcements.length === 0 ? (
          <div className="dash-empty-state">
            <div className="dash-empty-icon">📢</div>
            <div className="dash-empty-msg">No announcements yet</div>
            <button
              className="btn btn-ghost"
              type="button"
              onClick={() => onNavigate('announcements')}
            >
              Post your first announcement →
            </button>
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
