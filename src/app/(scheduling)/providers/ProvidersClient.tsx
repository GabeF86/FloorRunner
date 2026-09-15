'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { cachedFetch, invalidateCache } from '@/lib/clientCache';
import Link from 'next/link';
import { isValidEmail } from '@/lib/validation/providers';
import { interpretListRead } from './listRead';
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
    // Stated WORKING-DAYS FTE (patch43); null ⇒ same as fte_value.
    work_days_fte: number | null;
    call_taker: boolean;
    partial_call_taker: boolean;
    is_shareholder: boolean;
    is_partner_track: boolean;
    home_site_id: string | null;
    fellowship_primary: string | null;
  }[] | null;
}

interface Site {
  id: string;
  name: string;
  short_name: string | null;
}

// Provider-type identity colours. Duplicated VERBATIM in
// providers/[id]/page.tsx, and its first three rows plus the `other` fallback
// in requests/page.tsx — a provider is recognised by this colour on all three
// screens, so the copies change together or not at all.
//
// They used to be literals, defended as "data, not styling". That was half
// right: the ROLE (physician is warm, CRNA is blue) is data and is preserved
// below. The VALUES were not — all seven were dark-theme hexes rendered on the
// light default, where #f59e0b measures ~2.2:1 on white and fails AA as 11px
// avatar ink. A token keeps the identity and fixes the contrast in both themes,
// which a fixed hex cannot do for two backgrounds at once.
//
// Seven types, seven distinct tokens: the six chromatic accents plus the
// neutral ink. The tint is derived from the same token at 15% rather than
// hand-mixed, so a type's chip and its avatar can never drift apart, and
// color-mix is used because `var(--warn)15` is not a colour.
const TYPE_COLORS: Record<string, { color: string; bg: string; label: string }> = {
  physician: { color: 'var(--warn)',       bg: 'color-mix(in srgb, var(--warn) 15%, transparent)',       label: 'Physician' },
  crna:      { color: 'var(--blue)',       bg: 'color-mix(in srgb, var(--blue) 15%, transparent)',       label: 'CRNA' },
  aa:        { color: 'var(--indigo)',     bg: 'color-mix(in srgb, var(--indigo) 15%, transparent)',     label: 'AA' },
  resident:  { color: 'var(--ok)',         bg: 'color-mix(in srgb, var(--ok) 15%, transparent)',         label: 'Resident' },
  fellow:    { color: 'var(--info)',       bg: 'color-mix(in srgb, var(--info) 15%, transparent)',       label: 'Fellow' },
  locums:    { color: 'var(--danger)',     bg: 'color-mix(in srgb, var(--danger) 15%, transparent)',     label: 'Locums' },
  other:     { color: 'var(--text-muted)', bg: 'color-mix(in srgb, var(--text-muted) 15%, transparent)', label: 'Other' },
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

/** How long the search box sits idle before the roster is refetched. */
const SEARCH_DEBOUNCE_MS = 250;

export interface ProvidersClientProps {
  /** Rendered by the server in the same request as the page shell. */
  initialProviders: Provider[];
  initialSites: Site[];
  orgId: string;
  /** Set when the server read failed; shown instead of an empty roster. */
  loadError: string | null;
}

export default function ProvidersClient(
  { initialProviders, initialSites, orgId, loadError }: ProvidersClientProps,
) {
  const router = useRouter();
  const [providers, setProviders] = useState<Provider[]>(initialProviders);
  const [sites, setSites] = useState<Site[]>(initialSites);
  // `loading` starts FALSE: the rows are already on screen. Starting true
  // would paint a spinner over data the user can see, which is the exact
  // flash this refactor removes.
  const [loading, setLoading] = useState(false);
  const [orgError, setOrgError] = useState<string | null>(loadError);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [sitesError, setSitesError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  // The query the roster is actually fetched for — `search` lags behind it by
  // SEARCH_DEBOUNCE_MS so typing doesn't fire one request per keystroke.
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('active');
  const [homeSiteFilter, setHomeSiteFilter] = useState('');
  const [credentialedSiteFilter, setCredentialedSiteFilter] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [showAdd, setShowAdd] = useState(false);

  // Monotonic id of the newest roster request in flight. A slow earlier
  // response must never overwrite a newer one's results (type "smith" fast and
  // the "s" response can land after the "smith" one).
  const providersReq = useRef(0);
  // The effects below re-run whenever a filter changes, and they also run once
  // on mount — which would immediately refetch the list the server just sent
  // and reintroduce the very waterfall this page was converted to avoid. The
  // first run is skipped; every later one is a real filter change.
  const seeded = useRef(true);

  // The organization used to be fetched here and every other query gated
  // behind it (`if (!orgId) return`) — a round trip to learn an id that never
  // changes, delaying everything behind it on every navigation. The server
  // component resolves it now and passes it in.

  // Debounce the search box. loadProviders refetches on every change of its
  // inputs, so typing straight into `search` issues a request per character.
  useEffect(() => {
    const t = setTimeout(() => setSearchQuery(search), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);

  const loadProviders = useCallback(async () => {
    if (!orgId) return;
    const seq = ++providersReq.current;
    const params = new URLSearchParams({ org_id: orgId });
    if (statusFilter) params.set('status', statusFilter);
    if (typeFilter) params.set('provider_type', typeFilter);
    if (searchQuery) params.set('search', searchQuery);
    if (homeSiteFilter) params.set('home_site_id', homeSiteFilter);
    if (credentialedSiteFilter) params.set('credentialed_site_id', credentialedSiteFilter);
    try {
      const res = await fetch('/api/scheduling/providers?' + params);
      const read = interpretListRead<Provider>(res, await res.json().catch(() => null), 'providers');
      if (seq !== providersReq.current) return; // superseded — a newer request owns the state
      if (!read.ok) { setProvidersError(read.error); return; }
      setProviders(read.rows);
      setProvidersError(null);
    } catch (e) {
      if (seq !== providersReq.current) return;
      setProvidersError(e instanceof Error ? e.message : 'Network error loading providers');
    }
  }, [orgId, statusFilter, typeFilter, searchQuery, homeSiteFilter, credentialedSiteFilter]);

  const loadSites = useCallback(async () => {
    if (!orgId) return;
    try {
      const res = await cachedFetch('/api/scheduling/sites?org_id=' + orgId);
      const read = interpretListRead<Site>(res, await res.json().catch(() => null), 'sites');
      if (!read.ok) { setSitesError(read.error); return; }
      setSites(read.rows);
      setSitesError(null);
    } catch (e) {
      setSitesError(e instanceof Error ? e.message : 'Network error loading sites');
    }
  }, [orgId]);

  useEffect(() => {
    if (seeded.current) { seeded.current = false; return; }
    loadProviders();
  }, [loadProviders]);
  // Sites are seeded too and only change from the Sites screen, so this fetch
  // exists for the case where a filter re-render needs them refreshed.
  useEffect(() => {
    if (sites.length > 0) return;
    loadSites();
  }, [loadSites, sites.length]);

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

  // Only ever reached when the organizations read genuinely SUCCEEDED and came
  // back empty — never on a failure, which would invite a duplicate org.
  if (orgError) {
    return (
      <div>
        <PageHeader title="Providers" />
        <Banner tone="error">{orgError} Reload the page to try again.</Banner>
      </div>
    );
  }

  if (!orgId) {
    // orgId comes from the server render, so creating one has to re-run that
    // render rather than set local state — router.refresh() re-fetches the
    // server component in place, keeping the rest of the client state.
    return <NoOrgSetup onCreated={() => router.refresh()} />;
  }

  return (
    <div>
      <PageHeader
        title="Providers"
        subtitle={providersError
          ? 'Provider list unavailable'
          : `${filteredProviders.length} provider${filteredProviders.length !== 1 ? 's' : ''}${roleFilter && providers.length !== filteredProviders.length ? ` of ${providers.length}` : ''}`}
        actions={<Button onClick={() => setShowAdd(true)}>+ Add Provider</Button>}
      />

      {(providersError || sitesError) && (
        <div style={{ marginBottom: 'var(--space-4)', display: 'grid', gap: 'var(--space-2)' }}>
          {providersError && <Banner tone="error">{providersError}</Banner>}
          {/* Sites feed the two site filters and the Home Site column, so a
              failed sites read leaves them empty and needs saying out loud. */}
          {sitesError && <Banner tone="error">{sitesError}</Banner>}
        </div>
      )}

      {/* Filters. Every control carries .fr-field so hover and the keyboard ring
          come from the design system rather than from six near-identical inline
          styles that can only ever express the resting state. */}
      <div style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: 'var(--space-5)', flexWrap: 'wrap' }}>
        <input
          className="fr-field"
          placeholder="Search by name..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ ...fieldStyle, padding: '8px 14px', width: 220, cursor: 'auto' }}
        />
        <select className="fr-field" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} style={fieldStyle}>
          <option value="">All Types</option>
          {Object.entries(TYPE_COLORS).map(([t, c]) => (
            <option key={t} value={t}>{c.label}</option>
          ))}
        </select>
        <select className="fr-field" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={fieldStyle}>
          <option value="">All Statuses</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="on_leave">On Leave</option>
        </select>
        <select
          className="fr-field"
          value={homeSiteFilter}
          onChange={(e) => setHomeSiteFilter(e.target.value)}
          style={fieldStyle}
        >
          <option value="">Home site — Any</option>
          {sites.map(s => (
            <option key={s.id} value={s.id}>Home: {s.short_name || s.name}</option>
          ))}
        </select>
        <select
          className="fr-field"
          value={credentialedSiteFilter}
          onChange={(e) => setCredentialedSiteFilter(e.target.value)}
          style={fieldStyle}
        >
          <option value="">Credentialed at — Any Site</option>
          {sites.map(s => (
            <option key={s.id} value={s.id}>Credentialed at {s.short_name || s.name}</option>
          ))}
        </select>
        <select className="fr-field" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} style={fieldStyle}>
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
              <Link key="name" href={`/providers/${p.id}`} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', textDecoration: 'none', color: 'var(--text)' }}>
                {/* Avatar tint/ink come from TYPE_COLORS — provider-type data, not
                    styling, and shared verbatim with the provider detail page. */}
                <div style={{
                  width: 32, height: 32, borderRadius: 'var(--radius-sm)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 'var(--fs-xs)', fontWeight: 800, background: tc.bg, color: tc.color, flexShrink: 0,
                }}>{p.initials}</div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700 }}>{p.first_name} {p.last_name}</div>
                  {p.email && <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>{p.email}</div>}
                </div>
              </Link>,
              <span key="type" style={{
                display: 'inline-block', lineHeight: 1.5,
                fontSize: 'var(--fs-xs)', fontWeight: 700, padding: '2px 8px', borderRadius: 'var(--radius-sm)',
                background: tc.bg, color: tc.color, whiteSpace: 'nowrap',
              }}>{tc.label}</span>,
              <Badge key="status" tone={STATUS_TONES[p.status] || 'neutral'}>{p.status.replace('_', ' ')}</Badge>,
              EMPLOYMENT_OPTIONS.find(o => o.value === prof?.employment_status)?.label || prof?.employment_status?.replace(/_/g, ' ') || '—',
              /* FTE cell. When a separate WORKING-DAYS FTE is stated (patch43)
                 the cell shows "call / work-days" so the roster never reads as
                 though a 0.66-call physician also works 0.66 of the days. */
              prof?.fte_value == null ? '—' : prof.work_days_fte == null
                ? Number(prof.fte_value).toFixed(2)
                : (
                  <span
                    key="fte"
                    // Two figures read as one column: tabular digits and no wrap,
                    // so "0.66 / 1.00" never breaks across lines mid-pair.
                    style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
                    title={`Call FTE ${Number(prof.fte_value).toFixed(2)} (pro-rates call) · Working-days FTE ${Number(prof.work_days_fte).toFixed(2)} (share of working days they must be scheduled)`}
                  >
                    {Number(prof.fte_value).toFixed(2)}
                    <span style={{ color: 'var(--text-faint)' }}>{' / '}</span>
                    {Number(prof.work_days_fte).toFixed(2)}
                  </span>
                ),
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
          empty={providersError ? (
            // A failed read must never read as a confirmed "no providers".
            <EmptyState
              icon="!"
              title="Could not load providers"
              hint={providersError}
            />
          ) : (
            <EmptyState
              icon="◆"
              title="No providers found"
              hint="Add your first provider, or loosen the search and filters to see more of the roster."
            />
          )}
        />
      </Card>

      {showAdd && <AddProviderModal orgId={orgId} sites={sites} onClose={() => setShowAdd(false)} onAdded={() => { setShowAdd(false); loadProviders(); }} />}
    </div>
  );
}

