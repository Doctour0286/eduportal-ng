/**
 * LivePeriodWidget.tsx
 * PRD Tier 6 / Problem 6.4, Session 26.
 *
 * Renders above the timetable grid: a collapsed "live banner" (dot indicator,
 * status text, live countdown, expand toggle) and — when expanded — a
 * per-class grid of what every class is doing in the current period, plus a
 * short list of periods still to come today.
 *
 * All state comes from `getCurrentPeriodState()` (timetableService.ts), a
 * pure function over already-loaded `TimetableData` + `ClassNode[]` and the
 * current instant. This component only:
 *   - re-runs that function on a 1s interval against `Date.now()` (no network
 *     calls — per §4.1, ticking must be free), and
 *   - renders whatever state comes back.
 *
 * Reuses the exact same period-boundary logic as `getCurrentPeriod()`
 * (TeacherDashboard's "today's lesson" header, Session 14/17) — this widget
 * calls `getCurrentPeriodState()`, which is deliberately built on the same
 * day/time-window checks, so the two can never disagree about what period it
 * currently is (Session 26 dependency note).
 *
 * `prefers-reduced-motion` is respected globally in index.css — the live dot
 * pulse and expand/collapse both fall back to non-animated states there, not
 * here, so this component doesn't need to branch on it directly.
 */

import { useState, useEffect } from 'react'
import {
  getCurrentPeriodState,
  type TimetableData,
  type ClassNode,
  type LivePeriodState,
} from '../services/timetableService'
import { Icon } from './icons'

interface LivePeriodWidgetProps {
  data: TimetableData
  classNodes: ClassNode[]
  /** Called whenever the resolved state changes, so the parent can wire the
   *  grid's now-col highlight to the exact same state (Session 26 step 6) —
   *  one shared source of truth, not a second derivation. */
  onStateChange?: (state: LivePeriodState) => void
}

const STATUS_TEXT: Record<LivePeriodState['status'], string> = {
  before_school: 'School hasn\u2019t started yet',
  in_period: 'Happening now',
  break: 'Break time',
  after_school: 'School day has ended',
  non_school_day: 'Not a school day',
}

function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function formatClock(t: string): string {
  const [hStr, mStr] = t.split(':')
  let h = parseInt(hStr, 10)
  const ampm = h < 12 ? 'AM' : 'PM'
  if (h === 0) h = 12
  else if (h > 12) h -= 12
  return `${h}:${mStr} ${ampm}`
}

export function LivePeriodWidget({ data, classNodes, onStateChange }: LivePeriodWidgetProps) {
  const [state, setState] = useState<LivePeriodState>(() => getCurrentPeriodState(data, classNodes))
  const [expanded, setExpanded] = useState(false)

  // Tick every second off Date.now() — no network calls, purely re-derives
  // from data/classNodes already in memory (§4.1).
  useEffect(() => {
    const tick = () => {
      const next = getCurrentPeriodState(data, classNodes)
      setState(next)
      onStateChange?.(next)
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, classNodes])

  const isLive = state.status === 'in_period' || state.status === 'break'
  const canExpand = isLive

  return (
    <div className={`lpw-root${isLive ? ' lpw-root--live' : ''}`}>
      {/* ── Collapsed banner ────────────────────────────────────────────── */}
      <button
        type="button"
        className="lpw-banner"
        onClick={() => canExpand && setExpanded(e => !e)}
        aria-expanded={canExpand ? expanded : undefined}
        disabled={!canExpand}
      >
        <span
          className={`lpw-dot${isLive ? ' lpw-dot--live' : ' lpw-dot--idle'}`}
          aria-hidden="true"
        />

        <span className="lpw-body">
          <span className="lpw-status">
            {STATUS_TEXT[state.status]}
            {isLive && state.currentPeriod && (
              <span className="lpw-period-name"> \u2014 {state.currentPeriod.label}</span>
            )}
          </span>

          {state.status === 'before_school' && state.upcoming[0] && (
            <span className="lpw-sub">
              First period starts in {state.upcoming[0].startsInMin} min
              {' '}({formatClock(state.upcoming[0].period.start_time)})
            </span>
          )}
        </span>

        {isLive && state.secondsRemaining !== null && (
          <span className="lpw-countdown" aria-label="Time remaining in this period">
            {formatCountdown(state.secondsRemaining)}
          </span>
        )}

        {canExpand && (
          <span className={`lpw-chevron${expanded ? ' lpw-chevron--open' : ''}`}>
            <Icon name="chevron-down" size={18} />
          </span>
        )}
      </button>

      {/* Progress bar — only meaningful during a real live period/break */}
      {isLive && state.progressFraction !== null && (
        <div className="lpw-progress-track" role="presentation">
          <div
            className="lpw-progress-fill"
            style={{ width: `${Math.round(state.progressFraction * 100)}%` }}
          />
        </div>
      )}

      {/* ── Expanded content ─────────────────────────────────────────────── */}
      {canExpand && expanded && (
        <div className="lpw-expanded">
          {state.liveGrid.length > 0 && (
            <div className="lpw-grid">
              {state.liveGrid.map(row => (
                <div key={row.classNodeId} className="lpw-grid-row">
                  <span className="lpw-grid-class">{row.className}</span>
                  {row.entry ? (
                    <span className="lpw-grid-subject">
                      {row.entry.subject_name ?? 'Free period'}
                      {row.entry.staff_name && (
                        <span className="lpw-grid-teacher"> \u00b7 {row.entry.staff_name}</span>
                      )}
                    </span>
                  ) : (
                    <span className="lpw-grid-subject lpw-grid-subject--free">Free</span>
                  )}
                </div>
              ))}
            </div>
          )}

          {state.upcoming.length > 0 && (
            <div className="lpw-upcoming">
              <span className="lpw-upcoming-label">Up next</span>
              <ul className="lpw-upcoming-list">
                {state.upcoming.map(u => (
                  <li key={u.period.id} className="lpw-upcoming-item">
                    <span className="lpw-upcoming-name">{u.period.label}</span>
                    <span className="lpw-upcoming-time">
                      {formatClock(u.period.start_time)} \u00b7 in {u.startsInMin} min
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
