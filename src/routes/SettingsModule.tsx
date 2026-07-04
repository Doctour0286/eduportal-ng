/**
 * SettingsModule.tsx
 * Admin settings panel — Phase 6, final module.
 *
 * Tabs:
 *   School      — branding (name, logo, theme), language, public config (welcome msg, contacts)
 *   Calendar    — sessions + terms (when uses_terms=true); flag to toggle uses_terms
 *   Schedule    — school week days + periods (add/edit/delete/reorder)
 *   Classes     — class node tree (add/edit nodes at any depth)
 *   Subjects    — subject list (add/edit)
 *   Roles       — role management + permission assignment
 *   Staff       — read-only list with roles; links to HRModule for edits
 *   Audit       — audit log viewer (filter by table + action; paginated)
 *
 * Props:
 *   schoolId   — current school UUID
 *   isAdmin    — must be true; component renders nothing for non-admins
 *
 * CSS prefix: set-*
 * Follows every project convention from sessions 1–23.
 */

import { useState, useEffect, useCallback } from 'react'
import {
  loadSchoolSettings,       updateSchoolSettings,
  loadPublicConfig,         savePublicConfig,
  loadSessions,             upsertSession,
  loadTerms,                upsertTerm,
  loadCalendarDays,         upsertCalendarDay,  bulkUpsertCalendarDays,  deleteCalendarDay,
  loadWeekDays,             saveWeekDays,
  loadPeriods,              upsertPeriod,   deletePeriod,
  loadSubjects,             upsertSubject,
  loadPermissionsCatalog,   loadRoles,      saveRole,   deleteRole,
  loadStaffWithRoles,
  loadAuditLog,             loadAuditTableNames,
  buildClassTree,           loadClassNodes, upsertClassNode,
  loadStudentRoles,         saveStudentRole, deleteStudentRole,
  type SchoolSettings,
  type SchoolPublicConfig,
  type Period,
  type Subject,
  type Role,
  type Permission,
  type Session,
  type Term,
  type CalendarDay,
  type CalendarDayType,
  type ClassNode,
  type StaffListItem,
  type AuditEntry,
  type StudentRole,
} from '../services/settingsService'
import { getEffectiveTermEndDate } from '../services/attendanceService'

// ─── Tab definition ───────────────────────────────────────────────────────────

type SettingsTab = 'school' | 'calendar' | 'schedule' | 'classes' | 'subjects' | 'roles' | 'student-roles' | 'staff' | 'audit'

const TABS: { id: SettingsTab; label: string; icon: string }[] = [
  { id: 'school',        label: 'School',        icon: '🏫' },
  { id: 'calendar',      label: 'Calendar',      icon: '📅' },
  { id: 'schedule',      label: 'Schedule',      icon: '⏰' },
  { id: 'classes',       label: 'Classes',       icon: '🏷️' },
  { id: 'subjects',      label: 'Subjects',      icon: '📖' },
  { id: 'roles',         label: 'Roles',         icon: '🔑' },
  { id: 'student-roles', label: 'Student roles', icon: '🎓' },
  { id: 'staff',         label: 'Staff',         icon: '👥' },
  { id: 'audit',         label: 'Audit log',     icon: '📋' },
]

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// ─── Root component ───────────────────────────────────────────────────────────

export default function SettingsModule({ schoolId, isAdmin }: { schoolId: string; isAdmin: boolean }) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('school')

  if (!isAdmin) return null

  return (
    <div className="set-root">
      <div className="set-header">
        <h1 className="set-title">Settings</h1>
        <p className="set-subtitle">Configure your school's details and modules</p>
      </div>

      {/* Horizontal scrollable tab bar */}
      <div className="set-tabs" role="tablist">
        {TABS.map(t => (
          <button
            key={t.id}
            role="tab"
            aria-selected={activeTab === t.id}
            className={`set-tab${activeTab === t.id ? ' set-tab--active' : ''}`}
            onClick={() => setActiveTab(t.id)}
          >
            <span className="set-tab-icon">{t.icon}</span>
            <span className="set-tab-label">{t.label}</span>
          </button>
        ))}
      </div>

      <div className="set-body">
        {activeTab === 'school'    && <SchoolTab   schoolId={schoolId} />}
        {activeTab === 'calendar'  && <CalendarTab schoolId={schoolId} />}
        {activeTab === 'schedule'  && <ScheduleTab schoolId={schoolId} />}
        {activeTab === 'classes'   && <ClassesTab  schoolId={schoolId} />}
        {activeTab === 'subjects'  && <SubjectsTab schoolId={schoolId} />}
        {activeTab === 'roles'         && <RolesTab        schoolId={schoolId} />}
        {activeTab === 'student-roles' && <StudentRolesTab schoolId={schoolId} />}
        {activeTab === 'staff'         && <StaffTab        schoolId={schoolId} />}
        {activeTab === 'audit'         && <AuditTab        schoolId={schoolId} />}
      </div>
    </div>
  )
}

// ─── Shared helper components ─────────────────────────────────────────────────

function SaveBar({ saving, saved, error, onSave }: { saving: boolean; saved: boolean; error: string | null; onSave: () => void }) {
  return (
    <div className="set-save-bar">
      {error && <p className="set-save-error">{error}</p>}
      {saved && !error && <p className="set-save-ok">✓ Saved</p>}
      <button className="set-save-btn" onClick={onSave} disabled={saving}>
        {saving ? 'Saving…' : 'Save changes'}
      </button>
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="set-section-label">{children}</p>
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="set-field-row">
      <label className="set-field-label">{label}</label>
      <div className="set-field-control">{children}</div>
    </div>
  )
}

function Input({ value, onChange, placeholder, type = 'text' }: { value: string; onChange: (v: string) => void; placeholder?: string; type?: string }) {
  return (
    <input
      type={type}
      className="set-input"
      value={value}
      placeholder={placeholder}
      onChange={e => onChange(e.target.value)}
    />
  )
}

function Textarea({ value, onChange, placeholder, rows = 3 }: { value: string; onChange: (v: string) => void; placeholder?: string; rows?: number }) {
  return (
    <textarea
      className="set-textarea"
      value={value}
      placeholder={placeholder}
      rows={rows}
      onChange={e => onChange(e.target.value)}
    />
  )
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="set-toggle-wrap">
      <span className="set-toggle-label">{label}</span>
      <span className={`set-toggle-track${checked ? ' set-toggle-track--on' : ''}`} onClick={() => onChange(!checked)}>
        <span className="set-toggle-thumb" />
        <input type="checkbox" className="set-toggle-input" checked={checked} onChange={e => onChange(e.target.checked)} aria-label={label} />
      </span>
    </label>
  )
}

function Skeleton({ lines = 4 }: { lines?: number }) {
  return (
    <div className="set-skel">
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className="set-skel-line" style={{ width: i % 3 === 0 ? '70%' : i % 3 === 1 ? '50%' : '85%' }} />
      ))}
    </div>
  )
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="set-error-state">
      <span className="set-error-icon">⚠️</span>
      <p className="set-error-msg">{message}</p>
      <button className="set-retry-btn" onClick={onRetry}>Retry</button>
    </div>
  )
}

// ─── Tab: School ──────────────────────────────────────────────────────────────

