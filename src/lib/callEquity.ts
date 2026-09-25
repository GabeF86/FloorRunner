// Call equity — how the group's call burden is actually distributed, ranked
// and per-category (2026-09-24).
//
// Gabriel asked for two views, and he asked for BOTH deliberately:
//   (a) a LEADERBOARD — ranked, named, internal-only.
//   (b) a PER-CATEGORY DISTRIBUTION — each physician's calls-per-FTE in each
//       (day bucket × call code) against the group median and spread.
// (a) alone invites the wrong conversation ("who is at the bottom"); (b) alone
// buries the one thing a partner actually wants to know. They ship together.
//
// ── THIS MODULE ASSEMBLES; IT DOES NOT DERIVE ──────────────────────────────
// Nothing here walks a slot, reads a DB row, or decides what a call is worth.
// Every domain rule routes to its existing single home:
//   - fairness bucket        → rulesEngine/shared.dayTypeBucketOn, applied
//     upstream by plannerMath.computeScheduleActuals; this module receives
//     counts ALREADY bucketed and never re-derives one.
//   - split-call weighting   → callBurden.callBurdenWeight / parentCallCodeOf,
//     applied upstream by annualTally.annualCallCounts (or by
//     callCountColumns.computeCallCountColumns). `count` arrives WEIGHTED.
//   - column order / labels  → callCountColumns.orderCallCodes, BUCKET_LABELS.
//   - expected per bucket    → fteTarget.fteWeightedTarget — (slate weight ÷
//     par) × FTE, the same formula the grid's over-par cells and the Call
//     Counts modal use. Par is `sites.call_par_level`, AUTHORITATIVE.
//   - the bucket key itself  → fteTarget.overParBucketKey.
// The ONLY arithmetic this module owns is the equity arithmetic: per-FTE
// normalization, order statistics, and ranking.
//
// ── PER-FTE IS NOT A PRESENTATION CHOICE ───────────────────────────────────
// Raw counts make every 0.75 and 0.5 FTE physician look like a slacker. That
// is arithmetic, not performance, and a named leaderboard that sorts on raw
// counts is a defamation machine with a table for a face. Clinical invariant 5
// says burden distributes per-FTE; so does every quota in the engine. So the
// leaderboard's stated sort key is CALLS PER FTE and the ranked value is
// always carried with the FTE that produced it (see `leaderboardRows`).
//
// Providers with FTE 0 (or an unstated FTE) are EXCLUDED, not zeroed — the
// same rule as rulesEngine/burdenMetrics.callCounts, and for the same two
// reasons: they carry no obligation, and n/0 is not a rank. They are returned
// in `excluded` rather than dropped, because a partner missing from a named
// leaderboard is a question, and "silently absent" is the worst answer to it.
//
// ── THE PRIOR-CALLS LESSON, TRANSLATED ─────────────────────────────────────
// burdenMetrics.ts exists because two scripts counted only the calls placed IN
// THE PLAN while the solver folded in `priorCalls` — the call a provider
// already held ELSEWHERE in the block. Comparing those two numbers made the
// engine look 5x worse than it was. The metric did not error; it quietly
// answered a different question.
//
// The same trap here wears a different costume: 56 of 207 providers work at
// 2+ sites, so a "burden" figure scoped to ONE site is measuring a subset of a
// provider's call and calling it their burden. That is the identical bug. So
// scope is a REQUIRED, EXPLICIT discriminator (`EquityScope`) — there is no
// default — every row carries the sites it was summed from, and a single-site
// table whose roster contains multi-site providers says so in `notes`.
//
// ── NO COMPOSITE FAIRNESS SCORE ────────────────────────────────────────────
// Deliberately absent. The group's established no-netting rule (fteTarget.ts,
// Gabriel 2026-08-03: "if someone is above any of their obligatory calls, it
// should show up in the above obligatory column for that specific call,
// regardless if they are missing a different type of call somewhere else")
// says an extra weekday C2 and a missing Saturday are not the same money and
// must not cancel. A single "equity score" is exactly that cancellation with
// a decimal point on it. Per-category is the whole point.
//
// ── EVERY OUTPUT CARRIES ITS COVERED SPAN ──────────────────────────────────
// Published data starts 2026-09-01. A "YTD" leaderboard today shows about
// three weeks, and a partner rendered as "4 calls YTD" reads as the system
// under-counting them, not as the schedule being three weeks old. So
// `EquityCoverage` is required on every entry point, the covered span is
// derived from the PUBLISHED SEGMENTS (never from the requested window), and
// `coverageLabel` refuses to print a bare start–end range when the segments
// have gaps in between. Same discipline as annualTally.CoveredSpanInfo.

