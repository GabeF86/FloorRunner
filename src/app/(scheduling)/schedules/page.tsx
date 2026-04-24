'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';

interface Schedule {
  id: string;
  organization_id: string;
  site_id: string | null;
  schedule_name: string;
  schedule_type: string;
  provider_group: string;
  date_start: string;
  date_end: string;
  status: string;
  current_version_number: number;
  sites: { name: string; short_name: string | null } | null;
}

interface Site {
  id: string;
  name: string;
  short_name: string | null;
}

const STATUS_COLORS: Record<string, { color: string; bg: string; label: string }> = {
  draft:     { color: '#64748b', bg: 'rgba(100,116,139,0.15)', label: 'Draft' },
  review:    { color: '#fbbf24', bg: 'rgba(251,191,36,0.15)', label: 'Review' },
  published: { color: '#10b981', bg: 'rgba(16,185,129,0.15)', label: 'Published' },
  revised:   { color: '#fb923c', bg: 'rgba(251,146,60,0.15)', label: 'Revised' },
  archived:  { color: '#334155', bg: 'rgba(51,65,85,0.25)', label: 'Archived' },
};

const TYPE_COLORS: Record<string, { color: string; bg: string; label: string }> = {
  combined: { color: '#8b5cf6', bg: 'rgba(139,92,246,0.15)', label: 'Combined' },
  call:     { color: '#f87171', bg: 'rgba(248,113,113,0.15)', label: 'Call' },
  shifts:   { color: '#0ea5e9', bg: 'rgba(14,165,233,0.15)', label: 'Shifts' },
};

const GROUP_OPTIONS: { value: string; label: string }[] = [
  { value: 'physician', label: 'Physicians' },
  { value: 'crna', label: 'CRNAs' },
  { value: 'both', label: 'Both' },
];

