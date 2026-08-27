/**
 * PunctualityModule.tsx
 * Teacher punctuality tracking — proctor-recorded, admin/HR reported.
 *
 * Two record views:
 *   1. Grid: full timetable grid (teachers × periods) with current-period highlight
 *   2. List: card-based per-teacher quick-mark
 *
 * Teachers NEVER see this data — RLS excludes teacher-role identities.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useAuthStore } from '../stores/authStore'
import { Icon } from '../components/icons'
import { loadCurrentSession } from '../services/timetableService'
import {
  loadScheduledTeachersForDate,
  markTeacherFullDay,
  markPeriodRecord,
  loadPunctualityReport,
  todayDateString,
  type ScheduledTeacher,
  type ScheduledEntry,
  type PunctualityStatus,
  type PunctualityScope,
  type PunctualityReport,
} from '../services/punctualityService'

interface PunctualityModuleProps {
  schoolId: string
  isAdmin: boolean
}

export default function PunctualityModule({ schoolId, isAdmin }: PunctualityModuleProps) {
  const actorRecordId = useAuthStore(s => s.actorRecordId)
  const canRecord = useAuthStore(s => s.can('academics.punctuality.record'))
  const canView = useAuthStore(s => s.can('academics.punctuality.view'))
  const markedBy = actorRecordId ?? ''

  const [sessionId, setSessionId] = useState<string | null>(null)
  const [selectedDate, setSelectedDate] = useState(todayDateString())
  const [tab, setTab] = useState<'record' | 'report'>(canRecord ? 'record' : 'report')
  const [recordView, setRecordView] = useState<'grid' | 'list'>('grid')
  const dateInputRef = useRef<HTMLInputElement>(null)

  // Record view data
  const [teachers, setTeachers] = useState<ScheduledTeacher[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedTeacher, setExpandedTeacher] = useState<string | null>(null)

  // Report view data
  const [reportScope, setReportScope] = useState<PunctualityScope>('week')
  const [reportData, setReportData] = useState<PunctualityReport | null>(null)
  const [reportLoading, setReportLoading] = useState(false)
  const [reportError, setReportError] = useState<string | null>(null)

  // Load session
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const res = await loadCurrentSession()
      if (!cancelled && res.ok && res.sessionId) setSessionId(res.sessionId)
    })()
    return () => { cancelled = true }
  }, [])

  // Load teachers for selected date
  const loadTeachers = useCallback(async () => {
    if (!sessionId) return
    setLoading(true)
    setError(null)
    const res = await loadScheduledTeachersForDate(sessionId, selectedDate)
    if (res.ok) setTeachers(res.data)
    else setError(res.error)
    setLoading(false)
  }, [sessionId, selectedDate])

  useEffect(() => { loadTeachers() }, [loadTeachers])

  // Load report
  const loadReport = useCallback(async () => {
    setReportLoading(true)
    setReportError(null)
    const today = todayDateString()
    let startDate = today
    let endDate = today
    const now = new Date()

    if (reportScope === 'week') {
      const dow = now.getDay()
      const diff = dow === 0 ? -6 : 1 - dow
      const mon = new Date(now)
      mon.setDate(now.getDate() + diff)
      startDate = fmt(mon)
    } else if (reportScope === 'term' || reportScope === 'session') {
      const ago = new Date(now)
      ago.setDate(now.getDate() - 30)
      startDate = fmt(ago)
    }

    const res = await loadPunctualityReport({ scope: reportScope, startDate, endDate })
    if (res.ok) setReportData(res.data)
    else setReportError(res.error)
    setReportLoading(false)
  }, [reportScope])

  useEffect(() => { if (tab === 'report') loadReport() }, [tab, loadReport])

  // Mark all periods for a teacher
  const handleMarkAll = useCallback(async (teacher: ScheduledTeacher, status: PunctualityStatus) => {
    if (!markedBy) return
    const entryIds = teacher.entries.map(e => e.timetable_entry_id)
    const res = await markTeacherFullDay({
      schoolId, staffId: teacher.staff_id, date: selectedDate,
      status, recordedBy: markedBy, timetableEntryIds: entryIds,
    })
    if (res.ok) {
      setTeachers(prev => prev.map(t => {
        if (t.staff_id !== teacher.staff_id) return t
        const entries = t.entries.map(e => ({
          ...e,
          record: { id: e.record?.id ?? crypto.randomUUID(), status, record_date: selectedDate, recording_source: 'day_shortcut' as const } as any,
        }))
        return { ...t, entries, recordedCount: entries.length }
      }))
    }
  }, [markedBy, schoolId, selectedDate])

  // Mark single period
  const handleMarkOne = useCallback(async (entry: ScheduledEntry, staffId: string, status: PunctualityStatus) => {
    if (!markedBy) return
    const res = await markPeriodRecord({
      schoolId, timetableEntryId: entry.timetable_entry_id, staffId,
      status, recordedBy: markedBy, date: selectedDate, source: 'period_override',
    })
    if (res.ok) {
      setTeachers(prev => prev.map(t => {
        if (t.staff_id !== staffId) return t
        const entries = t.entries.map(e =>
          e.timetable_entry_id === entry.timetable_entry_id
            ? { ...e, record: { id: e.record?.id ?? crypto.randomUUID(), status, record_date: selectedDate, recording_source: 'period_override' as const } as any }
            : e
        )
        return { ...t, entries, recordedCount: entries.filter(e => e.record !== null).length }
      }))
    }
  }, [markedBy, schoolId, selectedDate])

  // Date helpers
  function fmt(d: Date) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  const shiftDate = (delta: number) => {
    const d = new Date(selectedDate + 'T00:00:00')
    d.setDate(d.getDate() + delta)
    setSelectedDate(fmt(d))
  }
  const isToday = selectedDate === todayDateString()
  const displayDate = new Date(selectedDate + 'T00:00:00').toLocaleDateString('en-NG', {
    weekday: 'short', month: 'short', day: 'numeric',
  })

  // Unique periods for grid (sorted by start_time)
  const periods = useMemo(() => {
    const seen = new Map<string, { id: string; label: string; start: string; end: string }>()
    for (const t of teachers) for (const e of t.entries) {
      if (!seen.has(e.period_id)) seen.set(e.period_id, { id: e.period_id, label: e.period_label, start: e.period_start, end: e.period_end })
    }
    return [...seen.values()].sort((a, b) => a.start.localeCompare(b.start))
  }, [teachers])

  // Current period detection (based on time now vs period start/end)
  const currentPeriodId = useMemo(() => {
    if (!isToday) return null
    const now = new Date()
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    for (const p of periods) {
      if (hhmm >= p.start && hhmm < p.end) return p.id
    }
    return null
  }, [periods, isToday])

  // Summary
  const summary = useMemo(() => {
    let total = 0, recorded = 0, present = 0, absent = 0
    for (const t of teachers) {
      total += t.totalCount
      recorded += t.recordedCount
      for (const e of t.entries) {
        if (e.record?.status === 'present') present++
        else if (e.record?.status === 'absent') absent++
      }
    }
    return { total, recorded, present, absent, unrecorded: total - recorded }
  }, [teachers])

  // Permission denied
  if (!canRecord && !canView && !isAdmin) {
    return (
      <div className="punc-root">
        <div className="punc-empty-state">
          <Icon name="alert-triangle" size={40} />
          <p className="punc-empty-msg">You don't have permission to access teacher punctuality.</p>
          <p className="punc-empty-sub">Contact your administrator.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="punc-root">
      {/* Header */}
      <div className="punc-header">
        <h2 className="punc-title">Teacher Punctuality</h2>
        <div className="punc-tabs">
          {canRecord && (
            <button className={`punc-tab${tab === 'record' ? ' punc-tab--active' : ''}`} onClick={() => setTab('record')}>
              Record
            </button>
          )}
          {(canView || isAdmin) && (
            <button className={`punc-tab${tab === 'report' ? ' punc-tab--active' : ''}`} onClick={() => setTab('report')}>
              Report
            </button>
          )}
        </div>
      </div>

      {/* ═══ RECORD TAB ═══ */}
      {tab === 'record' && (
        <div className="punc-record">
          {/* Date picker row */}
          <div className="punc-date-row">
            <button className="punc-arrow" onClick={() => shiftDate(-1)} aria-label="Previous day">‹</button>
            <button className="punc-date-pill" onClick={() => dateInputRef.current?.showPicker?.()}>
              {displayDate}{isToday && <span className="punc-today-badge">Today</span>}
            </button>
            <button className="punc-arrow" onClick={() => shiftDate(1)} disabled={isToday} aria-label="Next day">›</button>
            <input ref={dateInputRef} type="date" className="punc-date-hidden" value={selectedDate} max={todayDateString()}
              onChange={e => e.target.value && setSelectedDate(e.target.value)} />
          </div>

          {/* Summary chips */}
          {teachers.length > 0 && (
            <div className="punc-chips">
              <span className="punc-chip punc-chip--present">{summary.present} present</span>
              <span className="punc-chip punc-chip--absent">{summary.absent} absent</span>
              <span className="punc-chip punc-chip--unrecorded">{summary.unrecorded} unchecked</span>
            </div>
          )}

          {/* View toggle */}
          {!loading && !error && teachers.length > 0 && (
            <div className="punc-view-toggle">
              <button className={`punc-vt-btn${recordView === 'grid' ? ' punc-vt-btn--active' : ''}`}
                onClick={() => setRecordView('grid')}>
                <Icon name="calendar" size={14} /> Grid
              </button>
              <button className={`punc-vt-btn${recordView === 'list' ? ' punc-vt-btn--active' : ''}`}
                onClick={() => setRecordView('list')}>
                <Icon name="clipboard-list" size={14} /> List
              </button>
            </div>
          )}

          {/* Loading */}
          {loading && (
            <div className="punc-skeleton-list">
              {[1, 2, 3].map(i => <div key={i} className="punc-skel skeleton" />)}
            </div>
          )}

          {/* Error */}
          {error && !loading && (
            <div className="punc-msg-box">
              <Icon name="alert-triangle" size={20} style={{ color: 'var(--color-warning, #d97706)' }} />
              <p>{error}</p>
              <button className="punc-btn-small" onClick={loadTeachers}>Retry</button>
            </div>
          )}

          {/* Empty */}
          {!loading && !error && teachers.length === 0 && (
            <div className="punc-empty-state">
              <Icon name="calendar" size={36} />
              <p className="punc-empty-msg">No teachers scheduled on {displayDate}.</p>
              <p className="punc-empty-sub">Set up the timetable first, then come back to record punctuality.</p>
            </div>
          )}

          {/* ═══ GRID VIEW ═══ */}
          {!loading && !error && recordView === 'grid' && teachers.length > 0 && (
            <div className="punc-grid-wrap">
              <div className="punc-grid">
                {/* Header row: Teacher + period columns */}
                <div className="punc-grid-header">
                  <div className="punc-grid-cell punc-grid-cell--teacher">Teacher</div>
                  {periods.map(p => (
                    <div key={p.id} className={`punc-grid-cell punc-grid-cell--period${p.id === currentPeriodId ? ' punc-grid-cell--current' : ''}`}>
                      <span className="punc-period-label">{p.label}</span>
                      <span className="punc-period-time">{p.start?.slice(0, 5)}</span>
                    </div>
                  ))}
                </div>

                {/* Teacher rows */}
                {teachers.map(t => (
                  <div key={t.staff_id} className="punc-grid-row">
                    <div className="punc-grid-cell punc-grid-cell--teacher">
                      <span className="punc-grid-teacher-name">{t.staff_name}</span>
                    </div>
                    {periods.map(p => {
                      const entry = t.entries.find(e => e.period_id === p.id)
                      if (!entry) {
                        return (
                          <div key={p.id} className={`punc-grid-cell punc-grid-cell--empty${p.id === currentPeriodId ? ' punc-grid-cell--current-col' : ''}`}>
                            <span className="punc-cell-na">—</span>
                          </div>
                        )
                      }
                      const status = entry.record?.status
                      const isCurrent = p.id === currentPeriodId
                      const cellClass = status === 'present'
                        ? 'punc-grid-cell--present'
                        : status === 'absent'
                          ? 'punc-grid-cell--absent'
                          : 'punc-grid-cell--unrecorded'
                      return (
                        <div key={p.id} className={`punc-grid-cell ${cellClass}${isCurrent ? ' punc-grid-cell--current-col' : ''}`}>
                          <button
                            className={`punc-cell-toggle${isCurrent ? ' punc-cell-toggle--current' : ''}`}
                            onClick={() => {
                              if (!markedBy || !entry) return
                              const next: PunctualityStatus = status === 'present' ? 'absent' : 'present'
                              handleMarkOne(entry, t.staff_id, next)
                            }}
                            disabled={!markedBy}
                            title={
                              !entry ? 'No class scheduled'
                                : status === 'present' ? `${t.staff_name} — present (tap to mark absent)`
                                : status === 'absent' ? `${t.staff_name} — absent (tap to mark present)`
                                : `${t.staff_name} — unrecorded (tap to mark present)`
                            }
                          >
                            {status === 'present' && <Icon name="circle-check" size={14} />}
                            {status === 'absent' && <Icon name="alert-triangle" size={14} />}
                            {!status && <span className="punc-cell-dot" />}
                          </button>
                        </div>
                      )
                    })}
                  </div>
                ))}
              </div>

              {/* Current period indicator */}
              {currentPeriodId && (
                <div className="punc-current-hint">
                  <span className="punc-current-dot" />
                  Current period highlighted — tap a cell to mark
                </div>
              )}
            </div>
          )}

          {/* ═══ LIST VIEW ═══ */}
          {!loading && !error && recordView === 'list' && teachers.length > 0 && (
            <div className="punc-list">
              {teachers.map(t => {
                const isExpanded = expandedTeacher === t.staff_id
                const allRecorded = t.recordedCount === t.totalCount
                const allPresent = t.entries.every(e => e.record?.status === 'present')

                return (
                  <div key={t.staff_id} className={`punc-card${isExpanded ? ' punc-card--open' : ''}`}>
                    <button className="punc-card-header" onClick={() => setExpandedTeacher(isExpanded ? null : t.staff_id)}>
                      <div className="punc-card-left">
                        <div className="punc-card-avatar">
                          {allRecorded ? (
                            allPresent
                              ? <Icon name="circle-check" size={18} />
                              : <Icon name="alert-triangle" size={18} />
                          ) : (
                            <span className="punc-card-dot" />
                          )}
                        </div>
                        <div className="punc-card-info">
                          <span className="punc-card-name">{t.staff_name}</span>
                          <span className="punc-card-meta">
                            {[...new Set(t.entries.map(e => e.subject_name).filter(Boolean))].join(', ')}
                          </span>
                        </div>
                      </div>
                      <div className="punc-card-right">
                        <span className="punc-card-count">{t.recordedCount}/{t.totalCount}</span>
                        <span className="punc-card-chevron">{isExpanded ? '▾' : '›'}</span>
                      </div>
                    </button>

                    {isExpanded && (
                      <div className="punc-card-body">
                        <div className="punc-quick-actions">
                          <button className="punc-action-btn punc-action-btn--present"
                            onClick={() => handleMarkAll(t, 'present')} disabled={!markedBy}>
                            <Icon name="circle-check" size={16} /> All Present
                          </button>
                          <button className="punc-action-btn punc-action-btn--absent"
                            onClick={() => handleMarkAll(t, 'absent')} disabled={!markedBy}>
                            <Icon name="alert-triangle" size={16} /> All Absent
                          </button>
                        </div>
                        <div className="punc-periods">
                          {t.entries.map(e => {
                            const s = e.record?.status
                            return (
                              <div key={e.timetable_entry_id} className="punc-period-row">
                                <div className="punc-period-info">
                                  <span className="punc-period-name">{e.period_label}</span>
                                  <span className="punc-period-time">{e.period_start?.slice(0, 5)} – {e.period_end?.slice(0, 5)}</span>
                                  <span className="punc-period-class">{e.class_node_name}{e.subject_name ? ` · ${e.subject_name}` : ''}</span>
                                </div>
                                <button
                                  className={`punc-period-btn${s === 'present' ? ' punc-period-btn--present' : s === 'absent' ? ' punc-period-btn--absent' : ''}`}
                                  onClick={() => {
                                    if (!markedBy) return
                                    handleMarkOne(e, t.staff_id, s === 'present' ? 'absent' : 'present')
                                  }}
                                  disabled={!markedBy}
                                >
                                  {s === 'present' ? 'Present' : s === 'absent' ? 'Absent' : 'Mark'}
                                </button>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* ═══ REPORT TAB ═══ */}
      {tab === 'report' && (
        <div className="punc-report">
          <div className="punc-pills">
            {(['day', 'week', 'term', 'session'] as PunctualityScope[]).map(s => (
              <button key={s} className={`punc-pill${reportScope === s ? ' punc-pill--active' : ''}`}
                onClick={() => setReportScope(s)}>
                {s === 'day' ? 'Today' : s === 'week' ? 'This Week' : s === 'term' ? 'This Term' : 'This Session'}
              </button>
            ))}
          </div>

          {reportLoading && (
            <div className="punc-skeleton-list">
              {[1, 2, 3].map(i => <div key={i} className="punc-skel skeleton" />)}
            </div>
          )}

          {reportError && !reportLoading && (
            <div className="punc-msg-box">
              <Icon name="alert-triangle" size={20} style={{ color: 'var(--color-warning, #d97706)' }} />
              <p>{reportError}</p>
              <button className="punc-btn-small" onClick={loadReport}>Retry</button>
            </div>
          )}

          {!reportLoading && !reportError && reportData && (
            <>
              <div className="punc-report-summary">
                <div className="punc-report-stat">
                  <span className="punc-report-stat-value">{reportData.totalScheduled}</span>
                  <span className="punc-report-stat-label">Scheduled</span>
                </div>
                <div className="punc-report-stat punc-report-stat--green">
                  <span className="punc-report-stat-value">{reportData.totalPresent}</span>
                  <span className="punc-report-stat-label">Present</span>
                </div>
                <div className="punc-report-stat punc-report-stat--red">
                  <span className="punc-report-stat-value">{reportData.totalAbsent}</span>
                  <span className="punc-report-stat-label">Absent</span>
                </div>
                <div className="punc-report-stat punc-report-stat--gray">
                  <span className="punc-report-stat-value">{reportData.totalUnrecorded}</span>
                  <span className="punc-report-stat-label">Unchecked</span>
                </div>
              </div>

              {reportData.overallRate > 0 && (
                <div className="punc-rate-bar-wrap">
                  <div className="punc-rate-bar">
                    <div className="punc-rate-bar-fill" style={{ width: `${reportData.overallRate}%` }} />
                  </div>
                  <span className="punc-rate-label">{reportData.overallRate}% punctuality rate</span>
                </div>
              )}

              {reportData.teachers.length > 0 ? (
                <div className="punc-report-list">
                  {reportData.teachers.map(t => (
                    <div key={t.staff_id} className="punc-report-row">
                      <div className="punc-report-row-left">
                        <span className="punc-report-row-name">{t.staff_name}</span>
                        <span className="punc-report-row-detail">
                          {t.present} present · {t.absent} absent · {t.unrecorded} unchecked
                        </span>
                      </div>
                      <span className={`punc-report-row-rate${t.punctualityRate >= 80 ? ' punc-report-row-rate--good' : t.punctualityRate > 0 ? ' punc-report-row-rate--warn' : ''}`}>
                        {t.punctualityRate > 0 ? `${t.punctualityRate}%` : '—'}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="punc-empty-state">
                  <Icon name="bar-chart" size={36} />
                  <p className="punc-empty-msg">No punctuality data yet.</p>
                  <p className="punc-empty-sub">Records will appear here once a proctor marks teacher presence.</p>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
