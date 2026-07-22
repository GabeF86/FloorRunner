// Seed-eviction ROLLBACK-path invariant pins (2026-07-21 adversarial review).
// seedEviction.test.ts pins the gates and the happy path; these pin the branch
// where the eviction attempt RELEASES the seed's day-claim, re-runs the full
// derived gate, FAILS, and must roll back byte-identically:
//   • PTO / PENDING PTO / cross-site on the eviction date still decline the
//     post-call fill with the seed intact (clinical invariants 2 + 3);
//   • the rolled-back day-claim is fully restored — a later same-date call
//     fill for the provider still sees them occupied (no double-booking);
//   • multi-seed same-date: ALL evictable seeds evict together and are ALL
//     recorded; one non-evictable seed on the date blocks the whole eviction.
import { describe, it, expect } from 'vitest';
import { solve } from './solve';
import { buildCtx, prov, callSlot, dSlot, shiftInfo, cred } from './__fixtures__/buildContext';
import type { GenerationContext, SeedAssignment, ShiftTypeInfo } from './genTypes';

const SHIFT_TYPES = new Map<string, ShiftTypeInfo>([
  ['C1', shiftInfo('C1', { category: 'call', call_rank: 0, generation_engine: 'call', requires_post_call_rule: true })],
  ['C2', shiftInfo('C2', { category: 'call', call_rank: 1, generation_engine: 'call', requires_post_call_rule: true })],
  ['D1', shiftInfo('D1', { generation_engine: 'call' })],
  ['D2', shiftInfo('D2', { generation_engine: 'call' })],
  ['D3', shiftInfo('D3', { generation_engine: 'call' })],
]);

function staleSeed(code: string, over: Partial<SeedAssignment> = {}): SeedAssignment {
  return {
    slot_date: '2026-09-30', provider_id: 'hussain',
    shift_type_code: code, shift_type_category: 'regular', derived_day_type: 'weekday',
    slot_id: `slot-${code.toLowerCase()}-0930`, assignment_id: `a-${code.toLowerCase()}-0930`,
    source_type: 'auto_generated', schedule_version_id: 'v1',
    ...over,
  };
}

function committedC2Seed(): SeedAssignment {
  return {
    slot_date: '2026-10-01', provider_id: 'hussain',
    shift_type_code: 'C2', shift_type_category: 'call', derived_day_type: 'weekday',
    slot_id: 'slot-c2-1001', assignment_id: 'a-c2-1001',
    source_type: 'auto_generated', schedule_version_id: 'v1',
  };
}

function ctx(over: Partial<GenerationContext> = {}, extraSeeds: SeedAssignment[] = []): GenerationContext {
  const slots = [
    callSlot('c2-0929', '2026-09-29', 'C2'),
    dSlot('d1-0930', '2026-09-30', 'D1'),
    dSlot('d3-0928', '2026-09-28', 'D3'),
  ];
  return buildCtx(slots, [prov('hussain')], {
    seedAssignments: [staleSeed('D3'), committedC2Seed(), ...extraSeeds],
    shiftTypes: SHIFT_TYPES,
    ...over,
  });
}

describe('seed eviction — never bypasses PTO/cross-site (invariants 2+3)', () => {
  it('APPROVED PTO on the eviction date: no eviction, D1 skip recorded, seed intact', () => {
    const plan = solve(ctx({
      availByPid: new Map([['hussain', [{
        availability_type: 'pto', start_date: '2026-09-30', end_date: '2026-09-30',
        approval_status: 'approved',
      }]]]),
    }));
    expect(plan.evictions).toBeUndefined();
    expect(plan.assignments.some(a => a.slot_date === '2026-09-30')).toBe(false);
    expect(plan.skippedDerived).toContainEqual(
      { date: '2026-09-30', code: 'D1', provider_id: 'hussain', reason: 'occupied' });
    // The C2 itself still fills (PTO is only on 9/30).
    expect(plan.assignments.find(a => a.slot_id === 'c2-0929')?.provider_id).toBe('hussain');
  });

  it('PENDING PTO on the eviction date blocks too (invariant 2: pending blocks)', () => {
    const plan = solve(ctx({
      availByPid: new Map([['hussain', [{
        availability_type: 'pto', start_date: '2026-09-30', end_date: '2026-09-30',
        approval_status: 'pending',
      }]]]),
    }));
    expect(plan.evictions).toBeUndefined();
    expect(plan.assignments.some(a => a.slot_date === '2026-09-30')).toBe(false);
    expect(plan.skippedDerived).toContainEqual(
      { date: '2026-09-30', code: 'D1', provider_id: 'hussain', reason: 'occupied' });
  });

  it('cross-site conflict on the eviction date: no eviction, no fill', () => {
    const plan = solve(ctx({
      crossSiteByDate: new Map([['hussain', new Set(['2026-09-30'])]]),
    }));
    expect(plan.evictions).toBeUndefined();
    expect(plan.assignments.some(a => a.slot_date === '2026-09-30')).toBe(false);
    expect(plan.skippedDerived).toContainEqual(
      { date: '2026-09-30', code: 'D1', provider_id: 'hussain', reason: 'occupied' });
  });
});

