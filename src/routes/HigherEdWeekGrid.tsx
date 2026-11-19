import { useEffect, useMemo, useState } from 'react'
import { dayName, formatTime, type OfferingTimetableEntry } from '../services/courseOfferingTimetableService'

/**
 * Visual timetables for higher-ed course offerings.
 *
 *  HigherEdWeekGrid     one cohort / lecturer / venue across the week:
 *                       days across, time down, each lesson a block sized by
 *                       its real start and end time.
 *  HigherEdDayOverview  every programme level on one screen for one day:
 *                       levels down, time across.
 *
 * Unlike the secondary grid there are no fixed periods — a lesson can start
 * and end at any time — so blocks are positioned by minutes. In edit mode an
 * empty hour is tappable (the module decides what a tap does).
 */

export const toMin = (t: string) => {
  const [h, m] = t.split(':')
  return Number(h) * 60 + Number(m)
}
export const fromMin = (n: number) =>
  `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`

/** A stable colour per course so the same course looks the same everywhere. */
export function courseHue(code: string): number {
  let h = 0
  for (let i = 0; i < code.length; i++) h = (h * 31 + code.charCodeAt(i)) % 360
  return h
}
const blockStyle = (code: string) => {
  const h = courseHue(code)
  return { background: `hsl(${h} 70% 92%)`, borderColor: `hsl(${h} 55% 55%)`, color: `hsl(${h} 45% 22%)` }
}

/** Same-day overlaps share the column side by side instead of stacking on top of each other. */
function layoutLanes(list: OfferingTimetableEntry[]) {
  const sorted = [...list].sort((a, b) => toMin(a.start_time) - toMin(b.start_time) || toMin(a.end_time) - toMin(b.end_time))
  const laneEnds: number[] = []
  const placed = sorted.map(e => {
    const s = toMin(e.start_time)
    let lane = laneEnds.findIndex(end => end <= s)
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(0) }
    laneEnds[lane] = toMin(e.end_time)
    return { e, lane }
  })
  // Lane count per overlapping cluster, so a lone lesson still gets full width.
  return placed.map(p => {
    const s = toMin(p.e.start_time), en = toMin(p.e.end_time)
    const cluster = placed.filter(q => toMin(q.e.start_time) < en && s < toMin(q.e.end_time))
    return { ...p, lanes: Math.max(...cluster.map(q => q.lane)) + 1 }
  })
}

function axisFor(entries: OfferingTimetableEntry[]) {
  const starts = entries.map(e => toMin(e.start_time))
  const ends = entries.map(e => toMin(e.end_time))
  const from = Math.min(7 * 60, ...(starts.length ? [Math.floor(Math.min(...starts) / 60) * 60] : [7 * 60]))
  const to = Math.max(18 * 60, ...(ends.length ? [Math.ceil(Math.max(...ends) / 60) * 60] : [18 * 60]))
  return { from, to }
}

function useNow() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 60_000); return () => clearInterval(t) }, [])
  return { day: now.getDay(), minutes: now.getHours() * 60 + now.getMinutes() }
}

const HOUR_PX = 60

// ─── Week grid ───────────────────────────────────────────────────────────────

