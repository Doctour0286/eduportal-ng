/**
 * SchemeOfWorkModule.tsx
 * Teacher term planning — structured weekly plan per subject/class.
 *
 * Teachers create/edit/submit a scheme of work (weekly breakdown of topics,
 * objectives, activities, resources). Admins review, approve, or return.
 *
 * Teacher view: list of own schemes, create/edit, import from template, submit.
 * Admin view: all schemes filtered by status, approve/return workflow.
 */

import { useState, useEffect, useCallback } from 'react'
import { useAuthStore } from '../stores/authStore'
import { Icon } from '../components/icons'
import { loadCurrentSession } from '../services/timetableService'
import {
  loadMySchemes,
  loadAllSchemes,
  loadSchemeDetail,
  loadCurriculumTemplates,
  createScheme,
  saveSchemeWeeks,
  submitScheme,
  approveScheme,
  returnScheme,
  importFromTemplate,
  type SchemeOfWork,
  type SchemeDetail,
  type SchemeWeek,
  type SchemeStatus,
  type CurriculumTemplate,
} from '../services/schemeOfWorkService'

interface SchemeOfWorkModuleProps {
  schoolId: string
  isAdmin: boolean
}

export default function SchemeOfWorkModule({ schoolId, isAdmin }: SchemeOfWorkModuleProps) {
  const actorRecordId = useAuthStore(s => s.actorRecordId)
  const canManage = useAuthStore(s => s.can('academics.scheme_of_work.manage'))
  const canApprove = useAuthStore(s => s.can('academics.scheme_of_work.approve'))
  const canViewAll = useAuthStore(s => s.can('academics.scheme_of_work.view_all'))

  const [sessionId, setSessionId] = useState<string | null>(null)
  const [tab, setTab] = useState<'list' | 'create' | 'detail'>('list')
  const [statusFilter, setStatusFilter] = useState<SchemeStatus | 'all'>('all')
  const [schemes, setSchemes] = useState<SchemeOfWork[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Detail view
  const [selectedScheme, setSelectedScheme] = useState<SchemeDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  // Create/edit state
  const [selectedAssignmentId, setSelectedAssignmentId] = useState<string | null>(null)
  const [weeks, setWeeks] = useState<Omit<SchemeWeek, 'id' | 'scheme_of_work_id' | 'school_id' | 'created_at' | 'updated_at'>[]>([])
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Template import
  const [showTemplatePicker, setShowTemplatePicker] = useState(false)
  const [templates, setTemplates] = useState<CurriculumTemplate[]>([])
  const [templateSubject, setTemplateSubject] = useState('')
  const [templateLevel, setTemplateLevel] = useState('')
  const [templateTerm, setTemplateTerm] = useState('')
  const [templateLoading, setTemplateLoading] = useState(false)
  const [importing, setImporting] = useState(false)

  // Approval actions
  const [returnNote, setReturnNote] = useState('')
  const [showReturnForm, setShowReturnForm] = useState(false)

  // Load session
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const res = await loadCurrentSession()
      if (!cancelled && res.ok && res.sessionId) setSessionId(res.sessionId)
    })()
    return () => { cancelled = true }
  }, [])

  // Load schemes
  const loadSchemes = useCallback(async () => {
    if (!sessionId) return
    setLoading(true)
    setError(null)

    if (isAdmin || canViewAll) {
      const res = await loadAllSchemes({
        sessionId,
        status: statusFilter === 'all' ? undefined : statusFilter,
      })
      if (res.ok) setSchemes(res.data)
      else setError(res.error)
    } else if (actorRecordId) {
      const res = await loadMySchemes(actorRecordId, sessionId)
      if (res.ok) setSchemes(res.data)
      else setError(res.error)
    }
    setLoading(false)
  }, [sessionId, isAdmin, canViewAll, actorRecordId, statusFilter])

  useEffect(() => { loadSchemes() }, [loadSchemes])

  // Load scheme detail
  const handleViewDetail = useCallback(async (schemeId: string) => {
    setDetailLoading(true)
    const res = await loadSchemeDetail(schemeId)
    if (res.ok) {
      setSelectedScheme(res.data)
      setTab('detail')
    }
    setDetailLoading(false)
  }, [])

  // Initialize weeks for a new scheme
  const handleCreateScheme = useCallback(() => {
    setSelectedScheme(null)
    setSelectedAssignmentId(null)
    setWeeks([])
    setTab('create')
  }, [])

  // Add a blank week
  const addWeek = useCallback(() => {
    setWeeks(prev => [...prev, {
      week_number: prev.length + 1,
      topic: '',
      objectives: null,
      activities: null,
      resources: null,
      coverage_status: 'planned' as const,
      coverage_note: null,
    }])
  }, [])

  // Update a week's field
  const updateWeek = useCallback((index: number, field: string, value: string) => {
    setWeeks(prev => prev.map((w, i) => i === index ? { ...w, [field]: value || null } : w))
  }, [])

  // Remove a week
  const removeWeek = useCallback((index: number) => {
    setWeeks(prev => prev.filter((_, i) => i !== index).map((w, i) => ({ ...w, week_number: i + 1 })))
  }, [])

  // Save scheme (create or update weeks)
  const handleSave = useCallback(async () => {
    if (!sessionId || !schoolId) return
    if (weeks.length === 0) {
      setSaveError('Add at least one week before saving')
      return
    }
    setSaving(true)
    setSaveError(null)

    try {
      if (selectedScheme) {
        // Update existing scheme's weeks
        const res = await saveSchemeWeeks(selectedScheme.id, schoolId, weeks)
        if (!res.ok) { setSaveError(res.error); setSaving(false); return }
      } else {
        // Create new scheme — need assignment selection
        if (!selectedAssignmentId) {
          setSaveError('Select a subject and class first')
          setSaving(false)
          return
        }
        const { actorRecordId: staffId, user } = useAuthStore.getState()
        if (!staffId || !user) {
          setSaveError('Not authenticated')
          setSaving(false)
          return
        }
        const createRes = await createScheme({
          schoolId,
          teachingAssignmentId: selectedAssignmentId,
          sessionId,
          termId: '', // term is optional — can be set later
          userId: user.id,
        })
        if (!createRes.ok) { setSaveError(createRes.error); setSaving(false); return }

        const saveRes = await saveSchemeWeeks(createRes.data.id, schoolId, weeks)
        if (!saveRes.ok) { setSaveError(saveRes.error); setSaving(false); return }
      }

      await loadSchemes()
      setTab('list')
    } catch (err: any) {
      setSaveError(err?.message ?? 'Failed to save')
    }
    setSaving(false)
  }, [sessionId, schoolId, weeks, selectedScheme, selectedAssignmentId, loadSchemes])

  // Submit scheme
  const handleSubmit = useCallback(async (schemeId: string) => {
    const res = await submitScheme(schemeId)
    if (res.ok) {
      await loadSchemes()
      setTab('list')
    }
  }, [loadSchemes])

  // Approve scheme
  const handleApprove = useCallback(async (schemeId: string) => {
    if (!actorRecordId) return
    const res = await approveScheme(schemeId, actorRecordId)
    if (res.ok) {
      await loadSchemes()
      setTab('list')
    }
  }, [actorRecordId, loadSchemes])

  // Return scheme
  const handleReturn = useCallback(async (schemeId: string) => {
    if (!actorRecordId || !returnNote.trim()) return
    const res = await returnScheme(schemeId, actorRecordId, returnNote.trim())
    if (res.ok) {
      await loadSchemes()
      setTab('list')
      setShowReturnForm(false)
      setReturnNote('')
    }
  }, [actorRecordId, returnNote, loadSchemes])

  // Load templates
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

  // Import from template
  const handleImportTemplate = useCallback(async (template: CurriculumTemplate) => {
    if (!selectedScheme) return
    setImporting(true)
    const res = await importFromTemplate(selectedScheme.id, schoolId, {
      subject_name: template.subject_name,
      level: template.level,
      term: template.term,
      board_name: template.board_name,
    })
    if (res.ok) {
      // Reload the scheme detail
      const detailRes = await loadSchemeDetail(selectedScheme.id)
      if (detailRes.ok) setSelectedScheme(detailRes.data)
      setShowTemplatePicker(false)
    }
    setImporting(false)
  }, [selectedScheme, schoolId])

  // Status badge
  const statusBadge = (status: SchemeStatus) => {
    const cls = status === 'approved' ? 'sow-badge--approved'
      : status === 'submitted' ? 'sow-badge--submitted'
      : status === 'returned' ? 'sow-badge--returned'
      : 'sow-badge--draft'
    return <span className={`sow-badge ${cls}`}>{status}</span>
  }

  // ─── List view ────────────────────────────────────────────────────────────

  if (tab === 'list') {
    return (
      <div className="sow-module">
        <div className="sow-header">
          <h2>Scheme of Work</h2>
          {(isAdmin || canManage) && (
            <button className="sow-btn sow-btn--primary" onClick={handleCreateScheme}>
              <Icon name="plus" size={16} /> New Scheme
            </button>
          )}
        </div>

        {(isAdmin || canViewAll) && (
          <div className="sow-filters">
            {(['all', 'draft', 'submitted', 'approved', 'returned'] as const).map(s => (
              <button
                key={s}
                className={`sow-pill ${statusFilter === s ? 'sow-pill--active' : ''}`}
                onClick={() => setStatusFilter(s)}
              >
                {s === 'all' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
        )}

        {loading && <div className="sow-loading">Loading schemes...</div>}
        {error && <div className="sow-error">{error}</div>}

        {!loading && schemes.length === 0 && (
          <div className="sow-empty">
            <Icon name="clipboard-list" size={48} />
            <p>No schemes found</p>
            <p className="sow-empty-sub">
              {(isAdmin || canManage) ? 'Create a new scheme to get started.' : 'No schemes assigned to you yet.'}
            </p>
          </div>
        )}

        {!loading && schemes.length > 0 && (
          <div className="sow-list">
            {schemes.map(scheme => (
              <div
                key={scheme.id}
                className="sow-card"
                onClick={() => handleViewDetail(scheme.id)}
              >
                <div className="sow-card-header">
                  <div className="sow-card-subject">
                    {scheme.subject_name ?? 'Unknown Subject'}
                  </div>
                  {statusBadge(scheme.status)}
                </div>
                <div className="sow-card-class">{scheme.class_name ?? 'Unknown Class'}</div>
                {isAdmin && scheme.teacher_name && (
                  <div className="sow-card-teacher">{scheme.teacher_name}</div>
                )}
                {scheme.review_note && scheme.status === 'returned' && (
                  <div className="sow-card-note">
                    <Icon name="alert-triangle" size={14} /> {scheme.review_note}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {detailLoading && <div className="sow-loading">Loading scheme...</div>}
      </div>
    )
  }

  // ─── Detail view ──────────────────────────────────────────────────────────

  if (tab === 'detail' && selectedScheme) {
    const canEdit = selectedScheme.status === 'draft' || selectedScheme.status === 'returned'
    const canSubmit = canEdit && (isAdmin || canManage)
    const canApproveAction = selectedScheme.status === 'submitted' && (isAdmin || canApprove)

    return (
      <div className="sow-module">
        <div className="sow-header">
          <button className="sow-back" onClick={() => { setTab('list'); setSelectedScheme(null) }}>
            <Icon name="chevron-down" size={18} /> Back
          </button>
          <h2>{selectedScheme.subject_name} — {selectedScheme.class_name}</h2>
          {statusBadge(selectedScheme.status)}
        </div>

        {selectedScheme.teacher_name && (
          <div className="sow-detail-teacher">Teacher: {selectedScheme.teacher_name}</div>
        )}

        {selectedScheme.status === 'returned' && selectedScheme.review_note && (
          <div className="sow-return-note">
            <Icon name="alert-triangle" size={16} /> Returned: {selectedScheme.review_note}
          </div>
        )}

        <div className="sow-weeks-header">
          <h3>Weekly Plan ({selectedScheme.weeks.length} weeks)</h3>
          {canEdit && (
            <div className="sow-weeks-actions">
              <button className="sow-btn sow-btn--secondary" onClick={() => setShowTemplatePicker(true)}>
                <Icon name="file-text" size={14} /> Import Template
              </button>
              <button className="sow-btn sow-btn--secondary" onClick={() => addWeek()}>
                <Icon name="plus" size={14} /> Add Week
              </button>
            </div>
          )}
        </div>

        {selectedScheme.weeks.length === 0 && canEdit && (
          <div className="sow-empty-weeks">
            <p>No weeks yet. Add weeks manually or import from a curriculum template.</p>
          </div>
        )}

        <div className="sow-weeks-list">
          {selectedScheme.weeks.map((week, idx) => (
            <div key={week.id} className="sow-week-card">
              <div className="sow-week-header">
                <span className="sow-week-num">Week {week.week_number}</span>
                <span className={`sow-coverage sow-coverage--${week.coverage_status}`}>
                  {week.coverage_status.replace('_', ' ')}
                </span>
              </div>
              {canEdit ? (
                <div className="sow-week-edit">
                  <input
                    className="sow-input"
                    placeholder="Topic"
                    value={week.topic}
                    onChange={e => {
                      const val = e.target.value
                      setWeeks(prev => prev.map((w, i) => i === idx ? { ...w, topic: val } : w))
                      setSelectedScheme(prev => prev ? {
                        ...prev,
                        weeks: prev.weeks.map((w, i) => i === idx ? { ...w, topic: val } : w),
                      } : null)
                    }}
                  />
                  <textarea
                    className="sow-textarea"
                    placeholder="Objectives"
                    rows={2}
                    value={week.objectives ?? ''}
                    onChange={e => {
                      const val = e.target.value || null
                      setWeeks(prev => prev.map((w, i) => i === idx ? { ...w, objectives: val } : w))
                      setSelectedScheme(prev => prev ? {
                        ...prev,
                        weeks: prev.weeks.map((w, i) => i === idx ? { ...w, objectives: val } : w),
                      } : null)
                    }}
                  />
                  <textarea
                    className="sow-textarea"
                    placeholder="Activities"
                    rows={2}
                    value={week.activities ?? ''}
                    onChange={e => {
                      const val = e.target.value || null
                      setWeeks(prev => prev.map((w, i) => i === idx ? { ...w, activities: val } : w))
                      setSelectedScheme(prev => prev ? {
                        ...prev,
                        weeks: prev.weeks.map((w, i) => i === idx ? { ...w, activities: val } : w),
                      } : null)
                    }}
                  />
                  <input
                    className="sow-input"
                    placeholder="Resources"
                    value={week.resources ?? ''}
                    onChange={e => {
                      const val = e.target.value || null
                      setWeeks(prev => prev.map((w, i) => i === idx ? { ...w, resources: val } : w))
                      setSelectedScheme(prev => prev ? {
                        ...prev,
                        weeks: prev.weeks.map((w, i) => i === idx ? { ...w, resources: val } : w),
                      } : null)
                    }}
                  />
                  <button className="sow-remove-week" onClick={() => {
                    setWeeks(prev => prev.filter((_, i) => i !== idx).map((w, i) => ({ ...w, week_number: i + 1 })))
                    setSelectedScheme(prev => prev ? {
                      ...prev,
                      weeks: prev.weeks.filter((_, i) => i !== idx).map((w, i) => ({ ...w, week_number: i + 1 })),
                    } : null)
                  }}>
                    <Icon name="alert-triangle" size={14} /> Remove
                  </button>
                </div>
              ) : (
                <div className="sow-week-view">
                  <div className="sow-week-topic">{week.topic}</div>
                  {week.objectives && <div className="sow-week-detail"><strong>Objectives:</strong> {week.objectives}</div>}
                  {week.activities && <div className="sow-week-detail"><strong>Activities:</strong> {week.activities}</div>}
                  {week.resources && <div className="sow-week-detail"><strong>Resources:</strong> {week.resources}</div>}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Action buttons */}
        <div className="sow-actions">
          {canEdit && canSubmit && (
            <button
              className="sow-btn sow-btn--primary"
              onClick={() => handleSave().then(() => handleSubmit(selectedScheme.id))}
              disabled={saving || weeks.length === 0}
            >
              {saving ? 'Saving...' : 'Save & Submit'}
            </button>
          )}
          {canEdit && !canSubmit && (
            <button
              className="sow-btn sow-btn--primary"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? 'Saving...' : 'Save Draft'}
            </button>
          )}
          {canApproveAction && (
            <>
              <button
                className="sow-btn sow-btn--success"
                onClick={() => handleApprove(selectedScheme.id)}
              >
                <Icon name="circle-check" size={14} /> Approve
              </button>
              <button
                className="sow-btn sow-btn--warning"
                onClick={() => setShowReturnForm(true)}
              >
                Return
              </button>
            </>
          )}
        </div>

        {showReturnForm && (
          <div className="sow-return-form">
            <textarea
              className="sow-textarea"
              placeholder="Reason for return (required)"
              rows={3}
              value={returnNote}
              onChange={e => setReturnNote(e.target.value)}
            />
            <div className="sow-return-form-actions">
              <button className="sow-btn sow-btn--secondary" onClick={() => { setShowReturnForm(false); setReturnNote('') }}>
                Cancel
              </button>
              <button
                className="sow-btn sow-btn--warning"
                onClick={() => handleReturn(selectedScheme.id)}
                disabled={!returnNote.trim()}
              >
                Confirm Return
              </button>
            </div>
          </div>
        )}

        {/* Template picker modal */}
        {showTemplatePicker && (
          <div className="sow-modal-overlay" onClick={() => setShowTemplatePicker(false)}>
            <div className="sow-modal" onClick={e => e.stopPropagation()}>
              <h3>Import from Curriculum Template</h3>
              <p className="sow-modal-note">Placeholder content, clearly labeled as such. Not official board curriculum.</p>
              <div className="sow-template-filters">
                <input className="sow-input" placeholder="Subject (e.g. Mathematics)" value={templateSubject} onChange={e => setTemplateSubject(e.target.value)} />
                <input className="sow-input" placeholder="Level (e.g. JSS1)" value={templateLevel} onChange={e => setTemplateLevel(e.target.value)} />
                <input className="sow-input" placeholder="Term (e.g. First Term)" value={templateTerm} onChange={e => setTemplateTerm(e.target.value)} />
                <button className="sow-btn sow-btn--secondary" onClick={loadTemplates} disabled={templateLoading}>
                  {templateLoading ? 'Loading...' : 'Search'}
                </button>
              </div>
              {templates.length > 0 && (
                <div className="sow-template-list">
                  {templates.map(t => (
                    <div key={t.id} className="sow-template-card" onClick={() => handleImportTemplate(t)}>
                      <div className="sow-template-board">{t.board_name}</div>
                      <div className="sow-template-subject">{t.subject_name} — {t.level}</div>
                      <div className="sow-template-week">Week {t.week_number}: {t.topic}</div>
                      {t.objectives && <div className="sow-template-detail">{t.objectives}</div>}
                    </div>
                  ))}
                  <button
                    className="sow-btn sow-btn--primary"
                    onClick={() => {
                      if (templates.length > 0) {
                        handleImportTemplate(templates[0])
                      }
                    }}
                    disabled={importing}
                  >
                    {importing ? 'Importing...' : `Import All ${templates.length} Weeks`}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    )
  }

  // ─── Create view ──────────────────────────────────────────────────────────

  return (
    <div className="sow-module">
      <div className="sow-header">
        <button className="sow-back" onClick={() => setTab('list')}>
          <Icon name="chevron-down" size={18} /> Back
        </button>
        <h2>New Scheme of Work</h2>
      </div>

      <div className="sow-create-form">
        <div className="sow-form-group">
          <label>Teaching Assignment</label>
          <select
            className="sow-select"
            value={selectedAssignmentId ?? ''}
            onChange={e => setSelectedAssignmentId(e.target.value || null)}
          >
            <option value="">Select a subject/class...</option>
            {/* Assignment options loaded from teaching_assignments — simplified for first launch */}
          </select>
        </div>

        <div className="sow-form-group">
          <label>Weeks ({weeks.length})</label>
          {weeks.length === 0 ? (
            <div className="sow-empty-weeks">
              <p>No weeks yet. Add weeks manually or import from a template.</p>
            </div>
          ) : (
            <div className="sow-weeks-list">
              {weeks.map((week, idx) => (
                <div key={idx} className="sow-week-card">
                  <div className="sow-week-header">
                    <span className="sow-week-num">Week {week.week_number}</span>
                    <button className="sow-remove-week" onClick={() => removeWeek(idx)}>
                      <Icon name="alert-triangle" size={14} />
                    </button>
                  </div>
                  <div className="sow-week-edit">
                    <input
                      className="sow-input"
                      placeholder="Topic"
                      value={week.topic}
                      onChange={e => updateWeek(idx, 'topic', e.target.value)}
                    />
                    <textarea
                      className="sow-textarea"
                      placeholder="Objectives"
                      rows={2}
                      value={week.objectives ?? ''}
                      onChange={e => updateWeek(idx, 'objectives', e.target.value)}
                    />
                    <textarea
                      className="sow-textarea"
                      placeholder="Activities"
                      rows={2}
                      value={week.activities ?? ''}
                      onChange={e => updateWeek(idx, 'activities', e.target.value)}
                    />
                    <input
                      className="sow-input"
                      placeholder="Resources"
                      value={week.resources ?? ''}
                      onChange={e => updateWeek(idx, 'resources', e.target.value)}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
          <button className="sow-btn sow-btn--secondary" onClick={addWeek}>
            <Icon name="plus" size={14} /> Add Week
          </button>
        </div>

        {saveError && <div className="sow-error">{saveError}</div>}

        <div className="sow-actions">
          <button
            className="sow-btn sow-btn--primary"
            onClick={handleSave}
            disabled={saving || weeks.length === 0 || !selectedAssignmentId}
          >
            {saving ? 'Saving...' : 'Save Scheme'}
          </button>
        </div>
      </div>
    </div>
  )
}
