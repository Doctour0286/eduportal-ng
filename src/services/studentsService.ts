/**
 * studentsService.ts
 * Data access layer for the Students module.
 * No browser-only APIs. No UI imports. React Native compatible.
 *
 * Read exports:
 *   loadLeafClasses()             — all is_leaf_enrollable class nodes with path labels
 *   loadStudents()                — paginated student list for a class (or all active)
 *   loadStudent()                 — single student by id
 *   loadGuardiansForStudent()     — all guardian links for a student
 *   loadTransferRequest()         — active transfer request for a student, if any
 *   loadAttendanceSummary()       — present/absent/late/excused counts + % for the student's current term
 *   loadStudentRoleTags()         — Session 13: compact role-tag list for display anywhere
 *   loadAssignableStudentRoles()  — Session 13: eligible roles for the Edit subtab's picker, class-filtered
 *
 * Write exports:
 *   createStudent()               — insert new student row
 *   updateStudent()               — update editable fields on an existing student
 *   updateStudentStatus()         — set status (inactive / alumni / active)
 *   addGuardian()                 — create guardian + link to student in one transaction
 *   updateGuardianLink()          — toggle has_platform_access on a student_guardians row
 *   unlinkGuardian()              — remove student_guardians row (does not delete guardian)
 *   initiateTransfer()            — call release-student-transfer Edge Function
 *   assignStudentRole()           — Session 13: assign a student_roles row to a student
 *   unassignStudentRole()         — Session 13: remove a role assignment
 *
 * Pure helpers:
 *   buildClassPathMap()           — O(1) map of classNodeId → path label string
 *   todayDateString()             — local date string, React Native safe
 *   statusLabel()                 — human-readable label for a status value
 */

import { supabase } from '../lib/supabase'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ClassNode {
  id: string
  name: string
  parent_id: string | null
  sort_order: number
  path_label: string   // built client-side, e.g. "JSS 1 · JSS 1A"
}

export interface Student {
  id: string
  full_name: string
  date_of_birth: string | null   // ISO date string
  gender: string | null
  class_node_id: string | null
  class_path_label: string | null  // derived from ClassNode.path_label
  admission_date: string | null    // ISO date string
  student_code: string | null      // admin-assigned or auto-generated identifier
  status: 'active' | 'inactive' | 'alumni' | 'transferred_out' | 'transferred_in_pending'
  // Session 14 (owner request, "more detail space" in the Edit subtab).
  // blood_group/address/medical_notes/emergency_contact_* already existed
  // live since Session 27 (§7.8) but were never wired into this type or any
  // query here — that gap is closed this session, not a new column. hobbies/
  // email/phone are genuinely new columns (migration_session_14, §7.8).
  // Deliberately included in loadStudents()'s own select, not just
  // loadStudent() — StudentsModule.tsx's Edit subtab pre-fills from the list
  // row (detailStudent), never calls the standalone loadStudent() fetch.
  blood_group: string | null
  address: string | null
  medical_notes: string | null
  emergency_contact_name: string | null
  emergency_contact_phone: string | null
  hobbies: string | null
  email: string | null
  phone: string | null
  created_at: string
}

export interface StudentUpsertParams {
  schoolId: string
  full_name: string
  date_of_birth: string | null
  gender: string | null
  class_node_id: string | null
  admission_date: string | null
  student_code: string | null
  blood_group: string | null
  address: string | null
  medical_notes: string | null
  emergency_contact_name: string | null
  emergency_contact_phone: string | null
  hobbies: string | null
  email: string | null
  phone: string | null
}

export interface GuardianLink {
  guardian_id: string
  full_name: string
  phone: string | null
  email: string | null
  relationship: string | null
  has_platform_access: boolean
}

// Session 13 (PRD Problem 5.5) — descriptive-only student roles, e.g.
// "Class Rep", "Head Boy". Compact shape deliberately kept minimal since
// this is the type rendered as a tag "visible from anywhere" (Brief tab,
// list row, and the Guardians page via guardianService.ts) — not just
// inside the Edit subtab where the fuller admin-side StudentRole type
// (settingsService.ts) is used instead.
export interface StudentRoleTag {
  id: string
  name: string
}

