/**
 * Does a bigger optimizer budget — or letting it move weekends — close the
 * gap to the CP-SAT optimum?
 *
 *   npx tsx scripts/measureOptimizerScope.ts <scheduleVersionId> [model.json]
 *
 * READ ONLY.
 *
 * The CP-SAT benchmark found the engine reaches the proven optimum on a block
 * generated FROM SCRATCH and falls 5.1× short on one that is PARTLY BUILT.
 * The two things most likely to explain that are the optimizer's 2-second
 * wall clock and its movable set, which at Paoli is weekday + friday only.
 * This measures both.
 *
 * ── CHAINS ARE THE THING THAT MUST NOT BREAK ──────────────────────────────
 * Widening the movable day types to include Sat/Sun brings the weekend
 * structure into scope, and Paoli's weekends are chained: Sat C3 → Sun C3,
 * Fri C1 → Sun C2, Sat C2 → Fri C2 + Sun C1. A chain says one PERSON covers
 * the set; severing it produces a schedule that looks balanced and is wrong.
 *
 * The engine already guards both halves, and the guard is two separate
 * mechanisms rather than one:
 *   · chain LINKS carry source 'weekend-chain' / 'd-chain', and
 *     movableCallSlotIds only ever moves 'main-loop' / 'quota-relaxed'
 *   · chain ANCHORS are listed in plan.chainAnchorSlotIds and excluded by id
 *
 * That SHOULD mean widening the day types cannot sever a chain. This script
 * does not take that on trust: every arm is checked, and a broken pairing is
 * reported as a failure of the arm, not a footnote.
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { join } from 'path';
import { loadGenerationContext } from '../src/lib/rulesEngine/genContext';
import { solve } from '../src/lib/rulesEngine/solve';
import { optimize } from '../src/lib/rulesEngine/optimize';
import { totalExpectedCalls } from '../src/lib/rulesEngine/obligation';
import { CLASSIC_PATTERN, dayChainsFor } from '../src/lib/rulesEngine/callPattern';
import { movableCallSlotIds } from '../src/lib/rulesEngine/optimize';
import { addDays } from '../src/lib/rulesEngine/shared';
import type { GenerationContext, SolutionPlan, FillMode } from '../src/lib/rulesEngine/genTypes';
import type { SlotOrder } from '../src/lib/rulesEngine/slotOrder';
import type { OptimizeStats } from '../src/lib/rulesEngine/optimize';

function loadEnv() {
  try {
    for (const line of readFileSync(join(__dirname, '..', '.env.local'), 'utf8').split('\n')) {
      const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* already present */ }
}

const ALL_DAY_TYPES = [
  'weekday', 'friday', 'saturday', 'sunday', 'federal_holiday', 'major_holiday',
];

interface Arm {
  label: string;
  wallClockMs: number;
  maxResolves: number;
  /** null = leave the pattern's own movable set alone. */
  movableDayTypes: string[] | null;
  ruin?: boolean;
  fillScope?: 'all' | 'call' | 'count';
  slotOrder?: SlotOrder;
  /** Measure the GREEDY alone — isolates the commitment-order effect. */
  noOptimize?: boolean;
}

