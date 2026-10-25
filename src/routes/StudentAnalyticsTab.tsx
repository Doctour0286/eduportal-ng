import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  availablePresets,
  loadDurationContext,
  loadStudentAnalytics,
  loadStudentIdentity,
  resolveRange,
  type AnalyticsFlag,
  type DurationContext,
  type DurationPreset,
  type FlagSection,
  type StudentAnalytics,
  type StudentIdentity,
  type SubjectAnalytics,
} from '../services/studentAnalyticsService'
import { formatNaira } from '../services/portalService'
import { getStudentPhotoSignedUrl } from '../services/studentsService'

/**
 * Analytics tab on the student detail: one page that answers "is anything
 * wrong?", "how is the student doing against the class?" and "what is the
 * evidence?" — all over a duration the user picks.
 */

const fmtDay = (d: string) =>
  new Date(d + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
const fmtFull = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
const ordinal = (n: number) => {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}

function Sparkline({ values }: { values: (number | null)[] }) {
  const pts = values.map((v, i) => ({ v, i })).filter(p => p.v !== null) as { v: number; i: number }[]
  if (pts.length < 2) return null
  const w = 56, h = 18
  const max = Math.max(...pts.map(p => p.v)), min = Math.min(...pts.map(p => p.v))
  const span = Math.max(1, max - min)
  const x = (i: number) => (i / Math.max(1, values.length - 1)) * (w - 4) + 2
  const y = (v: number) => h - 3 - ((v - min) / span) * (h - 6)
  const d = pts.map((p, k) => `${k === 0 ? 'M' : 'L'}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ')
  const last = pts[pts.length - 1]
  return (
    <svg className="san-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Term-by-term trend">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={x(last.i)} cy={y(last.v)} r="2" fill="currentColor" />
    </svg>
  )
}

function SubjectRow({ s }: { s: SubjectAnalytics }) {
  const total = s.total ?? 0
  const behind = s.total !== null && s.classAverage !== null && s.total < s.classAverage - 5
  return (
    <li className="san-subj">
      <span className="san-subj-name">{s.name}</span>
      <div className="san-bar" role="img" aria-label={`${s.name}: ${s.total ?? 'no score'}${s.classAverage !== null ? `, class average ${s.classAverage}` : ''}`}>
        <div className={`san-bar-fill${behind ? ' san-bar-fill--behind' : ''}`} style={{ width: `${Math.max(0, Math.min(100, total))}%` }} />
        {s.classAverage !== null && <div className="san-bar-tick" style={{ left: `${Math.max(0, Math.min(100, s.classAverage))}%` }} title={`Class average ${s.classAverage}`} />}
      </div>
      <span className="san-subj-meta">
        {s.total === null ? 'No score' : `${s.total}${s.grade ? ` · ${s.grade}` : ''}${s.position ? ` · ${ordinal(s.position)}` : ''}`}
      </span>
      <span className={`san-delta${s.deltaVsPrev === null ? '' : s.deltaVsPrev < 0 ? ' san-delta--down' : s.deltaVsPrev > 0 ? ' san-delta--up' : ''}`}>
        {s.deltaVsPrev === null ? '' : `${s.deltaVsPrev > 0 ? '+' : ''}${s.deltaVsPrev}`}
      </span>
      <Sparkline values={s.trend.map(t => t.total)} />
    </li>
  )
}

export default function StudentAnalyticsTab({
  schoolId,
  studentId,
  studentName,
  canSeeFinanceAndConduct,
}: {
  schoolId: string
  studentId: string
  studentName: string
  canSeeFinanceAndConduct: boolean
}) {
  const [ctx, setCtx] = useState<DurationContext | null>(null)
  const [preset, setPreset] = useState<DurationPreset>('term')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [data, setData] = useState<StudentAnalytics | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [identity, setIdentity] = useState<StudentIdentity | null>(null)
  const [photoUrl, setPhotoUrl] = useState<string | null>(null)
  const [showAllPayments, setShowAllPayments] = useState(false)
  const sectionRefs = useRef<Record<FlagSection, HTMLElement | null>>({ attendance: null, academics: null, fees: null, record: null })

  // Passport + identity header. photo_url is a private-bucket path, so it
  // has to be turned into a short-lived signed URL before it can render.
  useEffect(() => {
    let cancelled = false
    setIdentity(null)
    setPhotoUrl(null)
    void loadStudentIdentity(studentId).then(async id => {
      if (cancelled || !id) return
      setIdentity(id)
      if (id.photo_path) {
        const url = await getStudentPhotoSignedUrl(id.photo_path)
        if (!cancelled) setPhotoUrl(url)
      }
    })
    return () => { cancelled = true }
  }, [studentId])

  useEffect(() => {
    let cancelled = false
    void loadDurationContext(schoolId).then(c => {
      if (cancelled) return
      setCtx(c)
      const presets = availablePresets(c).map(p => p.value)
      setPreset(presets.includes('term') ? 'term' : presets.includes('session') ? 'session' : 'days30')
    })
    return () => { cancelled = true }
  }, [schoolId])

  const range = useMemo(
    () => (ctx ? resolveRange(preset, ctx, { from: customFrom, to: customTo }) : null),
    [ctx, preset, customFrom, customTo],
  )

  const load = useCallback(async () => {
    if (!ctx || !range) return
    setLoading(true)
    setError('')
    const res = await loadStudentAnalytics({ schoolId, studentId, range, ctx, includeFinanceAndConduct: canSeeFinanceAndConduct })
    setLoading(false)
    if (res.ok) setData(res.data)
    else setError(res.error)
  }, [ctx, range, schoolId, studentId, canSeeFinanceAndConduct])

  useEffect(() => { void load() }, [load])

  const jump = (section: FlagSection) =>
    sectionRefs.current[section]?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  if (!ctx) return <div className="san-skel skeleton" />

  const presets = availablePresets(ctx)
  const att = data?.attendance.data
  const acad = data?.academics.data
  const fees = data?.fees?.data
  const customIncomplete = preset === 'custom' && (!customFrom || !customTo || customFrom > customTo)

  return (
    <div className="stu-detail-tab-content san">
      {/* Identity + passport */}
      <div className="san-id">
        <div className="san-photo" aria-hidden={!photoUrl}>
          {photoUrl
            ? <img src={photoUrl} alt={`${studentName} passport photograph`} />
            : <span>{(identity?.full_name ?? studentName).charAt(0).toUpperCase()}</span>}
        </div>
        <div className="san-id-text">
          <p className="san-id-name">{identity?.full_name ?? studentName}</p>
          <p className="san-id-meta">
            {[identity?.class_name, identity?.student_code, identity?.gender].filter(Boolean).join(' · ')}
          </p>
        </div>
        {identity && identity.status !== 'active' && (
          <span className="san-id-status">{identity.status === 'inactive' ? 'Inactive' : identity.status}</span>
        )}
      </div>

      {/* Duration filter */}
      <div className="san-filter">
        <div className="san-chips" role="group" aria-label="Duration">
          {presets.map(p => (
            <button
              key={p.value}
              type="button"
              className={`san-chip${preset === p.value ? ' san-chip--on' : ''}`}
              aria-pressed={preset === p.value}
              onClick={() => setPreset(p.value)}
            >
              {p.label}
            </button>
          ))}
        </div>
        {preset === 'custom' && (
          <div className="san-custom">
            <input type="date" className="san-date" value={customFrom} max={ctx.today} onChange={e => setCustomFrom(e.target.value)} aria-label="From" />
            <span>to</span>
            <input type="date" className="san-date" value={customTo} max={ctx.today} onChange={e => setCustomTo(e.target.value)} aria-label="To" />
          </div>
        )}
        {range && !customIncomplete && (
          <p className="san-range">{range.label} · {fmtDay(range.from)} – {fmtDay(range.to)}</p>
        )}
        {customIncomplete && <p className="san-range">Pick a start and end date.</p>}
      </div>

      {error && <p className="stu-status-note stu-status-note--error">{error}</p>}
      {loading && !data && <div className="san-skel skeleton" />}

      {data && (
        <div className={loading ? 'san-body san-body--loading' : 'san-body'}>
          {/* Outstanding fees — impossible to miss */}
          {canSeeFinanceAndConduct && fees && fees.summary.balance > 0 && fees.summary.totalBilled > 0 && (
            <div className="san-owing" role="alert">
              <div>
                <p className="san-owing-label">Outstanding fees</p>
                <p className="san-owing-amount">{formatNaira(fees.summary.balance)}</p>
                <p className="san-owing-sub">
                  of {formatNaira(fees.summary.totalBilled - fees.summary.totalDiscount)} billed this session · {formatNaira(fees.summary.totalPaid)} paid
                </p>
              </div>
              <button type="button" className="san-owing-btn" onClick={() => jump('fees')}>View payments</button>
            </div>
          )}

          {/* Attention strip */}
          {data.flags.length > 0 && (
            <div className="san-attn" role="status">
              <p className="san-attn-title">Needs attention</p>
              <div className="san-attn-list">
                {data.flags.map((f: AnalyticsFlag) => (
                  <button key={f.id} type="button" className="san-attn-chip" onClick={() => jump(f.section)}>{f.text}</button>
                ))}
              </div>
            </div>
          )}

          {/* Key numbers */}
          <div className="san-tiles">
            <div className="san-tile">
              <span className="san-tile-label">Attendance</span>
              <span className="san-tile-value">{att?.summary.percent != null ? `${att.summary.percent}%` : '—'}</span>
              <span className="san-tile-sub">{att?.summary.classAveragePercent != null ? `Class ${att.summary.classAveragePercent}%` : 'No class figure yet'}</span>
            </div>
            <div className="san-tile">
              <span className="san-tile-label">Average{acad ? ` · ${acad.termName}` : ''}</span>
              <span className="san-tile-value">{acad?.average != null ? `${acad.average}%` : '—'}</span>
              <span className="san-tile-sub">
                {acad?.overallPosition ? `${ordinal(acad.overallPosition)} of ${acad.classSize}` : acad?.classAverage != null ? `Class ${acad.classAverage}%` : 'No results yet'}
              </span>
            </div>
            {canSeeFinanceAndConduct && (
              <>
                <div className={`san-tile${fees && fees.summary.balance > 0 && fees.summary.totalBilled > 0 ? ' san-tile--alert' : ''}`}>
                  <span className="san-tile-label">Fees</span>
                  <span className="san-tile-value">
                    {fees && fees.summary.totalBilled > 0
                      ? `${Math.round((fees.summary.totalPaid / Math.max(1, fees.summary.totalBilled - fees.summary.totalDiscount)) * 100)}% paid`
                      : '—'}
                  </span>
                  <span className="san-tile-sub">{fees ? (fees.summary.balance > 0 ? `${formatNaira(fees.summary.balance)} left` : 'Nothing owed') : ''}</span>
                </div>
                <div className="san-tile">
                  <span className="san-tile-label">Conduct</span>
                  <span className="san-tile-value">{data.openObligations > 0 ? `${data.openObligations} open` : 'Clear'}</span>
                  <span className="san-tile-sub">{data.suspensionsInRange} suspension{data.suspensionsInRange === 1 ? '' : 's'} in range</span>
                </div>
              </>
            )}
          </div>

          {/* Academics */}
          <section className="san-card" ref={el => { sectionRefs.current.academics = el }}>
            <h4 className="san-h">Subjects against the class average</h4>
            {data.academics.error && <p className="stu-status-note stu-status-note--error">{data.academics.error}</p>}
            {acad && (
              <>
                {acad.rangeNote && <p className="san-note">{acad.rangeNote}</p>}
                {acad.subjects.length === 0 ? (
                  <p className="san-empty">No approved results for {acad.termName} yet.</p>
                ) : (
                  <>
                    <ul className="san-subj-list">{acad.subjects.map(s => <SubjectRow key={s.subject_id} s={s} />)}</ul>
                    <p className="san-note">
                      The black tick is the class average. Figures show score, grade and class position; the small arrow-line is the term-by-term trend, and the number beside it is the change since last term.
                    </p>
                  </>
                )}
                {acad.termAverages.filter(t => t.average !== null).length > 1 && (
                  <p className="san-terms">
                    {acad.termAverages.filter(t => t.average !== null).map(t => `${t.termName}: ${t.average}%`).join('  →  ')}
                  </p>
                )}
              </>
            )}
          </section>

          {/* Attendance */}
          <section className="san-card" ref={el => { sectionRefs.current.attendance = el }}>
            <h4 className="san-h">Attendance</h4>
            {data.attendance.error && <p className="stu-status-note stu-status-note--error">{data.attendance.error}</p>}
            {att && (
              att.days.length === 0 ? (
                <p className="san-empty">No school days in this range.</p>
              ) : (
                <>
                  <div className="san-days" aria-label="School days in range">
                    {att.days.map(d => (
                      <span key={d.date} className={`san-day san-day--${d.status}`} title={`${fmtDay(d.date)}: ${d.status === 'unmarked' ? 'not marked' : d.status}`} />
                    ))}
                  </div>
                  <div className="san-legend">
                    <span><i className="san-day san-day--present" /> Present</span>
                    <span><i className="san-day san-day--late" /> Late</span>
                    <span><i className="san-day san-day--absent" /> Absent</span>
                    <span><i className="san-day san-day--excused" /> Excused</span>
                    <span><i className="san-day san-day--unmarked" /> Not marked</span>
                  </div>
                  <p className="san-facts">
                    {att.summary.absent} absent · {att.lateCount} late · {att.summary.excused} excused · longest absence run {att.longestAbsentRun} day{att.longestAbsentRun === 1 ? '' : 's'}
                  </p>

                  {(() => {
                    const rated = att.byWeekday.filter(w => w.percent !== null)
                    const markedDays = att.byWeekday.reduce((n, w) => n + w.present + w.absent, 0)
                    if (rated.length < 2 || markedDays < 5) return null
                    const lowest = [...rated].sort((a, b) => (a.percent! - b.percent!) || (b.absent - a.absent))[0]
                    const highest = Math.max(...rated.map(w => w.percent!))
                    const gap = highest - lowest.percent!
                    return (
                      <div className="san-weekday">
                        <p className="san-sub">
                          Attendance by school day{gap >= 15 && lowest.absent >= 2 ? ` — lowest on ${lowest.label}s (${lowest.percent}%)` : ''}
                        </p>
                        <div className="san-wd-bars">
                          {att.byWeekday.map(w => (
                            <div key={w.label} className="san-wd" title={`${w.label}: ${w.present} present, ${w.absent} absent`}>
                              <div className="san-wd-col">
                                <div
                                  className={`san-mo-fill${w.percent !== null && w.percent < 80 ? ' san-mo-fill--low' : ''}`}
                                  style={{ height: `${w.percent ?? 0}%` }}
                                />
                              </div>
                              <span className="san-wd-n">{w.percent === null ? '—' : `${w.percent}%`}</span>
                              <span className="san-wd-l">{w.label}</span>
                              <span className="san-wd-l">{w.absent} abs.</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )
                  })()}

                  {att.monthly.length > 1 && (
                    <div className="san-monthly">
                      <p className="san-sub">Attendance by month</p>
                      <div className="san-mo-bars">
                        {att.monthly.map(m => (
                          <div key={m.key} className="san-mo">
                            <div className="san-mo-col"><div className={`san-mo-fill${m.percent !== null && m.percent < 80 ? ' san-mo-fill--low' : ''}`} style={{ height: `${m.percent ?? 0}%` }} /></div>
                            <span className="san-wd-n">{m.percent === null ? '—' : `${m.percent}%`}</span>
                            <span className="san-wd-l">{m.label}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )
            )}
          </section>

          {/* Fees */}
          {canSeeFinanceAndConduct && data.fees && (
            <section className="san-card" ref={el => { sectionRefs.current.fees = el }}>
              <h4 className="san-h">Fees</h4>
              {data.fees.error && <p className="stu-status-note stu-status-note--error">{data.fees.error}</p>}
              {fees && (
                <>
                  <div className="san-fee-bar" role="img" aria-label={`${formatNaira(fees.summary.totalPaid)} paid of ${formatNaira(fees.summary.totalBilled - fees.summary.totalDiscount)}`}>
                    <div className="san-fee-paid" style={{ width: `${Math.min(100, (fees.summary.totalPaid / Math.max(1, fees.summary.totalBilled - fees.summary.totalDiscount)) * 100)}%` }} />
                  </div>
                  <p className="san-facts">
                    Billed {formatNaira(fees.summary.totalBilled)}
                    {fees.summary.totalDiscount > 0 ? ` · discount ${formatNaira(fees.summary.totalDiscount)}` : ''}
                    {' · paid '}{formatNaira(fees.summary.totalPaid)} · balance {formatNaira(fees.summary.balance)}
                  </p>
                  <p className="san-note">Billed, paid and balance are for the whole session. Payments below follow the range you picked.</p>
                  {(() => {
                    const list = showAllPayments ? fees.allPayments : fees.paymentsInRange
                    return (
                      <>
                        <p className="san-sub">
                          {showAllPayments ? `Full payment history (${fees.allPayments.length})` : `Received in range: ${formatNaira(fees.paidInRange)}`}
                        </p>
                        {list.length === 0 ? (
                          <p className="san-empty">{showAllPayments ? 'No payments recorded yet.' : 'No payments in this range.'}</p>
                        ) : (
                          <ul className="san-pay-list">
                            {list.map(p => (
                              <li key={p.id} className="san-pay">
                                <div className="san-pay-top">
                                  <span>{p.paid_at ? fmtFull(p.paid_at) : 'Undated'} · {p.fee_head_name ?? 'Payment'}</span>
                                  <strong>{formatNaira(p.amount)}</strong>
                                </div>
                                <span className="san-pay-meta">
                                  {p.method}
                                  {p.received_by_name ? ` · recorded by ${p.received_by_name}` : ' · online payment'}
                                  {p.notes ? ` · ${p.notes}` : ''}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                        {fees.allPayments.length > fees.paymentsInRange.length || showAllPayments ? (
                          <button type="button" className="san-link" onClick={() => setShowAllPayments(v => !v)}>
                            {showAllPayments ? 'Show only the selected range' : `Show full history (${fees.allPayments.length})`}
                          </button>
                        ) : null}
                      </>
                    )
                  })()}
                </>
              )}
            </section>
          )}

          {/* Record */}
          {canSeeFinanceAndConduct && data.record && (
            <section className="san-card" ref={el => { sectionRefs.current.record = el }}>
              <h4 className="san-h">Record</h4>
              {data.record.error && <p className="stu-status-note stu-status-note--error">{data.record.error}</p>}
              {data.record.data && (
                data.record.data.length === 0 ? (
                  <p className="san-empty">Nothing recorded for {studentName} in this range.</p>
                ) : (
                  <ul className="san-timeline">
                    {data.record.data.map(e => (
                      <li key={e.id} className={`san-tl san-tl--${e.kind}`}>
                        <span className="san-tl-date">{fmtFull(e.at)}</span>
                        <span className="san-tl-body">
                          <strong>{e.title}</strong>
                          {e.detail && <span> — {e.detail}</span>}
                          {e.by && <span className="san-tl-by"> · {e.by}</span>}
                        </span>
                      </li>
                    ))}
                  </ul>
                )
              )}
            </section>
          )}
        </div>
      )}
    </div>
  )
}
