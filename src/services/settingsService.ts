/**
 * settingsService.ts
 * Data-access layer for the Admin Settings Panel (Phase 6 — last module).
 *
 * Scope: post-setup editing of everything the onboarding wizard configured,
 * plus module-level settings and the audit log viewer.
 *
 * Tables touched (all already live with RLS from Phase 1–4):
 *   schools, school_public_config, school_week_days, periods,
 *   subjects, class_nodes, roles, permissions, role_permissions,
 *   staff, staff_roles, sessions, terms, audit_log,
 *   student_roles, student_role_assignments (Session 13, §7.8a)
 *
 * Student-role exports (Session 13, PRD Problem 5.5):
 *   loadStudentRoles()   — the school's defined student roles
 *   saveStudentRole()    — create/update a role definition
 *   deleteStudentRole()  — remove a role definition (hard delete — see §7.8a)
 *
 * Pattern rules (consistent with every other service in this project):
 *   - No hard deletes — status changes only (roles: is_admin_role toggle;
 *     subjects/class_nodes/periods: soft-delete via status when needed)
 *   - Money: numeric(14,2) — not touched here (no money tables)
 *   - FK resolution via app_identities when writing actor ids
 *   - Joined relations cast through unknown → array before plucking [0]
 *   - schoolId threaded on every call — never inferred client-side
 */

import { supabase } from '../lib/supabase'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SchoolSettings {
  id: string
  name: string
  slug: string
  school_type: string | null
  logo_url: string | null
  theme_color: string | null
  default_lang: 'en' | 'ar' | 'ha'
  enabled_langs: string[]
  uses_terms: boolean
  uses_ledger: boolean
  status: string
}

// ─── Welcome post (owner request, 2026-07-11 — replaces plain-text
// welcome_message with a real heading + ordered block post) ────────────────
//
// Stored in school_public_config.welcome_post (jsonb, additive migration —
// see add_welcome_post_column.sql). welcome_message itself is untouched:
// PublicHomepage.tsx falls back to it when welcome_post is null, so a
// school that saved a plain message before this feature existed doesn't
// go blank. This editor no longer writes welcome_message going forward.

export interface WelcomePostParagraphBlock {
  type: 'paragraph'
  text: string
}

export interface WelcomePostImageBlock {
  type: 'image'
  url: string
  caption?: string
}

export type WelcomePostBlock = WelcomePostParagraphBlock | WelcomePostImageBlock

export interface WelcomePost {
  heading: string
  blocks: WelcomePostBlock[]
}

export interface SchoolPublicConfig {
  welcome_message: string | null
  welcome_post: WelcomePost | null
  contact_info: {
    phone?: string
    email?: string
    address?: string
    social_links?: Record<string, string>
  } | null
  show_announcements: boolean
}

export interface Period {
  id: string
  label: string
  start_time: string
  end_time: string
  is_break: boolean
  sort_order: number
}

export interface WeekDay {
  day_of_week: number   // 0=Sunday … 6=Saturday
  sort_order: number
}

export interface Subject {
  id: string
  name: string
  code: string | null
}

export interface ClassNode {
  id: string
  parent_id: string | null
  name: string
  node_type: string | null
  sort_order: number
  is_leaf_enrollable: boolean
  children?: ClassNode[]
}

export interface Role {
  id: string
  name: string
  is_admin_role: boolean
  permissions: string[]
}

// Session 13 (PRD Problem 5.5) — descriptive-only, no permissions equivalent.
// class_id null = school-wide; set = scoped to that one class. Admin chooses
// this per-role at creation time (§7.8a), not a fixed global setting.
export interface StudentRole {
  id: string
  name: string
  class_id: string | null
}

export interface Permission {
  key: string
  description: string
  module: string
}

export interface Session {
  id: string
  name: string
  start_date: string
  end_date: string
  is_current: boolean
}

export interface Term {
  id: string
  session_id: string
  name: string
  sequence: number
  start_date: string
  end_date: string
}

// Session 18 (PRD Problem 5.2/6.7) — a specific-date exception to the
// recurring school_week_days pattern. day_type 'school_day' is rarely
// inserted explicitly (it's the implicit default absent any row) but is
// supported for the rare case of overriding an otherwise-non-school weekday
// (e.g. a mandatory Saturday makeup class).
export type CalendarDayType = 'school_day' | 'holiday' | 'exam_day' | 'break'

export interface CalendarDay {
  id: string
  calendar_date: string
  day_type: CalendarDayType
  label: string | null
  extends_term: boolean
}

export interface AuditEntry {
  id: string
  created_at: string
  actor_id: string | null
  actor_type: string | null
  table_name: string
  record_id: string
  action: 'INSERT' | 'UPDATE' | 'DELETE'
  old_data: Record<string, unknown> | null
  new_data: Record<string, unknown> | null
}

export interface StaffListItem {
  id: string
  full_name: string
  email: string | null
  phone: string | null
  status: string
  hire_date: string | null
  roles: string[]
}

