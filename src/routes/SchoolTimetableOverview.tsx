import { useMemo, useState } from 'react'
import type { ClassNode, TimetableData, TimetableEntry } from '../services/timetableService'
import { orderedWeekDays } from '../lib/weekOrder'

/**
 * Whole-school timetable on one screen: every class (rows) against every
 * period (columns) for the chosen day, with subject and teacher in each cell.
 * "All days" stacks every school day one after another. The day order follows
 * the school's chosen first day of the week. Read-only; editing stays in the
 * per-class view.
 */

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const hhmm = (t: string) => t.slice(0, 5)

export default function SchoolTimetableOverview({
  data,
  classes,
  firstDay,
}: {
  data: TimetableData
  classes: ClassNode[]
  firstDay: number
}) {
  const schoolDays = useMemo(
    () => orderedWeekDays(firstDay).filter(d => data.weekDays.some(w => w.day_of_week === d)),
    [data.weekDays, firstDay],
  )
  const periods = useMemo(() => [...data.periods].sort((a, b) => a.sort_order - b.sort_order), [data.periods])

  const [day, setDay] = useState<number | 'all'>(() => {
    const today = new Date().getDay()
    return schoolDays.includes(today) ? today : (schoolDays[0] ?? 'all')
  })

  // entry lookup + teacher clash detection (same teacher, same day+period, 2+ classes)
  const { byCell, clashes } = useMemo(() => {
    const byCell = new Map<string, TimetableEntry>()
    const perSlot = new Map<string, Map<string, number>>()
    for (const e of data.entries) {
      byCell.set(`${e.day_of_week}|${e.class_node_id}|${e.period_id}`, e)
      if (e.staff_id) {
        const slot = `${e.day_of_week}|${e.period_id}`
        const m = perSlot.get(slot) ?? new Map<string, number>()
        m.set(e.staff_id, (m.get(e.staff_id) ?? 0) + 1)
        perSlot.set(slot, m)
      }
    }
    const clashes = new Set<string>()
    for (const e of data.entries) {
      if (e.staff_id && (perSlot.get(`${e.day_of_week}|${e.period_id}`)?.get(e.staff_id) ?? 0) > 1) clashes.add(e.id)
    }
    return { byCell, clashes }
  }, [data.entries])

  if (schoolDays.length === 0 || periods.length === 0 || classes.length === 0) {
    return <p className="tto-empty">Set up school days, periods and classes to see the whole-school timetable.</p>
  }

  const daysToShow = day === 'all' ? schoolDays : [day]

  return (
    <div className="tto">
      <div className="tto-days" role="group" aria-label="Day">
        {schoolDays.map(d => (
          <button
            key={d}
            type="button"
            className={`tto-day${day === d ? ' tto-day--on' : ''}`}
            aria-pressed={day === d}
            onClick={() => setDay(d)}
          >
            {DAY_NAMES[d].slice(0, 3)}
          </button>
        ))}
        <button
          type="button"
          className={`tto-day${day === 'all' ? ' tto-day--on' : ''}`}
          aria-pressed={day === 'all'}
          onClick={() => setDay('all')}
        >
          All days
        </button>
      </div>

      {daysToShow.map(d => (
        <section key={d} className="tto-block">
          <h4 className="tto-day-title">{DAY_NAMES[d]}</h4>
          <div className="tto-scroll">
            <table className="tto-table">
              <thead>
                <tr>
                  <th className="tto-corner">Class</th>
                  {periods.map(p => (
                    <th key={p.id} className={p.is_break ? 'tto-th tto-th--break' : 'tto-th'}>
                      <span className="tto-p-label">{p.label}</span>
                      <span className="tto-p-time">{hhmm(p.start_time)}–{hhmm(p.end_time)}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {classes.map(c => (
                  <tr key={c.id}>
                    <th className="tto-class" title={c.path_label ?? c.name}>{c.name}</th>
                    {periods.map(p => {
                      if (p.is_break) return <td key={p.id} className="tto-cell tto-cell--break" />
                      const e = byCell.get(`${d}|${c.id}|${p.id}`)
                      if (!e) return <td key={p.id} className="tto-cell tto-cell--empty">–</td>
                      const clash = clashes.has(e.id)
                      return (
                        <td
                          key={p.id}
                          className={`tto-cell${e.subject_id ? '' : ' tto-cell--free'}${clash ? ' tto-cell--clash' : ''}`}
                          title={clash ? `${e.staff_name} is booked in more than one class this period` : undefined}
                        >
                          <span className="tto-subject">{e.subject_name ?? 'Free'}</span>
                          {e.staff_name && <span className="tto-teacher">{e.staff_name}</span>}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
      {clashes.size > 0 && (
        <p className="tto-note">Cells outlined in red show a teacher booked in more than one class in the same period.</p>
      )}
    </div>
  )
}
