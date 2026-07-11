'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';

interface Site {
  id: string;
  name: string;
  short_name: string | null;
  site_type: string;
  address: string | null;
  timezone: string | null;
  is_active: boolean;
  display_order: number | null;
  shift_types?: { id: string }[];
}

const SITE_TYPE_COLORS: Record<string, { color: string; bg: string; label: string }> = {
  hospital: { color: '#0ea5e9', bg: 'rgba(14,165,233,0.15)', label: 'Hospital' },
  asc:      { color: '#10b981', bg: 'rgba(16,185,129,0.15)', label: 'ASC' },
  office:   { color: '#f59e0b', bg: 'rgba(245,158,11,0.15)', label: 'Office' },
};

export default function SitesPage() {
  const [sites, setSites] = useState<Site[]>([]);
  const [orgId, setOrgId] = useState('');
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);

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

  const loadSites = useCallback(async () => {
    if (!orgId) return;
    const res = await fetch('/api/scheduling/sites?org_id=' + orgId);
    const data = await res.json();
    // Also load shift type counts per site
    const stRes = await fetch('/api/scheduling/shift-types');
    const shiftTypes = await stRes.json();
    const enriched = data.map((s: Site) => ({
      ...s,
      shift_types: Array.isArray(shiftTypes) ? shiftTypes.filter((st: { site_id: string }) => st.site_id === s.id) : [],
    }));
    setSites(enriched);
  }, [orgId]);

  useEffect(() => { loadSites(); }, [loadSites]);

  if (loading) return <div style={{ padding: 40, color: 'var(--text-muted)' }}>Loading...</div>;

  return (
    <div style={{ padding: '24px 32px' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)' }}>Sites</h1>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>
            {sites.length} site{sites.length !== 1 ? 's' : ''} configured
          </p>
        </div>
        <button onClick={() => setShowAdd(true)} style={{
          padding: '10px 20px', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 13,
          background: 'linear-gradient(135deg,#0ea5e9,#6366f1)', color: '#fff', border: 'none',
        }}>+ Add Site</button>
      </div>

      {/* Site Cards Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16 }}>
        {sites.map(site => {
          const tc = SITE_TYPE_COLORS[site.site_type] || SITE_TYPE_COLORS.hospital;
          const shiftCount = site.shift_types?.length || 0;
          return (
            <Link key={site.id} href={`/sites/${site.id}`} style={{ textDecoration: 'none' }}>
              <div style={{
                background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12,
                padding: '20px 22px', cursor: 'pointer', transition: 'all 0.15s',
                position: 'relative', overflow: 'hidden',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.borderColor = '#0ea5e9'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border)'; }}
              >
                {/* Top row: name + active indicator */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                  <div>
                    <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--text)', marginBottom: 3 }}>{site.name}</div>
                    {site.short_name && (
                      <div style={{ fontSize: 12, color: 'var(--text-dim)', fontWeight: 600 }}>{site.short_name}</div>
                    )}
                  </div>
                  <span style={{
                    fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 6,
                    background: site.is_active ? 'rgba(16,185,129,0.12)' : 'rgba(100,116,139,0.12)',
                    color: site.is_active ? '#10b981' : '#64748b',
                  }}>{site.is_active ? 'Active' : 'Inactive'}</span>
                </div>

                {/* Badges */}
                <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
                  <span style={{
                    fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 6,
                    background: tc.bg, color: tc.color,
                  }}>{tc.label}</span>
                  <span style={{
                    fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 6,
                    background: 'rgba(99,102,241,0.12)', color: '#818cf8',
                  }}>{shiftCount} shift type{shiftCount !== 1 ? 's' : ''}</span>
                </div>

                {/* Details */}
                <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {site.address && (
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>Address:</span>
                      <span>{site.address}</span>
                    </div>
                  )}
                  {site.timezone && (
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>Timezone:</span>
                      <span>{site.timezone}</span>
                    </div>
                  )}
                </div>
              </div>
            </Link>
          );
        })}

        {sites.length === 0 && (
          <div style={{
            gridColumn: '1 / -1', padding: 48, textAlign: 'center',
            color: 'var(--text-dim)', fontStyle: 'italic',
            background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12,
          }}>
            No sites configured yet. Click &quot;Add Site&quot; to get started.
          </div>
        )}
      </div>

      {showAdd && (
        <AddSiteModal
          orgId={orgId}
          onClose={() => setShowAdd(false)}
          onAdded={() => { setShowAdd(false); loadSites(); }}
        />
      )}
    </div>
  );
}