const ARMS: Arm[] = [
  { label: 'baseline (2s, wkdy+fri)', wallClockMs: 2_000, maxResolves: 5_000, movableDayTypes: null },
  { label: 'budget 30s', wallClockMs: 30_000, maxResolves: 100_000, movableDayTypes: null },
  { label: 'weekends movable (2s)', wallClockMs: 2_000, maxResolves: 5_000, movableDayTypes: ALL_DAY_TYPES },
  { label: 'both (30s + weekends)', wallClockMs: 30_000, maxResolves: 100_000, movableDayTypes: ALL_DAY_TYPES },
  // The move set, not the budget, was the binding constraint — so change the
  // move set. Ruin-and-recreate tears out a window of dates or one provider's
  // whole burden and lets solve() rebuild it, changing many slots at once.
  { label: 'ruin+recreate (2s)', wallClockMs: 2_000, maxResolves: 5_000, movableDayTypes: null, ruin: true },
  { label: 'ruin+recreate (10s)', wallClockMs: 10_000, maxResolves: 50_000, movableDayTypes: null, ruin: true },
  { label: 'ruin+recreate (30s)', wallClockMs: 30_000, maxResolves: 100_000, movableDayTypes: null, ruin: true },
  // The gate judges every category while the mechanism only pins calls, so an
  // identity re-solve already loses a fill and nothing can ever be accepted.
  // These scope the gate to what the mechanism controls.
  { label: 'fillScope=call (2s)', wallClockMs: 2_000, maxResolves: 5_000, movableDayTypes: null, fillScope: 'call' },
  { label: 'fillScope=call + ruin', wallClockMs: 10_000, maxResolves: 50_000, movableDayTypes: null, ruin: true, fillScope: 'call' },
  { label: 'call + ruin + weekends', wallClockMs: 30_000, maxResolves: 100_000, movableDayTypes: ALL_DAY_TYPES, ruin: true, fillScope: 'call' },
  // The identity re-solve RELOCATES a derived slot rather than losing one, so
  // comparing by slot identity rejects equally-good plans. Compare by count
  // per category: still no holes, no false positives.
  { label: 'fillScope=count (2s)', wallClockMs: 2_000, maxResolves: 5_000, movableDayTypes: null, fillScope: 'count' },
  { label: 'count + ruin (10s)', wallClockMs: 10_000, maxResolves: 50_000, movableDayTypes: null, ruin: true, fillScope: 'count' },

  // ── COMMITMENT ORDER (Gabriel: "attack from both ends") ────────────────
  // Greedy alone first: the optimizer would mask the construction effect,
  // and the construction effect is the question.
  { label: '· solve only: forward', wallClockMs: 0, maxResolves: 0, movableDayTypes: null, noOptimize: true },
  { label: '· solve only: reverse', wallClockMs: 0, maxResolves: 0, movableDayTypes: null, noOptimize: true, slotOrder: 'reverse' },
  { label: '· solve only: outside-in', wallClockMs: 0, maxResolves: 0, movableDayTypes: null, noOptimize: true, slotOrder: 'outside-in' },
  { label: '· solve only: constrained', wallClockMs: 0, maxResolves: 0, movableDayTypes: null, noOptimize: true, slotOrder: 'constrained' },
  // Then each ordering with the fixed gate on top.
  { label: 'reverse + count (2s)', wallClockMs: 2_000, maxResolves: 5_000, movableDayTypes: null, fillScope: 'count', slotOrder: 'reverse' },
  { label: 'outside-in + count (2s)', wallClockMs: 2_000, maxResolves: 5_000, movableDayTypes: null, fillScope: 'count', slotOrder: 'outside-in' },
  { label: 'constrained + count (2s)', wallClockMs: 2_000, maxResolves: 5_000, movableDayTypes: null, fillScope: 'count', slotOrder: 'constrained' },
];

const stdevOf = (calls: Map<string, number>, fte: Map<string, number>): number => {
  const rs = [...calls.keys()].map(p => calls.get(p)! / fte.get(p)!);
  if (!rs.length) return 0;
  const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
  return Math.sqrt(rs.reduce((a, r) => a + (r - mean) ** 2, 0) / rs.length);
};

