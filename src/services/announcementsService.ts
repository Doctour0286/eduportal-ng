/**
 * announcementsService.ts
 * Data layer for the Announcements module.
 *
 * Scope (Phase 6, email deferred):
 *  - loadAnnouncements()       — paginated list, school-scoped, audience-filtered by RLS
 *  - loadAnnouncement()        — single announcement by id
 *  - createAnnouncement()      — staff/admin write
 *  - deleteAnnouncement()      — staff/admin write (own posts only via RLS)
 *  - loadNotifications()       — in-app notifications for the current user
 *  - markNotificationRead()    — mark a single notification as read
 *  - markAllNotificationsRead()— mark all unread notifications as read
 *  - loadUnreadCount()         — badge count for the notification bell
 *
 * Tables used: announcements, notifications, app_identities, class_nodes, staff
 *
 * All figures are school-scoped via RLS — schoolId is passed for explicit
 * .eq() filters as a defence-in-depth measure, same as every other service.
 */

import { supabase } from '../lib/supabase'

// ─── Result type (consistent with other services) ─────────────────────────────

export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: string }

// ─── Domain types ─────────────────────────────────────────────────────────────

export type AudienceType = 'all' | 'staff' | 'guardians' | 'students' | 'class_node'

export interface Announcement {
  id: string
  school_id: string
  title: string
  body: string
  audience: AudienceType
  class_node_id: string | null
  class_node_name: string | null   // resolved from class_nodes join
  is_public: boolean
  posted_by: string                // staff.id
  posted_by_name: string | null    // resolved from staff join
  posted_at: string
  expires_at: string | null
  is_expired: boolean              // derived: expires_at < now()
}

export interface Notification {
  id: string
  school_id: string
  recipient_identity_id: string
  channel: string
  subject: string | null
  body: string
  related_table: string | null
  related_id: string | null
  status: 'pending' | 'sent' | 'failed' | 'read'
  sent_at: string | null
  read_at: string | null
  created_at: string
}

