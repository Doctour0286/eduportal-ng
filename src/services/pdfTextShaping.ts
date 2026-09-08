/**
 * pdfTextShaping.ts
 * PRD Tier 8 / Problem 8.4 (Session 80, owner-reported bug) — makes Arabic
 * (and any right-to-left) text render correctly in jsPDF-generated report
 * cards, instead of the garbled mojibake previously produced whenever a
 * field (most commonly the school name) contained non-Latin characters.
 *
 * ROOT CAUSE: jsPDF has no complex-text-layout (shaping/bidi) engine. Its
 * doc.text() draws whatever codepoints it's given, left-to-right, glyph by
 * glyph, using whichever font is currently set. Two separate things were
 * therefore broken for Arabic specifically, and this file fixes both:
 *
 *   1. GLYPHS: jsPDF's built-in fonts (helvetica/times/courier) only cover
 *      the WinAnsi character set — no Arabic glyphs at all. Fixed by
 *      reportCardFont.ts / build-pdf-font.cjs (a custom merged Latin+Arabic
 *      font embedded via addFileToVFS/addFont) — NOT this file's concern.
 *
 *   2. SHAPING + ORDER: even with the right glyphs available, Arabic letters
 *      change shape depending on their position in a word (isolated/
 *      initial/medial/final — the same "alef" looks different at the start
 *      of a word than in the middle), and Arabic reads right-to-left while
 *      numbers and any embedded Latin text still read left-to-right. This
 *      file's toVisualPdfText() runs both passes — arabic-reshaper picks the
 *      correct contextual glyph forms, bidi-js's getReorderSegments()
 *      resolves the Unicode Bidirectional Algorithm's per-character
 *      embedding levels and returns which runs need reversing — before the
 *      text is ever handed to jsPDF, which then just draws the result
 *      left-to-right same as any other string. This two-step "shape then
 *      reorder" pipeline is the standard workaround wherever a renderer
 *      (canvas, PDF, etc.) lacks its own bidi/shaping support; verified
 *      end-to-end against a rendered, rasterized test PDF before landing.
 *
 * Pure-Latin strings (the overwhelming majority of report-card fields —
 * student names, subjects, remarks) pass through both libraries as
 * no-ops, so this is always safe to call unconditionally rather than
 * branching on script detection first.
 */

import ArabicReshaper from 'arabic-reshaper'
import bidiFactory from 'bidi-js'

const bidi = bidiFactory()

/**
 * Prepares a string for left-to-right drawing by a renderer with no bidi/
 * shaping support of its own (jsPDF's doc.text()). Safe to call on any
 * string — pure Latin/numeric text passes through unchanged.
 */
export function toVisualPdfText(text: string): string {
  if (!text) return text

  // Step 1: reshape Arabic letters into their contextual presentation
  // forms. No-op for any string with no Arabic-block characters.
  const reshaped = ArabicReshaper.convertArabic(text)

  // Step 2: resolve bidi embedding levels, then reverse each run bidi-js
  // flags as needing reversal (RTL runs) so the final string draws
  // correctly left-to-right, character by character, exactly as jsPDF's
  // doc.text() expects. A pure-LTR string yields zero flip ranges.
  const embeddingLevels = bidi.getEmbeddingLevels(reshaped)
  const flips = bidi.getReorderSegments(reshaped, embeddingLevels)
  if (flips.length === 0) return reshaped

  const chars = [...reshaped]
  for (const [start, end] of flips) {
    let s = start
    let e = end
    while (s < e) {
      const tmp = chars[s]
      chars[s] = chars[e]
      chars[e] = tmp
      s++
      e--
    }
  }
  return chars.join('')
}
