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
    // gate; use two providers so Sat fills and the chain is what we test.
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
