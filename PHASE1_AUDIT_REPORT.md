# Phase 1 — Full Codebase Audit

> Generated 2026-08-26 from parallel deep-reads of every route/service plus cross-checks against `PRD (30).md`, `MASTER_PLAN (24).md`, `TIER_9_OWNER_REPORTED_ISSUES (5).md`.
> Verification method: every claim cites `file:line`. Where the docs and code disagree, both directions are flagged: implementation diverging from docs **and** docs setting a lower bar than is actually best.

**Context at audit time:** `npm run build` clean, s46/s48/s49/s50 live. Owner states Tier 9 is code-complete (docs stale) and Tier 8 (secondary windows/promotion/report cards/exam overlay) was just built this arc. Those are treated as *shipped* where code proves it; remaining `⏸ Paused`/`⏸ Deferred` items in the docs are noted, not re-reported as new.

---

## 0. Cross-Cutting — Production Blockers

These apply to *every* module. Fix them once.

| # | Issue | Evidence | Fix class |
|---|---|---|---|
| C1 | **`subject_results` is a security-definer view** — RLS on `scores` is not enforced through the view. Any `authenticated` caller querying the view without a `school_id` filter sees every school's approved rows. Guardians filter by `student_id`, so leak is indirect, but tenant isolation is broken at the DB layer. | `MASTER_PLAN:981` view definition; `portalService.ts:755` select via view | **[REQ]** Recreate with `security_invoker = true` + explicit RLS or replace with RPC |
| C2 | **`offlineQueue` is IndexedDB now (code) but docs still say Phase-0 in-memory** — code is *ahead* of docs. In-memory fallback only on ancient browsers. Doc is stale, not code. | `lib/offlineQueue.ts:27` IndexedDbAdapter; `MASTER_PLAN:336` conventions still describe in-memory | **[DOC]** Update docs, not code |
| C3 | **`window.confirm/alert` everywhere** — 64 hits. `AssessmentsSettings:27`, `SettingsModule:25`, `LibraryModule:7`, `TimetableModuleHigherEd:3`, `Announcements:2`. Breaks embedded webviews, violates §4.3 plain-English guidance. | `grep` counts from Onboarding audit | **[REQ]** Replace with `Modal.tsx:1` pattern (already exists) |
| C4 | **`supabase` tenant scoping inconsistent** — some reads carry no `school_id` filter, relying on RLS alone (`financeService:339`, `studentsService:391`, `timetableService:351`). Others scope explicitly (`portalService:990`). | Finance/HR audits | **[REC]** Defense-in-depth: always filter `school_id` explicitly *and* keep RLS |
| C5 | **Zero pagination/virtualization** — every list is unbounded (`studentsService:309`, `hrService:309`, `financeService:336`, `LibraryModule:1032`). N-query fan-outs (`CourseAttendanceModule:538` 3 queries × students) kill 3G. | All module audits | **[REQ]** Server-side `ilike` + keyset pagination; `react-window` for lists |
| C6 | **Zero test harness, zero CI** — `package.json:6` has no `test` script; no `supabase/` dir in repo; migrations live only as loose `.sql` files in repo root. | `bash: supabase/` missing | **[REQ]** `vitest` for `gpaService:1` (pure) + `supabase/migrations/` + GHA `tsc -b && vite build && oxlint` |

---

## 1. Finance — `FinanceModule:1` / `financeService:1` / `receiptPdf:1` / `remitaPortalService:1`

### 1.1 Broken

- **Multi-session balance contamination**: `loadStudentBalances` sums *all* completed payments (no session scope) against current-session assignments. `financeService:452` comment admits it; discounts ignore `sessionId` (`financeService:604`, param `_sessionId`). Wrong balances for any school past session 1.
- **`received_by = null` silent success** when `app_identities` lookup misses (`financeService:872`). Contrast `createDiscount:946` which correctly fails.
- **Dead error state**: `feeHeadsError` declared `FinanceModule:285` never set → `renderFeeHeads:1191` unreachable. `methodLabel` missing `remita` case (`financeService:1006` vs `receiptPdf:318` has it).
- **Keys that gate nothing**: `finance.installments.manage` + `discounts.approve` keys read but never used (`FinanceModule:238`).

