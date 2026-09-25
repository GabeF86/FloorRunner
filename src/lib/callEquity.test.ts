/**
 * Call equity.
 *
 * The bugs these exist to prevent, in the order they would bite:
 *   1. Ranking named partners on RAW counts, which sorts every part-timer to
 *      the bottom by arithmetic and calls it performance.
 *   2. Dividing by a zero FTE, or quietly zeroing someone whose FTE nobody
 *      stated, so they vanish from a named list with no explanation.
 *   3. Printing a date range over a span that was never published — "4 calls
 *      YTD" reading as the system under-counting a partner.
 *   4. Inventing a ladder out of an even group (ties must SHARE a rank).
 *   5. Drifting from the engine's own per-FTE spread number. The stdev here is
 *      pinned to rulesEngine/burdenMetrics.callsPerFteStdev by a parity test,
 *      not by a comment.
 */
import { describe, it, expect } from 'vitest';
import {
  callEquityTable,
  callCountsFromKeyedRecord,
  coverageLabel,
  coveredDaysIn,
  equityDistribution,
  leaderboardRows,
  mergeSiteCounts,
  populationStdev,
  quantile,
  TOTAL_KEY,
  type CallEquityInput,
  type EquityCallCount,
  type EquityCoverage,
  type EquityProvider,
} from './callEquity';
import { callsPerFteStdev } from './rulesEngine/burdenMetrics';
import { buildCtx, callSlot, prov } from './rulesEngine/__fixtures__/buildContext';
import type { SolutionPlan } from './rulesEngine/genTypes';

/* ── fixtures ──────────────────────────────────────────────────────────────*/

const SPAN: EquityCoverage = { segments: [{ start: '2026-09-01', end: '2026-09-24' }] };
const SITE = 'paoli';
const SCOPE = { kind: 'single-site' as const, siteId: SITE, siteLabel: 'Paoli' };

function p(id: string, fte: number | null, name = id.toUpperCase()): EquityProvider {
  return { provider_id: id, display_name: name, fte_value: fte };
}

function counts(
  entries: Record<string, Array<[string, string, number]>>,
): Map<string, EquityCallCount[]> {
  const out = new Map<string, EquityCallCount[]>();
  for (const [pid, list] of Object.entries(entries)) {
    out.set(pid, list.map(([bucket, code, count]) => ({ bucket, code, count })));
  }
  return out;
}

function table(over: Partial<CallEquityInput> = {}) {
  return callEquityTable({
    scope: SCOPE,
    coverage: SPAN,
    providers: [],
    countsByProvider: new Map(),
    ...over,
  });
}

/* ── 1. the table ──────────────────────────────────────────────────────────*/