/** Every (anchor, link) pair the pattern designs, as date|code keys. */
function designedChains(ctx: GenerationContext): Array<[string, string]> {
  const doc = ctx.callPattern ?? CLASSIC_PATTERN;
  const out: Array<[string, string]> = [];
  for (const s of ctx.slotsToFill) {
    if (s.shift_type_category !== 'call') continue;
    const from = `${s.slot_date}|${s.shift_type_code}`;
    for (const block of doc.blocks) {
      if (block.anchorDayType !== s.derived_day_type) continue;
      for (const c of block.chains) {
        if (c.trigger !== s.shift_type_code) continue;
        for (const l of c.links) out.push([from, `${addDays(s.slot_date, l.offset)}|${l.code}`]);
      }
    }
    for (const c of dayChainsFor(doc, s.shift_type_code, s.derived_day_type)) {
      for (const l of c.links ?? []) out.push([from, `${addDays(s.slot_date, l.offset)}|${l.code}`]);
    }
  }
  return out;
}

/** Chains where BOTH ends are filled but by DIFFERENT people — the failure. */
function brokenChains(plan: SolutionPlan, chains: Array<[string, string]>): number {
  const who = new Map<string, string>();
  for (const a of plan.assignments) {
    if (a.provider_id) who.set(`${a.slot_date}|${a.shift_type_code}`, a.provider_id);
  }
  let broken = 0;
  for (const [from, to] of chains) {
    const a = who.get(from); const b = who.get(to);
    if (a && b && a !== b) broken++;
  }
  return broken;
}

/**
 * Same-provider call pairs 3 days apart or less. Out-of-order commitment is
 * exactly what could wreck spacing — scoreCall's recency term reads "days
 * since last call" off the state built SO FAR, so a non-chronological sweep
 * degrades it. Absolute value includes designed chain adjacency; compare
 * arms against each other, not against zero.
 */
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

