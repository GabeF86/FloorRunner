/* ───────────────────────────────────────────────────────────────────────────
 * Operations board — the view.
 *
 * Three panels, in the order back office reads them at 06:30:
 *
 *   1. AVAILABLE VS NEEDED   which sites are short this week
 *   2. BENCH                 who can actually be called
 *   3. SCHEDULED TODAY       who is physically on the floor
 *
 * ── THE COLOUR IS THE WHOLE POINT ──────────────────────────────────────────
 * A cell is green only when every position is filled. Amber is exactly one
 * short, red is two or more, and both grey states mean "no number exists" —
 * closed, or nobody has built that schedule. Those two greys are deliberately
 * NOT the green: a site with no schedule is not a covered site, and the day
 * this page prints 0/0 in green over an unbuilt Tuesday it stops being worth
 * opening. (Failures rendering as zeros is a trap this codebase has hit.)
 *
 * Every value is derived in lib/operationsBoard and every read is complete or
 * reported — see queries.ts. This file only paints.
 * ─────────────────────────────────────────────────────────────────────────── */

'use client';

import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Card, Banner, PageHeader, SectionLabel, StatBlock, Badge } from '@/components/ui';
import { GROUP_LABEL, type CellStatus, type CoverageCell } from '@/lib/operationsBoard';
import { DemandEntry } from './DemandEntry';
import type { OperationsData } from './queries';

// ── Cell treatment ─────────────────────────────────────────────────────────

const CELL: Record<CellStatus, { bg: string; ink: string; rule: string }> = {
  covered:     { bg: 'var(--ok-bg)',     ink: 'var(--text)',      rule: 'transparent' },
  // Blue, not a deeper green. Surplus is not "extra covered" — it is spare
  // capacity, and on a board where staff move between sites daily it is the
  // thing you scan for when somewhere else is short.
  surplus:     { bg: 'var(--info-bg)',   ink: 'var(--info)',      rule: 'var(--info)' },
  short:       { bg: 'var(--warn-bg)',   ink: 'var(--warn)',      rule: 'var(--warn)' },
  gap:         { bg: 'var(--danger-bg)', ink: 'var(--danger)',    rule: 'var(--danger)' },
  // The two "no number" states share an ink so they read as one idea — absence
  // — and neither can be mistaken for coverage.
  // The two "no grade" states share an ink so they read as one idea —
  // absence — and neither can be mistaken for coverage.
  closed:      { bg: 'transparent',      ink: 'var(--text-faint)', rule: 'transparent' },
  unstated:    { bg: 'transparent',      ink: 'var(--text-faint)', rule: 'transparent' },
};

const LEGEND: Array<{ status: CellStatus; label: string }> = [
  { status: 'covered', label: 'covered' },
  { status: 'surplus', label: 'spare' },
  { status: 'short', label: 'one short' },
  { status: 'gap', label: 'gap' },
  { status: 'unstated', label: 'N/A — no count entered' },
  { status: 'closed', label: 'closed' },
];

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "2026-09-15" → "Tue" / "9/15". Parsed as UTC parts, never through the Date
 *  constructor's local-timezone reading, which shifts the label a day west of
 *  GMT. */
function dayParts(iso: string): { dow: string; md: string } {
  const [y, m, d] = iso.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return { dow: DOW[dow], md: `${m}/${d}` };
}

function longDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC',
  });
}

const mono = {
  fontFamily: 'var(--font-mono), ui-monospace, monospace',
  fontVariantNumeric: 'tabular-nums' as const,
};

