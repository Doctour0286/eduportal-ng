/**
 * LibraryModule.tsx
 * Physical library management + digital resource browser.
 *
 * Tabs (admin view):
 *   Overview  — stats cards + quick-action strip
 *   Catalogue — book title list; add/edit title; copy management drawer
 *   Borrowing — active borrows; checkout form (barcode or search); return action
 *   Overdue   — overdue list; issue fine; mark fine paid/waived
 *   Digital   — platform-wide digital resource browser (read-only for all users)
 *
 * Non-admin staff / guardian / student:
 *   Sees Catalogue (read-only) + Digital only.
 *
 * Props:
 *   schoolId  — current school UUID
 *   isAdmin   — true for staff / platform_admin; retained only as an
 *               admin-bypass alongside can()/canForClass() below — see
 *               Session 10 update
 *   authUserId — session user.id; used to resolve issued_by staff.id at checkout
 *
 * Updated (Session 10, PRD Problem 3.1, Goal 5): this file previously used
 * a single blanket isAdmin to gate three entire tabs (Overview, Borrowing,
 * Overdue) plus four individual write actions inside CataloguePane — a
 * known, separately-documented simplification (§11 Session 20 entry) now
 * replaced with the real library.* catalog keys. Two structural findings
 * that changed the shape of this conversion versus every prior module:
 *
 * (1) BorrowingPane and OverduePane never received an isAdmin/permission
 * prop at all — their entire write surface (checkout, return, issue fine,
 * update fine) was gated ONLY by the parent tab-bar's adminOnly filter, not
 * by any check inside the pane itself. The permission boundary has moved
 * from the tab bar into each pane directly (can('library.physical.manage')
 * / can('library.physical.fines')), so a staff member without the relevant
 * key now sees the tab but gets a real read-only/blocked state inside it,
 * matching §4.3 progressive disclosure and the fail-gracefully principle
 * from §4.12 — not just a door that either fully opens or doesn't exist.
 *
 * (2) handleMarkLost (CataloguePane) had NO gate at all in the original
 * file, unlike its three sibling write actions in the same component — a
 * real pre-existing gap, same class as GuardianModule.tsx's ungated
 * access-toggle and ResultsModule.tsx's ungated score cells. Now gated on
 * library.physical.manage, consistent with the other three CataloguePane
 * write actions.
 *
 * Overview tab now requires library.physical.view (read access to physical
 * library data) rather than isAdmin — it is stats/reporting, not a write
 * surface, so the .view key is the correct fit, not .manage.
 *
 * (3) OverduePane's "Issue fine" control and "Mark paid"/"Waive" actions had
 * handler-level canManageFines guards but were not visually gated — every
 * other write action in this file hides the control itself, not just blocks
 * the handler. Fixed to match, for consistency with §4.3/§4.12 discipline.
 */

import { useState, useEffect, useCallback } from 'react'
import { useAuthStore } from '../stores/authStore'
import { supabase } from '../lib/supabase'
import {
  loadBookTitles,
  createBookTitle,
  updateBookTitle,
  loadCopiesForTitle,
  addBookCopy,
  updateCopyStatus,
  loadActiveBorrows,
  loadOverdueBorrows,
  checkoutBook,
  returnBook,
  createFine,
  updateFineStatus,
  loadUnpaidFines,
  loadDigitalResources,
  loadSubjectTags,
  loadLibraryStats,
  findCopyByBarcode,
  type BookTitle,
  type BookCopy,
  type BorrowRecord,
  type LibraryFine,
  type DigitalResource,
  type SubjectTag,
  type LibraryStats,
} from '../services/libraryService'

// ─── Types ─────────────────────────────────────────────────────────────────

type LibTab = 'overview' | 'catalogue' | 'borrowing' | 'overdue' | 'digital'