describe('callEquityTable', () => {
  it('breaks each provider down per bucket as raw count AND per FTE', () => {
    const t = table({
      providers: [p('a', 1), p('b', 0.5)],
      countsByProvider: counts({
        a: [['weekday', 'C1', 4], ['saturday', 'C2', 1]],
        b: [['weekday', 'C1', 2]],
      }),
    });

    const a = t.rows.find(r => r.provider_id === 'a')!;
    expect(a.total).toBe(5);
    expect(a.totalPerFte).toBe(5);
    expect(a.byKey.get('weekday|C1')).toMatchObject({ count: 4, perFte: 4 });
    expect(a.byKey.get('saturday|C2')).toMatchObject({ count: 1, perFte: 1 });

    const b = t.rows.find(r => r.provider_id === 'b')!;
    expect(b.total).toBe(2);
    // 2 calls at 0.5 FTE is the SAME burden as 4 at 1.0 — the whole point.
    expect(b.byKey.get('weekday|C1')!.perFte).toBe(4);
  });

  it('zero-fills every column, so "stood but not taken" is visible', () => {
    const t = table({
      providers: [p('a', 1), p('b', 1)],
      countsByProvider: counts({ a: [['sunday', 'C1', 1]] }),
    });
    const b = t.rows.find(r => r.provider_id === 'b')!;
    expect(b.cells).toHaveLength(t.columns.length);
    expect(b.byKey.get('sunday|C1')).toMatchObject({ count: 0, perFte: 0 });
    expect(b.total).toBe(0);
  });

  it('orders columns day-major with C1/C2/C3 leading inside each day', () => {
    const t = table({
      providers: [p('a', 1)],
      countsByProvider: counts({
        a: [
          ['sunday', 'CC1', 1], ['sunday', 'C1', 1],
          ['weekday', 'C2', 1], ['weekday', 'C1', 1],
          ['friday', 'C1', 1], ['saturday', 'C3', 1],
        ],
      }),
    });
    expect(t.columns.map(c => c.key)).toEqual([
      'weekday|C1', 'weekday|C2', 'friday|C1', 'saturday|C3', 'sunday|C1', 'sunday|CC1',
    ]);
    expect(t.columns[0].label).toBe('M–Th C1');
  });

  it('does not hardcode a C1/C2/C3 universe', () => {
    // callCountColumns.ts's documented bug: a hardcoded universe hid 22 of
    // Lankenau's 37 weekend calls.
    const t = table({
      providers: [p('a', 1)],
      countsByProvider: counts({ a: [['saturday', 'C4', 2], ['weekday', 'CC2', 3]] }),
    });
    expect(t.columns.map(c => c.key)).toEqual(['weekday|CC2', 'saturday|C4']);
    expect(t.rows[0].total).toBe(5);
  });

  describe('FTE exclusion', () => {
    it('excludes a zero FTE rather than dividing by it, and says so', () => {
      const t = table({
        providers: [p('a', 1), p('zero', 0)],
        countsByProvider: counts({ a: [['weekday', 'C1', 1]], zero: [['weekday', 'C1', 3]] }),
      });
      expect(t.rows.map(r => r.provider_id)).toEqual(['a']);
      expect(t.excluded).toEqual([
        { provider_id: 'zero', display_name: 'ZERO', reason: 'zero-fte', count: 3 },
      ]);
      // Their calls are real; the note has to admit they were dropped.
      expect(t.notes.join(' ')).toMatch(/1 of whom hold call/);
      for (const r of t.rows) for (const c of r.cells) expect(Number.isFinite(c.perFte)).toBe(true);
    });

    it('distinguishes an unstated FTE from a stated zero', () => {
      const t = table({
        providers: [p('n', null), p('z', 0)],
        countsByProvider: new Map(),
      });
      expect(t.excluded.map(e => e.reason)).toEqual(['unstated-fte', 'zero-fte']);
    });

    it('excludes a negative or non-finite FTE too', () => {
      const t = table({ providers: [p('neg', -1), p('nan', NaN)], countsByProvider: new Map() });
      expect(t.rows).toEqual([]);
      expect(t.excluded).toHaveLength(2);
    });
  });

  it('reports provider ids holding call that are not on the roster', () => {
    const t = table({
      providers: [p('a', 1)],
      countsByProvider: counts({ a: [['weekday', 'C1', 1]], ghost: [['weekday', 'C1', 9]] }),
    });
    expect(t.unrosteredProviderIds).toEqual(['ghost']);
    expect(t.notes.join(' ')).toMatch(/not on the roster/);
  });

  it('handles an empty roster and empty counts without throwing', () => {
    const t = table();
    expect(t.rows).toEqual([]);
    expect(t.columns).toEqual([]);
    expect(t.excluded).toEqual([]);
    expect(t.unrosteredProviderIds).toEqual([]);
    expect(equityDistribution(t)).toEqual([
      expect.objectContaining({ key: TOTAL_KEY, n: 0, median: 0, stdev: 0, positions: [] }),
    ]);
    expect(leaderboardRows(t).rows).toEqual([]);
  });

  describe('slate / expected', () => {
    const slate = {
      parLevel: 12,
      weightByKey: new Map([['weekday|C1', 44], ['sunday|C1', 11]]),
    };

    it('computes expected as (slate ÷ par) × FTE and totals it', () => {
      const t = table({
        providers: [p('a', 1), p('b', 0.5)],
        countsByProvider: counts({ a: [['weekday', 'C1', 4]] }),
        slate,
      });
      const a = t.rows.find(r => r.provider_id === 'a')!;
      expect(a.byKey.get('weekday|C1')!.expected).toBeCloseTo(44 / 12, 9);
      expect(a.byKey.get('sunday|C1')!.expected).toBeCloseTo(11 / 12, 9);
      expect(a.expectedTotal).toBeCloseTo(55 / 12, 9);

      const b = t.rows.find(r => r.provider_id === 'b')!;
      expect(b.expectedTotal).toBeCloseTo(55 / 24, 9);
      expect(t.parLevel).toBe(12);
    });

    it('gives a column to a bucket the block STOOD but nobody took', () => {
      const t = table({ providers: [p('a', 1)], countsByProvider: new Map(), slate });
      expect(t.columns.map(c => c.key)).toEqual(['weekday|C1', 'sunday|C1']);
      expect(t.rows[0].byKey.get('sunday|C1')).toMatchObject({ count: 0, expected: 11 / 12 });
    });

    it('leaves expected null and warns when no slate is supplied', () => {
      const t = table({ providers: [p('a', 1)], countsByProvider: counts({ a: [['weekday', 'C1', 1]] }) });
      expect(t.rows[0].expectedTotal).toBeNull();
      expect(t.rows[0].cells[0].expected).toBeNull();
      expect(t.parLevel).toBeNull();
      expect(t.notes.join(' ')).toMatch(/No expected column/);
    });
  });
});