import { WEIGHT_EPSILON } from './callBurden';
import { fteWeightedTarget, overParBucketKey } from './fteTarget';
import { daysBetween } from './rulesEngine/shared';
import { BUCKET_LABELS, orderCallCodes } from './callCountColumns';
import type { BucketDayType } from './callCountDays';
import type { CallCount } from './annualTally';

/** One provider's weighted calls in one (fairness bucket × parent call code).
 *
 * Structurally IDENTICAL to — and imported as — `annualTally.CallCount`, so
 * the year-scoped producer feeds this module with no adapter at all. Blocks
 * scoped to a single schedule come in through `callCountsFromKeyedRecord`
 * below, which converts `callCountColumns.computeCallCountColumns().counts`.
 *
 * `count` is WEIGHTED and is a RAW FLOAT: three 8h thirds at 0.3333 sum to
 * 0.9999, not 1. Render through `callBurden.formatCallWeight`; never compare
 * it to a whole number without WEIGHT_EPSILON. */
export type EquityCallCount = CallCount;

/* ── Inputs ────────────────────────────────────────────────────────────────*/

/**
 * WHOSE call this table counts. There is no default and no "site: string"
 * shorthand, because the wrong answer here is invisible: a cross-site
 * physician summed against one site's obligation reads as a normal row.
 *
 * `single-site` — counts ONLY this site's call. A provider who also takes
 *   call elsewhere reads LOW, by construction. Correct for "is call fair
 *   inside this site's pool", wrong for "how much call does this partner do".
 * `cross-site`  — counts every supplied site. Correct for whole-person
 *   burden; per-SITE obligation does not apply to a summed row, which is why
 *   `EquityRow.crossSite` exists and why `notes` says so out loud.
 */
export type EquityScope =
  | { kind: 'single-site'; siteId: string; siteLabel?: string }
  | { kind: 'cross-site'; siteIds: readonly string[]; siteLabel?: string };

/** A published date range, already clipped to whatever window the caller
 *  asked about. Shaped to take `annualTally.CoveredSpanInfo.segments`
 *  directly. */
export interface EquitySegment {
  start: string;
  end: string;
}

export interface EquityCoverage {
  /**
   * The PUBLISHED blocks' own disjoint ranges, ascending, adjacent/overlapping
   * ones already merged (i.e. `CoveredSpanInfo.segments`).
   *
   * EMPTY is a first-class state and must never render as "everyone took zero
   * calls": it means nothing was examined. `coverageLabel` says exactly that.
   */
  segments: readonly EquitySegment[];
  /**
   * The window the caller ASKED about — a calendar year, a block, "YTD".
   * Carried beside the covered span, never merged into it, so a UI can say
   * "asked for Jan 1 – Sep 24, the published schedule covers Sep 1 – Sep 24".
   * Null when the caller asked for "whatever exists".
   */
  requested?: EquitySegment | null;
}

export interface EquityProvider {
  provider_id: string;
  /** Real name. This surface is named by design — internal only. */
  display_name: string;
  /**
   * CALL FTE. Null / 0 / non-finite / negative ⇒ the provider is EXCLUDED
   * (see `EquityTable.excluded`), never coerced to 1 and never divided into.
   * Live values are 1.0, 0.75, 0.7, 0.5.
   */
  fte_value: number | null;
}

/**
 * Optional per-bucket SLATE — what the covered window actually stood — so
 * each cell can carry an `expected`.
 *
 * Without it every `expected` is null and the views compare physicians to each
 * OTHER only. With it they can also be compared to what the block owed them.
 * There is deliberately no fallback that derives the slate from the counts:
 * the counts are FILLED calls, so an open (unfilled) slot would vanish from
 * the denominator and quietly inflate everyone's share.
 */
export interface EquitySlate {
  /** `sites.call_par_level` — AUTHORITATIVE (12 at Paoli), never clamped to
   *  the pool's ΣFTE (fteTarget.ts, Gabriel 2026-07-24). */
  parLevel: number;
  /** `overParBucketKey(bucket, parentCode)` -> weighted call slots STOOD.
   *  Typically `computeCallCountColumns().blockTotals`, summed across the
   *  blocks in the covered span. For a cross-site scope it MUST cover the
   *  same sites the counts do. */
  weightByKey: ReadonlyMap<string, number>;
}

export interface CallEquityInput {
  scope: EquityScope;
  coverage: EquityCoverage;
  providers: readonly EquityProvider[];
  /** provider_id -> their weighted counts. A provider absent here simply took
   *  no call in the span and gets an all-zero row — which is real information
   *  and must not be hidden. */
  countsByProvider: ReadonlyMap<string, readonly EquityCallCount[]>;
  /** provider_id -> the sites their counts were drawn from. Drives
   *  `EquityRow.crossSite` and the honesty notes. Omitted ⇒ every row is
   *  attributed to the scope's own site(s). */
  siteIdsByProvider?: ReadonlyMap<string, readonly string[]>;
  slate?: EquitySlate | null;
}

