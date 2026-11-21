/**
 * carryOverService.ts — copy session/term-specific configuration forward so a
 * new session doesn't start from a blank page.
 *
 *   offerings  course offerings (+ optionally their timetable slots)
 *   fees       fee assignments (+ optional % uplift, due dates moved forward)
 *   teaching   teaching assignments (+ optionally the class timetable)
 *
 * Always additive and safe to repeat: anything already present in the target
 * is skipped, never overwritten. Every run starts with a preview.
 */
import { supabase } from '../lib/supabase'

type Ok<T> = { ok: true; data: T }
type Err = { ok: false; error: string }
type Result<T> = Ok<T> | Err

export type CarryKind = 'offerings' | 'fees' | 'teaching'

export interface CarryScope { sessionId: string; termId: string | null; startDate: string }

export interface CarryOptions {
  keepLecturers: boolean      // offerings
  includeTimetable: boolean   // offerings, teaching
  upliftPercent: number       // fees
  shiftDueDates: boolean      // fees
}

export interface CarryPreview { sourceCount: number; newCount: number; duplicateCount: number; notes: string[] }
export interface CarryResult { created: number; skipped: number; timetable: number }

const CHUNK = 300
const fail = (e: any): Err => ({ ok: false, error: e?.message ?? 'Something went wrong' })

function shiftDate(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00')
  d.setDate(d.getDate() + days)
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-')
}
const dayGap = (from: string, to: string) =>
  Math.round((new Date(to + 'T00:00:00').getTime() - new Date(from + 'T00:00:00').getTime()) / 86_400_000)

async function insertChunks(table: string, rows: object[], select?: string) {
  const out: any[] = []
  for (let i = 0; i < rows.length; i += CHUNK) {
    const q = supabase.from(table).insert(rows.slice(i, i + CHUNK) as any)
    const { data, error } = select ? await q.select(select) : await q
    if (error) throw new Error(error.message)
    if (data) out.push(...(data as any[]))
  }
  return out
}

// ─── Planning (shared by preview and run) ────────────────────────────────────

interface OfferingRow {
  id: string; course_id: string; term_id: string | null; staff_id: string | null
  programme_id: string | null; programme_level_id: string | null; attendance_eligibility_threshold_pct: number | null
}
const offeringKey = (o: { course_id: string; programme_id: string | null; programme_level_id: string | null }, termId: string | null) =>
  `${o.course_id}|${o.programme_id ?? ''}|${o.programme_level_id ?? ''}|${termId ?? ''}`

async function loadOfferings(sessionId: string, termId: string | null): Promise<OfferingRow[]> {
  let q = supabase.from('course_offerings')
    .select('id, course_id, term_id, staff_id, programme_id, programme_level_id, attendance_eligibility_threshold_pct')
    .eq('session_id', sessionId)
  if (termId) q = q.eq('term_id', termId)
  const { data, error } = await q
  if (error) throw new Error(error.message)
  return (data ?? []) as OfferingRow[]
}

interface FeeRow {
  fee_head_id: string; target_type: string; class_node_id: string | null; programme_id: string | null
  programme_level_id: string | null; amount: number; due_date: string | null; term_id: string | null
}
const feeKey = (f: { fee_head_id: string; target_type: string; class_node_id: string | null; programme_id: string | null; programme_level_id: string | null }, termId: string | null) =>
  `${f.fee_head_id}|${f.target_type}|${f.class_node_id ?? ''}|${f.programme_id ?? ''}|${f.programme_level_id ?? ''}|${termId ?? ''}`

async function loadFees(schoolId: string, sessionId: string, termId: string | null): Promise<FeeRow[]> {
  let q = supabase.from('fee_assignments')
    .select('fee_head_id, target_type, class_node_id, programme_id, programme_level_id, amount, due_date, term_id')
    .eq('school_id', schoolId).eq('session_id', sessionId).is('voided_at', null)
  if (termId) q = q.eq('term_id', termId)
  const { data, error } = await q
  if (error) throw new Error(error.message)
  return ((data ?? []) as any[]).filter(r => r.target_type !== 'student').map(r => ({ ...r, amount: Number(r.amount) })) as FeeRow[]
}

interface TeachRow { id: string; staff_id: string; subject_id: string; class_node_id: string }
const teachKey = (t: { staff_id: string; subject_id: string; class_node_id: string }) => `${t.staff_id}|${t.subject_id}|${t.class_node_id}`

