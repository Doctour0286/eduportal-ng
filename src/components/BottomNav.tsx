/**
 * BottomNav.tsx
 * Mobile-first bottom navigation bar.
 * Six primary tabs for staff/admin: Home, Timetable, Attendance, Students, Finance, More.
 * Two for guardian/student: Dashboard (home), Library.
 *
 * UPDATED (Session 31): guardian/student's nav is now just Dashboard + Library.
 * Everything else that used to be a separate tap target for this actor type —
 * Schedule, Attendance, Fees, More — is either already one tap away from
 * Dashboard (GuardianPortal's own internal tab bar: summary/results/
 * attendance/fees/announcements/schedule, reached via the summary screen's
 * brief cards) or wasn't relevant to guardian/student at all (per Session 30's
 * More-sheet audit, every guardian-relevant More item — Announcements,
 * Results — is already folded into GuardianPortal's tabs; the only item that
 * genuinely wasn't is Library). Home's label changes from "Summary" to
 * "Dashboard" for guardian/student, but behavior is unchanged: it still
 * mounts GuardianPortal with initialTab="summary" (App.tsx's 'home' branch),
 * i.e. the same brief-card screen that's always been the actual landing page —
 * only the nav label changes, matching what that screen already is.
 * Library is new to BottomNav entirely — previously staff-only, reachable
 * only via the More sheet (App.tsx already renders it unconditionally for
 * any actorType on tab === 'library', so no App.tsx routing change was
 * needed here, unlike Schedule/Attendance/Finance in Session 30).
 * staffHidden mirrors guardianHidden/staffOnly's pattern: Library is visible
 * to guardian/student only, staff keep reaching it via the More sheet as
 * before — this session didn't touch staff's nav, only guardian/student's,
 * so no staff-facing Library button was added to avoid an unrequested change
 * to a nav nothing here indicated needed simplifying.
 *
 * Session 30 (superseded by the above for guardian/student, kept below for
 * the staff nav's own history): Attendance and Finance were hidden for
 * guardian/student via guardianHidden, and 'timetable' was relabelled
 * "Schedule" and routed (via App.tsx) into GuardianPortal's own child-scoped,
 * read-only schedule tab instead of the staff TimetableModule. That relabel/
 * route still exists in App.tsx as a defensive fallback (see App.tsx's
 * 'timetable'/'attendance'/'finance' branches) in case anything still
 * dispatches those tab ids for a guardian/student outside this nav bar (e.g.
 * a stale deep link or onSeeAll handler) — but as of Session 31 this nav bar
 * itself no longer offers Schedule/Attendance/Finance/More as guardian/
 * student tap targets at all.
 *
 * Touch targets: minimum 44×44px.
 * Platform-agnostic: uses internal state for active tab,
 * calls onNavigate() callback — routing layer is in App.tsx.
 *
 * FIX (SESSION 7 / PRD Problem 1.3): this previously had no 'home' entry at
 * all, so there was no tap target anywhere in the app shell that returned
 * the user to the dashboard once they navigated to another tab — the header
 * account icon goes to 'more', not 'home'. Confirmed as the actual root
 * cause of "no link to the Admin Dashboard" (user's #5), not a rendering
 * failure of BottomNav itself.
 *
 * Updated (Session 10, PRD Problem 3.1, Goal 5): the Students tab's
 * visibility, previously staffOnly (any staff/platform_admin actor,
 * regardless of permissions), now also requires can('students.records.view')
 * — a staff member with zero students.* permission rows no longer sees a
 * door to a module they can't enter, per §4.3 progressive disclosure and
 * the PRD's explicit Problem 3.1 file note for this component. Read
 * in-component via useAuthStore, matching every other Session 10
 * conversion (no props threading).
 *
 * platform_admin needs an explicit OR here, not just the can() bypass —
 * per authStore.ts, isAdminRole and permissionScopes are both hard-coded
 * false/empty for platform_admin (it's a separate concept from a
 * school-scoped admin role), so can() alone would incorrectly hide this
 * tab from a platform_admin actor. actorType === 'platform_admin' is
 * checked directly, same pattern App.tsx already uses for its own
 * isAdmin derivation (isAdminRole || actorType === 'platform_admin').
 */

import { useAuthStore } from '../stores/authStore'

export type NavTab = 'home' | 'timetable' | 'attendance' | 'students' | 'finance' | 'library' | 'more'

interface BottomNavProps {
  activeTab: NavTab
  onNavigate: (tab: NavTab) => void
  /** Actor type determines which tabs are visible */
  actorType: 'staff' | 'guardian' | 'student' | 'platform_admin' | null
}

const NAV_ITEMS: { id: NavTab; label: string; icon: string; staffOnly?: boolean; staffHidden?: boolean; guardianLabel?: string; guardianHidden?: boolean }[] = [
  { id: 'home',       label: 'Home',       icon: '🏠', guardianLabel: 'Dashboard' },
  { id: 'timetable',  label: 'Timetable',  icon: '📅', guardianHidden: true },
  { id: 'attendance', label: 'Attendance', icon: '✅', guardianHidden: true },
  { id: 'students',   label: 'Students',   icon: '👥', staffOnly: true },
  { id: 'finance',    label: 'Finance',    icon: '💰', guardianHidden: true },
  { id: 'library',    label: 'Library',    icon: '📚', staffHidden: true },
  { id: 'more',       label: 'More',       icon: '☰', guardianHidden: true },
]

export function BottomNav({ activeTab, onNavigate, actorType }: BottomNavProps) {
  const isGuardian = actorType === 'guardian' || actorType === 'student'
  const can = useAuthStore((s) => s.can)
  const canViewStudents = can('students.records.view') || actorType === 'platform_admin'

  const visibleItems = NAV_ITEMS.filter((item) => {
    if (item.staffOnly && isGuardian) return false
    if (item.staffHidden && !isGuardian) return false
    if (item.guardianHidden && isGuardian) return false
    if (item.id === 'students' && !canViewStudents) return false
    return true
  })

  return (
    <nav className="bottom-nav" role="navigation" aria-label="Main navigation">
      {visibleItems.map((item) => {
        const label = isGuardian && item.guardianLabel ? item.guardianLabel : item.label
        const isActive = activeTab === item.id
        return (
          <button
            key={item.id}
            className={`bottom-nav-item ${isActive ? 'bottom-nav-item--active' : ''}`}
            onClick={() => onNavigate(item.id)}
            aria-label={label}
            aria-current={isActive ? 'page' : undefined}
          >
            <span className="bottom-nav-icon" aria-hidden="true">{item.icon}</span>
            <span className="bottom-nav-label">{label}</span>
          </button>
        )
      })}
    </nav>
  )
}
