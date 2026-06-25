/**
 * LoginPage.tsx
 * Login screen supporting three auth methods:
 *   - Staff: email + password
 *   - Guardian: phone + OTP
 *   - Anyone: login code (6-char alphanumeric issued by school admin)
 *
 * Mobile-first. All three flows handle errors and loading states.
 * Business logic lives in authService.ts — this file is UI only.
 */

import { useState } from 'react'
import {
  loginWithEmail,
  sendPhoneOtp,
  verifyPhoneOtp,
  loginWithCode,
} from '../services/authService'

interface LoginPageProps {
  schoolId: string
  schoolName: string
  logoUrl?: string | null
  themeColor?: string | null
}

type TabKey = 'staff' | 'guardian' | 'code'

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
        <TabButton active={activeTab === 'staff'} onClick={() => setActiveTab('staff')} label="Staff" icon="👤" />
        <TabButton active={activeTab === 'guardian'} onClick={() => setActiveTab('guardian')} label="Parent" icon="👨‍👩‍👧" />
        <TabButton active={activeTab === 'code'} onClick={() => setActiveTab('code')} label="Code" icon="🔑" />
      </div>

      {/* Login forms */}
      <div className="login-form-area">
        {activeTab === 'staff' && <StaffLoginForm />}
        {activeTab === 'guardian' && <GuardianLoginForm />}
        {activeTab === 'code' && <CodeLoginForm schoolId={schoolId} />}
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
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

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

// ─── Guardian: phone OTP ──────────────────────────────────────────────────

function GuardianLoginForm() {
  const [phone, setPhone] = useState('')
  const [otp, setOtp] = useState('')
  const [step, setStep] = useState<'phone' | 'otp'>('phone')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSendOtp() {
    if (!phone.trim()) {
      setError('Enter your phone number')
      return
    }
    setError(null)
    setLoading(true)
    const result = await sendPhoneOtp(phone.trim())
    setLoading(false)
    if (!result.ok) {
      setError(result.error ?? 'Could not send code — check the number and try again')
      return
    }
    setStep('otp')
  }

  async function handleVerifyOtp() {
    if (otp.trim().length < 6) {
      setError('Enter the 6-digit code from your SMS')
      return
    }
    setError(null)
    setLoading(true)
    const result = await verifyPhoneOtp(phone.trim(), otp.trim())
    setLoading(false)
    if (!result.ok) {
      setError(result.error ?? 'Wrong code — check your SMS and try again')
    }
  }

  if (step === 'otp') {
    return (
      <div className="login-form">
        <p className="login-form-hint">
          A 6-digit code was sent to <strong>{phone}</strong>.{' '}
          <button className="link-btn" onClick={() => { setStep('phone'); setError(null) }}>
            Change number
          </button>
        </p>

        <label className="form-label">
          6-digit code
          <input
            className="form-input form-input--otp"
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="one-time-code"
            maxLength={6}
            value={otp}
            onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="123456"
            disabled={loading}
            autoFocus
          />
        </label>

        {error && <p className="form-error" role="alert">{error}</p>}

        <button
          className="btn btn--primary btn--full"
          onClick={handleVerifyOtp}
          disabled={loading}
        >
          {loading ? 'Verifying…' : 'Verify and sign in'}
        </button>

        <button
          className="btn btn--ghost btn--full"
          onClick={handleSendOtp}
          disabled={loading}
        >
          Resend code
        </button>
      </div>
    )
  }

  return (
    <div className="login-form">
      <p className="login-form-hint">
        For parents and guardians — we'll send a code to your phone number.
      </p>

      <label className="form-label">
        Phone number
        <input
          className="form-input"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="0812 345 6789"
          disabled={loading}
          onKeyDown={(e) => e.key === 'Enter' && handleSendOtp()}
        />
      </label>

      {error && <p className="form-error" role="alert">{error}</p>}

      <button
        className="btn btn--primary btn--full"
        onClick={handleSendOtp}
        disabled={loading}
      >
        {loading ? 'Sending code…' : 'Send code'}
      </button>
    </div>
  )
}

// ─── Login code ───────────────────────────────────────────────────────────

function CodeLoginForm({ schoolId }: { schoolId: string }) {
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
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
        For students or parents with a login code — enter the code given to you by the school.
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
          placeholder="e.g. XK7R9"
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
