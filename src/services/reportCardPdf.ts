/**
 * reportCardPdf.ts
 * PRD Tier 8 / Problem 8.4 (Session 49) — real-download PDF report card for
 * secondary schools. Same jsPDF + jspdf-autotable precedent as
 * transcriptPdf.ts (owner instruction: a report card is a "keep as proof"
 * document — a real file, not a print-dialog detour).
 *
 * Layout (grounded in standard Nigerian terminal-report conventions):
 *   brand band → school name → "TERMINAL REPORT" title
 *   student info block (name, admission no, class, session/term,
 *                       position, attendance)
 *   subjects table: # | Subject | one column per component ("1st CA (20)")
 *                   | Total | Grade | Subject position
 *   summary box: overall average + aggregate remark band
 *   class teacher's remark paragraph
 *   signature lines (Class Teacher / Principal) + generated-at footer
 *
 * Every number comes straight off ReportCardData (assessmentService.
 * loadReportCardData()) — nothing is recomputed here. React Native port
 * note matches transcriptPdf.ts's own: only doc.save() and
 * resolveBrandColors() are DOM-bound; the assembly is portable.
 */

import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import type { ReportCardData } from './assessmentService'

// ─── Brand color resolution (same approach as transcriptPdf.ts) ──────────────

interface ResolvedBrandColors {
  brand600: [number, number, number]
  brandOn: [number, number, number]
}

const FALLBACK_BRAND_600: [number, number, number] = [37, 99, 235] // #2563eb

function resolveBrandColors(): ResolvedBrandColors {
  const styles = getComputedStyle(document.documentElement)
  return {
    brand600: parseColorToRgb(styles.getPropertyValue('--color-brand-600').trim()) ?? FALLBACK_BRAND_600,
    brandOn: parseColorToRgb(styles.getPropertyValue('--color-brand-on').trim()) ?? [255, 255, 255],
  }
}

function parseColorToRgb(value: string): [number, number, number] | null {
  if (!value) return null
  const hexMatch = value.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/)
  if (hexMatch) {
    let hex = hexMatch[1]
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('')
    const num = parseInt(hex, 16)
    return [(num >> 16) & 255, (num >> 8) & 255, num & 255]
  }
  const rgbMatch = value.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
  if (rgbMatch) {
    return [Number(rgbMatch[1]), Number(rgbMatch[2]), Number(rgbMatch[3])]
  }
  return null
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface ReportCardPdfOptions {
  schoolName: string
  data: ReportCardData
}

export function downloadReportCardPdf(opts: ReportCardPdfOptions): void {
  const doc = buildReportCardPdf(opts, resolveBrandColors())
  const safeName = (opts.data.studentName || 'student').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '')
  const period = opts.data.termName ?? opts.data.sessionName
  doc.save(`${safeName || 'report'}-report-card${period ? `-${period.replace(/[^a-z0-9]+/gi, '-')}` : ''}.pdf`.toLowerCase())
}

// ─── Document assembly ────────────────────────────────────────────────────────

const PAGE_MARGIN = 14 // mm

function buildReportCardPdf(opts: ReportCardPdfOptions, colors: ResolvedBrandColors): jsPDF {
  const { schoolName, data } = opts
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const pageWidth = doc.internal.pageSize.getWidth()

  let y = drawHeader(doc, pageWidth, schoolName, colors)
  y = drawStudentBlock(doc, pageWidth, y, data)
  y = drawSubjectsTable(doc, y, data, colors)
  y = drawSummaryBox(doc, pageWidth, y, data, colors)
  y = drawRemarkBlock(doc, pageWidth, y, data)
  drawSignatures(doc, pageWidth, y)
  drawFooter(doc)

  return doc
}

function drawHeader(doc: jsPDF, pageWidth: number, schoolName: string, colors: ResolvedBrandColors): number {
  doc.setFillColor(...colors.brand600)
  doc.rect(0, 0, pageWidth, 24, 'F')

  doc.setTextColor(...colors.brandOn)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(15)
  doc.text(schoolName || 'School', pageWidth / 2, 11, { align: 'center' })

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.text('TERMINAL REPORT', pageWidth / 2, 18, { align: 'center' })

  doc.setTextColor(17, 24, 39)
  return 32
}

function drawStudentBlock(doc: jsPDF, pageWidth: number, y: number, data: ReportCardData): number {
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(12)
  doc.text(data.studentName || '—', PAGE_MARGIN, y)

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9.5)
  doc.setTextColor(75, 85, 99)

  const period = data.termName ? `${data.sessionName} · ${data.termName}` : data.sessionName
  const leftLines = [
    `Admission No: ${data.studentCode ?? '—'}`,
    `Class: ${data.className || '—'}`,
    `Session: ${period}`,
  ]
  const rightLines = [
    data.overallPosition !== null && data.totalGraded > 0
      ? `Position: ${data.overallPosition} of ${data.totalGraded}`
      : 'Position: —',
    data.attendance && data.attendance.totalMarked > 0
      ? `Attendance: ${data.attendance.present} of ${data.attendance.totalMarked} days` +
        ` (${Math.round((data.attendance.present / data.attendance.totalMarked) * 100)}%)`
      : 'Attendance: —',
  ]

  leftLines.forEach((line, i) => doc.text(line, PAGE_MARGIN, y + 6 + i * 5))
  rightLines.forEach((line, i) => doc.text(line, pageWidth - PAGE_MARGIN, y + 6 + i * 5, { align: 'right' }))

  doc.setTextColor(17, 24, 39)
  return y + 6 + Math.max(leftLines.length, rightLines.length) * 5 + 4
}

