/**
 * transcriptPdf.ts
 * SESSION 60b — generates a real, downloadable PDF transcript (course /
 * grade / GP / CGPA only, per that session's own scope). No new
 * computation — every number here is read straight off the
 * StudentTranscript object courseResultsService.ts's loadStudentTranscript()
 * already assembled from course_results/student_gpa_snapshots.
 *
 * Deliberate departure from printTimetable.ts/printStudentIdCards.ts's
 * window.open()-then-browser-print-dialog pattern (owner's explicit
 * instruction, this session): those two files build an HTML document and
 * rely on the OS print sheet's own "Save as PDF" option, which is not a
 * real one-tap download and leaves the user in the print dialog rather
 * than with a file. This file instead renders directly to PDF bytes via
 * jsPDF + jspdf-autotable and triggers a real browser download — no print
 * dialog, no intermediate HTML document, no window.open() at all.
 *
 * jsPDF + jspdf-autotable is a genuinely NEW dependency — confirmed via
 * the master plan's own manifest that no PDF-generation library exists
 * anywhere in this codebase before this session (report cards/receipts/
 * invoices are all print-dialog-based). Flagged here rather than added
 * silently, per §7's "never invent... without flagging it" discipline
 * extended to dependencies. `npm install jspdf jspdf-autotable` is
 * required before this file will build.
 *
 * Brand-color resolution reuses printStudentIdCards.ts's exact approach —
 * read the live, already-injected --color-brand-600/--color-brand-on
 * custom properties off document.documentElement at call time (never a
 * var() reference baked into a detached document, since jsPDF has no
 * concept of CSS at all) — same fallback blue if unset.
 *
 * React Native note: jsPDF itself has no window.open/DOM dependency for
 * document generation, only for the final doc.save() browser-download
 * step (which uses an anchor-click-download under the hood) and for
 * resolveBrandColors()'s getComputedStyle() read. A future native port
 * swaps doc.save() for a Share-sheet write (react-native-blob-util or
 * similar) and passes resolved brand colors in from a theme context
 * instead of reading the DOM — buildTranscriptPdf() itself, given
 * resolved colors, is otherwise fully portable.
 */

import jsPDF from 'jspdf'
import autoTable, { type CellHookData } from 'jspdf-autotable'
import type { StudentTranscript, TranscriptSemester } from './courseResultsService'

// ─── Brand color resolution (same approach as printStudentIdCards.ts) ─────

interface ResolvedBrandColors {
  /** [r, g, b] tuples — jsPDF's setFillColor/setTextColor/setDrawColor
   *  take numeric RGB triples, not CSS strings, so the hex/rgb string
   *  read off the custom property is parsed once here rather than at
   *  every call site. */
  brand600: [number, number, number]
  brandOn: [number, number, number]
}

const FALLBACK_BRAND_600: [number, number, number] = [37, 99, 235] // #2563eb — same converged default as printStudentIdCards.ts
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

/** Parses a #hex or rgb()/rgba() CSS color string into an [r,g,b] tuple.
 *  Returns null on anything unparseable (empty string, an unexpected
 *  custom-property format) so the caller can fall back rather than hand
 *  jsPDF a garbage color. */
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

export interface TranscriptPdfOptions {
  schoolName: string
  schoolAddress?: string
  transcript: StudentTranscript
}

/**
 * Builds the transcript PDF and triggers a real browser download
 * (jsPDF's doc.save(), which under the hood does the anchor-click-download
 * dance itself — no manual Blob/URL.createObjectURL/window.open needed
 * for this path, unlike the two print-dialog files this session departs
 * from). Filename: "<student name> - Transcript.pdf", sanitised.
 */
export function downloadTranscriptPdf(opts: TranscriptPdfOptions): void {
  const doc = buildTranscriptPdf(opts, resolveBrandColors())
  const safeName = opts.transcript.student_name.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '')
  doc.save(`${safeName || 'transcript'}-transcript.pdf`)
}

// ─── Document assembly ──────────────────────────────────────────────────────

const PAGE_MARGIN = 14 // mm