export interface CreateAnnouncementInput {
  title: string
  body: string
  audience: AudienceType
  class_node_id?: string | null
  is_public?: boolean
  expires_at?: string | null
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function friendlyError(err: { message: string }, fallback: string): string {
  if (err.message.includes('violates row-level security')) {
    return "You don't have permission to do that."
  }
  if (err.message.includes('violates foreign key')) {
    return 'A referenced record no longer exists. Please refresh and try again.'
  }
  return `${fallback}: ${err.message}`
}

function mapAnnouncement(r: Record<string, unknown>): Announcement {
  const classNodes = r.class_nodes as unknown as { name: string }[] | null
  const staffRows  = r.staff      as unknown as { full_name: string }[] | null

  const expiresAt = r.expires_at as string | null
  const isExpired = expiresAt ? new Date(expiresAt) < new Date() : false

  return {
    id:              r.id as string,
    school_id:       r.school_id as string,
    title:           r.title as string,
    body:            r.body as string,
    audience:        r.audience as AudienceType,
    class_node_id:   r.class_node_id as string | null,
    class_node_name: classNodes?.[0]?.name ?? null,
    is_public:       r.is_public as boolean,
    posted_by:       r.posted_by as string,
    posted_by_name:  staffRows?.[0]?.full_name ?? null,
    posted_at:       r.posted_at as string,
    expires_at:      expiresAt,
    is_expired:      isExpired,
  }
}

const ANNOUNCEMENT_SELECT = `
  id,
  school_id,
  title,
  body,
  audience,
  class_node_id,
  is_public,
  posted_by,
  posted_at,
  expires_at,
  class_nodes(name),
  staff(full_name)
`

// ─── Load announcements (paginated) ───────────────────────────────────────────

export async function loadAnnouncements(
  schoolId: string,
  opts: {
    audience?: AudienceType | 'all'
    includeExpired?: boolean
    page?: number
    pageSize?: number
  } = {}
): Promise<Result<{ announcements: Announcement[]; total: number }>> {
  const { audience, includeExpired = false, page = 0, pageSize = 20 } = opts
  const from = page * pageSize
  const to   = from + pageSize - 1

  try {
    let query = supabase
      .from('announcements')
      .select(ANNOUNCEMENT_SELECT, { count: 'exact' })
      .eq('school_id', schoolId)
      .order('posted_at', { ascending: false })
      .range(from, to)

    if (audience && audience !== 'all') {
      query = query.eq('audience', audience)
    }

    if (!includeExpired) {
      // Show announcements that haven't expired or have no expiry set
      query = query.or('expires_at.is.null,expires_at.gt.' + new Date().toISOString())
    }

    const { data, error, count } = await query

    if (error) return { ok: false, error: friendlyError(error, 'Failed to load announcements') }

    return {
      ok: true,
      data: {
        announcements: (data ?? []).map(r => mapAnnouncement(r as unknown as Record<string, unknown>)),
        total: count ?? 0,
      },
    }
  } catch (e) {
    return { ok: false, error: `Failed to load announcements: ${(e as Error).message}` }
  }
}

// ─── Load single announcement ─────────────────────────────────────────────────

export async function loadAnnouncement(
  schoolId: string,
  id: string
): Promise<Result<Announcement>> {
  try {
    const { data, error } = await supabase
      .from('announcements')
      .select(ANNOUNCEMENT_SELECT)
      .eq('school_id', schoolId)
      .eq('id', id)
      .single()

    if (error) return { ok: false, error: friendlyError(error, 'Failed to load announcement') }

    return { ok: true, data: mapAnnouncement(data as unknown as Record<string, unknown>) }
  } catch (e) {
    return { ok: false, error: `Failed to load announcement: ${(e as Error).message}` }
  }
}

// ─── Create announcement ──────────────────────────────────────────────────────

export async function createAnnouncement(
  schoolId: string,
  input: CreateAnnouncementInput
): Promise<Result<Announcement>> {
  // Validate: class_node audience requires a class_node_id
  if (input.audience === 'class_node' && !input.class_node_id) {
    return { ok: false, error: 'Please select a class for this announcement.' }
  }
  // Non-class audiences must not carry a class_node_id
  const class_node_id = input.audience === 'class_node' ? (input.class_node_id ?? null) : null

  try {
    // Resolve the caller's staff.id from app_identities
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return { ok: false, error: 'Not authenticated.' }

    const { data: identity } = await supabase
      .from('app_identities')
      .select('actor_record_id, actor_type')
      .eq('auth_user_id', user.id)
      .maybeSingle()

    if (!identity || identity.actor_type !== 'staff') {
      return { ok: false, error: 'Only staff members can post announcements.' }
    }

    const { data, error } = await supabase
      .from('announcements')
      .insert({
        school_id:     schoolId,
        title:         input.title.trim(),
        body:          input.body.trim(),
        audience:      input.audience,
        class_node_id: class_node_id,
        is_public:     input.is_public ?? false,
        posted_by:     identity.actor_record_id,
        expires_at:    input.expires_at ?? null,
      })
      .select(ANNOUNCEMENT_SELECT)
      .single()

    if (error) return { ok: false, error: friendlyError(error, 'Failed to post announcement') }

    return { ok: true, data: mapAnnouncement(data as unknown as Record<string, unknown>) }
  } catch (e) {
    return { ok: false, error: `Failed to post announcement: ${(e as Error).message}` }
  }
}

// ─── Delete announcement ──────────────────────────────────────────────────────

export async function deleteAnnouncement(
  schoolId: string,
  id: string
): Promise<Result<void>> {
  try {
    const { error } = await supabase
      .from('announcements')
      .delete()
      .eq('school_id', schoolId)
      .eq('id', id)

    if (error) return { ok: false, error: friendlyError(error, 'Failed to delete announcement') }

    return { ok: true, data: undefined }
  } catch (e) {
    return { ok: false, error: `Failed to delete announcement: ${(e as Error).message}` }
  }
}

// ─── Load notifications ───────────────────────────────────────────────────────

/**
 * The signed-in account's app_identities.id — notifications are addressed to
 * an identity, so every read/update below is pinned to it explicitly (the
 * database also enforces this; see migration_notifications_own_only.sql).
 * Cached per auth user so the header's polling doesn't re-query it.
 */
let cachedIdentity: { authUserId: string; identityId: string | null } | null = null

export async function getMyIdentityId(): Promise<string | null> {
  const { data: auth } = await supabase.auth.getUser()
  const uid = auth.user?.id
  if (!uid) return null
  if (cachedIdentity && cachedIdentity.authUserId === uid) return cachedIdentity.identityId
  const { data } = await supabase.from('app_identities').select('id').eq('auth_user_id', uid).maybeSingle()
  cachedIdentity = { authUserId: uid, identityId: (data?.id as string | undefined) ?? null }
  return cachedIdentity.identityId
}

export async function loadNotifications(
  schoolId: string,
  opts: { unreadOnly?: boolean } = {}
): Promise<Result<Notification[]>> {
  try {
    const me = await getMyIdentityId()
    if (!me) return { ok: true, data: [] }
    let query = supabase
      .from('notifications')
      .select('id, school_id, recipient_identity_id, channel, subject, body, related_table, related_id, status, sent_at, read_at, created_at')
      .eq('school_id', schoolId)
      .eq('recipient_identity_id', me)
      .eq('channel', 'in_app')
      .order('created_at', { ascending: false })
      .limit(50)

    if (opts.unreadOnly) {
      query = query.neq('status', 'read')
    }

    const { data, error } = await query

    if (error) return { ok: false, error: friendlyError(error, 'Failed to load notifications') }

    return {
      ok: true,
      data: (data ?? []).map(r => ({
        id:                     r.id,
        school_id:              r.school_id,
        recipient_identity_id:  r.recipient_identity_id,
        channel:                r.channel,
        subject:                r.subject,
        body:                   r.body,
        related_table:          r.related_table,
        related_id:             r.related_id,
        status:                 r.status as Notification['status'],
        sent_at:                r.sent_at,
        read_at:                r.read_at,
        created_at:             r.created_at,
      })),
    }
  } catch (e) {
    return { ok: false, error: `Failed to load notifications: ${(e as Error).message}` }
  }
}

// ─── Load unread notification count (for bell badge) ─────────────────────────

export async function loadUnreadCount(schoolId: string): Promise<Result<number>> {
  try {
    const me = await getMyIdentityId()
    if (!me) return { ok: true, data: 0 }
    const { count, error } = await supabase
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('school_id', schoolId)
      .eq('recipient_identity_id', me)
      .eq('channel', 'in_app')
      .neq('status', 'read')

    if (error) return { ok: false, error: friendlyError(error, 'Failed to load notification count') }

    return { ok: true, data: count ?? 0 }
  } catch (e) {
    return { ok: false, error: `Failed to load notification count: ${(e as Error).message}` }
  }
}

// ─── Mark notification read ───────────────────────────────────────────────────

export async function markNotificationRead(id: string): Promise<Result<void>> {
  try {
    const me = await getMyIdentityId()
    if (!me) return { ok: false, error: 'Not signed in' }
    const { error } = await supabase
      .from('notifications')
      .update({ status: 'read', read_at: new Date().toISOString() })
      .eq('id', id)
      .eq('recipient_identity_id', me)

    if (error) return { ok: false, error: friendlyError(error, 'Failed to mark notification') }

    return { ok: true, data: undefined }
  } catch (e) {
    return { ok: false, error: `Failed to mark notification: ${(e as Error).message}` }
  }
}

// ─── Mark all notifications read ─────────────────────────────────────────────

export async function markAllNotificationsRead(schoolId: string): Promise<Result<void>> {
  try {
    const me = await getMyIdentityId()
    if (!me) return { ok: false, error: 'Not signed in' }
    const { error } = await supabase
      .from('notifications')
      .update({ status: 'read', read_at: new Date().toISOString() })
      .eq('school_id', schoolId)
      .eq('recipient_identity_id', me)
      .eq('channel', 'in_app')
      .neq('status', 'read')

    if (error) return { ok: false, error: friendlyError(error, 'Failed to mark notifications') }

    return { ok: true, data: undefined }
  } catch (e) {
    return { ok: false, error: `Failed to mark notifications: ${(e as Error).message}` }
  }
}

// ─── Load class nodes for audience picker ────────────────────────────────────

export interface ClassNodeOption {
  id: string
  name: string
  parent_id: string | null
  sort_order: number
  /** Computed client-side via parent-walk (see loadClassNodes below) — not
   *  a real column. class_nodes has no numeric depth column; hierarchy is
   *  encoded purely via parent_id chains (confirmed against the live
   *  schema: id, school_id, parent_id, name, node_type, sort_order,
   *  is_leaf_enrollable, created_at, updated_at — no "level" column
   *  exists at all). depth is 0 for a root node (parent_id === null),
   *  parent's depth + 1 otherwise. Used only for `<select>` indentation. */
  depth: number
}

/**
 * Loads every class_node for the school and returns it as a flat,
 * hierarchically-ordered list (parents immediately followed by their own
 * children, recursively), with a client-computed `depth` for indentation.
 *
 * class_nodes has no denormalized level/depth column — hierarchy is
 * parent_id-chain based only (real schema confirmed via
 * information_schema.columns, see 2026-07-10 bugfix). A prior version of
 * this function selected/ordered by a "level" column that never existed,
 * which failed every call with a hard Postgres error (42703) — not an
 * RLS or empty-data issue, an actually-invalid query. Fixed here by
 * fetching the real columns (parent_id, sort_order) and walking the tree
 * client-side, the same map-to-parent-walk approach the master plan
 * documents for timetableService.ts's buildClassTree() — this is that
 * established pattern, not a new one invented for this file.
 */
export async function loadClassNodes(schoolId: string): Promise<Result<ClassNodeOption[]>> {
  try {
    const { data, error } = await supabase
      .from('class_nodes')
      .select('id, name, parent_id, sort_order')
      .eq('school_id', schoolId)

    if (error) return { ok: false, error: friendlyError(error, 'Failed to load classes') }

    const rows = (data ?? []) as { id: string; name: string; parent_id: string | null; sort_order: number }[]

    // Group children by parent_id (null key = root nodes), each group
    // sorted by sort_order — sort_order is only meaningful among siblings,
    // never as a flat cross-tree ordering, hence the grouped walk rather
    // than a single top-level .order('sort_order').
    const byParent = new Map<string | null, typeof rows>()
    for (const r of rows) {
      const key = r.parent_id
      const group = byParent.get(key)
      if (group) group.push(r)
      else byParent.set(key, [r])
    }
    for (const group of byParent.values()) {
      group.sort((a, b) => a.sort_order - b.sort_order)
    }

    const result: ClassNodeOption[] = []
    function walk(parentId: string | null, depth: number) {
      const children = byParent.get(parentId)
      if (!children) return
      for (const c of children) {
        result.push({ id: c.id, name: c.name, parent_id: c.parent_id, sort_order: c.sort_order, depth })
        walk(c.id, depth + 1)
      }
    }
    walk(null, 0)

    return { ok: true, data: result }
  } catch (e) {
    return { ok: false, error: `Failed to load classes: ${(e as Error).message}` }
  }
}
