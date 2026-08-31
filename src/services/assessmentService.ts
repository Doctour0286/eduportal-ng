/**
 * assessmentService.ts
 * PRD Tier 8 / Problem 8.4 (Sessions 46–49) — data layer for the Assessment
 * Window system: windows, weight profiles, score components, attached
 * classes, venues, exam timetable + invigilators, aggregate remark bands,
 * per-student window remarks, and report-card data assembly.
 *
 * Schema ground truth: §7.14a (migration_tier8_s46/s48/s49 — all confirmed
 * run live). Every table below carries live RLS:
 *   - reads are school-boundary ([STD] or via parent-window join)
 *   - writes require admin OR the matching academics.* permission key,
 *     enforced at the DB layer; this service adds no client-side permission
 *     logic of its own beyond passing caller-provided actor ids.
 *
 * Conventions (same as every other service in this project):
 *   - Result<T> ok/error shape, never thrown for expected failures
 *   - No browser-only APIs (React-Native safe); report-card PDF download is
 *     deliberately split into reportCardPdf.ts where the DOM touch lives.
 *   - schoolId threaded on every call that needs it — never inferred.
 */

import { supabase } from '../lib/supabase'

// ─── Result shape ─────────────────────────────────────────────────────────────

type Ok<T> = { ok: true; data: T }
type Err = { ok: false; error: string }
export type Result<T> = Ok<T> | Err

