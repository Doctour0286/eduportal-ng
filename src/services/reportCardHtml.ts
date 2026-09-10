/**
 * reportCardHtml.ts
 * PRD Tier 8 / Problem 8.4 (Session 83 — owner decision after extensive
 * jsPDF Arabic-rendering investigation across Sessions 80-82).
 *
 * WHY THIS FILE EXISTS: jsPDF's own text-drawing internals cannot
 * correctly render multi-word Arabic text, confirmed extensively (see
 * pdfTextShaping.ts's file header for the investigation) — and even after
 * building a from-scratch word-by-word/run-based workaround that matched
 * an independent reference implementation exactly in every test, a real
 * device still showed corrupted output that could not be reproduced or
 * explained through further code inspection. Rather than continue
 * fighting jsPDF's text layout, this file follows the EXACT proven
 * pattern this codebase already uses successfully for student ID cards
 * (printStudentIdCards.ts) and timetables (printTimetable.ts): build a
 * plain HTML document and let the browser's own, real, battle-tested text
 * rendering engine draw it — Arabic, bidi, mixed scripts, and font
 * shaping all work correctly for free, because it's the same engine that
 * renders every other web page on the device correctly.
 *
 * Same open/print mechanism as printStudentIdCards.ts: build HTML string
 * → Blob → URL.createObjectURL → window.open(url), with an auto-triggered
 * window.print() once the new tab loads. The person can print physically
 * or choose "Save as PDF" in the print dialog to get a real PDF file —
 * this is the standard way browsers themselves turn HTML into PDF, and
 * it's exactly what generates a correct, real PDF without this codebase
 * needing its own PDF-text-layout engine at all.
 *
 * Batch printing (single vs multiple students) is handled by the SAME
 * function — one HTML document, one `.rc-card` block per student, each
 * with `page-break-after: always` (except the last) so a multi-student
 * batch prints as one job with one page per student, matching
 * downloadBatchReportCardPdf's "one combined output" contract from the
 * jsPDF version, but for real this time (no page-numbering-order bugs
 * possible here — the browser lays out and paginates the document itself).
 *
 * Field-for-field mirrors reportCardPdf.ts's layout (header/logo/photo,
 * student info, grading key, subjects table, summary row, notice,
 * attendance, remarks with signatures, resumption/fees, signature lines,
 * footer) so a school moving from the PDF version to this one sees the
 * same information in the same places — this file is a rendering-engine
 * swap, not a redesign.
 */

import { getGradeRemark, getAvgGradeLabel, ordinal, type GradeBandLike } from './reportCardGrading'
import type { ReportCardData } from './assessmentService'

// ─── Types (mirrors reportCardPdf.ts's ReportCardPdfOptions) ───────────────

export interface ReportCardHtmlOptions {
  schoolName: string
  schoolAddress?: string
  schoolPhone?: string | null
  schoolEmail?: string | null
  /** Directly-renderable logo URL (public bucket, or already-resolved) —
   *  same convention as printStudentIdCards.ts's schoolLogoUrl. */
  logoUrl?: string | null
  gradeBands?: GradeBandLike[]
  data: ReportCardData
}

// ─── Public entry points ────────────────────────────────────────────────────

/**
 * Opens ONE student's report card in a new tab and triggers print.
 * `data.studentPhotoUrl` must already be a directly-renderable URL (signed
 * URL resolved by the caller), same convention as everywhere else a
 * private Storage path is consumed in this codebase.
 */
export function printReportCardHtml(opts: ReportCardHtmlOptions): void {
  openAndPrint(buildReportCardDocument([opts]))
}

/**
 * Opens a BATCH of students' report cards as one combined document (one
 * page per student) and triggers print — the owner's explicit "one
 * combined output, not separate files" requirement, same as
 * downloadBatchReportCardPdf's contract, just via the browser instead of
 * jsPDF.
 */
export function printBatchReportCardHtml(optsList: ReportCardHtmlOptions[]): void {
  if (optsList.length === 0) return
  openAndPrint(buildReportCardDocument(optsList))
}

