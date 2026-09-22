/**
 * Engine vs CP-SAT, on the same block, same rules.
 *
 *   npx tsx scripts/exportCpsatModel.ts  <versionId> model.json
 *   python3 scripts/cpsat/model.py       model.json --mode all
 *   python3 scripts/cpsat/model.py       model.json --mode obligatory
 *   npx tsx scripts/compareCpsat.ts      <versionId> model.json
 *
 * READ ONLY.
 *
 * Runs the real engine (solve + optimize) in both fill modes, reads the
 * solver's proven-optimal solutions, and prints the gap.
 *
 * WHY THE COMPARISON IS FAIR
 * The solver's variable domain IS the engine's eligibility verdict — see
 * exportCpsatModel. Neither side can place anyone the other could not. The
 * only difference is the order decisions get made in: the engine commits one
 * slot at a time and never reconsiders, the solver considers all of them at
 * once. That is precisely the quantity being measured.
 *
 * WHAT THE GAP DOES **NOT** INCLUDE
 * Everything the engine does that is not optimisation: chains it constructs
 * rather than constrains, seeds it refuses to overwrite, targeted and scoped
 * runs, stale-seed eviction, request tiers, and the per-slot per-candidate
 * rejection report a chief reads when a slot will not fill. A solver that
 * matched the numbers would still have to grow all of that.
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { join } from 'path';
import { loadGenerationContext } from '../src/lib/rulesEngine/genContext';
import { solve } from '../src/lib/rulesEngine/solve';
import { optimize } from '../src/lib/rulesEngine/optimize';
import { totalExpectedCalls } from '../src/lib/rulesEngine/obligation';
import type { SolutionPlan, FillMode } from '../src/lib/rulesEngine/genTypes';

function loadEnv() {
  try {
    for (const line of readFileSync(join(__dirname, '..', '.env.local'), 'utf8').split('\n')) {
      const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* already present */ }
}

const stdevOf = (calls: Map<string, number>, fte: Map<string, number>): number => {
  const ratios = [...calls.keys()].map(p => calls.get(p)! / fte.get(p)!);
  if (ratios.length === 0) return 0;
  const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  return Math.sqrt(ratios.reduce((a, r) => a + (r - mean) ** 2, 0) / ratios.length);
};

function callsOf(plan: SolutionPlan, ids: string[]): Map<string, number> {
  const out = new Map(ids.map(id => [id, 0]));
  for (const a of plan.assignments) {
    if (!a.provider_id || a.shift_type_category !== 'call') continue;
    if (out.has(a.provider_id)) out.set(a.provider_id, out.get(a.provider_id)! + 1);
  }
  return out;
}