// Used only by the Edit subtab's role-assignment picker — the eligible-role
// list, filtered client-side (see loadAssignableStudentRoles' own comment)
// to the student's own class plus all school-wide roles, per PRD step 4's
// explicit filtering requirement.
export interface AssignableStudentRole {
  id: string
  name: string
  class_id: string | null   // null = school-wide; informational only, filtering already applied
  assigned: boolean         // true if this student already holds this role
}


export interface TransferRequest {
  id: string
  status: 'requested' | 'released' | 'claimed' | 'completed' | 'rejected'
  requested_by: 'guardian' | 'student' | 'releasing_admin'
  requested_at: string
  released_at: string | null
  completed_at: string | null
}

/**
 * Attendance summary for the Student Brief.
 * Computed client-side from raw attendance_records — no DB view exists for
 * this yet (attendance_records is the only table; see §7.13). Scope is the
 * school's current academic session (sessions.is_current = true), which is
 * the closest stand-in for "terminal" until a session/term selector exists
 * in the Students module.
 *
 * percent excludes 'excused' from both numerator and denominator — an
 * excused absence shouldn't count against the student, but it also isn't
 * "present", so it's left out of the ratio entirely rather than padding
 * either side.
 */
export interface AttendanceSummary {
  present: number
  absent: number
  late: number
  excused: number
  percent: number | null   // null when there are zero markable (present+absent+late) records yet
}

// Consistent Result shape
type Ok<T>     = { ok: true; data: T }
type Err       = { ok: false; error: string }
type Result<T> = Ok<T> | Err

// ─── Load leaf classes ────────────────────────────────────────────────────────

/**
 * Loads all enrollable leaf class nodes for the school, builds path labels
 * by joining each node to its parent name client-side (2-level label is
 * sufficient for the picker — same approach as attendanceService).
 *
 * Returns sorted by parent sort_order then child sort_order so the picker
 * order mirrors the school's own tree structure.
 */
export async function loadLeafClasses(): Promise<Result<ClassNode[]>> {
  try {
    const { data, error } = await supabase
      .from('class_nodes')
      .select('id, name, parent_id, sort_order, is_leaf_enrollable')
      .order('sort_order')

    if (error) return { ok: false, error: error.message }

    const all = (data ?? []) as Array<{
      id: string
      name: string
      parent_id: string | null
      sort_order: number
      is_leaf_enrollable: boolean
    }>

    const nameMap = new Map<string, string>(all.map(n => [n.id, n.name]))

    const leaves: ClassNode[] = all
      .filter(n => n.is_leaf_enrollable)
      .map(n => ({
        id: n.id,
        name: n.name,
        parent_id: n.parent_id,
        sort_order: n.sort_order,
        path_label: n.parent_id
          ? `${nameMap.get(n.parent_id) ?? ''} · ${n.name}`
          : n.name,
      }))

    return { ok: true, data: leaves }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load classes' }
  }
}

// ─── Load students ────────────────────────────────────────────────────────────

/**
 * Loads active students for the school, optionally filtered by class_node_id.
 * Always sorted alphabetically by full_name.
 */
export async function loadStudents(params: {
  classNodeId: string | null
  includeInactive?: boolean
}): Promise<Result<Student[]>> {
  try {
    let query = supabase
      .from('students')
      .select(`
        id,
        full_name,
        date_of_birth,
        gender,
        class_node_id,
        admission_date,
        status,
        student_code,
        blood_group,
        address,
        medical_notes,
        emergency_contact_name,
        emergency_contact_phone,
        hobbies,
        email,
        phone,
        created_at
      `)
      .order('full_name')

    if (!params.includeInactive) {
      query = query.eq('status', 'active')
    }

    if (params.classNodeId) {
      query = query.eq('class_node_id', params.classNodeId)
    }

    const { data, error } = await query

    if (error) return { ok: false, error: error.message }

    const students: Student[] = (data ?? []).map((r: any) => ({
      id: r.id,
      full_name: r.full_name,
      date_of_birth: r.date_of_birth ?? null,
      gender: r.gender ?? null,
      class_node_id: r.class_node_id ?? null,
      class_path_label: null,
      admission_date: r.admission_date ?? null,
      student_code: r.student_code ?? null,
      status: r.status,
      blood_group: r.blood_group ?? null,
      address: r.address ?? null,
      medical_notes: r.medical_notes ?? null,
      emergency_contact_name: r.emergency_contact_name ?? null,
      emergency_contact_phone: r.emergency_contact_phone ?? null,
      hobbies: r.hobbies ?? null,
      email: r.email ?? null,
      phone: r.phone ?? null,
      created_at: r.created_at,
    }))

    return { ok: true, data: students }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load students' }
  }
}

