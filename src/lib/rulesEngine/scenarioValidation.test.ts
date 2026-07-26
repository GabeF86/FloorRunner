// Scenario prohibition SOFT flag (validation, patch37): a seeded/manual
// fixed assignment standing against a manifest prohibition is
// mandatory-retained — validation flags it (soft, never blocking) and the
// context loader degrades to feature-off on every pre-patch/failure shape.
import { describe, it, expect } from 'vitest';
import { evaluators } from './evaluators';
import { loadScenarioValidationCtx } from './loadContext';
import { makeFakeSupabase, type TableCfg } from './__fixtures__/fakeSupabase';
import { sp } from './__fixtures__/scenarioFixtures';
import type { EvaluationContext, ShiftTypeRow, RuleViolation } from './types';

const stRow = (code: string, category = 'call'): ShiftTypeRow => ({
  id: `st-${code}`, site_id: 's1', code, name: code, category,
  start_time: '07:00', end_time: '07:00', duration_hours: 24,
} as unknown as ShiftTypeRow);

function ctx(over: Partial<EvaluationContext> = {}): EvaluationContext {
  const types = [stRow('C1'), stRow('C2'), stRow('D1', 'regular')];
  return {
    slot: {
      id: 'slot1', site_id: 's1', slot_date: '2026-09-05',
      shift_type_id: 'st-C2', provider_group: 'physician', derived_day_type: 'saturday',
    },
    shiftType: types[1], providerId: 'prov-jones', providerGroup: 'physician',
    credentials: null, fte_value: 1, poolFlags: null,
    neighborAssignments: [], availability: [], sameDayAssignments: [],
    crossSiteAssignments: [], scheduleVersionId: 'v1', rules: [],
    shiftTypesByCode: new Map(types.map(t => [t.code, t])),
    shiftTypesById: new Map(types.map(t => [t.id, t])),
    ...over,
  } as EvaluationContext;
}

const jonesScenarioCtx = (): NonNullable<EvaluationContext['scenarioCtx']> => ({
  providers: new Map([['prov-jones', sp('prov-jones', {
    prohibitedAllDates: new Set(['2026-09-05', '2026-09-06', '2026-09-07']),
  })]]),
  neuroCode: 'C3',
});

const flags = (c: EvaluationContext): RuleViolation[] =>
  evaluators.flatMap(e => e(c)).filter(v => /Scenario no-call prohibition/.test(v.rule_name));

describe('scenarioProhibition evaluator', () => {
  it('SOFT-flags a call assignment on a prohibited date, naming the mandatory-retained precedence', () => {
    const v = flags(ctx({ scenarioCtx: jonesScenarioCtx() }));
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe('soft');
    expect(v[0].category).toBe('time_off');
    expect(v[0].message).toMatch(/mandatory-over-prohibition/);
  });

  it('is inert without scenarioCtx, off prohibited dates, for other providers, and for non-call shifts', () => {
    expect(flags(ctx())).toHaveLength(0);
    expect(flags(ctx({
      scenarioCtx: jonesScenarioCtx(),
      slot: { ...ctx().slot, slot_date: '2026-09-08' },
    }))).toHaveLength(0);
    expect(flags(ctx({ scenarioCtx: jonesScenarioCtx(), providerId: 'prov-lin' }))).toHaveLength(0);
    expect(flags(ctx({
      scenarioCtx: jonesScenarioCtx(),
      shiftType: stRow('D1', 'regular'),
    }))).toHaveLength(0);
  });
});

describe('loadScenarioValidationCtx', () => {
  const run = (tables: Record<string, TableCfg>) => {
    const { sb } = makeFakeSupabase({ tables });
    return loadScenarioValidationCtx(sb, 'ver1');
  };

  it('degrades to null on a missing column (pre-patch37), missing rows, and null manifests', async () => {
    expect((await run({
      schedule_versions: { data: { schedule_id: 'sched1' } },
      schedules: { data: null, error: { message: 'column schedules.scenario_manifest does not exist' } },
    })).ctx).toBeNull();
    expect((await run({
      schedule_versions: { data: null },
      schedules: { data: null },
    })).ctx).toBeNull();
    expect((await run({
      schedule_versions: { data: { schedule_id: 'sched1' } },
      schedules: { data: { scenario_manifest: null } },
    })).ctx).toBeNull();
    expect((await loadScenarioValidationCtx(makeFakeSupabase({}).sb, null)).ctx).toBeNull();
  });

  it('degrades to null (never a throw) on an INVALID stored manifest', async () => {
    const res = await run({
      schedule_versions: { data: { schedule_id: 'sched1' } },
      schedules: { data: { scenario_manifest: { garbage: true } } },
    });
    expect(res.ctx).toBeNull();
  });
});
