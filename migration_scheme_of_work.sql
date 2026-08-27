-- ============================================================================
-- migration_scheme_of_work.sql
-- Feature 2: Scheme of Work — Teacher term planning with weekly coverage.
--
-- Teachers create/submit a scheme of work (structured term plan, broken down
-- by week/topic, per subject and class). Admins track progress against the
-- submitted scheme over the term.
--
-- Tables:
--   1. schemes_of_work         — per-teacher, per-assignment scheme shell
--   2. scheme_of_work_weeks    — weekly/topic breakdown
--   3. curriculum_templates    — platform-level reusable templates
--
-- Permission keys (3 new):
--   academics.scheme_of_work.view_all   — view all teachers' schemes (admin/HOD)
--   academics.scheme_of_work.manage     — create/edit/submit own schemes (teachers)
--   academics.scheme_of_work.approve    — approve/return submitted schemes (admin)
--
-- Idempotent: safe to re-run (create-if-not-exists / on-conflict-do-nothing).
-- ============================================================================

-- ── 1. schemes_of_work ──────────────────────────────────────────────────────

create table if not exists schemes_of_work (
  id                     uuid primary key default gen_random_uuid(),
  school_id              uuid not null references schools(id),
  teaching_assignment_id uuid not null references teaching_assignments(id),
  session_id             uuid not null references sessions(id),
  term_id                uuid not null references terms(id),
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

comment on table schemes_of_work is
  'Per-teacher, per-assignment scheme of work for a term. '
  'Teachers create/edit in draft, submit for admin approval.';

-- updated_at trigger
drop trigger if exists set_updated_at_schemes_of_work on schemes_of_work;
create trigger set_updated_at_schemes_of_work
  before update on schemes_of_work
  for each row execute function set_updated_at();

-- Indexes
create index if not exists idx_sow_school_session
  on schemes_of_work(school_id, session_id, term_id);
create index if not exists idx_sow_assignment
  on schemes_of_work(school_id, teaching_assignment_id);
create index if not exists idx_sow_status
  on schemes_of_work(school_id, status);

-- ── 2. scheme_of_work_weeks ─────────────────────────────────────────────────

create table if not exists scheme_of_work_weeks (
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

comment on table scheme_of_work_weeks is
  'Weekly/topic breakdown for a scheme of work. Each row is one week.';

-- updated_at trigger
drop trigger if exists set_updated_at_scheme_of_work_weeks on scheme_of_work_weeks;
create trigger set_updated_at_scheme_of_work_weeks
  before update on scheme_of_work_weeks
  for each row execute function set_updated_at();

-- Indexes
create index if not exists idx_sow_weeks_scheme
  on scheme_of_work_weeks(scheme_of_work_id);

-- ── 3. curriculum_templates ─────────────────────────────────────────────────

create table if not exists curriculum_templates (
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

comment on table curriculum_templates is
  'Platform-level reusable curriculum templates. Placeholder content, '
  'clearly labeled as such in the UI. Not official board curriculum.';

-- Indexes for filtered queries
create index if not exists idx_curr_tpl_board_subject
  on curriculum_templates(board_name, subject_name, level, term);

-- ── RLS ────────────────────────────────────────────────────────────────────

-- schemes_of_work
alter table schemes_of_work enable row level security;

-- SELECT: admin, view_all permission, or teacher's own schemes
drop policy if exists sow_select on schemes_of_work;
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

-- INSERT: admin or manage permission
drop policy if exists sow_insert on schemes_of_work;
create policy sow_insert on schemes_of_work
  for insert with check (
    school_id = current_school_id()
    and (
      current_is_admin()
      or current_has_permission('academics.scheme_of_work.manage')
    )
  );

-- UPDATE: admin, manage permission, or teacher's own draft/returned schemes
drop policy if exists sow_update on schemes_of_work;
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
  )
  with check (school_id = current_school_id());

-- scheme_of_work_weeks
alter table scheme_of_work_weeks enable row level security;

-- SELECT: scoped via parent scheme
drop policy if exists sow_weeks_select on scheme_of_work_weeks;
create policy sow_weeks_select on scheme_of_work_weeks
  for select using (
    school_id = current_school_id()
    and scheme_of_work_id in (select id from schemes_of_work)
  );

-- INSERT/UPDATE: only when parent scheme is draft or returned
drop policy if exists sow_weeks_write on scheme_of_work_weeks;
create policy sow_weeks_write on scheme_of_work_weeks
  for all using (
    school_id = current_school_id()
    and scheme_of_work_id in (
      select id from schemes_of_work where status in ('draft', 'returned')
    )
  )
  with check (school_id = current_school_id());

-- curriculum_templates — platform-level read-only for all authenticated users
alter table curriculum_templates enable row level security;

drop policy if exists curriculum_templates_select on curriculum_templates;
create policy curriculum_templates_select on curriculum_templates
  for select using (auth.role() = 'authenticated');

-- No INSERT/UPDATE/DELETE — templates are platform-managed

-- ── Permission catalog additions ───────────────────────────────────────────

insert into permissions (key, module, description) values
  ('academics.scheme_of_work.view_all',  'academics', 'View all teachers schemes of work (admin/HOD)'),
  ('academics.scheme_of_work.manage',    'academics', 'Create, edit, and submit own schemes of work'),
  ('academics.scheme_of_work.approve',   'academics', 'Approve or return submitted schemes of work')
on conflict (key) do nothing;

-- ── Placeholder curriculum templates ───────────────────────────────────────

-- NERDC Mathematics JSS1
insert into curriculum_templates (board_name, subject_name, level, term, week_number, topic, objectives, activities, resources) values
('NERDC (Placeholder)', 'Mathematics', 'JSS1', 'First Term', 1, 'Number Systems — Whole Numbers', 'Understand place value up to millions; count and write in figures and words', 'Counting exercises, place value charts, oral drills', 'Textbook Ch.1, Number charts'),
('NERDC (Placeholder)', 'Mathematics', 'JSS1', 'First Term', 2, 'Number Systems — Fractions', 'Identify proper and improper fractions; add and subtract simple fractions', 'Fraction circles, group work, worksheet exercises', 'Textbook Ch.2, Fraction kits'),
('NERDC (Placeholder)', 'Mathematics', 'JSS1', 'First Term', 3, 'Basic Algebra — Introduction', 'Use letters to represent unknowns; write simple algebraic expressions', 'Pattern recognition, equation solving games', 'Textbook Ch.3, Algebra tiles'),
('NERDC (Placeholder)', 'Mathematics', 'JSS1', 'First Term', 4, 'Geometry — Shapes and Angles', 'Identify 2D and 3D shapes; measure angles with protractor', 'Shape sorting, angle measurement activities', 'Textbook Ch.4, Protractors, Geometric solids'),
('NERDC (Placeholder)', 'Mathematics', 'JSS1', 'First Term', 5, 'Measurement — Length and Perimeter', 'Measure lengths in cm, m, km; calculate perimeter of rectangles', 'Measuring activities, field exercises', 'Textbook Ch.5, Rulers, Measuring tapes'),
('NERDC (Placeholder)', 'Mathematics', 'JSS1', 'First Term', 6, 'Measurement — Weight and Capacity', 'Measure weight in g, kg; volume in litres', 'Weighing activities, container measurement', 'Textbook Ch.6, Weighing scale, Graduated cylinders'),
('NERDC (Placeholder)', 'Mathematics', 'JSS1', 'First Term', 7, 'Data Handling — Pictograms and Bar Charts', 'Collect data; represent using pictograms and bar charts', 'Class survey, chart drawing', 'Textbook Ch.7, Graph paper'),
('NERDC (Placeholder)', 'Mathematics', 'JSS1', 'First Term', 8, 'Middle of Term Revision and Test', 'Revise weeks 1–7; administer mid-term test', 'Revision exercises, past questions', 'Test papers'),
('NERDC (Placeholder)', 'Mathematics', 'JSS1', 'First Term', 9, 'Fractions — Multiplication and Division', 'Multiply and divide simple fractions; word problems', 'Group problem solving, fraction games', 'Textbook Ch.8, Fraction strips'),
('NERDC (Placeholder)', 'Mathematics', 'JSS1', 'First Term', 10, 'Decimals — Introduction', 'Identify tenths and hundredths; convert fractions to decimals', 'Decimal place value charts, conversion exercises', 'Textbook Ch.9'),
('NERDC (Placeholder)', 'Mathematics', 'JSS1', 'First Term', 11, 'Lines, Angles and Plane Figures', 'Identify parallel and perpendicular lines; types of angles', 'Drawing activities, angle classification', 'Textbook Ch.10, Set squares'),
('NERDC (Placeholder)', 'Mathematics', 'JSS1', 'First Term', 12, 'End of Term Revision', 'Comprehensive revision of all topics', 'Group revision, past questions', 'Revision guide'),
('NERDC (Placeholder)', 'Mathematics', 'JSS1', 'First Term', 13, 'End of Term Examination', 'Examine all topics covered in the term', 'Examination', 'Exam papers')
on conflict do nothing;

-- NERDC English Language JSS1
insert into curriculum_templates (board_name, subject_name, level, term, week_number, topic, objectives, activities, resources) values
('NERDC (Placeholder)', 'English Language', 'JSS1', 'First Term', 1, 'Parts of Speech — Nouns and Pronouns', 'Identify and classify nouns (common, proper, abstract); use pronouns correctly', 'Word classification games, sentence building', 'Textbook Ch.1, Word cards'),
('NERDC (Placeholder)', 'English Language', 'JSS1', 'First Term', 2, 'Parts of Speech — Verbs and Adjectives', 'Identify action and linking verbs; use adjectives to describe', 'Verb charades, adjective brainstorming', 'Textbook Ch.2'),
('NERDC (Placeholder)', 'English Language', 'JSS1', 'First Term', 3, 'Reading Comprehension — Strategies', 'Use context clues; identify main idea and supporting details', 'Guided reading, comprehension exercises', 'Textbook Ch.3, Reading passages'),
('NERDC (Placeholder)', 'English Language', 'JSS1', 'First Term', 4, 'Writing — Sentence Construction', 'Construct simple, compound, and complex sentences', 'Sentence combining, punctuation practice', 'Textbook Ch.4, Worksheets'),
('NERDC (Placeholder)', 'English Language', 'JSS1', 'First Term', 5, 'Vocabulary Development — Synonyms and Antonyms', 'Identify synonyms and antonyms; expand vocabulary', 'Word matching, vocabulary games', 'Textbook Ch.5, Dictionary'),
('NERDC (Placeholder)', 'English Language', 'JSS1', 'First Term', 6, 'Oral English — Sound System', 'Identify vowel and consonant sounds; pronunciation practice', 'Sound drills, tongue twisters, pair work', 'Textbook Ch.6, Audio clips'),
('NERDC (Placeholder)', 'English Language', 'JSS1', 'First Term', 7, 'Summary Writing', 'Summarize passages in own words; identify key points', 'Guided summarization, group work', 'Textbook Ch.7, Passage excerpts'),
('NERDC (Placeholder)', 'English Language', 'JSS1', 'First Term', 8, 'Middle of Term Revision and Test', 'Revise weeks 1–7; administer mid-term test', 'Revision exercises', 'Test papers'),
('NERDC (Placeholder)', 'English Language', 'JSS1', 'First Term', 9, 'Letter Writing — Formal and Informal', 'Write formal and informal letters; identify letter parts', 'Letter writing practice, format drills', 'Textbook Ch.8, Letter templates'),
('NERDC (Placeholder)', 'English Language', 'JSS1', 'First Term', 10, 'Grammar — Tenses', 'Identify and use present, past, and future tenses', 'Tense transformation exercises, gap fills', 'Textbook Ch.9'),
('NERDC (Placeholder)', 'English Language', 'JSS1', 'First Term', 11, 'Literature — Types of Literature', 'Identify prose, poetry, drama; read selected passages', 'Read-aloud, discussion, drama skits', 'Textbook Ch.10, Anthology'),
('NERDC (Placeholder)', 'English Language', 'JSS1', 'First Term', 12, 'End of Term Revision', 'Comprehensive revision of all topics', 'Group revision, past questions', 'Revision guide'),
('NERDC (Placeholder)', 'English Language', 'JSS1', 'First Term', 13, 'End of Term Examination', 'Examine all topics covered in the term', 'Examination', 'Exam papers')
on conflict do nothing;

-- NERDC Basic Science JSS1
insert into curriculum_templates (board_name, subject_name, level, term, week_number, topic, objectives, activities, resources) values
('NERDC (Placeholder)', 'Basic Science', 'JSS1', 'First Term', 1, 'Living Things — Characteristics', 'Identify characteristics of living things; classify organisms', 'Nature walk, specimen observation', 'Textbook Ch.1, Magnifying glasses'),
('NERDC (Placeholder)', 'Basic Science', 'JSS1', 'First Term', 2, 'The Human Body — Systems', 'Name major body systems; describe their functions', 'Body outline labeling, group presentation', 'Textbook Ch.2, Body charts'),
('NERDC (Placeholder)', 'Basic Science', 'JSS1', 'First Term', 3, 'Matter — States and Properties', 'Identify solid, liquid, gas; describe properties of each', 'Experiment: water states, material sorting', 'Textbook Ch.3, Beakers, Ice'),
('NERDC (Placeholder)', 'Basic Science', 'JSS1', 'First Term', 4, 'Energy — Forms and Sources', 'Identify forms of energy; distinguish renewable and non-renewable', 'Energy sources discussion, demonstration', 'Textbook Ch.4, Battery, Torch'),
('NERDC (Placeholder)', 'Basic Science', 'JSS1', 'First Term', 5, 'The Environment — Ecosystems', 'Describe components of an ecosystem; identify human impact', 'Ecosystem models, environmental survey', 'Textbook Ch.5, Chart paper'),
('NERDC (Placeholder)', 'Basic Science', 'JSS1', 'First Term', 6, 'Water — Properties and Uses', 'Describe properties of water; identify uses in daily life', 'Water experiments, discussion', 'Textbook Ch.6, Beakers'),
('NERDC (Placeholder)', 'Basic Science', 'JSS1', 'First Term', 7, 'Air — Composition and Uses', 'Identify components of air; demonstrate oxygen support combustion', 'Candle experiment, air pollution discussion', 'Textbook Ch.7, Candles, Beakers'),
('NERDC (Placeholder)', 'Basic Science', 'JSS1', 'First Term', 8, 'Middle of Term Revision and Test', 'Revise weeks 1–7; administer mid-term test', 'Revision exercises', 'Test papers'),
('NERDC (Placeholder)', 'Basic Science', 'JSS1', 'First Term', 9, 'Soil — Types and Composition', 'Identify soil types; test soil composition', 'Soil sampling, filtration experiment', 'Textbook Ch.8, Soil samples, Funnel'),
('NERDC (Placeholder)', 'Basic Science', 'JSS1', 'First Term', 10, 'Health — Personal Hygiene', 'Identify good hygiene practices; explain importance', 'Hygiene checklist, role play', 'Textbook Ch.9'),
('NERDC (Placeholder)', 'Basic Science', 'JSS1', 'First Term', 11, 'Simple Machines', 'Identify simple machines; explain their uses', 'Model building, demonstration', 'Textbook Ch.10, Pulleys, Levers'),
('NERDC (Placeholder)', 'Basic Science', 'JSS1', 'First Term', 12, 'End of Term Revision', 'Comprehensive revision of all topics', 'Group revision, past questions', 'Revision guide'),
('NERDC (Placeholder)', 'Basic Science', 'JSS1', 'First Term', 13, 'End of Term Examination', 'Examine all topics covered in the term', 'Examination', 'Exam papers')
on conflict do nothing;

-- WAEC Mathematics JSS1 (placeholder variant)
insert into curriculum_templates (board_name, subject_name, level, term, week_number, topic, objectives, activities, resources) values
('WAEC (Placeholder)', 'Mathematics', 'JSS1', 'First Term', 1, 'Sets and Logic — Introduction', 'Understand set notation; identify elements of a set', 'Set activities, Venn diagrams', 'Textbook Ch.1, Venn diagram charts'),
('WAEC (Placeholder)', 'Mathematics', 'JSS1', 'First Term', 2, 'Number Bases — Binary and Decimal', 'Convert between binary and decimal; understand base-2 system', 'Binary counting, conversion exercises', 'Textbook Ch.2'),
('WAEC (Placeholder)', 'Mathematics', 'JSS1', 'First Term', 3, 'Factors and Multiples', 'Find factors and multiples; identify prime numbers', 'Factor trees, prime number games', 'Textbook Ch.3'),
('WAEC (Placeholder)', 'Mathematics', 'JSS1', 'First Term', 4, 'Fractions, Ratios and Proportions', 'Simplify ratios; solve proportion problems', 'Ratio problems, real-life examples', 'Textbook Ch.4'),
('WAEC (Placeholder)', 'Mathematics', 'JSS1', 'First Term', 5, 'Algebraic Expressions', 'Simplify algebraic expressions; factorize simple expressions', 'Algebra games, group exercises', 'Textbook Ch.5'),
('WAEC (Placeholder)', 'Mathematics', 'JSS1', 'First Term', 6, 'Mensuration — Area and Volume', 'Calculate area of triangles, circles; volume of cubes', 'Measurement activities, formula practice', 'Textbook Ch.6, Calculators'),
('WAEC (Placeholder)', 'Mathematics', 'JSS1', 'First Term', 7, 'Statistics — Mean, Median, Mode', 'Calculate mean, median, and mode from data sets', 'Data collection, calculation exercises', 'Textbook Ch.7'),
('WAEC (Placeholder)', 'Mathematics', 'JSS1', 'First Term', 8, 'Middle of Term Revision and Test', 'Revise weeks 1–7; administer mid-term test', 'Revision exercises', 'Test papers'),
('WAEC (Placeholder)', 'Mathematics', 'JSS1', 'First Term', 9, 'Coordinate Geometry — Plotting', 'Plot points on Cartesian plane; identify quadrants', 'Graph plotting, coordinate games', 'Textbook Ch.8, Graph paper'),
('WAEC (Placeholder)', 'Mathematics', 'JSS1', 'First Term', 10, 'Transformations — Reflection and Rotation', 'Identify reflection and rotation; apply to shapes', 'Shape transformations, mirror activities', 'Textbook Ch.9, Mirrors'),
('WAEC (Placeholder)', 'Mathematics', 'JSS1', 'First Term', 11, 'Probability — Introduction', 'Calculate simple probability; understand certainty and chance', 'Dice games, coin experiments', 'Textbook Ch.10, Dice, Coins'),
('WAEC (Placeholder)', 'Mathematics', 'JSS1', 'First Term', 12, 'End of Term Revision', 'Comprehensive revision of all topics', 'Group revision, past questions', 'Revision guide'),
('WAEC (Placeholder)', 'Mathematics', 'JSS1', 'First Term', 13, 'End of Term Examination', 'Examine all topics covered in the term', 'Examination', 'Exam papers')
on conflict do nothing;

-- ============================================================================
-- PRIVACY TEST (run after migration to confirm teacher visibility):
--
-- Step 1: Confirm teacher can only see their own schemes:
--   -- (run as a teacher-role identity)
--   SELECT count(*) FROM schemes_of_work;
--   -- Should return only schemes where teaching_assignment_id matches
--   -- the teacher's own teaching_assignments
--
-- Step 2: Confirm admin can see all schemes:
--   -- (run as admin identity)
--   SELECT count(*) FROM schemes_of_work;
--   -- Should return all schemes in the school
--
-- Step 3: Confirm curriculum templates are visible to all:
--   SELECT count(*) FROM curriculum_templates;
--   -- Should return all template rows
-- ============================================================================
