/**
 * Engine vs CP-SAT across MANY synthetic blocks.
 *
 *   npx tsx scripts/benchBlocks.ts <versionId> [--seeds 6] [--ptoWeeks 2] [--offDays 3]
 *
 * READ ONLY. Nothing is written to the database, ever.
 *
 * ── WHY SYNTHETIC ─────────────────────────────────────────────────────────
 * One block at one site is not evidence that the engine is optimal in
 * general. Gabriel 2026-09-22: "run it on some more blocks but make sure to
 * include random PTO and days off for each provider, in order to make it
 * realistic." Real leave is what makes a block hard — it is what removes
 * candidates from exactly the slots that are already tight — so a benchmark
 * on a leave-free block measures the easy case and reports the flattering
 * number.
 *
 * Each seed takes the REAL loaded context and perturbs only availability:
 * whole PTO weeks plus scattered single days, drawn from a seeded PRNG so a
 * run is reproducible. Seed 0 is the control — the real block, untouched.
 *
 * ── WHAT IS HELD EQUAL, AND WHAT IS NOT ───────────────────────────────────
 * The comparison is only honest if both sides face the same problem.
 *
 *   • prePtoByThursday is REBUILT from the perturbed availability. Without
 *     this the adjacent-week weekend exclusion would still be keyed to the
 *     original leave and the injected PTO would be half-invisible.
 *   • workDayBudget is DROPPED on every arm including the control. It is
 *     assembled inline in genContext from availability, so carrying the
 *     original would apply a stale cap; rebuilding it here would duplicate
 *     that assembly and risk getting it subtly wrong. Absent is a DOCUMENTED
 *     state (genTypes: the cap never fires, byte-identical to pre-change) and
 *     the CP-SAT model never had the cap either — so dropping it makes the
 *     two sides MORE alike, not less. Stated because it means these runs do
 *     not exercise the workdays cap at all.
 *   • providerLimits and scenario are reported if present: the engine honours
 *     them and the model does not, which would flatter the solver.
 */

import { createClient } from '@supabase/supabase-js';
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { loadGenerationContext } from '../src/lib/rulesEngine/genContext';
import { solve } from '../src/lib/rulesEngine/solve';
import { optimize } from '../src/lib/rulesEngine/optimize';
import { buildCpsatModel } from '../src/lib/rulesEngine/cpsatModel';
import { callsPerFteStdev, obligationCoverage, callsPlaced } from '../src/lib/rulesEngine/burdenMetrics';
import { addDays, buildPrePtoByThursday } from '../src/lib/rulesEngine/shared';
import type {
  AvailabilityEntry, FillMode, GenerationContext, SolutionPlan,
} from '../src/lib/rulesEngine/genTypes';

function loadEnv() {
  try {
    for (const line of readFileSync(join(__dirname, '..', '.env.local'), 'utf8').split('\n')) {
      const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* already present */ }
}

const opt = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};

/** mulberry32 — a small seeded PRNG so every run reproduces exactly. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Clone the context with extra PTO. Only availability and the indexes derived
 * from it change; slots, providers, obligations and the pattern are untouched.
 */
function perturb(
  base: GenerationContext, seed: number, ptoWeeks: number, offDays: number,
): { ctx: GenerationContext; addedRows: number; addedDays: number } {
  const dates = base.scheduleDates ?? [...base.slotIndex.keys()].sort();
  const first = dates[0];
  const last = dates[dates.length - 1];
  const rand = rng(seed * 7919 + 13);
  const pick = (n: number) => Math.floor(rand() * n);

  const availByPid = new Map<string, AvailabilityEntry[]>();
  for (const [pid, rows] of base.availByPid) availByPid.set(pid, [...rows]);

  let addedRows = 0;
  let addedDays = 0;
  if (seed > 0) {
    for (const p of base.providers) {
      if (p.fte_value <= 0) continue;
      const rows = availByPid.get(p.id) ?? [];
      // Whole PTO weeks — the shape that actually removes a provider from a
      // weekend chain, which is what makes a block hard.
      const weeks = pick(ptoWeeks + 1);
      for (let w = 0; w < weeks; w++) {
        const start = dates[pick(dates.length)];
        const end = addDays(start, 6);
        rows.push({
          availability_type: 'pto', approval_status: 'approved',
          start_date: start, end_date: end > last ? last : end,
        });
        addedRows++; addedDays += 7;
      }
      // Scattered single days off.
      const singles = pick(offDays + 1);
      for (let d = 0; d < singles; d++) {
        const day = dates[pick(dates.length)];
        rows.push({
          availability_type: 'unavailable', approval_status: 'approved',
          start_date: day, end_date: day,
        });
        addedRows++; addedDays++;
      }
      availByPid.set(p.id, rows);
    }
  }

  const ctx: GenerationContext = {
    ...base,
    availByPid,
    // Keyed to the ORIGINAL leave otherwise — the adjacent-week weekend
    // exclusion would not see any of the injected PTO.
    prePtoByThursday: buildPrePtoByThursday(base.providers, availByPid, base.slotIndex),
    // See the header: absent is a documented state; stale would be a lie.
    workDayBudget: undefined,
  };
  void first;
  return { ctx, addedRows, addedDays };
}

