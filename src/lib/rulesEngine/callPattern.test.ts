import { describe, it, expect } from 'vitest';
import {
  CallPatternDocSchema, CLASSIC_PATTERN, dayChainsFor, postCallBlockOffsets,
  blockChainsFor, referencedCodes, patternWarnings,
} from './callPattern';
import { WEEKEND_V2_PATTERN } from './patterns/weekendV2';

describe('CallPatternDocSchema', () => {
  it('accepts the classic pattern', () => {
    expect(() => CallPatternDocSchema.parse(CLASSIC_PATTERN)).not.toThrow();
  });
  it('rejects unknown keys and bad day types', () => {
    expect(() => CallPatternDocSchema.parse({ ...CLASSIC_PATTERN, bogus: 1 })).toThrow();
    expect(() => CallPatternDocSchema.parse({
      ...CLASSIC_PATTERN,
      blocks: [{ anchorDayType: 'caturday', chains: [] }],
    })).toThrow();
  });
  it('accepts the proposed weekend structure from the spec (§5.3)', () => {
    const proposed = {
      version: 1,
      blocks: [{ anchorDayType: 'friday', chains: [
        { trigger: 'C1', links: [{ offset: 2, code: 'C2' }] },
        { trigger: 'C2', links: [{ offset: 1, code: 'C2' }] } ] }],
      dayChains: [
        { trigger: 'C1', dayTypes: ['friday', 'saturday', 'sunday'], blocks: [{ offset: 1 }] },
        { trigger: 'C2', dayTypes: ['sunday'], links: [{ offset: 1, code: 'D1' }] } ],
      spans: [{ code: 'NB', anchorDayType: 'friday', offsets: [0, 1, 2] }],
      placementPasses: [],
      reliefPass: { enabled: true, dayTypes: ['weekday'] },
      optimizerMovableDayTypes: ['weekday'],
    };
    expect(() => CallPatternDocSchema.parse(proposed)).not.toThrow();
  });
});

describe('helpers', () => {
  it('dayChainsFor matches trigger + dayType scope', () => {
    expect(dayChainsFor(CLASSIC_PATTERN, 'C1', 'weekday')).toHaveLength(1);
    expect(dayChainsFor(CLASSIC_PATTERN, 'C1', 'saturday')).toHaveLength(0); // weekend block owns Saturday
    expect(dayChainsFor(CLASSIC_PATTERN, 'C2', 'sunday')[0].links?.[0].code).toBe('D1');
  });
  it('postCallBlockOffsets: C1 blocks next day on weekday/sunday, not saturday', () => {
    expect(postCallBlockOffsets(CLASSIC_PATTERN, 'C1', 'weekday')).toEqual([1]);
    expect(postCallBlockOffsets(CLASSIC_PATTERN, 'C1', 'sunday')).toEqual([1]);
    expect(postCallBlockOffsets(CLASSIC_PATTERN, 'C1', 'saturday')).toEqual([]);
    expect(postCallBlockOffsets(CLASSIC_PATTERN, 'C2', 'weekday')).toEqual([]);
  });
  it('blockChainsFor returns the saturday chain map', () => {
    const chains = blockChainsFor(CLASSIC_PATTERN, 'saturday');
    expect(chains.get('C1')).toEqual([{ offset: 1, code: 'C2' }, { offset: -1, code: 'C2' }]);
    expect(blockChainsFor(CLASSIC_PATTERN, 'friday').size).toBe(0);
  });
  it('referencedCodes lists every code the pattern mentions', () => {
    const codes = referencedCodes(CLASSIC_PATTERN);
    for (const c of ['C1', 'C2', 'C3', 'D1', 'D2', 'D3']) expect(codes).toContain(c);
  });
  it('patternWarnings flags codes missing from the known set', () => {
    const known = new Set(['C1', 'C2', 'C3', 'D1', 'D2']); // D3 missing
    const warnings = patternWarnings(CLASSIC_PATTERN, known);
    expect(warnings.some(w => w.includes('D3'))).toBe(true);
    expect(patternWarnings(CLASSIC_PATTERN, new Set([...known, 'D3']))).toEqual([]);
  });
});

/* ── minFte links + neuroWeekend config (2026-07-27) ─────────────────────── */

describe('block-chain link minFte', () => {
  const doc = (links: unknown[]) => ({
    version: 1,
    blocks: [{ anchorDayType: 'saturday', chains: [{ trigger: 'C3', links }] }],
    dayChains: [], spans: [], placementPasses: [],
    reliefPass: null, optimizerMovableDayTypes: [],
  });

  it('accepts a link carrying minFte', () => {
    const parsed = CallPatternDocSchema.parse(doc([{ offset: 1, code: 'C3', minFte: 0.75 }]));
    expect(parsed.blocks[0].chains[0].links[0].minFte).toBe(0.75);
  });

  it('leaves minFte undefined when absent (every existing doc)', () => {
    const parsed = CallPatternDocSchema.parse(doc([{ offset: 1, code: 'C3' }]));
    expect(parsed.blocks[0].chains[0].links[0].minFte).toBeUndefined();
  });

  it('rejects an out-of-range minFte', () => {
    expect(() => CallPatternDocSchema.parse(doc([{ offset: 1, code: 'C3', minFte: 2 }]))).toThrow();
  });
});

describe('neuroWeekend config', () => {
  const base = {
    version: 1, blocks: [], dayChains: [], spans: [], placementPasses: [],
    reliefPass: null, optimizerMovableDayTypes: [],
  };

  it('parses a band list', () => {
    const parsed = CallPatternDocSchema.parse({
      ...base,
      neuroWeekend: {
        code: 'C3',
        requirementBands: [{ minFte: 1, units: 0 }, { minFte: 0.75, units: 1 }, { minFte: 0, units: 0.5 }],
      },
    });
    expect(parsed.neuroWeekend?.requirementBands).toHaveLength(3);
  });

  it('is optional — docs without it parse unchanged', () => {
    expect(CallPatternDocSchema.parse(base).neuroWeekend).toBeUndefined();
  });

  it('CLASSIC_PATTERN and WEEKEND_V2_PATTERN still parse', () => {
    expect(() => CallPatternDocSchema.parse(CLASSIC_PATTERN)).not.toThrow();
    expect(() => CallPatternDocSchema.parse(WEEKEND_V2_PATTERN)).not.toThrow();
  });
});
