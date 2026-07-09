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

import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { supabase } from '../lib/supabase'
import { useAuthStore } from '../stores/authStore'
import { loadPayrollVisibilitySettings, setMyPayslipCardHidden } from '../services/hrService'
import {
  loadStaffPreferences,
  saveStaffPreferences,
  DEFAULT_STAFF_PREFERENCES,
  type StaffPreferences,
  type SoundTypePref,
  type AlertScopePref,
} from '../services/settingsService'
import { playAlarmTone, requestNotificationPermission, notificationsSupported, getNotificationPermission } from '../services/alarmService'
import type { ThemeMode } from '../services/themeService'
import { Icon } from '../components/icons'

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
          {visible ? <Icon name="eye-off" size={18} /> : <Icon name="eye" size={18} />}
        </button>
      </div>
    </label>
  )
}

export default function AccountPreferencesScreen({
  themeMode,
  setThemeMode,
}: {
  /** Session/dark-mode (§12, 2026-07-09) — resolved and persisted at
   *  App.tsx's level (loadThemePreference/saveThemePreference against
   *  app_identity_preferences), not self-resolved here the way
   *  AlarmSettingsSection resolves staffId, because dark mode applies
   *  app-wide (data-theme on <html>, brand re-derivation) the instant it
   *  changes — that has to happen in the one place already coordinating
   *  both of those (App.tsx), not independently in a leaf component that
   *  only renders when this screen happens to be open. This is the one
   *  section on this screen that takes props rather than resolving
   *  everything itself; every other section's "no props" shape still
   *  holds for settings that are genuinely local to this screen. */
  themeMode: ThemeMode
  setThemeMode: (mode: ThemeMode) => Promise<{ error: string | null }>
}) {
  const actorType = useAuthStore((s) => s.actorType)

  return (
    <div className="acctprefs-screen">
      <h1 className="acctprefs-title">Account preferences</h1>
      <p className="acctprefs-intro">
        Settings for your own account. These only affect you, not the rest of the school.
      </p>

      <PasswordSection />
      {actorType === 'staff' && <PayslipVisibilitySection />}
      <ThemeSection themeMode={themeMode} setThemeMode={setThemeMode} />
      <PlaceholderSection icon={<Icon name="globe" size={18} />} label="Language" note="Coming soon" />
      <PlaceholderSection icon={<Icon name="font-size" size={18} />} label="Font size" note="Coming soon" />
      {actorType === 'staff' && <AlarmSettingsSection />}
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
          <span className="acctprefs-section-icon"><Icon name="key" size={18} /></span>
          Password
        </h2>
        <span className="acctprefs-section-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>

      {success && !open && (
        <div className="acctprefs-success">
          <span className="acctprefs-success-icon"><Icon name="circle-check" size={18} style={{ color: 'var(--color-success, #16a34a)' }} /></span>
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
          <span className="acctprefs-section-icon"><Icon name="wallet" size={18} /></span>
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

// ─── Theme section ──────────────────────────────────────────────────────────
// §12 (2026-07-09) — dark mode, decided in scope for every actor type, so
// unlike AlarmSettingsSection this doesn't self-resolve via staffId (which
// is null for guardians/students). themeMode/setThemeMode are passed down
// from App.tsx, which is already the one place coordinating data-theme on
// <html> and the brand-scale re-derivation that also has to happen the
// instant this changes — duplicating that coordination here would mean
// two places independently deciding "what theme is it," which is exactly
// the kind of disagreement Session 23's original --color-brand-600 bug
// was caused by (see themeService.ts's header comment).
//
// No debounced autosave here (contrast AlarmSettingsSection's 500ms
// timer) — there's only one field, a toggle, not several independently-
// editable ones a person might adjust in quick succession, so saving
// immediately on click is simpler and just as correct.
function ThemeSection({
  themeMode,
  setThemeMode,
}: {
  themeMode: ThemeMode
  setThemeMode: (mode: ThemeMode) => Promise<{ error: string | null }>
}) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const isDark = themeMode === 'dark'

  async function handleToggle() {
    setSaving(true)
    setSaveError(null)
    const nextMode: ThemeMode = isDark ? 'light' : 'dark'
    const res = await setThemeMode(nextMode)
    setSaving(false)
    if (res.error) setSaveError(res.error)
  }

  return (
    <section className="acctprefs-section">
      <button
        className="acctprefs-section-toggle"
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <h2 className="acctprefs-section-title">
          <span className="acctprefs-section-icon"><Icon name="palette" size={18} /></span>
          Theme
        </h2>
        <span className="acctprefs-section-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>

      {!open && (
        <p className="acctprefs-placeholder-note">{isDark ? 'Dark' : 'Light'}</p>
      )}

      {open && (
        <div className="acctprefs-form">
          {saveError && <p className="acctprefs-error" role="alert">{saveError}</p>}

          <label className="acctprefs-row">
            <span className="acctprefs-row-label">Dark mode</span>
            <button
              type="button"
              role="switch"
              aria-checked={isDark}
              disabled={saving}
              className={`acctprefs-toggle-track${isDark ? ' acctprefs-toggle-track--on' : ''}`}
              onClick={handleToggle}
            >
              <span className="acctprefs-toggle-thumb" />
            </button>
          </label>
        </div>
      )}
    </section>
  )
}

// ─── Alarm settings section ──────────────────────────────────────────────────
// Session 28 (PRD Problem 6.6). Same self-resolving shape as
// PayslipVisibilitySection above: no props, staffId/schoolId pulled from
// useAuthStore, only mounted for actorType === 'staff' (see parent
// component) since alert_scope's 'mine' vs 'all' distinction — and indeed
// the whole staff_preferences row — is meaningless for guardians/students/
// platform_admins (migration_session_28.sql, alert_scope column comment).
//
// Unlike Password/Payslip, this section has no re-auth step — alarm volume
// and sound type are not sensitive data, so there's no "confirm it's you"
// friction here, matching the migration's own choice not to audit-log this
// table either (both decisions rest on the same "low-stakes personal
// preference" reasoning).
//
// Starts collapsed like every other section on this screen (Session 19
// precedent), but for a different reason here: not security, just so the
// screen doesn't front-load nine controls nobody asked to see yet. Loads
// current prefs on mount regardless of open/closed state (cheap single
// read, and needed so the collapsed summary line can say what's on file).
//
// "Test sound" calls playAlarmTone directly (not playAlarmToneRepeated) —
// per alarmService.ts's own doc comment, a test always plays once
// regardless of the saved repeat count, since the point of a test is "what
// does this sound like," not "what will actually happen at period end."
// The button itself is the real user gesture alarmService.ts requires
// before AudioContext will play at all — this is the first place in the
// app a teacher can ever hear one of these tones.

const SOUND_TYPE_OPTIONS: { value: SoundTypePref; label: string }[] = [
  { value: 'chime', label: 'Chime' },
  { value: 'bell', label: 'Bell' },
  { value: 'buzzer', label: 'Buzzer' },
  { value: 'digital', label: 'Digital' },
]

const ALERT_SCOPE_OPTIONS: { value: AlertScopePref; label: string }[] = [
  { value: 'mine', label: 'My periods only' },
  { value: 'all', label: 'Every period, school-wide' },
]

function AlarmSettingsSection() {
  const staffId = useAuthStore((s) => s.actorRecordId)
  const schoolId = useAuthStore((s) => s.schoolId)

  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [prefs, setPrefs] = useState<StaffPreferences>(DEFAULT_STAFF_PREFERENCES)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  // Read-only reflection of the browser's own Notification permission —
  // not something this component can set directly (only requestPermission()
  // inside a real click can), just displayed so a teacher who's toggled
  // browser_notif on but was denied (or hasn't decided) sees why nothing
  // shows up, instead of the setting silently doing nothing forever.
  const [notifPermission, setNotifPermission] = useState<NotificationPermission | null>(
    () => getNotificationPermission(),
  )

  useEffect(() => {
    let cancelled = false
    async function load() {
      if (!staffId) return
      setLoading(true)
      const res = await loadStaffPreferences(staffId)
      if (!cancelled) {
        setPrefs(res.data)
        setLoadError(res.error)
        setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [staffId])

  // Debounced autosave — every toggle/select/slider change updates local
  // state immediately (so the UI feels instant) and schedules a save
  // shortly after; rapid changes (e.g. dragging the volume slider) collapse
  // into a single write rather than one per pixel of drag.
  useEffect(() => {
    if (loading || !staffId || !schoolId) return
    setSaving(true)
    setSaveError(null)
    const timer = setTimeout(async () => {
      const res = await saveStaffPreferences(schoolId, staffId, prefs)
      setSaving(false)
      if (res.error) {
        setSaveError(res.error)
      } else {
        setSavedAt(Date.now())
      }
    }, 500)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs, staffId, schoolId])

  function update<K extends keyof StaffPreferences>(key: K, value: StaffPreferences[K]) {
    setPrefs((p) => ({ ...p, [key]: value }))
  }

  // The click that turns this ON is itself the real user gesture the
  // Notification API requires to prompt at all — deferring the request to
  // whenever the first alarm actually fires (inside LivePeriodWidget's tick
  // loop) would not be a gesture, and the browser would just refuse to ask.
  // Turning it off never needs a permission request, only the preference
  // write, so only the "turning on" branch calls requestNotificationPermission.
  async function handleBrowserNotifToggle() {
    const turningOn = !prefs.browser_notif
    update('browser_notif', turningOn)
    if (turningOn) {
      const result = await requestNotificationPermission()
      setNotifPermission(result)
    }
  }

  if (loading) {
    return null
  }

  return (
    <section className="acctprefs-section">
      <button
        className="acctprefs-section-toggle"
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <h2 className="acctprefs-section-title">
          <span className="acctprefs-section-icon"><Icon name="alarm-clock" size={18} /></span>
          Alarm
        </h2>
        <span className="acctprefs-section-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>

      {!open && (
        <p className="acctprefs-placeholder-note">
          {prefs.sound_enabled
            ? `${SOUND_TYPE_OPTIONS.find(o => o.value === prefs.sound_type)?.label ?? prefs.sound_type} sound, ${prefs.alert_scope === 'mine' ? 'your periods only' : 'every period'}.`
            : 'Sound is off.'}
        </p>
      )}

      {open && (
        <div className="acctprefs-form">
          {loadError && <p className="acctprefs-error" role="alert">{loadError}</p>}

          <label className="acctprefs-row">
            <span className="acctprefs-row-label">Play a sound at period end</span>
            <button
              type="button"
              role="switch"
              aria-checked={prefs.sound_enabled}
              className={`acctprefs-toggle-track${prefs.sound_enabled ? ' acctprefs-toggle-track--on' : ''}`}
              onClick={() => update('sound_enabled', !prefs.sound_enabled)}
            >
              <span className="acctprefs-toggle-thumb" />
            </button>
          </label>

          <label className="acctprefs-field">
            <span className="acctprefs-label">Sound</span>
            <select
              className="acctprefs-select"
              value={prefs.sound_type}
              disabled={!prefs.sound_enabled}
              onChange={(e) => update('sound_type', e.target.value as SoundTypePref)}
            >
              {SOUND_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>

          <div className="acctprefs-slider-row">
            <span className="acctprefs-label">Volume — {Math.round(prefs.sound_vol * 100)}%</span>
            <input
              type="range"
              className="acctprefs-slider"
              min={0}
              max={1}
              step={0.05}
              value={prefs.sound_vol}
              disabled={!prefs.sound_enabled}
              onChange={(e) => update('sound_vol', parseFloat(e.target.value))}
            />
          </div>

          <label className="acctprefs-field">
            <span className="acctprefs-label">Repeat</span>
            <select
              className="acctprefs-select"
              value={prefs.sound_repeat}
              disabled={!prefs.sound_enabled}
              onChange={(e) => update('sound_repeat', parseInt(e.target.value, 10))}
            >
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>{n} time{n > 1 ? 's' : ''}</option>
              ))}
            </select>
          </label>

          <button
            type="button"
            className="acctprefs-test-btn"
            disabled={!prefs.sound_enabled}
            onClick={() => playAlarmTone(prefs.sound_type, 'end', prefs.sound_vol)}
          >
            Test sound
          </button>

          <hr className="acctprefs-divider" />

          <label className="acctprefs-row">
            <span className="acctprefs-row-label">
              Early warning
              <span className="acctprefs-row-sublabel">A shorter heads-up sound before the period actually ends</span>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={prefs.early_warning}
              className={`acctprefs-toggle-track${prefs.early_warning ? ' acctprefs-toggle-track--on' : ''}`}
              disabled={!prefs.sound_enabled}
              onClick={() => update('early_warning', !prefs.early_warning)}
            >
              <span className="acctprefs-toggle-thumb" />
            </button>
          </label>

          {prefs.early_warning && (
            <label className="acctprefs-field">
              <span className="acctprefs-label">Warn me</span>
              <select
                className="acctprefs-select"
                value={prefs.warn_lead_min}
                disabled={!prefs.sound_enabled}
                onChange={(e) => update('warn_lead_min', parseInt(e.target.value, 10))}
              >
                {[1, 2, 3, 5, 10, 15].map((n) => (
                  <option key={n} value={n}>{n} minute{n > 1 ? 's' : ''} before</option>
                ))}
              </select>
            </label>
          )}

          <hr className="acctprefs-divider" />

          <label className="acctprefs-field">
            <span className="acctprefs-label">Alert me for</span>
            <select
              className="acctprefs-select"
              value={prefs.alert_scope}
              onChange={(e) => update('alert_scope', e.target.value as AlertScopePref)}
            >
              {ALERT_SCOPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>

          <label className="acctprefs-row">
            <span className="acctprefs-row-label">
              Browser notification
              <span className="acctprefs-row-sublabel">Also show a system notification, not just a sound</span>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={prefs.browser_notif}
              className={`acctprefs-toggle-track${prefs.browser_notif ? ' acctprefs-toggle-track--on' : ''}`}
              onClick={handleBrowserNotifToggle}
            >
              <span className="acctprefs-toggle-thumb" />
            </button>
          </label>

          {prefs.browser_notif && !notificationsSupported() && (
            <p className="acctprefs-placeholder-note">
              This browser doesn't support notifications — you'll still hear the sound.
            </p>
          )}
          {prefs.browser_notif && notificationsSupported() && notifPermission === 'denied' && (
            <p className="acctprefs-placeholder-note">
              Notifications are blocked for this site in your browser settings — you'll still hear the sound.
            </p>
          )}

          {saveError && <p className="acctprefs-error" role="alert">{saveError}</p>}
          {!saveError && saving && <p className="acctprefs-placeholder-note">Saving…</p>}
          {!saveError && !saving && savedAt && <p className="acctprefs-saved-note">Saved</p>}
        </div>
      )}
    </section>
  )
}

// ─── Placeholder sections ───────────────────────────────────────────────────
// Same section shell as PasswordSection (acctprefs-section) so replacing one
// of these with a real control later is a body swap, not a layout change.

function PlaceholderSection({ icon, label, note }: { icon: ReactNode; label: string; note: string }) {
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
