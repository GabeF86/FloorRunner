'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { PageHeader, Card, Badge, Button, Table, EmptyState, Banner, type BadgeTone } from '@/components/ui';

interface ProviderInfo {
  id: string;
  first_name: string;
  last_name: string;
  short_display_name: string;
  initials: string;
  provider_type: string;
}

interface Request {
  id: string;
  provider_id: string;
  site_id: string | null;
  request_type: string;
  start_date: string;
  end_date: string;
  part_of_day: string | null;
  notes: string | null;
  status: string;
  submitted_at: string;
  reviewed_at: string | null;
  decision_reason: string | null;
  providers: ProviderInfo | null;
}

/**
 * Request-type chip colours. These are categories, not statuses, so they carry
 * the meaning of the category rather than a hand-picked hue: leave/absence reads
 * as --ok, a restriction as --warn, volunteering for more call as the accent, and
 * an administrative change as neutral. Tokens rather than literals because the
 * old values were the DARK-mode ramp (the bright emerald/amber/sky trio) painted
 * on a light-default app, where the small chip label missed AA.
 */
const REQUEST_TYPES: Record<string, { label: string; fg: string; bg: string }> = {
  pto:                 { label: 'PTO',                 fg: 'var(--ok)',         bg: 'var(--ok-bg)' },
  no_call:             { label: 'No-Call',             fg: 'var(--warn)',       bg: 'var(--warn-bg)' },
  extra_call:          { label: 'Extra Call',          fg: 'var(--blue)',       bg: 'color-mix(in srgb, var(--blue) 12%, transparent)' },
  preferred_weekend:   { label: 'Preferred Weekend',   fg: 'var(--indigo)',     bg: 'color-mix(in srgb, var(--indigo) 12%, transparent)' },
  swap_request:        { label: 'Swap',                fg: 'var(--info)',       bg: 'var(--info-bg)' },
  availability_change: { label: 'Availability Change', fg: 'var(--text-muted)', bg: 'var(--tint-surface)' },
};

const UNKNOWN_TYPE = { fg: 'var(--text-muted)', bg: 'var(--tint-surface)' };

const STATUS_INFO: Record<string, { label: string; tone: BadgeTone }> = {
  pending: { label: 'Pending', tone: 'warn' },
  approved: { label: 'Approved', tone: 'ok' },
  denied: { label: 'Denied', tone: 'danger' },
  waitlisted: { label: 'Waitlisted', tone: 'info' },
  canceled: { label: 'Canceled', tone: 'neutral' },
};

/**
 * Provider-type swatch. providers/page.tsx and providers/[id]/page.tsx hold the
 * same rows verbatim (plus the four types that never reach this screen), and a
 * provider is recognised by this colour across all three — so the copies change
 * together or not at all. They were changed together: see the full note on the
 * map in providers/page.tsx.
 *
 * The literals these replace were dark-theme hexes on the light default, where
 * #f59e0b is ~2.2:1 on white and fails AA as 11px avatar ink.
 */
const TYPE_COLORS: Record<string, { color: string; bg: string }> = {
  physician: { color: 'var(--warn)',   bg: 'color-mix(in srgb, var(--warn) 15%, transparent)' },
  crna:      { color: 'var(--blue)',   bg: 'color-mix(in srgb, var(--blue) 15%, transparent)' },
  aa:        { color: 'var(--indigo)', bg: 'color-mix(in srgb, var(--indigo) 15%, transparent)' },
};

const TABLE_HEADERS = ['Provider', 'Type', 'Dates', 'Notes', 'Submitted', 'Status', 'Actions'];

