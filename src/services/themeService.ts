/**
 * themeService.ts
 * PRD Session 23 (Tier 6, Problem 6.1 — token architecture port).
 *
 * Root cause this file fixes: `--color-brand-600` (the school's admin-picked
 * theme color, set live by SettingsModule.tsx via `document.documentElement
 * .style.setProperty(...)`) was never actually declared in :root — every one
 * of its ~170 uses across index.css was a bare `var(--color-brand-600, #hex)`
 * fallback, and those fallbacks disagreed with each other (48 sites assumed
 * blue #2563eb, 11 sites assumed green #16a34a). So admin-set brand colors
 * only ever partially "took," inconsistently, depending on which file wrote
 * which rule — this is the direct cause of Problem 6.1's "school theme
 * colors show no visible difference."
 *
 * This file does NOT hardcode a single "safe" partner color that's assumed
 * to look fine next to any brand hue — research done for this session found
 * no such fixed color exists (Tailwind's own maintainers hand-tune every
 * default scale; there is no formula-only shortcut). Instead, matching the
 * pattern used by real theming engines (Adobe Leonardo, Confrere's runtime
 * palette generator), the full brand scale is DERIVED from whatever hex the
 * admin actually picked, at the moment they pick it:
 *   - Tints (50-400): brand color mixed toward white.
 *   - Shades (700-800): brand color mixed toward black.
 *   - 500/600: the admin's picked color itself (clamped — see below).
 *   - --color-brand-on: whichever of pure black/white gives higher real
 *     WCAG contrast against the picked color, computed per-school, not
 *     assumed to be white the way most hardcoded designs assume.
 *
 * LEGIBILITY GUARD (the one non-optional deviation from "use their exact
 * hex everywhere"): --color-brand-600 is used throughout index.css as
 * actual body-sized text color and as a solid button background with text
 * on top (grep confirmed: `color:`, `background:`, `border-color:` are the
 * three dominant roles, 65+58+28 occurrences). A school could pick a pale
 * gold, cream, or bright yellow as their brand color — verified directly:
 * #c49a1a, #f5e199, and #eab308 all land between 1.3:1 and 2.6:1 contrast
 * against white, far under WCAG's 4.5:1 minimum for normal text. Shipping
 * that color unmodified as literal text color would make body text
 * genuinely unreadable for every user of that school, not a cosmetic
 * nitpick. So: the picked hex is ALWAYS preserved and exposed as-is
 * (--color-brand-raw) for roles that don't need text-level contrast (e.g. a
 * colored swatch, a border on a light tint, a decorative accent) — but the
 * WORKING --color-brand-600 used for text/button-bg roles is the picked hex
 * darkened just enough (mixed toward black, binary-searched) to clear 4.5:1
 * against white, if and only if the raw pick doesn't already clear it. A
 * color that already passes is returned completely unmodified — this only
 * ever activates for the edge case, not as a routine desaturation.
 *
 * All computation is a pure function on hex strings — no DOM access, no
 * browser-only APIs, per §5 (native app strategy: business logic must not
 * live in components and must not assume a browser environment). The one
 * caller that touches the DOM (`applyBrandTheme`, thin wrapper at the
 * bottom) is intentionally the only non-pure export, so a future React
 * Native port can import everything else in this file unchanged and supply
 * its own platform-specific "apply" step.
 *
 * DARK MODE (added post-Session-28, §12 2026-07-09): the description above
 * ("tints toward white," "darkened... against white") is the LIGHT-mode
 * behavior specifically, still the default (`surfaceHex = '#ffffff'`) so
 * every pre-existing call site is unaffected. `deriveBrandScale` and
 * `darkenToContrast` now take that surface color as a real parameter
 * instead of assuming white: tints mix toward the surface, shades mix
 * away from it, and the legibility guard darkens-or-lightens toward
 * whichever pole actually gains contrast against that surface — mixing
 * toward black only ever helps against a light surface; against a dark
 * one the same admin-picked hex needs to move toward white instead, or
 * the guard would make contrast worse, not better. `on`/`on700`/`on800`
 * are unchanged — those judge contrast for text painted ON TOP OF a
 * solid brand fill, a different question from "does the brand color read
 * against the page surface," and stay checked against pure white/black
 * regardless of mode.
 */

