'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { interpretListRead } from '../providers/listRead';
import { PageHeader, Card, Badge, Button, Table, EmptyState, Banner, Modal } from '@/components/ui';

interface Site {
  id: string;
  name: string;
  short_name: string | null;
  site_type: string;
  address: string | null;
  timezone: string | null;
  is_active: boolean;
  display_order: number | null;
  /** undefined ⇒ the shift-type read failed, so the count is UNKNOWN, not zero. */
  shift_types?: { site_id: string }[];
}

/* Duplicated verbatim in ./[id]/page.tsx, which renders the same type pill —
   change both or neither. See the longer note there: site TYPE is a three-way
   enum (the database colour is `color_hex`), and the literals this used to hold
   were the DARK values of --blue / --ok / --warn, which is why these pills
   washed out on the light default. */
const SITE_TYPE_COLORS: Record<string, { color: string; bg: string; label: string }> = {
  hospital: { color: 'var(--blue)', bg: 'color-mix(in srgb, var(--blue) 15%, transparent)', label: 'Hospital' },
  asc:      { color: 'var(--ok)',   bg: 'color-mix(in srgb, var(--ok) 15%, transparent)',   label: 'ASC' },
  office:   { color: 'var(--warn)', bg: 'color-mix(in srgb, var(--warn) 15%, transparent)', label: 'Office' },
};

const TABLE_HEADERS = ['Site', 'Type', 'Status', 'Shift Types', 'Address', 'Timezone'];

export default function SitesPage() {
  const [sites, setSites] = useState<Site[]>([]);
  const [orgId, setOrgId] = useState('');
  const [loading, setLoading] = useState(true);
  const [orgError, setOrgError] = useState<string | null>(null);
  const [sitesError, setSitesError] = useState<string | null>(null);
  const [shiftTypesError, setShiftTypesError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/scheduling/organizations');
        const read = interpretListRead<{ id: string }>(res, await res.json().catch(() => null), 'organizations');
        // A failed org read leaves orgId empty, which stops the sites read from
        // ever running — indistinguishable from a group with no sites unless
        // the failure is said out loud.
        if (!read.ok) { setOrgError(read.error); return; }
        if (read.rows.length > 0) setOrgId(read.rows[0].id);
      } catch (e) {
        setOrgError(e instanceof Error ? e.message : 'Network error loading organizations');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const loadSites = useCallback(async () => {
    if (!orgId) return;
    try {
      const res = await fetch('/api/scheduling/sites?org_id=' + orgId);
      const read = interpretListRead<Site>(res, await res.json().catch(() => null), 'sites');
      // A failed read must not fall through to the empty-list path: that path
      // invites the user to onboard sites that already exist, which duplicates
      // every hospital in the group.
      if (!read.ok) { setSitesError(read.error); return; }

      // Shift-type counts decorate the rows; a failed read must not blank the
      // site list, but "0 shift types" would be a lie, so it is flagged and the
      // count is left unknown instead.
      const stRes = await fetch('/api/scheduling/shift-types');
      const stRead = interpretListRead<{ site_id: string }>(stRes, await stRes.json().catch(() => null), 'shift types');
      setShiftTypesError(stRead.ok ? null : stRead.error);

      setSites(read.rows.map(s => ({
        ...s,
        shift_types: stRead.ok ? stRead.rows.filter(st => st.site_id === s.id) : undefined,
      })));
      setSitesError(null);
    } catch (e) {
      setSitesError(e instanceof Error ? e.message : 'Network error loading sites');
    }
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

  if (orgError) {
    return (
      <div>
        <PageHeader title="Sites" />
        <Banner tone="error">{orgError} Reload the page to try again.</Banner>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Sites"
        subtitle={sitesError
          ? 'Site list unavailable'
          : `${sites.length} site${sites.length !== 1 ? 's' : ''} configured`}
        actions={<Button onClick={() => setShowAdd(true)}>+ Add Site</Button>}
      />

      {(sitesError || shiftTypesError) && (
        <div style={{ marginBottom: 16, display: 'grid', gap: 8 }}>
          {sitesError && <Banner tone="error">{sitesError}</Banner>}
          {shiftTypesError && <Banner tone="warn">{shiftTypesError} Shift-type counts are shown as unknown.</Banner>}
        </div>
      )}

      <Card pad={false}>
        <Table
          headers={TABLE_HEADERS}
          minWidth={720}
          rows={sites.map(site => {
            const tc = SITE_TYPE_COLORS[site.site_type] || SITE_TYPE_COLORS.hospital;
            const shiftCount = site.shift_types?.length;
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
              shiftCount === undefined
                ? <Badge key="st" tone="neutral">Shift types unknown</Badge>
                : <Badge key="st" tone="info">{shiftCount} shift type{shiftCount !== 1 ? 's' : ''}</Badge>,
              site.address || '—',
              site.timezone || '—',
            ];
          })}
          empty={sitesError
            // Only ever the onboarding pitch when the read genuinely SUCCEEDED
            // and came back empty — a failed read offering "+ Add Site" is how
            // an existing hospital gets entered twice.
            ? <EmptyState icon="⚠" title="Sites could not be loaded" hint={`${sitesError} Reload the page to try again.`} />
            : (
              <EmptyState
                icon="⬡"
                title="No sites configured yet"
                hint="Add the hospitals, surgery centers, and offices your group covers — shift types and schedules hang off each site."
                action={<Button size="sm" onClick={() => setShowAdd(true)}>+ Add Site</Button>}
              />
            )
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
