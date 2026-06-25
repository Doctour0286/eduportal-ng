/**
 * BottomNav.tsx
 * Mobile-first bottom navigation bar.
 * Five primary tabs: Timetable, Attendance, Students, Finance, More.
 * Touch targets: minimum 44×44px.
 * Platform-agnostic: uses internal state for active tab,
 * calls onNavigate() callback — routing layer is in App.tsx.
 */

export type NavTab = 'timetable' | 'attendance' | 'students' | 'finance' | 'more'

interface BottomNavProps {
  activeTab: NavTab
  onNavigate: (tab: NavTab) => void
  /** Actor type determines which tabs are visible */
  actorType: 'staff' | 'guardian' | 'student' | 'platform_admin' | null
}

const NAV_ITEMS: { id: NavTab; label: string; icon: string; staffOnly?: boolean; guardianLabel?: string }[] = [
  { id: 'timetable',  label: 'Timetable',  icon: '📅', guardianLabel: 'Schedule' },
  { id: 'attendance', label: 'Attendance', icon: '✅', guardianLabel: 'Attendance' },
  { id: 'students',   label: 'Students',   icon: '👥', staffOnly: true },
  { id: 'finance',    label: 'Finance',    icon: '💰', guardianLabel: 'Fees' },
  { id: 'more',       label: 'More',       icon: '☰' },
]

export function BottomNav({ activeTab, onNavigate, actorType }: BottomNavProps) {
  const isGuardian = actorType === 'guardian' || actorType === 'student'

  const visibleItems = NAV_ITEMS.filter((item) => {
    if (item.staffOnly && isGuardian) return false
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
