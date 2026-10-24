import { useCallback, useEffect, useMemo, useState } from 'react'
import { loadClassNodes } from '../services/settingsService'
import {
  clearClassRule,
  loadRulesContext,
  resolveEffectiveRule,
  saveClassRule,
  type ClassRule,
  type RuleMode,
  type RulesContext,
  type SchoolRule,
} from '../services/attendanceRules'

/**
 * Per-class overrides for the attendance auto-deactivation rule. Rendered
 * inside the Settings → Attendance auto-deactivation card. A rule on a
 * parent class applies to every class below it unless a child has its own.
 */

type Choice = 'default' | 'custom' | 'exempt'

interface Node { id: string; name: string; parent_id: string | null; sort_order: number }
interface Draft { choice: Choice; mode: RuleMode; threshold: string }

export default function AttendanceClassRules({
  schoolId,
  school,
}: {
  schoolId: string
  school: SchoolRule
}) {
  const [nodes, setNodes] = useState<Node[]>([])
  const [ctx, setCtx] = useState<RulesContext | null>(null)
  const [drafts, setDrafts] = useState<Map<string, Draft>>(new Map())
  const [savingId, setSavingId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    const [nodesRes, ctxRes] = await Promise.all([loadClassNodes(schoolId), loadRulesContext(schoolId)])
    if (nodesRes.error) setError(nodesRes.error)
    else if (!ctxRes.ok) setError(ctxRes.error)
    else {
      setError('')
      setNodes(nodesRes.data as unknown as Node[])
      setCtx(ctxRes.data)
      setDrafts(new Map())
    }
    setLoading(false)
  }, [schoolId])

  useEffect(() => { void load() }, [load])

  // Depth-first order so children sit directly under their parent.
  const ordered = useMemo(() => {
    const kids = new Map<string | null, Node[]>()
    for (const n of nodes) {
      const k = n.parent_id ?? null
      kids.set(k, [...(kids.get(k) ?? []), n])
    }
    const out: { node: Node; depth: number }[] = []
    const walk = (parent: string | null, depth: number) => {
      for (const n of (kids.get(parent) ?? []).sort((a, b) => a.sort_order - b.sort_order)) {
        out.push({ node: n, depth })
        walk(n.id, depth + 1)
      }
    }
    walk(null, 0)
    return out
  }, [nodes])

  const nameOf = (id: string) => nodes.find(n => n.id === id)?.name ?? 'a parent class'

  function savedDraft(id: string): Draft {
    const r = ctx?.rules.get(id)
    if (!r) return { choice: 'default', mode: school.mode, threshold: '' }
    if (r.exempt) return { choice: 'exempt', mode: school.mode, threshold: '' }
    const mode = r.mode ?? school.mode
    const t = mode === 'consecutive' ? r.consecutive_threshold : r.cumulative_threshold
    return { choice: 'custom', mode, threshold: t ? String(t) : '' }
  }

  const draftOf = (id: string) => drafts.get(id) ?? savedDraft(id)
  const setDraft = (id: string, patch: Partial<Draft>) =>
    setDrafts(prev => new Map(prev).set(id, { ...draftOf(id), ...patch }))

  async function saveRow(id: string) {
    const d = draftOf(id)
    setSavingId(id)
    setError('')
    let res: { error: string | null }
    if (d.choice === 'default') {
      res = await clearClassRule(schoolId, id)
    } else if (d.choice === 'exempt') {
      const rule: ClassRule = { class_node_id: id, exempt: true, mode: null, consecutive_threshold: null, cumulative_threshold: null }
      res = await saveClassRule(schoolId, rule)
    } else {
      const n = parseInt(d.threshold, 10)
      if (!Number.isFinite(n) || n < 1) {
        setSavingId(null)
        setError('Enter a threshold of 1 or more for a custom rule.')
        return
      }
      const rule: ClassRule = {
        class_node_id: id,
        exempt: false,
        mode: d.mode,
        consecutive_threshold: d.mode === 'consecutive' ? n : null,
        cumulative_threshold: d.mode === 'cumulative' ? n : null,
      }
      res = await saveClassRule(schoolId, rule)
    }
    setSavingId(null)
    if (res.error) { setError(res.error); return }
    await load()
  }

  if (loading) return <p className="set-field-hint">Loading class rules…</p>

  return (
    <div className="acr-wrap">
      <h4 className="acr-title">Class rules</h4>
      <p className="set-field-hint">
        Exempt a class from automatic deactivation, or give it its own rule. A rule on a parent
        class applies to every class under it unless that class has its own. Classes with no
        rule use the school-wide setting above. Counting continues for exempt classes — it just
        never suspends anyone. Tightening a class's rule can suspend students who already meet
        it the next time a staff member opens the Students module.
      </p>
      {error && <p className="set-form-error">{error}</p>}

      <ul className="acr-list">
        {ordered.map(({ node, depth }) => {
          const d = draftOf(node.id)
          const dirty = drafts.has(node.id)
          const eff = ctx ? resolveEffectiveRule(node.id, ctx, school) : null
          const own = ctx?.rules.has(node.id) ?? false
          let effText = ''
          if (eff) {
            const base = eff.exempt
              ? 'Exempt'
              : `${eff.threshold} ${eff.mode === 'consecutive' ? 'consecutive days' : 'total absences'}`
            effText = own
              ? base
              : eff.sourceClassId
                ? `${base} (from ${nameOf(eff.sourceClassId)})`
                : `${base} (school rule)`
          }
          return (
            <li key={node.id} className="acr-row" style={{ paddingLeft: `${depth * 18}px` }}>
              <div className="acr-name">
                <span>{node.name}</span>
                <span className="acr-eff">{effText}</span>
              </div>
              <div className="acr-controls">
                <select
                  className="set-select"
                  value={d.choice}
                  onChange={e => setDraft(node.id, { choice: e.target.value as Choice })}
                  aria-label={`Rule for ${node.name}`}
                >
                  <option value="default">{depth === 0 ? 'School rule' : 'Inherit'}</option>
                  <option value="custom">Custom rule</option>
                  <option value="exempt">Exempt</option>
                </select>
                {d.choice === 'custom' && (
                  <>
                    <select
                      className="set-select"
                      value={d.mode}
                      onChange={e => setDraft(node.id, { mode: e.target.value as RuleMode })}
                      aria-label="Count absences as"
                    >
                      <option value="consecutive">Consecutive days</option>
                      <option value="cumulative">Total absences</option>
                    </select>
                    <input
                      className="acr-threshold"
                      type="text"
                      inputMode="numeric"
                      value={d.threshold}
                      onChange={e => setDraft(node.id, { threshold: e.target.value.replace(/[^0-9]/g, '') })}
                      placeholder="No."
                      aria-label="Threshold"
                    />
                  </>
                )}
                {dirty && (
                  <button
                    type="button"
                    className="set-save-btn"
                    onClick={() => void saveRow(node.id)}
                    disabled={savingId === node.id}
                  >
                    {savingId === node.id ? 'Saving…' : 'Save'}
                  </button>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
