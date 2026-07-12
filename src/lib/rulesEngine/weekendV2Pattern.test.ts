import { describe, it, expect } from 'vitest';
import { CallPatternDocSchema, callFillOrderWarnings } from './callPattern';
import { CLASSIC_PATTERN } from './callPattern';

describe('callFillOrder schema field', () => {
  it('accepts call_rank and defaults to absent', () => {
    const doc = CallPatternDocSchema.parse({ ...CLASSIC_PATTERN, callFillOrder: 'call_rank' });
    expect(doc.callFillOrder).toBe('call_rank');
    expect(CallPatternDocSchema.parse(CLASSIC_PATTERN).callFillOrder).toBeUndefined();
  });
  it('rejects unknown orders', () => {
    expect(() => CallPatternDocSchema.parse({ ...CLASSIC_PATTERN, callFillOrder: 'alphabetical' })).toThrow();
  });
});

import { solve } from './solve';
import { buildCtx, prov, callSlot, shiftInfo } from './__fixtures__/buildContext';

// C1 ranks 0 in prod (C2=1, C3=2). Under Sunday scarcity, legacy order
// (C2 first) hands the last provider to home-call; call_rank order must
// protect the in-house C1 instead.
describe('callFillOrder: call_rank — in-house C1 wins under scarcity', () => {
  const sunC1 = callSlot('sunC1', '2026-01-11', 'C1', 'sunday');
  const sunC2 = callSlot('sunC2', '2026-01-11', 'C2', 'sunday');
  const providers = [prov('p1'), prov('p2')];
  const p2pto = new Map([['p2', [{
    availability_type: 'pto', start_date: '2026-01-11', end_date: '2026-01-11',
    approval_status: 'approved',
  }]]]);
  const shiftTypes = new Map([
    ['C1', shiftInfo('C1', { call_rank: 0 })],
    ['C2', shiftInfo('C2', { call_rank: 1 })],
  ]);

  it('legacy order gives the scarce provider to C2 (characterization)', () => {
    const plan = solve(buildCtx([sunC2, sunC1], providers, { availByPid: p2pto, shiftTypes }));
    expect(plan.assignments.find(a => a.slot_id === 'sunC2')?.provider_id).toBe('p1');
    expect(plan.assignments.some(a => a.slot_id === 'sunC1')).toBe(false);
  });

  it('call_rank order fills C1 first, C2 goes unfilled instead', () => {
    const doc = { ...CLASSIC_PATTERN, callFillOrder: 'call_rank' as const };
    const plan = solve(buildCtx([sunC2, sunC1], providers, { availByPid: p2pto, shiftTypes, callPattern: doc }));
    expect(plan.assignments.find(a => a.slot_id === 'sunC1')?.provider_id).toBe('p1');
    expect(plan.assignments.some(a => a.slot_id === 'sunC2')).toBe(false);
  });
});

// Null call_rank on a call code sorts by solve's legacy code fallback, not
// last — the load-time warning is the guard against silent mis-ordering.
describe('callFillOrderWarnings — null call_rank on a call code', () => {
  const ranked = shiftInfo('C1', { category: 'call', call_rank: 0 });
  const unranked = shiftInfo('C4', { category: 'call' });   // call_rank: null
  const nonCall = shiftInfo('D1');                          // regular, rank null — never warns

  it('warns per null-ranked call code when callFillOrder=call_rank', () => {
    const doc = { ...CLASSIC_PATTERN, callFillOrder: 'call_rank' as const };
    const warnings = callFillOrderWarnings(doc, [ranked, unranked, nonCall]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('C4');
    expect(warnings[0]).toContain("callFillOrder='call_rank'");
    expect(warnings[0]).toContain('legacy fallback');
  });

  it('silent when the flag is absent', () => {
    expect(callFillOrderWarnings(CLASSIC_PATTERN, [ranked, unranked, nonCall])).toEqual([]);
  });
});
