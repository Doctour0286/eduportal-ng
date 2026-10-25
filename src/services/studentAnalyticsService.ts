/**
 * studentAnalyticsService.ts — everything the student Analytics tab shows,
 * computed for one student over a chosen duration.
 *
 * Which sections follow the duration filter (and which can't):
 *   attendance  — fully: totals, calendar, weekday pattern, monthly bars
 *   record      — fully: suspensions, fines/tasks, reactivations in range
 *   fees        — payments received in the range; the billed/paid/balance
 *                 position is as of the session (a balance isn't "per week")
 *   academics   — scores aren't dated, they belong to a term. The range maps
 *                 to the term it falls in; the term-by-term trend always
 *                 shows the whole session.
 *
 * Reuses portalService's student-level loaders (attendance summary incl.
 * class average, fee summary, payment history) so numbers match what the
 * guardian portal shows. Each section loads independently — one failing
 * query shows an error on that section, not a blank page.
 */
import { supabase } from '../lib/supabase'
import { getSchoolDayMap } from './attendanceService'
import {
  loadAttendanceSummary,
  loadFeeSummary,
  loadCurrentSession,
  loadTermsForSession,
  loadSchoolUsesTerms,
  type AttendanceSummary,
  type FeeSummary,
  type PortalSession,
  type PortalTerm,
} from './portalService'
import { loadAttendanceDeactivationSettings } from './settingsService'
import { loadRulesContext, resolveEffectiveRule } from './attendanceRules'
import { formatObligationAmount, loadStudentObligations } from './obligationsService'

type Ok<T> = { ok: true; data: T }
type Err = { ok: false; error: string }
type Result<T> = Ok<T> | Err

// ─── Duration filter ─────────────────────────────────────────────────────────

export type DurationPreset = 'days7' | 'days30' | 'term' | 'last_term' | 'session' | 'custom'

export interface DurationContext {
  session: PortalSession | null
  terms: PortalTerm[]
  usesTerms: boolean
  today: string
}

export interface DateRange {
  from: string
  to: string
  label: string
  /** The term whose results apply to this range (null = school has no terms). */
  termId: string | null
}

export function ymd(d: Date): string {
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-')
}

function addDays(date: string, n: number): string {
  const d = new Date(date + 'T00:00:00')
  d.setDate(d.getDate() + n)
  return ymd(d)
}

export async function loadDurationContext(schoolId: string): Promise<DurationContext> {
  const [session, usesTerms] = await Promise.all([loadCurrentSession(schoolId), loadSchoolUsesTerms(schoolId)])
  const terms = session && usesTerms ? await loadTermsForSession(session.id) : []
  return { session, terms, usesTerms, today: ymd(new Date()) }
}

function currentTerm(ctx: DurationContext): PortalTerm | null {
  if (ctx.terms.length === 0) return null
  const inside = ctx.terms.find(t => t.start_date <= ctx.today && ctx.today <= t.end_date)
  if (inside) return inside
  // Between terms: the latest one that has already started.
  const started = ctx.terms.filter(t => t.start_date <= ctx.today)
  return started.length ? started[started.length - 1] : ctx.terms[0]
}

function termFor(date: string, ctx: DurationContext): PortalTerm | null {
  return ctx.terms.find(t => t.start_date <= date && date <= t.end_date) ?? currentTerm(ctx)
}

export function availablePresets(ctx: DurationContext): { value: DurationPreset; label: string }[] {
  const out: { value: DurationPreset; label: string }[] = [
    { value: 'days7', label: 'Last 7 days' },
    { value: 'days30', label: 'Last 30 days' },
  ]
  if (ctx.usesTerms && ctx.terms.length > 0) {
    out.push({ value: 'term', label: 'This term' })
    const cur = currentTerm(ctx)
    if (cur && cur.sequence > 1) out.push({ value: 'last_term', label: 'Last term' })
  }
  if (ctx.session) out.push({ value: 'session', label: 'This session' })
  out.push({ value: 'custom', label: 'Custom range' })
  return out
}

