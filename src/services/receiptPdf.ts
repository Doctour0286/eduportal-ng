/**
 * receiptPdf.ts
 * SESSION 72 — generates a real, downloadable PDF payment receipt for a
 * single completed payment. Deliberately mirrors transcriptPdf.ts's own
 * conventions rather than inventing a new pattern, per the owner's locked
 * §12 decision ("reuse transcriptPdf.ts's pattern, not a new mechanism")
 * and §3.12's own rule: report cards/receipts/invoices are generated
 * client-side on demand, never stored as files — no generated_documents
 * table, no server-side rendering, no persistence of the PDF itself.
 *
 * Same deliberate departure from printTimetable.ts/printStudentIdCards.ts's
 * window.open()-then-browser-print-dialog pattern that transcriptPdf.ts
 * made: this renders directly to PDF bytes via jsPDF and triggers a real
 * one-tap browser download via doc.save() — no print dialog, no
 * intermediate HTML document, no window.open() at all.
 *
 * No new dependency — jsPDF is already a real dependency as of Session 60b
 * (transcriptPdf.ts). jspdf-autotable is not needed here; a receipt has no
 * tabular row data the way a transcript's course list does, just a small
 * fixed set of label/value lines, so plain doc.text() calls are simpler
 * and sufficient — matching the spirit of "no new dependency for a shape
 * this file doesn't need," rather than pulling in autoTable just because
 * transcriptPdf.ts happens to use it for a genuinely tabular document.
 *
 * Brand-color resolution is copy-pasted from transcriptPdf.ts verbatim
 * (same --color-brand-600/--color-brand-on custom-property read off
 * document.documentElement, same fallback blue) rather than imported,
 * since transcriptPdf.ts doesn't export it — duplicating a ~20-line pure
 * function is preferable here to creating a shared module for one reused
 * helper and touching a file (transcriptPdf.ts) outside this session's
 * own scope just to add an export.
 *
 * Source data: this file performs NO computation and NO Supabase reads of
 * its own. Every field comes from a Payment (financeService.ts, staff-side)
 * or PaymentHistoryRow (portalService.ts, student/guardian-side) object
 * the caller already has in hand — both real, already-fetched shapes, not
 * invented for this file. This mirrors transcriptPdf.ts's own "no new
 * computation, every number already assembled upstream" discipline
 * exactly.
 *
 * React Native note: identical portability shape to transcriptPdf.ts —
 * buildReceiptPdf() itself has no DOM dependency; only resolveBrandColors()
 * (getComputedStyle) and downloadReceiptPdf()'s final doc.save() are
 * browser-only. A future native port passes resolved colors in from a
 * theme context and swaps doc.save() for a Share-sheet write, same as
 * transcriptPdf.ts's own note describes.
 */

import jsPDF from 'jspdf'

// ─── Brand color resolution (verbatim copy of transcriptPdf.ts's own —
// see that file's header comment for why this isn't a shared import) ──────

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

/**
 * Deliberately narrower than Payment/PaymentHistoryRow — only the fields a
 * receipt actually needs to render, so either shape can be passed in
 * without the caller reshaping anything. Both financeService.ts's Payment
 * and portalService.ts's PaymentHistoryRow satisfy this shape directly
 * (structural typing), since every field below is a strict subset of both
 * with matching names/types — confirmed against both real interfaces
 * before writing this, not assumed compatible.
 */
export interface ReceiptPaymentInput {
  id: string
  amount: number
  method: string
  provider_reference: string | null
  paid_at: string | null
  notes: string | null
  fee_head_name: string | null
}

export interface ReceiptPdfOptions {
  schoolName: string
  schoolAddress?: string
  studentName: string
  matricNumber?: string | null
  payment: ReceiptPaymentInput
}

/**
 * Builds the receipt PDF and triggers a real browser download, matching
 * transcriptPdf.ts's downloadTranscriptPdf() exactly in shape. Filename:
 * "<student name> - Receipt - <payment id prefix>.pdf", sanitised.
 *
 * Caller's responsibility to only offer this for a payment whose status
 * is 'completed' — this file trusts paid_at/the passed-in data rather
 * than re-deriving status itself, since neither Payment nor
 * PaymentHistoryRow's narrowed shape above carries status at all (the
 * portal's own loadPaymentHistory() already filters to completed-only
 * server-side; financeService.ts's staff-side callers should apply the
 * same discipline at the call site — flagged here rather than silently
 * assumed).
 */
export function downloadReceiptPdf(opts: ReceiptPdfOptions): void {
  const doc = buildReceiptPdf(opts, resolveBrandColors())
  const safeName = opts.studentName.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '')
  const shortId = opts.payment.id.slice(0, 8)
  doc.save(`${safeName || 'receipt'}-receipt-${shortId}.pdf`)
}

// ─── Document assembly ──────────────────────────────────────────────────────

const PAGE_MARGIN = 14 // mm

function buildReceiptPdf(opts: ReceiptPdfOptions, colors: ResolvedBrandColors): jsPDF {
  const { schoolName, schoolAddress, studentName, matricNumber, payment } = opts
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const pageWidth = doc.internal.pageSize.getWidth()

  let cursorY = drawHeader(doc, pageWidth, schoolName, schoolAddress, colors)
  cursorY = drawReceiptTitle(doc, pageWidth, cursorY, payment, colors)
  cursorY = drawStudentAndPaymentBlock(doc, pageWidth, cursorY, studentName, matricNumber ?? null, payment)
  cursorY = drawAmountBox(doc, pageWidth, cursorY, payment, colors)
  drawFooter(doc, pageWidth)

  return doc
}

