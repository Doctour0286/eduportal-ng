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
 * Grade scale & CGPA policy exports (Session 59, PRD Tier 8 / Problem 8.7, §7.27.4):
 *   loadHigherEdGradeScale()    — this school's grade bands (grade_scales;
 *                                 extended, not new — shared with the
 *                                 secondary-school Results module)
 *   upsertHigherEdGradeBand()   — create/update one band
 *   deleteHigherEdGradeBand()   — remove one band (hard delete)
 *   loadCgpaPolicy()            — this school's CGPA policy (null if unconfigured —
 *                                 expected for an "Other"-category school, Decision 5)
 *   upsertCgpaPolicy()          — create/update the one-row-per-school policy
 *
 * Academic standing exports (Session 61, PRD Tier 8 / Problem 8.7, §7.27.5):
 *   loadAcademicStandingRules()   — this school's standing thresholds (null if
 *                                   unconfigured — expected for an "Other"-
 *                                   category school, Decision 5)
 *   upsertAcademicStandingRules() — create/update the one-row-per-school rules
 *
 * Course offering exports (unscheduled interim step before Session 60,
 * PRD Tier 8 / Problem 8.7 — closes the gap Session 58's close-out surfaced,
 * "no course_offerings creation UI exists anywhere"):
 *   loadCourseOfferings()  — offerings for a session (+ optional term), joined
 *                            to course code/title and lecturer name for display
 *   upsertCourseOffering() — create/update one offering ("this course, this
 *                            session/term, this lecturer")
 *   deleteCourseOffering() — remove one offering (hard delete)
 *   course_offerings carries no school_id column of its own — every function
 *   here relies on RLS (join through course_id -> courses.school_id, the
 *   real live policy, confirmed via direct SQL read before writing this
 *   section rather than assumed from the master plan's [STD] shorthand) as
 *   the sole scoping mechanism; there is no .eq('school_id', ...) to write.
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

export interface WelcomePostTextRun {
  text: string
  bold?: boolean
  italic?: boolean
}

/** Heading level is block-level (the whole line either is a heading or
 *  isn't), matching how every real block/rich-text editor treats
 *  headings (WordPress, dotCMS, Contentstack). H1 is deliberately not an
 *  option — the post's own heading field (and the school name above it)
 *  already fill that role; offering a second H1 in body content is a
 *  real accessibility/SEO anti-pattern (duplicate top-level heading),
 *  not just an unlikely case to skip. 'p' = normal text. */
export type WelcomePostTextLevel = 'p' | 'h2' | 'h3' | 'h4'

export interface WelcomePostTextBlock {
  type: 'text'
  level: WelcomePostTextLevel
  /** Bold/italic are inline "runs" within one text block, not a
   *  block-level flag — matches the standard {text, marks} rich-text
   *  shape (Contentstack/Sanity/Payload all model bold/italic this way)
   *  since a real sentence often needs a bold word mid-run, not the
   *  whole line bolded. */
  runs: WelcomePostTextRun[]
}

export interface WelcomePostImageBlock {
  type: 'image'
  url: string
  caption?: string
}

export type WelcomePostBlock = WelcomePostTextBlock | WelcomePostImageBlock

/** Legacy shape saved before the rich-text upgrade (2026-07-11 follow-up
 *  #3) — a block used to be exactly { type: 'paragraph', text: string }.
 *  Never migrated destructively in the database; instead every read path
 *  normalizes through this so old posts keep rendering exactly as
 *  before (plain, unstyled paragraph) without a one-time migration
 *  script or any risk of silently losing old content. */
interface LegacyParagraphBlock {
  type: 'paragraph'
  text: string
}

export function normalizeBlock(raw: WelcomePostBlock | LegacyParagraphBlock): WelcomePostBlock {
  if ((raw as LegacyParagraphBlock).type === 'paragraph') {
    const legacy = raw as LegacyParagraphBlock
    return { type: 'text', level: 'p', runs: [{ text: legacy.text }] }
  }
  return raw as WelcomePostBlock
}

export function normalizeBlocks(raw: unknown): WelcomePostBlock[] {
  if (!Array.isArray(raw)) return []
  return raw.map(normalizeBlock)
}

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

// ─── Institution hierarchy (§7.27.1, PRD SESSION 55) ──────────────────────
// Deliberately separate from ClassNode/class_nodes — see §7.27.1's own note:
// programme_levels is administrative metadata a student's course
// registrations cluster under, not a live daily container. Post-onboarding
// admin UI for these lives in InstitutionTab, hidden unless school_type is a
// higher-institution category (see SettingsModule.tsx).

export interface Faculty {
  id: string
  name: string
  code: string | null
}

export interface Department {
  id: string
  name: string
  code: string | null
  faculty_id: string | null
}

export interface Programme {
  id: string
  name: string
  // SESSION 65 (PRD Problem 8.7a, items 1/7) — real schema gap closed here:
  // programmes had no code column at all (only faculties.code/
  // departments.code existed, §7.27.1), needed since "programme code" is
  // one of the owner's explicitly-named matric-number-format components.
  // Nullable — a school that never uses this component just leaves it blank.
  code: string | null
  award_type: string
  department_id: string
  duration_sessions: number
  min_credit_load: number | null
  max_credit_load: number | null
  // Matric sequence scope follow-up (owner request) — nullable override of
  // the school's matric_sequence_scope_default (schools table, read via
  // admissionService.ts's loadAdmissionMasterSettings()). Null = inherit the
  // school default; this column deliberately never defaults to 'programme'
  // at the DB level so a programme with no explicit choice keeps tracking
  // whatever the school's default becomes later, rather than freezing.
  // Typed as the raw string union here rather than importing
  // MatricSequenceScope from admissionService.ts, to avoid a cross-module
  // type dependency for one field — kept in sync manually, same as
  // award_type's own free-string treatment above.
  matric_sequence_scope: 'programme' | 'school' | null
}

export interface ProgrammeLevel {
  id: string
  programme_id: string
  level_label: string
  sequence_order: number
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
  if (!data) {
    return { data: { welcome_message: null, welcome_post: null, contact_info: null, show_announcements: true }, error: null }
  }
  const raw = data.welcome_post as { heading?: string; blocks?: unknown } | null
  return {
    data: {
      ...(data as SchoolPublicConfig),
      welcome_post: raw ? { heading: raw.heading ?? '', blocks: normalizeBlocks(raw.blocks) } : null,
    },
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

// ─── School logo upload (owner request, 2026-07-11 follow-up) ─────────────
//
// Before this: "Logo" in the School tab was a plain text URL input — the
// admin had to already have the image hosted elsewhere and paste a link
// in by hand. logo_url is read downstream in five places (public
// homepage header, login page brand strip, app header chrome, App.tsx's
// school-lookup skeleton, and the student ID card print feature via
// schoolLogoUrl) — all as a plain <img src={...}>, none of them caring
// how the URL got there. That's what makes this safe to upgrade without
// touching any downstream consumer: this still just writes a public URL
// string into the same schools.logo_url column.
//
// Own bucket (school-logos, see school_logos_bucket_setup.sql) rather
// than reusing school-homepage-images — a logo is school-identity
// content, not homepage-post content, and shouldn't share a path prefix
// with ad-hoc post images an admin might later bulk-manage or delete.
//
// Smaller max dimension than homepage post images (a logo only ever
// renders at avatar/header sizes, never hero-image size) and PNG instead
// of JPEG — a real school badge/crest logo very often has transparency,
// and JPEG would silently flatten that to a white or black square.

const LOGO_MAX_DIMENSION = 512

async function resizeLogoToBlob(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, LOGO_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height))
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
      'image/png'
    )
  })
}

/**
 * Uploads a school logo and returns its public URL. Mirrors
 * uploadWelcomePostImage's proven pattern (client-side resize, public
 * bucket, public URL returned) — same "always resize, no exceptions"
 * exception to this file's general no-browser-only-APIs convention.
 * upsert:true (unlike uploadWelcomePostImage) since a logo is a single
 * per-school identity asset the admin replaces, not an accumulating list
 * of post images — old objects under this school's folder are harmless
 * leftovers, not a correctness issue, so no cleanup step is added here.
 */
