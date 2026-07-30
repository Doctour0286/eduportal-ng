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
 * Three audiences, one query shape (per courseOfferingTimetableService.ts's
 * own file header):
 *   - Admin: every offering in the school, full edit chrome.
 *   - Lecturer: only their own assigned offerings, read-only.
 *   - Student: only their own currently-registered offerings, read-only.
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

import { useState, useEffect, useCallback } from 'react'
import {
  loadOfferingTimetable,
  loadOfferingsForTimetableAdmin,
  loadOfferingsForLecturer,
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

// ─── Days of the week present in this school's data (derived, not fixed) ──
// Unlike the secondary grid, there is no school_week_days table backing
// this domain — a course offering's schedule is whatever days its own
// entries actually use. Columns are built from the loaded data itself,
// sorted 0(Sun)..6(Sat), rather than assuming a fixed Mon-Fri grid that
// might not match a real school's actual offering days.

function distinctDaysUsed(entries: OfferingTimetableEntry[]): number[] {
  const days = new Set(entries.map(e => e.day_of_week))
  return Array.from(days).sort((a, b) => a - b)
}

// ─── Root component ─────────────────────────────────────────────────────

export default function TimetableModuleHigherEd({
  schoolId,
  isAdmin,
  currentStaffId = null,
  currentStudentId = null,
}: TimetableModuleHigherEdProps) {
  const [sessionName, setSessionName] = useState<string>('')
  const [offerings, setOfferings] = useState<CourseOffering[]>([])
  const [entries, setEntries] = useState<OfferingTimetableEntry[]>([])
  const [loadState, setLoadState] = useState<'loading' | 'error' | 'empty' | 'ready'>('loading')
  const [errorMsg, setErrorMsg] = useState('')

  const isStudentView = !isAdmin && !!currentStudentId
  const isLecturerView = !isAdmin && !isStudentView

  // ── Edit mode (admin only) ────────────────────────────────────────────
  const [editMode, setEditMode] = useState(false)
  const [editOfferingId, setEditOfferingId] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [formEntry, setFormEntry] = useState<Partial<OfferingTimetableEntry> | null>(null)
  const [formSaving, setFormSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)

  // ── Schedule-tab periods + lecturer assignment (TIER 9 / PROBLEM,
  // 2026-07-30) — admin-only, loaded once alongside offerings/entries,
  // not per form-open, since neither changes while the screen is open. ──
  const [periods, setPeriods] = useState<Period[]>([])
  const [selectedPeriodId, setSelectedPeriodId] = useState<string>('') // '' = custom time
  const [lecturers, setLecturers] = useState<LecturerOption[]>([])
  const [lecturerPickerId, setLecturerPickerId] = useState<string>('')
  const [lecturerSaving, setLecturerSaving] = useState(false)
  const [lecturerError, setLecturerError] = useState<string | null>(null)

  // ── Read-only detail popup (mirrors TimetableModuleSecondary's Session 24 pattern) ──
  const [detailEntry, setDetailEntry] = useState<OfferingTimetableEntry | null>(null)

  // ─── Initial load ─────────────────────────────────────────────────────

  const load = useCallback(async () => {
    setLoadState('loading')
    setErrorMsg('')

    const sessionRes = await loadCurrentSession(schoolId)
    if (sessionRes.error) {
      setLoadState('error')
      setErrorMsg(sessionRes.error)
      return
    }
    if (!sessionRes.data) {
      setLoadState('error')
      setErrorMsg('No current session found. Set up a session in the calendar settings.')
      return
    }
    setSessionName(sessionRes.data.name)

    let offeringsResult: CourseOffering[] = []

    if (isStudentView && currentStudentId) {
      const res = await loadOfferingsForStudent({
        studentId: currentStudentId,
        sessionId: sessionRes.data.id,
      })
      if (!res.ok) {
        setLoadState('error')
        setErrorMsg(res.error)
        return
      }
      offeringsResult = res.data
    } else if (isAdmin) {
      const res = await loadOfferingsForTimetableAdmin(sessionRes.data.id)
      if (!res.ok) {
        setLoadState('error')
        setErrorMsg(res.error)
        return
      }
      offeringsResult = res.data
    } else {
      // Lecturer view — currentStaffId may still be null while identity
      // is resolving; treat that as "no offerings yet," not an error,
      // matching TimetableModuleSecondary's own null-currentStaffId
      // tolerance (alarms simply stay off; here, the view simply stays
      // empty until identity resolves).
      if (!currentStaffId) {
        setOfferings([])
        setEntries([])
        setLoadState('empty')
        return
      }
      const res = await loadOfferingsForLecturer({
        schoolId,
        staffId: currentStaffId,
        isAdmin: false,
        sessionId: sessionRes.data.id,
      })
      if (!res.ok) {
        setLoadState('error')
        setErrorMsg(res.error)
        return
      }
      offeringsResult = res.data
    }

    setOfferings(offeringsResult)

    const offeringIds = offeringsResult.map(o => o.id)
    const entriesRes = await loadOfferingTimetable(offeringIds)
    if (!entriesRes.ok) {
      setLoadState('error')
      setErrorMsg(entriesRes.error)
      return
    }
    setEntries(entriesRes.data)

    // Admin-only, TIER 9 / PROBLEM (2026-07-30): the Schedule-tab periods
    // and staff list power the add/edit-slot form's period picker and
    // lecturer-assignment control respectively — neither is needed for a
    // lecturer/student read-only view, so both are skipped outside the
    // admin branch. Failures here are non-fatal to the screen (the form
    // simply falls back to manual time entry / no lecturer picker) rather
    // than blocking the whole timetable load over a convenience feature.
    if (isAdmin) {
      const [periodsRes, lecturersRes] = await Promise.all([
        loadPeriodsForTimetable(schoolId),
        loadLecturersForAssignment(schoolId),
      ])
      setPeriods(periodsRes.ok ? periodsRes.data : [])
      setLecturers(lecturersRes.ok ? lecturersRes.data : [])
    }

    setLoadState(entriesRes.data.length > 0 || offeringsResult.length > 0 ? 'ready' : 'empty')
  }, [schoolId, isAdmin, isStudentView, currentStudentId, currentStaffId])

  useEffect(() => {
    load()
  }, [load])

  // ─── Conflict ids (admin edit view only — informational) ─────────────

  const conflictIds = findLecturerConflicts(entries)

  // ─── Pre-save conflict check (SESSION 69 follow-up) ───────────────────
  //
  // findLecturerConflicts()/findCohortConflicts() both operate on already-
  // loaded entries, badging saved rows after the fact — that check still
  // runs (above) for the read-only grid. Saving needs the same two checks
  // run BEFORE the write, against the not-yet-saved slot, so the admin can
  // back out rather than only discover a clash after reloading. Neither
  // service function accepts a synthetic entry directly, so this builds
  // one full OfferingTimetableEntry-shaped object from formEntry's time
  // fields + editOffering's course/programme/term fields (formEntry itself
  // only ever carries the four fields openAddSlot() seeds, per the
  // component's own form state), then reuses the exact same rangesOverlap()
  // export and findCohortConflicts() the read-only badges already use —
  // one overlap definition, not a second one re-derived here.
  //
  // Both checks are soft, confirm-to-proceed warnings — never a hard block
  // — matching the real `confirm()` "Save anyway?" precedent already used
  // for the session/term date-bounds warning in SettingsModule.tsx, not a
  // new interaction pattern. If both fire, they're combined into one
  // dialog, not two stacked confirms, so the admin has a single decision
  // to make per save.
  function buildPendingEntry(): OfferingTimetableEntry | null {
    if (!formEntry?.course_offering_id || !formEntry.start_time || !formEntry.end_time) return null
    const offering = offerings.find(o => o.id === formEntry.course_offering_id)
    if (!offering) return null
    return {
      id: formEntry.id ?? '__pending__',
      course_offering_id: offering.id,
      course_id: offering.course_id,
      course_code: offering.course_code,
      course_title: offering.course_title,
      staff_id: offering.staff_id,
      staff_name: offering.staff_name,
      programme_id: offering.programme_id,
      programme_level_id: offering.programme_level_id,
      term_id: offering.term_id,
      day_of_week: formEntry.day_of_week ?? 1,
      start_time: formEntry.start_time,
      end_time: formEntry.end_time,
      venue: formEntry.venue ?? null,
    }
  }

  function findPendingLecturerClash(pending: OfferingTimetableEntry): OfferingTimetableEntry | null {
    if (!pending.staff_id) return null
    for (const e of entries) {
      if (e.id === pending.id) continue // editing an existing row: skip itself
      if (e.course_offering_id === pending.course_offering_id) continue
      if (e.staff_id !== pending.staff_id) continue
      if (e.day_of_week !== pending.day_of_week) continue
      if (rangesOverlap(e.start_time, e.end_time, pending.start_time, pending.end_time)) return e
    }
    return null
  }

  // ─── Edit mode: enter/exit ─────────────────────────────────────────────

  function enterEditMode() {
    setEditMode(true)
    setEditOfferingId(offerings[0]?.id ?? null)
  }

  function exitEditMode() {
    setEditMode(false)
    setEditOfferingId(null)
    setFormOpen(false)
    setFormEntry(null)
  }

  // ─── Add/edit slot form ────────────────────────────────────────────────

  // Finds a saved period whose start/end exactly match the given times, so
  // opening an existing slot for edit correctly shows the picker already
  // set to that period rather than always defaulting to "Custom" — the
  // same "don't make the admin re-derive state the app already has" bar
  // this form's other fields are held to. Compares on time-of-day only
  // (both sides already 'HH:MM' or 'HH:MM:SS'; slice to 5 for a stable
  // compare regardless of which shape either source uses).
  function matchingPeriodId(startTime: string, endTime: string): string {
    const match = periods.find(
      p => p.start_time.slice(0, 5) === startTime.slice(0, 5) && p.end_time.slice(0, 5) === endTime.slice(0, 5)
    )
    return match?.id ?? ''
  }

  function openAddSlot() {
    if (!editOfferingId) return
    const defaultStart = '09:00'
    const defaultEnd = '10:00'
    setFormEntry({
      course_offering_id: editOfferingId,
      day_of_week: 1,
      start_time: defaultStart,
      end_time: defaultEnd,
      venue: null,
    })
    setSelectedPeriodId(matchingPeriodId(defaultStart, defaultEnd))
    setLecturerPickerId('')
    setLecturerError(null)
    setFormError(null)
    setFormOpen(true)
  }

  function openEditSlot(entry: OfferingTimetableEntry) {
    setFormEntry({ ...entry })
    setSelectedPeriodId(matchingPeriodId(entry.start_time, entry.end_time))
    setLecturerPickerId('')
    setLecturerError(null)
    setFormError(null)
    setFormOpen(true)
  }

  // Picking a period pre-fills the same start/end time inputs the form
  // already has — a convenience default, not a constraint. The admin can
  // still edit either time field afterward (which silently reverts the
  // picker to "Custom" on next open, via matchingPeriodId() above, rather
  // than lying about which period is selected).
  function handlePeriodPick(periodId: string) {
    setSelectedPeriodId(periodId)
    if (!periodId) return
    const period = periods.find(p => p.id === periodId)
    if (!period) return
    setFormEntry(prev => prev ? {
      ...prev,
      start_time: period.start_time.slice(0, 5),
      end_time: period.end_time.slice(0, 5),
    } : prev)
  }

  // Lecturer assignment (TIER 9 / PROBLEM) — writes to course_offerings,
  // not to the timetable entry itself (a lecturer belongs to the offering,
  // every one of its time slots inherits it). Reloads afterward so the
  // offering picker's "(name)" suffix and the read-only grid's Lecturer
  // line both immediately reflect the change.
  async function handleAssignLecturer() {
    if (!editOffering || !lecturerPickerId) return
    setLecturerSaving(true)
    setLecturerError(null)
    const res = await assignOfferingLecturer(editOffering, lecturerPickerId)
    setLecturerSaving(false)
    if (!res.ok) {
      setLecturerError(res.error)
      return
    }
    setLecturerPickerId('')
    await load()
  }

  async function handleSaveSlot() {
    if (!formEntry || !formEntry.course_offering_id || !formEntry.start_time || !formEntry.end_time) return
    if (formEntry.start_time >= formEntry.end_time) {
      setFormError('End time must be after start time.')
      return
    }

    // Pre-save conflict check — both soft, both combined into one dialog.
    // buildPendingEntry() can legitimately return null (e.g. the chosen
    // offering isn't in the currently-loaded `offerings` list, which
    // shouldn't happen via the form's own dropdown but isn't assumed
    // impossible) — in that case neither check has enough to run on, so
    // saving proceeds without a warning rather than blocking on a check
    // that has nothing to check.
    const pending = buildPendingEntry()
    if (pending) {
      const lecturerClash = findPendingLecturerClash(pending)
      const cohortRes = await findCohortConflicts([...entries.filter(e => e.id !== pending.id), pending])
      if (!cohortRes.ok) {
        // A failed curriculum-severity lookup shouldn't silently block a
        // save the admin has no way to fix from here — surface it as a
        // form error instead, same as any other failed read in this file.
        setFormError(cohortRes.error)
        return
      }
      const cohortClashesForPending = cohortRes.data.filter(c => c.entryId === pending.id)

      const warnings: string[] = []
      if (lecturerClash) {
        warnings.push(
          `This lecturer is already booked for ${lecturerClash.course_code} — ${lecturerClash.course_title} at an overlapping time.`
        )
      }
      for (const c of cohortClashesForPending) {
        warnings.push(cohortConflictMessage(c))
      }

      if (warnings.length > 0) {
        const proceed = confirm(`${warnings.join('\n\n')}\n\nSave anyway?`)
        if (!proceed) return
      }
    }

    setFormSaving(true)
    setFormError(null)

    const res = await upsertOfferingTimetableEntry({
      id: formEntry.id,
      schoolId,
      courseOfferingId: formEntry.course_offering_id,
      dayOfWeek: formEntry.day_of_week ?? 1,
      startTime: formEntry.start_time,
      endTime: formEntry.end_time,
      venue: formEntry.venue ?? null,
    })

    setFormSaving(false)

    if (!res.ok) {
      setFormError(res.error)
      return
    }

    setFormOpen(false)
    setFormEntry(null)
    await load()
  }

  async function handleConfirmDelete(entryId: string) {
    const res = await deleteOfferingTimetableEntry(entryId)
    setPendingDeleteId(null)
    if (!res.ok) {
      setErrorMsg(res.error)
      return
    }
    await load()
  }

  // ─── Render ─────────────────────────────────────────────────────────────

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
            : `No course-offering timetable has been set up for ${sessionName} yet.`}
          {isAdmin ? ' Tap "Set up timetable" to start adding lessons.' : ''}
        </p>
        {isAdmin && (
          <button className="tt-edit-start-btn" onClick={enterEditMode}>
            Set up timetable
          </button>
        )}
      </div>
    )
  }

  const editOffering = offerings.find(o => o.id === editOfferingId) ?? null
  const editOfferingEntries = entries
    .filter(e => e.course_offering_id === editOfferingId)
    .sort((a, b) => a.day_of_week - b.day_of_week || a.start_time.localeCompare(b.start_time))

  const daysToRender = editMode
    ? [0, 1, 2, 3, 4, 5, 6]
    : distinctDaysUsed(entries)

  return (
    <div className="tt-root">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="tt-header">
        <div className="tt-header-top">
          <span className="tt-session-badge">{sessionName}</span>
          <div className="tt-header-actions">
            {isAdmin && !editMode && (
              <button className="tt-edit-btn" onClick={enterEditMode}>
                Edit
              </button>
            )}
            {isAdmin && editMode && (
              <button className="tt-done-btn" onClick={exitEditMode}>
                Done
              </button>
            )}
          </div>
        </div>

        {isAdmin && editMode && (
          <div className="tt-selector-row">
            <label className="tt-selector-label">Course offering</label>
            <select
              className="tt-selector"
              value={editOfferingId ?? ''}
              onChange={e => setEditOfferingId(e.target.value || null)}
            >
              {offerings.length === 0 && <option value="">No course offerings found</option>}
              {offerings.map(o => (
                <option key={o.id} value={o.id}>
                  {o.course_code} — {o.course_title}{o.staff_name ? ` (${o.staff_name})` : ''}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* ── Edit mode: per-offering slot list ────────────────────────────── */}
      {isAdmin && editMode && (
        <div className="tt-oe-edit-panel">
          {!editOffering ? (
            <p className="tt-empty-msg">Pick a course offering above to manage its schedule.</p>
          ) : (
            <>
              <div className="tt-oe-slot-list">
                {editOfferingEntries.length === 0 && (
                  <p className="tt-empty-msg">No time slots yet for {editOffering.course_code}.</p>
                )}
                {editOfferingEntries.map(entry => (
                  <div key={entry.id} className="tt-oe-slot-row">
                    <div className="tt-oe-slot-info">
                      <span className="tt-oe-slot-day">{dayName(entry.day_of_week, true)}</span>
                      <span className="tt-oe-slot-time">{formatTime(entry.start_time)} – {formatTime(entry.end_time)}</span>
                      {entry.venue && <span className="tt-oe-slot-venue">{entry.venue}</span>}
                      {conflictIds.has(entry.id) && (
                        <span className="tt-conflict-badge" title="This lecturer is double-booked at this time">⚠</span>
                      )}
                    </div>
                    <div className="tt-oe-slot-actions">
                      <button className="tt-oe-slot-edit-btn" onClick={() => openEditSlot(entry)}>Edit</button>
                      {pendingDeleteId === entry.id ? (
                        <>
                          <button className="tt-oe-slot-confirm-btn" onClick={() => handleConfirmDelete(entry.id)}>Confirm</button>
                          <button className="tt-oe-slot-cancel-btn" onClick={() => setPendingDeleteId(null)}>Cancel</button>
                        </>
                      ) : (
                        <button className="tt-oe-slot-delete-btn" onClick={() => setPendingDeleteId(entry.id)}>Remove</button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              <button className="tt-oe-add-slot-btn" onClick={openAddSlot}>+ Add time slot</button>
            </>
          )}
        </div>
      )}

      {/* ── Read-only grid (admin non-edit, lecturer, student) ───────────── */}
      {!editMode && (
        <div className="tt-grid-wrapper">
          <HigherEdTimetableGrid
            entries={entries}
            days={daysToRender}
            conflictIds={conflictIds}
            onEntryTap={setDetailEntry}
          />
        </div>
      )}

      {/* ── Add/edit slot modal ──────────────────────────────────────────── */}
      <Modal open={formOpen} onClose={() => { setFormOpen(false); setFormEntry(null) }} title={formEntry?.id ? 'Edit time slot' : 'Add time slot'}>
        {formEntry && (
          <div className="tt-oe-form">
            {/* Lecturer awareness (TIER 9 / PROBLEM, 2026-07-30) — the
                lecturer belongs to the course offering itself, not to this
                one time slot, so this is display + a fix-it-here shortcut,
                not a per-slot field. When the offering already has a
                lecturer, show it read-only (this form isn't where a
                lecturer gets reassigned once one exists — that stays in
                Curriculum/Offerings setup, matching this problem's own
                scoping to the "never assigned yet" gap). When it doesn't,
                offer the picker directly rather than sending the admin
                back to a different screen mid-scheduling. */}
            {editOffering && (
              <div className="tt-oe-form-lecturer">
                {editOffering.staff_id ? (
                  <p className="tt-oe-form-lecturer-assigned">
                    <strong>Lecturer:</strong> {editOffering.staff_name ?? 'Assigned'}
                  </p>
                ) : (
                  <label className="tt-oe-form-label">
                    Lecturer — not yet assigned
                    <select
                      className="tt-selector"
                      value={lecturerPickerId}
                      onChange={e => setLecturerPickerId(e.target.value)}
                    >
                      <option value="">Select a lecturer…</option>
                      {lecturers.map(l => (
                        <option key={l.id} value={l.id}>{l.full_name}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="tt-oe-form-assign-lecturer-btn"
                      onClick={handleAssignLecturer}
                      disabled={!lecturerPickerId || lecturerSaving}
                    >
                      {lecturerSaving ? 'Assigning…' : 'Assign lecturer'}
                    </button>
                    {lecturerError && <p className="tt-oe-form-error">{lecturerError}</p>}
                  </label>
                )}
              </div>
            )}
            <label className="tt-oe-form-label">
              Day
              <select
                className="tt-selector"
                value={formEntry.day_of_week ?? 1}
                onChange={e => setFormEntry({ ...formEntry, day_of_week: Number(e.target.value) })}
              >
                {[0, 1, 2, 3, 4, 5, 6].map(d => (
                  <option key={d} value={d}>{dayName(d)}</option>
                ))}
              </select>
            </label>
            {/* Schedule-tab period picker (TIER 9 / PROBLEM, 2026-07-30) —
                a convenience default only: picking a period pre-fills the
                two time inputs below, which stay fully editable afterward
                for a one-off time that doesn't match any saved period. */}
            {periods.length > 0 && (
              <label className="tt-oe-form-label">
                Period
                <select
                  className="tt-selector"
                  value={selectedPeriodId}
                  onChange={e => handlePeriodPick(e.target.value)}
                >
                  <option value="">Custom time</option>
                  {periods.filter(p => !p.is_break).map(p => (
                    <option key={p.id} value={p.id}>
                      {p.label} ({formatTime(p.start_time)}–{formatTime(p.end_time)})
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="tt-oe-form-label">
              Start time
              <input
                type="time"
                className="tt-selector"
                value={(formEntry.start_time ?? '09:00').slice(0, 5)}
                onChange={e => {
                  const start_time = e.target.value
                  setFormEntry({ ...formEntry, start_time })
                  setSelectedPeriodId(matchingPeriodId(start_time, formEntry.end_time ?? '10:00'))
                }}
              />
            </label>
            <label className="tt-oe-form-label">
              End time
              <input
                type="time"
                className="tt-selector"
                value={(formEntry.end_time ?? '10:00').slice(0, 5)}
                onChange={e => {
                  const end_time = e.target.value
                  setFormEntry({ ...formEntry, end_time })
                  setSelectedPeriodId(matchingPeriodId(formEntry.start_time ?? '09:00', end_time))
                }}
              />
            </label>
            <label className="tt-oe-form-label">
              Venue (optional)
              <input
                type="text"
                className="tt-selector"
                value={formEntry.venue ?? ''}
                onChange={e => setFormEntry({ ...formEntry, venue: e.target.value || null })}
                placeholder="e.g. Lecture Theatre 2"
              />
            </label>
            {formError && <p className="tt-oe-form-error">{formError}</p>}
            <button className="tt-oe-form-save-btn" onClick={handleSaveSlot} disabled={formSaving}>
              {formSaving ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}
      </Modal>

      {/* ── Read-only detail popup ───────────────────────────────────────── */}
      <Modal
        open={detailEntry !== null}
        onClose={() => setDetailEntry(null)}
        title={detailEntry ? `${detailEntry.course_code} — ${detailEntry.course_title}` : ''}
      >
        {detailEntry && (
          <div className="tt-oe-detail">
            <p><strong>Day:</strong> {dayName(detailEntry.day_of_week)}</p>
            <p><strong>Time:</strong> {formatTime(detailEntry.start_time)} – {formatTime(detailEntry.end_time)}</p>
            {detailEntry.staff_name && <p><strong>Lecturer:</strong> {detailEntry.staff_name}</p>}
            {detailEntry.venue && <p><strong>Venue:</strong> {detailEntry.venue}</p>}
            {conflictIds.has(detailEntry.id) && (
              <p className="tt-oe-detail-conflict">⚠ This lecturer is double-booked at this time with another course offering.</p>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}

// ─── Read-only grid — day columns, entries listed by start time ──────────
// Deliberately NOT a period-row grid (TimetableGrid in TimetableModule.tsx
// is keyed on a fixed period list this domain doesn't have) — each day
// column simply lists that day's entries in start-time order. This is the
// natural rendering for a domain where entries can have arbitrary,
// non-aligned time ranges rather than snapping to a shared period grid.

function HigherEdTimetableGrid({
  entries,
  days,
  conflictIds,
  onEntryTap,
}: {
  entries: OfferingTimetableEntry[]
  days: number[]
  conflictIds: Set<string>
  onEntryTap: (entry: OfferingTimetableEntry) => void
}) {
  if (days.length === 0) {
    return (
      <div className="tt-empty-state">
        <span className="tt-empty-icon"><Icon name="calendar" /></span>
        <p className="tt-empty-msg">No scheduled lessons yet.</p>
      </div>
    )
  }

  return (
    <div className="tt-oe-grid">
      {days.map(d => {
        const dayEntries = entries
          .filter(e => e.day_of_week === d)
          .sort((a, b) => a.start_time.localeCompare(b.start_time))
        return (
          <div key={d} className="tt-col">
            <div className="tt-cell tt-cell--day-header">{dayName(d, true)}</div>
            {dayEntries.length === 0 ? (
              <div className="tt-cell tt-oe-cell--empty" />
            ) : (
              dayEntries.map(entry => (
                <button
                  key={entry.id}
                  className="tt-cell tt-oe-cell--filled"
                  onClick={() => onEntryTap(entry)}
                >
                  <span className="tt-oe-cell-code">{entry.course_code}</span>
                  <span className="tt-oe-cell-time">{formatTime(entry.start_time)}–{formatTime(entry.end_time)}</span>
                  {entry.venue && <span className="tt-oe-cell-venue">{entry.venue}</span>}
                  {conflictIds.has(entry.id) && <span className="tt-conflict-badge">⚠</span>}
                </button>
              ))
            )}
          </div>
        )
      })}
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
