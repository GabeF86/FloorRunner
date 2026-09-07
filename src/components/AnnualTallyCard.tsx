'use client';

// Annual tally — the calendar-year running totals, mounted BOTH on /block-prep
// and on /dashboard (Gabriel 2026-09-06: "a window on the scheduling homepage
// that keeps tally of all the call counts, remaining PTO days and remaining off
// days"). Self-contained: it fetches its own data so either host can drop it in
// with a site id and nothing else.
//
// This card shows COUNTS, not over/under. Obligations are per-block, from the
// stated FTE bands, and live in the schedule's own Call Counts modal — linked
// from the block list below the table. Adding an annual over/under here would
// be a second obligation model running beside the bands.
//
// Zero math lives here. Every NUMBER comes from lib/annualTally.ts via the
// block-prep route, and every STRING from lib/blockPrepView.ts. The one
// exception is the per-bucket cell total, a plain reduce over already-computed
// weighted counts (no business rule, no rounding decision of its own) —
// formatCallWeight still owns turning that raw float into text.
//
// Departures from the plan's original snippet, all found by tracing render
// paths (see the task reports for the fuller rationale; render-path coverage
// lives in AnnualTallyCard.test.tsx, per Modal.test.tsx's renderToStaticMarkup
// strategy — useEffect never fires under SSR, so pre-fetched mode and the
// pre-effect self-fetch paint are both exercised there):
//   1. The Table's `rows` prop is driven ONLY by `rows === undefined` — not by
//      an extra `loading` flag. `rows` already IS undefined exactly when
//      nothing has loaded yet, on both the self-fetch and pre-fetched paths.
//      The plan's `loading && !rows` gate broke BOTH: in pre-fetched mode
//      `loading` never toggles at all (this component's own fetch never runs
//      for it), and on /dashboard's self-fetch it flashed the EMPTY state
//      ("No call takers") on every first paint, before the effect had a
//      chance to set `loading` true.
//   2. Fairness-bucket columns (M–Th / Fri / Sat / Sun) always render, rather
//      than being filtered to buckets with a non-zero count. Filtering tied
//      the table HEADER to `rows`, which is undefined while loading, so the
//      skeleton rendered with fewer columns than the loaded table would —
//      real, visible layout shift the instant data arrived. It would also
//      make a column vanish for a year whose block simply hasn't been
//      published yet, reading as "this site doesn't run Sunday call" rather
//      than "not scheduled yet" — the exact confusion a chief would want
//      flagged. A steady dash reads as "zero"; a disappearing column doesn't
//      read as anything in particular.
//   3. The roster panel and the blocks panel render independently, so a
//      `roster.error` no longer hides an otherwise-successful `blocks` read
//      (or vice versa) — "data.roster.error and data.blocks.error are
//      separate panels." The covered-span caption and the unrostered
//      footnote stay tied to the roster's own success, because both are
//      byproducts of the same annual-tally computation the roster read feeds
//      (the route nulls both out whenever the roster read fails, so there is
//      nothing honest to show there regardless).
//   4. Fix 1 (review): decoupling #3 alone made a FAILED BLOCKS read render
//      TWICE — route.helpers.ts deliberately sets roster.error to the exact
//      same string as blocks.error when a blocks failure is what took the
//      roster down with it ("A FAILED BLOCKS READ MUST FAIL THE ROSTER TOO"),
//      and the nested plan layout absorbed that into a single banner; fully
//      decoupled, the two panels rendered the identical message stacked. The
//      blocks banner is now suppressed exactly when its message byte-matches
//      the roster's — every OTHER blocks failure still gets its own banner.
//   5. Fix 5 (review): a payload for the wrong (site, year) is treated as "not
//      loaded" rather than rendered, so a late self-fetch response after the
//      user switched sites, or a pre-fetched host handing over the previous
//      site's data while its own new fetch is in flight, shows a skeleton
//      instead of one site's numbers under another site's title.
//   6. Fix 6 (review): `data` and `refreshKey` are a discriminated union —
//      `refreshKey` only means anything in self-fetch mode (see its own doc
//      comment), and passing both was a silent no-op trap. Now a type error.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Banner, Card, EmptyState, Table } from '@/components/ui';
import { formatCallWeight } from '@/lib/callBurden';
// The bucket list and the Call Counts modal's own column labels (Fix 4,
// review) — this card's whole purpose is to point at that modal, so the two
// are MEANT to agree, and a local copy could silently drift from it.
// `BUCKET_LABELS` is a `Record<BucketDayType, string>` keyed off the very list
// imported beside it, so it is exhaustive by construction: a fifth bucket
// would fail THAT map to compile rather than render an un-labelled raw key.
//
// BUCKET_DAY_TYPES, not rulesEngine/shared's FAIRNESS_BUCKETS: the two are the
// same four strings and in-flight work moves ownership to `shared`, with
// callCountDays re-exporting. But that move is UNCOMMITTED, and importing it
// from there left this branch failing to typecheck in a clean checkout while
// passing in the working tree that happened to have it — a green suite that
// would have broken the Vercel build on merge. This import is correct today
// and stays byte-identical after the move lands.
import { BUCKET_DAY_TYPES } from '@/lib/callCountDays';
import { BUCKET_LABELS } from '@/lib/callCountColumns';
import {
  coveredSpanLabel, offDaysText, remainingText, sortRosterRows, unrosteredFootnote,
} from '@/lib/blockPrepView';
import type { BlockPrepData } from '@/app/api/scheduling/block-prep/route.helpers';

