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
import { WEEKEND_V2_PATTERN } from './patterns/weekendV2';
import { dSlot } from './__fixtures__/buildContext';

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

describe('WEEKEND_V2_PATTERN — golden weekend shape (Doc A/B/C/E)', () => {
  // Slots are listed weekend-first (Sat, Sun, then Fri, Mon) on purpose. The
  // whole four-person shape depends on the Saturday + Sunday anchors firing
  // BEFORE the Friday slots, so the back-links (Sat C2 → Fri C2, Sun C2 → Fri C1
  // via the −2 link) claim those Fridays instead of the main loop filling them
  // standalone. Feeding these chronologically (Fri first) collapses Doc B's
  // Fri-C2 back-link and Doc C's Fri-C3 back-link — the main loop claims
  // Friday slots standalone before the Sat/Sun anchors fire, and
  // applyBlockChains no-ops on already-handled targets. Doc A happens to
  // still line up in this fixture via id-tiebreak, not via the −2 chain
  // firing. Weekend-first order matches production genContext's day-bucket
  // sort (saturday → sunday → friday → weekday), which the pattern relies on;
  // the bare `buildCtx` fixture keeps input order verbatim, so we mirror it.
  const slots = [
    callSlot('satC1', '2026-01-10', 'C1', 'saturday'),
    callSlot('satC2', '2026-01-10', 'C2', 'saturday'),
    callSlot('satC3', '2026-01-10', 'C3', 'saturday'),
    callSlot('sunC1', '2026-01-11', 'C1', 'sunday'),
    callSlot('sunC2', '2026-01-11', 'C2', 'sunday'),
    callSlot('sunC3', '2026-01-11', 'C3', 'sunday'),
    callSlot('friC1', '2026-01-09', 'C1', 'friday'),
    callSlot('friC2', '2026-01-09', 'C2', 'friday'),
    callSlot('friC3', '2026-01-09', 'C3', 'friday'),
    dSlot('friD2', '2026-01-09', 'D2', 'friday'),
    dSlot('monD1', '2026-01-12', 'D1', 'weekday'),
  ];
  const providers = [prov('p1'), prov('p2'), prov('p3'), prov('p4'), prov('p5'), prov('p6')];
  const shiftTypes = new Map([
    ['C1', shiftInfo('C1', { call_rank: 0 })],
    ['C2', shiftInfo('C2', { call_rank: 1 })],
    ['C3', shiftInfo('C3', { call_rank: 2 })],
  ]);

  it('produces the four-person weekend from the approved graphic', () => {
    const plan = solve(buildCtx(slots, providers, { callPattern: WEEKEND_V2_PATTERN, shiftTypes }));
    const byId = Object.fromEntries(plan.assignments.map(a => [a.slot_id, a.provider_id]));

    // Doc A: Sun C2 person carries Fri C1, gets Mon D1, is OFF Saturday.
    expect(byId['friC1']).toBe(byId['sunC2']);
    expect(byId['monD1']).toBe(byId['sunC2']);
    expect(plan.assignments.some(a => a.provider_id === byId['friC1'] && a.slot_date === '2026-01-10')).toBe(false);

    // Doc B: Sat C2 person carries Fri C2 + Sun C1, is OFF Monday.
    expect(byId['friC2']).toBe(byId['satC2']);
    expect(byId['sunC1']).toBe(byId['satC2']);
    expect(plan.assignments.some(a => a.provider_id === byId['satC2'] && a.slot_date === '2026-01-12')).toBe(false);

    // Doc C: one person covers Neuro Fri→Sun, works Monday (no post-call).
    expect(byId['friC3']).toBe(byId['satC3']);
    expect(byId['sunC3']).toBe(byId['satC3']);

    // Doc E: Sat C1 person has Fri D2 and is OFF Sunday.
    expect(byId['friD2']).toBe(byId['satC1']);
    expect(plan.assignments.some(a => a.provider_id === byId['satC1'] && a.slot_date === '2026-01-11')).toBe(false);

    // Four distinct people carry the four rows.
    expect(new Set([byId['sunC2'], byId['satC2'], byId['satC3'], byId['satC1']]).size).toBe(4);
  });
});

