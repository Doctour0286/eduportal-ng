/**
 * GuardianModule.tsx
 * Guardian directory — search, detail sheet, portal access management,
 * link/unlink students. Reached via the More menu.
 *
 * Props: { schoolId, isAdmin, authUserId }. `isAdmin` retained only on the
 * interface (unused in the body, pending App.tsx call-site visibility — same
 * conservative choice as StudentsModule.tsx/FinanceModule.tsx/HRModule.tsx).
 * `authUserId` also unused (pre-existing, not touched this session).
 *
 * Updated (Session 10, PRD Problem 3.1, Goal 5): all real isAdmin write-gates
 * converted to can('<key>') calls, read in-component via useAuthStore (not
 * props) — matching the established Timetable/Students/Finance/HR pattern:
 *   - students.records.edit ("Edit student records (name, class, guardian
 *     info, etc.)") — edit-toggle on the guardian's own info, link/unlink a
 *     student to this guardian. Same key StudentsModule.tsx uses for the
 *     mirror-image guardian-link actions on the student side.
 *   - students.records.manage ("Add and deactivate/transfer students") —
 *     "+ Add" guardian (list header + empty-state), the guardian-record
 *     equivalent of StudentsModule.tsx's "Add student" gate.
 *   - students.portal.manage_access ("Provision, regenerate, and revoke
 *     guardian/student portal login access") — guardian's own login
 *     provisioning/regenerate/deactivate/code-display, and the per-student
 *     access-toggle button.
 *
 * Also this session: the per-student access-toggle button (grant/revoke a
 * linked student's portal access) had NO isAdmin gate at all in the
 * originally uploaded file — unconditionally rendered to any viewer of the
 * guardian detail panel. This is the mirror of StudentsModule.tsx's
 * access-toggle, which *is* gated on students.portal.manage_access there.
 * Flagged and fixed (owner-confirmed) rather than silently left open.
 */

import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { useAuthStore } from '../stores/authStore'
import {
  loadGuardians,
  loadGuardian,
  createGuardian,
  updateGuardian,
  linkGuardianToStudent,
  unlinkGuardianFromStudent,
  deactivateGuardianAccess,
  type Guardian,
  type GuardianDetail,
  type LinkedStudent,
} from '../services/guardianService'
import {
  loadGuardianIdentity,
  provisionGuardianAccess,
  updateGuardianLink,
  type GuardianIdentity,
} from '../services/studentsService'

interface Props {
  schoolId: string
  isAdmin: boolean
  authUserId: string
  /** Passed from App.tsx via TabContent when arriving from a student's
   *  Guardians tab (onNavigate('guardians', { guardianId })). When present,
   *  opens straight into that guardian's detail panel instead of the list. */
  openGuardianId?: string
}

type PanelState = 'list' | 'detail' | 'add'

