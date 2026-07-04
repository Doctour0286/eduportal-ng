/**
 * guardianService.ts
 * Data access layer for the Guardian module.
 * No browser-only APIs. No UI imports. React Native compatible.
 *
 * Read exports:
 *   loadGuardians()           — paginated/searchable guardian directory
 *   loadGuardian()            — single guardian with linked students
 *                               (Session 13: linked_students now includes
 *                               role_tags — batched query, see §7.8a)
 *   searchGuardians()         — name/phone search for the link-existing flow
 *
 * Write exports:
 *   createGuardian()          — insert guardian row (no student link)
 *   updateGuardian()          — edit guardian info fields
 *   linkGuardianToStudent()   — insert student_guardians row
 *   unlinkGuardianFromStudent() — remove student_guardians row
 *   deactivateGuardianAccess() — set app_identities.is_active = false
 *
 * Re-exports from studentsService (to avoid duplication):
 *   updateGuardianLink, loadGuardianIdentity, provisionGuardianAccess
 */

import { supabase } from '../lib/supabase'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Guardian {
  id: string
  full_name: string
  phone: string | null
  email: string | null
  relationship: string | null
  created_at: string
  student_count: number          // derived client-side
  has_any_access: boolean        // true if any linked student has has_platform_access
}

export interface GuardianDetail {
  id: string
  full_name: string
  phone: string | null
  email: string | null
  relationship: string | null
  created_at: string
  linked_students: LinkedStudent[]
  identity: GuardianIdentityInfo | null
}

export interface LinkedStudent {
  student_id: string
  full_name: string
  class_path_label: string | null
  status: string
  has_platform_access: boolean
  role_tags: { id: string; name: string }[]   // Session 13, PRD Problem 5.5 —
                                                // owner-decided "visible from
                                                // anywhere" scope: student's
                                                // own detail header (see
                                                // studentsService.ts) plus
                                                // here on the Guardians page.
}

export interface GuardianIdentityInfo {
  login_method: 'login_code' | 'phone_otp'
  login_code: string | null
  is_active: boolean
}

export interface GuardianSearchResult {
  id: string
  full_name: string
  phone: string | null
  email: string | null
  relationship: string | null
  student_count: number
}

type Ok<T>     = { ok: true; data: T }
type Err       = { ok: false; error: string }
type Result<T> = Ok<T> | Err

// ─── Load guardian directory ──────────────────────────────────────────────────

/**
 * Loads all guardians for the school with their linked student count.
 * Optionally filters by search query (name or phone).
 */
export async function loadGuardians(params: {
  search?: string
}): Promise<Result<Guardian[]>> {
  try {
    let query = supabase
      .from('guardians')
      .select(`
        id,
        full_name,
        phone,
        email,
        relationship,
        created_at,
        student_guardians (
          has_platform_access,
          student_id
        )
      `)
      .order('full_name')

    if (params.search?.trim()) {
      const q = params.search.trim()
      query = query.or(`full_name.ilike.%${q}%,phone.ilike.%${q}%`)
    }

    const { data, error } = await query
    if (error) return { ok: false, error: error.message }

    const guardians: Guardian[] = (data ?? []).map((r: any) => {
      const links = (r.student_guardians as unknown as Array<{
        has_platform_access: boolean
        student_id: string
      }>) ?? []
      return {
        id:             r.id,
        full_name:      r.full_name,
        phone:          r.phone ?? null,
        email:          r.email ?? null,
        relationship:   r.relationship ?? null,
        created_at:     r.created_at,
        student_count:  links.length,
        has_any_access: links.some(l => l.has_platform_access),
      }
    })

    return { ok: true, data: guardians }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load guardians' }
  }
}

// ─── Load single guardian detail ──────────────────────────────────────────────

/**
 * Loads one guardian with all linked students and portal identity.
 */