### 1.2 Poor UX

- Boot retry = `window.location.reload():856` losing tab state; elsewhere uses targeted refetch.
- No pagination (`Balances` renders full roster `FinanceModule:1068`), no assignment edit/delete, search wipes on filter change `FinanceModule:811`.
- Date stored as UTC midnight `financeService:696` shifts on negative-UTC devices.

### 1.3 Docs divergence

- Drift `isHigherEd` (`'college'` vs `college_of_education`) **fixed** `FinanceModule:178` — doc note now stale.
- `finance.ledger.view/post` keys exist but zero ledger code (`chart_of_accounts`) — doc correctly says not built; keys gate nothing.
- `receiptPdf` is **built** (`GuardianPortal:2054`) contradicting doc line "NOT built".
- `Result<T>` vs `remitaPortalService:59` throwing — deliberate but divergent.

### 1.4 From-scratch take

- Balance calc belongs server-side (view/RPC with proper `payments → fee_assignments → session` join) — fixes contamination canonically and removes 4-query client fan-out.
- Resolve identity from `authStore.actorRecordId` (already loaded), not per-write `getSession()+app_identities` re-query (wastes 2 RTTs, caused the null bug).

### 1.5 Fixes (ordered)

- **[REQ]** Server-side balance RPC/view filtering payments by assignment session — closes C5 + contamination.
- **[REQ]** Fail `recordPayment` when actor identity missing; remove `?? ''` fallback `FinanceModule:1735`.
- **[REQ]** Add `remita` to `methodLabel`; wire `feeHeadsError`.
- **[REC]** Memoize `filteredBalances`, extract subcomponents, add edit/delete for assignments, add pagination.
- **[DOC]** Update docs: receipt built, ledger not built by design.

---

## 2. HR — `HRModule:1` / `hrService:1`

### 2.1 Broken

- **`reviewLeaveRequest:1296` has no status guard** (`WHERE id = ?` only) vs siblings `cancel:1322`, `approveRun:1655`, `markPaid:1699` which guard. Re-approving a cancelled leave overwrites `reviewed_by`.
- **Silent `null` reviewer/approver** when `app_identities` lookup misses `hrService:1291`.
- **Due-estimates treat any `payslips` row as "paid"** regardless of run `status` (`hrService:819`); future-dated `salary_structures` go live immediately (`hrService:574` no `effective_from <= now()` filter).

### 2.2 Poor UX

- No pagination anywhere; sequential per-candidate inserts (`hrService:1520`), multi-leg staff save (roles+assignments, `HRModule:766`) non-atomic with clunky partial-failure string.
- `confirm` avoided (good) but leave approve/reject is **one-tap irreversible** `HRModule:1517` vs two-tap elsewhere — inconsistent.

### 2.3 Docs divergence

- Key name in prompt `hr.leave.apply` does not exist; real key is `hr.leave.request:231` — docs themselves use the wrong name at the brief.
- `hr.leave.types_manage` confirmed absent from catalog (as documented `TIER_9:62`); `isAdmin` fallback `HRModule:1561` correctly left as-is — only remaining `isAdmin &&` in scope.

### 2.4 From-scratch take

- Enforce state machines in Postgres (constraints/triggers or single RPC), not conditional `.eq('status',...)` scattered per call site.
- Batch inserts (`insert(rows[])`), `useReducer` for 50 `useState` atoms, derived `useAsyncResult` hook.

### 2.5 Fixes

- **[REQ]** Add `eq('status','pending')` guard to `reviewLeaveRequest`; fail when `reviewerStaffId == null`.
- **[REQ]** Filter salary/due queries by `effective_from <= now()`; count only runs with `status='paid'` for due flags.
- **[REC]** Batch payslip inserts; add pagination + status guards server-side.

---

## 3. Students + Guardians — `StudentsModule:1` / `studentsService:1` / `GuardianModule:1` / `guardianService:1`

### 3.1 Broken

