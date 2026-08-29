/**
 * schemeOfWorkService.ts
 * Data access layer for the Scheme of Work module.
 * No browser-only APIs. No UI imports. React Native compatible.
 *
 * Core concept: Weeks are derived from the timetable + term dates.
 * Given a teaching_assignment_id, the system finds all periods when that
 * subject is taught, maps them to calendar dates, and groups into weeks.
 *
 * Read exports:
 *   loadMySchemes()            — teacher's own schemes (current session)
 *   loadAllSchemes()           — admin/HOD: all schemes for the school
 *   loadSchemeDetail()         — single scheme with its timetable-derived weeks
 *   loadCurriculumTemplates()  — platform-level templates for adoption
 *   getSowSummary()            — dashboard summary stats
 *   loadCurrentTerm()          — current term for the school
 *   loadTeacherAssignments()   — teacher's teaching assignments for picker
 *   generateWeeksFromTimetable() — derive week slots from timetable + term
 *
 * Write exports:
 *   createScheme()             — create a new scheme (draft)
 *   saveSchemeWeeks()          — save topics into timetable-derived week slots
 *   submitScheme()             — draft → submitted
 *   approveScheme()            — submitted → approved
 *   returnScheme()             — submitted → returned (with note)
 *   importFromTemplate()       — adopt a curriculum template as week topics
 *   markWeekCoverage()         — update a week's coverage status
 *
 * Privacy: teachers see only their own schemes via RLS.
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
  term_id: string | null
  status: SchemeStatus
  reviewed_by: string | null
  reviewed_at: string | null
  review_note: string | null
  created_by: string | null
  created_at: string
  updated_at: string
  subject_name?: string
  class_name?: string
  teacher_name?: string
  session_name?: string
  term_name?: string
  week_count?: number
  completed_count?: number
}

/** A week slot derived from the timetable — represents one calendar week. */
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
  // Timetable-derived fields (not in DB, computed at load time)
  week_start_date?: string    // 'YYYY-MM-DD' — Monday of this week
  week_end_date?: string      // 'YYYY-MM-DD' — Friday of this week
  lesson_dates?: string[]     // Specific dates when this subject is taught
  period_label?: string       // e.g. "Period 2"
  period_time?: string        // e.g. "10:00 - 10:40"
}

export interface SchemeDetail extends SchemeOfWork {
  weeks: SchemeWeek[]
  timetable_slots?: TimetableSlot[]
}