// Session 28 (PRD Problem 6.6, §12) — per-account alarm/display prefs.
// One row per staff member, [SELF] RLS (see migration_session_28.sql) — a
// staff member only ever reads/writes their own row. Kept in this file
// (rather than a brand-new service) since AccountPreferencesScreen.tsx
// already imports hrService for the sibling Payslip section — same
// "self-service settings" shape, just a different table.
export type ClockFormatPref = '12h' | '24h'
export type DefaultViewPref = 'class' | 'teacher'
export type SoundTypePref = 'chime' | 'bell' | 'buzzer' | 'digital'
export type AlertScopePref = 'mine' | 'all'

export interface StaffPreferences {
  clock_format: ClockFormatPref
  default_day: number | null
  default_view: DefaultViewPref
  show_seconds: boolean
  highlight_col: boolean

  sound_enabled: boolean
  sound_type: SoundTypePref
  sound_vol: number
  sound_repeat: number
  early_warning: boolean
  warn_lead_min: number
  browser_notif: boolean
  alert_scope: AlertScopePref
}

// Matches the table's own column defaults (migration_session_28.sql) —
// returned when a staff member has no row yet (brand-new account, or one
// that existed before this migration ran), so callers never have to
// special-case "no preferences saved yet" themselves.
export const DEFAULT_STAFF_PREFERENCES: StaffPreferences = {
  clock_format: '12h',
  default_day: null,
  default_view: 'class',
  show_seconds: false,
  highlight_col: true,

  sound_enabled: true,
  sound_type: 'chime',
  sound_vol: 0.70,
  sound_repeat: 1,
  early_warning: false,
  warn_lead_min: 2,
  browser_notif: false,
  alert_scope: 'mine',
}

// The column list below is inlined directly into .select() rather than
// pulled from a shared string constant (as a previous version of this file
// did) — Supabase's typed client can only narrow `data`'s shape when it sees
// a literal string at the .select() call site itself; routed through a
// `string`-typed variable, the column list becomes unparseable statically
// and `data` widens to a generic fallback shape with almost no overlap
// against StaffPreferences, which is exactly what produced the
// `TS2352: Conversion ... may be a mistake` build error. Every other
// .select() call in this file already inlines its literal column list for
// this same reason — this was the one call that didn't, and a bare
// (unused) constant left behind would itself fail `noUnusedLocals` under
// `tsc -b`'s strict settings, reintroducing a build error of the exact
// invisible-to-`npm run dev` class the PRD's own §0.2 warns about.

/**
 * Loads this staff member's preferences, falling back to
 * DEFAULT_STAFF_PREFERENCES if no row exists yet (maybeSingle — a missing
 * row is an expected, non-error state here, not a fault). staffId must be
 * the caller's own actorRecordId (resolved via authStore), never a
 * client-chosen id — RLS also enforces this server-side ([SELF] policy);
 * this is just the client-side mirror of that same rule so a mismatched
 * staffId fails softly (empty read) rather than surfacing a confusing RLS
 * error.
 */
export async function loadStaffPreferences(staffId: string): Promise<{ data: StaffPreferences; error: string | null }> {
  const { data, error } = await supabase
    .from('staff_preferences')
    .select('clock_format, default_day, default_view, show_seconds, highlight_col, sound_enabled, sound_type, sound_vol, sound_repeat, early_warning, warn_lead_min, browser_notif, alert_scope')
    .eq('staff_id', staffId)
    .maybeSingle()

  if (error) return { data: DEFAULT_STAFF_PREFERENCES, error: error.message }
  return {
    data: data ? (data as StaffPreferences) : DEFAULT_STAFF_PREFERENCES,
    error: null,
  }
}

/**
 * Upserts this staff member's preferences (onConflict: staff_id, matching
 * the table's `staff_preferences_one_row_per_staff` unique constraint) —
 * one round trip whether this is the first save (insert) or the hundredth
 * (update), same shape as savePublicConfig above. schoolId is required on
 * insert (school_id is NOT NULL) even though it isn't part of the RLS
 * predicate, so it's threaded here purely to satisfy the column, not for
 * any access-control purpose.
 */
export async function saveStaffPreferences(
  schoolId: string,
  staffId: string,
  prefs: Partial<StaffPreferences>
): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from('staff_preferences')
    .upsert(
      { school_id: schoolId, staff_id: staffId, ...prefs, updated_at: new Date().toISOString() },
      { onConflict: 'staff_id' }
    )

  return { error: error?.message ?? null }
}

// ─── Theme preference (all actor types) ────────────────────────────────────
// Dark mode (§12, decided 2026-07-09) needs to work for every signed-in
// actor type — staff, guardian, student — not just staff, so it can't live
// on staff_preferences (which has no row at all for guardians/students, by
// design: migration_session_28.sql). Lives instead in its own
// app_identity_preferences table (migration_dark_mode.sql), one row per
// auth.users(id), [SELF] RLS keyed directly on auth.uid() — no props, no
// staffId/actorRecordId needed, matching AccountPreferencesScreen.tsx's own
// "every section resolves what it needs from the current session" shape.
//
// Session 28 originally reserved a `theme` column on staff_preferences for
// this; migration_dark_mode.sql drops it as dead (verified unused) now that
// this is the real, all-actor-types home instead.
export type ThemeModePref = 'light' | 'dark'

