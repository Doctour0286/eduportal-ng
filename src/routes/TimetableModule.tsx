/**
 * TimetableModule.tsx
 * Phase 6 — Timetable module: read-only view + admin edit mode.
 *
 * Props:
 *   schoolId  — required for all writes (RLS with-check needs explicit school_id)
 *   isAdmin   — retained for read-state copy only (empty-state hint text);
 *               NOT used to gate the edit toolbar as of PRD Session 10 (same
 *               pattern as AttendanceModule.tsx's Session 9 conversion).
 *
 * Permissions (PRD Tier 3 / Session 10, 2026-07-01):
 *   Entering/using edit mode requires `academics.timetable.edit`, read via
 *   useAuthStore's can() directly inside this component — matching
 *   AttendanceModule.tsx's established pattern exactly, not threaded in as
 *   a prop from App.tsx. The store's can() selector already short-circuits
 *   to granted for admin-role holders (admin-bypass, confirmed 2026-07-01),
 *   so no separate isAdmin check is needed for the edit gate itself.
 *
 * Edit-mode interaction (tap-to-select, tap-to-place — no drag/drop):
 *   1. Admin taps "Edit" button → edit mode activates, assignment tray appears.
 *   2. Admin selects a class via the class selector (teacher view is read-only
 *      during edit — you can only edit one class at a time).
 *   3. Assignment chips for that class load into the tray.
 *      A "Free period" chip is always present as the first option.
 *   4. Admin taps a chip → it becomes "armed" (highlighted ring).
 *   5. Admin taps any non-break grid cell → writes/overwrites that slot.
 *   6. Tapping an armed chip again de-arms (cancel selection).
 *   7. Admin taps a filled lesson cell with NO chip armed → inline confirm to clear.
 *   8. Tap "Done" to exit edit mode.
 *
 * Conflict detection (teacher double-booking):
 *   - findConflictingEntryIds() is computed in-memory from all loaded entries,
 *     same day/period/teacher across different classes.
 *   - Conflicting cells show a ⚠ badge. No write is blocked — conflicts are
 *     informational per owner's decision (allow + warn).
 *
 * All CSS uses the `tt-` prefix (no collisions with dash-* or Phase 5 styles).
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { useAuthStore } from '../stores/authStore'
import {
  loadTimetableData,
  loadClassNodes,
  loadStaffList,
  loadCurrentSession,
  loadTeachingAssignments,
  upsertTimetableEntry,
  deleteTimetableEntry,
  findConflictingEntryIds,
  getCurrentPeriod,
  dayName,
  type TimetableData,
  type ClassNode,
  type StaffMember,
  type Period,
  type TimetableEntry,
  type TeachingAssignment,
} from '../services/timetableService'
import { printTimetable } from '../services/printTimetable'

// ─── Prop types ───────────────────────────────────────────────────────────────

interface TimetableModuleProps {
  schoolId: string
  schoolName: string
  isAdmin: boolean
}

// ─── View mode ────────────────────────────────────────────────────────────────

type ViewMode = 'class' | 'teacher'

// ─── Armed chip: what's currently selected in the tray ───────────────────────
// null   = nothing armed
// 'free' = "Free period" chip is armed (writes subject_id: null)
// string = a teaching_assignment id is armed

type ArmedChip = null | 'free' | string

// ─── Root component ───────────────────────────────────────────────────────────

export default function TimetableModule({ schoolId, schoolName, isAdmin }: TimetableModuleProps) {
  // ── Core data ────────────────────────────────────────────────────────────────
  const [sessionId, setSessionId]     = useState<string | null>(null)
  const [sessionName, setSessionName] = useState<string>('')
  const [ttData, setTtData]           = useState<TimetableData | null>(null)
  const [classNodes, setClassNodes]   = useState<ClassNode[]>([])
  const [staffList, setStaffList]     = useState<StaffMember[]>([])
  const [loadState, setLoadState]     = useState<'loading' | 'error' | 'empty' | 'ready'>('loading')
  const [errorMsg, setErrorMsg]       = useState('')

  // ── Auth: permission gate ───────────────────────────────────────────────────
  // Entering/using edit mode requires academics.timetable.edit. Read directly
  // via useAuthStore, same pattern as AttendanceModule.tsx's canMark (Session 9)
  // — not threaded in as a prop. can() already bypasses to true for admin-role
  // holders, so no separate isAdmin check is needed here.
  const canEditTimetable = useAuthStore(s => s.can('academics.timetable.edit'))

  // ── View state ────────────────────────────────────────────────────────────────
  const [viewMode, setViewMode]               = useState<ViewMode>('class')
  const [selectedClassId, setSelectedClassId] = useState<string | null>(null)
  const [selectedStaffId, setSelectedStaffId] = useState<string | null>(null)

  // ── Edit mode state ───────────────────────────────────────────────────────────
  const [editMode, setEditMode]               = useState(false)
  const [assignments, setAssignments]         = useState<TeachingAssignment[]>([])
  const [assignmentsLoading, setAssignmentsLoading] = useState(false)
  const [armedChip, setArmedChip]             = useState<ArmedChip>(null)
  // Entry pending clear confirmation: stores the entry id, or null
  const [pendingClearId, setPendingClearId]   = useState<string | null>(null)
  // Per-cell write state: cellKey → 'saving' | 'error'
  const [cellState, setCellState]             = useState<Record<string, 'saving' | 'error'>>({})

  // ── Live highlight ─────────────────────────────────────────────────────────
  const [liveState, setLiveState] = useState<{ periodId: string | null; dayOfWeek: number }>({
    periodId: null,
    dayOfWeek: new Date().getDay(),
  })

  // ── Scroll ref for "Jump to today" ────────────────────────────────────────
  const scrollRef = useRef<HTMLDivElement>(null)

  // ─── Initial data load ──────────────────────────────────────────────────────

  const load = useCallback(async () => {
    setLoadState('loading')
    setErrorMsg('')

    const sessionRes = await loadCurrentSession()
    if (!sessionRes.ok || !sessionRes.sessionId) {
      setLoadState('error')
      setErrorMsg(sessionRes.error ?? 'No current session')
      return
    }

    const [ttRes, classRes, staffRes] = await Promise.all([
      loadTimetableData(sessionRes.sessionId),
      loadClassNodes(),
      loadStaffList(),
    ])

    if (!ttRes.ok) {
      setLoadState('error')
      setErrorMsg(ttRes.error ?? 'Failed to load timetable')
      return
    }

    setSessionId(sessionRes.sessionId)
    setSessionName(sessionRes.sessionName ?? '')
    setTtData(ttRes.data!)
    setClassNodes(classRes.data ?? [])
    setStaffList(staffRes.data ?? [])

    // Auto-select first leaf class
    const leaves = (classRes.data ?? []).filter(n => n.is_leaf_enrollable)
    if (leaves.length > 0) {
      setSelectedClassId(prev => prev ?? leaves[0].id)
    }
    // Auto-select first staff member
    if ((staffRes.data ?? []).length > 0) {
      setSelectedStaffId(prev => prev ?? (staffRes.data ?? [])[0].id)
    }

    const hasEntries = (ttRes.data?.entries.length ?? 0) > 0
    // In edit mode we stay 'ready' even with zero entries so the grid renders
    setLoadState(hasEntries || editMode ? 'ready' : 'empty')
  }, [editMode])

  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Live highlight ticker ──────────────────────────────────────────────────

  useEffect(() => {
    if (!ttData) return
    const tick = () => setLiveState(getCurrentPeriod(ttData.periods, ttData.weekDays))
    tick()
    const id = setInterval(tick, 60_000)
    return () => clearInterval(id)
  }, [ttData])

  // ─── Load assignment chips when class or session changes ─────────────────────

  useEffect(() => {
    if (!editMode || !sessionId || !selectedClassId) return
    setAssignmentsLoading(true)
    setArmedChip(null)
    loadTeachingAssignments(sessionId, selectedClassId).then(res => {
      setAssignments(res.data ?? [])
      setAssignmentsLoading(false)
    })
  }, [editMode, sessionId, selectedClassId])

  // ─── Enter / exit edit mode ──────────────────────────────────────────────────

  function enterEditMode() {
    // Switch to class view (edit only works per-class)
    setViewMode('class')
    setEditMode(true)
    setArmedChip(null)
    // If we were showing empty-state, switch to ready so grid renders
    if (loadState === 'empty') setLoadState('ready')
  }

  function exitEditMode() {
    setEditMode(false)
    setArmedChip(null)
    setPendingClearId(null)
    setCellState({})
    // Re-check empty state
    const hasEntries = (ttData?.entries.length ?? 0) > 0
    if (!hasEntries) setLoadState('empty')
  }

  // ─── Print current view ───────────────────────────────────────────────────────

  function handlePrint() {
    if (!ttData) return
    const mode = editMode ? 'class' : viewMode
    const classNode = classNodes.find(n => n.id === selectedClassId)
    const staffMember = staffList.find(s => s.id === selectedStaffId)
    printTimetable({ mode, classNode, staffMember, schoolName, sessionName, data: ttData })
  }

  // ─── Jump to today ──────────────────────────────────────────────────────────

  function scrollToToday() {
    if (!scrollRef.current || !ttData) return
    const todayCol = scrollRef.current.querySelector<HTMLElement>(
      `[data-day="${liveState.dayOfWeek}"]`
    )
    todayCol?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })
  }

  // ─── Tap a chip in the tray ──────────────────────────────────────────────────

  function handleChipTap(chipId: ArmedChip) {
    // Tapping an already-armed chip de-arms it
    setArmedChip(prev => (prev === chipId ? null : chipId))
    setPendingClearId(null)
  }

  // ─── Tap a grid cell ─────────────────────────────────────────────────────────

  async function handleCellTap(
    dayOfWeek: number,
    period: Period,
    entry: TimetableEntry | undefined,
  ) {
    if (!editMode || period.is_break || !sessionId || !selectedClassId) return

    // ── Case A: a chip is armed → write to this cell ─────────────────────────
    if (armedChip !== null) {
      const cellKey = `${dayOfWeek}|${period.id}`
      setCellState(prev => ({ ...prev, [cellKey]: 'saving' }))

      let teachingAssignmentId: string | null = null
      let subjectId: string | null = null

      if (armedChip !== 'free') {
        const chip = assignments.find(a => a.id === armedChip)
        if (chip) {
          teachingAssignmentId = chip.id
          subjectId = chip.subject_id
        }
      }

      const res = await upsertTimetableEntry({
        schoolId,
        sessionId,
        dayOfWeek,
        periodId: period.id,
        classNodeId: selectedClassId,
        teachingAssignmentId,
        subjectId,
      })

      if (!res.ok) {
        setCellState(prev => ({ ...prev, [cellKey]: 'error' }))
        // Clear error badge after 3 s
        setTimeout(() => {
          setCellState(prev => {
            const next = { ...prev }
            delete next[cellKey]
            return next
          })
        }, 3000)
        return
      }

      // Optimistic update: patch the in-memory entries list
      const chip = armedChip !== 'free' ? assignments.find(a => a.id === armedChip) : null
      setTtData(prev => {
        if (!prev) return prev
        // Remove any existing entry for this slot
        const filtered = prev.entries.filter(
          e => !(e.day_of_week === dayOfWeek && e.period_id === period.id && e.class_node_id === selectedClassId)
        )
        // Add the new entry — id is temporary; real id comes from next full reload
        const newEntry: TimetableEntry = {
          id: `temp-${Date.now()}`,
          day_of_week: dayOfWeek,
          period_id: period.id,
          class_node_id: selectedClassId,
          class_node_name: classNodes.find(n => n.id === selectedClassId)?.name ?? '',
          subject_id: subjectId,
          subject_name: chip?.subject_name ?? null,
          teaching_assignment_id: teachingAssignmentId,
          staff_id: chip?.staff_id ?? null,
          staff_name: chip?.staff_name ?? null,
        }
        return { ...prev, entries: [...filtered, newEntry] }
      })

      setCellState(prev => {
        const next = { ...prev }
        delete next[cellKey]
        return next
      })
      // Keep chip armed so admin can quickly fill the whole row
      return
    }

    // ── Case B: no chip armed, cell has a lesson → ask to clear ─────────────
    if (entry) {
      setPendingClearId(prev => (prev === entry.id ? null : entry.id))
      return
    }

    // ── Case C: no chip armed, empty cell → do nothing ───────────────────────
  }

  // ─── Confirm clear a slot ────────────────────────────────────────────────────

  async function handleConfirmClear(entryId: string) {
    setPendingClearId(null)
    const res = await deleteTimetableEntry(entryId)
    if (!res.ok) {
      // Surface error briefly via a temporary cell error state
      // (entry id itself as key is fine here)
      setCellState(prev => ({ ...prev, [entryId]: 'error' }))
      setTimeout(() => {
        setCellState(prev => {
          const next = { ...prev }
          delete next[entryId]
          return next
        })
      }, 3000)
      return
    }
    // Remove from in-memory entries
    setTtData(prev => {
      if (!prev) return prev
      return { ...prev, entries: prev.entries.filter(e => e.id !== entryId) }
    })
  }

  // ─── Conflict ids ─────────────────────────────────────────────────────────────
  // Computed from all entries (school-wide, not just the selected class) —
  // this is what makes cross-class conflicts visible.
  const conflictIds = ttData ? findConflictingEntryIds(ttData.entries) : new Set<string>()

  // ─── Render ───────────────────────────────────────────────────────────────────

  if (loadState === 'loading') return <TimetableSkeleton />

  if (loadState === 'error') {
    return (
      <div className="tt-error-state">
        <span className="tt-error-icon">⚠️</span>
        <p className="tt-error-msg">{errorMsg}</p>
        <button className="tt-retry-btn" onClick={load}>Try again</button>
      </div>
    )
  }

  if (loadState === 'empty' && !editMode) {
    return (
      <div className="tt-empty-state">
        <span className="tt-empty-icon">📅</span>
        <p className="tt-empty-title">No timetable yet</p>
        <p className="tt-empty-msg">
          The timetable for {sessionName} hasn't been set up.
          {canEditTimetable
            ? ' Tap "Edit timetable" to start adding lessons.'
            : isAdmin
              ? ' You have admin access but no timetable-edit permission — check Settings → Roles.'
              : ' Check back with your school administrator.'}
        </p>
        {canEditTimetable && (
          <button className="tt-edit-start-btn" onClick={enterEditMode}>
            Edit timetable
          </button>
        )}
      </div>
    )
  }

  const leafNodes = classNodes.filter(n => n.is_leaf_enrollable)

  return (
    <div className="tt-root">

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="tt-header">
        <div className="tt-header-top">
          <span className="tt-session-badge">{sessionName}</span>
          <div className="tt-header-actions">
            {!editMode && (
              <button className="tt-today-btn" onClick={scrollToToday}>
                Today ↓
              </button>
            )}
            {!editMode && ttData && (ttData.entries.length > 0) && (
              <button className="tt-print-btn" onClick={handlePrint} aria-label="Print timetable">
                🖨
              </button>
            )}
            {canEditTimetable && !editMode && (
              <button className="tt-edit-btn" onClick={enterEditMode}>
                Edit
              </button>
            )}
            {canEditTimetable && editMode && (
              <button className="tt-done-btn" onClick={exitEditMode}>
                Done
              </button>
            )}
          </div>
        </div>

        {/* View mode toggle — hidden in edit mode (edit = class view only) */}
        {!editMode && (
          <div className="tt-view-toggle">
            <button
              className={`tt-toggle-btn${viewMode === 'class' ? ' tt-toggle-btn--active' : ''}`}
              onClick={() => setViewMode('class')}
            >
              Class view
            </button>
            <button
              className={`tt-toggle-btn${viewMode === 'teacher' ? ' tt-toggle-btn--active' : ''}`}
              onClick={() => setViewMode('teacher')}
            >
              Teacher view
            </button>
          </div>
        )}

        {/* Selector */}
        {(viewMode === 'class' || editMode) ? (
          <div className="tt-selector-row">
            <label className="tt-selector-label">Class</label>
            <select
              className="tt-selector"
              value={selectedClassId ?? ''}
              onChange={e => setSelectedClassId(e.target.value)}
            >
              {leafNodes.length === 0 && (
                <option value="">No classes found</option>
              )}
              {leafNodes.map(n => (
                <option key={n.id} value={n.id}>
                  {n.path_label ?? n.name}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div className="tt-selector-row">
            <label className="tt-selector-label">Teacher</label>
            <select
              className="tt-selector"
              value={selectedStaffId ?? ''}
              onChange={e => setSelectedStaffId(e.target.value)}
            >
              {staffList.length === 0 && (
                <option value="">No staff found</option>
              )}
              {staffList.map(s => (
                <option key={s.id} value={s.id}>
                  {s.full_name}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Edit mode: assignment tray */}
        {editMode && (
          <AssignmentTray
            assignments={assignments}
            loading={assignmentsLoading}
            armedChip={armedChip}
            onChipTap={handleChipTap}
          />
        )}
      </div>

      {/* ── Grid ────────────────────────────────────────────────────────────── */}
      <div className="tt-grid-wrapper" ref={scrollRef}>
        <TimetableGrid
          data={ttData!}
          viewMode={editMode ? 'class' : viewMode}
          selectedClassId={selectedClassId}
          selectedStaffId={selectedStaffId}
          liveState={liveState}
          editMode={editMode}
          armedChip={armedChip}
          pendingClearId={pendingClearId}
          cellState={cellState}
          conflictIds={conflictIds}
          onCellTap={handleCellTap}
          onConfirmClear={handleConfirmClear}
          onCancelClear={() => setPendingClearId(null)}
        />
      </div>
    </div>
  )
}

// ─── Assignment tray ──────────────────────────────────────────────────────────
// Shown below the selector in edit mode.
// First chip is always "Free period" (marks a slot as deliberately free).
// If no assignments exist for this class, shows a helpful gap message.

interface AssignmentTrayProps {
  assignments: TeachingAssignment[]
  loading: boolean
  armedChip: ArmedChip
  onChipTap: (chipId: ArmedChip) => void
}

function AssignmentTray({ assignments, loading, armedChip, onChipTap }: AssignmentTrayProps) {
  if (loading) {
    return (
      <div className="tt-tray">
        <div className="tt-tray-scroll">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="tt-chip tt-chip--skel skeleton" />
          ))}
        </div>
      </div>
    )
  }

  if (assignments.length === 0) {
    return (
      <div className="tt-tray">
        <p className="tt-tray-empty">
          No subjects assigned to this class yet. Assign teachers to subjects first, then return here.
        </p>
      </div>
    )
  }

  return (
    <div className="tt-tray">
      <p className="tt-tray-hint">Tap a lesson below, then tap a cell to place it.</p>
      <div className="tt-tray-scroll">
        {/* Free-period chip — always first */}
        <button
          className={`tt-chip tt-chip--free${armedChip === 'free' ? ' tt-chip--armed' : ''}`}
          onClick={() => onChipTap('free')}
        >
          <span className="tt-chip-subject">Free period</span>
        </button>

        {/* One chip per teaching assignment */}
        {assignments.map(a => (
          <button
            key={a.id}
            className={`tt-chip${armedChip === a.id ? ' tt-chip--armed' : ''}`}
            onClick={() => onChipTap(a.id)}
          >
            <span className="tt-chip-subject">{a.subject_name}</span>
            <span className="tt-chip-teacher">{a.staff_name}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

// ─── Timetable grid ───────────────────────────────────────────────────────────

interface GridProps {
  data: TimetableData
  viewMode: ViewMode
  selectedClassId: string | null
  selectedStaffId: string | null
  liveState: { periodId: string | null; dayOfWeek: number }
  // Edit mode extras
  editMode: boolean
  armedChip: ArmedChip
  pendingClearId: string | null
  cellState: Record<string, 'saving' | 'error'>
  conflictIds: Set<string>
  onCellTap: (day: number, period: Period, entry: TimetableEntry | undefined) => void
  onConfirmClear: (entryId: string) => void
  onCancelClear: () => void
}

function TimetableGrid({
  data,
  viewMode,
  selectedClassId,
  selectedStaffId,
  liveState,
  editMode,
  armedChip,
  pendingClearId,
  cellState,
  conflictIds,
  onCellTap,
  onConfirmClear,
  onCancelClear,
}: GridProps) {
  const { weekDays, periods, entries } = data

  if (weekDays.length === 0) {
    return (
      <div className="tt-empty-state">
        <p className="tt-empty-msg">
          School week days haven't been configured. Set them up in school settings.
        </p>
      </div>
    )
  }

  // Filter entries for the current view
  const filteredEntries = entries.filter(e => {
    if (viewMode === 'class') return e.class_node_id === selectedClassId
    return e.staff_id === selectedStaffId
  })

  // Build lookup: [day_of_week][period_id] → entry
  const grid: Record<number, Record<string, TimetableEntry>> = {}
  weekDays.forEach(wd => { grid[wd.day_of_week] = {} })
  filteredEntries.forEach(e => {
    if (grid[e.day_of_week]) {
      grid[e.day_of_week][e.period_id] = e
    }
  })

  const today = new Date().getDay()

  return (
    <div className={`tt-grid${editMode ? ' tt-grid--edit' : ''}`}>

      {/* Period label column */}
      <div className="tt-col tt-col--periods">
        <div className="tt-cell tt-cell--corner" />
        {periods.map(p => (
          <div
            key={p.id}
            className={[
              'tt-cell',
              'tt-cell--period-label',
              p.is_break ? 'tt-cell--break' : '',
              liveState.periodId === p.id ? 'tt-cell--live-label' : '',
            ].filter(Boolean).join(' ')}
          >
            <span className="tt-period-name">{p.label}</span>
            <span className="tt-period-time">
              {formatTime(p.start_time)}–{formatTime(p.end_time)}
            </span>
            {liveState.periodId === p.id && (
              <span className="tt-live-dot" aria-label="Live now" />
            )}
          </div>
        ))}
      </div>

      {/* One column per school day */}
      {weekDays.map(wd => {
        const isToday = wd.day_of_week === today && wd.day_of_week === liveState.dayOfWeek
        return (
          <div
            key={wd.day_of_week}
            className={`tt-col${isToday ? ' tt-col--today' : ''}`}
            data-day={wd.day_of_week}
          >
            {/* Day header */}
            <div
              className={`tt-cell tt-cell--day-header${isToday ? ' tt-cell--day-header-today' : ''}`}
            >
              <span className="tt-day-short">{dayName(wd.day_of_week, true)}</span>
              {isToday && <span className="tt-today-pill">Today</span>}
            </div>

            {/* Period cells */}
            {periods.map(p => {
              const entry = grid[wd.day_of_week]?.[p.id]
              const isLive = isToday && liveState.periodId === p.id
              const cellKey = `${wd.day_of_week}|${p.id}`
              const isSaving = cellState[cellKey] === 'saving'
              const isCellError = cellState[cellKey] === 'error'
              const isEntryError = entry && cellState[entry.id] === 'error'
              const isConflict = entry ? conflictIds.has(entry.id) : false
              const isPendingClear = entry ? pendingClearId === entry.id : false

              if (p.is_break) {
                return (
                  <div key={p.id} className="tt-cell tt-cell--break-fill">
                    <span className="tt-break-label">Break</span>
                  </div>
                )
              }

              // ── Saving spinner cell ──────────────────────────────────────
              if (isSaving) {
                return (
                  <div key={p.id} className="tt-cell tt-cell--saving">
                    <span className="tt-saving-spinner" aria-label="Saving…" />
                  </div>
                )
              }

              // ── Empty cell ───────────────────────────────────────────────
              if (!entry) {
                return (
                  <div
                    key={p.id}
                    className={[
                      'tt-cell',
                      'tt-cell--empty',
                      isLive ? 'tt-cell--live' : '',
                      editMode && armedChip !== null ? 'tt-cell--droppable' : '',
                      isCellError ? 'tt-cell--error' : '',
                    ].filter(Boolean).join(' ')}
                    onClick={() => onCellTap(wd.day_of_week, p, undefined)}
                    role={editMode ? 'button' : undefined}
                    aria-label={editMode ? `Place lesson in ${dayName(wd.day_of_week, true)}, ${p.label}` : undefined}
                  >
                    {isCellError && <span className="tt-cell-error-badge">!</span>}
                    {editMode && armedChip !== null && (
                      <span className="tt-cell-drop-hint">+</span>
                    )}
                  </div>
                )
              }

              // ── Filled cell ──────────────────────────────────────────────
              return (
                <div
                  key={p.id}
                  className={[
                    'tt-cell',
                    'tt-cell--lesson',
                    isLive ? 'tt-cell--live' : '',
                    isConflict ? 'tt-cell--conflict' : '',
                    isPendingClear ? 'tt-cell--pending-clear' : '',
                    isEntryError ? 'tt-cell--error' : '',
                    editMode && armedChip !== null ? 'tt-cell--droppable' : '',
                    editMode && armedChip === null ? 'tt-cell--clearable' : '',
                  ].filter(Boolean).join(' ')}
                  onClick={() => onCellTap(wd.day_of_week, p, entry)}
                  role={editMode ? 'button' : undefined}
                  aria-label={
                    editMode
                      ? armedChip !== null
                        ? `Replace lesson in ${dayName(wd.day_of_week, true)}, ${p.label}`
                        : `Clear lesson in ${dayName(wd.day_of_week, true)}, ${p.label}`
                      : undefined
                  }
                >
                  {/* Conflict badge */}
                  {isConflict && (
                    <span className="tt-conflict-badge" title="This teacher is double-booked in this slot">
                      ⚠
                    </span>
                  )}

                  <span className="tt-lesson-subject">
                    {entry.subject_name ?? 'Free period'}
                  </span>
                  {viewMode === 'class' && entry.staff_name && (
                    <span className="tt-lesson-teacher">{entry.staff_name}</span>
                  )}
                  {viewMode === 'teacher' && entry.class_node_name && (
                    <span className="tt-lesson-class">{entry.class_node_name}</span>
                  )}

                  {/* Inline clear confirmation */}
                  {isPendingClear && (
                    <div
                      className="tt-clear-confirm"
                      onClick={e => e.stopPropagation()}
                    >
                      <span className="tt-clear-confirm-msg">Remove this lesson?</span>
                      <div className="tt-clear-confirm-btns">
                        <button
                          className="tt-clear-confirm-yes"
                          onClick={() => onConfirmClear(entry.id)}
                        >
                          Remove
                        </button>
                        <button
                          className="tt-clear-confirm-no"
                          onClick={onCancelClear}
                        >
                          Keep
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────

function TimetableSkeleton() {
  return (
    <div className="tt-root">
      <div className="tt-header">
        <div className="tt-header-top">
          <div className="skeleton tt-skel-badge" />
          <div className="skeleton tt-skel-today-btn" />
        </div>
        <div className="tt-view-toggle">
          <div className="skeleton tt-skel-toggle" />
          <div className="skeleton tt-skel-toggle" />
        </div>
        <div className="tt-selector-row">
          <div className="skeleton tt-skel-selector" />
        </div>
      </div>
      <div className="tt-grid-wrapper">
        <div className="tt-grid tt-grid--skel">
          {[...Array(6)].map((_, ci) => (
            <div key={ci} className="tt-col">
              <div className="tt-cell tt-cell--day-header">
                <div className="skeleton tt-skel-day" />
              </div>
              {[...Array(7)].map((_, pi) => (
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

// ─── Time format helper ───────────────────────────────────────────────────────
// Converts 'HH:MM:SS' (Postgres time) to '8:00 AM' display format

function formatTime(t: string): string {
  const [hStr, mStr] = t.split(':')
  let h = parseInt(hStr, 10)
  const m = mStr
  const ampm = h < 12 ? 'AM' : 'PM'
  if (h === 0) h = 12
  else if (h > 12) h -= 12
  return `${h}:${m} ${ampm}`
}
