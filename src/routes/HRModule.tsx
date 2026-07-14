/**
 * HRModule.tsx
 * Staff management, leave requests/approval, payroll runs.
 *
 * Props (same pattern as all other modules):
 *   schoolId  — passed from App.tsx via TabContent
 *   isAdmin   — no longer used to gate any write action in this file (Session 10
 *               permission-catalog conversion pass). Retained only on the props
 *               interface pending App.tsx call-site visibility, same conservative
 *               choice made for StudentsModule.tsx/FinanceModule.tsx. Write gates
 *               below read real `can('<key>')` calls against the confirmed
 *               `hr.*` catalog (rows pulled directly from the live `permissions`
 *               table, not guessed from key names alone — see PRD Session 10 HR
 *               entry). One gate (leave-type add/edit) has NO matching catalog
 *               key and is intentionally left on `isAdmin` — flagged as a
 *               confirmed gap, not silently converted.
 *
 * Views (tab-based at module level, same chrome as FinanceModule):
 *   "Staff"   — all staff with role badges; admin can edit; tap opens detail sheet
 *   "Leave"   — leave requests (filterable by status); admin can approve/reject;
 *               staff sees + can cancel their own pending requests; leave types
 *               management section below the list (admin only)
 *   "Payroll" — payroll runs list; admin can create a run; tap opens run detail
 *               (payslips, approve/mark-paid actions)
 *
 * Staff detail panel (slide-up sheet, same chrome as FinanceModule's student detail):
 *   Tapping a staff member in the Staff tab opens a 2-tab detail sheet:
 *     "Details" — edit name/email/phone/hire date/status/role assignment
 *                 (role checklist added Session 10a — multi-select against
 *                 staff_roles, a many-to-many join table, so a staff member can
 *                 legitimately hold more than one role at once; catalog reused
 *                 from settingsService.loadRoles(), the same source
 *                 SettingsModule.tsx's RolesTab already uses, not a second
 *                 independent fetch). Also shows a default-password
 *                 view/print/regenerate panel (Session 10b) — gated on
 *                 canManageStaff, same as the edit toggle; hidden entirely
 *                 when the staff member has no default_password on file
 *                 (already changed it, or account predates this feature).
 *     "Salary"  — current salary structure; admin can save a new structure
 *                 (always inserts a new historical row — see §3.10 / §7.19)
 *
 * Payroll run detail panel (slide-up sheet):
 *   Tapping a run opens its payslip list + approve/mark-paid action bar (admin only)
 *
 * UX contract (§4):
 *   - All lists load skeleton first
 *   - All money formatted as ₦ with two decimal places
 *   - Leave approve/reject is a single tap from the list row — no extra sheet,
 *     this is the daily-use action and must be fast
 *   - No irreversible actions without confirmation where §3.10 applies
 *     (payroll runs are never hard-deleted; approving/marking paid moves status
 *     forward only — UI warns before the mark-paid step since it triggers the ledger)
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { Icon } from '../components/icons'
import { useAuthStore } from '../stores/authStore'
import {
  loadStaffList,
  loadStaffDetail,
  loadLeaveTypes,
  loadLeaveRequests,
  loadPayrollRuns,
  loadPayslipsForRun,
  updateStaff,
  updateStaffRoles,
  createLeaveType,
  updateLeaveType,
  submitLeaveRequest,
  reviewLeaveRequest,
  cancelLeaveRequest,
  saveSalaryStructure,
  loadSchoolDefaultPayFrequency,
  loadPayslipPayments,
  recordPayslipPayment,
  removePayslipFromRun,
  loadTeachingAssignmentOptions,
  loadStaffTeachingAssignments,
  updateStaffTeachingAssignments,
  createPayrollRun,
  approvePayrollRun,
  markPayrollRunPaid,
  loadStaffDueForPayment,
  loadEligibleStaffForRun,
  addPayslip,
  addAllEligiblePayslips,
  loadStaffDefaultPassword,
  regenerateStaffPassword,
  formatNaira,
  todayDateString,
  formatDate,
  statusLabel,
  type StaffMember,
  type StaffDetail,
  type LeaveType,
  type LeaveRequest,
  type PayrollRun,
  type Payslip,
  type AllowanceItem,
  type DeductionItem,
  type PayFrequency,
  type PayslipPayment,
  type TeachingAssignment,
  type SubjectOption,
  type ClassOption,
  type StaffPaymentDueStatus,
  type EligiblePayslipCandidate,
  type StaffDefaultPassword,
} from '../services/hrService'
// Session 10a — role-assignment UI reuses the same roles/permissions catalog
// source SettingsModule.tsx's RolesTab already uses, rather than re-fetching
// roles a second, independent way (PRD Session 10a step 2).
import { loadRoles, type Role } from '../services/settingsService'

// ─── Props ────────────────────────────────────────────────────────────────────

interface HRModuleProps {
  schoolId: string
  isAdmin: boolean
  /** auth.users.id of the signed-in actor — needed to resolve staff.id for
   *  submitting/reviewing leave and approving payroll (same pattern as Finance). */
  authUserId: string | null
  /** staff.id of the signed-in actor, if they are staff — used so a non-admin
   *  staff member can submit a leave request for themselves and see their own
   *  requests. Null for platform_admin actors with no staff row. */
  currentStaffId: string | null
}

// ─── Load states ──────────────────────────────────────────────────────────────

type LoadState = 'booting' | 'loading' | 'ready' | 'empty' | 'error'

// ─── Module-level tabs ────────────────────────────────────────────────────────

type ModuleTab = 'staff' | 'leave' | 'payroll'

// ─── Staff detail tabs ─────────────────────────────────────────────────────────

type StaffDetailTab = 'details' | 'salary'

// ─── Staff edit form ────────────────────────────────────────────────────────────

interface StaffEditForm {
  full_name: string
  email: string
  phone: string
  hire_date: string
  status: 'active' | 'inactive' | 'suspended'
  role_ids: string[]              // Session 10a — selected role ids, multi-select
  assignment_pairs: { subjectId: string; classNodeId: string }[]  // Session 10b — current-session only
}

// ─── Salary form ────────────────────────────────────────────────────────────────

interface SalaryForm {
  basic_salary: string
  allowances: AllowanceItem[]
  deductions: DeductionItem[]
  effective_from: string
  pay_frequency: PayFrequency | ''    // '' = defer to school default (Session 10c)
}

const EMPTY_SALARY_FORM: SalaryForm = {
  basic_salary: '',
  allowances: [],
  deductions: [],
  effective_from: todayDateString(),
  pay_frequency: '',
}

const PAY_FREQUENCY_LABELS: Record<PayFrequency, string> = {
  monthly:   'Monthly',
  termly:    'Per term',
  sessional: 'Per session',
  custom:    'Custom',
}

// ─── Leave type form ────────────────────────────────────────────────────────────

interface LeaveTypeForm {
  name: string
  paid: boolean
  annual_allowance_days: string
}

const EMPTY_LEAVE_TYPE_FORM: LeaveTypeForm = {
  name: '',
  paid: true,
  annual_allowance_days: '',
}

// ─── Leave request form (self-submit) ───────────────────────────────────────────

interface LeaveRequestForm {
  leave_type_id: string
  start_date: string
  end_date: string
  reason: string
}

const EMPTY_LEAVE_REQUEST_FORM: LeaveRequestForm = {
  leave_type_id: '',
  start_date: todayDateString(),
  end_date: todayDateString(),
  reason: '',
}

// ─── Payroll run form ───────────────────────────────────────────────────────────

interface PayrollRunForm {
  period_label: string
  period_start: string
  period_end: string
}

