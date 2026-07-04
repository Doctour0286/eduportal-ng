/**
 * settingsService.ts
 * Data-access layer for the Admin Settings Panel (Phase 6 — last module).
 *
 * Scope: post-setup editing of everything the onboarding wizard configured,
 * plus module-level settings and the audit log viewer.
 *
 * Tables touched (all already live with RLS from Phase 1–4):
 *   schools, school_public_config, school_week_days, periods,
 *   subjects, class_nodes, roles, permissions, role_permissions,
 *   staff, staff_roles, sessions, terms, audit_log,
 *   student_roles, student_role_assignments (Session 13, §7.8a)
 *
 * Student-role exports (Session 13, PRD Problem 5.5):
 *   loadStudentRoles()   — the school's defined student roles
 *   saveStudentRole()    — create/update a role definition
 *   deleteStudentRole()  — remove a role definition (hard delete — see §7.8a)
 *
 * Pattern rules (consistent with every other service in this project):
 *   - No hard deletes — status changes only (roles: is_admin_role toggle;
 *     subjects/class_nodes/periods: soft-delete via status when needed)
 *   - Money: numeric(14,2) — not touched here (no money tables)
 *   - FK resolution via app_identities when writing actor ids
 *   - Joined relations cast through unknown → array before plucking [0]
 *   - schoolId threaded on every call — never inferred client-side
 */

import { supabase } from '../lib/supabase'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SchoolSettings {
  id: string
  name: string
  slug: string
  school_type: string | null
  logo_url: string | null
  theme_color: string | null
  default_lang: 'en' | 'ar' | 'ha'
  enabled_langs: string[]
  uses_terms: boolean
  uses_ledger: boolean
  status: string
}

export interface SchoolPublicConfig {
  welcome_message: string | null
  contact_info: {
    phone?: string
    email?: string
    address?: string
    social_links?: Record<string, string>
  } | null
  show_announcements: boolean
}

export interface Period {
  id: string
  label: string
  start_time: string
  end_time: string
  is_break: boolean
  sort_order: number
}

export interface WeekDay {
  day_of_week: number   // 0=Sunday … 6=Saturday
  sort_order: number
}

export interface Subject {
  id: string
  name: string
  code: string | null
}

export interface ClassNode {
  id: string
  parent_id: string | null
  name: string
  node_type: string | null
  sort_order: number
  is_leaf_enrollable: boolean
  children?: ClassNode[]
}

export interface Role {
  id: string
  name: string
  is_admin_role: boolean
  permissions: string[]
}

// Session 13 (PRD Problem 5.5) — descriptive-only, no permissions equivalent.
// class_id null = school-wide; set = scoped to that one class. Admin chooses
// this per-role at creation time (§7.8a), not a fixed global setting.
export interface StudentRole {
  id: string
  name: string
  class_id: string | null
}

export interface Permission {
  key: string
  description: string
  module: string
}

export interface Session {
  id: string
  name: string
  start_date: string
  end_date: string
  is_current: boolean
}

export interface Term {
  id: string
  session_id: string
  name: string
  sequence: number
  start_date: string
  end_date: string
}

// Session 18 (PRD Problem 5.2/6.7) — a specific-date exception to the
// recurring school_week_days pattern. day_type 'school_day' is rarely
// inserted explicitly (it's the implicit default absent any row) but is
// supported for the rare case of overriding an otherwise-non-school weekday
// (e.g. a mandatory Saturday makeup class).
export type CalendarDayType = 'school_day' | 'holiday' | 'exam_day' | 'break'

export interface CalendarDay {
  id: string
  calendar_date: string
  day_type: CalendarDayType
  label: string | null
  extends_term: boolean
}

export interface AuditEntry {
  id: string
  created_at: string
  actor_id: string | null
  actor_type: string | null
  table_name: string
  record_id: string
  action: 'INSERT' | 'UPDATE' | 'DELETE'
  old_data: Record<string, unknown> | null
  new_data: Record<string, unknown> | null
}

export interface StaffListItem {
  id: string
  full_name: string
  email: string | null
  phone: string | null
  status: string
  hire_date: string | null
  roles: string[]
}

// ─── School branding & config ─────────────────────────────────────────────────

