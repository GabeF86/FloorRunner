import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { solve } from './solve';
import { optimize } from './optimize';
import { loadGenerationContext } from './genContext';
import { statedWorkingDaysCap, requiredWorkDaysWithLimit } from './workDays';
import { buildCallCaps, planWithinCallCaps, computeProviderCapSummary } from './providerCaps';
import { buildFixtureContext, buildCtx, prov, callSlot } from './__fixtures__/buildContext';
import { makeFakeSupabase, type TableCfg } from './__fixtures__/fakeSupabase';
import { CLASSIC_PATTERN, type CallPatternDoc } from './callPattern';

// ── Provider limits (2026-07-22, patch34) — engine caps ──────────────────────
// Per-code call caps are HARD CEILINGS for auto-generation: main loop, spans,
// pre-PTO and quota relaxation all refuse a placement that would push a
// provider past their stated max for that code (seeds count; block-chain
// admission is WHOLE-BLOCK at anchor time). Slots unfillable under caps stay
// OPEN with reason 'provider-cap' — never silently reassigned past a stated
// maximum. BLANK limits (absent field / absent entry / {}) fall back to the
// existing engine byte for byte (Gabriel, verbatim and binding).

const callsByPidCode = (plan: ReturnType<typeof solve>) => {
  const out = new Map<string, number>();
  for (const a of plan.assignments) {
    if (a.shift_type_category !== 'call') continue;
    const k = `${a.provider_id}|${a.shift_type_code}`;
    out.set(k, (out.get(k) || 0) + 1);
  }
  return out;
};

// ── BLANK-FALLBACK byte-identity pin (Gabriel's verbatim rule) ───────────────
describe('provider limits — blank fallback is byte-identical (pinned)', () => {
  const golden = readFileSync(
    join(__dirname, '__fixtures__', 'fillAllPlan.golden.json'), 'utf8',
  ).trimEnd();

  it('limits ABSENT reproduces the pinned plan byte for byte', () => {
    expect(JSON.stringify(solve(buildFixtureContext()), null, 2)).toBe(golden);
  });

  it('limits {} (empty map) reproduces the pinned plan byte for byte', () => {
    expect(JSON.stringify(solve(buildFixtureContext({ providerLimits: {} })), null, 2)).toBe(golden);
  });

  it('an entry with NO calls and NO day fields is inert too', () => {
    expect(JSON.stringify(solve(buildFixtureContext({ providerLimits: { p01: {} } })), null, 2)).toBe(golden);
  });
});

