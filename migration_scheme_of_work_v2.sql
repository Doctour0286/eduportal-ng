-- ============================================================================
-- migration_scheme_of_work_v2.sql
-- Fixes: term_id nullable, RLS for template writes, admin/owner week ops,
--        real NERDC + WAEC curriculum templates (no placeholders).
-- ============================================================================

-- ── 1. Make term_id nullable ─────────────────────────────────────────────────

alter table schemes_of_work alter column term_id drop not null;

-- ── 2. RLS: curriculum_templates — admin can write ──────────────────────────

alter table curriculum_templates enable row level security;

drop policy if exists curriculum_templates_select on curriculum_templates;
create policy curriculum_templates_select on curriculum_templates
  for select using (auth.role() = 'authenticated');

drop policy if exists curriculum_templates_insert on curriculum_templates;
create policy curriculum_templates_insert on curriculum_templates
  for insert with check (current_is_admin());

drop policy if exists curriculum_templates_update on curriculum_templates;
create policy curriculum_templates_update on curriculum_templates
  for update using (current_is_admin());

drop policy if exists curriculum_templates_delete on curriculum_templates;
create policy curriculum_templates_delete on curriculum_templates
  for delete using (current_is_admin());

-- ── 3. RLS: scheme_of_work_weeks — allow admin/owner on any status ──────────

-- INSERT: admin can import into any scheme
drop policy if exists sow_weeks_insert on scheme_of_work_weeks;
create policy sow_weeks_insert on scheme_of_work_weeks
  for insert
  with check (
    school_id = current_school_id()
    and (
      scheme_of_work_id in (
        select id from schemes_of_work where status in ('draft', 'returned')
      )
      or current_is_admin()
    )
  );

-- DELETE: admin can clear weeks on any scheme
drop policy if exists sow_weeks_delete on scheme_of_work_weeks;
create policy sow_weeks_delete on scheme_of_work_weeks
  for delete using (
    school_id = current_school_id()
    and (
      scheme_of_work_id in (
        select id from schemes_of_work where status in ('draft', 'returned')
      )
      or current_is_admin()
    )
  );

-- UPDATE: owner can update coverage on their own approved schemes
drop policy if exists sow_weeks_update on scheme_of_work_weeks;
create policy sow_weeks_update on scheme_of_work_weeks
  for update using (
    school_id = current_school_id()
    and (
      scheme_of_work_id in (
        select id from schemes_of_work where status in ('draft', 'returned')
      )
      or current_has_permission('academics.scheme_of_work.manage')
      or scheme_of_work_id in (
        select id from schemes_of_work
        where teaching_assignment_id in (
          select id from teaching_assignments
          where staff_id = (select actor_record_id from app_identities where auth_user_id = auth.uid() and actor_type = 'staff')
        )
      )
    )
  )
  with check (school_id = current_school_id());

-- ── 4. Delete placeholder templates ─────────────────────────────────────────

delete from curriculum_templates where board_name like '%Placeholder%';

-- ── 5. Real NERDC templates — Mathematics JSS1 First Term ──────────────────

insert into curriculum_templates (board_name, subject_name, level, term, week_number, topic, objectives, activities, resources) values
('NERDC', 'Mathematics', 'JSS1', 'First Term', 1,
 'Whole Numbers — Place Value and Ordering',
 'Identify place value up to millions; order whole numbers; write numbers in words and figures',
 'Place value chart exercises; number line activities; group ordering challenge',
 'Textbook Ch.1, Number charts, Place value cards'),

('NERDC', 'Mathematics', 'JSS1', 'First Term', 2,
 'Fractions — Introduction and Types',
 'Define fractions; identify proper, improper, and mixed numbers; compare fractions',
 'Fraction circles; shading exercises; fraction comparison cards',
 'Textbook Ch.2, Fraction kits, Coloured papers'),

('NERDC', 'Mathematics', 'JSS1', 'First Term', 3,
 'Basic Algebra — Using Letters',
 'Substitute values into simple expressions; identify unknowns; solve one-step equations',
 'Pattern recognition games; equation balance activities',
 'Textbook Ch.3, Algebra tiles, Balance scale'),

('NERDC', 'Mathematics', 'JSS1', 'First Term', 4,
 'Geometry — 2D and 3D Shapes',
 'Identify plane and solid shapes; name properties of quadrilaterals; classify angles',
 'Shape sorting; angle measurement with protractors; group classification',
 'Textbook Ch.4, Protractors, Geometric solids, Set squares'),