export function resolveRange(
  preset: DurationPreset,
  ctx: DurationContext,
  custom?: { from: string; to: string },
): DateRange {
  const today = ctx.today
  const clampEnd = (end: string) => (end > today ? today : end)
  const withTerm = (from: string, to: string, label: string): DateRange =>
    ({ from, to, label, termId: ctx.usesTerms ? (termFor(to, ctx)?.id ?? null) : null })

  switch (preset) {
    case 'days7':
      return withTerm(addDays(today, -6), today, 'Last 7 days')
    case 'days30':
      return withTerm(addDays(today, -29), today, 'Last 30 days')
    case 'term': {
      const t = currentTerm(ctx)
      if (t) return { from: t.start_date, to: clampEnd(t.end_date), label: t.name, termId: t.id }
      break
    }
    case 'last_term': {
      const cur = currentTerm(ctx)
      const prev = cur ? ctx.terms.find(t => t.sequence === cur.sequence - 1) : null
      if (prev) return { from: prev.start_date, to: prev.end_date, label: prev.name, termId: prev.id }
      break
    }
    case 'session':
      if (ctx.session) {
        const cur = currentTerm(ctx)
        return {
          from: ctx.session.start_date,
          to: clampEnd(ctx.session.end_date),
          label: ctx.session.name,
          termId: cur?.id ?? null,
        }
      }
      break
    case 'custom':
      if (custom && custom.from && custom.to && custom.from <= custom.to) {
        return withTerm(custom.from, clampEnd(custom.to), 'Custom range')
      }
      break
  }
  return withTerm(addDays(today, -29), today, 'Last 30 days')
}

// ─── Result types ────────────────────────────────────────────────────────────

export type DayStatus = 'present' | 'absent' | 'late' | 'excused' | 'unmarked'

export interface AttendanceDetail {
  summary: AttendanceSummary
  days: { date: string; status: DayStatus }[]      // school days only
  // One entry per weekday the school actually holds classes (from the school
  // calendar, so a Saturday school or a short week is respected), in
  // Monday-first order. percent = present+late over marked days.
  byWeekday: { label: string; present: number; absent: number; percent: number | null }[]
  longestAbsentRun: number
  lateCount: number
  monthly: { key: string; label: string; percent: number | null; absent: number }[]
}

export interface SubjectAnalytics {
  subject_id: string
  name: string
  total: number | null
  grade: string | null
  position: number | null
  classAverage: number | null
  deltaVsPrev: number | null
  trend: { termId: string; termName: string; total: number | null }[]
}

export interface AcademicsDetail {
  termId: string | null
  termName: string
  rangeNote: string | null
  average: number | null
  classAverage: number | null
  prevAverage: number | null
  overallPosition: number | null
  classSize: number
  subjects: SubjectAnalytics[]
  termAverages: { termId: string; termName: string; average: number | null }[]
}

export interface FeePayment {
  id: string
  amount: number
  method: string
  paid_at: string | null
  notes: string | null
  fee_head_name: string | null
  received_by_name: string | null
}

export interface FeesDetail {
  summary: FeeSummary
  allPayments: FeePayment[]          // full history, newest first
  paymentsInRange: FeePayment[]
  paidInRange: number
}

export interface StudentIdentity {
  full_name: string
  photo_path: string | null
  student_code: string | null
  class_name: string | null
  status: string
  gender: string | null
}

export type RecordKind = 'suspended' | 'reactivated' | 'fine' | 'task' | 'query' | 'resolved'

export interface RecordEntry {
  id: string
  at: string
  kind: RecordKind
  title: string
  detail: string | null
  by: string | null
}

export type FlagSection = 'attendance' | 'academics' | 'fees' | 'record'

export interface AnalyticsFlag {
  id: string
  section: FlagSection
  text: string
}

