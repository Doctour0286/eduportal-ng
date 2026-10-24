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
  loadCurrentSession,
  loadPlacementsForProgramme,
  upsertPlacement,
  loadCourses,              upsertCourse,
  loadCurriculum,           addCurriculumEntry, removeCurriculumEntry,
  loadHigherEdGradeScale,   upsertHigherEdGradeBand, deleteHigherEdGradeBand,
  loadCgpaPolicy,           upsertCgpaPolicy,
  loadAcademicStandingRules, upsertAcademicStandingRules,
  runStandingEvaluation, loadPendingStandingEvents, reviewStandingEvent,
  loadProgrammePromotionRules, upsertProgrammePromotionRule, deleteProgrammePromotionRule,
  runProgrammePromotion, recordManualPromotionDecision, type PromotionRunResultRow,
  loadCourseOfferings,      upsertCourseOffering, deleteCourseOffering,
  loadProgrammeLevelsTeachingCourse, createCourseOfferingsForProgrammeLevels,
  loadAttendanceDeactivationSettings, saveAttendanceDeactivationSettings,
  type CourseCurriculumProgrammeLevel,
  type AttendanceDeactivationSettings,
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
  type StudentProgrammePlacement,
  type Course,
  type CurriculumEntry,
  type GradeScaleBand,
  type CgpaPolicy,
  type AcademicStandingRules,
  type StandingEvaluationResult,
  type StandingEvent,
  type ProgrammePromotionRule,
  type CourseOffering,
} from '../services/settingsService'
// Tier 8 / Problem 8.4 (Sessions 46–50): assessment-window configuration and
// the secondary-school promotion flow are substantial standalone CRUD screens
// with their own domain services — they live in AssessmentsSettings.tsx (see
// that file's header for why), imported here as tab bodies only.
import { AssessmentsTab, PromotionTabSecondary } from './AssessmentsSettings'
import AttendanceClassRules from './AttendanceClassRules'
// SESSION 65c — admission pipeline/field-settings/master-switch authoring.
// Deliberately a separate import from admissionService.ts, not folded into
// the block above: that file's own header comment (added in 65b) explains
// why admission-domain functions live apart from settingsService.ts (same
// actor/permission/load-lifecycle reasoning that split it out from
// settingsService.ts in the first place). This tab is UI placed inside
// Settings for the owner-facing reason (§0/§7 of the redesign proposal —
// admission configuration belongs alongside every other school-config tab),
// not a reason to re-merge the service files.
import {
  loadAllPipelines,        upsertPipeline,
  upsertPipelineStage,     deletePipelineStage,
  loadFieldSettings,       saveFieldSettings,
  loadAdmissionMasterSettings,
  setAdmissionPipelineEnabled, setRejectionRetentionDays,
  loadMatricNumberFormat,  saveMatricNumberFormat, hasAnyMatricAdmissions,
  setMatricSequenceScopeDefault, hasAnyMatricAdmissionsForProgramme,
  setMatricNumberManual, searchStudentsMissingMatric,
  type ManualMatricResult, type StudentMissingMatric,
  FIELD_CONFIG_KEYS,
  type AdmissionPipeline,  type PipelineStageType,
  type EntryMode,
  type ConfigurableField,  type AdmissionFieldSettings, type AdmissionCustomField,
  type MatricNumberFormat, type MatricNumberComponent,   type MatricNumberComponentType,
  type MatricSequenceScope,
} from '../services/admissionService'
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

type SettingsTab = 'school' | 'homepage' | 'calendar' | 'schedule' | 'classes' | 'assessments' | 'institution' | 'curriculum' | 'offerings' | 'grading' | 'standing' | 'promotion' | 'admission' | 'subjects' | 'roles' | 'student-roles' | 'staff' | 'audit'

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
    // Promotion rules (SESSION 69, PRD Tier 8, §7.27.1a Design A amendment).
    // Distinct concern from Standing: Standing configures CGPA/residency
    // thresholds that trigger a REVIEW (probation/withdrawal risk); this
    // configures the actual "from level X to level Y, at what CGPA" mapping
    // the annual advancement run reads. Same reasoning as Offerings earning
    // its own tab apart from Curriculum -- a genuinely separate object, not
    // a variant of an existing one. Icon: 'graduation-cap' reused rather
    // than guessing an unconfirmed name like 'trending-up' -- this file's
    // own Grading tab precedent explicitly reuses an existing icon
    // ("clipboard-list", "no dedicated grading icon found") rather than
    // assume a new name exists in this app's icon set; same discipline here.
    tabs.push({ id: 'promotion', label: 'Promotion', icon: <Icon name="graduation-cap" size={18} /> })
  } else {
    tabs.push({ id: 'classes', label: 'Classes', icon: <Icon name="tag" size={18} /> })
    // Tier 8 / Problem 8.4 (Sessions 46–50): assessment windows + secondary
    // promotion are secondary-school configuration. Components live in
    // AssessmentsSettings.tsx; this is pure tab registration, same as every
    // other entry in this function.
    tabs.push({ id: 'assessments', label: 'Assessments', icon: <Icon name="clipboard-list" size={18} /> })
    tabs.push({ id: 'promotion',   label: 'Promotion',   icon: <Icon name="graduation-cap" size={18} /> })
  }
  // Admission (SESSION 65c, redesign proposal §7/§8) — not gated to
  // isHigherEd: admission intake applies to any school type (secondary
  // schools admit students same as higher-ed institutions do), unlike
  // Institution/Curriculum/Offerings/Grading/Standing above, which are all
  // gated because they're genuinely higher-ed-shaped data. Placed after
  // Standing/Classes and before Subjects to sit with the other whole-school
  // operational config rather than inside the higher-ed-only block.
  // icons.tsx wasn't in this upload, so this uses 'user' — confirmed present
  // elsewhere in the codebase — rather than a guessed name like 'user-plus'
  // that might not exist in the icon set.
  tabs.push({ id: 'admission', label: 'Admission', icon: <Icon name="user" size={18} /> })
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

// onNavigate: kept in the accepted-props signature (App.tsx still passes it)
// even though nothing inside this module calls it anymore — the last
// caller was InstitutionTab's "+ Admit student" button, removed as dead
// code (it navigated to a generic 'admission' tab with no level context,
// a leftover from before admission was relocated to its own top-level
// AdmissionModule.tsx). Prefixed with `_` rather than deleted from the
// destructure, since dropping it here would still leave App.tsx passing a
// prop this component's type no longer declares — a caller-side change
// this file can't safely make blind. If App.tsx's own onNavigate prop is
// also now dead everywhere else, that's a follow-up for whoever owns that
// file, not this one.
export default function SettingsModule({ schoolId, isAdmin, themeMode, schoolType, actorRecordId, onNavigate: _onNavigate }: { schoolId: string; isAdmin: boolean; themeMode: ThemeMode; schoolType?: string | null; actorRecordId?: string | null; onNavigate: (tab: 'admission') => void }) {
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
        {safeActiveTab === 'calendar'    && <CalendarTab    schoolId={schoolId} schoolType={schoolType} />}
        {safeActiveTab === 'schedule'    && <ScheduleTab    schoolId={schoolId} schoolType={schoolType} />}
        {safeActiveTab === 'classes'     && <ClassesTab     schoolId={schoolId} />}
        {safeActiveTab === 'assessments' && <AssessmentsTab schoolId={schoolId} />}
        {safeActiveTab === 'institution' && <InstitutionTab schoolId={schoolId} />}
        {safeActiveTab === 'curriculum'  && <CurriculumTab  schoolId={schoolId} />}
        {safeActiveTab === 'offerings'    && <OfferingsTab    schoolId={schoolId} />}
        {safeActiveTab === 'grading'      && <GradingTab      schoolId={schoolId} />}
        {safeActiveTab === 'standing'     && <StandingTab     schoolId={schoolId} actorRecordId={actorRecordId ?? null} />}
        {safeActiveTab === 'promotion'    && (
          isHigherInstitutionSchoolType(schoolType)
            ? <PromotionTab schoolId={schoolId} actorRecordId={actorRecordId ?? null} />
            : <PromotionTabSecondary schoolId={schoolId} />
        )}
        {safeActiveTab === 'admission'    && <AdmissionSettingsTab schoolId={schoolId} />}
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
      <Toggle
        checked={usesTerms}
        onChange={setUsesTerms}
        label={
          isHigherInstitutionSchoolType(schoolType)
            ? 'Use semesters within each session (e.g. First, Second semester)'
            : 'Use terms within each session (e.g. 1st, 2nd, 3rd term)'
        }
      />
      <Toggle checked={usesLedger} onChange={setUsesLedger} label="Enable double-entry ledger (advanced accounting)" />

      <SaveBar saving={saving} saved={saved} error={saveError} onSave={handleSave} />
    </div>
  )
}

// ─── Tab: Calendar ────────────────────────────────────────────────────────────

