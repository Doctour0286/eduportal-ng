/**
 * App.tsx
 * Top-level routing shell for Eduportal NG.
 *
 * Routing logic (in order):
 * 1. Read subdomain → query schools by slug
 * 2. If no school found → SchoolNotFound
 * 3. If school found but no auth session → LoginPage
 * 4. If authenticated but onboarding not complete → OnboardingWizard
 * 5. If authenticated and onboarded → MainApp (with BottomNav)
 *
 * All loading states use skeleton screens, not spinners.
 * No browser-only APIs in routing logic.
 */

import { useEffect, useState } from 'react'
import { supabase } from './lib/supabase'
import { useAuthStore } from './stores/authStore'
import { LoginPage } from './routes/LoginPage'
import { OnboardingWizard } from './routes/OnboardingWizard'
import { BottomNav, type NavTab } from './components/BottomNav'
import AdminDashboard from './routes/AdminDashboard'

// ─── School data ──────────────────────────────────────────────────────────

interface SchoolData {
  id: string
  name: string
  slug: string
  logo_url: string | null
  theme_color: string | null
  status: string
  onboarding_complete: boolean
}

// ─── Subdomain detection ──────────────────────────────────────────────────

function getSlugFromHostname(hostname: string): string | null {
  // Local dev: {slug}.localhost — 2 labels, first is the slug
  if (hostname.endsWith('.localhost')) {
    const parts = hostname.split('.')
    if (parts[0] !== 'localhost') return parts[0]
  } else {
    // Production: {slug}.eduportalng.com — 3+ labels means a subdomain is present.
    // A bare apex domain (eduportalng.com) or www.eduportalng.com has only 2
    // meaningful labels and must NOT be treated as a school slug.
    const parts = hostname.split('.')
    if (parts.length >= 3 && parts[0] !== 'www') {
      return parts[0]
    }
  }
  // Dev fallback: ?slug=dilimi in URL params
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search)
    return params.get('slug')
  }
  return null
}

// ─── App entry point ──────────────────────────────────────────────────────

export default function App() {
  const [school, setSchool] = useState<SchoolData | null>(null)
  const [slugState, setSlugState] = useState<'loading' | 'not-found' | 'found' | 'no-slug'>('loading')
  const [activeTab, setActiveTab] = useState<NavTab>('home')
  const [forceShowOnboarding, setForceShowOnboarding] = useState(false)

  const { session, actorType, isLoading: authLoading, isInitialized, initialize } = useAuthStore()

  // Initialize auth once on mount
  useEffect(() => {
    initialize()
  }, [initialize])

  // Load school from subdomain
  useEffect(() => {
    const slug = getSlugFromHostname(window.location.hostname)
    if (!slug) {
      setSlugState('no-slug')
      return
    }

    supabase
      .from('schools')
      .select('id, name, slug, logo_url, theme_color, status, onboarding_complete')
      .eq('slug', slug)
      .maybeSingle()
      .then(({ data }) => {
        if (!data) {
          setSlugState('not-found')
        } else {
          setSchool(data)
          setSlugState('found')
          // Apply school theme color to CSS variable
          if (data.theme_color) {
            document.documentElement.style.setProperty('--color-brand-600', data.theme_color)
          }
        }
      })
  }, [])

  // ─── Loading skeleton ──────────────────────────────────────────────────

  if (slugState === 'loading' || !isInitialized || authLoading) {
    return (
      <div className="app-loading">
        <div className="skeleton-logo" />
        <div className="skeleton-line" style={{ width: '60%' }} />
        <div className="skeleton-line" style={{ width: '40%' }} />
      </div>
    )
  }

  // ─── No subdomain ──────────────────────────────────────────────────────

  if (slugState === 'no-slug') {
    return (
      <div className="platform-home">
        <div className="platform-home-inner">
          <h1 className="platform-home-title">Eduportal NG</h1>
          <p className="platform-home-desc">
            School management platform for Nigerian schools.
          </p>
          <p className="platform-home-hint">
            Access your school at <strong>yourschool.eduportalng.com</strong>
          </p>
        </div>
      </div>
    )
  }

  // ─── School not found ──────────────────────────────────────────────────

  if (slugState === 'not-found' || !school) {
    return (
      <div className="school-not-found">
        <div className="not-found-inner">
          <span className="not-found-icon">🏫</span>
          <h1>School not found</h1>
          <p>
            We couldn't find a school at this address. Check the URL or contact the school for the correct link.
          </p>
        </div>
      </div>
    )
  }

  // ─── School suspended or archived ─────────────────────────────────────

  if (school.status === 'suspended') {
    return (
      <div className="school-suspended">
        <div className="suspended-inner">
          <span className="suspended-icon">⚠️</span>
          <h1>{school.name}</h1>
          <p>This school's account is currently suspended. Please contact the school administration.</p>
        </div>
      </div>
    )
  }

  // ─── Not logged in → Login ─────────────────────────────────────────────

  if (!session) {
    return (
      <LoginPage
        schoolId={school.id}
        schoolName={school.name}
        logoUrl={school.logo_url}
        themeColor={school.theme_color}
      />
    )
  }

  // ─── Onboarding not complete → Wizard ─────────────────────────────────

  if (!school.onboarding_complete || forceShowOnboarding) {
    return (
      <OnboardingWizard
        schoolId={school.id}
        schoolName={school.name}
        onComplete={() => {
          setSchool({ ...school, onboarding_complete: true })
          setForceShowOnboarding(false)
        }}
      />
    )
  }

  // ─── Main app shell ────────────────────────────────────────────────────

  return (
    <div className="app-shell">
      {/* Top header */}
      <header className="app-header">
        <div className="app-header-left">
          {school.logo_url && (
            <img src={school.logo_url} alt={school.name} className="app-header-logo" />
          )}
          <span className="app-header-school-name">{school.name}</span>
        </div>
        <div className="app-header-right">
          <button
            className="icon-btn"
            onClick={() => setActiveTab('more')}
            aria-label="Account"
          >
            👤
          </button>
        </div>
      </header>

      {/* Page content — module views loaded here */}
      <main className="app-main">
        <TabContent
          tab={activeTab}
          schoolId={school.id}
          actorType={actorType}
          onOpenSetup={() => setForceShowOnboarding(true)}
        />
      </main>

      {/* Bottom navigation */}
      <BottomNav
        activeTab={activeTab}
        onNavigate={setActiveTab}
        actorType={actorType}
      />
    </div>
  )
}