/* ── scope ─────────────────────────────────────────────────────────────────*/

describe('site scope', () => {
  it('attributes a single-site row to that site and warns about the rest', () => {
    const t = table({
      providers: [p('a', 1), p('b', 1)],
      countsByProvider: counts({ a: [['weekday', 'C1', 1]] }),
      siteIdsByProvider: new Map([['a', [SITE]], ['b', [SITE, 'bryn-mawr']]]),
    });
    expect(t.rows.find(r => r.provider_id === 'a')!.crossSite).toBe(false);
    expect(t.rows.find(r => r.provider_id === 'b')!.crossSite).toBe(true);
    expect(t.notes[0]).toMatch(/Single-site view \(Paoli\)/);
    expect(t.notes[0]).toMatch(/1 of 2 providers on this list also work elsewhere/);
  });

  it('defaults a row with no site map to the scope\'s own sites', () => {
    const t = table({ providers: [p('a', 1)], countsByProvider: new Map() });
    expect(t.rows[0].siteIds).toEqual([SITE]);
    expect(t.rows[0].crossSite).toBe(false);
  });

  it('merges cross-site counts and flags the summed rows', () => {
    const merged = mergeSiteCounts(new Map([
      ['paoli', counts({ a: [['weekday', 'C1', 3]], b: [['weekday', 'C1', 1]] })],
      ['lankenau', counts({ a: [['weekday', 'C1', 2], ['saturday', 'C1', 1]] })],
    ]));
    expect(merged.countsByProvider.get('a')).toEqual(expect.arrayContaining([
      { bucket: 'weekday', code: 'C1', count: 5 },
      { bucket: 'saturday', code: 'C1', count: 1 },
    ]));
    expect(merged.siteIdsByProvider.get('a')).toEqual(['lankenau', 'paoli']);
    expect(merged.siteIdsByProvider.get('b')).toEqual(['paoli']);

    const t = callEquityTable({
      scope: { kind: 'cross-site', siteIds: ['paoli', 'lankenau'], siteLabel: '2 sites' },
      coverage: SPAN,
      providers: [p('a', 1), p('b', 1)],
      countsByProvider: merged.countsByProvider,
      siteIdsByProvider: merged.siteIdsByProvider,
    });
    expect(t.rows.find(r => r.provider_id === 'a')).toMatchObject({ total: 6, crossSite: true });
    expect(t.rows.find(r => r.provider_id === 'b')!.crossSite).toBe(false);
    expect(t.notes[0]).toMatch(/Cross-site view/);
    expect(t.notes[0]).toMatch(/1 of 2 rows are multi-site totals/);
  });
});

