/**
 * Sidebar.tsx
 * Persistent, collapsible navigation sidebar for larger viewports (PRD
 * Problem 6.8, Tier 6). Purely additive: on phone-sized viewports this
 * component renders nothing (CSS media-query gated, see `.app-sidebar` in
 * index.css) and `BottomNav` remains the only navigation, unchanged. Above
 * the shared `--breakpoint-desktop` threshold (see index.css), this renders
 * alongside the header/content column and `BottomNav` hides itself via the
 * same breakpoint, so the two never show at once and never leave a gap.
 *
 * In scope for every actor type — staff, teacher, guardian/student, and
 * admin — not just admin (owner's explicit correction to the PRD's own
 * "confirm with the owner" Goal 1 open question: current UX-pattern
 * consensus for admin-panel/dashboard-style apps is a sidebar that's a
 * pure larger-viewport addition, bottom nav still primary on mobile —
 * §4.2 mobile-first is not violated, since nothing about the mobile
 * experience changes).
 *
 * Deliberately reuses, rather than re-derives, two things App.tsx/
 * BottomNav.tsx already own:
 * 1. `getVisibleNavItems()` (exported from BottomNav.tsx) for the primary
 *    nav row — the exact same staffOnly/staffHidden/guardianHidden/
 *    students-permission gating BottomNav itself uses, so a role's visible
 *    tab set can never silently disagree between the mobile and desktop
 *    presentations of the same navigation.
 * 2. `<MoreSheetContent>` itself (App.tsx) for the secondary item list
 *    (Results/Library/Announcements/HR/Guardians/Settings/Setup guide) —
 *    rendered directly inside this component's own "More" section rather
 *    than copied, so its can()-based gating and item list are the single
 *    source of truth whether the person is on a phone (sheet) or a larger
 *    screen (permanently visible in the sidebar).
 *
 * Collapse state is local (useState, not persisted) — matches the
 * reference app's own collapsible-sidebar pattern; a per-account persisted
 * preference is a reasonable future addition but is not required by
 * Problem 6.8's own Definition of Done and would need its own storage
 * decision (§ the settings/alarm precedent), not invented here.
 */
import { useState, type ReactNode } from 'react'
import { getVisibleNavItems, type NavTab as BottomNavTab } from './BottomNav'
import { Icon } from './icons'

interface SidebarProps {
  activeTab: string
  onNavigate: (tab: BottomNavTab) => void
  actorType: 'staff' | 'guardian' | 'student' | 'platform_admin' | null
  canViewStudents: boolean
  schoolName: string
  logoUrl?: string | null
  /** Rendered inside the sidebar's own "More" section — pass the same
   *  <MoreSheetContent .../> element App.tsx already builds for the mobile
   *  sheet, so both surfaces read one item list. `null` for guardian/
   *  student, which has no More content (mirrors BottomNav's own
   *  guardianHidden: true on the 'more' NAV_ITEMS entry). */
  moreContent: ReactNode
}

export function Sidebar({ activeTab, onNavigate, actorType, canViewStudents, schoolName, logoUrl, moreContent }: SidebarProps) {
  const [collapsed, setCollapsed] = useState(false)
  const isGuardian = actorType === 'guardian' || actorType === 'student'
  const visibleItems = getVisibleNavItems(actorType, canViewStudents).filter((item) => item.id !== 'more')

  return (
    <aside
      className={`app-sidebar${collapsed ? ' app-sidebar--collapsed' : ''}`}
      aria-label="Main navigation"
    >
      <div className="app-sidebar-header">
        {!collapsed && (
          <div className="app-sidebar-brand">
            {logoUrl && <img src={logoUrl} alt={schoolName} className="app-sidebar-logo" />}
            <span className="app-sidebar-school-name">{schoolName}</span>
          </div>
        )}
        <button
          type="button"
          className="app-sidebar-collapse-btn"
          onClick={() => setCollapsed((prev) => !prev)}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
        >
          <Icon name="menu" />
        </button>
      </div>

      <nav className="app-sidebar-nav" role="navigation" aria-label="Primary">
        {visibleItems.map((item) => {
          const label = isGuardian && item.guardianLabel ? item.guardianLabel : item.label
          const isActive = activeTab === item.id
          return (
            <button
              key={item.id}
              type="button"
              className={`app-sidebar-item${isActive ? ' app-sidebar-item--active' : ''}`}
              onClick={() => onNavigate(item.id)}
              aria-label={label}
              aria-current={isActive ? 'page' : undefined}
              title={collapsed ? label : undefined}
            >
              <span className="app-sidebar-item-icon" aria-hidden="true">{item.icon}</span>
              {!collapsed && <span className="app-sidebar-item-label">{label}</span>}
            </button>
          )
        })}
      </nav>

      {/* "More" section — staff/admin only, mirrors BottomNav's own
          guardianHidden: true on the 'more' tab. Not rendered at all for
          guardian/student rather than rendered empty, matching how
          BottomNav simply omits the tab for that actor type. */}
      {!isGuardian && moreContent && (
        <div className="app-sidebar-more">
          {!collapsed ? (
            moreContent
          ) : (
            // Collapsed state still needs a way to reach More items —
            // rather than hide them entirely (which would silently remove
            // reachability Problem 6.8's own Goal 4 requires preserving),
            // expanding the sidebar on click is the simplest correct
            // behavior: the person sees exactly what expanding manually
            // would have shown, with no separate collapsed-only menu to
            // keep in sync.
            <button
              type="button"
              className="app-sidebar-item app-sidebar-more-collapsed-btn"
              onClick={() => setCollapsed(false)}
              aria-label="More options"
              title="More options"
            >
              <span className="app-sidebar-item-icon" aria-hidden="true"><Icon name="folder" /></span>
            </button>
          )}
        </div>
      )}
    </aside>
  )
}