export default function SchedulesPage() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [orgId, setOrgId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [siteFilter, setSiteFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [groupFilter, setGroupFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [showCreate, setShowCreate] = useState(false);

  // Load org
  useEffect(() => {
    (async () => {
      const orgRes = await fetch('/api/scheduling/organizations');
      const orgs = await orgRes.json();
      if (orgs.length > 0) {
        setOrgId(orgs[0].id);
      }
      setLoading(false);
    })();
  }, []);

  const loadSchedules = useCallback(async () => {
    if (!orgId) return;
    const params = new URLSearchParams({ org_id: orgId });
    if (siteFilter) params.set('site_id', siteFilter);
    if (typeFilter) params.set('schedule_type', typeFilter);
    if (groupFilter) params.set('provider_group', groupFilter);
    if (statusFilter) params.set('status', statusFilter);
    const res = await fetch('/api/scheduling/schedules?' + params);
    setSchedules(await res.json());
  }, [orgId, siteFilter, typeFilter, groupFilter, statusFilter]);

  const loadSites = useCallback(async () => {
    if (!orgId) return;
    const res = await fetch('/api/scheduling/sites?org_id=' + orgId);
    setSites(await res.json());
  }, [orgId]);

  useEffect(() => { loadSchedules(); }, [loadSchedules]);
  useEffect(() => { loadSites(); }, [loadSites]);

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Permanently delete "${name}"? This cannot be undone — all versions, slots, and assignments will be removed.`)) return;
    await fetch(`/api/scheduling/schedules/${id}`, { method: 'DELETE' });
    loadSchedules();
  };

  const handleArchive = async (id: string, name: string) => {
    if (!confirm(`Archive "${name}"? It will be hidden from the active list but kept in the database.`)) return;
    await fetch(`/api/scheduling/schedules/${id}?archive=true`, { method: 'DELETE' });
    loadSchedules();
  };

  const formatDate = (d: string) => {
    const date = new Date(d + 'T12:00:00');
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  if (loading) return <div style={{ padding: 40, color: 'var(--text-muted)' }}>Loading...</div>;

  if (!orgId) {
    return (
      <div style={{ padding: 40, maxWidth: 460 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)', marginBottom: 8 }}>Schedules</h1>
        <p style={{ fontSize: 14, color: 'var(--text-muted)' }}>No organization found. Please set up your organization first.</p>
      </div>
    );
  }

  return (
    <div style={{ padding: '24px 32px' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)' }}>Schedules</h1>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>{schedules.length} schedule{schedules.length !== 1 ? 's' : ''}</p>
        </div>
        <button onClick={() => setShowCreate(true)} style={{
          padding: '10px 20px', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 13,
          background: 'linear-gradient(135deg,#0ea5e9,#6366f1)', color: '#fff', border: 'none',
        }}>+ Create Schedule</button>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
        <select value={siteFilter} onChange={(e) => setSiteFilter(e.target.value)} style={selectStyle}>
          <option value="">All Sites</option>
          {sites.map(s => (
            <option key={s.id} value={s.id}>{s.short_name || s.name}</option>
          ))}
        </select>
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} style={selectStyle}>
          <option value="">All Types</option>
          <option value="combined">Combined</option>
          <option value="call">Call</option>
          <option value="shifts">Shifts</option>
        </select>
        <select value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)} style={selectStyle}>
          <option value="">All Provider Groups</option>
          {GROUP_OPTIONS.map(g => (
            <option key={g.value} value={g.value}>{g.label}</option>
          ))}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={selectStyle}>
          <option value="">All Statuses</option>
          {Object.entries(STATUS_COLORS).map(([s, c]) => (
            <option key={s} value={s}>{c.label}</option>
          ))}
        </select>
      </div>

      {/* Table */}
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)', background: 'rgba(14,165,233,0.04)' }}>
              {['Schedule Name', 'Site', 'Type', 'Provider Group', 'Date Range', 'Status', 'Actions'].map(h => (
                <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: 10, fontWeight: 800, color: 'var(--text-dim)', letterSpacing: 1, textTransform: 'uppercase' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {schedules.map((s) => {
              const sc = STATUS_COLORS[s.status] || STATUS_COLORS.draft;
              const tc = TYPE_COLORS[s.schedule_type] || TYPE_COLORS.shifts;
              const groupLabel = GROUP_OPTIONS.find(g => g.value === s.provider_group)?.label || s.provider_group;
              return (
                <tr key={s.id} style={{ borderBottom: '1px solid rgba(30,58,95,0.4)', cursor: 'pointer' }}>
                  <td style={{ padding: '10px 14px' }}>
                    <Link href={`/schedules/${s.id}`} style={{ textDecoration: 'none', color: 'var(--text)', fontWeight: 700 }}>
                      {s.schedule_name}
                    </Link>
                  </td>
                  <td style={{ padding: '10px 14px', fontSize: 12, color: 'var(--text-muted)' }}>
                    {s.sites?.short_name || s.sites?.name || '—'}
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    <span style={{
                      fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 6,
                      background: tc.bg, color: tc.color,
                    }}>{tc.label}</span>
                  </td>
                  <td style={{ padding: '10px 14px', fontSize: 12, color: 'var(--text-muted)', textTransform: 'capitalize' }}>
                    {groupLabel}
                  </td>
                  <td style={{ padding: '10px 14px', fontSize: 12, color: 'var(--text-muted)' }}>
                    {formatDate(s.date_start)} — {formatDate(s.date_end)}
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    <span style={{
                      fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 6,
                      background: sc.bg, color: sc.color,
                    }}>{sc.label}</span>
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <Link href={`/schedules/${s.id}`} style={{
                        fontSize: 11, fontWeight: 700, color: '#0ea5e9', textDecoration: 'none',
                      }}>Open</Link>
                      {s.status !== 'archived' && (
                        <button onClick={(e) => { e.stopPropagation(); handleArchive(s.id, s.schedule_name); }} style={{
                          fontSize: 11, fontWeight: 600, color: '#94a3b8', background: 'none',
                          border: 'none', cursor: 'pointer', padding: 0,
                        }}>Archive</button>
                      )}
                      <button onClick={(e) => { e.stopPropagation(); handleDelete(s.id, s.schedule_name); }} style={{
                        fontSize: 11, fontWeight: 600, color: '#f87171', background: 'none',
                        border: 'none', cursor: 'pointer', padding: 0,
                      }}>Delete</button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {schedules.length === 0 && (
              <tr><td colSpan={7} style={{ padding: '40px 14px', textAlign: 'center', color: 'var(--text-dim)', fontStyle: 'italic' }}>No schedules found. Create one to get started.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {showCreate && <CreateScheduleModal orgId={orgId} sites={sites} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); loadSchedules(); }} />}
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)',
  background: 'var(--bg-deep)', color: 'var(--text)', fontSize: 13, cursor: 'pointer',
};

// ── Create Schedule Modal ────────────────────────────────────────────────────
function CreateScheduleModal({ orgId, sites, onClose, onCreated }: { orgId: string; sites: Site[]; onClose: () => void; onCreated: () => void }) {
  const [siteId, setSiteId] = useState('');
  const [providerGroup, setProviderGroup] = useState('both');
  const [dateStart, setDateStart] = useState('');
  const [dateEnd, setDateEnd] = useState('');
  const [saving, setSaving] = useState(false);

  // Snap end date from a week count. Blocks in anesthesia are usually talked
  // about in whole weeks (e.g. "11-week block", "12-week rotation"). The
  // user can still edit End Date manually if they want something custom.
  const applyWeeks = (weeks: number) => {
    if (!dateStart) return;
    const d = new Date(dateStart + 'T00:00:00Z');
    // weeks × 7 - 1 so an 11-week block starting Monday ends on the Sunday
    // after 11 full weeks (not the start of the 12th week).
    d.setUTCDate(d.getUTCDate() + weeks * 7 - 1);
    setDateEnd(d.toISOString().slice(0, 10));
  };

  const submit = async () => {
    if (!siteId || !dateStart || !dateEnd) return;
    setSaving(true);
    const res = await fetch('/api/scheduling/schedules', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        organization_id: orgId,
        site_id: siteId,
        schedule_type: 'combined',
        provider_group: providerGroup,
        date_start: dateStart,
        date_end: dateEnd,
      }),
    });
    const data = await res.json();
    if (data.id) {
      window.location.href = `/schedules/${data.id}`;
    } else {
      setSaving(false);
      onCreated();
    }
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '10px 12px', borderRadius: 8,
    border: '1px solid var(--border)', background: 'var(--bg-deep)',
    color: 'var(--text)', fontSize: 14, marginBottom: 12,
  };
  const labelStyle: React.CSSProperties = { fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 5, fontWeight: 600, letterSpacing: 0.5 };

  const groupOptions = [
    { value: 'physician', label: 'Physicians', color: '#f59e0b' },
    { value: 'crna', label: 'CRNAs', color: '#0ea5e9' },
    { value: 'both', label: 'Both', color: '#8b5cf6' },
  ];

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }} onClick={onClose}>
      <div className="modal-box" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 16, padding: 28, width: 480, maxHeight: '85vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: 17, fontWeight: 800, color: '#f1f5f9', marginBottom: 22 }}>Create Schedule</div>

        <label style={labelStyle}>Site *</label>
        <select value={siteId} onChange={e => setSiteId(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
          <option value="">— Select Site —</option>
          {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>

        <label style={labelStyle}>Provider Group *</label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 14 }}>
          {groupOptions.map(g => (
            <button key={g.value} onClick={() => setProviderGroup(g.value)} style={{
              padding: '9px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 700,
              border: `1px solid ${providerGroup === g.value ? g.color : 'var(--border)'}`,
              background: providerGroup === g.value ? `${g.color}20` : 'transparent',
              color: providerGroup === g.value ? g.color : 'var(--text-muted)',
            }}>{g.label}</button>
          ))}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 8 }}>
          <div>
            <label style={labelStyle}>Start Date *</label>
            <input type="date" style={inputStyle} value={dateStart} onChange={e => setDateStart(e.target.value)} />
          </div>
          <div>
            <label style={labelStyle}>End Date *</label>
            <input type="date" style={inputStyle} value={dateEnd} onChange={e => setDateEnd(e.target.value)} />
          </div>
        </div>

        <label style={labelStyle}>Quick Block Length</label>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
          {[4, 6, 8, 11, 12, 13, 16].map(n => (
            <button
              key={n}
              type="button"
              onClick={() => applyWeeks(n)}
              disabled={!dateStart}
              title={!dateStart ? 'Pick a start date first' : `Set end date to ${n} weeks after start`}
              style={{
                padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 700,
                cursor: dateStart ? 'pointer' : 'not-allowed',
                background: 'var(--bg-deep)', color: 'var(--text-muted)',
                border: '1px solid var(--border)',
                opacity: dateStart ? 1 : 0.5,
              }}
            >
              {n} weeks
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button onClick={onClose} style={{ padding: '9px 18px', borderRadius: 8, cursor: 'pointer', background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border)', fontWeight: 600, fontSize: 13 }}>Cancel</button>
          <button onClick={submit} disabled={saving || !siteId || !dateStart || !dateEnd} style={{
            padding: '9px 20px', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 13,
            background: 'linear-gradient(135deg,#0ea5e9,#6366f1)', color: '#fff', border: 'none', opacity: (saving || !siteId || !dateStart || !dateEnd) ? 0.5 : 1,
          }}>{saving ? 'Creating...' : 'Create Schedule'}</button>
        </div>
      </div>
    </div>
  );
}
