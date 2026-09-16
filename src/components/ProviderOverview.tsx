/* ───────────────────────────────────────────────────────────────────────────
 * The clinician overview — one screen, five panels.
 *
 * Rendered in two places from the same component: a physician sees their own
 * at /me, back office sees anyone's on the provider profile. Identical either
 * way, deliberately — the number a physician reads about their own call must
 * be the number the office is reading about them.
 *
 * ── WHAT IT WILL NOT SAY ───────────────────────────────────────────────────
 * Hours here are SCHEDULED hours, summed from shift start and end times, and
 * the panel says so. There is no payroll integration; presenting a computed
 * figure as pay would have somebody checking their paycheque against a number
 * that has never seen their pay.
 *
 * And an owed column with no stated bands behind it shows a dash, not a zero.
 * "You owe nothing" and "this site does not state per-category obligations"
 * are different sentences.
 * ─────────────────────────────────────────────────────────────────────────── */

'use client';

import type { ReactNode } from 'react';
import { Card, Badge, Banner, SectionLabel, SourceTag } from '@/components/ui';
import type { ProviderOverview as OverviewData, OverviewSite, OverviewProvider } from '@/lib/providerOverview';

const mono = {
  fontFamily: 'var(--font-mono), ui-monospace, monospace',
  fontVariantNumeric: 'tabular-nums' as const,
};

function shortDate(iso?: string | null): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return '';
  return new Date(Date.UTC(y, m - 1, d))
    .toLocaleDateString('en-US', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** A label/value line. The value is mono so a column of them lines up. */
function Line({ label, value, tone }: { label: ReactNode; value: ReactNode; tone?: string }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'baseline', gap: 'var(--space-3)',
      padding: '7px 0', borderBottom: '1px solid var(--border-faint)',
    }}>
      <span style={{ flex: 1, minWidth: 0, fontSize: 'var(--fs-sm)' }}>{label}</span>
      <span style={{ ...mono, fontWeight: 600, color: tone || 'var(--text-strong)' }}>{value}</span>
    </div>
  );
}

const EMPLOYMENT_LABEL: Record<string, string> = {
  full_time: 'Full-time', part_time: 'Part-time', per_diem: 'Per diem',
};

export interface ProviderOverviewProps {
  provider: OverviewProvider;
  sites: OverviewSite[];
  data: OverviewData;
  errors?: string[];
  /** Shown above the panels when the viewer is looking at somebody else. */
  viewingOther?: boolean;
}

