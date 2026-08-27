-- ============================================================================
-- migration_tier8_s50_promotion.sql
-- PRD Tier 8 / Problem 8.4 (Session 50) — secondary-school promotion flow.
--
-- Run order: FOURTH/final of the four Tier 8 migrations (after s49).
-- Idempotent: safe to re-run.
--
-- What this does:
--   1. Extends promotion_history.decision to the Problem 8.4 vocabulary
--      ('auto_promoted'|'manually_promoted'|'manually_retained'|'demoted')
--      while KEEPING the Phase-2 values valid ('promoted','repeated',
--      'manual_override') so existing rows stay readable.
--   2. Makes promotion_rules.to_class_node_id nullable — NULL destination
--      means "graduate" (student.status → 'alumni'). This is how final-year
--      classes (SS3) promote out of the system.
--   3. Two SECURITY DEFINER RPCs (the same atomic-RPC precedent as
--      admit_student()/run_programme_promotion()):
--        preview_secondary_promotion(...)  — per-student averages + suggested
--                                            decisions, computed SERVER-SIDE
--                                            from subject_results (approved
--                                            scores only), never trusted from
--                                            the client.
--        apply_secondary_promotions(...)   — validates the top-down sequencing
--                                            gate, then applies every decision
--                                            and writes promotion_history rows
--                                            in ONE transaction. A crash can
--                                            never leave a half-promoted class.
--
-- Sequencing gate (owner-specified, Problem 8.4): a destination class must be
-- CLEARED before anyone can promote INTO it — every ACTIVE student still
-- sitting in the destination class must already have a promotion_history row
-- recorded this session FROM that class (promoted onward, retained, or
-- graduated). A retained student therefore doesn't wedge the gate forever,
-- but an untouched class below always blocks the classes above it.
-- ============================================================================

-- ── 1. decision vocabulary ──────────────────────────────────────────────────

do $$
declare
  v_con text;
begin
  select conname into v_con
  from pg_constraint
  where conrelid = 'promotion_history'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%decision%';
  if v_con is not null then
    execute format('alter table promotion_history drop constraint %I', v_con);
  end if;
end $$;

alter table promotion_history drop constraint if exists promotion_history_decision_check;
alter table promotion_history add constraint promotion_history_decision_check
  check (decision in (
    'promoted','repeated','manual_override',            -- Phase-2 legacy values, still valid
    'auto_promoted','manually_promoted',
    'manually_retained','demoted'                       -- Problem 8.4 vocabulary
  ));

-- ── 2. graduation = NULL destination ────────────────────────────────────────

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'promotion_rules'
      and column_name = 'to_class_node_id'
      and is_nullable = 'NO'
  ) then
    alter table promotion_rules alter column to_class_node_id drop not null;
  end if;
end $$;

-- ── 3. Preview RPC ──────────────────────────────────────────────────────────