export interface SectionResult<T> { data: T | null; error: string | null }

export interface StudentAnalytics {
  range: DateRange
  attendance: SectionResult<AttendanceDetail>
  academics: SectionResult<AcademicsDetail>
  fees: SectionResult<FeesDetail> | null          // null = not permitted / not requested
  record: SectionResult<RecordEntry[]> | null
  openObligations: number
  suspensionsInRange: number
  flags: AnalyticsFlag[]
}

async function settle<T>(fn: () => Promise<T>): Promise<SectionResult<T>> {
  try { return { data: await fn(), error: null } }
  catch (err: any) { return { data: null, error: err?.message ?? 'Could not load this section' } }
}

// ─── Attendance ──────────────────────────────────────────────────────────────

const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0]
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

async function buildAttendance(schoolId: string, studentId: string, range: DateRange): Promise<AttendanceDetail> {
  const [summary, recRes, dayMapRes] = await Promise.all([
    loadAttendanceSummary(schoolId, studentId, range.from, range.to),
    supabase
      .from('attendance_records')
      .select('date, status')
      .eq('school_id', schoolId)
      .eq('student_id', studentId)
      .gte('date', range.from)
      .lte('date', range.to),
    getSchoolDayMap(range.from, range.to, schoolId),
  ])
  if (recRes.error) throw new Error(recRes.error.message)

  const recs = new Map<string, DayStatus>()
  for (const r of recRes.data ?? []) recs.set(r.date, r.status as DayStatus)
  const dayMap = dayMapRes.ok ? dayMapRes.data : new Map<string, boolean>()

  const days: AttendanceDetail['days'] = []
  for (let d = range.from; d <= range.to; d = addDays(d, 1)) {
    if (dayMap.get(d) ?? false) days.push({ date: d, status: recs.get(d) ?? 'unmarked' })
  }

  const perDow = new Map<number, { present: number; absent: number }>()
  let run = 0, longest = 0, late = 0
  for (const d of days) {
    const dow = new Date(d.date + 'T00:00:00').getDay()
    const bucket = perDow.get(dow) ?? { present: 0, absent: 0 }
    if (d.status === 'absent') {
      run += 1
      if (run > longest) longest = run
      bucket.absent += 1
    } else {
      run = 0
    }
    if (d.status === 'present' || d.status === 'late') bucket.present += 1
    if (d.status === 'late') late += 1
    perDow.set(dow, bucket)
  }
  const byWeekday = DOW_ORDER.filter(dow => perDow.has(dow)).map(dow => {
    const b = perDow.get(dow)!
    const marked = b.present + b.absent
    return {
      label: DOW_LABELS[dow],
      present: b.present,
      absent: b.absent,
      percent: marked > 0 ? Math.round((b.present / marked) * 100) : null,
    }
  })

  const monthly: AttendanceDetail['monthly'] = []
  const span = (new Date(range.to).getTime() - new Date(range.from).getTime()) / 86_400_000
  if (span > 35) {
    const groups = new Map<string, { present: number; absent: number }>()
    for (const d of days) {
      const key = d.date.slice(0, 7)
      const g = groups.get(key) ?? { present: 0, absent: 0 }
      if (d.status === 'present' || d.status === 'late') g.present += 1
      if (d.status === 'absent') g.absent += 1
      groups.set(key, g)
    }
    for (const [key, g] of [...groups.entries()].sort()) {
      const marked = g.present + g.absent
      monthly.push({
        key,
        label: MONTHS[Number(key.slice(5, 7)) - 1],
        percent: marked > 0 ? Math.round((g.present / marked) * 100) : null,
        absent: g.absent,
      })
    }
  }

  return { summary, days, byWeekday, longestAbsentRun: longest, lateCount: late, monthly }
}

// ─── Academics ───────────────────────────────────────────────────────────────

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
}
const round1 = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10)