export async function loadSchoolSettings(schoolId: string): Promise<{ data: SchoolSettings | null; error: string | null }> {
  const { data, error } = await supabase
    .from('schools')
    .select('id, name, slug, school_type, logo_url, theme_color, default_lang, enabled_langs, uses_terms, uses_ledger, status')
    .eq('id', schoolId)
    .single()

  if (error) return { data: null, error: error.message }
  return { data: data as SchoolSettings, error: null }
}

export async function updateSchoolSettings(
  schoolId: string,
  updates: Partial<Pick<SchoolSettings, 'name' | 'school_type' | 'logo_url' | 'theme_color' | 'default_lang' | 'enabled_langs' | 'uses_terms' | 'uses_ledger'>>
): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from('schools')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', schoolId)

  return { error: error?.message ?? null }
}

export async function loadPublicConfig(schoolId: string): Promise<{ data: SchoolPublicConfig | null; error: string | null }> {
  const { data, error } = await supabase
    .from('school_public_config')
    .select('welcome_message, contact_info, show_announcements')
    .eq('school_id', schoolId)
    .maybeSingle()

  if (error) return { data: null, error: error.message }
  return {
    data: data
      ? (data as SchoolPublicConfig)
      : { welcome_message: null, contact_info: null, show_announcements: true },
    error: null,
  }
}

export async function savePublicConfig(
  schoolId: string,
  cfg: SchoolPublicConfig
): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from('school_public_config')
    .upsert({ school_id: schoolId, ...cfg, updated_at: new Date().toISOString() }, { onConflict: 'school_id' })

  return { error: error?.message ?? null }
}

// ─── Calendar — sessions & terms ──────────────────────────────────────────────

export async function loadSessions(schoolId: string): Promise<{ data: Session[]; error: string | null }> {
  const { data, error } = await supabase
    .from('sessions')
    .select('id, name, start_date, end_date, is_current')
    .eq('school_id', schoolId)
    .order('start_date', { ascending: false })

  if (error) return { data: [], error: error.message }
  return { data: (data ?? []) as Session[], error: null }
}

export async function upsertSession(
  schoolId: string,
  session: { id?: string; name: string; start_date: string; end_date: string; is_current: boolean }
): Promise<{ error: string | null }> {
  // Demote any existing current session first if we're setting a new one
  if (session.is_current) {
    await supabase
      .from('sessions')
      .update({ is_current: false })
      .eq('school_id', schoolId)
      .eq('is_current', true)
  }

  if (session.id) {
    const { error } = await supabase
      .from('sessions')
      .update({ name: session.name, start_date: session.start_date, end_date: session.end_date, is_current: session.is_current })
      .eq('id', session.id)
      .eq('school_id', schoolId)
    return { error: error?.message ?? null }
  } else {
    const { error } = await supabase
      .from('sessions')
      .insert({ school_id: schoolId, name: session.name, start_date: session.start_date, end_date: session.end_date, is_current: session.is_current })
    return { error: error?.message ?? null }
  }
}

export async function loadTerms(schoolId: string, sessionId: string): Promise<{ data: Term[]; error: string | null }> {
  const { data, error } = await supabase
    .from('terms')
    .select('id, session_id, name, sequence, start_date, end_date')
    .eq('school_id', schoolId)
    .eq('session_id', sessionId)
    .order('sequence', { ascending: true })

  if (error) return { data: [], error: error.message }
  return { data: (data ?? []) as Term[], error: null }
}

export async function upsertTerm(
  schoolId: string,
  term: { id?: string; session_id: string; name: string; sequence: number; start_date: string; end_date: string }
): Promise<{ error: string | null }> {
  if (term.id) {
    const { error } = await supabase
      .from('terms')
      .update({ name: term.name, sequence: term.sequence, start_date: term.start_date, end_date: term.end_date })
      .eq('id', term.id)
      .eq('school_id', schoolId)
    return { error: error?.message ?? null }
  } else {
    const { error } = await supabase
      .from('terms')
      .insert({ school_id: schoolId, ...term })
    return { error: error?.message ?? null }
  }
}

