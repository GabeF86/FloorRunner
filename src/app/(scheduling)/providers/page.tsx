'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { isValidEmail } from '@/lib/validation/providers';
import { PageHeader, Card, Badge, Button, Table, EmptyState, Banner, Modal, type BadgeTone } from '@/components/ui';

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
    is_shareholder: boolean;
    is_partner_track: boolean;
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
  { value: 'per_diem', label: 'Per Diem' },
  { value: 'locums', label: 'Locums' },
  { value: 'contract', label: 'Contract' },
];

const STATUS_TONES: Record<string, BadgeTone> = {
  active: 'ok',
  inactive: 'neutral',
  on_leave: 'warn',
};

const TABLE_HEADERS = ['Name', 'Type', 'Status', 'Employment', 'FTE', 'Home Site', 'Call Taker', 'Fellowship', ''];

export default function ProvidersPage() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [orgId, setOrgId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('active');
  const [credentialedSiteFilter, setCredentialedSiteFilter] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
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
    if (credentialedSiteFilter) params.set('credentialed_site_id', credentialedSiteFilter);
    const res = await fetch('/api/scheduling/providers?' + params);
    setProviders(await res.json());
  }, [orgId, statusFilter, typeFilter, search, credentialedSiteFilter]);

  const loadSites = useCallback(async () => {
    if (!orgId) return;
    const res = await fetch('/api/scheduling/sites?org_id=' + orgId);
    setSites(await res.json());
  }, [orgId]);

  useEffect(() => { loadProviders(); }, [loadProviders]);
  useEffect(() => { loadSites(); }, [loadSites]);

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Permanently delete "${name}"? This cannot be undone — their employment profile, credentials, and assignment history will be removed.`)) return;
    const res = await fetch(`/api/scheduling/providers/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(`Failed to delete: ${err.error || res.statusText}`);
      return;
    }
    loadProviders();
  };

  const profile = (p: Provider) => p.provider_employment_profiles?.[0] || null;
  const siteName = (id: string | null) => sites.find(s => s.id === id)?.name || '—';

  // Client-side role filter — relies on employment profile fields already loaded.
  // "Call Taker" matches both full call_taker and partial_call_taker.
  const filteredProviders = useMemo(() => {
    if (!roleFilter) return providers;
    return providers.filter(p => {
      const prof = profile(p);
      if (!prof) return false;
      switch (roleFilter) {
        case 'call_taker':   return prof.call_taker || prof.partial_call_taker;
        case 'per_diem':     return prof.employment_status === 'per_diem';
        // "Employed" = W-2 salaried staff that work hourly shifts and do NOT
        // take call. Derived from employment_status + call flags rather than
        // a dedicated column.
        case 'employed':
          return (prof.employment_status === 'full_time' || prof.employment_status === 'part_time')
            && !prof.call_taker
            && !prof.partial_call_taker;
        case 'partner':      return prof.is_shareholder;
        case 'partner_track':return prof.is_partner_track;
        default:             return true;
      }
    });
  }, [providers, roleFilter]);

  if (loading) {
    return (
      <div>
        <PageHeader title="Providers" />
        <Card pad={false}>
          <Table headers={TABLE_HEADERS} rows={undefined} minWidth={900} />
        </Card>
      </div>
    );
  }

  if (!orgId) {
    return <NoOrgSetup onCreated={(id) => setOrgId(id)} />;
  }

  return (
    <div>
      <PageHeader
        title="Providers"
        subtitle={`${filteredProviders.length} provider${filteredProviders.length !== 1 ? 's' : ''}${roleFilter && providers.length !== filteredProviders.length ? ` of ${providers.length}` : ''}`}
        actions={<Button onClick={() => setShowAdd(true)}>+ Add Provider</Button>}
      />

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
        <select
          value={credentialedSiteFilter}
          onChange={(e) => setCredentialedSiteFilter(e.target.value)}
          style={selectStyle}
        >
          <option value="">Credentialed at — Any Site</option>
          {sites.map(s => (
            <option key={s.id} value={s.id}>Credentialed at {s.short_name || s.name}</option>
          ))}
        </select>
        <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} style={selectStyle}>
          <option value="">All Roles</option>
          <option value="call_taker">Call Taker</option>
          <option value="per_diem">Per Diem</option>
          <option value="employed">Employed</option>
          <option value="partner">Partner</option>
          <option value="partner_track">Partner Track</option>
        </select>
      </div>

      {/* Table */}
      <Card pad={false}>
        <Table
          headers={TABLE_HEADERS}
          minWidth={900}
          rows={filteredProviders.map((p) => {
            const prof = profile(p);
            const tc = TYPE_COLORS[p.provider_type] || TYPE_COLORS.other;
            return [
              <Link key="name" href={`/providers/${p.id}`} style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none', color: 'var(--text)' }}>
                <div style={{
                  width: 32, height: 32, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 11, fontWeight: 800, background: tc.bg, color: tc.color, flexShrink: 0,
                }}>{p.initials}</div>
                <div>
                  <div style={{ fontWeight: 700 }}>{p.first_name} {p.last_name}</div>
                  {p.email && <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{p.email}</div>}
                </div>
              </Link>,
              <span key="type" style={{
                fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 6,
                background: tc.bg, color: tc.color, whiteSpace: 'nowrap',
              }}>{tc.label}</span>,
              <Badge key="status" tone={STATUS_TONES[p.status] || 'neutral'}>{p.status.replace('_', ' ')}</Badge>,
              EMPLOYMENT_OPTIONS.find(o => o.value === prof?.employment_status)?.label || prof?.employment_status?.replace(/_/g, ' ') || '—',
              prof?.fte_value != null ? Number(prof.fte_value).toFixed(2) : '—',
              siteName(prof?.home_site_id ?? null),
              prof?.call_taker ? (
                <Badge key="ct" tone="ok">Yes</Badge>
              ) : prof?.partial_call_taker ? (
                <Badge key="ct" tone="warn">Partial</Badge>
              ) : (
                <Badge key="ct" tone="neutral">No</Badge>
              ),
              prof?.fellowship_primary || '—',
              <div key="actions" style={{ textAlign: 'right' }}>
                <Button
                  variant="danger"
                  size="sm"
                  title="Delete provider"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete(p.id, `${p.first_name} ${p.last_name}`);
                  }}
                >
                  Delete
                </Button>
              </div>,
            ];
          })}
          empty={
            <EmptyState
              icon="◆"
              title="No providers found"
              hint="Add your first provider, or loosen the search and filters to see more of the roster."
            />
          }
        />
      </Card>

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
    <div style={{ maxWidth: 460 }}>
      <PageHeader
        title="Welcome to FloorRunner"
        subtitle="Create your organization to get started."
      />
      <input
        placeholder="Organization name (e.g. Main Line Anesthesia)"
        value={name} onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && create()}
        style={{ width: '100%', padding: '12px 16px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-deep)', color: 'var(--text)', fontSize: 14, marginBottom: 12 }}
      />
      <Button onClick={create} disabled={creating}>{creating ? 'Creating...' : 'Create Organization'}</Button>
    </div>
  );
}