const EMPTY_PAYROLL_RUN_FORM: PayrollRunForm = {
  period_label: '',
  period_start: '',
  period_end: '',
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function HRModule({ schoolId, isAdmin, authUserId, currentStaffId }: HRModuleProps) {

  // ── Permission selectors (Session 10 — hr.* catalog, in-component pattern
  //    matching AttendanceModule.tsx/TimetableModule.tsx/StudentsModule.tsx/
  //    FinanceModule.tsx; admin-role bypass is automatic via useAuthStore's
  //    can() itself, not re-checked here) ──────────────────────────────────
  const canManageStaff    = useAuthStore(s => s.can('hr.staff.manage'))
  const canRequestLeave   = useAuthStore(s => s.can('hr.leave.request'))
  const canApproveLeave   = useAuthStore(s => s.can('hr.leave.approve'))
  const canViewAllLeave   = useAuthStore(s => s.can('hr.leave.view_all'))
  const canRunPayroll     = useAuthStore(s => s.can('hr.payroll.run'))
  const canApprovePayroll = useAuthStore(s => s.can('hr.payroll.approve'))

  // ── Module tabs ────────────────────────────────────────────────────────────
  const [moduleTab, setModuleTab] = useState<ModuleTab>('staff')

  // ── Staff tab ───────────────────────────────────────────────────────────────
  const [staffList,    setStaffList]    = useState<StaffMember[]>([])
  const [staffState,   setStaffState]   = useState<LoadState>('booting')
  const [staffError,   setStaffError]   = useState('')
  const [searchQuery,  setSearchQuery]  = useState('')

  // ── Leave tab ───────────────────────────────────────────────────────────────
  const [leaveTypes,      setLeaveTypes]      = useState<LeaveType[]>([])
  const [leaveTypesState, setLeaveTypesState] = useState<LoadState>('booting')
  const [leaveRequests,   setLeaveRequests]   = useState<LeaveRequest[]>([])
  const [leaveState,      setLeaveState]      = useState<LoadState>('booting')
  const [leaveError,      setLeaveError]      = useState('')
  const [leaveFilter,     setLeaveFilter]     = useState<'pending' | 'approved' | 'rejected' | 'cancelled' | ''>('pending')
  const [leaveActionId,   setLeaveActionId]   = useState<string | null>(null)

  // ── Leave type form (admin add/edit) ────────────────────────────────────────
  const [leaveTypeFormOpen,  setLeaveTypeFormOpen]  = useState(false)
  const [leaveTypeForm,      setLeaveTypeForm]      = useState<LeaveTypeForm>(EMPTY_LEAVE_TYPE_FORM)
  const [editingLeaveTypeId, setEditingLeaveTypeId] = useState<string | null>(null)
  const [leaveTypeSaving,    setLeaveTypeSaving]    = useState(false)
  const [leaveTypeError,     setLeaveTypeError]     = useState('')
  const leaveTypeNameRef = useRef<HTMLInputElement>(null)

  // ── Leave request form (self-submit) ────────────────────────────────────────
  const [leaveRequestFormOpen, setLeaveRequestFormOpen] = useState(false)
  const [leaveRequestForm,     setLeaveRequestForm]     = useState<LeaveRequestForm>(EMPTY_LEAVE_REQUEST_FORM)
  const [leaveRequestSaving,   setLeaveRequestSaving]   = useState(false)
  const [leaveRequestError,    setLeaveRequestError]    = useState('')

  // ── Payroll tab ──────────────────────────────────────────────────────────────
  const [payrollRuns,    setPayrollRuns]    = useState<PayrollRun[]>([])
  const [payrollState,   setPayrollState]   = useState<LoadState>('booting')
  const [payrollError,   setPayrollError]   = useState('')

  // ── "Who's due this month" panel (Session 10d) ──────────────────────────────
  // Collapsed by default, computed on demand (not on module boot) — this is a
  // derived estimate to help decide who to include in the next payroll run,
  // not stored data, so there's no point loading it before anyone asks.
  const [dueThisMonthOpen,   setDueThisMonthOpen]   = useState(false)
  const [dueThisMonthMonth,  setDueThisMonthMonth]  = useState<string>(() => todayDateString().slice(0, 7))
  const [dueThisMonthState,  setDueThisMonthState]  = useState<LoadState>('booting')
  const [dueThisMonthError,  setDueThisMonthError]  = useState('')
  const [dueThisMonthData,   setDueThisMonthData]   = useState<StaffPaymentDueStatus[]>([])

  // ── Payroll run form (admin create) ─────────────────────────────────────────
  const [runFormOpen, setRunFormOpen] = useState(false)
  const [runForm,     setRunForm]     = useState<PayrollRunForm>(EMPTY_PAYROLL_RUN_FORM)
  const [runSaving,   setRunSaving]   = useState(false)
  const [runError,    setRunError]    = useState('')

  // ── Staff detail panel ──────────────────────────────────────────────────────
  const [detailStaff,     setDetailStaff]     = useState<StaffDetail | null>(null)
  const [detailTab,       setDetailTab]       = useState<StaffDetailTab>('details')
  const [detailDataState, setDetailDataState] = useState<LoadState>('booting')
  const [detailDataError, setDetailDataError] = useState('')

  // ── Staff teaching assignments (Session 10b) — full history across all
  // sessions, loaded alongside the rest of the detail panel. The read-only
  // Details view filters this down to the current session for display; the
  // full list is what a future teacher-summary view would use.
  const [staffAssignments,      setStaffAssignments]      = useState<TeachingAssignment[]>([])
  const [staffAssignmentsState, setStaffAssignmentsState] = useState<LoadState>('booting')

  // ── Staff edit form (inside detail panel) ───────────────────────────────────
  const [editForm,    setEditForm]    = useState<StaffEditForm | null>(null)
  const [editSaving,  setEditSaving]  = useState(false)
  const [editError,   setEditError]   = useState('')

  // ── Default password (Session 10b) — loaded alongside the rest of the
  // detail panel on open; admin-only in practice (a non-admin caller simply
  // gets `data: null` back from the RLS-scoped view, not an error, so this
  // state naturally stays empty for them rather than showing a broken panel).
  const [defaultPassword,      setDefaultPassword]      = useState<StaffDefaultPassword | null>(null)
  const [defaultPasswordState, setDefaultPasswordState] = useState<LoadState>('booting')
  const [passwordRevealed,     setPasswordRevealed]     = useState(false)
  const [regenerateConfirm,    setRegenerateConfirm]    = useState(false)
  const [regenerateSaving,     setRegenerateSaving]     = useState(false)
  const [regenerateError,      setRegenerateError]      = useState('')

  // ── Roles catalog (Session 10a — for the role-assignment multi-select) ──────
  // Fetched from the same source SettingsModule.tsx's RolesTab uses, not a
  // second independent query. Loaded lazily on first entry into edit mode
  // rather than at module boot, since non-admin staff (no hr.staff.manage)
  // never reach the edit form and shouldn't pay for this fetch.
  const [rolesCatalog,      setRolesCatalog]      = useState<Role[]>([])
  const [rolesCatalogState, setRolesCatalogState] = useState<LoadState>('booting')

  // ── Teaching assignment catalog (Session 10b) — subjects/leaf-classes/
  // current session for the assignment picker. Lazy-loaded alongside the
  // roles catalog on first entry into edit mode, same rationale.
  const [assignmentOptions,      setAssignmentOptions]      = useState<{
    subjects: SubjectOption[]
    classes: ClassOption[]
    currentSessionId: string | null
  } | null>(null)
  const [assignmentOptionsState, setAssignmentOptionsState] = useState<LoadState>('booting')

  // ── School default pay frequency (Session 10c) — what a null per-staff
  // pay_frequency falls back to. Loaded lazily the first time the salary
  // form or salary tab needs it, cached module-wide (school-level value,
  // same rationale as the roles catalog not being staff-specific).
  const [schoolDefaultFrequency,      setSchoolDefaultFrequency]      = useState<PayFrequency | null>(null)
  const [schoolDefaultFrequencyState, setSchoolDefaultFrequencyState] = useState<LoadState>('booting')

  // ── Payslip payment recording (Session 10c) ─────────────────────────────────
  const [paymentHistoryByPayslip, setPaymentHistoryByPayslip] = useState<Record<string, PayslipPayment[]>>({})
  const [expandedPayslipId,       setExpandedPayslipId]       = useState<string | null>(null)
  const [paymentFormPayslipId,    setPaymentFormPayslipId]    = useState<string | null>(null)
  const [paymentAmount,           setPaymentAmount]           = useState('')
  const [isFullPayment,           setIsFullPayment]           = useState(true)
  const [paymentMethod,           setPaymentMethod]           = useState('')
  const [paymentNote,             setPaymentNote]             = useState('')
  const [paymentSaving,           setPaymentSaving]           = useState(false)
  const [paymentError,            setPaymentError]            = useState('')

  // ── Salary form (inside detail panel) ────────────────────────────────────────
  const [salaryFormOpen, setSalaryFormOpen] = useState(false)
  const [salaryForm,     setSalaryForm]     = useState<SalaryForm>(EMPTY_SALARY_FORM)
  const [salarySaving,   setSalarySaving]   = useState(false)
  const [salaryError,    setSalaryError]    = useState('')

  // ── Payroll run detail panel ────────────────────────────────────────────────
  const [detailRun,         setDetailRun]         = useState<PayrollRun | null>(null)
  const [detailPayslips,    setDetailPayslips]    = useState<Payslip[]>([])
  const [runDetailState,    setRunDetailState]    = useState<LoadState>('booting')
  const [runDetailError,    setRunDetailError]    = useState('')
  const [runActionSaving,   setRunActionSaving]   = useState(false)
  const [runActionError,    setRunActionError]    = useState('')
  const [markPaidConfirm,   setMarkPaidConfirm]   = useState(false)
  const [removePayslipId,   setRemovePayslipId]   = useState<string | null>(null)  // which row has the confirm state open
  const [removePayslipSaving, setRemovePayslipSaving] = useState(false)
  const [removePayslipError,  setRemovePayslipError]  = useState('')

  // ── "Add payslip(s)" picker (Session 10a-4) — lazy-loaded only when opened,
  // scoped to whichever run is currently in detailRun. ─────────────────────────
  const [addPayslipOpen,     setAddPayslipOpen]     = useState(false)
  const [eligibleState,      setEligibleState]      = useState<LoadState>('booting')
  const [eligibleError,      setEligibleError]      = useState('')
  const [eligibleCandidates, setEligibleCandidates] = useState<EligiblePayslipCandidate[]>([])
  const [addPayslipSaving,   setAddPayslipSaving]   = useState(false)
  const [addPayslipError,    setAddPayslipError]    = useState('')
  const [addPayslipResult,   setAddPayslipResult]   = useState('')   // brief success/partial-failure summary, cleared on next open
  const [reviewCandidate,    setReviewCandidate]    = useState<EligiblePayslipCandidate | null>(null)  // single-add review step

  // ─── Boot: load staff list ──────────────────────────────────────────────────

  const loadStaff = useCallback(async () => {
    setStaffState('loading')
    const res = await loadStaffList()
    if (!res.ok) {
      setStaffError(res.error)
      setStaffState('error')
      return
    }
    setStaffList(res.data)
    setStaffState(res.data.length === 0 ? 'empty' : 'ready')
  }, [])

  useEffect(() => { loadStaff() }, [loadStaff])

  // ─── Load leave types + leave requests when Leave tab is active ────────────

  const loadLeaveTypeList = useCallback(async () => {
    setLeaveTypesState('loading')
    const res = await loadLeaveTypes()
    if (!res.ok) { setLeaveTypesState('error'); return }
    setLeaveTypes(res.data)
    setLeaveTypesState(res.data.length === 0 ? 'empty' : 'ready')
  }, [])

  const loadLeaveList = useCallback(async () => {
    setLeaveState('loading')
    const res = await loadLeaveRequests({
      status: leaveFilter || null,
      // Staff without hr.leave.view_all only ever see their own requests
      staffId: canViewAllLeave ? null : currentStaffId,
    })
    if (!res.ok) {
      setLeaveError(res.error)
      setLeaveState('error')
      return
    }
    setLeaveRequests(res.data)
    setLeaveState(res.data.length === 0 ? 'empty' : 'ready')
  }, [leaveFilter, canViewAllLeave, currentStaffId])

  useEffect(() => {
    if (moduleTab === 'leave') {
      loadLeaveTypeList()
      loadLeaveList()
    }
  }, [moduleTab, loadLeaveTypeList, loadLeaveList])

  // ─── Load payroll runs when Payroll tab is active ──────────────────────────

  const loadPayrollList = useCallback(async () => {
    setPayrollState('loading')
    const res = await loadPayrollRuns()
    if (!res.ok) {
      setPayrollError(res.error)
      setPayrollState('error')
      return
    }
    setPayrollRuns(res.data)
    setPayrollState(res.data.length === 0 ? 'empty' : 'ready')
  }, [])

  useEffect(() => {
    if (moduleTab === 'payroll') loadPayrollList()
  }, [moduleTab, loadPayrollList])

  // "Who's due this month" — loads only while the panel is open, and reloads
  // whenever the selected month changes. Never fires on module boot.
  const loadDueThisMonth = useCallback(async () => {
    setDueThisMonthState('loading')
    setDueThisMonthError('')
    const res = await loadStaffDueForPayment(schoolId, dueThisMonthMonth)
    if (!res.ok) {
      setDueThisMonthError(res.error)
      setDueThisMonthState('error')
      return
    }
    setDueThisMonthData(res.data)
    setDueThisMonthState(res.data.length === 0 ? 'empty' : 'ready')
  }, [schoolId, dueThisMonthMonth])

  useEffect(() => {
    if (moduleTab === 'payroll' && dueThisMonthOpen) loadDueThisMonth()
  }, [moduleTab, dueThisMonthOpen, loadDueThisMonth])

  // ─── Client-side search filter (staff tab) ─────────────────────────────────

  const filteredStaff = searchQuery.trim()
    ? staffList.filter(s => s.full_name.toLowerCase().includes(searchQuery.toLowerCase()))
    : staffList

  // ─── Open staff detail panel ────────────────────────────────────────────────

  async function openStaffDetail(staffId: string) {
    setDetailTab('details')
    setDetailDataState('loading')
    setDetailDataError('')
    setEditForm(null)
    setSalaryFormOpen(false)
    setSalaryError('')
    setStaffAssignmentsState('loading')
    setPasswordRevealed(false)
    setRegenerateConfirm(false)
    setRegenerateError('')
    setDefaultPasswordState('loading')

    const res = await loadStaffDetail(staffId)
    if (!res.ok) {
      setDetailDataError(res.error)
      setDetailDataState('error')
      return
    }
    setDetailStaff(res.data)
    setDetailDataState('ready')

    // Teaching assignments load independently of the core detail fetch — a
    // failure here shouldn't block the rest of the panel from rendering, it
    // just leaves the assignments summary showing its own error state.
    const assignmentsRes = await loadStaffTeachingAssignments(staffId)
    if (assignmentsRes.ok) {
      setStaffAssignments(assignmentsRes.data)
      setStaffAssignmentsState(assignmentsRes.data.length === 0 ? 'empty' : 'ready')
    } else {
      setStaffAssignmentsState('error')
    }

    // Tier 8 fix: assignmentOptions (specifically currentSessionId) was
    // previously only loaded lazily, on Edit-mode entry (see
    // ensureAssignmentOptionsLoaded, still used for that path too — it's a
    // no-op once state is 'ready'). But the "Currently teaching" / "Teaching
    // history" split just above reads assignmentOptions?.currentSessionId on
    // every render of this panel, before Edit is ever opened. With
    // currentSessionId still null at that point, the split's `currentId ??
    // undefined` comparison put every real assignment — including the
    // current session's — into "Teaching history," and "Currently teaching"
    // always read empty, even though teaching_assignments had correct rows
    // (confirmed correct independently by Timetable/TeacherDashboard).
    // Loading it here, alongside staffAssignments, means the split is
    // correct the moment the panel opens, not only after Edit has been
    // clicked once.
    void ensureAssignmentOptionsLoaded()

    // Default password (Session 10b) — also loads independently. A non-admin
    // caller gets { ok: true, data: null } (the view's own RLS scoping, not
    // an error), so this naturally resolves to 'empty' for them and the
    // panel section below simply doesn't render — no separate isAdmin gate
    // needed here beyond canManageStaff already gating the section itself.
    const passwordRes = await loadStaffDefaultPassword(staffId)
    if (passwordRes.ok) {
      setDefaultPassword(passwordRes.data)
      setDefaultPasswordState(passwordRes.data ? 'ready' : 'empty')
    } else {
      setDefaultPasswordState('error')
    }
  }

  function closeStaffDetail() {
    setDetailStaff(null)
    setEditForm(null)
    setStaffAssignments([])
    setStaffAssignmentsState('booting')
    setDefaultPassword(null)
    setDefaultPasswordState('booting')
    setPasswordRevealed(false)
    setRegenerateConfirm(false)
    setRegenerateError('')
  }

  async function refreshStaffDetail(staffId: string) {
    const res = await loadStaffDetail(staffId)
    if (res.ok) setDetailStaff(res.data)
    await loadStaff()
    const assignmentsRes = await loadStaffTeachingAssignments(staffId)
    if (assignmentsRes.ok) {
      setStaffAssignments(assignmentsRes.data)
      setStaffAssignmentsState(assignmentsRes.data.length === 0 ? 'empty' : 'ready')
    }
  }

  // ─── Default password handlers (Session 10b) ───────────────────────────────
  // Two-step confirm before regenerating — this immediately invalidates the
  // staff member's current password (whatever it currently is, temp or
  // self-chosen), so it needs the same tap-to-confirm pattern as other
  // irreversible actions in this file (e.g. "Mark paid").

  async function handleRegeneratePassword() {
    if (!detailStaff) return
    if (!regenerateConfirm) {
      setRegenerateConfirm(true)
      return
    }
    setRegenerateSaving(true)
    setRegenerateError('')
    const res = await regenerateStaffPassword({ schoolId, staffId: detailStaff.id })
    setRegenerateSaving(false)
    setRegenerateConfirm(false)
    if (!res.ok) {
      setRegenerateError(res.error)
      return
    }
    // The edge function's response already carries the freshly-generated
    // plaintext password — show it immediately rather than re-fetching the
    // view (avoids a redundant round trip, and the view would return the
    // exact same value anyway since the function already wrote it).
    setDefaultPassword({
      password: res.data.temp_password,
      set_at:   new Date().toISOString(),
      expired:  false,
      claimed:  false,
    })
    setDefaultPasswordState('ready')
    setPasswordRevealed(true)
  }

  function handlePrintPassword() {
    if (!detailStaff || !defaultPassword) return
    const w = window.open('', '_blank', 'noopener,noreferrer')
    if (!w) return
    // Minimal, dependency-free print document — matches the "no extra
    // libraries for a one-off print" approach used elsewhere in the app
    // (e.g. TimetableModule's print page).
    w.document.write(`
      <html>
        <head>
          <title>Login details — ${detailStaff.full_name}</title>
          <style>
            body { font-family: system-ui, sans-serif; padding: 32px; color: #111827; }
            h1 { font-size: 1.1rem; margin-bottom: 4px; }
            p { margin: 4px 0; }
            .label { color: #6b7280; font-size: 0.8rem; }
            .value { font-size: 1rem; font-weight: 600; }
            .code { font-family: monospace; font-size: 1.25rem; letter-spacing: 0.05em; background: #f3f4f6; padding: 8px 12px; border-radius: 6px; display: inline-block; margin-top: 4px; }
          </style>
        </head>
        <body>
          <h1>${detailStaff.full_name} — login details</h1>
          <p class="label">Email</p>
          <p class="value">${detailStaff.email ?? '—'}</p>
          <p class="label">Temporary password</p>
          <p class="code">${defaultPassword.password}</p>
          <p class="label" style="margin-top: 16px;">Set on ${formatDate(defaultPassword.set_at)}. This password should be changed on first sign-in via Account → Change password.</p>
        </body>
      </html>
    `)
    w.document.close()
    w.focus()
    w.print()
  }

  // ─── Staff edit handlers ────────────────────────────────────────────────────

  // Lazy-load the roles catalog the first time it's needed (edit mode entered),
  // not at module boot — mirrors the load-state pattern used for every other
  // list in this file rather than a bare boolean.
  async function ensureRolesCatalogLoaded() {
    if (rolesCatalogState === 'ready') return
    setRolesCatalogState('loading')
    const { data, error } = await loadRoles(schoolId)
    if (error) {
      setRolesCatalogState('error')
      return
    }
    setRolesCatalog(data)
    setRolesCatalogState(data.length === 0 ? 'empty' : 'ready')
  }

  // Lazy-load subjects/leaf-classes/current-session-id for the teaching
  // assignment picker (Session 10b). Originally edit-only-lazy, same
  // rationale as the roles catalog above; now (Tier 8 fix) also called
  // eagerly from openStaffDetail() so currentSessionId is available for the
  // "Currently teaching" / "Teaching history" split before Edit is ever
  // opened — the guard below still makes this a no-op if already loaded.
  async function ensureAssignmentOptionsLoaded() {
    if (assignmentOptionsState === 'ready') return
    setAssignmentOptionsState('loading')
    const res = await loadTeachingAssignmentOptions(schoolId)
    if (!res.ok) {
      setAssignmentOptionsState('error')
      return
    }
    setAssignmentOptions(res.data)
    setAssignmentOptionsState('ready')
  }

  function startEditingStaff() {
    if (!detailStaff) return
    // Seed assignment_pairs from staffAssignments filtered to the current
    // session only — per the owner's confirmed design, HR's edit form edits
    // the current session's assignments only; past sessions are read-only
    // history. If assignmentOptions hasn't resolved yet (still loading), this
    // filters against a possibly-null currentSessionId and comes back empty —
    // handled by re-seeding once options finish loading, see the effect below.
    const currentSessionId = assignmentOptions?.currentSessionId ?? null
    setEditForm({
      full_name: detailStaff.full_name,
      email:     detailStaff.email ?? '',
      phone:     detailStaff.phone ?? '',
      hire_date: detailStaff.hire_date ?? '',
      status:    detailStaff.status,
      role_ids:  [...detailStaff.role_ids],
      assignment_pairs: currentSessionId
        ? staffAssignments
            .filter(a => a.session_id === currentSessionId)
            .map(a => ({ subjectId: a.subject_id, classNodeId: a.class_node_id }))
        : [],
    })
    setEditError('')
    ensureRolesCatalogLoaded()
    ensureAssignmentOptionsLoaded()
  }

  function cancelEditingStaff() {
    setEditForm(null)
    setEditError('')
  }

  function toggleEditFormRole(roleId: string) {
    setEditForm(prev => {
      if (!prev) return prev
      const has = prev.role_ids.includes(roleId)
      return {
        ...prev,
        role_ids: has
          ? prev.role_ids.filter(id => id !== roleId)
          : [...prev.role_ids, roleId],
      }
    })
  }

  function toggleEditFormAssignment(subjectId: string, classNodeId: string) {
    setEditForm(prev => {
      if (!prev) return prev
      const has = prev.assignment_pairs.some(p => p.subjectId === subjectId && p.classNodeId === classNodeId)
      return {
        ...prev,
        assignment_pairs: has
          ? prev.assignment_pairs.filter(p => !(p.subjectId === subjectId && p.classNodeId === classNodeId))
          : [...prev.assignment_pairs, { subjectId, classNodeId }],
      }
    })
  }

  // assignmentOptions (and therefore currentSessionId) may still be loading
  // when startEditingStaff() first runs, since it's fetched lazily rather
  // than at module boot. Once it resolves, re-seed assignment_pairs from the
  // now-known current session — without this, opening edit mode before the
  // options finish loading would silently leave assignment_pairs empty even
  // when real current-session assignments exist.
  useEffect(() => {
    if (!editForm || !assignmentOptions?.currentSessionId) return
    if (editForm.assignment_pairs.length > 0) return   // already seeded (or user has already made edits) — don't clobber
    const seeded = staffAssignments
      .filter(a => a.session_id === assignmentOptions.currentSessionId)
      .map(a => ({ subjectId: a.subject_id, classNodeId: a.class_node_id }))
    if (seeded.length > 0) {
      setEditForm(prev => prev && ({ ...prev, assignment_pairs: seeded }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignmentOptions?.currentSessionId])

  // The read-only salary tab shows "school default" as the effective
  // frequency whenever the staff member has no per-staff override — load it
  // as soon as the Salary tab is actually viewed with a real structure
  // present, not only when the edit form opens (openSalaryForm already
  // covers the edit-form case; this covers viewing without editing).
  useEffect(() => {
    if (detailTab !== 'salary') return
    if (!detailStaff?.salary_structure) return
    if (detailStaff.salary_structure.pay_frequency) return   // has its own override — school default not needed for display
    ensureSchoolDefaultFrequencyLoaded()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailTab, detailStaff?.salary_structure?.pay_frequency])

  async function handleSaveStaffEdit() {
    if (!detailStaff || !editForm) return
    if (!editForm.full_name.trim()) {
      setEditError('Name is required.')
      return
    }
    setEditSaving(true)
    setEditError('')
    const res = await updateStaff({
      id:        detailStaff.id,
      full_name: editForm.full_name,
      email:     editForm.email || null,
      phone:     editForm.phone || null,
      hire_date: editForm.hire_date || null,
      status:    editForm.status,
    })
    if (!res.ok) {
      setEditSaving(false)
      setEditError(res.error)
      return
    }

    // Role assignment is a separate table (staff_roles) — written second, after
    // the core staff-record update succeeds. If this leg fails, the name/email/
    // phone/status changes above have already landed; surface the role-specific
    // error distinctly rather than implying the whole save failed.
    const rolesRes = await updateStaffRoles({
      staffId:   detailStaff.id,
      schoolId,
      roleIds:   editForm.role_ids,
    })
    if (!rolesRes.ok) {
      setEditSaving(false)
      setEditError(`Staff details saved, but role assignment failed: ${rolesRes.error}`)
      await refreshStaffDetail(detailStaff.id)
      return
    }

    // Teaching assignments — third and final leg, only attempted if a current
    // session actually exists. No current session (school hasn't set one up
    // yet) means there's nothing meaningful to save here; skip silently
    // rather than surfacing an error for a state the owner can't act on from
    // this form.
    if (assignmentOptions?.currentSessionId) {
      const assignmentsRes = await updateStaffTeachingAssignments({
        staffId:    detailStaff.id,
        schoolId,
        sessionId:  assignmentOptions.currentSessionId,
        pairs:      editForm.assignment_pairs,
      })
      if (!assignmentsRes.ok) {
        setEditSaving(false)
        setEditError(`Staff details and roles saved, but teaching assignments failed: ${assignmentsRes.error}`)
        await refreshStaffDetail(detailStaff.id)
        return
      }
    }

    setEditSaving(false)
    setEditForm(null)
    await refreshStaffDetail(detailStaff.id)
  }

  // ─── Salary form handlers ───────────────────────────────────────────────────

  // Lazy-load the school's default pay frequency the first time it's needed —
  // same rationale/pattern as ensureRolesCatalogLoaded(). Cached module-wide
  // since it's a school-level value, not staff-specific.
  async function ensureSchoolDefaultFrequencyLoaded() {
    if (schoolDefaultFrequencyState === 'ready') return
    setSchoolDefaultFrequencyState('loading')
    const res = await loadSchoolDefaultPayFrequency(schoolId)
    if (!res.ok) {
      setSchoolDefaultFrequencyState('error')
      return
    }
    setSchoolDefaultFrequency(res.data)
    setSchoolDefaultFrequencyState('ready')
  }

  function openSalaryForm() {
    if (!detailStaff) return
    const existing = detailStaff.salary_structure
    setSalaryForm({
      basic_salary:   existing ? String(existing.basic_salary) : '',
      allowances:     existing ? existing.allowances.map(a => ({ ...a })) : [],
      deductions:     existing ? existing.deductions.map(d => ({ ...d })) : [],
      effective_from: todayDateString(),
      pay_frequency:  existing?.pay_frequency ?? '',
    })
    setSalaryError('')
    setSalaryFormOpen(true)
    ensureSchoolDefaultFrequencyLoaded()
  }

  function addAllowanceRow() {
    setSalaryForm(prev => ({ ...prev, allowances: [...prev.allowances, { label: '', amount: 0 }] }))
  }
  function updateAllowanceRow(index: number, field: keyof AllowanceItem, value: string) {
    setSalaryForm(prev => ({
      ...prev,
      allowances: prev.allowances.map((a, i) =>
        i === index ? { ...a, [field]: field === 'amount' ? Number(value) || 0 : value } : a
      ),
    }))
  }
  function removeAllowanceRow(index: number) {
    setSalaryForm(prev => ({ ...prev, allowances: prev.allowances.filter((_, i) => i !== index) }))
  }

  function addDeductionRow() {
    setSalaryForm(prev => ({ ...prev, deductions: [...prev.deductions, { label: '', amount: 0 }] }))
  }
  function updateDeductionRow(index: number, field: keyof DeductionItem, value: string) {
    setSalaryForm(prev => ({
      ...prev,
      deductions: prev.deductions.map((d, i) =>
        i === index ? { ...d, [field]: field === 'amount' ? Number(value) || 0 : value } : d
      ),
    }))
  }
  function removeDeductionRow(index: number) {
    setSalaryForm(prev => ({ ...prev, deductions: prev.deductions.filter((_, i) => i !== index) }))
  }

  async function handleSaveSalary() {
    if (!detailStaff) return
    const basic = parseFloat(salaryForm.basic_salary)
    if (!salaryForm.basic_salary || isNaN(basic) || basic < 0) {
      setSalaryError('Enter a valid basic salary.')
      return
    }
    if (salaryForm.allowances.some(a => !a.label.trim())) {
      setSalaryError('Every allowance needs a label.')
      return
    }
    if (salaryForm.deductions.some(d => !d.label.trim())) {
      setSalaryError('Every deduction needs a label.')
      return
    }
    setSalarySaving(true)
    setSalaryError('')
    const res = await saveSalaryStructure({
      schoolId,
      staffId: detailStaff.id,
      basic_salary: basic,
      allowances: salaryForm.allowances,
      deductions: salaryForm.deductions,
      effective_from: salaryForm.effective_from || todayDateString(),
      pay_frequency: salaryForm.pay_frequency || null,
    })
    setSalarySaving(false)
    if (!res.ok) { setSalaryError(res.error); return }
    setSalaryFormOpen(false)
    await refreshStaffDetail(detailStaff.id)
  }

  // ─── Leave request handlers (self-submit) ───────────────────────────────────

  function openLeaveRequestForm() {
    setLeaveRequestForm(EMPTY_LEAVE_REQUEST_FORM)
    setLeaveRequestError('')
    setLeaveRequestFormOpen(true)
  }

  async function handleSubmitLeaveRequest() {
    if (!currentStaffId) {
      setLeaveRequestError('Your account is not linked to a staff record.')
      return
    }
    if (!leaveRequestForm.leave_type_id) {
      setLeaveRequestError('Select a leave type.')
      return
    }
    if (!leaveRequestForm.start_date || !leaveRequestForm.end_date) {
      setLeaveRequestError('Select start and end dates.')
      return
    }
    if (leaveRequestForm.end_date < leaveRequestForm.start_date) {
      setLeaveRequestError('End date cannot be before start date.')
      return
    }
    setLeaveRequestSaving(true)
    setLeaveRequestError('')
    const res = await submitLeaveRequest({
      schoolId,
      staffId: currentStaffId,
      leaveTypeId: leaveRequestForm.leave_type_id,
      startDate: leaveRequestForm.start_date,
      endDate: leaveRequestForm.end_date,
      reason: leaveRequestForm.reason || null,
    })
    setLeaveRequestSaving(false)
    if (!res.ok) { setLeaveRequestError(res.error); return }
    setLeaveRequestFormOpen(false)
    await loadLeaveList()
  }

  // ─── Leave review handlers (admin approve/reject) ───────────────────────────

  async function handleReviewLeave(requestId: string, decision: 'approved' | 'rejected') {
    if (!authUserId) return
    setLeaveActionId(requestId)
    const res = await reviewLeaveRequest({ requestId, decision, authUserId })
    setLeaveActionId(null)
    if (!res.ok) {
      setLeaveError(res.error)
      return
    }
    await loadLeaveList()
  }

  async function handleCancelLeave(requestId: string) {
    setLeaveActionId(requestId)
    const res = await cancelLeaveRequest(requestId)
    setLeaveActionId(null)
    if (!res.ok) {
      setLeaveError(res.error)
      return
    }
    await loadLeaveList()
  }

  // ─── Leave type form handlers (admin) ────────────────────────────────────────

  function openLeaveTypeForm() {
    setEditingLeaveTypeId(null)
    setLeaveTypeForm(EMPTY_LEAVE_TYPE_FORM)
    setLeaveTypeError('')
    setLeaveTypeFormOpen(true)
    setTimeout(() => leaveTypeNameRef.current?.focus(), 80)
  }

  function openLeaveTypeFormForEdit(lt: LeaveType) {
    setEditingLeaveTypeId(lt.id)
    setLeaveTypeForm({
      name: lt.name,
      paid: lt.paid,
      annual_allowance_days: lt.annual_allowance_days !== null ? String(lt.annual_allowance_days) : '',
    })
    setLeaveTypeError('')
    setLeaveTypeFormOpen(true)
    setTimeout(() => leaveTypeNameRef.current?.focus(), 80)
  }

  async function handleSaveLeaveType() {
    if (!leaveTypeForm.name.trim()) {
      setLeaveTypeError('Leave type name is required.')
      leaveTypeNameRef.current?.focus()
      return
    }
    const days = leaveTypeForm.annual_allowance_days
      ? parseInt(leaveTypeForm.annual_allowance_days, 10)
      : null
    if (leaveTypeForm.annual_allowance_days && (isNaN(days!) || days! < 0)) {
      setLeaveTypeError('Annual allowance must be a valid number of days.')
      return
    }
    setLeaveTypeSaving(true)
    setLeaveTypeError('')

    const res = editingLeaveTypeId
      ? await updateLeaveType({
          id: editingLeaveTypeId,
          name: leaveTypeForm.name,
          paid: leaveTypeForm.paid,
          annual_allowance_days: days,
        })
      : await createLeaveType({
          schoolId,
          name: leaveTypeForm.name,
          paid: leaveTypeForm.paid,
          annual_allowance_days: days,
        })

    setLeaveTypeSaving(false)
    if (!res.ok) { setLeaveTypeError(res.error); return }
    setLeaveTypeFormOpen(false)
    setEditingLeaveTypeId(null)
    await loadLeaveTypeList()
  }

  // ─── Payroll run form handlers (admin create) ────────────────────────────────

  function openRunForm() {
    setRunForm(EMPTY_PAYROLL_RUN_FORM)
    setRunError('')
    setRunFormOpen(true)
  }

  async function handleCreateRun() {
    if (!runForm.period_label.trim()) {
      setRunError('Enter a period label, e.g. "June 2026".')
      return
    }
    if (!runForm.period_start || !runForm.period_end) {
      setRunError('Select a start and end date for the period.')
      return
    }
    if (runForm.period_end < runForm.period_start) {
      setRunError('Period end cannot be before period start.')
      return
    }
    setRunSaving(true)
    setRunError('')
    const res = await createPayrollRun({
      schoolId,
      period_label: runForm.period_label,
      period_start: runForm.period_start,
      period_end:   runForm.period_end,
    })
    setRunSaving(false)
    if (!res.ok) { setRunError(res.error); return }
    setRunFormOpen(false)
    await loadPayrollList()
  }

  // ─── Payroll run detail panel ────────────────────────────────────────────────

  async function openRunDetail(run: PayrollRun) {
    setDetailRun(run)
    setRunDetailState('loading')
    setRunDetailError('')
    setRunActionError('')
    setMarkPaidConfirm(false)
    setExpandedPayslipId(null)
    setPaymentFormPayslipId(null)
    setPaymentHistoryByPayslip({})
    setAddPayslipOpen(false)
    setEligibleCandidates([])
    setAddPayslipResult('')
    setAddPayslipError('')
    setReviewCandidate(null)

    const res = await loadPayslipsForRun(run.id)
    if (!res.ok) {
      setRunDetailError(res.error)
      setRunDetailState('error')
      return
    }
    setDetailPayslips(res.data)
    setRunDetailState(res.data.length === 0 ? 'empty' : 'ready')
  }

  function closeRunDetail() {
    setDetailRun(null)
    setMarkPaidConfirm(false)
    setExpandedPayslipId(null)
    setPaymentFormPayslipId(null)
    setAddPayslipOpen(false)
    setReviewCandidate(null)
  }

  async function refreshRunDetail(runId: string) {
    const res = await loadPayslipsForRun(runId)
    if (res.ok) {
      setDetailPayslips(res.data)
      setRunDetailState(res.data.length === 0 ? 'empty' : 'ready')
    }
    const runsRes = await loadPayrollRuns()
    if (runsRes.ok) {
      setPayrollRuns(runsRes.data)
      const updated = runsRes.data.find(r => r.id === runId)
      if (updated) setDetailRun(updated)
    }
  }

  // ─── "Add payslip(s)" (Session 10a-4) ────────────────────────────────────────

  async function openAddPayslip() {
    setAddPayslipOpen(true)
    setAddPayslipError('')
    setAddPayslipResult('')
    setReviewCandidate(null)
    if (!detailRun) return
    setEligibleState('loading')
    const res = await loadEligibleStaffForRun(schoolId, detailRun.id)
    if (!res.ok) {
      setEligibleError(res.error)
      setEligibleState('error')
      return
    }
    setEligibleCandidates(res.data)
    setEligibleState(res.data.length === 0 ? 'empty' : 'ready')
  }

  async function handleAddAllEligible() {
    if (!detailRun || eligibleCandidates.length === 0) return
    setAddPayslipSaving(true)
    setAddPayslipError('')
    const res = await addAllEligiblePayslips(schoolId, detailRun.id, eligibleCandidates)
    setAddPayslipSaving(false)
    if (!res.ok) { setAddPayslipError(res.error); return }
    const { added, failed } = res.data
    setAddPayslipResult(
      failed.length === 0
        ? `Added ${added} payslip${added !== 1 ? 's' : ''}.`
        : `Added ${added} payslip${added !== 1 ? 's' : ''}. ${failed.length} failed: ${failed.map(f => f.staff_name).join(', ')}.`
    )
    await refreshRunDetail(detailRun.id)
    // Re-check who's still eligible rather than assuming the whole batch landed.
    const reload = await loadEligibleStaffForRun(schoolId, detailRun.id)
    if (reload.ok) {
      setEligibleCandidates(reload.data)
      setEligibleState(reload.data.length === 0 ? 'empty' : 'ready')
    }
  }

  // Individual add shows a review step first (see openAddPayslip's sibling
  // bulk path, which skips review deliberately — see §10a-4 design note).
  function startReviewCandidate(c: EligiblePayslipCandidate) {
    setReviewCandidate(c)
    setAddPayslipError('')
  }

  async function confirmAddReviewedCandidate() {
    if (!detailRun || !reviewCandidate) return
    setAddPayslipSaving(true)
    setAddPayslipError('')
    const res = await addPayslip({
      schoolId,
      payrollRunId: detailRun.id,
      staffId: reviewCandidate.staff_id,
      gross_amount: reviewCandidate.gross_amount,
      total_deductions: reviewCandidate.total_deductions,
      net_amount: reviewCandidate.net_amount,
      breakdown: reviewCandidate.breakdown,
    })
    setAddPayslipSaving(false)
    if (!res.ok) { setAddPayslipError(res.error); return }
    setAddPayslipResult(`Added payslip for ${reviewCandidate.staff_name}.`)
    setReviewCandidate(null)
    setEligibleCandidates(prev => prev.filter(c => c.staff_id !== reviewCandidate.staff_id))
    await refreshRunDetail(detailRun.id)
  }

  async function handleApproveRun() {
    if (!detailRun || !authUserId) return
    setRunActionSaving(true)
    setRunActionError('')
    const res = await approvePayrollRun({ runId: detailRun.id, authUserId })
    setRunActionSaving(false)
    if (!res.ok) { setRunActionError(res.error); return }
    await refreshRunDetail(detailRun.id)
  }

  async function handleMarkPaid() {
    if (!detailRun) return
    if (!markPaidConfirm) {
      setMarkPaidConfirm(true)
      return
    }
    setRunActionSaving(true)
    setRunActionError('')
    const res = await markPayrollRunPaid(detailRun.id)
    setRunActionSaving(false)
    setMarkPaidConfirm(false)
    if (!res.ok) { setRunActionError(res.error); return }
    await refreshRunDetail(detailRun.id)
  }

  // Session 10c-2 — remove a staff member's payslip from a draft run. Mirrors
  // handleMarkPaid's tap-to-confirm pattern (setRemovePayslipId tracks which
  // row is asking for confirmation; a second click on the same row commits).
  async function handleRemovePayslip(payslip: Payslip) {
    if (removePayslipId !== payslip.id) {
      setRemovePayslipId(payslip.id)
      setRemovePayslipError('')
      return
    }
    setRemovePayslipSaving(true)
    setRemovePayslipError('')
    const res = await removePayslipFromRun({
      payslipId: payslip.id,
      payrollRunId: payslip.payroll_run_id,
    })
    setRemovePayslipSaving(false)
    setRemovePayslipId(null)
    if (!res.ok) { setRemovePayslipError(res.error); return }
    await refreshRunDetail(payslip.payroll_run_id)
  }

  function cancelRemovePayslip() {
    setRemovePayslipId(null)
    setRemovePayslipError('')
  }

  // ─── Payslip payment handlers (Session 10c) ────────────────────────────────

  async function toggleExpandPayslip(payslipId: string) {
    if (expandedPayslipId === payslipId) {
      setExpandedPayslipId(null)
      return
    }
    setExpandedPayslipId(payslipId)
    if (!paymentHistoryByPayslip[payslipId]) {
      const res = await loadPayslipPayments(payslipId)
      if (res.ok) {
        setPaymentHistoryByPayslip(prev => ({ ...prev, [payslipId]: res.data }))
      }
    }
  }

  function openPaymentForm(payslipId: string) {
    setPaymentFormPayslipId(payslipId)
    setPaymentAmount('')
    setIsFullPayment(true)
    setPaymentMethod('')
    setPaymentNote('')
    setPaymentError('')
  }

  function cancelPaymentForm() {
    setPaymentFormPayslipId(null)
    setPaymentError('')
  }

  async function handleRecordPayment(payslip: Payslip) {
    if (!currentStaffId) {
      setPaymentError('Could not identify who is recording this payment. Try reloading.')
      return
    }
    const remaining = payslip.net_amount - payslip.amount_paid
    let amount: number
    if (isFullPayment) {
      // "Pay in full" — use the exact remaining balance, no manual typing
      // (and no float-precision drift from re-parsing a formatted string).
      amount = remaining
    } else {
      amount = parseFloat(paymentAmount)
      if (!paymentAmount || isNaN(amount) || amount <= 0) {
        setPaymentError('Enter a valid payment amount.')
        return
      }
      if (amount > remaining) {
        // Not blocked at the service layer (see recordPayslipPayment's own
        // comment) — but the UI warns here since an accidental overpayment
        // entry is the likelier mistake, not a deliberate one.
        setPaymentError(`This is more than the ${formatNaira(remaining)} still owed on this payslip. Enter an amount up to that, or correct the payslip amount first.`)
        return
      }
    }
    setPaymentSaving(true)
    setPaymentError('')
    const res = await recordPayslipPayment({
      schoolId,
      payslipId: payslip.id,
      amount,
      paid_at: new Date().toISOString(),
      method: paymentMethod.trim() || null,
      note: paymentNote.trim() || null,
      recordedByStaffId: currentStaffId,
    })
    setPaymentSaving(false)
    if (!res.ok) { setPaymentError(res.error); return }
    setPaymentFormPayslipId(null)
    // Refresh both the payslip list (amount_paid/payment_status recomputed)
    // and, if this payslip's history panel is open, its payment list too.
    await refreshRunDetail(payslip.payroll_run_id)
    const historyRes = await loadPayslipPayments(payslip.id)
    if (historyRes.ok) {
      setPaymentHistoryByPayslip(prev => ({ ...prev, [payslip.id]: historyRes.data }))
    }
  }

  // ─── Render helpers ────────────────────────────────────────────────────────

  const pendingLeaveCount = canViewAllLeave
    ? leaveRequests.filter(r => r.status === 'pending').length
    : 0

  function renderHeader() {
    return (
      <div className="hr-header">
        <div className="hr-header-top">
          <h2 className="hr-title">HR</h2>
        </div>

        <div className="hr-module-tabs">
          {(['staff', 'leave', 'payroll'] as ModuleTab[]).map(tab => (
            <button
              key={tab}
              className={`hr-module-tab${moduleTab === tab ? ' hr-module-tab--active' : ''}`}
              onClick={() => setModuleTab(tab)}
            >
              {tab === 'staff' ? 'Staff' : tab === 'leave' ? 'Leave' : 'Payroll'}
              {tab === 'leave' && leaveFilter === 'pending' && pendingLeaveCount > 0 && (
                <span className="hr-module-tab-dot" aria-label={`${pendingLeaveCount} pending`} />
              )}
            </button>
          ))}
        </div>

        {/* Search — staff tab only */}
        {moduleTab === 'staff' && (
          <div className="hr-filter-bar">
            <input
              type="search"
              className="hr-search"
              placeholder="Search by name…"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
          </div>
        )}

        {/* Status filter — leave tab only */}
        {moduleTab === 'leave' && (
          <div className="hr-filter-bar">
            <select
              className="hr-status-filter"
              value={leaveFilter}
              onChange={e => setLeaveFilter(e.target.value as typeof leaveFilter)}
            >
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
              <option value="cancelled">Cancelled</option>
              <option value="">All</option>
            </select>
          </div>
        )}
      </div>
    )
  }

  function renderBody() {
    if (moduleTab === 'staff')   return renderStaffTab()
    if (moduleTab === 'leave')   return renderLeaveTab()
    if (moduleTab === 'payroll') return renderPayrollTab()
    return null
  }

  // ── Staff tab ───────────────────────────────────────────────────────────────

  function renderStaffTab() {
    if (staffState === 'loading' || staffState === 'booting') {
      return (
        <div className="hr-list-skel">
          {[1,2,3,4,5].map(i => <div key={i} className="hr-row-skel skeleton" />)}
        </div>
      )
    }
    if (staffState === 'error') {
      return (
        <div className="hr-error-state">
          <span className="hr-error-icon" style={{ color: 'var(--color-warning)' }}><Icon name="alert-triangle" /></span>
          <p className="hr-error-msg">{staffError}</p>
          <button className="hr-retry-btn" onClick={loadStaff}>Retry</button>
        </div>
      )
    }
    if (staffState === 'empty') {
      return (
        <div className="hr-empty-state">
          <span className="hr-empty-icon"><Icon name="users" /></span>
          <p className="hr-empty-msg">No staff records yet.</p>
        </div>
      )
    }
    if (filteredStaff.length === 0) {
      return (
        <div className="hr-empty-state hr-empty-state--search">
          <span className="hr-empty-icon"><Icon name="search" /></span>
          <p className="hr-empty-msg">No staff match "{searchQuery}".</p>
        </div>
      )
    }

    return (
      <>
        <p className="hr-count">
          {filteredStaff.length} staff member{filteredStaff.length !== 1 ? 's' : ''}
        </p>
        <ul className="hr-staff-list">
          {filteredStaff.map(s => (
            <li key={s.id} className="hr-staff-row">
              <button className="hr-staff-row-btn" onClick={() => openStaffDetail(s.id)}>
                <div className={`hr-staff-row-avatar${s.status !== 'active' ? ' hr-staff-row-avatar--inactive' : ''}`}>
                  {s.full_name.charAt(0).toUpperCase()}
                </div>
                <div className="hr-staff-row-body">
                  <span className="hr-staff-row-name">{s.full_name}</span>
                  <div className="hr-staff-row-meta">
                    {s.roles.length > 0
                      ? s.roles.map(r => <span key={r} className="hr-role-chip">{r}</span>)
                      : <span className="hr-role-chip">No role assigned</span>}
                  </div>
                </div>
                <div className="hr-staff-row-right">
                  <span className={`hr-status-chip hr-status-chip--${s.status}`}>
                    {statusLabel(s.status)}
                  </span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      </>
    )
  }

  // ── Leave tab ───────────────────────────────────────────────────────────────

  function renderLeaveTab() {
    return (
      <div className="hr-tab-body">
        {canRequestLeave && currentStaffId && (
          <div className="hr-actions-row">
            <button className="hr-add-btn" onClick={openLeaveRequestForm}>
              + Request leave
            </button>
          </div>
        )}

        {leaveRequestFormOpen && renderLeaveRequestForm()}

        {leaveState === 'loading' || leaveState === 'booting' ? (
          <div className="hr-list-skel">
            {[1,2,3].map(i => <div key={i} className="hr-row-skel skeleton" />)}
          </div>
        ) : leaveState === 'error' ? (
          <div className="hr-error-state">
            <span className="hr-error-icon" style={{ color: 'var(--color-warning)' }}><Icon name="alert-triangle" /></span>
            <p className="hr-error-msg">{leaveError}</p>
            <button className="hr-retry-btn" onClick={loadLeaveList}>Retry</button>
          </div>
        ) : leaveState === 'empty' || leaveRequests.length === 0 ? (
          <div className="hr-empty-state">
            <span className="hr-empty-icon"><Icon name="calendar" /></span>
            <p className="hr-empty-msg">
              {leaveFilter ? `No ${leaveFilter} leave requests.` : 'No leave requests yet.'}
            </p>
          </div>
        ) : (
          <ul className="hr-leave-list">
            {leaveRequests.map(r => (
              <li key={r.id} className="hr-leave-row">
                <div className="hr-leave-row-main">
                  <span className="hr-leave-staff-name">{r.staff_name}</span>
                  <span className={`hr-payroll-status hr-payroll-status--${r.status === 'pending' ? 'draft' : r.status === 'approved' ? 'paid' : r.status === 'rejected' ? 'draft' : 'draft'}`}>
                    {statusLabel(r.status)}
                  </span>
                </div>
                <div className="hr-leave-row-meta">
                  <span className="hr-leave-type">{r.leave_type_name}</span>
                  <span className="hr-leave-dates">
                    {formatDate(r.start_date)} – {formatDate(r.end_date)}
                  </span>
                  <span className="hr-leave-days">{r.days} day{r.days !== 1 ? 's' : ''}</span>
                </div>
                {r.reason && <p className="hr-leave-reason">"{r.reason}"</p>}
                {r.reviewed_by_name && (
                  <span className="hr-leave-by">
                    {statusLabel(r.status)} by {r.reviewed_by_name}
                    {r.reviewed_at ? ` · ${formatDate(r.reviewed_at)}` : ''}
                  </span>
                )}

                {canApproveLeave && r.status === 'pending' && (
                  <div className="hr-leave-actions">
                    <button
                      className="hr-leave-approve-btn"
                      onClick={() => handleReviewLeave(r.id, 'approved')}
                      disabled={leaveActionId === r.id}
                    >
                      {leaveActionId === r.id ? 'Saving…' : 'Approve'}
                    </button>
                    <button
                      className="hr-leave-reject-btn"
                      onClick={() => handleReviewLeave(r.id, 'rejected')}
                      disabled={leaveActionId === r.id}
                    >
                      Reject
                    </button>
                  </div>
                )}
                {!canApproveLeave && r.status === 'pending' && r.staff_id === currentStaffId && (
                  <div className="hr-leave-actions">
                    <button
                      className="hr-leave-cancel-btn"
                      onClick={() => handleCancelLeave(r.id)}
                      disabled={leaveActionId === r.id}
                    >
                      {leaveActionId === r.id ? 'Cancelling…' : 'Cancel request'}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {/* Leave types management — CONFIRMED CATALOG GAP (Session 10): no hr.*
            key covers configuring leave types (paid/unpaid, annual allowance
            days) as distinct from hr.leave.approve ("Approve or reject leave
            requests" — a per-request workflow verb, not config) or
            hr.staff.manage ("Add, edit, and deactivate staff" — staff records,
            not leave policy). Intentionally left on isAdmin rather than forced
            onto a mismatched key. Candidate for a future permissions-table
            insert, e.g. hr.leave.types_manage — not added here since this
            session can't run a migration. See §11 for the full owner
            discussion. */}
        {isAdmin && (
          <div className="hr-leavetypes-section">
            <div className="hr-actions-row">
              <p className="hr-section-title" style={{ flex: 1, marginBottom: 0 }}>Leave types</p>
              <button className="hr-add-btn" onClick={openLeaveTypeForm}>
                + Add type
              </button>
            </div>

            {leaveTypeFormOpen && renderLeaveTypeForm()}

            {leaveTypesState === 'loading' || leaveTypesState === 'booting' ? (
              <div className="hr-list-skel">
                {[1,2].map(i => <div key={i} className="hr-row-skel skeleton" />)}
              </div>
            ) : leaveTypes.length === 0 ? (
              <p className="hr-empty-msg" style={{ padding: '8px 0' }}>
                No leave types configured yet. Add one (e.g. "Annual", "Sick") to let staff request leave.
              </p>
            ) : (
              <ul className="hr-leavetype-list">
                {leaveTypes.map(lt => (
                  <li key={lt.id} className="hr-leavetype-row">
                    <span className="hr-leavetype-name">{lt.name}</span>
                    <div className="hr-leavetype-meta">
                      <span className={`hr-leavetype-badge${!lt.paid ? ' hr-leavetype-badge--unpaid' : ''}`}>
                        {lt.paid ? 'Paid' : 'Unpaid'}
                      </span>
                      {lt.annual_allowance_days !== null && (
                        <span className="hr-leavetype-badge">{lt.annual_allowance_days}d/yr</span>
                      )}
                      <button
                        className="hr-leavetype-edit-btn"
                        onClick={() => openLeaveTypeFormForEdit(lt)}
                        aria-label={`Edit ${lt.name}`}
                      >
                        Edit
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    )
  }

  function renderLeaveRequestForm() {
    return (
      <div className="hr-confirm-banner" style={{ background: 'var(--color-neutral-50)', borderColor: 'var(--color-border)' }}>
        <p className="hr-section-title">Request leave</p>
        <div className="hr-field">
          <label className="hr-label" htmlFor="hr-lr-type">
            Leave type <span className="hr-required">*</span>
          </label>
          <select
            id="hr-lr-type"
            className="hr-select"
            value={leaveRequestForm.leave_type_id}
            onChange={e => setLeaveRequestForm(prev => ({ ...prev, leave_type_id: e.target.value }))}
          >
            <option value="">— select leave type —</option>
            {leaveTypes.map(lt => (
              <option key={lt.id} value={lt.id}>{lt.name}</option>
            ))}
          </select>
        </div>
        <div className="hr-field">
          <label className="hr-label" htmlFor="hr-lr-start">
            Start date <span className="hr-required">*</span>
          </label>
          <input
            id="hr-lr-start"
            className="hr-input"
            type="date"
            value={leaveRequestForm.start_date}
            onChange={e => setLeaveRequestForm(prev => ({ ...prev, start_date: e.target.value }))}
          />
        </div>
        <div className="hr-field">
          <label className="hr-label" htmlFor="hr-lr-end">
            End date <span className="hr-required">*</span>
          </label>
          <input
            id="hr-lr-end"
            className="hr-input"
            type="date"
            min={leaveRequestForm.start_date}
            value={leaveRequestForm.end_date}
            onChange={e => setLeaveRequestForm(prev => ({ ...prev, end_date: e.target.value }))}
          />
        </div>
        <div className="hr-field">
          <label className="hr-label" htmlFor="hr-lr-reason">Reason</label>
          <textarea
            id="hr-lr-reason"
            className="hr-textarea"
            rows={3}
            placeholder="Optional"
            value={leaveRequestForm.reason}
            onChange={e => setLeaveRequestForm(prev => ({ ...prev, reason: e.target.value }))}
          />
        </div>
        {leaveRequestError && <p className="hr-form-error" role="alert">{leaveRequestError}</p>}
        <div className="hr-form-footer" style={{ padding: '12px 0 0', border: 'none' }}>
          <button className="hr-cancel-btn" onClick={() => setLeaveRequestFormOpen(false)} disabled={leaveRequestSaving}>
            Cancel
          </button>
          <button className="hr-save-btn" onClick={handleSubmitLeaveRequest} disabled={leaveRequestSaving}>
            {leaveRequestSaving ? 'Submitting…' : 'Submit request'}
          </button>
        </div>
      </div>
    )
  }

  function renderLeaveTypeForm() {
    const isEdit = !!editingLeaveTypeId
    return (
      <div
        className="hr-form-overlay"
        onClick={e => { if (e.target === e.currentTarget) { setLeaveTypeFormOpen(false); setEditingLeaveTypeId(null) } }}
      >
        <div className="hr-form-sheet" role="dialog" aria-modal aria-label={isEdit ? 'Edit leave type' : 'Add leave type'}>
          <div className="hr-form-handle" />
          <div className="hr-form-header">
            <h3 className="hr-form-title">{isEdit ? 'Edit leave type' : 'Add leave type'}</h3>
            <button className="hr-form-close" onClick={() => { setLeaveTypeFormOpen(false); setEditingLeaveTypeId(null) }} aria-label="Close"><Icon name="x" /></button>
          </div>
          <div className="hr-form-body">
            <div className="hr-field">
              <label className="hr-label" htmlFor="hr-lt-name">
                Name <span className="hr-required">*</span>
              </label>
              <input
                id="hr-lt-name"
                ref={leaveTypeNameRef}
                className="hr-input"
                type="text"
                placeholder="e.g. Annual, Sick, Maternity"
                value={leaveTypeForm.name}
                onChange={e => setLeaveTypeForm(prev => ({ ...prev, name: e.target.value }))}
                autoComplete="off"
              />
            </div>
            <div className="hr-field">
              <label className="hr-label" htmlFor="hr-lt-days">Annual allowance (days)</label>
              <input
                id="hr-lt-days"
                className="hr-input"
                type="number"
                min="0"
                placeholder="e.g. 21"
                value={leaveTypeForm.annual_allowance_days}
                onChange={e => setLeaveTypeForm(prev => ({ ...prev, annual_allowance_days: e.target.value }))}
              />
            </div>
            <div className="hr-field">
              <label className="hr-checkbox-label">
                <input
                  type="checkbox"
                  checked={leaveTypeForm.paid}
                  onChange={e => setLeaveTypeForm(prev => ({ ...prev, paid: e.target.checked }))}
                />
                Paid leave
              </label>
            </div>
            {leaveTypeError && <p className="hr-form-error" role="alert">{leaveTypeError}</p>}
          </div>
          <div className="hr-form-footer">
            <button className="hr-cancel-btn" onClick={() => { setLeaveTypeFormOpen(false); setEditingLeaveTypeId(null) }} disabled={leaveTypeSaving}>
              Cancel
            </button>
            <button className="hr-save-btn" onClick={handleSaveLeaveType} disabled={leaveTypeSaving}>
              {leaveTypeSaving ? 'Saving…' : isEdit ? 'Save changes' : 'Add leave type'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── Payroll tab ──────────────────────────────────────────────────────────────

  // Human-readable label for a DueReason — mirrors the estimate-not-mandate
  // framing from the service layer (§ Session 10d): this tells an admin why
  // the system thinks someone is due, never that they must be paid.
  function dueReasonLabel(s: StaffPaymentDueStatus): string {
    switch (s.reason) {
      case 'monthly_no_payslip_this_month':
        return 'Monthly — no payslip yet this month'
      case 'termly_term_ends_this_month':
        return 'Termly — current term ends this month'
      case 'sessional_session_ends_this_month':
        return 'Sessional — current session ends this month'
      case 'custom_unknown':
        return 'Custom schedule — check manually'
      default:
        return ''
    }
  }

  function renderDueThisMonthPanel() {
    const dueStaff = dueThisMonthData.filter(s => s.is_due)
    const [year, month] = dueThisMonthMonth.split('-')
    const monthLabel = new Date(Number(year), Number(month) - 1, 1)
      .toLocaleDateString('en-US', { month: 'long', year: 'numeric' })

    return (
      <div className="hr-due-panel">
        <button
          className="hr-due-panel-toggle"
          onClick={() => setDueThisMonthOpen(o => !o)}
          aria-expanded={dueThisMonthOpen}
        >
          <span><Icon name="wallet" size={16} style={{ verticalAlign: 'text-bottom', marginRight: '0.35em' }} /> Who's due for payment</span>
          <span className="hr-due-panel-chevron">{dueThisMonthOpen ? '▾' : '▸'}</span>
        </button>

        {dueThisMonthOpen && (
          <div className="hr-due-panel-body">
            <p className="hr-detail-sub">
              An estimate based on pay frequency and last payslip — not a record of what's actually owed.
              Use it to decide who to include in a payroll run.
            </p>

            {dueThisMonthState === 'ready' && dueThisMonthData.length > 0 && (
              <p className="hr-due-coverage">
                {dueThisMonthData.length - dueStaff.length} of {dueThisMonthData.length} staff already covered for {monthLabel}
              </p>
            )}

            <div className="hr-field">
              <label className="hr-label" htmlFor="due-month-picker">Month</label>
              <input
                id="due-month-picker"
                type="month"
                value={dueThisMonthMonth}
                onChange={e => setDueThisMonthMonth(e.target.value)}
              />
            </div>

            {dueThisMonthState === 'loading' || dueThisMonthState === 'booting' ? (
              <div className="hr-list-skel">
                {[1, 2].map(i => <div key={i} className="hr-row-skel skeleton" />)}
              </div>
            ) : dueThisMonthState === 'error' ? (
              <div className="hr-error-state">
                <span className="hr-error-icon" style={{ color: 'var(--color-warning)' }}><Icon name="alert-triangle" /></span>
                <p className="hr-error-msg">{dueThisMonthError}</p>
                <button className="hr-retry-btn" onClick={loadDueThisMonth}>Retry</button>
              </div>
            ) : dueStaff.length === 0 ? (
              <p className="hr-empty-msg">No one appears due for {monthLabel}.</p>
            ) : (
              <ul className="hr-due-list">
                {dueStaff.map(s => (
                  <li key={s.staff_id} className="hr-due-row">
                    <span className="hr-due-name">{s.staff_name}</span>
                    <span className="hr-due-reason">{dueReasonLabel(s)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    )
  }

  function renderPayrollTab() {
    return (
      <div className="hr-tab-body">
        {canRunPayroll && renderDueThisMonthPanel()}

        {canRunPayroll && (
          <div className="hr-actions-row">
            <button className="hr-add-btn" onClick={openRunForm}>
              + New payroll run
            </button>
          </div>
        )}

        {runFormOpen && renderRunForm()}

        {payrollState === 'loading' || payrollState === 'booting' ? (
          <div className="hr-list-skel">
            {[1,2,3].map(i => <div key={i} className="hr-row-skel skeleton" />)}
          </div>
        ) : payrollState === 'error' ? (
          <div className="hr-error-state">
            <span className="hr-error-icon" style={{ color: 'var(--color-warning)' }}><Icon name="alert-triangle" /></span>
            <p className="hr-error-msg">{payrollError}</p>
            <button className="hr-retry-btn" onClick={loadPayrollList}>Retry</button>
          </div>
        ) : payrollState === 'empty' || payrollRuns.length === 0 ? (
          <div className="hr-empty-state">
            <span className="hr-empty-icon"><Icon name="receipt" /></span>
            <p className="hr-empty-msg">
              No payroll runs yet.{canRunPayroll ? ' Create a run to start paying staff.' : ''}
            </p>
          </div>
        ) : (
          <ul className="hr-payroll-list">
            {payrollRuns.map(run => (
              <li key={run.id} className="hr-payroll-row">
                <button className="hr-payroll-row-btn" onClick={() => openRunDetail(run)}>
                  <div className="hr-payroll-row-main">
                    <span className="hr-payroll-period">{run.period_label}</span>
                    <span className={`hr-payroll-status hr-payroll-status--${run.status}`}>
                      {statusLabel(run.status)}
                    </span>
                  </div>
                  <div className="hr-payroll-row-meta">
                    <span className="hr-payroll-dates">
                      {formatDate(run.period_start)} – {formatDate(run.period_end)}
                    </span>
                    <span className="hr-payroll-count">
                      {run.payslip_count} payslip{run.payslip_count !== 1 ? 's' : ''}
                    </span>
                    {run.total_net !== null && (
                      <span className="hr-payroll-total">{formatNaira(run.total_net)} net</span>
                    )}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    )
  }

  function renderRunForm() {
    return (
      <div
        className="hr-form-overlay"
        onClick={e => { if (e.target === e.currentTarget) setRunFormOpen(false) }}
      >
        <div className="hr-form-sheet" role="dialog" aria-modal aria-label="New payroll run">
          <div className="hr-form-handle" />
          <div className="hr-form-header">
            <h3 className="hr-form-title">New payroll run</h3>
            <button className="hr-form-close" onClick={() => setRunFormOpen(false)} aria-label="Close"><Icon name="x" /></button>
          </div>
          <div className="hr-form-body">
            <div className="hr-field">
              <label className="hr-label" htmlFor="hr-run-label">
                Period label <span className="hr-required">*</span>
              </label>
              <input
                id="hr-run-label"
                className="hr-input"
                type="text"
                placeholder="e.g. June 2026"
                value={runForm.period_label}
                onChange={e => setRunForm(prev => ({ ...prev, period_label: e.target.value }))}
              />
            </div>
            <div className="hr-field">
              <label className="hr-label" htmlFor="hr-run-start">
                Period start <span className="hr-required">*</span>
              </label>
              <input
                id="hr-run-start"
                className="hr-input"
                type="date"
                value={runForm.period_start}
                onChange={e => setRunForm(prev => ({ ...prev, period_start: e.target.value }))}
              />
            </div>
            <div className="hr-field">
              <label className="hr-label" htmlFor="hr-run-end">
                Period end <span className="hr-required">*</span>
              </label>
              <input
                id="hr-run-end"
                className="hr-input"
                type="date"
                min={runForm.period_start}
                value={runForm.period_end}
                onChange={e => setRunForm(prev => ({ ...prev, period_end: e.target.value }))}
              />
            </div>
            {runError && <p className="hr-form-error" role="alert">{runError}</p>}
          </div>
          <div className="hr-form-footer">
            <button className="hr-cancel-btn" onClick={() => setRunFormOpen(false)} disabled={runSaving}>
              Cancel
            </button>
            <button className="hr-save-btn" onClick={handleCreateRun} disabled={runSaving}>
              {runSaving ? 'Creating…' : 'Create run'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── Staff detail panel ───────────────────────────────────────────────────────

  function renderStaffDetailPanel() {
    if (!detailStaff) return null
    const s = detailStaff

    return (
      <div
        className="hr-form-overlay"
        onClick={e => { if (e.target === e.currentTarget) closeStaffDetail() }}
      >
        <div className="hr-detail-sheet hr-form-sheet" role="dialog" aria-modal aria-label={`${s.full_name} details`}>
          <div className="hr-form-handle" />

          <div className="hr-detail-header">
            <div className="hr-detail-avatar">{s.full_name.charAt(0).toUpperCase()}</div>
            <div className="hr-detail-title-wrap">
              <p className="hr-detail-name">{s.full_name}</p>
              <p className="hr-detail-sub">{s.roles.length > 0 ? s.roles.join(', ') : 'No role assigned'}</p>
            </div>
            <button className="hr-form-close" onClick={closeStaffDetail} aria-label="Close"><Icon name="x" /></button>
          </div>

          <div className="hr-detail-tabs">
            {(['details', 'salary'] as StaffDetailTab[]).map(tab => (
              <button
                key={tab}
                className={`hr-detail-tab${detailTab === tab ? ' hr-detail-tab--active' : ''}`}
                onClick={() => setDetailTab(tab)}
              >
                {tab.charAt(0).toUpperCase() + tab.slice(1)}
              </button>
            ))}
          </div>

          <div className="hr-detail-body">
            {detailTab === 'details' && renderStaffDetailsTab(s)}
            {detailTab === 'salary'  && renderStaffSalaryTab(s)}
          </div>
        </div>
      </div>
    )
  }

  function renderStaffDetailsTab(s: StaffDetail) {
    if (detailDataState === 'error') {
      return <div className="hr-detail-tab-content"><p className="hr-form-error" role="alert">{detailDataError}</p></div>
    }

    if (!editForm) {
      return (
        <div className="hr-detail-tab-content">
          <div className="hr-field">
            <span className="hr-label">Email</span>
            <p className="hr-detail-sub" style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-primary)' }}>
              {s.email || '—'}
            </p>
          </div>
          <div className="hr-field">
            <span className="hr-label">Phone</span>
            <p className="hr-detail-sub" style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-primary)' }}>
              {s.phone || '—'}
            </p>
          </div>
          <div className="hr-field">
            <span className="hr-label">Hire date</span>
            <p className="hr-detail-sub" style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-primary)' }}>
              {s.hire_date ? formatDate(s.hire_date) : '—'}
            </p>
          </div>
          <div className="hr-field">
            <span className="hr-label">Status</span>
            <p>
              <span className={`hr-status-chip hr-status-chip--${s.status}`}>{statusLabel(s.status)}</span>
            </p>
          </div>

          {/* Session 10b — teaching assignment summary. Current session first
              (what this staff member teaches right now), then a collapsed
              history of past-session assignments per the owner's confirmed
              design ("past sessions assignment history may appear in
              teacher's summary page, including what he teaches now"). */}
          <div className="hr-field">
            <span className="hr-label">Currently teaching</span>
            {staffAssignmentsState === 'loading'  && <p className="hr-detail-sub">Loading…</p>}
            {staffAssignmentsState === 'error'    && <p className="hr-form-error" role="alert">Couldn't load teaching assignments.</p>}
            {staffAssignmentsState !== 'loading' && staffAssignmentsState !== 'error' && (() => {
              const currentId = assignmentOptions?.currentSessionId
              const current = currentId ? staffAssignments.filter(a => a.session_id === currentId) : []
              if (current.length === 0) {
                return <p className="hr-detail-sub">Not currently assigned to any subject/class.</p>
              }
              return (
                <ul className="hr-teaching-list">
                  {current.map(a => (
                    <li key={a.id} className="hr-teaching-list-item">
                      <span className="hr-teaching-subject">{a.subject_name}</span>
                      <span className="hr-teaching-class">{a.class_name}</span>
                    </li>
                  ))}
                </ul>
              )
            })()}
          </div>

          {(() => {
            const currentId = assignmentOptions?.currentSessionId
            const pastAssignments = staffAssignments.filter(a => a.session_id !== currentId)
            if (pastAssignments.length === 0) return null
            const bySession = new Map<string, TeachingAssignment[]>()
            for (const a of pastAssignments) {
              const list = bySession.get(a.session_name) ?? []
              list.push(a)
              bySession.set(a.session_name, list)
            }
            return (
              <div className="hr-field">
                <span className="hr-label">Teaching history</span>
                {[...bySession.entries()].map(([sessionName, rows]) => (
                  <div key={sessionName} className="hr-teaching-history-group">
                    <p className="hr-detail-sub hr-teaching-history-session">{sessionName}</p>
                    <ul className="hr-teaching-list">
                      {rows.map(a => (
                        <li key={a.id} className="hr-teaching-list-item">
                          <span className="hr-teaching-subject">{a.subject_name}</span>
                          <span className="hr-teaching-class">{a.class_name}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )
          })()}

          {/* Session 10b — default password view/print/regenerate. Same gate
              as "Edit details" (canManageStaff) — this is an admin action,
              not self-service (that's AccountPreferencesScreen.tsx's
              password section, reached by the staff member themselves via
              the account popover, entirely separate from this panel).
              Renders nothing when there's no default_password on file
              (loadStaffDefaultPassword resolved to 'empty') — most commonly
              because the staff member already changed it, or the account
              predates this feature. */}
          {canManageStaff && defaultPasswordState !== 'booting' && defaultPasswordState !== 'empty' && (
            <div className="hr-field">
              <span className="hr-label">Default password</span>
              {defaultPasswordState === 'loading' && (
                <p className="hr-detail-sub">Loading…</p>
              )}
              {defaultPasswordState === 'error' && (
                <p className="hr-form-error" role="alert">Couldn't load the default password.</p>
              )}
              {defaultPasswordState === 'ready' && defaultPassword && (
                <div className="hr-default-password-panel">
                  {defaultPassword.expired && (
                    <p className="hr-detail-sub hr-default-password-expired">
                      This password is more than 7 days old — regenerate it before sharing.
                    </p>
                  )}
                  <div className="hr-default-password-row">
                    <span className="hr-default-password-value">
                      {passwordRevealed ? defaultPassword.password : '••••••••••'}
                    </span>
                    <button
                      type="button"
                      className="hr-line-item-remove"
                      onClick={() => setPasswordRevealed(v => !v)}
                      aria-label={passwordRevealed ? 'Hide password' : 'Show password'}
                    >
                      {passwordRevealed ? 'Hide' : 'Show'}
                    </button>
                  </div>
                  <p className="hr-detail-sub">Set on {formatDate(defaultPassword.set_at)}.</p>
                  <div className="hr-default-password-actions">
                    <button type="button" className="hr-cancel-btn" onClick={handlePrintPassword}>
                      Print
                    </button>
                    <button
                      type="button"
                      className="hr-regenerate-password-btn"
                      onClick={handleRegeneratePassword}
                      disabled={regenerateSaving}
                    >
                      {regenerateSaving
                        ? 'Regenerating…'
                        : regenerateConfirm
                          ? 'Confirm — regenerate'
                          : 'Regenerate'}
                    </button>
                    {regenerateConfirm && (
                      <button
                        type="button"
                        className="hr-line-item-remove"
                        onClick={() => setRegenerateConfirm(false)}
                        disabled={regenerateSaving}
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                  {regenerateConfirm && (
                    <div className="hr-confirm-banner">
                      <p className="hr-confirm-text">
                        This immediately invalidates {s.full_name}'s current password. They'll need the new one to sign in. Confirm to proceed.
                      </p>
                    </div>
                  )}
                  {regenerateError && <p className="hr-form-error" role="alert">{regenerateError}</p>}
                </div>
              )}
            </div>
          )}

          {canManageStaff && (
            <button className="hr-edit-toggle-btn" onClick={startEditingStaff}>
              Edit details
            </button>
          )}
        </div>
      )
    }

    return (
      <div className="hr-detail-tab-content">
        <div className="hr-field">
          <label className="hr-label" htmlFor="hr-edit-name">
            Full name <span className="hr-required">*</span>
          </label>
          <input
            id="hr-edit-name"
            className="hr-input"
            type="text"
            value={editForm.full_name}
            onChange={e => setEditForm(prev => prev && ({ ...prev, full_name: e.target.value }))}
          />
        </div>
        <div className="hr-field">
          <label className="hr-label" htmlFor="hr-edit-email">Email</label>
          <input
            id="hr-edit-email"
            className="hr-input"
            type="email"
            value={editForm.email}
            onChange={e => setEditForm(prev => prev && ({ ...prev, email: e.target.value }))}
          />
        </div>
        <div className="hr-field">
          <label className="hr-label" htmlFor="hr-edit-phone">Phone</label>
          <input
            id="hr-edit-phone"
            className="hr-input"
            type="tel"
            value={editForm.phone}
            onChange={e => setEditForm(prev => prev && ({ ...prev, phone: e.target.value }))}
          />
        </div>
        <div className="hr-field">
          <label className="hr-label" htmlFor="hr-edit-hire">Hire date</label>
          <input
            id="hr-edit-hire"
            className="hr-input"
            type="date"
            value={editForm.hire_date}
            onChange={e => setEditForm(prev => prev && ({ ...prev, hire_date: e.target.value }))}
          />
        </div>
        <div className="hr-field">
          <label className="hr-label" htmlFor="hr-edit-status">Status</label>
          <select
            id="hr-edit-status"
            className="hr-select"
            value={editForm.status}
            onChange={e => setEditForm(prev => prev && ({ ...prev, status: e.target.value as StaffEditForm['status'] }))}
          >
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="suspended">Suspended</option>
          </select>
        </div>
        <div className="hr-field">
          <span className="hr-label">Roles</span>
          {rolesCatalogState === 'loading' && (
            <p className="hr-detail-sub">Loading roles…</p>
          )}
          {rolesCatalogState === 'error' && (
            <p className="hr-form-error" role="alert">Couldn't load the roles list. Try reopening this form.</p>
          )}
          {rolesCatalogState === 'empty' && (
            <p className="hr-detail-sub">No roles have been set up yet for this school. Create one in Settings → Roles first.</p>
          )}
          {rolesCatalogState === 'ready' && (
            <div className="hr-role-checklist" role="group" aria-label="Assigned roles">
              {rolesCatalog.map(role => (
                <label key={role.id} className="hr-role-checkbox-row">
                  <input
                    type="checkbox"
                    checked={editForm.role_ids.includes(role.id)}
                    onChange={() => toggleEditFormRole(role.id)}
                  />
                  <span>
                    {role.name}
                    {role.is_admin_role && <span className="hr-role-chip hr-role-chip--admin"> Admin</span>}
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>

        {/* Session 10b — subject/class assignment picker. Current session
            only, per the owner's confirmed design. Options are lazy-loaded
            via ensureAssignmentOptionsLoaded() on entering edit mode. */}
        <div className="hr-field">
          <span className="hr-label">Teaching assignments (current session)</span>
          {assignmentOptionsState === 'loading' && (
            <p className="hr-detail-sub">Loading subjects and classes…</p>
          )}
          {assignmentOptionsState === 'error' && (
            <p className="hr-form-error" role="alert">Couldn't load subjects/classes. Try reopening this form.</p>
          )}
          {assignmentOptionsState === 'ready' && !assignmentOptions?.currentSessionId && (
            <p className="hr-detail-sub">No current session is set up for this school yet — set one up in Settings before assigning subjects.</p>
          )}
          {assignmentOptionsState === 'ready' && assignmentOptions?.currentSessionId && (
            <>
              {assignmentOptions.subjects.length === 0 || assignmentOptions.classes.length === 0 ? (
                <p className="hr-detail-sub">
                  {assignmentOptions.subjects.length === 0
                    ? 'No subjects have been set up yet for this school.'
                    : 'No classes have been set up yet for this school.'}
                </p>
              ) : (
                <>
                  {editForm.assignment_pairs.length > 0 && (
                    <ul className="hr-assignment-chip-list">
                      {editForm.assignment_pairs.map((p, i) => {
                        const subjectName = assignmentOptions.subjects.find(s => s.id === p.subjectId)?.name ?? '—'
                        const className   = assignmentOptions.classes.find(c => c.id === p.classNodeId)?.name ?? '—'
                        return (
                          <li key={i} className="hr-assignment-chip">
                            <span>{subjectName} <span className="hr-assignment-chip-sep">·</span> {className}</span>
                            <button
                              className="hr-line-item-remove"
                              onClick={() => toggleEditFormAssignment(p.subjectId, p.classNodeId)}
                              aria-label={`Remove ${subjectName} for ${className}`}
                            >
                              <Icon name="x" size={14} />
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                  <AddAssignmentRow
                    subjects={assignmentOptions.subjects}
                    classes={assignmentOptions.classes}
                    existingPairs={editForm.assignment_pairs}
                    onAdd={(subjectId, classNodeId) => toggleEditFormAssignment(subjectId, classNodeId)}
                  />
                </>
              )}
            </>
          )}
        </div>

        {editError && <p className="hr-form-error" role="alert">{editError}</p>}
        <div className="hr-form-footer" style={{ padding: '12px 0 0', border: 'none' }}>
          <button className="hr-cancel-btn" onClick={cancelEditingStaff} disabled={editSaving}>
            Cancel
          </button>
          <button className="hr-save-btn" onClick={handleSaveStaffEdit} disabled={editSaving}>
            {editSaving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    )
  }

  function renderStaffSalaryTab(s: StaffDetail) {
    if (salaryFormOpen) return renderSalaryForm()

    const ss = s.salary_structure
    if (!ss) {
      return (
        <div className="hr-detail-tab-content">
          <div className="hr-empty-state hr-empty-state--detail">
            <span className="hr-empty-icon"><Icon name="wallet" /></span>
            <p className="hr-empty-msg">No salary structure set up yet.</p>
          </div>
          {canManageStaff && (
            <button className="hr-edit-toggle-btn" onClick={openSalaryForm}>
              + Set up salary
            </button>
          )}
        </div>
      )
    }

    // Effective frequency: the staff member's own override if set, otherwise
    // the school default — but the school default is lazy-loaded (see
    // ensureSchoolDefaultFrequencyLoaded), so it may briefly show "Loading…"
    // for staff who have no per-staff override.
    const effectiveFrequency = ss.pay_frequency ?? schoolDefaultFrequency
    const isSchoolDefault = !ss.pay_frequency

    return (
      <div className="hr-detail-tab-content">
        <div className="hr-salary-summary-row">
          <div className="hr-salary-stat">
            <span className="hr-salary-stat-label">Basic</span>
            <span className="hr-salary-stat-value">{formatNaira(ss.basic_salary)}</span>
          </div>
          <div className="hr-salary-stat">
            <span className="hr-salary-stat-label">Net</span>
            <span className="hr-salary-stat-value hr-salary-stat-value--ok">{formatNaira(ss.net)}</span>
          </div>
          <div className="hr-salary-stat hr-salary-stat--gross">
            <span className="hr-salary-stat-label">Gross</span>
            <span className="hr-salary-stat-value hr-salary-stat-value--lg">{formatNaira(ss.gross)}</span>
          </div>
        </div>

        <div className="hr-field">
          <span className="hr-label">Pay frequency</span>
          <p className="hr-detail-sub" style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-primary)' }}>
            {effectiveFrequency
              ? `${PAY_FREQUENCY_LABELS[effectiveFrequency]}${isSchoolDefault ? ' (school default)' : ''}`
              : (schoolDefaultFrequencyState === 'loading' ? 'Loading…' : '—')}
          </p>
        </div>

        {ss.allowances.length > 0 && (
          <>
            <p className="hr-section-title">Allowances</p>
            <ul className="hr-salary-line-list">
              {ss.allowances.map((a, i) => (
                <li key={i} className="hr-salary-line">
                  <span>{a.label}</span>
                  <span>{formatNaira(a.amount)}</span>
                </li>
              ))}
            </ul>
          </>
        )}

        {ss.deductions.length > 0 && (
          <>
            <p className="hr-section-title">Deductions</p>
            <ul className="hr-salary-line-list">
              {ss.deductions.map((d, i) => (
                <li key={i} className="hr-salary-line">
                  <span>{d.label}</span>
                  <span className="hr-salary-line-amount--deduction">− {formatNaira(d.amount)}</span>
                </li>
              ))}
            </ul>
          </>
        )}

        <p className="hr-salary-effective">
          Effective from {formatDate(ss.effective_from)}
          {ss.effective_to ? ` to ${formatDate(ss.effective_to)}` : ''}
        </p>

        {canManageStaff && (
          <button className="hr-edit-toggle-btn" onClick={openSalaryForm}>
            Update salary structure
          </button>
        )}
      </div>
    )
  }

  function renderSalaryForm() {
    return (
      <div className="hr-detail-tab-content">
        <p className="hr-section-title">
          {detailStaff?.salary_structure ? 'Update salary structure' : 'Set up salary'}
        </p>
        <p className="hr-empty-msg" style={{ textAlign: 'left', margin: '0 0 12px' }}>
          Saving creates a new historical record — the previous structure is kept, not overwritten.
        </p>

        <div className="hr-field">
          <label className="hr-label" htmlFor="hr-sal-basic">
            Basic salary (₦) <span className="hr-required">*</span>
          </label>
          <input
            id="hr-sal-basic"
            className="hr-input"
            type="number"
            min="0"
            step="0.01"
            placeholder="e.g. 150000"
            value={salaryForm.basic_salary}
            onChange={e => setSalaryForm(prev => ({ ...prev, basic_salary: e.target.value }))}
          />
        </div>

        <div className="hr-field">
          <label className="hr-label">Allowances</label>
          {salaryForm.allowances.map((a, i) => (
            <div key={i} className="hr-line-item-row">
              <input
                className="hr-input"
                type="text"
                placeholder="e.g. Housing"
                value={a.label}
                onChange={e => updateAllowanceRow(i, 'label', e.target.value)}
              />
              <input
                className="hr-input hr-input--amount"
                type="number"
                min="0"
                step="0.01"
                placeholder="Amount"
                value={a.amount || ''}
                onChange={e => updateAllowanceRow(i, 'amount', e.target.value)}
              />
              <button className="hr-line-item-remove" onClick={() => removeAllowanceRow(i)} aria-label="Remove allowance"><Icon name="x" size={14} /></button>
            </div>
          ))}
          <button className="hr-line-item-add" onClick={addAllowanceRow}>+ Add allowance</button>
        </div>

        <div className="hr-field">
          <label className="hr-label">Deductions</label>
          {salaryForm.deductions.map((d, i) => (
            <div key={i} className="hr-line-item-row">
              <input
                className="hr-input"
                type="text"
                placeholder="e.g. Tax, Pension"
                value={d.label}
                onChange={e => updateDeductionRow(i, 'label', e.target.value)}
              />
              <input
                className="hr-input hr-input--amount"
                type="number"
                min="0"
                step="0.01"
                placeholder="Amount"
                value={d.amount || ''}
                onChange={e => updateDeductionRow(i, 'amount', e.target.value)}
              />
              <button className="hr-line-item-remove" onClick={() => removeDeductionRow(i)} aria-label="Remove deduction"><Icon name="x" size={14} /></button>
            </div>
          ))}
          <button className="hr-line-item-add" onClick={addDeductionRow}>+ Add deduction</button>
        </div>

        <div className="hr-field">
          <label className="hr-label" htmlFor="hr-sal-effective">Effective from</label>
          <input
            id="hr-sal-effective"
            className="hr-input"
            type="date"
            value={salaryForm.effective_from}
            onChange={e => setSalaryForm(prev => ({ ...prev, effective_from: e.target.value }))}
          />
        </div>

        <div className="hr-field">
          <label className="hr-label" htmlFor="hr-sal-frequency">Pay frequency</label>
          <select
            id="hr-sal-frequency"
            className="hr-select"
            value={salaryForm.pay_frequency}
            onChange={e => setSalaryForm(prev => ({ ...prev, pay_frequency: e.target.value as PayFrequency | '' }))}
          >
            <option value="">
              {schoolDefaultFrequencyState === 'ready' && schoolDefaultFrequency
                ? `Use school default (${PAY_FREQUENCY_LABELS[schoolDefaultFrequency]})`
                : 'Use school default'}
            </option>
            <option value="monthly">Monthly</option>
            <option value="termly">Per term</option>
            <option value="sessional">Per session</option>
            <option value="custom">Custom</option>
          </select>
          <p className="hr-detail-sub">
            Leave as "school default" unless this staff member is paid on a different schedule than most staff.
          </p>
        </div>

        {salaryError && <p className="hr-form-error" role="alert">{salaryError}</p>}

        <div className="hr-form-footer" style={{ padding: '12px 0 0', border: 'none' }}>
          <button className="hr-cancel-btn" onClick={() => setSalaryFormOpen(false)} disabled={salarySaving}>
            Cancel
          </button>
          <button className="hr-save-btn" onClick={handleSaveSalary} disabled={salarySaving}>
            {salarySaving ? 'Saving…' : 'Save salary structure'}
          </button>
        </div>
      </div>
    )
  }

  // ── Payroll run detail panel ─────────────────────────────────────────────────

  function renderAddPayslipSection() {
    return (
      <div className="hr-add-payslip-section">
        {!addPayslipOpen ? (
          <button className="hr-add-btn hr-add-payslip-toggle" onClick={openAddPayslip}>
            + Add payslip(s)
          </button>
        ) : (
          <div className="hr-add-payslip-panel">
            <div className="hr-add-payslip-header">
              <span className="hr-label">Add payslip(s)</span>
              <button className="hr-form-close" onClick={() => setAddPayslipOpen(false)} aria-label="Close"><Icon name="x" /></button>
            </div>

            {addPayslipResult && <p className="hr-empty-msg" style={{ textAlign: 'left' }}>{addPayslipResult}</p>}
            {addPayslipError && <p className="hr-form-error" role="alert">{addPayslipError}</p>}

            {reviewCandidate ? (
              <div className="hr-payslip-review">
                <p className="hr-detail-sub">Review before adding — computed from {reviewCandidate.staff_name}'s current salary structure.</p>
                <div className="hr-payslip-review-row">
                  <span>Basic</span><span>{formatNaira(reviewCandidate.breakdown.basic_salary)}</span>
                </div>
                {reviewCandidate.breakdown.allowances.map((a, i) => (
                  <div className="hr-payslip-review-row" key={`a${i}`}>
                    <span>+ {a.label}</span><span>{formatNaira(a.amount)}</span>
                  </div>
                ))}
                {reviewCandidate.breakdown.deductions.map((d, i) => (
                  <div className="hr-payslip-review-row" key={`d${i}`}>
                    <span>− {d.label}</span><span>{formatNaira(d.amount)}</span>
                  </div>
                ))}
                <div className="hr-payslip-review-row hr-payslip-review-total">
                  <span>Net</span><span>{formatNaira(reviewCandidate.net_amount)}</span>
                </div>
                <div className="hr-form-footer" style={{ padding: '12px 0 0', border: 'none' }}>
                  <button className="hr-cancel-btn" onClick={() => setReviewCandidate(null)} disabled={addPayslipSaving}>
                    Back
                  </button>
                  <button className="hr-save-btn" onClick={confirmAddReviewedCandidate} disabled={addPayslipSaving}>
                    {addPayslipSaving ? 'Adding…' : 'Confirm — add payslip'}
                  </button>
                </div>
              </div>
            ) : eligibleState === 'loading' || eligibleState === 'booting' ? (
              <div className="hr-list-skel">
                {[1, 2].map(i => <div key={i} className="hr-row-skel skeleton" />)}
              </div>
            ) : eligibleState === 'error' ? (
              <div className="hr-error-state">
                <span className="hr-error-icon" style={{ color: 'var(--color-warning)' }}><Icon name="alert-triangle" /></span>
                <p className="hr-error-msg">{eligibleError}</p>
                <button className="hr-retry-btn" onClick={openAddPayslip}>Retry</button>
              </div>
            ) : eligibleCandidates.length === 0 ? (
              <p className="hr-empty-msg">
                Everyone with a salary structure is already in this run.
              </p>
            ) : (
              <>
                <button
                  className="hr-save-btn"
                  onClick={handleAddAllEligible}
                  disabled={addPayslipSaving}
                >
                  {addPayslipSaving
                    ? 'Adding…'
                    : `+ Add all ${eligibleCandidates.length} eligible`}
                </button>
                <ul className="hr-eligible-list">
                  {eligibleCandidates.map(c => (
                    <li key={c.staff_id} className="hr-eligible-row">
                      <span className="hr-eligible-name">{c.staff_name}</span>
                      <span className="hr-eligible-net">{formatNaira(c.net_amount)}</span>
                      <button
                        className="hr-line-item-add"
                        onClick={() => startReviewCandidate(c)}
                        disabled={addPayslipSaving}
                      >
                        + Add
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </div>
    )
  }

  function renderRunDetailPanel() {
    if (!detailRun) return null
    const run = detailRun

    return (
      <div
        className="hr-form-overlay"
        onClick={e => { if (e.target === e.currentTarget) closeRunDetail() }}
      >
        <div className="hr-detail-sheet hr-form-sheet" role="dialog" aria-modal aria-label={`${run.period_label} payroll run`}>
          <div className="hr-form-handle" />

          <div className="hr-detail-header">
            <div className="hr-detail-title-wrap">
              <p className="hr-detail-name">{run.period_label}</p>
              <p className="hr-detail-sub">
                {formatDate(run.period_start)} – {formatDate(run.period_end)} ·{' '}
                <span className={`hr-payroll-status hr-payroll-status--${run.status}`}>{statusLabel(run.status)}</span>
              </p>
            </div>
            <button className="hr-form-close" onClick={closeRunDetail} aria-label="Close"><Icon name="x" /></button>
          </div>

          <div className="hr-detail-body">
            <div className="hr-detail-tab-content">
              {/* hr.payroll.approve ("Approve payroll runs") covers "Approve run"
                  exactly. "Mark paid" has no dedicated catalog key — it's a further
                  progression after approval that triggers the ledger — bundled onto
                  the same gate as the closest available key rather than left on
                  isAdmin, since it's clearly still an approval-adjacent action, not
                  a config gap like leave-types above. Flagged in §11 as a second,
                  smaller candidate for a future dedicated key (e.g.
                  hr.payroll.mark_paid) if the owner wants finer separation later. */}
              {canApprovePayroll && run.status !== 'paid' && (
                <div className="hr-payroll-run-actions">
                  {run.status === 'draft' && (
                    <button className="hr-run-approve-btn" onClick={handleApproveRun} disabled={runActionSaving}>
                      {runActionSaving ? 'Approving…' : 'Approve run'}
                    </button>
                  )}
                  {run.status === 'approved' && (
                    <button className="hr-run-paid-btn" onClick={handleMarkPaid} disabled={runActionSaving}>
                      {runActionSaving ? 'Processing…' : markPaidConfirm ? 'Confirm — mark paid' : 'Mark paid'}
                    </button>
                  )}
                </div>
              )}

              {markPaidConfirm && (
                <div className="hr-confirm-banner">
                  <p className="hr-confirm-text">
                    This posts {formatNaira(run.total_net ?? 0)} net pay to the ledger (if enabled) and cannot be reversed. Confirm to proceed.
                  </p>
                </div>
              )}

              {runActionError && <p className="hr-form-error" role="alert">{runActionError}</p>}

              {run.approved_by_name && (
                <p className="hr-empty-msg" style={{ textAlign: 'left', margin: '0 0 12px' }}>
                  Approved by {run.approved_by_name}
                </p>
              )}

              {/* Session 10a-4 — closes the gap where addPayslip() existed in
                  hrService.ts but no UI ever called it: approving/marking a run
                  paid never created payslip rows, so a run could be fully
                  "processed" with nobody actually in it. Draft-only — once a
                  run is approved, changing who's in it should go through a
                  deliberate re-approval, not a quiet add. */}
              {canRunPayroll && run.status === 'draft' && renderAddPayslipSection()}

              {runDetailState === 'loading' || runDetailState === 'booting' ? (
                <div className="hr-list-skel">
                  {[1,2,3].map(i => <div key={i} className="hr-row-skel skeleton" />)}
                </div>
              ) : runDetailState === 'error' ? (
                <p className="hr-form-error" role="alert">{runDetailError}</p>
              ) : detailPayslips.length === 0 ? (
                <div className="hr-empty-state hr-empty-state--detail">
                  <span className="hr-empty-icon"><Icon name="receipt" /></span>
                  <p className="hr-empty-msg">No payslips added to this run yet.</p>
                </div>
              ) : (
                <ul className="hr-payslip-list">
                  {detailPayslips.map(p => (
                    <li key={p.id} className="hr-payslip-row">
                      <div className="hr-payslip-row-main">
                        <span className="hr-payslip-name">{p.staff_name}</span>
                        <span className="hr-payslip-net">{formatNaira(p.net_amount)}</span>
                      </div>
                      <div className="hr-payslip-row-meta">
                        <span className="hr-payslip-gross">Gross {formatNaira(p.gross_amount)}</span>
                        <span className="hr-payslip-deductions">− {formatNaira(p.total_deductions)} deductions</span>
                        {p.paid_at && (
                          <span className="hr-payslip-paid">Paid {formatDate(p.paid_at)}</span>
                        )}
                      </div>

                      {/* Session 10c — partial/split payment tracking. Status
                          badge always visible. "Record payment" is a direct,
                          row-level action (fixed from an earlier build where
                          it was only reachable by first expanding "Payment
                          history" — two clicks to find a primary action).
                          "Payment history" remains a separate, collapsed-by-
                          default disclosure for past payment rows. */}
                      <div className="hr-payslip-row-meta">
                        <span className={`hr-payment-status-chip hr-payment-status-chip--${p.payment_status}`}>
                          {p.payment_status === 'paid' ? 'Fully paid'
                            : p.payment_status === 'partially_paid' ? `Partially paid — ${formatNaira(p.amount_paid)} of ${formatNaira(p.net_amount)}`
                            : 'Unpaid'}
                        </span>
                        <div className="hr-payslip-row-actions">
                          {canApprovePayroll && p.payment_status !== 'paid' && paymentFormPayslipId !== p.id && (
                            <button className="hr-edit-toggle-btn" onClick={() => openPaymentForm(p.id)}>
                              + Record payment
                            </button>
                          )}
                          {/* Session 10c-2 — symmetric with "+ Add payslip(s)":
                              removal is also draft-run-only, and only offered
                              while unpaid — matches removePayslipFromRun's own
                              server-side guard, so this button never offers an
                              action that will just come back as an error. */}
                          {canRunPayroll && run.status === 'draft' && p.payment_status === 'unpaid' && (
                            <button
                              className="hr-remove-payslip-btn"
                              onClick={() => handleRemovePayslip(p)}
                              disabled={removePayslipSaving && removePayslipId === p.id}
                            >
                              {removePayslipSaving && removePayslipId === p.id
                                ? 'Removing…'
                                : removePayslipId === p.id
                                  ? 'Confirm remove'
                                  : 'Remove'}
                            </button>
                          )}
                          {removePayslipId === p.id && !removePayslipSaving && (
                            <button className="hr-cancel-btn" onClick={cancelRemovePayslip}>
                              Cancel
                            </button>
                          )}
                          <button
                            className="hr-payslip-history-toggle"
                            onClick={() => toggleExpandPayslip(p.id)}
                          >
                            {expandedPayslipId === p.id ? 'Hide history' : 'Payment history'}
                          </button>
                        </div>
                      </div>

                      {removePayslipId === p.id && removePayslipError && (
                        <p className="hr-form-error" role="alert">{removePayslipError}</p>
                      )}

                      {canApprovePayroll && paymentFormPayslipId === p.id && (
                        <div className="hr-payment-record-form">
                          <label className="hr-payment-full-toggle">
                            <input
                              type="checkbox"
                              checked={isFullPayment}
                              onChange={e => {
                                setIsFullPayment(e.target.checked)
                                if (e.target.checked) setPaymentAmount('')
                              }}
                            />
                            Pay in full ({formatNaira(p.net_amount - p.amount_paid)})
                          </label>
                          <div className="hr-line-item-row">
                            {isFullPayment ? (
                              <input
                                className="hr-input hr-input--amount"
                                type="text"
                                value={formatNaira(p.net_amount - p.amount_paid)}
                                disabled
                                readOnly
                              />
                            ) : (
                              <input
                                className="hr-input hr-input--amount"
                                type="number"
                                min="0"
                                step="0.01"
                                placeholder={`Up to ${formatNaira(p.net_amount - p.amount_paid)}`}
                                value={paymentAmount}
                                onChange={e => setPaymentAmount(e.target.value)}
                                autoFocus
                              />
                            )}
                            <input
                              className="hr-input"
                              type="text"
                              placeholder="Method (optional)"
                              value={paymentMethod}
                              onChange={e => setPaymentMethod(e.target.value)}
                            />
                          </div>
                          <input
                            className="hr-input"
                            type="text"
                            placeholder="Note (optional)"
                            value={paymentNote}
                            onChange={e => setPaymentNote(e.target.value)}
                          />
                          {paymentError && <p className="hr-form-error" role="alert">{paymentError}</p>}
                          <div className="hr-form-footer" style={{ padding: '8px 0 0', border: 'none' }}>
                            <button className="hr-cancel-btn" onClick={cancelPaymentForm} disabled={paymentSaving}>
                              Cancel
                            </button>
                            <button className="hr-save-btn" onClick={() => handleRecordPayment(p)} disabled={paymentSaving}>
                              {paymentSaving ? 'Recording…' : 'Record payment'}
                            </button>
                          </div>
                        </div>
                      )}

                      {expandedPayslipId === p.id && (
                        <div className="hr-payslip-payment-panel">
                          {!paymentHistoryByPayslip[p.id] ? (
                            <p className="hr-detail-sub">Loading…</p>
                          ) : paymentHistoryByPayslip[p.id].length === 0 ? (
                            <p className="hr-detail-sub">No payments recorded yet.</p>
                          ) : (
                            <ul className="hr-payment-history-list">
                              {paymentHistoryByPayslip[p.id].map(payment => (
                                <li key={payment.id} className="hr-payment-history-item">
                                  <span className="hr-payment-history-amount">{formatNaira(payment.amount)}</span>
                                  <span className="hr-payment-history-meta">
                                    {formatDate(payment.paid_at)}
                                    {payment.method ? ` · ${payment.method}` : ''}
                                    {payment.recorded_by_name ? ` · recorded by ${payment.recorded_by_name}` : ''}
                                  </span>
                                  {payment.note && <span className="hr-payment-history-note">{payment.note}</span>}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="hr-root">
      {renderHeader()}
      <div className="hr-body">
        {renderBody()}
      </div>
      {renderStaffDetailPanel()}
      {renderRunDetailPanel()}
    </div>
  )
}

// ─── Add-assignment row (Session 10b) ──────────────────────────────────────────
// Small standalone component (not an inline closure) since it needs its own
// local subject/class select state, separate from the parent's editForm —
// only committed to editForm.assignment_pairs when "+ Add" is pressed.
function AddAssignmentRow({
  subjects,
  classes,
  existingPairs,
  onAdd,
}: {
  subjects: SubjectOption[]
  classes: ClassOption[]
  existingPairs: { subjectId: string; classNodeId: string }[]
  onAdd: (subjectId: string, classNodeId: string) => void
}) {
  const [subjectId,   setSubjectId]   = useState('')
  const [classNodeId, setClassNodeId] = useState('')

  const alreadyAdded = subjectId && classNodeId &&
    existingPairs.some(p => p.subjectId === subjectId && p.classNodeId === classNodeId)

  function handleAdd() {
    if (!subjectId || !classNodeId || alreadyAdded) return
    onAdd(subjectId, classNodeId)
    setSubjectId('')
    setClassNodeId('')
  }

  return (
    <div className="hr-line-item-row">
      <select
        className="hr-select"
        value={subjectId}
        onChange={e => setSubjectId(e.target.value)}
        aria-label="Subject"
      >
        <option value="">Subject…</option>
        {subjects.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
      <select
        className="hr-select"
        value={classNodeId}
        onChange={e => setClassNodeId(e.target.value)}
        aria-label="Class"
      >
        <option value="">Class…</option>
        {classes.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <button
        className="hr-line-item-add"
        onClick={handleAdd}
        disabled={!subjectId || !classNodeId || Boolean(alreadyAdded)}
      >
        + Add
      </button>
      {alreadyAdded && <p className="hr-detail-sub" style={{ width: '100%' }}>Already assigned.</p>}
    </div>
  )
}
