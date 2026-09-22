/**
 * Measure the availability-aware candidate tier against a REAL block.
 *
 *   npx tsx scripts/measureCandidateTier.ts <scheduleVersionId>
 *
 * READ ONLY. It loads a real GenerationContext, runs solve()+optimize() under
 * each strategy, and prints the comparison. Nothing is written — commitPlan is
 * never called.
 *
 * ── WHAT IS MEASURED, AND WHY THAT ─────────────────────────────────────────
 * Gabriel 2026-09-22: "The only true and important thing is call quota being
 * met every block, and despite having many weeks of PTO days or off days, that
 * quota needs to be met for each provider."
 *
 * So the headline number is OBLIGATION ATTAINMENT — how many providers reach
 * their stated obligation, and by how much the shortfall total misses. Not
 * fairness stdev, which is the optimizer's own objective and therefore the
 * thing it is already trying to minimise; a heuristic that improved stdev
 * while leaving somebody four calls short would be scored well by the wrong
 * ruler.
 *
 * Fairness, unfilled and burnout are printed alongside, because a tier that
 * fixed attainment by wrecking one of them would not be a win either.
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { join } from 'path';
import { loadGenerationContext } from '../src/lib/rulesEngine/genContext';
import { solve } from '../src/lib/rulesEngine/solve';
import { optimize } from '../src/lib/rulesEngine/optimize';
import { totalExpectedCalls } from '../src/lib/rulesEngine/obligation';
import { scoreSolution } from '../src/lib/rulesEngine/metrics';
import { isDateBlocked } from '../src/lib/rulesEngine/shared';
import type { CandidateTierStrategy } from '../src/lib/rulesEngine/candidateTier';
import type { GenerationContext, SolutionPlan } from '../src/lib/rulesEngine/genTypes';

function loadEnv() {
  try {
    for (const line of readFileSync(join(__dirname, '..', '.env.local'), 'utf8').split('\n')) {
      const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* already present */ }
}

const STRATEGIES: CandidateTierStrategy[] = [
  'none', 'scarcity', 'pto_distance', 'pto_distance_capped',
];

interface Outcome {
  strategy: CandidateTierStrategy;
  filled: number;
  unfilledCall: number;
  fairnessStdev: number;
  burnout: number;
  /** provider id → calls placed this block */
  placed: Map<string, number>;
  metAll: number;
  shortProviders: number;
  shortTotal: number;
}

function callsByProvider(plan: SolutionPlan): Map<string, number> {
  const out = new Map<string, number>();
  for (const a of plan.assignments) {
    if (!a.provider_id || a.shift_type_category !== 'call') continue;
    out.set(a.provider_id, (out.get(a.provider_id) ?? 0) + 1);
  }
  return out;
}

function run(ctx: GenerationContext, strategy: CandidateTierStrategy): Outcome {
  const seeded = solve(ctx, { candidateTier: strategy });
  // The optimizer re-solves internally; it reads the same ctx, so the tier
  // rides into every trial too.
  const opt = optimize(ctx, { candidateTier: strategy });
  const plan = opt?.plan ?? seeded;
  const metrics = scoreSolution(plan, ctx);
  const placed = callsByProvider(plan);
  const obligations = totalExpectedCalls(ctx);

  let metAll = 0, shortProviders = 0, shortTotal = 0;
  for (const p of ctx.providers) {
    if (!(p.fte_value > 0)) continue;
    const owed = Math.round(obligations.get(p.id) ?? 0);
    const got = placed.get(p.id) ?? 0;
    if (got >= owed) metAll++;
    else { shortProviders++; shortTotal += owed - got; }
  }

  return {
    strategy,
    filled: plan.assignments.filter(a => a.provider_id).length,
    unfilledCall: plan.unfilled.filter(u => u.shift_type_category === 'call').length,
    fairnessStdev: metrics.fairnessStdev,
    burnout: metrics.burnout,
    placed, metAll, shortProviders, shortTotal,
  };
}