/**
 * Loads a single student by ID.
 * Used when opening the detail panel or edit form for an existing student.
 */
export async function loadStudent(studentId: string): Promise<Result<Student>> {
  try {
    const { data, error } = await supabase
      .from('students')
      .select('id, full_name, date_of_birth, gender, class_node_id, admission_date, student_code, status, blood_group, address, medical_notes, emergency_contact_name, emergency_contact_phone, hobbies, email, phone, created_at')
      .eq('id', studentId)
      .maybeSingle()

    if (error) return { ok: false, error: error.message }
    if (!data)  return { ok: false, error: 'Student not found.' }

    return {
      ok: true,
      data: {
        id: data.id,
        full_name: data.full_name,
        date_of_birth: data.date_of_birth ?? null,
        gender: data.gender ?? null,
        class_node_id: data.class_node_id ?? null,
        class_path_label: null,
        admission_date: data.admission_date ?? null,
        student_code: data.student_code ?? null,
        status: data.status,
        blood_group: data.blood_group ?? null,
        address: data.address ?? null,
        medical_notes: data.medical_notes ?? null,
        emergency_contact_name: data.emergency_contact_name ?? null,
        emergency_contact_phone: data.emergency_contact_phone ?? null,
        hobbies: data.hobbies ?? null,
        email: data.email ?? null,
        phone: data.phone ?? null,
        created_at: data.created_at,
      },
    }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load student' }
  }
}

// ─── Load guardians for student ───────────────────────────────────────────────

/**
 * Loads all guardians linked to a student via student_guardians.
 * Returns the joined guardian fields + has_platform_access from the junction row.
 *
 * Uses PostgREST foreign-table join: student_guardians → guardians.
 */
export async function loadGuardiansForStudent(
  studentId: string,
): Promise<Result<GuardianLink[]>> {
  try {
    const { data, error } = await supabase
      .from('student_guardians')
      .select(`
        has_platform_access,
        guardians (
          id,
          full_name,
          phone,
          email,
          relationship
        )
      `)
      .eq('student_id', studentId)

    if (error) return { ok: false, error: error.message }

    const links: GuardianLink[] = (data ?? []).map((row: any) => ({
      guardian_id:         row.guardians.id,
      full_name:           row.guardians.full_name,
      phone:               row.guardians.phone ?? null,
      email:               row.guardians.email ?? null,
      relationship:        row.guardians.relationship ?? null,
      has_platform_access: row.has_platform_access,
    }))

    return { ok: true, data: links }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load guardians' }
  }
}

// ─── Load transfer request ────────────────────────────────────────────────────

/**
 * Returns the most recent transfer request for this student at the current school,
 * or null if none exists. Used to show transfer status in the Transfer tab.
 *
 * Only reads rows where releasing_school_id = current_school_id() — enforced by RLS.
 */
