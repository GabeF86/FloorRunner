'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';

interface Provider {
  id: string;
  first_name: string;
  last_name: string;
  short_display_name: string;
  initials: string;
  provider_type: string;
  status: string;
  email: string | null;
  provider_employment_profiles: {
    employment_status: string;
    fte_value: number;
    call_taker: boolean;
    partial_call_taker: boolean;
    home_site_id: string | null;
    weekend_call_eligible: boolean;
    holiday_call_eligible: boolean;
    fellowship_primary: string | null;
  }[] | null;
}

interface Site {
  id: string;
  name: string;
  short_name: string | null;
}

const TYPE_COLORS: Record<string, { color: string; bg: string; label: string }> = {
  physician: { color: '#f59e0b', bg: 'rgba(245,158,11,0.15)', label: 'Physician' },
  crna:      { color: '#0ea5e9', bg: 'rgba(14,165,233,0.15)', label: 'CRNA' },
  aa:        { color: '#8b5cf6', bg: 'rgba(139,92,246,0.15)', label: 'AA' },
  resident:  { color: '#34d399', bg: 'rgba(52,211,153,0.15)', label: 'Resident' },
  fellow:    { color: '#a78bfa', bg: 'rgba(167,139,250,0.15)', label: 'Fellow' },
  locums:    { color: '#fb923c', bg: 'rgba(251,146,60,0.15)', label: 'Locums' },
  other:     { color: '#94a3b8', bg: 'rgba(148,163,184,0.15)', label: 'Other' },
};

const EMPLOYMENT_OPTIONS = [
  { value: 'full_time', label: 'Full Time' },
  { value: 'part_time', label: 'Part Time' },
  { value: 'employed', label: 'Employed' },
  { value: 'per_diem', label: 'Per Diem' },
  { value: 'locums', label: 'Locums' },
  { value: 'contract', label: 'Contract' },
];

const STATUS_COLORS: Record<string, string> = {
  active: '#10b981',
  inactive: '#64748b',
  on_leave: '#fbbf24',
};

