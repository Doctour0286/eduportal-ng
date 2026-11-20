/**
 * TimetableModuleHigherEd.tsx
 * SESSION 68 — Course-offering-based timetable for higher-ed schools.
 *
 * Deliberately a new component, not a branch inside the secondary
 * TimetableModule (now renamed TimetableModuleSecondary) — mirrors the
 * ResultsModule.tsx SESSION 60 / AttendanceModule.tsx SESSION 66 dispatcher-
 * split precedent exactly: TimetableModuleSecondary is left byte-for-byte
 * unmodified, and this file is the entire net-new higher-ed path, wired
 * together only by the thin TimetableModule.tsx dispatcher.
 *
 * Reuses TimetableModuleSecondary's SHELL where genuinely shared (loading
 * skeleton, error/empty states, Modal-based read-only detail popup, the
 * `tt-*` header/badge/toggle CSS classes) — the PRD card's own instruction
 * ("reusing the existing TimetableModule.tsx shell where possible, not
 * rebuilt from scratch"). Does NOT reuse the grid itself: the secondary
 * grid is keyed on period_id (a shared, fixed school-wide slot list) and
 * class_node_id; this domain has neither — each entry carries its own
 * start_time/end_time (§7.27.6's own reasoning for why periods don't fit),
 * and the anchor is course_offering_id, not class_node_id. Forcing the two
 * shapes into one grid component would mean threading period-shaped props
 * through a component that has no periods, the same "don't force an
 * artificial common shape neither domain has" discipline §7.27's own
 * header already established.
 *
 * Three audiences (per courseOfferingTimetableService.ts's own file
 * header):
 *   - Admin: every offering in the school, full edit chrome.
 *   - Lecturer: every offering in the school, read-only — FIX, PRD Tier 9 /
 *     Problem 9.5 (owner walkthrough, 2026-07-23): previously scoped to
 *     only the lecturer's own assigned offerings via
 *     loadOfferingsForLecturer({ isAdmin: false }), an application-layer
 *     over-restriction the owner confirmed was the wrong design — the
 *     shared grid must show the complete picture for every staff role, at
 *     both school types (secondary-school teachers already got the full
 *     grid; this was a higher-ed-only defect). A lecturer's own personal
 *     schedule now lives on their dashboard instead (Problem 9.4's own
 *     cards), not as a restriction on this module. Both admin and lecturer
 *     now load via the same loadOfferingsForTimetableAdmin() call; editing
 *     remains admin-only exactly as before, untouched by this fix.
 *   - Student: only their own currently-registered offerings, read-only —
 *     unaffected by this fix.
 *
 * Conflict detection, two layers:
 *   - Read-only badge: findLecturerConflicts() (time-range overlap, not
 *     period equality — see the service file's own reasoning) flags a ⚠
 *     badge on cells where the same lecturer is double-booked across
 *     already-saved entries, informational only, matching
 *     TimetableModuleSecondary's existing "allow + warn" convention
 *     (§7.12) rather than a hard block.
 *   - Pre-save check (SESSION 69 follow-up): handleSaveSlot() runs both
 *     a lecturer-clash check and findCohortConflicts() against the
 *     not-yet-saved slot before writing, combining any hits into one
 *     confirm()-based "Save anyway?" dialog — mirroring the real
 *     precedent already used for SettingsModule.tsx's session/term
 *     date-bounds warning, not a new interaction pattern. Still never a
 *     hard block, same as the read-only badge above.
 */

import { orderedWeekDays } from '../lib/weekOrder'
import { loadFirstDayOfWeek, loadWeekDays } from '../services/settingsService'
import { HigherEdWeekGrid, HigherEdSchoolView, courseHue, fromMin, type SchoolRow } from './HigherEdWeekGrid'
import { printHigherEdTimetable, printHigherEdSchool } from '../services/printHigherEdTimetable'
import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  loadOfferingTimetable,
  loadOfferingsForTimetableAdmin,
  loadOfferingsForStudent,
  upsertOfferingTimetableEntry,
  deleteOfferingTimetableEntry,
  findLecturerConflicts,
  findCohortConflicts,
  cohortConflictMessage,
  rangesOverlap,
  dayName,
  formatTime,
  loadPeriodsForTimetable,
  loadLevelLabels,
  loadLecturersForAssignment,
  assignOfferingLecturer,
  type OfferingTimetableEntry,
  type CourseOffering,
  type Period,
  type LecturerOption,
} from '../services/courseOfferingTimetableService'
import { loadCurrentSession } from '../services/settingsService'
import { Modal } from '../components/Modal'
import { Icon } from '../components/icons'

// ─── Prop types ───────────────────────────────────────────────────────────

interface TimetableModuleHigherEdProps {
  schoolId: string
  isAdmin: boolean
  /** Current staff member's own staff.id — used to scope the lecturer view
   *  and to resolve "which offerings are mine" for a non-admin lecturer.
   *  null for guardians/students/platform_admins/unresolved identity,
   *  mirroring TimetableModuleSecondary's own currentStaffId contract. */
  currentStaffId?: string | null
  /** Current student's own students.id — set only when actorType ===
   *  'student' and the identity has resolved. When present, this component
   *  renders the student's own read-only timetable regardless of the
   *  isAdmin/currentStaffId props (a student is never also staff in this
   *  schema). null for every other actor type. */
  currentStudentId?: string | null
}

// ─── Root component ─────────────────────────────────────────────────────

type View = 'level' | 'lecturer' | 'venue' | 'all'
const NONE = '__none__'
const DURATIONS: { label: string; minutes: number }[] = [
  { label: '1 hr', minutes: 60 }, { label: '1½ hrs', minutes: 90 }, { label: '2 hrs', minutes: 120 }, { label: '3 hrs', minutes: 180 },
]
const mins = (t: string) => { const [h, m] = t.split(':'); return Number(h) * 60 + Number(m) }

