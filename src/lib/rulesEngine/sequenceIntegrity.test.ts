// Sequence-slot integrity (2026-07-17, live-confirmed bug: 27 violating rows).
// SEQUENCE-OWNED slots — those the ACTIVE pattern doc could target as a chain
// link (dayChains links; block-chain links) — belong to the chain's provider
// and NOBODY else. D1 (Post 2nd Call) belongs to yesterday's C2 person; D2/D3
// pre-call fills belong to tomorrow's C1/C2 person; Doc C's Friday D4 belongs
// to the Sat-C3 block-chain provider. When the chain breaks (source call
// unfilled, or its holder blocked on the target day) the slot stays UNASSIGNED
// and is REPORTED — never handed to another provider by the mop-up sweep or
// the relief pass. Chain fills, sequenceAutoFill, and seeds remain the only
// legitimate writers.
//
// Reporting home (single, documented): plan.unfilled carries exactly ONE entry
// per open sequence-owned slot with an honest reason —
//   'sequence-orphan: chain source unfilled'  (chain never fired)
//   'sequence-orphan: chain link severed'     (skippedDerived records the
//                                              designated provider's block)
// plan.skippedDerived keeps its existing role (the suppression event itself,
// invariant 4) — that is a different fact about the same slot, not a
// double-report of the open-slot fact.
import { describe, it, expect } from 'vitest';
import { solve } from './solve';
import { WEEKEND_V2_PATTERN } from './patterns/weekendV2';
import { buildCtx, prov, callSlot, dSlot, cred, shiftInfo } from './__fixtures__/buildContext';
import type { ShiftTypeInfo } from './genTypes';

const engineShiftTypes = (): Map<string, ShiftTypeInfo> => new Map([
  ['C1', shiftInfo('C1', { category: 'call', call_rank: 0, generation_engine: 'call', requires_post_call_rule: true })],
  ['C2', shiftInfo('C2', { category: 'call', call_rank: 1, generation_engine: 'call', requires_post_call_rule: true })],
  ['C3', shiftInfo('C3', { category: 'call', call_rank: 2, generation_engine: 'call', is_overlay: true })],
  ['D1', shiftInfo('D1', { generation_engine: 'call' })],
  ['D2', shiftInfo('D2', { generation_engine: 'call' })],
  ['D3', shiftInfo('D3', { generation_engine: 'call' })],
  ['D4', shiftInfo('D4', { generation_engine: 'call', relief_rank: 1 })],
  ['D5', shiftInfo('D5', { generation_engine: 'call', relief_rank: 2 })],
]);