function err(error: string): Err { return { ok: false, error } }
function friendly(message: string): string {
  if (message.includes('violates row-level security')) {
    return (
      'Your role does not grant this assessment action. In Settings > Roles, either mark your role ' +
      'as an admin role or grant it the matching academics.* permission — then sign out and back in.'
    )
  }
  if (message.includes('null value in column')) {
    return `Save failed (missing data): ${message}`
  }
  if (message.includes('duplicate key')) {
    return 'That entry already exists.'
  }
  return message
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type WindowStatus = 'draft' | 'open' | 'closed' | 'finalized'
export type WindowScope = 'whole_school' | 'selected_classes'

export interface AssessmentWindow {
  id: string
  school_id: string
  session_id: string
  term_id: string | null
  name: string
  scope: WindowScope
  status: WindowStatus
  scores_open_at: string | null
  scores_submission_deadline: string | null
  scores_close_at: string | null
  created_at: string
}

export interface ComponentProfile {
  id: string
  assessment_window_id: string
  name: string
}

export interface ScoreComponentWithMax {
  id: string
  name: string
  weight_pct: number
  max_score: number
  sort_order: number
}

export interface AssessmentWindowClassRow {
  id: string
  assessment_window_id: string
  class_node_id: string
  class_node_name: string
  score_component_profile_id: string
  is_promotional: boolean
  sits_exam: boolean
}

export interface Venue {
  id: string
  name: string
  capacity: number
}

export interface ExamInvigilator {
  staff_id: string
  role: 'lead' | 'assistant'
  staff_name?: string
}

export interface ExamEntry {
  id: string
  assessment_window_id: string
  window_name: string
  class_node_id: string
  class_node_name: string
  subject_id: string
  subject_name: string
  exam_date: string          // yyyy-mm-dd
  start_time: string         // HH:mm:ss
  end_time: string
  venue_id: string | null
  venue_name: string | null
  venue_capacity: number | null
  invigilators: ExamInvigilator[]
}

// ─── Windows ──────────────────────────────────────────────────────────────────

/** All windows for a school (newest first), with session/term names for display. */
export async function loadWindows(schoolId: string): Promise<Result<Array<AssessmentWindow & { session_name: string; term_name: string | null }>>> {
  try {
    const { data, error } = await supabase
      .from('assessment_windows')
      .select(`
        id, school_id, session_id, term_id, name, scope, status,
        scores_open_at, scores_submission_deadline, scores_close_at, created_at,
        sessions ( name ),
        terms ( name )
      `)
      .eq('school_id', schoolId)
      .order('created_at', { ascending: false })

    if (error) return err(friendly(error.message))
    return {
      ok: true,
      data: (data ?? []).map((w: any) => ({
        id: w.id,
        school_id: w.school_id,
        session_id: w.session_id,
        term_id: w.term_id ?? null,
        name: w.name,
        scope: w.scope,
        status: w.status,
        scores_open_at: w.scores_open_at,
        scores_submission_deadline: w.scores_submission_deadline,
        scores_close_at: w.scores_close_at,
        created_at: w.created_at,
        session_name: w.sessions?.name ?? '',
        term_name: w.terms?.name ?? null,
      })),
    }
  } catch (e: any) {
    return err(e?.message ?? 'Failed to load assessment windows')
  }
}

/**
 * Resolves THE window covering one class for a session+term — the same rule
 * the scores-gating trigger applies server-side (§7.14a): whole_school scope
 * covers every class; selected_classes requires an attach row. When multiple
 * windows cover the same class+term (an admin misconfiguration), the newest
 * wins here so the app and the database agree as often as possible.
 */
export async function resolveWindowForClass(params: {
  sessionId: string
  termId: string | null
  classNodeId: string
}): Promise<Result<{ window: AssessmentWindow; windowClass: AssessmentWindowClassRow | null } | null>> {
  try {
    let query = supabase
      .from('assessment_windows')
      .select('*')
      .eq('session_id', params.sessionId)
      .order('created_at', { ascending: false })

    query = params.termId
      ? query.eq('term_id', params.termId)
      : query.is('term_id', null)

    const { data: windows, error } = await query
    if (error) return err(friendly(error.message))
    const candidates = (windows ?? []) as AssessmentWindow[]
    if (candidates.length === 0) return { ok: true, data: null }

    const scoped = candidates.filter(w => w.scope === 'whole_school')
    if (scoped.length > 0) {
      return { ok: true, data: { window: scoped[0], windowClass: null } }
    }

    // selected_classes — find the newest window that has an attach row for
    // this class (and carry the attach row back: it holds the profile id).
    for (const w of candidates) {
      const { data: awc, error: awcErr } = await supabase
        .from('assessment_window_classes')
        .select(`
          id, assessment_window_id, class_node_id,
          score_component_profile_id, is_promotional, sits_exam,
          class_nodes ( name )
        `)
        .eq('assessment_window_id', w.id)
        .eq('class_node_id', params.classNodeId)
        .maybeSingle()

      if (awcErr) return err(friendly(awcErr.message))
      if (awc) {
        return {
          ok: true,
          data: {
            window: w,
            windowClass: {
              id: awc.id,
              assessment_window_id: awc.assessment_window_id,
              class_node_id: awc.class_node_id,
              class_node_name: (awc.class_nodes as any)?.name ?? '',
              score_component_profile_id: awc.score_component_profile_id,
              is_promotional: awc.is_promotional,
              sits_exam: awc.sits_exam,
            },
          },
        }
      }
    }
    return { ok: true, data: null }
  } catch (e: any) {
    return err(e?.message ?? 'Failed to resolve assessment window')
  }
}

export async function createWindow(params: {
  schoolId: string
  sessionId: string
  termId: string | null
  name: string
  scope: WindowScope
  createdBy: string | null   // auth user id (conventions: created_by → auth.users; nullable column)
}): Promise<Result<AssessmentWindow>> {
  try {
    const { data, error } = await supabase
      .from('assessment_windows')
      .insert({
        school_id: params.schoolId,
        session_id: params.sessionId,
        term_id: params.termId,
        name: params.name,
        scope: params.scope,
        status: 'draft',
        created_by: params.createdBy,
      })
      .select('*')
      .single()

    if (error) return err(friendly(error.message))
    const w = data as any

    // Every window starts with one profile so attaching classes always has a
    // valid profile to point at (assessment_window_classes.profile_id is NOT NULL).
    // The insert result IS checked: a silently-failed profile row would leave
    // the window with zero weightings and nothing to attach classes to — the
    // admin would see a window that "can't add components" with no explanation.
    const profIns = await supabase
      .from('score_component_profiles')
      .insert({ assessment_window_id: w.id, name: 'Default weighting' })
    if (profIns.error) {
      return err(
        `Window "${w.name}" was created, but its default weighting profile could not be ` +
        `(${profIns.error.message}). Delete the window and try again, or add a weighting manually.`,
      )
    }

    return { ok: true, data: w as AssessmentWindow }
  } catch (e: any) {
    return err(e?.message ?? 'Failed to create assessment window')
  }
}

export async function updateWindow(windowId: string, patch: {
  name?: string
  scope?: WindowScope
  status?: WindowStatus
  scores_open_at?: string | null
  scores_submission_deadline?: string | null
  scores_close_at?: string | null
}): Promise<Result<AssessmentWindow>> {
  try {
    const { data, error } = await supabase
      .from('assessment_windows')
      .update(patch)
      .eq('id', windowId)
      .select('*')
      .single()
    if (error) return err(friendly(error.message))
    return { ok: true, data: data as AssessmentWindow }
  } catch (e: any) {
    return err(e?.message ?? 'Failed to update assessment window')
  }
}

export async function deleteWindow(windowId: string): Promise<Result<true>> {
  try {
    const { error } = await supabase
      .from('assessment_windows')
      .delete()
      .eq('id', windowId)
    if (error) return err(friendly(error.message))
    return { ok: true, data: true }
  } catch (e: any) {
    return err(e?.message ?? 'Failed to delete assessment window')
  }
}

// ─── Attached classes ─────────────────────────────────────────────────────────

/**
 * Per-window setup counts for list rendering (classes attached + weightings
 * defined), in two batched queries — never one query per window.
 */
export async function loadWindowSummaries(
  windowIds: string[],
): Promise<Result<Map<string, { classes: number; profiles: number }>>> {
  const map = new Map<string, { classes: number; profiles: number }>()
  if (windowIds.length === 0) return { ok: true, data: map }
  try {
    const [awcRes, profRes] = await Promise.all([
      supabase
        .from('assessment_window_classes')
        .select('assessment_window_id')
        .in('assessment_window_id', windowIds),
      supabase
        .from('score_component_profiles')
        .select('assessment_window_id')
        .in('assessment_window_id', windowIds),
    ])
    if (awcRes.error) return err(friendly(awcRes.error.message))
    if (profRes.error) return err(friendly(profRes.error.message))
    for (const id of windowIds) map.set(id, { classes: 0, profiles: 0 })
    for (const r of awcRes.data ?? []) {
      const cur = map.get(r.assessment_window_id)
      if (cur) cur.classes += 1
    }
    for (const r of profRes.data ?? []) {
      const cur = map.get(r.assessment_window_id)
      if (cur) cur.profiles += 1
    }
    return { ok: true, data: map }
  } catch (e: any) {
    return err(e?.message ?? 'Failed to load window summaries')
  }
}

export async function loadWindowClasses(windowId: string): Promise<Result<AssessmentWindowClassRow[]>> {
  try {
    const { data, error } = await supabase
      .from('assessment_window_classes')
      .select(`
        id, assessment_window_id, class_node_id,
        score_component_profile_id, is_promotional, sits_exam,
        class_nodes ( name )
      `)
      .eq('assessment_window_id', windowId)

    if (error) return err(friendly(error.message))
    return {
      ok: true,
      data: (data ?? []).map((r: any) => ({
        id: r.id,
        assessment_window_id: r.assessment_window_id,
        class_node_id: r.class_node_id,
        class_node_name: r.class_nodes?.name ?? '',
        score_component_profile_id: r.score_component_profile_id,
        is_promotional: r.is_promotional,
        sits_exam: r.sits_exam,
      })),
    }
  } catch (e: any) {
    return err(e?.message ?? 'Failed to load window classes')
  }
}

export async function attachClassesToWindow(windowId: string, classNodeIds: string[], profileId: string): Promise<Result<true>> {
  if (classNodeIds.length === 0) return { ok: true, data: true }
  try {
    const { error } = await supabase
      .from('assessment_window_classes')
      .upsert(
        classNodeIds.map(class_node_id => ({
          assessment_window_id: windowId,
          class_node_id,
          score_component_profile_id: profileId,
        })),
        { onConflict: 'assessment_window_id,class_node_id', ignoreDuplicates: true },
      )
    if (error) return err(friendly(error.message))
    return { ok: true, data: true }
  } catch (e: any) {
    return err(e?.message ?? 'Failed to attach classes')
  }
}

export async function updateWindowClass(rowId: string, patch: {
  score_component_profile_id?: string
  is_promotional?: boolean
  sits_exam?: boolean
}): Promise<Result<true>> {
  try {
    const { error } = await supabase
      .from('assessment_window_classes')
      .update(patch)
      .eq('id', rowId)
    if (error) return err(friendly(error.message))
    return { ok: true, data: true }
  } catch (e: any) {
    return err(e?.message ?? 'Failed to update class settings')
  }
}

export async function detachClassFromWindow(rowId: string): Promise<Result<true>> {
  try {
    const { error } = await supabase
      .from('assessment_window_classes')
      .delete()
      .eq('id', rowId)
    if (error) return err(friendly(error.message))
    return { ok: true, data: true }
  } catch (e: any) {
    return err(e?.message ?? 'Failed to remove class from window')
  }
}

// ─── Weight profiles ──────────────────────────────────────────────────────────

export async function loadProfiles(windowId: string): Promise<Result<ComponentProfile[]>> {
  try {
    const { data, error } = await supabase
      .from('score_component_profiles')
      .select('id, assessment_window_id, name')
      .eq('assessment_window_id', windowId)
      .order('created_at')
    if (error) return err(friendly(error.message))
    return { ok: true, data: data ?? [] }
  } catch (e: any) {
    return err(e?.message ?? 'Failed to load weight profiles')
  }
}

export async function saveProfile(windowId: string, opts: { id?: string; name: string }): Promise<Result<ComponentProfile>> {
  try {
    if (opts.id) {
      const { data, error } = await supabase
        .from('score_component_profiles')
        .update({ name: opts.name })
        .eq('id', opts.id)
        .select('*')
        .single()
      if (error) return err(friendly(error.message))
      return { ok: true, data: data as ComponentProfile }
    }
    const { data, error } = await supabase
      .from('score_component_profiles')
      .insert({ assessment_window_id: windowId, name: opts.name })
      .select('*')
      .single()
    if (error) return err(friendly(error.message))
    return { ok: true, data: data as ComponentProfile }
  } catch (e: any) {
    return err(e?.message ?? 'Failed to save weight profile')
  }
}

export async function deleteProfile(profileId: string): Promise<Result<true>> {
  try {
    // Refuse when classes still point at it — the DB FK would block anyway;
    // failing here gives a plain-English message instead of a raw FK error.
    const { count, error: checkErr } = await supabase
      .from('assessment_window_classes')
      .select('id', { count: 'exact', head: true })
      .eq('score_component_profile_id', profileId)
    if (checkErr) return err(friendly(checkErr.message))
    if ((count ?? 0) > 0) {
      return err('This weighting is still assigned to one or more classes. Reassign them first.')
    }
    const { error } = await supabase
      .from('score_component_profiles')
      .delete()
      .eq('id', profileId)
    if (error) return err(friendly(error.message))
    return { ok: true, data: true }
  } catch (e: any) {
    return err(e?.message ?? 'Failed to delete weight profile')
  }
}

// ─── Score components ─────────────────────────────────────────────────────────

export async function loadComponents(profileId: string): Promise<Result<ScoreComponentWithMax[]>> {
  try {
    const { data, error } = await supabase
      .from('score_components')
      .select('id, name, weight_pct, max_score, sort_order')
      .eq('score_component_profile_id', profileId)
      .order('sort_order')

    if (error) return err(friendly(error.message))
    return {
      ok: true,
      data: (data ?? []).map((c: any) => ({
        id: c.id,
        name: c.name,
        weight_pct: Number(c.weight_pct),
        max_score: Number(c.max_score),
        sort_order: c.sort_order,
      })),
    }
  } catch (e: any) {
    return err(e?.message ?? 'Failed to load score components')
  }
}

export async function saveComponent(schoolId: string, profileId: string, opts: {
  id?: string
  name: string
  weightPct: number
  maxScore: number
  sortOrder: number
}): Promise<Result<ScoreComponentWithMax>> {
  const payload = {
    name: opts.name,
    weight_pct: opts.weightPct,
    max_score: opts.maxScore,
    sort_order: opts.sortOrder,
  }
  try {
    if (opts.id) {
      const { data, error } = await supabase
        .from('score_components')
        .update(payload)
        .eq('id', opts.id)
        .select('*')
        .single()
      if (error) return err(friendly(error.message))
      return { ok: true, data: mapComponent(data) }
    }
    // score_components retains its legacy NOT NULL school_id column (§7.14a) —
    // the insert must supply it or the INSERT-time RLS WITH CHECK fails on the
    // null before the constraint ever fires (surfaces as a misleading
    // permission error). This exact omission shipped once; do not regress.
    const { data, error } = await supabase
      .from('score_components')
      .insert({ school_id: schoolId, score_component_profile_id: profileId, ...payload })
      .select('*')
      .single()
    if (error) return err(friendly(error.message))
    return { ok: true, data: mapComponent(data) }
  } catch (e: any) {
    return err(e?.message ?? 'Failed to save score component')
  }
}

export async function deleteComponent(componentId: string): Promise<Result<true>> {
  try {
    const { error } = await supabase
      .from('score_components')
      .delete()
      .eq('id', componentId)
    if (error) return err(friendly(error.message))
    return { ok: true, data: true }
  } catch (e: any) {
    return err(e?.message ?? 'Failed to delete score component')
  }
}

function mapComponent(r: any): ScoreComponentWithMax {
  return {
    id: r.id,
    name: r.name,
    weight_pct: Number(r.weight_pct),
    max_score: Number(r.max_score),
    sort_order: r.sort_order,
  }
}

// ─── Venues ───────────────────────────────────────────────────────────────────

export async function loadVenues(schoolId: string): Promise<Result<Venue[]>> {
  try {
    const { data, error } = await supabase
      .from('venues')
      .select('id, name, capacity')
      .eq('school_id', schoolId)
      .order('name')
    if (error) return err(friendly(error.message))
    return {
      ok: true,
      data: (data ?? []).map((v: any) => ({ id: v.id, name: v.name, capacity: Number(v.capacity) })),
    }
  } catch (e: any) {
    return err(e?.message ?? 'Failed to load venues')
  }
}

export async function saveVenue(schoolId: string, opts: { id?: string; name: string; capacity: number }): Promise<Result<true>> {
  try {
    const payload = { name: opts.name, capacity: opts.capacity }
    const { error } = opts.id
      ? await supabase.from('venues').update(payload).eq('id', opts.id).eq('school_id', schoolId)
      : await supabase.from('venues').insert({ school_id: schoolId, ...payload })
    if (error) return err(friendly(error.message))
    return { ok: true, data: true }
  } catch (e: any) {
    return err(e?.message ?? 'Failed to save venue')
  }
}

export async function deleteVenue(venueId: string): Promise<Result<true>> {
  try {
    const { error } = await supabase.from('venues').delete().eq('id', venueId)
    if (error) return err(friendly(error.message))
    return { ok: true, data: true }
  } catch (e: any) {
    return err(e?.message ?? 'Failed to delete venue')
  }
}

// ─── Exam timetable + invigilators ────────────────────────────────────────────

export async function loadExamEntries(params: {
  schoolId: string
  windowId?: string
  fromDate?: string       // inclusive yyyy-mm-dd
  toDate?: string         // inclusive
  classNodeId?: string
}): Promise<Result<ExamEntry[]>> {
  try {
    let query = supabase
      .from('exam_timetable_entries')
      .select(`
        id, assessment_window_id, class_node_id, subject_id,
        exam_date, start_time, end_time, venue_id,
        assessment_windows ( id, name ),
        class_nodes ( name ),
        subjects ( name ),
        venues ( name, capacity ),
        exam_invigilators ( staff_id, role, staff ( full_name ) )
      `)
      .eq('assessment_windows.school_id', params.schoolId)

    if (params.windowId)   query = query.eq('assessment_window_id', params.windowId)
    if (params.fromDate)   query = query.gte('exam_date', params.fromDate)
    if (params.toDate)     query = query.lte('exam_date', params.toDate)
    if (params.classNodeId) query = query.eq('class_node_id', params.classNodeId)

    const { data, error } = await query.order('exam_date').order('start_time')
    if (error) return err(friendly(error.message))

    return {
      ok: true,
      data: (data ?? []).map((r: any) => ({
        id: r.id,
        assessment_window_id: r.assessment_window_id,
        window_name: r.assessment_windows?.name ?? '',
        class_node_id: r.class_node_id,
        class_node_name: r.class_nodes?.name ?? '',
        subject_id: r.subject_id,
        subject_name: r.subjects?.name ?? '',
        exam_date: r.exam_date,
        start_time: (r.start_time ?? '').slice(0, 5),
        end_time: (r.end_time ?? '').slice(0, 5),
        venue_id: r.venue_id ?? null,
        venue_name: r.venues?.name ?? null,
        venue_capacity: r.venues ? Number(r.venues.capacity) : null,
        invigilators: (r.exam_invigilators ?? []).map((i: any) => ({
          staff_id: i.staff_id,
          role: i.role,
          staff_name: i.staff?.full_name ?? '',
        })),
      })),
    }
  } catch (e: any) {
    return err(e?.message ?? 'Failed to load exam timetable')
  }
}

export async function saveExamEntry(opts: {
  id?: string
  assessmentWindowId: string
  classNodeId: string
  subjectId: string
  examDate: string
  startTime: string      // HH:mm
  endTime: string        // HH:mm
  venueId: string | null
  createdBy: string | null      // auth user id (nullable column)
}): Promise<Result<string>> {
  try {
    const payload = {
      assessment_window_id: opts.assessmentWindowId,
      class_node_id: opts.classNodeId,
      subject_id: opts.subjectId,
      exam_date: opts.examDate,
      start_time: opts.startTime,
      end_time: opts.endTime,
      venue_id: opts.venueId,
    }
    if (opts.id) {
      const { error } = await supabase
        .from('exam_timetable_entries')
        .update(payload)
        .eq('id', opts.id)
      if (error) return err(friendly(error.message))
      return { ok: true, data: opts.id }
    }
    const { data, error } = await supabase
      .from('exam_timetable_entries')
      .insert({ ...payload, created_by: opts.createdBy })
      .select('id')
      .single()
    if (error) return err(friendly(error.message))
    return { ok: true, data: (data as any).id }
  } catch (e: any) {
    return err(e?.message ?? 'Failed to save exam entry')
  }
}

export async function deleteExamEntry(entryId: string): Promise<Result<true>> {
  try {
    const { error } = await supabase
      .from('exam_timetable_entries')
      .delete()
      .eq('id', entryId)
    if (error) return err(friendly(error.message))
    return { ok: true, data: true }
  } catch (e: any) {
    return err(e?.message ?? 'Failed to delete exam entry')
  }
}

/**
 * Replaces an entry's invigilator list. Deliberately delete-then-insert over
 * two calls (not one transaction): rows are few, admin-only, and idempotent
 * on retry — flagged in §12 rather than silently treated as atomic.
 */
export async function setEntryInvigilators(entryId: string, list: ExamInvigilator[]): Promise<Result<true>> {
  try {
    const del = await supabase
      .from('exam_invigilators')
      .delete()
      .eq('exam_timetable_entry_id', entryId)
    if (del.error) return err(friendly(del.error.message))
    if (list.length > 0) {
      const ins = await supabase
        .from('exam_invigilators')
        .insert(list.map(i => ({ exam_timetable_entry_id: entryId, staff_id: i.staff_id, role: i.role })))
      if (ins.error) return err(friendly(ins.error.message))
    }
    return { ok: true, data: true }
  } catch (e: any) {
    return err(e?.message ?? 'Failed to save invigilators')
  }
}

// ─── Clash detection (client-side v1, per Problem 8.4's own scoping) ─────────

function timesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart < bEnd && bStart < aEnd
}

