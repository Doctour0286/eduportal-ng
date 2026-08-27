/**
 * punctualityService.ts
 * Data access layer for the Teacher Punctuality Tracker.
 * No browser-only APIs. No UI imports. React Native compatible.
 *
 * Read exports:
 *   loadScheduledTeachersForDate()  — teachers scheduled on a given date (proctor view)
 *   loadPunctualityReport()         — date-range report for admin/HR
 *   getPunctualitySummary()         — summary stats for dashboard cards
 *
 * Write exports:
 *   markTeacherFullDay()            — day-level shortcut: marks all periods for a teacher
 *   markPeriodRecord()              — individual period mark/override
 *
 * Privacy: teachers are excluded from SELECT via RLS. This service is only
 * called from admin/HR/proctor UIs. Teachers have no access to this data.
 */

import { supabase } from '../lib/supabase'
import { queueWrite } from '../lib/offlineQueue'

// ─── Types ──────────────────────────────────────────────────────────────────

export type PunctualityStatus = 'present' | 'absent'
export type RecordingSource = 'day_shortcut' | 'period_override'
export type PunctualityScope = 'day' | 'week' | 'term' | 'session'

interface Ok<T> { ok: true; data: T }
interface Err   { ok: false; error: string }
type Result<T> = Ok<T> | Err

export interface PunctualityRecord {
  id: string
  school_id: string
  timetable_entry_id: string
  staff_id: string
  recorded_by: string
  status: PunctualityStatus
  record_date: string          // 'YYYY-MM-DD'
  recording_source: RecordingSource
  created_at: string
}

/** A teacher scheduled on a specific date, with their periods and recording status. */
export interface ScheduledTeacher {
  staff_id: string
  staff_name: string
  entries: ScheduledEntry[]
  recordedCount: number         // periods with a record (present or absent)
  totalCount: number           // total scheduled periods (non-null staff_id)
}

export interface ScheduledEntry {
  timetable_entry_id: string
  period_id: string
  period_label: string
  period_start: string         // 'HH:MM:SS'
  period_end: string
  class_node_id: string
  class_node_name: string
  subject_name: string | null
  record: PunctualityRecord | null  // null = unrecorded
}

/** Per-teacher row in the admin/HR report. */
export interface PunctualityTeacherReport {
  staff_id: string
  staff_name: string
  totalScheduled: number
  present: number
  absent: number
  unrecorded: number
  punctualityRate: number      // present / (present + absent) × 100, or 0 if no records
}

/** Full report for a date range. */
export interface PunctualityReport {
  scope: PunctualityScope
  startDate: string
  endDate: string
  totalScheduled: number       // sum of all teachers' scheduled periods in range
  totalPresent: number
  totalAbsent: number
  totalUnrecorded: number
  overallRate: number          // present / (present + absent) × 100
  teachers: PunctualityTeacherReport[]
}

/** Summary stats for dashboard cards. */
export interface PunctualitySummary {
  scope: PunctualityScope
  startDate: string
  endDate: string
  teachersScheduledToday: number
  teachersPresentToday: number
  totalScheduledPeriods: number
  totalPresent: number
  totalAbsent: number
  totalUnrecorded: number
  overallRate: number
}

// ─── Internal utilities ─────────────────────────────────────────────────────

export function todayDateString(): string {
  return formatDate(new Date())
}

function formatDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Convert a 'YYYY-MM-DD' date string to day_of_week (0=Sun … 6=Sat). */
function dateToDayOfWeek(dateStr: string): number {
  return new Date(dateStr + 'T00:00:00').getDay()
}

/** Heuristic: treat these message patterns as transient network failures. */
function isNetworkError(message: string): boolean {
  const lower = message.toLowerCase()
  return (
    lower.includes('failed to fetch') ||
    lower.includes('network') ||
    lower.includes('timeout') ||
    lower.includes('offline') ||
    lower.includes('econnrefused') ||
    lower.includes('load failed')
  )
}

function friendlyError(message: string): string {
  if (message.includes('violates row-level security')) {
    return "You don't have permission to record teacher punctuality."
  }
  if (message.includes('violates foreign key')) {
    return 'Timetable or staff record not found. Please refresh and try again.'
  }
  if (message.includes('violates unique constraint')) {
    return 'Record already exists. Please refresh and try again.'
  }
  return 'Failed to save punctuality record. Please try again.'
}