function CalendarTab({ schoolId, schoolType }: { schoolId: string; schoolType?: string | null }) {
  // Higher-ed schools organize a session into two semesters, not the
  // secondary-school "1st/2nd/3rd term" model (confirmed via research:
  // Nigerian universities/polytechnics overwhelmingly run First/Second
  // Semester per session). The schema/data model is already generic
  // (terms.name is free text, sequence is just an int) — this is purely
  // a copy fix using the same isHigherInstitutionSchoolType() helper
  // already established at module scope, not a new local duplicate.
  const isHigherEd = isHigherInstitutionSchoolType(schoolType)
  const periodWord = isHigherEd ? 'semester' : 'term'
  const periodWordCap = isHigherEd ? 'Semester' : 'Term'
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
    if (sesStart >= sesEnd) { setSesError('Start date must be before end date.'); return }

    // Warn-not-block, per owner decision: shrinking an existing session's
    // dates below an already-saved term's range doesn't get silently
    // rejected (that would trap an admin fixing a genuine typo), but it
    // must never happen silently either. Fetch this session's own terms
    // fresh rather than relying on `terms` state, which only ever holds
    // whichever session is currently selected in the picker above — not
    // necessarily the one being edited here.
    if (editingSession) {
      const existingTermsRes = await loadTerms(schoolId, editingSession.id)
      const existingTerms = existingTermsRes.error ? [] : existingTermsRes.data
      const orphaned = existingTerms.filter(t => t.start_date < sesStart || t.end_date > sesEnd)
      if (orphaned.length > 0) {
        const names = orphaned.map(t => t.name).join(', ')
        const proceed = confirm(
          `${orphaned.length} term${orphaned.length > 1 ? 's' : ''} (${names}) already exist${orphaned.length > 1 ? '' : 's'} outside these new session dates. ` +
          `Saving will not change those terms' own dates, but they'll now sit outside their parent session. Save anyway?`
        )
        if (!proceed) return
      }
    }

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
    if (termStart >= termEnd) { setTermError(`This ${periodWord}'s start date must be before its end date.`); return }

    // A term must fall within its parent session's own dates — this is a
    // real data-integrity rule, not just a UI nicety, so it's also
    // enforced at the DB level via a trigger (see
    // session67_term_bounds_migration.sql). Checking it here too gives
    // the admin an immediate, specific error instead of a generic
    // server/DB error surfacing after the round-trip.
    const parentSession = sessions.find(s => s.id === selectedSessionId)
    if (parentSession && (termStart < parentSession.start_date || termEnd > parentSession.end_date)) {
      setTermError(
        `This ${periodWord}'s dates (${termStart} to ${termEnd}) must fall within its session's dates ` +
        `(${parentSession.start_date} to ${parentSession.end_date}).`
      )
      return
    }

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
            <SectionLabel>{periodWordCap}s in session</SectionLabel>
            <div className="set-section-controls">
              <select className="set-select set-select--sm" value={selectedSessionId ?? ''} onChange={e => setSelectedSessionId(e.target.value)}>
                {sessions.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <button className="set-add-btn" onClick={() => openTermForm()}>+ Add {periodWord}</button>
            </div>
          </div>

          {termsLoading
            ? <Skeleton lines={3} />
            : terms.length === 0
              ? <p className="set-empty-hint">
                  {isHigherEd
                    ? 'No semesters for this session. Add First Semester, Second Semester etc.'
                    : 'No terms for this session. Add the 1st, 2nd, 3rd terms etc.'}
                </p>
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
            <h2 className="set-sheet-title">{editingTerm ? `Edit ${periodWord}` : `Add ${periodWord}`}</h2>
            <FieldRow label="Name"><Input value={termName} onChange={setTermName} placeholder={isHigherEd ? 'e.g. First Semester' : 'e.g. First Term'} /></FieldRow>
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

function ScheduleTab({ schoolId, schoolType }: { schoolId: string; schoolType?: string | null }) {
  // Bug fix (build error TS2304): the calendar-days/holidays sub-panel
  // below (extends_term chip, "Extend the term/session" toggle, its hint
  // text, the Mid-term/semester placeholder) actually lives in this
  // component, not in CalendarTab — periodWord/isHigherEd were originally
  // added to CalendarTab under the wrong assumption both panels were the
  // same function. Threading schoolType through here directly instead.
  const isHigherEd = isHigherInstitutionSchoolType(schoolType)
  const periodWord = isHigherEd ? 'semester' : 'term'
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

  // Attendance auto-deactivation (migration_attendance_auto_deactivation.sql).
  // Lives in this tab, not a new one, for the same reason school_week_days
  // does — it's a global, easy-to-misfire setting other modules key off of,
  // grouped with the rest of this tab's school-day/hours configuration.
  const [adSettings, setAdSettings] = useState<AttendanceDeactivationSettings>({
    enabled: false,
    mode: 'consecutive',
    consecutive_threshold: 5,
    cumulative_threshold: 5,
    activated_at: null,
  })
  const [adLoading, setAdLoading] = useState(true)
  const [adError, setAdError] = useState<string | null>(null)
  const [adSaving, setAdSaving] = useState(false)
  const [adSaveError, setAdSaveError] = useState<string | null>(null)
  const [adSaveOk, setAdSaveOk] = useState(false)
  // Kept as free-typed strings, separate from adSettings' numeric fields —
  // clamping to "at least 1" on every keystroke (the original bug) meant an
  // in-progress edit (briefly empty while backspacing to retype) instantly
  // snapped back to "1" before a new digit could be entered at all. Only
  // digits are allowed as you type; the "at least 1" floor is enforced once,
  // at save time, in handleSaveAttendanceDeactivation.
  const [adConsecutiveInput, setAdConsecutiveInput] = useState('5')
  const [adCumulativeInput, setAdCumulativeInput] = useState('5')

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

  const loadAttendanceDeactivation = useCallback(async () => {
    setAdLoading(true)
    setAdError(null)
    const { data, error } = await loadAttendanceDeactivationSettings(schoolId)
    if (error) { setAdError(error); setAdLoading(false); return }
    setAdSettings(data)
    setAdConsecutiveInput(String(data.consecutive_threshold))
    setAdCumulativeInput(String(data.cumulative_threshold))
    setAdLoading(false)
  }, [schoolId])

  useEffect(() => { loadAttendanceDeactivation() }, [loadAttendanceDeactivation])

  async function handleSaveAttendanceDeactivation() {
    setAdSaving(true)
    setAdSaveError(null)
    setAdSaveOk(false)
    // Parsed and floored to at least 1 here, once, rather than on every
    // keystroke — an emptied field (mid-edit) or a stray non-digit falls
    // back to 1 rather than blocking the save.
    const consecutiveThreshold = Math.max(1, parseInt(adConsecutiveInput, 10) || 1)
    const cumulativeThreshold = Math.max(1, parseInt(adCumulativeInput, 10) || 1)
    const { error } = await saveAttendanceDeactivationSettings(schoolId, {
      enabled: adSettings.enabled,
      mode: adSettings.mode,
      consecutive_threshold: consecutiveThreshold,
      cumulative_threshold: cumulativeThreshold,
    })
    setAdSaving(false)
    if (error) { setAdSaveError(error); return }
    setAdSaveOk(true)
    // Re-fetch rather than assuming — a fresh off->on activation stamps a
    // real activated_at server-side that this component doesn't compute
    // itself, and the readout below should show that real value. This also
    // re-syncs the two input strings to the clamped values actually saved.
    await loadAttendanceDeactivation()
  }

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
                {d.extends_term && <span className="set-extends-chip">Extends {periodWord}</span>}
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
              <Input value={calLabel} onChange={setCalLabel} placeholder={isHigherEd ? 'e.g. Eid al-Fitr, Mid-semester break' : 'e.g. Eid al-Fitr, Mid-term break'} />
            </FieldRow>

            <Toggle
              checked={calExtends}
              onChange={setCalExtends}
              label={`Extend the ${periodWord}/session end date to make up for this`}
            />
            <p className="set-field-hint">
              On: a school-day lost to this entry pushes the {periodWord}'s effective end date out by one
              day, so the same number of teaching days is still delivered. Off: this is just a
              marked exception inside the {periodWord} as originally planned — the common choice for a
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

      <div className="set-section-header set-section-header--spaced">
        <SectionLabel>Attendance auto-deactivation</SectionLabel>
      </div>
      <p className="set-field-hint">
        When on, a student is automatically set to inactive after too many absences. This check
        runs the next time a staff member who can manage student records opens the Students
        module after the qualifying school day has ended — not instantly, and not on a schedule.
        Only absences from the moment this is turned on count; nothing before that matters, even
        if a student was already partway through a run of absences.
      </p>

      {adLoading ? (
        <Skeleton lines={2} />
      ) : adError ? (
        <ErrorState message={adError} onRetry={loadAttendanceDeactivation} />
      ) : (
        <>
          <Toggle
            checked={adSettings.enabled}
            onChange={(v) => setAdSettings(prev => ({ ...prev, enabled: v }))}
            label="Auto-deactivate students after too many absences"
          />

          {adSettings.enabled && adSettings.activated_at && (
            <p className="set-field-hint">
              Active since {new Date(adSettings.activated_at).toLocaleString()}. Turning this off
              and back on later starts counting from zero again, for every student — it will not
              resume any earlier count.
            </p>
          )}

          <FieldRow label="Count absences as">
            <select
              className="set-select"
              value={adSettings.mode}
              onChange={e => setAdSettings(prev => ({ ...prev, mode: e.target.value as 'consecutive' | 'cumulative' }))}
            >
              <option value="consecutive">Consecutive school days in a row</option>
              <option value="cumulative">Total absences (does not reset each term)</option>
            </select>
          </FieldRow>

          {adSettings.mode === 'consecutive' ? (
            <FieldRow label="Consecutive absent days before deactivation">
              <Input
                value={adConsecutiveInput}
                onChange={v => setAdConsecutiveInput(v.replace(/[^0-9]/g, ''))}
                type="text"
              />
            </FieldRow>
          ) : (
            <FieldRow label="Total absences before deactivation">
              <Input
                value={adCumulativeInput}
                onChange={v => setAdCumulativeInput(v.replace(/[^0-9]/g, ''))}
                type="text"
              />
            </FieldRow>
          )}
          <p className="set-field-hint">
            Both numbers are kept even when only one mode is active — switching modes later won't
            lose whichever threshold isn't currently in use.
          </p>

          {adSaveError && <p className="set-form-error">{adSaveError}</p>}
          {adSaveOk && <p className="set-save-ok"><Icon name="circle-check" size={16} style={{ color: 'var(--color-success, #16a34a)' }} /> Saved.</p>}

          <button className="set-save-btn" onClick={handleSaveAttendanceDeactivation} disabled={adSaving}>
            {adSaving ? 'Saving…' : 'Save'}
          </button>

          <AttendanceClassRules
            schoolId={schoolId}
            school={{
              mode: adSettings.mode,
              consecutive_threshold: adSettings.consecutive_threshold,
              cumulative_threshold: adSettings.cumulative_threshold,
            }}
          />
        </>
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
  // Matric sequence scope follow-up (owner request) — null = "use school
  // default"; the school's actual current default is fetched separately
  // (loadAdmissionMasterSettings) only to render the inherited-value hint
  // below, never to silently coerce this field away from null.
  const [pMatricScope, setPMatricScope] = useState<'programme' | 'school' | null>(null)
  const [pSaving, setPSaving] = useState(false)
  const [pError, setPError] = useState<string | null>(null)
  const [schoolMatricScopeDefault, setSchoolMatricScopeDefault] = useState<'programme' | 'school'>('programme')
  const [hasMatricAdmissionsForProg, setHasMatricAdmissionsForProg] = useState(false)

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

  // Placement display (§7.27.1a student_programme_placements) — read-only
  // here: InstitutionTab shows who's currently placed into each level as
  // institution-structure context, but the actual admission action (search/
  // create student, generate matric number, write the placement) moved to
  // AdmissionModule.tsx in this session's own correction pass (§12 decision,
  // 2026-07-17) — see that file for the real, atomic admit flow. The
  // "+ Admit student" button below now navigates there instead of opening
  // an inline form.
  const [placementsByLevel, setPlacementsByLevel] = useState<Record<string, StudentProgrammePlacement[]>>({})

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const [fRes, dRes, pRes, cRes] = await Promise.all([
      loadFaculties(schoolId),
      loadDepartments(schoolId),
      loadProgrammes(schoolId),
      loadCourses(schoolId),
    ])
    if (fRes.error) { setError(fRes.error); setLoading(false); return }
    if (dRes.error) { setError(dRes.error); setLoading(false); return }
    if (pRes.error) { setError(pRes.error); setLoading(false); return }
    if (cRes.error) { setError(cRes.error); setLoading(false); return }
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

  async function openProgForm(p?: Programme, deptId?: string) {
    setEditingProg(p ?? null)
    setPName(p?.name ?? '')
    setPCode(p?.code ?? '')
    setPAwardType(p?.award_type ?? 'degree')
    setPDeptId(p?.department_id ?? deptId ?? null)
    setPDuration(p?.duration_sessions ?? 4)
    setPMinCredit(p?.min_credit_load != null ? String(p.min_credit_load) : '')
    setPMaxCredit(p?.max_credit_load != null ? String(p.max_credit_load) : '')
    setPMatricScope(p?.matric_sequence_scope ?? null)
    setPError(null)
    setShowProgForm(true)
    // Fetched on open, not kept live for the whole tab, since this only
    // needs to be right at the moment the form is shown — the inherited-
    // value hint and the soft-lock check below both read it.
    const masterRes = await loadAdmissionMasterSettings(schoolId)
    if (!masterRes.error && masterRes.data) {
      setSchoolMatricScopeDefault(masterRes.data.matric_sequence_scope_default)
    }
    if (p?.id) {
      const lockRes = await hasAnyMatricAdmissionsForProgramme(schoolId, p.id)
      setHasMatricAdmissionsForProg(!lockRes.error && lockRes.data)
    } else {
      setHasMatricAdmissionsForProg(false)
    }
  }

  async function handleSaveProg() {
    if (!pName) { setPError('Name is required.'); return }
    if (!pDeptId) { setPError('Choose a department.'); return }
    // Soft-lock, same pattern as the matric-format section (§12) — warn,
    // don't block, and only when the scope is actually changing from what
    // this programme is already admitting under.
    const scopeChanged = editingProg && (editingProg.matric_sequence_scope ?? null) !== pMatricScope
    if (scopeChanged && hasMatricAdmissionsForProg) {
      const ok = confirm(
        'Students have already been admitted under this programme\'s current matric-numbering scope. ' +
        'Changing it won\'t affect any matric number already issued — only admissions from now on will use the new scope. Continue?'
      )
      if (!ok) return
    }
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
      matric_sequence_scope: pMatricScope,
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

      {/* Matric number format & student admission moved to AdmissionModule.tsx
          (§12 correction, 2026-07-17) — see that file's header for the full
          reasoning. This tab now only shows placement counts per level as
          read-only institution-structure context, below. */}

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
            <FieldRow label="Matric numbering">
              <select
                className="set-select"
                value={pMatricScope ?? ''}
                onChange={e => setPMatricScope(e.target.value === '' ? null : e.target.value as 'programme' | 'school')}
              >
                <option value="">Use school default ({schoolMatricScopeDefault === 'school' ? 'shared school-wide' : 'per-programme'})</option>
                <option value="programme">Sequence resets for this programme only</option>
                <option value="school">Share the school-wide sequence</option>
              </select>
            </FieldRow>
            {hasMatricAdmissionsForProg && (
              <p className="set-empty-hint" style={{ margin: '0 0 8px' }}>
                Students have already been admitted under this programme's current scope. You can still change it — existing matric numbers won't be affected, only new admissions will use the updated scope.
              </p>
            )}
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

    </div>
  )
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
    if (terms.length > 0 && !selectedTermId) { setAddError('Choose a semester first.'); return }
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

      {/* SESSION 67: "Semester" not "Term" — this tab is higher-ed-only
          (gated behind isHigherEd in buildTabs, never rendered for a
          secondary school), so no branching is needed here, just a
          straight wording correction. Semester picker only appears when
          this school actually has terms defined for the current session
          — otherwise curriculum is scoped by session alone (term_id
          stays null throughout), per §7.4. */}
      {selectedLevelId && terms.length > 0 && (
        <FieldRow label="Semester">
          <select
            className="set-select"
            value={selectedTermId ?? ''}
            onChange={e => setSelectedTermId(e.target.value || null)}
          >
            <option value="">Choose a semester</option>
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
            <p className="set-empty-hint">No courses assigned yet for this {terms.length > 0 ? 'level/semester' : 'level'}.</p>
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
        <p className="set-empty-hint">Choose a semester to view or edit that semester's curriculum.</p>
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
  // SESSION 69: programme/level pickers for the offering form — reuses
  // loadProgrammes()/loadProgrammeLevels() exactly as CurriculumTab does
  // above, not a new picker pattern. Kept separate from the
  // selectedSessionId/selectedTermId picker above (which scopes the
  // OFFERINGS LIST), since this pair scopes the FORM's course filter only.
  const [programmes, setProgrammes] = useState<Programme[]>([])
  const [levelsByProgramme, setLevelsByProgramme] = useState<Record<string, ProgrammeLevel[]>>({})

  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [selectedTermId, setSelectedTermId] = useState<string | null>(null)

  const [offerings, setOfferings] = useState<CourseOffering[]>([])
  const [offeringsLoading, setOfferingsLoading] = useState(false)

  const [showForm, setShowForm] = useState(false)
  const [editingOffering, setEditingOffering] = useState<CourseOffering | null>(null)
  const [fProgrammeId, setFProgrammeId] = useState<string | null>(null)
  const [fLevelId, setFLevelId] = useState<string | null>(null)
  const [fCourseId, setFCourseId] = useState<string | null>(null)
  const [fStaffId, setFStaffId] = useState<string | null>(null)
  const [fThreshold, setFThreshold] = useState('')
  const [fSaving, setFSaving] = useState(false)
  const [fError, setFError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  // SESSION 69: curriculum entries for the currently-picked level/term in
  // the FORM — drives the filtered course dropdown. Separate from
  // CurriculumTab's own `entries` state (different component instance);
  // reuses the same loadCurriculum() call, not a new query.
  const [formCurriculum, setFormCurriculum] = useState<CurriculumEntry[]>([])
  const [formCurriculumLoading, setFormCurriculumLoading] = useState(false)
  // Deliberate, visible override — an admin must actively opt out of the
  // curriculum filter, not have it silently bypassed. Resets to false every
  // time the form re-opens (see openForm below), so it's never accidentally
  // left on from a previous offering.
  const [fShowAllCourses, setFShowAllCourses] = useState(false)
  // Save-time soft warning state — mirrors CourseRegistrationModule.tsx's
  // checkCreditLoad()-then-confirm shape: a real question surfaced to the
  // admin, not a silent save. Cleared whenever the course/level selection
  // changes, so a stale warning can never linger against a new choice.
  const [fOffCurriculumConfirm, setFOffCurriculumConfirm] = useState(false)

  // Multi-programme/level checkbox list — a course is chosen with NO
  // programme/level pre-selected (the admin left "Programme (optional)" on
  // "No programme"), so the form shows every programme/level whose
  // curriculum actually includes that course, each with its own checkbox.
  // Purpose: a course shared across programmes/levels but taught by the
  // same lecturer (e.g. a general Anatomy course both Nursing and
  // Midwifery take) previously had to be offered once per programme/level
  // via repeated trips through this form, with no visibility into which
  // programme/levels even teach it — real risk of a duplicate or a
  // forgotten offering for the same course. Only shown when fProgrammeId
  // is empty; picking a specific Programme/Level the normal way (as
  // before) bypasses this entirely and saves exactly one offering, single
  // upsertCourseOffering() call, unchanged from existing behavior.
  const [courseProgrammeLevels, setCourseProgrammeLevels] = useState<CourseCurriculumProgrammeLevel[]>([])
  const [courseProgrammeLevelsLoading, setCourseProgrammeLevelsLoading] = useState(false)
  const [checkedLevelKeys, setCheckedLevelKeys] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const [sessRes, cRes, stRes, curRes, pRes] = await Promise.all([
      loadSessions(schoolId),
      loadCourses(schoolId),
      loadStaffWithRoles(schoolId),
      loadCurrentSession(schoolId),
      loadProgrammes(schoolId),
    ])
    if (sessRes.error) { setError(sessRes.error); setLoading(false); return }
    if (cRes.error) { setError(cRes.error); setLoading(false); return }
    if (stRes.error) { setError(stRes.error); setLoading(false); return }
    if (pRes.error) { setError(pRes.error); setLoading(false); return }
    setSessions(sessRes.data)
    setCourses(cRes.data)
    setStaff(stRes.data)
    setProgrammes(pRes.data)
    // Same pattern CurriculumTab uses: fetch every programme's levels up
    // front, keyed by programme id, rather than lazily per-select — the
    // form's Level dropdown needs to react instantly to a Programme pick
    // with no extra loading state in between.
    const levelEntries = await Promise.all(
      pRes.data.map(async (prog: Programme) => [prog.id, (await loadProgrammeLevels(prog.id)).data] as const),
    )
    setLevelsByProgramme(Object.fromEntries(levelEntries))
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

  // SESSION 69: form's course filter — loads curriculum entries for the
  // picked level, scoped to the SAME term the offering itself will be
  // saved under (selectedTermId, the list-scoping picker above), not a
  // separate term choice in the form. Deliberately reuses loadCurriculum()
  // as-is — same function CurriculumTab calls, same fan-out-safe scoping
  // (programme_level_id + term_id together, see PRD SESSION 57 finding).
  const loadFormCurriculum = useCallback(async () => {
    if (!fLevelId) { setFormCurriculum([]); return }
    setFormCurriculumLoading(true)
    const res = await loadCurriculum(fLevelId, terms.length > 0 ? selectedTermId : null)
    setFormCurriculum(res.error ? [] : res.data)
    setFormCurriculumLoading(false)
  }, [fLevelId, selectedTermId, terms.length])

  useEffect(() => { loadFormCurriculum() }, [loadFormCurriculum])

  // Fetches the list (item 2) whenever a course is picked, in either of two
  // real cases: (a) creating a new offering with no programme pre-selected
  // (the interactive checkbox path), or (b) editing ANY existing offering,
  // regardless of whether it has a programme_id set — most real offerings
  // do have one, and the read-only list still needs to fetch and render
  // for those, not just the rare unassigned/shared ones. Deliberately
  // keyed on editingOffering too (not just fCourseId/fProgrammeId) so
  // switching between create/edit mode re-evaluates this correctly.
  const loadCourseProgrammeLevels = useCallback(async () => {
    if (!fCourseId || (fProgrammeId && !editingOffering)) {
      setCourseProgrammeLevels([]); setCheckedLevelKeys(new Set()); return
    }
    setCourseProgrammeLevelsLoading(true)
    const res = await loadProgrammeLevelsTeachingCourse(fCourseId, terms.length > 0 ? selectedTermId : null)
    setCourseProgrammeLevels(res.error ? [] : res.data)
    // Default: nothing pre-checked in CREATE mode — an admin must actively
    // choose which programme/levels to offer this course to, matching this
    // form's own existing "no silent default" convention (fShowAllCourses/
    // fOffCurriculumConfirm both start false/unset for the same reason).
    // In EDIT mode this is irrelevant (the list renders read-only off
    // editingOffering.programme_level_id directly, never off this set) but
    // cleared anyway for a consistent, predictable state either way.
    setCheckedLevelKeys(new Set())
    setCourseProgrammeLevelsLoading(false)
  }, [fCourseId, fProgrammeId, editingOffering, selectedTermId, terms.length])

  useEffect(() => { loadCourseProgrammeLevels() }, [loadCourseProgrammeLevels])

  function toggleLevelKey(programmeId: string, levelId: string) {
    const key = `${programmeId}:${levelId}`
    setCheckedLevelKeys(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // Resolves a programme/level's display name for the checkbox list —
  // small, already-loaded data (programmes/levelsByProgramme), no extra
  // query, same reasoning openForm() already uses to resolve an existing
  // offering's programme from its level id.
  function levelDisplayName(pl: CourseCurriculumProgrammeLevel): string {
    const programme = programmes.find(p => p.id === pl.programme_id)
    const level = (levelsByProgramme[pl.programme_id] ?? []).find(l => l.id === pl.programme_level_id)
    return `${programme?.name ?? 'Unknown programme'} — ${level?.level_label ?? 'Unknown level'}`
  }

  const formLevels = fProgrammeId ? (levelsByProgramme[fProgrammeId] ?? []) : []
  // The actual list the course dropdown renders: curriculum-filtered by
  // default once a level is chosen, full catalogue if no level is chosen
  // yet OR the admin has explicitly opted into "show all courses" (§7.27.2
  // amendment — filtering guides, it never hard-blocks).
  const formCourseOptions = (!fLevelId || fShowAllCourses)
    ? courses
    : courses.filter(c => formCurriculum.some(e => e.course_id === c.id))
  const selectedCourseOnCurriculum = !fCourseId || formCurriculum.some(e => e.course_id === fCourseId)

  function openForm(o?: CourseOffering) {
    setEditingOffering(o ?? null)
    // Programme isn't stored directly on CourseOffering (only
    // programme_level_id is) — resolving the programme by scanning
    // levelsByProgramme (small, already-loaded data, no extra query)
    // rather than storing a redundant programme_id-derivable-from-level
    // echo in local state beyond what's needed to drive the picker.
    const existingLevelId = o?.programme_level_id ?? null
    const existingProgrammeId = existingLevelId
      ? Object.entries(levelsByProgramme).find(([, levels]) => levels.some(l => l.id === existingLevelId))?.[0] ?? null
      : null
    setFProgrammeId(existingProgrammeId)
    setFLevelId(existingLevelId)
    setFCourseId(o?.course_id ?? null)
    setFStaffId(o?.staff_id ?? null)
    setFThreshold(o?.attendance_eligibility_threshold_pct != null ? String(o.attendance_eligibility_threshold_pct) : '')
    setFError(null)
    setFShowAllCourses(false)
    setFOffCurriculumConfirm(false)
    setCheckedLevelKeys(new Set())
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

    // Multi-programme/level batch path (item 2) — only reachable when
    // creating a NEW offering (never editing one, editingOffering is null)
    // with no single Programme chosen and at least one checkbox ticked.
    // Editing an existing offering always goes through the single-offering
    // path below unchanged, even if it happens to have no programme set —
    // an edit is inherently one specific row, never a batch-create.
    if (!editingOffering && !fProgrammeId && checkedLevelKeys.size > 0) {
      const selected = courseProgrammeLevels.filter(pl => checkedLevelKeys.has(`${pl.programme_id}:${pl.programme_level_id}`))
      setFSaving(true)
      const res = await createCourseOfferingsForProgrammeLevels({
        course_id: fCourseId,
        session_id: selectedSessionId,
        term_id: terms.length > 0 ? selectedTermId : null,
        staff_id: fStaffId,
        attendance_eligibility_threshold_pct: threshold,
        programmeLevels: selected,
      })
      if (res.error) { setFError(res.error); setFSaving(false); return }
      setShowForm(false)
      setFSaving(false)
      await loadOfferingsList()
      return
    }

    // SESSION 69 soft warning — non-blocking, matches
    // CourseRegistrationModule.tsx's checkCreditLoad()-then-confirm shape:
    // a course chosen while curriculum-filtered is on-curriculum by
    // construction and never hits this; a course chosen via the explicit
    // "show all courses" override might not be, which is a real, surfaced
    // question, not a silent save. Only fires once per attempt — a second
    // click with fOffCurriculumConfirm already true proceeds.
    if (fLevelId && !selectedCourseOnCurriculum && !fOffCurriculumConfirm) {
      const course = courses.find(c => c.id === fCourseId)
      setFError(
        `${course ? `${course.code} — ${course.title}` : 'This course'} isn't on this level's curriculum yet. ` +
        `Click Save again to save it anyway, or add it to the curriculum first.`,
      )
      setFOffCurriculumConfirm(true)
      return
    }
    setFSaving(true)
    const res = await upsertCourseOffering({
      id: editingOffering?.id,
      course_id: fCourseId,
      session_id: selectedSessionId,
      term_id: terms.length > 0 ? selectedTermId : null,
      staff_id: fStaffId,
      programme_id: fProgrammeId,
      programme_level_id: fLevelId,
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
    if (res.error) {
      // Translate the two known real foreign-key blockers into plain
      // language rather than surface Postgres's raw constraint-name
      // message — deleteCourseOffering() itself stays a genuine hard
      // delete with no cascade (the right default for something that may
      // have real dependent data), this only changes what the admin sees
      // when that protection actually fires. Matched on the FK constraint
      // name itself (stable, not the free-text wording around it) so this
      // doesn't silently stop matching if Postgres's message phrasing ever
      // changes.
      let message = res.error
      if (res.error.includes('course_attendance_sessions_course_offering_id_fkey')) {
        message =
          `Can't delete "${label}" — attendance has already been recorded for this offering ` +
          `(at least one attendance session exists for it). Deleting it would orphan or destroy ` +
          `real attendance history. If this offering genuinely needs to go, the attendance ` +
          `sessions/records for it need to be dealt with first — this isn't something to do from ` +
          `this screen, since it's real historical data, not configuration.`
      } else if (res.error.includes('course_offering_timetable_entries_course_offering_id_fkey') || res.error.includes('course_offering_timetable')) {
        message =
          `Can't delete "${label}" — it still has timetable slots assigned to it. ` +
          `Remove its slots from the Timetable module first, then delete the offering.`
      }
      alert(message)
      setDeletingId(null)
      return
    }
    setOfferings(prev => prev.filter(o => o.id !== offeringId))
    setDeletingId(null)
  }

  // ─── List regrouping (SESSION 69 follow-up) ─────────────────────────────
  //
  // Groups the flat `offerings` list into Programme → Level, in the same
  // order programmes/levels already appear via loadProgrammes()/
  // loadProgrammeLevels() (levels come back level_label/sequence_order-
  // ordered per settingsService.ts's own query — not re-sorted here).
  // Three real, permanent cases, not one flat list with gaps papered over:
  //   - offering has both programme_id/programme_level_id -> filed under
  //     that programme's level.
  //   - offering has a programme_id but its programme_level_id doesn't
  //     match any level currently in levelsByProgramme (a level deleted
  //     out from under an existing offering) -> filed under that
  //     programme's own "Unassigned level" bucket, not silently dropped or
  //     merged into the top-level Unassigned group, since the programme
  //     fact is still real even though the level fact no longer resolves.
  //   - offering has no programme_id at all (pre-SESSION-69 row, or a
  //     genuinely shared/university-wide offering, §7.27.2 amendment) ->
  //     filed under the top-level "Unassigned" group.
  // Built with a plain object accumulator (not Map) so it round-trips
  // through nothing more exotic than JSX .map(), matching this file's own
  // existing style elsewhere (levelsByProgramme itself is a plain Record).
  type OfferingGroup = { level: ProgrammeLevel | null; offerings: CourseOffering[] }
  type ProgrammeGroup = { programme: Programme | null; levelGroups: OfferingGroup[] }

  function buildGroupedOfferings(): ProgrammeGroup[] {
    const unassignedProgrammeOfferings: CourseOffering[] = []
    const byProgramme: Record<string, CourseOffering[]> = {}

    for (const o of offerings) {
      if (!o.programme_id) { unassignedProgrammeOfferings.push(o); continue }
      if (!byProgramme[o.programme_id]) byProgramme[o.programme_id] = []
      byProgramme[o.programme_id].push(o)
    }

    const groups: ProgrammeGroup[] = []

    for (const prog of programmes) {
      const progOfferings = byProgramme[prog.id]
      if (!progOfferings || progOfferings.length === 0) continue

      const levels = levelsByProgramme[prog.id] ?? []
      const byLevel: Record<string, CourseOffering[]> = {}
      const unassignedLevelOfferings: CourseOffering[] = []

      for (const o of progOfferings) {
        const level = o.programme_level_id ? levels.find(l => l.id === o.programme_level_id) : undefined
        if (!level) { unassignedLevelOfferings.push(o); continue }
        if (!byLevel[level.id]) byLevel[level.id] = []
        byLevel[level.id].push(o)
      }

      const levelGroups: OfferingGroup[] = levels
        .filter(l => byLevel[l.id]?.length > 0)
        .map(l => ({ level: l, offerings: byLevel[l.id] }))

      if (unassignedLevelOfferings.length > 0) {
        levelGroups.push({ level: null, offerings: unassignedLevelOfferings })
      }

      groups.push({ programme: prog, levelGroups })
    }

    if (unassignedProgrammeOfferings.length > 0) {
      groups.push({ programme: null, levelGroups: [{ level: null, offerings: unassignedProgrammeOfferings }] })
    }

    return groups
  }

  // Shared row markup, unchanged from the previous flat list — regrouping
  // only changes what wraps each row, not the row itself, so editing/
  // deleting an offering works identically to before.
  function renderOfferingRow(o: CourseOffering) {
    return (
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
    )
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

      {/* SESSION 67: "Semester" not "Term" — OfferingsTab is higher-ed-only
          (gated behind isHigherEd in buildTabs), so a straight wording fix,
          same reasoning as CurriculumTab above. */}
      {selectedSessionId && terms.length > 0 && (
        <FieldRow label="Semester">
          <select
            className="set-select"
            value={selectedTermId ?? ''}
            onChange={e => setSelectedTermId(e.target.value || null)}
          >
            <option value="">Choose a semester</option>
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
            <p className="set-empty-hint">No offerings yet for this {terms.length > 0 ? 'session/semester' : 'session'}.</p>
          ) : (
            <div className="set-offerings-grouped">
              {buildGroupedOfferings().map((pg, pgIdx) => (
                <div key={pg.programme?.id ?? 'unassigned-programme'} className="set-offerings-programme-group">
                  <h3 className="set-offerings-programme-heading">
                    {pg.programme ? pg.programme.name : 'Unassigned'}
                  </h3>
                  {pg.levelGroups.map((lg, lgIdx) => (
                    <div key={lg.level?.id ?? `unassigned-level-${pgIdx}-${lgIdx}`} className="set-offerings-level-group">
                      {/* Only show a level sub-heading when the programme is
                          real — the top-level "Unassigned" bucket (no
                          programme at all) has nothing meaningful to say at
                          the level tier, so it skips straight to rows rather
                          than showing a redundant "Unassigned > Unassigned". */}
                      {pg.programme && (
                        <h4 className="set-offerings-level-heading">
                          {lg.level ? lg.level.level_label : 'Unassigned level'}
                        </h4>
                      )}
                      <div className="set-offerings-rows">
                        {lg.offerings.map(o => renderOfferingRow(o))}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {selectedSessionId && terms.length > 0 && !selectedTermId && (
        <p className="set-empty-hint">Choose a semester to view or add offerings for that semester.</p>
      )}

      {showForm && (
        <div className="set-overlay" onClick={() => setShowForm(false)}>
          <div className="set-sheet" onClick={e => e.stopPropagation()}>
            <h2 className="set-sheet-title">{editingOffering ? 'Edit offering' : 'Add offering'}</h2>

            {/* SESSION 69: Programme → Level, above Course — reuses the
                same picker pattern as CurriculumTab, not a new one. Both
                optional: an offering with no programme/level is a real,
                intentional state (unassigned, or genuinely shared across
                programmes), not an incomplete form. */}
            <FieldRow label="Programme (optional)">
              <select
                className="set-select"
                value={fProgrammeId ?? ''}
                onChange={e => {
                  setFProgrammeId(e.target.value || null)
                  setFLevelId(null)
                  setFShowAllCourses(false)
                  setFOffCurriculumConfirm(false)
                }}
              >
                <option value="">No programme (shared/unassigned)</option>
                {programmes.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </FieldRow>

            {fProgrammeId && (
              <FieldRow label="Level (optional)">
                <select
                  className="set-select"
                  value={fLevelId ?? ''}
                  onChange={e => {
                    setFLevelId(e.target.value || null)
                    setFShowAllCourses(false)
                    setFOffCurriculumConfirm(false)
                  }}
                >
                  <option value="">No specific level</option>
                  {formLevels.map(l => <option key={l.id} value={l.id}>{l.level_label}</option>)}
                </select>
              </FieldRow>
            )}

            <FieldRow label="Course">
              <select
                className="set-select"
                value={fCourseId ?? ''}
                onChange={e => { setFCourseId(e.target.value || null); setFOffCurriculumConfirm(false) }}
              >
                <option value="">Choose a course</option>
                {formCourseOptions.map(c => <option key={c.id} value={c.id}>{c.code} — {c.title}</option>)}
              </select>
            </FieldRow>

            {/* Filtered-empty state: don't dead-end the admin — either
                reveal the override or point them at CurriculumTab, same
                programme/level already in hand for the deep link. */}
            {fLevelId && !fShowAllCourses && !formCurriculumLoading && formCourseOptions.length === 0 && (
              <p className="set-empty-hint">
                No courses on this level's curriculum yet.{' '}
                <button type="button" className="set-inline-link" onClick={() => setFShowAllCourses(true)}>
                  Show all courses instead
                </button>
                , or add courses to the curriculum first.
              </p>
            )}

            {fLevelId && !fShowAllCourses && !formCurriculumLoading && formCourseOptions.length > 0 && (
              <p className="set-hint-text">
                Showing courses on this level's curriculum.{' '}
                <button type="button" className="set-inline-link" onClick={() => setFShowAllCourses(true)}>
                  Show all courses instead
                </button>
              </p>
            )}

            {/* Multi-programme/level list (item 2) — two real modes here,
                not one:
                  - CREATE mode (editingOffering is null): interactive
                    checkboxes, as before — checking several creates one
                    offering per checked programme/level in a single save.
                  - EDIT mode (editingOffering is set): READ-ONLY, for
                    visibility/consistency only, per explicit owner
                    direction — checking more boxes here does NOT create
                    additional offerings; Edit always updates exactly the
                    one row being edited, same as before this feature
                    existed. Shown whenever a course is picked, regardless
                    of whether this specific offering has a Programme set,
                    so an admin editing one offering can see every
                    programme/level that teaches this course and where the
                    one they're editing sits among them — with the
                    currently-saved programme/level (if any) shown checked
                    and disabled, everything else shown unchecked and
                    disabled. */}
            {fCourseId && (!fProgrammeId || editingOffering) && (
              <FieldRow label={editingOffering ? 'Programmes/levels teaching this course' : 'Offer to (programmes/levels teaching this course)'}>
                {courseProgrammeLevelsLoading ? (
                  <p className="set-hint-text">Loading…</p>
                ) : courseProgrammeLevels.length === 0 ? (
                  <p className="set-empty-hint">
                    No programme/level currently has this course on its curriculum{terms.length > 0 ? ' for this semester' : ''}.
                    {!editingOffering && ' Add it to a curriculum first (Curriculum tab), or pick a specific Programme/Level above to offer it directly.'}
                  </p>
                ) : (
                  <div className="set-checkbox-list" role="group">
                    {courseProgrammeLevels.map(pl => {
                      const key = `${pl.programme_id}:${pl.programme_level_id}`
                      // In edit mode, "checked" reflects this specific
                      // offering's own saved programme_level_id — NOT the
                      // checkedLevelKeys create-mode state, which is never
                      // touched while editing (openForm() below never
                      // populates it for an edit, so it stays empty).
                      const isChecked = editingOffering
                        ? editingOffering.programme_level_id === pl.programme_level_id
                        : checkedLevelKeys.has(key)
                      return (
                        <label key={key} className="set-checkbox-row">
                          <input
                            type="checkbox"
                            checked={isChecked}
                            disabled={!!editingOffering}
                            onChange={() => { if (!editingOffering) toggleLevelKey(pl.programme_id, pl.programme_level_id) }}
                          />
                          <span>{levelDisplayName(pl)}</span>
                        </label>
                      )
                    })}
                  </div>
                )}
                {!editingOffering && courseProgrammeLevels.length > 0 && (
                  <p className="set-hint-text">
                    {checkedLevelKeys.size === 0
                      ? 'Check at least one programme/level, or pick a specific Programme above instead to offer to just one.'
                      : `Will create ${checkedLevelKeys.size} offering${checkedLevelKeys.size === 1 ? '' : 's'} for this course, one per checked programme/level.`}
                  </p>
                )}
                {editingOffering && courseProgrammeLevels.length > 0 && (
                  <p className="set-hint-text">
                    {editingOffering.programme_level_id && courseProgrammeLevels.some(pl => pl.programme_level_id === editingOffering.programme_level_id)
                      ? 'Shown for reference — this offering is tied to the checked programme/level above. To offer this course to another programme/level as well, use "+ Add offering" separately rather than editing this one.'
                      : editingOffering.programme_level_id
                        ? "This offering's own programme/level isn't in the list above because that programme/level's curriculum doesn't currently include this course (likely saved via \"Show all courses instead\"). The list above shows only programme/levels whose curriculum does include it."
                        : 'This offering has no specific programme/level (shared/unassigned) — none checked above. To restrict it to one programme/level, use the Programme/Level pickers above instead.'}
                  </p>
                )}
              </FieldRow>
            )}

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
              <button
                className="set-save-btn"
                onClick={handleSave}
                disabled={fSaving || (!editingOffering && !fProgrammeId && !!fCourseId && courseProgrammeLevels.length > 0 && checkedLevelKeys.size === 0)}
              >
                {fSaving ? 'Saving…' : 'Save'}
              </button>
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

// ─── Tab: Promotion rules ───────────────────────────────────────────────────
// (SESSION 69, PRD Tier 8, §7.27.1a Design A amendment). Configures the
// "from level X, to level Y, at CGPA cutoff Z" mapping the new
// run_programme_promotion() DB function reads at session end. This tab is
// rules-management ONLY (item 4b) — triggering the actual promotion run and
// reviewing its manual-decision bucket (item 4c) is a deliberately separate,
// later piece of work, not built here; owner's explicit sequencing choice
// this session, since a run/review UI showing every student as
// "no_rule_configured" until real rules exist would be premature.
//
// "To level" is scoped to the SAME programme as "from level" — confirmed
// against real institutional practice before assuming this, not guessed:
// routine annual advancement (the concern this table exists for) is
// universally described as progressing within one programme; a genuine
// change-of-programme is treated as its own distinct workflow everywhere
// it's described (Workday's own docs: "when a student decides to change
// program of study, automatically reevaluate transfer equivalences for the
// NEW programme" — a separate credit-equivalency operation, not a same-
// mechanism promotion). Building cross-programme selection into this rule
// would silently misrepresent a different, harder problem as a simple
// cutoff rule.
function PromotionTab({ schoolId, actorRecordId }: { schoolId: string; actorRecordId: string | null }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [programmes, setProgrammes] = useState<Programme[]>([])
  const [levelsByProgramme, setLevelsByProgramme] = useState<Record<string, ProgrammeLevel[]>>({})
  const [rules, setRules] = useState<ProgrammePromotionRule[]>([])

  const [showAddForm, setShowAddForm] = useState(false)
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null)
  const [formProgrammeId, setFormProgrammeId] = useState<string | null>(null)
  const [formFromLevelId, setFormFromLevelId] = useState<string | null>(null)
  const [formToLevelId, setFormToLevelId] = useState<string | null>(null)
  const [formMinCgpa, setFormMinCgpa] = useState('')
  const [formMaxCarryover, setFormMaxCarryover] = useState('')
  const [formSaving, setFormSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  // SESSION 69, item 4c -- the run itself + the manual-review bucket. Kept
  // independent of the rules-config state above, same separation
  // StandingTab already established between its thresholds form and its
  // own run/review state.
  const [sessions, setSessions] = useState<Session[]>([])
  const [runSessionId, setRunSessionId] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [runResults, setRunResults] = useState<PromotionRunResultRow[] | null>(null)
  const [reviewingStudentId, setReviewingStudentId] = useState<string | null>(null)
  const [reviewToLevelId, setReviewToLevelId] = useState<Record<string, string>>({})
  const [reviewReasonDraft, setReviewReasonDraft] = useState<Record<string, string>>({})
  const [reviewError, setReviewError] = useState<string | null>(null)
  const [decidedStudentIds, setDecidedStudentIds] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const [pRes, rRes, sRes] = await Promise.all([
      loadProgrammes(schoolId),
      loadProgrammePromotionRules(schoolId),
      loadSessions(schoolId),
    ])
    if (pRes.error) { setError(pRes.error); setLoading(false); return }
    if (rRes.error) { setError(rRes.error); setLoading(false); return }
    setProgrammes(pRes.data)
    setRules(rRes.data)
    if (!sRes.error) {
      setSessions(sRes.data)
      // Default the run's session picker to the current session, same
      // "sensible default, not forced to pick every time" reasoning as
      // every other session picker in this file -- but never override an
      // admin's own in-progress selection on a re-load.
      setRunSessionId((prev) => prev ?? sRes.data.find((s: Session) => s.is_current)?.id ?? sRes.data[0]?.id ?? null)
    }
    const levelEntries = await Promise.all(
      pRes.data.map(async (prog) => [prog.id, (await loadProgrammeLevels(prog.id)).data] as const),
    )
    setLevelsByProgramme(Object.fromEntries(levelEntries))
    setLoading(false)
  }, [schoolId])

  useEffect(() => { load() }, [load])

  // Flat lookup so a rule row can display real level labels/programme
  // names without a second per-row query — same "resolve once, render
  // many" shape CurriculumTab's own entries list already uses.
  const allLevels: ProgrammeLevel[] = Object.values(levelsByProgramme).flat()
  const levelLabel = (levelId: string) => allLevels.find((l: ProgrammeLevel) => l.id === levelId)?.level_label ?? 'Unknown level'
  const programmeForLevel = (levelId: string) => programmes.find((p: Programme) => (levelsByProgramme[p.id] ?? []).some((l: ProgrammeLevel) => l.id === levelId))
  const programmeName = (levelId: string) => programmeForLevel(levelId)?.name ?? 'Unknown programme'

  const formLevels = formProgrammeId ? (levelsByProgramme[formProgrammeId] ?? []) : []

  function openAddForm() {
    setEditingRuleId(null)
    setFormProgrammeId(null)
    setFormFromLevelId(null)
    setFormToLevelId(null)
    setFormMinCgpa('')
    setFormMaxCarryover('')
    setFormError(null)
    setShowAddForm(true)
  }

  function openEditForm(rule: ProgrammePromotionRule) {
    const prog = programmeForLevel(rule.from_programme_level_id)
    setEditingRuleId(rule.id)
    setFormProgrammeId(prog?.id ?? null)
    setFormFromLevelId(rule.from_programme_level_id)
    setFormToLevelId(rule.to_programme_level_id)
    setFormMinCgpa(rule.min_cgpa !== null ? String(rule.min_cgpa) : '')
    setFormMaxCarryover(rule.max_carryover_courses !== null ? String(rule.max_carryover_courses) : '')
    setFormError(null)
    setShowAddForm(true)
  }

  async function handleSaveRule() {
    if (!formFromLevelId || !formToLevelId) { setFormError('Choose both a "from" level and a "to" level.'); return }
    if (formFromLevelId === formToLevelId) { setFormError('"From" and "to" levels must be different.'); return }
    let minCgpa: number | null = null
    if (formMinCgpa) {
      const n = Number(formMinCgpa)
      if (Number.isNaN(n) || n < 0) { setFormError('Minimum CGPA must be a non-negative number.'); return }
      minCgpa = n
    }
    let maxCarryover: number | null = null
    if (formMaxCarryover) {
      const n = Number(formMaxCarryover)
      if (Number.isNaN(n) || n < 0 || !Number.isInteger(n)) { setFormError('Max carryover courses must be a non-negative whole number.'); return }
      maxCarryover = n
    }
    setFormError(null)
    setFormSaving(true)
    const res = await upsertProgrammePromotionRule(schoolId, {
      id: editingRuleId ?? undefined,
      from_programme_level_id: formFromLevelId,
      to_programme_level_id: formToLevelId,
      min_cgpa: minCgpa,
      max_carryover_courses: maxCarryover,
    })
    if (res.error) { setFormError(res.error); setFormSaving(false); return }
    setShowAddForm(false)
    setFormSaving(false)
    await load()
  }

  async function handleDeleteRule(ruleId: string) {
    if (!window.confirm('Delete this promotion rule? Students at this level will show as "no rule configured" in the promotion run until a new rule is added.')) return
    const res = await deleteProgrammePromotionRule(schoolId, ruleId)
    if (!res.error) await load()
  }

  // SESSION 69, item 4c -- the promotion run. This WRITES for real (see
  // runProgrammePromotion()'s own doc comment) -- there is no dry-run mode
  // exposed here on purpose, so the admin-facing "Run promotion" action
  // always means a real run, never a silent no-op that could be mistaken
  // for one.
  async function handleRunPromotion() {
    if (!runSessionId) { setRunError('Choose a session to run the promotion pass for.'); return }
    if (!actorRecordId) { setRunError('Could not resolve your staff id -- try reloading the page before running this.'); return }
    if (!window.confirm('This will actually promote every eligible student for the chosen session -- placements are flipped and history rows are written immediately, not previewed. Continue?')) return
    setRunError(null)
    setRunResults(null)
    setDecidedStudentIds(new Set())
    setRunning(true)
    const res = await runProgrammePromotion(runSessionId, actorRecordId)
    setRunning(false)
    if (res.error) { setRunError(res.error); return }
    setRunResults(res.data)
  }

  // One manual decision at a time, per the needs_review bucket -- never a
  // second bulk path, matching record_manual_promotion_decision()'s own
  // one-student-at-a-time design.
  async function handleReviewDecision(row: PromotionRunResultRow, decision: 'promoted' | 'repeated' | 'manual_override') {
    if (!runSessionId) return
    if (!actorRecordId) { setReviewError('Could not resolve your staff id -- try reloading the page.'); return }
    const toLevelId = reviewToLevelId[row.student_id] || null
    const requiresDestination = decision === 'promoted' || decision === 'manual_override'
    if (requiresDestination && !toLevelId) {
      setReviewError(`Choose a destination level for ${row.student_full_name} before confirming a ${decision === 'manual_override' ? 'manual override' : 'promotion'}.`)
      return
    }
    setReviewError(null)
    setReviewingStudentId(row.student_id)
    const res = await recordManualPromotionDecision({
      studentId: row.student_id,
      sessionId: runSessionId,
      decision,
      toProgrammeLevelId: requiresDestination ? toLevelId : null,
      decidedByStaffId: actorRecordId,
      reason: reviewReasonDraft[row.student_id]?.trim() || `Manual review: ${decision}`,
    })
    setReviewingStudentId(null)
    if (res.error) { setReviewError(res.error); return }
    setDecidedStudentIds(prev => { const next = new Set(prev); next.add(row.student_id); return next })
  }

  const REVIEW_DECISION_LABEL: Record<'promoted' | 'repeated' | 'manual_override', string> = {
    promoted: 'Promote',
    repeated: 'Repeat this level',
    manual_override: 'Manual override',
  }

  if (loading) return <div className="set-tab-content"><p className="set-hint-text">Loading…</p></div>
  if (error) return <div className="set-tab-content"><p className="set-form-error">{error}</p></div>

  return (
    <div className="set-tab-content">
      <div className="set-section-header">
        <SectionLabel>Promotion rules</SectionLabel>
        <button className="set-add-btn" onClick={openAddForm} disabled={programmes.length === 0}>+ Add rule</button>
      </div>

      {programmes.length === 0 ? (
        <p className="set-empty-hint">No programmes yet — add one in the Institution tab first.</p>
      ) : rules.length === 0 ? (
        <p className="set-empty-hint">
          No promotion rules configured yet. Without a rule, students at a level are shown as
          "no rule configured" when a promotion run is done, and are never silently promoted or held back.
        </p>
      ) : (
        rules.map(r => (
          <div key={r.id} className="set-list-row">
            <div className="set-list-row-info">
              <p className="set-list-row-name">
                {programmeName(r.from_programme_level_id)}: {levelLabel(r.from_programme_level_id)} → {levelLabel(r.to_programme_level_id)}
              </p>
              <p className="set-list-row-meta">
                {r.min_cgpa !== null ? `Min CGPA ${r.min_cgpa.toFixed(2)}` : 'No CGPA cutoff — always promotes'}
                {r.max_carryover_courses !== null && ` · Max ${r.max_carryover_courses} carryover course${r.max_carryover_courses === 1 ? '' : 's'} (not yet enforced by the promotion run)`}
              </p>
            </div>
            <div className="set-list-row-actions">
              <button className="set-edit-btn" onClick={() => openEditForm(r)}>Edit</button>
              <button className="set-edit-btn" onClick={() => handleDeleteRule(r.id)}>Delete</button>
            </div>
          </div>
        ))
      )}

      {showAddForm && (
        <div className="set-overlay" onClick={() => setShowAddForm(false)}>
          <div className="set-sheet" onClick={e => e.stopPropagation()}>
            <h2 className="set-sheet-title">{editingRuleId ? 'Edit promotion rule' : 'Add promotion rule'}</h2>

            <FieldRow label="Programme">
              <select
                className="set-select"
                value={formProgrammeId ?? ''}
                onChange={e => { setFormProgrammeId(e.target.value || null); setFormFromLevelId(null); setFormToLevelId(null) }}
                disabled={!!editingRuleId}
              >
                <option value="">Choose a programme</option>
                {programmes.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </FieldRow>

            {formProgrammeId && (
              <FieldRow label="From level">
                <select className="set-select" value={formFromLevelId ?? ''} onChange={e => setFormFromLevelId(e.target.value || null)}>
                  <option value="">Choose a level</option>
                  {formLevels.map(l => <option key={l.id} value={l.id}>{l.level_label}</option>)}
                </select>
              </FieldRow>
            )}

            {formProgrammeId && (
              <FieldRow label="To level">
                <select className="set-select" value={formToLevelId ?? ''} onChange={e => setFormToLevelId(e.target.value || null)}>
                  <option value="">Choose a level</option>
                  {formLevels.filter(l => l.id !== formFromLevelId).map(l => <option key={l.id} value={l.id}>{l.level_label}</option>)}
                </select>
              </FieldRow>
            )}

            <FieldRow label="Minimum CGPA (optional)">
              <Input value={formMinCgpa} onChange={setFormMinCgpa} placeholder="e.g. 2.00 — leave blank to always promote" />
            </FieldRow>

            <FieldRow label="Max carryover courses (optional)">
              <Input value={formMaxCarryover} onChange={setFormMaxCarryover} placeholder="Not yet enforced by the promotion run" />
            </FieldRow>

            {formError && <p className="set-form-error">{formError}</p>}
            <div className="set-sheet-footer">
              <button className="set-cancel-btn" onClick={() => setShowAddForm(false)}>Cancel</button>
              <button className="set-save-btn" onClick={handleSaveRule} disabled={formSaving}>{formSaving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}

      {/* SESSION 69, item 4c -- the run itself + three-bucket review, same
          overall section shape as StandingTab's "Session-end evaluation" +
          "Pending review" sections below its own thresholds form. */}
      <div className="set-section-header" style={{ marginTop: '2rem' }}>
        <SectionLabel>Promotion run</SectionLabel>
      </div>
      <p className="set-hint-text">
        Auto-promotes every student at or above their level's CGPA cutoff, and lists everyone else
        below for a manual decision — nobody is ever silently retained or silently skipped. This
        writes for real the moment you run it; there is no separate preview step here.
      </p>
      <FieldRow label="Session">
        <select className="set-select" value={runSessionId ?? ''} onChange={e => setRunSessionId(e.target.value || null)}>
          <option value="">Choose a session</option>
          {sessions.map(s => <option key={s.id} value={s.id}>{s.name}{s.is_current ? ' (current)' : ''}</option>)}
        </select>
      </FieldRow>
      <div className="set-sheet-footer" style={{ paddingLeft: 0 }}>
        <button className="set-save-btn" onClick={handleRunPromotion} disabled={running || !runSessionId}>
          {running ? 'Running…' : 'Run promotion'}
        </button>
      </div>
      {runError && <p className="set-form-error">{runError}</p>}

      {runResults && (
        <>
          {(() => {
            const autoPromoted = runResults.filter(r => r.outcome === 'auto_promoted')
            const graduated = runResults.filter(r => r.outcome === 'graduated')
            const needsReview = runResults.filter(r => r.outcome === 'needs_review')
            const noRule = runResults.filter(r => r.outcome === 'no_rule_configured')
            return (
              <>
                <p className="set-hint-text" style={{ marginTop: '1rem' }}>
                  Considered {runResults.length} student{runResults.length === 1 ? '' : 's'}:{' '}
                  {autoPromoted.length} promoted, {graduated.length} graduated,{' '}
                  {needsReview.length} need{needsReview.length === 1 ? 's' : ''} manual review,{' '}
                  {noRule.length} with no rule configured for their level.
                </p>

                {autoPromoted.length > 0 && (
                  <div style={{ marginTop: '1rem' }}>
                    <SectionLabel>Auto-promoted ({autoPromoted.length})</SectionLabel>
                    <ul className="set-list">
                      {autoPromoted.map(r => (
                        <li key={r.student_id} className="set-list-row">
                          <div className="set-list-row-info">
                            <p className="set-list-row-name">{r.student_full_name}</p>
                            <p className="set-list-row-meta">
                              {levelLabel(r.from_programme_level_id)} → {r.to_programme_level_id ? levelLabel(r.to_programme_level_id) : '—'}
                              {r.cgpa !== null ? ` · CGPA ${r.cgpa.toFixed(2)}` : ''}
                            </p>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {graduated.length > 0 && (
                  <div style={{ marginTop: '1rem' }}>
                    <SectionLabel>Graduated ({graduated.length})</SectionLabel>
                    <ul className="set-list">
                      {graduated.map(r => (
                        <li key={r.student_id} className="set-list-row">
                          <div className="set-list-row-info">
                            <p className="set-list-row-name">{r.student_full_name}</p>
                            <p className="set-list-row-meta">
                              {levelLabel(r.from_programme_level_id)} · final level
                              {r.cgpa !== null ? ` · CGPA ${r.cgpa.toFixed(2)}` : ''}
                            </p>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {noRule.length > 0 && (
                  <div style={{ marginTop: '1rem' }}>
                    <SectionLabel>No rule configured ({noRule.length})</SectionLabel>
                    <p className="set-hint-text">
                      Add a promotion rule above for these students' levels — nothing was changed for them.
                    </p>
                    <ul className="set-list">
                      {noRule.map(r => (
                        <li key={r.student_id} className="set-list-row">
                          <div className="set-list-row-info">
                            <p className="set-list-row-name">{r.student_full_name}</p>
                            <p className="set-list-row-meta">{programmeName(r.from_programme_level_id)}: {levelLabel(r.from_programme_level_id)}</p>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {needsReview.length > 0 && (
                  <div style={{ marginTop: '1rem' }}>
                    <SectionLabel>Needs manual review ({needsReview.length})</SectionLabel>
                    {reviewError && <p className="set-form-error">{reviewError}</p>}
                    <ul className="set-list">
                      {needsReview.map(r => {
                        const decided = decidedStudentIds.has(r.student_id)
                        const fromProg = programmeForLevel(r.from_programme_level_id)
                        const levelsForThisProgramme = fromProg ? (levelsByProgramme[fromProg.id] ?? []) : []
                        return (
                          <li key={r.student_id} className="set-list-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '0.5rem' }}>
                            <div>
                              <p className="set-list-row-title">{r.student_full_name}</p>
                              <p className="set-list-row-meta">
                                {programmeName(r.from_programme_level_id)}: {levelLabel(r.from_programme_level_id)}
                                {r.cgpa !== null ? ` · CGPA ${r.cgpa.toFixed(2)}` : ' · no CGPA on record'}
                                {r.min_cgpa !== null ? ` (cutoff ${r.min_cgpa.toFixed(2)})` : ''}
                              </p>
                            </div>
                            {decided ? (
                              <p className="set-hint-text">Decision recorded.</p>
                            ) : (
                              <>
                                <select
                                  className="set-select"
                                  value={reviewToLevelId[r.student_id] ?? ''}
                                  onChange={e => setReviewToLevelId(prev => ({ ...prev, [r.student_id]: e.target.value }))}
                                >
                                  <option value="">Destination level (only needed if promoting)</option>
                                  {levelsForThisProgramme.filter(l => l.id !== r.from_programme_level_id).map(l => (
                                    <option key={l.id} value={l.id}>{l.level_label}</option>
                                  ))}
                                </select>
                                <Input
                                  value={reviewReasonDraft[r.student_id] ?? ''}
                                  onChange={(v) => setReviewReasonDraft(prev => ({ ...prev, [r.student_id]: v }))}
                                  placeholder="Reason (optional)…"
                                />
                                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                                  <button
                                    className="set-save-btn"
                                    onClick={() => handleReviewDecision(r, 'promoted')}
                                    disabled={reviewingStudentId === r.student_id}
                                  >
                                    {reviewingStudentId === r.student_id ? 'Saving…' : REVIEW_DECISION_LABEL.promoted}
                                  </button>
                                  <button
                                    className="set-cancel-btn"
                                    onClick={() => handleReviewDecision(r, 'repeated')}
                                    disabled={reviewingStudentId === r.student_id}
                                  >
                                    {REVIEW_DECISION_LABEL.repeated}
                                  </button>
                                  <button
                                    className="set-cancel-btn"
                                    onClick={() => handleReviewDecision(r, 'manual_override')}
                                    disabled={reviewingStudentId === r.student_id}
                                  >
                                    {REVIEW_DECISION_LABEL.manual_override}
                                  </button>
                                </div>
                              </>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                )}
              </>
            )
          })()}
        </>
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

// ─── Tab: Admission (SESSION 65c, redesign proposal §7/§8) ─────────────────────
//
// Five independent sections on one tab, matching the proposal's own §7/§8
// grouping: master switch, pipelines (+ per-pipeline stage/component
// checklist), application field settings, matric number format (relocated
// here from AdmissionModule.tsx per 65b's own note — logic unchanged, still
// backed by admissionService.ts's matric functions), and the rejection
// retention window. Kept as one tab (not five) because they're all
// "admission configuration" from the owner's point of view and none is
// large enough alone to earn a dedicated top-level tab, unlike e.g.
// Offerings vs Curriculum.

function AdmissionSettingsTab({ schoolId }: { schoolId: string }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [master, setMaster] = useState<AdmissionMasterSettingsLocal | null>(null)
  const [pipelines, setPipelines] = useState<AdmissionPipeline[]>([])
  const [fieldSettings, setFieldSettings] = useState<AdmissionFieldSettings | null>(null)
  const [programmes, setProgrammes] = useState<Programme[]>([])
  const [matricFormat, setMatricFormat] = useState<MatricNumberFormat | null>(null)
  const [hasMatricAdmissions, setHasMatricAdmissions] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const [masterRes, pipelinesRes, fieldRes, progRes, matricRes, matricLockRes] = await Promise.all([
      loadAdmissionMasterSettings(schoolId),
      loadAllPipelines(schoolId),
      loadFieldSettings(schoolId),
      loadProgrammes(schoolId),
      loadMatricNumberFormat(schoolId),
      hasAnyMatricAdmissions(schoolId),
    ])
    if (masterRes.error) { setError(masterRes.error); setLoading(false); return }
    if (pipelinesRes.error) { setError(pipelinesRes.error); setLoading(false); return }
    if (fieldRes.error) { setError(fieldRes.error); setLoading(false); return }
    if (matricRes.error) { setError(matricRes.error); setLoading(false); return }
    setMaster(masterRes.data)
    setPipelines(pipelinesRes.data)
    setFieldSettings(fieldRes.data)
    setProgrammes(progRes.data)
    setMatricFormat(matricRes.data)
    setHasMatricAdmissions(matricLockRes.data)
    setLoading(false)
  }, [schoolId])

  useEffect(() => { load() }, [load])

  if (loading) return <Skeleton />
  if (error) return <ErrorState message={error} onRetry={load} />

  return (
    <div className="set-tab-content">
      <AdmissionMasterSwitchSection schoolId={schoolId} master={master} onChange={setMaster} />
      <AdmissionPipelinesSection schoolId={schoolId} pipelines={pipelines} programmes={programmes} onReload={load} />
      <AdmissionFieldSettingsSection schoolId={schoolId} fieldSettings={fieldSettings} onReload={load} />
      <AdmissionMatricFormatSection
        schoolId={schoolId}
        format={matricFormat}
        hasAdmissions={hasMatricAdmissions}
        onReload={load}
      />
      <AdmissionMatricScopeSection schoolId={schoolId} master={master} onChange={setMaster} programmes={programmes} />
      <AdmissionManualMatricSection schoolId={schoolId} />
      <AdmissionRetentionSection schoolId={schoolId} master={master} onChange={setMaster} />
    </div>
  )
}

// Local alias, not re-exported from admissionService.ts as a name change —
// just avoids the section components below each re-declaring the same
// inline shape.
type AdmissionMasterSettingsLocal = {
  admission_pipeline_enabled: boolean
  rejection_retention_days: number
  matric_sequence_scope_default: MatricSequenceScope
}

// ─── Admission: master switch ───────────────────────────────────────────────
//
// Per the proposal's §5 requirement ("a real confirmation step since it
// changes how every future student gets added") — this is a native confirm()
// dialog, matching the same pattern RolesTab's handleDelete() already uses
// for its own irreversible-ish action, rather than inventing a new modal
// pattern for just this one toggle.

function AdmissionMasterSwitchSection({
  schoolId, master, onChange,
}: {
  schoolId: string
  master: AdmissionMasterSettingsLocal | null
  onChange: (m: AdmissionMasterSettingsLocal) => void
}) {
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function handleToggle(next: boolean) {
    const verb = next ? 'enable' : 'disable'
    const consequence = next
      ? 'Once enabled, students can no longer be added directly from the Students module — all new admissions must go through the pipeline here.'
      : 'Once disabled, staff will be able to add students directly again, bypassing the admission pipeline.'
    if (!confirm(`${verb.charAt(0).toUpperCase() + verb.slice(1)} the admission pipeline?\n\n${consequence}`)) return
    setSaving(true)
    setErr(null)
    const res = await setAdmissionPipelineEnabled(schoolId, next)
    if (res.error) { setErr(res.error); setSaving(false); return }
    if (master) onChange({ ...master, admission_pipeline_enabled: next })
    setSaving(false)
  }

  return (
    <div className="set-section-header" style={{ marginBottom: 0 }}>
      <div className="set-list-row" style={{ padding: 0, border: 'none' }}>
        <div className="set-list-row-info">
          <p className="set-list-row-name">Admission pipeline</p>
          <p className="set-list-row-meta">
            {master?.admission_pipeline_enabled
              ? 'Enabled — new students are added only through admission applications below.'
              : 'Disabled — students can still be added directly from the Students module.'}
          </p>
          {saving && <p className="set-list-row-meta">Saving…</p>}
          {err && <p className="set-form-error">{err}</p>}
        </div>
        <div style={{ opacity: saving ? 0.6 : 1, pointerEvents: saving ? 'none' : 'auto' }} aria-disabled={saving}>
          <Toggle
            checked={master?.admission_pipeline_enabled ?? false}
            onChange={handleToggle}
            label="Admission pipeline enabled"
          />
        </div>
      </div>
    </div>
  )
}

// ─── Admission: pipelines + stage/component checklist ──────────────────────
//
// Per §4.2/§7 of the proposal: each pipeline has a matching rule
// (applies_to: entry_mode/programme_id, or is_default) and an ordered set of
// stages (screening/decision/clearance, fixed order per the §12 decision),
// each stage carrying a component checklist. Stage add/remove is
// presence-based (upsertPipelineStage keyed on pipeline_id+stage,
// deletePipelineStage by row id) — matching the service layer's own
// documented convention, not a separate "stage order" field, since order is
// fixed application-wide, not per-pipeline.

const PIPELINE_STAGE_TYPES: { type: PipelineStageType; label: string; components: { key: string; label: string }[] }[] = [
  {
    type: 'screening', label: 'Screening',
    components: [
      { key: 'document_review', label: 'Document review' },
      { key: 'jamb_verification', label: 'JAMB verification' },
      { key: 'olevel_verification', label: "O'Level verification" },
      { key: 'interview', label: 'Interview' },
      { key: 'aptitude_test', label: 'Aptitude test' },
    ],
  },
  {
    type: 'decision', label: 'Decision',
    components: [
      { key: 'committee_review', label: 'Committee review' },
      { key: 'programme_confirmation', label: 'Programme/level confirmation' },
    ],
  },
  {
    type: 'clearance', label: 'Clearance',
    components: [
      { key: 'fee_payment', label: 'Fee payment' },
      { key: 'medical_clearance', label: 'Medical clearance' },
      { key: 'document_submission', label: 'Original document submission' },
    ],
  },
]

function AdmissionPipelinesSection({
  schoolId, pipelines, programmes, onReload,
}: {
  schoolId: string
  pipelines: AdmissionPipeline[]
  programmes: Programme[]
  onReload: () => void
}) {
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<AdmissionPipeline | null>(null)
  const [name, setName] = useState('')
  const [entryMode, setEntryMode] = useState<EntryMode | ''>('')
  const [programmeId, setProgrammeId] = useState('')
  const [isDefault, setIsDefault] = useState(false)
  const [isActive, setIsActive] = useState(true)
  const [stageComponents, setStageComponents] = useState<Record<PipelineStageType, Record<string, boolean>>>({
    screening: {}, decision: {}, clearance: {},
  })
  const [saving, setSaving] = useState(false)
  const [formErr, setFormErr] = useState<string | null>(null)

  function openForm(p?: AdmissionPipeline) {
    setEditing(p ?? null)
    setName(p?.name ?? '')
    setEntryMode((p?.applies_to.entry_mode as EntryMode) ?? '')
    setProgrammeId(p?.applies_to.programme_id ?? '')
    setIsDefault(p?.is_default ?? false)
    setIsActive(p?.is_active ?? true)
    const initial: Record<PipelineStageType, Record<string, boolean>> = { screening: {}, decision: {}, clearance: {} }
    p?.stages.forEach(s => { initial[s.stage] = { ...s.components } })
    setStageComponents(initial)
    setFormErr(null)
    setShowForm(true)
  }

  function toggleComponent(stage: PipelineStageType, key: string) {
    setStageComponents(prev => ({
      ...prev,
      [stage]: { ...prev[stage], [key]: !prev[stage][key] },
    }))
  }

  async function handleSave() {
    if (!name.trim()) { setFormErr('Pipeline name is required.'); return }
    setSaving(true)
    setFormErr(null)

    const appliesTo: { entry_mode?: EntryMode; programme_id?: string } = {}
    if (entryMode) appliesTo.entry_mode = entryMode
    if (programmeId) appliesTo.programme_id = programmeId

    const res = await upsertPipeline(schoolId, {
      id: editing?.id,
      name: name.trim(),
      applies_to: appliesTo,
      is_default: isDefault,
      is_active: isActive,
    })
    if (res.error || !res.data) { setFormErr(res.error ?? 'Could not save pipeline.'); setSaving(false); return }
    const pipelineId = res.data.id

    // Reconcile stage rows: upsert any stage with at least one component
    // checked, delete any existing stage row whose checklist was cleared to
    // empty — matches upsertPipelineStage()'s own documented contract (a
    // components: {} state isn't a valid upsert, it's a removal).
    for (const stageDef of PIPELINE_STAGE_TYPES) {
      const comps = stageComponents[stageDef.type]
      const anyChecked = Object.values(comps).some(Boolean)
      const existing = editing?.stages.find(s => s.stage === stageDef.type)
      if (anyChecked) {
        const stageRes = await upsertPipelineStage(pipelineId, stageDef.type, comps)
        if (stageRes.error) { setFormErr(stageRes.error); setSaving(false); return }
      } else if (existing) {
        const delRes = await deletePipelineStage(existing.id)
        if (delRes.error) { setFormErr(delRes.error); setSaving(false); return }
      }
    }

    setShowForm(false)
    setSaving(false)
    onReload()
  }

  function stageSummary(p: AdmissionPipeline): string {
    if (p.stages.length === 0) return 'No stages — admits or rejects directly'
    return p.stages.map(s => PIPELINE_STAGE_TYPES.find(d => d.type === s.stage)?.label ?? s.stage).join(' → ')
  }

  function matchSummary(p: AdmissionPipeline): string {
    const parts: string[] = []
    if (p.applies_to.entry_mode) parts.push(p.applies_to.entry_mode === 'utme' ? 'UTME' : 'Direct Entry')
    if (p.applies_to.programme_id) {
      const prog = programmes.find(pr => pr.id === p.applies_to.programme_id)
      parts.push(prog ? prog.name : 'a specific programme')
    }
    if (parts.length === 0) return p.is_default ? 'Default pipeline (fallback)' : 'No matching rule set'
    return `Applies to: ${parts.join(', ')}`
  }

  return (
    <div className="set-tab-content" style={{ paddingTop: 24 }}>
      <div className="set-section-header">
        <SectionLabel>Admission pipelines</SectionLabel>
        <button className="set-add-btn" onClick={() => openForm()}>+ Add pipeline</button>
      </div>

      {pipelines.length === 0
        ? <p className="set-empty-hint">No pipelines yet. Applications will have no stages assigned until at least one pipeline exists — set one as default to cover every applicant, or add matching rules for specific entry modes/programmes.</p>
        : pipelines.map(p => (
          <div key={p.id} className="set-list-row">
            <div className="set-list-row-info">
              <p className="set-list-row-name">
                {p.name}
                {p.is_default && <span className="set-admin-chip">Default</span>}
                {!p.is_active && <span className="set-admin-chip">Inactive</span>}
              </p>
              <p className="set-list-row-meta">{matchSummary(p)}</p>
              <p className="set-list-row-meta">{stageSummary(p)}</p>
            </div>
            <div className="set-list-row-actions">
              <button className="set-edit-btn" onClick={() => openForm(p)}>Edit</button>
            </div>
          </div>
        ))
      }

      {showForm && (
        <div className="set-overlay" onClick={() => setShowForm(false)}>
          <div className="set-sheet set-sheet--tall" onClick={e => e.stopPropagation()}>
            <h2 className="set-sheet-title">{editing ? 'Edit pipeline' : 'Add pipeline'}</h2>
            <FieldRow label="Pipeline name"><Input value={name} onChange={setName} placeholder="e.g. UTME General, Direct Entry Nursing" /></FieldRow>

            <p className="set-section-label set-section-label--mt">Matching rule</p>
            <p className="set-empty-hint" style={{ margin: '0 0 8px' }}>
              Leave both blank if this pipeline should only ever be used as the default fallback.
            </p>
            <FieldRow label="Entry mode">
              <select className="set-select" value={entryMode} onChange={e => setEntryMode(e.target.value as EntryMode | '')}>
                <option value="">Any entry mode</option>
                <option value="utme">UTME</option>
                <option value="direct_entry">Direct Entry</option>
              </select>
            </FieldRow>
            <FieldRow label="Programme">
              <select className="set-select" value={programmeId} onChange={e => setProgrammeId(e.target.value)}>
                <option value="">Any programme</option>
                {programmes.map(pr => <option key={pr.id} value={pr.id}>{pr.name}</option>)}
              </select>
            </FieldRow>
            <Toggle checked={isDefault} onChange={setIsDefault} label="Use as the default pipeline for this school" />
            <Toggle checked={isActive} onChange={setIsActive} label="Active" />

            <p className="set-section-label set-section-label--mt">Stages</p>
            <p className="set-empty-hint" style={{ margin: '0 0 8px' }}>
              Stage order is fixed (Screening → Decision → Clearance → Admitted/Rejected). Leave a stage's components all unchecked to skip that stage entirely for this pipeline.
            </p>
            <div className="set-perm-list">
              {PIPELINE_STAGE_TYPES.map(stageDef => (
                <div key={stageDef.type} className="set-perm-module">
                  <p className="set-perm-module-name">{stageDef.label}</p>
                  {stageDef.components.map(c => (
                    <label key={c.key} className="set-perm-row">
                      <input
                        type="checkbox"
                        className="set-perm-check"
                        checked={!!stageComponents[stageDef.type][c.key]}
                        onChange={() => toggleComponent(stageDef.type, c.key)}
                      />
                      <div><span className="set-perm-desc">{c.label}</span></div>
                    </label>
                  ))}
                </div>
              ))}
            </div>

            {formErr && <p className="set-form-error">{formErr}</p>}
            <div className="set-sheet-footer">
              <button className="set-cancel-btn" onClick={() => setShowForm(false)}>Cancel</button>
              <button className="set-save-btn" onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save pipeline'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Admission: application field settings ──────────────────────────────────
//
// One shared, school-wide config (confirmed, not per-pipeline — the
// proposal's own §10 flagged this as an assumption worth confirming; the
// owner confirmed shared school-wide, which also matches the DB shape
// already built: admission_field_settings is unique(school_id), not keyed
// by pipeline). Identity/programme-intent fields aren't listed here at all
// since they're not configurable, matching FIELD_CONFIG_KEYS' own scope.

function AdmissionFieldSettingsSection({
  schoolId, fieldSettings, onReload,
}: {
  schoolId: string
  fieldSettings: AdmissionFieldSettings | null
  onReload: () => void
}) {
  const [config, setConfig] = useState<Record<string, { enabled: boolean; required: boolean }>>(
    fieldSettings?.field_config ?? {},
  )
  const [customFields, setCustomFields] = useState<AdmissionCustomField[]>(fieldSettings?.custom_fields ?? [])
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)

  const [showCustomForm, setShowCustomForm] = useState(false)
  const [cfKey, setCfKey] = useState('')
  const [cfLabel, setCfLabel] = useState('')
  const [cfType, setCfType] = useState<AdmissionCustomField['type']>('text')
  const [cfOptions, setCfOptions] = useState('')
  const [cfRequired, setCfRequired] = useState(false)

  useEffect(() => {
    setConfig(fieldSettings?.field_config ?? {})
    setCustomFields(fieldSettings?.custom_fields ?? [])
    setDirty(false)
  }, [fieldSettings])

  function toggle(key: ConfigurableField, field: 'enabled' | 'required') {
    setConfig(prev => {
      const current = prev[key] ?? { enabled: false, required: false }
      const next = { ...current, [field]: !current[field] }
      // A field can't be required without being enabled.
      if (field === 'enabled' && !next.enabled) next.required = false
      return { ...prev, [key]: next }
    })
    setDirty(true)
  }

  function addCustomField() {
    if (!cfKey.trim() || !cfLabel.trim()) return
    const field: AdmissionCustomField = {
      key: cfKey.trim().toLowerCase().replace(/\s+/g, '_'),
      label: cfLabel.trim(),
      type: cfType,
      required: cfRequired,
      ...(cfType === 'select' ? { options: cfOptions.split(',').map(o => o.trim()).filter(Boolean) } : {}),
    }
    setCustomFields(prev => [...prev, field])
    setDirty(true)
    setShowCustomForm(false)
    setCfKey(''); setCfLabel(''); setCfType('text'); setCfOptions(''); setCfRequired(false)
  }

  function removeCustomField(key: string) {
    setCustomFields(prev => prev.filter(f => f.key !== key))
    setDirty(true)
  }

  async function handleSave() {
    setSaving(true)
    setErr(null)
    const res = await saveFieldSettings(schoolId, config, customFields)
    if (res.error) { setErr(res.error); setSaving(false); return }
    setSaving(false)
    setDirty(false)
    onReload()
  }

  return (
    <div className="set-tab-content" style={{ paddingTop: 24 }}>
      <div className="set-section-header">
        <SectionLabel>Application fields</SectionLabel>
      </div>
      <p className="set-empty-hint" style={{ margin: '0 0 8px' }}>
        Identity and programme details are always captured. These JAMB/O'Level/Direct Entry fields are optional — enable the ones this school needs, and mark any as required.
      </p>

      <div className="set-perm-list">
        <div className="set-perm-module">
          {FIELD_CONFIG_KEYS.map(f => (
            <label key={f.key} className="set-perm-row">
              <input
                type="checkbox"
                className="set-perm-check"
                checked={config[f.key]?.enabled ?? false}
                onChange={() => toggle(f.key, 'enabled')}
              />
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flex: 1 }}>
                <span className="set-perm-desc">{f.label}</span>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, opacity: config[f.key]?.enabled ? 1 : 0.4 }}>
                  <input
                    type="checkbox"
                    disabled={!config[f.key]?.enabled}
                    checked={config[f.key]?.required ?? false}
                    onChange={() => toggle(f.key, 'required')}
                  />
                  Required
                </label>
              </div>
            </label>
          ))}
        </div>
      </div>

      <div className="set-section-header" style={{ marginTop: 20 }}>
        <SectionLabel>Custom fields</SectionLabel>
        <button className="set-add-btn" onClick={() => setShowCustomForm(true)}>+ Add custom field</button>
      </div>
      {customFields.length === 0
        ? <p className="set-empty-hint">No custom fields defined.</p>
        : customFields.map(f => (
          <div key={f.key} className="set-list-row">
            <div className="set-list-row-info">
              <p className="set-list-row-name">{f.label}{f.required && <span className="set-admin-chip">Required</span>}</p>
              <p className="set-list-row-meta">{f.type}{f.options ? ` — ${f.options.join(', ')}` : ''}</p>
            </div>
            <div className="set-list-row-actions">
              <button className="set-delete-btn" onClick={() => removeCustomField(f.key)} aria-label={`Remove ${f.label}`}>
                <Icon name="x" size={16} />
              </button>
            </div>
          </div>
        ))
      }

      {err && <p className="set-form-error">{err}</p>}
      {dirty && (
        <div className="set-sheet-footer" style={{ padding: '12px 0', borderTop: 'none' }}>
          <button className="set-save-btn" onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save field settings'}</button>
        </div>
      )}

      {showCustomForm && (
        <div className="set-overlay" onClick={() => setShowCustomForm(false)}>
          <div className="set-sheet" onClick={e => e.stopPropagation()}>
            <h2 className="set-sheet-title">Add custom field</h2>
            <FieldRow label="Field key"><Input value={cfKey} onChange={setCfKey} placeholder="e.g. sponsor_name" /></FieldRow>
            <FieldRow label="Label"><Input value={cfLabel} onChange={setCfLabel} placeholder="e.g. Sponsor's Name" /></FieldRow>
            <FieldRow label="Type">
              <select className="set-select" value={cfType} onChange={e => setCfType(e.target.value as AdmissionCustomField['type'])}>
                <option value="text">Text</option>
                <option value="number">Number</option>
                <option value="date">Date</option>
                <option value="select">Select (dropdown)</option>
              </select>
            </FieldRow>
            {cfType === 'select' && (
              <FieldRow label="Options (comma-separated)"><Input value={cfOptions} onChange={setCfOptions} placeholder="e.g. Yes, No, Not applicable" /></FieldRow>
            )}
            <Toggle checked={cfRequired} onChange={setCfRequired} label="Required" />
            <div className="set-sheet-footer">
              <button className="set-cancel-btn" onClick={() => setShowCustomForm(false)}>Cancel</button>
              <button className="set-save-btn" onClick={addCustomField}>Add field</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Admission: matric number format ────────────────────────────────────────
//
// Relocated here from AdmissionModule.tsx per 65b's own note — the UI editor
// moved, the underlying data functions (loadMatricNumberFormat/
// saveMatricNumberFormat/hasAnyMatricAdmissions, admissionService.ts) did
// not, since that file's header comment already explains why they stay
// there alongside admitStudent(). The soft-lock warning (§12 decision:
// "once matric_sequence_counters has any row with current_value > 0") is
// surfaced here via hasAnyMatricAdmissions, exactly as that function's own
// comment specifies — this component is responsible for showing it before
// save, saveMatricNumberFormat() itself does not block.

const MATRIC_COMPONENT_TYPES: { type: MatricNumberComponentType; label: string }[] = [
  { type: 'programme_code', label: 'Programme code' },
  { type: 'faculty_code', label: 'Faculty code' },
  { type: 'department_code', label: 'Department code' },
  { type: 'session_year', label: 'Session year' },
  { type: 'constant', label: 'Constant text' },
  { type: 'sequence', label: 'Sequence number' },
]

function AdmissionMatricFormatSection({
  schoolId, format, hasAdmissions, onReload,
}: {
  schoolId: string
  format: MatricNumberFormat | null
  hasAdmissions: boolean
  onReload: () => void
}) {
  const [components, setComponents] = useState<MatricNumberComponent[]>(format?.components ?? [])
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => { setComponents(format?.components ?? []) }, [format])

  function addComponent(type: MatricNumberComponentType) {
    setComponents(prev => [
      ...prev,
      {
        type,
        separator: prev.length === 0 ? null : '/',
        ...(type === 'constant' ? { value: '' } : {}),
        ...(type === 'session_year' ? { year_format: '4digit' as const } : {}),
        ...(type === 'sequence' ? { digits: 4 } : {}),
      },
    ])
  }

  function updateComponent(index: number, patch: Partial<MatricNumberComponent>) {
    setComponents(prev => prev.map((c, i) => i === index ? { ...c, ...patch } : c))
  }

  function removeComponent(index: number) {
    setComponents(prev => prev.filter((_, i) => i !== index))
  }

  function previewFormat(): string {
    return components.map((c, i) => {
      const sep = i === 0 ? '' : (c.separator ?? '')
      switch (c.type) {
        case 'programme_code': return sep + 'NUR'
        case 'faculty_code': return sep + 'SCI'
        case 'department_code': return sep + 'CSC'
        case 'session_year': return sep + (c.year_format === '2digit' ? '26' : '2026')
        case 'constant': return sep + (c.value || '')
        case 'sequence': return sep + '1'.padStart(c.digits ?? 4, '0')
        default: return sep
      }
    }).join('')
  }

  async function handleSave() {
    if (components.length === 0) { setErr('Add at least one component.'); return }
    if (hasAdmissions) {
      if (!confirm('This school has already admitted students under the current format. Changing it now starts a new version — existing matric numbers are unaffected, but double-check this is intentional before saving.')) return
    }
    setSaving(true)
    setErr(null)
    const res = await saveMatricNumberFormat(schoolId, components)
    if (res.error) { setErr(res.error); setSaving(false); return }
    setSaving(false)
    onReload()
  }

  return (
    <div className="set-tab-content" style={{ paddingTop: 24 }}>
      <div className="set-section-header">
        <SectionLabel>Matric number format</SectionLabel>
      </div>
      {hasAdmissions && (
        <p className="set-empty-hint" style={{ margin: '0 0 8px' }}>
          Students have already been admitted under the current format. You can still change it, but existing matric numbers won't be affected — only new admissions will use the updated format.
        </p>
      )}

      {components.length === 0
        ? <p className="set-empty-hint">No format configured yet — new admissions can't be given a matric number until one is set.</p>
        : (
          <div className="set-perm-list">
            <div className="set-perm-module">
              {components.map((c, i) => (
                <div key={i} className="set-perm-row" style={{ flexWrap: 'wrap', gap: 8 }}>
                  <span className="set-perm-desc" style={{ minWidth: 130 }}>
                    {MATRIC_COMPONENT_TYPES.find(t => t.type === c.type)?.label ?? c.type}
                  </span>
                  {i > 0 && (
                    <Input value={c.separator ?? ''} onChange={v => updateComponent(i, { separator: v || null })} placeholder="separator, e.g. /" />
                  )}
                  {c.type === 'constant' && (
                    <Input value={c.value ?? ''} onChange={v => updateComponent(i, { value: v })} placeholder="e.g. UNI" />
                  )}
                  {c.type === 'session_year' && (
                    <select className="set-select set-select--sm" value={c.year_format ?? '4digit'} onChange={e => updateComponent(i, { year_format: e.target.value as '2digit' | '4digit' })}>
                      <option value="4digit">4 digits (2026)</option>
                      <option value="2digit">2 digits (26)</option>
                    </select>
                  )}
                  {c.type === 'sequence' && (
                    <select className="set-select set-select--sm" value={c.digits ?? 4} onChange={e => updateComponent(i, { digits: Number(e.target.value) })}>
                      {[3, 4, 5, 6].map(n => <option key={n} value={n}>{n} digits</option>)}
                    </select>
                  )}
                  <button className="set-delete-btn" onClick={() => removeComponent(i)} aria-label="Remove component">
                    <Icon name="x" size={16} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '12px 0' }}>
        {MATRIC_COMPONENT_TYPES.map(t => (
          <button key={t.type} className="set-add-btn" onClick={() => addComponent(t.type)}>+ {t.label}</button>
        ))}
      </div>

      {components.length > 0 && (
        <p className="set-list-row-meta">Preview: <strong>{previewFormat()}</strong></p>
      )}

      {err && <p className="set-form-error">{err}</p>}
      <div className="set-sheet-footer" style={{ padding: '12px 0', borderTop: 'none' }}>
        <button className="set-save-btn" onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save format'}</button>
      </div>
    </div>
  )
}

// ─── Admission: matric sequence scope (school-wide default) ────────────────
//
// Owner request, follow-up to SESSION 65's original per-programme-per-year-
// only counter design. This is the school-wide fallback; the actual
// per-programme override lives in the Programme form itself (InstitutionTab,
// "Matric numbering" field) since that's where an admin is already thinking
// about one specific programme — not duplicated here as a second place to
// set the same thing. What this section *does* show is a live read-only
// count of how many programmes currently override the default, computed
// from the programmes array AdmissionSettingsTab already loaded (no extra
// fetch) — enough for an admin auditing configuration to sanity-check
// themselves without hunting through every programme individually.

function AdmissionMatricScopeSection({
  schoolId, master, onChange, programmes,
}: {
  schoolId: string
  master: AdmissionMasterSettingsLocal | null
  onChange: (m: AdmissionMasterSettingsLocal) => void
  programmes: Programme[]
}) {
  const [scope, setScope] = useState<MatricSequenceScope>(master?.matric_sequence_scope_default ?? 'programme')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => { setScope(master?.matric_sequence_scope_default ?? 'programme') }, [master?.matric_sequence_scope_default])

  const overrideCount = programmes.filter(p => p.matric_sequence_scope != null).length

  async function handleSave() {
    if (scope === (master?.matric_sequence_scope_default ?? 'programme')) return
    setSaving(true)
    setErr(null)
    const res = await setMatricSequenceScopeDefault(schoolId, scope)
    if (res.error) { setErr(res.error); setSaving(false); return }
    if (master) onChange({ ...master, matric_sequence_scope_default: scope })
    setSaving(false)
  }

  return (
    <div className="set-tab-content" style={{ paddingTop: 24 }}>
      <div className="set-section-header">
        <SectionLabel>Matric sequence scope</SectionLabel>
      </div>
      <p className="set-empty-hint" style={{ margin: '0 0 8px' }}>
        Controls whether a programme's matric sequence resets on its own each admission year, or shares one running sequence with the rest of the school (still resetting yearly). Applies to any programme that hasn't set its own override — set per-programme overrides from that programme's own edit form under Institution.
      </p>
      <FieldRow label="School default">
        <select className="set-select" value={scope} onChange={e => setScope(e.target.value as MatricSequenceScope)}>
          <option value="programme">Sequence resets per programme</option>
          <option value="school">One shared sequence school-wide</option>
        </select>
      </FieldRow>
      {overrideCount > 0 && (
        <p className="set-list-row-meta">
          {overrideCount} programme{overrideCount === 1 ? '' : 's'} currently override this default.
        </p>
      )}
      {err && <p className="set-form-error">{err}</p>}
      <div className="set-sheet-footer" style={{ padding: '12px 0', borderTop: 'none' }}>
        <button className="set-save-btn" onClick={handleSave} disabled={saving || scope === (master?.matric_sequence_scope_default ?? 'programme')}>
          {saving ? 'Saving…' : 'Save default'}
        </button>
      </div>
    </div>
  )
}

// ─── Admission: manual matric number entry ──────────────────────────────────
//
// Owner request, 2026-07-2x. Two real needs: entering the real matric
// number of a student who existed before this system (legacy records), and
// correcting a mistake on an already-admitted student. Deliberately NOT the
// same form as a real admission — no pipeline, no application, just: pick a
// student who has no number yet, pick their programme (the format's other
// components — faculty/department/programme code — are derived from that,
// never typed by hand, per the owner's explicit description), type the
// sequence number, done. set_matric_number_manual() (migration_session_
// manual_matric_number.sql) fast-forwards matric_sequence_counters so real
// future admissions never collide with a manually-entered number — the
// engine "stays aware," per the owner's own framing.
//
// Placement (student -> programme level -> session) is a separate,
// composable step below this one, not folded in automatically: a student
// needing a manual number might already be placed (just missing a number —
// nothing to do here beyond the number itself) or might genuinely need both.
// Finishes searchStudents()/upsertPlacement() (settingsService.ts) — both
// were already fully implemented but had no working caller anywhere in this
// module; their only previous caller was InstitutionTab's dead "+ Admit
// student" button, which navigated away instead of using them.
//
// Bulk/CSV import is a deliberate non-goal here — flagged, not silently
// skipped: malformed rows silently corrupting the sequence counter is a
// materially higher-risk failure mode than a single bad manual entry, and
// shouldn't ship in the same pass as the core mechanism.

function AdmissionManualMatricSection({ schoolId }: { schoolId: string }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<StudentMissingMatric[]>([])
  const [searching, setSearching] = useState(false)
  const [selectedStudent, setSelectedStudent] = useState<StudentMissingMatric | null>(null)

  const [programmes, setProgrammes] = useState<Programme[]>([])
  const [programmeId, setProgrammeId] = useState<string | null>(null)
  const [admissionYear, setAdmissionYear] = useState(String(new Date().getFullYear()))
  const [sequenceNumber, setSequenceNumber] = useState('')

  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [result, setResult] = useState<ManualMatricResult | null>(null)

  // Placement (optional second step, only shown once a number has just been
  // assigned to a student who has no current placement — a legacy student
  // with real placement history already recorded elsewhere doesn't need
  // this, so it's offered, not forced).
  const [levels, setLevels] = useState<ProgrammeLevel[]>([])
  const [levelId, setLevelId] = useState<string | null>(null)
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)
  const [placing, setPlacing] = useState(false)
  const [placementDone, setPlacementDone] = useState(false)
  const [placementErr, setPlacementErr] = useState<string | null>(null)

  useEffect(() => {
    loadProgrammes(schoolId).then(res => { if (!res.error) setProgrammes(res.data) })
    loadCurrentSession(schoolId).then(res => { if (!res.error && res.data) setCurrentSessionId(res.data.id) })
  }, [schoolId])

  useEffect(() => {
    if (query.trim().length < 2) { setResults([]); return }
    setSearching(true)
    const handle = setTimeout(async () => {
      const res = await searchStudentsMissingMatric(schoolId, query.trim())
      if (!res.error) setResults(res.data)
      setSearching(false)
    }, 300)
    return () => clearTimeout(handle)
  }, [query, schoolId])

  useEffect(() => {
    if (!programmeId) { setLevels([]); setLevelId(null); return }
    loadProgrammeLevels(programmeId).then(res => { if (!res.error) setLevels(res.data) })
  }, [programmeId])

  function pickStudent(s: StudentMissingMatric) {
    setSelectedStudent(s)
    setQuery('')
    setResults([])
    setResult(null)
    setErr(null)
    setPlacementDone(false)
    setPlacementErr(null)
  }

  function reset() {
    setSelectedStudent(null)
    setProgrammeId(null)
    setSequenceNumber('')
    setResult(null)
    setErr(null)
    setLevelId(null)
    setPlacementDone(false)
    setPlacementErr(null)
  }

  async function handleAssign() {
    if (!selectedStudent) { setErr('Select a student first.'); return }
    if (!programmeId) { setErr('Choose the student\'s programme.'); return }
    const year = Number(admissionYear)
    if (!Number.isInteger(year) || year < 1900) { setErr('Enter a valid admission year.'); return }
    const seq = Number(sequenceNumber)
    if (!Number.isInteger(seq) || seq < 1) { setErr('Enter a whole number of 1 or more for the sequence.'); return }

    setSaving(true)
    setErr(null)
    const res = await setMatricNumberManual({
      schoolId,
      studentId: selectedStudent.id,
      programmeId,
      admissionYear: year,
      sequenceNumber: seq,
    })
    if (res.error) { setErr(res.error); setSaving(false); return }
    setResult(res.data)
    setSaving(false)
  }

  async function handlePlace() {
    if (!selectedStudent || !levelId || !currentSessionId) return
    setPlacing(true)
    setPlacementErr(null)
    const res = await upsertPlacement({
      school_id: schoolId,
      student_id: selectedStudent.id,
      programme_level_id: levelId,
      session_id: currentSessionId,
    })
    if (res.error) { setPlacementErr(res.error); setPlacing(false); return }
    setPlacementDone(true)
    setPlacing(false)
  }

  return (
    <div className="set-tab-content" style={{ paddingTop: 24 }}>
      <div className="set-section-header">
        <SectionLabel>Manual matric number entry</SectionLabel>
      </div>
      <p className="set-empty-hint" style={{ margin: '0 0 8px' }}>
        For students who already existed before this system, or to correct a mistake. Only students without a matric number are shown — add the student first from Students if they don't exist yet.
      </p>

      {!selectedStudent ? (
        <>
          <FieldRow label="Find student">
            <Input value={query} onChange={setQuery} placeholder="Search by name…" />
          </FieldRow>
          {searching && <p className="set-list-row-meta">Searching…</p>}
          {results.map(s => (
            <div key={s.id} className="set-list-row" style={{ cursor: 'pointer' }} onClick={() => pickStudent(s)}>
              <div className="set-list-row-info">
                <p className="set-list-row-name">{s.full_name}</p>
                {s.student_code && <p className="set-list-row-meta">{s.student_code}</p>}
              </div>
              <button className="set-edit-btn">Select</button>
            </div>
          ))}
          {query.trim().length >= 2 && !searching && results.length === 0 && (
            <p className="set-empty-hint">No matching students without a matric number found.</p>
          )}
        </>
      ) : (
        <>
          <div className="set-list-row" style={{ border: 'none', padding: '0 0 12px' }}>
            <div className="set-list-row-info">
              <p className="set-list-row-name">{selectedStudent.full_name}</p>
              <p className="set-list-row-meta">No matric number on record</p>
            </div>
            <button className="set-cancel-btn" onClick={reset}>Change student</button>
          </div>

          {!result ? (
            <>
              <FieldRow label="Programme">
                <select className="set-select" value={programmeId ?? ''} onChange={e => setProgrammeId(e.target.value || null)}>
                  <option value="">Choose a programme</option>
                  {programmes.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </FieldRow>
              <FieldRow label="Admission year">
                <Input value={admissionYear} onChange={setAdmissionYear} type="number" />
              </FieldRow>
              <FieldRow label="Sequence number">
                <Input value={sequenceNumber} onChange={v => setSequenceNumber(v.replace(/[^0-9]/g, ''))} placeholder="e.g. 1" />
              </FieldRow>
              <p className="set-list-row-meta">
                The rest of the number (programme/faculty/department code, session year, separators) is filled in automatically from the active matric number format above — only the sequence itself is entered here.
              </p>
              {err && <p className="set-form-error">{err}</p>}
              <div className="set-sheet-footer" style={{ padding: '12px 0', borderTop: 'none' }}>
                <button className="set-save-btn" onClick={handleAssign} disabled={saving}>
                  {saving ? 'Assigning…' : 'Assign matric number'}
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="set-list-row-meta">
                Assigned: <strong>{result.matric_number}</strong>
              </p>

              {!placementDone ? (
                <>
                  <p className="set-empty-hint" style={{ margin: '12px 0 8px' }}>
                    Optional — place this student into a programme level now. Skip this if they already have placement history recorded.
                  </p>
                  <FieldRow label="Level">
                    <select className="set-select" value={levelId ?? ''} onChange={e => setLevelId(e.target.value || null)} disabled={levels.length === 0}>
                      <option value="">{levels.length === 0 ? 'No levels for this programme' : 'Choose a level'}</option>
                      {levels.map(l => <option key={l.id} value={l.id}>{l.level_label}</option>)}
                    </select>
                  </FieldRow>
                  {placementErr && <p className="set-form-error">{placementErr}</p>}
                  <div className="set-sheet-footer" style={{ padding: '12px 0', borderTop: 'none' }}>
                    <button className="set-cancel-btn" onClick={reset}>Skip</button>
                    <button className="set-save-btn" onClick={handlePlace} disabled={placing || !levelId || !currentSessionId}>
                      {placing ? 'Placing…' : 'Place student'}
                    </button>
                  </div>
                  {!currentSessionId && (
                    <p className="set-form-error">No current session is set for this school — placement needs one. Set a current session under Calendar first.</p>
                  )}
                </>
              ) : (
                <p className="set-list-row-meta">Placed into {levels.find(l => l.id === levelId)?.level_label}.</p>
              )}

              <div className="set-sheet-footer" style={{ padding: '12px 0', borderTop: 'none' }}>
                <button className="set-cancel-btn" onClick={reset}>Done — enter another</button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}

// ─── Admission: rejection retention window ──────────────────────────────────
//
// §6 of the proposal — the NDPA-driven purge window feeding the pg_cron job
// (migration_session_65a.sql). A plain numeric setting, deliberately with no
// confirmation ceremony (see setRejectionRetentionDays()'s own comment on
// why it's split from the master switch's setter).

function AdmissionRetentionSection({
  schoolId, master, onChange,
}: {
  schoolId: string
  master: AdmissionMasterSettingsLocal | null
  onChange: (m: AdmissionMasterSettingsLocal) => void
}) {
  const [days, setDays] = useState(String(master?.rejection_retention_days ?? 90))
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => { setDays(String(master?.rejection_retention_days ?? 90)) }, [master?.rejection_retention_days])

  async function handleSave() {
    const n = Number(days)
    if (!Number.isFinite(n) || n <= 0) { setErr('Enter a whole number of days greater than zero.'); return }
    setSaving(true)
    setErr(null)
    const res = await setRejectionRetentionDays(schoolId, Math.round(n))
    if (res.error) { setErr(res.error); setSaving(false); return }
    if (master) onChange({ ...master, rejection_retention_days: Math.round(n) })
    setSaving(false)
  }

  return (
    <div className="set-tab-content" style={{ paddingTop: 24 }}>
      <div className="set-section-header">
        <SectionLabel>Rejected applicant retention</SectionLabel>
      </div>
      <p className="set-empty-hint" style={{ margin: '0 0 8px' }}>
        Rejected applications are permanently purged this many days after rejection.
      </p>
      <FieldRow label="Retention window (days)">
        <Input value={days} onChange={setDays} placeholder="e.g. 90" type="number" />
      </FieldRow>
      {err && <p className="set-form-error">{err}</p>}
      <div className="set-sheet-footer" style={{ padding: '12px 0', borderTop: 'none' }}>
        <button className="set-save-btn" onClick={handleSave} disabled={saving || days === String(master?.rejection_retention_days ?? 90)}>
          {saving ? 'Saving…' : 'Save retention window'}
        </button>
      </div>
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
