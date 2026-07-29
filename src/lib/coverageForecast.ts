// Coverage forecast (Gabriel 2026-07-29) — "a count of the expected total
// number of each call I will need to find coverage for based on the length of
// the block and the pool of providers".
//
// THE QUESTION THIS ANSWERS is structural, not a read of the current draft:
// given this block's call slate and this pool, how much call is there that
// NOBODY owes? It is computable the moment a schedule exists, before a single
// assignment is made, which is the point — it is the number to plan pickups
// around, not a report on what happens to be unfilled right now.
//
// THE ARITHMETIC. Par-authoritative (Gabriel 2026-07-24): the stored
// call_par_level is the obligation denominator in both directions, so a pool
// whose ΣFTE is below par under-covers the block BY DESIGN and the remainder
// is the paid-pickup layer. One provider owes (slots ÷ par) × FTE of any
// bucket, so the whole pool owes (slots ÷ par) × ΣpoolFTE = slots × (ΣpoolFTE
// ÷ par). What is left is what has to be found:
//
//     needCoverage = slots × (1 − ΣpoolFTE ÷ par)
//
// At Paoli today — 8.70 pool FTE against par 11 — every bucket is 20.9%
// uncovered: 44 weekday C1 slots owe 34.8 and leave 9.2.
//
// WHY THE ROWS ARE FRACTIONAL AND THE TOTAL COMES TWICE. A provider's real
// obligation is their ROUNDED total (roundedObligation — one number for the
// whole block, which is also the cap obligatory mode enforces). That rounding
// cannot be attributed to a bucket: nobody owes "3.4 Friday C1s rounded". So
// the per-call rows are the honest fractional split, and `obligationGap` is
// the exact whole-call number obligatory generation will actually leave open
// (totalSlots − Σ roundedObligation). The two differ by the rounding only, and
// both are reported rather than one being quietly presented as the other.
//
// Reads its slate from computeCallObligationCensus (fteTarget.ts) — the same
// single pass the Call Counts columns and the over-par selection use — so a
// forecast can never disagree with the grid about how many calls exist or how
// they bucket.
import { WEIGHT_EPSILON } from './callBurden';
import { roundedObligation, type CallObligationCensus } from './fteTarget';
import { BUCKET_DAY_TYPES, type BucketDayType } from './callCountDays';

/** One call type's forecast. `bucket` is the engine's fairness bucket
 *  (a holiday counts as the weekday it falls on) and `code` the PARENT call
 *  code, so a split call counts once under the call it is a piece of. */
export interface CoverageForecastRow {
  bucket: BucketDayType;
  code: string;
  /** Call slots of this type in the block (weighted — a 12h half is 0.5). */
  slots: number;
  /** What the pool's obligations absorb: slots × ΣpoolFTE ÷ par. */
  covered: number;
  /** slots − covered: the pickups to find. Never negative — a pool at or above
   *  par owes the whole slate and this is 0, not a surplus. */
  needCoverage: number;
}

export interface CoverageForecast {
  rows: CoverageForecastRow[];
  totals: { slots: number; covered: number; needCoverage: number };
  /** The exact whole-call number obligatory generation leaves open:
   *  totalCallSlots − Σ roundedObligation over the pool. Differs from
   *  totals.needCoverage by per-provider rounding only. */
  obligationGap: number;
  poolFte: number;
  par: number;
  /** Fraction of every bucket the pool does NOT owe (0 when pool ≥ par). */
  uncoveredShare: number;
  /** False ⇒ `rows` is empty because a call slot could not be bucketed; the
   *  totals and obligationGap are still exact. Observable, never silent. */
  bucketed: boolean;
}

// Bucket order for display: M–Th, Fri, Sat, Sun (BUCKET_DAY_TYPES) — the same
// left-to-right order the Call Counts columns use, so the two read alike.
const bucketRank = (b: string) => {
  const i = (BUCKET_DAY_TYPES as readonly string[]).indexOf(b);
  return i < 0 ? BUCKET_DAY_TYPES.length : i;
};

/** Build the forecast from a census and the pool's provider ids.
 *
 * `poolProviderIds` is every provider the census may charge an obligation to;
 * the sum uses census.poolFteFor, which is 0 for anyone outside the call pool,
 * so passing extra ids (day docs, per-diems) cannot inflate coverage. */
export function computeCoverageForecast(
  census: CallObligationCensus,
  poolProviderIds: Iterable<string>,
): CoverageForecast {
  const par = census.effectivePar;
  const poolFte = census.poolFte;
  // A par of 0 (or worse) has no meaning as a denominator; fteWeightedTarget
  // already returns 0 there, so coverage is 0 and everything needs finding.
  const share = par > 0 ? poolFte / par : 0;
  const uncoveredShare = Math.max(0, 1 - share);

  const rows: CoverageForecastRow[] = [];
  if (census.bucketSlotWeight) {
    for (const [key, slots] of census.bucketSlotWeight) {
      // overParBucketKey is `${bucket}|${parentCode}`; the code may itself
      // contain no '|' by construction, so one split is exact.
      const sep = key.indexOf('|');
      if (sep < 0) continue;
      const bucket = key.slice(0, sep) as BucketDayType;
      const code = key.slice(sep + 1);
      const covered = slots * share;
      rows.push({
        bucket, code, slots, covered,
        needCoverage: Math.max(0, slots - covered),
      });
    }
    rows.sort((a, b) => bucketRank(a.bucket) - bucketRank(b.bucket)
      || a.code.localeCompare(b.code));
  }

  // Totals come from the census's own block total, NOT from summing rows —
  // in the unbucketed case there are no rows, and even when there are, the
  // census total is the authority both this and the grid already share.
  const slots = census.totalCallSlots;
  const covered = slots * share;

  let owed = 0;
  const counted = new Set<string>();
  for (const pid of poolProviderIds) {
    if (counted.has(pid)) continue;   // a duplicated id must not owe twice
    counted.add(pid);
    owed += roundedObligation(census.totalExpectedFor(pid));
  }

  return {
    rows,
    totals: { slots, covered, needCoverage: Math.max(0, slots - covered) },
    obligationGap: Math.max(0, slots - owed),
    poolFte,
    par,
    uncoveredShare,
    bucketed: census.bucketSlotWeight != null,
  };
}

/** Display rounding for a forecast figure: whole calls when it lands on one
 *  (within the stored-fraction tolerance the rest of the app uses), otherwise
 *  one decimal. 9.2 stays 9.2; 34.800000000000004 renders 34.8; 11.0 renders
 *  11 rather than "11.0". */
export function formatCalls(n: number): string {
  const whole = Math.round(n);
  if (Math.abs(n - whole) < WEIGHT_EPSILON) return String(whole);
  return n.toFixed(1);
}
