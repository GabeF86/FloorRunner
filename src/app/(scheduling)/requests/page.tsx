'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';

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

const STATUS_INFO: Record<string, { label: string; color: string; bg: string }> = {
  pending: { label: 'Pending', color: '#fbbf24', bg: 'rgba(251,191,36,0.12)' },
  approved: { label: 'Approved', color: '#10b981', bg: 'rgba(16,185,129,0.12)' },
  denied: { label: 'Denied', color: '#f87171', bg: 'rgba(248,113,113,0.12)' },
  waitlisted: { label: 'Waitlisted', color: '#8b5cf6', bg: 'rgba(139,92,246,0.12)' },
  canceled: { label: 'Canceled', color: '#64748b', bg: 'rgba(100,116,139,0.12)' },
};

const TYPE_COLORS: Record<string, { color: string; bg: string }> = {
  physician: { color: '#f59e0b', bg: 'rgba(245,158,11,0.15)' },
  crna: { color: '#0ea5e9', bg: 'rgba(14,165,233,0.15)' },
  aa: { color: '#8b5cf6', bg: 'rgba(139,92,246,0.15)' },
};

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

  if (loading) return <div style={{ padding: 40, color: 'var(--text-muted)' }}>Loading...</div>;

  return (
    <div style={{ padding: '24px 32px' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)' }}>Requests</h1>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>
            {requests.length} request{requests.length !== 1 ? 's' : ''}
          </p>
        </div>
      </div>

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
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)', background: 'rgba(14,165,233,0.04)' }}>
              {['Provider', 'Type', 'Dates', 'Notes', 'Submitted', 'Status', 'Actions'].map(h => (
                <th key={h} style={{
                  padding: '10px 14px', textAlign: 'left', fontSize: 10, fontWeight: 800,
                  color: 'var(--text-dim)', letterSpacing: 1, textTransform: 'uppercase',
                }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {requests.map(r => {
              const rt = REQUEST_TYPES[r.request_type] || { label: r.request_type, color: '#64748b' };
              const si = STATUS_INFO[r.status] || STATUS_INFO.pending;
              const prov = r.providers;
              const tc = TYPE_COLORS[prov?.provider_type || ''] || { color: '#94a3b8', bg: 'rgba(148,163,184,0.15)' };
              const sameDay = r.start_date === r.end_date;
              const isExpanded = actionId === r.id;

              return (
                <tr key={r.id} style={{ borderBottom: '1px solid rgba(30,58,95,0.4)' }}>
                  <td style={{ padding: '10px 14px' }}>
                    {prov ? (
                      <Link href={`/providers/${prov.id}`} style={{ display: 'flex', alignItems: 'center', gap: 8, textDecoration: 'none', color: 'var(--text)' }}>
                        <div style={{
                          width: 28, height: 28, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 10, fontWeight: 800, background: tc.bg, color: tc.color, flexShrink: 0,
                        }}>{prov.initials}</div>
                        <span style={{ fontWeight: 600 }}>{prov.short_display_name}</span>
                      </Link>
                    ) : (
                      <span style={{ color: 'var(--text-dim)' }}>Unknown</span>
                    )}
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    <span style={{
                      fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 6,
                      background: `${rt.color}20`, color: rt.color,
                    }}>{rt.label}</span>
                  </td>
                  <td style={{ padding: '10px 14px', fontSize: 12, color: 'var(--text-muted)' }}>
                    {formatDate(r.start_date)}{!sameDay && ` — ${formatDate(r.end_date)}`}
                    {r.part_of_day && <span style={{ fontSize: 10, marginLeft: 4 }}>({r.part_of_day})</span>}
                  </td>
                  <td style={{ padding: '10px 14px', fontSize: 12, color: 'var(--text-dim)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.notes || '—'}
                  </td>
                  <td style={{ padding: '10px 14px', fontSize: 11, color: 'var(--text-dim)' }}>
                    {formatDateTime(r.submitted_at)}
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    <span style={{
                      fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 6,
                      background: si.bg, color: si.color, textTransform: 'capitalize',
                    }}>{si.label}</span>
                    {r.decision_reason && (
                      <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 2 }}>
                        {r.decision_reason}
                      </div>
                    )}
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    {r.status === 'pending' ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
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
                              <button onClick={() => handleAction(r.id, 'approved')} style={actionBtn('#10b981')}>Approve</button>
                              <button onClick={() => handleAction(r.id, 'denied')} style={actionBtn('#f87171')}>Deny</button>
                              <button onClick={() => handleAction(r.id, 'waitlisted')} style={actionBtn('#8b5cf6')}>Wait</button>
                              <button onClick={() => { setActionId(null); setDecisionReason(''); }} style={actionBtn('#64748b')}>X</button>
                            </div>
                          </>
                        ) : (
                          <button onClick={() => setActionId(r.id)} style={{
                            fontSize: 11, fontWeight: 600, color: '#0ea5e9', background: 'none',
                            border: 'none', cursor: 'pointer', padding: 0,
                          }}>Review</button>
                        )}
                      </div>
                    ) : (
                      <button onClick={() => handleDelete(r.id)} style={{
                        fontSize: 11, color: '#f87171', background: 'none', border: 'none',
                        cursor: 'pointer', padding: 0,
                      }}>Delete</button>
                    )}
                  </td>
                </tr>
              );
            })}
            {requests.length === 0 && (
              <tr>
                <td colSpan={7} style={{
                  padding: '40px 14px', textAlign: 'center', color: 'var(--text-dim)', fontStyle: 'italic',
                }}>
                  No requests found{statusFilter ? ` with status "${STATUS_INFO[statusFilter]?.label || statusFilter}"` : ''}.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)',
  background: 'var(--bg-deep)', color: 'var(--text)', fontSize: 13, cursor: 'pointer',
};

function actionBtn(color: string): React.CSSProperties {
  return {
    fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 4,
    background: `${color}15`, color, border: `1px solid ${color}40`,
    cursor: 'pointer',
  };
}