/** A raw timetable slot for a teaching assignment. */
export interface TimetableSlot {
  id: string
  day_of_week: number
  period_id: string
  period_label: string
  period_start: string
  period_end: string
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

export interface CurrentTerm {
  id: string
  name: string
  startDate: string
  endDate: string
}

export interface TeachingAssignmentOption {
  id: string
  subjectName: string
  className: string
  sessionName: string
}

// ─── Timetable-to-Weeks Mapping ─────────────────────────────────────────────

/** Build all dates in a range. */
function buildDateRange(startDate: string, endDate: string): string[] {
  const dates: string[] = []
  const d = new Date(startDate + 'T00:00:00')
  const end = new Date(endDate + 'T00:00:00')
  while (d <= end) {
    dates.push(d.toISOString().slice(0, 10))
    d.setDate(d.getDate() + 1)
  }
  return dates
}

/** Get the Monday of the week containing a date. */
function getWeekStart(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00')
  const day = d.getDay()
  const diff = day === 0 ? -6 : 1 - day // Monday = 1
  d.setDate(d.getDate() + diff)
  return d.toISOString().slice(0, 10)
}

/** Get the Friday of the week containing a date. */
function getWeekEnd(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00')
  const day = d.getDay()
  const diff = day === 0 ? -6 : 1 - day
  d.setDate(d.getDate() + diff + 4)
  return d.toISOString().slice(0, 10)
}

/**
 * Generate week slots from timetable entries + term dates.
 * Each "week" is a calendar week (Mon-Fri) containing the specific dates
 * when this subject is taught.
 */
export function generateWeeksFromTimetable(params: {
  slots: TimetableSlot[]
  termStart: string
  termEnd: string
}): { week_number: number; week_start_date: string; week_end_date: string; lesson_dates: string[]; period_label: string; period_time: string }[] {
  const { slots, termStart, termEnd } = params
  if (slots.length === 0) return []

  const dateRange = buildDateRange(termStart, termEnd)

  // Build day_of_week → [dates]
  const datesByDow = new Map<number, string[]>()
  for (const d of dateRange) {
    const dow = new Date(d + 'T00:00:00').getDay()
    if (!datesByDow.has(dow)) datesByDow.set(dow, [])
    datesByDow.get(dow)!.push(d)
  }

  // For each slot, find matching dates
  const lessonsByDate = new Map<string, { periodLabel: string; periodTime: string }[]>()
  for (const slot of slots) {
    const dates = datesByDow.get(slot.day_of_week) ?? []
    for (const date of dates) {
      if (!lessonsByDate.has(date)) lessonsByDate.set(date, [])
      lessonsByDate.get(date)!.push({
        periodLabel: slot.period_label,
        periodTime: `${slot.period_start?.slice(0, 5)} - ${slot.period_end?.slice(0, 5)}`,
      })
    }
  }

  // Group by calendar week (Monday-based)
  const weeksMap = new Map<string, { lesson_dates: string[]; period_label: string; period_time: string }>()
  for (const [date, lessons] of lessonsByDate) {
    const weekStart = getWeekStart(date)
    if (!weeksMap.has(weekStart)) {
      weeksMap.set(weekStart, {
        lesson_dates: [],
        period_label: lessons[0]?.periodLabel ?? '',
        period_time: lessons[0]?.periodTime ?? '',
      })
    }
    const week = weeksMap.get(weekStart)!
    week.lesson_dates.push(date)
  }

  // Sort by week_start_date and assign week numbers
  const sortedWeeks = [...weeksMap.entries()].sort(([a], [b]) => a.localeCompare(b))
  return sortedWeeks.map(([weekStart, data], idx) => ({
    week_number: idx + 1,
    week_start_date: weekStart,
    week_end_date: getWeekEnd(weekStart),
    lesson_dates: data.lesson_dates.sort(),
    period_label: data.period_label,
    period_time: data.period_time,
  }))
}

// ─── Read functions ─────────────────────────────────────────────────────────

export async function loadCurrentTerm(sessionId: string): Promise<Result<CurrentTerm | null>> {
  try {
    const today = new Date().toISOString().slice(0, 10)
    const { data, error } = await supabase
      .from('terms')
      .select('id, name, start_date, end_date')
      .eq('session_id', sessionId)
      .lte('start_date', today)
      .gte('end_date', today)
      .maybeSingle()

    if (error) return { ok: false, error: error.message }
    if (!data) return { ok: true, data: null }
    return { ok: true, data: { id: data.id, name: data.name, startDate: data.start_date, endDate: data.end_date } }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load current term' }
  }
}

export async function loadTeacherAssignments(
  staffId: string,
  sessionId: string,
): Promise<Result<TeachingAssignmentOption[]>> {
  try {
    const { data, error } = await supabase
      .from('teaching_assignments')
      .select(`id, subjects ( name ), class_nodes ( name ), sessions ( name )`)
      .eq('staff_id', staffId)
      .eq('session_id', sessionId)

    if (error) return { ok: false, error: error.message }
    const options: TeachingAssignmentOption[] = (data ?? []).map((r: any) => ({
      id: r.id,
      subjectName: r.subjects?.name ?? 'Unknown Subject',
      className: r.class_nodes?.name ?? 'Unknown Class',
      sessionName: r.sessions?.name ?? '',
    }))
    return { ok: true, data: options }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load assignments' }
  }
}

/** Load ALL teaching assignments for the school (admin import flow). */
export async function loadAllTeachingAssignments(
  sessionId: string,
): Promise<Result<TeachingAssignmentOption[]>> {
  try {
    const { data, error } = await supabase
      .from('teaching_assignments')
      .select(`id, subjects ( name ), class_nodes ( name ), sessions ( name )`)
      .eq('session_id', sessionId)

    if (error) return { ok: false, error: error.message }
    const options: TeachingAssignmentOption[] = (data ?? []).map((r: any) => ({
      id: r.id,
      subjectName: r.subjects?.name ?? 'Unknown Subject',
      className: r.class_nodes?.name ?? 'Unknown Class',
      sessionName: r.sessions?.name ?? '',
    }))
    return { ok: true, data: options }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load all assignments' }
  }
}

/** Load timetable slots for a teaching assignment (day_of_week + period info). */
export async function loadTimetableSlots(
  sessionId: string,
  teachingAssignmentId: string,
): Promise<Result<TimetableSlot[]>> {
  try {
    const { data, error } = await supabase
      .from('timetable_entries')
      .select(`id, day_of_week, period_id, periods ( label, start_time, end_time )`)
      .eq('session_id', sessionId)
      .eq('teaching_assignment_id', teachingAssignmentId)

    if (error) return { ok: false, error: error.message }
    const slots: TimetableSlot[] = (data ?? []).map((r: any) => ({
      id: r.id,
      day_of_week: r.day_of_week,
      period_id: r.period_id,
      period_label: r.periods?.label ?? '',
      period_start: r.periods?.start_time ?? '',
      period_end: r.periods?.end_time ?? '',
    }))
    return { ok: true, data: slots }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load timetable slots' }
  }
}

export async function loadMySchemes(sessionId: string): Promise<Result<SchemeOfWork[]>> {
  try {
    const { data, error } = await supabase
      .from('schemes_of_work')
      .select(`
        id, school_id, teaching_assignment_id, session_id, term_id,
        status, reviewed_by, reviewed_at, review_note,
        created_by, created_at, updated_at,
        teaching_assignments ( subjects ( name ), class_nodes ( name ) ),
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
          staff_id, staff ( full_name ),
          subjects ( name ), class_nodes ( name )
        ),
        terms ( name ), sessions ( name )
      `)
      .eq('session_id', params.sessionId)
      .order('created_at', { ascending: false })

    if (params.status) query = query.eq('status', params.status)
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

export async function loadSchemeDetail(schemeId: string): Promise<Result<SchemeDetail>> {
  try {
    const { data: scheme, error: schemeErr } = await supabase
      .from('schemes_of_work')
      .select(`
        id, school_id, teaching_assignment_id, session_id, term_id,
        status, reviewed_by, reviewed_at, review_note,
        created_by, created_at, updated_at,
        teaching_assignments (
          staff_id, staff ( full_name ),
          subjects ( name ), class_nodes ( name )
        ),
        terms ( name, start_date, end_date ),
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
    const termStartDate = r.terms?.start_date
    const termEndDate = r.terms?.end_date

    // Load timetable slots to compute date info for each week
    let timetableSlots: TimetableSlot[] = []
    if (termStartDate && termEndDate) {
      const slotsRes = await loadTimetableSlots(r.session_id, r.teaching_assignment_id)
      if (slotsRes.ok) timetableSlots = slotsRes.data
    }

    // Compute timetable-derived weeks ONCE, then look up per-week
    let generatedFromTimetable: ReturnType<typeof generateWeeksFromTimetable> = []
    if (termStartDate && termEndDate && timetableSlots.length > 0) {
      generatedFromTimetable = generateWeeksFromTimetable({
        slots: timetableSlots,
        termStart: termStartDate,
        termEnd: termEndDate,
      })
    }

    // Compute date info for each stored week
    const computedWeeks: SchemeWeek[] = (weeks ?? []).map((w: any) => {
      const week: SchemeWeek = {
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
      }

      // Look up date info from pre-computed timetable mapping
      if (generatedFromTimetable.length > 0) {
        const match = generatedFromTimetable.find(g => g.week_number === w.week_number)
        if (match) {
          week.week_start_date = match.week_start_date
          week.week_end_date = match.week_end_date
          week.lesson_dates = match.lesson_dates
          week.period_label = match.period_label
          week.period_time = match.period_time
        }
      }

      return week
    })

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
      weeks: computedWeeks,
      timetable_slots: timetableSlots,
    }

    return { ok: true, data: detail }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load scheme detail' }
  }
}

export async function loadCurriculumTemplates(params?: {
  boardName?: string
  subjectName?: string
  level?: string
  term?: string
}): Promise<Result<CurriculumTemplate[]>> {
  try {
    let query = supabase.from('curriculum_templates').select('*').order('week_number', { ascending: true })
    if (params?.boardName) query = query.eq('board_name', params.boardName)
    if (params?.subjectName) query = query.eq('subject_name', params.subjectName)
    if (params?.level) query = query.eq('level', params.level)
    if (params?.term) query = query.eq('term', params.term)
    const { data, error } = await query
    if (error) return { ok: false, error: error.message }
    const templates: CurriculumTemplate[] = (data ?? []).map((r: any) => ({
      id: r.id, board_name: r.board_name, subject_name: r.subject_name,
      level: r.level, term: r.term, week_number: r.week_number,
      topic: r.topic, objectives: r.objectives, activities: r.activities, resources: r.resources,
    }))
    return { ok: true, data: templates }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load templates' }
  }
}

/** Load distinct board/subject/level/term combos for cascading dropdowns. */
export interface CurriculumMetadata {
  board_name: string
  subject_name: string
  level: string
  term: string
}

export async function loadCurriculumMetadata(): Promise<Result<CurriculumMetadata[]>> {
  try {
    const { data, error } = await supabase
      .from('curriculum_templates')
      .select('board_name, subject_name, level, term')
      .order('board_name', { ascending: true })
    if (error) return { ok: false, error: error.message }
    const seen = new Set<string>()
    const meta: CurriculumMetadata[] = []
    for (const r of data ?? []) {
      const key = `${r.board_name}|${r.subject_name}|${r.level}|${r.term}`
      if (seen.has(key)) continue
      seen.add(key)
      meta.push({ board_name: r.board_name, subject_name: r.subject_name, level: r.level, term: r.term })
    }
    return { ok: true, data: meta }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load curriculum metadata' }
  }
}

/** Delete all template rows for a given board/subject/level/term combination. */
export async function deleteCurriculumTemplate(
  boardName: string, subjectName: string, level: string, term: string,
): Promise<Result<void>> {
  try {
    const { error } = await supabase.from('curriculum_templates')
      .delete()
      .eq('board_name', boardName)
      .eq('subject_name', subjectName)
      .eq('level', level)
      .eq('term', term)
    if (error) return { ok: false, error: error.message }
    return { ok: true, data: undefined }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to delete template' }
  }
}

/** Load all templates grouped for admin management view. */
export interface CurriculumTemplateSet {
  board_name: string
  subject_name: string
  level: string
  term: string
  week_count: number
}

export async function loadAllTemplateSets(): Promise<Result<CurriculumTemplateSet[]>> {
  try {
    const { data, error } = await supabase
      .from('curriculum_templates')
      .select('board_name, subject_name, level, term')
      .order('board_name', { ascending: true })
    if (error) return { ok: false, error: error.message }
    const map = new Map<string, CurriculumTemplateSet>()
    for (const r of data ?? []) {
      const key = `${r.board_name}|${r.subject_name}|${r.level}|${r.term}`
      if (!map.has(key)) {
        map.set(key, { board_name: r.board_name, subject_name: r.subject_name, level: r.level, term: r.term, week_count: 0 })
      }
      map.get(key)!.week_count++
    }
    return { ok: true, data: [...map.values()] }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load template sets' }
  }
}

/** Get unique class names from a list of teaching assignments. */
export function getUniqueClasses(assignments: TeachingAssignmentOption[]): string[] {
  const seen = new Set<string>()
  return assignments.filter(a => { if (seen.has(a.className)) return false; seen.add(a.className); return true }).map(a => a.className)
}

/** Get subjects for a given class from teaching assignments. */
export function getSubjectsForClass(assignments: TeachingAssignmentOption[], className: string): { id: string; subjectName: string }[] {
  const seen = new Set<string>()
  return assignments.filter(a => a.className === className).filter(a => { if (seen.has(a.subjectName)) return false; seen.add(a.subjectName); return true }).map(a => ({ id: a.id, subjectName: a.subjectName }))
}

/** Save a curriculum template (admin creates reusable template). */
export async function saveCurriculumTemplate(
  rows: Omit<CurriculumTemplate, 'id'>[],
): Promise<Result<number>> {
  try {
    const { error: delErr } = await supabase.from('curriculum_templates')
      .delete()
      .eq('board_name', rows[0]?.board_name ?? '')
      .eq('subject_name', rows[0]?.subject_name ?? '')
      .eq('level', rows[0]?.level ?? '')
      .eq('term', rows[0]?.term ?? '')
    if (delErr) return { ok: false, error: delErr.message }
    const insertRows = rows.map(r => ({
      board_name: r.board_name, subject_name: r.subject_name, level: r.level,
      term: r.term, week_number: r.week_number, topic: r.topic,
      objectives: r.objectives, activities: r.activities, resources: r.resources,
    }))
    const { error: insErr } = await supabase.from('curriculum_templates').insert(insertRows)
    if (insErr) return { ok: false, error: insErr.message }
    return { ok: true, data: rows.length }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to save template' }
  }
}

export async function getSowSummary(sessionId: string): Promise<Result<SowSummary>> {
  try {
    const { data, error } = await supabase.from('schemes_of_work').select('status').eq('session_id', sessionId)
    if (error) return { ok: false, error: error.message }
    const rows = data ?? []
    return {
      ok: true,
      data: {
        totalSchemes: rows.length,
        draftCount: rows.filter((r: any) => r.status === 'draft').length,
        submittedCount: rows.filter((r: any) => r.status === 'submitted').length,
        approvedCount: rows.filter((r: any) => r.status === 'approved').length,
        returnedCount: rows.filter((r: any) => r.status === 'returned').length,
      },
    }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load summary' }
  }
}

// ─── Write functions ────────────────────────────────────────────────────────

export async function createScheme(params: {
  schoolId: string
  teachingAssignmentId: string
  sessionId: string
  termId: string | null
  userId: string
}): Promise<Result<{ id: string }>> {
  try {
    const { data, error } = await supabase
      .from('schemes_of_work')
      .insert({
        school_id: params.schoolId,
        teaching_assignment_id: params.teachingAssignmentId,
        session_id: params.sessionId,
        term_id: params.termId || null,
        status: 'draft',
        created_by: params.userId,
      })
      .select('id').single()
    if (error) return { ok: false, error: error.message }
    return { ok: true, data: { id: data.id } }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to create scheme' }
  }
}

export async function saveSchemeWeeks(
  schemeId: string,
  schoolId: string,
  weeks: Omit<SchemeWeek, 'id' | 'scheme_of_work_id' | 'school_id' | 'created_at' | 'updated_at'>[],
): Promise<Result<void>> {
  try {
    const { error: delErr } = await supabase.from('scheme_of_work_weeks').delete().eq('scheme_of_work_id', schemeId)
    if (delErr) return { ok: false, error: delErr.message }
    if (weeks.length === 0) return { ok: true, data: undefined }
    const rows = weeks.map(w => ({
      scheme_of_work_id: schemeId, school_id: schoolId, week_number: w.week_number,
      topic: w.topic, objectives: w.objectives, activities: w.activities,
      resources: w.resources, coverage_status: w.coverage_status, coverage_note: w.coverage_note,
    }))
    const { error: insErr } = await supabase.from('scheme_of_work_weeks').insert(rows)
    if (insErr) return { ok: false, error: insErr.message }
    return { ok: true, data: undefined }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to save weeks' }
  }
}

export async function submitScheme(schemeId: string): Promise<Result<void>> {
  try {
    const { data, error } = await supabase
      .from('schemes_of_work').update({ status: 'submitted' })
      .eq('id', schemeId).in('status', ['draft', 'returned']).select('id').maybeSingle()
    if (error) return { ok: false, error: error.message }
    if (!data) return { ok: false, error: 'Scheme is not in draft or returned status' }
    return { ok: true, data: undefined }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to submit scheme' }
  }
}

export async function approveScheme(schemeId: string, reviewerStaffId: string): Promise<Result<void>> {
  try {
    const { data, error } = await supabase
      .from('schemes_of_work').update({
        status: 'approved', reviewed_by: reviewerStaffId,
        reviewed_at: new Date().toISOString(), review_note: null,
      })
      .eq('id', schemeId).eq('status', 'submitted').select('id').maybeSingle()
    if (error) return { ok: false, error: error.message }
    if (!data) return { ok: false, error: 'Scheme is not in submitted status' }
    return { ok: true, data: undefined }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to approve scheme' }
  }
}

export async function returnScheme(schemeId: string, reviewerStaffId: string, note: string): Promise<Result<void>> {
  try {
    const { data, error } = await supabase
      .from('schemes_of_work').update({
        status: 'returned', reviewed_by: reviewerStaffId,
        reviewed_at: new Date().toISOString(), review_note: note,
      })
      .eq('id', schemeId).eq('status', 'submitted').select('id').maybeSingle()
    if (error) return { ok: false, error: error.message }
    if (!data) return { ok: false, error: 'Scheme is not in submitted status' }
    return { ok: true, data: undefined }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to return scheme' }
  }
}

export async function importFromTemplate(
  schemeId: string, schoolId: string,
  templateFilter: { subject_name: string; level: string; term: string; board_name: string },
): Promise<Result<number>> {
  try {
    const { data: templates, error: tplErr } = await supabase
      .from('curriculum_templates').select('*')
      .eq('subject_name', templateFilter.subject_name)
      .eq('level', templateFilter.level)
      .eq('term', templateFilter.term)
      .eq('board_name', templateFilter.board_name)
      .order('week_number', { ascending: true })
    if (tplErr) return { ok: false, error: tplErr.message }
    if (!templates || templates.length === 0) return { ok: false, error: 'No template found for the selected filters' }

    const { error: delErr } = await supabase.from('scheme_of_work_weeks').delete().eq('scheme_of_work_id', schemeId)
    if (delErr) return { ok: false, error: delErr.message }

    const rows = templates.map((t: any) => ({
      scheme_of_work_id: schemeId, school_id: schoolId, week_number: t.week_number,
      topic: t.topic, objectives: t.objectives, activities: t.activities,
      resources: t.resources, coverage_status: 'planned' as CoverageStatus,
    }))
    const { error: insErr } = await supabase.from('scheme_of_work_weeks').insert(rows)
    if (insErr) return { ok: false, error: insErr.message }
    return { ok: true, data: templates.length }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to import template' }
  }
}

/** Update a single week's coverage status and note. */
export async function markWeekCoverage(
  weekId: string,
  status: CoverageStatus,
  note?: string,
): Promise<Result<void>> {
  try {
    const updates: any = { coverage_status: status }
    if (note !== undefined) updates.coverage_note = note
    const { data, error } = await supabase.from('scheme_of_work_weeks').update(updates).eq('id', weekId).select('id')
    if (error) return { ok: false, error: error.message }
    if (!data || data.length === 0) return { ok: false, error: 'Week not found or access denied' }
    return { ok: true, data: undefined }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to update coverage' }
  }
}
