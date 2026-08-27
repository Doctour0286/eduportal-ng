# New Features Plan — Teacher Punctuality Tracker + Scheme of Work

> Generated from codebase exploration of `/root/eduportal-ng`. All claims cite `file:line` where applicable.

---

## Codebase Findings

### Patterns to Reuse

| Pattern | Location | Convention |
|---|---|---|
| Permission keys | `HRModule.tsx:230-235`, `FinanceModule.tsx:191-239` | `<module>.<feature>.action` — e.g. `hr.staff.manage`, `academics.attendance.mark`, `finance.payments.record` |
| RLS | `MASTER_PLAN §7` | `[STD]` base: `school_id = current_school_id()` + `current_has_permission('key')` for role-gated writes |
| Dashboard cards | `AdminDashboard.tsx:62-77` | `dash-stat-card dash-stat-card--{accent}` with icon + label + value + sub, inside `dash-section` wrapper |
| Analytics panels | `AttendanceModule.tsx:905-976` | Tab-based scope selection (`day/week/term/session`) with `.att-analytics-tabs` pill UI |
| Period resolution | `timetableService.ts:460` | Pure function `getCurrentPeriodState(data, classNodes, now)` — returns status/period/liveGrid/upcoming |
| Service error handling | `attendanceService.ts:1405` | `friendlyError()` translates RLS violations to plain-English messages |
| Offline queue | `lib/offlineQueue.ts:27` | `queueWrite()` / `flushQueue()` pattern with IndexedDB backend |

### `staff_id` Reliability

- `timetable_entries.staff_id` is **nullable by design** — `null` means a free/supervised period (no teaching assignment). Join chain: `timetable_entries → teaching_assignments(staff_id) → staff(full_name)`.
- The `teaching_assignment_id` column on `timetable_entries` is nullable. When null, both `staff_id` and `staff_name` resolve to null.
- `LivePeriodWidget.tsx:205-212` uses `staff_id` for alarm scoping via `teachesThisPeriod()` — confirms the field is actively used but only for entries with non-null staff.
- Audit flagged `staff_id` backfill as unverified (`PHASE1_AUDIT:164,302`) — but for punctuality, entries with null staff are irrelevant (no teacher to track). Server-side validation will reject records for entries with `staff_id IS NULL`.

### Existing Subject/Curriculum Structures

| Structure | Exists? | Reusable for Scheme of Work? |
|---|---|---|
| `subjects` table | Yes — flat `id/name/code` | Indirectly — via `teaching_assignments → subject_id` |
| `teaching_assignments` | Yes — `staff_id + subject_id + class_node_id + session_id` | **Primary anchor** — PRD §7.15a designs SOW to attach here |
| `programme_curriculum` | Yes — higher-ed only | No — different concept (course assignment, not topic planning) |
| Topics/weekly breakdown | No | Must create new |
| NERDC/WAEC syllabus references | No | Must create new (placeholder data) |
| `schemes_of_work` schema | Designed in PRD §7.15a, **zero implementation** | Follow this design |

### Dashboard Card Pattern

```tsx
<div className={`dash-stat-card dash-stat-card--${accent}`}>
  <div className="dash-stat-icon">{icon}</div>
  <div className="dash-stat-body">
    <div className="dash-stat-label">{label}</div>
    {loading ? <Skeleton /> : <div className="dash-stat-value">{value}</div>}
    {sub && <div className="dash-stat-sub">{sub}</div>}
  </div>
</div>
```

CSS: `--color-surface` bg, `--shadow-sm`, `--radius-lg`, min-height 88px, left-border accent stripe. Grid: `dash-stat-grid` (2-column CSS grid, gap `--space-3`).

### Analytics Period Selection Pattern

```tsx
// State
const [analyticsScope, setAnalyticsScope] = useState<'day'|'week'|'term'|'session'>('day');

// Tabs
<div className="att-analytics-tabs" role="tablist">
  {(['day','week','term','session'] as const).map(s => (
    <button key={s} className={`att-analytics-tab${analyticsScope===s?' att-analytics-tab--active':''}`}
      onClick={() => setAnalyticsScope(s)}>{s}</button>
  ))}
</div>

// Data loading — resolves date range from scope, queries service
useEffect(() => { load(scope, startDate, endDate) }, [analyticsScope]);
```

---

