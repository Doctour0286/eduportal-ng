/**
 * attendanceRules.ts — per-class overrides for the attendance
 * auto-deactivation rule (migration_attendance_class_rules_and_obligations.sql).
 *
 * A rule on a class node applies to that node and everything below it,
 * unless a more specific node has its own rule. No rule up the tree = the
 * school-wide setting. `exempt` wins over any thresholds on the same row.
 */
import { supabase } from '../lib/supabase'

type Ok<T> = { ok: true; data: T }
type Err = { ok: false; error: string }
type Result<T> = Ok<T> | Err

export type RuleMode = 'consecutive' | 'cumulative'

export interface ClassRule {
  class_node_id: string
  exempt: boolean
  mode: RuleMode | null
  consecutive_threshold: number | null
  cumulative_threshold: number | null
}

export interface SchoolRule {
  mode: RuleMode
  consecutive_threshold: number
  cumulative_threshold: number
}

export interface EffectiveRule {
  exempt: boolean
  mode: RuleMode
  threshold: number
  /** The class node whose rule applied, or null when the school rule did. */
  sourceClassId: string | null
}

export interface RulesContext {
  rules: Map<string, ClassRule>
  parentById: Map<string, string | null>
}

export function resolveEffectiveRule(
  classId: string | null,
  ctx: RulesContext,
  school: SchoolRule,
): EffectiveRule {
  let cur: string | null = classId
  const seen = new Set<string>()
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    const rule = ctx.rules.get(cur)
    if (rule) {
      const mode = rule.mode ?? school.mode
      const threshold = mode === 'consecutive'
        ? (rule.consecutive_threshold ?? school.consecutive_threshold)
        : (rule.cumulative_threshold ?? school.cumulative_threshold)
      return { exempt: rule.exempt, mode, threshold, sourceClassId: cur }
    }
    cur = ctx.parentById.get(cur) ?? null
  }
  const threshold = school.mode === 'consecutive'
    ? school.consecutive_threshold
    : school.cumulative_threshold
  return { exempt: false, mode: school.mode, threshold, sourceClassId: null }
}

export async function loadRulesContext(schoolId: string): Promise<Result<RulesContext>> {
  try {
    const [rulesRes, nodesRes] = await Promise.all([
      supabase
        .from('attendance_deactivation_class_rules')
        .select('class_node_id, exempt, mode, consecutive_threshold, cumulative_threshold')
        .eq('school_id', schoolId),
      supabase.from('class_nodes').select('id, parent_id').eq('school_id', schoolId),
    ])
    if (rulesRes.error) return { ok: false, error: rulesRes.error.message }
    if (nodesRes.error) return { ok: false, error: nodesRes.error.message }

    const rules = new Map<string, ClassRule>()
    for (const r of rulesRes.data ?? []) rules.set(r.class_node_id, r as ClassRule)
    const parentById = new Map<string, string | null>()
    for (const n of nodesRes.data ?? []) parentById.set(n.id, n.parent_id ?? null)
    return { ok: true, data: { rules, parentById } }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to load class rules' }
  }
}

/** Create/replace the rule on one class node. */
export async function saveClassRule(
  schoolId: string,
  rule: ClassRule,
): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from('attendance_deactivation_class_rules')
    .upsert(
      { school_id: schoolId, ...rule, updated_at: new Date().toISOString() },
      { onConflict: 'school_id,class_node_id' },
    )
  return { error: error?.message ?? null }
}

/** Remove the rule on one class node (falls back to parent / school rule). */
export async function clearClassRule(
  schoolId: string,
  classNodeId: string,
): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from('attendance_deactivation_class_rules')
    .delete()
    .eq('school_id', schoolId)
    .eq('class_node_id', classNodeId)
  return { error: error?.message ?? null }
}