async function main() {
  loadEnv();
  const [versionId, modelPath] = process.argv.slice(2);
  if (!versionId || !modelPath) {
    console.error('Usage: npx tsx scripts/compareCpsat.ts <versionId> <model.json>');
    process.exit(1);
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error('Supabase env vars missing.'); process.exit(1); }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb: any = createClient(url, key, {
    db: { schema: 'scheduling' }, auth: { persistSession: false },
  });

  const { ctx } = await loadGenerationContext(sb, versionId);
  if (!ctx) { console.error('Context failed to load.'); process.exit(1); }

  const model = JSON.parse(readFileSync(modelPath, 'utf8'));
  const ids: string[] = model.providers.map((p: { id: string }) => p.id);
  const fte = new Map<string, number>(model.providers.map((p: { id: string; fte: number }) => [p.id, p.fte]));
  const name = new Map<string, string>(model.providers.map((p: { id: string; name: string }) => [p.id, p.name]));
  const obligation = new Map<string, number>(
    [...totalExpectedCalls(ctx)].map(([k, v]) => [k, Math.round(v)]));
  const callSlots = model.stats.callSlots as number;

  console.log(`\n  BLOCK ${model.meta.from} → ${model.meta.to}`
    + `   ${callSlots} call slots · ${ids.length} providers · par ${model.meta.parLevel}\n`);

  const rows: Array<{ mode: string; who: string; filled: number; stdev: number; ms: number; proved: string }> = [];
  const perProvider = new Map<string, Record<string, number>>();

  for (const mode of ['all', 'obligatory'] as FillMode[]) {
    // ── the engine ──────────────────────────────────────────────────────
    const t0 = Date.now();
    solve(ctx, { fillMode: mode });
    const { plan } = optimize(ctx, { fillMode: mode });
    const engMs = Date.now() - t0;
    const engCalls = callsOf(plan, ids);
    rows.push({
      mode, who: 'engine (greedy + hill-climb)',
      filled: [...engCalls.values()].reduce((a, b) => a + b, 0),
      stdev: stdevOf(engCalls, fte), ms: engMs, proved: 'no bound',
    });

    // ── the solver ──────────────────────────────────────────────────────
    const solPath = modelPath.replace(/\.json$/, '') + `.solution.${mode}.json`;
    let sol: Record<string, unknown> | null = null;
    try { sol = JSON.parse(readFileSync(solPath, 'utf8')); } catch { /* not run */ }
    if (sol) {
      const solCalls = new Map(Object.entries(sol.calls as Record<string, number>));
      rows.push({
        mode, who: 'CP-SAT (proved optimal)',
        filled: sol.filled as number,
        stdev: sol.stdev as number,
        ms: Math.round(((sol.modelStats as { wallSeconds: number }).wallSeconds) * 1000),
        proved: sol.fairnessProved ? 'OPTIMAL' : 'bound only',
      });
      for (const id of ids) {
        const rec = perProvider.get(id) ?? {};
        rec[`eng_${mode}`] = engCalls.get(id) ?? 0;
        rec[`cp_${mode}`] = solCalls.get(id) ?? 0;
        perProvider.set(id, rec);
      }
    }
  }

  console.log(`  ${'mode'.padEnd(12)}${'solver'.padEnd(30)}${'filled'.padStart(8)}`
    + `${'stdev'.padStart(9)}${'time'.padStart(9)}${'   guarantee'}`);
  for (const r of rows) {
    console.log(`  ${r.mode.padEnd(12)}${r.who.padEnd(30)}${String(r.filled).padStart(8)}`
      + `${r.stdev.toFixed(3).padStart(9)}${(r.ms + 'ms').padStart(9)}   ${r.proved}`);
  }

  // The headline: how much fairness is actually on the table?
  const byMode = (mode: string, who: string) => rows.find(r => r.mode === mode && r.who.startsWith(who));
  for (const mode of ['all', 'obligatory']) {
    const e = byMode(mode, 'engine'); const c = byMode(mode, 'CP-SAT');
    if (!e || !c) continue;
    const gap = c.stdev < 1e-9 ? Infinity : e.stdev / c.stdev;
    console.log(`\n  ${mode.toUpperCase()}: engine ${e.stdev.toFixed(3)} vs optimal `
      + `${c.stdev.toFixed(3)}  →  ${Number.isFinite(gap) ? gap.toFixed(1) + '×' : 'n/a'}`
      + `${e.filled !== c.filled ? `   (filled ${e.filled} vs ${c.filled})` : ''}`);
  }

  console.log('\n  PER PROVIDER — calls placed');
  console.log(`  ${'provider'.padEnd(13)}${'fte'.padStart(5)}${'owes'.padStart(6)}`
    + `${'eng all'.padStart(9)}${'cp all'.padStart(8)}${'eng oblig'.padStart(11)}${'cp oblig'.padStart(10)}`);
  for (const id of [...ids].sort((a, b) => fte.get(b)! - fte.get(a)! || name.get(a)!.localeCompare(name.get(b)!))) {
    const r = perProvider.get(id) ?? {};
    console.log(`  ${name.get(id)!.padEnd(13)}${String(fte.get(id)).padStart(5)}`
      + `${String(obligation.get(id) ?? 0).padStart(6)}`
      + `${String(r.eng_all ?? '-').padStart(9)}${String(r.cp_all ?? '-').padStart(8)}`
      + `${String(r.eng_obligatory ?? '-').padStart(11)}${String(r.cp_obligatory ?? '-').padStart(10)}`);
  }
  console.log('');
}

main().catch(e => { console.error(e); process.exit(1); });
