/**
 * alarmService.ts
 * PRD Tier 6 / Problem 6.6, Session 28.
 *
 * Pure Web Audio API tone synthesis — zero audio files to host or load.
 * Four tone families (chime/bell/buzzer/digital), each with an "end" variant
 * (played when a period actually ends) and a "warn" variant (played
 * `warnLeadMin` minutes before a period ends, if earlyWarning is on) — the
 * warn variant is deliberately a shorter/quieter-feeling cousin of the same
 * family so a teacher can tell "this is the two-minute warning" from "this
 * period is over now" by ear, without looking at a screen.
 *
 * AudioContext is created lazily via getAudioCtx() and only on a genuine
 * user gesture — browsers refuse (or silently suspend) AudioContext creation
 * before any user interaction, so this module never constructs one at
 * import/mount time. Call primeAudioContext() from a real click/tap handler
 * (e.g. the Settings screen's own "Test sound" button) to warm it up before
 * the first scheduled alarm ever needs to fire.
 *
 * Every playX function is a pure side-effecting function over the Web Audio
 * graph — no module-level mutable state beyond the lazily-created
 * AudioContext singleton itself, and no React/store dependency of any kind.
 * Volume is 0–1 (matches staff_preferences.sound_vol's numeric(3,2) range).
 *
 * React Native note (master plan §5.1): Web Audio API is available in React
 * Native only via community modules (e.g. react-native-webview shims or
 * native audio libraries) — it is NOT a guaranteed drop-in for a future
 * native port. This entire file will need a platform-specific rewrite or
 * abstraction layer at that point, not a portability shim. Flagged here per
 * §5.1's own discipline rather than assumed away.
 *
 * Scope addition (this session): staff_preferences.browser_notif was stored
 * and toggleable in the Settings UI but nothing ever acted on it — a real
 * gap against Problem 6.6's own spec ("...and browser notifications").
 * requestNotificationPermission()/showAlarmNotification() below close that
 * gap. These use the separate, unrelated Notification Web API, not Web
 * Audio — kept in this file anyway rather than a new one-purpose file,
 * since both are "how an alarm actually reaches the teacher" concerns
 * fired from the exact same LivePeriodWidget call site; genuinely audio-only
 * code stays above this section unchanged.
 */

export type ToneType = 'chime' | 'bell' | 'buzzer' | 'digital'
export type ToneVariant = 'end' | 'warn'

let audioCtx: AudioContext | null = null

/**
 * Lazily creates (or returns the existing) AudioContext. Safe to call
 * repeatedly. Does NOT resume a suspended context on its own — call
 * primeAudioContext() from a real user gesture for that; this getter alone
 * is fine to call from non-gesture code paths (e.g. a scheduling check)
 * since construction itself doesn't throw, only autoplay does.
 */
function getAudioCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const AudioContextCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextCtor) return null
  if (!audioCtx) {
    audioCtx = new AudioContextCtor()
  }
  return audioCtx
}

/**
 * Call from a real click/tap handler (e.g. "Test sound" button, or the
 * first render after the user has interacted with the page at all) to
 * create + resume the AudioContext ahead of when an alarm actually needs to
 * fire. Most browsers suspend a freshly-created context until this runs
 * inside a genuine user-gesture call stack.
 */
export function primeAudioContext(): void {
  const ctx = getAudioCtx()
  if (ctx && ctx.state === 'suspended') {
    void ctx.resume()
  }
}

// ─── Low-level tone primitive ──────────────────────────────────────────────

interface ToneStep {
  freq: number
  startOffset: number   // seconds from the call to playTone()
  duration: number       // seconds
  type?: OscillatorType  // defaults to 'sine'
}

/**
 * Schedules one or more oscillator "notes" against the shared AudioContext,
 * each with its own short attack/decay envelope so notes don't click at
 * their edges. `volume` is 0–1 and is applied uniformly to every step.
 */
