import { describe, it, expect } from 'vitest';
import { CallPatternDocSchema, callFillOrderWarnings, dayTypeFillOrderWarnings } from './callPattern';
import { CLASSIC_PATTERN, type CallPatternDoc } from './callPattern';

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

describe('dayTypeFillOrder schema field', () => {
  it('accepts an ordered day-type list and defaults to absent', () => {
    const order = ['saturday', 'friday', 'sunday'];
    const doc = CallPatternDocSchema.parse({ ...CLASSIC_PATTERN, dayTypeFillOrder: order });
    expect(doc.dayTypeFillOrder).toEqual(order);
    expect(CallPatternDocSchema.parse(CLASSIC_PATTERN).dayTypeFillOrder).toBeUndefined();
  });
  it('rejects non-string entries (structure is validated; names are only warned)', () => {
    expect(() => CallPatternDocSchema.parse({ ...CLASSIC_PATTERN, dayTypeFillOrder: [1] })).toThrow();
    expect(() => CallPatternDocSchema.parse({ ...CLASSIC_PATTERN, dayTypeFillOrder: [''] })).toThrow();
  });
  it('unknown day-type NAMES parse fine but produce a load warning', () => {
    // Deliberately not a hard failure: a typo must not knock the whole live
    // pattern back to classic — the rest of the order still applies.
    const doc = CallPatternDocSchema.parse({ ...CLASSIC_PATTERN, dayTypeFillOrder: ['saturady', 'friday'] });
    const warnings = dayTypeFillOrderWarnings(doc);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("'saturady'");
    expect(warnings[0]).toContain('unknown day type');
  });
  it('silent when the list is valid or absent', () => {
    const doc = CallPatternDocSchema.parse({
      ...CLASSIC_PATTERN,
      dayTypeFillOrder: ['saturday', 'friday', 'sunday', 'weekday', 'federal_holiday', 'major_holiday'],
    });
    expect(dayTypeFillOrderWarnings(doc)).toEqual([]);
    expect(dayTypeFillOrderWarnings(CLASSIC_PATTERN)).toEqual([]);
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
  // Slots are listed saturday-first, then FRIDAY, then sunday — mirroring the
  // pattern's dayTypeFillOrder (saturday, friday, sunday, …), which production
  // genContext applies to slotsToFill; the bare `buildCtx` fixture keeps input
  // order verbatim, so we mirror it here. The four-person shape depends on it:
  // the Saturday anchors fire first (claiming Fri C2, Fri D4, Fri D2,
  // Sun C1, Sun C3 as links), THEN the friday pass places the in-house Fri C1
  // whose anchor chains Sun C2 forward (friday-first Doc A, spec 2026-07-15),
  // and the sunday pass has nothing left but leftovers. Feeding sunday before
  // friday would let the main loop claim Sun C2 standalone before the friday
  // anchor fires (applyBlockChains no-ops on already-handled call targets) —
  // collapsing Doc A exactly the way the old sunday-anchored −2 back-link
  // collapsed when fed fridays first.
  const slots = [
    callSlot('satC1', '2026-01-10', 'C1', 'saturday'),
    callSlot('satC2', '2026-01-10', 'C2', 'saturday'),
    callSlot('satC3', '2026-01-10', 'C3', 'saturday'),
    callSlot('friC1', '2026-01-09', 'C1', 'friday'),
    callSlot('friC2', '2026-01-09', 'C2', 'friday'),
    dSlot('friD2', '2026-01-09', 'D2', 'friday'),
    dSlot('friD4', '2026-01-09', 'D4', 'friday'),
    callSlot('sunC1', '2026-01-11', 'C1', 'sunday'),
    callSlot('sunC2', '2026-01-11', 'C2', 'sunday'),
    callSlot('sunC3', '2026-01-11', 'C3', 'sunday'),
    dSlot('monD1', '2026-01-12', 'D1', 'weekday'),
  ];
  const providers = [prov('p1'), prov('p2'), prov('p3'), prov('p4'), prov('p5'), prov('p6')];
  // C3 is_overlay mirrors patch25 (Doc C: Fri D4 day shift + Fri C3 evening
  // call coexist on one person).
  const shiftTypes = new Map([
    ['C1', shiftInfo('C1', { call_rank: 0 })],
    ['C2', shiftInfo('C2', { call_rank: 1 })],
    ['C3', shiftInfo('C3', { category: 'call', call_rank: 2, is_overlay: true })],
    ['D4', shiftInfo('D4', { category: 'regular' })],
  ]);

  it('produces the four-person weekend from the approved graphic', () => {
    const plan = solve(buildCtx(slots, providers, { callPattern: WEEKEND_V2_PATTERN, shiftTypes }));
    const byId = Object.fromEntries(plan.assignments.map(a => [a.slot_id, a.provider_id]));

    // Doc A: Fri C1 person carries Sun C2 (friday-anchored +2 link), gets
    // Mon D1, is OFF Saturday.
    expect(byId['sunC2']).toBe(byId['friC1']);
    expect(byId['monD1']).toBe(byId['friC1']);
    expect(plan.assignments.some(a => a.provider_id === byId['friC1'] && a.slot_date === '2026-01-10')).toBe(false);

    // Doc B: Sat C2 person carries Fri C2 + Sun C1, is OFF Monday.
    expect(byId['friC2']).toBe(byId['satC2']);
    expect(byId['sunC1']).toBe(byId['satC2']);
    expect(plan.assignments.some(a => a.provider_id === byId['satC2'] && a.slot_date === '2026-01-12')).toBe(false);

    // Doc C (2026-07-27): neuro is Sat + Sun, and the neuro doc still works
    // the Friday D4 day shift. Friday NEURO CALL has no slot at all — the
    // Friday C2 doc cross-covers it.
    expect(byId['friD4']).toBe(byId['satC3']);
    expect(byId['sunC3']).toBe(byId['satC3']);
    expect(byId['friC3']).toBeUndefined();
    expect(plan.skippedDerived ?? []).not.toContainEqual(
      expect.objectContaining({ code: 'C3', reason: 'no-slot' }));

    // Doc E: Sat C1 person has Fri D2 and is OFF Sunday.
    expect(byId['friD2']).toBe(byId['satC1']);
    expect(plan.assignments.some(a => a.provider_id === byId['satC1'] && a.slot_date === '2026-01-11')).toBe(false);

    // Four distinct people carry the four rows.
    expect(new Set([byId['friC1'], byId['satC2'], byId['satC3'], byId['satC1']]).size).toBe(4);
  });
});

describe('WEEKEND_V2_PATTERN — broken chains still fill (in-house first)', () => {
  // Input order mirrors the pattern's dayTypeFillOrder: saturday, friday,
  // sunday (buildCtx preserves input order verbatim).
  const mkSlots = () => [
    callSlot('satC1', '2026-01-10', 'C1', 'saturday'),
    callSlot('satC2', '2026-01-10', 'C2', 'saturday'),
    callSlot('friC1', '2026-01-09', 'C1', 'friday'),
    callSlot('friC2', '2026-01-09', 'C2', 'friday'),
    callSlot('sunC1', '2026-01-11', 'C1', 'sunday'),
    callSlot('sunC2', '2026-01-11', 'C2', 'sunday'),
  ];
  const shiftTypes = new Map([
    ['C1', shiftInfo('C1', { call_rank: 0 })],
    ['C2', shiftInfo('C2', { call_rank: 1 })],
  ]);

  it('every C1 is assigned even when Sunday capacity is scarce', () => {
    // p4 is on PTO across the whole weekend, so only three providers remain —
    // exactly the minimum the three-doc C1/C2 structure needs (Doc D: Sat C1
    // with Sunday off; Doc B: Sat C2 + Fri C2 + Sun C1; Doc A: Fri C1 + Sun
    // C2). Sunday capacity is fully consumed by the chains; every C1 fills.
    const pto = [{ availability_type: 'pto', start_date: '2026-01-09', end_date: '2026-01-11', approval_status: 'approved' }];
    const ctx = buildCtx(mkSlots(), [prov('p1'), prov('p2'), prov('p3'), prov('p4')], {
      callPattern: WEEKEND_V2_PATTERN, shiftTypes,
      availByPid: new Map([['p4', pto]]),
    });
    const plan = solve(ctx);
    for (const id of ['friC1', 'satC1', 'sunC1']) {
      expect(plan.assignments.some(a => a.slot_id === id), `${id} must be filled`).toBe(true);
    }
  });

  it('a Sun-C1 link broken by PTO falls through to a standalone fill', () => {
    // p2 wins Sat C2 but is on PTO Sunday, so Doc B's +1 Sun C1 link declines;
    // the slot must fall through to a standalone main-loop fill. Four
    // providers: p1 takes Sat C1 (Sunday blocked), p3 takes Fri C1 (and Sun C2
    // via the friday anchor), leaving p4 as the only legal Sun C1 fill.
    const ctx = buildCtx(mkSlots(), [prov('p1'), prov('p2'), prov('p3'), prov('p4')], {
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

  it('June-draft: Sat C3 with no Fri D4 slot — Sat fills, the missing Friday is recorded', () => {
    // Block starts on a weekend, so the saturday C3 anchor's −1 back-link has
    // no Friday slot to claim. The Sun C3 slot IS included so the +1 link fills
    // normally — the test isolates exactly one dead link (the missing Friday).
    // RE-POINTED 2026-07-27: that −1 back-link is now Fri D4 (the day shift).
    // The old Fri C3 evening-call link is GONE — Friday neuro is cross-covered
    // by the Friday C2 doc — so a missing Friday C3 slot is no longer an
    // obligation at all and must mint no record; the D4 one still must.
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
        date: '2026-01-09', code: 'D4', provider_id: satC3!.provider_id, reason: 'no-slot',
      }));
    expect(plan.skippedDerived ?? []).not.toContainEqual(
      expect.objectContaining({ date: '2026-01-09', code: 'C3' }));
  });
});

// ── friday-first Doc A: behavior pinned across the re-anchor (spec 2026-07-15)
//
// The OLD live shape (sunday-anchored, −2 back-link to Fri C1) and the NEW
// shape (friday-anchored, +2 forward link to Sun C2) must produce the
// IDENTICAL Doc A artifact set: Fri C1 + Sun C2 on one person, Thursday D2
// filled, Saturday blocked, Monday D1 filled. Both variants also pin that
// dayChains fire on BLOCK-LINK placements: in the old shape Fri C1 was the
// link (its Saturday block + Thursday D2 fired from the link); in the new
// shape Sun C2 is the link (its Monday D1 fires from the link). The old doc is
// inlined verbatim below (Doc A pieces of the pre-2026-07-15 live pattern) as
// the characterization baseline.
//
// RE-PINNED 2026-07-20 (Gabriel): the recent-call scenario now DIVERGES by
// design. WEEKEND_V2_PATTERN dropped unlessCallWithinDays from its pre-call
// links (pre-call fills are unconditional — the previous describe), so Thu D2
// FILLS despite a Wednesday call. The OLD synthetic doc keeps the condition
// verbatim and stays the engine-level coverage of the unlessCallWithinDays
// FEATURE (silent link waiver, no skip record) — the schema field remains
// supported for patterns that still use it (classic does).
describe('friday-first Doc A — pinned behavior across the re-anchor', () => {
  const OLD_SUNDAY_ANCHORED: CallPatternDoc = {
    version: 1,
    blocks: [{ anchorDayType: 'sunday', chains: [
      { trigger: 'C2', links: [{ offset: -2, code: 'C1' }] },
    ] }],
    dayChains: [
      { trigger: 'C1', dayTypes: ['weekday', 'friday', 'federal_holiday', 'major_holiday'],
        links: [{ offset: -1, code: 'D2', unlessCallWithinDays: 2 }], blocks: [{ offset: 1 }] },
      { trigger: 'C1', dayTypes: ['saturday'], blocks: [{ offset: 1 }] },
      { trigger: 'C2', dayTypes: ['sunday'], links: [{ offset: 1, code: 'D1' }] },
    ],
    spans: [], placementPasses: [], reliefPass: null, optimizerMovableDayTypes: [],
  };
  const shiftTypes = new Map([
    ['C1', shiftInfo('C1', { category: 'call', call_rank: 0 })],
    ['C2', shiftInfo('C2', { category: 'call', call_rank: 1 })],
  ]);
  // Thu 01-08, Fri 01-09, Sat 01-10, Sun 01-11, Mon 01-12. The Saturday C1 is
  // listed LAST in both variants so Doc A assembles first and the Sat slot
  // then PROVES the block: Doc A's holder must be skipped for it. Anchor-first
  // input order per variant (old: sunday first; new: friday first) mirrors
  // each pattern's production fill order.
  const mkDerived = () => [
    dSlot('thuD2', '2026-01-08', 'D2', 'weekday'),
    dSlot('monD1', '2026-01-12', 'D1', 'weekday'),
  ];
  const variants = [
    {
      name: 'OLD sunday-anchored (characterization of live-today)',
      doc: OLD_SUNDAY_ANCHORED,
      anchorId: 'sunC2', linkId: 'friC1',
      waivesPreCall: true, // keeps unlessCallWithinDays: 2 — the FEATURE pin
      slots: () => [
        callSlot('sunC2', '2026-01-11', 'C2', 'sunday'),
        callSlot('friC1', '2026-01-09', 'C1', 'friday'),
        callSlot('satC1', '2026-01-10', 'C1', 'saturday'),
        ...mkDerived(),
      ],
    },
    {
      name: 'NEW friday-anchored (re-anchored chain)',
      doc: WEEKEND_V2_PATTERN,
      anchorId: 'friC1', linkId: 'sunC2',
      waivesPreCall: false, // pre-call fills unconditional (Gabriel 2026-07-20)
      slots: () => [
        callSlot('friC1', '2026-01-09', 'C1', 'friday'),
        callSlot('sunC2', '2026-01-11', 'C2', 'sunday'),
        callSlot('satC1', '2026-01-10', 'C1', 'saturday'),
        ...mkDerived(),
      ],
    },
  ];

  for (const v of variants) {
    it(`${v.name}: Fri C1 + Sun C2 one person; Thu D2 filled; Sat blocked; Mon D1 filled`, () => {
      const plan = solve(buildCtx(v.slots(), [prov('p1'), prov('p2')], {
        callPattern: v.doc, shiftTypes,
      }));
      const byId = Object.fromEntries(plan.assignments.map(a => [a.slot_id, a.provider_id]));
      const docA = byId[v.anchorId];
      expect(docA).toBeDefined();
      // The chained pair lands on one person, whichever side is the anchor.
      expect(byId[v.linkId]).toBe(docA);
      // Thursday D2 fills in both variants. (Old doc: unlessCallWithinDays 2
      // sees only calls strictly BEFORE Friday — the paired Sun C2 two days
      // AFTER never suppresses, hadCallWithin looks backwards. New doc: the
      // link is unconditional.)
      expect(byId['thuD2']).toBe(docA);
      // Monday D1 via the sunday C2 dayChain — fires whether Sun C2 was the
      // anchor (old) or the link (new): dayChains run on block-link placements.
      expect(byId['monD1']).toBe(docA);
      // Saturday is Doc A's day off: the Sat C1 slot must go to the OTHER
      // provider (the block wrote through even when Fri C1 was a mere link).
      expect(byId['satC1']).toBeDefined();
      expect(byId['satC1']).not.toBe(docA);
      expect(plan.assignments.some(a => a.provider_id === docA && a.slot_date === '2026-01-10')).toBe(false);
    });

    it(`${v.name}: a call 2 days before Friday — Thu D2 ${v.waivesPreCall ? 'waived (unlessCallWithinDays feature)' : 'FILLS (waiver removed, Gabriel 2026-07-20)'}`, () => {
      // RE-PINNED 2026-07-20 (was: "suppresses Thu D2 identically"). A
      // Wednesday C2 seed (gap 2 from Friday) exercises the recent-call
      // window. OLD synthetic doc: unlessCallWithinDays 2 waives the Thu D2
      // pre-fill SILENTLY (link condition, not a recorded skip) — this stays
      // the engine coverage of the schema feature. NEW WEEKEND_V2_PATTERN:
      // the link carries no condition, so Thu D2 fills — pre-call status
      // depends only on tomorrow's call (Gabriel 2026-07-20). Single provider
      // so Doc A is deterministically the Wednesday-call holder.
      const wedSeed = {
        slot_date: '2026-01-07', provider_id: 'p1', shift_type_code: 'C2',
        shift_type_category: 'call', derived_day_type: 'weekday',
      };
      const slots = v.slots().filter(s => s.slot_id !== 'satC1'); // 1-provider pool
      const plan = solve(buildCtx(slots, [prov('p1')], {
        callPattern: v.doc, shiftTypes, seedAssignments: [wedSeed],
      }));
      const byId = Object.fromEntries(plan.assignments.map(a => [a.slot_id, a.provider_id]));
      expect(byId[v.anchorId]).toBe('p1');
      expect(byId[v.linkId]).toBe('p1');
      if (v.waivesPreCall) {
        // Waived, and silently (link condition, not a recorded skip).
        expect(byId['thuD2']).toBeUndefined();
        expect(plan.skippedDerived!.some(s => s.date === '2026-01-08' && s.code === 'D2')).toBe(false);
      } else {
        expect(byId['thuD2']).toBe('p1');
      }
    });
  }
});

// ── chain call links bypass quota + record severance (2026-07-16) ────────────
// A block-chain call link is a structural same-provider obligation whose anchor
// was already fairness-scored: re-checking the bucket quota on the link
// silently severed the designed Doc A pairing whenever quota math ran dry, and
// left ZERO record of it. Links now gate 'call-no-quota' (every safety gate
// still runs) and a safety-severed call link is recorded in skippedDerived
// (invariant 4 extended — the fall-through to the main loop is unchanged).
describe('WEEKEND_V2_PATTERN — chain call links bypass quota, severance recorded', () => {
  const shiftTypes = new Map([
    ['C1', shiftInfo('C1', { category: 'call', call_rank: 0 })],
    ['C2', shiftInfo('C2', { category: 'call', call_rank: 1 })],
  ]);

  it('quota-exhausted pool: the Fri C1 anchor still chains Sun C2 to the SAME provider', () => {
    const slots = [
      callSlot('friC1', '2026-01-09', 'C1', 'friday'),
      callSlot('sunC2', '2026-01-11', 'C2', 'sunday'),
    ];
    const ctx = buildCtx(slots, [prov('p1'), prov('p2')], {
      callPattern: WEEKEND_V2_PATTERN, shiftTypes,
      bucketTarget: new Map(), // every target 0 — full quota exhaustion
    });
    const plan = solve(ctx);
    const fri = plan.assignments.find(a => a.slot_id === 'friC1');
    const sun = plan.assignments.find(a => a.slot_id === 'sunC2');
    expect(fri).toBeDefined();
    expect(fri!.source).toBe('quota-relaxed'); // anchor itself needed relaxation
    expect(sun).toBeDefined();
    // The whole point: the pairing survives quota exhaustion. Under the old
    // 'call' gate the link failed 'bucket-quota', fell through, and the main
    // loop's recency sort handed Sun C2 to the OTHER provider.
    expect(sun!.provider_id).toBe(fri!.provider_id);
    expect(sun!.source).toBe('weekend-chain');
    expect(plan.unfilled).toHaveLength(0);
  });

  it('a PTO-severed call link is RECORDED in skippedDerived and falls through to the main loop', () => {
    const slots = [
      callSlot('friC1', '2026-01-09', 'C1', 'friday'),
      callSlot('sunC2', '2026-01-11', 'C2', 'sunday'),
    ];
    // p1 wins Fri C1 (id tie) but is on PTO Sunday: the +2 link must decline
    // (safety gate — relaxation never waives PTO), be RECORDED, and the slot
    // must fall through to a standalone main-loop fill by p2.
    const ctx = buildCtx(slots, [prov('p1'), prov('p2')], {
      callPattern: WEEKEND_V2_PATTERN, shiftTypes,
      availByPid: new Map([['p1', [{
        availability_type: 'pto', start_date: '2026-01-11', end_date: '2026-01-11',
        approval_status: 'approved',
      }]]]),
    });
    const plan = solve(ctx);
    const fri = plan.assignments.find(a => a.slot_id === 'friC1');
    expect(fri?.provider_id).toBe('p1');
    expect(plan.skippedDerived).toContainEqual({
      date: '2026-01-11', code: 'C2', provider_id: 'p1', reason: 'pto',
    });
    const sun = plan.assignments.find(a => a.slot_id === 'sunC2');
    expect(sun?.provider_id).toBe('p2');
    expect(sun?.source).toBe('main-loop');
  });

  it('an OVERRIDDEN chain target whose pinned provider is ineligible records the severance (override path)', () => {
    // 2026-07-16 PROOF defect 2 observability half: the optimizer pins chain
    // targets via callOverrides; when the pinned provider can't take the slot
    // the pairing severs through the OVERRIDE branch of applyBlockChains —
    // previously silent (invariant-4 gap). It must be recorded with the real
    // reason, and the slot still surfaces via the main loop's unfilled report.
    const slots = [
      callSlot('friC1', '2026-01-09', 'C1', 'friday'),
      callSlot('sunC2', '2026-01-11', 'C2', 'sunday'),
    ];
    // p2 is pinned onto sunC2 but is on PTO that Sunday; p1 wins Fri C1.
    const ctx = buildCtx(slots, [prov('p1'), prov('p2')], {
      callPattern: WEEKEND_V2_PATTERN, shiftTypes,
      availByPid: new Map([['p2', [{
        availability_type: 'pto', start_date: '2026-01-11', end_date: '2026-01-11',
        approval_status: 'approved',
      }]]]),
    });
    const plan = solve(ctx, { callOverrides: new Map([['sunC2', 'p2']]) });
    expect(plan.assignments.find(a => a.slot_id === 'friC1')?.provider_id).toBe('p1');
    // The severance is recorded against the PINNED provider with the real reason.
    expect(plan.skippedDerived).toContainEqual({
      date: '2026-01-11', code: 'C2', provider_id: 'p2', reason: 'pto',
    });
    // The slot itself is still honestly reported unfilled by the main loop.
    expect(plan.unfilled.some(
      u => u.slot_id === 'sunC2' && u.reason === 'Forced provider ineligible',
    )).toBe(true);
  });

  it('an OVERRIDDEN chain target whose pinned provider IS eligible still records the DESIGNED partner severance', () => {
    // 2026-07-16 PROOF final-run residue: optimize() pins EVERY incumbent call
    // fill as an override on each trial re-solve. When greedy severed a pairing
    // on a hard block (recorded), the accepted trial refills the target via the
    // eligible-override branch — which previously recorded NOTHING, so the
    // severance vanished from the FINAL committed plan (invariant-4 gap, the
    // eligible-pin half). The designed partner's block must be re-evaluated and
    // recorded with the real reason.
    const slots = [
      callSlot('friC1', '2026-01-09', 'C1', 'friday'),
      callSlot('sunC2', '2026-01-11', 'C2', 'sunday'),
    ];
    // p1 wins Fri C1 but is on PTO that Sunday (designed +2 partner blocked);
    // p2 — eligible — is pinned onto sunC2, exactly like an optimizer trial
    // replaying greedy's post-severance fill.
    const ctx = buildCtx(slots, [prov('p1'), prov('p2')], {
      callPattern: WEEKEND_V2_PATTERN, shiftTypes,
      availByPid: new Map([['p1', [{
        availability_type: 'pto', start_date: '2026-01-11', end_date: '2026-01-11',
        approval_status: 'approved',
      }]]]),
    });
    const plan = solve(ctx, { callOverrides: new Map([['sunC2', 'p2']]) });
    expect(plan.assignments.find(a => a.slot_id === 'friC1')?.provider_id).toBe('p1');
    // The pinned provider fills the slot (no hole)...
    const sun = plan.assignments.find(a => a.slot_id === 'sunC2');
    expect(sun?.provider_id).toBe('p2');
    // ...AND the designed-pairing severance stays observable with its real reason.
    expect(plan.skippedDerived).toContainEqual({
      date: '2026-01-11', code: 'C2', provider_id: 'p1', reason: 'pto',
    });
  });

  it('an OVERRIDDEN chain target severed with NO hard block on the designed partner records reason overridden', () => {
    // Defensive: optimize()'s move sets can no longer sever a healthy pairing
    // (chain anchors are immovable and chain-sourced targets are not movable),
    // but callOverrides is a public solve() surface — a caller pinning a chain
    // target away from an eligible designed partner must still leave a record.
    const slots = [
      callSlot('friC1', '2026-01-09', 'C1', 'friday'),
      callSlot('sunC2', '2026-01-11', 'C2', 'sunday'),
    ];
    const ctx = buildCtx(slots, [prov('p1'), prov('p2')], {
      callPattern: WEEKEND_V2_PATTERN, shiftTypes,
    });
    const plan = solve(ctx, { callOverrides: new Map([['sunC2', 'p2']]) });
    expect(plan.assignments.find(a => a.slot_id === 'friC1')?.provider_id).toBe('p1');
    expect(plan.assignments.find(a => a.slot_id === 'sunC2')?.provider_id).toBe('p2');
    expect(plan.skippedDerived).toContainEqual({
      date: '2026-01-11', code: 'C2', provider_id: 'p1', reason: 'overridden',
    });
  });

  it('an OVERRIDDEN chain target pinned to the DESIGNED partner records nothing (pairing intact)', () => {
    // Control: optimize() trials pin the incumbent holder — when that IS the
    // designed partner the pairing is honored and no severance may be invented.
    const slots = [
      callSlot('friC1', '2026-01-09', 'C1', 'friday'),
      callSlot('sunC2', '2026-01-11', 'C2', 'sunday'),
    ];
    const ctx = buildCtx(slots, [prov('p1'), prov('p2')], {
      callPattern: WEEKEND_V2_PATTERN, shiftTypes,
    });
    const plan = solve(ctx, { callOverrides: new Map([['sunC2', 'p1']]) });
    const fri = plan.assignments.find(a => a.slot_id === 'friC1');
    const sun = plan.assignments.find(a => a.slot_id === 'sunC2');
    expect(fri?.provider_id).toBe('p1');
    expect(sun?.provider_id).toBe('p1');
    expect((plan.skippedDerived ?? []).filter(s => s.code === 'C2')).toHaveLength(0);
  });
});

// ── pre-call fills are UNCONDITIONAL under Weekend v2 (Gabriel 2026-07-20) ───
// "Pre-call status should be given to anyone on call the following day. D1
// status is only dependent on the Call status from the day before, and D2 and
// D3 Status is only for the call status on the following day." The
// unlessCallWithinDays:2 conditions on the C1→D2 and C2→D3 pre-call links were
// ported from legacy behavior on 2026-07-12, never asked for — they waived the
// pre-call fill after ANY call within 2 days, which is how neuro-weekend Jones
// (Sun C3, Tue C1) lost her Monday D2. The schema feature stays (other
// patterns — classic included — may still use it); Weekend v2's DATA drops it.
describe('WEEKEND_V2_PATTERN — pre-call fills are unconditional (Gabriel 2026-07-20)', () => {
  const shiftTypes = new Map([
    ['C1', shiftInfo('C1', { category: 'call', call_rank: 0 })],
    ['C2', shiftInfo('C2', { category: 'call', call_rank: 1 })],
    ['C3', shiftInfo('C3', { category: 'call', call_rank: 2, is_overlay: true })],
  ]);

  it('Jones shape: C3 two days back + C1 tomorrow → the Monday D2 pre-fill LANDS', () => {
    // Seeded Sun C3 (neuro weekend tail) is 2 days before Tuesday's C1 — the
    // old waiver suppressed Monday D2 exactly here. D2 depends ONLY on
    // tomorrow's C1; the fill must land.
    const slots = [
      dSlot('monD2', '2026-01-12', 'D2', 'weekday'),
      callSlot('tueC1', '2026-01-13', 'C1', 'weekday'),
    ];
    const plan = solve(buildCtx(slots, [prov('p1')], {
      callPattern: WEEKEND_V2_PATTERN, shiftTypes,
      seedAssignments: [{
        slot_date: '2026-01-11', provider_id: 'p1',
        shift_type_code: 'C3', shift_type_category: 'call', derived_day_type: 'sunday',
      }],
    }));
    const byId = Object.fromEntries(plan.assignments.map(a => [a.slot_id, a.provider_id]));
    expect(byId['tueC1']).toBe('p1');
    expect(byId['monD2']).toBe('p1');
  });

  it('sibling link: C3 two days back + C2 tomorrow → the Monday D3 pre-fill LANDS', () => {
    const slots = [
      dSlot('monD3', '2026-01-12', 'D3', 'weekday'),
      callSlot('tueC2', '2026-01-13', 'C2', 'weekday'),
    ];
    const plan = solve(buildCtx(slots, [prov('p1')], {
      callPattern: WEEKEND_V2_PATTERN, shiftTypes,
      seedAssignments: [{
        slot_date: '2026-01-11', provider_id: 'p1',
        shift_type_code: 'C3', shift_type_category: 'call', derived_day_type: 'sunday',
      }],
    }));
    const byId = Object.fromEntries(plan.assignments.map(a => [a.slot_id, a.provider_id]));
    expect(byId['tueC2']).toBe('p1');
    expect(byId['monD3']).toBe('p1');
  });

  it('D1 OVERRIDES D2: C2 on day X−1 and C1 on day X+1 → day X = D1, D2 open with the honest orphan reason', () => {
    // Gabriel 2026-07-20: "unless it was a C2, in which case her D1 status
    // would override the D2 status." Mechanism, pinned here: the C2 fills in
    // date order and its +1 D1 lands FIRST; the next day's C1 then tries the
    // −1 D2 pre-fill, hits the same-date gate (the provider already holds D1),
    // and the link severs with a RECORDED 'occupied' skip (invariant 4). The
    // sequence-owned D2 slot stays open and is reported once, honestly.
    const engineShiftTypes = new Map([
      ['C1', shiftInfo('C1', { category: 'call', call_rank: 0, generation_engine: 'call' })],
      ['C2', shiftInfo('C2', { category: 'call', call_rank: 1, generation_engine: 'call' })],
      ['D1', shiftInfo('D1', { generation_engine: 'call' })],
      ['D2', shiftInfo('D2', { generation_engine: 'call' })],
    ]);
    const slots = [
      callSlot('monC2', '2026-01-12', 'C2', 'weekday'), // day X−1
      dSlot('tueD1', '2026-01-13', 'D1', 'weekday'),    // day X
      dSlot('tueD2', '2026-01-13', 'D2', 'weekday'),    // day X
      callSlot('wedC1', '2026-01-14', 'C1', 'weekday'), // day X+1
    ];
    const plan = solve(buildCtx(slots, [prov('p1')], {
      callPattern: WEEKEND_V2_PATTERN, shiftTypes: engineShiftTypes,
    }));
    const byId = Object.fromEntries(plan.assignments.map(a => [a.slot_id, a.provider_id]));
    expect(byId['monC2']).toBe('p1');
    expect(byId['wedC1']).toBe('p1');
    // Day X = D1 (post-2nd-call wins the day).
    expect(byId['tueD1']).toBe('p1');
    // The D2 pre-fill severed on the same-date gate — recorded, never silent…
    expect(plan.skippedDerived).toContainEqual(
      { date: '2026-01-13', code: 'D2', provider_id: 'p1', reason: 'occupied' });
    // …and the sequence-owned D2 slot stays open, reported exactly once.
    expect(plan.assignments.some(a => a.slot_id === 'tueD2')).toBe(false);
    const orphans = plan.unfilled.filter(u => u.slot_id === 'tueD2');
    expect(orphans).toHaveLength(1);
    expect(orphans[0].reason).toBe('sequence-orphan: chain link severed');
  });
});

// ── friday-first Doc A: the starved-Sunday failure mode moves to Sunday ──────
// The whole point of the re-anchor (spec 2026-07-15): when the pool cannot
// cover Doc A's full Fri-C1 + Sun-C2 pair, the IN-HOUSE Friday C1 still fills
// and the blank lands on the Sunday home-call — never the other way around
// (the old sunday anchor starved first and blanked Friday C1 with it).
describe('friday-first Doc A — starved Sunday leaves Sun C2 (not Fri C1) unfilled', () => {
  it('fills Fri C1 and reports Sun C2 unfilled when nobody can take Sunday', () => {
    const sundayPto = [{
      availability_type: 'pto', start_date: '2026-01-11', end_date: '2026-01-11',
      approval_status: 'approved',
    }];
    const slots = [
      callSlot('friC1', '2026-01-09', 'C1', 'friday'),
      callSlot('sunC2', '2026-01-11', 'C2', 'sunday'),
    ];
    const shiftTypes = new Map([
      ['C1', shiftInfo('C1', { category: 'call', call_rank: 0 })],
      ['C2', shiftInfo('C2', { category: 'call', call_rank: 1 })],
    ]);
    const plan = solve(buildCtx(slots, [prov('p1'), prov('p2')], {
      callPattern: WEEKEND_V2_PATTERN, shiftTypes,
      availByPid: new Map([['p1', sundayPto], ['p2', sundayPto]]),
    }));
    // Friday C1 fills — the anchor never blanks with its starved link.
    expect(plan.assignments.find(a => a.slot_id === 'friC1')?.provider_id).toBeDefined();
    expect(plan.unfilled.some(u => u.slot_id === 'friC1')).toBe(false);
    // The blank is Sunday C2, reported honestly.
    const sunUnfilled = plan.unfilled.find(u => u.slot_id === 'sunC2');
    expect(sunUnfilled).toBeDefined();
    expect(sunUnfilled!.candidates?.every(c => c.reason === 'availability-blocked')).toBe(true);
    expect(plan.assignments.some(a => a.slot_id === 'sunC2')).toBe(false);
  });
});
