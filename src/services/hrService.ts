/**
 * hrService.ts
 * Data access layer for the HR module.
 * No browser-only APIs. No UI imports. React Native compatible.
 *
 * Read exports:
 *   loadStaffList()              — all staff with roles (names + role_ids, Session 10a)
 *   loadStaffDetail()            — single staff record with salary structure (+ role_ids)
 *   loadLeaveTypes()             — all leave types for the school
 *   loadLeaveRequests()          — leave requests (filterable by status/staff)
 *   loadPayrollRuns()            — all payroll runs
 *   loadPayslipsForRun()         — payslips for a specific payroll run (+ amount_paid /
 *                                  payment_status, computed from payslip_payments — Session 10c)
 *   loadPayslipPayments()        — payment history for a single payslip (Session 10c)
 *   loadSalaryStructure()        — current salary structure for a staff member (+ pay_frequency)
 *   loadSchoolDefaultPayFrequency() — school-wide default a null pay_frequency falls back to (Session 10c)
 *   loadTeachingAssignmentOptions() — subjects/leaf-classes/current-session-id for the
 *                                  assignment picker (Session 10b)
 *   loadStaffTeachingAssignments() — a staff member's teaching_assignments across ALL
 *                                  sessions (Session 10b — for a teacher summary/history view;
 *                                  HR's edit form itself filters to the current session only)
 *   loadStaffDueForPayment()     — per-staff estimate of who's due for payment in a given
 *                                  month (Session 10a-3) — derived, never stored
 *   loadEligibleStaffForRun()    — active staff with a salary structure, not already having
 *                                  a payslip in a specific run, with gross/deductions/net
 *                                  pre-computed from their live salary_structure (Session 10a-4)
 *   loadStaffDefaultPassword()   — the current default_password/set_at for one staff member,
 *                                  read via the admin-only staff_default_password_view
 *                                  (Session 10b), with client-computed check-on-read expiry
 *                                  (7 days; no cron infra exists in this app)
 *   loadMyPayslips()             — Session 17 — the signed-in staff member's own payslips
 *                                  across all payroll runs, self-scoped (staff_id = self),
 *                                  same amount_paid/payment_status computation as
 *                                  loadPayslipsForRun() but never exposes other staff's rows
 *   loadPayrollVisibilitySettings() — Session 17 — school-wide switch
 *                                  (schools.teacher_payslip_visibility_enabled) plus this
 *                                  staff member's own personal hide preference
 *                                  (staff.payslip_card_hidden), fetched together since
 *                                  TeacherDashboard always needs both to decide what to render
 *
 * Write exports:
 *   updateStaff()                — edit name, email, phone, hire_date, status
 *   updateStaffRoles()           — diff + write staff_roles (additions/removals only;
 *                                  Session 10a, role assignment UI). staff_roles has a
 *                                  school_id column (confirmed live schema, §11 2026-06-24)
 *                                  so it's required here, not just staff_id/role_id.
 *   updateStaffTeachingAssignments() — diff + write teaching_assignments for ONE session
 *                                  (Session 10b) — additions/removals only, same discipline
 *                                  as updateStaffRoles(). This is the first write path ever
 *                                  built for teaching_assignments; Timetable's chip tray only
 *                                  ever read existing rows, never created them.
 *   createLeaveType()            — add a leave type
 *   updateLeaveType()            — edit a leave type
 *   submitLeaveRequest()         — staff submits a leave request
 *   reviewLeaveRequest()         — admin approves or rejects
 *   cancelLeaveRequest()         — staff cancels their own pending request
 *   saveSalaryStructure()        — create or update salary structure for a staff member
 *                                  (+ pay_frequency — Session 10c)
 *   createPayrollRun()           — create a draft payroll run
 *   addPayslip()                 — add a payslip to a draft run
 *   addAllEligiblePayslips()     — bulk-add one payslip per eligible staff member to a run,
 *                                  no per-row review (Session 10a-4); partial failure doesn't
 *                                  block the rest of the batch
 *   removePayslipFromRun()       — remove a payslip from a draft run (Session 10c-2); refuses
 *                                  if the run isn't draft or a payment is already recorded
 *   recordPayslipPayment()       — record one payment (full or partial) against a payslip
 *                                  (Session 10c) — a payslip can receive multiple calls over
 *                                  time; net_amount is never mutated, "paid so far" is always
 *                                  the sum of payslip_payments rows
 *   approvePayrollRun()          — move run from draft → approved
 *   markPayrollRunPaid()         — move run from approved → paid (triggers ledger if enabled)
 *   regenerateStaffPassword()    — calls the regenerate-staff-password Edge Function to reset
 *                                  a staff member's real Auth password and overwrite
 *                                  default_password/set_at (Session 10b)
 *   setSchoolPayslipVisibility() — Session 17 — admin-only write to the school-wide
 *                                  teacher_payslip_visibility_enabled switch
 *   setMyPayslipCardHidden()     — Session 17 — self-service write to the caller's own
 *                                  staff.payslip_card_hidden preference. Hiding needs no
 *                                  extra step. Un-hiding (hidden: false) is only meant to be
 *                                  called after the UI has already re-authenticated the caller
 *                                  with a fresh password prompt — this function does not
 *                                  perform that re-auth itself, see AccountPreferencesScreen.tsx
 *                                  Session 17 changes for where that actually happens
 *
 * Pure helpers:
 *   formatNaira()                — ₦1,234.00
 *   todayDateString()            — YYYY-MM-DD, React Native safe
 *   dateRangeDays()              — inclusive day count between two date strings
 *
 * Session 10b/10c both require a SQL migration run first — see
 * migration_session_10b_10c.sql (schools.default_pay_frequency,
 * salary_structures.pay_frequency, new payslip_payments table). Session 10b
 * needs no schema change — teaching_assignments already existed (§7.11).
 */

import { supabase } from '../lib/supabase'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StaffMember {
  id: string
  full_name: string
  email: string | null
  phone: string | null
  status: 'active' | 'inactive' | 'suspended'
  hire_date: string | null
  roles: string[]                  // role names from staff_roles join
  role_ids: string[]                // role ids from staff_roles join — needed to pre-populate the role-assignment editor (Session 10a)
}

export interface StaffDetail extends StaffMember {
  salary_structure: SalaryStructure | null
}

// Session 10b — default password view/print/regenerate. Read via
// staff_default_password_view (admin-only, see migration_session_10b.sql —
// the view's own WHERE clause restricts this independently of `staff`'s
// permissive [STD] RLS, not RLS pass-through). A null result (no matching
// view row) means either the caller isn't admin, or — most commonly — the
// staff member has no default_password on file at all (never generated one,
// or it was set before this feature existed).
export interface StaffDefaultPassword {
  password: string
  set_at: string
  /** Client-computed, check-on-read (§ migration decision — no cron exists
   *  in this app). True once 7 days have passed since set_at. */
  expired: boolean
  /** NOT a real signal today — always false. Would reflect whether the
   *  staff member has actually signed in since this password was set
   *  (auth.users.last_sign_in_at), but that column is only reachable via
   *  the Auth Admin API (service-role, server-side), not the client SDK,
   *  and app_identities has no mirrored column for it. Kept on the type so
   *  a future Edge Function/trigger can populate it without a breaking
   *  shape change — see loadStaffDefaultPassword()'s comment for detail. */
  claimed: boolean
}

export interface LeaveType {
  id: string
  name: string
  paid: boolean
  annual_allowance_days: number | null
}

export interface LeaveRequest {
  id: string
  staff_id: string
  staff_name: string
  leave_type_id: string
  leave_type_name: string
  start_date: string
  end_date: string
  days: number
  reason: string | null
  status: 'pending' | 'approved' | 'rejected' | 'cancelled'
  reviewed_by_name: string | null
  reviewed_at: string | null
  created_at: string
}

export interface SalaryStructure {
  id: string
  staff_id: string
  basic_salary: number
  allowances: AllowanceItem[]
  deductions: DeductionItem[]
  effective_from: string
  effective_to: string | null
  pay_frequency: PayFrequency | null   // null = "use school default" (Session 10c)
  gross: number           // computed: basic + sum(allowances)
  net: number             // computed: gross - sum(deductions)
}

// Session 10c — 'custom' exists for schools whose pay schedule doesn't fit the
// other three (e.g. bi-weekly, irregular) — no logic branches on 'custom'
// today, it's a label only, same convention as schools.school_type.
export type PayFrequency = 'monthly' | 'termly' | 'sessional' | 'custom'

export interface AllowanceItem {
  label: string
  amount: number
}

export interface DeductionItem {
  label: string
  amount: number
}