export interface ExamClashReport {
  classClash: ExamEntry | null
  venueClash: ExamEntry | null
  staffClashes: Array<{ staffId: string; entry: ExamEntry }>
}

/** Checks a candidate entry against every OTHER existing entry. */
export function findExamClashes(candidate: {
  excludeEntryId?: string
  classNodeId: string
  examDate: string
  startTime: string
  endTime: string
  venueId: string | null
  invigilatorStaffIds: string[]
}, existing: ExamEntry[]): ExamClashReport {
  const report: ExamClashReport = { classClash: null, venueClash: null, staffClashes: [] }

  for (const e of existing) {
    if (e.id === candidate.excludeEntryId) continue
    if (e.exam_date !== candidate.examDate) continue
    if (!timesOverlap(candidate.startTime, candidate.endTime, e.start_time, e.end_time)) continue

    if (e.class_node_id === candidate.classNodeId && !report.classClash) report.classClash = e

    if (
      candidate.venueId &&
      e.venue_id === candidate.venueId &&
      !report.venueClash
    ) report.venueClash = e

    for (const sid of candidate.invigilatorStaffIds) {
      if (e.invigilators.some(i => i.staff_id === sid)) {
        report.staffClashes.push({ staffId: sid, entry: e })
      }
    }
  }
  return report
}