function SchoolTab({ schoolId }: { schoolId: string }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [_settings, setSettings] = useState<SchoolSettings | null>(null)
  const [_pubCfg, setPubCfg] = useState<SchoolPublicConfig | null>(null)

  // Form state
  const [name, setName] = useState('')
  const [schoolType, setSchoolType] = useState('')
  const [logoUrl, setLogoUrl] = useState('')
  const [themeColor, setThemeColor] = useState('#4f46e5')
  const [defaultLang, setDefaultLang] = useState<'en' | 'ar' | 'ha'>('en')
  const [enabledLangs, setEnabledLangs] = useState<string[]>(['en'])
  const [usesTerms, setUsesTerms] = useState(true)
  const [usesLedger, setUsesLedger] = useState(false)
  const [welcomeMsg, setWelcomeMsg] = useState('')
  const [contactPhone, setContactPhone] = useState('')
  const [contactEmail, setContactEmail] = useState('')
  const [contactAddress, setContactAddress] = useState('')
  const [showAnnouncements, setShowAnnouncements] = useState(true)

  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const [sRes, pRes] = await Promise.all([
      loadSchoolSettings(schoolId),
      loadPublicConfig(schoolId),
    ])
    if (sRes.error || pRes.error) {
      setError(sRes.error ?? pRes.error)
      setLoading(false)
      return
    }
    const s = sRes.data!
    const p = pRes.data!
    setSettings(s)
    setPubCfg(p)
    setName(s.name)
    setSchoolType(s.school_type ?? '')
    setLogoUrl(s.logo_url ?? '')
    setThemeColor(s.theme_color ?? '#4f46e5')
    setDefaultLang(s.default_lang)
    setEnabledLangs(s.enabled_langs ?? ['en'])
    setUsesTerms(s.uses_terms)
    setUsesLedger(s.uses_ledger)
    setWelcomeMsg(p.welcome_message ?? '')
    setContactPhone((p.contact_info as { phone?: string })?.phone ?? '')
    setContactEmail((p.contact_info as { email?: string })?.email ?? '')
    setContactAddress((p.contact_info as { address?: string })?.address ?? '')
    setShowAnnouncements(p.show_announcements)
    setLoading(false)
  }, [schoolId])

  useEffect(() => { load() }, [load])

  async function handleSave() {
    setSaving(true)
    setSaveError(null)
    setSaved(false)

    const [sRes, pRes] = await Promise.all([
      updateSchoolSettings(schoolId, {
        name, school_type: schoolType || null, logo_url: logoUrl || null,
        theme_color: themeColor, default_lang: defaultLang,
        enabled_langs: enabledLangs, uses_terms: usesTerms, uses_ledger: usesLedger,
      }),
      savePublicConfig(schoolId, {
        welcome_message: welcomeMsg || null,
        contact_info: {
          phone: contactPhone || undefined,
          email: contactEmail || undefined,
          address: contactAddress || undefined,
        },
        show_announcements: showAnnouncements,
      }),
    ])

    if (sRes.error || pRes.error) {
      setSaveError(sRes.error ?? pRes.error)
    } else {
      setSaved(true)
      // Apply theme color live
      if (themeColor) document.documentElement.style.setProperty('--color-brand-600', themeColor)
      setTimeout(() => setSaved(false), 3000)
    }
    setSaving(false)
  }

  function toggleLang(lang: string) {
    setEnabledLangs(prev =>
      prev.includes(lang) ? prev.filter(l => l !== lang) : [...prev, lang]
    )
  }

  if (loading) return <Skeleton lines={8} />
  if (error) return <ErrorState message={error} onRetry={load} />

  return (
    <div className="set-tab-content">
      <SectionLabel>School identity</SectionLabel>
      <FieldRow label="School name">
        <Input value={name} onChange={setName} placeholder="e.g. Dilimi Model School" />
      </FieldRow>
      <FieldRow label="School type (optional)">
        <Input value={schoolType} onChange={setSchoolType} placeholder="e.g. Primary, Secondary, Madrasa" />
      </FieldRow>
      <FieldRow label="Logo URL (optional)">
        <Input value={logoUrl} onChange={setLogoUrl} placeholder="https://…" />
        {logoUrl && <img src={logoUrl} alt="Logo preview" className="set-logo-preview" />}
      </FieldRow>
      <FieldRow label="Theme colour">
        <div className="set-color-row">
          <input type="color" className="set-color-picker" value={themeColor} onChange={e => setThemeColor(e.target.value)} />
          <Input value={themeColor} onChange={setThemeColor} placeholder="#4f46e5" />
        </div>
      </FieldRow>

      <SectionLabel>Language</SectionLabel>
      <FieldRow label="Default language">
        <select className="set-select" value={defaultLang} onChange={e => setDefaultLang(e.target.value as 'en' | 'ar' | 'ha')}>
          <option value="en">English</option>
          <option value="ar">Arabic (العربية)</option>
          <option value="ha">Hausa</option>
        </select>
      </FieldRow>
      <FieldRow label="Additional languages">
        <div className="set-lang-chips">
          {(['en', 'ar', 'ha'] as const).map(lang => (
            <button
              key={lang}
              className={`set-lang-chip${enabledLangs.includes(lang) ? ' set-lang-chip--on' : ''}`}
              onClick={() => toggleLang(lang)}
              type="button"
            >
              {lang === 'en' ? 'English' : lang === 'ar' ? 'العربية' : 'Hausa'}
            </button>
          ))}
        </div>
      </FieldRow>

      <SectionLabel>Module flags</SectionLabel>
      <Toggle checked={usesTerms} onChange={setUsesTerms} label="Use terms within each session (e.g. 1st, 2nd, 3rd term)" />
      <Toggle checked={usesLedger} onChange={setUsesLedger} label="Enable double-entry ledger (advanced accounting)" />

      <SectionLabel>Public page</SectionLabel>
      <FieldRow label="Welcome message">
        <Textarea value={welcomeMsg} onChange={setWelcomeMsg} placeholder="A short message shown to visitors on your school's public page." />
      </FieldRow>
      <FieldRow label="Phone">
        <Input value={contactPhone} onChange={setContactPhone} placeholder="+234 801 234 5678" />
      </FieldRow>
      <FieldRow label="Email">
        <Input value={contactEmail} onChange={setContactEmail} placeholder="admin@yourschool.edu.ng" type="email" />
      </FieldRow>
      <FieldRow label="Address">
        <Textarea value={contactAddress} onChange={setContactAddress} placeholder="Full school address" rows={2} />
      </FieldRow>
      <Toggle checked={showAnnouncements} onChange={setShowAnnouncements} label="Show announcements on public page" />

      <SaveBar saving={saving} saved={saved} error={saveError} onSave={handleSave} />
    </div>
  )
}

// ─── Tab: Calendar ────────────────────────────────────────────────────────────