export interface PayrollRun {
  id: string
  period_label: string
  period_start: string
  period_end: string
  status: 'draft' | 'approved' | 'paid'
  approved_by_name: string | null
  created_at: string
  total_gross: number | null       // computed from payslips — null until payslips exist
  total_net: number | null
  payslip_count: number
}

export interface Payslip {
  id: string
  payroll_run_id: string
  staff_id: string
  staff_name: string
  gross_amount: number
  total_deductions: number
  net_amount: number
  breakdown: SalaryBreakdown | null
  paid_at: string | null             // Session 10a-5 — most recent payslip_payments.paid_at, derived, not the
                                      // dead payslips.paid_at column (nothing writes that column anymore)
  amount_paid: number               // Session 10c — sum of payslip_payments rows, computed here not stored
  payment_status: PayslipPaymentStatus  // Session 10c — derived from amount_paid vs net_amount
}

// Session 10c — computed client-side from amount_paid vs net_amount, never
// stored, matching the "computed values are views, not columns" convention
// (subject_results §7.14) already used elsewhere in the schema.
export type PayslipPaymentStatus = 'unpaid' | 'partially_paid' | 'paid'

// Session 17 — bundles both flags TeacherDashboard needs in one round trip:
// the school-wide admin switch and this caller's own personal preference.
// Kept as one type/one loader (not two separate calls) since every consumer
// needs both together to decide what to render, same rationale
// loadPayslipsForRun() already applies to bundling amount_paid computation
// alongside the payslip row itself rather than a second query.
export interface PayrollVisibilitySettings {
  schoolEnabled: boolean   // schools.teacher_payslip_visibility_enabled
  selfHidden: boolean      // staff.payslip_card_hidden, for the calling staff member
}


export interface PayslipPayment {
  id: string
  payslip_id: string
  amount: number
  paid_at: string
  method: string | null
  note: string | null
  recorded_by_name: string | null
}

// ─── Session 10d — "who's due this month" ──────────────────────────────────────
// Derived/estimated, never an authoritative deadline: payroll runs are 100%
// manually created in this app (no scheduled-job infrastructure exists to
// auto-generate them — confirmed by grep across the whole project before
// building this). This surfaces a computed estimate so an admin can see who
// likely needs a payroll run this month, not a system that enforces payment.

export type DueReason =
  | 'monthly_no_payslip_this_month'   // monthly frequency, no payslip covering any period in the target month yet
  | 'termly_term_ends_this_month'     // termly frequency, current term's end_date falls in the target month
  | 'sessional_session_ends_this_month' // sessional frequency, current session's end_date falls in the target month
  | 'custom_unknown'                  // custom frequency — can't be computed, flagged for manual check

export interface StaffPaymentDueStatus {
  staff_id: string
  staff_name: string
  pay_frequency: PayFrequency          // effective frequency (own override or school default), never null here
  is_due: boolean
  reason: DueReason | null             // null when not due
  last_payslip_period_end: string | null   // most recent period_end this staff has any payslip for, across all runs
}


// ─── Session 10b — teaching assignments ────────────────────────────────────────
// Mirrors teaching_assignments (§7.11) — the same table Timetable's chip tray
// reads from, but until now nothing in the app ever wrote to it (Timetable's
// tray only ever placed *existing* rows onto the grid). This is the first
// write path for this table.

export interface TeachingAssignment {
  id: string
  staff_id: string
  subject_id: string
  subject_name: string
  class_node_id: string
  class_name: string          // path label, e.g. "Secondary > JSS2 > JSS2A" (see loadStaffTeachingSummary)
  session_id: string
  session_name: string
}

export interface SubjectOption {
  id: string
  name: string
}

export interface ClassOption {
  id: string
  name: string       // full path label
}

export interface SalaryBreakdown {
  basic_salary: number
  allowances: AllowanceItem[]
  deductions: DeductionItem[]
}

// Consistent Result shape
type Ok<T>     = { ok: true; data: T }
type Err       = { ok: false; error: string }
type Result<T> = Ok<T> | Err

// ─── Load staff list ──────────────────────────────────────────────────────────

export async function loadStaffList(schoolId: string): Promise<Result<StaffMember[]>> {
  try {
    const { data, error } = await supabase
      .from('staff')
      .select(`
        id,
        full_name,
        email,
        phone,
        status,
        hire_date,
        staff_roles ( role_id, roles ( name ) )
      `)
      .eq('school_id', schoolId)
      .order('full_name')

    if (error) return { ok: false, error: error.message }

    return {
      ok: true,
      data: (data ?? []).map((r: any) => ({
        id:        r.id,
        full_name: r.full_name,
        email:     r.email ?? null,
        phone:     r.phone ?? null,
        status:    r.status,
        hire_date: r.hire_date ?? null,
        roles:     (r.staff_roles ?? [])
          .map((sr: any) => sr.roles?.name)
          .filter(Boolean),
        role_ids:  (r.staff_roles ?? [])
          .map((sr: any) => sr.role_id)
          .filter(Boolean),
      })),
    }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load staff' }
  }
}

// ─── Load staff detail (with salary structure) ────────────────────────────────

export async function loadStaffDetail(staffId: string): Promise<Result<StaffDetail>> {
  try {
    const { data, error } = await supabase
      .from('staff')
      .select(`
        id,
        full_name,
        email,
        phone,
        status,
        hire_date,
        staff_roles ( role_id, roles ( name ) )
      `)
      .eq('id', staffId)
      .single()

    if (error) return { ok: false, error: error.message }

    const salaryRes = await loadSalaryStructure(staffId)

    return {
      ok: true,
      data: {
        id:               data.id,
        full_name:        data.full_name,
        email:            data.email ?? null,
        phone:            data.phone ?? null,
        status:           data.status,
        hire_date:        data.hire_date ?? null,
        roles:            ((data as any).staff_roles ?? [])
          .map((sr: any) => sr.roles?.name)
          .filter(Boolean),
        role_ids:         ((data as any).staff_roles ?? [])
          .map((sr: any) => sr.role_id)
          .filter(Boolean),
        salary_structure: salaryRes.ok ? salaryRes.data : null,
      },
    }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load staff detail' }
  }
}

// ─── Load staff default password (Session 10b) ────────────────────────────────
// Reads staff_default_password_view, not `staff` directly — the view is the
// only place these two columns are exposed, gated admin-only by its own
// WHERE clause (current_is_admin()), independent of `staff`'s permissive
// [STD] policy. A non-admin caller gets zero rows here, not an RLS error —
// that's by design (see migration_session_10b.sql), so this returns
// { ok: true, data: null } in that case rather than treating it as a
// failure; the caller (HRModule.tsx) should simply not render a password
// panel when data is null, not show an error state.
//
// Expiry is check-on-read (owner-approved decision, no cron infra exists in
// this app): "expired" = more than 7 days since default_password_set_at.
const DEFAULT_PASSWORD_EXPIRY_DAYS = 7

export async function loadStaffDefaultPassword(
  staffId: string,
): Promise<Result<StaffDefaultPassword | null>> {
  try {
    const { data, error } = await supabase
      .from('staff_default_password_view')
      .select('default_password, default_password_set_at')
      .eq('staff_id', staffId)
      .maybeSingle()

    if (error) return { ok: false, error: error.message }
    if (!data || !data.default_password || !data.default_password_set_at) {
      return { ok: true, data: null }
    }

    const setAt = data.default_password_set_at as string
    const ageMs = Date.now() - new Date(setAt).getTime()
    const expired = ageMs > DEFAULT_PASSWORD_EXPIRY_DAYS * 86_400_000

    // "claimed" (has the staff member actually signed in with this password
    // since it was set?) is NOT computed here. The real signal for that,
    // auth.users.last_sign_in_at, lives on Supabase's own auth schema — it
    // is reachable only via the Auth Admin API (service-role key, server
    // side), never through the client SDK/PostgREST, and app_identities has
    // no mirrored column for it (confirmed against §7.2's actual schema —
    // auth_user_id, school_id, actor_type, actor_record_id, login_method,
    // login_code, phone, is_active, created_at, updated_at; nothing else).
    // Inventing a column here rather than flagging the gap would be exactly
    // the mistake this PRD's own verification discipline exists to catch.
    // If "claimed" needs to be real, it requires either a small Edge
    // Function (service-role admin.getUserById) or a DB trigger/column that
    // mirrors last_sign_in_at into app_identities on login — neither exists
    // yet, and building one wasn't asked for as part of this pass. `claimed`
    // is therefore always false today; expiry (7-day check-on-read) is the
    // only real signal this returns, and HRModule.tsx should not present
    // `claimed` as ever true.
    return {
      ok: true,
      data: {
        password: data.default_password as string,
        set_at:   setAt,
        expired,
        claimed:  false,
      },
    }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load default password' }
  }
}

