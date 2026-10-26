import { useCallback, useEffect, useMemo, useState } from 'react'
import { Modal } from '../components/Modal'
import { formatNaira } from '../services/financeService'
import {
  accountStatement, backfillPayments, draftTotals, loadAccounts, loadJournal, loadLedgerEnabled,
  postEntry, reverseEntry, saveAccount, setLedgerEnabled, trialBalance,
  type Account, type AccountType, type DraftLine, type JournalEntry, type StatementLine, type TrialRow,
} from '../services/ledgerService'

/**
 * Finance → Ledger. Three views — Journal, Accounts, Trial balance — over one
 * date range. Entries are never edited: a mistake is fixed with a reversal.
 */

type View = 'journal' | 'accounts' | 'trial'
type RangeKey = 'month' | 'quarter' | 'year' | 'custom'

const TYPE_LABEL: Record<AccountType, string> = {
  asset: 'Assets', liability: 'Liabilities', equity: 'Equity', income: 'Income', expense: 'Expenses',
}
const TYPES: AccountType[] = ['asset', 'liability', 'equity', 'income', 'expense']
const SOURCE_LABEL: Record<string, string> = { payment: 'Fee payment', payment_refund: 'Refund', reversal: 'Reversal', manual: 'Manual' }

const ymd = (d: Date) => [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-')
const fmtDate = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

function rangeFor(key: RangeKey, custom: { from: string; to: string }) {
  const now = new Date()
  if (key === 'month') return { from: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), to: ymd(now) }
  if (key === 'quarter') return { from: ymd(new Date(now.getFullYear(), now.getMonth() - 2, 1)), to: ymd(now) }
  if (key === 'year') return { from: ymd(new Date(now.getFullYear(), 0, 1)), to: ymd(now) }
  return custom
}

