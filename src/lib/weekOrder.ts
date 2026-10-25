/** Days 0-6 (Sun-Sat) ordered so the school's chosen first day comes first. */
export function orderedWeekDays(firstDay: number): number[] {
  const f = Number.isInteger(firstDay) && firstDay >= 0 && firstDay <= 6 ? firstDay : 1
  return Array.from({ length: 7 }, (_, i) => (f + i) % 7)
}