- **Edge auth wrong token**: `provisionGuardianAccess:1559`/`provisionStudentAccess:1635` use **anon key** bearer (`supabaseAnonKey`) with `school_id` in body — no user JWT; edge must trust caller-supplied `school_id`. `initiateTransfer:1698` correctly uses `getSession().access_token` but reads URL via `(supabase as any).supabaseUrl` which does not exist on the client — yields `undefined/functions/...`.
- **No tenant filter** on `loadStudents:391`/`getStudentStatusCounts:575` (RLS-only, inconsistent with `loadUnplaced:499` which scopes `school_id`).
- **`searchStudentsForLink:668` always returns `class_path_label:null`** (no `class_nodes` join) `GuardianModule:674`.
- **Non-atomic `addGuardian:1241`** (insert guardian → link) leaves orphan on step-2 failure.

### 3.2 Poor UX — monolith

- `StudentsModule:4298` with **101 `useState` + 7 `useEffect`** (`GuardianModule:29+2` more). Every domain (list/filters, add/edit, brief, guardians tab, status, transfer, placement, transcript, photo, ID print) lives in one file. No virtualization (`renderList:1958` maps full roster + per-row photo resolve), duplicate derivations (`effectiveClassIds:757` ×2 higher-ed copy, `classPathMap:251`).
- Mixed search conventions: instant client filter vs 350 ms debounce in guardian search — two conventions in one file.

### 3.3 Docs divergence — mostly implemented as described

- Class pills + search (`renderHeader:1712`), Edit-via-Brief (`DetailTab:221`, gated `students.records.edit:245`), extended fields/photo resize pipeline (`studentsService:925` canvas → `987` `${schoolId}/${studentId}/photo.jpg`), brief attendance, role tags, transfer confirm, ID-card Blob-URL (Android-safe), higher-ed placement RPC + Unplaced view + transcript drafts badge — all present as documented.
- Guardians-tab **diverged** from old defect #2/#3/#6 "consolidated card" request: now a one-at-a-time `renderGuardianBrief:3566` popup behind a name tap `3073`, not a flat card list. Meets §4.3 confirmation (banner `537`) but not the flat-card discoverability the old request wanted.

### 3.4 From-scratch take

- Vertically split: `StudentsList` (virtualized), `StudentDetailShell` (header+tabs) with lazy `BriefTab/InfoForm/GuardiansTab/StatusTab` code-split; extracted hooks `useStudentList/useGuardians/usePlacement`. Single server `ilike` search, one canonical `classPathMap` selector.
- RPCs for `addGuardian+link` and anon-key → `getSession` token for edge calls.

### 3.5 Fixes

- **[REQ]** Edge auth: use `getSession` token for all provision calls; fix `supabaseUrl` read via `import.meta.env.VITE_SUPABASE_URL`.
- **[REQ]** Scope `loadStudents` explicitly by `school_id`.
- **[REC]** Virtualize list, unify search debounce, dedup derivations.

---

## 4. Guardian Portal — `GuardianPortal:1` / `portalService:1`

### 4.1 Broken

- **Announcements `limit-then-expiry` bug**: `.limit(1)` before expiry filter `portalService:1023` — one expired latest row hides all fresh ones.
- **`StudentRegistrationDownload:1245`** calls `downloadRegistrationSlipPdf` with **no try/catch** — throw leaves button stuck "Preparing…".
- **`ScheduleTab:1592`** over-fetches whole-school timetable via `loadCurrentSession()` with **no `schoolId`** (`timetableService:351` `maybeSingle` across tenants) — with > 1 `is_current` row, errors permanently.

### 4.2 Poor UX

- First-name-only child chips `GuardianPortal:250` (siblings collide); `ChildDetail` mounted without `key={child.id}:257` so `expandedSubject`/`expandedIds` survive child switches.
- Every visited tab refetches on `child.id` change → skeleton flash. Fees `reload:1857` duplicated by separate `useEffect:1876`.
- Higher-ed has **7 tabs** (Summary/Transcript/Register/Attendance/Schedule/Fees/News) vs spec's five — horizontal scroll strip `452` confirms crowding.