// ─── Grade bands (secondary-safe) ─────────────────────────────────────────────
// grade_scales is shared between secondary and higher-ed (§7.14), but the
// higher-ed columns (grade_point/scale_max/is_passing) must stay NULL on
// secondary rows — so this writes ONLY the five secondary columns and never
// touches the higher-ed ones, unlike settingsService.upsertHigherEdGradeBand.

export interface SecondaryGradeBand {
  id: string
  min_score: number
  max_score: number
  grade_label: string
  remark: string | null
  sort_order: number
}

export async function loadGradeBands(schoolId: string): Promise<Result<SecondaryGradeBand[]>> {
  try {
    const { data, error } = await supabase
      .from('grade_scales')
      .select('id, min_score, max_score, grade_label, remark, sort_order')
      .eq('school_id', schoolId)
      .order('sort_order')
    if (error) return err(friendly(error.message))
    return {
      ok: true,
      data: (data ?? []).map((b: any) => ({
        id: b.id,
        min_score: Number(b.min_score),
        max_score: Number(b.max_score),
        grade_label: b.grade_label,
        remark: b.remark ?? null,
        sort_order: b.sort_order,
      })),
    }
  } catch (e: any) {
    return err(e?.message ?? 'Failed to load grade bands')
  }
}

export async function saveGradeBand(schoolId: string, opts: {
  id?: string
  minScore: number
  maxScore: number
  label: string
  remark: string | null
  sortOrder: number
}): Promise<Result<true>> {
  try {
    const payload = {
      min_score: opts.minScore,
      max_score: opts.maxScore,
      grade_label: opts.label,
      remark: opts.remark,
      sort_order: opts.sortOrder,
    }
    const { error } = opts.id
      ? await supabase.from('grade_scales').update(payload).eq('id', opts.id).eq('school_id', schoolId)
      : await supabase.from('grade_scales').insert({ school_id: schoolId, ...payload })
    if (error) return err(friendly(error.message))
    return { ok: true, data: true }
  } catch (e: any) {
    return err(e?.message ?? 'Failed to save grade band')
  }
}

