/* ───────────────────────────────────────────────────────────────────────────
 * Group handbook — the view.
 *
 * Six panels: rates, site call rules, leadership, committee, pipeline,
 * documents. One page for administration and for employees, always current.
 *
 * ── EMPTY STATES ARE THE MAIN FEATURE RIGHT NOW ────────────────────────────
 * Five of the six tables ship empty. So every panel's empty state has to do
 * real work: say what belongs there, and make clear nothing is missing or
 * broken. A blank panel that looks like a failed load is worse than no panel,
 * and "$0" beside a call rate is worse than both.
 * ─────────────────────────────────────────────────────────────────────────── */

'use client';

import type { ReactNode } from 'react';
import { Card, Banner, PageHeader, SectionLabel, Badge } from '@/components/ui';
import { formatMoney, ACCESS_LABEL } from '@/lib/handbook';
import { NO_CALL } from '@/lib/siteCallRules';
import type { HandbookData } from './queries';

const mono = {
  fontFamily: 'var(--font-mono), ui-monospace, monospace',
  fontVariantNumeric: 'tabular-nums' as const,
};

/** "2026-09-24" → "24 Sep". UTC parts, never the Date constructor's local
 *  reading, which shifts the label a day west of GMT. */
function shortDate(iso?: string | null): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return '';
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    day: 'numeric', month: 'short', timeZone: 'UTC',
  });
}

function longDate(iso?: string | null): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return '';
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

/** The one place a panel decides between "broken", "nothing here yet" and
 *  content — so no panel can accidentally render an error as emptiness. */
function PanelBody<T>(
  { panel, empty, children }: {
    panel: { data: T[]; error: string | null };
    empty: ReactNode;
    children: (rows: T[]) => ReactNode;
  },
) {
  if (panel.error) {
    return <Banner tone="error">This panel could not be loaded: {panel.error}</Banner>;
  }
  if (panel.data.length === 0) {
    return (
      <p style={{
        margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--text-dim)', lineHeight: 1.65,
      }}>{empty}</p>
    );
  }
  return <>{children(panel.data)}</>;
}

const RowLine = ({ children, last }: { children: ReactNode; last?: boolean }) => (
  <div style={{
    display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)',
    padding: '7px 0',
    borderBottom: last ? 'none' : '1px solid var(--border-faint)',
  }}>{children}</div>
);

