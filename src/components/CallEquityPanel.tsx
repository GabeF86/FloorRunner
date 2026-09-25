// Call equity — the two views, rendered.
//
// PURELY PRESENTATIONAL. No fetching, no state, no effects: every number
// arrives computed from `lib/callEquity.ts`, which is where the whole feature's
// arithmetic lives and where it is tested. Nothing here does math beyond
// turning a float into pixels. That split is the same one gridTheme.ts /
// blockTargets.ts use, and it is what lets the rules be unit-tested at all —
// vitest runs `environment: 'node'` here, so a component is not testable.
//
// No 'use client': there is no hook and no handler, so this renders on the
// server and a client page can still mount it.
//
// ── WHY THE COLOUR DOES NOT SAY GOOD OR BAD ────────────────────────────────
// This page puts real partners' names in a ranked list, so every visual
// choice is a claim about them. Carrying MORE call than the median is not a
// virtue and carrying less is not a failing — the schedule assigns call, the
// physician does not choose it. So the deviation bars are DIRECTIONAL, not
// tonal: --blue above the median, --indigo below, two hues of one family that
// read as "two directions" rather than "good and bad". --ok / --danger are
// deliberately NOT used for position; --danger would turn a 0.7 FTE with a
// light Saturday month into a red row.
//
// The one tonal mark is the Tukey outlier ring (--warn), and it is labelled in
// the legend as what it literally is — outside 1.5x the interquartile range —
// rather than as a verdict.
//
// ── AND WHY THE CAVEATS ARE NOT OPTIONAL ───────────────────────────────────
// `table.notes` and `table.coverageLabel` are rendered ABOVE the numbers, not
// under them. Published data starts 2026-09-01; a "YTD" leaderboard today is
// three weeks long, and a partner shown with four calls will read that as the
// system under-counting them unless the span is on the screen next to it. Same
// for scope: a single-site table under-counts the 56 physicians who work at
// two or more sites, and that has to be stated, not inferred.
//
// ── TOKENS ─────────────────────────────────────────────────────────────────
// Every colour is a globals.css custom property defined in BOTH the :root and
// the [data-theme='dark'] block (cssTokens.test.ts fails the build on a
// fallback-less var() that is defined nowhere). No Tailwind, no CSS modules —
// inline style objects with var(--token) values, per the design system.

import type { CSSProperties, ReactNode } from 'react';
import { Badge, Card, SectionLabel, StatBlock, Table } from '@/components/ui';
import { formatCallWeight } from '@/lib/callBurden';
import {
  TOTAL_KEY,
  type EquityDistribution,
  type EquityTable,
  type Leaderboard,
  type LeaderboardRow,
} from '@/lib/callEquity';

/* ── shared bits ───────────────────────────────────────────────────────────*/

const MONO: CSSProperties = {
  fontFamily: 'var(--font-mono), ui-monospace, monospace',
  fontVariantNumeric: 'tabular-nums',
};

/** Calls per FTE. One decimal: the underlying figure is a weighted float and
 *  two decimals invite a precision the roster does not have. */
const perFte = (n: number): string => n.toFixed(1);

/** Signed delta, with an explicit + so "at the median" (0.0) is visibly its
 *  own state rather than looking like a small negative. */
const signed = (n: number): string => (n >= 0 ? `+${n.toFixed(1)}` : n.toFixed(1));

/** FTE as the roster states it: 1.0, 0.75, 0.7, 0.5. Single home so the chip
 *  and the tooltip can never print the same physician's FTE two ways. */
const fmtFte = (n: number): string => n.toFixed(2).replace(/0$/, '');

