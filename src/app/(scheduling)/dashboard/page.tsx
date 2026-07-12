// Live dashboard — server component. All reads happen in loadDashboardData
// (≤6 selects via the same service client the API routes use); every panel
// fails soft: a query error renders an error Banner for that panel only,
// never fake zeros. Empty states carry onboarding hints — never dashes.

import Link from 'next/link';
import type { ReactNode } from 'react';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { PageHeader, Card, Badge, Table, EmptyState, Banner, Button, scheduleStatusTone } from '@/components/ui';
import { loadDashboardData, type DashboardData, type Panel } from './queries';

// Never prerender — this page hits Supabase at request time.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Zero-count onboarding hints are links — the underline makes the affordance
// visible (a plain muted line reads as static text).
const ZERO_HINT_STYLE: React.CSSProperties = {
  marginTop: 'var(--space-2)',
  fontSize: 'var(--fs-sm)',
  color: 'var(--text-muted)',
  lineHeight: 1.4,
  textDecoration: 'underline',
  textDecorationColor: 'var(--border-strong)',
  textUnderlineOffset: 3,
};

function StatCard({
  label,
  panel,
  zeroHint,
  href,
}: {
  label: string;
  panel: Panel<number>;
  /** Shown under a genuine 0 — onboarding nudge, never a dash. */
  zeroHint: string;
  href: string;
}) {
  return (
    <Card>
      <div
        style={{
          fontSize: 'var(--fs-xs)',
          fontWeight: 500,
          fontFamily: 'var(--font-mono), ui-monospace, monospace',
          textTransform: 'uppercase',
          letterSpacing: 0.6,
          color: 'var(--text-muted)',
          marginBottom: 'var(--space-2)',
        }}
      >
        {label}
      </div>
      {panel.error ? (
        <Banner tone="error">{panel.error}</Banner>
      ) : (
        <>
          <div style={{ fontSize: 28, fontWeight: 800, lineHeight: 1.1, color: 'var(--text-strong)' }}>
            {panel.data ?? 0}
          </div>
          {(panel.data ?? 0) === 0 && (
            <Link href={href} style={{ textDecoration: 'none' }}>
              <div style={ZERO_HINT_STYLE}>{zeroHint}</div>
            </Link>
          )}
        </>
      )}
    </Card>
  );
}