// ─── Tab content router ───────────────────────────────────────────────────

function TabContent({
  tab,
  schoolId,
  actorType,
  onOpenSetup,
}: {
  tab: NavTab
  schoolId: string
  actorType: 'staff' | 'guardian' | 'student' | 'platform_admin' | null
  onOpenSetup: () => void
}) {
  const isAdmin = actorType === 'staff' || actorType === 'platform_admin'

  // ── Home / Dashboard ──────────────────────────────────────────────────
  if (tab === 'home') {
    // Admin and staff see the full AdminDashboard.
    // Guardian/student home views are placeholders until Phase 6 builds them.
    if (isAdmin) {
      return <AdminDashboard />
    }
    return (
      <PlaceholderModule
        icon="🏠"
        title="Home"
        description="Your personalised home screen is coming soon."
        comingSoon
      />
    )
  }

  if (tab === 'timetable') {
    return (
      <PlaceholderModule
        icon="📅"
        title="Timetable"
        description="View today's schedule and the weekly class timetable."
        comingSoon
      />
    )
  }

  if (tab === 'attendance') {
    return (
      <PlaceholderModule
        icon="✅"
        title="Attendance"
        description="Mark and review daily attendance for your classes."
        comingSoon
      />
    )
  }

  if (tab === 'students') {
    return (
      <PlaceholderModule
        icon="👥"
        title="Students"
        description="Manage student records, enrolment, and guardian links."
        comingSoon
      />
    )
  }

  if (tab === 'finance') {
    return (
      <PlaceholderModule
        icon="💰"
        title={actorType === 'guardian' ? 'Fees' : 'Finance'}
        description={
          actorType === 'guardian'
            ? "View your child's fee balance, payment history, and upcoming dues."
            : 'Record payments, manage fee structures, and view balances.'
        }
        comingSoon
      />
    )
  }

  if (tab === 'more') {
    return (
      <div className="more-menu">
        <div className="more-menu-section">
          <p className="more-menu-section-title">Modules</p>
          <MoreMenuItem icon="📊" label="Results" description="Scores, report cards, and promotions" />
          <MoreMenuItem icon="📚" label="Library" description="Books, borrowing, and digital resources" />
          <MoreMenuItem icon="📢" label="Announcements" description="School notices and messages" />
          <MoreMenuItem icon="🗂️" label="HR" description="Staff leaves and payroll" />
        </div>

        {isAdmin && (
          <div className="more-menu-section">
            <p className="more-menu-section-title">Administration</p>
            <MoreMenuItem icon="⚙️" label="Settings" description="School config, roles, and preferences" />
            <button className="more-menu-item" onClick={onOpenSetup}>
              <span className="more-menu-item-icon">🧭</span>
              <div>
                <p className="more-menu-item-label">Setup guide</p>
                <p className="more-menu-item-desc">Return to the onboarding wizard</p>
              </div>
              <span className="more-menu-item-arrow">›</span>
            </button>
            <MoreMenuItem icon="📋" label="Audit log" description="See who changed what and when" />
          </div>
        )}

        <div className="more-menu-section">
          <SignOutButton />
        </div>
      </div>
    )
  }

  return null
}

function PlaceholderModule({
  icon,
  title,
  description,
  comingSoon,
}: {
  icon: string
  title: string
  description: string
  comingSoon?: boolean
}) {
  return (
    <div className="placeholder-module">
      <span className="placeholder-icon">{icon}</span>
      <h2 className="placeholder-title">{title}</h2>
      <p className="placeholder-desc">{description}</p>
      {comingSoon && (
        <span className="coming-soon-badge">Coming in Phase 6</span>
      )}
    </div>
  )
}

function MoreMenuItem({
  icon,
  label,
  description,
}: {
  icon: string
  label: string
  description: string
}) {
  return (
    <div className="more-menu-item">
      <span className="more-menu-item-icon">{icon}</span>
      <div>
        <p className="more-menu-item-label">{label}</p>
        <p className="more-menu-item-desc">{description}</p>
      </div>
      <span className="more-menu-item-arrow">›</span>
    </div>
  )
}

function SignOutButton() {
  const [signingOut, setSigningOut] = useState(false)
  async function handleSignOut() {
    setSigningOut(true)
    await supabase.auth.signOut()
  }
  return (
    <button
      className="more-menu-item more-menu-item--danger"
      onClick={handleSignOut}
      disabled={signingOut}
    >
      <span className="more-menu-item-icon">🚪</span>
      <div>
        <p className="more-menu-item-label">{signingOut ? 'Signing out…' : 'Sign out'}</p>
      </div>
    </button>
  )
}