const DEFAULT_THEME_MODE: ThemeModePref = 'light'

/**
 * Loads the current signed-in user's theme preference. Resolves
 * auth_user_id itself via supabase.auth.getUser() rather than taking it as
 * a param — nothing else in the app currently exposes app_identities.id or
 * the raw auth user id through authStore, and adding it there just for this
 * would widen that store's surface for a cosmetic setting. maybeSingle: no
 * row yet (brand-new account, or one that existed before this migration
 * ran) is an expected, non-error state, matching loadStaffPreferences'
 * shape — falls back to 'light' rather than surfacing an error for it.
 */
export async function loadThemePreference(): Promise<{ data: ThemeModePref; error: string | null }> {
  const { data: userData, error: userError } = await supabase.auth.getUser()
  if (userError || !userData.user) {
    return { data: DEFAULT_THEME_MODE, error: userError?.message ?? 'Not signed in' }
  }

  const { data, error } = await supabase
    .from('app_identity_preferences')
    .select('theme_mode')
    .eq('auth_user_id', userData.user.id)
    .maybeSingle()

  if (error) return { data: DEFAULT_THEME_MODE, error: error.message }
  return {
    data: (data?.theme_mode as ThemeModePref | undefined) ?? DEFAULT_THEME_MODE,
    error: null,
  }
}

/**
 * Upserts the current signed-in user's theme preference (onConflict:
 * auth_user_id, matching the table's app_identity_preferences_one_row_per_user
 * unique constraint) — same one-round-trip shape as saveStaffPreferences.
 */
export async function saveThemePreference(themeMode: ThemeModePref): Promise<{ error: string | null }> {
  const { data: userData, error: userError } = await supabase.auth.getUser()
  if (userError || !userData.user) {
    return { error: userError?.message ?? 'Not signed in' }
  }

  const { error } = await supabase
    .from('app_identity_preferences')
    .upsert(
      { auth_user_id: userData.user.id, theme_mode: themeMode, updated_at: new Date().toISOString() },
      { onConflict: 'auth_user_id' }
    )

  return { error: error?.message ?? null }
}

// ─── School branding & config ─────────────────────────────────────────────────

export async function loadSchoolSettings(schoolId: string): Promise<{ data: SchoolSettings | null; error: string | null }> {
  const { data, error } = await supabase
    .from('schools')
    .select('id, name, slug, school_type, logo_url, theme_color, default_lang, enabled_langs, uses_terms, uses_ledger, status')
    .eq('id', schoolId)
    .single()

  if (error) return { data: null, error: error.message }
  return { data: data as SchoolSettings, error: null }
}

export async function updateSchoolSettings(
  schoolId: string,
  updates: Partial<Pick<SchoolSettings, 'name' | 'school_type' | 'logo_url' | 'theme_color' | 'default_lang' | 'enabled_langs' | 'uses_terms' | 'uses_ledger'>>
): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from('schools')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', schoolId)

  return { error: error?.message ?? null }
}

export async function loadPublicConfig(schoolId: string): Promise<{ data: SchoolPublicConfig | null; error: string | null }> {
  const { data, error } = await supabase
    .from('school_public_config')
    .select('welcome_message, welcome_post, contact_info, show_announcements')
    .eq('school_id', schoolId)
    .maybeSingle()

  if (error) return { data: null, error: error.message }
  return {
    data: data
      ? (data as SchoolPublicConfig)
      : { welcome_message: null, welcome_post: null, contact_info: null, show_announcements: true },
    error: null,
  }
}

export async function savePublicConfig(
  schoolId: string,
  cfg: SchoolPublicConfig
): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from('school_public_config')
    .upsert({ school_id: schoolId, ...cfg, updated_at: new Date().toISOString() }, { onConflict: 'school_id' })

  return { error: error?.message ?? null }
}

// ─── Welcome post images ────────────────────────────────────────────────────
// Uploads to the public `school-homepage-images` Storage bucket (see
// school_homepage_images_bucket_setup.sql). Deliberately PUBLIC, unlike
// studentsService.ts's private + signed-URL student-photo pattern — this
// page is anonymous/no-auth/high-traffic, the content has no
// confidentiality requirement, and a signed URL would both cost an extra
// request per image on the highest-traffic page in the app and eventually
// expire with no session available to refresh it. See the bucket-setup
// migration's own header comment for the full reasoning. Because the
// bucket is public, the resolved public URL is stored directly in
// welcome_post — no separate "resolve signed URL at render time" step is
// needed, unlike student photos.
//
// Client-side resize before upload, same approach studentsService.ts's
// resizeImageToBlob() documents (createImageBitmap/canvas — no new
// dependency; browser-image-compression confirmed absent from
// package.json there, same holds here) — capped smaller than a student ID
// photo, since this is a page hero/inline image, not a printed card asset.

