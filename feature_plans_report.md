# Feature Plans Report — Teacher Punctuality Tracker & Scheme of Work

## Overview

Two new features to build on top of the eduportal-ng codebase (React + TypeScript + Vite + Supabase), following existing patterns for RLS, permissions, offline queueing, and dashboard card design.

---

## Feature 1 — Teacher Punctuality Tracker

### Concept

Track whether each teacher was actually present during their scheduled timetable periods — recorded by an authorized staff member (proctor), NOT by teachers self-reporting. Report surfaces on Admin and HR dashboards only; teachers must never see this data.

### Data Model — New Table: `teacher_punctuality`

| Column | Type | Description |
|---|---|---|
| `id` | `uuid primary key default gen_random_uuid()` | Primary key |
| `school_id` | `uuid not null references schools(id)` | School scoping (existing convention) |
| `timetable_entry_id` | `uuid not null references timetable_entries(id)` | Links to a specific period slot |
| `recorded_by` | `uuid not null references staff(id)` | Proctor's identity (the staff member recording) |
| `present` | `boolean not null` | Binary: present or absent (no partial/late state) |
| `source` | `text not null check (source in ('day_shortcut','period_override'))` | Audit context: day-level bulk write or individual override |
| `recorded_at` | `timestamptz not null default now()` | When the record was created |

### Permission Key: `attendance.staff_punctuality.record`

- New row in the `permissions` catalog: `key = 'attendance.staff_punctuality.record'`, `module = 'attendance'`, `description = 'Record teacher punctuality presence'`
- Exposed through the existing `permissionsService.ts`/`authStore.ts` catalog

### RLS Design (CRITICAL — Privacy Requirement)

This is the hardest part. Teachers must **not** be able to see punctuality records even if they inspect network requests or the database directly.

**Table RLS policies (run in the same migration as table creation):**

1. **`[STD]` (default) SELECT policy:**
   ```sql
   for all using (school_id = current_school_id())
   ```

2. **Additional restrictive SELECT policy** (only platform_admin + staff with the permission can read):
   ```sql
   for select using (
     is_platform_admin() OR
     exists (
       select 1 from staff_permission_class_scope sps
       join app_identities ai on ai.school_id = sps.school_id
       where sps.staff_id = auth.uid()::text  -- or appropriate FK
         and sps.permission_key = 'attendance.staff_punctuality.record'
         and (sps.class_id is null or exists (
           select 1 from class_nodes cn
           where cn.id = sps.class_id and cn.school_id = current_school_id()
         ))
     )
   )
   ```

   *Simpler approach verified in codebase:* Since `staff_permission_class_scope` already has `school_id` column and `[STD]` policy, we can rely on the join pattern used throughout this app. The key design is:

   - `staff_permission_class_scope` row for `(staff_id, 'attendance.staff_punctuality.record')` grants read access
   - RLS on `teacher_punctuality` checks this join via `current_school_id()`
   - Teachers without that specific row get zero SELECT rows back

3. **INSERT policy** (same gate): only platform_admin + staff holding the permission can insert records

4. **UPDATE/DELETE policy**: platform_admin only (or staff with permission for their own records, admins can override)

**RLS Helper Function Pattern (existing in codebase):**
- Use `current_school_id()` — every table has `school_id` scoping via this function
- Pattern: `[STD]` = `for all using (school_id = current_school_id())`
- New policy adds the permission check on top of school scoping

### Two Views for the Proctor (Same Underlying Data)

**1. Day-level shortcut view:**
- Per-teacher list for the current day
- Marking one teacher "present" auto-fills ALL of that teacher's scheduled periods for the day as fulfilled/present
- Fast path for the common case (teacher was in all day)
- Writes to `teacher_punctuality` records for each of the teacher's timetable_entry rows for that day

**2. Periods view:**
- Granular per-period, per-teacher grid for the day (or selected day)
- Any individual assignment can be marked/overridden independently of the day-level shortcut
- Must be able to override whatever the day-level shortcut set — e.g., a teacher present all day except one period they missed should be correctable here without re-doing the whole day
- Overriding in the periods view after using the day shortcut should update just that one record (same table)

Both views write to the **same** `teacher_punctuality` table. The day shortcut is a bulk-write convenience over the same records the periods view edits individually.

### Reporting Surface

- **Admin dashboard** and **HR dashboard** cards/reports
- Per teacher (and ideally per subject/class)
- Contacts fulfilled vs scheduled over a selectable period (day/week/term)
- Standard "useful, at-a-glance" analytics matching existing dashboard cards elsewhere in the app

**Unrecorded vs absent:** By default, unrecorded periods should be visually distinct from "absent" in the report so admins can tell the difference between "known missed" and "nobody checked." (Flag this for confirmation before building differently.)

### UI Locations

- Admin dashboard and HR dashboard only
- No teacher-facing UI entry point
- No self-check-in capability for teachers

### Code Changes Required

1. **Migration:** Create `teacher_punctuality` table + 4 RLS policies + insert `attendance.staff_punctuality.record` into `permissions` catalog
2. **`src/services/permissionsService.ts`:** No changes needed — existing `can()` / `canForClass()` pattern handles new key
3. **`src/stores/authStore.ts`:** No changes needed — existing `FINANCE_PERMISSION_KEYS` pattern; add `PUNCTUALITY_PERMISSION_KEYS` if needed, or just use `can('attendance.staff_punctuality.record')` generically
4. **New component:** `ProctorPunctualityRecordForm.tsx` — day shortcut + periods grid toggle
5. **Admin dashboard:** Punctuality report card (import existing dashboard card pattern)
6. **HR dashboard:** Punctuality report card