('NERDC', 'Mathematics', 'JSS1', 'First Term', 5,
 'Measurement — Length and Perimeter',
 'Measure lengths in mm, cm, m, km; calculate perimeter of rectangles and triangles',
 'Measuring activities with rulers; field perimeter walk',
 'Textbook Ch.5, Rulers, Measuring tapes'),

('NERDC', 'Mathematics', 'JSS1', 'First Term', 6,
 'Measurement — Weight and Capacity',
 'Measure mass in g, kg; volume in litres and ml; read scales accurately',
 'Weighing exercises; container capacity comparison',
 'Textbook Ch.6, Weighing scale, Graduated cylinders'),

('NERDC', 'Mathematics', 'JSS1', 'First Term', 7,
 'Middle of Term Revision and Test',
 'Revise weeks 1–6; administer mid-term assessment',
 'Revision exercises; past questions; test',
 'Test papers, Revision guide'),

('NERDC', 'Mathematics', 'JSS1', 'First Term', 8,
 'Fractions — Operations',
 'Add and subtract fractions with same and different denominators; word problems',
 'Fraction bar activities; problem-solving groups',
 'Textbook Ch.7, Fraction strips'),

('NERDC', 'Mathematics', 'JSS1', 'First Term', 9,
 'Decimals — Place Value and Operations',
 'Identify tenths and hundredths; add and subtract decimals; convert fractions to decimals',
 'Decimal place value charts; conversion exercises',
 'Textbook Ch.8, Number grids'),

('NERDC', 'Mathematics', 'JSS1', 'First Term', 10,
 'Lines, Angles and Plane Figures',
 'Identify parallel, perpendicular, and intersecting lines; classify angles as acute, obtuse, reflex',
 'Drawing activities; angle classification games',
 'Textbook Ch.9, Set squares, Rulers'),

('NERDC', 'Mathematics', 'JSS1', 'First Term', 11,
 'Data Handling — Tables and Charts',
 'Collect and organise data; construct frequency tables, bar charts, and pictograms',
 'Class survey project; chart construction',
 'Textbook Ch.10, Graph paper, Rulers'),

('NERDC', 'Mathematics', 'JSS1', 'First Term', 12,
 'End of Term Revision',
 'Comprehensive revision of all first term topics; practice past questions',
 'Group revision; past question practice',
 'Revision guide, Past question booklet'),

('NERDC', 'Mathematics', 'JSS1', 'First Term', 13,
 'End of Term Examination',
 'Examine all topics covered in the first term',
 'Examination',
 'Exam papers')
on conflict do nothing;

-- ── 6. Real NERDC templates — English Language JSS1 First Term ─────────────

insert into curriculum_templates (board_name, subject_name, level, term, week_number, topic, objectives, activities, resources) values
('NERDC', 'English Language', 'JSS1', 'First Term', 1,
 'Parts of Speech — Nouns and Pronouns',
 'Identify and classify nouns (common, proper, abstract, collective); use personal and possessive pronouns correctly',
 'Word classification games; sentence building with noun cards',
 'Textbook Ch.1, Word cards,flashcards'),

('NERDC', 'English Language', 'JSS1', 'First Term', 2,
 'Parts of Speech — Verbs and Adjectives',
 'Identify action and linking verbs; use adjectives to describe people, places, and things',
 'Verb charades; adjective brainstorming sessions',
 'Textbook Ch.2, Picture cards'),

('NERDC', 'English Language', 'JSS1', 'First Term', 3,
 'Reading Comprehension — Strategies',
 'Use context clues to guess meaning; identify main idea and supporting details; make inferences',
 'Guided reading of passages; comprehension exercises',
 'Textbook Ch.3, Reading passages, Comprehension sheets'),

('NERDC', 'English Language', 'JSS1', 'First Term', 4,
 'Writing — Sentence Construction',
 'Construct simple, compound, and complex sentences; use conjunctions correctly',
 'Sentence combining exercises; punctuation practice',
 'Textbook Ch.4, Worksheets'),

('NERDC', 'English Language', 'JSS1', 'First Term', 5,
 'Vocabulary — Synonyms and Antonyms',
 'Identify synonyms and antonyms; build vocabulary through word association',
 'Word matching games; vocabulary journal entries',
 'Textbook Ch.5, Dictionary, Thesaurus'),

