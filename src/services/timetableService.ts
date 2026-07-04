/**
 * timetableService.ts
 * Data access layer for the timetable module.
 * No browser-only APIs. No UI imports. React Native compatible.
 *
 * Read-only exports:
 *   loadTimetableData()   — everything needed to render class + teacher views
 *   loadStaffList()       — for teacher-view selector
 *   loadClassNodes()      — leaf nodes for class-view selector
 *   getCurrentPeriod()    — live lesson highlight helper
 *
 * Admin edit-mode exports (added for tap-to-select, tap-to-place slot assignment):
 *   loadTeachingAssignments()  — assignment "chips" available for a class+session
 *   upsertTimetableEntry()     — write/overwrite one day×period slot
 *   deleteTimetableEntry()     — clear one slot
 *   findConflictingEntryIds()  — pure helper: which loaded entries double-book a teacher
 */

import { supabase } from '../lib/supabase'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Period {
  id: string
  label: string
  start_time: string   // 'HH:MM:SS'
  end_time: string
  is_break: boolean
  sort_order: number
}

export interface WeekDay {
  day_of_week: number  // 0=Sun … 6=Sat
  sort_order: number
}

export interface TimetableEntry {
  id: string
  day_of_week: number
  period_id: string
  class_node_id: string
  class_node_name: string
  subject_id: string | null
  subject_name: string | null
  teaching_assignment_id: string | null
  staff_id: string | null
  staff_name: string | null
}

export interface ClassNode {
  id: string
  name: string
  parent_id: string | null
  sort_order: number
  is_leaf_enrollable: boolean
  // Full path label, e.g. "JSS → JSS 1 → JSS 1A"
  path_label?: string
}

export interface StaffMember {
  id: string
  full_name: string
  status: string
}

// A teaching assignment shown as a draggable/tappable "chip" in edit mode.
// One row = one teacher teaching one subject to one class, for the session.
// This is the *only* source of who/what can be placed on the timetable —
// edit mode never lets an admin invent a staff/subject pairing on the fly.
export interface TeachingAssignment {
  id: string
  staff_id: string
  staff_name: string
  subject_id: string
  subject_name: string
  class_node_id: string
}

export interface TimetableData {
  weekDays: WeekDay[]
  periods: Period[]
  entries: TimetableEntry[]
}

// ─── Load full timetable data ─────────────────────────────────────────────────
// One parallel query pair: periods+days, then entries with joins.
// RLS scopes everything to the current school automatically.

export async function loadTimetableData(sessionId: string): Promise<{
  ok: boolean
  data?: TimetableData
  error?: string
}> {
  try {
    const [
      { data: weekDays, error: wdError },
      { data: periods, error: pError },
    ] = await Promise.all([
      supabase
        .from('school_week_days')
        .select('day_of_week, sort_order')
        .order('sort_order'),
      supabase
        .from('periods')
        .select('id, label, start_time, end_time, is_break, sort_order')
        .order('sort_order'),
    ])

    if (wdError) return { ok: false, error: wdError.message }
    if (pError) return { ok: false, error: pError.message }

    // Entries: join through teaching_assignments to get staff name,
    // and through class_nodes / subjects for display labels.
    const { data: rawEntries, error: eError } = await supabase
      .from('timetable_entries')
      .select(`
        id,
        day_of_week,
        period_id,
        class_node_id,
        subject_id,
        teaching_assignment_id,
        class_nodes ( name ),
        subjects ( name ),
        teaching_assignments (
          staff_id,
          staff ( full_name )
        )
      `)
      .eq('session_id', sessionId)

    if (eError) return { ok: false, error: eError.message }

    // Flatten the Supabase nested join shape into flat TimetableEntry objects
    const entries: TimetableEntry[] = (rawEntries ?? []).map((e: any) => ({
      id: e.id,
      day_of_week: e.day_of_week,
      period_id: e.period_id,
      class_node_id: e.class_node_id,
      class_node_name: e.class_nodes?.name ?? '',
      subject_id: e.subject_id ?? null,
      subject_name: e.subjects?.name ?? null,
      teaching_assignment_id: e.teaching_assignment_id ?? null,
      staff_id: e.teaching_assignments?.staff_id ?? null,
      staff_name: e.teaching_assignments?.staff?.full_name ?? null,
    }))

    return {
      ok: true,
      data: {
        weekDays: weekDays ?? [],
        periods: periods ?? [],
        entries,
      },
    }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load timetable' }
  }
}