// ── main-loop per-code cap ───────────────────────────────────────────────────
describe('provider limits — per-code call caps in the main loop', () => {
  // Mon/Wed/Fri C1 (spaced so post-call blocks never interfere), one provider.
  const slots = [
    callSlot('mon', '2026-01-05', 'C1'),
    callSlot('wed', '2026-01-07', 'C1'),
    callSlot('fri', '2026-01-09', 'C1', 'friday'),
  ];

  it('a cap-hit provider stops receiving that code; the slot stays OPEN with provider-cap', () => {
    const ctx = buildCtx(slots, [prov('p1')], {
      providerLimits: { p1: { calls: { C1: 2 } } },
    });
    const plan = solve(ctx, { fillMode: 'all' });
    expect(callsByPidCode(plan).get('p1|C1')).toBe(2);
    expect(plan.unfilled).toHaveLength(1);
    expect(plan.unfilled[0].slot_id).toBe('fri');
    expect(plan.unfilled[0].reason).toBe('provider-cap');
    expect(plan.unfilled[0].candidates).toEqual([
      { provider_id: 'p1', provider_name: 'p1', reason: 'provider-cap' },
    ]);
  });

  it('control: without limits every slot fills', () => {
    const plan = solve(buildCtx(slots, [prov('p1')]), { fillMode: 'all' });
    expect(plan.unfilled).toHaveLength(0);
  });

  it('a stated cap BELOW the par-authoritative obligation still wins — caps are hard ceilings, obligations are targets (2026-07-24)', () => {
    // Par 1 → obligation = 3 slots / 1 × 1.0 = 3, but the stated C1 cap is 1:
    // the provider receives exactly 1 call in BOTH modes; the rest stay open
    // with the cap reason, never force-filled up to the obligation.
    const mk = () => buildCtx(slots, [prov('p1')], {
      parLevel: 1,
      providerLimits: { p1: { calls: { C1: 1 } } },
    });
    for (const fillMode of ['all', 'obligatory'] as const) {
      const plan = solve(mk(), { fillMode });
      expect(callsByPidCode(plan).get('p1|C1')).toBe(1);
      expect(plan.unfilled).toHaveLength(2);
      expect(plan.unfilled.every(u => u.reason === 'provider-cap')).toBe(true);
    }
  });

  it('a capped provider never strands a slot another provider can take', () => {
    // p2 carries heavy history so p1 would win BOTH slots on score; the cap
    // hands the second to p2 instead.
    const two = [callSlot('mon', '2026-01-05', 'C1'), callSlot('wed', '2026-01-07', 'C1')];
    const mk = (limits?: Record<string, { calls?: Record<string, number> }>) =>
      buildCtx(two, [prov('p1'), prov('p2')], {
        historicalAssignedByPid: new Map([['p2', new Map([['weekday|C1', 5]])]]),
        ...(limits ? { providerLimits: limits } : {}),
      });
    const control = solve(mk(), { fillMode: 'all' });
    const controlById = new Map(control.assignments.map(a => [a.slot_id, a.provider_id]));
    expect(controlById.get('mon')).toBe('p1');
    expect(controlById.get('wed')).toBe('p1');

    const plan = solve(mk({ p1: { calls: { C1: 1 } } }), { fillMode: 'all' });
    const byId = new Map(plan.assignments.map(a => [a.slot_id, a.provider_id]));
    expect(byId.get('mon')).toBe('p1');
    expect(byId.get('wed')).toBe('p2');
    expect(plan.unfilled).toHaveLength(0);
  });
});

// ── quota relaxation respects caps ───────────────────────────────────────────
describe('provider limits — quota relaxation never resurrects a capped provider', () => {
  const slot = callSlot('mon', '2026-01-05', 'C1');
  const mk = (withCap: boolean) => buildCtx([slot], [prov('p1')], {
    bucketTarget: new Map([['p1|weekday|C1', 0]]), // quota-blocked
    ...(withCap ? { providerLimits: { p1: { calls: { C1: 0 } } } } : {}),
  });

  it('control: relaxation fills the quota-blocked slot when no cap binds', () => {
    const plan = solve(mk(false), { fillMode: 'all' });
    expect(plan.assignments.find(a => a.slot_id === 'mon')?.source).toBe('quota-relaxed');
  });

  it('with a cap of 0 the slot stays open — provider-cap, never quota-relaxed', () => {
    const plan = solve(mk(true), { fillMode: 'all' });
    expect(plan.assignments).toHaveLength(0);
    expect(plan.unfilled).toHaveLength(1);
    expect(plan.unfilled[0].reason).toBe('provider-cap');
    expect(plan.unfilled[0].candidates).toEqual([
      { provider_id: 'p1', provider_name: 'p1', reason: 'provider-cap' },
    ]);
  });
});

// ── whole-block admission at the anchor ──────────────────────────────────────
describe('provider limits — block-chain admission is whole-block at anchor time', () => {
  // Classic Saturday chain: Sat C1 anchor → same provider takes Sun C2 + Fri
  // C2. A provider with C2 cap 1 cannot absorb the two designed C2 links, so
  // they are NOT admitted to the anchor — the next candidate takes the whole
  // block; the pairing is never severed halfway.
  const slots = [
    callSlot('satC1', '2026-01-10', 'C1', 'saturday'),
    callSlot('friC2', '2026-01-09', 'C2', 'friday'),
    callSlot('sunC2', '2026-01-11', 'C2', 'sunday'),
  ];

  it('control: without limits the score winner p1 takes anchor + both links', () => {
    const plan = solve(buildCtx(slots, [prov('p1'), prov('p2')]), { fillMode: 'all' });
    const byId = new Map(plan.assignments.map(a => [a.slot_id, a.provider_id]));
    expect(byId.get('satC1')).toBe('p1');
    expect(byId.get('friC2')).toBe('p1');
    expect(byId.get('sunC2')).toBe('p1');
  });

  it('C2 cap 1 refuses the anchor; the whole designed block goes to p2 intact', () => {
    const ctx = buildCtx(slots, [prov('p1'), prov('p2')], {
      providerLimits: { p1: { calls: { C2: 1 } } },
    });
    const plan = solve(ctx, { fillMode: 'all' });
    const byId = new Map(plan.assignments.map(a => [a.slot_id, a.provider_id]));
    expect(byId.get('satC1')).toBe('p2');
    expect(byId.get('friC2')).toBe('p2');
    expect(byId.get('sunC2')).toBe('p2');
    expect(plan.unfilled).toHaveLength(0);
    // No severance: the designed CALL pairing was never split. (The fixture
    // has no D1 slot after Sunday, so the C2→D1 day-chain records ordinary
    // 'no-slot' bookkeeping — that is invariant-4 recording, not severance.)
    expect(plan.skippedDerived!.filter(s => s.code.startsWith('C'))).toEqual([]);
  });
});

