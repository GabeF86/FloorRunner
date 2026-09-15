// The dashboard body, shared by the whole-group view (/dashboard) and each
// per-site view (/dashboard/[siteId]).
//
// It lives here rather than in page.tsx because a Next page may only export
// `default`, `dynamic`, `revalidate` and friends — exporting a view component
// from one would fail `next build` while tsc and vitest both pass. Two pages
// needing the same body therefore means a module.
//
// All reads happen in loadDashboardData (≤6 selects via the same service
// client the API routes use); every panel fails soft: a query error renders an
// error Banner for that panel only, never fake zeros. Empty states carry
// onboarding hints — never dashes.

import Link from 'next/link';
import type { ReactNode } from 'react';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { PageHeader, Card, Badge, Table, EmptyState, Banner, Button, scheduleStatusTone } from '@/components/ui';
import type { DashboardData, Panel, ProviderMix, ScheduleRow } from './queries';
import { formatShare, type SiteCallObligation } from '@/lib/siteCallObligation';
import PhysicianPlannerCard from './PhysicianPlannerCard';
import DashboardTallyCard from './DashboardTallyCard';

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


// ── Staffing mix ───────────────────────────────────────────────────────────

function MixFigure({ value, label, sub }: { value: string; label: string; sub?: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 'var(--fs-xl)', fontWeight: 800, color: 'var(--text-strong)', letterSpacing: -0.5 }}>
        {value}
      </div>
      <div style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, color: 'var(--text-muted)', marginTop: 2 }}>
        {label}
      </div>
      {sub && (
        <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 2 }}>{sub}</div>
      )}
    </div>
  );
}

