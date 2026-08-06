/**
 * authStore.ts
 * Zustand store for authentication state.
 * Platform-agnostic — no browser-only APIs.
 */

import { create } from 'zustand'
import { supabase } from '../lib/supabase'
import type { Session, User } from '@supabase/supabase-js'
import { loadEffectivePermissionScopes, can as canCheck, canForClass as canForClassCheck } from '../services/permissionsService'
import type { PermissionScopeMap } from '../services/permissionsService'

export type ActorType = 'staff' | 'guardian' | 'student' | 'platform_admin' | null

// PRD Tier 9 / Problem 9.7 — same sessionStorage key App.tsx's own
// read/write pair uses for the remembered active tab. Duplicated here
// (rather than imported) since this codebase has no shared browser-utils
// module today; kept as a single one-line constant + helper, not scattered
// sessionStorage calls, so the key string only needs to match App.tsx's in
// one place. A fresh login (real 'SIGNED_IN' event, never a reload
// restoring an existing session) clears this so App.tsx's next render
// always falls back to 'home', per the owner's explicit "login always
// forces the dashboard" clarification.
const ACTIVE_TAB_STORAGE_KEY = 'activeTab'

function resetStoredActiveTab(): void {
  if (typeof window === 'undefined' || !window.sessionStorage) return
  try {
    window.sessionStorage.removeItem(ACTIVE_TAB_STORAGE_KEY)
  } catch {
    // Same defensive degrade as App.tsx's own helpers — losing this
    // persistence silently is acceptable, throwing out of the auth
    // listener is not.
  }
}

/**
 * Every finance.* permission key relevant to module ENTRY (PRD Tier 9 /
 * Problem 9.1). CONFIRMED against a real, direct query of the live
 * `permissions` table (2026-07-23) — 10 keys, independently cross-checked
 * against the master plan's own Session 8 catalog audit record (identical
 * list), PLUS finance.analytics.view (11th key, added by Problem 9.2's own
 * migration, same session). This intentionally includes several keys
 * FinanceModule.tsx does not wire to any UI action at all (finance.fees.view,
 * finance.payments.view_all, finance.reports.view, finance.installments.manage,
 * finance.ledger.view, finance.ledger.post, finance.discounts.approve) —
 * module ENTRY must be granted to a non-admin holder of ANY of these, per
 * the owner's 2026-07-23 "union of granted permissions" clarification, not
 * just the keys the UI happens to gate a write action on today. A bursar
 * granted only finance.reports.view, say, must still be able to open the
 * module even though no button in it currently reads that specific key.
 *
 * finance.analytics.view is INCLUDED here even though it gates a single,
 * narrow read-only card (Problem 9.2) rather than any write action — it is
 * still a real finance.* key, and Problem 9.1's own rule was "any finance.*
 * key", not "any of the three keys FinanceModule.tsx happens to wire to a
 * button." A staff member holding only finance.analytics.view can therefore
 * enter the module (and will see the balance-summary card, but no write
 * actions) — consistent with the rule as stated, not scope creep.
 *
 * PREREQUISITE: this list is only accurate once Problem 9.2's own
 * migration_tier9_problem_9_2_analytics_key.sql has actually been run and
 * the key confirmed live via `select key from permissions where key like
 * 'finance.%'` — do not trust this comment's count over that query's
 * result if they ever disagree.
 */
const FINANCE_PERMISSION_KEYS = [
  'finance.analytics.view',
  'finance.discounts.apply',
  'finance.discounts.approve',
  'finance.fees.manage',
  'finance.fees.view',
  'finance.installments.manage',
  'finance.ledger.post',
  'finance.ledger.view',
  'finance.payments.record',
  'finance.payments.view_all',
  'finance.reports.view',
] as const