export async function deleteGradeBand(bandId: string): Promise<Result<true>> {
  try {
    const { error } = await supabase.from('grade_scales').delete().eq('id', bandId)
    if (error) return err(friendly(error.message))
    return { ok: true, data: true }
  } catch (e: any) {
    return err(e?.message ?? 'Failed to delete grade band')
  }
}

// ─── Aggregate remark bands ───────────────────────────────────────────────────
export interface AggregateRemarkBand {
  id: string
  min_average: number
  max_average: number
  remark: string
  sort_order: number
}

export async function loadAggregateBands(schoolId: string): Promise<Result<AggregateRemarkBand[]>> {
  try {
    const { data, error } = await supabase
      .from('aggregate_remark_bands')
      .select('id, min_average, max_average, remark, sort_order')
      .eq('school_id', schoolId)
      .order('sort_order')
    if (error) return err(friendly(error.message))
    return {
      ok: true,
      data: (data ?? []).map((b: any) => ({
        id: b.id,
        min_average: Number(b.min_average),
        max_average: Number(b.max_average),
        remark: b.remark,
        sort_order: b.sort_order,
      })),
    }
  } catch (e: any) {
    return err(e?.message ?? 'Failed to load remark bands')
  }
}

export async function saveAggregateBand(schoolId: string, opts: {
  id?: string
  minAverage: number
  maxAverage: number
  remark: string
  sortOrder: number
}): Promise<Result<true>> {
  try {
    const payload = {
      min_average: opts.minAverage,
      max_average: opts.maxAverage,
      remark: opts.remark,
      sort_order: opts.sortOrder,
    }
    const { error } = opts.id
      ? await supabase.from('aggregate_remark_bands').update(payload).eq('id', opts.id).eq('school_id', schoolId)
      : await supabase.from('aggregate_remark_bands').insert({ school_id: schoolId, ...payload })
    if (error) return err(friendly(error.message))
    return { ok: true, data: true }
  } catch (e: any) {
    return err(e?.message ?? 'Failed to save remark band')
  }
}

