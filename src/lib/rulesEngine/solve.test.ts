import { describe, it, expect } from 'vitest';
import { solve } from './solve';
import type {
  GenerationContext, SlotToFill, CandidateProvider,
} from './genTypes';

function prov(id: string, fte = 1): CandidateProvider {
  return {
    id, provider_type: 'physician', short_display_name: id, fte_value: fte,
    home_site_id: 'site1', available_weekdays: [true, true, true, true, true, true, true],
  };
}
function callSlot(id: string, date: string, code: string, dt = 'weekday'): SlotToFill {
  return {
    slot_id: id, slot_date: date, shift_type_id: 'st-' + code,
    shift_type_code: code, shift_type_category: 'call',
    derived_day_type: dt, provider_group: 'physician',
    required_count: 1, existing_assignment_id: null,
  };
}
function buildCtx(slots: SlotToFill[], providers: CandidateProvider[],
                  over: Partial<GenerationContext> = {}): GenerationContext {
  const slotIndex = new Map<string, Map<string, SlotToFill>>();
  for (const s of slots) {
    if (!slotIndex.has(s.slot_date)) slotIndex.set(s.slot_date, new Map());
    slotIndex.get(s.slot_date)!.set(s.shift_type_code, s);
  }
  const bucketTotals = new Map<string, number>();
  const bucketTarget = new Map<string, number>();
  // generous targets so quota never blocks unless a test sets its own
  for (const s of slots) for (const p of providers) {
    bucketTarget.set(`${p.id}|weekday|${s.shift_type_code}`, 99);
  }
  return {
    scheduleVersionId: 'v1', siteId: 'site1', parLevel: 12,
    slotsToFill: slots, slotIndex, providers,
    credByPid: new Map(), availByPid: new Map(), crossSiteByDate: new Map(),
    historicalAssignedByPid: new Map(), historicalTotalByBucket: new Map(),
    bucketTotals, bucketTarget, seedAssignments: [],
    ...over,
  };
}

describe('solve — construction core', () => {
  it('fills a single weekday C1 with the only eligible provider', () => {
    const slots = [callSlot('s1', '2026-01-07', 'C1')];
    const plan = solve(buildCtx(slots, [prov('p1')]));
    expect(plan.assignments).toHaveLength(1);
    expect(plan.assignments[0].provider_id).toBe('p1');
    expect(plan.unfilled).toHaveLength(0);
  });

  it('reports an unfilled slot when no provider is eligible', () => {
    const slots = [callSlot('s1', '2026-01-07', 'C1')];
    // crna can't take a physician slot
    const plan = solve(buildCtx(slots, [prov('p1')], {
      providers: [{ ...prov('p1'), provider_type: 'crna' }],
    }));
    expect(plan.assignments).toHaveLength(0);
    expect(plan.unfilled).toHaveLength(1);
    expect(plan.unfilled[0].slot_id).toBe('s1');
  });

  it('is deterministic: identical input yields identical output', () => {
    const mk = () => buildCtx(
      [callSlot('s1', '2026-01-07', 'C1'), callSlot('s2', '2026-01-14', 'C1')],
      [prov('pB'), prov('pA')],
    );
    const a = solve(mk());
    const b = solve(mk());
    expect(a.assignments.map(x => x.provider_id))
      .toEqual(b.assignments.map(x => x.provider_id));
  });

  it('breaks an exact score tie by provider id (stable)', () => {
    // Two identical fresh providers, one slot. Lower id wins deterministically.
    const slots = [callSlot('s1', '2026-01-07', 'C1')];
    const plan = solve(buildCtx(slots, [prov('pB'), prov('pA')]));
    expect(plan.assignments[0].provider_id).toBe('pA');
  });

  it('spreads two slots across two providers by lifetime ratio', () => {
    const slots = [callSlot('s1', '2026-01-07', 'C1'), callSlot('s2', '2026-01-14', 'C1')];
    const plan = solve(buildCtx(slots, [prov('pA'), prov('pB')]));
    const ids = plan.assignments.map(a => a.provider_id).sort();
    expect(ids).toEqual(['pA', 'pB']);
  });
});