// ─── Read: scheduled teachers for a date ────────────────────────────────────

/**
 * Loads every teacher who has at least one timetable entry on the given date,
 * along with their entries and any existing punctuality records.
 *
 * Used by the proctor's day-level view and periods grid.
 * Entries with null staff_id (free/supervised periods) are excluded —
 * there is no teacher to track for those.
 */
export async function loadScheduledTeachersForDate(
  sessionId: string,
  date: string,
): Promise<Result<ScheduledTeacher[]>> {
  try {
    const dayOfWeek = dateToDayOfWeek(date)

    // Load timetable entries for this day, with staff + period + class joins
    const { data: entries, error: entriesErr } = await supabase
      .from('timetable_entries')
      .select(`
        id,
        period_id,
        class_node_id,
        teaching_assignment_id,
        teaching_assignments (
          staff_id,
          staff ( full_name )
        ),
        periods ( label, start_time, end_time, sort_order ),
        class_nodes ( name ),
        subjects ( name )
      `)
      .eq('session_id', sessionId)
      .eq('day_of_week', dayOfWeek)

    if (entriesErr) return { ok: false, error: entriesErr.message }

    // Filter to entries with a staff member (exclude free/supervised periods)
    const staffEntries = (entries ?? []).filter((e: any) =>
      e.teaching_assignments?.staff_id != null
    )

    if (staffEntries.length === 0) return { ok: true, data: [] }

    // Collect entry IDs for the punctuality records query
    const entryIds = staffEntries.map((e: any) => e.id as string)

    // Load existing punctuality records for these entries on this date
    const { data: records, error: recordsErr } = await supabase
      .from('teacher_punctuality_records')
      .select('*')
      .eq('record_date', date)
      .in('timetable_entry_id', entryIds)

    if (recordsErr) return { ok: false, error: recordsErr.message }

    // Index records by timetable_entry_id for fast lookup
    const recordMap = new Map<string, PunctualityRecord>()
    for (const r of records ?? []) {
      recordMap.set(r.timetable_entry_id, r as PunctualityRecord)
    }

    // Group entries by staff member
    const byStaff = new Map<string, {
      staff_name: string
      entries: ScheduledEntry[]
    }>()

    for (const e of staffEntries) {
      const ta = e.teaching_assignments as any
      const staffId = ta.staff_id as string
      const staffName = ta.staff?.full_name ?? ''
      const period = e.periods as any
      const classNode = e.class_nodes as any
      const subject = e.subjects as any

      if (!byStaff.has(staffId)) {
        byStaff.set(staffId, { staff_name: staffName, entries: [] })
      }

      byStaff.get(staffId)!.entries.push({
        timetable_entry_id: e.id,
        period_id: e.period_id,
        period_label: period?.label ?? '',
        period_start: period?.start_time ?? '',
        period_end: period?.end_time ?? '',
        class_node_id: e.class_node_id,
        class_node_name: classNode?.name ?? '',
        subject_name: subject?.name ?? null,
        record: recordMap.get(e.id) ?? null,
      })
    }

    // Sort entries within each teacher by period sort_order
    const result: ScheduledTeacher[] = []
    for (const [staffId, group] of byStaff) {
      group.entries.sort((a, b) => {
        // Use period_start as a fallback sort key
        return a.period_start.localeCompare(b.period_start)
      })
      const recordedCount = group.entries.filter(e => e.record !== null).length
      result.push({
        staff_id: staffId,
        staff_name: group.staff_name,
        entries: group.entries,
        recordedCount,
        totalCount: group.entries.length,
      })
    }

    // Sort teachers alphabetically
    result.sort((a, b) => a.staff_name.localeCompare(b.staff_name))

    return { ok: true, data: result }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load scheduled teachers' }
  }
}

// ─── Write: day-level shortcut ──────────────────────────────────────────────

/**
 * Marks ALL of a teacher's scheduled periods for a given date as present or absent.
 * Uses upsert with onConflict on (school_id, timetable_entry_id) so it's safe
 * to re-call — repeated taps overwrite, never duplicate.
 *
 * This is the bulk convenience over the same table the periods view edits
 * individually. Overriding in the periods view after this will update just
 * that one record.
 */