/** Resting look of a filter control; hover and focus come from .fr-field. */
const fieldStyle: React.CSSProperties = {
  padding: '8px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--bg-deep)', color: 'var(--text)', fontSize: 'var(--fs-sm)',
  fontFamily: 'inherit', cursor: 'pointer',
};

// ── No Org Setup ──────────────────────────────────────────────────────────────
function NoOrgSetup({ onCreated }: { onCreated: (id: string) => void }) {
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);

  const create = async () => {
    if (!name.trim()) return;
    setCreating(true);
    invalidateCache('/api/scheduling/organizations');
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
        className="fr-field"
        placeholder="Organization name (e.g. Main Line Anesthesia)"
        value={name} onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && create()}
        style={{
          width: '100%', padding: '12px 16px', borderRadius: 'var(--radius-sm)',
          border: '1px solid var(--border)', background: 'var(--bg-deep)', color: 'var(--text)',
          fontSize: 'var(--fs-md)', fontFamily: 'inherit', marginBottom: 'var(--space-3)',
        }}
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
    width: '100%', padding: '10px 12px', borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--border)', background: 'var(--bg-deep)',
    color: 'var(--text)', fontSize: 'var(--fs-md)', fontFamily: 'inherit',
    marginBottom: 'var(--space-3)',
  };
  const labelStyle: React.CSSProperties = { fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', display: 'block', marginBottom: 'var(--space-1)', fontWeight: 600, letterSpacing: 0.5 };
  const errorStyle: React.CSSProperties = { fontSize: 'var(--fs-xs)', color: 'var(--danger)', marginBottom: 'var(--space-2)', marginTop: 2 };
  /** Checkbox rows share one resting style; only the accent differs. */
  const toggleStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
    fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', cursor: 'pointer',
    userSelect: 'none',
  };

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
        <div style={{ marginBottom: 'var(--space-4)' }}>
          <Banner tone="error">{error}</Banner>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)', marginBottom: 'var(--space-3)' }}>
        <div>
          <label style={labelStyle}>First Name *</label>
          <input
            className="fr-field"
            style={{ ...inputStyle, border: `1px solid ${errors.firstName ? 'var(--danger)' : 'var(--border)'}`, marginBottom: errors.firstName ? 2 : 12 }}
            placeholder="Jane" value={firstName} onChange={e => setFirstName(e.target.value)}
          />
          {errors.firstName && <div style={errorStyle}>{errors.firstName}</div>}
        </div>
        <div>
          <label style={labelStyle}>Last Name *</label>
          <input
            className="fr-field"
            style={{ ...inputStyle, border: `1px solid ${errors.lastName ? 'var(--danger)' : 'var(--border)'}`, marginBottom: errors.lastName ? 2 : 12 }}
            placeholder="Smith" value={lastName} onChange={e => setLastName(e.target.value)}
          />
          {errors.lastName && <div style={errorStyle}>{errors.lastName}</div>}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
        <div>
          <label style={labelStyle}>Email</label>
          <input
            className="fr-field"
            style={{ ...inputStyle, border: `1px solid ${errors.email ? 'var(--danger)' : 'var(--border)'}`, marginBottom: errors.email ? 2 : 12 }}
            placeholder="jane.smith@hospital.org" value={email} onChange={e => setEmail(e.target.value)}
          />
          {errors.email && <div style={errorStyle}>{errors.email}</div>}
        </div>
        <div>
          <label style={labelStyle}>Phone</label>
          <input className="fr-field" style={inputStyle} placeholder="(555) 123-4567" value={phone} onChange={e => setPhone(e.target.value)} />
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
        <div>
          <label style={labelStyle}>NPI</label>
          <input className="fr-field" style={inputStyle} placeholder="1234567890" value={npi} onChange={e => setNpi(e.target.value)} />
        </div>
        <div>
          <label style={labelStyle}>Employee ID</label>
          <input className="fr-field" style={inputStyle} placeholder="E12345" value={employeeId} onChange={e => setEmployeeId(e.target.value)} />
        </div>
      </div>

      <label style={labelStyle}>Provider Type</label>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--space-1)', marginBottom: 'var(--space-4)' }}>
        {Object.entries(TYPE_COLORS).map(([t, c]) => (
          <Button
            key={t}
            variant="secondary"
            size="sm"
            onClick={() => setProviderType(t)}
            style={{
              // Only the SELECTED type paints its identity colour here. An
              // unselected one declares no background and no border, because
              // those are the two properties .fr-btn-secondary:hover moves and
              // an inline value outranks the class — spelling them out, as this
              // did, left the whole picker inert under the cursor. The class's
              // resting values are the same transparent/--border it stated.
              ...(providerType === t ? { background: c.bg, border: `1px solid ${c.color}` } : null),
              color: providerType === t ? c.color : 'var(--text-muted)',
              fontWeight: 700,
            }}
          >
            {c.label}
          </Button>
        ))}
      </div>

      <label style={labelStyle}>Employment Status</label>
      <select className="fr-field" value={employmentStatus} onChange={e => setEmploymentStatus(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
        {EMPLOYMENT_OPTIONS.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>

      <label style={labelStyle}>Home Address</label>
      <input className="fr-field" style={inputStyle} placeholder="123 Main St, City, State" value={homeAddress} onChange={e => setHomeAddress(e.target.value)} />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)', marginBottom: 'var(--space-3)' }}>
        <div>
          <label style={labelStyle}>Home Hospital / Surgery Center</label>
          <select className="fr-field" value={homeSiteId} onChange={e => setHomeSiteId(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
            <option value="">— None —</option>
            {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div>
          <label style={labelStyle}>Start Date with Company</label>
          <input className="fr-field" type="date" style={inputStyle} value={startDate} onChange={e => setStartDate(e.target.value)} />
        </div>
      </div>

      {/* Checkbox accents were four literals — and #0ea5e9 is the DARK-mode blue,
          so on the light default it was both off-system and short of AA. Each is
          now the token that means the thing: brand blue for the call flag, the
          second accent for its mutually-exclusive twin, ok/warn for the two
          partner states. accent-color resolves var() natively, so both themes
          track their own value. */}
      <div style={{ display: 'flex', gap: 'var(--space-4)', marginBottom: 'var(--space-4)', flexWrap: 'wrap' }}>
        <label style={toggleStyle}>
          <input
            type="checkbox"
            checked={callTaker}
            onChange={e => {
              const v = e.target.checked;
              setCallTaker(v);
              if (v) setIsDayDoc(false);
            }}
            style={{ accentColor: 'var(--blue)', cursor: 'pointer' }}
          />
          Call Taker
        </label>
        <label style={toggleStyle}>
          <input
            type="checkbox"
            checked={isDayDoc}
            onChange={e => {
              const v = e.target.checked;
              setIsDayDoc(v);
              if (v) setCallTaker(false);
            }}
            style={{ accentColor: 'var(--indigo)', cursor: 'pointer' }}
          />
          Day Doc
        </label>
        <label style={toggleStyle}>
          <input type="checkbox" checked={isPartner} onChange={e => { setIsPartner(e.target.checked); if (e.target.checked) setIsPartnerTrack(false); }} style={{ accentColor: 'var(--ok)', cursor: 'pointer' }} />
          Partner
        </label>
        <label style={toggleStyle}>
          <input type="checkbox" checked={isPartnerTrack} onChange={e => { setIsPartnerTrack(e.target.checked); if (e.target.checked) setIsPartner(false); }} style={{ accentColor: 'var(--warn)', cursor: 'pointer' }} />
          Partner Track
        </label>
      </div>
    </Modal>
  );
}
