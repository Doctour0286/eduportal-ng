/**
 * schemeOfWorkService.ts
 * Data access layer for the Scheme of Work module.
 * No browser-only APIs. No UI imports. React Native compatible.
 *
 * Read exports:
 *   loadMySchemes()           — teacher's own schemes (current session)
 *   loadAllSchemes()          — admin/HOD: all schemes for the school (filtered)
 *   loadSchemeDetail()        — single scheme with its weeks
 *   loadCurriculumTemplates() — platform-level templates for adoption
 *   getSowSummary()           — dashboard summary stats
 *
 * Write exports:
 *   createScheme()            — create a new scheme (draft)
 *   updateScheme()            — edit scheme metadata
 *   saveSchemeWeeks()         — replace all weeks for a scheme (full overwrite)
 *   submitScheme()            — draft → submitted
 *   approveScheme()           — submitted → approved
 *   returnScheme()            — submitted → returned (with note)
 *   importFromTemplate()      — adopt a curriculum template as weeks
 *
 * Privacy: teachers see only their own schemes via RLS.
 * Admins see all schemes (RLS + view_all permission).
 */

import { supabase } from '../lib/supabase'

// ─── Types ──────────────────────────────────────────────────────────────────

export type SchemeStatus = 'draft' | 'submitted' | 'approved' | 'returned'
export type CoverageStatus = 'planned' | 'in_progress' | 'completed' | 'not_covered'

interface Ok<T> { ok: true; data: T }
interface Err   { ok: false; error: string }
type Result<T> = Ok<T> | Err

export interface SchemeOfWork {
  id: string
  school_id: string
  teaching_assignment_id: string
  session_id: string
  term_id: string
  status: SchemeStatus
  reviewed_by: string | null
  reviewed_at: string | null
  review_note: string | null
  created_by: string | null
  created_at: string
  updated_at: string
  // Joined fields
  subject_name?: string
  class_name?: string
  teacher_name?: string
  session_name?: string
  term_name?: string
}

export interface SchemeWeek {
  id: string
  scheme_of_work_id: string
  school_id: string
  week_number: number
  topic: string
  objectives: string | null
  activities: string | null
  resources: string | null
  coverage_status: CoverageStatus
  coverage_note: string | null
  created_at: string
  updated_at: string
}

export interface SchemeDetail extends SchemeOfWork {
  weeks: SchemeWeek[]
}

export interface CurriculumTemplate {
  id: string
  board_name: string
  subject_name: string
  level: string
  term: string
  week_number: number
  topic: string
  objectives: string | null
  activities: string | null
  resources: string | null
}

export interface SowSummary {
  totalSchemes: number
  draftCount: number
  submittedCount: number
  approvedCount: number
  returnedCount: number
}

// ─── Read functions ─────────────────────────────────────────────────────────

/**
 * Load the current teacher's own schemes for the current session.
 * Used by teacher-facing SchemeOfWorkModule.
 */
export async function loadMySchemes(
  _staffId: string,
  sessionId: string,
): Promise<Result<SchemeOfWork[]>> {
  try {
    const { data, error } = await supabase
      .from('schemes_of_work')
      .select(`
        id, school_id, teaching_assignment_id, session_id, term_id,
        status, reviewed_by, reviewed_at, review_note,
        created_by, created_at, updated_at,
        teaching_assignments (
          subjects ( name ),
          class_nodes ( name )
        ),
        terms ( name ),
        sessions ( name )
      `)
      .eq('session_id', sessionId)
      .order('created_at', { ascending: false })

    if (error) return { ok: false, error: error.message }

    const schemes: SchemeOfWork[] = (data ?? []).map((r: any) => ({
      id: r.id,
      school_id: r.school_id,
      teaching_assignment_id: r.teaching_assignment_id,
      session_id: r.session_id,
      term_id: r.term_id,
      status: r.status,
      reviewed_by: r.reviewed_by,
      reviewed_at: r.reviewed_at,
      review_note: r.review_note,
      created_by: r.created_by,
      created_at: r.created_at,
      updated_at: r.updated_at,
      subject_name: r.teaching_assignments?.subjects?.name ?? null,
      class_name: r.teaching_assignments?.class_nodes?.name ?? null,
      term_name: r.terms?.name ?? null,
      session_name: r.sessions?.name ?? null,
    }))

    return { ok: true, data: schemes }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load schemes' }
  }
}