export function ProviderOverviewView(
  { provider, sites, data, errors = [], viewingOther }: ProviderOverviewProps,
) {
  const { employment, call, hours, availability } = data;
  const siteById = new Map(sites.map(s => [s.id, s]));
  const homeSite = employment.homeSiteId ? siteById.get(employment.homeSiteId) : null;
  const name = [provider.first_name, provider.last_name].filter(Boolean).join(' ')
    || provider.short_display_name || 'Provider';
  const credential = provider.provider_type === 'crna' ? 'CRNA' : 'MD';
  const maxSiteHours = Math.max(1, ...hours.bySite.map(s => s.hours));

  return (
    <>
      {errors.length > 0 && (
        <Banner tone="error">
          Some data could not be read, so the figures below are incomplete: {errors.join('; ')}
        </Banner>
      )}

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'flex-start', gap: 'var(--space-4)',
        flexWrap: 'wrap', marginBottom: 'var(--space-4)',
      }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <h1 style={{
            fontSize: 'var(--fs-xl)', fontWeight: 800, letterSpacing: -0.5,
            color: 'var(--text-strong)', lineHeight: 1.15,
          }}>
            {name}{credential ? `, ${credential}` : ''}
          </h1>
          <div style={{
            display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap',
            marginTop: 'var(--space-2)',
          }}>
            <Badge tone="warn">{provider.provider_type === 'crna' ? 'CRNA' : 'Physician'}</Badge>
            <Badge tone={provider.status === 'active' ? 'ok' : 'neutral'}>
              {provider.status ?? 'unknown'}
            </Badge>
            {employment.status && (
              <Badge tone="neutral">
                {EMPLOYMENT_LABEL[employment.status] ?? employment.status}
              </Badge>
            )}
            {homeSite && (
              <Badge tone="info">Home · {homeSite.short_name || homeSite.name}</Badge>
            )}
            {employment.partner && <Badge tone="warn">Partner</Badge>}
          </div>
        </div>

        <div style={{ textAlign: 'right' }}>
          <div style={{
            ...mono, fontSize: 34, fontWeight: 600, letterSpacing: -1,
            color: 'var(--text-strong)', lineHeight: 1,
          }}>
            {employment.fte !== null ? employment.fte.toFixed(2) : '—'}
          </div>
          <div style={{
            ...mono, fontSize: 'var(--fs-xs)', color: 'var(--text-dim)',
            letterSpacing: 0.8, textTransform: 'uppercase', marginTop: 4,
          }}>
            FTE {employment.callTaker ? '· call' : '· no call'}
          </div>
        </div>
      </div>

      {viewingOther && (
        <p style={{
          margin: '0 0 var(--space-3)', fontSize: 'var(--fs-xs)', color: 'var(--text-dim)',
        }}>
          This is the same view {provider.first_name || 'this clinician'} sees when they sign in.
        </p>
      )}

      <div style={{
        display: 'grid', gap: 'var(--space-4)', alignItems: 'start',
        gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
      }}>
        {/* ── Employment ────────────────────────────────────────────────── */}
        <Card>
          <SectionLabel tags={<SourceTag>FloorRunner</SourceTag>}>Employment</SectionLabel>
          <Line label="Employment" value={
            employment.status ? (EMPLOYMENT_LABEL[employment.status] ?? employment.status) : '—'} />
          <Line label="FTE" value={employment.fte !== null ? employment.fte.toFixed(2) : '—'} />
          {employment.workDaysFte !== null && (
            <Line label="Working-days FTE" value={employment.workDaysFte.toFixed(2)} />
          )}
          <Line label="PTO allotment" value={
            employment.ptoWeeks !== null ? `${employment.ptoWeeks} wks` : '—'} />
          <Line
            label="Partnership"
            value={employment.partner ? 'Partner' : employment.partnerTrack ? 'Partner track' : 'Employed'}
          />
        </Card>

        {/* ── Call owed vs taken ────────────────────────────────────────── */}
        <Card>
          <SectionLabel tags={<SourceTag>FloorRunner</SourceTag>}>Call owed vs. taken</SectionLabel>

          {call.rows.length === 0 ? (
            <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--text-dim)', lineHeight: 1.65 }}>
              No call on record this year.
            </p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 300 }}>
                <thead>
                  <tr style={{ ...mono, fontSize: 10, color: 'var(--text-muted)' }}>
                    <th style={{ textAlign: 'left', padding: '0 0 6px', letterSpacing: 0.7 }}>CATEGORY</th>
                    <th style={{ textAlign: 'right', padding: '0 0 6px 10px', letterSpacing: 0.7 }}>OWED</th>
                    <th style={{ textAlign: 'right', padding: '0 0 6px 10px', letterSpacing: 0.7 }}
                        title="Taken within the current block — the only column comparable to OWED.">BLOCK</th>
                    <th style={{ textAlign: 'right', padding: '0 0 6px 10px', letterSpacing: 0.7 }}>YTD</th>
                    <th style={{ textAlign: 'right', padding: '0 0 6px 10px', letterSpacing: 0.7 }}>MTD</th>
                  </tr>
                </thead>
                <tbody>
                  {call.rows.map(r => {
                    // Compared against the BLOCK, not the year — the window the
                    // obligation is actually stated for.
                    const over = r.owed !== null && r.block > r.owed;
                    return (
                      <tr key={r.key} className="fr-row">
                        <td style={{
                          padding: '6px 0', fontSize: 'var(--fs-sm)',
                          borderBottom: '1px solid var(--border-faint)',
                        }}>{r.label}</td>
                        <td style={{
                          ...mono, padding: '6px 0 6px 10px', textAlign: 'right',
                          borderBottom: '1px solid var(--border-faint)',
                          color: r.owed === null ? 'var(--text-dim)' : 'var(--text)',
                        }}>{r.owed === null ? '—' : r.owed}</td>
                        <td style={{
                          ...mono, padding: '6px 0 6px 10px', textAlign: 'right', fontWeight: 600,
                          borderBottom: '1px solid var(--border-faint)',
                          color: over ? 'var(--danger)' : 'var(--text)',
                        }}>{r.block}</td>
                        <td style={{
                          ...mono, padding: '6px 0 6px 10px', textAlign: 'right',
                          borderBottom: '1px solid var(--border-faint)',
                          color: r.ytd > 0 ? 'var(--text)' : 'var(--text-dim)',
                        }}>{r.ytd}</td>
                        <td style={{
                          ...mono, padding: '6px 0 6px 10px', textAlign: 'right',
                          borderBottom: '1px solid var(--border-faint)',
                          color: r.mtd > 0 ? 'var(--text)' : 'var(--text-dim)',
                        }}>{r.mtd}</td>
                      </tr>
                    );
                  })}
                  <tr>
                    <td style={{ padding: '8px 0 0', fontWeight: 700, fontSize: 'var(--fs-sm)' }}>Total</td>
                    <td style={{ ...mono, padding: '8px 0 0 10px', textAlign: 'right', fontWeight: 700 }}>
                      {call.totals.owed === null ? '—' : call.totals.owed}
                    </td>
                    <td style={{ ...mono, padding: '8px 0 0 10px', textAlign: 'right', fontWeight: 700 }}>
                      {call.totals.block}
                    </td>
                    <td style={{ ...mono, padding: '8px 0 0 10px', textAlign: 'right', fontWeight: 700 }}>
                      {call.totals.ytd}
                    </td>
                    <td style={{ ...mono, padding: '8px 0 0 10px', textAlign: 'right', fontWeight: 700 }}>
                      {call.totals.mtd}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          {/* The no-netting rule, stated where it is being applied. */}
          {call.remaining !== null && call.remaining > 0 && (
            <div style={{
              marginTop: 'var(--space-3)', paddingLeft: 'var(--space-3)',
              borderLeft: '2px solid var(--blue)',
              fontSize: 'var(--fs-xs)', lineHeight: 1.7, color: 'var(--text-dim)',
            }}>
              <strong style={{ ...mono, color: 'var(--blue)' }}>{call.remaining}</strong>
              {' '}of {call.totals.owed} still to come before {shortDate(call.blockEnd)}.
              {' '}The block is still running, so these are not yet short.
            </div>
          )}

          {(call.over.length > 0 || call.short.length > 0) && (
            <div style={{
              marginTop: 'var(--space-3)', paddingLeft: 'var(--space-3)',
              borderLeft: '2px solid var(--warn)',
              fontSize: 'var(--fs-xs)', lineHeight: 1.7, color: 'var(--text-dim)',
            }}>
              {call.over.map(o => (
                <div key={o.label}>
                  <strong style={{ ...mono, color: 'var(--danger)' }}>+{o.by} {o.label}</strong>
                  {' '}beyond the stated count.
                </div>
              ))}
              {call.short.map(s => (
                <div key={s.label}>
                  <strong style={{ ...mono, color: 'var(--warn)' }}>{s.by} {s.label}</strong>
                  {' '}still owed.
                </div>
              ))}
              {call.over.length > 0 && call.short.length > 0 && (
                <div style={{ marginTop: 4 }}>
                  Each category counts on its own — an extra is never cancelled by one
                  still owed elsewhere.
                </div>
              )}
            </div>
          )}

          <p style={{
            margin: 'var(--space-3) 0 0', fontSize: 'var(--fs-xs)',
            color: 'var(--text-dim)', lineHeight: 1.6,
          }}>
            {call.blockLabel
              ? <><strong style={{ color: 'var(--text-muted)' }}>Owed</strong> is the stated
                obligation for the current block ({call.blockLabel}); YTD and MTD count what
                has actually been taken.</>
              : <>No block covers today, so there is no stated obligation to compare against —
                the counts are what has been taken.</>}
          </p>
        </Card>

        {/* ── Hours ─────────────────────────────────────────────────────── */}
        <Card>
          <SectionLabel tags={<SourceTag>FloorRunner</SourceTag>}>Hours scheduled</SectionLabel>
          <Line label="Average hours / week YTD" value={hours.averageHoursPerWeekYtd} />
          <Line label="Total hours YTD" value={hours.totalHoursYtd.toLocaleString('en-US')} />
          <Line label="Call hours YTD" value={hours.callHoursYtd.toLocaleString('en-US')} />
          <Line label="Shifts YTD" value={hours.shiftsYtd} />

          {hours.bySite.length > 0 && (
            <div style={{ marginTop: 'var(--space-3)' }}>
              <SectionLabel source="none" rule={false}>By site</SectionLabel>
              {hours.bySite.map(s => (
                <div key={s.siteId} style={{
                  display: 'flex', alignItems: 'center', gap: 'var(--space-2)', padding: '4px 0',
                }}>
                  <span style={{ fontSize: 'var(--fs-sm)', width: 62, flexShrink: 0 }}>{s.label}</span>
                  <span style={{
                    flex: 1, height: 6, borderRadius: 3, background: 'var(--tint-surface)',
                    overflow: 'hidden', minWidth: 40,
                  }}>
                    <span style={{
                      display: 'block', height: '100%', borderRadius: 3,
                      width: `${Math.round((s.hours / maxSiteHours) * 100)}%`,
                      background: 'var(--blue)',
                    }} />
                  </span>
                  <span style={{ ...mono, fontSize: 'var(--fs-sm)', fontWeight: 600, width: 54, textAlign: 'right' }}>
                    {s.hours.toLocaleString('en-US')}
                  </span>
                </div>
              ))}
            </div>
          )}

          <p style={{
            margin: 'var(--space-3) 0 0', fontSize: 'var(--fs-xs)',
            color: 'var(--text-dim)', lineHeight: 1.6,
          }}>
            Hours the <strong style={{ color: 'var(--text-muted)' }}>schedule</strong> puts you in
            a room, summed from shift start and end times. Not a payroll figure.
            {hours.shiftsWithoutTimes > 0 && (
              <> {hours.shiftsWithoutTimes} shift{hours.shiftsWithoutTimes === 1 ? '' : 's'} this
                year {hours.shiftsWithoutTimes === 1 ? 'states' : 'state'} no hours and {hours.shiftsWithoutTimes === 1 ? 'is' : 'are'} not
                counted above.</>
            )}
          </p>
        </Card>

        {/* ── Credentialed sites ────────────────────────────────────────── */}
        <Card>
          <SectionLabel tags={<SourceTag>FloorRunner</SourceTag>}>Credentialed sites</SectionLabel>
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            {sites.map(s => {
              const on = data.credentialedSiteIds.includes(s.id);
              const home = s.id === employment.homeSiteId;
              return (
                <span key={s.id} style={{
                  ...mono, fontSize: 'var(--fs-xs)', fontWeight: 600, letterSpacing: 0.5,
                  padding: '5px 10px', borderRadius: 'var(--radius-sm)',
                  background: home ? 'var(--blue)' : on
                    ? 'color-mix(in srgb, var(--blue) 12%, transparent)' : 'transparent',
                  color: home ? 'var(--on-accent)' : on ? 'var(--blue)' : 'var(--text-faint)',
                  border: `1px solid ${home ? 'var(--blue)' : on
                    ? 'color-mix(in srgb, var(--blue) 30%, transparent)' : 'var(--border)'}`,
                }} title={home ? `${s.name} — home site` : on ? s.name : `${s.name} — not credentialed`}>
                  {s.short_name || s.name}
                </span>
              );
            })}
          </div>
          <p style={{
            margin: 'var(--space-3) 0 0', fontSize: 'var(--fs-xs)',
            color: 'var(--text-dim)', lineHeight: 1.6,
          }}>
            {data.credentialedSiteIds.length === 0
              ? 'No active site credential on file. The engine will not place anyone at a site they are not credentialed for.'
              : <>Credentialing on file for {data.credentialedSiteIds.length} of {sites.length} sites.
                The engine will not place anyone at a site they are not credentialed for.</>}
          </p>
        </Card>

        {/* ── Availability ──────────────────────────────────────────────── */}
        <Card>
          <SectionLabel tags={<SourceTag>FloorRunner</SourceTag>}>Availability</SectionLabel>
          <Line
            label="PTO used"
            value={availability.ptoWeeksAllotted !== null
              ? `${availability.ptoWeeksUsed} of ${availability.ptoWeeksAllotted} wks`
              : `${availability.ptoWeeksUsed} wks`}
          />
          <Line
            label="Next PTO block"
            value={availability.nextPto
              ? `${shortDate(availability.nextPto.start)}–${shortDate(availability.nextPto.end)}`
              : 'none booked'}
            tone={availability.nextPto ? undefined : 'var(--text-dim)'}
          />
          {availability.sellbackWeeks > 0 && (
            <Line label="PTO sell-back" value={`${availability.sellbackWeeks} wk`} />
          )}
          <Line
            label="Open no-call requests"
            value={availability.openNoCallRequests}
            tone={availability.openNoCallRequests > 0 ? 'var(--warn)' : 'var(--text-dim)'}
          />
          {availability.pendingPtoBlocks > 0 && (
            <Line
              label="PTO requested, not yet approved"
              value={availability.pendingPtoBlocks}
              tone="var(--warn)"
            />
          )}
          <p style={{
            margin: 'var(--space-3) 0 0', fontSize: 'var(--fs-xs)',
            color: 'var(--text-dim)', lineHeight: 1.6,
          }}>
            PTO used counts approved leave that has already started. A request still waiting
            on a decision blocks the scheduler but is not counted as used.
          </p>
        </Card>
      </div>
    </>
  );
}
