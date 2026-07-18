/**
 * App.tsx
 * Top-level routing shell for Eduportal NG.
 *
 * Routing logic (in order):
 * 1. Read subdomain → query schools by slug
 * 2. If no school found → SchoolNotFound
 * 3. If school found but no auth session → PublicHomepage first (no auth
 *    required), "Log in" tap → LoginPage. A wrong-school redirect
 *    (valid-elsewhere credentials on this subdomain) bypasses
 *    PublicHomepage entirely and goes straight to LoginPage's banner —
 *    that's a security-relevant redirect, not a first-time-visitor flow.
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
import { applyBrandTheme, type ThemeMode } from './services/themeService'
import { loadThemePreference, saveThemePreference } from './services/settingsService'
import { LoginPage } from './routes/LoginPage'
import { PublicHomepage } from './routes/PublicHomepage'
import { OnboardingWizard } from './routes/OnboardingWizard'
import { BottomNav, type NavTab as BottomNavTab } from './components/BottomNav'
import { Sidebar } from './components/Sidebar'
import { Icon } from './components/icons'

// App-level tab type extends the bottom-nav tabs with 'home' (the dashboard tab).
// BottomNav only shows timetable/attendance/students/finance/more as visible buttons,
// but App.tsx needs 'home' as the initial landing tab for the admin dashboard.
type NavTab = BottomNavTab | 'home' | 'results' | 'hr' | 'library' | 'announcements' | 'settings' | 'guardians' | 'account_preferences' | 'course_registration' | 'course_attendance' | 'admission'

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

// SESSION 66: TabContent's own copy of the same higher-institution check
// every other module/route-branch site already duplicates locally
// (ResultsModule.tsx, CourseAttendanceModule.tsx, CourseRegistrationModule.tsx,
// MoreSheetContent below) — not exported/shared per those files' own
// "worth promoting to lib/schoolType.ts, out of scope here" note. Named
// distinctly from MoreSheetContent's local `isHigherEd` const (same function
// body) so as not to collide with or shadow it — they're two separate scopes
// in this same file, not one shared binding.
function isHigherEdSchool(schoolType: string | null | undefined): boolean {
  return !!schoolType && ['university', 'polytechnic', 'college_of_education', 'other'].includes(schoolType)
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
import AdmissionModule from './routes/AdmissionModule'
import CourseRegistrationModule from './routes/CourseRegistrationModule'
import CourseAttendanceModule from './routes/CourseAttendanceModule'
import GuardianModule from './routes/GuardianModule'
import AccountPreferencesScreen from './routes/AccountPreferencesScreen'

// ─── School data ──────────────────────────────────────────────────────────

interface SchoolData {
  id: string
  name: string
  slug: string
  // SESSION 55 addition — needed here for two separate, legitimate reasons:
  // (1) SettingsModule's own tab-visibility check (Classes vs Institution
  // tab), and (2) per the §3.16 amendment, this is where a future session's
  // secondary-vs-higher-institution academic-engine branch will read it
  // from. Neither of those exists in this file yet as actual branching
  // logic — this addition only makes the column available; SESSION 56+
  // scopes the actual engine-selection render branch. Do not read this as
  // that branch already being implemented here.
  school_type: string | null
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
  // Set once the wrong-school branch fires signOut() — kept in local state
  // (not derived from session/identitySchoolId) specifically so the message
  // stays on screen after onAuthStateChange's listener clears `session` a
  // moment later. Without this, the !session check further down would start
  // matching on the very next render and silently swap this message for
  // LoginPage before the person has had a chance to read it.
  const [wrongSchoolBlock, setWrongSchoolBlock] = useState(false)
  // PRD Row 34 / Problem 7.1 — local only, deliberately not persisted
  // (sessionStorage/localStorage) across a reload: a fresh visit to the
  // subdomain should show the public homepage again, not skip straight to
  // LoginPage from a stale flag. Reset is implicit — this is component
  // state, gone on unmount/reload, no explicit reset code needed.
  const [homepageAcknowledged, setHomepageAcknowledged] = useState(false)
  const [activeTab, setActiveTab] = useState<NavTab>('home')
  const [forceShowOnboarding, setForceShowOnboarding] = useState(false)
  // staff.id of the signed-in actor, resolved once via app_identities — needed by
  // HRModule so a non-admin staff member can submit/see their own leave requests.
  // Null for guardians/students/platform_admins with no staff row.
  const [currentStaffId, setCurrentStaffId] = useState<string | null>(null)
  // Dark mode (§12, 2026-07-09) — per-account, via app_identity_preferences,
  // works for every actor type (not staffId-gated the way currentStaffId
  // is). Defaults to 'light' until the real preference loads, matching
  // DEFAULT_STAFF_PREFERENCES' own "sensible default before the first
  // read resolves" shape elsewhere in this file.
  const [themeMode, setThemeModeState] = useState<ThemeMode>('light')
  // Account popover (user-icon header button)
  const [accountPopoverOpen, setAccountPopoverOpen] = useState(false)
  // More sheet (replaces full-screen More tab)
  const [moreSheetOpen, setMoreSheetOpen] = useState(false)
  // Resolved role label for the signed-in staff member — fetched once after login.
  // Null until resolved; shown in account popover.
  const [roleLabel, setRoleLabel] = useState<string | null>(null)
  // Header status-badge slot (PRD Problem 6.8) — reusable, not conflict-specific
  // like the reference app's own .header-conflict-badge. Per owner decision:
  // admin/platform_admin only see a real count (pending scores + pending leave
  // requests — the same two figures AdminDashboard.tsx's own "Needs attention"
  // section already computes); every other actor type's badge stays empty for
  // now, not a placeholder zero. Kept as its own lightweight query here rather
  // than reading AdminDashboard's state, since AdminDashboard isn't always the
  // mounted child of this header (teacher/guardian home renders a different
  // component) and the header must work regardless of which one is active.
  const [headerBadgeCount, setHeaderBadgeCount] = useState<number | null>(null)
  // Toast (new scope, not previously named in the PRD — owner-scoped this
  // session to badge-count-increase only, not a general app-wide toast bus).
  // Tracks the last count seen so a toast fires only when the number goes up
  // (a new item appeared since the last check), not on every poll/render.
  const lastBadgeCountRef = useRef<number | null>(null)
  const [badgeToast, setBadgeToast] = useState<{ count: number; delta: number } | null>(null)
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

  const { session, actorType, actorRecordId, schoolId: identitySchoolId, isAdminRole, isLoading: authLoading, isInitialized, initialize, can } = useAuthStore()

  // Initialize auth once on mount
  useEffect(() => {
    initialize()
  }, [initialize])

  // Wrong school → sign out, do not enter this school's shell. Must live
  // here, unconditionally, alongside every other hook — never after an
  // early return (see the pendingIntent comment above for why). Guarded
  // internally against `school`/`session` still being null/loading, since
  // both early states are reachable at the point these hooks run, before
  // any of the slugState/session early-return branches below have fired.
  //
  // A valid Supabase session only proves *who* the person is — auth.users
  // is never school-scoped, so the same credentials work under any
  // subdomain. Nothing before this fix ever checked that the identity
  // resolved via app_identities (identitySchoolId, from authStore) actually
  // belongs to the school this subdomain resolved to (school.id). Every
  // module further down is handed `schoolId={school.id}` — the SUBDOMAIN's
  // school, not the signed-in identity's — so without this check a user
  // could log in under any other school's URL and see that school's
  // name/logo/color in the shell chrome while RLS quietly serves back only
  // their own rows underneath, since RLS keys off auth.uid() regardless of
  // what schoolId prop a component was handed. That's not a data leak (RLS
  // still holds), but it's a real gap at the app's own auth boundary, and
  // RLS being the only thing preventing a leak here is not a design to
  // lean on.
  //
  // platform_admin is deliberately exempt: authStore.ts's resolveIdentity
  // always sets schoolId: null for that actor type (platform admins are not
  // scoped to any single school by design), so this check would otherwise
  // sign every platform admin back out on every school's subdomain.
  //
  // Every other actor type must match exactly, including the null case —
  // a staff/guardian/student session with no resolvable app_identities row
  // (identitySchoolId === null) is signed out too, not waved through. An
  // unresolvable identity is not evidence of belonging here; treating null
  // as "skip the check" was the same class of silent-pass mistake this fix
  // exists to close, just moved one line over.
  const isWrongSchool =
    !!session &&
    !!school &&
    actorType !== 'platform_admin' &&
    identitySchoolId !== school.id

  useEffect(() => {
    if (isWrongSchool) {
      setWrongSchoolBlock(true)
      supabase.auth.signOut()
    } else if (session && school && identitySchoolId === school.id) {
      // Clears the sticky flag once a genuinely matching session exists —
      // otherwise a correct login right after a wrong-school attempt, on
      // the same mounted App instance (no full page reload in between),
      // would stay stuck showing the stale "wrong school" message forever.
      setWrongSchoolBlock(false)
    }
  }, [isWrongSchool, session, school, identitySchoolId])

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

  // Load this signed-in user's theme_mode preference once a session exists.
  // Works for every actor type (staff/guardian/student/platform_admin) —
  // unlike currentStaffId above, this isn't staff-gated, since
  // app_identity_preferences has a row for anyone with a session, not just
  // staff (§12, 2026-07-09: dark mode decided in scope for all actor
  // types, which is exactly why it couldn't live on staff_preferences —
  // see migration_dark_mode.sql). loadThemePreference() self-resolves the
  // auth user via supabase.auth.getUser() rather than taking session.user.id
  // as a param — same "no props, resolve from the current session" shape
  // AccountPreferencesScreen.tsx's own sections already use.
  useEffect(() => {
    if (!session?.user?.id) {
      setThemeModeState('light')
      return
    }
    let cancelled = false
    loadThemePreference().then(({ data }) => {
      if (cancelled) return
      setThemeModeState(data)
    })
    return () => { cancelled = true }
  }, [session?.user?.id])

  // Reflects themeMode onto the DOM as data-theme, which index.css's
  // [data-theme="dark"] block reads. Separate from the load effect above
  // so a same-session toggle (setThemeMode below) re-applies immediately
  // without waiting on a network round trip.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', themeMode)
  }, [themeMode])

  // Re-derive the brand scale whenever either input changes — the school's
  // theme_color (set once `school` loads) or themeMode (set once the
  // preference loads, or on toggle). Both applyBrandTheme call sites
  // further down (initial school load, onboarding re-fetch) pass
  // `themeMode` too, but neither of them re-fires on a LATER themeMode
  // change on its own — a school load event and a theme toggle are
  // independent triggers, so this effect is what actually re-derives the
  // scale when someone flips the toggle after the school already loaded.
  // Deliberately re-reads school.theme_color from useSchoolStore rather
  // than closing over the schools-query response directly, since that's
  // the same store TeacherDashboard/AdminDashboard already treat as the
  // ground truth for "the currently loaded school."
  useEffect(() => {
    const currentSchool = useSchoolStore.getState().school
    if (currentSchool?.theme_color) {
      applyBrandTheme(currentSchool.theme_color, themeMode)
    }
  }, [themeMode])

  // Exposed to AccountPreferencesScreen.tsx's Theme section via a prop
  // threaded through the account_preferences route below — saves to
  // app_identity_preferences (fire-and-forget from this function's own
  // perspective; the section itself surfaces the error) and updates local
  // state immediately so data-theme (and the brand re-derivation effect
  // above) reflect the change without waiting on the save round trip.
  async function setThemeMode(mode: ThemeMode): Promise<{ error: string | null }> {
    setThemeModeState(mode)
    return saveThemePreference(mode)
  }

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

  // Header status-badge count (PRD Problem 6.8, admin-only per owner decision).
  // Same two figures AdminDashboard.tsx's own "Needs attention" section reads
  // (pending scores + pending leave requests) — kept as a separate lightweight
  // query here since this header renders regardless of which dashboard
  // component is mounted as the 'home' tab's child. Non-admin actor types
  // never run this effect at all — setHeaderBadgeCount is simply never called
  // for them, so the badge slot stays at its initial null (no fake zero shown).
  useEffect(() => {
    const isAdmin = isAdminRole || actorType === 'platform_admin'
    if (!isAdmin || !school?.id) return
    let cancelled = false

    async function loadBadgeCount() {
      const [scoresRes, leaveRes] = await Promise.all([
        supabase.from('scores').select('id', { count: 'exact', head: true }).is('approved_at', null),
        supabase.from('leave_requests').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
      ])
      if (cancelled) return
      const total = (scoresRes.count ?? 0) + (leaveRes.count ?? 0)
      const previous = lastBadgeCountRef.current
      // Toast only on a real increase — not on first load (previous === null)
      // and not when the count drops or stays flat, so dismissing/approving
      // items elsewhere never triggers a spurious toast.
      if (previous !== null && total > previous) {
        setBadgeToast({ count: total, delta: total - previous })
      }
      lastBadgeCountRef.current = total
      setHeaderBadgeCount(total)
    }

    loadBadgeCount()
    // Poll at a modest interval — good enough for a "new item appeared" nudge
    // without hammering the two count queries; matches this app's existing
    // preference for simple polling over a realtime subscription elsewhere.
    const interval = setInterval(loadBadgeCount, 60_000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [isAdminRole, actorType, school?.id])

  // Auto-dismiss the badge toast after a few seconds — matches this file's
  // reduced-motion-aware transition convention (see the More sheet), not a
  // new animation system.
  useEffect(() => {
    if (!badgeToast) return
    const timer = setTimeout(() => setBadgeToast(null), 5000)
    return () => clearTimeout(timer)
  }, [badgeToast])

  // Load school from subdomain
  useEffect(() => {
    const slug = getSlugFromHostname(window.location.hostname)
    if (!slug) {
      setSlugState('no-slug')
      return
    }

    supabase
      .from('schools')
      .select('id, name, slug, school_type, logo_url, theme_color, status, onboarding_complete, default_lang, enabled_langs, uses_terms, uses_ledger')
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
            applyBrandTheme(data.theme_color, themeMode)
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
          <span className="not-found-icon"><Icon name="school" size={40} /></span>
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
          <span className="suspended-icon"><Icon name="alert-triangle" size={40} /></span>
          <h1>{school.name}</h1>
          <p>This school's account is currently suspended. Please contact the school administration.</p>
        </div>
      </div>
    )
  }

  // ─── Wrong school → sign out, do not enter this school's shell ───────
  // Must run BEFORE the "not logged in" check below, not after. Once
  // signOut() (fired from the effect above) resolves, session flips to
  // null a moment later — if the !session check ran first, it would win
  // on that next render and silently swap this message for LoginPage
  // before the person could read it (the exact blink this ordering fixes).
  // wrongSchoolBlock is the sticky flag that keeps this branch winning
  // regardless of what session does afterward; isWrongSchool alone would
  // stop being true the instant session clears (it requires !!session).
  // ─── Wrong school, or not logged in → Login (with banner if relevant) ──
  // Previously a separate full "Wrong school" page — replaced per owner
  // request with a banner on the same LoginPage the person would otherwise
  // see, so they can immediately retry with different credentials for
  // this school without a reload. Message kept deliberately generic (not
  // naming the person's actual correct school) per owner direction — see
  // the isWrongSchool/useEffect block above for the reasoning on why.
  //
  // This branch deliberately bypasses PublicHomepage entirely — a wrong-
  // school redirect means someone already has valid-elsewhere credentials
  // and got signed out of *this* subdomain, not a first-time anonymous
  // visitor; showing them this school's public content first would be a
  // confusing (and mildly information-disclosing) detour, not a courtesy.
  if (isWrongSchool || wrongSchoolBlock) {
    return (
      <LoginPage
        schoolId={school.id}
        schoolName={school.name}
        logoUrl={school.logo_url}
        themeColor={school.theme_color}
        topLevelError="This isn't your school — check the URL or link your school gave you."
      />
    )
  }

  // ─── Not logged in, first visit → PublicHomepage before LoginPage ─────
  // PRD Row 34 / Problem 7.1. homepageAcknowledged flips true only when
  // the person taps "Log in" on PublicHomepage itself — a plain !session
  // with no acknowledgement yet always shows the public page first, per
  // this problem's own Definition of Done ("visiting the subdomain in an
  // incognito/logged-out browser shows..."). Once acknowledged, LoginPage
  // renders with no error banner (this is the ordinary path, not a
  // wrong-school redirect).
  if (!session && !homepageAcknowledged) {
    return (
      <PublicHomepage
        slug={school.slug}
        onLogin={() => setHomepageAcknowledged(true)}
      />
    )
  }

  if (!session) {
    return (
      <LoginPage
        schoolId={school.id}
        schoolName={school.name}
        logoUrl={school.logo_url}
        themeColor={school.theme_color}
        topLevelError={null}
        // Owner request, 2026-07-11: back button returns to PublicHomepage.
        // Only wired here, not on the wrong-school branch above — that
        // redirect is security-relevant (valid-elsewhere credentials on
        // the wrong subdomain), not an ordinary first visit, and offering
        // a way "back" into this school's public content there would be
        // the same disclosure risk this file's own PublicHomepage routing
        // comment already flags. homepageAcknowledged flipping back to
        // false is exactly the state PublicHomepage's own branch above
        // checks — no new state needed.
        onBack={() => setHomepageAcknowledged(false)}
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
            .select('id, name, slug, school_type, logo_url, theme_color, status, onboarding_complete, default_lang, enabled_langs, uses_terms, uses_ledger')
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
              applyBrandTheme(data.theme_color, themeMode)
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

  const canViewStudentsForSidebar = can('students.records.view') || actorType === 'platform_admin'

  return (
    <div className="app-shell">
      {/* Sidebar — larger-viewport addition only (PRD Problem 6.8). Renders
          nothing on phone-sized viewports via CSS; BottomNav below remains
          unchanged and is the only nav at that size. */}
      <Sidebar
        activeTab={activeTab}
        onNavigate={(tab) => onNavigate(tab as NavTab)}
        actorType={actorType}
        canViewStudents={canViewStudentsForSidebar}
        schoolName={school.name}
        logoUrl={school.logo_url}
        moreContent={
          actorType === 'guardian' || actorType === 'student' ? null : (
            <MoreSheetContent
              isAdmin={isAdminRole || actorType === 'platform_admin'}
              schoolType={school.school_type}
              onNavigate={(tab: NavTab, intent?: NavIntent) => onNavigate(tab, intent)}
              onOpenSetup={() => setForceShowOnboarding(true)}
            />
          )
        }
      />

      <div className="app-shell-main">
      {/* Top header */}
      <header className="app-header">
        <div className="app-header-left">
          {school.logo_url && (
            <img src={school.logo_url} alt={school.name} className="app-header-logo" />
          )}
          <span className="app-header-school-name">{school.name}</span>
        </div>
        <div className="app-header-right">
          {/* Compact identity chip (PRD Problem 6.8) — name initial + resolved
              role label, matching the reference app's .header-user-chip. Reuses
              roleLabel, already fetched once after login for the account popover
              (no second identity query). Renders nothing until roleLabel resolves,
              same graceful-degradation convention used throughout this file. */}
          {roleLabel && (
            <div className="app-header-user-chip" aria-hidden="true">
              <span className="app-header-user-chip-avatar">
                {(session?.user?.user_metadata?.full_name as string | undefined)?.[0]?.toUpperCase() ?? '•'}
              </span>
              <span className="app-header-user-chip-role">{roleLabel}</span>
            </div>
          )}
          <button
            className="icon-btn app-header-account-btn"
            onClick={() => setAccountPopoverOpen(prev => !prev)}
            aria-label={headerBadgeCount ? `Account, ${headerBadgeCount} items need attention` : 'Account'}
            aria-expanded={accountPopoverOpen}
            aria-haspopup="true"
          >
            <Icon name="user" />
            {/* Reusable status-badge slot (PRD Problem 6.8) — deliberately not
                conflict-specific like the reference app's own .header-conflict-badge.
                Wired to admin/platform_admin's pending scores + leave requests count
                (see the effect above); every other actor type never has
                setHeaderBadgeCount called, so this stays null and renders nothing. */}
            {headerBadgeCount !== null && headerBadgeCount > 0 && (
              <span className="app-header-status-badge">{headerBadgeCount > 99 ? '99+' : headerBadgeCount}</span>
            )}
          </button>
        </div>
      </header>

      {/* Badge-count toast — fires only when headerBadgeCount increases since
          the last check (new item appeared), not on every poll. New scope,
          not previously named in the PRD; owner explicitly scoped this to
          badge-count-increase only, not a general app-wide toast system.
          Purely informational — dismiss via its own button or the 5s
          auto-timeout; does not open the account popover on tap. */}
      {badgeToast && (
        <div
          className={`app-badge-toast${prefersReducedMotion ? ' app-badge-toast--no-motion' : ''}`}
          role="status"
          aria-live="polite"
        >
          <span className="app-badge-toast-icon" aria-hidden="true"><Icon name="bell" size={16} /></span>
          <span className="app-badge-toast-text">
            {badgeToast.delta === 1 ? '1 new item needs attention' : `${badgeToast.delta} new items need attention`}
          </span>
          <button
            type="button"
            className="app-badge-toast-close"
            onClick={() => setBadgeToast(null)}
            aria-label="Dismiss notification"
          >
            <Icon name="x" size={14} />
          </button>
        </div>
      )}

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
                <Icon name="x" size={18} />
              </button>
            </div>
            <div className="account-popover-divider" />
            {/* Language preference — the orphaned Session 3 toggle's home, per PRD
                Problem 2.2a. No working i18n engine exists yet (PRD Tier 7 / Session
                27), so this surfaces the current language as a disabled/"Coming soon"
                row rather than a second live control duplicating Settings' write path
                — avoids a control that silently does nothing in two places at once. */}
            <div className="account-popover-item account-popover-item--static" aria-disabled="true">
              <span className="account-popover-item-icon"><Icon name="globe" size={18} /></span>
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
              <span className="account-popover-item-icon"><Icon name="key" size={18} /></span>
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
                <span className="account-popover-item-icon"><Icon name="clipboard-list" size={18} /></span>
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
          schoolLogoUrl={school.logo_url}
          schoolType={school.school_type}
          authUserId={session.user.id}
          currentStaffId={currentStaffId}
          actorRecordId={actorRecordId}
          themeMode={themeMode}
          setThemeMode={setThemeMode}
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
              schoolType={school.school_type}
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
  // PRD Tier 6 / Problem 6.10 follow-up (2026-07-10) — needed for the
  // student ID card print feature's logo slot. A genuine pre-existing gap,
  // not previously threaded through TabContent at all despite school.logo_url
  // already being read at the top-level App component for the header <img>
  // and GuardianPortal/LoginPage's own logoUrl props — closed here rather
  // than silently left missing.
  schoolLogoUrl,
  // SESSION 55 — needed only for the Settings tab's visibility check
  // (whether to show the Institution tab vs. Classes tab). Same kind of
  // pre-existing gap as schoolLogoUrl above: not previously threaded
  // through TabContent despite school.school_type being read at the
  // top-level App component already.
  schoolType,
  authUserId,
  currentStaffId,
  actorRecordId,
  themeMode,
  setThemeMode,
  intent,
  onNavigate,
}: {
  tab: NavTab
  actorType: 'staff' | 'guardian' | 'student' | 'platform_admin' | null
  isAdminRole: boolean
  schoolId: string
  schoolName: string
  schoolLogoUrl: string | null
  schoolType: string | null
  authUserId: string
  currentStaffId: string | null
  actorRecordId: string | null
  themeMode: ThemeMode
  setThemeMode: (mode: ThemeMode) => Promise<{ error: string | null }>
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
    // schoolType threaded in (SESSION 66 build-error fix) so AdminDashboard's
    // today's-attendance stat card can branch by school type without relying
    // on useSchoolStore's School type carrying school_type — it doesn't (see
    // the tsc error this replaces), and schoolStore.ts wasn't available to
    // confirm it's safe/complete to add there. Same prop-threading pattern
    // already used for ResultsModule/CourseAttendanceModule/SettingsModule
    // above, not a new shape.
    if (isAdmin) {
      return <AdminDashboard onNavigate={onNavigate} schoolType={schoolType} />
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
            icon={<Icon name="book-open" size={32} />}
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
          schoolType={schoolType}
        />
      )
    }
    return (
      <PlaceholderModule
        icon={<Icon name="home" size={32} />}
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
          schoolType={schoolType}
        />
      )
    }
    // SESSION 68: schoolType threaded in so TimetableModule's own thin
    // dispatcher can branch to TimetableModuleHigherEd for a higher-ed
    // school, mirroring the 'attendance' branch's SESSION 66 precedent
    // exactly. currentStaffId also threaded (previously omitted from this
    // call site entirely) — TimetableModuleHigherEd needs it to resolve a
    // non-admin lecturer's own assigned offerings; TimetableModuleSecondary
    // already declared this prop optional and simply had it default to
    // null before this fix (its alarm-widget feature staying off), so this
    // is a genuine, additive fix for both branches, not new scope for
    // either. Owner-scoped: this branch only ever renders for a staff
    // actor (guardian/student are routed to GuardianPortal above, before
    // reaching this line) — a real, tracked-forward gap, not silently
    // dropped: GuardianPortal.tsx has no course-offering-timetable
    // awareness yet, same class of gap SESSION 58's own tracked-forward
    // list already flagged for this file generally (item 3, course
    // attendance/eligibility). TimetableModuleHigherEd's own student-view
    // code path (currentStudentId prop, loadOfferingsForStudent()) is
    // fully built and typed, ready to be wired in once GuardianPortal.tsx
    // gains a real route to it — not wasted work, just not reachable yet.
    return (
      <TimetableModule
        schoolId={schoolId}
        schoolName={schoolName}
        isAdmin={isAdmin}
        schoolType={schoolType}
        currentStaffId={actorRecordId}
      />
    )
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
          schoolType={schoolType}
        />
      )
    }
    // SESSION 66: branch by school type at the route level, mirroring
    // ResultsModule.tsx's own SESSION 60 dispatcher-split precedent exactly
    // (schoolType decides which of two entirely separate modules renders;
    // never threaded further down into either module's own tree beyond the
    // prop each already declares). Before this fix, a higher-ed school's
    // BottomNav "Attendance" slot always rendered the secondary-school
    // class-attendance module regardless of school_type — CourseAttendanceModule
    // only existed as a second, additive entry buried in the More menu
    // (MoreSheetContent's canViewCourseAttendance button below), so a
    // higher-ed school saw BOTH attendance systems live at once instead of
    // exactly one. This tab is now the canonical destination for course
    // attendance at a higher-ed school. The More-menu button is deliberately
    // LEFT IN PLACE for now (not removed) — BottomNav.tsx wasn't available to
    // confirm the 'attendance' slot is visible to every staff role (e.g. a
    // non-admin lecturer), so cutting that second entry point on an
    // inference risks a real regression. Once BottomNav.tsx confirms the
    // slot's visibility rules, the More-menu button becomes a genuinely
    // redundant second door to the same destination and can be removed as
    // its own small follow-up — logged, not silently dropped.
    if (isHigherEdSchool(schoolType)) {
      return <CourseAttendanceModule schoolId={schoolId} isAdmin={isAdmin} schoolType={schoolType} />
    }
    return <AttendanceModule schoolId={schoolId} isAdmin={isAdmin} intent={intent.intent} />
  }

  if (tab === 'students') {
    // schoolName added (PRD Tier 6 / Problem 6.10) — needed for the new
    // student ID card print feature's header, same reasoning and same
    // threading pattern as TimetableModule's own schoolName prop two
    // branches up (added there for its print page header). schoolLogoUrl
    // added the same way, same session, for the card's logo slot.
    // schoolType added SESSION 60e — needed to gate the new admin
    // Transcript tab to higher-ed schools only, matching this same
    // isHigherEd check's own four other call sites below (GuardianPortal's
    // 'home'/'timetable'/'attendance'/'finance' branches, SESSION 60b).
    return <StudentsModule schoolId={schoolId} schoolName={schoolName} schoolLogoUrl={schoolLogoUrl} schoolType={schoolType} isAdmin={isAdmin} intent={intent.intent} onNavigate={onNavigate} />
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
          schoolType={schoolType}
        />
      )
    }
    return <FinanceModule schoolId={schoolId} isAdmin={isAdmin} intent={intent.intent} />
  }

  if (tab === 'results') {
    // schoolType passed through (Session 60) so ResultsModule can branch to
    // the higher-ed course-results/GPA view — same pattern already used two
    // branches above for CourseRegistrationModule/CourseAttendanceModule.
    return <ResultsModule schoolId={schoolId} isAdmin={isAdmin} schoolType={schoolType} />
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
    return <SettingsModule schoolId={schoolId} isAdmin={isAdmin} themeMode={themeMode} schoolType={schoolType} actorRecordId={actorRecordId} onNavigate={onNavigate} />
  }

  if (tab === 'admission') {
    // SESSION 65 §12 correction — admission moved out of Settings entirely:
    // high-frequency operational workflow, not a rarely-touched config
    // screen, so it gets its own route rather than a Settings sub-tab.
    // Gated at the nav layer (MoreSheetContent, admin-or-permission-key),
    // not re-checked here — matches course_registration/course_attendance's
    // own precedent immediately above/below.
    return <AdmissionModule schoolId={schoolId} />
  }

  if (tab === 'course_registration') {
    // Higher-institution-only, same as SettingsModule's Institution/
    // Curriculum tabs — CourseRegistrationModule itself also gates on
    // isHigherInstitutionSchoolType internally (its own local copy of the
    // same check, since it's a separate module and that helper isn't
    // exported from SettingsModule.tsx), so this route-level branch is a
    // defense-in-depth guard, not the only gate.
    return <CourseRegistrationModule schoolId={schoolId} isAdmin={isAdmin} schoolType={schoolType} />
  }

  if (tab === 'course_attendance') {
    // Higher-institution-only (PRD Tier 8 / Problem 8.7, SESSION 58) — same
    // shape as course_registration above, but unlike registration this is a
    // per-lecturer operational task, not an admin/registrar one (SESSION
    // 58's own card: "a lecturer takes attendance for a real course
    // offering"), so it's NOT admin-gated at the nav level — see
    // MoreSheetContent's canViewCourseAttendance below, which mirrors
    // canViewHR/canViewGuardians' permission-based visibility, not
    // isHigherEd-and-isAdmin's admin-only shape. CourseAttendanceModule
    // resolves its own current session internally (loadCurrentSession(),
    // same source AttendanceModule.tsx uses) — no sessionId prop needed.
    // schoolType is passed through so the module can run its own internal
    // isHigherInstitutionSchoolType gate (its own local copy, same pattern
    // as CourseRegistrationModule's) — this route-level branch alone was
    // not a real defense-in-depth guard until that internal gate existed.
    return <CourseAttendanceModule schoolId={schoolId} isAdmin={isAdmin} schoolType={schoolType} />
  }

  if (tab === 'guardians') {
    return <GuardianModule schoolId={schoolId} isAdmin={isAdmin} authUserId={authUserId} openGuardianId={intent.guardianId} />
  }

  if (tab === 'account_preferences') {
    return <AccountPreferencesScreen themeMode={themeMode} setThemeMode={setThemeMode} />
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
  icon: React.ReactNode
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
  schoolType,
  onNavigate,
  onOpenSetup,
}: {
  isAdmin: boolean
  schoolType: string | null
  onNavigate: (tab: NavTab, intent?: NavIntent) => void
  onOpenSetup: () => void
}) {
  const can = useAuthStore((s) => s.can)
  const canViewHR = can('hr.staff.view') || isAdmin
  const canViewGuardians = can('students.records.view') || isAdmin
  // SESSION 66: canViewCourseAttendance's own More-menu button (the one
  // real call site) was removed above — the BottomNav "Attendance" tab is
  // now the canonical destination for course attendance at a higher-ed
  // school, confirmed on-device. The const itself is removed too rather
  // than left dead (would fail a strict noUnusedLocals build, and a stray
  // unused permission check is exactly the kind of drift this codebase's
  // own history has already caught more than once).
  // Admission (PRD Tier 8 / Problem 8.7a, SESSION 65 §12 correction) — new
  // permission key, deliberately distinct from
  // academics.institution_structure.manage per that decision (see this
  // session's own comment on AdmissionModule.tsx for why reusing the
  // institution-structure key was wrong). NOT YET in the permissions
  // catalog — needs a real DB insert before can() will ever return true for
  // it; until that row exists, only isAdmin unlocks this entry. See the SQL
  // provided alongside this change.
  const canViewAdmission = can('academics.admission.manage') || isAdmin
  // Duplicated from SettingsModule.tsx's own private (unexported) list —
  // see CourseRegistrationModule.tsx's header note on the same
  // duplication. Course registration is a higher-institution-only concept
  // (PRD Tier 8 / Problem 8.7): a secondary school has no programme/level
  // structure or course catalogue for this screen to operate on at all.
  const isHigherEd = !!schoolType && ['university', 'polytechnic', 'college_of_education', 'other'].includes(schoolType)

  return (
    <div className="more-menu">
      <div className="more-menu-section">
        <p className="more-menu-section-title">Modules</p>
        <button className="more-menu-item" onClick={() => onNavigate('results')}>
          <span className="more-menu-item-icon"><Icon name="bar-chart" /></span>
          <div>
            <p className="more-menu-item-label">Results</p>
            <p className="more-menu-item-desc">Scores, report cards, and promotions</p>
          </div>
          <span className="more-menu-item-arrow">›</span>
        </button>
        <button className="more-menu-item" onClick={() => onNavigate('library')}>
          <span className="more-menu-item-icon"><Icon name="book" /></span>
          <div>
            <p className="more-menu-item-label">Library</p>
            <p className="more-menu-item-desc">Books, borrowing, and digital resources</p>
          </div>
          <span className="more-menu-item-arrow">›</span>
        </button>
        <button className="more-menu-item" onClick={() => onNavigate('announcements')}>
          <span className="more-menu-item-icon"><Icon name="megaphone" /></span>
          <div>
            <p className="more-menu-item-label">Announcements</p>
            <p className="more-menu-item-desc">School notices and messages</p>
          </div>
          <span className="more-menu-item-arrow">›</span>
        </button>
        {canViewHR && (
          <button className="more-menu-item" onClick={() => onNavigate('hr')}>
            <span className="more-menu-item-icon"><Icon name="folder" /></span>
            <div>
              <p className="more-menu-item-label">HR</p>
              <p className="more-menu-item-desc">Staff, leave requests, and payroll</p>
            </div>
            <span className="more-menu-item-arrow">›</span>
          </button>
        )}
        {canViewGuardians && (
          <button className="more-menu-item" onClick={() => onNavigate('guardians')}>
            <span className="more-menu-item-icon"><Icon name="users" /></span>
            <div>
              <p className="more-menu-item-label">Guardians</p>
              <p className="more-menu-item-desc">Manage parents, link students, set up portal access</p>
            </div>
            <span className="more-menu-item-arrow">›</span>
          </button>
        )}
        {/* SESSION 66: Course Attendance button removed from here — the
            BottomNav "Attendance" tab now branches by school_type
            (App.tsx's TabContent) and is the canonical destination for a
            higher-ed school. Confirmed safe to remove this second door:
            BottomNav.tsx shows 'attendance' is only guardianHidden, not
            staffOnly or permission-gated, so every staff role (including a
            non-admin lecturer) already reaches the tab directly — nothing
            was reachable here that isn't reachable via the tab. Owner
            confirmed on-device 2026-07-18. */}
        {canViewAdmission && (
          <button className="more-menu-item" onClick={() => onNavigate('admission')}>
            <span className="more-menu-item-icon"><Icon name="users" /></span>
            <div>
              <p className="more-menu-item-label">Admission</p>
              <p className="more-menu-item-desc">Admit students, generate matric numbers, set the format</p>
            </div>
            <span className="more-menu-item-arrow">›</span>
          </button>
        )}
      </div>

      {isAdmin && (
        <div className="more-menu-section">
          <p className="more-menu-section-title">Administration</p>
          <button className="more-menu-item" onClick={() => onNavigate('settings')}>
            <span className="more-menu-item-icon"><Icon name="settings" /></span>
            <div>
              <p className="more-menu-item-label">Settings</p>
              <p className="more-menu-item-desc">School config, roles, and preferences</p>
            </div>
            <span className="more-menu-item-arrow">›</span>
          </button>
          {isHigherEd && (
            <button className="more-menu-item" onClick={() => onNavigate('course_registration')}>
              <span className="more-menu-item-icon"><Icon name="book-open" /></span>
              <div>
                <p className="more-menu-item-label">Course Registration</p>
                <p className="more-menu-item-desc">Register students into courses each session</p>
              </div>
              <span className="more-menu-item-arrow">›</span>
            </button>
          )}
          <button className="more-menu-item" onClick={onOpenSetup}>
            <span className="more-menu-item-icon"><Icon name="compass" /></span>
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
      <span className="account-popover-item-icon"><Icon name="log-out" size={18} /></span>
      <span className="account-popover-item-label">{signingOut ? 'Signing out…' : 'Sign out'}</span>
    </button>
  )
}