## Feature 1: Teacher Punctuality Tracker

### Concept

Track whether each teacher was present during their scheduled timetable periods — recorded by an authorized staff member (proctor), NOT by teachers self-reporting. Reports surface on Admin and HR dashboards only. Teachers must never see this data about themselves or others. Presence is binary: present or absent (no partial/late state).

### Data Model

```sql
create table teacher_punctuality_records (
  id              uuid primary key default gen_random_uuid(),
  school_id       uuid not null references schools(id),
  timetable_entry_id uuid not null references timetable_entries(id),
  staff_id        uuid not null references staff(id),  -- denormalized for fast queries
  recorded_by     uuid not null references staff(id),  -- the proctor
  status          text not null check (status in ('present', 'absent')),
  record_date     date not null,                        -- denormalized for date-range queries
  recording_source text not null default 'period_override'
                    check (recording_source in ('day_shortcut', 'period_override')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique(school_id, timetable_entry_id)  -- one record per entry per school
);

-- Index for date-range queries (admin/HR reports)
create index idx_punctuality_school_date on teacher_punctuality_records(school_id, record_date);
create index idx_punctuality_staff_date on teacher_punctuality_records(school_id, staff_id, record_date);
```

**Why denormalized `staff_id` + `record_date`:** Avoids a join to `timetable_entries` for every date-range query. Admin reports aggregate across many teachers/days — the join would be expensive. The `unique(school_id, timetable_entry_id)` constraint prevents duplicates at the DB level.

### RLS Policies

```sql
-- School isolation base
alter table teacher_punctuality_records enable row level security;

-- SELECT: only admin + punctuality viewers (teachers excluded entirely)
create policy "punctuality_select" on teacher_punctuality_records
  for select using (
    school_id = current_school_id()
    and (current_has_permission('academics.punctuality.view') or current_is_admin())
  );

-- INSERT/UPDATE: only proctors with record permission + admins
create policy "punctuality_write" on teacher_punctuality_records
  for all using (
    school_id = current_school_id()
    and (current_has_permission('academics.punctuality.record') or current_is_admin())
  ) with check (
    school_id = current_school_id()
    and (current_has_permission('academics.punctuality.record') or current_is_admin())
  );

-- No DELETE policy — audit trail, records are never deleted
```

**Privacy enforcement:** The `academics.punctuality.view` and `academics.punctuality.record` permission keys do not exist for any teacher role by default. Teachers have no permission that satisfies the SELECT policy → RLS returns zero rows → teachers see nothing even if they inspect network requests or query the database directly. `current_is_admin()` is included for admin bypass per the codebase convention (`admin should have no restrictions` — user directive).

### Permission Keys

| Key | Purpose | Default grant |
|---|---|---|
| `academics.punctuality.view` | View punctuality reports (Admin, HR) | Admin roles |
| `academics.punctuality.record` | Mark teacher presence (proctors) | Specific roles only |
| `academics.punctuality.manage` | Assign proctors, override records | Admin only |

### Service Layer — `src/services/punctualityService.ts`

**Key functions:**

```ts
// Load today's scheduled teachers (for proctor day-level view)
async function loadScheduledTeachersForDate(
  schoolId: string, sessionId: string, date: string
): Promise<Result<ScheduledTeacher[]>>

// Returns: { staff_id, staff_name, entries: TimetableEntry[], recordedCount, totalCount }

// Bulk mark: day-level shortcut — marks ALL of a teacher's periods as present
async function markTeacherFullDay(
  schoolId: string, staffId: string, date: string, status: 'present'|'absent',
  recordedBy: string, timetableEntryIds: string[]
): Promise<Result<void>>

// Individual period mark/override
async function markPeriodRecord(
  schoolId: string, timetableEntryId: string, staffId: string,
  status: 'present'|'absent', recordedBy: string, date: string,
  source: 'day_shortcut'|'period_override'
): Promise<Result<void>>

// Load punctuality data for admin/HR reports
async function loadPunctualityReport(params: {
  schoolId: string, scope: 'day'|'week'|'term'|'session',
  startDate: string, endDate: string, staffId?: string
}): Promise<Result<PunctualityReport>>

// Summary stats for dashboard cards
async function getPunctualitySummary(
  schoolId: string, scope: 'day'|'week'|'term'|'session',
  startDate: string, endDate: string
): Promise<Result<PunctualitySummary>>
```