export async function loadGuardian(
  guardianId: string,
): Promise<Result<GuardianDetail>> {
  try {
    // Guardian + linked students in one query
    const { data, error } = await supabase
      .from('guardians')
      .select(`
        id,
        full_name,
        phone,
        email,
        relationship,
        created_at,
        student_guardians (
          has_platform_access,
          students (
            id,
            full_name,
            class_node_id,
            status
          )
        )
      `)
      .eq('id', guardianId)
      .maybeSingle()

    if (error) return { ok: false, error: error.message }
    if (!data)  return { ok: false, error: 'Guardian not found' }

    // Load class nodes separately to build path labels
    const { data: classNodes } = await supabase
      .from('class_nodes')
      .select('id, name, parent_id')

    const nameMap = new Map<string, string>(
      (classNodes ?? []).map((n: any) => [n.id, n.name])
    )
    const parentMap = new Map<string, string | null>(
      (classNodes ?? []).map((n: any) => [n.id, n.parent_id])
    )
    function pathLabel(classNodeId: string | null): string | null {
      if (!classNodeId) return null
      const parentId = parentMap.get(classNodeId)
      const name = nameMap.get(classNodeId) ?? ''
      return parentId ? `${nameMap.get(parentId) ?? ''} · ${name}` : name
    }

    // Load portal identity
    const { data: identityRow } = await supabase
      .from('app_identities')
      .select('login_method, login_code, is_active')
      .eq('actor_record_id', guardianId)
      .eq('actor_type', 'guardian')
      .maybeSingle()

    const links = (data.student_guardians as unknown as Array<{
      has_platform_access: boolean
      students: { id: string; full_name: string; class_node_id: string | null; status: string } | null
    }>) ?? []

    // Role tags (Session 13, PRD Problem 5.5) — one batched query for every
    // linked student rather than N+1 per-student calls, since this list is
    // typically small (a guardian's own children, not a school-wide list).
    // Mirrors studentsService.ts's loadStudentRoleTags() shape but reads
    // student_role_assignments directly here instead of importing that
    // function, since this needs all linked students in one round trip
    // rather than one student at a time.
    const linkedStudentIds = links.filter(l => l.students).map(l => l.students!.id)
    const roleTagsByStudent = new Map<string, { id: string; name: string }[]>()
    if (linkedStudentIds.length > 0) {
      const { data: roleRows } = await supabase
        .from('student_role_assignments')
        .select('student_id, student_roles ( id, name )')
        .in('student_id', linkedStudentIds)

      for (const row of (roleRows ?? []) as unknown as Array<{
        student_id: string
        student_roles: { id: string; name: string } | null
      }>) {
        if (!row.student_roles) continue
        const existing = roleTagsByStudent.get(row.student_id) ?? []
        existing.push({ id: row.student_roles.id, name: row.student_roles.name })
        roleTagsByStudent.set(row.student_id, existing)
      }
    }

    const linked_students: LinkedStudent[] = links
      .filter(l => l.students)
      .map(l => ({
        student_id:          l.students!.id,
        full_name:           l.students!.full_name,
        class_path_label:    pathLabel(l.students!.class_node_id),
        status:              l.students!.status,
        has_platform_access: l.has_platform_access,
        role_tags:           roleTagsByStudent.get(l.students!.id) ?? [],
      }))

    return {
      ok: true,
      data: {
        id:              data.id,
        full_name:       data.full_name,
        phone:           data.phone ?? null,
        email:           data.email ?? null,
        relationship:    data.relationship ?? null,
        created_at:      data.created_at,
        linked_students,
        identity:        identityRow as GuardianIdentityInfo | null,
      },
    }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load guardian' }
  }
}

// ─── Search guardians (for link-existing flow) ────────────────────────────────

/**
 * Fast name/phone search returning minimal fields.
 * Used in the "Add guardian" search-first flow in StudentsModule.
 * Returns up to 10 results.
 */
export async function searchGuardians(
  query: string,
): Promise<Result<GuardianSearchResult[]>> {
  try {
    if (!query.trim()) return { ok: true, data: [] }

    const { data, error } = await supabase
      .from('guardians')
      .select(`
        id,
        full_name,
        phone,
        email,
        relationship,
        student_guardians ( student_id )
      `)
      .or(`full_name.ilike.%${query.trim()}%,phone.ilike.%${query.trim()}%`)
      .limit(10)

    if (error) return { ok: false, error: error.message }

    const results: GuardianSearchResult[] = (data ?? []).map((r: any) => ({
      id:           r.id,
      full_name:    r.full_name,
      phone:        r.phone ?? null,
      email:        r.email ?? null,
      relationship: r.relationship ?? null,
      student_count: (r.student_guardians as unknown as any[])?.length ?? 0,
    }))

    return { ok: true, data: results }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to search guardians' }
  }
}