const HOMEPAGE_IMAGE_MAX_DIMENSION = 1600
const HOMEPAGE_IMAGE_JPEG_QUALITY = 0.82

async function resizeHomepageImageToBlob(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, HOMEPAGE_IMAGE_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height))
  const width = Math.round(bitmap.width * scale)
  const height = Math.round(bitmap.height * scale)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not prepare image for upload')
  ctx.drawImage(bitmap, 0, 0, width, height)

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      blob => (blob ? resolve(blob) : reject(new Error('Could not prepare image for upload'))),
      'image/jpeg',
      HOMEPAGE_IMAGE_JPEG_QUALITY
    )
  })
}

/**
 * Uploads one welcome-post image and returns its public URL. Deliberately
 * a single-purpose helper (not a generic file-upload utility) — flagged
 * per this project's own §5 exception precedent (studentsService.ts's
 * resizeImageToBlob() header note): createImageBitmap/canvas are
 * browser-only APIs, breaking this file's general "no browser-only APIs"
 * convention, kept here anyway because owning "always resize, no
 * exceptions" in one place is a real safety property worth the
 * inconsistency, same reasoning as that precedent.
 */
export async function uploadWelcomePostImage(
  schoolId: string,
  file: File
): Promise<{ url: string | null; error: string | null }> {
  try {
    const blob = await resizeHomepageImageToBlob(file)
    const ext = 'jpg'
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
    const path = `${schoolId}/${filename}`

    const { error: uploadErr } = await supabase.storage
      .from('school-homepage-images')
      .upload(path, blob, { contentType: 'image/jpeg', upsert: false })

    if (uploadErr) return { url: null, error: uploadErr.message }

    const { data } = supabase.storage.from('school-homepage-images').getPublicUrl(path)
    return { url: data.publicUrl, error: null }
  } catch (e) {
    return { url: null, error: (e as Error).message }
  }
}

// ─── Homepage posts (owner request, 2026-07-11 follow-up — upgrades the
// single welcome_post above to a real list of several expandable posts) ────
//
// Stored in a new school_homepage_posts table (see
// add_school_homepage_posts_table.sql), NOT inside school_public_config —
// this is a genuine one-to-many relationship (per-post always_expanded
// toggle, per-post ordering, future per-post publish/unpublish), which a
// singleton-per-school config row can't represent cleanly. welcome_post
// above is left completely untouched and is not migrated into this list —
// same "start fresh, old data stays dormant" approach already used for
// welcome_message → welcome_post.
//
// blocks reuses the exact same WelcomePostBlock shape as welcome_post —
// deliberately not a new/parallel block type.

export interface HomepagePost {
  id: string
  school_id: string
  heading: string
  blocks: WelcomePostBlock[]
  always_expanded: boolean
  sort_order: number
  created_at: string
  updated_at: string
}

export async function loadHomepagePosts(
  schoolId: string
): Promise<{ data: HomepagePost[]; error: string | null }> {
  const { data, error } = await supabase
    .from('school_homepage_posts')
    .select('id, school_id, heading, blocks, always_expanded, sort_order, created_at, updated_at')
    .eq('school_id', schoolId)
    .order('sort_order', { ascending: true })

  if (error) return { data: [], error: error.message }
  return { data: (data ?? []) as HomepagePost[], error: null }
}

export async function createHomepagePost(
  schoolId: string,
  post: { heading: string; blocks: WelcomePostBlock[]; always_expanded: boolean; sort_order: number }
): Promise<{ data: HomepagePost | null; error: string | null }> {
  const { data, error } = await supabase
    .from('school_homepage_posts')
    .insert({ school_id: schoolId, ...post })
    .select('id, school_id, heading, blocks, always_expanded, sort_order, created_at, updated_at')
    .single()

  if (error) return { data: null, error: error.message }
  return { data: data as HomepagePost, error: null }
}

export async function updateHomepagePost(
  postId: string,
  updates: Partial<Pick<HomepagePost, 'heading' | 'blocks' | 'always_expanded' | 'sort_order'>>
): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from('school_homepage_posts')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', postId)

  return { error: error?.message ?? null }
}

export async function deleteHomepagePost(postId: string): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from('school_homepage_posts')
    .delete()
    .eq('id', postId)

  return { error: error?.message ?? null }
}

/**
 * Persists a full reorder in one round trip — called after a drag/move
 * action rebuilds the local list order client-side. Writes sort_order for
 * every post in the given order (0-indexed), not just the two that moved,
 * so ties can never occur even if a prior partial-write left gaps.
 */