function playTone(steps: ToneStep[], volume: number): void {
  const ctx = getAudioCtx()
  if (!ctx) return
  const now = ctx.currentTime
  const vol = Math.max(0, Math.min(1, volume))
  if (vol === 0) return

  for (const step of steps) {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = step.type ?? 'sine'
    osc.frequency.value = step.freq

    const start = now + step.startOffset
    const end = start + step.duration
    const attack = Math.min(0.015, step.duration / 4)
    const release = Math.min(0.08, step.duration / 3)

    gain.gain.setValueAtTime(0, start)
    gain.gain.linearRampToValueAtTime(vol, start + attack)
    gain.gain.setValueAtTime(vol, Math.max(start + attack, end - release))
    gain.gain.linearRampToValueAtTime(0, end)

    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(start)
    osc.stop(end + 0.02)
  }
}

// ─── Tone families ──────────────────────────────────────────────────────────
// Each family's "end" variant is the fuller/longer version; "warn" is a
// shorter, single-note cousin using the same timbre so the two are
// audibly related but distinguishable.

function chime(variant: ToneVariant, volume: number): void {
  if (variant === 'end') {
    playTone(
      [
        { freq: 880, startOffset: 0, duration: 0.35 },
        { freq: 1174.66, startOffset: 0.18, duration: 0.35 },
        { freq: 1567.98, startOffset: 0.36, duration: 0.5 },
      ],
      volume,
    )
  } else {
    playTone([{ freq: 1174.66, startOffset: 0, duration: 0.25 }], volume)
  }
}

function bell(variant: ToneVariant, volume: number): void {
  if (variant === 'end') {
    playTone(
      [
        { freq: 987.77, startOffset: 0, duration: 0.9, type: 'triangle' },
        { freq: 1975.53, startOffset: 0, duration: 0.6, type: 'triangle' },
      ],
      volume * 0.8,
    )
  } else {
    playTone([{ freq: 987.77, startOffset: 0, duration: 0.4, type: 'triangle' }], volume * 0.8)
  }
}

function buzzer(variant: ToneVariant, volume: number): void {
  if (variant === 'end') {
    playTone(
      [
        { freq: 220, startOffset: 0, duration: 0.2, type: 'sawtooth' },
        { freq: 220, startOffset: 0.3, duration: 0.2, type: 'sawtooth' },
        { freq: 220, startOffset: 0.6, duration: 0.3, type: 'sawtooth' },
      ],
      volume * 0.6,
    )
  } else {
    playTone([{ freq: 220, startOffset: 0, duration: 0.15, type: 'sawtooth' }], volume * 0.6)
  }
}

function digital(variant: ToneVariant, volume: number): void {
  if (variant === 'end') {
    playTone(
      [
        { freq: 1500, startOffset: 0, duration: 0.08, type: 'square' },
        { freq: 1500, startOffset: 0.12, duration: 0.08, type: 'square' },
        { freq: 1500, startOffset: 0.24, duration: 0.08, type: 'square' },
        { freq: 2000, startOffset: 0.4, duration: 0.18, type: 'square' },
      ],
      volume * 0.5,
    )
  } else {
    playTone([{ freq: 1500, startOffset: 0, duration: 0.08, type: 'square' }], volume * 0.5)
  }
}

const TONE_FAMILIES: Record<ToneType, (variant: ToneVariant, volume: number) => void> = {
  chime,
  bell,
  buzzer,
  digital,
}

/**
 * Plays one repetition of the given tone type/variant at the given volume.
 * Does not handle repeat-count looping or lead-time scheduling — callers
 * (e.g. LivePeriodWidget's alarm-firing effect, or a "Test sound" button)
 * own that, since only they know the staff member's sound_repeat setting
 * and how "test" playback should differ (a test always plays once,
 * regardless of the saved repeat count).
 */
export function playAlarmTone(type: ToneType, variant: ToneVariant, volume: number): void {
  primeAudioContext()
  TONE_FAMILIES[type](variant, volume)
}

