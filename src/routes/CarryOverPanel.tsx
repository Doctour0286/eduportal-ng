import { useEffect, useMemo, useState } from 'react'
import { loadSessions, loadTerms } from '../services/settingsService'
import {
  previewCarryOver, runCarryOver,
  type CarryKind, type CarryOptions, type CarryPreview, type CarryResult, type CarryScope,
} from '../services/carryOverService'

/**
 * "Copy from a previous session": carry course offerings, fee assignments or
 * teaching assignments (and their timetables) forward. Preview first, always
 * additive — anything already in the new period is skipped, not overwritten.
 */

interface SessionLite { id: string; name: string; start_date: string; is_current: boolean }
interface TermLite { id: string; name: string }

const KIND_LABEL: Record<CarryKind, string> = {
  offerings: 'Course offerings',
  fees: 'Fee assignments',
  teaching: 'Teaching assignments',
}
const KIND_HELP: Record<CarryKind, string> = {
  offerings: 'The courses offered, to which programme levels, and (optionally) their lecturers and timetable slots.',
  fees: 'What each class or programme level is charged, with an optional price change and dates moved forward.',
  teaching: 'Which teacher teaches which subject in which class, and (optionally) the class timetable.',
}

export default function CarryOverPanel({
  schoolId,
  kinds,
  usesTerms,
  periodWord,
  onDone,
}: {
  schoolId: string
  kinds: CarryKind[]
  usesTerms: boolean
  periodWord: string
  onDone?: () => void
}) {
  const [sessions, setSessions] = useState<SessionLite[]>([])
  const [kind, setKind] = useState<CarryKind>(kinds[0])
  const [fromSession, setFromSession] = useState('')
  const [toSession, setToSession] = useState('')
  const [fromTerms, setFromTerms] = useState<TermLite[]>([])
  const [toTerms, setToTerms] = useState<TermLite[]>([])
  const [fromTerm, setFromTerm] = useState('')
  const [toTerm, setToTerm] = useState('')
  const [opts, setOpts] = useState<CarryOptions>({ keepLecturers: true, includeTimetable: true, upliftPercent: 0, shiftDueDates: true })
  const [upliftText, setUpliftText] = useState('0')
  const [preview, setPreview] = useState<CarryPreview | null>(null)
  const [result, setResult] = useState<CarryResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    void loadSessions(schoolId).then(r => {
      const list = (r.data as unknown as SessionLite[]).slice().sort((a, b) => a.start_date.localeCompare(b.start_date))
      setSessions(list)
      const target = list.find(s => s.is_current) ?? list[list.length - 1]
      if (target) {
        setToSession(target.id)
        const idx = list.findIndex(s => s.id === target.id)
        if (idx > 0) setFromSession(list[idx - 1].id)
      }
    })
  }, [schoolId])

  useEffect(() => {
    if (!usesTerms || !fromSession) { setFromTerms([]); setFromTerm(''); return }
    void loadTerms(schoolId, fromSession).then(r => { setFromTerms(r.data as TermLite[]); setFromTerm('') })
  }, [usesTerms, fromSession, schoolId])
  useEffect(() => {
    if (!usesTerms || !toSession) { setToTerms([]); setToTerm(''); return }
    void loadTerms(schoolId, toSession).then(r => { setToTerms(r.data as TermLite[]); setToTerm('') })
  }, [usesTerms, toSession, schoolId])

  const scopeOf = (sessionId: string, termId: string): CarryScope => ({
    sessionId, termId: termId || null, startDate: sessions.find(s => s.id === sessionId)?.start_date ?? '',
  })
  const from = useMemo(() => scopeOf(fromSession, fromTerm), [fromSession, fromTerm, sessions]) // eslint-disable-line react-hooks/exhaustive-deps
  const to = useMemo(() => scopeOf(toSession, toTerm), [toSession, toTerm, sessions]) // eslint-disable-line react-hooks/exhaustive-deps
  const options: CarryOptions = { ...opts, upliftPercent: Number(upliftText) || 0 }

  const clear = () => { setPreview(null); setResult(null); setError('') }

  async function doPreview() {
    clear()
    if (!fromSession || !toSession) { setError('Choose both periods.'); return }
    setBusy(true)
    const res = await previewCarryOver(schoolId, kind, from, to, options)
    setBusy(false)
    if (!res.ok) setError(res.error); else setPreview(res.data)
  }

  async function doRun() {
    setBusy(true); setError('')
    const res = await runCarryOver(schoolId, kind, from, to, options)
    setBusy(false)
    if (!res.ok) { setError(res.error); return }
    setPreview(null); setResult(res.data)
    onDone?.()
  }

  if (sessions.length < 2) {
    return <p className="fma-hint">Add a second session to be able to copy configuration from an earlier one.</p>
  }

  const Picker = ({ label, session, setSession, term, setTerm, terms }: {
    label: string; session: string; setSession: (v: string) => void; term: string; setTerm: (v: string) => void; terms: TermLite[]
  }) => (
    <div className="cop-pick">
      <span className="cop-pick-label">{label}</span>
      <select className="fma-input" value={session} onChange={e => { setSession(e.target.value); clear() }}>
        <option value="">Choose a session…</option>
        {sessions.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
      {usesTerms && terms.length > 0 && (
        <select className="fma-input" value={term} onChange={e => { setTerm(e.target.value); clear() }}>
          <option value="">Whole session</option>
          {terms.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      )}
    </div>
  )

  return (
    <div className="cop">
      {kinds.length > 1 && (
        <div className="fl-seg" role="tablist">
          {kinds.map(k => (
            <button key={k} type="button" role="tab" aria-selected={kind === k}
              className={`fl-seg-btn${kind === k ? ' fl-seg-btn--on' : ''}`} onClick={() => { setKind(k); clear() }}>{KIND_LABEL[k]}</button>
          ))}
        </div>
      )}
      <p className="fma-hint">{KIND_HELP[kind]}</p>

      <div className="cop-grid">
        <Picker label="Copy from" session={fromSession} setSession={setFromSession} term={fromTerm} setTerm={setFromTerm} terms={fromTerms} />
        <Picker label="Copy into" session={toSession} setSession={setToSession} term={toTerm} setTerm={setToTerm} terms={toTerms} />
      </div>
      {usesTerms && <p className="fma-hint">Pick a specific {periodWord} on each side to copy one {periodWord} into another, or leave both on “Whole session”.</p>}

      {kind === 'offerings' && (
        <div className="cop-opts">
          <label className="obl-toggle"><input type="checkbox" checked={opts.keepLecturers} onChange={e => { setOpts({ ...opts, keepLecturers: e.target.checked }); clear() }} /> Keep the same lecturers</label>
          <label className="obl-toggle"><input type="checkbox" checked={opts.includeTimetable} onChange={e => { setOpts({ ...opts, includeTimetable: e.target.checked }); clear() }} /> Copy timetable slots too</label>
        </div>
      )}
      {kind === 'teaching' && (
        <div className="cop-opts">
          <label className="obl-toggle"><input type="checkbox" checked={opts.includeTimetable} onChange={e => { setOpts({ ...opts, includeTimetable: e.target.checked }); clear() }} /> Copy the class timetable too</label>
        </div>
      )}
      {kind === 'fees' && (
        <div className="cop-opts">
          <label className="cop-uplift">Change amounts by (%)
            <input className="fma-input" inputMode="decimal" value={upliftText} onChange={e => { setUpliftText(e.target.value.replace(/[^0-9.\-]/g, '')); clear() }} placeholder="0" />
          </label>
          <label className="obl-toggle"><input type="checkbox" checked={opts.shiftDueDates} onChange={e => { setOpts({ ...opts, shiftDueDates: e.target.checked }); clear() }} /> Move due dates forward to match the new session</label>
        </div>
      )}

      {error && <p className="fma-error" role="alert">{error}</p>}

      {preview && (
        <div className="fma-preview">
          <p className="fma-preview-title">This will:</p>
          <ul>
            <li>Find <strong>{preview.sourceCount}</strong> in the earlier period</li>
            <li>Copy <strong>{preview.newCount}</strong> new {preview.newCount === 1 ? 'item' : 'items'}</li>
            {preview.duplicateCount > 0 && <li>Skip <strong>{preview.duplicateCount}</strong> that already exist{preview.duplicateCount === 1 ? 's' : ''} in the new period</li>}
          </ul>
          {preview.notes.map(n => <p key={n} className="fma-note">{n}</p>)}
        </div>
      )}
      {result && (
        <p className="fma-notice" role="status">
          Copied {result.created} item{result.created === 1 ? '' : 's'}
          {result.timetable > 0 ? ` and ${result.timetable} timetable slot${result.timetable === 1 ? '' : 's'}` : ''}
          {result.skipped > 0 ? `; ${result.skipped} already existed.` : '.'}
        </p>
      )}

      <div className="fma-actions">
        {!preview ? (
          <button type="button" className="obl-btn obl-btn--primary" disabled={busy} onClick={() => void doPreview()}>{busy ? 'Checking…' : 'Preview'}</button>
        ) : (
          <button type="button" className="obl-btn obl-btn--primary" disabled={busy || preview.newCount === 0} onClick={() => void doRun()}>
            {busy ? 'Copying…' : preview.newCount === 0 ? 'Nothing new to copy' : `Copy ${preview.newCount}`}
          </button>
        )}
      </div>
    </div>
  )
}
