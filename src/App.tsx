import { useEffect } from 'react'
import { useSchoolStore } from './stores/schoolStore'
import { supabase } from './lib/supabase'

function getSlugFromHostname(): string | null {
  const hostname = window.location.hostname
  // localhost dev: expects format like "dilimi.localhost"
  // production: expects format like "dilimi.eduportal.ng"
  const parts = hostname.split('.')
  if (parts.length >= 2 && parts[0] !== 'localhost' && parts[0] !== 'www') {
    return parts[0]
  }
  return null
}

export default function App() {
  const { school, slug, isLoading, error, setSchool, setSlug, setLoading, setError } = useSchoolStore()

  useEffect(() => {
    const detectedSlug = getSlugFromHostname()
    if (!detectedSlug) {
      setError('no-slug')
      setLoading(false)
      return
    }
    setSlug(detectedSlug)
    setLoading(true)

    supabase
      .from('schools')
      .select('id, name, slug, logo_url, theme_color, default_lang, enabled_langs, uses_terms, uses_ledger, status, onboarding_complete')
      .eq('slug', detectedSlug)
      .single()
      .then(({ data, error: err }) => {
        if (err || !data) {
          setError('not-found')
        } else {
          setSchool(data)
        }
        setLoading(false)
      })
  }, [])

  if (isLoading) {
    return (
      <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>Loading…</p>
      </div>
    )
  }

  if (error === 'no-slug') {
    return (
      <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--space-8)' }}>
        <div style={{ textAlign: 'center' }}>
          <h1 style={{ fontSize: 'var(--text-2xl)', fontWeight: 700, marginBottom: 'var(--space-4)' }}>Eduportal NG</h1>
          <p style={{ color: 'var(--color-text-muted)' }}>Visit your school's link to get started.</p>
        </div>
      </div>
    )
  }

  if (error === 'not-found') {
    return (
      <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--space-8)' }}>
        <div style={{ textAlign: 'center' }}>
          <h1 style={{ fontSize: 'var(--text-2xl)', fontWeight: 700, marginBottom: 'var(--space-4)' }}>School not found</h1>
          <p style={{ color: 'var(--color-text-muted)' }}>The link <strong>{slug}</strong> doesn't match any school on Eduportal.</p>
        </div>
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100dvh', padding: 'var(--space-8)' }}>
      <h1 style={{ fontSize: 'var(--text-2xl)', fontWeight: 700 }}>{school?.name}</h1>
      <p style={{ color: 'var(--color-text-muted)', marginTop: 'var(--space-2)' }}>Status: {school?.status}</p>
    </div>
  )
}
