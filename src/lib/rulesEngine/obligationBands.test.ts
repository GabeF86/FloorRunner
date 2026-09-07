// Stated call obligations in the CallPatternDoc (Gabriel 2026-08-03).
//
// The table under test is his, verbatim, and the totals are pinned against the
// live 8/10–10/25 Paoli block, where the three part-FTE call takers hold
// EXACTLY their band (Simon 13/13, Havildar 13.5/13.5 incl. the shared 12h
// Saturday, Hussain 11/11). If a change here moves one of these numbers it has
// changed a real physician's clinical obligation.
import { describe, it, expect } from 'vitest';
import {
  CallPatternDocSchema,
  CLASSIC_PATTERN,
  obligationBandFor,
  owedCallsFor,
  obligationWarnings,
  referencedCodes,
  type CallPatternDoc,
  type PatternObligations,
} from './callPattern';
import { derivedTargetsFor, type DerivationBasis } from '@/lib/blockTargets';
import { BUCKET_KEYS } from '@/lib/paoliBlock/manifest';

/** Gabriel's stated table. Neuro is deliberately absent — it is owed in
 * weekend UNITS by neuroWeekend.requirementBands. */
const PAOLI_OBLIGATIONS = {
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
    { minFte: 0.75, calls: [
      { dayType: 'weekday', code: 'C1', count: 3 },
      { dayType: 'weekday', code: 'C2', count: 3 },
      // Fri C1 chain (friday anchor, C1 → C2 at offset +2)
      { dayType: 'friday', code: 'C1', count: 1 },
      { dayType: 'sunday', code: 'C2', count: 1 },
      // Sat C2 chain (saturday anchor, C2 → C2 at -1, C1 at +1)
      { dayType: 'friday', code: 'C2', count: 1 },
      { dayType: 'saturday', code: 'C2', count: 1 },
      { dayType: 'sunday', code: 'C1', count: 1 },
    ] },
    { minFte: 0.7, calls: [
      { dayType: 'weekday', code: 'C1', count: 3 },
      { dayType: 'weekday', code: 'C2', count: 3 },
      { dayType: 'friday', code: 'C1', count: 1 },
      { dayType: 'sunday', code: 'C2', count: 1 },
      { dayType: 'saturday', code: 'C1', count: 1 },
    ] },
    { minFte: 0, calls: [
      { dayType: 'weekday', code: 'C1', count: 2 },
      { dayType: 'weekday', code: 'C2', count: 2 },
      { dayType: 'saturday', code: 'C1', count: 1.5 },
      { dayType: 'friday', code: 'C2', count: 1 },
      { dayType: 'sunday', code: 'C2', count: 1 },
    ] },
  ],
} as const;

const withObligations = (): CallPatternDoc => CallPatternDocSchema.parse({
  ...CLASSIC_PATTERN,
  neuroWeekend: { code: 'C3', requirementBands: [{ minFte: 0, units: 1 }] },
  obligations: PAOLI_OBLIGATIONS,
});

/** Calls owed excluding neuro — the number the band itself states. */
const totalOwed = (doc: CallPatternDoc, fte: number): number => {
  const owed = owedCallsFor(doc, fte);
  return owed ? [...owed.values()].reduce((s, v) => s + v, 0) : NaN;
};

describe('obligation bands — Gabriel\'s stated table', () => {
  it('parses', () => {
    expect(() => withObligations()).not.toThrow();
  });

  // Neuro adds 2 calls (Sat C3 + Sun C3) on top of every one of these.
  it.each([
    [1.0, 14],   // + neuro 2 = 16
    [0.75, 11],  // + neuro 2 = 13
    [0.7, 9],    // + neuro 2 = 11
    [0.5, 7.5],  // + neuro 2 = 9.5
  ])('FTE %s owes %s non-neuro calls', (fte, expected) => {
    expect(totalOwed(withObligations(), fte)).toBeCloseTo(expected, 6);
  });

  it('states the per-bucket table for a 1.0 FTE', () => {
    expect(Object.fromEntries(owedCallsFor(withObligations(), 1)!)).toEqual({
      'weekday|C1': 4, 'weekday|C2': 4,
      'friday|C1': 1, 'friday|C2': 1,
      'saturday|C1': 1, 'saturday|C2': 1,
      'sunday|C1': 1, 'sunday|C2': 1,
    });
  });

  it('gives the 0.5 FTE 1.5 Saturday C1 — one whole plus half the 12h split', () => {
    expect(owedCallsFor(withObligations(), 0.5)!.get('saturday|C1')).toBe(1.5);
  });

  it('is NOT the FTE formula: 0.75 is stated 13 where slots÷par×FTE derives 12', () => {
    // 176 call slots ÷ par 11 × 0.75 = 12, the number this table deliberately
    // supersedes (his model is whole chains, not fractional shares).
    expect(totalOwed(withObligations(), 0.75) + 2).toBe(13);
  });
});

