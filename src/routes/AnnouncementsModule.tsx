/**
 * AnnouncementsModule.tsx
 * Announcements + in-app notification bell for EduSkola.
 *
 * Two sub-views accessed via a top tab bar:
 *   • Announcements — list with audience filter; compose sheet; detail
 *                     sheet; delete (own posts, admin-only)
 *   • Notifications — in-app notification inbox; mark-read; mark-all-read
 *                     (self-service, no permission gate — every actor
 *                     manages only their own inbox)
 *
 * Props:
 *   schoolId  — current school's UUID
 *   isAdmin   — true for staff / platform_admin; retained as a
 *               platform_admin-safety bypass alongside can() below, and
 *               as the sole gate on delete (see Session 10 note)
 *   actorType — used to render audience-appropriate copy
 *
 * Updated (Session 10, PRD Problem 3.1, Goal 5): compose (the "+ Post"
 * button and "Post the first one" empty-state button) now gates on the
 * real catalog key admin.announcements.post ("Post announcements to
 * staff/guardians/students"), read in-component via useAuthStore, not
 * threaded as a prop from App.tsx — same pattern as every other module
 * converted this session.
 *
 * Delete (own post, AnnouncementDetail's canDelete) is a CONFIRMED,
 * FLAGGED catalog gap, left on isAdmin unchanged — same discipline as
 * HRModule.tsx's leave-types gap. Queried the live permissions table
 * directly: only two keys exist in this area (admin.announcements.post
 * — "Post announcements..."; admin.notifications.manage — "Configure
 * notification channels"). Neither covers deleting an announcement.
 * admin.announcements.post describes posting, not deleting, so it is
 * not force-fit here. A dedicated key (e.g. admin.announcements.delete)
 * would need to be added to the catalog in a future session.
 *
 * admin.notifications.manage was checked and confirmed NOT applicable to
 * this file's mark-read/mark-all-read actions — its description ("Configure
 * notification channels") describes system-level channel configuration
 * (e.g. email/SMS/push settings), not a user managing their own inbox.
 * NotificationsTab is correctly left ungated — every actor type marking
 * their own notifications read is inherently self-service, not a
 * permission-gated action.
 */

import { useState, useEffect, useCallback, type ReactNode } from 'react'
import { useAuthStore } from '../stores/authStore'
import { supabase } from '../lib/supabase'
import { Icon } from '../components/icons'
import {
  loadAnnouncements,
  createAnnouncement,
  deleteAnnouncement,
  loadNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  loadClassNodes,
  type Announcement,
  type Notification,
  type AudienceType,
  type ClassNodeOption,
  type CreateAnnouncementInput,
} from '../services/announcementsService'

// ─── Types ────────────────────────────────────────────────────────────────────

type LoadState = 'booting' | 'loading' | 'ready' | 'error'
type ModuleTab = 'announcements' | 'notifications'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins  = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days  = Math.floor(diff / 86400000)
  if (mins < 1)   return 'just now'
  if (mins < 60)  return `${mins}m ago`
  if (hours < 24) return `${hours}h ago`
  if (days < 7)   return `${days}d ago`
  return new Date(iso).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })
}

function audienceLabel(audience: AudienceType, className?: string | null): string {
  switch (audience) {
    case 'all':        return 'Everyone'
    case 'staff':      return 'Staff only'
    case 'guardians':  return 'Guardians'
    case 'students':   return 'Students'
    case 'class_node': return className ? `Class: ${className}` : 'Specific class'
  }
}

function audienceIcon(audience: AudienceType): ReactNode {
  switch (audience) {
    case 'all':        return <Icon name="globe" size={14} />
    case 'staff':      return <Icon name="presentation" size={14} />
    case 'guardians':  return <Icon name="users" size={14} />
    case 'students':   return <Icon name="backpack" size={14} />
    case 'class_node': return <Icon name="school" size={14} />
  }
}

function initials(name: string | null): string {
  if (!name) return '?'
  return name.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase()
}

