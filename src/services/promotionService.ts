/**
 * promotionService.ts
 * PRD Tier 8 / Problem 8.4 (Session 50) — secondary-school promotion.
 *
 * Thin client over two SECURITY DEFINER RPCs (migration_tier8_s50_promotion.sql,
 * confirmed live): preview_secondary_promotion() and apply_secondary_promotions().
 * All promotion math (averages from subject_results, cutoff comparison) and all
 * safety rails (top-down sequencing gate, atomic multi-student apply, audit
 * rows in promotion_history) live server-side on purpose — the client never
 * computes or trusts its own numbers, and can never half-apply a run.
 *
 * Rule CRUD is plain table access on promotion_rules ([STD] RLS), following
 * settingsService.ts's programme-promotion-rule precedent exactly.
 */

import { supabase } from '../lib/supabase'

type Ok<T> = { ok: true; data: T }
type Err = { ok: false; error: string }
export type Result<T> = Ok<T> | Err

function friendly(message: string): string {
  // The RPCs raise plain-English exceptions by design — pass them through
  // untouched so the UI shows exactly what the database said (§4.3).
  if (message.includes('violates row-level security')) {
    return 'You do not have permission to manage promotion rules.'
  }
  return message
}

// ─── Rules ────────────────────────────────────────────────────────────────────

export interface SecondaryPromotionRule {
  id: string
  from_class_node_id: string
  from_class_name: string
  /** null destination = graduating rule (students become alumni). */
  to_class_node_id: string | null
  to_class_name: string | null
  min_average_pct: number | null
}

export async function loadPromotionRules(schoolId: string): Promise<Result<SecondaryPromotionRule[]>> {
  try {
    const { data, error } = await supabase
      .from('promotion_rules')
      .select(`
        id, from_class_node_id, to_class_node_id, min_average_pct,
        from_node:class_nodes!public_promotion_rules_from_class_node_id_fkey ( name ),
        to_node:class_nodes!public_promotion_rules_to_class_node_id_fkey ( name )
      `)
      .eq('school_id', schoolId)
      .order('created_at')

    if (error) {
      // Embed-hint fallback: some PostgREST versions name the FK hints
      // differently — degrade to a two-step fetch rather than fail the tab.
      const { data: raw, error: rawErr } = await supabase
        .from('promotion_rules')
        .select('id, from_class_node_id, to_class_node_id, min_average_pct')
        .eq('school_id', schoolId)
        .order('created_at')
      if (rawErr) return { ok: false, error: friendly(rawErr.message) }

      const nodeIds = [...new Set(
        (raw ?? []).flatMap((r: any) => [r.from_class_node_id, r.to_class_node_id].filter(Boolean)),
      )]
      const nodes = nodeIds.length > 0
        ? await supabase.from('class_nodes').select('id, name').in('id', nodeIds)
        : { data: [], error: null }
      if (nodes.error) return { ok: false, error: friendly(nodes.error.message) }
      const names = new Map(((nodes.data ?? []) as any[]).map(n => [n.id, n.name]))

      return {
        ok: true,
        data: (raw ?? []).map((r: any) => ({
          id: r.id,
          from_class_node_id: r.from_class_node_id,
          from_class_name: names.get(r.from_class_node_id) ?? '',
          to_class_node_id: r.to_class_node_id ?? null,
          to_class_name: r.to_class_node_id ? names.get(r.to_class_node_id) ?? '' : null,
          min_average_pct: r.min_average_pct === null ? null : Number(r.min_average_pct),
        })),
      }
    }

    return {
      ok: true,
      data: (data ?? []).map((r: any) => ({
        id: r.id,
        from_class_node_id: r.from_class_node_id,
        from_class_name: r.from_node?.name ?? '',
        to_class_node_id: r.to_class_node_id ?? null,
        to_class_name: r.to_class_node_id ? r.to_node?.name ?? '' : null,
        min_average_pct: r.min_average_pct === null ? null : Number(r.min_average_pct),
      })),
    }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Failed to load promotion rules' }
  }
}

export async function savePromotionRule(schoolId: string, opts: {
  id?: string
  fromClassNodeId: string
  /** null = graduating class. */
  toClassNodeId: string | null
  /** null = promote unconditionally. */
  minAveragePct: number | null
}): Promise<Result<true>> {
  try {
    const payload = {
      from_class_node_id: opts.fromClassNodeId,
      to_class_node_id: opts.toClassNodeId,
      min_average_pct: opts.minAveragePct,
    }
    const { error } = opts.id
      ? await supabase.from('promotion_rules').update(payload).eq('id', opts.id).eq('school_id', schoolId)
      : await supabase.from('promotion_rules').insert({ school_id: schoolId, ...payload })
    if (error) return { ok: false, error: friendly(error.message) }
    return { ok: true, data: true }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Failed to save promotion rule' }
  }
}

export async function deletePromotionRule(ruleId: string): Promise<Result<true>> {
  try {
    const { error } = await supabase.from('promotion_rules').delete().eq('id', ruleId)
    if (error) return { ok: false, error: friendly(error.message) }
    return { ok: true, data: true }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Failed to delete promotion rule' }
  }
}

// ─── Preview + Apply (RPC wrappers) ──────────────────────────────────────────

export interface PromotionPreviewRow {
  student_id: string
  full_name: string
  average: number | null
  suggested: 'promote' | 'review' | 'blocked'
  reason: string
  to_class_id: string | null
  to_class_name: string | null
  graduating: boolean
}

export async function previewPromotion(params: {
  sessionId: string
  termId: string | null
  fromClassNodeId: string
}): Promise<Result<PromotionPreviewRow[]>> {
  try {
    const { data, error } = await supabase.rpc('preview_secondary_promotion', {
      p_session_id: params.sessionId,
      p_term_id: params.termId,
      p_from_class_node_id: params.fromClassNodeId,
    })
    if (error) return { ok: false, error: friendly(error.message) }
    return {
      ok: true,
      data: ((data ?? []) as any[]).map(r => ({
        student_id: r.student_id,
        full_name: r.full_name,
        average: r.average === null ? null : Number(r.average),
        suggested: r.suggested,
        reason: r.reason ?? '',
        to_class_id: r.to_class_id ?? null,
        to_class_name: r.to_class_name ?? null,
        graduating: !!r.graduating,
      })),
    }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Failed to preview promotion' }
  }
}

export interface PromotionDecision {
  student_id: string
  action: 'promote' | 'retain' | 'demote'
  mode: 'auto' | 'manual'
  to_class_node_id?: string | null
  reason?: string
}

export interface PromotionApplySummary {
  promoted: number
  retained: number
  demoted: number
  graduated: number
}

export async function applyPromotions(params: {
  sessionId: string
  fromClassNodeId: string
  decisions: PromotionDecision[]
  decidedBy: string   // staff.id (actorRecordId)
}): Promise<Result<PromotionApplySummary>> {
  try {
    const { data, error } = await supabase.rpc('apply_secondary_promotions', {
      p_session_id: params.sessionId,
      p_from_class_node_id: params.fromClassNodeId,
      p_decisions: params.decisions,
      p_decided_by: params.decidedBy,
    })
    if (error) return { ok: false, error: friendly(error.message) }
    const row = (data as any[])[0] ?? {}
    return {
      ok: true,
      data: {
        promoted: Number(row.promoted ?? 0),
        retained: Number(row.retained ?? 0),
        demoted: Number(row.demoted ?? 0),
        graduated: Number(row.graduated ?? 0),
      },
    }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Failed to apply promotions' }
  }
}