// ─── School calendar (holidays / exam days / breaks) ─────────────────────────
// Session 18, PRD Problem 5.2 (Goals 2–4) + Problem 6.7's term-extension
// refinement (owner-requested per-entry choice, not a global rule — see
// migration_calendar_extend_term.sql). Distinct from the Calendar tab's
// sessions/terms (the *recurring* structure) — these are *specific-date
// exceptions* to that structure. school_id + session_id scoped per §3.6, so
// it works whether or not uses_terms is true.

export async function loadCalendarDays(
  schoolId: string,
  sessionId: string,
): Promise<{ data: CalendarDay[]; error: string | null }> {
  const { data, error } = await supabase
    .from('school_calendar_days')
    .select('id, calendar_date, day_type, label, extends_term')
    .eq('school_id', schoolId)
    .eq('session_id', sessionId)
    .order('calendar_date', { ascending: true })

  if (error) return { data: [], error: error.message }
  return { data: (data ?? []) as CalendarDay[], error: null }
}

export async function upsertCalendarDay(
  schoolId: string,
  sessionId: string,
  entry: { id?: string; calendar_date: string; day_type: CalendarDayType; label: string | null; extends_term: boolean }
): Promise<{ error: string | null }> {
  if (entry.id) {
    const { error } = await supabase
      .from('school_calendar_days')
      .update({
        day_type: entry.day_type,
        label: entry.label,
        extends_term: entry.extends_term,
        updated_at: new Date().toISOString(),
      })
      .eq('id', entry.id)
      .eq('school_id', schoolId)
    return { error: error?.message ?? null }
  }

  const { error } = await supabase
    .from('school_calendar_days')
    .upsert(
      {
        school_id: schoolId,
        session_id: sessionId,
        calendar_date: entry.calendar_date,
        day_type: entry.day_type,
        label: entry.label,
        extends_term: entry.extends_term,
      },
      { onConflict: 'school_id,calendar_date' }
    )
  return { error: error?.message ?? null }
}

/**
 * Marks every date in [startDate, endDate] inclusive with the same day_type/
 * label/extends_term — the bulk-range entry point for things like a
 * multi-week mid-term break. Upserts one date at a time (school_id,
 * calendar_date is the real unique constraint) rather than a single batched
 * insert, so a range that partially overlaps existing entries updates those
 * rows instead of erroring — reusing upsertCalendarDay per date rather than
 * duplicating the upsert shape here.
 *
 * Does NOT skip weekends or otherwise pre-filter which dates in the range
 * are "real" school days — every school runs a different week pattern
 * (school_week_days is per-school, e.g. some run Sat–Sun instead of Mon–Fri),
 * so this function has no business guessing which dates matter. It simply
 * marks the full range as requested; getEffectiveTermEndDate() and the
 * attendance calendar-awareness logic are what correctly ignore the
 * already-non-school dates within it.
 */
export async function bulkUpsertCalendarDays(
  schoolId: string,
  sessionId: string,
  range: { start_date: string; end_date: string; day_type: CalendarDayType; label: string | null; extends_term: boolean }
): Promise<{ error: string | null; count: number }> {
  const dates: string[] = []
  const cursor = new Date(range.start_date + 'T00:00:00')
  const end = new Date(range.end_date + 'T00:00:00')
  if (cursor > end) return { error: 'Start date must be on or before end date.', count: 0 }

  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10))
    cursor.setDate(cursor.getDate() + 1)
  }

  const rows = dates.map(calendar_date => ({
    school_id: schoolId,
    session_id: sessionId,
    calendar_date,
    day_type: range.day_type,
    label: range.label,
    extends_term: range.extends_term,
  }))

  const { error } = await supabase
    .from('school_calendar_days')
    .upsert(rows, { onConflict: 'school_id,calendar_date' })

  if (error) return { error: error.message, count: 0 }
  return { error: null, count: rows.length }
}

export async function deleteCalendarDay(schoolId: string, calendarDayId: string): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from('school_calendar_days')
    .delete()
    .eq('id', calendarDayId)
    .eq('school_id', schoolId)
  return { error: error?.message ?? null }
}

// ─── Week & periods ───────────────────────────────────────────────────────────

export async function loadWeekDays(schoolId: string): Promise<{ data: WeekDay[]; error: string | null }> {
  const { data, error } = await supabase
    .from('school_week_days')
    .select('day_of_week, sort_order')
    .eq('school_id', schoolId)
    .order('sort_order', { ascending: true })

  if (error) return { data: [], error: error.message }
  return { data: (data ?? []) as WeekDay[], error: null }
}