interface AuthState {
  session: Session | null
  user: User | null
  actorType: ActorType
  actorRecordId: string | null   // FK to staff.id / guardians.id / students.id
  schoolId: string | null        // from app_identities — the school this session belongs to
  /**
   * The signed-in staff member's real name/email, read directly from the
   * `staff` table (`staff.full_name`/`staff.email`) — never from Supabase
   * Auth's `user_metadata.full_name`, which is only populated if something
   * explicitly wrote it at signup and is not guaranteed to be set for staff
   * accounts provisioned server-side (PRD Tier 9 / Problem 9.3). Resolved
   * once at login, alongside isAdminRole/permissionScopes, so every screen
   * reads the same value instead of re-deriving it from auth metadata.
   * null for non-staff actor types (guardian/student self-identity is
   * already resolved separately by portalService.ts/GuardianPortal.tsx,
   * which never had this bug — out of scope for this fix per the owner's
   * 2026-07-23 staff-specific clarification) and for a staff member whose
   * row is somehow missing full_name (should not happen given the column's
   * NOT NULL constraint, but the resolver degrades to null rather than
   * throwing, matching resolveAdminRole's own fail-safe convention).
   */
  displayName: string | null
  email: string | null
  /**
   * True only when the signed-in staff member holds at least one role where
   * roles.is_admin_role = true (resolved via staff_roles → roles).
   * Always false for non-staff actor types (guardian, student, platform_admin).
   * Deliberately separate from actorType === 'staff' — every teacher is staff
   * but not every staff member is an admin-role holder.
   * Referenced in §12 of MASTER_PROJECT_PLAN.md as the canonical shape.
   */
  isAdminRole: boolean
  /**
   * Effective permission scopes for the signed-in staff member, resolved via
   * permissionsService.ts's staff-override-first resolution order (see that
   * file's header comment, and MASTER_PROJECT_PLAN.md §7.3/§12 for the full
   * design). Empty for non-staff actor types — guardian/student/platform_admin
   * access is governed by RLS and portal-specific read-only rules, not this
   * permission catalog. PRD Tier 3 / Problem 3.1 / Session 8.
   */
  permissionScopes: PermissionScopeMap
  isLoading: boolean
  isInitialized: boolean
  _authListenerAttached: boolean // internal guard — prevents duplicate onAuthStateChange subscriptions

  // Actions
  initialize: () => Promise<void>
  setSession: (session: Session | null) => void
  clearSession: () => void

  // Permission selectors — PRD Tier 3 / Session 8. Admin bypass wired
  // Session 9 follow-on (locked 2026-07-01, §12): both selectors pass the
  // store's own isAdminRole through to permissionsService.ts automatically,
  // so every call site in the app gets the bypass for free — an admin-role
  // holder is always granted, even with zero explicit permission rows.
  /** True if the key is granted in any scope (unrestricted or restricted to at least one class), or the staff member holds an admin role. */
  can: (key: string) => boolean
  /** True if the key is granted AND either unrestricted or the given classId is in the granted scope — or the staff member holds an admin role. */
  canForClass: (key: string, classId: string) => boolean
  /**
   * True if the signed-in actor may enter the Finance module at all —
   * PRD Tier 9 / Problem 9.1. Admin (isAdminRole) OR the union of every
   * live finance.* permission key, per the owner's 2026-07-23 clarification:
   * entry is gated on admin-OR-any-finance-permission, never admin-only,
   * so a non-admin bursar/accountant role can still open the module.
   * Computed once here (not independently in BottomNav.tsx and App.tsx)
   * so the two call sites can never drift apart — same discipline already
   * applied to nowColState in Session 26.
   *
   * NOTE: keep this key list in sync with the live `permissions` catalog —
   * confirm via `select key from permissions where key like 'finance.%'`
   * before trusting this list from memory (master plan §11 precedent).
   */
  canViewFinance: () => boolean
}

export const useAuthStore = create<AuthState>((set, get) => ({
  session: null,
  user: null,
  actorType: null,
  actorRecordId: null,
  schoolId: null,
  displayName: null,
  email: null,
  isAdminRole: false,
  permissionScopes: new Map(),
  isLoading: true,
  isInitialized: false,
  _authListenerAttached: false,

  initialize: async () => {
    // Guard: under Vite HMR or React StrictMode, effects can re-run.
    // Without this, every call attaches another onAuthStateChange listener
    // and a single auth event ends up resolving identity multiple times.
    if (get()._authListenerAttached) return

    set({ isLoading: true, _authListenerAttached: true })

    // Get current session from Supabase
    const { data: { session } } = await supabase.auth.getSession()

    if (session?.user) {
      await resolveIdentity(session, set)
    } else {
      set({ session: null, user: null, actorType: null, displayName: null, email: null, isAdminRole: false, permissionScopes: new Map(), isLoading: false, isInitialized: true })
    }

    // Subscribe to future auth state changes. `event` here is the real,
    // reliable distinction between a fresh login and every other case this
    // listener fires for (PRD Tier 9 / Problem 9.7) — the initial session
    // restore on a page load/reload is handled entirely by the getSession()
    // branch above and never reaches this callback at all, so a 'SIGNED_IN'
    // event received here always means an actual, just-now sign-in, never a
    // reload simply restoring an already-existing session. Confirmed against
    // the real Supabase client behavior, not assumed from the event's name.
    supabase.auth.onAuthStateChange(async (event, newSession) => {
      if (newSession?.user) {
        if (event === 'SIGNED_IN') {
          // A fresh login must always land on the dashboard, regardless of
          // whatever tab a previous session on this same browser tab last
          // left behind — reset the persisted tab before/alongside identity
          // resolution so App.tsx's next render never picks up a stale value.
          resetStoredActiveTab()
        }
        await resolveIdentity(newSession, set)
      } else {
        get().clearSession()
      }
    })
  },

  setSession: (session) => {
    set({ session, user: session?.user ?? null })
  },

  clearSession: () => {
    // Problem 9.7 — belt-and-suspenders with App.tsx's own AccountSignOutButton
    // reset: either alone is sufficient, but clearing here too removes any
    // ordering-dependent edge case between a sign-out and the next sign-in
    // on the same device/browser tab.
    resetStoredActiveTab()
    set({
      session: null,
      user: null,
      actorType: null,
      actorRecordId: null,
      schoolId: null,
      displayName: null,
      email: null,
      isAdminRole: false,
      permissionScopes: new Map(),
      isLoading: false,
    })
  },

  can: (key) => canCheck(get().permissionScopes, key, get().isAdminRole),
  canForClass: (key, classId) => canForClassCheck(get().permissionScopes, key, classId, get().isAdminRole),
  canViewFinance: () => {
    const { isAdminRole, permissionScopes } = get()
    return FINANCE_PERMISSION_KEYS.some((key) => canCheck(permissionScopes, key, isAdminRole))
  },
}))

