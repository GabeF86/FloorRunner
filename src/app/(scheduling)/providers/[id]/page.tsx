'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';

interface ProviderDetail {
  id: string;
  organization_id: string;
  first_name: string;
  last_name: string;
  preferred_display_name: string;
  short_display_name: string;
  initials: string;
  provider_type: string;
  status: string;
  email: string | null;
  phone: string | null;
  home_address: string | null;
  npi: string | null;
  employee_id: string | null;
  start_date: string | null;
  years_with_group: number | null;
  notes_admin_only: string | null;
  provider_employment_profiles: EmploymentProfile[] | null;
  provider_site_credentials: SiteCredential[] | null;
}

interface EmploymentProfile {
  employment_status: string;
  fte_value: number;
  is_shareholder: boolean;
  is_partner_track: boolean;
  pto_weeks: number;
  max_weekly_hours: number | null;
  max_monthly_calls: number | null;
  call_taker: boolean;
  partial_call_taker: boolean;
  holiday_call_eligible: boolean;
  weekend_call_eligible: boolean;
  night_call_eligible: boolean;
  backup_call_eligible: boolean;
  late_shift_eligible: boolean;
  can_supervise_crnas: boolean;
  can_work_solo: boolean;
  can_cover_offsite: boolean;
  home_site_id: string | null;
  fellowship_primary: string | null;
  fellowships: string[];
  float_eligible: boolean;
  trauma_eligible: boolean;
  ob_eligible: boolean;
  cardiac_eligible: boolean;
  neuro_eligible: boolean;
  endo_eligible: boolean;
  ep_eligible: boolean;
  max_consecutive_calls: number | null;
  weekend_frequency_target: number | null;
  holiday_frequency_target: number | null;
  friday_frequency_target: number | null;
  scheduling_notes: string | null;
}

interface SiteCredential {
  id: string;
  site_id: string;
  is_active: boolean;
  credentialed: boolean;
  can_take_call: boolean;
  can_take_weekend_call: boolean;
  can_take_holiday_call: boolean;
  sites?: { id: string; name: string; short_name: string | null };
}

type Tab = 'profile' | 'scheduling' | 'sites' | 'availability' | 'history';

const TYPE_COLORS: Record<string, { color: string; bg: string; label: string }> = {
  physician: { color: '#f59e0b', bg: 'rgba(245,158,11,0.15)', label: 'Physician' },
  crna:      { color: '#0ea5e9', bg: 'rgba(14,165,233,0.15)', label: 'CRNA' },
  aa:        { color: '#8b5cf6', bg: 'rgba(139,92,246,0.15)', label: 'AA' },
  resident:  { color: '#34d399', bg: 'rgba(52,211,153,0.15)', label: 'Resident' },
  fellow:    { color: '#a78bfa', bg: 'rgba(167,139,250,0.15)', label: 'Fellow' },
  locums:    { color: '#fb923c', bg: 'rgba(251,146,60,0.15)', label: 'Locums' },
  other:     { color: '#94a3b8', bg: 'rgba(148,163,184,0.15)', label: 'Other' },
};

// Default profile used when a provider has no employment profile row yet.
// On first save, the API will INSERT a row for them.
const EMPTY_PROFILE: EmploymentProfile = {
  employment_status: 'full_time',
  fte_value: 1.0,
  is_shareholder: false,
  is_partner_track: false,
  pto_weeks: 0,
  max_weekly_hours: null,
  max_monthly_calls: null,
  call_taker: false,
  partial_call_taker: false,
  holiday_call_eligible: true,
  weekend_call_eligible: true,
  night_call_eligible: true,
  backup_call_eligible: true,
  late_shift_eligible: true,
  can_supervise_crnas: false,
  can_work_solo: false,
  can_cover_offsite: false,
  home_site_id: null,
  fellowship_primary: null,
  fellowships: [],
  float_eligible: true,
  trauma_eligible: false,
  ob_eligible: false,
  cardiac_eligible: false,
  neuro_eligible: false,
  endo_eligible: false,
  ep_eligible: false,
  max_consecutive_calls: null,
  weekend_frequency_target: null,
  holiday_frequency_target: null,
  friday_frequency_target: null,
  scheduling_notes: null,
};

const EMPLOYMENT_OPTIONS = [
  { value: 'full_time', label: 'Full Time' },
  { value: 'part_time', label: 'Part Time' },
  { value: 'per_diem', label: 'Per Diem' },
  { value: 'locums', label: 'Locums' },
  { value: 'contract', label: 'Contract' },
];