/**
 * Plays `repeatCount` repetitions of the given tone, spaced apart so notes
 * don't overlap and blur together. Used by the real firing path
 * (LivePeriodWidget) — the "Test sound" button should call playAlarmTone
 * directly instead, always once, regardless of the saved repeat setting.
 */
export function playAlarmToneRepeated(
  type: ToneType,
  variant: ToneVariant,
  volume: number,
  repeatCount: number,
): void {
  primeAudioContext()
  const gapSeconds = 1.1 // spacing between repeats — comfortably clear of the longest single tone (~1s, bell's "end")
  const count = Math.max(1, Math.min(5, repeatCount))
  for (let i = 0; i < count; i++) {
    setTimeout(() => TONE_FAMILIES[type](variant, volume), i * gapSeconds * 1000)
  }
}

// ─── Browser notifications ──────────────────────────────────────────────────
// Unrelated Web API (Notification, not AudioContext) — see header note.

/**
 * True if this browser supports the Notification API at all. Older/embedded
 * webviews may not — every function below already checks this internally,
 * so callers don't strictly need to gate on it themselves, but it's
 * exported for UI code that wants to hide the "Browser notification" toggle
 * entirely rather than show a control that can never do anything.
 */
export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window
}

/**
 * Current permission state, or null if the API isn't supported at all.
 * Does not prompt — read-only. 'granted' | 'denied' | 'default' per spec;
 * 'default' means "never asked," not "denied."
 */
export function getNotificationPermission(): NotificationPermission | null {
  if (!notificationsSupported()) return null
  return Notification.permission
}

/**
 * Requests permission — MUST be called from a real user gesture (a click
 * handler), same constraint as primeAudioContext(). The natural call site
 * is the Settings screen's own "Browser notification" toggle: flipping it
 * on IS the user gesture, so request from that onClick handler directly
 * rather than deferring to whenever the first alarm happens to fire (which
 * won't be inside a gesture, and the browser will silently refuse to
 * prompt). Resolves to the resulting permission state; already-decided
 * permissions (previously granted or denied) resolve immediately without
 * re-prompting, matching the browser's own one-decision-per-origin model.
 */
export async function requestNotificationPermission(): Promise<NotificationPermission | null> {
  if (!notificationsSupported()) return null
  if (Notification.permission !== 'default') return Notification.permission
  try {
    return await Notification.requestPermission()
  } catch {
    // Some older browsers implement the callback-style API instead of the
    // promise-style one; both are still in real-world use in older webviews.
    return new Promise((resolve) => {
      Notification.requestPermission((result) => resolve(result))
    })
  }
}

/**
 * Shows a browser notification for a period-end/warn event, if and only if
 * permission has already been granted. Silently no-ops otherwise (never
 * throws, never prompts) — permission must be requested ahead of time via
 * requestNotificationPermission(), from a real gesture; this function is
 * called from LivePeriodWidget's tick loop, which is not a user gesture and
 * would be silently refused by the browser if it tried to prompt here.
 */
export function showAlarmNotification(periodLabel: string, variant: ToneVariant): void {
  if (!notificationsSupported() || Notification.permission !== 'granted') return
  const title = variant === 'warn' ? 'Period ending soon' : 'Period ended'
  const body = variant === 'warn'
    ? `${periodLabel} is about to end.`
    : `${periodLabel} has ended.`
  try {
    new Notification(title, { body, tag: `alarm-${variant}-${periodLabel}`, silent: true })
    // silent: true — this notification rides alongside the Web Audio tone,
    // which already provides the sound; a second, OS-level notification
    // sound would double up and isn't controlled by sound_vol at all.
  } catch {
    // Notification constructor can throw in some contexts (e.g. certain
    // mobile browsers require a Service Worker for this outside of one) —
    // this is a supplementary alert, not the primary one, so fail silently
    // rather than surface an error for a nice-to-have channel.
  }
}