async function buildAcademics(
  schoolId: string,
  studentId: string,
  classNodeId: string | null,
  range: DateRange,
  ctx: DurationContext,
): Promise<AcademicsDetail> {
  if (!ctx.session) throw new Error('No current session is set up yet.')

  // The student plus classmates — class averages and rank need everyone.
  let peerIds = [studentId]
  if (classNodeId) {
    const { data: peers, error } = await supabase
      .from('students')
      .select('id')
      .eq('school_id', schoolId)
      .eq('class_node_id', classNodeId)
      .eq('status', 'active')
    if (error) throw new Error(error.message)
    peerIds = [...new Set([studentId, ...(peers ?? []).map(p => p.id as string)])]
  }

  const [rowsRes, subjRes] = await Promise.all([
    supabase
      .from('subject_results')
      .select('student_id, subject_id, term_id, weighted_total, grade_label, position_in_class')
      .eq('session_id', ctx.session.id)
      .in('student_id', peerIds),
    supabase.from('subjects').select('id, name').eq('school_id', schoolId),
  ])
  if (rowsRes.error) throw new Error(rowsRes.error.message)
  const names = new Map<string, string>((subjRes.data ?? []).map(s => [s.id as string, s.name as string]))
  const rows = rowsRes.data ?? []

  const termList = ctx.usesTerms
    ? ctx.terms
    : [{ id: '', name: ctx.session.name, sequence: 1, start_date: '', end_date: '' } as PortalTerm]
  const termKey = (t: PortalTerm) => (ctx.usesTerms ? t.id : null)
  const inTerm = (r: any, t: PortalTerm) => (ctx.usesTerms ? r.term_id === t.id : r.term_id === null)

  // Average + rank per term.
  const perTerm = termList.map(t => {
    const byStudent = new Map<string, number[]>()
    for (const r of rows.filter(x => inTerm(x, t))) {
      if (r.weighted_total === null || r.weighted_total === undefined) continue
      const arr = byStudent.get(r.student_id) ?? []
      arr.push(Number(r.weighted_total))
      byStudent.set(r.student_id, arr)
    }
    const avgs = new Map<string, number>()
    for (const [sid, arr] of byStudent) avgs.set(sid, mean(arr)!)
    const mine = avgs.get(studentId) ?? null
    const all = [...avgs.values()]
    const position = mine === null ? null : 1 + all.filter(v => v > mine).length
    return { term: t, mine, classAvg: mean(all), position, size: all.length }
  })

  const selectedTerm =
    termList.find(t => termKey(t) === range.termId) ?? termList[termList.length - 1]
  const selIdx = termList.indexOf(selectedTerm)
  const sel = perTerm[selIdx]
  const prev = selIdx > 0 ? perTerm[selIdx - 1] : null

  const subjectIds = [...new Set(rows.filter(r => r.student_id === studentId).map(r => r.subject_id as string))]
  const subjects: SubjectAnalytics[] = subjectIds.map(sid => {
    const mineIn = (t: PortalTerm) => rows.find(r => r.student_id === studentId && r.subject_id === sid && inTerm(r, t))
    const cur = mineIn(selectedTerm)
    const before = prev ? mineIn(prev.term) : null
    const classVals = rows
      .filter(r => r.subject_id === sid && inTerm(r, selectedTerm) && r.weighted_total !== null)
      .map(r => Number(r.weighted_total))
    const total = cur && cur.weighted_total !== null ? Number(cur.weighted_total) : null
    const prevTotal = before && before.weighted_total !== null ? Number(before.weighted_total) : null
    return {
      subject_id: sid,
      name: names.get(sid) ?? 'Subject',
      total: round1(total),
      grade: cur?.grade_label ?? null,
      position: cur?.position_in_class ?? null,
      classAverage: round1(mean(classVals)),
      deltaVsPrev: total !== null && prevTotal !== null ? round1(total - prevTotal) : null,
      trend: termList.map(t => {
        const r = mineIn(t)
        return { termId: t.id, termName: t.name, total: r && r.weighted_total !== null ? round1(Number(r.weighted_total)) : null }
      }),
    }
  }).sort((a, b) => a.name.localeCompare(b.name))

  const rangeNote = ctx.usesTerms && (range.label === 'Last 7 days' || range.label === 'Last 30 days' || range.label === 'Custom range' || range.label === ctx.session.name)
    ? `Scores belong to a term, not a date. Showing ${selectedTerm.name}.`
    : null

  return {
    termId: range.termId,
    termName: selectedTerm.name,
    rangeNote,
    average: round1(sel.mine),
    classAverage: round1(sel.classAvg),
    prevAverage: prev ? round1(prev.mine) : null,
    overallPosition: sel.position,
    classSize: sel.size,
    subjects,
    termAverages: perTerm.map(p => ({ termId: p.term.id, termName: p.term.name, average: round1(p.mine) })),
  }
}