export async function reorderHomepagePosts(
  postIds: string[]
): Promise<{ error: string | null }> {
  const results = await Promise.all(
    postIds.map((id, index) =>
      supabase.from('school_homepage_posts').update({ sort_order: index, updated_at: new Date().toISOString() }).eq('id', id)
    )
  )
  const firstError = results.find(r => r.error)?.error
  return { error: firstError?.message ?? null }
}

// ─── Calendar — sessions & terms ──────────────────────────────────────────────

export async function loadSessions(schoolId: string): Promise<{ data: Session[]; error: string | null }> {
  const { data, error } = await supabase
    .from('sessions')
    .select('id, name, start_date, end_date, is_current')
    .eq('school_id', schoolId)
    .order('start_date', { ascending: false })

  if (error) return { data: [], error: error.message }
  return { data: (data ?? []) as Session[], error: null }
}

export async function upsertSession(
  schoolId: string,
  session: { id?: string; name: string; start_date: string; end_date: string; is_current: boolean }
): Promise<{ error: string | null }> {
  // Demote any existing current session first if we're setting a new one
  if (session.is_current) {
    await supabase
      .from('sessions')
      .update({ is_current: false })
      .eq('school_id', schoolId)
      .eq('is_current', true)
  }

  if (session.id) {
    const { error } = await supabase
      .from('sessions')
      .update({ name: session.name, start_date: session.start_date, end_date: session.end_date, is_current: session.is_current })
      .eq('id', session.id)
      .eq('school_id', schoolId)
    return { error: error?.message ?? null }
  } else {
    const { error } = await supabase
      .from('sessions')
      .insert({ school_id: schoolId, name: session.name, start_date: session.start_date, end_date: session.end_date, is_current: session.is_current })
    return { error: error?.message ?? null }
  }
}

export async function loadTerms(schoolId: string, sessionId: string): Promise<{ data: Term[]; error: string | null }> {
  const { data, error } = await supabase
    .from('terms')
    .select('id, session_id, name, sequence, start_date, end_date')
    .eq('school_id', schoolId)
    .eq('session_id', sessionId)
    .order('sequence', { ascending: true })

  if (error) return { data: [], error: error.message }
  return { data: (data ?? []) as Term[], error: null }
}

export async function upsertTerm(
  schoolId: string,
  term: { id?: string; session_id: string; name: string; sequence: number; start_date: string; end_date: string }
): Promise<{ error: string | null }> {
  if (term.id) {
    const { error } = await supabase
      .from('terms')
      .update({ name: term.name, sequence: term.sequence, start_date: term.start_date, end_date: term.end_date })
      .eq('id', term.id)
      .eq('school_id', schoolId)
    return { error: error?.message ?? null }
  } else {
    const { error } = await supabase
      .from('terms')
      .insert({ school_id: schoolId, ...term })
    return { error: error?.message ?? null }
  }
}

// ─── School calendar (holidays / exam days / breaks) ─────────────────────────
// Session 18, PRD Problem 5.2 (Goals 2–4) + Problem 6.7's term-extension
// refinement (owner-requested per-entry choice, not a global rule — see
// migration_calendar_extend_term.sql). Distinct from the Calendar tab's
// sessions/terms (the *recurring* structure) — these are *specific-date
// exceptions* to that structure. school_id + session_id scoped per §3.6, so
// it works whether or not uses_terms is true.

export async function loadCalendarDays(
  schoolId: string,
  sessionId: string,
): Promise<{ data: CalendarDay[]; error: string | null }> {
  const { data, error } = await supabase
    .from('school_calendar_days')
    .select('id, calendar_date, day_type, label, extends_term')
    .eq('school_id', schoolId)
    .eq('session_id', sessionId)
    .order('calendar_date', { ascending: true })

  if (error) return { data: [], error: error.message }
  return { data: (data ?? []) as CalendarDay[], error: null }
}

export async function upsertCalendarDay(
  schoolId: string,
  sessionId: string,
  entry: { id?: string; calendar_date: string; day_type: CalendarDayType; label: string | null; extends_term: boolean }
): Promise<{ error: string | null }> {
  if (entry.id) {
    const { error } = await supabase
      .from('school_calendar_days')
      .update({
        day_type: entry.day_type,
        label: entry.label,
        extends_term: entry.extends_term,
        updated_at: new Date().toISOString(),
      })
      .eq('id', entry.id)
      .eq('school_id', schoolId)
    return { error: error?.message ?? null }
  }

  const { error } = await supabase
    .from('school_calendar_days')
    .upsert(
      {
        school_id: schoolId,
        session_id: sessionId,
        calendar_date: entry.calendar_date,
        day_type: entry.day_type,
        label: entry.label,
        extends_term: entry.extends_term,
      },
      { onConflict: 'school_id,calendar_date' }
    )
  return { error: error?.message ?? null }
}

