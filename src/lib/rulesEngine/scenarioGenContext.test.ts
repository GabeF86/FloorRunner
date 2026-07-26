// genContext scenario loading (patch37): schedules.scenario_manifest →
// projectScenario → ctx.scenario + the scenario-FTE provider projection +
// the stated-target bucketTarget override. Degradation: pre-patch37 column
// silently absent; invalid manifests warn loudly and generate scenario-free.
// The MASTER employment profile is never written — pinned here.
import { describe, it, expect } from 'vitest';
import { loadGenerationContext } from './genContext';
import { makeFakeSupabase, type TableCfg, type Filter } from './__fixtures__/fakeSupabase';

const rawSlot = (id: string, date: string, dayType = 'weekday') => ({
  id, slot_date: date, shift_type_id: 'st-C1', provider_group: 'physician',
  required_count: 1, locked: false, derived_day_type: dayType, site_id: 'site1',
  shift_types: { code: 'C1', category: 'call' }, assignments: [],
});
const slots = [
  rawSlot('m10', '2026-08-10'),
  rawSlot('m11', '2026-08-11'),
  rawSlot('f14', '2026-08-14', 'friday'),
];

// The manifest's targets record is EXHAUSTIVE over the 9 bucket keys (the
// phase-1 importer always emits all of them; zod enforces it).
const fullTargets = (over: Record<string, number> = {}) => ({
  MTH_C1: 0, MTH_C2: 0, FRI_C1: 0, FRI_C2: 0,
  SAT_C1: 0, SAT_C2: 0, SUN_C1: 0, SUN_C2: 0, NEURO_FSS: 0,
  ...over,
});
function manifestWith(providers: unknown[]): unknown {
  return {
    manifestVersion: 1,
    generatedAt: '2026-07-26T00:00:00.000Z',
    source: { workbook: 'test.xlsx', sheetName: 'Sheet4', shape: 'full' },
    defaultYear: 2026,
    callCodeLegend: {},
    checksums: {
      computed: { providerRows: providers.length, totalFte: 1, targets: fullTargets() },
      expected: null, comparisons: [], ok: null,
    },
    providers,
    warnings: [],
    errors: [],
  };
}
const manifestProvider = (over: Record<string, unknown> = {}) => ({
  providerId: 'p1', sourceName: 'DOCA', normalizedName: 'doca', scenarioFte: 0.5,
  targets: fullTargets({ MTH_C1: 2, SAT_C2: 0.5 }),
  prohibitions: [], fixedAssignments: [], linkages: [], preferences: [],
  sourceText: { noCall: null, mandatory: null }, warnings: [], conflicts: [],
  ...over,
});

const baseTables = (over: Record<string, TableCfg> = {}): Record<string, TableCfg> => ({
  schedule_slots: { data: slots, error: null },
  schedule_versions: { data: { schedule_id: 'sched1' }, error: null },
  sites: { data: { call_par_level: 12, organization_id: 'org1' }, error: null },
  holiday_calendars: { data: [], error: null },
  shift_types: { data: [
    { code: 'C1', category: 'call', call_rank: 0, relief_rank: null, is_overlay: false, generation_engine: 'call', requires_post_call_rule: true, call_coverage_type: null },
    { code: 'C2', category: 'call', call_rank: 1, relief_rank: null, is_overlay: false, generation_engine: 'call', requires_post_call_rule: false, call_coverage_type: null },
    { code: 'C3', category: 'call', call_rank: 2, relief_rank: null, is_overlay: true, generation_engine: 'call', requires_post_call_rule: false, call_coverage_type: null },
  ], error: null },
  call_patterns: { data: null, error: null },
  provider_employment_profiles: { data: [
    { provider_id: 'p1', fte_value: 1.0, home_site_id: 'site1', call_taker: true, partial_call_taker: false, available_weekdays: null },
    { provider_id: 'p2', fte_value: 1.0, home_site_id: 'site1', call_taker: true, partial_call_taker: false, available_weekdays: null },
  ], error: null },
  providers: { data: [
    { id: 'p1', provider_type: 'physician', short_display_name: 'DOCA', status: 'active' },
    { id: 'p2', provider_type: 'physician', short_display_name: 'DOCB', status: 'active' },
  ], error: null },
  provider_site_credentials: { data: [], error: null },
  provider_availability: { data: [], error: null },
  assignments: { data: [], error: null },
  ...over,
});