('NERDC', 'English Language', 'JSS1', 'First Term', 6,
 'Oral English — Sound System',
 'Identify vowel and consonant sounds; practise correct pronunciation; use stress and intonation',
 'Sound drills; tongue twisters; pair pronunciation practice',
 'Textbook Ch.6, Audio clips'),

('NERDC', 'English Language', 'JSS1', 'First Term', 7,
 'Middle of Term Revision and Test',
 'Revise weeks 1–6; administer mid-term test',
 'Revision exercises; test',
 'Test papers'),

('NERDC', 'English Language', 'JSS1', 'First Term', 8,
 'Summary Writing',
 'Summarize passages in own words; identify key points; write concise summaries',
 'Guided summarization; group work on passages',
 'Textbook Ch.7, Passage excerpts'),

('NERDC', 'English Language', 'JSS1', 'First Term', 9,
 'Letter Writing — Formal and Informal',
 'Write formal and informal letters; identify parts of a letter (heading, salutation, body, closing)',
 'Letter writing practice; format drills',
 'Textbook Ch.8, Letter templates'),

('NERDC', 'English Language', 'JSS1', 'First Term', 10,
 'Grammar — Tenses',
 'Identify and use present simple, present continuous, past simple, and future tenses',
 'Tense transformation exercises; gap-fill activities',
 'Textbook Ch.9, Grammar worksheets'),

('NERDC', 'English Language', 'JSS1', 'First Term', 11,
 'Literature — Introduction to Prose and Poetry',
 'Identify prose and poetry; read and discuss selected passages; identify themes',
 'Read-aloud sessions; group discussion; poem recitation',
 'Textbook Ch.10, Anthology'),

('NERDC', 'English Language', 'JSS1', 'First Term', 12,
 'End of Term Revision',
 'Comprehensive revision of all first term topics; practice past questions',
 'Group revision; past question practice',
 'Revision guide'),

('NERDC', 'English Language', 'JSS1', 'First Term', 13,
 'End of Term Examination',
 'Examine all topics covered in the first term',
 'Examination',
 'Exam papers')
on conflict do nothing;

-- ── 7. Real NERDC templates — Basic Science JSS1 First Term ────────────────

insert into curriculum_templates (board_name, subject_name, level, term, week_number, topic, objectives, activities, resources) values
('NERDC', 'Basic Science', 'JSS1', 'First Term', 1,
 'Living Things — Characteristics',
 'Identify characteristics of living things (growth, reproduction, movement, etc.); classify organisms as living or non-living',
 'Nature walk; specimen observation; classification chart',
 'Textbook Ch.1, Magnifying glasses, Specimen jars'),

('NERDC', 'Basic Science', 'JSS1', 'First Term', 2,
 'The Human Body — Systems',
 'Name major body systems (digestive, respiratory, circulatory); describe basic functions of each',
 'Body outline labeling; group presentation on body systems',
 'Textbook Ch.2, Body charts, Posters'),

('NERDC', 'Basic Science', 'JSS1', 'First Term', 3,
 'Matter — States and Properties',
 'Identify solid, liquid, and gas; describe properties of each state; explain changes of state',
 'Experiment: heating and cooling water; material sorting',
 'Textbook Ch.3, Beakers, Ice, Thermometer'),

('NERDC', 'Basic Science', 'JSS1', 'First Term', 4,
 'Energy — Forms and Sources',
 'Identify forms of energy (heat, light, sound, electrical); distinguish renewable and non-renewable sources',
 'Energy sources demonstration; torch and battery experiment',
 'Textbook Ch.4, Battery, Torch, Solar panel demo'),

('NERDC', 'Basic Science', 'JSS1', 'First Term', 5,
 'The Environment — Ecosystems',
 'Describe components of an ecosystem (biotic and abiotic); identify human impact on the environment',
 'Ecosystem models; environmental survey project',
 'Textbook Ch.5, Chart paper, Markers'),

('NERDC', 'Basic Science', 'JSS1', 'First Term', 6,
 'Water — Properties and Uses',
 'Describe properties of water; identify uses in daily life; explain water cycle basics',
 'Water experiments (evaporation, condensation); discussion',
 'Textbook Ch.6, Beakers, Bunsen burner'),

('NERDC', 'Basic Science', 'JSS1', 'First Term', 7,
 'Middle of Term Revision and Test',
 'Revise weeks 1–6; administer mid-term test',
 'Revision exercises; test',
 'Test papers'),

('NERDC', 'Basic Science', 'JSS1', 'First Term', 8,
 'Air — Composition and Uses',
 'Identify components of air (nitrogen, oxygen, CO2); demonstrate oxygen supports combustion',
 'Candle-in-jar experiment; air pollution discussion',
 'Textbook Ch.7, Candles, Glass jars, Lime water'),

