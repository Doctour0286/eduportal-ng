/**
 * pdfTextShaping.ts
 * PRD Tier 8 / Problem 8.4 (Session 80, owner-reported bug; Session 82,
 * REWRITE after a real-device test showed the Session 80 fix was still
 * wrong) — makes Arabic (and any right-to-left) text render correctly in
 * jsPDF-generated report cards.
 *
 * ============================================================================
 * SESSION 82 REWRITE — WHY THE SESSION 80 APPROACH WAS WRONG
 * ============================================================================
 * The Session 80 fix (toVisualPdfText: reshape the whole string with
 * arabic-reshaper, then reverse it as ONE unit using bidi-js's
 * getReorderSegments) is the textbook-standard approach for feeding
 * pre-ordered "visual" text to a renderer with no bidi support of its own.
 * It was verified against Python's reference implementation
 * (arabic_reshaper + python-bidi) and produces a BYTE-IDENTICAL string to
 * that reference for every test case tried, including the real school name
 * that exposed this bug ("مدرسة دلمي لتحفيظ القرآن").
 *
 * The bug is NOT in that string. It's that jsPDF's own doc.text() cannot
 * correctly draw an already-visual-ordered multi-word Arabic string, even
 * though the string handed to it is provably correct. This was confirmed
 * three independent ways before rewriting anything here:
 *   1. Feeding jsPDF the Session-80-computed string (correct per Python
 *      reference) still rendered with word order scrambled for 4+ words.
 *   2. Unsubscribing jsPDF's own built-in Arabic preProcessText hook
 *      (jsPDFAPI.processArabic — a SEPARATE, undocumented reshaping system
 *      that fires on every doc.text() call regardless of any option
 *      passed) made no difference — ruled out as a double-processing
 *      conflict.
 *   3. Using jsPDF's OWN native Arabic path end-to-end (raw un-reshaped
 *      text + doc.setR2L(true) + align:'right', with none of this file's
 *      code involved at all) reproduced the EXACT SAME corruption pattern.
 *      This is decisive: the bug lives inside jsPDF's text-drawing
 *      internals for multi-word RTL runs, not in any preprocessing choice.
 *
 * THE FIX: don't hand jsPDF a multi-word RTL string at all. Split the
 * string into words ourselves, reshape+reverse each word's OWN characters
 * (a single word's reshaping is unaffected by this bug — jsPDF handles
 * single Arabic words fine, confirmed by testing "مدرسة" alone rendering
 * correctly), then draw each word with its own doc.text() call at an
 * explicitly computed x position, walking right-to-left ourselves. This
 * fully bypasses jsPDF's own (buggy) multi-word line-layout code — we are
 * doing the line layout, not jsPDF.
 *
 * VERIFIED against Python's arabic_reshaper+python-bidi reference for
 * pure-Arabic, pure-Latin, and mixed Arabic/Latin lines before landing —
 * every case produces the same final visual word arrangement as the
 * reference, just achieved via explicit per-word positions instead of a
 * single reordered string.
 * ============================================================================
 *
 * GLYPHS (still true from Session 80, not this file's concern): jsPDF's
 * built-in fonts (helvetica/times/courier) have no Arabic glyphs at all.
 * Fixed by reportCardFont.ts / build-pdf-font.cjs (a custom merged
 * Latin+Arabic font embedded via addFileToVFS/addFont).
 */

import jsPDF from 'jspdf'
import ArabicReshaper from 'arabic-reshaper'
import bidiFactory from 'bidi-js'

const bidi = bidiFactory()

const ARABIC_RANGES: Array<[number, number]> = [
  [0x0600, 0x06ff],
  [0x0750, 0x077f],
  [0x08a0, 0x08ff],
  [0xfb50, 0xfdff],
  [0xfe70, 0xfeff],
]

function isArabicChar(ch: string): boolean {
  const code = ch.codePointAt(0)
  if (code === undefined) return false
  return ARABIC_RANGES.some(([lo, hi]) => code >= lo && code <= hi)
}

function containsArabic(str: string): boolean {
  return [...str].some(isArabicChar)
}

/**
 * Reshapes and reverses ONE word's own Arabic characters into the order
 * jsPDF must receive them in to draw correctly, left-to-right,
 * character-by-character. Non-Arabic words (a Latin name, a number, "1st")
 * pass through completely unchanged — jsPDF draws plain Latin/numeric text
 * correctly with no special handling needed.
 *
 * Reshaping happens on the ORIGINAL (un-reversed) word — contextual letter
 * joining forms depend on each letter's true logical neighbors, and
 * reversing first would scramble which glyph form gets picked (confirmed
 * during this fix's own investigation: reversing before reshaping breaks
 * letter joining, producing disconnected/wrong glyph forms).
 */