// ─── Write: create guardian (no student link) ─────────────────────────────────

export async function createGuardian(params: {
  schoolId: string
  full_name: string
  phone: string | null
  email: string | null
  relationship: string | null
}): Promise<Result<{ id: string }>> {
  try {
    const { data, error } = await supabase
      .from('guardians')
      .insert({
        school_id:    params.schoolId,
        full_name:    params.full_name.trim(),
        phone:        params.phone || null,
        email:        params.email || null,
        relationship: params.relationship || null,
      })
      .select('id')
      .single()

    if (error) return { ok: false, error: friendlyError(error.message) }
    return { ok: true, data: { id: data.id } }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to create guardian' }
  }
}

// ─── Write: update guardian info ──────────────────────────────────────────────

// NOTE: if guardians table has no updated_at column (check §7 / SQL query),
// remove the updated_at line from this update call.
export async function updateGuardian(
  guardianId: string,
  params: {
    full_name: string
    phone: string | null
    email: string | null
    relationship: string | null
  },
): Promise<Result<void>> {
  try {
    const { error } = await supabase
      .from('guardians')
      .update({
        full_name:    params.full_name.trim(),
        phone:        params.phone || null,
        email:        params.email || null,
        relationship: params.relationship || null,
      })
      .eq('id', guardianId)

    if (error) return { ok: false, error: friendlyError(error.message) }
    return { ok: true, data: undefined }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to update guardian' }
  }
}

// ─── Write: link existing guardian to a student ───────────────────────────────

/**
 * Links an already-existing guardian to a student.
 * has_platform_access is false by default — admin grants it separately.
 */
export async function linkGuardianToStudent(params: {
  schoolId: string
  guardianId: string
  studentId: string
}): Promise<Result<void>> {
  try {
    const { error } = await supabase
      .from('student_guardians')
      .insert({
        school_id:           params.schoolId,
        guardian_id:         params.guardianId,
        student_id:          params.studentId,
        has_platform_access: false,
      })

    if (error) {
      if (error.message.includes('duplicate') || error.message.includes('unique')) {
        return { ok: false, error: 'This guardian is already linked to this student.' }
      }
      return { ok: false, error: friendlyError(error.message) }
    }
    return { ok: true, data: undefined }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to link guardian' }
  }
}

// ─── Write: unlink guardian from a student ────────────────────────────────────

export async function unlinkGuardianFromStudent(params: {
  guardianId: string
  studentId: string
}): Promise<Result<void>> {
  try {
    const { error } = await supabase
      .from('student_guardians')
      .delete()
      .eq('guardian_id', params.guardianId)
      .eq('student_id', params.studentId)

    if (error) return { ok: false, error: friendlyError(error.message) }
    return { ok: true, data: undefined }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to unlink guardian' }
  }
}

// ─── Write: deactivate portal access ─────────────────────────────────────────

/**
 * Sets app_identities.is_active = false for this guardian.
 * Does not delete the row — the admin can re-provision if needed.
 */
export async function deactivateGuardianAccess(
  guardianId: string,
): Promise<Result<void>> {
  try {
    const { error } = await supabase
      .from('app_identities')
      .update({ is_active: false })
      .eq('actor_record_id', guardianId)
      .eq('actor_type', 'guardian')

    if (error) return { ok: false, error: error.message }
    return { ok: true, data: undefined }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to deactivate access' }
  }
}

// ─── Internal utilities ───────────────────────────────────────────────────────

function friendlyError(message: string): string {
  if (message.includes('violates row-level security')) {
    return "You don't have permission to manage guardians."
  }
  if (message.includes('violates not-null constraint')) {
    return 'Guardian name is required.'
  }
  if (message.includes('violates foreign key')) {
    return 'Invalid student or school reference.'
  }
  return `Failed to save: ${message}`
}
