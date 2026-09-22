'use client';

/* ───────────────────────────────────────────────────────────────────────────
 * The master schedule, on screen.
 *
 * ── ONE MONTH AT A TIME, INSIDE A TWELVE-MONTH WINDOW ─────────────────────
 * The window holds a year of data; the table shows a month of it. 365 columns
 * in one scroller is not a document anybody reads — the per-site grid is 77
 * columns and already needs horizontal scroll — and a month is the unit people
 * already think and talk in. The strip at the top moves across the window, and
 * every month in it is reachable in one click.
 *
 * ── SITES STACK, AWAY SITS AT THE BOTTOM ──────────────────────────────────
 * Each site is a band with a heavy rule above it, read top to bottom. Everyone
 * off is collected once at the foot of the whole sheet rather than repeated
 * inside each band: leave is a fact about a person, not about a hospital.
 * ─────────────────────────────────────────────────────────────────────────── */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Card, Banner, PageHeader, Badge } from '@/components/ui';
import {
  monthsOf, datesInMonth, awayInMonth,
  type MasterSchedule,
} from '@/lib/masterSchedule';
import type { CoverageGroup } from '@/lib/operationsBoard';
import type { MasterData } from './queries';

const mono = {
  fontFamily: 'var(--font-mono), ui-monospace, monospace',
  fontVariantNumeric: 'tabular-nums' as const,
};

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function dayOf(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1))
    .toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function spellLabel(start: string, end: string): string {
  const f = (iso: string) => {
    const [, m, d] = iso.split('-').map(Number);
    return `${m}/${d}`;
  };
  return start === end ? f(start) : `${f(start)} – ${f(end)}`;
}

const TITLE: Record<CoverageGroup, string> = {
  physician: 'Master Physician Schedule',
  crna: 'Master CRNA Schedule',
};