export default function ProvidersPage() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [orgId, setOrgId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('active');
  const [showAdd, setShowAdd] = useState(false);

  // Load org, then providers
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

  const loadProviders = useCallback(async () => {
    if (!orgId) return;
    const params = new URLSearchParams({ org_id: orgId });
    if (statusFilter) params.set('status', statusFilter);
    if (typeFilter) params.set('provider_type', typeFilter);
    if (search) params.set('search', search);
    const res = await fetch('/api/scheduling/providers?' + params);
    setProviders(await res.json());
  }, [orgId, statusFilter, typeFilter, search]);

  const loadSites = useCallback(async () => {
    if (!orgId) return;
    const res = await fetch('/api/scheduling/sites?org_id=' + orgId);
    setSites(await res.json());
  }, [orgId]);

  useEffect(() => { loadProviders(); }, [loadProviders]);
  useEffect(() => { loadSites(); }, [loadSites]);

  const profile = (p: Provider) => p.provider_employment_profiles?.[0] || null;
  const siteName = (id: string | null) => sites.find(s => s.id === id)?.name || '—';

  if (loading) return <div style={{ padding: 40, color: 'var(--text-muted)' }}>Loading...</div>;

  if (!orgId) {
    return <NoOrgSetup onCreated={(id) => setOrgId(id)} />;
  }

  return (
    <div style={{ padding: '24px 32px' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)' }}>Providers</h1>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>{providers.length} provider{providers.length !== 1 ? 's' : ''}</p>
        </div>
        <button onClick={() => setShowAdd(true)} style={{
          padding: '10px 20px', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 13,
          background: 'linear-gradient(135deg,#0ea5e9,#6366f1)', color: '#fff', border: 'none',
        }}>+ Add Provider</button>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
        <input
          placeholder="Search by name..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            padding: '8px 14px', borderRadius: 8, border: '1px solid var(--border)',
            background: 'var(--bg-deep)', color: 'var(--text)', fontSize: 13, width: 220,
          }}
        />
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} style={selectStyle}>
          <option value="">All Types</option>
          {Object.entries(TYPE_COLORS).map(([t, c]) => (
            <option key={t} value={t}>{c.label}</option>
          ))}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={selectStyle}>
          <option value="">All Statuses</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="on_leave">On Leave</option>
        </select>
      </div>

      {/* Table */}
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)', background: 'rgba(14,165,233,0.04)' }}>
              {['Name', 'Type', 'Status', 'Employment', 'FTE', 'Home Site', 'Call Taker', 'Fellowship'].map(h => (
                <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: 10, fontWeight: 800, color: 'var(--text-dim)', letterSpacing: 1, textTransform: 'uppercase' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {providers.map((p) => {
              const prof = profile(p);
              const tc = TYPE_COLORS[p.provider_type] || TYPE_COLORS.other;
              return (
                <tr key={p.id} style={{ borderBottom: '1px solid rgba(30,58,95,0.4)', cursor: 'pointer' }}>
                  <td style={{ padding: '10px 14px' }}>
                    <Link href={`/providers/${p.id}`} style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none', color: 'var(--text)' }}>
                      <div style={{
                        width: 32, height: 32, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 11, fontWeight: 800, background: tc.bg, color: tc.color, flexShrink: 0,
                      }}>{p.initials}</div>
                      <div>
                        <div style={{ fontWeight: 700 }}>{p.first_name} {p.last_name}</div>
                        {p.email && <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{p.email}</div>}
                      </div>
                    </Link>
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    <span style={{
                      fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 6,
                      background: tc.bg, color: tc.color,
                    }}>{tc.label}</span>
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: STATUS_COLORS[p.status] || '#64748b' }} />
                      <span style={{ fontSize: 12, color: 'var(--text-muted)', textTransform: 'capitalize' }}>{p.status.replace('_', ' ')}</span>
                    </span>
                  </td>
                  <td style={{ padding: '10px 14px', fontSize: 12, color: 'var(--text-muted)' }}>
                    {EMPLOYMENT_OPTIONS.find(o => o.value === prof?.employment_status)?.label || prof?.employment_status?.replace(/_/g, ' ') || '—'}
                  </td>
                  <td style={{ padding: '10px 14px', fontSize: 12, color: 'var(--text-muted)' }}>
                    {prof?.fte_value ?? '—'}
                  </td>
                  <td style={{ padding: '10px 14px', fontSize: 12, color: 'var(--text-muted)' }}>
                    {siteName(prof?.home_site_id || null)}
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    {prof?.call_taker ? (
                      <span style={{ fontSize: 11, fontWeight: 700, color: '#10b981' }}>Yes</span>
                    ) : prof?.partial_call_taker ? (
                      <span style={{ fontSize: 11, fontWeight: 700, color: '#fbbf24' }}>Partial</span>
                    ) : (
                      <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>No</span>
                    )}
                  </td>
                  <td style={{ padding: '10px 14px', fontSize: 12, color: 'var(--text-muted)' }}>
                    {prof?.fellowship_primary || '—'}
                  </td>
                </tr>
              );
            })}
            {providers.length === 0 && (
              <tr><td colSpan={8} style={{ padding: '40px 14px', textAlign: 'center', color: 'var(--text-dim)', fontStyle: 'italic' }}>No providers found</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {showAdd && <AddProviderModal orgId={orgId} sites={sites} onClose={() => setShowAdd(false)} onAdded={() => { setShowAdd(false); loadProviders(); }} />}
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)',
  background: 'var(--bg-deep)', color: 'var(--text)', fontSize: 13, cursor: 'pointer',
};

// ── No Org Setup ──────────────────────────────────────────────────────────────
function NoOrgSetup({ onCreated }: { onCreated: (id: string) => void }) {
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);

  const create = async () => {
    if (!name.trim()) return;
    setCreating(true);
    const res = await fetch('/api/scheduling/organizations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim() }),
    });
    const org = await res.json();
    onCreated(org.id);
  };

  return (
    <div style={{ padding: 40, maxWidth: 460 }}>
      <h1 style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)', marginBottom: 8 }}>Welcome to FloorRunner</h1>
      <p style={{ fontSize: 14, color: 'var(--text-muted)', marginBottom: 24 }}>Create your organization to get started.</p>
      <input
        placeholder="Organization name (e.g. Main Line Anesthesia)"
        value={name} onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && create()}
        style={{ width: '100%', padding: '12px 16px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-deep)', color: 'var(--text)', fontSize: 14, marginBottom: 12 }}
      />
      <button onClick={create} disabled={creating} style={{
        padding: '10px 24px', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 13,
        background: 'linear-gradient(135deg,#0ea5e9,#6366f1)', color: '#fff', border: 'none', opacity: creating ? 0.5 : 1,
      }}>{creating ? 'Creating...' : 'Create Organization'}</button>
    </div>
  );
}