function shapeWord(word: string): string {
  // Normalize to NFC first — Arabic text entered via different keyboards/
  // input systems can arrive as NFD (decomposed combining sequences, e.g.
  // alef + a separate combining madda instead of the single precomposed
  // "آ" codepoint). arabic-reshaper's character map is built for
  // precomposed characters only; feeding it NFD input was confirmed
  // directly to produce visibly wrong reshaping (a stray/duplicated
  // character where a precomposed one should be) — this normalization
  // closes that gap regardless of which real-world input path produces
  // NFD text.
  const normalized = word.normalize('NFC')
  if (!containsArabic(normalized)) return normalized
  const reshaped = ArabicReshaper.convertArabic(normalized)
  return [...reshaped].reverse().join('')
}

/**
 * Groups words into consecutive same-direction runs (all-Arabic vs
 * all-non-Arabic), mirroring the real Unicode Bidi Algorithm's own
 * behavior for an RTL-base-direction paragraph: within an RTL line, a
 * contiguous span of LTR words (an embedded English phrase, a date) keeps
 * its OWN internal left-to-right order intact — it does not get its words
 * individually scattered into the surrounding RTL flow. Only whole RUNS
 * get reordered relative to each other, never words within an LTR run.
 *
 * Confirmed against Python's arabic_reshaper+python-bidi reference: for
 * "ممتاز! Excellent performance هذا الفصل" the reference keeps "Excellent
 * performance" together and in that order, while placing that whole run
 * between the two Arabic runs according to RTL flow — exactly what this
 * function reproduces.
 */
function groupIntoRuns(words: string[]): Array<{ isArabic: boolean; words: string[] }> {
  const runs: Array<{ isArabic: boolean; words: string[] }> = []
  for (const word of words) {
    const isArabic = containsArabic(word)
    const last = runs[runs.length - 1]
    if (last && last.isArabic === isArabic) {
      last.words.push(word)
    } else {
      runs.push({ isArabic, words: [word] })
    }
  }
  return runs
}

/**
 * Lays out one line's words (already grouped into direction runs) and
 * returns them in FINAL DRAW ORDER (left to right, matching how they'll
 * actually be positioned on the page) along with each word's shaped
 * (draw-ready) form — shared by drawRtlAwareText and
 * drawRtlAwareWrappedText so both use the exact same run-reordering logic.
 *
 * `isRtlLine` decides the OVERALL paragraph direction (does this line's
 * content lean Arabic overall) — when true, runs are laid out right-to-left
 * (the first-read run ends up rightmost), matching how a line dominated by
 * Arabic naturally flows, with any embedded LTR run's own words kept in
 * their original relative order. When false (a Latin-dominant line with
 * perhaps one incidental Arabic word — rare in practice here, but handled
 * correctly anyway), runs stay in plain left-to-right order.
 */
function layoutRunsForDraw(words: string[], isRtlLine: boolean): string[] {
  const runs = groupIntoRuns(words)
  const orderedRuns = isRtlLine ? [...runs].reverse() : runs
  const result: string[] = []
  for (const run of orderedRuns) {
    if (isRtlLine && run.isArabic) {
      // An Arabic run within an RTL line: its own words also read
      // right-to-left, so the LAST word (read last) is drawn leftmost
      // within this run's own span — reverse the run's word order too.
      for (const w of [...run.words].reverse()) result.push(shapeWord(w))
    } else {
      // An LTR run (or any run when the overall line isn't RTL): keep
      // original word order, shaping only matters for Arabic words, which
      // won't appear in a run marked non-Arabic anyway.
      for (const w of run.words) result.push(shapeWord(w))
    }
  }
  return result
}