/** Entries that use the same venue at overlapping times on the same day. */
function findVenueConflicts(entries: OfferingTimetableEntry[]): Set<string> {
  const ids = new Set<string>()
  for (let i = 0; i < entries.length; i++) {
    const a = entries[i]
    if (!a.venue?.trim()) continue
    for (let j = i + 1; j < entries.length; j++) {
      const b = entries[j]
      if (a.day_of_week !== b.day_of_week || !b.venue?.trim()) continue
      if (a.venue.trim().toLowerCase() !== b.venue.trim().toLowerCase()) continue
      if (a.course_offering_id === b.course_offering_id) continue
      if (rangesOverlap(a.start_time, a.end_time, b.start_time, b.end_time)) { ids.add(a.id); ids.add(b.id) }
    }
  }
  return ids
}

export default function TimetableModuleHigherEd({
  schoolId,
  isAdmin,
  currentStaffId = null,
  currentStudentId = null,
}: TimetableModuleHigherEdProps) {
  const [sessionName, setSessionName] = useState<string>('')
  const [firstDay, setFirstDay] = useState(1)
  useEffect(() => { void loadFirstDayOfWeek(schoolId).then(setFirstDay) }, [schoolId])
  const [offerings, setOfferings] = useState<CourseOffering[]>([])
  const [entries, setEntries] = useState<OfferingTimetableEntry[]>([])
  const [loadState, setLoadState] = useState<'loading' | 'error' | 'empty' | 'ready'>('loading')
  const [errorMsg, setErrorMsg] = useState('')

  const isStudentView = !isAdmin && !!currentStudentId
  const isLecturerView = !isAdmin && !isStudentView

  // View + selection
  const [view, setView] = useState<View>(isLecturerView ? 'lecturer' : 'level')
  const [levelSel, setLevelSel] = useState('')
  const [lecturerSel, setLecturerSel] = useState('')
  const [venueSel, setVenueSel] = useState('')
  const [overviewDay, setOverviewDay] = useState<number | 'all' | null>(null)
  // Whole school: how rows are grouped, plus search and a clashes-only filter.
  const [groupBy, setGroupBy] = useState<'room' | 'level' | 'lecturer'>('room')
  const [query, setQuery] = useState('')
  const [onlyClashes, setOnlyClashes] = useState(false)
  const [levelLabels, setLevelLabels] = useState<Map<string, string>>(new Map())
  const [schoolDays, setSchoolDays] = useState<number[]>([])

  // Editing
  const [editMode, setEditMode] = useState(false)
  const [armedId, setArmedId] = useState<string | null>(null)
  const [duration, setDuration] = useState(60)
  const [notice, setNotice] = useState('')
  const [scopePoolIds, setScopePoolIds] = useState<string[] | null>(null)   // limits the course picker in the add form
  const [formOpen, setFormOpen] = useState(false)
  const [formEntry, setFormEntry] = useState<Partial<OfferingTimetableEntry> | null>(null)
  const [formSaving, setFormSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)

  const [periods, setPeriods] = useState<Period[]>([])
  const [selectedPeriodId, setSelectedPeriodId] = useState<string>('')
  const [lecturers, setLecturers] = useState<LecturerOption[]>([])
  const [lecturerPickerId, setLecturerPickerId] = useState<string>('')
  const [lecturerSaving, setLecturerSaving] = useState(false)
  const [lecturerError, setLecturerError] = useState<string | null>(null)
  const [detailEntry, setDetailEntry] = useState<OfferingTimetableEntry | null>(null)

  const load = useCallback(async () => {
    setLoadState('loading')
    setErrorMsg('')

    const sessionRes = await loadCurrentSession(schoolId)
    if (sessionRes.error) { setLoadState('error'); setErrorMsg(sessionRes.error); return }
    if (!sessionRes.data) {
      setLoadState('error')
      setErrorMsg('No current session found. Set up a session in the calendar settings.')
      return
    }
    setSessionName(sessionRes.data.name)

    let offeringsResult: CourseOffering[] = []
    if (isStudentView && currentStudentId) {
      const res = await loadOfferingsForStudent({ studentId: currentStudentId, sessionId: sessionRes.data.id })
      if (!res.ok) { setLoadState('error'); setErrorMsg(res.error); return }
      offeringsResult = res.data
    } else {
      const res = await loadOfferingsForTimetableAdmin(sessionRes.data.id)
      if (!res.ok) { setLoadState('error'); setErrorMsg(res.error); return }
      offeringsResult = res.data
    }
    setOfferings(offeringsResult)

    const entriesRes = await loadOfferingTimetable(offeringsResult.map(o => o.id))
    if (!entriesRes.ok) { setLoadState('error'); setErrorMsg(entriesRes.error); return }
    setEntries(entriesRes.data)

    const [levelsRes, weekRes] = await Promise.all([loadLevelLabels(schoolId), loadWeekDays(schoolId)])
    if (levelsRes.ok) setLevelLabels(levelsRes.data)
    setSchoolDays(weekRes.error ? [] : weekRes.data.map(w => w.day_of_week))

    if (isAdmin) {
      const [periodsRes, lecturersRes] = await Promise.all([loadPeriodsForTimetable(schoolId), loadLecturersForAssignment(schoolId)])
      setPeriods(periodsRes.ok ? periodsRes.data : [])
      setLecturers(lecturersRes.ok ? lecturersRes.data : [])
    }
    setLoadState(entriesRes.data.length > 0 || offeringsResult.length > 0 ? 'ready' : 'empty')
  }, [schoolId, isAdmin, isStudentView, currentStudentId, currentStaffId])

  useEffect(() => { void load() }, [load])

  // After an edit, refresh just the lessons — no full-page skeleton flash.
  const refreshEntries = useCallback(async () => {
    const res = await loadOfferingTimetable(offerings.map(o => o.id))
    if (res.ok) setEntries(res.data)
  }, [offerings])

  // ── Clash detection (live, in memory) ───────────────────────────────────
  const lecturerClashIds = useMemo(() => findLecturerConflicts(entries), [entries])
  const venueClashIds = useMemo(() => findVenueConflicts(entries), [entries])

  // ── What each view can pick from ────────────────────────────────────────
  const levelOptions = useMemo(() => {
    const ids = new Set<string>()
    let hasNone = false
    for (const o of offerings) { if (o.programme_level_id) ids.add(o.programme_level_id); else hasNone = true }
    const list = [...ids].map(id => ({ id, label: levelLabels.get(id) ?? 'Programme level' })).sort((a, b) => a.label.localeCompare(b.label))
    if (hasNone) list.push({ id: NONE, label: 'Shared / no level' })
    return list
  }, [offerings, levelLabels])

  const lecturerOptions = useMemo(() => {
    const m = new Map<string, string>()
    let hasNone = false
    for (const o of offerings) { if (o.staff_id) m.set(o.staff_id, o.staff_name ?? 'Lecturer'); else hasNone = true }
    const list = [...m.entries()].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label))
    if (hasNone) list.push({ id: NONE, label: 'No lecturer assigned yet' })
    return list
  }, [offerings])

  const venueOptions = useMemo(() => {
    const set = new Set<string>()
    let hasNone = false
    for (const e of entries) { if (e.venue?.trim()) set.add(e.venue.trim()); else hasNone = true }
    const list = [...set].sort().map(v => ({ id: v, label: v }))
    if (hasNone || list.length === 0) list.push({ id: NONE, label: 'No venue set' })
    return list
  }, [entries])

  // Keep the selection valid; lecturers land on their own timetable.
  useEffect(() => {
    if (levelOptions.length && !levelOptions.some(o => o.id === levelSel)) setLevelSel(levelOptions[0].id)
  }, [levelOptions, levelSel])
  useEffect(() => {
    if (lecturerOptions.length && !lecturerOptions.some(o => o.id === lecturerSel)) {
      const mine = currentStaffId && lecturerOptions.find(o => o.id === currentStaffId)
      setLecturerSel(mine ? mine.id : lecturerOptions[0].id)
    }
  }, [lecturerOptions, lecturerSel, currentStaffId])
  useEffect(() => {
    if (venueOptions.length && !venueOptions.some(o => o.id === venueSel)) setVenueSel(venueOptions[0].id)
  }, [venueOptions, venueSel])

  const keyOf = {
    level: (x: { programme_level_id: string | null }) => x.programme_level_id ?? NONE,
    lecturer: (x: { staff_id: string | null }) => x.staff_id ?? NONE,
  }

  const viewEntries = useMemo(() => {
    if (isStudentView || view === 'all') return entries
    if (view === 'level') return entries.filter(e => keyOf.level(e) === levelSel)
    if (view === 'lecturer') return entries.filter(e => keyOf.lecturer(e) === lecturerSel)
    return entries.filter(e => (e.venue?.trim() || NONE) === venueSel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, view, levelSel, lecturerSel, venueSel, isStudentView])

  const days = useMemo(() => {
    const used = new Set(entries.map(e => e.day_of_week))
    const base = new Set<number>(schoolDays.length ? schoolDays : [1, 2, 3, 4, 5])
    for (const d of used) base.add(d)
    return orderedWeekDays(firstDay).filter(d => base.has(d))
  }, [entries, schoolDays, firstDay])

  // ── Whole school: rows by room, programme level or lecturer ─────────────
  const schoolRows: SchoolRow[] = useMemo(() => {
    const has = (pred: (e: OfferingTimetableEntry) => boolean) => entries.some(pred)
    if (groupBy === 'room') {
      const rows: SchoolRow[] = venueOptions.filter(v => v.id !== NONE).map(v => ({
        key: v.id, label: v.label, venue: v.label,
        match: (e: OfferingTimetableEntry) => (e.venue?.trim().toLowerCase() ?? '') === v.label.toLowerCase(),
      }))
      if (has(e => !e.venue?.trim())) rows.push({ key: NONE, label: 'No venue set', venue: null, match: e => !e.venue?.trim() })
      return rows
    }
    if (groupBy === 'level') {
      const rows: SchoolRow[] = levelOptions.filter(o => o.id !== NONE).map(o => ({
        key: o.id, label: o.label, levelId: o.id, match: (e: OfferingTimetableEntry) => e.programme_level_id === o.id,
      }))
      if (has(e => !e.programme_level_id) || offerings.some(o => !o.programme_level_id)) {
        rows.push({ key: NONE, label: 'Shared / no level', levelId: null, match: e => !e.programme_level_id })
      }
      return rows
    }
    const rows: SchoolRow[] = lecturerOptions.filter(o => o.id !== NONE).map(o => ({
      key: o.id, label: o.label, staffId: o.id, match: (e: OfferingTimetableEntry) => e.staff_id === o.id,
    }))
    if (has(e => !e.staff_id) || offerings.some(o => !o.staff_id)) rows.push({ key: NONE, label: 'No lecturer yet', staffId: null, match: e => !e.staff_id })
    return rows
  }, [groupBy, venueOptions, levelOptions, lecturerOptions, entries, offerings])

  const schoolEntries = useMemo(() => {
    const q = query.trim().toLowerCase()
    return entries.filter(e =>
      (!q || `${e.course_code} ${e.course_title} ${e.staff_name ?? ''} ${e.venue ?? ''}`.toLowerCase().includes(q)) &&
      (!onlyClashes || lecturerClashIds.has(e.id) || venueClashIds.has(e.id)))
  }, [entries, query, onlyClashes, lecturerClashIds, venueClashIds])

  const activeSchoolDay: number | 'all' = overviewDay ?? (days.includes(new Date().getDay()) ? new Date().getDay() : (days[0] ?? 1))
  const summaryEntries = activeSchoolDay === 'all' ? schoolEntries : schoolEntries.filter(e => e.day_of_week === activeSchoolDay)
  const summary = {
    lessons: summaryEntries.length,
    rooms: new Set(summaryEntries.map(e => e.venue?.trim().toLowerCase()).filter(Boolean)).size,
    lecturers: new Set(summaryEntries.map(e => e.staff_id).filter(Boolean)).size,
    clashes: summaryEntries.filter(e => lecturerClashIds.has(e.id) || venueClashIds.has(e.id)).length,
  }

  // ── Course tray: what can be placed in the current view ─────────────────
  const trayOfferings = useMemo(() => {
    if (view === 'level') return offerings.filter(o => keyOf.level(o) === levelSel)
    if (view === 'lecturer') return offerings.filter(o => keyOf.lecturer(o) === lecturerSel)
    return offerings
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offerings, view, levelSel, lecturerSel])

  const venueDefault = view === 'venue' && venueSel !== NONE ? venueSel : null
  const placedCount = (id: string) => entries.filter(e => e.course_offering_id === id).length

  // ── Saving (shared by tap-to-place and the add/edit form) ───────────────
  async function commitEntry(p: {
    id?: string; offeringId: string; day: number; start: string; end: string; venue: string | null
  }): Promise<'saved' | 'cancelled' | { error: string }> {
    if (p.start >= p.end) return { error: 'End time must be after start time.' }
    const offering = offerings.find(o => o.id === p.offeringId)
    if (!offering) return { error: 'Choose a course.' }

    const pending: OfferingTimetableEntry = {
      id: p.id ?? '__pending__',
      course_offering_id: offering.id, course_id: offering.course_id,
      course_code: offering.course_code, course_title: offering.course_title,
      staff_id: offering.staff_id, staff_name: offering.staff_name,
      programme_id: offering.programme_id, programme_level_id: offering.programme_level_id, term_id: offering.term_id,
      day_of_week: p.day, start_time: p.start, end_time: p.end, venue: p.venue,
    }
    const others = entries.filter(e => e.id !== pending.id)
    const warnings: string[] = []

    if (pending.staff_id) {
      const clash = others.find(e => e.course_offering_id !== pending.course_offering_id && e.staff_id === pending.staff_id
        && e.day_of_week === pending.day_of_week && rangesOverlap(e.start_time, e.end_time, pending.start_time, pending.end_time))
      if (clash) warnings.push(`${pending.staff_name ?? 'This lecturer'} is already booked for ${clash.course_code} — ${clash.course_title} at an overlapping time.`)
    }
    if (pending.venue?.trim()) {
      const clash = others.find(e => e.course_offering_id !== pending.course_offering_id && e.venue?.trim().toLowerCase() === pending.venue!.trim().toLowerCase()
        && e.day_of_week === pending.day_of_week && rangesOverlap(e.start_time, e.end_time, pending.start_time, pending.end_time))
      if (clash) warnings.push(`${pending.venue} is already used by ${clash.course_code} at an overlapping time.`)
    }
    const cohortRes = await findCohortConflicts([...others, pending])
    if (!cohortRes.ok) return { error: cohortRes.error }
    for (const c of cohortRes.data.filter(c => c.entryId === pending.id)) warnings.push(cohortConflictMessage(c))

    if (warnings.length > 0 && !confirm(`${warnings.join('\n\n')}\n\nSave anyway?`)) return 'cancelled'

    const res = await upsertOfferingTimetableEntry({
      id: p.id, schoolId, courseOfferingId: p.offeringId, dayOfWeek: p.day,
      startTime: p.start, endTime: p.end, venue: p.venue,
    })
    if (!res.ok) return { error: res.error }
    await refreshEntries()
    return 'saved'
  }

  // ── Interactions ────────────────────────────────────────────────────────
  function openAdd(day: number, startMin: number, opts: { pool?: string[] | null; venue?: string | null } = {}) {
    const start = fromMin(startMin)
    const end = fromMin(Math.min(23 * 60 + 59, startMin + duration))
    const poolIds = opts.pool && opts.pool.length > 0 ? opts.pool : null
    const pool = poolIds ? offerings.filter(o => poolIds.includes(o.id)) : trayOfferings
    setScopePoolIds(poolIds)
    setFormEntry({
      course_offering_id: armedId ?? pool[0]?.id ?? '', day_of_week: day, start_time: start, end_time: end,
      venue: opts.venue !== undefined ? opts.venue : venueDefault,
    })
    setSelectedPeriodId(matchingPeriodId(start, end))
    setLecturerPickerId(''); setLecturerError(null); setFormError(null); setConfirmRemove(false)
    setFormOpen(true)
  }

  async function handleSlotTap(day: number, startMin: number, row?: SchoolRow) {
    if (!editMode) return
    setNotice('')
    if (armedId && !row) {
      const res = await commitEntry({
        offeringId: armedId, day, start: fromMin(startMin),
        end: fromMin(Math.min(23 * 60 + 59, startMin + duration)), venue: venueDefault,
      })
      if (typeof res === 'object') setNotice(res.error)
      return
    }
    // Whole school: the row you tapped decides what the form starts with.
    let pool: string[] | null = null
    let venue: string | null | undefined = undefined
    if (row) {
      if (row.levelId !== undefined) pool = offerings.filter(o => keyOf.level(o) === (row.levelId ?? NONE)).map(o => o.id)
      if (row.staffId !== undefined) pool = offerings.filter(o => keyOf.lecturer(o) === (row.staffId ?? NONE)).map(o => o.id)
      if (row.venue !== undefined) venue = row.venue
    }
    openAdd(day, startMin, { pool, venue })
  }

  function openEditForm(entry: OfferingTimetableEntry) {
    setScopePoolIds(null)
    setFormEntry({ ...entry })
    setSelectedPeriodId(matchingPeriodId(entry.start_time, entry.end_time))
    setLecturerPickerId(''); setLecturerError(null); setFormError(null); setConfirmRemove(false)
    setFormOpen(true)
  }

  function handleEntryTap(entry: OfferingTimetableEntry) {
    if (editMode && isAdmin) openEditForm(entry)
    else setDetailEntry(entry)
  }

  function matchingPeriodId(startTime: string, endTime: string): string {
    const match = periods.find(p => p.start_time.slice(0, 5) === startTime.slice(0, 5) && p.end_time.slice(0, 5) === endTime.slice(0, 5))
    return match?.id ?? ''
  }

  function handlePeriodPick(periodId: string) {
    setSelectedPeriodId(periodId)
    const period = periods.find(p => p.id === periodId)
    if (!period) return
    setFormEntry(prev => prev ? { ...prev, start_time: period.start_time.slice(0, 5), end_time: period.end_time.slice(0, 5) } : prev)
  }

  function setDurationOnForm(minutes: number) {
    setFormEntry(prev => {
      if (!prev?.start_time) return prev
      return { ...prev, end_time: fromMin(Math.min(23 * 60 + 59, mins(prev.start_time) + minutes)) }
    })
    setSelectedPeriodId('')
  }

  const formOffering = offerings.find(o => o.id === formEntry?.course_offering_id) ?? null

  async function handleAssignLecturer() {
    if (!formOffering || !lecturerPickerId) return
    setLecturerSaving(true); setLecturerError(null)
    const res = await assignOfferingLecturer(formOffering, lecturerPickerId)
    setLecturerSaving(false)
    if (!res.ok) { setLecturerError(res.error); return }
    setLecturerPickerId('')
    await load()
  }

  async function handleSaveSlot() {
    if (!formEntry?.course_offering_id || !formEntry.start_time || !formEntry.end_time) { setFormError('Choose a course and a time.'); return }
    setFormSaving(true); setFormError(null)
    const res = await commitEntry({
      id: formEntry.id, offeringId: formEntry.course_offering_id, day: formEntry.day_of_week ?? 1,
      start: formEntry.start_time.slice(0, 5), end: formEntry.end_time.slice(0, 5), venue: formEntry.venue?.trim() || null,
    })
    setFormSaving(false)
    if (res === 'cancelled') return
    if (typeof res === 'object') { setFormError(res.error); return }
    setFormOpen(false); setFormEntry(null)
  }

  async function handleRemove() {
    if (!formEntry?.id) return
    const res = await deleteOfferingTimetableEntry(formEntry.id)
    if (!res.ok) { setFormError(res.error); return }
    setFormOpen(false); setFormEntry(null); setConfirmRemove(false)
    await refreshEntries()
  }

  function handlePrint() {
    if (view === 'all') {
      const ok = printHigherEdSchool({
        title: 'Whole-school timetable',
        subtitle: `${sessionName} · by ${groupBy === 'room' ? 'room' : groupBy === 'level' ? 'programme level' : 'lecturer'}`,
        entries: schoolEntries,
        rows: schoolRows.map(r => ({ label: r.label, match: r.match })),
        days: activeSchoolDay === 'all' ? days : [activeSchoolDay],
      })
      if (!ok) setNotice('There are no lessons to print.')
      return
    }
    const label = isStudentView ? 'My timetable'
      : view === 'level' ? (levelOptions.find(o => o.id === levelSel)?.label ?? 'Timetable')
      : view === 'lecturer' ? (lecturerOptions.find(o => o.id === lecturerSel)?.label ?? 'Timetable')
      : `Venue: ${venueOptions.find(o => o.id === venueSel)?.label ?? ''}`
    const ok = printHigherEdTimetable({ title: label, subtitle: sessionName, schoolName: '', entries: viewEntries, days })
    if (!ok) setNotice('There are no lessons to print in this view.')
  }

  function enterEditMode() { setEditMode(true); setNotice('') }
  function exitEditMode() { setEditMode(false); setArmedId(null); setFormOpen(false); setFormEntry(null); setNotice('') }

  // ── Render ──────────────────────────────────────────────────────────────

  if (loadState === 'loading') return <HigherEdTimetableSkeleton />

  if (loadState === 'error') {
    return (
      <div className="tt-error-state">
        <span className="tt-error-icon"><Icon name="alert-triangle" style={{ color: 'var(--color-warning, #d97706)' }} /></span>
        <p className="tt-error-msg">{errorMsg}</p>
        <button className="tt-retry-btn" onClick={load}>Try again</button>
      </div>
    )
  }

  if (loadState === 'empty' && !editMode) {
    return (
      <div className="tt-empty-state">
        <span className="tt-empty-icon"><Icon name="calendar" /></span>
        <p className="tt-empty-title">No timetable yet</p>
        <p className="tt-empty-msg">
          {isStudentView
            ? "You don't have any registered courses with a scheduled time yet."
            : isLecturerView
            ? "You don't have any assigned course offerings with a scheduled time yet."
            : `No course offerings have been set up for ${sessionName} yet. Add them in Curriculum / Offerings, then schedule them here.`}
        </p>
      </div>
    )
  }

  const showSelector = !isStudentView && view !== 'all'
  const selection =
    view === 'level' ? { value: levelSel, set: setLevelSel, options: levelOptions, label: 'Programme level' }
    : view === 'lecturer' ? { value: lecturerSel, set: setLecturerSel, options: lecturerOptions, label: 'Lecturer' }
    : { value: venueSel, set: setVenueSel, options: venueOptions, label: 'Venue' }

  const modalPool = scopePoolIds
    ? offerings.filter(o => scopePoolIds.includes(o.id))
    : (formEntry?.id ? offerings : trayOfferings.length ? trayOfferings : offerings)

  return (
    <div className="tt-root">
      <div className="tt-header">
        <div className="tt-header-top">
          <span className="tt-session-badge">{sessionName}</span>
          <div className="tt-header-actions">
            {!editMode && (view === 'all' ? schoolEntries.length > 0 : viewEntries.length > 0) && (
              <button className="tt-print-btn" onClick={handlePrint}>Print</button>
            )}
            {isAdmin && !editMode && <button className="tt-edit-btn" onClick={enterEditMode}>Edit</button>}
            {isAdmin && editMode && <button className="tt-done-btn" onClick={exitEditMode}>Done</button>}
          </div>
        </div>

        {!isStudentView && (
          <div className="tt-toggle-row">
            {([['level', 'Programme level'], ['lecturer', 'Lecturer'], ['venue', 'Venue'], ['all', 'Whole school']] as [View, string][]).map(([k, label]) => (
              <button key={k} className={`tt-toggle-btn${view === k ? ' tt-toggle-btn--active' : ''}`} onClick={() => { setView(k); setArmedId(null) }}>{label}</button>
            ))}
          </div>
        )}

        {showSelector && (
          <div className="tt-selector-row">
            <label className="tt-selector-label">{selection.label}</label>
            <select className="tt-selector" value={selection.value} onChange={e => { selection.set(e.target.value); setArmedId(null) }}>
              {selection.options.length === 0 && <option value="">Nothing to show yet</option>}
              {selection.options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </div>
        )}
      </div>

      {notice && <p className="hg-notice" role="status">{notice} <button type="button" className="fma-link" onClick={() => setNotice('')}>Dismiss</button></p>}

      {/* Edit tray: pick a course, then tap the grid to place it */}
      {isAdmin && editMode && view !== 'all' && (
        <div className="hg-tray">
          <div className="hg-tray-top">
            <span className="hg-tray-hint">
              {armedId ? 'Now tap the grid to place it. Tap the course again to put it down.' : 'Pick a course, then tap the grid to place it — or tap any empty hour to add one with options.'}
            </span>
            <label className="hg-tray-dur">Length
              <select value={duration} onChange={e => setDuration(Number(e.target.value))}>
                {DURATIONS.map(d => <option key={d.minutes} value={d.minutes}>{d.label}</option>)}
              </select>
            </label>
          </div>
          {trayOfferings.length === 0 ? (
            <p className="hg-tray-empty">No courses to place here. {view === 'venue' ? 'Switch to a programme level or lecturer.' : 'Add course offerings in Curriculum / Offerings first.'}</p>
          ) : (
            <div className="hg-chips">
              {trayOfferings.map(o => (
                <button key={o.id} type="button"
                  className={`hg-chip${armedId === o.id ? ' hg-chip--armed' : ''}`}
                  style={{ borderColor: `hsl(${courseHue(o.course_code)} 55% 55%)` }}
                  onClick={() => setArmedId(armedId === o.id ? null : o.id)}
                  title={`${o.course_title}${o.staff_name ? ` · ${o.staff_name}` : ' · no lecturer yet'}`}>
                  <strong>{o.course_code}</strong>
                  <span>{o.staff_name ?? 'No lecturer'}</span>
                  <em>{placedCount(o.id)} slot{placedCount(o.id) === 1 ? '' : 's'}</em>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {isAdmin && editMode && view === 'all' && (
        <p className="hg-tray-hint hg-tray-hint--solo">Tap an empty hour in any row to add a lesson there — the row sets the room, level or lecturer for you. Tap a lesson to change or remove it.</p>
      )}

      {view === 'all' && !isStudentView && (
        <>
          <div className="hg-summary">
            <div className="hg-sum"><strong>{summary.lessons}</strong>lesson{summary.lessons === 1 ? '' : 's'}{activeSchoolDay === 'all' ? ' this week' : ''}</div>
            <div className="hg-sum"><strong>{summary.rooms}</strong>room{summary.rooms === 1 ? '' : 's'} in use</div>
            <div className="hg-sum"><strong>{summary.lecturers}</strong>lecturer{summary.lecturers === 1 ? '' : 's'} teaching</div>
            <div className={`hg-sum${summary.clashes > 0 ? ' hg-sum--warn' : ''}`}><strong>{summary.clashes}</strong>clash{summary.clashes === 1 ? '' : 'es'}</div>
          </div>
          <div className="hg-filters">
            <div className="hg-group" role="group" aria-label="Group rows by">
              {([['room', 'By room'], ['level', 'By level'], ['lecturer', 'By lecturer']] as ['room' | 'level' | 'lecturer', string][]).map(([k, label]) => (
                <button key={k} type="button" aria-pressed={groupBy === k} onClick={() => setGroupBy(k)}>{label}</button>
              ))}
            </div>
            <input className="hg-search" type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search course, lecturer or room…" aria-label="Search the timetable" />
            <label className="hg-check"><input type="checkbox" checked={onlyClashes} onChange={e => setOnlyClashes(e.target.checked)} /> Clashes only</label>
          </div>
        </>
      )}

      <div className="tt-grid-wrapper">
        {view === 'all' && !isStudentView ? (
          <HigherEdSchoolView
            entries={schoolEntries}
            rows={schoolRows}
            days={days}
            day={activeSchoolDay}
            onDayChange={setOverviewDay}
            editMode={editMode && isAdmin}
            lecturerClashIds={lecturerClashIds}
            venueClashIds={venueClashIds}
            onSlotTap={(d, row, start) => void handleSlotTap(d, start, row)}
            onEntryTap={handleEntryTap}
          />
        ) : (
          <HigherEdWeekGrid
            entries={viewEntries}
            days={days}
            editMode={editMode && isAdmin}
            armed={armedId !== null}
            lecturerClashIds={lecturerClashIds}
            venueClashIds={venueClashIds}
            showLecturer={view !== 'lecturer'}
            onSlotTap={(day, start) => void handleSlotTap(day, start)}
            onEntryTap={handleEntryTap}
          />
        )}
        {viewEntries.length === 0 && view !== 'all' && !editMode && (
          <p className="hg-empty">Nothing scheduled here yet.{isAdmin ? ' Press Edit to start placing courses.' : ''}</p>
        )}
        {(lecturerClashIds.size > 0 || venueClashIds.size > 0) && (
          <p className="hg-legend">⚠ marks a lecturer or venue booked twice at overlapping times.</p>
        )}
      </div>

      {/* ── Add / edit lesson ──────────────────────────────────────────── */}
      <Modal open={formOpen} onClose={() => { setFormOpen(false); setFormEntry(null) }} title={formEntry?.id ? 'Edit lesson' : 'Add lesson'} showTitle>
        {formEntry && (
          <div className="tt-oe-form">
            <label className="tt-oe-form-label">
              Course
              {formEntry.id ? (
                <input className="tt-selector" value={`${formOffering?.course_code ?? ''} — ${formOffering?.course_title ?? ''}`} disabled />
              ) : (
                <select className="tt-selector" value={formEntry.course_offering_id ?? ''}
                  onChange={e => setFormEntry({ ...formEntry, course_offering_id: e.target.value })}>
                  <option value="">Choose a course…</option>
                  {modalPool.map(o => <option key={o.id} value={o.id}>{o.course_code} — {o.course_title}{o.staff_name ? ` (${o.staff_name})` : ''}</option>)}
                </select>
              )}
            </label>

            {formOffering && (
              <div className="tt-oe-form-lecturer">
                {formOffering.staff_id ? (
                  <p className="tt-oe-form-lecturer-assigned"><strong>Lecturer:</strong> {formOffering.staff_name ?? 'Assigned'}</p>
                ) : (
                  <label className="tt-oe-form-label">
                    Lecturer — not yet assigned
                    <select className="tt-selector" value={lecturerPickerId} onChange={e => setLecturerPickerId(e.target.value)}>
                      <option value="">Select a lecturer…</option>
                      {lecturers.map(l => <option key={l.id} value={l.id}>{l.full_name}</option>)}
                    </select>
                    <button type="button" className="tt-oe-form-assign-lecturer-btn" onClick={handleAssignLecturer} disabled={!lecturerPickerId || lecturerSaving}>
                      {lecturerSaving ? 'Assigning…' : 'Assign lecturer'}
                    </button>
                    {lecturerError && <p className="tt-oe-form-error">{lecturerError}</p>}
                  </label>
                )}
              </div>
            )}

            <label className="tt-oe-form-label">
              Day
              <select className="tt-selector" value={formEntry.day_of_week ?? 1} onChange={e => setFormEntry({ ...formEntry, day_of_week: Number(e.target.value) })}>
                {days.map(d => <option key={d} value={d}>{dayName(d)}</option>)}
              </select>
            </label>

            {periods.length > 0 && (
              <label className="tt-oe-form-label">
                Period
                <select className="tt-selector" value={selectedPeriodId} onChange={e => handlePeriodPick(e.target.value)}>
                  <option value="">Custom time</option>
                  {periods.filter(p => !p.is_break).map(p => <option key={p.id} value={p.id}>{p.label} ({formatTime(p.start_time)}–{formatTime(p.end_time)})</option>)}
                </select>
              </label>
            )}

            <div className="hg-timerow">
              <label className="tt-oe-form-label">Starts
                <input type="time" className="tt-selector" value={(formEntry.start_time ?? '09:00').slice(0, 5)}
                  onChange={e => { setFormEntry({ ...formEntry, start_time: e.target.value }); setSelectedPeriodId(matchingPeriodId(e.target.value, formEntry.end_time ?? '10:00')) }} />
              </label>
              <label className="tt-oe-form-label">Ends
                <input type="time" className="tt-selector" value={(formEntry.end_time ?? '10:00').slice(0, 5)}
                  onChange={e => { setFormEntry({ ...formEntry, end_time: e.target.value }); setSelectedPeriodId(matchingPeriodId(formEntry.start_time ?? '09:00', e.target.value)) }} />
              </label>
            </div>
            <div className="hg-durbtns">
              {DURATIONS.map(d => <button key={d.minutes} type="button" className="hg-durbtn" onClick={() => setDurationOnForm(d.minutes)}>{d.label}</button>)}
            </div>

            <label className="tt-oe-form-label">
              Venue (optional)
              <input type="text" className="tt-selector" value={formEntry.venue ?? ''} list="hg-venues"
                onChange={e => setFormEntry({ ...formEntry, venue: e.target.value || null })} placeholder="e.g. Lecture Theatre 2" />
              <datalist id="hg-venues">{venueOptions.filter(v => v.id !== NONE).map(v => <option key={v.id} value={v.label} />)}</datalist>
            </label>

            {formError && <p className="tt-oe-form-error">{formError}</p>}
            <button className="tt-oe-form-save-btn" onClick={handleSaveSlot} disabled={formSaving || !formEntry.course_offering_id}>
              {formSaving ? 'Saving…' : 'Save'}
            </button>
            {formEntry.id && (
              confirmRemove ? (
                <div className="hg-remove-confirm">
                  <span>Remove this lesson from the timetable?</span>
                  <button type="button" className="tt-oe-slot-confirm-btn" onClick={() => void handleRemove()}>Yes, remove</button>
                  <button type="button" className="tt-oe-slot-cancel-btn" onClick={() => setConfirmRemove(false)}>Keep</button>
                </div>
              ) : (
                <button type="button" className="tt-oe-slot-delete-btn" onClick={() => setConfirmRemove(true)}>Remove lesson</button>
              )
            )}
          </div>
        )}
      </Modal>

      {/* ── Lesson detail ──────────────────────────────────────────────── */}
      <Modal open={detailEntry !== null} onClose={() => setDetailEntry(null)} title={detailEntry ? `${detailEntry.course_code} — ${detailEntry.course_title}` : ''}>
        {detailEntry && (() => {
          const e = detailEntry
          const lengthMin = mins(e.end_time) - mins(e.start_time)
          const length = lengthMin % 60 === 0 ? `${lengthMin / 60} hr${lengthMin === 60 ? '' : 's'}` : `${Math.floor(lengthMin / 60) ? Math.floor(lengthMin / 60) + ' hr ' : ''}${lengthMin % 60} min`
          const overlaps = (o: OfferingTimetableEntry) =>
            o.id !== e.id && o.course_offering_id !== e.course_offering_id && o.day_of_week === e.day_of_week &&
            rangesOverlap(o.start_time, o.end_time, e.start_time, e.end_time)
          const lecturerWith = e.staff_id ? entries.filter(o => o.staff_id === e.staff_id && overlaps(o)) : []
          const venueWith = e.venue?.trim()
            ? entries.filter(o => o.venue?.trim().toLowerCase() === e.venue!.trim().toLowerCase() && overlaps(o)) : []
          const other = entries
            .filter(o => o.course_offering_id === e.course_offering_id && o.id !== e.id)
            .sort((a, b) => orderedWeekDays(firstDay).indexOf(a.day_of_week) - orderedWeekDays(firstDay).indexOf(b.day_of_week) || a.start_time.localeCompare(b.start_time))
          const level = e.programme_level_id ? levelLabels.get(e.programme_level_id) : null
          const describe = (o: OfferingTimetableEntry) =>
            `${o.course_code} (${formatTime(o.start_time)}–${formatTime(o.end_time)}${o.venue ? `, ${o.venue}` : ''})`
          return (
            <>
              <div className="modal-badge" style={{
                background: 'color-mix(in srgb, var(--color-brand-600, #2563eb) 12%, transparent)',
                color: 'var(--color-brand-700, var(--color-brand-600))',
              }}>
                {dayName(e.day_of_week, true)} · {formatTime(e.start_time)} – {formatTime(e.end_time)}
              </div>
              <div className="modal-title">{e.course_code}</div>
              <div className="modal-sub">{e.course_title}</div>
              <div className="modal-div" />

              <div className="modal-row">
                <span className="modal-ic" aria-hidden="true"><Icon name="clock" size={18} /></span>
                <span>Time: <strong>{dayName(e.day_of_week)}, {formatTime(e.start_time)} – {formatTime(e.end_time)}</strong> ({length})</span>
              </div>
              <div className="modal-row">
                <span className="modal-ic" aria-hidden="true"><Icon name="user" size={18} /></span>
                <span>Lecturer: <strong>{e.staff_name ?? 'Not assigned yet'}</strong></span>
              </div>
              <div className="modal-row">
                <span className="modal-ic" aria-hidden="true"><Icon name="door-open" size={18} /></span>
                <span>Venue: <strong>{e.venue?.trim() || 'Not set'}</strong></span>
              </div>
              <div className="modal-row">
                <span className="modal-ic" aria-hidden="true"><Icon name="graduation-cap" size={18} /></span>
                <span>For: <strong>{level ?? 'Shared / all programmes'}</strong></span>
              </div>

              {other.length > 0 && (
                <>
                  <div className="modal-div" />
                  <div className="modal-row">
                    <span className="modal-ic" aria-hidden="true"><Icon name="calendar" size={18} /></span>
                    <span>Also meets:</span>
                  </div>
                  <ul className="modal-list">
                    {other.map(o => <li key={o.id}>{dayName(o.day_of_week, true)} {formatTime(o.start_time)}–{formatTime(o.end_time)}{o.venue ? ` · ${o.venue}` : ''}</li>)}
                  </ul>
                </>
              )}

              {(lecturerWith.length > 0 || venueWith.length > 0) && (
                <>
                  <div className="modal-div" />
                  {lecturerWith.length > 0 && (
                    <div className="modal-row modal-row--conflict">
                      <span className="modal-ic" aria-hidden="true"><Icon name="alert-triangle" size={18} /></span>
                      <span>{e.staff_name} is also teaching {lecturerWith.map(describe).join('; ')} at the same time.</span>
                    </div>
                  )}
                  {venueWith.length > 0 && (
                    <div className="modal-row modal-row--conflict">
                      <span className="modal-ic" aria-hidden="true"><Icon name="alert-triangle" size={18} /></span>
                      <span>{e.venue} is also used by {venueWith.map(describe).join('; ')} at the same time.</span>
                    </div>
                  )}
                </>
              )}

              {isAdmin && (
                <button type="button" className="tt-edit-btn modal-action" onClick={() => { setDetailEntry(null); enterEditMode(); openEditForm(e) }}>
                  Edit this lesson
                </button>
              )}
            </>
          )
        })()}
      </Modal>
    </div>
  )
}

// ─── Skeleton — reuses tt-root/tt-header/tt-grid-wrapper shell classes ────

function HigherEdTimetableSkeleton() {
  return (
    <div className="tt-root">
      <div className="tt-header">
        <div className="tt-header-top">
          <div className="skeleton tt-skel-badge" />
          <div className="skeleton tt-skel-today-btn" />
        </div>
      </div>
      <div className="tt-grid-wrapper">
        <div className="tt-grid tt-grid--skel">
          {[...Array(5)].map((_, ci) => (
            <div key={ci} className="tt-col">
              <div className="tt-cell tt-cell--day-header">
                <div className="skeleton tt-skel-day" />
              </div>
              {[...Array(3)].map((_, pi) => (
                <div key={pi} className="tt-cell">
                  <div className="skeleton tt-skel-cell" />
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
