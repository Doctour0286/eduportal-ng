#!/usr/bin/env node
/**
 * build-pdf-font.cjs
 *
 * Generates src/assets/fonts/reportCardFont.ts — a single base64-embedded
 * TTF font (regular + bold) covering Latin, Arabic, and the Naira sign (₦),
 * for use in reportCardPdf.ts via jsPDF's addFileToVFS/addFont.
 *
 * WHY THIS EXISTS (Session 80, owner-reported bug):
 * jsPDF's built-in fonts (helvetica/times/courier) only support the WinAnsi
 * character set — essentially Latin + a handful of symbols. Any school whose
 * name, or any other report-card field, contains Arabic script (owner
 * confirmed: "some schools use Arabic") rendered as garbled repeating bytes
 * (mojibake, visually like "þåþ•þ®...") because jsPDF was asked to draw
 * codepoints its font has no glyph for and silently substituted garbage.
 *
 * jsPDF has no complex-text-layout engine of its own — Arabic must be
 * (a) reshaped into its contextual joined presentation forms and
 * (b) reordered into visual (LTR-drawing) order via the Unicode
 * Bidirectional Algorithm BEFORE being handed to doc.text(). See
 * reportCardPdf.ts's `toVisualArabic()` for that half of the fix — this
 * script only produces the font those shaped glyphs are drawn with.
 *
 * Google's Noto Sans / Noto Sans Arabic are shipped as disjoint per-script
 * subsets (confirmed by inspection: the "arabic" subset has .notdef for
 * every Latin letter/digit, and vice versa) — there is no single upstream
 * file with both. This script merges them at the glyph level with
 * fonteditor-core into one physical font, plus manually splices in the
 * Naira sign (₦, U+20A6) from Noto Sans's latin-ext subset, since the Naira
 * glyph isn't in either the base Latin or the Arabic subset and a naive
 * merge of the whole latin-ext subset collides on shared codepoints (space,
 * etc.) that fonteditor-core's merge() rejects as duplicates.
 *
 * Run manually whenever the font needs regenerating (Fontsource version
 * bump, wanting a different script/weight, etc.) — this is NOT run as part
 * of the normal build, since its output (reportCardFont.ts) is committed:
 *
 *   npm run build:pdf-font
 *
 * Requires (devDependencies): wawoff2, opentype.js, fonteditor-core,
 * @fontsource/noto-sans, @fontsource/noto-sans-arabic.
 */

const fs = require('fs')
const path = require('path')
const wawoff2 = require('wawoff2')
const fc = require('fonteditor-core')

const FONTSOURCE = path.join(__dirname, '..', 'node_modules', '@fontsource')
const OUT_DIR = path.join(__dirname, '..', 'src', 'assets', 'fonts')
const OUT_FILE = path.join(OUT_DIR, 'reportCardFont.ts')
const NAIRA_CODE = 0x20a6 // ₦

async function woff2ToTtfBuffer(woff2Path) {
  const compressed = fs.readFileSync(woff2Path)
  const ttf = await wawoff2.decompress(compressed)
  return Buffer.from(ttf)
}

function loadFcFont(ttfBuffer) {
  return fc.Font.create(ttfBuffer, { type: 'ttf', hinting: true, compound2simple: true })
}

/**
 * Builds one merged weight: base Latin + Arabic (glyph-merged), with the
 * Naira glyph manually spliced in from the latin-ext subset (avoids the
 * duplicate-unicode collision a full latin-ext merge would hit).
 */
async function buildWeight(weight) {
  const latinPath = path.join(FONTSOURCE, 'noto-sans', 'files', `noto-sans-latin-${weight}-normal.woff2`)
  const latinExtPath = path.join(FONTSOURCE, 'noto-sans', 'files', `noto-sans-latin-ext-${weight}-normal.woff2`)
  const arabicPath = path.join(FONTSOURCE, 'noto-sans-arabic', 'files', `noto-sans-arabic-arabic-${weight}-normal.woff2`)

  // Sequential, not Promise.all: wawoff2's decompress() is backed by a
  // single shared WASM instance that is NOT safely reentrant — running
  // multiple decompressions concurrently corrupts their output buffers
  // (confirmed by testing: concurrent calls threw "ttf file damaged" on
  // buffers that decompress perfectly fine one at a time).
  const latinTtf = await woff2ToTtfBuffer(latinPath)
  const latinExtTtf = await woff2ToTtfBuffer(latinExtPath)
  const arabicTtf = await woff2ToTtfBuffer(arabicPath)

  const latinExtFont = loadFcFont(latinExtTtf)
  const nairaGlyf = latinExtFont.get().glyf.find(g => g.unicode && g.unicode.includes(NAIRA_CODE))
  if (!nairaGlyf) throw new Error(`Naira glyph (U+20A6) not found in latin-ext ${weight} subset`)

  const base = loadFcFont(latinTtf)
  const arabic = loadFcFont(arabicTtf)
  base.merge(arabic, { scale: 1 })

  const mergedTtf = base.get()
  mergedTtf.glyf.push(Object.assign({}, nairaGlyf, { name: 'naira' }))

  return base.write({ type: 'ttf', hinting: true })
}

async function main() {
  console.log('Building merged Latin+Arabic+Naira report-card font…')

  // Sequential for the same reason as woff2ToTtfBuffer's own comment above —
  // each buildWeight() call decompresses multiple woff2 files internally.
  const regular = await buildWeight('400')
  const bold = await buildWeight('700')

  const regularB64 = Buffer.from(regular).toString('base64')
  const boldB64 = Buffer.from(bold).toString('base64')

  fs.mkdirSync(OUT_DIR, { recursive: true })
  const content = `/**
 * reportCardFont.ts — GENERATED FILE, do not hand-edit.
 * Produced by scripts/build-pdf-font.cjs — see that file for the full
 * rationale (Session 80: jsPDF's built-in fonts can't render Arabic, and
 * Google's Noto Sans / Noto Sans Arabic ship as disjoint script subsets
 * with no merged file upstream, so this repo builds and commits its own).
 *
 * Regenerate with: npm run build:pdf-font
 *
 * Covers: Latin (incl. accented characters used in Nigerian names),
 * Arabic (all contextual presentation forms via arabic-reshaper), and the
 * Naira sign (₦, U+20A6, spliced in from Noto Sans's latin-ext subset).
 */

export const REPORT_CARD_FONT_REGULAR_BASE64 = '${regularB64}'
export const REPORT_CARD_FONT_BOLD_BASE64 = '${boldB64}'
`
  fs.writeFileSync(OUT_FILE, content)
  console.log(`Wrote ${OUT_FILE}`)
  console.log(`  regular: ${(regular.length / 1024).toFixed(1)} KB TTF -> ${(regularB64.length / 1024).toFixed(1)} KB base64`)
  console.log(`  bold:    ${(bold.length / 1024).toFixed(1)} KB TTF -> ${(boldB64.length / 1024).toFixed(1)} KB base64`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