**Offline queue:** Follow `attendanceService.ts` pattern — on network error, `queueWrite('teacher_punctuality_records', 'insert', payload)`, return `{ ok: true, queued: true }`.

### UI

#### Proctor Entry — `src/routes/PunctualityModule.tsx`

New module, accessible from:
- Admin/HR dashboards as a card/button
- Or as a route in the More sheet (gated by `can('academics.punctuality.record')`)

Two sub-views within the same module:

1. **Day-level view (default):** Per-teacher list for today (or selected date). Each row shows teacher name, subjects taught today, and a toggle/mark-all button. Marking "present" bulk-writes all their scheduled periods. Shows count: "3 of 5 periods marked".

2. **Periods view:** Granular per-period, per-teacher grid. Columns = periods (sorted by `sort_order`), Rows = teachers. Each cell is a toggle (present/absent/dash for unrecorded). Clicking any cell writes/overrides that single record. Day-level shortcuts are reflected here and can be individually overridden.

**Date picker:** Both views support selecting any date (not just today) for retroactive recording.

#### Admin Dashboard Card

```tsx
<div className="dash-stat-card dash-stat-card--success">
  <div className="dash-stat-icon"><CheckCircle /></div>
  <div className="dash-stat-body">
    <div className="dash-stat-label">TEACHER PUNCTUALITY</div>
    <div className="dash-stat-value">{present}/{total}</div>
    <div className="dash-stat-sub">teachers present today</div>
  </div>
</div>
```

Clicking opens a full report panel with tab-based scope selection (day/week/term/session), per-teacher breakdown, and subject/class filtering.

#### HR Dashboard Card

Similar card but with term-level view and per-teacher summary table.

### Unrecorded vs Absent

- **Unrecorded:** No row exists in the table. LEFT JOIN from scheduled entries → records produces null. Displayed as a grey dash `—`.
- **Absent:** Row exists with `status = 'absent'`. Displayed as a red `✗`.
- **Present:** Row exists with `status = 'present'`. Displayed as a green `✓`.

This distinction is preserved in the data model and all queries. Admins can see "nobody checked" vs "known missed" at a glance.

---

## Feature 2: Scheme of Work

### Concept

A syllabus/term-plan feature with three capabilities:
1. Teachers create/submit a scheme of work (structured term plan, broken down by week/topic, per subject and class).
2. Teachers adopt/adapt a standardized curriculum template from a recognized education board as a starting point, then customize it.
3. Admins track each teacher's actual progress against their submitted/adopted scheme over the term.

### Data Model

```sql
-- Per-teacher, per-assignment scheme
create table schemes_of_work (
  id                     uuid primary key default gen_random_uuid(),
  school_id              uuid not null references schools(id),
  teaching_assignment_id uuid not null references teaching_assignments(id),
  session_id             uuid not null references academic_sessions(id),
  term_id                uuid not null references academic_terms(id),
  status                 text not null default 'draft'
                           check (status in ('draft', 'submitted', 'approved', 'returned')),
  reviewed_by            uuid references staff(id),
  reviewed_at            timestamptz,
  review_note            text,
  created_by             uuid references auth.users(id),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique(school_id, teaching_assignment_id, session_id, term_id)
);

-- Weekly/topic breakdown
create table scheme_of_work_weeks (
  id                  uuid primary key default gen_random_uuid(),
  scheme_of_work_id   uuid not null references schemes_of_work(id) on delete cascade,
  school_id           uuid not null references schools(id),
  week_number         integer not null,
  topic               text not null,
  objectives          text,
  activities          text,
  resources           text,
  coverage_status     text not null default 'planned'
                        check (coverage_status in ('planned', 'in_progress', 'completed', 'not_covered')),
  coverage_note       text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique(scheme_of_work_id, week_number)
);

-- Reusable curriculum templates (platform-level, not school-scoped)
create table curriculum_templates (
  id            uuid primary key default gen_random_uuid(),
  board_name    text not null,   -- 'NERDC (Placeholder)', 'WAEC (Placeholder)'
  subject_name  text not null,
  level         text not null,   -- 'JSS1', 'SSS3', etc.
  term          text not null,
  week_number   integer not null,
  topic         text not null,
  objectives    text,
  activities    text,
  resources     text,
  created_at    timestamptz not null default now()
);
```