/* ── coverage labelling ────────────────────────────────────────────────────*/

describe('coverage', () => {
  it('counts inclusive days and skips the gaps', () => {
    expect(coveredDaysIn([{ start: '2026-09-01', end: '2026-09-24' }])).toBe(24);
    expect(coveredDaysIn([
      { start: '2026-01-01', end: '2026-01-31' },
      { start: '2026-09-01', end: '2026-09-24' },
    ])).toBe(31 + 24);
    expect(coveredDaysIn([])).toBe(0);
    expect(coveredDaysIn([{ start: '2026-09-24', end: '2026-09-01' }])).toBe(0); // malformed
  });

  it('never prints a date range when nothing is published', () => {
    expect(coverageLabel({ segments: [] })).toBe('No published schedule in range — nothing counted');
    expect(coverageLabel({ segments: [], requested: { start: '2026-01-01', end: '2026-09-24' } }))
      .toBe('No published schedule in 2026-01-01 – 2026-09-24 — nothing counted');
  });

  it('states the covered span, not the requested one', () => {
    // THE demo failure: "YTD" over three published weeks reads as the system
    // under-counting a partner unless the label says otherwise.
    const label = coverageLabel({
      segments: [{ start: '2026-09-01', end: '2026-09-24' }],
      requested: { start: '2026-01-01', end: '2026-09-24' },
    });
    expect(label).toBe('2026-09-01 – 2026-09-24 (24 days) — of the 2026-01-01 – 2026-09-24 requested');
  });

  it('refuses a bare start–end range when the coverage has gaps', () => {
    const label = coverageLabel({ segments: [
      { start: '2026-01-01', end: '2026-01-31' },
      { start: '2026-09-01', end: '2026-09-24' },
    ] });
    expect(label).toContain('gaps in between');
    expect(label).toContain('55 days counted');
  });

  it('puts the label and the day count on the table', () => {
    const t = table();
    expect(t.coverageLabel).toBe('2026-09-01 – 2026-09-24 (24 days)');
    expect(t.coveredDays).toBe(24);
  });

  it('says nothing was examined when nothing is published', () => {
    const t = table({ coverage: { segments: [] }, providers: [p('a', 1)] });
    expect(t.notes.join(' ')).toMatch(/because nothing was examined/);
  });
});

/* ── 2. distribution ───────────────────────────────────────────────────────*/

describe('quantile', () => {
  it('is the R-7 / spreadsheet definition', () => {
    const v = [1, 2, 3, 4];
    expect(quantile(v, 0)).toBe(1);
    expect(quantile(v, 0.25)).toBeCloseTo(1.75, 9);
    expect(quantile(v, 0.5)).toBeCloseTo(2.5, 9);
    expect(quantile(v, 0.75)).toBeCloseTo(3.25, 9);
    expect(quantile(v, 1)).toBe(4);
  });

  it('handles the degenerate sizes', () => {
    expect(quantile([], 0.5)).toBe(0);
    expect(quantile([7], 0.5)).toBe(7);
    expect(quantile([7], 0.25)).toBe(7);
    expect(quantile([1, 2, 3], 0.5)).toBe(2);
  });
});

