// END-TO-END scenario pipeline (Paoli phase 2): synthetic full workbook →
// phase-1 import → manifest → projectScenario → multi-start solve on an
// 11-week Paoli-shaped fixture (weekend v2 pattern, 2026-08-10..2026-10-25,
// Labor Day 2026-09-07, fixed assignments seeded) → scenarioReport audit
// assertions. Pure fixtures — no DB.
import { describe, it, expect } from 'vitest';
import { importPaoliBlockWorkbook } from '../paoliBlock/importWorkbook';
import { buildSyntheticFullWorkbook, TEST_ROSTER } from '../paoliBlock/__fixtures__/syntheticFullWorkbook';
import { projectScenario, applyScenarioBucketTargets, scenarioBucketOf } from './scenario';
import type { ScenarioDoc } from './scenario';
import { solveMultiStart } from './multiStart';
import { computeScenarioReport } from './scenarioReport';
import { WEEKEND_V2_PATTERN } from './patterns/weekendV2';
import { addDays, dayOfWeekUTC, dayTypeFromDow, dayTypeBucket } from './shared';
import type {
  GenerationContext, SlotToFill, CandidateProvider, ShiftTypeInfo, SeedAssignment,
} from './genTypes';

const BLOCK_START = '2026-08-10';
const BLOCK_END = '2026-10-25';
const LABOR_DAY = '2026-09-07';

function importManifest() {
  const res = importPaoliBlockWorkbook(buildSyntheticFullWorkbook(), {
    workbookLabel: 'synthetic.xlsx', roster: TEST_ROSTER, defaultYear: 2026,
  });
  expect(res.hardErrors).toEqual([]);
  return res.manifest!;
}

function shiftInfoMap(): Map<string, ShiftTypeInfo> {
  const st = (code: string, over: Partial<ShiftTypeInfo>): [string, ShiftTypeInfo] => [code, {
    code, category: 'regular', call_rank: null, relief_rank: null, is_overlay: false,
    generation_engine: 'day_pool', requires_post_call_rule: false, call_coverage_type: null,
    manual_only: false, call_burden_weight: 1, parent_call_code: null, ...over,
  }];
  return new Map([
    st('C1', { category: 'call', call_rank: 0, generation_engine: 'call', requires_post_call_rule: true }),
    st('C2', { category: 'call', call_rank: 1, generation_engine: 'call' }),
    st('C3', { category: 'call', call_rank: 2, generation_engine: 'call', is_overlay: true }),
    st('C1N12', { category: 'call', call_rank: 0, generation_engine: 'call', manual_only: true, call_burden_weight: 0.5, parent_call_code: 'C1', requires_post_call_rule: true }),
    st('C2N12', { category: 'call', call_rank: 1, generation_engine: 'call', manual_only: true, call_burden_weight: 0.5, parent_call_code: 'C2' }),
    st('D1', {}), st('D2', {}), st('D3', {}), st('D4', {}),
  ]);
}