/**
 * Marks every date in [startDate, endDate] inclusive with the same day_type/
 * label/extends_term — the bulk-range entry point for things like a
 * multi-week mid-term break. Upserts one date at a time (school_id,
 * calendar_date is the real unique constraint) rather than a single batched
 * insert, so a range that partially overlaps existing entries updates those
 * rows instead of erroring — reusing upsertCalendarDay per date rather than
 * duplicating the upsert shape here.
 *
 * Does NOT skip weekends or otherwise pre-filter which dates in the range
 * are "real" school days — every school runs a different week pattern
 * (school_week_days is per-school, e.g. some run Sat–Sun instead of Mon–Fri),
 * so this function has no business guessing which dates matter. It simply
 * marks the full range as requested; getEffectiveTermEndDate() and the
 * attendance calendar-awareness logic are what correctly ignore the
 * already-non-school dates within it.
 */
export async function bulkUpsertCalendarDays(
  schoolId: string,
  sessionId: string,
  range: { start_date: string; end_date: string; day_type: CalendarDayType; label: string | null; extends_term: boolean }
): Promise<{ error: string | null; count: number }> {
  const dates: string[] = []
  const cursor = new Date(range.start_date + 'T00:00:00')
  const end = new Date(range.end_date + 'T00:00:00')
  if (cursor > end) return { error: 'Start date must be on or before end date.', count: 0 }

  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10))
    cursor.setDate(cursor.getDate() + 1)
  }

  const rows = dates.map(calendar_date => ({
    school_id: schoolId,
    session_id: sessionId,
    calendar_date,
    day_type: range.day_type,
    label: range.label,
    extends_term: range.extends_term,
  }))

  const { error } = await supabase
    .from('school_calendar_days')
    .upsert(rows, { onConflict: 'school_id,calendar_date' })

  if (error) return { error: error.message, count: 0 }
  return { error: null, count: rows.length }
}

export async function deleteCalendarDay(schoolId: string, calendarDayId: string): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from('school_calendar_days')
    .delete()
    .eq('id', calendarDayId)
    .eq('school_id', schoolId)
  return { error: error?.message ?? null }
}

// ─── Week & periods ───────────────────────────────────────────────────────────

export async function loadWeekDays(schoolId: string): Promise<{ data: WeekDay[]; error: string | null }> {
  const { data, error } = await supabase
    .from('school_week_days')
    .select('day_of_week, sort_order')
    .eq('school_id', schoolId)
    .order('sort_order', { ascending: true })

  if (error) return { data: [], error: error.message }
  return { data: (data ?? []) as WeekDay[], error: null }
}

export async function saveWeekDays(schoolId: string, days: number[]): Promise<{ error: string | null }> {
  // Delete then re-insert to handle day removal cleanly
  const { error: delErr } = await supabase
    .from('school_week_days')
    .delete()
    .eq('school_id', schoolId)

  if (delErr) return { error: delErr.message }

  if (days.length === 0) return { error: null }

  const rows = days.map((day, idx) => ({ school_id: schoolId, day_of_week: day, sort_order: idx }))
  const { error } = await supabase.from('school_week_days').insert(rows)
  return { error: error?.message ?? null }
}

export async function loadPeriods(schoolId: string): Promise<{ data: Period[]; error: string | null }> {
  const { data, error } = await supabase
    .from('periods')
    .select('id, label, start_time, end_time, is_break, sort_order')
    .eq('school_id', schoolId)
    .order('sort_order', { ascending: true })

  if (error) return { data: [], error: error.message }
  return { data: (data ?? []) as Period[], error: null }
}

export async function upsertPeriod(
  schoolId: string,
  period: { id?: string; label: string; start_time: string; end_time: string; is_break: boolean; sort_order: number }
): Promise<{ error: string | null }> {
  if (period.id) {
    const { error } = await supabase
      .from('periods')
      .update({ label: period.label, start_time: period.start_time, end_time: period.end_time, is_break: period.is_break, sort_order: period.sort_order })
      .eq('id', period.id)
      .eq('school_id', schoolId)
    return { error: error?.message ?? null }
  } else {
    const { error } = await supabase
      .from('periods')
      .insert({ school_id: schoolId, ...period })
    return { error: error?.message ?? null }
  }
}

export async function deletePeriod(schoolId: string, periodId: string): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from('periods')
    .delete()
    .eq('id', periodId)
    .eq('school_id', schoolId)
  return { error: error?.message ?? null }
}

// ─── Subjects ─────────────────────────────────────────────────────────────────

export async function loadSubjects(schoolId: string): Promise<{ data: Subject[]; error: string | null }> {
  const { data, error } = await supabase
    .from('subjects')
    .select('id, name, code')
    .eq('school_id', schoolId)
    .order('name', { ascending: true })

  if (error) return { data: [], error: error.message }
  return { data: (data ?? []) as Subject[], error: null }
}

export async function upsertSubject(
  schoolId: string,
  subject: { id?: string; name: string; code?: string | null }
): Promise<{ error: string | null }> {
  if (subject.id) {
    const { error } = await supabase
      .from('subjects')
      .update({ name: subject.name, code: subject.code ?? null })
      .eq('id', subject.id)
      .eq('school_id', schoolId)
    return { error: error?.message ?? null }
  } else {
    const { error } = await supabase
      .from('subjects')
      .insert({ school_id: schoolId, name: subject.name, code: subject.code ?? null })
    return { error: error?.message ?? null }
  }
}