// ---------------------------------------------------------------------------
// resolveAdminRole
// For a staff actor, queries staff_roles → roles to determine whether the
// staff member holds at least one role where roles.is_admin_role = true.
// Unions across ALL roles the staff member holds per §3.7: "effective
// permissions are the union." Does not hardcode any role name — only reads
// the is_admin_role boolean from the roles table.
// Returns false (not throws) if the query fails, so a DB error cannot
// silently escalate a teacher to admin — it degrades to the safer default.
//
// Type note: Supabase infers the joined `roles` column as an array type
// ({ is_admin_role: any }[]) from a !inner join on a one-to-many relation.
// We cast through unknown to boolean-check each element safely.
// ---------------------------------------------------------------------------
async function resolveAdminRole(actorRecordId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('staff_roles')
    .select('roles!inner(is_admin_role)')
    .eq('staff_id', actorRecordId)

  if (error || !data || data.length === 0) {
    // Fail safe: treat as non-admin rather than throwing or escalating.
    return false
  }

  // Supabase returns the joined relation as an array per row.
  // Cast through unknown to extract is_admin_role safely regardless of
  // whether the generated type resolves it as object or array.
  return data.some((row) => {
    const roles = row.roles as unknown
    if (Array.isArray(roles)) {
      return (roles as Array<{ is_admin_role: boolean }>).some((r) => r.is_admin_role === true)
    }
    return (roles as { is_admin_role: boolean } | null)?.is_admin_role === true
  })
}

// ---------------------------------------------------------------------------
// resolveIdentity
// Fetch app_identities row to determine actor type and school scoping, then
// resolve isAdminRole and effective permission scopes for staff actors.
// ---------------------------------------------------------------------------
async function resolveIdentity(
  session: Session,
  set: (partial: Partial<AuthState>) => void,
): Promise<void> {
  // First check if platform admin
  const { data: platformAdmin } = await supabase
    .from('platform_admins')
    .select('id')
    .eq('auth_user_id', session.user.id)
    .maybeSingle()

  if (platformAdmin) {
    set({
      session,
      user: session.user,
      actorType: 'platform_admin',
      actorRecordId: platformAdmin.id,
      schoolId: null,
      displayName: null, // platform_admin has no equivalent name lookup — out of this problem's scope
      email: null,
      isAdminRole: false, // platform_admin is its own concept; isAdminRole is school-scoped
      permissionScopes: new Map(), // platform_admin bypasses the school-level permission catalog entirely
      isLoading: false,
      isInitialized: true,
    })
    return
  }

  // Otherwise fetch app_identities
  const { data: identity } = await supabase
    .from('app_identities')
    .select('actor_type, actor_record_id, school_id')
    .eq('auth_user_id', session.user.id)
    .maybeSingle()

  const actorType = (identity?.actor_type as ActorType) ?? null
  const actorRecordId = identity?.actor_record_id ?? null

  // For staff actors, resolve whether they hold an admin-role, their
  // effective permission scopes, and their real name/email (PRD Tier 9 /
  // Problem 9.3). Guardian and student actors don't have admin roles or a
  // permission catalog to resolve (isAdminRole stays false, permissionScopes
  // stays empty for them, same as before), but DO need their own real
  // displayName/email resolved here too — App.tsx's account popover and
  // header chip are shared across every actor type (mounted once, above
  // the guardian/staff routing split), and previously fell through straight
  // to the login email for guardian/student sessions since this branch left
  // displayName/email null for them. portalService.ts/GuardianPortal.tsx
  // already resolve a correct name separately for their own in-module
  // rendering — this is a second, narrower resolution feeding only the
  // shared App.tsx chrome, not a replacement for that existing one.
  //
  // All three staff-branch reads are independent of one another (none
  // depends on another's result), so they run via a single Promise.all
  // rather than three sequential awaits — Goal 1 of Problem 9.3, a genuine
  // performance improvement alongside the name fetch, not just a name fetch
  // riding along.
  let isAdminRole = false
  let permissionScopes: PermissionScopeMap = new Map()
  let displayName: string | null = null
  let email: string | null = null
  if (actorType === 'staff' && actorRecordId) {
    const [adminRole, scopes, profile] = await Promise.all([
      resolveAdminRole(actorRecordId),
      loadEffectivePermissionScopes(actorRecordId),
      resolveStaffProfile(actorRecordId),
    ])
    isAdminRole = adminRole
    permissionScopes = scopes
    displayName = profile.full_name
    email = profile.email
  } else if ((actorType === 'guardian' || actorType === 'student') && actorRecordId) {
    // No admin role or permission catalog applies to these actor types
    // (isAdminRole/permissionScopes stay at their initialized false/empty
    // defaults) — only the name/email resolution is relevant here.
    const profile = await resolveGuardianOrStudentProfile(actorType, actorRecordId)
    displayName = profile.full_name
    email = profile.email
  }

  set({
    session,
    user: session.user,
    actorType,
    actorRecordId,
    schoolId: identity?.school_id ?? null,
    displayName,
    email,
    isAdminRole,
    permissionScopes,
    isLoading: false,
    isInitialized: true,
  })
}

