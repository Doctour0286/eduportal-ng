/**
 * SettingsModule.tsx
 * Admin settings panel — Phase 6, final module.
 *
 * Tabs:
 *   School      — branding (name, logo, theme), language, public config (welcome msg, contacts)
 *   Sessions    — sessions + terms (when uses_terms=true); flag to toggle uses_terms
 *               (relabeled from "Calendar" — Session 18/6.7 — to avoid confusion with
 *               the specific-date holiday/exam/break entries now living in Schedule,
 *               below; internal tab id is left as 'calendar' to avoid touching every
 *               reference to it, only the visible label changed)
 *   Schedule    — school week days (collapsed by default — owner request, since most
 *               modules depend on it and it should not be casually toggled) + periods
 *               (add/edit/delete/reorder) + holidays & special days (Session 18: single-
 *               date and bulk-range entry into school_calendar_days, each entry optionally
 *               marked to extend the containing term/session's effective end date —
 *               see getEffectiveTermEndDate() in attendanceService.ts, Problem 6.7's
 *               extension logic, folded into this session at the owner's request rather
 *               than deferred to Session 29, which now only needs to build the visual
 *               TermProgressCard on top of this already-working computation)
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
import { applyBrandTheme, type ThemeMode } from '../services/themeService'
import { Icon } from '../components/icons'
import {
  loadSchoolSettings,       updateSchoolSettings,
  loadPublicConfig,         savePublicConfig, uploadWelcomePostImage, uploadSchoolLogo,
  loadHomepagePosts,        createHomepagePost, updateHomepagePost,
  deleteHomepagePost,       reorderHomepagePosts,
  loadSessions,             upsertSession,
  loadTerms,                upsertTerm,
  loadWeekDays,             saveWeekDays,
  loadPeriods,              upsertPeriod,   deletePeriod,
  loadCalendarDays,         upsertCalendarDay, bulkUpsertCalendarDays, deleteCalendarDay,
  loadSubjects,             upsertSubject,
  loadPermissionsCatalog,   loadRoles,      saveRole,   deleteRole,
  loadStaffWithRoles,
  loadAuditLog,             loadAuditTableNames,
  buildClassTree,           loadClassNodes, upsertClassNode,
  loadStudentRoles,         saveStudentRole, deleteStudentRole,
  loadFaculties,            upsertFaculty,
  loadDepartments,          upsertDepartment,
  loadProgrammes,           upsertProgramme,
  loadProgrammeLevels,      upsertProgrammeLevel,
  searchStudents,           loadCurrentSession,
  loadPlacementsForProgramme, upsertPlacement,
  loadMatricNumberFormat,   saveMatricNumberFormat,
  admitStudent,
  loadCourses,              upsertCourse,
  loadCurriculum,           addCurriculumEntry, removeCurriculumEntry,
  loadHigherEdGradeScale,   upsertHigherEdGradeBand, deleteHigherEdGradeBand,
  loadCgpaPolicy,           upsertCgpaPolicy,
  loadAcademicStandingRules, upsertAcademicStandingRules,
  runStandingEvaluation, loadPendingStandingEvents, reviewStandingEvent,
  loadCourseOfferings,      upsertCourseOffering, deleteCourseOffering,
  type SchoolSettings,
  type SchoolPublicConfig,
  type WelcomePost,
  type WelcomePostBlock,
  type WelcomePostTextBlock,
  type WelcomePostTextRun,
  type WelcomePostTextLevel,
  type HomepagePost,
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
  type Faculty,
  type Department,
  type Programme,
  type ProgrammeLevel,
  type StudentSearchResult,
  type StudentProgrammePlacement,
  type MatricNumberComponent,
  type MatricNumberFormat,
  type AdmitStudentResult,
  type Course,
  type CurriculumEntry,
  type GradeScaleBand,
  type CgpaPolicy,
  type AcademicStandingRules,
  type StandingEvaluationResult,
  type StandingEvent,
  type CourseOffering,
} from '../services/settingsService'
import {
  // SESSION 60a: course_result_components' CRUD lives in
  // courseResultsService.ts, not settingsService.ts — deliberately NOT
  // duplicated here. That file already owns this table's read path for
  // CourseResultsModule.tsx's lecturer-facing scoring grid, and its
  // upsert/delete functions are already scoped correctly against the
  // real admin-only RLS policy (migration_session_60a.sql,
  // academics.course_result_components.manage). This is a genuine, new
  // cross-service import for this file (admin UI reusing a function from
  // the higher-ed lecturer-domain service) rather than the copy-into-
  // settingsService.ts pattern every other higher-ed admin feature so far
  // has followed (loadHigherEdGradeScale, loadCgpaPolicy, etc., all of
  // which duplicate a courseResultsService.ts read for the settings UI's
  // own use) — done this way specifically because course_result_components
  // has no lecturer-facing write counterpart to keep separate from (unlike
  // grade_scales/cgpa_policy, which both have a courseResultsService.ts
  // read AND a settingsService.ts write); there is only ever one write
  // path for this table, so one function set is correct, not two.
  loadCourseResultComponents, upsertCourseResultComponent, deleteCourseResultComponent,
  type CourseResultComponent,
  // SESSION 60c: per-course overrides are FOLDED into course_result_
  // components via a nullable course_id (migration_session_60c.sql) — the
  // original separate course_result_component_overrides table was
  // abandoned before any code shipped against it (see that migration's
  // header: course_result_component_scores can only FK to
  // course_result_components(id), so an override in its own table/id-space
  // could never be scored against). loadCourseSpecificComponents() reads
  // this course's own rows (course_id = courseId); resolveCourseResultComponents()
  // + mergeCourseResultComponents() produce the merged/effective set for
  // preview, using the SAME merge function finalizeWeightedCourseResult()
  // uses server-side, so the two can never disagree.
  loadCourseSpecificComponents, resolveCourseResultComponents, mergeCourseResultComponents,
  type ResolvedCourseResultComponent,
} from '../services/courseResultsService'
// SESSION 65 (PRD Problem 8.7a, items 1/7) — a genuine, new cross-service
// import for the same reason as courseResultsService's own above: the
// admission flow's "create" branch needs studentsService.ts's real
// createStudent() (school-scoped insert, friendlyError()-mapped) rather than
// a second, duplicated insert written directly against `students` here.
import { createStudent, type StudentUpsertParams } from '../services/studentsService'

// Same fixed union as onboardingService.ts's InstitutionCategory — kept in
// sync manually since this file doesn't import from onboardingService.ts
// (settingsService.ts is this module's own data-access layer, per its own
// header comment's scope). If this union changes, update both files and
// record it in master-plan §12, per §3.16's amendment.
const HIGHER_INSTITUTION_SCHOOL_TYPES = ['university', 'polytechnic', 'college_of_education', 'other']
function isHigherInstitutionSchoolType(schoolType: string | null | undefined): boolean {
  return !!schoolType && HIGHER_INSTITUTION_SCHOOL_TYPES.includes(schoolType)
}

// All values the onboarding wizard's institution-category picker can write
// (HIGHER_INSTITUTION_SCHOOL_TYPES plus 'secondary'). Once school_type holds
// one of these, it was set via the wizard's saveInstitutionCategory, not
// hand-typed — SchoolTab locks the field at that point instead of allowing
// free-text edits that could silently overwrite a valid category with an
// arbitrary string (this is what caused the wizard-looks-unchanged bug for
// existing schools; see SESSION 55 follow-up). A school that has never gone
// through the wizard still gets the old free-text input, unchanged.
const RECOGNIZED_SCHOOL_TYPES = ['secondary', ...HIGHER_INSTITUTION_SCHOOL_TYPES]
function isRecognizedSchoolType(schoolType: string | null | undefined): boolean {
  return !!schoolType && RECOGNIZED_SCHOOL_TYPES.includes(schoolType)
}

const SCHOOL_TYPE_DISPLAY_LABELS: Record<string, string> = {
  secondary: 'Secondary / Basic school',
  university: 'University',
  polytechnic: 'Polytechnic / Monotechnic',
  college_of_education: 'College of Education',
  other: 'Other higher institution',
}

// ─── Tab definition ───────────────────────────────────────────────────────────

type SettingsTab = 'school' | 'homepage' | 'calendar' | 'schedule' | 'classes' | 'institution' | 'curriculum' | 'offerings' | 'grading' | 'standing' | 'subjects' | 'roles' | 'student-roles' | 'staff' | 'audit'

// Institution tab is hidden entirely when school_type is not a
// higher-institution type — per SESSION 55 §0 instruction 5 — so TABS is
// built conditionally rather than filtered by a render-time boolean check
// on every tab bar render.
function buildTabs(schoolType: string | null | undefined): { id: SettingsTab; label: string; icon: React.ReactNode }[] {
  const isHigherEd = isHigherInstitutionSchoolType(schoolType)
  const tabs: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
    { id: 'school',        label: 'School',        icon: <Icon name="school" size={18} /> },
    { id: 'homepage',      label: 'Homepage',      icon: <Icon name="globe" size={18} /> },
    { id: 'calendar',      label: 'Sessions',      icon: <Icon name="calendar" size={18} /> },
    { id: 'schedule',      label: 'Schedule',      icon: <Icon name="clock" size={18} /> },
  ]
  if (isHigherEd) {
    tabs.push({ id: 'institution', label: 'Institution', icon: <Icon name="graduation-cap" size={18} /> })
    // Curriculum depends on a real programme/level structure existing
    // (PRD SESSION 56, depends on SESSION 55) — shown alongside Institution
    // for the same higher-ed-only reason, not gated further, since an empty
    // structure just means the tab's pickers have nothing to select yet
    // (same "fine, just nothing to show" pattern as Faculties being optional).
    tabs.push({ id: 'curriculum', label: 'Curriculum', icon: <Icon name="book-open" size={18} /> })
    // Course offerings (unscheduled interim step before SESSION 60, PRD Tier
    // 8 / Problem 8.7 — closes the gap SESSION 58's close-out surfaced: "no
    // course_offerings creation UI exists anywhere"). Sits between
    // Curriculum and Grading — an offering ("this course, this session/
    // term, this lecturer") is the real per-session object that
    // registration and attendance both key off, distinct from the
    // catalogue (courses) and the requirement structure (curriculum).
    tabs.push({ id: 'offerings', label: 'Offerings', icon: <Icon name="users" size={18} /> })
    // Grade scale + CGPA policy (PRD Tier 8 / Problem 8.7, SESSION 59,
    // §7.27.4). Higher-ed-only for the same reason Institution/Curriculum
    // are: grade_scales rows here are the higher-ed shape (scale_max/
    // grade_point populated), and cgpa_policy has no secondary-school
    // meaning at all. A secondary school's own grading (CA/exam bands) is
    // configured elsewhere (Results module), not through this tab.
    tabs.push({ id: 'grading', label: 'Grading', icon: <Icon name="clipboard-list" size={18} /> })
    // Academic standing (PRD Tier 8 / Problem 8.7, SESSION 61, §7.27.5).
    // Higher-ed-only for the same reason Grading is: academic_standing_rules
    // is keyed off CGPA, which only exists for higher-ed schools (cgpa_policy
    // has no secondary-school meaning). Distinct concern from Grading itself
    // — this configures the review-trigger thresholds, not how a score
    // becomes a grade — so it gets its own tab rather than folding into
    // Grading's already-large form, consistent with Offerings earning its
    // own tab rather than being crammed into Curriculum.
    tabs.push({ id: 'standing', label: 'Standing', icon: <Icon name="alert-triangle" size={18} /> })
  } else {
    tabs.push({ id: 'classes', label: 'Classes', icon: <Icon name="tag" size={18} /> })
  }
  tabs.push(
    { id: 'subjects',      label: 'Subjects',      icon: <Icon name="book-open" size={18} /> },
    { id: 'roles',         label: 'Roles',         icon: <Icon name="key" size={18} /> },
    { id: 'student-roles', label: 'Student roles', icon: <Icon name="graduation-cap" size={18} /> },
    { id: 'staff',         label: 'Staff',         icon: <Icon name="users" size={18} /> },
    { id: 'audit',         label: 'Audit log',     icon: <Icon name="clipboard-list" size={18} /> },
  )
  return tabs
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// ─── Root component ───────────────────────────────────────────────────────────

export default function SettingsModule({ schoolId, isAdmin, themeMode, schoolType, actorRecordId }: { schoolId: string; isAdmin: boolean; themeMode: ThemeMode; schoolType?: string | null; actorRecordId?: string | null }) {
  // themeMode is only consumed by SchoolTab (the brand-color picker), but
  // is accepted here and passed down since this is the module's entry
  // point — matches the pattern App.tsx already uses for other props
  // that only one sub-tab actually needs (e.g. schoolId itself).
  //
  // schoolType (new, SESSION 55): needed here purely to decide which tab
  // — Classes or Institution — appears in TABS, per §0 instruction 5
  // ("hidden entirely when school_type is not a higher-institution type").
  // This is the app-level UI branch reading school_type; the §3.16
  // amendment's own recorded exception is App.tsx's academic-engine
  // selection, not this tab-visibility check — both are legitimate reads
  // of the same column for different reasons, but flagged here so a future
  // contributor doesn't count this as a second violation of §3.16's "never
  // branch on it again" rule. App.tsx must pass its already-fetched
  // schoolType through to this component's props; it does not fetch its
  // own copy here.
  const [activeTab, setActiveTab] = useState<SettingsTab>('school')
  const tabs = buildTabs(schoolType)

  if (!isAdmin) return null

  // If the active tab was 'classes'/'institution' and school_type changes
  // out from under it (shouldn't normally happen mid-session, but defends
  // against a stale tab reference), fall back to 'school' rather than
  // rendering a tab no longer in the list.
  const safeActiveTab = tabs.some(t => t.id === activeTab) ? activeTab : 'school'

  return (
    <div className="set-root">
      <div className="set-header">
        <h1 className="set-title">Settings</h1>
        <p className="set-subtitle">Configure your school's details and modules</p>
      </div>

      {/* Horizontal scrollable tab bar */}
      <div className="set-tabs" role="tablist">
        {tabs.map(t => (
          <button
            key={t.id}
            role="tab"
            aria-selected={safeActiveTab === t.id}
            className={`set-tab${safeActiveTab === t.id ? ' set-tab--active' : ''}`}
            onClick={() => setActiveTab(t.id)}
          >
            <span className="set-tab-icon">{t.icon}</span>
            <span className="set-tab-label">{t.label}</span>
          </button>
        ))}
      </div>

      <div className="set-body">
        {safeActiveTab === 'school'      && <SchoolTab      schoolId={schoolId} themeMode={themeMode} />}
        {safeActiveTab === 'homepage'    && <HomepageTab    schoolId={schoolId} />}
        {safeActiveTab === 'calendar'    && <CalendarTab    schoolId={schoolId} />}
        {safeActiveTab === 'schedule'    && <ScheduleTab    schoolId={schoolId} />}
        {safeActiveTab === 'classes'     && <ClassesTab     schoolId={schoolId} />}
        {safeActiveTab === 'institution' && <InstitutionTab schoolId={schoolId} />}
        {safeActiveTab === 'curriculum'  && <CurriculumTab  schoolId={schoolId} />}
        {safeActiveTab === 'offerings'    && <OfferingsTab    schoolId={schoolId} />}
        {safeActiveTab === 'grading'      && <GradingTab      schoolId={schoolId} />}
        {safeActiveTab === 'standing'     && <StandingTab     schoolId={schoolId} actorRecordId={actorRecordId ?? null} />}
        {safeActiveTab === 'subjects'     && <SubjectsTab     schoolId={schoolId} />}
        {safeActiveTab === 'roles'         && <RolesTab        schoolId={schoolId} />}
        {safeActiveTab === 'student-roles' && <StudentRolesTab schoolId={schoolId} />}
        {safeActiveTab === 'staff'         && <StaffTab        schoolId={schoolId} />}
        {safeActiveTab === 'audit'         && <AuditTab        schoolId={schoolId} />}
      </div>
    </div>
  )
}

// ─── Shared helper components ─────────────────────────────────────────────────

function SaveBar({ saving, saved, error, onSave }: { saving: boolean; saved: boolean; error: string | null; onSave: () => void }) {
  return (
    <div className="set-save-bar">
      {error && <p className="set-save-error">{error}</p>}
      {saved && !error && <p className="set-save-ok"><Icon name="circle-check" size={16} style={{ color: 'var(--color-success, #16a34a)' }} /> Saved</p>}
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

// Debounced value — used by the student search picker below (§7.27.1a).
// Small and local rather than a new file: this is the only place in the
// module that needs debounce, since every other tab's search (e.g. StaffTab)
// filters an already-loaded, small, in-memory list instead of querying per
// keystroke.
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(t)
  }, [value, delayMs])
  return debounced
}

// SESSION 65 — local date-string helper for the new-student admission form's
// default admission_date, matching studentsService.ts's own todayDateString()
// (local YYYY-MM-DD, no window/navigator dependency, React Native safe)
// rather than importing a function this file didn't otherwise need.
function todayDateStringSettings(): string {
  const d = new Date()
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
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
      <span className="set-error-icon"><Icon name="alert-triangle" style={{ color: 'var(--color-warning, #d97706)' }} /></span>
      <p className="set-error-msg">{message}</p>
      <button className="set-retry-btn" onClick={onRetry}>Retry</button>
    </div>
  )
}

// ─── Welcome post helpers ───────────────────────────────────────────────────

/**
 * Returns null (not an empty post) when there's genuinely nothing to
 * save — an empty heading and zero blocks — so a school that never
 * touches this editor doesn't get a hollow welcome_post row written,
 * and PublicHomepage.tsx's own null-check / legacy-message-fallback
 * branch keeps working exactly as documented.
 */
/** Trims every run's text in a text block and drops any run left empty;
 *  a text block with zero non-empty runs left is dropped entirely. Image
 *  blocks pass through untouched. */
function cleanBlocks(blocks: WelcomePostBlock[]): WelcomePostBlock[] {
  return blocks
    .map(b => b.type === 'text' ? { ...b, runs: b.runs.map(r => ({ ...r, text: r.text.trim() })).filter(r => r.text.length > 0) } : b)
    .filter(b => b.type === 'image' || b.runs.length > 0)
}

function buildWelcomePost(heading: string, blocks: WelcomePostBlock[]): WelcomePost | null {
  const trimmedHeading = heading.trim()
  const cb = cleanBlocks(blocks)
  if (!trimmedHeading && cb.length === 0) return null
  return { heading: trimmedHeading, blocks: cb }
}

// ─── Homepage posts editor (owner request, 2026-07-11 follow-up #2) ───────
// Several ordered, independently expandable posts — a real one-to-many
// list (school_homepage_posts), distinct from the single welcome_post
// editor above. Each post gets the same paragraph/image block editor
// pattern as the welcome post (deliberately not a separate component —
// see PostBlockFields below, shared by both), plus its own heading and
// an "always expanded" toggle: on, the public page never truncates this
// post regardless of length; off (the default for every new post), the
// public page collapses it past a fixed height with a "Continue
// reading…" control — matching PublicHomepage.tsx's own
// HomepagePostCard default (isExpanded starts false, always_expanded
// starts false on create below).
//
// Each row is its own local draft with its own save — posts are
// independent rows in a separate table, not one form-wide blob, so a
// half-finished edit to post #2 shouldn't block saving a brand-new
// post #3. This deliberately does NOT share SchoolTab's single
// SaveBar/handleSave — that button only ever wrote school_public_config
// and schools, this list writes school_homepage_posts via its own CRUD
// (loadHomepagePosts/createHomepagePost/updateHomepagePost/
// deleteHomepagePost/reorderHomepagePosts, all already built in
// settingsService.ts but never wired to any UI until now).

interface PostDraft {
  id: string | null // null = new, unsaved post
  heading: string
  blocks: WelcomePostBlock[]
  always_expanded: boolean
  sort_order: number
  saving: boolean
  error: string | null
  dirty: boolean
  created_at: string | null
  updated_at: string | null
  /** Gating (owner request, mistake-prevention): a post starts collapsed
   *  to a title-only row in the list. Clicking the title is the only way
   *  to reveal its editor/delete control — this deliberately keeps
   *  destructive actions (and accidental edits) behind one intentional
   *  extra tap, rather than every post's full editor + delete button
   *  sitting open and reachable at all times. */
  open: boolean
}

function homepagePostToDraft(p: HomepagePost): PostDraft {
  return {
    id: p.id,
    heading: p.heading,
    blocks: p.blocks,
    always_expanded: p.always_expanded,
    sort_order: p.sort_order,
    saving: false,
    error: null,
    dirty: false,
    created_at: p.created_at,
    updated_at: p.updated_at,
    open: false,
  }
}

