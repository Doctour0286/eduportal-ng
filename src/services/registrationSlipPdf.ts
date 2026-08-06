/**
 * registrationSlipPdf.ts
 * PRD Tier 9 / Problem 9.6 — generates a real, downloadable PDF course
 * registration slip for student self-service. Built directly against
 * transcriptPdf.ts's established jsPDF + jspdf-autotable pattern (same
 * doc.save() download trigger, same live-CSS-custom-property brand-color
 * resolution, no new dependency — jsPDF/jspdf-autotable are already
 * installed per that file's own note) rather than inventing a new
 * PDF-generation approach.
 *
 * Chosen as a "keep as proof" document (real PDF download), not a
 * print-dialog reference like printTimetable.ts/printStudentIdCards.ts —
 * per the owner's explicit instruction (Problem 9.6), a registration slip
 * sits in the same category as a transcript or fee receipt.
 *
 * Student self-service only: this file has no concept of "who is allowed
 * to call it" baked in — that scoping lives entirely in GuardianPortal.tsx,
 * which is the only caller. CourseRegistrationModule.tsx (admin side)
 * deliberately never imports this file, matching the owner's explicit
 * "not also exposed on the admin side" scoping.
 */

import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'

// ─── Brand color resolution (identical approach to transcriptPdf.ts) ──────

interface ResolvedBrandColors {
  brand600: [number, number, number]
  brandOn: [number, number, number]
}

const FALLBACK_BRAND_600: [number, number, number] = [37, 99, 235] // #2563eb — same converged default as transcriptPdf.ts/printStudentIdCards.ts
const FALLBACK_BRAND_ON: [number, number, number] = [255, 255, 255]

function resolveBrandColors(): ResolvedBrandColors {
  const styles = getComputedStyle(document.documentElement)
  const rawBrand600 = styles.getPropertyValue('--color-brand-600').trim()
  const rawBrandOn = styles.getPropertyValue('--color-brand-on').trim()
  return {
    brand600: parseColorToRgb(rawBrand600) ?? FALLBACK_BRAND_600,
    brandOn: parseColorToRgb(rawBrandOn) ?? FALLBACK_BRAND_ON,
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

// ─── Public API ─────────────────────────────────────────────────────────────

export interface RegistrationSlipCourse {
  course_code: string
  course_title: string
  credit_units: number
}

export interface RegistrationSlipOptions {
  studentName: string
  matricNumber: string | null
  programmeName: string
  levelLabel: string
  sessionName: string | null
  termName: string | null
  courses: RegistrationSlipCourse[]
}

/**
 * Builds the registration slip PDF and triggers a real browser download
 * (jsPDF's doc.save()). Filename: "<student name>-registration.pdf",
 * sanitised the same way transcriptPdf.ts sanitises its own filename.
 */
export function downloadRegistrationSlipPdf(opts: RegistrationSlipOptions): void {
  const doc = buildRegistrationSlipPdf(opts, resolveBrandColors())
  const safeName = opts.studentName.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '')
  doc.save(`${safeName || 'student'}-registration.pdf`)
}

// ─── Document assembly ──────────────────────────────────────────────────────

const PAGE_MARGIN = 14 // mm

function buildRegistrationSlipPdf(opts: RegistrationSlipOptions, colors: ResolvedBrandColors): jsPDF {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const pageWidth = doc.internal.pageSize.getWidth()

  let cursorY = drawHeader(doc, pageWidth, colors)
  cursorY = drawStudentBlock(doc, pageWidth, cursorY, opts)
  cursorY = drawCourseTable(doc, pageWidth, cursorY, opts, colors)
  drawFooter(doc, pageWidth)

  return doc
}

function drawHeader(doc: jsPDF, pageWidth: number, colors: ResolvedBrandColors): number {
  doc.setFillColor(...colors.brand600)
  doc.rect(0, 0, pageWidth, 22, 'F')

  doc.setTextColor(...colors.brandOn)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(15)
  doc.text('Course Registration Slip', PAGE_MARGIN, 12)

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.text('Official record of registered courses', PAGE_MARGIN, 18)

  doc.setTextColor(17, 24, 39)
  return 30
}

function drawStudentBlock(doc: jsPDF, pageWidth: number, y: number, opts: RegistrationSlipOptions): number {
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(11)
  doc.text(opts.studentName, PAGE_MARGIN, y)

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(75, 85, 99)
  doc.text(`Matric No: ${opts.matricNumber ?? '—'}`, PAGE_MARGIN, y + 5)
  doc.text(`${opts.programmeName} · Level ${opts.levelLabel}`, PAGE_MARGIN, y + 10)

  const periodLabel = opts.termName
    ? `${opts.sessionName ?? ''} — ${opts.termName}`.replace(/^ — /, '')
    : (opts.sessionName ?? '')
  if (periodLabel) doc.text(periodLabel, PAGE_MARGIN, y + 15)

  const generatedLabel = `Generated ${new Date().toLocaleDateString(undefined, {
    year: 'numeric', month: 'long', day: 'numeric',
  })}`
  doc.text(generatedLabel, pageWidth - PAGE_MARGIN, y, { align: 'right' })

  doc.setTextColor(17, 24, 39)
  return y + 22
}

function drawCourseTable(
  doc: jsPDF,
  pageWidth: number,
  y: number,
  opts: RegistrationSlipOptions,
  colors: ResolvedBrandColors,
): number {
  const totalUnits = opts.courses.reduce((sum, c) => sum + c.credit_units, 0)
  const rows = opts.courses.map((c) => [c.course_code, c.course_title, String(c.credit_units)])

  autoTable(doc, {
    startY: y,
    margin: { left: PAGE_MARGIN, right: PAGE_MARGIN },
    head: [['Code', 'Course title', 'Units']],
    body: rows,
    styles: { fontSize: 9, cellPadding: 2.2, textColor: [17, 24, 39] },
    headStyles: { fillColor: colors.brand600, textColor: colors.brandOn, fontStyle: 'bold' },
    columnStyles: {
      0: { cellWidth: 26 },
      2: { cellWidth: 20, halign: 'center' },
    },
  })

  const finalY = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(10)
  doc.setTextColor(17, 24, 39)
  doc.text(`Total credit units: ${totalUnits}`, pageWidth - PAGE_MARGIN, finalY + 8, { align: 'right' })

  return finalY + 16
}

function drawFooter(doc: jsPDF, pageWidth: number): void {
  const pageCount = doc.getNumberOfPages()
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i)
    const pageHeight = doc.internal.pageSize.getHeight()
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7.5)
    doc.setTextColor(156, 163, 175)
    doc.text('Generated by EduSkola — for the student\'s own record', PAGE_MARGIN, pageHeight - 8)
    doc.text(`Page ${i} of ${pageCount}`, pageWidth - PAGE_MARGIN, pageHeight - 8, { align: 'right' })
  }
}