export async function uploadSchoolLogo(
  schoolId: string,
  file: File
): Promise<{ url: string | null; error: string | null }> {
  try {
    const blob = await resizeLogoToBlob(file)
    const filename = `logo-${Date.now()}.png`
    const path = `${schoolId}/${filename}`

    const { error: uploadErr } = await supabase.storage
      .from('school-logos')
      .upload(path, blob, { contentType: 'image/png', upsert: true })

    if (uploadErr) return { url: null, error: uploadErr.message }

    const { data } = supabase.storage.from('school-logos').getPublicUrl(path)
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
  return {
    data: (data ?? []).map(row => ({ ...row, blocks: normalizeBlocks(row.blocks) })) as HomepagePost[],
    error: null,
  }
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

// ─── Institution hierarchy: faculties → departments → programmes → levels ─
// §7.27.1. Same {id?} upsert shape as upsertClassNode above, for consistency.

export async function loadFaculties(schoolId: string): Promise<{ data: Faculty[]; error: string | null }> {
  const { data, error } = await supabase
    .from('faculties')
    .select('id, name, code')
    .eq('school_id', schoolId)
    .order('name', { ascending: true })
  if (error) return { data: [], error: error.message }
  return { data: (data ?? []) as Faculty[], error: null }
}

export async function upsertFaculty(
  schoolId: string,
  faculty: { id?: string; name: string; code?: string | null },
): Promise<{ error: string | null }> {
  if (faculty.id) {
    const { error } = await supabase
      .from('faculties')
      .update({ name: faculty.name, code: faculty.code ?? null, updated_at: new Date().toISOString() })
      .eq('id', faculty.id)
      .eq('school_id', schoolId)
    return { error: error?.message ?? null }
  }
  const { error } = await supabase
    .from('faculties')
    .insert({ school_id: schoolId, name: faculty.name, code: faculty.code ?? null })
  return { error: error?.message ?? null }
}

export async function loadDepartments(schoolId: string): Promise<{ data: Department[]; error: string | null }> {
  const { data, error } = await supabase
    .from('departments')
    .select('id, name, code, faculty_id')
    .eq('school_id', schoolId)
    .order('name', { ascending: true })
  if (error) return { data: [], error: error.message }
  return { data: (data ?? []) as Department[], error: null }
}

export async function upsertDepartment(
  schoolId: string,
  department: { id?: string; name: string; code?: string | null; faculty_id: string | null },
): Promise<{ error: string | null }> {
  if (department.id) {
    const { error } = await supabase
      .from('departments')
      .update({
        name: department.name,
        code: department.code ?? null,
        faculty_id: department.faculty_id,
        updated_at: new Date().toISOString(),
      })
      .eq('id', department.id)
      .eq('school_id', schoolId)
    return { error: error?.message ?? null }
  }
  const { error } = await supabase
    .from('departments')
    .insert({
      school_id: schoolId,
      name: department.name,
      code: department.code ?? null,
      faculty_id: department.faculty_id,
    })
  return { error: error?.message ?? null }
}

export async function loadProgrammes(schoolId: string): Promise<{ data: Programme[]; error: string | null }> {
  const { data, error } = await supabase
    .from('programmes')
    .select('id, name, code, award_type, department_id, duration_sessions, min_credit_load, max_credit_load, matric_sequence_scope')
    .eq('school_id', schoolId)
    .order('name', { ascending: true })
  if (error) return { data: [], error: error.message }
  return { data: (data ?? []) as Programme[], error: null }
}

export async function upsertProgramme(
  schoolId: string,
  programme: {
    id?: string
    name: string
    code?: string | null
    award_type: string
    department_id: string
    duration_sessions: number
    min_credit_load?: number | null
    max_credit_load?: number | null
    // Optional, and deliberately left out of payload when omitted (see
    // below) rather than coalesced to null — callers that don't pass this
    // key (e.g. any pre-existing call site not yet updated for this field)
    // must not accidentally clear a programme's existing override on every
    // unrelated save.
    matric_sequence_scope?: 'programme' | 'school' | null
  },
): Promise<{ error: string | null }> {
  const payload: Record<string, unknown> = {
    name: programme.name,
    code: programme.code ?? null,
    award_type: programme.award_type,
    department_id: programme.department_id,
    duration_sessions: programme.duration_sessions,
    min_credit_load: programme.min_credit_load ?? null,
    max_credit_load: programme.max_credit_load ?? null,
  }
  if ('matric_sequence_scope' in programme) {
    payload.matric_sequence_scope = programme.matric_sequence_scope ?? null
  }
  if (programme.id) {
    const { error } = await supabase
      .from('programmes')
      .update({ ...payload, updated_at: new Date().toISOString() })
      .eq('id', programme.id)
      .eq('school_id', schoolId)
    return { error: error?.message ?? null }
  }
  const { error } = await supabase
    .from('programmes')
    .insert({ school_id: schoolId, ...payload })
  return { error: error?.message ?? null }
}

// programme_levels has no school_id of its own (per §7.27.1) — school
// scoping for writes is enforced by RLS via the programme_id join (see
// migration_session_55.sql), matching role_permissions' own pattern.
// §7.27.1a — student_programme_placements. Admits a student into a specific
// programme level for a given session. History table (not a direct FK on
// students), per the owner's explicit decision: `class_node_id` (§7.5) is a
// bare overwritten FK with no history table behind it anywhere, and this
// school has a real, stated need for retroactive "what level was this
// student in last session" lookups that a direct FK would silently lose.
export interface StudentSearchResult {
  id: string
  full_name: string
  matric_number: string | null
}

export interface StudentProgrammePlacement {
  id: string
  student_id: string
  student_name: string
  student_matric_number: string | null
  programme_level_id: string
  session_id: string
  is_current: boolean
}

export async function loadProgrammeLevels(programmeId: string): Promise<{ data: ProgrammeLevel[]; error: string | null }> {
  const { data, error } = await supabase
    .from('programme_levels')
    .select('id, programme_id, level_label, sequence_order')
    .eq('programme_id', programmeId)
    .order('sequence_order', { ascending: true })
  if (error) return { data: [], error: error.message }
  return { data: (data ?? []) as ProgrammeLevel[], error: null }
}

export async function upsertProgrammeLevel(
  level: { id?: string; programme_id: string; level_label: string; sequence_order: number },
): Promise<{ error: string | null }> {
  if (level.id) {
    const { error } = await supabase
      .from('programme_levels')
      .update({ level_label: level.level_label, sequence_order: level.sequence_order })
      .eq('id', level.id)
    return { error: error?.message ?? null }
  }
  const { error } = await supabase
    .from('programme_levels')
    .insert({ programme_id: level.programme_id, level_label: level.level_label, sequence_order: level.sequence_order })
  return { error: error?.message ?? null }
}

// Current session for a school — used to default the placement form and to
// gate it off entirely when no session is set, rather than inventing one.
export async function loadCurrentSession(schoolId: string): Promise<{ data: Session | null; error: string | null }> {
  const { data, error } = await supabase
    .from('sessions')
    .select('id, name, start_date, end_date, is_current')
    .eq('school_id', schoolId)
    .eq('is_current', true)
    .maybeSingle()
  if (error) return { data: null, error: error.message }
  return { data: (data ?? null) as Session | null, error: null }
}

// Debounced type-to-search over this school's own students only — a plain
// dropdown doesn't scale past a few dozen students, so this mirrors the
// search-as-you-type pattern used elsewhere for large lists, rather than
// the load-everything-then-filter pattern this file uses for small ones
// (staff, class nodes).
export async function searchStudents(
  schoolId: string,
  query: string,
): Promise<{ data: StudentSearchResult[]; error: string | null }> {
  const { data, error } = await supabase
    .from('students')
    .select('id, full_name, matric_number')
    .eq('school_id', schoolId)
    .or(`full_name.ilike.%${query}%,matric_number.ilike.%${query}%`)
    .order('full_name', { ascending: true })
    .limit(20)
  if (error) return { data: [], error: error.message }
  return { data: (data ?? []) as StudentSearchResult[], error: null }
}

// Currently-placed students for one programme level — the admin's day-to-day
// view ("who's placed into this level right now"). Historical placements
// stay queryable directly via SQL per the PRD's Done Check; this deliberately
// only surfaces is_current rows.
export async function loadPlacementsForProgramme(
  programmeLevelId: string,
): Promise<{ data: StudentProgrammePlacement[]; error: string | null }> {
  const { data, error } = await supabase
    .from('student_programme_placements')
    .select('id, student_id, programme_level_id, session_id, is_current, students(full_name, matric_number)')
    .eq('programme_level_id', programmeLevelId)
    .eq('is_current', true)
  if (error) return { data: [], error: error.message }
  // Joined relations cast through unknown → array before plucking [0], per
  // this file's own established convention (see header comment).
  const mapped = (data ?? []).map((row: any) => {
    const student = (Array.isArray(row.students) ? row.students[0] : row.students) as
      | { full_name: string; matric_number: string | null }
      | undefined
    return {
      id: row.id,
      student_id: row.student_id,
      student_name: student?.full_name ?? 'Unknown student',
      student_matric_number: student?.matric_number ?? null,
      programme_level_id: row.programme_level_id,
      session_id: row.session_id,
      is_current: row.is_current,
    }
  })
  return { data: mapped as StudentProgrammePlacement[], error: null }
}

// Admits a student into a programme level for a session. Demotes any prior
// current placement for that student first — same demote-then-insert shape
// as sessions.is_current — rather than relying on the DB's partial-unique
// index alone to reject a second concurrent "current" row.
export async function upsertPlacement(placement: {
  school_id: string
  student_id: string
  programme_level_id: string
  session_id: string
}): Promise<{ error: string | null }> {
  const { error: demoteError } = await supabase
    .from('student_programme_placements')
    .update({ is_current: false })
    .eq('student_id', placement.student_id)
    .eq('is_current', true)
  if (demoteError) return { error: demoteError.message }

  const { error } = await supabase
    .from('student_programme_placements')
    .insert({
      school_id: placement.school_id,
      student_id: placement.student_id,
      programme_level_id: placement.programme_level_id,
      session_id: placement.session_id,
      is_current: true,
    })
  return { error: error?.message ?? null }
}

// SESSION 64 (PRD Problem 8.7a) — the missing "student → their own current
// placement" read. Every existing placement function above goes the other
// direction (level → its currently-placed students, for InstitutionTab's own
// admin view); nothing previously answered "what is THIS student's current
// programme/level" for use outside that tab. This is the read
// StudentsModule.tsx's Brief/Status tabs and studentsService.ts's higher-ed
// query branch both need, so it lives here rather than being duplicated —
// same "one implementation, not two" discipline gpaService.ts already
// established. Joins through to `programmes`/`programme_levels` for real
// display names (a bare programme_level_id is useless in a UI), and includes
// `programme_duration_sessions`/`level_sequence_order` even though this
// session's own scope doesn't need them yet — SESSION 69's promotion flow
// will, and re-deriving the same join a second time there would repeat
// exactly the "same read written twice" mistake this file's own header
// discipline warns against.
export interface StudentCurrentPlacement {
  placement_id: string
  programme_level_id: string
  level_label: string
  level_sequence_order: number
  programme_id: string
  programme_name: string
  programme_duration_sessions: number
  session_id: string
}

export async function loadStudentCurrentPlacement(
  studentId: string,
): Promise<{ data: StudentCurrentPlacement | null; error: string | null }> {
  const { data, error } = await supabase
    .from('student_programme_placements')
    .select(`
      id,
      programme_level_id,
      session_id,
      programme_levels!inner(
        level_label,
        sequence_order,
        programmes!inner(id, name, duration_sessions)
      )
    `)
    .eq('student_id', studentId)
    .eq('is_current', true)
    .maybeSingle()

  if (error) return { data: null, error: error.message }
  if (!data) return { data: null, error: null }  // no current placement — a normal, real state (not yet admitted, or between placements), not an error

  // Joined relations cast through unknown → array before plucking [0], per
  // this file's own established convention (see header comment) — a nested
  // !inner join still arrives as an array-or-object depending on the
  // Supabase client version, same caveat loadPlacementsForProgramme() above
  // already documents for its own single-level join.
  const level = (Array.isArray((data as any).programme_levels) ? (data as any).programme_levels[0] : (data as any).programme_levels) as
    | { level_label: string; sequence_order: number; programmes: any }
    | undefined
  if (!level) return { data: null, error: 'Placement row found but its programme level could not be resolved.' }
  const programme = (Array.isArray(level.programmes) ? level.programmes[0] : level.programmes) as
    | { id: string; name: string; duration_sessions: number }
    | undefined
  if (!programme) return { data: null, error: 'Placement row found but its programme could not be resolved.' }

  return {
    data: {
      placement_id: (data as any).id,
      programme_level_id: (data as any).programme_level_id,
      level_label: level.level_label,
      level_sequence_order: level.sequence_order,
      programme_id: programme.id,
      programme_name: programme.name,
      programme_duration_sessions: programme.duration_sessions,
      session_id: (data as any).session_id,
    },
    error: null,
  }
}

// ─── Matric number format & admission ──────────────────────────────────────
// Moved to admissionService.ts (SESSION 65 correction pass, §12 decision
// 2026-07-17): admission is a high-frequency operational workflow, not an
// institution-structure config concern, and sharing this file's load
// lifecycle / permission key with faculties-departments-programmes editing
// was a real mismatch, not just organization — see MASTER_PLAN.md §12 for
// the full reasoning. loadMatricNumberFormat/saveMatricNumberFormat/
// admitStudent and their types now live there.

// ─── Course catalogue & curriculum (§7.27.2, PRD SESSION 56) ──────────────
// courses is school-wide institutional metadata, scoped by school_id +
// department_id, the same shape as Faculty/Department/Programme above — a
// course exists independently of any one curriculum and is reused across
// many. programme_curriculum is the assignment of a course into a specific
// programme/level/term with a requirement_type and optional prerequisite;
// deliberately its own concern (see SettingsModule.tsx's CurriculumTab),
// mirroring the same "definition vs. per-target assignment" split already
// drawn between ProgrammeLevel (definition) and StudentProgrammePlacement
// (assignment) above.

export interface Course {
  id: string
  school_id: string
  department_id: string
  code: string
  title: string
  credit_units: number
  course_type: string | null
}

export interface CurriculumEntry {
  id: string
  programme_id: string
  programme_level_id: string
  course_id: string
  course_code: string
  course_title: string
  credit_units: number
  term_id: string | null
  requirement_type: 'core' | 'elective'
  prerequisite_course_id: string | null
  prerequisite_course_code: string | null
}

export async function loadCourses(schoolId: string): Promise<{ data: Course[]; error: string | null }> {
  const { data, error } = await supabase
    .from('courses')
    .select('id, school_id, department_id, code, title, credit_units, course_type')
    .eq('school_id', schoolId)
    .order('code', { ascending: true })
  if (error) return { data: [], error: error.message }
  return { data: (data ?? []) as Course[], error: null }
}

export async function upsertCourse(
  schoolId: string,
  course: {
    id?: string
    department_id: string
    code: string
    title: string
    credit_units: number
    course_type?: string | null
  },
): Promise<{ error: string | null }> {
  const payload = {
    department_id: course.department_id,
    code: course.code,
    title: course.title,
    credit_units: course.credit_units,
    course_type: course.course_type ?? null,
  }
  if (course.id) {
    const { error } = await supabase
      .from('courses')
      .update({ ...payload, updated_at: new Date().toISOString() })
      .eq('id', course.id)
      .eq('school_id', schoolId)
    return { error: error?.message ?? null }
  }
  const { error } = await supabase
    .from('courses')
    .insert({ school_id: schoolId, ...payload })
  return { error: error?.message ?? null }
}

// Curriculum rows for one programme level, optionally scoped to a term (for
// schools with uses_terms = true). When termId is null, rows with a null
// term_id are read — matching term_id's own "falls back to session_id when
// uses_terms = false" convention (§7.4): a term-less school's curriculum is
// simply not term-partitioned.
export async function loadCurriculum(
  programmeLevelId: string,
  termId: string | null,
): Promise<{ data: CurriculumEntry[]; error: string | null }> {
  let query = supabase
    .from('programme_curriculum')
    .select(`
      id, programme_id, programme_level_id, course_id, term_id, requirement_type, prerequisite_course_id,
      courses!programme_curriculum_course_id_fkey(code, title, credit_units),
      prerequisite:courses!programme_curriculum_prerequisite_course_id_fkey(code)
    `)
    .eq('programme_level_id', programmeLevelId)
  query = termId ? query.eq('term_id', termId) : query.is('term_id', null)
  const { data, error } = await query.order('created_at', { ascending: true })
  if (error) return { data: [], error: error.message }
  // Joined relations cast through unknown → array before plucking [0], per
  // this file's own established convention (see header comment).
  const mapped = (data ?? []).map((row: any) => {
    const course = (Array.isArray(row.courses) ? row.courses[0] : row.courses) as
      | { code: string; title: string; credit_units: number }
      | undefined
    const prereq = (Array.isArray(row.prerequisite) ? row.prerequisite[0] : row.prerequisite) as
      | { code: string }
      | undefined
    return {
      id: row.id,
      programme_id: row.programme_id,
      programme_level_id: row.programme_level_id,
      course_id: row.course_id,
      course_code: course?.code ?? '—',
      course_title: course?.title ?? 'Unknown course',
      credit_units: course?.credit_units ?? 0,
      term_id: row.term_id,
      requirement_type: row.requirement_type,
      prerequisite_course_id: row.prerequisite_course_id,
      prerequisite_course_code: prereq?.code ?? null,
    }
  })
  return { data: mapped as CurriculumEntry[], error: null }
}

export async function addCurriculumEntry(entry: {
  programme_id: string
  programme_level_id: string
  course_id: string
  term_id: string | null
  requirement_type: 'core' | 'elective'
  prerequisite_course_id?: string | null
}): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from('programme_curriculum')
    .insert({
      programme_id: entry.programme_id,
      programme_level_id: entry.programme_level_id,
      course_id: entry.course_id,
      term_id: entry.term_id,
      requirement_type: entry.requirement_type,
      prerequisite_course_id: entry.prerequisite_course_id ?? null,
    })
  return { error: error?.message ?? null }
}

export async function removeCurriculumEntry(curriculumEntryId: string): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from('programme_curriculum')
    .delete()
    .eq('id', curriculumEntryId)
  return { error: error?.message ?? null }
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

// ─── Grade scale & CGPA policy (PRD Tier 8 / Problem 8.7, SESSION 59, §7.27.4) ─
//
// grade_scales is NOT a new table — it already existed for the secondary-school
// Results module (school_id, min_score, max_score, grade_label, remark,
// sort_order; see resultsService.ts's loadGradeScale()). SESSION 59 extended it
// with two new nullable columns (scale_max, grade_point) for the higher-ed
// shape, rather than creating a second colliding table — see master-plan
// §7.27.4 for the full reconciliation record. A higher-ed grade band therefore
// reuses grade_label as "the letter," min_score/max_score as the pct bounds,
// and additionally sets scale_max/grade_point — the same row shape a
// secondary-school band uses, just with two more fields populated.
//
// cgpa_policy is genuinely new (Phase 0 Decision 2) — one row per school,
// unique on school_id. Per Decision 5, an "Other"-category school (this real
// school's own category) gets NO smart default pre-filled for rollup_method/
// retake_treatment — loadCgpaPolicy() returning { data: null } is a normal,
// expected "not configured yet" state, not an error.

export interface GradeScaleBand {
  id: string
  min_score: number   // higher-ed: min_pct
  max_score: number   // higher-ed: max_pct
  grade_label: string // higher-ed: the letter grade
  remark: string | null
  sort_order: number
  scale_max: number | null   // null on pre-existing secondary-school rows
  grade_point: number | null // null on pre-existing secondary-school rows
  /**
   * Explicit, school-configured pass/fail designation (migration
   * session_62pre_carryover_flip.sql). Deliberately NOT inferred from
   * grade_point > 0 anywhere downstream — see gpaService.ts's GradeBand.is_passing
   * doc for the worked example (a D at grade_point 1.0 that should still
   * fail a program's higher minimum) that this column exists to fix.
   * null only for pre-existing secondary-school rows this column doesn't
   * apply to (grade_point/scale_max are null on those same rows) — a
   * higher-ed row should always have a real true/false here after the
   * migration's backfill, but the type stays nullable so a genuine gap
   * surfaces instead of silently coercing to false.
   */
  is_passing: boolean | null
}

export async function loadHigherEdGradeScale(schoolId: string): Promise<{ data: GradeScaleBand[]; error: string | null }> {
  const { data, error } = await supabase
    .from('grade_scales')
    .select('id, min_score, max_score, grade_label, remark, sort_order, scale_max, grade_point, is_passing')
    .eq('school_id', schoolId)
    .order('sort_order', { ascending: true })

  if (error) return { data: [], error: error.message }
  return {
    data: (data ?? []).map((g: any) => ({
      id: g.id,
      min_score: Number(g.min_score),
      max_score: Number(g.max_score),
      grade_label: g.grade_label,
      remark: g.remark ?? null,
      sort_order: g.sort_order,
      scale_max: g.scale_max === null ? null : Number(g.scale_max),
      grade_point: g.grade_point === null ? null : Number(g.grade_point),
      is_passing: g.is_passing === null ? null : Boolean(g.is_passing),
    })),
    error: null,
  }
}

export async function upsertHigherEdGradeBand(
  schoolId: string,
  band: {
    id?: string
    min_score: number
    max_score: number
    grade_label: string
    grade_point: number
    scale_max: number
    remark?: string | null
    sort_order: number
    is_passing: boolean
  },
): Promise<{ error: string | null }> {
  const payload = {
    min_score: band.min_score,
    max_score: band.max_score,
    grade_label: band.grade_label,
    grade_point: band.grade_point,
    scale_max: band.scale_max,
    remark: band.remark ?? null,
    sort_order: band.sort_order,
    is_passing: band.is_passing,
  }
  if (band.id) {
    const { error } = await supabase
      .from('grade_scales')
      .update(payload)
      .eq('id', band.id)
      .eq('school_id', schoolId)
    return { error: error?.message ?? null }
  }
  const { error } = await supabase
    .from('grade_scales')
    .insert({ school_id: schoolId, ...payload })
  return { error: error?.message ?? null }
}

// Catalogue/config data, not a person or financial record — real hard delete,
// same carve-out this file's header rule already documents for periods/roles/
// student roles (§7.8a's deleteStudentRole is the precedent cited there).
export async function deleteHigherEdGradeBand(schoolId: string, bandId: string): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from('grade_scales')
    .delete()
    .eq('id', bandId)
    .eq('school_id', schoolId)
  return { error: error?.message ?? null }
}

