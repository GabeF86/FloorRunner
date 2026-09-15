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
import type { DashboardData, Panel, ProviderMix, ScheduleRow, StaffChip } from './queries';
import { formatShare, obligationColumns, type SiteCallObligation } from '@/lib/siteCallObligation';
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

export function StaffChips({ people }: { people: StaffChip[] }) {
  if (people.length === 0) {
    return (
      <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-dim)', fontStyle: 'italic' }}>
        None.
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      {people.map(p => (
        <Link
          key={p.id || p.name}
          href={p.id ? `/providers/${p.id}` : '/providers'}
          className="fr-chip"
          title={[p.name, p.partner ? 'partner' : null, p.crna ? 'CRNA' : null]
            .filter(Boolean).join(' — ')}
          style={{
            // Tightened 2026-09-15: the group view renders 288 of these and a
            // single site up to 76, so padding and leading are the difference
            // between a list and a wall.
            display: 'inline-flex', alignItems: 'baseline', gap: 4,
            padding: '2px 7px', textDecoration: 'none',
            // SHAPE carries the physician/CRNA distinction, not colour: the
            // per-diem list mixes both, and shape survives printing and
            // colour-vision deficiency. A pill is a person on the call slate;
            // a tag is a CRNA.
            borderRadius: p.crna ? 'var(--radius-sm)' : 999,
            border: `1px solid ${p.partner ? 'var(--partner-ring)' : 'var(--border)'}`,
            background: 'var(--bg-deep)',
            fontSize: 'var(--fs-xs)', color: 'var(--text)', lineHeight: 1.35,
            whiteSpace: 'nowrap',
          }}
        >
          {/* "Farkas G." rather than "Gabriel Farkas" — roughly half the
              width, and the full name stays in the tooltip above. */}
          <span style={{ fontWeight: 700 }}>{p.short || p.name}</span>
          {/* Per diems carry no FTE — theirs is 0 and means nothing. */}
          {p.fte != null && (
            <span style={{ color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
              {formatFte(p.fte)}
            </span>
          )}
          {p.weeklyHours != null && (
            <span style={{ color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
              {p.weeklyHours} hr/wk
            </span>
          )}
          {p.call && (
            <span style={{
              fontWeight: 800, letterSpacing: 0.4, textTransform: 'uppercase',
              fontSize: 9, color: 'var(--blue)',
            }}>
              call
            </span>
          )}
        </Link>
      ))}
    </div>
  );
}

/**
 * 1 → "1.0", 0.75 → "0.75" — enough places to be exact, no more.
 *
 * Decided by rounding to two places and dropping a trailing zero, NOT by
 * testing `Number.isInteger(n * 100)`: 0.55 * 100 is 55.00000000000001 in
 * binary floating point, so that test failed for real contract values and
 * rendered 0.55 FTE as "0.6".
 */
export function formatFte(n: number): string {
  const two = n.toFixed(2);
  return two.endsWith('0') ? two.slice(0, -1) : two;
}

/**
 * A staffing figure with the people behind it.
 *
 * Built on <details> rather than React state because DashboardView is a SERVER
 * component — and it is the better answer anyway: the disclosure works with no
 * JavaScript, and keyboard and screen-reader behaviour come for free rather
 * than being reimplemented with aria-expanded.
 */
function StaffSection({
  value, label, sub, people,
}: {
  value: string;
  label: string;
  sub?: string;
  people: StaffChip[];
}) {
  // Every section starts CLOSED (Gabriel 2026-09-15). An adaptive default —
  // open when the list was short — meant the same section opened at one site
  // and closed at another, so the card's height changed depending on where you
  // were. One rule is easier to live with than a clever one, and the figures
  // that matter stay in the header either way.
  return (
    <details style={{ minWidth: 0, marginBottom: 'var(--space-3)' }}>
      <summary
        className="fr-focus"
        style={{
          display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)', flexWrap: 'wrap',
          paddingBottom: 5, marginBottom: 'var(--space-2)',
          borderBottom: '1px solid var(--border-faint)',
          cursor: 'pointer',
          // The native triangle sits on the text baseline and misaligns with a
          // 17px figure, so it is replaced by the caret below.
          listStyle: 'none',
        }}
      >
        {/* Always shown, including for an empty section: expanding to find
            "None." confirms the list is genuinely empty rather than broken. */}
        <span aria-hidden="true" className="fr-caret" style={{
          fontSize: 9, color: 'var(--text-dim)', width: 9, flexShrink: 0,
        }}>
          ▸
        </span>
        <span style={{ fontSize: 'var(--fs-lg)', fontWeight: 800, color: 'var(--text-strong)', letterSpacing: -0.3 }}>
          {value}
        </span>
        <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, color: 'var(--text-muted)' }}>
          {label}
        </span>
        {sub && (
          <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginLeft: 'auto' }}>
            {sub}
          </span>
        )}
      </summary>
      <StaffChips people={people} />
    </details>
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
          {site ? 'homed at this site' : 'whole group'}
        </span>
      }
    >
      {/* Each headline figure sits with the people it is made of, so the number
          is always checkable against the names beside it. */}
      <StaffSection
        value={String(m.callTakerFte)}
        // The parenthetical is the partner headcount, and the orange rings on
        // the chips below are the same people — so the figure is checkable by
        // counting, which is the whole arrangement of this card.
        label={`FTE call takers (${m.partnerCount} partner${m.partnerCount === 1 ? '' : 's'})`}
        sub={`${m.callTakerCount} physician${m.callTakerCount === 1 ? '' : 's'} take call`}
        people={m.physicians}
      />
      <StaffSection
        value={String(m.crnaFte)}
        label="FTE CRNAs"
        sub={`${m.crnaCount} ${m.crnaCount === 1 ? 'person' : 'people'}`}
        people={m.crnas}
      />
      <StaffSection
        value={String(m.perDiem)}
        label="Per diems"
        sub="paid per shift — no FTE"
        people={m.perDiems}
      />

      {/* Day docs are NAMED, not counted — there are only a handful per site,
          and which people they are is the useful fact. */}
      <StaffSection
        value={String(m.dayDocs.length)}
        label="Day docs"
        people={m.dayDocs.map(d => ({ ...d, fte: null, call: false, weeklyHours: d.weeklyHours }))}
      />
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

