/**
 * TermProgressCard.tsx
 * Read-only term/session progress display (PRD Problem 6.7). Originally built
 * for the Guardian/Student portal's Summary tab (Session 29, first pass);
 * a later pass (Session 29, resumed) closed the three pieces flagged as a
 * real gap against the problem's own Definition of Done — a today-marker
 * pin, a notch per school-day holiday, and a break-impact summary line —
 * and added the two dashboard placements (Admin/Teacher) the PRD names as
 * likely.
 *
 * Mirrors the admin Settings screen's effective-end-date computation exactly
 * — both ultimately call attendanceService.getEffectiveTermEndDate() (this
 * one via portalService's loadTermProgress()), so an admin, a teacher, and a
 * parent never see three different "days remaining" numbers for the same
 * term. Holiday notch positions are precomputed server-side by
 * loadTermProgress() too, for the same reason — one source of date math.
 *
 * **Counters corrected 2026-07-10** (owner-reported, via screenshot: the
 * footer showed "Day 100 of 179" while the attendance card on the same term
 * showed "72 school days," with no unit on either to explain the gap).
 * Rather than pick one figure and hide the other, the footer is now a
 * 3-way toggle — **School days** / **All days** / **Weeks** — so the viewer
 * chooses what they want to see instead of the two cards silently
 * disagreeing. School-day and all-day figures both come straight from
 * `loadTermProgress()` (the same `getSchoolDayMap()` the attendance card
 * itself uses for school days, so those two can never drift apart again);
 * weeks is derived client-side as `schoolDays / schoolDaysPerWeek` — real
 * per-school data from `school_week_days`, not a hardcoded ÷5 or ÷7, per
 * Problem 6.7's own PRD wording ("school days per week from
 * school_week_days, not a hardcoded 2"). The progress bar's fill width and
 * today-pin *position* always use `percentElapsed` (calendar-time-based,
 * unaffected by the toggle) so the bar fills at a constant real-time rate
 * rather than jumping unevenly around holiday clusters — only the
 * *numbers displayed* change with the toggle, never the bar's own shape.
 * Defaults to School days (§4.11/owner discussion: the most directly useful
 * figure — "how much real teaching time is left" — day 100-of-179 calendar
 * figures overstate remaining instruction time whenever a term contains a
 * long break).
 *
 * Renders nothing when progress is null (no current session, or the fetch
 * hasn't resolved / failed) — every surface this renders on already degrades
 * its other cards independently, so a missing term-progress card shouldn't
 * block or clutter the rest of the screen.
 */
import { useState } from 'react'
import type { TermProgress } from '../services/portalService'

type DisplayUnit = 'school' | 'calendar' | 'weeks'

