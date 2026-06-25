/**
 * TimetableModule.tsx
 * Phase 6 — Timetable module (read-only layer).
 *
 * Features:
 *   - Class view:   one class selected → see full week grid
 *   - Teacher view: one teacher selected → see all their lessons across classes
 *   - Live lesson highlight: current period + today's column glow
 *   - Skeleton loading, empty states, error/retry
 *   - Today-pill: jumps the horizontal scroll to today
 *
 * Admin edit mode and conflict detection come in the next session.
 * All CSS classes use the `tt-` prefix so they never collide with
 * dash-* (Phase 6 dashboard) or Phase 5 styles.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { useAuthStore } from '../stores/authStore'
import {
  loadTimetableData,
  loadClassNodes,
  loadStaffList,
  loadCurrentSession,
  getCurrentPeriod,
  dayName,
  type TimetableData,
  type ClassNode,
  type StaffMember,
  type Period,
  type TimetableEntry,
} from '../services/timetableService'

// ─── View mode ────────────────────────────────────────────────────────────────

type ViewMode = 'class' | 'teacher'

// ─── Root component ───────────────────────────────────────────────────────────

export default function TimetableModule() {
  // Auth — needed to decide whether to show admin edit button (next session)
  const actorType = useAuthStore(s => s.actorType)
  const _isAdmin = actorType === 'staff' || actorType === 'platform_admin'

  // Data state
  const [sessionId, setSessionId]       = useState<string | null>(null)
  const [sessionName, setSessionName]   = useState<string>('')
  const [ttData, setTtData]             = useState<TimetableData | null>(null)
  const [classNodes, setClassNodes]     = useState<ClassNode[]>([])
  const [staffList, setStaffList]       = useState<StaffMember[]>([])
  const [loadState, setLoadState]       = useState<'loading' | 'error' | 'empty' | 'ready'>('loading')
  const [errorMsg, setErrorMsg]         = useState('')

  // View mode + selector
  const [viewMode, setViewMode]         = useState<ViewMode>('class')
  const [selectedClassId, setSelectedClassId] = useState<string | null>(null)
  const [selectedStaffId, setSelectedStaffId] = useState<string | null>(null)

  // Live highlight — recomputed every minute
  const [liveState, setLiveState] = useState<{ periodId: string | null; dayOfWeek: number }>({
    periodId: null,
    dayOfWeek: new Date().getDay(),
  })

  // Horizontal scroll ref — for "Jump to today" button
  const scrollRef = useRef<HTMLDivElement>(null)

  // ── Initial load ────────────────────────────────────────────────────────────

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
    if (leaves.length > 0 && !selectedClassId) {
      setSelectedClassId(leaves[0].id)
    }
    // Auto-select first staff member for teacher view
    if ((staffRes.data ?? []).length > 0 && !selectedStaffId) {
      setSelectedStaffId((staffRes.data ?? [])[0].id)
    }

    const hasEntries = (ttRes.data?.entries.length ?? 0) > 0
    setLoadState(hasEntries ? 'ready' : 'empty')
  }, [selectedClassId, selectedStaffId])

  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Live highlight ticker ───────────────────────────────────────────────────

  useEffect(() => {
    if (!ttData) return
    const tick = () => {
      setLiveState(getCurrentPeriod(ttData.periods, ttData.weekDays))
    }
    tick()
    const id = setInterval(tick, 60_000)
    return () => clearInterval(id)
  }, [ttData])

  // ── Jump to today ───────────────────────────────────────────────────────────

  function scrollToToday() {
    if (!scrollRef.current || !ttData) return
    const todayCol = scrollRef.current.querySelector<HTMLElement>(`[data-day="${liveState.dayOfWeek}"]`)
    todayCol?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })
  }

  // ─── Render ─────────────────────────────────────────────────────────────────

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

  if (loadState === 'empty' || !ttData) {
    return (
      <div className="tt-empty-state">
        <span className="tt-empty-icon">📅</span>
        <p className="tt-empty-title">No timetable yet</p>
        <p className="tt-empty-msg">
          The timetable for {sessionName} hasn't been set up.
          {_isAdmin ? ' Use the admin edit mode to add lessons.' : ' Check back later.'}
        </p>
      </div>
    )
  }

  const leafNodes = classNodes.filter(n => n.is_leaf_enrollable)

  return (
    <div className="tt-root">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="tt-header">
        <div className="tt-header-top">
          <span className="tt-session-badge">{sessionName}</span>
          <button className="tt-today-btn" onClick={scrollToToday}>
            Today ↓
          </button>
        </div>

        {/* View mode toggle */}
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

        {/* Selector */}
        {viewMode === 'class' ? (
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
      </div>

      {/* ── Grid ────────────────────────────────────────────────────────── */}
      <div className="tt-grid-wrapper" ref={scrollRef}>
        <TimetableGrid
          data={ttData}
          viewMode={viewMode}
          selectedClassId={selectedClassId}
          selectedStaffId={selectedStaffId}
          liveState={liveState}
        />
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
}

function TimetableGrid({ data, viewMode, selectedClassId, selectedStaffId, liveState }: GridProps) {
  const { weekDays, periods, entries } = data

  if (weekDays.length === 0) {
    return (
      <div className="tt-empty-state">
        <p className="tt-empty-msg">Week days haven't been configured. Set them up in school settings.</p>
      </div>
    )
  }

  // Filter entries for the current view
  const filteredEntries = entries.filter(e => {
    if (viewMode === 'class') return e.class_node_id === selectedClassId
    return e.staff_id === selectedStaffId
  })

  // Build a lookup: [day_of_week][period_id] → entry
  const grid: Record<number, Record<string, TimetableEntry>> = {}
  weekDays.forEach(wd => { grid[wd.day_of_week] = {} })
  filteredEntries.forEach(e => {
    if (grid[e.day_of_week]) {
      grid[e.day_of_week][e.period_id] = e
    }
  })

  const today = new Date().getDay()

  return (
    <div className="tt-grid">
      {/* Period label column */}
      <div className="tt-col tt-col--periods">
        {/* Top-left corner */}
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
            <div className={`tt-cell tt-cell--day-header${isToday ? ' tt-cell--day-header-today' : ''}`}>
              <span className="tt-day-short">{dayName(wd.day_of_week, true)}</span>
              {isToday && <span className="tt-today-pill">Today</span>}
            </div>

            {/* Period cells */}
            {periods.map(p => {
              const entry = grid[wd.day_of_week]?.[p.id]
              const isLive = isToday && liveState.periodId === p.id

              if (p.is_break) {
                return (
                  <div key={p.id} className="tt-cell tt-cell--break-fill">
                    <span className="tt-break-label">Break</span>
                  </div>
                )
              }

              if (!entry) {
                return (
                  <div
                    key={p.id}
                    className={`tt-cell tt-cell--empty${isLive ? ' tt-cell--live' : ''}`}
                  />
                )
              }

              return (
                <div
                  key={p.id}
                  className={[
                    'tt-cell',
                    'tt-cell--lesson',
                    isLive ? 'tt-cell--live' : '',
                  ].filter(Boolean).join(' ')}
                >
                  <span className="tt-lesson-subject">
                    {entry.subject_name ?? 'Free period'}
                  </span>
                  {viewMode === 'class' && entry.staff_name && (
                    <span className="tt-lesson-teacher">{entry.staff_name}</span>
                  )}
                  {viewMode === 'teacher' && entry.class_node_name && (
                    <span className="tt-lesson-class">{entry.class_node_name}</span>
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