export interface CgpaPolicy {
  id: string
  rollup_method: 'weighted_all_attempts' | 'average_of_semester_gpas'
  retake_treatment: 'replacement' | 'dilution'
  min_credit_load: number | null
  max_credit_load: number | null
}

// Returns { data: null } when the school has never configured this — a real,
// expected state for an "Other"-category school per Phase 0 Decision 5, not
// an error to surface as one. cgpa_policy.school_id is unique, so at most one
// row can ever exist.
export async function loadCgpaPolicy(schoolId: string): Promise<{ data: CgpaPolicy | null; error: string | null }> {
  const { data, error } = await supabase
    .from('cgpa_policy')
    .select('id, rollup_method, retake_treatment, min_credit_load, max_credit_load')
    .eq('school_id', schoolId)
    .maybeSingle()

  if (error) return { data: null, error: error.message }
  return { data: data as CgpaPolicy | null, error: null }
}

export async function upsertCgpaPolicy(
  schoolId: string,
  policy: {
    rollup_method: 'weighted_all_attempts' | 'average_of_semester_gpas'
    retake_treatment: 'replacement' | 'dilution'
    min_credit_load: number | null
    max_credit_load: number | null
  },
): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from('cgpa_policy')
    .upsert(
      {
        school_id: schoolId,
        rollup_method: policy.rollup_method,
        retake_treatment: policy.retake_treatment,
        min_credit_load: policy.min_credit_load,
        max_credit_load: policy.max_credit_load,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'school_id' },
    )
  return { error: error?.message ?? null }
}