// ── Add Provider Modal ────────────────────────────────────────────────────────
function AddProviderModal({ orgId, sites, onClose, onAdded }: { orgId: string; sites: Site[]; onClose: () => void; onAdded: () => void }) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [providerType, setProviderType] = useState('physician');
  const [email, setEmail] = useState('');
  const [employmentStatus, setEmploymentStatus] = useState('full_time');
  const [callTaker, setCallTaker] = useState(false);
  const [isPartner, setIsPartner] = useState(false);
  const [isPartnerTrack, setIsPartnerTrack] = useState(false);
  const [homeSiteId, setHomeSiteId] = useState('');
  const [homeAddress, setHomeAddress] = useState('');
  const [startDate, setStartDate] = useState('');
  const [fellowship, setFellowship] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!firstName.trim() || !lastName.trim()) return;
    setSaving(true);
    await fetch('/api/scheduling/providers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        organization_id: orgId,
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        provider_type: providerType,
        email: email.trim() || null,
        home_address: homeAddress.trim() || null,
        start_date: startDate || null,
        employment_status: employmentStatus,
        call_taker: callTaker,
        is_shareholder: isPartner,
        is_partner_track: isPartnerTrack,
        home_site_id: homeSiteId || null,
        fellowship_primary: fellowship.trim() || null,
      }),
    });
    onAdded();
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '10px 12px', borderRadius: 8,
    border: '1px solid var(--border)', background: 'var(--bg-deep)',
    color: 'var(--text)', fontSize: 14, marginBottom: 12,
  };
  const labelStyle: React.CSSProperties = { fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 5, fontWeight: 600, letterSpacing: 0.5 };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }} onClick={onClose}>
      <div className="modal-box" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 16, padding: 28, width: 480, maxHeight: '85vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: 17, fontWeight: 800, color: '#f1f5f9', marginBottom: 22 }}>Add Provider</div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
          <div>
            <label style={labelStyle}>First Name *</label>
            <input style={inputStyle} placeholder="Jane" value={firstName} onChange={e => setFirstName(e.target.value)} />
          </div>
          <div>
            <label style={labelStyle}>Last Name *</label>
            <input style={inputStyle} placeholder="Smith" value={lastName} onChange={e => setLastName(e.target.value)} />
          </div>
        </div>

        <label style={labelStyle}>Email</label>
        <input style={inputStyle} placeholder="jane.smith@hospital.org" value={email} onChange={e => setEmail(e.target.value)} />

        <label style={labelStyle}>Provider Type</label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginBottom: 14 }}>
          {Object.entries(TYPE_COLORS).map(([t, c]) => (
            <button key={t} onClick={() => setProviderType(t)} style={{
              padding: '7px 10px', borderRadius: 8, cursor: 'pointer', fontSize: 11, fontWeight: 700,
              border: `1px solid ${providerType === t ? c.color : 'var(--border)'}`,
              background: providerType === t ? c.bg : 'transparent',
              color: providerType === t ? c.color : 'var(--text-muted)',
            }}>{c.label}</button>
          ))}
        </div>

        <label style={labelStyle}>Employment Status</label>
        <select value={employmentStatus} onChange={e => setEmploymentStatus(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
          {EMPLOYMENT_OPTIONS.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>

        <label style={labelStyle}>Home Address</label>
        <input style={inputStyle} placeholder="123 Main St, City, State" value={homeAddress} onChange={e => setHomeAddress(e.target.value)} />

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
          <div>
            <label style={labelStyle}>Home Hospital / Surgery Center</label>
            <select value={homeSiteId} onChange={e => setHomeSiteId(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
              <option value="">— None —</option>
              {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Start Date with Company</label>
            <input type="date" style={inputStyle} value={startDate} onChange={e => setStartDate(e.target.value)} />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 16, marginBottom: 14, flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-muted)', cursor: 'pointer' }}>
            <input type="checkbox" checked={callTaker} onChange={e => setCallTaker(e.target.checked)} style={{ accentColor: '#0ea5e9' }} />
            Call Taker
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-muted)', cursor: 'pointer' }}>
            <input type="checkbox" checked={isPartner} onChange={e => { setIsPartner(e.target.checked); if (e.target.checked) setIsPartnerTrack(false); }} style={{ accentColor: '#10b981' }} />
            Partner
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-muted)', cursor: 'pointer' }}>
            <input type="checkbox" checked={isPartnerTrack} onChange={e => { setIsPartnerTrack(e.target.checked); if (e.target.checked) setIsPartner(false); }} style={{ accentColor: '#fbbf24' }} />
            Partner Track
          </label>
        </div>

        {(providerType === 'physician' || providerType === 'fellow') && (
          <>
            <label style={labelStyle}>Fellowship / Subspecialty</label>
            <input style={inputStyle} placeholder="e.g. Cardiac, Pediatric, OB" value={fellowship} onChange={e => setFellowship(e.target.value)} />
          </>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button onClick={onClose} style={{ padding: '9px 18px', borderRadius: 8, cursor: 'pointer', background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border)', fontWeight: 600, fontSize: 13 }}>Cancel</button>
          <button onClick={submit} disabled={saving} style={{
            padding: '9px 20px', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 13,
            background: 'linear-gradient(135deg,#0ea5e9,#6366f1)', color: '#fff', border: 'none', opacity: saving ? 0.5 : 1,
          }}>{saving ? 'Adding...' : 'Add Provider'}</button>
        </div>
      </div>
    </div>
  );
}
