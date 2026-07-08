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

import { useEffect, useRef, useState } from 'react'
import { supabase } from './lib/supabase'
import { useAuthStore } from './stores/authStore'
import { useSchoolStore } from './stores/schoolStore'
import { applyBrandTheme } from './services/themeService'
import { LoginPage } from './routes/LoginPage'
import { OnboardingWizard } from './routes/OnboardingWizard'
import { BottomNav, type NavTab as BottomNavTab } from './components/BottomNav'

// App-level tab type extends the bottom-nav tabs with 'home' (the dashboard tab).
// BottomNav only shows timetable/attendance/students/finance/more as visible buttons,
// but App.tsx needs 'home' as the initial landing tab for the admin dashboard.
type NavTab = BottomNavTab | 'home' | 'results' | 'hr' | 'library' | 'announcements' | 'settings' | 'guardians' | 'account_preferences'

// Intent payload — carried from dashboard quick actions into target modules.
// Only the three intents that open a form on arrival are defined here.
// Modules that don't receive an intent ignore the field entirely.
// `guardianId` is a separate, independent payload (not one of the three named
// intents above) — carried when navigating from a student's Guardians tab to
// a specific guardian's detail view in the Guardians module.
export interface NavIntent {
  intent?: 'add_student' | 'record_payment' | 'mark_attendance'
  guardianId?: string
}
import AdminDashboard from './routes/AdminDashboard'
import TeacherDashboard from './routes/TeacherDashboard'
import TimetableModule from './routes/TimetableModule'
import AttendanceModule from './routes/AttendanceModule'
import ResultsModule from './routes/ResultsModule'
import StudentsModule from './routes/StudentsModule'
import FinanceModule from './routes/FinanceModule'
import HRModule from './routes/HRModule'
import LibraryModule from './routes/LibraryModule'
import AnnouncementsModule from './routes/AnnouncementsModule'
import GuardianPortal from './routes/GuardianPortal'
import SettingsModule from './routes/SettingsModule'
import GuardianModule from './routes/GuardianModule'
import AccountPreferencesScreen from './routes/AccountPreferencesScreen'

// ─── School data ──────────────────────────────────────────────────────────

