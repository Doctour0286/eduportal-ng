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

interface AuthState {
  session: Session | null
  user: User | null
  actorType: ActorType
  actorRecordId: string | null   // FK to staff.id / guardians.id / students.id
  schoolId: string | null        // from app_identities — the school this session belongs to
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
}

export const useAuthStore = create<AuthState>((set, get) => ({
  session: null,
  user: null,
  actorType: null,
  actorRecordId: null,
  schoolId: null,
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
      set({ session: null, user: null, actorType: null, isAdminRole: false, permissionScopes: new Map(), isLoading: false, isInitialized: true })
    }

    // Subscribe to future auth state changes
    supabase.auth.onAuthStateChange(async (_event, newSession) => {
      if (newSession?.user) {
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
    set({
      session: null,
      user: null,
      actorType: null,
      actorRecordId: null,
      schoolId: null,
      isAdminRole: false,
      permissionScopes: new Map(),
      isLoading: false,
    })
  },

  can: (key) => canCheck(get().permissionScopes, key, get().isAdminRole),
  canForClass: (key, classId) => canForClassCheck(get().permissionScopes, key, classId, get().isAdminRole),
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

  // For staff actors, resolve whether they hold an admin-role and their
  // effective permission scopes. Non-staff actors (guardian, student) always
  // have isAdminRole = false and an empty permission map — their access is
  // governed by RLS and portal-specific read-only rules, not this catalog.
  let isAdminRole = false
  let permissionScopes: PermissionScopeMap = new Map()
  if (actorType === 'staff' && actorRecordId) {
    isAdminRole = await resolveAdminRole(actorRecordId)
    permissionScopes = await loadEffectivePermissionScopes(actorRecordId)
  }

  set({
    session,
    user: session.user,
    actorType,
    actorRecordId,
    schoolId: identity?.school_id ?? null,
    isAdminRole,
    permissionScopes,
    isLoading: false,
    isInitialized: true,
  })
}
