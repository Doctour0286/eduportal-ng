/**
 * studentsService.ts
 * Data access layer for the Students module.
 * No browser-only APIs. No UI imports. React Native compatible.
 *
 * FLAGGED EXCEPTION (Session 21, §5): resizeImageToBlob() below uses
 * createImageBitmap/canvas/canvas.toBlob — all browser-only DOM APIs — to
 * satisfy §4.8's "resize client-side before upload" requirement. This is a
 * deliberate, named deviation from this file's own "no browser-only APIs"
 * rule, not an oversight: the PRD's Session 21 instructions explicitly name
 * canvas-based resize as an acceptable approach in the same step as the
 * upload call, and keeping resize inside uploadStudentPhoto() guarantees
 * every caller gets a resized image with no way to bypass it. If this file
 * is ever reused in a non-browser context (React Native), this one function
 * would need to move to a platform-specific implementation.
 *
 * Read exports:
 *   loadLeafClasses()             — all is_leaf_enrollable class nodes with path labels
 *   loadParentClassGroups()       — Session 32: parent class nodes + their leaf ids, for the whole-parent filter view
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
 *   updateStudentStatus()         — set status (inactive / alumni / active); note required on reactivation
 *   runAttendanceAutoDeactivationCheck() — migration_attendance_auto_deactivation.sql:
 *                                   "looks automatic" per-school check, call from a
 *                                   students.records.manage-gated screen on load
 *   addGuardian()                 — create guardian + link to student in one transaction
 *   updateGuardianLink()          — toggle has_platform_access on a student_guardians row
 *   unlinkGuardian()              — remove student_guardians row (does not delete guardian)
 *   initiateTransfer()            — call release-student-transfer Edge Function
 *   assignStudentRole()           — Session 13: assign a student_roles row to a student
 *   unassignStudentRole()         — Session 13: remove a role assignment
 *   uploadStudentPhoto()          — Session 21: resize + upload to Storage, save path to photo_url
 *   getActivePlacedStudentCount() — Problem 9.9 (Tier 9): the one canonical "active, currently-
 *                                    placed higher-ed student" count, shared by AdminDashboard.tsx
 *                                    and this file's own getHigherEdStudentStatusCounts()
 *
 * Pure helpers:
 *   buildClassPathMap()           — O(1) map of classNodeId → path label string
 *   todayDateString()             — local date string, React Native safe
 *   statusLabel()                 — human-readable label for a status value
 *   getStudentPhotoSignedUrl()    — Session 21: resolves photo_url (a Storage path) into a
 *                                    short-lived signed URL for display; caches per path/TTL
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

// Session 32 (owner request: "same kind of intelligent navigation" as
// AttendanceModule's whole-parent view) — one entry per parent class node
// that has at least one enrollable leaf beneath it, carrying the ids of
// those leaves so the UI can filter/aggregate across an entire grade level
// (e.g. "All of JSS 1") in one combined list rather than one arm at a time.
export interface ParentClassGroup {
  id: string
  name: string
  leafIds: string[]
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
  // SESSION 64 (owner-reported gap) — matric_number exists on students
  // since SESSION 55 but was never added to this type or to
  // loadStudents()'s/loadStudent()'s select lists. Higher-ed-only in
  // practice (nullable, unique per school when set) but harmless to
  // include unconditionally, matching student_code's own always-present
  // shape rather than adding a second isHigherEd-gated select variant.
  matric_number: string | null
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
  // Session 20 (PRD Tier 5 / Problem 5.3, Goal 1) — nullable. Despite the
  // column name, this stores a **Storage object path**
  // (<school_id>/<student_id>/photo.jpg), not a directly-renderable URL —
  // corrected in Session 21 once the bucket was confirmed private
  // (public: false). Never render this value directly as an <img src>;
  // resolve it first via getStudentPhotoSignedUrl(). Null = no photo yet;
  // UI falls back to initials.
  photo_url: string | null
  created_at: string
  // Attendance auto-deactivation (migration_attendance_auto_deactivation.sql)
  // — all four maintained by the DB trigger / updateStudentStatus(), never
  // set directly from a form. See that migration's header comment for the
  // full rule set.
  consecutive_absent_count: number
  cumulative_absent_count: number
  last_absent_date: string | null
  deactivation_reason: 'attendance_auto' | null
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
  // Problem 9.8 (Tier 9) — higher-ed-only, optional. When both are set on
  // createStudent(), a student_programme_placements row is written right
  // after the student is created (see createStudent() below). Deliberately
  // NOT part of the students table insert itself — placement lives in its
  // own table, unrelated to this insert's columns; carried here only so
  // the caller (StudentsModule.tsx's Add form) can pass both in one params
  // object instead of two separate calls with two separate error-handling
  // paths at the call site. Never read by updateStudent() — editing a
  // student's placement is a separate, existing action (upsertPlacement()
  // directly), not part of the general edit form.
  programme_level_id?: string | null
  session_id?: string | null
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

import { getSchoolHoursEndMoment, isWithinEditWindow } from './attendanceService'

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
export async function loadLeafClasses(schoolId: string): Promise<Result<ClassNode[]>> {
  try {
    const { data, error } = await supabase
      .from('class_nodes')
      .select('id, name, parent_id, sort_order, is_leaf_enrollable')
      .eq('school_id', schoolId)
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

/**
 * Session 32 — loads every parent class node that has at least one
 * enrollable leaf beneath it, for the two-tier "grade level" filter
 * (matches AttendanceModule.tsx's own loadParentClassGroups, same
 * reasoning: keeps loadLeafClasses()'s existing contract/return shape
 * untouched for any other caller, adds a parallel export instead).
 *
 * Deliberately a second lightweight query rather than derived from an
 * already-loaded leaves array — this needs parent name + sort_order too,
 * which loadLeafClasses() doesn't return for parents (only bakes the name
 * into each leaf's path_label string). Cheap: one query, id/name/parent_id/
 * sort_order columns only, same table as loadLeafClasses().
 */