// ─── Fees ────────────────────────────────────────────────────────────────────

async function buildFees(schoolId: string, studentId: string, range: DateRange, ctx: DurationContext): Promise<FeesDetail> {
  if (!ctx.session) throw new Error('No current session is set up yet.')
  const [summary, payRes] = await Promise.all([
    loadFeeSummary(schoolId, studentId, ctx.session.id),
    supabase
      .from('payments')
      .select('id, amount, method, paid_at, notes, received_by, fee_assignments ( fee_heads ( name ) )')
      .eq('school_id', schoolId)
      .eq('student_id', studentId)
      .eq('status', 'completed')
      .order('paid_at', { ascending: false }),
  ])
  if (payRes.error) throw new Error(payRes.error.message)

  const staffIds = [...new Set((payRes.data ?? []).map(p => p.received_by).filter(Boolean))] as string[]
  const names = new Map<string, string>()
  if (staffIds.length > 0) {
    const { data } = await supabase.from('staff').select('id, full_name').in('id', staffIds)
    for (const st of data ?? []) names.set(st.id as string, st.full_name as string)
  }

  const one = (x: any) => (Array.isArray(x) ? x[0] : x)
  const allPayments: FeePayment[] = (payRes.data ?? []).map((p: any) => ({
    id: p.id,
    amount: Number(p.amount),
    method: p.method,
    paid_at: p.paid_at ?? null,
    notes: p.notes ?? null,
    fee_head_name: one(one(p.fee_assignments)?.fee_heads)?.name ?? null,
    // Gateway payments (e.g. Remita) have no staff recorder.
    received_by_name: p.received_by ? (names.get(p.received_by) ?? null) : null,
  }))
  const paymentsInRange = allPayments.filter(p => {
    if (!p.paid_at) return false
    const d = p.paid_at.slice(0, 10)
    return d >= range.from && d <= range.to
  })
  return { summary, allPayments, paymentsInRange, paidInRange: paymentsInRange.reduce((n, p) => n + p.amount, 0) }
}

export async function loadStudentIdentity(studentId: string): Promise<StudentIdentity | null> {
  const { data } = await supabase
    .from('students')
    .select('full_name, photo_url, student_code, status, gender, class_node_id')
    .eq('id', studentId)
    .maybeSingle()
  if (!data) return null
  let className: string | null = null
  if (data.class_node_id) {
    const { data: node } = await supabase.from('class_nodes').select('name').eq('id', data.class_node_id).maybeSingle()
    className = (node?.name as string | undefined) ?? null
  }
  return {
    full_name: data.full_name as string,
    photo_path: (data.photo_url as string | null) ?? null,
    student_code: (data.student_code as string | null) ?? null,
    class_name: className,
    status: data.status as string,
    gender: (data.gender as string | null) ?? null,
  }
}

// ─── Record (suspensions, fines, tasks) ──────────────────────────────────────