describe('equityDistribution', () => {
  const dist = (over: Partial<CallEquityInput>, key: string) =>
    equityDistribution(table(over), [key])[0];

  it('reports the order statistics and everyone\'s position per category', () => {
    const d = dist({
      providers: [p('a', 1), p('b', 1), p('c', 1), p('d', 1)],
      countsByProvider: counts({
        a: [['weekday', 'C1', 1]], b: [['weekday', 'C1', 2]],
        c: [['weekday', 'C1', 3]], d: [['weekday', 'C1', 4]],
      }),
    }, 'weekday|C1');

    expect(d).toMatchObject({ n: 4, min: 1, q1: 1.75, median: 2.5, q3: 3.25, max: 4, totalCount: 10 });
    expect(d.iqr).toBeCloseTo(1.5, 9);
    expect(d.mean).toBeCloseTo(2.5, 9);
    expect(d.label).toBe('M–Th C1');
    // Sorted heaviest first.
    expect(d.positions.map(x => x.display_name)).toEqual(['D', 'C', 'B', 'A']);
    expect(d.positions[0]).toMatchObject({ perFte: 4, count: 4, quartile: 4, percentile: 1 });
    expect(d.positions[0].deltaFromMedian).toBeCloseTo(1.5, 9);
    expect(d.positions[3]).toMatchObject({ perFte: 1, quartile: 1, percentile: 0.25 });
    expect(d.positions[3].deltaFromMedian).toBeCloseTo(-1.5, 9);
  });

  it('normalizes by FTE, so a 0.5 taking half as many sits ON the median', () => {
    const d = dist({
      providers: [p('full', 1), p('half', 0.5)],
      countsByProvider: counts({ full: [['weekday', 'C1', 4]], half: [['weekday', 'C1', 2]] }),
    }, 'weekday|C1');
    expect(d.median).toBe(4);
    expect(d.stdev).toBeCloseTo(0, 9);
    for (const x of d.positions) expect(x.deltaFromMedian).toBeCloseTo(0, 9);
  });

  it('is flat for an all-equal group, with no outliers invented', () => {
    const d = dist({
      providers: [p('a', 1), p('b', 1), p('c', 1)],
      countsByProvider: counts({
        a: [['weekday', 'C1', 2]], b: [['weekday', 'C1', 2]], c: [['weekday', 'C1', 2]],
      }),
    }, 'weekday|C1');
    expect(d).toMatchObject({ min: 2, q1: 2, median: 2, q3: 2, max: 2, iqr: 0, stdev: 0 });
    for (const x of d.positions) {
      expect(x.deltaFromMedian).toBe(0);
      expect(x.percentile).toBe(1);   // ties share it — no invented ladder
      expect(x.outlier).toBeNull();   // a zero IQR collapses every fence
      expect(x.quartile).toBe(1);
    }
  });

  it('puts a single provider on their own median', () => {
    const d = dist({
      providers: [p('solo', 0.7)],
      countsByProvider: counts({ solo: [['weekday', 'C1', 7]] }),
    }, 'weekday|C1');
    expect(d.n).toBe(1);
    expect(d.median).toBeCloseTo(10, 9);
    expect(d).toMatchObject({ q1: d.median, q3: d.median, iqr: 0, stdev: 0 });
    expect(d.positions[0]).toMatchObject({ deltaFromMedian: 0, percentile: 1, outlier: null });
  });

  it('counts a provider who took NONE of a category as a zero in it', () => {
    // Not taking Sundays is a position in the Sunday distribution, not an
    // absence from it.
    const d = dist({
      providers: [p('a', 1), p('b', 1)],
      countsByProvider: counts({ a: [['sunday', 'C1', 2]] }),
    }, 'sunday|C1');
    expect(d.n).toBe(2);
    expect(d.positions.map(x => x.perFte)).toEqual([2, 0]);
    expect(d.median).toBe(1);
  });

  it('flags a Tukey outlier without flagging the merely-high', () => {
    const d = dist({
      providers: ['a', 'b', 'c', 'd', 'e', 'f'].map(id => p(id, 1)),
      countsByProvider: counts({
        a: [['weekday', 'C1', 4]], b: [['weekday', 'C1', 4]], c: [['weekday', 'C1', 4]],
        d: [['weekday', 'C1', 5]], e: [['weekday', 'C1', 5]], f: [['weekday', 'C1', 40]],
      }),
    }, 'weekday|C1');
    const flagged = d.positions.filter(x => x.outlier);
    expect(flagged.map(x => x.display_name)).toEqual(['F']);
    expect(flagged[0].outlier).toBe('high');
  });

  it('does not net one category against another', () => {
    // fteTarget.ts, Gabriel 2026-08-03: being over on M–Th C1 and short on
    // Sunday C2 is NOT "even". Each category stands on its own.
    const t = table({
      providers: [p('over', 1), p('even', 1)],
      countsByProvider: counts({
        over: [['weekday', 'C1', 6], ['sunday', 'C2', 0]],
        even: [['weekday', 'C1', 4], ['sunday', 'C2', 2]],
      }),
    });
    const byKey = new Map(equityDistribution(t).map(d => [d.key, d]));
    const at = (key: string, name: string) =>
      byKey.get(key)!.positions.find(x => x.display_name === name)!;

    expect(at('weekday|C1', 'OVER').deltaFromMedian).toBe(1);
    expect(at('sunday|C2', 'OVER').deltaFromMedian).toBe(-1);
    // The totals happen to tie — which is exactly why the per-category view
    // has to exist, and why there is no composite score collapsing them.
    expect(at(TOTAL_KEY, 'OVER').deltaFromMedian).toBe(0);
    expect(at(TOTAL_KEY, 'EVEN').deltaFromMedian).toBe(0);
  });

  it('emits every column plus a total row, and honours a key filter', () => {
    const t = table({
      providers: [p('a', 1)],
      countsByProvider: counts({ a: [['weekday', 'C1', 1], ['saturday', 'C2', 1]] }),
    });
    expect(equityDistribution(t).map(d => d.key))
      .toEqual(['weekday|C1', 'saturday|C2', TOTAL_KEY]);
    expect(equityDistribution(t, [TOTAL_KEY]).map(d => d.label)).toEqual(['All call']);
  });
});

