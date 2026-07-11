/**
 * PublicHomepage.tsx
 * Pre-login, no-auth-required public page for a school's subdomain.
 * PRD Row 34 / Problem 7.1.
 *
 * Rendered by App.tsx as the FIRST thing an unauthenticated visitor sees
 * (before LoginPage) — see App.tsx's own routing doc comment, updated
 * alongside this file. The wrong-school case (isWrongSchool/
 * wrongSchoolBlock) deliberately bypasses this page entirely and goes
 * straight to LoginPage's banner — that's a security-relevant redirect for
 * someone with valid-elsewhere credentials, not a first-time visitor, and
 * showing them a different school's public content first would be a real
 * information-disclosure/confusion risk, not a UX nicety to skip.
 *
 * Data comes from publicHomepageService.ts — anonymous reads only, no
 * session assumed or required anywhere in this file.
 */

import { useEffect, useState } from 'react'
import { applyBrandTheme } from '../services/themeService'
import {
  loadPublicSchoolData,
  loadPublicAnnouncements,
  loadPublicHomepagePosts,
  type PublicSchoolInfo,
  type PublicSchoolConfig,
  type PublicAnnouncement,
  type PublicHomepagePost,
  type WelcomePost,
  type WelcomePostBlock,
} from '../services/publicHomepageService'

// ─── Skeleton (same minimal convention as AdminDashboard.tsx's own) ───────

