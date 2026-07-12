'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { PageHeader, Card, Badge, Button, Table, EmptyState, Modal } from '@/components/ui';

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

const TABLE_HEADERS = ['Site', 'Type', 'Status', 'Shift Types', 'Address', 'Timezone'];

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

  if (loading) {
    return (
      <div>
        <PageHeader title="Sites" />
        <Card pad={false}>
          <Table headers={TABLE_HEADERS} rows={undefined} minWidth={720} />
        </Card>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Sites"
        subtitle={`${sites.length} site${sites.length !== 1 ? 's' : ''} configured`}
        actions={<Button onClick={() => setShowAdd(true)}>+ Add Site</Button>}
      />

      <Card pad={false}>
        <Table
          headers={TABLE_HEADERS}
          minWidth={720}
          rows={sites.map(site => {
            const tc = SITE_TYPE_COLORS[site.site_type] || SITE_TYPE_COLORS.hospital;
            const shiftCount = site.shift_types?.length || 0;
            return [
              <Link key="name" href={`/sites/${site.id}`} style={{ textDecoration: 'none', color: 'var(--text)' }}>
                <div style={{ fontWeight: 700, color: 'var(--text-strong)' }}>{site.name}</div>
                {site.short_name && (
                  <div style={{ fontSize: 11, color: 'var(--text-dim)', fontWeight: 600 }}>{site.short_name}</div>
                )}
              </Link>,
              <span key="type" style={{
                fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 6,
                background: tc.bg, color: tc.color, whiteSpace: 'nowrap',
              }}>{tc.label}</span>,
              <Badge key="status" tone={site.is_active ? 'ok' : 'neutral'}>{site.is_active ? 'Active' : 'Inactive'}</Badge>,
              <Badge key="st" tone="info">{shiftCount} shift type{shiftCount !== 1 ? 's' : ''}</Badge>,
              site.address || '—',
              site.timezone || '—',
            ];
          })}
          empty={
            <EmptyState
              icon="⬡"
              title="No sites configured yet"
              hint="Add the hospitals, surgery centers, and offices your group covers — shift types and schedules hang off each site."
              action={<Button size="sm" onClick={() => setShowAdd(true)}>+ Add Site</Button>}
            />
          }
        />
      </Card>

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
    <Modal
      open
      onClose={onClose}
      title="Add Site"
      width={480}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={saving}>{saving ? 'Adding...' : 'Add Site'}</Button>
        </>
      }
    >
      <label style={labelStyle}>Site Name *</label>
      <input style={inputStyle} placeholder="Main Hospital" value={name} onChange={e => setName(e.target.value)} />

      <label style={labelStyle}>Short Name</label>
      <input style={inputStyle} placeholder="MH" value={shortName} onChange={e => setShortName(e.target.value)} />

      <label style={labelStyle}>Site Type</label>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginBottom: 14 }}>
        {Object.entries(SITE_TYPE_COLORS).map(([t, c]) => (
          <Button
            key={t}
            variant="secondary"
            size="sm"
            onClick={() => setSiteType(t)}
            style={{
              border: `1px solid ${siteType === t ? c.color : 'var(--border)'}`,
              background: siteType === t ? c.bg : 'transparent',
              color: siteType === t ? c.color : 'var(--text-muted)',
              fontWeight: 700,
            }}
          >
            {c.label}
          </Button>
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
    </Modal>
  );
}