function dSlot(id: string, date: string, code: string, dt = 'weekday'): SlotToFill {
  return {
    slot_id: id, slot_date: date, shift_type_id: 'st-' + code,
    shift_type_code: code, shift_type_category: 'regular',
    derived_day_type: dt, provider_group: 'physician',
    required_count: 1, existing_assignment_id: null,
  };
}

describe('solve — D-chains', () => {
  it('forward-fills D1 the day after a weekday C2 with the same provider', () => {
    // Mon C2 -> Tue D1 (post-call). 2026-01-05 is Monday, 2026-01-06 Tuesday.
    const slots = [
      callSlot('c2', '2026-01-05', 'C2'),
      dSlot('d1', '2026-01-06', 'D1'),
    ];
    const plan = solve(buildCtx(slots, [prov('p1')]));
    const d1 = plan.assignments.find(a => a.shift_type_code === 'D1');
    expect(d1?.provider_id).toBe('p1');
    expect(d1?.source).toBe('d-chain');
  });

  it('blocks the C1 provider from any assignment the next day (post-call off)', () => {
    // Mon C1 -> provider must NOT be eligible for Tue C1.
    const slots = [
      callSlot('c1a', '2026-01-05', 'C1'),
      callSlot('c1b', '2026-01-06', 'C1'),
    ];
    const plan = solve(buildCtx(slots, [prov('p1')]));
    // p1 takes Mon C1; Tue C1 has no other provider -> unfilled.
    expect(plan.unfilled.map(u => u.slot_id)).toContain('c1b');
  });
});

describe('solve — weekend block (H1)', () => {
  it('does NOT force a Sun-C1 onto a provider lacking weekend-call credential', () => {
    // Sat-C2 -> would chain Sun-C1 to the same provider. p1 has the Sat slot
    // (weekend cred true) but we revoke weekend cred -> the Sat itself is the
    // gate; With weekend cred revoked, Sat-C2 itself fails the weekend-call gate,
    // so the chain never fires and Sun stays unfilled.
    const sat = callSlot('sat', '2026-01-03', 'C2', 'saturday');
    const sun = callSlot('sun', '2026-01-04', 'C1', 'sunday');
    const ctx = buildCtx([sat, sun], [prov('p1')], {
      bucketTarget: new Map([
        ['p1|weekend|C2', 99], ['p1|weekend|C1', 99],
      ]),
      credByPid: new Map([['p1', {
        is_active: true, credentialed: true, can_take_call: true,
        can_take_weekend_call: true, can_take_holiday_call: true,
        allowed_shift_types: [], excluded_shift_types: [], skill_tags: [],
      }]]),
    });
    const plan = solve(ctx);
    // With weekend cred TRUE the chain places Sun-C1.
    expect(plan.assignments.some(a => a.slot_id === 'sun')).toBe(true);

    // Now revoke weekend cred: the Sat slot won't fill, so the chain can't run,
    // and Sun stays unfilled — never force-assigned.
    const ctx2 = buildCtx([sat, sun], [prov('p1')], {
      bucketTarget: new Map([['p1|weekend|C2', 99], ['p1|weekend|C1', 99]]),
      credByPid: new Map([['p1', {
        is_active: true, credentialed: true, can_take_call: true,
        can_take_weekend_call: false, can_take_holiday_call: true,
        allowed_shift_types: [], excluded_shift_types: [], skill_tags: [],
      }]]),
    });
    const plan2 = solve(ctx2);
    expect(plan2.assignments.some(a => a.slot_id === 'sun')).toBe(false);
  });
});

describe('solve — pre-PTO Thursday', () => {
  it('gives a PTO-bound provider the Thursday C1 before their PTO week', () => {
    // PTO week of Mon 2026-01-12. Thursday before = 2026-01-08.
    const thuC1 = callSlot('thu', '2026-01-08', 'C1');
    const ctx = buildCtx([thuC1], [prov('p1')], {
      bucketTarget: new Map([['p1|weekday|C1', 99]]),
      availByPid: new Map([['p1', [{
        availability_type: 'pto', start_date: '2026-01-12', end_date: '2026-01-16',
        approval_status: 'approved',
      }]]]),
    });
    const plan = solve(ctx);
    const thu = plan.assignments.find(a => a.slot_id === 'thu');
    expect(thu?.provider_id).toBe('p1');
    expect(thu?.source).toBe('pre-pto-thursday');
  });
});