function CoverageCellView({ cell }: { cell: CoverageCell }) {
  const t = CELL[cell.status];

  if (cell.status === 'closed') {
    return (
      <td style={{
        padding: '7px 10px', textAlign: 'center', ...mono,
        fontSize: 'var(--fs-xs)', color: t.ink, letterSpacing: 0.5,
        borderBottom: '1px solid var(--border-faint)',
      }} title="This site does not run on this day.">
        CLOSED
      </td>
    );
  }

  // Nobody has counted this day. The people already on it are still shown in
  // the tooltip — they are a real fact — but the cell cannot be graded, and
  // printing 0/0 in green over an uncounted day is exactly the failure the
  // demand table exists to prevent.
  if (cell.status === 'unstated') {
    const staffed = cell.groups
      .filter(g => g.available > 0)
      .map(g => `${g.available} ${GROUP_LABEL[g.group]}`).join(', ');
    return (
      <td style={{
        padding: '7px 10px', textAlign: 'center', ...mono,
        fontSize: 'var(--fs-xs)', color: t.ink, letterSpacing: 0.5,
        borderBottom: '1px solid var(--border-faint)', cursor: 'help',
      }} title={`No staffing need entered for this day.${staffed ? ` ${staffed} currently scheduled.` : ''}`}>
        N/A
      </td>
    );
  }

  return (
    <td
      title={cell.groups.map(g => g.needed === null
        ? `${GROUP_LABEL[g.group]} ${g.available} scheduled, need not stated`
        : `${GROUP_LABEL[g.group]} ${g.available} of ${g.needed} needed`).join(' · ')
        + (cell.shortBy > 0 ? ` — ${cell.shortBy} short`
          : cell.surplusBy > 0 ? ` — ${cell.surplusBy} spare, movable elsewhere`
          : ' — covered')
        + (cell.demandSource ? ` (${cell.demandSource} count)` : '')}
      style={{
        padding: '7px 10px', background: t.bg, ...mono,
        fontSize: 'var(--fs-xs)', lineHeight: 1.5,
        borderBottom: '1px solid var(--border-faint)',
        boxShadow: t.rule === 'transparent' ? undefined : `inset 2px 0 0 ${t.rule}`,
        cursor: 'help',
      }}
    >
      {cell.groups.map(g => {
        const short = g.needed !== null && g.available < g.needed;
        const spare = g.needed !== null && g.available > g.needed;
        return (
          <div key={g.group} style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
            <span style={{ color: 'var(--text-dim)', fontSize: 10, alignSelf: 'center' }}>
              {GROUP_LABEL[g.group]}
            </span>
            <span style={{
              color: short || spare ? t.ink : 'var(--text)',
              fontWeight: short || spare ? 700 : 500,
            }}>
              {g.available}/{g.needed === null ? '—' : g.needed}
            </span>
            {spare && (
              <span style={{ color: t.ink, fontSize: 9, alignSelf: 'center' }}>
                +{g.available - (g.needed ?? 0)}
              </span>
            )}
          </div>
        );
      })}
    </td>
  );
}

// ── The page ───────────────────────────────────────────────────────────────