export interface BrandScale {
  /** The admin's picked color, completely unmodified. Use for swatches,
   *  decorative accents, borders on light tints — anything that does not
   *  render text or rely on WCAG text/UI contrast. */
  raw: string;
  /** Tints — brand mixed toward white. Safe as background fills behind
   *  dark text (already-declared --color-text tokens), never as text
   *  color themselves. */
  50: string;
  100: string;
  200: string;
  300: string;
  400: string;
  /** Working base. Equal to `raw` unless `raw` fails 4.5:1 against white,
   *  in which case this is `raw` darkened to the minimum needed to pass.
   *  This is what most of index.css's `color:`/`background:` roles for
   *  --color-brand-600 should read from. */
  500: string;
  600: string;
  /** Shades — working base mixed toward black. For hover/active states
   *  and text that needs to sit on a light brand-tinted background. */
  700: string;
  800: string;
  /** Either '#ffffff' or '#000000' — whichever gives higher real contrast
   *  against the WORKING 600, not assumed. Use as text/icon color for
   *  anything rendered on top of a solid --color-brand-600 fill (e.g. a
   *  primary button's label). */
  on: string;
  /** Same idea as `on`, computed independently against shade 700 rather
   *  than reusing `on`. Session 24 found a real gap: `on` is chosen
   *  against the working 600, but 700/800 are always darker — for a
   *  brand pick where black already barely wins against 600 (e.g. mid
   *  grays, or a pale color the legibility guard darkened toward
   *  mid-gray), black-on-800 measures as low as ~2.4:1, well under the
   *  4.5:1 text minimum, even though black was the "correct" choice
   *  against 600 itself. Any UI painting text on a 700 fill must use
   *  this, not `on`. */
  on700: string;
  /** Same as `on700`, computed against shade 800. Checked directly: for
   *  every tested brand color from near-black through pale
   *  gold/green/gray, white clears ≥8.5:1 against 800 while black caps
   *  at ~2.4:1 — so in practice this always resolves to '#ffffff', but
   *  it is computed for real rather than hardcoded, so a future shade
   *  darker than 800 (or a change to the mix fractions above) can't
   *  silently invalidate the assumption. */
  on800: string;
  /** True if the legibility guard actually altered the admin's pick for
   *  the working 600. Surfaced so a future Settings UI can show the admin
   *  a small "adjusted for readability" note rather than silently
   *  diverging from the swatch they clicked — flagged here, not built,
   *  since no such UI copy exists yet; do not invent it without the
   *  owner's sign-off on the wording. */
  wasAdjustedForContrast: boolean;
}

const WHITE: RGB = [255, 255, 255];
const BLACK: RGB = [0, 0, 0];

/** WCAG AA minimum for normal-weight body text. Not the 3:1 large-text/
 *  UI-component minimum — index.css's own grep confirms --color-brand-600
 *  is used as regular-sized text color at 58+ sites, so the stricter
 *  threshold is the correct one to guard against, not the looser one. */
const MIN_TEXT_CONTRAST = 4.5;

type RGB = [number, number, number];

