/**
 * AccountPreferencesScreen.tsx
 * Session 10b — net-new self-service "my account" screen.
 *
 * Named "Account preferences," not "Change password," on purpose: this is
 * the future home for every personal (not school-wide) setting — theme,
 * language, font size, alarm sound, and anything else that belongs to the
 * signed-in person rather than to SettingsModule.tsx's school configuration.
 * Password change is the first real section built; the rest are placeholder
 * sections below it, using the exact same `acctprefs-section` shape so a
 * future session adds a section, not a new screen/route/nav entry.
 *
 * Reached exclusively via the account popover (App.tsx, "Account
 * preferences" item, between Language and Audit log — that popover item's
 * own label is a separate, smaller thing: a disabled "Coming soon" row
 * surfacing the *current* language value at a glance; the live language
 * *control* lives inside this screen's own Language section once built,
 * same relationship "Settings" in the More sheet has to the screens inside
 * it). Available to every signed-in actor type — staff, guardian, student,
 * platform_admin — everything on this screen is self-service, so it takes
 * no isAdmin/permission prop at all, and no props at all: each section
 * resolves whatever it needs (e.g. supabase.auth.updateUser() always acts
 * on the current session's own user).
 *
 * The password section is also the mechanism that makes the default-password
 * "check-on-read" expiry design (locked in the 10b migration) actually fire:
 * once a staff member changes their password here, any subsequent real
 * sign-in with the new password naturally supersedes the temp one — HR's
 * read-side expiry check (staff detail view, built against
 * `staff_default_password_view`) is what actually stops showing/honoring
 * the old default_password value. This section's only job is: let the user
 * set a new password via Supabase Auth directly. It does not, and should
 * not, touch `staff.default_password` — that column is write-only from the
 * two edge functions (create-staff-account, regenerate-staff-password), by
 * design (see migration_session_10b.sql).
 *
 * Collapsed-by-default + current-password re-auth — added Session 19,
 * owner-requested hardening. Two separate problems, one shape:
 * (1) The form used to render open on page load, so anyone at an unlocked,
 *     unattended device could change the account's password with zero
 *     friction — a real gap, not just visual noise. Now the section starts
 *     collapsed behind a "Change password" click; nothing is typed into
 *     until that's an explicit action.
 * (2) Even once opened, the old form asked only for the *new* password —
 *     never confirmed the person typing is the actual account owner and
 *     not just whoever's holding the unlocked session. Fixed by adding a
 *     required "Current password" field, verified via
 *     `supabase.auth.signInWithPassword()` against the signed-in user's own
 *     email *before* `updateUser()` runs — same re-auth primitive already
 *     used by the payslip-unhide flow below, for the same reason: it
 *     revalidates credentials without disturbing the existing session, so
 *     a wrong current-password attempt just shows an error rather than
 *     signing anyone out.
 *
 * Payslip visibility section — added Session 18, following on from
 * TeacherDashboard.tsx's Session 17 "My Payslip" card. Design locked with
 * the owner during that session: hiding the card is free (no re-auth,
 * that's the safe direction), but showing it again after hiding requires
 * re-entering the current password first — a lightweight speed bump on the
 * one direction that re-exposes payroll data, not a hard security boundary
 * (the data was never inaccessible; the teacher chose to hide their own
 * card and now has to mean it a second time to bring it back). Verified via
 * supabase.auth.signInWithPassword() against the signed-in user's own
 * email, which re-validates credentials without disturbing the existing
 * session (unlike updateUser, it doesn't require an already-authenticated
 * mutation and won't throw the user out if it fails).
 *
 * Self-resolves staffId from useAuthStore rather than taking a prop — same
 * "no props at all" shape as the rest of this screen. Only renders at all
 * for actorType === 'staff', and only shows a "show it again" control once
 * the personal hidden flag is actually true AND the school-wide switch is
 * still on (if admin has since turned the whole feature off, there's
 * nothing to offer back — the card wouldn't render on the dashboard
 * regardless of this flag, so surfacing the control here would be
 * misleading).
 */

import { useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { useAuthStore } from '../stores/authStore'
import { loadPayrollVisibilitySettings, setMyPayslipCardHidden } from '../services/hrService'

const MIN_PASSWORD_LENGTH = 8

// ─── Shared password input (with show/hide toggle) ─────────────────────────
// Every password field on this screen (current, new, confirm, and the
// payslip-unhide confirmation) routes through this so the toggle behavior
// and markup stay in exactly one place.
//
// Visibility is a *group* concept, not a per-field one: toggling the eye
// icon on any field in the password-change form should reveal/hide all
// three fields together (current/new/confirm), since a person checking
// what they typed almost always means "all of it," not one field at a
// time. `visible`/`onToggleVisible` are passed down from the parent
// section so all fields in that form share one boolean. When omitted
// (the payslip-unhide field, which is the only password field in its own
// section), the field falls back to its own local state — there's nothing
// else in that form to stay in sync with.

function PasswordInput({
  label,
  value,
  onChange,
  autoComplete,
  minLength,
  required,
  visible: visibleProp,
  onToggleVisible,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  autoComplete: 'current-password' | 'new-password'
  minLength?: number
  required?: boolean
  visible?: boolean
  onToggleVisible?: () => void
}) {
  const [localVisible, setLocalVisible] = useState(false)
  const visible = visibleProp ?? localVisible
  const toggleVisible = onToggleVisible ?? (() => setLocalVisible((v) => !v))

  return (
    <label className="acctprefs-field">
      <span className="acctprefs-label">{label}</span>
      <div className="acctprefs-password-wrap">
        <input
          className="acctprefs-input acctprefs-input--password"
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          minLength={minLength}
          required={required}
        />
        <button
          className="acctprefs-password-toggle"
          type="button"
          onClick={toggleVisible}
          aria-label={visible ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          aria-pressed={visible}
        >
          {visible ? '🙈' : '👁️'}
        </button>
      </div>
    </label>
  )
}

export default function AccountPreferencesScreen() {
  const actorType = useAuthStore((s) => s.actorType)

  return (
    <div className="acctprefs-screen">
      <h1 className="acctprefs-title">Account preferences</h1>
      <p className="acctprefs-intro">
        Settings for your own account. These only affect you, not the rest of the school.
      </p>

      <PasswordSection />
      {actorType === 'staff' && <PayslipVisibilitySection />}
      <PlaceholderSection icon="🎨" label="Theme" note="Light/dark mode — coming soon" />
      <PlaceholderSection icon="🌐" label="Language" note="Coming soon" />
      <PlaceholderSection icon="🔠" label="Font size" note="Coming soon" />
      <PlaceholderSection icon="⏰" label="Alarm" note="Coming soon" />
    </div>
  )
}

// ─── Password section ───────────────────────────────────────────────────────

function PasswordSection() {
  const userEmail = useAuthStore((s) => s.user?.email ?? null)

  const [open, setOpen] = useState(false)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordsVisible, setPasswordsVisible] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  function resetFields() {
    setCurrentPassword('')
    setNewPassword('')
    setConfirmPassword('')
    setPasswordsVisible(false)
    setError(null)
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)

    if (!userEmail) {
      setError('Could not confirm your account. Please refresh and try again.')
      return
    }
    if (!currentPassword) {
      setError('Enter your current password to confirm it\u2019s you.')
      return
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setError(`New password must be at least ${MIN_PASSWORD_LENGTH} characters.`)
      return
    }
    if (newPassword !== confirmPassword) {
      setError('New passwords do not match.')
      return
    }

    setSubmitting(true)

    // Re-auth first: confirms the person typing is the actual account
    // owner, not just whoever's holding an unlocked session. Same primitive
    // as the payslip-unhide flow below — revalidates without disturbing the
    // existing session, so a wrong current-password guess just errors out.
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: userEmail,
      password: currentPassword,
    })

    if (signInError) {
      setSubmitting(false)
      setError('Current password is incorrect.')
      return
    }

    const { error: updateError } = await supabase.auth.updateUser({
      password: newPassword,
    })
    setSubmitting(false)

    if (updateError) {
      setError(updateError.message || 'Could not change password. Please try again.')
      return
    }

    setSuccess(true)
    setOpen(false)
    resetFields()
  }

  return (
    <section className="acctprefs-section">
      <button
        className="acctprefs-section-toggle"
        type="button"
        onClick={() => {
          if (open) resetFields()
          setOpen((v) => !v)
          setSuccess(false)
        }}
        aria-expanded={open}
      >
        <h2 className="acctprefs-section-title">
          <span className="acctprefs-section-icon">🔑</span>
          Password
        </h2>
        <span className="acctprefs-section-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>

      {success && !open && (
        <div className="acctprefs-success">
          <span className="acctprefs-success-icon">✅</span>
          <p className="acctprefs-success-text">Password changed. Use it next time you sign in.</p>
        </div>
      )}

      {!open && !success && (
        <p className="acctprefs-placeholder-note">Click "Password" above to change it.</p>
      )}

      {open && (
        <form className="acctprefs-form" onSubmit={handleSubmit}>
          <PasswordInput
            label="Current password"
            value={currentPassword}
            onChange={setCurrentPassword}
            autoComplete="current-password"
            required
            visible={passwordsVisible}
            onToggleVisible={() => setPasswordsVisible((v) => !v)}
          />
          <PasswordInput
            label="New password"
            value={newPassword}
            onChange={setNewPassword}
            autoComplete="new-password"
            minLength={MIN_PASSWORD_LENGTH}
            required
            visible={passwordsVisible}
            onToggleVisible={() => setPasswordsVisible((v) => !v)}
          />
          <PasswordInput
            label="Confirm new password"
            value={confirmPassword}
            onChange={setConfirmPassword}
            autoComplete="new-password"
            minLength={MIN_PASSWORD_LENGTH}
            required
            visible={passwordsVisible}
            onToggleVisible={() => setPasswordsVisible((v) => !v)}
          />
          {error && <p className="acctprefs-error" role="alert">{error}</p>}
          <div className="acctprefs-form-actions">
            <button
              className="acctprefs-save-btn"
              type="submit"
              disabled={submitting}
            >
              {submitting ? 'Changing…' : 'Change password'}
            </button>
            <button
              className="acctprefs-link-btn"
              type="button"
              onClick={() => { setOpen(false); resetFields() }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  )
}

// ─── Payslip visibility section ─────────────────────────────────────────────
// Only mounted for actorType === 'staff' (see the parent component). Loads
// both flags on mount via hrService's loadPayrollVisibilitySettings — same
// one-round-trip pairing TeacherDashboard.tsx itself uses, since a decision
// here also depends on both. Three render states below cover every
// combination of (schoolEnabled, selfHidden):
//   schoolEnabled=false             → nothing to do here, feature is off
//   schoolEnabled=true, hidden=false → nothing to do here, card already shows
//   schoolEnabled=true, hidden=true  → the actual "show it again" flow
//
// Session 19 — this section is only ever visible at all in the third case
// above, so unlike Password it doesn't need an "empty, click to open"
// placeholder state; but the password *field* inside it still shouldn't sit
// there open before the user's committed to doing anything, same reasoning
// as Password: collapsed behind a click, so the confirm form isn't rendered
// (and nothing's typed into) until "Payslip card" is actually clicked.

function PayslipVisibilitySection() {
  const staffId = useAuthStore((s) => s.actorRecordId)
  const schoolId = useAuthStore((s) => s.schoolId)
  const userEmail = useAuthStore((s) => s.user?.email ?? null)

  const [loading, setLoading] = useState(true)
  const [schoolEnabled, setSchoolEnabled] = useState(true)
  const [selfHidden, setSelfHidden] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  function resetForm() {
    setPassword('')
    setFormError(null)
  }

  useEffect(() => {
    let cancelled = false
    async function load() {
      if (!staffId || !schoolId) return
      setLoading(true)
      const res = await loadPayrollVisibilitySettings(schoolId, staffId)
      if (!cancelled) {
        if (res.ok) {
          setSchoolEnabled(res.data.schoolEnabled)
          setSelfHidden(res.data.selfHidden)
        } else {
          setLoadError(res.error)
        }
        setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [staffId, schoolId])

  async function handleShowAgain(e: FormEvent) {
    e.preventDefault()
    setFormError(null)

    if (!staffId || !userEmail) {
      setFormError('Could not confirm your account. Please refresh and try again.')
      return
    }
    if (!password) {
      setFormError('Enter your password to confirm.')
      return
    }

    setSubmitting(true)

    // Re-validates the current password without disturbing the existing
    // session — this is a confirmation step, not a fresh sign-in, so a
    // wrong password here should just show an error, never sign anyone out.
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: userEmail,
      password,
    })

    if (signInError) {
      setSubmitting(false)
      setFormError('Incorrect password. Please try again.')
      return
    }

    const res = await setMyPayslipCardHidden(staffId, false)
    setSubmitting(false)

    if (!res.ok) {
      setFormError(res.error)
      return
    }

    setSelfHidden(false)
    setOpen(false)
    resetForm()
  }

  // Nothing to render while resolving, or if this teacher never hid the
  // card, or if admin has since turned the feature off school-wide.
  if (loading || loadError || !schoolEnabled || !selfHidden) {
    return null
  }

  return (
    <section className="acctprefs-section">
      <button
        className="acctprefs-section-toggle"
        type="button"
        onClick={() => {
          if (open) resetForm()
          setOpen((v) => !v)
        }}
        aria-expanded={open}
      >
        <h2 className="acctprefs-section-title">
          <span className="acctprefs-section-icon">💰</span>
          Payslip card
        </h2>
        <span className="acctprefs-section-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>

      {!open && (
        <p className="acctprefs-placeholder-note">
          You hid the "My Payslip" card from your dashboard. Click here to show it again.
        </p>
      )}

      {open && (
        <>
          <p className="acctprefs-placeholder-note">
            Enter your password to show the "My Payslip" card again.
          </p>
          <form className="acctprefs-form" onSubmit={handleShowAgain}>
            <PasswordInput
              label="Password"
              value={password}
              onChange={setPassword}
              autoComplete="current-password"
              required
            />
            {formError && <p className="acctprefs-error" role="alert">{formError}</p>}
            <div className="acctprefs-form-actions">
              <button
                className="acctprefs-save-btn"
                type="submit"
                disabled={submitting}
              >
                {submitting ? 'Confirming…' : 'Show payslip card again'}
              </button>
              <button
                className="acctprefs-link-btn"
                type="button"
                onClick={() => { setOpen(false); resetForm() }}
              >
                Cancel
              </button>
            </div>
          </form>
        </>
      )}
    </section>
  )
}

// ─── Placeholder sections ───────────────────────────────────────────────────
// Same section shell as PasswordSection (acctprefs-section) so replacing one
// of these with a real control later is a body swap, not a layout change.

function PlaceholderSection({ icon, label, note }: { icon: string; label: string; note: string }) {
  return (
    <section className="acctprefs-section acctprefs-section--placeholder" aria-disabled="true">
      <h2 className="acctprefs-section-title">
        <span className="acctprefs-section-icon">{icon}</span>
        {label}
      </h2>
      <p className="acctprefs-placeholder-note">{note}</p>
    </section>
  )
}