export function OperationsView({ data, fatal }: { data: OperationsData | null; fatal?: string | null }) {
  if (fatal || !data) {
    return (
      <>
        <PageHeader title="Operations" />
        <Banner tone="error">{fatal || 'The operations board could not be loaded.'}</Banner>
      </>
    );
  }

  const s = data.summary;

  // ── The bench filter ────────────────────────────────────────────────────
  // "A site needs help — who can I call for it?" is the question the bench is
  // opened to answer, and until now it answered a different one: who is free
  // ANYWHERE. Filtering client-side over rows already loaded, so choosing a
  // site is instant and costs no round trip.
  const [siteFilter, setSiteFilter] = useState<string | null>(null);
  const [tab, setTab] = useState<'coverage' | 'demand'>('coverage');
  const router = useRouter();

  // The coverage tab is server-rendered, so a saved count reached it only on a
  // hard reload. router.refresh() re-runs the server component in place: the
  // matrix picks the number up as soon as it is saved, and the entry grid
  // keeps its own state while that happens.
  const handleSaved = useCallback(() => { router.refresh(); }, [router]);

  const benchRows = useMemo(
    () => (siteFilter
      ? data.bench.rows.filter(r => r.siteIds.includes(siteFilter))
      : data.bench.rows),
    [data.bench.rows, siteFilter]);

  // Free-and-credentialed per site — the number that decides whether calling
  // that site's bench is worth doing at all. Counted over EVERY bench row, not
  // the filtered view, so the chips do not change as you click between them.
  const freeBySite = useMemo(() => {
    const out = new Map<string, number>();
    for (const r of data.bench.rows) {
      if (r.status !== 'available') continue;
      for (const id of r.siteIds) out.set(id, (out.get(id) ?? 0) + 1);
    }
    return out;
  }, [data.bench.rows]);

  const filteredFree = benchRows.filter(r => r.status === 'available').length;
  const filterSite = siteFilter ? data.coverage.find(c => c.siteId === siteFilter) : null;
  const strip: Array<[string, string]> = [
    ['roster', `${s.physicians} physicians · ${s.crnas} CRNAs · ${s.sites} sites`],
    ['mix', `${s.fullTime} full-time · ${s.partTime} part-time · ${s.perDiem} per diem`],
    ['off today', `${s.offMd} MD · ${s.offCrna} CRNA${s.returning ? ` · ${s.returning} back tomorrow` : ''}`],
  ];

  return (
    <>
      <div style={{
        display: 'flex', gap: 'var(--space-6)', alignItems: 'flex-start',
        flexWrap: 'wrap', justifyContent: 'space-between',
      }}>
        <PageHeader
          title="Real-time and future staffing, all on one screen."
          subtitle="Who is short, who is on the bench, and who is actually on the floor."
        />
        <div style={{ ...mono, fontSize: 'var(--fs-xs)', textAlign: 'right', lineHeight: 1.9 }}>
          {strip.map(([k, v]) => (
            <div key={k}>
              <span style={{ color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: 0.6 }}>
                {k}
              </span>{' '}
              <span style={{ color: 'var(--text)' }}>{v}</span>
            </div>
          ))}
          <div style={{ marginTop: 4 }}>
            <span style={{ color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: 0.6 }}>
              today
            </span>{' '}
            <span style={{ fontSize: 'var(--fs-lg)', fontWeight: 600, color: 'var(--text-strong)' }}>
              {s.scheduledToday} scheduled
            </span>
            <span style={{ color: 'var(--text-dim)' }}> · </span>
            <span style={{
              fontSize: 'var(--fs-lg)', fontWeight: 600,
              color: s.openToday > 0 ? 'var(--danger)' : 'var(--text-strong)',
            }}>{s.openToday} open</span>
            <span style={{ color: 'var(--text-dim)' }}> · </span>
            <span style={{ fontSize: 'var(--fs-lg)', fontWeight: 600, color: 'var(--text-strong)' }}>
              {s.freeToday} free
            </span>
          </div>
        </div>
      </div>

      {data.errors.length > 0 && (
        <Banner tone="error">
          Some data could not be read, so the numbers below are incomplete:{' '}
          {data.errors.join('; ')}
        </Banner>
      )}

      {/* Coverage reads the demand; the entry tab writes it. Same grid, same
          sites, same week — so the numbers are typed in exactly where they
          will be read. */}
      <div style={{
        display: 'flex', gap: 'var(--space-2)', marginBottom: 'var(--space-3)',
        borderBottom: '1px solid var(--border)', paddingBottom: 'var(--space-2)',
      }}>
        <BoardTab active={tab === 'coverage'} onClick={() => setTab('coverage')}>
          Coverage
        </BoardTab>
        <BoardTab active={tab === 'demand'} onClick={() => setTab('demand')}>
          Manual entry for needed staff
        </BoardTab>
      </div>

      {/* HIDDEN, not unmounted. Unmounting threw away everything typed and
          refetched on the way back, which read as the entries having been
          erased. The grid keeps its state; only its visibility changes. */}
      <div style={{ display: tab === 'demand' ? undefined : 'none' }}>
        <DemandEntry
          sites={data.coverage}
          dates={data.dates}
          onSaved={handleSaved}
        />
      </div>

      <div style={{
        display: tab === 'coverage' ? 'grid' : 'none',
        gap: 'var(--space-4)', alignItems: 'start',
        gridTemplateColumns: 'minmax(0, 2.1fr) minmax(300px, 1fr)',
      }} className="ops-split">
        {/* ── 1. Available vs needed ─────────────────────────────────────── */}
        <Card pad={false}>
          <div style={{ padding: 'var(--space-4) var(--space-4) 0' }}>
            <SectionLabel
              tags={
                <span style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  {LEGEND.map(l => (
                    <span key={l.status} style={{
                      ...mono, fontSize: 10, color: 'var(--text-dim)',
                      display: 'inline-flex', alignItems: 'center', gap: 4,
                    }}>
                      <span style={{
                        width: 9, height: 9, borderRadius: 2,
                        background: CELL[l.status].bg,
                        border: `1px solid ${CELL[l.status].rule === 'transparent'
                          ? 'var(--border)' : CELL[l.status].rule}`,
                      }} />
                      {l.label}
                    </span>
                  ))}
                </span>
              }
            >
              Available vs. needed — week of {dayParts(data.dates[0]).md}
            </SectionLabel>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
              <thead>
                <tr>
                  <th style={{
                    padding: '6px var(--space-4)', textAlign: 'left', ...mono,
                    fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', fontWeight: 600,
                    borderBottom: '1px solid var(--border)',
                  }}>Site</th>
                  {data.dates.map(d => {
                    const { dow, md } = dayParts(d);
                    return (
                      <th key={d} style={{
                        padding: '6px 10px', textAlign: 'center', ...mono,
                        fontSize: 'var(--fs-xs)', fontWeight: 600,
                        color: d === data.date ? 'var(--text-strong)' : 'var(--text-muted)',
                        borderBottom: `1px solid ${d === data.date ? 'var(--blue)' : 'var(--border)'}`,
                      }}>
                        {dow}<br />
                        <span style={{ fontWeight: 400, color: 'var(--text-dim)' }}>{md}</span>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {data.coverage.map(row => (
                  <tr key={row.siteId} className="fr-row">
                    {/* Clicking a site filters the bench to it. This is the
                        whole workflow the page exists for: see that Riddle is
                        short, click Riddle, get the per diems who can actually
                        be placed at Riddle. */}
                    <td
                      onClick={() => setSiteFilter(siteFilter === row.siteId ? null : row.siteId)}
                      title={`Show the per diems credentialed at ${row.siteName}`}
                      style={{
                        padding: '7px var(--space-4)', cursor: 'pointer',
                        borderBottom: '1px solid var(--border-faint)', whiteSpace: 'nowrap',
                        background: siteFilter === row.siteId
                          ? 'color-mix(in srgb, var(--blue) 10%, transparent)' : undefined,
                        boxShadow: siteFilter === row.siteId
                          ? 'inset 2px 0 0 var(--blue)' : undefined,
                      }}
                    >
                      <span style={{
                        ...mono, fontWeight: 600, fontSize: 'var(--fs-sm)',
                        color: siteFilter === row.siteId ? 'var(--blue)' : undefined,
                      }}>
                        {row.shortName}
                      </span>
                      <span style={{
                        display: 'block', fontSize: 'var(--fs-xs)', color: 'var(--text-dim)',
                      }}>{row.siteName}</span>
                    </td>
                    {row.cells.map(cell => <CoverageCellView key={cell.date} cell={cell} />)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <TransfersPanel data={data} />

          <p style={{
            margin: 0, padding: 'var(--space-3) var(--space-4)',
            fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', lineHeight: 1.6,
            borderTop: '1px solid var(--border-faint)',
          }}>
            <strong style={{ color: 'var(--text-muted)' }}>Needed</strong> is the staffing a day
            actually requires, counted from the OR schedule — not a count of the positions the
            schedule already contains, which could only ever say the schedule matches itself.
            {' '}<strong style={{ color: 'var(--text-muted)' }}>Available</strong> is the people
            on the published schedule that day. A day nobody has counted reads N/A, never 0.
            {' '}<strong style={{ color: 'var(--text-muted)' }}>Click a site</strong> to show the
            per diems credentialed there.
          </p>
        </Card>

        {/* ── 2. The bench ───────────────────────────────────────────────── */}
        <Card pad={false}>
          <div style={{ padding: 'var(--space-4) var(--space-4) 0' }}>
            <SectionLabel>
              Bench — {longDate(data.date)}
              {filterSite && <> · {filterSite.shortName}</>}
            </SectionLabel>

            {/* Filter by credential. The question this panel is opened to
                answer is "site X is short, who can I call FOR IT" — and a
                per diem who is free but not credentialed there is no use.
                Counts are the free-and-credentialed number per site, so a
                chip reading 0 says "do not bother" before you click it. */}
            <div style={{
              display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 'var(--space-3)',
            }}>
              <FilterChip
                label="All sites"
                count={data.bench.freeToday}
                active={siteFilter === null}
                onClick={() => setSiteFilter(null)}
              />
              {data.coverage.map(site => {
                const free = freeBySite.get(site.siteId) ?? 0;
                return (
                  <FilterChip
                    key={site.siteId}
                    label={site.shortName}
                    count={free}
                    active={siteFilter === site.siteId}
                    dim={free === 0}
                    title={`${site.siteName} — ${free} per diem free and credentialed today`}
                    onClick={() => setSiteFilter(siteFilter === site.siteId ? null : site.siteId)}
                  />
                );
              })}
            </div>
          </div>

          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 'var(--space-2)', padding: '0 var(--space-4) var(--space-3)',
          }}>
            <StatBlock value={data.bench.onRoster} caption="per diem on the roster" />
            <StatBlock
              value={filterSite ? benchRows.length : data.bench.sitesCovered}
              caption={filterSite ? `credentialed at ${filterSite.shortName}` : 'sites they cover'}
            />
            <StatBlock
              value={filteredFree}
              caption={filterSite ? `free at ${filterSite.shortName}` : 'free and credentialed'}
              tone={filteredFree === 0 ? 'danger' : 'ok'}
            />
          </div>

          <div style={{ maxHeight: 340, overflowY: 'auto', borderTop: '1px solid var(--border-faint)' }}>
            {benchRows.length === 0 ? (
              <p style={{
                margin: 0, padding: 'var(--space-4)',
                fontSize: 'var(--fs-sm)', color: 'var(--text-dim)', lineHeight: 1.6,
              }}>
                {filterSite
                  ? `No per diem is credentialed at ${filterSite.siteName}. Nobody on the bench can be placed there until somebody is.`
                  : 'No per diem on the roster holds a live site credential today.'}
              </p>
            ) : benchRows.map(r => (
              <div key={r.providerId} style={{
                display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
                padding: '8px var(--space-4)',
                borderBottom: '1px solid var(--border-faint)',
              }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 'var(--fs-sm)', fontWeight: 600 }}>
                    {r.name}
                    {r.code && (
                      <span style={{ ...mono, fontSize: 10, color: 'var(--text-dim)', marginLeft: 6 }}>
                        {r.code}
                      </span>
                    )}
                  </div>
                  <div style={{ ...mono, fontSize: 10, color: 'var(--text-dim)' }}>
                    {r.detail}
                  </div>
                </div>
                <Badge tone={
                  r.status === 'available' ? 'ok' : r.status === 'booked' ? 'neutral' : 'warn'
                }>
                  {r.status}
                </Badge>
              </div>
            ))}
          </div>

          {data.bench.uncredentialed > 0 && (
            <p style={{
              margin: 0, padding: 'var(--space-3) var(--space-4)',
              borderTop: '1px solid var(--border-faint)',
              fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', lineHeight: 1.6,
            }}>
              A further <strong style={{ color: 'var(--warn)' }}>
                {data.bench.uncredentialed}
              </strong>{' '}
              per diem hold no active site credential and are not listed — they cannot be
              placed anywhere today. That is a credentialing backlog, not a staffing one.
            </p>
          )}
        </Card>
      </div>

      {/* ── 3. On the floor ──────────────────────────────────────────────── */}
      <div style={{ marginTop: 'var(--space-5)', display: tab === 'coverage' ? undefined : 'none' }}>
        <h2 style={{
          margin: '0 0 var(--space-1)', fontSize: 'var(--fs-lg)', fontWeight: 600,
        }}>
          Scheduled today — {longDate(data.date)}
        </h2>
        <p style={{ margin: '0 0 var(--space-3)', fontSize: 'var(--fs-sm)', color: 'var(--text-dim)' }}>
          Everyone on the board at every site, and who is carrying call tonight.
        </p>

        <div style={{
          display: 'grid', gap: 'var(--space-3)',
          gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))',
          alignItems: 'start',
        }}>
          {data.boards.map(b => (
            <Card key={b.siteId} pad={false} style={{ overflow: 'hidden' }}>
              <div style={{
                display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)',
                padding: 'var(--space-3)', borderBottom: '1px solid var(--border-faint)',
              }}>
                <span style={{ ...mono, fontWeight: 700, fontSize: 'var(--fs-sm)' }}>{b.shortName}</span>
                <span style={{
                  marginLeft: 'auto', ...mono, fontSize: 10, color: 'var(--text-dim)',
                }}>
                  {b.mdCount} MD{b.crnaCount > 0 ? ` · ${b.crnaCount} CRNA` : ''}
                </span>
              </div>

              {b.closed || b.unscheduled ? (
                <p style={{
                  margin: 0, padding: 'var(--space-4) var(--space-3)',
                  fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', lineHeight: 1.6,
                }}>
                  {b.closed
                    ? `${b.siteName} does not run today.`
                    : `No published schedule covers ${b.siteName} today.`}
                </p>
              ) : (
                <div style={{ padding: 'var(--space-3)' }}>
                  {b.onCall.length > 0 && (
                    <>
                      <SectionLabel source="none" rule={false}>On call tonight</SectionLabel>
                      {b.onCall.map(p => (
                        <div key={p.providerId + p.code} style={{
                          display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3,
                        }}>
                          <span style={{
                            ...mono, fontSize: 10, fontWeight: 600, padding: '1px 5px',
                            borderRadius: 'var(--radius-sm)',
                            background: 'var(--danger-bg)', color: 'var(--danger)',
                          }}>{p.code}</span>
                          <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 600 }}>{p.name}</span>
                          <span style={{ marginLeft: 'auto', ...mono, fontSize: 10, color: 'var(--text-dim)' }}>
                            {p.hours}
                          </span>
                        </div>
                      ))}
                    </>
                  )}

                  {b.inRooms.length > 0 && (
                    <div style={{ marginTop: b.onCall.length > 0 ? 'var(--space-3)' : 0 }}>
                      {/* NOT "in rooms": the schedule records who is working
                          and in what capacity, never which anaesthetising site
                          they stand in. Room assignment happens on the day. */}
                      <SectionLabel source="none" rule={false}>Working</SectionLabel>
                      {b.inRooms.map(p => (
                        <div key={p.providerId + p.code} style={{
                          display: 'flex', gap: 6, fontSize: 'var(--fs-xs)', marginBottom: 2,
                        }}>
                          <span style={{ flex: 1, minWidth: 0 }}>{p.name}</span>
                          <span style={{ ...mono, color: 'var(--text-dim)' }}>{p.code}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {b.openPositions > 0 && (
                    <div style={{
                      marginTop: 'var(--space-3)', paddingTop: 'var(--space-2)',
                      borderTop: '1px solid var(--border-faint)',
                      ...mono, fontSize: 10, color: 'var(--danger)', fontWeight: 600,
                    }}>
                      {b.openPositions} OPEN {b.openPositions === 1 ? 'POSITION' : 'POSITIONS'}
                    </div>
                  )}

                  {b.onCall.length === 0 && b.inRooms.length === 0 && (
                    <p style={{ margin: 0, fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>
                      Nobody assigned yet.
                    </p>
                  )}
                </div>
              )}
            </Card>
          ))}
        </div>
      </div>

      <p style={{
        marginTop: 'var(--space-5)', fontSize: 'var(--fs-xs)', color: 'var(--text-dim)',
      }}>
        Coverage, bench and floor all read the same published schedule — see{' '}
        <Link href="/rules" style={{ color: 'var(--blue)' }}>Scheduling Logic</Link> for the
        rules the generator builds to.
      </p>

      {/* One breakpoint: below it the matrix and the bench stack rather than
          squeezing the seven day columns into a third of the width. */}
      <style>{`
        @media (max-width: 1100px) {
          .ops-split { grid-template-columns: minmax(0, 1fr) !important; }
        }
      `}</style>
    </>
  );
}

/**
 * A filter chip with its count.
 *
 * The count is the point: a chip reading 0 tells the scheduler not to bother
 * clicking it, which is the fastest possible answer to "can the bench help
 * Riddle today". `dim` greys those out without hiding them — a site with
 * nobody credentialed is information, and removing the chip would leave the
 * reader wondering whether they had missed it.
 */
function FilterChip(
  { label, count, active, dim, title, onClick }: {
    label: string; count: number; active: boolean;
    dim?: boolean; title?: string; onClick: () => void;
  },
) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className="fr-focus"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        padding: '3px 8px', borderRadius: 999, cursor: 'pointer',
        fontFamily: 'var(--font-mono), ui-monospace, monospace',
        fontSize: 10, fontWeight: 600, letterSpacing: 0.4,
        background: active ? 'var(--blue)' : 'transparent',
        color: active ? 'var(--on-accent)' : dim ? 'var(--text-faint)' : 'var(--text-muted)',
        border: `1px solid ${active ? 'var(--blue)' : 'var(--border)'}`,
        transition: 'background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)',
      }}
    >
      {label}
      <span style={{
        opacity: active ? 0.85 : 0.65,
        fontVariantNumeric: 'tabular-nums',
      }}>{count}</span>
    </button>
  );
}

/** A board tab. Underlined when active, quiet when not — the same contract the
 *  provider profile's tabs use, so the two do not read as different controls. */
function BoardTab(
  { active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode },
) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={active ? 'fr-focus' : 'fr-focus fr-btn fr-btn-ghost'}
      style={{
        padding: '6px 10px', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
        fontSize: 'var(--fs-sm)', fontWeight: 600,
        background: active ? 'color-mix(in srgb, var(--blue) 12%, transparent)' : 'transparent',
        color: active ? 'var(--blue)' : 'var(--text-muted)',
        border: '1px solid ' + (active
          ? 'color-mix(in srgb, var(--blue) 30%, transparent)' : 'transparent'),
      }}
    >
      {children}
    </button>
  );
}

/**
 * Who could move today.
 *
 * Staff are shared daily here — sites need different numbers on different days,
 * PTO lands unevenly — so a block routinely leaves one hospital a body spare
 * while another is a body down. The move itself is made by hand on the
 * schedule; this answers the question that comes first, which is who is
 * actually movable.
 *
 * It stays quiet when there is nothing to say. A panel that renders "no
 * transfers needed" every day is a panel people stop reading, and the days it
 * matters are exactly the days it would be skimmed past.
 */
function TransfersPanel({ data }: { data: OperationsData }) {
  const t = data.transfers;
  if (t.short.length === 0) return null;

  const byTarget = new Map<string, typeof t.candidates>();
  for (const c of t.candidates) {
    const list = byTarget.get(c.toSite) ?? [];
    list.push(c);
    byTarget.set(c.toSite, list);
  }

  return (
    <div style={{
      padding: 'var(--space-3) var(--space-4)',
      borderTop: '1px solid var(--border-faint)',
      background: 'var(--tint-surface-faint)',
    }}>
      <SectionLabel source="none" rule={false}>
        Cover {longDate(data.date)} by moving somebody
      </SectionLabel>

      <div style={{
        display: 'flex', gap: 'var(--space-4)', flexWrap: 'wrap',
        marginBottom: t.candidates.length > 0 ? 'var(--space-2)' : 0,
      }}>
        <span style={{ ...mono, fontSize: 'var(--fs-xs)' }}>
          <span style={{ color: 'var(--text-dim)' }}>SHORT </span>
          {t.short.map(s => `${s.shortName} ${s.by}`).join(' · ')}
        </span>
        {t.surplus.length > 0 && (
          <span style={{ ...mono, fontSize: 'var(--fs-xs)' }}>
            <span style={{ color: 'var(--text-dim)' }}>SPARE </span>
            <span style={{ color: 'var(--info)' }}>
              {t.surplus.map(s => `${s.shortName} +${s.by}`).join(' · ')}
            </span>
          </span>
        )}
      </div>

      {[...byTarget.entries()].map(([target, list]) => (
        <div key={target} style={{ marginBottom: 6, fontSize: 'var(--fs-xs)', lineHeight: 1.7 }}>
          <span style={{ ...mono, color: 'var(--warn)', fontWeight: 700 }}>→ {target}</span>
          {' '}
          {list.map(c => (
            <span key={c.providerId + c.fromSiteId} style={{ marginRight: 10 }}>
              <strong>{c.name}</strong>
              <span style={{ ...mono, color: 'var(--text-dim)', fontSize: 10 }}>
                {' '}{c.shiftCode} @ {c.fromSite}
              </span>
            </span>
          ))}
        </div>
      ))}

      {t.unmatched.map(u => (
        <div key={u.siteId} style={{
          fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', lineHeight: 1.7,
        }}>
          <span style={{ ...mono, color: 'var(--warn)', fontWeight: 700 }}>→ {u.shortName}</span>
          {' '}nobody to move — {u.reason}.
        </div>
      ))}

      <p style={{
        margin: 'var(--space-2) 0 0', fontSize: 10,
        color: 'var(--text-dim)', lineHeight: 1.6,
      }}>
        Only day work is offered, and only to sites the person is credentialed at — moving
        call is a different decision, and the engine will not place anyone where they are not
        credentialed. Make the move itself on the schedule.
      </p>
    </div>
  );
}