/* ── Outputs ───────────────────────────────────────────────────────────────*/

export interface EquityColumn {
  bucket: string;
  /** PARENT call code. At a site with a stated neuro tier this is just
   *  another code (C3 at Paoli) — neuro is NOT special-cased in the math,
   *  only in the label the UI puts above it. */
  code: string;
  /** `overParBucketKey(bucket, code)`. */
  key: string;
  /** "Sat C1" — day then code, always, whichever group a UI draws it in. */
  label: string;
}

export interface EquityCell {
  key: string;
  bucket: string;
  code: string;
  /** WEIGHTED raw count. Raw float — render via `formatCallWeight`. */
  count: number;
  /** count ÷ FTE. THE comparable number; everything ranked or distributed is
   *  this one, never `count`. */
  perFte: number;
  /** (slate weight ÷ par) × FTE, or null when no slate was supplied. */
  expected: number | null;
}

export interface EquityRow {
  provider_id: string;
  display_name: string;
  /** The positive FTE this row was normalized by. */
  fte: number;
  /** Weighted calls across every column. */
  total: number;
  /** total ÷ FTE — the leaderboard's default sort value. */
  totalPerFte: number;
  /** Σ expected across columns, or null with no slate. */
  expectedTotal: number | null;
  /** One cell per column in `EquityTable.columns` order, zero-filled. A zero
   *  cell means "stood, not taken"; there is no undefined cell. */
  cells: readonly EquityCell[];
  byKey: ReadonlyMap<string, EquityCell>;
  /** Sites this row's counts were summed from. */
  siteIds: readonly string[];
  /** True when `siteIds.length > 1`: a whole-person total that NO single
   *  site's obligation applies to. */
  crossSite: boolean;
}

export type ExclusionReason = 'zero-fte' | 'unstated-fte';

export interface ExcludedProvider {
  provider_id: string;
  display_name: string;
  reason: ExclusionReason;
  /** Weighted calls they nonetheless hold in the span. Nonzero here is worth
   *  a footnote: somebody with no stated FTE is taking real call. */
  count: number;
}

export interface EquityTable {
  scope: EquityScope;
  coverage: EquityCoverage;
  /** Honest one-liner for the covered span — see `coverageLabel`. */
  coverageLabel: string;
  /** Inclusive days actually covered by the segments (gaps excluded). 0 when
   *  nothing is published. */
  coveredDays: number;
  parLevel: number | null;
  columns: readonly EquityColumn[];
  /** Ranked by NOTHING — alphabetical by display name. Ordering is
   *  `leaderboardRows`' job and is stated there. */
  rows: readonly EquityRow[];
  excluded: readonly ExcludedProvider[];
  /** Provider ids with counts but no roster entry. Their calls are in NO row
   *  and in NO distribution — surfaced so a caller can footnote them rather
   *  than silently losing the count (same posture as
   *  annualTally.unrosteredProviderIds). */
  unrosteredProviderIds: readonly string[];
  /**
   * Plain-English caveats derived from the inputs — scope, gaps, cross-site
   * rows, a missing slate. Meant to be RENDERED, not logged: every one of them
   * is a way this table can be read as saying something it does not say.
   */
  notes: readonly string[];
}

/* ── Coverage ──────────────────────────────────────────────────────────────*/

/** Inclusive days in the segments, gaps NOT counted. Segments are assumed
 *  disjoint and ascending (what `coveredSpanFor` produces). */
export function coveredDaysIn(segments: readonly EquitySegment[]): number {
  let n = 0;
  for (const s of segments) {
    if (s.start > s.end) continue; // malformed — dropped, same as coveredSpanFor
    n += daysBetween(s.start, s.end) + 1;
  }
  return n;
}

/**
 * The label every view must print beside its numbers.
 *
 * Three rules, each of which exists because the alternative reads as a
 * different claim:
 *   1. No segments ⇒ "No published schedule …" — never a date range, because
 *      a range implies the zeros underneath it were measured.
 *   2. More than one segment ⇒ the bare start–end range OVERSTATES coverage
 *      (an August block and a December block collapse to "Aug – Dec"), so the
 *      gap count is named. Same rule as CoveredSpanInfo.segments.
 *   3. A requested window wider than the covered span is stated explicitly,
 *      because "YTD" over three published weeks is the exact demo in which a
 *      partner's real workload renders as four calls.
 */