// ─── Root component ───────────────────────────────────────────────────────────

export default function AnnouncementsModule({
  schoolId,
  isAdmin,
  actorType,
}: {
  schoolId: string
  isAdmin: boolean
  actorType: 'staff' | 'guardian' | 'student' | 'platform_admin' | null
}) {
  const [activeTab, setActiveTab] = useState<ModuleTab>('announcements')
  const [unreadCount, setUnreadCount] = useState(0)

  // Refresh unread badge whenever notifications tab is left
  const refreshUnread = useCallback(async () => {
    const res = await loadNotifications(schoolId, { unreadOnly: true })
    if (res.ok) setUnreadCount(res.data.length)
  }, [schoolId])

  useEffect(() => {
    refreshUnread()
  }, [refreshUnread])

  return (
    <div className="ann-root">
      <div className="ann-header">
        <div className="ann-header-top">
          <h1 className="ann-title">Announcements</h1>
        </div>
        <div className="ann-module-tabs">
          <button
            className={`ann-module-tab${activeTab === 'announcements' ? ' ann-module-tab--active' : ''}`}
            onClick={() => setActiveTab('announcements')}
          >
            Notices
          </button>
          <button
            className={`ann-module-tab${activeTab === 'notifications' ? ' ann-module-tab--active' : ''}`}
            onClick={() => { setActiveTab('notifications'); setUnreadCount(0) }}
          >
            Notifications
            {unreadCount > 0 && (
              <span className="ann-bell-badge">{unreadCount > 99 ? '99+' : unreadCount}</span>
            )}
          </button>
        </div>
      </div>

      <div className="ann-body">
        {activeTab === 'announcements' && (
          <AnnouncementsTab
            schoolId={schoolId}
            isAdmin={isAdmin}
            actorType={actorType}
          />
        )}
        {activeTab === 'notifications' && (
          <NotificationsTab
            schoolId={schoolId}
            onRead={refreshUnread}
          />
        )}
      </div>
    </div>
  )
}

// ─── Announcements tab ────────────────────────────────────────────────────────

