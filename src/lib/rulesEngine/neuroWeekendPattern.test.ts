// Neuro weekend FTE gate (spec 2026-07-27): the Sat C3 → Sun C3 pair fires
// for 0.75+ docs and is suppressed for anyone below, leaving the Sunday as a
// remainder slot. Pure fixture contexts — no DB.
import { describe, it, expect } from 'vitest';
import { solve } from './solve';
import { CallPatternDocSchema } from './callPattern';
import { buildCtx, prov, callSlot } from './__fixtures__/buildContext';
import { sp, scen } from './__fixtures__/scenarioFixtures';

// Minimal pattern: the Paoli neuro block, nothing else.
const NEURO_DOC = CallPatternDocSchema.parse({
  version: 1,
  blocks: [{ anchorDayType: 'saturday', chains: [
    { trigger: 'C3', links: [{ offset: 1, code: 'C3', minFte: 0.75 }] },
  ] }],
  dayChains: [], spans: [], placementPasses: [],
  reliefPass: null, optimizerMovableDayTypes: [],
  neuroWeekend: {
    code: 'C3',
    requirementBands: [{ minFte: 1, units: 0 }, { minFte: 0.75, units: 1 }, { minFte: 0, units: 0.5 }],
  },
});

// 2026-08-15 = Saturday, 2026-08-16 = Sunday.
const SAT = '2026-08-15';
const SUN = '2026-08-16';
const slots = () => [
  callSlot('sat-c3', SAT, 'C3', 'saturday'),
  callSlot('sun-c3', SUN, 'C3', 'sunday'),
];

const filledBy = (plan: { assignments: Array<{ slot_id: string; provider_id: string }> }, slotId: string) =>
  plan.assignments.find(a => a.slot_id === slotId)?.provider_id ?? null;

// `filledBy(...) === anchor` alone is VACUOUS on a single-provider fixture:
// the main loop backfills the Sunday whether or not the chain fired, so the
// assertion holds even if the pair is suppressed for everyone. The
// discriminator is the placement SOURCE — only the block chain stamps
// 'weekend-chain' — plus an empty skippedDerived (a fired pair records no
// severance). Together these kill the "suppress for every provider" and the
// "wrong epsilon direction" mutants.
const expectPairFired = (
  plan: { assignments: Array<{ slot_id: string; source: string }>; skippedDerived?: unknown[] },
) => {
  expect(plan.assignments.find(a => a.slot_id === 'sun-c3')?.source).toBe('weekend-chain');
  expect(plan.skippedDerived).toEqual([]);
};

describe('neuro pair FTE gate', () => {
  it('a 1.0 anchor takes BOTH weekend days', () => {
    const ctx = buildCtx(slots(), [prov('full', 1)], { callPattern: NEURO_DOC });
    const plan = solve(ctx);
    expect(filledBy(plan, 'sat-c3')).toBe('full');
    expect(filledBy(plan, 'sun-c3')).toBe('full');
    expectPairFired(plan);
  });

  // The BOUNDARY case: 0.75 against a 0.75 floor must clear it. This is what
  // pins the epsilon direction (fte + WEIGHT_EPSILON, never minus).
  it('a 0.75 anchor takes BOTH weekend days', () => {
    const ctx = buildCtx(slots(), [prov('three4', 0.75)], { callPattern: NEURO_DOC });
    const plan = solve(ctx);
    expect(filledBy(plan, 'sat-c3')).toBe('three4');
    expect(filledBy(plan, 'sun-c3')).toBe('three4');
    expectPairFired(plan);
  });

  // NOTE the seam between this task and the remainder gate: the FTE gate only
  // suppresses the CHAIN link. It does not make the orphaned Sunday unfillable
  // — the main construction loop still reaches that slot like any other open
  // call slot. Keeping the leftover day away from a doc who does not owe it is
  // the eligibility gate's job, which reads neuroRemainderSlotIds and is
  // pinned by the 'neuro remainder gate' cases. So this case asserts exactly
  // what the chain gate itself guarantees: Saturday placed, the designed
  // partner NOT pulled onto the same provider, and the severance recorded
  // (clinical invariant 4).
  it('a 0.5 anchor is not pulled onto Sunday by the chain, and the skip is recorded', () => {
    const ctx = buildCtx(slots(), [prov('half', 0.5)], { callPattern: NEURO_DOC });
    const plan = solve(ctx);
    expect(filledBy(plan, 'sat-c3')).toBe('half');
    expect(plan.skippedDerived).toContainEqual(
      { date: SUN, code: 'C3', provider_id: 'half', reason: 'fte-gated' });
    // The chain placed NOTHING. Asserted over the whole plan rather than as
    // `sun-c3`'s source, so it stays sharp once the remainder gate legitimately
    // leaves the Sunday unfilled — a `?.source` check would go vacuously true
    // the moment the slot is empty.
    expect(plan.assignments.filter(a => a.source === 'weekend-chain')).toEqual([]);
  });
});

