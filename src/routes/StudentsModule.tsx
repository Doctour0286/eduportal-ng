/**
 * StudentsModule.tsx
 * Student list, add/edit, guardian management, status management, and transfer initiation.
 *
 * Props (same pattern as all other modules):
 *   schoolId  — passed from App.tsx via TabContent
 *   isAdmin   — true for staff/platform_admin actor types. Kept in the props
 *               interface for parity with App.tsx's existing call site, but
 *               NOT consumed in this file — unlike AttendanceModule.tsx /
 *               TimetableModule.tsx, no cosmetic copy in this module branches
 *               on it. All real gating uses the can() selectors below, which
 *               already bypass to true for admin-role holders.
 *
 * Flow:
 *   1. Load all leaf class nodes (for filter + add/edit picker)
 *   2. Show student list — filterable by class, searchable by name
 *   3. Tap a student → slide-up detail panel (3 tabs: Info, Guardians, Status/Transfer)
 *   4. Info tab: edit form (pre-filled) — same form as Add student
 *   5. Guardians tab: linked guardians with access toggle; Add guardian
 *   6. Status tab: current status badge + change buttons with confirmation
 *   7. Transfer tab (active students only, admin only): initiate release with confirmation
 *   8. "Add student" button → slide-up add form, blank
 *
 * UX contract (§4):
 *   - List loads instantly; search filters client-side
 *   - Detail panel lazy-loads guardians and transfer on first open (not on list load)
 *   - Irreversible actions (alumni, transfer) require an explicit confirmation step
 *   - Errors show plain English + Retry
 *   - Status 'transferred_out' and 'transferred_in_pending' are read-only — can only
 *     be set by the transfer flow, not by the status buttons
 */

import { useState, useEffect, useCallback, useRef, type ChangeEvent } from 'react'
import { useAuthStore } from '../stores/authStore'
import { Icon } from '../components/icons'
import {
  loadLeafClasses,
  loadParentClassGroups,
  type ParentClassGroup,
  loadStudents,
  loadGuardiansForStudent,
  loadTransferRequest,
  loadAttendanceSummary,
  createStudent,
  updateStudent,
  updateStudentStatus,
  addGuardian,
  updateGuardianLink,
  unlinkGuardian,
  initiateTransfer,
  buildClassPathMap,
  todayDateString,
  statusLabel,
  type ClassNode,
  type Student,
  type GuardianLink,
  type TransferRequest,
  type AttendanceSummary,
  type GuardianIdentity,
  loadGuardianIdentity,
  provisionGuardianAccess,
  type StudentIdentity,
  loadStudentIdentity,
  provisionStudentAccess,
  loadStudentRoleTags,
  loadStudentRoleTagsBatch,
  loadAssignableStudentRoles,
  assignStudentRole,
  unassignStudentRole,
  type StudentRoleTag,
  type AssignableStudentRole,
  uploadStudentPhoto,
  getStudentPhotoSignedUrl,
  getStudentStatusCounts,
  getHigherEdStudentStatusCounts,
  type StudentStatusCounts,
  runAttendanceAutoDeactivationCheck,
  type AttendanceDeactivationCandidate,
  // Problem 9.8 (Tier 9)
  loadUnplacedHigherEdStudents,
} from '../services/studentsService'
import ObligationFields from '../components/ObligationFields'
import {
  loadPendingObligations,
  loadStudentObligations,
  createObligation,
  resolveObligation,
  obligationBadge,
  formatObligationAmount,
  validateObligationDraft,
  type Obligation,
  type ObligationDraft,
} from '../services/obligationsService'
import {
  searchGuardians,
  linkGuardianToStudent,
  loadGuardian,
  type GuardianSearchResult,
  type GuardianDetail,
} from '../services/guardianService'
// PRD Tier 6 / Problem 6.10 — student ID card print feature. Same Blob-URL
// pattern as printTimetable.ts (see that file's own header comment for why
// document.write() on a blank window.open('') is unsafe on Android Chrome).
import { printStudentIdCards, type IdCardStudent } from '../services/printStudentIdCards'
// SESSION 60e — admin transcript view (owner request, closing the gap
// GuardianPortal.tsx's own TranscriptTab left: admin had no equivalent).
// Reuses SESSION 60b/60d's already-built read/PDF services as-is — no new
// service code, this file only adds a rendering layer around them.
import { loadStudentTranscript, type StudentTranscript } from '../services/courseResultsService'
import { downloadTranscriptPdf } from '../services/transcriptPdf'
import { loadStudentCurrentPlacement, loadProgrammes, loadProgrammeLevels, upsertPlacement, type StudentCurrentPlacement, type Programme, type ProgrammeLevel, loadAttendanceDeactivationSettings, type AttendanceDeactivationSettings } from '../services/settingsService'
import { loadCurrentSession } from '../services/attendanceService'
import { loadStudentOverallAttendance, type StudentOverallAttendance } from '../services/courseAttendanceService'

// ─── Props ────────────────────────────────────────────────────────────────────

interface StudentsModuleProps {
  schoolId: string
  isAdmin: boolean
  /** SESSION 60e — needed to gate the Transcript tab to higher-ed schools
   *  only, same isHigherEd check App.tsx's other higher-ed-aware call
   *  sites (GuardianPortal.tsx, CourseResultsModule.tsx's own dispatcher)
   *  already duplicate locally rather than share a hook. App.tsx passes
   *  schoolType={schoolType} into this module's call site, mirroring the
   *  four GuardianPortal call sites from SESSION 60b exactly. */
  schoolType?: string | null
  /** PRD Tier 6 / Problem 6.10 — needed for the ID card print header, same
   *  reasoning and same threading pattern as TimetableModule.tsx's own
   *  schoolName prop (added there for its print page header). App.tsx
   *  passes schoolName={school.name} into this module's call site, same
   *  as it already does for TimetableModule. */
  schoolName: string
  /** PRD Tier 6 / Problem 6.10 follow-up (owner-supplied reference design,
   *  2026-07-10) — "space for school logo" on the printed ID card.
   *  schools.logo_url per §7.1; public bucket (unlike student photos,
   *  which are private and need a signed URL), so this is passed straight
   *  through with no resolution step. Optional/nullable — a school that
   *  hasn't set a logo yet still gets a working card, just without the
   *  logo mark, same graceful-fallback convention as everywhere else in
   *  this file. App.tsx must pass schoolLogoUrl={school.logo_url} — see
   *  that file's existing school.logo_url reads (header <img>,
   *  GuardianPortal's logoUrl prop) for the pattern to copy. */
  schoolLogoUrl?: string | null
  /** Optional intent from a dashboard quick action — 'add_student' opens the
   *  add-student form immediately on mount, same as tapping the in-module
   *  "Add student" button. Per PRD Problem 2.2c — no new form is built here,
   *  this just triggers the form that already exists. */
  intent?: 'add_student' | 'record_payment' | 'mark_attendance'
  /** Passed from App.tsx's TabContent — used to jump from a student's
   *  Guardians tab into that guardian's own detail view in the Guardians
   *  module (tab === 'guardians', carrying { guardianId }). Optional so
   *  StudentsModule still works standalone if a future caller omits it —
   *  the guardian name simply won't be tappable in that case. */
  onNavigate?: (tab: 'guardians', intent?: { guardianId?: string }) => void
}

// ─── Load states ──────────────────────────────────────────────────────────────

type LoadState = 'booting' | 'loading' | 'ready' | 'empty' | 'error'

// ─── Form state (add / edit) ──────────────────────────────────────────────────

interface FormState {
  full_name: string
  class_node_id: string
  gender: string
  date_of_birth: string
  admission_date: string
  student_code: string
  // Session 14 (owner request — "more detail space" in the Edit subtab).
  // blood_group/address/medical_notes/emergency_contact_* map to columns
  // that already existed live but were never surfaced in this form; hobbies/
  // email/phone are new columns (migration_session_14, §7.8).
  blood_group: string
  address: string
  medical_notes: string
  emergency_contact_name: string
  emergency_contact_phone: string
  hobbies: string
  email: string
  phone: string
  // Problem 9.8 (Tier 9) — higher-ed only, optional. Replaces class_node_id
  // for that school type in the Add form (a higher-ed school has no class
  // nodes at all — class_node_id was rendering a meaningless "Class"
  // picker for higher-ed before this fix, a separate latent bug fixed in
  // the same pass). Left blank = student created unplaced, same as today's
  // behavior, fixable later via the Status tab or the Unplaced list.
  programme_id: string
  programme_level_id: string
}

const EMPTY_FORM: FormState = {
  full_name: '',
  class_node_id: '',
  gender: '',
  date_of_birth: '',
  admission_date: todayDateString(),
  student_code: '',
  blood_group: '',
  address: '',
  medical_notes: '',
  emergency_contact_name: '',
  emergency_contact_phone: '',
  hobbies: '',
  email: '',
  phone: '',
  programme_id: '',
  programme_level_id: '',
}

// ─── Guardian form state ──────────────────────────────────────────────────────

interface GuardianFormState {
  full_name: string
  phone: string
  email: string
  relationship: string
}

const EMPTY_GUARDIAN_FORM: GuardianFormState = {
  full_name: '',
  phone: '',
  email: '',
  relationship: '',
}

// ─── Detail panel tab ─────────────────────────────────────────────────────────

// SESSION 12 (step 3): 'info' removed as a standalone tab destination — the
// same renderInfoTab() content now surfaces as an "Edit" action reached from
// Brief, gated on students.records.edit (not a separate tab a non-editor
// would see and tap into for no reason). editSheetOpen (below) controls its
// visibility instead of DetailTab; the type keeps 'info' only as an internal
// label for which body renderDetailBody() should show, not a tab-bar entry.
type DetailTab = 'brief' | 'info' | 'guardians' | 'status' | 'transcript'

// ─── Component ────────────────────────────────────────────────────────────────

