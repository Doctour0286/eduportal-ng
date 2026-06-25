/**
 * onboardingService.ts
 * All wizard data mutations and queries.
 * Business logic only — no UI, no browser-only APIs.
 */

import { supabase } from '../lib/supabase'

// ─── Types ────────────────────────────────────────────────────────────────

export interface OnboardingProgress {
  current_step: number
  steps_completed: number[]
}

export interface SchoolIdentityInput {
  name: string
  logo_url?: string
  theme_color?: string
  welcome_message?: string
  contact_info?: {
    phone?: string
    email?: string
    address?: string
  }
}

export interface LanguageInput {
  default_lang: 'en' | 'ar' | 'ha'
  enabled_langs: ('en' | 'ar' | 'ha')[]
}

export interface CalendarInput {
  uses_terms: boolean
  session_name: string
  session_start: string
  session_end: string
}

export interface WeekDayInput {
  day_of_week: number // 0=Sun … 6=Sat
  sort_order: number
}

export interface PeriodInput {
  label: string
  start_time: string
  end_time: string
  is_break: boolean
  sort_order: number
}

export interface SubjectInput {
  name: string
  code?: string
}

export interface ClassNodeInput {
  name: string
  parent_id: string | null
  node_type?: string
  sort_order: number
  is_leaf_enrollable: boolean
}

export interface RoleInput {
  name: string
  is_admin_role: boolean
  permission_keys: string[]
}

export interface StaffInput {
  full_name: string
  email: string
  phone?: string
  hire_date?: string
  role_ids: string[]
}

// ─── Progress tracking ────────────────────────────────────────────────────

export async function getOnboardingProgress(
  schoolId: string,
): Promise<OnboardingProgress> {
  const { data } = await supabase
    .from('onboarding_progress')
    .select('current_step, steps_completed')
    .eq('school_id', schoolId)
    .maybeSingle()
  return data ?? { current_step: 1, steps_completed: [] }
}

export async function saveOnboardingProgress(
  schoolId: string,
  step: number,
  completedSteps: number[],
): Promise<void> {
  await supabase.from('onboarding_progress').upsert({
    school_id: schoolId,
    current_step: step,
    steps_completed: completedSteps,
    updated_at: new Date().toISOString(),
  })
}

// ─── Step 1: School identity ──────────────────────────────────────────────

export async function saveSchoolIdentity(
  schoolId: string,
  input: SchoolIdentityInput,
): Promise<{ ok: boolean; error?: string }> {
  const { error: schoolErr } = await supabase
    .from('schools')
    .update({
      logo_url: input.logo_url,
      theme_color: input.theme_color,
      updated_at: new Date().toISOString(),
    })
    .eq('id', schoolId)
  if (schoolErr) return { ok: false, error: schoolErr.message }

  const { error: configErr } = await supabase
    .from('school_public_config')
    .upsert({
      school_id: schoolId,
      welcome_message: input.welcome_message ?? '',
      contact_info: input.contact_info ?? {},
      updated_at: new Date().toISOString(),
    })
  if (configErr) return { ok: false, error: configErr.message }
  return { ok: true }
}

// ─── Step 2: Language ─────────────────────────────────────────────────────