// The gate must also suppress the link's RESERVATION, in both reservation
// paths. Each path independently decides whether the ANCHOR can be placed at
// all, so over-reserving for a link that will never fire blanks the Saturday
// and leaves the orphan Sunday filled — anchor day empty, leftover day
// covered, precisely backwards.
describe('neuro pair FTE gate — reservation', () => {
  // Path 1: chainCallNeeds, the obligation reservation (solve.ts's forced and
  // candidate gates). parLevel 1 over 2 call slots makes a 0.5 doc's
  // obligation exactly 1 — room for the anchor only.
  it('a sub-floor anchor is not charged obligation room for the gated link', () => {
    const ctx = buildCtx(slots(), [prov('half', 0.5)],
      { callPattern: NEURO_DOC, parLevel: 1 });
    const plan = solve(ctx, { fillMode: 'obligatory' });
    // Charged for the pair (1 + 1 > 1), the anchor itself would be refused.
    // THIS is the discriminator for over-reservation: the mutant blanks it.
    expect(filledBy(plan, 'sat-c3')).toBe('half');
    // REASON UPDATED 2026-07-27 (Task 5): this asserted 'obligation-cap'. The
    // Sunday still stays OPEN — unchanged, and that is what the case is about
    // — but the neuro remainder gate now refuses 'half' during ELIGIBILITY
    // (they owe 0.5 and earned 0.5 on Saturday, so they are no longer short),
    // and cap reasons are only computed downstream for candidates that PASS
    // eligibility. So the more specific gate legitimately wins the report.
    // Caps keep their own coverage in providerLimitCaps/obligatoryMode tests.
    expect(filledBy(plan, 'sun-c3')).toBe(null);
    expect(plan.unfilled).toContainEqual(expect.objectContaining({
      slot_id: 'sun-c3',
      candidates: [expect.objectContaining({ provider_id: 'half', reason: 'neuro-remainder' })],
    }));
  });

  // Path 2: liveBlockChainCallLinks, the provider_limits cap reservation
  // (admitsUnderCallCaps). A C3 ceiling of 1 is exactly enough for the
  // anchor; charging the gated Sunday too made the Saturday 'provider-cap'.
  it('a sub-floor anchor is not charged provider-cap room for the gated link', () => {
    const ctx = buildCtx(slots(), [prov('half', 0.5)],
      { callPattern: NEURO_DOC, providerLimits: { half: { calls: { C3: 1 } } } });
    const plan = solve(ctx);
    // THIS is the discriminator for over-reservation: the mutant blanks it.
    expect(filledBy(plan, 'sat-c3')).toBe('half');
    // The orphan stays open — one C3 total either way. REASON UPDATED
    // 2026-07-27 (Task 5), same precedence note as the obligation case above:
    // the neuro remainder gate refuses 'half' at eligibility before the
    // provider cap is ever consulted.
    expect(filledBy(plan, 'sun-c3')).toBe(null);
    expect(plan.unfilled).toContainEqual(expect.objectContaining({
      slot_id: 'sun-c3',
      candidates: [expect.objectContaining({ provider_id: 'half', reason: 'neuro-remainder' })],
    }));
  });

  // Path 3: preferScenarioChainClean, the scenario chain-clean STEERING that
  // shares liveBlockChainCallLinks. Unlike the two cap paths this one does not
  // gate the anchor — it narrows the candidate pool — so its regression is
  // silent: the Saturday still fills, just with the wrong doc and a severed
  // pairing. Requires an active scenario AND a minFte link, which is exactly
  // the live Paoli neuro configuration.
  it('a gated link cannot make its anchor scenario-unclean', () => {
    // Every candidate is prohibited on the chained SUNDAY, so for the 0.75 and
    // 1.0 docs the designed pair is unsatisfiable — placing them on Saturday
    // severs it. The 0.5 doc's link is FTE-gated and never fires, so they
    // sever nothing and are the only chain-clean anchor.
    const sunBan = () => new Map([['C3', new Set([SUN])]]);
    const ctx = buildCtx(slots(),
      [prov('half', 0.5), prov('three4', 0.75), prov('full', 1)],
      { callPattern: NEURO_DOC, scenario: scen([
        sp('half', { prohibitedDatesByCode: sunBan() }),
        sp('three4', { prohibitedDatesByCode: sunBan() }),
        sp('full', { prohibitedDatesByCode: sunBan() }),
      ]) });
    const plan = solve(ctx);
    // Ungated, the link is live for EVERYONE, nobody is clean, and the
    // filter falls back to the whole pool — 'full' wins the anchor on score
    // and its designed Sunday is then severed by the prohibition.
    expect(filledBy(plan, 'sat-c3')).toBe('half');
    // Second axis: the only record is the FTE gate declining to fire, NOT a
    // severed pairing. Ungated this reads { provider_id: 'full',
    // reason: 'ineligible' } — a real severance the steering exists to avoid.
    expect(plan.skippedDerived).toEqual([
      { date: SUN, code: 'C3', provider_id: 'half', reason: 'fte-gated' },
    ]);
  });
});