// academic_standing_rules is the SESSION 61 counterpart to cgpa_policy —
// same shape (one row per school, unique on school_id), same Decision 5
// discipline: no threshold here is ever smart-defaulted, and
// loadAcademicStandingRules() returning { data: null } is a normal
// "not configured yet" state for an "Other"-category school, not an error.
// See master-plan §7.27.5 — every field school-configured, none hardcoded,
// per Problem 8.7's own "10 variations" research finding on this exact
// policy family.

export interface AcademicStandingRules {
  id: string
  probation_cgpa_threshold: number | null
  withdrawal_cgpa_threshold: number | null
  max_carryover_courses_before_review: number | null
  max_registration_multiplier: number | null
}

export async function loadAcademicStandingRules(schoolId: string): Promise<{ data: AcademicStandingRules | null; error: string | null }> {
  const { data, error } = await supabase
    .from('academic_standing_rules')
    .select('id, probation_cgpa_threshold, withdrawal_cgpa_threshold, max_carryover_courses_before_review, max_registration_multiplier')
    .eq('school_id', schoolId)
    .maybeSingle()

  if (error) return { data: null, error: error.message }
  return { data: data as AcademicStandingRules | null, error: null }
}

export async function upsertAcademicStandingRules(
  schoolId: string,
  rules: {
    probation_cgpa_threshold: number | null
    withdrawal_cgpa_threshold: number | null
    max_carryover_courses_before_review: number | null
    max_registration_multiplier: number | null
  },
): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from('academic_standing_rules')
    .upsert(
      {
        school_id: schoolId,
        probation_cgpa_threshold: rules.probation_cgpa_threshold,
        withdrawal_cgpa_threshold: rules.withdrawal_cgpa_threshold,
        max_carryover_courses_before_review: rules.max_carryover_courses_before_review,
        max_registration_multiplier: rules.max_registration_multiplier,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'school_id' },
    )
  return { error: error?.message ?? null }
}

