/**
 * Which dates a student was suspended for, from their status history.
 * A day counts as a suspension day when it is strictly after the day the
 * suspension was recorded and strictly before the day they were reactivated
 * (the reactivation day itself is left alone — they may have attended part
 * of it). A suspension with no reactivation yet runs through `today`.
 */
export interface StatusEventLite { event: 'inactivated' | 'reactivated'; created_at: string }

export function buildSuspendedChecker(events: StatusEventLite[], today: string): (date: string) => boolean {
  const sorted = [...events].sort((a, b) => a.created_at.localeCompare(b.created_at))
  const intervals: { start: string; end: string | null }[] = []
  let open: string | null = null
  for (const e of sorted) {
    const d = e.created_at.slice(0, 10)
    if (e.event === 'inactivated') {
      if (open === null) open = d
    } else if (open !== null) {
      intervals.push({ start: open, end: d })
      open = null
    }
  }
  if (open !== null) intervals.push({ start: open, end: null })
  return (date: string) =>
    date <= today && intervals.some(iv => date > iv.start && (iv.end === null || date < iv.end))
}