export async function markTeacherFullDay(params: {
  schoolId: string
  staffId: string
  date: string
  status: PunctualityStatus
  recordedBy: string
  timetableEntryIds: string[]
}): Promise<{ ok: boolean; queued?: boolean; error?: string }> {
  const { schoolId, staffId, date, status, recordedBy, timetableEntryIds } = params

  if (timetableEntryIds.length === 0) return { ok: true }

  const rows = timetableEntryIds.map(entryId => ({
    school_id: schoolId,
    timetable_entry_id: entryId,
    staff_id: staffId,
    recorded_by: recordedBy,
    status,
    record_date: date,
    recording_source: 'day_shortcut' as const,
  }))

  try {
    const { error } = await supabase
      .from('teacher_punctuality_records')
      .upsert(rows, {
        onConflict: 'school_id,timetable_entry_id',
      })

    if (error) {
      if (isNetworkError(error.message)) {
        await Promise.all(rows.map(row =>
          queueWrite('teacher_punctuality_records', 'insert', row)
        ))
        return { ok: true, queued: true }
      }
      return { ok: false, error: friendlyError(error.message) }
    }

    return { ok: true }
  } catch (err: any) {
    await Promise.all(rows.map(row =>
      queueWrite('teacher_punctuality_records', 'insert', row)
    ))
    return { ok: true, queued: true }
  }
}

// ─── Write: individual period mark/override ─────────────────────────────────

/**
 * Marks or overrides a single timetable entry's punctuality record.
 * Used by the periods grid view for granular per-period control.
 *
 * The day-level shortcut and this function write to the same underlying
 * table — overriding in the periods view after using the day shortcut
 * updates just that one record (the unique constraint ensures no duplicates).
 */
export async function markPeriodRecord(params: {
  schoolId: string
  timetableEntryId: string
  staffId: string
  status: PunctualityStatus
  recordedBy: string
  date: string
  source: RecordingSource
}): Promise<{ ok: boolean; queued?: boolean; error?: string }> {
  const payload = {
    school_id: params.schoolId,
    timetable_entry_id: params.timetableEntryId,
    staff_id: params.staffId,
    recorded_by: params.recordedBy,
    status: params.status,
    record_date: params.date,
    recording_source: params.source,
  }

  try {
    const { error } = await supabase
      .from('teacher_punctuality_records')
      .upsert(payload, {
        onConflict: 'school_id,timetable_entry_id',
      })

    if (error) {
      if (isNetworkError(error.message)) {
        await queueWrite('teacher_punctuality_records', 'insert', payload)
        return { ok: true, queued: true }
      }
      return { ok: false, error: friendlyError(error.message) }
    }

    return { ok: true }
  } catch (err: any) {
    await queueWrite('teacher_punctuality_records', 'insert', payload)
    return { ok: true, queued: true }
  }
}

// ─── Read: punctuality report (admin/HR) ────────────────────────────────────

/**
 * Aggregates punctuality across the whole school for a date range.
 * Per-teacher breakdown with present/absent/unrecorded counts.
 *
 * "Unrecorded" = scheduled periods with no row in teacher_punctuality_records.
 * "Absent" = rows with status='absent'. The distinction is visible in the report.
 */
