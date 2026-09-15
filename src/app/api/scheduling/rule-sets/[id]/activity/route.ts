import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { readAllRows } from '@/lib/pagedRead';

// Never prerender — this route walks every assignment at the rule set's site
// and aggregates validation_flags counts. Always per-request.
export const dynamic = 'force-dynamic';

interface ValidationFlag {
  rule_id: string | null;
  rule_name: string;
  category: string;
  // 'warning' = sentinel flags (e.g. 'validation unavailable — needs
  // re-validation'). Counted separately — never as soft violations.
  severity: 'hard' | 'soft' | 'warning';
  message: string;
}

interface PerRuleActivity {
  rule_id: string | null;
  rule_name: string;
  hard_count: number;
  soft_count: number;
  warning_count: number;
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
  warning_count: number;
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
  //
  // PAGED. This is the whole site across every version, not one block, so it is
  // the read most likely to cross PostgREST's silent 1000-row cap (the table
  // held 1,225 rows site-wide as of 2026-09-15). A short read here truncates the
  // slot set every later number is measured against, so the panel would show a
  // smaller "fired N times" with nothing to say it was short — the stats would
  // look plausible and be wrong. readAllRows returns no rows alongside an error,
  // so a failure surfaces as a 500 rather than a confident undercount.
  const slotsRead = await readAllRows<{ id: string }>(
    (from, to) => sb
      .from('schedule_slots')
      .select('id', { count: 'exact' })
      .eq('site_id', ruleSet.site_id)
      .order('id')
      .range(from, to),
    'Failed to load slots',
  );
  if (slotsRead.error) {
    return NextResponse.json({ error: slotsRead.error }, { status: 500 });
  }
  const slotIds = slotsRead.rows.map(s => s.id);

  if (slotIds.length === 0) {
    const empty: ActivityResponse = {
      rule_set_id: id,
      site_id: ruleSet.site_id,
      assignments_checked: 0,
      assignments_with_violations: 0,
      total_violations: 0,
      hard_count: 0,
      soft_count: 0,
      warning_count: 0,
      per_rule: [],
    };
    return NextResponse.json(empty);
  }

  // 3. Walk assignments at this site, pulling validation_flags. Two separate
  // limits apply and only one of them is the IN clause: slot ids are batched so
  // the request URL stays sane, and EACH batch is then paged, because a batch of
  // 1000 slots routinely carries more than 1000 assignments and an un-ranged
  // select would silently return only the first 1000 of them. Counting that
  // array is what made `assignments_checked` and `total_violations` report the
  // cap as if it were the truth.
  let assignmentsChecked = 0;
  let assignmentsWithViolations = 0;
  let totalViolations = 0;
  let hardCount = 0;
  let softCount = 0;
  let warningCount = 0;
  const perRule = new Map<string, PerRuleActivity>();

  const CHUNK = 1000;
  for (let i = 0; i < slotIds.length; i += CHUNK) {
    const batch = slotIds.slice(i, i + CHUNK);
    const assignmentsRead = await readAllRows<{ validation_flags: ValidationFlag[] }>(
      (from, to) => sb
        .from('assignments')
        .select('validation_flags', { count: 'exact' })
        .in('schedule_slot_id', batch)
        .not('validation_flags', 'is', null)
        .order('id')
        .range(from, to),
      'Failed to load assignments',
    );
    if (assignmentsRead.error) {
      return NextResponse.json({ error: assignmentsRead.error }, { status: 500 });
    }
    for (const row of assignmentsRead.rows) {
      assignmentsChecked++;
      const flags = row.validation_flags || [];
      if (flags.length > 0) assignmentsWithViolations++;
      for (const f of flags) {
        totalViolations++;
        // Anything that isn't explicitly hard/soft (sentinel 'warning' flags,
        // unknown severities) counts as a warning — never inflates soft.
        if (f.severity === 'hard') hardCount++;
        else if (f.severity === 'soft') softCount++;
        else warningCount++;
        const key = (f.rule_id ?? f.rule_name);
        const ex = perRule.get(key);
        if (ex) {
          if (f.severity === 'hard') ex.hard_count++;
          else if (f.severity === 'soft') ex.soft_count++;
          else ex.warning_count++;
          ex.total++;
        } else {
          perRule.set(key, {
            rule_id: f.rule_id,
            rule_name: f.rule_name,
            hard_count: f.severity === 'hard' ? 1 : 0,
            soft_count: f.severity === 'soft' ? 1 : 0,
            warning_count: f.severity !== 'hard' && f.severity !== 'soft' ? 1 : 0,
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
    warning_count: warningCount,
    per_rule: [...perRule.values()].sort((a, b) => b.total - a.total),
  };
  return NextResponse.json(response);
}
