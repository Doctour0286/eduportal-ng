/**
 * reportCardPdf.ts
 * PRD Tier 8 / Problem 8.4 — PDF report card for secondary schools.
 *
 * Layout (Session 81 redesign — owner-requested overhaul):
 *   1. School header band: LOGO, name, address, "TERMINAL REPORT"
 *   2. Student info block: PASSPORT PHOTO, name (dominant), position
 *      (dominant), reg/class/session — attendance moved OUT of this block,
 *      see point 7 (Session 81: fixed a real duplication — attendance used
 *      to appear here AND in its own section below; now only the section)
 *   3. Grading key: dynamic from grade_scales, never hardcoded
 *   4. Per-subject table: dynamic component columns, total, grade, remark, position
 *   5. Totals / summary row: total marks, average, class position
 *   6. Admin-configured notice (Session 81: report_card_settings.notice —
 *      only rendered if the admin set one for this class+term)
 *   7. Attendance summary: days present, absent, rate — the ONE place this
 *      appears now
 *   8. Teacher's remark + Principal's remark, each with an actual SIGNATURE
 *      IMAGE when the form master / school has uploaded one (Session 81 —
 *      previously always a blank line, and the principal remark was never
 *      wired to real data at all)
 *   9. Resumption date / next-term fees (Session 81: report_card_settings)
 *   10. Signature lines + page footer
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
 *
 * Images (Session 81): logo, passport photo, and signatures are loaded
 * ASYNCHRONOUSLY before drawing (pdfImageLoader.ts — jsPDF's addImage()
 * needs actual image bytes, it cannot fetch a URL itself), which is why
 * downloadReportCardPdf() and downloadBatchReportCardPdf() are both async
 * now, unlike this file's previous fully-synchronous shape. A failed image
 * load (network hiccup, missing photo) never aborts generation — the report
 * card just renders without that one image; see pdfImageLoader.ts's own
 * comment for why that's the right failure mode for a print job.
 *
 * Batch printing (Session 81, owner request — "print all" / "print
 * selected" as ONE combined multi-page PDF): drawOneReportCard() draws a
 * single student's full report card onto a jsPDF doc the CALLER owns and
 * has already added a page to, rather than creating its own document the
 * way the old buildReportCardPdf() did. downloadReportCardPdf() (single
 * student, unchanged public contract) and downloadBatchReportCardPdf() (new)
 * both just create one shared doc, loop, and call drawOneReportCard() once
 * per student — this is the only structural change needed to support
 * batching; nothing about the single-student path's behavior or output
 * changed.
 */

import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import type { ReportCardData } from './assessmentService'
import { drawRtlAwareText, drawRtlAwareWrappedText, countWrappedLines, toVisualPdfText } from './pdfTextShaping'
import { loadImageForPdf, fitWithinBox, type LoadedImage } from './pdfImageLoader'
import { REPORT_CARD_FONT_REGULAR_BASE64, REPORT_CARD_FONT_BOLD_BASE64 } from '../assets/fonts/reportCardFont'

// ─── Font registration ──────────────────────────────────────────────────────
// jsPDF fonts are registered per-document (addFileToVFS/addFont live on the
// jsPDF instance), so this runs once per generated PDF, not once per student
// — for a batch, register ONCE on the shared doc, not inside the per-student
// loop (re-registering the same font data on every page is pure waste and,
// worse, re-running addFont mid-document has not been verified safe against
// pages already drawn with FONT_FAMILY active).

const FONT_FAMILY = 'ReportCard'

function registerReportCardFont(doc: jsPDF): void {
  doc.addFileToVFS('ReportCard-Regular.ttf', REPORT_CARD_FONT_REGULAR_BASE64)
  doc.addFont('ReportCard-Regular.ttf', FONT_FAMILY, 'normal')
  doc.addFileToVFS('ReportCard-Bold.ttf', REPORT_CARD_FONT_BOLD_BASE64)
  doc.addFont('ReportCard-Bold.ttf', FONT_FAMILY, 'bold')
  // No real italic weight is embedded — jsPDF falls back to a built-in
  // standard font (NOT a synthetic slant) when 'italic' is requested and no
  // italic weight is registered for a custom family — confirmed by testing
  // in Session 80. Never request FONT_FAMILY + 'italic' anywhere below;
  // use color/weight for emphasis instead (see drawSummaryRow's own note).
  doc.setFont(FONT_FAMILY, 'normal')
}