export async function saveWeekDays(schoolId: string, days: number[]): Promise<{ error: string | null }> {
  // Delete then re-insert to handle day removal cleanly
  const { error: delErr } = await supabase
    .from('school_week_days')
    .delete()
    .eq('school_id', schoolId)

  if (delErr) return { error: delErr.message }

  if (days.length === 0) return { error: null }

  const rows = days.map((day, idx) => ({ school_id: schoolId, day_of_week: day, sort_order: idx }))
  const { error } = await supabase.from('school_week_days').insert(rows)
  return { error: error?.message ?? null }
}

export async function loadPeriods(schoolId: string): Promise<{ data: Period[]; error: string | null }> {
  const { data, error } = await supabase
    .from('periods')
    .select('id, label, start_time, end_time, is_break, sort_order')
    .eq('school_id', schoolId)
    .order('sort_order', { ascending: true })

  if (error) return { data: [], error: error.message }
  return { data: (data ?? []) as Period[], error: null }
}

export async function upsertPeriod(
  schoolId: string,
  period: { id?: string; label: string; start_time: string; end_time: string; is_break: boolean; sort_order: number }
): Promise<{ error: string | null }> {
  if (period.id) {
    const { error } = await supabase
      .from('periods')
      .update({ label: period.label, start_time: period.start_time, end_time: period.end_time, is_break: period.is_break, sort_order: period.sort_order })
      .eq('id', period.id)
      .eq('school_id', schoolId)
    return { error: error?.message ?? null }
  } else {
    const { error } = await supabase
      .from('periods')
      .insert({ school_id: schoolId, ...period })
    return { error: error?.message ?? null }
  }
}

export async function deletePeriod(schoolId: string, periodId: string): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from('periods')
    .delete()
    .eq('id', periodId)
    .eq('school_id', schoolId)
  return { error: error?.message ?? null }
}

// ─── Subjects ─────────────────────────────────────────────────────────────────

export async function loadSubjects(schoolId: string): Promise<{ data: Subject[]; error: string | null }> {
  const { data, error } = await supabase
    .from('subjects')
    .select('id, name, code')
    .eq('school_id', schoolId)
    .order('name', { ascending: true })

  if (error) return { data: [], error: error.message }
  return { data: (data ?? []) as Subject[], error: null }
}

export async function upsertSubject(
  schoolId: string,
  subject: { id?: string; name: string; code?: string | null }
): Promise<{ error: string | null }> {
  if (subject.id) {
    const { error } = await supabase
      .from('subjects')
      .update({ name: subject.name, code: subject.code ?? null })
      .eq('id', subject.id)
      .eq('school_id', schoolId)
    return { error: error?.message ?? null }
  } else {
    const { error } = await supabase
      .from('subjects')
      .insert({ school_id: schoolId, name: subject.name, code: subject.code ?? null })
    return { error: error?.message ?? null }
  }
}

// No hard delete — leave for future soft-delete UI if needed.
// Subjects with scores/class_subjects FKs can't be deleted without a cascade anyway.

// ─── Class hierarchy ──────────────────────────────────────────────────────────

export async function loadClassNodes(schoolId: string): Promise<{ data: ClassNode[]; error: string | null }> {
  const { data, error } = await supabase
    .from('class_nodes')
    .select('id, parent_id, name, node_type, sort_order, is_leaf_enrollable')
    .eq('school_id', schoolId)
    .order('sort_order', { ascending: true })

  if (error) return { data: [], error: error.message }
  return { data: (data ?? []) as ClassNode[], error: null }
}

/** Build a flat list into a tree (client-side — avoids recursive SQL). */
export function buildClassTree(flat: ClassNode[]): ClassNode[] {
  const map = new Map<string, ClassNode>()
  flat.forEach(n => map.set(n.id, { ...n, children: [] }))

  const roots: ClassNode[] = []
  map.forEach(node => {
    if (node.parent_id && map.has(node.parent_id)) {
      map.get(node.parent_id)!.children!.push(node)
    } else {
      roots.push(node)
    }
  })
  return roots
}