function openAndPrint(html: string): void {
  const blob = new Blob([html], { type: 'text/html' })
  const url = URL.createObjectURL(blob)
  window.open(url, '_blank')
  // Same 60s revoke window as printStudentIdCards.ts/printTimetable.ts.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

// ─── Document assembly ──────────────────────────────────────────────────────

function buildReportCardDocument(optsList: ReportCardHtmlOptions[]): string {
  const cards = optsList.map(opts => buildCardHtml(opts)).join('\n')

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escHtml(optsList[0]?.schoolName ?? 'School')} — Report Card${optsList.length > 1 ? 's' : ''}</title>
<style>
  @page { size: A4 portrait; margin: 12mm; }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
    margin: 0;
    padding: 0;
    color: #111827;
    background: #fff;
    font-size: 12px;
  }
  .rc-card {
    max-width: 186mm;
    margin: 0 auto;
    page-break-after: always;
    break-after: page;
  }
  .rc-card:last-child { page-break-after: auto; break-after: auto; }

  /* Header */
  .rc-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
    border-bottom: 1px solid #e2e8f0;
    padding-bottom: 8px;
    margin-bottom: 10px;
  }
  .rc-logo, .rc-photo {
    width: 22mm;
    height: 22mm;
    object-fit: contain;
    flex: 0 0 auto;
  }
  .rc-photo { object-fit: cover; border: 1px solid #cbd5e1; border-radius: 2px; }
  .rc-header-center { flex: 1; min-width: 0; text-align: center; }
  .rc-school-name { font-size: 20px; font-weight: 800; color: #111827; margin: 0 0 2px; }
  .rc-school-contact { font-size: 10px; color: #4b5563; margin: 0 0 2px; }
  .rc-report-label { font-size: 10px; font-weight: 700; color: var(--rc-brand, #2563eb); letter-spacing: 0.04em; margin: 0; }

  /* Student info block */
  .rc-student-block {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    background: #eff6ff;
    border-left: 3px solid var(--rc-brand, #2563eb);
    border-radius: 3px;
    padding: 8px 10px;
    margin-bottom: 8px;
  }
  .rc-student-name { font-size: 16px; font-weight: 800; margin: 0 0 4px; }
  .rc-student-meta { font-size: 11px; color: #374151; line-height: 1.6; margin: 0; }
  .rc-position { text-align: right; }
  .rc-position-value { font-size: 16px; font-weight: 800; color: var(--rc-brand, #2563eb); }
  .rc-position-total { font-size: 10px; color: #6b7280; }

  /* Grading key */
  .rc-grading-key {
    background: #f8fafc;
    border-radius: 3px;
    padding: 6px 10px;
    margin-bottom: 8px;
    font-size: 10px;
    color: #374151;
  }
  .rc-grading-key-label { font-weight: 700; color: #6b7280; display: block; margin-bottom: 3px; }
  .rc-grading-key-items span { margin-right: 14px; }

  /* Subjects table */
  table.rc-subjects { width: 100%; border-collapse: collapse; margin-bottom: 8px; font-size: 10.5px; }
  table.rc-subjects th {
    background: var(--rc-brand, #2563eb);
    color: var(--rc-brand-on, #fff);
    text-align: left;
    padding: 5px 6px;
    font-weight: 700;
  }
  table.rc-subjects td { padding: 4px 6px; border-bottom: 1px solid #e2e8f0; }
  table.rc-subjects tr:nth-child(even) td { background: #f8fafc; }
  .rc-no-results { color: #6b7280; margin-bottom: 8px; }

  /* Summary row */
  .rc-summary {
    display: flex;
    background: #eff6ff;
    border-left: 3px solid var(--rc-brand, #2563eb);
    border-radius: 3px;
    padding: 8px 10px;
    margin-bottom: 8px;
    gap: 12px;
  }
  .rc-summary-cell { flex: 1; min-width: 0; }
  .rc-summary-cell.rc-align-right { text-align: right; }
  .rc-summary-label { font-size: 9px; color: #6b7280; text-transform: uppercase; display: block; margin-bottom: 2px; }
  .rc-summary-value { font-size: 15px; font-weight: 800; }
  .rc-summary-grade { font-size: 12px; font-weight: 700; color: var(--rc-brand, #2563eb); margin-left: 4px; }
  .rc-overall-remark { font-weight: 700; color: var(--rc-brand, #2563eb); font-size: 11px; }

  /* Notice */
  .rc-notice {
    background: #fffbeb;
    border-radius: 3px;
    padding: 6px 10px;
    margin-bottom: 8px;
    font-size: 10.5px;
    color: #78350f;
  }
  .rc-notice-label { font-weight: 700; color: #92400e; display: block; margin-bottom: 2px; font-size: 9px; }

  /* Attendance */
  .rc-attendance {
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: #f8fafc;
    border-radius: 3px;
    padding: 6px 10px;
    margin-bottom: 8px;
    font-size: 10.5px;
  }
  .rc-attendance-label { font-weight: 700; color: #6b7280; font-size: 9px; }
  .rc-attendance-dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; }

  /* Remarks */
  .rc-remarks { display: flex; gap: 8px; margin-bottom: 8px; }
  .rc-remark-box { flex: 1; min-width: 0; background: #f8fafc; border-radius: 3px; padding: 6px 10px; }
  .rc-remark-label { font-weight: 700; color: #6b7280; font-size: 9px; display: block; margin-bottom: 4px; }
  .rc-remark-text { font-size: 10.5px; color: #374151; min-height: 24px; }
  .rc-remark-blank { color: #9ca3af; }
  .rc-signature-img { max-width: 30mm; max-height: 10mm; display: block; margin-top: 4px; }
  .rc-signature-line { border-bottom: 1px solid #9ca3af; width: 30mm; margin-top: 4px; }
  .rc-signature-name { font-size: 8px; color: #6b7280; margin-top: 1px; }

  /* Term info (resumption / fees) */
  .rc-term-info {
    text-align: center;
    background: #f8fafc;
    border-radius: 3px;
    padding: 6px 10px;
    margin-bottom: 8px;
    font-size: 10.5px;
    font-weight: 700;
  }
  .rc-term-info span { margin: 0 8px; }

  /* Signature lines */
  .rc-sign-lines { display: flex; justify-content: space-between; margin-top: 14px; font-size: 10px; color: #4b5563; }
  .rc-sign-lines > div { flex: 1; text-align: center; }
  .rc-sign-lines .rc-line { border-bottom: 1px solid #9ca3af; width: 70%; margin: 0 auto 4px; }

  .rc-footer { display: flex; justify-content: space-between; font-size: 9px; color: #9ca3af; border-top: 1px solid #e2e8f0; margin-top: 12px; padding-top: 4px; }

  @media print {
    .rc-card { page-break-after: always; }
    .rc-card:last-child { page-break-after: auto; }
  }
</style>
</head>
<body>
${cards}
<script>
  window.addEventListener('load', function () { window.print(); });
</script>
</body>
</html>`
}

function buildCardHtml(opts: ReportCardHtmlOptions): string {
  const { data } = opts
  const bands = opts.gradeBands ?? []
  const brand = '#2563eb' // resolved brand color could be threaded through like printStudentIdCards.ts does; kept as the app default for now since report cards don't yet expose a per-call brand override

  const generatedDate = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
  const period = data.termName ? `${data.sessionName} — ${data.termName}` : data.sessionName

  return `<div class="rc-card" style="--rc-brand: ${brand}; --rc-brand-on: #ffffff;">
  ${buildHeaderHtml(opts)}
  ${buildStudentBlockHtml(data, period)}
  ${buildGradingKeyHtml(bands)}
  ${buildSubjectsTableHtml(data, bands)}
  ${buildSummaryRowHtml(data, bands)}
  ${buildNoticeHtml(data)}
  ${buildAttendanceHtml(data)}
  ${buildRemarksHtml(data)}
  ${buildTermInfoHtml(data)}
  ${buildSignatureLinesHtml()}
  <div class="rc-footer"><span>Generated ${escHtml(generatedDate)}</span><span></span></div>
</div>`
}

function buildHeaderHtml(opts: ReportCardHtmlOptions): string {
  const logoImg = opts.logoUrl ? `<img class="rc-logo" src="${escHtml(opts.logoUrl)}" alt="" />` : '<span class="rc-logo"></span>'
  const photoImg = opts.data.studentPhotoUrl
    ? `<img class="rc-photo" src="${escHtml(opts.data.studentPhotoUrl)}" alt="" />`
    : '<span class="rc-photo"></span>'

  const contactParts = [opts.schoolPhone, opts.schoolEmail].filter((v): v is string => !!v)

  return `<div class="rc-header">
    ${logoImg}
    <div class="rc-header-center">
      <p class="rc-school-name">${escHtml(opts.schoolName || 'School')}</p>
      ${opts.schoolAddress ? `<p class="rc-school-contact">${escHtml(opts.schoolAddress)}</p>` : ''}
      ${contactParts.length > 0 ? `<p class="rc-school-contact">${escHtml(contactParts.join('   •   '))}</p>` : ''}
      <p class="rc-report-label">TERMINAL REPORT</p>
    </div>
    ${photoImg}
  </div>`
}

function buildStudentBlockHtml(data: ReportCardData, period: string): string {
  const positionBlock = data.overallPosition !== null && data.totalGraded > 0
    ? `<div class="rc-position">
        <span class="rc-position-value">${escHtml(ordinal(data.overallPosition))}</span>
        <span class="rc-position-total"> of ${data.totalGraded}</span>
      </div>`
    : ''

  return `<div class="rc-student-block">
    <div>
      <p class="rc-student-name">${escHtml(data.studentName || '—')}</p>
      <p class="rc-student-meta">
        Reg. No: ${escHtml(data.studentCode ?? '—')}<br />
        Class: ${escHtml(data.className || '—')}<br />
        Session: ${escHtml(period)}
      </p>
    </div>
    ${positionBlock}
  </div>`
}

function buildGradingKeyHtml(bands: GradeBandLike[]): string {
  if (bands.length === 0) return ''
  const items = bands.map(b => `<span>${escHtml(b.grade_label)} (${b.min_score}–${b.max_score})</span>`).join('')
  return `<div class="rc-grading-key">
    <span class="rc-grading-key-label">GRADING KEY</span>
    <div class="rc-grading-key-items">${items}</div>
  </div>`
}

function buildSubjectsTableHtml(data: ReportCardData, bands: GradeBandLike[]): string {
  if (data.subjects.length === 0) {
    return `<p class="rc-no-results">No approved results yet for this period.</p>`
  }

  const compHeaders = data.components.map(c => `<th>${escHtml(c.name)} (${c.max_score})</th>`).join('')
  const rows = data.subjects.map((s, i) => {
    const compCells = data.components.map(c =>
      `<td>${s.componentValues[c.id] !== undefined ? s.componentValues[c.id] : '—'}</td>`).join('')
    const remark = getGradeRemark(s.grade_label, bands) ?? '—'
    return `<tr>
      <td>${i + 1}</td>
      <td>${escHtml(s.subject_name)}</td>
      ${compCells}
      <td>${s.weighted_total.toFixed(1)}</td>
      <td><strong>${escHtml(s.grade_label ?? '—')}</strong></td>
      <td>${escHtml(remark)}</td>
      <td>${s.position_in_class ?? '—'}</td>
    </tr>`
  }).join('')

  return `<table class="rc-subjects">
    <thead><tr><th>#</th><th>Subject</th>${compHeaders}<th>Total</th><th>Grade</th><th>Remark</th><th>Pos</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`
}

function buildSummaryRowHtml(data: ReportCardData, bands: GradeBandLike[]): string {
  const avgGrade = data.average !== null ? getAvgGradeLabel(data.average, bands) : null

  return `<div class="rc-summary">
    <div class="rc-summary-cell">
      <span class="rc-summary-label">Average</span>
      <span class="rc-summary-value">${data.average !== null ? data.average.toFixed(1) : '—'}</span>
      ${avgGrade ? `<span class="rc-summary-grade">(${escHtml(avgGrade)})</span>` : ''}
    </div>
    <div class="rc-summary-cell">
      <span class="rc-summary-label">Class Position</span>
      <span class="rc-summary-value" style="font-size: 13px;">${
        data.overallPosition !== null && data.totalGraded > 0
          ? `${escHtml(ordinal(data.overallPosition))} of ${data.totalGraded}`
          : '—'
      }</span>
    </div>
    ${data.aggregateRemark ? `<div class="rc-summary-cell rc-align-right">
      <span class="rc-summary-label">Overall</span>
      <span class="rc-overall-remark">${escHtml(data.aggregateRemark)}</span>
    </div>` : ''}
  </div>`
}

function buildNoticeHtml(data: ReportCardData): string {
  const notice = data.settings?.notice?.trim()
  if (!notice) return ''
  return `<div class="rc-notice">
    <span class="rc-notice-label">NOTICE</span>
    ${escHtml(notice)}
  </div>`
}

function buildAttendanceHtml(data: ReportCardData): string {
  const att = data.attendance
  if (!att || att.totalMarked === 0) return ''
  const absent = att.totalMarked - att.present
  const pct = Math.round((att.present / att.totalMarked) * 100)
  const dotColor = pct >= 90 ? '#16a34a' : pct >= 75 ? '#d97706' : '#dc2626'

  return `<div class="rc-attendance">
    <span class="rc-attendance-label">ATTENDANCE SUMMARY</span>
    <span>Days Present: ${att.present}  |  Days Absent: ${absent}  |  Attendance Rate: ${pct}%</span>
    <span class="rc-attendance-dot" style="background: ${dotColor};"></span>
  </div>`
}

function buildRemarksHtml(data: ReportCardData): string {
  const teacherRemark = data.teacherRemark?.trim()
  const principalRemark = data.principalRemark?.trim()
  const teacherSigBlock = data.formMaster?.signatureUrl
    ? `<img class="rc-signature-img" src="${escHtml(data.formMaster.signatureUrl)}" alt="" />`
    : `<div class="rc-signature-line"></div>`

  return `<div class="rc-remarks">
    <div class="rc-remark-box">
      <span class="rc-remark-label">CLASS TEACHER'S REMARK</span>
      <div class="rc-remark-text">${teacherRemark ? escHtml(teacherRemark) : '<span class="rc-remark-blank">—</span>'}</div>
      ${teacherSigBlock}
      ${data.formMaster?.staffName ? `<div class="rc-signature-name">${escHtml(data.formMaster.staffName)}</div>` : ''}
    </div>
    <div class="rc-remark-box">
      <span class="rc-remark-label">PRINCIPAL'S REMARK</span>
      <div class="rc-remark-text">${principalRemark ? escHtml(principalRemark) : '<span class="rc-remark-blank">—</span>'}</div>
      <div class="rc-signature-line"></div>
    </div>
  </div>`
}

function buildTermInfoHtml(data: ReportCardData): string {
  const resumptionDate = data.settings?.resumptionDate
  const nextTermFees = data.settings?.nextTermFees
  if (!resumptionDate && nextTermFees == null) return ''

  const parts: string[] = []
  if (resumptionDate) {
    const d = new Date(resumptionDate)
    const formatted = Number.isNaN(d.getTime())
      ? resumptionDate
      : d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
    parts.push(`Next Resumption: ${formatted}`)
  }
  if (nextTermFees != null) parts.push(`Next Term Fees: ₦${nextTermFees.toLocaleString()}`)

  return `<div class="rc-term-info">${parts.map(escHtml).join('<span>|</span>')}</div>`
}

function buildSignatureLinesHtml(): string {
  return `<div class="rc-sign-lines">
    <div><div class="rc-line"></div>Class Teacher</div>
    <div><div class="rc-line"></div>Head Teacher / Principal</div>
    <div><div class="rc-line"></div>Date</div>
  </div>`
}

// ─── Internal helpers ───────────────────────────────────────────────────────

function escHtml(str: string): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