// ─── Write: regenerate staff default password (Session 10b) ───────────────────
// Calls the regenerate-staff-password Edge Function (service-role key,
// mirrors create-staff-account's auth/admin-check pattern exactly) rather
// than writing to `staff` directly — a real Auth password reset requires
// admin.updateUserById, which is only available server-side. This function
// is a thin client wrapper; all the actual authorization/identity checks
// happen inside the Edge Function itself, independent of this call site.
export async function regenerateStaffPassword(params: {
  schoolId: string
  staffId: string
}): Promise<Result<{ temp_password: string }>> {
  try {
    const { data, error } = await supabase.functions.invoke('regenerate-staff-password', {
      body: { school_id: params.schoolId, staff_id: params.staffId },
    })

    if (error) {
      return { ok: false, error: error.message ?? 'Failed to regenerate password' }
    }
    if (!data?.ok) {
      return { ok: false, error: data?.error ?? 'Failed to regenerate password' }
    }
    return { ok: true, data: { temp_password: data.temp_password } }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to regenerate password' }
  }
}

export async function loadLeaveTypes(): Promise<Result<LeaveType[]>> {
  try {
    const { data, error } = await supabase
      .from('leave_types')
      .select('id, name, paid, annual_allowance_days')
      .order('name')

    if (error) return { ok: false, error: error.message }

    return {
      ok: true,
      data: (data ?? []).map((r: any) => ({
        id:                    r.id,
        name:                  r.name,
        paid:                  r.paid,
        annual_allowance_days: r.annual_allowance_days ?? null,
      })),
    }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load leave types' }
  }
}

// ─── Load leave requests ──────────────────────────────────────────────────────

export async function loadLeaveRequests(params: {
  status?: 'pending' | 'approved' | 'rejected' | 'cancelled' | null
  staffId?: string | null
}): Promise<Result<LeaveRequest[]>> {
  try {
    let query = supabase
      .from('leave_requests')
      .select(`
        id,
        staff_id,
        leave_type_id,
        start_date,
        end_date,
        reason,
        status,
        reviewed_at,
        created_at,
        staff!leave_requests_staff_id_fkey ( full_name ),
        leave_types ( name ),
        reviewer:staff!leave_requests_reviewed_by_fkey ( full_name )
      `)
      .order('created_at', { ascending: false })

    if (params.status) {
      query = query.eq('status', params.status)
    }
    if (params.staffId) {
      query = query.eq('staff_id', params.staffId)
    }

    const { data, error } = await query
    if (error) return { ok: false, error: error.message }

    return {
      ok: true,
      data: (data ?? []).map((r: any) => ({
        id:               r.id,
        staff_id:         r.staff_id,
        staff_name:       r.staff?.full_name ?? '—',
        leave_type_id:    r.leave_type_id,
        leave_type_name:  r.leave_types?.name ?? '—',
        start_date:       r.start_date,
        end_date:         r.end_date,
        days:             dateRangeDays(r.start_date, r.end_date),
        reason:           r.reason ?? null,
        status:           r.status,
        reviewed_by_name: r.reviewer?.full_name ?? null,
        reviewed_at:      r.reviewed_at ?? null,
        created_at:       r.created_at,
      })),
    }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load leave requests' }
  }
}

// ─── Load salary structure (current, latest effective_from) ───────────────────

export async function loadSalaryStructure(
  staffId: string,
): Promise<Result<SalaryStructure | null>> {
  try {
    const { data, error } = await supabase
      .from('salary_structures')
      .select('id, staff_id, basic_salary, allowances, deductions, effective_from, effective_to, pay_frequency')
      .eq('staff_id', staffId)
      .order('effective_from', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) return { ok: false, error: error.message }
    if (!data)  return { ok: true, data: null }

    const allowances: AllowanceItem[] = Array.isArray(data.allowances) ? data.allowances : []
    const deductions: DeductionItem[] = Array.isArray(data.deductions) ? data.deductions : []
    const basic = Number(data.basic_salary)
    const gross = basic + allowances.reduce((s, a) => s + Number(a.amount), 0)
    const net   = gross - deductions.reduce((s, d) => s + Number(d.amount), 0)

    return {
      ok: true,
      data: {
        id:             data.id,
        staff_id:       data.staff_id,
        basic_salary:   basic,
        allowances,
        deductions,
        effective_from: data.effective_from,
        effective_to:   data.effective_to ?? null,
        pay_frequency:  (data.pay_frequency as PayFrequency | null) ?? null,
        gross,
        net,
      },
    }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load salary structure' }
  }
}

// ─── Load school default pay frequency (Session 10c) ──────────────────────────
// A staff member's own salary_structures.pay_frequency is null unless someone
// explicitly overrides it — in which case the UI needs to know and show the
// school-wide default it's falling back to. schools.default_pay_frequency was
// not previously read by this file (HR had no pay-frequency concept before
// Session 10c) — same pattern as reading uses_terms/uses_ledger elsewhere.

export async function loadSchoolDefaultPayFrequency(
  schoolId: string,
): Promise<Result<PayFrequency>> {
  try {
    const { data, error } = await supabase
      .from('schools')
      .select('default_pay_frequency')
      .eq('id', schoolId)
      .single()

    if (error) return { ok: false, error: error.message }
    return { ok: true, data: (data.default_pay_frequency as PayFrequency) ?? 'monthly' }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load school pay frequency' }
  }
}

// ─── Session 10b — read: options for the assignment form ──────────────────────
// Subjects list + leaf class list (path-labelled) + the current session id —
// everything the HR staff-edit form's subject/class picker needs. Leaf-class
// path-label convention ("Parent · Child") matches studentsService.ts's
// loadLeafClasses() exactly, not a new convention invented for this form.

export async function loadTeachingAssignmentOptions(schoolId: string): Promise<Result<{
  subjects: SubjectOption[]
  classes: ClassOption[]
  currentSessionId: string | null
}>> {
  try {
    const [subjectsRes, classesRes, sessionRes] = await Promise.all([
      supabase.from('subjects').select('id, name').eq('school_id', schoolId).order('name'),
      supabase.from('class_nodes').select('id, name, parent_id').eq('school_id', schoolId).eq('is_leaf_enrollable', true),
      supabase.from('sessions').select('id').eq('school_id', schoolId).eq('is_current', true).maybeSingle(),
    ])

    if (subjectsRes.error) return { ok: false, error: subjectsRes.error.message }
    if (classesRes.error)  return { ok: false, error: classesRes.error.message }
    if (sessionRes.error)  return { ok: false, error: sessionRes.error.message }

    // Need parent names to build "Parent · Child" path labels — fetch all
    // class_nodes (not just leaves) once, keyed by id, same approach as
    // studentsService.ts's buildClassPathMap().
    const { data: allNodes, error: allNodesError } = await supabase
      .from('class_nodes')
      .select('id, name, parent_id')
      .eq('school_id', schoolId)

    if (allNodesError) return { ok: false, error: allNodesError.message }

    const nodeById = new Map((allNodes ?? []).map((n: any) => [n.id as string, n]))
    const pathLabel = (nodeId: string): string => {
      const node = nodeById.get(nodeId)
      if (!node) return '—'
      const parent = node.parent_id ? nodeById.get(node.parent_id) : null
      return parent ? `${parent.name} · ${node.name}` : node.name
    }

    return {
      ok: true,
      data: {
        subjects: (subjectsRes.data ?? []).map((s: any) => ({ id: s.id, name: s.name })),
        classes:  (classesRes.data ?? []).map((c: any) => ({ id: c.id, name: pathLabel(c.id) })),
        currentSessionId: sessionRes.data?.id ?? null,
      },
    }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load assignment options' }
  }
}

// ─── Session 10b — read: a staff member's teaching assignments ────────────────
// Returns every teaching_assignments row for this staff member across all
// sessions (not just current) — the HR edit form filters to currentSessionId
// itself for the editable list; the full history is for the teacher summary
// view (per owner's confirmed design: "past sessions assignment history may
// appear in teacher's summary page, including what he teaches now").