export async function deleteAggregateBand(bandId: string): Promise<Result<true>> {
  try {
    const { error } = await supabase.from('aggregate_remark_bands').delete().eq('id', bandId)
    if (error) return err(friendly(error.message))
    return { ok: true, data: true }
  } catch (e: any) {
    return err(e?.message ?? 'Failed to delete remark band')
  }
}

// ─── Per-student window remarks (class teacher's remark) ─────────────────────

export interface StudentRemark {
  student_id: string
  remark: string
}

export async function loadRemarksForWindow(windowId: string): Promise<Result<StudentRemark[]>> {
  try {
    const { data, error } = await supabase
      .from('assessment_window_student_remarks')
      .select('student_id, remark')
      .eq('assessment_window_id', windowId)
    if (error) return err(friendly(error.message))
    return { ok: true, data: data ?? [] }
  } catch (e: any) {
    return err(e?.message ?? 'Failed to load remarks')
  }
}

export async function saveStudentRemark(params: {
  schoolId: string
  windowId: string
  studentId: string
  remark: string
  enteredBy: string      // staff.id (actorRecordId)
}): Promise<Result<true>> {
  try {
    const { error } = await supabase
      .from('assessment_window_student_remarks')
      .upsert(
        {
          school_id: params.schoolId,
          assessment_window_id: params.windowId,
          student_id: params.studentId,
          remark: params.remark,
          entered_by: params.enteredBy,
        },
        { onConflict: 'assessment_window_id,student_id' },
      )
    if (error) return err(friendly(error.message))
    return { ok: true, data: true }
  } catch (e: any) {
    return err(e?.message ?? 'Failed to save remark')
  }
}