/* ── 3. leaderboard ────────────────────────────────────────────────────────*/

describe('leaderboardRows', () => {
  it('states its sort key on the result', () => {
    const lb = leaderboardRows(table({ providers: [p('a', 1)], countsByProvider: new Map() }));
    expect(lb.sort).toEqual({ by: 'total-per-fte' });
    expect(lb.sortLabel).toBe('calls per FTE, all categories');
    expect(lb.warning).toBeNull();
    expect(lb.coverageLabel).toBe('2026-09-01 – 2026-09-24 (24 days)');
  });

  it('ranks on calls per FTE, so a 0.5 FTE can outrank a 1.0', () => {
    const lb = leaderboardRows(table({
      providers: [p('full', 1), p('half', 0.5)],
      countsByProvider: counts({
        full: [['weekday', 'C1', 8]],   // 8 per FTE
        half: [['weekday', 'C1', 5]],   // 10 per FTE
      }),
    }));
    expect(lb.rows.map(r => r.display_name)).toEqual(['HALF', 'FULL']);
    expect(lb.rows[0]).toMatchObject({ rank: 1, value: 10, count: 5, fte: 0.5 });
    expect(lb.rows[1]).toMatchObject({ rank: 2, value: 8, count: 8 });
  });

  it('carries the raw count beside every normalized figure', () => {
    const lb = leaderboardRows(table({
      providers: [p('a', 0.75)],
      countsByProvider: counts({ a: [['weekday', 'C1', 3]] }),
    }));
    expect(lb.rows[0]).toMatchObject({ count: 3, fte: 0.75 });
    expect(lb.rows[0].value).toBeCloseTo(4, 9);
  });

  it('shares a rank on a tie and skips the next (competition ranking)', () => {
    const lb = leaderboardRows(table({
      providers: [p('a', 1), p('b', 1), p('c', 1)],
      countsByProvider: counts({
        a: [['weekday', 'C1', 5]], b: [['weekday', 'C1', 5]], c: [['weekday', 'C1', 1]],
      }),
    }));
    expect(lb.rows.map(r => [r.display_name, r.rank, r.tied]))
      .toEqual([['A', 1, true], ['B', 1, true], ['C', 3, false]]);
  });

  it('renders an even group as even: everyone rank 1', () => {
    const lb = leaderboardRows(table({
      providers: [p('a', 1), p('b', 0.5), p('c', 0.7)],
      countsByProvider: counts({
        a: [['weekday', 'C1', 10]], b: [['weekday', 'C1', 5]], c: [['weekday', 'C1', 7]],
      }),
    }));
    expect(lb.rows.map(r => r.rank)).toEqual([1, 1, 1]);
    expect(lb.rows.every(r => r.tied)).toBe(true);
    for (const r of lb.rows) expect(r.deltaFromMedian).toBeCloseTo(0, 9);
  });

  it('breaks a per-FTE tie deterministically: raw count, then name', () => {
    // Same per-FTE, different absolute volume, and the input order is the
    // reverse of the expected output — so a stable-sort accident would fail.
    const lb = leaderboardRows(table({
      providers: [p('zed', 1, 'ZED'), p('amy', 1, 'AMY'), p('big', 2, 'BIG')],
      countsByProvider: counts({
        zed: [['weekday', 'C1', 4]], amy: [['weekday', 'C1', 4]], big: [['weekday', 'C1', 8]],
      }),
    }));
    expect(lb.rows.map(r => r.display_name)).toEqual(['BIG', 'AMY', 'ZED']);
    expect(lb.rows.map(r => r.rank)).toEqual([1, 1, 1]);
  });

  it('gives a lone provider rank 1 on their own median', () => {
    const lb = leaderboardRows(table({
      providers: [p('solo', 0.7)],
      countsByProvider: counts({ solo: [['weekday', 'C1', 7]] }),
    }));
    expect(lb.rows).toHaveLength(1);
    expect(lb.rows[0]).toMatchObject({ rank: 1, tied: false, deltaFromMedian: 0 });
    expect(lb.median).toBeCloseTo(10, 9);
  });

  it('returns nothing, not a crash, for an empty roster', () => {
    const lb = leaderboardRows(table());
    expect(lb.rows).toEqual([]);
    expect(lb.median).toBe(0);
  });

  it('warns loudly when asked to rank on raw counts', () => {
    const lb = leaderboardRows(table({
      providers: [p('full', 1), p('half', 0.5)],
      countsByProvider: counts({
        full: [['weekday', 'C1', 8]], half: [['weekday', 'C1', 5]],
      }),
    }), { by: 'total' });
    expect(lb.rows.map(r => r.display_name)).toEqual(['FULL', 'HALF']);
    expect(lb.sortLabel).toBe('total calls (NOT normalized for FTE)');
    expect(lb.warning).toMatch(/by arithmetic alone/);
  });

  it('can rank one category, and names it', () => {
    const t = table({
      providers: [p('a', 1), p('b', 1)],
      countsByProvider: counts({
        a: [['weekday', 'C1', 9], ['saturday', 'C1', 0]],
        b: [['weekday', 'C1', 1], ['saturday', 'C1', 3]],
      }),
    });
    const lb = leaderboardRows(t, { by: 'bucket', key: 'saturday|C1' });
    expect(lb.sortLabel).toBe('Sat C1 calls per FTE');
    expect(lb.rows.map(r => r.display_name)).toEqual(['B', 'A']);
    expect(lb.rows[1]).toMatchObject({ value: 0, count: 0 });
  });

  it('propagates the cross-site flag so a summed row can be marked', () => {
    const lb = leaderboardRows(table({
      providers: [p('a', 1)],
      countsByProvider: counts({ a: [['weekday', 'C1', 1]] }),
      siteIdsByProvider: new Map([['a', ['paoli', 'lankenau']]]),
    }));
    expect(lb.rows[0].crossSite).toBe(true);
  });

  it('does not let stored-fraction noise break a tie', () => {
    // Three 8h thirds sum to 0.9999, which must read as one whole call.
    const lb = leaderboardRows(table({
      providers: [p('split', 1), p('whole', 1)],
      countsByProvider: counts({
        split: [['weekday', 'C1', 0.3333], ['weekday', 'C2', 0.3333], ['friday', 'C1', 0.3333]],
        whole: [['weekday', 'C1', 1]],
      }),
    }));
    expect(lb.rows.map(r => r.rank)).toEqual([1, 1]);
    expect(lb.rows.every(r => r.tied)).toBe(true);
  });
});