// ─── SESSION 62 — Session-end evaluation flow + admin review queue ─────────
// (PRD Tier 8 / Problem 8.7, §7.27.5). Reads academic_standing_rules
// (above) and student_gpa_snapshots/course_registrations/
// student_programme_placements/programmes, and writes review-pending rows
// into academic_standing_events. Never flips a student's standing
// directly, never writes anything but a pending event — the actual
// standing change is a human decision recorded via reviewStandingEvent()
// below, per this table's own explicit "never silent, always
// human-reviewed" design (§7.27.5).
//
// Formula, grounded directly in real schema + real NUC-cited research
// (not assumed) — see PRD SESSION 62's card / PRD Log for the full
// research trail:
//   - probation: latest running CGPA (student_gpa_snapshots, term_id is
//     null row) < probation_cgpa_threshold.
//   - spillover: distinct count(session_id) across ALL of a student's
//     student_programme_placements rows (their full placement history,
//     not just the current row — a student placed in sessions A..F has
//     genuinely been enrolled across every one of them) exceeds
//     programmes.duration_sessions × max_registration_multiplier. This
//     mirrors the real, named NUC "maximum residency" rule (1.5x normal
//     programme duration) — school-configured via max_registration_multiplier,
//     never hardcoded to 1.5.
//   - max_carryover_courses_before_review does NOT generate its own
//     standing event or its own `standing` value — research found no
//     institution treating "too many carryovers" as a clean, independent
//     trigger decoupled from CGPA; every source describes it as
//     contributing pressure toward a CGPA-driven probation, or as an
//     administrative monitoring signal, not a standalone category. It is
//     folded into whichever event (probation or spillover) already fires
//     for that student, added as review context in that event's `note`
//     — never a trigger on its own, and generates nothing if a student
//     is over this threshold while CGPA and residency are both fine
//     (a real, deliberate, documented gap — see PRD SESSION 62's card).

export interface StandingEvaluationResult {
  studentsEvaluated: number
  eventsCreated: number
  /** Students who already had an unreviewed pending event for this
   *  session-standing pair — skipped, not duplicated. See the
   *  idempotency note on runStandingEvaluation() below. */
  skippedAlreadyPending: number
}

export interface StandingEvent {
  id: string
  student_id: string
  student_name: string
  matric_number: string | null
  session_id: string
  session_name: string
  standing: 'good_standing' | 'probation' | 'spillover' | 'withdrawal_recommended'
  cgpa_at_evaluation: number | null
  triggered_by: string | null
  note: string | null
  reviewed_by: string | null
  reviewed_at: string | null
  created_at: string
}

/**
 * Runs the session-end evaluation for every active student in the
 * school's current session, comparing their latest CGPA and residency
 * duration against academic_standing_rules, and inserting a
 * review-pending academic_standing_events row for anyone who trips a
 * threshold. Never touches a student's standing directly — every row
 * this writes has reviewed_by/reviewed_at left null, per §7.27.5's
 * design; a human confirms via reviewStandingEvent() below.
 *
 * Idempotent per (student, session, standing): if a student already has
 * an UNREVIEWED event for the same session and standing, this does not
 * insert a duplicate — re-running the sweep after a partial review pass
 * doesn't flood the queue with repeats for cases already pending. A
 * student who was already reviewed and is evaluated again in a LATER
 * sweep (e.g. a subsequent session) can get a fresh event even for the
 * same standing value, since that's a new evaluation, not a duplicate
 * of an already-closed one.
 *
 * A student who trips neither threshold gets no event at all — 'good_standing'
 * is a real value in the check constraint but this function deliberately
 * never writes it: a non-event (nothing pending) already means "nothing
 * to review," and manufacturing a 'good_standing' row for every
 * unflagged student every sweep would make the events table an
 * every-student-every-sweep audit log rather than a review queue,
 * working against its own purpose.
 */
