import { create } from 'zustand'

type ActorType = 'staff' | 'guardian' | 'student'

type AuthUser = {
  authUserId: string
  schoolId: string
  actorType: ActorType
  actorRecordId: string
  loginMethod: 'email_password' | 'phone_otp' | 'login_code'
  isActive: boolean
}

type AuthStore = {
  user: AuthUser | null
  isLoading: boolean
  isAuthenticated: boolean
  setUser: (user: AuthUser) => void
  setLoading: (loading: boolean) => void
  logout: () => void
}

export const useAuthStore = create<AuthStore>((set) => ({
  user: null,
  isLoading: true,
  isAuthenticated: false,
  setUser: (user) => set({ user, isAuthenticated: true, isLoading: false }),
  setLoading: (isLoading) => set({ isLoading }),
  logout: () => set({ user: null, isAuthenticated: false, isLoading: false }),
}))