('NERDC', 'Basic Science', 'JSS1', 'First Term', 9,
 'Soil — Types and Composition',
 'Identify soil types (clay, sandy, loam); test soil composition and water retention',
 'Soil sampling; filtration experiment; water drainage test',
 'Textbook Ch.8, Soil samples, Funnels, Filter paper'),

('NERDC', 'Basic Science', 'JSS1', 'First Term', 10,
 'Health — Personal Hygiene',
 'Identify good hygiene practices; explain importance of cleanliness for health',
 'Hygiene checklist creation; role play on personal hygiene',
 'Textbook Ch.9, Posters'),

('NERDC', 'Basic Science', 'JSS1', 'First Term', 11,
 'Simple Machines',
 'Identify simple machines (lever, pulley, inclined plane); explain their uses in daily life',
 'Model building; demonstration of each simple machine type',
 'Textbook Ch.10, Pulleys, Levers, Ramps'),

('NERDC', 'Basic Science', 'JSS1', 'First Term', 12,
 'End of Term Revision',
 'Comprehensive revision of all first term topics; practice past questions',
 'Group revision; past question practice',
 'Revision guide'),

('NERDC', 'Basic Science', 'JSS1', 'First Term', 13,
 'End of Term Examination',
 'Examine all topics covered in the first term',
 'Examination',
 'Exam papers')
on conflict do nothing;

-- ── 8. Real WAEC templates — Mathematics SSS1 First Term ──────────────────

insert into curriculum_templates (board_name, subject_name, level, term, week_number, topic, objectives, activities, resources) values
('WAEC', 'Mathematics', 'SSS1', 'First Term', 1,
 'Sets — Notation and Operations',
 'Use set notation (belong, subset, union, intersection, complement); perform set operations',
 'Set exercises; Venn diagram activities',
 'Textbook Ch.1, Venn diagram charts'),

('WAEC', 'Mathematics', 'SSS1', 'First Term', 2,
 'Number Bases — Binary and Other Bases',
 'Convert between decimal and binary; understand base-2 and base-5 number systems',
 'Binary counting exercises; conversion practice',
 'Textbook Ch.2, Calculator'),

('WAEC', 'Mathematics', 'SSS1', 'First Term', 3,
 'Indices and Logarithms',
 'Apply laws of indices; define logarithms; convert between index and log form',
 'Index law exercises; log table practice',
 'Textbook Ch.3, Log tables'),

('WAEC', 'Mathematics', 'SSS1', 'First Term', 4,
 'Middle of Term Revision and Test',
 'Revise weeks 1–3; administer mid-term test',
 'Revision exercises; test',
 'Test papers'),

('WAEC', 'Mathematics', 'SSS1', 'First Term', 5,
 'Variation — Direct and Inverse',
 'Define direct, inverse, and joint variation; set up and solve variation problems',
 'Variation problem-solving; graph plotting',
 'Textbook Ch.4, Graph paper'),

('WAEC', 'Mathematics', 'SSS1', 'First Term', 6,
 'Quadratic Equations',
 'Solve quadratic equations by factorization, completing the square, and formula; identify roots',
 'Equation-solving exercises; graph plotting of quadratics',
 'Textbook Ch.5, Graph paper, Calculator'),

('WAEC', 'Mathematics', 'SSS1', 'First Term', 7,
 'Inequalities — Linear and Quadratic',
 'Solve linear and quadratic inequalities; represent solutions on number lines',
 'Inequality exercises; number line activities',
 'Textbook Ch.6, Number line charts'),

('WAEC', 'Mathematics', 'SSS1', 'First Term', 8,
 'Trigonometry — Ratios and Angles',
 'Define sine, cosine, and tangent; calculate ratios for standard angles (30, 45, 60)',
 'Trig ratio exercises; right triangle problems',
 'Textbook Ch.7, Protractors, Trig tables'),

('WAEC', 'Mathematics', 'SSS1', 'First Term', 9,
 'Statistics — Frequency Distribution',
 'Construct frequency tables; draw histograms and frequency polygons; calculate class intervals',
 'Data collection project; frequency table construction',
 'Textbook Ch.8, Graph paper, Rulers'),

('WAEC', 'Mathematics', 'SSS1', 'First Term', 10,
 'Statistics — Measures of Central Tendency',
 'Calculate mean, median, mode, and range from grouped and ungrouped data',
 'Data analysis exercises; group problem-solving',
 'Textbook Ch.9, Calculator'),