describe('band resolution', () => {
  it('picks the HIGHEST band the FTE clears', () => {
    expect(obligationBandFor(withObligations(), 0.8)!.minFte).toBe(0.75);
    expect(obligationBandFor(withObligations(), 0.72)!.minFte).toBe(0.7);
    expect(obligationBandFor(withObligations(), 0.67)!.minFte).toBe(0);
  });

  it('clears a floor through stored-fraction noise', () => {
    // 0.75 arriving as 0.7499999 must still land on the 0.75 band, not 0.7.
    expect(obligationBandFor(withObligations(), 0.7499999)!.minFte).toBe(0.75);
  });

  it('an exact band boundary resolves to its own band', () => {
    expect(obligationBandFor(withObligations(), 1)!.minFte).toBe(1);
    expect(obligationBandFor(withObligations(), 0.7)!.minFte).toBe(0.7);
  });
});

describe('absent obligations = today\'s behavior, exactly', () => {
  it('CLASSIC_PATTERN states none', () => {
    const doc = CallPatternDocSchema.parse(CLASSIC_PATTERN);
    expect(doc.obligations).toBeUndefined();
    expect(obligationBandFor(doc, 1)).toBeNull();
    expect(owedCallsFor(doc, 1)).toBeNull();
    expect(obligationWarnings(doc, [1, 0.5])).toEqual([]);
  });

  it('a doc that clears no band falls back rather than owing zero', () => {
    const doc = CallPatternDocSchema.parse({
      ...CLASSIC_PATTERN,
      obligations: { bands: [{ minFte: 0.75, calls: [{ dayType: 'weekday', code: 'C1', count: 3 }] }] },
    });
    // 0.5 clears no band: null (use the formula), NOT an empty map (owe nothing).
    expect(owedCallsFor(doc, 0.5)).toBeNull();
  });
});

describe('schema rejects what would silently change an obligation', () => {
  it('rejects duplicate band minFte', () => {
    expect(() => CallPatternDocSchema.parse({
      ...CLASSIC_PATTERN,
      obligations: { bands: [
        { minFte: 0.75, calls: [{ dayType: 'weekday', code: 'C1', count: 3 }] },
        { minFte: 0.75, calls: [{ dayType: 'weekday', code: 'C1', count: 4 }] },
      ] },
    })).toThrow(/duplicate minFte 0\.75/);
  });

  it('rejects a bucket stated twice inside one band', () => {
    expect(() => CallPatternDocSchema.parse({
      ...CLASSIC_PATTERN,
      obligations: { bands: [{ minFte: 1, calls: [
        { dayType: 'weekday', code: 'C1', count: 4 },
        { dayType: 'weekday', code: 'C1', count: 3 },
      ] }] },
    })).toThrow(/weekday\|C1 twice/);
  });

  it('rejects a holiday day type — dayTypeBucketOn folds holidays onto the weekday', () => {
    expect(() => CallPatternDocSchema.parse({
      ...CLASSIC_PATTERN,
      obligations: { bands: [{ minFte: 1, calls: [
        { dayType: 'major_holiday', code: 'C1', count: 1 },
      ] }] },
    })).toThrow();
  });

  it('rejects an empty bands array', () => {
    expect(() => CallPatternDocSchema.parse({
      ...CLASSIC_PATTERN, obligations: { bands: [] },
    })).toThrow();
  });
});

