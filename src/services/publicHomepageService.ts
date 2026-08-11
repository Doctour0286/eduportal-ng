/**
 * publicHomepageService.ts
 * Data layer for the pre-login public homepage (PRD Problem 7.1, Row 34).
 *
 * Anonymous-read only — every function here is called before any auth
 * session exists, so nothing in this file may depend on RLS scoping by
 * identity. Confirmed via direct SQL (2026-07-11) before writing this file:
 *
 *   - `schools`' own "public can read school routing info" policy IS scoped
 *     to {anon, authenticated} but has no school_id restriction in its
 *     qual (`true`) — same as school_public_config below. Every read here
 *     filters explicitly by id/school_id itself; RLS is the outer school-
 *     boundary backstop for authenticated writes elsewhere in this app
 *     (per master plan §3.2), not a per-row anonymous-read scope here.
 *   - `school_public_config`'s "public read school config" policy:
 *     cmd=SELECT, roles={public}, qual=true — genuinely anonymous-readable,
 *     for ANY school's row, not just one. This file's own explicit
 *     .eq('school_id', schoolId) is therefore load-bearing, not
 *     defence-in-depth — the query does not implicitly self-scope, no
 *     row-per-school ambiguity.
 *
 * No new RLS needed — both policies already existed and were confirmed
 * intact before this file was written (the PRD's own note flags this exact
 * policy as previously lost once, on 2026-06-24 — re-verified present here,
 * not assumed from that note alone).
 *
 * Table shapes confirmed directly via information_schema.columns, not
 * assumed from the PRD's prose description:
 *   schools:               id, name, slug, school_type, logo_url,
 *                          theme_color, default_lang, enabled_langs,
 *                          uses_terms, uses_ledger, status,
 *                          onboarding_complete, created_at, updated_at,
 *                          default_pay_frequency,
 *                          teacher_payslip_visibility_enabled
 *   school_public_config:  school_id, welcome_message, welcome_post (jsonb,
 *                          added 2026-07-11 — see add_welcome_post_column.sql;
 *                          structured heading+blocks post, supersedes
 *                          welcome_message going forward, which is kept
 *                          only as a read-only fallback for schools that
 *                          saved a plain message before this existed),
 *                          contact_info (jsonb), show_announcements,
 *                          custom_fields (jsonb), updated_at
 *
 * Public announcements reuse the exact same audience/expiry semantics
 * announcementsService.ts's loadAnnouncements() already applies for signed-
 * in users (school-scoped, `is_public = true`, excludes expired unless
 * asked) — this file does not build a second, parallel announcements query
 * with different filtering rules; see loadPublicAnnouncements() below.
 */

import { supabase } from '../lib/supabase'
import {
  normalizeBlocks,
  type WelcomePostBlock,
  type WelcomePostTextRun,
  type WelcomePostTextLevel,
} from './settingsService'

// Re-exported so PublicHomepage.tsx can import the block/run/level shapes
// from this file alone, without also reaching into settingsService.ts
// directly — this file is the anonymous-read boundary for the public page,
// settingsService.ts is the authenticated-admin editor for the same
// underlying data. Both sides share one shape (not a second, parallel
// type) because they render/produce the exact same jsonb blocks column;
// see normalizeBlocks' own doc comment in settingsService.ts for why a
// shared normalizer matters (old posts saved before the rich-text/level
// upgrade must still render, on this page too, not just in Settings).
export type { WelcomePostBlock, WelcomePostTextRun, WelcomePostTextLevel }

// ─── Result type (consistent with every other service in this app) ────────

export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: string }

// ─── Domain types ───────────────────────────────────────────────────────────

export interface PublicSchoolInfo {
  id: string
  name: string
  logo_url: string | null
  theme_color: string | null
  status: string
}

export interface ContactInfo {
  phone?: string
  email?: string
  address?: string
}

