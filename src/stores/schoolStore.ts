import { create } from 'zustand'

type School = {
  id: string
  name: string
  slug: string
  logo_url: string | null
  theme_color: string | null
  default_lang: 'en' | 'ar' | 'ha'
  enabled_langs: string[]
  uses_terms: boolean
  uses_ledger: boolean
  status: 'trial' | 'active' | 'suspended' | 'archived'
  onboarding_complete: boolean
}

type SchoolStore = {
  school: School | null
  slug: string | null
  isLoading: boolean
  error: string | null
  setSchool: (school: School) => void
  setSlug: (slug: string) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  reset: () => void
}

export const useSchoolStore = create<SchoolStore>((set) => ({
  school: null,
  slug: null,
  isLoading: false,
  error: null,
  setSchool: (school) => set({ school }),
  setSlug: (slug) => set({ slug }),
  setLoading: (isLoading) => set({ isLoading }),
  setError: (error) => set({ error }),
  reset: () => set({ school: null, slug: null, isLoading: false, error: null }),
}))