---

## Feature 2 — Scheme of Work

### Concept

Syllabus/term-plan feature: teachers can create/submit a scheme of work, or adopt/adapt a standardized curriculum template from a recognized education board. Admins can track each teacher's actual progress against their submitted/adopted scheme over the term.

### Data Models

**1. `schemes_of_work` table (school-scoped):**

| Column | Type | Description |
|---|---|---|
| `id` | `uuid primary key default gen_random_uuid()` | Primary key |
| `school_id` | `uuid not null references schools(id)` | School scoping |
| `teacher_id` | `uuid not null references staff(id)` | Owning teacher |
| `subject` | `text not null` | Subject name |
| `class_id` | `uuid not null references class_nodes(id)` | Class/node |
| `term` | `text not null` | Term identifier |
| `week` | `integer not null` | Week number |
| `topic` | `text not null` | Topic/lesson title |
| `status` | `text not null check (status in ('planned','in progress','completed'))` | Progress status |
| `created_at` | `timestamptz not null default now()` | Creation timestamp |
| `updated_at` | `timestamptz not null default now()` | Update timestamp |

**RLS:** `[STD]` — `for all using (school_id = current_school_id())`. Teachers can read/write their own rows. Admins can read all rows across school.

**2. `curriculum_templates` table (platform-scoped, reusable):**

| Column | Type | Description |
|---|---|---|
| `id` | `uuid primary key default gen_random_uuid()` | Primary key |
| `board` | `text not null` | Education board name (e.g. 'WAEC', 'NERDC', 'NECO') |
| `subject` | `text not null` | Subject the template covers |
| `weeks` | `jsonb not null default '[]'::jsonb` | Week-by-week topic breakdown |
| `is_placeholder` | `boolean not null default true` | Mark template as placeholder content |
| `created_at` | `timestamptz not null default now()` | Creation timestamp |

**Purpose:** Platform-scoped so templates can be shared across schools. Populated with realistic-looking placeholder data (plausible subjects/weeks/topics). Visible "Coming soon" badge unambiguous that this is placeholder, not authoritative board curriculum.

**RLS:** Public read (`for select to public using (true)`) — templates are reference data. Write restricted to platform admin.

**"Behind Schedule" Definition (mechanical, date-driven):**

An entry is "behind schedule" when:
- Its planned week/date has **passed** (current date > planned week/date), AND
- It is still marked **"planned"** or **"in progress"** (not "completed")

This is a **date-driven check** — don't try to infer pacing or teaching quality.

Report: Admin sees which teachers have entries behind schedule, per subject/class, over a selectable period.

### UI

**Teacher-facing:**
- View/edit their own scheme of work
- Mark progress per week/topic (planned → in progress → completed)
- Load a standardized curriculum template as a starting point (copies template rows into their `schemes_of_work`)
- "Coming soon" badge visible on template picker

**Admin-facing:**
- View progress across teachers/subjects
- See who's behind schedule per the definition above
- Standard "useful, at-a-glance" analytics matching existing dashboard cards

### "Coming Soon" Badge

- Template picker clearly labeled with visible badge/banner: **"Coming soon"** or equivalent
- Unambiguous to any user that this is placeholder content, not an authoritative WAEC/NERDC/other board curriculum
- Even though the underlying feature is fully working code (data model, template loading, copy-to-teacher UI)

### Structure Template Table for Future Boards

- Designed so real curriculum data can be swapped in later without a schema change
- `board` column identifies the source board
- `is_placeholder` flag distinguishes placeholder vs real data
- `weeks` as `jsonb` allows arbitrary structure per board

### Code Changes Required

1. **Migration:** Create `schemes_of_work` table + create `curriculum_templates` table + insert placeholder template data
2. **Seed data:** Populate `curriculum_templates` with realistic placeholder data (subjects, weeks, topics)
3. **`src/services/schemeOfWorkService.ts`:** Service functions for CRUD on `schemes_of_work`, template loading/copying
4. **New component:** `TeacherSchemeOfWork.tsx` — teacher's view/edit their scheme, load template
5. **New component:** `AdminSchemeOfWorkReport.tsx` — admin views progress, behind schedule
6. **Permission key:** `scheme_of_work.*` — follow existing catalog pattern; gate teacher UI on `scheme_of_work.view_own` or similar, admin sees all
7. **`src/stores/authStore.ts`:** Optional — add `canSchemeOfWork()` selector if needed

---

## Implementation Sequence

**Build Feature 1 first (Teacher Punctuality Tracker):**
- Database migration (table + RLS policies + permission key) — highest risk, needs verification
- Proctor recording UI (day shortcut + periods grid)
- Admin/HR punctuality reports
- **Mandatory test:** Confirm a teacher-role identity cannot read the data (RLS test)

**Then build Feature 2 (Scheme of Work):**
- Database tables + seed data
- Teacher-facing scheme of work UI
- Admin-facing progress reporting
- "Coming soon" badge on template picker

---

## Plan Approval

This plan respects the existing codebase conventions:
- RLS patterns from master plan §3.2, §3.7
- Permission catalog from §7.3 and PRD Tier 3
- Dashboard card design from existing modules
- Offline queue pattern from `lib/offlineQueue.ts` (not directly needed for these features but verified)
- Live period resolution reused from `timetableService.getCurrentPeriodState()` (Feature 1)
- `staff_permission_class_scope` resolution order (Feature 1 RLS)
- `isHigherEdSchool()` pattern for school-type-aware branching (Feature 2)

Please approve this plan and I'll start building Feature 1 (Teacher Punctuality Tracker) first.