// ─── Report-card data assembly ────────────────────────────────────────────────

export interface ReportCardSubjectRow {
  subject_id: string
  subject_name: string
  weighted_total: number
  grade_label: string | null
  position_in_class: number | null
  /** Raw per-component values keyed by component id (for the CA/exam columns). */
  componentValues: Record<string, number>
}

export interface ReportCardData {
  studentName: string
  studentCode: string | null
  className: string
  sessionName: string
  termName: string | null
  subjects: ReportCardSubjectRow[]
  components: ScoreComponentWithMax[]
  average: number | null
  overallPosition: number | null
  totalGraded: number           // how many peers have results (denominator for position)
  aggregateRemark: string | null
  teacherRemark: string
  attendance: { present: number; totalMarked: number } | null
}

export async function loadReportCardData(params: {
  schoolId: string
  sessionId: string
  termId: string | null
  termName: string | null
  sessionName: string
  classNodeId: string
  className: string
  studentId: string
  windowId: string | null
}): Promise<Result<ReportCardData>> {
  try {
    // Students of the class (for the peer-average position denominator).
    const studentsRes = await supabase
      .from('students')
      .select('id, full_name, student_code')
      .eq('class_node_id', params.classNodeId)
      .eq('status', 'active')
      .order('full_name')
    if (studentsRes.error) return err(studentsRes.error.message)
    const classmates = studentsRes.data ?? []
    const me = classmates.find(s => s.id === params.studentId)

    // Subject results for the whole class this session+term — one read feeds
    // both the student's own rows and the peer-average ranking.
    let srQuery = supabase
      .from('subject_results')
      .select('student_id, subject_id, weighted_total, grade_label, position_in_class')
      .eq('school_id', params.schoolId)
      .eq('session_id', params.sessionId)
      .in('student_id', classmates.length > 0 ? classmates.map(s => s.id) : [params.studentId])
    srQuery = params.termId
      ? srQuery.eq('term_id', params.termId)
      : srQuery.is('term_id', null)
    const srRes = await srQuery
    if (srRes.error) return err(srRes.error.message)
    const srRows = (srRes.data ?? []) as Array<{
      student_id: string; subject_id: string
      weighted_total: number; grade_label: string | null; position_in_class: number
    }>

    // Subject names.
    const subjectIds = [...new Set(srRows.map(r => r.subject_id))]
    const subjRes = subjectIds.length > 0
      ? await supabase.from('subjects').select('id, name').in('id', subjectIds)
      : { data: [], error: null }
    if (subjRes.error) return err(subjRes.error.message)
    const subjectNames = new Map(((subjRes.data ?? []) as any[]).map(s => [s.id, s.name]))

    // Components for THIS class's profile (columns of the report table).
    let components: ScoreComponentWithMax[] = []
    if (params.windowId) {
      const winRes = await resolveWindowForClass({
        sessionId: params.sessionId,
        termId: params.termId,
        classNodeId: params.classNodeId,
      })
      const profileId = winRes.ok && winRes.data?.windowClass
        ? winRes.data.windowClass.score_component_profile_id
        : null
      if (profileId) {
        const compRes = await loadComponents(profileId)
        if (compRes.ok) components = compRes.data
      }
    }

    // Raw per-component scores for the student (approved only reach guardians,
    // but the report card is a staff document — show whatever exists).
    let scoreQuery = supabase
      .from('scores')
      .select('subject_id, score_component_id, value')
      .eq('student_id', params.studentId)
      .eq('session_id', params.sessionId)
    scoreQuery = params.termId
      ? scoreQuery.eq('term_id', params.termId)
      : scoreQuery.is('term_id', null)
    const scoreRes = await scoreQuery
    if (scoreRes.error) return err(scoreRes.error.message)
    const scoreRows = (scoreRes.data ?? []) as Array<{ subject_id: string; score_component_id: string; value: number }>

    // Build the student's subject rows.
    const myRows = srRows.filter(r => r.student_id === params.studentId)
    const compById = new Map(components.map(c => [c.id, c]))
    const subjects: ReportCardSubjectRow[] = myRows.map(r => {
      const componentValues: Record<string, number> = {}
      for (const s of scoreRows) {
        if (s.subject_id !== r.subject_id) continue
        if (compById.has(s.score_component_id)) componentValues[s.score_component_id] = Number(s.value)
      }
      return {
        subject_id: r.subject_id,
        subject_name: subjectNames.get(r.subject_id) ?? '—',
        weighted_total: Number(r.weighted_total),
        grade_label: r.grade_label,
        position_in_class: r.position_in_class ? Number(r.position_in_class) : null,
        componentValues,
      }
    })

    // Overall position: rank peers by their cross-subject average.
    const avgByStudent = new Map<string, number>()
    const sumByStudent = new Map<string, { sum: number; n: number }>()
    for (const r of srRows) {
      const cur = sumByStudent.get(r.student_id) ?? { sum: 0, n: 0 }
      cur.sum += Number(r.weighted_total)
      cur.n += 1
      sumByStudent.set(r.student_id, cur)
    }
    for (const [sid, agg] of sumByStudent) avgByStudent.set(sid, agg.sum / agg.n)
    const ranked = [...avgByStudent.entries()].sort((a, b) => b[1] - a[1])
    const overallPosition = ranked.findIndex(([sid]) => sid === params.studentId)
    const average = avgByStudent.get(params.studentId) ?? null

    // Aggregate remark band.
    let aggregateRemark: string | null = null
    if (average !== null) {
      const bandsRes = await loadAggregateBands(params.schoolId)
      if (bandsRes.ok) {
        const band = bandsRes.data.find(b => average >= b.min_average && average <= b.max_average)
        aggregateRemark = band?.remark ?? null
      }
    }

    // Teacher's remark (may not exist yet — empty default, not an error).
    let teacherRemark = ''
    if (params.windowId) {
      const rmRes = await supabase
        .from('assessment_window_student_remarks')
        .select('remark')
        .eq('assessment_window_id', params.windowId)
        .eq('student_id', params.studentId)
        .maybeSingle()
      if (!rmRes.error && rmRes.data) teacherRemark = rmRes.data.remark ?? ''
    }

    // Attendance summary within the term/session date range.
    let attendance: ReportCardData['attendance'] = null
    let rangeStart: string | null = null
    let rangeEnd: string | null = null
    if (params.termId) {
      const tRes = await supabase
        .from('terms')
        .select('start_date, end_date')
        .eq('id', params.termId)
        .maybeSingle()
      if (!tRes.error && tRes.data) { rangeStart = tRes.data.start_date; rangeEnd = tRes.data.end_date }
    } else {
      const sRes = await supabase
        .from('sessions')
        .select('start_date, end_date')
        .eq('id', params.sessionId)
        .maybeSingle()
      if (!sRes.error && sRes.data) { rangeStart = sRes.data.start_date; rangeEnd = sRes.data.end_date }
    }
    if (rangeStart && rangeEnd) {
      const attRes = await supabase
        .from('attendance_records')
        .select('status')
        .eq('student_id', params.studentId)
        .gte('date', rangeStart)
        .lte('date', rangeEnd)
      if (!attRes.error && attRes.data) {
        const presentish = attRes.data.filter((r: any) => r.status === 'present' || r.status === 'late' || r.status === 'excused').length
        attendance = { present: presentish, totalMarked: attRes.data.length }
      }
    }

    return {
      ok: true,
      data: {
        studentName: me?.full_name ?? '',
        studentCode: me?.student_code ?? null,
        className: params.className,
        sessionName: params.sessionName,
        termName: params.termName,
        subjects,
        components,
        average,
        overallPosition: overallPosition >= 0 ? overallPosition + 1 : null,
        totalGraded: ranked.length,
        aggregateRemark,
        teacherRemark,
        attendance,
      },
    }
  } catch (e: any) {
    return err(e?.message ?? 'Failed to assemble report card')
  }
}
