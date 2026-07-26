import { describe, expect, it } from 'vitest';
import {
  BUCKET_KEYS,
  PAOLI_BLOCK_MANIFEST_VERSION,
  validateManifest,
  type PaoliBlockManifest,
} from './manifest';

function minimalManifest(): PaoliBlockManifest {
  return {
    manifestVersion: PAOLI_BLOCK_MANIFEST_VERSION,
    generatedAt: '2026-07-26T00:00:00.000Z',
    source: { workbook: 'test.xlsx', sheetName: 'Sheet4', shape: 'full' },
    defaultYear: 2026,
    callCodeLegend: {
      C1: 'Paoli first call (canonical engine shift id resolved in the engine-extension phase)',
    },
    checksums: {
      computed: {
        providerRows: 1,
        totalFte: 1,
        targets: Object.fromEntries(BUCKET_KEYS.map((k) => [k, 0])) as never,
      },
      expected: null,
      comparisons: [],
      ok: null,
    },
    providers: [
      {
        providerId: 'prov-x',
        sourceName: 'X ',
        normalizedName: 'x',
        scenarioFte: 1,
        targets: Object.fromEntries(BUCKET_KEYS.map((k) => [k, 0])) as never,
        prohibitions: [
          { dates: ['2026-09-05'], callCodes: 'all', source: 'No call 9/5' },
          { recurrence: { weekday: 'MON' }, callCodes: ['C1'], source: 'No Monday C1' },
        ],
        fixedAssignments: [{ date: '2026-09-07', code: 'C1', source: 'Must be C1 on 9/7' }],
        linkages: [{ kind: 'same-weekend', members: ['SAT:C1', 'SUN:C2'], source: 's' }],
        preferences: [{ kind: 'weekday', weekday: 'TUE', callCodes: ['C1'], source: 'p' }],
        sourceText: { noCall: 'No call 9/5', mandatory: 'Must be C1 on 9/7' },
        warnings: [],
        conflicts: [
          {
            kind: 'mandatory-vs-prohibition',
            date: '2026-09-05',
            code: 'C1',
            resolution: 'mandatory-retained',
            sources: ['L', 'M'],
          },
        ],
      },
    ],
    warnings: [],
    errors: [],
  };
}

describe('validateManifest', () => {
  it('accepts a well-formed manifest', () => {
    const res = validateManifest(minimalManifest());
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it('rejects a wrong manifestVersion', () => {
    const m = { ...minimalManifest(), manifestVersion: 2 };
    const res = validateManifest(m);
    expect(res.ok).toBe(false);
    expect(res.errors.join(' ')).toMatch(/manifestVersion/);
  });

  it('rejects non-ISO dates in prohibitions', () => {
    const m = minimalManifest();
    m.providers[0].prohibitions[0] = {
      dates: ['9/5'],
      callCodes: 'all',
      source: 'x',
    } as never;
    expect(validateManifest(m).ok).toBe(false);
  });

  it('rejects unknown linkage kinds', () => {
    const m = minimalManifest();
    m.providers[0].linkages[0] = { kind: 'buddy-system', members: ['a'], source: 's' } as never;
    expect(validateManifest(m).ok).toBe(false);
  });

  it('rejects a targets record missing a bucket key', () => {
    const m = minimalManifest();
    delete (m.providers[0].targets as Record<string, number>).NEURO_FSS;
    expect(validateManifest(m).ok).toBe(false);
  });

  it('rejects non-numeric targets', () => {
    const m = minimalManifest();
    (m.providers[0].targets as Record<string, unknown>).MTH_C1 = 'four';
    expect(validateManifest(m).ok).toBe(false);
  });
});