export async function loadTransferRequest(
  studentId: string,
): Promise<Result<TransferRequest | null>> {
  try {
    const { data, error } = await supabase
      .from('student_transfer_requests')
      .select('id, status, requested_by, requested_at, released_at, completed_at')
      .eq('student_id', studentId)
      .order('requested_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) return { ok: false, error: error.message }
    if (!data)  return { ok: true, data: null }

    return {
      ok: true,
      data: {
        id:           data.id,
        status:       data.status,
        requested_by: data.requested_by,
        requested_at: data.requested_at,
        released_at:  data.released_at ?? null,
        completed_at: data.completed_at ?? null,
      },
    }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load transfer request' }
  }
}

// ─── Load attendance summary (for Student Brief) ──────────────────────────────

/**
 * Computes a present/absent/late/excused count + attendance % for a student,
 * scoped to the school's current session (sessions.is_current = true).
 *
 * Two-step query (no DB view yet for this aggregate):
 *   1. Find the current session's date range.
 *   2. Count attendance_records by status within that range for the student.
 *
 * If no current session is set up, falls back to all-time records for the
 * student so the Brief never silently shows "no data" when records exist —
 * it only does that when there really are none.
 */
export async function loadAttendanceSummary(
  studentId: string,
): Promise<Result<AttendanceSummary>> {
  try {
    const { data: sessionRow, error: sessionError } = await supabase
      .from('sessions')
      .select('id, start_date, end_date')
      .eq('is_current', true)
      .maybeSingle()

    if (sessionError) return { ok: false, error: sessionError.message }

    let query = supabase
      .from('attendance_records')
      .select('status')
      .eq('student_id', studentId)

    if (sessionRow) {
      query = query.gte('date', sessionRow.start_date).lte('date', sessionRow.end_date)
    }

    const { data, error } = await query

    if (error) return { ok: false, error: error.message }

    const rows = (data ?? []) as Array<{ status: string }>
    const present = rows.filter(r => r.status === 'present').length
    const absent  = rows.filter(r => r.status === 'absent').length
    const late    = rows.filter(r => r.status === 'late').length
    const excused = rows.filter(r => r.status === 'excused').length

    const markable = present + absent + late
    const percent  = markable > 0 ? Math.round((present / markable) * 100) : null

    return { ok: true, data: { present, absent, late, excused, percent } }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load attendance summary' }
  }
}

// ─── Write: create ────────────────────────────────────────────────────────────

/**
 * Inserts a new student row.
 * school_id is required — RLS `with check` enforces it matches the caller's school.
 * status defaults to 'active' at the DB level; no need to pass it on creation.
 */
export async function createStudent(
  params: StudentUpsertParams,
): Promise<Result<{ id: string }>> {
  try {
    const { data, error } = await supabase
      .from('students')
      .insert({
        school_id:      params.schoolId,
        full_name:      params.full_name.trim(),
        date_of_birth:  params.date_of_birth || null,
        gender:         params.gender || null,
        class_node_id:  params.class_node_id || null,
        admission_date: params.admission_date || null,
        student_code:   params.student_code || null,
        blood_group:               params.blood_group || null,
        address:                   params.address || null,
        medical_notes:             params.medical_notes || null,
        emergency_contact_name:    params.emergency_contact_name || null,
        emergency_contact_phone:   params.emergency_contact_phone || null,
        hobbies:                   params.hobbies || null,
        email:                     params.email || null,
        phone:                     params.phone || null,
      })
      .select('id')
      .single()

    if (error) return { ok: false, error: friendlyError(error.message) }
    return { ok: true, data: { id: data.id } }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to create student' }
  }
}

// ─── Write: update editable fields ───────────────────────────────────────────

/**
 * Updates editable fields on an existing student.
 * Does NOT update status — status changes use updateStudentStatus() instead.
 */
export async function updateStudent(
  studentId: string,
  params: StudentUpsertParams,
): Promise<Result<void>> {
  try {
    const { error } = await supabase
      .from('students')
      .update({
        full_name:      params.full_name.trim(),
        date_of_birth:  params.date_of_birth || null,
        gender:         params.gender || null,
        class_node_id:  params.class_node_id || null,
        admission_date: params.admission_date || null,
        student_code:   params.student_code || null,
        blood_group:               params.blood_group || null,
        address:                   params.address || null,
        medical_notes:             params.medical_notes || null,
        emergency_contact_name:    params.emergency_contact_name || null,
        emergency_contact_phone:   params.emergency_contact_phone || null,
        hobbies:                   params.hobbies || null,
        email:                     params.email || null,
        phone:                     params.phone || null,
      })
      .eq('id', studentId)

    if (error) return { ok: false, error: friendlyError(error.message) }
    return { ok: true, data: undefined }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to update student' }
  }
}

// ─── Write: status change ─────────────────────────────────────────────────────

/**
 * Sets the student's status to one of: 'active', 'inactive', 'alumni'.
 *
 * 'transferred_out' is set only by initiateTransfer() via the Edge Function —
 * never directly here. 'transferred_in_pending' is set by the receiving school's
 * import flow — also never directly here.
 *
 * This is a deliberate admin action, not an edit-form field. The UI must
 * show a confirmation dialog before calling this for irreversible statuses
 * (alumni). §4.3: "Confirmation dialogs only for irreversible actions."
 */
export async function updateStudentStatus(
  studentId: string,
  status: 'active' | 'inactive' | 'alumni',
): Promise<Result<void>> {
  try {
    const { error } = await supabase
      .from('students')
      .update({ status })
      .eq('id', studentId)

    if (error) return { ok: false, error: friendlyStatusError(error.message) }
    return { ok: true, data: undefined }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to update student status' }
  }
}

// ─── Write: guardian management ──────────────────────────────────────────────

/**
 * Creates a new guardian record and immediately links them to the student.
 *
 * Two-step operation (no DB transaction available client-side):
 *   1. Insert into guardians
 *   2. Insert into student_guardians
 *
 * If step 2 fails, the orphaned guardian row is left in place — safe to retry
 * since step 2 uses a primary key (student_id, guardian_id) and will upsert.
 *
 * has_platform_access is always false on create — grant separately via
 * updateGuardianLink() after confirming contact details.
 */
export async function addGuardian(params: {
  schoolId: string
  studentId: string
  full_name: string
  phone: string | null
  email: string | null
  relationship: string | null
}): Promise<Result<{ guardian_id: string }>> {
  try {
    // Step 1: create guardian row
    const { data: gData, error: gError } = await supabase
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

    if (gError) return { ok: false, error: friendlyGuardianError(gError.message) }

    // Step 2: link to student
    const { error: linkError } = await supabase
      .from('student_guardians')
      .insert({
        student_id:          params.studentId,
        guardian_id:         gData.id,
        school_id:           params.schoolId,
        has_platform_access: false,
      })

    if (linkError) return { ok: false, error: friendlyGuardianError(linkError.message) }

    return { ok: true, data: { guardian_id: gData.id } }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to add guardian' }
  }
}

/**
 * Toggles has_platform_access on a student_guardians row.
 *
 * Granting access: the partial unique index `one_access_guardian_per_student`
 * enforces at most one platform-access guardian per student. If another guardian
 * already has access, Postgres will reject this with a unique constraint violation.
 * The UI must check this before calling and warn the user, but this function
 * also surfaces the error cleanly.
 *
 * Revoking access: always safe — no constraint is violated.
 */
export async function updateGuardianLink(
  studentId: string,
  guardianId: string,
  hasPlatformAccess: boolean,
): Promise<Result<void>> {
  try {
    const { error } = await supabase
      .from('student_guardians')
      .update({ has_platform_access: hasPlatformAccess })
      .eq('student_id', studentId)
      .eq('guardian_id', guardianId)

    if (error) {
      if (error.message.includes('one_access_guardian_per_student') ||
          error.message.includes('unique constraint')) {
        return {
          ok: false,
          error: 'Another guardian already has platform access for this student. Remove their access first.',
        }
      }
      return { ok: false, error: friendlyGuardianError(error.message) }
    }

    return { ok: true, data: undefined }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to update guardian access' }
  }
}

/**
 * Removes the student_guardians link row.
 * Does NOT delete the guardian record — the guardian may be linked to
 * other students at this school, and hard deletes are not permitted (§3.10).
 */
export async function unlinkGuardian(
  studentId: string,
  guardianId: string,
): Promise<Result<void>> {
  try {
    const { error } = await supabase
      .from('student_guardians')
      .delete()
      .eq('student_id', studentId)
      .eq('guardian_id', guardianId)

    if (error) return { ok: false, error: friendlyGuardianError(error.message) }
    return { ok: true, data: undefined }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to unlink guardian' }
  }
}

// ─── Student roles (Session 13, PRD Problem 5.5) ──────────────────────────────
// Role definitions themselves are managed in Settings (settingsService.ts's
// StudentRole/loadStudentRoles/saveStudentRole/deleteStudentRole) — this
// section is only the per-student read (for tags shown anywhere) and the
// per-student assign/unassign actions reached from the Edit subtab.

/**
 * Compact tag list for display — Brief tab, list row, and the Guardians
 * page (via guardianService.ts, which imports this directly rather than
 * duplicating the query). Deliberately minimal: id + name only, no class
 * scope info, since a tag rendered "anywhere" doesn't need it.
 */
export async function loadStudentRoleTags(
  studentId: string,
): Promise<Result<StudentRoleTag[]>> {
  try {
    const { data, error } = await supabase
      .from('student_role_assignments')
      .select(`
        student_roles ( id, name )
      `)
      .eq('student_id', studentId)

    if (error) return { ok: false, error: error.message }

    const tags: StudentRoleTag[] = (data ?? [])
      .map((row: any) => row.student_roles)
      .filter(Boolean)
      .map((r: any) => ({ id: r.id, name: r.name }))

    return { ok: true, data: tags }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load student roles' }
  }
}

/**
 * Batch version of loadStudentRoleTags, for the students list row display
 * (Session 14, owner request — tags visible directly on the list, not just
 * the detail header). One query for every visible student rather than N+1
 * per row — same tradeoff guardianService.ts's loadGuardian() already makes
 * for a guardian's linked-student rows, just at list-page scale here. Owner
 * confirmed this cost explicitly (flagged during Session 13, revisited and
 * approved this session) rather than it being assumed silently either way.
 */
export async function loadStudentRoleTagsBatch(
  studentIds: string[],
): Promise<Result<Map<string, StudentRoleTag[]>>> {
  try {
    if (studentIds.length === 0) return { ok: true, data: new Map() }

    const { data, error } = await supabase
      .from('student_role_assignments')
      .select(`
        student_id,
        student_roles ( id, name )
      `)
      .in('student_id', studentIds)

    if (error) return { ok: false, error: error.message }

    const byStudent = new Map<string, StudentRoleTag[]>()
    for (const row of (data ?? []) as unknown as Array<{
      student_id: string
      student_roles: { id: string; name: string } | null
    }>) {
      if (!row.student_roles) continue
      const existing = byStudent.get(row.student_id) ?? []
      existing.push({ id: row.student_roles.id, name: row.student_roles.name })
      byStudent.set(row.student_id, existing)
    }

    return { ok: true, data: byStudent }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load student roles' }
  }
}

/**
 * Every school-wide role, plus class-scoped roles for exactly this
 * student's own class — the filtering PRD step 4 requires (a JSS1A student
 * never sees a JSS1B-scoped role as assignable). Filtering is done
 * client-side against the small full `student_roles` list rather than a
 * parameterized query, since a school's total role count is expected to be
 * small (tens, not thousands) and this avoids a second RLS-scoped query
 * shape to maintain — same tradeoff loadGuardiansForStudent() already makes
 * by not paginating. Also marks which roles this student already holds, so
 * the Edit subtab's picker can show assigned state without a second call.
 */
export async function loadAssignableStudentRoles(
  schoolId: string,
  studentId: string,
  classNodeId: string | null,
): Promise<Result<AssignableStudentRole[]>> {
  try {
    const { data: allRoles, error: rolesError } = await supabase
      .from('student_roles')
      .select('id, name, class_id')
      .eq('school_id', schoolId)
      .order('name', { ascending: true })

    if (rolesError) return { ok: false, error: rolesError.message }

    const { data: assignedRows, error: assignedError } = await supabase
      .from('student_role_assignments')
      .select('student_role_id')
      .eq('student_id', studentId)

    if (assignedError) return { ok: false, error: assignedError.message }

    const assignedIds = new Set((assignedRows ?? []).map((r: any) => r.student_role_id as string))

    const eligible: AssignableStudentRole[] = (allRoles ?? [])
      .filter((r: any) => r.class_id === null || r.class_id === classNodeId)
      .map((r: any) => ({
        id:       r.id,
        name:     r.name,
        class_id: r.class_id,
        assigned: assignedIds.has(r.id),
      }))

    return { ok: true, data: eligible }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load assignable roles' }
  }
}

/**
 * Assigns a role to a student. Safe to call even if already assigned —
 * the composite primary key (student_id, student_role_id) on
 * student_role_assignments makes a duplicate a unique-constraint error,
 * caught and treated as a no-op success rather than surfaced as a failure,
 * since the Edit subtab's picker only offers "assign" for roles not
 * already held (assigned: false) — a duplicate here would mean a race
 * with another admin tab, not a UI bug to report loudly.
 */
export async function assignStudentRole(
  schoolId: string,
  studentId: string,
  studentRoleId: string,
): Promise<Result<void>> {
  try {
    const { error } = await supabase
      .from('student_role_assignments')
      .insert({ school_id: schoolId, student_id: studentId, student_role_id: studentRoleId })

    if (error) {
      if (error.message.includes('duplicate') || error.message.includes('unique')) {
        return { ok: true, data: undefined }
      }
      return { ok: false, error: error.message }
    }
    return { ok: true, data: undefined }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to assign role' }
  }
}

export async function unassignStudentRole(
  studentId: string,
  studentRoleId: string,
): Promise<Result<void>> {
  try {
    const { error } = await supabase
      .from('student_role_assignments')
      .delete()
      .eq('student_id', studentId)
      .eq('student_role_id', studentRoleId)

    if (error) return { ok: false, error: error.message }
    return { ok: true, data: undefined }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to remove role' }
  }
}

// ─── Guardian identity ────────────────────────────────────────────────────────
// Checks whether a guardian already has an app_identities row (i.e. has been
// provisioned with a login method). Used by the guardians tab to show current
// access method and login code without calling the Edge Function unnecessarily.

export interface GuardianIdentity {
  login_method: 'login_code' | 'phone_otp'
  login_code: string | null
  is_active: boolean
}

export async function loadGuardianIdentity(
  schoolId: string,
  guardianId: string,
): Promise<{ ok: true; data: GuardianIdentity | null } | { ok: false; error: string }> {
  const { data, error } = await supabase
    .from('app_identities')
    .select('login_method, login_code, is_active')
    .eq('school_id', schoolId)
    .eq('actor_record_id', guardianId)
    .eq('actor_type', 'guardian')
    .maybeSingle()

  if (error) return { ok: false, error: 'Could not load guardian access info' }
  return { ok: true, data: data as GuardianIdentity | null }
}

// Calls the provision-guardian-access Edge Function.
// Returns the login_code (or null for phone_otp) on success.

export async function provisionGuardianAccess(params: {
  schoolId: string
  guardianId: string
  loginMethod: 'login_code' | 'phone_otp'
  phone?: string
  regenerate?: boolean
}): Promise<{ ok: true; loginCode: string | null; alreadyProvisioned?: boolean } | { ok: false; error: string }> {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string
  const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string

  let res: Response
  try {
    res = await fetch(`${supabaseUrl}/functions/v1/provision-guardian-access`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseAnonKey}`,
        'apikey': supabaseAnonKey,
      },
      body: JSON.stringify({
        school_id:    params.schoolId,
        guardian_id:  params.guardianId,
        login_method: params.loginMethod,
        phone:        params.phone,
        regenerate:   params.regenerate ?? false,
      }),
    })		
  } catch {
    return { ok: false, error: 'Network error — check your connection and try again' }
  }

  let json: Record<string, unknown> = {}
  try { json = await res.json() } catch { /* ignore */ }

  if (!res.ok) {
    return { ok: false, error: (json.error as string) ?? 'Failed to provision access' }
  }

  if (json.already_provisioned) {
    return {
      ok: true,
      loginCode: (json.login_code as string | null) ?? null,
      alreadyProvisioned: true,
    }
  }

  return { ok: true, loginCode: (json.login_code as string | null) ?? null }
}

// ─── Student identity ─────────────────────────────────────────────────────────
// Checks whether a student already has an app_identities row (i.e. has been
// provisioned with a login_code). Used by the Info tab to show current code
// without calling the Edge Function unnecessarily.

export interface StudentIdentity {
  login_code: string
  is_active: boolean
}

export async function loadStudentIdentity(
  schoolId: string,
  studentId: string,
): Promise<{ ok: true; data: StudentIdentity | null } | { ok: false; error: string }> {
  const { data, error } = await supabase
    .from('app_identities')
    .select('login_code, is_active')
    .eq('school_id', schoolId)
    .eq('actor_record_id', studentId)
    .eq('actor_type', 'student')
    .maybeSingle()

  if (error) return { ok: false, error: 'Could not load student access info' }
  return { ok: true, data: data as StudentIdentity | null }
}

// Calls the provision-student-access Edge Function.
// Returns the login_code on success.

export async function provisionStudentAccess(params: {
  schoolId: string
  studentId: string
  regenerate?: boolean
}): Promise<{ ok: true; loginCode: string; alreadyProvisioned?: boolean } | { ok: false; error: string }> {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string
  const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string

  let res: Response
  try {
    res = await fetch(`${supabaseUrl}/functions/v1/provision-student-access`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseAnonKey}`,
        'apikey': supabaseAnonKey,
      },
      body: JSON.stringify({
        school_id:  params.schoolId,
        student_id: params.studentId,
        regenerate: params.regenerate ?? false,
      }),
    })
  } catch {
    return { ok: false, error: 'Network error — check your connection and try again' }
  }

  let json: Record<string, unknown> = {}
  try { json = await res.json() } catch { /* ignore */ }

  if (!res.ok) {
    return { ok: false, error: (json.error as string) ?? 'Failed to provision student access' }
  }

  if (json.already_provisioned) {
    return {
      ok: true,
      loginCode: json.login_code as string,
      alreadyProvisioned: true,
    }
  }

  return { ok: true, loginCode: json.login_code as string }
}