export default function FinanceLedger({ schoolId, isAdmin, canPost }: { schoolId: string; isAdmin: boolean; canPost: boolean }) {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [view, setView] = useState<View>('journal')
  const [rangeKey, setRangeKey] = useState<RangeKey>('month')
  const [custom, setCustom] = useState({ from: '', to: '' })
  const [entries, setEntries] = useState<JournalEntry[] | null>(null)
  const [trial, setTrial] = useState<TrialRow[] | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [composing, setComposing] = useState(false)
  const [editingAccount, setEditingAccount] = useState<Partial<Account> | null>(null)
  const [statement, setStatement] = useState<{ account: Account; lines: StatementLine[] } | null>(null)
  const [busy, setBusy] = useState(false)

  const range = useMemo(() => rangeFor(rangeKey, custom), [rangeKey, custom])
  const rangeOk = !!range.from && !!range.to && range.from <= range.to

  useEffect(() => { void loadLedgerEnabled(schoolId).then(setEnabled) }, [schoolId])

  const reloadAccounts = useCallback(async () => {
    const res = await loadAccounts(schoolId)
    if (res.ok) setAccounts(res.data); else setError(res.error)
  }, [schoolId])

  const reloadData = useCallback(async () => {
    if (!enabled || !rangeOk) return
    setError('')
    if (view === 'journal') {
      setEntries(null)
      const res = await loadJournal(schoolId, range.from, range.to)
      if (res.ok) setEntries(res.data); else { setEntries([]); setError(res.error) }
    } else if (view === 'trial') {
      setTrial(null)
      const res = await trialBalance(range.from, range.to)
      if (res.ok) setTrial(res.data); else { setTrial([]); setError(res.error) }
    }
  }, [enabled, rangeOk, view, schoolId, range.from, range.to])

  useEffect(() => { if (enabled) void reloadAccounts() }, [enabled, reloadAccounts])
  useEffect(() => { void reloadData() }, [reloadData])

  async function turnOn() {
    setBusy(true); setError('')
    const res = await setLedgerEnabled(true)
    setBusy(false)
    if (!res.ok) { setError(res.error); return }
    setEnabled(true)
  }

  async function postPast() {
    setBusy(true); setError('')
    const res = await backfillPayments()
    setBusy(false)
    if (!res.ok) { setError(res.error); return }
    setNotice(res.data === 0 ? 'Every completed payment is already in the ledger.' : `${res.data} past payment${res.data === 1 ? '' : 's'} posted to the ledger.`)
    await reloadData()
  }

  async function reverse(e: JournalEntry) {
    if (!window.confirm(`Reverse "${e.description}"? A new opposite entry is posted; the original stays in the history.`)) return
    const res = await reverseEntry(e.id)
    if (!res.ok) { setError(res.error); return }
    setNotice('Reversal posted.')
    await reloadData()
  }

  async function openStatement(acc: Account) {
    if (!rangeOk) return
    const res = await accountStatement(acc, range.from, range.to)
    if (!res.ok) { setError(res.error); return }
    setStatement({ account: acc, lines: res.data })
  }

  if (enabled === null) return <div className="fin-list-skel"><div className="fin-row-skel skeleton" /></div>

  if (!enabled) {
    return (
      <div className="fl-gate">
        <h3>The ledger is switched off</h3>
        <p>Fee collection works fine without it. Switch it on to keep full double-entry books: every payment is posted automatically, you can record expenses and other income yourself, and you get a trial balance and account statements.</p>
        {isAdmin ? (
          <>
            <button type="button" className="obl-btn obl-btn--primary" disabled={busy} onClick={() => void turnOn()}>
              {busy ? 'Switching on…' : 'Switch the ledger on'}
            </button>
            <p className="fma-hint">A starter chart of accounts is added for you, and you can change it afterwards. Payments recorded before now can be posted with one click.</p>
          </>
        ) : (
          <p className="fma-hint">Ask an administrator to switch it on.</p>
        )}
        {error && <p className="fma-error">{error}</p>}
      </div>
    )
  }

  const activeAccounts = accounts.filter(a => a.is_active)

  return (
    <div className="fl">
      <div className="fl-top">
        <div className="fl-seg" role="tablist">
          {([['journal', 'Journal'], ['accounts', 'Accounts'], ['trial', 'Trial balance']] as [View, string][]).map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={view === k}
              className={`fl-seg-btn${view === k ? ' fl-seg-btn--on' : ''}`} onClick={() => setView(k)}>{label}</button>
          ))}
        </div>
        {view !== 'accounts' && (
          <div className="fl-range">
            {([['month', 'This month'], ['quarter', '3 months'], ['year', 'This year'], ['custom', 'Custom']] as [RangeKey, string][]).map(([k, label]) => (
              <button key={k} type="button" className={`fin-status-chip${rangeKey === k ? ' fin-status-chip--on' : ''}`} onClick={() => setRangeKey(k)}>{label}</button>
            ))}
            {rangeKey === 'custom' && (
              <span className="fin-period-range">
                <input type="date" className="fin-period-date" value={custom.from} onChange={e => setCustom(c => ({ ...c, from: e.target.value }))} aria-label="From" />
                <span>to</span>
                <input type="date" className="fin-period-date" value={custom.to} onChange={e => setCustom(c => ({ ...c, to: e.target.value }))} aria-label="To" />
              </span>
            )}
          </div>
        )}
      </div>

      {notice && <p className="fma-notice" role="status">{notice} <button type="button" className="fma-link" onClick={() => setNotice('')}>Dismiss</button></p>}
      {error && <p className="fma-error" role="alert">{error}</p>}

      {view === 'journal' && (
        <>
          {canPost && (
            <div className="fl-actions">
              <button type="button" className="obl-btn obl-btn--primary" onClick={() => setComposing(true)}>+ New entry</button>
              <button type="button" className="obl-btn" disabled={busy} onClick={() => void postPast()}>{busy ? 'Posting…' : 'Post past payments'}</button>
            </div>
          )}
          {!rangeOk ? <p className="fad-empty">Pick a start and end date.</p>
            : entries === null ? <div className="fin-list-skel">{[1, 2, 3].map(i => <div key={i} className="fin-row-skel skeleton" />)}</div>
            : entries.length === 0 ? <p className="fad-empty">No entries in this period. Payments post here automatically; you can add your own with “New entry”.</p>
            : (
              <ul className="fl-entries">
                {entries.map(e => {
                  const isOpen = open.has(e.id)
                  return (
                    <li key={e.id} className="fl-entry">
                      <button type="button" className="fl-entry-head" aria-expanded={isOpen}
                        onClick={() => setOpen(prev => { const n = new Set(prev); if (n.has(e.id)) n.delete(e.id); else n.add(e.id); return n })}>
                        <span className="fl-entry-date">{fmtDate(e.entry_date)}</span>
                        <span className="fl-entry-desc">{e.description}</span>
                        <span className="fl-entry-src">{SOURCE_LABEL[e.source_type ?? 'manual'] ?? e.source_type}</span>
                        <strong className="fl-entry-amt">{formatNaira(e.total)}</strong>
                      </button>
                      {isOpen && (
                        <div className="fl-entry-body">
                          <table className="fl-lines">
                            <thead><tr><th>Account</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
                            <tbody>
                              {e.lines.map(l => (
                                <tr key={l.id}>
                                  <td>{l.account_code} · {l.account_name}{l.memo ? <span className="fl-memo"> — {l.memo}</span> : null}</td>
                                  <td className="num">{l.debit ? formatNaira(l.debit) : ''}</td>
                                  <td className="num">{l.credit ? formatNaira(l.credit) : ''}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          {canPost && e.source_type !== 'reversal' && (
                            <button type="button" className="fma-link" onClick={() => void reverse(e)}>Reverse this entry</button>
                          )}
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
        </>
      )}

      {view === 'accounts' && (
        <>
          {canPost && <div className="fl-actions"><button type="button" className="obl-btn obl-btn--primary" onClick={() => setEditingAccount({ account_type: 'expense' })}>+ Add account</button></div>}
          {TYPES.map(t => {
            const list = accounts.filter(a => a.account_type === t)
            if (list.length === 0) return null
            return (
              <section key={t} className="fl-group">
                <h4 className="fl-group-title">{TYPE_LABEL[t]}</h4>
                <ul className="fad-list">
                  {list.map(a => (
                    <li key={a.id} className={`fad-row${a.is_active ? '' : ' fl-off'}`}>
                      <button type="button" className="fl-acc" onClick={() => void openStatement(a)} disabled={!rangeOk}>
                        <span className="fl-acc-code">{a.code}</span><span>{a.name}</span>
                      </button>
                      {!a.is_active && <span className="fad-chip">Off</span>}
                      {canPost && <button type="button" className="fad-act" onClick={() => setEditingAccount(a)}>Edit</button>}
                    </li>
                  ))}
                </ul>
              </section>
            )
          })}
          <p className="fma-hint">Click an account to see its statement for the date range on the Journal and Trial balance views.</p>
        </>
      )}

      {view === 'trial' && (
        !rangeOk ? <p className="fad-empty">Pick a start and end date.</p>
        : trial === null ? <div className="fin-list-skel"><div className="fin-row-skel skeleton" /></div>
        : (() => {
          const rows = trial.filter(r => r.debit !== 0 || r.credit !== 0)
          const d = rows.reduce((n, r) => n + r.debit, 0), c = rows.reduce((n, r) => n + r.credit, 0)
          if (rows.length === 0) return <p className="fad-empty">No postings in this period yet.</p>
          return (
            <>
              <table className="fl-lines fl-trial">
                <thead><tr><th>Account</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.account_id}>
                      <td><button type="button" className="fl-acc" onClick={() => { const a = accounts.find(x => x.id === r.account_id); if (a) void openStatement(a) }}>
                        <span className="fl-acc-code">{r.code}</span><span>{r.name}</span></button></td>
                      <td className="num">{r.debit ? formatNaira(r.debit) : ''}</td>
                      <td className="num">{r.credit ? formatNaira(r.credit) : ''}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr><th>Total</th><th className="num">{formatNaira(d)}</th><th className="num">{formatNaira(c)}</th></tr></tfoot>
              </table>
              <p className={Math.abs(d - c) < 0.005 ? 'fma-notice' : 'fma-error'}>
                {Math.abs(d - c) < 0.005 ? 'Debits equal credits — the books balance.' : `Out of balance by ${formatNaira(Math.abs(d - c))}. Please check recent entries.`}
              </p>
            </>
          )
        })()
      )}

      {composing && (
        <EntryForm accounts={activeAccounts} onClose={() => setComposing(false)}
          onPosted={async () => { setComposing(false); setNotice('Entry posted.'); await reloadData() }} />
      )}

      {editingAccount && (
        <AccountForm schoolId={schoolId} initial={editingAccount} onClose={() => setEditingAccount(null)}
          onSaved={async () => { setEditingAccount(null); await reloadAccounts() }} />
      )}

      {statement && (
        <Modal open onClose={() => setStatement(null)} title={`${statement.account.code} · ${statement.account.name}`} maxWidth="640px">
          <p className="fma-hint">{fmtDate(range.from)} – {fmtDate(range.to)}</p>
          {statement.lines.length === 0 ? <p className="fad-empty">Nothing posted to this account in this period.</p> : (
            <table className="fl-lines">
              <thead><tr><th>Date</th><th>Description</th><th className="num">Debit</th><th className="num">Credit</th><th className="num">Balance</th></tr></thead>
              <tbody>
                {statement.lines.map((l, i) => (
                  <tr key={i}>
                    <td>{fmtDate(l.entry_date)}</td><td>{l.description}</td>
                    <td className="num">{l.debit ? formatNaira(l.debit) : ''}</td>
                    <td className="num">{l.credit ? formatNaira(l.credit) : ''}</td>
                    <td className="num">{formatNaira(l.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Modal>
      )}
    </div>
  )
}

function EntryForm({ accounts, onClose, onPosted }: { accounts: Account[]; onClose: () => void; onPosted: () => void | Promise<void> }) {
  const blank = (): DraftLine => ({ account_id: '', debit: '', credit: '', memo: '' })
  const [date, setDate] = useState(ymd(new Date()))
  const [description, setDescription] = useState('')
  const [lines, setLines] = useState<DraftLine[]>([blank(), blank()])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const totals = draftTotals(lines)
  const set = (i: number, patch: Partial<DraftLine>) => setLines(prev => prev.map((l, k) => (k === i ? { ...l, ...patch } : l)))
  const money = (v: string) => v.replace(/[^0-9.]/g, '')

  async function submit() {
    setSaving(true); setError('')
    const res = await postEntry(date, description, lines)
    setSaving(false)
    if (!res.ok) { setError(res.error); return }
    await onPosted()
  }

  return (
    <Modal open onClose={onClose} title="New journal entry" maxWidth="680px">
      <div className="fma">
        <div className="fad-form">
          <label>Date<input className="fma-input" type="date" value={date} onChange={e => setDate(e.target.value)} /></label>
          <label>What is this for?<input className="fma-input" value={description} onChange={e => setDescription(e.target.value)} placeholder="e.g. Generator fuel, October" /></label>
        </div>
        <table className="fl-lines fl-compose">
          <thead><tr><th>Account</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td>
                  <select className="fma-input" value={l.account_id} onChange={e => set(i, { account_id: e.target.value })} aria-label={`Account for line ${i + 1}`}>
                    <option value="">Choose account…</option>
                    {accounts.map(a => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
                  </select>
                  <input className="fma-input fl-memo-in" value={l.memo} onChange={e => set(i, { memo: e.target.value })} placeholder="Note (optional)" />
                </td>
                <td className="num"><input className="fma-input num" inputMode="decimal" value={l.debit} onChange={e => set(i, { debit: money(e.target.value), credit: e.target.value ? '' : l.credit })} /></td>
                <td className="num"><input className="fma-input num" inputMode="decimal" value={l.credit} onChange={e => set(i, { credit: money(e.target.value), debit: e.target.value ? '' : l.debit })} /></td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr><th>Total</th><th className="num">{formatNaira(totals.debit)}</th><th className="num">{formatNaira(totals.credit)}</th></tr></tfoot>
        </table>
        <button type="button" className="fma-link" onClick={() => setLines(p => [...p, blank()])}>+ Add a line</button>
        <p className={totals.balanced ? 'fma-notice' : 'fma-hint'}>
          {totals.balanced ? 'Balanced — ready to post.' : totals.debit || totals.credit ? `Out by ${formatNaira(Math.abs(totals.debit - totals.credit))} — debits and credits must be equal.` : 'Enter amounts on at least two lines.'}
        </p>
        {error && <p className="fma-error" role="alert">{error}</p>}
        <div className="fma-actions">
          <button type="button" className="obl-btn obl-btn--primary" disabled={saving || !totals.balanced || description.trim().length < 2} onClick={() => void submit()}>{saving ? 'Posting…' : 'Post entry'}</button>
          <button type="button" className="obl-btn" disabled={saving} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </Modal>
  )
}

function AccountForm({ schoolId, initial, onClose, onSaved }: { schoolId: string; initial: Partial<Account>; onClose: () => void; onSaved: () => void | Promise<void> }) {
  const [code, setCode] = useState(initial.code ?? '')
  const [name, setName] = useState(initial.name ?? '')
  const [type, setType] = useState<AccountType>(initial.account_type ?? 'expense')
  const [active, setActive] = useState(initial.is_active ?? true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  async function submit() {
    setSaving(true); setError('')
    const res = await saveAccount(schoolId, { id: initial.id, code, name, account_type: type, is_active: active })
    setSaving(false)
    if (!res.ok) { setError(res.error); return }
    await onSaved()
  }
  return (
    <Modal open onClose={onClose} title={initial.id ? 'Edit account' : 'Add account'} maxWidth="440px">
      <div className="fma">
        <label className="fma-reason">Code<input className="fma-input" value={code} onChange={e => setCode(e.target.value)} placeholder="e.g. 5400" /></label>
        <label className="fma-reason">Name<input className="fma-input" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Fuel and generator" /></label>
        <label className="fma-reason">Type
          <select className="fma-input" value={type} onChange={e => setType(e.target.value as AccountType)} disabled={!!initial.id}>
            {TYPES.map(t => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
          </select>
        </label>
        {initial.id && <label className="obl-toggle"><input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} /> In use (untick to hide it from new entries)</label>}
        {error && <p className="fma-error" role="alert">{error}</p>}
        <div className="fma-actions">
          <button type="button" className="obl-btn obl-btn--primary" disabled={saving} onClick={() => void submit()}>{saving ? 'Saving…' : 'Save'}</button>
          <button type="button" className="obl-btn" disabled={saving} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </Modal>
  )
}