export async function upsertClassNode(
  schoolId: string,
  node: { id?: string; parent_id: string | null; name: string; node_type?: string | null; sort_order: number; is_leaf_enrollable: boolean }
): Promise<{ error: string | null }> {
  if (node.id) {
    const { error } = await supabase
      .from('class_nodes')
      .update({ parent_id: node.parent_id, name: node.name, node_type: node.node_type ?? null, sort_order: node.sort_order, is_leaf_enrollable: node.is_leaf_enrollable, updated_at: new Date().toISOString() })
      .eq('id', node.id)
      .eq('school_id', schoolId)
    return { error: error?.message ?? null }
  } else {
    const { error } = await supabase
      .from('class_nodes')
      .insert({ school_id: schoolId, parent_id: node.parent_id, name: node.name, node_type: node.node_type ?? null, sort_order: node.sort_order, is_leaf_enrollable: node.is_leaf_enrollable })
    return { error: error?.message ?? null }
  }
}

// ─── Roles & permissions ──────────────────────────────────────────────────────

export async function loadPermissionsCatalog(): Promise<{ data: Permission[]; error: string | null }> {
  const { data, error } = await supabase
    .from('permissions')
    .select('key, description, module')
    .order('module', { ascending: true })

  if (error) return { data: [], error: error.message }
  return { data: (data ?? []) as Permission[], error: null }
}

export async function loadRoles(schoolId: string): Promise<{ data: Role[]; error: string | null }> {
  const { data, error } = await supabase
    .from('roles')
    .select('id, name, is_admin_role, role_permissions(permission_key)')
    .eq('school_id', schoolId)
    .order('name', { ascending: true })

  if (error) return { data: [], error: error.message }

  const roles: Role[] = (data ?? []).map((r) => ({
    id: r.id as string,
    name: r.name as string,
    is_admin_role: r.is_admin_role as boolean,
    permissions: ((r.role_permissions as unknown as { permission_key: string }[]) ?? []).map(rp => rp.permission_key),
  }))

  return { data: roles, error: null }
}

export async function saveRole(
  schoolId: string,
  role: { id?: string; name: string; is_admin_role: boolean; permissions: string[] }
): Promise<{ error: string | null }> {
  let roleId = role.id

  if (roleId) {
    const { error } = await supabase
      .from('roles')
      .update({ name: role.name, is_admin_role: role.is_admin_role })
      .eq('id', roleId)
      .eq('school_id', schoolId)
    if (error) return { error: error.message }
  } else {
    const { data, error } = await supabase
      .from('roles')
      .insert({ school_id: schoolId, name: role.name, is_admin_role: role.is_admin_role })
      .select('id')
      .single()
    if (error) return { error: error.message }
    roleId = (data as { id: string }).id
  }

  // Replace permissions: delete all then re-insert
  const { error: delErr } = await supabase
    .from('role_permissions')
    .delete()
    .eq('role_id', roleId)
  if (delErr) return { error: delErr.message }

  if (role.permissions.length > 0) {
    const rows = role.permissions.map(key => ({ role_id: roleId, permission_key: key }))
    const { error: insErr } = await supabase.from('role_permissions').insert(rows)
    if (insErr) return { error: insErr.message }
  }

  return { error: null }
}

export async function deleteRole(schoolId: string, roleId: string): Promise<{ error: string | null }> {
  // Remove permissions first to avoid FK block
  await supabase.from('role_permissions').delete().eq('role_id', roleId)
  await supabase.from('staff_roles').delete().eq('role_id', roleId).eq('school_id', schoolId)
  const { error } = await supabase.from('roles').delete().eq('id', roleId).eq('school_id', schoolId)
  return { error: error?.message ?? null }
}

// ─── Student roles (Session 13, PRD Problem 5.5, §7.8a) ──────────────────────
// Definitional side only — "the role exists," admin-managed here. The
// per-student "who holds it" read/assign/unassign functions live in
// studentsService.ts instead (StudentRoleTag/loadStudentRoleTags/
// loadAssignableStudentRoles/assignStudentRole/unassignStudentRole), matching
// that file's own Result<T> convention rather than this file's {data,error}
// shape — same split roles/staff_roles never needed since staff assignment
// lives entirely in HRModule/hrService.ts, but student roles are assigned
// from StudentsModule, a different file than where they're defined.