export async function loadStaffTeachingAssignments(staffId: string): Promise<Result<TeachingAssignment[]>> {
  try {
    const { data, error } = await supabase
      .from('teaching_assignments')
      .select(`
        id,
        staff_id,
        subject_id,
        class_node_id,
        session_id,
        subjects ( name ),
        class_nodes ( name, parent_id ),
        sessions ( name )
      `)
      .eq('staff_id', staffId)

    if (error) return { ok: false, error: error.message }

    // Path labels need the parent's name too — same "Parent · Child" pattern,
    // resolved with one extra lookup rather than a second round trip per row.
    const parentIds = [...new Set(
      (data ?? [])
        .map((r: any) => r.class_nodes?.parent_id)
        .filter(Boolean)
    )] as string[]

    let parentNameById = new Map<string, string>()
    if (parentIds.length > 0) {
      const { data: parents, error: parentsError } = await supabase
        .from('class_nodes')
        .select('id, name')
        .in('id', parentIds)
      if (parentsError) return { ok: false, error: parentsError.message }
      parentNameById = new Map((parents ?? []).map((p: any) => [p.id as string, p.name as string]))
    }

    return {
      ok: true,
      data: (data ?? []).map((r: any) => {
        const parentName = r.class_nodes?.parent_id ? parentNameById.get(r.class_nodes.parent_id) : null
        return {
          id:            r.id,
          staff_id:      r.staff_id,
          subject_id:    r.subject_id,
          subject_name:  r.subjects?.name ?? '—',
          class_node_id: r.class_node_id,
          class_name:    parentName ? `${parentName} · ${r.class_nodes?.name}` : (r.class_nodes?.name ?? '—'),
          session_id:    r.session_id,
          session_name:  r.sessions?.name ?? '—',
        }
      }),
    }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load teaching assignments' }
  }
}

// ─── Load "who's due this month" (Session 10d) ─────────────────────────────────
// targetMonth format: 'YYYY-MM'. Computes an estimate per active staff member
// with a salary structure — see DueReason for exactly what "due" means per
// frequency. Intentionally excludes staff with no salary_structures row at
// all (nothing to estimate against) rather than reporting them as "due."

export async function loadStaffDueForPayment(
  schoolId: string,
  targetMonth: string,
): Promise<Result<StaffPaymentDueStatus[]>> {
  try {
    const [monthStart, monthEndExclusive] = monthBounds(targetMonth)

    const [staffRes, schoolRes, currentSessionRes] = await Promise.all([
      supabase
        .from('staff')
        .select('id, full_name, status, salary_structures ( basic_salary, effective_from, effective_to, pay_frequency )')
        .eq('school_id', schoolId)
        .eq('status', 'active'),
      supabase.from('schools').select('default_pay_frequency').eq('id', schoolId).single(),
      supabase.from('sessions').select('id, end_date').eq('school_id', schoolId).eq('is_current', true).maybeSingle(),
    ])

    if (staffRes.error)         return { ok: false, error: staffRes.error.message }
    if (schoolRes.error)        return { ok: false, error: schoolRes.error.message }
    if (currentSessionRes.error) return { ok: false, error: currentSessionRes.error.message }

    const schoolDefault = (schoolRes.data?.default_pay_frequency as PayFrequency) ?? 'monthly'

    // Current term (only meaningful for termly frequency) — resolved
    // separately since it depends on the current session's id.
    let currentTermEndDate: string | null = null
    if (currentSessionRes.data?.id) {
      const today = todayDateString()
      const { data: term, error: termError } = await supabase
        .from('terms')
        .select('end_date')
        .eq('session_id', currentSessionRes.data.id)
        .lte('start_date', today)
        .gte('end_date', today)
        .maybeSingle()
      if (termError) return { ok: false, error: termError.message }
      currentTermEndDate = term?.end_date ?? null
    }
    const currentSessionEndDate = currentSessionRes.data?.end_date ?? null

    // Only staff with a real salary_structures row are candidates. Each
    // staff row's salary_structures is fetched unfiltered (all historical
    // rows) — same "cast through unknown → array" pattern as
    // loadSalaryStructure — then reduced to the latest by effective_from
    // client-side, since PostgREST can't order-and-limit within a nested
    // embed.
    const candidates = (staffRes.data ?? [])
      .map((r: any) => {
        const rows = (r.salary_structures as unknown as {
          basic_salary: number
          effective_from: string
          effective_to: string | null
          pay_frequency: PayFrequency | null
        }[] | null) ?? []
        if (rows.length === 0) return null
        const latest = [...rows].sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0]
        return { staffId: r.id as string, staffName: r.full_name as string, latest }
      })
      .filter(Boolean) as { staffId: string; staffName: string; latest: { effective_from: string; effective_to: string | null; pay_frequency: PayFrequency | null } }[]

    if (candidates.length === 0) return { ok: true, data: [] }

    // Last payslip period per staff, across ALL runs — no existing query
    // does this (every payslip read to date is scoped by payroll_run_id, not
    // staff_id). One query, grouped client-side.
    const { data: payslipRows, error: payslipError } = await supabase
      .from('payslips')
      .select('staff_id, payroll_runs ( period_end )')
      .in('staff_id', candidates.map(c => c.staffId))

    if (payslipError) return { ok: false, error: payslipError.message }

    const lastPeriodEndByStaff = new Map<string, string>()
    for (const row of (payslipRows ?? []) as any[]) {
      const periodEnd = row.payroll_runs?.period_end as string | undefined
      if (!periodEnd) continue
      const existing = lastPeriodEndByStaff.get(row.staff_id)
      if (!existing || periodEnd > existing) {
        lastPeriodEndByStaff.set(row.staff_id, periodEnd)
      }
    }

    const results: StaffPaymentDueStatus[] = candidates.map(c => {
      const frequency = c.latest.pay_frequency ?? schoolDefault
      const lastPeriodEnd = lastPeriodEndByStaff.get(c.staffId) ?? null

      // Salary structure must actually be active during the target month —
      // a structure that ended before this month, or starts after it, isn't
      // a candidate for "due this month."
      if (c.latest.effective_from >= monthEndExclusive) {
        return { staff_id: c.staffId, staff_name: c.staffName, pay_frequency: frequency, is_due: false, reason: null, last_payslip_period_end: lastPeriodEnd }
      }
      if (c.latest.effective_to && c.latest.effective_to < monthStart) {
        return { staff_id: c.staffId, staff_name: c.staffName, pay_frequency: frequency, is_due: false, reason: null, last_payslip_period_end: lastPeriodEnd }
      }

      if (frequency === 'monthly') {
        const alreadyPaidThisMonth = lastPeriodEnd !== null && lastPeriodEnd >= monthStart && lastPeriodEnd < monthEndExclusive
        return {
          staff_id: c.staffId, staff_name: c.staffName, pay_frequency: frequency,
          is_due: !alreadyPaidThisMonth,
          reason: alreadyPaidThisMonth ? null : 'monthly_no_payslip_this_month',
          last_payslip_period_end: lastPeriodEnd,
        }
      }

      if (frequency === 'termly') {
        const termDueThisMonth = currentTermEndDate !== null && currentTermEndDate >= monthStart && currentTermEndDate < monthEndExclusive
        const alreadyPaidForTerm = lastPeriodEnd !== null && currentTermEndDate !== null && lastPeriodEnd >= currentTermEndDate
        return {
          staff_id: c.staffId, staff_name: c.staffName, pay_frequency: frequency,
          is_due: termDueThisMonth && !alreadyPaidForTerm,
          reason: (termDueThisMonth && !alreadyPaidForTerm) ? 'termly_term_ends_this_month' : null,
          last_payslip_period_end: lastPeriodEnd,
        }
      }

      if (frequency === 'sessional') {
        const sessionDueThisMonth = currentSessionEndDate !== null && currentSessionEndDate >= monthStart && currentSessionEndDate < monthEndExclusive
        const alreadyPaidForSession = lastPeriodEnd !== null && currentSessionEndDate !== null && lastPeriodEnd >= currentSessionEndDate
        return {
          staff_id: c.staffId, staff_name: c.staffName, pay_frequency: frequency,
          is_due: sessionDueThisMonth && !alreadyPaidForSession,
          reason: (sessionDueThisMonth && !alreadyPaidForSession) ? 'sessional_session_ends_this_month' : null,
          last_payslip_period_end: lastPeriodEnd,
        }
      }

      // 'custom' — genuinely can't be computed from any data this app has.
      // Flagged explicitly rather than silently omitted or guessed at.
      return {
        staff_id: c.staffId, staff_name: c.staffName, pay_frequency: frequency,
        is_due: false, reason: 'custom_unknown', last_payslip_period_end: lastPeriodEnd,
      }
    })

    return { ok: true, data: results }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? "Failed to load who's due for payment" }
  }
}

