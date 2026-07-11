/**
 * printStudentIdCards.ts
 * Pure student-ID-card print utility. No React, no Supabase calls — takes
 * already-loaded data (mirrors printTimetable.ts's own contract: the caller
 * has already fetched everything via studentsService.ts; this file issues
 * no query of its own).
 *
 * Card layout (owner-supplied reference design, 2026-07-10): standard CR80
 * ID card size, 3.375in × 2.125in (85.60mm × 54.00mm), landscape. Left
 * ~35% is a full-bleed student photo in a bordered box; right ~65% is a
 * header (logo + school name/address), a solid-color "STUDENT CARD" label
 * band, then labeled NAME/CLASS/ID NO rows, with a barcode-style rendering
 * of the student code along the bottom. One card per student, laid out in
 * a print-safe grid (2 per row on A4/Letter portrait, with cut-guide
 * dashed borders — the reference design assumes cards are cut apart after
 * printing, not physically perforated).
 *
 * "Sync with school custom colour" (owner's explicit ask): the header band
 * and photo-box border use the school's real brand color — resolved from
 * the live CSS custom properties `themeService.ts`'s applyBrandTheme()
 * already injects onto document.documentElement (--color-brand-600 for
 * the fill, --color-brand-on for contrast-safe text on top of it — see
 * that file's WCAG-contrast-derived on/on700/on800 fields, master plan
 * §11 Session 23/24). This print document is a fully detached window (see
 * printTimetable.ts's and HRModule.tsx's own print windows) with no access
 * to the main page's stylesheet or its CSS variables once opened, so the
 * *resolved* color values are read here, in the main page, at call time,
 * and passed into the generated HTML as literal hex/rgb strings — not as
 * `var(--color-brand-600)` references, which would silently resolve to
 * nothing in the isolated document.
 *
 * printStudentIdCards(opts) builds a self-contained HTML document and
 * opens it via Blob → URL.createObjectURL → window.open(url) — the same
 * approach printTimetable.ts uses, for the same reason: document.write()
 * on a blank window.open('') is silently blocked by Android Chrome's
 * cross-origin sandbox restriction, but a Blob URL is same-origin to the
 * creating page and loads reliably. The object URL is revoked after 60s.
 * A window.addEventListener('load', () => window.print()) in the
 * generated page auto-triggers the print dialog.
 *
 * Platform note: window.open and getComputedStyle are the only
 * browser-only calls — on a React Native port, replace window.open with
 * expo-print/react-native-print, and pass resolved brand colors in
 * directly (e.g. from a theme context) rather than reading the DOM.
 * buildIdCardPayload() itself, given already-resolved colors, is fully
 * portable.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface IdCardStudent {
  id: string
  full_name: string
  class_path_label: string | null
  student_code: string | null
  /** Resolved, directly-renderable photo URL (signed URL from
   *  getStudentPhotoSignedUrl(), already resolved by the caller) — never a
   *  raw Storage path. Null falls back to initials, same convention as the
   *  rest of the Students module. */
  photo_url: string | null
}

export interface PrintStudentIdCardsOptions {
  schoolName: string
  /** Optional — shown under the school name in the card header if provided. */
  schoolAddress?: string
  /** schools.logo_url (already resolved to a directly-renderable URL —
   *  public bucket per §3.13, unlike student photos which are private and
   *  need signing). Null/omitted falls back to a plain text header with no
   *  logo mark, same "graceful when the data isn't there" convention as
   *  the student photo's initials fallback. */
  schoolLogoUrl?: string | null
  students: IdCardStudent[]
}

// ─── Public entry point ────────────────────────────────────────────────────

/**
 * Builds the ID card HTML document and opens it in a new tab, auto-triggering
 * the print dialog. Browser-only (window.open, getComputedStyle) — see
 * platform note above.
 */