export async function loadParentClassGroups(schoolId: string): Promise<Result<ParentClassGroup[]>> {
  try {
    const { data, error } = await supabase
      .from('class_nodes')
      .select('id, name, parent_id, sort_order, is_leaf_enrollable')
      .eq('school_id', schoolId)
      .order('sort_order')

    if (error) return { ok: false, error: error.message }

    const all = (data ?? []) as Array<{
      id: string
      name: string
      parent_id: string | null
      sort_order: number
      is_leaf_enrollable: boolean
    }>

    const byId = new Map(all.map(n => [n.id, n]))
    const leafIdsByParent = new Map<string, string[]>()

    for (const n of all) {
      if (!n.is_leaf_enrollable || !n.parent_id) continue
      const arr = leafIdsByParent.get(n.parent_id) ?? []
      arr.push(n.id)
      leafIdsByParent.set(n.parent_id, arr)
    }

    const groups: ParentClassGroup[] = Array.from(leafIdsByParent.entries())
      .map(([parentId, leafIds]) => ({
        id: parentId,
        name: byId.get(parentId)?.name ?? 'Class',
        leafIds,
        sort_order: byId.get(parentId)?.sort_order ?? 0,
      }))
      .sort((a, b) => a.sort_order - b.sort_order)
      .map(({ id, name, leafIds }) => ({ id, name, leafIds })) // drop sort_order, not part of the public type

    return { ok: true, data: groups }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load class groups' }
  }
}

// ─── Load students ────────────────────────────────────────────────────────────

/**
 * Loads active students for the school, optionally filtered by class_node_id.
 * Always sorted alphabetically by full_name.
 *
 * SESSION 64 (PRD Problem 8.7a) — for a higher-ed school, `students.status`
 * is no longer trusted as ground truth for 'active' (see master-plan §12,
 * "computed live, nothing stored" decision). When `isHigherEd` is true and
 * `statusFilter` resolves to 'active' (the default), this function instead
 * selects every student who has a current `student_programme_placements` row
 * — a two-step fetch (ids first, then the real student rows), not a single
 * joined query, because Supabase's client can't cleanly express "exists a
 * matching row in another table" as a filter without an actual FK-based
 * embed, and `students` has no FK to `student_programme_placements` (the
 * relationship runs the other way). 'inactive'/'alumni' filtering for
 * higher-ed is a real, deliberately open gap — not yet defined per §12 — and
 * falls through to the same raw-column read secondary schools use, which is
 * likely wrong for higher-ed until that gap is resolved; not silently
 * patched over here.
 */
