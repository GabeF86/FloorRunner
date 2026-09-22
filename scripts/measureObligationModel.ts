/**
 * How many providers meet their call quota, under each obligation model?
 *
 *   npx tsx scripts/measureObligationModel.ts <scheduleVersionId>
 *
 * READ ONLY — commitPlan is never called.
 *
 * ── THE QUESTION ──────────────────────────────────────────────────────────
 * Gabriel 2026-09-22: "the obligation should change based on the block length,
 * the par level does not. So if the par is 11, then the total amount of each
 * call in that set block, however many weeks it is, gets divided by 11 and
 * that's the obligation for each provider."
 *
 * Today the engine does NOT do that at Paoli. The pattern states fixed
 * obligation BANDS (a 1.0 FTE owes 16), and statedTotalFor returns the band
 * sum regardless of how long the block is. The formula Gabriel describes is
 * already in the code as the FALLBACK — `blockTotal / par × fte` — used at
 * every site whose pattern states no bands.
 *
 * ── WHAT THIS VARIES ──────────────────────────────────────────────────────
 * Each arm re-solves the whole block, because par does not only set the
 * obligation: it is also the denominator of the fairness bucket targets that
 * steer the greedy loop. Measuring the same plan against different obligation
 * definitions would answer a narrower question than the one being asked.
 *
 *   bands    @ par 11     the live configuration
 *   formula  @ par 11     Gabriel's rule at the stored par
 *   formula  @ par 12.6   the same rule with par set to the pool's FTE
 *   formula  @ par 15     par as head count (the flat reading)
 *
 * ── WHY PAR IS THE HINGE ──────────────────────────────────────────────────
 * Σ obligation = blockTotal × (Σ fte) / par. So the obligations sum to the
 * block exactly when par equals the pool's summed FTE; below that they
 * over-subscribe and somebody must come up short by arithmetic, whatever the
 * solver does.
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { join } from 'path';
import { loadGenerationContext } from '../src/lib/rulesEngine/genContext';
import { solve } from '../src/lib/rulesEngine/solve';
import { optimize } from '../src/lib/rulesEngine/optimize';
import { scoreSolution } from '../src/lib/rulesEngine/metrics';
import type { GenerationContext, SolutionPlan } from '../src/lib/rulesEngine/genTypes';

function loadEnv() {
  try {
    for (const line of readFileSync(join(__dirname, '..', '.env.local'), 'utf8').split('\n')) {
      const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* already present */ }
}

interface Arm {
  label: string;
  par: number;
  /** Strip the pattern's obligation bands so the formula fallback is used. */
  dropBands: boolean;
}

const ARMS: Arm[] = [
  { label: 'bands   @ par 11', par: 11, dropBands: false },
  { label: 'formula @ par 11', par: 11, dropBands: true },
  { label: 'formula @ par 12.6', par: 12.6, dropBands: true },
  { label: 'formula @ par 15', par: 15, dropBands: true },
];

function callsBy(plan: SolutionPlan): Map<string, number> {
  const out = new Map<string, number>();
  for (const a of plan.assignments) {
    if (!a.provider_id || a.shift_type_category !== 'call') continue;
    out.set(a.provider_id, (out.get(a.provider_id) ?? 0) + 1);
  }
  return out;
}

async function main() {
  loadEnv();
  const versionId = process.argv[2];
  if (!versionId) {
    console.error('Usage: npx tsx scripts/measureObligationModel.ts <scheduleVersionId>');
    process.exit(1);
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error('Supabase env vars missing.'); process.exit(1); }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb: any = createClient(url, key, {
    db: { schema: 'scheduling' }, auth: { persistSession: false },
  });

  const { ctx: base } = await loadGenerationContext(sb, versionId);
  if (!base) { console.error('Context failed to load.'); process.exit(1); }

  const inventory =
    base.slotsToFill.filter(s => s.shift_type_category === 'call')
      .reduce((n, s) => n + (s.required_count || 1), 0)
    + base.seedAssignments.filter(s => s.shift_type_category === 'call').length;
  const poolFte = base.providers.reduce((n, p) => n + p.fte_value, 0);

  console.log(`\nINVENTORY ${inventory} call slots · pool ${base.providers.length} providers `
    + `/ ${poolFte.toFixed(2)} FTE · stored par ${base.parLevel}`);
  console.log('Σ obligation = blockTotal × Σfte / par — closes exactly when par = Σfte\n');

  console.log(`  ${'arm'.padEnd(20)}${'Σ owed'.padStart(8)}${'vs inv'.padStart(9)}`
    + `${'met'.padStart(6)}${'short'.padStart(7)}${'calls short'.padStart(13)}${'unfilled'.padStart(10)}`);

  for (const arm of ARMS) {
    // A shallow clone per arm. The pattern is re-created without its
    // obligations key so statedTotalFor falls through to the formula.
    const doc = base.callPattern
      ? { ...base.callPattern, ...(arm.dropBands ? { obligations: undefined } : {}) }
      : base.callPattern;
    const ctx = { ...base, parLevel: arm.par, callPattern: doc } as GenerationContext;

    // Obligations under THIS arm, computed the same way the engine would.
    const owedBy = new Map<string, number>();
    for (const p of ctx.providers) {
      owedBy.set(p.id, Math.round((inventory / arm.par) * p.fte_value));
    }
    if (!arm.dropBands) {
      // Band arm: use the engine's own stated-band answer.
      const { totalExpectedCalls } = await import('../src/lib/rulesEngine/obligation');
      for (const [pid, v] of totalExpectedCalls(ctx)) owedBy.set(pid, Math.round(v));
    }
    const owedTotal = [...owedBy.values()].reduce((a, b) => a + b, 0);

    solve(ctx, {});
    const { plan } = optimize(ctx, {});
    const got = callsBy(plan);

    let met = 0, short = 0, shortTotal = 0;
    for (const p of ctx.providers) {
      if (!(p.fte_value > 0)) continue;
      const owed = owedBy.get(p.id) ?? 0;
      const n = got.get(p.id) ?? 0;
      if (n >= owed) met++; else { short++; shortTotal += owed - n; }
    }
    const unfilled = plan.unfilled.filter(u => u.shift_type_category === 'call').length;
    const delta = owedTotal - inventory;

    console.log(`  ${arm.label.padEnd(20)}${String(owedTotal).padStart(8)}`
      + `${(delta > 0 ? `+${delta}` : String(delta)).padStart(9)}`
      + `${String(met).padStart(6)}${String(short).padStart(7)}`
      + `${String(shortTotal).padStart(13)}${String(unfilled).padStart(10)}`);
  }
  console.log('');
}

main().catch(e => { console.error(e); process.exit(1); });
