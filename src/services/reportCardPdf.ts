/**
 * reportCardPdf.ts
 * PRD Tier 8 / Problem 8.4 — PDF report card for secondary schools.
 *
 * Layout (Session 67 redesign — Nigerian/Ghanaian terminal-report standard):
 *   1. School header band: logo, name, address, "TERMINAL REPORT"
 *   2. Student info block: name (dominant), position (dominant), reg/class/session,
 *      attendance, days open, next resumption
 *   3. Grading key: dynamic from grade_scales, never hardcoded
 *   4. Per-subject table: dynamic component columns, total, grade, remark, position
 *   5. Totals / summary row: total marks, average, class position
 *   6. Teacher's remark + Principal's remark (side by side)
 *   7. Attendance summary: days open, present, absent, late, rate
 *   8. Signature lines + page footer
 *
 * Design principles:
 *   - Single A4 page per student, overflow to page 2 only when subject count requires
 *   - School branding via theme_color (brand-600 / brand-on) — works in B&W
 *   - Grade-band subtle tinting on table rows — print-safe
 *   - Three-type hierarchy: headline (student name / position), section labels, body
 *
 * Font (Session 80, owner-reported bug — garbled/mojibake text on any field
 * containing non-Latin characters, e.g. an Arabic school name): jsPDF's
 * built-in fonts (helvetica/times/courier) only cover the WinAnsi character
 * set. Every text draw in this file now goes through the local `text()`
 * wrapper (not doc.text() directly), which (a) runs the string through
 * toVisualPdfText() — reshapes+bidi-reorders Arabic so it draws correctly
 * left-to-right — and (b) uses the custom 'ReportCard' font family
 * (registerReportCardFont(), reportCardFont.ts) that actually has the Arabic
 * + Latin + Naira (₦) glyphs to draw. setFont() calls below pass 'ReportCard'
 * instead of 'helvetica' for the same reason. See pdfTextShaping.ts and
 * scripts/build-pdf-font.cjs for the full root-cause writeup.
 */

import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import type { ReportCardData } from './assessmentService'
import { toVisualPdfText } from './pdfTextShaping'
import { REPORT_CARD_FONT_REGULAR_BASE64, REPORT_CARD_FONT_BOLD_BASE64 } from '../assets/fonts/reportCardFont'

// ─── Font registration ──────────────────────────────────────────────────────
// jsPDF fonts are registered per-document (addFileToVFS/addFont live on the
// jsPDF instance), so this runs once per generated PDF, not once globally.

const FONT_FAMILY = 'ReportCard'

function registerReportCardFont(doc: jsPDF): void {
  doc.addFileToVFS('ReportCard-Regular.ttf', REPORT_CARD_FONT_REGULAR_BASE64)
  doc.addFont('ReportCard-Regular.ttf', FONT_FAMILY, 'normal')
  doc.addFileToVFS('ReportCard-Bold.ttf', REPORT_CARD_FONT_BOLD_BASE64)
  doc.addFont('ReportCard-Bold.ttf', FONT_FAMILY, 'bold')
  // No real italic weight is embedded — jsPDF falls back to synthetic
  // slant-on-regular for 'italic' automatically when only normal/bold are
  // registered, which is fine for the one italic use below (aggregate
  // remark) and not worth doubling font payload size for.
  doc.setFont(FONT_FAMILY, 'normal')
}

/**
 * Draws text via jsPDF's doc.text(), but always through toVisualPdfText()
 * first. Use this instead of doc.text() everywhere in this file — the one
 * time a raw doc.text() call slips back in, any Arabic text handed to it
 * will silently mis-shape/mis-order again.
 */
function text(doc: jsPDF, str: string, x: number, y: number, options?: Parameters<jsPDF['text']>[3]): void {
  doc.text(toVisualPdfText(str), x, y, options)
}

// ─── Brand color resolution ─────────────────────────────────────────────────

interface ResolvedBrandColors {
  brand600: [number, number, number]
  brand50: [number, number, number]
  brandOn: [number, number, number]
}

const FALLBACK_600: [number, number, number] = [37, 99, 235]
const FALLBACK_50: [number, number, number] = [239, 246, 255]
const FALLBACK_ON: [number, number, number] = [255, 255, 255]

