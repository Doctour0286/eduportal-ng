/**
 * LoginPage.tsx
 * Login screen supporting two auth methods:
 *   - Staff:   email + password
 *   - Anyone:  login code (issued by school admin — used by guardians and students)
 *
 * Phone OTP removed — requires Twilio configuration not yet active.
 * Re-add the Guardian tab and GuardianLoginForm when Twilio is connected.
 *
 * Mobile-first. Both flows handle errors and loading states.
 * Business logic lives in authService.ts — this file is UI only.
 */

import { useState } from 'react'
import { loginWithEmail, loginWithCode } from '../services/authService'

interface LoginPageProps {
  schoolId: string
  schoolName: string
  logoUrl?: string | null
  themeColor?: string | null
}

type TabKey = 'staff' | 'code'

export function LoginPage({ schoolId, schoolName, logoUrl, themeColor }: LoginPageProps) {
  const [activeTab, setActiveTab] = useState<TabKey>('staff')
  const accent = themeColor || 'var(--color-brand-600)'

  return (
    <div className="login-shell">
      {/* School header */}
      <div className="login-header" style={{ background: accent }}>
        {logoUrl ? (
          <img src={logoUrl} alt={schoolName} className="login-logo" />
        ) : (
          <div className="login-logo-placeholder">{schoolName.slice(0, 2).toUpperCase()}</div>
        )}
        <h1 className="login-school-name">{schoolName}</h1>
        <p className="login-tagline">Sign in to continue</p>
      </div>

      {/* Tab switcher */}
      <div className="login-tabs" role="tablist">
        <TabButton
          active={activeTab === 'staff'}
          onClick={() => setActiveTab('staff')}
          label="Staff"
          icon="👤"
        />
        <TabButton
          active={activeTab === 'code'}
          onClick={() => setActiveTab('code')}
          label="Login code"
          icon="🔑"
        />
      </div>

      {/* Login forms */}
      <div className="login-form-area">
        {activeTab === 'staff' && <StaffLoginForm />}
        {activeTab === 'code'  && <CodeLoginForm schoolId={schoolId} />}
      </div>
    </div>
  )
}

// ─── Tab button ───────────────────────────────────────────────────────────

function TabButton({
  active,
  onClick,
  label,
  icon,
}: {
  active: boolean
  onClick: () => void
  label: string
  icon: string
}) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`login-tab ${active ? 'login-tab--active' : ''}`}
    >
      <span className="login-tab-icon">{icon}</span>
      <span>{label}</span>
    </button>
  )
}

// ─── Staff: email + password ──────────────────────────────────────────────

function StaffLoginForm() {
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [error,    setError]    = useState<string | null>(null)
  const [loading,  setLoading]  = useState(false)

  async function handleSubmit() {
    if (!email.trim() || !password.trim()) {
      setError('Enter your email and password')
      return
    }
    setError(null)
    setLoading(true)
    const result = await loginWithEmail(email.trim(), password)
    setLoading(false)
    if (!result.ok) {
      setError(result.error ?? 'Could not sign in — check your email and password')
    }
    // On success: Supabase auth state change fires → authStore updates → App re-renders
  }

  return (
    <div className="login-form">
      <p className="login-form-hint">For school staff — use your work email and password.</p>

      <label className="form-label">
        Email address
        <input
          className="form-input"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@school.edu.ng"
          disabled={loading}
        />
      </label>

      <label className="form-label">
        Password
        <input
          className="form-input"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          disabled={loading}
          onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
        />
      </label>

      {error && <p className="form-error" role="alert">{error}</p>}

      <button
        className="btn btn--primary btn--full"
        onClick={handleSubmit}
        disabled={loading}
      >
        {loading ? 'Signing in…' : 'Sign in'}
      </button>
    </div>
  )
}

// ─── Login code (guardians + students) ───────────────────────────────────

function CodeLoginForm({ schoolId }: { schoolId: string }) {
  const [code,    setCode]    = useState('')
  const [error,   setError]   = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit() {
    const trimmed = code.trim().toUpperCase()
    if (trimmed.length < 4) {
      setError('Enter the login code given to you by the school')
      return
    }
    setError(null)
    setLoading(true)
    const result = await loginWithCode(schoolId, trimmed)
    setLoading(false)
    if (!result.ok) {
      setError(result.error ?? 'Invalid code — ask the school admin for a new one')
    }
  }

  return (
    <div className="login-form">
      <p className="login-form-hint">
        For parents and students — enter the login code given to you by the school.
      </p>

      <label className="form-label">
        Login code
        <input
          className="form-input form-input--code"
          type="text"
          autoCapitalize="characters"
          autoComplete="off"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="e.g. ABCD123"
          disabled={loading}
          onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
          maxLength={12}
        />
      </label>

      {error && <p className="form-error" role="alert">{error}</p>}

      <button
        className="btn btn--primary btn--full"
        onClick={handleSubmit}
        disabled={loading}
      >
        {loading ? 'Signing in…' : 'Sign in with code'}
      </button>
    </div>
  )
}
