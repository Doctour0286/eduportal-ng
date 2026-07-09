/**
 * FinanceModule.tsx
 * Fee management: assignments, payments, student balance view, discounts.
 *
 * Props (same pattern as all other modules):
 *   schoolId  — passed from App.tsx via TabContent
 *   isAdmin   — true for staff/platform_admin actor types; retained on the props
 *               interface for now (App.tsx call site unverified this session) but
 *               NOT used for any gating or cosmetic copy in this file's body —
 *               all write gates below read real permission keys in-component via
 *               useAuthStore, matching the established Timetable/Attendance/
 *               Students pattern (PRD Tier 3 / Problem 3.1, Session 10):
 *     canManageFees      — finance.fees.manage  (fee heads + assignments: add, edit)
 *     canRecordPayments  — finance.payments.record (Record payment button + form)
 *     canApplyDiscounts  — finance.discounts.apply (Apply discount/waiver button + form)
 *
 * Views (tab-based at module level, not inside a detail panel):
 *   "Balances"    — all-students fee balance table; searchable + class-filterable
 *   "Assignments" — fee assignments for the current session/term; admin can add new
 *   "Fee heads"   — fee head list; admin can add new fee heads
 *
 * Detail panel (slide-up sheet, same chrome as StudentsModule):
 *   Tapping a student in Balances opens a 3-tab detail sheet:
 *     "Summary"  — breakdown of what they owe, paid, balance
 *     "Payments" — payment history; admin can record a new payment
 *     "Discounts"— applied discounts; admin can add a discount/waiver
 *
 * UX contract (§4):
 *   - Balance list loads skeleton first; computes client-side after three parallel queries
 *   - Balances with zero owed shown in muted style; outstanding balances in warning/danger
 *   - All money formatted as ₦ with two decimal places
 *   - Record Payment form is the daily-use action — it must be fast, one sheet, 3 fields
 *   - Session selector defaults to current session; term selector appears only when uses_terms
 *   - No irreversible actions without confirmation (discounts are not hard-deletable per §3.10
 *     — once applied they are permanent; UI warns clearly before applying)
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { useAuthStore } from '../stores/authStore'
import { Icon } from '../components/icons'
import {
  loadFeeHeads,
  loadCurrentSession,
  loadTermsForSession,
  loadFeeAssignments,
  loadStudentBalances,
  loadStudentPayments,
  loadStudentDiscounts,
  loadLeafClasses,
  createFeeHead,
  updateFeeHead,
  createFeeAssignment,
  recordPayment,
  createDiscount,
  buildClassPathMap,
  formatNaira,
  todayDateString,
  methodLabel,
  discountTypeLabel,
  type FeeHead,
  type Session,
  type Term,
  type FeeAssignment,
  type StudentBalance,
  type Payment,
  type Discount,
  type ClassNode,
  type PaymentMethod,
} from '../services/financeService'

// ─── Props ────────────────────────────────────────────────────────────────────

interface FinanceModuleProps {
  schoolId: string
  isAdmin: boolean
  /**
   * Optional intent forwarded from AdminDashboard's quick-action / App.tsx's
   * TabContent intent passthrough (PRD Problem 2.2c, Session 7b). Only
   * 'record_payment' is meaningful here: sorts the balances list outstanding-
   * first so the admin lands on students who actually owe money, reusing the
   * already-loaded `balances` state — no new query. Module still opens on
   * its normal Balances tab; no form is auto-opened since payment recording
   * is per-student (requires picking a student first).
   */
  intent?: 'add_student' | 'record_payment' | 'mark_attendance'
}

// ─── Load states ──────────────────────────────────────────────────────────────

type LoadState = 'booting' | 'loading' | 'ready' | 'empty' | 'error'

// ─── Module-level tabs ────────────────────────────────────────────────────────

type ModuleTab = 'balances' | 'assignments' | 'feeheads'

// ─── Student detail tabs ──────────────────────────────────────────────────────

type DetailTab = 'summary' | 'payments' | 'discounts'

// ─── Fee head form ─────────────────────────────────────────────────────────────

interface FeeHeadForm {
  name: string
  is_recurring: boolean
  default_amount: string
}

const EMPTY_FEE_HEAD_FORM: FeeHeadForm = {
  name: '',
  is_recurring: true,
  default_amount: '',
}

// ─── Assignment form ───────────────────────────────────────────────────────────

interface AssignmentForm {
  fee_head_id: string
  target_type: 'school_wide' | 'class_node' | 'student'
  class_node_id: string
  student_search: string
  student_id: string
  student_name: string
  amount: string
  term_id: string
  due_date: string
}

const EMPTY_ASSIGNMENT_FORM: AssignmentForm = {
  fee_head_id:    '',
  target_type:    'school_wide',
  class_node_id:  '',
  student_search: '',
  student_id:     '',
  student_name:   '',
  amount:         '',
  term_id:        '',
  due_date:       '',
}

// ─── Payment form ──────────────────────────────────────────────────────────────

interface PaymentForm {
  fee_assignment_id: string
  amount: string
  method: PaymentMethod
  paid_at: string
  provider_reference: string
  notes: string
}

// ─── Discount form ─────────────────────────────────────────────────────────────