function StaffingCard({ panel, site }: { panel: Panel<ProviderMix>; site: boolean }) {
  if (panel.error) {
    return <Card title="Staffing"><Banner tone="error">{panel.error}</Banner></Card>;
  }
  const m = panel.data;
  if (!m) return <Card title="Staffing"><Banner tone="error">Staffing could not be loaded.</Banner></Card>;

  return (
    <Card
      title="Staffing"
      actions={
        <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>
          {site ? 'providers homed at this site' : 'whole group'}
        </span>
      }
    >
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
        gap: 'var(--space-4)',
      }}>
        {/* FTE for the two capacity questions, headcount for the two
            who-are-they questions — they answer different things. */}
        <MixFigure
          value={String(m.callTakerFte)}
          label="FTE call takers"
          sub={`${m.callTakerCount} physician${m.callTakerCount === 1 ? '' : 's'}`}
        />
        <MixFigure
          value={String(m.crnaFte)}
          label="FTE CRNAs"
          sub={`${m.crnaCount} ${m.crnaCount === 1 ? 'person' : 'people'}`}
        />
        <MixFigure value={String(m.perDiem)} label="Per diems" />
      </div>

      {/* Day docs are NAMED, not counted — there are only a handful per site,
          and which people they are is the useful fact. */}
      <div style={{ marginTop: 'var(--space-4)', paddingTop: 'var(--space-3)', borderTop: '1px solid var(--border-faint)' }}>
        <div style={{
          fontSize: 'var(--fs-xs)', textTransform: 'uppercase', letterSpacing: 1,
          color: 'var(--text-dim)', fontWeight: 700, marginBottom: 'var(--space-2)',
        }}>
          Day docs{m.dayDocs.length > 0 && ` (${m.dayDocs.length})`}
        </div>
        {m.dayDocs.length === 0 ? (
          <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-dim)', fontStyle: 'italic' }}>
            {site ? 'None homed at this site.' : 'None in the group.'}
          </div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {m.dayDocs.map(d => (
              <Link
                key={d.id || d.name}
                href={d.id ? `/providers/${d.id}` : '/providers'}
                style={{
                  padding: '4px 10px', borderRadius: 999, textDecoration: 'none',
                  border: '1px solid var(--border)', background: 'var(--bg-deep)',
                  fontSize: 'var(--fs-sm)', fontWeight: 600, color: 'var(--text)',
                }}
              >
                {d.name}
              </Link>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

// ── Schedules by provider group ────────────────────────────────────────────

const GROUP_LABEL: Record<string, string> = {
  physician: 'Physician schedules',
  crna: 'CRNA schedules',
  both: 'Combined schedules',
};

function ScheduleGroup({ label, rows }: { label: string; rows: ScheduleRow[] }) {
  return (
    <div style={{ marginBottom: 'var(--space-4)' }}>
      <div style={{
        fontSize: 'var(--fs-xs)', textTransform: 'uppercase', letterSpacing: 1,
        color: 'var(--text-dim)', fontWeight: 700, marginBottom: 'var(--space-2)',
      }}>
        {label}
      </div>
      {rows.length === 0 ? (
        <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-dim)', fontStyle: 'italic' }}>
          None yet.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 6 }}>
          {rows.map(r => (
            <Link
              key={r.id}
              href={`/schedules/${r.id}`}
              style={{
                display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
                padding: '8px var(--space-3)', borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--border)', background: 'var(--bg-deep)',
                textDecoration: 'none', fontSize: 'var(--fs-sm)',
              }}
            >
              <span style={{ fontWeight: 700, color: 'var(--text)', flex: 1, minWidth: 0 }}>
                {r.schedule_name}
              </span>
              <span style={{ color: 'var(--text-dim)', fontSize: 'var(--fs-xs)', whiteSpace: 'nowrap' }}>
                {r.date_start} → {r.date_end}
              </span>
              <Badge tone={scheduleStatusTone(r.status)}>{r.status}</Badge>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function SchedulesByGroupCard({ panel }: { panel: DashboardData['schedules'] }) {
  if (panel.error) {
    return <Card title="Schedules"><Banner tone="error">{panel.error}</Banner></Card>;
  }
  const rows = panel.data?.rows ?? [];
  // 'both' only gets a section when something is actually in it — an empty
  // "Combined" heading on every site would be noise.
  const groups: Array<[string, ScheduleRow[]]> = [
    ['physician', rows.filter(r => (r.provider_group ?? 'both') === 'physician')],
    ['crna', rows.filter(r => r.provider_group === 'crna')],
    ['both', rows.filter(r => (r.provider_group ?? 'both') === 'both')],
  ];
  return (
    <Card title="Schedules">
      {groups
        .filter(([key, g]) => key !== 'both' || g.length > 0)
        .map(([key, g]) => <ScheduleGroup key={key} label={GROUP_LABEL[key]} rows={g} />)}
    </Card>
  );
}

// ── Annual call obligation ─────────────────────────────────────────────────

function ObligationCard({ panel }: { panel: Panel<SiteCallObligation> }) {
  if (panel.error) {
    return <Card title="Annual call obligation"><Banner tone="error">{panel.error}</Banner></Card>;
  }
  const o = panel.data;
  if (!o) return null;

  if (o.noSlate) {
    // Six of eight sites are here. "0 calls a year" would be a claim; this is
    // the truth, and it names the fix.
    return (
      <Card title="Annual call obligation">
        <Banner tone="info">
          This site has no active call templates, so there is no call load to
          compute. Define its call shift types and templates under Sites first.
        </Banner>
      </Card>
    );
  }

  const num: React.CSSProperties = { textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

  return (
    <Card
      title="Annual call obligation"
      actions={
        <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>
          {o.year} · par {o.parLevel}
        </span>
      }
    >
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
        gap: 'var(--space-4)',
      }}>
        {o.groups.map(g => (
          <div key={g.bucket} style={{ minWidth: 0 }}>
            <div style={{
              fontSize: 'var(--fs-xs)', textTransform: 'uppercase', letterSpacing: 1,
              color: 'var(--text-dim)', fontWeight: 700,
              paddingBottom: 6, borderBottom: '1px solid var(--border)', marginBottom: 6,
            }}>
              {g.label}
            </div>

            {g.rows.map(r => (
              <div
                key={r.code}
                style={{
                  display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)',
                  padding: '5px 0',
                }}
              >
                <span style={{ fontWeight: 700, color: 'var(--text)', minWidth: 42 }}>{r.code}</span>
                {/* The number Gabriel reads this table for: what ONE 1.0 FTE
                    owes of this call type on this kind of day. */}
                <span style={{ ...num, flex: 1, fontWeight: 800, color: 'var(--blue)', fontSize: 'var(--fs-md)' }}>
                  {formatShare(r.perFte)}
                </span>
                <span style={{ ...num, fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', minWidth: 58 }}>
                  of {r.slots}
                </span>
              </div>
            ))}

            <div style={{
              display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)',
              padding: '6px 0 0', marginTop: 4, borderTop: '1px solid var(--border-faint)',
            }}>
              <span style={{ fontWeight: 700, color: 'var(--text-muted)', minWidth: 42, fontSize: 'var(--fs-sm)' }}>
                All
              </span>
              <span style={{ ...num, flex: 1, fontWeight: 800, color: 'var(--text-strong)' }}>
                {formatShare(g.perFte)}
              </span>
              <span style={{ ...num, fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', minWidth: 58 }}>
                of {g.slots}
              </span>
            </div>
          </div>
        ))}
      </div>

      <div style={{
        marginTop: 'var(--space-4)', paddingTop: 'var(--space-3)',
        borderTop: '1px solid var(--border)',
        display: 'flex', alignItems: 'baseline', gap: 'var(--space-3)', flexWrap: 'wrap',
      }}>
        <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 700, color: 'var(--text-muted)' }}>
          A 1.0 FTE owes
        </span>
        <span style={{ fontSize: 'var(--fs-xl)', fontWeight: 800, color: 'var(--blue)', letterSpacing: -0.5 }}>
          {formatShare(o.totalPerFte)}
        </span>
        <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)' }}>
          calls in {o.year}, of {o.totalSlots} the site must cover.
        </span>
      </div>

      <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 'var(--space-2)', lineHeight: 1.6 }}>
        Big blue figure is what one 1.0 FTE owes; &ldquo;of N&rdquo; is the site&rsquo;s own
        total for that call type. Divided by the par level of {o.parLevel}, so a
        0.75 FTE owes three quarters of each. Holidays are charged to the day of
        the week they land on. When the pool&rsquo;s total FTE is below par,
        obligations deliberately under-cover the year — the remainder is the
        paid-pickup layer.
      </div>
    </Card>
  );
}

export interface DashboardViewProps {
  data: DashboardData | null;
  fatal: string | null;
  /** Whole-group view when absent. */
  site?: { id: string; name: string } | null;
  /** Site pages only — the annual call load. */
  obligation?: Panel<SiteCallObligation> | null;
}

export function DashboardView({ data, fatal, site, obligation }: DashboardViewProps) {
  const header = (
    <PageHeader
      title={site ? site.name : 'UAS Dashboard'}
      subtitle={site
        ? 'Coverage, requests, and schedule health for this site.'
        : 'Coverage, requests, and schedule health across the whole group.'}
      actions={
        <>
          {site && (
            <Link href="/dashboard" style={{ textDecoration: 'none' }}>
              <Button variant="ghost">← All sites</Button>
            </Link>
          )}
          <Link href="/requests" style={{ textDecoration: 'none' }}>
            <Button variant="secondary">Requests</Button>
          </Link>
          <Link href="/board" style={{ textDecoration: 'none' }}>
            <Button variant="secondary">Open Board</Button>
          </Link>
          <Link
            href={site ? `/schedules?site_id=${site.id}` : '/schedules'}
            style={{ textDecoration: 'none' }}
          >
            <Button>{site ? 'Schedules' : 'New Schedule'}</Button>
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

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
          gap: 'var(--space-4)',
          marginBottom: 'var(--space-5)',
        }}
      >
        <StatCard
          label={site ? 'Providers homed here' : 'Active providers'}
          panel={data.providers}
          zeroHint={site
            ? 'No provider lists this as their home site yet.'
            : 'Add providers to build your roster.'}
          href="/providers"
        />
        {!site && (
          <StatCard
            label="Active sites"
            panel={data.sites}
            zeroHint="Add the sites your group covers."
            href="/sites"
          />
        )}
        <SchedulesStatCard panel={data.schedules} />
        <StatCard
          label="Pending requests"
          panel={data.pendingRequests}
          zeroHint="All caught up — no PTO or availability requests waiting."
          href="/requests"
        />
      </div>

      <div style={{ marginBottom: 'var(--space-4)' }}>
        <StaffingCard panel={data.providerMix} site={!!site} />
      </div>

      {site && obligation && (
        <div style={{ marginBottom: 'var(--space-4)' }}>
          <ObligationCard panel={obligation} />
        </div>
      )}

      {site && (
        <div style={{ marginBottom: 'var(--space-4)' }}>
          <SchedulesByGroupCard panel={data.schedules} />
        </div>
      )}

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

      {/* The annual running tally and the planner are client cards with their
          own site pickers and their own data sources, so they are shown on the
          group view only — a site page carrying a card that can display a
          DIFFERENT site would contradict its own heading. */}
      {!site && (
        <>
          <div style={{ marginTop: 'var(--space-4)' }}>
            <DashboardTallyCard />
          </div>
          <div style={{ marginTop: 'var(--space-4)' }}>
            <PhysicianPlannerCard />
          </div>
        </>
      )}
    </div>
  );
}