async function main() {
  loadEnv();
  const versionId = process.argv[2];
  if (!versionId) {
    console.error('Usage: npx tsx scripts/measureCandidateTier.ts <scheduleVersionId>');
    process.exit(1);
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error('Supabase env vars missing.'); process.exit(1); }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb: any = createClient(url, key, {
    db: { schema: 'scheduling' }, auth: { persistSession: false },
  });

  const loaded = await loadGenerationContext(sb, versionId);
  const ctx = loaded.ctx;
  if (!ctx) { console.error('Context failed to load:', loaded.error); process.exit(1); }

  const dates = ctx.scheduleDates ?? [];
  console.log(`\nBLOCK  ${dates[0]} → ${dates[dates.length - 1]}  (${dates.length} dates)`);
  console.log(`call slots to fill : ${ctx.slotsToFill.filter(s => s.shift_type_category === 'call').length}`);
  console.log(`pool               : ${ctx.providers.length}   par ${ctx.parLevel}`);
  for (const w of ctx.warnings ?? []) console.log(`  ! ${w}`);

  // Leave exposure, so the result can be read against who is actually away.
  console.log('\nLEAVE EXPOSURE (blocked dates in the block, bookend applied)');
  const obligations = totalExpectedCalls(ctx);
  const blocked = new Map<string, number>();
  for (const p of ctx.providers) {
    const entries = ctx.availByPid.get(p.id) ?? [];
    blocked.set(p.id, dates.filter(d => isDateBlocked(entries, d, { bookend: true })).length);
  }
  const byBlocked = [...ctx.providers].sort((a, b) => (blocked.get(b.id)! - blocked.get(a.id)!));
  for (const p of byBlocked) {
    const n = blocked.get(p.id)!;
    if (n === 0 && p.fte_value > 0) continue;
    console.log(`  ${(p.short_display_name || p.id.slice(0, 8)).padEnd(14)} fte ${String(p.fte_value).padEnd(5)}`
      + ` away ${String(n).padStart(3)}/${dates.length}  owes ${Math.round(obligations.get(p.id) ?? 0)}`);
  }

  const outcomes: Outcome[] = [];
  for (const s of STRATEGIES) {
    process.stdout.write(`\nrunning ${s} … `);
    const t0 = Date.now();
    outcomes.push(run(ctx, s));
    process.stdout.write(`${Date.now() - t0}ms`);
  }

  console.log('\n\nRESULT  (headline = obligation attainment)');
  console.log(`  ${'strategy'.padEnd(21)}${'met'.padStart(5)}${'short'.padStart(7)}`
    + `${'calls short'.padStart(13)}${'unfilled'.padStart(10)}${'stdev'.padStart(9)}${'burnout'.padStart(9)}`);
  for (const o of outcomes) {
    console.log(`  ${o.strategy.padEnd(21)}${String(o.metAll).padStart(5)}`
      + `${String(o.shortProviders).padStart(7)}${String(o.shortTotal).padStart(13)}`
      + `${String(o.unfilledCall).padStart(10)}`
      + `${o.fairnessStdev.toFixed(3).padStart(9)}${o.burnout.toFixed(2).padStart(9)}`);
  }

  console.log('\nPER PROVIDER — calls placed vs owed');
  const head = `  ${'provider'.padEnd(14)}${'fte'.padStart(5)}${'away'.padStart(6)}${'owes'.padStart(6)}`
    + STRATEGIES.map(s => s.slice(0, 9).padStart(11)).join('');
  console.log(head);
  for (const p of byBlocked) {
    if (!(p.fte_value > 0)) continue;
    const owed = Math.round(obligations.get(p.id) ?? 0);
    const cells = outcomes.map(o => {
      const got = o.placed.get(p.id) ?? 0;
      return `${got}${got < owed ? ` (-${owed - got})` : '     '}`.padStart(11);
    }).join('');
    console.log(`  ${(p.short_display_name || p.id.slice(0, 8)).padEnd(14)}${String(p.fte_value).padStart(5)}`
      + `${String(blocked.get(p.id)).padStart(6)}${String(owed).padStart(6)}${cells}`);
  }
  console.log('');
}

main().catch(e => { console.error(e); process.exit(1); });