export function HandbookView({ data, fatal }: { data: HandbookData | null; fatal?: string | null }) {
  if (fatal || !data) {
    return (
      <>
        <PageHeader title="Group handbook" />
        <Banner tone="error">{fatal || 'The handbook could not be loaded.'}</Banner>
      </>
    );
  }

  const { rates, siteRules, leadership, meetings, pipeline, documents } = data;
  const flaggedSites = siteRules.data.filter(r => r.flagged);

  return (
    <>
      <div style={{
        display: 'flex', gap: 'var(--space-6)', alignItems: 'flex-start',
        flexWrap: 'wrap', justifyContent: 'space-between',
      }}>
        <PageHeader
          title="One source of truth for how the group runs."
          subtitle="Rules, rates, minutes, documents and hiring — the same page for administration and for employees."
        />
        <div style={{ ...mono, fontSize: 'var(--fs-xs)', textAlign: 'right', lineHeight: 1.9 }}>
          <div>
            <span style={{ color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: 0.6 }}>
              documents
            </span>{' '}
            <span>{documents.data.length} on file</span>
          </div>
          <div>
            <span style={{ color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: 0.6 }}>
              committee
            </span>{' '}
            <span>
              {meetings.data.next
                ? `next ${shortDate(meetings.data.next.meets_on)}`
                : 'none scheduled'}
            </span>
          </div>
          <div>
            <span style={{ color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: 0.6 }}>
              open
            </span>{' '}
            <span>{meetings.data.openActions} actions · {pipeline.data.active} candidates</span>
          </div>
        </div>
      </div>

      <div style={{
        display: 'grid', gap: 'var(--space-4)', alignItems: 'start',
        gridTemplateColumns: 'repeat(auto-fit, minmax(330px, 1fr))',
      }}>
        {/* ── Pay rates ─────────────────────────────────────────────────── */}
        <Card>
          <SectionLabel>Additional pay rates</SectionLabel>
          <PanelBody
            panel={rates}
            empty={<>
              No rates recorded yet. Each rate is stored with the date it takes effect, so
              the page can answer both &ldquo;what is it now&rdquo; and &ldquo;when did it
              move&rdquo; without anybody sending an email.
            </>}
          >
            {rows => (
              <div>
                {rows.map((r, i) => (
                  <RowLine key={r.id} last={i === rows.length - 1}>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 'var(--fs-sm)' }}>
                      {r.label}
                      {r.siteId && (
                        <span style={{ ...mono, fontSize: 10, color: 'var(--text-dim)', marginLeft: 6 }}>
                          {data.siteNames[r.siteId] || 'site'}
                        </span>
                      )}
                      {r.previous && (
                        <span style={{
                          ...mono, fontSize: 10, marginLeft: 6,
                          color: r.amountCents > r.previous.amountCents ? 'var(--ok)' : 'var(--warn)',
                        }}>
                          {r.amountCents > r.previous.amountCents ? '↑' : '↓'}{' '}
                          {shortDate(r.effectiveDate)}
                        </span>
                      )}
                      {r.pending && (
                        <span style={{
                          ...mono, fontSize: 10, marginLeft: 6, color: 'var(--blue)',
                        }} title={`${formatMoney(r.pending.amountCents)} from ${r.pending.effectiveDate}`}>
                          {formatMoney(r.pending.amountCents)} from {shortDate(r.pending.effectiveDate)}
                        </span>
                      )}
                    </span>
                    <span style={{ ...mono, fontWeight: 600 }}>
                      {r.effectiveDate
                        ? formatMoney(r.amountCents)
                        // Every row for this rate is in the future: there is no
                        // current amount, and printing $0 would be a lie about
                        // what the group pays.
                        : <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>not yet in force</span>}
                    </span>
                  </RowLine>
                ))}
              </div>
            )}
          </PanelBody>
        </Card>

        {/* ── Site call rules ───────────────────────────────────────────── */}
        <Card>
          <SectionLabel>Site call rules, par level &amp; roster</SectionLabel>
          <PanelBody
            panel={siteRules}
            empty="No active sites."
          >
            {rows => (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 380 }}>
                  <thead>
                    <tr style={{ ...mono, fontSize: 10, color: 'var(--text-muted)' }}>
                      <th style={{ textAlign: 'left', padding: '0 0 6px', letterSpacing: 0.6 }}>SITE</th>
                      <th style={{ textAlign: 'right', padding: '0 10px 6px', letterSpacing: 0.6 }}>PAR</th>
                      <th style={{ textAlign: 'right', padding: '0 10px 6px', letterSpacing: 0.6 }}>ROSTER</th>
                      <th style={{ textAlign: 'left', padding: '0 0 6px', letterSpacing: 0.6 }}>CALL STRUCTURE</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(r => (
                      <tr key={r.siteId} className="fr-row">
                        <td style={{
                          padding: '7px 0', fontSize: 'var(--fs-sm)',
                          borderBottom: '1px solid var(--border-faint)', whiteSpace: 'nowrap',
                        }}>{r.siteName}</td>
                        <td style={{
                          padding: '7px 10px', textAlign: 'right', ...mono, fontWeight: 600,
                          fontSize: 'var(--fs-sm)',
                          borderBottom: '1px solid var(--border-faint)',
                        }}>
                          {r.parLevel ?? <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>—</span>}
                          {r.flagged && (
                            <span style={{
                              ...mono, fontSize: 9, fontWeight: 600, marginLeft: 5,
                              padding: '1px 4px', borderRadius: 'var(--radius-sm)',
                              background: 'var(--warn-bg)', color: 'var(--warn)',
                            }} title={r.flagNote}>FLAG</span>
                          )}
                        </td>
                        <td style={{
                          padding: '7px 10px', textAlign: 'right', ...mono,
                          fontSize: 'var(--fs-xs)', color: 'var(--text-dim)',
                          borderBottom: '1px solid var(--border-faint)', whiteSpace: 'nowrap',
                        }} title={`${r.poolCount} call ${r.poolCount === 1 ? 'taker lists' : 'takers list'} this as their home site`}>
                          {/* The roster is shown wherever people are homed —
                              including at a site with nothing configured,
                              where it is the point: those twelve people have
                              nowhere to be scheduled. */}
                          {r.poolCount === 0 ? '—' : `${r.poolFte} FTE`}
                        </td>
                        <td style={{
                          padding: '7px 0', fontSize: 'var(--fs-xs)',
                          color: r.configured && r.structure !== NO_CALL
                            ? 'var(--text)' : 'var(--text-dim)',
                          fontStyle: r.configured ? undefined : 'italic',
                          borderBottom: '1px solid var(--border-faint)',
                        }}>{r.structure}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {flaggedSites.length > 0 && (
                  <div style={{
                    marginTop: 'var(--space-3)', paddingTop: 'var(--space-2)',
                    borderTop: '1px solid var(--border-faint)',
                    fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', lineHeight: 1.65,
                  }}>
                    {flaggedSites.map(r => (
                      <div key={r.siteId} style={{ marginBottom: 4 }}>
                        <strong style={{ color: 'var(--warn)' }}>{r.siteName}</strong>{' '}
                        {r.flagNote}
                      </div>
                    ))}
                  </div>
                )}

                <p style={{
                  margin: 'var(--space-3) 0 0', fontSize: 'var(--fs-xs)',
                  color: 'var(--text-dim)', lineHeight: 1.65,
                }}>
                  <strong style={{ color: 'var(--text-muted)' }}>Roster</strong> is every call
                  taker whose home site this is. A single block can be narrower — the generator
                  honours an included-provider override, which only ever narrows the pool — so
                  the figure a block was actually built against can be smaller than this one.
                </p>
              </div>
            )}
          </PanelBody>
        </Card>

        {/* ── Leadership ────────────────────────────────────────────────── */}
        <Card>
          <SectionLabel>Leadership structure</SectionLabel>
          <PanelBody
            panel={leadership}
            empty="No leadership roles recorded yet."
          >
            {rows => (
              <div>
                {rows.map(r => (
                  <div key={r.id} style={{
                    paddingLeft: 'var(--space-3)',
                    borderLeft: '2px solid var(--blue)',
                    marginBottom: 'var(--space-3)',
                  }}>
                    <div style={{
                      ...mono, fontSize: 10, letterSpacing: 0.7, textTransform: 'uppercase',
                      color: 'var(--text-muted)',
                    }}>
                      {r.title}{r.division ? ` · ${r.division}` : ''}
                    </div>
                    <div style={{ fontSize: 'var(--fs-md)', fontWeight: 600 }}>
                      {r.person_name || <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>vacant</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </PanelBody>
        </Card>

        {/* ── Operating committee ───────────────────────────────────────── */}
        <Card>
          <SectionLabel>Operating committee</SectionLabel>
          {meetings.error ? (
            <Banner tone="error">This panel could not be loaded: {meetings.error}</Banner>
          ) : (
            <>
              {meetings.data.next ? (
                <div style={{
                  padding: 'var(--space-3)', borderRadius: 'var(--radius-md)',
                  background: 'var(--info-bg)', marginBottom: 'var(--space-3)',
                }}>
                  <div style={{ ...mono, fontSize: 'var(--fs-md)', fontWeight: 600, color: 'var(--info)' }}>
                    {longDate(meetings.data.next.meets_on)}
                    {meetings.data.next.meets_at ? ` · ${meetings.data.next.meets_at.slice(0, 5)}` : ''}
                  </div>
                  <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 2 }}>
                    {meetings.data.next.location || 'Location not set'}
                    {meetings.data.next.agenda_posted_on
                      ? ` · agenda posted ${shortDate(meetings.data.next.agenda_posted_on)}`
                      : ' · agenda not posted'}
                  </div>
                </div>
              ) : (
                <p style={{
                  margin: '0 0 var(--space-3)', fontSize: 'var(--fs-sm)', color: 'var(--text-dim)',
                }}>
                  No meeting is scheduled.
                </p>
              )}

              {meetings.data.past.length === 0 ? (
                <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--text-dim)', lineHeight: 1.65 }}>
                  No past meetings recorded yet. Each one carries its topics, whether the
                  minutes are posted, and its action items with an owner and a due date.
                </p>
              ) : meetings.data.past.map((m, i) => (
                <RowLine key={m.id} last={i === meetings.data.past.length - 1}>
                  <span style={{
                    ...mono, fontSize: 10, fontWeight: 600, padding: '2px 6px',
                    borderRadius: 'var(--radius-sm)',
                    background: 'var(--tint-surface)', color: 'var(--text-muted)',
                    whiteSpace: 'nowrap',
                  }}>{shortDate(m.meets_on)}</span>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 'var(--fs-sm)' }}>
                    {m.topics || <span style={{ color: 'var(--text-dim)' }}>No topics recorded</span>}
                  </span>
                  <Badge tone={m.minutes_status === 'posted' ? 'ok' : 'neutral'}>
                    {m.minutes_status === 'posted' ? 'posted' : 'no minutes'}
                  </Badge>
                </RowLine>
              ))}

              {meetings.data.openActions > 0 && (
                <p style={{
                  margin: 'var(--space-3) 0 0', fontSize: 'var(--fs-xs)',
                  color: 'var(--text-dim)', lineHeight: 1.6,
                }}>
                  <strong style={{ color: 'var(--warn)' }}>{meetings.data.openActions}</strong>{' '}
                  open action {meetings.data.openActions === 1 ? 'item' : 'items'} carried
                  across these meetings.
                </p>
              )}
            </>
          )}
        </Card>

        {/* ── Candidate pipeline ────────────────────────────────────────── */}
        <Card>
          <SectionLabel
            tags={pipeline.data.active > 0
              ? <Badge tone="info">{pipeline.data.active} active</Badge>
              : undefined}
          >
            Candidate pipeline
          </SectionLabel>
          {pipeline.error ? (
            <Banner tone="error">This panel could not be loaded: {pipeline.error}</Banner>
          ) : pipeline.data.active === 0 ? (
            <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--text-dim)', lineHeight: 1.65 }}>
              No candidates in the pipeline. Candidates are recorded by{' '}
              <strong style={{ color: 'var(--text-muted)' }}>initials only</strong> — a hiring
              pipeline is visible to more people than a name should be — and the page surfaces
              a lapsing contract or a stalled credentialing file on its own.
            </p>
          ) : (
            <>
              {pipeline.data.stages.map(s => (
                <RowLine key={s.stage}>
                  <span style={{
                    ...mono, fontSize: 10, letterSpacing: 0.6, textTransform: 'uppercase',
                    color: 'var(--text-muted)', width: 110, flexShrink: 0,
                  }}>{s.label}</span>
                  <span style={{ ...mono, fontWeight: 600, width: 20, flexShrink: 0 }}>
                    {s.candidates.length || <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>—</span>}
                  </span>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 'var(--fs-xs)', lineHeight: 1.7 }}>
                    {s.candidates.map(c => (
                      <span key={c.id} style={{ marginRight: 10, whiteSpace: 'nowrap' }}>
                        <strong>{c.initials}</strong>
                        {c.homeSiteId && data.siteNames[c.homeSiteId] && (
                          <span style={{ color: 'var(--text-dim)' }}> · {data.siteNames[c.homeSiteId]}</span>
                        )}
                        {c.attention && (
                          <span style={{
                            ...mono, fontSize: 9, marginLeft: 4, padding: '1px 4px',
                            borderRadius: 'var(--radius-sm)',
                            background: 'var(--warn-bg)', color: 'var(--warn)',
                            textTransform: 'uppercase',
                          }}>{c.attention}</span>
                        )}
                      </span>
                    ))}
                  </span>
                </RowLine>
              ))}
              {pipeline.data.needAttention.length > 0 && (
                <p style={{
                  margin: 'var(--space-3) 0 0', fontSize: 'var(--fs-xs)',
                  color: 'var(--text-dim)', lineHeight: 1.6,
                }}>
                  <strong style={{ color: 'var(--warn)' }}>
                    {pipeline.data.needAttention.length}
                  </strong>{' '}
                  {pipeline.data.needAttention.length === 1 ? 'item needs' : 'items need'} attention
                  this week — each surfaced on its own, not because somebody went looking.
                </p>
              )}
            </>
          )}
        </Card>

        {/* ── Documents ─────────────────────────────────────────────────── */}
        <Card>
          <SectionLabel>Documents</SectionLabel>
          <PanelBody
            panel={documents}
            empty={<>
              No documents on file yet. Access is set per document, so one library serves
              partners and staff without two sets of files drifting apart.
            </>}
          >
            {rows => (
              <div>
                {rows.map((d, i) => (
                  <RowLine key={d.id} last={i === rows.length - 1}>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 'var(--fs-sm)' }}>
                      {d.url ? (
                        <a href={d.url} target="_blank" rel="noopener noreferrer"
                           style={{ color: 'var(--blue)' }}>{d.title}</a>
                      ) : d.title}
                    </span>
                    <span style={{ ...mono, fontSize: 10, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
                      {d.rolling ? 'rolling' : shortDate(d.version_on) || '—'}
                    </span>
                    <Badge tone={d.access_level === 'all_staff' ? 'neutral' : 'info'}>
                      {ACCESS_LABEL[d.access_level || 'all_staff'] || d.access_level}
                    </Badge>
                  </RowLine>
                ))}
              </div>
            )}
          </PanelBody>
        </Card>
      </div>

      <p style={{
        marginTop: 'var(--space-5)', fontSize: 'var(--fs-xs)', color: 'var(--text-dim)',
        lineHeight: 1.65,
      }}>
        Par levels, call structures and the roster behind them are read live from the
        scheduling configuration — they cannot drift from what the generator builds to.
        Rates, minutes, candidates and documents are records this page keeps; nothing on it
        is seeded or illustrative.
      </p>
    </>
  );
}
