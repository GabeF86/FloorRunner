/* ───────────────────────────────────────────────────────────────────────────
 * Manual entry for needed staff.
 *
 * The same site × day grid as the coverage matrix, with two inputs per cell:
 * MDs needed and CRNAs needed. A scheduler reads the OR schedule out of Epic,
 * counts the anaesthetising sites, and types the numbers in.
 *
 * ── A BLANK IS NOT A ZERO ──────────────────────────────────────────────────
 * Clearing a cell DELETES the manual row rather than storing 0. The board then
 * reads that day N/A. If it stored a zero the day would go green — an
 * unstaffed hospital reported as fully covered, which is the failure the
 * demand table exists to prevent. A genuine 0 ("no physician needed on
 * Sunday") is a different statement and is stored as one.
 *
 * ── SAVES ARE PER CELL ─────────────────────────────────────────────────────
 * On blur, and only when the value actually changed. No Save button to forget,
 * no bulk submit that loses the whole grid because one cell was malformed, and
 * a failed cell says so next to itself while its neighbours stay saved.
 * ─────────────────────────────────────────────────────────────────────────── */

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, Banner, SectionLabel } from '@/components/ui';
import { demandKey, parseDemandInput, type DemandRow, type WeekendCall } from '@/lib/staffingDemand';
import type { CoverageRow } from '@/lib/operationsBoard';

const mono = {
  fontFamily: 'var(--font-mono), ui-monospace, monospace',
  fontVariantNumeric: 'tabular-nums' as const,
};

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function dayParts(iso: string): { dow: string; md: string } {
  const [y, m, d] = iso.split('-').map(Number);
  return { dow: DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()], md: `${m}/${d}` };
}

type CellState = 'idle' | 'saving' | 'saved' | 'error';