export async function saveLanguage(
  schoolId: string,
  input: LanguageInput,
): Promise<{ ok: boolean; error?: string }> {
  const { error } = await supabase
    .from('schools')
    .update({
      default_lang: input.default_lang,
      enabled_langs: input.enabled_langs,
      updated_at: new Date().toISOString(),
    })
    .eq('id', schoolId)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

// ─── Step 3: Calendar ─────────────────────────────────────────────────────

export async function saveCalendar(
  schoolId: string,
  input: CalendarInput,
): Promise<{ ok: boolean; error?: string }> {
  // Update uses_terms flag
  const { error: schoolErr } = await supabase
    .from('schools')
    .update({ uses_terms: input.uses_terms, updated_at: new Date().toISOString() })
    .eq('id', schoolId)
  if (schoolErr) return { ok: false, error: schoolErr.message }

  // `sessions` has a partial unique index enforcing one current session per
  // school (on is_current), not a unique constraint on (school_id, name) —
  // so we cannot rely on upsert's onConflict here. Instead: look up any
  // existing session with this name, update it if found, otherwise insert.
  // Any other session previously marked current is demoted first so the
  // partial unique index is never violated (this also covers an admin
  // revisiting this step from the setup guide after onboarding).
  const { error: demoteErr } = await supabase
    .from('sessions')
    .update({ is_current: false })
    .eq('school_id', schoolId)
    .eq('is_current', true)
  if (demoteErr) return { ok: false, error: demoteErr.message }

  const { data: existing } = await supabase
    .from('sessions')
    .select('id')
    .eq('school_id', schoolId)
    .eq('name', input.session_name)
    .maybeSingle()

  const sessionErr = existing
    ? (
        await supabase
          .from('sessions')
          .update({
            start_date: input.session_start,
            end_date: input.session_end,
            is_current: true,
          })
          .eq('id', existing.id)
      ).error
    : (
        await supabase.from('sessions').insert({
          school_id: schoolId,
          name: input.session_name,
          start_date: input.session_start,
          end_date: input.session_end,
          is_current: true,
        })
      ).error

  if (sessionErr) return { ok: false, error: sessionErr.message }
  return { ok: true }
}

// ─── Step 4: Week days & periods ──────────────────────────────────────────

export async function saveWeekAndPeriods(
  schoolId: string,
  days: WeekDayInput[],
  periods: PeriodInput[],
): Promise<{ ok: boolean; error?: string }> {
  // Replace existing week days
  await supabase.from('school_week_days').delete().eq('school_id', schoolId)
  const { error: daysErr } = await supabase.from('school_week_days').insert(
    days.map((d) => ({ ...d, school_id: schoolId })),
  )
  if (daysErr) return { ok: false, error: daysErr.message }

  // Replace existing periods
  await supabase.from('periods').delete().eq('school_id', schoolId)
  const { error: periodsErr } = await supabase.from('periods').insert(
    periods.map((p) => ({
      ...p,
      school_id: schoolId,
      created_at: new Date().toISOString(),
    })),
  )
  if (periodsErr) return { ok: false, error: periodsErr.message }
  return { ok: true }
}

// ─── Step 5: Subjects ─────────────────────────────────────────────────────

export async function saveSubjects(
  schoolId: string,
  subjects: SubjectInput[],
): Promise<{ ok: boolean; error?: string; ids?: string[] }> {
  const rows = subjects.map((s) => ({
    school_id: schoolId,
    name: s.name,
    code: s.code ?? null,
  }))
  const { data, error } = await supabase
    .from('subjects')
    .upsert(rows, { onConflict: 'school_id,name' })
    .select('id')
  if (error) return { ok: false, error: error.message }
  return { ok: true, ids: data?.map((r: { id: string }) => r.id) }
}

// ─── Step 6: Class hierarchy ──────────────────────────────────────────────

export async function saveClassNode(
  schoolId: string,
  node: ClassNodeInput,
): Promise<{ ok: boolean; error?: string; id?: string }> {
  const { data, error } = await supabase
    .from('class_nodes')
    .insert({
      school_id: schoolId,
      parent_id: node.parent_id,
      name: node.name,
      node_type: node.node_type ?? null,
      sort_order: node.sort_order,
      is_leaf_enrollable: node.is_leaf_enrollable,
    })
    .select('id')
    .single()
  if (error) return { ok: false, error: error.message }
  return { ok: true, id: data.id }
}

export async function deleteClassNode(nodeId: string): Promise<void> {
  // No hard deletes — in this case nodes with no students are safe to remove
  // during wizard setup before any enrollments exist
  await supabase.from('class_nodes').delete().eq('id', nodeId)
}

export async function getClassNodes(
  schoolId: string,
): Promise<{ id: string; name: string; parent_id: string | null; is_leaf_enrollable: boolean; sort_order: number }[]> {
  const { data } = await supabase
    .from('class_nodes')
    .select('id, name, parent_id, is_leaf_enrollable, sort_order')
    .eq('school_id', schoolId)
    .order('sort_order')
  return data ?? []
}

// ─── Step 7: Roles & permissions ──────────────────────────────────────────

export async function getPermissionsCatalog(): Promise<
  { key: string; description: string; module: string }[]
> {
  const { data } = await supabase
    .from('permissions')
    .select('key, description, module')
    .order('module')
    .order('key')
  return data ?? []
}

export async function saveRole(
  schoolId: string,
  role: RoleInput,
): Promise<{ ok: boolean; error?: string; id?: string }> {
  const { data, error } = await supabase
    .from('roles')
    .upsert(
      { school_id: schoolId, name: role.name, is_admin_role: role.is_admin_role },
      { onConflict: 'school_id,name' },
    )
    .select('id')
    .single()
  if (error) return { ok: false, error: error.message }

  const roleId = data.id
  // Replace permissions for this role
  await supabase.from('role_permissions').delete().eq('role_id', roleId)
  if (role.permission_keys.length > 0) {
    const { error: permErr } = await supabase.from('role_permissions').insert(
      role.permission_keys.map((key) => ({ role_id: roleId, permission_key: key })),
    )
    if (permErr) return { ok: false, error: permErr.message }
  }
  return { ok: true, id: roleId }
}

export async function getRoles(
  schoolId: string,
): Promise<{ id: string; name: string; is_admin_role: boolean }[]> {
  const { data } = await supabase
    .from('roles')
    .select('id, name, is_admin_role')
    .eq('school_id', schoolId)
    .order('name')
  return data ?? []
}

// ─── Step 8: Staff ────────────────────────────────────────────────────────
// Creating a staff account calls the Edge Function which mints a real
// auth.users row server-side. Returns a generated temporary password.

export async function createStaffMember(
  schoolId: string,
  staff: StaffInput,
): Promise<{ ok: boolean; error?: string; tempPassword?: string }> {
  const { data, error } = await supabase.functions.invoke('create-staff-account', {
    body: {
      school_id: schoolId,
      full_name: staff.full_name,
      email: staff.email,
      phone: staff.phone,
      hire_date: staff.hire_date,
      role_ids: staff.role_ids,
    },
  })
  if (error || !data?.ok) {
    return { ok: false, error: data?.error ?? 'Could not create staff account' }
  }
  return { ok: true, tempPassword: data.temp_password }
}

// ─── Mark onboarding complete ─────────────────────────────────────────────

export async function completeOnboarding(
  schoolId: string,
): Promise<{ ok: boolean; error?: string }> {
  const { error } = await supabase
    .from('schools')
    .update({ onboarding_complete: true, updated_at: new Date().toISOString() })
    .eq('id', schoolId)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}