const HEADING_LEVEL_OPTIONS: { value: WelcomePostTextLevel; label: string }[] = [
  { value: 'p',  label: 'Normal text' },
  { value: 'h2', label: 'Heading 2' },
  { value: 'h3', label: 'Heading 3' },
  { value: 'h4', label: 'Heading 4' },
]

/** A text block's editable content, flattened to one run for this plain-
 *  textarea editor (no cursor-selection engine exists here, so bold/
 *  italic are whole-block toggles rather than a mid-sentence selection —
 *  see PostBlockFields' own doc comment for the full reasoning). Reads
 *  the first run's flags/text; a block with multiple runs (possible if
 *  data is ever produced another way) is still readable — later runs'
 *  text is concatenated in, but its own individual bold/italic flags are
 *  not separately editable here. */
function firstRunOf(block: WelcomePostTextBlock): WelcomePostTextRun {
  return block.runs[0] ?? { text: '' }
}

function textOf(block: WelcomePostTextBlock): string {
  return block.runs.map(r => r.text).join('')
}

/** Shared paragraph/image block editor — identical UI/behavior to the
 *  welcome-post editor above, factored out so the two don't drift into
 *  two different block-editing experiences for the same underlying
 *  WelcomePostBlock shape. Text blocks (owner request, rich text
 *  upgrade): each gets a heading-level selector (Normal/H2/H3/H4 — H1 is
 *  deliberately not offered, matching this app's own documented
 *  heading-hierarchy reasoning) and Bold/Italic toggle buttons, applied
 *  to the block's whole line of text as a single run. */
function PostBlockFields({
  blocks,
  onChange,
  schoolId,
}: {
  blocks: WelcomePostBlock[]
  onChange: (blocks: WelcomePostBlock[]) => void
  schoolId: string
}) {
  const [imageUploading, setImageUploading] = useState(false)
  const [imageUploadError, setImageUploadError] = useState<string | null>(null)

  function addTextBlock() {
    onChange([...blocks, { type: 'text', level: 'p', runs: [{ text: '' }] }])
  }

  function updateTextBlock(index: number, patch: Partial<WelcomePostTextRun>) {
    onChange(blocks.map((b, i) => {
      if (i !== index || b.type !== 'text') return b
      const run = firstRunOf(b)
      return { ...b, runs: [{ ...run, ...patch }] }
    }))
  }

  function updateTextLevel(index: number, level: WelcomePostTextLevel) {
    onChange(blocks.map((b, i) => (i === index && b.type === 'text' ? { ...b, level } : b)))
  }

  function updateImageCaption(index: number, caption: string) {
    onChange(blocks.map((b, i) => (i === index && b.type === 'image' ? { ...b, caption } : b)))
  }

  function removeBlock(index: number) {
    onChange(blocks.filter((_, i) => i !== index))
  }

  function moveBlock(index: number, direction: -1 | 1) {
    const target = index + direction
    if (target < 0 || target >= blocks.length) return
    const next = [...blocks]
    ;[next[index], next[target]] = [next[target], next[index]]
    onChange(next)
  }

  async function handleImageFileSelected(file: File | undefined) {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setImageUploadError('Please choose an image file')
      return
    }
    setImageUploading(true)
    setImageUploadError(null)
    const { url, error } = await uploadWelcomePostImage(schoolId, file)
    setImageUploading(false)
    if (error || !url) {
      setImageUploadError(error ?? 'Could not upload image')
      return
    }
    onChange([...blocks, { type: 'image', url, caption: '' }])
  }

  return (
    <>
      <div className="set-post-blocks">
        {blocks.map((block, i) => (
          <div key={i} className="set-post-block">
            <div className="set-post-block-controls">
              <button type="button" className="set-post-block-move" onClick={() => moveBlock(i, -1)} disabled={i === 0} aria-label="Move up">
                ▲
              </button>
              <button type="button" className="set-post-block-move" onClick={() => moveBlock(i, 1)} disabled={i === blocks.length - 1} aria-label="Move down">
                ▼
              </button>
              <span className="set-post-block-type">{block.type === 'text' ? 'Text' : 'Image'}</span>
              <button type="button" className="set-post-block-remove" onClick={() => removeBlock(i)} aria-label="Remove block">
                ✕
              </button>
            </div>
            {block.type === 'text' ? (
              <>
                <div className="set-post-block-toolbar" role="toolbar" aria-label="Text formatting">
                  <select
                    className="set-post-level-select"
                    value={block.level}
                    onChange={e => updateTextLevel(i, e.target.value as WelcomePostTextLevel)}
                    aria-label="Heading level"
                  >
                    {HEADING_LEVEL_OPTIONS.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className={`set-post-format-btn ${firstRunOf(block).bold ? 'set-post-format-btn--active' : ''}`}
                    onClick={() => updateTextBlock(i, { bold: !firstRunOf(block).bold })}
                    aria-pressed={!!firstRunOf(block).bold}
                    aria-label="Bold"
                    title="Bold"
                  >
                    B
                  </button>
                  <button
                    type="button"
                    className={`set-post-format-btn set-post-format-btn--italic ${firstRunOf(block).italic ? 'set-post-format-btn--active' : ''}`}
                    onClick={() => updateTextBlock(i, { italic: !firstRunOf(block).italic })}
                    aria-pressed={!!firstRunOf(block).italic}
                    aria-label="Italic"
                    title="Italic"
                  >
                    I
                  </button>
                </div>
                <Textarea
                  value={textOf(block)}
                  onChange={t => updateTextBlock(i, { text: t })}
                  placeholder="Write a paragraph…"
                  rows={3}
                />
              </>
            ) : (
              <div className="set-post-image-block">
                <img src={block.url} alt="" className="set-post-image-preview" />
                <Input
                  value={block.caption ?? ''}
                  onChange={c => updateImageCaption(i, c)}
                  placeholder="Caption (optional)"
                />
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="set-post-add-row">
        <button type="button" className="set-post-add-btn" onClick={addTextBlock}>
          + Add text
        </button>
        <label className="set-post-add-btn set-post-add-btn--upload">
          {imageUploading ? 'Uploading…' : '+ Add image'}
          <input
            type="file"
            accept="image/*"
            className="set-post-image-input"
            disabled={imageUploading}
            onChange={e => { handleImageFileSelected(e.target.files?.[0]); e.target.value = '' }}
          />
        </label>
      </div>
      {imageUploadError && <p className="form-error" role="alert">{imageUploadError}</p>}
    </>
  )
}

/** Formats an ISO timestamp as a short, readable date for the list row
 *  ("Posted Jul 11, 2026" / "Updated Jul 11, 2026"). Falls back to the
 *  raw string if it doesn't parse, rather than throwing on odd data. */
function formatPostDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

/** New-post creation prompt (owner request): a post cannot be opened for
 *  editing or deletion until it has a title — so creation itself asks
 *  for the title first and calls createHomepagePost immediately, rather
 *  than inserting an empty, already-editable draft into the list. The
 *  moment the title is saved, the post exists as a real row and opens
 *  automatically into its full editor. */
function NewPostPrompt({
  onCreate,
  onCancel,
}: {
  onCreate: (title: string) => Promise<void>
  onCancel: () => void
}) {
  const [title, setTitle] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleCreate() {
    const trimmed = title.trim()
    if (!trimmed) {
      setError('Enter a title for the post')
      return
    }
    setSaving(true)
    setError(null)
    await onCreate(trimmed)
    setSaving(false)
  }

  return (
    <div className="set-homepage-post-new">
      <FieldRow label="Post title">
        <Input
          value={title}
          onChange={setTitle}
          placeholder="e.g. Resumption date for next term"
        />
      </FieldRow>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="set-homepage-post-new-actions">
        <button type="button" className="btn btn--primary" onClick={handleCreate} disabled={saving}>
          {saving ? 'Creating…' : 'Create post'}
        </button>
        <button type="button" className="btn btn--secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </div>
  )
}

/** Delete requires typing the post's own title back exactly, not just a
 *  window.confirm() dialog — owner-requested mistake-prevention, since a
 *  reflexive "OK" tap on a generic confirm is exactly how a real page
 *  gets deleted by accident. */
function DeletePostConfirm({
  heading,
  onConfirm,
  onCancel,
  deleting,
}: {
  heading: string
  onConfirm: () => void
  onCancel: () => void
  deleting: boolean
}) {
  const [typed, setTyped] = useState('')
  const matches = typed.trim() === heading.trim() && heading.trim().length > 0

  return (
    <div className="set-homepage-post-delete-confirm">
      <p className="set-homepage-post-delete-warning">
        This will permanently delete this post from the public page. Type the post's
        title to confirm: <strong>{heading || '(untitled post)'}</strong>
      </p>
      <Input value={typed} onChange={setTyped} placeholder="Type the title exactly" />
      <div className="set-homepage-post-delete-actions">
        <button
          type="button"
          className="btn btn--danger"
          onClick={onConfirm}
          disabled={!matches || deleting}
        >
          {deleting ? 'Deleting…' : 'Delete permanently'}
        </button>
        <button type="button" className="btn btn--secondary" onClick={onCancel} disabled={deleting}>
          Cancel
        </button>
      </div>
    </div>
  )
}

function HomepagePostsEditor({ schoolId }: { schoolId: string }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<PostDraft[]>([])
  const [reordering, setReordering] = useState(false)
  const [showNewPost, setShowNewPost] = useState(false)
  // id of the post currently showing its delete-confirm panel — kept
  // separate from `open` so confirming delete doesn't require the full
  // editor to also be open, and so only one post's delete-confirm shows
  // at a time.
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const { data, error } = await loadHomepagePosts(schoolId)
    if (error) { setError(error); setLoading(false); return }
    setDrafts(data.map(homepagePostToDraft))
    setLoading(false)
  }, [schoolId])

  useEffect(() => { load() }, [load])

  function updateDraft(index: number, patch: Partial<PostDraft>) {
    setDrafts(prev => prev.map((d, i) => (i === index ? { ...d, ...patch, dirty: true } : d)))
  }

  function toggleOpen(index: number) {
    setDrafts(prev => prev.map((d, i) => (i === index ? { ...d, open: !d.open } : d)))
  }

  async function handleCreatePost(title: string) {
    setError(null)
    const { data, error } = await createHomepagePost(schoolId, {
      heading: title,
      blocks: [],
      always_expanded: false,
      sort_order: drafts.length,
    })
    if (error || !data) {
      setError(error ?? 'Could not create post')
      return
    }
    // The new post exists now — open it immediately so the admin can add
    // content right away, matching "only once a title exists can the
    // post be edited," not a separate extra tap after creation.
    setDrafts(prev => [...prev, { ...homepagePostToDraft(data), open: true }])
    setShowNewPost(false)
  }

  async function savePost(index: number) {
    const draft = drafts[index]
    const cleanHeading = draft.heading.trim()
    if (!cleanHeading) {
      updateDraft(index, { error: 'A post needs a title.' })
      return
    }
    const cb = cleanBlocks(draft.blocks)

    setDrafts(prev => prev.map((d, i) => (i === index ? { ...d, saving: true, error: null } : d)))

    const { error } = await updateHomepagePost(draft.id as string, {
      heading: cleanHeading,
      blocks: cb,
      always_expanded: draft.always_expanded,
    })
    if (error) {
      setDrafts(prev => prev.map((d, i) => (i === index ? { ...d, saving: false, error } : d)))
      return
    }
    setDrafts(prev => prev.map((d, i) => (i === index ? { ...d, heading: cleanHeading, blocks: cb, saving: false, error: null, dirty: false, updated_at: new Date().toISOString() } : d)))
  }

  async function confirmDelete(index: number) {
    const draft = drafts[index]
    if (draft.id === null) return
    updateDraft(index, { saving: true })
    const { error } = await deleteHomepagePost(draft.id)
    if (error) {
      updateDraft(index, { saving: false, error })
      return
    }
    setDrafts(prev => prev.filter((_, i) => i !== index))
    setDeletingId(null)
  }

  async function movePost(index: number, direction: -1 | 1) {
    const target = index + direction
    if (target < 0 || target >= drafts.length) return
    const next = [...drafts]
    ;[next[index], next[target]] = [next[target], next[index]]
    setDrafts(next)

    const savedIds = next.filter(d => d.id !== null).map(d => d.id as string)
    if (savedIds.length < 2) return
    setReordering(true)
    await reorderHomepagePosts(savedIds)
    setReordering(false)
  }

  if (loading) return <Skeleton lines={4} />
  if (error && drafts.length === 0) return <ErrorState message={error} onRetry={load} />

  return (
    <div className="set-homepage-posts">
      {drafts.length === 0 && !showNewPost && (
        <p className="set-homepage-posts-empty">No posts yet. Add one below.</p>
      )}

      {drafts.map((draft, i) => (
        <div key={draft.id} className="set-homepage-post-card">
          {!draft.open ? (
            // ─── Collapsed row: title + dates only. This is the gate —
            // no edit or delete control exists here at all, only a way
            // to open the post (owner-requested mistake-prevention).
            <button
              type="button"
              className="set-homepage-post-row"
              onClick={() => toggleOpen(i)}
            >
              <div className="set-homepage-post-move-group" onClick={e => e.stopPropagation()}>
                <button type="button" className="set-post-block-move" onClick={() => movePost(i, -1)} disabled={i === 0 || reordering} aria-label="Move post up">
                  ▲
                </button>
                <button type="button" className="set-post-block-move" onClick={() => movePost(i, 1)} disabled={i === drafts.length - 1 || reordering} aria-label="Move post down">
                  ▼
                </button>
              </div>
              <div className="set-homepage-post-row-info">
                <span className="set-homepage-post-row-title">{draft.heading || '(untitled post)'}</span>
                <span className="set-homepage-post-row-meta">
                  Posted {formatPostDate(draft.created_at)} · Last updated {formatPostDate(draft.updated_at)}
                  {draft.always_expanded && ' · Always shown in full'}
                </span>
              </div>
              <span className="set-homepage-post-row-chevron" aria-hidden="true">
                <Icon name="chevron-down" size={18} />
              </span>
            </button>
          ) : (
            <>
              <div className="set-homepage-post-card-header">
                <span className="set-homepage-post-card-label">{draft.heading || '(untitled post)'}</span>
                <button type="button" className="set-post-block-remove" onClick={() => toggleOpen(i)} aria-label="Collapse post">
                  Close
                </button>
              </div>

              <FieldRow label="Heading">
                <Input
                  value={draft.heading}
                  onChange={h => updateDraft(i, { heading: h })}
                  placeholder="e.g. Resumption date for next term"
                />
              </FieldRow>

              <PostBlockFields
                blocks={draft.blocks}
                onChange={blocks => updateDraft(i, { blocks })}
                schoolId={schoolId}
              />

              <Toggle
                checked={draft.always_expanded}
                onChange={v => updateDraft(i, { always_expanded: v })}
                label="Always show in full (skip “Continue reading…” collapsing, regardless of length)"
              />

              <div className="set-homepage-post-card-footer">
                {draft.error && <p className="form-error" role="alert">{draft.error}</p>}
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => savePost(i)}
                  disabled={draft.saving || !draft.dirty}
                >
                  {draft.saving ? 'Saving…' : 'Save changes'}
                </button>
                {deletingId === draft.id ? null : (
                  <button
                    type="button"
                    className="set-homepage-post-delete-trigger"
                    onClick={() => setDeletingId(draft.id)}
                  >
                    Delete this post…
                  </button>
                )}
              </div>

              {deletingId === draft.id && (
                <DeletePostConfirm
                  heading={draft.heading}
                  deleting={draft.saving}
                  onConfirm={() => confirmDelete(i)}
                  onCancel={() => setDeletingId(null)}
                />
              )}
            </>
          )}
        </div>
      ))}

      {showNewPost ? (
        <NewPostPrompt onCreate={handleCreatePost} onCancel={() => setShowNewPost(false)} />
      ) : (
        <button type="button" className="set-post-add-btn set-homepage-post-add-btn" onClick={() => setShowNewPost(true)}>
          + Add another post
        </button>
      )}
    </div>
  )
}

// ─── Tab: Homepage ──────────────────────────────────────────────────────────
// Owner request: everything the public homepage renders (welcome post,
// several ordered posts, contact info, announcements toggle) now lives on
// its own tab, separate from School identity — previously all of this sat
// inside SchoolTab's single form, which made "School" a confusing mix of
// identity settings and public-page content, and buried destructive post
// actions in an always-open editor. This tab owns school_public_config's
// read/write directly (welcome_message round-trip, welcome_post, contact
// info, show_announcements) and mounts HomepagePostsEditor for the
// separate school_homepage_posts table.

function HomepageTab({ schoolId }: { schoolId: string }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [postHeading, setPostHeading] = useState('')
  const [postBlocks, setPostBlocks] = useState<WelcomePostBlock[]>([])
  const [legacyWelcomeMessage, setLegacyWelcomeMessage] = useState<string | null>(null)
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
    const pRes = await loadPublicConfig(schoolId)
    if (pRes.error) {
      setError(pRes.error)
      setLoading(false)
      return
    }
    const p: SchoolPublicConfig = pRes.data!
    if (p.welcome_post) {
      setPostHeading(p.welcome_post.heading ?? '')
      setPostBlocks(p.welcome_post.blocks ?? [])
    } else {
      setPostHeading('')
      setPostBlocks([])
    }
    setLegacyWelcomeMessage(p.welcome_post ? null : (p.welcome_message ?? null))
    setContactPhone((p.contact_info as { phone?: string })?.phone ?? '')
    setContactEmail((p.contact_info as { email?: string })?.email ?? '')
    setContactAddress((p.contact_info as { address?: string })?.address ?? '')
    setShowAnnouncements(p.show_announcements)
    setLoading(false)
  }, [schoolId])

  useEffect(() => { load() }, [load])

  function startPostFromLegacyMessage() {
    if (!legacyWelcomeMessage) return
    setPostBlocks(prev => [...prev, { type: 'text', level: 'p', runs: [{ text: legacyWelcomeMessage }] }])
    setLegacyWelcomeMessage(null)
  }

  async function handleSave() {
    setSaving(true)
    setSaveError(null)
    setSaved(false)

    const pRes = await savePublicConfig(schoolId, {
      // welcome_message is round-tripped from what was loaded, never
      // actively edited by this form — an existing plain-text message
      // must survive saves of the other fields on this tab (contact
      // info, announcements toggle) until a real welcome_post supersedes
      // it (see load()'s own branch, which nulls this out once a real
      // post exists).
      welcome_message: legacyWelcomeMessage,
      welcome_post: buildWelcomePost(postHeading, postBlocks),
      contact_info: {
        phone: contactPhone || undefined,
        email: contactEmail || undefined,
        address: contactAddress || undefined,
      },
      show_announcements: showAnnouncements,
    })

    if (pRes.error) {
      setSaveError(pRes.error)
    } else {
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    }
    setSaving(false)
  }

  if (loading) return <Skeleton lines={8} />
  if (error) return <ErrorState message={error} onRetry={load} />

  return (
    <div className="set-tab-content">
      <SectionLabel>Welcome message</SectionLabel>

      {legacyWelcomeMessage && (
        <div className="set-legacy-msg-banner">
          <p className="set-legacy-msg-text">
            You have an older plain-text welcome message: <em>“{legacyWelcomeMessage.slice(0, 120)}{legacyWelcomeMessage.length > 120 ? '…' : ''}”</em>
          </p>
          <button type="button" className="set-legacy-msg-btn" onClick={startPostFromLegacyMessage}>
            Start a post from it
          </button>
        </div>
      )}

      <FieldRow label="Post heading">
        <Input value={postHeading} onChange={setPostHeading} placeholder="e.g. Welcome to Dilimi Model School" />
      </FieldRow>

      <PostBlockFields blocks={postBlocks} onChange={setPostBlocks} schoolId={schoolId} />

      <SectionLabel>Homepage posts</SectionLabel>
      <p className="set-homepage-posts-hint">
        Several ordered posts shown below the welcome message on the public page.
        Each one collapses at a certain length with a “Continue reading…” link by
        default — toggle “Always show in full” per post to skip that. Click a
        post's title to open it — that's also the only way to edit or delete it.
      </p>
      <HomepagePostsEditor schoolId={schoolId} />

      <SectionLabel>Contact info</SectionLabel>
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

// ─── Tab: School ──────────────────────────────────────────────────────────────

function SchoolTab({ schoolId, themeMode }: { schoolId: string; themeMode: ThemeMode }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [_settings, setSettings] = useState<SchoolSettings | null>(null)

  // Form state
  const [name, setName] = useState('')
  const [schoolType, setSchoolType] = useState('')
  const [logoUrl, setLogoUrl] = useState('')
  const [themeColor, setThemeColor] = useState('#2563eb')
  const [defaultLang, setDefaultLang] = useState<'en' | 'ar' | 'ha'>('en')
  const [enabledLangs, setEnabledLangs] = useState<string[]>(['en'])
  const [usesTerms, setUsesTerms] = useState(true)
  const [usesLedger, setUsesLedger] = useState(false)

  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Logo upload — same loading/error state shape as the welcome-post
  // block editor's own image upload (imageUploading/imageUploadError),
  // kept local to this tab rather than shared, since this field lives
  // here while post images live in HomepageTab.
  const [logoUploading, setLogoUploading] = useState(false)
  const [logoUploadError, setLogoUploadError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const sRes = await loadSchoolSettings(schoolId)
    if (sRes.error) {
      setError(sRes.error)
      setLoading(false)
      return
    }
    const s = sRes.data!
    setSettings(s)
    setName(s.name)
    setSchoolType(s.school_type ?? '')
    setLogoUrl(s.logo_url ?? '')
    setThemeColor(s.theme_color ?? '#2563eb')
    setDefaultLang(s.default_lang)
    setEnabledLangs(s.enabled_langs ?? ['en'])
    setUsesTerms(s.uses_terms)
    setUsesLedger(s.uses_ledger)
    setLoading(false)

    // Re-apply the school's saved theme color on load, not just on save.
    // PRD Session 23 finding: nothing in the app previously applied
    // theme_color at boot — a page reload would silently show the
    // :root default (blue) until an admin happened to open Settings and
    // save again. This does not fully close that gap (App.tsx/
    // schoolStore.ts would need to call applyBrandTheme() as soon as the
    // school record loads, before Settings is ever opened, which needs
    // those files — not available in this session, flagged rather than
    // guessed at), but it does mean the moment an admin's own Settings
    // tab mounts, the full accessible scale — not just the one raw
    // property the old code set — is correctly re-derived and live.
    if (s.theme_color) applyBrandTheme(s.theme_color, themeMode)
  }, [schoolId, themeMode])

  useEffect(() => { load() }, [load])

  async function handleSave() {
    setSaving(true)
    setSaveError(null)
    setSaved(false)

    const sRes = await updateSchoolSettings(schoolId, {
      name, school_type: schoolType || null, logo_url: logoUrl || null,
      theme_color: themeColor, default_lang: defaultLang,
      enabled_langs: enabledLangs, uses_terms: usesTerms, uses_ledger: usesLedger,
    })

    if (sRes.error) {
      setSaveError(sRes.error)
    } else {
      setSaved(true)
      // Apply the full derived brand scale live (PRD Session 23) — the
      // prior code only set --color-brand-600 itself, which most of
      // index.css was never actually reading correctly (undeclared
      // token, inconsistent fallbacks — see themeService.ts's header
      // comment and §11 2026-07-08 for the full audit). applyBrandTheme
      // sets all nine brand tokens (50-800 + -on) in one call, derived
      // from this one picked color, so every consumer across the app
      // updates consistently instead of the old single-property write.
      if (themeColor) {
        const scale = applyBrandTheme(themeColor, themeMode)
        // Surfaced, not acted on: if the admin's exact pick was too
        // light/washed-out to hit 4.5:1 contrast as text/button color,
        // the WORKING brand-600 has been quietly darkened for
        // legibility — the picker itself still shows their original
        // hex (harmless, cosmetic-only difference) since themeColor
        // state is untouched. No UI copy exists yet to tell the admin
        // this happened; flagged here rather than inventing copy
        // without the owner's sign-off on the wording (see
        // BrandScale.wasAdjustedForContrast's own doc comment).
        if (scale.wasAdjustedForContrast) {
          // eslint-disable-next-line no-console
          console.warn(
            '[theme] Picked brand color was too light for readable text/buttons — ' +
            'automatically darkened for the working --color-brand-600. ' +
            'Original pick preserved in --color-brand-raw.'
          )
        }
      }
      setTimeout(() => setSaved(false), 3000)
    }
    setSaving(false)
  }

  function toggleLang(lang: string) {
    setEnabledLangs(prev =>
      prev.includes(lang) ? prev.filter(l => l !== lang) : [...prev, lang]
    )
  }

  // Fills logoUrl on a successful upload. Upload-only now (owner removed
  // the paste-a-link fallback) — logoUrl state still exists purely to
  // hold whatever the upload returns for preview/save; nothing downstream
  // (public homepage, login page, header chrome, App.tsx, student ID
  // cards) needs to change, since they all just read the resulting
  // string in logo_url regardless of how it got there.
  async function handleLogoFileSelected(file: File | undefined) {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setLogoUploadError('Please choose an image file')
      return
    }
    setLogoUploading(true)
    setLogoUploadError(null)
    const { url, error } = await uploadSchoolLogo(schoolId, file)
    setLogoUploading(false)
    if (error || !url) {
      setLogoUploadError(error ?? 'Could not upload logo')
      return
    }
    setLogoUrl(url)
  }

  if (loading) return <Skeleton lines={8} />
  if (error) return <ErrorState message={error} onRetry={load} />

  return (
    <div className="set-tab-content">
      <SectionLabel>School identity</SectionLabel>
      <FieldRow label="School name">
        <Input value={name} onChange={setName} placeholder="e.g. Dilimi Model School" />
      </FieldRow>
      <FieldRow label="School type">
        {isRecognizedSchoolType(schoolType) ? (
          <div className="set-readonly-field">
            <span className="set-readonly-value">
              {SCHOOL_TYPE_DISPLAY_LABELS[schoolType] ?? schoolType}
            </span>
            <p className="field-hint">
              Set during onboarding and can't be changed here. Contact support if this needs to change.
            </p>
          </div>
        ) : (
          <Input value={schoolType} onChange={setSchoolType} placeholder="e.g. Primary, Secondary, Madrasa" />
        )}
      </FieldRow>
      <FieldRow label="Logo">
        <div className="set-logo-upload-row">
          {logoUrl && <img src={logoUrl} alt="Logo preview" className="set-logo-preview" />}
          <label className="btn btn--secondary set-logo-upload-btn">
            <Icon name="image" size={16} />
            {logoUploading ? 'Uploading…' : logoUrl ? 'Replace logo' : 'Upload logo'}
            <input
              type="file"
              accept="image/*"
              className="set-logo-upload-input"
              disabled={logoUploading}
              onChange={e => handleLogoFileSelected(e.target.files?.[0])}
            />
          </label>
        </div>
        {logoUploadError && <p className="form-error" role="alert">{logoUploadError}</p>}
      </FieldRow>
      <FieldRow label="Theme colour">
        <div className="set-color-row">
          <input type="color" className="set-color-picker" value={themeColor} onChange={e => setThemeColor(e.target.value)} />
          <Input value={themeColor} onChange={setThemeColor} placeholder="#2563eb" />
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
              <p className="set-list-row-meta">{s.start_date} → {s.end_date}</p>
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
                    <p className="set-list-row-meta">{t.start_date} → {t.end_date}</p>
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
    </div>
  )
}