export function DemandEntry(
  { sites, dates, onSaved }: {
    sites: CoverageRow[];
    dates: string[];
    /** Told after a successful save so the coverage tab can refresh. */
    onSaved?: () => void;
  },
) {
  const [rows, setRows] = useState<DemandRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [state, setState] = useState<Record<string, CellState>>({});
  const [message, setMessage] = useState<Record<string, string>>({});

  useEffect(() => {
    let live = true;
    // no-store, deliberately. Without it the browser serves the response it
    // cached BEFORE the last save, so re-opening this tab showed the counts
    // gone — they were in the database the whole time.
    fetch(`/api/scheduling/staffing-demand?from=${dates[0]}&to=${dates[dates.length - 1]}`,
      { cache: 'no-store' })
      .then(async r => {
        const body = await r.json();
        if (!r.ok) throw new Error(body?.error || `Request failed (${r.status})`);
        return body.rows as DemandRow[];
      })
      .then(r => { if (live) setRows(r); })
      .catch(e => { if (live) setLoadError(e instanceof Error ? e.message : 'Could not load.'); });
    return () => { live = false; };
  }, [dates]);

  /** Only MANUAL rows are editable here. A calculated row is shown as the
   *  placeholder underneath, so a scheduler can see what the calculator said
   *  before overriding it. */
  const manual = useMemo(() => {
    const m = new Map<string, DemandRow>();
    for (const r of rows ?? []) {
      if ((r.source ?? 'manual') === 'manual') m.set(demandKey(r.site_id, r.demand_date), r);
    }
    return m;
  }, [rows]);

  const calculated = useMemo(() => {
    const m = new Map<string, DemandRow>();
    for (const r of rows ?? []) {
      if (r.source === 'calculated') m.set(demandKey(r.site_id, r.demand_date), r);
    }
    return m;
  }, [rows]);

  const save = useCallback(async (
    siteId: string, date: string, field: 'md' | 'crna', raw: string,
  ) => {
    const key = demandKey(siteId, date);
    const parsed = parseDemandInput(raw);
    if (parsed === 'invalid') {
      setState(s => ({ ...s, [key]: 'error' }));
      setMessage(m => ({ ...m, [key]: 'Whole numbers only.' }));
      return;
    }

    const existing = manual.get(key);
    const next = {
      md_needed: field === 'md' ? parsed : (existing?.md_needed ?? null),
      crna_needed: field === 'crna' ? parsed : (existing?.crna_needed ?? null),
    };

    setState(s => ({ ...s, [key]: 'saving' }));
    try {
      const res = await fetch('/api/scheduling/staffing-demand', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ site_id: siteId, demand_date: date, ...next }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || `Save failed (${res.status})`);

      setRows(prev => {
        const others = (prev ?? []).filter(
          r => !(r.site_id === siteId && r.demand_date === date && (r.source ?? 'manual') === 'manual'));
        return body.cleared
          ? others
          : [...others, { site_id: siteId, demand_date: date, source: 'manual', ...next }];
      });
      setState(s => ({ ...s, [key]: 'saved' }));
      setMessage(m => ({ ...m, [key]: '' }));
      onSaved?.();
    } catch (e) {
      setState(s => ({ ...s, [key]: 'error' }));
      setMessage(m => ({ ...m, [key]: e instanceof Error ? e.message : 'Save failed.' }));
    }
  }, [manual, onSaved]);

  if (loadError) return <Banner tone="error">{loadError}</Banner>;

  return (
    <Card pad={false}>
      <div style={{ padding: 'var(--space-4) var(--space-4) 0' }}>
        <SectionLabel>Manual entry for needed staff</SectionLabel>
        <p style={{
          margin: '0 0 var(--space-3)', fontSize: 'var(--fs-xs)',
          color: 'var(--text-dim)', lineHeight: 1.65,
        }}>
          Count the anaesthetising sites running that day on the OR schedule and enter how many
          MDs and CRNAs it takes to cover them. Saves as you leave each box.
          {' '}<strong style={{ color: 'var(--text-muted)' }}>Leave a box empty</strong> and the
          day reads N/A on the board — never zero, because an uncounted day must not report as
          covered. A real <strong style={{ color: 'var(--text-muted)' }}>0</strong> means nobody
          is needed, and is stored as that.
        </p>
      </div>

      <WeekendCallSection onSaved={onSaved} />

      <div style={{ padding: '0 var(--space-4)' }}>
        <SectionLabel source="none" rule={false}>By day</SectionLabel>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 860 }}>
          <thead>
            <tr>
              <th style={{
                padding: '6px var(--space-4)', textAlign: 'left', ...mono,
                fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', fontWeight: 600,
                borderBottom: '1px solid var(--border)',
              }}>Site</th>
              {dates.map(d => {
                const { dow, md } = dayParts(d);
                return (
                  <th key={d} style={{
                    padding: '6px 8px', textAlign: 'center', ...mono,
                    fontSize: 'var(--fs-xs)', fontWeight: 600, color: 'var(--text-muted)',
                    borderBottom: '1px solid var(--border)',
                  }}>
                    {dow}<br />
                    <span style={{ fontWeight: 400, color: 'var(--text-dim)' }}>{md}</span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sites.map(site => (
              <tr key={site.siteId} className="fr-row">
                <td style={{
                  padding: '7px var(--space-4)', whiteSpace: 'nowrap',
                  borderBottom: '1px solid var(--border-faint)',
                }}>
                  <span style={{ ...mono, fontWeight: 600, fontSize: 'var(--fs-sm)' }}>
                    {site.shortName}
                  </span>
                  <span style={{
                    display: 'block', fontSize: 'var(--fs-xs)', color: 'var(--text-dim)',
                  }}>{site.siteName}</span>
                </td>
                {dates.map(date => {
                  const key = demandKey(site.siteId, date);
                  const row = manual.get(key);
                  const calc = calculated.get(key);
                  const st = state[key] ?? 'idle';
                  return (
                    <td key={date} style={{
                      padding: '5px 6px', textAlign: 'center',
                      borderBottom: '1px solid var(--border-faint)',
                      background: st === 'error' ? 'var(--danger-bg)'
                        : st === 'saved' ? 'var(--ok-bg)' : undefined,
                    }}>
                      <div style={{ display: 'flex', gap: 4, justifyContent: 'center' }}>
                        <DemandInput
                          label="MD"
                          value={row?.md_needed ?? null}
                          placeholder={calc?.md_needed ?? null}
                          disabled={rows === null}
                          onCommit={v => save(site.siteId, date, 'md', v)}
                        />
                        <DemandInput
                          label="CRNA"
                          value={row?.crna_needed ?? null}
                          placeholder={calc?.crna_needed ?? null}
                          disabled={rows === null}
                          onCommit={v => save(site.siteId, date, 'crna', v)}
                        />
                      </div>
                      {st === 'error' && message[key] && (
                        <div style={{ fontSize: 9, color: 'var(--danger)', marginTop: 2 }}>
                          {message[key]}
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p style={{
        margin: 0, padding: 'var(--space-3) var(--space-4)',
        borderTop: '1px solid var(--border-faint)',
        fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', lineHeight: 1.65,
      }}>
        When the staffing calculator lands it will write these counts itself, from the
        anaesthetising sites each hospital is running. Anything entered here will still win —
        a person who has read the OR schedule outranks a model of it — and both figures are
        kept, so an override can be compared against what the calculator would have said.
      </p>
    </Card>
  );
}

/** One count box. Local state while typing, committed on blur or Enter, so a
 *  half-typed "1" of "12" is never saved. */
function DemandInput(
  { label, value, placeholder, disabled, onCommit }: {
    label: string;
    value: number | null;
    placeholder: number | null;
    disabled?: boolean;
    onCommit: (raw: string) => void;
  },
) {
  const [text, setText] = useState(value === null || value === undefined ? '' : String(value));

  // Follow the saved value when it changes underneath — after a save, or when
  // the week changes.
  useEffect(() => {
    setText(value === null || value === undefined ? '' : String(value));
  }, [value]);

  return (
    <label style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
      <span style={{ ...mono, fontSize: 8, color: 'var(--text-dim)', letterSpacing: 0.4 }}>
        {label}
      </span>
      <input
        className="fr-field fr-focus"
        inputMode="numeric"
        disabled={disabled}
        value={text}
        placeholder={placeholder === null ? '–' : String(placeholder)}
        onChange={e => setText(e.target.value)}
        onBlur={e => {
          const raw = e.target.value;
          if (raw.trim() === (value === null || value === undefined ? '' : String(value))) return;
          onCommit(raw);
        }}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        style={{
          width: 34, padding: '3px 2px', textAlign: 'center',
          ...mono, fontSize: 'var(--fs-xs)', fontWeight: 600,
          borderRadius: 'var(--radius-sm)',
          border: '1px solid var(--border-input)',
          background: 'var(--bg-surface)', color: 'var(--text)',
        }}
      />
    </label>
  );
}

/* ── The standing weekend complement ──────────────────────────────────────
 * Weekend call is structural: the same positions have to be covered every
 * Saturday and Sunday whatever the OR is doing. Typing it into fourteen cells
 * a fortnight would be busywork, so it is configured once per site and applied
 * to every weekend automatically — and still overridden by anything typed into
 * a specific day below.
 *
 * The suggestion beside each box is the call positions actually standing on
 * weekends in the published schedule. It is offered, never applied: Riddle
 * shows two across the window because its second call ran on exactly one
 * Saturday, so taking the derived number unquestioned would overstate it.
 */
interface WeekendSite {
  id: string;
  name: string;
  short_name: string | null;
  configured: WeekendCall | null;
  suggestion: { md: number | null; crna: number | null; codes: string[] } | null;
}

function WeekendCallSection({ onSaved }: { onSaved?: () => void }) {
  const [sites, setSites] = useState<WeekendSite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch('/api/scheduling/sites/weekend-call', { cache: 'no-store' })
      .then(async r => {
        const body = await r.json();
        if (!r.ok) throw new Error(body?.error || `Request failed (${r.status})`);
        return body.sites as WeekendSite[];
      })
      .then(r => { if (live) setSites(r); })
      .catch(e => { if (live) setError(e instanceof Error ? e.message : 'Could not load.'); });
    return () => { live = false; };
  }, []);

  const save = useCallback(async (site: WeekendSite, field: 'md' | 'crna', raw: string) => {
    const parsed = parseDemandInput(raw);
    if (parsed === 'invalid') { setError('Whole numbers only.'); return; }
    const next: WeekendCall = {
      md: field === 'md' ? parsed : (site.configured?.md ?? null),
      crna: field === 'crna' ? parsed : (site.configured?.crna ?? null),
    };
    setBusy(site.id);
    try {
      const res = await fetch('/api/scheduling/sites/weekend-call', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ site_id: site.id, ...next }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || `Save failed (${res.status})`);
      setSites(prev => (prev ?? []).map(s => (s.id === site.id
        ? { ...s, configured: next.md === null && next.crna === null ? null : next }
        : s)));
      setError(null);
      onSaved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed.');
    } finally { setBusy(null); }
  }, [onSaved]);

  return (
    <div style={{ padding: '0 var(--space-4) var(--space-4)' }}>
      <SectionLabel source="none" rule={false}>Weekend call complement</SectionLabel>
      <p style={{
        margin: '0 0 var(--space-2)', fontSize: 'var(--fs-xs)',
        color: 'var(--text-dim)', lineHeight: 1.65,
      }}>
        Set once per site and it fills every Saturday and Sunday. Anything typed into a
        specific day below still wins. The grey number is what the published schedule
        actually stands on weekends — a suggestion to confirm, not a default.
      </p>

      {error && <Banner tone="error">{error}</Banner>}

      <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
        {(sites ?? []).map(site => (
          <div key={site.id} style={{
            display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
            padding: '6px 10px', borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--border)', opacity: busy === site.id ? 0.6 : 1,
          }}>
            <span style={{ ...mono, fontSize: 'var(--fs-xs)', fontWeight: 600, minWidth: 40 }}
                  title={site.name}>
              {site.short_name || site.name}
            </span>
            <DemandInput
              label="MD"
              value={site.configured?.md ?? null}
              placeholder={site.suggestion?.md ?? null}
              onCommit={v => save(site, 'md', v)}
            />
            <DemandInput
              label="CRNA"
              value={site.configured?.crna ?? null}
              placeholder={site.suggestion?.crna ?? null}
              onCommit={v => save(site, 'crna', v)}
            />
            {site.suggestion?.codes.length ? (
              <span style={{ ...mono, fontSize: 9, color: 'var(--text-dim)' }}
                    title={`Standing on weekends in the published schedule: ${site.suggestion.codes.join(', ')}`}>
                {site.suggestion.codes.join(' ')}
              </span>
            ) : null}
          </div>
        ))}
        {sites === null && !error && (
          <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-dim)' }}>Loading sites…</span>
        )}
      </div>
    </div>
  );
}
