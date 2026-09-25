/**
 * CallEquityPanel render-path tests (node environment, zero new deps).
 *
 * Strategy per Modal.test.tsx / AnnualTallyCard.test.tsx: interaction needs
 * jsdom, but render OUTPUT is testable through react-dom/server. This
 * component has no state and no effects, so its static markup IS the whole
 * component.
 *
 * What is actually asserted is the handful of things that would be WRONG
 * rather than merely ugly if they regressed:
 *   - the covered span and the caveats appear beside the numbers, not
 *     somewhere else on the page;
 *   - the sort quantity is named, from the data, never hardcoded here;
 *   - a physician excluded for a zero/unstated FTE is listed, with the call
 *     they nonetheless hold;
 *   - the degenerate shapes (nobody, one person, everyone identical) render
 *     instead of dividing by a zero range.
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CallEquityDistribution, CallEquityLeaderboard, CallEquityPanel } from './CallEquityPanel';
import {
  callEquityTable,
  equityDistribution,
  leaderboardRows,
  type CallEquityInput,
  type EquityCallCount,
} from '@/lib/callEquity';

const SCOPE = { kind: 'single-site' as const, siteId: 'paoli', siteLabel: 'Paoli' };
const COVERAGE = {
  segments: [{ start: '2026-09-01', end: '2026-09-24' }],
  requested: { start: '2026-01-01', end: '2026-09-24' },
};

function counts(entries: Record<string, Array<[string, string, number]>>) {
  return new Map<string, EquityCallCount[]>(
    Object.entries(entries).map(([pid, list]) => [
      pid, list.map(([bucket, code, count]) => ({ bucket, code, count })),
    ]),
  );
}

function views(over: Partial<CallEquityInput> = {}) {
  const table = callEquityTable({
    scope: SCOPE,
    coverage: COVERAGE,
    providers: [],
    countsByProvider: new Map(),
    ...over,
  });
  return { table, leaderboard: leaderboardRows(table), distributions: equityDistribution(table) };
}

const ROSTER = views({
  providers: [
    { provider_id: 'a', display_name: 'Farkas', fte_value: 1 },
    { provider_id: 'b', display_name: 'Havildar', fte_value: 0.75 },
    { provider_id: 'c', display_name: 'Horan', fte_value: 0.5 },
    { provider_id: 'z', display_name: 'Per Diem', fte_value: 0 },
  ],
  countsByProvider: counts({
    a: [['weekday', 'C1', 5], ['weekday', 'C2', 4], ['saturday', 'C1', 1], ['saturday', 'C3', 1]],
    b: [['weekday', 'C1', 3], ['weekday', 'C2', 3], ['sunday', 'C1', 1]],
    c: [['weekday', 'C1', 2], ['saturday', 'C1', 0.5]],
    z: [['weekday', 'C1', 3]],
  }),
  siteIdsByProvider: new Map([['a', ['paoli']], ['b', ['paoli', 'lankenau']], ['c', ['paoli']]]),
  slate: { parLevel: 12, weightByKey: new Map([['weekday|C1', 44], ['sunday|C1', 11]]) },
});

const html = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node);

describe('CallEquityLeaderboard', () => {
  const markup = html(<CallEquityLeaderboard table={ROSTER.table} leaderboard={ROSTER.leaderboard} />);

  it('prints the covered span next to the numbers, not the requested one alone', () => {
    // The whole point: "YTD" over three published weeks must not read as a
    // partner having taken four calls all year.
    expect(markup).toContain('2026-09-01 – 2026-09-24 (24 days)');
    expect(markup).toContain('of the 2026-01-01 – 2026-09-24 requested');
  });

  it('names the sort quantity from the data', () => {
    expect(markup).toContain('calls per FTE, all categories');
    expect(ROSTER.leaderboard.sortLabel).toBe('calls per FTE, all categories');
  });

  it('renders every caveat the table generated', () => {
    for (const note of ROSTER.table.notes) expect(markup).toContain(note.slice(0, 40));
  });

  it('shows each normalized figure beside the FTE it was divided by', () => {
    expect(markup).toContain('0.75 FTE');
    expect(markup).toContain('0.5 FTE');
    expect(markup).toContain('1.0 FTE');
  });

  it('marks a multi-site row', () => {
    expect(markup).toContain('multi-site');
  });

  it('states what a limit hid rather than silently truncating', () => {
    const limited = html(
      <CallEquityLeaderboard table={ROSTER.table} leaderboard={ROSTER.leaderboard} limit={1} />,
    );
    expect(limited).toContain('Showing the top 1 of 3');
    expect(limited).toContain('2 more are ranked but not drawn');
  });

  it('carries the warning when ranked on raw counts', () => {
    const raw = leaderboardRows(ROSTER.table, { by: 'total' });
    expect(html(<CallEquityLeaderboard table={ROSTER.table} leaderboard={raw} />))
      .toContain('by arithmetic alone');
  });
});

describe('CallEquityDistribution', () => {
  const markup = html(
    <CallEquityDistribution table={ROSTER.table} distributions={ROSTER.distributions} />,
  );

  it('heads each category with its own median and IQR', () => {
    expect(markup).toContain('M–Th C1');
    expect(markup).toContain('Sat C3');
    expect(markup).toMatch(/med \d+\.\d · IQR \d+\.\d/);
  });

  it('renders a legend that describes position, never merit', () => {
    expect(markup).toContain('above the group median');
    expect(markup).toContain('below the group median');
    expect(markup).toContain('outside 1.5 × IQR');
    expect(markup).not.toMatch(/\b(good|bad|poor|slacker|underperform)\b/i);
  });

  it('states the no-netting rule where a reader will hit it', () => {
    expect(markup).toContain('does not cancel a missing Saturday');
  });

  it('titles each bar with the raw count, the FTE and the delta', () => {
    expect(markup).toMatch(/Havildar — M–Th C1: 3 calls at 0\.75 FTE/);
    expect(markup).toContain('vs the group median');
  });
});

describe('CallEquityPanel', () => {
  it('renders both views and the excluded list', () => {
    const markup = html(<CallEquityPanel {...ROSTER} />);
    expect(markup).toContain('Call leaderboard');
    expect(markup).toContain('Per-category distribution');
    expect(markup).toContain('Not in these figures');
    // Excluded, and the call they still hold is named — never a silent drop.
    expect(markup).toContain('Per Diem');
    expect(markup).toContain('FTE 0');
    expect(markup).toContain('3 calls');
  });

  it('renders an empty roster as an explanation, not a blank table', () => {
    const markup = html(<CallEquityPanel {...views()} />);
    expect(markup).toContain('nothing can be normalized');
    expect(markup).not.toContain('Not in these figures');
  });

  it('renders a single physician without dividing by a zero range', () => {
    const one = views({
      providers: [{ provider_id: 'a', display_name: 'Solo', fte_value: 0.7 }],
      countsByProvider: counts({ a: [['weekday', 'C1', 7]] }),
    });
    const markup = html(<CallEquityPanel {...one} />);
    expect(markup).toContain('Solo');
    expect(markup).not.toContain('NaN');
    expect(markup).not.toContain('Infinity');
  });

  /** The outlier ring, counted. One occurrence is the legend's own swatch;
   *  anything beyond that is a ring drawn on a real physician's bar. */
  const rings = (markup: string) =>
    markup.split('outline:1px solid var(--warn)').length - 1;

  it('renders an all-equal group flat, with no bar and no outlier ring', () => {
    const flat = views({
      providers: [
        { provider_id: 'a', display_name: 'A', fte_value: 1 },
        { provider_id: 'b', display_name: 'B', fte_value: 0.5 },
      ],
      countsByProvider: counts({ a: [['weekday', 'C1', 4]], b: [['weekday', 'C1', 2]] }),
    });
    const markup = html(<CallEquityPanel {...flat} />);
    expect(markup).not.toContain('NaN');
    expect(rings(markup)).toBe(1);    // the legend swatch only
    expect(markup).toContain('+0.0'); // both sit ON the median
    // A quartile would read as a placing when there is no spread to place in.
    expect(markup).toContain('The middle half of the group is on one value here.');
    expect(markup).not.toContain('Quartile 1 of 4');
  });

  it('draws the ring on a real outlier', () => {
    const skewed = views({
      providers: ['a', 'b', 'c', 'd', 'e', 'f'].map(id => ({
        provider_id: id, display_name: id.toUpperCase(), fte_value: 1,
      })),
      countsByProvider: counts({
        a: [['weekday', 'C1', 4]], b: [['weekday', 'C1', 4]], c: [['weekday', 'C1', 4]],
        d: [['weekday', 'C1', 5]], e: [['weekday', 'C1', 5]], f: [['weekday', 'C1', 40]],
      }),
    });
    const markup = html(<CallEquityDistribution {...skewed} />);
    expect(rings(markup)).toBeGreaterThan(1);
    expect(markup).toContain('high outlier');
  });
});
