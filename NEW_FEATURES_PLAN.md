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

A syllabus/term-plan feature with four capabilities:
1. Teachers create/submit a scheme of work (structured term plan, broken down by week/topic, per subject and class).
2. Admins adopt standardized curriculum templates from recognized education boards (NERDC/WAEC) into a school's scheme.
3. Admins build and manage school-owned reusable templates, adoptable into any class/subject/term/session.
4. Admins track each teacher's actual progress against their submitted/adopted scheme over the term.

### Two Kind of Template

**Board Templates** — platform-wide, seeded content (NERDC/WAEC). Stored in `curriculum_templates`. Not owned by any school. Read-only for all authenticated users; admin write for management. Marked with `is_placeholder = true` until verified curriculum data is added. Adopting a board template into a specific class+subject forks it into `schemes_of_work` + `scheme_of_work_weeks`.

**School Templates** — school-owned, built from scratch by admin. Stored in `school_curriculum_templates` + `school_curriculum_template_weeks`. Scoped to the creating school. Reusable any number of times. Fields like subject/level are optional plain-text labels (not FKs), used only for findability. At adoption time, the admin picks the actual live class+subject fresh.

### Data Model

```sql
-- Per-teacher, per-assignment scheme (term_id nullable for flexibility)
create table schemes_of_work (
  id                     uuid primary key default gen_random_uuid(),
  school_id              uuid not null references schools(id),
  teaching_assignment_id uuid not null references teaching_assignments(id),
  session_id             uuid not null references sessions(id),
  term_id                uuid references terms(id),  -- nullable
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

-- Board-level curriculum templates (platform-wide, not school-scoped)
create table curriculum_templates (
  id            uuid primary key default gen_random_uuid(),
  board_name    text not null,   -- 'NERDC', 'WAEC'
  subject_name  text not null,
  level         text not null,   -- 'JSS1', 'SSS3', etc.
  term          text not null,
  is_placeholder boolean not null default true,
  week_number   integer not null,
  topic         text not null,
  objectives    text,
  activities    text,
  resources     text,
  created_at    timestamptz not null default now(),
  unique(board_name, subject_name, level, term, week_number)
);

-- School-owned reusable templates
create table school_curriculum_templates (
  id                uuid primary key default gen_random_uuid(),
  school_id         uuid not null references schools(id),
  name              text not null,           -- "JSS1 Mathematics — My Version"
  subject_label     text,                    -- optional plain text, not a FK
  class_level_label text,                    -- optional plain text, not a FK
  created_by        uuid references auth.users(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Weekly content for school-owned templates
create table school_curriculum_template_weeks (
  id                uuid primary key default gen_random_uuid(),
  template_id       uuid not null references school_curriculum_templates(id) on delete cascade,
  school_id         uuid not null references schools(id),
  week_number       integer not null,
  topic             text not null,
  objectives        text,
  activities        text,
  resources         text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique(template_id, week_number)
);
```

### RLS Policies