export function coverageLabel(coverage: EquityCoverage): string {
  const segs = coverage.segments.filter(s => s.start <= s.end);
  const req = coverage.requested;
  if (segs.length === 0) {
    return req
      ? `No published schedule in ${req.start} – ${req.end} — nothing counted`
      : 'No published schedule in range — nothing counted';
  }
  const start = segs[0].start;
  const end = segs[segs.length - 1].end;
  const days = coveredDaysIn(segs);
  const span = segs.length > 1
    ? `${start} – ${end} (${segs.length} published blocks, gaps in between; ${days} days counted)`
    : `${start} – ${end} (${days} days)`;
  if (req && (req.start < start || req.end > end)) {
    return `${span} — of the ${req.start} – ${req.end} requested`;
  }
  return span;
}

/* ── Adapters ──────────────────────────────────────────────────────────────*/

/**
 * Convert `computeCallCountColumns().counts` — `Record<pid, Record<'bucket|
 * code', weight>>` — into this module's input shape.
 *
 * The key is split at the LAST pipe, exactly as `fteTarget` reads its own
 * keys, so a call code containing a pipe (none do) would still parent
 * correctly rather than silently landing in a bucket named after half of it.
 */
export function callCountsFromKeyedRecord(
  counts: Readonly<Record<string, Readonly<Record<string, number>>>>,
): Map<string, EquityCallCount[]> {
  const out = new Map<string, EquityCallCount[]>();
  for (const [pid, byKey] of Object.entries(counts)) {
    const list: EquityCallCount[] = [];
    for (const [key, count] of Object.entries(byKey)) {
      const at = key.lastIndexOf('|');
      if (at <= 0) continue; // not a bucket|code key — never invent a bucket
      list.push({ bucket: key.slice(0, at), code: key.slice(at + 1), count });
    }
    if (list.length > 0) out.set(pid, list);
  }
  return out;
}

/**
 * Merge per-site count maps into one cross-site map, and report which sites
 * each provider was summed from.
 *
 * This is the ONLY supported way to build a cross-site table, and it exists so
 * the summing is a visible, deliberate step rather than something a caller
 * does with a spread operator and no record of what it did. The returned
 * `siteIdsByProvider` is what makes `EquityRow.crossSite` true.
 */
export function mergeSiteCounts(
  bySite: ReadonlyMap<string, ReadonlyMap<string, readonly EquityCallCount[]>>,
): {
  countsByProvider: Map<string, EquityCallCount[]>;
  siteIdsByProvider: Map<string, string[]>;
} {
  const folded = new Map<string, Map<string, EquityCallCount>>();
  const siteIdsByProvider = new Map<string, string[]>();
  for (const [siteId, counts] of bySite) {
    for (const [pid, list] of counts) {
      let mine = folded.get(pid);
      if (!mine) { mine = new Map(); folded.set(pid, mine); }
      let sites = siteIdsByProvider.get(pid);
      if (!sites) { sites = []; siteIdsByProvider.set(pid, sites); }
      if (!sites.includes(siteId)) sites.push(siteId);
      for (const c of list) {
        const key = overParBucketKey(c.bucket, c.code);
        const cur = mine.get(key);
        if (cur) cur.count += c.count;
        else mine.set(key, { bucket: c.bucket, code: c.code, count: c.count });
      }
    }
  }
  const countsByProvider = new Map<string, EquityCallCount[]>();
  for (const [pid, mine] of folded) countsByProvider.set(pid, [...mine.values()]);
  for (const sites of siteIdsByProvider.values()) sites.sort();
  return { countsByProvider, siteIdsByProvider };
}

/* ── 1. The table ──────────────────────────────────────────────────────────*/

const DISPLAY_BUCKETS: readonly string[] = Object.keys(BUCKET_LABELS);

/** Day-major column order — M–Th, Fri, Sat, Sun — with the block's own codes
 *  inside each day, ordered by `callCountColumns.orderCallCodes` (C1, C2, C3
 *  lead; anything else alphabetical). Buckets the data uses but the modal has
 *  no label for follow, sorted, rather than being dropped. */
function orderColumns(keys: Iterable<{ bucket: string; code: string }>): EquityColumn[] {
  const byBucket = new Map<string, Set<string>>();
  for (const { bucket, code } of keys) {
    let codes = byBucket.get(bucket);
    if (!codes) { codes = new Set(); byBucket.set(bucket, codes); }
    codes.add(code);
  }
  const known = DISPLAY_BUCKETS.filter(b => byBucket.has(b));
  const extra = [...byBucket.keys()].filter(b => !DISPLAY_BUCKETS.includes(b)).sort();
  const out: EquityColumn[] = [];
  for (const bucket of [...known, ...extra]) {
    const label = BUCKET_LABELS[bucket as BucketDayType] ?? bucket;
    for (const code of orderCallCodes(byBucket.get(bucket)!)) {
      out.push({ bucket, code, key: overParBucketKey(bucket, code), label: `${label} ${code}` });
    }
  }
  return out;
}

