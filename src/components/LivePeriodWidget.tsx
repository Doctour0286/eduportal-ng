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
 *
 * Bugfix (this session): expanding the panel used to leave long content
 * clipped below the fold with no scroll cue, since opening it doesn't
 * change scroll position on its own. On expand we now scroll the widget's
 * own root into view; index.css also caps `.lpw-expanded`'s height with
 * internal overflow as a backup for very short viewports. Separately, three
 * JSX text nodes were using literal `\uXXXX` escape sequences instead of
 * real characters — JSX doesn't interpret those in bare text (only inside
 * JS string literals), so they were rendering as visible backslash-u
 * codes instead of an em dash / middle dot. Replaced with the actual
 * unicode characters.
 *
 * Alarm wiring (Session 28, PRD Problem 6.6): fires a tone via
 * alarmService.ts at two moments, purely by watching the same ticked
 * `LivePeriodState` this component already re-derives every second —
 * no separate timer, no new network call:
 *   - "warn" tone once, when `secondsRemaining` first drops to or below
 *     `warnLeadMin * 60` for the currently-live period (only if
 *     `early_warning` is on).
 *   - "end" tone once, the first tick where `currentPeriod.id` has
 *     changed away from the id we were just tracking as live (covers both
 *     "period ended, break/next period started" and "period ended, school
 *     day ended").
 * Both are latched per period id (`firedWarnFor`/`firedEndFor` refs) so a
 * re-render or a state object that happens to repeat a value never
 * double-fires — each period's warn/end tone plays exactly once per actual
 * occurrence, not once per tick that happens to match the condition.
 *
 * `alert_scope: 'all'` vs `'mine'` (staff_preferences, migration_session_28)
 * IS implemented, using data this component already receives — no new
 * query. `TimetableEntry` (timetableService.ts) carries `staff_id`
 * end-to-end from `teaching_assignments`, even though `LiveClassEntry`
 * (the per-class display row rendered below) only surfaces `staff_name`
 * for the UI. For the 'mine' check we go straight to `data.entries`
 * instead — the same array `getCurrentPeriodState()` itself reads from —
 * filtering on `day_of_week`/`period_id` matching the live/warning period
 * and `staff_id === staffId`. A teacher with no lesson in the current
 * period (a free period, or a period taught by someone else in every
 * class) simply doesn't trigger a 'mine'-scoped alarm for it, which is the
 * intended meaning of the setting (migration_session_28.sql's alert_scope
 * column comment).
 *
 * Browser notifications (this session, closing a real gap): staff_preferences
 * .browser_notif was stored and toggleable in Settings but nothing acted on
 * it. Both firing points below now also call alarmService.ts's
 * showAlarmNotification() when browser_notif is on — gated the same way as
 * the tone itself (same alert_scope check, same once-per-occurrence latch;
 * no separate notification-specific latch, since a notification with no
 * accompanying tone would be a confusing half-alarm). showAlarmNotification()
 * itself no-ops silently if permission was never granted — permission must
 * be requested from a real user gesture elsewhere (the Settings screen's
 * own browser_notif toggle, not from here, since this tick loop is never a
 * user gesture and the browser would just refuse to prompt).
 * firedEndFor's ref shape was widened from a bare period id to
 * `{ id, label }`, since by the time the "end" tone/notification fires,
 * `next.currentPeriod` has already moved on to whatever comes after — the
 * ended period's own label has to be captured at the moment it was still
 * live, not looked up after the fact.
 */

import { useState, useEffect, useRef } from 'react'
import {
  getCurrentPeriodState,
  type TimetableData,
  type ClassNode,
  type LivePeriodState,
} from '../services/timetableService'
import { playAlarmToneRepeated, showAlarmNotification } from '../services/alarmService'
import type { StaffPreferences } from '../services/settingsService'
import { Icon } from './icons'

interface LivePeriodWidgetProps {
  data: TimetableData
  classNodes: ClassNode[]
  /** Called whenever the resolved state changes, so the parent can wire the
   *  grid's now-col highlight to the exact same state (Session 26 step 6) —
   *  one shared source of truth, not a second derivation. */
  onStateChange?: (state: LivePeriodState) => void
  /**
   * Session 28 — this teacher's own staff_preferences row (or null/undefined
   * if not yet loaded, or if the viewer isn't staff at all — guardians,
   * students, and platform_admins have no row per migration_session_28.sql).
   * Omitting this prop entirely disables alarm firing with no other change
   * in behavior — existing callers that haven't been updated yet keep
   * working exactly as before Session 28.
   */
  staffPrefs?: StaffPreferences | null
  /**
   * Session 28 — the same staff.id staffPrefs was loaded for (App.tsx's
   * currentStaffId, threaded through TimetableModule). Only used to
   * evaluate `alert_scope: 'mine'` against `data.entries[].staff_id`; has
   * no effect when staffPrefs.alert_scope is 'all', and no effect at all if
   * staffPrefs is omitted.
   */
  staffId?: string | null
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

export function LivePeriodWidget({ data, classNodes, onStateChange, staffPrefs, staffId }: LivePeriodWidgetProps) {
  const [state, setState] = useState<LivePeriodState>(() => getCurrentPeriodState(data, classNodes))
  const [expanded, setExpanded] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // Session 28 — latches so each period's warn/end tone fires exactly once
  // per real occurrence, not once per tick that happens to still match the
  // firing condition. Keyed by period id; reset naturally as ids change.
  const firedWarnFor = useRef<string | null>(null)
  const firedEndFor = useRef<{ id: string; label: string } | null>(null)

  // On mobile the expanded panel (per-class grid + upcoming list) can be
  // taller than the viewport below the banner, so opening it doesn't
  // visually "move" anything — the content just renders off-screen with no
  // cue to scroll. Bring the widget's top into view whenever it opens so
  // the newly-revealed content is actually reachable.
  useEffect(() => {
    if (expanded) {
      rootRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [expanded])

  // Tick every second off Date.now() — no network calls, purely re-derives
  // from data/classNodes already in memory (§4.1).
  //
  // Bugfix (this session): staffId was missing from this dependency array.
  // App.tsx resolves currentStaffId asynchronously (a separate lookup from
  // `data`/`classNodes` loading), so it's genuinely possible for this
  // effect to first run while staffId is still null, then never re-run
  // once the real id arrives — data/classNodes don't necessarily change
  // again, so nothing else would trigger a re-run. Every tick after that
  // point calls fireAlarmsIfNeeded → teachesThisPeriod with the *stale*
  // null staffId baked into this closure, which makes teachesThisPeriod
  // always return false — meaning alert_scope: 'mine' (the default) could
  // never match anything and no alarm would ever fire, silently, with
  // nothing visibly wrong (state/countdown/progress bar all still update
  // correctly, since those don't depend on staffId at all). staffPrefs was
  // already a dep, which is why prefs loading late self-healed but staffId
  // loading late did not — the exact asymmetry that made this bug easy to
  // miss on inspection alone.
  useEffect(() => {
    const tick = () => {
      const next = getCurrentPeriodState(data, classNodes)
      setState(next)
      onStateChange?.(next)
      fireAlarmsIfNeeded(next)
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, classNodes, staffPrefs, staffId])

  // Session 28 — true if `staffId` has a real (non-free) lesson in the given
  // day/period, per data.entries (the same array getCurrentPeriodState()
  // itself reads from — TimetableEntry.staff_id is populated end-to-end
  // from teaching_assignments in timetableService.ts's loadTimetableData()).
  // Used only to evaluate alert_scope: 'mine'; always true when scope is
  // 'all' or staffId is unavailable (handled by the caller before this runs).
  function teachesThisPeriod(dayOfWeek: number, periodId: string): boolean {
    if (!staffId) return false
    return data.entries.some(e =>
      e.day_of_week === dayOfWeek &&
      e.period_id === periodId &&
      e.staff_id === staffId,
    )
  }

  // Session 28 — pure side-effect helper, kept out of the tick callback body
  // itself only for readability; still runs on every 1s tick, same as
  // setState/onStateChange above.
  function fireAlarmsIfNeeded(next: LivePeriodState) {
    // TEMP DIAGNOSTIC — remove once the silent-alarm issue is confirmed fixed.
    // Logs once per status change only (not every tick) to stay readable.
    if (next.status !== (fireAlarmsIfNeeded as any)._lastStatus) {
      ;(fireAlarmsIfNeeded as any)._lastStatus = next.status
      console.log('[alarm-debug] status change', {
        status: next.status,
        currentPeriodId: next.currentPeriod?.id ?? null,
        staffId,
        hasStaffPrefs: !!staffPrefs,
        soundEnabled: staffPrefs?.sound_enabled,
        alertScope: staffPrefs?.alert_scope,
        entriesForThisPeriod: next.currentPeriod
          ? data.entries.filter(e => e.day_of_week === next.dayOfWeek && e.period_id === next.currentPeriod!.id)
          : [],
      })
    }

    if (!staffPrefs || !staffPrefs.sound_enabled) return
    const scopedToMine = staffPrefs.alert_scope === 'mine'

    const nextIsLive = next.status === 'in_period' || next.status === 'break'
    const nextPeriodId = next.currentPeriod?.id ?? null

    // "End" tone: the period id we were tracking as live has changed to
    // something else (a new period/break started, or school ended/broke).
    // Guard on firedEndFor to fire exactly once per period id, not once
    // per tick after the change. Scope check runs against the day/period
    // that just ended (firedEndFor.current + next.dayOfWeek — the day
    // can't change mid-period, so reusing next.dayOfWeek here is safe),
    // not the one we're moving into — "mine" means "a period I taught just
    // ended," regardless of whose period comes next.
    const previousLivePeriod = firedEndFor.current
    if (previousLivePeriod && previousLivePeriod.id !== nextPeriodId) {
      const endScopeOk = !scopedToMine || teachesThisPeriod(next.dayOfWeek, previousLivePeriod.id)
      console.log('[alarm-debug] END tone check', { previousLivePeriod, nextPeriodId, scopedToMine, endScopeOk })
      if (endScopeOk) {
        playAlarmToneRepeated(staffPrefs.sound_type, 'end', staffPrefs.sound_vol, staffPrefs.sound_repeat)
        if (staffPrefs.browser_notif) {
          showAlarmNotification(previousLivePeriod.label, 'end')
        }
      }
    }
    firedEndFor.current = nextIsLive && nextPeriodId && next.currentPeriod
      ? { id: nextPeriodId, label: next.currentPeriod.label }
      : null

    // "Warn" tone: only while genuinely live, only if early_warning is on,
    // only once per period id, only the first tick where secondsRemaining
    // has actually dropped to/below the configured lead time, and — when
    // scoped to 'mine' — only if this teacher actually teaches the live
    // period itself.
    if (
      staffPrefs.early_warning &&
      nextIsLive &&
      nextPeriodId &&
      next.secondsRemaining !== null &&
      next.secondsRemaining <= staffPrefs.warn_lead_min * 60 &&
      firedWarnFor.current !== nextPeriodId &&
      (!scopedToMine || teachesThisPeriod(next.dayOfWeek, nextPeriodId))
    ) {
      firedWarnFor.current = nextPeriodId
      playAlarmToneRepeated(staffPrefs.sound_type, 'warn', staffPrefs.sound_vol, 1)
      if (staffPrefs.browser_notif && next.currentPeriod) {
        showAlarmNotification(next.currentPeriod.label, 'warn')
      }
    }
    // Once the period id itself changes (whether to another live period, a
    // break, or nothing), the old latch no longer applies — clear it so a
    // later live period with the same id (tomorrow) can warn again too.
    if (firedWarnFor.current && firedWarnFor.current !== nextPeriodId) {
      firedWarnFor.current = null
    }
  }

  const isLive = state.status === 'in_period' || state.status === 'break'
  const canExpand = isLive

  return (
    <div ref={rootRef} className={`lpw-root${isLive ? ' lpw-root--live' : ''}`}>
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
              <span className="lpw-period-name"> — {state.currentPeriod.label}</span>
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
                        <span className="lpw-grid-teacher"> · {row.entry.staff_name}</span>
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
                      {formatClock(u.period.start_time)} · in {u.startsInMin} min
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