/**
 * Draws text via jsPDF's doc.text(), but always through toVisualPdfText()
 * first. Use this instead of doc.text() everywhere in this file — the one
 * time a raw doc.text() call slips back in, any Arabic text handed to it
 * will silently mis-shape/mis-order again.
 */
/**
 * text()
 * Every text draw in this file goes through this wrapper instead of
 * calling doc.text() directly — it routes to drawRtlAwareText()
 * (pdfTextShaping.ts), which lays out each word's position itself rather
 * than handing jsPDF a single string to draw, because jsPDF's own
 * multi-word RTL rendering has a confirmed, unfixable-from-the-outside bug
 * (see pdfTextShaping.ts's file header for the full investigation before
 * concluding this).
 *
 * Only `align` is forwarded — `maxWidth` (jsPDF's own auto-wrap option) is
 * NOT supported here, because jsPDF's line-splitting for auto-wrap has the
 * same RTL-unsafe internals as its single-line draw. Callers that need
 * wrapping use wrappedText() below instead; the couple of `maxWidth`-only
 * call sites that existed before this rewrite (safeguards against a
 * long student name overflowing, not real expected multi-line wrapping)
 * were checked individually and either don't need real wrapping or were
 * moved to wrappedText().
 */
function text(doc: jsPDF, str: string, x: number, y: number, options?: { align?: 'left' | 'center' | 'right' }): void {
  drawRtlAwareText(doc, str, x, y, options)
}

/**
 * wrappedText()
 * For text that genuinely needs to wrap across multiple lines (a remark, a
 * notice) — see text()'s own comment for why this can't just be `maxWidth`
 * on a regular text() call. Returns the number of lines drawn (mirrors
 * jsPDF's own doc.splitTextToSize(...).length, which every prior call site
 * needing a line count used).
 */
function wrappedText(doc: jsPDF, str: string, x: number, y: number, maxWidth: number, lineHeight: number, options?: { align?: 'left' | 'center' | 'right' }): number {
  return drawRtlAwareWrappedText(doc, str, x, y, maxWidth, lineHeight, options)
}

/**
 * safeAddImage
 * jsPDF's addImage() can throw even after pdfImageLoader.ts's own checks
 * passed (fetch succeeded, browser decoded it fine for dimensions) — jsPDF
 * has its own internal image processing (re-encoding, colorspace handling)
 * that can reject a file the browser itself displayed without complaint.
 * Confirmed directly during this feature's own testing: a malformed test
 * PNG that fetch()/Image() both accepted still threw "Error while
 * decompressing the data" inside addImage. Every addImage call in this
 * file goes through this wrapper so that failure mode matches
 * pdfImageLoader.ts's own stated policy — a bad image degrades gracefully
 * (skip it, keep the blank-line/no-logo layout), it never aborts the
 * student's whole report card.
 */
function safeAddImage(doc: jsPDF, img: LoadedImage, x: number, y: number, w: number, h: number): boolean {
  try {
    doc.addImage(img.dataUrl, img.format, x, y, w, h)
    return true
  } catch {
    return false
  }
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
  schoolPhone?: string | null
  schoolEmail?: string | null
  logoUrl?: string | null
  gradeBands?: { min_score: number; max_score: number; grade_label: string; remark: string | null }[]
  data: ReportCardData
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function downloadReportCardPdf(opts: ReportCardPdfOptions): Promise<void> {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  registerReportCardFont(doc)
  const colors = resolveBrandColors()

  const [logo, photo] = await Promise.all([
    loadImageForPdf(opts.logoUrl),
    loadImageForPdf(opts.data.studentPhotoUrl),
  ])
  const signatures = await loadSignaturesForOptions(opts)

  await drawOneReportCard(doc, opts, colors, { logo, photo, ...signatures })
  drawPageFooter(doc)

  const safeName = (opts.data.studentName || 'student').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '')
  const period = opts.data.termName ?? opts.data.sessionName
  doc.save(`${safeName || 'report'}-report-card${period ? `-${period.replace(/[^a-z0-9]+/gi, '-')}` : ''}.pdf`.toLowerCase())
}

/**
 * downloadBatchReportCardPdf
 * Session 81 (owner request) — "print all" / "print selected students as a
 * batch" -> ONE combined multi-page PDF, one download.
 *
 * The school logo and each student's form-master/principal signature are
 * loaded ONCE per distinct URL across the whole batch (not once per
 * student) via the caches below — a class of 40 students all share the
 * same school logo and, in the overwhelming majority of cases, the same
 * form master, so re-fetching those images 40 times would be pure waste
 * and would meaningfully slow down a big print run. Each student's own
 * passport photo is still fetched individually (genuinely per-student
 * data), but happens in parallel across the batch via Promise.all, not
 * serially page-by-page.
 */