function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton ${className}`} />
}

// ─── Welcome post (owner request, 2026-07-11) ──────────────────────────────
// Renders the structured heading + ordered blocks post. A school with no
// welcome_post yet falls back to the legacy plain welcome_message (see
// PublicHomepageProps's caller — the parent component decides which of
// the two to render, this component only ever renders a real post).

function BlocksView({ blocks }: { blocks: WelcomePostBlock[] }) {
  return (
    <>
      {blocks.map((block, i) =>
        block.type === 'paragraph' ? (
          <p key={i} className="public-home-post-paragraph">{block.text}</p>
        ) : (
          <figure key={i} className="public-home-post-figure">
            <img src={block.url} alt={block.caption ?? ''} className="public-home-post-image" loading="lazy" />
            {block.caption && <figcaption className="public-home-post-caption">{block.caption}</figcaption>}
          </figure>
        )
      )}
    </>
  )
}

function WelcomePostView({ post }: { post: WelcomePost }) {
  return (
    <div className="public-home-post">
      {post.heading && <h2 className="public-home-post-heading">{post.heading}</h2>}
      <BlocksView blocks={post.blocks} />
    </div>
  )
}

// ─── Homepage posts (owner request, 2026-07-11 follow-up) ─────────────────
// Several ordered, independently expandable posts. Truncation is
// line-based (CSS line-clamp), not character-count — the established,
// layout-aware approach already used elsewhere in this app (see
// .dash-ann-body's own -webkit-line-clamp: 2), and the current UX-best-
// -practice approach generally: it adapts to real rendered width/font
// size instead of an arbitrary character cutoff that looks inconsistent
// from post to post. isExpanded is driven entirely by the parent
// (PublicHomepage) so that expanding one post can collapse every other —
// this component holds no expand/collapse state of its own. The collapsed
// line count itself lives in CSS (.public-home-post-body--clamped),
// matching .dash-ann-body's own convention of hardcoding its line count
// rather than reading it from a JS constant.

function HomepagePostCard({
  post,
  isExpanded,
  onToggle,
}: {
  post: PublicHomepagePost
  isExpanded: boolean
  onToggle: () => void
}) {
  // always_expanded (admin toggle) wins regardless of the shared
  // expand/collapse-others state — an admin who pinned a post open does
  // not want it silently collapsed just because a visitor expanded a
  // different one.
  const effectivelyExpanded = post.always_expanded || isExpanded

  return (
    <article className="public-home-post-card">
      {post.heading && <h2 className="public-home-post-heading">{post.heading}</h2>}
      <div
        className={
          effectivelyExpanded
            ? 'public-home-post-body'
            : 'public-home-post-body public-home-post-body--clamped'
        }
      >
        <BlocksView blocks={post.blocks} />
      </div>
      {!post.always_expanded && (
        <button
          type="button"
          className="public-home-post-toggle"
          onClick={onToggle}
          aria-expanded={effectivelyExpanded}
        >
          {effectivelyExpanded ? 'Show less' : 'Continue reading…'}
        </button>
      )}
    </article>
  )
}

// ─── Props ──────────────────────────────────────────────────────────────────

interface PublicHomepageProps {
  slug: string
  onLogin: () => void
}

type LoadState = 'loading' | 'ready' | 'not-found' | 'error'

export function PublicHomepage({ slug, onLogin }: PublicHomepageProps) {
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [loadError, setLoadError] = useState('')
  const [school, setSchool] = useState<PublicSchoolInfo | null>(null)
  const [config, setConfig] = useState<PublicSchoolConfig | null>(null)
  const [announcements, setAnnouncements] = useState<PublicAnnouncement[]>([])
  const [annsLoading, setAnnsLoading] = useState(false)
  const [posts, setPosts] = useState<PublicHomepagePost[]>([])
  const [postsLoading, setPostsLoading] = useState(false)
  // Which one post (by id) is currently expanded via visitor interaction —
  // deliberately a single id, not a Set, so that expanding a new post
  // always collapses whichever one was previously open (owner request:
  // "each expanded post to make any other collapsed post collapsed").
  // Posts with always_expanded=true ignore this entirely (see
  // HomepagePostCard's own effectivelyExpanded logic) — they're never
  // affected by what a visitor taps elsewhere on the page.
  const [expandedPostId, setExpandedPostId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    loadPublicSchoolData(slug).then(res => {
      if (cancelled) return
      if (!res.ok) {
        // "School not found." (a real, named case from the service) is
        // distinguished from a genuine load error so this page can show
        // the same not-found treatment App.tsx's own school-lookup step
        // already uses elsewhere, rather than a scary error banner for
        // what is very often just a mistyped subdomain.
        setLoadState(res.error === 'School not found.' ? 'not-found' : 'error')
        setLoadError(res.error)
        return
      }
      setSchool(res.data.school)
      setConfig(res.data.config)
      setLoadState('ready')

      // Apply the school's real brand color to this page too, same call
      // App.tsx itself makes once `school` loads for the authenticated
      // shell — 'light' mode default, since an anonymous visitor has no
      // saved theme-mode preference to load (App.tsx's own themeMode
      // state also defaults to 'light' before any preference resolves).
      if (res.data.school.theme_color) {
        applyBrandTheme(res.data.school.theme_color, 'light')
      }

      // Homepage posts (2026-07-11 follow-up) — unconditional, unlike
      // announcements: there's no school-level "show posts" toggle, since
      // an empty post list already renders nothing (same "absence is the
      // off switch" reasoning as the welcome-post fallback chain below).
      setPostsLoading(true)
      loadPublicHomepagePosts(res.data.school.id).then(postsRes => {
        if (cancelled) return
        setPosts(postsRes.ok ? postsRes.data : [])
        setPostsLoading(false)
      })

      // Public announcements are opt-in per school (show_announcements)
      // and non-fatal if they fail to load — same "dashboard still works
      // without announcements" tolerance AdminDashboard.tsx's own
      // loadAnnouncements() already applies, not a stricter standard for
      // an anonymous visitor than a signed-in admin gets.
      if (res.data.config.show_announcements) {
        setAnnsLoading(true)
        loadPublicAnnouncements(res.data.school.id).then(annRes => {
          if (cancelled) return
          setAnnouncements(annRes.ok ? annRes.data : [])
          setAnnsLoading(false)
        })
      }
    })

    return () => { cancelled = true }
  }, [slug])

  function togglePost(postId: string) {
    setExpandedPostId(prev => (prev === postId ? null : postId))
  }

  // ─── Not found ────────────────────────────────────────────────────────

  if (loadState === 'not-found') {
    return (
      <div className="public-home-status">
        <div className="public-home-status-inner">
          <h1>School not found</h1>
          <p>Check the web address — it should look like yourschool.eduportalng.com.</p>
        </div>
      </div>
    )
  }

  // ─── Load error ───────────────────────────────────────────────────────

  if (loadState === 'error') {
    return (
      <div className="public-home-status">
        <div className="public-home-status-inner">
          <h1>Something went wrong</h1>
          <p>{loadError}</p>
          <button className="public-home-retry-btn" onClick={() => window.location.reload()}>
            Try again
          </button>
        </div>
      </div>
    )
  }

  // ─── Loading (skeleton, not a spinner — matches App.tsx's own rule) ───

  if (loadState === 'loading' || !school || !config) {
    return (
      <div className="public-home">
        <header className="public-home-header">
          <Skeleton className="public-home-logo-skel" />
          <Skeleton className="public-home-name-skel" />
        </header>
        <main className="public-home-main">
          <Skeleton className="public-home-welcome-skel" />
          <Skeleton className="public-home-welcome-skel" />
        </main>
      </div>
    )
  }

  // ─── Ready ────────────────────────────────────────────────────────────

  const contact = config.contact_info

  return (
    <div className="public-home">
      <header className="public-home-header">
        {school.logo_url && (
          <img src={school.logo_url} alt={school.name} className="public-home-logo" />
        )}
        <h1 className="public-home-school-name">{school.name}</h1>
      </header>

      <main className="public-home-main">
        <div className="public-home-layout">
          <div className="public-home-primary">
            {config.welcome_post ? (
              <WelcomePostView post={config.welcome_post} />
            ) : config.welcome_message ? (
              <p className="public-home-welcome">{config.welcome_message}</p>
            ) : (
              <p className="public-home-welcome public-home-welcome--empty">
                Welcome to {school.name}.
              </p>
            )}

            {/* Homepage posts (owner request, 2026-07-11 follow-up) — several
                ordered, independently expandable posts. Unconditional section
                (no school-level toggle, same "empty list renders nothing"
                reasoning as the welcome-post fallback chain above). */}
            {postsLoading && (
              <section className="public-home-posts">
                <Skeleton className="public-home-post-skel" />
                <Skeleton className="public-home-post-skel" />
              </section>
            )}
            {!postsLoading && posts.length > 0 && (
              <section className="public-home-posts">
                {posts.map(post => (
                  <HomepagePostCard
                    key={post.id}
                    post={post}
                    isExpanded={expandedPostId === post.id}
                    onToggle={() => togglePost(post.id)}
                  />
                ))}
              </section>
            )}
          </div>

          <div className="public-home-sidebar">
            {contact && (contact.phone || contact.email || contact.address) && (
              <section className="public-home-contact">
                <h2 className="public-home-section-heading">Contact</h2>
                <ul className="public-home-contact-list">
                  {contact.phone && (
                    <li className="public-home-contact-row">
                      <span className="public-home-contact-label">Phone</span>
                      <span className="public-home-contact-value">{contact.phone}</span>
                    </li>
                  )}
                  {contact.email && (
                    <li className="public-home-contact-row">
                      <span className="public-home-contact-label">Email</span>
                      <span className="public-home-contact-value">{contact.email}</span>
                    </li>
                  )}
                  {contact.address && (
                    <li className="public-home-contact-row">
                      <span className="public-home-contact-label">Address</span>
                      <span className="public-home-contact-value">{contact.address}</span>
                    </li>
                  )}
                </ul>
              </section>
            )}

            {config.show_announcements && (
              <section className="public-home-announcements">
                <h2 className="public-home-section-heading">Announcements</h2>
                {annsLoading && (
                  <>
                    <Skeleton className="public-home-ann-skel" />
                    <Skeleton className="public-home-ann-skel" />
                  </>
                )}
                {!annsLoading && announcements.length === 0 && (
                  <p className="public-home-ann-empty">No announcements right now.</p>
                )}
                {!annsLoading && announcements.length > 0 && (
                  <ul className="public-home-ann-list">
                    {announcements.map(a => (
                      <li key={a.id} className="public-home-ann-row">
                        <p className="public-home-ann-title">{a.title}</p>
                        <p className="public-home-ann-body">
                          {a.body.slice(0, 140)}{a.body.length > 140 ? '…' : ''}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}

            <button className="public-home-login-btn" onClick={onLogin}>
              Log in
            </button>
          </div>
        </div>
      </main>
    </div>
  )
}