async function main() {
  loadEnv();
  const [versionId, modelPath] = process.argv.slice(2);
  if (!versionId) {
    console.error('Usage: npx tsx scripts/measureOptimizerScope.ts <versionId> [model.json]');
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

  const providers = ctx.providers.filter(p => p.fte_value > 0);
  const fte = new Map(providers.map(p => [p.id, p.fte_value]));
  const name = new Map(providers.map(p => [p.id, p.short_display_name || p.id.slice(0, 8)]));
  const owed = new Map([...totalExpectedCalls(ctx)].map(([k, v]) => [k, Math.round(v)]));
  const chains = designedChains(ctx);
  const openCallIds = new Set(ctx.slotsToFill
    .filter(s => s.shift_type_category === 'call').map(s => s.slot_id));

  // The proved optimum, when the CP-SAT model has been run for this block.
  const optimal: Record<string, { stdev: number; filled: number }> = {};
  if (modelPath) {
    for (const mode of ['all', 'obligatory']) {
      try {
        const s = JSON.parse(readFileSync(modelPath.replace(/\.json$/, '') + `.solution.${mode}.json`, 'utf8'));
        optimal[mode] = { stdev: s.stdev, filled: s.filled };
      } catch { /* not run for this mode */ }
    }
  }

  console.log(`\n  BLOCK  ${ctx.scheduleDates?.[0]} → ${ctx.scheduleDates?.[ctx.scheduleDates.length - 1]}`);
  console.log(`  ${ctx.slotsToFill.filter(s => s.shift_type_category === 'call').length} call slots · `
    + `${providers.length} providers · ${chains.length} designed chain links\n`);

  for (const mode of ['all', 'obligatory'] as FillMode[]) {
    console.log(`  ── ${mode.toUpperCase()} ${'─'.repeat(58)}`);
    console.log(`     ${'arm'.padEnd(26)}${'filled'.padStart(8)}${'stdev'.padStart(9)}`
      + `${'met'.padStart(6)}${'short'.padStart(7)}${'tight'.padStart(7)}${'chains broken'.padStart(15)}${'time'.padStart(9)}`
      + '   optimizer work');

    for (const arm of ARMS) {
      // A shallow ctx clone per arm; only the movable set differs.
      const doc = arm.movableDayTypes
        ? { ...(ctx.callPattern ?? CLASSIC_PATTERN), optimizerMovableDayTypes: arm.movableDayTypes }
        : ctx.callPattern;
      const armCtx = { ...ctx, callPattern: doc } as GenerationContext;

      const t0 = Date.now();
      const seed = solve(armCtx, { fillMode: mode, slotOrder: arm.slotOrder });
      const { plan, stats } = arm.noOptimize
        ? { plan: seed, stats: null as OptimizeStats | null }
        : optimize(armCtx, {
          fillMode: mode, wallClockMs: arm.wallClockMs, maxResolves: arm.maxResolves,
          ruinRecreate: arm.ruin, ruinRounds: 60,
          fillMonotonicityScope: arm.fillScope, slotOrder: arm.slotOrder,
        });
      const ms = Date.now() - t0;
      // How much work did the optimizer actually get to do? If it is inert,
      // the budget and the movable set are not the binding constraint and
      // raising either cannot help.
      const movableCount = movableCallSlotIds(seed, (armCtx.callPattern ?? CLASSIC_PATTERN)).length;

      const calls = new Map(providers.map(p => [p.id, 0]));
      for (const a of plan.assignments) {
        if (a.provider_id && a.shift_type_category === 'call' && calls.has(a.provider_id)) {
          calls.set(a.provider_id, calls.get(a.provider_id)! + 1);
        }
      }
      // Calls already held ELSEWHERE in the block. Leaving these out compares
      // the engine's in-plan-only spread against CP-SAT's prior-inclusive one
      // — two different quantities, which made an early run of this harness
      // report a 5x fairness gap where the like-for-like figure is 1.25x.
      for (const seed of ctx.seedAssignments) {
        if (seed.shift_type_category !== 'call' || !seed.provider_id) continue;
        if (seed.slot_id && openCallIds.has(seed.slot_id)) continue;
        if (calls.has(seed.provider_id)) {
          calls.set(seed.provider_id, calls.get(seed.provider_id)! + 1);
        }
      }
      let met = 0, short = 0;
      for (const p of providers) {
        if ((calls.get(p.id) ?? 0) >= (owed.get(p.id) ?? 0)) met++; else short++;
      }
      const broke = brokenChains(plan, chains);
      // Plan-only: `calls` now folds in prior calls for the fairness/obligation
      // maths, which would make this column incomparable to the solver's.
      const filled = plan.assignments
        .filter(a => a.provider_id && a.shift_type_category === 'call').length;

      console.log(`     ${arm.label.padEnd(26)}${String(filled).padStart(8)}`
        + `${stdevOf(calls, fte).toFixed(3).padStart(9)}`
        + `${String(met).padStart(6)}${String(short).padStart(7)}`
        + `${String(tightPairs(plan)).padStart(7)}`
        + `${(broke === 0 ? 'none' : `${broke} BROKEN`).padStart(15)}${(ms + 'ms').padStart(9)}`
        + (!stats ? '   greedy only' : `   movable ${String(movableCount).padStart(3)}`
        + ` · resolves ${String(stats.resolves).padStart(5)}`
        + ` · gated ${String(stats.gatedSkips).padStart(5)}`
        + ` · moveRej(fill ${stats.moveReject?.fill} same ${stats.moveReject?.same} worse ${stats.moveReject?.worse})`
        + (arm.ruin ? ` · ruin ok ${stats.ruinAccepted ?? 0}`
          + ` rej(fill ${stats.ruinReject?.fill} cap ${stats.ruinReject?.caps}`
          + ` obl ${stats.ruinReject?.oblig} same ${stats.ruinReject?.same}`
          + ` worse ${stats.ruinReject?.worse})` : '')));
    }
    if (optimal[mode]) {
      console.log(`     ${'CP-SAT (proved optimal)'.padEnd(26)}`
        + `${String(optimal[mode].filled).padStart(8)}${optimal[mode].stdev.toFixed(3).padStart(9)}`);
    }
    console.log('');
  }
  console.log(`  Providers: ${providers.map(p => name.get(p.id)).join(', ')}\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