/**
 * Load all schemes for the school (admin/HOD view).
 * Supports filtering by status.
 */
export async function loadAllSchemes(params: {
  sessionId: string
  status?: SchemeStatus
}): Promise<Result<SchemeOfWork[]>> {
  try {
    let query = supabase
      .from('schemes_of_work')
      .select(`
        id, school_id, teaching_assignment_id, session_id, term_id,
        status, reviewed_by, reviewed_at, review_note,
        created_by, created_at, updated_at,
        teaching_assignments (
          staff_id,
          staff ( full_name ),
          subjects ( name ),
          class_nodes ( name )
        ),
        terms ( name ),
        sessions ( name )
      `)
      .eq('session_id', params.sessionId)
      .order('created_at', { ascending: false })

    if (params.status) {
      query = query.eq('status', params.status)
    }

    const { data, error } = await query
    if (error) return { ok: false, error: error.message }

    const schemes: SchemeOfWork[] = (data ?? []).map((r: any) => ({
      id: r.id,
      school_id: r.school_id,
      teaching_assignment_id: r.teaching_assignment_id,
      session_id: r.session_id,
      term_id: r.term_id,
      status: r.status,
      reviewed_by: r.reviewed_by,
      reviewed_at: r.reviewed_at,
      review_note: r.review_note,
      created_by: r.created_by,
      created_at: r.created_at,
      updated_at: r.updated_at,
      subject_name: r.teaching_assignments?.subjects?.name ?? null,
      class_name: r.teaching_assignments?.class_nodes?.name ?? null,
      teacher_name: r.teaching_assignments?.staff?.full_name ?? null,
      term_name: r.terms?.name ?? null,
      session_name: r.sessions?.name ?? null,
    }))

    return { ok: true, data: schemes }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load schemes' }
  }
}

/**
 * Load a single scheme with its weeks.
 */
export async function loadSchemeDetail(schemeId: string): Promise<Result<SchemeDetail>> {
  try {
    const { data: scheme, error: schemeErr } = await supabase
      .from('schemes_of_work')
      .select(`
        id, school_id, teaching_assignment_id, session_id, term_id,
        status, reviewed_by, reviewed_at, review_note,
        created_by, created_at, updated_at,
        teaching_assignments (
          staff_id,
          staff ( full_name ),
          subjects ( name ),
          class_nodes ( name )
        ),
        terms ( name ),
        sessions ( name )
      `)
      .eq('id', schemeId)
      .single()

    if (schemeErr) return { ok: false, error: schemeErr.message }
    if (!scheme) return { ok: false, error: 'Scheme not found' }

    const { data: weeks, error: weeksErr } = await supabase
      .from('scheme_of_work_weeks')
      .select('*')
      .eq('scheme_of_work_id', schemeId)
      .order('week_number', { ascending: true })

    if (weeksErr) return { ok: false, error: weeksErr.message }

    const r = scheme as any
    const detail: SchemeDetail = {
      id: r.id,
      school_id: r.school_id,
      teaching_assignment_id: r.teaching_assignment_id,
      session_id: r.session_id,
      term_id: r.term_id,
      status: r.status,
      reviewed_by: r.reviewed_by,
      reviewed_at: r.reviewed_at,
      review_note: r.review_note,
      created_by: r.created_by,
      created_at: r.created_at,
      updated_at: r.updated_at,
      subject_name: r.teaching_assignments?.subjects?.name ?? null,
      class_name: r.teaching_assignments?.class_nodes?.name ?? null,
      teacher_name: r.teaching_assignments?.staff?.full_name ?? null,
      term_name: r.terms?.name ?? null,
      session_name: r.sessions?.name ?? null,
      weeks: (weeks ?? []).map((w: any) => ({
        id: w.id,
        scheme_of_work_id: w.scheme_of_work_id,
        school_id: w.school_id,
        week_number: w.week_number,
        topic: w.topic,
        objectives: w.objectives,
        activities: w.activities,
        resources: w.resources,
        coverage_status: w.coverage_status,
        coverage_note: w.coverage_note,
        created_at: w.created_at,
        updated_at: w.updated_at,
      })),
    }

    return { ok: true, data: detail }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load scheme detail' }
  }
}