describe('WEEKEND_V2_PATTERN — broken chains still fill (in-house first)', () => {
  const mkSlots = () => [
    callSlot('friC1', '2026-01-09', 'C1', 'friday'),
    callSlot('friC2', '2026-01-09', 'C2', 'friday'),
    callSlot('satC1', '2026-01-10', 'C1', 'saturday'),
    callSlot('satC2', '2026-01-10', 'C2', 'saturday'),
    callSlot('sunC1', '2026-01-11', 'C1', 'sunday'),
    callSlot('sunC2', '2026-01-11', 'C2', 'sunday'),
  ];
  const shiftTypes = new Map([
    ['C1', shiftInfo('C1', { call_rank: 0 })],
    ['C2', shiftInfo('C2', { call_rank: 1 })],
  ]);

  it('every C1 is assigned even when Sunday capacity is scarce', () => {
    const pto = [{ availability_type: 'pto', start_date: '2026-01-09', end_date: '2026-01-11', approval_status: 'approved' }];
    const ctx = buildCtx(mkSlots(), [prov('p1'), prov('p2'), prov('p3'), prov('p4')], {
      callPattern: WEEKEND_V2_PATTERN, shiftTypes,
      availByPid: new Map([['p3', pto], ['p4', pto]]),
    });
    const plan = solve(ctx);
    for (const id of ['friC1', 'satC1', 'sunC1']) {
      expect(plan.assignments.some(a => a.slot_id === id), `${id} must be filled`).toBe(true);
    }
  });

  it('a Sun-C1 link broken by PTO falls through to a standalone fill', () => {
    const ctx = buildCtx(mkSlots(), [prov('p1'), prov('p2'), prov('p3')], {
      callPattern: WEEKEND_V2_PATTERN, shiftTypes,
      availByPid: new Map([['p2', [{
        availability_type: 'pto', start_date: '2026-01-11', end_date: '2026-01-11',
        approval_status: 'approved',
      }]]]),
    });
    const plan = solve(ctx);
    const sunC1 = plan.assignments.find(a => a.slot_id === 'sunC1');
    expect(sunC1).toBeDefined();
    expect(sunC1!.provider_id).not.toBe('p2');
    // M-1: the fill must be a genuine main-loop fallthrough — if scoring
    // changes ever hand satC2 to a Sunday-free provider, the scenario would
    // silently collapse into an ordinary weekend-chain fill and stop proving
    // anything. Fail loudly instead.
    expect(sunC1!.source).toBe('main-loop');
  });

  it('missing Fri D2 targets are recorded by BOTH the day chain and the block chain, Sat C1 unaffected', () => {
    // No D2 slot exists anywhere in this fixture, so two independent links dead-end:
    //  - friday C1's day-chain Thursday D2 pre-fill (offset −1 from Fri 01-09)
    //  - saturday C1's block-chain Fri D2 back-link (offset −1 from Sat 01-10)
    // Both must surface as no-slot skips (invariant 4); the second is the
    // block-chain recording fix — it was previously a silent `continue`.
    const ctx = buildCtx(mkSlots(), [prov('p1'), prov('p2'), prov('p3')], {
      callPattern: WEEKEND_V2_PATTERN, shiftTypes,
    });
    const plan = solve(ctx);
    const satC1 = plan.assignments.find(a => a.slot_id === 'satC1');
    expect(satC1).toBeDefined();
    // Day-chain source: Thursday 2026-01-08 (friC1's D2 pre-fill target).
    expect(plan.skippedDerived).toContainEqual(
      expect.objectContaining({ date: '2026-01-08', code: 'D2', reason: 'no-slot' }));
    // Block-chain source: Friday 2026-01-09, attributed to the satC1 holder.
    expect(plan.skippedDerived).toContainEqual(
      expect.objectContaining({
        date: '2026-01-09', code: 'D2', provider_id: satC1!.provider_id, reason: 'no-slot',
      }));
  });

  it('June-draft: Sat C3 with no Fri C3 slot — Sat fills, the missing Friday is recorded', () => {
    // Block starts on a weekend, so the saturday C3 anchor's −1 back-link has
    // no Friday slot to claim. The Sun C3 slot IS included so the +1 link fills
    // normally — the test isolates exactly one dead link (the missing Friday).
    const slots = [
      callSlot('satC3', '2026-01-10', 'C3', 'saturday'),
      callSlot('sunC3', '2026-01-11', 'C3', 'sunday'),
    ];
    const ctx = buildCtx(slots, [prov('p1'), prov('p2')], {
      callPattern: WEEKEND_V2_PATTERN,
      shiftTypes: new Map([['C3', shiftInfo('C3', { call_rank: 2 })]]),
    });
    const plan = solve(ctx);
    const satC3 = plan.assignments.find(a => a.slot_id === 'satC3');
    expect(satC3).toBeDefined();
    expect(plan.assignments.find(a => a.slot_id === 'sunC3')?.provider_id).toBe(satC3!.provider_id);
    expect(plan.skippedDerived).toContainEqual(
      expect.objectContaining({
        date: '2026-01-09', code: 'C3', provider_id: satC3!.provider_id, reason: 'no-slot',
      }));
  });
});
