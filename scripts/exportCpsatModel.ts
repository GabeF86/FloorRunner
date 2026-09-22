/**
 * Export a real generation context as a CP-SAT model input.
 *
 *   npx tsx scripts/exportCpsatModel.ts <scheduleVersionId> [out.json]
 *
 * READ ONLY. Nothing is written to the database.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 * To answer one question with evidence instead of intuition: how far is the
 * greedy engine from the best schedule that exists? A solver that proves
 * optimality gives a number; nothing else does.
 *
 * ── THE ONE DESIGN RULE THAT MAKES THE COMPARISON HONEST ──────────────────
 * The model does NOT re-implement the clinical rules. It consumes the
 * ENGINE'S OWN eligibility verdicts.
 *
 * Re-deriving "can this provider take this slot" in Python would make the
 * benchmark meaningless in the bad direction: a solver that wins by
 * forgetting the adjacent-week PTO exclusion has not beaten the engine, it
 * has just broken a rule the engine follows. Exporting the verdicts means a
 * pair the engine refuses is a pair the model cannot use — the solver can
 * only win on ARRANGEMENT, which is exactly the thing being measured.
 *
 * ── STATIC VS DYNAMIC GATES ───────────────────────────────────────────────
 * evaluateEligibility is stateful: some gates depend only on (provider,
 * slot), others on what has already been placed. Run against an EMPTY solve
 * state, the dynamic gates cannot fire, so what comes back is exactly the
 * static feasibility:
 *
 *   STATIC   → exported as the variable domain
 *              provider group, site credentials, weekday availability,
 *              PTO/leave with bookend, adjacent-week weekend exclusion,
 *              cross-schedule conflicts against published versions
 *
 *   DYNAMIC  → exported as data and modelled as CONSTRAINTS in Python
 *              one call per provider per day, post-call rest, bucket quota,
 *              obligation ceiling, pattern chains
 *
 * The gate set is 'call-no-quota' deliberately: the quota is a dynamic rule
 * the model states explicitly, and letting it fire here would bake a greedy
 * artefact into the domain.
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { loadGenerationContext } from '../src/lib/rulesEngine/genContext';
import { evaluateEligibility } from '../src/lib/rulesEngine/eligibility';
import { emptySolveState } from '../src/lib/rulesEngine/solveState';
import { totalExpectedCalls } from '../src/lib/rulesEngine/obligation';
import { CLASSIC_PATTERN, dayChainsFor, postCallBlockOffsets } from '../src/lib/rulesEngine/callPattern';
import { dayTypeBucketOn } from '../src/lib/rulesEngine/shared';
import { addDays } from '../src/lib/rulesEngine/shared';
import type { GenerationContext, SlotToFill } from '../src/lib/rulesEngine/genTypes';

function loadEnv() {
  try {
    for (const line of readFileSync(join(__dirname, '..', '.env.local'), 'utf8').split('\n')) {
      const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* already present */ }
}

interface ModelSlot {
  id: string;
  date: string;
  code: string;
  dayType: string;
  bucket: string;
  /** Provider ids the engine says MAY hold this slot (static gates only). */
  eligible: string[];
  /** Pre-existing assignment the engine would treat as a seed — fixed, not
   *  a decision. Null when the slot is open. */
  fixedTo: string | null;
  /** Placing this slot blocks its holder on these dates (post-call rest). */
  blocksDates: string[];
}

interface ModelChain {
  /** Anchor slot id; the linked slot must go to the SAME provider. */
  from: string;
  to: string;
  kind: 'block' | 'dayChain';
}