// monthBounds('2026-07') -> ['2026-07-01', '2026-08-01') — half-open range,
// avoids end-of-month day-count edge cases (28/29/30/31).
function monthBounds(targetMonth: string): [string, string] {
  const [year, month] = targetMonth.split('-').map(Number)
  const start = `${targetMonth}-01`
  const nextMonth = month === 12 ? 1 : month + 1
  const nextYear  = month === 12 ? year + 1 : year
  const end = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`
  return [start, end]
}



export async function loadPayrollRuns(): Promise<Result<PayrollRun[]>> {
  try {
    const { data, error } = await supabase
      .from('payroll_runs')
      .select(`
        id,
        period_label,
        period_start,
        period_end,
        status,
        created_at,
        approver:staff!payroll_runs_approved_by_fkey ( full_name ),
        payslips ( gross_amount, net_amount )
      `)
      .order('period_start', { ascending: false })

    if (error) return { ok: false, error: error.message }

    return {
      ok: true,
      data: (data ?? []).map((r: any) => {
        const slips: any[] = r.payslips ?? []
        const total_gross = slips.length > 0
          ? slips.reduce((s: number, p: any) => s + Number(p.gross_amount), 0)
          : null
        const total_net = slips.length > 0
          ? slips.reduce((s: number, p: any) => s + Number(p.net_amount), 0)
          : null
        return {
          id:               r.id,
          period_label:     r.period_label,
          period_start:     r.period_start,
          period_end:       r.period_end,
          status:           r.status,
          approved_by_name: r.approver?.full_name ?? null,
          created_at:       r.created_at,
          total_gross,
          total_net,
          payslip_count:    slips.length,
        }
      }),
    }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load payroll runs' }
  }
}

// ─── Load payslips for a run ──────────────────────────────────────────────────

export async function loadPayslipsForRun(runId: string): Promise<Result<Payslip[]>> {
  try {
    const { data, error } = await supabase
      .from('payslips')
      .select(`
        id,
        payroll_run_id,
        staff_id,
        gross_amount,
        total_deductions,
        net_amount,
        breakdown,
        staff ( full_name ),
        payslip_payments ( amount, paid_at )
      `)
      .eq('payroll_run_id', runId)
      .order('created_at')

    if (error) return { ok: false, error: error.message }

    return {
      ok: true,
      data: (data ?? []).map((r: any) => {
        const netAmount   = Number(r.net_amount)
        const paymentRows = (r.payslip_payments as { amount: number; paid_at: string }[] | null) ?? []
        const amountPaid  = paymentRows.reduce((sum, p) => sum + Number(p.amount), 0)
        const paymentStatus: PayslipPaymentStatus =
          amountPaid <= 0            ? 'unpaid'
          : amountPaid >= netAmount  ? 'paid'
          :                            'partially_paid'
        // Most recent payment's date, if any — replaces the old bulk-stamped
        // payslips.paid_at column, which nothing writes anymore as of
        // Session 10a-5 (markPayrollRunPaid no longer touches payslips at all).
        const lastPaidAt = paymentRows.length === 0
          ? null
          : paymentRows.reduce((latest, p) => (!latest || p.paid_at > latest ? p.paid_at : latest), null as string | null)

        return {
          id:               r.id,
          payroll_run_id:   r.payroll_run_id,
          staff_id:         r.staff_id,
          staff_name:       r.staff?.full_name ?? '—',
          gross_amount:     Number(r.gross_amount),
          total_deductions: Number(r.total_deductions),
          net_amount:       netAmount,
          breakdown:        r.breakdown ?? null,
          paid_at:          lastPaidAt,
          amount_paid:      amountPaid,
          payment_status:   paymentStatus,
        }
      }),
    }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load payslips' }
  }
}

// ─── Load payments recorded against a single payslip (Session 10c) ────────────

export async function loadPayslipPayments(payslipId: string): Promise<Result<PayslipPayment[]>> {
  try {
    const { data, error } = await supabase
      .from('payslip_payments')
      .select('id, payslip_id, amount, paid_at, method, note, staff ( full_name )')
      .eq('payslip_id', payslipId)
      .order('paid_at', { ascending: false })

    if (error) return { ok: false, error: error.message }

    return {
      ok: true,
      data: (data ?? []).map((r: any) => ({
        id:               r.id,
        payslip_id:       r.payslip_id,
        amount:           Number(r.amount),
        paid_at:          r.paid_at,
        method:           r.method ?? null,
        note:             r.note ?? null,
        recorded_by_name: r.staff?.full_name ?? null,
      })),
    }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load payment history' }
  }
}

// ─── Write: update staff ──────────────────────────────────────────────────────

export async function updateStaff(params: {
  id: string
  full_name: string
  email: string | null
  phone: string | null
  hire_date: string | null
  status: 'active' | 'inactive' | 'suspended'
}): Promise<Result<void>> {
  try {
    const { error } = await supabase
      .from('staff')
      .update({
        full_name: params.full_name.trim(),
        email:     params.email?.trim() || null,
        phone:     params.phone?.trim() || null,
        hire_date: params.hire_date || null,
        status:    params.status,
      })
      .eq('id', params.id)

    if (error) return { ok: false, error: friendlyStaffError(error.message) }
    return { ok: true, data: undefined }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to update staff' }
  }
}

// ─── Write: update staff role assignment (Session 10a) ────────────────────────
// Diffs the staff member's current staff_roles rows against the newly-selected
// role id set and writes only the delta (additions inserted, removals deleted) —
// not a blind delete-then-reinsert, so untouched rows/timestamps aren't churned.

export async function updateStaffRoles(params: {
  staffId: string
  schoolId: string
  roleIds: string[]                // full desired set of role ids, post-edit
}): Promise<Result<void>> {
  try {
    const { data: existingRows, error: readError } = await supabase
      .from('staff_roles')
      .select('role_id')
      .eq('staff_id', params.staffId)

    if (readError) return { ok: false, error: friendlyStaffError(readError.message) }

    const currentIds = new Set((existingRows ?? []).map((r: any) => r.role_id as string))
    const desiredIds = new Set(params.roleIds)

    const toAdd    = params.roleIds.filter(id => !currentIds.has(id))
    const toRemove = [...currentIds].filter(id => !desiredIds.has(id))

    if (toAdd.length > 0) {
      const { error: insertError } = await supabase
        .from('staff_roles')
        .insert(toAdd.map(roleId => ({
          staff_id:  params.staffId,
          role_id:   roleId,
          school_id: params.schoolId,
        })))
      if (insertError) return { ok: false, error: friendlyStaffError(insertError.message) }
    }

    if (toRemove.length > 0) {
      const { error: deleteError } = await supabase
        .from('staff_roles')
        .delete()
        .eq('staff_id', params.staffId)
        .in('role_id', toRemove)
      if (deleteError) return { ok: false, error: friendlyStaffError(deleteError.message) }
    }

    return { ok: true, data: undefined }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to update staff roles' }
  }
}

// ─── Write: update staff teaching assignments for the current session ─────────
// (Session 10b) Scoped to a single session_id — per the owner's confirmed
// design, HR's edit UI only edits the *current* session's assignments; past
// sessions are read-only history (surfaced via loadStaffTeachingAssignments()
// in a teacher summary view, not editable here). Diffs the desired
// (subject_id, class_node_id) pair set against what already exists for this
// staff+session and writes only the delta — same discipline as
// updateStaffRoles(), not a blind delete-then-reinsert.

export async function updateStaffTeachingAssignments(params: {
  staffId: string
  schoolId: string
  sessionId: string
  pairs: { subjectId: string; classNodeId: string }[]   // full desired set, post-edit
}): Promise<Result<void>> {
  try {
    const { data: existingRows, error: readError } = await supabase
      .from('teaching_assignments')
      .select('id, subject_id, class_node_id')
      .eq('staff_id', params.staffId)
      .eq('session_id', params.sessionId)

    if (readError) return { ok: false, error: friendlyTeachingAssignmentError(readError.message) }

    const pairKey = (subjectId: string, classNodeId: string) => `${subjectId}::${classNodeId}`

    const existingByKey = new Map(
      (existingRows ?? []).map((r: any) => [pairKey(r.subject_id, r.class_node_id), r.id as string])
    )
    const desiredKeys = new Set(params.pairs.map(p => pairKey(p.subjectId, p.classNodeId)))

    const toAdd    = params.pairs.filter(p => !existingByKey.has(pairKey(p.subjectId, p.classNodeId)))
    const toRemove = [...existingByKey.entries()]
      .filter(([key]) => !desiredKeys.has(key))
      .map(([, id]) => id)

    if (toAdd.length > 0) {
      const { error: insertError } = await supabase
        .from('teaching_assignments')
        .insert(toAdd.map(p => ({
          school_id:     params.schoolId,
          staff_id:      params.staffId,
          subject_id:    p.subjectId,
          class_node_id: p.classNodeId,
          session_id:    params.sessionId,
        })))
      if (insertError) return { ok: false, error: friendlyTeachingAssignmentError(insertError.message) }
    }

    if (toRemove.length > 0) {
      const { error: deleteError } = await supabase
        .from('teaching_assignments')
        .delete()
        .in('id', toRemove)
      if (deleteError) return { ok: false, error: friendlyTeachingAssignmentError(deleteError.message) }
    }

    return { ok: true, data: undefined }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to update teaching assignments' }
  }
}

// ─── Write: create leave type ─────────────────────────────────────────────────

export async function createLeaveType(params: {
  schoolId: string
  name: string
  paid: boolean
  annual_allowance_days: number | null
}): Promise<Result<{ id: string }>> {
  try {
    const { data, error } = await supabase
      .from('leave_types')
      .insert({
        school_id:             params.schoolId,
        name:                  params.name.trim(),
        paid:                  params.paid,
        annual_allowance_days: params.annual_allowance_days ?? null,
      })
      .select('id')
      .single()

    if (error) return { ok: false, error: friendlyLeaveTypeError(error.message) }
    return { ok: true, data: { id: data.id } }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to create leave type' }
  }
}

// ─── Write: update leave type ─────────────────────────────────────────────────

export async function updateLeaveType(params: {
  id: string
  name: string
  paid: boolean
  annual_allowance_days: number | null
}): Promise<Result<void>> {
  try {
    const { error } = await supabase
      .from('leave_types')
      .update({
        name:                  params.name.trim(),
        paid:                  params.paid,
        annual_allowance_days: params.annual_allowance_days ?? null,
      })
      .eq('id', params.id)

    if (error) return { ok: false, error: friendlyLeaveTypeError(error.message) }
    return { ok: true, data: undefined }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to update leave type' }
  }
}

// ─── Write: submit leave request ──────────────────────────────────────────────

/**
 * Staff members submit their own leave request.
 * `staffId` must be the calling user's staff record ID.
 * Resolved from app_identities at the call site (same pattern as recordPayment).
 */
export async function submitLeaveRequest(params: {
  schoolId: string
  staffId: string
  leaveTypeId: string
  startDate: string
  endDate: string
  reason: string | null
}): Promise<Result<{ id: string }>> {
  try {
    const { data, error } = await supabase
      .from('leave_requests')
      .insert({
        school_id:     params.schoolId,
        staff_id:      params.staffId,
        leave_type_id: params.leaveTypeId,
        start_date:    params.startDate,
        end_date:      params.endDate,
        reason:        params.reason?.trim() || null,
        status:        'pending',
      })
      .select('id')
      .single()

    if (error) return { ok: false, error: friendlyLeaveError(error.message) }
    return { ok: true, data: { id: data.id } }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to submit leave request' }
  }
}

// ─── Write: review leave request (approve / reject) ───────────────────────────

export async function reviewLeaveRequest(params: {
  requestId: string
  decision: 'approved' | 'rejected'
  authUserId: string             // resolved to staff.id via app_identities
}): Promise<Result<void>> {
  try {
    // Resolve reviewer staff.id
    let reviewerStaffId: string | null = null
    if (params.authUserId) {
      const { data: identity } = await supabase
        .from('app_identities')
        .select('actor_record_id, actor_type')
        .eq('auth_user_id', params.authUserId)
        .maybeSingle()
      if (identity?.actor_type === 'staff') {
        reviewerStaffId = identity.actor_record_id
      }
    }

    const { error } = await supabase
      .from('leave_requests')
      .update({
        status:      params.decision,
        reviewed_by: reviewerStaffId,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', params.requestId)

    if (error) return { ok: false, error: error.message }
    return { ok: true, data: undefined }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to review leave request' }
  }
}

// ─── Write: cancel leave request ──────────────────────────────────────────────

export async function cancelLeaveRequest(
  requestId: string,
): Promise<Result<void>> {
  try {
    const { error } = await supabase
      .from('leave_requests')
      .update({ status: 'cancelled' })
      .eq('id', requestId)
      .eq('status', 'pending')  // can only cancel pending requests

    if (error) return { ok: false, error: error.message }
    return { ok: true, data: undefined }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to cancel leave request' }
  }
}

// ─── Write: save salary structure ─────────────────────────────────────────────

/**
 * Creates a new salary structure row for the staff member.
 * The old row is left in place (historical record).
 * `effective_from` defaults to today if not provided.
 */
export async function saveSalaryStructure(params: {
  schoolId: string
  staffId: string
  basic_salary: number
  allowances: AllowanceItem[]
  deductions: DeductionItem[]
  effective_from: string
  pay_frequency: PayFrequency | null   // null = defer to school default (Session 10c)
}): Promise<Result<{ id: string }>> {
  try {
    const { data, error } = await supabase
      .from('salary_structures')
      .insert({
        school_id:      params.schoolId,
        staff_id:       params.staffId,
        basic_salary:   params.basic_salary,
        allowances:     params.allowances,
        deductions:     params.deductions,
        effective_from: params.effective_from,
        pay_frequency:  params.pay_frequency,
      })
      .select('id')
      .single()

    if (error) return { ok: false, error: friendlySalaryError(error.message) }
    return { ok: true, data: { id: data.id } }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to save salary structure' }
  }
}

// ─── Write: create payroll run ────────────────────────────────────────────────

export async function createPayrollRun(params: {
  schoolId: string
  period_label: string
  period_start: string
  period_end: string
}): Promise<Result<{ id: string }>> {
  try {
    const { data, error } = await supabase
      .from('payroll_runs')
      .insert({
        school_id:    params.schoolId,
        period_label: params.period_label.trim(),
        period_start: params.period_start,
        period_end:   params.period_end,
        status:       'draft',
      })
      .select('id')
      .single()

    if (error) return { ok: false, error: friendlyPayrollError(error.message) }
    return { ok: true, data: { id: data.id } }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to create payroll run' }
  }
}

// ─── Write: add payslip to run ────────────────────────────────────────────────

export async function addPayslip(params: {
  schoolId: string
  payrollRunId: string
  staffId: string
  gross_amount: number
  total_deductions: number
  net_amount: number
  breakdown: SalaryBreakdown
}): Promise<Result<{ id: string }>> {
  try {
    const { data, error } = await supabase
      .from('payslips')
      .insert({
        school_id:        params.schoolId,
        payroll_run_id:   params.payrollRunId,
        staff_id:         params.staffId,
        gross_amount:     params.gross_amount,
        total_deductions: params.total_deductions,
        net_amount:       params.net_amount,
        breakdown:        params.breakdown,
      })
      .select('id')
      .single()

    if (error) return { ok: false, error: friendlyPayrollError(error.message) }
    return { ok: true, data: { id: data.id } }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to add payslip' }
  }
}

// ─── Session 10a-4 — "Add payslip(s)" to a run ─────────────────────────────────
// Closes a real gap surfaced by 10a-3's "who's due" panel: addPayslip() existed
// but no UI ever called it, so payslips.rows for a run could never actually be
// created — meaning loadStaffDueForPayment() could never see anyone as "paid,"
// regardless of run status. Approving/marking a run paid never created payslip
// rows either; that was always a separate, missing step.

export interface EligiblePayslipCandidate {
  staff_id: string
  staff_name: string
  gross_amount: number
  total_deductions: number
  net_amount: number
  breakdown: SalaryBreakdown
}

// Active staff with a salary structure, not already having a payslip in this
// specific run. One batched pass (staff+salary in one embedded query, existing
// payslips in a second), not N sequential per-staff calls.
export async function loadEligibleStaffForRun(
  schoolId: string,
  payrollRunId: string,
): Promise<Result<EligiblePayslipCandidate[]>> {
  try {
    const [staffRes, existingRes] = await Promise.all([
      supabase
        .from('staff')
        .select('id, full_name, salary_structures ( basic_salary, allowances, deductions, effective_from, effective_to )')
        .eq('school_id', schoolId)
        .eq('status', 'active'),
      supabase
        .from('payslips')
        .select('staff_id')
        .eq('payroll_run_id', payrollRunId),
    ])

    if (staffRes.error)    return { ok: false, error: staffRes.error.message }
    if (existingRes.error) return { ok: false, error: existingRes.error.message }

    const alreadyInRun = new Set((existingRes.data ?? []).map((r: any) => r.staff_id as string))

    const candidates: EligiblePayslipCandidate[] = (staffRes.data ?? [])
      .filter((r: any) => !alreadyInRun.has(r.id))
      .map((r: any) => {
        const rows = (r.salary_structures as unknown as {
          basic_salary: number
          allowances: AllowanceItem[] | null
          deductions: DeductionItem[] | null
          effective_from: string
          effective_to: string | null
        }[] | null) ?? []
        if (rows.length === 0) return null
        const latest = [...rows].sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0]

        const allowances: AllowanceItem[] = Array.isArray(latest.allowances) ? latest.allowances : []
        const deductions: DeductionItem[] = Array.isArray(latest.deductions) ? latest.deductions : []
        const basic = Number(latest.basic_salary)
        const gross = basic + allowances.reduce((s, a) => s + Number(a.amount), 0)
        const net   = gross - deductions.reduce((s, d) => s + Number(d.amount), 0)

        return {
          staff_id:         r.id as string,
          staff_name:       r.full_name as string,
          gross_amount:     gross,
          total_deductions: gross - net,
          net_amount:       net,
          breakdown:        { basic_salary: basic, allowances, deductions },
        }
      })
      .filter(Boolean) as EligiblePayslipCandidate[]

    return { ok: true, data: candidates }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load eligible staff' }
  }
}

// Bulk path: insert one payslip per candidate, no per-row review — the number
// is exactly what loadEligibleStaffForRun just computed from each staff
// member's live salary_structure. If any single insert fails, the rest still
// proceed (one bad row shouldn't block the whole batch); failures are
// collected and returned so the caller can show exactly who didn't get added.
export async function addAllEligiblePayslips(
  schoolId: string,
  payrollRunId: string,
  candidates: EligiblePayslipCandidate[],
): Promise<Result<{ added: number; failed: { staff_name: string; error: string }[] }>> {
  try {
    const failed: { staff_name: string; error: string }[] = []
    let added = 0
    for (const c of candidates) {
      const res = await addPayslip({
        schoolId,
        payrollRunId,
        staffId: c.staff_id,
        gross_amount: c.gross_amount,
        total_deductions: c.total_deductions,
        net_amount: c.net_amount,
        breakdown: c.breakdown,
      })
      if (res.ok) added++
      else failed.push({ staff_name: c.staff_name, error: res.error })
    }
    return { ok: true, data: { added, failed } }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to add payslips' }
  }
}


// Each call inserts one payslip_payments row — a single payslip can receive
// multiple calls over time (partial/split payments). net_amount on payslips
// itself is never touched; "how much is left" is always derived by summing
// these rows against it, both here and in loadPayslipsForRun(). Overpayment
// (amount pushing amount_paid past net_amount) is intentionally not blocked
// here — same "don't invent a rule the owner didn't ask for" caution as the
// rest of this file — the UI can warn before calling this if desired.

export async function recordPayslipPayment(params: {
  schoolId: string
  payslipId: string
  amount: number
  paid_at: string          // ISO date/timestamp — caller-supplied so a payment can be backdated
  method: string | null
  note: string | null
  recordedByStaffId: string   // currentStaffId, already resolved at the call site — see HRModule.tsx
}): Promise<Result<{ id: string }>> {
  try {
    const { data, error } = await supabase
      .from('payslip_payments')
      .insert({
        school_id:   params.schoolId,
        payslip_id:  params.payslipId,
        amount:      params.amount,
        paid_at:     params.paid_at,
        method:      params.method,
        note:        params.note,
        recorded_by: params.recordedByStaffId,
      })
      .select('id')
      .single()

    if (error) return { ok: false, error: friendlyPayslipPaymentError(error.message) }
    return { ok: true, data: { id: data.id } }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to record payment' }
  }
}

// ─── Write: remove a payslip from a draft run ──────────────────────────────────

// Symmetric with addPayslip/addAllEligiblePayslips: adding is draft-only, so
// removing is too — changing who's in an approved/paid run is a bigger,
// deliberate decision, not a quiet undo. Also blocked if any payment has
// already been recorded against this payslip (recordPayslipPayment doesn't
// check run status, so a draft-run payslip can still have real payment_rows
// on it) — deleting it would silently destroy that payment history, which
// this function refuses to do rather than guess it's fine.
export async function removePayslipFromRun(params: {
  payslipId: string
  payrollRunId: string
}): Promise<Result<void>> {
  try {
    const { data: run, error: runError } = await supabase
      .from('payroll_runs')
      .select('status')
      .eq('id', params.payrollRunId)
      .maybeSingle()

    if (runError) return { ok: false, error: friendlyPayrollError(runError.message) }
    if (!run) return { ok: false, error: 'Could not find this payroll run.' }
    if (run.status !== 'draft') {
      return { ok: false, error: 'Only payslips in a draft run can be removed. Approved or paid runs are locked.' }
    }

    const { data: payments, error: paymentsError } = await supabase
      .from('payslip_payments')
      .select('id')
      .eq('payslip_id', params.payslipId)
      .limit(1)

    if (paymentsError) return { ok: false, error: friendlyPayrollError(paymentsError.message) }
    if (payments && payments.length > 0) {
      return { ok: false, error: 'This payslip already has a payment recorded against it and cannot be removed. Contact support if this was recorded in error.' }
    }

    const { error } = await supabase
      .from('payslips')
      .delete()
      .eq('id', params.payslipId)
      .eq('payroll_run_id', params.payrollRunId)

    if (error) return { ok: false, error: friendlyPayrollError(error.message) }
    return { ok: true, data: undefined }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to remove payslip' }
  }
}

// ─── Write: approve payroll run ───────────────────────────────────────────────

export async function approvePayrollRun(params: {
  runId: string
  authUserId: string
}): Promise<Result<void>> {
  try {
    let approverStaffId: string | null = null
    if (params.authUserId) {
      const { data: identity } = await supabase
        .from('app_identities')
        .select('actor_record_id, actor_type')
        .eq('auth_user_id', params.authUserId)
        .maybeSingle()
      if (identity?.actor_type === 'staff') {
        approverStaffId = identity.actor_record_id
      }
    }

    const { error } = await supabase
      .from('payroll_runs')
      .update({
        status:      'approved',
        approved_by: approverStaffId,
      })
      .eq('id', params.runId)
      .eq('status', 'draft')

    if (error) return { ok: false, error: friendlyPayrollError(error.message) }
    return { ok: true, data: undefined }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to approve payroll run' }
  }
}

// ─── Write: mark payroll run paid ─────────────────────────────────────────────

// ─── Write: mark a payroll run paid (Session 10a-5) ────────────────────────────
// Owner's explicit decision, 2026-07-02: remove the old bulk "stamp everyone
// paid_at" behavior entirely — payment_status (derived from payslip_payments,
// Session 10a-2) is now the single source of truth for whether someone's
// actually been paid. This function no longer pays anyone; it only flips the
// run's own status, and only once every payslip in the run already independently
// shows payment_status = 'paid' via recordPayslipPayment(). A run with zero
// payslips, or any payslip still unpaid/partially paid, cannot be marked paid.
export async function markPayrollRunPaid(runId: string): Promise<Result<void>> {
  try {
    const { data: slips, error: slipsError } = await supabase
      .from('payslips')
      .select('id, net_amount, payslip_payments ( amount )')
      .eq('payroll_run_id', runId)

    if (slipsError) return { ok: false, error: friendlyPayrollError(slipsError.message) }
    if (!slips || slips.length === 0) {
      return { ok: false, error: 'This run has no payslips yet — add and pay staff before marking it paid.' }
    }

    const unpaid = slips.filter((s: any) => {
      const paid = ((s.payslip_payments as { amount: number }[] | null) ?? [])
        .reduce((sum, p) => sum + Number(p.amount), 0)
      return paid < Number(s.net_amount)
    })
    if (unpaid.length > 0) {
      return { ok: false, error: `${unpaid.length} payslip${unpaid.length !== 1 ? 's are' : ' is'} not fully paid yet. Record payments for everyone in this run first.` }
    }

    const { error: runError } = await supabase
      .from('payroll_runs')
      .update({ status: 'paid' })
      .eq('id', runId)
      .eq('status', 'approved')

    if (runError) return { ok: false, error: friendlyPayrollError(runError.message) }
    return { ok: true, data: undefined }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to mark payroll run paid' }
  }
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

export function formatNaira(amount: number): string {
  return '₦' + amount.toLocaleString('en-NG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

export function todayDateString(): string {
  const d = new Date()
  const yyyy = d.getFullYear()
  const mm   = String(d.getMonth() + 1).padStart(2, '0')
  const dd   = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

/**
 * Inclusive day count between two YYYY-MM-DD strings.
 * e.g. 2026-06-01 to 2026-06-03 = 3
 */
export function dateRangeDays(start: string, end: string): number {
  const ms = new Date(end).getTime() - new Date(start).getTime()
  return Math.round(ms / 86_400_000) + 1
}

export function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-NG', {
      day: 'numeric', month: 'short', year: 'numeric',
    })
  } catch {
    return iso
  }
}

export function statusLabel(status: string): string {
  switch (status) {
    case 'pending':   return 'Pending'
    case 'approved':  return 'Approved'
    case 'rejected':  return 'Rejected'
    case 'cancelled': return 'Cancelled'
    case 'draft':     return 'Draft'
    case 'paid':      return 'Paid'
    default:          return status
  }
}

// ─── Internal error helpers ───────────────────────────────────────────────────

function friendlyStaffError(message: string): string {
  if (message.includes('violates row-level security')) {
    return "You don't have permission to edit staff records."
  }
  return `Failed to update staff: ${message}`
}

function friendlyLeaveTypeError(message: string): string {
  if (message.includes('unique') || message.includes('duplicate')) {
    return 'A leave type with this name already exists.'
  }
  if (message.includes('violates row-level security')) {
    return "You don't have permission to manage leave types."
  }
  return `Failed to save leave type: ${message}`
}

function friendlyLeaveError(message: string): string {
  if (message.includes('violates row-level security')) {
    return "You don't have permission to submit this leave request."
  }
  return `Failed to submit leave request: ${message}`
}

function friendlySalaryError(message: string): string {
  if (message.includes('violates row-level security')) {
    return "You don't have permission to manage salary structures."
  }
  return `Failed to save salary structure: ${message}`
}

function friendlyTeachingAssignmentError(message: string): string {
  if (message.includes('violates row-level security')) {
    return "You don't have permission to manage teaching assignments."
  }
  // timetable_entries.teaching_assignment_id has no ON DELETE clause (defaults
  // to RESTRICT) — removing an assignment still placed on the timetable grid
  // fails at the DB level rather than silently orphaning the lesson slot.
  if (message.includes('violates foreign key constraint') && message.includes('timetable_entries')) {
    return 'This subject/class assignment is still placed on the timetable and can\u2019t be removed until it\u2019s cleared from the timetable grid first.'
  }
  if (message.includes('duplicate') || message.includes('unique')) {
    return 'This subject/class pairing is already assigned to this staff member.'
  }
  return `Failed to update teaching assignments: ${message}`
}

function friendlyPayrollError(message: string): string {
  if (message.includes('violates row-level security')) {
    return "You don't have permission to manage payroll."
  }
  return `Failed to process payroll: ${message}`
}

function friendlyPayslipPaymentError(message: string): string {
  if (message.includes('violates row-level security')) {
    return "You don't have permission to record payments."
  }
  if (message.includes('check constraint') && message.includes('amount')) {
    return 'Payment amount must be greater than zero.'
  }
  return `Failed to record payment: ${message}`
}
// ─── Session 17 — teacher/staff self-service payslip visibility ───────────────
// Owner-confirmed design (see migration_session_17_payslip_visibility.sql):
//   - schools.teacher_payslip_visibility_enabled — one school-wide switch,
//     admin-controlled, not a permission key. When false, this overrides
//     every staff member's own preference — nobody sees the card.
//   - staff.payslip_card_hidden — personal, self-service. Hiding is
//     frictionless; showing it again after hiding requires the UI to
//     re-authenticate the caller with their own password first (handled in
//     AccountPreferencesScreen.tsx, not here — this function only persists
//     the resulting boolean once that's already happened).

// ─── Load the signed-in staff member's own payslips (all runs) ────────────────
// Mirrors loadPayslipsForRun()'s exact amount_paid/payment_status computation,
// scoped by staff_id instead of payroll_run_id. RLS already permits this —
// payslips has [SELF] read for staff on their own rows (§7.19), and
// payslip_payments has a staff self-read policy against their own payslips
// (Session 10a-2) — so this needs no new RLS, only a new scoped query.

export async function loadMyPayslips(staffId: string): Promise<Result<Payslip[]>> {
  try {
    const { data, error } = await supabase
      .from('payslips')
      .select(`
        id,
        payroll_run_id,
        staff_id,
        gross_amount,
        total_deductions,
        net_amount,
        breakdown,
        staff ( full_name ),
        payslip_payments ( amount, paid_at ),
        payroll_runs ( period_label, period_start, period_end, status )
      `)
      .eq('staff_id', staffId)
      .order('created_at', { ascending: false })

    if (error) return { ok: false, error: friendlyPayrollError(error.message) }

    return {
      ok: true,
      data: (data ?? []).map((r: any) => {
        const netAmount   = Number(r.net_amount)
        const paymentRows = (r.payslip_payments as { amount: number; paid_at: string }[] | null) ?? []
        const amountPaid  = paymentRows.reduce((sum, p) => sum + Number(p.amount), 0)
        const paymentStatus: PayslipPaymentStatus =
          amountPaid <= 0            ? 'unpaid'
          : amountPaid >= netAmount  ? 'paid'
          :                            'partially_paid'
        const lastPaidAt = paymentRows.length === 0
          ? null
          : paymentRows.reduce((latest, p) => (!latest || p.paid_at > latest ? p.paid_at : latest), null as string | null)

        return {
          id:               r.id,
          payroll_run_id:   r.payroll_run_id,
          staff_id:         r.staff_id,
          staff_name:       r.staff?.full_name ?? '—',
          gross_amount:     Number(r.gross_amount),
          total_deductions: Number(r.total_deductions),
          net_amount:       netAmount,
          breakdown:        r.breakdown ?? null,
          paid_at:          lastPaidAt,
          amount_paid:      amountPaid,
          payment_status:   paymentStatus,
        }
      }),
    }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load your payslips' }
  }
}

// ─── Load payroll-visibility settings (school switch + own preference) ────────
// One round trip for both flags — TeacherDashboard always needs them together
// (school switch off = don't even check the personal one). schoolId is
// required explicitly, same defence-in-depth pattern every other service in
// this app already follows (RLS scopes it too, but an explicit .eq() is
// cheap insurance against a future query regression).

export async function loadPayrollVisibilitySettings(
  schoolId: string,
  staffId: string,
): Promise<Result<PayrollVisibilitySettings>> {
  try {
    const [schoolRes, staffRes] = await Promise.all([
      supabase
        .from('schools')
        .select('teacher_payslip_visibility_enabled')
        .eq('id', schoolId)
        .single(),
      supabase
        .from('staff')
        .select('payslip_card_hidden')
        .eq('id', staffId)
        .single(),
    ])

    if (schoolRes.error) return { ok: false, error: schoolRes.error.message }
    if (staffRes.error) return { ok: false, error: staffRes.error.message }

    return {
      ok: true,
      data: {
        schoolEnabled: schoolRes.data?.teacher_payslip_visibility_enabled ?? true,
        selfHidden:    staffRes.data?.payslip_card_hidden ?? false,
      },
    }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load payslip visibility settings' }
  }
}

// ─── Admin write: school-wide switch ───────────────────────────────────────────
// Relies on schools' existing "school admins manage own school" UPDATE policy
// (§7.1) — no new RLS needed. Not gated on a permission key by design (owner's
// explicit choice: school-wide, not per-staff) — call sites should gate the
// UI on isAdmin, matching the coarse role-shaped gates already used for
// home→AdminDashboard and the Administration section, not a can() key.

export async function setSchoolPayslipVisibility(
  schoolId: string,
  enabled: boolean,
): Promise<Result<void>> {
  try {
    const { error } = await supabase
      .from('schools')
      .update({ teacher_payslip_visibility_enabled: enabled })
      .eq('id', schoolId)

    if (error) return { ok: false, error: friendlyPayrollError(error.message) }
    return { ok: true, data: undefined }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to update payslip visibility setting' }
  }
}

// ─── Self-service write: personal hide/show preference ────────────────────────
// Deliberately takes no re-auth step itself. Hiding (hidden: true) is meant
// to be called directly from the dashboard card's own "Hide" action, no
// friction. Showing again (hidden: false) must only ever be called by
// AccountPreferencesScreen.tsx AFTER it has independently confirmed the
// caller's password via a fresh supabase.auth.signInWithPassword() call —
// this function trusts its caller on that ordering rather than re-verifying
// auth itself, same separation of concerns HRModule.tsx already uses for
// regenerateStaffPassword() (auth handled by the Edge Function, not this
// service layer re-deriving it).

export async function setMyPayslipCardHidden(
  staffId: string,
  hidden: boolean,
): Promise<Result<void>> {
  try {
    const { error } = await supabase
      .from('staff')
      .update({ payslip_card_hidden: hidden })
      .eq('id', staffId)

    if (error) return { ok: false, error: friendlyPayrollError(error.message) }
    return { ok: true, data: undefined }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to update your payslip preference' }
  }
}
