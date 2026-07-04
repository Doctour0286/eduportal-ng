/**
 * TermProgressCard.tsx
 * Read-only term/session progress display for the Guardian/Student portal's
 * Summary tab (Session 29, PRD Problem 6.7). Mirrors the admin Settings
 * screen's effective-end-date computation exactly — both ultimately call
 * attendanceService.getEffectiveTermEndDate() (this one via portalService's
 * loadTermProgress()), so a parent and an admin never see two different
 * "days remaining" numbers for the same term.
 *
 * Renders nothing when progress is null (no current session, or the fetch
 * hasn't resolved / failed) — the Summary tab's other cards already degrade
 * independently, so a missing term-progress card shouldn't block or clutter
 * the rest of the tab.
 */
import type { TermProgress } from '../services/portalService'

export function TermProgressCard({ progress }: { progress: TermProgress | null }) {
  if (!progress) return null

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
      </div>

      <div className="port-term-progress-footer">
        <span>Day {progress.elapsedDays} of {progress.totalDays}</span>
        <span>{progress.remainingDays} day{progress.remainingDays === 1 ? '' : 's'} left</span>
      </div>
    </div>
  )
}
