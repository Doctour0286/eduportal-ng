import { obligationBadges, type Obligation } from '../services/obligationsService'

const MAX_VISIBLE = 2

/**
 * Specific badges for a student's unfulfilled fines/tasks — a fine shows its
 * amount, a task shows its text. Clicking opens the mark-paid/done dialog.
 */
export default function ObligationBadges({
  items,
  onOpen,
}: {
  items: Obligation[] | undefined
  onOpen: () => void
}) {
  const badges = obligationBadges(items)
  if (badges.length === 0) return null
  const shown = badges.slice(0, MAX_VISIBLE)
  const extra = badges.length - shown.length
  const open = (e: React.SyntheticEvent) => { e.stopPropagation(); onOpen() }

  return (
    <span className="obl-badges">
      {shown.map(b => (
        <button
          key={b.id}
          type="button"
          className={`obl-badge obl-badge--${b.kind}`}
          title={`${b.title}\nClick to resolve`}
          onClick={open}
        >
          {b.label}
        </button>
      ))}
      {extra > 0 && (
        <button type="button" className="obl-badge obl-badge--more" onClick={open}>
          +{extra} more
        </button>
      )}
    </span>
  )
}