export function ObligationCard({ panel }: { panel: Panel<SiteCallObligation> }) {
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
  const cols = obligationColumns(o);
  // Every code that appears anywhere, so a code that runs only at the weekend
  // still gets a row and reads as absent on weekdays rather than missing.
  const codes = [...new Set(cols.flatMap(c => c.rows.map(r => r.code)))]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  return (
    <Card
      title="Annual call obligation"
      actions={
        <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>
          {o.year} · par {o.parLevel}
        </span>
      }
    >
      {/* A TABLE, not a column per day type.
          The previous layout repeated the call code inside every column and
          printed "of N" beside every figure, so six day types meant six copies
          of "C1" and twelve slot counts — the same numbers Gabriel reads
          across, laid out so they cannot be read across. Codes are rows now
          and day types are columns, which is how the slate is actually spoken
          about ("C1 on a Saturday"). The site's own slot count moves into each
          cell's tooltip and stays in the sentence below; the per-FTE figure is
          what the table is for. */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{
          width: '100%', borderCollapse: 'collapse',
          fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
        }}>
          <thead>
            <tr>
              <th style={{
                textAlign: 'left', padding: '0 var(--space-3) 6px 0',
                fontSize: 'var(--fs-xs)', textTransform: 'uppercase', letterSpacing: 1,
                color: 'var(--text-dim)', fontWeight: 700,
                borderBottom: '1px solid var(--border)',
              }} />
              {cols.map(g => (
                <th
                  key={g.key}
                  style={{
                    textAlign: 'right', padding: '0 0 6px var(--space-4)',
                    fontSize: 'var(--fs-xs)', textTransform: 'uppercase', letterSpacing: 0.6,
                    fontWeight: 700,
                    // A total is a different KIND of column, not a louder one.
                    color: g.isSum ? 'var(--danger)' : 'var(--text-dim)',
                    borderBottom: `1px solid ${g.isSum ? 'var(--danger)' : 'var(--border)'}`,
                  }}
                >
                  {g.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {codes.map(code => (
              <tr key={code}>
                <td style={{
                  padding: '4px var(--space-3) 4px 0', fontWeight: 700,
                  color: 'var(--text)', fontSize: 'var(--fs-sm)',
                }}>
                  {code}
                </td>
                {cols.map(g => {
                  const r = g.rows.find(x => x.code === code);
                  return (
                    <td
                      key={g.key}
                      title={r ? `${r.slots} ${code} slots the site must cover on ${g.label}` : undefined}
                      style={{
                        ...num, padding: '4px 0 4px var(--space-4)',
                        fontWeight: 800, fontSize: 'var(--fs-md)',
                        color: r ? (g.isSum ? 'var(--danger)' : 'var(--blue)') : 'var(--text-faint)',
                      }}
                    >
                      {/* An em dash, not a zero: this code does not run on this
                          day at all, which is a different fact from owing none
                          of it. */}
                      {r ? formatShare(r.perFte) : '—'}
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr>
              <td style={{
                padding: '6px var(--space-3) 0 0', fontWeight: 700,
                color: 'var(--text-muted)', fontSize: 'var(--fs-sm)',
                borderTop: '1px solid var(--border-faint)',
              }}>
                All
              </td>
              {cols.map(g => (
                <td
                  key={g.key}
                  title={`${g.slots} slots in total on ${g.label}`}
                  style={{
                    ...num, padding: '6px 0 0 var(--space-4)', fontWeight: 800,
                    color: g.isSum ? 'var(--danger)' : 'var(--text-strong)',
                    borderTop: '1px solid var(--border-faint)',
                  }}
                >
                  {formatShare(g.perFte)}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
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