// CORRECTED 2026-07-27 (caught during execution, second plan defect in this
// feature): the drafted fixtures for this task were `[prov('half', 0.5),
// prov('full', 1)]` with no availability shaping, and asserted the 0.5 doc
// anchors Saturday. It does not — nothing in the engine makes a sub-floor doc
// win a neuro anchor until Task 6's steering lands, so `full` took Saturday,
// the pair FIRED (1.0 clears the 0.75 floor), neuroRemainderSlotIds stayed
// EMPTY and the gate under test was never exercised at all. The third case was
// unfixable by Task 6 too: with no neuroWeekend config there is no steering
// term by construction, so `full` anchors Saturday forever.
//
// The fix keeps every assertion's intent and removes the dependency on a
// later task: close SATURDAY for the docs who must not anchor. That forces the
// sub-floor doc onto the anchor, which is the ONLY way to mint a remainder
// slot — while leaving the excluded docs fully eligible for the leftover
// SUNDAY, which is exactly the candidate this gate has to refuse. Availability
// is Sun..Sat, so index 6 is Saturday.
const NO_SATURDAY = { available_weekdays: [true, true, true, true, true, true, false] };

describe('neuro remainder gate', () => {
  it('a full-FTE doc may NOT take the leftover day — it stays open', () => {
    const ctx = buildCtx(slots(),
      [prov('half', 0.5), prov('full', 1, NO_SATURDAY)], { callPattern: NEURO_DOC });
    const plan = solve(ctx);
    expect(filledBy(plan, 'sat-c3')).toBe('half');
    expect(filledBy(plan, 'sun-c3')).toBe(null);           // NOT the full doc
    expect(plan.unfilled.some(u => u.slot_id === 'sun-c3')).toBe(true);
  });

  it('a 0.75 doc still short of a full weekend MAY take the leftover day', () => {
    // 'full' is in the pool precisely so the assertion below has something to
    // exclude: the leftover Sunday must never fall to the 1.0 doc, and a short
    // partial doc may hold it. Both non-anchors are Saturday-closed so 'half'
    // is forced onto the anchor and the remainder actually exists.
    const ctx = buildCtx(slots(),
      [prov('half', 0.5), prov('three4', 0.75, NO_SATURDAY), prov('full', 1, NO_SATURDAY)],
      { callPattern: NEURO_DOC });
    const plan = solve(ctx);
    const sun = filledBy(plan, 'sun-c3');
    expect(sun).not.toBe('full');
    expect(sun === null || sun === 'three4' || sun === 'half').toBe(true);
    // The plan's two assertions above both pass VACUOUSLY on an empty Sunday —
    // they would hold even if the gate wrongly refused everyone. Test 1 already
    // pins the refusal side; this pins the ADMISSION side, which is the entire
    // point of this case: 'three4' owes a full weekend and holds none, so they
    // are short by 1.0 unit and the gate must let them through.
    expect(sun).toBe('three4');
  });

  it('the gate is inert without a neuroWeekend config', () => {
    const noConfig = CallPatternDocSchema.parse({
      version: 1,
      blocks: [{ anchorDayType: 'saturday', chains: [
        { trigger: 'C3', links: [{ offset: 1, code: 'C3', minFte: 0.75 }] },
      ] }],
      dayChains: [], spans: [], placementPasses: [],
      reliefPass: null, optimizerMovableDayTypes: [],
    });
    const ctx = buildCtx(slots(),
      [prov('half', 0.5), prov('full', 1, NO_SATURDAY)], { callPattern: noConfig });
    const plan = solve(ctx);
    // Pair still suppressed by minFte, but with no requirement vocabulary the
    // remainder is an ordinary open slot the main loop may fill. Identical
    // fixture to test 1 apart from the config, so the ONLY thing that can move
    // the Sunday from 'full' to empty is the config check on the gate.
    expect(filledBy(plan, 'sat-c3')).toBe('half');
    expect(filledBy(plan, 'sun-c3')).toBe('full');
  });
});

