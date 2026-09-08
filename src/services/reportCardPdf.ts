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
 */

import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import type { ReportCardData } from './assessmentService'

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
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(16)
  doc.text(opts.schoolName || 'School', PAGE_W / 2, 9, { align: 'center' })

  // Address / contact — centered, smaller
  if (opts.schoolAddress) {
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7.5)
    doc.text(opts.schoolAddress, PAGE_W / 2, 14, { align: 'center' })
  }

  // "TERMINAL REPORT" — right-aligned in the bar
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9)
  doc.text('TERMINAL REPORT', PAGE_W - MARGIN, 18, { align: 'right' })

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
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(13)
  doc.setTextColor(17, 24, 39)
  doc.text(data.studentName || '—', lx, ly)

  // Position — headline (right side)
  if (data.overallPosition !== null && data.totalGraded > 0) {
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(13)
    doc.setTextColor(...colors.brand600)
    const posLabel = ordinal(data.overallPosition)
    doc.text(`${posLabel}`, rx, ly, { align: 'right' })
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(9)
    doc.setTextColor(75, 85, 99)
    doc.text(`of ${data.totalGraded}`, rx - doc.getTextWidth(posLabel) - 1.5, ly, { align: 'right' })
  }

  ly += 6
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(55, 65, 81)

  // Left column: reg no, class, session/term
  const period = data.termName ? `${data.sessionName} — ${data.termName}` : data.sessionName
  doc.text(`Reg. No: ${data.studentCode ?? '—'}`, lx, ly)
  doc.text(`Class: ${data.className || '—'}`, lx, ly + 5)
  doc.text(`Session: ${period}`, lx, ly + 10)

  // Right column: attendance, days open, resumption
  const att = data.attendance
  if (att && att.totalMarked > 0) {
    const pct = Math.round((att.present / att.totalMarked) * 100)
    doc.text(`Attendance: ${att.present}/${att.totalMarked} days (${pct}%)`, rx, ly, { align: 'right' })
  } else {
    doc.text('Attendance: —', rx, ly, { align: 'right' })
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

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(7.5)
  doc.setTextColor(107, 114, 128)
  doc.text('GRADING KEY', MARGIN + 3, y + 4)

  doc.setFont('helvetica', 'normal')
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
    doc.text(items[i], ix, iy)
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
    doc.setFont('helvetica', 'italic')
    doc.setFontSize(10)
    doc.setTextColor(107, 114, 128)
    doc.text('No approved results yet for this period.', MARGIN, y + 4)
    doc.setTextColor(17, 24, 39)
    return y + 12
  }

  // Dynamic component columns: "CA 1 (20)" format
  const compHeaders = data.components.map(c => `${c.name} (${c.max_score})`)
  const head = [['#', 'Subject', ...compHeaders, 'Total', 'Grade', 'Remark', 'Pos']]

  const body = data.subjects.map((s, i) => [
    String(i + 1),
    s.subject_name,
    ...data.components.map(c =>
      s.componentValues[c.id] !== undefined ? String(s.componentValues[c.id]) : '—'),
    s.weighted_total.toFixed(1),
    s.grade_label ?? '—',
    getGradeRemark(s.grade_label, bands) ?? '—',
    s.position_in_class ? String(s.position_in_class) : '—',
  ])

  autoTable(doc, {
    startY: y,
    margin: { left: MARGIN, right: MARGIN },
    head,
    body,
    styles: {
      fontSize: 8,
      cellPadding: 1.5,
      textColor: [17, 24, 39],
      lineColor: [226, 232, 240],
      lineWidth: 0.15,
    },
    headStyles: {
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
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7.5)
  doc.setTextColor(107, 114, 128)
  doc.text('AVERAGE', lx, ty - 2)

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(14)
  doc.setTextColor(17, 24, 39)
  doc.text(data.average !== null ? data.average.toFixed(1) : '—', lx, ty + 4)

  // Grade label next to average
  if (data.average !== null) {
    const avgGrade = getAvgGradeLabel(data.average, bands)
    if (avgGrade) {
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(10)
      doc.setTextColor(...colors.brand600)
      doc.text(`(${avgGrade})`, lx + 20, ty + 4)
    }
  }

  // Position
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7.5)
  doc.setTextColor(107, 114, 128)
  doc.text('CLASS POSITION', cx, ty - 2)

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(12)
  doc.setTextColor(17, 24, 39)
  if (data.overallPosition !== null && data.totalGraded > 0) {
    doc.text(`${ordinal(data.overallPosition)} of ${data.totalGraded}`, cx, ty + 4)
  } else {
    doc.text('—', cx, ty + 4)
  }

  // Aggregate remark
  if (data.aggregateRemark) {
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7.5)
    doc.setTextColor(107, 114, 128)
    doc.text('OVERALL', rx, ty - 2, { align: 'right' })

    doc.setFont('helvetica', 'italic')
    doc.setFontSize(9)
    doc.setTextColor(55, 65, 81)
    doc.text(data.aggregateRemark, rx, ty + 4, { align: 'right', maxWidth: 55 })
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

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(7.5)
  doc.setTextColor(107, 114, 128)
  doc.text("CLASS TEACHER'S REMARK", MARGIN + 3, y + 4)

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(55, 65, 81)
  const remark = data.teacherRemark?.trim()
  if (remark) {
    doc.text(remark, MARGIN + 3, y + 10, { maxWidth: halfW - 6, lineHeightFactor: 1.3 })
  } else {
    doc.setTextColor(180, 180, 180)
    doc.text('________________________________', MARGIN + 3, y + 10)
  }

  // Principal's remark (right)
  const rx = MARGIN + halfW + 4
  doc.setFillColor(248, 250, 252)
  doc.roundedRect(rx, y, halfW, boxH, 1.5, 1.5, 'F')

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(7.5)
  doc.setTextColor(107, 114, 128)
  doc.text("PRINCIPAL'S REMARK", rx + 3, y + 4)

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(180, 180, 180)
  doc.text('________________________________', rx + 3, y + 10)

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

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(7.5)
  doc.setTextColor(107, 114, 128)
  doc.text('ATTENDANCE SUMMARY', MARGIN + 3, y + 4)

  const absent = att.totalMarked - att.present
  const pct = Math.round((att.present / att.totalMarked) * 100)
  const summary = `Days Present: ${att.present}  |  Days Absent: ${absent}  |  Attendance Rate: ${pct}%`

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8.5)
  doc.setTextColor(55, 65, 81)
  doc.text(summary, PAGE_W / 2, y + 9, { align: 'center' })

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
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  doc.setTextColor(75, 85, 99)

  // Class teacher
  doc.text('________________________', MARGIN, y + 6)
  doc.text('Class Teacher', MARGIN, y + 10)

  // Head teacher / Principal
  doc.text('________________________', MARGIN + thirdW, y + 6)
  doc.text('Head Teacher / Principal', MARGIN + thirdW, y + 10)

  // Date
  doc.text('________________________', MARGIN + thirdW * 2, y + 6)
  doc.text('Date', MARGIN + thirdW * 2, y + 10)

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

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7)
    doc.setTextColor(156, 163, 175)

    // Thin separator line
    doc.setDrawColor(226, 232, 240)
    doc.setLineWidth(0.2)
    doc.line(MARGIN, ph - 12, PAGE_W - MARGIN, ph - 12)

    doc.text(generated, MARGIN, ph - 8)
    doc.text(`Page ${i} of ${pageCount}`, PAGE_W - MARGIN, ph - 8, { align: 'right' })
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}