async function buildRecord(schoolId: string, studentId: string, range: DateRange): Promise<{ entries: RecordEntry[]; suspensions: number }> {
  const [histRes, oblRes] = await Promise.all([
    supabase
      .from('student_status_history')
      .select('id, event, reason, note, consecutive_count, cumulative_count, changed_by, created_at')
      .eq('school_id', schoolId)
      .eq('student_id', studentId)
      .order('created_at', { ascending: false }),
    loadStudentObligations(studentId),
  ])
  if (histRes.error) throw new Error(histRes.error.message)
  if (!oblRes.ok) throw new Error(oblRes.error)

  const staffIds = [...new Set((histRes.data ?? []).map(h => h.changed_by).filter(Boolean))] as string[]
  const names = new Map<string, string>()
  if (staffIds.length > 0) {
    const { data } = await supabase.from('staff').select('id, full_name').in('id', staffIds)
    for (const s of data ?? []) names.set(s.id as string, s.full_name as string)
  }

  const inRange = (iso: string) => {
    const d = iso.slice(0, 10)
    return d >= range.from && d <= range.to
  }
  const entries: RecordEntry[] = []
  let suspensions = 0

  for (const h of histRes.data ?? []) {
    if (!inRange(h.created_at)) continue
    const by = h.changed_by ? (names.get(h.changed_by) ?? null) : null
    if (h.event === 'inactivated') {
      suspensions += 1
      entries.push({
        id: `h-${h.id}`, at: h.created_at, kind: 'suspended', by,
        title: h.reason === 'attendance_auto' ? 'Suspended automatically' : 'Marked inactive',
        detail: h.reason === 'attendance_auto'
          ? `${h.consecutive_count ?? 0} days in a row · ${h.cumulative_count ?? 0} absences in total`
          : (h.note ?? null),
      })
    } else {
      entries.push({ id: `h-${h.id}`, at: h.created_at, kind: 'reactivated', by, title: 'Reactivated', detail: h.note ?? null })
    }
  }

  for (const o of oblRes.data) {
    const label = o.kind === 'fine' ? `Fine ${formatObligationAmount(o.amount ?? 0)}` : o.kind === 'query' ? 'Query issued' : 'Task assigned'
    if (inRange(o.created_at)) {
      entries.push({ id: `o-${o.id}`, at: o.created_at, kind: o.kind, by: o.created_by_name, title: label, detail: o.description })
    }
    if (o.status !== 'pending' && o.resolved_at && inRange(o.resolved_at)) {
      const verb = o.status === 'waived' ? 'waived' : o.kind === 'fine' ? 'paid' : o.kind === 'query' ? 'responded' : 'done'
      entries.push({
        id: `r-${o.id}`, at: o.resolved_at, kind: 'resolved', by: o.resolved_by_name,
        title: `${o.kind === 'fine' ? 'Fine' : o.kind === 'query' ? 'Query' : 'Task'} ${verb}`,
        detail: [o.description, o.resolution_note].filter(Boolean).join(' — ') || null,
      })
    }
  }

  entries.sort((a, b) => b.at.localeCompare(a.at))
  return { entries, suspensions }
}

// ─── Main loader ─────────────────────────────────────────────────────────────