/** A usable call FTE, or the reason it is not one. Mirrors
 *  `burdenMetrics.callCounts`' `fte_value > 0` gate — an FTE of 0 carries no
 *  obligation and cannot be divided into. */
function fteStatus(fte: number | null): { ok: true; fte: number } | { ok: false; reason: ExclusionReason } {
  if (fte == null || !Number.isFinite(fte)) return { ok: false, reason: 'unstated-fte' };
  if (fte <= 0) return { ok: false, reason: 'zero-fte' };
  return { ok: true, fte };
}

function scopeSites(scope: EquityScope): string[] {
  return scope.kind === 'single-site' ? [scope.siteId] : [...scope.siteIds];
}

/**
 * Per provider: weighted total, calls per FTE, and a per-(bucket × code)
 * breakdown carrying BOTH the raw count and the per-FTE figure.
 *
 * Columns are derived from the data (and the slate, when given), never
 * hardcoded: Paoli yields weekday/friday/saturday/sunday × C1/C2 plus the
 * neuro C3 weekend columns, and a site standing C4/CC1 gets those instead.
 * Hardcoding C1/C2/C3 here would repeat the bug callCountColumns.ts documents
 * — it hid 22 of Lankenau's 37 weekend calls.
 */
export function callEquityTable(input: CallEquityInput): EquityTable {
  const { scope, coverage, providers, countsByProvider, siteIdsByProvider, slate } = input;

  // Column universe: every (bucket, code) anyone holds, PLUS every one the
  // slate stands. A column the block stood and nobody took is a real column —
  // "stood, not taken" is information, and dropping it would make an empty
  // Sunday read as "we don't run Sunday call" (callCountColumns.ts's rule).
  const pairs: Array<{ bucket: string; code: string }> = [];
  for (const list of countsByProvider.values()) {
    for (const c of list) pairs.push({ bucket: c.bucket, code: c.code });
  }
  if (slate) {
    for (const key of slate.weightByKey.keys()) {
      const at = key.lastIndexOf('|');
      if (at > 0) pairs.push({ bucket: key.slice(0, at), code: key.slice(at + 1) });
    }
  }
  const columns = orderColumns(pairs);

  const rosterIds = new Set(providers.map(p => p.provider_id));
  const rows: EquityRow[] = [];
  const excluded: ExcludedProvider[] = [];

  for (const p of providers) {
    const list = countsByProvider.get(p.provider_id) ?? [];
    const held = new Map<string, number>();
    let total = 0;
    for (const c of list) {
      const key = overParBucketKey(c.bucket, c.code);
      held.set(key, (held.get(key) ?? 0) + c.count);
      total += c.count;
    }

    const status = fteStatus(p.fte_value);
    if (!status.ok) {
      excluded.push({
        provider_id: p.provider_id,
        display_name: p.display_name,
        reason: status.reason,
        count: total,
      });
      continue;
    }
    const fte = status.fte;

    const cells: EquityCell[] = columns.map(col => {
      const count = held.get(col.key) ?? 0;
      return {
        key: col.key,
        bucket: col.bucket,
        code: col.code,
        count,
        perFte: count / fte,
        expected: slate
          ? fteWeightedTarget(slate.weightByKey.get(col.key) ?? 0, slate.parLevel, fte)
          : null,
      };
    });

    const siteIds = siteIdsByProvider?.get(p.provider_id) ?? scopeSites(scope);
    rows.push({
      provider_id: p.provider_id,
      display_name: p.display_name,
      fte,
      total,
      totalPerFte: total / fte,
      expectedTotal: slate
        ? cells.reduce((n, c) => n + (c.expected ?? 0), 0)
        : null,
      cells,
      byKey: new Map(cells.map(c => [c.key, c])),
      siteIds,
      crossSite: siteIds.length > 1,
    });
  }

  rows.sort((a, b) => a.display_name.localeCompare(b.display_name));

  const unrosteredProviderIds = [...countsByProvider.keys()]
    .filter(pid => !rosterIds.has(pid))
    .sort();

  return {
    scope,
    coverage,
    coverageLabel: coverageLabel(coverage),
    coveredDays: coveredDaysIn(coverage.segments),
    parLevel: slate?.parLevel ?? null,
    columns,
    rows,
    excluded,
    unrosteredProviderIds,
    notes: buildNotes(scope, coverage, rows, excluded, unrosteredProviderIds, slate ?? null),
  };
}

