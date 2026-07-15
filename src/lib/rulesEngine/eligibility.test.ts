import { describe, it, expect } from 'vitest';
import { evaluateEligibility } from './eligibility';
import { emptySolveState } from './genTypes';
import type {
  GenerationContext, SlotToFill, CandidateProvider, SolveState,
} from './genTypes';

// ── Fixture builders ────────────────────────────────────────────────────────
function provider(over: Partial<CandidateProvider> = {}): CandidateProvider {
  return {
    id: 'p1', provider_type: 'physician', short_display_name: 'DOCA',
    fte_value: 1, home_site_id: 'site1',
    available_weekdays: [true, true, true, true, true, true, true],
    ...over,
  };
}
function slot(over: Partial<SlotToFill> = {}): SlotToFill {
  return {
    slot_id: 's1', slot_date: '2026-01-07', shift_type_id: 'st-c1',
    shift_type_code: 'C1', shift_type_category: 'call',
    derived_day_type: 'weekday', provider_group: 'physician',
    required_count: 1, existing_assignment_id: null,
    ...over,
  };
}
// Minimal context: only the maps the predicate reads. Targets default high so
// the quota gate passes unless a test overrides it.
function ctx(over: Partial<GenerationContext> = {}): GenerationContext {
  return {
    scheduleVersionId: 'v1', siteId: 'site1', parLevel: 12,
    slotsToFill: [], slotIndex: new Map(),
    providers: [], credByPid: new Map(), availByPid: new Map(),
    crossSiteByDate: new Map(),
    historicalAssignedByPid: new Map(), historicalTotalByBucket: new Map(),
    bucketTotals: new Map(),
    bucketTarget: new Map([['p1|weekday|C1', 5]]),
    seedAssignments: [],
    ...over,
  };
}