### 4.3 Docs divergence — portal spec §4.4/§4.9 mostly honored

- Child Summary-first landing, contextual figures ("Present N of M"), fee/history scoped via `student_guardians:225` — correct.
- `scores` raw read correctly gated `.not('approved_at','is',null):736`; view for aggregates — half-literal vs spec, but compliant.
- Higher-ed swaps (Transcript replaces Results, Register inserted) documented as divergence.
- Registration rules verified **shipped** despite `TIER_9:369 ⬜`: summary default `CourseRegistration:583`, admin Drop inline confirm `657`, student readOnly `644/685`, PDF student-only `GuardianPortal:1245`, core-course banner additive-only `1051` — doc table stale.
- `matric_number` nullable → `StudentRegistrationDownload:1011 null` compiles (confirmed).

### 4.4 From-scratch take

- Keep one portal, extract seams (`FeesTab`, `Registration` cluster, two schedule tabs). Add server-scoped timetable/fee-assignments queries; unify `usePortalQuery(childId, tab)` to kill skeleton flashes.

### 4.5 Fixes

- **[REQ]** Move expiry filter before limit (or fetch 20 then expiry-filter then slice 1).
- **[REQ]** Scope timetable by `schoolId`; add `try/catch` around PDF trigger with reset.
- **[REC]** Keyed `ChildDetail`, deduplicate Fees loader, collapse 7 → 5 tabs via overflow menu.

---

## 5. Attendance + Timetables — `AttendanceModule`/`CourseAttendance` / `TimetableModule*` / `attendanceService` / `courseAttendanceService` / `timetableService` / `courseOfferingTimetableService` / `LivePeriodWidget` / `TermProgressCard`

### 5.1 Broken — alarm is the headline (still failing on device, as documented)

