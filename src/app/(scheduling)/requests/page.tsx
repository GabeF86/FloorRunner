'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { PageHeader, Card, Badge, Button, Table, EmptyState, type BadgeTone } from '@/components/ui';

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

const REQUEST_TYPES: Record<string, { label: string; color: string }> = {
  pto: { label: 'PTO', color: '#10b981' },
  no_call: { label: 'No-Call', color: '#fbbf24' },
  extra_call: { label: 'Extra Call', color: '#0ea5e9' },
  preferred_weekend: { label: 'Preferred Weekend', color: '#8b5cf6' },
  swap_request: { label: 'Swap', color: '#fb923c' },
  availability_change: { label: 'Availability Change', color: '#64748b' },
};

const STATUS_INFO: Record<string, { label: string; tone: BadgeTone }> = {
  pending: { label: 'Pending', tone: 'warn' },
  approved: { label: 'Approved', tone: 'ok' },
  denied: { label: 'Denied', tone: 'danger' },
  waitlisted: { label: 'Waitlisted', tone: 'info' },
  canceled: { label: 'Canceled', tone: 'neutral' },
};

const TYPE_COLORS: Record<string, { color: string; bg: string }> = {
  physician: { color: '#f59e0b', bg: 'rgba(245,158,11,0.15)' },
  crna: { color: '#0ea5e9', bg: 'rgba(14,165,233,0.15)' },
  aa: { color: '#8b5cf6', bg: 'rgba(139,92,246,0.15)' },
};

const TABLE_HEADERS = ['Provider', 'Type', 'Dates', 'Notes', 'Submitted', 'Status', 'Actions'];

export default function RequestsPage() {
  const [requests, setRequests] = useState<Request[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('pending');
  const [typeFilter, setTypeFilter] = useState('');
  const [actionId, setActionId] = useState<string | null>(null);
  const [decisionReason, setDecisionReason] = useState('');

  const loadRequests = useCallback(async () => {
    const params = new URLSearchParams();
    if (statusFilter) params.set('status', statusFilter);
    if (typeFilter) params.set('request_type', typeFilter);
    const res = await fetch('/api/scheduling/requests?' + params);
    if (res.ok) setRequests(await res.json());
    setLoading(false);
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
        subtitle={`${requests.length} request${requests.length !== 1 ? 's' : ''}`}
      />

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={selectStyle}>
          <option value="">All Statuses</option>
          {Object.entries(STATUS_INFO).map(([k, v]) => (
            <option key={k} value={k}>{v.label}</option>
          ))}
        </select>
        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)} style={selectStyle}>
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
            const rt = REQUEST_TYPES[r.request_type] || { label: r.request_type, color: '#64748b' };
            const si = STATUS_INFO[r.status] || STATUS_INFO.pending;
            const prov = r.providers;
            const tc = TYPE_COLORS[prov?.provider_type || ''] || { color: '#94a3b8', bg: 'rgba(148,163,184,0.15)' };
            const sameDay = r.start_date === r.end_date;
            const isExpanded = actionId === r.id;

            return [
              prov ? (
                <Link key="prov" href={`/providers/${prov.id}`} style={{ display: 'flex', alignItems: 'center', gap: 8, textDecoration: 'none', color: 'var(--text)' }}>
                  <div style={{
                    width: 28, height: 28, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 10, fontWeight: 800, background: tc.bg, color: tc.color, flexShrink: 0,
                  }}>{prov.initials}</div>
                  <span style={{ fontWeight: 600 }}>{prov.short_display_name}</span>
                </Link>
              ) : (
                <span key="prov" style={{ color: 'var(--text-dim)' }}>Unknown</span>
              ),
              <span key="type" style={{
                fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 6,
                background: `${rt.color}20`, color: rt.color, whiteSpace: 'nowrap',
              }}>{rt.label}</span>,
              <span key="dates">
                {formatDate(r.start_date)}{!sameDay && ` — ${formatDate(r.end_date)}`}
                {r.part_of_day && <span style={{ fontSize: 10, marginLeft: 4 }}>({r.part_of_day})</span>}
              </span>,
              <span key="notes" style={{
                display: 'block', color: 'var(--text-dim)', maxWidth: 200,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{r.notes || '—'}</span>,
              <span key="sub" style={{ fontSize: 11, color: 'var(--text-dim)' }}>{formatDateTime(r.submitted_at)}</span>,
              <span key="status">
                <Badge tone={si.tone}>{si.label}</Badge>
                {r.decision_reason && (
                  <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 2 }}>
                    {r.decision_reason}
                  </div>
                )}
              </span>,
              r.status === 'pending' ? (
                <div key="actions" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {isExpanded ? (
                    <>
                      <input
                        placeholder="Reason (optional)"
                        value={decisionReason}
                        onChange={e => setDecisionReason(e.target.value)}
                        style={{
                          padding: '4px 8px', fontSize: 11, borderRadius: 4,
                          border: '1px solid var(--border)', background: 'var(--bg-deep)',
                          color: 'var(--text)', width: 150,
                        }}
                      />
                      <div style={{ display: 'flex', gap: 4 }}>
                        <Button size="sm" variant="secondary" onClick={() => handleAction(r.id, 'approved')} style={{ color: 'var(--ok)', background: 'var(--ok-bg)', border: '1px solid transparent' }}>Approve</Button>
                        <Button size="sm" variant="danger" onClick={() => handleAction(r.id, 'denied')}>Deny</Button>
                        <Button size="sm" variant="secondary" onClick={() => handleAction(r.id, 'waitlisted')} style={{ color: 'var(--info)', background: 'var(--info-bg)', border: '1px solid transparent' }}>Wait</Button>
                        <Button size="sm" variant="ghost" onClick={() => { setActionId(null); setDecisionReason(''); }}>X</Button>
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
          empty={
            <EmptyState
              icon="✉"
              title={`No requests found${statusFilter ? ` with status "${STATUS_INFO[statusFilter]?.label || statusFilter}"` : ''}`}
              hint="PTO, no-call, and availability requests submitted by providers land here for review. Try clearing the status filter to see older decisions."
            />
          }
        />
      </Card>
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)',
  background: 'var(--bg-deep)', color: 'var(--text)', fontSize: 13, cursor: 'pointer',
};