export default function StudentsModule({ schoolId, schoolName, schoolLogoUrl, schoolType, intent, onNavigate }: StudentsModuleProps) {
  // SESSION 60e — same check App.tsx's TabContent already duplicates
  // locally for its four higher-ed-aware call sites; copied verbatim
  // rather than imported, matching that existing (if imperfect) local-
  // duplication convention instead of introducing a shared hook this
  // session.
  const isHigherEd = !!schoolType && ['university', 'polytechnic', 'college_of_education', 'other'].includes(schoolType)

  // ── Auth: permission gates (PRD Tier 3 / Session 10, 2026-07-01) ────────────
  // Read directly via useAuthStore, same pattern as AttendanceModule.tsx's
  // canMark and TimetableModule.tsx's canEditTimetable — not threaded in as
  // props. can() already bypasses to true for admin-role holders. isAdmin
  // itself is not used anywhere in this file's body (see props note above).
  //   students.records.edit          — edit existing student record fields,
  //                                     including guardian info/links
  //   students.records.manage        — add / deactivate / transfer students
  //   students.portal.manage_access  — provision, regenerate, revoke
  //                                     student/guardian portal login access
  // Verified against the live `permissions` catalog descriptions, not
  // inferred from memory or prose, per §0.2.
  const canEditStudentRecords = useAuthStore(s => s.can('students.records.edit'))
  const canManageStudents     = useAuthStore(s => s.can('students.records.manage'))
  const canManagePortalAccess = useAuthStore(s => s.can('students.portal.manage_access'))

  // ── Class nodes ───────────────────────────────────────────────────────────
  const [classes,      setClasses]      = useState<ClassNode[]>([])
  const [classPathMap, setClassPathMap] = useState<Map<string, string>>(new Map())
  const [bootState,    setBootState]    = useState<LoadState>('booting')
  const [bootError,    setBootError]    = useState('')

  // ── Student list ──────────────────────────────────────────────────────────
  const [students,     setStudents]     = useState<Student[]>([])
  const [listState,    setListState]    = useState<LoadState>('booting')
  const [listError,    setListError]    = useState('')
  // Session 14 — role tags for the list row display, keyed by student id.
  // Separate from `students` itself since it's a supplementary batch fetch,
  // not part of the Student record proper — same reasoning as detail-header
  // roleTags being its own state rather than folded into `detailStudent`.
  // Failure here degrades silently (empty tags, no error banner) since a
  // missing tag row is not worth blocking or cluttering the whole list over.
  const [listRoleTags, setListRoleTags] = useState<Map<string, StudentRoleTag[]>>(new Map())
  // Session 21 — resolved signed URLs for student photos, keyed by the
  // storage *path* stored in student.photo_url (not by student id — two
  // students could theoretically share no path, but keying on the path
  // itself means a re-upload that keeps the same path, i.e. the fixed
  // photo.jpg filename studentsService.ts always uses, naturally
  // invalidates by just overwriting the map entry after upload, rather
  // than needing a separate cache-bust mechanism). Same non-blocking
  // batch-resolve shape as listRoleTags above: fired after the list
  // itself renders, never blocks it.
  const [photoUrls, setPhotoUrls] = useState<Map<string, string>>(new Map())

  // ── Filters ───────────────────────────────────────────────────────────────
  // Session 32 (owner request: "same kind of intelligent navigation" as
  // AttendanceModule's whole-parent view) — filterClass stays the
  // single-leaf-class case exactly as before (untouched contract, every
  // existing read of filterClass below keeps working); selectedGroup is new
  // and mutually exclusive with it, set when "All of {parent}" is picked.
  // parentGroups/selectedParentId are the picker's own tier-1 state (which
  // grade is currently narrowing tier 2's pill row) — selectedParentId is
  // NOT the same thing as selectedGroup: picking a parent pill narrows the
  // class row, it does not by itself select "the whole parent" as the
  // active filter (that's a separate, explicit "All of X" pill beside it).
  const [filterClass,     setFilterClass]     = useState<string>('')
  const [selectedGroup,   setSelectedGroup]   = useState<ParentClassGroup | null>(null)
  const [parentGroups,    setParentGroups]    = useState<ParentClassGroup[]>([])
  const [selectedParentId, setSelectedParentId] = useState<string | null>(null)
  const [searchQuery,  setSearchQuery]  = useState('')
  // SESSION 64 (owner-reported gap) — higher-ed equivalent of the
  // class-picker state above. filterProgrammeId narrows tier 1 (which
  // programme), filterLevelId narrows tier 2 (which level within it) —
  // same two-tier shape as parentGroups/filterClass, but a higher-ed
  // student has no class_node_id at all, so this is a genuinely separate
  // filter axis, not a re-use of the class-picker's own state.
  const [programmes,        setProgrammes]        = useState<Programme[]>([])
  const [filterProgrammeId, setFilterProgrammeId] = useState<string>('')
  const [programmeLevels,   setProgrammeLevels]   = useState<ProgrammeLevel[]>([])
  const [filterLevelId,     setFilterLevelId]     = useState<string>('')
  const [levelsLoading,     setLevelsLoading]     = useState(false)
  // Collapse-on-select (matches AttendanceModule's own follow-up) — once a
  // class or group is picked, fold the picker down to one compact summary
  // row instead of showing both pill tiers permanently. Defaults to
  // expanded so a first-time/no-selection state still shows the full
  // picker, same as before this feature existed.
  const [pickerExpanded, setPickerExpanded] = useState(true)
  // Session 32 follow-up (owner: "collapsible on the option of 'All
  // Classes' [too]") — filterClass === '' is structurally ambiguous on its
  // own: it means both "nothing picked yet" (initial boot state) AND
  // "All classes" explicitly chosen (selectAllClasses' own reset target),
  // and those two need to behave differently for collapse purposes — the
  // former should stay expanded (there's nothing yet to summarize), the
  // latter should collapse just like any other real selection. This flag
  // is the one place that distinction lives; every pill's onClick sets it
  // true, including selectAllClasses, so "All classes" is a genuine tapped
  // choice, not just a default.
  const [hasChosen, setHasChosen] = useState(false)

  // Session 22 follow-up (stat-strip drill-down). Which single status the
  // visible list is currently showing — defaults to 'active' so the list's
  // default behavior is unchanged from before this feature. Set by clicking
  // a non-active stat chip; cleared back to 'active' via the "Showing: X ×"
  // indicator or by clicking the same chip again.
  const [statusFilter, setStatusFilter] = useState<Student['status']>('active')

  // Problem 9.8 (Tier 9) — higher-ed only. Mutually exclusive with
  // statusFilter's usual drill-down (see loadList() below): "unplaced" is
  // not a students.status value, so it can't reuse statusFilter's own
  // state the way the active/inactive/alumni/transferred chips already do
  // — it's a separate, derived condition (no current placement row) that
  // only ever applies on top of status='active'.
  const [showUnplacedOnly, setShowUnplacedOnly] = useState(false)

  // Counts across ALL statuses, scoped to filterClass — independent of
  // statusFilter above, so the stat strip's numbers stay stable while the
  // list underneath switches which single status it displays.
  const [statusCounts, setStatusCounts] = useState<StudentStatusCounts | null>(null)

  // ── Add / edit form ───────────────────────────────────────────────────────
  const [formOpen,     setFormOpen]     = useState(false)
  const [editingId,    setEditingId]    = useState<string | null>(null)
  const [form,         setForm]         = useState<FormState>(EMPTY_FORM)
  const [formSaving,   setFormSaving]   = useState(false)
  const [formError,    setFormError]    = useState('')
  const nameInputRef = useRef<HTMLInputElement>(null)
  // Editing an existing student had no success feedback at all — saving
  // silently returned nothing, so the only sign anything happened was
  // whatever the person could visually confirm themselves. Shown briefly on
  // Brief (which the save now returns to) and auto-clears; not a toast
  // component, since this file has no existing toast pattern to reuse and
  // the whole flow is a single-panel round trip anyway.
  const [briefSuccessMsg, setBriefSuccessMsg] = useState('')
  // Same gap as briefSuccessMsg, for the create path — after adding a new
  // student, the form just closed and the list refreshed with nothing
  // indicating the new record actually saved. Shown above the list itself
  // since there's no detailStudent/Brief tab to show it on right after
  // create (the person lands back on the plain list, not inside the new
  // student's own panel).
  const [listSuccessMsg,  setListSuccessMsg]  = useState('')

  // Problem 9.8 (Tier 9) — Add form's own programme→level dependent
  // dropdown, higher-ed only. Deliberately separate from
  // programmeLevels/filterLevelId above (that pair belongs to the list's
  // filter picker, a different UI concern with its own independent
  // lifecycle — reusing it here would mean opening the Add form
  // could stomp on whatever filter the admin currently has applied to the
  // list behind it, or vice versa). `programmes` itself (the school's full
  // programme list) IS shared — it's the same static list either way, no
  // reason to fetch it twice.
  const [formLevels,        setFormLevels]        = useState<ProgrammeLevel[]>([])
  const [formLevelsLoading, setFormLevelsLoading]  = useState(false)
  // Problem 9.8 (Tier 9) — the current session id, needed alongside
  // programme_level_id to call upsertPlacement() from the Add form (and
  // from the Status tab's Assign-to-level action below). Fetched once on
  // mount for higher-ed schools only, same "load once, reuse everywhere in
  // this component" shape AdmissionManualMatricSection uses in
  // SettingsModule.tsx for the identical value — not re-fetched per submit.
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)

  // ── Detail panel ──────────────────────────────────────────────────────────
  const [detailStudent,  setDetailStudent]  = useState<Student | null>(null)
  const [detailTab,      setDetailTab]      = useState<DetailTab>('brief')

  // ── Photo upload (Info subtab only, Session 21, PRD Problem 5.3) ──────────
  // Deliberately not folded into formSaving/formError — a photo upload is
  // independent of the rest of the edit form's own save flow (same reasoning
  // as roleTogglingId being separate from handleSubmit above), and tapping
  // the avatar shouldn't be blocked by, or block, the surrounding form.
  const [photoUploading, setPhotoUploading] = useState(false)
  const [photoError,     setPhotoError]     = useState('')
  const photoInputRef = useRef<HTMLInputElement>(null)

  // Full-size photo preview lightbox, opened by tapping the header avatar
  // when a photo exists. Reset on every open/closeDetail so it never
  // carries over between students.
  const [photoPreviewOpen, setPhotoPreviewOpen] = useState(false)

  // ── Role tags (Session 13, PRD Problem 5.5) ───────────────────────────────
  // Header-level, not tab-scoped — fetched once per openDetail() alongside
  // Brief/identity, since the header persists across all four subtabs (the
  // owner's "visible from anywhere" decision means the tag row belongs in
  // the one place every subtab shares, not duplicated per-tab).
  const [roleTags,      setRoleTags]      = useState<StudentRoleTag[]>([])
  const [roleTagsState, setRoleTagsState] = useState<LoadState>('booting')

  // ── Role picker (Edit subtab only, Session 13) ────────────────────────────
  const [assignableRoles,      setAssignableRoles]      = useState<AssignableStudentRole[]>([])
  const [assignableRolesState, setAssignableRolesState] = useState<LoadState>('booting')
  const [roleTogglingId,       setRoleTogglingId]       = useState<string | null>(null)

  // ── Brief (detail panel) ──────────────────────────────────────────────────
  const [attendanceSummary, setAttendanceSummary] = useState<AttendanceSummary | null | undefined>(undefined) // undefined = not loaded
  const [briefState,        setBriefState]        = useState<LoadState>('booting')
  const [_briefError,        setBriefError]        = useState('')
  const [moreDetailsOpen,   setMoreDetailsOpen]   = useState(false)
  // SESSION 64 (PRD Problem 8.7a) — a higher-ed student's current
  // programme/level, sourced from settingsService.ts's loadStudentCurrentPlacement().
  // undefined = not yet loaded, null = loaded but no current placement (not
  // yet admitted, or between placements) — same three-state convention as
  // attendanceSummary above. Only ever populated when isHigherEd; left
  // permanently undefined for secondary schools, matching this file's
  // existing isHigherEd-gated-fetch pattern (fetchAssignableRoles, etc).
  const [currentPlacement, setCurrentPlacement] = useState<StudentCurrentPlacement | null | undefined>(undefined)
  const [placementState,   setPlacementState]   = useState<LoadState>('booting')

  // Problem 9.8 (Tier 9) — Status tab's "Assign to level" action. Its own
  // small, self-contained picker state, shown only when currentPlacement
  // is null (nothing to assign once a placement already exists — use
  // upsertPlacement() again some other way if a correction is ever
  // needed, not this one-time "first placement" control). Same
  // programme→level dependent-dropdown shape as the Add form's own
  // formLevels above and as AdmissionManualMatricSection's precedent in
  // SettingsModule.tsx — deliberately a third, independent copy of this
  // small piece of local UI state (not shared with the other two) since
  // each lives in a different part of the tree with its own open/close
  // lifecycle; only the underlying upsertPlacement() write itself is
  // shared, never the state around it.
  const [assignPanelOpen,      setAssignPanelOpen]      = useState(false)
  const [assignProgrammeId,    setAssignProgrammeId]    = useState('')
  const [assignLevelId,        setAssignLevelId]        = useState('')
  const [assignLevels,         setAssignLevels]         = useState<ProgrammeLevel[]>([])
  const [assignLevelsLoading,  setAssignLevelsLoading]  = useState(false)
  const [assigning,            setAssigning]            = useState(false)
  const [assignError,          setAssignError]          = useState('')

  // SESSION 64 (owner-reported gap, researched) — the Brief tab's
  // "Performance" stat was a hardcoded "Not yet available" stub for every
  // student. For a higher-ed student, real CGPA already exists and is
  // already computed live elsewhere in this exact file (see
  // StudentTranscriptTab below, built SESSION 60b) via
  // loadStudentTranscript(studentId, true) — reusing that proven call here
  // rather than inventing a new read. Only ever populated when isHigherEd,
  // same convention as currentPlacement above.
  const [cgpaValue, setCgpaValue] = useState<number | null | undefined>(undefined)
  const [cgpaState, setCgpaState] = useState<LoadState>('booting')

  // SESSION 64 follow-up — real cross-course attendance rollup, now that
  // courseAttendanceService.ts is available. Only ever populated when
  // isHigherEd, same convention as currentPlacement/cgpaValue above.
  const [overallAttendance, setOverallAttendance] = useState<StudentOverallAttendance | null | undefined>(undefined)
  const [overallAttendanceState, setOverallAttendanceState] = useState<LoadState>('booting')

  // ── Guardians (detail panel) ──────────────────────────────────────────────
  const [guardians,        setGuardians]        = useState<GuardianLink[]>([])
  const [guardiansState,   setGuardiansState]   = useState<LoadState>('booting')
  const [guardiansError,   setGuardiansError]   = useState('')
  const [guardianFormOpen, setGuardianFormOpen] = useState(false)
  const [guardianForm,     setGuardianForm]     = useState<GuardianFormState>(EMPTY_GUARDIAN_FORM)
  const [guardianSaving,   setGuardianSaving]   = useState(false)
  const [guardianError,    setGuardianError]    = useState('')
  const [unlinkTarget,     setUnlinkTarget]     = useState<GuardianLink | null>(null)
  const [unlinkSaving,     setUnlinkSaving]     = useState(false)
  const guardianNameRef = useRef<HTMLInputElement>(null)

  // ── Guardian search-first linking ─────────────────────────────────────────
  const [guardianSearchMode,  setGuardianSearchMode]  = useState(false)
  const [guardianSearchQ,     setGuardianSearchQ]     = useState('')
  const [guardianSearchRes,   setGuardianSearchRes]   = useState<GuardianSearchResult[]>([])
  const [guardianSearching,   setGuardianSearching]   = useState(false)
  const [guardianLinkSaving,  setGuardianLinkSaving]  = useState(false)
  const guardianSearchTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  // ── Guardian access provisioning ──────────────────────────────────────────
  // keyed by guardian_id so each row has independent state
  const [identities,       setIdentities]       = useState<Record<string, GuardianIdentity | null>>({})
  const [provisionTarget,  setProvisionTarget]  = useState<string | null>(null)  // guardian_id being provisioned
  const [provisionSaving,  setProvisionSaving]  = useState(false)
  const [provisionError,   setProvisionError]   = useState('')
  // SESSION 11 item 2: "Change / regenerate" previously jumped straight into
  // the provision form with no separate "are you sure" step — a single tap on
  // "Regenerate code" fired the real API call and invalidated the guardian's
  // current code immediately. This mirrors unlinkTarget's own confirm-banner
  // pattern above rather than inventing a new one: holds the GuardianLink
  // being confirmed, null when no confirmation is pending. Only gates the
  // regenerate path (identity already exists) — first-time "Set up login" is
  // not destructive (nothing existing is invalidated), so it still opens the
  // provision form directly, unchanged.
  const [regenerateConfirmTarget, setRegenerateConfirmTarget] = useState<GuardianLink | null>(null)

  // ── Guardian brief popup ───────────────────────────────────────────────────
  // Tapping a guardian's name in the Guardians tab previously jumped straight
  // into the standalone Guardians module via onNavigate — a full module
  // switch with no way back to this exact subtab (owner-reported bug; there
  // is no navigation-history mechanism anywhere in this app to build a real
  // "back" on top of). Replaced with an in-place brief: a small popup, layered
  // over this same detail sheet, showing the guardian's own info plus every
  // other student they're linked to — reusing guardianService's existing
  // loadGuardian(), which already returns exactly this shape in one query, so
  // no new service function or query was needed. Closing the brief returns to
  // this same Guardians subtab with nothing having navigated away at all.
  // "Edit in Guardians module" remains available from inside the brief via
  // the existing onNavigate mechanism, for the cases that genuinely need it.
  const [briefGuardianId,      setBriefGuardianId]      = useState<string | null>(null)
  const [briefGuardianData,    setBriefGuardianData]    = useState<GuardianDetail | null>(null)
  const [briefGuardianState,   setBriefGuardianState]   = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [briefGuardianError,   setBriefGuardianError]   = useState('')

  // ── Student access provisioning (Brief tab) ───────────────────────────────
  const [studentIdentity,        setStudentIdentity]        = useState<StudentIdentity | null | undefined>(undefined) // undefined = not loaded
  const [studentProvisioning,    setStudentProvisioning]    = useState(false)  // provision form open
  const [studentProvisionSaving, setStudentProvisionSaving] = useState(false)
  const [studentProvisionError,  setStudentProvisionError]  = useState('')

  async function fetchStudentIdentity(studentId: string) {
    const res = await loadStudentIdentity(schoolId, studentId)
    if (res.ok) {
      setStudentIdentity(res.data)
    }
  }

  // ── Role tags (Session 13) ────────────────────────────────────────────────
  async function fetchRoleTags(studentId: string) {
    setRoleTagsState('loading')
    const res = await loadStudentRoleTags(studentId)
    if (!res.ok) { setRoleTagsState('error'); return }
    setRoleTags(res.data)
    setRoleTagsState(res.data.length === 0 ? 'empty' : 'ready')
  }

  async function fetchAssignableRoles(student: Student) {
    setAssignableRolesState('loading')
    const res = await loadAssignableStudentRoles(schoolId, student.id, student.class_node_id)
    if (!res.ok) { setAssignableRolesState('error'); return }
    setAssignableRoles(res.data)
    setAssignableRolesState(res.data.length === 0 ? 'empty' : 'ready')
  }

  async function handleToggleRole(role: AssignableStudentRole) {
    if (!detailStudent) return
    setRoleTogglingId(role.id)
    const res = role.assigned
      ? await unassignStudentRole(detailStudent.id, role.id)
      : await assignStudentRole(schoolId, detailStudent.id, role.id)
    setRoleTogglingId(null)
    if (!res.ok) return
    // Refresh both the picker (assigned state) and the header tag row —
    // cheap enough (small role counts, per PRD's own "tens not thousands"
    // assumption already made in the service layer) to just re-fetch both
    // rather than hand-patch two separate pieces of local state in sync.
    fetchAssignableRoles(detailStudent)
    fetchRoleTags(detailStudent.id)
    // Session 14 — keep the list row's tag display in sync too, without a
    // full loadStudentRoleTagsBatch() re-fetch for every student in the
    // list over one student's change.
    const tagsRes = await loadStudentRoleTags(detailStudent.id)
    if (tagsRes.ok) {
      setListRoleTags(prev => {
        const next = new Map(prev)
        next.set(detailStudent.id, tagsRes.data)
        return next
      })
    }
  }

  function openStudentProvision() {
    setStudentProvisioning(true)
    setStudentProvisionError('')
  }

  function closeStudentProvision() {
    setStudentProvisioning(false)
    setStudentProvisionError('')
  }

  async function handleProvisionStudent(studentId: string, regenerate = false) {
    setStudentProvisionSaving(true)
    setStudentProvisionError('')
    const res = await provisionStudentAccess({
      schoolId,
      studentId,
      regenerate,
    })
    setStudentProvisionSaving(false)
    if (!res.ok) {
      setStudentProvisionError(res.error)
      return
    }
    await fetchStudentIdentity(studentId)
    closeStudentProvision()
  }
  
  // ─── Guardian access provisioning ────────────────────────────────────────

  async function fetchGuardianIdentity(guardianId: string) {
    if (!detailStudent) return
    const res = await loadGuardianIdentity(schoolId, guardianId)
    if (res.ok) {
      setIdentities(prev => ({ ...prev, [guardianId]: res.data }))
    }
  }

  function openProvision(guardianId: string) {
    setProvisionTarget(guardianId)
    setProvisionError('')
  }

  function closeProvision() {
    setProvisionTarget(null)
    setProvisionError('')
  }

  async function handleProvision(guardianId: string, regenerate = false) {
    if (!detailStudent) return
    setProvisionSaving(true)
    setProvisionError('')
    const res = await provisionGuardianAccess({
      schoolId,
      guardianId,
      loginMethod: 'login_code',
      regenerate,
    })
    setProvisionSaving(false)
    if (!res.ok) {
      setProvisionError(res.error)
      return
    }
    // Refresh identity row so identity.login_code is populated for direct display
    await fetchGuardianIdentity(guardianId)
    closeProvision()
  }

  // ─── Guardian brief popup ───────────────────────────────────────────────────

  async function openGuardianBrief(guardianId: string) {
    setBriefGuardianId(guardianId)
    setBriefGuardianState('loading')
    setBriefGuardianError('')
    setBriefGuardianData(null)
    const res = await loadGuardian(guardianId)
    if (!res.ok) {
      setBriefGuardianError(res.error)
      setBriefGuardianState('error')
      return
    }
    setBriefGuardianData(res.data)
    setBriefGuardianState('ready')
  }

  function closeGuardianBrief() {
    setBriefGuardianId(null)
    setBriefGuardianData(null)
    setBriefGuardianState('idle')
    setBriefGuardianError('')
  }

  // ── Status management (detail panel) ─────────────────────────────────────
  const [statusSaving,   setStatusSaving]   = useState(false)
  const [statusError,    setStatusError]    = useState('')

  // Fines / tasks (migration_attendance_class_rules_and_obligations.sql).
  // pendingObl feeds the list/detail badges school-wide; stuObligations is
  // the selected student's full history for the Status tab.
  const actorRecordId = useAuthStore(s => s.actorRecordId)
  const [reactivateDraft, setReactivateDraft] = useState<ObligationDraft | null>(null)
  const [pendingObl,      setPendingObl]      = useState<Map<string, Obligation[]>>(new Map())
  const [stuObligations,  setStuObligations]  = useState<Obligation[]>([])
  const [stuOblLoading,   setStuOblLoading]   = useState(false)
  const [resolvingId,     setResolvingId]     = useState<string | null>(null)
  const [resolveNote,     setResolveNote]     = useState('')
  const [resolveSaving,   setResolveSaving]   = useState(false)
  const [oblError,        setOblError]        = useState('')
  const [statusConfirm,  setStatusConfirm]  = useState<'active' | 'inactive' | 'alumni' | null>(null)
  // migration_attendance_auto_deactivation.sql — required specifically for
  // the 'active' (reactivation) case, enforced both here (button stays
  // disabled) and again in updateStudentStatus() itself, since that
  // function is the one place every reactivation path goes through.
  const [reactivateNote, setReactivateNote] = useState('')

  // ── Transfer (detail panel) ───────────────────────────────────────────────
  const [transferRequest,  setTransferRequest]  = useState<TransferRequest | null | undefined>(undefined) // undefined = not loaded
  const [transferState,    setTransferState]    = useState<LoadState>('booting')
  const [transferConfirm,  setTransferConfirm]  = useState(false)
  const [transferSaving,   setTransferSaving]   = useState(false)
  const [transferError,    setTransferError]    = useState('')

  // ─── Boot: load classes (secondary) or programmes (higher-ed) ─────────────

  useEffect(() => {
    let cancelled = false
    async function boot() {
      setBootState('loading')

      // SESSION 64 (owner-reported gap) — a higher-ed school has no
      // class_nodes at all; loadLeafClasses()/loadParentClassGroups()
      // were previously called unconditionally here regardless of school
      // type, which is exactly why "All classes"/"No class assigned"/
      // "Search in All classes" kept showing for a higher-ed school (an
      // empty class list still renders that UI shell, it just happens to
      // have zero pills under it). Branch at the root instead of patching
      // each downstream string.
      if (isHigherEd) {
        const res = await loadProgrammes(schoolId)
        if (cancelled) return
        if (res.error) {
          setBootError(res.error)
          setBootState('error')
          return
        }
        setProgrammes(res.data)
        setBootState('ready')
        // Problem 9.8 (Tier 9) — fired alongside, not blocking bootState,
        // same "a failure here degrades gracefully" treatment as
        // loadParentClassGroups() below for the secondary-school branch. A
        // failure (or no current session set) just means the Add form's
        // Level picker stays disabled with an explanatory hint — see
        // renderAddForm() — never a hard error blocking the whole module.
        loadCurrentSession().then(sessionRes => {
          if (!cancelled && sessionRes.ok && sessionRes.sessionId) {
            setCurrentSessionId(sessionRes.sessionId)
          }
        })
        return
      }

      const res = await loadLeafClasses(schoolId)
      if (cancelled) return
      if (!res.ok) {
        setBootError(res.error)
        setBootState('error')
        return
      }
      setClasses(res.data)
      setClassPathMap(buildClassPathMap(res.data))
      setBootState('ready')

      // Session 32 — fired alongside, not blocking bootState. A failure
      // here just means the parent-pill tier doesn't appear (flat class
      // picker, identical to pre-Session-32 behavior) rather than blocking
      // the whole list from loading over a purely additive filter feature.
      const groupsRes = await loadParentClassGroups(schoolId)
      if (!cancelled && groupsRes.ok) setParentGroups(groupsRes.data)
    }
    boot()
    return () => { cancelled = true }
  }, [isHigherEd, schoolId])

  // ─── Derived effective selection ────────────────────────────────────────
  // Session 32 — single place that resolves filterClass vs selectedGroup
  // into one shape every downstream loader/handler reads, exactly the same
  // reasoning as AttendanceModule.tsx's own effectiveClassIds/
  // effectiveSelectionKey/effectiveLabel block. Declared here, BEFORE
  // loadList/loadStatusCounts below reference it — AttendanceModule's own
  // Session 31 caught a genuine "used before declaration" TS error from
  // placing this kind of block too late; placed early here from the start
  // rather than repeating that mistake.
  //
  // '' (empty string) continues to mean "All classes, no filter" for
  // filterClass, unchanged from before this feature — effectiveClassIds is
  // `[]` in that case, and every query below already treats an empty/absent
  // classNodeId as "no class filter" (see loadStudents'/getStudentStatusCounts'
  // own `if (params.classNodeId)` checks), so this is not a new special case.
  const effectiveClassIds: string[] = selectedGroup
    ? selectedGroup.leafIds
    : filterClass
      ? [filterClass]
      : []
  const effectiveSelectionKey: string = selectedGroup
    ? `group:${selectedGroup.id}`
    : `class:${filterClass}`
  const effectiveLabel: string = selectedGroup
    ? `${selectedGroup.name} (all classes)`
    : filterClass
      ? (classPathMap.get(filterClass) ?? 'this class')
      : 'All classes'

  // SESSION 64 (owner-reported gap) — higher-ed equivalent of the block
  // above. filterLevelId set = one specific level; filterProgrammeId set
  // but no level yet = every level under that programme; neither set =
  // every currently-admitted student, school-wide.
  const effectiveProgrammeLevelIds: string[] = filterLevelId
    ? [filterLevelId]
    : filterProgrammeId
      ? programmeLevels.map(l => l.id)
      : []
  const effectiveHigherEdSelectionKey: string = filterLevelId
    ? `level:${filterLevelId}`
    : filterProgrammeId
      ? `programme:${filterProgrammeId}`
      : 'all-programmes'
  const selectedProgramme = programmes.find(p => p.id === filterProgrammeId) ?? null
  const selectedLevel = programmeLevels.find(l => l.id === filterLevelId) ?? null
  const effectiveHigherEdLabel: string = selectedLevel
    ? `${selectedProgramme?.name ?? 'Programme'} — ${selectedLevel.level_label}`
    : selectedProgramme
      ? `${selectedProgramme.name} (all levels)`
      : 'All programmes'

  // SESSION 64 (owner-reported gap) — loads tier 2 (levels) whenever tier 1
  // (programme) changes. Mirrors the boot effect's cancelled-flag pattern.
  useEffect(() => {
    if (!isHigherEd || !filterProgrammeId) {
      setProgrammeLevels([])
      return
    }
    let cancelled = false
    async function run() {
      setLevelsLoading(true)
      const res = await loadProgrammeLevels(filterProgrammeId)
      if (cancelled) return
      setLevelsLoading(false)
      if (!res.error) setProgrammeLevels(res.data)
    }
    run()
    return () => { cancelled = true }
  }, [isHigherEd, filterProgrammeId])

  // ─── Load students whenever class filter changes ───────────────────────────

  const loadList = useCallback(async () => {
    setListState('loading')

    // Problem 9.8 (Tier 9) — "unplaced" is a completely separate query
    // shape (loadUnplacedHigherEdStudents(), no statusFilter/class/level
    // params at all — it's always status='active' AND no current
    // placement, by definition), not a variant of the normal loadStudents()
    // call below. Short-circuits before touching any of the usual
    // class/programme/level filter params, which don't apply to this view.
    if (isHigherEd && showUnplacedOnly) {
      const unplacedRes = await loadUnplacedHigherEdStudents(schoolId)
      if (!unplacedRes.ok) {
        setListError(unplacedRes.error)
        setListState('error')
        return
      }
      setStudents(unplacedRes.data)
      setListState(unplacedRes.data.length === 0 ? 'empty' : 'ready')
      const unplacedTagsRes = await loadStudentRoleTagsBatch(unplacedRes.data.map(s => s.id))
      if (unplacedTagsRes.ok) setListRoleTags(unplacedTagsRes.data)
      return
    }

    const res = await loadStudents({
      schoolId,
      classNodeId: effectiveClassIds.length === 1 ? effectiveClassIds[0] : effectiveClassIds,
      statusFilter,
      isHigherEd,
      programmeLevelIds: effectiveProgrammeLevelIds,
    })
    if (!res.ok) {
      setListError(res.error)
      setListState('error')
      return
    }
    const enriched = res.data.map(s => ({
      ...s,
      class_path_label: s.class_node_id
        ? (classPathMap.get(s.class_node_id) ?? null)
        : null,
    }))
    setStudents(enriched)
    setListState(enriched.length === 0 ? 'empty' : 'ready')

    // Session 14 — batch role-tag fetch for the list row display. Fired
    // after the list itself renders (not awaited above) so a slow or
    // failing roles query never blocks the student list from showing —
    // degrades to "no tags shown yet" rather than a loading stall.
    const tagsRes = await loadStudentRoleTagsBatch(enriched.map(s => s.id))
    if (tagsRes.ok) setListRoleTags(tagsRes.data)

    // Session 21 — same non-blocking, degrade-silently treatment as the
    // role-tag batch immediately above. Only resolves students who actually
    // have a photo_url set (most won't, especially right after this
    // feature ships) and skips any path already in the cache.
    enriched
      .filter(s => s.photo_url)
      .forEach(s => { resolvePhoto(s.photo_url) })
  }, [effectiveSelectionKey, effectiveHigherEdSelectionKey, statusFilter, classPathMap, isHigherEd, showUnplacedOnly, schoolId])

  useEffect(() => {
    if (bootState === 'ready') loadList()
  }, [bootState, loadList])

  // ─── Attendance auto-deactivation (migration_attendance_auto_deactivation.sql) ─
  // "Looks automatic" — runs once when this module loads, not on a real
  // schedule. Gated on canManageStudents specifically (not just bootState
  // ready) because the deactivation write inside
  // runAttendanceAutoDeactivationCheck() goes through the same RLS as a
  // manual status change: a staff member without students.records.manage
  // (e.g. a teacher who can only mark attendance) opening this module would
  // have every write silently rejected, so there is no point attempting it
  // for them — the next admin/records-manager to open this screen still
  // catches it. hasRunAutoDeactivationCheck guards against this firing more
  // than once per mount (e.g. bootState briefly flickering), since running
  // it twice in a row is wasted work, not incorrect, but still worth
  // avoiding.
  const hasRunAutoDeactivationCheck = useRef(false)
  const [attendanceDeactivationSettings, setAttendanceDeactivationSettings] =
    useState<AttendanceDeactivationSettings | null>(null)

  useEffect(() => {
    // Read-only, cheap, and useful even for staff without
    // students.records.manage (it only drives the threshold-1 "at risk"
    // badge below, never a write) — so this loads independently of the
    // check itself and its own permission gate.
    loadAttendanceDeactivationSettings(schoolId).then(({ data, error }) => {
      if (!error) setAttendanceDeactivationSettings(data)
    })
  }, [schoolId])

  useEffect(() => {
    if (bootState !== 'ready' || !canManageStudents || hasRunAutoDeactivationCheck.current) return
    hasRunAutoDeactivationCheck.current = true

    runAttendanceAutoDeactivationCheck(schoolId).then(res => {
      if (!res.ok || res.data.deactivated.length === 0) return
      const names = res.data.deactivated.map((d: AttendanceDeactivationCandidate) => d.full_name)
      const summary = names.length === 1
        ? `${names[0]} was auto-deactivated for attendance.`
        : `${names.length} students were auto-deactivated for attendance: ${names.join(', ')}.`
      setListSuccessMsg(summary)
      window.setTimeout(() => setListSuccessMsg(''), 6000) // longer than the 3s default — this can name several students, worth more time to read
      loadList()
    })
  }, [bootState, canManageStudents, schoolId, loadList])

  // ─── Load status counts whenever CLASS filter changes ──────────────────────
  // Deliberately separate from loadList()/statusFilter above: the stat strip
  // must keep showing every status's count even while the visible list is
  // scoped to just one of them. Only class filter should reset these counts.

  const loadStatusCounts = useCallback(async () => {
    // SESSION 64 — class_node_id-based counts don't apply to a higher-ed
    // student at all (no class membership exists for that school type), so
    // this branches to the dedicated placement-derived function rather than
    // trying to force isHigherEd through the class-scoped one. See both
    // functions' own doc comments in studentsService.ts for the full
    // reasoning.
    const res = isHigherEd
      ? await getHigherEdStudentStatusCounts(schoolId)
      : await getStudentStatusCounts({
          schoolId,
          classNodeId: effectiveClassIds.length === 1 ? effectiveClassIds[0] : effectiveClassIds,
        })
    if (res.ok) setStatusCounts(res.data)
  }, [effectiveSelectionKey, isHigherEd, schoolId])

  useEffect(() => {
    if (bootState === 'ready') loadStatusCounts()
  }, [bootState, loadStatusCounts])

  // ─── Filtered list (client-side search) ───────────────────────────────────

  const filteredStudents = searchQuery.trim()
    ? students.filter(s =>
        s.full_name.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : students

  // migration_attendance_auto_deactivation.sql — 'pending' means this
  // student has already reached the threshold but is still 'active' because
  // the qualifying day hasn't elapsed yet (runAttendanceAutoDeactivationCheck
  // defers exactly that case); 'at-risk' means one more qualifying absence
  // would cross it. Returns null whenever the rule doesn't apply at all
  // (disabled, or the student isn't currently active).
  function attendanceRiskInfo(student: Student): 'pending' | 'at-risk' | null {
    if (!attendanceDeactivationSettings?.enabled || student.status !== 'active') return null
    const isConsecutive = attendanceDeactivationSettings.mode === 'consecutive'
    const count = isConsecutive ? student.consecutive_absent_count : student.cumulative_absent_count
    const threshold = isConsecutive
      ? attendanceDeactivationSettings.consecutive_threshold
      : attendanceDeactivationSettings.cumulative_threshold
    if (count >= threshold) return 'pending'
    if (count === threshold - 1) return 'at-risk'
    return null
  }

  // ─── Status stat strip (PRD Session 22, Problem 5.4) ──────────────────────
  // Sourced from statusCounts (a dedicated getStudentStatusCounts() query,
  // scoped only to filterClass) rather than derived from `students` — the
  // `students` array is now scoped to a single statusFilter at a time (active
  // by default, or whichever chip was clicked), so aggregating it here would
  // make every non-selected status's count collapse to 0. statusCounts stays
  // independent of statusFilter, so the strip's numbers stay stable no matter
  // which status the visible list underneath is currently showing.
  const studentStats = {
    total: statusCounts?.total ?? 0,
    active: statusCounts?.active ?? 0,
    inactive: statusCounts?.inactive ?? 0,
    alumni: statusCounts?.alumni ?? 0,
    transferred: (statusCounts?.transferred_out ?? 0) + (statusCounts?.transferred_in_pending ?? 0),
    // Problem 9.8 (Tier 9) — higher-ed only; undefined for secondary
    // schools (getStudentStatusCounts() never sets it), left as undefined
    // here too rather than coerced to 0, so renderStatStrip() below can
    // tell "not applicable to this school type" apart from "genuinely
    // zero unplaced students" if it ever needs to.
    unplaced: statusCounts?.unplaced,
  }

  // ─── Open detail panel ────────────────────────────────────────────────────


  // Problem 9.8 (Tier 9) — optional initialTab param so the Unplaced list
  // can open a row straight into the Status tab (where "Assign to level"
  // lives) instead of always defaulting to Brief. Every existing caller
  // omits it and keeps today's Brief-first behavior unchanged.
  const refreshPendingObl = useCallback(async () => {
    if (!canManageStudents) return
    const res = await loadPendingObligations(schoolId)
    if (res.ok) setPendingObl(res.data)
  }, [schoolId, canManageStudents])

  useEffect(() => { void refreshPendingObl() }, [refreshPendingObl])

  const detailStudentId = detailStudent?.id ?? null
  const refreshStuObl = useCallback(async () => {
    if (!detailStudentId || !canManageStudents) { setStuObligations([]); return }
    setStuOblLoading(true)
    const res = await loadStudentObligations(detailStudentId)
    setStuOblLoading(false)
    if (res.ok) setStuObligations(res.data)
    else setOblError(res.error)
  }, [detailStudentId, canManageStudents])

  useEffect(() => {
    setOblError('')
    setResolvingId(null)
    void refreshStuObl()
  }, [refreshStuObl])

  async function handleResolveObligation(id: string, status: 'fulfilled' | 'waived') {
    setResolveSaving(true)
    setOblError('')
    const res = await resolveObligation({ id, status, note: resolveNote, resolvedBy: actorRecordId ?? null })
    setResolveSaving(false)
    if (!res.ok) { setOblError(res.error); return }
    setResolvingId(null)
    setResolveNote('')
    await Promise.all([refreshStuObl(), refreshPendingObl()])
  }

  function openDetail(student: Student, initialTab: DetailTab = 'brief') {
    setDetailStudent(student)
    setDetailTab(initialTab)
    // Pre-fill info form
    setEditingId(student.id)
    setForm({
      full_name:      student.full_name,
      class_node_id:  student.class_node_id ?? '',
      gender:         student.gender ?? '',
      date_of_birth:  student.date_of_birth ?? '',
      admission_date: student.admission_date ?? '',
      student_code:   student.student_code ?? '',
      blood_group:              student.blood_group ?? '',
      address:                  student.address ?? '',
      medical_notes:             student.medical_notes ?? '',
      emergency_contact_name:    student.emergency_contact_name ?? '',
      emergency_contact_phone:   student.emergency_contact_phone ?? '',
      hobbies:                   student.hobbies ?? '',
      email:                     student.email ?? '',
      phone:                     student.phone ?? '',
      // Problem 9.8 — the Edit form never edits placement (that's the
      // Status tab's job, or upsertPlacement() directly), so these two
      // always reset to blank on open regardless of the student's real
      // current placement. Distinct from currentPlacement (fetched
      // separately below via fetchBrief) which is what actually drives the
      // read-only Programme/Level display and the Status tab's own gate.
      programme_id: '',
      programme_level_id: '',
    })
    setFormError('')
    setBriefSuccessMsg('')
    // Reset other tabs
    setAttendanceSummary(undefined)
    setBriefState('booting')
    setBriefError('')
    setCurrentPlacement(undefined)
    setPlacementState('booting')
    setCgpaValue(undefined)
    setCgpaState('booting')
    setOverallAttendance(undefined)
    setOverallAttendanceState('booting')
    setMoreDetailsOpen(false)
    setStudentIdentity(undefined)
    setStudentProvisioning(false)
    setStudentProvisionError('')
    setGuardians([])
    setGuardiansState('booting')
    setGuardiansError('')
    setGuardianFormOpen(false)
    setGuardianForm(EMPTY_GUARDIAN_FORM)
    setGuardianError('')
    setUnlinkTarget(null)
    setRegenerateConfirmTarget(null)
    setGuardianSearchMode(false)
    setGuardianSearchQ('')
    setGuardianSearchRes([])
    setStatusError('')
    setStatusConfirm(null)
    setTransferRequest(undefined)
    setTransferState('booting')
    setTransferError('')
    setTransferConfirm(false)
    setRoleTags([])
    setRoleTagsState('booting')
    setAssignableRoles([])
    setAssignableRolesState('booting')
    setPhotoUploading(false)
    setPhotoError('')
    setPhotoPreviewOpen(false)
    // Problem 9.8 (Tier 9) — Status tab's "Assign to level" panel resets
    // closed on every open, same reset-on-open discipline as every other
    // per-student panel above.
    setAssignPanelOpen(false)
    setAssignProgrammeId('')
    setAssignLevelId('')
    setAssignLevels([])
    setAssigning(false)
    setAssignError('')
    fetchBrief(student.id)
    fetchStudentIdentity(student.id)
    fetchRoleTags(student.id)
    resolvePhoto(student.photo_url)
  }

  function closeDetail() {
    setDetailStudent(null)
    setEditingId(null)
    setFormError('')
    setPhotoPreviewOpen(false)
  }

  // ─── Detail tab switch — lazy-load data ───────────────────────────────────

  async function switchDetailTab(tab: DetailTab) {
    setDetailTab(tab)
    if (!detailStudent) return

    if (tab === 'guardians' && guardiansState === 'booting') {
      await fetchGuardians(detailStudent.id)
    }
    if (tab === 'status' && transferRequest === undefined) {
      await fetchTransferRequest(detailStudent.id)
    }
    if (tab === 'info' && assignableRolesState === 'booting') {
      await fetchAssignableRoles(detailStudent)
    }
  }

  // ─── Photo: resolve a stored path into a displayable signed URL ───────────
  // Session 21 — students.photo_url stores a Storage *path*, not a
  // renderable URL (the bucket is private; see studentsService.ts's
  // uploadStudentPhoto doc comment for why getPublicUrl() would have been
  // wrong here). Every render site must go through this, never read
  // photo_url directly into an <img src>. Silent no-op if resolution fails
  // or there's no path — callers already fall back to initials, matching
  // §4.3's "no broken image icons" empty-state spirit.
  async function resolvePhoto(photoPath: string | null) {
    if (!photoPath) return
    if (photoUrls.has(photoPath)) return
    const url = await getStudentPhotoSignedUrl(photoPath)
    if (url) setPhotoUrls(prev => new Map(prev).set(photoPath, url))
  }

  // ─── Brief: fetch ──────────────────────────────────────────────────────────

  async function fetchBrief(studentId: string) {
    if (isHigherEd) {
      // Daily attendance_records has no meaning for a higher-ed student —
      // per-course attendance lives in course_attendance_records instead
      // (SESSION 58). briefState is left 'ready' immediately (this stat
      // has its own independent overallAttendanceState below) so the tab
      // isn't stuck on a skeleton waiting on a value it doesn't use.
      setBriefState('ready')

      setPlacementState('loading')
      const placementRes = await loadStudentCurrentPlacement(studentId)
      if (placementRes.error) {
        setPlacementState('error')
      } else {
        setCurrentPlacement(placementRes.data)
        setPlacementState('ready')
      }

      setCgpaState('loading')
      try {
        const { data, error } = await loadStudentTranscript(studentId, true)
        if (error || !data) {
          setCgpaState('error')
        } else {
          setCgpaValue(data.cgpa)
          setCgpaState('ready')
        }
      } catch {
        setCgpaState('error')
      }

      setOverallAttendanceState('loading')
      const sessionRes = await loadCurrentSession()
      if (!sessionRes.ok || !sessionRes.sessionId) {
        setOverallAttendanceState('error')
      } else {
        const attRes = await loadStudentOverallAttendance({
          studentId,
          sessionId: sessionRes.sessionId,
        })
        if (!attRes.ok) {
          setOverallAttendanceState('error')
        } else {
          setOverallAttendance(attRes.data)
          setOverallAttendanceState('ready')
        }
      }
      return
    }

    setBriefState('loading')
    const res = await loadAttendanceSummary(studentId)
    if (!res.ok) {
      setBriefError(res.error)
      setBriefState('error')
      return
    }
    setAttendanceSummary(res.data)
    setBriefState('ready')
  }

  // ─── Guardians: fetch ─────────────────────────────────────────────────────

  async function fetchGuardians(studentId: string) {
    setGuardiansState('loading')
    const res = await loadGuardiansForStudent(studentId)
    if (!res.ok) {
      setGuardiansError(res.error)
      setGuardiansState('error')
      return
    }
    setGuardians(res.data)
    setGuardiansState(res.data.length === 0 ? 'empty' : 'ready')

    // Bug fix, 2026-07-02 (owner-reported): the provisioning card previously
    // fell back to "No login set up yet" for any guardian whose `identities`
    // entry was still `undefined` — which was every access-granted guardian
    // on first render, since `identities` was only ever populated on-demand
    // (granting access, or opening the provision form). `undefined` (not yet
    // fetched) and `null` (fetched, genuinely unprovisioned) were being
    // treated as the same case. That meant a guardian who already had a
    // working login code would show "not set up" and route straight into
    // the create/regenerate flow with no confirm step, since the confirm
    // gate only lived on the *other* branch's "Change / regenerate" button.
    // Fix: as soon as the guardian list loads, eagerly fetch the identity
    // for every guardian who already has platform access, so `identities`
    // resolves to its real value (object or `null`) before the card ever
    // renders for them — no click required to find out which state they're
    // actually in.
    res.data
      .filter(link => link.has_platform_access)
      .forEach(link => { fetchGuardianIdentity(link.guardian_id) })
  }

  // ─── Guardians: add ───────────────────────────────────────────────────────

  function openGuardianForm() {
    setGuardianForm(EMPTY_GUARDIAN_FORM)
    setGuardianError('')
    setGuardianFormOpen(true)
    setTimeout(() => guardianNameRef.current?.focus(), 80)
  }

  function closeGuardianForm() {
    setGuardianFormOpen(false)
    setGuardianError('')
  }

  async function handleAddGuardian() {
    if (!detailStudent) return
    if (!guardianForm.full_name.trim()) {
      setGuardianError('Guardian name is required.')
      guardianNameRef.current?.focus()
      return
    }
    setGuardianSaving(true)
    setGuardianError('')
    const res = await addGuardian({
      schoolId,
      studentId:    detailStudent.id,
      full_name:    guardianForm.full_name,
      phone:        guardianForm.phone || null,
      email:        guardianForm.email || null,
      relationship: guardianForm.relationship || null,
    })
    setGuardianSaving(false)
    if (!res.ok) {
      setGuardianError(res.error)
      return
    }
    closeGuardianForm()
    await fetchGuardians(detailStudent.id)
  }

  // ─── Guardians: search-first link existing ────────────────────────────────

  function handleGuardianSearchChange(val: string) {
    setGuardianSearchQ(val)
    clearTimeout(guardianSearchTimer.current)
    setGuardianSearchRes([])
    if (!val.trim()) return
    guardianSearchTimer.current = setTimeout(async () => {
      setGuardianSearching(true)
      const res = await searchGuardians(val)
      setGuardianSearching(false)
      if (res.ok) setGuardianSearchRes(res.data)
    }, 350)
  }

  async function handleLinkExistingGuardian(guardianId: string) {
    if (!detailStudent) return
    setGuardianLinkSaving(true)
    setGuardianError('')
    const res = await linkGuardianToStudent({
      schoolId,
      guardianId,
      studentId: detailStudent.id,
    })
    setGuardianLinkSaving(false)
    if (!res.ok) {
      setGuardianError(res.error)
      return
    }
    setGuardianSearchMode(false)
    setGuardianSearchQ('')
    setGuardianSearchRes([])
    await fetchGuardians(detailStudent.id)
  }

  // ─── Guardians: toggle platform access ────────────────────────────────────

  async function handleToggleAccess(link: GuardianLink) {
    if (!detailStudent) return
    const newValue = !link.has_platform_access
    // Optimistic update
    setGuardians(prev =>
      prev.map(g =>
        g.guardian_id === link.guardian_id
          ? { ...g, has_platform_access: newValue }
          : newValue ? { ...g, has_platform_access: false } : g
        // If granting, also clear any other guardian's access optimistically
      )
    )
    const res = await updateGuardianLink(detailStudent.id, link.guardian_id, newValue)
    if (!res.ok) {
      // Revert
      setGuardians(prev =>
        prev.map(g =>
          g.guardian_id === link.guardian_id
            ? { ...g, has_platform_access: link.has_platform_access }
            : g
        )
      )
      setGuardiansError(res.error)
    }
  }

  // ─── Guardians: unlink ────────────────────────────────────────────────────

  async function handleUnlink() {
    if (!detailStudent || !unlinkTarget) return
    setUnlinkSaving(true)
    const res = await unlinkGuardian(detailStudent.id, unlinkTarget.guardian_id)
    setUnlinkSaving(false)
    if (!res.ok) {
      setGuardiansError(res.error)
      setUnlinkTarget(null)
      return
    }
    setUnlinkTarget(null)
    await fetchGuardians(detailStudent.id)
  }

  // ─── Status management ────────────────────────────────────────────────────

  async function handleStatusChange(newStatus: 'active' | 'inactive' | 'alumni', note?: string) {
    if (!detailStudent) return
    setStatusSaving(true)
    setStatusError('')
    setStatusConfirm(null)
    const res = await updateStudentStatus(detailStudent.id, newStatus, note)
    setStatusSaving(false)
    if (!res.ok) {
      setStatusError(res.error)
      return
    }
    setReactivateNote('')
    if (newStatus === 'active' && reactivateDraft) {
      const ob = await createObligation({
        schoolId, studentId: detailStudent.id, draft: reactivateDraft, createdBy: actorRecordId ?? null,
      })
      if (!ob.ok) setStatusError(`Reactivated, but the fine/task could not be saved: ${ob.error}`)
      await Promise.all([refreshStuObl(), refreshPendingObl()])
    }
    setReactivateDraft(null)
    // Update the detail student and list without a full reload. Reactivating
    // also resets the attendance auto-deactivation counters server-side
    // (updateStudentStatus()) — mirrored here so the at-risk/pending badges
    // don't show stale numbers until the next full list reload.
    const updated: Student = newStatus === 'active'
      ? { ...detailStudent, status: newStatus, consecutive_absent_count: 0, cumulative_absent_count: 0, last_absent_date: null, deactivation_reason: null }
      : { ...detailStudent, status: newStatus }
    setDetailStudent(updated)
    setStudents(prev => prev.map(s => s.id === updated.id ? updated : s))
  }

  // ─── Transfer ─────────────────────────────────────────────────────────────

  async function fetchTransferRequest(studentId: string) {
    setTransferState('loading')
    const res = await loadTransferRequest(studentId)
    if (!res.ok) {
      setTransferState('error')
      setTransferError(res.error)
      return
    }
    setTransferRequest(res.data)
    setTransferState('ready')
  }

  async function handleInitiateTransfer() {
    if (!detailStudent) return
    setTransferSaving(true)
    setTransferError('')
    setTransferConfirm(false)
    const res = await initiateTransfer({
      studentId:    detailStudent.id,
      requestedBy:  'releasing_admin',
    })
    setTransferSaving(false)
    if (!res.ok) {
      setTransferError(res.error)
      return
    }
    // Refresh transfer request status and student status
    await fetchTransferRequest(detailStudent.id)
    const updated: Student = { ...detailStudent, status: 'transferred_out' }
    setDetailStudent(updated)
    setStudents(prev => prev.map(s => s.id === updated.id ? updated : s))
  }

  // ─── Add form (new student) ───────────────────────────────────────────────

  function openAddForm() {
    setEditingId(null)
    setDetailStudent(null)
    setForm({ ...EMPTY_FORM, admission_date: todayDateString() })
    setFormError('')
    setFormOpen(true)
    // Problem 9.8 (Tier 9) — same reset-on-open discipline as the rest of
    // this function; EMPTY_FORM already clears programme_id/
    // programme_level_id, but formLevels is separate derived state (not
    // part of FormState) and needs its own explicit reset so a previous
    // Add session's level list never briefly appears before the (empty)
    // programme selection re-triggers its own fetch.
    setFormLevels([])
    setFormLevelsLoading(false)
    setTimeout(() => nameInputRef.current?.focus(), 80)
  }

  function closeAddForm() {
    setFormOpen(false)
    setFormError('')
  }

  // ─── Dashboard quick-action intent ────────────────────────────────────────
  // intent='add_student' arrives from AdminDashboard's "Add student" quick
  // action (PRD Problem 2.2c) — open the same form the in-module button opens.
  // Runs once per mount; App.tsx resets pendingIntent to {} on every
  // onNavigate call, so a later plain bottom-nav tap into Students arrives
  // with intent=undefined and does not reopen the form.
  useEffect(() => {
    if (intent === 'add_student' && canManageStudents) {
      openAddForm()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function setField(field: keyof FormState, value: string) {
    setForm(prev => ({ ...prev, [field]: value }))
  }

  // Problem 9.8 (Tier 9) — Add form's Programme → Level dependent picker.
  // Changing the programme must always clear whatever level was previously
  // selected (a level id from the old programme is meaningless once the
  // programme itself changes) and re-fetch formLevels for the new
  // programme — same shape as the existing filter picker's own
  // programme-change effect and AdmissionManualMatricSection's
  // programmeId-change effect in SettingsModule.tsx.
  async function handleAddFormProgrammeChange(programmeId: string) {
    setForm(prev => ({ ...prev, programme_id: programmeId, programme_level_id: '' }))
    if (!programmeId) {
      setFormLevels([])
      return
    }
    setFormLevelsLoading(true)
    const res = await loadProgrammeLevels(programmeId)
    setFormLevelsLoading(false)
    if (!res.error) setFormLevels(res.data)
  }

  // Problem 9.8 (Tier 9) — Status tab's own Programme → Level dependent
  // picker, structurally identical to handleAddFormProgrammeChange() above
  // but deliberately a separate function against separate state
  // (assignProgrammeId/assignLevels, not form/formLevels) — this panel and
  // the Add form have independent open/close lifecycles and must not share
  // state, per this problem's own Tier 9 writeup reasoning.
  async function handleAssignProgrammeChange(programmeId: string) {
    setAssignProgrammeId(programmeId)
    setAssignLevelId('')
    if (!programmeId) {
      setAssignLevels([])
      return
    }
    setAssignLevelsLoading(true)
    const res = await loadProgrammeLevels(programmeId)
    setAssignLevelsLoading(false)
    if (!res.error) setAssignLevels(res.data)
  }

  // Problem 9.8 (Tier 9) — the actual remediation write, reused by both
  // the per-student Status tab flow here and, indirectly, by the Unplaced
  // list (which routes into this same Status tab rather than duplicating
  // this call — see openDetail()'s initialTab param and the list row's
  // onClick above). Calls the same upsertPlacement() the Add form's
  // optional placement and AdmissionManualMatricSection's own handlePlace()
  // both call — one write path, three entry points.
  async function handleAssignToLevel() {
    if (!detailStudent || !assignLevelId || !currentSessionId) return
    setAssigning(true)
    setAssignError('')
    const res = await upsertPlacement({
      school_id: schoolId,
      student_id: detailStudent.id,
      programme_level_id: assignLevelId,
      session_id: currentSessionId,
    })
    setAssigning(false)
    if (res.error) {
      setAssignError(res.error)
      return
    }
    setAssignPanelOpen(false)
    setAssignProgrammeId('')
    setAssignLevelId('')
    setAssignLevels([])
    // Refresh currentPlacement so the badge/note above flips to "Active"
    // immediately, without requiring the admin to close and reopen the
    // detail panel — same "no reload required" bar this codebase already
    // holds itself to elsewhere (e.g. Problem 9.2's own live-revoke
    // Definition of Done in the Tier 9 doc).
    setPlacementState('loading')
    const placementRes = await loadStudentCurrentPlacement(detailStudent.id)
    if (placementRes.error) {
      setPlacementState('error')
    } else {
      setCurrentPlacement(placementRes.data)
      setPlacementState('ready')
    }
    // Also refresh the list/stat-strip in the background so the Unplaced
    // count and (if currently in unplaced view) the list itself stay
    // accurate without a manual refresh — same non-blocking treatment as
    // the role-tag/photo batches elsewhere in this file.
    loadList()
    loadStatusCounts()
  }

  async function handleSubmit() {
    if (!form.full_name.trim()) {
      setFormError('Student name is required.')
      nameInputRef.current?.focus()
      return
    }
    setFormSaving(true)
    setFormError('')
    const params = {
      schoolId,
      full_name:      form.full_name,
      date_of_birth:  form.date_of_birth || null,
      gender:         form.gender || null,
      class_node_id:  form.class_node_id || null,
      admission_date: form.admission_date || null,
      student_code:   form.student_code.trim() || null,
      blood_group:               form.blood_group.trim() || null,
      address:                   form.address.trim() || null,
      medical_notes:             form.medical_notes.trim() || null,
      emergency_contact_name:    form.emergency_contact_name.trim() || null,
      emergency_contact_phone:   form.emergency_contact_phone.trim() || null,
      hobbies:                   form.hobbies.trim() || null,
      email:                     form.email.trim() || null,
      phone:                     form.phone.trim() || null,
    }
    const isCreating = !editingId || !detailStudent
    // Problem 9.8 (Tier 9) — placement fields only ever attached to the
    // CREATE call, never to updateStudent()'s params — editing a student's
    // placement is a separate, existing action (upsertPlacement()
    // directly, via the Status tab's own Assign-to-level control), not
    // part of this general edit form. Both fields together are also only
    // sent when a level was actually chosen (form.programme_level_id set)
    // AND a current session was resolved (currentSessionId set) —
    // createStudent() now rejects a mismatched pair explicitly (both
    // required together, or neither) rather than silently no-oping, but
    // building createParams this way still keeps a clean "both or
    // neither" contract visible at the call site too.
    const createParams = isCreating && isHigherEd && form.programme_level_id && currentSessionId
      ? { ...params, programme_level_id: form.programme_level_id, session_id: currentSessionId }
      : params
    const result = editingId && !detailStudent
      ? await createStudent(createParams, isHigherEd)   // shouldn't happen but safety net
      : editingId
        ? await updateStudent(editingId, params)
        : await createStudent(createParams, isHigherEd)

    setFormSaving(false)
    if (!result.ok) {
      setFormError(result.error)
      return
    }
    if (detailStudent) {
      // Update in detail panel
      const updated: Student = {
        ...detailStudent,
        full_name:       form.full_name.trim(),
        class_node_id:   form.class_node_id || null,
        class_path_label: form.class_node_id ? (classPathMap.get(form.class_node_id) ?? null) : null,
        gender:          form.gender || null,
        date_of_birth:   form.date_of_birth || null,
        admission_date:  form.admission_date || null,
        student_code:    form.student_code.trim() || null,
        // Session 14 fields were missing here entirely — the DB write
        // (createStudent/updateStudent, above) always saved them correctly,
        // but this local-state patch never copied them over, so Brief and
        // the list row kept showing pre-edit (or blank, on first-ever save)
        // values until the page reloaded from the DB. Same bug on both the
        // detail-panel patch and the students-list patch below, since both
        // built from this same `updated` object.
        blood_group:               form.blood_group.trim() || null,
        address:                   form.address.trim() || null,
        medical_notes:             form.medical_notes.trim() || null,
        emergency_contact_name:    form.emergency_contact_name.trim() || null,
        emergency_contact_phone:   form.emergency_contact_phone.trim() || null,
        hobbies:                   form.hobbies.trim() || null,
        email:                     form.email.trim() || null,
        phone:                     form.phone.trim() || null,
      }
      setDetailStudent(updated)
      setStudents(prev => prev.map(s => s.id === updated.id ? updated : s))
      // Previously ended here with no feedback at all — the person stayed
      // on the Edit form with nothing to indicate the save had worked.
      // Return to Brief (now showing the correct, just-saved values thanks
      // to the fix above) and show a brief confirmation there.
      setBriefSuccessMsg('Saved.')
      switchDetailTab('brief')
      window.setTimeout(() => setBriefSuccessMsg(''), 3000)
    } else {
      closeAddForm()
      await loadList()
      // Previously ended here with nothing shown — the form just closed
      // and the list refreshed, with no confirmation the new student (and
      // its full set of details) actually saved.
      //
      // Problem 9.8 (Tier 9) — the prior "warning" surfaced here (student
      // created but placement failed) belonged to createStudent()'s old
      // non-atomic two-step write. That state can no longer occur once
      // createStudent() calls the atomic create_placed_student() RPC for
      // higher-ed schools (student + placement succeed or fail together) —
      // removed rather than left as dead, non-type-checking code. This was
      // also a real TS2339 build error (`result` here is a union that
      // includes updateStudent()'s plain Ok<void>, which has no `warning`
      // field at all — not narrowable the way the removed code assumed).
      setListSuccessMsg(`${form.full_name.trim()} added.`)
      window.setTimeout(() => setListSuccessMsg(''), 3000)
    }
  }

  // ─── Photo upload (Info subtab, Session 21) ───────────────────────────────
  // Fires from the file input's onChange, not a separate "confirm" step —
  // matches the "tap avatar → camera/gallery picker → done" flow the PRD
  // describes, with no extra tap in between. Resize/compress happens inside
  // uploadStudentPhoto() itself (studentsService.ts) — this handler only
  // owns the UI-facing loading/error state and the post-success local patch.
  async function handlePhotoSelected(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    // Always clear the input's value, success or failure, so selecting the
    // *same* file twice in a row (e.g. retry after an error) still fires
    // onChange — browsers don't fire a change event for an unchanged value.
    e.target.value = ''
    if (!file || !detailStudent) return

    setPhotoUploading(true)
    setPhotoError('')

    const result = await uploadStudentPhoto({
      schoolId,
      studentId: detailStudent.id,
      file,
    })

    setPhotoUploading(false)
    if (!result.ok) {
      setPhotoError(result.error)
      return
    }

    // Same no-full-reload local-patch pattern as handleSubmit above:
    // update detailStudent + the students list in place.
    const updated: Student = { ...detailStudent, photo_url: result.data.photo_path }
    setDetailStudent(updated)
    setStudents(prev => prev.map(s => s.id === updated.id ? updated : s))
    // The fixed photo.jpg filename means a re-upload keeps the exact same
    // path — force a fresh resolve rather than relying on resolvePhoto's
    // own "already cached" skip, or the old (now-stale) image would keep
    // showing until the signed-URL cache's 30-minute TTL happens to expire.
    setPhotoUrls(prev => {
      const next = new Map(prev)
      next.delete(result.data.photo_path)
      return next
    })
    await resolvePhoto(result.data.photo_path)
  }

  // ─── Render helpers ────────────────────────────────────────────────────────

  // Session 32 — selection handlers, mirroring AttendanceModule's
  // selectClass/selectGroup: each clears the other selection shape,
  // resets search (a filter change invalidates whatever was being
  // searched for in the previous view), and collapses the picker back
  // down to the compact summary bar.
  function selectAllClasses() {
    setFilterClass('')
    setSelectedGroup(null)
    setSearchQuery('')
    setHasChosen(true)
    setPickerExpanded(false)
  }
  function selectClass(c: ClassNode) {
    setFilterClass(c.id)
    setSelectedGroup(null)
    setSearchQuery('')
    setHasChosen(true)
    setPickerExpanded(false)
  }
  function selectGroup(g: ParentClassGroup) {
    setSelectedGroup(g)
    setFilterClass('')
    setSearchQuery('')
    setHasChosen(true)
    setPickerExpanded(false)
  }

  // SESSION 64 (owner-reported gap) — higher-ed equivalent of the three
  // handlers above. selectAllProgrammes clears both tiers (all students
  // across every programme); selectProgramme narrows tier 1 only (loads
  // that programme's levels, tier 2); selectLevel narrows tier 2 to one
  // specific level. Same reset-search/collapse-picker contract as the
  // secondary handlers, for the same reason (a filter change invalidates
  // whatever was being searched for; a real choice collapses the picker).
  function selectAllProgrammes() {
    setFilterProgrammeId('')
    setProgrammeLevels([])
    setFilterLevelId('')
    setSearchQuery('')
    setHasChosen(true)
    setPickerExpanded(false)
  }
  function selectProgramme(p: Programme) {
    setFilterProgrammeId(p.id)
    setFilterLevelId('')
    setSearchQuery('')
    setHasChosen(true)
    // Deliberately does NOT collapse the picker — selecting a programme is
    // tier 1 of a two-tier choice; the level pill row (tier 2) still needs
    // to be visible for the admin to actually finish narrowing. Matches
    // the secondary picker's own selectedParentId (tier-1-only) pattern,
    // which likewise doesn't collapse on its own.
  }
  function selectLevel(l: ProgrammeLevel) {
    setFilterLevelId(l.id)
    setSearchQuery('')
    setHasChosen(true)
    setPickerExpanded(false)
  }

  // ─── ID card print (PRD Tier 6 / Problem 6.10) ────────────────────────────
  //
  // PRD §4.10 explicitly scopes this "admin-only" — reusing canManageStudents
  // (students.records.manage) rather than inventing a new permission key,
  // since that's already this module's own gate for the analogous "+ Add
  // student" action (both are office/admin-level record actions, not
  // read-level access). Two entry points: a single-card print from the
  // detail sheet header (one student, whichever is currently open), and a
  // bulk "print class" action from the list header (every student currently
  // shown in filteredStudents — respects whatever class/search filter is
  // active, same "what you see is what you get" contract as the rest of
  // this module's filtering). Both funnel through the same
  // toIdCardStudent() mapper so photo resolution (photoUrls) and the
  // class_path_label fallback stay identical between the two paths.
  function toIdCardStudent(s: Student): IdCardStudent {
    return {
      id: s.id,
      full_name: s.full_name,
      class_path_label: s.class_node_id ? (classPathMap.get(s.class_node_id) ?? null) : null,
      student_code: s.student_code,
      photo_url: s.photo_url ? (photoUrls.get(s.photo_url) ?? null) : null,
    }
  }

  function printSingleStudentIdCard(student: Student) {
    printStudentIdCards({
      schoolName,
      schoolLogoUrl,
      students: [toIdCardStudent(student)],
    })
  }

  function printClassIdCards() {
    printStudentIdCards({
      schoolName,
      schoolLogoUrl,
      students: filteredStudents.map(toIdCardStudent),
    })
  }

  function renderHeader() {
    // Session 32 (owner request: "same kind of intelligent navigation" as
    // AttendanceModule's whole-parent view) — two-tier pill picker:
    // tier 1 narrows by parent/grade, tier 2 shows that parent's own arms
    // plus a dashed "All of {parent}" pill for the combined view. Orphan
    // leaves (no parent_id) always show in tier 2's "All classes" view
    // (no parent selected), same as before this feature — never
    // unreachable. hasSelection now reads the explicit hasChosen flag
    // (Session 32 follow-up), not filterClass/selectedGroup directly —
    // '' is both "nothing picked yet" and "All classes chosen", and only
    // the latter should collapse.
    const hasSelection = hasChosen
    const visibleLeaves = selectedParentId
      ? classes.filter(c => c.parent_id === selectedParentId)
      : classes
    const activeParent = parentGroups.find(g => g.id === selectedParentId) ?? null
    // SESSION 64 (owner-reported gap) — every downstream read in this
    // function branches on isHigherEd from here, rather than each site
    // re-deriving its own condition.
    const resolvedLabel = isHigherEd ? effectiveHigherEdLabel : effectiveLabel

    return (
      <div className="stu-header">
        <div className="stu-header-top">
          <h2 className="stu-title">Students</h2>
          {canManageStudents && (
            <button className="stu-add-btn" onClick={openAddForm}>
              + Add student
            </button>
          )}
        </div>

        {bootState === 'ready' && (
          <div className="stu-filter-bar">
            {/* Collapsed summary bar — once a selection is made, fold both
                pill tiers into one compact row (economizes phone screen
                space, matches AttendanceModule's own follow-up). Defaults
                to expanded when nothing is selected yet. */}
            {hasSelection && !pickerExpanded ? (
              <button
                type="button"
                className="stu-selector-summary"
                onClick={() => setPickerExpanded(true)}
              >
                <span className="stu-selector-summary-label">{resolvedLabel}</span>
                <span className="stu-selector-summary-change">
                  Change <Icon name="chevron-down" size={14} />
                </span>
              </button>
            ) : isHigherEd ? (
              <>
                {/* SESSION 64 (owner-reported gap) — programme/level
                    picker, replacing the class picker entirely for
                    higher-ed schools. Same two-tier pill shape as the
                    secondary picker below (tier 1 = programme, tier 2 =
                    level), sourced from programmes/programmeLevels
                    instead of classes/parentGroups — a higher-ed student
                    has no class_node_id to filter by at all. */}
                {programmes.length > 0 && (
                  <div className="stu-pill-row" role="tablist" aria-label="Filter by programme">
                    <button
                      type="button"
                      className={`stu-pill${filterProgrammeId === '' ? ' stu-pill--active' : ''}`}
                      onClick={selectAllProgrammes}
                    >
                      All
                    </button>
                    {programmes.map(p => (
                      <button
                        type="button"
                        key={p.id}
                        className={`stu-pill${filterProgrammeId === p.id ? ' stu-pill--active' : ''}`}
                        onClick={() => selectProgramme(p)}
                      >
                        {p.name}
                      </button>
                    ))}
                  </div>
                )}

                {filterProgrammeId && (
                  <div className="stu-class-pills" role="group" aria-label="Filter by level">
                    <button
                      type="button"
                      className={`stu-class-pill${filterLevelId === '' ? ' stu-class-pill--active' : ''}`}
                      onClick={() => setFilterLevelId('')}
                      aria-pressed={filterLevelId === ''}
                    >
                      All levels
                    </button>
                    {levelsLoading ? (
                      <span className="stu-brief-stat-skel skeleton" />
                    ) : (
                      programmeLevels.map(l => (
                        <button
                          type="button"
                          key={l.id}
                          className={`stu-class-pill${filterLevelId === l.id ? ' stu-class-pill--active' : ''}`}
                          onClick={() => selectLevel(l)}
                          aria-pressed={filterLevelId === l.id}
                        >
                          {l.level_label}
                        </button>
                      ))
                    )}
                  </div>
                )}
              </>
            ) : (
              <>
                {/* SESSION 12 step 4 (extended Session 32) — dropdown
                    replaced with tappable pills so which class you're
                    viewing (and that other classes exist) is visible at a
                    glance, no open-to-check-options step. Two tiers when
                    parent groups exist; falls back to the original flat
                    single row when a school has no grouped classes at all
                    (parentGroups.length === 0), so a flat-tree school sees
                    no change from before this feature. */}
                {parentGroups.length > 0 && (
                  <div className="stu-pill-row" role="tablist" aria-label="Filter by grade">
                    <button
                      type="button"
                      className={`stu-pill${selectedParentId === null ? ' stu-pill--active' : ''}`}
                      onClick={() => setSelectedParentId(null)}
                    >
                      All
                    </button>
                    {parentGroups.map(g => (
                      <button
                        type="button"
                        key={g.id}
                        className={`stu-pill${selectedParentId === g.id ? ' stu-pill--active' : ''}`}
                        onClick={() => setSelectedParentId(g.id)}
                      >
                        {g.name}
                      </button>
                    ))}
                  </div>
                )}

                <div className="stu-class-pills" role="group" aria-label="Filter by class">
                  <button
                    type="button"
                    className={`stu-class-pill${filterClass === '' && !selectedGroup ? ' stu-class-pill--active' : ''}`}
                    onClick={selectAllClasses}
                    aria-pressed={filterClass === '' && !selectedGroup}
                  >
                    All classes
                  </button>
                  {activeParent && (
                    <button
                      type="button"
                      className={`stu-class-pill stu-class-pill--group${selectedGroup?.id === activeParent.id ? ' stu-class-pill--active' : ''}`}
                      onClick={() => selectGroup(activeParent)}
                      aria-pressed={selectedGroup?.id === activeParent.id}
                    >
                      All of {activeParent.name}
                    </button>
                  )}
                  {visibleLeaves.map(c => (
                    <button
                      type="button"
                      key={c.id}
                      className={`stu-class-pill${filterClass === c.id ? ' stu-class-pill--active' : ''}`}
                      onClick={() => selectClass(c)}
                      aria-pressed={filterClass === c.id}
                    >
                      {activeParent ? c.name : c.path_label}
                    </button>
                  ))}
                </div>
              </>
            )}

            <input
              type="search"
              className="stu-search"
              placeholder={`Search in ${resolvedLabel}…`}
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
          </div>
        )}

        {(bootState === 'loading' || bootState === 'booting') && (
          <div className="stu-filter-skel skeleton" />
        )}
      </div>
    )
  }

  function renderList() {
    if (bootState === 'error') {
      return (
        <div className="stu-error-state">
          <span className="stu-error-icon"><Icon name="alert-triangle" style={{ color: 'var(--color-warning, #d97706)' }} /></span>
          <p className="stu-error-msg">{bootError}</p>
          <button className="stu-retry-btn" onClick={() => window.location.reload()}>Retry</button>
        </div>
      )
    }
    if (listState === 'loading' || listState === 'booting') {
      return (
        <div className="stu-list-skel">
          {[1,2,3,4,5,6].map(i => (
            <div key={i} className="stu-row-skel skeleton" />
          ))}
        </div>
      )
    }
    if (listState === 'error') {
      return (
        <div className="stu-error-state">
          <span className="stu-error-icon"><Icon name="alert-triangle" style={{ color: 'var(--color-warning, #d97706)' }} /></span>
          <p className="stu-error-msg">{listError}</p>
          <button className="stu-retry-btn" onClick={loadList}>Retry</button>
        </div>
      )
    }
    if (listState === 'empty') {
      return (
        <div className="stu-empty-state">
          <span className="stu-empty-icon"><Icon name="users" /></span>
          <p className="stu-empty-msg">
            {isHigherEd
              ? ((filterProgrammeId || filterLevelId) ? 'No students placed in this programme/level yet.' : 'No students added yet.')
              : ((filterClass || selectedGroup) ? 'No students enrolled in this class yet.' : 'No students added yet.')}
          </p>
          {canManageStudents && (
            <button className="stu-empty-action" onClick={openAddForm}>
              Add first student →
            </button>
          )}
        </div>
      )
    }
    if (filteredStudents.length === 0) {
      return (
        <div className="stu-empty-state stu-empty-state--search">
          <span className="stu-empty-icon"><Icon name="search" /></span>
          <p className="stu-empty-msg">No students match "{searchQuery}".</p>
        </div>
      )
    }
    return (
      <ul className="stu-list">
        {filteredStudents.map(student => (
          <li key={student.id} className="stu-row">
            <button
              className="stu-row-btn"
              onClick={() => openDetail(student, showUnplacedOnly ? 'status' : 'brief')}
            >
              <div className="stu-row-avatar" aria-hidden>
                {/* Session 21 — photo_url is a Storage path, never rendered
                    directly; photoUrls holds the resolved signed URL, keyed
                    by that path, populated by the batch resolve in
                    loadList(). Falls back to initials until resolved or if
                    the student has no photo — same "no broken image icons"
                    treatment used everywhere else in this file. */}
                {student.photo_url && photoUrls.get(student.photo_url) ? (
                  <img
                    className="stu-row-avatar-img"
                    src={photoUrls.get(student.photo_url)}
                    alt=""
                  />
                ) : (
                  student.full_name.charAt(0).toUpperCase()
                )}
              </div>
              <div className="stu-row-body">
                <span className="stu-row-name">{student.full_name}</span>
                {(() => {
                  const b = canManageStudents ? obligationBadge(pendingObl.get(student.id)) : null
                  return b ? <span className="obl-badge" title={b.title}>{b.label}</span> : null
                })()}
                <span className="stu-row-meta">
                  {isHigherEd
                    ? (student.matric_number ?? 'No matric number yet')
                    : (student.class_path_label ?? 'No class assigned')}
                  {student.gender ? ` · ${student.gender}` : ''}
                  {student.student_code ? ` · ${student.student_code}` : ''}
                </span>
                {/* migration_attendance_auto_deactivation.sql — distinguishes
                    an auto-deactivation from every other reason a student
                    might be inactive (manual, alumni, transfer), and warns
                    staff before it happens rather than only after. */}
                {student.status === 'inactive' && student.deactivation_reason === 'attendance_auto' && (
                  <span className="stu-attendance-auto-tag" title="Automatically set to inactive by the attendance rule">
                    Auto-deactivated (attendance)
                  </span>
                )}
                {attendanceRiskInfo(student) === 'pending' && (
                  <span className="stu-attendance-risk-tag stu-attendance-risk-tag--pending" title="Over the attendance threshold — will be deactivated once staff next open this screen after the day ends">
                    Attendance: pending deactivation
                  </span>
                )}
                {/* Session 14 — role tags directly on the list row. Silent
                    when a student holds no role, same treatment as the
                    detail header and the Guardians page: no "Unassigned"
                    placeholder, the row just has one less line. */}
                {(listRoleTags.get(student.id)?.length ?? 0) > 0 && (
                  <div className="stu-role-tags stu-row-role-tags">
                    {listRoleTags.get(student.id)!.map(tag => (
                      <span key={tag.id} className="stu-role-tag">{tag.name}</span>
                    ))}
                  </div>
                )}
              </div>
              <span className="stu-row-arrow">›</span>
            </button>
          </li>
        ))}
      </ul>
    )
  }

  function renderCount() {
    if (listState !== 'ready' && listState !== 'empty') return null
    const total = students.length
    const shown = filteredStudents.length
    return (
      <p className="stu-count">
        {searchQuery
          ? `${shown} of ${total} student${total !== 1 ? 's' : ''}`
          : `${total} student${total !== 1 ? 's' : ''}`}
        {statusFilter !== 'active' && (
          <button
            type="button"
            className="stu-status-filter-clear"
            onClick={() => setStatusFilter('active')}
          >
            Showing: {statusLabel(statusFilter)} ×
          </button>
        )}
        {/* Problem 9.8 (Tier 9) — parallel indicator for showUnplacedOnly,
            since it's a separate piece of state from statusFilter and
            neither one implies the other. */}
        {showUnplacedOnly && (
          <button
            type="button"
            className="stu-status-filter-clear"
            onClick={() => setShowUnplacedOnly(false)}
          >
            Showing: Unplaced ×
          </button>
        )}
        {/* PRD Tier 6 / Problem 6.10 — bulk ID card print for whatever's
            currently shown (respects class filter + search, same
            "what you see is what you get" contract as the count text
            itself). Admin-only per §4.10; hidden when the list is empty. */}
        {canManageStudents && shown > 0 && (
          <button
            type="button"
            className="stu-print-class-btn"
            onClick={printClassIdCards}
          >
            <Icon name="printer" size={14} /> Print ID cards
          </button>
        )}
      </p>
    )
  }

  // PRD Session 22, Problem 5.4 — status stat strip above the list, same
  // "class/chip" pattern as AdminDashboard.tsx and AttendanceModule.tsx's
  // att-summary-bar (§4.7 consistency). Only shows chips for statuses with
  // at least one student, same "don't show a zero" convention as
  // renderSummaryBar() in AttendanceModule.tsx.
  //
  // Follow-up to the original stat strip: each non-total chip is now a
  // toggle into the hidden (non-active) statuses. The visible list itself
  // still defaults to active-only; clicking "N inactive" switches the list
  // to show just that status (via statusFilter), while the strip's own
  // counts (statusCounts) stay put regardless of which one is selected, so
  // the numbers never jump around as you drill in and out. Clicking the
  // currently-selected chip again returns to the active-only default —
  // same affordance as the "Showing: X ×" indicator in renderCount().
  function renderStatStrip() {
    if (studentStats.total === 0) return null

    function chip(
      status: Student['status'] | null,
      count: number,
      label: string,
      variant: string,
    ) {
      if (count === 0) return null
      const isSelected = status !== null && statusFilter === status
      return (
        <button
          type="button"
          className={`stu-stat stu-stat--${variant}${isSelected ? ' stu-stat--selected' : ''}`}
          onClick={() => {
            if (status === null) return
            setStatusFilter(isSelected ? 'active' : status)
          }}
        >
          {count} {label}
        </button>
      )
    }

    return (
      <div className="stu-stat-strip">
        <span className="stu-stat stu-stat--total stu-stat--static">
          {studentStats.total} total
        </span>
        {chip('active', studentStats.active, 'active', 'active')}
        {chip('inactive', studentStats.inactive, 'inactive', 'inactive')}
        {chip('alumni', studentStats.alumni, 'alumni', 'alumni')}
        {/* "transferred" combines two underlying statuses (transferred_out /
            transferred_in_pending), so it can't map to a single statusFilter
            value the way the others do. Kept as a static, non-clickable
            count for now rather than guessing which of the two the user
            means — same "don't invent scope" approach as elsewhere in this
            file. */}
        {studentStats.transferred > 0 && (
          <span className="stu-stat stu-stat--transferred stu-stat--static">
            {studentStats.transferred} transferred
          </span>
        )}
        {/* Problem 9.8 (Tier 9) — higher-ed only. Deliberately its own
            button, not routed through chip() above: chip() toggles
            statusFilter, but "unplaced" isn't a status value — it toggles
            showUnplacedOnly instead, a separate piece of state loadList()
            branches on. Hidden entirely (not just zero-count-hidden) for
            secondary schools, where studentStats.unplaced is undefined. */}
        {isHigherEd && typeof studentStats.unplaced === 'number' && studentStats.unplaced > 0 && (
          <button
            type="button"
            className={`stu-stat stu-stat--unplaced${showUnplacedOnly ? ' stu-stat--selected' : ''}`}
            onClick={() => setShowUnplacedOnly(prev => !prev)}
          >
            {studentStats.unplaced} unplaced
          </button>
        )}
      </div>
    )
  }


  // ─── Detail panel ──────────────────────────────────────────────────────────

  function renderDetailPanel() {
    if (!detailStudent) return null

    return (
      <div
        className="stu-form-overlay stu-detail-overlay"
        onClick={e => { if (e.target === e.currentTarget) closeDetail() }}
      >
        <div
          className="stu-detail-sheet"
          role="dialog"
          aria-modal
          aria-label={detailStudent.full_name}
        >
          {/* Detail header */}
          <div className="stu-detail-header">
            {/* Header avatar — the single source of truth for the photo in
                this popup (Brief's own copy removed, was disconnected and
                display-only anyway per the Session 21 note below). Photo
                resolution mirrors Info tab's stu-info-avatar exactly, keyed
                off the same photoUrls map. When a photo exists, renders as
                a button that opens the full-size lightbox; otherwise falls
                back to the plain initials div, unchanged from before. */}
            {detailStudent.photo_url && photoUrls.get(detailStudent.photo_url) ? (
              <button
                type="button"
                className="stu-detail-avatar stu-detail-avatar--photo"
                onClick={() => setPhotoPreviewOpen(true)}
                aria-label="View photo"
              >
                <img
                  className="stu-detail-avatar-img"
                  src={photoUrls.get(detailStudent.photo_url)}
                  alt=""
                />
              </button>
            ) : (
              <div className="stu-detail-avatar">
                {detailStudent.full_name.charAt(0).toUpperCase()}
              </div>
            )}
            <div className="stu-detail-title-wrap">
              <h3 className="stu-detail-name">{detailStudent.full_name}</h3>
              {/* PRD Tier 6 / Problem 6.10 — restyle target explicitly calls
                  for "avatar, name, class, code badge" at a glance in the
                  popup header, not two taps deep under Brief's "More
                  details" toggle (where student_code previously lived
                  alone). Class was already shown in Brief's Tier 1; this
                  row surfaces both together at the header level instead,
                  without removing either from Brief — same data, promoted
                  visibility, not a duplicate source of truth. */}
              {(detailStudent.class_path_label || detailStudent.student_code) && (
                <div className="stu-detail-meta-row">
                  {detailStudent.class_path_label && (
                    <span className="stu-detail-class-label">{detailStudent.class_path_label}</span>
                  )}
                  {detailStudent.student_code && (
                    <span className="stu-detail-code-badge">{detailStudent.student_code}</span>
                  )}
                </div>
              )}
              <span className={`stu-status-badge stu-status-badge--${detailStudent.status}`}>
                {statusLabel(detailStudent.status)}
              </span>
              {(() => {
                const b = canManageStudents ? obligationBadge(pendingObl.get(detailStudent.id)) : null
                return b ? <span className="obl-badge" title={b.title}>{b.label}</span> : null
              })()}
              {detailStudent.status === 'inactive' && detailStudent.deactivation_reason === 'attendance_auto' && (
                <span className="stu-attendance-auto-tag" title="Automatically set to inactive by the attendance rule">
                  Auto-deactivated (attendance)
                </span>
              )}
              {attendanceRiskInfo(detailStudent) === 'pending' && (
                <span className="stu-attendance-risk-tag stu-attendance-risk-tag--pending">
                  Attendance: pending deactivation
                </span>
              )}
              {/* Session 13 (PRD Problem 5.5) — role tags, "visible from
                  anywhere" per owner decision. Header-level so it's the same
                  row regardless of which subtab is open. Silent when empty/
                  loading/error — this is a nice-to-have display, not a state
                  that needs its own error UI competing with the tab content
                  below it. */}
              {roleTagsState === 'ready' && roleTags.length > 0 && (
                <div className="stu-role-tags" aria-label="Student roles">
                  {roleTags.map(r => (
                    <span key={r.id} className="stu-role-tag">{r.name}</span>
                  ))}
                </div>
              )}
            </div>
            {/* PRD Tier 6 / Problem 6.10 — print this one student's ID card.
                Admin-only per §4.10, reusing canManageStudents. Placed in
                the header (not a tab) so it's reachable regardless of which
                detail tab is open, same reasoning as the close button
                beside it. */}
            {canManageStudents && (
              <button
                className="stu-detail-print-btn"
                onClick={() => printSingleStudentIdCard(detailStudent)}
                aria-label="Print ID card"
                title="Print ID card"
              >
                <Icon name="printer" size={16} />
              </button>
            )}
            <button className="stu-form-close" onClick={closeDetail} aria-label="Close"><Icon name="x" size={16} /></button>
          </div>


          {/* Tab bar — SESSION 12 step 3: 'info' removed as a tab; its
              content (renderInfoTab) is now reached via the "Edit" button
              inside the Brief tab instead, gated on students.records.edit. */}
          <div className="stu-detail-tabs" role="tablist">
            {(['brief', 'guardians', 'status', ...(isHigherEd ? (['transcript'] as DetailTab[]) : [])] as DetailTab[]).map(tab => (
              <button
                key={tab}
                className={`stu-detail-tab${detailTab === tab ? ' stu-detail-tab--active' : ''}`}
                role="tab"
                aria-selected={detailTab === tab}
                onClick={() => switchDetailTab(tab)}
              >
                {tab === 'brief' ? 'Brief' : tab === 'guardians' ? 'Guardians' : tab === 'status' ? 'Status' : 'Transcript'}
              </button>
            ))}
          </div>

          {/* Tab content — the fixed-size/scroll-inside wrapper lives on
              .stu-detail-body itself (SESSION 12 step 2), so switching tabs
              (including into Edit) no longer resizes the sheet. */}
          <div className="stu-detail-body">
            {detailTab === 'brief' && renderBriefTab()}
            {detailTab === 'info' && renderInfoTab()}
            {detailTab === 'guardians' && renderGuardiansTab()}
            {detailTab === 'status' && renderStatusTab()}
            {detailTab === 'transcript' && isHigherEd && (
              <StudentTranscriptTab schoolName={schoolName} studentId={detailStudent.id} />
            )}
          </div>
        </div>

        {/* Full-size photo preview, opened by tapping the header avatar.
            Sibling of .stu-detail-sheet inside the same .stu-form-overlay,
            per the CSS's own stacking convention (z-index 60 vs the sheet's
            50). Click on the dimmed backdrop or the close button both
            dismiss it without closing the whole detail panel. */}
        {photoPreviewOpen && detailStudent.photo_url && photoUrls.get(detailStudent.photo_url) && (
          <div
            className="stu-photo-preview-overlay"
            onClick={e => { if (e.target === e.currentTarget) setPhotoPreviewOpen(false) }}
          >
            <button
              type="button"
              className="stu-photo-preview-close"
              onClick={() => setPhotoPreviewOpen(false)}
              aria-label="Close preview"
            >
              <Icon name="x" size={20} />
            </button>
            <img
              className="stu-photo-preview-img"
              src={photoUrls.get(detailStudent.photo_url)}
              alt={detailStudent.full_name}
            />
          </div>
        )}
      </div>
    )
  }

  // ─── Brief tab (at-a-glance triage view) ───────────────────────────────────
  //
  // Layout intent (see design note in studentsService.ts for AttendanceSummary):
  //   Tier 1 (always visible, top): status, attendance %, performance.
  //     These are the "is something wrong right now" signals.
  //   Tier 2 ("More details", collapsed by default): DOB, gender, admission
  //     date, record created date — lower-urgency reference info.
  //   This structure is deliberately built to extend cleanly once medical
  //   notes, blood group, address, student code, and emergency contact are
  //   added next session: medical/blood group join Tier 1 (they're safety-
  //   critical), address/contact/student code join Tier 2.

  function renderBriefTab() {
    if (!detailStudent) return null
    const s = detailStudent
    const isTransferred =
      s.status === 'transferred_out' || s.status === 'transferred_in_pending'

    return (
      <div className="stu-detail-tab-content">

        {briefSuccessMsg && (
          <p className="stu-brief-success" role="status"><Icon name="circle-check" size={16} style={{ color: 'var(--color-success, #16a34a)' }} /> {briefSuccessMsg}</p>
        )}

        {/* Photo moved to the popup header (single source of truth, click-
            to-preview) — Brief no longer renders its own copy. See the
            header avatar block above for the current photo logic. */}

        {/* SESSION 12 step 3 — Info is no longer its own tab. Editing is
            reached explicitly from here, gated on the real permission key
            (students.records.edit — the same catalog key that already
            disables every individual field inside renderInfoTab()), not on
            isAdmin. A non-editor simply doesn't see this button — nothing
            to tap into that would just show disabled fields. */}
        {canEditStudentRecords && !isTransferred && (
          <button
            type="button"
            className="stu-brief-edit-btn"
            onClick={() => switchDetailTab('info')}
          >
            Edit student record
          </button>
        )}

        {/* Tier 1 — at-a-glance */}
        <div className="stu-brief-tier1">
          <div className="stu-brief-stat-row">
            <div className="stu-brief-stat">
              <span className="stu-brief-stat-label">Attendance</span>
              {isHigherEd ? (
                overallAttendanceState === 'loading' || overallAttendanceState === 'booting' ? (
                  <span className="stu-brief-stat-skel skeleton" />
                ) : overallAttendanceState === 'error' ? (
                  <span className="stu-brief-stat-value stu-brief-stat-value--muted">—</span>
                ) : overallAttendance && overallAttendance.percent !== null ? (
                  // 75% is a visual warn cue only, matching the secondary
                  // side's own convention — this is a cross-course rollup,
                  // not any one offering's configured eligibility
                  // threshold (each course_offering can set its own via
                  // attendance_eligibility_threshold_pct; see Course
                  // Attendance for the per-course, threshold-aware figure).
                  <span className={`stu-brief-stat-value${overallAttendance.percent < 75 ? ' stu-brief-stat-value--warn' : ''}`}>
                    {overallAttendance.percent}%
                  </span>
                ) : (
                  <span className="stu-brief-stat-value stu-brief-stat-value--muted">No sessions yet</span>
                )
              ) : briefState === 'loading' || briefState === 'booting' ? (
                <span className="stu-brief-stat-skel skeleton" />
              ) : briefState === 'error' ? (
                <span className="stu-brief-stat-value stu-brief-stat-value--muted">—</span>
              ) : attendanceSummary && attendanceSummary.percent !== null ? (
                <span className={`stu-brief-stat-value${attendanceSummary.percent < 75 ? ' stu-brief-stat-value--warn' : ''}`}>
                  {attendanceSummary.percent}%
                </span>
              ) : (
                <span className="stu-brief-stat-value stu-brief-stat-value--muted">No records yet</span>
              )}
              {isHigherEd && overallAttendance && overallAttendance.totalSessions > 0 && (
                <span className="stu-brief-stat-sub">
                  {overallAttendance.presentCount} of {overallAttendance.totalSessions} sessions attended
                  {overallAttendance.courseCount > 0 ? ` · across ${overallAttendance.courseCount} course${overallAttendance.courseCount === 1 ? '' : 's'}` : ''}
                </span>
              )}
              {!isHigherEd && attendanceSummary && (attendanceSummary.present + attendanceSummary.absent + attendanceSummary.late + attendanceSummary.excused) > 0 && (
                <span className="stu-brief-stat-sub">
                  {attendanceSummary.present} present · {attendanceSummary.absent} absent · {attendanceSummary.late} late
                  {attendanceSummary.excused > 0 ? ` · ${attendanceSummary.excused} excused` : ''}
                </span>
              )}
            </div>

            <div className="stu-brief-stat">
              <span className="stu-brief-stat-label">Performance</span>
              {isHigherEd ? (
                cgpaState === 'loading' || cgpaState === 'booting' ? (
                  <span className="stu-brief-stat-skel skeleton" />
                ) : cgpaState === 'error' ? (
                  <span className="stu-brief-stat-value stu-brief-stat-value--muted">Couldn't load</span>
                ) : cgpaValue !== null && cgpaValue !== undefined ? (
                  <>
                    <span className="stu-brief-stat-value">{cgpaValue.toFixed(2)} CGPA</span>
                    <span className="stu-brief-stat-sub">See the transcript tab for full breakdown</span>
                  </>
                ) : (
                  <>
                    <span className="stu-brief-stat-value stu-brief-stat-value--muted">No scores yet</span>
                    <span className="stu-brief-stat-sub">See the transcript tab once results are published</span>
                  </>
                )
              ) : (
                <>
                  <span className="stu-brief-stat-value stu-brief-stat-value--muted">Not yet available</span>
                  <span className="stu-brief-stat-sub">See the Results module for subject scores</span>
                </>
              )}
            </div>
          </div>

          {!isHigherEd && briefState === 'error' && (
            <p className="stu-status-note stu-status-note--error">
              Couldn't load attendance data. <button className="stu-inline-retry" onClick={() => fetchBrief(s.id)}>Retry</button>
            </p>
          )}
          {isHigherEd && cgpaState === 'error' && (
            <p className="stu-status-note stu-status-note--error">
              Couldn't load performance data. <button className="stu-inline-retry" onClick={() => fetchBrief(s.id)}>Retry</button>
            </p>
          )}
          {isHigherEd && overallAttendanceState === 'error' && (
            <p className="stu-status-note stu-status-note--error">
              Couldn't load attendance data. <button className="stu-inline-retry" onClick={() => fetchBrief(s.id)}>Retry</button>
            </p>
          )}

          {isHigherEd ? (
            <div className="stu-brief-fact-row">
              <span className="stu-brief-fact-label">Programme / Level</span>
              {placementState === 'loading' || placementState === 'booting' ? (
                <span className="stu-brief-stat-skel skeleton" />
              ) : placementState === 'error' ? (
                <span className="stu-brief-fact-value">Couldn't load</span>
              ) : currentPlacement ? (
                <span className="stu-brief-fact-value">
                  {currentPlacement.programme_name} — {currentPlacement.level_label}
                </span>
              ) : (
                <span className="stu-brief-fact-value">Not yet admitted</span>
              )}
            </div>
          ) : (
            <div className="stu-brief-fact-row">
              <span className="stu-brief-fact-label">Class</span>
              <span className="stu-brief-fact-value">{s.class_path_label ?? 'Not assigned'}</span>
            </div>
          )}
          <div className="stu-brief-fact-row">
            <span className="stu-brief-fact-label">Status</span>
            {isHigherEd ? (
              <span className={`stu-status-badge stu-status-badge--${currentPlacement ? 'active' : 'inactive'}`}>
                {currentPlacement ? 'Active' : 'Not yet admitted'}
              </span>
            ) : (
              <span className={`stu-status-badge stu-status-badge--${s.status}`}>{statusLabel(s.status)}</span>
            )}
          </div>

          {/* Session 14 — blood_group/medical_notes are now wired (they
              already existed live per §7.8, just weren't surfaced).
              Session 16: owner asked for the actual note text on Brief, not
              a "see Edit" flag — medical info is safety-relevant, worth
              showing at a glance rather than requiring an extra tap. */}
          <div className="stu-brief-fact-row">
            <span className="stu-brief-fact-label">Blood group</span>
            <span className="stu-brief-fact-value">{s.blood_group ?? 'Not recorded'}</span>
          </div>
          {s.medical_notes && (
            <div className="stu-brief-medical-notes">
              <span className="stu-brief-fact-label"><Icon name="stethoscope" size={14} /> Medical notes</span>
              <p className="stu-brief-medical-notes-text">{s.medical_notes}</p>
            </div>
          )}

          {/* Student portal login — gated on students.portal.manage_access */}
          {canManagePortalAccess && (
            <div className="stu-provision-section">
              {studentIdentity === undefined && (
                <span className="stu-brief-stat-skel skeleton" />
              )}

              {/* Already provisioned */}
              {studentIdentity && !studentProvisioning && (
                <div className="stu-provision-status">
                  <span className="stu-provision-method-badge"><Icon name="key" size={14} /> Login code</span>
                  {studentIdentity.login_code ? (
                    <span className="stu-provision-code">{studentIdentity.login_code}</span>
                  ) : (
                    <span className="stu-provision-code-unavailable">Code not available — try Regenerate</span>
                  )}
                  <button className="stu-provision-change-btn" onClick={openStudentProvision}>
                    Regenerate
                  </button>
                </div>
              )}

              {/* Not yet provisioned */}
              {studentIdentity === null && !studentProvisioning && (
                <div className="stu-provision-status">
                  <span className="stu-provision-unprov">No login set up yet</span>
                  <button className="stu-provision-btn" onClick={openStudentProvision}>
                    Set up login →
                  </button>
                </div>
              )}

              {/* Provision form */}
              {studentProvisioning && (
                <div className="stu-provision-form">
                  <p className="stu-provision-form-title">
                    {studentIdentity ? 'Regenerate login code for' : 'Set up login for'} {s.full_name}
                  </p>
                  <p className="stu-provision-method-hint">
                    A unique login code will be generated. Give it to the student to sign in.
                  </p>

                  {studentProvisionError && (
                    <p className="stu-form-error" role="alert">{studentProvisionError}</p>
                  )}

                  <div className="stu-provision-form-footer">
                    <button className="stu-cancel-btn" onClick={closeStudentProvision} disabled={studentProvisionSaving}>
                      Cancel
                    </button>
                    <button
                      className="stu-save-btn"
                      onClick={() => handleProvisionStudent(s.id, !!studentIdentity)}
                      disabled={studentProvisionSaving}
                    >
                      {studentProvisionSaving ? 'Setting up…' : studentIdentity ? 'Regenerate code' : 'Generate code'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Tier 2 — more details, collapsed by default */}
        <button
          className="stu-brief-more-toggle"
          onClick={() => setMoreDetailsOpen(o => !o)}
          aria-expanded={moreDetailsOpen}
        >
          {moreDetailsOpen ? '▾' : '▸'} More details
        </button>

        {moreDetailsOpen && (
          <div className="stu-brief-tier2">
            {s.student_code && (
              <div className="stu-brief-fact-row">
                <span className="stu-brief-fact-label">Student code</span>
                <span className="stu-brief-fact-value stu-brief-code">{s.student_code}</span>
              </div>
            )}
            <div className="stu-brief-fact-row">
              <span className="stu-brief-fact-label">Gender</span>
              <span className="stu-brief-fact-value">{s.gender ?? '—'}</span>
            </div>
            <div className="stu-brief-fact-row">
              <span className="stu-brief-fact-label">Date of birth</span>
              <span className="stu-brief-fact-value">{s.date_of_birth ? formatDate(s.date_of_birth) : '—'}</span>
            </div>
            <div className="stu-brief-fact-row">
              <span className="stu-brief-fact-label">Admission date</span>
              <span className="stu-brief-fact-value">{s.admission_date ? formatDate(s.admission_date) : '—'}</span>
            </div>
            {/* Session 16 — these five were added to the schema/Edit form in
                Session 14 but never actually surfaced anywhere on Brief,
                despite the original Tier-2 design note explicitly planning
                for it. Closing that gap now. Email/phone/address/hobbies
                render only when present, same "no empty placeholder" rule
                as the rest of this tab; emergency contact renders as one
                combined row (name + phone) only when at least the name is
                set, since a phone number with no name isn't useful on its
                own. */}
            {s.email && (
              <div className="stu-brief-fact-row">
                <span className="stu-brief-fact-label">Email</span>
                <span className="stu-brief-fact-value">{s.email}</span>
              </div>
            )}
            {s.phone && (
              <div className="stu-brief-fact-row">
                <span className="stu-brief-fact-label">Phone</span>
                <span className="stu-brief-fact-value">{s.phone}</span>
              </div>
            )}
            {s.address && (
              <div className="stu-brief-fact-row">
                <span className="stu-brief-fact-label">Address</span>
                <span className="stu-brief-fact-value">{s.address}</span>
              </div>
            )}
            {s.hobbies && (
              <div className="stu-brief-fact-row">
                <span className="stu-brief-fact-label">Hobbies</span>
                <span className="stu-brief-fact-value">{s.hobbies}</span>
              </div>
            )}
            {s.emergency_contact_name && (
              <div className="stu-brief-fact-row">
                <span className="stu-brief-fact-label">Emergency contact</span>
                <span className="stu-brief-fact-value">
                  {s.emergency_contact_name}
                  {s.emergency_contact_phone ? ` · ${s.emergency_contact_phone}` : ''}
                </span>
              </div>
            )}
            <div className="stu-brief-fact-row">
              <span className="stu-brief-fact-label">Record created</span>
              <span className="stu-brief-fact-value">{formatDate(s.created_at)}</span>
            </div>
          </div>
        )}
      </div>
    )
  }

  // ─── Info tab (edit form) ──────────────────────────────────────────────────

  function renderInfoTab() {
    const isTransferred =
      detailStudent?.status === 'transferred_out' ||
      detailStudent?.status === 'transferred_in_pending'

    return (
      <>
        <div className="stu-form-body">
          {/* SESSION 12 step 3 — Info is reached from Brief via "Edit student
              record", not from the tab bar, so it needs its own way back
              rather than relying on the (now-hidden) tab switcher. */}
          <button
            type="button"
            className="stu-info-back-link"
            onClick={() => switchDetailTab('brief')}
          >
            ← Back to Brief
          </button>

          {/* Session 21 — the only upload entry point (Brief's is
              display-only, owner decision). Circle + separate "Change
              photo" link rather than making the whole circle the tap
              target, so upload state (uploading/error) has a natural home
              beneath it instead of crowding the circle itself. Hidden
              file input triggered via photoInputRef so the visible
              control can be plain text, not a native file-picker button. */}
          {detailStudent && (
            <div className="stu-info-avatar-section">
              <div className="stu-info-avatar" aria-hidden>
                {detailStudent.photo_url && photoUrls.get(detailStudent.photo_url) ? (
                  <img
                    className="stu-info-avatar-img"
                    src={photoUrls.get(detailStudent.photo_url)}
                    alt=""
                  />
                ) : (
                  detailStudent.full_name.charAt(0).toUpperCase()
                )}
              </div>
              {canEditStudentRecords && !isTransferred && (
                <>
                  <input
                    ref={photoInputRef}
                    type="file"
                    accept="image/*"
                    className="stu-info-avatar-input"
                    onChange={handlePhotoSelected}
                  />
                  <button
                    type="button"
                    className="stu-info-avatar-change-btn"
                    onClick={() => photoInputRef.current?.click()}
                    disabled={photoUploading}
                  >
                    {photoUploading ? 'Uploading…' : 'Change photo'}
                  </button>
                  {photoError && (
                    <p className="stu-form-error" role="alert">{photoError}</p>
                  )}
                </>
              )}
            </div>
          )}

          {isTransferred && (
            <p className="stu-detail-readonly-notice">
              This student's record is locked after transfer. Contact support if a correction is needed.
            </p>
          )}

          <div className="stu-field">
            <label className="stu-label" htmlFor="stu-name">
              Full name <span className="stu-required">*</span>
            </label>
            <input
              id="stu-name"
              ref={nameInputRef}
              className="stu-input"
              type="text"
              placeholder="e.g. Amina Ibrahim"
              value={form.full_name}
              onChange={e => setField('full_name', e.target.value)}
              disabled={!canEditStudentRecords || isTransferred}
              autoComplete="off"
            />
          </div>

          <div className="stu-field">
            <label className="stu-label" htmlFor="stu-class">Class</label>
            <select
              id="stu-class"
              className="stu-select"
              value={form.class_node_id}
              onChange={e => setField('class_node_id', e.target.value)}
              disabled={!canEditStudentRecords || isTransferred}
            >
              <option value="">— not yet assigned —</option>
              {classes.map(c => (
                <option key={c.id} value={c.id}>{c.path_label}</option>
              ))}
            </select>
          </div>

          <div className="stu-field">
            <label className="stu-label" htmlFor="stu-gender">Gender</label>
            <select
              id="stu-gender"
              className="stu-select"
              value={form.gender}
              onChange={e => setField('gender', e.target.value)}
              disabled={!canEditStudentRecords || isTransferred}
            >
              <option value="">— not specified —</option>
              <option value="Male">Male</option>
              <option value="Female">Female</option>
            </select>
          </div>

          <div className="stu-field">
            <label className="stu-label" htmlFor="stu-dob">Date of birth</label>
            <input
              id="stu-dob"
              className="stu-input"
              type="date"
              max={todayDateString()}
              value={form.date_of_birth}
              onChange={e => setField('date_of_birth', e.target.value)}
              disabled={!canEditStudentRecords || isTransferred}
            />
          </div>

          <div className="stu-field">
            <label className="stu-label" htmlFor="stu-admission">Admission date</label>
            <input
              id="stu-admission"
              className="stu-input"
              type="date"
              max={todayDateString()}
              value={form.admission_date}
              onChange={e => setField('admission_date', e.target.value)}
              disabled={!canEditStudentRecords || isTransferred}
            />
          </div>

          <div className="stu-field">
            {/* Session 4 defect log flagged this as a second, confusing
               "code generator" that looked like it might duplicate or
               conflict with the login-code flow in the Brief tab. Confirmed
               (Session 7c follow-up) they're unrelated: this is a
               school-issued ID/roll number for registers and ID cards, with
               no server call and no connection to authentication. The
               actual problem was labeling — "Student code" sitting near
               "Login code" elsewhere in the same panel. Renamed and the
               hint text made explicit rather than changing any behavior. */}
            <label className="stu-label" htmlFor="stu-code">Student ID number (not a login code)</label>
            <div className="stu-code-row">
              <input
                id="stu-code"
                className="stu-input stu-input--code"
                type="text"
                placeholder="e.g. STU-0042 (optional)"
                value={form.student_code}
                onChange={e => setField('student_code', e.target.value.toUpperCase())}
                disabled={!canEditStudentRecords || isTransferred}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <p className="stu-field-hint">
              Used for registers and ID cards only — has nothing to do with the student's portal login code (set up separately, in the Brief tab).
            </p>
          </div>

          {/* Session 14 (owner request — "more detail space" in the Edit
              subtab). blood_group/address/medical_notes/emergency_contact_*
              already existed live (§7.8, Session 27) but were never
              surfaced anywhere; hobbies/email/phone are new columns
              (migration_session_14). Grouped under one section label rather
              than mixed into the fields above, since these are a distinct
              "extra detail" category the owner asked for as a set, not
              incremental additions to the core identity fields above. */}
          <p className="stu-section-divider">Additional details</p>

          <div className="stu-field">
            <label className="stu-label" htmlFor="stu-address">Address</label>
            <textarea
              id="stu-address"
              className="stu-textarea"
              placeholder="Home address"
              value={form.address}
              onChange={e => setField('address', e.target.value)}
              disabled={!canEditStudentRecords || isTransferred}
              rows={2}
            />
          </div>

          <div className="stu-field">
            <label className="stu-label" htmlFor="stu-email">Email (optional)</label>
            <input
              id="stu-email"
              className="stu-input"
              type="email"
              placeholder="student@example.com"
              value={form.email}
              onChange={e => setField('email', e.target.value)}
              disabled={!canEditStudentRecords || isTransferred}
              autoComplete="off"
            />
          </div>

          <div className="stu-field">
            <label className="stu-label" htmlFor="stu-phone">Phone (optional)</label>
            <input
              id="stu-phone"
              className="stu-input"
              type="tel"
              placeholder="e.g. 080…"
              value={form.phone}
              onChange={e => setField('phone', e.target.value)}
              disabled={!canEditStudentRecords || isTransferred}
              autoComplete="off"
            />
          </div>

          <div className="stu-field">
            <label className="stu-label" htmlFor="stu-hobbies">Hobbies</label>
            <input
              id="stu-hobbies"
              className="stu-input"
              type="text"
              placeholder="e.g. Football, reading, chess"
              value={form.hobbies}
              onChange={e => setField('hobbies', e.target.value)}
              disabled={!canEditStudentRecords || isTransferred}
              autoComplete="off"
            />
          </div>

          <div className="stu-field">
            <label className="stu-label" htmlFor="stu-blood">Blood group</label>
            <select
              id="stu-blood"
              className="stu-select"
              value={form.blood_group}
              onChange={e => setField('blood_group', e.target.value)}
              disabled={!canEditStudentRecords || isTransferred}
            >
              <option value="">— not recorded —</option>
              {['O+', 'O-', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-'].map(bg => (
                <option key={bg} value={bg}>{bg}</option>
              ))}
            </select>
          </div>

          <div className="stu-field">
            <label className="stu-label" htmlFor="stu-medical">Medical notes</label>
            <textarea
              id="stu-medical"
              className="stu-textarea"
              placeholder="Allergies, conditions, or anything staff should know"
              value={form.medical_notes}
              onChange={e => setField('medical_notes', e.target.value)}
              disabled={!canEditStudentRecords || isTransferred}
              rows={3}
            />
          </div>

          <div className="stu-field">
            <label className="stu-label" htmlFor="stu-ec-name">Emergency contact name</label>
            <input
              id="stu-ec-name"
              className="stu-input"
              type="text"
              placeholder="e.g. Mrs. Ibrahim"
              value={form.emergency_contact_name}
              onChange={e => setField('emergency_contact_name', e.target.value)}
              disabled={!canEditStudentRecords || isTransferred}
              autoComplete="off"
            />
          </div>

          <div className="stu-field">
            <label className="stu-label" htmlFor="stu-ec-phone">Emergency contact phone</label>
            <input
              id="stu-ec-phone"
              className="stu-input"
              type="tel"
              placeholder="e.g. 080…"
              value={form.emergency_contact_phone}
              onChange={e => setField('emergency_contact_phone', e.target.value)}
              disabled={!canEditStudentRecords || isTransferred}
              autoComplete="off"
            />
          </div>

          {formError && (
            <p className="stu-form-error" role="alert">{formError}</p>
          )}

          {/* Session 13 (PRD Problem 5.5) — role assignment. Deliberately
              NOT part of the form/handleSubmit save flow: each toggle below
              calls assignStudentRole/unassignStudentRole directly and takes
              effect immediately, the same way the Guardians tab's
              access-toggle and unlink buttons work — a "Save changes" tap
              is not needed and would be misleading if implied here. Options
              are pre-filtered server-round-trip-side to school-wide +
              this student's own class (PRD step 4) — a JSS1B-scoped role
              never appears in this list for a JSS1A student. Gated on
              students.records.manage, same key as the rest of this
              module's "manage a student's standing" actions (status
              change, transfer) rather than .records.edit, since assigning a
              role is closer to that class of action than to editing a
              field on the record itself. */}
          {canManageStudents && !isTransferred && (
            <div className="stu-field stu-roles-section">
              <label className="stu-label">Student roles</label>

              {assignableRolesState === 'booting' || assignableRolesState === 'loading' ? (
                <p className="stu-field-hint">Loading roles…</p>
              ) : assignableRolesState === 'error' ? (
                <p className="stu-form-error">
                  Couldn't load roles.{' '}
                  <button type="button" className="stu-inline-retry" onClick={() => detailStudent && fetchAssignableRoles(detailStudent)}>
                    Retry
                  </button>
                </p>
              ) : assignableRoles.length === 0 ? (
                <p className="stu-field-hint">
                  No student roles defined for this school yet — add some in Settings → Student roles.
                </p>
              ) : (
                <div className="stu-role-picker" role="group" aria-label="Student roles">
                  {assignableRoles.map(role => (
                    <button
                      type="button"
                      key={role.id}
                      className={`stu-role-pill${role.assigned ? ' stu-role-pill--active' : ''}`}
                      onClick={() => handleToggleRole(role)}
                      disabled={roleTogglingId === role.id}
                      aria-pressed={role.assigned}
                    >
                      {roleTogglingId === role.id ? '…' : role.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {canEditStudentRecords && !isTransferred && (
          <div className="stu-form-footer">
            <button className="stu-cancel-btn" onClick={closeDetail} disabled={formSaving}>
              Close
            </button>
            <button className="stu-save-btn" onClick={handleSubmit} disabled={formSaving}>
              {formSaving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        )}

        {(!canEditStudentRecords || isTransferred) && (
          <div className="stu-form-footer">
            <button className="stu-cancel-btn" onClick={closeDetail}>Close</button>
          </div>
        )}
      </>
    )
  }

  // ─── Guardians tab ────────────────────────────────────────────────────────

function renderGuardiansTab() {
    return (
      <div className="stu-detail-tab-content">

        {/* SESSION 11 item 3 — removed 2026-07-02 (owner-reported redundancy).
            History: original delivery labeled this "← Back to Guardians"
            but wired it to onNavigate('guardians'), which exited the
            student's detail sheet entirely — a sideways teleport, not a
            "back." That was fixed to setDetailTab('brief') so it stayed
            inside the same detail sheet. But once the guardian-brief
            popup redesign landed, this subtab is reached the same way as
            Brief/Info/Status — via the normal tab switcher a few lines up
            in the detail sheet — so a dedicated "return to Brief" button
            duplicates navigation already one tap away on the same screen.
            Removed entirely, not relabeled again. The top-level Guardians
            module is still reachable from here when genuinely needed, via
            "Edit in Guardians module →" inside the brief popup
            (renderGuardianBrief()) and via each guardian's own
            name-triggered brief — not via a standalone back link. */}

        {/* Unlink confirmation */}
        {unlinkTarget && (
          <div className="stu-confirm-banner">
            <p className="stu-confirm-text">
              Remove {unlinkTarget.full_name} as guardian? This will also remove their platform access.
            </p>
            <div className="stu-confirm-actions">
              <button className="stu-confirm-cancel" onClick={() => setUnlinkTarget(null)} disabled={unlinkSaving}>Keep</button>
              <button className="stu-confirm-danger" onClick={handleUnlink} disabled={unlinkSaving}>
                {unlinkSaving ? 'Removing…' : 'Remove'}
              </button>
            </div>
          </div>
        )}

        {guardiansError && (
          <p className="stu-form-error" role="alert">{guardiansError}</p>
        )}

        {(guardiansState === 'loading' || guardiansState === 'booting') && (
          <div className="stu-list-skel">
            {[1,2].map(i => <div key={i} className="stu-guardian-skel skeleton" />)}
          </div>
        )}

        {guardiansState === 'error' && (
          <div className="stu-error-state">
            <span className="stu-error-icon"><Icon name="alert-triangle" style={{ color: 'var(--color-warning, #d97706)' }} /></span>
            <p className="stu-error-msg">{guardiansError}</p>
            <button className="stu-retry-btn" onClick={() => detailStudent && fetchGuardians(detailStudent.id)}>Retry</button>
          </div>
        )}

        {guardiansState === 'empty' && (
          <div className="stu-empty-state">
            <span className="stu-empty-icon"><Icon name="users" /></span>
            <p className="stu-empty-msg">No guardians linked yet.</p>
          </div>
        )}

        {guardiansState === 'ready' && (
          <ul className="stu-guardian-list">
            {guardians.map(link => {
              return (
                <li key={link.guardian_id} className="stu-guardian-row">
                  <div className="stu-guardian-info">
                    {/* Owner-reported bug fix, 2026-07-02: this used to call
                        onNavigate('guardians', { guardianId }), jumping out
                        of this student's detail sheet into the standalone
                        Guardians module with no way back to this exact
                        subtab. Now opens an in-place brief popup instead —
                        no navigation away at all, so there's nothing to
                        "come back" from. Always rendered as a real button
                        now (previously gated on `onNavigate` being present,
                        since that was the only way it could do anything) —
                        the brief popup has no such dependency. */}
                    <button
                      type="button"
                      className="stu-guardian-name stu-guardian-name--link"
                      onClick={() => openGuardianBrief(link.guardian_id)}
                    >
                      {link.full_name}
                    </button>
                    {link.relationship && <span className="stu-guardian-meta">{link.relationship}</span>}
                    {link.phone && <span className="stu-guardian-meta">{link.phone}</span>}
                    {link.email && <span className="stu-guardian-meta">{link.email}</span>}
                  </div>

                  {(canManagePortalAccess || canEditStudentRecords) && (
                    <div className="stu-guardian-actions">
                      {canManagePortalAccess && (
                        <button
                          className={`stu-access-btn${link.has_platform_access ? ' stu-access-btn--on' : ''}`}
                          onClick={() => {
                            handleToggleAccess(link)
                            // Load identity when granting access so we know if already provisioned
                            if (!link.has_platform_access && identities[link.guardian_id] === undefined) {
                              fetchGuardianIdentity(link.guardian_id)
                            }
                          }}
                          title={link.has_platform_access ? 'Remove portal access' : 'Grant portal access'}
                        >
                          <Icon name={link.has_platform_access ? 'lock-open' : 'lock'} size={14} /> {link.has_platform_access ? 'Access on' : 'No access'}
                        </button>
                      )}
                      {canEditStudentRecords && (
                        <button
                          className="stu-unlink-btn"
                          onClick={() => setUnlinkTarget(link)}
                          title="Remove guardian link"
                          aria-label="Remove guardian link"
                        >
                          <Icon name="x" size={14} />
                        </button>
                      )}
                    </div>
                  )}

                  {/* Owner request, 2026-07-02: the login-code provisioning
                      card used to live here, inline in the list row. It's
                      been moved into the guardian brief popup (opened by
                      tapping the guardian's name above) — see
                      renderGuardianBrief(). Two reasons: (1) the code
                      shouldn't be visible in the list at a glance, only when
                      an admin deliberately opens the guardian's details; (2)
                      the card's compact/form-state swap was causing visible
                      resize jumps in the tightly-packed list row — inside the
                      popup it has room for a fixed-height wrapper instead so
                      it no longer jumps. The row-scoped `identity` /
                      `isProvisioning` locals that used to feed this card were
                      removed too — nothing else in the row read them, the
                      access-toggle handler above reads identities[...]
                      directly. */}
                </li>
              )
            })}
          </ul>
        )}

        {/* ── Add guardian entry point ──
            SESSION 4 defect #1 fix: gated on guardiansState being settled
            ('empty' or 'ready'), not rendered unconditionally alongside the
            list. Previously this button was reachable during 'booting'/
            'loading', so a fast admin could tap into the add-guardian flow
            before the existing-guardian lookup resolved — risking a
            duplicate guardian record for a student who already has one.
            Now the entry point simply isn't there until the lookup settles. */}
        {canEditStudentRecords && (guardiansState === 'empty' || guardiansState === 'ready') && !guardianFormOpen && !guardianSearchMode && (
          <div className="stu-detail-tab-footer">
            <button className="stu-add-guardian-btn" onClick={() => {
              setGuardianSearchMode(true)
              setGuardianSearchQ('')
              setGuardianSearchRes([])
              setGuardianError('')
            }}>
              + Add guardian
            </button>
          </div>
        )}

        {/* ── Step 1: search for existing guardian ── */}
        {guardianSearchMode && canEditStudentRecords && !guardianFormOpen && (
          <div className="stu-guardian-form">
            <p className="stu-guardian-form-title">Add guardian</p>
            <p className="stu-guardian-search-hint">Search first — if the guardian is already in the system, link them instead of creating a duplicate.</p>

            <div className="stu-field">
              <label className="stu-label">Search by name or phone</label>
              <input
                className="stu-input"
                type="text"
                placeholder="e.g. Aisha Musa or 0801…"
                value={guardianSearchQ}
                onChange={e => handleGuardianSearchChange(e.target.value)}
                autoFocus
              />
            </div>

            {guardianSearching && <p className="stu-guardian-search-status">Searching…</p>}

            {guardianSearchRes.length > 0 && (
              <ul className="stu-guardian-search-results">
                {guardianSearchRes.map(g => (
                  <li key={g.id} className="stu-guardian-search-row">
                    <div className="stu-guardian-search-info">
                      <span className="stu-guardian-name">{g.full_name}</span>
                      <span className="stu-guardian-meta">
                        {[g.phone, g.student_count > 0 ? `${g.student_count} student${g.student_count !== 1 ? 's' : ''}` : null]
                          .filter(Boolean).join(' · ')}
                      </span>
                    </div>
                    <button
                      className="stu-save-btn stu-guardian-link-btn"
                      onClick={() => handleLinkExistingGuardian(g.id)}
                      disabled={guardianLinkSaving}
                    >
                      {guardianLinkSaving ? '…' : 'Link'}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {!guardianSearching && guardianSearchQ.trim() && guardianSearchRes.length === 0 && (
              <p className="stu-guardian-search-status">No match found — create a new guardian below.</p>
            )}

            {guardianError && <p className="stu-form-error" role="alert">{guardianError}</p>}

            <div className="stu-guardian-form-footer">
              <button className="stu-cancel-btn" onClick={() => {
                setGuardianSearchMode(false)
                setGuardianSearchQ('')
                setGuardianSearchRes([])
                setGuardianError('')
              }}>
                Cancel
              </button>
              <button className="stu-save-btn" onClick={() => {
                setGuardianSearchMode(false)
                openGuardianForm()
              }}>
                + Create new
              </button>
            </div>
          </div>
        )}

        {/* ── Step 2: create new guardian form ── */}
        {guardianFormOpen && canEditStudentRecords && (
          <div className="stu-guardian-form">
            <p className="stu-guardian-form-title">New guardian</p>
            <div className="stu-field">
              <label className="stu-label" htmlFor="g-name">Full name <span className="stu-required">*</span></label>
              <input id="g-name" ref={guardianNameRef} className="stu-input" type="text"
                placeholder="e.g. Fatima Ibrahim" value={guardianForm.full_name}
                onChange={e => setGuardianForm(f => ({ ...f, full_name: e.target.value }))} autoComplete="off" />
            </div>
            <div className="stu-field">
              <label className="stu-label" htmlFor="g-relationship">Relationship</label>
              <select id="g-relationship" className="stu-select" value={guardianForm.relationship}
                onChange={e => setGuardianForm(f => ({ ...f, relationship: e.target.value }))}>
                <option value="">— not specified —</option>
                <option value="Mother">Mother</option>
                <option value="Father">Father</option>
                <option value="Guardian">Guardian</option>
                <option value="Sibling">Sibling</option>
                <option value="Other">Other</option>
              </select>
            </div>
            <div className="stu-field">
              <label className="stu-label" htmlFor="g-phone">Phone</label>
              <input id="g-phone" className="stu-input" type="tel" inputMode="numeric"
                placeholder="e.g. 08012345678" value={guardianForm.phone}
                onChange={e => setGuardianForm(f => ({ ...f, phone: e.target.value }))} />
            </div>
            <div className="stu-field">
              <label className="stu-label" htmlFor="g-email">Email</label>
              <input id="g-email" className="stu-input" type="email" inputMode="email"
                placeholder="optional" value={guardianForm.email}
                onChange={e => setGuardianForm(f => ({ ...f, email: e.target.value }))} />
            </div>
            {guardianError && <p className="stu-form-error" role="alert">{guardianError}</p>}
            <div className="stu-guardian-form-footer">
              <button className="stu-cancel-btn" onClick={closeGuardianForm} disabled={guardianSaving}>Cancel</button>
              <button className="stu-save-btn" onClick={handleAddGuardian} disabled={guardianSaving}>
                {guardianSaving ? 'Saving…' : 'Add guardian'}
              </button>
            </div>
          </div>
        )}
      </div>
    )
  }

  // ─── Status tab ───────────────────────────────────────────────────────────

  function renderStatusTab() {
    if (!detailStudent) return null
    const s = detailStudent.status
    const isTransferred = s === 'transferred_out' || s === 'transferred_in_pending'

    return (
      <div className="stu-detail-tab-content">

        {/* Current status */}
        <div className="stu-status-section">
          <p className="stu-status-section-label">Current status</p>
          {isHigherEd && !isTransferred ? (
            <>
              <span className={`stu-status-badge stu-status-badge--${currentPlacement ? 'active' : 'inactive'} stu-status-badge--lg`}>
                {currentPlacement ? 'Active' : 'Not yet admitted'}
              </span>
              <p className="stu-status-note">
                Derived from this student's current programme placement — not manually set.
                {currentPlacement ? ' To change it, update their placement instead.' : ''}
              </p>
              {/* Problem 9.8 (Tier 9) — this used to be static, unactionable
                  copy ("Admit this student into a programme/level to make
                  them active") with no control anywhere to actually do it.
                  Real "Assign to level" action added here: only shown once
                  placementState has genuinely settled to 'ready' with no
                  current placement (never mid-fetch, and never for a
                  student who already has one — see the note above for that
                  case instead), and only for someone with edit rights,
                  matching this file's canEditStudentRecords gate used
                  elsewhere for write actions. */}
              {placementState === 'ready' && !currentPlacement && canEditStudentRecords && (
                assignPanelOpen ? (
                  <div className="stu-assign-panel">
                    <div className="stu-field">
                      <label className="stu-label" htmlFor="stu-assign-programme">Programme</label>
                      <select
                        id="stu-assign-programme"
                        className="stu-select"
                        value={assignProgrammeId}
                        onChange={e => handleAssignProgrammeChange(e.target.value)}
                      >
                        <option value="">Choose a programme</option>
                        {programmes.map(p => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                      </select>
                    </div>
                    {assignProgrammeId && (
                      <div className="stu-field">
                        <label className="stu-label" htmlFor="stu-assign-level">Level</label>
                        <select
                          id="stu-assign-level"
                          className="stu-select"
                          value={assignLevelId}
                          onChange={e => setAssignLevelId(e.target.value)}
                          disabled={assignLevelsLoading || assignLevels.length === 0}
                        >
                          <option value="">
                            {assignLevelsLoading ? 'Loading levels…' : assignLevels.length === 0 ? 'No levels for this programme' : 'Choose a level'}
                          </option>
                          {assignLevels.map(l => (
                            <option key={l.id} value={l.id}>{l.level_label}</option>
                          ))}
                        </select>
                      </div>
                    )}
                    {!currentSessionId && (
                      <p className="stu-form-error">No current session is set for this school — placement needs one. Set a current session under Settings → Calendar first.</p>
                    )}
                    {assignError && <p className="stu-form-error">{assignError}</p>}
                    <div className="stu-status-actions">
                      <button
                        type="button"
                        className="stu-status-action-btn"
                        onClick={() => { setAssignPanelOpen(false); setAssignProgrammeId(''); setAssignLevelId(''); setAssignLevels([]); setAssignError('') }}
                        disabled={assigning}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="stu-status-action-btn stu-status-action-btn--activate"
                        onClick={handleAssignToLevel}
                        disabled={assigning || !assignLevelId || !currentSessionId}
                      >
                        {assigning ? 'Assigning…' : 'Assign'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="stu-status-action-btn stu-status-action-btn--activate"
                    onClick={() => setAssignPanelOpen(true)}
                  >
                    Assign to level
                  </button>
                )
              )}
            </>
          ) : (
            <>
              <span className={`stu-status-badge stu-status-badge--${s} stu-status-badge--lg`}>
                {statusLabel(s)}
              </span>
              {s === 'transferred_out' && (
                <p className="stu-status-note">
                  This student has been transferred out. Their record is read-only and retained permanently.
                </p>
              )}
              {s === 'transferred_in_pending' && (
                <p className="stu-status-note">
                  This student's transfer from another school is pending acceptance.
                </p>
              )}
              {s === 'alumni' && (
                <p className="stu-status-note">
                  Alumni status is permanent. Contact support if this was set in error.
                </p>
              )}
            </>
          )}
        </div>

        {statusError && (
          <p className="stu-form-error" role="alert">{statusError}</p>
        )}

        {/* Confirmation dialog */}
        {!isHigherEd && statusConfirm && (
          <div className="stu-confirm-banner">
            <p className="stu-confirm-text">
              {statusConfirm === 'alumni'
                ? `Mark ${detailStudent.full_name} as alumni? This is a permanent record and cannot be undone here.`
                : statusConfirm === 'active'
                ? `Reactivate ${detailStudent.full_name}?`
                : `Mark ${detailStudent.full_name} as inactive?`}
            </p>
            {statusConfirm === 'active' && (
              <>
                <label className="stu-label" htmlFor="stu-reactivate-note">
                  Note (required)
                </label>
                <textarea
                  id="stu-reactivate-note"
                  className="stu-textarea"
                  value={reactivateNote}
                  onChange={e => setReactivateNote(e.target.value)}
                  placeholder="Why is this student being reactivated?"
                  rows={2}
                />
                <ObligationFields value={reactivateDraft} onChange={setReactivateDraft} />
              </>
            )}
            <div className="stu-confirm-actions">
              <button
                className="stu-confirm-cancel"
                onClick={() => { setStatusConfirm(null); setReactivateNote(''); setReactivateDraft(null) }}
                disabled={statusSaving}
              >
                Cancel
              </button>
              <button
                className={statusConfirm === 'alumni' ? 'stu-confirm-danger' : 'stu-confirm-warn'}
                onClick={() => handleStatusChange(statusConfirm, statusConfirm === 'active' ? reactivateNote : undefined)}
                disabled={
                  statusSaving ||
                  (statusConfirm === 'active' && (!reactivateNote.trim() ||
                    (reactivateDraft !== null && validateObligationDraft(reactivateDraft) !== null)))
                }
              >
                {statusSaving ? 'Saving…' : statusConfirm === 'alumni' ? 'Mark as alumni' : statusConfirm === 'active' ? 'Reactivate' : 'Mark as inactive'}
              </button>
            </div>
          </div>
        )}

        {/* Status action buttons — only when admin and not yet terminal.
            SESSION 64 §12: not shown for higher-ed — active/alumni are
            derived, not manually toggled; inactive has no defined trigger
            yet for higher-ed (open gap, not guessed at here). */}
        {!isHigherEd && canManageStudents && !isTransferred && !statusConfirm && (
          <div className="stu-status-actions">
            {s !== 'active' && (
              <button
                className="stu-status-action-btn stu-status-action-btn--activate"
                onClick={() => setStatusConfirm('active')}
                disabled={statusSaving}
              >
                Reactivate student
              </button>
            )}
            {s === 'active' && (
              <button
                className="stu-status-action-btn stu-status-action-btn--inactive"
                onClick={() => setStatusConfirm('inactive')}
                disabled={statusSaving}
              >
                Mark as inactive
              </button>
            )}
            {s !== 'alumni' && (
              <button
                className="stu-status-action-btn stu-status-action-btn--alumni"
                onClick={() => setStatusConfirm('alumni')}
                disabled={statusSaving}
              >
                Mark as alumni
              </button>
            )}
          </div>
        )}

        {/* Fines & tasks — pending items with fulfil/waive, plus the full
            history (who assigned, when, who resolved) for this student. */}
        {canManageStudents && !isHigherEd && (
          <div className="stu-status-section obl-section">
            <p className="stu-status-section-label">Fines &amp; tasks</p>
            {oblError && <p className="stu-status-note stu-status-note--error">{oblError}</p>}
            {stuOblLoading && <div className="stu-transfer-skel skeleton" />}
            {!stuOblLoading && stuObligations.length === 0 && (
              <p className="stu-status-note">None recorded. A fine or task can be added when reactivating a student.</p>
            )}
            <ul className="obl-list">
              {stuObligations.map(o => {
                const fmt = (d: string) => new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
                return (
                  <li key={o.id} className={`obl-item obl-item--${o.status}`}>
                    <div className="obl-item-top">
                      <strong>{o.kind === 'fine' ? `Fine ${formatObligationAmount(o.amount ?? 0)}` : 'Task'}</strong>
                      <span className={`obl-status obl-status--${o.status}`}>
                        {o.status === 'pending' ? 'Unfulfilled' : o.status === 'fulfilled' ? 'Fulfilled' : 'Waived'}
                      </span>
                    </div>
                    <span className="obl-item-desc">{o.description}</span>
                    <span className="obl-item-meta">
                      Assigned {fmt(o.created_at)}{o.created_by_name ? ` by ${o.created_by_name}` : ''}
                      {o.due_date ? ` · due ${fmt(o.due_date + 'T00:00:00')}` : ''}
                    </span>
                    {o.status !== 'pending' && o.resolved_at && (
                      <span className="obl-item-meta">
                        {o.status === 'fulfilled' ? 'Fulfilled' : 'Waived'} {fmt(o.resolved_at)}
                        {o.resolved_by_name ? ` by ${o.resolved_by_name}` : ''}
                        {o.resolution_note ? ` — ${o.resolution_note}` : ''}
                      </span>
                    )}
                    {o.status === 'pending' && (
                      resolvingId === o.id ? (
                        <div className="obl-resolve">
                          <input
                            className="obl-input obl-input--wide"
                            type="text"
                            value={resolveNote}
                            onChange={e => setResolveNote(e.target.value)}
                            placeholder="Note (optional)"
                          />
                          <button className="stu-confirm-warn" disabled={resolveSaving}
                            onClick={() => void handleResolveObligation(o.id, 'fulfilled')}>
                            {resolveSaving ? 'Saving…' : 'Mark fulfilled'}
                          </button>
                          <button className="stu-confirm-cancel" disabled={resolveSaving}
                            onClick={() => void handleResolveObligation(o.id, 'waived')}>
                            Waive
                          </button>
                          <button className="stu-confirm-cancel" disabled={resolveSaving}
                            onClick={() => { setResolvingId(null); setResolveNote('') }}>
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button className="stu-status-action-btn" onClick={() => { setResolvingId(o.id); setResolveNote('') }}>
                          Resolve…
                        </button>
                      )
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        )}

        {/* Transfer section — only for active students, admin only.
            SESSION 64 §12: s (raw students.status) is not kept in sync
            for higher-ed students, so it can't gate this correctly on its
            own — derive "active" from placement instead for that case. */}
        {canManageStudents && (isHigherEd ? !!currentPlacement : s === 'active') && (
          <div className="stu-transfer-section">
            <p className="stu-status-section-label">Inter-school transfer</p>

            {/* Transfer request loading */}
            {(transferState === 'loading' || transferState === 'booting') && (
              <div className="stu-transfer-skel skeleton" />
            )}

            {/* Transfer error */}
            {transferState === 'error' && (
              <p className="stu-status-note stu-status-note--error">{transferError}</p>
            )}

            {/* Existing transfer request */}
            {transferState === 'ready' && transferRequest && (
              <div className="stu-transfer-status">
                <p className="stu-transfer-status-label">
                  Transfer in progress · {transferRequest.status}
                </p>
                <p className="stu-transfer-status-meta">
                  Initiated {formatDate(transferRequest.requested_at)}
                  {transferRequest.released_at && ` · Released ${formatDate(transferRequest.released_at)}`}
                </p>
              </div>
            )}

            {/* No transfer yet — show initiate button */}
            {transferState === 'ready' && !transferRequest && (
              <>
                {transferConfirm ? (
                  <div className="stu-confirm-banner">
                    <p className="stu-confirm-text">
                      Release {detailStudent.full_name} for transfer? This will mark them as
                      transferred out and lock their record at this school. This cannot be undone.
                    </p>
                    <div className="stu-confirm-actions">
                      <button
                        className="stu-confirm-cancel"
                        onClick={() => setTransferConfirm(false)}
                        disabled={transferSaving}
                      >
                        Cancel
                      </button>
                      <button
                        className="stu-confirm-danger"
                        onClick={handleInitiateTransfer}
                        disabled={transferSaving}
                      >
                        {transferSaving ? 'Releasing…' : 'Release for transfer'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    className="stu-status-action-btn stu-status-action-btn--transfer"
                    onClick={() => {
                      fetchTransferRequest(detailStudent.id)
                      setTransferConfirm(true)
                    }}
                  >
                    Initiate transfer to another school
                  </button>
                )}
                {transferError && (
                  <p className="stu-form-error" role="alert">{transferError}</p>
                )}
              </>
            )}
          </div>
        )}
      </div>
    )
  }

  // ─── Guardian brief popup ───────────────────────────────────────────────────
  // Opened by tapping a guardian's name in the student's Guardians subtab.
  // Read-only glance at the guardian's own info + every student they're
  // linked to. Layered on top of the detail sheet (this overlay is a
  // sibling in the root render tree, not nested inside the Guardians tab
  // content) so closing it always returns to exactly the same subtab,
  // because nothing underneath ever unmounts. "Edit in Guardians module →"
  // is the one deliberate exit that leaves this screen, via the existing
  // onNavigate mechanism — a real jump the admin chooses, not an accidental
  // one, so there's no "back" to solve on that path either.

  function guardianBriefStatusLabel(status: string): string {
    switch (status) {
      case 'active':                 return 'Active'
      case 'inactive':               return 'Inactive'
      case 'alumni':                 return 'Alumni'
      case 'transferred_out':        return 'Transferred out'
      case 'transferred_in_pending': return 'Transfer pending'
      default:                       return status
    }
  }

  function renderGuardianBrief() {
    if (!briefGuardianId) return null

    // Derived from existing per-student state, not new fetches: the brief
    // popup shows portal-login management for this guardian in the context
    // of the currently open student, so it reuses the same `guardians`
    // (GuardianLink[]) and `identities`/`provisionTarget` state the list row
    // used to read directly, just re-pointed at briefGuardianId.
    const briefGuardianLink   = guardians.find(g => g.guardian_id === briefGuardianId) ?? null
    const briefIdentity       = identities[briefGuardianId]
    const briefIsProvisioning = provisionTarget === briefGuardianId

    return (
      <div
        className="stu-form-overlay stu-guardian-brief-overlay"
        onClick={e => { if (e.target === e.currentTarget) closeGuardianBrief() }}
      >
        <div className="stu-form-sheet" role="dialog" aria-modal aria-label="Guardian details">
          <div className="stu-form-handle" />
          <div className="stu-form-header">
            <h3 className="stu-form-title">
              {briefGuardianState === 'ready' && briefGuardianData ? briefGuardianData.full_name : 'Guardian details'}
            </h3>
            <button
              type="button"
              className="stu-form-close"
              onClick={closeGuardianBrief}
              aria-label="Close"
            >
              <Icon name="x" size={16} />
            </button>
          </div>

          <div className="stu-form-body">
            {briefGuardianState === 'loading' && (
              <p className="stu-loading-text">Loading guardian…</p>
            )}

            {briefGuardianState === 'error' && (
              <div className="stu-guardian-brief-error">
                <p className="stu-form-error" role="alert">{briefGuardianError}</p>
                <button
                  type="button"
                  className="stu-retry-btn"
                  onClick={() => openGuardianBrief(briefGuardianId)}
                >
                  Retry
                </button>
              </div>
            )}

            {briefGuardianState === 'ready' && briefGuardianData && (
              <>
                <div className="stu-guardian-brief-info">
                  {briefGuardianData.relationship && (
                    <div className="stu-guardian-brief-row">
                      <span className="stu-guardian-brief-label">Relationship</span>
                      <span className="stu-guardian-brief-value">{briefGuardianData.relationship}</span>
                    </div>
                  )}
                  {briefGuardianData.phone && (
                    <div className="stu-guardian-brief-row">
                      <span className="stu-guardian-brief-label">Phone</span>
                      <span className="stu-guardian-brief-value">{briefGuardianData.phone}</span>
                    </div>
                  )}
                  {briefGuardianData.email && (
                    <div className="stu-guardian-brief-row">
                      <span className="stu-guardian-brief-label">Email</span>
                      <span className="stu-guardian-brief-value">{briefGuardianData.email}</span>
                    </div>
                  )}
                  {!briefGuardianData.relationship && !briefGuardianData.phone && !briefGuardianData.email && (
                    <p className="stu-empty-text">No contact details on file.</p>
                  )}
                </div>

                <div className="stu-guardian-brief-students">
                  <h4 className="stu-guardian-brief-subheading">
                    {briefGuardianData.linked_students.length === 1
                      ? 'Linked student'
                      : `Linked students (${briefGuardianData.linked_students.length})`}
                  </h4>
                  {briefGuardianData.linked_students.length === 0 ? (
                    <p className="stu-empty-text">No linked students.</p>
                  ) : (
                    <ul className="stu-guardian-brief-student-list">
                      {briefGuardianData.linked_students.map(s => (
                        <li key={s.student_id} className="stu-guardian-brief-student-row">
                          <div className="stu-guardian-brief-student-info">
                            <span className="stu-guardian-brief-student-name">{s.full_name}</span>
                            {s.class_path_label && (
                              <span className="stu-guardian-meta">{s.class_path_label}</span>
                            )}
                          </div>
                          <div className="stu-guardian-brief-student-badges">
                            <span className={`stu-status-badge stu-status-badge--${s.status}`}>
                              {guardianBriefStatusLabel(s.status)}
                            </span>
                            {s.has_platform_access && (
                              <span className="stu-guardian-brief-access-badge">Portal access</span>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {/* Login-code provisioning — moved here from the list row per
                    owner request, 2026-07-02: (1) the code shouldn't be
                    visible in the guardian list at a glance, only inside this
                    deliberately-opened popup; (2) wrapping all three card
                    states (status / unprovisioned / form) in a single
                    min-height container stops the visible jump the old
                    inline card had when swapping between them. Only shown
                    when this guardian has portal access for the student
                    whose detail sheet is currently open — access itself is
                    still granted/revoked from the list row's toggle, this is
                    just the code management piece. */}
                {canManagePortalAccess && briefGuardianLink?.has_platform_access && (
                  <div className="stu-guardian-brief-provision-section">
                    <h4 className="stu-guardian-brief-subheading">Portal login</h4>

                    {/* Regenerate-code confirmation — SESSION 11 item 2.
                        Moved inside the popup, 2026-07-02: this used to
                        render in the (now-behind-the-overlay) list area, so
                        triggering it from here would have been invisible
                        under the popup's z-index: 200. Only shown for the
                        regenerate path (identity already exists); first-time
                        "Set up login" is non-destructive and skips straight
                        to the provision form, unchanged. */}
                    {regenerateConfirmTarget && regenerateConfirmTarget.guardian_id === briefGuardianId && (
                      <div className="stu-confirm-banner">
                        <p className="stu-confirm-text">
                          Regenerate {regenerateConfirmTarget.full_name}'s login code? Their current code will stop working immediately.
                        </p>
                        <div className="stu-confirm-actions">
                          <button className="stu-confirm-cancel" onClick={() => setRegenerateConfirmTarget(null)}>Keep current code</button>
                          <button
                            className="stu-confirm-danger"
                            onClick={() => {
                              const guardianId = regenerateConfirmTarget.guardian_id
                              setRegenerateConfirmTarget(null)
                              openProvision(guardianId)
                            }}
                          >
                            Continue
                          </button>
                        </div>
                      </div>
                    )}

                    <div className="stu-provision-section stu-provision-section--brief">

                      {/* Already provisioned — show current method + code */}
                      {briefIdentity && !briefIsProvisioning && (
                        <div className="stu-provision-status">
                          <span className="stu-provision-method-badge"><Icon name="key" size={14} /> Login code</span>
                          {briefIdentity.login_method === 'login_code' && briefIdentity.login_code && (
                            <span className="stu-provision-code">{briefIdentity.login_code}</span>
                          )}
                          {briefIdentity.login_method === 'login_code' && !briefIdentity.login_code && (
                            <span className="stu-provision-code-unavailable">Code not available — try Change / regenerate</span>
                          )}
                          <button
                            className="stu-provision-change-btn"
                            onClick={() => briefGuardianLink && setRegenerateConfirmTarget(briefGuardianLink)}
                          >
                            Change / regenerate
                          </button>
                        </div>
                      )}

                      {/* Not yet provisioned */}
                      {(briefIdentity === null || briefIdentity === undefined) && !briefIsProvisioning && (
                        <div className="stu-provision-status">
                          <span className="stu-provision-unprov">No login set up yet</span>
                          <button
                            className="stu-provision-btn"
                            onClick={() => {
                              fetchGuardianIdentity(briefGuardianId)
                              openProvision(briefGuardianId)
                            }}
                          >
                            Set up login →
                          </button>
                        </div>
                      )}

                      {/* Provision form */}
                      {briefIsProvisioning && (
                        <div className="stu-provision-form">
                          <p className="stu-provision-form-title">
                            {briefIdentity ? 'Regenerate login code for' : 'Set up login for'} {briefGuardianData.full_name}
                          </p>
                          <p className="stu-provision-method-hint">
                            A unique login code will be generated. Give it to the guardian to sign in.
                          </p>

                          {provisionError && (
                            <p className="stu-form-error" role="alert">{provisionError}</p>
                          )}

                          <div className="stu-provision-form-footer">
                            <button className="stu-cancel-btn" onClick={closeProvision} disabled={provisionSaving}>
                              Cancel
                            </button>
                            <button
                              className="stu-save-btn"
                              onClick={() => handleProvision(briefGuardianId, !!briefIdentity)}
                              disabled={provisionSaving}
                            >
                              {provisionSaving ? 'Setting up…' : briefIdentity ? 'Regenerate code' : 'Generate code'}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {onNavigate && (
                  <button
                    type="button"
                    className="stu-guardian-brief-edit-link"
                    onClick={() => {
                      const id = briefGuardianId
                      closeGuardianBrief()
                      onNavigate('guardians', { guardianId: id })
                    }}
                  >
                    Edit in Guardians module →
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    )
  }

  // ─── Add student form overlay ─────────────────────────────────────────────

  function renderAddForm() {
    if (!formOpen) return null
    return (
      <div className="stu-form-overlay" onClick={e => { if (e.target === e.currentTarget) closeAddForm() }}>
        <div className="stu-form-sheet" role="dialog" aria-modal aria-label="Add student">
          <div className="stu-form-handle" />
          <div className="stu-form-header">
            <h3 className="stu-form-title">Add student</h3>
            <button className="stu-form-close" onClick={closeAddForm} aria-label="Close"><Icon name="x" size={16} /></button>
          </div>
          <div className="stu-form-body">
            <div className="stu-field">
              <label className="stu-label" htmlFor="stu-add-name">
                Full name <span className="stu-required">*</span>
              </label>
              <input
                id="stu-add-name"
                ref={nameInputRef}
                className="stu-input"
                type="text"
                placeholder="e.g. Amina Ibrahim"
                value={form.full_name}
                onChange={e => setField('full_name', e.target.value)}
                autoComplete="off"
              />
            </div>
            {/* Problem 9.8 (Tier 9) — this field previously rendered
                unconditionally regardless of school type, showing a
                meaningless "Class" picker (always empty — `classes` is
                only ever populated for secondary schools, see the boot
                effect above) on a higher-ed school. Branches here instead:
                secondary keeps the existing Class picker untouched;
                higher-ed gets a real Programme → Level dependent picker,
                optional (per the owner's "optional at creation" decision —
                see this problem's Tier 9 writeup), wired to createStudent()'s
                new optional placement params in handleSubmit(). */}
            {isHigherEd ? (
              <>
                <div className="stu-field">
                  <label className="stu-label" htmlFor="stu-add-programme">Programme</label>
                  <select
                    id="stu-add-programme"
                    className="stu-select"
                    value={form.programme_id}
                    onChange={e => handleAddFormProgrammeChange(e.target.value)}
                  >
                    <option value="">— not yet placed —</option>
                    {programmes.map(p => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>
                {form.programme_id && (
                  <div className="stu-field">
                    <label className="stu-label" htmlFor="stu-add-level">Level</label>
                    <select
                      id="stu-add-level"
                      className="stu-select"
                      value={form.programme_level_id}
                      onChange={e => setField('programme_level_id', e.target.value)}
                      disabled={formLevelsLoading || formLevels.length === 0}
                    >
                      <option value="">
                        {formLevelsLoading ? 'Loading levels…' : formLevels.length === 0 ? 'No levels for this programme' : 'Choose a level'}
                      </option>
                      {formLevels.map(l => (
                        <option key={l.id} value={l.id}>{l.level_label}</option>
                      ))}
                    </select>
                    <p className="stu-field-hint">
                      Optional — leave blank to add the student without placing them yet. Place them later from the Unplaced list or their Status tab.
                    </p>
                  </div>
                )}
              </>
            ) : (
              <div className="stu-field">
                <label className="stu-label" htmlFor="stu-add-class">Class</label>
                <select
                  id="stu-add-class"
                  className="stu-select"
                  value={form.class_node_id}
                  onChange={e => setField('class_node_id', e.target.value)}
                >
                  <option value="">— not yet assigned —</option>
                  {classes.map(c => (
                    <option key={c.id} value={c.id}>{c.path_label}</option>
                  ))}
                </select>
              </div>
            )}
            <div className="stu-field">
              <label className="stu-label" htmlFor="stu-add-gender">Gender</label>
              <select
                id="stu-add-gender"
                className="stu-select"
                value={form.gender}
                onChange={e => setField('gender', e.target.value)}
              >
                <option value="">— not specified —</option>
                <option value="Male">Male</option>
                <option value="Female">Female</option>
              </select>
            </div>
            <div className="stu-field">
              <label className="stu-label" htmlFor="stu-add-dob">Date of birth</label>
              <input
                id="stu-add-dob"
                className="stu-input"
                type="date"
                max={todayDateString()}
                value={form.date_of_birth}
                onChange={e => setField('date_of_birth', e.target.value)}
              />
            </div>
            <div className="stu-field">
              <label className="stu-label" htmlFor="stu-add-admission">Admission date</label>
              <input
                id="stu-add-admission"
                className="stu-input"
                type="date"
                max={todayDateString()}
                value={form.admission_date}
                onChange={e => setField('admission_date', e.target.value)}
              />
            </div>
            <div className="stu-field">
              <label className="stu-label" htmlFor="stu-add-code">Student ID number (not a login code)</label>
              <div className="stu-code-row">
                <input
                  id="stu-add-code"
                  className="stu-input stu-input--code"
                  type="text"
                  placeholder="e.g. STU-0042 (optional)"
                  value={form.student_code}
                  onChange={e => setField('student_code', e.target.value.toUpperCase())}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <p className="stu-field-hint">Used for registers and ID cards. Must be unique per school.</p>
            </div>

            {/* Session 16 — this was the actual bug behind "new details not
                showing when adding a new student": renderAddForm() is a
                separate JSX block from renderInfoTab() (Edit), not shared
                markup. Session 14 added these fields to FormState/the DB
                write/the Edit subtab's inputs, but never to this form — so
                there was nothing to type into on create, and every new
                student silently got null for all eight fields. Same field
                set, same order, as the Edit subtab's own "Additional
                details" section for consistency. */}
            <p className="stu-section-divider">Additional details</p>

            <div className="stu-field">
              <label className="stu-label" htmlFor="stu-add-address">Address</label>
              <textarea
                id="stu-add-address"
                className="stu-textarea"
                placeholder="Home address"
                value={form.address}
                onChange={e => setField('address', e.target.value)}
                rows={2}
              />
            </div>

            <div className="stu-field">
              <label className="stu-label" htmlFor="stu-add-email">Email (optional)</label>
              <input
                id="stu-add-email"
                className="stu-input"
                type="email"
                placeholder="student@example.com"
                value={form.email}
                onChange={e => setField('email', e.target.value)}
                autoComplete="off"
              />
            </div>

            <div className="stu-field">
              <label className="stu-label" htmlFor="stu-add-phone">Phone (optional)</label>
              <input
                id="stu-add-phone"
                className="stu-input"
                type="tel"
                placeholder="e.g. 080…"
                value={form.phone}
                onChange={e => setField('phone', e.target.value)}
                autoComplete="off"
              />
            </div>

            <div className="stu-field">
              <label className="stu-label" htmlFor="stu-add-hobbies">Hobbies</label>
              <input
                id="stu-add-hobbies"
                className="stu-input"
                type="text"
                placeholder="e.g. Football, reading, chess"
                value={form.hobbies}
                onChange={e => setField('hobbies', e.target.value)}
                autoComplete="off"
              />
            </div>

            <div className="stu-field">
              <label className="stu-label" htmlFor="stu-add-blood">Blood group</label>
              <select
                id="stu-add-blood"
                className="stu-select"
                value={form.blood_group}
                onChange={e => setField('blood_group', e.target.value)}
              >
                <option value="">— not recorded —</option>
                {['O+', 'O-', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-'].map(bg => (
                  <option key={bg} value={bg}>{bg}</option>
                ))}
              </select>
            </div>

            <div className="stu-field">
              <label className="stu-label" htmlFor="stu-add-medical">Medical notes</label>
              <textarea
                id="stu-add-medical"
                className="stu-textarea"
                placeholder="Allergies, conditions, or anything staff should know"
                value={form.medical_notes}
                onChange={e => setField('medical_notes', e.target.value)}
                rows={3}
              />
            </div>

            <div className="stu-field">
              <label className="stu-label" htmlFor="stu-add-ec-name">Emergency contact name</label>
              <input
                id="stu-add-ec-name"
                className="stu-input"
                type="text"
                placeholder="e.g. Mrs. Ibrahim"
                value={form.emergency_contact_name}
                onChange={e => setField('emergency_contact_name', e.target.value)}
                autoComplete="off"
              />
            </div>

            <div className="stu-field">
              <label className="stu-label" htmlFor="stu-add-ec-phone">Emergency contact phone</label>
              <input
                id="stu-add-ec-phone"
                className="stu-input"
                type="tel"
                placeholder="e.g. 080…"
                value={form.emergency_contact_phone}
                onChange={e => setField('emergency_contact_phone', e.target.value)}
                autoComplete="off"
              />
            </div>

            {formError && (
              <p className="stu-form-error" role="alert">{formError}</p>
            )}
          </div>
          <div className="stu-form-footer">
            <button className="stu-cancel-btn" onClick={closeAddForm} disabled={formSaving}>
              Cancel
            </button>
            <button className="stu-save-btn" onClick={handleSubmit} disabled={formSaving}>
              {formSaving ? 'Saving…' : 'Add student'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="stu-root">
      {renderHeader()}
      <div className="stu-body">
        {listSuccessMsg && (
          <p className="stu-brief-success stu-list-success" role="status"><Icon name="circle-check" size={16} style={{ color: 'var(--color-success, #16a34a)' }} /> {listSuccessMsg}</p>
        )}
        {renderStatStrip()}
        {renderCount()}
        {renderList()}
      </div>
      {renderDetailPanel()}
      {renderAddForm()}
      {renderGuardianBrief()}
    </div>
  )
}

// ─── Transcript tab (SESSION 60e — admin equivalent of GuardianPortal.tsx's
//      TranscriptTab, only reachable when isHigherEd) ─────────────────────
//
// Deliberately a standalone top-level component, not a renderXTab() closure
// like Brief/Guardians/Status above — matches GuardianPortal.tsx's own
// TranscriptTab shape (self-contained load effect keyed on studentId, own
// loading/error state) rather than this file's closure convention, since
// it's intentionally the same component shape/behavior as the guardian
// version, just fed a different studentId source (an admin-selected
// student here vs. the logged-in guardian's own child there) — no new
// service logic, this is a rendering-layer twin.
//
// Reads via loadStudentTranscript() as STAFF (this module is admin/staff-
// only), which per migration_session_60d_publish_gate.sql's RLS is a
// *different, unrestricted* policy than the guardian/student one
// GuardianPortal.tsx's own call hits — so this naturally receives BOTH
// published and draft (unpublished) rows, unlike the guardian view. Per
// owner's 2026-07-16 decision ("admin sees everything, drafts clearly
// marked"), every course row is shown, with an explicit "Draft — not yet
// published" badge on any row where is_published is false, so an admin
// browsing a transcript can never mistake an unreviewed score for a final
// one.
function StudentTranscriptTab({
  schoolName,
  studentId,
}: {
  schoolName: string
  studentId: string
}) {
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [transcript, setTranscript] = useState<StudentTranscript | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function run() {
      setLoadState('loading')
      try {
        // includeUnpublished=true — this is the admin view; owner's
        // 2026-07-16 requirement is that admin sees everything on the
        // transcript, published or not (with the Draft badge below
        // marking unpublished rows). Omitting this arg (the default,
        // false) is what GuardianPortal.tsx's own call relies on instead.
        const { data, error } = await loadStudentTranscript(studentId, true)
        if (cancelled) return
        if (error || !data) {
          setLoadState('error')
          return
        }
        setTranscript(data)
        setLoadState('ready')
      } catch {
        if (!cancelled) setLoadState('error')
      }
    }
    run()
    return () => { cancelled = true }
  }, [studentId])

  const handleDownload = () => {
    if (!transcript) return
    setDownloadError(null)
    setDownloading(true)
    try {
      // Admin's PDF download intentionally uses the same
      // downloadTranscriptPdf() as the guardian's — it renders every
      // course row it's handed with no is_published branching of its own
      // (transcriptPdf.ts has no concept of publish state at all). Since
      // this admin view's transcript object CAN include drafts, an admin
      // downloading here could produce a PDF containing unpublished
      // scores — acceptable for an admin's own working copy/internal
      // review use, but worth knowing: this is not the same document a
      // guardian would get (guardians never receive draft rows to begin
      // with, so their downloaded PDF is always all-published already).
      downloadTranscriptPdf({ schoolName, transcript })
    } catch {
      setDownloadError("Couldn't generate the PDF — try again.")
    } finally {
      setDownloading(false)
    }
  }

  if (loadState === 'loading') {
    return (
      <>
        <div className="port-skel-card" />
        <div className="port-skel-card" />
      </>
    )
  }

  if (loadState === 'error') {
    return <p className="port-form-error">Couldn't load the transcript — check your connection and try again.</p>
  }

  if (!transcript) return null

  return (
    <div className="port-transcript">
      <div className="port-transcript-header">
        <div>
          <p className="port-transcript-student">{transcript.student_name}</p>
          <p className="port-transcript-matric">Matric No: {transcript.matric_number ?? '—'}</p>
        </div>
        <button
          className="port-transcript-download-btn"
          onClick={handleDownload}
          disabled={downloading}
        >
          <Icon name="graduation-cap" size={16} />
          {downloading ? 'Preparing…' : 'Download PDF'}
        </button>
      </div>
      {downloadError && <p className="port-form-error">{downloadError}</p>}

      <div className="port-transcript-cgpa-card">
        <p className="port-transcript-cgpa-label">Cumulative GPA (CGPA)</p>
        <p className="port-transcript-cgpa-value">
          {transcript.cgpa === null ? '—' : transcript.cgpa.toFixed(2)}
        </p>
        {transcript.cgpa !== null && (
          <p className="port-transcript-cgpa-detail">
            Units attempted: {transcript.cgpa_total_units_attempted ?? '—'} · Quality points:{' '}
            {transcript.cgpa_total_quality_points?.toFixed(2) ?? '—'}
          </p>
        )}
      </div>

      {transcript.semesters.length === 0 && (
        <p className="port-empty-inline">No finalized courses yet.</p>
      )}

      {transcript.semesters.map((semester) => (
        <div key={`${semester.session_id}|${semester.term_id ?? ''}`} className="port-transcript-semester-card">
          <div className="port-transcript-semester-header">
            <p className="port-transcript-semester-title">
              {semester.term_name ? `${semester.session_name} — ${semester.term_name}` : semester.session_name}
            </p>
            <p className="port-transcript-semester-gpa">
              {semester.gpa === null ? 'GPA: —' : `GPA: ${semester.gpa.toFixed(2)}`}
            </p>
          </div>
          <div className="port-transcript-course-list">
            {semester.courses.map((c) => (
              <div
                key={c.registration_id}
                className={`port-transcript-course-row ${c.is_superseded ? 'port-transcript-course-row--superseded' : ''}`}
              >
                <div className="port-transcript-course-main">
                  <span className="port-transcript-course-code">{c.course_code}</span>
                  <span className="port-transcript-course-title">{c.course_title}</span>
                </div>
                <div className="port-transcript-course-meta">
                  <span>{c.credit_units} units</span>
                  {c.letter_grade && <span className="port-transcript-course-grade-pill">{c.letter_grade}</span>}
                  {c.grade_point !== null && <span>{c.grade_point.toFixed(2)} GP</span>}
                </div>
                {/* SESSION 60e — admin-only draft badge. Not present in
                    GuardianPortal.tsx's own copy of this row markup at
                    all, since a guardian/student's course_results read is
                    RLS-restricted to published_at is not null already —
                    this badge would be permanently, silently dead code
                    there. Here it's live: this view's read is the
                    unrestricted staff policy, so drafts genuinely
                    surface. */}
                {(c.is_carryover || c.is_superseded || !c.is_published) && (
                  <div className="port-transcript-course-tags">
                    {c.is_carryover && <span className="port-transcript-tag">Carryover</span>}
                    {c.is_superseded && <span className="port-transcript-tag port-transcript-tag--superseded">Superseded</span>}
                    {!c.is_published && <span className="port-transcript-tag port-transcript-tag--draft">Draft — not yet published</span>}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-NG', {
      day: 'numeric', month: 'short', year: 'numeric',
    })
  } catch {
    return iso
  }
}