// ---------------------------------------------------------------------------
// resolveStaffProfile
// Reads the signed-in staff member's real full_name/email directly from the
// `staff` table (PRD Tier 9 / Problem 9.3) — rides the same round trip
// pattern as resolveAdminRole/loadEffectivePermissionScopes, keyed on the
// same actorRecordId, run in parallel with them via Promise.all above.
// staff.full_name/staff.email are [STD]-readable by any staff member (no
// admin restriction, per the master plan's schema section) and full_name is
// NOT NULL, so a missing row/column here reflects a genuine query failure,
// not an expected data gap — degrades to null rather than throwing, so a
// transient DB error cannot break login, matching resolveAdminRole's own
// fail-safe convention.
// ---------------------------------------------------------------------------
async function resolveStaffProfile(
  actorRecordId: string,
): Promise<{ full_name: string | null; email: string | null }> {
  const { data, error } = await supabase
    .from('staff')
    .select('full_name, email')
    .eq('id', actorRecordId)
    .maybeSingle()

  if (error || !data) {
    return { full_name: null, email: null }
  }

  return { full_name: data.full_name ?? null, email: data.email ?? null }
}

// ---------------------------------------------------------------------------
// resolveGuardianOrStudentProfile
// Reads the signed-in guardian's or student's real full_name/email directly
// from the `guardians`/`students` table (PRD Tier 9 / Problem 9.3 scope
// extension). App.tsx's account popover and header chip are mounted once,
// above the guardian/staff routing split, and are shared by every actor
// type — before this fix, a guardian/student session left authStore's
// displayName/email null and the popover fell through to the raw login
// email, the same "vague name" bug class Problem 9.3 exists to close for
// staff. This is a separate, narrower resolution than
// portalService.ts/GuardianPortal.tsx's own existing in-module identity
// read (loadPortalIdentity()/loadChildRecord()) — that one was already
// correct and feeds the portal's own screens; this one exists only because
// the shared App-level chrome has no other route to a real name. Both
// `guardians.full_name`/`guardians.email` and `students.full_name`/
// `students.email` are [STD]-readable by the record's own owner; email is
// nullable on both tables (unlike staff.email), so a null email here is a
// legitimate, expected value, not a query failure — only a genuinely
// missing/errored row degrades full_name to null, matching
// resolveStaffProfile's own fail-safe convention.
// ---------------------------------------------------------------------------
async function resolveGuardianOrStudentProfile(
  actorType: 'guardian' | 'student',
  actorRecordId: string,
): Promise<{ full_name: string | null; email: string | null }> {
  const table = actorType === 'guardian' ? 'guardians' : 'students'
  const { data, error } = await supabase
    .from(table)
    .select('full_name, email')
    .eq('id', actorRecordId)
    .maybeSingle()

  if (error || !data) {
    return { full_name: null, email: null }
  }

  return { full_name: data.full_name ?? null, email: data.email ?? null }
}