/** The caveats, rendered. See the header — these are not a debug channel. */
function Notes({ label, notes }: { label: string; notes: readonly string[] }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 'var(--space-2)',
      padding: 'var(--space-3)',
      background: 'var(--tint-surface-faint)',
      border: '1px solid var(--border-faint)',
      borderRadius: 'var(--radius-md)',
    }}>
      <div style={{ ...MONO, fontSize: 'var(--fs-xs)', letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--text-muted)' }}>
        {label}
      </div>
      {notes.length === 0 ? null : (
        <ul style={{ margin: 0, paddingLeft: 'var(--space-4)', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {notes.map((n, i) => (
            <li key={i} style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-dim)', lineHeight: 1.5 }}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** FTE chip. Always beside a normalized figure: a reader must never have to
 *  guess what a per-FTE number was divided by. */
function Fte({ value }: { value: number }) {
  return (
    <span style={{
      ...MONO, fontSize: 'var(--fs-xs)', color: 'var(--text-dim)',
      padding: '1px 5px', borderRadius: 'var(--radius-sm)',
      background: 'var(--tint-surface)', whiteSpace: 'nowrap',
    }}>
      {fmtFte(value)} FTE
    </span>
  );
}

/**
 * A deviation bar: one track spanning the category's observed range, a
 * centreline at the group median, and a bar running from the median to this
 * physician's value.
 *
 * Length is the magnitude, side is the direction, and neither is a judgement
 * (see the header). A zero-width range (everyone identical) draws a bare
 * centreline — no bar, because there is no deviation to draw.
 */
function DeviationBar({
  value, median, min, max, outlier, title,
}: {
  value: number; median: number; min: number; max: number;
  outlier: 'low' | 'high' | null; title: string;
}) {
  const range = max - min;
  const pct = (v: number) => (range <= 0 ? 50 : ((v - min) / range) * 100);
  const here = pct(value);
  const mid = pct(median);
  const left = Math.min(here, mid);
  const width = Math.abs(here - mid);
  const ink = value >= median ? 'var(--blue)' : 'var(--indigo)';

  return (
    <div
      title={title}
      style={{
        position: 'relative', height: 8, width: '100%', minWidth: 48,
        background: 'var(--tint-surface)',
        borderRadius: 999,
        outline: outlier ? '1px solid var(--warn)' : undefined,
        outlineOffset: 1,
      }}
    >
      {/* the median centreline — the only reference the bar means anything against */}
      <div style={{
        position: 'absolute', left: `${mid}%`, top: -2, bottom: -2, width: 1,
        background: 'var(--border-strong)',
      }} />
      {width > 0 && (
        <div style={{
          position: 'absolute', left: `${left}%`, width: `${width}%`, top: 0, bottom: 0,
          background: `color-mix(in srgb, ${ink} 55%, transparent)`,
          borderRadius: 999,
        }} />
      )}
      {/* this physician's own position, so a zero-length bar is still locatable */}
      <div style={{
        position: 'absolute', left: `${here}%`, top: -1, bottom: -1, width: 3,
        transform: 'translateX(-1.5px)',
        background: ink, borderRadius: 999,
      }} />
    </div>
  );
}

function Legend() {
  const swatch = (background: string) => ({
    width: 10, height: 10, borderRadius: 999, background, flexShrink: 0,
  } as CSSProperties);
  const item = (node: ReactNode, text: string, key: string) => (
    <span key={key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>
      {node}{text}
    </span>
  );
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-4)', alignItems: 'center' }}>
      {item(<span style={swatch('var(--blue)')} />, 'above the group median', 'hi')}
      {item(<span style={swatch('var(--indigo)')} />, 'below the group median', 'lo')}
      {item(<span style={{ width: 1, height: 12, background: 'var(--border-strong)' }} />, 'group median', 'med')}
      {item(
        <span style={{ width: 10, height: 10, borderRadius: 999, outline: '1px solid var(--warn)', outlineOffset: 1 }} />,
        'outside 1.5 × IQR',
        'out',
      )}
    </div>
  );
}

/* ── the leaderboard ───────────────────────────────────────────────────────*/

export interface CallEquityLeaderboardProps {
  table: EquityTable;
  leaderboard: Leaderboard;
  /** Draw one physician's row picked out — their own row on their own page. */
  highlightProviderId?: string | null;
  /** Cap the rows drawn. Omitted ⇒ all of them; the count of what is hidden
   *  is always stated, because a truncated ranked list that does not say it is
   *  truncated is a different claim from the one the data makes. */
  limit?: number;
}

/**
 * Ranked and named.
 *
 * The sort quantity is printed in the header from `leaderboard.sortLabel` —
 * never hardcoded here — so this table can never show a ranked list of
 * partners without naming what ranked them. Same for `leaderboard.warning`,
 * which is non-null exactly when the caller chose a sort known to mislead.
 */
export function CallEquityLeaderboard({
  table, leaderboard, highlightProviderId, limit,
}: CallEquityLeaderboardProps) {
  const shown = limit != null ? leaderboard.rows.slice(0, limit) : leaderboard.rows;
  const hidden = leaderboard.rows.length - shown.length;

  const row = (r: LeaderboardRow): ReactNode[] => {
    const me = r.provider_id === highlightProviderId;
    return [
      <span key="rank" style={{
        ...MONO, fontSize: 'var(--fs-sm)', fontWeight: 600,
        color: me ? 'var(--text-strong)' : 'var(--text-muted)',
      }}>
        {r.rank}{r.tied ? '=' : ''}
      </span>,
      <span key="name" style={{
        display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap',
        fontWeight: me ? 700 : 500,
        color: me ? 'var(--text-strong)' : 'var(--text)',
      }}>
        {r.display_name}
        <Fte value={r.fte} />
        {r.crossSite && <Badge tone="info">multi-site</Badge>}
      </span>,
      <span key="count" style={{ ...MONO, fontSize: 'var(--fs-sm)', color: 'var(--text-dim)' }}>
        {formatCallWeight(r.count)}
      </span>,
      <span key="value" style={{ ...MONO, fontSize: 'var(--fs-md)', fontWeight: 600, color: 'var(--text-strong)' }}>
        {perFte(r.value)}
      </span>,
      <span key="delta" style={{
        ...MONO, fontSize: 'var(--fs-sm)',
        color: Math.abs(r.deltaFromMedian) < 0.05
          ? 'var(--text-dim)'
          : r.deltaFromMedian > 0 ? 'var(--blue)' : 'var(--indigo)',
      }}>
        {signed(r.deltaFromMedian)}
      </span>,
    ];
  };

  return (
    <Card
      title="Call leaderboard"
      actions={<Badge tone="neutral">{leaderboard.rows.length} physicians</Badge>}
      pad={false}
      footer={
        hidden > 0
          ? `Showing the top ${shown.length} of ${leaderboard.rows.length}. ${hidden} more are ranked but not drawn.`
          : `Ranked by ${leaderboard.sortLabel}. Ties share a rank.`
      }
    >
      <div style={{ padding: 'var(--space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        <SectionLabel>Ranked by {leaderboard.sortLabel}</SectionLabel>
        <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-dim)' }}>
          {leaderboard.coverageLabel}
        </div>
        {leaderboard.warning && (
          <div style={{
            fontSize: 'var(--fs-sm)', color: 'var(--warn)',
            background: 'var(--warn-bg)', border: '1px solid var(--border-faint)',
            borderRadius: 'var(--radius-md)', padding: 'var(--space-3)', lineHeight: 1.5,
          }}>
            {leaderboard.warning}
          </div>
        )}
        <Notes label="Read this table with" notes={table.notes} />
      </div>
      <Table
        minWidth={620}
        headers={['#', 'Physician', 'Calls', 'Per FTE', 'vs median']}
        rows={shown.map(row)}
        empty={<div style={{ padding: 'var(--space-6)', color: 'var(--text-dim)', fontSize: 'var(--fs-sm)' }}>
          No physician on this roster carries a stated FTE, so nothing can be normalized or ranked.
        </div>}
      />
    </Card>
  );
}

/* ── the per-category distribution ─────────────────────────────────────────*/

export interface CallEquityDistributionProps {
  table: EquityTable;
  distributions: readonly EquityDistribution[];
  highlightProviderId?: string | null;
}

/**
 * Each physician's calls-per-FTE in each category, against that category's own
 * median and spread.
 *
 * This is the half a rank cannot do: "7th of 74" reads the same whether 7th is
 * a tenth of a call off the median or nine calls off. Here the bar length IS
 * that distance, drawn against the category's own observed range, and the
 * header carries the median and the interquartile range it is measured from.
 *
 * Categories are never netted against each other — being over on M–Th C2 and
 * under on Saturdays is not "even", and the group's own no-netting rule
 * (fteTarget.ts) says so. There is deliberately no summary column combining
 * them beyond the plain "All call" total, which is a sum, not a score.
 */
export function CallEquityDistribution({
  table, distributions, highlightProviderId,
}: CallEquityDistributionProps) {
  // Per-category columns in the table's own order, with the plain total last.
  const byKey = new Map(distributions.map(d => [d.key, d]));
  const cols = [
    ...table.columns.map(c => byKey.get(c.key)).filter((d): d is EquityDistribution => !!d),
    ...(byKey.has(TOTAL_KEY) ? [byKey.get(TOTAL_KEY)!] : []),
  ];
  const positionsByKey = new Map(
    cols.map(d => [d.key, new Map(d.positions.map(x => [x.provider_id, x]))]),
  );

  const header = (d: EquityDistribution): ReactNode => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 96 }}>
      <span style={{ color: 'var(--text-muted)' }}>{d.label}</span>
      <span style={{ ...MONO, textTransform: 'none', letterSpacing: 0, color: 'var(--text-dim)', fontWeight: 400 }}>
        med {perFte(d.median)} · IQR {perFte(d.iqr)}
      </span>
    </div>
  );

  const rows = table.rows.map(r => {
    const me = r.provider_id === highlightProviderId;
    const cells: ReactNode[] = [
      <span key="name" style={{
        display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap',
        fontWeight: me ? 700 : 500,
        color: me ? 'var(--text-strong)' : 'var(--text)',
      }}>
        {r.display_name}
        <Fte value={r.fte} />
        {r.crossSite && <Badge tone="info">multi-site</Badge>}
      </span>,
    ];
    for (const d of cols) {
      const pos = positionsByKey.get(d.key)!.get(r.provider_id);
      cells.push(
        <div key={d.key} style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 96 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
            <span style={{ ...MONO, fontSize: 'var(--fs-sm)', fontWeight: 600, color: 'var(--text-strong)' }}>
              {pos ? perFte(pos.perFte) : '—'}
            </span>
            <span style={{ ...MONO, fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>
              {pos ? `(${formatCallWeight(pos.count)})` : ''}
            </span>
          </div>
          {pos && (
            <DeviationBar
              value={pos.perFte}
              median={d.median}
              min={d.min}
              max={d.max}
              outlier={pos.outlier}
              title={
                `${r.display_name} — ${d.label}: ${formatCallWeight(pos.count)} calls at ${fmtFte(r.fte)} FTE `
                + `= ${perFte(pos.perFte)} per FTE, ${signed(pos.deltaFromMedian)} vs the group median `
                + `of ${perFte(d.median)}. `
                // A quartile is meaningless when the group is level — every
                // fence sits on the same value, so "quartile 1 of 4" would
                // read as a low placing rather than as no spread at all.
                + (d.iqr <= 0
                  ? 'The middle half of the group is on one value here.'
                  : `Quartile ${pos.quartile} of 4${pos.outlier ? `, ${pos.outlier} outlier` : ''}.`)
              }
            />
          )}
        </div>,
      );
    }
    return cells;
  });

  const total = byKey.get(TOTAL_KEY);

  return (
    <Card
      title="Per-category distribution"
      actions={<Badge tone="neutral">{table.columns.length} categories</Badge>}
      pad={false}
      footer="Each category is measured on its own. An extra weekday call does not cancel a missing Saturday — they are not the same duty and they are not priced the same."
    >
      <div style={{ padding: 'var(--space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <SectionLabel>Calls per FTE, by day type and call code</SectionLabel>
        <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-dim)' }}>{table.coverageLabel}</div>

        {total && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-6)' }}>
            <StatBlock value={total.n} caption="physicians compared" />
            <StatBlock value={perFte(total.median)} caption="group median, calls per FTE" size="lg" />
            <StatBlock value={`${perFte(total.q1)} – ${perFte(total.q3)}`} caption="middle half of the group" />
            <StatBlock value={perFte(total.stdev)} caption="spread of all call (population SD)" />
            <StatBlock value={table.coveredDays} caption="days of published schedule counted" />
          </div>
        )}

        <Legend />
        <Notes label="Read this table with" notes={table.notes} />
      </div>

      <Table
        minWidth={260 + cols.length * 130}
        headers={['Physician', ...cols.map(header)]}
        rows={rows}
        empty={<div style={{ padding: 'var(--space-6)', color: 'var(--text-dim)', fontSize: 'var(--fs-sm)' }}>
          No physician on this roster carries a stated FTE, so nothing can be normalized.
        </div>}
      />
    </Card>
  );
}

/* ── both, stacked ─────────────────────────────────────────────────────────*/

export interface CallEquityPanelProps {
  table: EquityTable;
  leaderboard: Leaderboard;
  distributions: readonly EquityDistribution[];
  highlightProviderId?: string | null;
  /** Passed through to the leaderboard only. */
  leaderboardLimit?: number;
}

/**
 * Both views, in the order Gabriel asked for them: the ranked list answers
 * "who", the distribution answers "by how much, and in what". They ship
 * together on purpose — the leaderboard alone invites a conversation about
 * people, and the distribution is what turns it back into one about the
 * schedule.
 *
 * Providers excluded for a zero or unstated FTE are listed at the foot rather
 * than dropped. A partner missing from a named list is a question, and
 * "silently absent" is the worst available answer to it.
 */
export function CallEquityPanel({
  table, leaderboard, distributions, highlightProviderId, leaderboardLimit,
}: CallEquityPanelProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
      <CallEquityLeaderboard
        table={table}
        leaderboard={leaderboard}
        highlightProviderId={highlightProviderId}
        limit={leaderboardLimit}
      />
      <CallEquityDistribution
        table={table}
        distributions={distributions}
        highlightProviderId={highlightProviderId}
      />
      {(table.excluded.length > 0 || table.unrosteredProviderIds.length > 0) && (
        <Card title="Not in these figures">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
            {table.excluded.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-dim)', lineHeight: 1.5 }}>
                  Excluded because there is no FTE to normalize by — not because they took no call.
                  Where a call count is shown, that call is real and is counted nowhere on this page.
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
                  {table.excluded.map(e => (
                    <span key={e.provider_id} style={{
                      display: 'inline-flex', alignItems: 'center', gap: 6,
                      fontSize: 'var(--fs-sm)', color: 'var(--text)',
                      background: 'var(--tint-surface)', border: '1px solid var(--border-faint)',
                      borderRadius: 999, padding: '2px 10px',
                    }}>
                      {e.display_name}
                      <Badge tone={e.reason === 'unstated-fte' ? 'warn' : 'neutral'}>
                        {e.reason === 'unstated-fte' ? 'FTE not stated' : 'FTE 0'}
                      </Badge>
                      {e.count > 0 && (
                        <span style={{ ...MONO, fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>
                          {formatCallWeight(e.count)} calls
                        </span>
                      )}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {table.unrosteredProviderIds.length > 0 && (
              <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-dim)', lineHeight: 1.5 }}>
                {table.unrosteredProviderIds.length} provider id
                {table.unrosteredProviderIds.length === 1 ? '' : 's'} hold call in this span but are
                not on the roster supplied, so their calls appear in no row above.
              </div>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