// No hard delete — leave for future soft-delete UI if needed.
// Subjects with scores/class_subjects FKs can't be deleted without a cascade anyway.

// ─── Class hierarchy ──────────────────────────────────────────────────────────

export async function loadClassNodes(schoolId: string): Promise<{ data: ClassNode[]; error: string | null }> {
  const { data, error } = await supabase
    .from('class_nodes')
    .select('id, parent_id, name, node_type, sort_order, is_leaf_enrollable')
    .eq('school_id', schoolId)
    .order('sort_order', { ascending: true })

  if (error) return { data: [], error: error.message }
  return { data: (data ?? []) as ClassNode[], error: null }
}

/** Build a flat list into a tree (client-side — avoids recursive SQL). */
export function buildClassTree(flat: ClassNode[]): ClassNode[] {
  const map = new Map<string, ClassNode>()
  flat.forEach(n => map.set(n.id, { ...n, children: [] }))

  const roots: ClassNode[] = []
  map.forEach(node => {
    if (node.parent_id && map.has(node.parent_id)) {
      map.get(node.parent_id)!.children!.push(node)
    } else {
      roots.push(node)
    }
  })
  return roots
}

export async function upsertClassNode(
  schoolId: string,
  node: { id?: string; parent_id: string | null; name: string; node_type?: string | null; sort_order: number; is_leaf_enrollable: boolean }
): Promise<{ error: string | null }> {
  if (node.id) {
    const { error } = await supabase
      .from('class_nodes')
      .update({ parent_id: node.parent_id, name: node.name, node_type: node.node_type ?? null, sort_order: node.sort_order, is_leaf_enrollable: node.is_leaf_enrollable, updated_at: new Date().toISOString() })
      .eq('id', node.id)
      .eq('school_id', schoolId)
    return { error: error?.message ?? null }
  } else {
    const { error } = await supabase
      .from('class_nodes')
      .insert({ school_id: schoolId, parent_id: node.parent_id, name: node.name, node_type: node.node_type ?? null, sort_order: node.sort_order, is_leaf_enrollable: node.is_leaf_enrollable })
    return { error: error?.message ?? null }
  }
}

// ─── Roles & permissions ──────────────────────────────────────────────────────

export async function loadPermissionsCatalog(): Promise<{ data: Permission[]; error: string | null }> {
  const { data, error } = await supabase
    .from('permissions')
    .select('key, description, module')
    .order('module', { ascending: true })

  if (error) return { data: [], error: error.message }
  return { data: (data ?? []) as Permission[], error: null }
}

export async function loadRoles(schoolId: string): Promise<{ data: Role[]; error: string | null }> {
  const { data, error } = await supabase
    .from('roles')
    .select('id, name, is_admin_role, role_permissions(permission_key)')
    .eq('school_id', schoolId)
    .order('name', { ascending: true })

  if (error) return { data: [], error: error.message }

  const roles: Role[] = (data ?? []).map((r) => ({
    id: r.id as string,
    name: r.name as string,
    is_admin_role: r.is_admin_role as boolean,
    permissions: ((r.role_permissions as unknown as { permission_key: string }[]) ?? []).map(rp => rp.permission_key),
  }))

  return { data: roles, error: null }
}

export async function saveRole(
  schoolId: string,
  role: { id?: string; name: string; is_admin_role: boolean; permissions: string[] }
): Promise<{ error: string | null }> {
  let roleId = role.id

  if (roleId) {
    const { error } = await supabase
      .from('roles')
      .update({ name: role.name, is_admin_role: role.is_admin_role })
      .eq('id', roleId)
      .eq('school_id', schoolId)
    if (error) return { error: error.message }
  } else {
    const { data, error } = await supabase
      .from('roles')
      .insert({ school_id: schoolId, name: role.name, is_admin_role: role.is_admin_role })
      .select('id')
      .single()
    if (error) return { error: error.message }
    roleId = (data as { id: string }).id
  }

  // Replace permissions: delete all then re-insert
  const { error: delErr } = await supabase
    .from('role_permissions')
    .delete()
    .eq('role_id', roleId)
  if (delErr) return { error: delErr.message }

  if (role.permissions.length > 0) {
    const rows = role.permissions.map(key => ({ role_id: roleId, permission_key: key }))
    const { error: insErr } = await supabase.from('role_permissions').insert(rows)
    if (insErr) return { error: insErr.message }
  }

  return { error: null }
}

export async function deleteRole(schoolId: string, roleId: string): Promise<{ error: string | null }> {
  // Remove permissions first to avoid FK block
  await supabase.from('role_permissions').delete().eq('role_id', roleId)
  await supabase.from('staff_roles').delete().eq('role_id', roleId).eq('school_id', schoolId)
  const { error } = await supabase.from('roles').delete().eq('id', roleId).eq('school_id', schoolId)
  return { error: error?.message ?? null }
}