export async function runStandingEvaluation(schoolId: string): Promise<{ data: StandingEvaluationResult | null; error: string | null }> {
  const rulesRes = await loadAcademicStandingRules(schoolId)
  if (rulesRes.error) return { data: null, error: rulesRes.error }
  const rules = rulesRes.data
  if (!rules || (rules.probation_cgpa_threshold === null && rules.max_registration_multiplier === null)) {
    return { data: null, error: 'No academic standing thresholds are configured for this school yet. Set at least one threshold in Academic Standing settings before running an evaluation.' }
  }

  const sessionRes = await supabase
    .from('sessions')
    .select('id, name')
    .eq('school_id', schoolId)
    .eq('is_current', true)
    .maybeSingle()
  if (sessionRes.error) return { data: null, error: sessionRes.error.message }
  if (!sessionRes.data) return { data: null, error: 'No current session is set for this school — set one in Sessions settings first.' }
  const currentSessionId = sessionRes.data.id as string

  // Every active student currently placed into a programme (join through
  // student_programme_placements' is_current row, same resolution path
  // courseRegistrationService.ts's loadCurriculum() already uses — not a
  // re-derivation, the confirmed-correct join per SESSION 57's own
  // fan-out lesson).
  const placementsRes = await supabase
    .from('student_programme_placements')
    .select('student_id, programme_level_id, students!inner(id, full_name, matric_number, status, school_id)')
    .eq('is_current', true)
    .eq('students.school_id', schoolId)
    .eq('students.status', 'active')
  if (placementsRes.error) return { data: null, error: placementsRes.error.message }

  const currentPlacements = (placementsRes.data ?? []) as any[]
  if (currentPlacements.length === 0) {
    return { data: { studentsEvaluated: 0, eventsCreated: 0, skippedAlreadyPending: 0 }, error: null }
  }

  // Resolve each current placement's programme (for duration_sessions) —
  // one batched query, not N+1: programme_levels -> programmes.
  const levelIds = Array.from(new Set(currentPlacements.map((p) => p.programme_level_id)))
  const levelsRes = await supabase
    .from('programme_levels')
    .select('id, programme_id, programmes(id, duration_sessions)')
    .in('id', levelIds)
  if (levelsRes.error) return { data: null, error: levelsRes.error.message }
  const durationByLevelId = new Map<string, number | null>()
  for (const l of (levelsRes.data ?? []) as any[]) {
    const programme = Array.isArray(l.programmes) ? l.programmes[0] : l.programmes
    durationByLevelId.set(l.id, programme?.duration_sessions ?? null)
  }

  // Full placement history (every row, not just is_current) for every
  // student being evaluated, to count distinct sessions actually
  // enrolled across — the real residency-duration signal, not just
  // "how many sessions since their current placement."
  const studentIds = currentPlacements.map((p) => p.student_id as string)
  const historyRes = await supabase
    .from('student_programme_placements')
    .select('student_id, session_id')
    .in('student_id', studentIds)
  if (historyRes.error) return { data: null, error: historyRes.error.message }
  const sessionsByStudent = new Map<string, Set<string>>()
  for (const row of (historyRes.data ?? []) as any[]) {
    const set = sessionsByStudent.get(row.student_id) ?? new Set<string>()
    set.add(row.session_id)
    sessionsByStudent.set(row.student_id, set)
  }

  // Latest running CGPA per student — the null-term_id row per student
  // in student_gpa_snapshots, exactly saveGpaSnapshots()'s own written
  // convention (courseResultsService.ts) — one row per student since
  // that function deletes-then-inserts on every recompute, so there is
  // never more than one to disambiguate.
  const cgpaRes = await supabase
    .from('student_gpa_snapshots')
    .select('student_id, cgpa, term_id')
    .in('student_id', studentIds)
    .is('term_id', null)
  if (cgpaRes.error) return { data: null, error: cgpaRes.error.message }
  const cgpaByStudent = new Map<string, number | null>()
  for (const row of (cgpaRes.data ?? []) as any[]) {
    cgpaByStudent.set(row.student_id, row.cgpa === null ? null : Number(row.cgpa))
  }

  // Outstanding carryover count per student — course_registrations.status
  // = 'carryover', the real, self-maintaining signal per SESSION 62pre
  // (auto-flagged on finalize, no longer SQL-Editor-seeded). Used only as
  // context text on whichever event fires, per this function's header
  // comment — never its own trigger.
  const carryoverRes = await supabase
    .from('course_registrations')
    .select('student_id, status')
    .in('student_id', studentIds)
    .eq('status', 'carryover')
  if (carryoverRes.error) return { data: null, error: carryoverRes.error.message }
  const carryoverCountByStudent = new Map<string, number>()
  for (const row of (carryoverRes.data ?? []) as any[]) {
    carryoverCountByStudent.set(row.student_id, (carryoverCountByStudent.get(row.student_id) ?? 0) + 1)
  }

  // Already-pending (unreviewed) events for this session, to avoid
  // duplicate inserts on a re-run — see this function's own idempotency
  // doc above.
  const pendingRes = await supabase
    .from('academic_standing_events')
    .select('student_id, standing')
    .eq('session_id', currentSessionId)
    .is('reviewed_at', null)
  if (pendingRes.error) return { data: null, error: pendingRes.error.message }
  const pendingKey = (studentId: string, standing: string) => `${studentId}::${standing}`
  const alreadyPending = new Set((pendingRes.data ?? []).map((r: any) => pendingKey(r.student_id, r.standing)))

  const rowsToInsert: any[] = []
  let skipped = 0

  for (const placement of currentPlacements) {
    const studentId = placement.student_id as string
    const carryoverCount = carryoverCountByStudent.get(studentId) ?? 0
    const carryoverNote = rules.max_carryover_courses_before_review !== null && carryoverCount > rules.max_carryover_courses_before_review
      ? ` Also carrying ${carryoverCount} outstanding carryover course(s), above the configured review threshold of ${rules.max_carryover_courses_before_review}.`
      : ''

    // Probation check
    if (rules.probation_cgpa_threshold !== null) {
      const cgpa = cgpaByStudent.get(studentId) ?? null
      if (cgpa !== null && cgpa < rules.probation_cgpa_threshold) {
        const key = pendingKey(studentId, 'probation')
        if (alreadyPending.has(key)) {
          skipped++
        } else {
          rowsToInsert.push({
            student_id: studentId,
            session_id: currentSessionId,
            standing: 'probation',
            cgpa_at_evaluation: cgpa,
            triggered_by: 'probation_cgpa_threshold',
            note: `CGPA ${cgpa.toFixed(2)} is below the configured probation threshold of ${rules.probation_cgpa_threshold}.${carryoverNote}`,
          })
          alreadyPending.add(key) // guard against a second trip in this same run
        }
      }
    }

    // Spillover check
    if (rules.max_registration_multiplier !== null) {
      const durationSessions = durationByLevelId.get(placement.programme_level_id) ?? null
      const sessionsEnrolled = sessionsByStudent.get(studentId)?.size ?? 0
      if (durationSessions !== null && durationSessions > 0) {
        const threshold = durationSessions * rules.max_registration_multiplier
        if (sessionsEnrolled > threshold) {
          const key = pendingKey(studentId, 'spillover')
          if (alreadyPending.has(key)) {
            skipped++
          } else {
            const cgpa = cgpaByStudent.get(studentId) ?? null
            rowsToInsert.push({
              student_id: studentId,
              session_id: currentSessionId,
              standing: 'spillover',
              cgpa_at_evaluation: cgpa,
              triggered_by: 'max_registration_multiplier',
              note: `Enrolled across ${sessionsEnrolled} sessions, exceeding this programme's ${durationSessions}-session duration × ${rules.max_registration_multiplier} residency multiplier (threshold: ${threshold.toFixed(1)} sessions).${carryoverNote}`,
            })
            alreadyPending.add(key)
          }
        }
      }
    }
  }

  if (rowsToInsert.length > 0) {
    const insRes = await supabase.from('academic_standing_events').insert(rowsToInsert)
    if (insRes.error) return { data: null, error: insRes.error.message }
  }

  return {
    data: {
      studentsEvaluated: currentPlacements.length,
      eventsCreated: rowsToInsert.length,
      skippedAlreadyPending: skipped,
    },
    error: null,
  }
}

/** All unreviewed (reviewed_at is null) academic_standing_events for the
 *  school, newest first — the admin review queue's own read. Joins
 *  through students for name/matric_number/school scoping, since
 *  academic_standing_events carries no school_id column of its own
 *  (§7.27.5's own RLS note — join-through-students is the real scope,
 *  matched here explicitly rather than assumed). */
export async function loadPendingStandingEvents(schoolId: string): Promise<{ data: StandingEvent[]; error: string | null }> {
  const { data, error } = await supabase
    .from('academic_standing_events')
    .select('id, student_id, session_id, standing, cgpa_at_evaluation, triggered_by, note, reviewed_by, reviewed_at, created_at, students!inner(full_name, matric_number, school_id), sessions(name)')
    .eq('students.school_id', schoolId)
    .is('reviewed_at', null)
    .order('created_at', { ascending: false })

  if (error) return { data: [], error: error.message }
  return {
    data: (data ?? []).map((row: any) => {
      const student = Array.isArray(row.students) ? row.students[0] : row.students
      const session = Array.isArray(row.sessions) ? row.sessions[0] : row.sessions
      return {
        id: row.id,
        student_id: row.student_id,
        student_name: student?.full_name ?? '',
        matric_number: student?.matric_number ?? null,
        session_id: row.session_id,
        session_name: session?.name ?? 'Session',
        standing: row.standing,
        cgpa_at_evaluation: row.cgpa_at_evaluation === null ? null : Number(row.cgpa_at_evaluation),
        triggered_by: row.triggered_by,
        note: row.note,
        reviewed_by: row.reviewed_by,
        reviewed_at: row.reviewed_at,
        created_at: row.created_at,
      }
    }),
    error: null,
  }
}