export async function loadPunctualityReport(params: {
  scope: PunctualityScope
  startDate: string
  endDate: string
}): Promise<Result<PunctualityReport>> {
  try {
    const { scope, startDate, endDate } = params

    // Load all punctuality records in the date range
    const { data: records, error: recordsErr } = await supabase
      .from('teacher_punctuality_records')
      .select('staff_id, status, timetable_entry_id, record_date')
      .gte('record_date', startDate)
      .lte('record_date', endDate)

    if (recordsErr) return { ok: false, error: recordsErr.message }

    // Load timetable entries in the date range to get scheduled periods
    // We need to resolve which dates fall on which day_of_week,
    // then query timetable_entries for those days.
    const dateRange = buildDateRange(startDate, endDate)
    const dayOfWeekSet = new Set(dateRange.map(d => dateToDayOfWeek(d)))
    const dayOfWeekArray = [...dayOfWeekSet]

    // We need session_id — load the current session
    const { data: session, error: sessionErr } = await supabase
      .from('sessions')
      .select('id')
      .eq('is_current', true)
      .single()

    if (sessionErr || !session) return { ok: false, error: sessionErr?.message ?? 'No current session' }

    const { data: entries, error: entriesErr } = await supabase
      .from('timetable_entries')
      .select(`
        id,
        day_of_week,
        teaching_assignments ( staff_id )
      `)
      .eq('session_id', session.id)
      .in('day_of_week', dayOfWeekArray)

    if (entriesErr) return { ok: false, error: entriesErr.message }

    // Filter entries to only those whose day_of_week falls within the date range
    // Build a map: day_of_week → list of dates in range with that day_of_week
    const datesByDow = new Map<number, string[]>()
    for (const d of dateRange) {
      const dow = dateToDayOfWeek(d)
      if (!datesByDow.has(dow)) datesByDow.set(dow, [])
      datesByDow.get(dow)!.push(d)
    }

    // Count scheduled periods per teacher per date
    // Key: `${staff_id}|${date}`
    const scheduledByTeacherDate = new Map<string, number>()
    const scheduledByTeacher = new Map<string, number>() // total per teacher
    const allStaffIds = new Set<string>()

    for (const entry of entries ?? []) {
      const staffId = (entry as any).teaching_assignments?.staff_id
      if (!staffId) continue // free period
      const dow = entry.day_of_week as number
      const dates = datesByDow.get(dow) ?? []
      for (const d of dates) {
        const key = `${staffId}|${d}`
        scheduledByTeacherDate.set(key, (scheduledByTeacherDate.get(key) ?? 0) + 1)
        scheduledByTeacher.set(staffId, (scheduledByTeacher.get(staffId) ?? 0) + 1)
        allStaffIds.add(staffId)
      }
    }

    // Count records per teacher per date
    const presentByTeacherDate = new Map<string, number>()
    const absentByTeacherDate = new Map<string, number>()
    const presentByTeacher = new Map<string, number>()
    const absentByTeacher = new Map<string, number>()

    for (const r of records ?? []) {
      const key = `${r.staff_id}|${r.record_date}`
      if (r.status === 'present') {
        presentByTeacherDate.set(key, (presentByTeacherDate.get(key) ?? 0) + 1)
        presentByTeacher.set(r.staff_id, (presentByTeacher.get(r.staff_id) ?? 0) + 1)
      } else if (r.status === 'absent') {
        absentByTeacherDate.set(key, (absentByTeacherDate.get(key) ?? 0) + 1)
        absentByTeacher.set(r.staff_id, (absentByTeacher.get(r.staff_id) ?? 0) + 1)
      }
      allStaffIds.add(r.staff_id)
    }

    // Build per-teacher report
    const teachers: PunctualityTeacherReport[] = []
    let totalScheduled = 0, totalPresent = 0, totalAbsent = 0, totalUnrecorded = 0

    // We need staff names — batch-load
    let staffNameMap = new Map<string, string>()
    if (allStaffIds.size > 0) {
      const { data: staffRows } = await supabase
        .from('staff')
        .select('id, full_name')
        .in('id', [...allStaffIds])
      for (const s of staffRows ?? []) {
        staffNameMap.set(s.id, s.full_name)
      }
    }

    for (const staffId of allStaffIds) {
      const scheduled = scheduledByTeacher.get(staffId) ?? 0
      const present = presentByTeacher.get(staffId) ?? 0
      const absent = absentByTeacher.get(staffId) ?? 0
      const unrecorded = Math.max(0, scheduled - present - absent)
      const rate = (present + absent) > 0
        ? Math.round((present / (present + absent)) * 1000) / 10
        : 0

      teachers.push({
        staff_id: staffId,
        staff_name: staffNameMap.get(staffId) ?? '',
        totalScheduled: scheduled,
        present,
        absent,
        unrecorded,
        punctualityRate: rate,
      })

      totalScheduled += scheduled
      totalPresent += present
      totalAbsent += absent
      totalUnrecorded += unrecorded
    }

    // Sort by name
    teachers.sort((a, b) => a.staff_name.localeCompare(b.staff_name))

    const overallRate = (totalPresent + totalAbsent) > 0
      ? Math.round((totalPresent / (totalPresent + totalAbsent)) * 1000) / 10
      : 0

    return {
      ok: true,
      data: {
        scope,
        startDate,
        endDate,
        totalScheduled,
        totalPresent,
        totalAbsent,
        totalUnrecorded,
        overallRate,
        teachers,
      },
    }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load punctuality report' }
  }
}

