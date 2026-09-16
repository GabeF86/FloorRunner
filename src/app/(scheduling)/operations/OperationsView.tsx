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

import Link from 'next/link';
import { Card, Banner, PageHeader, SectionLabel, StatBlock, Badge } from '@/components/ui';
import { GROUP_LABEL, type CellStatus, type CoverageCell } from '@/lib/operationsBoard';
import type { OperationsData } from './queries';

// ── Cell treatment ─────────────────────────────────────────────────────────

const CELL: Record<CellStatus, { bg: string; ink: string; rule: string }> = {
  covered:     { bg: 'var(--ok-bg)',     ink: 'var(--text)',      rule: 'transparent' },
  short:       { bg: 'var(--warn-bg)',   ink: 'var(--warn)',      rule: 'var(--warn)' },
  gap:         { bg: 'var(--danger-bg)', ink: 'var(--danger)',    rule: 'var(--danger)' },
  // The two "no number" states share an ink so they read as one idea — absence
  // — and neither can be mistaken for coverage.
  closed:      { bg: 'transparent',      ink: 'var(--text-faint)', rule: 'transparent' },
  unscheduled: { bg: 'transparent',      ink: 'var(--text-faint)', rule: 'transparent' },
};

const LEGEND: Array<{ status: CellStatus; label: string }> = [
  { status: 'covered', label: 'covered' },
  { status: 'short', label: 'one short' },
  { status: 'gap', label: 'gap' },
  { status: 'closed', label: 'closed / no schedule' },
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
  if (cell.status === 'closed' || cell.status === 'unscheduled') {
    return (
      <td style={{
        padding: '7px 10px', textAlign: 'center', ...mono,
        fontSize: 'var(--fs-xs)', color: t.ink, letterSpacing: 0.5,
        borderBottom: '1px solid var(--border-faint)',
      }}
        title={cell.status === 'closed'
          ? 'This site does not run on this day.'
          : 'No published schedule covers this day yet — this is a blank, not a zero.'}
      >
        {cell.status === 'closed' ? 'CLOSED' : '—'}
      </td>
    );
  }
  return (
    <td
      title={cell.groups.map(g => `${GROUP_LABEL[g.group]} ${g.filled} of ${g.required}`).join(' · ')
        + (cell.shortBy > 0 ? ` — ${cell.shortBy} short` : ' — covered')}
      style={{
        padding: '7px 10px', background: t.bg, ...mono,
        fontSize: 'var(--fs-xs)', lineHeight: 1.5,
        borderBottom: '1px solid var(--border-faint)',
        boxShadow: t.rule === 'transparent' ? undefined : `inset 2px 0 0 ${t.rule}`,
        cursor: 'help',
      }}
    >
      {cell.groups.map(g => (
        <div key={g.group} style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
          {/* An either-group row is unfilled BY DEFINITION — it only exists
              while nobody is standing it — so "0/2" spends a ratio saying
              nothing. It reads as the count of open rooms it is. */}
          {g.group === 'either' ? (
            <span style={{ color: t.ink, fontWeight: 700 }}>
              {g.required - g.filled} open
            </span>
          ) : (
            <>
              <span style={{ color: 'var(--text-dim)', fontSize: 10, alignSelf: 'center' }}>
                {GROUP_LABEL[g.group]}
              </span>
              <span style={{
                color: g.filled < g.required ? t.ink : 'var(--text)',
                fontWeight: g.filled < g.required ? 700 : 500,
              }}>
                {g.filled}/{g.required}
              </span>
            </>
          )}
        </div>
      ))}
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

      <div style={{
        display: 'grid', gap: 'var(--space-4)', alignItems: 'start',
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
                    <td style={{
                      padding: '7px var(--space-4)',
                      borderBottom: '1px solid var(--border-faint)', whiteSpace: 'nowrap',
                    }}>
                      <span style={{ ...mono, fontWeight: 600, fontSize: 'var(--fs-sm)' }}>
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

          <p style={{
            margin: 0, padding: 'var(--space-3) var(--space-4)',
            fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', lineHeight: 1.6,
            borderTop: '1px solid var(--border-faint)',
          }}>
            <strong style={{ color: 'var(--text-muted)' }}>Needed</strong> is the positions the
            published schedule says exist — never a template&rsquo;s guess at what a day usually
            takes. A day nobody has scheduled reads as a dash, not as zero needed.
          </p>
        </Card>

        {/* ── 2. The bench ───────────────────────────────────────────────── */}
        <Card pad={false}>
          <div style={{ padding: 'var(--space-4) var(--space-4) 0' }}>
            <SectionLabel>Bench — {longDate(data.date)}</SectionLabel>
          </div>

          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 'var(--space-2)', padding: '0 var(--space-4) var(--space-3)',
          }}>
            <StatBlock value={data.bench.onRoster} caption="per diem on the roster" />
            <StatBlock value={data.bench.sitesCovered} caption="sites they cover" />
            <StatBlock
              value={data.bench.freeToday}
              caption="free and credentialed"
              tone={data.bench.freeToday === 0 ? 'danger' : 'ok'}
            />
          </div>

          <div style={{ maxHeight: 340, overflowY: 'auto', borderTop: '1px solid var(--border-faint)' }}>
            {data.bench.rows.length === 0 ? (
              <p style={{
                margin: 0, padding: 'var(--space-4)',
                fontSize: 'var(--fs-sm)', color: 'var(--text-dim)',
              }}>
                No per diem on the roster holds a live site credential today.
              </p>
            ) : data.bench.rows.map(r => (
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
      <div style={{ marginTop: 'var(--space-5)' }}>
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
                      <SectionLabel source="none" rule={false}>In rooms</SectionLabel>
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
