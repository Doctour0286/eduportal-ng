import { obligationBadges, type Obligation } from '../services/obligationsService'

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
  const first = badges[0]
  const extra = badges.length - 1
  const open = (e: React.SyntheticEvent) => { e.stopPropagation(); onOpen() }

  // One tag per student. With more than one item it carries a "+N" so it's
  // obvious there is more; clicking opens a dialog listing every item.
  return (
    <span className="obl-badges">
      <button
        type="button"
        className={`obl-badge obl-badge--${first.kind}`}
        title={`${badges.map(b => b.title).join('\n')}\nClick to view all`}
        onClick={open}
      >
        {first.label}
        {extra > 0 && <span className="obl-badge-plus">+{extra}</span>}
      </button>
    </span>
  )
}
