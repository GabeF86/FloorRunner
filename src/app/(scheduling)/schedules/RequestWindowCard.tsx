'use client';

// Request-window management (patch29). Lives on the SCHEDULES list page —
// not site settings — because opening a window is a scheduling-workflow act
// tied to a block Gabriel is about to build (block dates mirror the schedule
// he'll create next), and this page already has the org's sites loaded.
// Site settings holds durable configuration; a window is an operational
// object he opens/closes around each generation cycle. Deliberately
// decoupled from schedule creation (v1): creating a schedule overlapping an
// open window prompts nothing.
import { useState, useEffect, useCallback } from 'react';
import { Card, Button, Badge } from '@/components/ui';

interface Site {
  id: string;
  name: string;
  short_name: string | null;
}

interface RequestWindow {
  id: string;
  site_id: string;
  block_start: string;
  block_end: string;
  max_no_call_requests: number;
  token: string;
  status: 'open' | 'closed';
  opened_at: string;
  closed_at: string | null;
}

export default function RequestWindowCard({ sites, initialSiteId }: {
  sites: Site[];
  initialSiteId?: string;
}) {
  const [siteId, setSiteId] = useState(initialSiteId || sites[0]?.id || '');
  const [windows, setWindows] = useState<RequestWindow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Open form state
  const [blockStart, setBlockStart] = useState('');
  const [blockEnd, setBlockEnd] = useState('');
  const [maxNoCall, setMaxNoCall] = useState('3');
  const [busy, setBusy] = useState(false);

  // Keep site in sync when the page-level site filter changes.
  useEffect(() => {
    if (initialSiteId) setSiteId(initialSiteId);
  }, [initialSiteId]);

  const load = useCallback(async () => {
    if (!siteId) { setWindows([]); setLoading(false); return; }
    setLoading(true);
    try {
      const res = await fetch(`/api/scheduling/request-windows?site_id=${siteId}`);
      setWindows(res.ok ? await res.json() : []);
    } finally {
      setLoading(false);
    }
  }, [siteId]);

  useEffect(() => { load(); }, [load]);

  const openWindow = async () => {
    if (!blockStart || !blockEnd) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch('/api/scheduling/request-windows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          site_id: siteId,
          block_start: blockStart,
          block_end: blockEnd,
          max_no_call_requests: parseInt(maxNoCall, 10) || 3,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || `Failed (${res.status})`); return; }
      setBlockStart(''); setBlockEnd(''); setMaxNoCall('3');
      await load();
    } finally {
      setBusy(false);
    }
  };

  const closeWindow = async (id: string) => {
    if (!confirm('Close this request window? The shared link will stop accepting submissions.')) return;
    await fetch(`/api/scheduling/request-windows/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'closed' }),
    });
    await load();
  };

  const fmt = (d: string) =>
    new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  const open = windows.find(w => w.status === 'open') || null;
  const recentClosed = windows.filter(w => w.status === 'closed').slice(0, 3);
  const link = open && typeof window !== 'undefined'
    ? `${window.location.origin}/requests/submit/${open.token}`
    : '';

  const copyLink = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be denied — the input is selectable as a fallback.
    }
  };

  if (sites.length === 0) return null;

  return (
    <Card style={{ marginTop: 20, maxWidth: 720 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <div style={{
          fontSize: 11, fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase',
          color: 'var(--text-muted)', fontFamily: 'var(--font-mono), ui-monospace, monospace',
        }}>
          Request Window
        </div>
        {open && <Badge tone="ok">Open</Badge>}
        <div style={{ flex: 1 }} />
        <select value={siteId} onChange={e => setSiteId(e.target.value)} style={smallSelectStyle}>
          {sites.map(s => (
            <option key={s.id} value={s.id}>{s.short_name || s.name}</option>
          ))}
        </select>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginBottom: 12, lineHeight: 1.5 }}>
        One shared link per site where providers submit PTO, days off, and up to N
        no-call dates for the next block. PTO / days-off land in the Requests queue;
        no-call dates go straight to the engine.
      </div>

      {error && (
        <div style={{
          color: 'var(--danger)', fontSize: 12, marginBottom: 10,
          padding: '6px 10px', background: 'var(--danger-bg)',
          border: '1px solid rgba(220,38,38,0.25)', borderRadius: 6,
        }}>{error}</div>
      )}

      {loading ? (
        <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>Loading…</div>
      ) : open ? (
        <div>
          <div style={{ fontSize: 13, color: 'var(--text)', marginBottom: 8 }}>
            Block <b>{fmt(open.block_start)} – {fmt(open.block_end)}</b>
            <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>
              {' '}· max {open.max_no_call_requests} no-call date{open.max_no_call_requests === 1 ? '' : 's'} per provider
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              readOnly
              value={link}
              onFocus={e => e.currentTarget.select()}
              style={{
                flex: 1, padding: '7px 10px', borderRadius: 6,
                border: '1px solid var(--border)', background: 'var(--bg-deep)',
                color: 'var(--text-muted)', fontSize: 12,
                fontFamily: 'var(--font-mono), ui-monospace, monospace',
              }}
            />
            <Button size="sm" variant="secondary" onClick={copyLink}>
              {copied ? 'Copied ✓' : 'Copy Link'}
            </Button>
            <Button size="sm" variant="ghost" style={{ color: 'var(--danger)' }} onClick={() => closeWindow(open.id)}>
              Close Window
            </Button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div>
            <label style={smallLabelStyle}>Block start</label>
            <input type="date" value={blockStart} onChange={e => {
              setBlockStart(e.target.value);
              if (!blockEnd || e.target.value > blockEnd) setBlockEnd(e.target.value);
            }} style={smallInputStyle} />
          </div>
          <div>
            <label style={smallLabelStyle}>Block end</label>
            <input type="date" value={blockEnd} min={blockStart} onChange={e => setBlockEnd(e.target.value)} style={smallInputStyle} />
          </div>
          <div>
            <label style={smallLabelStyle}>Max no-call</label>
            <select value={maxNoCall} onChange={e => setMaxNoCall(e.target.value)} style={{ ...smallInputStyle, width: 76 }}>
              {[0, 1, 2, 3, 4, 5, 6].map(n => <option key={n} value={String(n)}>{n}</option>)}
            </select>
          </div>
          <Button size="sm" onClick={openWindow} disabled={busy || !blockStart || !blockEnd}>
            {busy ? 'Opening…' : 'Open Window'}
          </Button>
        </div>
      )}

      {recentClosed.length > 0 && (
        <div style={{ marginTop: 12, borderTop: '1px solid var(--border-faint)', paddingTop: 8 }}>
          {recentClosed.map(w => (
            <div key={w.id} style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 2 }}>
              Closed · {fmt(w.block_start)} – {fmt(w.block_end)}
              {w.closed_at && ` (closed ${new Date(w.closed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})`}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

const smallSelectStyle: React.CSSProperties = {
  padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border)',
  background: 'var(--bg-deep)', color: 'var(--text)', fontSize: 12, cursor: 'pointer',
};
const smallLabelStyle: React.CSSProperties = {
  fontSize: 10, color: 'var(--text-muted)', display: 'block',
  marginBottom: 3, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase',
};
const smallInputStyle: React.CSSProperties = {
  padding: '6px 9px', borderRadius: 6, border: '1px solid var(--border)',
  background: 'var(--bg-deep)', color: 'var(--text)', fontSize: 12,
};