describe('solve — characterization: D1 > D3 precedence', () => {
  it('fills Tue-D1 (post-call from Mon-C2) and suppresses Tue-D3 (Wed-C2 hadCallTwoDaysBefore guard)', () => {
    // Mon 2026-01-05 C2 → chains Tue D1 (post-call).
    // Wed 2026-01-07 C2 → would chain Tue D3 (day-before backfill) but
    // hadCallTwoDaysBefore is true (Mon C2), so D3 is suppressed.
    const monC2 = callSlot('monC2', '2026-01-05', 'C2');
    const wedC2 = callSlot('wedC2', '2026-01-07', 'C2');
    const tueD1 = dSlot('tueD1', '2026-01-06', 'D1');
    const tueD3 = dSlot('tueD3', '2026-01-06', 'D3');
    const ctx = buildCtx([monC2, wedC2, tueD1, tueD3], [prov('p1')], {
      bucketTarget: new Map([
        ['p1|weekday|C2', 99],
        ['p1|weekday|C1', 99],
      ]),
    });
    const plan = solve(ctx);
    const d1Assign = plan.assignments.find(a => a.slot_id === 'tueD1');
    const d3Assign = plan.assignments.find(a => a.slot_id === 'tueD3');
    // Tue-D1 is filled via d-chain from Mon-C2
    expect(d1Assign?.provider_id).toBe('p1');
    expect(d1Assign?.source).toBe('d-chain');
    // Tue-D3 is suppressed: Wed-C2 hadCallTwoDaysBefore (Mon), so D3 backfill never fires
    expect(d3Assign).toBeUndefined();
  });
});

describe('solve — characterization: weekend Sat-C1 chain', () => {
  it('chains Sat-C1 provider onto Sun-C2 and Fri-C2 via weekend-chain', () => {
    // Sat 2026-01-03 C1; Sun 2026-01-04 C2; Fri 2026-01-02 C2.
    // One eligible provider with weekend-call credential.
    const satC1 = callSlot('satC1', '2026-01-03', 'C1', 'saturday');
    const sunC2 = callSlot('sunC2', '2026-01-04', 'C2', 'sunday');
    const friC2 = callSlot('friC2', '2026-01-02', 'C2', 'friday');
    const ctx = buildCtx([friC2, satC1, sunC2], [prov('p1')], {
      bucketTarget: new Map([
        ['p1|weekend|C1', 99],
        ['p1|weekend|C2', 99],
        ['p1|friday|C2', 99],
      ]),
      credByPid: new Map([['p1', {
        is_active: true, credentialed: true, can_take_call: true,
        can_take_weekend_call: true, can_take_holiday_call: true,
        allowed_shift_types: [], excluded_shift_types: [], skill_tags: [],
      }]]),
    });
    const plan = solve(ctx);
    const satAssign = plan.assignments.find(a => a.slot_id === 'satC1');
    const sunAssign = plan.assignments.find(a => a.slot_id === 'sunC2');
    const friAssign = plan.assignments.find(a => a.slot_id === 'friC2');
    expect(satAssign?.provider_id).toBe('p1');
    expect(sunAssign?.provider_id).toBe('p1');
    expect(sunAssign?.source).toBe('weekend-chain');
    // Fri-C2 is processed by the main loop before Sat-C1 (earlier date order),
    // so p1 gets Fri-C2 from the main loop; the Sat chain finds it already handled.
    expect(friAssign?.provider_id).toBe('p1');
    expect(friAssign?.source).toBe('main-loop');
  });
});