interface Subject {
  id: string
  name: string
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-NG', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

function formatNaira(amount: number): string {
  return amount.toLocaleString('en-NG', { style: 'currency', currency: 'NGN', maximumFractionDigits: 0 })
}

function daysOverdue(dueDate: string): number {
  const diff = Date.now() - new Date(dueDate).getTime()
  return Math.floor(diff / 86_400_000)
}

// ─── Root component ─────────────────────────────────────────────────────────

export default function LibraryModule({
  schoolId,
  isAdmin,
  authUserId,
}: {
  schoolId: string
  isAdmin: boolean
  authUserId: string
}) {
  const can = useAuthStore((s) => s.can)
  const canViewLibrary   = can('library.physical.view')   || isAdmin
  const canManageLibrary = can('library.physical.manage') || isAdmin
  const canManageFines   = can('library.physical.fines')  || isAdmin

  const [activeTab, setActiveTab] = useState<LibTab>('overview')

  // requiredKey: which permission gates this tab's visibility. Catalogue
  // and Digital have none — per the header comment, Catalogue is always
  // visible (read-only for non-managers), Digital is open to all users.
  const tabs: { key: LibTab; label: string; visible: boolean }[] = [
    { key: 'overview',   label: 'Overview',   visible: canViewLibrary },
    { key: 'catalogue',  label: 'Catalogue',  visible: true },
    { key: 'borrowing',  label: 'Borrowing',  visible: canManageLibrary },
    { key: 'overdue',    label: 'Overdue',    visible: canManageFines },
    { key: 'digital',    label: 'Digital',    visible: true },
  ]

  const visibleTabs = tabs.filter((t) => t.visible)

  // If a non-admin somehow lands on a restricted tab, reset to catalogue
  const safeTab = visibleTabs.find((t) => t.key === activeTab) ? activeTab : 'catalogue'

  return (
    <div className="lib-root">
      {/* Tab bar */}
      <div className="lib-tab-bar">
        {visibleTabs.map((t) => (
          <button
            key={t.key}
            className={`lib-tab-btn${safeTab === t.key ? ' lib-tab-btn--active' : ''}`}
            onClick={() => setActiveTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Pane */}
      <div className="lib-pane">
        {safeTab === 'overview' && <OverviewPane schoolId={schoolId} />}
        {safeTab === 'catalogue' && (
          <CataloguePane schoolId={schoolId} canManage={canManageLibrary} />
        )}
        {safeTab === 'borrowing' && (
          <BorrowingPane schoolId={schoolId} authUserId={authUserId} canManage={canManageLibrary} />
        )}
        {safeTab === 'overdue' && <OverduePane schoolId={schoolId} canManageFines={canManageFines} />}
        {safeTab === 'digital' && <DigitalPane />}
      </div>
    </div>
  )
}

// ─── Overview pane ──────────────────────────────────────────────────────────

function OverviewPane({ schoolId }: { schoolId: string }) {
  const [stats, setStats] = useState<LibraryStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    loadLibraryStats(schoolId)
      .then(setStats)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [schoolId])

  if (loading) {
    return (
      <div className="lib-stats-grid">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="lib-stat-card skeleton-card" />
        ))}
      </div>
    )
  }

  if (error || !stats) {
    return (
      <div className="lib-error">
        <span className="lib-error-icon">⚠️</span>
        <p>{error ?? 'Could not load library overview.'}</p>
      </div>
    )
  }

  const cards = [
    { label: 'Total titles', value: stats.total_titles, icon: '📖', accent: 'blue' },
    { label: 'Total copies', value: stats.total_copies, icon: '📚', accent: 'teal' },
    { label: 'Available', value: stats.available_copies, icon: '✅', accent: 'green' },
    { label: 'Borrowed', value: stats.borrowed_copies, icon: '🔄', accent: 'amber' },
    { label: 'Overdue', value: stats.overdue_count, icon: '⏰', accent: stats.overdue_count > 0 ? 'red' : 'neutral' },
    { label: 'Unpaid fines', value: stats.unpaid_fines, icon: '💰', accent: stats.unpaid_fines > 0 ? 'red' : 'neutral' },
  ]