describe('sequence integrity — mop-up must not fill sequence-owned slots', () => {
  it('leaves D1 unassigned when its trigger C2 went unfilled (the live bug: mop-up handed it out)', () => {
    // p1 is on PTO Monday (the C2 date) but free Tuesday. Mon C2 goes
    // unfilled; Tue D1 is sequence-owned (classic C2 dayChain, +1 D1).
    // Pre-fix the mop-up handed Tue D1 to p1, who was NOT on C2 Monday.
    const monC2 = callSlot('monC2', '2026-01-05', 'C2'); // Mon
    const tueD1 = dSlot('tueD1', '2026-01-06', 'D1');    // Tue
    const ctx = buildCtx([monC2, tueD1], [prov('p1')], {
      shiftTypes: engineShiftTypes(),
      availByPid: new Map([['p1', [{
        availability_type: 'pto', start_date: '2026-01-05', end_date: '2026-01-05',
        approval_status: 'approved',
      }]]]),
    });
    const plan = solve(ctx);
    expect(plan.unfilled.map(u => u.slot_id)).toContain('monC2');
    expect(plan.assignments.some(a => a.slot_id === 'tueD1')).toBe(false);
    const orphans = plan.unfilled.filter(u => u.slot_id === 'tueD1');
    expect(orphans).toHaveLength(1);
    expect(orphans[0].reason).toBe('sequence-orphan: chain source unfilled');
  });

  it('leaves D1 unassigned when the C2 holder is blocked the next day (severed chain: skip recorded, slot stays open)', () => {
    // p1 takes Mon C2 (p2 is credential-excluded from C2) but has PTO Tuesday:
    // the D1 chain link severs (skippedDerived 'pto'). p2 is a physician who
    // passes the derived gate — pre-fix the mop-up handed Tue D1 to p2.
    const monC2 = callSlot('monC2', '2026-01-05', 'C2');
    const tueD1 = dSlot('tueD1', '2026-01-06', 'D1');
    const ctx = buildCtx([monC2, tueD1], [prov('p1'), prov('p2')], {
      shiftTypes: engineShiftTypes(),
      credByPid: new Map([['p2', cred({ excluded_shift_types: ['C2'] })]]),
      availByPid: new Map([['p1', [{
        availability_type: 'pto', start_date: '2026-01-06', end_date: '2026-01-06',
        approval_status: 'approved',
      }]]]),
    });
    const plan = solve(ctx);
    expect(plan.assignments.find(a => a.slot_id === 'monC2')?.provider_id).toBe('p1');
    // The suppression event is recorded (invariant 4)…
    expect(plan.skippedDerived).toContainEqual(
      { date: '2026-01-06', code: 'D1', provider_id: 'p1', reason: 'pto' });
    // …and the slot stays open, reported exactly once with the severed reason.
    expect(plan.assignments.some(a => a.slot_id === 'tueD1')).toBe(false);
    const orphans = plan.unfilled.filter(u => u.slot_id === 'tueD1');
    expect(orphans).toHaveLength(1);
    expect(orphans[0].reason).toBe('sequence-orphan: chain link severed');
  });

  it('reports a WAIVED pre-call fill honestly (unlessCallWithinDays: anchor filled, link deliberately not fired)', () => {
    // p1 had a seeded Sun C2 (2026-01-04). p1 takes Tue C2 (p2 is
    // credential-excluded from C2); the −1 D3 pre-fill link carries
    // unlessCallWithinDays: 2 and p1's Sunday call is 2 days back, so the
    // link is WAIVED by design — anchor filled, no suppression event.
    // Pre-fix the mop-up filled Mon D3 with p2, and post-fix (pre-label) the
    // reason misread as 'chain source unfilled' though the C2 source IS
    // filled. The slot stays open with the honest waived reason.
    const monD3 = dSlot('monD3', '2026-01-05', 'D3');
    const tueC2 = callSlot('tueC2', '2026-01-06', 'C2');
    const ctx = buildCtx([monD3, tueC2], [prov('p1'), prov('p2')], {
      shiftTypes: engineShiftTypes(),
      credByPid: new Map([['p2', cred({ excluded_shift_types: ['C2'] })]]),
      seedAssignments: [{
        slot_date: '2026-01-04', provider_id: 'p1',
        shift_type_code: 'C2', shift_type_category: 'call', derived_day_type: 'sunday',
      }],
    });
    const plan = solve(ctx);
    expect(plan.assignments.find(a => a.slot_id === 'tueC2')?.provider_id).toBe('p1');
    // The waiver is a designed condition, not a suppression: no skippedDerived
    // record for Mon D3 (keeps skippedDerived's meaning — and the golden plan
    // pin — byte-stable).
    expect((plan.skippedDerived ?? []).some(s => s.date === '2026-01-05' && s.code === 'D3')).toBe(false);
    expect(plan.assignments.some(a => a.slot_id === 'monD3')).toBe(false);
    const orphans = plan.unfilled.filter(u => u.slot_id === 'monD3');
    expect(orphans).toHaveLength(1);
    expect(orphans[0].reason).toBe('sequence-orphan: pre-call fill waived');
  });

  it('still mop-up-fills an engine-call day slot that no chain could ever target (control)', () => {
    // D5 is engine-call but relief_rank null here and never a chain target →
    // legitimately mop-up-eligible.
    const shiftTypes = engineShiftTypes();
    shiftTypes.set('D5', shiftInfo('D5', { generation_engine: 'call' }));
    const wedD5 = dSlot('wedD5', '2026-01-07', 'D5'); // Wednesday
    const plan = solve(buildCtx([wedD5], [prov('p1')], { shiftTypes }));
    const got = plan.assignments.find(a => a.slot_id === 'wedD5');
    expect(got?.provider_id).toBe('p1');
    expect(got?.source).toBe('day-mop-up');
  });
});