async function main() {
  loadEnv();
  const versionId = process.argv[2];
  const outPath = process.argv[3] ?? 'cpsat-model.json';
  if (!versionId) {
    console.error('Usage: npx tsx scripts/exportCpsatModel.ts <scheduleVersionId> [out.json]');
    process.exit(1);
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error('Supabase env vars missing.'); process.exit(1); }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb: any = createClient(url, key, {
    db: { schema: 'scheduling' }, auth: { persistSession: false },
  });

  const { ctx, error } = await loadGenerationContext(sb, versionId);
  if (!ctx) { console.error('Context failed to load:', error); process.exit(1); }
  const doc = ctx.callPattern ?? CLASSIC_PATTERN;

  const callSlots = ctx.slotsToFill.filter(s => s.shift_type_category === 'call');
  const providers = ctx.providers.filter(p => p.fte_value > 0);

  // ── Static eligibility, straight from the engine ────────────────────────
  // Empty state ⇒ only the static gates can fire. 'call-no-quota' ⇒ the
  // quota is left to the model, which states it as a constraint.
  const emptyState = emptySolveState();
  let pairs = 0;
  const slots: ModelSlot[] = callSlots.map((s: SlotToFill) => {
    const eligible = providers
      .filter(p => evaluateEligibility(s, p, emptyState, ctx, 'call-no-quota').eligible)
      .map(p => p.id);
    pairs += eligible.length;

    // Post-call rest, read off the pattern exactly as solve() does.
    const offsets = postCallBlockOffsets(doc, s.shift_type_code, s.derived_day_type);
    return {
      id: s.slot_id,
      date: s.slot_date,
      code: s.shift_type_code,
      dayType: s.derived_day_type,
      bucket: `${dayTypeBucketOn(s.derived_day_type, s.slot_date)}|${s.shift_type_code}`,
      eligible,
      fixedTo: null,
      blocksDates: offsets.map(o => addDays(s.slot_date, o)),
    };
  });

  // ── Seeds: calls ALREADY HELD, which the model must carry too ───────────
  // Seeded call slots are not in slotsToFill — they are done, not open. But
  // they are far from irrelevant: they consume the holder's obligation, they
  // occupy a date, and they trigger post-call rest.
  //
  // The first version of this exporter ignored them, and the benchmark then
  // handed the solver an easier problem than the engine was solving: 16 calls
  // of capacity the engine had already spent and the model still had. It
  // reported the engine as leaving 18 obligation calls unplaced when much of
  // that was the harness, not the engine. A benchmark that flatters the
  // challenger is worse than no benchmark.
  const slotById = new Map(slots.map(s => [s.id, s]));
  let seeded = 0;
  const priorCalls: Record<string, number> = {};
  const busyDates: Record<string, string[]> = {};
  for (const seed of ctx.seedAssignments) {
    if (seed.shift_type_category !== 'call') continue;
    if (!seed.provider_id) continue;
    // slot_id is optional on a seed (a seed can predate its slot row).
    const target = seed.slot_id ? slotById.get(seed.slot_id) : undefined;
    if (target) { target.fixedTo = seed.provider_id; seeded++; continue; }
    // A seed with no OPEN slot of its own: already-committed work. Counted
    // against the holder's capacity and marked on their calendar.
    priorCalls[seed.provider_id] = (priorCalls[seed.provider_id] ?? 0) + 1;
    (busyDates[seed.provider_id] ??= []).push(seed.slot_date);
    // Post-call rest earned by a seeded call blocks the next day too.
    for (const o of postCallBlockOffsets(doc, seed.shift_type_code, seed.derived_day_type ?? 'weekday')) {
      busyDates[seed.provider_id].push(addDays(seed.slot_date, o));
    }
  }

  // ── Pattern chains: same-provider coupling ──────────────────────────────
  // A chain says "whoever takes the anchor also takes the link". The engine
  // enforces it by construction; the model needs it as an equality.
  const byDateCode = new Map<string, string>();
  for (const s of slots) byDateCode.set(`${s.date}|${s.code}`, s.id);
  const chains: ModelChain[] = [];
  const addChain = (from: ModelSlot, date: string, code: string, kind: ModelChain['kind']) => {
    const to = byDateCode.get(`${date}|${code}`);
    if (to && to !== from.id) chains.push({ from: from.id, to, kind });
  };
  for (const s of slots) {
    for (const block of doc.blocks) {
      if (block.anchorDayType !== s.dayType) continue;
      for (const chain of block.chains) {
        if (chain.trigger !== s.code) continue;
        for (const link of chain.links) addChain(s, addDays(s.date, link.offset), link.code, 'block');
      }
    }
    for (const chain of dayChainsFor(doc, s.code, s.dayType)) {
      for (const link of chain.links ?? []) {
        addChain(s, addDays(s.date, link.offset), link.code, 'dayChain');
      }
    }
  }

  const obligations = totalExpectedCalls(ctx);
  const model = {
    meta: {
      versionId,
      from: slots.reduce((a, s) => (s.date < a ? s.date : a), '9999'),
      to: slots.reduce((a, s) => (s.date > a ? s.date : a), '0000'),
      parLevel: ctx.parLevel,
      exportedAt: null as string | null,   // stamped by the caller, not here
    },
    providers: providers.map(p => ({
      id: p.id,
      name: p.short_display_name || p.id.slice(0, 8),
      fte: p.fte_value,
      obligation: Math.round(obligations.get(p.id) ?? 0),
      // Calls already committed elsewhere in this block. The model spends
      // them against the obligation and counts them in the fairness ratio,
      // exactly as the engine does.
      priorCalls: priorCalls[p.id] ?? 0,
      busyDates: [...new Set(busyDates[p.id] ?? [])],
      // Per-bucket fairness target the engine gates on, so the model can use
      // the SAME quota rather than inventing one.
      bucketTargets: Object.fromEntries(
        [...ctx.bucketTarget.entries()]
          .filter(([k]) => k.startsWith(`${p.id}|`))
          .map(([k, v]) => [k.slice(p.id.length + 1), v]),
      ),
    })),
    slots,
    chains,
    stats: {
      callSlots: slots.length,
      providers: providers.length,
      feasiblePairs: pairs,
      seededSlots: seeded,
      priorCalls: Object.values(priorCalls).reduce((a, b) => a + b, 0),
      chains: chains.length,
      // Density: how much freedom the model actually has.
      avgEligiblePerSlot: +(pairs / Math.max(slots.length, 1)).toFixed(2),
    },
  };

  writeFileSync(outPath, JSON.stringify(model, null, 2));
  console.log(`\n  wrote ${outPath}`);
  console.log(`  block            ${model.meta.from} → ${model.meta.to}`);
  console.log(`  call slots       ${model.stats.callSlots}  (${seeded} seeded in place)`);
  console.log(`  prior calls      ${model.stats.priorCalls}  already committed elsewhere in the block`);
  console.log(`  providers        ${model.stats.providers}   par ${ctx.parLevel}`);
  console.log(`  feasible pairs   ${model.stats.feasiblePairs}  `
    + `(avg ${model.stats.avgEligiblePerSlot} eligible per slot)`);
  console.log(`  chain couplings  ${model.stats.chains}`);
  const noCandidate = slots.filter(s => s.eligible.length === 0 && !s.fixedTo).length;
  if (noCandidate > 0) {
    console.log(`  ! ${noCandidate} slot(s) have NO eligible provider even before any `
      + 'constraint — those are unfillable for both the engine and the solver.');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
