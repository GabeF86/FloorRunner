import { describe, it, expect } from 'vitest';
import {
  CallPatternDocSchema, CLASSIC_PATTERN, dayChainsFor, postCallBlockOffsets,
  blockChainsFor, referencedCodes, patternWarnings,
} from './callPattern';

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
