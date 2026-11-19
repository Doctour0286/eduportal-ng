/**
 * printHigherEdTimetable.ts — print the timetable currently on screen
 * (one cohort / lecturer / venue across the week). Builds a half-hour grid
 * where each lesson spans the rows it occupies, opens it in a new tab and
 * lets the browser's print dialog do the rest.
 */
import { dayName, formatTime, type OfferingTimetableEntry } from './courseOfferingTimetableService'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const toMin = (t: string) => { const [h, m] = t.split(':'); return Number(h) * 60 + Number(m) }
const STEP = 30

export function printHigherEdTimetable(opts: {
  title: string
  subtitle: string
  schoolName: string
  entries: OfferingTimetableEntry[]
  days: number[]
}): boolean {
  const { title, subtitle, schoolName, entries, days } = opts
  if (entries.length === 0 || days.length === 0) return false

  const from = Math.min(...entries.map(e => Math.floor(toMin(e.start_time) / 60) * 60))
  const to = Math.max(...entries.map(e => Math.ceil(toMin(e.end_time) / 60) * 60))
  const slots: number[] = []
  for (let m = from; m < to; m += STEP) slots.push(m)

  // Pre-compute, per day, which entry starts at which slot and how many rows it spans.
  const covered = new Map<string, Set<number>>()
  const rows = slots.map(slot => {
    const cells = days.map(d => {
      const skip = covered.get(`${d}`)
      if (skip?.has(slot)) return ''
      const starting = entries.filter(e => e.day_of_week === d && toMin(e.start_time) >= slot && toMin(e.start_time) < slot + STEP)
      if (starting.length === 0) return '<td class="empty"></td>'
      const span = Math.max(...starting.map(e => Math.max(1, Math.ceil((toMin(e.end_time) - slot) / STEP))))
      const set = covered.get(`${d}`) ?? new Set<number>()
      for (let k = 1; k < span; k++) set.add(slot + k * STEP)
      covered.set(`${d}`, set)
      const body = starting.map(e =>
        `<div class="les"><strong>${esc(e.course_code)}</strong> ${esc(e.course_title)}<br/><small>${formatTime(e.start_time)}–${formatTime(e.end_time)}${e.venue ? ' · ' + esc(e.venue) : ''}${e.staff_name ? '<br/>' + esc(e.staff_name) : ''}</small></div>`
      ).join('')
      return `<td rowspan="${span}">${body}</td>`
    }).join('')
    const label = slot % 60 === 0 ? formatTime(`${String(slot / 60).padStart(2, '0')}:00`) : ''
    return `<tr><th class="time">${label}</th>${cells}</tr>`
  }).join('')

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><title>${esc(title)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,Helvetica,sans-serif;font-size:9pt;color:#111;padding:1cm}
header{border-bottom:2px solid #111;padding-bottom:.5em;margin-bottom:.8em}
header h1{font-size:14pt} header p{color:#555;margin-top:.15em}
table{width:100%;border-collapse:collapse;table-layout:fixed}
th,td{border:1px solid #bbb;padding:3px 5px;vertical-align:top;word-break:break-word}
thead th{background:#eee;font-size:9pt}
.time{width:48px;background:#f4f4f4;text-align:right;font-size:8pt;color:#555}
.empty{background:#fafafa}
td[rowspan]{background:#eef4ff}
.les+.les{border-top:1px dashed #99a;margin-top:3px;padding-top:3px}
small{color:#444;font-size:7.5pt}
tr{height:15px}
@media print{@page{size:A4 landscape;margin:1cm}}
</style></head><body>
<header><h1>${esc(title)}</h1><p>${esc(schoolName)} · ${esc(subtitle)}</p></header>
<table><thead><tr><th class="time"></th>${days.map(d => `<th>${dayName(d)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>
<script>window.onload=function(){setTimeout(function(){window.print()},250)}</script>
</body></html>`

  const w = window.open('', '_blank')
  if (!w) return false
  w.document.open(); w.document.write(html); w.document.close()
  return true
}

/**
 * Whole-school print: for each chosen day, rows (rooms / levels / lecturers)
 * down the side and half-hour columns across; a lesson spans the columns it
 * occupies. Lessons that overlap within a row get their own line, so nothing
 * is hidden.
 */
export function printHigherEdSchool(opts: {
  title: string
  subtitle: string
  entries: OfferingTimetableEntry[]
  rows: { label: string; match: (e: OfferingTimetableEntry) => boolean }[]
  days: number[]
}): boolean {
  const { title, subtitle, entries, rows, days } = opts
  if (entries.length === 0 || rows.length === 0 || days.length === 0) return false
  const from = Math.min(...entries.map(e => Math.floor(toMin(e.start_time) / 60) * 60))
  const to = Math.max(...entries.map(e => Math.ceil(toMin(e.end_time) / 60) * 60))
  const cols = Math.ceil((to - from) / STEP)

  const sections = days.map(d => {
    const dayEntries = entries.filter(e => e.day_of_week === d)
    const head = Array.from({ length: cols }, (_, i) => {
      const m = from + i * STEP
      return `<th>${m % 60 === 0 ? formatTime(`${String(m / 60).padStart(2, '0')}:00`) : ''}</th>`
    }).join('')
    const body = rows.map(r => {
      const mine = dayEntries.filter(r.match).sort((a, b) => toMin(a.start_time) - toMin(b.start_time))
      // greedy lanes
      const lanes: OfferingTimetableEntry[][] = []
      for (const e of mine) {
        const lane = lanes.find(l => toMin(l[l.length - 1].end_time) <= toMin(e.start_time))
        if (lane) lane.push(e); else lanes.push([e])
      }
      if (lanes.length === 0) lanes.push([])
      return lanes.map((lane, li) => {
        let cursor = 0
        let cells = ''
        for (const e of lane) {
          const start = Math.max(0, Math.floor((toMin(e.start_time) - from) / STEP))
          const span = Math.max(1, Math.ceil((toMin(e.end_time) - toMin(e.start_time)) / STEP))
          if (start > cursor) cells += `<td colspan="${start - cursor}" class="empty"></td>`
          cells += `<td colspan="${span}" class="les"><strong>${esc(e.course_code)}</strong><br/><small>${formatTime(e.start_time)}${e.venue ? ' · ' + esc(e.venue) : ''}${e.staff_name ? ' · ' + esc(e.staff_name) : ''}</small></td>`
          cursor = start + span
        }
        if (cursor < cols) cells += `<td colspan="${cols - cursor}" class="empty"></td>`
        return `<tr>${li === 0 ? `<th class="cls" rowspan="${lanes.length}">${esc(r.label)}</th>` : ''}${cells}</tr>`
      }).join('')
    }).join('')
    return `<section><h2>${dayName(d)}</h2><table><thead><tr><th class="cls"></th>${head}</tr></thead><tbody>${body}</tbody></table></section>`
  }).join('')

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><title>${esc(title)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,Helvetica,sans-serif;font-size:8pt;color:#111;padding:.8cm}
header{border-bottom:2px solid #111;padding-bottom:.4em;margin-bottom:.6em}
header h1{font-size:13pt} header p{color:#555;margin-top:.1em}
section{margin-bottom:1em;page-break-inside:avoid}
h2{font-size:10.5pt;margin:.4em 0 .25em}
table{width:100%;border-collapse:collapse;table-layout:fixed}
th,td{border:1px solid #ccc;padding:2px 3px;vertical-align:top;overflow:hidden}
thead th{background:#eee;font-size:7pt;text-align:left}
.cls{width:90px;background:#f4f4f4;text-align:left}
.les{background:#eef4ff}
.empty{background:#fcfcfc}
small{color:#444;font-size:6.5pt}
@media print{@page{size:A4 landscape;margin:.8cm}thead{display:table-header-group}}
</style></head><body>
<header><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></header>
${sections}
<script>window.onload=function(){setTimeout(function(){window.print()},250)}</script>
</body></html>`
  const w = window.open('', '_blank')
  if (!w) return false
  w.document.open(); w.document.write(html); w.document.close()
  return true
}