function drawHeader(
  doc: jsPDF,
  pageWidth: number,
  schoolName: string,
  schoolAddress: string | undefined,
  colors: ResolvedBrandColors,
): number {
  doc.setFillColor(...colors.brand600)
  doc.rect(0, 0, pageWidth, 22, 'F')

  doc.setTextColor(...colors.brandOn)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(15)
  doc.text(schoolName, PAGE_MARGIN, 12)

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.text(schoolAddress ? schoolAddress : 'Official Payment Receipt', PAGE_MARGIN, 18)

  doc.setTextColor(17, 24, 39)
  return 32
}

function drawReceiptTitle(
  doc: jsPDF,
  pageWidth: number,
  y: number,
  payment: ReceiptPaymentInput,
  colors: ResolvedBrandColors,
): number {
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(13)
  doc.setTextColor(...colors.brand600)
  doc.text('PAYMENT RECEIPT', PAGE_MARGIN, y)

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(75, 85, 99)
  const issuedLabel = `Issued ${new Date().toLocaleDateString(undefined, {
    year: 'numeric', month: 'long', day: 'numeric',
  })}`
  doc.text(issuedLabel, pageWidth - PAGE_MARGIN, y, { align: 'right' })

  doc.setTextColor(17, 24, 39)
  return y + 10
}

function drawStudentAndPaymentBlock(
  doc: jsPDF,
  pageWidth: number,
  y: number,
  studentName: string,
  matricNumber: string | null,
  payment: ReceiptPaymentInput,
): number {
  const colGap = 6
  const colWidth = (pageWidth - PAGE_MARGIN * 2 - colGap) / 2
  const leftX = PAGE_MARGIN
  const rightX = PAGE_MARGIN + colWidth + colGap

  doc.setDrawColor(229, 231, 235)
  doc.setLineWidth(0.3)
  doc.line(PAGE_MARGIN, y, pageWidth - PAGE_MARGIN, y)

  let ly = y + 8
  drawLabelValue(doc, leftX, ly, 'Student', studentName)
  drawLabelValue(doc, rightX, ly, 'Receipt No.', payment.id.slice(0, 8).toUpperCase())
  ly += 10

  drawLabelValue(doc, leftX, ly, 'Matric / Reg. No.', matricNumber ?? '—')
  drawLabelValue(doc, rightX, ly, 'Payment Date', payment.paid_at ? formatDate(payment.paid_at) : 'Pending confirmation')
  ly += 10

  drawLabelValue(doc, leftX, ly, 'Fee', payment.fee_head_name ?? 'Payment')
  drawLabelValue(doc, rightX, ly, 'Method', methodLabel(payment.method))
  ly += 10

  if (payment.provider_reference) {
    drawLabelValue(doc, leftX, ly, 'Reference (RRR)', payment.provider_reference)
    ly += 10
  }

  if (payment.notes) {
    drawLabelValue(doc, leftX, ly, 'Notes', payment.notes, colWidth * 2 + colGap)
    ly += 10
  }

  return ly + 2
}

function drawLabelValue(doc: jsPDF, x: number, y: number, label: string, value: string, maxWidth?: number): number {
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  doc.setTextColor(107, 114, 128)
  doc.text(label.toUpperCase(), x, y)

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(10)
  doc.setTextColor(17, 24, 39)
  const lines = maxWidth ? doc.splitTextToSize(value, maxWidth) : [value]
  doc.text(lines, x, y + 5)
  return y + 5 + lines.length * 4.5
}

function drawAmountBox(
  doc: jsPDF,
  pageWidth: number,
  y: number,
  payment: ReceiptPaymentInput,
  colors: ResolvedBrandColors,
): number {
  const boxHeight = 20
  doc.setFillColor(...colors.brand600)
  doc.roundedRect(PAGE_MARGIN, y, pageWidth - PAGE_MARGIN * 2, boxHeight, 2, 2, 'F')

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(...colors.brandOn)
  doc.text('AMOUNT PAID', PAGE_MARGIN + 4, y + 7)

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(16)
  doc.text(formatNaira(payment.amount), PAGE_MARGIN + 4, y + 15)

  doc.setTextColor(17, 24, 39)
  return y + boxHeight + 8
}

function drawFooter(doc: jsPDF, pageWidth: number): void {
  const pageHeight = doc.internal.pageSize.getHeight()
  doc.setFont('helvetica', 'italic')
  doc.setFontSize(7.5)
  doc.setTextColor(156, 163, 175)
  doc.text(
    'This is a system-generated receipt and is valid without a signature.',
    PAGE_MARGIN,
    pageHeight - 12,
  )
  doc.text('Page 1 of 1', pageWidth - PAGE_MARGIN, pageHeight - 12, { align: 'right' })
}

// ─── Small formatting helpers (kept local rather than imported, matching
// transcriptPdf.ts's own self-contained-file convention — this file has
// no dependency on GuardianPortal.tsx's formatDate/formatNaira/methodLabel
// helpers, which aren't exported from that file anyway) ────────────────────

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
}

function formatNaira(amount: number): string {
  return `₦${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function methodLabel(method: string): string {
  const labels: Record<string, string> = {
    cash: 'Cash',
    bank_transfer: 'Bank Transfer',
    card: 'Card',
    paystack: 'Paystack',
    flutterwave: 'Flutterwave',
    ussd: 'USSD',
    remita: 'Remita',
  }
  return labels[method] ?? method
}