```sql
-- schemes_of_work — teacher sees own; admin/view_all sees all
alter table schemes_of_work enable row level security;

create policy sow_select on schemes_of_work
  for select using (
    school_id = current_school_id()
    and (
      current_is_admin()
      or current_has_permission('academics.scheme_of_work.view_all')
      or teaching_assignment_id in (
        select id from teaching_assignments
        where staff_id = (select actor_record_id from app_identities where auth_user_id = auth.uid() and actor_type = 'staff')
      )
    )
  );

create policy sow_insert on schemes_of_work
  for insert with check (
    school_id = current_school_id()
    and (current_is_admin() or current_has_permission('academics.scheme_of_work.manage'))
  );

create policy sow_update on schemes_of_work
  for update using (
    school_id = current_school_id()
    and (
      current_is_admin()
      or current_has_permission('academics.scheme_of_work.manage')
      or (teaching_assignment_id in (
        select id from teaching_assignments
        where staff_id = (select actor_record_id from app_identities where auth_user_id = auth.uid() and actor_type = 'staff')
      ) and status in ('draft', 'returned'))
    )
  ) with check (school_id = current_school_id());

-- scheme_of_work_weeks — admin can import into any status; owner can update coverage
alter table scheme_of_work_weeks enable row level security;

create policy sow_weeks_select on scheme_of_work_weeks
  for select using (
    school_id = current_school_id()
    and scheme_of_work_id in (select id from schemes_of_work)
  );

create policy sow_weeks_insert on scheme_of_work_weeks
  for insert with check (
    school_id = current_school_id()
    and (
      scheme_of_work_id in (select id from schemes_of_work where status in ('draft', 'returned'))
      or current_is_admin()
    )
  );

create policy sow_weeks_delete on scheme_of_work_weeks
  for delete using (
    school_id = current_school_id()
    and (
      scheme_of_work_id in (select id from schemes_of_work where status in ('draft', 'returned'))
      or current_is_admin()
    )
  );

create policy sow_weeks_update on scheme_of_work_weeks
  for update using (
    school_id = current_school_id()
    and (
      scheme_of_work_id in (select id from schemes_of_work where status in ('draft', 'returned'))
      or current_has_permission('academics.scheme_of_work.manage')
      or scheme_of_work_id in (
        select id from schemes_of_work
        where teaching_assignment_id in (
          select id from teaching_assignments
          where staff_id = (select actor_record_id from app_identities where auth_user_id = auth.uid() and actor_type = 'staff')
        )
      )
    )
  ) with check (school_id = current_school_id());

-- curriculum_templates — board templates: public read, admin write
alter table curriculum_templates enable row level security;

create policy curriculum_templates_select on curriculum_templates
  for select using (auth.role() = 'authenticated');

create policy curriculum_templates_insert on curriculum_templates
  for insert with check (current_is_admin());

create policy curriculum_templates_update on curriculum_templates
  for update using (current_is_admin());

create policy curriculum_templates_delete on curriculum_templates
  for delete using (current_is_admin());

-- school_curriculum_templates — school-scoped CRUD
alter table school_curriculum_templates enable row level security;

create policy school_tpl_select on school_curriculum_templates
  for select using (school_id = current_school_id());

create policy school_tpl_insert on school_curriculum_templates
  for insert with check (
    school_id = current_school_id()
    and (current_is_admin() or current_has_permission('academics.scheme_of_work.manage'))
  );

create policy school_tpl_update on school_curriculum_templates
  for update using (
    school_id = current_school_id()
    and (current_is_admin() or current_has_permission('academics.scheme_of_work.manage'))
  ) with check (school_id = current_school_id());

create policy school_tpl_delete on school_curriculum_templates
  for delete using (
    school_id = current_school_id() and current_is_admin()
  );

-- school_curriculum_template_weeks — school-scoped CRUD
alter table school_curriculum_template_weeks enable row level security;

create policy school_tpl_weeks_select on school_curriculum_template_weeks
  for select using (school_id = current_school_id());

create policy school_tpl_weeks_insert on school_curriculum_template_weeks
  for insert with check (
    school_id = current_school_id()
    and (current_is_admin() or current_has_permission('academics.scheme_of_work.manage'))
  );

create policy school_tpl_weeks_update on school_curriculum_template_weeks
  for update using (
    school_id = current_school_id()
    and (current_is_admin() or current_has_permission('academics.scheme_of_work.manage'))
  ) with check (school_id = current_school_id());

create policy school_tpl_weeks_delete on school_curriculum_template_weeks
  for delete using (
    school_id = current_school_id()
    and (current_is_admin() or current_has_permission('academics.scheme_of_work.manage'))
  );
```

### Permission Keys

| Key | Purpose | Default grant |
|---|---|---|
| `academics.scheme_of_work.view_all` | View all teachers' schemes (admin, HOD) | Admin roles |
| `academics.scheme_of_work.manage` | Create/edit own schemes, submit, manage school templates | Teachers, admin |
| `academics.scheme_of_work.approve` | Approve/return submitted schemes | Admin only |

### Service Layer — `src/services/schemeOfWorkService.ts`

```ts
// ─── Scheme CRUD ────────────────────────────────────────────────
loadMySchemes(sessionId)                        // teacher's own schemes
loadAllSchemes({ sessionId?, status? })         // admin: all schemes (sessionId optional for "all sessions")
loadSchemeDetail(schemeId)                      // single scheme with timetable-derived weeks
createScheme({ schoolId, teachingAssignmentId, sessionId, termId, userId })
saveSchemeWeeks(schemeId, schoolId, weeks)
submitScheme(schemeId)                          // draft|returned → submitted
approveScheme(schemeId, reviewerStaffId)        // submitted → approved
returnScheme(schemeId, reviewerStaffId, note)   // submitted → returned
markWeekCoverage(weekId, status, note?)
getSowSummary(sessionId)

// ─── Board templates (curriculum_templates) ─────────────────────
loadCurriculumTemplates({ boardName?, subjectName?, level?, term? })
loadCurriculumMetadata()                        // distinct board/subject/level/term combos
loadAllTemplateSets()                           // grouped sets with week counts
saveCurriculumTemplate(rows)                    // admin creates/updates board template
deleteCurriculumTemplate(board, subject, level, term)

// ─── School templates (school_curriculum_templates) ─────────────
loadSchoolTemplates(schoolId)
loadSchoolTemplateDetail(templateId, schoolId)
createSchoolTemplate({ schoolId, name, subjectLabel, classLevelLabel, userId, weeks })
updateSchoolTemplate({ templateId, schoolId, name, subjectLabel, classLevelLabel, weeks })
deleteSchoolTemplate(templateId, schoolId)

// ─── Adoption (shared mechanism for both template types) ────────
importFromTemplate(schemeId, schoolId, { subject_name, level, term, board_name })  // board → scheme
adoptSchoolTemplate(schemeId, schoolId, templateId)                                 // school → scheme
```