export async function downloadBatchReportCardPdf(
  optsList: ReportCardPdfOptions[],
  batchLabel: string,
): Promise<void> {
  if (optsList.length === 0) return

  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  registerReportCardFont(doc)
  const colors = resolveBrandColors()

  const imageCache = new Map<string, Promise<LoadedImage | null>>()
  const cachedLoad = (url: string | null | undefined): Promise<LoadedImage | null> => {
    if (!url) return Promise.resolve(null)
    if (!imageCache.has(url)) imageCache.set(url, loadImageForPdf(url))
    return imageCache.get(url)!
  }

  // Pre-warm every distinct image URL in the batch in parallel, rather than
  // sequentially inside the per-student loop below — this is what actually
  // makes the shared-logo/shared-signature caching pay off (without this,
  // the FIRST student to need the logo would still trigger one fetch, but
  // subsequent students calling cachedLoad on an in-flight promise before it
  // resolves works correctly either way; pre-warming just makes the whole
  // batch's image loading happen concurrently instead of page-by-page).
  await Promise.all(
    optsList.flatMap(o => [
      cachedLoad(o.logoUrl),
      cachedLoad(o.data.studentPhotoUrl),
      cachedLoad(o.data.formMaster?.signatureUrl),
    ]),
  )

  for (let i = 0; i < optsList.length; i++) {
    const opts = optsList[i]
    if (i > 0) doc.addPage()

    const [logo, photo] = await Promise.all([cachedLoad(opts.logoUrl), cachedLoad(opts.data.studentPhotoUrl)])
    const signature = await cachedLoad(opts.data.formMaster?.signatureUrl)

    await drawOneReportCard(doc, opts, colors, {
      logo,
      photo,
      teacherSignature: signature,
      principalSignature: null, // no separate principal-signature source exists yet — see file header's schema note
    })
  }

  drawPageFooter(doc)
  doc.save(`${batchLabel.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-report-cards.pdf`)
}

async function loadSignaturesForOptions(opts: ReportCardPdfOptions): Promise<{
  teacherSignature: LoadedImage | null
  principalSignature: LoadedImage | null
}> {
  const teacherSignature = await loadImageForPdf(opts.data.formMaster?.signatureUrl)
  // No separate principal-signature field exists in the schema yet (only
  // class_form_masters.signature_url, which is the CLASS TEACHER's/form
  // master's signature) — the principal's remark box therefore still draws
  // a blank signature line, same as before, until/unless a school-level
  // head-teacher-signature field is added.
  return { teacherSignature, principalSignature: null }
}

interface ReportCardImages {
  logo: LoadedImage | null
  photo: LoadedImage | null
  teacherSignature: LoadedImage | null
  principalSignature: LoadedImage | null
}

// ─── Document assembly ──────────────────────────────────────────────────────

const MARGIN = 14 // mm
const PAGE_W = 210 // A4 width mm
const PAGE_H = 297 // A4 height mm
const CONTENT_W = PAGE_W - MARGIN * 2

/**
 * Draws one student's complete report card onto `doc`, starting at
 * whatever page is CURRENTLY ACTIVE (doc.setPage/doc.addPage is the
 * caller's responsibility — see downloadReportCardPdf/
 * downloadBatchReportCardPdf above). This is the one function this whole
 * file previously called buildReportCardPdf() and had create its own
 * jsPDF instance; it no longer does either, which is what makes batching
 * possible without changing anything about a single student's own layout.
 */
async function drawOneReportCard(
  doc: jsPDF,
  opts: ReportCardPdfOptions,
  colors: ResolvedBrandColors,
  images: ReportCardImages,
): Promise<void> {
  const { data } = opts

  let y = drawHeader(doc, opts, colors, images.logo, images.photo)
  y = drawStudentBlock(doc, y, data, colors)
  y = drawGradingKey(doc, y, opts.gradeBands ?? [], colors)
  y = drawSubjectsTable(doc, y, data, opts.gradeBands ?? [], colors)
  y = drawSummaryRow(doc, y, data, opts.gradeBands ?? [], colors)
  y = drawNotice(doc, y, data)
  y = drawAttendanceSummary(doc, y, data)
  y = drawRemarks(doc, y, data, images.teacherSignature, images.principalSignature)
  y = drawTermInfo(doc, y, data)
  drawSignatureLines(doc, y)
  // NOTE: drawPageFooter() is deliberately NOT called here. It stamps every
  // page currently in the whole document (needed for a correct "Page X of
  // N" count), so it must run exactly ONCE, after the LAST student in a
  // batch is drawn — not once per student, which would both re-stamp
  // already-footed pages (visible double-footer) and show the wrong "of N"
  // total until the very last call. See downloadReportCardPdf and
  // downloadBatchReportCardPdf, which each call it exactly once.
}

