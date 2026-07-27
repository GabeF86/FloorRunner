// Neuro weekend FTE gate (spec 2026-07-27): the Sat C3 → Sun C3 pair fires
// for 0.75+ docs and is suppressed for anyone below, leaving the Sunday as a
// remainder slot. Pure fixture contexts — no DB.
import { describe, it, expect } from 'vitest';
import { solve } from './solve';
import { CallPatternDocSchema } from './callPattern';
import { buildCtx, prov, callSlot } from './__fixtures__/buildContext';

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
    expect(filledBy(plan, 'sat-c3')).toBe('half');
    expect(plan.unfilled).toContainEqual(
      expect.objectContaining({ slot_id: 'sun-c3', reason: 'obligation-cap' }));
  });

  // Path 2: liveBlockChainCallLinks, the provider_limits cap reservation
  // (admitsUnderCallCaps). A C3 ceiling of 1 is exactly enough for the
  // anchor; charging the gated Sunday too made the Saturday 'provider-cap'.
  it('a sub-floor anchor is not charged provider-cap room for the gated link', () => {
    const ctx = buildCtx(slots(), [prov('half', 0.5)],
      { callPattern: NEURO_DOC, providerLimits: { half: { calls: { C3: 1 } } } });
    const plan = solve(ctx);
    expect(filledBy(plan, 'sat-c3')).toBe('half');
    // The cap is still honored: one C3 total, so the orphan stays open.
    expect(filledBy(plan, 'sun-c3')).toBe(null);
    expect(plan.unfilled).toContainEqual(
      expect.objectContaining({ slot_id: 'sun-c3', reason: 'provider-cap' }));
  });
});
