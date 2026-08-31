/**
 * ReportCardsPanel.tsx
 * PRD Tier 8 / Problem 8.4 (Session 49) — the report-cards surface inside
 * ResultsModule's secondary path. Rendered as a mode tab next to score entry,
 * visible only to admins and staff holding academics.remarks.manage.
 *
 * What it does:
 *   - Lists every active student of the selected class for the selected
 *     term/window with their cross-subject average and overall position.
 *   - Lets remark-holders edit each student's class-teacher remark inline
 *     (saved on blur, per-student, against the covering window).
 *   - One-tap PDF report card download per student (reportCardPdf.ts —
 *     jsPDF, same real-download precedent as transcriptPdf.ts).
 *
 * Deliberately NOT here: subject-level detail. The PDF assembly pulls the
 * full picture server-side via loadReportCardData(); this list stays light
 * (one subject_results read for the whole class) so it renders instantly.
 */

import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { useAuthStore } from '../stores/authStore'
import { useSchoolStore } from '../stores/schoolStore'
import { Icon } from '../components/icons'
import {
  loadReportCardData,
  loadRemarksForWindow,
  saveStudentRemark,
  type AssessmentWindow,
  type AssessmentWindowClassRow,
} from '../services/assessmentService'
import { downloadReportCardPdf } from '../services/reportCardPdf'
import type { Session, Term, TeachingAssignment } from '../services/resultsService'

type LoadState = 'booting' | 'loading' | 'ready' | 'empty' | 'error'

interface ReportCardsPanelProps {
  schoolId: string
  isAdmin: boolean
  session: Session | null
  selectedTerm: Term | null
  selectedAssign: TeachingAssignment | null
  winInfo: { window: AssessmentWindow; windowClass: AssessmentWindowClassRow | null } | null
}

interface RowState {
  studentId: string
  fullName: string
  average: number | null
  position: number | null
  gradedCount: number
}