// ─── 1. School header band ──────────────────────────────────────────────────

function drawHeader(
  doc: jsPDF,
  opts: ReportCardPdfOptions,
  colors: ResolvedBrandColors,
  logo: LoadedImage | null,
  photo: LoadedImage | null,
): number {
  // Session 82 redesign (owner feedback on a real device): the solid
  // colored header bar is gone — plain white background, matching the
  // reference report-card samples the owner shared, and reads more like a
  // formal institutional letterhead than an app-branded banner. Logo sits
  // top-left, passport photo top-right (moved OUT of the student-info
  // block below, where it was cramped next to the position/"of N" text —
  // this is the standard convention the reference samples use: logo and
  // photo bookend the header, school name centered between them).
  const HEADER_H = 30
  const IMG_SLOT = 20

  // Logo — top-left
  if (logo) {
    const { w, h } = fitWithinBox(logo, IMG_SLOT, IMG_SLOT)
    safeAddImage(doc, logo, MARGIN, (HEADER_H - h) / 2, w, h)
  }

  // Passport photo — top-right, mirroring the logo's placement. A bordered
  // box only when it actually renders (see safeAddImage's own contract) —
  // no placeholder box when a student has no photo yet, since a bordered
  // empty box would read as a rendering bug rather than "not uploaded".
  if (photo) {
    const { w, h } = fitWithinBox(photo, IMG_SLOT, IMG_SLOT)
    const px = PAGE_W - MARGIN - w
    const py = (HEADER_H - h) / 2
    const drew = safeAddImage(doc, photo, px, py, w, h)
    if (drew) {
      doc.setDrawColor(203, 213, 225)
      doc.setLineWidth(0.2)
      doc.rect(px, py, w, h)
    }
  }

  // School name — centered, bolder/larger than before (owner feedback:
  // "font should be bolder") — bumped from 16pt to 18pt, and drawn twice
  // with a hair offset to fake a heavier weight, since the embedded font
  // only has one bold weight and jsPDF has no "extra-bold" to request (see
  // registerReportCardFont's own note on why a second weight isn't
  // embedded — this trick avoids doubling font payload size for one extra
  // weight used in exactly one place).
  doc.setTextColor(17, 24, 39)
  doc.setFont(FONT_FAMILY, 'bold')
  doc.setFontSize(18)
  text(doc, opts.schoolName || 'School', PAGE_W / 2 + 0.15, 12, { align: 'center' })
  text(doc, opts.schoolName || 'School', PAGE_W / 2, 12, { align: 'center' })

  // Address, then phone/email on their own line below — only drawn when
  // set (owner: "if school address and contact exist"). Two separate
  // lines rather than cramming both onto one, since a school with a long
  // address AND both a phone and email would otherwise overflow or need
  // its own wrap logic.
  let contactY = 18
  doc.setFont(FONT_FAMILY, 'normal')
  doc.setFontSize(8)
  doc.setTextColor(75, 85, 99)
  if (opts.schoolAddress) {
    text(doc, opts.schoolAddress, PAGE_W / 2, contactY, { align: 'center' })
    contactY += 4.5
  }
  const contactParts = [opts.schoolPhone, opts.schoolEmail].filter((v): v is string => !!v)
  if (contactParts.length > 0) {
    text(doc, contactParts.join('   •   '), PAGE_W / 2, contactY, { align: 'center' })
    contactY += 4.5
  }

  // "TERMINAL REPORT" label, centered below whatever contact lines were
  // drawn (or right under the name if there are none) — small caps-style
  // label, no longer competing with a colored bar for attention.
  doc.setFont(FONT_FAMILY, 'bold')
  doc.setFontSize(8)
  doc.setTextColor(...colors.brand600)
  text(doc, 'TERMINAL REPORT', PAGE_W / 2, contactY + 1, { align: 'center' })

  // Thin rule under the whole header band, closing it off from the content
  // below now that there's no colored fill to do that visually.
  doc.setDrawColor(226, 232, 240)
  doc.setLineWidth(0.3)
  doc.line(MARGIN, HEADER_H, PAGE_W - MARGIN, HEADER_H)

  return HEADER_H + 4
}