function drawSubjectsTable(
  doc: jsPDF,
  y: number,
  data: ReportCardData,
  colors: ResolvedBrandColors,
): number {
  if (data.subjects.length === 0) {
    doc.setFont('helvetica', 'italic')
    doc.setFontSize(10)
    doc.setTextColor(107, 114, 128)
    doc.text('No approved results yet for this period.', PAGE_MARGIN, y + 4)
    doc.setTextColor(17, 24, 39)
    return y + 12
  }

  // Dynamic component columns: ["1st CA", 20] → header "1st CA (20)".
  const compHead = data.components.map(c => `${c.name} (${c.max_score})`)
  const head = ['#', 'Subject', ...compHead, 'Total', 'Grade', 'Pos']
  const body = data.subjects.map((s, i) => [
    String(i + 1),
    s.subject_name,
    ...data.components.map(c =>
      s.componentValues[c.id] !== undefined ? String(s.componentValues[c.id]) : '—'),
    s.weighted_total.toFixed(1),
    s.grade_label ?? '—',
    s.position_in_class ? String(s.position_in_class) : '—',
  ])

  autoTable(doc, {
    startY: y,
    margin: { left: PAGE_MARGIN, right: PAGE_MARGIN },
    head: [head],
    body,
    styles: { fontSize: 8.5, cellPadding: 1.8, textColor: [17, 24, 39] },
    headStyles: { fillColor: colors.brand600, textColor: colors.brandOn, fontStyle: 'bold' },
    columnStyles: {
      0: { cellWidth: 8, halign: 'center' },
      1: { cellWidth: 52 },
    },
  })

  return (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 8
}

function drawSummaryBox(
  doc: jsPDF,
  pageWidth: number,
  y: number,
  data: ReportCardData,
  colors: ResolvedBrandColors,
): number {
  const availableHeight = doc.internal.pageSize.getHeight() - PAGE_MARGIN
  if (y > availableHeight - 40) { doc.addPage(); y = PAGE_MARGIN }

  const boxHeight = 18
  doc.setDrawColor(...colors.brand600)
  doc.setLineWidth(0.4)
  doc.roundedRect(PAGE_MARGIN, y, pageWidth - PAGE_MARGIN * 2, boxHeight, 2, 2)

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9.5)
  doc.setTextColor(...colors.brand600)
  doc.text('OVERALL PERFORMANCE', PAGE_MARGIN + 4, y + 6)

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(13)
  doc.setTextColor(17, 24, 39)
  doc.text(data.average !== null ? data.average.toFixed(1) : '—', PAGE_MARGIN + 4, y + 13.5)

  doc.setFont('helvetica', 'italic')
  doc.setFontSize(10)
  doc.setTextColor(75, 85, 99)
  const remarkText = data.aggregateRemark ?? (data.average !== null ? '' : 'Not yet graded')
  if (remarkText) {
    doc.text(remarkText, pageWidth - PAGE_MARGIN - 4, y + 11, { align: 'right', maxWidth: pageWidth - PAGE_MARGIN * 2 - 40 })
  }

  doc.setTextColor(17, 24, 39)
  return y + boxHeight + 8
}

function drawRemarkBlock(doc: jsPDF, pageWidth: number, y: number, data: ReportCardData): number {
  const availableHeight = doc.internal.pageSize.getHeight() - PAGE_MARGIN
  if (y > availableHeight - 34) { doc.addPage(); y = PAGE_MARGIN }

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9.5)
  doc.text("CLASS TEACHER'S REMARK", PAGE_MARGIN, y)

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.setTextColor(55, 65, 81)
  const remark = data.teacherRemark?.trim()
  if (remark) {
    doc.text(remark, PAGE_MARGIN, y + 6, { maxWidth: pageWidth - PAGE_MARGIN * 2 })
  } else {
    doc.setTextColor(156, 163, 175)
    doc.text('________________________________________________________________', PAGE_MARGIN, y + 6)
  }

  doc.setTextColor(17, 24, 39)
  const blockHeight = remark ? Math.ceil(remark.length / 95) * 5 + 8 : 12
  return y + blockHeight + 4
}

function drawSignatures(doc: jsPDF, pageWidth: number, y: number): void {
  const availableHeight = doc.internal.pageSize.getHeight() - PAGE_MARGIN
  if (y > availableHeight - 22) { doc.addPage(); y = PAGE_MARGIN }

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(75, 85, 99)
  doc.text('_____________________', PAGE_MARGIN, y + 6)
  doc.text('_____________________', pageWidth - PAGE_MARGIN - 40, y + 6)
  doc.text('Class Teacher', PAGE_MARGIN, y + 11)
  doc.text('Principal', pageWidth - PAGE_MARGIN - 40, y + 11)
  doc.setTextColor(17, 24, 39)
}

function drawFooter(doc: jsPDF): void {
  const pageCount = doc.getNumberOfPages()
  const generated = `Generated ${new Date().toLocaleDateString(undefined, {
    year: 'numeric', month: 'long', day: 'numeric',
  })}`
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i)
    const pageHeight = doc.internal.pageSize.getHeight()
    const pageWidth = doc.internal.pageSize.getWidth()
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7.5)
    doc.setTextColor(156, 163, 175)
    doc.text(generated, PAGE_MARGIN, pageHeight - 8)
    doc.text(`Page ${i} of ${pageCount}`, pageWidth - PAGE_MARGIN, pageHeight - 8, { align: 'right' })
  }
}