/* ── adapters ──────────────────────────────────────────────────────────────*/

describe('callCountsFromKeyedRecord', () => {
  it('splits a bucket|code key at the LAST pipe', () => {
    const out = callCountsFromKeyedRecord({
      a: { 'weekday|C1': 4, 'saturday|C3': 1 },
      b: { 'sunday|C1': 0.5 },
    });
    expect(out.get('a')).toEqual([
      { bucket: 'weekday', code: 'C1', count: 4 },
      { bucket: 'saturday', code: 'C3', count: 1 },
    ]);
    expect(out.get('b')).toEqual([{ bucket: 'sunday', code: 'C1', count: 0.5 }]);
  });

  it('drops a malformed key rather than inventing a bucket from it', () => {
    const out = callCountsFromKeyedRecord({ a: { C1: 3 }, b: { '|C1': 1 } });
    expect(out.has('a')).toBe(false);
    expect(out.has('b')).toBe(false);
  });
});

/* ── parity with the engine ────────────────────────────────────────────────*/

describe('per-FTE spread parity with rulesEngine/burdenMetrics', () => {
  /** burdenMetrics.callsPerFteStdev reads only `plan.assignments`. */
  const planOf = (): SolutionPlan => ({ assignments: [] } as unknown as SolutionPlan);

  it('matches callsPerFteStdev on the same population, priors included', () => {
    // The engine's number folds in `priorCalls` — the call a provider already
    // holds elsewhere in the block. Counting only in-plan calls made an engine
    // look 5x worse than it was. The equity table's counts are the SAME
    // whole-person quantity (everything published in the span), so the two
    // spreads must agree to the last digit or one of them is answering a
    // different question.
    const holdings: Array<[string, number, number]> = [
      // [pid, fte, calls]
      ['p1', 1, 12], ['p2', 1, 9], ['p3', 0.75, 8],
      ['p4', 0.7, 6], ['p5', 0.5, 5], ['p6', 1, 11],
    ];

    const ctx = buildCtx(
      // One open call slot, unrelated to the seeds, so nothing double-counts.
      [callSlot('s0', '2026-09-01', 'C1')],
      holdings.map(([pid, fte]) => prov(pid, fte)),
      {
        seedAssignments: holdings.flatMap(([pid, , n]) =>
          Array.from({ length: n }, (_, i) => ({
            slot_date: `2026-09-${String(i + 2).padStart(2, '0')}`,
            provider_id: pid,
            shift_type_code: 'C1',
            shift_type_category: 'call',
            derived_day_type: 'weekday',
          }))),
      },
    );
    const engineStdev = callsPerFteStdev(planOf(), ctx, true);

    const t = table({
      providers: holdings.map(([pid, fte]) => p(pid, fte)),
      countsByProvider: counts(Object.fromEntries(
        holdings.map(([pid, , n]) => [pid, [['weekday', 'C1', n] as [string, string, number]]]),
      )),
    });
    const total = equityDistribution(t, [TOTAL_KEY])[0];

    expect(engineStdev).toBeGreaterThan(0); // not vacuously equal to zero
    expect(total.stdev).toBeCloseTo(engineStdev, 12);
  });

  it('uses the population formula, not the sample one', () => {
    // n, not n-1: the roster IS the population. [2, 4] -> mean 3, pop sd 1,
    // sample sd 1.414.
    expect(populationStdev([2, 4])).toBeCloseTo(1, 12);
    expect(populationStdev([5])).toBe(0);
    expect(populationStdev([])).toBe(0);
  });
});