// ─── 2. Student info block ──────────────────────────────────────────────────

function drawStudentBlock(
  doc: jsPDF,
  y: number,
  data: ReportCardData,
  colors: ResolvedBrandColors,
): number {
  // Session 82: no longer takes a `photo` param — the passport photo now
  // lives in the header (see drawHeader), so this block goes back to being
  // a plain text block, same height regardless of whether the student has
  // a photo. Attendance is still deliberately NOT drawn here — see the
  // dedicated section further down the page (drawAttendanceSummary).
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

  // Reg no, class, session/term
  const period = data.termName ? `${data.sessionName} — ${data.termName}` : data.sessionName
  text(doc, `Reg. No: ${data.studentCode ?? '—'}`, lx, ly)
  text(doc, `Class: ${data.className || '—'}`, lx, ly + 5)
  text(doc, `Session: ${period}`, lx, ly + 10)

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
    wrappedText(doc, data.aggregateRemark, rx, ty + 4, 55, 4.5, { align: 'right' })
  }

  doc.setTextColor(17, 24, 39)
  return y + boxH + 5
}

function getAvgGradeLabel(avg: number, bands: { min_score: number; max_score: number; grade_label: string }[]): string | null {
  const band = bands.find(b => avg >= b.min_score && avg <= b.max_score)
  return band?.grade_label ?? null
}

// ─── 6. Teacher + Principal remarks ─────────────────────────────────────────

function drawRemarks(
  doc: jsPDF,
  y: number,
  data: ReportCardData,
  teacherSignature: LoadedImage | null,
  principalSignature: LoadedImage | null,
): number {
  // Taller than before to make room for a signature image sitting under
  // the remark text, when one is available (Session 81 — previously this
  // box only ever drew a blank underscore line, and the principal side
  // never read real data at all: data.principalRemark did not exist yet).
  const boxH = 30
  if (y + boxH > PAGE_H - MARGIN - 20) {
    doc.addPage()
    y = MARGIN
  }

  const halfW = (CONTENT_W - 4) / 2
  const SIG_SLOT_W = 30
  const SIG_SLOT_H = 10

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
    wrappedText(doc, remark, MARGIN + 3, y + 10, halfW - 6, 4.1)
  } else {
    doc.setTextColor(180, 180, 180)
    text(doc, '________________________________', MARGIN + 3, y + 10)
  }
  drawSignatureBlock(doc, teacherSignature, data.formMaster?.staffName ?? null, MARGIN + 3, y + boxH - SIG_SLOT_H - 2, SIG_SLOT_W, SIG_SLOT_H)

  // Principal's remark (right) — now reads real data (data.principalRemark,
  // added by migration_tier8_s81_report_card_overhaul.sql) instead of
  // always drawing a blank line.
  const rx = MARGIN + halfW + 4
  doc.setFillColor(248, 250, 252)
  doc.roundedRect(rx, y, halfW, boxH, 1.5, 1.5, 'F')

  doc.setFont(FONT_FAMILY, 'bold')
  doc.setFontSize(7.5)
  doc.setTextColor(107, 114, 128)
  text(doc, "PRINCIPAL'S REMARK", rx + 3, y + 4)

  doc.setFont(FONT_FAMILY, 'normal')
  doc.setFontSize(9)
  const principalRemark = data.principalRemark?.trim()
  if (principalRemark) {
    doc.setTextColor(55, 65, 81)
    wrappedText(doc, principalRemark, rx + 3, y + 10, halfW - 6, 4.1)
  } else {
    doc.setTextColor(180, 180, 180)
    text(doc, '________________________________', rx + 3, y + 10)
  }
  // No separate principal/head-teacher signature source exists in the
  // schema yet (see downloadBatchReportCardPdf's own note) — this side
  // still gets a signature slot drawn, but with no image, it degrades to
  // exactly the blank line this box always used to show.
  drawSignatureBlock(doc, principalSignature, null, rx + 3, y + boxH - SIG_SLOT_H - 2, SIG_SLOT_W, SIG_SLOT_H)

  doc.setTextColor(17, 24, 39)
  return y + boxH + 4
}