// ─── Tab: Schedule ────────────────────────────────────────────────────────────

function ScheduleTab({ schoolId }: { schoolId: string }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [weekDays, setWeekDays] = useState<number[]>([])
  const [periods, setPeriods] = useState<Period[]>([])

  // Collapsed by default per owner request (2026-07-04) — most other modules
  // depend on this setting (attendance's school-day logic, analytics
  // denominators, the new calendar-days extension math below), so it
  // shouldn't be one accidental tap away from changing. Always collapsed on
  // load regardless of whether days are already set, not just for new
  // schools — the owner's ask was "somewhat hidden to avoid mistakes," not
  // "hidden only until first configured."
  const [weekDaysOpen, setWeekDaysOpen] = useState(false)

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

  // Holidays & special days (school_calendar_days) — Session 18 / Problem 6.7.
  // Scoped to the current session, same as CalendarTab's own sessions/terms
  // (§3.6 — works whether or not uses_terms is true, since school_calendar_days
  // is session_id-scoped, not term_id-scoped).
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)
  const [calendarDays, setCalendarDays] = useState<CalendarDay[]>([])
  const [calLoading, setCalLoading] = useState(true)
  const [calError, setCalError] = useState<string | null>(null)

  const [calMode, setCalMode] = useState<'single' | 'bulk'>('single')
  const [showCalForm, setShowCalForm] = useState(false)
  const [editingCalDay, setEditingCalDay] = useState<CalendarDay | null>(null)
  const [calDate, setCalDate] = useState('')
  const [calEndDate, setCalEndDate] = useState('')
  const [calDayType, setCalDayType] = useState<CalendarDayType>('holiday')
  const [calLabel, setCalLabel] = useState('')
  const [calExtends, setCalExtends] = useState(false)
  const [calSaving, setCalSaving] = useState(false)
  const [calFormError, setCalFormError] = useState<string | null>(null)
  const [calBulkResult, setCalBulkResult] = useState<string | null>(null)

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

  const loadCalendar = useCallback(async () => {
    setCalLoading(true)
    setCalError(null)
    // Reuses the exact "find current session" pattern CalendarTab already
    // uses — loadSessions() rather than a dedicated lookup, so there's one
    // source of truth for "what counts as current" across both tabs.
    const sRes = await loadSessions(schoolId)
    if (sRes.error) { setCalError(sRes.error); setCalLoading(false); return }
    if (sRes.data.length === 0) {
      setCurrentSessionId(null)
      setCalendarDays([])
      setCalLoading(false)
      return
    }
    const current = sRes.data.find(s => s.is_current) ?? sRes.data[0]
    setCurrentSessionId(current.id)
    const cRes = await loadCalendarDays(schoolId, current.id)
    if (cRes.error) { setCalError(cRes.error); setCalLoading(false); return }
    setCalendarDays(cRes.data)
    setCalLoading(false)
  }, [schoolId])

  useEffect(() => { loadCalendar() }, [loadCalendar])

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

  function openCalForm(mode: 'single' | 'bulk', d?: CalendarDay) {
    setCalMode(mode)
    setEditingCalDay(d ?? null)
    setCalDate(d?.calendar_date ?? '')
    setCalEndDate('')
    setCalDayType(d?.day_type ?? 'holiday')
    setCalLabel(d?.label ?? '')
    setCalExtends(d?.extends_term ?? false)
    setCalFormError(null)
    setCalBulkResult(null)
    setShowCalForm(true)
  }

  async function handleSaveCalDay() {
    if (!currentSessionId) { setCalFormError('No session found — create a session first, in the Sessions tab.'); return }

    if (calMode === 'bulk' && !editingCalDay) {
      if (!calDate || !calEndDate) { setCalFormError('Start date and end date are required.'); return }
      setCalSaving(true)
      setCalFormError(null)
      const res = await bulkUpsertCalendarDays(schoolId, currentSessionId, {
        start_date: calDate,
        end_date: calEndDate,
        day_type: calDayType,
        label: calLabel || null,
        extends_term: calExtends,
      })
      setCalSaving(false)
      if (res.error) { setCalFormError(res.error); return }
      setCalBulkResult(`Marked ${res.count} date${res.count === 1 ? '' : 's'}.`)
      const cRes = await loadCalendarDays(schoolId, currentSessionId)
      setCalendarDays(cRes.data)
      return
    }

    if (!calDate) { setCalFormError('Date is required.'); return }
    setCalSaving(true)
    setCalFormError(null)
    const res = await upsertCalendarDay(schoolId, currentSessionId, {
      id: editingCalDay?.id,
      calendar_date: calDate,
      day_type: calDayType,
      label: calLabel || null,
      extends_term: calExtends,
    })
    setCalSaving(false)
    if (res.error) { setCalFormError(res.error); return }
    setShowCalForm(false)
    const cRes = await loadCalendarDays(schoolId, currentSessionId)
    setCalendarDays(cRes.data)
  }

  async function handleDeleteCalDay(id: string) {
    if (!currentSessionId) return
    if (!confirm('Remove this calendar entry?')) return
    const res = await deleteCalendarDay(schoolId, id)
    if (res.error) { alert(res.error); return }
    setCalendarDays(prev => prev.filter(d => d.id !== id))
  }

  if (loading) return <Skeleton />
  if (error) return <ErrorState message={error} onRetry={load} />

  return (
    <div className="set-tab-content">
      <div className="set-collapsible-header" onClick={() => setWeekDaysOpen(o => !o)}>
        <SectionLabel>School week</SectionLabel>
        <span className="set-collapsible-summary">
          {weekDays.length === 0
            ? 'Not set'
            : weekDays.slice().sort().map(d => DAY_NAMES[d]).join(', ')}
        </span>
        <button type="button" className="set-collapsible-toggle" aria-expanded={weekDaysOpen}>
          {weekDaysOpen ? 'Hide' : 'Edit week days'}
        </button>
      </div>
      {weekDaysOpen && (
        <>
          <p className="set-field-hint">
            Which weekdays count as school days for this school — used everywhere attendance,
            calendars, and term progress are calculated. Change carefully.
          </p>
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
            {daysSaved && <p className="set-save-ok"><Icon name="circle-check" size={16} style={{ color: 'var(--color-success, #16a34a)' }} /> Saved</p>}
            <button className="set-save-btn" onClick={handleSaveDays} disabled={daysSaving}>{daysSaving ? 'Saving…' : 'Save week days'}</button>
          </div>
        </>
      )}

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
              <button className="set-delete-btn" onClick={() => handleDeletePeriod(p.id)} aria-label={`Delete period ${p.label}`}><Icon name="x" size={16} /></button>
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

      <div className="set-section-header set-section-header--spaced">
        <SectionLabel>Holidays & special days</SectionLabel>
        {currentSessionId && (
          <div className="set-add-btn-group">
            <button className="set-add-btn" onClick={() => openCalForm('single')}>+ Add date</button>
            <button className="set-add-btn" onClick={() => openCalForm('bulk')}>+ Add range</button>
          </div>
        )}
      </div>
      <p className="set-field-hint">
        Mark specific dates as a holiday, exam day, or break — these override the school-week
        pattern above for that date only. {calendarDays.length} {calendarDays.length === 1 ? 'entry' : 'entries'} in this session.
      </p>

      {calLoading ? (
        <Skeleton lines={2} />
      ) : calError ? (
        <ErrorState message={calError} onRetry={loadCalendar} />
      ) : !currentSessionId ? (
        <p className="set-empty-hint">No session found — create one in the Sessions tab first.</p>
      ) : calendarDays.length === 0 ? (
        <p className="set-empty-hint">No holidays or special days marked yet for this session.</p>
      ) : (
        calendarDays.map(d => (
          <div key={d.id} className="set-list-row">
            <div className="set-list-row-info">
              <p className="set-list-row-name">
                {d.calendar_date}
                <span className={`set-caldaytype-chip set-caldaytype-chip--${d.day_type}`}>
                  {CAL_DAY_TYPE_LABELS[d.day_type]}
                </span>
                {d.extends_term && <span className="set-extends-chip">Extends term</span>}
              </p>
              {d.label && <p className="set-list-row-meta">{d.label}</p>}
            </div>
            <div className="set-list-row-actions">
              <button className="set-edit-btn" onClick={() => openCalForm('single', d)}>Edit</button>
              <button className="set-delete-btn" onClick={() => handleDeleteCalDay(d.id)} aria-label={`Delete ${d.calendar_date}`}><Icon name="x" size={16} /></button>
            </div>
          </div>
        ))
      )}

      {showCalForm && (
        <div className="set-overlay" onClick={() => setShowCalForm(false)}>
          <div className="set-sheet" onClick={e => e.stopPropagation()}>
            <h2 className="set-sheet-title">
              {editingCalDay ? 'Edit calendar entry' : calMode === 'bulk' ? 'Add date range' : 'Add date'}
            </h2>

            {calMode === 'bulk' && !editingCalDay ? (
              <>
                <FieldRow label="Start date"><Input value={calDate} onChange={setCalDate} type="date" /></FieldRow>
                <FieldRow label="End date"><Input value={calEndDate} onChange={setCalEndDate} type="date" /></FieldRow>
              </>
            ) : (
              <FieldRow label="Date"><Input value={calDate} onChange={setCalDate} type="date" /></FieldRow>
            )}

            <FieldRow label="Type">
              <select
                className="set-select"
                value={calDayType}
                onChange={e => setCalDayType(e.target.value as CalendarDayType)}
              >
                <option value="holiday">Holiday</option>
                <option value="exam_day">Exam day</option>
                <option value="break">Break</option>
                <option value="school_day">School day (override)</option>
              </select>
            </FieldRow>

            <FieldRow label="Label (optional)">
              <Input value={calLabel} onChange={setCalLabel} placeholder="e.g. Eid al-Fitr, Mid-term break" />
            </FieldRow>

            <Toggle
              checked={calExtends}
              onChange={setCalExtends}
              label="Extend the term/session end date to make up for this"
            />
            <p className="set-field-hint">
              On: a school-day lost to this entry pushes the term's effective end date out by one
              day, so the same number of teaching days is still delivered. Off: this is just a
              marked exception inside the term as originally planned — the common choice for a
              single stray public holiday. Only applies to dates that would otherwise have been
              real school days; already non-school dates (per the school week above) are ignored
              either way.
            </p>

            {calFormError && <p className="set-form-error">{calFormError}</p>}
            {calBulkResult && <p className="set-save-ok"><Icon name="circle-check" size={16} style={{ color: 'var(--color-success, #16a34a)' }} /> {calBulkResult}</p>}

            <div className="set-sheet-footer">
              <button className="set-cancel-btn" onClick={() => setShowCalForm(false)}>
                {calBulkResult ? 'Close' : 'Cancel'}
              </button>
              <button className="set-save-btn" onClick={handleSaveCalDay} disabled={calSaving}>
                {calSaving ? 'Saving…' : calMode === 'bulk' && !editingCalDay ? 'Mark range' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const CAL_DAY_TYPE_LABELS: Record<CalendarDayType, string> = {
  school_day: 'School day',
  holiday: 'Holiday',
  exam_day: 'Exam day',
  break: 'Break',
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

// ─── Tab: Institution (faculties → departments → programmes → levels) ─────────
// §7.27.1, PRD SESSION 55. Post-onboarding equivalent of ClassesTab above,
// modeled directly on its structure (openForm/handleSave/set-sheet pattern)
// per SESSION 55 §0 instruction 5 — hidden entirely unless school_type is a
// higher-institution type (enforced in buildTabs, above). Deliberately not
// merged with ClassesTab: different tables, different anchor semantics
// (§7.27.1's own note — programme_levels is administrative metadata, not a
// live daily container the way class_nodes is).

function InstitutionTab({ schoolId }: { schoolId: string }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [faculties, setFaculties] = useState<Faculty[]>([])
  const [departments, setDepartments] = useState<Department[]>([])
  const [programmes, setProgrammes] = useState<Programme[]>([])
  const [levelsByProgramme, setLevelsByProgramme] = useState<Record<string, ProgrammeLevel[]>>({})
  const [courses, setCourses] = useState<Course[]>([])

  // Faculty form
  const [showFacultyForm, setShowFacultyForm] = useState(false)
  const [editingFaculty, setEditingFaculty] = useState<Faculty | null>(null)
  const [fName, setFName] = useState('')
  const [fCode, setFCode] = useState('')
  const [fSaving, setFSaving] = useState(false)
  const [fError, setFError] = useState<string | null>(null)

  // Department form
  const [showDeptForm, setShowDeptForm] = useState(false)
  const [editingDept, setEditingDept] = useState<Department | null>(null)
  const [dName, setDName] = useState('')
  const [dCode, setDCode] = useState('')
  const [dFacultyId, setDFacultyId] = useState<string | null>(null)
  const [dSaving, setDSaving] = useState(false)
  const [dError, setDError] = useState<string | null>(null)

  // Programme form
  const [showProgForm, setShowProgForm] = useState(false)
  const [editingProg, setEditingProg] = useState<Programme | null>(null)
  const [pName, setPName] = useState('')
  // SESSION 65 — programmes.code, the schema gap closed by
  // migration_session_65.sql; optional, used only as an available matric-
  // number-format component, same "optional, informational" treatment
  // faculties.code/departments.code already get in their own forms below.
  const [pCode, setPCode] = useState('')
  const [pAwardType, setPAwardType] = useState('degree')
  const [pDeptId, setPDeptId] = useState<string | null>(null)
  const [pDuration, setPDuration] = useState(4)
  const [pMinCredit, setPMinCredit] = useState('')
  const [pMaxCredit, setPMaxCredit] = useState('')
  const [pSaving, setPSaving] = useState(false)
  const [pError, setPError] = useState<string | null>(null)

  // Course form (§7.27.2 courses — school-wide catalogue, not per-programme;
  // lives here rather than in CurriculumTab since a course is definitional
  // institutional metadata like a Faculty/Department/Programme, reused
  // across many curricula — see settingsService.ts's header note on this.)
  const [showCourseForm, setShowCourseForm] = useState(false)
  const [editingCourse, setEditingCourse] = useState<Course | null>(null)
  const [cCode, setCCode] = useState('')
  const [cTitle, setCTitle] = useState('')
  const [cDeptId, setCDeptId] = useState<string | null>(null)
  const [cCreditUnits, setCCreditUnits] = useState('1')
  const [cType, setCType] = useState('')
  const [cSaving, setCSaving] = useState(false)
  const [cError, setCError] = useState<string | null>(null)

  // Level form
  const [showLevelForm, setShowLevelForm] = useState(false)
  const [editingLevel, setEditingLevel] = useState<ProgrammeLevel | null>(null)
  const [lProgId, setLProgId] = useState<string | null>(null)
  const [lLabel, setLLabel] = useState('')
  const [lSequence, setLSequence] = useState(1)
  const [lSaving, setLSaving] = useState(false)
  const [lError, setLError] = useState<string | null>(null)

  // Admission form (§7.27.1a student_programme_placements + §12 SESSION 65
  // matric-number generation) — SESSION 65 replaces the old "+Place student"
  // action (search-only, hand-typed matric number, a second disconnected
  // step from creating the student) with one real, atomic flow: search OR
  // create the student → confirm programme/level/session → Admit, which
  // calls admitStudent() (settingsService.ts → admit_student() RPC,
  // migration_session_65.sql) to generate the matric number and write the
  // placement in a single server-side transaction. Kept as its own form
  // rather than folded into the level form above, same reasoning the old
  // placement form already established: a level is created once by an
  // admin setting up the structure, while an admission happens per-student,
  // repeatedly, and needs its own search-driven picker.
  const [placementsByLevel, setPlacementsByLevel] = useState<Record<string, StudentProgrammePlacement[]>>({})
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)
  const [currentSessionName, setCurrentSessionName] = useState<string | null>(null)
  const [currentSessionStartYear, setCurrentSessionStartYear] = useState<number | null>(null)

  const [showPlacementForm, setShowPlacementForm] = useState(false)
  const [placementLevelId, setPlacementLevelId] = useState<string | null>(null)
  const [placementLevelLabel, setPlacementLevelLabel] = useState('')
  // 'search' = pick an existing student (default); 'create' = admit a
  // brand-new student in the same flow, closing the "two disconnected
  // manual steps" gap the card names directly.
  const [admitMode, setAdmitMode] = useState<'search' | 'create'>('search')
  const [studentQuery, setStudentQuery] = useState('')
  const debouncedStudentQuery = useDebouncedValue(studentQuery, 300)
  const [studentResults, setStudentResults] = useState<StudentSearchResult[]>([])
  const [studentSearching, setStudentSearching] = useState(false)
  const [selectedStudent, setSelectedStudent] = useState<StudentSearchResult | null>(null)
  // New-student mini form — deliberately minimal (name + optional gender/DOB
  // only). Every other field on Student (address, guardians, photo, etc.)
  // stays reachable afterward through StudentsModule's own full Edit form —
  // this screen's job is admission, not the complete student record.
  const [newStudentName, setNewStudentName] = useState('')
  const [newStudentGender, setNewStudentGender] = useState('')
  const [newStudentDob, setNewStudentDob] = useState('')
  const [plSaving, setPlSaving] = useState(false)
  const [plError, setPlError] = useState<string | null>(null)
  const [admitResult, setAdmitResult] = useState<AdmitStudentResult | null>(null)

  // ── Matric number format (§12, SESSION 65) ────────────────────────────
  const [matricFormatId, setMatricFormatId] = useState<string | null>(null)
  const [matricComponents, setMatricComponents] = useState<MatricNumberComponent[]>([])
  const [matricSaving, setMatricSaving] = useState(false)
  const [matricError, setMatricError] = useState<string | null>(null)
  const [matricSaved, setMatricSaved] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const [fRes, dRes, pRes, sessRes, cRes, mfRes] = await Promise.all([
      loadFaculties(schoolId),
      loadDepartments(schoolId),
      loadProgrammes(schoolId),
      loadCurrentSession(schoolId),
      loadCourses(schoolId),
      loadMatricNumberFormat(schoolId),
    ])
    if (fRes.error) { setError(fRes.error); setLoading(false); return }
    if (dRes.error) { setError(dRes.error); setLoading(false); return }
    if (pRes.error) { setError(pRes.error); setLoading(false); return }
    if (cRes.error) { setError(cRes.error); setLoading(false); return }
    // mfRes.error is deliberately not a hard blocker the way f/d/p/c are —
    // "no format configured yet" is a normal state (loadMatricNumberFormat
    // returns {data: null, error: null} for it, same convention
    // loadCgpaPolicy() already established), and admitStudent() itself
    // surfaces a clear error at admit-time if a school somehow reaches that
    // screen with no format saved.
    if (!mfRes.error && mfRes.data) {
      setMatricFormatId(mfRes.data.id)
      setMatricComponents(mfRes.data.components)
    }
    // Current session is informational context for the admission form, not
    // a hard blocker for the rest of the tab — a school between sessions
    // (sessRes.data null) should still be able to manage its hierarchy; it
    // just can't admit a student until one exists, which the admission form
    // itself gates on below.
    if (!sessRes.error && sessRes.data) {
      setCurrentSessionId(sessRes.data.id)
      setCurrentSessionName(sessRes.data.name)
      // Admission year for the matric-number sequence's reset scope (§12
      // decision, 2026-07-17) — derived from the current session's real
      // start_date rather than exposed as a separate editable field, since
      // the session is already the thing being chosen implicitly by
      // "there is one current session" and inventing a second, independent
      // year input would let the two disagree for no real reason.
      const startYear = new Date(sessRes.data.start_date).getFullYear()
      setCurrentSessionStartYear(Number.isFinite(startYear) ? startYear : null)
    }
    setFaculties(fRes.data)
    setDepartments(dRes.data)
    setProgrammes(pRes.data)
    setCourses(cRes.data)
    const levelEntries = await Promise.all(
      pRes.data.map(async (prog) => [prog.id, (await loadProgrammeLevels(prog.id)).data] as const),
    )
    setLevelsByProgramme(Object.fromEntries(levelEntries))
    // Placements are loaded per-level, scoped to the current session, since
    // that's the only view an admin needs day-to-day ("who's placed into
    // this level right now") — historical placements remain queryable
    // directly via SQL per the PRD's Done Check, not surfaced in this list.
    const allLevelIds = Object.values(Object.fromEntries(levelEntries)).flat().map(l => l.id)
    if (allLevelIds.length > 0) {
      const placementEntries = await Promise.all(
        allLevelIds.map(async (levelId) => [levelId, (await loadPlacementsForProgramme(levelId)).data] as const),
      )
      setPlacementsByLevel(Object.fromEntries(placementEntries))
    }
    setLoading(false)
  }, [schoolId])

  useEffect(() => { load() }, [load])

  // Debounced student search — only fires once the query settles, and only
  // against this school's own students (searchStudents scopes by schoolId
  // itself, same as every other loader in this file).
  useEffect(() => {
    if (!debouncedStudentQuery || debouncedStudentQuery.trim().length < 2) {
      setStudentResults([])
      return
    }
    let cancelled = false
    setStudentSearching(true)
    searchStudents(schoolId, debouncedStudentQuery).then(res => {
      if (cancelled) return
      setStudentResults(res.error ? [] : res.data)
      setStudentSearching(false)
    })
    return () => { cancelled = true }
  }, [schoolId, debouncedStudentQuery])

  function openFacultyForm(f?: Faculty) {
    setEditingFaculty(f ?? null)
    setFName(f?.name ?? '')
    setFCode(f?.code ?? '')
    setFError(null)
    setShowFacultyForm(true)
  }

  async function handleSaveFaculty() {
    if (!fName) { setFError('Name is required.'); return }
    setFSaving(true)
    const res = await upsertFaculty(schoolId, { id: editingFaculty?.id, name: fName, code: fCode || null })
    if (res.error) { setFError(res.error); setFSaving(false); return }
    setShowFacultyForm(false)
    await load()
    setFSaving(false)
  }

  function openDeptForm(d?: Department) {
    setEditingDept(d ?? null)
    setDName(d?.name ?? '')
    setDCode(d?.code ?? '')
    setDFacultyId(d?.faculty_id ?? null)
    setDError(null)
    setShowDeptForm(true)
  }

  async function handleSaveDept() {
    if (!dName) { setDError('Name is required.'); return }
    setDSaving(true)
    const res = await upsertDepartment(schoolId, {
      id: editingDept?.id, name: dName, code: dCode || null, faculty_id: dFacultyId,
    })
    if (res.error) { setDError(res.error); setDSaving(false); return }
    setShowDeptForm(false)
    await load()
    setDSaving(false)
  }

  function openProgForm(p?: Programme, deptId?: string) {
    setEditingProg(p ?? null)
    setPName(p?.name ?? '')
    setPCode(p?.code ?? '')
    setPAwardType(p?.award_type ?? 'degree')
    setPDeptId(p?.department_id ?? deptId ?? null)
    setPDuration(p?.duration_sessions ?? 4)
    setPMinCredit(p?.min_credit_load != null ? String(p.min_credit_load) : '')
    setPMaxCredit(p?.max_credit_load != null ? String(p.max_credit_load) : '')
    setPError(null)
    setShowProgForm(true)
  }

  async function handleSaveProg() {
    if (!pName) { setPError('Name is required.'); return }
    if (!pDeptId) { setPError('Choose a department.'); return }
    setPSaving(true)
    const res = await upsertProgramme(schoolId, {
      id: editingProg?.id,
      name: pName,
      code: pCode || null,
      award_type: pAwardType,
      department_id: pDeptId,
      duration_sessions: pDuration,
      min_credit_load: pMinCredit ? Number(pMinCredit) : null,
      max_credit_load: pMaxCredit ? Number(pMaxCredit) : null,
    })
    if (res.error) { setPError(res.error); setPSaving(false); return }
    setShowProgForm(false)
    await load()
    setPSaving(false)
  }

  function openCourseForm(c?: Course) {
    setEditingCourse(c ?? null)
    setCCode(c?.code ?? '')
    setCTitle(c?.title ?? '')
    setCDeptId(c?.department_id ?? null)
    setCCreditUnits(String(c?.credit_units ?? 1))
    setCType(c?.course_type ?? '')
    setCError(null)
    setShowCourseForm(true)
  }

  async function handleSaveCourse() {
    if (!cCode) { setCError('Course code is required.'); return }
    if (!cTitle) { setCError('Title is required.'); return }
    if (!cDeptId) { setCError('Choose a department.'); return }
    const creditUnitsNum = Number(cCreditUnits)
    if (!cCreditUnits || !Number.isInteger(creditUnitsNum) || creditUnitsNum < 1) {
      setCError('Credit units must be a whole number of 1 or more.')
      return
    }
    setCSaving(true)
    const res = await upsertCourse(schoolId, {
      id: editingCourse?.id,
      code: cCode,
      title: cTitle,
      department_id: cDeptId,
      credit_units: creditUnitsNum,
      course_type: cType || null,
    })
    if (res.error) { setCError(res.error); setCSaving(false); return }
    setShowCourseForm(false)
    await load()
    setCSaving(false)
  }

  function openLevelForm(programmeId: string, l?: ProgrammeLevel) {
    setEditingLevel(l ?? null)
    setLProgId(programmeId)
    setLLabel(l?.level_label ?? '')
    setLSequence(l?.sequence_order ?? (levelsByProgramme[programmeId]?.length ?? 0) + 1)
    setLError(null)
    setShowLevelForm(true)
  }

  async function handleSaveLevel() {
    if (!lLabel) { setLError('Label is required.'); return }
    if (!lProgId) { setLError('No programme selected.'); return }
    setLSaving(true)
    const res = await upsertProgrammeLevel({
      id: editingLevel?.id, programme_id: lProgId, level_label: lLabel, sequence_order: lSequence,
    })
    if (res.error) { setLError(res.error); setLSaving(false); return }
    setShowLevelForm(false)
    await load()
    setLSaving(false)
  }

  function openPlacementForm(levelId: string, levelLabel: string) {
    setPlacementLevelId(levelId)
    setPlacementLevelLabel(levelLabel)
    setAdmitMode('search')
    setStudentQuery('')
    setStudentResults([])
    setSelectedStudent(null)
    setNewStudentName('')
    setNewStudentGender('')
    setNewStudentDob('')
    setPlError(null)
    setAdmitResult(null)
    setShowPlacementForm(true)
  }

  // SESSION 65 (PRD Problem 8.7a, items 1 and 7) — the one real, atomic
  // admission flow. Branches only on whether the student already exists
  // (search) or needs creating (create) — everything after that point
  // (matric-number generation + placement write) is the same single
  // admitStudent() call either way, so a newly-created student is admitted
  // exactly as atomically as an existing one, not through a second,
  // looser path.
  async function handleAdmit() {
    if (!placementLevelId) { setPlError('No level selected.'); return }
    if (!currentSessionId || currentSessionStartYear == null) {
      // Real, current constraint — not something to silently work around.
      // student_programme_placements.session_id is not-null (migration
      // 55b), and there is deliberately no "no session" fallback: an
      // admission without a session is meaningless for the history this
      // table exists to track, and the matric sequence's own reset scope
      // (§12) needs a real admission year to key off. If a school
      // genuinely has no current session, that's a Sessions-tab problem to
      // fix first, not something this form should paper over.
      setPlError('This school has no current session set. Set one in the Sessions tab before admitting students.')
      return
    }

    let studentId: string
    if (admitMode === 'search') {
      if (!selectedStudent) { setPlError('Search for and select a student, or switch to "New student".'); return }
      studentId = selectedStudent.id
    } else {
      if (!newStudentName.trim()) { setPlError('Enter the student\u2019s full name.'); return }
      setPlSaving(true)
      const createRes = await createStudent({
        schoolId,
        full_name: newStudentName,
        date_of_birth: newStudentDob || null,
        gender: newStudentGender || null,
        class_node_id: null,        // higher-ed admission — class_node_id is secondary-only (§7.5)
        admission_date: todayDateStringSettings(),
        student_code: null,
        blood_group: null, address: null, medical_notes: null,
        emergency_contact_name: null, emergency_contact_phone: null,
        hobbies: null, email: null, phone: null,
      } as StudentUpsertParams)
      if (!createRes.ok) { setPlError(createRes.error); setPlSaving(false); return }
      studentId = createRes.data.id
    }

    setPlSaving(true)
    setPlError(null)
    const res = await admitStudent({
      schoolId,
      studentId,
      programmeLevelId: placementLevelId,
      sessionId: currentSessionId,
      admissionYear: currentSessionStartYear,
    })
    if (res.error || !res.data) { setPlError(res.error ?? 'Admission failed.'); setPlSaving(false); return }
    setAdmitResult(res.data)
    await load()
    setPlSaving(false)
  }

  function closeAdmitForm() {
    setShowPlacementForm(false)
    setAdmitResult(null)
  }

  // ── Matric number format builder (§12, SESSION 65) ─────────────────────
  // Fully admin-configurable, not fixed: an ordered list of components, each
  // with its own preceding separator (see settingsService.ts's own header
  // note on this type). Order in the array IS the display order — no
  // separate sequence_order field, since reordering the array itself is
  // simpler and there's nothing else that needs to reference a component by
  // a stable position.
  function addMatricComponent(type: MatricNumberComponent['type']) {
    setMatricSaved(false)
    const next: MatricNumberComponent = { type, separator: matricComponents.length > 0 ? '/' : null }
    if (type === 'sequence') next.digits = 3
    if (type === 'session_year') next.year_format = '2digit'
    if (type === 'constant') next.value = ''
    setMatricComponents([...matricComponents, next])
  }

  function updateMatricComponent(index: number, patch: Partial<MatricNumberComponent>) {
    setMatricSaved(false)
    setMatricComponents(matricComponents.map((c, i) => (i === index ? { ...c, ...patch } : c)))
  }

  function removeMatricComponent(index: number) {
    setMatricSaved(false)
    setMatricComponents(matricComponents.filter((_, i) => i !== index))
  }

  function moveMatricComponent(index: number, direction: -1 | 1) {
    const target = index + direction
    if (target < 0 || target >= matricComponents.length) return
    setMatricSaved(false)
    const next = [...matricComponents]
    ;[next[index], next[target]] = [next[target], next[index]]
    setMatricComponents(next)
  }

  async function handleSaveMatricFormat() {
    if (matricComponents.length === 0) {
      setMatricError('Add at least one component before saving.')
      return
    }
    if (!matricComponents.some(c => c.type === 'sequence')) {
      // Not a DB constraint — a real, deliberate UI-level guard: a format
      // with no sequence component would generate the identical matric
      // number for every student in the same programme/year, which
      // build_matric_number() would happily do since it has no opinion on
      // uniqueness itself (that's students.matric_number's own unique
      // constraint, which would then reject every admission after the
      // first with a confusing DB error instead of this clear one).
      setMatricError('The format needs a sequence component, or every student in the same programme/year would get the same number.')
      return
    }
    setMatricSaving(true)
    setMatricError(null)
    const res = await saveMatricNumberFormat(schoolId, matricComponents)
    if (res.error) { setMatricError(res.error); setMatricSaving(false); return }
    setMatricSaving(false)
    setMatricSaved(true)
  }

  if (loading) return <Skeleton />
  if (error) return <ErrorState message={error} onRetry={load} />

  return (
    <div className="set-tab-content">
      <div className="set-section-header">
        <SectionLabel>Faculties <span className="optional">(optional)</span></SectionLabel>
        <button className="set-add-btn" onClick={() => openFacultyForm()}>+ Add faculty</button>
      </div>
      {faculties.length === 0
        ? <p className="set-empty-hint">No faculties — fine if your institution doesn't use this tier.</p>
        : faculties.map(f => (
          <div key={f.id} className="set-list-row">
            <div className="set-list-row-info">
              <p className="set-list-row-name">{f.name}</p>
              {f.code && <p className="set-list-row-meta">Code: {f.code}</p>}
            </div>
            <button className="set-edit-btn" onClick={() => openFacultyForm(f)}>Edit</button>
          </div>
        ))
      }

      <div className="set-section-header">
        <SectionLabel>Departments</SectionLabel>
        <button className="set-add-btn" onClick={() => openDeptForm()}>+ Add department</button>
      </div>
      {departments.length === 0
        ? <p className="set-empty-hint">No departments yet. Add your first one.</p>
        : departments.map(d => (
          <div key={d.id} className="set-list-row">
            <div className="set-list-row-info">
              <p className="set-list-row-name">{d.name}</p>
              <p className="set-list-row-meta">
                {faculties.find(f => f.id === d.faculty_id)?.name ?? 'No faculty'}
                {d.code ? ` · Code: ${d.code}` : ''}
              </p>
            </div>
            <button className="set-edit-btn" onClick={() => openDeptForm(d)}>Edit</button>
          </div>
        ))
      }

      {/* Matric number format (§12, SESSION 65) — fully admin-configurable
          per school: an ordered list of components, each with its own
          preceding separator. build_matric_number() (migration_session_65.sql)
          is the only place this actually gets assembled into a real number
          — this section only defines the shape. */}
      <div className="set-section-header">
        <SectionLabel>Matric number format</SectionLabel>
      </div>
      <p className="set-hint-text">
        Build the shape of this school's matriculation numbers from components, in order. Each component after the first has its own separator.
      </p>
      {matricComponents.length === 0 ? (
        <p className="set-empty-hint">No format set up yet — add components below, then Save.</p>
      ) : (
        <div className="set-matric-preview">
          <span className="set-list-row-meta">Preview shape: </span>
          <code>{previewMatricFormat(matricComponents)}</code>
        </div>
      )}
      {matricComponents.map((c, i) => (
        <div key={i} className="set-list-row set-matric-row">
          <div className="set-matric-row-fields">
            {i > 0 && (
              <input
                type="text"
                className="set-input set-matric-sep-input"
                value={c.separator ?? ''}
                onChange={e => updateMatricComponent(i, { separator: e.target.value || null })}
                placeholder="/"
                aria-label="Separator before this component"
              />
            )}
            <span className="set-type-chip">{MATRIC_COMPONENT_LABELS[c.type]}</span>
            {c.type === 'constant' && (
              <input
                type="text"
                className="set-input set-matric-const-input"
                value={c.value ?? ''}
                onChange={e => updateMatricComponent(i, { value: e.target.value })}
                placeholder="e.g. SCH"
                aria-label="Fixed text value"
              />
            )}
            {c.type === 'session_year' && (
              <select
                className="set-select set-select--sm"
                value={c.year_format ?? '2digit'}
                onChange={e => updateMatricComponent(i, { year_format: e.target.value as '2digit' | '4digit' })}
              >
                <option value="2digit">2 digits (e.g. 26)</option>
                <option value="4digit">4 digits (e.g. 2026)</option>
              </select>
            )}
            {c.type === 'sequence' && (
              <span className="set-matric-digits-field">
                <label className="set-field-label" htmlFor={`matric-digits-${i}`}>Digits</label>
                <input
                  id={`matric-digits-${i}`}
                  type="number"
                  className="set-input set-matric-digits-input"
                  value={String(c.digits ?? 3)}
                  onChange={e => updateMatricComponent(i, { digits: Math.max(1, Number(e.target.value) || 1) })}
                  min={1}
                />
              </span>
            )}
          </div>
          <div className="set-list-row-actions">
            <button className="set-edit-btn" onClick={() => moveMatricComponent(i, -1)} disabled={i === 0}>↑</button>
            <button className="set-edit-btn" onClick={() => moveMatricComponent(i, 1)} disabled={i === matricComponents.length - 1}>↓</button>
            <button className="set-edit-btn" onClick={() => removeMatricComponent(i)}>Remove</button>
          </div>
        </div>
      ))}
      <div className="set-section-header">
        <SectionLabel>Add component</SectionLabel>
        <div className="set-add-btn-group">
          <select
            className="set-select set-select--sm"
            value=""
            onChange={e => { if (e.target.value) addMatricComponent(e.target.value as MatricNumberComponent['type']) }}
          >
            <option value="">Choose type…</option>
            {(Object.keys(MATRIC_COMPONENT_LABELS) as MatricNumberComponent['type'][]).map(t => (
              <option key={t} value={t}>{MATRIC_COMPONENT_LABELS[t]}</option>
            ))}
          </select>
          <button className="set-save-btn" onClick={handleSaveMatricFormat} disabled={matricSaving}>
            {matricSaving ? 'Saving…' : 'Save format'}
          </button>
        </div>
      </div>
      {matricError && <p className="set-form-error">{matricError}</p>}
      {matricSaved && !matricError && <p className="set-hint-text">Saved.</p>}

      <div className="set-section-header">
        <SectionLabel>Programmes</SectionLabel>
        <button className="set-add-btn" onClick={() => openProgForm()} disabled={departments.length === 0}>+ Add programme</button>
      </div>
      {departments.length === 0 ? (
        <p className="set-empty-hint">Add a department first.</p>
      ) : programmes.length === 0 ? (
        <p className="set-empty-hint">No programmes yet. Add your first one.</p>
      ) : programmes.map(p => (
        <div key={p.id} className="set-class-node">
          <div className="set-class-node-row">
            <div className="set-class-node-info">
              <span className="set-class-node-name">{p.name}</span>
              <span className="set-type-chip">{p.award_type}</span>
              <span className="set-type-chip">{p.duration_sessions} sessions</span>
            </div>
            <div className="set-list-row-actions">
              <button className="set-edit-btn" onClick={() => openProgForm(p)}>Edit</button>
              <button className="set-add-sub-btn" onClick={() => openLevelForm(p.id)}>+ Level</button>
            </div>
          </div>
          {(levelsByProgramme[p.id] ?? []).map(l => (
            <div key={l.id} className="set-class-node" style={{ marginLeft: 16 }}>
              <div className="set-class-node-row">
                <div className="set-class-node-info">
                  <span className="set-class-node-name">{l.level_label}</span>
                  {(placementsByLevel[l.id] ?? []).length > 0 && (
                    <span className="set-type-chip">{(placementsByLevel[l.id] ?? []).length} placed</span>
                  )}
                </div>
                <div className="set-list-row-actions">
                  <button className="set-edit-btn" onClick={() => openLevelForm(p.id, l)}>Edit</button>
                  <button className="set-add-sub-btn" onClick={() => openPlacementForm(l.id, l.level_label)}>+ Admit student</button>
                </div>
              </div>
              {(placementsByLevel[l.id] ?? []).length > 0 && (
                <div style={{ marginLeft: 16 }}>
                  {(placementsByLevel[l.id] ?? []).map(pl => (
                    <p key={pl.id} className="set-list-row-meta">{pl.student_name}{pl.student_matric_number ? ` · ${pl.student_matric_number}` : ''}</p>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      ))}

      {/* Course catalogue (§7.27.2 courses) — school-wide, reused across
          many curricula; kept here alongside Programmes rather than in
          CurriculumTab since it's institutional metadata, not a per-
          programme assignment. See settingsService.ts header note. */}
      <div className="set-section-header">
        <SectionLabel>Courses</SectionLabel>
        <button className="set-add-btn" onClick={() => openCourseForm()} disabled={departments.length === 0}>+ Add course</button>
      </div>
      {departments.length === 0 ? (
        <p className="set-empty-hint">Add a department first.</p>
      ) : courses.length === 0 ? (
        <p className="set-empty-hint">No courses yet. Add your first one.</p>
      ) : courses.map(c => (
        <div key={c.id} className="set-list-row">
          <div className="set-list-row-info">
            <p className="set-list-row-name">{c.code} — {c.title}</p>
            <p className="set-list-row-meta">
              {departments.find(d => d.id === c.department_id)?.name ?? 'No department'}
              {' · '}{c.credit_units} unit{c.credit_units === 1 ? '' : 's'}
              {c.course_type ? ` · ${c.course_type}` : ''}
            </p>
          </div>
          <button className="set-edit-btn" onClick={() => openCourseForm(c)}>Edit</button>
        </div>
      ))}

      {showFacultyForm && (
        <div className="set-overlay" onClick={() => setShowFacultyForm(false)}>
          <div className="set-sheet" onClick={e => e.stopPropagation()}>
            <h2 className="set-sheet-title">{editingFaculty ? 'Edit faculty' : 'Add faculty'}</h2>
            <FieldRow label="Name"><Input value={fName} onChange={setFName} placeholder="e.g. Faculty of Science" /></FieldRow>
            <FieldRow label="Code (optional)"><Input value={fCode} onChange={setFCode} placeholder="e.g. SCI" /></FieldRow>
            {fError && <p className="set-form-error">{fError}</p>}
            <div className="set-sheet-footer">
              <button className="set-cancel-btn" onClick={() => setShowFacultyForm(false)}>Cancel</button>
              <button className="set-save-btn" onClick={handleSaveFaculty} disabled={fSaving}>{fSaving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}

      {showDeptForm && (
        <div className="set-overlay" onClick={() => setShowDeptForm(false)}>
          <div className="set-sheet" onClick={e => e.stopPropagation()}>
            <h2 className="set-sheet-title">{editingDept ? 'Edit department' : 'Add department'}</h2>
            <FieldRow label="Name"><Input value={dName} onChange={setDName} placeholder="e.g. Department of Nursing" /></FieldRow>
            <FieldRow label="Faculty (optional)">
              <select className="set-select" value={dFacultyId ?? ''} onChange={e => setDFacultyId(e.target.value || null)}>
                <option value="">No faculty</option>
                {faculties.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </FieldRow>
            <FieldRow label="Code (optional)"><Input value={dCode} onChange={setDCode} placeholder="e.g. NUR" /></FieldRow>
            {dError && <p className="set-form-error">{dError}</p>}
            <div className="set-sheet-footer">
              <button className="set-cancel-btn" onClick={() => setShowDeptForm(false)}>Cancel</button>
              <button className="set-save-btn" onClick={handleSaveDept} disabled={dSaving}>{dSaving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}

      {showProgForm && (
        <div className="set-overlay" onClick={() => setShowProgForm(false)}>
          <div className="set-sheet" onClick={e => e.stopPropagation()}>
            <h2 className="set-sheet-title">{editingProg ? 'Edit programme' : 'Add programme'}</h2>
            <FieldRow label="Department">
              <select className="set-select" value={pDeptId ?? ''} onChange={e => setPDeptId(e.target.value || null)}>
                <option value="">Choose a department</option>
                {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </FieldRow>
            <FieldRow label="Name"><Input value={pName} onChange={setPName} placeholder="e.g. Basic Nursing Science" /></FieldRow>
            <FieldRow label="Code (optional)"><Input value={pCode} onChange={setPCode} placeholder="e.g. NSC" /></FieldRow>
            <FieldRow label="Award type">
              <select className="set-select" value={pAwardType} onChange={e => setPAwardType(e.target.value)}>
                {AWARD_TYPE_OPTIONS_SETTINGS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </FieldRow>
            <FieldRow label="Duration (sessions)"><Input value={String(pDuration)} onChange={v => setPDuration(Number(v) || 1)} type="number" /></FieldRow>
            <FieldRow label="Min credit load (optional)"><Input value={pMinCredit} onChange={setPMinCredit} type="number" /></FieldRow>
            <FieldRow label="Max credit load (optional)"><Input value={pMaxCredit} onChange={setPMaxCredit} type="number" /></FieldRow>
            {pError && <p className="set-form-error">{pError}</p>}
            <div className="set-sheet-footer">
              <button className="set-cancel-btn" onClick={() => setShowProgForm(false)}>Cancel</button>
              <button className="set-save-btn" onClick={handleSaveProg} disabled={pSaving}>{pSaving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}

      {showCourseForm && (
        <div className="set-overlay" onClick={() => setShowCourseForm(false)}>
          <div className="set-sheet" onClick={e => e.stopPropagation()}>
            <h2 className="set-sheet-title">{editingCourse ? 'Edit course' : 'Add course'}</h2>
            <FieldRow label="Department">
              <select className="set-select" value={cDeptId ?? ''} onChange={e => setCDeptId(e.target.value || null)}>
                <option value="">Choose a department</option>
                {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </FieldRow>
            <FieldRow label="Course code"><Input value={cCode} onChange={setCCode} placeholder="e.g. NSC101" /></FieldRow>
            <FieldRow label="Title"><Input value={cTitle} onChange={setCTitle} placeholder="e.g. Introduction to Nursing Science" /></FieldRow>
            <FieldRow label="Credit units"><Input value={cCreditUnits} onChange={v => setCCreditUnits(v.replace(/[^0-9]/g, ''))} type="number" /></FieldRow>
            <FieldRow label="Type (optional)">
              <select className="set-select" value={cType} onChange={e => setCType(e.target.value)}>
                <option value="">Not specified</option>
                {COURSE_TYPE_OPTIONS_SETTINGS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </FieldRow>
            {cError && <p className="set-form-error">{cError}</p>}
            <div className="set-sheet-footer">
              <button className="set-cancel-btn" onClick={() => setShowCourseForm(false)}>Cancel</button>
              <button className="set-save-btn" onClick={handleSaveCourse} disabled={cSaving}>{cSaving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}

      {showLevelForm && (
        <div className="set-overlay" onClick={() => setShowLevelForm(false)}>
          <div className="set-sheet" onClick={e => e.stopPropagation()}>
            <h2 className="set-sheet-title">{editingLevel ? 'Edit level' : 'Add level'}</h2>
            <FieldRow label="Label"><Input value={lLabel} onChange={setLLabel} placeholder="e.g. 100, ND1, Year 1" /></FieldRow>
            <FieldRow label="Sequence order"><Input value={String(lSequence)} onChange={v => setLSequence(Number(v) || 1)} type="number" /></FieldRow>
            {lError && <p className="set-form-error">{lError}</p>}
            <div className="set-sheet-footer">
              <button className="set-cancel-btn" onClick={() => setShowLevelForm(false)}>Cancel</button>
              <button className="set-save-btn" onClick={handleSaveLevel} disabled={lSaving}>{lSaving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}

      {showPlacementForm && (
        <div className="set-overlay" onClick={closeAdmitForm}>
          <div className="set-sheet" onClick={e => e.stopPropagation()}>
            <h2 className="set-sheet-title">Admit student — {placementLevelLabel}</h2>

            {admitResult ? (
              // SESSION 65 — the whole point of this screen: a real,
              // generated matric number, shown right after the atomic
              // admit_student() call succeeds, not hand-typed by the admin
              // afterward the way SESSION 55's own Done Check had to.
              <>
                <p className="set-hint-text">
                  {admitResult.generated_new_number
                    ? 'Student admitted. Matric number generated:'
                    : 'Placement created. This student already had a matric number, so it was kept:'}
                </p>
                <p className="set-matric-result"><code>{admitResult.matric_number}</code></p>
                <div className="set-sheet-footer">
                  <button className="set-save-btn" onClick={closeAdmitForm}>Done</button>
                </div>
              </>
            ) : (
              <>
                <p className="set-hint-text">
                  {currentSessionName
                    ? `This admits the student into ${placementLevelLabel} for the current session (${currentSessionName}).`
                    : 'No current session is set for this school — set one in the Sessions tab first.'}
                </p>

                <div className="set-tab-switcher" role="group">
                  <button
                    className={`set-tab-btn${admitMode === 'search' ? ' set-tab-btn--active' : ''}`}
                    onClick={() => { setAdmitMode('search'); setPlError(null) }}
                  >
                    Existing student
                  </button>
                  <button
                    className={`set-tab-btn${admitMode === 'create' ? ' set-tab-btn--active' : ''}`}
                    onClick={() => { setAdmitMode('create'); setPlError(null) }}
                  >
                    New student
                  </button>
                </div>

                {admitMode === 'search' ? (
                  <FieldRow label="Student">
                    {selectedStudent ? (
                      <div className="set-list-row">
                        <div className="set-list-row-info">
                          <p className="set-list-row-name">{selectedStudent.full_name}</p>
                          <p className="set-list-row-meta">{selectedStudent.matric_number ?? 'No matric number yet'}</p>
                        </div>
                        <button className="set-edit-btn" onClick={() => { setSelectedStudent(null); setStudentQuery('') }}>Change</button>
                      </div>
                    ) : (
                      <>
                        <input
                          type="text"
                          className="set-input set-search-input"
                          placeholder="Search by name or matric number…"
                          value={studentQuery}
                          onChange={e => setStudentQuery(e.target.value)}
                        />
                        {studentSearching && <p className="set-hint-text">Searching…</p>}
                        {!studentSearching && studentQuery.trim().length >= 2 && studentResults.length === 0 && (
                          <p className="set-empty-hint">No students match.</p>
                        )}
                        {studentResults.map(s => (
                          <div key={s.id} className="set-list-row" onClick={() => setSelectedStudent(s)} style={{ cursor: 'pointer' }}>
                            <div className="set-list-row-info">
                              <p className="set-list-row-name">{s.full_name}</p>
                              <p className="set-list-row-meta">{s.matric_number ?? 'No matric number yet'}</p>
                            </div>
                          </div>
                        ))}
                      </>
                    )}
                  </FieldRow>
                ) : (
                  <>
                    <FieldRow label="Full name"><Input value={newStudentName} onChange={setNewStudentName} placeholder="Student's full name" /></FieldRow>
                    <FieldRow label="Gender (optional)">
                      <select className="set-select" value={newStudentGender} onChange={e => setNewStudentGender(e.target.value)}>
                        <option value="">Not specified</option>
                        <option value="male">Male</option>
                        <option value="female">Female</option>
                      </select>
                    </FieldRow>
                    <FieldRow label="Date of birth (optional)"><Input value={newStudentDob} onChange={setNewStudentDob} type="date" /></FieldRow>
                    <p className="set-hint-text">Other details (address, guardians, photo, etc.) can be filled in afterward from the Students module.</p>
                  </>
                )}

                {plError && <p className="set-form-error">{plError}</p>}
                <div className="set-sheet-footer">
                  <button className="set-cancel-btn" onClick={closeAdmitForm}>Cancel</button>
                  <button className="set-save-btn" onClick={handleAdmit} disabled={plSaving || !currentSessionId}>
                    {plSaving ? 'Admitting…' : 'Admit'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// SESSION 65 — display labels for each selectable matric-number-format
// component, and a pure client-side preview of the shape (not a real
// generated number — that only ever happens server-side, build_matric_number(),
// migration_session_65.sql — this just shows the admin what pattern they're
// building, e.g. "NSC/DEPT/26/0001").
const MATRIC_COMPONENT_LABELS: Record<MatricNumberComponent['type'], string> = {
  programme_code: 'Programme code',
  faculty_code: 'Faculty code',
  department_code: 'Department code',
  session_year: 'Admission year',
  constant: 'Fixed text',
  sequence: 'Sequence number',
}

function previewMatricFormat(components: MatricNumberComponent[]): string {
  return components
    .map((c, i) => {
      const sep = i > 0 ? (c.separator ?? '') : ''
      let piece = ''
      switch (c.type) {
        case 'programme_code': piece = 'NSC'; break
        case 'faculty_code': piece = 'MED'; break
        case 'department_code': piece = 'DEPT'; break
        case 'session_year': piece = c.year_format === '4digit' ? '2026' : '26'; break
        case 'constant': piece = c.value || '—'; break
        case 'sequence': piece = '1'.padStart(c.digits ?? 3, '0'); break
      }
      return sep + piece
    })
    .join('')
}

const AWARD_TYPE_OPTIONS_SETTINGS = [
  { value: 'degree', label: 'Degree (B.Sc/B.A/B.Eng etc.)' },
  { value: 'hnd', label: 'HND' },
  { value: 'nd', label: 'ND' },
  { value: 'nce', label: 'NCE' },
  { value: 'pgd', label: 'PGD' },
  { value: 'other', label: 'Other' },
]

// §7.27.2: course_type is advisory only, no DB check constraint — this list
// is the UI's own convention, matching the four values named in the schema
// comment ('lecture' | 'lab' | 'practical' | 'tp').
const COURSE_TYPE_OPTIONS_SETTINGS = [
  { value: 'lecture', label: 'Lecture' },
  { value: 'lab', label: 'Lab' },
  { value: 'practical', label: 'Practical' },
  { value: 'tp', label: 'TP (Teaching Practice)' },
]

// ─── Tab: Curriculum ──────────────────────────────────────────────────────────
// §7.27.2 programme_curriculum — assigns courses (from the school-wide
// catalogue managed in InstitutionTab) into a specific programme/level, with
// an optional term when the school uses terms (term_id null otherwise, per
// §7.4's convention — see loadCurriculum's own comment in settingsService.ts).
// Picker chain: Programme → Level → (Term, only if the school has any) →
// list of core/elective entries with add/remove.

function CurriculumTab({ schoolId }: { schoolId: string }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [programmes, setProgrammes] = useState<Programme[]>([])
  const [levelsByProgramme, setLevelsByProgramme] = useState<Record<string, ProgrammeLevel[]>>({})
  const [courses, setCourses] = useState<Course[]>([])
  const [terms, setTerms] = useState<Term[]>([])

  const [selectedProgrammeId, setSelectedProgrammeId] = useState<string | null>(null)
  const [selectedLevelId, setSelectedLevelId] = useState<string | null>(null)
  const [selectedTermId, setSelectedTermId] = useState<string | null>(null)

  const [entries, setEntries] = useState<CurriculumEntry[]>([])
  const [entriesLoading, setEntriesLoading] = useState(false)

  // Add-entry form
  const [showAddForm, setShowAddForm] = useState(false)
  const [addCourseId, setAddCourseId] = useState<string | null>(null)
  const [addReqType, setAddReqType] = useState<'core' | 'elective'>('core')
  const [addPrereqId, setAddPrereqId] = useState<string | null>(null)
  const [addSaving, setAddSaving] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const [pRes, sessRes, cRes] = await Promise.all([
      loadProgrammes(schoolId),
      loadCurrentSession(schoolId),
      loadCourses(schoolId),
    ])
    if (pRes.error) { setError(pRes.error); setLoading(false); return }
    if (cRes.error) { setError(cRes.error); setLoading(false); return }
    setProgrammes(pRes.data)
    setCourses(cRes.data)
    const levelEntries = await Promise.all(
      pRes.data.map(async (prog) => [prog.id, (await loadProgrammeLevels(prog.id)).data] as const),
    )
    setLevelsByProgramme(Object.fromEntries(levelEntries))
    // Terms are only meaningful once we know the current session — a school
    // with uses_terms=false (or between sessions) simply has an empty terms
    // list, and the term picker below stays hidden rather than showing a
    // disabled/empty control (mirrors InstitutionTab's own between-sessions
    // handling for placements).
    if (!sessRes.error && sessRes.data) {
      const tRes = await loadTerms(schoolId, sessRes.data.id)
      if (!tRes.error) setTerms(tRes.data)
    }
    setLoading(false)
  }, [schoolId])

  useEffect(() => { load() }, [load])

  const loadEntries = useCallback(async () => {
    if (!selectedLevelId) { setEntries([]); return }
    setEntriesLoading(true)
    const res = await loadCurriculum(selectedLevelId, terms.length > 0 ? selectedTermId : null)
    setEntries(res.error ? [] : res.data)
    setEntriesLoading(false)
  }, [selectedLevelId, selectedTermId, terms.length])

  useEffect(() => { loadEntries() }, [loadEntries])

  const selectedLevels = selectedProgrammeId ? (levelsByProgramme[selectedProgrammeId] ?? []) : []

  function openAddForm() {
    setAddCourseId(null)
    setAddReqType('core')
    setAddPrereqId(null)
    setAddError(null)
    setShowAddForm(true)
  }

  async function handleAddEntry() {
    if (!selectedProgrammeId || !selectedLevelId) { setAddError('Choose a programme and level first.'); return }
    if (!addCourseId) { setAddError('Choose a course.'); return }
    setAddSaving(true)
    const res = await addCurriculumEntry({
      programme_id: selectedProgrammeId,
      programme_level_id: selectedLevelId,
      course_id: addCourseId,
      term_id: terms.length > 0 ? selectedTermId : null,
      requirement_type: addReqType,
      prerequisite_course_id: addPrereqId,
    })
    if (res.error) { setAddError(res.error); setAddSaving(false); return }
    setShowAddForm(false)
    setAddSaving(false)
    await loadEntries()
  }

  async function handleRemoveEntry(entryId: string) {
    const res = await removeCurriculumEntry(entryId)
    if (!res.error) await loadEntries()
  }

  if (loading) return <div className="set-tab-content"><p className="set-hint-text">Loading…</p></div>
  if (error) return <div className="set-tab-content"><p className="set-form-error">{error}</p></div>

  return (
    <div className="set-tab-content">
      <FieldRow label="Programme">
        <select
          className="set-select"
          value={selectedProgrammeId ?? ''}
          onChange={e => { setSelectedProgrammeId(e.target.value || null); setSelectedLevelId(null) }}
        >
          <option value="">Choose a programme</option>
          {programmes.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </FieldRow>

      {selectedProgrammeId && (
        <FieldRow label="Level">
          <select
            className="set-select"
            value={selectedLevelId ?? ''}
            onChange={e => setSelectedLevelId(e.target.value || null)}
          >
            <option value="">Choose a level</option>
            {selectedLevels.map(l => <option key={l.id} value={l.id}>{l.level_label}</option>)}
          </select>
        </FieldRow>
      )}

      {/* Term picker only appears when this school actually has terms
          defined for the current session — otherwise curriculum is scoped
          by session alone (term_id stays null throughout), per §7.4. */}
      {selectedLevelId && terms.length > 0 && (
        <FieldRow label="Term">
          <select
            className="set-select"
            value={selectedTermId ?? ''}
            onChange={e => setSelectedTermId(e.target.value || null)}
          >
            <option value="">Choose a term</option>
            {terms.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </FieldRow>
      )}

      {selectedLevelId && (terms.length === 0 || selectedTermId) && (
        <>
          <div className="set-section-header">
            <SectionLabel>Curriculum</SectionLabel>
            <button className="set-add-btn" onClick={openAddForm} disabled={courses.length === 0}>+ Add course</button>
          </div>
          {courses.length === 0 ? (
            <p className="set-empty-hint">No courses in the catalogue yet — add some in the Institution tab first.</p>
          ) : entriesLoading ? (
            <p className="set-hint-text">Loading…</p>
          ) : entries.length === 0 ? (
            <p className="set-empty-hint">No courses assigned yet for this {terms.length > 0 ? 'level/term' : 'level'}.</p>
          ) : (
            <>
              <p className="set-hint-text">
                {entries.reduce((sum, e) => sum + e.credit_units, 0)} total credit units
                {' · '}{entries.filter(e => e.requirement_type === 'core').length} core
                {' · '}{entries.filter(e => e.requirement_type === 'elective').length} elective
              </p>
              {entries.map(e => (
                <div key={e.id} className="set-list-row">
                  <div className="set-list-row-info">
                    <p className="set-list-row-name">{e.course_code} — {e.course_title}</p>
                    <p className="set-list-row-meta">
                      {e.credit_units} unit{e.credit_units === 1 ? '' : 's'}
                      {' · '}<span className="set-type-chip">{e.requirement_type}</span>
                      {e.prerequisite_course_code ? ` · Prerequisite: ${e.prerequisite_course_code}` : ''}
                    </p>
                  </div>
                  <button className="set-edit-btn" onClick={() => handleRemoveEntry(e.id)}>Remove</button>
                </div>
              ))}
            </>
          )}
        </>
      )}

      {selectedLevelId && terms.length > 0 && !selectedTermId && (
        <p className="set-empty-hint">Choose a term to view or edit that term's curriculum.</p>
      )}

      {showAddForm && (
        <div className="set-overlay" onClick={() => setShowAddForm(false)}>
          <div className="set-sheet" onClick={e => e.stopPropagation()}>
            <h2 className="set-sheet-title">Add course to curriculum</h2>
            <FieldRow label="Course">
              <select className="set-select" value={addCourseId ?? ''} onChange={e => setAddCourseId(e.target.value || null)}>
                <option value="">Choose a course</option>
                {courses
                  .filter(c => !entries.some(e => e.course_id === c.id))
                  .map(c => <option key={c.id} value={c.id}>{c.code} — {c.title}</option>)}
              </select>
            </FieldRow>
            <FieldRow label="Requirement type">
              <select className="set-select" value={addReqType} onChange={e => setAddReqType(e.target.value as 'core' | 'elective')}>
                <option value="core">Core</option>
                <option value="elective">Elective</option>
              </select>
            </FieldRow>
            <FieldRow label="Prerequisite (optional)">
              <select className="set-select" value={addPrereqId ?? ''} onChange={e => setAddPrereqId(e.target.value || null)}>
                <option value="">None</option>
                {courses.filter(c => c.id !== addCourseId).map(c => <option key={c.id} value={c.id}>{c.code} — {c.title}</option>)}
              </select>
            </FieldRow>
            {addError && <p className="set-form-error">{addError}</p>}
            <div className="set-sheet-footer">
              <button className="set-cancel-btn" onClick={() => setShowAddForm(false)}>Cancel</button>
              <button className="set-save-btn" onClick={handleAddEntry} disabled={addSaving}>{addSaving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Tab: Course offerings ─────────────────────────────────────────────────
//
// Unscheduled interim step before SESSION 60, PRD Tier 8 / Problem 8.7 —
// closes the gap SESSION 58's close-out surfaced: "no course_offerings
// creation UI exists anywhere ... every test in this session used a direct
// SQL insert." An offering is "this course, this session/term, this
// lecturer" — the real per-session object course_registrations and
// course_attendance_sessions both key off, distinct from the catalogue
// (courses, InstitutionTab) and the requirement structure (programme_
// curriculum, CurriculumTab above).
//
// course_offerings has no school_id column of its own — every write here
// is scoped purely by RLS (join through course_id -> courses.school_id,
// confirmed via direct SQL read before this was built, not assumed). The
// course/session/term pickers are still filtered to this school's own data
// via loadCourses()/loadSessions()/loadTerms(), so the UI can never even
// offer a cross-school id, though RLS is the real enforcement either way.
//
// venue_id is deliberately not exposed in this form — §7.15's venues table
// doesn't exist yet (Problem 8.4 not accepted); the column is nullable, so
// omitting it is correct, not a stopgap.
function OfferingsTab({ schoolId }: { schoolId: string }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [sessions, setSessions] = useState<Session[]>([])
  const [terms, setTerms] = useState<Term[]>([])
  const [courses, setCourses] = useState<Course[]>([])
  const [staff, setStaff] = useState<StaffListItem[]>([])

  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [selectedTermId, setSelectedTermId] = useState<string | null>(null)

  const [offerings, setOfferings] = useState<CourseOffering[]>([])
  const [offeringsLoading, setOfferingsLoading] = useState(false)

  const [showForm, setShowForm] = useState(false)
  const [editingOffering, setEditingOffering] = useState<CourseOffering | null>(null)
  const [fCourseId, setFCourseId] = useState<string | null>(null)
  const [fStaffId, setFStaffId] = useState<string | null>(null)
  const [fThreshold, setFThreshold] = useState('')
  const [fSaving, setFSaving] = useState(false)
  const [fError, setFError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const [sessRes, cRes, stRes, curRes] = await Promise.all([
      loadSessions(schoolId),
      loadCourses(schoolId),
      loadStaffWithRoles(schoolId),
      loadCurrentSession(schoolId),
    ])
    if (sessRes.error) { setError(sessRes.error); setLoading(false); return }
    if (cRes.error) { setError(cRes.error); setLoading(false); return }
    if (stRes.error) { setError(stRes.error); setLoading(false); return }
    setSessions(sessRes.data)
    setCourses(cRes.data)
    setStaff(stRes.data)
    // Default the picker to the current session, same convention
    // CurriculumTab uses for its own term default — an admin opening this
    // tab almost always wants to see/build the current session's offerings
    // first, not an empty picker.
    if (!curRes.error && curRes.data) setSelectedSessionId(curRes.data.id)
    else if (sessRes.data.length > 0) setSelectedSessionId(sessRes.data[0].id)
    setLoading(false)
  }, [schoolId])

  useEffect(() => { load() }, [load])

  const loadTermsForSession = useCallback(async () => {
    if (!selectedSessionId) { setTerms([]); return }
    const res = await loadTerms(schoolId, selectedSessionId)
    setTerms(res.error ? [] : res.data)
    setSelectedTermId(null)
  }, [schoolId, selectedSessionId])

  useEffect(() => { loadTermsForSession() }, [loadTermsForSession])

  const loadOfferingsList = useCallback(async () => {
    if (!selectedSessionId) { setOfferings([]); return }
    if (terms.length > 0 && !selectedTermId) { setOfferings([]); return }
    setOfferingsLoading(true)
    const res = await loadCourseOfferings(selectedSessionId, terms.length > 0 ? selectedTermId : null)
    setOfferings(res.error ? [] : res.data)
    setOfferingsLoading(false)
  }, [schoolId, selectedSessionId, selectedTermId, terms.length])

  useEffect(() => { loadOfferingsList() }, [loadOfferingsList])

  function openForm(o?: CourseOffering) {
    setEditingOffering(o ?? null)
    setFCourseId(o?.course_id ?? null)
    setFStaffId(o?.staff_id ?? null)
    setFThreshold(o?.attendance_eligibility_threshold_pct != null ? String(o.attendance_eligibility_threshold_pct) : '')
    setFError(null)
    setShowForm(true)
  }

  async function handleSave() {
    if (!selectedSessionId) { setFError('Choose a session first.'); return }
    if (!fCourseId) { setFError('Choose a course.'); return }
    let threshold: number | null = null
    if (fThreshold) {
      threshold = Number(fThreshold)
      if (Number.isNaN(threshold) || threshold < 0 || threshold > 100) {
        setFError('Eligibility threshold must be a percentage between 0 and 100.')
        return
      }
    }
    setFSaving(true)
    const res = await upsertCourseOffering({
      id: editingOffering?.id,
      course_id: fCourseId,
      session_id: selectedSessionId,
      term_id: terms.length > 0 ? selectedTermId : null,
      staff_id: fStaffId,
      attendance_eligibility_threshold_pct: threshold,
    })
    if (res.error) { setFError(res.error); setFSaving(false); return }
    setShowForm(false)
    setFSaving(false)
    await loadOfferingsList()
  }

  async function handleDelete(offeringId: string, label: string) {
    if (!confirm(`Delete the offering "${label}"? This cannot be undone if course registrations or attendance already reference it.`)) return
    setDeletingId(offeringId)
    const res = await deleteCourseOffering(offeringId)
    if (res.error) { alert(res.error); setDeletingId(null); return }
    setOfferings(prev => prev.filter(o => o.id !== offeringId))
    setDeletingId(null)
  }

  if (loading) return <Skeleton />
  if (error) return <ErrorState message={error} onRetry={load} />

  return (
    <div className="set-tab-content">
      <FieldRow label="Session">
        <select
          className="set-select"
          value={selectedSessionId ?? ''}
          onChange={e => setSelectedSessionId(e.target.value || null)}
        >
          <option value="">Choose a session</option>
          {sessions.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </FieldRow>

      {selectedSessionId && terms.length > 0 && (
        <FieldRow label="Term">
          <select
            className="set-select"
            value={selectedTermId ?? ''}
            onChange={e => setSelectedTermId(e.target.value || null)}
          >
            <option value="">Choose a term</option>
            {terms.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </FieldRow>
      )}

      {selectedSessionId && (terms.length === 0 || selectedTermId) && (
        <>
          <div className="set-section-header">
            <SectionLabel>Offerings</SectionLabel>
            <button className="set-add-btn" onClick={() => openForm()} disabled={courses.length === 0}>+ Add offering</button>
          </div>
          {courses.length === 0 ? (
            <p className="set-empty-hint">No courses in the catalogue yet — add some in the Institution tab first.</p>
          ) : offeringsLoading ? (
            <p className="set-hint-text">Loading…</p>
          ) : offerings.length === 0 ? (
            <p className="set-empty-hint">No offerings yet for this {terms.length > 0 ? 'session/term' : 'session'}.</p>
          ) : (
            offerings.map(o => (
              <div key={o.id} className="set-list-row">
                <div className="set-list-row-info">
                  <p className="set-list-row-name">{o.course_code} — {o.course_title}</p>
                  <p className="set-list-row-meta">
                    {o.staff_name ? `Lecturer: ${o.staff_name}` : 'No lecturer assigned'}
                    {o.attendance_eligibility_threshold_pct != null ? ` · ${o.attendance_eligibility_threshold_pct}% eligibility threshold` : ''}
                  </p>
                </div>
                <div className="set-list-row-actions">
                  <button className="set-edit-btn" onClick={() => openForm(o)}>Edit</button>
                  <button
                    className="set-delete-btn"
                    onClick={() => handleDelete(o.id, `${o.course_code} — ${o.course_title}`)}
                    disabled={deletingId === o.id}
                    aria-label={`Delete offering ${o.course_code}`}
                  >
                    <Icon name="x" size={16} />
                  </button>
                </div>
              </div>
            ))
          )}
        </>
      )}

      {selectedSessionId && terms.length > 0 && !selectedTermId && (
        <p className="set-empty-hint">Choose a term to view or add offerings for that term.</p>
      )}

      {showForm && (
        <div className="set-overlay" onClick={() => setShowForm(false)}>
          <div className="set-sheet" onClick={e => e.stopPropagation()}>
            <h2 className="set-sheet-title">{editingOffering ? 'Edit offering' : 'Add offering'}</h2>
            <FieldRow label="Course">
              <select className="set-select" value={fCourseId ?? ''} onChange={e => setFCourseId(e.target.value || null)}>
                <option value="">Choose a course</option>
                {courses.map(c => <option key={c.id} value={c.id}>{c.code} — {c.title}</option>)}
              </select>
            </FieldRow>
            <FieldRow label="Lecturer (optional)">
              <select className="set-select" value={fStaffId ?? ''} onChange={e => setFStaffId(e.target.value || null)}>
                <option value="">Unassigned</option>
                {staff.map(s => <option key={s.id} value={s.id}>{s.full_name}</option>)}
              </select>
            </FieldRow>
            <FieldRow label="Attendance eligibility threshold % (optional)">
              <Input value={fThreshold} onChange={v => setFThreshold(v.replace(/[^0-9.]/g, ''))} placeholder="e.g. 75" />
            </FieldRow>
            {fError && <p className="set-form-error">{fError}</p>}
            <div className="set-sheet-footer">
              <button className="set-cancel-btn" onClick={() => setShowForm(false)}>Cancel</button>
              <button className="set-save-btn" onClick={handleSave} disabled={fSaving}>{fSaving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Tab: Grading (grade scale + CGPA policy) ─────────────────────────────────
//
// PRD Tier 8 / Problem 8.7, SESSION 59, §7.27.4. Higher-ed-only (gated in
// buildTabs, above). Two independent sections on one tab, matching the size
// of the feature (neither alone is big enough to earn its own tab):
//   - Grade scale bands: multiple rows per school, add/edit/delete — same
//     shape as CalendarTab's periods list, template followed directly below
//     (set-list-row-actions with Edit + Delete buttons, window.confirm on
//     delete, hard delete per the catalogue/config carve-out already used
//     by deletePeriod/deleteRole/deleteStudentRole).
//   - CGPA policy: at most one row per school (cgpa_policy.school_id is
//     unique) — a plain settings form, not a list. loadCgpaPolicy()
//     returning { data: null } is expected or an "Other"-category school
//     that has never configured this (Phase 0 Decision 5) and is rendered
//     as an unfilled form, not an error.
//
// Numeric fields (min_pct, max_pct, grade_point, scale_max, credit loads)
// are held as raw strings during editing and coerced with Number() only at
// save time — the same pattern CurriculumTab's credit-units field uses,
// fixing the per-keystroke-coercion bug recorded for that field.
function GradingTab({ schoolId }: { schoolId: string }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [bands, setBands] = useState<GradeScaleBand[]>([])
  const [policy, setPolicy] = useState<CgpaPolicy | null>(null)

  // SESSION 60a: CA/exam component definitions (course_result_components).
  // Admin-only write per RLS (migration_session_60a.sql) — this tab is
  // already gated to isHigherInstitutionSchoolType admins by its own
  // parent (buildTabs()), so no additional client-side permission check
  // is added here; the RLS layer is the real enforcement per this file's
  // own convention throughout (settingsService.ts's own header: "schoolId
  // threaded on every call — never inferred client-side").
  const [components, setComponents] = useState<CourseResultComponent[]>([])
  const [showComponentForm, setShowComponentForm] = useState(false)
  const [editingComponent, setEditingComponent] = useState<CourseResultComponent | null>(null)
  const [cName, setCName] = useState('')
  const [cWeightPct, setCWeightPct] = useState('')
  const [cSaving, setCSaving] = useState(false)
  const [cError, setCError] = useState<string | null>(null)
  const [deletingComponentId, setDeletingComponentId] = useState<string | null>(null)

  // SESSION 60c: per-course override of the school-wide components above.
  // These are now folded into the SAME table (course_result_components,
  // course_id set) rather than a separate override table/type — so
  // `overrides` here is just CourseResultComponent[] filtered to one
  // course, loaded via loadCourseSpecificComponents(), and the "merged
  // preview" below is produced by the SAME mergeCourseResultComponents()
  // function finalizeWeightedCourseResult() uses server-side, so the two
  // can never disagree.
  //
  // `courses` is loaded once alongside everything else in `load()` below
  // (loadCourses() already exists at module scope, reused as-is — same
  // precedent noted in the cross-import comment for why this table's own
  // CRUD lives in courseResultsService.ts but the *course list* itself
  // still comes from settingsService.ts, since Course is a general
  // catalogue entity this tab doesn't own). `overrides` is reloaded
  // whenever `selectedCourseId` changes, not upfront for every course —
  // a school could have hundreds of courses and only a handful with real
  // overrides, so loading all of them eagerly would be wasted reads for
  // the common case of "most courses use the school-wide set as-is."
  const [courses, setCourses] = useState<Course[]>([])
  const [selectedCourseId, setSelectedCourseId] = useState<string>('')
  const [overrides, setOverrides] = useState<CourseResultComponent[]>([])
  const [overridesLoading, setOverridesLoading] = useState(false)
  const [overridesError, setOverridesError] = useState<string | null>(null)
  const [showOverrideForm, setShowOverrideForm] = useState(false)
  const [editingOverride, setEditingOverride] = useState<ResolvedCourseResultComponent | null>(null)
  const [ovName, setOvName] = useState('')
  const [ovWeightPct, setOvWeightPct] = useState('')
  const [ovSaving, setOvSaving] = useState(false)
  const [ovError, setOvError] = useState<string | null>(null)
  const [deletingOverrideId, setDeletingOverrideId] = useState<string | null>(null)
  // Merged/effective set for the currently selected course — resolved via
  // resolveCourseResultComponents(schoolId, selectedCourseId), same
  // function CourseResultsModule.tsx's scoring grid and
  // finalizeWeightedCourseResult() both call. School-wide rows (source:
  // 'school') are shown here for CONTEXT ONLY — this screen must never
  // write to the real school-wide row (that would silently rebalance
  // every other course that inherits it). "Editing" a school-derived row
  // from here always creates/updates a course-SPECIFIC row of the same
  // name (courseId: selectedCourseId), which by-name-overrides the
  // school-wide value for THIS course only, leaving the real school-wide
  // row untouched. A true global edit stays reachable only from the
  // school-wide section above.
  const [mergedPreview, setMergedPreview] = useState<ResolvedCourseResultComponent[]>([])

  // Add/edit grade band form
  const [showBandForm, setShowBandForm] = useState(false)
  const [editingBand, setEditingBand] = useState<GradeScaleBand | null>(null)
  const [bLabel, setBLabel] = useState('')
  const [bMinPct, setBMinPct] = useState('')
  const [bMaxPct, setBMaxPct] = useState('')
  const [bGradePoint, setBGradePoint] = useState('')
  const [bScaleMax, setBScaleMax] = useState('5')
  const [bRemark, setBRemark] = useState('')
  // Defaults true for a brand-new band (the common case — most bands pass).
  // For an existing band being edited, openBandForm() below overwrites this
  // from the real stored value, never from this default.
  const [bIsPassing, setBIsPassing] = useState(true)
  const [bSaving, setBSaving] = useState(false)
  const [bError, setBError] = useState<string | null>(null)
  const [deletingBandId, setDeletingBandId] = useState<string | null>(null)

  // CGPA policy form — held as its own editable draft, separate from the
  // loaded `policy`, so "no policy configured yet" still renders a normal
  // (empty) form rather than a hint-only state; same reasoning InstitutionTab
  // uses for a school with no programmes yet.
  const [rollupMethod, setRollupMethod] = useState<'weighted_all_attempts' | 'average_of_semester_gpas' | ''>('')
  const [retakeTreatment, setRetakeTreatment] = useState<'replacement' | 'dilution' | ''>('')
  const [minCreditLoad, setMinCreditLoad] = useState('')
  const [maxCreditLoad, setMaxCreditLoad] = useState('')
  const [policySaving, setPolicySaving] = useState(false)
  const [policyError, setPolicyError] = useState<string | null>(null)
  const [policySaved, setPolicySaved] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const [bRes, pRes, cRes, coursesRes] = await Promise.all([
      loadHigherEdGradeScale(schoolId),
      loadCgpaPolicy(schoolId),
      loadCourseResultComponents(schoolId),
      loadCourses(schoolId),
    ])
    if (bRes.error) { setError(bRes.error); setLoading(false); return }
    if (pRes.error) { setError(pRes.error); setLoading(false); return }
    if (cRes.error) { setError(cRes.error); setLoading(false); return }
    if (coursesRes.error) { setError(coursesRes.error); setLoading(false); return }
    setBands(bRes.data)
    setPolicy(pRes.data)
    setComponents(cRes.data)
    setCourses(coursesRes.data)
    setRollupMethod(pRes.data?.rollup_method ?? '')
    setRetakeTreatment(pRes.data?.retake_treatment ?? '')
    setMinCreditLoad(pRes.data?.min_credit_load != null ? String(pRes.data.min_credit_load) : '')
    setMaxCreditLoad(pRes.data?.max_credit_load != null ? String(pRes.data.max_credit_load) : '')
    setLoading(false)
  }, [schoolId])

  useEffect(() => { load() }, [load])

  // SESSION 60c: reload overrides whenever the selected course changes.
  // Guarded on schoolId's own boot (courses must exist to select one), and
  // clears overrides immediately on an empty selection rather than leaving
  // stale data from a previously-selected course visible.
  const loadOverridesForSelectedCourse = useCallback(async () => {
    if (!selectedCourseId) { setOverrides([]); setMergedPreview([]); return }
    setOverridesLoading(true)
    setOverridesError(null)
    const [ownRes, mergedRes] = await Promise.all([
      loadCourseSpecificComponents(selectedCourseId),
      resolveCourseResultComponents(schoolId, selectedCourseId),
    ])
    if (ownRes.error) { setOverridesError(ownRes.error); setOverridesLoading(false); return }
    if (mergedRes.error) { setOverridesError(mergedRes.error); setOverridesLoading(false); return }
    setOverrides(ownRes.data)
    setMergedPreview(mergedRes.data)
    setOverridesLoading(false)
  }, [selectedCourseId, schoolId])

  useEffect(() => { loadOverridesForSelectedCourse() }, [loadOverridesForSelectedCourse])

  function openBandForm(b?: GradeScaleBand) {
    setEditingBand(b ?? null)
    setBLabel(b?.grade_label ?? '')
    setBMinPct(b?.min_score != null ? String(b.min_score) : '')
    setBMaxPct(b?.max_score != null ? String(b.max_score) : '')
    setBGradePoint(b?.grade_point != null ? String(b.grade_point) : '')
    setBScaleMax(b?.scale_max != null ? String(b.scale_max) : (bands[0]?.scale_max != null ? String(bands[0].scale_max) : '5'))
    setBRemark(b?.remark ?? '')
    // b.is_passing is only genuinely null for a legacy row the migration's
    // backfill never touched (pre-existing secondary-school shape) — not
    // expected here since this form is higher-ed only, but falling back to
    // the same grade_point > 0 guess the migration itself used keeps this
    // form never silently blank/unset rather than assuming true or false.
    setBIsPassing(b?.is_passing ?? (b?.grade_point != null ? b.grade_point > 0 : true))
    setBError(null)
    setShowBandForm(true)
  }

  async function handleSaveBand() {
    if (!bLabel) { setBError('Grade letter is required.'); return }
    const minPct = Number(bMinPct)
    const maxPct = Number(bMaxPct)
    const gradePoint = Number(bGradePoint)
    const scaleMax = Number(bScaleMax)
    if (!bMinPct || !bMaxPct || Number.isNaN(minPct) || Number.isNaN(maxPct)) {
      setBError('Min and max percentage are required numbers.')
      return
    }
    if (minPct < 0 || maxPct > 100 || minPct > maxPct) {
      setBError('Percentage range must be between 0 and 100, with min ≤ max.')
      return
    }
    if (!bGradePoint || Number.isNaN(gradePoint) || gradePoint < 0) {
      setBError('Grade point is required and must be 0 or more.')
      return
    }
    if (!bScaleMax || Number.isNaN(scaleMax) || scaleMax <= 0) {
      setBError('Scale max (e.g. 5.0 or 4.0) is required.')
      return
    }
    setBSaving(true)
    const res = await upsertHigherEdGradeBand(schoolId, {
      id: editingBand?.id,
      min_score: minPct,
      max_score: maxPct,
      grade_label: bLabel,
      grade_point: gradePoint,
      scale_max: scaleMax,
      remark: bRemark || null,
      sort_order: editingBand?.sort_order ?? bands.length,
      is_passing: bIsPassing,
    })
    if (res.error) { setBError(res.error); setBSaving(false); return }
    setShowBandForm(false)
    setBSaving(false)
    await load()
  }

  async function handleDeleteBand(bandId: string, label: string) {
    if (!confirm(`Delete the "${label}" grade band?`)) return
    setDeletingBandId(bandId)
    const res = await deleteHigherEdGradeBand(schoolId, bandId)
    if (res.error) { alert(res.error); setDeletingBandId(null); return }
    setBands(prev => prev.filter(b => b.id !== bandId))
    setDeletingBandId(null)
  }

  function openComponentForm(c?: CourseResultComponent) {
    setEditingComponent(c ?? null)
    setCName(c?.name ?? '')
    setCWeightPct(c?.weight_pct != null ? String(c.weight_pct) : '')
    setCError(null)
    setShowComponentForm(true)
  }

  /**
   * Sum-to-100 is a genuine invariant of the *finished* set, not of any one
   * save — building a set is inherently incremental (add "CA" at 10%, save,
   * then add "Exam" at 90%, save), and every intermediate save along the
   * way is legitimately off from 100% until the last piece lands. Blocking
   * the save itself at every intermediate step made it impossible to build
   * a set at all (caught 2026-07-15: editing a lone "CA" component at 10%
   * was hard-rejected with no way to save it before a second component
   * existed to bring the total up).
   *
   * This is exactly the "mid-edit intermediate state" problem migration_
   * session_60a.sql's own header already named as the reason a plain CHECK
   * constraint can't enforce this at the DB layer (it needs a deferred
   * CONSTRAINT TRIGGER instead, still not built — flagged there as a
   * follow-up). The fix here brings the client-side check in line with
   * that same reasoning: WARN, don't block, on save. The real hard
   * enforcement point is finalizeWeightedCourseResult() in
   * courseResultsService.ts, which already refuses to finalize a score
   * against an incomplete component set (missing-component check) — that
   * function is extended below to also refuse finalizing against a set
   * whose weights don't sum to 100%, so a misconfigured set can never
   * silently produce a wrong score, even though it CAN be saved
   * mid-configuration.
   *
   * Computed against what the *saved set* would become after this save —
   * i.e. every other existing component's weight, plus this one's new
   * value (replacing its own prior weight if editing, not double-counted).
   */
  function projectedWeightSum(newWeight: number): number {
    const others = components.filter((c) => c.id !== editingComponent?.id)
    return others.reduce((sum, c) => sum + c.weight_pct, 0) + newWeight
  }

  async function handleSaveComponent() {
    if (!cName.trim()) { setCError('Component name is required.'); return }
    const weight = Number(cWeightPct)
    if (!cWeightPct || Number.isNaN(weight) || weight < 0 || weight > 100) {
      setCError('Weight must be a number between 0 and 100.')
      return
    }
    // No sum-to-100 block here — see projectedWeightSum's header. The
    // non-blocking projected-total line in the render below (already
    // present) keeps the admin informed while building the set; nothing
    // here prevents saving an intermediate, not-yet-100% state.
    setCError(null)
    setCSaving(true)
    const res = await upsertCourseResultComponent(schoolId, {
      id: editingComponent?.id,
      name: cName.trim(),
      weight_pct: weight,
      sort_order: editingComponent?.sort_order ?? components.length,
    })
    if (res.error) { setCError(res.error); setCSaving(false); return }
    setShowComponentForm(false)
    setCSaving(false)
    await load()
  }

  async function handleDeleteComponent(componentId: string, name: string) {
    if (!confirm(`Delete the "${name}" component? Any entered scores for it will block this delete until removed.`)) return
    setDeletingComponentId(componentId)
    const res = await deleteCourseResultComponent(componentId)
    if (res.error) {
      // A foreign-key violation here means real course_result_component_scores
      // rows still reference this component (deleteCourseResultComponent's
      // own header documents this as expected, correct behavior, not a bug
      // to work around) — surfaced plainly rather than silently swallowed.
      alert(res.error)
      setDeletingComponentId(null)
      return
    }
    setComponents((prev) => prev.filter((c) => c.id !== componentId))
    setDeletingComponentId(null)
  }

  // ─── SESSION 60c: per-course override handlers ──────────────────────────
  // Operates on the MERGED preview (mergedPreview, ResolvedCourseResultComponent[])
  // so school-wide rows are visible here for context alongside this
  // course's own overrides. CRITICAL: this screen must NEVER write to a
  // real school-wide row (courseId: null) — doing so silently changes the
  // weight for every course that inherits it, not just the one selected
  // here. "Editing" ANY row from this screen — whether it started as
  // `source: 'school'` or `source: 'course'` — always writes a
  // course-specific row (courseId: selectedCourseId), pre-filled with the
  // row's current effective weight. For a `source: 'school'` row this
  // creates a new course-specific override with the same name, which the
  // existing by-name merge rule then uses to shadow the school-wide value
  // for this course only — the school-wide row itself is left untouched.
  // A true global edit is only reachable from the school-wide section
  // above, never from here.

  function openOverrideForm(c?: ResolvedCourseResultComponent) {
    setEditingOverride(c ?? null)
    setOvName(c?.name ?? '')
    setOvWeightPct(c?.weight_pct != null ? String(c.weight_pct) : '')
    setOvError(null)
    setShowOverrideForm(true)
  }

  /**
   * Merged-set preview for the override form — same non-blocking,
   * warn-don't-block posture as projectedWeightSum() above, and for the
   * same reason: an override set is built incrementally too (e.g. add
   * "Practical" at 20% today, come back and reweight "CA"/"Exam" tomorrow
   * to make room for it). The REAL enforcement point remains
   * finalizeWeightedCourseResult() server-side, which calls
   * resolveCourseResultComponents() — the same merge function used here —
   * so this preview and finalize-time truth can never disagree.
   */
  function projectedMergedWeightSum(newWeight: number): number {
    // Editing (or adding) from this screen ALWAYS projects a
    // course-specific override row, never a change to the school-wide
    // set itself — see the handler block comment above. If the row being
    // edited started as `source: 'school'`, its id belongs to the
    // school-wide table, so it must NOT be matched against `overrides`
    // (this course's own rows) when de-duping the draft; it simply adds a
    // new course-specific row with the same name, which by-name-overrides
    // the untouched school-wide value in the merge below.
    const isEditingSchoolRow = editingOverride?.source === 'school'
    const draftOverrides = overrides
      .filter((o) => o.id !== (isEditingSchoolRow ? '__never_match__' : editingOverride?.id))
      .concat([{
        id: editingOverride?.id ?? '__draft__',
        school_id: schoolId,
        course_id: selectedCourseId,
        name: ovName.trim(),
        weight_pct: newWeight,
        sort_order: editingOverride?.sort_order ?? overrides.length,
      }])
    const merged = mergeCourseResultComponents(components, draftOverrides)
    return merged.reduce((sum, c) => sum + c.weight_pct, 0)
  }

  async function handleSaveOverride() {
    if (!selectedCourseId) { setOvError('Select a course first.'); return }
    if (!ovName.trim()) { setOvError('Component name is required.'); return }
    const weight = Number(ovWeightPct)
    if (!ovWeightPct || Number.isNaN(weight) || weight < 0 || weight > 100) {
      setOvError('Weight must be a number between 0 and 100.')
      return
    }
    const isEditingSchoolRow = editingOverride?.source === 'school'
    setOvError(null)
    setOvSaving(true)
    const res = await upsertCourseResultComponent(schoolId, {
      // A `source: 'school'` row's id belongs to the school-wide table —
      // passing it as `id` here would UPDATE that real school-wide row.
      // Omit it so this always INSERTs a new, course-specific row instead
      // (by-name-overriding the school-wide value for this course only).
      // Only a genuine `source: 'course'` row's id is safe to reuse for
      // an update, since that id already belongs to this course.
      id: isEditingSchoolRow ? undefined : editingOverride?.id,
      name: ovName.trim(),
      weight_pct: weight,
      sort_order: editingOverride?.sort_order ?? mergedPreview.length,
      // ALWAYS scoped to this course — this screen never writes the
      // real school-wide row (courseId: null). A true global edit is
      // only reachable from the school-wide section above.
      courseId: selectedCourseId,
    })
    if (res.error) { setOvError(res.error); setOvSaving(false); return }
    setShowOverrideForm(false)
    setOvSaving(false)
    // Only this course's own rows changed — no need to reload the
    // school-wide `components` list, since it was never touched.
    await loadOverridesForSelectedCourse()
  }

  async function handleDeleteOverride(c: ResolvedCourseResultComponent) {
    // A `source: 'school'` row's id is the REAL school-wide component's
    // id — this screen must never delete it (that would remove it for
    // every course school-wide, from a per-course screen). There's also
    // nothing course-specific to "remove" for an inherited row that
    // isn't already overridden here, so this action is simply unavailable
    // for school rows; the render below doesn't offer a delete button for
    // them, but this guard exists so this function can never be called
    // that way even indirectly.
    if (c.source === 'school') return
    if (!confirm(`Remove the "${c.name}" override for this course? It will revert to the school-wide value.`)) return
    setDeletingOverrideId(c.id)
    const res = await deleteCourseResultComponent(c.id)
    if (res.error) {
      alert(res.error)
      setDeletingOverrideId(null)
      return
    }
    await loadOverridesForSelectedCourse()
    setDeletingOverrideId(null)
  }

  async function handleSavePolicy() {
    setPolicySaved(false)
    if (!rollupMethod) { setPolicyError('Choose a CGPA roll-up method.'); return }
    if (!retakeTreatment) { setPolicyError('Choose how retakes are treated.'); return }
    const minLoad = minCreditLoad ? Number(minCreditLoad) : null
    const maxLoad = maxCreditLoad ? Number(maxCreditLoad) : null
    if (minCreditLoad && (minLoad === null || Number.isNaN(minLoad) || minLoad < 0)) {
      setPolicyError('Min credit load must be a non-negative number.')
      return
    }
    if (maxCreditLoad && (maxLoad === null || Number.isNaN(maxLoad) || maxLoad < 0)) {
      setPolicyError('Max credit load must be a non-negative number.')
      return
    }
    if (minLoad !== null && maxLoad !== null && minLoad > maxLoad) {
      setPolicyError('Min credit load cannot exceed max credit load.')
      return
    }
    setPolicyError(null)
    setPolicySaving(true)
    const res = await upsertCgpaPolicy(schoolId, {
      rollup_method: rollupMethod,
      retake_treatment: retakeTreatment,
      min_credit_load: minLoad,
      max_credit_load: maxLoad,
    })
    if (res.error) { setPolicyError(res.error); setPolicySaving(false); return }
    setPolicySaving(false)
    setPolicySaved(true)
    await load()
  }

  if (loading) return <Skeleton />
  if (error) return <ErrorState message={error} onRetry={load} />

  return (
    <div className="set-tab-content">
      <div className="set-section-header">
        <SectionLabel>Grade scale</SectionLabel>
        <button className="set-add-btn" onClick={() => openBandForm()}>+ Add band</button>
      </div>

      {bands.length === 0 ? (
        <p className="set-empty-hint">No grade bands yet. Add one for each letter grade — e.g. A: 70–100, 5.0 points.</p>
      ) : (
        bands.map(b => (
          <div key={b.id} className="set-list-row">
            <div className="set-list-row-info">
              <p className="set-list-row-name">{b.grade_label}</p>
              <p className="set-list-row-meta">
                {b.min_score}–{b.max_score}%
                {b.grade_point != null ? ` · ${b.grade_point} pts` : ''}
                {b.scale_max != null ? ` (of ${b.scale_max})` : ''}
                {b.remark ? ` · ${b.remark}` : ''}
                {b.is_passing === null ? '' : b.is_passing ? ' · Passing' : ' · Fails (carryover)'}
              </p>
            </div>
            <div className="set-list-row-actions">
              <button className="set-edit-btn" onClick={() => openBandForm(b)}>Edit</button>
              <button
                className="set-delete-btn"
                onClick={() => handleDeleteBand(b.id, b.grade_label)}
                disabled={deletingBandId === b.id}
                aria-label={`Delete grade band ${b.grade_label}`}
              >
                <Icon name="x" size={16} />
              </button>
            </div>
          </div>
        ))
      )}

      <div className="set-section-header" style={{ marginTop: '2rem' }}>
        <SectionLabel>CGPA policy</SectionLabel>
      </div>
      <p className="set-hint-text">Applies once, school-wide. Controls how course results roll up into a student's GPA and CGPA.</p>

      <FieldRow label="Roll-up method">
        <select
          className="set-select"
          value={rollupMethod}
          onChange={e => { setRollupMethod(e.target.value as typeof rollupMethod); setPolicySaved(false) }}
        >
          <option value="">Choose a method</option>
          <option value="weighted_all_attempts">Weighted across all attempts</option>
          <option value="average_of_semester_gpas">Average of semester GPAs</option>
        </select>
      </FieldRow>

      <FieldRow label="Retake treatment">
        <select
          className="set-select"
          value={retakeTreatment}
          onChange={e => { setRetakeTreatment(e.target.value as typeof retakeTreatment); setPolicySaved(false) }}
        >
          <option value="">Choose a treatment</option>
          <option value="replacement">Replacement (retake score replaces the original)</option>
          <option value="dilution">Dilution (both attempts count toward CGPA)</option>
        </select>
      </FieldRow>

      <FieldRow label="Min credit load (optional)">
        <Input value={minCreditLoad} onChange={v => { setMinCreditLoad(v.replace(/[^0-9]/g, '')); setPolicySaved(false) }} placeholder="e.g. 15" />
      </FieldRow>
      <FieldRow label="Max credit load (optional)">
        <Input value={maxCreditLoad} onChange={v => { setMaxCreditLoad(v.replace(/[^0-9]/g, '')); setPolicySaved(false) }} placeholder="e.g. 24" />
      </FieldRow>

      {policyError && <p className="set-form-error">{policyError}</p>}
      {policySaved && !policyError && <p className="set-hint-text">Saved.</p>}
      <div className="set-sheet-footer" style={{ paddingLeft: 0 }}>
        <button className="set-save-btn" onClick={handleSavePolicy} disabled={policySaving}>
          {policySaving ? 'Saving…' : policy ? 'Update policy' : 'Save policy'}
        </button>
      </div>

      <div className="set-section-header" style={{ marginTop: '2rem' }}>
        <SectionLabel>CA/exam components</SectionLabel>
        <button className="set-add-btn" onClick={() => openComponentForm()}>+ Add component</button>
      </div>
      <p className="set-hint-text">
        School-wide weighted components (e.g. CA 40% / Exam 60%) used to score every course. Weights must sum to exactly 100%.
        {components.length > 0 && (
          <> Current total: <strong>{components.reduce((sum, c) => sum + c.weight_pct, 0).toFixed(2)}%</strong></>
        )}
      </p>

      {components.length === 0 ? (
        <p className="set-empty-hint">No components defined yet. Lecturers can't score courses until at least one set summing to 100% exists — e.g. CA 40%, Exam 60%.</p>
      ) : (
        components.map((c) => (
          <div key={c.id} className="set-list-row">
            <div className="set-list-row-info">
              <p className="set-list-row-name">{c.name}</p>
              <p className="set-list-row-meta">{c.weight_pct}%</p>
            </div>
            <div className="set-list-row-actions">
              <button className="set-edit-btn" onClick={() => openComponentForm(c)}>Edit</button>
              <button
                className="set-delete-btn"
                onClick={() => handleDeleteComponent(c.id, c.name)}
                disabled={deletingComponentId === c.id}
                aria-label={`Delete component ${c.name}`}
              >
                <Icon name="x" size={16} />
              </button>
            </div>
          </div>
        ))
      )}

      {showComponentForm && (
        <div className="set-overlay" onClick={() => setShowComponentForm(false)}>
          <div className="set-sheet" onClick={(e) => e.stopPropagation()}>
            <h2 className="set-sheet-title">{editingComponent ? 'Edit component' : 'Add component'}</h2>
            <FieldRow label="Name">
              <Input value={cName} onChange={setCName} placeholder="e.g. CA, Exam, Practical" />
            </FieldRow>
            <FieldRow label="Weight %">
              <Input value={cWeightPct} onChange={(v) => setCWeightPct(v.replace(/[^0-9.]/g, ''))} placeholder="e.g. 40" />
            </FieldRow>
            <p className="set-hint-text">
              With this value, all components would total{' '}
              <strong>{cWeightPct && !Number.isNaN(Number(cWeightPct)) ? projectedWeightSum(Number(cWeightPct)).toFixed(2) : '—'}%</strong>
              {' '}(must reach 100% before lecturers can finalize scores — you can still save while building the set up).
            </p>
            {cError && <p className="set-form-error">{cError}</p>}
            <div className="set-sheet-footer">
              <button className="set-cancel-btn" onClick={() => setShowComponentForm(false)}>Cancel</button>
              <button className="set-save-btn" onClick={handleSaveComponent} disabled={cSaving}>{cSaving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}

      {/* SESSION 60c: per-course override of the school-wide set above. A
          course with no overrides here simply inherits the school-wide set
          untouched — this section is opt-in per course, not a second
          required config step. */}
      <div className="set-section-header" style={{ marginTop: '2rem' }}>
        <SectionLabel>Per-course overrides</SectionLabel>
      </div>
      <p className="set-hint-text">
        Override component weights for one course, or add a course-specific component (e.g. "Practical") on top of the school-wide set.
        A course with no overrides here uses the school-wide set as-is.
      </p>
      <FieldRow label="Course">
        <select className="set-select" value={selectedCourseId} onChange={(e) => setSelectedCourseId(e.target.value)}>
          <option value="">Choose a course</option>
          {courses.map((c) => <option key={c.id} value={c.id}>{c.code} — {c.title}</option>)}
        </select>
      </FieldRow>

      {selectedCourseId && (
        <>
          {overridesLoading ? (
            <Skeleton />
          ) : overridesError ? (
            <ErrorState message={overridesError} onRetry={loadOverridesForSelectedCourse} />
          ) : (
            <>
              <div className="set-section-header" style={{ marginTop: '1rem' }}>
                <p className="set-hint-text" style={{ margin: 0 }}>
                  Effective set for this course (school-wide + overrides): current total{' '}
                  <strong>
                    {mergedPreview.reduce((sum, c) => sum + c.weight_pct, 0).toFixed(2)}%
                  </strong>
                </p>
                <button className="set-add-btn" onClick={() => openOverrideForm()}>+ Add course-specific component</button>
              </div>

              {mergedPreview.map((c) => (
                <div key={c.id} className="set-list-row">
                  <div className="set-list-row-info">
                    <p className="set-list-row-name">
                      {c.name}
                      {c.source === 'course' && ' (course-specific)'}
                      {c.source === 'school' && ' (school-wide)'}
                    </p>
                    <p className="set-list-row-meta">{c.weight_pct}%</p>
                  </div>
                  <div className="set-list-row-actions">
                    <button
                      className="set-edit-btn"
                      onClick={() => openOverrideForm(c)}
                      title={c.source === 'school' ? 'Create a course-specific override for this course only — the school-wide value is not changed' : undefined}
                    >
                      {c.source === 'school' ? 'Override for this course' : 'Edit'}
                    </button>
                    {c.source === 'course' && (
                      <button
                        className="set-delete-btn"
                        onClick={() => handleDeleteOverride(c)}
                        disabled={deletingOverrideId === c.id}
                        aria-label={`Remove ${c.name}`}
                      >
                        <Icon name="x" size={16} />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </>
          )}
        </>
      )}

      {showOverrideForm && (
        <div className="set-overlay" onClick={() => setShowOverrideForm(false)}>
          <div className="set-sheet" onClick={(e) => e.stopPropagation()}>
            <h2 className="set-sheet-title">
              {editingOverride
                ? (editingOverride.source === 'school' ? `Override "${editingOverride.name}" for this course` : 'Edit course-specific component')
                : 'Add course-specific component'}
            </h2>
            {editingOverride?.source === 'school' ? (
              <p className="set-hint-text">
                This creates a course-specific "{editingOverride.name}" for this course only — the school-wide value stays {editingOverride.weight_pct}% for every other course.
              </p>
            ) : (
              <p className="set-hint-text">
                Name matching a school-wide component (e.g. "CA") replaces its weight for this course only. A new name (e.g. "Practical") adds a course-specific component.
              </p>
            )}
            <FieldRow label="Name">
              <Input value={ovName} onChange={setOvName} placeholder="e.g. CA, Exam, Practical" />
            </FieldRow>
            <FieldRow label="Weight %">
              <Input value={ovWeightPct} onChange={(v) => setOvWeightPct(v.replace(/[^0-9.]/g, ''))} placeholder="e.g. 20" />
            </FieldRow>
            <p className="set-hint-text">
              With this value, this course's effective set would total{' '}
              <strong>{ovWeightPct && !Number.isNaN(Number(ovWeightPct)) ? projectedMergedWeightSum(Number(ovWeightPct)).toFixed(2) : '—'}%</strong>
              {' '}(must reach 100% before lecturers can finalize scores for this course — you can still save while building the set up).
            </p>
            {ovError && <p className="set-form-error">{ovError}</p>}
            <div className="set-sheet-footer">
              <button className="set-cancel-btn" onClick={() => setShowOverrideForm(false)}>Cancel</button>
              <button className="set-save-btn" onClick={handleSaveOverride} disabled={ovSaving}>{ovSaving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}

      {showBandForm && (
        <div className="set-overlay" onClick={() => setShowBandForm(false)}>
          <div className="set-sheet" onClick={e => e.stopPropagation()}>
            <h2 className="set-sheet-title">{editingBand ? 'Edit grade band' : 'Add grade band'}</h2>
            <FieldRow label="Letter grade">
              <Input value={bLabel} onChange={setBLabel} placeholder="e.g. A, B, C, F" />
            </FieldRow>
            <FieldRow label="Min %">
              <Input value={bMinPct} onChange={v => setBMinPct(v.replace(/[^0-9.]/g, ''))} placeholder="e.g. 70" />
            </FieldRow>
            <FieldRow label="Max %">
              <Input value={bMaxPct} onChange={v => setBMaxPct(v.replace(/[^0-9.]/g, ''))} placeholder="e.g. 100" />
            </FieldRow>
            <FieldRow label="Grade point">
              <Input value={bGradePoint} onChange={v => setBGradePoint(v.replace(/[^0-9.]/g, ''))} placeholder="e.g. 5.0" />
            </FieldRow>
            <FieldRow label="Scale max">
              <Input value={bScaleMax} onChange={v => setBScaleMax(v.replace(/[^0-9.]/g, ''))} placeholder="e.g. 5.0 or 4.0" />
            </FieldRow>
            <FieldRow label="Remark (optional)">
              <Input value={bRemark} onChange={setBRemark} placeholder="e.g. Excellent, Fail" />
            </FieldRow>
            <FieldRow label="Counts as passing">
              <Toggle
                checked={bIsPassing}
                onChange={setBIsPassing}
                label="This band counts as a passing grade"
              />
            </FieldRow>
            <p className="set-hint-text">
              Determines carryover, not the grade point value — a low but positive
              grade point (e.g. a D) can still be marked failing if your program
              requires it. Unrelated to whether this band earns GPA credit.
            </p>
            {bError && <p className="set-form-error">{bError}</p>}
            <div className="set-sheet-footer">
              <button className="set-cancel-btn" onClick={() => setShowBandForm(false)}>Cancel</button>
              <button className="set-save-btn" onClick={handleSaveBand} disabled={bSaving}>{bSaving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Tab: Academic standing ────────────────────────────────────────────────────
//
// PRD Tier 8 / Problem 8.7, SESSION 61, §7.27.5. One row per school
// (academic_standing_rules, unique on school_id) — same shape and same
// Decision 5 discipline as CgpaPolicy in GradingTab above: no threshold is
// ever smart-defaulted, and loadAcademicStandingRules() returning
// { data: null } is a normal "not configured yet" state, not an error.
// This tab only configures the rule THRESHOLDS; the evaluation flow that
// reads them and generates review-pending academic_standing_events rows is
// SESSION 62, deliberately out of scope here (§10 Session Task Breakdown,
// SESSION 61's own "Exactly what to do" list stops at the settings UI).

function StandingTab({ schoolId, actorRecordId }: { schoolId: string; actorRecordId: string | null }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [rules, setRules] = useState<AcademicStandingRules | null>(null)

  // Held as its own editable draft, separate from the loaded `rules`, so
  // "no rules configured yet" still renders a normal (empty) form rather
  // than a hint-only state — same reasoning GradingTab's CGPA-policy form
  // and InstitutionTab (school with no programmes yet) both already use.
  const [probationCgpaThreshold, setProbationCgpaThreshold] = useState('')
  const [withdrawalCgpaThreshold, setWithdrawalCgpaThreshold] = useState('')
  const [maxCarryoverCourses, setMaxCarryoverCourses] = useState('')
  const [maxRegistrationMultiplier, setMaxRegistrationMultiplier] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  // SESSION 62 — evaluation run + review queue state, kept independent of
  // the thresholds form's own state above (separate concerns: configuring
  // rules vs. acting on them).
  const [evaluating, setEvaluating] = useState(false)
  const [evalError, setEvalError] = useState<string | null>(null)
  const [evalResult, setEvalResult] = useState<StandingEvaluationResult | null>(null)
  const [queueLoading, setQueueLoading] = useState(true)
  const [queueError, setQueueError] = useState<string | null>(null)
  const [pendingEvents, setPendingEvents] = useState<StandingEvent[]>([])
  const [reviewingId, setReviewingId] = useState<string | null>(null)
  const [reviewNoteDraft, setReviewNoteDraft] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const res = await loadAcademicStandingRules(schoolId)
    if (res.error) { setError(res.error); setLoading(false); return }
    setRules(res.data)
    setProbationCgpaThreshold(res.data?.probation_cgpa_threshold != null ? String(res.data.probation_cgpa_threshold) : '')
    setWithdrawalCgpaThreshold(res.data?.withdrawal_cgpa_threshold != null ? String(res.data.withdrawal_cgpa_threshold) : '')
    setMaxCarryoverCourses(res.data?.max_carryover_courses_before_review != null ? String(res.data.max_carryover_courses_before_review) : '')
    setMaxRegistrationMultiplier(res.data?.max_registration_multiplier != null ? String(res.data.max_registration_multiplier) : '')
    setLoading(false)
  }, [schoolId])

  useEffect(() => { load() }, [load])

  // Numeric parse helper mirrors GradingTab's handleSavePolicy: empty input
  // is a legitimate "not set" state (null), not zero and not an error —
  // every threshold here is optional per §7.27.5's own nullable columns.
  function parseOptionalNonNegative(raw: string, label: string): { value: number | null; error: string | null } {
    if (!raw) return { value: null, error: null }
    const n = Number(raw)
    if (Number.isNaN(n) || n < 0) return { value: null, error: `${label} must be a non-negative number.` }
    return { value: n, error: null }
  }

  async function handleSave() {
    setSaved(false)
    const probation = parseOptionalNonNegative(probationCgpaThreshold, 'Probation CGPA threshold')
    if (probation.error) { setSaveError(probation.error); return }
    const withdrawal = parseOptionalNonNegative(withdrawalCgpaThreshold, 'Withdrawal CGPA threshold')
    if (withdrawal.error) { setSaveError(withdrawal.error); return }
    const maxCarryover = parseOptionalNonNegative(maxCarryoverCourses, 'Max carryover courses before review')
    if (maxCarryover.error) { setSaveError(maxCarryover.error); return }
    const maxMultiplier = parseOptionalNonNegative(maxRegistrationMultiplier, 'Max registration multiplier')
    if (maxMultiplier.error) { setSaveError(maxMultiplier.error); return }
    if (probation.value !== null && withdrawal.value !== null && withdrawal.value > probation.value) {
      setSaveError('Withdrawal CGPA threshold should not exceed the probation threshold.')
      return
    }
    setSaveError(null)
    setSaving(true)
    const res = await upsertAcademicStandingRules(schoolId, {
      probation_cgpa_threshold: probation.value,
      withdrawal_cgpa_threshold: withdrawal.value,
      max_carryover_courses_before_review: maxCarryover.value,
      max_registration_multiplier: maxMultiplier.value,
    })
    if (res.error) { setSaveError(res.error); setSaving(false); return }
    setSaving(false)
    setSaved(true)
    await load()
  }

  // SESSION 62 — pending review queue, loaded independently of the
  // thresholds form so switching this tab always shows both without
  // needing a save first.
  const loadQueue = useCallback(async () => {
    setQueueLoading(true)
    setQueueError(null)
    const res = await loadPendingStandingEvents(schoolId)
    if (res.error) { setQueueError(res.error); setQueueLoading(false); return }
    setPendingEvents(res.data)
    setQueueLoading(false)
  }, [schoolId])

  useEffect(() => { loadQueue() }, [loadQueue])

  async function handleRunEvaluation() {
    setEvalError(null)
    setEvalResult(null)
    setEvaluating(true)
    const res = await runStandingEvaluation(schoolId)
    setEvaluating(false)
    if (res.error) { setEvalError(res.error); return }
    setEvalResult(res.data)
    await loadQueue()
  }

  async function handleConfirmEvent(eventId: string, overrideStanding?: StandingEvent['standing']) {
    if (!actorRecordId) {
      setQueueError('Could not resolve your staff id — try reloading the page before confirming a review.')
      return
    }
    setReviewingId(eventId)
    const additionalNote = reviewNoteDraft[eventId]?.trim() || undefined
    const res = await reviewStandingEvent(eventId, actorRecordId, { overrideStanding, additionalNote })
    setReviewingId(null)
    if (res.error) { setQueueError(res.error); return }
    setReviewNoteDraft((prev) => { const next = { ...prev }; delete next[eventId]; return next })
    await loadQueue()
  }

  const STANDING_LABEL: Record<StandingEvent['standing'], string> = {
    good_standing: 'Good standing',
    probation: 'Probation',
    spillover: 'Spillover',
    withdrawal_recommended: 'Withdrawal recommended',
  }

  if (loading) return <Skeleton />
  if (error) return <ErrorState message={error} onRetry={load} />

  return (
    <div className="set-tab-content">
      <div className="set-section-header">
        <SectionLabel>Academic standing thresholds</SectionLabel>
      </div>
      <p className="set-hint-text">
        Applies once, school-wide. These thresholds define when a student's CGPA or carryover load
        is flagged for review — every case is always reviewed and confirmed by an admin/registrar
        before any standing change is recorded; nothing here is applied automatically.
      </p>

      <FieldRow label="Probation CGPA threshold (optional)">
        <Input
          value={probationCgpaThreshold}
          onChange={v => { setProbationCgpaThreshold(v.replace(/[^0-9.]/g, '')); setSaved(false) }}
          placeholder="e.g. 2.0"
        />
      </FieldRow>
      <FieldRow label="Withdrawal CGPA threshold (optional)">
        <Input
          value={withdrawalCgpaThreshold}
          onChange={v => { setWithdrawalCgpaThreshold(v.replace(/[^0-9.]/g, '')); setSaved(false) }}
          placeholder="e.g. 1.0"
        />
      </FieldRow>
      <FieldRow label="Max carryover courses before review (optional)">
        <Input
          value={maxCarryoverCourses}
          onChange={v => { setMaxCarryoverCourses(v.replace(/[^0-9]/g, '')); setSaved(false) }}
          placeholder="e.g. 3"
        />
      </FieldRow>
      <FieldRow label="Max registration multiplier (optional)">
        <Input
          value={maxRegistrationMultiplier}
          onChange={v => { setMaxRegistrationMultiplier(v.replace(/[^0-9.]/g, '')); setSaved(false) }}
          placeholder="e.g. 1.5"
        />
      </FieldRow>

      {saveError && <p className="set-form-error">{saveError}</p>}
      {saved && !saveError && <p className="set-hint-text">Saved.</p>}
      <div className="set-sheet-footer" style={{ paddingLeft: 0 }}>
        <button className="set-save-btn" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : rules ? 'Update thresholds' : 'Save thresholds'}
        </button>
      </div>

      <div className="set-section-header" style={{ marginTop: '2rem' }}>
        <SectionLabel>Session-end evaluation</SectionLabel>
      </div>
      <p className="set-hint-text">
        Compares every active student's latest CGPA and residency duration against the thresholds
        above and creates a review-pending entry below for anyone who trips one — nothing is
        changed on a student's record automatically. Run this at the end of a session, or any time
        you want a fresh check.
      </p>
      <div className="set-sheet-footer" style={{ paddingLeft: 0 }}>
        <button className="set-save-btn" onClick={handleRunEvaluation} disabled={evaluating}>
          {evaluating ? 'Evaluating…' : 'Run session-end evaluation'}
        </button>
      </div>
      {evalError && <p className="set-form-error">{evalError}</p>}
      {evalResult && !evalError && (
        <p className="set-hint-text">
          Evaluated {evalResult.studentsEvaluated} active student{evalResult.studentsEvaluated === 1 ? '' : 's'}.
          {' '}{evalResult.eventsCreated} new review-pending event{evalResult.eventsCreated === 1 ? '' : 's'} created
          {evalResult.skippedAlreadyPending > 0 ? `, ${evalResult.skippedAlreadyPending} already pending from an earlier run` : ''}.
        </p>
      )}

      <div className="set-section-header" style={{ marginTop: '2rem' }}>
        <SectionLabel>Pending review{pendingEvents.length > 0 ? ` (${pendingEvents.length})` : ''}</SectionLabel>
      </div>
      {queueLoading ? (
        <Skeleton />
      ) : queueError ? (
        <ErrorState message={queueError} onRetry={loadQueue} />
      ) : pendingEvents.length === 0 ? (
        <p className="set-hint-text">Nothing pending review right now.</p>
      ) : (
        <ul className="set-list">
          {pendingEvents.map((ev) => (
            <li key={ev.id} className="set-list-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '0.5rem' }}>
              <div>
                <p className="set-list-row-title">
                  {ev.student_name}
                  {ev.matric_number ? ` · ${ev.matric_number}` : ''}
                  {' — '}
                  <span style={{ fontWeight: 600 }}>{STANDING_LABEL[ev.standing]}</span>
                </p>
                <p className="set-list-row-meta">
                  {ev.session_name}
                  {ev.cgpa_at_evaluation !== null ? ` · CGPA ${ev.cgpa_at_evaluation.toFixed(2)}` : ''}
                </p>
                {ev.note && <p className="set-hint-text" style={{ marginTop: '0.25rem' }}>{ev.note}</p>}
              </div>
              <Input
                value={reviewNoteDraft[ev.id] ?? ''}
                onChange={(v) => setReviewNoteDraft((prev) => ({ ...prev, [ev.id]: v }))}
                placeholder="Add a note (optional) before confirming…"
              />
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                <button
                  className="set-save-btn"
                  onClick={() => handleConfirmEvent(ev.id)}
                  disabled={reviewingId === ev.id}
                >
                  {reviewingId === ev.id ? 'Confirming…' : `Confirm ${STANDING_LABEL[ev.standing]}`}
                </button>
                <button
                  className="set-save-btn"
                  onClick={() => handleConfirmEvent(ev.id, 'good_standing')}
                  disabled={reviewingId === ev.id}
                  style={{ background: 'transparent', border: '1px solid var(--color-border)' }}
                >
                  Override → Good standing
                </button>
              </div>
            </li>
          ))}
        </ul>
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
              <button className="set-delete-btn" onClick={() => handleDelete(r.id, r.name)} disabled={deleting === r.id} aria-label={`Delete role ${r.name}`}>
                {deleting === r.id ? '…' : <Icon name="x" size={16} />}
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
              <button className="set-delete-btn" onClick={() => handleDelete(r.id, r.name)} disabled={deleting === r.id} aria-label={`Delete student role ${r.name}`}>
                {deleting === r.id ? '…' : <Icon name="x" size={16} />}
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
