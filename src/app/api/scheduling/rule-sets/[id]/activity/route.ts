import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';

// Never prerender — this route walks every assignment at the rule set's site
// and aggregates validation_flags counts. Always per-request.
export const dynamic = 'force-dynamic';

interface ValidationFlag {
  rule_id: string | null;
  rule_name: string;
  category: string;
  severity: 'hard' | 'soft';
  message: string;
}

interface PerRuleActivity {
  rule_id: string | null;
  rule_name: string;
  hard_count: number;
  soft_count: number;
  total: number;
}

interface ActivityResponse {
  rule_set_id: string;
  site_id: string;
  assignments_checked: number;
  assignments_with_violations: number;
  total_violations: number;
  hard_count: number;
  soft_count: number;
  per_rule: PerRuleActivity[];
}

/**
 * GET /api/scheduling/rule-sets/[id]/activity
 *
 * Aggregates `assignments.validation_flags` across every assignment whose
 * schedule_slot belongs to the rule set's site, so the rules UI can show
 * "this rule fired N times" next to each rule definition. Validation_flags
 * is the source of truth — it's what the post-generate step in
 * autoGenerate.ts writes per assignment.
 *
 * "Checked" means the validation_flags column is non-null (the post-generate
 * step wrote to it, even if the array ended up empty). An assignment with a
 * NULL validation_flags column hasn't been validated since this feature was
 * turned on, so it doesn't count toward the totals — generate the schedule
 * again to populate.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const sb = sbSchedulingServer();
  const { id } = params;

  // 1. Look up the rule set so we know which site to scope to.
  const { data: ruleSet, error: rsErr } = await sb
    .from('rule_sets')
    .select('id, site_id')
    .eq('id', id)
    .single();
  if (rsErr || !ruleSet) {
    return NextResponse.json({ error: rsErr?.message || 'Rule set not found' }, { status: 404 });
  }

  // 2. Get every schedule_slot id at this site so we can scope the assignments query.
  // We do this in a separate query (rather than a join) because Supabase's
  // PostgREST schema layer doesn't always pick up cross-table FKs cleanly when
  // pulling jsonb columns.
  const { data: slots, error: slotErr } = await sb
    .from('schedule_slots')
    .select('id')
    .eq('site_id', ruleSet.site_id);
  if (slotErr) {
    return NextResponse.json({ error: slotErr.message }, { status: 500 });
  }
  const slotIds = (slots || []).map((s: { id: string }) => s.id);

  if (slotIds.length === 0) {
    const empty: ActivityResponse = {
      rule_set_id: id,
      site_id: ruleSet.site_id,
      assignments_checked: 0,
      assignments_with_violations: 0,
      total_violations: 0,
      hard_count: 0,
      soft_count: 0,
      per_rule: [],
    };
    return NextResponse.json(empty);
  }

  // 3. Walk assignments at this site, pulling validation_flags. Page in chunks
  // of 1000 to stay under PostgREST's IN clause and row caps.
  let assignmentsChecked = 0;
  let assignmentsWithViolations = 0;
  let totalViolations = 0;
  let hardCount = 0;
  let softCount = 0;
  const perRule = new Map<string, PerRuleActivity>();

  const CHUNK = 1000;
  for (let i = 0; i < slotIds.length; i += CHUNK) {
    const batch = slotIds.slice(i, i + CHUNK);
    const { data: assignments, error: aErr } = await sb
      .from('assignments')
      .select('validation_flags')
      .in('schedule_slot_id', batch)
      .not('validation_flags', 'is', null);
    if (aErr) {
      return NextResponse.json({ error: aErr.message }, { status: 500 });
    }
    for (const row of (assignments || []) as { validation_flags: ValidationFlag[] }[]) {
      assignmentsChecked++;
      const flags = row.validation_flags || [];
      if (flags.length > 0) assignmentsWithViolations++;
      for (const f of flags) {
        totalViolations++;
        if (f.severity === 'hard') hardCount++;
        else softCount++;
        const key = (f.rule_id ?? f.rule_name);
        const ex = perRule.get(key);
        if (ex) {
          if (f.severity === 'hard') ex.hard_count++;
          else ex.soft_count++;
          ex.total++;
        } else {
          perRule.set(key, {
            rule_id: f.rule_id,
            rule_name: f.rule_name,
            hard_count: f.severity === 'hard' ? 1 : 0,
            soft_count: f.severity === 'soft' ? 1 : 0,
            total: 1,
          });
        }
      }
    }
  }

  const response: ActivityResponse = {
    rule_set_id: id,
    site_id: ruleSet.site_id,
    assignments_checked: assignmentsChecked,
    assignments_with_violations: assignmentsWithViolations,
    total_violations: totalViolations,
    hard_count: hardCount,
    soft_count: softCount,
    per_rule: [...perRule.values()].sort((a, b) => b.total - a.total),
  };
  return NextResponse.json(response);
}