/**
 * Confirms (or overrides, via an appended note) one pending standing
 * event — the one and only place reviewed_by/reviewed_at ever get set,
 * per §7.27.5's "never silent, always human-reviewed" design.
 * reviewerStaffId must be the real confirming admin's staff id
 * (actorRecordId from authStore, threaded down from App.tsx — see
 * StandingTab's own call site) — never fabricated or left null, since
 * this is the audit trail's whole point.
 *
 * overrideStanding, if provided, lets the admin record a different
 * final standing than what the evaluation proposed (e.g. downgrading a
 * proposed 'spillover' to 'good_standing' after confirming a Senate
 * extension was granted) — the ORIGINAL event row is updated in place
 * (standing overwritten, not a second row inserted), since this is one
 * event's final disposition, not a new event; the evaluation's original
 * proposal is preserved in the note text (appended, not overwritten) so
 * the audit trail still shows what was proposed vs. what was decided.
 */
export async function reviewStandingEvent(
  eventId: string,
  reviewerStaffId: string,
  options?: { overrideStanding?: StandingEvent['standing']; additionalNote?: string },
): Promise<{ error: string | null }> {
  const updates: any = {
    reviewed_by: reviewerStaffId,
    reviewed_at: new Date().toISOString(),
  }
  if (options?.overrideStanding || options?.additionalNote) {
    const existingRes = await supabase.from('academic_standing_events').select('standing, note').eq('id', eventId).maybeSingle()
    if (existingRes.error) return { error: existingRes.error.message }
    const original = existingRes.data as { standing: string; note: string | null } | null
    let newNote = original?.note ?? ''
    if (options.overrideStanding && options.overrideStanding !== original?.standing) {
      newNote += ` [Reviewed: standing changed from '${original?.standing}' to '${options.overrideStanding}'.]`
      updates.standing = options.overrideStanding
    }
    if (options.additionalNote) {
      newNote += ` [Admin note: ${options.additionalNote}]`
    }
    updates.note = newNote
  }

  const { error } = await supabase.from('academic_standing_events').update(updates).eq('id', eventId)
  return { error: error?.message ?? null }
}

// ─── SESSION 69 — Programme-level promotion rules ──────────────────────────
// (PRD Tier 8, SESSION 69, §7.27.1a Design A amendment). A school-configured
// mapping "from this programme level, to that one, at this CGPA cutoff" —
// read by the new run_programme_promotion()/record_manual_promotion_decision()
// DB functions (migration_session69_promotion_run.sql), never computed or
// guessed at here. This is definitional-side CRUD only, following
// upsertHigherEdGradeBand()/deleteHigherEdGradeBand()'s exact established
// pattern for a small per-school config/catalogue table (upsert by optional
// id, real hard delete — same catalogue-data carve-out from this file's own
// "no hard deletes" header rule already documented for grade_scales/periods/
// roles/student roles).
//
// max_carryover_courses is read/written here (so the column isn't silently
// unreachable from any UI) but is NOT YET enforced by the promotion run
// itself — owner's explicit choice this session: CGPA-only eligibility for
// now, carryover-cap as a clearly separate, later follow-up. Exposing the
// field now means no second migration/UI pass is needed once that follow-up
// lands; it simply starts being read by the DB function at that point.

export interface ProgrammePromotionRule {
  id: string
  from_programme_level_id: string
  to_programme_level_id: string
  min_cgpa: number | null
  max_carryover_courses: number | null
}

export async function loadProgrammePromotionRules(schoolId: string): Promise<{ data: ProgrammePromotionRule[]; error: string | null }> {
  const { data, error } = await supabase
    .from('programme_promotion_rules')
    .select('id, from_programme_level_id, to_programme_level_id, min_cgpa, max_carryover_courses')
    .eq('school_id', schoolId)
    .order('created_at', { ascending: true })

  if (error) return { data: [], error: error.message }
  return {
    data: (data ?? []).map((r: any) => ({
      id: r.id,
      from_programme_level_id: r.from_programme_level_id,
      to_programme_level_id: r.to_programme_level_id,
      min_cgpa: r.min_cgpa === null ? null : Number(r.min_cgpa),
      max_carryover_courses: r.max_carryover_courses === null ? null : Number(r.max_carryover_courses),
    })),
    error: null,
  }
}

export async function upsertProgrammePromotionRule(
  schoolId: string,
  rule: {
    id?: string
    from_programme_level_id: string
    to_programme_level_id: string
    min_cgpa: number | null
    max_carryover_courses: number | null
  },
): Promise<{ error: string | null }> {
  const payload = {
    from_programme_level_id: rule.from_programme_level_id,
    to_programme_level_id: rule.to_programme_level_id,
    min_cgpa: rule.min_cgpa,
    max_carryover_courses: rule.max_carryover_courses,
  }
  if (rule.id) {
    const { error } = await supabase
      .from('programme_promotion_rules')
      .update(payload)
      .eq('id', rule.id)
      .eq('school_id', schoolId)
    return { error: error?.message ?? null }
  }
  const { error } = await supabase
    .from('programme_promotion_rules')
    .insert({ school_id: schoolId, ...payload })
  return { error: error?.message ?? null }
}

// Catalogue/config data, not a person or financial record — real hard
// delete, same carve-out this file's header rule already documents for
// grade_scales/periods/roles/student roles (deleteHigherEdGradeBand is the
// most directly analogous precedent — same table shape, same reasoning).
export async function deleteProgrammePromotionRule(schoolId: string, ruleId: string): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from('programme_promotion_rules')
    .delete()
    .eq('id', ruleId)
    .eq('school_id', schoolId)
  return { error: error?.message ?? null }
}

// ─── SESSION 69, item 4c — the promotion run itself + manual-review queue ──
// Calls the two real security-definer DB functions directly
// (session69_promotion_run.sql) via supabase.rpc() — the first .rpc() call
// in this file. Neither function is a plain client write under this
// school's existing RLS: run_programme_promotion() flips
// student_programme_placements.is_current and inserts a new placement row
// in the same pass, and record_manual_promotion_decision() does the same
// for a single student — both writes broader than any staff role's direct
// RLS grant, per the SQL file's own documented justification (mirroring
// apply_carryover_status()'s precedent). This mirrors
// runStandingEvaluation()'s role in this file (a session-end sweep +
// review queue) but is NOT built the same way internally — that function
// computes client-side against ordinary RLS-gated reads/writes;
// run_programme_promotion() is real, server-side, transactional logic that
// cannot safely be replicated as a sequence of client calls (see the SQL
// file's own header comment on why a client-side loop of individual
// updates would race).

export interface PromotionRunResultRow {
  student_id: string
  student_full_name: string
  from_programme_level_id: string
  to_programme_level_id: string | null
  cgpa: number | null
  min_cgpa: number | null
  outcome: 'auto_promoted' | 'needs_review' | 'graduated' | 'no_rule_configured'
}

/**
 * Runs run_programme_promotion() for real — this WRITES: auto-promotes
 * every eligible student (flips their current placement, inserts the new
 * one, writes a programme_promotion_history row), and returns one row per
 * considered student covering all four outcomes, including
 * needs_review/no_rule_configured, which this function does NOT act on —
 * per the SQL function's own "never silent" design, every considered
 * student is returned, not just the ones it changed. There is
 * deliberately no separate "dry run" mode exposed here — the DB function
 * itself always writes; a dry run is done by wrapping the raw SQL call in
 * begin/rollback directly in SQL Editor, not by this service layer.
 */
