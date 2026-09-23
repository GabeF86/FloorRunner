/**
 * Stage 1 of the CP-SAT hybrid: generate a block with the solver's help,
 * compare it against what the engine alone would produce, and — only on an
 * explicit --write — commit it.
 *
 *   npx tsx scripts/cpsatPolish.ts <scheduleVersionId>                  # dry
 *   npx tsx scripts/cpsatPolish.ts <scheduleVersionId> --mode all
 *   npx tsx scripts/cpsatPolish.ts <scheduleVersionId> --write
 *
 * DRY BY DEFAULT. Nothing is written without --write.
 *
 * ── WHAT THIS DOES ────────────────────────────────────────────────────────
 *   1. loads the generation context for the version
 *   2. builds the CP-SAT model from it (cpsatModel.ts — the engine's OWN
 *      eligibility verdicts are the variable domain)
 *   3. shells out to scripts/cpsat/model.py (OR-Tools)
 *   4. feeds the solution back through solve()'s callOverrides seam and
 *      applies the three safety gates (cpsatPolish.ts)
 *   5. prints both plans side by side
 *   6. --write only: commitPlan, then batch validation
 *
 * ── SCOPE LIMIT, STATED PLAINLY ───────────────────────────────────────────
 * This polishes a draft whose call slots are still OPEN. A draft that is
 * already fully generated has no open call slots — its assignments arrive as
 * seeds, which the solver treats as fixed — so there is nothing left to
 * rearrange. To re-optimise a generated draft, clear it and regenerate
 * through this script. The run reports the open-slot count up front so an
 * empty run is never mistaken for "no improvement available".
 *
 * ── REQUIREMENTS ──────────────────────────────────────────────────────────
 *   python3 -m pip install ortools        (see scripts/cpsat/README.md)
 */

import { createClient } from '@supabase/supabase-js';
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { loadGenerationContext } from '../src/lib/rulesEngine/genContext';
import { loadSiteValidationContext } from '../src/lib/rulesEngine/loadContext';
import { batchValidateVersion } from '../src/lib/rulesEngine/batchValidate';
import { solve } from '../src/lib/rulesEngine/solve';
import { optimize } from '../src/lib/rulesEngine/optimize';
import { commitPlan } from '../src/lib/rulesEngine/commit';
import { scoreSolution } from '../src/lib/rulesEngine/metrics';
import { totalExpectedCalls } from '../src/lib/rulesEngine/obligation';
import { buildCpsatModel } from '../src/lib/rulesEngine/cpsatModel';
import { applyCpsatSolution } from '../src/lib/rulesEngine/cpsatPolish';
import type { CpsatSolution } from '../src/lib/rulesEngine/cpsatPolish';
import type { FillMode, GenerationContext, SolutionPlan } from '../src/lib/rulesEngine/genTypes';

function loadEnv() {
  try {
    for (const line of readFileSync(join(__dirname, '..', '.env.local'), 'utf8').split('\n')) {
      const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* already present */ }
}

const flag = (name: string) => process.argv.includes(`--${name}`);
const opt = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};

/** Per-provider call count; includePrior folds in calls already held
 *  elsewhere in the block, which is what obligation is measured against. */
function callCounts(
  plan: SolutionPlan, ctx: GenerationContext, includePrior: boolean,
): Map<string, number> {
  const providers = ctx.providers.filter(p => p.fte_value > 0);
  const calls = new Map(providers.map(p => [p.id, 0]));
  const bump = (pid: string) => {
    if (calls.has(pid)) calls.set(pid, calls.get(pid)! + 1);
  };
  for (const a of plan.assignments) {
    if (a.provider_id && a.shift_type_category === 'call') bump(a.provider_id);
  }
  if (includePrior) {
    const openIds = new Set(ctx.slotsToFill
      .filter(sl => sl.shift_type_category === 'call').map(sl => sl.slot_id));
    for (const seed of ctx.seedAssignments) {
      if (seed.shift_type_category !== 'call' || !seed.provider_id) continue;
      if (seed.slot_id && openIds.has(seed.slot_id)) continue;
      bump(seed.provider_id);
    }
  }
  return calls;
}

/** Providers whose TOTAL block call meets their stated obligation.
 *  Gabriel 2026-09: "the only true and important thing is call quota being
 *  met every block" — so this is the headline column, not the spread. */