async function loadTeaching(sessionId: string): Promise<TeachRow[]> {
  const { data, error } = await supabase.from('teaching_assignments')
    .select('id, staff_id, subject_id, class_node_id').eq('session_id', sessionId)
  if (error) throw new Error(error.message)
  return (data ?? []) as TeachRow[]
}

function sameScope(a: CarryScope, b: CarryScope) { return a.sessionId === b.sessionId && (a.termId ?? '') === (b.termId ?? '') }

export async function previewCarryOver(
  schoolId: string, kind: CarryKind, from: CarryScope, to: CarryScope, opts: CarryOptions,
): Promise<Result<CarryPreview>> {
  try {
    if (sameScope(from, to)) return { ok: false, error: 'Choose two different periods — copying a period onto itself does nothing.' }
    const notes: string[] = []

    if (kind === 'offerings') {
      const [src, existing] = await Promise.all([loadOfferings(from.sessionId, from.termId), loadOfferings(to.sessionId, to.termId)])
      const have = new Set(existing.map(o => offeringKey(o, to.termId)))
      const fresh = src.filter(o => !have.has(offeringKey(o, to.termId)))
      if (opts.keepLecturers) notes.push('Lecturers stay assigned to their courses. You can change them afterwards.')
      if (opts.includeTimetable) {
        const ids = fresh.map(o => o.id)
        const { count } = ids.length
          ? await supabase.from('course_offering_timetable_entries').select('id', { count: 'exact', head: true }).in('course_offering_id', ids)
          : { count: 0 }
        notes.push(`${count ?? 0} timetable slot${count === 1 ? '' : 's'} will be copied with them — check for clashes afterwards.`)
      }
      return { ok: true, data: { sourceCount: src.length, newCount: fresh.length, duplicateCount: src.length - fresh.length, notes } }
    }

    if (kind === 'fees') {
      const [src, existing] = await Promise.all([loadFees(schoolId, from.sessionId, from.termId), loadFees(schoolId, to.sessionId, to.termId)])
      const have = new Set(existing.map(f => feeKey(f, to.termId)))
      const fresh = src.filter(f => !have.has(feeKey(f, to.termId)))
      const total = fresh.reduce((n, f) => n + f.amount * (1 + opts.upliftPercent / 100), 0)
      notes.push('Fees set for individual students are not copied — they belong to that session.')
      if (opts.upliftPercent !== 0) notes.push(`Amounts change by ${opts.upliftPercent > 0 ? '+' : ''}${opts.upliftPercent}%.`)
      notes.push(`Total per student-fee: ₦${Math.round(total).toLocaleString('en-NG')} across the copied assignments.`)
      return { ok: true, data: { sourceCount: src.length, newCount: fresh.length, duplicateCount: src.length - fresh.length, notes } }
    }

    const [src, existing] = await Promise.all([loadTeaching(from.sessionId), loadTeaching(to.sessionId)])
    const have = new Set(existing.map(teachKey))
    const fresh = src.filter(t => !have.has(teachKey(t)))
    if (opts.includeTimetable) {
      const { count } = await supabase.from('timetable_entries').select('id', { count: 'exact', head: true }).eq('school_id', schoolId).eq('session_id', from.sessionId)
      notes.push(`Up to ${count ?? 0} timetable slot${count === 1 ? '' : 's'} will be copied. Slots already filled in the new session are kept as they are.`)
    }
    return { ok: true, data: { sourceCount: src.length, newCount: fresh.length, duplicateCount: src.length - fresh.length, notes } }
  } catch (e) { return fail(e) }
}

// ─── Run ─────────────────────────────────────────────────────────────────────