### "Behind Schedule" Definition

A scheme week entry is **behind schedule** when:
- Its `week_number` corresponds to a date that has already passed (calculated as: term start date + (week_number - 1) × 7 days)
- AND its `coverage_status` is `planned` or `in_progress`

This is a mechanical, date-driven check. No inference about pacing or teaching quality.

### UI — Three Screens

#### Screen 1: List View (main screen)

- **Status tabs:** All / Draft / Submitted / Approved / Returned
- **Session filter:** dropdown (Current session / All sessions / specific session)
- **Class filter:** dropdown derived from fetched schemes (only classes with schemes)
- **Templates button:** navigates to Screen 2
- **New button:** navigates to Screen 1b (create picker)

#### Screen 1b: New Scheme Picker (2 options)

- **Create Manually:** select class + subject → weeks auto-generated from timetable
- **Create Template:** navigates to Screen 3 (school template builder)

#### Screen 2: Templates Screen (2 tabs)

- **Board Templates tab:** lists NERDC/WAEC template sets with "Adopt" action. Shows placeholder/unverified indicator. Not editable/deletable.
- **My School's Templates tab:** lists school templates with "Adopt", "Edit", "Delete" actions.
- **Board adopt flow:** board → subject → level → term cascading dropdowns, then class → subject in school
- **School adopt flow:** class → subject in school

#### Screen 3: Create/Edit Template Form

- **Template Name** (required)
- **Subject** (optional plain text label)
- **Class Level** (optional plain text label)
- **Week-by-week content:** topic, objectives, activities, resources per week
- No board, no term, no live class/subject picker

#### Detail View

- Week-by-week breakdown with coverage tracking
- Edit button (draft/returned schemes)
- Import Template button (admin, opens board import modal)
- Approve/Return buttons (admin, on submitted schemes)
- Coverage progress bar

### Curriculum Template Data

6 template sets seeded (NERDC + WAEC, 13 weeks each):

| Board | Subject | Level | Weeks |
|---|---|---|---|
| NERDC | Mathematics | JSS1 | 13 (First Term) |
| NERDC | English Language | JSS1 | 13 (First Term) |
| NERDC | Basic Science | JSS1 | 13 (First Term) |
| WAEC | Mathematics | SSS1 | 13 (First Term) |
| WAEC | English Language | SSS1 | 13 (First Term) |
| WAEC | Biology | SSS1 | 13 (First Term) |

All marked `is_placeholder = true` — verified curriculum data replaces these over time.

---

## Implementation Scope

### Files to Create

| File | Purpose |
|---|---|
| `migration_punctuality_tracker.sql` | Table + RLS + permission inserts |
| `migration_scheme_of_work.sql` | Tables + RLS + permission inserts |
| `migration_scheme_of_work_v2.sql` | term_id nullable, curriculum_templates RLS writes, real NERDC/WAEC templates, unique constraint |
| `migration_scheme_of_work_v3.sql` | is_placeholder column, school_curriculum_templates, school_curriculum_template_weeks, RLS |
| `src/services/schemeOfWorkService.ts` | CRUD + board/school template loading + adoption + progress tracking |
| `src/routes/PunctualityModule.tsx` | Proctor entry UI (day-level + periods grid) |
| `src/routes/SchemeOfWorkModule.tsx` | 3-screen UI: list + templates + school template builder |

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
- Real curriculum data beyond the 6 seeded template sets (placeholder only, per spec)
- Teacher self-check-in (explicitly excluded per spec)

---

## Open Questions

1. **Punctuality RLS — admin scope:** `current_is_admin()` in the SELECT policy means anyone with `is_admin_role = true` on any role can see punctuality data. Should this be narrower (e.g. only roles with `academics.punctuality.view`), or is admin-bypass acceptable per the existing convention?

2. **Scheme of Work — teacher visibility:** Teachers can only see their own schemes, or should department heads see all schemes in their department? I defaulted to "own only" with `view_all` for admin.

3. **Dashboard cards — placement:** New cards in the existing `dash-stat-grid`, or separate section panels below the grid (like the attendance analytics panel)?

4. **Module routing:** Separate entries in the More sheet, or sub-tabs within existing modules (Punctuality → Attendance, Scheme of Work → Results)?

5. **Board template verification:** The 6 seeded board templates are marked `is_placeholder = true`. How should verified curriculum data be added later? (Admin upload UI? Platform-managed SQL inserts?)