function obligationsMet(plan: SolutionPlan, ctx: GenerationContext): string {
  const calls = callCounts(plan, ctx, true);
  const owed = totalExpectedCalls(ctx);
  let met = 0;
  for (const [pid, n] of calls) {
    if (n >= Math.round(owed.get(pid) ?? 0)) met++;
  }
  return `${met}/${calls.size}`;
}

/**
 * Population stdev of calls-per-FTE — the SAME quantity model.py reports, so
 * both sides of the comparison are one number computed one way.
 * scoreSolution().fairnessStdev is the engine's own internal metric on a
 * different scale; it is printed as a separate column, never as the
 * counterpart to the solver's figure.
 */
function callsPerFteStdev(
  plan: SolutionPlan, ctx: GenerationContext, includePrior: boolean,
): number {
  // model.py folds priorCalls into its ratios, so a comparison that leaves
  // them out measures a different quantity than the solver optimised — the
  // mistake that made an early benchmark read as a 5x gap when it is 1.25x.
  const providers = ctx.providers.filter(p => p.fte_value > 0);
  const calls = callCounts(plan, ctx, includePrior);
  const ratios = providers.map(p => calls.get(p.id)! / p.fte_value);
  if (ratios.length === 0) return 0;
  const mean = ratios.reduce((x, y) => x + y, 0) / ratios.length;
  return Math.sqrt(ratios.reduce((acc, r) => acc + (r - mean) ** 2, 0) / ratios.length);
}

function planLine(label: string, plan: SolutionPlan, ctx: GenerationContext) {
  const m = scoreSolution(plan, ctx);
  const calls = plan.assignments.filter(a => a.provider_id && a.shift_type_category === 'call').length;
  return `  ${label.padEnd(30)}${String(calls).padStart(7)}`
    + `${obligationsMet(plan, ctx).padStart(9)}`
    + `${String(m.skipped).padStart(9)}`
    + `${callsPerFteStdev(plan, ctx, false).toFixed(3).padStart(11)}`
    + `${callsPerFteStdev(plan, ctx, true).toFixed(3).padStart(13)}`
    + `${m.fairnessStdev.toFixed(3).padStart(11)}`;
}