/** The caveats a reader needs in order not to misread the table. Generated
 *  from the inputs so they cannot go stale, and returned as strings so a UI
 *  is forced to either render them or visibly throw them away. */
function buildNotes(
  scope: EquityScope,
  coverage: EquityCoverage,
  rows: readonly EquityRow[],
  excluded: readonly ExcludedProvider[],
  unrostered: readonly string[],
  slate: EquitySlate | null,
): string[] {
  const notes: string[] = [];
  const where = scope.siteLabel ?? (scope.kind === 'single-site' ? scope.siteId : `${scope.siteIds.length} sites`);

  if (scope.kind === 'single-site') {
    const elsewhere = rows.filter(r => r.siteIds.some(s => s !== scope.siteId)).length;
    notes.push(
      `Single-site view (${where}): call taken at any other site is NOT counted here.`
      + (elsewhere > 0
        ? ` ${elsewhere} of ${rows.length} providers on this list also work elsewhere and therefore read low.`
        : ''),
    );
  } else {
    const summed = rows.filter(r => r.crossSite).length;
    notes.push(
      `Cross-site view (${where}): each row sums every site's call.`
      + (summed > 0
        ? ` ${summed} of ${rows.length} rows are multi-site totals — no single site's obligation applies to them.`
        : ''),
    );
  }

  if (coverage.segments.filter(s => s.start <= s.end).length > 1) {
    notes.push('Coverage has gaps: the span is made of separate published blocks, and the dates in between were never built.');
  }
  if (coverage.segments.length === 0) {
    notes.push('Nothing is published in this range, so every figure below is zero because nothing was examined — not because nobody took call.');
  }
  if (!slate) {
    notes.push('No expected column: physicians are compared to each other, not to what the block owed them.');
  }
  if (excluded.length > 0) {
    const working = excluded.filter(e => e.count > WEIGHT_EPSILON).length;
    notes.push(
      `${excluded.length} provider${excluded.length === 1 ? '' : 's'} excluded for a zero or unstated FTE`
      + (working > 0 ? `, ${working} of whom hold call in this span` : '')
      + '.',
    );
  }
  if (unrostered.length > 0) {
    notes.push(`${unrostered.length} provider id${unrostered.length === 1 ? '' : 's'} hold call in this span but are not on the roster supplied; their calls appear in no row.`);
  }
  return notes;
}

/* ── 2. Distribution ───────────────────────────────────────────────────────*/

/** The pseudo-column for "every bucket added up". Cannot collide with a real
 *  `bucket|code` key. */
export const TOTAL_KEY = 'total';

export type Quartile = 1 | 2 | 3 | 4;

export interface EquityPosition {
  provider_id: string;
  display_name: string;
  fte: number;
  /** WEIGHTED raw count behind `perFte`. Carried so a UI never has to show a
   *  normalized figure without the number it came from. */
  count: number;
  perFte: number;
  /** perFte − median. Signed; the distribution's whole point. */
  deltaFromMedian: number;
  /** Fraction of the group at or below this value, 0..1. Ties share it. */
  percentile: number;
  quartile: Quartile;
  /** Tukey fence: outside [q1 − 1.5·IQR, q3 + 1.5·IQR]. A flag to look at,
   *  not a verdict. Null for everyone else. */
  outlier: 'low' | 'high' | null;
}

export interface EquityDistribution {
  key: string;
  /** Null for the TOTAL_KEY row. */
  bucket: string | null;
  code: string | null;
  label: string;
  /** Providers in the distribution (every non-excluded row, including zeros —
   *  taking none of a bucket is a position in it). */
  n: number;
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  iqr: number;
  mean: number;
  /**
   * POPULATION standard deviation of the per-FTE values — byte-for-byte the
   * quantity `rulesEngine/burdenMetrics.callsPerFteStdev` reports, so a
   * generation report and this page can be read side by side. Pinned by a
   * parity test in callEquity.test.ts rather than by a comment.
   *
   * It is NOT a fairness score and must not be presented as one: it is the
   * spread of ONE category.
   */
  stdev: number;
  /** Total weighted calls in this category across the group. */
  totalCount: number;
  /** Everyone's position, ordered by perFte descending then name. */
  positions: readonly EquityPosition[];
}

/**
 * Linear-interpolation quantile on a SORTED ascending array (the R-7 /
 * Excel PERCENTILE.INC definition — the one a spreadsheet gives, which is what
 * anyone checking this by hand will use). Empty ⇒ 0.
 */
export function quantile(sortedAsc: readonly number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  if (n === 1) return sortedAsc[0];
  const pos = (n - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}

/**
 * Population standard deviation — the SAME formula as
 * `burdenMetrics.callsPerFteStdev` (divide by n, not n−1). Population, because
 * the roster IS the population; there is no larger group being sampled.
 */
export function populationStdev(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length);
}

