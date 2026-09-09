/**
 * ReportCardsPanel.tsx
 * PRD Tier 8 / Problem 8.4 (Session 49, rebuilt Session 81 — owner request).
 *
 * Session 81 rebuild — what changed and why:
 *   - DROPPED the subject/teaching-assignment dependency entirely. The
 *     owner's own words: "The report card tab doesn't need a subject
 *     selector. Just classes/whole school, and maybe a term/session
 *     selector." Previously this panel was mounted INSIDE ResultsModule's
 *     subject-scoped state and could not even load without a subject+class
 *     assignment picked first (see ResultsModule.tsx's own history for why
 *     that coupling existed — it borrowed the surrounding screen's state
 *     rather than owning its own). This panel is now fully self-sufficient:
 *     it loads its own session/terms/classes/grade-bands on mount, taking
 *     only schoolId + isAdmin from its parent.
 *   - Class picker uses the SAME whole-school leaf-class list Attendance
 *     already uses (loadAllLeafClasses) — not the teaching-assignment-
 *     derived "classes I teach a subject in" list ResultsModule's own
 *     picker uses, since a principal or form master needs to browse EVERY
 *     class here, not just ones they hold a subject assignment for.
 *   - ADDED: student search (filters the loaded roster client-side).
 *   - ADDED: checkbox multi-select with "select all filtered", "Print all"
 *     and "Print selected" — both produce ONE combined multi-page PDF via
 *     reportCardPdf.ts's new downloadBatchReportCardPdf() (owner's explicit
 *     answer: one file, not a zip of separate PDFs).
 *   - ADDED: passport photo now flows through automatically (students.
 *     photo_url, already resolved via getStudentPhotoSignedUrl — reuses the
 *     exact signed-URL pattern the Students module already established,
 *     rather than inventing a second one).
 *
 * Still true from the original design: this list stays light (one
 * subject_results read for the whole class) — full per-subject detail is
 * only assembled server-side, per-student, at PDF-generation time via
 * loadReportCardData(), not duplicated into this list's own state.
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { useAuthStore } from '../stores/authStore'
import { useSchoolStore } from '../stores/schoolStore'
import { Icon } from '../components/icons'
import {
  loadReportCardData,
  loadRemarksForWindow,
  saveStudentRemark,
  loadGradeBands,
  resolveWindowForClass,
  type AssessmentWindow,
  type AssessmentWindowClassRow,
} from '../services/assessmentService'
import { downloadReportCardPdf, downloadBatchReportCardPdf, type ReportCardPdfOptions } from '../services/reportCardPdf'
import { loadCurrentSession, loadTermsForSession, type Session, type Term } from '../services/resultsService'
import { loadAllLeafClasses, type ClassNode } from '../services/attendanceService'
import { getStudentPhotoSignedUrl } from '../services/studentsService'
import { loadPublicConfig } from '../services/settingsService'

type BootState = 'booting' | 'ready' | 'error'
type LoadState = 'idle' | 'loading' | 'ready' | 'empty' | 'error'

interface ReportCardsPanelProps {
  schoolId: string
  isAdmin: boolean
}

interface RowState {
  studentId: string
  fullName: string
  average: number | null
  position: number | null
  selected: boolean
}

interface GradeBandRow {
  min_score: number
  max_score: number
  grade_label: string
  remark: string | null
}

export default function ReportCardsPanel({ schoolId, isAdmin }: ReportCardsPanelProps) {
  const actorRecordId = useAuthStore((s) => s.actorRecordId)
  const schoolName = useSchoolStore((s) => s.school?.name ?? '')
  const schoolLogoUrl = useSchoolStore((s) => s.school?.logo_url ?? null)

  // ── Boot: session, terms, classes, grade bands — all loaded ONCE, fully
  // independent of any subject/teaching-assignment state. ──────────────────
  const [bootState, setBootState] = useState<BootState>('booting')
  const [bootError, setBootError] = useState('')
  const [session, setSession] = useState<Session | null>(null)
  const [terms, setTerms] = useState<Term[]>([])
  const [selectedTerm, setSelectedTerm] = useState<Term | null>(null)
  const [classes, setClasses] = useState<ClassNode[]>([])
  const [selectedClassId, setSelectedClassId] = useState<string | null>(null)
  const [gradeBands, setGradeBands] = useState<GradeBandRow[]>([])
  // Session 82 (owner feedback, real-device test): school address/phone/
  // email on the printed card — these already exist as school_public_
  // config.contact_info (same source PublicHomepage.tsx's contact section
  // reads), NOT a new field; just wasn't wired into the PDF options before.
  const [schoolAddress, setSchoolAddress] = useState<string | null>(null)
  const [schoolPhone, setSchoolPhone] = useState<string | null>(null)
  const [schoolEmail, setSchoolEmail] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function boot() {
      setBootState('booting')
      const [sessionRes, classesRes, bandsRes, publicConfigRes] = await Promise.all([
        loadCurrentSession(),
        loadAllLeafClasses(schoolId),
        loadGradeBands(schoolId),
        loadPublicConfig(schoolId),
      ])
      if (cancelled) return
      if (!sessionRes.ok) { setBootError(sessionRes.error); setBootState('error'); return }
      if (!classesRes.ok) { setBootError(classesRes.error); setBootState('error'); return }

      setSession(sessionRes.data)
      setClasses(classesRes.data)
      if (bandsRes.ok) setGradeBands(bandsRes.data)
      if (publicConfigRes.data?.contact_info) {
        setSchoolAddress(publicConfigRes.data.contact_info.address ?? null)
        setSchoolPhone(publicConfigRes.data.contact_info.phone ?? null)
        setSchoolEmail(publicConfigRes.data.contact_info.email ?? null)
      }

      if (sessionRes.data.uses_terms) {
        const termsRes = await loadTermsForSession(sessionRes.data.id)
        if (cancelled) return
        if (termsRes.ok) {
          setTerms(termsRes.data)
          setSelectedTerm(termsRes.data[0] ?? null)
        }
      }
      setBootState('ready')
    }
    boot()
    return () => { cancelled = true }
  }, [schoolId])

  // ── Window resolution for the selected class + term ──────────────────────
  const [winInfo, setWinInfo] = useState<{ window: AssessmentWindow; windowClass: AssessmentWindowClassRow | null } | null>(null)
  const [winChecked, setWinChecked] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function resolveWin() {
      if (!session || !selectedClassId) { setWinInfo(null); setWinChecked(false); return }
      setWinChecked(false)
      const res = await resolveWindowForClass({
        sessionId: session.id,
        termId: selectedTerm?.id ?? null,
        classNodeId: selectedClassId,
      })
      if (cancelled) return
      setWinInfo(res.ok ? res.data : null)
      setWinChecked(true)
    }
    resolveWin()
    return () => { cancelled = true }
  }, [session, selectedTerm, selectedClassId])

  // ── Roster + averages + remarks for the selected class ────────────────────
  const [loadState, setLoadState] = useState<LoadState>('idle')
  const [loadError, setLoadError] = useState('')
  const [rows, setRows] = useState<RowState[]>([])
  const [totalGraded, setTotalGraded] = useState(0)
  const [remarks, setRemarks] = useState<Record<string, string>>({})
  const [inlineError, setInlineError] = useState('')
  const [search, setSearch] = useState('')

  const selectedClass = classes.find(c => c.id === selectedClassId) ?? null

  const load = useCallback(async () => {
    if (!selectedClassId || !session || !winChecked) return
    setLoadState('loading')
    setLoadError('')
    setInlineError('')

    try {
      const studentsRes = await supabase
        .from('students')
        .select('id, full_name')
        .eq('class_node_id', selectedClassId)
        .eq('status', 'active')
        .order('full_name')
      if (studentsRes.error) { setLoadError(studentsRes.error.message); setLoadState('error'); return }
      const classmates = (studentsRes.data ?? []) as Array<{ id: string; full_name: string }>

      if (classmates.length === 0) {
        setRows([])
        setTotalGraded(0)
        setLoadState('empty')
        return
      }

      const NULL_TERM_SENTINEL = '00000000-0000-0000-0000-000000000000'
      const srRes = await supabase.rpc('get_subject_results', {
        p_school_id: schoolId,
        p_session_id: session.id,
        p_student_ids: classmates.map(s => s.id),
        p_term_id: selectedTerm?.id ?? NULL_TERM_SENTINEL,
      })
      if (srRes.error) { setLoadError(srRes.error.message); setLoadState('error'); return }

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
        selected: false,
      })))

      if (winInfo) {
        const rmRes = await loadRemarksForWindow(winInfo.window.id)
        if (rmRes.ok) {
          const rmMap: Record<string, string> = {}
          for (const r of rmRes.data) rmMap[r.student_id] = r.remark ?? ''
          setRemarks(rmMap)
        }
      } else {
        setRemarks({})
      }

      setLoadState('ready')
    } catch (e: any) {
      setLoadError(e?.message ?? 'Failed to load report cards')
      setLoadState('error')
    }
  }, [selectedClassId, session, selectedTerm, winInfo, winChecked, schoolId])

  useEffect(() => { load() }, [load])

  // Reset search whenever the class changes, so a filter from a previous
  // class never silently carries over.
  useEffect(() => { setSearch('') }, [selectedClassId])

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows
    return rows.filter(r => r.fullName.toLowerCase().includes(q))
  }, [rows, search])

  const selectedCount = rows.filter(r => r.selected).length
  const allFilteredSelected = filteredRows.length > 0 && filteredRows.every(r => r.selected)

  function toggleSelectAllFiltered() {
    const filteredIds = new Set(filteredRows.map(r => r.studentId))
    setRows(prev => prev.map(r => filteredIds.has(r.studentId) ? { ...r, selected: !allFilteredSelected } : r))
  }

  function toggleRowSelected(studentId: string) {
    setRows(prev => prev.map(r => r.studentId === studentId ? { ...r, selected: !r.selected } : r))
  }

  async function handleRemarkBlur(studentId: string) {
    if (!winInfo || !actorRecordId) return
    setInlineError('')
    const res = await saveStudentRemark({
      schoolId,
      windowId: winInfo.window.id,
      studentId,
      remark: remarks[studentId] ?? '',
      enteredBy: actorRecordId,
    })
    if (!res.ok) setInlineError(res.error)
  }

  // ── PDF generation (single + batch) ───────────────────────────────────────
  const [pdfBusyFor, setPdfBusyFor] = useState<string | null>(null)
  const [batchBusy, setBatchBusy] = useState(false)
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null)

  async function buildOptionsForStudent(studentId: string): Promise<ReportCardPdfOptions | null> {
    if (!selectedClass || !session) return null
    const res = await loadReportCardData({
      schoolId,
      sessionId: session.id,
      termId: selectedTerm?.id ?? null,
      termName: selectedTerm?.name ?? null,
      sessionName: session.name,
      classNodeId: selectedClass.id,
      className: selectedClass.name,
      studentId,
      windowId: winInfo?.window.id ?? null,
    })
    if (!res.ok) { setInlineError(res.error); return null }

    // students.photo_url is a Storage PATH, same private-bucket pattern as
    // everywhere else it's consumed — resolve to a real signed URL here,
    // once, rather than pushing that resolution into reportCardPdf.ts
    // itself (which stays storage-agnostic and just draws whatever URL
    // it's handed).
    const photoUrl = await getStudentPhotoSignedUrl(res.data.studentPhotoUrl)

    return {
      schoolName,
      schoolAddress: schoolAddress ?? undefined,
      schoolPhone,
      schoolEmail,
      logoUrl: schoolLogoUrl,
      gradeBands,
      data: { ...res.data, studentPhotoUrl: photoUrl },
    }
  }

  async function handleDownloadOne(studentId: string) {
    setPdfBusyFor(studentId)
    setInlineError('')
    const opts = await buildOptionsForStudent(studentId)
    setPdfBusyFor(null)
    if (!opts) return
    await downloadReportCardPdf(opts)
  }

  /**
   * handleBatchDownload
   * Owner request: "print all"/"print selected students as a batch" -> ONE
   * combined multi-page PDF. `targetIds` is either every filtered row
   * (Print all — respects the current search filter, matching how "select
   * all filtered" already scopes to what's visibly filtered rather than
   * silently including hidden rows) or the checked subset (Print selected).
   */
  async function handleBatchDownload(targetIds: string[]) {
    if (targetIds.length === 0) return
    setBatchBusy(true)
    setInlineError('')
    setBatchProgress({ done: 0, total: targetIds.length })

    const optsList: ReportCardPdfOptions[] = []
    for (const studentId of targetIds) {
      const opts = await buildOptionsForStudent(studentId)
      if (opts) optsList.push(opts)
      setBatchProgress(prev => prev ? { ...prev, done: prev.done + 1 } : null)
    }

    setBatchBusy(false)
    setBatchProgress(null)
    if (optsList.length === 0) return

    const label = selectedTerm ? `${selectedClass?.name}-${selectedTerm.name}` : `${selectedClass?.name}-${session?.name}`
    await downloadBatchReportCardPdf(optsList, label ?? 'report-cards')
  }

  // ── Render ─────────────────────────────────────────────────────────────

  if (bootState === 'booting') {
    return (
      <div className="res-grid-skel">
        {[1, 2, 3, 4].map(i => <div key={i} className="res-row-skel skeleton" />)}
      </div>
    )
  }
  if (bootState === 'error') {
    return (
      <div className="res-error-state">
        <span className="res-error-icon"><Icon name="alert-triangle" style={{ color: 'var(--color-warning, #d97706)' }} /></span>
        <p className="res-error-msg">{bootError}</p>
      </div>
    )
  }

  return (
    <div className="rpt-root">
      {/* Class picker — pill style, matching Attendance's own picker
          (att-pill-row/att-pill) rather than a plain <select>, for visual
          consistency with the rest of the app. Whole-school class list, NOT
          teaching-assignment-scoped — see file header. */}
      <div className="res-selector-wrap">
        <label className="att-selector-label">Class</label>
        <div className="att-pill-row att-pill-row--class">
          {classes.map(c => (
            <button
              key={c.id}
              type="button"
              className={`att-pill${selectedClassId === c.id ? ' att-pill--active' : ''}`}
              onClick={() => setSelectedClassId(c.id)}
            >
              {c.path_label ?? c.name}
            </button>
          ))}
        </div>
      </div>

      {/* Term tabs — reuses ResultsModule's own res-term-bar/res-term-btn
          classes for visual consistency, only shown when the school
          actually uses terms. */}
      {session?.uses_terms && terms.length > 0 && (
        <div className="res-term-bar">
          {terms.map(t => (
            <button
              key={t.id}
              className={['res-term-btn', selectedTerm?.id === t.id ? 'res-term-btn--active' : ''].join(' ')}
              onClick={() => setSelectedTerm(t)}
            >
              {t.name}
            </button>
          ))}
        </div>
      )}

      {!selectedClassId ? (
        <div className="res-empty-state res-empty-state--prompt">
          <span className="res-empty-icon"><Icon name="file-text" /></span>
          <p className="res-empty-msg">Select a class above to view its report cards.</p>
        </div>
      ) : !winChecked || loadState === 'loading' || loadState === 'idle' ? (
        <div className="res-grid-skel">
          {[1, 2, 3, 4].map(i => <div key={i} className="res-row-skel skeleton" />)}
        </div>
      ) : loadState === 'error' ? (
        <div className="res-error-state">
          <span className="res-error-icon"><Icon name="alert-triangle" style={{ color: 'var(--color-warning, #d97706)' }} /></span>
          <p className="res-error-msg">{loadError}</p>
          <button className="res-retry-btn" onClick={load}>Retry</button>
        </div>
      ) : loadState === 'empty' || rows.length === 0 ? (
        <div className="res-empty-state">
          <span className="res-empty-icon"><Icon name="users" /></span>
          <p className="res-empty-msg">No students enrolled in {selectedClass?.name ?? 'this class'} yet.</p>
        </div>
      ) : (
        <>
          {!winInfo && (
            <div className="res-empty-state">
              <span className="res-empty-icon"><Icon name="calendar" /></span>
              <p className="res-empty-msg">No assessment window covers this class yet.</p>
              <p className="res-empty-sub">
                Report cards still show each student's average and position from approved
                subject results, but the class-teacher remark field is unavailable
                {isAdmin ? ' until a window is created in Settings > Assessments.' : '.'}
              </p>
            </div>
          )}

          <p className="rpt-window-label">
            <Icon name="file-text" size={14} />
            {' '}{winInfo ? winInfo.window.name : 'No window'}{selectedTerm ? ` · ${selectedTerm.name}` : ''} · {selectedClass?.name}
          </p>
          {inlineError && <p className="set-form-error">{inlineError}</p>}

          {/* Search + batch actions toolbar */}
          <div className="rpt-toolbar">
            <div className="rpt-search-wrap">
              <Icon name="search" size={14} />
              <input
                type="text"
                className="rpt-search-input"
                placeholder="Search students…"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
              {search && (
                <button className="rpt-search-clear" onClick={() => setSearch('')} aria-label="Clear search">
                  <Icon name="x" size={14} />
                </button>
              )}
            </div>

            <label className="rpt-select-all">
              <input
                type="checkbox"
                checked={allFilteredSelected}
                onChange={toggleSelectAllFiltered}
              />
              Select all{search ? ' filtered' : ''} ({filteredRows.length})
            </label>

            <div className="rpt-batch-actions">
              <button
                className="rpt-batch-btn"
                disabled={batchBusy || filteredRows.length === 0}
                onClick={() => handleBatchDownload(filteredRows.map(r => r.studentId))}
              >
                <Icon name="printer" size={14} /> Print all{search ? ' (filtered)' : ''}
              </button>
              <button
                className="rpt-batch-btn rpt-batch-btn--primary"
                disabled={batchBusy || selectedCount === 0}
                onClick={() => handleBatchDownload(rows.filter(r => r.selected).map(r => r.studentId))}
              >
                <Icon name="printer" size={14} /> Print selected ({selectedCount})
              </button>
            </div>
          </div>

          {batchProgress && (
            <p className="rpt-saving-hint">
              Preparing report cards… {batchProgress.done} of {batchProgress.total}
            </p>
          )}

          <div className="rpt-list">
            {filteredRows.length === 0 ? (
              <p className="res-empty-sub">No students match "{search}".</p>
            ) : (
              filteredRows.map(r => (
                <div key={r.studentId} className="rpt-row">
                  <input
                    type="checkbox"
                    className="rpt-row-checkbox"
                    checked={r.selected}
                    onChange={() => toggleRowSelected(r.studentId)}
                    aria-label={`Select ${r.fullName}`}
                  />
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
                    placeholder={winInfo ? "Class teacher's remark…" : 'No window open for remarks'}
                    value={remarks[r.studentId] ?? ''}
                    disabled={!winInfo}
                    onChange={e => setRemarks(prev => ({ ...prev, [r.studentId]: e.target.value }))}
                    onBlur={() => handleRemarkBlur(r.studentId)}
                  />

                  <button
                    className="rpt-pdf-btn"
                    onClick={() => handleDownloadOne(r.studentId)}
                    disabled={pdfBusyFor === r.studentId || batchBusy}
                    aria-label={`Download report card for ${r.fullName}`}
                  >
                    {pdfBusyFor === r.studentId
                      ? <Icon name="refresh-cw" size={15} />
                      : <><Icon name="file-text" size={15} /> PDF</>}
                  </button>
                </div>
              ))
            )}
          </div>
        </>
      )}
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
