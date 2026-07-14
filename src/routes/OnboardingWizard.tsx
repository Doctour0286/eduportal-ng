/**
 * OnboardingWizard.tsx
 * 8-step school setup wizard.
 * Progress saved automatically after every step.
 * Admin can close browser and resume where they left off.
 *
 * Steps:
 *   1. School identity (name, logo, contact)
 *   2. Language settings
 *   3. Calendar structure (session, uses_terms)
 *   4. Week days & periods
 *   5. Subjects
 *   6. Institution structure — Step 0 Decision 1 (PRD SESSION 55, master-plan
 *      §7.27.1 / §3.16 amendment): admin first picks the institution category
 *      here; "Secondary school" renders the original Classes tree exactly as
 *      before, any higher-institution category renders the new
 *      faculty/department/programme/level builder instead. This is the one
 *      fork point in the wizard — steps 1–5 and 7–8 are identical for both
 *      paths, per the reasoning that this choice doesn't change anything
 *      *before* the class/programme-structure step, only that step itself.
 *      Total step count stays 8: this is a branch within the existing Step 6
 *      slot, not an inserted Step 9, so progress persistence/step numbering
 *      for every other step is untouched.
 *   7. Roles & permissions
 *   8. Staff accounts
 */

import React, { useState, useEffect } from 'react'
import { Icon } from '../components/icons'
import {
  saveSchoolIdentity,
  saveLanguage,
  saveCalendar,
  saveWeekAndPeriods,
  saveSubjects,
  saveClassNode,
  deleteClassNode,
  getClassNodes,
  getPermissionsCatalog,
  saveRole,
  getRoles,
  createStaffMember,
  completeOnboarding,
  saveOnboardingProgress,
  getOnboardingProgress,
  saveInstitutionCategory,
  getInstitutionCategory,
  isHigherInstitution,
  saveFaculty,
  getFaculties,
  saveDepartment,
  getDepartments,
  saveProgramme,
  getProgrammes,
  saveProgrammeLevel,
  getProgrammeLevels,
  type WeekDayInput,
  type PeriodInput,
  type InstitutionCategory,
} from '../services/onboardingService'

const TOTAL_STEPS = 8

const STEP_LABELS = [
  'School identity',
  'Language',
  'Calendar',
  'Week & periods',
  'Subjects',
  'Structure',
  'Roles',
  'Staff',
]

interface WizardProps {
  schoolId: string
  schoolName: string
  onComplete: () => void
}