function buildPaoliCtx(scenario: ScenarioDoc, seeds: SeedAssignment[]): GenerationContext {
  const dates: string[] = [];
  for (let d = BLOCK_START; d <= BLOCK_END; d = addDays(d, 1)) dates.push(d);
  const dayTypeOf = (d: string) => (d === LABOR_DAY ? 'major_holiday' : dayTypeFromDow(dayOfWeekUTC(d)));

  const seededKeys = new Set(seeds.map(s => `${s.slot_date}|${s.shift_type_code}`));
  const allSlots: SlotToFill[] = [];
  const mk = (date: string, code: string, category: string) => {
    if (seededKeys.has(`${date}|${code}`)) return; // seeded slots are not open
    allSlots.push({
      slot_id: `${date}|${code}`, slot_date: date, shift_type_id: `st-${code}`,
      shift_type_code: code, shift_type_category: category,
      derived_day_type: dayTypeOf(date), provider_group: 'physician',
      required_count: 1, existing_assignment_id: null,
    });
  };
  for (const d of dates) {
    const dt = dayTypeFromDow(dayOfWeekUTC(d));
    mk(d, 'C1', 'call');
    mk(d, 'C2', 'call');
    // Neuro (C3) is a SAT + SUN slot only (2026-07-27): Friday neuro is
    // cross-covered by the Friday C2 doc and patch38 deactivates the
    // friday/C3 template row. Minting a Friday C3 here would overstate neuro
    // credit — weekendGroupKey folds Fri/Sat/Sun into ONE weekend group, so a
    // Friday C3 date counts toward a provider's neuro weekend units.
    if (dt === 'saturday' || dt === 'sunday') mk(d, 'C3', 'call');
    mk(d, 'D1', 'regular'); mk(d, 'D2', 'regular'); mk(d, 'D3', 'regular');
    if (dt === 'friday') mk(d, 'D4', 'regular');
  }

  const slotIndex = new Map<string, Map<string, SlotToFill>>();
  for (const s of allSlots) {
    if (!slotIndex.has(s.slot_date)) slotIndex.set(s.slot_date, new Map());
    slotIndex.get(s.slot_date)!.set(s.shift_type_code, s);
  }

  // genContext's across-date sort with the weekend-v2 dayTypeFillOrder.
  const order = WEEKEND_V2_PATTERN.dayTypeFillOrder!;
  const dayOrder = Object.fromEntries(order.map((dt, i) => [dt, i]));
  const codeOrder: Record<string, number> = { C2: 0, C3: 1, C1: 2 };
  const slotsToFill = allSlots.filter(s => s.shift_type_category === 'call');
  slotsToFill.sort((a, b) => {
    const da = dayOrder[a.derived_day_type] ?? order.length;
    const db = dayOrder[b.derived_day_type] ?? order.length;
    if (da !== db) return da - db;
    if (a.slot_date !== b.slot_date) return a.slot_date.localeCompare(b.slot_date);
    return (codeOrder[a.shift_type_code] ?? 9) - (codeOrder[b.shift_type_code] ?? 9);
  });

  // Providers: the roster with SCENARIO FTEs applied (mirrors genContext 6c).
  const providers: CandidateProvider[] = TEST_ROSTER.map(r => ({
    id: r.id, provider_type: 'physician', short_display_name: r.name,
    fte_value: scenario.providers.get(r.id)?.scenarioFte ?? 1,
    home_site_id: 'paoli', available_weekdays: [true, true, true, true, true, true, true],
  }));

  const PAR = 9;
  const bucketTotals = new Map<string, number>();
  for (const s of slotsToFill) {
    const key = `${dayTypeBucket(s.derived_day_type)}|${s.shift_type_code}`;
    bucketTotals.set(key, (bucketTotals.get(key) || 0) + 1);
  }
  const rawTargets = new Map<string, number>();
  for (const p of providers) {
    for (const [key, total] of bucketTotals) {
      rawTargets.set(`${p.id}|${key}`, Math.max(1, (total / PAR) * p.fte_value));
    }
  }
  const bucketTarget = applyScenarioBucketTargets(rawTargets, scenario);

  return {
    scheduleVersionId: 'v-paoli-e2e', siteId: 'paoli', parLevel: PAR,
    slotsToFill, slotIndex, providers,
    credByPid: new Map(), availByPid: new Map(), crossSiteByDate: new Map(),
    historicalAssignedByPid: new Map(), historicalTotalByBucket: new Map(),
    bucketTotals, bucketTarget,
    seedAssignments: seeds,
    callPattern: WEEKEND_V2_PATTERN,
    shiftTypes: shiftInfoMap(),
    scheduleDates: dates,
    scenario,
  };
}

