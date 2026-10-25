import { useState } from 'react'
import ObligationFields from './ObligationFields'
import {
  EMPTY_OBLIGATION_DRAFT,
  createObligation,
  validateObligationDraft,
  type ObligationDraft,
} from '../services/obligationsService'

/**
 * Issue a query, fine or task to a student directly — no suspension or
 * reactivation involved. Same table and same lifecycle (pending -> done /
 * paid / responded / waived) as the ones created at reactivation.
 */
export default function IssueObligationForm({
  schoolId,
  studentId,
  actorRecordId,
  onIssued,
  onCancel,
}: {
  schoolId: string
  studentId: string
  actorRecordId: string | null
  onIssued: () => void | Promise<void>
  onCancel: () => void
}) {
  const [draft, setDraft] = useState<ObligationDraft | null>({ ...EMPTY_OBLIGATION_DRAFT, kind: 'query' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function submit() {
    if (!draft) return
    const problem = validateObligationDraft(draft)
    if (problem) { setError(problem); return }
    setSaving(true)
    setError('')
    const res = await createObligation({ schoolId, studentId, draft, createdBy: actorRecordId, origin: 'direct' })
    setSaving(false)
    if (!res.ok) { setError(res.error); return }
    await onIssued()
  }

  return (
    <div className="obl-issue">
      <ObligationFields value={draft} onChange={setDraft} disabled={saving} required />
      {error && <p className="obl-dlg-error" role="alert">{error}</p>}
      <div className="obl-dlg-actions">
        <button type="button" className="obl-btn obl-btn--primary" disabled={saving} onClick={() => void submit()}>
          {saving ? 'Saving…' : 'Issue'}
        </button>
        <button type="button" className="obl-btn" disabled={saving} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}