async function main() {
  loadEnv();
  const versionId = process.argv[2];
  if (!versionId || versionId.startsWith('--')) {
    console.error('Usage: npx tsx scripts/cpsatPolish.ts <scheduleVersionId> [--mode obligatory|all] [--write]');
    process.exit(1);
  }
  const mode = opt('mode', 'obligatory') as FillMode;
  const seconds = opt('seconds', '60');
  const write = flag('write');

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error('Supabase env vars missing.'); process.exit(1); }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb: any = createClient(url, key, {
    db: { schema: 'scheduling' }, auth: { persistSession: false },
  });

  // ── 1. context ──────────────────────────────────────────────────────────
  const { ctx, error } = await loadGenerationContext(sb, versionId);
  if (!ctx) { console.error('Context failed to load:', error); process.exit(1); }

  const openCalls = ctx.slotsToFill.filter(s => s.shift_type_category === 'call').length;
  console.log(`\n  VERSION  ${versionId}`);
  console.log(`  mode     ${mode}${write ? '   *** WRITE ***' : '   (dry run)'}`);
  console.log(`  open call slots  ${openCalls}`);
  if (openCalls === 0) {
    console.log('\n  Nothing to do: this draft has no OPEN call slots. Its assignments arrive');
    console.log('  as seeds, which the solver treats as fixed. Clear the draft and regenerate');
    console.log('  through this script to re-optimise it.\n');
    return;
  }

  // ── 2. model ────────────────────────────────────────────────────────────
  const outDir = join(__dirname, '..', '.cpsat');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const modelPath = join(outDir, `${versionId}.json`);
  const model = buildCpsatModel(ctx);
  model.meta.exportedAt = new Date().toISOString();
  writeFileSync(modelPath, JSON.stringify(model, null, 2));
  console.log(`  model    ${model.stats.callSlots} slots · ${model.stats.providers} providers · `
    + `${model.stats.feasiblePairs} feasible pairs (avg ${model.stats.avgEligiblePerSlot})`);
  console.log(`           ${model.stats.chains} chain equalities · `
    + `${model.stats.seededSlots} seeded · ${model.stats.priorCalls} prior calls`);
  if (model.stats.noCandidateSlots > 0) {
    console.log(`           ! ${model.stats.noCandidateSlots} slot(s) have NO eligible provider `
      + 'before any constraint — unfillable for the engine AND the solver.');
  }

  // ── 3. solver ───────────────────────────────────────────────────────────
  console.log(`\n  solving (${seconds}s cap) …`);
  try {
    execFileSync('python3', [
      join(__dirname, 'cpsat', 'model.py'), modelPath, '--mode', mode, '--seconds', seconds,
    ], { stdio: 'inherit' });
  } catch {
    console.error('\n  Solver failed. Is OR-Tools installed?  python3 -m pip install ortools');
    console.error('  See scripts/cpsat/README.md.\n');
    process.exit(1);
  }

  const solPath = modelPath.replace(/\.json$/, '') + `.solution.${mode}.json`;
  let solution: CpsatSolution | null = null;
  try { solution = JSON.parse(readFileSync(solPath, 'utf8')); } catch {
    console.error(`  Could not read solver output at ${solPath}`);
    process.exit(1);
  }

  // ── 4. incumbent + gates ────────────────────────────────────────────────
  // The incumbent is TODAY's production behaviour, so the delta answers
  // "versus what we would ship right now" rather than versus a tuned run.
  solve(ctx, { fillMode: mode });
  const { plan: engine } = optimize(ctx, { fillMode: mode });
  const result = applyCpsatSolution(ctx, engine, solution, { fillMode: mode });

  console.log(`\n  ${'plan'.padEnd(30)}${'calls'.padStart(7)}${'oblig met'.padStart(9)}${'skipped'.padStart(9)}`
    + `${'in-plan sd'.padStart(11)}${'incl.prior sd'.padStart(12)}${'engine sd'.padStart(11)}`);
  console.log(planLine('engine (greedy + hill-climb)', engine, ctx));
  if (result.trialMetrics) console.log(planLine('engine + CP-SAT', result.plan, ctx));
  console.log(`\n  solver status    ${solution!.status}`
    + `${solution!.fairnessProved ? ' (fairness PROVED optimal)' : ''}`);
  console.log(`  verdict          ${result.accepted ? 'ACCEPTED' : `REJECTED — ${result.reason}`}`);
  console.log(`  ${result.detail}`);
  if (result.overriddenByStructure.length > 0) {
    // Not an error: solve() owns structure, so a chain overrides the solver.
    console.log(`  note             ${result.overriddenByStructure.length} slot(s) were re-derived by `
      + 'the pattern rather than taken from the solver (chains win).');
  }

  if (!result.accepted) {
    console.log('\n  Nothing written — the incumbent stands.\n');
    return;
  }
  if (!write) {
    console.log('\n  Dry run. Re-run with --write to commit this plan.\n');
    return;
  }

  // ── 5. commit, then validate ────────────────────────────────────────────
  console.log('\n  committing …');
  const commit = await commitPlan(sb, result.plan);
  console.log(`  ${JSON.stringify(commit)}`);

  const siteCtx = await loadSiteValidationContext(sb, ctx.siteId);
  const validation = await batchValidateVersion(sb, versionId, siteCtx);
  // Invariant 6: a row that did not evaluate is NOT a clean row. Count the
  // unevaluated separately and say so, rather than folding them into zero.
  const rows = validation.results;
  const unevaluated = rows.filter(r => !r.evaluated).length;
  const hard = rows.reduce((n, r) => n + r.hardCount, 0);
  const soft = rows.reduce((n, r) => n + r.softCount, 0);
  console.log(`\n  validation  ${rows.length} rows · hard ${hard} · soft ${soft}`
    + ` · written ${validation.written}`);
  if (validation.errors.length > 0) console.log(`  errors: ${validation.errors.join('; ')}`);
  if (unevaluated > 0) {
    console.log(`  !! ${unevaluated} row(s) DID NOT EVALUATE — treat them as UNVERIFIED, `
      + 'not clean (invariant 6).');
  }
  if (hard > 0) console.log('  !! Hard violations flagged. Review before publishing.');
  if (unevaluated === 0 && hard === 0) console.log('  clean.');
  console.log('');
}

main().catch(e => { console.error(e); process.exit(1); });