// ─── Load leaf class nodes (for class-view selector) ─────────────────────────

export async function loadClassNodes(): Promise<{
  ok: boolean
  data?: ClassNode[]
  error?: string
}> {
  try {
    const { data, error } = await supabase
      .from('class_nodes')
      .select('id, name, parent_id, sort_order, is_leaf_enrollable')
      .order('sort_order')

    if (error) return { ok: false, error: error.message }

    const nodes: ClassNode[] = data ?? []

    // Build a quick parent-name lookup so we can show a 2-level label
    // e.g. "JSS 1A" under "JSS 1" → label "JSS 1 · JSS 1A"
    const byId: Record<string, ClassNode> = {}
    nodes.forEach(n => { byId[n.id] = n })

    nodes.forEach(n => {
      if (n.parent_id && byId[n.parent_id]) {
        n.path_label = `${byId[n.parent_id].name} · ${n.name}`
      } else {
        n.path_label = n.name
      }
    })

    return { ok: true, data: nodes }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load classes' }
  }
}

// ─── Load active staff list (for teacher-view selector) ──────────────────────

export async function loadStaffList(): Promise<{
  ok: boolean
  data?: StaffMember[]
  error?: string
}> {
  try {
    const { data, error } = await supabase
      .from('staff')
      .select('id, full_name, status')
      .eq('status', 'active')
      .order('full_name')

    if (error) return { ok: false, error: error.message }
    return { ok: true, data: data ?? [] }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load staff' }
  }
}

// ─── Teaching assignments — the "chips" admin places onto the grid ──────────
// One row = one teacher teaching one subject to one class, for the session.
// This is read-only from the timetable module's side: there is no UI here
// to create a teaching_assignments row. If a class has none, the admin needs
// to assign teachers to subjects first (a separate, not-yet-built screen) —
// edit mode surfaces that gap rather than inventing a pairing.

export async function loadTeachingAssignments(
  sessionId: string,
  classNodeId: string,
): Promise<{
  ok: boolean
  data?: TeachingAssignment[]
  error?: string
}> {
  try {
    const { data, error } = await supabase
      .from('teaching_assignments')
      .select(`
        id,
        staff_id,
        subject_id,
        class_node_id,
        staff ( full_name ),
        subjects ( name )
      `)
      .eq('session_id', sessionId)
      .eq('class_node_id', classNodeId)

    if (error) return { ok: false, error: error.message }

    const assignments: TeachingAssignment[] = (data ?? []).map((a: any) => ({
      id: a.id,
      staff_id: a.staff_id,
      staff_name: a.staff?.full_name ?? '',
      subject_id: a.subject_id,
      subject_name: a.subjects?.name ?? '',
      class_node_id: a.class_node_id,
    }))

    return { ok: true, data: assignments }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load teaching assignments' }
  }
}

// ─── Conflict detection — derived from data already in memory ───────────────
// Same teacher, same day, same period, different class = double-booked.
// There is no "room" concept anywhere in the schema, so room conflicts
// cannot be checked — this only ever flags the teacher.
// loadTimetableData() already loads every entry for the session, school-wide
// (the class/teacher view toggle filters it client-side) — so this is a pure
// data transform, no extra query, computed fresh every time entries change.
// "Live query, not a stored flag" per §7.12 — this is that, just in-memory.