describe('derivedTargetsFor — the panel/engine derivation reads the bands', () => {
  // The live 8/10–10/25 Paoli slate, so the formula path produces the real
  // numbers the bands are being compared against.
  const basis = (obligations: PatternObligations | null): DerivationBasis => ({
    slotCounts: {
      MTH_C1: 44, MTH_C2: 44, FRI_C1: 11, FRI_C2: 11,
      SAT_C1: 11, SAT_C2: 11, SUN_C1: 11, SUN_C2: 11, NEURO_FSS: 11,
    },
    parLevel: 11,
    neuro: { code: 'C3', requirementBands: [{ minFte: 0, units: 1 }] },
    obligations,
  });
  const bands = withObligations().obligations!;

  it('a 1.0 FTE derives the same either way — the formula already agreed', () => {
    const formula = derivedTargetsFor(1, basis(null));
    const stated = derivedTargetsFor(1, basis(bands));
    expect(stated).toEqual(formula);
  });

  it('a 0.75 FTE takes WHOLE chain calls where the formula gave fractions', () => {
    expect(derivedTargetsFor(0.75, basis(null))).toMatchObject({
      MTH_C1: 3, FRI_C1: 0.75, SUN_C2: 0.75, SAT_C1: 0.75,
    });
    expect(derivedTargetsFor(0.75, basis(bands))).toMatchObject({
      MTH_C1: 3, MTH_C2: 3,
      FRI_C1: 1, SUN_C2: 1,          // Fri C1 chain
      FRI_C2: 1, SAT_C2: 1, SUN_C1: 1, // Sat C2 chain
      SAT_C1: 0,                      // not in the band — owed zero, not derived
      NEURO_FSS: 1,
    });
  });

  it('an unnamed bucket inside a stated band is ZERO, never re-derived', () => {
    // Paoli's 0.7 band names no Friday C2; the formula would have given 0.7.
    expect(derivedTargetsFor(0.7, basis(null)).FRI_C2).toBeCloseTo(0.7, 6);
    expect(derivedTargetsFor(0.7, basis(bands)).FRI_C2).toBe(0);
  });

  it('carries the 0.5 FTE\'s 1.5 Saturday C1 through to the panel', () => {
    expect(derivedTargetsFor(0.5, basis(bands)).SAT_C1).toBe(1.5);
  });

  it('NEURO_FSS always comes from requirementBands, never from a call band', () => {
    expect(derivedTargetsFor(0.5, basis(bands)).NEURO_FSS).toBe(1);
    // No neuro config at all → 0, whatever the call bands say.
    expect(derivedTargetsFor(0.5, { ...basis(bands), neuro: null }).NEURO_FSS).toBe(0);
  });

  it('an FTE below every band keeps the formula', () => {
    const partial = { bands: [bands.bands[0]] }; // minFte 1 only
    expect(derivedTargetsFor(0.5, basis(partial)).MTH_C1)
      .toBe(derivedTargetsFor(0.5, basis(null)).MTH_C1);
  });

  it('block totals: the stated table sums to his numbers', () => {
    const total = (fte: number) => {
      const t = derivedTargetsFor(fte, basis(bands));
      // NEURO_FSS is one weekend UNIT = a Sat C3 + Sun C3 pair = 2 calls.
      return BUCKET_KEYS.reduce(
        (s, k) => s + (k === 'NEURO_FSS' ? t[k] * 2 : t[k]), 0);
    };
    expect(total(1)).toBe(16);
    expect(total(0.75)).toBe(13);
    expect(total(0.7)).toBe(11);
    expect(total(0.5)).toBe(9.5);
  });
});

describe('load-time warnings', () => {
  it('warns, naming the FTEs, when the roster falls below every band', () => {
    const doc = CallPatternDocSchema.parse({
      ...CLASSIC_PATTERN,
      obligations: { bands: [{ minFte: 0.75, calls: [{ dayType: 'weekday', code: 'C1', count: 3 }] }] },
    });
    const [warning] = obligationWarnings(doc, [1, 0.75, 0.5, 0.7]);
    expect(warning).toMatch(/no band for FTE 0\.5, 0\.7/);
    expect(warning).toMatch(/keep the DERIVED formula/);
  });

  it('does not warn when a bottom band makes the table total', () => {
    expect(obligationWarnings(withObligations(), [1, 0.75, 0.7, 0.5, 0.6])).toEqual([]);
  });

  it('warns when a band restates the neuro code as calls', () => {
    const doc = CallPatternDocSchema.parse({
      ...CLASSIC_PATTERN,
      neuroWeekend: { code: 'C3', requirementBands: [{ minFte: 0, units: 1 }] },
      obligations: { bands: [{ minFte: 0, calls: [
        { dayType: 'saturday', code: 'C3', count: 1 },
        { dayType: 'sunday', code: 'C3', count: 1 },
      ] }] },
    });
    expect(obligationWarnings(doc, [1])[0]).toMatch(/counted twice/);
  });

  it('surfaces a band code that does not exist at the site', () => {
    const doc = withObligations();
    expect(referencedCodes(doc)).toContain('C1');
    expect(referencedCodes(doc)).toContain('C2');
  });
});