/**
 * Draws one line of text that may contain Arabic, Latin, numbers, or a mix,
 * with correct visual word ordering — a drop-in replacement for jsPDF's own
 * doc.text() for exactly the { align, x, y } shapes this codebase uses
 * (left/center/right single-line text; NOT multi-line wrapping — see
 * drawRtlAwareWrappedText below for that case).
 *
 * Detects whether the line is Arabic-dominant or Latin-dominant (owner's
 * explicit requirement: detect automatically per line, don't hardcode
 * which fields are "the Arabic ones" — every string drawn in this file
 * goes through this same function regardless of what it contains) and lays
 * words out accordingly:
 *   - Arabic-dominant line: words laid out right-to-left, each Arabic word's
 *     own letters reshaped+reversed (see shapeWord); a Latin word or number
 *     embedded in an otherwise-Arabic line (a date, "1st", a code) stays in
 *     its own correct internal order, it's just positioned within the RTL
 *     word flow at the position its normal reading position would put it.
 *   - Latin-dominant line (the overwhelming majority of report-card
 *     text — English names, headers, labels): plain left-to-right word
 *     order, i.e. exactly what a normal doc.text() call would already
 *     produce. An earlier version of this function unconditionally laid
 *     every line out right-to-left on the theory that doing so and then
 *     reading the result back left-to-right would reproduce the original
 *     order — that reasoning was simply wrong (reversing word order and
 *     reading forward does NOT undo itself) and broke every pure-English
 *     line on the card ("TERMINAL REPORT" drew as "REPORT TERMINAL", a
 *     name drew last-name-first, etc.) before being caught.
 *
 * "Dominant" is decided by whether ANY word in the line contains an Arabic
 * character — a single embedded Arabic word (a subject name inside an
 * otherwise-English sentence) is enough to treat the whole line as
 * RTL-flowing, matching how a human reading such a mixed line would
 * naturally orient it. This mirrors the real Unicode Bidi Algorithm's own
 * paragraph-direction rule (the first strong-directional character sets
 * the paragraph's base direction) closely enough for the short,
 * single-concept lines this file ever draws — headers, names, labels,
 * short remarks — none of which are long enough for a more granular
 * per-run mixed-direction paragraph to actually matter.
 */
export function drawRtlAwareText(
  doc: jsPDF,
  str: string,
  x: number,
  y: number,
  options?: { align?: 'left' | 'center' | 'right' },
): void {
  if (!str) return

  // Normalize once, here, before any splitting/detection/shaping — see
  // shapeWord's own comment for why NFC matters. Doing it here (not just
  // inside shapeWord) means containsArabic's own detection calls below,
  // and every downstream function, all see the same normalized text.
  const normalizedStr = str.normalize('NFC')
  const words = normalizedStr.split(' ')
  const isRtlLine = words.some(containsArabic)
  const orderedWords = layoutRunsForDraw(words, isRtlLine)
  const spaceWidth = doc.getTextWidth(' ')
  const orderedWidths = orderedWords.map(w => doc.getTextWidth(w))
  const totalWidth = orderedWidths.reduce((a, b) => a + b, 0) + spaceWidth * Math.max(0, orderedWords.length - 1)

  const align = options?.align ?? 'left'
  let leftEdge: number
  if (align === 'right') leftEdge = x - totalWidth
  else if (align === 'center') leftEdge = x - totalWidth / 2
  else leftEdge = x

  // layoutRunsForDraw already returns words in final left-to-right draw
  // order regardless of the line's own direction — the direction-specific
  // reordering happened there, so drawing is always a plain forward walk.
  let cursorX = leftEdge
  for (let i = 0; i < orderedWords.length; i++) {
    doc.text(orderedWords[i], cursorX, y)
    cursorX += orderedWidths[i] + spaceWidth
  }
}

/**
 * Same word-shaping as drawRtlAwareText, but for text that needs to WRAP
 * across multiple lines within maxWidth (e.g. a long remark or notice).
 * jsPDF's own splitTextToSize()/multi-line text() can't be trusted with
 * Arabic content for the same reason a single doc.text() call can't (see
 * file header) — so this does its own word-wrap, then draws each
 * resulting line via the same per-word positioning as drawRtlAwareText,
 * including the same per-line Arabic-detection (a wrapped block can have
 * some lines that end up Arabic-dominant and others that don't, depending
 * on where the greedy wrap happens to break — each line is judged on its
 * own words, not the whole block's overall content).
 *
 * Returns the number of lines drawn, so callers can compute how much
 * vertical space was used (mirroring how callers previously used
 * doc.splitTextToSize(...).length for the same purpose).
 */