// ─── Read: summary for dashboard cards ───────────────────────────────────────

/**
 * Returns summary stats for a date range — used by admin and HR dashboard cards.
 * Lighter than loadPunctualityReport: no per-teacher breakdown.
 */
export async function getPunctualitySummary(params: {
  scope: PunctualityScope
  startDate: string
  endDate: string
}): Promise<Result<PunctualitySummary>> {
  try {
    const { scope, startDate, endDate } = params
    const today = todayDateString()

    // Load all records in range
    const { data: records, error: recordsErr } = await supabase
      .from('teacher_punctuality_records')
      .select('staff_id, status, record_date')
      .gte('record_date', startDate)
      .lte('record_date', endDate)

    if (recordsErr) return { ok: false, error: recordsErr.message }

    // Load timetable entries for the range
    const dateRange = buildDateRange(startDate, endDate)
    const dayOfWeekSet = new Set(dateRange.map(d => dateToDayOfWeek(d)))

    const { data: session } = await supabase
      .from('sessions')
      .select('id')
      .eq('is_current', true)
      .single()

    if (!session) return { ok: false, error: 'No current session' }

    const { data: entries, error: entriesErr } = await supabase
      .from('timetable_entries')
      .select(`
        id,
        day_of_week,
        teaching_assignments ( staff_id )
      `)
      .eq('session_id', session.id)
      .in('day_of_week', [...dayOfWeekSet])

    if (entriesErr) return { ok: false, error: entriesErr.message }

    // Build date→dow mapping
    const datesByDow = new Map<number, string[]>()
    for (const d of dateRange) {
      const dow = dateToDayOfWeek(d)
      if (!datesByDow.has(dow)) datesByDow.set(dow, [])
      datesByDow.get(dow)!.push(d)
    }

    // Count total scheduled periods (staff-only entries)
    let totalScheduledPeriods = 0
    let teachersScheduledToday = 0
    const todayTeachers = new Set<string>()

    for (const entry of entries ?? []) {
      const staffId = (entry as any).teaching_assignments?.staff_id
      if (!staffId) continue
      const dow = entry.day_of_week as number
      const dates = datesByDow.get(dow) ?? []
      totalScheduledPeriods += dates.length
      if (dates.includes(today)) {
        todayTeachers.add(staffId)
      }
    }

    teachersScheduledToday = todayTeachers.size

    // Count records
    let totalPresent = 0, totalAbsent = 0
    const presentToday = new Set<string>()

    for (const r of records ?? []) {
      if (r.status === 'present') {
        totalPresent++
        if (r.record_date === today) presentToday.add(r.staff_id)
      } else if (r.status === 'absent') {
        totalAbsent++
      }
    }

    const totalUnrecorded = Math.max(0, totalScheduledPeriods - totalPresent - totalAbsent)
    const overallRate = (totalPresent + totalAbsent) > 0
      ? Math.round((totalPresent / (totalPresent + totalAbsent)) * 1000) / 10
      : 0

    return {
      ok: true,
      data: {
        scope,
        startDate,
        endDate,
        teachersScheduledToday,
        teachersPresentToday: presentToday.size,
        totalScheduledPeriods,
        totalPresent,
        totalAbsent,
        totalUnrecorded,
        overallRate,
      },
    }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load punctuality summary' }
  }
}

// ─── Internal: date range builder ───────────────────────────────────────────

function buildDateRange(startDate: string, endDate: string): string[] {
  const dates: string[] = []
  const current = new Date(startDate + 'T00:00:00')
  const end = new Date(endDate + 'T00:00:00')
  while (current <= end) {
    dates.push(formatDate(current))
    current.setDate(current.getDate() + 1)
  }
  return dates
}