export async function loadStudentAnalytics(params: {
  schoolId: string
  studentId: string
  range: DateRange
  ctx: DurationContext
  includeFinanceAndConduct: boolean
}): Promise<Result<StudentAnalytics>> {
  const { schoolId, studentId, range, ctx, includeFinanceAndConduct } = params
  try {
    const { data: stu, error: stuErr } = await supabase
      .from('students')
      .select('class_node_id, status, deactivation_reason, consecutive_absent_count, cumulative_absent_count')
      .eq('id', studentId)
      .maybeSingle()
    if (stuErr) return { ok: false, error: stuErr.message }
    if (!stu) return { ok: false, error: 'Student not found.' }
    const classNodeId = (stu.class_node_id as string | null) ?? null

    const [attendance, academics, fees, recordRaw, oblPending, rule] = await Promise.all([
      settle(() => buildAttendance(schoolId, studentId, range)),
      settle(() => buildAcademics(schoolId, studentId, classNodeId, range, ctx)),
      includeFinanceAndConduct ? settle(() => buildFees(schoolId, studentId, range, ctx)) : Promise.resolve(null),
      includeFinanceAndConduct ? settle(() => buildRecord(schoolId, studentId, range)) : Promise.resolve(null),
      includeFinanceAndConduct ? loadStudentObligations(studentId) : Promise.resolve(null),
      Promise.all([loadAttendanceDeactivationSettings(schoolId), loadRulesContext(schoolId)]),
    ])

    const record: SectionResult<RecordEntry[]> | null = recordRaw
      ? { data: recordRaw.data?.entries ?? null, error: recordRaw.error }
      : null
    const suspensionsInRange = recordRaw?.data?.suspensions ?? 0
    const pending = oblPending && oblPending.ok ? oblPending.data.filter(o => o.status === 'pending') : []

    // ── Flags: only what is actually true, each pointing at its section ──
    const flags: AnalyticsFlag[] = []

    if (stu.status === 'inactive' && stu.deactivation_reason === 'attendance_auto') {
      flags.push({ id: 'suspended', section: 'record', text: 'Currently suspended for absences' })
    } else if (rule[0].data && rule[0].data.enabled && rule[1].ok) {
      const s = rule[0].data
      const eff = resolveEffectiveRule(classNodeId, rule[1].data, {
        mode: s.mode, consecutive_threshold: s.consecutive_threshold, cumulative_threshold: s.cumulative_threshold,
      })
      if (!eff.exempt) {
        const count = eff.mode === 'consecutive' ? (stu.consecutive_absent_count ?? 0) : (stu.cumulative_absent_count ?? 0)
        if (eff.threshold - count <= 2 && count > 0) {
          flags.push({
            id: 'near-limit', section: 'attendance',
            text: `${count} of ${eff.threshold} ${eff.mode === 'consecutive' ? 'absences in a row' : 'absences in total'} before suspension`,
          })
        }
      }
    }

    const att = attendance.data?.summary
    if (att && att.percent !== null && att.totalMarkable >= 5) {
      const behindClass = att.classAveragePercent !== null && att.classAveragePercent - att.percent >= 10
      if (att.percent < 80 || behindClass) {
        flags.push({
          id: 'attendance-low', section: 'attendance',
          text: att.classAveragePercent !== null
            ? `Attendance ${att.percent}% (class ${att.classAveragePercent}%)`
            : `Attendance ${att.percent}%`,
        })
      }
    }

    for (const s of academics.data?.subjects ?? []) {
      if (s.deltaVsPrev !== null && s.deltaVsPrev <= -10) {
        flags.push({ id: `drop-${s.subject_id}`, section: 'academics', text: `${s.name} down ${Math.abs(s.deltaVsPrev)} points since last term` })
      }
    }

    const bal = fees?.data?.summary
    if (bal && bal.balance > 0 && bal.totalBilled > 0) {
      flags.push({ id: 'fees', section: 'fees', text: `${formatObligationAmount(bal.balance)} fees outstanding` })
    }

    for (const o of pending) {
      flags.push({
        id: `obl-${o.id}`, section: 'record',
        text: o.kind === 'fine'
          ? `${formatObligationAmount(o.amount ?? 0)} fine unpaid`
          : o.kind === 'query' ? `Query awaiting response: ${o.description}` : `Task not done: ${o.description}`,
      })
    }

    return {
      ok: true,
      data: {
        range,
        attendance,
        academics,
        fees,
        record,
        openObligations: pending.length,
        suspensionsInRange,
        flags,
      },
    }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load analytics' }
  }
}
