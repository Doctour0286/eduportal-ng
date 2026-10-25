import { useMemo, useState } from 'react'
import type { ClassNode, Period, TimetableData, TimetableEntry } from '../services/timetableService'

/**
 * Whole-school timetable on one screen: every class (rows) against every
 * period (columns) for the chosen day, subject and teacher in each cell.
 * "All days" stacks every school day. Day order comes from `data.weekDays`,
 * which the module has already ordered by the school's first day of week.
 *
 * Cells are tappable: outside edit mode they open the same lesson-detail
 * popup as the other views; in edit mode they open the lesson chooser, so a
 * whole school can be edited with everything in view. The module owns the
 * data and the writes — this component only renders and reports taps.
 */

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const hhmm = (t: string) => t.slice(0, 5)

export default function SchoolTimetableOverview({
  data,
  classes,
  day,
  onDayChange,
  editMode,
  conflictIds,
  cellState,
  liveState,
  onCellTap,
}: {
  data: TimetableData
  classes: ClassNode[]
  day: number | 'all'
  onDayChange: (d: number | 'all') => void
  editMode: boolean
  conflictIds: Set<string>
  cellState: Record<string, 'saving' | 'error'>
  liveState: { periodId: string | null; dayOfWeek: number }
  onCellTap: (classNode: ClassNode, dayOfWeek: number, period: Period, entry: TimetableEntry | undefined) => void
}) {
  const schoolDays = useMemo(() => data.weekDays.map(w => w.day_of_week), [data.weekDays])
  const periods = useMemo(() => [...data.periods].sort((a, b) => a.sort_order - b.sort_order), [data.periods])
  const [highlightStaff, setHighlightStaff] = useState('')

  const byCell = useMemo(() => {
    const m = new Map<string, TimetableEntry>()
    for (const e of data.entries) m.set(`${e.day_of_week}|${e.class_node_id}|${e.period_id}`, e)
    return m
  }, [data.entries])

  const teachers = useMemo(() => {
    const m = new Map<string, string>()
    for (const e of data.entries) if (e.staff_id && e.staff_name) m.set(e.staff_id, e.staff_name)
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [data.entries])

  if (schoolDays.length === 0 || periods.length === 0 || classes.length === 0) {
    return <p className="tto-empty">Set up school days, periods and classes to see the whole-school timetable.</p>
  }

  const daysToShow = day === 'all' ? schoolDays : [day]

  return (
    <div className={`tto${editMode ? ' tto--edit' : ''}`}>
      <div className="tto-bar">
        <div className="tto-days" role="group" aria-label="Day">
          {schoolDays.map(d => (
            <button
              key={d}
              type="button"
              className={`tto-day${day === d ? ' tto-day--on' : ''}${liveState.dayOfWeek === d ? ' tto-day--today' : ''}`}
              aria-pressed={day === d}
              onClick={() => onDayChange(d)}
            >
              {DAY_NAMES[d].slice(0, 3)}
            </button>
          ))}
          <button
            type="button"
            className={`tto-day${day === 'all' ? ' tto-day--on' : ''}`}
            aria-pressed={day === 'all'}
            onClick={() => onDayChange('all')}
          >
            All days
          </button>
        </div>
        <label className="tto-teacher-pick">
          Highlight teacher
          <select value={highlightStaff} onChange={e => setHighlightStaff(e.target.value)}>
            <option value="">None</option>
            {teachers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
      </div>

      {editMode && <p className="tto-hint">Tap any cell to choose its lesson, mark it free, or clear it.</p>}

      {daysToShow.map(d => (
        <section key={d} className="tto-block">
          <h4 className="tto-day-title">{DAY_NAMES[d]}</h4>
          <div className="tto-scroll">
            <table className="tto-table">
              <thead>
                <tr>
                  <th className="tto-corner">Class</th>
                  {periods.map(p => (
                    <th
                      key={p.id}
                      className={`tto-th${p.is_break ? ' tto-th--break' : ''}${liveState.periodId === p.id && liveState.dayOfWeek === d ? ' tto-th--now' : ''}`}
                    >
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
                      const state = cellState[`${c.id}|${d}|${p.id}`]
                      const clash = e ? conflictIds.has(e.id) : false
                      const dim = highlightStaff !== '' && e?.staff_id !== highlightStaff
                      const lit = highlightStaff !== '' && e?.staff_id === highlightStaff
                      const interactive = editMode || !!e
                      const cls = [
                        'tto-cell',
                        !e ? 'tto-cell--empty' : '',
                        e && !e.subject_id ? 'tto-cell--free' : '',
                        clash ? 'tto-cell--clash' : '',
                        lit ? 'tto-cell--lit' : '',
                        dim ? 'tto-cell--dim' : '',
                        state === 'saving' ? 'tto-cell--saving' : '',
                        state === 'error' ? 'tto-cell--error' : '',
                      ].filter(Boolean).join(' ')
                      return (
                        <td key={p.id} className={cls}>
                          {interactive ? (
                            <button
                              type="button"
                              className="tto-cell-btn"
                              onClick={() => onCellTap(c, d, p, e)}
                              aria-label={`${c.name}, ${DAY_NAMES[d]}, ${p.label}${e ? `: ${e.subject_name ?? 'Free'}` : ': empty'}`}
                              title={clash ? `${e?.staff_name} is booked in more than one class this period` : undefined}
                            >
                              {e ? (
                                <>
                                  <span className="tto-subject">{e.subject_name ?? 'Free'}</span>
                                  {e.staff_name && <span className="tto-teacher">{e.staff_name}</span>}
                                </>
                              ) : (
                                <span className="tto-add">+</span>
                              )}
                              {state === 'error' && <span className="tto-err">Not saved</span>}
                            </button>
                          ) : (
                            '–'
                          )}
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
      {conflictIds.size > 0 && (
        <p className="tto-note">Cells outlined in red show a teacher booked in more than one class in the same period.</p>
      )}
    </div>
  )
}