/**
 * Load curriculum templates, optionally filtered by subject/level/term.
 */
export async function loadCurriculumTemplates(params?: {
  subjectName?: string
  level?: string
  term?: string
}): Promise<Result<CurriculumTemplate[]>> {
  try {
    let query = supabase
      .from('curriculum_templates')
      .select('*')
      .order('week_number', { ascending: true })

    if (params?.subjectName) query = query.eq('subject_name', params.subjectName)
    if (params?.level) query = query.eq('level', params.level)
    if (params?.term) query = query.eq('term', params.term)

    const { data, error } = await query
    if (error) return { ok: false, error: error.message }

    const templates: CurriculumTemplate[] = (data ?? []).map((r: any) => ({
      id: r.id,
      board_name: r.board_name,
      subject_name: r.subject_name,
      level: r.level,
      term: r.term,
      week_number: r.week_number,
      topic: r.topic,
      objectives: r.objectives,
      activities: r.activities,
      resources: r.resources,
    }))

    return { ok: true, data: templates }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load templates' }
  }
}

/**
 * Dashboard summary: counts by status for the current session.
 */
export async function getSowSummary(sessionId: string): Promise<Result<SowSummary>> {
  try {
    const { data, error } = await supabase
      .from('schemes_of_work')
      .select('status')
      .eq('session_id', sessionId)

    if (error) return { ok: false, error: error.message }

    const rows = data ?? []
    const summary: SowSummary = {
      totalSchemes: rows.length,
      draftCount: rows.filter((r: any) => r.status === 'draft').length,
      submittedCount: rows.filter((r: any) => r.status === 'submitted').length,
      approvedCount: rows.filter((r: any) => r.status === 'approved').length,
      returnedCount: rows.filter((r: any) => r.status === 'returned').length,
    }

    return { ok: true, data: summary }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load summary' }
  }
}

// ─── Write functions ────────────────────────────────────────────────────────

/**
 * Create a new scheme of work (draft status).
 * Returns the new scheme's id.
 */
export async function createScheme(params: {
  schoolId: string
  teachingAssignmentId: string
  sessionId: string
  termId: string
  userId: string
}): Promise<Result<{ id: string }>> {
  try {
    const { data, error } = await supabase
      .from('schemes_of_work')
      .insert({
        school_id: params.schoolId,
        teaching_assignment_id: params.teachingAssignmentId,
        session_id: params.sessionId,
        term_id: params.termId,
        status: 'draft',
        created_by: params.userId,
      })
      .select('id')
      .single()

    if (error) return { ok: false, error: error.message }
    return { ok: true, data: { id: data.id } }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to create scheme' }
  }
}

/**
 * Update scheme metadata (status cannot be changed here — use submit/approve/return).
 */
export async function updateScheme(
  schemeId: string,
  updates: Partial<Pick<SchemeOfWork, 'teaching_assignment_id' | 'term_id'>>,
): Promise<Result<void>> {
  try {
    const { error } = await supabase
      .from('schemes_of_work')
      .update(updates)
      .eq('id', schemeId)

    if (error) return { ok: false, error: error.message }
    return { ok: true, data: undefined }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to update scheme' }
  }
}

/**
 * Replace all weeks for a scheme (full overwrite).
 * Deletes existing weeks, inserts new ones.
 */