// ── Add Provider Modal ────────────────────────────────────────────────────────
function AddProviderModal({ orgId, sites, onClose, onAdded }: { orgId: string; sites: Site[]; onClose: () => void; onAdded: () => void }) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [providerType, setProviderType] = useState('physician');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [npi, setNpi] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [employmentStatus, setEmploymentStatus] = useState('full_time');
  const [callTaker, setCallTaker] = useState(false);
  const [isPartner, setIsPartner] = useState(false);
  const [isPartnerTrack, setIsPartnerTrack] = useState(false);
  const [homeSiteId, setHomeSiteId] = useState('');
  const [homeAddress, setHomeAddress] = useState('');
  const [startDate, setStartDate] = useState('');
  const [isDayDoc, setIsDayDoc] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const errors: Record<string, string> = {};
  if (!firstName.trim()) errors.firstName = 'Required';
  if (!lastName.trim()) errors.lastName = 'Required';
  if (email.trim() && !isValidEmail(email.trim())) errors.email = 'Not a valid email';

  const canSubmit = Object.keys(errors).length === 0 && !saving;

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true); setError(null);
    try {
      const res = await fetch('/api/scheduling/providers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          organization_id: orgId,
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          provider_type: providerType,
          email: email.trim() || null,
          phone: phone.trim() || null,
          npi: npi.trim() || null,
          employee_id: employeeId.trim() || null,
          home_address: homeAddress.trim() || null,
          start_date: startDate || null,
          employment_status: employmentStatus,
          call_taker: callTaker,
          is_shareholder: isPartner,
          is_partner_track: isPartnerTrack,
          is_day_doc: isDayDoc,
          home_site_id: homeSiteId || null,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || `Failed (${res.status})`);
        return;
      }
      onAdded();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setSaving(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '10px 12px', borderRadius: 8,
    border: '1px solid var(--border)', background: 'var(--bg-deep)',
    color: 'var(--text)', fontSize: 14, marginBottom: 12,
  };
  const labelStyle: React.CSSProperties = { fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 5, fontWeight: 600, letterSpacing: 0.5 };
  const errorStyle: React.CSSProperties = { fontSize: 10, color: 'var(--danger)', marginBottom: 8, marginTop: 2 };

  return (
    <Modal
      open
      onClose={onClose}
      title="Add Provider"
      width={520}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={!canSubmit}>{saving ? 'Adding...' : 'Add Provider'}</Button>
        </>
      }
    >
      {error && (
        <div style={{ marginBottom: 14 }}>
          <Banner tone="error">{error}</Banner>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
        <div>
          <label style={labelStyle}>First Name *</label>
          <input
            style={{ ...inputStyle, border: `1px solid ${errors.firstName ? 'var(--danger)' : 'var(--border)'}`, marginBottom: errors.firstName ? 2 : 12 }}
            placeholder="Jane" value={firstName} onChange={e => setFirstName(e.target.value)}
          />
          {errors.firstName && <div style={errorStyle}>{errors.firstName}</div>}
        </div>
        <div>
          <label style={labelStyle}>Last Name *</label>
          <input
            style={{ ...inputStyle, border: `1px solid ${errors.lastName ? 'var(--danger)' : 'var(--border)'}`, marginBottom: errors.lastName ? 2 : 12 }}
            placeholder="Smith" value={lastName} onChange={e => setLastName(e.target.value)}
          />
          {errors.lastName && <div style={errorStyle}>{errors.lastName}</div>}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <label style={labelStyle}>Email</label>
          <input
            style={{ ...inputStyle, border: `1px solid ${errors.email ? 'var(--danger)' : 'var(--border)'}`, marginBottom: errors.email ? 2 : 12 }}
            placeholder="jane.smith@hospital.org" value={email} onChange={e => setEmail(e.target.value)}
          />
          {errors.email && <div style={errorStyle}>{errors.email}</div>}
        </div>
        <div>
          <label style={labelStyle}>Phone</label>
          <input style={inputStyle} placeholder="(555) 123-4567" value={phone} onChange={e => setPhone(e.target.value)} />
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <label style={labelStyle}>NPI</label>
          <input style={inputStyle} placeholder="1234567890" value={npi} onChange={e => setNpi(e.target.value)} />
        </div>
        <div>
          <label style={labelStyle}>Employee ID</label>
          <input style={inputStyle} placeholder="E12345" value={employeeId} onChange={e => setEmployeeId(e.target.value)} />
        </div>
      </div>

      <label style={labelStyle}>Provider Type</label>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginBottom: 14 }}>
        {Object.entries(TYPE_COLORS).map(([t, c]) => (
          <Button
            key={t}
            variant="secondary"
            size="sm"
            onClick={() => setProviderType(t)}
            style={{
              border: `1px solid ${providerType === t ? c.color : 'var(--border)'}`,
              background: providerType === t ? c.bg : 'transparent',
              color: providerType === t ? c.color : 'var(--text-muted)',
              fontWeight: 700,
            }}
          >
            {c.label}
          </Button>
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
          <input
            type="checkbox"
            checked={callTaker}
            onChange={e => {
              const v = e.target.checked;
              setCallTaker(v);
              if (v) setIsDayDoc(false);
            }}
            style={{ accentColor: '#0ea5e9' }}
          />
          Call Taker
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-muted)', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={isDayDoc}
            onChange={e => {
              const v = e.target.checked;
              setIsDayDoc(v);
              if (v) setCallTaker(false);
            }}
            style={{ accentColor: '#8b5cf6' }}
          />
          Day Doc
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
    </Modal>
  );
}
