'use client';

// Holiday Call (patch44, Gabriel 2026-09-06). Lives on the SCHEDULES list
// page next to the request window, for the same reason: it is an operational
// act tied to the blocks he is about to build, not durable site configuration.
//
// The list is the org's federal holidays for a calendar year; opening one
// shows every DAY that holiday covers — a holiday "stretches" over the
// weekend it touches (Thanksgiving also takes its Friday), so Christmas is
// three days to staff, not one. Each day × call code is a single-valued cell:
// pick the provider, and the decision is written to that provider's
// availability profile under the Holiday Call heading. See
// src/lib/holidayCall.ts for the day-expansion rule and how these decisions
// later materialize into real assignments.
import { useState, useEffect, useCallback, useMemo } from 'react';
import { Card, Button, Badge, Modal } from '@/components/ui';
import { HOLIDAY_CALL_CODES } from '@/lib/holidayCall';

interface Site {
  id: string;
  name: string;
  short_name: string | null;
}

interface Holiday {
  id: string;
  holiday_name: string;
  holiday_date: string;
  holiday_type: string;
  is_major_holiday: boolean;
  /** Every day this holiday covers, ascending — expanded server-side. */
  dates: string[];
}

interface Entry {
  id: string;
  provider_id: string;
  provider_name: string;
  date: string;
  code: string;
  holiday_name: string | null;
}

interface Conflict {
  provider_id: string;
  date: string;
  availability_type: string;
  label: string;
}

interface ProviderOption {
  id: string;
  label: string;
}

interface Payload {
  year: number;
  holidays: Holiday[];
  entries: Entry[];
  conflicts: Conflict[];
}

const EMPTY: Payload = { year: 0, holidays: [], entries: [], conflicts: [] };