// ─── Write: transfer initiation ───────────────────────────────────────────────

/**
 * Calls the `release-student-transfer` Edge Function to initiate a transfer.
 *
 * The Edge Function (server-side, service-role key):
 *   — Verifies caller is staff of the releasing school
 *   — Builds a full student snapshot (guardians, subjects, attendance summary)
 *   — Inserts a student_transfer_requests row with status = 'released'
 *   — Sets students.status = 'transferred_out'
 *   — Returns the transfer request id
 *
 * The UI must show a confirmation dialog before calling this — it is irreversible
 * from the releasing school's side once the student's status is transferred_out.
 *
 * Edge Function URL pattern: {SUPABASE_URL}/functions/v1/release-student-transfer
 */
export async function initiateTransfer(params: {
  studentId: string
  requestedBy: 'releasing_admin'
}): Promise<Result<{ transfer_request_id: string }>> {
  try {
    const supabaseUrl = (supabase as any).supabaseUrl as string
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return { ok: false, error: 'Not authenticated.' }

    const response = await fetch(
      `${supabaseUrl}/functions/v1/release-student-transfer`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          student_id:    params.studentId,
          requested_by:  params.requestedBy,
        }),
      },
    )

    const json = await response.json().catch(() => ({}))

    if (!response.ok) {
      const msg = json?.error ?? json?.message ?? `Transfer failed (${response.status})`
      return { ok: false, error: friendlyTransferError(msg) }
    }

    if (!json?.transfer_request_id) {
      return { ok: false, error: 'Transfer initiated but no confirmation received. Check the student\'s status before retrying.' }
    }

    return { ok: true, data: { transfer_request_id: json.transfer_request_id } }
  } catch (err: any) {
    if (err?.message?.toLowerCase().includes('fetch')) {
      return { ok: false, error: 'No internet connection. Please try again when online.' }
    }
    return { ok: false, error: err?.message ?? 'Failed to initiate transfer' }
  }
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Builds an O(1) map of classNodeId → path_label from a loaded ClassNode array.
 */