export function findConflictingEntryIds(entries: TimetableEntry[]): Set<string> {
  const byTeacherSlot: Record<string, TimetableEntry[]> = {}

  for (const e of entries) {
    if (!e.staff_id) continue   // free/supervised periods can't conflict
    const key = `${e.staff_id}|${e.day_of_week}|${e.period_id}`
    if (!byTeacherSlot[key]) byTeacherSlot[key] = []
    byTeacherSlot[key].push(e)
  }

  const conflictingIds = new Set<string>()
  for (const group of Object.values(byTeacherSlot)) {
    const distinctClasses = new Set(group.map(e => e.class_node_id))
    if (distinctClasses.size > 1) {
      group.forEach(e => conflictingIds.add(e.id))
    }
  }

  return conflictingIds
}

// ─── Write one day×period slot ───────────────────────────────────────────────
// Upserts on the table's real unique constraint
// (school_id, session_id, day_of_week, period_id, class_node_id) — dropping
// a different assignment onto an already-filled cell overwrites it rather
// than erroring. Pass teachingAssignmentId + subjectId as null to mark a
// deliberately free/supervised period (subject_id is nullable for this).

export async function upsertTimetableEntry(params: {
  schoolId: string
  sessionId: string
  dayOfWeek: number
  periodId: string
  classNodeId: string
  teachingAssignmentId: string | null
  subjectId: string | null
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const { error } = await supabase
      .from('timetable_entries')
      .upsert(
        {
          school_id: params.schoolId,
          session_id: params.sessionId,
          day_of_week: params.dayOfWeek,
          period_id: params.periodId,
          class_node_id: params.classNodeId,
          teaching_assignment_id: params.teachingAssignmentId,
          subject_id: params.subjectId,
        },
        { onConflict: 'school_id,session_id,day_of_week,period_id,class_node_id' },
      )

    if (error) return { ok: false, error: error.message }
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to save the lesson' }
  }
}

// ─── Clear one slot ───────────────────────────────────────────────────────────

export async function deleteTimetableEntry(entryId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const { error } = await supabase
      .from('timetable_entries')
      .delete()
      .eq('id', entryId)

    if (error) return { ok: false, error: error.message }
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to remove the lesson' }
  }
}

// ─── Current session lookup ───────────────────────────────────────────────────

export async function loadCurrentSession(): Promise<{
  ok: boolean
  sessionId?: string
  sessionName?: string
  error?: string
}> {
  try {
    const { data, error } = await supabase
      .from('sessions')
      .select('id, name')
      .eq('is_current', true)
      .maybeSingle()

    if (error) return { ok: false, error: error.message }
    if (!data) return { ok: false, error: 'No current session found. Set up a session in the calendar settings.' }
    return { ok: true, sessionId: data.id, sessionName: data.name }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load session' }
  }
}

// ─── Live lesson highlight ────────────────────────────────────────────────────
// Given today's day_of_week and current time, find which period_id is active.
// Returns null during breaks or outside school hours.

export function getCurrentPeriod(
  periods: Period[],
  weekDays: WeekDay[],
  now: Date = new Date(),
): { periodId: string | null; dayOfWeek: number } {
  const dayOfWeek = now.getDay()  // 0=Sun, 6=Sat

  // Check if today is a school day
  const isSchoolDay = weekDays.some(wd => wd.day_of_week === dayOfWeek)
  if (!isSchoolDay) return { periodId: null, dayOfWeek }

  const hhmm = now.getHours() * 60 + now.getMinutes()

  for (const p of periods) {
    if (p.is_break) continue
    const [sh, sm] = p.start_time.split(':').map(Number)
    const [eh, em] = p.end_time.split(':').map(Number)
    const start = sh * 60 + sm
    const end = eh * 60 + em
    if (hhmm >= start && hhmm < end) {
      return { periodId: p.id, dayOfWeek }
    }
  }

  return { periodId: null, dayOfWeek }
}

// ─── Day name helper ──────────────────────────────────────────────────────────

const DAY_NAMES_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DAY_NAMES_FULL  = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export function dayName(dayOfWeek: number, short = false): string {
  return short ? DAY_NAMES_SHORT[dayOfWeek] : DAY_NAMES_FULL[dayOfWeek]
}