// ── seeds count toward caps ──────────────────────────────────────────────────
describe('provider limits — seeded call assignments consume the cap', () => {
  const mk = (withCap: boolean) => buildCtx(
    [callSlot('wed', '2026-01-07', 'C1')],
    [prov('p1')],
    {
      seedAssignments: [{
        slot_date: '2026-01-05', provider_id: 'p1',
        shift_type_code: 'C1', shift_type_category: 'call', derived_day_type: 'weekday',
      }],
      ...(withCap ? { providerLimits: { p1: { calls: { C1: 1 } } } } : {}),
    },
  );

  it('a seed at the cap blocks further auto-placements of that code', () => {
    const plan = solve(mk(true), { fillMode: 'all' });
    expect(plan.assignments).toHaveLength(0);
    expect(plan.unfilled).toHaveLength(1);
    expect(plan.unfilled[0].reason).toBe('provider-cap');
  });

  it('control: without the cap the seeded provider takes the second call', () => {
    const plan = solve(mk(false), { fillMode: 'all' });
    expect(plan.assignments.find(a => a.slot_id === 'wed')?.provider_id).toBe('p1');
  });
});

// ── pre-PTO pass respects caps ───────────────────────────────────────────────
describe('provider limits — the pre-PTO Thursday pass respects call caps', () => {
  const slots = [callSlot('thuC1', '2026-01-08', 'C1')];
  const availByPid = new Map([['p1', [{
    availability_type: 'pto', start_date: '2026-01-12', end_date: '2026-01-16',
    approval_status: 'approved',
  }]]]);
  const mk = (withCap: boolean) => buildCtx(slots, [prov('p1'), prov('p2')], {
    availByPid,
    ...(withCap ? { providerLimits: { p1: { calls: { C1: 0 } } } } : {}),
  });

  it('control: PTO-bound p1 takes the pre-PTO Thursday', () => {
    const a = solve(mk(false), { fillMode: 'all' }).assignments.find(x => x.slot_id === 'thuC1');
    expect(a?.provider_id).toBe('p1');
    expect(a?.source).toBe('pre-pto-thursday');
  });

  it('a C1 cap of 0 skips the pre-PTO placement; the main loop fills p2', () => {
    const a = solve(mk(true), { fillMode: 'all' }).assignments.find(x => x.slot_id === 'thuC1');
    expect(a?.provider_id).toBe('p2');
    expect(a?.source).toBe('main-loop');
  });
});

// ── spans respect caps atomically ────────────────────────────────────────────
describe('provider limits — spans are admitted whole against caps', () => {
  const spanDoc: CallPatternDoc = {
    ...CLASSIC_PATTERN,
    blocks: [],
    spans: [{ code: 'C1', anchorDayType: 'friday', offsets: [0, 1] }],
  };
  const slots = [
    callSlot('friC1', '2026-01-09', 'C1', 'friday'),
    callSlot('satC1', '2026-01-10', 'C1', 'saturday'),
  ];

  it('the span goes to a provider with cap room for every covered call slot', () => {
    const ctx = buildCtx(slots, [prov('p1'), prov('p2')], {
      callPattern: spanDoc,
      providerLimits: { p1: { calls: { C1: 1 } } },
    });
    const plan = solve(ctx, { fillMode: 'all' });
    const byId = new Map(plan.assignments.map(a => [a.slot_id, a.provider_id]));
    expect(byId.get('friC1')).toBe('p2');
    expect(byId.get('satC1')).toBe('p2');
  });

  it('when everyone is capped below the span it severs to capped individual fills', () => {
    const ctx = buildCtx(slots, [prov('p1'), prov('p2')], {
      callPattern: spanDoc,
      providerLimits: { p1: { calls: { C1: 1 } }, p2: { calls: { C1: 1 } } },
    });
    const plan = solve(ctx, { fillMode: 'all' });
    const spanUnfilled = plan.unfilled.filter(u => u.reason === 'provider-cap');
    expect(spanUnfilled.map(u => u.slot_id).sort()).toEqual(['friC1', 'satC1']);
    for (const [, n] of callsByPidCode(plan)) expect(n).toBeLessThanOrEqual(1);
  });
});

