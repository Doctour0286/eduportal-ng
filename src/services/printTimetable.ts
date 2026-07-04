/**
 * printTimetable.ts
 * Generates a print-ready HTML page for a timetable view and opens it
 * in a new browser tab. The browser's native print dialog handles
 * paper sizing, PDF export, etc. — no third-party library needed.
 *
 * React Native note: this file uses `window.open`, which is browser-only.
 * On the native port, replace the `openPrintWindow` call with a
 * Share-sheet PDF via react-native-print or expo-print — the data
 * assembly (`buildPrintPayload`) is fully platform-agnostic.
 */

import { type TimetableData, type ClassNode, type StaffMember, dayName } from './timetableService'

// ─── Public API ───────────────────────────────────────────────────────────────

export interface PrintOptions {
  mode: 'class' | 'teacher'
  // Class view: pass the selected class node
  classNode?: ClassNode
  // Teacher view: pass the selected staff member
  staffMember?: StaffMember
  schoolName: string
  sessionName: string
  data: TimetableData
}

/**
 * Build the timetable grid data for printing, then open it in a new tab.
 * Returns false if the required selector (class or staff) is missing.
 */
export function printTimetable(opts: PrintOptions): boolean {
  const payload = buildPrintPayload(opts)
  if (!payload) return false
  openPrintWindow(payload.html, payload.title)
  return true
}

// ─── Data assembly (platform-agnostic) ───────────────────────────────────────

interface PrintPayload {
  html: string
  title: string
}