export default function GuardianModule({ schoolId, isAdmin: _isAdmin, authUserId: _authUserId, openGuardianId }: Props) {
  // ── Permissions (PRD Tier 3 / Session 10) ───────────────────────────────────
  const canEditGuardianRecords = useAuthStore(s => s.can('students.records.edit'))
  const canManageGuardians     = useAuthStore(s => s.can('students.records.manage'))
  const canManagePortalAccess  = useAuthStore(s => s.can('students.portal.manage_access'))

  // ── List state ──────────────────────────────────────────────────────────────
  const [guardians,    setGuardians]    = useState<Guardian[]>([])
  const [listState,    setListState]    = useState<'loading' | 'ready' | 'empty' | 'error'>('loading')
  const [listError,    setListError]    = useState('')
  const [search,       setSearch]       = useState('')
  const searchTimer                     = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // ── Panel state ─────────────────────────────────────────────────────────────
  const [panel,        setPanel]        = useState<PanelState>('list')
  const [selected,     setSelected]     = useState<GuardianDetail | null>(null)
  const [detailState,  setDetailState]  = useState<'loading' | 'ready' | 'error'>('loading')
  const [detailError,  setDetailError]  = useState('')

  // ── Add guardian form ───────────────────────────────────────────────────────
  const [addForm,      setAddForm]      = useState({ full_name: '', phone: '', email: '', relationship: '' })
  const [addError,     setAddError]     = useState('')
  const [addSaving,    setAddSaving]    = useState(false)

  // ── Edit guardian ───────────────────────────────────────────────────────────
  const [editing,      setEditing]      = useState(false)
  const [editForm,     setEditForm]     = useState({ full_name: '', phone: '', email: '', relationship: '' })
  const [editError,    setEditError]    = useState('')
  const [editSaving,   setEditSaving]   = useState(false)

  // ── Link student ────────────────────────────────────────────────────────────
  const [linkSearch,   setLinkSearch]   = useState('')
  const [linkResults,  setLinkResults]  = useState<Array<{ id: string; full_name: string; class_path_label: string | null }>>([])
  const [linkSearching, setLinkSearching] = useState(false)
  const [linkOpen,     setLinkOpen]     = useState(false)
  const [linkSaving,   setLinkSaving]   = useState(false)
  const [linkError,    setLinkError]    = useState('')
  const linkTimer                       = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // ── Unlink confirm ──────────────────────────────────────────────────────────
  const [unlinkTarget, setUnlinkTarget] = useState<LinkedStudent | null>(null)
  const [unlinkSaving, setUnlinkSaving] = useState(false)

  // ── Portal access ───────────────────────────────────────────────────────────
  const [identity,     setIdentity]     = useState<GuardianIdentity | null | undefined>(undefined)
  const [provOpen,     setProvOpen]     = useState(false)
  const [provSaving,   setProvSaving]   = useState(false)
  const [provError,    setProvError]    = useState('')
  const [deactivating, setDeactivating] = useState(false)

  // ── Boot ────────────────────────────────────────────────────────────────────
  // Always load the list — even when arriving with openGuardianId — so the
  // list is ready underneath once the detail panel is later closed (closeDetail
  // sets panel back to 'list', which would otherwise be empty/never-fetched).
  // If openGuardianId is present, additionally jump straight to that
  // guardian's detail panel instead of showing the list first.
  useEffect(() => {
    fetchList('')
    if (openGuardianId) {
      openDetail(openGuardianId)
    }
    // Only re-run if the target guardian actually changes (e.g. tapping a
    // different student's guardian while already inside this module) — not
    // on every render, and not keyed to `search`/other in-module state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openGuardianId])

  // ── List fetch ──────────────────────────────────────────────────────────────
  async function fetchList(q: string) {
    setListState('loading')
    setListError('')
    const res = await loadGuardians({ search: q })
    if (!res.ok) { setListError(res.error); setListState('error'); return }
    setGuardians(res.data)
    setListState(res.data.length === 0 ? 'empty' : 'ready')
  }

  function handleSearchChange(val: string) {
    setSearch(val)
    clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => fetchList(val), 350)
  }

  // ── Open guardian detail ────────────────────────────────────────────────────
  async function openDetail(guardianId: string) {
    setPanel('detail')
    setDetailState('loading')
    setDetailError('')
    setEditing(false)
    setLinkOpen(false)
    setProvOpen(false)
    setIdentity(undefined)

    const res = await loadGuardian(guardianId)
    if (!res.ok) { setDetailError(res.error); setDetailState('error'); return }
    setSelected(res.data)
    setEditForm({
      full_name:    res.data.full_name,
      phone:        res.data.phone ?? '',
      email:        res.data.email ?? '',
      relationship: res.data.relationship ?? '',
    })
    setIdentity(res.data.identity as GuardianIdentity | null)
    setDetailState('ready')
  }

  function closeDetail() {
    setPanel('list')
    setSelected(null)
    setEditing(false)
    setLinkOpen(false)
    setProvOpen(false)
  }

  // ── Edit guardian info ──────────────────────────────────────────────────────
  async function handleEditSave() {
    if (!selected) return
    if (!editForm.full_name.trim()) { setEditError('Name is required'); return }
    setEditSaving(true); setEditError('')
    const res = await updateGuardian(selected.id, {
      full_name:    editForm.full_name,
      phone:        editForm.phone || null,
      email:        editForm.email || null,
      relationship: editForm.relationship || null,
    })
    setEditSaving(false)
    if (!res.ok) { setEditError(res.error); return }
    setEditing(false)
    openDetail(selected.id)
    fetchList(search)
  }

  // ── Link student search ─────────────────────────────────────────────────────
  function handleLinkSearchChange(val: string) {
    setLinkSearch(val)
    clearTimeout(linkTimer.current)
    if (!val.trim()) { setLinkResults([]); return }
    linkTimer.current = setTimeout(() => doLinkSearch(val), 350)
  }

  async function doLinkSearch(q: string) {
    setLinkSearching(true)
    const res = await searchStudentsForLink(q)
    setLinkSearching(false)
    setLinkResults(res)
  }

  async function handleLinkStudent(studentId: string) {
    if (!selected) return
    setLinkSaving(true); setLinkError('')
    const res = await linkGuardianToStudent({
      schoolId,
      guardianId: selected.id,
      studentId,
    })
    setLinkSaving(false)
    if (!res.ok) { setLinkError(res.error); return }
    setLinkOpen(false)
    setLinkSearch('')
    setLinkResults([])
    openDetail(selected.id)
    fetchList(search)
  }

  // ── Unlink student ──────────────────────────────────────────────────────────
  async function handleUnlink() {
    if (!selected || !unlinkTarget) return
    setUnlinkSaving(true)
    const res = await unlinkGuardianFromStudent({
      guardianId: selected.id,
      studentId:  unlinkTarget.student_id,
    })
    setUnlinkSaving(false)
    if (!res.ok) return
    setUnlinkTarget(null)
    openDetail(selected.id)
    fetchList(search)
  }

  // ── Portal access toggle per student ────────────────────────────────────────
  async function handleToggleAccess(student: LinkedStudent) {
    if (!selected) return
    const res = await updateGuardianLink(student.student_id, selected.id, !student.has_platform_access)
    if (!res.ok) return
    openDetail(selected.id)
  }

  // ── Provision ───────────────────────────────────────────────────────────────
  async function handleProvision(regenerate = false) {
    if (!selected) return
    setProvSaving(true); setProvError('')
    const res = await provisionGuardianAccess({
      schoolId,
      guardianId:  selected.id,
      loginMethod: 'login_code',
      regenerate,
    })
    setProvSaving(false)
    if (!res.ok) { setProvError(res.error); return }
    const idRes = await loadGuardianIdentity(schoolId, selected.id)
    if (idRes.ok) setIdentity(idRes.data)
    setProvOpen(false)
  }

  async function handleDeactivate() {
    if (!selected) return
    setDeactivating(true)
    const res = await deactivateGuardianAccess(selected.id)
    setDeactivating(false)
    if (!res.ok) return
    const idRes = await loadGuardianIdentity(schoolId, selected.id)
    if (idRes.ok) setIdentity(idRes.data)
  }

  // ── Add guardian ────────────────────────────────────────────────────────────
  async function handleAddGuardian() {
    if (!addForm.full_name.trim()) { setAddError('Name is required'); return }
    setAddSaving(true); setAddError('')
    const res = await createGuardian({
      schoolId,
      full_name:    addForm.full_name,
      phone:        addForm.phone || null,
      email:        addForm.email || null,
      relationship: addForm.relationship || null,
    })
    setAddSaving(false)
    if (!res.ok) { setAddError(res.error); return }
    setPanel('list')
    setAddForm({ full_name: '', phone: '', email: '', relationship: '' })
    fetchList(search)
    openDetail(res.data.id)
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  if (panel === 'add') return (
    <div className="grd-shell">
      <div className="grd-topbar">
        <button className="grd-back-btn" onClick={() => setPanel('list')}>← Back</button>
        <h2 className="grd-title">New guardian</h2>
      </div>
      <div className="grd-form">
        <div className="grd-field">
          <label className="grd-label">Full name <span className="grd-required">*</span></label>
          <input className="grd-input" type="text" placeholder="e.g. Aisha Musa"
            value={addForm.full_name}
            onChange={e => setAddForm(f => ({ ...f, full_name: e.target.value }))}
            autoFocus />
        </div>
        <div className="grd-field">
          <label className="grd-label">Phone</label>
          <input className="grd-input" type="tel" inputMode="numeric" placeholder="e.g. 08012345678"
            value={addForm.phone}
            onChange={e => setAddForm(f => ({ ...f, phone: e.target.value }))} />
        </div>
        <div className="grd-field">
          <label className="grd-label">Email</label>
          <input className="grd-input" type="email" placeholder="optional"
            value={addForm.email}
            onChange={e => setAddForm(f => ({ ...f, email: e.target.value }))} />
        </div>
        <div className="grd-field">
          <label className="grd-label">Relationship</label>
          <select className="grd-select" value={addForm.relationship}
            onChange={e => setAddForm(f => ({ ...f, relationship: e.target.value }))}>
            <option value="">— not specified —</option>
            <option value="Mother">Mother</option>
            <option value="Father">Father</option>
            <option value="Guardian">Guardian</option>
            <option value="Sibling">Sibling</option>
            <option value="Other">Other</option>
          </select>
        </div>
        {addError && <p className="grd-error" role="alert">{addError}</p>}
        <button className="grd-btn-primary" onClick={handleAddGuardian} disabled={addSaving}>
          {addSaving ? 'Saving…' : 'Create guardian'}
        </button>
      </div>
    </div>
  )

  if (panel === 'detail') return (
    <div className="grd-shell">
      <div className="grd-topbar">
        <button className="grd-back-btn" onClick={closeDetail}>← Guardians</button>
        {canEditGuardianRecords && !editing && (
          <button className="grd-edit-btn" onClick={() => setEditing(true)}>Edit</button>
        )}
      </div>

      {detailState === 'loading' && (
        <div className="grd-detail-skel">
          <div className="grd-skel grd-skel--title" />
          <div className="grd-skel grd-skel--line" />
          <div className="grd-skel grd-skel--line" />
        </div>
      )}

      {detailState === 'error' && (
        <div className="grd-error-state">
          <p>{detailError}</p>
          <button className="grd-retry-btn" onClick={() => selected && openDetail(selected.id)}>Retry</button>
        </div>
      )}

      {detailState === 'ready' && selected && (
        <div className="grd-detail">

          {/* Info section */}
          {editing ? (
            <div className="grd-section">
              <div className="grd-field">
                <label className="grd-label">Full name <span className="grd-required">*</span></label>
                <input className="grd-input" type="text" value={editForm.full_name}
                  onChange={e => setEditForm(f => ({ ...f, full_name: e.target.value }))} autoFocus />
              </div>
              <div className="grd-field">
                <label className="grd-label">Phone</label>
                <input className="grd-input" type="tel" inputMode="numeric" value={editForm.phone}
                  onChange={e => setEditForm(f => ({ ...f, phone: e.target.value }))} />
              </div>
              <div className="grd-field">
                <label className="grd-label">Email</label>
                <input className="grd-input" type="email" value={editForm.email}
                  onChange={e => setEditForm(f => ({ ...f, email: e.target.value }))} />
              </div>
              <div className="grd-field">
                <label className="grd-label">Relationship</label>
                <select className="grd-select" value={editForm.relationship}
                  onChange={e => setEditForm(f => ({ ...f, relationship: e.target.value }))}>
                  <option value="">— not specified —</option>
                  <option value="Mother">Mother</option>
                  <option value="Father">Father</option>
                  <option value="Guardian">Guardian</option>
                  <option value="Sibling">Sibling</option>
                  <option value="Other">Other</option>
                </select>
              </div>
              {editError && <p className="grd-error" role="alert">{editError}</p>}
              <div className="grd-row-actions">
                <button className="grd-btn-ghost" onClick={() => setEditing(false)} disabled={editSaving}>Cancel</button>
                <button className="grd-btn-primary" onClick={handleEditSave} disabled={editSaving}>
                  {editSaving ? 'Saving…' : 'Save changes'}
                </button>
              </div>
            </div>
          ) : (
            <div className="grd-section">
              <h2 className="grd-guardian-name">{selected.full_name}</h2>
              {selected.relationship && <p className="grd-meta">{selected.relationship}</p>}
              {selected.phone && <p className="grd-meta">📞 {selected.phone}</p>}
              {selected.email && <p className="grd-meta">✉️ {selected.email}</p>}
            </div>
          )}

          {/* Portal access section */}
          <div className="grd-section">
            <h3 className="grd-section-title">Portal access</h3>

            {identity === undefined && <p className="grd-meta">Loading…</p>}

            {identity === null && !provOpen && (
              <div className="grd-access-row">
                <span className="grd-access-none">No login set up</span>
                {canManagePortalAccess && (
                  <button className="grd-access-setup-btn" onClick={() => { setProvOpen(true); setProvError('') }}>
                    Set up login →
                  </button>
                )}
              </div>
            )}

            {identity && !identity.is_active && !provOpen && (
              <div className="grd-access-row">
                <span className="grd-access-badge grd-access-badge--off">Deactivated</span>
                {canManagePortalAccess && (
                  <button className="grd-access-setup-btn" onClick={() => { setProvOpen(true); setProvError('') }}>
                    Re-provision →
                  </button>
                )}
              </div>
            )}

            {identity && identity.is_active && !provOpen && (
              <div className="grd-access-active">
                <span className="grd-access-badge grd-access-badge--on">🔑 Login code</span>
                {/* Per owner request: no more "Show code" click-to-reveal. The
                   code is already on `identity` from openDetail()'s loadGuardian
                   call — display it directly if the signed-in actor is allowed
                   to see it (students.portal.manage_access), rather than gating
                   it behind an extra tap. If the backend genuinely never
                   returns login_code on this endpoint, that's a real gap to
                   flag to the person, not something to paper over with a
                   button that quietly does nothing. */}
                {canManagePortalAccess && identity.login_code && (
                  <span className="grd-code-display">{identity.login_code}</span>
                )}
                {canManagePortalAccess && !identity.login_code && (
                  <span className="grd-code-unavailable">Code not available — try Change / regenerate</span>
                )}
                {canManagePortalAccess && (
                  <div className="grd-access-admin-actions">
                    <button className="grd-access-minor-btn" onClick={() => { setProvOpen(true); setProvError('') }}>
                      Change / regenerate
                    </button>
                    <button className="grd-access-danger-btn" onClick={handleDeactivate} disabled={deactivating}>
                      {deactivating ? 'Deactivating…' : 'Deactivate'}
                    </button>
                  </div>
                )}
              </div>
            )}

            {provOpen && (
              <div className="grd-prov-form">
                <p className="grd-prov-hint">
                  {identity ? 'A new login code will be generated and the old one will stop working.'
                            : 'A unique login code will be generated. Give it to the guardian to sign in.'}
                </p>
                {provError && <p className="grd-error" role="alert">{provError}</p>}
                <div className="grd-row-actions">
                  <button className="grd-btn-ghost" onClick={() => setProvOpen(false)} disabled={provSaving}>Cancel</button>
                  <button className="grd-btn-primary" onClick={() => handleProvision(!!identity)} disabled={provSaving}>
                    {provSaving ? 'Setting up…' : identity ? 'Regenerate code' : 'Generate code'}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Linked students section */}
          <div className="grd-section">
            <div className="grd-section-header">
              <h3 className="grd-section-title">Linked students ({selected.linked_students.length})</h3>
              {canEditGuardianRecords && (
                <button className="grd-link-btn" onClick={() => { setLinkOpen(o => !o); setLinkSearch(''); setLinkResults([]); setLinkError('') }}>
                  {linkOpen ? 'Cancel' : '+ Link student'}
                </button>
              )}
            </div>

            {linkOpen && (
              <div className="grd-link-search">
                <input className="grd-input" type="text" placeholder="Search student by name…"
                  value={linkSearch} onChange={e => handleLinkSearchChange(e.target.value)}
                  autoFocus />
                {linkSearching && <p className="grd-meta">Searching…</p>}
                {linkError && <p className="grd-error">{linkError}</p>}
                {linkResults.length > 0 && (
                  <ul className="grd-link-results">
                    {linkResults.map(s => (
                      <li key={s.id} className="grd-link-result-row">
                        <span className="grd-link-result-name">{s.full_name}</span>
                        {s.class_path_label && <span className="grd-link-result-class">{s.class_path_label}</span>}
                        <button className="grd-link-result-btn" onClick={() => handleLinkStudent(s.id)} disabled={linkSaving}>
                          {linkSaving ? '…' : 'Link'}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {!linkSearching && linkSearch.trim() && linkResults.length === 0 && (
                  <p className="grd-meta">No students found for "{linkSearch}"</p>
                )}
              </div>
            )}

            {unlinkTarget && (
              <div className="grd-confirm-banner">
                <p className="grd-confirm-text">Unlink {unlinkTarget.full_name}? Portal access for this student will also be removed.</p>
                <div className="grd-confirm-actions">
                  <button className="grd-btn-ghost" onClick={() => setUnlinkTarget(null)} disabled={unlinkSaving}>Keep</button>
                  <button className="grd-btn-danger" onClick={handleUnlink} disabled={unlinkSaving}>
                    {unlinkSaving ? 'Removing…' : 'Unlink'}
                  </button>
                </div>
              </div>
            )}

            {selected.linked_students.length === 0 && (
              <p className="grd-empty-msg">No students linked yet.</p>
            )}

            <ul className="grd-student-list">
              {selected.linked_students.map(s => (
                <li key={s.student_id} className="grd-student-row">
                  <div className="grd-student-info">
                    <span className="grd-student-name">{s.full_name}</span>
                    {s.class_path_label && <span className="grd-student-class">{s.class_path_label}</span>}
                    {/* Session 13 (PRD Problem 5.5) — owner-decided "visible
                        from anywhere" scope: detail header (StudentsModule)
                        + here. Silent when empty, same as the header's own
                        treatment — a nice-to-have display, not a state that
                        needs its own error/loading UI. */}
                    {s.role_tags.length > 0 && (
                      <div className="grd-student-role-tags" aria-label="Student roles">
                        {s.role_tags.map(tag => (
                          <span key={tag.id} className="grd-student-role-tag">{tag.name}</span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="grd-student-actions">
                    {/* Previously unconditionally rendered — no isAdmin gate
                       existed here at all in the originally uploaded file,
                       unlike its mirror-image toggle in StudentsModule.tsx
                       (gated on students.portal.manage_access there). Added
                       this session, owner-confirmed, not a silent fix. */}
                    {canManagePortalAccess && (
                      <button
                        className={`grd-access-toggle${s.has_platform_access ? ' grd-access-toggle--on' : ''}`}
                        onClick={() => handleToggleAccess(s)}
                        title={s.has_platform_access ? 'Remove portal access for this student' : 'Grant portal access for this student'}
                      >
                        {s.has_platform_access ? '🔓 Access on' : '🔒 No access'}
                      </button>
                    )}
                    {canEditGuardianRecords && (
                      <button className="grd-unlink-btn" onClick={() => setUnlinkTarget(s)} title="Unlink student">✕</button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>

        </div>
      )}
    </div>
  )

  // ── List view ───────────────────────────────────────────────────────────────
  return (
    <div className="grd-shell">
      <div className="grd-topbar">
        <h2 className="grd-title">Guardians</h2>
        {canManageGuardians && (
          <button className="grd-add-btn" onClick={() => { setPanel('add'); setAddForm({ full_name: '', phone: '', email: '', relationship: '' }); setAddError('') }}>
            + Add
          </button>
        )}
      </div>

      <div className="grd-search-bar">
        <input className="grd-search-input" type="search" placeholder="Search by name or phone…"
          value={search} onChange={e => handleSearchChange(e.target.value)} />
      </div>

      {listState === 'loading' && (
        <div className="grd-list-skel">
          {[1,2,3,4].map(i => <div key={i} className="grd-skel grd-skel--row" />)}
        </div>
      )}

      {listState === 'error' && (
        <div className="grd-error-state">
          <p>{listError}</p>
          <button className="grd-retry-btn" onClick={() => fetchList(search)}>Retry</button>
        </div>
      )}

      {listState === 'empty' && (
        <div className="grd-empty-state">
          <span className="grd-empty-icon">👨‍👩‍👧</span>
          <p className="grd-empty-msg">{search ? `No guardians matching "${search}"` : 'No guardians yet.'}</p>
          {canManageGuardians && !search && (
            <button className="grd-btn-primary" onClick={() => setPanel('add')}>Add first guardian</button>
          )}
        </div>
      )}

      {listState === 'ready' && (
        <ul className="grd-list">
          {guardians.map(g => (
            <li key={g.id} className="grd-list-row" onClick={() => openDetail(g.id)} role="button" tabIndex={0}
              onKeyDown={e => e.key === 'Enter' && openDetail(g.id)}>
              <div className="grd-list-avatar">{g.full_name.charAt(0).toUpperCase()}</div>
              <div className="grd-list-info">
                <span className="grd-list-name">{g.full_name}</span>
                <span className="grd-list-meta">
                  {g.phone ?? ''}
                  {g.phone && g.student_count > 0 ? ' · ' : ''}
                  {g.student_count > 0 ? `${g.student_count} student${g.student_count !== 1 ? 's' : ''}` : 'No students linked'}
                </span>
              </div>
              <div className="grd-list-right">
                {g.has_any_access && <span className="grd-access-dot" title="Has portal access" />}
                <span className="grd-list-chevron">›</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ─── Student search helper (used for link-student-to-guardian flow) ───────────

async function searchStudentsForLink(
  query: string,
): Promise<Array<{ id: string; full_name: string; class_path_label: string | null }>> {
  if (!query.trim()) return []
  const { data } = await supabase
    .from('students')
    .select('id, full_name')
    .ilike('full_name', `%${query.trim()}%`)
    .eq('status', 'active')
    .limit(10)

  return (data ?? []).map((s: any) => ({
    id:               s.id,
    full_name:        s.full_name,
    class_path_label: null,
  }))
}