export default function RequestsPage() {
  const [requests, setRequests] = useState<Request[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('pending');
  const [typeFilter, setTypeFilter] = useState('');
  const [actionId, setActionId] = useState<string | null>(null);
  const [decisionReason, setDecisionReason] = useState('');

  const loadRequests = useCallback(async () => {
    const params = new URLSearchParams();
    if (statusFilter) params.set('status', statusFilter);
    if (typeFilter) params.set('request_type', typeFilter);
    try {
      const res = await fetch('/api/scheduling/requests?' + params);
      // A 500 from Next can be an HTML error page, so the parse is guarded.
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const err = (body as { error?: unknown } | null)?.error;
        throw new Error(typeof err === 'string' && err ? err : `Could not load requests (${res.status})`);
      }
      // A malformed 200 (an object, not a list) assigned to array state makes
      // the next .map() throw and blanks the page, so shape is checked too.
      if (!Array.isArray(body)) throw new Error('The requests response was malformed.');
      setRequests(body as Request[]);
      setLoadError(null);
    } catch (e) {
      // A failed read must never render as "0 requests": an unreviewed PTO
      // request would look handled, and the queue is how they get answered.
      setRequests([]);
      setLoadError(e instanceof Error ? e.message : 'Network error loading requests');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, typeFilter]);

  useEffect(() => { loadRequests(); }, [loadRequests]);

  const handleAction = async (id: string, status: 'approved' | 'denied' | 'waitlisted') => {
    const res = await fetch(`/api/scheduling/requests/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, decision_reason: decisionReason || null }),
    });
    if (res.ok) {
      setActionId(null);
      setDecisionReason('');
      await loadRequests();
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this request?')) return;
    await fetch(`/api/scheduling/requests/${id}`, { method: 'DELETE' });
    await loadRequests();
  };

  const formatDate = (d: string) => {
    const date = new Date(d + 'T12:00:00');
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const formatDateTime = (d: string) => {
    return new Date(d).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  };

  if (loading) {
    return (
      <div>
        <PageHeader title="Requests" />
        <Card pad={false}>
          <Table headers={TABLE_HEADERS} rows={undefined} minWidth={760} />
        </Card>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Requests"
        subtitle={loadError
          ? 'Request count unknown — the queue could not be read'
          : `${requests.length} request${requests.length !== 1 ? 's' : ''}`}
      />

      {loadError && (
        <div style={{ marginBottom: 'var(--space-5)' }}>
          <Banner tone="error">{loadError} Reload the page to try again.</Banner>
        </div>
      )}

      {/* Filters */}
      <div style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: 'var(--space-5)', flexWrap: 'wrap' }}>
        <select className="fr-field" value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={selectStyle}>
          <option value="">All Statuses</option>
          {Object.entries(STATUS_INFO).map(([k, v]) => (
            <option key={k} value={k}>{v.label}</option>
          ))}
        </select>
        <select className="fr-field" value={typeFilter} onChange={e => setTypeFilter(e.target.value)} style={selectStyle}>
          <option value="">All Types</option>
          {Object.entries(REQUEST_TYPES).map(([k, v]) => (
            <option key={k} value={k}>{v.label}</option>
          ))}
        </select>
      </div>

      {/* Table */}
      <Card pad={false}>
        <Table
          headers={TABLE_HEADERS}
          minWidth={760}
          rows={requests.map(r => {
            const rt = REQUEST_TYPES[r.request_type] || { label: r.request_type, ...UNKNOWN_TYPE };
            const si = STATUS_INFO[r.status] || STATUS_INFO.pending;
            const prov = r.providers;
            // Fallback = TYPE_COLORS.other on the providers pages, kept
            // byte-identical for the same reason the map above is (see comment).
            const tc = TYPE_COLORS[prov?.provider_type || ''] || { color: 'var(--text-muted)', bg: 'color-mix(in srgb, var(--text-muted) 15%, transparent)' };
            const sameDay = r.start_date === r.end_date;
            const isExpanded = actionId === r.id;

            return [
              prov ? (
                <Link key="prov" className="fr-focus" href={`/providers/${prov.id}`} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)',
                  textDecoration: 'none', color: 'var(--text)',
                  borderRadius: 'var(--radius-sm)', outline: 'none',
                }}>
                  <div style={{
                    width: 28, height: 28, borderRadius: 'var(--radius-sm)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 'var(--fs-xs)', fontWeight: 700, background: tc.bg, color: tc.color, flexShrink: 0,
                  }}>{prov.initials}</div>
                  <span style={{ fontWeight: 600 }}>{prov.short_display_name}</span>
                </Link>
              ) : (
                <span key="prov" style={{ color: 'var(--text-dim)' }}>Unknown</span>
              ),
              <span key="type" style={{
                display: 'inline-block',
                fontSize: 'var(--fs-xs)', fontWeight: 600, padding: '3px 8px', borderRadius: 'var(--radius-sm)',
                background: rt.bg, color: rt.fg, whiteSpace: 'nowrap',
                // Same hairline trick as Badge: a flat tint with no edge washes
                // out against the surface, and it is derived from the tone so it
                // stays correct in both themes.
                border: `1px solid color-mix(in srgb, ${rt.fg} 22%, transparent)`,
              }}>{rt.label}</span>,
              <span key="dates" style={{ whiteSpace: 'nowrap' }}>
                {formatDate(r.start_date)}{!sameDay && ` — ${formatDate(r.end_date)}`}
                {r.part_of_day && <span style={{ fontSize: 'var(--fs-xs)', marginLeft: 'var(--space-1)', color: 'var(--text-dim)' }}>({r.part_of_day})</span>}
              </span>,
              <span key="notes" style={{
                display: 'block', color: 'var(--text-dim)', maxWidth: 200,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{r.notes || '—'}</span>,
              <span key="sub" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>{formatDateTime(r.submitted_at)}</span>,
              <span key="status">
                <Badge tone={si.tone}>{si.label}</Badge>
                {r.decision_reason && (
                  <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 'var(--space-1)', maxWidth: 180 }}>
                    {r.decision_reason}
                  </div>
                )}
              </span>,
              r.status === 'pending' ? (
                <div key="actions" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                  {isExpanded ? (
                    <>
                      <input
                        className="fr-field"
                        placeholder="Reason (optional)"
                        value={decisionReason}
                        onChange={e => setDecisionReason(e.target.value)}
                        style={{
                          padding: '4px 8px', fontSize: 'var(--fs-xs)', borderRadius: 'var(--radius-sm)',
                          border: '1px solid var(--border)', background: 'var(--bg-deep)',
                          color: 'var(--text)', width: 150, fontFamily: 'inherit',
                        }}
                      />
                      <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
                        {/* Tone lives in the label, not a fill: an inline background
                            would out-specify .fr-btn-secondary:hover (inline beats a
                            class rule), which is what left these two with no hover
                            state at all. Colour the ink, let the kit own the states. */}
                        <Button size="sm" variant="secondary" onClick={() => handleAction(r.id, 'approved')} style={{ color: 'var(--ok)' }}>Approve</Button>
                        <Button size="sm" variant="danger" onClick={() => handleAction(r.id, 'denied')}>Deny</Button>
                        <Button size="sm" variant="secondary" onClick={() => handleAction(r.id, 'waitlisted')} style={{ color: 'var(--info)' }}>Wait</Button>
                        <Button size="sm" variant="ghost" title="Cancel review" onClick={() => { setActionId(null); setDecisionReason(''); }}>✕</Button>
                      </div>
                    </>
                  ) : (
                    <div>
                      <Button size="sm" variant="ghost" style={{ color: 'var(--blue)' }} onClick={() => setActionId(r.id)}>Review</Button>
                    </div>
                  )}
                </div>
              ) : (
                <Button key="actions" size="sm" variant="ghost" style={{ color: 'var(--danger)' }} onClick={() => handleDelete(r.id)}>Delete</Button>
              ),
            ];
          })}
          empty={loadError ? (
            <EmptyState
              icon="⚠"
              title="Could not load the request queue"
              hint={`${loadError} This is NOT an empty queue — pending requests may be waiting.`}
            />
          ) : (
            <EmptyState
              icon="✉"
              title={`No requests found${statusFilter ? ` with status "${STATUS_INFO[statusFilter]?.label || statusFilter}"` : ''}`}
              hint="PTO, no-call, and availability requests submitted by providers land here for review. Try clearing the status filter to see older decisions."
            />
          )}
        />
      </Card>
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  padding: 'var(--space-2) var(--space-3)', borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--border)', background: 'var(--bg-deep)', color: 'var(--text)',
  fontSize: 'var(--fs-md)', fontFamily: 'inherit', cursor: 'pointer',
};
