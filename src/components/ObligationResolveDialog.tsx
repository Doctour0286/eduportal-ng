import { useState } from 'react'
import { Modal } from './Modal'
import {
  formatObligationAmount,
  resolveObligation,
  type Obligation,
} from '../services/obligationsService'

/**
 * "Mark paid / Mark done / Waive" for a student's unfulfilled fines and
 * tasks. One dialog used everywhere a badge or action appears, so
 * resolving always looks and works the same.
 */
export default function ObligationResolveDialog({
  open,
  studentName,
  items,
  actorRecordId,
  onClose,
  onResolved,
}: {
  open: boolean
  studentName: string
  items: Obligation[]               // pending items to resolve
  actorRecordId: string | null
  onClose: () => void
  onResolved: () => void | Promise<void>
}) {
  const [notes, setNotes] = useState<Map<string, string>>(new Map())
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState('')

  async function act(o: Obligation, status: 'fulfilled' | 'waived') {
    setBusyId(o.id)
    setError('')
    const res = await resolveObligation({
      id: o.id, status, note: notes.get(o.id) ?? '', resolvedBy: actorRecordId,
    })
    setBusyId(null)
    if (!res.ok) { setError(res.error); return }
    await onResolved()
    if (items.length <= 1) onClose()
  }

  const fmt = (d: string) =>
    new Date(d.length > 10 ? d : d + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

  return (
    <Modal open={open} onClose={onClose} title={`Fines & tasks — ${studentName}`}>
      {items.length === 0 ? (
        <p className="obl-dlg-empty">Nothing outstanding.</p>
      ) : (
        <ul className="obl-dlg-list">
          {items.map(o => (
            <li key={o.id} className="obl-dlg-item">
              <div className="obl-dlg-top">
                <span className={`obl-chip obl-chip--${o.kind}`}>
                  {o.kind === 'fine' ? `${formatObligationAmount(o.amount ?? 0)} fine` : 'Task'}
                </span>
                {o.due_date && <span className="obl-dlg-due">Due {fmt(o.due_date)}</span>}
              </div>
              <p className="obl-dlg-desc">{o.description}</p>
              <p className="obl-dlg-meta">
                Assigned {fmt(o.created_at)}{o.created_by_name ? ` by ${o.created_by_name}` : ''}
              </p>
              <input
                className="obl-input obl-input--wide"
                type="text"
                value={notes.get(o.id) ?? ''}
                onChange={e => setNotes(prev => new Map(prev).set(o.id, e.target.value))}
                placeholder={o.kind === 'fine' ? 'Note, e.g. receipt number (optional)' : 'Note (optional)'}
                disabled={busyId === o.id}
              />
              <div className="obl-dlg-actions">
                <button
                  type="button"
                  className="obl-btn obl-btn--primary"
                  disabled={busyId === o.id}
                  onClick={() => void act(o, 'fulfilled')}
                >
                  {busyId === o.id ? 'Saving…' : o.kind === 'fine' ? 'Mark paid' : 'Mark done'}
                </button>
                <button
                  type="button"
                  className="obl-btn"
                  disabled={busyId === o.id}
                  onClick={() => void act(o, 'waived')}
                >
                  Waive
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="obl-dlg-error" role="alert">{error}</p>}
    </Modal>
  )
}