// ─── Welcome post (owner request, 2026-07-11) ──────────────────────────────
// WelcomePost's own `blocks` field uses the shared WelcomePostBlock shape
// imported above (heading-level text blocks + image blocks, matching
// exactly what settingsService.ts's editor writes) — this is a read-only
// view of the same admin-written data, not a second, independently-
// evolving type. See add_welcome_post_column.sql.

export interface WelcomePost {
  heading: string
  blocks: WelcomePostBlock[]
}

export interface PublicSchoolConfig {
  school_id: string
  /** Legacy plain-text message — only rendered when welcome_post is null
   *  (a school that saved a message before the post editor existed).
   *  See PublicHomepage.tsx's own render branch. */
  welcome_message: string | null
  welcome_post: WelcomePost | null
  contact_info: ContactInfo | null
  show_announcements: boolean
  /** Present in the schema for future use — not consumed by
   *  PublicHomepage.tsx yet; typed here so a future addition doesn't need
   *  a second round-trip through this file's own shape. */
  custom_fields: Record<string, unknown> | null
}

export interface PublicAnnouncement {
  id: string
  title: string
  body: string
  posted_at: string
}

// ─── Homepage posts (owner request, 2026-07-11 follow-up) ─────────────────
// Anonymous-read view of settingsService.ts's own HomepagePost — same
// school_homepage_posts table, same shared WelcomePostBlock shape for
// `blocks`, but without the school_id/created_at/updated_at fields this
// page's own components never read. Kept as a distinct type (not an
// import of HomepagePost itself) so this file's public surface doesn't
// widen every time the authenticated editor's own row shape grows a new
// admin-only field.

