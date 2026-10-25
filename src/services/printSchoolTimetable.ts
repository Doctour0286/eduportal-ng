/**
 * printSchoolTimetable.ts — print-ready whole-school timetable (every class
 * against every period) for one day or all days. Same approach as
 * printTimetable.ts: build an HTML page, open it in a new tab, let the
 * browser's print dialog handle paper/PDF.
 */
import { type TimetableData, type ClassNode, dayName } from './timetableService'

export interface SchoolPrintOptions {
  schoolName: string
  sessionName: string
  data: TimetableData          // weekDays already ordered by the school's first day
  classes: ClassNode[]
  day: number | 'all'
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const hhmm = (t: string) => t.slice(0, 5)

export function printSchoolTimetable(opts: SchoolPrintOptions): boolean {
  const { schoolName, sessionName, data, classes, day } = opts
  const periods = [...data.periods].sort((a, b) => a.sort_order - b.sort_order)
  const days = day === 'all' ? data.weekDays.map(w => w.day_of_week) : [day]
  if (periods.length === 0 || classes.length === 0 || days.length === 0) return false

  const byCell = new Map<string, { subject: string; teacher: string }>()
  for (const e of data.entries) {
    byCell.set(`${e.day_of_week}|${e.class_node_id}|${e.period_id}`, {
      subject: e.subject_name ?? 'Free',
      teacher: e.staff_name ?? '',
    })
  }

  const blocks = days.map(d => {
    const head = periods
      .map(p => `<th class="${p.is_break ? 'brk' : ''}">${esc(p.label)}<br/><small>${hhmm(p.start_time)}–${hhmm(p.end_time)}</small></th>`)
      .join('')
    const rows = classes.map(c => {
      const cells = periods.map(p => {
        if (p.is_break) return '<td class="brk"></td>'
        const slot = byCell.get(`${d}|${c.id}|${p.id}`)
        if (!slot) return '<td class="empty"></td>'
        return `<td><strong>${esc(slot.subject)}</strong>${slot.teacher ? `<br/><small>${esc(slot.teacher)}</small>` : ''}</td>`
      }).join('')
      return `<tr><th class="cls">${esc(c.name)}</th>${cells}</tr>`
    }).join('')
    return `<section><h2>${dayName(d)}</h2><table><thead><tr><th class="cls">Class</th>${head}</tr></thead><tbody>${rows}</tbody></table></section>`
  }).join('')

  const title = `${schoolName} — whole-school timetable`
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><title>${esc(title)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,Helvetica,sans-serif;font-size:9pt;color:#111;padding:1cm}
header{border-bottom:2px solid #111;padding-bottom:.5em;margin-bottom:.8em}
header h1{font-size:14pt} header p{color:#555;font-size:9pt;margin-top:.15em}
section{margin-bottom:1.2em;page-break-inside:avoid}
h2{font-size:11pt;margin:.6em 0 .3em}
table{width:100%;border-collapse:collapse;table-layout:fixed}
th,td{border:1px solid #bbb;padding:3px 4px;vertical-align:top;word-break:break-word}
thead th{background:#eee;text-align:center;font-size:8pt}
.cls{width:70px;background:#f4f4f4;text-align:left}
.brk{background:#e8e8e8;width:26px}
.empty{background:#fafafa}
small{color:#555;font-size:7.5pt}
@media print{@page{size:A4 landscape;margin:1cm}thead{display:table-header-group}}
</style></head><body>
<header><h1>${esc(schoolName)}</h1><p>${esc(sessionName)} · whole-school timetable</p></header>
${blocks}
<script>window.onload=function(){setTimeout(function(){window.print()},250)}</script>
</body></html>`

  const w = window.open('', '_blank')
  if (!w) return false
  w.document.open()
  w.document.write(html)
  w.document.close()
  return true
}