describe('sequence integrity — relief pass must not grab sequence-owned relief-code slots', () => {
  it("leaves Doc C's Friday D4 open when the Sat C3 anchor is unfillable (weekend v2)", () => {
    // weekendV2: Sat C3 anchor links Fri D4 (−1) onto the same provider.
    // Nobody can take C3 (credential-excluded) → the Sat anchor never fires →
    // Fri D4 is an orphan. Pre-fix the relief pass (D4 relief_rank 1, friday
    // in reliefPass.dayTypes) grabbed it for whoever ranked first.
    const satC3 = callSlot('satC3', '2026-01-10', 'C3', 'saturday');
    const friD4 = dSlot('friD4', '2026-01-09', 'D4', 'friday');
    const providers = [prov('p1'), prov('p2')];
    const ctx = buildCtx([satC3, friD4], providers, {
      callPattern: WEEKEND_V2_PATTERN,
      shiftTypes: engineShiftTypes(),
      credByPid: new Map([
        ['p1', cred({ excluded_shift_types: ['C3'] })],
        ['p2', cred({ excluded_shift_types: ['C3'] })],
      ]),
    });
    const plan = solve(ctx);
    expect(plan.unfilled.map(u => u.slot_id)).toContain('satC3');
    expect(plan.assignments.some(a => a.slot_id === 'friD4')).toBe(false);
    const orphans = plan.unfilled.filter(u => u.slot_id === 'friD4');
    expect(orphans).toHaveLength(1);
    expect(orphans[0].reason).toBe('sequence-orphan: chain source unfilled');
  });

  it('still relief-fills a weekday D4 (not a chain target under weekend v2)', () => {
    const wedD4 = dSlot('wedD4', '2026-01-07', 'D4'); // Wednesday
    const plan = solve(buildCtx([wedD4], [prov('p1')], {
      callPattern: WEEKEND_V2_PATTERN,
      shiftTypes: engineShiftTypes(),
    }));
    const got = plan.assignments.find(a => a.slot_id === 'wedD4');
    expect(got?.provider_id).toBe('p1');
    expect(got?.source).toBe('relief-order');
  });
});

describe('sequence integrity — obligatory mode (capped C2 orphans its D1)', () => {
  it('a D1 orphaned by an obligation-capped C2 stays open, never handed out', () => {
    // 4 weekday C2 slots, pool ΣFTE 3 → effectivePar 3 → obligation
    // round(4/3)=1 each. Mon/Tue/Wed C2 consume all three caps; Thu C2 is
    // obligation-capped and open → Fri D1 (sequence-owned, +1 off Thu) is an
    // orphan. Pre-fix the mop-up handed Fri D1 out.
    const slots = [
      callSlot('monC2', '2026-01-05', 'C2'),
      callSlot('tueC2', '2026-01-06', 'C2'),
      callSlot('wedC2', '2026-01-07', 'C2'),
      callSlot('thuC2', '2026-01-08', 'C2'),
      dSlot('friD1', '2026-01-09', 'D1', 'friday'),
    ];
    const providers = [prov('p1'), prov('p2'), prov('p3')];
    const plan = solve(buildCtx(slots, providers, { shiftTypes: engineShiftTypes() }),
      { fillMode: 'obligatory' });
    expect(plan.unfilled.find(u => u.slot_id === 'thuC2')?.reason).toBe('obligation-cap');
    expect(plan.assignments.some(a => a.slot_id === 'friD1')).toBe(false);
    const orphans = plan.unfilled.filter(u => u.slot_id === 'friD1');
    expect(orphans).toHaveLength(1);
    expect(orphans[0].reason).toBe('sequence-orphan: chain source unfilled');
  });
});
