'use client';

import { useState, useEffect, use } from 'react';
import Link from 'next/link';

interface ProviderDetail {
  id: string;
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

const EMPLOYMENT_OPTIONS = [
  { value: 'full_time', label: 'Full Time' },
  { value: 'part_time', label: 'Part Time' },
  { value: 'employed', label: 'Employed' },
  { value: 'per_diem', label: 'Per Diem' },
  { value: 'locums', label: 'Locums' },
  { value: 'contract', label: 'Contract' },
];

export default function ProviderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [provider, setProvider] = useState<ProviderDetail | null>(null);
  const [tab, setTab] = useState<Tab>('profile');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(`/api/scheduling/providers/${id}`).then(r => r.json()).then(setProvider);
  }, [id]);

  const save = async (updates: Record<string, unknown>) => {
    setSaving(true);
    const res = await fetch(`/api/scheduling/providers/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    setProvider(await res.json());
    setSaving(false);
  };

  if (!provider) return <div style={{ padding: 40, color: 'var(--text-muted)' }}>Loading...</div>;

  const prof = provider.provider_employment_profiles?.[0] || null;
  const tc = TYPE_COLORS[provider.provider_type] || TYPE_COLORS.other;

  const TABS: { key: Tab; label: string }[] = [
    { key: 'profile', label: 'Profile' },
    { key: 'scheduling', label: 'Employment & Scheduling' },
    { key: 'sites', label: 'Sites & Credentials' },
    { key: 'availability', label: 'Availability' },
    { key: 'history', label: 'Assignment History' },
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
          }}>{t.label}</button>
        ))}
      </div>

      {/* Tab content */}
      {tab === 'profile' && <ProfileTab provider={provider} onSave={save} />}
      {tab === 'scheduling' && prof && <SchedulingTab profile={prof} onSave={save} />}
      {tab === 'sites' && <SitesTab credentials={provider.provider_site_credentials || []} />}
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
function SchedulingTab({ profile, onSave }: { profile: EmploymentProfile; onSave: (u: Record<string, unknown>) => void }) {
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
    });
  };

  return (
    <div style={{ maxWidth: 640 }}>
      <SectionLabel>Employment</SectionLabel>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
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
function SitesTab({ credentials }: { credentials: SiteCredential[] }) {
  if (credentials.length === 0) {
    return (
      <div style={{ color: 'var(--text-dim)', fontStyle: 'italic', padding: '20px 0' }}>
        No site credentials configured yet. Add sites and then assign this provider.
      </div>
    );
  }
  return (
    <div style={{ maxWidth: 640 }}>
      {credentials.map(c => (
        <div key={c.id} style={{
          background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 10,
          padding: '14px 18px', marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{c.sites?.name || c.site_id}</div>
            <div style={{ fontSize: 11, color: 'var(--text-dim)', display: 'flex', gap: 10, marginTop: 3 }}>
              {c.credentialed && <span>Credentialed</span>}
              {c.can_take_call && <span>Call</span>}
              {c.can_take_weekend_call && <span>Weekend</span>}
              {c.can_take_holiday_call && <span>Holiday</span>}
            </div>
          </div>
          <span style={{
            fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 6,
            background: c.is_active ? 'rgba(16,185,129,0.12)' : 'rgba(100,116,139,0.12)',
            color: c.is_active ? '#10b981' : '#64748b',
          }}>{c.is_active ? 'Active' : 'Inactive'}</span>
        </div>
      ))}
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

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-dim)', letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 10, marginTop: 8 }}>
      {children}
    </div>
  );
}