('WAEC', 'Mathematics', 'SSS1', 'First Term', 11,
 'Mensuration — Area and Volume',
 'Calculate area of triangles, circles, and composite shapes; volume of prisms and cylinders',
 'Measurement activities; formula practice exercises',
 'Textbook Ch.10, Calculators, Rulers'),

('WAEC', 'Mathematics', 'SSS1', 'First Term', 12,
 'End of Term Revision',
 'Comprehensive revision of all first term topics; practice past questions',
 'Group revision; past question practice',
 'Revision guide, Past question booklet'),

('WAEC', 'Mathematics', 'SSS1', 'First Term', 13,
 'End of Term Examination',
 'Examine all topics covered in the first term',
 'Examination',
 'Exam papers')
on conflict do nothing;

-- ── 9. Real WAEC templates — English Language SSS1 First Term ─────────────

insert into curriculum_templates (board_name, subject_name, level, term, week_number, topic, objectives, activities, resources) values
('WAEC', 'English Language', 'SSS1', 'First Term', 1,
 'Comprehension — Reading for Meaning',
 'Read and interpret passages; identify main ideas, supporting details, and author purpose',
 'Guided reading; comprehension exercises; passage analysis',
 'Textbook Ch.1, Reading passages'),

('WAEC', 'English Language', 'SSS1', 'First Term', 2,
 'Grammar — Parts of Speech Review',
 'Review and classify all eight parts of speech; identify functions in sentences',
 'Word classification exercises; sentence analysis',
 'Textbook Ch.2, Grammar worksheets'),

('WAEC', 'English Language', 'SSS1', 'First Term', 3,
 'Essay Writing — Narrative',
 'Plan and write narrative essays; use plot structure (introduction, climax, resolution)',
 'Essay planning exercises; story writing practice',
 'Textbook Ch.3, Writing guides'),

('WAEC', 'English Language', 'SSS1', 'First Term', 4,
 'Lexis and Structure — Words and Meanings',
 'Expand vocabulary through context; identify word roots, prefixes, and suffixes',
 'Word root exercises; vocabulary building games',
 'Textbook Ch.4, Dictionary'),

('WAEC', 'English Language', 'SSS1', 'First Term', 5,
 'Oral English — Vowel and Consonant Sounds',
 'Identify and produce correct vowel and consonant sounds; distinguish minimal pairs',
 'Sound drills; minimal pair exercises; pronunciation practice',
 'Textbook Ch.5, Audio clips'),

('WAEC', 'English Language', 'SSS1', 'First Term', 6,
 'Literature — African Prose',
 'Read and discuss selected African prose texts; identify themes, characters, and setting',
 'Read-aloud; group discussion; character analysis',
 'Textbook Ch.6, Selected African novel'),

('WAEC', 'English Language', 'SSS1', 'First Term', 7,
 'Middle of Term Revision and Test',
 'Revise weeks 1–6; administer mid-term test',
 'Revision exercises; test',
 'Test papers'),

('WAEC', 'English Language', 'SSS1', 'First Term', 8,
 'Comprehension — Inferential and Critical',
 'Make inferences from passages; evaluate arguments; identify bias and tone',
 'Critical reading exercises; passage evaluation',
 'Textbook Ch.7, Critical reading sheets'),

('WAEC', 'English Language', 'SSS1', 'First Term', 9,
 'Grammar — Phrases and Clauses',
 'Identify types of phrases (noun, verb, adjective) and clauses (main, subordinate)',
 'Sentence diagramming; phrase identification exercises',
 'Textbook Ch.8, Grammar worksheets'),

('WAEC', 'English Language', 'SSS1', 'First Term', 10,
 'Essay Writing — Descriptive and Expository',
 'Write descriptive essays using sensory details; structure expository essays logically',
 'Descriptive writing exercises; essay planning',
 'Textbook Ch.9, Writing guides'),

('WAEC', 'English Language', 'SSS1', 'First Term', 11,
 'Literature — Non-African Poetry',
 'Read and analyse selected non-African poems; identify literary devices (metaphor, simile, imagery)',
 'Poetry reading; literary device identification; group discussion',
 'Textbook Ch.10, Poetry anthology'),

('WAEC', 'English Language', 'SSS1', 'First Term', 12,
 'End of Term Revision',
 'Comprehensive revision of all first term topics; practice past questions',
 'Group revision; past question practice',
 'Revision guide'),