function buildTranscriptPdf(opts: TranscriptPdfOptions, colors: ResolvedBrandColors): jsPDF {
  const { schoolName, schoolAddress, transcript } = opts
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const pageWidth = doc.internal.pageSize.getWidth()

  let cursorY = drawHeader(doc, pageWidth, schoolName, schoolAddress, colors)
  cursorY = drawStudentBlock(doc, pageWidth, cursorY, transcript)

  if (transcript.semesters.length === 0) {
    doc.setFont('helvetica', 'italic')
    doc.setFontSize(10)
    doc.setTextColor(107, 114, 128)
    doc.text('No finalized courses yet.', PAGE_MARGIN, cursorY + 8)
    cursorY += 16
  } else {
    for (const semester of transcript.semesters) {
      cursorY = drawSemesterTable(doc, pageWidth, cursorY, semester, colors)
    }
  }

  cursorY = drawCgpaSummary(doc, pageWidth, cursorY, transcript, colors)
  drawFooter(doc, pageWidth, transcript.computed_at)

  return doc
}

function drawHeader(
  doc: jsPDF,
  pageWidth: number,
  schoolName: string,
  schoolAddress: string | undefined,
  colors: ResolvedBrandColors,
): number {
  // Brand-colored top band, matching printStudentIdCards.ts's "sync with
  // school custom colour" instinct even though this is a different
  // document shape — a thin header bar rather than a card band.
  doc.setFillColor(...colors.brand600)
  doc.rect(0, 0, pageWidth, 22, 'F')

  doc.setTextColor(...colors.brandOn)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(15)
  doc.text(schoolName, PAGE_MARGIN, 12)

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.text(schoolAddress ? schoolAddress : 'Official Academic Transcript', PAGE_MARGIN, 18)

  doc.setTextColor(17, 24, 39)
  return 30
}

function drawStudentBlock(doc: jsPDF, pageWidth: number, y: number, transcript: StudentTranscript): number {
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(11)
  doc.text(transcript.student_name, PAGE_MARGIN, y)

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(75, 85, 99)
  doc.text(`Matric No: ${transcript.matric_number ?? '—'}`, PAGE_MARGIN, y + 5)

  const generatedLabel = `Generated ${new Date().toLocaleDateString(undefined, {
    year: 'numeric', month: 'long', day: 'numeric',
  })}`
  doc.text(generatedLabel, pageWidth - PAGE_MARGIN, y, { align: 'right' })

  doc.setTextColor(17, 24, 39)
  return y + 12
}

/**
 * Draws one semester's course table via jspdf-autotable, then that
 * semester's own GPA/units/quality-points line directly beneath it.
 * autotable handles page-breaks automatically if a semester's course list
 * runs past the bottom margin — the manual coordinate math in this file
 * only has to track where the PAGE currently sits (via doc.lastAutoTable's
 * finalY), not re-derive row heights itself.
 */