function resolveBrandColors(): ResolvedBrandColors {
  const styles = getComputedStyle(document.documentElement)
  return {
    brand600: parseColor(styles.getPropertyValue('--color-brand-600').trim()) ?? FALLBACK_600,
    brand50: parseColor(styles.getPropertyValue('--color-brand-50').trim()) ?? FALLBACK_50,
    brandOn: parseColor(styles.getPropertyValue('--color-brand-on').trim()) ?? FALLBACK_ON,
  }
}

function parseColor(value: string): [number, number, number] | null {
  if (!value) return null
  const hex = value.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/)
  if (hex) {
    let h = hex[1]
    if (h.length === 3) h = h.split('').map(c => c + c).join('')
    const n = parseInt(h, 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  const rgb = value.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  return null
}

// ─── Grade tint colors (print-safe: very light, reads as gray in B&W) ──────

const GRADE_TINTS: Record<string, [number, number, number]> = {
  'A': [220, 252, 231],  // green-50
  'B': [219, 234, 254],  // blue-50
  'C': [254, 249, 195],  // yellow-50
  'D': [255, 237, 213],  // orange-50
  'F': [254, 226, 226],  // red-50
}

function getGradeTint(gradeLabel: string | null): [number, number, number] | null {
  if (!gradeLabel) return null
  const key = gradeLabel.charAt(0).toUpperCase()
  return GRADE_TINTS[key] ?? null
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ReportCardPdfOptions {
  schoolName: string
  schoolAddress?: string
  logoUrl?: string | null
  gradeBands?: { min_score: number; max_score: number; grade_label: string; remark: string | null }[]
  data: ReportCardData
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function downloadReportCardPdf(opts: ReportCardPdfOptions): void {
  const doc = buildReportCardPdf(opts, resolveBrandColors())
  const safeName = (opts.data.studentName || 'student').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '')
  const period = opts.data.termName ?? opts.data.sessionName
  doc.save(`${safeName || 'report'}-report-card${period ? `-${period.replace(/[^a-z0-9]+/gi, '-')}` : ''}.pdf`.toLowerCase())
}

// ─── Document assembly ──────────────────────────────────────────────────────

const MARGIN = 14 // mm
const PAGE_W = 210 // A4 width mm
const PAGE_H = 297 // A4 height mm
const CONTENT_W = PAGE_W - MARGIN * 2

function buildReportCardPdf(opts: ReportCardPdfOptions, colors: ResolvedBrandColors): jsPDF {
  const { data } = opts
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  registerReportCardFont(doc)

  let y = drawHeader(doc, opts, colors)
  y = drawStudentBlock(doc, y, data, colors)
  y = drawGradingKey(doc, y, opts.gradeBands ?? [], colors)
  y = drawSubjectsTable(doc, y, data, opts.gradeBands ?? [], colors)
  y = drawSummaryRow(doc, y, data, opts.gradeBands ?? [], colors)
  y = drawRemarks(doc, y, data)
  y = drawAttendanceSummary(doc, y, data)
  drawSignatures(doc, y)
  drawPageFooter(doc)

  return doc
}

// ─── 1. School header band ──────────────────────────────────────────────────

function drawHeader(doc: jsPDF, opts: ReportCardPdfOptions, colors: ResolvedBrandColors): number {
  // Brand bar
  doc.setFillColor(...colors.brand600)
  doc.rect(0, 0, PAGE_W, 20, 'F')

  // School name — centered, dominant
  doc.setTextColor(...colors.brandOn)
  doc.setFont(FONT_FAMILY, 'bold')
  doc.setFontSize(16)
  text(doc, opts.schoolName || 'School', PAGE_W / 2, 9, { align: 'center' })

  // Address / contact — centered, smaller
  if (opts.schoolAddress) {
    doc.setFont(FONT_FAMILY, 'normal')
    doc.setFontSize(7.5)
    text(doc, opts.schoolAddress, PAGE_W / 2, 14, { align: 'center' })
  }

  // "TERMINAL REPORT" — right-aligned in the bar
  doc.setFont(FONT_FAMILY, 'bold')
  doc.setFontSize(9)
  text(doc, 'TERMINAL REPORT', PAGE_W - MARGIN, 18, { align: 'right' })

  doc.setTextColor(17, 24, 39)
  return 26
}

// ─── 2. Student info block ──────────────────────────────────────────────────

function drawStudentBlock(doc: jsPDF, y: number, data: ReportCardData, colors: ResolvedBrandColors): number {
  const blockH = 26

  // Background tint
  doc.setFillColor(...colors.brand50)
  doc.roundedRect(MARGIN, y, CONTENT_W, blockH, 1.5, 1.5, 'F')

  // Left accent bar
  doc.setFillColor(...colors.brand600)
  doc.rect(MARGIN, y, 2, blockH, 'F')

  const lx = MARGIN + 5
  const rx = PAGE_W - MARGIN - 4
  let ly = y + 5

  // Student name — headline
  doc.setFont(FONT_FAMILY, 'bold')
  doc.setFontSize(13)
  doc.setTextColor(17, 24, 39)
  text(doc, data.studentName || '—', lx, ly)

  // Position — headline (right side)
  if (data.overallPosition !== null && data.totalGraded > 0) {
    doc.setFont(FONT_FAMILY, 'bold')
    doc.setFontSize(13)
    doc.setTextColor(...colors.brand600)
    const posLabel = ordinal(data.overallPosition)
    // Measure while the bold/13pt font is still the active font — getTextWidth
    // reads whatever font/size is currently set, so measuring after switching
    // to the "of N" font/size below would use the wrong metrics and produce
    // too small an offset, causing the two strings to overlap.
    const posLabelWidth = doc.getTextWidth(posLabel)
    text(doc, posLabel, rx, ly, { align: 'right' })
    doc.setFont(FONT_FAMILY, 'normal')
    doc.setFontSize(9)
    doc.setTextColor(75, 85, 99)
    text(doc, `of ${data.totalGraded}`, rx - posLabelWidth - 1.5, ly, { align: 'right' })
  }

  ly += 6
  doc.setFont(FONT_FAMILY, 'normal')
  doc.setFontSize(9)
  doc.setTextColor(55, 65, 81)

  // Left column: reg no, class, session/term
  const period = data.termName ? `${data.sessionName} — ${data.termName}` : data.sessionName
  text(doc, `Reg. No: ${data.studentCode ?? '—'}`, lx, ly)
  text(doc, `Class: ${data.className || '—'}`, lx, ly + 5)
  text(doc, `Session: ${period}`, lx, ly + 10)

  // Right column: attendance, days open, resumption
  const att = data.attendance
  if (att && att.totalMarked > 0) {
    const pct = Math.round((att.present / att.totalMarked) * 100)
    text(doc, `Attendance: ${att.present}/${att.totalMarked} days (${pct}%)`, rx, ly, { align: 'right' })
  } else {
    text(doc, 'Attendance: —', rx, ly, { align: 'right' })
  }

  doc.setTextColor(17, 24, 39)
  return y + blockH + 4
}

// ─── 3. Grading key ────────────────────────────────────────────────────────

function drawGradingKey(
  doc: jsPDF,
  y: number,
  bands: { min_score: number; max_score: number; grade_label: string; remark: string | null }[],
  _colors: ResolvedBrandColors,
): number {
  if (bands.length === 0) return y

  const boxH = bands.length <= 5 ? 10 : 16

  doc.setFillColor(248, 250, 252) // very light gray
  doc.roundedRect(MARGIN, y, CONTENT_W, boxH, 1.5, 1.5, 'F')

  doc.setFont(FONT_FAMILY, 'bold')
  doc.setFontSize(7.5)
  doc.setTextColor(107, 114, 128)
  text(doc, 'GRADING KEY', MARGIN + 3, y + 4)

  doc.setFont(FONT_FAMILY, 'normal')
  doc.setFontSize(7.5)
  doc.setTextColor(55, 65, 81)

  // Lay out bands in a single row, wrapping if needed
  const items = bands.map(b => `${b.grade_label} (${b.min_score}–${b.max_score})`)
  const itemWidth = items.map(i => doc.getTextWidth(i)).reduce((a, b) => Math.max(a, b), 0) + 8
  const cols = Math.max(1, Math.floor(CONTENT_W / itemWidth))

  for (let i = 0; i < items.length; i++) {
    const col = i % cols
    const row = Math.floor(i / cols)
    const ix = MARGIN + 3 + col * (CONTENT_W / cols)
    const iy = y + 8 + row * 4.5
    text(doc, items[i], ix, iy)
  }

  doc.setTextColor(17, 24, 39)
  return y + boxH + 3
}

// ─── 4. Per-subject table ───────────────────────────────────────────────────

function drawSubjectsTable(
  doc: jsPDF,
  y: number,
  data: ReportCardData,
  bands: { min_score: number; max_score: number; grade_label: string; remark: string | null }[],
  colors: ResolvedBrandColors,
): number {
  if (data.subjects.length === 0) {
    doc.setFont(FONT_FAMILY, 'normal')
    doc.setFontSize(10)
    doc.setTextColor(107, 114, 128)
    text(doc, 'No approved results yet for this period.', MARGIN, y + 4)
    doc.setTextColor(17, 24, 39)
    return y + 12
  }

  // Dynamic component columns: "CA 1 (20)" format. Header/body strings are
  // pre-shaped via toVisualPdfText() here (rather than inside autoTable's own
  // cell-drawing pass, which calls doc.text() directly and never goes through
  // this file's text() wrapper) — subject names and grade remarks are
  // free-text fields that could in principle contain Arabic, same as the
  // school name that originally surfaced this bug.
  const compHeaders = data.components.map(c => `${c.name} (${c.max_score})`)
  const head = [['#', 'Subject', ...compHeaders, 'Total', 'Grade', 'Remark', 'Pos'].map(toVisualPdfText)]

  const body = data.subjects.map((s, i) => [
    String(i + 1),
    toVisualPdfText(s.subject_name),
    ...data.components.map(c =>
      s.componentValues[c.id] !== undefined ? String(s.componentValues[c.id]) : '—'),
    s.weighted_total.toFixed(1),
    s.grade_label ?? '—',
    toVisualPdfText(getGradeRemark(s.grade_label, bands) ?? '—'),
    s.position_in_class ? String(s.position_in_class) : '—',
  ])

  autoTable(doc, {
    startY: y,
    margin: { left: MARGIN, right: MARGIN },
    head,
    body,
    styles: {
      font: FONT_FAMILY,
      fontSize: 8,
      cellPadding: 1.5,
      textColor: [17, 24, 39],
      lineColor: [226, 232, 240],
      lineWidth: 0.15,
    },
    headStyles: {
      font: FONT_FAMILY,
      fillColor: colors.brand600,
      textColor: colors.brandOn,
      fontStyle: 'bold',
      fontSize: 7.5,
      cellPadding: 2,
    },
    alternateRowStyles: { fillColor: colors.brand50 },
    columnStyles: {
      0: { cellWidth: 7, halign: 'center' },
      1: { cellWidth: 36 },
      // Component columns: auto
      // Total column: bold, right-aligned
      [3 + data.components.length]: { fontStyle: 'bold', halign: 'right' },
      // Grade column: centered
      [4 + data.components.length]: { halign: 'center' },
      // Remark column
      [5 + data.components.length]: { fontSize: 7, textColor: [107, 114, 128] },
      // Pos column: centered, narrow
      [6 + data.components.length]: { cellWidth: 10, halign: 'center' },
    },
    didParseCell: (hookData) => {
      // Apply grade tint to the Grade column cells (not header)
      if (hookData.section === 'body' && hookData.column.index === 4 + data.components.length) {
        const tint = getGradeTint(hookData.cell.raw as string)
        if (tint) hookData.cell.styles.fillColor = tint
      }
    },
  })

  const tableEnd = (doc as any).lastAutoTable.finalY
  return tableEnd + 6
}

function getGradeRemark(gradeLabel: string | null, bands: { grade_label: string; remark: string | null }[]): string | null {
  if (!gradeLabel) return null
  const band = bands.find(b => b.grade_label === gradeLabel)
  return band?.remark ?? null
}

// ─── 5. Totals / summary row ────────────────────────────────────────────────

function drawSummaryRow(
  doc: jsPDF,
  y: number,
  data: ReportCardData,
  bands: { min_score: number; max_score: number; grade_label: string; remark: string | null }[],
  colors: ResolvedBrandColors,
): number {
  const boxH = 14

  // Check page space
  if (y + boxH > PAGE_H - MARGIN - 30) {
    doc.addPage()
    y = MARGIN
  }

  doc.setFillColor(...colors.brand50)
  doc.roundedRect(MARGIN, y, CONTENT_W, boxH, 1.5, 1.5, 'F')

  // Left accent
  doc.setFillColor(...colors.brand600)
  doc.rect(MARGIN, y, 2, boxH, 'F')

  const lx = MARGIN + 6
  const cx = PAGE_W / 2
  const rx = PAGE_W - MARGIN - 4
  const ty = y + 6

  // Average
  doc.setFont(FONT_FAMILY, 'normal')
  doc.setFontSize(7.5)
  doc.setTextColor(107, 114, 128)
  text(doc, 'AVERAGE', lx, ty - 2)

  doc.setFont(FONT_FAMILY, 'bold')
  doc.setFontSize(14)
  doc.setTextColor(17, 24, 39)
  text(doc, data.average !== null ? data.average.toFixed(1) : '—', lx, ty + 4)

  // Grade label next to average
  if (data.average !== null) {
    const avgGrade = getAvgGradeLabel(data.average, bands)
    if (avgGrade) {
      doc.setFont(FONT_FAMILY, 'bold')
      doc.setFontSize(10)
      doc.setTextColor(...colors.brand600)
      text(doc, `(${avgGrade})`, lx + 20, ty + 4)
    }
  }

  // Position
  doc.setFont(FONT_FAMILY, 'normal')
  doc.setFontSize(7.5)
  doc.setTextColor(107, 114, 128)
  text(doc, 'CLASS POSITION', cx, ty - 2)

  doc.setFont(FONT_FAMILY, 'bold')
  doc.setFontSize(12)
  doc.setTextColor(17, 24, 39)
  if (data.overallPosition !== null && data.totalGraded > 0) {
    text(doc, `${ordinal(data.overallPosition)} of ${data.totalGraded}`, cx, ty + 4)
  } else {
    text(doc, '—', cx, ty + 4)
  }

  // Aggregate remark
  if (data.aggregateRemark) {
    doc.setFont(FONT_FAMILY, 'normal')
    doc.setFontSize(7.5)
    doc.setTextColor(107, 114, 128)
    text(doc, 'OVERALL', rx, ty - 2, { align: 'right' })

    // Emphasis via color + size only, not font style: no italic weight is
    // embedded in the custom font (see registerReportCardFont), and jsPDF
    // does NOT synthesize a slant when an unregistered style is requested —
    // it silently falls back to a built-in standard font instead (confirmed
    // by testing: requesting 'italic' here with only 'normal'/'bold'
    // registered swapped to Times-Italic, which has no Arabic glyphs and
    // would have reintroduced this exact bug for this one field). Brand-
    // colored + slightly larger reads as "distinct/emphasized" without
    // that risk.
    doc.setFont(FONT_FAMILY, 'bold')
    doc.setFontSize(9)
    doc.setTextColor(...colors.brand600)
    text(doc, data.aggregateRemark, rx, ty + 4, { align: 'right', maxWidth: 55 })
  }

  doc.setTextColor(17, 24, 39)
  return y + boxH + 5
}

function getAvgGradeLabel(avg: number, bands: { min_score: number; max_score: number; grade_label: string }[]): string | null {
  const band = bands.find(b => avg >= b.min_score && avg <= b.max_score)
  return band?.grade_label ?? null
}

// ─── 6. Teacher + Principal remarks ─────────────────────────────────────────

function drawRemarks(doc: jsPDF, y: number, data: ReportCardData): number {
  const boxH = 22
  if (y + boxH > PAGE_H - MARGIN - 20) {
    doc.addPage()
    y = MARGIN
  }

  const halfW = (CONTENT_W - 4) / 2

  // Class teacher's remark (left)
  doc.setFillColor(248, 250, 252)
  doc.roundedRect(MARGIN, y, halfW, boxH, 1.5, 1.5, 'F')

  doc.setFont(FONT_FAMILY, 'bold')
  doc.setFontSize(7.5)
  doc.setTextColor(107, 114, 128)
  text(doc, "CLASS TEACHER'S REMARK", MARGIN + 3, y + 4)

  doc.setFont(FONT_FAMILY, 'normal')
  doc.setFontSize(9)
  doc.setTextColor(55, 65, 81)
  const remark = data.teacherRemark?.trim()
  if (remark) {
    text(doc, remark, MARGIN + 3, y + 10, { maxWidth: halfW - 6, lineHeightFactor: 1.3 })
  } else {
    doc.setTextColor(180, 180, 180)
    text(doc, '________________________________', MARGIN + 3, y + 10)
  }

  // Principal's remark (right)
  const rx = MARGIN + halfW + 4
  doc.setFillColor(248, 250, 252)
  doc.roundedRect(rx, y, halfW, boxH, 1.5, 1.5, 'F')

  doc.setFont(FONT_FAMILY, 'bold')
  doc.setFontSize(7.5)
  doc.setTextColor(107, 114, 128)
  text(doc, "PRINCIPAL'S REMARK", rx + 3, y + 4)

  doc.setFont(FONT_FAMILY, 'normal')
  doc.setFontSize(9)
  doc.setTextColor(180, 180, 180)
  text(doc, '________________________________', rx + 3, y + 10)

  doc.setTextColor(17, 24, 39)
  return y + boxH + 4
}

// ─── 7. Attendance summary ──────────────────────────────────────────────────

function drawAttendanceSummary(doc: jsPDF, y: number, data: ReportCardData): number {
  const att = data.attendance
  if (!att || att.totalMarked === 0) return y

  const boxH = 12
  if (y + boxH > PAGE_H - MARGIN - 15) {
    doc.addPage()
    y = MARGIN
  }

  doc.setFillColor(248, 250, 252)
  doc.roundedRect(MARGIN, y, CONTENT_W, boxH, 1.5, 1.5, 'F')

  doc.setFont(FONT_FAMILY, 'bold')
  doc.setFontSize(7.5)
  doc.setTextColor(107, 114, 128)
  text(doc, 'ATTENDANCE SUMMARY', MARGIN + 3, y + 4)

  const absent = att.totalMarked - att.present
  const pct = Math.round((att.present / att.totalMarked) * 100)
  const summary = `Days Present: ${att.present}  |  Days Absent: ${absent}  |  Attendance Rate: ${pct}%`

  doc.setFont(FONT_FAMILY, 'normal')
  doc.setFontSize(8.5)
  doc.setTextColor(55, 65, 81)
  text(doc, summary, PAGE_W / 2, y + 9, { align: 'center' })

  // Color indicator for attendance rate
  const indicatorColor: [number, number, number] =
    pct >= 90 ? [22, 163, 74] : pct >= 75 ? [217, 119, 6] : [220, 38, 38]
  doc.setFillColor(...indicatorColor)
  doc.circle(PAGE_W - MARGIN - 4, y + 8, 1.5, 'F')

  doc.setTextColor(17, 24, 39)
  return y + boxH + 3
}

// ─── 8. Signatures ──────────────────────────────────────────────────────────

function drawSignatures(doc: jsPDF, y: number): void {
  const boxH = 16
  if (y + boxH > PAGE_H - MARGIN - 10) {
    doc.addPage()
    y = MARGIN
  }

  const thirdW = CONTENT_W / 3
  doc.setFont(FONT_FAMILY, 'normal')
  doc.setFontSize(8)
  doc.setTextColor(75, 85, 99)

  // Class teacher
  text(doc, '________________________', MARGIN, y + 6)
  text(doc, 'Class Teacher', MARGIN, y + 10)

  // Head teacher / Principal
  text(doc, '________________________', MARGIN + thirdW, y + 6)
  text(doc, 'Head Teacher / Principal', MARGIN + thirdW, y + 10)

  // Date
  text(doc, '________________________', MARGIN + thirdW * 2, y + 6)
  text(doc, 'Date', MARGIN + thirdW * 2, y + 10)

  doc.setTextColor(17, 24, 39)
}

// ─── Page footer ────────────────────────────────────────────────────────────

function drawPageFooter(doc: jsPDF): void {
  const pageCount = doc.getNumberOfPages()
  const generated = `Generated ${new Date().toLocaleDateString(undefined, {
    year: 'numeric', month: 'long', day: 'numeric',
  })}`

  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i)
    const ph = doc.internal.pageSize.getHeight()

    doc.setFont(FONT_FAMILY, 'normal')
    doc.setFontSize(7)
    doc.setTextColor(156, 163, 175)

    // Thin separator line
    doc.setDrawColor(226, 232, 240)
    doc.setLineWidth(0.2)
    doc.line(MARGIN, ph - 12, PAGE_W - MARGIN, ph - 12)

    text(doc, generated, MARGIN, ph - 8)
    text(doc, `Page ${i} of ${pageCount}`, PAGE_W - MARGIN, ph - 8, { align: 'right' })
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}