export function buildClassPathMap(classes: ClassNode[]): Map<string, string> {
  return new Map(classes.map(c => [c.id, c.path_label]))
}

/**
 * Returns today's date as a local ISO string (YYYY-MM-DD).
 * Uses no window/navigator — React Native safe.
 */
export function todayDateString(): string {
  const d = new Date()
  const yyyy = d.getFullYear()
  const mm   = String(d.getMonth() + 1).padStart(2, '0')
  const dd   = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

/**
 * Returns a human-readable label for a student status value.
 */
export function statusLabel(status: Student['status']): string {
  switch (status) {
    case 'active':                 return 'Active'
    case 'inactive':               return 'Inactive'
    case 'alumni':                 return 'Alumni'
    case 'transferred_out':        return 'Transferred out'
    case 'transferred_in_pending': return 'Transfer pending'
  }
}

// ─── Internal utilities ───────────────────────────────────────────────────────

function friendlyError(message: string): string {
  if (message.includes('violates row-level security')) {
    return "You don't have permission to add or edit students."
  }
  if (message.includes('violates not-null constraint')) {
    return 'Student name is required.'
  }
  if (message.includes('violates foreign key')) {
    return 'The selected class no longer exists. Please refresh and try again.'
  }
  return 'Failed to save student. Please try again.'
}

function friendlyStatusError(message: string): string {
  if (message.includes('violates row-level security')) {
    return "You don't have permission to change this student's status."
  }
  return 'Failed to update status. Please try again.'
}

function friendlyGuardianError(message: string): string {
  if (message.includes('violates row-level security')) {
    return "You don't have permission to manage guardians."
  }
  if (message.includes('violates not-null constraint')) {
    return 'Guardian name is required.'
  }
  return 'Failed to save guardian. Please try again.'
}

function friendlyTransferError(message: string): string {
  if (message.toLowerCase().includes('permission') ||
      message.toLowerCase().includes('security')) {
    return "You don't have permission to initiate transfers."
  }
  if (message.toLowerCase().includes('already transferred')) {
    return 'This student has already been transferred out.'
  }
  return message
}