interface Row {
  seed: number;
  leave: string;
  engine: ReturnType<typeof measure>;
  tuned: ReturnType<typeof measure>;
  /** Tuned PLUS spacing-first candidate ordering (Gabriel 2026-09-23). */
  spacing: ReturnType<typeof measure>;
  /** CP-SAT's answer AS REALISED by the engine — what you would actually
   *  ship, after solve() re-derives structure from the solver's call map. */
  cpsat: { filled: number; met: string; sd: number } | null;
  /** What the solver itself proved, before re-derivation. The drift between
   *  the two is how much of the solver's edge survives the engine's
   *  structural rules. */
  raw: { filled: number; sd: number } | null;
  /** Of the solver's call overrides, how many did solve() actually honour?
   *  Stage 1 rides entirely on this seam, so its fidelity IS the feature. */
  fidelity: { honoured: number; moved: number; dropped: number } | null;
  note: string;
}

/** Same-provider call pairs 3 days apart or less — the spacing signal.
 *  Absolute value includes designed chain adjacency (Fri-Sat-Sun), so compare
 *  arms against each other, not against zero. */
function tightPairs(plan: SolutionPlan): number {
  const byPid = new Map<string, string[]>();
  for (const a of plan.assignments) {
    if (!a.provider_id || a.shift_type_category !== 'call') continue;
    const cur = byPid.get(a.provider_id);
    if (cur) cur.push(a.slot_date); else byPid.set(a.provider_id, [a.slot_date]);
  }
  let n = 0;
  for (const dates of byPid.values()) {
    const d = [...dates].sort();
    for (let i = 1; i < d.length; i++) {
      if ((Date.parse(d[i]) - Date.parse(d[i - 1])) / 86_400_000 <= 3) n++;
    }
  }
  return n;
}

function measure(plan: SolutionPlan, ctx: GenerationContext) {
  const cov = obligationCoverage(plan, ctx);
  return {
    filled: callsPlaced(plan),
    met: `${cov.met}/${cov.total}`,
    sd: callsPerFteStdev(plan, ctx, true),
    tight: tightPairs(plan),
  };
}