/**
 * drawSignatureBlock
 * Draws either an actual signature image (fitted into a fixed slot, with a
 * name label beneath it) or, when no image is available, the same blank
 * underscore line this file always drew — so a school that hasn't uploaded
 * a signature yet sees no regression from before this feature existed.
 */
function drawSignatureBlock(
  doc: jsPDF,
  signature: LoadedImage | null,
  nameLabel: string | null,
  x: number,
  y: number,
  slotW: number,
  slotH: number,
): void {
  if (signature) {
    const { w, h } = fitWithinBox(signature, slotW, slotH)
    safeAddImage(doc, signature, x, y + (slotH - h), w, h)
  }
  doc.setDrawColor(180, 180, 180)
  doc.setLineWidth(0.2)
  doc.line(x, y + slotH + 1, x + slotW, y + slotH + 1)
  if (nameLabel) {
    doc.setFont(FONT_FAMILY, 'normal')
    doc.setFontSize(6.5)
    doc.setTextColor(107, 114, 128)
    text(doc, nameLabel, x, y + slotH + 4.5)
  }
}

// ─── 6b. Admin-configured notice ────────────────────────────────────────────
// Session 81 (owner request) — free-text notice space, admin-configured per
// class+term via report_card_settings. Only rendered when set; a school
// that hasn't configured this yet sees no empty box taking up page space.

function drawNotice(doc: jsPDF, y: number, data: ReportCardData): number {
  const notice = data.settings?.notice?.trim()
  if (!notice) return y

  // Measure line count first (font must be set before getTextWidth-based
  // wrapping runs inside wrappedText, since it measures at whatever font/
  // size is currently active) — this pass only measures, it doesn't draw
  // yet, since the box height depends on the result and must be known
  // before the box itself is painted.
  doc.setFont(FONT_FAMILY, 'normal')
  doc.setFontSize(8.5)
  const lineCount = countWrappedLines(doc, notice, CONTENT_W - 6)
  const boxH = lineCount * 4 + 8

  if (y + boxH > PAGE_H - MARGIN - 20) {
    doc.addPage()
    y = MARGIN
  }

  doc.setFillColor(255, 251, 235) // amber-50 — a notice should read as "pay attention," distinct from the neutral gray boxes elsewhere
  doc.roundedRect(MARGIN, y, CONTENT_W, boxH, 1.5, 1.5, 'F')

  doc.setFont(FONT_FAMILY, 'bold')
  doc.setFontSize(7.5)
  doc.setTextColor(146, 64, 14) // amber-800
  text(doc, 'NOTICE', MARGIN + 3, y + 4)

  doc.setFont(FONT_FAMILY, 'normal')
  doc.setFontSize(8.5)
  doc.setTextColor(120, 53, 15) // amber-900
  wrappedText(doc, notice, MARGIN + 3, y + 9, CONTENT_W - 6, 4)

  doc.setTextColor(17, 24, 39)
  return y + boxH + 3
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

// ─── 7b. Term info: resumption date, next-term fees ─────────────────────────
// Session 81 (owner request) — admin-configured per class+term via
// report_card_settings. Only rendered when at least one of the two fields
// is set; a school that hasn't configured either sees no empty box.

function drawTermInfo(doc: jsPDF, y: number, data: ReportCardData): number {
  const resumptionDate = data.settings?.resumptionDate
  const nextTermFees = data.settings?.nextTermFees
  if (!resumptionDate && nextTermFees == null) return y

  const boxH = 10
  if (y + boxH > PAGE_H - MARGIN - 20) {
    doc.addPage()
    y = MARGIN
  }

  doc.setFillColor(248, 250, 252)
  doc.roundedRect(MARGIN, y, CONTENT_W, boxH, 1.5, 1.5, 'F')

  const parts: string[] = []
  if (resumptionDate) {
    const d = new Date(resumptionDate)
    const formatted = Number.isNaN(d.getTime())
      ? resumptionDate
      : d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
    parts.push(`Next Resumption: ${formatted}`)
  }
  if (nextTermFees != null) {
    parts.push(`Next Term Fees: ₦${nextTermFees.toLocaleString()}`)
  }

  doc.setFont(FONT_FAMILY, 'bold')
  doc.setFontSize(8.5)
  doc.setTextColor(55, 65, 81)
  text(doc, parts.join('     |     '), PAGE_W / 2, y + 6.5, { align: 'center' })

  doc.setTextColor(17, 24, 39)
  return y + boxH + 3
}

// ─── 8. Signature lines ─────────────────────────────────────────────────────

function drawSignatureLines(doc: jsPDF, y: number): void {
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