describe('evaluateEligibility — call gate', () => {
  it('passes a clean weekday C1 candidate', () => {
    const r = evaluateEligibility(slot(), provider(), emptySolveState(), ctx(), 'call');
    expect(r.eligible).toBe(true);
  });

  it('rejects non-physician for a physician slot', () => {
    const r = evaluateEligibility(slot(), provider({ provider_type: 'crna' }), emptySolveState(), ctx(), 'call');
    expect(r).toEqual({ eligible: false, reason: 'group-mismatch' });
  });

  it('rejects a same-date conflict', () => {
    const st: SolveState = emptySolveState();
    st.assignedOnDate.set('2026-01-07', new Set(['p1']));
    const r = evaluateEligibility(slot(), provider(), st, ctx(), 'call');
    expect(r).toEqual({ eligible: false, reason: 'same-date' });
  });

  it('rejects a cross-site conflict', () => {
    const c = ctx({ crossSiteByDate: new Map([['p1', new Set(['2026-01-07'])]]) });
    const r = evaluateEligibility(slot(), provider(), emptySolveState(), c, 'call');
    expect(r).toEqual({ eligible: false, reason: 'cross-site' });
  });

  it('rejects when the weekday is unavailable', () => {
    // 2026-01-07 is a Wednesday (dow=3).
    const wedOff = provider({ available_weekdays: [true, true, true, false, true, true, true] });
    const r = evaluateEligibility(slot(), wedOff, emptySolveState(), ctx(), 'call');
    expect(r).toEqual({ eligible: false, reason: 'weekday-unavailable' });
  });

  it('rejects C1 when the provider is already committed the next day (post-call guard)', () => {
    const st = emptySolveState();
    st.assignedOnDate.set('2026-01-08', new Set(['p1']));
    const r = evaluateEligibility(slot(), provider(), st, ctx(), 'call');
    expect(r).toEqual({ eligible: false, reason: 'post-call-guard' });
  });

  it('rejects when one more assignment would pass the bucket target', () => {
    const st = emptySolveState();
    st.bucketAssigned.set('p1|weekday|C1', 5); // target is 5; 5+1 > 5
    const r = evaluateEligibility(slot(), provider(), st, ctx(), 'call');
    expect(r).toEqual({ eligible: false, reason: 'bucket-quota' });
  });

  it('rejects an excluded shift type via credentials', () => {
    const c = ctx({
      credByPid: new Map([['p1', {
        is_active: true, credentialed: true, can_take_call: true,
        can_take_weekend_call: true, can_take_holiday_call: true,
        allowed_shift_types: [], excluded_shift_types: ['C1'], skill_tags: [],
      }]]),
    });
    const r = evaluateEligibility(slot(), provider(), emptySolveState(), c, 'call');
    expect(r).toEqual({ eligible: false, reason: 'credential' });
  });

  it('rejects a weekend slot without weekend-call credential (H1 guard)', () => {
    const c = ctx({
      bucketTarget: new Map([['p1|saturday|C1', 5]]),
      credByPid: new Map([['p1', {
        is_active: true, credentialed: true, can_take_call: true,
        can_take_weekend_call: false, can_take_holiday_call: true,
        allowed_shift_types: [], excluded_shift_types: [], skill_tags: [],
      }]]),
    });
    // 2026-01-03 is a Saturday.
    const satSlot = slot({ slot_date: '2026-01-03', derived_day_type: 'saturday' });
    const r = evaluateEligibility(satSlot, provider(), emptySolveState(), c, 'call');
    expect(r).toEqual({ eligible: false, reason: 'credential' });
  });

  it('rejects a Saturday slot when PTO covers the prior Mon-Fri week', () => {
    const c = ctx({
      bucketTarget: new Map([['p1|saturday|C1', 5]]),
      // 2026-01-03 Sat; prior week Mon-Fri = Dec 29 .. Jan 2. PTO Dec 30-31.
      availByPid: new Map([['p1', [{
        availability_type: 'pto', start_date: '2025-12-30', end_date: '2025-12-31',
        approval_status: 'approved',
      }]]]),
    });
    const satSlot = slot({ slot_date: '2026-01-03', derived_day_type: 'saturday' });
    const r = evaluateEligibility(satSlot, provider(), emptySolveState(), c, 'call');
    expect(r).toEqual({ eligible: false, reason: 'weekend-adjacent-pto' });
  });

  it('rejects when PTO (with bookend) covers the slot date', () => {
    const c = ctx({
      availByPid: new Map([['p1', [{
        availability_type: 'pto', start_date: '2026-01-05', end_date: '2026-01-09',
        approval_status: 'approved',
      }]]]),
    });
    const r = evaluateEligibility(slot(), provider(), emptySolveState(), c, 'call');
    expect(r).toEqual({ eligible: false, reason: 'availability-blocked' });
  });

  it('exempts Saturday C1 from the post-call guard (weekend swap)', () => {
    // 2026-01-03 is Saturday. Provider is committed Sunday 2026-01-04, but a
    // Saturday C1 must still be allowed (the weekend swap intentionally puts
    // the Sat-C1 person on Sun-C2).
    const st = emptySolveState();
    st.assignedOnDate.set('2026-01-04', new Set(['p1']));
    const c = ctx({ bucketTarget: new Map([['p1|saturday|C1', 5]]) });
    const satC1 = slot({ slot_date: '2026-01-03', derived_day_type: 'saturday' });
    const r = evaluateEligibility(satC1, provider(), st, c, 'call');
    expect(r.eligible).toBe(true);
  });

  it('rejects via the positive allow-list when the shift type is not listed', () => {
    const c = ctx({
      credByPid: new Map([['p1', {
        is_active: true, credentialed: true, can_take_call: true,
        can_take_weekend_call: true, can_take_holiday_call: true,
        allowed_shift_types: ['C2'], excluded_shift_types: [], skill_tags: [],
      }]]),
    });
    const r = evaluateEligibility(slot(), provider(), emptySolveState(), c, 'call');
    expect(r).toEqual({ eligible: false, reason: 'credential' });
  });

  it('rejects an inactive credential row', () => {
    const c = ctx({
      credByPid: new Map([['p1', {
        is_active: false, credentialed: true, can_take_call: true,
        can_take_weekend_call: true, can_take_holiday_call: true,
        allowed_shift_types: [], excluded_shift_types: [], skill_tags: [],
      }]]),
    });
    const r = evaluateEligibility(slot(), provider(), emptySolveState(), c, 'call');
    expect(r).toEqual({ eligible: false, reason: 'credential' });
  });

  it('treats a missing credential row as passing (not yet configured)', () => {
    // ctx() has an empty credByPid by default, so this confirms the
    // "no cred row = pass" behavior explicitly.
    const r = evaluateEligibility(slot(), provider(), emptySolveState(), ctx(), 'call');
    expect(r.eligible).toBe(true);
  });
});

describe('evaluateEligibility — derived gate (relief / D-chain)', () => {
  it('ignores the bucket-quota gate for derived placements', () => {
    const st = emptySolveState();
    st.bucketAssigned.set('p1|weekday|D1', 99);
    const d1 = slot({ shift_type_code: 'D1', shift_type_category: 'regular' });
    const r = evaluateEligibility(d1, provider(), st, ctx(), 'derived');
    expect(r.eligible).toBe(true);
  });

  it('still rejects derived placement during PTO bookend (H2 fix)', () => {
    const c = ctx({
      availByPid: new Map([['p1', [{
        availability_type: 'pto', start_date: '2026-01-05', end_date: '2026-01-09',
        approval_status: 'approved',
      }]]]),
    });
    const d1 = slot({ shift_type_code: 'D1', shift_type_category: 'regular' });
    const r = evaluateEligibility(d1, provider(), emptySolveState(), c, 'derived');
    expect(r).toEqual({ eligible: false, reason: 'availability-blocked' });
  });

  it('skips the C1 post-call guard for derived placements', () => {
    // Same setup that rejects under the 'call' gate must PASS under 'derived'.
    const st = emptySolveState();
    st.assignedOnDate.set('2026-01-08', new Set(['p1']));
    const r = evaluateEligibility(slot(), provider(), st, ctx(), 'derived');
    expect(r.eligible).toBe(true);
  });
});