export async function runProgrammePromotion(
  sessionId: string,
  decidedByStaffId: string,
): Promise<{ data: PromotionRunResultRow[]; error: string | null }> {
  const { data, error } = await supabase.rpc('run_programme_promotion', {
    p_session_id: sessionId,
    p_decided_by: decidedByStaffId,
  })
  if (error) return { data: [], error: error.message }
  return {
    data: (data ?? []).map((r: any) => ({
      student_id: r.student_id,
      student_full_name: r.student_full_name,
      from_programme_level_id: r.from_programme_level_id,
      to_programme_level_id: r.to_programme_level_id,
      cgpa: r.cgpa === null ? null : Number(r.cgpa),
      min_cgpa: r.min_cgpa === null ? null : Number(r.min_cgpa),
      outcome: r.outcome,
    })),
    error: null,
  }
}

/**
 * Records one manual review decision for a single student in the
 * needs_review bucket — calls record_manual_promotion_decision(), which
 * writes its own placement flip and its own programme_promotion_history
 * row, same audit discipline as the bulk function.
 *
 * FIX (session69, post-4c): 'manual_override' was previously treated like
 * 'repeated' at this layer — toProgrammeLevelId was silently forced to
 * null for anything other than 'promoted', which meant an admin picking a
 * destination level and clicking "Manual override" had that choice
 * discarded, and the DB function (before its own fix5) wrote an
 * audit-only row that never moved the student. Owner-confirmed semantics:
 * 'manual_override' behaves exactly like 'promoted' (flip placement,
 * insert new one at the chosen level) — it exists only to let an admin
 * bypass the normal CGPA cutoff, distinguished from 'promoted' only in
 * the audit trail's decision column, never in the real effect. This must
 * stay in sync with record_manual_promotion_decision's own
 * p_decision in ('promoted', 'manual_override', 'graduated') branch
 * (session69_promotion_run_fix5.sql) — a destination level is required
 * for both 'promoted' and 'manual_override', and null only for
 * 'repeated'/'graduated'.
 */
export async function recordManualPromotionDecision(params: {
  studentId: string
  sessionId: string
  decision: 'promoted' | 'repeated' | 'manual_override' | 'graduated'
  toProgrammeLevelId: string | null
  decidedByStaffId: string
  reason: string
}): Promise<{ error: string | null }> {
  const requiresDestination = params.decision === 'promoted' || params.decision === 'manual_override'
  if (requiresDestination && !params.toProgrammeLevelId) {
    return { error: `Choose a destination level for a "${params.decision}" decision.` }
  }
  const { error } = await supabase.rpc('record_manual_promotion_decision', {
    p_student_id: params.studentId,
    p_session_id: params.sessionId,
    p_decision: params.decision,
    p_to_programme_level_id: requiresDestination ? params.toProgrammeLevelId : null,
    p_decided_by: params.decidedByStaffId,
    p_reason: params.reason,
  })
  return { error: error?.message ?? null }
}


// before SESSION 60, closing the gap SESSION 58's close-out surfaced: "no
// course_offerings creation UI exists anywhere ... every test in this
// session used a direct SQL insert.") ─────────────────────────────────────
//
// course_offerings has no school_id column of its own — confirmed directly
// against the live RLS policy before writing any function here, not assumed
// from the table's [STD] label in the master plan (which is shorthand, not
// literal, for this table): the real policy is
//   EXISTS (SELECT 1 FROM courses c WHERE c.id = course_offerings.course_id
//           AND c.school_id = current_school_id())
// — the same join-through-parent shape course_results already uses. This
// means every read/write is scoped via course_id, not a literal school_id
// column, and the course picker itself must only ever list this school's
// own courses (loadCourses() already does, reused as-is below).
//
// venue_id is deliberately not exposed anywhere in this section — §7.15's
// venues table doesn't exist yet (Problem 8.4 not yet accepted); the column
// is nullable, so simply never setting it is correct, not a workaround.

export interface CourseOffering {
  id: string
  course_id: string
  course_code: string
  course_title: string
  session_id: string
  term_id: string | null
  staff_id: string | null
  staff_name: string | null
  // SESSION 69 (§7.27.2 amendment) — which cohort this specific offering
  // is taught to, fixed at offering-creation time. Both nullable: an
  // offering predating this session, or a genuinely shared/university-wide
  // offering with no single owning cohort, are both real, permanent
  // states, not a gap to backfill. See master_plan_7_27_2_amendment_
  // session_69.md for the full reasoning (deliberately not derived live
  // from programme_curriculum — see that doc for why).
  programme_id: string | null
  programme_level_id: string | null
  attendance_eligibility_threshold_pct: number | null
}

// Scoped to the given session (and term, when this school uses terms) —
// mirrors loadCurriculum()'s own session/term-scoping shape, since an
// offering is meaningless outside a specific session/term. No schoolId
// param: session_id/term_id are themselves already school-scoped uuids
// (the caller only ever passes an id it already loaded via loadSessions()/
// loadTerms(), both school-filtered), and RLS (join through course_id ->
// courses.school_id, confirmed live) is the real cross-school enforcement
// regardless — an explicit .eq('school_id', ...) isn't possible here since
// the column doesn't exist on this table, and wouldn't add any real
// boundary beyond what the session/term id and RLS already guarantee.
export async function loadCourseOfferings(
  sessionId: string,
  termId?: string | null,
): Promise<{ data: CourseOffering[]; error: string | null }> {
  let q = supabase
    .from('course_offerings')
    .select('id, course_id, session_id, term_id, staff_id, programme_id, programme_level_id, attendance_eligibility_threshold_pct, courses(code, title), staff(full_name)')
    .eq('session_id', sessionId)

  if (termId) q = q.eq('term_id', termId)

  const { data, error } = await q
  if (error) return { data: [], error: error.message }

  return {
    data: (data ?? []).map((o: any) => ({
      id: o.id,
      course_id: o.course_id,
      course_code: o.courses?.code ?? '',
      course_title: o.courses?.title ?? '',
      session_id: o.session_id,
      term_id: o.term_id,
      staff_id: o.staff_id,
      staff_name: o.staff?.full_name ?? null,
      programme_id: o.programme_id ?? null,
      programme_level_id: o.programme_level_id ?? null,
      attendance_eligibility_threshold_pct: o.attendance_eligibility_threshold_pct === null ? null : Number(o.attendance_eligibility_threshold_pct),
    })),
    error: null,
  }
}

export async function upsertCourseOffering(
  offering: {
    id?: string
    course_id: string
    session_id: string
    term_id?: string | null
    staff_id?: string | null
    programme_id?: string | null
    programme_level_id?: string | null
    attendance_eligibility_threshold_pct?: number | null
  },
): Promise<{ error: string | null }> {
  const payload = {
    course_id: offering.course_id,
    session_id: offering.session_id,
    term_id: offering.term_id ?? null,
    staff_id: offering.staff_id ?? null,
    programme_id: offering.programme_id ?? null,
    programme_level_id: offering.programme_level_id ?? null,
    attendance_eligibility_threshold_pct: offering.attendance_eligibility_threshold_pct ?? null,
  }
  // No .eq('school_id', ...) — the column doesn't exist on this table.
  // RLS (join through course_id -> courses.school_id, confirmed live)
  // is the only scoping mechanism for both branches below.
  if (offering.id) {
    const { error } = await supabase
      .from('course_offerings')
      .update({ ...payload, updated_at: new Date().toISOString() })
      .eq('id', offering.id)
    return { error: error?.message ?? null }
  }
  const { error } = await supabase
    .from('course_offerings')
    .insert(payload)
  return { error: error?.message ?? null }
}

// Catalogue/config data, not a person or financial record — real hard
// delete, same carve-out as deletePeriod/deleteRole/deleteHigherEdGradeBand.
// No .eq('school_id', ...) for the same reason as upsertCourseOffering above.
export async function deleteCourseOffering(offeringId: string): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from('course_offerings')
    .delete()
    .eq('id', offeringId)
  return { error: error?.message ?? null }
}