export default function ReportCardsPanel({
  schoolId,
  isAdmin,
  session,
  selectedTerm,
  selectedAssign,
  winInfo,
}: ReportCardsPanelProps) {
  const actorRecordId = useAuthStore((s) => s.actorRecordId)
  const schoolName = useSchoolStore((s) => s.school?.name ?? '')

  const [state, setState] = useState<LoadState>('booting')
  const [error, setError] = useState('')
  const [rows, setRows] = useState<RowState[]>([])
  const [totalGraded, setTotalGraded] = useState(0)
  // Local editable copy of remarks keyed by studentId; '' when unset.
  const [remarks, setRemarks] = useState<Record<string, string>>({})
  const [savingRemarkFor, setSavingRemarkFor] = useState<string | null>(null)
  const [inlineError, setInlineError] = useState('')
  const [pdfBusyFor, setPdfBusyFor] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!selectedAssign || !session || !winInfo) return
    setState('loading')
    setError('')

    try {
      // Classmates + their results in one pass (same averaging shape as the
      // PDF assembly uses, kept consistent by construction).
      const studentsRes = await supabase
        .from('students')
        .select('id, full_name')
        .eq('class_node_id', selectedAssign.class_node_id)
        .eq('status', 'active')
        .order('full_name')
      if (studentsRes.error) { setError(studentsRes.error.message); setState('error'); return }
      const classmates = (studentsRes.data ?? []) as Array<{ id: string; full_name: string }>

      if (classmates.length === 0) {
        setRows([])
        setTotalGraded(0)
        setState('empty')
        return
      }

      let srQuery = supabase
        .from('subject_results')
        .select('student_id, weighted_total')
        .eq('school_id', schoolId)
        .eq('session_id', session.id)
        .in('student_id', classmates.map(s => s.id))
      srQuery = selectedTerm?.id ? srQuery.eq('term_id', selectedTerm.id) : srQuery.is('term_id', null)
      const srRes = await srQuery
      if (srRes.error) { setError(srRes.error.message); setState('error'); return }

      const sumByStudent = new Map<string, { sum: number; n: number }>()
      for (const r of (srRes.data ?? []) as Array<{ student_id: string; weighted_total: number }>) {
        const cur = sumByStudent.get(r.student_id) ?? { sum: 0, n: 0 }
        cur.sum += Number(r.weighted_total)
        cur.n += 1
        sumByStudent.set(r.student_id, cur)
      }
      const avgByStudent = new Map<string, number>()
      for (const [sid, agg] of sumByStudent) avgByStudent.set(sid, agg.sum / agg.n)
      const ranked = [...avgByStudent.entries()].sort((a, b) => b[1] - a[1])
      setTotalGraded(ranked.length)

      setRows(classmates.map(s => ({
        studentId: s.id,
        fullName: s.full_name,
        average: avgByStudent.get(s.id) ?? null,
        position: ranked.findIndex(([sid]) => sid === s.id) >= 0
          ? ranked.findIndex(([sid]) => sid === s.id) + 1
          : null,
        gradedCount: sumByStudent.get(s.id)?.n ?? 0,
      })))

      const rmRes = await loadRemarksForWindow(winInfo.window.id)
      if (!rmRes.ok) { setError(rmRes.error); setState('error'); return }
      const rmMap: Record<string, string> = {}
      for (const r of rmRes.data) rmMap[r.student_id] = r.remark ?? ''
      setRemarks(rmMap)

      setState('ready')
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load report cards')
      setState('error')
    }
  }, [selectedAssign, session, selectedTerm, winInfo])

  useEffect(() => { load() }, [load])

  async function handleRemarkBlur(studentId: string) {
    if (!winInfo || !actorRecordId) return
    setSavingRemarkFor(studentId)
    setInlineError('')
    const res = await saveStudentRemark({
      schoolId,
      windowId: winInfo.window.id,
      studentId,
      remark: remarks[studentId] ?? '',
      enteredBy: actorRecordId,
    })
    setSavingRemarkFor(null)
    if (!res.ok) setInlineError(res.error)
  }

  async function handleDownload(studentId: string) {
    if (!selectedAssign || !session || !winInfo) return
    setPdfBusyFor(studentId)
    setInlineError('')
    const res = await loadReportCardData({
      schoolId,
      sessionId: session.id,
      termId: selectedTerm?.id ?? null,
      termName: selectedTerm?.name ?? null,
      sessionName: session.name,
      classNodeId: selectedAssign.class_node_id,
      className: selectedAssign.class_node_name,
      studentId,
      windowId: winInfo.window.id,
    })
    setPdfBusyFor(null)
    if (!res.ok) { setInlineError(res.error); return }
    downloadReportCardPdf({ schoolName, data: res.data })
  }

  if (!selectedAssign || !session) {
    return (
      <div className="res-empty-state res-empty-state--prompt">
        <span className="res-empty-icon"><Icon name="file-text" /></span>
        <p className="res-empty-msg">Select a subject and class above to view its report cards.</p>
      </div>
    )
  }

  if (!winInfo) {
    return (
      <div className="res-empty-state">
        <span className="res-empty-icon"><Icon name="calendar" /></span>
        <p className="res-empty-msg">No assessment window covers this class yet.</p>
        <p className="res-empty-sub">
          Report cards are generated per assessment window
          {isAdmin ? ' — create one in Settings > Assessments first.' : '.'}
        </p>
      </div>
    )
  }

  if (state === 'loading' || state === 'booting') {
    return (
      <div className="res-grid-skel">
        {[1, 2, 3, 4].map(i => <div key={i} className="res-row-skel skeleton" />)}
      </div>
    )
  }
  if (state === 'error') {
    return (
      <div className="res-error-state">
        <span className="res-error-icon"><Icon name="alert-triangle" style={{ color: 'var(--color-warning, #d97706)' }} /></span>
        <p className="res-error-msg">{error}</p>
        <button className="res-retry-btn" onClick={load}>Retry</button>
      </div>
    )
  }
  if (state === 'empty' || rows.length === 0) {
    return (
      <div className="res-empty-state">
        <span className="res-empty-icon"><Icon name="users" /></span>
        <p className="res-empty-msg">No students enrolled in {selectedAssign.class_node_name} yet.</p>
      </div>
    )
  }

  return (
    <div className="rpt-root">
      <p className="rpt-window-label">
        <Icon name="file-text" size={14} />
        {' '}{winInfo.window.name}{selectedTerm ? ` · ${selectedTerm.name}` : ''} · {selectedAssign.class_node_name}
      </p>
      {inlineError && <p className="set-form-error">{inlineError}</p>}

      <div className="rpt-list">
        {rows.map(r => (
          <div key={r.studentId} className="rpt-row">
            <div className="rpt-row-main">
              <p className="rpt-row-name">{r.fullName}</p>
              <p className="rpt-row-meta">
                {r.average !== null
                  ? <>Avg {r.average.toFixed(1)}{r.position !== null ? ` · ${ordinalSuffix(r.position)} of ${totalGraded}` : ''}</>
                  : 'No approved results yet'}
              </p>
            </div>

            <textarea
              className="rpt-remark-input"
              rows={2}
              placeholder="Class teacher's remark…"
              value={remarks[r.studentId] ?? ''}
              onChange={e => setRemarks(prev => ({ ...prev, [r.studentId]: e.target.value }))}
              onBlur={() => handleRemarkBlur(r.studentId)}
            />

            <button
              className="rpt-pdf-btn"
              onClick={() => handleDownload(r.studentId)}
              disabled={pdfBusyFor === r.studentId}
              aria-label={`Download report card for ${r.fullName}`}
            >
              {pdfBusyFor === r.studentId
                ? <Icon name="refresh-cw" size={15} />
                : <><Icon name="file-text" size={15} /> PDF</>}
            </button>
          </div>
        ))}
      </div>
      {savingRemarkFor && <p className="rpt-saving-hint">Saving remark…</p>}
    </div>
  )
}

// ─── Small helpers ────────────────────────────────────────────────────────────

function ordinalSuffix(n: number): string {
  const rem10 = n % 10
  const rem100 = n % 100
  if (rem10 === 1 && rem100 !== 11) return `${n}st`
  if (rem10 === 2 && rem100 !== 12) return `${n}nd`
  if (rem10 === 3 && rem100 !== 13) return `${n}rd`
  return `${n}th`
}