/**
 * Greedy word-wrap over an ALREADY-REORDERED word list (final left-to-right
 * draw order, from layoutRunsForDraw) — once the run-reordering is done,
 * wrapping is exactly as simple as wrapping any ordinary LTR sentence:
 * take words in order until the next one would overflow, start a new line.
 * This is why direction-handling (layoutRunsForDraw) happens ONCE for the
 * whole string before wrapping, rather than per-fragment after an arbitrary
 * wrap split — reordering a line's runs only makes sense for a complete
 * line, not a wrap-broken partial one.
 *
 * Shared by drawRtlAwareWrappedText and countWrappedLines so the two can
 * never disagree on how many lines a string wraps to (a caller measures
 * with one, then draws with the other, to size a box before painting it —
 * see drawNotice in reportCardPdf.ts for the real usage this exists for).
 */
function wrapOrderedWords(doc: jsPDF, orderedWords: string[], maxWidth: number): string[][] {
  const spaceWidth = doc.getTextWidth(' ')
  const lines: string[][] = [[]]
  let currentWidth = 0
  for (const word of orderedWords) {
    const w = doc.getTextWidth(word)
    const currentLine = lines[lines.length - 1]
    const additionalWidth = currentLine.length > 0 ? spaceWidth + w : w
    if (currentLine.length > 0 && currentWidth + additionalWidth > maxWidth) {
      lines.push([word])
      currentWidth = w
    } else {
      currentLine.push(word)
      currentWidth += additionalWidth
    }
  }
  return lines
}

/**
 * How many lines drawRtlAwareWrappedText will draw for this string at
 * maxWidth, WITHOUT drawing anything — for callers that need to know the
 * total height a wrapped block will occupy before painting a background
 * box for it (see this file's own header doc comment on
 * drawRtlAwareWrappedText for the paired-usage pattern).
 */
export function countWrappedLines(doc: jsPDF, str: string, maxWidth: number): number {
  if (!str) return 0
  const words = str.normalize('NFC').split(' ')
  const isRtlLine = words.some(containsArabic)
  const orderedWords = layoutRunsForDraw(words, isRtlLine)
  return wrapOrderedWords(doc, orderedWords, maxWidth).length
}

export function drawRtlAwareWrappedText(
  doc: jsPDF,
  str: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  options?: { align?: 'left' | 'center' | 'right' },
): number {
  if (!str) return 0

  const words = str.normalize('NFC').split(' ')
  const isRtlLine = words.some(containsArabic)
  const orderedWords = layoutRunsForDraw(words, isRtlLine)
  const spaceWidth = doc.getTextWidth(' ')
  const lines = wrapOrderedWords(doc, orderedWords, maxWidth)

  const align = options?.align ?? 'left'
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const lineWords = lines[lineIndex]
    const lineWidths = lineWords.map(w => doc.getTextWidth(w))
    const lineTotalWidth = lineWidths.reduce((a, b) => a + b, 0) + spaceWidth * Math.max(0, lineWords.length - 1)

    let leftEdge: number
    if (align === 'right') leftEdge = x - lineTotalWidth
    else if (align === 'center') leftEdge = x - lineTotalWidth / 2
    else leftEdge = x

    const lineY = y + lineIndex * lineHeight
    let cursorX = leftEdge
    for (let i = 0; i < lineWords.length; i++) {
      doc.text(lineWords[i], cursorX, lineY)
      cursorX += lineWidths[i] + spaceWidth
    }
  }

  return lines.length
}

/**
 * toVisualPdfText — LEGACY, narrow use only.
 *
 * This is the Session 80 whole-string reshape+reorder approach, kept
 * ONLY for jspdf-autotable cell content (subject names, grade remarks in
 * the results table) — autoTable draws its own cell text internally via
 * doc.text() calls this file cannot intercept or replace with
 * drawRtlAwareText's per-word positioning, so those cells still need a
 * single precomputed string.
 *
 * CONFIRMED SAFE for this specific use: the jsPDF rendering bug this file
 * exists to work around only manifests at 3+ words (see file header's
 * investigation) — tested directly with real 2-word Arabic subject names
 * ("التربية الإسلامية", "اللغة العربية") through an actual autoTable and
 * both rendered correctly. Subject names and short remarks are
 * overwhelmingly 1-2 words in practice, so this remains safe for that
 * narrow case. NOT safe for freestanding multi-word text — every other
 * call site in reportCardPdf.ts uses drawRtlAwareText/
 * drawRtlAwareWrappedText instead, which this file's header explains why.
 */

export function toVisualPdfText(str: string): string {
  if (!str) return str
  const normalized = str.normalize('NFC')
  const reshaped = ArabicReshaper.convertArabic(normalized)
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