export function printStudentIdCards(opts: PrintStudentIdCardsOptions): void {
  const html = buildIdCardPayload(opts, resolveBrandColors())
  const blob = new Blob([html], { type: 'text/html' })
  const url = URL.createObjectURL(blob)

  window.open(url, '_blank')

  // Same 60s revoke window as printTimetable.ts — long enough for the new
  // tab to finish loading and print, short enough not to leak memory if the
  // tab is left open.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

// ─── Brand color resolution (browser-only half) ────────────────────────────

export interface ResolvedBrandColors {
  /** School's brand color fill, e.g. for the "STUDENT CARD" band and the
   *  photo-box border. Falls back to this app's own converged default blue
   *  (#2563eb — see index.css's :root and the master plan's "Option A"
   *  decision) if the live custom property isn't set for some reason. */
  brand600: string
  /** Contrast-safe text color for content sitting on top of brand600 —
   *  never assumed white, matches themeService.ts's own WCAG-measured
   *  --color-brand-on. */
  brandOn: string
}

const FALLBACK_BRAND_600 = '#2563eb'
const FALLBACK_BRAND_ON = '#ffffff'

/**
 * Reads the live, already-injected brand custom properties off
 * document.documentElement — the same values applyBrandTheme() sets at
 * app boot and on Settings save. Never recomputes the derived scale itself
 * (that's themeService.ts's job); this just reads what's already there.
 */
function resolveBrandColors(): ResolvedBrandColors {
  const styles = getComputedStyle(document.documentElement)
  const brand600 = styles.getPropertyValue('--color-brand-600').trim() || FALLBACK_BRAND_600
  const brandOn = styles.getPropertyValue('--color-brand-on').trim() || FALLBACK_BRAND_ON
  return { brand600, brandOn }
}

// ─── Payload builder (portable — no browser APIs) ──────────────────────────

/**
 * Builds the full HTML document string. Pure — no window/document access —
 * so this half of the file ports cleanly to a future React Native
 * implementation even though printStudentIdCards() itself does not. Colors
 * are passed in already-resolved (see ResolvedBrandColors above) rather
 * than read here.
 */
export function buildIdCardPayload(
  opts: PrintStudentIdCardsOptions,
  colors: ResolvedBrandColors,
): string {
  const generatedDate = new Date().toLocaleDateString(undefined, {
    year: 'numeric', month: 'long', day: 'numeric',
  })

  const cards = opts.students.map(s => buildCardHtml(opts, s)).join('\n')

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escHtml(opts.schoolName)} — Student ID Cards</title>
<style>
  /* CR80 card size: 3.375in × 2.125in (85.60mm × 54.00mm), landscape.
     Printed 2-up on A4/Letter portrait with a small gutter and dashed cut
     guides — owner's reference design assumes cutting cards apart after
     printing, not a perforated/pre-cut stock. */
  @page { size: A4 portrait; margin: 10mm; }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
    margin: 0;
    padding: 0;
    color: #111827;
    background: #fff;
  }
  .idc-meta {
    padding: 0 0 4mm;
    font-size: 10px;
    color: #6b7280;
    text-align: right;
  }
  .idc-grid {
    display: grid;
    grid-template-columns: repeat(2, 3.375in);
    gap: 6mm;
    justify-content: center;
  }
  .idc-card {
    width: 3.375in;
    height: 2.125in;
    display: flex;
    border: 1px dashed #9ca3af;
    border-radius: 4px;
    overflow: hidden;
    page-break-inside: avoid;
    break-inside: avoid;
    background: #fff;
  }
  .idc-photo-col {
    flex: 0 0 34%;
    height: 100%;
    border-right: 3px solid ${escHtml(colors.brand600)};
    overflow: hidden;
  }
  .idc-photo {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .idc-photo-fallback {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #e5e7eb;
    font-size: 28px;
    font-weight: 700;
    color: #6b7280;
  }
  .idc-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    padding: 3mm 3mm 2mm;
    gap: 1.5mm;
  }
  .idc-header {
    display: flex;
    align-items: center;
    gap: 2mm;
  }
  .idc-logo {
    flex: 0 0 auto;
    width: 8mm;
    height: 8mm;
    object-fit: contain;
  }
  .idc-header-text {
    min-width: 0;
    flex: 1;
  }
  .idc-school-name {
    font-size: 8.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.02em;
    color: #111827;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .idc-school-address {
    font-size: 6.5px;
    color: #6b7280;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .idc-band {
    display: inline-block;
    align-self: flex-start;
    background: ${escHtml(colors.brand600)};
    color: ${escHtml(colors.brandOn)};
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    padding: 1mm 3mm;
    border-radius: 0 4mm 4mm 0;
    margin: 0.5mm 0;
  }
  .idc-fact-row {
    display: flex;
    gap: 1.5mm;
    font-size: 8px;
    line-height: 1.3;
  }
  .idc-fact-label {
    flex: 0 0 auto;
    width: 13mm;
    color: #6b7280;
    text-transform: uppercase;
    letter-spacing: 0.02em;
  }
  .idc-fact-value {
    flex: 1;
    min-width: 0;
    font-weight: 700;
    color: #111827;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .idc-code-block {
    margin-top: auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5mm;
  }
  .idc-barcode {
    width: 100%;
    height: 7mm;
  }
  .idc-code-text {
    font-size: 6.5px;
    letter-spacing: 0.08em;
    color: #374151;
    font-family: monospace;
  }
  @media print {
    .idc-meta { display: none; }
    .idc-card { border-color: #d1d5db; }
  }
</style>
</head>
<body>
  <div class="idc-meta">Generated ${escHtml(generatedDate)}</div>
  <div class="idc-grid">
${cards}
  </div>
  <script>
    window.addEventListener('load', function () { window.print(); });
  </script>
</body>
</html>`
}

// ─── Internal helpers ───────────────────────────────────────────────────────

function buildCardHtml(
  opts: PrintStudentIdCardsOptions,
  s: IdCardStudent,
): string {
  const photoBlock = s.photo_url
    ? `<img class="idc-photo" src="${escHtml(s.photo_url)}" alt="" />`
    : `<div class="idc-photo-fallback">${escHtml(initials(s.full_name))}</div>`

  const logoBlock = opts.schoolLogoUrl
    ? `<img class="idc-logo" src="${escHtml(opts.schoolLogoUrl)}" alt="" />`
    : ''

  const addressLine = opts.schoolAddress
    ? `<div class="idc-school-address">${escHtml(opts.schoolAddress)}</div>`
    : ''

  const code = s.student_code ?? '—'
  const barcodeBlock = s.student_code
    ? buildBarcodeSvg(s.student_code)
    : ''

  return `    <div class="idc-card">
      <div class="idc-photo-col">
        ${photoBlock}
      </div>
      <div class="idc-body">
        <div class="idc-header">
          ${logoBlock}
          <div class="idc-header-text">
            <div class="idc-school-name">${escHtml(opts.schoolName)}</div>
            ${addressLine}
          </div>
        </div>
        <span class="idc-band">Student card</span>
        <div class="idc-fact-row">
          <span class="idc-fact-label">Name</span>
          <span class="idc-fact-value">${escHtml(s.full_name)}</span>
        </div>
        <div class="idc-fact-row">
          <span class="idc-fact-label">Class</span>
          <span class="idc-fact-value">${escHtml(s.class_path_label ?? '—')}</span>
        </div>
        <div class="idc-fact-row">
          <span class="idc-fact-label">ID no.</span>
          <span class="idc-fact-value">${escHtml(code)}</span>
        </div>
        <div class="idc-code-block">
          ${barcodeBlock}
          <span class="idc-code-text">${escHtml(code)}</span>
        </div>
      </div>
    </div>`
}

/**
 * Renders a CODE39-pattern-*styled* SVG barcode — visually matches the
 * reference design's barcode strip, but this is a decorative/illustrative
 * bar pattern derived deterministically from the code's characters, not a
 * scannable CODE39/CODE128 encoding. A real scannable barcode needs a
 * proper encoding library (e.g. JsBarcode) which isn't a dependency of
 * this project; flagged here rather than silently shipped as if it were
 * scannable. If real barcode scanning is needed, this is the function to
 * replace.
 */
function buildBarcodeSvg(code: string): string {
  const bars: string[] = []
  let x = 0
  for (let i = 0; i < code.length; i++) {
    const charCode = code.charCodeAt(i)
    // Deterministic per-character bar width (2-5px) and gap (1-3px) —
    // visually varied like a real barcode, stable for the same code.
    const barWidth = 2 + (charCode % 4)
    const gap = 1 + (charCode % 3)
    bars.push(`<rect x="${x}" y="0" width="${barWidth}" height="26" fill="#1f2937" />`)
    x += barWidth + gap
  }
  return `<svg class="idc-barcode" viewBox="0 0 ${x} 26" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">${bars.join('')}</svg>`
}

function initials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase()
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase()
}

/** Sanitises all user-supplied strings before interpolation into the
 *  generated HTML document — same helper name/contract as printTimetable.ts. */
function escHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