export function HigherEdWeekGrid({
  entries,
  days,
  editMode,
  armed,
  lecturerClashIds,
  venueClashIds,
  showLecturer,
  onSlotTap,
  onEntryTap,
}: {
  entries: OfferingTimetableEntry[]
  days: number[]
  editMode: boolean
  armed: boolean
  lecturerClashIds: Set<string>
  venueClashIds: Set<string>
  showLecturer: boolean
  onSlotTap: (day: number, startMinutes: number) => void
  onEntryTap: (entry: OfferingTimetableEntry) => void
}) {
  const now = useNow()
  const { from, to } = useMemo(() => axisFor(entries), [entries])
  const hours = useMemo(() => Array.from({ length: (to - from) / 60 }, (_, i) => from + i * 60), [from, to])
  const interactive = editMode

  return (
    <div className="hg">
      <div className="hg-scroll">
        <div className="hg-table" style={{ gridTemplateColumns: `52px repeat(${days.length}, minmax(112px, 1fr))` }}>
          <div className="hg-corner" />
          {days.map(d => (
            <div key={d} className={`hg-dayhead${now.day === d ? ' hg-dayhead--today' : ''}`}>{dayName(d, true)}</div>
          ))}

          <div className="hg-axis" style={{ height: hours.length * HOUR_PX }}>
            {hours.map(h => (
              <div key={h} className="hg-axis-label" style={{ height: HOUR_PX }}>{formatTime(fromMin(h))}</div>
            ))}
          </div>

          {days.map(d => {
            const laid = layoutLanes(entries.filter(e => e.day_of_week === d))
            const isToday = now.day === d && now.minutes >= from && now.minutes <= to
            return (
              <div key={d} className={`hg-col${now.day === d ? ' hg-col--today' : ''}`} style={{ height: hours.length * HOUR_PX }}>
                {hours.map(h => (
                  interactive ? (
                    <button
                      key={h}
                      type="button"
                      className={`hg-slot hg-slot--tap${armed ? ' hg-slot--armed' : ''}`}
                      style={{ top: ((h - from) / 60) * HOUR_PX, height: HOUR_PX }}
                      onClick={() => onSlotTap(d, h)}
                      aria-label={`${dayName(d)} ${formatTime(fromMin(h))}`}
                    ><span>+</span></button>
                  ) : (
                    <div key={h} className="hg-slot" style={{ top: ((h - from) / 60) * HOUR_PX, height: HOUR_PX }} />
                  )
                ))}

                {laid.map(({ e, lane, lanes }) => {
                  const s = toMin(e.start_time), en = toMin(e.end_time)
                  const clash = lecturerClashIds.has(e.id) || venueClashIds.has(e.id)
                  const height = ((en - s) / 60) * HOUR_PX
                  return (
                    <button
                      key={e.id}
                      type="button"
                      className={`hg-block${clash ? ' hg-block--clash' : ''}`}
                      style={{
                        top: ((s - from) / 60) * HOUR_PX,
                        height: Math.max(24, height - 2),
                        left: `${(lane / lanes) * 100}%`,
                        width: `calc(${100 / lanes}% - 3px)`,
                        ...blockStyle(e.course_code),
                      }}
                      onClick={() => onEntryTap(e)}
                      title={clash
                        ? `${lecturerClashIds.has(e.id) ? 'Lecturer is double-booked. ' : ''}${venueClashIds.has(e.id) ? 'Venue is double-booked.' : ''}`
                        : `${e.course_code} — ${e.course_title}`}
                    >
                      <span className="hg-b-code">{e.course_code}{clash ? ' ⚠' : ''}</span>
                      {height >= 52 && <span className="hg-b-title">{e.course_title}</span>}
                      <span className="hg-b-meta">{formatTime(e.start_time)}–{formatTime(e.end_time)}{e.venue ? ` · ${e.venue}` : ''}</span>
                      {showLecturer && height >= 84 && e.staff_name && <span className="hg-b-meta">{e.staff_name}</span>}
                    </button>
                  )
                })}

                {isToday && <div className="hg-now" style={{ top: ((now.minutes - from) / 60) * HOUR_PX }} />}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ─── Whole school: every lesson in the institution ───────────────────────────

/** One row of the master timetable: a room, a programme level or a lecturer. */
export interface SchoolRow {
  key: string
  label: string
  sub?: string
  match: (e: OfferingTimetableEntry) => boolean
  levelId?: string | null
  venue?: string | null
  staffId?: string | null
}

const COL_PX = 84

export function HigherEdSchoolView({
  entries,
  rows,
  days,
  day,
  onDayChange,
  editMode,
  lecturerClashIds,
  venueClashIds,
  onSlotTap,
  onEntryTap,
}: {
  entries: OfferingTimetableEntry[]
  rows: SchoolRow[]
  days: number[]
  day: number | 'all'
  onDayChange: (d: number | 'all') => void
  editMode: boolean
  lecturerClashIds: Set<string>
  venueClashIds: Set<string>
  onSlotTap: (day: number, row: SchoolRow, startMinutes: number) => void
  onEntryTap: (entry: OfferingTimetableEntry) => void
}) {
  const now = useNow()
  const shown = day === 'all' ? days : [day]
  // One shared time axis, so "All days" lines up from block to block.
  const { from, to } = useMemo(() => axisFor(entries), [entries])
  const hours = useMemo(() => Array.from({ length: (to - from) / 60 }, (_, i) => from + i * 60), [from, to])
  const width = hours.length * COL_PX
  const px = (min: number) => ((min - from) / 60) * COL_PX

  return (
    <div className="hg hgo">
      <div className="tto-days" role="group" aria-label="Day">
        {days.map(d => (
          <button key={d} type="button"
            className={`tto-day${day === d ? ' tto-day--on' : ''}${now.day === d ? ' tto-day--today' : ''}`}
            aria-pressed={day === d} onClick={() => onDayChange(d)}>{dayName(d, true)}</button>
        ))}
        <button type="button" className={`tto-day${day === 'all' ? ' tto-day--on' : ''}`} aria-pressed={day === 'all'} onClick={() => onDayChange('all')}>All days</button>
      </div>

      {shown.map(d => {
        const dayEntries = entries.filter(e => e.day_of_week === d)
        return (
          <section key={d} className="hgo-day">
            {day === 'all' && <h4 className="tto-day-title">{dayName(d)} <span className="hgo-count">{dayEntries.length} lesson{dayEntries.length === 1 ? '' : 's'}</span></h4>}
            <div className="hg-scroll">
              <div className="hgo-table" style={{ ['--track' as string]: `${width}px` }}>
                <div className="hgo-row hgo-row--head">
                  <div className="hgo-label hgo-label--head">{rows.length} row{rows.length === 1 ? '' : 's'}</div>
                  <div className="hgo-track" style={{ width }}>
                    {hours.map(h => <span key={h} className="hgo-hour" style={{ left: px(h), width: COL_PX }}>{formatTime(fromMin(h))}</span>)}
                  </div>
                </div>

                {rows.map(r => {
                  const laid = layoutLanes(dayEntries.filter(r.match))
                  const lanes = Math.max(1, ...laid.map(l => l.lanes), ...laid.map(l => l.lane + 1))
                  const rowH = lanes * 46 + 8
                  return (
                    <div key={r.key} className="hgo-row">
                      <div className="hgo-label" title={r.sub ? `${r.label} — ${r.sub}` : r.label}>
                        <span className="hgo-label-main">{r.label}</span>
                        {r.sub && <span className="hgo-label-sub">{r.sub}</span>}
                      </div>
                      <div className="hgo-track" style={{ width, height: rowH }}>
                        {hours.map(h => (
                          editMode ? (
                            <button key={h} type="button" className="hgo-cell hgo-cell--tap" style={{ left: px(h), width: COL_PX, height: rowH }}
                              onClick={() => onSlotTap(d, r, h)} aria-label={`${r.label}, ${dayName(d)} ${formatTime(fromMin(h))}`}><span>+</span></button>
                          ) : (
                            <div key={h} className="hgo-cell" style={{ left: px(h), width: COL_PX, height: rowH }} />
                          )
                        ))}
                        {laid.map(({ e, lane }) => {
                          const clash = lecturerClashIds.has(e.id) || venueClashIds.has(e.id)
                          const w = Math.max(44, px(toMin(e.end_time)) - px(toMin(e.start_time)) - 2)
                          return (
                            <button key={e.id} type="button" className={`hg-block hgo-block${clash ? ' hg-block--clash' : ''}`}
                              style={{ left: px(toMin(e.start_time)), width: w, top: 4 + lane * 46, height: 42, ...blockStyle(e.course_code) }}
                              onClick={() => onEntryTap(e)}
                              title={`${e.course_code} — ${e.course_title}${e.staff_name ? ` · ${e.staff_name}` : ''}${e.venue ? ` · ${e.venue}` : ''}${clash ? ' (clash)' : ''}`}>
                              <span className="hg-b-code">{e.course_code}{clash ? ' ⚠' : ''}</span>
                              <span className="hg-b-meta">{formatTime(e.start_time)}{e.venue ? ` · ${e.venue}` : ''}</span>
                            </button>
                          )
                        })}
                        {now.day === d && now.minutes >= from && now.minutes <= to && <div className="hgo-now" style={{ left: px(now.minutes) }} />}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </section>
        )
      })}
    </div>
  )
}