interface SchoolData {
  id: string
  name: string
  slug: string
  logo_url: string | null
  theme_color: string | null
  status: string
  onboarding_complete: boolean
  default_lang: 'en' | 'ar' | 'ha'
  enabled_langs: string[]
  uses_terms: boolean
  uses_ledger: boolean
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
  // staff.id of the signed-in actor, resolved once via app_identities — needed by
  // HRModule so a non-admin staff member can submit/see their own leave requests.
  // Null for guardians/students/platform_admins with no staff row.
  const [currentStaffId, setCurrentStaffId] = useState<string | null>(null)
  // Account popover (👤 header button)
  const [accountPopoverOpen, setAccountPopoverOpen] = useState(false)
  // More sheet (replaces full-screen More tab)
  const [moreSheetOpen, setMoreSheetOpen] = useState(false)
  // Resolved role label for the signed-in staff member — fetched once after login.
  // Null until resolved; shown in account popover.
  const [roleLabel, setRoleLabel] = useState<string | null>(null)
  // onNavigate: switches tab and optionally carries an intent for the target module.
  // Intent is stored separately so the module can read it on mount. Must be declared
  // here, alongside every other hook, never after an early return — a conditional
  // hook call crashes React's hook-order invariant the moment any early-return
  // branch above (no-slug, not-found, suspended, no-session, onboarding) executes.
  const [pendingIntent, setPendingIntent] = useState<NavIntent>({})
  // prefers-reduced-motion — read once; the More sheet's slide transition is
  // skipped entirely when true, per §4.10. matchMedia is read defensively since
  // this file must stay portable to non-DOM environments per §5.
  const [prefersReducedMotion] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  })
  // Swipe-down-to-dismiss tracking for the More sheet (touch only — desktop
  // relies on backdrop-tap and the explicit handle/close control instead).
  const sheetTouchStartY = useRef<number | null>(null)
  const sheetTouchDeltaY = useRef<number>(0)

  function handleSheetTouchStart(e: React.TouchEvent) {
    sheetTouchStartY.current = e.touches[0].clientY
    sheetTouchDeltaY.current = 0
  }
  function handleSheetTouchMove(e: React.TouchEvent) {
    if (sheetTouchStartY.current === null) return
    sheetTouchDeltaY.current = e.touches[0].clientY - sheetTouchStartY.current
  }
  function handleSheetTouchEnd() {
    // Threshold: a deliberate downward drag, not an accidental tap-jitter.
    if (sheetTouchDeltaY.current > 80) {
      setMoreSheetOpen(false)
    }
    sheetTouchStartY.current = null
    sheetTouchDeltaY.current = 0
  }

  const { session, actorType, actorRecordId, isAdminRole, isLoading: authLoading, isInitialized, initialize } = useAuthStore()

  // Initialize auth once on mount
  useEffect(() => {
    initialize()
  }, [initialize])

  // Resolve current actor's staff.id (if they are staff) once a session exists.
  // Same app_identities lookup pattern used by hrService/financeService at write time;
  // done once here at boot since HRModule needs it to filter its leave list, not just
  // to stamp a write.
  useEffect(() => {
    if (!session?.user?.id) {
      setCurrentStaffId(null)
      return
    }
    let cancelled = false
    supabase
      .from('app_identities')
      .select('actor_record_id, actor_type')
      .eq('auth_user_id', session.user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return
        setCurrentStaffId(data?.actor_type === 'staff' ? data.actor_record_id : null)
      })
    return () => { cancelled = true }
  }, [session?.user?.id])

  // Resolve the first role name for the signed-in staff member.
  // Used in the account popover. Non-staff actors get a fixed label derived
  // from their actor type. Runs only when actorRecordId is set.
  useEffect(() => {
    if (actorType !== 'staff' || !actorRecordId) {
      // Guardian/student/platform_admin — derive label from type directly
      if (actorType === 'guardian') setRoleLabel('Guardian')
      else if (actorType === 'student') setRoleLabel('Student')
      else if (actorType === 'platform_admin') setRoleLabel('Platform Admin')
      else setRoleLabel(null)
      return
    }
    let cancelled = false
    supabase
      .from('staff_roles')
      .select('roles(name)')
      .eq('staff_id', actorRecordId)
      .limit(1)
      .then(({ data }) => {
        if (cancelled) return
        if (data && data.length > 0) {
          const roles = data[0].roles as unknown
          let name: string | null = null
          if (Array.isArray(roles) && roles.length > 0) {
            name = (roles[0] as { name: string }).name ?? null
          } else if (roles && !Array.isArray(roles)) {
            name = (roles as { name: string }).name ?? null
          }
          setRoleLabel(name)
        }
      })
    return () => { cancelled = true }
  }, [actorType, actorRecordId])

  // Load school from subdomain
  useEffect(() => {
    const slug = getSlugFromHostname(window.location.hostname)
    if (!slug) {
      setSlugState('no-slug')
      return
    }

    supabase
      .from('schools')
      .select('id, name, slug, logo_url, theme_color, status, onboarding_complete, default_lang, enabled_langs, uses_terms, uses_ledger')
      .eq('slug', slug)
      .maybeSingle()
      .then(({ data }) => {
        if (!data) {
          setSlugState('not-found')
        } else {
          setSchool(data)
          // SESSION 19 fix: App.tsx previously only set its own local
          // `school` state here — useSchoolStore's `school` (read by
          // TeacherDashboard.tsx, AdminDashboard.tsx, etc.) was never
          // written to at all, so it stayed null forever regardless of
          // whether the school actually loaded. This was the root cause
          // of every collapsible card rendering empty: TeacherDashboard's
          // data-fetch effect gates on `useSchoolStore((s) => s.school)`
          // being truthy and was silently bailing out on every mount.
          useSchoolStore.getState().setSchool(data)
          setSlugState('found')
          // PRD Session 23: previously set only --color-brand-600 itself
          // directly, the same single-property gap SettingsModule.tsx had
          // (see themeService.ts's header comment and §11 2026-07-08) —
          // most of index.css was never actually reading that one
          // property reliably (undeclared token, inconsistent fallbacks
          // before this session's :root fix). applyBrandTheme() derives
          // and sets the full accessible scale (tints/shades/on-color)
          // from this one saved hex, in one call, at the earliest point
          // in the app's lifecycle a school record exists — this is what
          // actually closes the "reload shows the wrong color until an
          // admin revisits Settings" gap flagged when this session's
          // Settings-side fix was made.
          if (data.theme_color) {
            applyBrandTheme(data.theme_color)
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
        onComplete={async () => {
          // Re-fetch from the DB rather than optimistically patching local
          // state. completeOnboarding() inside the wizard is now checked and
          // onComplete() only fires after a confirmed successful write, but
          // re-reading here is cheap insurance: the local `school` object
          // must reflect the same ground truth a reload would re-fetch a
          // second later, not an assumption about what the write did.
          const { data } = await supabase
            .from('schools')
            .select('id, name, slug, logo_url, theme_color, status, onboarding_complete, default_lang, enabled_langs, uses_terms, uses_ledger')
            .eq('id', school.id)
            .maybeSingle()
          if (data) {
            setSchool(data)
            useSchoolStore.getState().setSchool(data)
            // PRD Session 23: this re-fetch previously never applied theme
            // at all — a school that set its brand color during the
            // onboarding wizard itself (Step 1, School identity) would see
            // the default blue until they later happened to open Settings
            // and re-save. Same applyBrandTheme() call as the initial
            // school-load effect above, for the same reason.
            if (data.theme_color) {
              applyBrandTheme(data.theme_color)
            }
          }
          setForceShowOnboarding(false)
        }}
      />
    )
  }

  // ─── Main app shell ────────────────────────────────────────────────────

  function onNavigate(tab: NavTab, intent?: NavIntent) {
    setActiveTab(tab)
    setPendingIntent(intent ?? {})
    setMoreSheetOpen(false)    // always close More sheet on navigation
    setAccountPopoverOpen(false) // always close account popover on navigation
  }

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
            onClick={() => setAccountPopoverOpen(prev => !prev)}
            aria-label="Account"
            aria-expanded={accountPopoverOpen}
            aria-haspopup="true"
          >
            👤
          </button>
        </div>
      </header>

      {/* Account popover — anchored to top-right, closed on backdrop tap */}
      {accountPopoverOpen && (
        <>
          {/* Invisible backdrop — closes on tap, no blur so content stays readable */}
          <div
            className="account-popover-backdrop"
            onClick={() => setAccountPopoverOpen(false)}
            aria-hidden="true"
          />
          <div className="account-popover" role="dialog" aria-label="Account">
            <div className="account-popover-header">
              <div className="account-popover-identity">
                <div className="account-popover-name">
                  {(session?.user?.user_metadata?.full_name as string | undefined) ?? session?.user?.email ?? '—'}
                </div>
                {roleLabel && (
                  <div className="account-popover-role">{roleLabel}</div>
                )}
              </div>
              {/* Explicit, operable close control — §4.10 requires a visible control,
                  not just an implicit tap-outside gesture. */}
              <button
                className="account-popover-close"
                onClick={() => setAccountPopoverOpen(false)}
                aria-label="Close account menu"
              >
                ✕
              </button>
            </div>
            <div className="account-popover-divider" />
            {/* Language preference — the orphaned Session 3 toggle's home, per PRD
                Problem 2.2a. No working i18n engine exists yet (PRD Tier 7 / Session
                27), so this surfaces the current language as a disabled/"Coming soon"
                row rather than a second live control duplicating Settings' write path
                — avoids a control that silently does nothing in two places at once. */}
            <div className="account-popover-item account-popover-item--static" aria-disabled="true">
              <span className="account-popover-item-icon">🌐</span>
              <span className="account-popover-item-label">Language</span>
              <span className="account-popover-item-badge">Coming soon</span>
            </div>
            {/* Session 10b — self-service account preferences (password
                today; theme/language/font-size/alarm land here later as
                sections inside the same screen, not new popover items).
                Visible to every signed-in actor (staff, guardian, student,
                platform_admin), not admin-gated: this is "my own account,"
                not an admin action — unlike Audit log directly below it,
                which stays admin/platform_admin-only. */}
            <button
              className="account-popover-item"
              onClick={() => {
                setAccountPopoverOpen(false)
                onNavigate('account_preferences')
              }}
            >
              <span className="account-popover-item-icon">🔑</span>
              <span className="account-popover-item-label">Account preferences</span>
            </button>
            {(isAdminRole || actorType === 'platform_admin') && (
              <button
                className="account-popover-item"
                onClick={() => {
                  setAccountPopoverOpen(false)
                  // Audit log placeholder — routes to settings until dedicated screen exists
                  onNavigate('settings')
                }}
              >
                <span className="account-popover-item-icon">📋</span>
                <span className="account-popover-item-label">Audit log</span>
              </button>
            )}
            <div className="account-popover-divider" />
            <AccountSignOutButton onSignedOut={() => setAccountPopoverOpen(false)} />
          </div>
        </>
      )}

      {/* Page content — module views loaded here */}
      <main className="app-main">
        <TabContent
          tab={activeTab}
          actorType={actorType}
          isAdminRole={isAdminRole}
          schoolId={school.id}
          schoolName={school.name}
          authUserId={session.user.id}
          currentStaffId={currentStaffId}
          actorRecordId={actorRecordId}
          intent={pendingIntent}
          onNavigate={onNavigate}
        />
      </main>

      {/* Bottom navigation */}
      <BottomNav
        activeTab={activeTab as BottomNavTab}
        onNavigate={(tab) => {
          // 'more' is a sheet overlay now, not a routed tab — opening it must
          // not change activeTab, or the screen underneath would itself become
          // the (now pointless) full-screen More content instead of staying
          // visible-but-dimmed behind the sheet, per Problem 2.2b's "never lost"
          // requirement.
          if (tab === 'more') {
            setMoreSheetOpen(true)
            return
          }
          onNavigate(tab)
        }}
        actorType={actorType}
      />

      {/* More sheet — slides up over the dimmed current screen */}
      {moreSheetOpen && (
        <>
          {/* Dimmed/blurred backdrop */}
          <div
            className="more-sheet-backdrop"
            onClick={() => setMoreSheetOpen(false)}
            aria-hidden="true"
          />
          <div
            className={`more-sheet${prefersReducedMotion ? ' more-sheet--no-motion' : ''}`}
            role="dialog"
            aria-modal="true"
            aria-label="More options"
            onTouchStart={handleSheetTouchStart}
            onTouchMove={handleSheetTouchMove}
            onTouchEnd={handleSheetTouchEnd}
          >
            <button
              className="more-sheet-handle"
              aria-label="Close more options"
              onClick={() => setMoreSheetOpen(false)}
            />
            <MoreSheetContent
              isAdmin={isAdminRole || actorType === 'platform_admin'}
              onNavigate={(tab: NavTab, intent?: NavIntent) => {
                // Selecting an item closes the sheet before navigating, not
                // underneath it — per PRD Goal/Files: "should also close the
                // sheet before navigating, not navigate underneath it."
                setMoreSheetOpen(false)
                onNavigate(tab, intent)
              }}
              onOpenSetup={() => {
                setMoreSheetOpen(false)
                setForceShowOnboarding(true)
              }}
            />
          </div>
        </>
      )}
    </div>
  )
}

// ─── Tab content router ───────────────────────────────────────────────────

function TabContent({
  tab,
  actorType,
  isAdminRole,
  schoolId,
  schoolName,
  authUserId,
  currentStaffId,
  actorRecordId,
  intent,
  onNavigate,
}: {
  tab: NavTab
  actorType: 'staff' | 'guardian' | 'student' | 'platform_admin' | null
  isAdminRole: boolean
  schoolId: string
  schoolName: string
  authUserId: string
  currentStaffId: string | null
  actorRecordId: string | null
  intent: NavIntent
  onNavigate: (tab: NavTab, intent?: NavIntent) => void
}) {
  // isAdmin: true only for platform_admin OR staff who hold a role with is_admin_role = true.
  // A plain teacher (staff + is_admin_role = false) is NOT admin — see PRD Tier 1 / Problem 1.1.
  // isAdminRole comes from authStore (resolved via staff_roles → roles.is_admin_role in SESSION 2).
  const isAdmin = isAdminRole || actorType === 'platform_admin'

  // ── Home / Dashboard ──────────────────────────────────────────────────
  if (tab === 'home') {
    // Admin (is_admin_role = true) and platform_admin see the full AdminDashboard.
    if (isAdmin) {
      return <AdminDashboard onNavigate={onNavigate} />
    }
    // Non-admin staff (teachers etc.) — TeacherDashboard built SESSION 14 (Tier 4 /
    // Problem 4.1). Scoped entirely to this teacher's own data (assigned classes,
    // pending score submissions, today's lesson, announcements) — never the
    // school-wide AdminDashboard view, per PRD Tier 1 / Problem 1.1.
    if (actorType === 'staff') {
      // SESSION 18 fix: was gated on currentStaffId (App.tsx's own separate
      // app_identities fetch, line ~160) — that query has no error handling
      // and no confirmed success path independent of authStore's own
      // identity resolution. actorRecordId comes from authStore.ts's
      // resolveIdentity(), which is already proven to resolve correctly
      // (same app_identities table, same filter) because actorType/isAdminRole
      // above depend on it succeeding. Removes a redundant, unverified async
      // dependency from the mount gate rather than adding another one.
      if (!actorRecordId) {
        return (
          <PlaceholderModule
            icon="📖"
            title="Teacher Dashboard"
            description="Loading your dashboard…"
            comingSoon={false}
          />
        )
      }
      return (
        <TeacherDashboard
          staffId={actorRecordId}
          onNavigate={(tab) => onNavigate(tab)}
        />
      )
    }
    // Guardians and students see their read-only portal — first screen is the
    // child's summary, not a menu, per §4.4.
    if (actorType === 'guardian' || actorType === 'student') {
      return (
        <GuardianPortal
          schoolId={schoolId}
          schoolName={schoolName}
          actorType={actorType}
          authUserId={authUserId}
        />
      )
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
    // Guardian/student: BottomNav relabels this slot "Schedule" and it must
    // land on GuardianPortal's own read-only, child-scoped schedule tab —
    // not the staff TimetableModule (whole-school class+teacher grid, with
    // edit chrome for admins). Same GuardianPortal instance 'home' already
    // uses; only the initial internal tab differs.
    if (actorType === 'guardian' || actorType === 'student') {
      return (
        <GuardianPortal
          schoolId={schoolId}
          schoolName={schoolName}
          actorType={actorType}
          authUserId={authUserId}
          initialTab="schedule"
        />
      )
    }
    return <TimetableModule schoolId={schoolId} schoolName={schoolName} isAdmin={isAdmin} />
  }

  if (tab === 'attendance') {
    // Attendance and Finance bottom-nav slots are hidden for guardian/student
    // in BottomNav.tsx (Session 30 nav simplification — all of this is one
    // tap away from Home/GuardianPortal already). This branch is staff/admin
    // only in practice, but guard it anyway rather than trust nav visibility
    // alone, since App.tsx doesn't otherwise know BottomNav hid the button.
    if (actorType === 'guardian' || actorType === 'student') {
      return (
        <GuardianPortal
          schoolId={schoolId}
          schoolName={schoolName}
          actorType={actorType}
          authUserId={authUserId}
          initialTab="attendance"
        />
      )
    }
    return <AttendanceModule schoolId={schoolId} isAdmin={isAdmin} intent={intent.intent} />
  }

  if (tab === 'students') {
    return <StudentsModule schoolId={schoolId} isAdmin={isAdmin} intent={intent.intent} onNavigate={onNavigate} />
  }

  if (tab === 'finance') {
    // See the 'attendance' branch above for why this guard exists even
    // though BottomNav already hides the Finance button for guardian/student.
    if (actorType === 'guardian' || actorType === 'student') {
      return (
        <GuardianPortal
          schoolId={schoolId}
          schoolName={schoolName}
          actorType={actorType}
          authUserId={authUserId}
          initialTab="fees"
        />
      )
    }
    return <FinanceModule schoolId={schoolId} isAdmin={isAdmin} intent={intent.intent} />
  }

  if (tab === 'results') {
    return <ResultsModule schoolId={schoolId} isAdmin={isAdmin} />
  }

  if (tab === 'hr') {
    return (
      <HRModule
        schoolId={schoolId}
        isAdmin={isAdmin}
        authUserId={authUserId}
        currentStaffId={currentStaffId}
      />
    )
  }

  if (tab === 'library') {
    return (
      <LibraryModule
        schoolId={schoolId}
        isAdmin={isAdmin}
        authUserId={authUserId}
      />
    )
  }

  if (tab === 'announcements') {
    return (
      <AnnouncementsModule
        schoolId={schoolId}
        isAdmin={isAdmin}
        actorType={actorType}
      />
    )
  }

  if (tab === 'settings') {
    return <SettingsModule schoolId={schoolId} isAdmin={isAdmin} />
  }

  if (tab === 'guardians') {
    return <GuardianModule schoolId={schoolId} isAdmin={isAdmin} authUserId={authUserId} openGuardianId={intent.guardianId} />
  }

  if (tab === 'account_preferences') {
    return <AccountPreferencesScreen />
  }

  // Note: 'more' is intentionally NOT handled here. Per Problem 2.2b, "More" is
  // a dismissible bottom sheet (rendered at the App component's top level,
  // overlaying whatever tab is currently active) rather than a routed tab
  // destination — see <MoreSheetContent> and the moreSheetOpen JSX block above.

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

// ─── More sheet content ────────────────────────────────────────────────────
// Reuses the exact item list/markup from the former full-screen More tab,
// unchanged, per PRD Problem 2.2b Goal 1 — this is a presentation/container
// change only. Audit log and Sign out are NOT here; they moved to the account
// popover per Problem 2.2a's split (every item moves to exactly one surface).
//
// Updated (Session 10, PRD Problem 3.1, Goal 5): HR and Guardians items now
// require can('hr.staff.view') / can('students.records.view') respectively
// — a staff member with zero permissions in that module no longer sees a
// door to it, per §4.3 progressive disclosure and the PRD's explicit file
// note for this component. Read in-component via useAuthStore, no props
// threading (isAdmin stays a prop — it still gates the separate
// Administration section below, a role-shaped check, not a module-door
// check; see the isAdmin comment further down for why that one intentionally
// was NOT converted this session).
//
// Results, Library, and Announcements items are DELIBERATELY left ungated
// here, not overlooked: the confirmed 46-key permissions catalog (PRD
// Session 8) has no `results.*` or `announcements.*` module at all, so no
// real key exists to gate on without inventing one — same discipline as
// HRModule.tsx's leave-types gap. Library.* keys do exist
// (library.physical.view/manage/fines, library.digital.view), but
// LibraryModule.tsx's own write UI is still isAdmin-gated by a separately
// documented, deliberate simplification (§11 Session 20) — gating just this
// nav item on can('library.*') while the module behind it still checks
// isAdmin would be an inconsistent half-measure, not a fix. Revisit all
// three together once those modules are actually converted.
function MoreSheetContent({
  isAdmin,
  onNavigate,
  onOpenSetup,
}: {
  isAdmin: boolean
  onNavigate: (tab: NavTab, intent?: NavIntent) => void
  onOpenSetup: () => void
}) {
  const can = useAuthStore((s) => s.can)
  const canViewHR = can('hr.staff.view') || isAdmin
  const canViewGuardians = can('students.records.view') || isAdmin

  return (
    <div className="more-menu">
      <div className="more-menu-section">
        <p className="more-menu-section-title">Modules</p>
        <button className="more-menu-item" onClick={() => onNavigate('results')}>
          <span className="more-menu-item-icon">📊</span>
          <div>
            <p className="more-menu-item-label">Results</p>
            <p className="more-menu-item-desc">Scores, report cards, and promotions</p>
          </div>
          <span className="more-menu-item-arrow">›</span>
        </button>
        <button className="more-menu-item" onClick={() => onNavigate('library')}>
          <span className="more-menu-item-icon">📚</span>
          <div>
            <p className="more-menu-item-label">Library</p>
            <p className="more-menu-item-desc">Books, borrowing, and digital resources</p>
          </div>
          <span className="more-menu-item-arrow">›</span>
        </button>
        <button className="more-menu-item" onClick={() => onNavigate('announcements')}>
          <span className="more-menu-item-icon">📢</span>
          <div>
            <p className="more-menu-item-label">Announcements</p>
            <p className="more-menu-item-desc">School notices and messages</p>
          </div>
          <span className="more-menu-item-arrow">›</span>
        </button>
        {canViewHR && (
          <button className="more-menu-item" onClick={() => onNavigate('hr')}>
            <span className="more-menu-item-icon">🗂️</span>
            <div>
              <p className="more-menu-item-label">HR</p>
              <p className="more-menu-item-desc">Staff, leave requests, and payroll</p>
            </div>
            <span className="more-menu-item-arrow">›</span>
          </button>
        )}
        {canViewGuardians && (
          <button className="more-menu-item" onClick={() => onNavigate('guardians')}>
            <span className="more-menu-item-icon">👨‍👩‍👧</span>
            <div>
              <p className="more-menu-item-label">Guardians</p>
              <p className="more-menu-item-desc">Manage parents, link students, set up portal access</p>
            </div>
            <span className="more-menu-item-arrow">›</span>
          </button>
        )}
      </div>

      {isAdmin && (
        <div className="more-menu-section">
          <p className="more-menu-section-title">Administration</p>
          <button className="more-menu-item" onClick={() => onNavigate('settings')}>
            <span className="more-menu-item-icon">⚙️</span>
            <div>
              <p className="more-menu-item-label">Settings</p>
              <p className="more-menu-item-desc">School config, roles, and preferences</p>
            </div>
            <span className="more-menu-item-arrow">›</span>
          </button>
          <button className="more-menu-item" onClick={onOpenSetup}>
            <span className="more-menu-item-icon">🧭</span>
            <div>
              <p className="more-menu-item-label">Setup guide</p>
              <p className="more-menu-item-desc">Return to the onboarding wizard</p>
            </div>
            <span className="more-menu-item-arrow">›</span>
          </button>
        </div>
      )}
    </div>
  )
}

// ─── Account popover sign-out ──────────────────────────────────────────────
// Distinct from the former More-list SignOutButton only in container class
// (account-popover-item, not more-menu-item) — same behavior, new home, per
// Problem 2.2a.
function AccountSignOutButton({ onSignedOut }: { onSignedOut: () => void }) {
  const [signingOut, setSigningOut] = useState(false)
  async function handleSignOut() {
    setSigningOut(true)
    onSignedOut()
    await supabase.auth.signOut()
  }
  return (
    <button
      className="account-popover-item account-popover-item--danger"
      onClick={handleSignOut}
      disabled={signingOut}
    >
      <span className="account-popover-item-icon">🚪</span>
      <span className="account-popover-item-label">{signingOut ? 'Signing out…' : 'Sign out'}</span>
    </button>
  )
}
