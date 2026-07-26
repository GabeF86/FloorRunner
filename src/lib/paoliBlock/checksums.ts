/**
 * Import checksum engine: computes provider-row count, ΣFTE, and per-bucket
 * target totals, and compares them against expected values when provided.
 * A mismatch is REPORTED (per-key), never silent — and never "fixed" by
 * rounding: fractional credits are first-class (8.75 FTE, Sun C1 8.5, …).
 */

import type { BucketKey, ChecksumReport, ChecksumValues } from './manifest';
import { BUCKET_KEYS } from './manifest';

/** The full-workbook expected checksums from the Paoli prompt. */
export const PROMPT_EXPECTED_CHECKSUMS: ChecksumValues = {
  providerRows: 10,
  totalFte: 8.75,
  targets: {
    MTH_C1: 35,
    MTH_C2: 35,
    FRI_C1: 9,
    FRI_C2: 8,
    SAT_C1: 8,
    SAT_C2: 6,
    SUN_C1: 8.5,
    SUN_C2: 8,
    NEURO_FSS: 10,
  },
};

export interface ChecksumRow {
  fte: number;
  targets: Record<BucketKey, number>;
}

/** Kill binary-float noise (0.1+0.2 → 0.3) without disturbing real decimals. */
function clean(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

const EPS = 1e-6;

export function computeChecksums(rows: ChecksumRow[]): ChecksumValues {
  const targets = Object.fromEntries(BUCKET_KEYS.map((k) => [k, 0])) as Record<BucketKey, number>;
  let totalFte = 0;
  for (const row of rows) {
    totalFte += row.fte;
    for (const k of BUCKET_KEYS) targets[k] += row.targets[k] ?? 0;
  }
  for (const k of BUCKET_KEYS) targets[k] = clean(targets[k]);
  return { providerRows: rows.length, totalFte: clean(totalFte), targets };
}

export function compareChecksums(
  computed: ChecksumValues,
  expected: ChecksumValues | null,
): ChecksumReport {
  if (!expected) return { computed, expected: null, comparisons: [], ok: null };

  const comparisons = [
    { key: 'provider_rows', expected: expected.providerRows, actual: computed.providerRows },
    { key: 'total_fte', expected: expected.totalFte, actual: computed.totalFte },
    ...BUCKET_KEYS.map((k) => ({
      key: k as string,
      expected: expected.targets[k],
      actual: computed.targets[k],
    })),
  ].map((c) => ({ ...c, ok: Math.abs(c.expected - c.actual) < EPS }));

  return { computed, expected, comparisons, ok: comparisons.every((c) => c.ok) };
}