export async function loadStudents(params: {
  schoolId: string
  // Session 32 — widened from `string | null` to also accept `string[]`,
  // for the whole-parent "All of JSS 1" combined view (matches
  // attendanceService.ts's own loadStudentsForClass widening, same
  // reasoning: .eq() for a single id keeps every existing call site's
  // behavior byte-for-byte unchanged, .in() only engages when an array is
  // actually passed).
  classNodeId: string | string[] | null
  // Session 22 follow-up (stat-strip drill-down): which single status to
  // return. Defaults to 'active' when omitted, preserving every existing
  // caller's behavior exactly as before this param was renamed from the old
  // includeInactive boolean. Only ever one status at a time — the visible
  // list shows one status view at a time (active by default, or whichever
  // status chip was clicked), never a blended "all statuses" list. The
  // combined-total counts for the stat strip come from the separate
  // getStudentStatusCounts() below, not from this function.
  statusFilter?: Student['status']
  // SESSION 64 — see function header. Omitted/false preserves every
  // existing secondary-school caller's behavior exactly as before this
  // param existed.
  isHigherEd?: boolean
  // SESSION 64 follow-up (owner-reported gap) — higher-ed equivalent of
  // classNodeId. Only meaningful when isHigherEd is true; ignored
  // otherwise. Same array-or-null shape as classNodeId (a "whole
  // programme" filter needs every level under it, a single level needs
  // just one); null/empty means no level filter, matching classNodeId's
  // own "no filter" convention exactly.
  programmeLevelIds?: string[] | null
}): Promise<Result<Student[]>> {
  try {
    const resolvedStatus = params.statusFilter ?? 'active'
    let placementStudentIds: string[] | null = null

    if (params.isHigherEd && resolvedStatus === 'active') {
      let placementQuery = supabase
        .from('student_programme_placements')
        .select('student_id')
        .eq('is_current', true)
      if (params.programmeLevelIds && params.programmeLevelIds.length > 0) {
        placementQuery = placementQuery.in('programme_level_id', params.programmeLevelIds)
      }
      const { data: placementRows, error: placementError } = await placementQuery
      if (placementError) return { ok: false, error: placementError.message }
      placementStudentIds = Array.from(new Set((placementRows ?? []).map((r: any) => r.student_id as string)))
      // An empty result here is a real, valid state (no students admitted
      // yet, or none in the selected level) — return early rather than
      // letting an empty .in() below fall through to Postgrest's own
      // "no filter applied" behavior, which would incorrectly return
      // every student regardless of placement/level.
      if (placementStudentIds.length === 0) return { ok: true, data: [] }
    }

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
        matric_number,
        blood_group,
        address,
        medical_notes,
        emergency_contact_name,
        emergency_contact_phone,
        hobbies,
        email,
        phone,
        photo_url,
        created_at,
        consecutive_absent_count,
        cumulative_absent_count,
        last_absent_date,
        deactivation_reason
      `)
      .eq('school_id', params.schoolId)
      .order('full_name')

    if (placementStudentIds) {
      query = query.in('id', placementStudentIds)
    } else {
      query = query.eq('status', resolvedStatus)
    }

    if (Array.isArray(params.classNodeId)) {
      if (params.classNodeId.length > 0) {
        query = query.in('class_node_id', params.classNodeId)
      }
    } else if (params.classNodeId) {
      query = query.eq('class_node_id', params.classNodeId)
    }

    const { data, error } = await query

    if (error) return { ok: false, error: error.message }

    const students: Student[] = (data ?? []).map(mapStudentRow)

    return { ok: true, data: students }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load students' }
  }
}

// Shared row → Student mapper, factored out (Problem 9.8 build) so
// loadStudents() and the new loadUnplacedHigherEdStudents() below don't
// each carry their own independent copy of this same field-by-field
// mapping — the exact "one implementation, not two" discipline this file's
// own header comment already asks for elsewhere. loadStudent() (singular,
// by-id) keeps its own inline version below, since its select list is
// already a different shape (fewer/different columns) — not worth forcing
// into this same helper only to immediately diverge.
function mapStudentRow(r: any): Student {
  return {
    id: r.id,
    full_name: r.full_name,
    date_of_birth: r.date_of_birth ?? null,
    gender: r.gender ?? null,
    class_node_id: r.class_node_id ?? null,
    class_path_label: null,
    admission_date: r.admission_date ?? null,
    student_code: r.student_code ?? null,
    matric_number: r.matric_number ?? null,
    status: r.status,
    blood_group: r.blood_group ?? null,
    address: r.address ?? null,
    medical_notes: r.medical_notes ?? null,
    emergency_contact_name: r.emergency_contact_name ?? null,
    emergency_contact_phone: r.emergency_contact_phone ?? null,
    hobbies: r.hobbies ?? null,
    email: r.email ?? null,
    phone: r.phone ?? null,
    photo_url: r.photo_url ?? null,
    created_at: r.created_at,
    consecutive_absent_count: r.consecutive_absent_count ?? 0,
    cumulative_absent_count: r.cumulative_absent_count ?? 0,
    last_absent_date: r.last_absent_date ?? null,
    deactivation_reason: r.deactivation_reason ?? null,
  }
}

/**
 * Problem 9.8 (Tier 9) — every status='active' higher-ed student with no
 * current student_programme_placements row. The exact inverse of
 * loadStudents()'s isHigherEd branch above: that function fetches
 * placementStudentIds and does `.in('id', placementStudentIds)`; this one
 * fetches the identical placementStudentIds shape and does the opposite —
 * `.not('id', 'in', ...)` — so "placed" is defined exactly once, the same
 * way, in both places, and can never quietly drift into two different
 * meanings of "placed" over time.
 *
 * Deliberately its own function rather than a new loadStudents() param
 * (e.g. `unplacedOnly?: boolean`) — "unplaced" is not a statusFilter value
 * (students.status has no such state, per that column's own real enum) and
 * forcing it through the same param as active/inactive/alumni would
 * conflate a real DB status with a derived, placement-based condition that
 * happens to share only the 'active' status as a precondition.
 */
export async function loadUnplacedHigherEdStudents(
  schoolId: string,
): Promise<Result<Student[]>> {
  try {
    const { data: placementRows, error: placementError } = await supabase
      .from('student_programme_placements')
      .select('student_id')
      .eq('school_id', schoolId)
      .eq('is_current', true)
    if (placementError) return { ok: false, error: placementError.message }
    const placedStudentIds = Array.from(new Set((placementRows ?? []).map((r: any) => r.student_id as string)))

    let query = supabase
      .from('students')
      .select(`
        id, full_name, date_of_birth, gender, class_node_id, admission_date,
        status, student_code, matric_number, blood_group, address,
        medical_notes, emergency_contact_name, emergency_contact_phone,
        hobbies, email, phone, photo_url, created_at
      `)
      .eq('school_id', schoolId)
      .eq('status', 'active')
      .order('full_name')

    // Supabase/PostgREST's .not('id', 'in', (...)) needs a non-empty list —
    // an empty placedStudentIds means "nobody is placed yet," which is a
    // real, valid state (every active student is unplaced) and must NOT be
    // treated as "no filter" the same way loadStudents() already guards
    // against the mirror-image case for its own .in() call above.
    if (placedStudentIds.length > 0) {
      query = query.not('id', 'in', `(${placedStudentIds.join(',')})`)
    }

    const { data, error } = await query
    if (error) return { ok: false, error: error.message }

    return { ok: true, data: (data ?? []).map(mapStudentRow) }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load unplaced students' }
  }
}

export interface StudentStatusCounts {
  active: number
  inactive: number
  alumni: number
  transferred_out: number
  transferred_in_pending: number
  total: number
  // Problem 9.8 (Tier 9) — higher-ed only. Count of students with
  // status = 'active' who have no current student_programme_placements
  // row (direct-add students never routed through placement). Undefined
  // for secondary schools (getStudentStatusCounts() never sets it) — not
  // 0, since 0 and "not applicable" are different facts and a stray 0
  // tile would misleadingly imply the concept exists for that school type.
  unplaced?: number
}

/**
 * Session 22 follow-up (stat-strip drill-down).
 * Returns counts of students by status, scoped to a class filter exactly
 * like loadStudents() — but across ALL statuses at once, regardless of
 * which single status the visible list is currently showing. This is what
 * powers the Students stat strip; it's deliberately independent of
 * loadStudents()'s statusFilter so the strip's numbers stay stable while the
 * list underneath switches between active/inactive/alumni/transferred.
 *
 * Selects only the `status` column (no other fields) and tallies
 * client-side — Supabase's JS client has no native GROUP BY, and a
 * single-column fetch keeps the payload small even for large rosters.
 *
 * SECONDARY-SCHOOL ONLY as of SESSION 64 — a higher-ed student has no
 * class_node_id at all, so this function's entire filter axis (class
 * scoping) doesn't apply to it. Call getHigherEdStudentStatusCounts() below
 * for a higher-ed school instead of trying to force isHigherEd through this
 * one, which would conflate two genuinely different filter concepts rather
 * than cleanly separating them.
 */
export async function getStudentStatusCounts(params: {
  schoolId: string
  // Session 32 — widened, same reasoning as loadStudents() above.
  classNodeId: string | string[] | null
}): Promise<Result<StudentStatusCounts>> {
  try {
    let query = supabase.from('students').select('status').eq('school_id', params.schoolId)

    if (Array.isArray(params.classNodeId)) {
      if (params.classNodeId.length > 0) {
        query = query.in('class_node_id', params.classNodeId)
      }
    } else if (params.classNodeId) {
      query = query.eq('class_node_id', params.classNodeId)
    }

    const { data, error } = await query
    if (error) return { ok: false, error: error.message }

    const rows = (data ?? []) as Array<{ status: Student['status'] }>
    const counts: StudentStatusCounts = {
      active: 0,
      inactive: 0,
      alumni: 0,
      transferred_out: 0,
      transferred_in_pending: 0,
      total: rows.length,
    }
    for (const r of rows) {
      if (r.status in counts) counts[r.status as keyof Omit<StudentStatusCounts, 'total'>]++
    }

    return { ok: true, data: counts }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load student status counts' }
  }
}

/**
 * SESSION 64 (PRD Problem 8.7a) — higher-ed equivalent of
 * getStudentStatusCounts() above, deliberately separate rather than a branch
 * inside it (see that function's own header note). `active` is the count of
 * students with a current student_programme_placements row — the same
 * derivation loadStudents()'s isHigherEd branch uses, so the stat strip and
 * the visible list can never disagree about what "active" means. `inactive`
 * and `alumni` are correctly left at 0, not guessed at: per master-plan §12,
 * neither has a defined trigger for higher-ed yet (alumni awaits SESSION
 * 69's promotion/graduation logic; inactive is an explicitly open gap) — a
 * silently wrong non-zero number would be worse than an honestly-zero one
 * for a status this function has no real way to compute yet.
 * `transferred_out`/`transferred_in_pending` are read from the raw column,
 * since inter-school transfer (initiateTransfer()) is school-type-agnostic
 * and unaffected by any of this — those two statuses mean the same thing
 * for both school types.
 *
 * Bug found and fixed while resuming this session: the placement-count
 * query below originally had no `school_id` filter at all, while the
 * transfer-count query in the same function correctly scoped on it —
 * an inconsistency within one function, not a deliberate RLS-reliant
 * choice (unlike loadStudents()/getStudentStatusCounts() above, which
 * consistently omit explicit school_id everywhere and rely on RLS
 * throughout). `student_programme_placements` is `[STD]`-scoped RLS
 * (§7.27.1a), so this was not an actual cross-tenant data leak — but
 * an unscoped read sitting next to a scoped one in the same function
 * is exactly the kind of drift this codebase has flagged before, so
 * fixed rather than left as a latent inconsistency.
 */
// Problem 9.9 (Tier 9) — the one canonical query for "which students at
// this school currently have an active placement," extracted so every
// caller (the count below, getHigherEdStudentStatusCounts()'s own
// activeCount/unplaced derivation, and AdminDashboard.tsx via the count
// function) shares one real query, not independently-written copies that
// happen to agree by coincidence. This is exactly the "one canonical
// derivation, never two independently-computed versions that could drift"
// discipline already applied elsewhere in this codebase (nowColState,
// canViewFinance) — extended here across files rather than within just one.
async function loadCurrentlyPlacedStudentIds(
  schoolId: string,
): Promise<Result<Set<string>>> {
  const { data, error } = await supabase
    .from('student_programme_placements')
    .select('student_id')
    .eq('school_id', schoolId)
    .eq('is_current', true)
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: new Set((data ?? []).map((r: any) => r.student_id as string)) }
}

// Root cause this closes: AdminDashboard.tsx's totalStudents card was a
// flat `students` count with `status = 'active'` and no join to placement
// at all — a directly-added-but-unplaced student (Problem 9.8's own defect,
// now fixed at creation time, but any student who slips through the
// Unplaced view's remediation crosses this same boundary too) was counted
// here even though StudentsModule.tsx's list/stat-strip never queried them
// in the first place. Both surfaces now resolve "active" the same way.
export async function getActivePlacedStudentCount(
  schoolId: string,
): Promise<Result<number>> {
  const result = await loadCurrentlyPlacedStudentIds(schoolId)
  if (!result.ok) return result
  return { ok: true, data: result.data.size }
}

export async function getHigherEdStudentStatusCounts(
  schoolId: string,
): Promise<Result<StudentStatusCounts>> {
  try {
    const placedResult = await loadCurrentlyPlacedStudentIds(schoolId)
    if (!placedResult.ok) return placedResult
    const placedStudentIds = placedResult.data
    const activeCount = placedStudentIds.size

    const { data: transferRows, error: transferError } = await supabase
      .from('students')
      .select('status')
      .eq('school_id', schoolId)
      .in('status', ['transferred_out', 'transferred_in_pending'])
    if (transferError) return { ok: false, error: transferError.message }
    const transferredOut = (transferRows ?? []).filter((r: any) => r.status === 'transferred_out').length
    const transferredInPending = (transferRows ?? []).filter((r: any) => r.status === 'transferred_in_pending').length

    // Problem 9.8 (Tier 9) — "unplaced" is every status='active' student NOT
    // in placedStudentIds above. Deliberately a second, separate query
    // rather than trying to derive it from placedStudentIds alone (that set
    // only tells us who IS placed — it says nothing about how many active
    // students exist in total, which is the other half of the subtraction).
    // Scoped to status='active' only, matching this function's own existing
    // convention that 'active' for higher-ed means "should have a current
    // placement" — an inactive/alumni/transferred student missing a
    // placement is not this problem's concern and must not inflate the count.
    const { data: activeStatusRows, error: activeStatusError } = await supabase
      .from('students')
      .select('id')
      .eq('school_id', schoolId)
      .eq('status', 'active')
    if (activeStatusError) return { ok: false, error: activeStatusError.message }
    const unplacedCount = (activeStatusRows ?? []).filter((r: any) => !placedStudentIds.has(r.id)).length

    return {
      ok: true,
      data: {
        active: activeCount,
        inactive: 0,
        alumni: 0,
        transferred_out: transferredOut,
        transferred_in_pending: transferredInPending,
        total: activeCount + transferredOut + transferredInPending,
        unplaced: unplacedCount,
      },
    }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load higher-ed student status counts' }
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
      .select('id, full_name, date_of_birth, gender, class_node_id, admission_date, student_code, matric_number, status, blood_group, address, medical_notes, emergency_contact_name, emergency_contact_phone, hobbies, email, phone, photo_url, created_at, consecutive_absent_count, cumulative_absent_count, last_absent_date, deactivation_reason')
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
        matric_number: data.matric_number ?? null,
        status: data.status,
        blood_group: data.blood_group ?? null,
        address: data.address ?? null,
        medical_notes: data.medical_notes ?? null,
        emergency_contact_name: data.emergency_contact_name ?? null,
        emergency_contact_phone: data.emergency_contact_phone ?? null,
        hobbies: data.hobbies ?? null,
        email: data.email ?? null,
        phone: data.phone ?? null,
        photo_url: data.photo_url ?? null,
        created_at: data.created_at,
        consecutive_absent_count: data.consecutive_absent_count ?? 0,
        cumulative_absent_count: data.cumulative_absent_count ?? 0,
        last_absent_date: data.last_absent_date ?? null,
        deactivation_reason: data.deactivation_reason ?? null,
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

// ─── Write: photo upload ──────────────────────────────────────────────────────
// Session 21 (PRD Tier 5 / Problem 5.3, Goal 3). No browser-image-compression
// dependency exists in package.json (confirmed before writing this) — resize
// is done with a plain <canvas>, which is web-only but isolated to this one
// function; a future React Native port swaps this one function's internals,
// same abstraction-boundary approach §5 asks for elsewhere (storage.get(),
// platform.openURL()). Nothing else in this file touches the DOM.

/**
 * Resizes an image file client-side to a max edge of `maxEdge` pixels and
 * re-encodes it as JPEG at the given quality, entirely in-memory (no disk
 * write, no browser storage). Never uploads the original raw file — per
 * §4.8, a full-resolution camera photo is a serious regression on Nigerian
 * 3G, and nothing in this app displays the photo at more than avatar/ID-card
 * size, so a full-resolution copy would never even be used once stored.
 *
 * Returns a Blob ready to hand to Storage's upload(), not a data URL — a
 * Blob avoids the ~33% base64 size inflation a data URL would otherwise
 * cost on top of the network upload.
 */
async function resizeImageToBlob(
  file: File,
  maxEdge = 480,
  quality = 0.82,
): Promise<Result<Blob>> {
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
    const width  = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return { ok: false, error: 'Could not process image on this device.' }
    ctx.drawImage(bitmap, 0, 0, width, height)
    bitmap.close?.()

    const blob: Blob | null = await new Promise(resolve =>
      canvas.toBlob(resolve, 'image/jpeg', quality),
    )
    if (!blob) return { ok: false, error: 'Could not process image on this device.' }

    return { ok: true, data: blob }
  } catch {
    return { ok: false, error: 'Could not read that image. Try a different photo.' }
  }
}

/**
 * Resizes, uploads to the student-photos bucket at the path shape the RLS
 * policies require (<school_id>/<student_id>/<filename> — see
 * student_photos_bucket_setup.sql), and saves the resulting **storage path**
 * (not a URL) to students.photo_url.
 *
 * Real correction made before shipping this, not glossed over: an earlier
 * draft called getPublicUrl() and stored that. getPublicUrl() only produces
 * a working URL for a *public* bucket — this bucket is public: false by
 * design (student_photos_bucket_setup.sql), so that URL would have silently
 * 400'd for every viewer, on every render, everywhere. Private buckets need
 * createSignedUrl(), which is short-lived by nature — wrong shape to persist
 * as a long-lived column value. Storing the raw path instead and resolving
 * a fresh signed URL at display time (getStudentPhotoSignedUrl, below) is
 * the correct pattern for a private bucket; every consumer (list row, Brief,
 * Info, future ID card) must call that helper rather than rendering
 * `photo_url` directly as an <img src>.
 *
 * A fixed filename (photo.jpg) is used deliberately — every re-upload for a
 * student overwrites the same object (upsert: true) rather than
 * accumulating orphaned old photos in the bucket with nothing ever cleaning
 * them up.
 */
export async function uploadStudentPhoto(params: {
  schoolId: string
  studentId: string
  file: File
}): Promise<Result<{ photo_path: string }>> {
  try {
    const resized = await resizeImageToBlob(params.file)
    if (!resized.ok) return resized

    const path = `${params.schoolId}/${params.studentId}/photo.jpg`

    const { error: uploadError } = await supabase.storage
      .from('student-photos')
      .upload(path, resized.data, {
        contentType: 'image/jpeg',
        upsert: true,
      })

    if (uploadError) {
      const msg = uploadError.message ?? ''
      if (msg.toLowerCase().includes('row-level security') || msg.toLowerCase().includes('policy')) {
        return { ok: false, error: "You don't have permission to upload a photo for this student." }
      }
      return { ok: false, error: 'Failed to upload photo. Please try again.' }
    }

    // Store the path, not a URL — see function comment above.
    const { error: dbError } = await supabase
      .from('students')
      .update({ photo_url: path })
      .eq('id', params.studentId)

    if (dbError) return { ok: false, error: friendlyError(dbError.message) }

    return { ok: true, data: { photo_path: path } }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to upload photo' }
  }
}

// In-memory cache of resolved signed URLs, keyed by storage path. Signed
// URLs are valid for SIGNED_URL_TTL_SECONDS below; re-resolving on every
// single row render (list can have 100+ students) would mean 100+ Storage
// API calls on every list load, so a short-lived cache avoids that without
// ever persisting a URL anywhere durable (React state only — cleared on
// full reload, matching this project's "no localStorage in shared logic"
// rule from §5).
const SIGNED_URL_TTL_SECONDS = 60 * 30 // 30 minutes
const signedUrlCache = new Map<string, { url: string; expiresAt: number }>()

/**
 * Resolves a student's stored photo path (students.photo_url) into a usable,
 * temporarily-valid signed URL for display. Returns null if the student has
 * no photo yet (caller should fall back to initials) or if resolution fails
 * (caller should fall back to initials rather than show a broken image).
 *
 * Cheap to call from every avatar render site — cache above absorbs repeat
 * calls for the same path within the TTL window.
 */
export async function getStudentPhotoSignedUrl(photoPath: string | null): Promise<string | null> {
  if (!photoPath) return null

  const cached = signedUrlCache.get(photoPath)
  if (cached && cached.expiresAt > Date.now()) return cached.url

  try {
    const { data, error } = await supabase.storage
      .from('student-photos')
      .createSignedUrl(photoPath, SIGNED_URL_TTL_SECONDS)

    if (error || !data?.signedUrl) return null

    signedUrlCache.set(photoPath, {
      url: data.signedUrl,
      expiresAt: Date.now() + (SIGNED_URL_TTL_SECONDS - 30) * 1000, // 30s safety margin
    })
    return data.signedUrl
  } catch {
    return null
  }
}





/**
 * Inserts a new student row.
 * school_id is required — RLS `with check` enforces it matches the caller's school.
 * status defaults to 'active' at the DB level; no need to pass it on creation.
 */
// Problem 9.8 (Tier 9) — REVISED. The previous version of this function
// inserted `students` directly, then separately called upsertPlacement()
// as a second, non-atomic client call. That shape could leave a real,
// committed, unplaced student behind if the second call failed — exactly
// the "orphaned student" defect this problem reports, just made
// survivable-and-visible rather than actually prevented. Per the owner's
// clarification (TIER_9_OWNER_REPORTED_ISSUES.md, Problem 9.8), the real
// fix is prevention at the point of creation: student + placement must
// succeed or fail together. For higher-ed schools this now calls the new
// create_placed_student() RPC (migration_session_problem_9_8.sql) — a
// single security-definer transaction, mirroring admit_student()'s own
// atomic shape. Secondary schools are unaffected: they have no placement
// concept, so they keep the original plain `students` insert unchanged.
//
// Return type reverted to the plain Result<T> shape — the prior
// function-specific CreateStudentResult existed only to carry an optional
// `warning` for the now-impossible "created but not placed" degraded
// state; with a real atomic call, createStudent() either fully succeeds
// or fully fails, so the generic Result<T> is sufficient again.
export async function createStudent(
  params: StudentUpsertParams,
  isHigherEd?: boolean,
): Promise<Result<{ id: string }>> {
  try {
    if (isHigherEd) {
      // Both-or-neither is enforced again here (not just relied on
      // server-side) so a caller bug surfaces at the call site rather than
      // as a raw Postgres exception string.
      if (Boolean(params.programme_level_id) !== Boolean(params.session_id)) {
        return { ok: false, error: 'A programme level requires a session, and vice versa.' }
      }
      const { data, error } = await supabase.rpc('create_placed_student', {
        p_school_id:                params.schoolId,
        p_full_name:                params.full_name.trim(),
        p_date_of_birth:            params.date_of_birth || null,
        p_gender:                   params.gender || null,
        p_admission_date:           params.admission_date || null,
        p_student_code:             params.student_code || null,
        p_blood_group:               params.blood_group || null,
        p_address:                   params.address || null,
        p_medical_notes:             params.medical_notes || null,
        p_emergency_contact_name:    params.emergency_contact_name || null,
        p_emergency_contact_phone:   params.emergency_contact_phone || null,
        p_hobbies:                   params.hobbies || null,
        p_email:                     params.email || null,
        p_phone:                     params.phone || null,
        p_programme_level_id:        params.programme_level_id || null,
        p_session_id:                params.session_id || null,
      })
      if (error) return { ok: false, error: friendlyError(error.message) }
      // Postgres RETURNS TABLE functions come back as an array of rows via
      // .rpc() — exactly one row here since create_placed_student() either
      // returns one row or raises (same convention as admissionService.ts's
      // admitStudent()).
      const row = Array.isArray(data) ? data[0] : data
      if (!row?.student_id) return { ok: false, error: 'Student creation did not return a result.' }
      return { ok: true, data: { id: row.student_id } }
    }

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
 *
 * `note` (migration_attendance_auto_deactivation.sql, owner decision):
 * required when reactivating (status: 'active') — enforced here, not just
 * in the UI, since this is the one function every reactivation path (manual
 * or previously auto-deactivated) goes through. Optional for 'inactive'/
 * 'alumni'. Stored in the generic status_change_note column rather than a
 * reactivation-specific one, so any future status-change flow can reuse it.
 *
 * Reactivating also resets both attendance-deactivation counters and clears
 * deactivation_reason, regardless of whether this particular student was
 * ever auto-deactivated — otherwise a student reactivated today could be
 * auto-deactivated again on their very next absence, which would look like
 * a bug to staff even though the raw numbers would technically justify it.
 */
export async function updateStudentStatus(
  studentId: string,
  status: 'active' | 'inactive' | 'alumni',
  note?: string,
): Promise<Result<void>> {
  const trimmedNote = note?.trim() || null

  if (status === 'active' && !trimmedNote) {
    return { ok: false, error: 'A note is required to reactivate a student.' }
  }

  try {
    const updates: Record<string, unknown> = { status, status_change_note: trimmedNote }

    if (status === 'active') {
      updates.consecutive_absent_count = 0
      updates.cumulative_absent_count = 0
      updates.last_absent_date = null
      updates.deactivation_reason = null
      // Absences on or before today never count again for this student.
      // Without this baseline, the DB trigger re-derives both counters from
      // the old attendance rows on the next attendance write and the
      // student is deactivated again immediately. Counting restarts from
      // the next calendar day (school's local date, not UTC).
      const d = new Date()
      d.setDate(d.getDate() + 1)
      updates.attendance_count_start = [
        d.getFullYear(),
        String(d.getMonth() + 1).padStart(2, '0'),
        String(d.getDate()).padStart(2, '0'),
      ].join('-')
    }

    const { error } = await supabase
      .from('students')
      .update(updates)
      .eq('id', studentId)

    if (error) return { ok: false, error: friendlyStatusError(error.message) }
    return { ok: true, data: undefined }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to update student status' }
  }
}

// ─── Attendance auto-deactivation (migration_attendance_auto_deactivation.sql) ─
//
// See that migration's header comment for the full rule set. Summary:
// client-triggered (no server cron), gated on students.records.manage (the
// same permission updateStudentStatus() already requires via RLS), and only
// acts on a school day once that day's school hours have actually ended.

export interface AttendanceDeactivationCandidate {
  student_id: string
  full_name: string
  count: number       // whichever counter (consecutive or cumulative) is live
}

export interface AttendanceDeactivationCheckResult {
  deactivated: AttendanceDeactivationCandidate[]
}

/**
 * Sets one student to inactive specifically for the attendance rule —
 * distinct from updateStudentStatus() because this is a system decision,
 * not a staff member choosing a status in a form: it tags
 * deactivation_reason so the Students list can badge it, and deliberately
 * does NOT accept or require a note (there's no human to write one at the
 * moment this fires — the note requirement is reactivation's, not this
 * function's).
 */
async function autoDeactivateForAttendance(studentId: string): Promise<Result<void>> {
  try {
    const { error } = await supabase
      .from('students')
      .update({ status: 'inactive', deactivation_reason: 'attendance_auto' })
      .eq('id', studentId)

    if (error) return { ok: false, error: friendlyStatusError(error.message) }
    return { ok: true, data: undefined }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to auto-deactivate student' }
  }
}

/**
 * Runs the "looks automatic" check: finds every active student in this
 * school whose live counter (consecutive or cumulative, per the setting's
 * mode) has reached the configured threshold, and — only for students whose
 * qualifying school day has actually elapsed — sets them to inactive.
 *
 * Call this from a screen only staff with students.records.manage actually
 * reach (StudentsModule.tsx on load), not from the Attendance-marking
 * screen: a teacher with only academics.attendance.mark would have this
 * silently do nothing useful, since the deactivation write below goes
 * through the same RLS as a manual status change and would simply fail for
 * that role. Returns an empty `deactivated` array (not an error) when the
 * setting is off, unconfigured, or nothing currently qualifies — all normal,
 * common states, not failures.
 *
 * "Elapsed" is checked via last_absent_date + attendanceService.ts's own
 * getSchoolHoursEndMoment()/isWithinEditWindow() — the same after-hours
 * lock the register itself uses — so a student isn't deactivated mid-day
 * before staff have had the rest of that day to correct a mis-tap.
 */
export async function runAttendanceAutoDeactivationCheck(
  schoolId: string,
): Promise<Result<AttendanceDeactivationCheckResult>> {
  try {
    const { data: settings, error: settingsError } = await supabase
      .from('attendance_deactivation_settings')
      .select('enabled, mode, consecutive_threshold, cumulative_threshold')
      .eq('school_id', schoolId)
      .maybeSingle()

    if (settingsError) return { ok: false, error: settingsError.message }
    if (!settings || !settings.enabled) return { ok: true, data: { deactivated: [] } }

    const isConsecutive = settings.mode === 'consecutive'
    const counterColumn = isConsecutive ? 'consecutive_absent_count' : 'cumulative_absent_count'
    const threshold = isConsecutive ? settings.consecutive_threshold : settings.cumulative_threshold

    const { data: candidates, error: candidatesError } = await supabase
      .from('students')
      .select('id, full_name, last_absent_date, consecutive_absent_count, cumulative_absent_count')
      .eq('school_id', schoolId)
      .eq('status', 'active')
      .is('deactivation_reason', null)
      .gte(counterColumn, threshold)

    if (candidatesError) return { ok: false, error: candidatesError.message }
    if (!candidates || candidates.length === 0) return { ok: true, data: { deactivated: [] } }

    const deactivated: AttendanceDeactivationCandidate[] = []

    for (const c of candidates) {
      const lastAbsentDate = c.last_absent_date as string | null
      if (!lastAbsentDate) continue // shouldn't happen if a counter is >= threshold, but fails safe

      const hoursEndRes = await getSchoolHoursEndMoment(lastAbsentDate, schoolId)
      if (!hoursEndRes.ok) continue // skip this student rather than fail the whole check

      // Still within the qualifying day's edit window -> that day hasn't
      // elapsed yet. Wait for a later run rather than acting mid-day.
      if (isWithinEditWindow(hoursEndRes.data)) continue

      const count = isConsecutive
        ? (c.consecutive_absent_count as number)
        : (c.cumulative_absent_count as number)

      const res = await autoDeactivateForAttendance(c.id as string)
      if (res.ok) {
        deactivated.push({ student_id: c.id as string, full_name: c.full_name as string, count })
      }
      // A single failed write (e.g. a rare race) doesn't abort the rest —
      // every other qualifying student is still worth checking this run.
    }

    return { ok: true, data: { deactivated } }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to run attendance auto-deactivation check' }
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
