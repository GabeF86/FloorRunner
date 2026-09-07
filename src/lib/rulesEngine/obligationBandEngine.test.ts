// Stated obligation bands reaching the ENGINE (Gabriel 2026-08-03, "I would
// like you to change the engine to follow these obligations when it builds a
// draft schedule").
//
// Two surfaces:
//   • applyObligationBandTargets — the quota/steering target the greedy loop
//     reads through ctx.bucketTarget (eligibility's `assigned + 1 > target`).
//   • totalExpectedCalls / computeObligations — the obligatory-mode CEILING.
//
// The invariant every test here defends: a pattern with no `obligations` key
// behaves EXACTLY as it did before this feature, so every other site, every
// fixture and golden parity are untouched.
import { describe, it, expect } from 'vitest';
import { applyObligationBandTargets } from './genContext';
import { totalExpectedCalls, computeObligations } from './obligation';
import { CallPatternDocSchema, CLASSIC_PATTERN, type CallPatternDoc } from './callPattern';
import type { CandidateProvider, GenerationContext } from './genTypes';

const PAOLI_BANDS = {
  bands: [
    { minFte: 1, calls: [
      { dayType: 'weekday', code: 'C1', count: 4 },
      { dayType: 'weekday', code: 'C2', count: 4 },
      { dayType: 'friday', code: 'C1', count: 1 },
      { dayType: 'friday', code: 'C2', count: 1 },
      { dayType: 'saturday', code: 'C1', count: 1 },
      { dayType: 'saturday', code: 'C2', count: 1 },
      { dayType: 'sunday', code: 'C1', count: 1 },
      { dayType: 'sunday', code: 'C2', count: 1 },
    ] },
    { minFte: 0.7, calls: [
      { dayType: 'weekday', code: 'C1', count: 3 },
      { dayType: 'weekday', code: 'C2', count: 3 },
      { dayType: 'friday', code: 'C1', count: 1 },
      { dayType: 'sunday', code: 'C2', count: 1 },
      { dayType: 'saturday', code: 'C1', count: 1 },
    ] },
  ],
};

// Paoli's real neuro shape: a Sat→Sun chain, so one weekend UNIT = 2 calls.
const doc = (obligations?: unknown): CallPatternDoc => CallPatternDocSchema.parse({
  ...CLASSIC_PATTERN,
  blocks: [{ anchorDayType: 'saturday', chains: [
    { trigger: 'C3', links: [{ offset: 1, code: 'C3' }] },
    ...CLASSIC_PATTERN.blocks[0].chains.filter(c => c.trigger !== 'C3'),
  ] }],
  neuroWeekend: { code: 'C3', requirementBands: [{ minFte: 0, units: 1 }] },
  ...(obligations ? { obligations } : {}),
});

const provider = (id: string, fte: number): CandidateProvider =>
  ({ id, fte_value: fte } as CandidateProvider);

/** The floored FTE targets the band override receives in production. */
function flooredTargets(pids: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const pid of pids) {
    for (const bucket of ['weekday', 'friday', 'saturday', 'sunday']) {
      for (const code of ['C1', 'C2', 'C3']) out.set(`${pid}|${bucket}|${code}`, 2);
    }
  }
  return out;
}

describe('applyObligationBandTargets', () => {
  const providers = [provider('full', 1), provider('part', 0.7), provider('tiny', 0.2)];
  const targets = () => flooredTargets(['full', 'part', 'tiny']);

  it('sets a 1.0 FTE to the stated table', () => {
    const out = applyObligationBandTargets(targets(), providers, doc(PAOLI_BANDS));
    expect(out.get('full|weekday|C1')).toBe(4);
    expect(out.get('full|friday|C1')).toBe(1);
    expect(out.get('full|sunday|C2')).toBe(1);
  });

  it('ZEROES a governed bucket the band leaves out — a band is exhaustive', () => {
    // Paoli's 0.7 band names no Friday C2, so Hussain owes none. The floor had
    // lifted it to 2; the band must win.
    const out = applyObligationBandTargets(targets(), providers, doc(PAOLI_BANDS));
    expect(out.get('part|friday|C2')).toBe(0);
    expect(out.get('part|saturday|C2')).toBe(0);
    expect(out.get('part|weekday|C1')).toBe(3);
  });

  it('leaves the NEURO code alone — it is owed in weekend units, not calls', () => {
    // Zeroing C3 here would starve the tier neuroWeekend separately requires.
    const out = applyObligationBandTargets(targets(), providers, doc(PAOLI_BANDS));
    expect(out.get('full|saturday|C3')).toBe(2);
    expect(out.get('part|sunday|C3')).toBe(2);
  });

  it('an FTE below every band keeps the formula target, never a silent zero', () => {
    const out = applyObligationBandTargets(targets(), providers, doc(PAOLI_BANDS));
    expect(out.get('tiny|weekday|C1')).toBe(2);
    expect(out.get('tiny|friday|C2')).toBe(2);
  });

  it('is a no-op when the pattern states no bands', () => {
    const before = targets();
    const after = applyObligationBandTargets(before, providers, doc());
    expect(after).toBe(before);           // same reference — provably untouched
  });

  it('does not mutate the map it is given', () => {
    const before = targets();
    applyObligationBandTargets(before, providers, doc(PAOLI_BANDS));
    expect(before.get('full|weekday|C1')).toBe(2);
  });
});

describe('totalExpectedCalls — the obligatory-mode ceiling', () => {
  const ctx = (pattern: CallPatternDoc, fte: number): GenerationContext => ({
    parLevel: 11,
    providers: [provider('p', fte)],
    slotsToFill: [],
    manualCallSlots: [],
    seedAssignments: [],
    shiftTypes: new Map(),
    callPattern: pattern,
  } as unknown as GenerationContext);

  it.each([
    [1, 16],
    [0.7, 11],
  ])('FTE %s owes %s calls — band + neuro units × 2 calls per unit', (fte, expected) => {
    expect(totalExpectedCalls(ctx(doc(PAOLI_BANDS), fte)).get('p')).toBeCloseTo(expected, 6);
  });

  it('reads the neuro calls-per-unit off the pattern, never hardcoded 2', () => {
    // A site standing a LONE neuro day: one unit is one call, so 14 + 1 = 15.
    const lone = CallPatternDocSchema.parse({
      ...CLASSIC_PATTERN,
      blocks: [{ anchorDayType: 'saturday', chains: [{ trigger: 'C3', links: [{ offset: -1, code: 'D4' }] }] }],
      neuroWeekend: { code: 'C3', requirementBands: [{ minFte: 0, units: 1 }] },
      obligations: PAOLI_BANDS,
    });
    expect(totalExpectedCalls(ctx(lone, 1)).get('p')).toBeCloseTo(15, 6);
  });

  it('falls back to slots ÷ par × FTE when the pattern states no bands', () => {
    const noBands = {
      ...ctx(doc(), 1),
      slotsToFill: Array.from({ length: 176 }, () => (
        { required_count: 1, shift_type_code: 'C1' })),
    } as unknown as GenerationContext;
    expect(totalExpectedCalls(noBands).get('p')).toBeCloseTo(16, 6);
  });

  it('computeObligations rounds the stated total', () => {
    // 0.7 states 11 exactly — a whole number already, so rounding is identity.
    expect(computeObligations(ctx(doc(PAOLI_BANDS), 0.7)).get('p')).toBe(11);
  });
});
