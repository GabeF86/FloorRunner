// READ-ONLY measurement, run on demand (not part of the suite's intent — it
// hits the live DB). Loads the real block, rebuilds it as a from-scratch board,
// and races the engine variants purely in memory. commitPlan is never called.
import { describe, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { loadGenerationContext } from '../genContext';
import { solve } from '../solve';
import { optimize } from '../optimize';
import { solveMultiStart } from '../multiStart';
import { spacingScore } from '../spacingScore';
import { computeObligations } from '../obligation';
import { dayTypeBucketOn } from '../shared';
import type { GenerationContext, SlotToFill, SolutionPlan } from '../genTypes';

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const VERSION = process.env.MEASURE_VERSION!;
const PRIMARY = 'C1';

function fromScratch(ctx: GenerationContext): GenerationContext {
  const byId = new Map<string, SlotToFill>();
  for (const s of ctx.slotsToFill) byId.set(s.slot_id, s);
  for (const seed of ctx.seedAssignments) {
    if (seed.shift_type_category !== 'call' || !seed.slot_id || byId.has(seed.slot_id)) continue;
    byId.set(seed.slot_id, {
      slot_id: seed.slot_id, slot_date: seed.slot_date,
      shift_type_id: `st-${seed.shift_type_code}`, shift_type_code: seed.shift_type_code,
      shift_type_category: 'call', derived_day_type: seed.derived_day_type,
      provider_group: 'physician', required_count: 1, existing_assignment_id: null,
    });
  }
  const slotsToFill = [...byId.values()];
  const order = ctx.callPattern?.dayTypeFillOrder
    ?? ['saturday', 'sunday', 'friday', 'weekday', 'federal_holiday', 'major_holiday'];
  const rank = (dt: string) => { const i = order.indexOf(dt); return i < 0 ? order.length : i; };
  slotsToFill.sort((a, b) => rank(a.derived_day_type) - rank(b.derived_day_type)
    || a.slot_date.localeCompare(b.slot_date)
    || (ctx.shiftTypes?.get(a.shift_type_code)?.call_rank ?? 9)
       - (ctx.shiftTypes?.get(b.shift_type_code)?.call_rank ?? 9));
  const slotIndex = new Map<string, Map<string, SlotToFill>>();
  for (const [d, m] of ctx.slotIndex) slotIndex.set(d, new Map(m));
  for (const s of slotsToFill) {
    if (!slotIndex.has(s.slot_date)) slotIndex.set(s.slot_date, new Map());
    slotIndex.get(s.slot_date)!.set(s.shift_type_code, s);
  }
  return { ...ctx, slotsToFill, slotIndex, seedAssignments: [] };
}

const DAY = 86_400_000;
const days = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);

function spacing(plan: SolutionPlan, ctx: GenerationContext) {
  const byPid = new Map<string, Array<{ d: string; bucket: string }>>();
  for (const a of plan.assignments) {
    if (a.shift_type_category !== 'call') continue;
    const code = ctx.shiftTypes?.get(a.shift_type_code)?.parent_call_code ?? a.shift_type_code;
    if (code !== PRIMARY) continue;
    const list = byPid.get(a.provider_id) ?? [];
    list.push({ d: a.slot_date, bucket: dayTypeBucketOn(a.derived_day_type, a.slot_date) });
    byPid.set(a.provider_id, list);
  }
  const gaps: number[] = [];
  let le2 = 0, le3 = 0, movable = 0;
  for (const list of byPid.values()) {
    list.sort((x, y) => x.d.localeCompare(y.d));
    for (let i = 1; i < list.length; i++) {
      const g = days(list[i - 1].d, list[i].d);
      gaps.push(g);
      if (g <= 2) le2++;
      if (g <= 3) { le3++; if (list[i - 1].bucket === 'weekday' || list[i].bucket === 'weekday') movable++; }
    }
  }
  gaps.sort((a, b) => a - b);
  const obl = computeObligations(ctx);
  const held = new Map<string, number>();
  for (const a of plan.assignments) {
    if (a.shift_type_category === 'call') held.set(a.provider_id, (held.get(a.provider_id) ?? 0) + 1);
  }
  let overCap = 0;
  for (const [pid, n] of held) {
    const cap = obl.get(pid);
    if (cap != null && Number.isFinite(cap) && n > cap) overCap++;
  }
  return {
    calls: plan.assignments.filter(a => a.shift_type_category === 'call').length,
    unfilled: plan.unfilled.length,
    minGap: gaps[0] ?? null,
    avgGap: gaps.length ? +(gaps.reduce((s, g) => s + g, 0) / gaps.length).toFixed(2) : null,
    le2, le3, movable, overCap,
  };
}

describe('spacing measurement', () => {
  it('races the engine variants on the real block', async () => {
    const sb = sbSchedulingServer();
    const loaded = await loadGenerationContext(sb, VERSION);
    if (!loaded.ctx) throw new Error('load failed: ' + ((loaded as { error?: string }).error ?? '?'));
    const ctx = fromScratch(loaded.ctx);
    console.log(`block: ${ctx.slotsToFill.length} call slots · ${ctx.providers.length} providers · par ${ctx.parLevel}`);

    const rows: Array<[string, ReturnType<typeof spacing>]> = [];
    rows.push(['obligatory greedy (TODAY)', spacing(solve(ctx, { fillMode: 'obligatory' }), ctx)]);
    let t = Date.now();
    const opt = optimize(ctx, { fillMode: 'obligatory', wallClockMs: 4000 });
    rows.push([`obligatory + optimizer ${Date.now() - t}ms`, spacing(opt.plan, ctx)]);
    rows.push(['all greedy', spacing(solve(ctx, { fillMode: 'all' }), ctx)]);
    t = Date.now();
    const optAll = optimize(ctx, { fillMode: 'all', wallClockMs: 4000 });
    rows.push([`all + optimizer ${Date.now() - t}ms`, spacing(optAll.plan, ctx)]);

    // The SPACING objective — today gated behind a scenario manifest, which
    // this schedule does not have. spacingScore's scenario terms are all
    // guarded, so it computes gaps/blocks fine without one.
    for (const mode of ['obligatory', 'all'] as const) {
      t = Date.now();
      const ms = solveMultiStart(ctx, {
        k: 8, fillMode: mode, optimizeEnabled: mode === 'all', wallClockMs: 1500,
      });
      rows.push([`${mode} + multiStart K=8 ${Date.now() - t}ms`, spacing(ms.plan, ctx)]);
    }
    console.log('spacing score, obligatory greedy:',
      JSON.stringify(spacingScore(ctx, solve(ctx, { fillMode: 'obligatory' }))));

    const head = ['calls', 'unfil', 'min', 'avg', 'C1≤2', 'C1≤3', 'movable', 'overCap'];
    console.log('\n' + 'variant'.padEnd(32) + head.map(h => h.padStart(9)).join(''));
    for (const [n, m] of rows) {
      console.log(n.padEnd(32) + [m.calls, m.unfilled, m.minGap, m.avgGap, m.le2, m.le3, m.movable, m.overCap]
        .map(v => String(v).padStart(9)).join(''));
    }
    console.log('\nobligatory optimizer stats:', JSON.stringify(opt.stats));
  }, 180_000);
});