async function main() {
  loadEnv();
  const versionId = process.argv[2];
  if (!versionId || versionId.startsWith('--')) {
    console.error('Usage: npx tsx scripts/benchBlocks.ts <versionId> [--seeds 6] [--ptoWeeks 2] [--offDays 3]');
    process.exit(1);
  }
  const seeds = parseInt(opt('seeds', '6'), 10);
  const ptoWeeks = parseInt(opt('ptoWeeks', '2'), 10);
  const offDays = parseInt(opt('offDays', '3'), 10);
  const mode = opt('mode', 'obligatory') as FillMode;
  const seconds = opt('seconds', '60');
  // Production default is 2000ms and solveMultiStart runs optimize K times,
  // so a tuned config that only pays off at 10s is not shippable as-is.
  const tunedMs = parseInt(opt('tunedMs', '10000'), 10);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error('Supabase env vars missing.'); process.exit(1); }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb: any = createClient(url, key, {
    db: { schema: 'scheduling' }, auth: { persistSession: false },
  });

  const { ctx: base, error } = await loadGenerationContext(sb, versionId);
  if (!base) { console.error('Context failed to load:', error); process.exit(1); }

  const outDir = join(__dirname, '..', '.cpsat');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  console.log(`\n  BLOCK ${base.scheduleDates?.[0]} → ${base.scheduleDates?.[base.scheduleDates.length - 1]}`
    + `   par ${base.parLevel}   mode ${mode}`);
  console.log(`  ${base.slotsToFill.filter(s => s.shift_type_category === 'call').length} open call slots`
    + ` · ${base.providers.filter(p => p.fte_value > 0).length} providers`
    + ` · ${seeds} seeds (0 = real leave, untouched)`);
  // Anything the engine honours and the model does not would flatter CP-SAT.
  if (base.providerLimits && Object.keys(base.providerLimits).length > 0) {
    console.log('  ! providerLimits present — the engine enforces them, the CP-SAT model does NOT.');
  }
  if (base.scenario) console.log('  ! a scenario manifest is projected onto this ctx.');

  const rows: Row[] = [];
  for (let seed = 0; seed < seeds; seed++) {
    const { ctx, addedRows, addedDays } = perturb(base, seed, ptoWeeks, offDays);

    solve(ctx, { fillMode: mode });
    // PRE-CHANGE behaviour, pinned explicitly: as of 2026-09-22 the defaults
    // ARE the tuned config, so a bare optimize() would make both columns the
    // same and hide the delta this table exists to show.
    const engine = optimize(ctx, {
      fillMode: mode, fillMonotonicityScope: 'all', ruinRecreate: false,
    }).plan;
    solve(ctx, { fillMode: mode });
    const tuned = optimize(ctx, {
      fillMode: mode, fillMonotonicityScope: 'count',
      ruinRecreate: true, ruinRounds: 60, wallClockMs: tunedMs, maxResolves: 50_000,
    }).plan;

    const priority = (process.argv.includes('--balanced')
      ? 'balanced' : 'spacing-first') as 'balanced' | 'spacing-first';
    solve(ctx, { fillMode: mode, callPriority: priority });
    const spacing = optimize(ctx, {
      fillMode: mode, callPriority: priority,
      wallClockMs: tunedMs, maxResolves: 50_000,
    }).plan;

    const model = buildCpsatModel(ctx);
    const modelPath = join(outDir, `bench-${versionId}-s${seed}.json`);
    writeFileSync(modelPath, JSON.stringify(model));
    let cpsat: Row['cpsat'] = null;
    let raw: Row['raw'] = null;
    let fidelity: Row['fidelity'] = null;
    let note = model.stats.noCandidateSlots > 0
      ? `${model.stats.noCandidateSlots} slot(s) have no eligible provider` : '';
    try {
      if (process.argv.includes('--noSolver')) throw new Error('skipped');
      execFileSync('python3', [
        join(__dirname, 'cpsat', 'model.py'), modelPath, '--mode', mode, '--seconds', seconds,
      ], { stdio: 'pipe' });
      const sol = JSON.parse(readFileSync(
        modelPath.replace(/\.json$/, '') + `.solution.${mode}.json`, 'utf8'));
      if (sol.assignment) {
        // Score the solver's answer THROUGH the engine, so both sides are
        // measured on a fully re-derived plan rather than on a raw map.
        const derived = solve(ctx, {
          callOverrides: new Map(Object.entries(sol.assignment as Record<string, string>)),
          fillMode: mode,
        });
        cpsat = measure(derived, ctx);
        raw = { filled: sol.filled as number, sd: sol.stdev as number };
        const placed = new Map<string, string>();
        for (const a of derived.assignments) {
          if (a.provider_id) placed.set(a.slot_id, a.provider_id);
        }
        let honoured = 0, moved = 0, dropped = 0;
        for (const [slotId, pid] of Object.entries(sol.assignment as Record<string, string>)) {
          const got = placed.get(slotId);
          if (got === pid) honoured++;
          else if (got) moved++;
          else dropped++;
        }
        fidelity = { honoured, moved, dropped };
        if (!sol.fairnessProved) note = note ? `${note}; not proved` : 'not proved optimal';
      } else {
        note = note ? `${note}; solver ${sol.status}` : `solver ${sol.status}`;
      }
    } catch {
      note = note ? `${note}; solver failed` : 'solver failed';
    }

    rows.push({
      seed,
      leave: seed === 0 ? 'real' : `+${addedRows}r/${addedDays}d`,
      engine: measure(engine, ctx), tuned: measure(tuned, ctx),
      spacing: measure(spacing, ctx), cpsat, raw, fidelity, note,
    });
    process.stdout.write('.');
  }
  console.log('\n');

  console.log(`  ${'seed'.padEnd(6)}${'leave'.padEnd(11)}`
    + `${'engine PRE-change'.padStart(26)}${'tuned (new default)'.padStart(26)}`
    + `${(process.argv.includes('--balanced') ? 'tuned + BALANCED' : 'tuned + SPACING-FIRST').padStart(26)}`);
  console.log(`  ${''.padEnd(17)}${'fill  met    sd tight'.padStart(26)}`
    + `${'fill  met    sd tight'.padStart(26)}${'fill  met    sd tight'.padStart(26)}`);
  const fmt = (m: ReturnType<typeof measure> | null) => m
    ? `${String(m.filled).padStart(5)}${m.met.padStart(7)}${m.sd.toFixed(3).padStart(8)}${String(m.tight).padStart(6)}`
    : '—'.padStart(26);
  for (const r of rows) {
    console.log(`  ${String(r.seed).padEnd(6)}${r.leave.padEnd(11)}`
      + `${fmt(r.engine)}${fmt(r.tuned)}${fmt(r.spacing)}`);
  }

  // ── the two questions this exercise exists to answer ───────────────────
  const cmp = rows.filter(r => r.cpsat && r.raw);

  // 1. Does the tuning help? (engine today vs engine tuned — no solver in it)
  const better = rows.filter(r => r.tuned.sd < r.engine.sd - 1e-9 || r.tuned.filled > r.engine.filled);
  const worse = rows.filter(r => r.tuned.sd > r.engine.sd + 1e-9 || r.tuned.filled < r.engine.filled);
  console.log(`\n  TUNING (count gate + ruin) vs today's defaults:`);
  console.log(`    better on ${better.length}/${rows.length}, worse on ${worse.length}/${rows.length}`);

  // Spacing-first: does it buy spacing, and what does it cost in burden?
  const tighter = rows.filter(r => r.spacing.tight < r.tuned.tight).length;
  const looser = rows.filter(r => r.spacing.tight > r.tuned.tight).length;
  const metWorse = rows.filter(r =>
    parseInt(r.spacing.met, 10) < parseInt(r.tuned.met, 10)).length;
  const metBetter = rows.filter(r =>
    parseInt(r.spacing.met, 10) > parseInt(r.tuned.met, 10)).length;
  console.log(`\n  ${process.argv.includes('--balanced') ? 'BALANCED' : 'SPACING-FIRST'} vs tuned:`);
  console.log(`    spacing  better on ${tighter}/${rows.length}, worse on ${looser}/${rows.length}`);
  console.log(`    burden   obligations met better on ${metBetter}/${rows.length}, `
    + `WORSE on ${metWorse}/${rows.length}`);

  // 2. How much of the solver's proved edge SURVIVES re-derivation? A large
  //    drift means the solver is optimising a model the engine will not
  //    reproduce, so its proof does not transfer to a shippable schedule.
  console.log(`\n  SOLVER: proved → re-derived drift, and override fidelity`);
  for (const r of cmp) {
    const d = r.cpsat!.sd - r.raw!.sd;
    const df = r.cpsat!.filled - r.raw!.filled;
    const f = r.fidelity;
    console.log(`    seed ${r.seed}: proved ${r.raw!.filled}/${r.raw!.sd.toFixed(3)}`
      + ` → realised ${r.cpsat!.filled}/${r.cpsat!.sd.toFixed(3)}`
      + `   (fill ${df >= 0 ? '+' : ''}${df}, sd ${d >= 0 ? '+' : ''}${d.toFixed(3)})`
      + (f ? `   overrides honoured ${f.honoured} · moved ${f.moved} · dropped ${f.dropped}` : ''));
  }
  const ahead = cmp.filter(r => r.tuned.sd < r.cpsat!.sd - 1e-9 && r.tuned.filled >= r.cpsat!.filled);
  if (ahead.length > 0) {
    console.log(`\n  ! On ${ahead.length} block(s) the tuned ENGINE beats the re-derived solver plan.`);
    console.log('    That cannot happen if the model is a faithful relaxation of the engine —');
    console.log('    it means the model is still stricter than the rules it is measuring.');
  }
  console.log('');
}

main().catch(e => { console.error(e); process.exit(1); });
