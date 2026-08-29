-- ============================================================================
-- migration_scheme_of_work_hotfix.sql
-- Fixes for Scheme of Work migration (post-creation corrections):
--   1. Make term_id nullable — auto-resolved at app level from terms table
--   2. Fix curriculum_templates dedup — add unique constraint for seed data
-- ============================================================================

-- ── 1. Make term_id nullable ────────────────────────────────────────────────
-- term_id is resolved dynamically at app level from the current term.
-- No need to require it at schema level — it would block creation.

ALTER TABLE schemes_of_work ALTER COLUMN term_id DROP NOT NULL;

-- ── 2. Add unique constraint on curriculum_templates for dedup ──────────────
-- Prevents duplicate seed data on re-run. Uses board_name + subject + level + term + week.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'curriculum_templates_dedup'
  ) THEN
    ALTER TABLE curriculum_templates
      ADD CONSTRAINT curriculum_templates_dedup
      UNIQUE (board_name, subject_name, level, term, week_number);
  END IF;
END $$;

-- ── 3. Re-run seed data (ON CONFLICT DO NOTHING will now work correctly) ────
-- NERDC Mathematics JSS1
INSERT INTO curriculum_templates (board_name, subject_name, level, term, week_number, topic, objectives, activities, resources) VALUES
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
ON CONFLICT ON CONSTRAINT curriculum_templates_dedup DO NOTHING;

-- NERDC English Language JSS1
INSERT INTO curriculum_templates (board_name, subject_name, level, term, week_number, topic, objectives, activities, resources) VALUES
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
ON CONFLICT ON CONSTRAINT curriculum_templates_dedup DO NOTHING;

-- NERDC Basic Science JSS1
INSERT INTO curriculum_templates (board_name, subject_name, level, term, week_number, topic, objectives, activities, resources) VALUES
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
ON CONFLICT ON CONSTRAINT curriculum_templates_dedup DO NOTHING;