export function MasterScheduleView(
  { group, data, fatal }: {
    group: CoverageGroup;
    data: MasterData | null;
    fatal: string | null;
  },
) {
  const schedule: MasterSchedule | null = data?.schedule ?? null;
  const months = useMemo(
    () => (schedule ? monthsOf(schedule.from, schedule.to) : []),
    [schedule]);
  // Open on the CURRENT month — the middle of the window, not its start. A
  // sheet that opens six months in the past makes you navigate before you can
  // read anything.
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const active = months.includes(month) ? month : months[Math.floor(months.length / 2)] ?? month;
  const dates = useMemo(() => datesInMonth(active), [active]);
  const away = useMemo(
    () => (schedule ? awayInMonth(schedule.away, active) : []),
    [schedule, active]);

  const other: CoverageGroup = group === 'physician' ? 'crna' : 'physician';

  if (fatal || !schedule) {
    return (
      <>
        <PageHeader title={TITLE[group]} />
        <Banner tone="error">{fatal || 'The master schedule could not be loaded.'}</Banner>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={TITLE[group]}
        subtitle="Every site's published assignments, in one document."
      />

      {/* A partial read must never look like a quiet month. */}
      {data!.errors.length > 0 && (
        <Banner tone="error">
          This sheet is incomplete — {data!.errors.join('; ')}. Some assignments
          are missing from what you see below.
        </Banner>
      )}

      <div style={{
        display: 'flex', gap: 'var(--space-2)', alignItems: 'center',
        flexWrap: 'wrap', marginBottom: 'var(--space-3)',
      }}>
        <Link href={`/schedules/master/${other}`} style={{ textDecoration: 'none' }}>
          <span style={{
            ...mono, fontSize: 11, fontWeight: 700, padding: '4px 10px',
            borderRadius: 999, border: '1px solid var(--border)',
            color: 'var(--text-muted)',
          }}>
            {other === 'crna' ? 'CRNA sheet →' : 'Physician sheet →'}
          </span>
        </Link>
      </div>

      {/* The month strip — the whole window, one click per month. */}
      <div style={{
        display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 'var(--space-4)',
      }}>
        {months.map(m => {
          const on = m === active;
          return (
            <button
              key={m}
              type="button"
              onClick={() => setMonth(m)}
              aria-pressed={on}
              className="fr-focus"
              style={{
                ...mono, fontSize: 10, fontWeight: 700, letterSpacing: 0.3,
                padding: '4px 9px', borderRadius: 999, cursor: 'pointer',
                background: on ? 'var(--blue)' : 'transparent',
                color: on ? 'var(--on-accent)' : 'var(--text-muted)',
                border: `1px solid ${on ? 'var(--blue)' : 'var(--border)'}`,
              }}
            >{monthLabel(m)}</button>
          );
        })}
      </div>

      {schedule.empty ? (
        <Card>
          <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--text-dim)', lineHeight: 1.6 }}>
            No published {group === 'crna' ? 'CRNA' : 'physician'} schedule covers
            any site in this window. {group === 'crna' && (
              <>The CRNA schedules have not been built yet — every schedule in the
              system today is a physician schedule, so this sheet will stay empty
              until they are uploaded.</>
            )}
          </p>
        </Card>
      ) : (
        <Card pad={false} style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', minWidth: '100%' }}>
            <thead>
              <tr>
                <th style={{ ...headCell, position: 'sticky', left: 0, zIndex: 2, minWidth: 92 }} />
                {dates.map(d => {
                  const dow = dayOf(d);
                  const weekend = dow === 0 || dow === 6;
                  return (
                    <th key={d} style={{
                      ...headCell,
                      background: weekend ? 'var(--bg-deep)' : undefined,
                      color: weekend ? 'var(--text-dim)' : 'var(--text-muted)',
                    }}>
                      <div>{DOW[dow]}</div>
                      <div style={{ fontWeight: 400 }}>{Number(d.slice(8))}</div>
                    </th>
                  );
                })}
              </tr>
            </thead>

            {schedule.blocks.map(block => (
              <tbody key={block.siteId}>
                {/* The marker line between sites. */}
                <tr>
                  <th
                    colSpan={dates.length + 1}
                    style={{
                      textAlign: 'left', padding: '10px var(--space-3) 6px',
                      borderTop: '2px solid var(--border-strong, var(--text-faint))',
                      background: 'var(--bg-deep)',
                      position: 'sticky', left: 0,
                    }}
                  >
                    <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 700 }}>
                      {block.siteName}
                    </span>
                    <span style={{ ...mono, fontSize: 10, color: 'var(--text-dim)', marginLeft: 8 }}>
                      {block.shortName} · {block.people} on the schedule
                    </span>
                  </th>
                </tr>

                {block.rows.map(row => (
                  <tr key={block.siteId + row.code}>
                    <th style={{
                      ...rowHead,
                      position: 'sticky', left: 0, zIndex: 1,
                      color: row.isCall ? 'var(--danger)' : 'var(--text)',
                    }}>
                      {row.code}
                    </th>
                    {dates.map(d => {
                      const cells = row.byDate.get(d);
                      const dow = dayOf(d);
                      const weekend = dow === 0 || dow === 6;
                      return (
                        <td key={d} style={{
                          ...bodyCell,
                          background: weekend ? 'var(--bg-deep)' : undefined,
                        }}>
                          {cells?.map(c => (
                            <div key={c.providerId} style={{ whiteSpace: 'nowrap' }}>
                              {c.name}
                            </div>
                          ))}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </Card>
      )}

      {/* ── Away, at the foot of the whole sheet ──────────────────────────── */}
      <Card style={{ marginTop: 'var(--space-4)' }}>
        <div style={{
          display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)',
          marginBottom: 'var(--space-2)',
        }}>
          <h2 style={{ margin: 0, fontSize: 'var(--fs-md)', fontWeight: 700 }}>
            Away — {monthLabel(active)}
          </h2>
          <span style={{ ...mono, fontSize: 10, color: 'var(--text-dim)' }}>
            PTO · Off · Sick · Jury duty
          </span>
        </div>

        {away.length === 0 ? (
          <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--text-dim)' }}>
            Nobody is recorded away this month.
          </p>
        ) : (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))',
            gap: '4px var(--space-4)',
          }}>
            {away.map(a => (
              <div key={a.providerId + a.start + a.type} style={{
                display: 'flex', alignItems: 'center', gap: 6,
                fontSize: 'var(--fs-sm)', padding: '2px 0',
              }}>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {a.name}
                </span>
                {a.pending && <Badge tone="warn">pending</Badge>}
                <span style={{ ...mono, fontSize: 10, color: 'var(--text-dim)' }}>
                  {a.label}
                </span>
                <span style={{ ...mono, fontSize: 10, color: 'var(--text-muted)', minWidth: 62, textAlign: 'right' }}>
                  {spellLabel(a.start, a.end)}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}

const headCell: React.CSSProperties = {
  ...mono, fontSize: 9, fontWeight: 700, padding: '5px 4px',
  borderBottom: '1px solid var(--border)', color: 'var(--text-muted)',
  textAlign: 'center', minWidth: 46, background: 'var(--bg-surface)',
};

const rowHead: React.CSSProperties = {
  ...mono, fontSize: 10, fontWeight: 700, padding: '4px var(--space-3)',
  textAlign: 'left', whiteSpace: 'nowrap',
  borderBottom: '1px solid var(--border-faint)',
  background: 'var(--bg-surface)', minWidth: 92,
};

const bodyCell: React.CSSProperties = {
  fontSize: 10, padding: '3px 4px', textAlign: 'center',
  borderBottom: '1px solid var(--border-faint)',
  borderLeft: '1px solid var(--border-faint)',
  verticalAlign: 'top',
};