/**
 * For each (bucket × code) — and for the total — the group's order statistics
 * and every physician's position in them.
 *
 * This is the half of the feature that a leaderboard cannot do: a rank says
 * "7th of 74" whether 7th is one call off the median or nine. A distribution
 * says which.
 *
 * `keys` restricts the output (e.g. to the columns a UI is drawing); omitted
 * ⇒ every column plus TOTAL_KEY.
 */
export function equityDistribution(
  table: EquityTable,
  keys?: readonly string[],
): EquityDistribution[] {
  const wanted = keys ? new Set(keys) : null;
  const specs: Array<{ key: string; bucket: string | null; code: string | null; label: string }> = [
    ...table.columns.map(c => ({ key: c.key, bucket: c.bucket, code: c.code, label: c.label })),
    { key: TOTAL_KEY, bucket: null, code: null, label: 'All call' },
  ];

  const out: EquityDistribution[] = [];
  for (const spec of specs) {
    if (wanted && !wanted.has(spec.key)) continue;

    const sample = table.rows.map(r => {
      const cell = spec.key === TOTAL_KEY ? null : r.byKey.get(spec.key);
      const count = spec.key === TOTAL_KEY ? r.total : (cell?.count ?? 0);
      const perFte = spec.key === TOTAL_KEY ? r.totalPerFte : (cell?.perFte ?? 0);
      return { row: r, count, perFte };
    });

    const values = sample.map(s => s.perFte);
    const sorted = [...values].sort((a, b) => a - b);
    const n = sorted.length;
    const q1 = quantile(sorted, 0.25);
    const median = quantile(sorted, 0.5);
    const q3 = quantile(sorted, 0.75);
    const iqr = q3 - q1;
    const loFence = q1 - 1.5 * iqr;
    const hiFence = q3 + 1.5 * iqr;

    const positions: EquityPosition[] = sample.map(s => {
      // Ties share a percentile: `<=` counts every equal value, so an
      // all-equal group is 1.0 for everyone rather than a spurious ladder.
      // WEIGHT_EPSILON absorbs stored-fraction noise (3 × 0.3333 = 0.9999
      // must not read as strictly below a whole 1.0).
      const atOrBelow = sorted.filter(v => v <= s.perFte + WEIGHT_EPSILON).length;
      return {
        provider_id: s.row.provider_id,
        display_name: s.row.display_name,
        fte: s.row.fte,
        count: s.count,
        perFte: s.perFte,
        deltaFromMedian: s.perFte - median,
        percentile: n === 0 ? 0 : atOrBelow / n,
        quartile: quartileOf(s.perFte, q1, median, q3),
        outlier: iqr <= WEIGHT_EPSILON
          // A zero IQR means at least half the group sits on one value; every
          // fence collapses onto it and all but the mode would flag. That is
          // noise, not a finding, so no outliers are reported.
          ? null
          : s.perFte < loFence ? 'low' : s.perFte > hiFence ? 'high' : null,
      };
    });
    positions.sort((a, b) => b.perFte - a.perFte || a.display_name.localeCompare(b.display_name));

    out.push({
      key: spec.key,
      bucket: spec.bucket,
      code: spec.code,
      label: spec.label,
      n,
      min: n === 0 ? 0 : sorted[0],
      q1,
      median,
      q3,
      max: n === 0 ? 0 : sorted[n - 1],
      iqr,
      mean: n === 0 ? 0 : values.reduce((a, b) => a + b, 0) / n,
      stdev: populationStdev(values),
      totalCount: sample.reduce((a, s) => a + s.count, 0),
      positions,
    });
  }
  return out;
}

/** Which quarter of the distribution a value sits in. Boundaries go to the
 *  LOWER band (a value exactly on the median is q2), so the four bands
 *  partition the line with no value in two of them. */
function quartileOf(v: number, q1: number, median: number, q3: number): Quartile {
  if (v <= q1) return 1;
  if (v <= median) return 2;
  if (v <= q3) return 3;
  return 4;
}

/* ── 3. Leaderboard ────────────────────────────────────────────────────────*/

/**
 * What the leaderboard is ordered by. Always stated in the output
 * (`Leaderboard.sortLabel`) so the rendered table can never show a ranked list
 * of named partners without naming the quantity that ranked them.
 *
 * `total-per-fte` — DEFAULT. Weighted calls ÷ FTE, all categories.
 * `total`         — raw weighted calls. Available because someone will ask for
 *                   it; `Leaderboard.warning` says what it does to part-timers.
 * `bucket`        — one category's calls ÷ FTE (`key` is a column key).
 */