  return (
    <div className="lib-overview">
      <div className="lib-stats-grid">
        {cards.map((c) => (
          <div key={c.label} className={`lib-stat-card lib-stat-card--${c.accent}`}>
            <span className="lib-stat-icon">{c.icon}</span>
            <div className="lib-stat-body">
              <span className="lib-stat-value">{c.value}</span>
              <span className="lib-stat-label">{c.label}</span>
            </div>
          </div>
        ))}
      </div>

      {(stats.overdue_count > 0 || stats.unpaid_fines > 0) && (
        <div className="lib-overview-alerts">
          {stats.overdue_count > 0 && (
            <div className="lib-alert lib-alert--warn">
              <span>⏰</span>
              <span>
                {stats.overdue_count} book{stats.overdue_count !== 1 ? 's are' : ' is'} overdue.
                Check the <strong>Overdue</strong> tab to follow up.
              </span>
            </div>
          )}
          {stats.unpaid_fines > 0 && (
            <div className="lib-alert lib-alert--warn">
              <span>💰</span>
              <span>
                {stats.unpaid_fines} unpaid fine{stats.unpaid_fines !== 1 ? 's' : ''} outstanding.
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Catalogue pane ─────────────────────────────────────────────────────────

function CataloguePane({
  schoolId,
  canManage,
}: {
  schoolId: string
  canManage: boolean
}) {
  const [books, setBooks] = useState<BookTitle[]>([])
  const [subjects, setSubjects] = useState<Subject[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  // Title form
  const [showTitleForm, setShowTitleForm] = useState(false)
  const [editingTitle, setEditingTitle] = useState<BookTitle | null>(null)
  const [titleForm, setTitleForm] = useState({ title: '', author: '', isbn: '', subject_id: '', cover_url: '' })
  const [titleSaving, setTitleSaving] = useState(false)
  const [titleError, setTitleError] = useState<string | null>(null)

  // Copy drawer
  const [openCopiesFor, setOpenCopiesFor] = useState<BookTitle | null>(null)
  const [copies, setCopies] = useState<BookCopy[]>([])
  const [copiesLoading, setCopiesLoading] = useState(false)
  const [addCopyBarcode, setAddCopyBarcode] = useState('')
  const [addCopyCondition, setAddCopyCondition] = useState('good')
  const [addCopyError, setAddCopyError] = useState<string | null>(null)
  const [addCopySaving, setAddCopySaving] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    Promise.all([
      loadBookTitles(schoolId),
      supabase.from('subjects').select('id, name').eq('school_id', schoolId).order('name'),
    ])
      .then(([booksData, subjectsRes]) => {
        setBooks(booksData)
        setSubjects((subjectsRes.data ?? []) as Subject[])
        setError(null)
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [schoolId])

  useEffect(() => { load() }, [load])

  function openAddTitle() {
    setEditingTitle(null)
    setTitleForm({ title: '', author: '', isbn: '', subject_id: '', cover_url: '' })
    setTitleError(null)
    setShowTitleForm(true)
  }

  function openEditTitle(b: BookTitle) {
    setEditingTitle(b)
    setTitleForm({
      title: b.title,
      author: b.author ?? '',
      isbn: b.isbn ?? '',
      subject_id: b.subject_id ?? '',
      cover_url: b.cover_url ?? '',
    })
    setTitleError(null)
    setShowTitleForm(true)
  }

  async function handleSaveTitle() {
    if (!canManage) { setTitleError('You do not have permission to manage the catalogue.'); return }
    if (!titleForm.title.trim()) { setTitleError('Book title is required.'); return }
    setTitleSaving(true); setTitleError(null)
    try {
      const input = {
        title: titleForm.title,
        author: titleForm.author,
        isbn: titleForm.isbn,
        subject_id: titleForm.subject_id || null,
        cover_url: titleForm.cover_url || null,
      }
      if (editingTitle) {
        await updateBookTitle(editingTitle.id, input)
        setBooks((prev) => prev.map((b) =>
          b.id === editingTitle.id
            ? {
                ...b,
                ...input,
                subject_name: subjects.find((s) => s.id === input.subject_id)?.name ?? null,
              }
            : b
        ))
      } else {
        const created = await createBookTitle(schoolId, input)
        setBooks((prev) => [created, ...prev])
      }
      setShowTitleForm(false)
    } catch (e) {
      setTitleError((e as Error).message)
    } finally {
      setTitleSaving(false)
    }
  }

  async function openCopies(b: BookTitle) {
    setOpenCopiesFor(b)
    setAddCopyBarcode('')
    setAddCopyCondition('good')
    setAddCopyError(null)
    setCopiesLoading(true)
    try {
      const data = await loadCopiesForTitle(b.id)
      setCopies(data)
    } catch (e) {
      setAddCopyError((e as Error).message)
    } finally {
      setCopiesLoading(false)
    }
  }

  async function handleAddCopy() {
    if (!openCopiesFor) return
    if (!canManage) { setAddCopyError('You do not have permission to add copies.'); return }
    setAddCopySaving(true); setAddCopyError(null)
    try {
      const copy = await addBookCopy(schoolId, {
        book_title_id: openCopiesFor.id,
        barcode: addCopyBarcode,
        condition: addCopyCondition,
      })
      setCopies((prev) => [...prev, copy])
      setBooks((prev) => prev.map((b) =>
        b.id === openCopiesFor.id
          ? { ...b, total_copies: b.total_copies + 1, available_copies: b.available_copies + 1 }
          : b
      ))
      setAddCopyBarcode('')
    } catch (e) {
      setAddCopyError((e as Error).message)
    } finally {
      setAddCopySaving(false)
    }
  }

  async function handleMarkLost(copy: BookCopy) {
    if (!canManage) {
      setAddCopyError('You do not have permission to update copy status.')
      return
    }
    try {
      await updateCopyStatus(copy.id, 'lost')
      setCopies((prev) => prev.map((c) => c.id === copy.id ? { ...c, status: 'lost' } : c))
      setBooks((prev) => prev.map((b) =>
        b.id === openCopiesFor?.id
          ? {
              ...b,
              available_copies: copy.status === 'available'
                ? b.available_copies - 1
                : b.available_copies,
            }
          : b
      ))
    } catch (e) {
      setAddCopyError((e as Error).message)
    }
  }

  const filtered = books.filter((b) =>
    b.title.toLowerCase().includes(search.toLowerCase()) ||
    (b.author ?? '').toLowerCase().includes(search.toLowerCase()) ||
    (b.isbn ?? '').includes(search)
  )

  if (loading) {
    return (
      <div className="lib-list">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="lib-book-row skeleton-row" />
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <div className="lib-error">
        <span className="lib-error-icon">⚠️</span>
        <p>{error}</p>
        <button className="lib-retry-btn" onClick={load}>Retry</button>
      </div>
    )
  }

  return (
    <div className="lib-catalogue">
      {/* Title add/edit form sheet */}
      {showTitleForm && (
        <div className="lib-sheet-overlay" onClick={() => setShowTitleForm(false)}>
          <div className="lib-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="lib-sheet-header">
              <h2 className="lib-sheet-title">{editingTitle ? 'Edit book' : 'Add book'}</h2>
              <button className="lib-sheet-close" onClick={() => setShowTitleForm(false)}>✕</button>
            </div>
            <div className="lib-form">
              <label className="lib-label">Title <span className="lib-required">*</span></label>
              <input
                className="lib-input"
                value={titleForm.title}
                onChange={(e) => setTitleForm((f) => ({ ...f, title: e.target.value }))}
                placeholder="e.g. New General Mathematics"
                autoFocus
              />
              <label className="lib-label">Author</label>
              <input
                className="lib-input"
                value={titleForm.author}
                onChange={(e) => setTitleForm((f) => ({ ...f, author: e.target.value }))}
                placeholder="e.g. M. F. Macrae"
              />
              <label className="lib-label">ISBN</label>
              <input
                className="lib-input"
                value={titleForm.isbn}
                onChange={(e) => setTitleForm((f) => ({ ...f, isbn: e.target.value }))}
                placeholder="Optional"
                inputMode="numeric"
              />
              <label className="lib-label">Subject</label>
              <select
                className="lib-select"
                value={titleForm.subject_id}
                onChange={(e) => setTitleForm((f) => ({ ...f, subject_id: e.target.value }))}
              >
                <option value="">— None —</option>
                {subjects.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
              {titleError && <p className="lib-field-error">{titleError}</p>}
              <div className="lib-form-actions">
                <button
                  className="lib-btn lib-btn--primary"
                  onClick={handleSaveTitle}
                  disabled={titleSaving}
                >
                  {titleSaving ? 'Saving…' : editingTitle ? 'Save changes' : 'Add book'}
                </button>
                <button
                  className="lib-btn lib-btn--ghost"
                  onClick={() => setShowTitleForm(false)}
                  disabled={titleSaving}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Copy management drawer */}
      {openCopiesFor && (
        <div className="lib-sheet-overlay" onClick={() => setOpenCopiesFor(null)}>
          <div className="lib-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="lib-sheet-header">
              <h2 className="lib-sheet-title">Copies — {openCopiesFor.title}</h2>
              <button className="lib-sheet-close" onClick={() => setOpenCopiesFor(null)}>✕</button>
            </div>
            <div className="lib-form">
              {copiesLoading ? (
                <div className="lib-copies-loading">Loading copies…</div>
              ) : (
                <>
                  {copies.length === 0 ? (
                    <p className="lib-empty-inline">No copies registered yet — add one below.</p>
                  ) : (
                    <div className="lib-copies-list">
                      {copies.map((c) => (
                        <div key={c.id} className="lib-copy-row">
                          <div className="lib-copy-info">
                            <span className="lib-copy-barcode">{c.barcode ?? '(no barcode)'}</span>
                            <span className={`lib-copy-status lib-copy-status--${c.status}`}>
                              {c.status}
                            </span>
                            <span className="lib-copy-condition">{c.condition}</span>
                          </div>
                          {canManage && c.status === 'available' && (
                            <button
                              className="lib-copy-lost-btn"
                              onClick={() => handleMarkLost(c)}
                            >
                              Mark lost
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {canManage && (
                    <>
                      <p className="lib-section-label">Add a copy</p>
                      <label className="lib-label">Barcode</label>
                      <input
                        className="lib-input"
                        value={addCopyBarcode}
                        onChange={(e) => setAddCopyBarcode(e.target.value)}
                        placeholder="Scan or type barcode (optional)"
                      />
                      <label className="lib-label">Condition</label>
                      <select
                        className="lib-select"
                        value={addCopyCondition}
                        onChange={(e) => setAddCopyCondition(e.target.value)}
                      >
                        <option value="good">Good</option>
                        <option value="fair">Fair</option>
                        <option value="poor">Poor</option>
                      </select>
                      {addCopyError && <p className="lib-field-error">{addCopyError}</p>}
                      <button
                        className="lib-btn lib-btn--primary"
                        onClick={handleAddCopy}
                        disabled={addCopySaving}
                      >
                        {addCopySaving ? 'Adding…' : 'Add copy'}
                      </button>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Search + add row */}
      <div className="lib-toolbar">
        <input
          className="lib-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by title, author, or ISBN…"
        />
        {canManage && (
          <button className="lib-btn lib-btn--primary lib-btn--sm" onClick={openAddTitle}>
            + Add book
          </button>
        )}
      </div>

      {/* Book list */}
      {filtered.length === 0 ? (
        <div className="lib-empty">
          <span className="lib-empty-icon">📖</span>
          <p className="lib-empty-msg">
            {books.length === 0
              ? 'No books in the catalogue yet. Add your first book to get started.'
              : 'No books match your search.'}
          </p>
          {canManage && books.length === 0 && (
            <button className="lib-btn lib-btn--primary" onClick={openAddTitle}>Add first book</button>
          )}
        </div>
      ) : (
        <div className="lib-book-list">
          {filtered.map((b) => (
            <div key={b.id} className="lib-book-row">
              <div className="lib-book-spine">
                <div className="lib-book-cover">
                  {b.cover_url
                    ? <img src={b.cover_url} alt={b.title} className="lib-book-cover-img" />
                    : <span className="lib-book-cover-placeholder">📖</span>
                  }
                </div>
              </div>
              <div className="lib-book-meta">
                <p className="lib-book-title">{b.title}</p>
                {b.author && <p className="lib-book-author">{b.author}</p>}
                {b.subject_name && (
                  <span className="lib-book-subject">{b.subject_name}</span>
                )}
                <div className="lib-book-copies-row">
                  <span className="lib-copies-badge lib-copies-badge--available">
                    {b.available_copies} available
                  </span>
                  <span className="lib-copies-badge lib-copies-badge--total">
                    {b.total_copies} total
                  </span>
                </div>
              </div>
              <div className="lib-book-actions">
                <button
                  className="lib-icon-btn"
                  onClick={() => openCopies(b)}
                  title="Manage copies"
                >
                  📋
                </button>
                {canManage && (
                  <button
                    className="lib-icon-btn"
                    onClick={() => openEditTitle(b)}
                    title="Edit book details"
                  >
                    ✏️
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Borrowing pane ─────────────────────────────────────────────────────────

function BorrowingPane({
  schoolId,
  authUserId,
  canManage,
}: {
  schoolId: string
  authUserId: string
  canManage: boolean
}) {
  const [borrows, setBorrows] = useState<BorrowRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<'active' | 'checkout'>('active')

  // Checkout form state
  const [barcodeInput, setBarcodeInput] = useState('')
  const [copyFound, setCopyFound] = useState<{ id: string; title: string; barcode: string | null; status: string } | null>(null)
  const [copySearchError, setCopySearchError] = useState<string | null>(null)
  const [copySearching, setCopySearching] = useState(false)
  const [borrowerType, setBorrowerType] = useState<'student' | 'staff'>('student')
  const [borrowerSearch, setBorrowerSearch] = useState('')
  const [borrowerResults, setBorrowerResults] = useState<{ id: string; name: string }[]>([])
  const [selectedBorrower, setSelectedBorrower] = useState<{ id: string; name: string } | null>(null)
  const [dueDate, setDueDate] = useState('')
  const [checkoutError, setCheckoutError] = useState<string | null>(null)
  const [checkoutSaving, setCheckoutSaving] = useState(false)

  // Return state
  const [returningId, setReturningId] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    loadActiveBorrows(schoolId)
      .then((data) => { setBorrows(data); setError(null) })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [schoolId])

  useEffect(() => { load() }, [load])

  // Default due date = 14 days from today
  useEffect(() => {
    const d = new Date()
    d.setDate(d.getDate() + 14)
    setDueDate(d.toISOString().slice(0, 10))
  }, [])

  async function handleBarcodeSearch() {
    if (!barcodeInput.trim()) return
    setCopySearching(true); setCopySearchError(null); setCopyFound(null)
    try {
      const result = await findCopyByBarcode(schoolId, barcodeInput.trim())
      if (!result) {
        setCopySearchError('No copy found with that barcode in this school.')
      } else {
        setCopyFound({ id: result.id, title: result.title, barcode: result.barcode, status: result.status })
        if (result.status !== 'available') {
          setCopySearchError(`This copy is currently "${result.status}" and cannot be checked out.`)
        }
      }
    } catch (e) {
      setCopySearchError((e as Error).message)
    } finally {
      setCopySearching(false)
    }
  }

  useEffect(() => {
    if (!borrowerSearch.trim() || borrowerSearch.length < 2) {
      setBorrowerResults([]); return
    }
    const table = borrowerType === 'student' ? 'students' : 'staff'
    const timer = setTimeout(async () => {
      const { data } = await supabase
        .from(table)
        .select('id, full_name')
        .eq('school_id', schoolId)
        .ilike('full_name', `%${borrowerSearch}%`)
        .eq('status', 'active')
        .limit(8)
      setBorrowerResults((data ?? []).map((r: { id: string; full_name: string }) => ({ id: r.id, name: r.full_name })))
    }, 300)
    return () => clearTimeout(timer)
  }, [borrowerSearch, borrowerType, schoolId])

  async function handleCheckout() {
    if (!canManage) {
      setCheckoutError('You do not have permission to check out books.'); return
    }
    if (!copyFound || copyFound.status !== 'available') {
      setCheckoutError('Please scan a valid, available copy first.'); return
    }
    if (!selectedBorrower) {
      setCheckoutError('Please select a borrower.'); return
    }
    if (!dueDate) {
      setCheckoutError('Please set a due date.'); return
    }

    setCheckoutSaving(true); setCheckoutError(null)
    try {
      // Resolve staff.id for issued_by (same pattern as financeService)
      const { data: identity } = await supabase
        .from('app_identities')
        .select('actor_record_id, actor_type')
        .eq('auth_user_id', authUserId)
        .maybeSingle()

      const issuedBy = identity?.actor_type === 'staff' ? identity.actor_record_id : null
      if (!issuedBy) throw new Error('Only staff can check out books. Your account does not have a staff record.')

      const record = await checkoutBook(schoolId, {
        book_copy_id: copyFound.id,
        borrower_type: borrowerType,
        borrower_id: selectedBorrower.id,
        due_date: dueDate,
        issued_by_staff_id: issuedBy,
      })
      setBorrows((prev) => [{ ...record, book_title: copyFound.title, student_name: borrowerType === 'student' ? selectedBorrower.name : null, staff_name: borrowerType === 'staff' ? selectedBorrower.name : null }, ...prev])

      // Reset form
      setBarcodeInput('')
      setCopyFound(null)
      setBorrowerSearch('')
      setSelectedBorrower(null)
      const d = new Date(); d.setDate(d.getDate() + 14)
      setDueDate(d.toISOString().slice(0, 10))
      setView('active')
    } catch (e) {
      setCheckoutError((e as Error).message)
    } finally {
      setCheckoutSaving(false)
    }
  }

  async function handleReturn(b: BorrowRecord) {
    if (!canManage) {
      alert('You do not have permission to return books.'); return
    }
    setReturningId(b.id)
    try {
      await returnBook(b.id, b.book_copy_id)
      setBorrows((prev) => prev.filter((r) => r.id !== b.id))
    } catch (e) {
      alert((e as Error).message)
    } finally {
      setReturningId(null)
    }
  }

  if (loading) {
    return (
      <div className="lib-list">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="lib-borrow-row skeleton-row" />
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <div className="lib-error">
        <span className="lib-error-icon">⚠️</span>
        <p>{error}</p>
        <button className="lib-retry-btn" onClick={load}>Retry</button>
      </div>
    )
  }

  return (
    <div className="lib-borrowing">
      <div className="lib-borrow-view-toggle">
        <button
          className={`lib-toggle-btn${view === 'active' ? ' lib-toggle-btn--active' : ''}`}
          onClick={() => setView('active')}
        >
          Active ({borrows.length})
        </button>
        {canManage && (
          <button
            className={`lib-toggle-btn${view === 'checkout' ? ' lib-toggle-btn--active' : ''}`}
            onClick={() => setView('checkout')}
          >
            Check out book
          </button>
        )}
      </div>

      {view === 'active' ? (
        borrows.length === 0 ? (
          <div className="lib-empty">
            <span className="lib-empty-icon">📚</span>
            <p className="lib-empty-msg">No books are currently borrowed.</p>
          </div>
        ) : (
          <div className="lib-borrow-list">
            {borrows.map((b) => (
              <div key={b.id} className={`lib-borrow-row${b.is_overdue ? ' lib-borrow-row--overdue' : ''}`}>
                <div className="lib-borrow-info">
                  <p className="lib-borrow-book">{b.book_title}</p>
                  <p className="lib-borrow-borrower">
                    {b.student_name ?? b.staff_name ?? 'Unknown borrower'}
                    {b.barcode && <span className="lib-borrow-barcode"> · {b.barcode}</span>}
                  </p>
                  <p className={`lib-borrow-due${b.is_overdue ? ' lib-borrow-due--overdue' : ''}`}>
                    {b.is_overdue
                      ? `Overdue by ${daysOverdue(b.due_date)} day${daysOverdue(b.due_date) !== 1 ? 's' : ''}`
                      : `Due ${formatDate(b.due_date)}`}
                  </p>
                </div>
                {canManage && (
                  <button
                    className="lib-btn lib-btn--sm lib-btn--return"
                    onClick={() => handleReturn(b)}
                    disabled={returningId === b.id}
                  >
                    {returningId === b.id ? '…' : 'Return'}
                  </button>
                )}
              </div>
            ))}
          </div>
        )
      ) : (
        <div className="lib-checkout-form">
          {/* Step 1: barcode */}
          <p className="lib-section-label">1. Scan or enter barcode</p>
          <div className="lib-barcode-row">
            <input
              className="lib-input lib-input--barcode"
              value={barcodeInput}
              onChange={(e) => setBarcodeInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleBarcodeSearch()}
              placeholder="Barcode…"
            />
            <button
              className="lib-btn lib-btn--primary"
              onClick={handleBarcodeSearch}
              disabled={copySearching}
            >
              {copySearching ? '…' : 'Find'}
            </button>
          </div>
          {copySearchError && <p className="lib-field-error">{copySearchError}</p>}
          {copyFound && copyFound.status === 'available' && (
            <div className="lib-copy-found">
              <span className="lib-copy-found-icon">✅</span>
              <div>
                <p className="lib-copy-found-title">{copyFound.title}</p>
                <p className="lib-copy-found-sub">
                  {copyFound.barcode ?? 'no barcode'} · available
                </p>
              </div>
            </div>
          )}

          {/* Step 2: borrower */}
          <p className="lib-section-label">2. Borrower</p>
          <div className="lib-borrower-type-row">
            <button
              className={`lib-toggle-btn${borrowerType === 'student' ? ' lib-toggle-btn--active' : ''}`}
              onClick={() => { setBorrowerType('student'); setSelectedBorrower(null); setBorrowerSearch('') }}
            >
              Student
            </button>
            <button
              className={`lib-toggle-btn${borrowerType === 'staff' ? ' lib-toggle-btn--active' : ''}`}
              onClick={() => { setBorrowerType('staff'); setSelectedBorrower(null); setBorrowerSearch('') }}
            >
              Staff
            </button>
          </div>
          {selectedBorrower ? (
            <div className="lib-copy-found">
              <span className="lib-copy-found-icon">👤</span>
              <div>
                <p className="lib-copy-found-title">{selectedBorrower.name}</p>
                <p className="lib-copy-found-sub">{borrowerType}</p>
              </div>
              <button className="lib-clear-btn" onClick={() => { setSelectedBorrower(null); setBorrowerSearch('') }}>✕</button>
            </div>
          ) : (
            <>
              <input
                className="lib-input"
                value={borrowerSearch}
                onChange={(e) => setBorrowerSearch(e.target.value)}
                placeholder={`Search ${borrowerType} name…`}
              />
              {borrowerResults.length > 0 && (
                <div className="lib-borrower-results">
                  {borrowerResults.map((r) => (
                    <button
                      key={r.id}
                      className="lib-borrower-result-row"
                      onClick={() => { setSelectedBorrower(r); setBorrowerResults([]); setBorrowerSearch('') }}
                    >
                      {r.name}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}

          {/* Step 3: due date */}
          <p className="lib-section-label">3. Due date</p>
          <input
            className="lib-input"
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            min={new Date().toISOString().slice(0, 10)}
          />

          {checkoutError && <p className="lib-field-error">{checkoutError}</p>}

          <button
            className="lib-btn lib-btn--primary lib-btn--full"
            onClick={handleCheckout}
            disabled={checkoutSaving}
          >
            {checkoutSaving ? 'Checking out…' : 'Confirm checkout'}
          </button>
        </div>
      )}
    </div>
  )
}

// ─── Overdue pane ────────────────────────────────────────────────────────────

function OverduePane({ schoolId, canManageFines }: { schoolId: string; canManageFines: boolean }) {
  const [borrows, setBorrows] = useState<BorrowRecord[]>([])
  const [fines, setFines] = useState<(LibraryFine & { borrower_name: string; book_title: string })[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [fineAmount, setFineAmount] = useState<Record<string, string>>({})
  const [fineCreating, setFineCreating] = useState<string | null>(null)
  const [fineUpdating, setFineUpdating] = useState<string | null>(null)
  const [view, setView] = useState<'overdue' | 'fines'>('overdue')

  const load = useCallback(() => {
    setLoading(true)
    Promise.all([loadOverdueBorrows(schoolId), loadUnpaidFines(schoolId)])
      .then(([b, f]) => { setBorrows(b); setFines(f); setError(null) })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [schoolId])

  useEffect(() => { load() }, [load])

  async function handleIssueFine(b: BorrowRecord) {
    if (!canManageFines) { alert('You do not have permission to issue fines.'); return }
    const amount = parseFloat(fineAmount[b.id] ?? '0')
    if (!amount || amount <= 0) { alert('Enter a fine amount greater than 0.'); return }
    setFineCreating(b.id)
    try {
      await createFine(schoolId, { borrow_record_id: b.id, amount })
      setBorrows((prev) => prev.map((r) =>
        r.id === b.id ? { ...r, fine: { id: '', school_id: schoolId, borrow_record_id: b.id, amount, status: 'unpaid', created_at: '' } } : r
      ))
      setFineAmount((prev) => ({ ...prev, [b.id]: '' }))
    } catch (e) {
      alert((e as Error).message)
    } finally {
      setFineCreating(null)
    }
  }

  async function handleUpdateFine(fineId: string, status: LibraryFine['status']) {
    if (!canManageFines) { alert('You do not have permission to update fines.'); return }
    setFineUpdating(fineId)
    try {
      await updateFineStatus(fineId, status)
      setFines((prev) => prev.filter((f) => f.id !== fineId))
    } catch (e) {
      alert((e as Error).message)
    } finally {
      setFineUpdating(null)
    }
  }

  if (loading) {
    return (
      <div className="lib-list">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="lib-borrow-row skeleton-row" />
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <div className="lib-error">
        <span className="lib-error-icon">⚠️</span>
        <p>{error}</p>
        <button className="lib-retry-btn" onClick={load}>Retry</button>
      </div>
    )
  }

  return (
    <div className="lib-overdue">
      <div className="lib-borrow-view-toggle">
        <button
          className={`lib-toggle-btn${view === 'overdue' ? ' lib-toggle-btn--active' : ''}`}
          onClick={() => setView('overdue')}
        >
          Overdue ({borrows.length})
        </button>
        <button
          className={`lib-toggle-btn${view === 'fines' ? ' lib-toggle-btn--active' : ''}`}
          onClick={() => setView('fines')}
        >
          Unpaid fines ({fines.length})
        </button>
      </div>

      {view === 'overdue' ? (
        borrows.length === 0 ? (
          <div className="lib-empty">
            <span className="lib-empty-icon">✅</span>
            <p className="lib-empty-msg">No overdue books. Good.</p>
          </div>
        ) : (
          <div className="lib-borrow-list">
            {borrows.map((b) => (
              <div key={b.id} className="lib-borrow-row lib-borrow-row--overdue">
                <div className="lib-borrow-info">
                  <p className="lib-borrow-book">{b.book_title}</p>
                  <p className="lib-borrow-borrower">
                    {b.student_name ?? b.staff_name ?? 'Unknown borrower'}
                  </p>
                  <p className="lib-borrow-due lib-borrow-due--overdue">
                    {daysOverdue(b.due_date)} day{daysOverdue(b.due_date) !== 1 ? 's' : ''} overdue
                    · due {formatDate(b.due_date)}
                  </p>
                  {!b.fine ? (
                    canManageFines && (
                      <div className="lib-fine-issue-row">
                        <input
                          className="lib-input lib-input--fine"
                          type="number"
                          min="0"
                          step="50"
                          value={fineAmount[b.id] ?? ''}
                          onChange={(e) => setFineAmount((prev) => ({ ...prev, [b.id]: e.target.value }))}
                          placeholder="Fine ₦"
                          inputMode="decimal"
                        />
                        <button
                          className="lib-btn lib-btn--sm lib-btn--warn"
                          onClick={() => handleIssueFine(b)}
                          disabled={fineCreating === b.id}
                        >
                          {fineCreating === b.id ? '…' : 'Issue fine'}
                        </button>
                      </div>
                    )
                  ) : (
                    <span className="lib-fine-badge">Fine issued · {formatNaira(b.fine.amount)}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )
      ) : (
        fines.length === 0 ? (
          <div className="lib-empty">
            <span className="lib-empty-icon">✅</span>
            <p className="lib-empty-msg">No unpaid fines at the moment.</p>
          </div>
        ) : (
          <div className="lib-borrow-list">
            {fines.map((f) => (
              <div key={f.id} className="lib-borrow-row">
                <div className="lib-borrow-info">
                  <p className="lib-borrow-book">{f.book_title}</p>
                  <p className="lib-borrow-borrower">{f.borrower_name}</p>
                  <p className="lib-fine-amount">{formatNaira(f.amount)} unpaid</p>
                </div>
                {canManageFines && (
                  <div className="lib-fine-actions">
                    <button
                      className="lib-btn lib-btn--sm lib-btn--primary"
                      onClick={() => handleUpdateFine(f.id, 'paid')}
                      disabled={fineUpdating === f.id}
                    >
                      {fineUpdating === f.id ? '…' : 'Mark paid'}
                    </button>
                    <button
                      className="lib-btn lib-btn--sm lib-btn--ghost"
                      onClick={() => handleUpdateFine(f.id, 'waived')}
                      disabled={fineUpdating === f.id}
                    >
                      Waive
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )
      )}
    </div>
  )
}

// ─── Digital resources pane ──────────────────────────────────────────────────

function DigitalPane() {
  const [resources, setResources] = useState<DigitalResource[]>([])
  const [tags, setTags] = useState<SubjectTag[]>([])
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  const load = useCallback(async (tagId?: string | null) => {
    setLoading(true)
    try {
      const [r, t] = await Promise.all([
        loadDigitalResources(tagId ?? undefined),
        tags.length === 0 ? loadSubjectTags() : Promise.resolve(tags),
      ])
      setResources(r)
      if (tags.length === 0) setTags(t)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => { load(null) }, [load])

  function handleTagFilter(tagId: string | null) {
    setActiveTag(tagId)
    load(tagId)
  }

  const resourceTypeIcon: Record<string, string> = {
    pdf: '📄',
    docx: '📝',
    image: '🖼️',
    embedded_link: '🔗',
    video: '🎥',
  }

  const filtered = resources.filter((r) =>
    r.title.toLowerCase().includes(search.toLowerCase()) ||
    (r.description ?? '').toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className="lib-digital">
      <div className="lib-digital-header">
        <p className="lib-digital-intro">
          Platform-wide learning resources — available to all schools.
        </p>
      </div>

      {/* Tag filter chips */}
      {tags.length > 0 && (
        <div className="lib-tag-chips">
          <button
            className={`lib-tag-chip${activeTag === null ? ' lib-tag-chip--active' : ''}`}
            onClick={() => handleTagFilter(null)}
          >
            All
          </button>
          {tags.map((t) => (
            <button
              key={t.id}
              className={`lib-tag-chip${activeTag === t.id ? ' lib-tag-chip--active' : ''}`}
              onClick={() => handleTagFilter(t.id)}
            >
              {t.name}
            </button>
          ))}
        </div>
      )}

      <input
        className="lib-search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search resources…"
        style={{ marginBottom: '0.75rem' }}
      />

      {loading ? (
        <div className="lib-list">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="lib-resource-card skeleton-row" />
          ))}
        </div>
      ) : error ? (
        <div className="lib-error">
          <span className="lib-error-icon">⚠️</span>
          <p>{error}</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="lib-empty">
          <span className="lib-empty-icon">🔍</span>
          <p className="lib-empty-msg">
            {resources.length === 0
              ? 'No digital resources have been uploaded yet.'
              : 'No resources match your search.'}
          </p>
        </div>
      ) : (
        <div className="lib-resource-list">
          {filtered.map((r) => (
            <div key={r.id} className="lib-resource-card">
              <div className="lib-resource-type-icon">
                {resourceTypeIcon[r.resource_type] ?? '📁'}
              </div>
              <div className="lib-resource-info">
                <p className="lib-resource-title">{r.title}</p>
                {r.description && <p className="lib-resource-desc">{r.description}</p>}
                {r.tags.length > 0 && (
                  <div className="lib-resource-tags">
                    {r.tags.map((tag) => (
                      <span key={tag} className="lib-resource-tag">{tag}</span>
                    ))}
                  </div>
                )}
              </div>
              {(r.file_url || r.embed_url) && (
                <a
                  href={r.file_url ?? r.embed_url ?? '#'}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="lib-resource-open-btn"
                >
                  Open ↗
                </a>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