interface DiscountForm {
  fee_assignment_id: string
  discount_type: 'percentage' | 'fixed_amount' | 'full_waiver'
  value: string
  reason: string
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function FinanceModule({ schoolId, intent }: FinanceModuleProps) {

  // ── Permissions (PRD Tier 3 / Problem 3.1, Session 10) ────────────────────
  // Read in-component via useAuthStore, matching Timetable/Attendance/Students —
  // not threaded as props from App.tsx.
  const canManageFees     = useAuthStore(s => s.can('finance.fees.manage'))
  const canRecordPayments = useAuthStore(s => s.can('finance.payments.record'))
  const canApplyDiscounts = useAuthStore(s => s.can('finance.discounts.apply'))

  // ── Boot data ─────────────────────────────────────────────────────────────
  const [classes,        setClasses]        = useState<ClassNode[]>([])
  const [classPathMap,   setClassPathMap]   = useState<Map<string, string>>(new Map())
  const [feeHeads,       setFeeHeads]       = useState<FeeHead[]>([])
  const [currentSession, setCurrentSession] = useState<Session | null>(null)
  const [terms,          setTerms]          = useState<Term[]>([])
  const [bootState,      setBootState]      = useState<LoadState>('booting')
  const [bootError,      setBootError]      = useState('')

  // ── Module tabs ────────────────────────────────────────────────────────────
  const [moduleTab, setModuleTab] = useState<ModuleTab>('balances')

  // ── Session / term selector ────────────────────────────────────────────────
  const [selectedTermId, setSelectedTermId] = useState<string>('')

  // ── Balances tab ───────────────────────────────────────────────────────────
  const [balances,       setBalances]       = useState<StudentBalance[]>([])
  const [balancesState,  setBalancesState]  = useState<LoadState>('booting')
  const [balancesError,  setBalancesError]  = useState('')
  const [filterClass,    setFilterClass]    = useState<string>('')
  const [searchQuery,    setSearchQuery]    = useState('')

  // ── Assignments tab ────────────────────────────────────────────────────────
  const [assignments,       setAssignments]       = useState<FeeAssignment[]>([])
  const [assignmentsState,  setAssignmentsState]  = useState<LoadState>('booting')
  const [assignmentsError,  setAssignmentsError]  = useState('')

  // ── Fee heads tab ──────────────────────────────────────────────────────────
  const [feeHeadsState,   setFeeHeadsState]   = useState<LoadState>('booting')
  const [feeHeadsError,   _setFeeHeadsError]  = useState('')

  // ── Add fee head form ──────────────────────────────────────────────────────
  const [feeHeadFormOpen,  setFeeHeadFormOpen]  = useState(false)
  const [feeHeadForm,      setFeeHeadForm]      = useState<FeeHeadForm>(EMPTY_FEE_HEAD_FORM)
  const [feeHeadSaving,    setFeeHeadSaving]    = useState(false)
  const [feeHeadError,     setFeeHeadError]     = useState('')
  const [editingFeeHeadId, setEditingFeeHeadId] = useState<string | null>(null)
  const feeHeadNameRef = useRef<HTMLInputElement>(null)

  // ── Add assignment form ────────────────────────────────────────────────────
  const [assignmentFormOpen, setAssignmentFormOpen] = useState(false)
  const [assignmentForm,     setAssignmentForm]     = useState<AssignmentForm>(EMPTY_ASSIGNMENT_FORM)
  const [assignmentSaving,   setAssignmentSaving]   = useState(false)
  const [assignmentError,    setAssignmentError]    = useState('')

  // ── Student detail panel ───────────────────────────────────────────────────
  const [detailBalance,   setDetailBalance]   = useState<StudentBalance | null>(null)
  const [detailTab,       setDetailTab]       = useState<DetailTab>('summary')

  // ── Summary tab (detail) ───────────────────────────────────────────────────
  const [detailPayments,      setDetailPayments]      = useState<Payment[]>([])
  const [detailDiscounts,     setDetailDiscounts]     = useState<Discount[]>([])
  const [detailDataState,     setDetailDataState]     = useState<LoadState>('booting')
  const [detailDataError,     setDetailDataError]     = useState('')

  // ── Record payment form ────────────────────────────────────────────────────
  const [paymentFormOpen, setPaymentFormOpen] = useState(false)
  const [paymentForm,     setPaymentForm]     = useState<PaymentForm>({
    fee_assignment_id: '',
    amount: '',
    method: 'cash',
    paid_at: todayDateString(),
    provider_reference: '',
    notes: '',
  })
  const [paymentSaving,   setPaymentSaving]   = useState(false)
  const [paymentError,    setPaymentError]    = useState('')
  const paymentAmountRef = useRef<HTMLInputElement>(null)

  // ── Add discount form ──────────────────────────────────────────────────────
  const [discountFormOpen, setDiscountFormOpen] = useState(false)
  const [discountForm,     setDiscountForm]     = useState<DiscountForm>({
    fee_assignment_id: '',
    discount_type: 'fixed_amount',
    value: '',
    reason: '',
  })
  const [discountConfirm,  setDiscountConfirm]  = useState(false)
  const [discountSaving,   setDiscountSaving]   = useState(false)
  const [discountError,    setDiscountError]    = useState('')

  // ─── Boot: parallel load of classes, fee heads, current session ────────────

  useEffect(() => {
    let cancelled = false
    async function boot() {
      setBootState('loading')
      const [classesRes, feeHeadsRes, sessionRes] = await Promise.all([
        loadLeafClasses(),
        loadFeeHeads(),
        loadCurrentSession(),
      ])
      if (cancelled) return

      if (!classesRes.ok) { setBootError(classesRes.error); setBootState('error'); return }
      if (!feeHeadsRes.ok) { setBootError(feeHeadsRes.error); setBootState('error'); return }
      if (!sessionRes.ok) { setBootError(sessionRes.error); setBootState('error'); return }

      const cpm = buildClassPathMap(classesRes.data)
      setClasses(classesRes.data)
      setClassPathMap(cpm)
      setFeeHeads(feeHeadsRes.data)
      setFeeHeadsState(feeHeadsRes.data.length === 0 ? 'empty' : 'ready')
      setCurrentSession(sessionRes.data)

      // Load terms if session exists, and eagerly load assignments so the
      // payment form fee-head dropdown is populated even before visiting the Assignments tab
      if (sessionRes.data) {
        const [termsRes, assignmentsRes] = await Promise.all([
          loadTermsForSession(sessionRes.data.id),
          loadFeeAssignments({ sessionId: sessionRes.data.id }),
        ])
        if (cancelled) return
        if (termsRes.ok) setTerms(termsRes.data)
        if (assignmentsRes.ok) {
          setAssignments(assignmentsRes.data)
          setAssignmentsState(assignmentsRes.data.length === 0 ? 'empty' : 'ready')
        }
      }

      setBootState('ready')
    }
    boot()
    return () => { cancelled = true }
  }, [])

  // ─── Load balances when boot is ready or filter changes ───────────────────

  const loadBalances = useCallback(async () => {
    if (!currentSession) {
      setBalancesState('empty')
      return
    }
    setBalancesState('loading')
    const res = await loadStudentBalances({
      sessionId:    currentSession.id,
      classNodeId:  filterClass || null,
      classPathMap,
    })
    if (!res.ok) {
      setBalancesError(res.error)
      setBalancesState('error')
      return
    }
    setBalances(res.data)
    setBalancesState(res.data.length === 0 ? 'empty' : 'ready')
  }, [currentSession, filterClass, classPathMap])

  useEffect(() => {
    if (bootState === 'ready') loadBalances()
  }, [bootState, loadBalances])

  // ─── Load assignments when switching to Assignments tab ───────────────────

  const loadAssignmentList = useCallback(async () => {
    if (!currentSession) { setAssignmentsState('empty'); return }
    setAssignmentsState('loading')
    const res = await loadFeeAssignments({
      sessionId: currentSession.id,
      termId:    selectedTermId || null,
    })
    if (!res.ok) {
      setAssignmentsError(res.error)
      setAssignmentsState('error')
      return
    }
    setAssignments(res.data)
    setAssignmentsState(res.data.length === 0 ? 'empty' : 'ready')
  }, [currentSession, selectedTermId])

  useEffect(() => {
    if (bootState === 'ready' && moduleTab === 'assignments') loadAssignmentList()
  }, [bootState, moduleTab, loadAssignmentList])

  // ─── Client-side search filter ────────────────────────────────────────────

  const filteredBalances = (searchQuery.trim()
    ? balances.filter(b =>
        b.student_name.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : balances
  ).slice().sort((a, b) => {
    if (intent !== 'record_payment') return 0
    // Outstanding-first per PRD Problem 2.2c / Session 7b — no new query,
    // just a stable client-side reorder of the already-loaded balances.
    const aOwes = a.balance > 0 ? 0 : 1
    const bOwes = b.balance > 0 ? 0 : 1
    return aOwes - bOwes
  })

  // ─── Open student detail panel ────────────────────────────────────────────

  async function openDetail(balance: StudentBalance) {
    setDetailBalance(balance)
    setDetailTab('summary')
    setDetailPayments([])
    setDetailDiscounts([])
    setDetailDataState('loading')
    setDetailDataError('')
    setPaymentFormOpen(false)
    setDiscountFormOpen(false)
    setDiscountConfirm(false)

    // Load payments and discounts in parallel
    const [paymentsRes, discountsRes] = await Promise.all([
      loadStudentPayments(balance.student_id),
      loadStudentDiscounts(balance.student_id, currentSession?.id ?? ''),
    ])

    if (!paymentsRes.ok || !discountsRes.ok) {
      setDetailDataError(!paymentsRes.ok ? paymentsRes.error : !discountsRes.ok ? discountsRes.error : 'Unknown error')
      setDetailDataState('error')
      return
    }

    setDetailPayments(paymentsRes.data)
    setDetailDiscounts(discountsRes.data)
    setDetailDataState('ready')
  }

  function closeDetail() {
    setDetailBalance(null)
  }

  async function refreshDetailData(studentId: string) {
    const [paymentsRes, discountsRes] = await Promise.all([
      loadStudentPayments(studentId),
      loadStudentDiscounts(studentId, currentSession?.id ?? ''),
    ])
    if (paymentsRes.ok) setDetailPayments(paymentsRes.data)
    if (discountsRes.ok) setDetailDiscounts(discountsRes.data)
    // Also refresh the balance for this student
    await loadBalances()
    // Update the detail balance from refreshed list
    setBalances(prev => {
      const updated = prev.find(b => b.student_id === studentId)
      if (updated) setDetailBalance(updated)
      return prev
    })
  }

  // ─── Fee head form handlers ────────────────────────────────────────────────

  function openFeeHeadForm() {
    setEditingFeeHeadId(null)
    setFeeHeadForm(EMPTY_FEE_HEAD_FORM)
    setFeeHeadError('')
    setFeeHeadFormOpen(true)
    setTimeout(() => feeHeadNameRef.current?.focus(), 80)
  }

  function openFeeHeadFormForEdit(fh: FeeHead) {
    setEditingFeeHeadId(fh.id)
    setFeeHeadForm({
      name:           fh.name,
      is_recurring:   fh.is_recurring,
      default_amount: fh.default_amount !== null ? String(fh.default_amount) : '',
    })
    setFeeHeadError('')
    setFeeHeadFormOpen(true)
    setTimeout(() => feeHeadNameRef.current?.focus(), 80)
  }

  async function handleAddFeeHead() {
    if (!feeHeadForm.name.trim()) {
      setFeeHeadError('Fee head name is required.')
      feeHeadNameRef.current?.focus()
      return
    }
    const amount = feeHeadForm.default_amount
      ? parseFloat(feeHeadForm.default_amount)
      : null
    if (feeHeadForm.default_amount && (isNaN(amount!) || amount! < 0)) {
      setFeeHeadError('Default amount must be a valid number.')
      return
    }
    setFeeHeadSaving(true)
    setFeeHeadError('')

    let res
    if (editingFeeHeadId) {
      res = await updateFeeHead({
        id:             editingFeeHeadId,
        name:           feeHeadForm.name,
        is_recurring:   feeHeadForm.is_recurring,
        default_amount: amount,
      })
    } else {
      res = await createFeeHead({
        schoolId,
        name:           feeHeadForm.name,
        is_recurring:   feeHeadForm.is_recurring,
        default_amount: amount,
      })
    }

    setFeeHeadSaving(false)
    if (!res.ok) { setFeeHeadError(res.error); return }
    setFeeHeadFormOpen(false)
    setEditingFeeHeadId(null)
    // Reload fee heads
    const refreshed = await loadFeeHeads()
    if (refreshed.ok) {
      setFeeHeads(refreshed.data)
      setFeeHeadsState(refreshed.data.length === 0 ? 'empty' : 'ready')
    }
  }

  // ─── Assignment form handlers ─────────────────────────────────────────────

  function openAssignmentForm() {
    setAssignmentForm({
      ...EMPTY_ASSIGNMENT_FORM,
      term_id: selectedTermId,
      // Pre-fill amount from the selected fee head's default if available
    })
    setAssignmentError('')
    setAssignmentFormOpen(true)
  }

  function setAssignmentField<K extends keyof AssignmentForm>(
    field: K,
    value: AssignmentForm[K],
  ) {
    setAssignmentForm(prev => {
      const next = { ...prev, [field]: value }
      // When fee_head_id changes, auto-fill amount from default if field is empty
      if (field === 'fee_head_id') {
        const head = feeHeads.find(h => h.id === value)
        if (head?.default_amount && !prev.amount) {
          next.amount = String(head.default_amount)
        }
      }
      return next
    })
  }

  async function handleAddAssignment() {
    if (!assignmentForm.fee_head_id) {
      setAssignmentError('Select a fee head.')
      return
    }
    if (!assignmentForm.amount || isNaN(parseFloat(assignmentForm.amount)) || parseFloat(assignmentForm.amount) <= 0) {
      setAssignmentError('Enter a valid amount greater than zero.')
      return
    }
    if (assignmentForm.target_type === 'class_node' && !assignmentForm.class_node_id) {
      setAssignmentError('Select a class.')
      return
    }
    if (assignmentForm.target_type === 'student' && !assignmentForm.student_id) {
      setAssignmentError('Search and select a student.')
      return
    }
    if (!currentSession) {
      setAssignmentError('No current session set up. Please configure a session first.')
      return
    }

    setAssignmentSaving(true)
    setAssignmentError('')
    const res = await createFeeAssignment({
      schoolId,
      fee_head_id:   assignmentForm.fee_head_id,
      session_id:    currentSession.id,
      term_id:       assignmentForm.term_id || null,
      target_type:   assignmentForm.target_type,
      class_node_id: assignmentForm.class_node_id || null,
      student_id:    assignmentForm.student_id || null,
      amount:        parseFloat(assignmentForm.amount),
      due_date:      assignmentForm.due_date || null,
    })
    setAssignmentSaving(false)
    if (!res.ok) { setAssignmentError(res.error); return }
    setAssignmentFormOpen(false)
    await loadAssignmentList()
    await loadBalances()
  }

  // ─── Payment form handlers ────────────────────────────────────────────────

  function openPaymentForm() {
    setPaymentForm({
      fee_assignment_id: '',
      amount: '',
      method: 'cash',
      paid_at: todayDateString(),
      provider_reference: '',
      notes: '',
    })
    setPaymentError('')
    setPaymentFormOpen(true)
    setTimeout(() => paymentAmountRef.current?.focus(), 80)
  }

  async function handleRecordPayment(authUserId: string) {
    if (!detailBalance) return
    if (!paymentForm.amount || isNaN(parseFloat(paymentForm.amount)) || parseFloat(paymentForm.amount) <= 0) {
      setPaymentError('Enter a valid payment amount.')
      return
    }
    setPaymentSaving(true)
    setPaymentError('')
    const res = await recordPayment({
      schoolId,
      studentId:       detailBalance.student_id,
      feeAssignmentId: paymentForm.fee_assignment_id || null,
      amount:          parseFloat(paymentForm.amount),
      method:          paymentForm.method,
      authUserId,
      paidAt:          new Date(paymentForm.paid_at).toISOString(),
      providerReference: paymentForm.provider_reference || undefined,
      notes:           paymentForm.notes || null,
    })
    setPaymentSaving(false)
    if (!res.ok) { setPaymentError(res.error); return }
    setPaymentFormOpen(false)
    await refreshDetailData(detailBalance.student_id)
  }

  // ─── Discount form handlers ───────────────────────────────────────────────

  function openDiscountForm() {
    setDiscountForm({
      fee_assignment_id: '',
      discount_type: 'fixed_amount',
      value: '',
      reason: '',
    })
    setDiscountError('')
    setDiscountConfirm(false)
    setDiscountFormOpen(true)
  }

  async function handleApplyDiscount(authUserId: string) {
    if (!detailBalance) return
    if (discountForm.discount_type !== 'full_waiver' && (
      !discountForm.value ||
      isNaN(parseFloat(discountForm.value)) ||
      parseFloat(discountForm.value) <= 0
    )) {
      setDiscountError('Enter a valid discount value.')
      return
    }
    if (!discountConfirm) {
      setDiscountConfirm(true)
      return
    }
    setDiscountSaving(true)
    setDiscountError('')
    const res = await createDiscount({
      schoolId,
      studentId:        detailBalance.student_id,
      feeAssignmentId:  discountForm.fee_assignment_id || null,
      discountType:     discountForm.discount_type,
      value:            discountForm.discount_type === 'full_waiver'
        ? null
        : parseFloat(discountForm.value),
      reason:           discountForm.reason || null,
      authUserId,
    })
    setDiscountSaving(false)
    if (!res.ok) { setDiscountError(res.error); return }
    setDiscountFormOpen(false)
    setDiscountConfirm(false)
    await refreshDetailData(detailBalance.student_id)
  }

  // ─── Render helpers ────────────────────────────────────────────────────────

  function renderHeader() {
    return (
      <div className="fin-header">
        <div className="fin-header-top">
          <h2 className="fin-title">Finance</h2>
          {currentSession && (
            <span className="fin-session-label">{currentSession.name}</span>
          )}
        </div>

        {/* Module-level tab bar */}
        <div className="fin-module-tabs">
          {(['balances', 'assignments', 'feeheads'] as ModuleTab[]).map(tab => (
            <button
              key={tab}
              className={`fin-module-tab${moduleTab === tab ? ' fin-module-tab--active' : ''}`}
              onClick={() => setModuleTab(tab)}
            >
              {tab === 'balances'    ? 'Balances'
               : tab === 'assignments' ? 'Assignments'
               : 'Fee heads'}
            </button>
          ))}
        </div>

        {/* Term selector — only if school uses terms and we're on assignments tab */}
        {terms.length > 0 && moduleTab === 'assignments' && (
          <div className="fin-term-bar">
            <select
              className="fin-term-select"
              value={selectedTermId}
              onChange={e => setSelectedTermId(e.target.value)}
            >
              <option value="">All terms</option>
              {terms.map(t => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>
        )}

        {/* Class filter + search — only on balances tab */}
        {moduleTab === 'balances' && bootState === 'ready' && (
          <div className="fin-filter-bar">
            <select
              className="fin-class-filter"
              value={filterClass}
              onChange={e => { setFilterClass(e.target.value); setSearchQuery('') }}
            >
              <option value="">All classes</option>
              {classes.map(c => (
                <option key={c.id} value={c.id}>{c.path_label}</option>
              ))}
            </select>
            <input
              type="search"
              className="fin-search"
              placeholder="Search by name…"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
          </div>
        )}
      </div>
    )
  }

  function renderBody() {
    if (bootState === 'loading' || bootState === 'booting') {
      return (
        <div className="fin-list-skel">
          {[1,2,3,4,5].map(i => <div key={i} className="fin-row-skel skeleton" />)}
        </div>
      )
    }
    if (bootState === 'error') {
      return (
        <div className="fin-error-state">
          <span className="fin-error-icon"><Icon name="alert-triangle" size={32} style={{ color: 'var(--color-warning, #d97706)' }} /></span>
          <p className="fin-error-msg">{bootError}</p>
          <button className="fin-retry-btn" onClick={() => window.location.reload()}>Retry</button>
        </div>
      )
    }

    if (moduleTab === 'balances')   return renderBalances()
    if (moduleTab === 'assignments') return renderAssignments()
    if (moduleTab === 'feeheads')   return renderFeeHeads()
    return null
  }

  // ── Balances tab ───────────────────────────────────────────────────────────

  function renderBalances() {
    if (!currentSession) {
      return (
        <div className="fin-empty-state">
          <span className="fin-empty-icon"><Icon name="calendar" size={40} /></span>
          <p className="fin-empty-msg">No current session is set up. Set up an academic session to track fees.</p>
        </div>
      )
    }
    if (balancesState === 'loading' || balancesState === 'booting') {
      return (
        <div className="fin-list-skel">
          {[1,2,3,4,5,6].map(i => <div key={i} className="fin-row-skel skeleton" />)}
        </div>
      )
    }
    if (balancesState === 'error') {
      return (
        <div className="fin-error-state">
          <span className="fin-error-icon"><Icon name="alert-triangle" size={32} style={{ color: 'var(--color-warning, #d97706)' }} /></span>
          <p className="fin-error-msg">{balancesError}</p>
          <button className="fin-retry-btn" onClick={loadBalances}>Retry</button>
        </div>
      )
    }
    if (balancesState === 'empty') {
      return (
        <div className="fin-empty-state">
          <span className="fin-empty-icon"><Icon name="users" size={40} /></span>
          <p className="fin-empty-msg">No active students found. Add students first.</p>
        </div>
      )
    }
    if (filteredBalances.length === 0) {
      return (
        <div className="fin-empty-state fin-empty-state--search">
          <span className="fin-empty-icon"><Icon name="search" size={40} /></span>
          <p className="fin-empty-msg">No students match "{searchQuery}".</p>
        </div>
      )
    }

    // Summary bar
    const totalBalance  = filteredBalances.reduce((s, b) => s + b.balance, 0)
    const totalPaid     = filteredBalances.reduce((s, b) => s + b.paid_total, 0)
    const totalAssigned = filteredBalances.reduce((s, b) => s + b.assigned_total, 0)
    const outstanding   = filteredBalances.filter(b => b.balance > 0).length

    return (
      <>
        <div className="fin-balance-summary">
          <div className="fin-balance-stat">
            <span className="fin-balance-stat-label">Total billed</span>
            <span className="fin-balance-stat-value">{formatNaira(totalAssigned)}</span>
          </div>
          <div className="fin-balance-stat">
            <span className="fin-balance-stat-label">Collected</span>
            <span className="fin-balance-stat-value fin-balance-stat-value--ok">{formatNaira(totalPaid)}</span>
          </div>
          <div className="fin-balance-stat">
            <span className="fin-balance-stat-label">Outstanding</span>
            <span className={`fin-balance-stat-value${totalBalance > 0 ? ' fin-balance-stat-value--warn' : ''}`}>
              {formatNaira(totalBalance)}
            </span>
          </div>
          <div className="fin-balance-stat">
            <span className="fin-balance-stat-label">Owing</span>
            <span className={`fin-balance-stat-value${outstanding > 0 ? ' fin-balance-stat-value--warn' : ''}`}>
              {outstanding} student{outstanding !== 1 ? 's' : ''}
            </span>
          </div>
        </div>

        <p className="fin-count">
          {filteredBalances.length} student{filteredBalances.length !== 1 ? 's' : ''}
          {filterClass ? ` · ${classes.find(c => c.id === filterClass)?.path_label ?? ''}` : ''}
        </p>

        <ul className="fin-balance-list">
          {filteredBalances.map(b => (
            <li key={b.student_id} className="fin-balance-row">
              <button
                className="fin-balance-row-btn"
                onClick={() => openDetail(b)}
              >
                <div className="fin-balance-row-avatar">
                  {b.student_name.charAt(0).toUpperCase()}
                </div>
                <div className="fin-balance-row-body">
                  <span className="fin-balance-row-name">{b.student_name}</span>
                  <span className="fin-balance-row-meta">
                    {b.class_path_label ?? 'No class assigned'}
                  </span>
                </div>
                <div className="fin-balance-row-right">
                  {b.balance > 0 ? (
                    <span className="fin-balance-chip fin-balance-chip--owing">
                      Owes {formatNaira(b.balance)}
                    </span>
                  ) : b.assigned_total === 0 ? (
                    <span className="fin-balance-chip fin-balance-chip--nil">
                      No fees
                    </span>
                  ) : (
                    <span className="fin-balance-chip fin-balance-chip--clear">
                      Cleared
                    </span>
                  )}
                </div>
              </button>
            </li>
          ))}
        </ul>
      </>
    )
  }

  // ── Assignments tab ────────────────────────────────────────────────────────

  function renderAssignments() {
    return (
      <div className="fin-assignments-body">
        {canManageFees && (
          <div className="fin-assignments-actions">
            <button className="fin-add-btn" onClick={openAssignmentForm}>
              + Add assignment
            </button>
          </div>
        )}

        {assignmentsState === 'loading' || assignmentsState === 'booting' ? (
          <div className="fin-list-skel">
            {[1,2,3,4].map(i => <div key={i} className="fin-row-skel skeleton" />)}
          </div>
        ) : assignmentsState === 'error' ? (
          <div className="fin-error-state">
            <span className="fin-error-icon"><Icon name="alert-triangle" size={32} style={{ color: 'var(--color-warning, #d97706)' }} /></span>
            <p className="fin-error-msg">{assignmentsError}</p>
            <button className="fin-retry-btn" onClick={loadAssignmentList}>Retry</button>
          </div>
        ) : assignmentsState === 'empty' || assignments.length === 0 ? (
          <div className="fin-empty-state">
            <span className="fin-empty-icon"><Icon name="clipboard-list" size={40} /></span>
            <p className="fin-empty-msg">
              No fee assignments yet{selectedTermId ? ' for this term' : ' for this session'}.
              {canManageFees ? ' Add an assignment to start billing students.' : ''}
            </p>
          </div>
        ) : (
          <ul className="fin-assignment-list">
            {assignments.map(a => (
              <li key={a.id} className="fin-assignment-row">
                <div className="fin-assignment-row-main">
                  <span className="fin-assignment-name">{a.fee_head_name}</span>
                  <span className="fin-assignment-amount">{formatNaira(a.amount)}</span>
                </div>
                <div className="fin-assignment-row-meta">
                  <span className="fin-assignment-target">
                    {a.target_type === 'school_wide' ? 'All students'
                      : a.target_type === 'class_node' ? (a.class_node_name ?? 'Class')
                      : (a.student_name ?? 'Individual student')}
                  </span>
                  {a.due_date && (
                    <span className="fin-assignment-due">
                      Due {formatDate(a.due_date)}
                    </span>
                  )}
                  {a.term_id && terms.length > 0 && (
                    <span className="fin-assignment-term">
                      {terms.find(t => t.id === a.term_id)?.name ?? ''}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    )
  }

  // ── Fee heads tab ──────────────────────────────────────────────────────────

  function renderFeeHeads() {
    return (
      <div className="fin-feeheads-body">
        {canManageFees && (
          <div className="fin-assignments-actions">
            <button className="fin-add-btn" onClick={openFeeHeadForm}>
              + Add fee head
            </button>
          </div>
        )}

        {feeHeadsState === 'loading' || feeHeadsState === 'booting' ? (
          <div className="fin-list-skel">
            {[1,2,3].map(i => <div key={i} className="fin-row-skel skeleton" />)}
          </div>
        ) : feeHeadsState === 'error' ? (
          <div className="fin-error-state">
            <span className="fin-error-icon"><Icon name="alert-triangle" size={32} style={{ color: 'var(--color-warning, #d97706)' }} /></span>
            <p className="fin-error-msg">{feeHeadsError}</p>
          </div>
        ) : feeHeads.length === 0 ? (
          <div className="fin-empty-state">
            <span className="fin-empty-icon"><Icon name="tag" size={40} /></span>
            <p className="fin-empty-msg">No fee heads yet. Add a fee head (e.g. "School Fees", "PTA Levy") to start assigning fees.</p>
            {canManageFees && (
              <button className="fin-empty-action" onClick={openFeeHeadForm}>
                Add first fee head →
              </button>
            )}
          </div>
        ) : (
          <ul className="fin-feehead-list">
            {feeHeads.map(fh => (
              <li key={fh.id} className="fin-feehead-row">
                <div className="fin-feehead-row-main">
                  <span className="fin-feehead-name">{fh.name}</span>
                  {fh.default_amount !== null && (
                    <span className="fin-feehead-default">{formatNaira(fh.default_amount)}</span>
                  )}
                </div>
                <div className="fin-feehead-row-meta">
                  <span className={`fin-feehead-badge${fh.is_recurring ? ' fin-feehead-badge--recurring' : ' fin-feehead-badge--once'}`}>
                    {fh.is_recurring ? 'Recurring' : 'One-time'}
                  </span>
                  {canManageFees && (
                    <button
                      className="fin-feehead-edit-btn"
                      onClick={() => openFeeHeadFormForEdit(fh)}
                      aria-label={`Edit ${fh.name}`}
                    >
                      Edit
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        {/* Add fee head form — inline sheet */}
        {feeHeadFormOpen && renderFeeHeadForm()}
      </div>
    )
  }

  // ── Add fee head form ──────────────────────────────────────────────────────

  function renderFeeHeadForm() {
    const isEdit = !!editingFeeHeadId
    return (
      <div
        className="fin-form-overlay"
        onClick={e => { if (e.target === e.currentTarget) { setFeeHeadFormOpen(false); setEditingFeeHeadId(null) } }}
      >
        <div className="fin-form-sheet" role="dialog" aria-modal aria-label={isEdit ? 'Edit fee head' : 'Add fee head'}>
          <div className="fin-form-handle" />
          <div className="fin-form-header">
            <h3 className="fin-form-title">{isEdit ? 'Edit fee head' : 'Add fee head'}</h3>
            <button className="fin-form-close" onClick={() => { setFeeHeadFormOpen(false); setEditingFeeHeadId(null) }} aria-label="Close"><Icon name="x" size={18} /></button>
          </div>
          <div className="fin-form-body">
            <div className="fin-field">
              <label className="fin-label" htmlFor="fin-fh-name">
                Name <span className="fin-required">*</span>
              </label>
              <input
                id="fin-fh-name"
                ref={feeHeadNameRef}
                className="fin-input"
                type="text"
                placeholder="e.g. School Fees, PTA Levy"
                value={feeHeadForm.name}
                onChange={e => setFeeHeadForm(prev => ({ ...prev, name: e.target.value }))}
                autoComplete="off"
              />
            </div>
            <div className="fin-field">
              <label className="fin-label" htmlFor="fin-fh-amount">Default amount (₦)</label>
              <input
                id="fin-fh-amount"
                className="fin-input"
                type="number"
                min="0"
                step="0.01"
                placeholder="e.g. 15000"
                value={feeHeadForm.default_amount}
                onChange={e => setFeeHeadForm(prev => ({ ...prev, default_amount: e.target.value }))}
              />
            </div>
            <div className="fin-field">
              <label className="fin-label">Type</label>
              <div className="fin-radio-group">
                <label className="fin-radio-label">
                  <input
                    type="radio"
                    name="fin-fh-recurring"
                    value="recurring"
                    checked={feeHeadForm.is_recurring}
                    onChange={() => setFeeHeadForm(prev => ({ ...prev, is_recurring: true }))}
                  />
                  Recurring (per term/session)
                </label>
                <label className="fin-radio-label">
                  <input
                    type="radio"
                    name="fin-fh-recurring"
                    value="once"
                    checked={!feeHeadForm.is_recurring}
                    onChange={() => setFeeHeadForm(prev => ({ ...prev, is_recurring: false }))}
                  />
                  One-time
                </label>
              </div>
            </div>
            {feeHeadError && <p className="fin-form-error" role="alert">{feeHeadError}</p>}
          </div>
          <div className="fin-form-footer">
            <button className="fin-cancel-btn" onClick={() => { setFeeHeadFormOpen(false); setEditingFeeHeadId(null) }} disabled={feeHeadSaving}>
              Cancel
            </button>
            <button className="fin-save-btn" onClick={handleAddFeeHead} disabled={feeHeadSaving}>
              {feeHeadSaving ? 'Saving…' : isEdit ? 'Save changes' : 'Add fee head'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── Add assignment form ────────────────────────────────────────────────────

  function renderAssignmentForm() {
    if (!assignmentFormOpen) return null
    return (
      <div
        className="fin-form-overlay"
        onClick={e => { if (e.target === e.currentTarget) setAssignmentFormOpen(false) }}
      >
        <div className="fin-form-sheet" role="dialog" aria-modal aria-label="Add fee assignment">
          <div className="fin-form-handle" />
          <div className="fin-form-header">
            <h3 className="fin-form-title">Add fee assignment</h3>
            <button className="fin-form-close" onClick={() => setAssignmentFormOpen(false)} aria-label="Close"><Icon name="x" size={18} /></button>
          </div>
          <div className="fin-form-body">
            <div className="fin-field">
              <label className="fin-label" htmlFor="fin-asgn-feehead">
                Fee head <span className="fin-required">*</span>
              </label>
              <select
                id="fin-asgn-feehead"
                className="fin-select"
                value={assignmentForm.fee_head_id}
                onChange={e => setAssignmentField('fee_head_id', e.target.value)}
              >
                <option value="">— select fee head —</option>
                {feeHeads.map(fh => (
                  <option key={fh.id} value={fh.id}>{fh.name}</option>
                ))}
              </select>
            </div>
            <div className="fin-field">
              <label className="fin-label" htmlFor="fin-asgn-amount">
                Amount (₦) <span className="fin-required">*</span>
              </label>
              <input
                id="fin-asgn-amount"
                className="fin-input"
                type="number"
                min="0"
                step="0.01"
                placeholder="e.g. 15000"
                value={assignmentForm.amount}
                onChange={e => setAssignmentField('amount', e.target.value)}
              />
            </div>
            <div className="fin-field">
              <label className="fin-label">Applies to</label>
              <div className="fin-radio-group">
                {(['school_wide', 'class_node', 'student'] as const).map(type => (
                  <label key={type} className="fin-radio-label">
                    <input
                      type="radio"
                      name="fin-asgn-target"
                      value={type}
                      checked={assignmentForm.target_type === type}
                      onChange={() => setAssignmentField('target_type', type)}
                    />
                    {type === 'school_wide' ? 'All students'
                      : type === 'class_node' ? 'A specific class'
                      : 'A specific student'}
                  </label>
                ))}
              </div>
            </div>
            {assignmentForm.target_type === 'class_node' && (
              <div className="fin-field">
                <label className="fin-label" htmlFor="fin-asgn-class">
                  Class <span className="fin-required">*</span>
                </label>
                <select
                  id="fin-asgn-class"
                  className="fin-select"
                  value={assignmentForm.class_node_id}
                  onChange={e => setAssignmentField('class_node_id', e.target.value)}
                >
                  <option value="">— select class —</option>
                  {classes.map(c => (
                    <option key={c.id} value={c.id}>{c.path_label}</option>
                  ))}
                </select>
              </div>
            )}
            {assignmentForm.target_type === 'student' && (
              <div className="fin-field">
                <label className="fin-label">Student <span className="fin-required">*</span></label>
                {assignmentForm.student_id ? (
                  <div className="fin-selected-student">
                    <span className="fin-selected-student-name">{assignmentForm.student_name}</span>
                    <button
                      className="fin-clear-student-btn"
                      onClick={() => setAssignmentForm(prev => ({
                        ...prev, student_id: '', student_name: '', student_search: '',
                      }))}
                      aria-label="Clear selected student"
                    >
                      <Icon name="x" size={14} />
                    </button>
                  </div>
                ) : (
                  <StudentSearchField
                    value={assignmentForm.student_search}
                    onChange={v => setAssignmentField('student_search', v)}
                    onSelect={(id, name) => setAssignmentForm(prev => ({
                      ...prev, student_id: id, student_name: name, student_search: name,
                    }))}
                  />
                )}
              </div>
            )}
            {terms.length > 0 && (
              <div className="fin-field">
                <label className="fin-label" htmlFor="fin-asgn-term">Term</label>
                <select
                  id="fin-asgn-term"
                  className="fin-select"
                  value={assignmentForm.term_id}
                  onChange={e => setAssignmentField('term_id', e.target.value)}
                >
                  <option value="">Whole session</option>
                  {terms.map(t => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </div>
            )}
            <div className="fin-field">
              <label className="fin-label" htmlFor="fin-asgn-due">Due date</label>
              <input
                id="fin-asgn-due"
                className="fin-input"
                type="date"
                value={assignmentForm.due_date}
                onChange={e => setAssignmentField('due_date', e.target.value)}
              />
            </div>
            {assignmentError && <p className="fin-form-error" role="alert">{assignmentError}</p>}
          </div>
          <div className="fin-form-footer">
            <button className="fin-cancel-btn" onClick={() => setAssignmentFormOpen(false)} disabled={assignmentSaving}>
              Cancel
            </button>
            <button className="fin-save-btn" onClick={handleAddAssignment} disabled={assignmentSaving}>
              {assignmentSaving ? 'Saving…' : 'Add assignment'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── Student detail panel ───────────────────────────────────────────────────

  function renderDetailPanel() {
    if (!detailBalance) return null
    const b = detailBalance

    return (
      <div
        className="fin-form-overlay"
        onClick={e => { if (e.target === e.currentTarget) closeDetail() }}
      >
        <div className="fin-detail-sheet fin-form-sheet" role="dialog" aria-modal aria-label={`${b.student_name} fees`}>
          <div className="fin-form-handle" />

          {/* Detail header */}
          <div className="fin-detail-header">
            <div className="fin-detail-avatar">
              {b.student_name.charAt(0).toUpperCase()}
            </div>
            <div className="fin-detail-title-wrap">
              <p className="fin-detail-name">{b.student_name}</p>
              <p className="fin-detail-class">{b.class_path_label ?? 'No class assigned'}</p>
            </div>
            <button className="fin-form-close" onClick={closeDetail} aria-label="Close"><Icon name="x" size={18} /></button>
          </div>

          {/* Detail tabs */}
          <div className="fin-detail-tabs">
            {(['summary', 'payments', 'discounts'] as DetailTab[]).map(tab => (
              <button
                key={tab}
                className={`fin-detail-tab${detailTab === tab ? ' fin-detail-tab--active' : ''}`}
                onClick={() => setDetailTab(tab)}
              >
                {tab.charAt(0).toUpperCase() + tab.slice(1)}
              </button>
            ))}
          </div>

          {/* Detail body */}
          <div className="fin-detail-body">
            {detailTab === 'summary'   && renderDetailSummary(b)}
            {detailTab === 'payments'  && renderDetailPayments()}
            {detailTab === 'discounts' && renderDetailDiscounts()}
          </div>
        </div>
      </div>
    )
  }

  function renderDetailSummary(b: StudentBalance) {
    return (
      <div className="fin-detail-tab-content">
        <div className="fin-summary-row">
          <div className="fin-summary-stat">
            <span className="fin-summary-stat-label">Billed</span>
            <span className="fin-summary-stat-value">{formatNaira(b.assigned_total)}</span>
          </div>
          <div className="fin-summary-stat">
            <span className="fin-summary-stat-label">Discount</span>
            <span className="fin-summary-stat-value fin-summary-stat-value--muted">
              {b.discount_total > 0 ? `− ${formatNaira(b.discount_total)}` : '—'}
            </span>
          </div>
          <div className="fin-summary-stat">
            <span className="fin-summary-stat-label">Paid</span>
            <span className="fin-summary-stat-value fin-summary-stat-value--ok">
              {b.paid_total > 0 ? formatNaira(b.paid_total) : '—'}
            </span>
          </div>
          <div className="fin-summary-stat fin-summary-stat--balance">
            <span className="fin-summary-stat-label">Balance</span>
            <span className={`fin-summary-stat-value fin-summary-stat-value--lg${b.balance > 0 ? ' fin-summary-stat-value--warn' : ' fin-summary-stat-value--ok'}`}>
              {formatNaira(b.balance)}
            </span>
          </div>
        </div>

        {b.assigned_total === 0 && (
          <p className="fin-summary-hint">
            No fee assignments apply to this student yet.
            {canManageFees ? ' Go to Assignments to create one.' : ''}
          </p>
        )}
      </div>
    )
  }

  function renderDetailPayments() {
    return (
      <div className="fin-detail-tab-content">
        {canRecordPayments && !paymentFormOpen && (
          <button className="fin-record-payment-btn" onClick={openPaymentForm}>
            + Record payment
          </button>
        )}

        {paymentFormOpen && renderPaymentForm()}

        {detailDataState === 'loading' || detailDataState === 'booting' ? (
          <div className="fin-list-skel">
            {[1,2,3].map(i => <div key={i} className="fin-row-skel skeleton" />)}
          </div>
        ) : detailDataState === 'error' ? (
          <p className="fin-form-error" role="alert">{detailDataError}</p>
        ) : detailPayments.length === 0 ? (
          <div className="fin-empty-state fin-empty-state--detail">
            <span className="fin-empty-icon"><Icon name="credit-card" size={40} /></span>
            <p className="fin-empty-msg">No payments recorded yet.</p>
          </div>
        ) : (
          <ul className="fin-payment-list">
            {detailPayments.map(p => (
              <li key={p.id} className="fin-payment-row">
                <div className="fin-payment-row-main">
                  <span className="fin-payment-amount">{formatNaira(p.amount)}</span>
                  <span className={`fin-payment-status fin-payment-status--${p.status}`}>
                    {p.status}
                  </span>
                </div>
                <div className="fin-payment-row-meta">
                  <span className="fin-payment-method">{methodLabel(p.method)}</span>
                  {p.fee_head_name && (
                    <span className="fin-payment-feehead">· {p.fee_head_name}</span>
                  )}
                  <span className="fin-payment-date">{formatDate(p.paid_at)}</span>
                </div>
                {p.received_by_name && (
                  <span className="fin-payment-by">Recorded by {p.received_by_name}</span>
                )}
                {p.notes && (
                  <span className="fin-payment-notes">{p.notes}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    )
  }

  function renderPaymentForm() {
    return (
      <div className="fin-payment-form">
        <p className="fin-payment-form-title">Record payment</p>
        <div className="fin-field">
          <label className="fin-label" htmlFor="fin-pay-assignment">Fee head (optional)</label>
          <select
            id="fin-pay-assignment"
            className="fin-select"
            value={paymentForm.fee_assignment_id}
            onChange={e => setPaymentForm(prev => ({ ...prev, fee_assignment_id: e.target.value }))}
          >
            <option value="">— general payment —</option>
            {detailBalance && assignments
              .filter(a =>
                a.target_type === 'school_wide' ||
                (a.target_type === 'class_node' && a.class_node_id === detailBalance.class_node_id) ||
                (a.target_type === 'student' && a.student_id === detailBalance.student_id)
              )
              .map(a => (
                <option key={a.id} value={a.id}>
                  {a.fee_head_name} ({formatNaira(a.amount)})
                </option>
              ))
            }
          </select>
        </div>
        <div className="fin-field">
          <label className="fin-label" htmlFor="fin-pay-amount">
            Amount (₦) <span className="fin-required">*</span>
          </label>
          <input
            id="fin-pay-amount"
            ref={paymentAmountRef}
            className="fin-input"
            type="number"
            min="0"
            step="0.01"
            placeholder="e.g. 15000"
            value={paymentForm.amount}
            onChange={e => setPaymentForm(prev => ({ ...prev, amount: e.target.value }))}
          />
        </div>
        <div className="fin-field">
          <label className="fin-label" htmlFor="fin-pay-method">Method</label>
          <select
            id="fin-pay-method"
            className="fin-select"
            value={paymentForm.method}
            onChange={e => setPaymentForm(prev => ({ ...prev, method: e.target.value as PaymentMethod }))}
          >
            <option value="cash">Cash</option>
            <option value="bank_transfer">Bank transfer</option>
            <option value="card">Card</option>
            <option value="ussd">USSD</option>
          </select>
        </div>
        <div className="fin-field">
          <label className="fin-label" htmlFor="fin-pay-date">Date</label>
          <input
            id="fin-pay-date"
            className="fin-input"
            type="date"
            max={todayDateString()}
            value={paymentForm.paid_at}
            onChange={e => setPaymentForm(prev => ({ ...prev, paid_at: e.target.value }))}
          />
        </div>
        <div className="fin-field">
          <label className="fin-label" htmlFor="fin-pay-notes">Notes</label>
          <textarea
            id="fin-pay-notes"
            className="fin-textarea"
            rows={3}
            placeholder="e.g. Part payment — balance of ₦5,000 expected by end of term"
            value={paymentForm.notes}
            onChange={e => setPaymentForm(prev => ({ ...prev, notes: e.target.value }))}
          />
        </div>
        {paymentError && <p className="fin-form-error" role="alert">{paymentError}</p>}
        <div className="fin-payment-form-footer">
          <button className="fin-cancel-btn" onClick={() => setPaymentFormOpen(false)} disabled={paymentSaving}>
            Cancel
          </button>
          <button
            className="fin-save-btn"
            onClick={() => {
              // Pass auth.users.id — recordPayment() resolves the staff.id itself via app_identities.
              import('../lib/supabase').then(({ supabase: sb }) => {
                sb.auth.getSession().then(({ data }) => {
                  const authUserId = data.session?.user?.id ?? ''
                  handleRecordPayment(authUserId)
                })
              })
            }}
            disabled={paymentSaving}
          >
            {paymentSaving ? 'Saving…' : 'Record payment'}
          </button>
        </div>
      </div>
    )
  }

  function renderDetailDiscounts() {
    return (
      <div className="fin-detail-tab-content">
        {canApplyDiscounts && !discountFormOpen && (
          <button className="fin-record-payment-btn" onClick={openDiscountForm}>
            + Apply discount / waiver
          </button>
        )}

        {discountFormOpen && renderDiscountForm()}

        {detailDataState === 'loading' || detailDataState === 'booting' ? (
          <div className="fin-list-skel">
            {[1,2].map(i => <div key={i} className="fin-row-skel skeleton" />)}
          </div>
        ) : detailDataState === 'error' ? (
          <p className="fin-form-error" role="alert">{detailDataError}</p>
        ) : detailDiscounts.length === 0 ? (
          <div className="fin-empty-state fin-empty-state--detail">
            <span className="fin-empty-icon"><Icon name="tag" size={40} /></span>
            <p className="fin-empty-msg">No discounts applied.</p>
          </div>
        ) : (
          <ul className="fin-discount-list">
            {detailDiscounts.map(d => (
              <li key={d.id} className="fin-discount-row">
                <div className="fin-discount-row-main">
                  <span className="fin-discount-type">{discountTypeLabel(d.discount_type)}</span>
                  <span className="fin-discount-amount">
                    {d.resolved_amount !== null
                      ? `− ${formatNaira(d.resolved_amount)}`
                      : d.discount_type === 'percentage'
                        ? `${d.value}%`
                        : '—'}
                  </span>
                </div>
                <div className="fin-discount-row-meta">
                  {d.fee_head_name && <span className="fin-discount-feehead">{d.fee_head_name}</span>}
                  {d.reason && <span className="fin-discount-reason">{d.reason}</span>}
                  {d.approved_by_name && (
                    <span className="fin-discount-by">Approved by {d.approved_by_name}</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    )
  }

  function renderDiscountForm() {
    return (
      <div className="fin-payment-form">
        <p className="fin-payment-form-title">Apply discount / waiver</p>
        <div className="fin-field">
          <label className="fin-label" htmlFor="fin-disc-assignment">Fee head (optional)</label>
          <select
            id="fin-disc-assignment"
            className="fin-select"
            value={discountForm.fee_assignment_id}
            onChange={e => setDiscountForm(prev => ({ ...prev, fee_assignment_id: e.target.value }))}
          >
            <option value="">— general / unlinked —</option>
            {detailBalance && assignments
              .filter(a =>
                a.target_type === 'school_wide' ||
                (a.target_type === 'class_node' && a.class_node_id === detailBalance.class_node_id) ||
                (a.target_type === 'student' && a.student_id === detailBalance.student_id)
              )
              .map(a => (
                <option key={a.id} value={a.id}>
                  {a.fee_head_name} ({formatNaira(a.amount)})
                </option>
              ))
            }
          </select>
        </div>
        <div className="fin-field">
          <label className="fin-label">Type</label>
          <div className="fin-radio-group">
            {(['fixed_amount', 'percentage', 'full_waiver'] as const).map(type => (
              <label key={type} className="fin-radio-label">
                <input
                  type="radio"
                  name="fin-disc-type"
                  value={type}
                  checked={discountForm.discount_type === type}
                  onChange={() => setDiscountForm(prev => ({ ...prev, discount_type: type }))}
                />
                {discountTypeLabel(type)}
              </label>
            ))}
          </div>
        </div>
        {discountForm.discount_type !== 'full_waiver' && (
          <div className="fin-field">
            <label className="fin-label" htmlFor="fin-disc-value">
              {discountForm.discount_type === 'percentage' ? 'Percentage (%)' : 'Amount (₦)'}
              <span className="fin-required">*</span>
            </label>
            <input
              id="fin-disc-value"
              className="fin-input"
              type="number"
              min="0"
              max={discountForm.discount_type === 'percentage' ? '100' : undefined}
              step={discountForm.discount_type === 'percentage' ? '1' : '0.01'}
              placeholder={discountForm.discount_type === 'percentage' ? '50' : '5000'}
              value={discountForm.value}
              onChange={e => setDiscountForm(prev => ({ ...prev, value: e.target.value }))}
            />
          </div>
        )}
        <div className="fin-field">
          <label className="fin-label" htmlFor="fin-disc-reason">Reason</label>
          <input
            id="fin-disc-reason"
            className="fin-input"
            type="text"
            placeholder="e.g. Scholarship, Staff child"
            value={discountForm.reason}
            onChange={e => setDiscountForm(prev => ({ ...prev, reason: e.target.value }))}
          />
        </div>

        {discountConfirm && (
          <div className="fin-discount-confirm-banner">
            <p className="fin-discount-confirm-text">
              Discounts cannot be deleted once applied. Confirm you want to apply this discount to {detailBalance?.student_name}.
            </p>
          </div>
        )}

        {discountError && <p className="fin-form-error" role="alert">{discountError}</p>}

        <div className="fin-payment-form-footer">
          <button
            className="fin-cancel-btn"
            onClick={() => { setDiscountFormOpen(false); setDiscountConfirm(false) }}
            disabled={discountSaving}
          >
            Cancel
          </button>
          <button
            className={`fin-save-btn${discountConfirm ? ' fin-save-btn--confirm' : ''}`}
            onClick={() => {
              import('../lib/supabase').then(({ supabase: sb }) => {
                sb.auth.getSession().then(({ data }) => {
                  const authUserId = data.session?.user?.id ?? ''
                  handleApplyDiscount(authUserId)
                })
              })
            }}
            disabled={discountSaving}
          >
            {discountSaving ? 'Saving…' : discountConfirm ? 'Confirm — apply discount' : 'Apply discount'}
          </button>
        </div>
      </div>
    )
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="fin-root">
      {renderHeader()}
      <div className="fin-body">
        {renderBody()}
      </div>
      {renderDetailPanel()}
      {renderAssignmentForm()}
    </div>
  )
}

// ─── Student search field (inline component) ──────────────────────────────────

/**
 * Simple debounced search against the students table.
 * Used in the assignment form to pick a specific student target.
 * Kept as a separate component to avoid polluting the main component's state.
 */
function StudentSearchField({
  value,
  onChange,
  onSelect,
}: {
  value: string
  onChange: (v: string) => void
  onSelect: (id: string, name: string) => void
}) {
  const [results, setResults] = useState<Array<{ id: string; full_name: string }>>([])
  const [searching, setSearching] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function handleChange(v: string) {
    onChange(v)
    if (timerRef.current) clearTimeout(timerRef.current)
    if (!v.trim()) { setResults([]); return }
    timerRef.current = setTimeout(async () => {
      setSearching(true)
      const { data } = await supabase
        .from('students')
        .select('id, full_name')
        .ilike('full_name', `%${v.trim()}%`)
        .eq('status', 'active')
        .limit(8)
      setSearching(false)
      setResults(data ?? [])
    }, 300)
  }

  return (
    <div className="fin-student-search">
      <input
        className="fin-input"
        type="search"
        placeholder="Search student by name…"
        value={value}
        onChange={e => handleChange(e.target.value)}
        autoComplete="off"
      />
      {searching && <p className="fin-student-search-hint">Searching…</p>}
      {results.length > 0 && (
        <ul className="fin-student-search-results">
          {results.map(r => (
            <li key={r.id}>
              <button
                className="fin-student-search-result"
                onClick={() => { onSelect(r.id, r.full_name); setResults([]) }}
                type="button"
              >
                {r.full_name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-NG', {
      day: 'numeric', month: 'short', year: 'numeric',
    })
  } catch {
    return iso
  }
}
