// post-call repair pass — Gabriel's live report, 2026-07-29.
//
// "I see that Jones is C2 on 8/13 but listed as D4 the following day, why did
// that happen? I know shes on Neuro call that weekend, but if there are two
// linked D spots for one provider, obviously the lower one should have
// priority."
//
// The weekend pass runs before the weekday pass (dayTypeFillOrder), so the
// saturday neuro anchor's −1 D4 claimed the Friday first; the Thursday C2's
// +1 D1 then found the provider already working that day and gave up, leaving
// D1 open. These fixtures reproduce that exact shape and pin the repair.
import { describe, it, expect } from 'vitest';
import { solve } from '../solve';
import { buildCtx, prov, callSlot, dSlot } from '../__fixtures__/buildContext';
import { WEEKEND_V2_PATTERN } from '../patterns/weekendV2';
import { CallPatternDocSchema } from '../callPattern';
import type { GenerationContext } from '../genTypes';

// Thu 2026-08-13, Fri 08-14, Sat 08-15, Sun 08-16 — Gabriel's actual dates.
const THU = '2026-08-13';
const FRI = '2026-08-14';
const SAT = '2026-08-15';
const SUN = '2026-08-16';

/** The collision board: a Thursday C2 (→ +1 D1 Friday) and a Saturday neuro
 * anchor (→ −1 D4 Friday) that the same provider is the obvious pick for.
 *
 * SLOT ORDER IS LOAD-BEARING. Production sorts slotsToFill by the pattern's
 * dayTypeFillOrder inside genContext (saturday, friday, sunday, weekday) —
 * buildCtx does NOT, it takes the array as given. Listing the weekday slots
 * first hands the Thursday C2 its Friday D1 before the neuro anchor ever
 * runs, and the collision this pass exists for never forms. So the call slots
 * below are in weekendV2's dayTypeFillOrder, exactly as the real loader emits
 * them, and the saturday neuro anchor claims Friday D4 first. */
function collisionCtx(over: Partial<GenerationContext> = {}): GenerationContext {
  const slots = [
    // saturday → friday → sunday → weekday (weekendV2 dayTypeFillOrder)
    callSlot('sat-c1', SAT, 'C1', 'saturday'), callSlot('sat-c2', SAT, 'C2', 'saturday'),
    callSlot('sat-c3', SAT, 'C3', 'saturday'),
    callSlot('fri-c1', FRI, 'C1', 'friday'), callSlot('fri-c2', FRI, 'C2', 'friday'),
    callSlot('sun-c1', SUN, 'C1', 'sunday'), callSlot('sun-c2', SUN, 'C2', 'sunday'),
    callSlot('sun-c3', SUN, 'C3', 'sunday'),
    callSlot('thu-c1', THU, 'C1'), callSlot('thu-c2', THU, 'C2'),
    // day slots (never in slotsToFill; reachable only as chain/relief targets)
    dSlot('fri-d1', FRI, 'D1', 'friday'), dSlot('fri-d2', FRI, 'D2', 'friday'),
    dSlot('fri-d4', FRI, 'D4', 'friday'),
  ];
  const providers = [prov('p1'), prov('p2'), prov('p3'), prov('p4'), prov('p5')];
  return buildCtx(slots, providers, { callPattern: WEEKEND_V2_PATTERN, ...over });
}