async function run(over: Record<string, TableCfg> = {}) {
  const { sb, calls } = makeFakeSupabase({ tables: baseTables(over) });
  const res = await loadGenerationContext(sb, 'ver1');
  return { res, calls };
}

describe('loadGenerationContext — scenario_manifest (patch37)', () => {
  it('projects the stored manifest: ctx.scenario, scenario-FTE provider projection, stated bucket targets', async () => {
    const { res, calls } = await run({
      schedules: { data: { provider_limits: null, scenario_manifest: manifestWith([manifestProvider()]) }, error: null },
    });
    expect(res.ctx).toBeTruthy();
    const ctx = res.ctx!;
    expect(ctx.scenario).toBeTruthy();
    expect(ctx.scenario!.providers.get('p1')!.targets.get('MTH|C1')).toBe(2);

    // Scenario FTE override — projection only, with an audit warning.
    expect(ctx.providers.find(p => p.id === 'p1')!.fte_value).toBe(0.5);
    expect(ctx.providers.find(p => p.id === 'p2')!.fte_value).toBe(1.0);
    expect(ctx.workDayBudget!.byProvider.get('p1')!.fte).toBe(0.5);
    expect((ctx.warnings ?? []).some(w => /Scenario FTE override/.test(w) && /DOCA/.test(w))).toBe(true);

    // MASTER NEVER WRITTEN: no write method ever touched the profiles table
    // (or any table — the loader is read-only by construction).
    const writes = calls.filter(c => ['update', 'upsert', 'insert', 'delete'].includes(c.method));
    expect(writes).toEqual([]);

    // Stated targets replace the FTE-derived quota targets — exact,
    // unfloored (SAT|C2 0.5 survives as 0.5).
    expect(ctx.bucketTarget.get('p1|weekday|C1')).toBe(2);
    expect(ctx.bucketTarget.get('p1|saturday|C2')).toBe(0.5);
    // Non-manifest provider keeps the floored FTE-derived target.
    expect(ctx.bucketTarget.get('p2|weekday|C1')!).toBeGreaterThanOrEqual(1);
  });

  it('pre-patch37 (missing column) degrades SILENTLY via the narrow retry — provider_limits still load', async () => {
    const { res } = await run({
      schedules: (filters: Filter[]) => {
        const sel = filters.find(f => f.method === 'select');
        if (sel && String(sel.args[0]).includes('scenario_manifest')) {
          return { data: null, error: { message: 'column schedules.scenario_manifest does not exist' } };
        }
        return { data: { provider_limits: { p1: { calls: { C1: 2 } } } }, error: null };
      },
    });
    expect(res.ctx).toBeTruthy();
    expect(res.ctx!.scenario).toBeUndefined();
    expect(res.ctx!.providerLimits).toEqual({ p1: { calls: { C1: 2 } } });
    expect((res.ctx!.warnings ?? []).some(w => /scenario/i.test(w))).toBe(false);
  });

  it('an invalid stored manifest warns LOUDLY and generates scenario-free', async () => {
    const { res } = await run({
      schedules: { data: { provider_limits: null, scenario_manifest: { garbage: true } }, error: null },
    });
    expect(res.ctx!.scenario).toBeUndefined();
    expect((res.ctx!.warnings ?? []).some(w => /Scenario manifest failed validation/.test(w))).toBe(true);
  });

  it('a manifest provider outside the pool is skipped with a warning; the rest still project', async () => {
    const { res } = await run({
      schedules: { data: { provider_limits: null, scenario_manifest: manifestWith([
        manifestProvider(),
        manifestProvider({ providerId: 'ghost', sourceName: 'Ghost', normalizedName: 'ghost' }),
      ]) }, error: null },
    });
    expect(res.ctx!.scenario!.providers.size).toBe(1);
    expect((res.ctx!.warnings ?? []).some(w => /Ghost/.test(w) && /pool/i.test(w))).toBe(true);
  });
});