export async function runCarryOver(
  schoolId: string, kind: CarryKind, from: CarryScope, to: CarryScope, opts: CarryOptions,
): Promise<Result<CarryResult>> {
  try {
    if (sameScope(from, to)) return { ok: false, error: 'Choose two different periods.' }

    if (kind === 'offerings') {
      const [src, existing] = await Promise.all([loadOfferings(from.sessionId, from.termId), loadOfferings(to.sessionId, to.termId)])
      const have = new Set(existing.map(o => offeringKey(o, to.termId)))
      const fresh = src.filter(o => !have.has(offeringKey(o, to.termId)))
      const rows = fresh.map(o => ({
        course_id: o.course_id, session_id: to.sessionId, term_id: to.termId,
        staff_id: opts.keepLecturers ? o.staff_id : null,
        programme_id: o.programme_id, programme_level_id: o.programme_level_id,
        attendance_eligibility_threshold_pct: o.attendance_eligibility_threshold_pct,
      }))
      const created = await insertChunks('course_offerings', rows, 'id, course_id, programme_id, programme_level_id')
      let timetable = 0
      if (opts.includeTimetable && created.length > 0) {
        const newIdByKey = new Map<string, string>(created.map((c: any) => [offeringKey(c, to.termId), c.id as string]))
        const oldToNew = new Map<string, string>()
        for (const o of fresh) { const id = newIdByKey.get(offeringKey(o, to.termId)); if (id) oldToNew.set(o.id, id) }
        const { data: slots, error } = await supabase.from('course_offering_timetable_entries')
          .select('course_offering_id, day_of_week, start_time, end_time, venue')
          .in('course_offering_id', fresh.map(o => o.id))
        if (error) throw new Error(error.message)
        const slotRows = (slots ?? []).map((s: any) => ({
          school_id: schoolId, course_offering_id: oldToNew.get(s.course_offering_id), day_of_week: s.day_of_week,
          start_time: s.start_time, end_time: s.end_time, venue: s.venue,
        })).filter(r => r.course_offering_id)
        await insertChunks('course_offering_timetable_entries', slotRows)
        timetable = slotRows.length
      }
      return { ok: true, data: { created: created.length, skipped: src.length - fresh.length, timetable } }
    }

    if (kind === 'fees') {
      const [src, existing] = await Promise.all([loadFees(schoolId, from.sessionId, from.termId), loadFees(schoolId, to.sessionId, to.termId)])
      const have = new Set(existing.map(f => feeKey(f, to.termId)))
      const fresh = src.filter(f => !have.has(feeKey(f, to.termId)))
      const gap = dayGap(from.startDate, to.startDate)
      const rows = fresh.map(f => ({
        school_id: schoolId, session_id: to.sessionId, term_id: to.termId, fee_head_id: f.fee_head_id,
        target_type: f.target_type, class_node_id: f.class_node_id, student_id: null,
        programme_id: f.programme_id, programme_level_id: f.programme_level_id,
        amount: Math.max(0, Math.round(f.amount * (1 + opts.upliftPercent / 100) * 100) / 100),
        due_date: opts.shiftDueDates && f.due_date ? shiftDate(f.due_date, gap) : null,
      }))
      const created = await insertChunks('fee_assignments', rows)
      return { ok: true, data: { created: created.length || rows.length, skipped: src.length - fresh.length, timetable: 0 } }
    }

    // teaching (+ timetable)
    const [src, existing] = await Promise.all([loadTeaching(from.sessionId), loadTeaching(to.sessionId)])
    const have = new Set(existing.map(teachKey))
    const fresh = src.filter(t => !have.has(teachKey(t)))
    const created = await insertChunks('teaching_assignments',
      fresh.map(t => ({ school_id: schoolId, session_id: to.sessionId, staff_id: t.staff_id, subject_id: t.subject_id, class_node_id: t.class_node_id })),
      'id, staff_id, subject_id, class_node_id')
    let timetable = 0
    if (opts.includeTimetable) {
      const targetNow = [...existing, ...created] as TeachRow[]
      const newIdByKey = new Map(targetNow.map(t => [teachKey(t), t.id]))
      const oldKey = new Map(src.map(t => [t.id, teachKey(t)]))
      const [srcSlots, tgtSlots] = await Promise.all([
        supabase.from('timetable_entries').select('day_of_week, period_id, class_node_id, teaching_assignment_id, subject_id').eq('school_id', schoolId).eq('session_id', from.sessionId),
        supabase.from('timetable_entries').select('day_of_week, period_id, class_node_id').eq('school_id', schoolId).eq('session_id', to.sessionId),
      ])
      if (srcSlots.error) throw new Error(srcSlots.error.message)
      const taken = new Set((tgtSlots.data ?? []).map((s: any) => `${s.day_of_week}|${s.period_id}|${s.class_node_id}`))
      const slotRows = (srcSlots.data ?? [])
        .filter((s: any) => !taken.has(`${s.day_of_week}|${s.period_id}|${s.class_node_id}`))
        .map((s: any) => ({
          school_id: schoolId, session_id: to.sessionId, day_of_week: s.day_of_week, period_id: s.period_id,
          class_node_id: s.class_node_id, subject_id: s.subject_id,
          teaching_assignment_id: s.teaching_assignment_id ? (newIdByKey.get(oldKey.get(s.teaching_assignment_id) ?? '') ?? null) : null,
        }))
      await insertChunks('timetable_entries', slotRows)
      timetable = slotRows.length
    }
    return { ok: true, data: { created: created.length, skipped: src.length - fresh.length, timetable } }
  } catch (e) { return fail(e) }
}
