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
// Three deliberate departures from the plan's original snippet, made while
// implementing (see AnnualTallyCard's task report for the fuller rationale):
//   1. The Table's `rows` prop is driven ONLY by `rows === undefined` — not by
//      an extra `loading` flag. `rows` already IS undefined exactly when
//      nothing has loaded yet, on both the self-fetch and pre-fetched paths;
//      gating on `loading` too broke the pre-fetched path, where a host that
//      passes `data={null}` while its own fetch is in flight never toggles
//      `loading` at all (this component's fetch never runs for it), so the
//      card rendered the EMPTY state ("No call takers") instead of a skeleton.
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

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Banner, Card, EmptyState, Table } from '@/components/ui';
import { formatCallWeight } from '@/lib/callBurden';
import { FAIRNESS_BUCKETS } from '@/lib/rulesEngine/shared';
import { coveredSpanLabel, offDaysText, remainingText, sortRosterRows } from '@/lib/blockPrepView';
import type { BlockPrepData } from '@/app/api/scheduling/block-prep/route.helpers';

const BUCKET_LABELS: Record<string, string> = {
  weekday: 'M–Th',
  friday: 'Fri',
  saturday: 'Sat',
  sunday: 'Sun',
};

export default function AnnualTallyCard({
  siteId,
  year,
  siteName,
  /** Bumped by the host after an edit so the card refetches. Ignored when
   *  `data` is supplied — the host owns reloading in that case. */
  refreshKey = 0,
  /**
   * Pre-fetched payload. When the host has already loaded `/block-prep` for
   * this (site, year) — as /block-prep itself has, for its roster — it passes
   * the data in and the card renders from it instead of issuing a SECOND
   * identical request. Without this the board would fire two year-wide slot
   * queries on every load and two more on every inline edit, against exactly
   * the read we just had to add an exact-count truncation guard to.
   *
   * Pass `null` (not `undefined`) while the host's own fetch is still in
   * flight — that renders the loading skeleton here too. Omit the prop
   * entirely on /dashboard, where the card is standalone and self-fetches.
   */
  data: providedData,
}: {
  siteId: string | null;
  year: number;
  siteName?: string;
  refreshKey?: number;
  data?: BlockPrepData | null;
}) {
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

  const roster = data?.roster;
  // undefined => nothing has loaded yet (true for BOTH: self-fetch before its
  // first response, and pre-fetched mode while the host still holds `data`
  // at null). [] => loaded, genuinely zero call takers. Array => loaded rows.
  // This alone is what the Table below keys its skeleton off of.
  const rows = roster?.data ? sortRosterRows(roster.data) : undefined;

  const headers = [
    'Provider',
    ...FAIRNESS_BUCKETS.map(b => BUCKET_LABELS[b] ?? b),
    'Calls',
    'PTO',
    'Off days',
  ];

  const blocks = data?.blocks;
  const showBlocksPanel = !!blocks?.error || (blocks?.data?.length ?? 0) > 0;

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
              ...FAIRNESS_BUCKETS.map(b => {
                // Plain aggregation over already-weighted counts (no rule of
                // its own) — a bucket can hold more than one parent call code.
                const total = r.callCounts
                  .filter(c => c.bucket === b)
                  .reduce((n, c) => n + c.count, 0);
                return total === 0
                  ? <span key={b} style={{ color: 'var(--text-dim)' }}>—</span>
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
            {coveredSpanLabel(data?.coveredSpan ?? null)}
          </div>

          {/* Providers with published call at this site who have NO ROW above —
              a mid-year status change, cross-site coverage, or someone simply
              not flagged as a call taker. Their calls are counted by the tally
              but belong to nobody on screen, so the count would vanish silently
              without this line. There is a live instance at Paoli (Orji holds a
              published 2026 call and is not flagged a call taker). The ids come
              from annualTally, which exposes them for exactly this purpose.
              `null` (roster read failed) vs `[]` (nobody excluded) are
              different facts; only a non-empty ARRAY renders this line. */}
          {(data?.unrosteredProviderIds?.length ?? 0) > 0 && (
            <div style={{ marginTop: 'var(--space-2)', fontSize: 'var(--fs-xs)', color: 'var(--warn)', lineHeight: 1.5 }}>
              {data!.unrosteredProviderIds!.length} provider
              {data!.unrosteredProviderIds!.length === 1 ? ' holds' : 's hold'} published call at this
              site but {data!.unrosteredProviderIds!.length === 1 ? 'is' : 'are'} not on the roster
              above — inactive, based at another site, or not marked a call taker. Those calls are
              not shown in any row.
            </div>
          )}
        </div>
      )}

      {/* Independent of the roster panel above: a failed roster read must not
          hide a blocks list that loaded fine, and vice versa (each panel
          reports what it knows). */}
      {showBlocksPanel && (
        <div style={{ padding: 'var(--space-3) var(--space-4)', borderTop: '1px solid var(--border-faint)' }}>
          {blocks?.error ? (
            <Banner tone="error">{blocks.error}</Banner>
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
