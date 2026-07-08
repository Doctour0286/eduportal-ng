/**
 * Modal.tsx
 * PRD Session 24 (Tier 6, Problem 6.5) — shared overlay+card component.
 *
 * Built now, ahead of its originally-planned sequencing (after 6.2–6.4),
 * because the timetable click-to-popup feature (owner request, this
 * session) needs a real modal pattern and the owner chose to build the
 * shared component now rather than a one-off, so this becomes Problem
 * 6.5's first real consumer instead of a separate future pass.
 *
 * Matches the reference app's `.modal-ov`/`.modal`/`.modal-x` pattern:
 *   - Backdrop with blur, centered card, close (×) button top-right.
 *   - popIn animation, 0.18s — reference app's own timing, "feels
 *     instant" per §4.1.
 *   - Focus management (§4.10, not decoration): stores whatever had
 *     focus before the modal opened, focuses the close button on open,
 *     restores focus to the original element on close. Reference app's
 *     exact `lastFocusBeforeModal` pattern.
 *   - Closes on backdrop click or Escape key.
 *
 * This is intentionally a *thin* shell — it owns the overlay, card,
 * close button, and focus/escape behavior only. Content is passed as
 * children, so every consumer (timetable period-detail popup today;
 * pickers, confirmations, or anything else Problem 6.5's audit finds
 * later) supplies its own body markup rather than this component
 * knowing about any of them.
 *
 * Not yet done, named rather than silently skipped: a full focus TRAP
 * (Tab/Shift+Tab cycling confined inside the modal while open) is not
 * implemented — only focus store/restore-on-close and initial focus.
 * The reference app's own behavior is the same subset ("focus-trap-
 * lite" per the PRD's own wording for this problem), so this matches
 * the named spec, but a real trap is a legitimate future addition if
 * an on-device pass finds Tab genuinely escaping the modal.
 *
 * Existing popover/sheet patterns elsewhere in the app (e.g. Tier 2's
 * guardian-delete confirmation, StudentsModule's slide-up sheets) are
 * NOT retrofitted onto this component in this pass — per Problem 6.5's
 * own instruction, that coexistence question is left for its own
 * review, not decided here as a side effect of adding this file.
 *
 * One deliberate divergence from the reference app: index.html's modal
 * is a permanently-mounted DOM node toggled via a `.open` class
 * (display:none ↔ flex). This component instead returns null when
 * `open` is false, unmounting entirely — the more natural React
 * pattern, and it means .modal-ov never needs an --open modifier class
 * in CSS (the .modal-ov rule's own `display: flex` always applies to
 * whatever's actually mounted).
 */

import { useEffect, useRef, type ReactNode } from 'react'

interface ModalProps {
  open: boolean
  onClose: () => void
  title?: string
  children: ReactNode
  /** Optional max-width override, e.g. '480px'. Defaults to the
   *  reference app's own 400px card width via CSS. */
  maxWidth?: string
}

export function Modal({ open, onClose, title, children, maxWidth }: ModalProps) {
  const closeBtnRef = useRef<HTMLButtonElement>(null)
  const lastFocusBeforeModal = useRef<HTMLElement | null>(null)

  // Store focus on open, focus the close button; restore on close.
  useEffect(() => {
    if (!open) return
    lastFocusBeforeModal.current = document.activeElement as HTMLElement | null
    // Match the reference app's own 50ms delay — lets the popIn
    // animation/mount settle before moving focus.
    const t = setTimeout(() => closeBtnRef.current?.focus(), 50)
    return () => {
      clearTimeout(t)
      if (lastFocusBeforeModal.current?.focus) {
        lastFocusBeforeModal.current.focus()
      }
    }
  }, [open])

  // Escape key closes.
  useEffect(() => {
    if (!open) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="modal-ov"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="modal" style={maxWidth ? { maxWidth } : undefined}>
        <button
          ref={closeBtnRef}
          className="modal-x"
          onClick={onClose}
          aria-label="Close"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" style={{ width: '0.85em', height: '0.85em' }}>
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
        <div className="modal-content">
          {children}
        </div>
      </div>
    </div>
  )
}