### RLS Policies

```sql
-- schemes_of_work
alter table schemes_of_work enable row level security;

create policy "sow_select" on schemes_of_work
  for select using (
    school_id = current_school_id()
    and (
      current_has_permission('academics.scheme_of_work.view_all')
      or current_is_admin()
      or teaching_assignment_id in (
        select id from teaching_assignments
        where staff_id = (select id from staff where user_id = auth.uid() and school_id = current_school_id())
      )
    )
  );

create policy "sow_write" on schemes_of_work
  for all using (
    school_id = current_school_id()
    and (
      current_has_permission('academics.scheme_of_work.manage')
      or current_is_admin()
      or (teaching_assignment_id in (
        select id from teaching_assignments
        where staff_id = (select id from staff where user_id = auth.uid() and school_id = current_school_id())
      ) and status in ('draft', 'returned'))
    )
  ) with check (
    school_id = current_school_id()
  );

-- scheme_of_work_weeks — scoped via parent
alter table scheme_of_work_weeks enable row level security;

create policy "sow_weeks_select" on scheme_of_work_weeks
  for select using (
    school_id = current_school_id()
    and scheme_of_work_id in (select id from schemes_of_work)
  );

create policy "sow_weeks_write" on scheme_of_work_weeks
  for all using (
    school_id = current_school_id()
    and scheme_of_work_id in (
      select id from schemes_of_work where status in ('draft', 'returned')
    )
  ) with check (
    school_id = current_school_id()
  );

-- curriculum_templates — platform-level read-only for all authenticated users
alter table curriculum_templates enable row level security;

create policy "curriculum_templates_select" on curriculum_templates
  for select using (auth.role() = 'authenticated');
```

### Permission Keys

| Key | Purpose | Default grant |
|---|---|---|
| `academics.scheme_of_work.view_all` | View all teachers' schemes (admin, HOD) | Admin roles |
| `academics.scheme_of_work.manage` | Create/edit own schemes, submit | Teachers, admin |
| `academics.scheme_of_work.approve` | Approve/return submitted schemes | Admin only |

### Service Layer — `src/services/schemeOfWorkService.ts`

```ts
// Load schemes for current teacher (or all for admin)
async function loadSchemesOfWork(params: {
  schoolId: string, sessionId: string, termId: string, staffId?: string
}): Promise<Result<SchemeOfWork[]>>

// Load weeks for a scheme
async function loadSchemeWeeks(
  schoolId: string, schemeId: string
): Promise<Result<SchemeOfWeek[]>>

// Create new scheme
async function createSchemeOfWork(params: {
  schoolId: string, teachingAssignmentId: string, sessionId: string, termId: string
}): Promise<Result<SchemeOfWork>>

// Update a week's content or coverage status
async function updateSchemeWeek(
  schoolId: string, weekId: string, updates: Partial<SchemeOfWeek>
): Promise<Result<void>>

// Submit scheme for approval
async function submitScheme(schoolId: string, schemeId: string): Promise<Result<void>>

// Approve/return scheme (admin)
async function reviewScheme(
  schoolId: string, schemeId: string, action: 'approve'|'return',
  note?: string, reviewedBy?: string
): Promise<Result<void>>

// Load curriculum templates
async function loadCurriculumTemplates(params: {
  boardName?: string, subjectName?: string, level?: string
}): Promise<Result<CurriculumTemplate[]>>

// Import template into scheme (copies template weeks into scheme)
async function importTemplateIntoScheme(
  schoolId: string, schemeId: string, templateFilter: {
    boardName: string, subjectName: string, level: string, term: string
  }
): Promise<Result<void>>

// Progress summary for admin dashboard
async function getSchemeProgressSummary(
  schoolId: string, sessionId: string, termId: string
): Promise<Result<SchemeProgressSummary>>
```

### "Behind Schedule" Definition

A scheme week entry is **behind schedule** when:
- Its `week_number` corresponds to a date that has already passed (calculated as: term start date + (week_number - 1) × 7 days)
- AND its `coverage_status` is `planned` or `in_progress`

This is a mechanical, date-driven check. No inference about pacing or teaching quality.

### UI

#### Teacher View — `src/routes/SchemeOfWorkModule.tsx`