type AnnualTallyCardProps = {
  siteId: string | null;
  year: number;
  siteName?: string;
} & (
  | {
      /**
       * Pre-fetched payload. When the host has already loaded `/block-prep`
       * for this (site, year) — as /block-prep itself has, for its roster —
       * it passes the data in and the card renders from it instead of
       * issuing a SECOND identical request. Without this the board would
       * fire two year-wide slot queries on every load and two more on every
       * inline edit, against exactly the read we just had to add an
       * exact-count truncation guard to.
       *
       * Pass `null` (not `undefined`) while the host's own fetch is still in
       * flight — that renders the loading skeleton here too. Omit `data`
       * entirely (see the other branch) on /dashboard, where the card is
       * standalone and self-fetches.
       *
       * `refreshKey` is not accepted alongside `data` — the host owns
       * reloading in this mode (it refetches and passes a new `data`), so a
       * `refreshKey` here would be silently ignored (Fix 6, review: this is
       * now a type error instead of a silent no-op).
       */
      data: BlockPrepData | null;
      refreshKey?: undefined;
    }
  | {
      data?: undefined;
      /** Bumped by the host after an edit so the card refetches. Only
       *  meaningful in self-fetch mode (no `data` prop) — see above. */
      refreshKey?: number;
    }
);

export default function AnnualTallyCard(props: AnnualTallyCardProps) {
  const { siteId, year, siteName, data: providedData, refreshKey = 0 } = props;
  const [fetched, setFetched] = useState<BlockPrepData | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const selfFetch = providedData === undefined;
  const data = selfFetch ? fetched : providedData;

  const load = useCallback(async () => {
    if (!selfFetch) return;
    if (!siteId) { setFetched(null); return; }
    setFatal(null);
    try {
      const res = await fetch(`/api/scheduling/block-prep?site_id=${siteId}&year=${year}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setFatal(body.error || `Request failed (${res.status})`);
        setFetched(null);
        return;
      }
      setFetched(await res.json());
    } catch (e) {
      setFatal(e instanceof Error ? e.message : 'Network error');
      setFetched(null);
    }
  }, [siteId, year, selfFetch]);

  useEffect(() => { load(); }, [load, refreshKey]);

  const title = `${year} running tally${siteName ? ` — ${siteName}` : ''}`;

  if (!siteId) {
    return (
      <Card title="Annual tally">
        <EmptyState
          icon="∑"
          title="Pick a site"
          hint="Call counts, PTO and off days are tracked per site — choose one to see the year's running totals."
        />
      </Card>
    );
  }

  if (fatal) {
    return <Card title={title}><Banner tone="error">{fatal}</Banner></Card>;
  }

  // Fix 5 (review): a payload stamped for a DIFFERENT (site, year) than what
  // this render is asking for is treated exactly like "not loaded yet" —
  // never rendered as-is. Reachable two ways: a self-fetch response that
  // lands late, after the user has already moved on to another site or year;
  // or a pre-fetched host hasn't updated `data` yet for a new siteId/year it
  // already passed down (Task 10 makes this a real, not theoretical, case).
  // `BlockPrepData.site_id`/`.year` are stamped on every shape the route
  // returns, including every failure panel, so this guard is orthogonal to
  // roster/blocks success or failure.
  const loaded = data && data.site_id === siteId && data.year === year ? data : null;

  const roster = loaded?.roster;
  // undefined => nothing has loaded yet for THIS (site, year) — true for: not
  // yet fetched, a pre-fetched host still holding null, or a stale payload
  // just discarded above. [] => loaded, genuinely zero call takers. Array =>
  // loaded rows. This alone is what the Table below keys its skeleton off of.
  const rows = roster?.data ? sortRosterRows(roster.data) : undefined;

  const headers = [
    'Provider',
    ...BUCKET_DAY_TYPES.map(b => BUCKET_LABELS[b]),
    'Calls',
    'PTO',
    'Off days',
  ];

  const blocks = loaded?.blocks;
  // Fix 1 (review): suppress the blocks banner ONLY when it is byte-identical
  // to the roster's — the signature of the cascade where a failed blocks read
  // took the roster down with it (route.helpers.ts's `fail(blocks.error,
  // blocks)`). Any other blocks failure (a different message, or one with no
  // corresponding roster failure) still renders its own banner — the
  // decoupling above stays in force for every other case.
  const blocksError = blocks?.error && blocks.error !== roster?.error ? blocks.error : null;
  const showBlocksPanel = !!blocksError || (blocks?.data?.length ?? 0) > 0;

  // Fix 3 (review): the sentence lives in lib, not assembled here — this is
  // the only line standing between a chief and a silently vanished call
  // count, and inline pluralization branches are exactly what zero-inline-
  // strings prohibits. Null for both "roster failed" and "nobody excluded";
  // only a non-empty array produces text (see unrosteredFootnote's own doc).
  const footnote = unrosteredFootnote(loaded?.unrosteredProviderIds ?? null);

  return (
    <Card title={title} pad={false}>
      <div style={{ padding: roster?.error ? 'var(--space-4)' : 0 }}>
        {roster?.error ? (
          <Banner tone="error">{roster.error}</Banner>
        ) : (
          <Table
            headers={headers}
            minWidth={760}
            rows={rows === undefined ? undefined : rows.map(r => [
              <Link
                key="name"
                href={`/providers/${r.provider_id}`}
                style={{ fontWeight: 700, color: 'var(--text-strong)', textDecoration: 'none' }}
              >
                {r.display_name}
              </Link>,
              ...BUCKET_DAY_TYPES.map(b => {
                // Plain aggregation over already-weighted counts (no rule of
                // its own) — a bucket can hold more than one parent call code.
                const total = r.callCounts
                  .filter(c => c.bucket === b)
                  .reduce((n, c) => n + c.count, 0);
                return total === 0
                  // Fix 7 (review, a11y): the dash alone reads to a screen
                  // reader as "em dash", not "0 calls" — name it explicitly.
                  // A bare <span> has an implicit ARIA role of `generic`,
                  // which per the ARIA spec PROHIBITS naming from `aria-label`
                  // (browsers strip it) — it only appeared to work because
                  // `title` is a valid name source independent of role.
                  // `role="img"` is one of the roles that DOES permit
                  // `aria-label` naming, so this now conforms (axe-clean).
                  ? (
                    <span
                      key={b}
                      role="img"
                      aria-label="0 calls"
                      title="0 calls"
                      style={{ color: 'var(--text-dim)' }}
                    >
                      —
                    </span>
                  )
                  : <span key={b}>{formatCallWeight(total)}</span>;
              }),
              <span key="total" style={{ fontWeight: 700 }}>{formatCallWeight(r.callTotal)}</span>,
              <span key="pto" style={{ fontSize: 'var(--fs-sm)' }}>{remainingText(r.pto)}</span>,
              <span key="off" style={{ fontSize: 'var(--fs-sm)' }}>{offDaysText(r.offDayBudget, r.offDaysUsed)}</span>,
            ])}
            empty={
              <EmptyState
                icon="∑"
                title="No call takers at this site"
                hint="Mark a provider as a call taker with this site as their home site and they'll appear here."
              />
            }
          />
        )}
      </div>

      {/* Covered-span caption and the unrostered footnote are byproducts of the
          SAME annual-tally pass the roster read feeds — the route nulls both
          out whenever the roster read fails, so they only ever have something
          honest to say once the roster itself has genuinely loaded
          (rows !== undefined implies roster.data, i.e. success). */}
      {rows !== undefined && (
        <div style={{ padding: '0 var(--space-4) var(--space-4)' }}>
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', lineHeight: 1.5 }}>
            {coveredSpanLabel(loaded?.coveredSpan ?? null)}
          </div>

          {footnote && (
            // Fix 7 (review, a11y): role="note" so its only warning signal
            // isn't colour alone.
            <div
              role="note"
              style={{ marginTop: 'var(--space-2)', fontSize: 'var(--fs-xs)', color: 'var(--warn)', lineHeight: 1.5 }}
            >
              {footnote}
            </div>
          )}
        </div>
      )}

      {/* Independent of the roster panel above: a failed roster read must not
          hide a blocks list that loaded fine, and vice versa (each panel
          reports what it knows) — except the identical-message case Fix 1
          suppresses, which the roster banner above already shows. */}
      {showBlocksPanel && (
        <div style={{ padding: 'var(--space-3) var(--space-4)', borderTop: '1px solid var(--border-faint)' }}>
          {blocksError ? (
            <Banner tone="error">{blocksError}</Banner>
          ) : (
            <>
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginBottom: 'var(--space-2)' }}>
                Per-block obligations live in each schedule&rsquo;s Call Counts:
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
                {(blocks?.data ?? []).map(b => (
                  <Link
                    key={b.schedule_id}
                    href={`/schedules/${b.schedule_id}`}
                    style={{
                      fontSize: 'var(--fs-sm)', textDecoration: 'none',
                      color: 'var(--blue)', border: '1px solid var(--border-faint)',
                      borderRadius: 'var(--radius-sm)', padding: '4px 10px',
                    }}
                  >
                    {b.schedule_name}
                  </Link>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </Card>
  );
}