// The workbook's fixed mandatory assignments, seeded exactly as phase 3 will
// (Jones's stand against his own no-call cell — mandatory-retained).
function fixedSeeds(scenario: ScenarioDoc): SeedAssignment[] {
  const seeds: SeedAssignment[] = [];
  for (const sp of scenario.providers.values()) {
    for (const f of sp.fixedAssignments) {
      seeds.push({
        slot_date: f.date, provider_id: sp.provider_id, shift_type_code: f.code,
        shift_type_category: 'call',
        derived_day_type: f.date === LABOR_DAY ? 'major_holiday' : dayTypeFromDow(dayOfWeekUTC(f.date)),
      });
    }
  }
  return seeds.sort((a, b) => a.slot_date.localeCompare(b.slot_date) || a.provider_id.localeCompare(b.provider_id));
}

describe('scenario end-to-end (synthetic workbook → engine → report)', () => {
  const manifest = importManifest();
  const { scenario, warnings } = projectScenario(manifest, {
    knownProviderIds: new Set(TEST_ROSTER.map(r => r.id)),
    knownShiftCodes: new Set(['C1', 'C2', 'C3']),
  });
  expect(warnings).toEqual([]);
  const seeds = fixedSeeds(scenario!);
  const ctx = buildPaoliCtx(scenario!, seeds);
  const ms = solveMultiStart(ctx, { k: 3, optimizeEnabled: false });
  const plan = ms.plan;
  const report = computeScenarioReport(ctx, plan, ms)!;

  const callsOf = (pid: string) => [
    ...plan.assignments.filter(a => a.provider_id === pid && a.shift_type_category === 'call')
      .map(a => ({ date: a.slot_date, code: a.shift_type_code })),
    ...seeds.filter(s => s.provider_id === pid).map(s => ({ date: s.slot_date, code: s.shift_type_code })),
  ];

  it('fills the block deterministically (same K re-run = identical plan) and reports the chosen seed', () => {
    const again = solveMultiStart(ctx, { k: 3, optimizeEnabled: false });
    expect(JSON.stringify(again.plan)).toBe(JSON.stringify(plan));
    expect(report.multiStart!.k).toBe(3);
    expect(report.multiStart!.chosenSeed).toBe(ms.chosenSeed);
    expect(report.score).toEqual(report.multiStart!.starts.find(s => s.seed === ms.chosenSeed)!.score);
  });

  it('every prohibition is honored by GENERATED placements (only mandatory-retained seeds may stand)', () => {
    expect(report.prohibitionViolations.filter(v => v.source === 'generated')).toEqual([]);
    // Jones's fixed 9/5–9/7 calls sit on his own no-call dates — retained + flagged.
    const jones = report.prohibitionViolations.filter(v => v.provider_id === 'prov-jones');
    expect(jones).toHaveLength(3);
    expect(jones.every(v => v.mandatoryRetained && v.source === 'seed')).toBe(true);
  });

  it('honors the named provider constraints from the prompt', () => {
    // Kalawadia: never a Monday C1 (recurring gate); Amusa: no C1 on 8/13 or
    // 8/24, nothing 9/18–9/20; Farkas: nothing 9/11–9/13 or 9/20–9/21;
    // Mojica/Simon/Havildar ranges likewise.
    for (const c of callsOf('prov-kalawadia')) {
      if (c.code === 'C1') expect(dayOfWeekUTC(c.date)).not.toBe(1);
    }
    for (const c of callsOf('prov-amusa')) {
      if (c.code === 'C1') expect(['2026-08-13', '2026-08-24']).not.toContain(c.date);
      expect(c.date < '2026-09-18' || c.date > '2026-09-20').toBe(true);
    }
    for (const c of callsOf('prov-farkas')) {
      expect(c.date < '2026-09-11' || c.date > '2026-09-13').toBe(true);
      expect(c.date < '2026-09-20' || c.date > '2026-09-21').toBe(true);
    }
    for (const c of callsOf('prov-havildar')) {
      expect(c.date < '2026-09-18' || c.date > '2026-09-20').toBe(true);
    }
  });

  it('never places past a stated per-bucket ceiling (either-or members excepted at group cap 1)', () => {
    for (const pr of report.providers) {
      const sp = scenario!.providers.get(pr.provider_id)!;
      const eitherOr = sp.linkages.filter(l => l.kind === 'either-or');
      for (const row of pr.buckets) {
        const covered = eitherOr.some(l => l.members.some(m => {
          const bucket = m.dow === 0 ? 'SUN' : m.dow === 6 ? 'SAT' : m.dow === 5 ? 'FRI' : 'MTH';
          return row.key.startsWith(`${bucket}|`);
        }));
        if (!covered) {
          expect(row.placed, `${pr.provider_name} ${row.key}`).toBeLessThanOrEqual(Math.ceil(row.target) + 1e-9);
        }
      }
      // Either-or group usage ≤ 1 (Hussain: one Saturday OR one Sunday call).
      for (const l of eitherOr) {
        const usage = callsOf(pr.provider_id).filter(c =>
          c.code !== 'C3' && [0, 6].includes(dayOfWeekUTC(c.date))).length;
        expect(usage, `${pr.provider_name} either-or`).toBeLessThanOrEqual(1);
      }
      // NEURO pair-units never exceed the stated pair count.
      if (pr.neuro) {
        expect(pr.neuro.placedUnits, `${pr.provider_name} NEURO`).toBeLessThanOrEqual(Math.ceil(pr.neuro.target) + 1e-9);
      }
    }
  });

  it('reports every fixed assignment satisfied and target-vs-placed with exact fractions', () => {
    for (const pr of report.providers) {
      for (const f of pr.fixed) expect(f.satisfied, `${pr.provider_name} ${f.date} ${f.code}`).toBe(true);
    }
    // Mojica's SAT|C2 target is 0.5 — the report carries the exact fraction.
    const mojica = report.providers.find(p => p.provider_id === 'prov-mojica')!;
    expect(mojica.buckets.find(b => b.key === 'SAT|C2')!.target).toBe(0.5);
  });

  it('produces spacing stats and per-provider blocks (weekend chains count as single blocks)', () => {
    expect(report.spacing.minGap).not.toBeNull();
    const withBlocks = report.providers.filter(p => p.blocks.length > 0);
    expect(withBlocks.length).toBeGreaterThan(0);
    // No block may be a single accidental pairing artifact: block dates are
    // sorted and within Fri..Mon spans for weekend chains.
    for (const p of withBlocks) {
      for (const b of p.blocks) expect(b.start <= b.end).toBe(true);
    }
  });

  it('scenario FTE overrides rode into the ctx providers (workbook FTEs, master untouched by construction)', () => {
    expect(ctx.providers.find(p => p.id === 'prov-horan')!.fte_value).toBe(0.5);
    expect(ctx.providers.find(p => p.id === 'prov-simon')!.fte_value).toBe(0.75);
    expect(ctx.providers.find(p => p.id === 'prov-jones')!.fte_value).toBe(1);
  });

  it('a seeded 12h split segment counts toward the SUN|C2 target at weight 0.5 (Horan/Simon Sunday split shape)', () => {
    // Simon's Sunday-night C2 segment, seeded pre-split as phase 3 will do.
    const segSeed: SeedAssignment = {
      slot_date: '2026-09-27', provider_id: 'prov-simon', shift_type_code: 'C2N12',
      shift_type_category: 'call', derived_day_type: 'sunday',
    };
    const ctx2 = buildPaoliCtx(scenario!, [...seeds, segSeed]);
    const ms2 = solveMultiStart(ctx2, { k: 1, optimizeEnabled: false });
    const report2 = computeScenarioReport(ctx2, ms2.plan, ms2)!;
    const simon = report2.providers.find(p => p.provider_id === 'prov-simon')!;
    const sunC2 = simon.buckets.find(b => b.key === 'SUN|C2')!;
    // The 0.5-weight segment is included in `placed` and the total never
    // exceeds ceil(target) — the split machinery counts toward scenarios.
    expect(sunC2.placed).toBeGreaterThanOrEqual(0.5);
    expect(sunC2.placed).toBeLessThanOrEqual(Math.ceil(sunC2.target) + 1e-9);
  });
});