function CalendarTab({ schoolId }: { schoolId: string }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sessions, setSessions] = useState<Session[]>([])
  const [usesTerms, setUsesTerms] = useState(true)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [terms, setTerms] = useState<Term[]>([])
  const [termsLoading, setTermsLoading] = useState(false)

  // Session form
  const [showSessionForm, setShowSessionForm] = useState(false)
  const [editingSession, setEditingSession] = useState<Session | null>(null)
  const [sesName, setSesName] = useState('')
  const [sesStart, setSesStart] = useState('')
  const [sesEnd, setSesEnd] = useState('')
  const [sesCurrent, setSesCurrent] = useState(false)
  const [sesSaving, setSesSaving] = useState(false)
  const [sesError, setSesError] = useState<string | null>(null)

  // Term form
  const [showTermForm, setShowTermForm] = useState(false)
  const [editingTerm, setEditingTerm] = useState<Term | null>(null)
  const [termName, setTermName] = useState('')
  const [termSeq, setTermSeq] = useState(1)
  const [termStart, setTermStart] = useState('')
  const [termEnd, setTermEnd] = useState('')
  const [termSaving, setTermSaving] = useState(false)
  const [termError, setTermError] = useState<string | null>(null)

  // School calendar (holidays/exam days/breaks) — Session 18/29 (PRD Problem
  // 5.2 + 6.7's per-entry extend refinement). Scoped to selectedSessionId,
  // same as terms above, so it works whether or not uses_terms is true.
  const [calendarDays, setCalendarDays] = useState<CalendarDay[]>([])
  const [calendarLoading, setCalendarLoading] = useState(false)
  const [calendarError, setCalendarError] = useState<string | null>(null)

  // Effective (possibly extended) end dates, keyed by term id (or the
  // session id itself when uses_terms=false) — computed live via
  // attendanceService.getEffectiveTermEndDate(), never stored. Recomputed
  // whenever calendarDays or terms change so an insert/delete of an
  // extends_term entry is reflected immediately, no page reload.
  const [effectiveEndDates, setEffectiveEndDates] = useState<Record<string, string>>({})

  // Single-date entry form
  const [showDayForm, setShowDayForm] = useState(false)
  const [editingDay, setEditingDay] = useState<CalendarDay | null>(null)
  const [dayDate, setDayDate] = useState('')
  const [dayType, setDayType] = useState<CalendarDayType>('holiday')
  const [dayLabel, setDayLabel] = useState('')
  const [dayExtends, setDayExtends] = useState(false)
  const [daySaving, setDaySaving] = useState(false)
  const [dayError, setDayError] = useState<string | null>(null)

  // Bulk date-range entry form
  const [showRangeForm, setShowRangeForm] = useState(false)
  const [rangeStart, setRangeStart] = useState('')
  const [rangeEnd, setRangeEnd] = useState('')
  const [rangeType, setRangeType] = useState<CalendarDayType>('break')
  const [rangeLabel, setRangeLabel] = useState('')
  const [rangeExtends, setRangeExtends] = useState(false)
  const [rangeSaving, setRangeSaving] = useState(false)
  const [rangeError, setRangeError] = useState<string | null>(null)

  const loadAll = useCallback(async () => {
    setLoading(true)
    setError(null)
    const [sRes, schRes] = await Promise.all([
      loadSessions(schoolId),
      loadSchoolSettings(schoolId),
    ])
    if (sRes.error) { setError(sRes.error); setLoading(false); return }
    setSessions(sRes.data)
    setUsesTerms(schRes.data?.uses_terms ?? true)
    if (sRes.data.length > 0 && !selectedSessionId) {
      const current = sRes.data.find(s => s.is_current) ?? sRes.data[0]
      setSelectedSessionId(current.id)
    }
    setLoading(false)
  }, [schoolId, selectedSessionId])

  useEffect(() => { loadAll() }, [loadAll])

  useEffect(() => {
    if (!selectedSessionId || !usesTerms) return
    setTermsLoading(true)
    loadTerms(schoolId, selectedSessionId).then(res => {
      setTerms(res.data)
      setTermsLoading(false)
    })
  }, [selectedSessionId, schoolId, usesTerms])

  const loadCalendar = useCallback(async () => {
    if (!selectedSessionId) return
    setCalendarLoading(true)
    setCalendarError(null)
    const res = await loadCalendarDays(schoolId, selectedSessionId)
    if (res.error) { setCalendarError(res.error); setCalendarLoading(false); return }
    setCalendarDays(res.data)
    setCalendarLoading(false)
  }, [schoolId, selectedSessionId])

  useEffect(() => { loadCalendar() }, [loadCalendar])

  // Recompute every relevant effective end date whenever the underlying
  // terms/session dates or the calendar entries change — this is what makes
  // an insert/delete of an extends_term day reflect immediately in the UI,
  // with zero risk of a stored value drifting (see getEffectiveTermEndDate's
  // own doc comment for why it's live-computed rather than stored).
  useEffect(() => {
    if (!selectedSessionId) return
    let cancelled = false

    async function recompute() {
      const currentSession = sessions.find(s => s.id === selectedSessionId)
      const entries: Record<string, string> = {}

      if (usesTerms) {
        for (const t of terms) {
          const res = await getEffectiveTermEndDate(t.start_date, t.end_date, schoolId)
          if (res.ok) entries[t.id] = res.data
        }
      } else if (currentSession) {
        const res = await getEffectiveTermEndDate(currentSession.start_date, currentSession.end_date, schoolId)
        if (res.ok) entries[currentSession.id] = res.data
      }

      if (!cancelled) setEffectiveEndDates(entries)
    }

    recompute()
    return () => { cancelled = true }
  }, [selectedSessionId, sessions, terms, usesTerms, calendarDays, schoolId])

  function openSessionForm(s?: Session) {
    setEditingSession(s ?? null)
    setSesName(s?.name ?? '')
    setSesStart(s?.start_date ?? '')
    setSesEnd(s?.end_date ?? '')
    setSesCurrent(s?.is_current ?? false)
    setSesError(null)
    setShowSessionForm(true)
  }

  async function handleSaveSession() {
    if (!sesName || !sesStart || !sesEnd) { setSesError('Name, start date, and end date are required.'); return }
    setSesSaving(true)
    const res = await upsertSession(schoolId, { id: editingSession?.id, name: sesName, start_date: sesStart, end_date: sesEnd, is_current: sesCurrent })
    if (res.error) { setSesError(res.error); setSesSaving(false); return }
    setShowSessionForm(false)
    loadAll()
    setSesSaving(false)
  }

  function openTermForm(t?: Term) {
    setEditingTerm(t ?? null)
    setTermName(t?.name ?? '')
    setTermSeq(t?.sequence ?? (terms.length + 1))
    setTermStart(t?.start_date ?? '')
    setTermEnd(t?.end_date ?? '')
    setTermError(null)
    setShowTermForm(true)
  }

  async function handleSaveTerm() {
    if (!termName || !termStart || !termEnd || !selectedSessionId) { setTermError('All fields are required.'); return }
    setTermSaving(true)
    const res = await upsertTerm(schoolId, { id: editingTerm?.id, session_id: selectedSessionId, name: termName, sequence: termSeq, start_date: termStart, end_date: termEnd })
    if (res.error) { setTermError(res.error); setTermSaving(false); return }
    setShowTermForm(false)
    if (selectedSessionId) {
      const r = await loadTerms(schoolId, selectedSessionId)
      setTerms(r.data)
    }
    setTermSaving(false)
  }

  function openDayForm(d?: CalendarDay) {
    setEditingDay(d ?? null)
    setDayDate(d?.calendar_date ?? '')
    setDayType(d?.day_type ?? 'holiday')
    setDayLabel(d?.label ?? '')
    setDayExtends(d?.extends_term ?? false)
    setDayError(null)
    setShowDayForm(true)
  }

  async function handleSaveDay() {
    if (!dayDate || !selectedSessionId) { setDayError('A date is required.'); return }
    setDaySaving(true)
    const res = await upsertCalendarDay(schoolId, selectedSessionId, {
      id: editingDay?.id,
      calendar_date: dayDate,
      day_type: dayType,
      label: dayLabel || null,
      extends_term: dayExtends,
    })
    if (res.error) { setDayError(res.error); setDaySaving(false); return }
    setShowDayForm(false)
    setDaySaving(false)
    loadCalendar()
  }

  function openRangeForm() {
    setRangeStart('')
    setRangeEnd('')
    setRangeType('break')
    setRangeLabel('')
    setRangeExtends(false)
    setRangeError(null)
    setShowRangeForm(true)
  }

  async function handleSaveRange() {
    if (!rangeStart || !rangeEnd || !selectedSessionId) { setRangeError('Start and end dates are required.'); return }
    if (rangeStart > rangeEnd) { setRangeError('Start date must be on or before end date.'); return }
    setRangeSaving(true)
    const res = await bulkUpsertCalendarDays(schoolId, selectedSessionId, {
      start_date: rangeStart,
      end_date: rangeEnd,
      day_type: rangeType,
      label: rangeLabel || null,
      extends_term: rangeExtends,
    })
    if (res.error) { setRangeError(res.error); setRangeSaving(false); return }
    setShowRangeForm(false)
    setRangeSaving(false)
    loadCalendar()
  }

  async function handleDeleteDay(id: string) {
    await deleteCalendarDay(schoolId, id)
    loadCalendar()
  }

  if (loading) return <Skeleton />
  if (error) return <ErrorState message={error} onRetry={loadAll} />

  return (
    <div className="set-tab-content">
      <div className="set-section-header">
        <SectionLabel>Academic sessions</SectionLabel>
        <button className="set-add-btn" onClick={() => openSessionForm()}>+ Add session</button>
      </div>

      {sessions.length === 0
        ? <p className="set-empty-hint">No sessions yet. Add your first one.</p>
        : sessions.map(s => (
          <div key={s.id} className={`set-list-row${s.is_current ? ' set-list-row--current' : ''}`}>
            <div className="set-list-row-info">
              <p className="set-list-row-name">{s.name}</p>
              <p className="set-list-row-meta">
                {s.start_date} → {s.end_date}
                {!usesTerms && effectiveEndDates[s.id] && effectiveEndDates[s.id] !== s.end_date && (
                  <span className="set-extended-date"> (extended to {effectiveEndDates[s.id]})</span>
                )}
              </p>
            </div>
            <div className="set-list-row-actions">
              {s.is_current && <span className="set-current-chip">Current</span>}
              <button className="set-edit-btn" onClick={() => openSessionForm(s)}>Edit</button>
            </div>
          </div>
        ))
      }

      {usesTerms && sessions.length > 0 && (
        <>
          <div className="set-section-header set-section-header--spaced">
            <SectionLabel>Terms in session</SectionLabel>
            <div className="set-section-controls">
              <select className="set-select set-select--sm" value={selectedSessionId ?? ''} onChange={e => setSelectedSessionId(e.target.value)}>
                {sessions.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <button className="set-add-btn" onClick={() => openTermForm()}>+ Add term</button>
            </div>
          </div>

          {termsLoading
            ? <Skeleton lines={3} />
            : terms.length === 0
              ? <p className="set-empty-hint">No terms for this session. Add the 1st, 2nd, 3rd terms etc.</p>
              : terms.map(t => (
                <div key={t.id} className="set-list-row">
                  <div className="set-list-row-info">
                    <p className="set-list-row-name">{t.name}</p>
                    <p className="set-list-row-meta">
                      {t.start_date} → {t.end_date}
                      {effectiveEndDates[t.id] && effectiveEndDates[t.id] !== t.end_date && (
                        <span className="set-extended-date"> (extended to {effectiveEndDates[t.id]})</span>
                      )}
                    </p>
                  </div>
                  <button className="set-edit-btn" onClick={() => openTermForm(t)}>Edit</button>
                </div>
              ))
          }
        </>
      )}

      {/* Session form sheet */}
      {showSessionForm && (
        <div className="set-overlay" onClick={() => setShowSessionForm(false)}>
          <div className="set-sheet" onClick={e => e.stopPropagation()}>
            <h2 className="set-sheet-title">{editingSession ? 'Edit session' : 'Add session'}</h2>
            <FieldRow label="Name"><Input value={sesName} onChange={setSesName} placeholder="e.g. 2025/2026 Session" /></FieldRow>
            <FieldRow label="Start date"><Input value={sesStart} onChange={setSesStart} type="date" /></FieldRow>
            <FieldRow label="End date"><Input value={sesEnd} onChange={setSesEnd} type="date" /></FieldRow>
            <Toggle checked={sesCurrent} onChange={setSesCurrent} label="Mark as current session" />
            {sesError && <p className="set-form-error">{sesError}</p>}
            <div className="set-sheet-footer">
              <button className="set-cancel-btn" onClick={() => setShowSessionForm(false)}>Cancel</button>
              <button className="set-save-btn" onClick={handleSaveSession} disabled={sesSaving}>{sesSaving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Term form sheet */}
      {showTermForm && (
        <div className="set-overlay" onClick={() => setShowTermForm(false)}>
          <div className="set-sheet" onClick={e => e.stopPropagation()}>
            <h2 className="set-sheet-title">{editingTerm ? 'Edit term' : 'Add term'}</h2>
            <FieldRow label="Name"><Input value={termName} onChange={setTermName} placeholder="e.g. First Term" /></FieldRow>
            <FieldRow label="Sequence">
              <select className="set-select" value={termSeq} onChange={e => setTermSeq(Number(e.target.value))}>
                {[1, 2, 3, 4, 5, 6].map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </FieldRow>
            <FieldRow label="Start date"><Input value={termStart} onChange={setTermStart} type="date" /></FieldRow>
            <FieldRow label="End date"><Input value={termEnd} onChange={setTermEnd} type="date" /></FieldRow>
            {termError && <p className="set-form-error">{termError}</p>}
            <div className="set-sheet-footer">
              <button className="set-cancel-btn" onClick={() => setShowTermForm(false)}>Cancel</button>
              <button className="set-save-btn" onClick={handleSaveTerm} disabled={termSaving}>{termSaving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}

      {/* School calendar — holidays / exam days / breaks (Session 18/29) */}
      {selectedSessionId && (
        <>
          <div className="set-section-header set-section-header--spaced">
            <SectionLabel>School calendar</SectionLabel>
            <div className="set-section-controls">
              <button className="set-add-btn" onClick={() => openDayForm()}>+ Add date</button>
              <button className="set-add-btn" onClick={openRangeForm}>+ Add range</button>
            </div>
          </div>
          <p className="set-hint-text">
            Mark specific dates as holidays, exam days, or breaks. Turn on "Extend term end date"
            for entries that should push the term's effective end date out — a single stray public
            holiday usually shouldn't, but a planned multi-week break usually should.
          </p>

          {calendarLoading
            ? <Skeleton lines={3} />
            : calendarError
              ? <ErrorState message={calendarError} onRetry={loadCalendar} />
              : calendarDays.length === 0
                ? <p className="set-empty-hint">No calendar entries for this session yet.</p>
                : calendarDays.map(d => (
                  <div key={d.id} className="set-list-row">
                    <div className="set-list-row-info">
                      <p className="set-list-row-name">
                        {d.calendar_date}
                        <span className={`set-daytype-chip set-daytype-chip--${d.day_type}`}>{d.day_type.replace('_', ' ')}</span>
                        {d.extends_term && <span className="set-extends-chip">extends term</span>}
                      </p>
                      {d.label && <p className="set-list-row-meta">{d.label}</p>}
                    </div>
                    <div className="set-list-row-actions">
                      <button className="set-edit-btn" onClick={() => openDayForm(d)}>Edit</button>
                      <button className="set-delete-btn" onClick={() => handleDeleteDay(d.id)}>Delete</button>
                    </div>
                  </div>
                ))
          }
        </>
      )}

      {/* Single-date entry form sheet */}
      {showDayForm && (
        <div className="set-overlay" onClick={() => setShowDayForm(false)}>
          <div className="set-sheet" onClick={e => e.stopPropagation()}>
            <h2 className="set-sheet-title">{editingDay ? 'Edit calendar entry' : 'Add calendar entry'}</h2>
            <FieldRow label="Date"><Input value={dayDate} onChange={setDayDate} type="date" /></FieldRow>
            <FieldRow label="Type">
              <select className="set-select" value={dayType} onChange={e => setDayType(e.target.value as CalendarDayType)}>
                <option value="holiday">Holiday</option>
                <option value="exam_day">Exam day</option>
                <option value="break">Break</option>
                <option value="school_day">School day (override a normally non-school weekday)</option>
              </select>
            </FieldRow>
            <FieldRow label="Label (optional)">
              <Input value={dayLabel} onChange={setDayLabel} placeholder="e.g. Eid al-Fitr" />
            </FieldRow>
            {dayType !== 'school_day' && (
              <Toggle
                checked={dayExtends}
                onChange={setDayExtends}
                label="Extend term/session end date by this day"
              />
            )}
            {dayError && <p className="set-form-error">{dayError}</p>}
            <div className="set-sheet-footer">
              <button className="set-cancel-btn" onClick={() => setShowDayForm(false)}>Cancel</button>
              <button className="set-save-btn" onClick={handleSaveDay} disabled={daySaving}>{daySaving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk date-range entry form sheet */}
      {showRangeForm && (
        <div className="set-overlay" onClick={() => setShowRangeForm(false)}>
          <div className="set-sheet" onClick={e => e.stopPropagation()}>
            <h2 className="set-sheet-title">Add date range</h2>
            <FieldRow label="Start date"><Input value={rangeStart} onChange={setRangeStart} type="date" /></FieldRow>
            <FieldRow label="End date"><Input value={rangeEnd} onChange={setRangeEnd} type="date" /></FieldRow>
            <FieldRow label="Type">
              <select className="set-select" value={rangeType} onChange={e => setRangeType(e.target.value as CalendarDayType)}>
                <option value="holiday">Holiday</option>
                <option value="exam_day">Exam day</option>
                <option value="break">Break</option>
                <option value="school_day">School day (override a normally non-school weekday)</option>
              </select>
            </FieldRow>
            <FieldRow label="Label (optional)">
              <Input value={rangeLabel} onChange={setRangeLabel} placeholder="e.g. Mid-term break" />
            </FieldRow>
            {rangeType !== 'school_day' && (
              <Toggle
                checked={rangeExtends}
                onChange={setRangeExtends}
                label="Extend term/session end date for every school day in this range"
              />
            )}
            <p className="set-hint-text">
              Only the dates in this range that would otherwise have been real school days count
              toward any extension — marking an already-off Saturday doesn't add an extra day.
            </p>
            {rangeError && <p className="set-form-error">{rangeError}</p>}
            <div className="set-sheet-footer">
              <button className="set-cancel-btn" onClick={() => setShowRangeForm(false)}>Cancel</button>
              <button className="set-save-btn" onClick={handleSaveRange} disabled={rangeSaving}>{rangeSaving ? 'Saving…' : 'Save range'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Tab: Schedule ────────────────────────────────────────────────────────────

function ScheduleTab({ schoolId }: { schoolId: string }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [weekDays, setWeekDays] = useState<number[]>([])
  const [periods, setPeriods] = useState<Period[]>([])

  const [daysSaving, setDaysSaving] = useState(false)
  const [daysSaved, setDaysSaved] = useState(false)
  const [daysError, setDaysError] = useState<string | null>(null)

  const [showPeriodForm, setShowPeriodForm] = useState(false)
  const [editingPeriod, setEditingPeriod] = useState<Period | null>(null)
  const [pLabel, setPLabel] = useState('')
  const [pStart, setPStart] = useState('')
  const [pEnd, setPEnd] = useState('')
  const [pBreak, setPBreak] = useState(false)
  const [pSortOrder, setPSortOrder] = useState(0)
  const [pSaving, setPSaving] = useState(false)
  const [pError, setPError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const [wRes, pRes] = await Promise.all([
      loadWeekDays(schoolId),
      loadPeriods(schoolId),
    ])
    if (wRes.error || pRes.error) { setError(wRes.error ?? pRes.error); setLoading(false); return }
    setWeekDays(wRes.data.map(d => d.day_of_week))
    setPeriods(pRes.data)
    setLoading(false)
  }, [schoolId])

  useEffect(() => { load() }, [load])

  function toggleDay(day: number) {
    setWeekDays(prev => prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day].sort())
  }

  async function handleSaveDays() {
    setDaysSaving(true)
    setDaysError(null)
    const res = await saveWeekDays(schoolId, weekDays)
    if (res.error) setDaysError(res.error)
    else { setDaysSaved(true); setTimeout(() => setDaysSaved(false), 3000) }
    setDaysSaving(false)
  }

  function openPeriodForm(p?: Period) {
    setEditingPeriod(p ?? null)
    setPLabel(p?.label ?? '')
    setPStart(p?.start_time ?? '')
    setPEnd(p?.end_time ?? '')
    setPBreak(p?.is_break ?? false)
    setPSortOrder(p?.sort_order ?? periods.length)
    setPError(null)
    setShowPeriodForm(true)
  }

  async function handleSavePeriod() {
    if (!pLabel || !pStart || !pEnd) { setPError('Label, start time, and end time are required.'); return }
    setPSaving(true)
    const res = await upsertPeriod(schoolId, { id: editingPeriod?.id, label: pLabel, start_time: pStart, end_time: pEnd, is_break: pBreak, sort_order: pSortOrder })
    if (res.error) { setPError(res.error); setPSaving(false); return }
    setShowPeriodForm(false)
    const r = await loadPeriods(schoolId)
    setPeriods(r.data)
    setPSaving(false)
  }

  async function handleDeletePeriod(id: string) {
    if (!confirm('Remove this period? This may affect timetable entries.')) return
    const res = await deletePeriod(schoolId, id)
    if (res.error) { alert(res.error); return }
    setPeriods(prev => prev.filter(p => p.id !== id))
  }

  if (loading) return <Skeleton />
  if (error) return <ErrorState message={error} onRetry={load} />

  return (
    <div className="set-tab-content">
      <SectionLabel>School week</SectionLabel>
      <div className="set-day-chips">
        {[0, 1, 2, 3, 4, 5, 6].map(d => (
          <button
            key={d}
            className={`set-day-chip${weekDays.includes(d) ? ' set-day-chip--on' : ''}`}
            onClick={() => toggleDay(d)}
            type="button"
          >
            {DAY_NAMES[d]}
          </button>
        ))}
      </div>
      <div className="set-save-bar set-save-bar--inline">
        {daysError && <p className="set-save-error">{daysError}</p>}
        {daysSaved && <p className="set-save-ok">✓ Saved</p>}
        <button className="set-save-btn" onClick={handleSaveDays} disabled={daysSaving}>{daysSaving ? 'Saving…' : 'Save week days'}</button>
      </div>

      <div className="set-section-header set-section-header--spaced">
        <SectionLabel>Periods</SectionLabel>
        <button className="set-add-btn" onClick={() => openPeriodForm()}>+ Add period</button>
      </div>

      {periods.length === 0
        ? <p className="set-empty-hint">No periods set up yet.</p>
        : periods.map(p => (
          <div key={p.id} className="set-list-row">
            <div className="set-list-row-info">
              <p className="set-list-row-name">
                {p.label}
                {p.is_break && <span className="set-break-chip">Break</span>}
              </p>
              <p className="set-list-row-meta">{p.start_time} – {p.end_time}</p>
            </div>
            <div className="set-list-row-actions">
              <button className="set-edit-btn" onClick={() => openPeriodForm(p)}>Edit</button>
              <button className="set-delete-btn" onClick={() => handleDeletePeriod(p.id)}>✕</button>
            </div>
          </div>
        ))
      }

      {showPeriodForm && (
        <div className="set-overlay" onClick={() => setShowPeriodForm(false)}>
          <div className="set-sheet" onClick={e => e.stopPropagation()}>
            <h2 className="set-sheet-title">{editingPeriod ? 'Edit period' : 'Add period'}</h2>
            <FieldRow label="Label"><Input value={pLabel} onChange={setPLabel} placeholder="e.g. Period 1, Assembly, Lunch break" /></FieldRow>
            <FieldRow label="Start time"><Input value={pStart} onChange={setPStart} type="time" /></FieldRow>
            <FieldRow label="End time"><Input value={pEnd} onChange={setPEnd} type="time" /></FieldRow>
            <FieldRow label="Sort order"><Input value={String(pSortOrder)} onChange={v => setPSortOrder(Number(v))} type="number" /></FieldRow>
            <Toggle checked={pBreak} onChange={setPBreak} label="This is a break (no lessons scheduled)" />
            {pError && <p className="set-form-error">{pError}</p>}
            <div className="set-sheet-footer">
              <button className="set-cancel-btn" onClick={() => setShowPeriodForm(false)}>Cancel</button>
              <button className="set-save-btn" onClick={handleSavePeriod} disabled={pSaving}>{pSaving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Tab: Classes ─────────────────────────────────────────────────────────────

function ClassesTab({ schoolId }: { schoolId: string }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [flatNodes, setFlatNodes] = useState<ClassNode[]>([])
  const [tree, setTree] = useState<ClassNode[]>([])

  const [showForm, setShowForm] = useState(false)
  const [editingNode, setEditingNode] = useState<ClassNode | null>(null)
  const [nName, setNName] = useState('')
  const [nParent, setNParent] = useState<string | null>(null)
  const [nNodeType, setNNodeType] = useState('')
  const [nSortOrder, setNSortOrder] = useState(0)
  const [nLeaf, setNLeaf] = useState(false)
  const [nSaving, setNSaving] = useState(false)
  const [nError, setNError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const res = await loadClassNodes(schoolId)
    if (res.error) { setError(res.error); setLoading(false); return }
    setFlatNodes(res.data)
    setTree(buildClassTree(res.data))
    setLoading(false)
  }, [schoolId])

  useEffect(() => { load() }, [load])

  function openForm(node?: ClassNode, parentId?: string) {
    setEditingNode(node ?? null)
    setNName(node?.name ?? '')
    setNParent(node?.parent_id ?? parentId ?? null)
    setNNodeType(node?.node_type ?? '')
    setNSortOrder(node?.sort_order ?? 0)
    setNLeaf(node?.is_leaf_enrollable ?? false)
    setNError(null)
    setShowForm(true)
  }

  async function handleSave() {
    if (!nName) { setNError('Name is required.'); return }
    setNSaving(true)
    const res = await upsertClassNode(schoolId, {
      id: editingNode?.id,
      parent_id: nParent,
      name: nName,
      node_type: nNodeType || null,
      sort_order: nSortOrder,
      is_leaf_enrollable: nLeaf,
    })
    if (res.error) { setNError(res.error); setNSaving(false); return }
    setShowForm(false)
    load()
    setNSaving(false)
  }

  function renderNode(node: ClassNode, depth: number): React.ReactNode {
    return (
      <div key={node.id} className="set-class-node" style={{ marginLeft: depth * 16 }}>
        <div className="set-class-node-row">
          <div className="set-class-node-info">
            <span className="set-class-node-name">{node.name}</span>
            {node.is_leaf_enrollable && <span className="set-leaf-chip">Enrollable</span>}
            {node.node_type && <span className="set-type-chip">{node.node_type}</span>}
          </div>
          <div className="set-list-row-actions">
            <button className="set-edit-btn" onClick={() => openForm(node)}>Edit</button>
            <button className="set-add-sub-btn" onClick={() => openForm(undefined, node.id)}>+ Child</button>
          </div>
        </div>
        {(node.children ?? []).map(c => renderNode(c, depth + 1))}
      </div>
    )
  }

  if (loading) return <Skeleton />
  if (error) return <ErrorState message={error} onRetry={load} />

  return (
    <div className="set-tab-content">
      <div className="set-section-header">
        <SectionLabel>Class hierarchy</SectionLabel>
        <button className="set-add-btn" onClick={() => openForm()}>+ Add class</button>
      </div>
      <p className="set-hint-text">Build your class tree: levels, classes, arms, streams. Leaf nodes (marked Enrollable) are where students are assigned.</p>

      {tree.length === 0
        ? <p className="set-empty-hint">No classes yet. Add your first one.</p>
        : tree.map(n => renderNode(n, 0))
      }

      {showForm && (
        <div className="set-overlay" onClick={() => setShowForm(false)}>
          <div className="set-sheet" onClick={e => e.stopPropagation()}>
            <h2 className="set-sheet-title">{editingNode ? 'Edit class' : 'Add class'}</h2>
            <FieldRow label="Name"><Input value={nName} onChange={setNName} placeholder="e.g. JSS 1A, Primary 4, Year 2" /></FieldRow>
            <FieldRow label="Parent class (optional)">
              <select className="set-select" value={nParent ?? ''} onChange={e => setNParent(e.target.value || null)}>
                <option value="">— Top level (no parent) —</option>
                {flatNodes.filter(n => n.id !== editingNode?.id).map(n => (
                  <option key={n.id} value={n.id}>{n.name}</option>
                ))}
              </select>
            </FieldRow>
            <FieldRow label="Type label (optional)">
              <Input value={nNodeType} onChange={setNNodeType} placeholder="e.g. level, class, arm, stream" />
            </FieldRow>
            <FieldRow label="Sort order"><Input value={String(nSortOrder)} onChange={v => setNSortOrder(Number(v))} type="number" /></FieldRow>
            <Toggle checked={nLeaf} onChange={setNLeaf} label="Students can be enrolled in this class (leaf node)" />
            {nError && <p className="set-form-error">{nError}</p>}
            <div className="set-sheet-footer">
              <button className="set-cancel-btn" onClick={() => setShowForm(false)}>Cancel</button>
              <button className="set-save-btn" onClick={handleSave} disabled={nSaving}>{nSaving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Tab: Subjects ────────────────────────────────────────────────────────────

function SubjectsTab({ schoolId }: { schoolId: string }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [subjects, setSubjects] = useState<Subject[]>([])

  const [showForm, setShowForm] = useState(false)
  const [editingSubject, setEditingSubject] = useState<Subject | null>(null)
  const [sName, setSName] = useState('')
  const [sCode, setSCode] = useState('')
  const [sSaving, setSSaving] = useState(false)
  const [sError, setSError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const res = await loadSubjects(schoolId)
    if (res.error) { setError(res.error); setLoading(false); return }
    setSubjects(res.data)
    setLoading(false)
  }, [schoolId])

  useEffect(() => { load() }, [load])

  function openForm(s?: Subject) {
    setEditingSubject(s ?? null)
    setSName(s?.name ?? '')
    setSCode(s?.code ?? '')
    setSError(null)
    setShowForm(true)
  }

  async function handleSave() {
    if (!sName) { setSError('Subject name is required.'); return }
    setSSaving(true)
    const res = await upsertSubject(schoolId, { id: editingSubject?.id, name: sName, code: sCode || null })
    if (res.error) { setSError(res.error); setSSaving(false); return }
    setShowForm(false)
    load()
    setSSaving(false)
  }

  if (loading) return <Skeleton />
  if (error) return <ErrorState message={error} onRetry={load} />

  return (
    <div className="set-tab-content">
      <div className="set-section-header">
        <SectionLabel>Subjects</SectionLabel>
        <button className="set-add-btn" onClick={() => openForm()}>+ Add subject</button>
      </div>

      {subjects.length === 0
        ? <p className="set-empty-hint">No subjects yet. Add Mathematics, English Language, etc.</p>
        : subjects.map(s => (
          <div key={s.id} className="set-list-row">
            <div className="set-list-row-info">
              <p className="set-list-row-name">{s.name}</p>
              {s.code && <p className="set-list-row-meta">Code: {s.code}</p>}
            </div>
            <button className="set-edit-btn" onClick={() => openForm(s)}>Edit</button>
          </div>
        ))
      }

      {showForm && (
        <div className="set-overlay" onClick={() => setShowForm(false)}>
          <div className="set-sheet" onClick={e => e.stopPropagation()}>
            <h2 className="set-sheet-title">{editingSubject ? 'Edit subject' : 'Add subject'}</h2>
            <FieldRow label="Name"><Input value={sName} onChange={setSName} placeholder="e.g. Mathematics, Qur'an Studies" /></FieldRow>
            <FieldRow label="Code (optional)"><Input value={sCode} onChange={setSCode} placeholder="e.g. MTH, ENG, BIO" /></FieldRow>
            {sError && <p className="set-form-error">{sError}</p>}
            <div className="set-sheet-footer">
              <button className="set-cancel-btn" onClick={() => setShowForm(false)}>Cancel</button>
              <button className="set-save-btn" onClick={handleSave} disabled={sSaving}>{sSaving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Tab: Roles ───────────────────────────────────────────────────────────────

function RolesTab({ schoolId }: { schoolId: string }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [roles, setRoles] = useState<Role[]>([])
  const [catalog, setCatalog] = useState<Permission[]>([])

  const [showForm, setShowForm] = useState(false)
  const [editingRole, setEditingRole] = useState<Role | null>(null)
  const [rName, setRName] = useState('')
  const [rAdmin, setRAdmin] = useState(false)
  const [rPerms, setRPerms] = useState<string[]>([])
  const [rSaving, setRSaving] = useState(false)
  const [rError, setRError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const [rRes, cRes] = await Promise.all([loadRoles(schoolId), loadPermissionsCatalog()])
    if (rRes.error) { setError(rRes.error); setLoading(false); return }
    setRoles(rRes.data)
    setCatalog(cRes.data)
    setLoading(false)
  }, [schoolId])

  useEffect(() => { load() }, [load])

  function openForm(r?: Role) {
    setEditingRole(r ?? null)
    setRName(r?.name ?? '')
    setRAdmin(r?.is_admin_role ?? false)
    setRPerms(r?.permissions ?? [])
    setRError(null)
    setShowForm(true)
  }

  function togglePerm(key: string) {
    setRPerms(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key])
  }

  async function handleSave() {
    if (!rName) { setRError('Role name is required.'); return }
    setRSaving(true)
    const res = await saveRole(schoolId, { id: editingRole?.id, name: rName, is_admin_role: rAdmin, permissions: rPerms })
    if (res.error) { setRError(res.error); setRSaving(false); return }
    setShowForm(false)
    load()
    setRSaving(false)
  }

  async function handleDelete(roleId: string, name: string) {
    if (!confirm(`Delete the "${name}" role? This will remove it from all staff who hold it.`)) return
    setDeleting(roleId)
    const res = await deleteRole(schoolId, roleId)
    if (res.error) { alert(res.error); setDeleting(null); return }
    setRoles(prev => prev.filter(r => r.id !== roleId))
    setDeleting(null)
  }

  // Group permissions by module
  const byModule: Record<string, Permission[]> = {}
  catalog.forEach(p => {
    if (!byModule[p.module]) byModule[p.module] = []
    byModule[p.module].push(p)
  })

  if (loading) return <Skeleton />
  if (error) return <ErrorState message={error} onRetry={load} />

  return (
    <div className="set-tab-content">
      <div className="set-section-header">
        <SectionLabel>Roles</SectionLabel>
        <button className="set-add-btn" onClick={() => openForm()}>+ Add role</button>
      </div>

      {roles.length === 0
        ? <p className="set-empty-hint">No roles yet. Create roles like "Class Teacher", "Bursar", "Headmaster".</p>
        : roles.map(r => (
          <div key={r.id} className="set-list-row">
            <div className="set-list-row-info">
              <p className="set-list-row-name">
                {r.name}
                {r.is_admin_role && <span className="set-admin-chip">Admin</span>}
              </p>
              <p className="set-list-row-meta">
                {r.is_admin_role
                  ? 'Full admin access — bypasses individual permissions'
                  : `${r.permissions.length} permission${r.permissions.length !== 1 ? 's' : ''}`}
              </p>
            </div>
            <div className="set-list-row-actions">
              <button className="set-edit-btn" onClick={() => openForm(r)}>Edit</button>
              <button className="set-delete-btn" onClick={() => handleDelete(r.id, r.name)} disabled={deleting === r.id}>
                {deleting === r.id ? '…' : '✕'}
              </button>
            </div>
          </div>
        ))
      }

      {showForm && (
        <div className="set-overlay" onClick={() => setShowForm(false)}>
          <div className="set-sheet set-sheet--tall" onClick={e => e.stopPropagation()}>
            <h2 className="set-sheet-title">{editingRole ? 'Edit role' : 'Add role'}</h2>
            <FieldRow label="Role name"><Input value={rName} onChange={setRName} placeholder="e.g. Class Teacher, Bursar, Headmaster" /></FieldRow>
            <Toggle checked={rAdmin} onChange={setRAdmin} label="This role grants full admin access" />

            <p className="set-section-label set-section-label--mt">Permissions</p>
            <div className="set-perm-list">
              {Object.entries(byModule).map(([mod, perms]) => (
                <div key={mod} className="set-perm-module">
                  <p className="set-perm-module-name">{mod}</p>
                  {perms.map(p => (
                    <label key={p.key} className="set-perm-row">
                      <input
                        type="checkbox"
                        className="set-perm-check"
                        checked={rPerms.includes(p.key)}
                        onChange={() => togglePerm(p.key)}
                      />
                      <div>
                        <span className="set-perm-desc">{p.description}</span>
                      </div>
                    </label>
                  ))}
                </div>
              ))}
            </div>

            {rError && <p className="set-form-error">{rError}</p>}
            <div className="set-sheet-footer">
              <button className="set-cancel-btn" onClick={() => setShowForm(false)}>Cancel</button>
              <button className="set-save-btn" onClick={handleSave} disabled={rSaving}>{rSaving ? 'Saving…' : 'Save role'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Tab: Student roles (Session 13, PRD Problem 5.5) ─────────────────────────
// Definitional side only, same split as roles/RolesTab vs staff-assignment-
// in-HR: the per-student assign/unassign UI lives in StudentsModule.tsx's
// Edit subtab instead, reached from a student's own record — this tab is
// scoped to "does this role exist and what's its class scope," nothing else.

function StudentRolesTab({ schoolId }: { schoolId: string }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [roles, setRoles] = useState<StudentRole[]>([])
  const [classes, setClasses] = useState<ClassNode[]>([])

  const [showForm, setShowForm] = useState(false)
  const [editingRole, setEditingRole] = useState<StudentRole | null>(null)
  const [rName, setRName] = useState('')
  // Explicit three-state choice, not a bare optional dropdown — PRD step 2
  // requires the school-wide/class-scoped decision be unmissable, not a
  // buried default. null = not yet chosen; the save button is disabled
  // until the admin actively picks one, even though "school-wide" ends up
  // being the same stored value (class_id: null) either way.
  const [rScope, setRScope] = useState<'school-wide' | 'class' | null>(null)
  const [rClassId, setRClassId] = useState<string | null>(null)
  const [rSaving, setRSaving] = useState(false)
  const [rError, setRError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const [rRes, cRes] = await Promise.all([loadStudentRoles(schoolId), loadClassNodes(schoolId)])
    if (rRes.error) { setError(rRes.error); setLoading(false); return }
    setRoles(rRes.data)
    // Leaf classes only — a student role scoped to a non-leaf (grouping)
    // node would never match any actual student's class_node_id, since
    // students are only ever enrolled at leaf nodes (§7.8).
    setClasses((cRes.data ?? []).filter(c => c.is_leaf_enrollable))
    setLoading(false)
  }, [schoolId])

  useEffect(() => { load() }, [load])

  function classLabel(classId: string): string {
    const node = classes.find(c => c.id === classId)
    return node?.name ?? 'Unknown class'
  }

  function openForm(r?: StudentRole) {
    setEditingRole(r ?? null)
    setRName(r?.name ?? '')
    if (r) {
      setRScope(r.class_id ? 'class' : 'school-wide')
      setRClassId(r.class_id)
    } else {
      setRScope(null)
      setRClassId(null)
    }
    setRError(null)
    setShowForm(true)
  }

  async function handleSave() {
    if (!rName) { setRError('Role name is required.'); return }
    if (!rScope) { setRError('Choose school-wide or a specific class.'); return }
    if (rScope === 'class' && !rClassId) { setRError('Pick which class this role belongs to.'); return }

    setRSaving(true)
    const res = await saveStudentRole(schoolId, {
      id: editingRole?.id,
      name: rName,
      class_id: rScope === 'class' ? rClassId : null,
    })
    if (res.error) { setRError(res.error); setRSaving(false); return }
    setShowForm(false)
    load()
    setRSaving(false)
  }

  async function handleDelete(roleId: string, name: string) {
    if (!confirm(`Delete the "${name}" role? This will remove it from every student who holds it.`)) return
    setDeleting(roleId)
    const res = await deleteStudentRole(schoolId, roleId)
    if (res.error) { alert(res.error); setDeleting(null); return }
    setRoles(prev => prev.filter(r => r.id !== roleId))
    setDeleting(null)
  }

  if (loading) return <Skeleton />
  if (error) return <ErrorState message={error} onRetry={load} />

  return (
    <div className="set-tab-content">
      <div className="set-section-header">
        <SectionLabel>Student roles</SectionLabel>
        <button className="set-add-btn" onClick={() => openForm()}>+ Add role</button>
      </div>

      {roles.length === 0
        ? <p className="set-empty-hint">No student roles yet. Create roles like "Class Rep" or "Head Boy" — descriptive tags, not permissions.</p>
        : roles.map(r => (
          <div key={r.id} className="set-list-row">
            <div className="set-list-row-info">
              <p className="set-list-row-name">{r.name}</p>
              <p className="set-list-row-meta">
                {r.class_id ? `Scoped to ${classLabel(r.class_id)}` : 'School-wide'}
              </p>
            </div>
            <div className="set-list-row-actions">
              <button className="set-edit-btn" onClick={() => openForm(r)}>Edit</button>
              <button className="set-delete-btn" onClick={() => handleDelete(r.id, r.name)} disabled={deleting === r.id}>
                {deleting === r.id ? '…' : '✕'}
              </button>
            </div>
          </div>
        ))
      }

      {showForm && (
        <div className="set-overlay" onClick={() => setShowForm(false)}>
          <div className="set-sheet" onClick={e => e.stopPropagation()}>
            <h2 className="set-sheet-title">{editingRole ? 'Edit student role' : 'Add student role'}</h2>
            <FieldRow label="Role name"><Input value={rName} onChange={setRName} placeholder="e.g. Class Rep, Head Boy" /></FieldRow>

            <p className="set-section-label set-section-label--mt">Scope</p>
            <div className="set-scope-choice" role="radiogroup" aria-label="Role scope">
              <label className="set-scope-option">
                <input
                  type="radio"
                  name="student-role-scope"
                  checked={rScope === 'school-wide'}
                  onChange={() => { setRScope('school-wide'); setRClassId(null) }}
                />
                <span>School-wide — any student can hold this role</span>
              </label>
              <label className="set-scope-option">
                <input
                  type="radio"
                  name="student-role-scope"
                  checked={rScope === 'class'}
                  onChange={() => setRScope('class')}
                />
                <span>One specific class only</span>
              </label>
            </div>

            {rScope === 'class' && (
              <FieldRow label="Class">
                <select className="set-select" value={rClassId ?? ''} onChange={e => setRClassId(e.target.value || null)}>
                  <option value="">Select a class…</option>
                  {classes.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </FieldRow>
            )}

            {rError && <p className="set-form-error">{rError}</p>}
            <div className="set-sheet-footer">
              <button className="set-cancel-btn" onClick={() => setShowForm(false)}>Cancel</button>
              <button className="set-save-btn" onClick={handleSave} disabled={rSaving}>{rSaving ? 'Saving…' : 'Save role'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Tab: Staff ───────────────────────────────────────────────────────────────

function StaffTab({ schoolId }: { schoolId: string }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [staff, setStaff] = useState<StaffListItem[]>([])
  const [query, setQuery] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const res = await loadStaffWithRoles(schoolId)
    if (res.error) { setError(res.error); setLoading(false); return }
    setStaff(res.data)
    setLoading(false)
  }, [schoolId])

  useEffect(() => { load() }, [load])

  const filtered = staff.filter(s =>
    !query || s.full_name.toLowerCase().includes(query.toLowerCase()) || (s.email ?? '').toLowerCase().includes(query.toLowerCase())
  )

  if (loading) return <Skeleton />
  if (error) return <ErrorState message={error} onRetry={load} />

  return (
    <div className="set-tab-content">
      <SectionLabel>Staff members</SectionLabel>
      <p className="set-hint-text">To edit staff details or manage salaries and leave, use the HR module. This view shows roles and login status.</p>
      <input
        type="text"
        className="set-input set-search-input"
        placeholder="Search staff…"
        value={query}
        onChange={e => setQuery(e.target.value)}
      />

      {filtered.length === 0
        ? <p className="set-empty-hint">{query ? 'No staff match your search.' : 'No staff added yet. Add staff in the HR module.'}</p>
        : filtered.map(s => (
          <div key={s.id} className="set-list-row">
            <div className="set-staff-avatar">{s.full_name.charAt(0).toUpperCase()}</div>
            <div className="set-list-row-info">
              <p className="set-list-row-name">
                {s.full_name}
                <span className={`set-status-chip set-status-chip--${s.status}`}>{s.status}</span>
              </p>
              <p className="set-list-row-meta">
                {s.email ?? s.phone ?? '—'}
                {s.roles.length > 0 && ` · ${s.roles.join(', ')}`}
              </p>
            </div>
          </div>
        ))
      }
    </div>
  )
}

// ─── Tab: Audit log ───────────────────────────────────────────────────────────

function AuditTab({ schoolId }: { schoolId: string }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [count, setCount] = useState(0)
  const [tableNames, setTableNames] = useState<string[]>([])
  const [filterTable, setFilterTable] = useState('')
  const [filterAction, setFilterAction] = useState<'' | 'INSERT' | 'UPDATE' | 'DELETE'>('')
  const [page, setPage] = useState(0)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const PAGE_SIZE = 25

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const [res, tables] = await Promise.all([
      loadAuditLog(schoolId, {
        table_name: filterTable || undefined,
        action: filterAction || undefined,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }),
      tableNames.length === 0 ? loadAuditTableNames(schoolId) : Promise.resolve(tableNames),
    ])
    if (res.error) { setError(res.error); setLoading(false); return }
    setEntries(res.data)
    setCount(res.count)
    if (Array.isArray(tables)) setTableNames(tables)
    setLoading(false)
  }, [schoolId, filterTable, filterAction, page, tableNames])

  useEffect(() => { load() }, [load])

  function formatTs(ts: string) {
    return new Date(ts).toLocaleString('en-NG', { dateStyle: 'short', timeStyle: 'short' })
  }

  const actionColor: Record<string, string> = { INSERT: 'set-action--insert', UPDATE: 'set-action--update', DELETE: 'set-action--delete' }

  if (loading) return <Skeleton lines={6} />
  if (error) return <ErrorState message={error} onRetry={load} />

  return (
    <div className="set-tab-content">
      <SectionLabel>Audit log</SectionLabel>
      <p className="set-hint-text">Every change to sensitive data is logged here. Records can never be edited or deleted.</p>

      {/* Filters */}
      <div className="set-audit-filters">
        <select className="set-select set-select--sm" value={filterTable} onChange={e => { setFilterTable(e.target.value); setPage(0) }}>
          <option value="">All tables</option>
          {tableNames.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <select className="set-select set-select--sm" value={filterAction} onChange={e => { setFilterAction(e.target.value as '' | 'INSERT' | 'UPDATE' | 'DELETE'); setPage(0) }}>
          <option value="">All actions</option>
          <option value="INSERT">INSERT</option>
          <option value="UPDATE">UPDATE</option>
          <option value="DELETE">DELETE</option>
        </select>
        <p className="set-audit-count">{count} record{count !== 1 ? 's' : ''}</p>
      </div>

      {entries.length === 0
        ? <p className="set-empty-hint">No audit records match the current filters.</p>
        : entries.map(e => (
          <div key={e.id} className="set-audit-row">
            <button className="set-audit-row-btn" onClick={() => setExpandedId(expandedId === e.id ? null : e.id)}>
              <span className={`set-action-badge ${actionColor[e.action] ?? ''}`}>{e.action}</span>
              <span className="set-audit-table">{e.table_name}</span>
              <span className="set-audit-actor">{e.actor_type ?? '—'}</span>
              <span className="set-audit-time">{formatTs(e.created_at)}</span>
              <span className="set-audit-chevron">{expandedId === e.id ? '▲' : '▼'}</span>
            </button>
            {expandedId === e.id && (
              <div className="set-audit-detail">
                <p className="set-audit-record-id">Record: {e.record_id}</p>
                {e.old_data && (
                  <div className="set-audit-data-block">
                    <p className="set-audit-data-label">Before</p>
                    <pre className="set-audit-pre">{JSON.stringify(e.old_data, null, 2)}</pre>
                  </div>
                )}
                {e.new_data && (
                  <div className="set-audit-data-block">
                    <p className="set-audit-data-label">After</p>
                    <pre className="set-audit-pre">{JSON.stringify(e.new_data, null, 2)}</pre>
                  </div>
                )}
              </div>
            )}
          </div>
        ))
      }

      {/* Pagination */}
      {count > PAGE_SIZE && (
        <div className="set-pagination">
          <button className="set-page-btn" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}>← Prev</button>
          <span className="set-page-label">Page {page + 1} of {Math.ceil(count / PAGE_SIZE)}</span>
          <button className="set-page-btn" onClick={() => setPage(p => p + 1)} disabled={(page + 1) * PAGE_SIZE >= count}>Next →</button>
        </div>
      )}
    </div>
  )
}