export async function loadStudentRoles(schoolId: string): Promise<{ data: StudentRole[]; error: string | null }> {
  const { data, error } = await supabase
    .from('student_roles')
    .select('id, name, class_id')
    .eq('school_id', schoolId)
    .order('name', { ascending: true })

  if (error) return { data: [], error: error.message }

  const roles: StudentRole[] = (data ?? []).map((r) => ({
    id:       r.id as string,
    name:     r.name as string,
    class_id: r.class_id as string | null,
  }))

  return { data: roles, error: null }
}

export async function saveStudentRole(
  schoolId: string,
  role: { id?: string; name: string; class_id: string | null },
): Promise<{ error: string | null }> {
  if (role.id) {
    const { error } = await supabase
      .from('student_roles')
      .update({ name: role.name, class_id: role.class_id })
      .eq('id', role.id)
      .eq('school_id', schoolId)
    return { error: error?.message ?? null }
  }

  const { error } = await supabase
    .from('student_roles')
    .insert({ school_id: schoolId, name: role.name, class_id: role.class_id })

  return { error: error?.message ?? null }
}

export async function deleteStudentRole(schoolId: string, studentRoleId: string): Promise<{ error: string | null }> {
  // Remove assignments first to avoid FK block — same order as deleteRole
  // clearing role_permissions/staff_roles before the roles row itself.
  await supabase.from('student_role_assignments').delete().eq('student_role_id', studentRoleId)
  const { error } = await supabase.from('student_roles').delete().eq('id', studentRoleId).eq('school_id', schoolId)
  return { error: error?.message ?? null }
}

// ─── Staff (read-only list — edits live in HRModule) ─────────────────────────

export async function loadStaffWithRoles(schoolId: string): Promise<{ data: StaffListItem[]; error: string | null }> {
  const { data, error } = await supabase
    .from('staff')
    .select('id, full_name, email, phone, status, hire_date, staff_roles(roles(name))')
    .eq('school_id', schoolId)
    .order('full_name', { ascending: true })

  if (error) return { data: [], error: error.message }

  const items: StaffListItem[] = (data ?? []).map((s) => {
    const staffRoles = (s.staff_roles as unknown as { roles: { name: string }[] | { name: string } | null }[]) ?? []
    const roleNames = staffRoles.flatMap(sr => {
      const r = sr.roles
      if (!r) return []
      if (Array.isArray(r)) return r.map(x => x.name)
      return [r.name]
    })
    return {
      id: s.id as string,
      full_name: s.full_name as string,
      email: s.email as string | null,
      phone: s.phone as string | null,
      status: s.status as string,
      hire_date: s.hire_date as string | null,
      roles: roleNames,
    }
  })

  return { data: items, error: null }
}

// ─── Audit log ────────────────────────────────────────────────────────────────

export interface AuditFilters {
  table_name?: string
  action?: 'INSERT' | 'UPDATE' | 'DELETE'
  limit?: number
  offset?: number
}

export async function loadAuditLog(schoolId: string, filters: AuditFilters = {}): Promise<{ data: AuditEntry[]; count: number; error: string | null }> {
  let q = supabase
    .from('audit_log')
    .select('id, created_at, actor_id, actor_type, table_name, record_id, action, old_data, new_data', { count: 'exact' })
    .eq('school_id', schoolId)
    .order('created_at', { ascending: false })
    .limit(filters.limit ?? 50)

  if (filters.offset) q = q.range(filters.offset, (filters.offset ?? 0) + (filters.limit ?? 50) - 1)
  if (filters.table_name) q = q.eq('table_name', filters.table_name)
  if (filters.action) q = q.eq('action', filters.action)

  const { data, error, count } = await q

  if (error) return { data: [], count: 0, error: error.message }
  return { data: (data ?? []) as AuditEntry[], count: count ?? 0, error: null }
}

/** Returns the distinct table names that appear in the audit log for this school. */
export async function loadAuditTableNames(schoolId: string): Promise<string[]> {
  const { data } = await supabase
    .from('audit_log')
    .select('table_name')
    .eq('school_id', schoolId)

  if (!data) return []
  const names = new Set(data.map((r: { table_name: string }) => r.table_name))
  return Array.from(names).sort()
}