// ─── Student roles (Session 13, PRD Problem 5.5, §7.8a) ──────────────────────
// Definitional side only — "the role exists," admin-managed here. The
// per-student "who holds it" read/assign/unassign functions live in
// studentsService.ts instead (StudentRoleTag/loadStudentRoleTags/
// loadAssignableStudentRoles/assignStudentRole/unassignStudentRole), matching
// that file's own Result<T> convention rather than this file's {data,error}
// shape — same split roles/staff_roles never needed since staff assignment
// lives entirely in HRModule/hrService.ts, but student roles are assigned
// from StudentsModule, a different file than where they're defined.

export async function loadStudentRoles(schoolId: string): Promise<{ data: StudentRole[]; error: string | null }> {
  const { data, error } = await supabase
    .from('student_roles')
    .select('id, name, class_id')
    .eq('school_id', schoolId)
    .order('name', { ascending: true })

  if (error) return { data: [], error: error.message }

  const roles: StudentRole[] = (data ?? []).map((r) => ({
    id:       r.id as string,
    name:     r.name as string,
    class_id: r.class_id as string | null,
  }))

  return { data: roles, error: null }
}

export async function saveStudentRole(
  schoolId: string,
  role: { id?: string; name: string; class_id: string | null },
): Promise<{ error: string | null }> {
  if (role.id) {
    const { error } = await supabase
      .from('student_roles')
      .update({ name: role.name, class_id: role.class_id })
      .eq('id', role.id)
      .eq('school_id', schoolId)
    return { error: error?.message ?? null }
  }

  const { error } = await supabase
    .from('student_roles')
    .insert({ school_id: schoolId, name: role.name, class_id: role.class_id })

  return { error: error?.message ?? null }
}

export async function deleteStudentRole(schoolId: string, studentRoleId: string): Promise<{ error: string | null }> {
  // Remove assignments first to avoid FK block — same order as deleteRole
  // clearing role_permissions/staff_roles before the roles row itself.
  await supabase.from('student_role_assignments').delete().eq('student_role_id', studentRoleId)
  const { error } = await supabase.from('student_roles').delete().eq('id', studentRoleId).eq('school_id', schoolId)
  return { error: error?.message ?? null }
}

// ─── Staff (read-only list — edits live in HRModule) ─────────────────────────

export async function loadStaffWithRoles(schoolId: string): Promise<{ data: StaffListItem[]; error: string | null }> {
  const { data, error } = await supabase
    .from('staff')
    .select('id, full_name, email, phone, status, hire_date, staff_roles(roles(name))')
    .eq('school_id', schoolId)
    .order('full_name', { ascending: true })

  if (error) return { data: [], error: error.message }

  const items: StaffListItem[] = (data ?? []).map((s) => {
    const staffRoles = (s.staff_roles as unknown as { roles: { name: string }[] | { name: string } | null }[]) ?? []
    const roleNames = staffRoles.flatMap(sr => {
      const r = sr.roles
      if (!r) return []
      if (Array.isArray(r)) return r.map(x => x.name)
      return [r.name]
    })
    return {
      id: s.id as string,
      full_name: s.full_name as string,
      email: s.email as string | null,
      phone: s.phone as string | null,
      status: s.status as string,
      hire_date: s.hire_date as string | null,
      roles: roleNames,
    }
  })

  return { data: items, error: null }
}

// ─── Audit log ────────────────────────────────────────────────────────────────

export interface AuditFilters {
  table_name?: string
  action?: 'INSERT' | 'UPDATE' | 'DELETE'
  limit?: number
  offset?: number
}

export async function loadAuditLog(schoolId: string, filters: AuditFilters = {}): Promise<{ data: AuditEntry[]; count: number; error: string | null }> {
  let q = supabase
    .from('audit_log')
    .select('id, created_at, actor_id, actor_type, table_name, record_id, action, old_data, new_data', { count: 'exact' })
    .eq('school_id', schoolId)
    .order('created_at', { ascending: false })
    .limit(filters.limit ?? 50)

  if (filters.offset) q = q.range(filters.offset, (filters.offset ?? 0) + (filters.limit ?? 50) - 1)
  if (filters.table_name) q = q.eq('table_name', filters.table_name)
  if (filters.action) q = q.eq('action', filters.action)

  const { data, error, count } = await q

  if (error) return { data: [], count: 0, error: error.message }
  return { data: (data ?? []) as AuditEntry[], count: count ?? 0, error: null }
}

/** Returns the distinct table names that appear in the audit log for this school. */
export async function loadAuditTableNames(schoolId: string): Promise<string[]> {
  const { data } = await supabase
    .from('audit_log')
    .select('table_name')
    .eq('school_id', schoolId)

  if (!data) return []
  const names = new Set(data.map((r: { table_name: string }) => r.table_name))
  return Array.from(names).sort()
}