function buildPrintPayload(opts: PrintOptions): PrintPayload | null {
  const { mode, classNode, staffMember, schoolName, sessionName, data } = opts
  const { weekDays, periods, entries } = data

  // Guard: we need a selector for whichever mode is active
  if (mode === 'class' && !classNode) return null
  if (mode === 'teacher' && !staffMember) return null

  // ── Filter entries for this view ─────────────────────────────────────────
  const filteredEntries = entries.filter(e =>
    mode === 'class'
      ? e.class_node_id === classNode!.id
      : e.staff_id === staffMember!.id
  )

  // ── Build lookup: [day][period] → entry ─────────────────────────────────
  const grid: Record<number, Record<string, { subject: string; secondary: string }>> = {}
  weekDays.forEach(wd => { grid[wd.day_of_week] = {} })
  filteredEntries.forEach(e => {
    if (!grid[e.day_of_week]) return
    const subject = e.subject_name ?? 'Free period'
    const secondary = mode === 'class'
      ? (e.staff_name ?? '')
      : (e.class_node_name ?? '')
    grid[e.day_of_week][e.period_id] = { subject, secondary }
  })

  // ── Title / heading strings ──────────────────────────────────────────────
  const viewLabel = mode === 'class'
    ? `Class: ${classNode!.path_label ?? classNode!.name}`
    : `Teacher: ${staffMember!.full_name}`

  const docTitle = `Timetable — ${viewLabel} — ${sessionName}`

  const generatedDate = new Date().toLocaleDateString('en-NG', {
    day: 'numeric', month: 'long', year: 'numeric',
  })

  // ── Build table rows ─────────────────────────────────────────────────────
  const dayHeaders = weekDays
    .map(wd => `<th>${dayName(wd.day_of_week)}</th>`)
    .join('')

  const periodRows = periods.map(p => {
    const periodLabel = `
      <td class="period-label">
        <strong>${escHtml(p.label)}</strong>
        <br/><small>${formatTime(p.start_time)}–${formatTime(p.end_time)}</small>
      </td>
    `
    if (p.is_break) {
      const breakCells = weekDays
        .map(() => `<td class="break-cell">Break</td>`)
        .join('')
      return `<tr class="break-row">${periodLabel}${breakCells}</tr>`
    }

    const dayCells = weekDays.map(wd => {
      const slot = grid[wd.day_of_week]?.[p.id]
      if (!slot) return `<td class="empty-cell"></td>`
      return `
        <td class="lesson-cell">
          <strong>${escHtml(slot.subject)}</strong>
          ${slot.secondary ? `<br/><small>${escHtml(slot.secondary)}</small>` : ''}
        </td>
      `
    }).join('')

    return `<tr>${periodLabel}${dayCells}</tr>`
  }).join('')

  // ── Full HTML document ───────────────────────────────────────────────────
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${escHtml(docTitle)}</title>
  <style>
    /* ── Reset ── */
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: Arial, Helvetica, sans-serif;
      font-size: 11pt;
      color: #111;
      background: #fff;
      padding: 1.5cm;
    }

    /* ── Header ── */
    .print-header {
      margin-bottom: 1.2em;
      border-bottom: 2px solid #111;
      padding-bottom: 0.6em;
    }
    .print-school { font-size: 15pt; font-weight: 700; }
    .print-session { font-size: 10pt; color: #555; margin-top: 0.1em; }
    .print-view { font-size: 12pt; font-weight: 600; margin-top: 0.4em; }
    .print-generated { font-size: 9pt; color: #888; margin-top: 0.2em; }

    /* ── Table ── */
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 0.8em;
      table-layout: fixed;
    }

    th, td {
      border: 1px solid #ccc;
      padding: 5px 6px;
      vertical-align: top;
      word-break: break-word;
    }

    thead th {
      background: #f0f0f0;
      font-size: 10pt;
      font-weight: 700;
      text-align: center;
    }

    /* Period label column — narrower fixed width */
    .period-label {
      width: 80px;
      background: #fafafa;
      font-size: 9pt;
      text-align: center;
      vertical-align: middle;
    }
    .period-label strong { display: block; font-size: 10pt; }
    .period-label small  { color: #666; }

    /* Break row */
    .break-row td { background: #f5f5f5; color: #888; font-size: 9pt; text-align: center; }

    /* Lesson cell */
    .lesson-cell { font-size: 9.5pt; }
    .lesson-cell strong { display: block; }
    .lesson-cell small  { color: #555; }

    /* Empty cell */
    .empty-cell { background: #fafafa; }

    /* ── Print directives ── */
    @media print {
      body { padding: 0; }
      @page { margin: 1.5cm; size: A4 landscape; }
      thead { display: table-header-group; } /* repeat on every page */
    }
  </style>
</head>
<body>
  <div class="print-header">
    <div class="print-school">${escHtml(schoolName)}</div>
    <div class="print-session">Academic session: ${escHtml(sessionName)}</div>
    <div class="print-view">${escHtml(viewLabel)}</div>
    <div class="print-generated">Generated ${escHtml(generatedDate)}</div>
  </div>

  <table>
    <thead>
      <tr>
        <th style="width:80px">Period</th>
        ${dayHeaders}
      </tr>
    </thead>
    <tbody>
      ${periodRows}
    </tbody>
  </table>

  <script>
    // Auto-open the print dialog as soon as the page loads.
    // The user can still cancel; this just saves one tap.
    window.addEventListener('load', function() { window.print(); });
  </script>
</body>
</html>`

  return { html, title: docTitle }
}

// ─── Browser: open in new tab ─────────────────────────────────────────────────
// Strategy: Blob URL → window.open(url).
// document.write() on a blank window is blocked by Android Chrome and most
// modern mobile browsers (cross-origin sandbox). A Blob URL is same-origin
// to the page that created it, so it loads reliably without any policy block.
// The URL is revoked after 60 s — plenty of time for the tab to load it.

function openPrintWindow(html: string, _title: string): void {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
  const url  = URL.createObjectURL(blob)

  // noreferrer prevents the Referer header; noopener is intentionally omitted
  // because it would prevent the new window from being addressable, which some
  // browsers use to block window.open entirely when the opener is detached.
  const win = window.open(url, '_blank', 'noreferrer')

  // Revoke the object URL after the tab has had time to load it.
  // If the browser blocked the popup, win is null — still revoke to avoid leak.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)

  if (!win) {
    // Popup was blocked — nothing more we can do from JS; the browser will
    // typically show its own "popup blocked" UI. The URL is still valid for
    // 60 s so the user can manually navigate to it if the browser surfaces it.
    console.warn('[printTimetable] Popup blocked by browser.')
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Escape HTML special characters to prevent XSS in the generated page. */
function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 'HH:MM:SS' → '8:00 AM' */
function formatTime(t: string): string {
  const [hStr, mStr] = t.split(':')
  let h = parseInt(hStr, 10)
  const m = mStr
  const ampm = h < 12 ? 'AM' : 'PM'
  if (h === 0) h = 12
  else if (h > 12) h -= 12
  return `${h}:${m} ${ampm}`
}