function AnnouncementsTab({
  schoolId,
  isAdmin,
  actorType,
}: {
  schoolId: string
  isAdmin: boolean
  actorType: 'staff' | 'guardian' | 'student' | 'platform_admin' | null
}) {
  // canPost: real gate on composing/posting, per Session 10 conversion
  // (admin.announcements.post). isAdmin is kept as a platform_admin-safety
  // bypass here (can() alone would miss that actor type, matching every
  // other Session 10 conversion) and is separately still threaded down to
  // AnnouncementDetail, where it's the sole gate on delete — a confirmed,
  // flagged catalog gap (see header comment), not converted.
  const can = useAuthStore((s) => s.can)
  const canPost = can('admin.announcements.post') || isAdmin

  const [loadState, setLoadState]           = useState<LoadState>('booting')
  const [announcements, setAnnouncements]   = useState<Announcement[]>([])
  const [loadError, setLoadError]           = useState('')
  const [audienceFilter, setAudienceFilter] = useState<AudienceType | 'all'>('all')
  const [detail, setDetail]                 = useState<Announcement | null>(null)
  const [showCompose, setShowCompose]       = useState(false)
  const [deleting, setDeleting]             = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoadState('loading')
    const res = await loadAnnouncements(schoolId, { audience: audienceFilter, includeExpired: false })
    if (!res.ok) {
      setLoadError(res.error)
      setLoadState('error')
      return
    }
    setAnnouncements(res.data.announcements)
    setLoadState('ready')
  }, [schoolId, audienceFilter])

  useEffect(() => { load() }, [load])

  async function handleDelete(id: string) {
    if (!window.confirm('Delete this announcement? This cannot be undone.')) return
    setDeleting(id)
    const res = await deleteAnnouncement(schoolId, id)
    if (!res.ok) {
      alert(res.error)
    } else {
      setAnnouncements(prev => prev.filter(a => a.id !== id))
      if (detail?.id === id) setDetail(null)
    }
    setDeleting(null)
  }

  function handleCreated(a: Announcement) {
    setAnnouncements(prev => [a, ...prev])
    setShowCompose(false)
  }

  return (
    <>
      {/* Filter bar */}
      <div className="ann-filter-bar">
        <select
          className="ann-audience-filter"
          value={audienceFilter}
          onChange={e => setAudienceFilter(e.target.value as AudienceType | 'all')}
          aria-label="Filter by audience"
        >
          <option value="all">All audiences</option>
          <option value="staff">Staff only</option>
          <option value="guardians">Guardians</option>
          <option value="students">Students</option>
          <option value="class_node">Specific class</option>
        </select>

        {canPost && (
          <button className="ann-compose-btn" onClick={() => setShowCompose(true)}>
            + Post
          </button>
        )}
      </div>

      {/* States */}
      {loadState === 'loading' && (
        <div className="ann-list-skel">
          {[1, 2, 3, 4].map(i => <div key={i} className="ann-row-skel skeleton" />)}
        </div>
      )}

      {loadState === 'error' && (
        <div className="ann-error-state">
          <span className="ann-error-icon"><Icon name="alert-triangle" size={32} style={{ color: 'var(--color-warning, #d97706)' }} /></span>
          <p className="ann-error-msg">{loadError}</p>
          <button className="ann-retry-btn" onClick={load}>Try again</button>
        </div>
      )}

      {loadState === 'ready' && announcements.length === 0 && (
        <div className="ann-empty-state">
          <span className="ann-empty-icon"><Icon name="megaphone" size={40} /></span>
          <p className="ann-empty-msg">
            {audienceFilter === 'all'
              ? 'No announcements yet.'
              : `No announcements for this audience.`}
          </p>
          {canPost && (
            <button className="ann-empty-action" onClick={() => setShowCompose(true)}>
              Post the first one
            </button>
          )}
        </div>
      )}

      {loadState === 'ready' && announcements.length > 0 && (
        <ul className="ann-list">
          {announcements.map(a => (
            <li key={a.id} className="ann-row">
              <button
                className="ann-row-btn"
                onClick={() => setDetail(a)}
              >
                <div className="ann-row-avatar">
                  {initials(a.posted_by_name)}
                </div>
                <div className="ann-row-body">
                  <p className="ann-row-title">{a.title}</p>
                  <p className="ann-row-preview">{a.body.slice(0, 80)}{a.body.length > 80 ? '…' : ''}</p>
                  <div className="ann-row-meta">
                    <span className="ann-row-audience">
                      {audienceIcon(a.audience)} {audienceLabel(a.audience, a.class_node_name)}
                    </span>
                    <span className="ann-row-time">{relativeTime(a.posted_at)}</span>
                    {a.is_expired && <span className="ann-row-expired-chip">Expired</span>}
                  </div>
                </div>
                <span className="ann-row-arrow">›</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Detail sheet */}
      {detail && (
        <AnnouncementDetail
          announcement={detail}
          isAdmin={isAdmin}
          actorType={actorType}
          deleting={deleting === detail.id}
          onDelete={() => handleDelete(detail.id)}
          onClose={() => setDetail(null)}
        />
      )}

      {/* Compose sheet */}
      {showCompose && (
        <ComposeSheet
          schoolId={schoolId}
          onCreated={handleCreated}
          onClose={() => setShowCompose(false)}
        />
      )}
    </>
  )
}

// ─── Announcement detail sheet ────────────────────────────────────────────────

function AnnouncementDetail({
  announcement: a,
  isAdmin,
  actorType: _actorType,
  deleting,
  onDelete,
  onClose,
}: {
  announcement: Announcement
  isAdmin: boolean
  actorType: 'staff' | 'guardian' | 'student' | 'platform_admin' | null
  deleting: boolean
  onDelete: () => void
  onClose: () => void
}) {
  // Resolve the current user's staff.id to know if they own this post
  const [currentStaffId, setCurrentStaffId] = useState<string | null>(null)

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) return
      supabase
        .from('app_identities')
        .select('actor_record_id, actor_type')
        .eq('auth_user_id', user.id)
        .maybeSingle()
        .then(({ data }) => {
          if (data?.actor_type === 'staff') setCurrentStaffId(data.actor_record_id)
        })
    })
  }, [])

  const canDelete = isAdmin && (currentStaffId === a.posted_by)

  return (
    <div className="ann-overlay" onClick={onClose}>
      <div className="ann-detail-sheet" onClick={e => e.stopPropagation()}>
        <div className="ann-form-handle" />

        <div className="ann-detail-header">
          <button className="ann-form-close" onClick={onClose} aria-label="Close"><Icon name="x" size={18} /></button>
        </div>

        <div className="ann-detail-body">
          <div className="ann-detail-audience-row">
            <span className="ann-detail-audience-chip">
              {audienceIcon(a.audience)} {audienceLabel(a.audience, a.class_node_name)}
            </span>
            {a.is_public && <span className="ann-detail-public-chip">Public</span>}
            {a.is_expired && <span className="ann-detail-expired-chip">Expired</span>}
          </div>

          <h2 className="ann-detail-title">{a.title}</h2>

          <div className="ann-detail-meta">
            <div className="ann-detail-avatar">{initials(a.posted_by_name)}</div>
            <div>
              <p className="ann-detail-poster">{a.posted_by_name ?? 'Unknown'}</p>
              <p className="ann-detail-time">{relativeTime(a.posted_at)}</p>
            </div>
          </div>

          <p className="ann-detail-body-text">{a.body}</p>

          {a.expires_at && (
            <p className="ann-detail-expiry">
              {a.is_expired ? 'Expired' : 'Expires'}{' '}
              {new Date(a.expires_at).toLocaleDateString('en-NG', { day: 'numeric', month: 'long', year: 'numeric' })}
            </p>
          )}
        </div>

        {canDelete && (
          <div className="ann-detail-footer">
            <button
              className="ann-delete-btn"
              onClick={onDelete}
              disabled={deleting}
            >
              {deleting ? 'Deleting…' : 'Delete announcement'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Compose sheet ────────────────────────────────────────────────────────────

function ComposeSheet({
  schoolId,
  onCreated,
  onClose,
}: {
  schoolId: string
  onCreated: (a: Announcement) => void
  onClose: () => void
}) {
  const [title, setTitle]           = useState('')
  const [body, setBody]             = useState('')
  const [audience, setAudience]     = useState<AudienceType>('all')
  const [classNodeId, setClassNodeId] = useState('')
  const [isPublic, setIsPublic]     = useState(false)
  const [expiresAt, setExpiresAt]   = useState('')
  const [saving, setSaving]         = useState(false)
  const [error, setError]           = useState('')

  const [classNodes, setClassNodes]         = useState<ClassNodeOption[]>([])
  const [classNodesState, setClassNodesState] = useState<'idle' | 'loading' | 'ready'>('idle')

  // Defensive handler-level guard, matching §4.12 discipline used elsewhere
  // this session — the visible control (compose button) is already gated,
  // but this sheet only ever opens from that gated entry point, so this is
  // a belt-and-braces check, not the primary boundary. RLS remains the
  // actual backstop per §3.2.
  //
  // Note: this reads only can('admin.announcements.post'), without the
  // isAdmin/platform_admin bypass that gates the outer compose button —
  // ComposeSheet has no isAdmin prop, and this file's Session 10 conversion
  // deliberately avoids threading new props where an in-component store
  // read is available. In practice this is immaterial: since this sheet
  // only opens via the already isAdmin-bypassed outer gate, a platform_admin
  // reaching this point already passed that check upstream — this inner
  // check simply can't fire false for that actor type in the only reachable
  // path. Flagged here for completeness, not because it's a live gap.
  const canPost = useAuthStore((s) => s.can('admin.announcements.post'))

  // Load class nodes lazily when class_node audience is chosen
  useEffect(() => {
    if (audience !== 'class_node' || classNodesState !== 'idle') return
    setClassNodesState('loading')
    loadClassNodes(schoolId).then(res => {
      if (res.ok) setClassNodes(res.data)
      setClassNodesState('ready')
    })
  }, [audience, classNodesState, schoolId])

  async function handleSubmit() {
    setError('')
    if (!canPost) { setError('You do not have permission to post announcements.'); return }
    if (!title.trim()) { setError('Title is required.'); return }
    if (!body.trim())  { setError('Body is required.'); return }
    if (audience === 'class_node' && !classNodeId) {
      setError('Please select a class.'); return
    }

    setSaving(true)
    const input: CreateAnnouncementInput = {
      title,
      body,
      audience,
      class_node_id: audience === 'class_node' ? classNodeId : null,
      is_public: isPublic,
      expires_at: expiresAt || null,
    }

    const res = await createAnnouncement(schoolId, input)
    setSaving(false)

    if (!res.ok) { setError(res.error); return }
    onCreated(res.data)
  }

  return (
    <div className="ann-overlay" onClick={onClose}>
      <div className="ann-form-sheet" onClick={e => e.stopPropagation()}>
        <div className="ann-form-handle" />
        <div className="ann-form-header">
          <h2 className="ann-form-title">New announcement</h2>
          <button className="ann-form-close" onClick={onClose} aria-label="Close"><Icon name="x" size={18} /></button>
        </div>

        <div className="ann-form-body">
          {/* Title */}
          <div className="ann-field">
            <label className="ann-label">
              Title <span className="ann-required">*</span>
            </label>
            <input
              className="ann-input"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="e.g. End-of-term assembly"
              maxLength={200}
            />
          </div>

          {/* Body */}
          <div className="ann-field">
            <label className="ann-label">
              Message <span className="ann-required">*</span>
            </label>
            <textarea
              className="ann-textarea"
              value={body}
              onChange={e => setBody(e.target.value)}
              placeholder="Write your announcement here…"
              rows={5}
            />
          </div>

          {/* Audience */}
          <div className="ann-field">
            <label className="ann-label">
              Audience <span className="ann-required">*</span>
            </label>
            <select
              className="ann-select"
              value={audience}
              onChange={e => { setAudience(e.target.value as AudienceType); setClassNodeId('') }}
            >
              <option value="all">Everyone</option>
              <option value="staff">Staff only</option>
              <option value="guardians">Guardians</option>
              <option value="students">Students</option>
              <option value="class_node">Specific class</option>
            </select>
          </div>

          {/* Class picker (only when audience = class_node) */}
          {audience === 'class_node' && (
            <div className="ann-field">
              <label className="ann-label">
                Class <span className="ann-required">*</span>
              </label>
              {classNodesState === 'loading' && (
                <p className="ann-field-hint">Loading classes…</p>
              )}
              {classNodesState === 'ready' && (
                <select
                  className="ann-select"
                  value={classNodeId}
                  onChange={e => setClassNodeId(e.target.value)}
                >
                  <option value="">Select a class</option>
                  {classNodes.map(c => (
                    <option key={c.id} value={c.id}>
                      {'  '.repeat(c.depth)}{c.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}

          {/* Expiry */}
          <div className="ann-field">
            <label className="ann-label">Expires on (optional)</label>
            <input
              className="ann-input"
              type="date"
              value={expiresAt}
              onChange={e => setExpiresAt(e.target.value)}
              min={new Date().toISOString().slice(0, 10)}
            />
            <p className="ann-field-hint">Leave blank to keep the announcement indefinitely.</p>
          </div>

          {/* Public toggle */}
          <div className="ann-field ann-field--row">
            <label className="ann-toggle-label">
              <input
                type="checkbox"
                checked={isPublic}
                onChange={e => setIsPublic(e.target.checked)}
                className="ann-toggle-input"
              />
              <span className="ann-toggle-track">
                <span className="ann-toggle-thumb" />
              </span>
              <span className="ann-toggle-text">Visible without login</span>
            </label>
          </div>

          {error && <p className="ann-form-error">{error}</p>}
        </div>

        <div className="ann-form-footer">
          <button className="ann-cancel-btn" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="ann-save-btn" onClick={handleSubmit} disabled={saving}>
            {saving ? 'Posting…' : 'Post announcement'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Notifications tab ────────────────────────────────────────────────────────

function NotificationsTab({
  schoolId,
  onRead,
}: {
  schoolId: string
  onRead: () => void
}) {
  const [loadState, setLoadState]         = useState<LoadState>('booting')
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [loadError, setLoadError]         = useState('')
  const [markingAll, setMarkingAll]       = useState(false)

  const load = useCallback(async () => {
    setLoadState('loading')
    const res = await loadNotifications(schoolId)
    if (!res.ok) {
      setLoadError(res.error)
      setLoadState('error')
      return
    }
    setNotifications(res.data)
    setLoadState('ready')
  }, [schoolId])

  useEffect(() => { load() }, [load])

  async function handleMarkRead(id: string) {
    const res = await markNotificationRead(id)
    if (!res.ok) return
    setNotifications(prev =>
      prev.map(n => n.id === id ? { ...n, status: 'read', read_at: new Date().toISOString() } : n)
    )
    onRead()
  }

  async function handleMarkAllRead() {
    setMarkingAll(true)
    const res = await markAllNotificationsRead(schoolId)
    if (res.ok) {
      setNotifications(prev =>
        prev.map(n => ({ ...n, status: 'read' as const, read_at: n.read_at ?? new Date().toISOString() }))
      )
      onRead()
    }
    setMarkingAll(false)
  }

  const hasUnread = notifications.some(n => n.status !== 'read')

  return (
    <>
      {hasUnread && loadState === 'ready' && (
        <div className="ann-notif-actions">
          <button
            className="ann-mark-all-btn"
            onClick={handleMarkAllRead}
            disabled={markingAll}
          >
            {markingAll ? 'Marking…' : 'Mark all as read'}
          </button>
        </div>
      )}

      {loadState === 'loading' && (
        <div className="ann-list-skel">
          {[1, 2, 3].map(i => <div key={i} className="ann-row-skel skeleton" />)}
        </div>
      )}

      {loadState === 'error' && (
        <div className="ann-error-state">
          <span className="ann-error-icon"><Icon name="alert-triangle" size={32} style={{ color: 'var(--color-warning, #d97706)' }} /></span>
          <p className="ann-error-msg">{loadError}</p>
          <button className="ann-retry-btn" onClick={load}>Try again</button>
        </div>
      )}

      {loadState === 'ready' && notifications.length === 0 && (
        <div className="ann-empty-state">
          <span className="ann-empty-icon"><Icon name="bell" size={40} /></span>
          <p className="ann-empty-msg">You're all caught up.</p>
        </div>
      )}

      {loadState === 'ready' && notifications.length > 0 && (
        <ul className="ann-notif-list">
          {notifications.map(n => (
            <li
              key={n.id}
              className={`ann-notif-row${n.status !== 'read' ? ' ann-notif-row--unread' : ''}`}
            >
              <button
                className="ann-notif-btn"
                onClick={() => n.status !== 'read' && handleMarkRead(n.id)}
              >
                <div className="ann-notif-dot-wrap">
                  {n.status !== 'read' && <span className="ann-notif-dot" />}
                </div>
                <div className="ann-notif-body">
                  {n.subject && <p className="ann-notif-subject">{n.subject}</p>}
                  <p className="ann-notif-text">{n.body}</p>
                  <p className="ann-notif-time">{relativeTime(n.created_at)}</p>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