function drawSemesterTable(
  doc: jsPDF,
  pageWidth: number,
  y: number,
  semester: TranscriptSemester,
  colors: ResolvedBrandColors,
): number {
  const availableHeight = doc.internal.pageSize.getHeight() - PAGE_MARGIN
  if (y > availableHeight - 30) {
    doc.addPage()
    y = PAGE_MARGIN
  }

  const heading = semester.term_name ? `${semester.session_name} — ${semester.term_name}` : semester.session_name
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(10.5)
  doc.setTextColor(17, 24, 39)
  doc.text(heading, PAGE_MARGIN, y + 4)

  const rows = semester.courses.map((c) => [
    c.course_code,
    c.course_title,
    String(c.credit_units),
    c.score === null ? '—' : c.score.toFixed(1),
    c.letter_grade ?? '—',
    c.grade_point === null ? '—' : c.grade_point.toFixed(2),
    [c.is_carryover ? 'Carryover' : '', c.is_superseded ? 'Superseded' : ''].filter(Boolean).join(', ') || '—',
  ])

  autoTable(doc, {
    startY: y + 7,
    margin: { left: PAGE_MARGIN, right: PAGE_MARGIN },
    head: [['Code', 'Course title', 'Units', 'Score', 'Grade', 'GP', 'Notes']],
    body: rows,
    styles: { fontSize: 8.5, cellPadding: 1.8, textColor: [17, 24, 39] },
    headStyles: { fillColor: colors.brand600, textColor: colors.brandOn, fontStyle: 'bold' },
    // Superseded rows shown greyed rather than omitted — §7.27.4's own
    // rule ("still shows on the transcript, annotated superseded, but
    // excluded from the calculation") is a display instruction, not a
    // filter; the CGPA math these rows are excluded from already happened
    // upstream in gpaService.ts, this table just needs to say so.
    didParseCell: (data: CellHookData) => {
      const rowIndex = data.row.index
      if (data.section === 'body' && semester.courses[rowIndex]?.is_superseded) {
        data.cell.styles.textColor = [156, 163, 175]
      }
    },
    columnStyles: {
      0: { cellWidth: 20 },
      2: { cellWidth: 14, halign: 'center' },
      3: { cellWidth: 16, halign: 'center' },
      4: { cellWidth: 16, halign: 'center' },
      5: { cellWidth: 12, halign: 'center' },
      6: { cellWidth: 28 },
    },
  })

  // jspdf-autotable attaches its own finalY onto the doc instance after
  // each call — the documented way to chain multiple tables down a page.
  const finalY = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(75, 85, 99)
  const gpaLine =
    semester.gpa === null
      ? 'Semester GPA: not yet computed'
      : `Semester GPA: ${semester.gpa.toFixed(2)}  ·  Units attempted: ${semester.total_units_attempted ?? '—'}  ·  Quality points: ${semester.total_quality_points?.toFixed(2) ?? '—'}`
  doc.text(gpaLine, pageWidth - PAGE_MARGIN, finalY + 5, { align: 'right' })
  doc.setTextColor(17, 24, 39)

  return finalY + 12
}

function drawCgpaSummary(
  doc: jsPDF,
  pageWidth: number,
  y: number,
  transcript: StudentTranscript,
  colors: ResolvedBrandColors,
): number {
  const availableHeight = doc.internal.pageSize.getHeight() - PAGE_MARGIN
  if (y > availableHeight - 20) {
    doc.addPage()
    y = PAGE_MARGIN
  }

  const boxHeight = 16
  doc.setDrawColor(...colors.brand600)
  doc.setLineWidth(0.4)
  doc.roundedRect(PAGE_MARGIN, y, pageWidth - PAGE_MARGIN * 2, boxHeight, 2, 2)

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9.5)
  doc.setTextColor(...colors.brand600)
  doc.text('CUMULATIVE GPA (CGPA)', PAGE_MARGIN + 4, y + 6.5)

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(13)
  doc.setTextColor(17, 24, 39)
  const cgpaText = transcript.cgpa === null ? '—' : transcript.cgpa.toFixed(2)
  doc.text(cgpaText, PAGE_MARGIN + 4, y + 12.5)

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8.5)
  doc.setTextColor(75, 85, 99)
  const detail =
    transcript.cgpa === null
      ? 'Not yet computed'
      : `Units attempted: ${transcript.cgpa_total_units_attempted ?? '—'}  ·  Quality points: ${transcript.cgpa_total_quality_points?.toFixed(2) ?? '—'}`
  doc.text(detail, pageWidth - PAGE_MARGIN - 4, y + 9.5, { align: 'right' })

  doc.setTextColor(17, 24, 39)
  return y + boxHeight + 8
}

function drawFooter(doc: jsPDF, pageWidth: number, computedAt: string | null): void {
  const pageCount = doc.getNumberOfPages()
  const asOfLine = computedAt
    ? `As of ${new Date(computedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}`
    : 'No results computed yet'
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i)
    const pageHeight = doc.internal.pageSize.getHeight()
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7.5)
    doc.setTextColor(156, 163, 175)
    doc.text(asOfLine, PAGE_MARGIN, pageHeight - 8)
    doc.text(`Page ${i} of ${pageCount}`, pageWidth - PAGE_MARGIN, pageHeight - 8, { align: 'right' })
  }
}