// ── Add Site Modal ─────────────────────────────────────────────────────────────
function AddSiteModal({ orgId, onClose, onAdded }: { orgId: string; onClose: () => void; onAdded: () => void }) {
  const [name, setName] = useState('');
  const [shortName, setShortName] = useState('');
  const [siteType, setSiteType] = useState('hospital');
  const [address, setAddress] = useState('');
  const [timezone, setTimezone] = useState('America/New_York');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!name.trim()) return;
    setSaving(true);
    await fetch('/api/scheduling/sites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        organization_id: orgId,
        name: name.trim(),
        short_name: shortName.trim() || null,
        site_type: siteType,
        address: address.trim() || null,
        timezone,
      }),
    });
    onAdded();
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '10px 12px', borderRadius: 8,
    border: '1px solid var(--border)', background: 'var(--bg-deep)',
    color: 'var(--text)', fontSize: 14, marginBottom: 12,
  };
  const labelStyle: React.CSSProperties = {
    fontSize: 11, color: 'var(--text-muted)', display: 'block',
    marginBottom: 5, fontWeight: 600, letterSpacing: 0.5,
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }} onClick={onClose}>
      <div className="modal-box" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 16, padding: 28, width: 480, maxHeight: '85vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: 17, fontWeight: 800, color: 'var(--text-strong)', marginBottom: 22 }}>Add Site</div>

        <label style={labelStyle}>Site Name *</label>
        <input style={inputStyle} placeholder="Main Hospital" value={name} onChange={e => setName(e.target.value)} />

        <label style={labelStyle}>Short Name</label>
        <input style={inputStyle} placeholder="MH" value={shortName} onChange={e => setShortName(e.target.value)} />

        <label style={labelStyle}>Site Type</label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginBottom: 14 }}>
          {Object.entries(SITE_TYPE_COLORS).map(([t, c]) => (
            <button key={t} onClick={() => setSiteType(t)} style={{
              padding: '8px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 700,
              border: `1px solid ${siteType === t ? c.color : 'var(--border)'}`,
              background: siteType === t ? c.bg : 'transparent',
              color: siteType === t ? c.color : 'var(--text-muted)',
            }}>{c.label}</button>
          ))}
        </div>

        <label style={labelStyle}>Address</label>
        <input style={inputStyle} placeholder="123 Medical Dr, City, State" value={address} onChange={e => setAddress(e.target.value)} />

        <label style={labelStyle}>Timezone</label>
        <select value={timezone} onChange={e => setTimezone(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
          <option value="America/New_York">America/New_York (Eastern)</option>
          <option value="America/Chicago">America/Chicago (Central)</option>
          <option value="America/Denver">America/Denver (Mountain)</option>
          <option value="America/Los_Angeles">America/Los_Angeles (Pacific)</option>
          <option value="America/Phoenix">America/Phoenix (Arizona)</option>
          <option value="Pacific/Honolulu">Pacific/Honolulu (Hawaii)</option>
          <option value="America/Anchorage">America/Anchorage (Alaska)</option>
        </select>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button onClick={onClose} style={{ padding: '9px 18px', borderRadius: 8, cursor: 'pointer', background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border)', fontWeight: 600, fontSize: 13 }}>Cancel</button>
          <button onClick={submit} disabled={saving} style={{
            padding: '9px 20px', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 13,
            background: 'linear-gradient(135deg,#0ea5e9,#6366f1)', color: '#fff', border: 'none', opacity: saving ? 0.5 : 1,
          }}>{saving ? 'Adding...' : 'Add Site'}</button>
        </div>
      </div>
    </div>
  );
}