export async function saveSchemeWeeks(
  schemeId: string,
  schoolId: string,
  weeks: Omit<SchemeWeek, 'id' | 'scheme_of_work_id' | 'school_id' | 'created_at' | 'updated_at'>[],
): Promise<Result<void>> {
  try {
    // Delete existing weeks
    const { error: delErr } = await supabase
      .from('scheme_of_work_weeks')
      .delete()
      .eq('scheme_of_work_id', schemeId)

    if (delErr) return { ok: false, error: delErr.message }

    if (weeks.length === 0) return { ok: true, data: undefined }

    // Insert new weeks
    const rows = weeks.map(w => ({
      scheme_of_work_id: schemeId,
      school_id: schoolId,
      week_number: w.week_number,
      topic: w.topic,
      objectives: w.objectives,
      activities: w.activities,
      resources: w.resources,
      coverage_status: w.coverage_status,
      coverage_note: w.coverage_note,
    }))

    const { error: insErr } = await supabase
      .from('scheme_of_work_weeks')
      .insert(rows)

    if (insErr) return { ok: false, error: insErr.message }
    return { ok: true, data: undefined }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to save weeks' }
  }
}

/**
 * Submit a scheme: draft → submitted.
 */
export async function submitScheme(schemeId: string): Promise<Result<void>> {
  try {
    const { error } = await supabase
      .from('schemes_of_work')
      .update({ status: 'submitted' })
      .eq('id', schemeId)
      .eq('status', 'draft')

    if (error) return { ok: false, error: error.message }
    return { ok: true, data: undefined }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to submit scheme' }
  }
}

/**
 * Approve a scheme: submitted → approved.
 */
export async function approveScheme(
  schemeId: string,
  reviewerStaffId: string,
): Promise<Result<void>> {
  try {
    const { error } = await supabase
      .from('schemes_of_work')
      .update({
        status: 'approved',
        reviewed_by: reviewerStaffId,
        reviewed_at: new Date().toISOString(),
        review_note: null,
      })
      .eq('id', schemeId)
      .eq('status', 'submitted')

    if (error) return { ok: false, error: error.message }
    return { ok: true, data: undefined }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to approve scheme' }
  }
}

/**
 * Return a scheme: submitted → returned (with note).
 */
export async function returnScheme(
  schemeId: string,
  reviewerStaffId: string,
  note: string,
): Promise<Result<void>> {
  try {
    const { error } = await supabase
      .from('schemes_of_work')
      .update({
        status: 'returned',
        reviewed_by: reviewerStaffId,
        reviewed_at: new Date().toISOString(),
        review_note: note,
      })
      .eq('id', schemeId)
      .eq('status', 'submitted')

    if (error) return { ok: false, error: error.message }
    return { ok: true, data: undefined }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to return scheme' }
  }
}

/**
 * Import weeks from a curriculum template into a scheme.
 * Fetches template rows and writes them as scheme weeks.
 */
export async function importFromTemplate(
  schemeId: string,
  schoolId: string,
  templateFilter: { subject_name: string; level: string; term: string; board_name: string },
): Promise<Result<number>> {
  try {
    // Load template rows
    const { data: templates, error: tplErr } = await supabase
      .from('curriculum_templates')
      .select('*')
      .eq('subject_name', templateFilter.subject_name)
      .eq('level', templateFilter.level)
      .eq('term', templateFilter.term)
      .eq('board_name', templateFilter.board_name)
      .order('week_number', { ascending: true })

    if (tplErr) return { ok: false, error: tplErr.message }
    if (!templates || templates.length === 0) {
      return { ok: false, error: 'No template found for the selected filters' }
    }

    // Delete existing weeks first
    const { error: delErr } = await supabase
      .from('scheme_of_work_weeks')
      .delete()
      .eq('scheme_of_work_id', schemeId)

    if (delErr) return { ok: false, error: delErr.message }

    // Insert template rows as scheme weeks
    const rows = templates.map((t: any) => ({
      scheme_of_work_id: schemeId,
      school_id: schoolId,
      week_number: t.week_number,
      topic: t.topic,
      objectives: t.objectives,
      activities: t.activities,
      resources: t.resources,
      coverage_status: 'planned' as CoverageStatus,
    }))

    const { error: insErr } = await supabase
      .from('scheme_of_work_weeks')
      .insert(rows)

    if (insErr) return { ok: false, error: insErr.message }
    return { ok: true, data: templates.length }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to import template' }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export function todayDateString(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