export function TermProgressCard({ progress }: { progress: TermProgress | null }) {
  const [unit, setUnit] = useState<DisplayUnit>('school')

  if (!progress) return null

  const holidayCount = progress.holidays.length

  // Weeks derived here, not in portalService.ts — it's a pure display-unit
  // conversion of already-correct school-day figures, not a new fact about
  // the term, so it doesn't need its own round-trip through the data layer.
  // schoolDaysPerWeek can be 0 for a school with no school_week_days rows
  // configured yet — guarded to avoid a divide-by-zero producing NaN/Infinity
  // on the card.
  const weeksPerDay = progress.schoolDaysPerWeek > 0 ? 1 / progress.schoolDaysPerWeek : 0
  const totalWeeks = Math.round(progress.totalSchoolDays * weeksPerDay * 10) / 10
  const elapsedWeeks = Math.round(progress.elapsedSchoolDays * weeksPerDay * 10) / 10
  const remainingWeeks = Math.round(progress.remainingSchoolDays * weeksPerDay * 10) / 10

  let footerElapsedLabel: string
  let footerRemainingLabel: string
  let pinLabel: string

  if (unit === 'calendar') {
    footerElapsedLabel = `Day ${progress.elapsedCalendarDays} of ${progress.totalCalendarDays}`
    footerRemainingLabel = `${progress.remainingCalendarDays} day${progress.remainingCalendarDays === 1 ? '' : 's'} left`
    pinLabel = `Today — day ${progress.elapsedCalendarDays} of ${progress.totalCalendarDays}`
  } else if (unit === 'weeks') {
    footerElapsedLabel = `Week ${elapsedWeeks} of ${totalWeeks}`
    footerRemainingLabel = `${remainingWeeks} week${remainingWeeks === 1 ? '' : 's'} left`
    pinLabel = `Today — week ${elapsedWeeks} of ${totalWeeks}`
  } else {
    footerElapsedLabel = `School day ${progress.elapsedSchoolDays} of ${progress.totalSchoolDays}`
    footerRemainingLabel = `${progress.remainingSchoolDays} school day${progress.remainingSchoolDays === 1 ? '' : 's'} left`
    pinLabel = `Today — school day ${progress.elapsedSchoolDays} of ${progress.totalSchoolDays}`
  }

  return (
    <div className="port-term-progress">
      <div className="port-term-progress-header">
        <span className="port-term-progress-label">{progress.scopeLabel}</span>
        {progress.isExtended && (
          <span className="port-term-progress-extended">Extended</span>
        )}
      </div>

      <div className="port-term-progress-dates">
        {progress.scopeStartDate} → {progress.effectiveEndDate}
        {progress.isExtended && ` (originally ${progress.baseEndDate})`}
      </div>

      <div className="port-term-progress-track">
        <div
          className="port-term-progress-fill"
          style={{ width: `${progress.percentElapsed}%` }}
        />

        {/* Holiday notches — one per school-day holiday within range. Paired
            with a real title tooltip (§4.10: never colour/position alone) so
            the date/reason is available on tap/hover, not just implied by
            placement. Rendered after the fill so notches sit visibly on top
            of it regardless of how far the fill has progressed. */}
        {progress.holidays.map((h) => (
          <div
            key={h.date}
            className={`port-term-progress-notch${h.qualifiesForExtension ? ' port-term-progress-notch--extending' : ''}`}
            style={{ left: `${h.positionPercent}%` }}
            title={`${h.label || h.dayType} — ${h.date}${h.qualifiesForExtension ? ' (extended term)' : ''}`}
          />
        ))}

        {/* Today-marker pin — position uses percentElapsed (calendar-time-based,
            so the pin can never visually disagree with the fill's own edge),
            but the tooltip's numbers follow the same unit toggle as the
            footer below. */}
        <div
          className="port-term-progress-pin"
          style={{ left: `${progress.percentElapsed}%` }}
          title={pinLabel}
        />
      </div>

      <div className="port-term-progress-unit-toggle" role="group" aria-label="Progress display unit">
        <button
          type="button"
          className={`port-term-progress-unit-pill${unit === 'school' ? ' port-term-progress-unit-pill--active' : ''}`}
          onClick={() => setUnit('school')}
          aria-pressed={unit === 'school'}
        >
          School days
        </button>
        <button
          type="button"
          className={`port-term-progress-unit-pill${unit === 'calendar' ? ' port-term-progress-unit-pill--active' : ''}`}
          onClick={() => setUnit('calendar')}
          aria-pressed={unit === 'calendar'}
        >
          All days
        </button>
        <button
          type="button"
          className={`port-term-progress-unit-pill${unit === 'weeks' ? ' port-term-progress-unit-pill--active' : ''}`}
          onClick={() => setUnit('weeks')}
          aria-pressed={unit === 'weeks'}
        >
          Weeks
        </button>
      </div>

      <div className="port-term-progress-footer">
        <span>{footerElapsedLabel}</span>
        <span>{footerRemainingLabel}</span>
      </div>

      {/* Break-impact summary — collapsed by default (<details>, no extra
          state needed), matching the reference app's own .trim-break-row
          expandable-list pattern. Only rendered when there's something to
          show; an empty list would just be dead chrome. */}
      {holidayCount > 0 && (
        <details className="port-term-progress-breaks">
          <summary className="port-term-progress-breaks-summary">
            {holidayCount} break{holidayCount === 1 ? '' : 's'} in this {progress.scopeLabel.toLowerCase().includes('term') ? 'term' : 'period'}
          </summary>
          <ul className="port-term-progress-breaks-list">
            {progress.holidays.map((h) => (
              <li key={h.date} className="port-term-progress-breaks-row">
                <span className="port-term-progress-breaks-date">{h.date}</span>
                <span className="port-term-progress-breaks-label">{h.label || h.dayType}</span>
                {h.qualifiesForExtension && (
                  <span className="port-term-progress-breaks-tag">extends term</span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
