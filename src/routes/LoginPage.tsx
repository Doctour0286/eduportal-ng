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
 *
 * PRD Session 24 (Tier 6, Problem 6.2): rebuilt against the reference
 * app's `.att-login-card` pattern — a centered card (icon + title +
 * description header, labeled inputs with focus-ring styling,
 * full-width primary button, inline error below the form) rather than
 * the old full-bleed colored header + sticky tab bar. The school
 * identity banner is kept, but shrunk to a compact strip above the
 * card rather than a full colored section, since this app (unlike the
 * single-school reference) needs a neutral, theme-color-agnostic page
 * background that works for any admin-picked brand color. Dark mode
 * intentionally out of scope this session — no `theme_mode` concept
 * exists in the schema yet (§11 2026-07-08 Session 24 entry).
 *
 * Tab icons were originally built as scoped inline SVGs (Session 24) in
 * the same visual convention as the shared icon module. Session 25
 * absorbed them into that module as intended by this file's own prior
 * note: "staff" tab reuses the module's real `lock` icon (this file's
 * hand-authored badge/shackle shape turned out to be the same shape as
 * Lucide's actual "lock" glyph), "login code" tab reuses `key`, and the
 * password show/hide toggle reuses `eye`/`eye-off` — all sourced from
 * `src/components/icons/index.tsx` rather than duplicated locally.
 */

import { useState, type ReactNode } from 'react'
import { Icon } from '../components/icons'
import { loginWithEmail, loginWithCode } from '../services/authService'
import { deriveBrandScale } from '../services/themeService'

interface LoginPageProps {
  schoolId: string
  schoolName: string
  logoUrl?: string | null
  themeColor?: string | null
  /**
   * Set when App.tsx's subdomain/identity mismatch check (see App.tsx's
   * isWrongSchool) rejects an otherwise-successful login — the person's
   * credentials worked, but the account doesn't belong to the school this
   * subdomain resolved to, or the account's school couldn't be resolved
   * at all. Rendered as a banner above the form rather than replacing the
   * page, so the person can immediately retry with different credentials
   * for this school without a reload. Kept deliberately generic (no
   * naming of the person's actual correct school) — see MASTER_PROJECT_PLAN
   * §12 for the reasoning: revealing a second school's name to an
   * unverified caller is a small information leak, and a legitimate user
   * who mistyped the URL doesn't need reminding which school they meant
   * to log into.
   */
  topLevelError?: string | null
  /**
   * Owner request, 2026-07-11: a way back to the school's public homepage
   * without a reload. Optional and deliberately omitted on the wrong-school
   * banner branch (App.tsx's isWrongSchool/wrongSchoolBlock render) — that
   * case is a security-relevant redirect for someone with valid-elsewhere
   * credentials, not a first-time visitor, so sending them "back" to this
   * school's public content would be the same information-disclosure risk
   * PublicHomepage.tsx's own header comment already flags for that branch.
   * Undefined (not just a no-op) hides the button entirely rather than
   * rendering a dead one.
   */
  onBack?: () => void
}

type TabKey = 'staff' | 'code'

export function LoginPage({ schoolId, schoolName, logoUrl, themeColor, topLevelError, onBack }: LoginPageProps) {
  const [activeTab, setActiveTab] = useState<TabKey>('staff')

  // Session 23's real-contrast derivation, reused here for the logo
  // placeholder's text color only — the brand strip no longer paints
  // a full colored banner (see file header), so there's no large-area
  // contrast risk left to guard against, but the placeholder circle is
  // still a solid brand fill and needs the same guarantee.
  const scale = themeColor ? deriveBrandScale(themeColor) : null
  const placeholderText = scale ? scale.on : 'var(--color-brand-on, #ffffff)'

  return (
    <div className="login-shell">
      {onBack && (
        <button type="button" className="login-back-btn" onClick={onBack} aria-label="Back to school homepage">
          ← Back
        </button>
      )}

      {/* Compact brand identity strip */}
      <div className="login-brand-strip">
        {logoUrl ? (
          <img src={logoUrl} alt={schoolName} className="login-logo" />
        ) : (
          <div
            className="login-logo-placeholder"
            style={scale ? { background: scale[600], color: placeholderText } : undefined}
          >
            {schoolName.slice(0, 2).toUpperCase()}
          </div>
        )}
        <h1 className="login-school-name">{schoolName}</h1>
      </div>

      {topLevelError && (
        <div className="login-top-error" role="alert">
          <span className="login-top-error-icon" aria-hidden="true" style={{ color: 'var(--color-warning)' }}><Icon name="alert-triangle" /></span>
          <span>{topLevelError}</span>
        </div>
      )}

      {/* Card — icon + title + description header, tab switcher, form */}
      <div className="login-card">
        <div className="login-card-icon">
          {activeTab === 'staff' ? <Icon name="lock" size={28} /> : <Icon name="key" size={28} />}
        </div>
        <p className="login-card-title">
          {activeTab === 'staff' ? 'Staff sign in' : 'Login code'}
        </p>
        <p className="login-card-desc">
          {activeTab === 'staff'
            ? 'For teachers and administrators'
            : 'For parents and students'}
        </p>

        {/* Tab switcher */}
        <div className="login-tabs" role="tablist">
          <TabButton
            active={activeTab === 'staff'}
            onClick={() => setActiveTab('staff')}
            label="Staff"
            icon={<Icon name="lock" size={18} />}
          />
          <TabButton
            active={activeTab === 'code'}
            onClick={() => setActiveTab('code')}
            label="Login code"
            icon={<Icon name="key" size={18} />}
          />
        </div>

        {/* Login forms */}
        <div className="login-form-area">
          {activeTab === 'staff' && <StaffLoginForm />}
          {activeTab === 'code'  && <CodeLoginForm schoolId={schoolId} />}
        </div>
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
  icon: ReactNode
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
  const [email,       setEmail]       = useState('')
  const [password,    setPassword]    = useState('')
  const [error,       setError]       = useState<string | null>(null)
  const [loading,     setLoading]     = useState(false)
  // Password-visibility toggle — owner-requested, Session 24. Same simple
  // pattern already used elsewhere in the app (TeacherDashboard.tsx's
  // password-change form has a shared show/hide toggle across its three
  // password fields); this form has only one password field, so it's a
  // local toggle rather than a shared-across-fields one, but the same
  // visual/interaction convention (eye / eye-off icon inside the field).
  const [showPassword, setShowPassword] = useState(false)

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
        <div className="form-input-wrap">
          <input
            className="form-input form-input--with-toggle"
            type={showPassword ? 'text' : 'password'}
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            disabled={loading}
            onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
          />
          <button
            type="button"
            className="form-input-toggle"
            onClick={() => setShowPassword(v => !v)}
            disabled={loading}
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            aria-pressed={showPassword}
            tabIndex={-1}
          >
            {showPassword ? <Icon name="eye-off" size={18} /> : <Icon name="eye" size={18} />}
          </button>
        </div>
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