describe('seed eviction — rollback restores the released day-claim', () => {
  it('a failed eviction (credential-blocked D1) leaves the seed claim intact: a later same-date call fill is still refused', () => {
    // D1 is credential-excluded, so the eviction attempt releases the claim,
    // re-runs the gate, FAILS on 'credential', and must roll the claim back.
    // The later open C2 on 9/30 then probes the restored claim: if rollback
    // were broken, hussain would double-book onto it against his live D3 seed.
    const slots = [
      callSlot('c2-0929', '2026-09-29', 'C2'),
      callSlot('c2-0930', '2026-09-30', 'C2'),
      dSlot('d1-0930', '2026-09-30', 'D1'),
      dSlot('d3-0928', '2026-09-28', 'D3'),
    ];
    const plan = solve(buildCtx(slots, [prov('hussain')], {
      seedAssignments: [staleSeed('D3'), committedC2Seed()],
      shiftTypes: SHIFT_TYPES,
      credByPid: new Map([['hussain', cred({ excluded_shift_types: ['D1'] })]]),
    }));
    expect(plan.evictions).toBeUndefined();
    // D1 skip recorded with the ORIGINAL reason (occupied), no eviction.
    expect(plan.skippedDerived).toContainEqual(
      { date: '2026-09-30', code: 'D1', provider_id: 'hussain', reason: 'occupied' });
    // The probe: the 9/30 C2 must NOT be filled with hussain (claim restored).
    expect(plan.assignments.some(a => a.slot_id === 'c2-0930')).toBe(false);
    expect(plan.unfilled.some(u => u.slot_id === 'c2-0930')).toBe(true);
    // Exactly one assignment per provider-date overall (no double-booking).
    const key = (a: { provider_id: string; slot_date: string }) => `${a.provider_id}|${a.slot_date}`;
    const seen = new Set<string>();
    for (const a of plan.assignments) {
      expect(seen.has(key(a))).toBe(false);
      seen.add(key(a));
    }
  });
});

describe('seed eviction — multi-seed same-date behavior', () => {
  it('TWO evictable seeds on the date: both evicted, both recorded, D1 fills once', () => {
    const plan = solve(ctx({}, [staleSeed('D2', {
      slot_id: 'slot-d2-0930', assignment_id: 'a-d2-0930',
    })]));
    expect(plan.assignments.find(a => a.slot_id === 'd1-0930')?.provider_id).toBe('hussain');
    expect(plan.evictions).toHaveLength(2);
    const codes = plan.evictions!.map(e => e.code).sort();
    expect(codes).toEqual(['D2', 'D3']);
    // Every eviction record carries an executable identity for commitPlan.
    for (const e of plan.evictions!) {
      expect(e.assignment_id).toBeTruthy();
      expect(e.slot_id).toBeTruthy();
    }
  });

  it('one evictable + one MANUAL seed on the date: NOTHING is evicted', () => {
    const plan = solve(ctx({}, [staleSeed('D2', {
      slot_id: 'slot-d2-0930', assignment_id: 'a-d2-0930', source_type: 'manual',
    })]));
    expect(plan.evictions).toBeUndefined();
    expect(plan.assignments.some(a => a.slot_id === 'd1-0930')).toBe(false);
    expect(plan.skippedDerived).toContainEqual(
      { date: '2026-09-30', code: 'D1', provider_id: 'hussain', reason: 'occupied' });
  });
});
