import { describe, expect, it } from 'vitest';
import { matchRoster, normalizeName } from './names';
import { TEST_ROSTER } from './__fixtures__/syntheticFullWorkbook';

describe('normalizeName', () => {
  it('trims, collapses internal whitespace, and lowercases', () => {
    expect(normalizeName('Simon ')).toBe('simon');
    expect(normalizeName('  Gabriel   Farkas ')).toBe('gabriel farkas');
    expect(normalizeName('KALAWADIA')).toBe('kalawadia');
  });
});

describe('matchRoster', () => {
  it('matches `Simon ` (trailing space) uniquely to the Simon roster entry', () => {
    const { matches, errors } = matchRoster(['Simon '], TEST_ROSTER);
    expect(errors).toEqual([]);
    expect(matches[0]).toMatchObject({
      sourceName: 'Simon ',
      normalized: 'simon',
      providerId: 'prov-simon',
    });
  });

  it('matches case-insensitively via the last-name token of a full roster name', () => {
    const { matches, errors } = matchRoster(['FARKAS'], TEST_ROSTER);
    expect(errors).toEqual([]);
    expect(matches[0].providerId).toBe('prov-farkas');
  });

  it('unmatched name is a HARD error (Amusa missing from roster), never fuzzy', () => {
    const noAmusa = TEST_ROSTER.filter((r) => r.id !== 'prov-amusa');
    const { matches, errors } = matchRoster(['Amusa', 'Jones'], noAmusa);
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/Amusa/);
    expect(errors[0]).toMatch(/unmatched/i);
    expect(matches.find((m) => m.sourceName === 'Amusa')!.providerId).toBeNull();
    expect(matches.find((m) => m.sourceName === 'Jones')!.providerId).toBe('prov-jones');
  });

  it('ambiguous match (two providers could match) is a HARD error', () => {
    const roster = [...TEST_ROSTER, { id: 'prov-simon2', name: 'Ted Simon' }];
    const { matches, errors } = matchRoster(['Simon '], roster);
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/ambiguous/i);
    expect(errors[0]).toMatch(/Simon/);
    expect(matches[0].providerId).toBeNull();
  });

  it('duplicate workbook rows for the same provider are a HARD error', () => {
    const { errors } = matchRoster(['Jones', 'JONES '], TEST_ROSTER);
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/duplicate/i);
  });
});