// ── the optimizer may not move calls past a cap ──────────────────────────────
describe('provider limits — optimizer trials are rejected when they violate caps', () => {
  it('a fairness swap onto a capped provider is refused (final plan stays cap-clean)', () => {
    // Greedy: p1 capped at 0 C1 → both calls to p2 (stdev high). A swap to p1
    // strictly improves fairness — but the pin path ('call-no-quota') bypasses
    // caps inside the trial, so acceptance must reject the trial itself.
    const ctx = buildCtx(
      [callSlot('mon', '2026-01-05', 'C1'), callSlot('wed', '2026-01-07', 'C1')],
      [prov('p1'), prov('p2')],
      { providerLimits: { p1: { calls: { C1: 0 } } } },
    );
    const { plan } = optimize(ctx);
    expect(plan.assignments.filter(a => a.provider_id === 'p1' && a.shift_type_category === 'call')).toHaveLength(0);
    expect(callsByPidCode(plan).get('p2|C1')).toBe(2);
  });
});

// ── pure cap helpers ─────────────────────────────────────────────────────────
describe('buildCallCaps / planWithinCallCaps / computeProviderCapSummary', () => {
  it('buildCallCaps ignores entries without calls and returns null when empty', () => {
    expect(buildCallCaps(undefined)).toBeNull();
    expect(buildCallCaps({})).toBeNull();
    expect(buildCallCaps({ p1: { workingDays: 10 } })).toBeNull();
    const caps = buildCallCaps({ p1: { calls: { C1: 2 } } })!;
    expect(caps.get('p1')!.get('C1')).toBe(2);
  });

  it('planWithinCallCaps counts plan + seed calls per code', () => {
    const caps = buildCallCaps({ p1: { calls: { C1: 1 } } })!;
    const seed = {
      slot_date: '2026-01-05', provider_id: 'p1',
      shift_type_code: 'C1', shift_type_category: 'call', derived_day_type: 'weekday',
    };
    const planAt = (n: number) => ({
      assignments: Array.from({ length: n }, (_, i) => ({
        slot_id: `s${i}`, slot_date: `2026-01-0${6 + i}`, shift_type_code: 'C1',
        shift_type_category: 'call', derived_day_type: 'weekday',
        provider_id: 'p1', provider_name: 'p1', existing_assignment_id: null,
        source: 'main-loop' as const,
      })),
      unfilled: [],
    });
    expect(planWithinCallCaps(caps, planAt(0), [seed])).toBe(true);   // 1 seed ≤ 1
    expect(planWithinCallCaps(caps, planAt(1), [seed])).toBe(false);  // 2 > 1
    expect(planWithinCallCaps(caps, planAt(1), [])).toBe(true);       // 1 ≤ 1
  });

  it('computeProviderCapSummary reports placed-vs-cap per stated code + capped open slots', () => {
    const ctx = buildCtx(
      [callSlot('mon', '2026-01-05', 'C1'), callSlot('wed', '2026-01-07', 'C1')],
      [prov('p1')],
      { providerLimits: { p1: { calls: { C1: 1 } } } },
    );
    const plan = solve(ctx, { fillMode: 'all' });
    const summary = computeProviderCapSummary(ctx, plan)!;
    expect(summary.rows).toEqual([
      { provider_id: 'p1', provider_name: 'p1', code: 'C1', cap: 1, placed: 1 },
    ]);
    expect(summary.cappedUnfilled).toBe(1);
  });

  it('computeProviderCapSummary is null when no call caps are stated', () => {
    const ctx = buildCtx([callSlot('mon', '2026-01-05', 'C1')], [prov('p1')]);
    expect(computeProviderCapSummary(ctx, solve(ctx))).toBeNull();
  });

  it('cappedUnfilled counts only DISTINCT truly-open slots (span fallback honesty)', () => {
    // Everyone capped below the span: the spans pass reports BOTH slots with
    // 'provider-cap', then the severed-span fallback lets the main loop fill
    // them individually (one C1 each — within caps). The unfilled list keeps
    // the span-level entries (pre-existing fallback semantics), but the banner
    // claims "left open at a stated maximum" — so cappedUnfilled must count
    // only slots that truly ended open, deduped: here 0 (review fix 2026-07-22).
    const spanDoc: CallPatternDoc = {
      ...CLASSIC_PATTERN,
      blocks: [],
      spans: [{ code: 'C1', anchorDayType: 'friday', offsets: [0, 1] }],
    };
    const ctx = buildCtx(
      [callSlot('friC1', '2026-01-09', 'C1', 'friday'), callSlot('satC1', '2026-01-10', 'C1', 'saturday')],
      [prov('p1'), prov('p2')],
      { callPattern: spanDoc, providerLimits: { p1: { calls: { C1: 1 } }, p2: { calls: { C1: 1 } } } },
    );
    const plan = solve(ctx, { fillMode: 'all' });
    // Both slots DID fill individually under caps...
    expect(new Set(plan.assignments.map(a => a.slot_id))).toEqual(new Set(['friC1', 'satC1']));
    // ...while the span-level provider-cap entries remain in unfilled.
    expect(plan.unfilled.filter(u => u.reason === 'provider-cap').length).toBeGreaterThan(0);
    // The summary must not call filled slots "left open".
    expect(computeProviderCapSummary(ctx, plan)!.cappedUnfilled).toBe(0);
  });
});