('WAEC', 'English Language', 'SSS1', 'First Term', 13,
 'End of Term Examination',
 'Examine all topics covered in the first term',
 'Examination',
 'Exam papers')
on conflict do nothing;

-- ── 10. Real WAEC templates — Biology SSS1 First Term ─────────────────────

insert into curriculum_templates (board_name, subject_name, level, term, week_number, topic, objectives, activities, resources) values
('WAEC', 'Biology', 'SSS1', 'First Term', 1,
 'Classification of Living Things',
 'Explain the basis of biological classification; use binomial nomenclature; classify organisms into kingdoms',
 'Classification exercises; use of dichotomous keys',
 'Textbook Ch.1, Dichotomous keys, Specimens'),

('WAEC', 'Biology', 'SSS1', 'First Term', 2,
 'The Cell — Structure and Function',
 'Identify cell components (nucleus, mitochondria, cell membrane); distinguish plant and animal cells',
 'Microscopy practical; cell labeling',
 'Textbook Ch.2, Microscopes, Prepared slides'),

('WAEC', 'Biology', 'SSS1', 'First Term', 3,
 'Tissues and Organs',
 'Explain levels of organisation (cell → tissue → organ → system); identify types of plant and animal tissues',
 'Tissue identification exercises; organ model building',
 'Textbook Ch.3, Tissue samples, Diagrams'),

('WAEC', 'Biology', 'SSS1', 'First Term', 4,
 'Nutrition — Types and Functions',
 'Identify classes of food and their functions; explain balanced diet; describe digestive enzymes',
 'Food analysis experiments (starch test, protein test); diet planning',
 'Textbook Ch.4, Iodine solution, Biuret reagent'),

('WAEC', 'Biology', 'SSS1', 'First Term', 5,
 'The Skeletal System',
 'Name bones of the human skeleton; describe functions of the skeleton (support, protection, movement)',
 'Bone identification exercise; joint model building',
 'Textbook Ch.5, Skeleton charts, Joint models'),

('WAEC', 'Biology', 'SSS1', 'First Term', 6,
 'Middle of Term Revision and Test',
 'Revise weeks 1–5; administer mid-term test',
 'Revision exercises; test',
 'Test papers'),

('WAEC', 'Biology', 'SSS1', 'First Term', 7,
 'Transport in Plants',
 'Explain water and mineral uptake by roots; describe transpiration and photosynthesis',
 'Transpiration experiment (potometer); leaf surface study',
 'Textbook Ch.6, Potometer, Leaf peel slides'),

('WAEC', 'Biology', 'SSS1', 'First Term', 8,
 'Transport in Humans — Blood and Circulatory System',
 'Identify components of blood; describe the human heart and blood vessels; explain blood circulation',
 'Heart model study; blood component identification',
 'Textbook Ch.7, Heart diagrams, Blood slides'),

('WAEC', 'Biology', 'SSS1', 'First Term', 9,
 'Respiration in Living Things',
 'Define respiration; distinguish aerobic and anaerobic respiration; explain gas exchange in lungs',
 'Respiration experiment (germinating seeds); lung model building',
 'Textbook Ch.8, Beakers, Germinating seeds, Balloon'),

('WAEC', 'Biology', 'SSS1', 'First Term', 10,
 'Ecosystem — Components and Energy Flow',
 'Identify biotic and abiotic factors in ecosystems; explain food chains and food webs; describe energy flow',
 'Ecosystem field study; food web construction',
 'Textbook Ch.9, Field guides, Chart paper'),

('WAEC', 'Biology', 'SSS1', 'First Term', 11,
 'Pollution and Conservation',
 'Identify types of pollution (air, water, soil); explain effects on living organisms; describe conservation methods',
 'Pollution case studies; conservation project planning',
 'Textbook Ch.10, Case study sheets'),

('WAEC', 'Biology', 'SSS1', 'First Term', 12,
 'End of Term Revision',
 'Comprehensive revision of all first term topics; practice past questions',
 'Group revision; past question practice',
 'Revision guide'),

('WAEC', 'Biology', 'SSS1', 'First Term', 13,
 'End of Term Examination',
 'Examine all topics covered in the first term',
 'Examination',
 'Exam papers')
on conflict do nothing;

-- ── 11. Add unique constraint to prevent duplicate templates ───────────────

alter table curriculum_templates
  add constraint uq_curriculum_template
  unique (board_name, subject_name, level, term, week_number);