- Wiring is structurally complete (`App:1209 actorRecordId → TimetableModule:67 → LivePeriodWidget:205`). Five stacked failure modes, ranked:
  1. `timetable_entries.staff_id` null via `teaching_assignments` join miss `timetableService:114` — window `alert_scope='mine'` (default) never matches → silent no-op (doc lead #2, never verified live).
  2. `AudioContext` suspended — only gesture-primed by "Test sound" `AccountPreferences:808`; boundary fires from `setInterval` non-gesture → stays suspended on iOS.
  3. Period-boundary latch gap — `fireAlarmsIfNeeded:235` end-tone needs `previousId != nextId`; break/non-school gaps skip the transition; background throttling skips 1 s tick.
  4. Panel-only mount — widget lives only on Timetable tab; away at boundary = missed by design.
  5. Diagnostic coverage missing on warn path `269` and gate exit `235`.
- Other breaks: temp-entry id `temp-${Date.now()} TimetableModuleSecondary:455` never reconciled → delete via `deleteTimetableEntry('temp-…')` always fails `489`; HigherEd empty-state copy stale post-9.5 (`TimetableModuleHigherEd:505`); `combined-register` paths work (`attendanceService:406`) but class-level permission filtering absent `AttendanceModule:20`; `CourseAttendance:743` heading "No school today" also used for insert/RLS errors `courseAttendance:354`.

### 5.2 Poor UX

- Register usability: whole-school inline arm list (no collapse), mark-all overwrites with no confirm `Attendance:793`, attendance analytics present (`905`, `1107`) but per-course analytics/history missing by design.
- Timetable edit learnability: armed-chip mode indicator weak; conflicts as title-only badge `1127`.

### 5.3 Docs divergence

- Holiday-aware school-day + `extends_term` engine `attendanceService:985` and `TermProgressCard:90` present as specified.
- Analytics strips present; 30-day history strip present.
- Per-course attendance parity: no analytics/history by design — header comment `CourseAttendance:6` promises notice but renders hard empty `776` (contradicts self).

### 5.4 From-scratch take

- Keep `getCurrentPeriodState` pure engine. Rework alarms: `setTimeout` anchored to boundary timestamps while visible + `showNotification` for background, prime `AudioContext` on first app-wide pointerdown.
- CSS grid for timetable, replace `window.confirm:443` with inline confirm, fix N+1 eligibility loads `CourseAttendance:538`.

### 5.5 Fixes

- **[REQ]** Backfill/verify `timetable_entries.staff_id` for existing rows; prime audio globally; add visibility-change catch-up; fix temp-id reconciliation.
- **[REQ]** Wire `canForClass` into class selectors; correct HigherEd copy and `CourseAttendance` error heading.
- **[REC]** Batch eligibility, paginate combined registers.

---

## 6. Results + Courses + Registration + Admission + Library + Announcements

### 6.1 Results (secondary `ResultsModule`/`resultsService` + higher-ed `CourseResultsModule`/`courseResultsService`/`gpaService`)

- **Broken:** none hard-broken post-Tier 8. Publish gate, re-finalize auto-unpublish `courseResults:281`, finalize 100% check, carryover RPC, guardian published-only cache `425` all verified.
- **UX:** component drafts save onBlur only — unsaved draft vs finalize preview diverge `CourseResults:483`; transcript semester sort is string `localeCompare:908` not chronological.
- **Docs:** now that Tier 8 windows ship, secondary entry is no longer dead. GPA pure engine hand-verified correct.
- **[REC]** Add unique `course_registration_id` + real upsert; move GPA recompute into one RPC.

### 6.2 Course Registration (`CourseRegistration:583` / `courseRegistrationService:89`)

- **Broken:** `registerStudent` per-term reconciliation gap flagged `337` — active rows on other terms in same session never withdrawn (write per-term, read session-scoped).
- **Docs vs reality:** `TIER_9:369 9.6 ⬜` is stale — summary view, admin Drop inline confirm, student readOnly, PDF student-only, core-course banner all **shipped** and even improved (session-scoped read fixes multi-term bug docs missed).
- **[REQ]** Surgical add/drop RPCs.

### 6.3 Admission (`AdmissionModule:1` / `admissionService:1`)

- **Broken:** `saveMatricNumberFormat:207` is deactivate-then-insert **non-atomic** — insert failure leaves zero active format. `ClosedTab:897` renders `purge_at` (future purge date) as "Data purged".
- **Missing:** Applications intake form stub `473` — JAMB/O'Level/DE custom fields authored in Settings **never rendered**.
- **Docs divergence:** Versioning (`is_active` partial unique) **is** shipped `admissionService:24`, but `saveMatric…` still uses two client calls (race). `pg_cron` purge job is prose only (`MASTER_PLAN:4596`); no migration/cron in repo (`grep pg_cron: 0`).
- **[REQ]** One-RPC `saveMatricFormat`, render intake fields, fix "Data purged" copy, add list pagination, ship the cron migration idempotently.

### 6.4 Library (`LibraryModule:1` / `libraryService:1`)

- **Broken:** `checkoutBook:362` = 3 sequential writes (verify → insert borrow → update copy) non-atomic; `handleIssueFine:1043` writes fake `id:''` into state.
- **[REQ]** Wrap checkout/return in a Postgres function; align `libraryService` error style to `{data,error}`; auto-compute fines.

### 6.5 Announcements (`AnnouncementsModule:1` / `announcementsService:1`)

- **Broken:** Unread badge capped at 50 (`limit(50):279` vs unused `loadUnreadCount:313` → `99+` dead code `Announcements:151`).
- **[REQ]** Use `loadUnreadCount()`; add `announcements.delete` key (currently `isAdmin` fallback).

---

## 7. Settings — `SettingsModule:1` (~6760 lines, 15 tab bodies)

**Known gaps the audit confirms still live:**

- `SchoolTab` logo upload uses `set-logo-upload-*` classes — grep `set-logo-upload` in `index.css` = **0** (unstyled).
- `RolesTab` `load()` does `Promise.all([loadRoles, loadPermissionsCatalog])` but early-returns only on `rRes.error` — catalog failure leaves stale/empty list with no visible error `TIER_9:84` flagged, not fixed.

**Structure:** 15 tabs in one file. Higher-ed tabs (`institution`/`curriculum`/`offerings`/`grading`/`standing` vs secondary `classes`) branching via `isHigherInstitutionSchoolType` is sensible but the file is now unmaintainable without feature-folder split. The new `AssessmentsSettings` extraction (Tier 8) is the right pattern to continue.

**Docs vs reality:** Calendar `ScheduleTab`/`CalendarTab` already carry `school_calendar_days` holiday bulk entry + `extends_term` flag folded early (owner-requested) — Session 29's card was the only remainder. Expected.

**Fixes:**

- **[REQ]** Add missing logo-upload CSS; fix `RolesTab` `load()` to surface whichever of the two fetches failed.
- **[REC]** Split `SettingsModule` into `settings/tabs/*` with lazy imports — continue the `AssessmentsSettings` precedent.

---

## 8. Onboarding + Auth Surfaces + App Shell

### 8.1 Broken (ranked) — alarm already covered in §5

- **`offlineQueue` reload loss: FIXED** — `lib/offlineQueue.ts:27` is now IndexedDB-backed (`eduskola_offline` DB `33`), not Phase-0 in-memory; doc saying in-memory is stale.
- **`initialize()` vs routing race: mitigated** by `App:569` guard (`slugState==='loading' || !isInitialized || authLoading` skeleton prevents transient `isWrongSchool` true when `identitySchoolId` still null).

### 8.2 Poor UX

- Login: two tabs `staff|code` `LoginPage:73` minimal hints; onboarding 8 steps `OnboardingWizard:62` long, progress bar `166` + dots `175` only, no global saved toast, `Step5Gate:731` branch confusing.
- Account popover (`App:839`) holds Language "Coming soon" `877`, Audit log `904` (admin only), Sign out `918` — but Settings stays in More sheet `1569`, so two admin destinations live in two places.
- Badge toast (`App:480` 60 s poll, fire-on-increase only `496`) has no inbox/deep-link.

### 8.3 Docs divergence

- Language i18n: present & inert as documented — `App:877` + `AccountPreferences:191` "Coming soon", rows 35–43 deferred — accurate.
- Public posts fallback `welcome_post → welcome_message` present (`publicHomepageService:192`, `PublicHomepage:302`).
- Logo 512 px PNG (`settingsService:632`), PlatformHomepage apex handling (`App:176`), wrong-school generic copy (`App:638`) — all present as specified.

### 8.4 From-scratch take

- `sessionStorage activeTab` (`App:73`) is a deliberate shared-device choice (no leak) but trades away deep-links/back-button/history. A `react-router` with `/timetable?intent=` would give shareable URLs; tab memory could be `history.state`.
- `authStore:158` init shape is clean; `FINANCE_PERMISSION_KEYS:67` hard-coded 11 keys drifts — should be DB-driven.

### 8.5 Remaining top-line counts (all `src/`)

| Metric | Count | Notes |
|---|---|---|
| `TODO/FIXME` | 0 | Clean |
| `console.log` | 2 | Both `[alarm-debug]` in `LivePeriodWidget:222,252` — diagnostic, documented |
| `console.warn` | 4 | `icons/index.tsx:530`, `offlineQueue:128`, `SettingsModule:1297`, `printTimetable:254` |
| `window.confirm/alert(` | 64 | Top: `AssessmentsSettings:27`, `SettingsModule:25`, `LibraryModule:7`, `TimetableModuleHigherEd:3`, `Announcements:2` |
| `auth.getUser(` | 0 | Migrated to `auth.getSession` in scope |

---

## 9. Other Surfaces

- **Admin/Teacher dashboards:** dashboards render; Teacher `isAdminRole` split correct (`authStore:113`, `App:356`). No hard stubs remain (old `// TODO` wired Session 6); intent payloads threaded.
- **Library guardian nav:** bottom-nav `library:109` (`staffHidden`) correctly routes to `LibraryModule` for guardians — matches "nav, not portal tab" framing.
- **Printing:** `printTimetable:231` + `printStudentIdCards` Blob-URL approach (Android-safe, 60 s revoke) present.

---

## 10. Ordered Fix Plan — What to do next

### P0 — Required regardless of docs (ship before any polish)

1. **DB layer**
   - (a) `scores_admin_full` hotfix already written — run it.
   - (b) Recreate `subject_results` with `security_invoker=true` (or RPC) + add `school_id` filter discipline review.
   - (c) Wrap Library checkout/return + Admission `saveMatricFormat` + HR leave review in RPCs/transactions.
2. **Session contamination** — server-side balance view/RPC for Finance; scope portal fee/timetable reads (add `schoolId` param to `loadCurrentSession`).
3. **HR guards** — `reviewLeaveRequest` status gate + null-reviewer fail; `salary_structures effective_from <= now()`; due-estimate `status='paid'` filter.
4. **Portal bugs** — announcements limit-then-expiry swap; `StudentRegistrationDownload` try/catch+reset; `GuardianModule:668` null `class_path_label`.
5. **Attendance alarm** — verify `timetable_entries.staff_id` backfill + global `primeAudioContext` on first pointerdown + warn-path logging; fix `CourseAttendance` heading + `TimetableModuleSecondary:455` temp-id + fix `initiateTransfer` `supabaseUrl` bug `studentsService:1697`.

### P1 — Required to match docs

6. Ship the one-file hotfixes that close documented gaps: `loadUnreadCount:313` for badge; `set-logo-upload` CSS; `RolesTab` error surfacing; render Admission intake fields (Settings field-settings are already authored); correct `AdmissionModule:897` "Data purged" copy.
7. Decide on `report_card_templates` — either implement the template system the docs promise (`MASTER_PLAN:1006` `report_card_templates` unused; we shipped a fixed WAEC layout in `reportCardPdf`) **or** amend the docs to declare the fixed layout as the product. Don't leave both.
8. Build the deferred-but-small `pg_cron` purge migration idempotently (docs claim it, repo has 0 SQL for it) or explicitly defer it.

### P2 — Recommended beyond docs (do only with your sign-off)

9. **Architecture:** split the three monoliths (`StudentsModule:4298`, `HRModule:2978`, `SettingsModule:6760`) into `features/*` with lazy tabs; extract `usePortalQuery`/`useAsyncResult` hooks; promote shared helpers (`formatNaira`, `methodLabel`, `isHigherInstitutionSchoolType`) to `lib/`.
10. **Data layer:** single RPC for GPA recompute (publish/unpublish/finalize can't drift); surgical add/drop RPCs for registration; keyset pagination + server `ilike` search.
11. **Routing & offline:** `react-router` with shareable `/students/:id`, `/timetable?week=` + persisted `activeTab` fallback; confirm IndexedDB queue has a background sync loop + `navigator.onLine` → `uiStore` wiring.
12. **i18n:** don't attempt the big-bang rows 35–43 arc. Start incremental: extract a tiny `t(key)` (English-only) and wrap one module (Announcements) as proof — same advice `PRD 7.2` already gives, but even leaner.

---

## 11. Where the docs are the lower bar

Cases where following the document uncritically would be a step back:

- **`PRD 6.5`** says "consolidate `window.confirm` onto `Modal.tsx`" — the docs' own later sessions kept using `window.confirm` 64 times. The modal doesn't replace confirm for destructive actions until you actually do it; treat the doc as directionally right but under-shipped.
- **`MASTER_PLAN §4.2`** bottom-nav vs sidebar: docs prescribe bottom-nav primary on phone which is correct — but the sidebar's non-persisted collapse `Sidebar:65` reintroduces the doc's own "never lose work" violation on reload; persist it.
- **Payments `paid_at not null default now()`** (pre-hotfix) was wrong for RRR-pending flows — we already fixed it to nullable in Session 70 and guard the render; doc text there was never updated.

---

*Tell me which of the P2 items — and the `security_invoker` change (P0-1b, which touches every school) — you want treated as in-scope for Phase 2, and which to leave as tracked-forward debt. Phase 2 edits will not begin until you confirm the order and any deviation-from-docs choices above.*