export type LeaderboardSort =
  | { by: 'total-per-fte' }
  | { by: 'total' }
  | { by: 'bucket'; key: string };

export interface LeaderboardRow {
  /** Competition rank: ties SHARE a rank and the next rank skips (1, 1, 3).
   *  An all-equal group is all rank 1, which is the honest picture. */
  rank: number;
  tied: boolean;
  provider_id: string;
  display_name: string;
  fte: number;
  /** The sorted quantity. */
  value: number;
  /** The raw weighted count behind `value` — always carried, so a per-FTE
   *  figure is never shown without the calls it came from. */
  count: number;
  deltaFromMedian: number;
  crossSite: boolean;
}

export interface Leaderboard {
  sort: LeaderboardSort;
  /** Human sentence naming the sort quantity. RENDER THIS. */
  sortLabel: string;
  /** Non-null when the chosen sort is known to mislead (raw counts vs FTE). */
  warning: string | null;
  coverageLabel: string;
  /** Median of the sorted quantity — the reference line for `deltaFromMedian`. */
  median: number;
  rows: readonly LeaderboardRow[];
}

const SORT_LABELS: Record<LeaderboardSort['by'], string> = {
  'total-per-fte': 'calls per FTE, all categories',
  total: 'total calls (NOT normalized for FTE)',
  bucket: 'calls per FTE',
};

/**
 * The ranked, named list.
 *
 * SORT KEY — calls per FTE, descending. Stated, not implied, and carried on
 * the result. Three reasons it is this and not raw calls:
 *   1. It is the only quantity that means the same thing for a 0.5 and a 1.0
 *      FTE. Raw counts rank the part-timers last by arithmetic.
 *   2. It is what clinical invariant 5 says burden distributes by, and what
 *      every quota in the engine is scaled by.
 *   3. It is the quantity `burdenMetrics.callsPerFteStdev` measures, so the
 *      leaderboard and the engine's own fairness number describe one thing.
 *
 * TIE-BREAKS, in order: raw weighted count descending (someone who got there
 * on more absolute calls sorts first), then display name ascending. Fully
 * deterministic — no input order dependence — and ties still SHARE a rank, so
 * an even group renders as an even group instead of an invented ladder.
 * WEIGHT_EPSILON decides equality, because these are stored-fraction floats.
 */
export function leaderboardRows(
  table: EquityTable,
  sort: LeaderboardSort = { by: 'total-per-fte' },
): Leaderboard {
  const valueOf = (r: EquityRow): { value: number; count: number } => {
    if (sort.by === 'total') return { value: r.total, count: r.total };
    if (sort.by === 'total-per-fte') return { value: r.totalPerFte, count: r.total };
    const cell = r.byKey.get(sort.key);
    return { value: cell?.perFte ?? 0, count: cell?.count ?? 0 };
  };

  const scored = table.rows.map(r => ({ row: r, ...valueOf(r) }));
  scored.sort((a, b) =>
    b.value - a.value
    || b.count - a.count
    || a.row.display_name.localeCompare(b.row.display_name));

  const sortedValues = [...scored.map(s => s.value)].sort((a, b) => a - b);
  const median = quantile(sortedValues, 0.5);

  const rows: LeaderboardRow[] = [];
  let rank = 0;
  for (let i = 0; i < scored.length; i++) {
    const s = scored[i];
    const prev = i > 0 ? scored[i - 1] : null;
    const tiedWithPrev = prev != null && Math.abs(prev.value - s.value) <= WEIGHT_EPSILON;
    if (!tiedWithPrev) rank = i + 1; // competition ranking: skip over the tie
    const next = scored[i + 1];
    const tiedWithNext = next != null && Math.abs(next.value - s.value) <= WEIGHT_EPSILON;
    rows.push({
      rank,
      tied: tiedWithPrev || tiedWithNext,
      provider_id: s.row.provider_id,
      display_name: s.row.display_name,
      fte: s.row.fte,
      value: s.value,
      count: s.count,
      deltaFromMedian: s.value - median,
      crossSite: s.row.crossSite,
    });
  }

  const column = sort.by === 'bucket' ? table.columns.find(c => c.key === sort.key) : undefined;
  const sortLabel = sort.by === 'bucket'
    ? `${column?.label ?? sort.key} calls per FTE`
    : SORT_LABELS[sort.by];

  return {
    sort,
    sortLabel,
    warning: sort.by === 'total'
      ? 'Ranked on raw calls. A 0.5 FTE physician working exactly their share sits at the bottom of this list by arithmetic alone — use calls per FTE to compare people.'
      : null,
    coverageLabel: table.coverageLabel,
    median,
    rows,
  };
}
