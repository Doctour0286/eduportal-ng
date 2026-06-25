/**
 * authStore.ts
 * Zustand store for authentication state.
 * Platform-agnostic — no browser-only APIs.
 */

import { create } from 'zustand'
import { supabase } from '../lib/supabase'
import type { Session, User } from '@supabase/supabase-js'

export type ActorType = 'staff' | 'guardian' | 'student' | 'platform_admin' | null

interface AuthState {
  session: Session | null
  user: User | null
  actorType: ActorType
  actorRecordId: string | null   // FK to staff.id / guardians.id / students.id
  schoolId: string | null        // from app_identities — the school this session belongs to
  isLoading: boolean
  isInitialized: boolean
  _authListenerAttached: boolean // internal guard — prevents duplicate onAuthStateChange subscriptions

  // Actions
  initialize: () => Promise<void>
  setSession: (session: Session | null) => void
  clearSession: () => void
}

export const useAuthStore = create<AuthState>((set, get) => ({
  session: null,
  user: null,
  actorType: null,
  actorRecordId: null,
  schoolId: null,
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
      set({ session: null, user: null, actorType: null, isLoading: false, isInitialized: true })
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
      isLoading: false,
    })
  },
}))

// Fetch app_identities row to determine actor type and school scoping
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

  set({
    session,
    user: session.user,
    actorType: (identity?.actor_type as ActorType) ?? null,
    actorRecordId: identity?.actor_record_id ?? null,
    schoolId: identity?.school_id ?? null,
    isLoading: false,
    isInitialized: true,
  })
}
