import { useCallback, useEffect, useMemo, useState } from 'react'
import { formatNaira, type ClassNode, type FeeAssignment, type Term } from '../services/financeService'
import {
  loadAssignmentActivity,
  loadAssignmentCoverage,
  removeExemption,
  updateAssignmentDetails,
  type CoverageRow,
  type FeeActionLogRow,
  type MassAction,
} from '../services/feeMassActionsService'
import { FeeMassActionDialog } from './FeeMassActionsPanel'

/**
 * One fee assignment, opened as a page: who it covers and where each student
 * stands, its settings, and what has been done to it. Replaces the old
 * list-only view — pick a fee, then do everything to it from here.
 */

const formatDate = (iso: string) =>
  new Date(iso.length > 10 ? iso : iso + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

type Tab = 'students' | 'details' | 'activity'
type StatusFilter = 'all' | CoverageRow['status']

const STATUS_LABEL: Record<CoverageRow['status'], string> = {
  unpaid: 'Unpaid', part: 'Part-paid', paid: 'Paid', waived: 'Waived', exempt: 'Exempt', credit: 'Credit',
}
const ACTION_LABEL: Record<MassAction, string> = {
  edit_amount: 'Amount edited', waive: 'Waived', exempt: 'Exempted', unassign: 'Unassigned',
}

export default function FeeAssignmentDetail({
  assignment: a,
  terms,
  classes,
  schoolId,
  staffId,
  canManage,
  canWaive,
  onBack,
  onChanged,
}: {
  assignment: FeeAssignment
  terms: Term[]
  classes: ClassNode[]
  schoolId: string
  staffId: string | null
  canManage: boolean
  canWaive: boolean
  onBack: () => void
  onChanged: () => void | Promise<void>
}) {
  const [tab, setTab] = useState<Tab>('students')
  const [rows, setRows] = useState<CoverageRow[] | null>(null)
  const [coverageError, setCoverageError] = useState('')
  const [activity, setActivity] = useState<FeeActionLogRow[] | null>(null)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<StatusFilter>('all')
  const [dialog, setDialog] = useState<{ action: MassAction; student?: { id: string; full_name: string } } | null>(null)
  const [notice, setNotice] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)

  // Details form
  const [amount, setAmount] = useState(String(a.amount))
  const [dueDate, setDueDate] = useState(a.due_date ?? '')
  const [termId, setTermId] = useState(a.term_id ?? '')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [formMsg, setFormMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    setAmount(String(a.amount)); setDueDate(a.due_date ?? ''); setTermId(a.term_id ?? '')
  }, [a.id, a.amount, a.due_date, a.term_id])

  const reloadCoverage = useCallback(async () => {
    setCoverageError('')
    const res = await loadAssignmentCoverage(schoolId, a)
    if (res.ok) setRows(res.data); else { setRows([]); setCoverageError(res.error) }
  }, [schoolId, a])

  const reloadActivity = useCallback(async () => {
    const res = await loadAssignmentActivity(schoolId, a.id)
    setActivity(res.ok ? res.data : [])
  }, [schoolId, a.id])

  useEffect(() => { void reloadCoverage() }, [reloadCoverage])
  useEffect(() => { if (tab === 'activity') void reloadActivity() }, [tab, reloadActivity])

  const totals = useMemo(() => {
    const list = rows ?? []
    const billed = list.filter(r => !r.exempt).length * a.amount
    return {
      count: list.length,
      billed,
      collected: list.reduce((n, r) => n + r.paid, 0),
      outstanding: list.reduce((n, r) => n + r.owed, 0),
      credit: list.reduce((n, r) => n + r.credit, 0),
    }
  }, [rows, a.amount])

  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const r of rows ?? []) c[r.status] = (c[r.status] ?? 0) + 1
    return c
  }, [rows])

  const visible = (rows ?? []).filter(r =>
    (filter === 'all' || r.status === filter) &&
    (!search.trim() || r.name.toLowerCase().includes(search.trim().toLowerCase())))

  const target =
    a.target_type === 'school_wide' ? 'All students'
    : a.target_type === 'class_node' ? (a.class_node_name ?? 'A class')
    : a.target_type === 'programme_level' ? (a.programme_level_label ?? 'A programme level')
    : (a.student_name ?? 'One student')
  const termName = a.term_id ? (terms.find(t => t.id === a.term_id)?.name ?? '') : 'Whole session'

  async function restore(r: CoverageRow) {
    setBusyId(r.studentId)
    const res = await removeExemption(a, r.studentId)
    setBusyId(null)
    if (!res.ok) { setNotice(res.error); return }
    setNotice(`${r.name} is billed for this fee again.`)
    await reloadCoverage()
    await onChanged()
  }

  async function saveDetails() {
    setFormMsg(null)
    setSaving(true)
    const res = await updateAssignmentDetails({
      schoolId, assignment: a, amount: Number(amount), dueDate: dueDate || null,
      termId: termId || null, reason, staffId,
    })
    setSaving(false)
    if (!res.ok) { setFormMsg({ ok: false, text: res.error }); return }
    setFormMsg({ ok: true, text: 'Saved.' })
    setReason('')
    await onChanged()
    await reloadCoverage()
  }

  const dirty = Number(amount) !== a.amount || (dueDate || null) !== (a.due_date ?? null) || (termId || null) !== (a.term_id ?? null)

  return (
    <div className="fad">
      <button type="button" className="fad-back" onClick={onBack}>← All assignments</button>

      <div className="fad-head">
        <div>
          <h3 className="fad-title">{a.fee_head_name}</h3>
          <p className="fad-sub">{target} · {termName}{a.due_date ? ` · due ${formatDate(a.due_date)}` : ''}</p>
        </div>
        <span className="fad-amount">{formatNaira(a.amount)}</span>
      </div>

      <div className="fad-stats">
        <div className="fad-stat"><span>Students</span><strong>{totals.count}</strong></div>
        <div className="fad-stat"><span>Billed</span><strong>{formatNaira(totals.billed)}</strong></div>
        <div className="fad-stat"><span>Collected</span><strong>{formatNaira(totals.collected)}</strong></div>
        <div className={`fad-stat${totals.outstanding > 0 ? ' fad-stat--warn' : ''}`}><span>Outstanding</span><strong>{formatNaira(totals.outstanding)}</strong></div>
        {totals.credit > 0 && <div className="fad-stat fad-stat--ok"><span>Credit held</span><strong>{formatNaira(totals.credit)}</strong></div>}
      </div>

      {notice && <p className="fma-notice" role="status">{notice} <button type="button" className="fma-link" onClick={() => setNotice('')}>Dismiss</button></p>}

      <div className="fad-tabs" role="tablist">
        {(['students', 'details', 'activity'] as Tab[]).map(t => (
          <button key={t} type="button" role="tab" aria-selected={tab === t}
            className={`fad-tab${tab === t ? ' fad-tab--on' : ''}`} onClick={() => setTab(t)}>
            {t === 'students' ? 'Students' : t === 'details' ? 'Details' : 'Activity'}
          </button>
        ))}
      </div>

      {tab === 'students' && (
        <div className="fad-pane">
          <div className="fad-toolbar">
            <input className="fma-input" placeholder="Search a student…" value={search} onChange={e => setSearch(e.target.value)} />
            <select className="fma-input fad-filter" value={filter} onChange={e => setFilter(e.target.value as StatusFilter)} aria-label="Filter by status">
              <option value="all">All ({rows?.length ?? 0})</option>
              {(Object.keys(STATUS_LABEL) as CoverageRow['status'][]).map(k => counts[k]
                ? <option key={k} value={k}>{STATUS_LABEL[k]} ({counts[k]})</option> : null)}
            </select>
          </div>
          {(canManage || canWaive) && (
            <div className="fad-bulk">
              {canWaive && <button type="button" className="fma-tbtn" onClick={() => setDialog({ action: 'waive' })}>Waive for a class / everyone…</button>}
              {canManage && <button type="button" className="fma-tbtn" onClick={() => setDialog({ action: 'exempt' })}>Exempt a class / everyone…</button>}
            </div>
          )}

          {rows === null ? (
            <div className="fin-list-skel">{[1, 2, 3].map(i => <div key={i} className="fin-row-skel skeleton" />)}</div>
          ) : coverageError ? (
            <p className="fma-error">{coverageError}</p>
          ) : visible.length === 0 ? (
            <p className="fad-empty">{rows.length === 0 ? 'No active students are covered by this fee.' : 'No students match.'}</p>
          ) : (
            <ul className="fad-list">
              {visible.map(r => (
                <li key={r.studentId} className="fad-row">
                  <div className="fad-row-main">
                    <span className="fad-row-name">{r.name}</span>
                    <span className="fad-row-meta">
                      {r.className ? `${r.className} · ` : ''}paid {formatNaira(r.paid)}
                      {r.discount > 0 ? ` · waived ${formatNaira(r.discount)}` : ''}
                      {r.owed > 0 ? ` · owes ${formatNaira(r.owed)}` : ''}
                      {r.credit > 0 ? ` · credit ${formatNaira(r.credit)}` : ''}
                    </span>
                  </div>
                  <span className={`fad-chip fad-chip--${r.status}`}>{STATUS_LABEL[r.status]}</span>
                  <div className="fad-row-actions">
                    {canWaive && !r.exempt && r.owed > 0 && (
                      <button type="button" className="fad-act" onClick={() => setDialog({ action: 'waive', student: { id: r.studentId, full_name: r.name } })}>Waive</button>
                    )}
                    {canManage && !r.exempt && (
                      <button type="button" className="fad-act" onClick={() => setDialog({ action: 'exempt', student: { id: r.studentId, full_name: r.name } })}>Exempt</button>
                    )}
                    {canManage && r.exempt && (
                      <button type="button" className="fad-act" disabled={busyId === r.studentId} onClick={() => void restore(r)}>
                        {busyId === r.studentId ? '…' : 'Bill again'}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {tab === 'details' && (
        <div className="fad-pane">
          {canManage ? (
            <>
              <div className="fad-form">
                <label>Amount (₦)
                  <input className="fma-input" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} />
                </label>
                <label>Due date
                  <input className="fma-input" type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} />
                </label>
                {terms.length > 0 && (
                  <label>Term
                    <select className="fma-input" value={termId} onChange={e => setTermId(e.target.value)}>
                      <option value="">Whole session</option>
                      {terms.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                  </label>
                )}
                {Number(amount) !== a.amount && (
                  <label>Reason for changing the amount
                    <input className="fma-input" value={reason} onChange={e => setReason(e.target.value)} placeholder="Kept in the audit log" />
                  </label>
                )}
              </div>
              <p className="fma-hint">Who this fee applies to ({target}) is fixed. To bill different students, add a new assignment and unassign this one.</p>
              {formMsg && <p className={formMsg.ok ? 'fma-notice' : 'fma-error'} role="status">{formMsg.text}</p>}
              <div className="fma-actions">
                <button type="button" className="obl-btn obl-btn--primary" disabled={!dirty || saving} onClick={() => void saveDetails()}>
                  {saving ? 'Saving…' : 'Save changes'}
                </button>
              </div>
              <div className="fad-danger">
                <div>
                  <strong>Unassign this fee</strong>
                  <p className="fma-hint">Removes it from billing and keeps it in the history. Not possible once payments exist — waive or exempt instead.</p>
                </div>
                <button type="button" className="fma-tbtn fma-tbtn--danger" onClick={() => setDialog({ action: 'unassign' })}>Unassign…</button>
              </div>
            </>
          ) : (
            <p className="fad-empty">You can view this fee but not change it.</p>
          )}
        </div>
      )}

      {tab === 'activity' && (
        <div className="fad-pane">
          {activity === null ? (
            <div className="fin-list-skel"><div className="fin-row-skel skeleton" /></div>
          ) : activity.length === 0 ? (
            <p className="fad-empty">No changes have been made to this fee yet.</p>
          ) : (
            <ul className="fma-history-list">
              {activity.map(r => (
                <li key={r.id} className="fma-history-item">
                  <div className="fma-history-top">
                    <strong>{ACTION_LABEL[r.action]}{r.failed ? ' (failed)' : ''}</strong>
                    <span>{new Date(r.performed_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}{r.performed_by_name ? ` · ${r.performed_by_name}` : ''}</span>
                  </div>
                  <span className="fma-history-meta">{r.scopeLabel} · {r.students_count} student{r.students_count === 1 ? '' : 's'}{r.total_amount !== null ? ` · ${formatNaira(Math.abs(r.total_amount))}` : ''}</span>
                  <span className="fma-history-meta">“{r.reason}”</span>
                  {r.undone_at && <span className="fma-history-undone">Undone {new Date(r.undone_at).toLocaleDateString()}</span>}
                </li>
              ))}
            </ul>
          )}
          <p className="fma-hint">Undo is in the “Mass action history” list on the Assignments screen.</p>
        </div>
      )}

      {dialog && (
        <FeeMassActionDialog
          open
          action={dialog.action}
          assignments={[a]}
          schoolId={schoolId}
          staffId={staffId}
          classes={classes}
          presetStudent={dialog.student}
          onClose={() => setDialog(null)}
          onDone={async summary => {
            const wasUnassign = dialog.action === 'unassign'
            setDialog(null)
            setNotice(summary)
            await onChanged()
            if (wasUnassign) { onBack(); return }
            await reloadCoverage()
            if (tab === 'activity') await reloadActivity()
          }}
        />
      )}
    </div>
  )
}