function SchedulesStatCard({ panel }: { panel: DashboardData['schedules'] }) {
  const byStatus = panel.data?.byStatus ?? {};
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
  return (
    <Card>
      <div
        style={{
          fontSize: 'var(--fs-xs)',
          fontWeight: 500,
          fontFamily: 'var(--font-mono), ui-monospace, monospace',
          textTransform: 'uppercase',
          letterSpacing: 0.6,
          color: 'var(--text-muted)',
          marginBottom: 'var(--space-2)',
        }}
      >
        Schedules
      </div>
      {panel.error ? (
        <Banner tone="error">{panel.error}</Banner>
      ) : (
        <>
          <div style={{ fontSize: 28, fontWeight: 800, lineHeight: 1.1, color: 'var(--text-strong)' }}>{total}</div>
          {total === 0 ? (
            <Link href="/schedules" style={{ textDecoration: 'none' }}>
              <div style={ZERO_HINT_STYLE}>Create your first schedule to start generating call coverage.</div>
            </Link>
          ) : (
            <div style={{ marginTop: 'var(--space-2)', display: 'flex', flexWrap: 'wrap', gap: 'var(--space-1)' }}>
              {Object.entries(byStatus).map(([status, count]) => (
                <Badge key={status} tone={scheduleStatusTone(status)}>
                  {count} {status}
                </Badge>
              ))}
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function TodaysCallPanel({ panel, today }: { panel: DashboardData['todaysCall']; today: string }) {
  let body: ReactNode;
  if (panel.error) {
    body = <Banner tone="error">{panel.error}</Banner>;
  } else if ((panel.data ?? []).length === 0) {
    body = (
      <EmptyState
        icon="◎"
        title="No one is on call today"
        hint="Publish a schedule that covers today and its call assignments will appear here — the live who's-on-call glance."
        action={
          <Link href="/schedules" style={{ textDecoration: 'none' }}>
            <Button variant="secondary" size="sm">Go to schedules</Button>
          </Link>
        }
      />
    );
  } else {
    body = (
      <Table
        headers={['Provider', 'Site', 'Shift']}
        rows={(panel.data ?? []).map(e => [
          <span key="p" style={{ fontWeight: 600, color: 'var(--text-strong)' }}>{e.provider_name}</span>,
          e.site_name,
          <Badge key="c" tone="info">{e.code}</Badge>,
        ])}
      />
    );
  }
  return (
    <Card title="Today's call" actions={<span style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)' }}>{today}</span>} pad={!!panel.error}>
      {body}
    </Card>
  );
}

function AttentionPanel({ panel }: { panel: DashboardData['attention'] }) {
  let body: ReactNode;
  if (panel.error) {
    body = <Banner tone="error">{panel.error}</Banner>;
  } else if ((panel.data ?? []).length === 0) {
    body = (
      <EmptyState
        icon="▦"
        title="No schedules yet"
        hint="Create a schedule and this panel will track its unfilled slots and hard rule violations for you."
        action={
          <Link href="/schedules" style={{ textDecoration: 'none' }}>
            <Button size="sm">New Schedule</Button>
          </Link>
        }
      />
    );
  } else {
    body = (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        {(panel.data ?? []).map(s => (
          <Link key={s.schedule_id} href={`/schedules/${s.schedule_id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
            <div
              className="fr-row"
              style={{
                display: 'flex',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: 'var(--space-2)',
                padding: 'var(--space-3)',
                border: '1px solid var(--border-faint)',
                borderRadius: 'var(--radius-md)',
              }}
            >
              <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 700, color: 'var(--text-strong)', marginRight: 'auto' }}>
                {s.schedule_name}
              </span>
              <Badge tone={scheduleStatusTone(s.status)}>{s.status}</Badge>
              {s.assigned === 0 && s.unfilled === 0 ? (
                <Badge tone="neutral">no slots yet</Badge>
              ) : (
                <>
                  <Badge tone={s.unfilled > 0 ? 'warn' : 'ok'}>{s.unfilled} unfilled</Badge>
                  {s.checked === 0 ? (
                    // null flags = never validated — distinct from clean.
                    <Badge tone="neutral">not validated</Badge>
                  ) : (
                    <Badge tone={s.hard > 0 ? 'danger' : 'ok'}>{s.hard} hard</Badge>
                  )}
                </>
              )}
            </div>
          </Link>
        ))}
      </div>
    );
  }
  return <Card title="Needs attention" pad={!!panel.error || (panel.data ?? []).length > 0}>{body}</Card>;
}

export default async function DashboardPage() {
  let data: DashboardData | null = null;
  let fatal: string | null = null;
  try {
    data = await loadDashboardData(sbSchedulingServer());
  } catch (e) {
    fatal = e instanceof Error ? e.message : 'Dashboard data could not be loaded.';
  }

  const header = (
    <PageHeader
      title="Dashboard"
      subtitle="Coverage, requests, and schedule health at a glance."
      actions={
        <>
          {/* The assistant's picker entry lives on the schedules list page. */}
          <Link href="/schedules" style={{ textDecoration: 'none' }}>
            <Button variant="secondary">Assistant ✨</Button>
          </Link>
          <Link href="/requests" style={{ textDecoration: 'none' }}>
            <Button variant="secondary">Requests</Button>
          </Link>
          <Link href="/board" style={{ textDecoration: 'none' }}>
            <Button variant="secondary">Open Board</Button>
          </Link>
          <Link href="/schedules" style={{ textDecoration: 'none' }}>
            <Button>New Schedule</Button>
          </Link>
        </>
      }
    />
  );

  if (fatal || !data) {
    return (
      <div>
        {header}
        <Banner tone="error">Dashboard data could not be loaded: {fatal}</Banner>
      </div>
    );
  }

  return (
    <div>
      {header}

      {/* Stat cards */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
          gap: 'var(--space-4)',
          marginBottom: 'var(--space-5)',
        }}
      >
        <StatCard
          label="Active providers"
          panel={data.providers}
          zeroHint="Add providers to build your roster."
          href="/providers"
        />
        <StatCard
          label="Active sites"
          panel={data.sites}
          zeroHint="Add the sites your group covers."
          href="/sites"
        />
        <SchedulesStatCard panel={data.schedules} />
        <StatCard
          label="Pending requests"
          panel={data.pendingRequests}
          zeroHint="All caught up — no PTO or availability requests waiting."
          href="/requests"
        />
      </div>

      {/* Panels */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
          gap: 'var(--space-4)',
          alignItems: 'start',
        }}
      >
        <TodaysCallPanel panel={data.todaysCall} today={data.today} />
        <AttentionPanel panel={data.attention} />
      </div>
    </div>
  );
}