// ── working-days override (single-homed in workDays.ts) ──────────────────────
describe('statedWorkingDaysCap / requiredWorkDaysWithLimit', () => {
  it('workingDays entry IS the required count (as entered)', () => {
    expect(statedWorkingDaysCap({ workingDays: 12 }, 20, 3)).toBe(12);
    expect(requiredWorkDaysWithLimit(1, 20, 3, { workingDays: 12 })).toBe(12);
  });

  it('daysOff re-derives against the same netting: WD − pto − daysOff', () => {
    expect(statedWorkingDaysCap({ daysOff: 4 }, 20, 3)).toBe(13);
    expect(requiredWorkDaysWithLimit(1, 20, 3, { daysOff: 4 })).toBe(13);
    // floors at 0
    expect(statedWorkingDaysCap({ daysOff: 30 }, 20, 3)).toBe(0);
  });

  it('BLANK falls back to the FTE-derived budget (verbatim rule)', () => {
    expect(statedWorkingDaysCap(undefined, 20, 3)).toBeNull();
    expect(statedWorkingDaysCap({}, 20, 3)).toBeNull();
    expect(requiredWorkDaysWithLimit(1, 20, 3, undefined)).toBe(17); // round(1×20) − 3
    expect(requiredWorkDaysWithLimit(0.5, 20, 0, {})).toBe(10);
  });
});

