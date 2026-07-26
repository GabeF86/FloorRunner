import { describe, expect, it } from 'vitest';
import {
  computeChecksums,
  compareChecksums,
  PROMPT_EXPECTED_CHECKSUMS,
} from './checksums';
import { BUCKET_KEYS, type BucketKey } from './manifest';
import { SYNTHETIC_PROVIDERS } from './__fixtures__/syntheticFullWorkbook';

function syntheticRows() {
  return SYNTHETIC_PROVIDERS.map((p) => {
    const targets = {} as Record<BucketKey, number>;
    BUCKET_KEYS.forEach((k, i) => {
      targets[k] = p.targets[i];
    });
    return { fte: p.fte, targets };
  });
}

describe('computeChecksums', () => {
  const computed = computeChecksums(syntheticRows());

  it('counts provider rows', () => {
    expect(computed.providerRows).toBe(10);
  });

  it('sums FTE with decimals preserved (8.75, not 9)', () => {
    expect(computed.totalFte).toBe(8.75);
  });

  it('sums per-category targets, preserving fractional credits (Sun C1 = 8.5)', () => {
    expect(computed.targets).toEqual(PROMPT_EXPECTED_CHECKSUMS.targets);
    expect(computed.targets.SUN_C1).toBe(8.5);
  });

  it('is robust to binary-float noise in sums', () => {
    const rows = [0.1, 0.2].map((fte) => ({
      fte,
      targets: Object.fromEntries(BUCKET_KEYS.map((k) => [k, fte])) as Record<
        BucketKey,
        number
      >,
    }));
    const c = computeChecksums(rows);
    expect(c.totalFte).toBe(0.3);
    expect(c.targets.MTH_C1).toBe(0.3);
  });
});

describe('compareChecksums', () => {
  it('all-match comparison reports ok', () => {
    const report = compareChecksums(computeChecksums(syntheticRows()), PROMPT_EXPECTED_CHECKSUMS);
    expect(report.ok).toBe(true);
    expect(report.comparisons.every((c) => c.ok)).toBe(true);
    // 2 scalar checks + 9 buckets
    expect(report.comparisons.length).toBe(11);
  });

  it('mismatches are reported per key, never silently dropped', () => {
    const computed = computeChecksums(syntheticRows());
    const skewed = {
      ...PROMPT_EXPECTED_CHECKSUMS,
      targets: { ...PROMPT_EXPECTED_CHECKSUMS.targets, FRI_C1: 12, SAT_C2: 1 },
    };
    const report = compareChecksums(computed, skewed);
    expect(report.ok).toBe(false);
    const bad = report.comparisons.filter((c) => !c.ok).map((c) => c.key);
    expect(bad.sort()).toEqual(['FRI_C1', 'SAT_C2']);
    const fri = report.comparisons.find((c) => c.key === 'FRI_C1')!;
    expect(fri.expected).toBe(12);
    expect(fri.actual).toBe(9);
    // matching keys still reported as ok
    expect(report.comparisons.find((c) => c.key === 'provider_rows')!.ok).toBe(true);
    expect(report.comparisons.find((c) => c.key === 'total_fte')!.ok).toBe(true);
  });
});