export interface PublicHomepagePost {
  id: string
  heading: string
  blocks: WelcomePostBlock[]
  always_expanded: boolean
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function friendlyError(err: { message: string }, fallback: string): string {
  if (err.message.includes('violates row-level security')) {
    return "This school's page isn't available right now."
  }
  return `${fallback}: ${err.message}`
}

// ─── Load school + public config together ──────────────────────────────────

/**
 * Resolves a school by its subdomain slug and its public-facing config in
 * one call — the two things PublicHomepage.tsx needs before it can render
 * anything. Mirrors App.tsx's own existing slug→school lookup query shape
 * (same select-by-slug pattern, see App.tsx's `getSlugFromHostname()` +
 * schools query) rather than introducing a second, differently-shaped
 * lookup for the same table.
 *
 * A school with no school_public_config row yet (never saved via the
 * onboarding wizard's Step 1, or via Settings) is not an error — every
 * field on `config` comes back null/false/empty rather than throwing, so
 * the homepage can still render the school's name/logo/theme color with a
 * plain "no welcome message yet" fallback instead of failing outright.
 */
export async function loadPublicSchoolData(
  slug: string
): Promise<Result<{ school: PublicSchoolInfo; config: PublicSchoolConfig }>> {
  try {
    const { data: school, error: schoolErr } = await supabase
      .from('schools')
      .select('id, name, logo_url, theme_color, status')
      .eq('slug', slug)
      .maybeSingle()

    if (schoolErr) return { ok: false, error: friendlyError(schoolErr, 'Failed to load school') }
    if (!school) return { ok: false, error: 'School not found.' }

    const { data: config, error: configErr } = await supabase
      .from('school_public_config')
      .select('school_id, welcome_message, welcome_post, contact_info, show_announcements, custom_fields')
      .eq('school_id', school.id)
      .maybeSingle()

    // A missing config row is expected (not every school has saved Step 1
    // of onboarding, or ever visits Settings' public-page section) — treat
    // it as "nothing configured yet," not a load failure. A real query
    // error (configErr set) is still surfaced, distinct from "no row."
    if (configErr) return { ok: false, error: friendlyError(configErr, 'Failed to load school page config') }

    const resolvedConfig: PublicSchoolConfig = config
      ? {
          school_id:          config.school_id as string,
          welcome_message:    config.welcome_message as string | null,
          welcome_post:       config.welcome_post
            ? {
                heading: (config.welcome_post as { heading?: string }).heading ?? '',
                blocks:  normalizeBlocks((config.welcome_post as { blocks?: unknown }).blocks),
              }
            : null,
          contact_info:       (config.contact_info as ContactInfo | null) ?? null,
          show_announcements: (config.show_announcements as boolean | null) ?? false,
          custom_fields:      (config.custom_fields as Record<string, unknown> | null) ?? null,
        }
      : {
          school_id:          school.id as string,
          welcome_message:    null,
          welcome_post:       null,
          contact_info:       null,
          show_announcements: false,
          custom_fields:      null,
        }

    return {
      ok: true,
      data: {
        school: {
          id:          school.id as string,
          name:        school.name as string,
          logo_url:    school.logo_url as string | null,
          theme_color: school.theme_color as string | null,
          status:      school.status as string,
        },
        config: resolvedConfig,
      },
    }
  } catch (e) {
    return { ok: false, error: `Failed to load school: ${(e as Error).message}` }
  }
}

// ─── Load homepage posts ────────────────────────────────────────────────────

/**
 * Anonymous-read counterpart to settingsService.ts's own loadHomepagePosts —
 * same school_homepage_posts table, same sort_order ascending order, same
 * normalizeBlocks() pass on the way out so a post saved before the rich-
 * text/level upgrade still renders correctly here too, not just in
 * Settings. Deliberately re-implemented rather than calling
 * loadHomepagePosts() directly, same reasoning as loadPublicAnnouncements()
 * below: that function's own error shape ({ data, error: string | null })
 * isn't this file's Result<T> convention, and re-running the same
 * school_id-scoped select here keeps this file's own anonymous-read
 * surface self-contained and auditable without a cross-file trust
 * assumption about a function written for an authenticated caller.
 */
export async function loadPublicHomepagePosts(
  schoolId: string
): Promise<Result<PublicHomepagePost[]>> {
  try {
    const { data, error } = await supabase
      .from('school_homepage_posts')
      .select('id, heading, blocks, always_expanded')
      .eq('school_id', schoolId)
      .order('sort_order', { ascending: true })

    if (error) return { ok: false, error: friendlyError(error, 'Failed to load homepage posts') }

    return {
      ok: true,
      data: (data ?? []).map((row: Record<string, unknown>) => ({
        id:              row.id as string,
        heading:         row.heading as string,
        blocks:          normalizeBlocks(row.blocks),
        always_expanded: (row.always_expanded as boolean | null) ?? false,
      })),
    }
  } catch (e) {
    return { ok: false, error: `Failed to load homepage posts: ${(e as Error).message}` }
  }
}

// ─── Load public announcements ─────────────────────────────────────────────

/**
 * Same audience/expiry semantics as announcementsService.ts's own
 * loadAnnouncements() — school-scoped, is_public = true, excludes expired
 * by default — deliberately re-implemented here rather than imported,
 * since that file's loadAnnouncements() has no anonymous-caller mode (its
 * own RLS-defence-in-depth .eq('school_id', schoolId) pattern assumes an
 * authenticated, school-scoped caller elsewhere in the app; the *filter
 * logic* is what's being reused here, not the function itself, per the
 * PRD's own instruction to reuse the filtering rather than build a
 * parallel query with different rules).
 */
export async function loadPublicAnnouncements(
  schoolId: string,
  limit = 5
): Promise<Result<PublicAnnouncement[]>> {
  try {
    const { data, error } = await supabase
      .from('announcements')
      .select('id, title, body, posted_at')
      .eq('school_id', schoolId)
      .eq('is_public', true)
      .or('expires_at.is.null,expires_at.gt.' + new Date().toISOString())
      .order('posted_at', { ascending: false })
      .limit(limit)

    if (error) return { ok: false, error: friendlyError(error, 'Failed to load announcements') }

    return {
      ok: true,
      data: (data ?? []).map((r: Record<string, unknown>) => ({
        id:        r.id as string,
        title:     r.title as string,
        body:      r.body as string,
        posted_at: r.posted_at as string,
      })),
    }
  } catch (e) {
    return { ok: false, error: `Failed to load announcements: ${(e as Error).message}` }
  }
}
