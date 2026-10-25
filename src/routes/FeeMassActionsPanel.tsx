import { useEffect, useState } from 'react'
import { Modal } from '../components/Modal'
import { supabase } from '../lib/supabase'
import { formatNaira, type ClassNode, type FeeAssignment } from '../services/financeService'
import {
  applyMassAction,
  loadFeeActionLog,
  newAmountFor,
  previewMassAction,
  undoMassAction,
  type AmountSpec,
  type FeeActionLogRow,
  type MassAction,
  type MassPreview,
  type StudentScope,
  type WaiveSpec,
} from '../services/feeMassActionsService'

/**
 * Mass actions on fee assignments — the dialog (choose → preview → confirm)
 * and the history list with Undo. State and permissions live in the Finance
 * module; this file only draws and calls the service.
 */

const ACTION_TITLE: Record<MassAction, string> = {
  edit_amount: 'Edit amount',
  waive: 'Waive',
  exempt: 'Exempt',
  unassign: 'Unassign',
}

export function FeeMassActionDialog({
  open,
  action,
  assignments,
  schoolId,
  staffId,
  classes,
  onClose,
  onDone,
}: {
  open: boolean
  action: MassAction
  assignments: FeeAssignment[]
  schoolId: string
  staffId: string | null
  classes: ClassNode[]
  onClose: () => void
  onDone: (summary: string) => void
}) {
  const [scopeType, setScopeType] = useState<'school' | 'class' | 'student'>('school')
  const [classId, setClassId] = useState('')
  const [studentQuery, setStudentQuery] = useState('')
  const [studentHits, setStudentHits] = useState<Array<{ id: string; full_name: string }>>([])
  const [student, setStudent] = useState<{ id: string; full_name: string } | null>(null)
  const [waiveKind, setWaiveKind] = useState<WaiveSpec['kind']>('full')
  const [waiveValue, setWaiveValue] = useState('')
  const [amountMode, setAmountMode] = useState<AmountSpec['mode']>('set')
  const [amountValue, setAmountValue] = useState('')
  const [reason, setReason] = useState('')
  const [preview, setPreview] = useState<MassPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // Fresh form each time the dialog opens.
  useEffect(() => {
    if (!open) return
    setScopeType('school'); setClassId(''); setStudentQuery(''); setStudentHits([]); setStudent(null)
    setWaiveKind('full'); setWaiveValue(''); setAmountMode('set'); setAmountValue('')
    setReason(''); setPreview(null); setError('')
  }, [open, action])

  // Student search (scope = one student).
  useEffect(() => {
    if (scopeType !== 'student' || studentQuery.trim().length < 2) { setStudentHits([]); return }
    let cancelled = false
    const t = setTimeout(async () => {
      const { data } = await supabase
        .from('students')
        .select('id, full_name')
        .eq('school_id', schoolId)
        .eq('status', 'active')
        .ilike('full_name', `%${studentQuery.trim()}%`)
        .order('full_name')
        .limit(8)
      if (!cancelled) setStudentHits((data ?? []) as Array<{ id: string; full_name: string }>)
    }, 250)
    return () => { cancelled = true; clearTimeout(t) }
  }, [studentQuery, scopeType, schoolId])

  const needsScope = action === 'waive' || action === 'exempt'

  function buildScope(): StudentScope | null {
    if (!needsScope || scopeType === 'school') return { type: 'school' }
    if (scopeType === 'class') {
      const c = classes.find(x => x.id === classId)
      return c ? { type: 'class', classNodeId: c.id, label: c.path_label ?? c.name } : null
    }
    return student ? { type: 'student', studentId: student.id, label: student.full_name } : null
  }

  function buildRequest() {
    const scope = buildScope()
    if (!scope) return null
    const waive: WaiveSpec | undefined = action === 'waive'
      ? (waiveKind === 'full' ? { kind: 'full' } : { kind: waiveKind, value: Number(waiveValue) })
      : undefined
    const amount: AmountSpec | undefined = action === 'edit_amount'
      ? { mode: amountMode, value: Number(amountValue) }
      : undefined
    return { schoolId, action, assignments, scope, waive, amount, reason }
  }

  async function runPreview() {
    setError('')
    const req = buildRequest()
    if (!req) { setError(scopeType === 'class' ? 'Choose a class.' : 'Choose a student.'); return }
    setBusy(true)
    const res = await previewMassAction(req)
    setBusy(false)
    if (!res.ok) { setError(res.error); setPreview(null); return }
    setPreview(res.data)
  }

  async function confirm() {
    const req = buildRequest()
    if (!req) return
    setBusy(true)
    const res = await applyMassAction(req, staffId)
    setBusy(false)
    if (!res.ok) { setError(res.error); return }
    onDone(res.data.summary)
  }

  const changed = () => { setPreview(null); setError('') }
  const sample = assignments.slice(0, 3).map(a => `${a.fee_head_name} (${formatNaira(a.amount)})`).join(', ')

  return (
    <Modal open={open} onClose={onClose} title={`${ACTION_TITLE[action]} — ${assignments.length} fee${assignments.length === 1 ? '' : 's'}`} maxWidth="560px">
      <div className="fma">
        <p className="fma-sub">{sample}{assignments.length > 3 ? ` and ${assignments.length - 3} more` : ''}</p>

        {needsScope && (
          <fieldset className="fma-group">
            <legend>Who does this apply to?</legend>
            <label><input type="radio" checked={scopeType === 'school'} onChange={() => { setScopeType('school'); changed() }} /> Everyone these fees cover</label>
            <label><input type="radio" checked={scopeType === 'class'} onChange={() => { setScopeType('class'); changed() }} /> One class</label>
            {scopeType === 'class' && (
              <select className="fma-input" value={classId} onChange={e => { setClassId(e.target.value); changed() }}>
                <option value="">Choose a class…</option>
                {classes.map(c => <option key={c.id} value={c.id}>{c.path_label ?? c.name}</option>)}
              </select>
            )}
            <label><input type="radio" checked={scopeType === 'student'} onChange={() => { setScopeType('student'); changed() }} /> One student</label>
            {scopeType === 'student' && (
              <div>
                {student ? (
                  <p className="fma-picked">{student.full_name} <button type="button" className="fma-link" onClick={() => { setStudent(null); changed() }}>change</button></p>
                ) : (
                  <>
                    <input className="fma-input" value={studentQuery} onChange={e => setStudentQuery(e.target.value)} placeholder="Search student name…" />
                    {studentHits.length > 0 && (
                      <ul className="fma-hits">
                        {studentHits.map(h => (
                          <li key={h.id}><button type="button" onClick={() => { setStudent(h); setStudentHits([]); changed() }}>{h.full_name}</button></li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </div>
            )}
          </fieldset>
        )}

        {action === 'waive' && (
          <fieldset className="fma-group">
            <legend>Waive</legend>
            <label><input type="radio" checked={waiveKind === 'full'} onChange={() => { setWaiveKind('full'); changed() }} /> Full amount</label>
            <label><input type="radio" checked={waiveKind === 'percentage'} onChange={() => { setWaiveKind('percentage'); changed() }} /> A percentage</label>
            <label><input type="radio" checked={waiveKind === 'fixed'} onChange={() => { setWaiveKind('fixed'); changed() }} /> A fixed amount (₦) off each fee</label>
            {waiveKind !== 'full' && (
              <input className="fma-input" inputMode="decimal" value={waiveValue}
                onChange={e => { setWaiveValue(e.target.value.replace(/[^0-9.]/g, '')); changed() }}
                placeholder={waiveKind === 'percentage' ? 'e.g. 50' : 'e.g. 5000'} />
            )}
          </fieldset>
        )}

        {action === 'edit_amount' && (
          <fieldset className="fma-group">
            <legend>New amount</legend>
            <label><input type="radio" checked={amountMode === 'set'} onChange={() => { setAmountMode('set'); changed() }} /> Set to an amount (₦)</label>
            <label><input type="radio" checked={amountMode === 'adjust_percent'} onChange={() => { setAmountMode('adjust_percent'); changed() }} /> Raise or lower by a percentage</label>
            <label><input type="radio" checked={amountMode === 'adjust_fixed'} onChange={() => { setAmountMode('adjust_fixed'); changed() }} /> Raise or lower by an amount (₦)</label>
            <input className="fma-input" inputMode="decimal" value={amountValue}
              onChange={e => { setAmountValue(e.target.value.replace(/[^0-9.\-]/g, '')); changed() }}
              placeholder={amountMode === 'set' ? 'e.g. 45000' : 'e.g. 10 or -10'} />
            {amountValue !== '' && Number.isFinite(Number(amountValue)) && assignments.length > 0 && (
              <p className="fma-hint">
                {assignments[0].fee_head_name}: {formatNaira(assignments[0].amount)} → {formatNaira(newAmountFor(assignments[0].amount, { mode: amountMode, value: Number(amountValue) }))}
              </p>
            )}
          </fieldset>
        )}

        {action === 'unassign' && (
          <p className="fma-hint">The fee is removed from billing but kept in the history, so it can be restored with Undo. Fees that already have payments cannot be unassigned.</p>
        )}

        <label className="fma-reason">
          Reason (kept in the audit log)
          <input className="fma-input" value={reason} onChange={e => { setReason(e.target.value); changed() }} placeholder="e.g. Staff-child discount approved by the proprietor" />
        </label>

        {error && <p className="fma-error" role="alert">{error}</p>}

        {preview && (
          <div className="fma-preview">
            <p className="fma-preview-title">This will:</p>
            <ul>
              <li>Affect <strong>{preview.assignmentsCount}</strong> fee{preview.assignmentsCount === 1 ? '' : 's'} across <strong>{preview.studentsCount}</strong> student{preview.studentsCount === 1 ? '' : 's'}</li>
              <li>
                {action === 'edit_amount' ? 'Change the total billed by' : action === 'unassign' ? 'Remove from billing' : action === 'waive' ? 'Waive' : 'Stop billing'}
                {' '}<strong>{formatNaira(Math.abs(preview.totalAmount))}</strong>
                {action === 'edit_amount' && preview.totalAmount < 0 ? ' (a reduction)' : ''}
              </li>
              {preview.creditStudents > 0 && (
                <li><strong>{preview.creditStudents}</strong> student{preview.creditStudents === 1 ? '' : 's'} will hold a credit of <strong>{formatNaira(preview.creditTotal)}</strong> in total</li>
              )}
            </ul>
            {preview.blocked.length > 0 && (
              <p className="fma-warn">Blocked: {preview.blocked.map(b => b.assignment.fee_head_name).join(', ')} — {preview.blocked[0].reason.toLowerCase()}.</p>
            )}
            {preview.notes.map(n => <p key={n} className="fma-note">{n}</p>)}
          </div>
        )}

        <div className="fma-actions">
          {!preview ? (
            <button type="button" className="obl-btn obl-btn--primary" disabled={busy} onClick={() => void runPreview()}>
              {busy ? 'Checking…' : 'Preview'}
            </button>
          ) : (
            <button type="button" className="obl-btn obl-btn--primary" disabled={busy || preview.assignmentsCount === 0} onClick={() => void confirm()}>
              {busy ? 'Applying…' : `Confirm ${ACTION_TITLE[action].toLowerCase()}`}
            </button>
          )}
          <button type="button" className="obl-btn" disabled={busy} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </Modal>
  )
}

export function FeeActionHistory({
  schoolId,
  staffId,
  refreshKey,
  onUndone,
}: {
  schoolId: string
  staffId: string | null
  refreshKey: number
  onUndone: () => void
}) {
  const [rows, setRows] = useState<FeeActionLogRow[]>([])
  const [open, setOpen] = useState(false)
  const [msg, setMsg] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void loadFeeActionLog(schoolId).then(res => { if (!cancelled && res.ok) setRows(res.data) })
    return () => { cancelled = true }
  }, [schoolId, refreshKey])

  async function undo(id: string) {
    setBusyId(id)
    const res = await undoMassAction(id, staffId)
    setBusyId(null)
    setMsg(res.ok ? res.data : res.error)
    if (res.ok) {
      const fresh = await loadFeeActionLog(schoolId)
      if (fresh.ok) setRows(fresh.data)
      onUndone()
    }
  }

  if (rows.length === 0) return null
  const fmt = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

  return (
    <div className="fma-history">
      <button type="button" className="fma-history-head" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <span>Mass action history ({rows.length})</span><span aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <ul className="fma-history-list">
          {rows.map(r => (
            <li key={r.id} className="fma-history-item">
              <div className="fma-history-top">
                <strong>{ACTION_TITLE[r.action]}{r.failed ? ' (failed)' : ''}</strong>
                <span>{fmt(r.performed_at)}{r.performed_by_name ? ` · ${r.performed_by_name}` : ''}</span>
              </div>
              <span className="fma-history-meta">
                {r.assignments_count} fee{r.assignments_count === 1 ? '' : 's'} · {r.students_count} student{r.students_count === 1 ? '' : 's'} · {r.scopeLabel}
                {r.total_amount !== null ? ` · ${formatNaira(Math.abs(r.total_amount))}` : ''}
              </span>
              <span className="fma-history-meta">“{r.reason}”</span>
              {r.undone_at ? (
                <span className="fma-history-undone">Undone {fmt(r.undone_at)}{r.undone_by_name ? ` by ${r.undone_by_name}` : ''}</span>
              ) : (
                <button type="button" className="obl-btn obl-btn--inline" disabled={busyId === r.id} onClick={() => void undo(r.id)}>
                  {busyId === r.id ? 'Undoing…' : 'Undo'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {msg && <p className="fma-note" role="status">{msg}</p>}
    </div>
  )
}
