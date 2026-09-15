'use client';

// Assignment History tab of /providers/[id] — the year-stepped call-burden
// tiles and the assignment table behind them.
//
// DYNAMICALLY IMPORTED by page.tsx. Only one of the eight tabs is ever on
// screen, and this is the last one in the strip: everything below — the burden
// fetch, the StatTile grid, the Table — used to ship in the page's own chunk on
// every open of the route, including the overwhelming majority that never leave
// the Profile tab. It now loads on first click (or on hover, which prefetches).

import { useState, useEffect } from 'react';
import { formatBreakdown, type BreakdownRow } from '@/lib/callCodeBreakdown';
import { Badge, Banner, Button, Card, EmptyState, Spinner, Table } from '@/components/ui';
import { SectionLabel, FormGrid, StatTile, TabStack } from './ui';

interface BurdenData {
  period: { from: string; to: string };
  burden: Record<string, number>;
  breakdown: Record<string, BreakdownRow[]>;
  history: Array<{
    id: string;
    slot_date: string;
    shift_code: string;
    shift_name: string;
    shift_category: string;
    day_type: string | null;
    source_type: string;
  }>;
}

const BURDEN_LABELS: Record<string, string> = {
  total_assignments: 'Total Assignments',
  total_call: 'Total Call',
  weekday_call: 'Weekday Call',
  friday_call: 'Friday Call',
  weekend_call: 'Weekend Call',
  holiday_call: 'Holiday Call',
};

// The six figures are not six peers: the four day-type buckets DECOMPOSE
// total_call. Splitting them across a rule says so, and replaces the old
// BURDEN_COLORS — six unrelated hues (#64748b, #0ea5e9, #6366f1, #f59e0b,
// #f87171, #10b981) on six tiles, which encoded nothing since the set is
// neither a scale nor a set of statuses, and all six were dark-theme values.
const BURDEN_TOTALS = ['total_assignments', 'total_call'] as const;
const BURDEN_BUCKETS = ['weekday_call', 'friday_call', 'weekend_call', 'holiday_call'] as const;

export function HistoryTab({ providerId }: { providerId: string }) {
  const [data, setData] = useState<BurdenData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [year, setYear] = useState(new Date().getFullYear());

  useEffect(() => {
    // The stepper can be clicked faster than the route answers. Without this
    // guard a slower EARLIER response can resolve last and paint the previous
    // year's burden under the current year's heading — silently wrong numbers,
    // which is worse than a spinner. The cleanup runs before the next effect,
    // so only the newest request is allowed to write state.
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await fetch(`/api/scheduling/providers/${providerId}/burden?from=${year}-01-01&to=${year}-12-31`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          if (cancelled) return;
          // A failed read must never render as a clean zero-burden year, so the
          // stale figures are dropped and the error path takes over.
          setData(null);
          setError(body.error || `Could not load assignment history (${res.status})`);
          return;
        }
        const json = await res.json();
        if (cancelled) return;
        setData(json);
      } catch (e) {
        if (cancelled) return;
        setData(null);
        setError(e instanceof Error ? e.message : 'Network error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [providerId, year]);

  const formatDate = (d: string) => {
    const date = new Date(d + 'T12:00:00');
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  // The year stepper stays mounted through load and failure so the way OUT of
  // an empty year is never the thing that disappears.
  const yearBar = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
      <Button variant="secondary" size="sm" title="Previous year" onClick={() => setYear(y => y - 1)}>&larr;</Button>
      <span style={{
        fontSize: 'var(--fs-lg)', fontWeight: 700, color: 'var(--text-strong)',
        minWidth: 56, textAlign: 'center',
        fontFamily: 'var(--font-mono), ui-monospace, monospace',
        fontVariantNumeric: 'tabular-nums',
      }}>{year}</span>
      <Button variant="secondary" size="sm" title="Next year" onClick={() => setYear(y => y + 1)}>&rarr;</Button>
    </div>
  );

  if (loading) {
    return (
      <TabStack>
        {yearBar}
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', color: 'var(--text-muted)', fontSize: 'var(--fs-sm)' }}>
          <Spinner /> Loading assignments…
        </div>
      </TabStack>
    );
  }
  if (!data) {
    return (
      <TabStack>
        {yearBar}
        <Banner tone="error">
          Could not load this provider&rsquo;s assignment history{error ? `: ${error}` : '.'}
        </Banner>
      </TabStack>
    );
  }

  const tile = (key: string, emphasis?: boolean) => (
    <StatTile
      key={key}
      value={data.burden[key] ?? 0}
      label={BURDEN_LABELS[key]}
      // Breakdown by shift code, e.g. "7 C2 · 3 C1" under a Weekday Call of
      // 10. Computed by the route from the same predicate as the total, so
      // these always sum to the number above them. Empty renders nothing,
      // which leaves an untouched category looking exactly as it did.
      detail={formatBreakdown(data.breakdown?.[key] ?? []) || undefined}
      emphasis={emphasis}
    />
  );

  return (
    <TabStack>
      {yearBar}

      <Card title="Call burden">
        <FormGrid cols="repeat(auto-fit, minmax(190px, 1fr))" style={{ gap: 'var(--space-3)' }}>
          {BURDEN_TOTALS.map(k => tile(k, true))}
        </FormGrid>
        <div style={{ marginTop: 'var(--space-4)' }}>
          <SectionLabel>Total call, by day type</SectionLabel>
          <FormGrid cols="repeat(auto-fit, minmax(150px, 1fr))" style={{ gap: 'var(--space-3)' }}>
            {BURDEN_BUCKETS.map(k => tile(k))}
          </FormGrid>
        </div>
      </Card>

      <Card title={`Assignments (${data.history.length})`} pad={false}>
        <Table
          headers={['Date', 'Shift', 'Category', 'Day Type', 'Source']}
          minWidth={620}
          rows={data.history.map(a => [
            <span key="d" style={{ fontWeight: 600, color: 'var(--text-strong)', whiteSpace: 'nowrap' }}>
              {formatDate(a.slot_date)}
            </span>,
            <span key="s">
              <span style={{ fontWeight: 700 }}>{a.shift_code}</span>
              <span style={{ marginLeft: 'var(--space-2)', color: 'var(--text-muted)' }}>{a.shift_name}</span>
            </span>,
            <span key="c" style={{ textTransform: 'capitalize', color: 'var(--text-muted)' }}>{a.shift_category}</span>,
            <span key="t" style={{ textTransform: 'capitalize', color: 'var(--text-muted)' }}>
              {a.day_type?.replace('_', ' ') || '—'}
            </span>,
            <Badge key="src" tone={a.source_type === 'auto_generated' ? 'ok' : 'info'}>
              {a.source_type === 'auto_generated' ? 'Auto' : a.source_type === 'manual' ? 'Manual' : a.source_type}
            </Badge>,
          ])}
          empty={<EmptyState icon="◷" title={`No assignments in ${year}`} hint="Step to another year, or generate a schedule that covers this provider." />}
        />
      </Card>
    </TabStack>
  );
}