// ── genContext loads limits + applies the workday override ───────────────────
describe('loadGenerationContext — provider_limits', () => {
  // May 2026 block (Fri 5/22 → Fri 5/29): 6 weekdays minus Memorial Day 5/25
  // = 5 working days. p1 PTO Tue 5/26 + Wed 5/27 nets 2.
  const rawSlot = (id: string, date: string, dayType = 'weekday') => ({
    id, slot_date: date, shift_type_id: 'st-C1', provider_group: 'physician',
    required_count: 1, locked: false, derived_day_type: dayType, site_id: 'site1',
    shift_types: { code: 'C1', category: 'call' }, assignments: [],
  });
  const budgetSlots = [
    rawSlot('m22', '2026-05-22', 'friday'),
    rawSlot('m25', '2026-05-25', 'major_holiday'),
    rawSlot('m26', '2026-05-26'),
    rawSlot('m27', '2026-05-27'),
    rawSlot('m28', '2026-05-28'),
    rawSlot('m29', '2026-05-29', 'friday'),
  ];
  const baseTables = (over: Record<string, TableCfg> = {}): Record<string, TableCfg> => ({
    schedule_slots: { data: budgetSlots, error: null },
    schedule_versions: { data: { schedule_id: 'sched1' }, error: null },
    sites: { data: { call_par_level: 1, organization_id: 'org1' }, error: null },
    holiday_calendars: {
      data: [{ holiday_date: '2026-05-25', holiday_name: 'Memorial Day', is_major_holiday: true }],
      error: null,
    },
    shift_types: { data: [{ code: 'C1', category: 'call', call_rank: 0, relief_rank: null, is_overlay: false, generation_engine: 'call', requires_post_call_rule: true, call_coverage_type: null }], error: null },
    call_patterns: { data: null, error: null },
    provider_employment_profiles: { data: [
      { provider_id: 'p1', fte_value: 1.0, home_site_id: 'site1', call_taker: true, partial_call_taker: false, available_weekdays: null },
      { provider_id: 'p2', fte_value: 0.5, home_site_id: 'site1', call_taker: true, partial_call_taker: false, available_weekdays: null },
    ], error: null },
    providers: { data: [
      { id: 'p1', provider_type: 'physician', short_display_name: 'DOCA', status: 'active' },
      { id: 'p2', provider_type: 'physician', short_display_name: 'DOCB', status: 'active' },
    ], error: null },
    provider_site_credentials: { data: [], error: null },
    provider_availability: { data: [
      { provider_id: 'p1', availability_type: 'pto', start_date: '2026-05-26', end_date: '2026-05-27', approval_status: 'approved' },
    ], error: null },
    assignments: { data: [], error: null },
    ...over,
  });

  async function run(over: Record<string, TableCfg> = {}) {
    const { sb } = makeFakeSupabase({ tables: baseTables(over) });
    return loadGenerationContext(sb, 'ver1');
  }

  it('loads + parses limits and overrides required for both entry modes', async () => {
    const res = await run({
      schedules: { data: { provider_limits: {
        p1: { daysOff: 1, calls: { C1: 2 } },   // required = 5 − 2 pto − 1 = 2 (default would be 3)
        p2: { workingDays: 1 },                  // required = 1 as entered (default would be 3)
      } }, error: null },
    });
    expect(res.ctx).toBeTruthy();
    expect(res.ctx!.providerLimits).toEqual({
      p1: { daysOff: 1, calls: { C1: 2 } },
      p2: { workingDays: 1 },
    });
    const b = res.ctx!.workDayBudget!;
    expect(b.byProvider.get('p1')!.required).toBe(2);
    expect(b.byProvider.get('p2')!.required).toBe(1);
  });

  it('BLANK entries keep the FTE-derived budget untouched (verbatim rule)', async () => {
    const res = await run({ schedules: { data: { provider_limits: null }, error: null } });
    expect(res.ctx!.providerLimits).toBeUndefined();
    const b = res.ctx!.workDayBudget!;
    expect(b.byProvider.get('p1')!.required).toBe(3); // round(1×5) − 2
    expect(b.byProvider.get('p2')!.required).toBe(3); // round(0.5×5)
  });

  it('a missing provider_limits column (pre-patch34) degrades silently to no limits', async () => {
    const res = await run({
      schedules: { data: null, error: { message: 'column schedules.provider_limits does not exist' } },
    });
    expect(res.ctx).toBeTruthy();
    expect(res.ctx!.providerLimits).toBeUndefined();
    expect(res.ctx!.workDayBudget!.byProvider.get('p1')!.required).toBe(3);
    expect((res.ctx!.warnings ?? []).some(w => /provider_limits/.test(w))).toBe(false);
  });

  it('malformed stored limits are IGNORED with a warning (never a crash, never partial caps)', async () => {
    const res = await run({
      schedules: { data: { provider_limits: { p1: { calls: { C1: -1 } } } }, error: null },
    });
    expect(res.ctx).toBeTruthy();
    expect(res.ctx!.providerLimits).toBeUndefined();
    expect((res.ctx!.warnings ?? []).some(w => /provider_limits/.test(w))).toBe(true);
  });
});