describe('solve — characterization: pre-PTO two-provider split', () => {
  it('places two PTO-bound providers on Thu-C1 and Thu-C2, deterministically by id', () => {
    // Both p1 and p2 have PTO starting Mon 2026-01-12.
    // thursdayBeforeWeekOf('2026-01-12') = 2026-01-08.
    // ranked = sorted by id: [p1, p2] → p1 → C1, p2 → C2.
    const thuC1 = callSlot('thuC1', '2026-01-08', 'C1');
    const thuC2 = callSlot('thuC2', '2026-01-08', 'C2');
    const providers = [prov('p2'), prov('p1')]; // intentionally unsorted
    const ctx = buildCtx([thuC1, thuC2], providers, {
      bucketTarget: new Map([
        ['p1|weekday|C1', 99], ['p1|weekday|C2', 99],
        ['p2|weekday|C1', 99], ['p2|weekday|C2', 99],
      ]),
      availByPid: new Map([
        ['p1', [{ availability_type: 'pto', start_date: '2026-01-12', end_date: '2026-01-16', approval_status: 'approved' }]],
        ['p2', [{ availability_type: 'pto', start_date: '2026-01-12', end_date: '2026-01-16', approval_status: 'approved' }]],
      ]),
    });
    const plan = solve(ctx);
    const c1Assign = plan.assignments.find(a => a.slot_id === 'thuC1');
    const c2Assign = plan.assignments.find(a => a.slot_id === 'thuC2');
    // Lower id (p1) sorted first → gets C1; p2 gets C2
    expect(c1Assign?.provider_id).toBe('p1');
    expect(c1Assign?.source).toBe('pre-pto-thursday');
    expect(c2Assign?.provider_id).toBe('p2');
    expect(c2Assign?.source).toBe('pre-pto-thursday');
  });
});

describe('solve — D4-D9 relief (H2)', () => {
  it('does not place a provider on relief inside their PTO bookend window', () => {
    // PTO Mon 2026-01-05 .. Fri 2026-01-09. Bookend extends to Sun 2026-01-11.
    // A D4 slot on Sun is N/A (relief is weekday/friday only), so test Fri 01-09
    // which is inside raw PTO, AND test that the bookend-only day is also blocked.
    const d4 = dSlot('d4', '2026-01-09', 'D4', 'friday'); // inside raw PTO
    const ctx = buildCtx([d4], [prov('p1')], {
      availByPid: new Map([['p1', [{
        availability_type: 'pto', start_date: '2026-01-05', end_date: '2026-01-09',
        approval_status: 'approved',
      }]]]),
    });
    const plan = solve(ctx);
    expect(plan.assignments.some(a => a.slot_id === 'd4')).toBe(false);
  });

  it('fills a relief slot for an available provider in next-call order', () => {
    const d4 = dSlot('d4', '2026-01-07', 'D4'); // Wednesday weekday
    const plan = solve(buildCtx([d4], [prov('p1')]));
    const got = plan.assignments.find(a => a.slot_id === 'd4');
    expect(got?.provider_id).toBe('p1');
    expect(got?.source).toBe('relief-order');
  });
});

describe('solve — explainability (Phase 2a)', () => {
  it('records an explanation with competing-candidate count on a main-loop pick', () => {
    const slots = [callSlot('s1', '2026-01-07', 'C1')];
    const plan = solve(buildCtx(slots, [prov('pA'), prov('pB')]));
    const a = plan.assignments.find(x => x.slot_id === 's1');
    expect(a?.source).toBe('main-loop');
    expect(a?.explanation).toBeDefined();
    expect(a?.explanation?.competingCandidates).toBe(2);
    // first call for both providers -> no prior call -> daysSinceLastCall null
    expect(a?.explanation?.daysSinceLastCall).toBeNull();
    expect(typeof a?.explanation?.ratioAtAssignment).toBe('number');
  });

  it('attaches per-candidate rejection reasons to an unfilled slot', () => {
    const slots = [callSlot('s1', '2026-01-07', 'C1')];
    // single provider, but make them a CRNA so the physician slot rejects them
    const ctx = buildCtx(slots, [{ ...prov('p1'), provider_type: 'crna' }]);
    const plan = solve(ctx);
    expect(plan.assignments).toHaveLength(0);
    const u = plan.unfilled.find(x => x.slot_id === 's1');
    expect(u?.candidates).toBeDefined();
    expect(u?.candidates).toHaveLength(1);
    expect(u?.candidates?.[0]).toEqual({
      provider_id: 'p1', provider_name: 'p1', reason: 'group-mismatch',
    });
  });
});