export default function ProviderDetailPage({ params }: { params: { id: string } }) {
  const { id } = params;
  const [provider, setProvider] = useState<ProviderDetail | null>(null);
  const [sites, setSites] = useState<Array<{ id: string; name: string; short_name: string | null }>>([]);
  const [tab, setTab] = useState<Tab>('profile');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(`/api/scheduling/providers/${id}`, { cache: 'no-store' })
      .then(r => r.json())
      .then(setProvider);
  }, [id]);

  // Load all sites for the provider's org so we can offer them in dropdowns.
  useEffect(() => {
    if (!provider?.organization_id) return;
    fetch(`/api/scheduling/sites?org_id=${provider.organization_id}`)
      .then(r => r.json())
      .then(setSites);
  }, [provider?.organization_id]);

  const reload = async () => {
    try {
      const res = await fetch(`/api/scheduling/providers/${id}`, { cache: 'no-store' });
      if (!res.ok) return;
      setProvider(await res.json());
    } catch {
      // Silent: keep showing the last-known provider data rather than wiping it.
    }
  };

  const save = async (updates: Record<string, unknown>) => {
    setSaving(true);
    try {
      const res = await fetch(`/api/scheduling/providers/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(`Save failed: ${data.error || res.statusText}`);
        return;
      }
      setProvider(data);
    } catch (e) {
      alert(`Save failed: ${e instanceof Error ? e.message : 'network error'}`);
    } finally {
      setSaving(false);
    }
  };

  if (!provider) return <div style={{ padding: 40, color: 'var(--text-muted)' }}>Loading...</div>;

  const prof = provider.provider_employment_profiles?.[0] || null;
  const tc = TYPE_COLORS[provider.provider_type] || TYPE_COLORS.other;

  const TABS: { key: Tab; label: string; info: string }[] = [
    { key: 'profile', label: 'Profile', info: 'Basic provider information — name, contact details, NPI, employee ID, and admin notes.' },
    { key: 'scheduling', label: 'Employment & Scheduling', info: 'Employment status, FTE, call eligibility, specialty capabilities, and scheduling constraints. These settings determine what shifts this provider can be assigned to.' },
    { key: 'sites', label: 'Sites & Credentials', info: 'Which hospitals and surgery centers this provider is credentialed at, and site-specific call eligibility overrides.' },
    { key: 'availability', label: 'Availability', info: 'PTO, blocked dates, recurring unavailability, and leave status. The scheduler checks this before assigning shifts.' },
    { key: 'history', label: 'Assignment History', info: 'Past shift and call assignments for this provider, including burden tracking and fairness metrics.' },
  ];

  return (
    <div style={{ padding: '24px 32px' }}>
      {/* Breadcrumb */}
      <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 16 }}>
        <Link href="/providers" style={{ color: '#0ea5e9', textDecoration: 'none' }}>Providers</Link>
        <span style={{ margin: '0 6px' }}>/</span>
        <span>{provider.first_name} {provider.last_name}</span>
      </div>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 24 }}>
        <div style={{
          width: 56, height: 56, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 20, fontWeight: 800, background: tc.bg, color: tc.color, border: `1px solid ${tc.color}30`,
        }}>{provider.initials}</div>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)' }}>{provider.first_name} {provider.last_name}</h1>
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 6, background: tc.bg, color: tc.color }}>
              {tc.label}
            </span>
            <span style={{
              fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 6,
              background: provider.status === 'active' ? 'rgba(16,185,129,0.12)' : 'rgba(100,116,139,0.12)',
              color: provider.status === 'active' ? '#10b981' : '#64748b', textTransform: 'capitalize',
            }}>{provider.status}</span>
            {prof?.fellowship_primary && (
              <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 6, background: 'rgba(167,139,250,0.12)', color: '#a78bfa' }}>
                {prof.fellowship_primary}
              </span>
            )}
          </div>
        </div>
        {saving && <span style={{ fontSize: 11, color: '#0ea5e9', marginLeft: 'auto' }}>Saving...</span>}
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--border)', marginBottom: 24 }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            padding: '10px 18px', fontSize: 13, fontWeight: 700, cursor: 'pointer',
            background: 'none', border: 'none', borderBottom: `2px solid ${tab === t.key ? '#0ea5e9' : 'transparent'}`,
            color: tab === t.key ? '#0ea5e9' : 'var(--text-muted)', transition: 'all 0.15s',
            display: 'flex', alignItems: 'center', gap: 5,
          }}>
            {t.label}
            {tab === t.key && <InfoTip text={t.info} />}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === 'profile' && <ProfileTab provider={provider} onSave={save} />}
      {tab === 'scheduling' && <SchedulingTab profile={prof || EMPTY_PROFILE} sites={sites} onSave={save} />}
      {tab === 'sites' && <SitesTab providerId={id} credentials={provider.provider_site_credentials || []} sites={sites} onChanged={reload} />}
      {tab === 'availability' && <PlaceholderTab label="Availability / PTO" />}
      {tab === 'history' && <PlaceholderTab label="Assignment History" />}
    </div>
  );
}

// ── Profile Tab ─────────────────────────────────────────────────────────────
function ProfileTab({ provider, onSave }: { provider: ProviderDetail; onSave: (u: Record<string, unknown>) => void }) {
  const [firstName, setFirstName] = useState(provider.first_name);
  const [lastName, setLastName] = useState(provider.last_name);
  const [email, setEmail] = useState(provider.email || '');
  const [phone, setPhone] = useState(provider.phone || '');
  const [npi, setNpi] = useState(provider.npi || '');
  const [employeeId, setEmployeeId] = useState(provider.employee_id || '');
  const [startDate, setStartDate] = useState(provider.start_date || '');
  const [notes, setNotes] = useState(provider.notes_admin_only || '');

  // Sync local state when the parent passes a new provider (e.g. after save).
  useEffect(() => {
    setFirstName(provider.first_name);
    setLastName(provider.last_name);
    setEmail(provider.email || '');
    setPhone(provider.phone || '');
    setNpi(provider.npi || '');
    setEmployeeId(provider.employee_id || '');
    setStartDate(provider.start_date || '');
    setNotes(provider.notes_admin_only || '');
  }, [provider]);

  const handleSave = () => {
    onSave({
      first_name: firstName, last_name: lastName,
      email: email || null, phone: phone || null,
      npi: npi || null, employee_id: employeeId || null,
      start_date: startDate || null, notes_admin_only: notes || null,
    });
  };

  return (
    <div style={{ maxWidth: 640 }}>
      <SectionLabel>Basic Information</SectionLabel>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
        <Field label="First Name" value={firstName} onChange={setFirstName} />
        <Field label="Last Name" value={lastName} onChange={setLastName} />
        <Field label="Email" value={email} onChange={setEmail} />
        <Field label="Phone" value={phone} onChange={setPhone} />
        <Field label="NPI" value={npi} onChange={setNpi} />
        <Field label="Employee ID" value={employeeId} onChange={setEmployeeId} />
        <Field label="Start Date" value={startDate} onChange={setStartDate} type="date" />
      </div>

      <SectionLabel>Admin Notes</SectionLabel>
      <textarea
        value={notes} onChange={e => setNotes(e.target.value)}
        placeholder="Internal notes visible only to admins..."
        style={{
          width: '100%', minHeight: 80, padding: '10px 12px', borderRadius: 8,
          border: '1px solid var(--border)', background: 'var(--bg-deep)',
          color: 'var(--text)', fontSize: 13, resize: 'vertical', marginBottom: 16,
        }}
      />

      <button onClick={handleSave} style={saveBtnStyle}>Save Changes</button>
    </div>
  );
}

// ── Scheduling Tab ──────────────────────────────────────────────────────────
function SchedulingTab({ profile, sites, onSave }: { profile: EmploymentProfile; sites: Array<{ id: string; name: string; short_name: string | null }>; onSave: (u: Record<string, unknown>) => void }) {
  const [empStatus, setEmpStatus] = useState(profile.employment_status);
  const [fte, setFte] = useState(String(profile.fte_value));
  const [isPartner, setIsPartner] = useState(profile.is_shareholder);
  const [isPartnerTrack, setIsPartnerTrack] = useState(profile.is_partner_track);
  const [callTaker, setCallTaker] = useState(profile.call_taker);
  const [partialCall, setPartialCall] = useState(profile.partial_call_taker);
  const [weekendElig, setWeekendElig] = useState(profile.weekend_call_eligible);
  const [holidayElig, setHolidayElig] = useState(profile.holiday_call_eligible);
  const [nightElig, setNightElig] = useState(profile.night_call_eligible);
  const [backupElig, setBackupElig] = useState(profile.backup_call_eligible);
  const [lateElig, setLateElig] = useState(profile.late_shift_eligible);
  const [canSupervise, setCanSupervise] = useState(profile.can_supervise_crnas);
  const [canSolo, setCanSolo] = useState(profile.can_work_solo);
  const [floatElig, setFloatElig] = useState(profile.float_eligible);
  const [traumaElig, setTraumaElig] = useState(profile.trauma_eligible);
  const [obElig, setObElig] = useState(profile.ob_eligible);
  const [cardiacElig, setCardiacElig] = useState(profile.cardiac_eligible);
  const [neuroElig, setNeuroElig] = useState(profile.neuro_eligible);
  const [endoElig, setEndoElig] = useState(profile.endo_eligible);
  const [epElig, setEpElig] = useState(profile.ep_eligible);
  const [maxCalls, setMaxCalls] = useState(String(profile.max_monthly_calls ?? ''));
  const [maxConsec, setMaxConsec] = useState(String(profile.max_consecutive_calls ?? ''));
  const [homeSite, setHomeSite] = useState(profile.home_site_id || '');

  // Sync local state when the parent passes a new profile (e.g. after save
  // or when switching between providers). useState initializers only run on
  // mount, so we need this effect to pick up prop changes.
  useEffect(() => {
    setEmpStatus(profile.employment_status);
    setFte(String(profile.fte_value));
    setIsPartner(profile.is_shareholder);
    setIsPartnerTrack(profile.is_partner_track);
    setCallTaker(profile.call_taker);
    setPartialCall(profile.partial_call_taker);
    setWeekendElig(profile.weekend_call_eligible);
    setHolidayElig(profile.holiday_call_eligible);
    setNightElig(profile.night_call_eligible);
    setBackupElig(profile.backup_call_eligible);
    setLateElig(profile.late_shift_eligible);
    setCanSupervise(profile.can_supervise_crnas);
    setCanSolo(profile.can_work_solo);
    setFloatElig(profile.float_eligible);
    setTraumaElig(profile.trauma_eligible);
    setObElig(profile.ob_eligible);
    setCardiacElig(profile.cardiac_eligible);
    setNeuroElig(profile.neuro_eligible);
    setEndoElig(profile.endo_eligible);
    setEpElig(profile.ep_eligible);
    setMaxCalls(String(profile.max_monthly_calls ?? ''));
    setMaxConsec(String(profile.max_consecutive_calls ?? ''));
    setHomeSite(profile.home_site_id || '');
  }, [profile]);

  const handleSave = () => {
    onSave({
      employment_status: empStatus,
      fte_value: parseFloat(fte) || 1.0,
      is_shareholder: isPartner, is_partner_track: isPartnerTrack,
      call_taker: callTaker, partial_call_taker: partialCall,
      weekend_call_eligible: weekendElig, holiday_call_eligible: holidayElig,
      night_call_eligible: nightElig, backup_call_eligible: backupElig,
      late_shift_eligible: lateElig, can_supervise_crnas: canSupervise,
      can_work_solo: canSolo, float_eligible: floatElig, trauma_eligible: traumaElig,
      ob_eligible: obElig, cardiac_eligible: cardiacElig, neuro_eligible: neuroElig,
      endo_eligible: endoElig, ep_eligible: epElig,
      max_monthly_calls: maxCalls ? parseInt(maxCalls) : null,
      max_consecutive_calls: maxConsec ? parseInt(maxConsec) : null,
      home_site_id: homeSite || null,
    });
  };

  return (
    <div style={{ maxWidth: 640 }}>
      <SectionLabel>Employment</SectionLabel>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
        <div>
          <label style={fieldLabelStyle}>Employment Status</label>
          <select value={empStatus} onChange={e => setEmpStatus(e.target.value)} style={fieldInputStyle}>
            {EMPLOYMENT_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <Field label="FTE" value={fte} onChange={setFte} />
      </div>
      <div style={{ marginBottom: 16 }}>
        <label style={fieldLabelStyle}>Home Hospital / Surgery Center</label>
        <select value={homeSite} onChange={e => setHomeSite(e.target.value)} style={fieldInputStyle}>
          <option value="">— None —</option>
          {sites.map(s => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      </div>

      <div style={{ display: 'flex', gap: 16, marginBottom: 16 }}>
        <Toggle label="Partner" checked={isPartner} onChange={(v) => { setIsPartner(v); if (v) setIsPartnerTrack(false); }} />
        <Toggle label="Partner Track" checked={isPartnerTrack} onChange={(v) => { setIsPartnerTrack(v); if (v) setIsPartner(false); }} />
      </div>

      <SectionLabel>Call Eligibility</SectionLabel>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 16 }}>
        <Toggle label="Call Taker" checked={callTaker} onChange={setCallTaker} />
        <Toggle label="Partial Call Taker" checked={partialCall} onChange={setPartialCall} />
        <Toggle label="Weekend Call" checked={weekendElig} onChange={setWeekendElig} />
        <Toggle label="Holiday Call" checked={holidayElig} onChange={setHolidayElig} />
        <Toggle label="Night Call" checked={nightElig} onChange={setNightElig} />
        <Toggle label="Backup Call" checked={backupElig} onChange={setBackupElig} />
        <Toggle label="Late Shift" checked={lateElig} onChange={setLateElig} />
      </div>

      <SectionLabel>Capabilities</SectionLabel>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 16 }}>
        <Toggle label="Can Supervise CRNAs" checked={canSupervise} onChange={setCanSupervise} />
        <Toggle label="Can Work Solo" checked={canSolo} onChange={setCanSolo} />
      </div>

      <SectionLabel>Specialty Eligibility</SectionLabel>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 16 }}>
        <Toggle label="Float" checked={floatElig} onChange={setFloatElig} />
        <Toggle label="Trauma" checked={traumaElig} onChange={setTraumaElig} />
        <Toggle label="OB" checked={obElig} onChange={setObElig} />
        <Toggle label="Cardiac" checked={cardiacElig} onChange={setCardiacElig} />
        <Toggle label="Neuro" checked={neuroElig} onChange={setNeuroElig} />
        <Toggle label="Endoscopy" checked={endoElig} onChange={setEndoElig} />
        <Toggle label="EP Lab" checked={epElig} onChange={setEpElig} />
      </div>

      <SectionLabel>Limits</SectionLabel>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
        <Field label="Max Monthly Calls" value={maxCalls} onChange={setMaxCalls} />
        <Field label="Max Consecutive Calls" value={maxConsec} onChange={setMaxConsec} />
      </div>

      <button onClick={handleSave} style={saveBtnStyle}>Save Changes</button>
    </div>
  );
}

// ── Sites Tab ───────────────────────────────────────────────────────────────
function SitesTab({ providerId, credentials, sites, onChanged }: {
  providerId: string;
  credentials: SiteCredential[];
  sites: Array<{ id: string; name: string; short_name: string | null }>;
  onChanged: () => void;
}) {
  const [addSiteId, setAddSiteId] = useState('');
  const [busy, setBusy] = useState(false);

  const credentialedSiteIds = new Set(credentials.map(c => c.site_id));
  const availableSites = sites.filter(s => !credentialedSiteIds.has(s.id));

  const addSite = async () => {
    if (!addSiteId) return;
    setBusy(true);
    try {
      await fetch(`/api/scheduling/providers/${providerId}/site-credentials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ site_id: addSiteId, credentialed: true, is_active: true }),
      });
      setAddSiteId('');
      onChanged();
    } finally { setBusy(false); }
  };

  const toggleField = async (cred: SiteCredential, field: keyof SiteCredential, value: boolean) => {
    setBusy(true);
    try {
      await fetch(`/api/scheduling/providers/${providerId}/site-credentials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          site_id: cred.site_id,
          is_active: cred.is_active,
          credentialed: cred.credentialed,
          can_take_call: cred.can_take_call,
          can_take_weekend_call: cred.can_take_weekend_call,
          can_take_holiday_call: cred.can_take_holiday_call,
          [field]: value,
        }),
      });
      onChanged();
    } finally { setBusy(false); }
  };

  const removeSite = async (siteId: string) => {
    if (!confirm('Remove this site credential?')) return;
    setBusy(true);
    try {
      await fetch(`/api/scheduling/providers/${providerId}/site-credentials?site_id=${siteId}`, {
        method: 'DELETE',
      });
      onChanged();
    } finally { setBusy(false); }
  };

  return (
    <div style={{ maxWidth: 720 }}>
      {/* Add new site */}
      {availableSites.length > 0 && (
        <div style={{
          display: 'flex', gap: 8, marginBottom: 16, padding: 12,
          background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 10,
        }}>
          <select
            value={addSiteId}
            onChange={e => setAddSiteId(e.target.value)}
            style={{ ...fieldInputStyle, flex: 1 }}
          >
            <option value="">+ Credential at a new site...</option>
            {availableSites.map(s => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          <button
            onClick={addSite}
            disabled={!addSiteId || busy}
            style={{ ...saveBtnStyle, opacity: !addSiteId || busy ? 0.5 : 1 }}
          >
            Add
          </button>
        </div>
      )}

      {credentials.length === 0 ? (
        <div style={{ color: 'var(--text-dim)', fontStyle: 'italic', padding: '20px 0' }}>
          No site credentials configured yet. Use the dropdown above to add one.
        </div>
      ) : (
        credentials.map(c => (
          <div key={c.id} style={{
            background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 10,
            padding: '14px 18px', marginBottom: 8,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>
                {c.sites?.name || c.site_id}
              </div>
              <button
                onClick={() => removeSite(c.site_id)}
                disabled={busy}
                style={{
                  fontSize: 11, fontWeight: 600, color: '#f87171', background: 'none',
                  border: '1px solid rgba(248,113,113,0.3)', borderRadius: 6,
                  padding: '3px 10px', cursor: busy ? 'not-allowed' : 'pointer',
                }}
              >
                Remove
              </button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              <Toggle label="Credentialed" checked={c.credentialed} onChange={v => toggleField(c, 'credentialed', v)} />
              <Toggle label="Active" checked={c.is_active} onChange={v => toggleField(c, 'is_active', v)} />
              <Toggle label="Can Take Call" checked={c.can_take_call} onChange={v => toggleField(c, 'can_take_call', v)} />
              <Toggle label="Weekend Call" checked={c.can_take_weekend_call} onChange={v => toggleField(c, 'can_take_weekend_call', v)} />
              <Toggle label="Holiday Call" checked={c.can_take_holiday_call} onChange={v => toggleField(c, 'can_take_holiday_call', v)} />
            </div>
          </div>
        ))
      )}
    </div>
  );
}

// ── Placeholder Tab ─────────────────────────────────────────────────────────
function PlaceholderTab({ label }: { label: string }) {
  return (
    <div style={{ color: 'var(--text-dim)', fontStyle: 'italic', padding: '20px 0' }}>
      {label} — coming soon
    </div>
  );
}

// ── Shared Components ───────────────────────────────────────────────────────
const fieldLabelStyle: React.CSSProperties = { fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 5, fontWeight: 600, letterSpacing: 0.5 };
const fieldInputStyle: React.CSSProperties = {
  width: '100%', padding: '9px 12px', borderRadius: 8, border: '1px solid var(--border)',
  background: 'var(--bg-deep)', color: 'var(--text)', fontSize: 13,
};
const saveBtnStyle: React.CSSProperties = {
  padding: '10px 24px', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 13,
  background: 'linear-gradient(135deg,#0ea5e9,#6366f1)', color: '#fff', border: 'none',
};

function Field({ label, value, onChange, type }: { label: string; value: string; onChange: (v: string) => void; type?: string }) {
  return (
    <div>
      <label style={fieldLabelStyle}>{label}</label>
      <input type={type || 'text'} value={value} onChange={e => onChange(e.target.value)} style={fieldInputStyle} />
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-muted)', cursor: 'pointer', padding: '4px 0' }}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} style={{ accentColor: '#0ea5e9', width: 15, height: 15 }} />
      {label}
    </label>
  );
}

function InfoTip({ text }: { text: string }) {
  const [show, setShow] = useState(false);
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}
      onClick={(e) => { e.stopPropagation(); setShow(v => !v); }}>
      <span style={{
        width: 16, height: 16, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 10, fontWeight: 800, cursor: 'pointer',
        background: 'rgba(14,165,233,0.15)', color: '#0ea5e9', border: '1px solid rgba(14,165,233,0.3)',
        flexShrink: 0,
      }}>i</span>
      {show && (
        <div style={{
          position: 'absolute', top: '100%', left: '50%', transform: 'translateX(-50%)',
          marginTop: 8, padding: '10px 14px', borderRadius: 8, fontSize: 12, lineHeight: 1.5,
          background: '#1e293b', color: '#e2e8f0', border: '1px solid #334155',
          boxShadow: '0 8px 24px rgba(0,0,0,0.5)', width: 280, zIndex: 300,
          fontWeight: 500, whiteSpace: 'normal',
        }}>
          {text}
        </div>
      )}
    </span>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-dim)', letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 10, marginTop: 8 }}>
      {children}
    </div>
  );
}