- **List view:** Shows teacher's schemes per subject/class for the current term. Each scheme shows status badge (Draft/Submitted/Approved/Returned) and progress bar (completed weeks / total weeks).
- **Editor view:** Week-by-week table. Each row: week number, topic, objectives, activities, resources, coverage status dropdown. Inline editing with save-on-blur or explicit save button.
- **Template picker:** "Load from Template" button opens a modal with:
  - Board selector (dropdown: "NERDC (Placeholder)", "WAEC (Placeholder)")
  - Subject selector (filtered by what's in the teacher's `teaching_assignments`)
  - Level selector (JSS1, JSS2, etc.)
  - Term selector
  - Preview of template weeks before importing
  - **Visible badge:** "Coming soon — placeholder content, not official board curriculum"
  - Import button copies template weeks into the scheme as editable entries

#### Admin View

- **Schemes list:** Table of all teachers' schemes with columns: Teacher, Subject, Class, Status, Progress %, Behind Schedule count. Filterable by teacher/subject/status.
- **Detail view:** Click a scheme to see week-by-week breakdown with behind-schedule highlighting (red badge on past-due weeks).
- **Review workflow:** Submitted schemes show Approve/Return buttons with optional note.

#### Dashboard Card (Admin)

```tsx
<div className="dash-stat-card dash-stat-card--purple">
  <div className="dash-stat-icon"><BookOpen /></div>
  <div className="dash-stat-body">
    <div className="dash-stat-label">SCHEMES OF WORK</div>
    <div className="dash-stat-value">{submitted}/{total}</div>
    <div className="dash-stat-sub">{behindSchedule} behind schedule</div>
  </div>
</div>
```

### Placeholder Template Data

~10-15 weeks of realistic-looking topics for common subjects at JSS1 level:

| Board | Subject | Sample Weeks |
|---|---|---|
| NERDC (Placeholder) | Mathematics | Wk1: Number Systems, Wk2: Fractions, Wk3: Algebra Basics, ... |
| NERDC (Placeholder) | English Language | Wk1: Parts of Speech, Wk2: Reading Comprehension, ... |
| NERDC (Placeholder) | Basic Science | Wk1: Living Things, Wk2: Matter & Energy, ... |
| WAEC (Placeholder) | Mathematics | Wk1: Sets & Logic, Wk2: Number Bases, ... |

All clearly labeled "Coming soon — placeholder content" in the UI.

---

## Implementation Scope

### Files to Create

| File | Purpose |
|---|---|
| `migration_punctuality_tracker.sql` | Table + RLS + permission inserts |
| `migration_scheme_of_work.sql` | Tables + RLS + permission inserts + placeholder data |
| `src/services/punctualityService.ts` | Load/record/analytics functions |
| `src/services/schemeOfWorkService.ts` | CRUD + template loading + progress tracking |
| `src/routes/PunctualityModule.tsx` | Proctor entry UI (day-level + periods grid) |
| `src/routes/SchemeOfWorkModule.tsx` | Teacher editor + template picker + admin view |

### Files to Modify

| File | Change |
|---|---|
| `src/routes/AdminDashboard.tsx` | Add punctuality + scheme-of-work summary cards |
| `src/routes/HRModule.tsx` | Add punctuality summary card |
| `src/App.tsx` | Add route/module entries, nav items |
| `src/index.css` | Add new CSS classes |

### Out of Scope (noted separately)

- Refactoring unrelated modules
- Pagination/virtualization of existing lists (audit finding C5 — tracked separately)
- Real curriculum data (placeholder only, per spec)
- Teacher self-check-in (explicitly excluded per spec)

---

## Open Questions

1. **Punctuality RLS — admin scope:** `current_is_admin()` in the SELECT policy means anyone with `is_admin_role = true` on any role can see punctuality data. Should this be narrower (e.g. only roles with `academics.punctuality.view`), or is admin-bypass acceptable per the existing convention?

2. **Scheme of Work — teacher visibility:** Teachers can only see their own schemes, or should department heads see all schemes in their department? I defaulted to "own only" with `view_all` for admin.

3. **Dashboard cards — placement:** New cards in the existing `dash-stat-grid`, or separate section panels below the grid (like the attendance analytics panel)?

4. **Module routing:** Separate entries in the More sheet, or sub-tabs within existing modules (Punctuality → Attendance, Scheme of Work → Results)?