export default function HolidayCallCard({ orgId, sites, initialSiteId }: {
  orgId: string;
  sites: Site[];
  initialSiteId?: string;
}) {
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [siteId, setSiteId] = useState(initialSiteId || sites[0]?.id || '');
  const [data, setData] = useState<Payload>(EMPTY);
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openHoliday, setOpenHoliday] = useState<Holiday | null>(null);

  useEffect(() => { if (initialSiteId) setSiteId(initialSiteId); }, [initialSiteId]);

  // Same async-sites guard RequestWindowCard documents: a controlled <select>
  // whose value matches no option DISPLAYS the first one while state stays ''.
  useEffect(() => {
    if (sites.length > 0 && !sites.some(s => s.id === siteId)) setSiteId(sites[0].id);
  }, [sites, siteId]);

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ org_id: orgId, year: String(year) });
      if (siteId) params.set('site_id', siteId);
      const res = await fetch('/api/scheduling/holiday-call?' + params);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error || `Failed to load holidays (${res.status})`);
        setData(EMPTY);
        return;
      }
      setData(await res.json());
    } finally {
      setLoading(false);
    }
  }, [orgId, siteId, year]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!orgId) return;
    (async () => {
      const res = await fetch(`/api/scheduling/providers?org_id=${orgId}&status=active&provider_type=physician`);
      if (!res.ok) return;
      const rows = await res.json();
      setProviders((rows as Array<Record<string, string>>).map(p => ({
        id: p.id,
        label: p.short_display_name || [p.first_name, p.last_name].filter(Boolean).join(' ') || '—',
      })));
    })();
  }, [orgId]);

  // date|code -> entry, and provider|date -> conflict label, for O(1) cell reads.
  const entryByCell = useMemo(() => {
    const m = new Map<string, Entry>();
    for (const e of data.entries) m.set(`${e.date}|${e.code}`, e);
    return m;
  }, [data.entries]);

  const conflictByProviderDate = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of data.conflicts) m.set(`${c.provider_id}|${c.date}`, c.label);
    return m;
  }, [data.conflicts]);

  const setCell = async (date: string, code: string, providerId: string, holidayName: string) => {
    setError(null);
    const res = await fetch('/api/scheduling/holiday-call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        site_id: siteId || null,
        provider_id: providerId || null,
        date,
        code,
        holiday_name: holidayName,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error || `Failed to save (${res.status})`);
    }
    await load();
  };

  const fmtDay = (d: string) =>
    new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const fmtShort = (d: string) =>
    new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  if (!orgId) return null;

  return (
    <Card style={{ marginTop: 20, maxWidth: 720 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <div style={headingStyle}>Holiday Call</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button onClick={() => setYear(y => y - 1)} style={yearBtn} aria-label="Previous year">&larr;</button>
          <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--text)', minWidth: 38, textAlign: 'center' }}>{year}</span>
          <button onClick={() => setYear(y => y + 1)} style={yearBtn} aria-label="Next year">&rarr;</button>
        </div>
        <div style={{ flex: 1 }} />
        {sites.length > 0 && (
          <select value={siteId} onChange={e => setSiteId(e.target.value)} style={smallSelectStyle}>
            {sites.map(s => (
              <option key={s.id} value={s.id}>{s.short_name || s.name}</option>
            ))}
          </select>
        )}
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginBottom: 12, lineHeight: 1.5 }}>
        Who covers call on each federal holiday. Open a holiday to staff every day it
        covers — a holiday takes in the weekend it touches, and Thanksgiving its Friday,
        so Christmas on a Friday is three days to fill. Each pick is saved to that
        provider’s availability profile under <b>Holiday Call</b>, and is written in as a
        locked assignment when a schedule covering the date is created.
      </div>

      {error && <div style={errorStyle}>{error}</div>}

      {loading ? (
        <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>Loading…</div>
      ) : data.holidays.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--text-dim)', fontStyle: 'italic' }}>
          No holidays on the calendar for {year}. Add them under Settings → Holidays.
        </div>
      ) : (
        <div>
          {data.holidays.map(h => {
            const filled = h.dates.reduce(
              (n, d) => n + HOLIDAY_CALL_CODES.filter(c => entryByCell.has(`${d}|${c.code}`)).length, 0);
            const clashes = h.dates.reduce((n, d) => {
              return n + HOLIDAY_CALL_CODES.filter(c => {
                const e = entryByCell.get(`${d}|${c.code}`);
                return e && conflictByProviderDate.has(`${e.provider_id}|${d}`);
              }).length;
            }, 0);
            return (
              <button key={h.id} onClick={() => setOpenHoliday(h)} style={rowStyle}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <span style={{ fontWeight: 700, color: 'var(--text-strong)', fontSize: 13 }}>
                    {h.holiday_name}
                  </span>
                  {h.is_major_holiday && <Badge tone="warn">Major</Badge>}
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                  {clashes > 0 && (
                    <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--danger)' }}>
                      {clashes} conflict{clashes === 1 ? '' : 's'}
                    </span>
                  )}
                  <span style={{ fontSize: 11.5, color: filled > 0 ? 'var(--text)' : 'var(--text-dim)' }}>
                    {filled > 0 ? `${filled} assigned` : 'unstaffed'}
                  </span>
                  <span style={{ fontSize: 11.5, color: 'var(--text-dim)', fontFamily: 'var(--font-mono), ui-monospace, monospace' }}>
                    {h.dates.length === 1
                      ? fmtShort(h.dates[0])
                      : `${fmtShort(h.dates[0])} – ${fmtShort(h.dates[h.dates.length - 1])}`}
                  </span>
                  <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>›</span>
                </span>
              </button>
            );
          })}
        </div>
      )}

      {openHoliday && (
        <Modal
          open
          onClose={() => setOpenHoliday(null)}
          title={`${openHoliday.holiday_name} — Holiday Call`}
          width={720}
          footer={<Button variant="secondary" onClick={() => setOpenHoliday(null)}>Done</Button>}
        >
          <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginBottom: 12, lineHeight: 1.5 }}>
            One provider per code per day. A provider can hold only one code on a given
            day. Clearing a cell removes the entry from their profile.
          </div>
          {error && <div style={errorStyle}>{error}</div>}
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 560 }}>
              <thead>
                <tr>
                  <th style={{ ...thStyle, textAlign: 'left' }}>Day</th>
                  {HOLIDAY_CALL_CODES.map(c => (
                    <th key={c.code} style={thStyle} title={c.label}>{c.code}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {openHoliday.dates.map(d => (
                  <tr key={d}>
                    <td style={{ ...tdStyle, whiteSpace: 'nowrap', fontWeight: 700, color: 'var(--text)' }}>
                      {fmtDay(d)}
                      {d === openHoliday.holiday_date && (
                        <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--text-dim)', fontWeight: 600 }}>
                          holiday
                        </span>
                      )}
                    </td>
                    {HOLIDAY_CALL_CODES.map(c => {
                      const entry = entryByCell.get(`${d}|${c.code}`);
                      const clash = entry ? conflictByProviderDate.get(`${entry.provider_id}|${d}`) : undefined;
                      return (
                        <td key={c.code} style={tdStyle}>
                          <select
                            value={entry?.provider_id ?? ''}
                            onChange={e => setCell(d, c.code, e.target.value, openHoliday.holiday_name)}
                            style={{
                              ...cellSelectStyle,
                              borderColor: clash ? 'var(--danger)' : 'var(--border)',
                            }}
                            title={clash ? `Conflict — ${clash} on this date` : c.label}
                          >
                            <option value="">—</option>
                            {providers.map(p => (
                              <option key={p.id} value={p.id}>{p.label}</option>
                            ))}
                          </select>
                          {clash && (
                            <div style={{ fontSize: 10, color: 'var(--danger)', marginTop: 2, fontWeight: 700 }}>
                              {clash}
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
        </Modal>
      )}
    </Card>
  );
}

const headingStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase',
  color: 'var(--text-muted)', fontFamily: 'var(--font-mono), ui-monospace, monospace',
};
const yearBtn: React.CSSProperties = {
  background: 'none', border: '1px solid var(--border)', borderRadius: 5,
  color: 'var(--text-dim)', fontSize: 12, padding: '1px 7px', cursor: 'pointer', lineHeight: 1.6,
};
const smallSelectStyle: React.CSSProperties = {
  padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border)',
  background: 'var(--bg-deep)', color: 'var(--text)', fontSize: 12, cursor: 'pointer',
};
const rowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
  width: '100%', textAlign: 'left', padding: '8px 10px', marginBottom: 5,
  background: 'var(--bg-deep)', border: '1px solid var(--border-faint)',
  borderRadius: 6, cursor: 'pointer', color: 'inherit',
};
const errorStyle: React.CSSProperties = {
  color: 'var(--danger)', fontSize: 12, marginBottom: 10,
  padding: '6px 10px', background: 'var(--danger-bg)',
  border: '1px solid rgba(220,38,38,0.25)', borderRadius: 6,
};
const thStyle: React.CSSProperties = {
  fontSize: 10, fontWeight: 800, letterSpacing: 0.5, textTransform: 'uppercase',
  color: 'var(--text-muted)', padding: '4px 6px', borderBottom: '1px solid var(--border-faint)',
};
const tdStyle: React.CSSProperties = {
  padding: '5px 6px', verticalAlign: 'top',
};
const cellSelectStyle: React.CSSProperties = {
  width: '100%', minWidth: 110, padding: '5px 6px', borderRadius: 6,
  border: '1px solid var(--border)', background: 'var(--bg-deep)',
  color: 'var(--text)', fontSize: 12, cursor: 'pointer',
};
