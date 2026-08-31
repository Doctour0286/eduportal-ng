/**
 * SchemeOfWorkModule.tsx
 * Teacher term planning — structured weekly plan per subject/class.
 *
 * Weeks are auto-generated from the timetable + term dates.
 * Teachers fill in topics/objectives/activities per week slot.
 * Coverage tracking: teachers mark weeks as they teach them.
 *
 * Teacher view: list, create (timetable-derived weeks), edit, submit, track coverage.
 * Admin view: all schemes, approve/return, edit any, import from board, create templates.
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useAuthStore } from '../stores/authStore'
import { Icon } from '../components/icons'
import { loadCurrentSession } from '../services/timetableService'
import { loadSessions, type Session } from '../services/settingsService'
import {
  loadMySchemes, loadAllSchemes, loadSchemeDetail, loadCurriculumTemplates,
  loadCurriculumMetadata, loadAllTemplateSets,
  loadSchoolTemplates, loadSchoolTemplateDetail, createSchoolTemplate,
  updateSchoolTemplate, deleteSchoolTemplate, adoptSchoolTemplate,
  loadCurrentTerm, loadTeacherAssignments, loadAllTeachingAssignments, loadTimetableSlots,
  generateWeeksFromTimetable, createScheme, saveSchemeWeeks,
  submitScheme, approveScheme, returnScheme, importFromTemplate, markWeekCoverage,
  getUniqueClasses, getSubjectsForClass,
  type SchemeOfWork, type SchemeDetail, type SchemeWeek, type SchemeStatus,
  type CurriculumTemplate, type TeachingAssignmentOption, type CurrentTerm,
  type CoverageStatus, type CurriculumMetadata, type CurriculumTemplateSet,
  type SchoolCurriculumTemplate, type SchoolCurriculumTemplateWeek, type SchoolCurriculumTemplateDetail,
} from '../services/schemeOfWorkService'

interface SchemeOfWorkModuleProps {
  schoolId: string
  isAdmin: boolean
}

type CreateMode = 'manual' | 'import' | 'template'

export default function SchemeOfWorkModule({ schoolId, isAdmin }: SchemeOfWorkModuleProps) {
  const actorRecordId = useAuthStore(s => s.actorRecordId)
  const canManage = useAuthStore(s => s.can('academics.scheme_of_work.manage'))
  const canApprove = useAuthStore(s => s.can('academics.scheme_of_work.approve'))
  const canViewAll = useAuthStore(s => s.can('academics.scheme_of_work.view_all'))

  const [sessionId, setSessionId] = useState<string | null>(null)
  const [currentTerm, setCurrentTerm] = useState<CurrentTerm | null>(null)
  const [assignments, setAssignments] = useState<TeachingAssignmentOption[]>([])
  const [allAssignments, setAllAssignments] = useState<TeachingAssignmentOption[]>([])
  const [tab, setTab] = useState<'list' | 'create' | 'detail' | 'templates' | 'create-school'>('list')
  const [statusFilter, setStatusFilter] = useState<SchemeStatus | 'all'>('all')
  const [sessionFilter, setSessionFilter] = useState<string>('current')
  const [classFilter, setClassFilter] = useState<string>('all')
  const [allSessions, setAllSessions] = useState<Session[]>([])
  const [schemes, setSchemes] = useState<SchemeOfWork[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Detail view
  const [selectedScheme, setSelectedScheme] = useState<SchemeDetail | null>(null)
  const [isEditing, setIsEditing] = useState(false)

  // Create state
  const [createMode, setCreateMode] = useState<CreateMode | null>(null)
  const [selectedAssignmentId, setSelectedAssignmentId] = useState<string | null>(null)
  const [selectedClass, setSelectedClass] = useState<string>('')
  const [selectedSubject, setSelectedSubject] = useState<string>('')
  const [generatedWeeks, setGeneratedWeeks] = useState<{
    week_number: number; week_start_date: string; week_end_date: string;
    lesson_dates: string[]; period_label: string; period_time: string
  }[]>([])
  const [weeks, setWeeks] = useState<(Omit<SchemeWeek, 'id' | 'scheme_of_work_id' | 'school_id' | 'created_at' | 'updated_at'> & { id?: string })[]>([])
  const [slotsLoading, setSlotsLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Template import
  const [showTemplatePicker, setShowTemplatePicker] = useState(false)
  const [templates, setTemplates] = useState<CurriculumTemplate[]>([])
  const [templateSubject, setTemplateSubject] = useState('')
  const [templateLevel, setTemplateLevel] = useState('')
  const [templateTerm, setTemplateTerm] = useState('')
  const [templateBoard, setTemplateBoard] = useState('')
  const [templateLoading, setTemplateLoading] = useState(false)
  const [importing, setImporting] = useState(false)

  // Curriculum metadata for cascading dropdowns
  const [curriculumMeta, setCurriculumMeta] = useState<CurriculumMetadata[]>([])

  // Templates screen state
  const [templateTab, setTemplateTab] = useState<'board' | 'school'>('board')
  const [boardTemplateSets, setBoardTemplateSets] = useState<CurriculumTemplateSet[]>([])
  const [boardTemplateSetsLoading, setBoardTemplateSetsLoading] = useState(false)
  const [schoolTemplates, setSchoolTemplates] = useState<SchoolCurriculumTemplate[]>([])
  const [schoolTemplatesLoading, setSchoolTemplatesLoading] = useState(false)
  const [selectedBoardSet, setSelectedBoardSet] = useState<CurriculumTemplateSet | null>(null)
  const [selectedSchoolTpl, setSelectedSchoolTpl] = useState<SchoolCurriculumTemplateDetail | null>(null)
  const [boardAdoptStep, setBoardAdoptStep] = useState<'browse' | 'adopt'>('browse')

  // School template creation/editing
  const [schoolTplForm, setSchoolTplForm] = useState({
    name: '',
    subjectLabel: '',
    classLevelLabel: '',
  })
  const [schoolTplWeeks, setSchoolTplWeeks] = useState<Omit<SchoolCurriculumTemplateWeek, 'id' | 'template_id' | 'school_id'>[]>([])
  const [editingSchoolTpl, setEditingSchoolTpl] = useState<string | null>(null)
  const [savingSchoolTpl, setSavingSchoolTpl] = useState(false)

  // Approval
  const [returnNote, setReturnNote] = useState('')
  const [showReturnForm, setShowReturnForm] = useState(false)

  // Coverage tracking
  const [markingCoverage, setMarkingCoverage] = useState<string | null>(null)

  // Derived: classes and subjects for separate dropdowns
  const activeAssignments = isAdmin ? allAssignments : assignments
  const uniqueClasses = useMemo(() => getUniqueClasses(activeAssignments), [activeAssignments])
  const subjectsForClass = useMemo(() => selectedClass ? getSubjectsForClass(activeAssignments, selectedClass) : [], [activeAssignments, selectedClass])

  // Derived: available classes from fetched schemes + filtered schemes list
  const availableClasses = useMemo(() => {
    const seen = new Set<string>()
    return schemes.filter(s => {
      if (!s.class_name || seen.has(s.class_name)) return false
      seen.add(s.class_name)
      return true
    }).map(s => s.class_name!)
  }, [schemes])

  const filteredSchemes = useMemo(() => {
    if (classFilter === 'all') return schemes
    return schemes.filter(s => s.class_name === classFilter)
  }, [schemes, classFilter])

  // ─── Init ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const sRes = await loadCurrentSession()
      if (cancelled || !sRes.ok || !sRes.sessionId) return
      setSessionId(sRes.sessionId)
      const tRes = await loadCurrentTerm(sRes.sessionId)
      if (!cancelled && tRes.ok) setCurrentTerm(tRes.data)
      if (actorRecordId) {
        const aRes = await loadTeacherAssignments(actorRecordId, sRes.sessionId)
        if (!cancelled && aRes.ok) setAssignments(aRes.data)
      }
      if (isAdmin) {
        const allRes = await loadAllTeachingAssignments(sRes.sessionId)
        if (!cancelled && allRes.ok) setAllAssignments(allRes.data)
        const metaRes = await loadCurriculumMetadata()
        if (!cancelled && metaRes.ok) setCurriculumMeta(metaRes.data)
        const sessRes = await loadSessions(schoolId)
        if (!cancelled && sessRes.data) setAllSessions(sessRes.data)
      }
    })()
    return () => { cancelled = true }
  }, [actorRecordId, isAdmin, schoolId])

  // ─── Load schemes ──────────────────────────────────────────────────────────

  const handleSessionFilterChange = useCallback((newSession: string) => {
    setSessionFilter(newSession)
    setClassFilter('all')
  }, [])

  const loadSchemes = useCallback(async () => {
    if (!sessionId) return
    setLoading(true); setError(null)
    if (isAdmin || canViewAll) {
      const effectiveSessionId = sessionFilter === 'current' ? sessionId : sessionFilter === 'all' ? undefined : sessionFilter
      const res = await loadAllSchemes({ sessionId: effectiveSessionId, status: statusFilter === 'all' ? undefined : statusFilter })
      if (res.ok) setSchemes(res.data); else setError(res.error)
    } else {
      const res = await loadMySchemes(sessionId)
      if (res.ok) setSchemes(res.data); else setError(res.error)
    }
    setLoading(false)
  }, [sessionId, isAdmin, canViewAll, statusFilter, sessionFilter])

  useEffect(() => { loadSchemes() }, [loadSchemes])

  // ─── Load detail ───────────────────────────────────────────────────────────

  const handleViewDetail = useCallback(async (schemeId: string) => {
    const res = await loadSchemeDetail(schemeId)
    if (res.ok) {
      setSelectedScheme(res.data)
      setWeeks(res.data.weeks.map(w => ({
        id: w.id, week_number: w.week_number, topic: w.topic, objectives: w.objectives,
        activities: w.activities, resources: w.resources,
        coverage_status: w.coverage_status, coverage_note: w.coverage_note,
        week_start_date: w.week_start_date, week_end_date: w.week_end_date,
        lesson_dates: w.lesson_dates, period_label: w.period_label, period_time: w.period_time,
      })))
      setIsEditing(false)
      setTab('detail')
    }
  }, [])

  // ─── Create: class/subject selection → load timetable slots ────────────────

  const handleClassChange = useCallback((className: string) => {
    setSelectedClass(className)
    setSelectedSubject('')
    setSelectedAssignmentId(null)
    setGeneratedWeeks([])
    setWeeks([])
  }, [])

  const handleSubjectChange = useCallback(async (subjectName: string) => {
    setSelectedSubject(subjectName)
    const match = activeAssignments.find(a => a.className === selectedClass && a.subjectName === subjectName)
    setSelectedAssignmentId(match?.id ?? null)
    setGeneratedWeeks([])
    setWeeks([])
    if (!sessionId || !match || !currentTerm) return
    setSlotsLoading(true)
    const slotsRes = await loadTimetableSlots(sessionId, match.id)
    if (slotsRes.ok && slotsRes.data.length > 0) {
      const generated = generateWeeksFromTimetable({
        slots: slotsRes.data,
        termStart: currentTerm.startDate,
        termEnd: currentTerm.endDate,
      })
      setGeneratedWeeks(generated)
      setWeeks(generated.map(g => ({
        week_number: g.week_number, topic: '', objectives: null,
        activities: null, resources: null,
        coverage_status: 'planned' as CoverageStatus, coverage_note: null,
        week_start_date: g.week_start_date, week_end_date: g.week_end_date,
        lesson_dates: g.lesson_dates, period_label: g.period_label, period_time: g.period_time,
      })))
    }
    setSlotsLoading(false)
  }, [sessionId, currentTerm, activeAssignments, selectedClass])

  // ─── Week editing ──────────────────────────────────────────────────────────

  const updateWeek = useCallback((index: number, field: string, value: string) => {
    setWeeks(prev => prev.map((w, i) => i === index ? { ...w, [field]: value || null } : w))
  }, [])

  // ─── Save ──────────────────────────────────────────────────────────────────

  const handleSave = useCallback(async (): Promise<boolean> => {
    if (!sessionId || !schoolId) return false
    if (weeks.length === 0) { setSaveError('No weeks to save'); return false }
    const hasContent = weeks.some(w => w.topic.trim())
    if (!hasContent) { setSaveError('Enter at least one topic before saving'); return false }
    setSaving(true); setSaveError(null)
    try {
      const { user } = useAuthStore.getState()
      if (!user) { setSaveError('Not authenticated'); setSaving(false); return false }
      if (selectedScheme) {
        const res = await saveSchemeWeeks(selectedScheme.id, schoolId, weeks)
        if (!res.ok) { setSaveError(res.error); setSaving(false); return false }
      } else {
        if (!selectedAssignmentId) { setSaveError('Select a subject/class'); setSaving(false); return false }
        const createRes = await createScheme({
          schoolId, teachingAssignmentId: selectedAssignmentId,
          sessionId, termId: currentTerm?.id ?? null, userId: user.id,
        })
        if (!createRes.ok) { setSaveError(createRes.error); setSaving(false); return false }
        const saveRes = await saveSchemeWeeks(createRes.data.id, schoolId, weeks)
        if (!saveRes.ok) { setSaveError(saveRes.error); setSaving(false); return false }
        const detailRes = await loadSchemeDetail(createRes.data.id)
        if (detailRes.ok) setSelectedScheme(detailRes.data)
      }
      setIsEditing(false)
      await loadSchemes(); setSaving(false); return true
    } catch (err: any) { setSaveError(err?.message ?? 'Failed to save'); setSaving(false); return false }
  }, [sessionId, schoolId, weeks, selectedScheme, selectedAssignmentId, currentTerm, loadSchemes])

  const handleSaveAndSubmit = useCallback(async () => {
    const saved = await handleSave()
    if (saved && selectedScheme) {
      const res = await submitScheme(selectedScheme.id)
      if (res.ok) { await loadSchemes(); setTab('list') }
      else setSaveError(res.error)
    } else if (saved) { setTab('list') }
  }, [handleSave, selectedScheme, loadSchemes])

  const handleApprove = useCallback(async (schemeId: string) => {
    if (!actorRecordId) return
    const res = await approveScheme(schemeId, actorRecordId)
    if (res.ok) { await loadSchemes(); setTab('list') }
  }, [actorRecordId, loadSchemes])

  const handleReturn = useCallback(async (schemeId: string) => {
    if (!actorRecordId || !returnNote.trim()) return
    const res = await returnScheme(schemeId, actorRecordId, returnNote.trim())
    if (res.ok) { await loadSchemes(); setTab('list'); setShowReturnForm(false); setReturnNote('') }
  }, [actorRecordId, returnNote, loadSchemes])

  // ─── Coverage tracking ─────────────────────────────────────────────────────

  const handleMarkCoverage = useCallback(async (weekId: string, status: CoverageStatus) => {
    setMarkingCoverage(weekId)
    const res = await markWeekCoverage(weekId, status)
    if (res.ok && selectedScheme) {
      setWeeks(prev => prev.map(w => w.id === weekId ? { ...w, coverage_status: status } : w))
    } else if (!res.ok) {
      setSaveError(`Failed to update coverage: ${res.error}`)
    }
    setMarkingCoverage(null)
  }, [selectedScheme])

  // ─── Template import ───────────────────────────────────────────────────────

  const loadTemplates = useCallback(async () => {
    setTemplateLoading(true)
    const res = await loadCurriculumTemplates({
      subjectName: templateSubject || undefined,
      level: templateLevel || undefined,
      term: templateTerm || undefined,
    })
    if (res.ok) setTemplates(res.data)
    setTemplateLoading(false)
  }, [templateSubject, templateLevel, templateTerm])

  const handleImportTemplate = useCallback(async () => {
    if (!selectedScheme || !templateBoard || !templateSubject || !templateLevel || !templateTerm) return
    setImporting(true)
    const res = await importFromTemplate(selectedScheme.id, schoolId, {
      subject_name: templateSubject, level: templateLevel,
      term: templateTerm, board_name: templateBoard,
    })
    if (res.ok) {
      const detailRes = await loadSchemeDetail(selectedScheme.id)
      if (detailRes.ok) {
        setSelectedScheme(detailRes.data)
        setWeeks(detailRes.data.weeks.map(w => ({
          id: w.id, week_number: w.week_number, topic: w.topic, objectives: w.objectives,
          activities: w.activities, resources: w.resources,
          coverage_status: w.coverage_status, coverage_note: w.coverage_note,
          week_start_date: w.week_start_date, week_end_date: w.week_end_date,
          lesson_dates: w.lesson_dates, period_label: w.period_label, period_time: w.period_time,
        })))
      }
      setShowTemplatePicker(false); setTemplateBoard(''); setTemplateSubject(''); setTemplateLevel(''); setTemplateTerm('')
    }
    setImporting(false)
  }, [selectedScheme, schoolId, templateBoard, templateSubject, templateLevel, templateTerm])

  const handleImportTemplateNew = useCallback(async () => {
    if (!selectedAssignmentId || !sessionId || !templateBoard || !templateSubject || !templateLevel || !templateTerm || !actorRecordId) return
    const { user } = useAuthStore.getState()
    if (!user) return
    setImporting(true); setSaveError(null)
    const res = await createScheme({
      schoolId, teachingAssignmentId: selectedAssignmentId,
      sessionId, termId: currentTerm?.id ?? null, userId: user.id,
    })
    if (!res.ok) { setSaveError(res.error); setImporting(false); return }
    const importRes = await importFromTemplate(res.data.id, schoolId, {
      subject_name: templateSubject, level: templateLevel,
      term: templateTerm, board_name: templateBoard,
    })
    if (importRes.ok) {
      const detailRes = await loadSchemeDetail(res.data.id)
      if (detailRes.ok) {
        setSelectedScheme(detailRes.data)
        setWeeks(detailRes.data.weeks.map(w => ({
          id: w.id, week_number: w.week_number, topic: w.topic, objectives: w.objectives,
          activities: w.activities, resources: w.resources,
          coverage_status: w.coverage_status, coverage_note: w.coverage_note,
          week_start_date: w.week_start_date, week_end_date: w.week_end_date,
          lesson_dates: w.lesson_dates, period_label: w.period_label, period_time: w.period_time,
        })))
        setTab('detail')
      }
      setShowTemplatePicker(false); setTemplateBoard(''); setTemplateSubject(''); setTemplateLevel(''); setTemplateTerm('')
    } else {
      setSaveError(importRes.error)
    }
    setImporting(false)
  }, [schoolId, sessionId, currentTerm, selectedAssignmentId, templateBoard, templateSubject, templateLevel, templateTerm, actorRecordId])

  // ─── Templates screen ──────────────────────────────────────────────────────

  const loadBoardTemplateSets = useCallback(async () => {
    setBoardTemplateSetsLoading(true)
    const res = await loadAllTemplateSets()
    if (res.ok) setBoardTemplateSets(res.data)
    setBoardTemplateSetsLoading(false)
  }, [])

  const loadSchoolTemplatesList = useCallback(async () => {
    setSchoolTemplatesLoading(true)
    const res = await loadSchoolTemplates(schoolId)
    if (res.ok) setSchoolTemplates(res.data)
    setSchoolTemplatesLoading(false)
  }, [schoolId])

  const handleAdoptBoardSet = useCallback(async (set: CurriculumTemplateSet) => {
    setSelectedBoardSet(set)
    setTemplateBoard(set.board_name)
    setTemplateSubject(set.subject_name)
    setTemplateLevel(set.level)
    setTemplateTerm(set.term)
    setBoardAdoptStep('adopt')
    // Load the actual template weeks for preview
    const res = await loadCurriculumTemplates({
      boardName: set.board_name, subjectName: set.subject_name,
      level: set.level, term: set.term,
    })
    if (res.ok) setTemplates(res.data)
  }, [])

  const handleAdoptSchoolTpl = useCallback(async (tpl: SchoolCurriculumTemplate) => {
    const res = await loadSchoolTemplateDetail(tpl.id, schoolId)
    if (res.ok) setSelectedSchoolTpl(res.data)
  }, [schoolId])

  const handleDeleteSchoolTpl = useCallback(async (tplId: string) => {
    const res = await deleteSchoolTemplate(tplId, schoolId)
    if (res.ok) await loadSchoolTemplatesList()
  }, [schoolId, loadSchoolTemplatesList])

  // ─── School template creation/editing ──────────────────────────────────────

  const addSchoolTplWeek = useCallback(() => {
    const nextNum = schoolTplWeeks.length + 1
    setSchoolTplWeeks(prev => [...prev, {
      week_number: nextNum, topic: '', objectives: null, activities: null, resources: null,
    }])
  }, [schoolTplWeeks.length])

  const updateSchoolTplWeek = useCallback((index: number, field: string, value: string) => {
    setSchoolTplWeeks(prev => prev.map((w, i) => i === index ? { ...w, [field]: value || null } : w))
  }, [])

  const removeSchoolTplWeek = useCallback((index: number) => {
    setSchoolTplWeeks(prev => prev.filter((_, i) => i !== index).map((w, i) => ({ ...w, week_number: i + 1 })))
  }, [])

  const handleSaveSchoolTpl = useCallback(async () => {
    if (!schoolTplForm.name.trim() || schoolTplWeeks.length === 0) return
    setSavingSchoolTpl(true); setSaveError(null)
    const { user } = useAuthStore.getState()
    if (!user) { setSaveError('Not authenticated'); setSavingSchoolTpl(false); return }

    const weeks = schoolTplWeeks.map((w, i) => ({ ...w, week_number: i + 1 }))

    if (editingSchoolTpl) {
      const res = await updateSchoolTemplate({
        templateId: editingSchoolTpl, schoolId,
        name: schoolTplForm.name, subjectLabel: schoolTplForm.subjectLabel || null,
        classLevelLabel: schoolTplForm.classLevelLabel || null, weeks,
      })
      if (!res.ok) { setSaveError(res.error); setSavingSchoolTpl(false); return }
    } else {
      const res = await createSchoolTemplate({
        schoolId, name: schoolTplForm.name,
        subjectLabel: schoolTplForm.subjectLabel || null,
        classLevelLabel: schoolTplForm.classLevelLabel || null,
        userId: user.id, weeks,
      })
      if (!res.ok) { setSaveError(res.error); setSavingSchoolTpl(false); return }
    }
    setSchoolTplForm({ name: '', subjectLabel: '', classLevelLabel: '' })
    setSchoolTplWeeks([])
    setEditingSchoolTpl(null)
    await loadSchoolTemplatesList()
    setTemplateTab('school')
    setSavingSchoolTpl(false)
  }, [schoolId, schoolTplForm, schoolTplWeeks, editingSchoolTpl, loadSchoolTemplatesList])

  const handleEditSchoolTpl = useCallback(async (tpl: SchoolCurriculumTemplate) => {
    const res = await loadSchoolTemplateDetail(tpl.id, schoolId)
    if (res.ok) {
      setEditingSchoolTpl(res.data.id)
      setSchoolTplForm({
        name: res.data.name,
        subjectLabel: res.data.subject_label ?? '',
        classLevelLabel: res.data.class_level_label ?? '',
      })
      setSchoolTplWeeks(res.data.weeks.map(w => ({
        week_number: w.week_number, topic: w.topic,
        objectives: w.objectives, activities: w.activities, resources: w.resources,
      })))
      setTab('create-school')
    }
  }, [schoolId])

  // ─── Helpers ───────────────────────────────────────────────────────────────

  const statusBadge = (status: SchemeStatus) => {
    const cls = status === 'approved' ? 'sow-badge--approved'
      : status === 'submitted' ? 'sow-badge--submitted'
      : status === 'returned' ? 'sow-badge--returned' : 'sow-badge--draft'
    return <span className={`sow-badge ${cls}`}>{status}</span>
  }

  const coverageBadge = (status: CoverageStatus) => {
    const cls = status === 'completed' ? 'sow-cov--completed'
      : status === 'in_progress' ? 'sow-cov--in-progress'
      : status === 'not_covered' ? 'sow-cov--not-covered' : 'sow-cov--planned'
    return <span className={`sow-cov ${cls}`}>{status.replace('_', ' ')}</span>
  }

  const formatDate = (d: string) => {
    if (!d) return ''
    const date = new Date(d + 'T00:00:00')
    return date.toLocaleDateString('en-NG', { month: 'short', day: 'numeric' })
  }

  const resetCreateState = () => {
    setCreateMode(null); setSelectedAssignmentId(null); setSelectedClass(''); setSelectedSubject('')
    setWeeks([]); setGeneratedWeeks([]); setSaveError(null); setShowTemplatePicker(false)
    setTemplateBoard(''); setTemplateSubject(''); setTemplateLevel(''); setTemplateTerm('')
    setSchoolTplForm({ name: '', subjectLabel: '', classLevelLabel: '' })
    setSchoolTplWeeks([]); setEditingSchoolTpl(null)
    setSelectedBoardSet(null); setSelectedSchoolTpl(null); setBoardAdoptStep('browse')
  }

  // ─── List view ────────────────────────────────────────────────────────────

  if (tab === 'list') {
    return (
      <div className="sow-root">
        <div className="sow-header">
          <h2 className="sow-title">Scheme of Work</h2>
          {(isAdmin || canManage) && (
            <div style={{ display: 'flex', gap: 8 }}>
              {isAdmin && (
                <button className="sow-btn sow-btn--outline" onClick={() => { resetCreateState(); setTab('templates'); loadBoardTemplateSets(); loadSchoolTemplatesList() }}>
                  <Icon name="clipboard-list" size={16} /> Templates
                </button>
              )}
              <button className="sow-btn sow-btn--primary" onClick={() => { resetCreateState(); setTab('create') }}>
                <Icon name="plus" size={16} /> New
              </button>
            </div>
          )}
        </div>

        {(isAdmin || canViewAll) && (
          <div className="sow-tabs">
            {(['all', 'draft', 'submitted', 'approved', 'returned'] as const).map(s => (
              <button key={s} className={`sow-tab ${statusFilter === s ? 'sow-tab--active' : ''}`} onClick={() => setStatusFilter(s)}>
                {s === 'all' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
        )}

        {(isAdmin || canViewAll) && (
          <div className="sow-filters">
            <div className="sow-filter">
              <label className="sow-filter-label">Session</label>
              <select className="sow-select sow-select--compact" value={sessionFilter} onChange={e => handleSessionFilterChange(e.target.value)}>
                <option value="current">Current session</option>
                <option value="all">All sessions</option>
                {allSessions.map(s => (
                  <option key={s.id} value={s.id}>{s.name}{s.is_current ? ' (current)' : ''}</option>
                ))}
              </select>
            </div>
            {availableClasses.length > 0 && (
              <div className="sow-filter">
                <label className="sow-filter-label">Class</label>
                <select className="sow-select sow-select--compact" value={classFilter} onChange={e => setClassFilter(e.target.value)}>
                  <option value="all">All classes</option>
                  {availableClasses.map(c => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
        )}

        {loading && <div className="sow-skel-list">{[1,2,3].map(i => <div key={i} className="sow-skel" />)}</div>}
        {error && <div className="sow-msg-box"><Icon name="alert-triangle" size={24} /><p>{error}</p></div>}

        {!loading && filteredSchemes.length === 0 && (
          <div className="sow-empty">
            <Icon name="clipboard-list" size={48} />
            <p className="sow-empty-msg">No schemes yet</p>
            <p className="sow-empty-sub">{(isAdmin || canManage) ? 'Create your first scheme to get started.' : 'No schemes assigned to you.'}</p>
          </div>
        )}

        {!loading && filteredSchemes.length > 0 && (
          <div className="sow-list">
            {filteredSchemes.map(scheme => (
              <button key={scheme.id} className="sow-card" onClick={() => handleViewDetail(scheme.id)}>
                <div className="sow-card-left">
                  <div className="sow-card-icon"><Icon name="file-text" size={20} /></div>
                  <div className="sow-card-info">
                    <div className="sow-card-title">{scheme.subject_name ?? 'Subject'}</div>
                    <div className="sow-card-meta">{scheme.class_name ?? 'Class'}{scheme.term_name ? ` · ${scheme.term_name}` : ''}</div>
                    {isAdmin && scheme.teacher_name && <div className="sow-card-meta">{scheme.teacher_name}</div>}
                  </div>
                </div>
                <div className="sow-card-right">
                  {statusBadge(scheme.status)}
                  <Icon name="chevron-down" size={16} />
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }

  // ─── Detail view ──────────────────────────────────────────────────────────

  if (tab === 'detail' && selectedScheme) {
    const canEditScheme = isAdmin || selectedScheme.status === 'draft' || selectedScheme.status === 'returned'
    const canSubmit = (selectedScheme.status === 'draft' || selectedScheme.status === 'returned') && (isAdmin || canManage)
    const canApproveAction = selectedScheme.status === 'submitted' && (isAdmin || canApprove)
    const completedCount = weeks.filter(w => w.coverage_status === 'completed').length
    const totalCount = weeks.length
    const progressPct = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0

    return (
      <div className="sow-root">
        <div className="sow-header">
          <button className="sow-back" onClick={() => { setTab('list'); setSelectedScheme(null); setIsEditing(false) }}>
            <Icon name="chevron-down" size={18} />
          </button>
          <div className="sow-header-text">
            <h2 className="sow-title">{selectedScheme.subject_name}</h2>
            <div className="sow-header-meta">{selectedScheme.class_name}{selectedScheme.term_name ? ` · ${selectedScheme.term_name}` : ''}</div>
          </div>
          <div className="sow-header-right">
            {statusBadge(selectedScheme.status)}
            {canEditScheme && !isEditing && selectedScheme.status !== 'submitted' && (
              <button className="sow-btn sow-btn--xs sow-btn--outline" onClick={() => setIsEditing(true)}>
                <Icon name="pencil" size={12} /> Edit
              </button>
            )}
          </div>
        </div>

        {selectedScheme.teacher_name && (
          <div className="sow-detail-row">Teacher: {selectedScheme.teacher_name}</div>
        )}

        {selectedScheme.status === 'returned' && selectedScheme.review_note && (
          <div className="sow-return-note"><Icon name="alert-triangle" size={14} /> {selectedScheme.review_note}</div>
        )}

        {totalCount > 0 && (
          <div className="sow-progress">
            <div className="sow-progress-header">
              <span className="sow-progress-label">Coverage</span>
              <span className="sow-progress-value">{completedCount}/{totalCount} weeks ({progressPct}%)</span>
            </div>
            <div className="sow-progress-bar">
              <div className="sow-progress-fill" style={{ width: `${progressPct}%` }} />
            </div>
          </div>
        )}

        <div className="sow-weeks">
          {weeks.map((week, idx) => (
            <div key={idx} className={`sow-week ${week.coverage_status === 'completed' ? 'sow-week--completed' : week.coverage_status === 'in_progress' ? 'sow-week--active' : ''}`}>
              <div className="sow-week-header">
                <div className="sow-week-left">
                  <span className="sow-week-num">W{week.week_number}</span>
                  {week.week_start_date && (
                    <span className="sow-week-dates">{formatDate(week.week_start_date)}{week.week_end_date ? ` – ${formatDate(week.week_end_date)}` : ''}</span>
                  )}
                </div>
                <div className="sow-week-right">
                  {week.period_label && <span className="sow-week-period">{week.period_label}{week.period_time ? ` ${week.period_time}` : ''}</span>}
                  {coverageBadge(week.coverage_status)}
                </div>
              </div>

              {isEditing ? (
                <div className="sow-week-body">
                  <input className="sow-input" placeholder="Topic" value={week.topic} onChange={e => updateWeek(idx, 'topic', e.target.value)} />
                  <textarea className="sow-textarea" placeholder="Objectives" rows={2} value={week.objectives ?? ''} onChange={e => updateWeek(idx, 'objectives', e.target.value)} />
                  <textarea className="sow-textarea" placeholder="Activities" rows={2} value={week.activities ?? ''} onChange={e => updateWeek(idx, 'activities', e.target.value)} />
                  <input className="sow-input" placeholder="Resources" value={week.resources ?? ''} onChange={e => updateWeek(idx, 'resources', e.target.value)} />
                </div>
              ) : (
                <div className="sow-week-body">
                  {week.topic && <div className="sow-week-topic">{week.topic}</div>}
                  {week.objectives && <div className="sow-week-detail"><strong>Objectives:</strong> {week.objectives}</div>}
                  {week.activities && <div className="sow-week-detail"><strong>Activities:</strong> {week.activities}</div>}
                  {week.resources && <div className="sow-week-detail"><strong>Resources:</strong> {week.resources}</div>}
                  {!week.topic && !week.objectives && <div className="sow-week-empty">No content yet</div>}
                </div>
              )}

              {week.id && (
                <div className="sow-week-actions">
                  {week.coverage_status !== 'completed' && (
                    <button className="sow-btn sow-btn--xs sow-btn--success" disabled={markingCoverage === week.id} onClick={() => handleMarkCoverage(week.id!, 'completed')}>
                      <Icon name="circle-check" size={12} /> Mark Covered
                    </button>
                  )}
                  {week.coverage_status === 'planned' && (
                    <button className="sow-btn sow-btn--xs sow-btn--outline" disabled={markingCoverage === week.id} onClick={() => handleMarkCoverage(week.id!, 'in_progress')}>
                      In Progress
                    </button>
                  )}
                  {week.coverage_status === 'completed' && (
                    <button className="sow-btn sow-btn--xs sow-btn--outline" disabled={markingCoverage === week.id} onClick={() => handleMarkCoverage(week.id!, 'planned')}>
                      Undo
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        {saveError && <div className="sow-error">{saveError}</div>}
        <div className="sow-footer">
          {isEditing && canSubmit && (
            <button className="sow-btn sow-btn--primary" onClick={handleSaveAndSubmit} disabled={saving || weeks.length === 0}>
              {saving ? 'Saving...' : 'Save & Submit'}
            </button>
          )}
          {isEditing && (
            <button className="sow-btn sow-btn--secondary" onClick={async () => { await handleSave() }} disabled={saving || weeks.length === 0}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          )}
          {isEditing && (
            <button className="sow-btn sow-btn--outline" onClick={() => { setIsEditing(false); handleViewDetail(selectedScheme.id) }}>
              Cancel
            </button>
          )}
          {isEditing && isAdmin && (
            <button className="sow-btn sow-btn--outline" onClick={() => setShowTemplatePicker(true)}>
              <Icon name="file-text" size={14} /> Import Template
            </button>
          )}
          {canApproveAction && (
            <>
              <button className="sow-btn sow-btn--success" onClick={() => handleApprove(selectedScheme.id)}>
                <Icon name="circle-check" size={14} /> Approve
              </button>
              <button className="sow-btn sow-btn--danger" onClick={() => setShowReturnForm(true)}>Return</button>
            </>
          )}
        </div>

        {showReturnForm && (
          <div className="sow-return-form">
            <textarea className="sow-textarea" placeholder="Reason for return (required)" rows={3} value={returnNote} onChange={e => setReturnNote(e.target.value)} />
            <div className="sow-return-actions">
              <button className="sow-btn sow-btn--secondary" onClick={() => { setShowReturnForm(false); setReturnNote('') }}>Cancel</button>
              <button className="sow-btn sow-btn--danger" onClick={() => handleReturn(selectedScheme.id)} disabled={!returnNote.trim()}>Confirm Return</button>
            </div>
          </div>
        )}

        {showTemplatePicker && (
          <div className="sow-modal-overlay" onClick={() => setShowTemplatePicker(false)}>
            <div className="sow-modal" onClick={e => e.stopPropagation()}>
              <h3 className="sow-modal-title">Import Curriculum Template</h3>
              <p className="sow-modal-note">Select board, subject, level, and term to find a template.</p>
              <div className="sow-modal-fields">
                <div className="sow-field">
                  <label className="sow-label">Curriculum Board</label>
                  <select className="sow-select" value={templateBoard} onChange={e => { setTemplateBoard(e.target.value); setTemplateSubject(''); setTemplateLevel(''); setTemplateTerm('') }}>
                    <option value="">Select board...</option>
                    {[...new Set(curriculumMeta.map(m => m.board_name))].map(b => (
                      <option key={b} value={b}>{b}</option>
                    ))}
                  </select>
                </div>
                {templateBoard && (
                  <div className="sow-field">
                    <label className="sow-label">Subject</label>
                    <select className="sow-select" value={templateSubject} onChange={e => { setTemplateSubject(e.target.value); setTemplateLevel(''); setTemplateTerm('') }}>
                      <option value="">Select subject...</option>
                      {[...new Set(curriculumMeta.filter(m => m.board_name === templateBoard).map(m => m.subject_name))].map(s => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  </div>
                )}
                {templateBoard && templateSubject && (
                  <div className="sow-field">
                    <label className="sow-label">Class Level</label>
                    <select className="sow-select" value={templateLevel} onChange={e => { setTemplateLevel(e.target.value); setTemplateTerm('') }}>
                      <option value="">Select level...</option>
                      {[...new Set(curriculumMeta.filter(m => m.board_name === templateBoard && m.subject_name === templateSubject).map(m => m.level))].map(l => (
                        <option key={l} value={l}>{l}</option>
                      ))}
                    </select>
                  </div>
                )}
                {templateBoard && templateSubject && templateLevel && (
                  <div className="sow-field">
                    <label className="sow-label">Term</label>
                    <select className="sow-select" value={templateTerm} onChange={e => setTemplateTerm(e.target.value)}>
                      <option value="">Select term...</option>
                      {[...new Set(curriculumMeta.filter(m => m.board_name === templateBoard && m.subject_name === templateSubject && m.level === templateLevel).map(m => m.term))].map(t => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </select>
                  </div>
                )}
                <button className="sow-btn sow-btn--secondary" onClick={loadTemplates} disabled={templateLoading || !templateBoard || !templateLevel || !templateSubject || !templateTerm}>
                  {templateLoading ? 'Searching...' : 'Search Templates'}
                </button>
              </div>
              {templates.length > 0 && (
                <>
                  <div className="sow-modal-results">
                    <p className="sow-modal-count">{templates.length} weeks found for {templateSubject} — {templateLevel}</p>
                    <div className="sow-template-preview">
                      {templates.slice(0, 3).map(t => (
                        <div key={t.id} className="sow-template-mini"><span>W{t.week_number}</span> {t.topic}</div>
                      ))}
                      {templates.length > 3 && <div className="sow-template-more">+{templates.length - 3} more</div>}
                    </div>
                  </div>
                  {selectedScheme.weeks.length > 0 && (
                    <div className="sow-import-warning" style={{ padding: '8px 12px', background: '#fef3cd', border: '1px solid #ffc107', borderRadius: 6, marginBottom: 12, fontSize: 13 }}>
                      <Icon name="alert-triangle" size={14} /> This will replace all {selectedScheme.weeks.length} existing weeks with the template content.
                    </div>
                  )}
                  <button className="sow-btn sow-btn--primary" onClick={handleImportTemplate} disabled={importing}>
                    {importing ? 'Importing...' : `Import ${templates.length} Weeks`}
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    )
  }

  // ─── Create view — Step 1: choose mode ────────────────────────────────────

  if (tab === 'create' && !createMode) {
    return (
      <div className="sow-root">
        <div className="sow-header">
          <button className="sow-back" onClick={() => setTab('list')}><Icon name="chevron-down" size={18} /></button>
          <h2 className="sow-title">New Scheme</h2>
        </div>

        {currentTerm && <div className="sow-term-badge">Current term: {currentTerm.name}</div>}

        <div className="sow-create-mode">
          <p className="sow-create-mode-label">How would you like to create?</p>
          <button className="sow-create-mode-card" onClick={() => setCreateMode('manual')}>
            <Icon name="pencil" size={24} />
            <div>
              <div className="sow-create-mode-title">Create Manually</div>
              <div className="sow-create-mode-desc">Select a class and subject. Weeks auto-generated from timetable.</div>
            </div>
          </button>
          {isAdmin && (
            <button className="sow-create-mode-card" onClick={() => setTab('create-school')}>
              <Icon name="clipboard-list" size={24} />
              <div>
                <div className="sow-create-mode-title">Create Template</div>
                <div className="sow-create-mode-desc">Build a reusable curriculum template. Adopt into any class/subject later from the Templates screen.</div>
              </div>
            </button>
          )}
        </div>
      </div>
    )
  }

  // ─── Create view — Step 2a: manual create ─────────────────────────────────

  if (createMode === 'manual') {
    return (
      <div className="sow-root">
        <div className="sow-header">
          <button className="sow-back" onClick={() => resetCreateState()}><Icon name="chevron-down" size={18} /></button>
          <h2 className="sow-title">New Scheme</h2>
        </div>

        {currentTerm && <div className="sow-term-badge">Current term: {currentTerm.name}</div>}

        <div className="sow-create">
          <div className="sow-field">
            <label className="sow-label">Class</label>
            <select className="sow-select" value={selectedClass} onChange={e => handleClassChange(e.target.value)}>
              <option value="">Select class...</option>
              {uniqueClasses.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>

          {selectedClass && (
            <div className="sow-field">
              <label className="sow-label">Subject</label>
              <select className="sow-select" value={selectedSubject} onChange={e => handleSubjectChange(e.target.value)}>
                <option value="">Select subject...</option>
                {subjectsForClass.map(s => <option key={s.id} value={s.subjectName}>{s.subjectName}</option>)}
              </select>
            </div>
          )}

          {slotsLoading && <div className="sow-loading">Loading timetable slots...</div>}

          {generatedWeeks.length > 0 && (
            <div className="sow-generated-info">
              <Icon name="calendar" size={14} />
              <span>{weeks.length} weeks auto-generated from timetable ({generatedWeeks[0]?.period_label || 'multiple periods'})</span>
            </div>
          )}

          {weeks.length > 0 && (
            <div className="sow-weeks">
              {weeks.map((week, idx) => (
                <div key={idx} className="sow-week sow-week--edit">
                  <div className="sow-week-header">
                    <div className="sow-week-left">
                      <span className="sow-week-num">W{week.week_number}</span>
                      {week.week_start_date && (
                        <span className="sow-week-dates">{formatDate(week.week_start_date)} – {formatDate(week.week_end_date ?? '')}</span>
                      )}
                    </div>
                    <div className="sow-week-right">
                      {week.period_label && <span className="sow-week-period">{week.period_label}</span>}
                    </div>
                  </div>
                  <div className="sow-week-body">
                    <input className="sow-input" placeholder="Topic" value={week.topic} onChange={e => updateWeek(idx, 'topic', e.target.value)} />
                    <textarea className="sow-textarea" placeholder="Objectives" rows={2} value={week.objectives ?? ''} onChange={e => updateWeek(idx, 'objectives', e.target.value)} />
                    <textarea className="sow-textarea" placeholder="Activities" rows={2} value={week.activities ?? ''} onChange={e => updateWeek(idx, 'activities', e.target.value)} />
                    <input className="sow-input" placeholder="Resources" value={week.resources ?? ''} onChange={e => updateWeek(idx, 'resources', e.target.value)} />
                  </div>
                </div>
              ))}
            </div>
          )}

          {weeks.length === 0 && !slotsLoading && selectedAssignmentId && (
            <div className="sow-empty"><p className="sow-empty-msg">No timetable slots found for this assignment.</p></div>
          )}

          {saveError && <div className="sow-error">{saveError}</div>}

          <div className="sow-footer">
            <button className="sow-btn sow-btn--primary" onClick={async () => { const s = await handleSave(); if (s) setTab('list') }} disabled={saving || weeks.length === 0 || !selectedAssignmentId}>
              {saving ? 'Saving...' : 'Save Scheme'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ─── Templates screen (tab === 'templates') ────────────────────────────────

  if (tab === 'templates') {
    return (
      <div className="sow-root">
        <div className="sow-header">
          <button className="sow-back" onClick={() => setTab('list')}><Icon name="chevron-down" size={18} /></button>
          <h2 className="sow-title">Templates</h2>
        </div>

        <div className="sow-tabs">
          <button className={`sow-tab ${templateTab === 'board' ? 'sow-tab--active' : ''}`} onClick={() => setTemplateTab('board')}>
            Board Templates
          </button>
          <button className={`sow-tab ${templateTab === 'school' ? 'sow-tab--active' : ''}`} onClick={() => setTemplateTab('school')}>
            My School's Templates
          </button>
        </div>

        {templateTab === 'board' && (
          <>
            {boardTemplateSetsLoading ? (
              <div className="sow-loading">Loading board templates...</div>
            ) : boardTemplateSets.length === 0 ? (
              <div className="sow-empty">
                <Icon name="clipboard-list" size={48} />
                <p className="sow-empty-msg">No board templates available.</p>
              </div>
            ) : (
              <div className="sow-list">
                {boardTemplateSets.map(ts => (
                  <div key={`${ts.board_name}-${ts.subject_name}-${ts.level}-${ts.term}`} className="sow-card">
                    <div className="sow-card-left">
                      <div className="sow-card-icon"><Icon name="file-text" size={20} /></div>
                      <div className="sow-card-info">
                        <div className="sow-card-title">{ts.board_name} — {ts.subject_name}</div>
                        <div className="sow-card-meta">{ts.level} · {ts.term} · {ts.week_count} weeks</div>
                      </div>
                    </div>
                    <div className="sow-card-right">
                      <button className="sow-btn sow-btn--xs sow-btn--primary" onClick={() => handleAdoptBoardSet(ts)}>
                        Adopt
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {boardAdoptStep === 'adopt' && selectedBoardSet && (
              <div className="sow-modal-overlay" onClick={() => { setBoardAdoptStep('browse'); setSelectedBoardSet(null); setTemplates([]) }}>
                <div className="sow-modal" onClick={e => e.stopPropagation()}>
                  <h3 className="sow-modal-title">Adopt {selectedBoardSet.board_name} Template</h3>
                  <p className="sow-modal-note">Preview the template content, then select a class/subject in your school to adopt it into.</p>

                  {templates.length > 0 && (
                    <div className="sow-modal-results" style={{ marginBottom: 16 }}>
                      <p className="sow-modal-count">{templates.length} weeks — {selectedBoardSet.subject_name} ({selectedBoardSet.level})</p>
                      <div className="sow-template-preview">
                        {templates.slice(0, 3).map(t => (
                          <div key={t.id} className="sow-template-mini"><span>W{t.week_number}</span> {t.topic}</div>
                        ))}
                        {templates.length > 3 && <div className="sow-template-more">+{templates.length - 3} more</div>}
                      </div>
                      {templates[0]?.is_placeholder && (
                        <div style={{ padding: '6px 10px', background: '#fef3cd', border: '1px solid #ffc107', borderRadius: 6, fontSize: 12, marginTop: 8 }}>
                          <Icon name="alert-triangle" size={12} /> Placeholder content — verify against official board curriculum before use.
                        </div>
                      )}
                    </div>
                  )}

                  <p className="sow-modal-note">Select the class and subject in your school:</p>
                  <div className="sow-modal-fields">
                    <div className="sow-field">
                      <label className="sow-label">School Class</label>
                      <select className="sow-select" value={selectedClass} onChange={e => { handleClassChange(e.target.value); setSelectedSubject('') }}>
                        <option value="">Select class...</option>
                        {uniqueClasses.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </div>
                    {selectedClass && (
                      <div className="sow-field">
                        <label className="sow-label">School Subject</label>
                        <select className="sow-select" value={selectedSubject} onChange={e => { setSelectedSubject(e.target.value); const m = activeAssignments.find(a => a.className === selectedClass && a.subjectName === e.target.value); setSelectedAssignmentId(m?.id ?? null) }}>
                          <option value="">Select subject...</option>
                          {subjectsForClass.map(s => <option key={s.id} value={s.subjectName}>{s.subjectName}</option>)}
                        </select>
                      </div>
                    )}
                    <button className="sow-btn sow-btn--primary" onClick={handleImportTemplateNew} disabled={importing || !selectedAssignmentId || templates.length === 0}>
                      {importing ? 'Importing...' : `Adopt ${templates.length} Weeks`}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        {templateTab === 'school' && (
          <>
            {schoolTemplatesLoading ? (
              <div className="sow-loading">Loading school templates...</div>
            ) : schoolTemplates.length === 0 ? (
              <div className="sow-empty">
                <Icon name="clipboard-list" size={48} />
                <p className="sow-empty-msg">No school templates yet.</p>
                <p className="sow-empty-sub">Create a reusable template from the "Create Template" option in the New Scheme picker.</p>
              </div>
            ) : (
              <div className="sow-list">
                {schoolTemplates.map(tpl => (
                  <div key={tpl.id} className="sow-card">
                    <div className="sow-card-left">
                      <div className="sow-card-icon"><Icon name="clipboard-list" size={20} /></div>
                      <div className="sow-card-info">
                        <div className="sow-card-title">{tpl.name}</div>
                        <div className="sow-card-meta">
                          {[tpl.subject_label, tpl.class_level_label].filter(Boolean).join(' · ') || 'No labels'}
                        </div>
                      </div>
                    </div>
                    <div className="sow-card-right" style={{ display: 'flex', gap: 4 }}>
                      <button className="sow-btn sow-btn--xs sow-btn--primary" onClick={() => handleAdoptSchoolTpl(tpl)}>
                        Adopt
                      </button>
                      <button className="sow-btn sow-btn--xs sow-btn--outline" onClick={() => handleEditSchoolTpl(tpl)}>
                        <Icon name="pencil" size={12} />
                      </button>
                      <button className="sow-btn sow-btn--xs sow-btn--danger" onClick={() => handleDeleteSchoolTpl(tpl.id)}>
                        <Icon name="alert-triangle" size={10} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {selectedSchoolTpl && (
              <div className="sow-modal-overlay" onClick={() => setSelectedSchoolTpl(null)}>
                <div className="sow-modal" onClick={e => e.stopPropagation()}>
                  <h3 className="sow-modal-title">Adopt: {selectedSchoolTpl.name}</h3>
                  <p className="sow-modal-note">{selectedSchoolTpl.weeks.length} weeks — select a class/subject to adopt into.</p>

                  <div className="sow-modal-fields">
                    <div className="sow-field">
                      <label className="sow-label">School Class</label>
                      <select className="sow-select" value={selectedClass} onChange={e => { handleClassChange(e.target.value); setSelectedSubject('') }}>
                        <option value="">Select class...</option>
                        {uniqueClasses.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </div>
                    {selectedClass && (
                      <div className="sow-field">
                        <label className="sow-label">School Subject</label>
                        <select className="sow-select" value={selectedSubject} onChange={e => { setSelectedSubject(e.target.value); const m = activeAssignments.find(a => a.className === selectedClass && a.subjectName === e.target.value); setSelectedAssignmentId(m?.id ?? null) }}>
                          <option value="">Select subject...</option>
                          {subjectsForClass.map(s => <option key={s.id} value={s.subjectName}>{s.subjectName}</option>)}
                        </select>
                      </div>
                    )}
                    <button className="sow-btn sow-btn--primary" onClick={async () => {
                      if (!selectedAssignmentId || !sessionId || !actorRecordId || !selectedSchoolTpl) return
                      const { user } = useAuthStore.getState()
                      if (!user) return
                      setImporting(true); setSaveError(null)
                      const createRes = await createScheme({
                        schoolId, teachingAssignmentId: selectedAssignmentId,
                        sessionId, termId: currentTerm?.id ?? null, userId: user.id,
                      })
                      if (!createRes.ok) { setSaveError(createRes.error); setImporting(false); return }
                      const adoptRes = await adoptSchoolTemplate(createRes.data.id, schoolId, selectedSchoolTpl.id)
                      if (adoptRes.ok) {
                        const detailRes = await loadSchemeDetail(createRes.data.id)
                        if (detailRes.ok) {
                          setSelectedScheme(detailRes.data)
                          setWeeks(detailRes.data.weeks.map(w => ({
                            id: w.id, week_number: w.week_number, topic: w.topic, objectives: w.objectives,
                            activities: w.activities, resources: w.resources,
                            coverage_status: w.coverage_status, coverage_note: w.coverage_note,
                            week_start_date: w.week_start_date, week_end_date: w.week_end_date,
                            lesson_dates: w.lesson_dates, period_label: w.period_label, period_time: w.period_time,
                          })))
                          setTab('detail')
                        }
                        setSelectedSchoolTpl(null)
                      } else {
                        setSaveError(adoptRes.error)
                      }
                      setImporting(false)
                    }} disabled={importing || !selectedAssignmentId}>
                      {importing ? 'Adopting...' : `Adopt ${selectedSchoolTpl.weeks.length} Weeks`}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        {saveError && <div className="sow-error">{saveError}</div>}
      </div>
    )
  }

  // ─── School template creation/editing (tab === 'create-school') ────────────

  if (tab === 'create-school') {
    return (
      <div className="sow-root">
        <div className="sow-header">
          <button className="sow-back" onClick={() => { resetCreateState(); setTab('templates'); loadSchoolTemplatesList() }}>
            <Icon name="chevron-down" size={18} />
          </button>
          <h2 className="sow-title">{editingSchoolTpl ? 'Edit Template' : 'Create Template'}</h2>
        </div>

        <div className="sow-create">
          <div className="sow-create-template-info">
            <Icon name="clipboard-list" size={20} />
            <span>Templates are reusable. Create once, adopt into any class/subject/term later.</span>
          </div>

          <div className="sow-field">
            <label className="sow-label">Template Name *</label>
            <input className="sow-input" placeholder="e.g. JSS1 Mathematics — My Version" value={schoolTplForm.name} onChange={e => setSchoolTplForm(prev => ({ ...prev, name: e.target.value }))} />
          </div>

          <div className="sow-field-row">
            <div className="sow-field">
              <label className="sow-label">Subject (optional label)</label>
              <input className="sow-input" placeholder="e.g. Mathematics" value={schoolTplForm.subjectLabel} onChange={e => setSchoolTplForm(prev => ({ ...prev, subjectLabel: e.target.value }))} />
            </div>
            <div className="sow-field">
              <label className="sow-label">Class Level (optional label)</label>
              <input className="sow-input" placeholder="e.g. JSS1" value={schoolTplForm.classLevelLabel} onChange={e => setSchoolTplForm(prev => ({ ...prev, classLevelLabel: e.target.value }))} />
            </div>
          </div>

          <div className="sow-template-weeks-header">
            <span className="sow-template-weeks-count">{schoolTplWeeks.length} weeks</span>
            <button className="sow-btn sow-btn--xs sow-btn--outline" onClick={addSchoolTplWeek}>
              <Icon name="plus" size={12} /> Add Week
            </button>
          </div>

          {schoolTplWeeks.length > 0 && (
            <div className="sow-weeks">
              {schoolTplWeeks.map((week, idx) => (
                <div key={idx} className="sow-week sow-week--edit">
                  <div className="sow-week-header">
                    <div className="sow-week-left">
                      <span className="sow-week-num">W{week.week_number}</span>
                    </div>
                    <button className="sow-btn sow-btn--xs sow-btn--danger" onClick={() => removeSchoolTplWeek(idx)}>
                      <Icon name="alert-triangle" size={10} />
                    </button>
                  </div>
                  <div className="sow-week-body">
                    <input className="sow-input" placeholder="Topic" value={week.topic} onChange={e => updateSchoolTplWeek(idx, 'topic', e.target.value)} />
                    <textarea className="sow-textarea" placeholder="Objectives" rows={2} value={week.objectives ?? ''} onChange={e => updateSchoolTplWeek(idx, 'objectives', e.target.value)} />
                    <textarea className="sow-textarea" placeholder="Activities" rows={2} value={week.activities ?? ''} onChange={e => updateSchoolTplWeek(idx, 'activities', e.target.value)} />
                    <input className="sow-input" placeholder="Resources" value={week.resources ?? ''} onChange={e => updateSchoolTplWeek(idx, 'resources', e.target.value)} />
                  </div>
                </div>
              ))}
            </div>
          )}

          {schoolTplWeeks.length === 0 && (
            <div className="sow-empty"><p className="sow-empty-msg">No weeks yet. Click "Add Week" to start building your template.</p></div>
          )}

          {saveError && <div className="sow-error">{saveError}</div>}

          <div className="sow-footer">
            <button className="sow-btn sow-btn--primary" onClick={handleSaveSchoolTpl} disabled={savingSchoolTpl || schoolTplWeeks.length === 0 || !schoolTplForm.name.trim()}>
              {savingSchoolTpl ? 'Saving...' : editingSchoolTpl ? 'Update Template' : 'Save Template'}
            </button>
          </div>
        </div>
      </div>
    )
  }
}