create or replace function preview_secondary_promotion(
  p_session_id         uuid,
  p_term_id            uuid,          -- null = whole-session school (uses_terms=false)
  p_from_class_node_id uuid
)
returns table (
  student_id   uuid,
  full_name    text,
  average      numeric,
  suggested    text,     -- 'promote' | 'review' | 'blocked'
  reason       text,
  to_class_id  uuid,
  to_class_name text,
  graduating   boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rule record;
  v_to_class_name text;
begin
  select * into v_rule
  from promotion_rules
  where from_class_node_id = p_from_class_node_id
  order by created_at desc
  limit 1;

  if v_rule.to_class_node_id is not null then
    select name into v_to_class_name from class_nodes where id = v_rule.to_class_node_id;
  end if;

  return query
  with students_in_class as (
    select s.id, s.full_name
    from students s
    where s.class_node_id = p_from_class_node_id
      and s.status = 'active'
  ),
  avgs as (
    select sr.student_id, avg(sr.weighted_total) as avg_total
    from subject_results sr
    where sr.session_id = p_session_id
      and ((p_term_id is null and sr.term_id is null) or sr.term_id = p_term_id)
      and sr.student_id in (select id from students_in_class)
    group by sr.student_id
  )
  select
    sic.id,
    sic.full_name,
    round(av.avg_total, 2),
    case
      when v_rule.id is null                                 then 'blocked'
      when av.avg_total is null                              then 'review'
      when v_rule.min_average_pct is null                    then 'promote'
      when av.avg_total >= v_rule.min_average_pct            then 'promote'
      else 'review'
    end,
    case
      when v_rule.id is null                      then 'No promotion rule is configured for this class yet.'
      when av.avg_total is null                   then 'No approved results yet — needs manual review.'
      when v_rule.min_average_pct is null         then 'Rule promotes unconditionally.'
      when av.avg_total >= v_rule.min_average_pct then 'Meets the ' || v_rule.min_average_pct || '% cutoff.'
      else 'Below the ' || v_rule.min_average_pct || '% cutoff — needs manual review.'
    end,
    v_rule.to_class_node_id,
    v_to_class_name,
    (v_rule.id is not null and v_rule.to_class_node_id is null)
  from students_in_class sic
  left join avgs av on av.student_id = sic.id
  order by sic.full_name;
end;
$$;

-- ── 4. Apply RPC ────────────────────────────────────────────────────────────

create or replace function apply_secondary_promotions(
  p_session_id         uuid,
  p_from_class_node_id uuid,
  p_decisions          jsonb,   -- [{student_id, action:'promote'|'retain'|'demote', mode:'auto'|'manual', to_class_node_id?:uuid}]
  p_decided_by         uuid     -- staff.id of the acting admin (actorRecordId)
)
returns table (promoted int, retained int, demoted int, graduated int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_school_id uuid;
  v_rule      record;
  v_dest      uuid;
  v_item      jsonb;
  v_action    text;
  v_mode      text;
  v_student   record;
  v_promoted  int  := 0;
  v_retained  int  := 0;
  v_demoted   int  := 0;
  v_graduated int  := 0;
begin
  -- Permission gate (RLS is bypassed under security definer, so the check
  -- lives here — same discipline as run_programme_promotion()).
  select school_id into v_school_id from class_nodes where id = p_from_class_node_id;

  if not (current_is_admin() or current_has_permission('academics.promotion.run')) then
    raise exception 'You do not have permission to run promotions.';
  end if;

  if v_school_id is null then
    raise exception 'Class not found.';
  end if;

  select * into v_rule
  from promotion_rules
  where from_class_node_id = p_from_class_node_id
  order by created_at desc
  limit 1;

  -- ── Sequencing gate: every destination must be cleared first. ────────────
  for v_dest in
    select distinct coalesce((d->>'to_class_node_id')::uuid, v_rule.to_class_node_id)
    from jsonb_array_elements(p_decisions) d
    where (d->>'action') = 'promote'
      and coalesce((d->>'to_class_node_id')::uuid, v_rule.to_class_node_id) is not null
  loop
    if v_dest = p_from_class_node_id then
      raise exception 'A class cannot promote into itself.';
    end if;

    if exists (
      select 1
      from students s
      where s.class_node_id = v_dest
        and s.status = 'active'
        and s.school_id = v_school_id
        and not exists (
          select 1 from promotion_history ph
          where ph.student_id = s.id
            and ph.session_id = p_session_id
            and ph.from_class_node_id = v_dest
        )
    ) then
      perform announce_blocked_class(v_dest);
    end if;
  end loop;

  -- ── Apply decisions ───────────────────────────────────────────────────────
  for v_item in select * from jsonb_array_elements(p_decisions) loop
    v_action := v_item->>'action';
    v_mode   := coalesce(v_item->>'mode', 'manual');

    select * into v_student
    from students
    where id = (v_item->>'student_id')::uuid
      and school_id = v_school_id
      and class_node_id = p_from_class_node_id
      and status = 'active';

    if v_student.id is null then
      raise exception 'Student % is not an active member of this class — data changed mid-run. Nothing was saved.', v_item->>'student_id';
    end if;

    if v_action = 'promote' then
      v_dest := coalesce((v_item->>'to_class_node_id')::uuid, v_rule.to_class_node_id);

      if v_dest is null then
        -- Graduation is ONLY valid when a real rule exists whose destination
        -- was deliberately left NULL (SS3 → alumni). A missing rule must
        -- block loudly — never silently graduate anyone by accident.
        if v_rule.id is null then
          raise exception 'No promotion rule is configured for this class yet. Set one up in Settings > Promotion first.';
        end if;
        -- Graduation: NULL destination rule → alumni status.
        update students set status = 'alumni' where id = v_student.id;
        insert into promotion_history (school_id, student_id, session_id, from_class_node_id, to_class_node_id, decision, decided_by, reason)
        values (v_school_id, v_student.id, p_session_id, p_from_class_node_id, null,
                case when v_mode = 'auto' then 'auto_promoted' else 'manually_promoted' end,
                p_decided_by, 'Graduated (final class)');
        v_graduated := v_graduated + 1;
        v_promoted  := v_promoted + 1;
      else
        update students set class_node_id = v_dest where id = v_student.id;
        insert into promotion_history (school_id, student_id, session_id, from_class_node_id, to_class_node_id, decision, decided_by, reason)
        values (v_school_id, v_student.id, p_session_id, p_from_class_node_id, v_dest,
                case when v_mode = 'auto' then 'auto_promoted' else 'manually_promoted' end,
                p_decided_by, null);
        v_promoted := v_promoted + 1;
      end if;

    elsif v_action = 'retain' then
      insert into promotion_history (school_id, student_id, session_id, from_class_node_id, to_class_node_id, decision, decided_by, reason)
      values (v_school_id, v_student.id, p_session_id, p_from_class_node_id, null,
              'manually_retained', p_decided_by, v_item->>'reason');
      v_retained := v_retained + 1;

    elsif v_action = 'demote' then
      v_dest := (v_item->>'to_class_node_id')::uuid;
      if v_dest is null then
        raise exception 'A demotion needs an explicit destination class.';
      end if;
      update students set class_node_id = v_dest where id = v_student.id;
      insert into promotion_history (school_id, student_id, session_id, from_class_node_id, to_class_node_id, decision, decided_by, reason)
      values (v_school_id, v_student.id, p_session_id, p_from_class_node_id, v_dest,
              'demoted', p_decided_by, v_item->>'reason');
      v_demoted := v_demoted + 1;

    else
      raise exception 'Unknown action "%" in decisions payload.', v_action;
    end if;
  end loop;

  return query select v_promoted, v_retained, v_demoted, v_graduated;
end;
$$;

-- Helper: raises a plain-English block naming the offending class (called via
-- PERFORM so the message reads as one clear sentence, §4.3).
create or replace function announce_blocked_class(p_dest uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
begin
  select name into v_name from class_nodes where id = p_dest;
  raise exception 'Promotion blocked: % still has students who haven''t been promoted out yet. Promote (or decide on) the destination class first — senior classes before junior.', coalesce(v_name, 'The destination class');
end;
$$;