describe('post-call repair pass', () => {
  // Gabriel's exact report. Force the SAME provider onto the saturday neuro
  // anchor (→ −1 Friday D4) and the Thursday C2 (→ +1 Friday D1), which is the
  // collision he found on Jones 8/13 and Kalawadia 8/20.
  const neuroAndThursdayC2 = new Map([['sat-c3', 'p3'], ['thu-c2', 'p3']]);

  it('moves the neuro doc out of Friday D4 into the Friday D1 their Thursday C2 declared', () => {
    const plan = solve(collisionCtx(), { callOverrides: neuroAndThursdayC2 });

    expect(plan.assignments.find(a => a.slot_id === 'sat-c3')!.provider_id).toBe('p3');
    expect(plan.assignments.find(a => a.slot_id === 'thu-c2')!.provider_id).toBe('p3');

    // The whole point: the post-call D1 is theirs, and D4 is not.
    expect(plan.assignments.find(a => a.slot_id === 'fri-d1')?.provider_id).toBe('p3');
    expect(plan.assignments.find(a => a.slot_id === 'fri-d4')?.provider_id).not.toBe('p3');

    expect(plan.postCallRepairs).toEqual([{
      date: FRI, provider_id: 'p3', provider_name: 'p3',
      from_code: 'D4', to_code: 'D1', trigger_date: THU, trigger_code: 'C2',
    }]);
  });

  it('repairs a dayChain pre-call fill too, not just the weekend block chain', () => {
    // Unforced, the collision lands on the saturday-C1 doc instead: their
    // Friday D2 (weekend-chain) yields to the Friday D1 their Thursday C2
    // declared. Same rule, different source — pinned so a gate that only
    // recognised one link kind fails here.
    const plan = solve(collisionCtx());
    expect(plan.postCallRepairs).toEqual([
      expect.objectContaining({ date: FRI, to_code: 'D1', trigger_code: 'C2' }),
    ]);
    const r = plan.postCallRepairs![0];
    expect(plan.assignments.find(a => a.slot_id === 'fri-d1')?.provider_id).toBe(r.provider_id);
  });

  it('leaves the vacated slot OPEN for the later passes, never dark', () => {
    // Running before relief/mop-up is the reason this holds — the D4 the neuro
    // doc left must still be fillable by somebody else.
    const plan = solve(collisionCtx(), { callOverrides: neuroAndThursdayC2 });
    const d4 = plan.assignments.find(a => a.slot_id === 'fri-d4');
    // Either refilled by another provider, or genuinely open — never held by
    // the provider who was moved out of it.
    expect(d4?.provider_id).not.toBe('p3');
  });

  it('never steals a post-call slot somebody else already holds', () => {
    const ctx = collisionCtx({
      seedAssignments: [{
        slot_date: FRI, provider_id: 'p5', shift_type_code: 'D1',
        shift_type_category: 'regular', derived_day_type: 'friday', slot_id: 'fri-d1',
      }],
    });
    const plan = solve(ctx, { callOverrides: neuroAndThursdayC2 });
    expect(plan.assignments.find(a => a.slot_id === 'fri-d1')).toBeUndefined();
    expect(plan.postCallRepairs).toBeUndefined();
  });

  it('never steals a post-call slot filled EARLIER IN THIS RUN', () => {
    // The seed guard cannot cover this: here the Friday D1 is claimed during
    // the main loop by a SECOND provider. Only handledSlotIds stands between
    // the repair and a double-booked slot.
    //
    // Built on a SYNTHETIC doc (the idiom patternEngine.test.ts uses) because
    // no SHIPPED pattern can produce it: weekendV2's only other +1 D1 triggers
    // are C2's split segments, which are manual_only and never engine-placed.
    // The guard is still real — a pattern may legally declare this — so it is
    // pinned against a doc that does.
    const doc = CallPatternDocSchema.parse({
      version: 1,
      spans: [],
      blocks: [{ anchorDayType: 'saturday', chains: [
        { trigger: 'C3', links: [{ offset: -1, code: 'D4' }] },
      ] }],
      dayChains: [
        { trigger: 'CA', dayTypes: ['weekday'], links: [{ offset: 1, code: 'D1' }] },
        { trigger: 'CB', dayTypes: ['weekday'], links: [{ offset: 1, code: 'D1' }] },
      ],
      placementPasses: [],
      reliefPass: { enabled: false, dayTypes: ['weekday'] },
      optimizerMovableDayTypes: [],
    });
    const slots = [
      callSlot('sat-c3', SAT, 'C3', 'saturday'),
      callSlot('thu-cb', THU, 'CB'),   // ← reaches Friday D1 first
      callSlot('thu-ca', THU, 'CA'),
      dSlot('fri-d1', FRI, 'D1', 'friday'), dSlot('fri-d4', FRI, 'D4', 'friday'),
    ];
    const ctx = buildCtx(slots, [prov('p3'), prov('p5')], { callPattern: doc });
    const plan = solve(ctx, {
      callOverrides: new Map([['sat-c3', 'p3'], ['thu-cb', 'p5'], ['thu-ca', 'p3']]),
    });

    // p3 is on the neuro anchor and therefore Friday D4; p5 holds Friday D1.
    expect(plan.assignments.find(a => a.slot_id === 'fri-d4')?.provider_id).toBe('p3');
    expect(plan.assignments.find(a => a.slot_id === 'fri-d1')?.provider_id).toBe('p5');
    // Exactly ONE assignment for the D1 — p3 was not moved on top of p5.
    expect(plan.assignments.filter(a => a.slot_id === 'fri-d1')).toHaveLength(1);
    expect(plan.postCallRepairs).toBeUndefined();
  });

  it('never relocates a provider out of a CALL placed by a chain link', () => {
    // THE LABOR DAY GUARD. Gabriel's 9/4-9/7 weekend is built on people
    // holding a call the day after another call; he told us to keep it
    // ("fill the labor day weekend ... as it was initially"). If this pass
    // treated a chain-placed CALL as relocatable, editing that weekend would
    // silently pull someone off a call into a day slot.
    //
    // Synthetic doc: the saturday anchor chains a CALL onto the Friday
    // (source 'weekend-chain', which the source gate DOES accept), and the
    // Thursday call declares a +1 D1 on that same Friday. Only the
    // category === 'regular' gate stands between the two.
    const doc = CallPatternDocSchema.parse({
      version: 1,
      spans: [],
      blocks: [{ anchorDayType: 'saturday', chains: [
        { trigger: 'C3', links: [{ offset: -1, code: 'CB' }] },
      ] }],
      dayChains: [
        { trigger: 'CA', dayTypes: ['weekday'], links: [{ offset: 1, code: 'D1' }] },
      ],
      placementPasses: [],
      reliefPass: { enabled: false, dayTypes: ['weekday'] },
      optimizerMovableDayTypes: [],
    });
    const slots = [
      callSlot('sat-c3', SAT, 'C3', 'saturday'),
      callSlot('fri-cb', FRI, 'CB', 'friday'),
      callSlot('thu-ca', THU, 'CA'),
      dSlot('fri-d1', FRI, 'D1', 'friday'),
    ];
    const ctx = buildCtx(slots, [prov('p3'), prov('p5')], { callPattern: doc });
    const plan = solve(ctx, {
      callOverrides: new Map([['sat-c3', 'p3'], ['thu-ca', 'p3']]),
    });

    // p3 holds the chain-placed Friday CALL…
    expect(plan.assignments.find(a => a.slot_id === 'fri-cb')?.provider_id).toBe('p3');
    // …and was NOT pulled out of it into the open D1.
    expect(plan.assignments.find(a => a.slot_id === 'fri-d1')?.provider_id).not.toBe('p3');
    expect(plan.postCallRepairs ?? []).not.toContainEqual(
      expect.objectContaining({ from_code: 'CB' }));
  });

  it('leaves the plan alone when there is nothing to repair (field stays absent)', () => {
    // No competing day slot ⇒ the +1 D1 link fills normally and the pass is a
    // no-op. Lazy materialization keeps every existing golden plan pin valid.
    const slots = [callSlot('thu-c2', THU, 'C2'), dSlot('fri-d1', FRI, 'D1', 'friday')];
    const plan = solve(buildCtx(slots, [prov('p1'), prov('p2')],
      { callPattern: WEEKEND_V2_PATTERN }));
    expect(plan.assignments.find(a => a.slot_id === 'fri-d1')).toBeDefined();
    expect(plan.postCallRepairs).toBeUndefined();
  });

  it('never relocates anyone out of a CALL, and never double-books a date', () => {
    const plan = solve(collisionCtx(), { callOverrides: neuroAndThursdayC2 });
    for (const date of [THU, FRI, SAT, SUN]) {
      const onDate = plan.assignments.filter(a => a.slot_date === date);
      // C3 is an overlay at this site, so the neuro doc may legitimately hold
      // a call plus an overlay call; every OTHER pairing would be a clash.
      const nonOverlay = onDate.filter(a => a.shift_type_code !== 'C3');
      expect(new Set(nonOverlay.map(a => a.provider_id)).size).toBe(nonOverlay.length);
    }
    expect(plan.assignments.filter(a => a.slot_id === 'fri-c1')).toHaveLength(1);
  });
});