export function OnboardingWizard({ schoolId, schoolName, onComplete }: WizardProps) {
  const [currentStep, setCurrentStep] = useState(1)
  const [completedSteps, setCompletedSteps] = useState<number[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [finishError, setFinishError] = useState<string | null>(null)

  // Institution category (SESSION 55, Phase 0 Decision 1) — lifted to the
  // shell rather than fetched inside whichever step needs it, because it now
  // gates TWO steps: Step 5 (Subjects — skipped entirely for higher-ed
  // schools, since `courses`/`programme_curriculum` don't exist until
  // SESSION 56) and Step 6 (Classes vs. faculty/department/programme
  // structure). A single fetch here, read by both, avoids two components
  // independently racing to load/cache the same value.
  const [category, setCategory] = useState<InstitutionCategory | null>(null)
  const [categoryLoading, setCategoryLoading] = useState(true)

  // Load saved progress on mount
  useEffect(() => {
    getOnboardingProgress(schoolId).then((progress) => {
      setCurrentStep(progress.current_step)
      setCompletedSteps(progress.steps_completed)
      setIsLoading(false)
    })
  }, [schoolId])

  useEffect(() => {
    getInstitutionCategory(schoolId).then((c) => {
      setCategory(c)
      setCategoryLoading(false)
    })
  }, [schoolId])

  async function advanceStep(completedStep: number) {
    const newCompleted = completedSteps.includes(completedStep)
      ? completedSteps
      : [...completedSteps, completedStep]
    const nextStep = Math.min(completedStep + 1, TOTAL_STEPS)
    setCompletedSteps(newCompleted)
    setCurrentStep(nextStep)
    await saveOnboardingProgress(schoolId, nextStep, newCompleted)
  }

  async function skipStep(step: number) {
    const nextStep = Math.min(step + 1, TOTAL_STEPS)
    setCurrentStep(nextStep)
    await saveOnboardingProgress(schoolId, nextStep, completedSteps)
  }

  async function handleFinish() {
    setFinishError(null)
    const result = await completeOnboarding(schoolId)
    if (!result.ok) {
      // Do NOT call onComplete() — the DB write failed, so onboarding_complete
      // is still false server-side. Surfacing this now (instead of letting the
      // user sail through to the app and get bounced back to the wizard on the
      // next reload) is the actual fix for the reload-loop bug: the UI must not
      // advance past a state the database doesn't agree with.
      setFinishError(
        result.error ?? 'Could not finish setup — please check your connection and try again.',
      )
      return
    }
    onComplete()
  }

  if (isLoading || categoryLoading) {
    return (
      <div className="wizard-loading">
        <div className="skeleton-line" style={{ width: '60%' }} />
        <div className="skeleton-line" style={{ width: '40%' }} />
      </div>
    )
  }

  return (
    <div className="wizard-shell">
      {/* Header */}
      <div className="wizard-header">
        <p className="wizard-school-name">{schoolName}</p>
        <h1 className="wizard-title">Set up your school</h1>
        <p className="wizard-subtitle">
          Step {currentStep} of {TOTAL_STEPS} — {STEP_LABELS[currentStep - 1]}
        </p>

        {/* Progress bar */}
        <div className="wizard-progress-track" role="progressbar"
          aria-valuenow={currentStep} aria-valuemin={1} aria-valuemax={TOTAL_STEPS}>
          <div
            className="wizard-progress-fill"
            style={{ width: `${((currentStep - 1) / (TOTAL_STEPS - 1)) * 100}%` }}
          />
        </div>

        {/* Step dots */}
        <div className="wizard-steps-dots">
          {STEP_LABELS.map((label, i) => (
            <button
              key={i}
              className={`wizard-dot ${i + 1 === currentStep ? 'wizard-dot--active' : ''} ${completedSteps.includes(i + 1) ? 'wizard-dot--done' : ''}`}
              onClick={() => setCurrentStep(i + 1)}
              title={label}
              aria-label={`Go to step ${i + 1}: ${label}`}
            />
          ))}
        </div>
      </div>

      {/* Step content */}
      <div className="wizard-body">
        {currentStep === 1 && (
          <Step1Identity
            schoolId={schoolId}
            schoolName={schoolName}
            onNext={() => advanceStep(1)}
          />
        )}
        {currentStep === 2 && (
          <Step2Language
            schoolId={schoolId}
            onNext={() => advanceStep(2)}
            onBack={() => setCurrentStep(1)}
          />
        )}
        {currentStep === 3 && (
          <Step3Calendar
            schoolId={schoolId}
            onNext={() => advanceStep(3)}
            onBack={() => setCurrentStep(2)}
          />
        )}
        {currentStep === 4 && (
          <Step4WeekPeriods
            schoolId={schoolId}
            onNext={() => advanceStep(4)}
            onBack={() => setCurrentStep(3)}
          />
        )}
        {currentStep === 5 && (
          <Step5Gate
            schoolId={schoolId}
            category={category}
            onCategoryChosen={setCategory}
            onNext={() => advanceStep(5)}
            onBack={() => setCurrentStep(4)}
          />
        )}
        {currentStep === 6 && (
          <Step6Structure
            schoolId={schoolId}
            category={category}
            onNext={() => advanceStep(6)}
            onBack={() => setCurrentStep(5)}
            onSkip={() => skipStep(6)}
          />
        )}
        {currentStep === 7 && (
          <Step7Roles
            schoolId={schoolId}
            onNext={() => advanceStep(7)}
            onBack={() => setCurrentStep(6)}
          />
        )}
        {currentStep === 8 && (
          <Step8Staff
            schoolId={schoolId}
            onFinish={handleFinish}
            onBack={() => setCurrentStep(7)}
            finishError={finishError}
          />
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1 — School identity
// ─────────────────────────────────────────────────────────────────────────────

function Step1Identity({
  schoolId,
  schoolName,
  onNext,
}: {
  schoolId: string
  schoolName: string
  onNext: () => void
}) {
  const [welcomeMessage, setWelcomeMessage] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [address, setAddress] = useState('')
  const [themeColor, setThemeColor] = useState('#2563eb')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleNext() {
    setSaving(true)
    setError(null)
    const result = await saveSchoolIdentity(schoolId, {
      name: schoolName,
      theme_color: themeColor,
      welcome_message: welcomeMessage,
      contact_info: { phone, email, address },
    })
    setSaving(false)
    if (!result.ok) { setError(result.error ?? 'Could not save — try again'); return }
    onNext()
  }

  return (
    <div className="wizard-step">
      <h2 className="step-heading">Your school's public page</h2>
      <p className="step-desc">
        This information appears on your school's public homepage — what parents and visitors see before they log in.
      </p>

      <div className="form-stack">
        <div className="form-group">
          <label className="form-label">School name</label>
          <p className="form-value-locked">{schoolName}</p>
          <p className="form-hint">Set when the school was registered — contact support to change it.</p>
        </div>

        <label className="form-label">
          Welcome message <span className="optional">(optional)</span>
          <textarea
            className="form-textarea"
            rows={3}
            placeholder="Welcome to our school! We are committed to…"
            value={welcomeMessage}
            onChange={(e) => setWelcomeMessage(e.target.value)}
            maxLength={500}
          />
        </label>

        <label className="form-label">
          School colour
          <div className="color-picker-row">
            <input
              type="color"
              className="color-swatch-input"
              value={themeColor}
              onChange={(e) => setThemeColor(e.target.value)}
            />
            <span className="color-value-label">{themeColor}</span>
          </div>
        </label>

        <div className="section-divider">Contact information</div>

        <label className="form-label">
          Phone <span className="optional">(optional)</span>
          <input className="form-input" type="tel" placeholder="0812 345 6789" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </label>

        <label className="form-label">
          Email <span className="optional">(optional)</span>
          <input className="form-input" type="email" placeholder="info@school.edu.ng" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>

        <label className="form-label">
          Address <span className="optional">(optional)</span>
          <input className="form-input" type="text" placeholder="123 School Road, Abuja" value={address} onChange={(e) => setAddress(e.target.value)} />
        </label>
      </div>

      {error && <p className="form-error" role="alert">{error}</p>}

      <div className="wizard-actions">
        <button className="btn btn--primary btn--full" onClick={handleNext} disabled={saving}>
          {saving ? 'Saving…' : 'Save and continue'}
        </button>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2 — Language
// ─────────────────────────────────────────────────────────────────────────────

const LANG_OPTIONS = [
  { value: 'en' as const, label: 'English' },
  { value: 'ha' as const, label: 'Hausa' },
  { value: 'ar' as const, label: 'Arabic' },
]

function Step2Language({
  schoolId,
  onNext,
  onBack,
}: { schoolId: string; onNext: () => void; onBack: () => void }) {
  const [defaultLang, setDefaultLang] = useState<'en' | 'ar' | 'ha'>('en')
  const [enabledLangs, setEnabledLangs] = useState<('en' | 'ar' | 'ha')[]>(['en'])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function toggleLang(lang: 'en' | 'ar' | 'ha') {
    if (lang === defaultLang) return // can't disable the default
    setEnabledLangs((prev) =>
      prev.includes(lang) ? prev.filter((l) => l !== lang) : [...prev, lang],
    )
  }

  async function handleNext() {
    setSaving(true)
    setError(null)
    const result = await saveLanguage(schoolId, { default_lang: defaultLang, enabled_langs: enabledLangs })
    setSaving(false)
    if (!result.ok) { setError(result.error ?? 'Could not save'); return }
    onNext()
  }

  return (
    <div className="wizard-step">
      <h2 className="step-heading">What language does your school use?</h2>
      <p className="step-desc">The default language is shown to everyone. You can enable additional languages — users can switch between them.</p>

      <div className="form-stack">
        <div className="form-group">
          <p className="form-label">Primary (default) language</p>
          <div className="radio-card-group">
            {LANG_OPTIONS.map((opt) => (
              <label key={opt.value} className={`radio-card ${defaultLang === opt.value ? 'radio-card--selected' : ''}`}>
                <input
                  type="radio"
                  name="default_lang"
                  value={opt.value}
                  checked={defaultLang === opt.value}
                  onChange={() => {
                    setDefaultLang(opt.value)
                    if (!enabledLangs.includes(opt.value)) {
                      setEnabledLangs([...enabledLangs, opt.value])
                    }
                  }}
                  className="sr-only"
                />
                <span className="radio-card-label">{opt.label}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="form-group">
          <p className="form-label">Also enable <span className="optional">(optional)</span></p>
          <div className="checkbox-card-group">
            {LANG_OPTIONS.filter((o) => o.value !== defaultLang).map((opt) => (
              <label key={opt.value} className={`checkbox-card ${enabledLangs.includes(opt.value) ? 'checkbox-card--selected' : ''}`}>
                <input
                  type="checkbox"
                  checked={enabledLangs.includes(opt.value)}
                  onChange={() => toggleLang(opt.value)}
                  className="sr-only"
                />
                <span>{opt.label}</span>
              </label>
            ))}
          </div>
        </div>
      </div>

      {error && <p className="form-error" role="alert">{error}</p>}

      <div className="wizard-actions wizard-actions--two">
        <button className="btn btn--ghost" onClick={onBack}>Back</button>
        <button className="btn btn--primary" onClick={handleNext} disabled={saving}>
          {saving ? 'Saving…' : 'Continue'}
        </button>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3 — Calendar
// ─────────────────────────────────────────────────────────────────────────────

function Step3Calendar({
  schoolId,
  onNext,
  onBack,
}: { schoolId: string; onNext: () => void; onBack: () => void }) {
  const year = new Date().getFullYear()
  const [usesTerms, setUsesTerms] = useState(true)
  const [sessionName, setSessionName] = useState(`${year}/${year + 1}`)
  const [sessionStart, setSessionStart] = useState(`${year}-09-01`)
  const [sessionEnd, setSessionEnd] = useState(`${year + 1}-07-31`)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleNext() {
    if (!sessionName.trim()) { setError('Enter a name for this academic session'); return }
    if (!sessionStart || !sessionEnd) { setError('Enter start and end dates'); return }
    if (sessionEnd <= sessionStart) { setError('End date must be after start date'); return }
    setSaving(true)
    setError(null)
    const result = await saveCalendar(schoolId, {
      uses_terms: usesTerms,
      session_name: sessionName.trim(),
      session_start: sessionStart,
      session_end: sessionEnd,
    })
    setSaving(false)
    if (!result.ok) { setError(result.error ?? 'Could not save'); return }
    onNext()
  }

  return (
    <div className="wizard-step">
      <h2 className="step-heading">How is your school year structured?</h2>
      <p className="step-desc">Tell us your current academic session and whether your school uses terms.</p>

      <div className="form-stack">
        <label className="form-label">
          Academic session name
          <input
            className="form-input"
            type="text"
            value={sessionName}
            onChange={(e) => setSessionName(e.target.value)}
            placeholder="2025/2026"
          />
        </label>

        <div className="form-row">
          <label className="form-label">
            Session start
            <input className="form-input" type="date" value={sessionStart} onChange={(e) => setSessionStart(e.target.value)} />
          </label>
          <label className="form-label">
            Session end
            <input className="form-input" type="date" value={sessionEnd} onChange={(e) => setSessionEnd(e.target.value)} />
          </label>
        </div>

        <div className="toggle-card">
          <div className="toggle-card-text">
            <p className="toggle-card-title">Use terms within this session</p>
            <p className="toggle-card-desc">
              {usesTerms
                ? 'Your session is divided into terms (e.g. First Term, Second Term, Third Term). Fees and results can be tracked per term.'
                : 'Your session has no terms — everything is tracked for the full session. Good for Qur\'an schools or year-long programmes.'}
            </p>
          </div>
          <button
            role="switch"
            aria-checked={usesTerms}
            className={`toggle-switch ${usesTerms ? 'toggle-switch--on' : ''}`}
            onClick={() => setUsesTerms(!usesTerms)}
          >
            <span className="toggle-thumb" />
          </button>
        </div>
      </div>

      {error && <p className="form-error" role="alert">{error}</p>}

      <div className="wizard-actions wizard-actions--two">
        <button className="btn btn--ghost" onClick={onBack}>Back</button>
        <button className="btn btn--primary" onClick={handleNext} disabled={saving}>
          {saving ? 'Saving…' : 'Continue'}
        </button>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 4 — Week days & periods
// ─────────────────────────────────────────────────────────────────────────────

const ALL_DAYS = [
  { day: 0, label: 'Sun' },
  { day: 1, label: 'Mon' },
  { day: 2, label: 'Tue' },
  { day: 3, label: 'Wed' },
  { day: 4, label: 'Thu' },
  { day: 5, label: 'Fri' },
  { day: 6, label: 'Sat' },
]

const DEFAULT_PERIODS: PeriodInput[] = [
  { label: 'Period 1', start_time: '08:00', end_time: '08:45', is_break: false, sort_order: 1 },
  { label: 'Period 2', start_time: '08:45', end_time: '09:30', is_break: false, sort_order: 2 },
  { label: 'Period 3', start_time: '09:30', end_time: '10:15', is_break: false, sort_order: 3 },
  { label: 'Break',    start_time: '10:15', end_time: '10:30', is_break: true,  sort_order: 4 },
  { label: 'Period 4', start_time: '10:30', end_time: '11:15', is_break: false, sort_order: 5 },
  { label: 'Period 5', start_time: '11:15', end_time: '12:00', is_break: false, sort_order: 6 },
  { label: 'Lunch',    start_time: '12:00', end_time: '13:00', is_break: true,  sort_order: 7 },
  { label: 'Period 6', start_time: '13:00', end_time: '13:45', is_break: false, sort_order: 8 },
  { label: 'Period 7', start_time: '13:45', end_time: '14:30', is_break: false, sort_order: 9 },
]

function Step4WeekPeriods({
  schoolId,
  onNext,
  onBack,
}: { schoolId: string; onNext: () => void; onBack: () => void }) {
  const [selectedDays, setSelectedDays] = useState([1, 2, 3, 4, 5]) // Mon–Fri default
  const [periods, setPeriods] = useState<PeriodInput[]>(DEFAULT_PERIODS)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function toggleDay(day: number) {
    setSelectedDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort(),
    )
  }

  function updatePeriod(index: number, field: keyof PeriodInput, value: string | boolean) {
    setPeriods((prev) => prev.map((p, i) => i === index ? { ...p, [field]: value } : p))
  }

  function removePeriod(index: number) {
    setPeriods((prev) => prev.filter((_, i) => i !== index).map((p, i) => ({ ...p, sort_order: i + 1 })))
  }

  function addPeriod() {
    const last = periods[periods.length - 1]
    setPeriods([...periods, {
      label: `Period ${periods.filter((p) => !p.is_break).length + 1}`,
      start_time: last?.end_time || '14:30',
      end_time: '15:15',
      is_break: false,
      sort_order: periods.length + 1,
    }])
  }

  async function handleNext() {
    if (selectedDays.length === 0) { setError('Select at least one school day'); return }
    if (periods.length === 0) { setError('Add at least one period'); return }
    setSaving(true)
    setError(null)
    const days: WeekDayInput[] = selectedDays.map((day, i) => ({ day_of_week: day, sort_order: i }))
    const result = await saveWeekAndPeriods(schoolId, days, periods)
    setSaving(false)
    if (!result.ok) { setError(result.error ?? 'Could not save'); return }
    onNext()
  }

  return (
    <div className="wizard-step">
      <h2 className="step-heading">What days and periods does your school run?</h2>
      <p className="step-desc">Select your school days and set up the daily time periods.</p>

      <div className="form-stack">
        <div className="form-group">
          <p className="form-label">School days</p>
          <div className="day-chip-row">
            {ALL_DAYS.map(({ day, label }) => (
              <button
                key={day}
                className={`day-chip ${selectedDays.includes(day) ? 'day-chip--selected' : ''}`}
                onClick={() => toggleDay(day)}
                type="button"
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="form-group">
          <div className="form-label-row">
            <p className="form-label">Periods</p>
            <button className="link-btn" onClick={addPeriod} type="button">+ Add period</button>
          </div>
          <div className="period-list">
            {periods.map((period, i) => (
              <div key={i} className={`period-row ${period.is_break ? 'period-row--break' : ''}`}>
                <input
                  className="form-input period-label-input"
                  value={period.label}
                  onChange={(e) => updatePeriod(i, 'label', e.target.value)}
                  placeholder="Label"
                />
                <input
                  className="form-input period-time-input"
                  type="time"
                  value={period.start_time}
                  onChange={(e) => updatePeriod(i, 'start_time', e.target.value)}
                />
                <span className="period-dash">–</span>
                <input
                  className="form-input period-time-input"
                  type="time"
                  value={period.end_time}
                  onChange={(e) => updatePeriod(i, 'end_time', e.target.value)}
                />
                <label className="period-break-toggle" title="Is this a break/lunch?">
                  <input
                    type="checkbox"
                    checked={period.is_break}
                    onChange={(e) => updatePeriod(i, 'is_break', e.target.checked)}
                    className="sr-only"
                  />
                  <span className={`break-chip ${period.is_break ? 'break-chip--on' : ''}`}>Break</span>
                </label>
                <button
                  className="icon-btn icon-btn--danger"
                  onClick={() => removePeriod(i)}
                  type="button"
                  aria-label="Remove period"
                  disabled={periods.length <= 1}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      {error && <p className="form-error" role="alert">{error}</p>}

      <div className="wizard-actions wizard-actions--two">
        <button className="btn btn--ghost" onClick={onBack}>Back</button>
        <button className="btn btn--primary" onClick={handleNext} disabled={saving}>
          {saving ? 'Saving…' : 'Continue'}
        </button>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 5 GATE — institution category (Phase 0 Decision 1)
//
// This is the actual fork point: everything before Step 5 is identical for
// both paths. The choice made here decides two things at once — whether
// THIS step's slot shows Subjects at all (secondary only; a higher-ed
// school has no `subjects` concept — its equivalent, `courses`, doesn't
// exist until SESSION 56, so there is nothing to show), and what Step 6
// shows (Classes vs. faculty/department/programme structure).
//
// Placement follows the same UX reasoning used for Step 6 originally: a
// choice that changes downstream steps' behavior belongs immediately before
// the first step it affects — which, now that Step 5 itself has no content
// for higher-ed schools, is Step 5, not Step 6.
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORY_OPTIONS: { value: InstitutionCategory; label: string; desc: string }[] = [
  { value: 'secondary', label: 'Secondary / Basic school', desc: 'Students belong to a class (e.g. JSS 1A) — attendance, subjects, and results are tracked per class.' },
  { value: 'university', label: 'University', desc: 'NUC-regulated. Students register for courses each semester; GPA/CGPA tracked on a 5.0 scale.' },
  { value: 'polytechnic', label: 'Polytechnic / Monotechnic', desc: 'NBTE-regulated (ND/HND). Students register for courses each semester; GPA/CGPA tracked on a 4.0 scale.' },
  { value: 'college_of_education', label: 'College of Education', desc: 'NCCE-regulated. Fixed 40:60 CA:Exam split, course registration per semester.' },
  { value: 'other', label: 'Other higher institution', desc: "Doesn't fit the categories above (e.g. a school of nursing/midwifery). Fully manual configuration — no smart defaults assumed." },
]

function Step5Gate({
  schoolId,
  category,
  onCategoryChosen,
  onNext,
  onBack,
}: {
  schoolId: string
  category: InstitutionCategory | null
  onCategoryChosen: (c: InstitutionCategory) => void
  onNext: () => void
  onBack: () => void
}) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handlePickCategory(value: InstitutionCategory) {
    setSaving(true)
    setError(null)
    const result = await saveInstitutionCategory(schoolId, value)
    setSaving(false)
    if (!result.ok) { setError(result.error ?? 'Could not save — try again'); return }
    onCategoryChosen(value)
  }

  // No category chosen yet — show the picker.
  if (!category) {
    return (
      <div className="wizard-step">
        <h2 className="step-heading">What kind of school is this?</h2>
        <p className="step-desc">
          This changes what the next couple of steps ask for — a secondary school defines
          subjects and classes, a higher institution defines a faculty/department/programme
          structure instead. This can't be changed later without contacting support, so choose
          carefully.
        </p>

        <div className="form-stack">
          <div className="radio-card-group radio-card-group--stacked">
            {CATEGORY_OPTIONS.map((opt) => (
              <label key={opt.value} className="radio-card radio-card--wide">
                <input
                  type="radio"
                  name="institution_category"
                  value={opt.value}
                  checked={false}
                  onChange={() => handlePickCategory(opt.value)}
                  disabled={saving}
                  className="sr-only"
                />
                <span className="radio-card-label">{opt.label}</span>
                <span className="radio-card-desc">{opt.desc}</span>
              </label>
            ))}
          </div>
        </div>

        {error && <p className="form-error" role="alert">{error}</p>}
        {saving && <p className="form-hint">Saving…</p>}

        <div className="wizard-actions wizard-actions--two">
          <button className="btn btn--ghost" onClick={onBack}>Back</button>
        </div>
      </div>
    )
  }

  // Category already chosen (e.g. returning to this step after Back).
  // Secondary schools proceed to Subjects in this same slot; higher-ed
  // schools have nothing to configure here — auto-advance to Step 6.
  if (isHigherInstitution(category)) {
    // Advance on mount rather than rendering a dead-end screen. useEffect
    // (not a bare call in the render body) so this doesn't fire during
    // render / before commit.
    return <AutoAdvance onNext={onNext} />
  }

  return (
    <Step5Subjects
      schoolId={schoolId}
      onNext={onNext}
      onBack={onBack}
    />
  )
}

function AutoAdvance({ onNext }: { onNext: () => void }) {
  useEffect(() => {
    onNext()
  }, [])
  return (
    <div className="wizard-step">
      <div className="skeleton-line" style={{ width: '50%' }} />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 5 — Subjects
// ─────────────────────────────────────────────────────────────────────────────

// Common Nigerian school subjects for autocomplete suggestions
const SUBJECT_SUGGESTIONS = [
  'English Language', 'Mathematics', 'Basic Science', 'Civic Education',
  'Social Studies', 'Basic Technology', 'Agricultural Science', 'Business Studies',
  'Home Economics', 'Computer Studies', 'Physical and Health Education',
  'Christian Religious Studies', 'Islamic Religious Studies', 'Yoruba', 'Igbo', 'Hausa',
  'Physics', 'Chemistry', 'Biology', 'Further Mathematics', 'Economics',
  'Government', 'Literature in English', 'Geography', 'History', 'Financial Accounting',
  'Commerce', 'French', 'Arabic', 'Visual Art', 'Music',
  'Quran Recitation', 'Quran Memorisation', 'Islamic Studies', 'Fiqh', 'Hadith',
]

function Step5Subjects({
  schoolId,
  onNext,
  onBack,
}: { schoolId: string; onNext: () => void; onBack: () => void }) {
  const [subjects, setSubjects] = useState<string[]>([])
  const [inputValue, setInputValue] = useState('')
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function handleInputChange(val: string) {
    setInputValue(val)
    if (val.trim().length >= 2) {
      const lower = val.toLowerCase()
      setSuggestions(
        SUBJECT_SUGGESTIONS.filter(
          (s) => s.toLowerCase().includes(lower) && !subjects.includes(s),
        ).slice(0, 6),
      )
    } else {
      setSuggestions([])
    }
  }

  function addSubject(name: string) {
    const trimmed = name.trim()
    if (!trimmed || subjects.includes(trimmed)) return
    setSubjects([...subjects, trimmed])
    setInputValue('')
    setSuggestions([])
  }

  function removeSubject(name: string) {
    setSubjects(subjects.filter((s) => s !== name))
  }

  async function handleNext() {
    if (subjects.length === 0) { setError('Add at least one subject'); return }
    setSaving(true)
    setError(null)
    const result = await saveSubjects(schoolId, subjects.map((name) => ({ name })))
    setSaving(false)
    if (!result.ok) { setError(result.error ?? 'Could not save'); return }
    onNext()
  }

  return (
    <div className="wizard-step">
      <h2 className="step-heading">What subjects does your school teach?</h2>
      <p className="step-desc">
        Add your subject list. Type to search or add your own. You can change this anytime from settings.
      </p>

      <div className="form-stack">
        <div className="subject-input-area">
          <div className="subject-tags">
            {subjects.map((s) => (
              <span key={s} className="subject-tag">
                {s}
                <button className="subject-tag-remove" onClick={() => removeSubject(s)} type="button" aria-label={`Remove ${s}`}>×</button>
              </span>
            ))}
            <input
              className="subject-tag-input"
              value={inputValue}
              onChange={(e) => handleInputChange(e.target.value)}
              onKeyDown={(e) => {
                if ((e.key === 'Enter' || e.key === ',') && inputValue.trim()) {
                  e.preventDefault()
                  addSubject(inputValue)
                }
              }}
              placeholder={subjects.length === 0 ? 'Type a subject name, then press Enter' : 'Add another…'}
            />
          </div>

          {suggestions.length > 0 && (
            <div className="autocomplete-dropdown">
              {suggestions.map((s) => (
                <button
                  key={s}
                  className="autocomplete-option"
                  onClick={() => addSubject(s)}
                  type="button"
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>

        {subjects.length === 0 && (
          <div className="suggestions-chips-section">
            <p className="form-hint">Common subjects — tap to add:</p>
            <div className="suggestions-chips">
              {SUBJECT_SUGGESTIONS.slice(0, 10).map((s) => (
                <button
                  key={s}
                  className="suggestion-chip"
                  onClick={() => addSubject(s)}
                  type="button"
                >
                  + {s}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {error && <p className="form-error" role="alert">{error}</p>}

      <div className="wizard-actions wizard-actions--two">
        <button className="btn btn--ghost" onClick={onBack}>Back</button>
        <button className="btn btn--primary" onClick={handleNext} disabled={saving}>
          {saving ? 'Saving…' : `Continue with ${subjects.length} subject${subjects.length !== 1 ? 's' : ''}`}
        </button>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 6 — Class hierarchy
// ─────────────────────────────────────────────────────────────────────────────

interface ClassNodeDisplay {
  id: string
  name: string
  parent_id: string | null
  is_leaf_enrollable: boolean
  sort_order: number
}

// Category is now decided at Step 5 (Step5Gate, above) and passed down here
// as a prop — this component no longer fetches it or shows the picker
// itself. It only branches to the matching structure builder. "Change
// category" and "Back" both return to Step 5's slot, where the picker
// reappears (category is still set, so Step5Gate shows Subjects or
// auto-advances — the admin picking a different option there is what
// actually changes it).
function Step6Structure({
  schoolId,
  category,
  onNext,
  onBack,
  onSkip,
}: {
  schoolId: string
  category: InstitutionCategory | null
  onNext: () => void
  onBack: () => void
  onSkip: () => void
}) {
  // category should always be set by the time Step 6 renders (Step 5 can't
  // be passed without choosing it), but guard defensively rather than
  // assume — send the admin back to Step 5 if it's somehow still null.
  if (!category) {
    return (
      <div className="wizard-step">
        <p className="step-desc">We need to know what kind of school this is first.</p>
        <div className="wizard-actions wizard-actions--two">
          <button className="btn btn--ghost" onClick={onBack}>Back</button>
        </div>
      </div>
    )
  }

  return isHigherInstitution(category)
    ? (
      <Step6InstitutionStructure
        schoolId={schoolId}
        category={category}
        onNext={onNext}
        onBack={onBack}
        onChangeCategory={onBack}
      />
    )
    : (
      <Step6ClassesBody
        schoolId={schoolId}
        onNext={onNext}
        onBack={onBack}
        onSkip={onSkip}
      />
    )
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 6a — Classes (secondary-school path — original Step6Classes body,
// unchanged in content, only renamed and re-parented under Step6Structure)
// ─────────────────────────────────────────────────────────────────────────────

function Step6ClassesBody({
  schoolId,
  onNext,
  onBack,
  onSkip,
}: {
  schoolId: string
  onNext: () => void
  onBack: () => void
  onSkip: () => void
}) {
  const [nodes, setNodes] = useState<ClassNodeDisplay[]>([])
  const [addingName, setAddingName] = useState('')
  const [addingParent, setAddingParent] = useState<string | null>(null)
  const [addingIsLeaf, setAddingIsLeaf] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getClassNodes(schoolId).then(setNodes)
  }, [schoolId])

  async function handleAdd() {
    const trimmed = addingName.trim()
    if (!trimmed) return
    setSaving(true)
    const result = await saveClassNode(schoolId, {
      name: trimmed,
      parent_id: addingParent,
      is_leaf_enrollable: addingIsLeaf,
      sort_order: nodes.filter((n) => n.parent_id === addingParent).length,
    })
    if (result.ok && result.id) {
      setNodes([...nodes, {
        id: result.id,
        name: trimmed,
        parent_id: addingParent,
        is_leaf_enrollable: addingIsLeaf,
        sort_order: nodes.length,
      }])
      setAddingName('')
    } else {
      setError(result.error ?? 'Could not add class')
    }
    setSaving(false)
  }

  async function handleDelete(id: string) {
    const hasChildren = nodes.some((n) => n.parent_id === id)
    if (hasChildren) { setError('Remove child classes first before removing a parent'); return }
    await deleteClassNode(id)
    setNodes(nodes.filter((n) => n.id !== id))
  }

  // Build tree for display
  function renderTree(parentId: string | null, depth: number): React.ReactElement[] {
    return nodes
      .filter((n) => n.parent_id === parentId)
      .sort((a, b) => a.sort_order - b.sort_order)
      .flatMap((node) => [
        <div key={node.id} className="class-tree-node" style={{ paddingLeft: `${depth * 1.5}rem` }}>
          <span className="class-tree-icon"><Icon name={node.is_leaf_enrollable ? 'school' : 'folder'} size={16} /></span>
          <span className="class-tree-name">{node.name}</span>
          {node.is_leaf_enrollable && <span className="leaf-badge">enrollable</span>}
          <button
            className="icon-btn icon-btn--sm"
            onClick={() => setAddingParent(node.id)}
            type="button"
            title="Add child class"
            aria-label={`Add child class under ${node.name}`}
          ><Icon name="plus" size={14} /></button>
          <button
            className="icon-btn icon-btn--danger icon-btn--sm"
            onClick={() => handleDelete(node.id)}
            type="button"
            title="Remove"
            aria-label={`Remove ${node.name}`}
          ><Icon name="x" size={14} /></button>
        </div>,
        ...renderTree(node.id, depth + 1),
      ])
  }

  return (
    <div className="wizard-step">
      <h2 className="step-heading">Build your class structure</h2>
      <p className="step-desc">
        Add your classes, levels, and arms. A class marked "enrollable" is where students are actually placed.
        For example: <em>Junior Secondary → JSS 1 → JSS 1A, JSS 1B</em> — only the arms would be enrollable.
      </p>

      <div className="form-stack">
        {/* Add node form */}
        <div className="class-add-form">
          <label className="form-label">
            Class name
            <input
              className="form-input"
              value={addingName}
              onChange={(e) => setAddingName(e.target.value)}
              placeholder={addingParent ? 'e.g. JSS 1A' : 'e.g. Junior Secondary'}
              onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            />
          </label>

          {nodes.length > 0 && (
            <label className="form-label">
              Parent class <span className="optional">(none = top-level)</span>
              <select
                className="form-input"
                value={addingParent ?? ''}
                onChange={(e) => setAddingParent(e.target.value || null)}
              >
                <option value="">Top level (no parent)</option>
                {nodes.map((n) => (
                  <option key={n.id} value={n.id}>{n.name}</option>
                ))}
              </select>
            </label>
          )}

          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={addingIsLeaf}
              onChange={(e) => setAddingIsLeaf(e.target.checked)}
            />
            Students are enrolled directly into this class
          </label>

          <button
            className="btn btn--secondary"
            onClick={handleAdd}
            disabled={saving || !addingName.trim()}
            type="button"
          >
            {saving ? 'Adding…' : '+ Add class'}
          </button>
        </div>

        {/* Tree display */}
        {nodes.length > 0 ? (
          <div className="class-tree">
            {renderTree(null, 0)}
          </div>
        ) : (
          <div className="empty-state">
            <p>No classes yet — add your first one above.</p>
            <p className="empty-hint">You can also skip this step and set up classes later from Settings.</p>
          </div>
        )}
      </div>

      {error && <p className="form-error" role="alert">{error}</p>}

      <div className="wizard-actions wizard-actions--two">
        <button className="btn btn--ghost" onClick={onBack}>Back</button>
        <div className="wizard-actions-right">
          {nodes.length === 0 && (
            <button className="btn btn--ghost" onClick={onSkip}>Skip for now</button>
          )}
          <button
            className="btn btn--primary"
            onClick={onNext}
            disabled={nodes.length === 0 && false /* allow even if empty */}
          >
            {nodes.length > 0 ? 'Continue' : 'Skip'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 6b — Institution structure (higher-institution path)
// Per §7.27.1 / Phase 0 Decision 3: this deliberately does NOT reuse
// class_nodes. Requires at least one department → programme → level
// (faculty is optional) plus a matric-number format template before
// continuing, per SESSION 55 §0 instruction 4.
// ─────────────────────────────────────────────────────────────────────────────

interface FacultyDisplay { id: string; name: string; code: string | null }
interface DepartmentDisplay { id: string; name: string; code: string | null; faculty_id: string | null }
interface ProgrammeDisplay { id: string; name: string; award_type: string; department_id: string; duration_sessions: number }
interface ProgrammeLevelDisplay { id: string; level_label: string; sequence_order: number; programme_id: string }

const AWARD_TYPE_OPTIONS = [
  { value: 'degree', label: 'Degree (B.Sc/B.A/B.Eng etc.)' },
  { value: 'hnd', label: 'HND' },
  { value: 'nd', label: 'ND' },
  { value: 'nce', label: 'NCE' },
  { value: 'pgd', label: 'PGD' },
  { value: 'other', label: 'Other' },
]

function Step6InstitutionStructure({
  schoolId,
  category,
  onNext,
  onBack,
  onChangeCategory,
}: {
  schoolId: string
  category: InstitutionCategory
  onNext: () => void
  onBack: () => void
  onChangeCategory: () => void
}) {
  const [faculties, setFaculties] = useState<FacultyDisplay[]>([])
  const [departments, setDepartments] = useState<DepartmentDisplay[]>([])
  const [programmes, setProgrammes] = useState<ProgrammeDisplay[]>([])
  const [levelsByProgramme, setLevelsByProgramme] = useState<Record<string, ProgrammeLevelDisplay[]>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Add-faculty form (optional tier)
  const [facultyName, setFacultyName] = useState('')
  const [savingFaculty, setSavingFaculty] = useState(false)

  // Add-department form
  const [deptName, setDeptName] = useState('')
  const [deptFacultyId, setDeptFacultyId] = useState<string | null>(null)
  const [savingDept, setSavingDept] = useState(false)

  // Add-programme form
  const [progDeptId, setProgDeptId] = useState<string | null>(null)
  const [progName, setProgName] = useState('')
  const [progAwardType, setProgAwardType] = useState('degree')
  const [progDuration, setProgDuration] = useState(4)
  const [savingProg, setSavingProg] = useState(false)

  // Add-level form
  const [levelProgId, setLevelProgId] = useState<string | null>(null)
  const [levelLabel, setLevelLabel] = useState('')
  const [savingLevel, setSavingLevel] = useState(false)

  // Matric-number format template — stored via saveSchoolIdentity-adjacent
  // config would need its own settings column; per SESSION 55's own scope
  // (matric_number is on `students`, format is "school-configurable" per
  // §7.27.1, not a stored template column). Kept as local wizard-only
  // guidance text for now since no format-template column exists in
  // §7.27.1's schema — flagged rather than inventing a column silently.
  const [matricFormatExample, setMatricFormatExample] = useState('')

  const load = async () => {
    setLoading(true)
    const [f, d, p] = await Promise.all([
      getFaculties(schoolId),
      getDepartments(schoolId),
      getProgrammes(schoolId),
    ])
    setFaculties(f)
    setDepartments(d)
    setProgrammes(p)
    const levelEntries = await Promise.all(
      p.map(async (prog) => {
        const levels = await getProgrammeLevels(prog.id)
        // getProgrammeLevels doesn't select programme_id (it's implicit in
        // the query filter, not returned) but ProgrammeLevelDisplay needs
        // it for later lookups — attach it client-side rather than change
        // the service's query shape.
        const withProgrammeId: ProgrammeLevelDisplay[] = levels.map((lvl) => ({
          ...lvl,
          programme_id: prog.id,
        }))
        return [prog.id, withProgrammeId] as const
      }),
    )
    setLevelsByProgramme(Object.fromEntries(levelEntries))
    setLoading(false)
  }

  useEffect(() => { load() }, [schoolId])

  async function handleAddFaculty() {
    const trimmed = facultyName.trim()
    if (!trimmed) return
    setSavingFaculty(true)
    setError(null)
    const result = await saveFaculty(schoolId, { name: trimmed })
    setSavingFaculty(false)
    if (!result.ok) { setError(result.error ?? 'Could not add faculty'); return }
    setFacultyName('')
    await load()
  }

  async function handleAddDepartment() {
    const trimmed = deptName.trim()
    if (!trimmed) return
    setSavingDept(true)
    setError(null)
    const result = await saveDepartment(schoolId, { name: trimmed, faculty_id: deptFacultyId })
    setSavingDept(false)
    if (!result.ok) { setError(result.error ?? 'Could not add department'); return }
    setDeptName('')
    await load()
  }

  async function handleAddProgramme() {
    const trimmed = progName.trim()
    if (!trimmed || !progDeptId) { setError('Choose a department and enter a programme name'); return }
    setSavingProg(true)
    setError(null)
    const result = await saveProgramme(schoolId, {
      name: trimmed,
      award_type: progAwardType,
      department_id: progDeptId,
      duration_sessions: progDuration,
    })
    setSavingProg(false)
    if (!result.ok) { setError(result.error ?? 'Could not add programme'); return }
    setProgName('')
    await load()
  }

  async function handleAddLevel() {
    const trimmed = levelLabel.trim()
    if (!trimmed || !levelProgId) { setError('Choose a programme and enter a level label'); return }
    setSavingLevel(true)
    setError(null)
    const existing = levelsByProgramme[levelProgId] ?? []
    const result = await saveProgrammeLevel({
      programme_id: levelProgId,
      level_label: trimmed,
      sequence_order: existing.length + 1,
    })
    setSavingLevel(false)
    if (!result.ok) { setError(result.error ?? 'Could not add level'); return }
    setLevelLabel('')
    await load()
  }

  const hasAtLeastOneFullChain =
    departments.length > 0 &&
    programmes.length > 0 &&
    Object.values(levelsByProgramme).some((levels) => levels.length > 0)

  if (loading) {
    return (
      <div className="wizard-step">
        <div className="skeleton-line" style={{ width: '60%' }} />
      </div>
    )
  }

  return (
    <div className="wizard-step">
      <h2 className="step-heading">Build your institution structure</h2>
      <p className="step-desc">
        Add at least one department, one programme under it, and one level under that
        (faculty is optional). This replaces the class structure a secondary school would
        use — a student's real schedule here comes from course registration, not class
        membership.{' '}
        <button className="link-btn" type="button" onClick={onChangeCategory}>
          Not a {CATEGORY_OPTIONS.find((o) => o.value === category)?.label ?? 'higher institution'}? Change category
        </button>
      </p>

      <div className="form-stack">
        {/* Faculty (optional) */}
        <div className="section-divider">Faculty <span className="optional">(optional)</span></div>
        <div className="class-add-form">
          <label className="form-label">
            Faculty name
            <input
              className="form-input"
              value={facultyName}
              onChange={(e) => setFacultyName(e.target.value)}
              placeholder="e.g. Faculty of Science"
              onKeyDown={(e) => e.key === 'Enter' && handleAddFaculty()}
            />
          </label>
          <button className="btn btn--secondary" onClick={handleAddFaculty} disabled={savingFaculty || !facultyName.trim()} type="button">
            {savingFaculty ? 'Adding…' : '+ Add faculty'}
          </button>
        </div>
        {faculties.length > 0 && (
          <ul className="simple-list">
            {faculties.map((f) => <li key={f.id}>{f.name}</li>)}
          </ul>
        )}

        {/* Department (required) */}
        <div className="section-divider">Department</div>
        <div className="class-add-form">
          <label className="form-label">
            Department name
            <input
              className="form-input"
              value={deptName}
              onChange={(e) => setDeptName(e.target.value)}
              placeholder="e.g. Department of Nursing"
              onKeyDown={(e) => e.key === 'Enter' && handleAddDepartment()}
            />
          </label>
          {faculties.length > 0 && (
            <label className="form-label">
              Faculty <span className="optional">(none = direct)</span>
              <select className="form-input" value={deptFacultyId ?? ''} onChange={(e) => setDeptFacultyId(e.target.value || null)}>
                <option value="">No faculty</option>
                {faculties.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </label>
          )}
          <button className="btn btn--secondary" onClick={handleAddDepartment} disabled={savingDept || !deptName.trim()} type="button">
            {savingDept ? 'Adding…' : '+ Add department'}
          </button>
        </div>
        {departments.length > 0 && (
          <ul className="simple-list">
            {departments.map((d) => <li key={d.id}>{d.name}</li>)}
          </ul>
        )}

        {/* Programme (required) */}
        <div className="section-divider">Programme</div>
        <div className="class-add-form">
          <label className="form-label">
            Department
            <select className="form-input" value={progDeptId ?? ''} onChange={(e) => setProgDeptId(e.target.value || null)} disabled={departments.length === 0}>
              <option value="">{departments.length === 0 ? 'Add a department first' : 'Choose a department'}</option>
              {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </label>
          <label className="form-label">
            Programme name
            <input
              className="form-input"
              value={progName}
              onChange={(e) => setProgName(e.target.value)}
              placeholder="e.g. Basic Nursing Science"
            />
          </label>
          <div className="form-row">
            <label className="form-label">
              Award type
              <select className="form-input" value={progAwardType} onChange={(e) => setProgAwardType(e.target.value)}>
                {AWARD_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <label className="form-label">
              Duration (sessions)
              <input
                className="form-input"
                type="number"
                min={1}
                value={progDuration}
                onChange={(e) => setProgDuration(Number(e.target.value) || 1)}
              />
            </label>
          </div>
          <button className="btn btn--secondary" onClick={handleAddProgramme} disabled={savingProg || !progName.trim() || !progDeptId} type="button">
            {savingProg ? 'Adding…' : '+ Add programme'}
          </button>
        </div>
        {programmes.length > 0 && (
          <ul className="simple-list">
            {programmes.map((p) => <li key={p.id}>{p.name} ({p.award_type}, {p.duration_sessions} sessions)</li>)}
          </ul>
        )}

        {/* Level (required) */}
        <div className="section-divider">Level</div>
        <div className="class-add-form">
          <label className="form-label">
            Programme
            <select className="form-input" value={levelProgId ?? ''} onChange={(e) => setLevelProgId(e.target.value || null)} disabled={programmes.length === 0}>
              <option value="">{programmes.length === 0 ? 'Add a programme first' : 'Choose a programme'}</option>
              {programmes.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label className="form-label">
            Level label
            <input
              className="form-input"
              value={levelLabel}
              onChange={(e) => setLevelLabel(e.target.value)}
              placeholder="e.g. 100, ND1, Year 1"
            />
          </label>
          <button className="btn btn--secondary" onClick={handleAddLevel} disabled={savingLevel || !levelLabel.trim() || !levelProgId} type="button">
            {savingLevel ? 'Adding…' : '+ Add level'}
          </button>
        </div>
        {levelProgId && (levelsByProgramme[levelProgId]?.length ?? 0) > 0 && (
          <ul className="simple-list">
            {levelsByProgramme[levelProgId].map((l) => <li key={l.id}>{l.level_label}</li>)}
          </ul>
        )}

        {/* Matric number format guidance */}
        <div className="section-divider">Matriculation number format</div>
        <label className="form-label">
          Example matric number for this school <span className="optional">(guidance only, e.g. NUR/2026/0001)</span>
          <input
            className="form-input"
            value={matricFormatExample}
            onChange={(e) => setMatricFormatExample(e.target.value)}
            placeholder="e.g. NUR/2026/0001"
          />
        </label>
        <p className="form-hint">
          Each student's actual matric number is entered when they're admitted — this is just
          an example to guide your registrar. The format is entirely up to your institution.
        </p>
      </div>

      {error && <p className="form-error" role="alert">{error}</p>}
      {!hasAtLeastOneFullChain && (
        <p className="form-hint">
          Add at least one department → programme → level before continuing.
        </p>
      )}

      <div className="wizard-actions wizard-actions--two">
        <button className="btn btn--ghost" onClick={onBack}>Back</button>
        <button className="btn btn--primary" onClick={onNext} disabled={!hasAtLeastOneFullChain}>
          Continue
        </button>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 7 — Roles & permissions
// ─────────────────────────────────────────────────────────────────────────────

const PERMISSION_DESCRIPTIONS: Record<string, string> = {
  'attendance.mark': 'Mark student attendance',
  'attendance.view': 'View attendance records',
  'results.enter': 'Enter student scores',
  'results.approve': 'Approve scores for release',
  'results.view': 'View all results (before approval)',
  'timetable.edit': 'Edit the school timetable',
  'timetable.view': 'View the timetable',
  'fees.record': 'Record fee payments',
  'fees.waive': 'Apply discounts and waivers',
  'fees.view': 'View fee records',
  'finance.ledger': 'Access double-entry ledger',
  'hr.manage': 'Manage staff HR records',
  'hr.payroll': 'Process payroll',
  'hr.leave': 'Approve leave requests',
  'library.manage': 'Manage library books and loans',
  'admin.full': 'Full school administration',
  'admin.roles': 'Manage roles and permissions',
  'admin.students': 'Manage student records',
  'admin.settings': 'Manage school settings',
}

function Step7Roles({
  schoolId,
  onNext,
  onBack,
}: { schoolId: string; onNext: () => void; onBack: () => void }) {
  const [catalog, setCatalog] = useState<{ key: string; description: string; module: string }[]>([])
  const [roles, setRoles] = useState<{ id: string; name: string; is_admin_role: boolean }[]>([])
  const [newRoleName, setNewRoleName] = useState('')
  const [newRoleIsAdmin, setNewRoleIsAdmin] = useState(false)
  const [newRolePerms, setNewRolePerms] = useState<string[]>([])
  const [expandedModule, setExpandedModule] = useState<string | null>('academics')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedMessage, setSavedMessage] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([getPermissionsCatalog(), getRoles(schoolId)]).then(([cat, existingRoles]) => {
      setCatalog(cat)
      setRoles(existingRoles)
    })
  }, [schoolId])

  const byModule = catalog.reduce(
    (acc, p) => {
      if (!acc[p.module]) acc[p.module] = []
      acc[p.module].push(p)
      return acc
    },
    {} as Record<string, { key: string; description: string; module: string }[]>,
  )

  function togglePerm(key: string) {
    setNewRolePerms((prev) => prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key])
  }

  async function handleSaveRole() {
    if (!newRoleName.trim()) { setError('Enter a name for this role'); return }
    setSaving(true)
    setError(null)
    const result = await saveRole(schoolId, {
      name: newRoleName.trim(),
      is_admin_role: newRoleIsAdmin,
      permission_keys: newRolePerms,
    })
    setSaving(false)
    if (!result.ok) { setError(result.error ?? 'Could not save role'); return }
    const updated = await getRoles(schoolId)
    setRoles(updated)
    setSavedMessage(`Role "${newRoleName.trim()}" saved`)
    setNewRoleName('')
    setNewRoleIsAdmin(false)
    setNewRolePerms([])
    setTimeout(() => setSavedMessage(null), 2500)
  }

  return (
    <div className="wizard-step">
      <h2 className="step-heading">Define roles for your staff</h2>
      <p className="step-desc">
        Create roles like "Class Teacher", "Bursar", or "Principal" and choose what each role can do.
        Staff can hold multiple roles — their permissions are combined.
      </p>

      <div className="form-stack">
        {/* Existing roles */}
        {roles.length > 0 && (
          <div className="roles-list">
            {roles.map((r) => (
              <div key={r.id} className="role-chip">
                {r.is_admin_role && <span className="admin-badge">Admin</span>}
                {r.name}
              </div>
            ))}
          </div>
        )}

        {/* Add role form */}
        <div className="role-add-form">
          <label className="form-label">
            Role name
            <input
              className="form-input"
              value={newRoleName}
              onChange={(e) => setNewRoleName(e.target.value)}
              placeholder="e.g. Class Teacher, Bursar, Vice Principal"
            />
          </label>

          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={newRoleIsAdmin}
              onChange={(e) => setNewRoleIsAdmin(e.target.checked)}
            />
            This is an admin role (full school access)
          </label>

          {!newRoleIsAdmin && (
            <div className="permissions-accordion">
              <p className="form-label">Permissions for this role</p>
              {Object.entries(byModule).map(([module, perms]) => (
                <div key={module} className="perm-module">
                  <button
                    className="perm-module-header"
                    onClick={() => setExpandedModule(expandedModule === module ? null : module)}
                    type="button"
                  >
                    <span className="perm-module-name">{module.charAt(0).toUpperCase() + module.slice(1)}</span>
                    <span className="perm-module-count">
                      {perms.filter((p) => newRolePerms.includes(p.key)).length}/{perms.length}
                    </span>
                    <span className="accordion-arrow">{expandedModule === module ? '▲' : '▼'}</span>
                  </button>
                  {expandedModule === module && (
                    <div className="perm-module-body">
                      {perms.map((p) => (
                        <label key={p.key} className="perm-checkbox-label">
                          <input
                            type="checkbox"
                            checked={newRolePerms.includes(p.key)}
                            onChange={() => togglePerm(p.key)}
                          />
                          {PERMISSION_DESCRIPTIONS[p.key] ?? p.description}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {error && <p className="form-error" role="alert">{error}</p>}
          {savedMessage && <p className="form-success" role="status">{savedMessage}</p>}

          <button
            className="btn btn--secondary"
            onClick={handleSaveRole}
            disabled={saving || !newRoleName.trim()}
            type="button"
          >
            {saving ? 'Saving…' : '+ Save role'}
          </button>
        </div>
      </div>

      <div className="wizard-actions wizard-actions--two">
        <button className="btn btn--ghost" onClick={onBack}>Back</button>
        <button className="btn btn--primary" onClick={onNext}>
          {roles.length > 0 ? `Continue with ${roles.length} role${roles.length !== 1 ? 's' : ''}` : 'Skip for now'}
        </button>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 8 — Staff
// ─────────────────────────────────────────────────────────────────────────────

interface StaffEntry {
  full_name: string
  email: string
  role_ids: string[]
  tempPassword?: string
  saved: boolean
}

function Step8Staff({
  schoolId,
  onFinish,
  onBack,
  finishError,
}: { schoolId: string; onFinish: () => void | Promise<void>; onBack: () => void; finishError: string | null }) {
  const [roles, setRoles] = useState<{ id: string; name: string }[]>([])
  const [staffList, setStaffList] = useState<StaffEntry[]>([])
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [selectedRoles, setSelectedRoles] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [finishing, setFinishing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getRoles(schoolId).then(setRoles)
  }, [schoolId])

  function toggleRole(id: string) {
    setSelectedRoles((prev) => prev.includes(id) ? prev.filter((r) => r !== id) : [...prev, id])
  }

  async function handleAddStaff() {
    if (!fullName.trim()) { setError('Enter the staff member\'s full name'); return }
    if (!email.trim()) { setError('Enter their email address'); return }
    setSaving(true)
    setError(null)
    const result = await createStaffMember(schoolId, {
      full_name: fullName.trim(),
      email: email.trim(),
      role_ids: selectedRoles,
    })
    setSaving(false)
    if (!result.ok) { setError(result.error ?? 'Could not create account'); return }
    setStaffList([...staffList, {
      full_name: fullName.trim(),
      email: email.trim(),
      role_ids: selectedRoles,
      tempPassword: result.tempPassword,
      saved: true,
    }])
    setFullName('')
    setEmail('')
    setSelectedRoles([])
  }

  async function handleFinish() {
    setFinishing(true)
    await onFinish()
    // If completeOnboarding() failed, the parent sets finishError and does NOT
    // call its own onComplete() — meaning this component is still mounted and
    // visible. Clear `finishing` so the button is tappable again for a retry,
    // rather than being stuck on "Setting up…" forever.
    setFinishing(false)
  }

  return (
    <div className="wizard-step">
      <h2 className="step-heading">Add your first staff members</h2>
      <p className="step-desc">
        Each person gets an email with their temporary password. They can change it on first login.
        You can add more staff anytime from the Staff section.
      </p>

      <div className="form-stack">
        {/* Saved staff list */}
        {staffList.length > 0 && (
          <div className="staff-added-list">
            {staffList.map((s, i) => (
              <div key={i} className="staff-added-row">
                <div className="staff-added-info">
                  <p className="staff-added-name">{s.full_name}</p>
                  <p className="staff-added-email">{s.email}</p>
                </div>
                {s.tempPassword && (
                  <div className="temp-password-box">
                    <span>Temp password:</span>
                    <code className="temp-password">{s.tempPassword}</code>
                    <button
                      className="link-btn"
                      onClick={() => navigator.clipboard.writeText(s.tempPassword!)}
                      type="button"
                    >
                      Copy
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Add staff form */}
        <div className="staff-add-form">
          <label className="form-label">
            Full name
            <input
              className="form-input"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="e.g. Aisha Ibrahim"
            />
          </label>

          <label className="form-label">
            Email address
            <input
              className="form-input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="aisha@school.edu.ng"
            />
          </label>

          {roles.length > 0 && (
            <div className="form-group">
              <p className="form-label">Roles <span className="optional">(optional)</span></p>
              <div className="role-checkboxes">
                {roles.map((r) => (
                  <label key={r.id} className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={selectedRoles.includes(r.id)}
                      onChange={() => toggleRole(r.id)}
                    />
                    {r.name}
                  </label>
                ))}
              </div>
            </div>
          )}

          {error && <p className="form-error" role="alert">{error}</p>}

          <button
            className="btn btn--secondary"
            onClick={handleAddStaff}
            disabled={saving}
            type="button"
          >
            {saving ? 'Creating account…' : '+ Add staff member'}
          </button>
        </div>
      </div>

      {finishError && <p className="form-error" role="alert">{finishError}</p>}

      <div className="wizard-actions wizard-actions--two">
        <button className="btn btn--ghost" onClick={onBack}>Back</button>
        <button
          className="btn btn--primary"
          onClick={handleFinish}
          disabled={finishing}
        >
          {finishing ? 'Setting up…' : staffList.length > 0 ? '🎉 Go to my school' : 'Skip — finish setup'}
        </button>
      </div>
    </div>
  )
}