// CORRECTED 2026-07-27 (third fixture defect in this feature, same class as
// the two above). The drafted fixture was two weekends over `[prov('full', 1),
// prov('three4', 0.75)]`, asserting `three4` holds >= 2 assignments. It PASSED
// before the steering existed: with one doc per weekend the per-FTE fairness
// ratio already alternates them — `full` takes weekend 1, its bucket ratio
// rises, and `three4` wins weekend 2 unaided. The case never exercised the
// tier, and `>= 2` would also have accepted two stray Saturdays rather than a
// designed pair.
//
// The corrected fixture reproduces Gabriel's actual complaint — full-timers
// take EVERY neuro weekend in the block and the 0.75 doc gets none — and pins
// the loss to the fairness RATIO rather than an incidental id tiebreak:
//   • TWO full-timers for TWO weekends, so fairness alone has no reason to
//     ever reach the 0.75 doc.
//   • The 0.75 doc carries prior weekend C3 history, so its per-FTE ratio
//     (2 / 0.75 = 2.67) is strictly worse than either full-timer's 0. This is
//     the realistic shape: a part-timer who has already carried weekend call
//     sorts BEHIND full-timers forever, which is exactly why the requirement
//     needs a tier of its own.
//   • The full-timers are named `zfull*` so the final id tiebreak FAVOURS
//     `three4`. Nothing but the neuro tier can win them a weekend, so the case
//     cannot pass for an accidental reason.
// Verified against the pre-steering engine: `three4` held ZERO of the four
// slots (zfull1 took weekend 1, zfull2 weekend 2).
describe('neuro requirement steering', () => {
  const SAT2 = '2026-08-22';
  const SUN2 = '2026-08-23';
  const twoWeekends = () => [
    callSlot('sat1', SAT, 'C3', 'saturday'),
    callSlot('sun1', SUN, 'C3', 'sunday'),
    callSlot('sat2', SAT2, 'C3', 'saturday'),
    callSlot('sun2', SUN2, 'C3', 'sunday'),
  ];
  // pid -> "bucket|code" -> count, from past blocks. Deliberately NOT neuro
  // credit: the requirement is per-block, so this history worsens the fairness
  // ratio without paying down anything `creditedUnitsByProvider` can see.
  const THREE4_PRIOR = () =>
    new Map([['three4', new Map([['saturday|C3', 2], ['sunday|C3', 2]])]]);

  const steeringCtx = () => buildCtx(twoWeekends(),
    [prov('three4', 0.75), prov('zfull1', 1), prov('zfull2', 1)],
    { callPattern: NEURO_DOC, historicalAssignedByPid: THREE4_PRIOR() });

  it('gives the doc who owes a neuro weekend one of them', () => {
    const plan = solve(steeringCtx());
    // The plan drafted `held.length >= 2`, which two stray SATURDAYS would
    // satisfy. Asserting the slot ids pins a designed Sat+Sun PAIR — the only
    // thing that credits a full unit and actually discharges the requirement.
    const held = plan.assignments
      .filter(a => a.provider_id === 'three4').map(a => a.slot_id).sort();
    expect(held).toEqual(['sat1', 'sun1']);
  });

  // A TIER, never a gate. The full-timers owe nothing, so a steering term that
  // had hardened into eligibility would strand the second weekend; instead the
  // remaining weekend still fills, on ordinary fairness.
  it('steering does not gate — the other weekend still fills', () => {
    const plan = solve(steeringCtx());
    expect(filledBy(plan, 'sat2')).toBe('zfull1');
    expect(filledBy(plan, 'sun2')).toBe('zfull1');
    expect(plan.unfilled).toEqual([]);
    expect(plan.skippedDerived).toEqual([]);
  });

  // The term must be dead weight for every pattern that states no neuro
  // requirement — the guarantee behind "golden parity is unmoved".
  it('the steering is inert without a neuroWeekend config', () => {
    const noConfig = CallPatternDocSchema.parse({
      version: 1,
      blocks: [{ anchorDayType: 'saturday', chains: [
        { trigger: 'C3', links: [{ offset: 1, code: 'C3', minFte: 0.75 }] },
      ] }],
      dayChains: [], spans: [], placementPasses: [],
      reliefPass: null, optimizerMovableDayTypes: [],
    });
    const ctx = buildCtx(twoWeekends(),
      [prov('three4', 0.75), prov('zfull1', 1), prov('zfull2', 1)],
      { callPattern: noConfig, historicalAssignedByPid: THREE4_PRIOR() });
    const plan = solve(ctx);
    // Identical fixture to the steering case apart from the config, so this is
    // the pre-steering result byte for byte: the 0.75 doc gets nothing.
    expect(plan.assignments.filter(a => a.provider_id === 'three4')).toEqual([]);
    expect(filledBy(plan, 'sat1')).toBe('zfull1');
    expect(filledBy(plan, 'sat2')).toBe('zfull2');
  });
});