function hexToRgb(hex: string): RGB {
  const clean = hex.replace('#', '');
  const full =
    clean.length === 3
      ? clean.split('').map((c) => c + c).join('')
      : clean;
  const num = parseInt(full, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function rgbToHex([r, g, b]: RGB): string {
  const clamp = (c: number) => Math.max(0, Math.min(255, Math.round(c)));
  return (
    '#' +
    [clamp(r), clamp(g), clamp(b)]
      .map((c) => c.toString(16).padStart(2, '0'))
      .join('')
  );
}

function mix(c1: RGB, c2: RGB, t: number): RGB {
  return [
    c1[0] + (c2[0] - c1[0]) * t,
    c1[1] + (c2[1] - c1[1]) * t,
    c1[2] + (c2[2] - c1[2]) * t,
  ];
}

function relativeLuminance([r, g, b]: RGB): number {
  const chan = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
}

/** Real WCAG contrast ratio between two colors — 1 (no contrast) to 21
 *  (max, pure black on pure white). Exported since Session 23's own
 *  Definition of Done and any future settings UI validation both need to
 *  show/check this number directly, not just consume the derived scale. */
export function contrastRatio(hexA: string, hexB: string): number {
  const lA = relativeLuminance(hexToRgb(hexA));
  const lB = relativeLuminance(hexToRgb(hexB));
  const lighter = Math.max(lA, lB);
  const darker = Math.min(lA, lB);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Pushes `hex` toward whichever pole (black or white) actually increases
 *  its contrast against `surfaceHex`, by the minimum amount needed to
 *  clear `minContrast`. Binary search over the mix fraction rather than a
 *  fixed step, so the result is the least possible departure from the
 *  admin's original pick — matching this session's "preserve intent, fix
 *  only the failing case" decision, not a blanket desaturation.
 *
 *  Surface-aware by necessity, not just by preference: mixing toward black
 *  only ever gains contrast against a LIGHT surface (white text stays
 *  fixed, the color gets darker, the gap widens). Against a DARK surface
 *  the same black-ward mix does the opposite — it moves the color closer
 *  to the dark surface and contrast gets worse, not better. The pole has
 *  to be chosen relative to the surface, not assumed to always be black. */
function darkenToContrast(hex: string, minContrast: number, surfaceHex: string): string {
  const rgb = hexToRgb(hex);
  const surfaceIsDark = relativeLuminance(hexToRgb(surfaceHex)) < 0.5;
  const pole: RGB = surfaceIsDark ? WHITE : BLACK;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    const candidate = mix(rgb, pole, mid);
    if (contrastRatio(rgbToHex(candidate), surfaceHex) >= minContrast) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return rgbToHex(mix(rgb, pole, hi));
}

/**
 * Pure function: given the admin's picked brand hex, derive the full
 * scale. No DOM access — safe to call from a service, a test, or a future
 * React Native theme provider equally.
 *
 * `surfaceHex` — the background the derived scale will actually sit on.
 * Defaults to '#ffffff', so every existing light-mode call site (App.tsx's
 * two boot-time calls, SettingsModule.tsx's save handler) keeps its exact
 * prior behavior with zero code changes on their end. Pass the dark
 * surface color (DARK_SURFACE_HEX below) to derive a scale that's
 * legible and visually coherent against a dark background instead —
 * a brand hue picked and verified against white can still fail contrast,
 * or just look harshly oversaturated, against near-black (see this
 * file's header note on why no single fixed "safe partner color" exists).
 */
export function deriveBrandScale(pickedHex: string, surfaceHex: string = '#ffffff'): BrandScale {
  const raw = pickedHex;
  const surfaceIsDark = relativeLuminance(hexToRgb(surfaceHex)) < 0.5;

  const rawContrast = contrastRatio(raw, surfaceHex);
  const wasAdjustedForContrast = rawContrast < MIN_TEXT_CONTRAST;
  const workingBase = wasAdjustedForContrast
    ? darkenToContrast(raw, MIN_TEXT_CONTRAST, surfaceHex)
    : raw;
  const workingRgb = hexToRgb(workingBase);

  // Tints/shades are always relative to the surface, not fixed poles —
  // matching real theming-engine practice (Adobe Leonardo, Confrere's
  // runtime palette generator). A "tint" is a subtle version of the brand
  // color relative to whatever it sits on: mixing toward white when the
  // surface is dark produces a jarring near-white chip on a dark UI,
  // not a subtle one. So tints mix TOWARD the surface (subtle, blends
  // in) and shades mix AWAY from the surface (deeper into the color,
  // for hover/active states and text-on-tint roles) — in both modes.
  const tintPole = hexToRgb(surfaceHex);
  const shadePole: RGB = surfaceIsDark ? WHITE : BLACK;

  const tint50 = rgbToHex(mix(workingRgb, tintPole, 0.94));
  const tint100 = rgbToHex(mix(workingRgb, tintPole, 0.88));
  const tint200 = rgbToHex(mix(workingRgb, tintPole, 0.72));
  const tint300 = rgbToHex(mix(workingRgb, tintPole, 0.52));
  const tint400 = rgbToHex(mix(workingRgb, tintPole, 0.28));

  const shade700 = rgbToHex(mix(workingRgb, shadePole, 0.2));
  const shade800 = rgbToHex(mix(workingRgb, shadePole, 0.36));

  const contrastVsWhite = contrastRatio(workingBase, '#ffffff');
  const contrastVsBlack = contrastRatio(workingBase, '#000000');
  const on = contrastVsWhite >= contrastVsBlack ? '#ffffff' : '#000000';

  // Computed independently per shade, not inherited from `on` — a shade
  // darker than 600 can flip which of black/white actually wins, and
  // reusing `on` blindly was the exact bug this fixes (see BrandScale's
  // on700/on800 doc comment above). Still checked against pure white/
  // black here, not surfaceHex — on/on700/on800 are for text/icons
  // painted ON TOP OF a solid brand fill, a different contrast question
  // than "does the brand color read against the page surface."
  const contrast700VsWhite = contrastRatio(shade700, '#ffffff');
  const contrast700VsBlack = contrastRatio(shade700, '#000000');
  const on700 = contrast700VsWhite >= contrast700VsBlack ? '#ffffff' : '#000000';

  const contrast800VsWhite = contrastRatio(shade800, '#ffffff');
  const contrast800VsBlack = contrastRatio(shade800, '#000000');
  const on800 = contrast800VsWhite >= contrast800VsBlack ? '#ffffff' : '#000000';

  return {
    raw,
    50: tint50,
    100: tint100,
    200: tint200,
    300: tint300,
    400: tint400,
    500: workingBase,
    600: workingBase,
    700: shade700,
    800: shade800,
    on,
    on700,
    on800,
    wasAdjustedForContrast,
  };
}

/**
 * Dark-mode page surface color. Not an arbitrary invented dark — matches
 * index.css's own existing --color-neutral-900 (#111827), so the derived
 * brand scale stays internally consistent with the rest of the app's
 * already-shipped dark-adjacent color rather than introducing a second,
 * disagreeing "dark" the way --color-brand-600's un-declared :root value
 * caused Problem 6.1 in the first place (see this file's header note).
 */
export const DARK_SURFACE_HEX = '#111827';

export type ThemeMode = 'light' | 'dark';

/**
 * The only DOM-touching export in this file. Applies a derived scale to
 * `document.documentElement` as real CSS custom properties, matching
 * SettingsModule.tsx's existing single-property call
 * (`setProperty('--color-brand-600', themeColor)` at its current call
 * site) but now setting the FULL scale in one call instead of just the
 * one property most of index.css was never actually reading correctly.
 *
 * `mode` defaults to 'light', so every existing call site (App.tsx's two
 * boot-time calls, SettingsModule.tsx's save handler) keeps its exact
 * prior behavior unless explicitly passed 'dark'. Callers that need dark
 * mode should pass the current theme_mode explicitly and re-call this
 * whenever that mode toggles, since the derived scale itself changes
 * with the surface it's computed against — it's not just a CSS
 * data-attribute switch, the actual color math is different.
 *
 * Kept as a thin, separately-exported wrapper (not folded into
 * deriveBrandScale) specifically so a React Native theme provider can
 * import deriveBrandScale directly and supply its own platform-specific
 * application step, per §5 — this function is the part that does NOT
 * port as-is, and is named/isolated so that's obvious at a glance.
 */
export function applyBrandTheme(pickedHex: string, mode: ThemeMode = 'light'): BrandScale {
  const surfaceHex = mode === 'dark' ? DARK_SURFACE_HEX : '#ffffff';
  const scale = deriveBrandScale(pickedHex, surfaceHex);
  const root = document.documentElement.style;
  root.setProperty('--color-brand-raw', scale.raw);
  root.setProperty('--color-brand-50', scale[50]);
  root.setProperty('--color-brand-100', scale[100]);
  root.setProperty('--color-brand-200', scale[200]);
  root.setProperty('--color-brand-300', scale[300]);
  root.setProperty('--color-brand-400', scale[400]);
  root.setProperty('--color-brand-500', scale[500]);
  root.setProperty('--color-brand-600', scale[600]);
  root.setProperty('--color-brand-700', scale[700]);
  root.setProperty('--color-brand-800', scale[800]);
  root.setProperty('--color-brand-on', scale.on);
  root.setProperty('--color-brand-on-700', scale.on700);
  root.setProperty('--color-brand-on-800', scale.on800);
  return scale;
}
