'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import {
  EMPLOYMENT_STATUSES,
  FTE_MAX,
  FTE_MIN,
  PROVIDER_STATUSES,
  PROVIDER_TYPES,
  isValidEmail,
  reasonCodeLabel,
} from '@/lib/validation/providers';
import {
  icuWeekEnd,
  pairIcuRows,
  planIcuEntry,
  ICU_POST_CALL_REASON,
  ICU_WEEK_REASON,
} from '@/lib/icuRotation';
import { SiteShiftTypePicker } from '@/components/ShiftTypePicker';

// Canonical lists used by the Preferences tab. Kept in this file for now —
// when we want them to be admin-configurable they should move into the
// organization settings and be fetched.
const FELLOWSHIP_OPTIONS = [
  'Cardiac', 'Pediatric', 'Regional', 'Chronic Pain', 'Neuro', 'Obstetrics',
] as const;

const ASSIGNMENT_OPTIONS = [
  'GI', 'OB', 'Ortho', 'Neuro', 'Peds', 'ENT', 'General Surgery',
  'Thoracic', 'Cardiac', 'EP', 'Neuro Lap', 'EP Lab', 'Trauma',
] as const;

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
  payroll_id: string | null;
  start_date: string | null;
  years_with_group: number | null;
  notes_admin_only: string | null;
  color_tag: string | null;
  photo_url: string | null;
  provider_employment_profiles: EmploymentProfile[] | null;
  provider_site_credentials: SiteCredential[] | null;
}

interface EmploymentProfile {
  employment_status: string;
  fte_value: number;
  is_shareholder: boolean;
  is_partner_track: boolean;
  is_day_doc: boolean;
  is_icu_doc: boolean;
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
  skills: string[];
  preferred_assignments: string[];
  undesired_assignments: string[];
  preferred_sites: string[];
  undesired_sites: string[];
  trauma_eligible: boolean;
  ob_eligible: boolean;
  cardiac_eligible: boolean;
  endo_eligible: boolean;
  ep_eligible: boolean;
  max_consecutive_calls: number | null;
  weekend_frequency_target: number | null;
  holiday_frequency_target: number | null;
  friday_frequency_target: number | null;
  blocked_dates: string[];
  scheduling_notes: string | null;
  // 7-element boolean array indexed Sun..Sat (matches JS Date.getDay).
  // Editable in the UI only for non-call-takers. Null on legacy rows —
  // treated as all-true.
  available_weekdays: boolean[] | null;
  // Day-doc only: which day-shift codes they'll work (e.g. ['7-3']).
  // Empty = no restriction.
  preferred_day_shift_types: string[];
  // Day-doc only: how many days per week they want scheduled. NULL = no cap.
  days_per_week: number | null;
}

interface SiteCredential {
  id: string;
  site_id: string;
  is_active: boolean;
  credentialed: boolean;
  can_take_call: boolean;
  can_take_weekend_call: boolean;
  can_take_holiday_call: boolean;
  can_take_backup_call: boolean;
  effective_start_date: string | null;
  effective_end_date: string | null;
  allowed_shift_types: string[];
  excluded_shift_types: string[];
  skill_tags: string[];
  notes: string | null;
  sites?: { id: string; name: string; short_name: string | null };
}

type Tab = 'profile' | 'scheduling' | 'preferences' | 'sites' | 'availability' | 'custom' | 'compensation' | 'history';

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
  is_day_doc: false,
  is_icu_doc: false,
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
  skills: [],
  preferred_assignments: [],
  undesired_assignments: [],
  preferred_sites: [],
  undesired_sites: [],
  trauma_eligible: false,
  ob_eligible: false,
  cardiac_eligible: false,
  endo_eligible: false,
  ep_eligible: false,
  max_consecutive_calls: null,
  weekend_frequency_target: null,
  holiday_frequency_target: null,
  friday_frequency_target: null,
  blocked_dates: [],
  scheduling_notes: null,
  available_weekdays: [true, true, true, true, true, true, true],
  preferred_day_shift_types: [],
  days_per_week: null,
};

const EMPLOYMENT_LABELS: Record<string, string> = {
  full_time: 'Full Time',
  part_time: 'Part Time',
  per_diem: 'Per Diem',
  locums: 'Locums',
  contract: 'Contract',
  retired: 'Retired',
  terminated: 'Terminated',
};

// Keep the array reference stable so the `asArray` helper below can normalize
// incoming data coming from Supabase as jsonb (may be null or a plain array).
function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

// Coerce a loaded available_weekdays value (may be null on legacy rows, or
// a shorter array on malformed data) into a guaranteed 7-element boolean
// array indexed Sun..Sat. Missing entries are treated as available.
function normalizeWeekdays(v: boolean[] | null | undefined): boolean[] {
  const out = [true, true, true, true, true, true, true];
  if (Array.isArray(v)) {
    for (let i = 0; i < 7; i++) {
      if (typeof v[i] === 'boolean') out[i] = v[i];
    }
  }
  return out;
}

export default function ProviderDetailPage({ params }: { params: { id: string } }) {
  const { id } = params;
  const [provider, setProvider] = useState<ProviderDetail | null>(null);
  const [sites, setSites] = useState<Array<{ id: string; name: string; short_name: string | null }>>([]);
  // Persist tab selection in the URL hash so reload / hard-refresh preserves
  // the current tab. The hash is the lightest-weight option — no router
  // changes, no history entries per tab switch, survives F5 / Cmd+Shift+R.
  const [tab, setTab] = useState<Tab>(() => {
    if (typeof window === 'undefined') return 'profile';
    const h = window.location.hash.replace(/^#/, '');
    const valid: Tab[] = ['profile', 'scheduling', 'preferences', 'sites', 'availability', 'custom', 'compensation', 'history'];
    return (valid as string[]).includes(h) ? (h as Tab) : 'profile';
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.location.hash.replace(/^#/, '') !== tab) {
      history.replaceState(null, '', `#${tab}`);
    }
  }, [tab]);
  // 'idle' → normal button state. 'saving' → request in flight. 'saved' →
  // request succeeded; shown briefly so the user sees that the click did
  // something. After ~1.5s it drops back to 'idle' automatically.
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/scheduling/providers/${id}`, { cache: 'no-store' });
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setLoadError(data.error || `Failed to load (${res.status})`);
          return;
        }
        setProvider(normalizeProvider(data));
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Failed to load provider');
      }
    })();
    return () => { cancelled = true; };
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
      setProvider(normalizeProvider(await res.json()));
    } catch {
      // Silent: keep showing the last-known provider data rather than wiping it.
    }
  };

  const save = async (updates: Record<string, unknown>) => {
    setSaveState('saving');
    let ok = false;
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
      setProvider(normalizeProvider(data));
      ok = true;
    } catch (e) {
      alert(`Save failed: ${e instanceof Error ? e.message : 'network error'}`);
    } finally {
      if (ok) {
        setSaveState('saved');
        // Revert to idle after a short window so the button can be clicked
        // again for a fresh save with the new state clearly reset.
        setTimeout(() => setSaveState(prev => prev === 'saved' ? 'idle' : prev), 1500);
      } else {
        setSaveState('idle');
      }
    }
  };

  if (loadError) {
    return (
      <div style={{ padding: 40 }}>
        <div style={{ color: '#f87171', fontSize: 14, marginBottom: 12 }}>
          {loadError}
        </div>
        <Link href="/providers" style={{ color: '#0ea5e9', fontSize: 13 }}>← Back to providers</Link>
      </div>
    );
  }
  if (!provider) return <div style={{ padding: 40, color: 'var(--text-muted)' }}>Loading...</div>;

  const prof = provider.provider_employment_profiles?.[0] || null;
  const tc = TYPE_COLORS[provider.provider_type] || TYPE_COLORS.other;

  const TABS: { key: Tab; label: string; info: string }[] = [
    { key: 'profile', label: 'Profile', info: 'Basic provider information — name, contact details, NPI, employee ID, and admin notes.' },
    { key: 'scheduling', label: 'Employment & Scheduling', info: 'Employment status, FTE, call eligibility, specialty capabilities, and scheduling constraints. These settings determine what shifts this provider can be assigned to.' },
    { key: 'preferences', label: 'Preferences & Specialties', info: 'Preferred and undesired shift types or sites, fellowships, skills, and custom blocked dates. The scheduler uses these as soft preferences.' },
    { key: 'sites', label: 'Sites & Credentials', info: 'Which hospitals and surgery centers this provider is credentialed at, effective dates, and site-specific call / shift-type restrictions.' },
    { key: 'availability', label: 'Availability', info: 'PTO schedule, days off, no-call requests (while a request window is open), ICU rotation weeks, and other leave. The scheduler checks this before assigning shifts.' },
    { key: 'custom', label: 'Custom Fields', info: 'Organization-defined extra fields. Configure which fields exist under Settings → Provider Custom Fields.' },
    { key: 'compensation', label: 'Compensation', info: 'ADMIN ONLY — salary, stipends, bonuses, and benefits costs. Currently visible to anyone with app access; will be gated to admins once auth/RLS is in place.' },
    { key: 'history', label: 'Assignment History', info: 'Past shift and call assignments for this provider, including burden tracking and fairness metrics.' },
  ];

  return (
    <div style={{ padding: '14px 22px 28px', maxWidth: 1200 }}>
      {/* Breadcrumb */}
      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-mono), ui-monospace, monospace' }}>
        <Link href="/providers" style={{ color: '#0ea5e9', textDecoration: 'none' }}>providers</Link>
        <span style={{ color: 'var(--text-dim)' }}>/</span>
        <span style={{ color: 'var(--text-muted)' }}>{provider.last_name.toLowerCase()}, {provider.first_name.toLowerCase()}</span>
      </div>

      {/* Header card — single hairline-bordered surface, dense */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 14,
        padding: '12px 14px', marginBottom: 14,
        background: 'var(--bg-surface)', border: '0.5px solid var(--border)', borderRadius: 6,
      }}>
        <div style={{
          width: 44, height: 44, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 14, fontWeight: 800, background: tc.bg, color: tc.color,
          border: `0.5px solid ${tc.color}40`,
          overflow: 'hidden', position: 'relative', flexShrink: 0,
          fontFamily: 'var(--font-mono), ui-monospace, monospace',
        }}>
          {provider.photo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={provider.photo_url}
              alt={`${provider.first_name} ${provider.last_name}`}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
            />
          ) : (
            provider.initials
          )}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)', letterSpacing: -0.2, marginBottom: 3 }}>
            {provider.first_name} {provider.last_name}
          </h1>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            <ChipPill text={tc.label} fg={tc.color} bg={tc.bg} />
            <ChipPill
              text={provider.status.replace('_', ' ')}
              fg={provider.status === 'active' ? '#0e7c52' : '#64748b'}
              bg={provider.status === 'active' ? 'rgba(16,185,129,0.12)' : 'rgba(100,116,139,0.12)'}
            />
            {prof?.fellowship_primary && <ChipPill text={prof.fellowship_primary} fg="#534AB7" bg="rgba(83,74,183,0.10)" />}
            {prof?.employment_status && <ChipPill text={EMPLOYMENT_LABELS[prof.employment_status] || prof.employment_status} fg="#0C447C" bg="rgba(14,165,233,0.10)" />}
          </div>
        </div>
        <SaveIndicator state={saveState} />
      </div>

      {/* Tabs — hairline underline, sentence case, denser */}
      <div style={{ display: 'flex', gap: 0, borderBottom: '0.5px solid var(--border)', marginBottom: 18, flexWrap: 'wrap' }}>
        {TABS.map(t => {
          const isAdminTab = t.key === 'compensation';
          const isActive = tab === t.key;
          const activeColor = isAdminTab ? '#BA7517' : '#0ea5e9';
          return (
            <button key={t.key} onClick={() => setTab(t.key)} style={{
              padding: '7px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
              background: 'none', border: 'none',
              borderBottom: `2px solid ${isActive ? activeColor : 'transparent'}`,
              color: isActive ? activeColor : 'var(--text-muted)', transition: 'all 0.12s',
              display: 'flex', alignItems: 'center', gap: 5,
              marginBottom: -1, // sit on top of the container border
            }}>
              {t.label}
              {isAdminTab && (
                <span style={{
                  fontSize: 8, fontWeight: 800, padding: '1px 4px', borderRadius: 3,
                  background: 'rgba(186,117,23,0.15)', color: '#BA7517', letterSpacing: 0.5,
                  fontFamily: 'var(--font-mono), ui-monospace, monospace',
                }}>
                  ADMIN
                </span>
              )}
              {isActive && <InfoTip text={t.info} />}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      {tab === 'profile' && <ProfileTab provider={provider} saveState={saveState} onSave={save} />}
      {tab === 'scheduling' && <SchedulingTab profile={prof || EMPTY_PROFILE} sites={sites} saveState={saveState} onSave={save} />}
      {tab === 'preferences' && <PreferencesTab profile={prof || EMPTY_PROFILE} sites={sites} saveState={saveState} onSave={save} />}
      {tab === 'sites' && <SitesTab providerId={id} credentials={provider.provider_site_credentials || []} sites={sites} onChanged={reload} />}
      {tab === 'availability' && <AvailabilityTab providerId={id} profile={prof} />}
      {tab === 'custom' && <CustomFieldsTab providerId={id} providerType={provider.provider_type} homeSiteId={prof?.home_site_id ?? null} />}
      {tab === 'compensation' && <CompensationTab providerId={id} />}
      {tab === 'history' && <HistoryTab providerId={id} />}
    </div>
  );
}

// Coerce jsonb arrays that may come back as null.
function normalizeProvider(p: ProviderDetail): ProviderDetail {
  const prof = p.provider_employment_profiles?.[0];
  if (prof) {
    prof.fellowships = asArray<string>(prof.fellowships);
    prof.skills = asArray<string>(prof.skills);
    prof.preferred_assignments = asArray<string>(prof.preferred_assignments);
    prof.undesired_assignments = asArray<string>(prof.undesired_assignments);
    prof.preferred_sites = asArray<string>(prof.preferred_sites);
    prof.undesired_sites = asArray<string>(prof.undesired_sites);
    prof.blocked_dates = asArray<string>(prof.blocked_dates);
    prof.preferred_day_shift_types = asArray<string>(prof.preferred_day_shift_types);
  }
  if (p.provider_site_credentials) {
    for (const c of p.provider_site_credentials) {
      c.allowed_shift_types = asArray<string>(c.allowed_shift_types);
      c.excluded_shift_types = asArray<string>(c.excluded_shift_types);
      c.skill_tags = asArray<string>(c.skill_tags);
    }
  }
  return p;
}

// ── Profile Tab ─────────────────────────────────────────────────────────────
function ProfileTab({ provider, saveState, onSave }: { provider: ProviderDetail; saveState: 'idle' | 'saving' | 'saved'; onSave: (u: Record<string, unknown>) => void }) {
  const [firstName, setFirstName] = useState(provider.first_name);
  const [lastName, setLastName] = useState(provider.last_name);
  const [preferredDisplay, setPreferredDisplay] = useState(provider.preferred_display_name || '');
  const [providerType, setProviderType] = useState(provider.provider_type);
  const [status, setStatus] = useState(provider.status);
  const [email, setEmail] = useState(provider.email || '');
  const [phone, setPhone] = useState(provider.phone || '');
  const [homeAddress, setHomeAddress] = useState(provider.home_address || '');
  const [npi, setNpi] = useState(provider.npi || '');
  const [employeeId, setEmployeeId] = useState(provider.employee_id || '');
  const [payrollId, setPayrollId] = useState(provider.payroll_id || '');
  const [startDate, setStartDate] = useState(provider.start_date || '');
  const [colorTag, setColorTag] = useState(provider.color_tag || '');
  const [photoUrl, setPhotoUrl] = useState(provider.photo_url || '');
  const [notes, setNotes] = useState(provider.notes_admin_only || '');

  // Sync local state when the parent passes a new provider (e.g. after save).
  useEffect(() => {
    setFirstName(provider.first_name);
    setLastName(provider.last_name);
    setPreferredDisplay(provider.preferred_display_name || '');
    setProviderType(provider.provider_type);
    setStatus(provider.status);
    setEmail(provider.email || '');
    setPhone(provider.phone || '');
    setHomeAddress(provider.home_address || '');
    setNpi(provider.npi || '');
    setEmployeeId(provider.employee_id || '');
    setPayrollId(provider.payroll_id || '');
    setStartDate(provider.start_date || '');
    setColorTag(provider.color_tag || '');
    setPhotoUrl(provider.photo_url || '');
    setNotes(provider.notes_admin_only || '');
  }, [provider]);

  const errors: Record<string, string> = {};
  if (!firstName.trim()) errors.firstName = 'Required';
  if (!lastName.trim()) errors.lastName = 'Required';
  if (email.trim() && !isValidEmail(email.trim())) errors.email = 'Not a valid email';

  const canSave = Object.keys(errors).length === 0;

  const handleSave = () => {
    if (!canSave) return;
    onSave({
      first_name: firstName.trim(),
      last_name: lastName.trim(),
      preferred_display_name: preferredDisplay.trim() || null,
      provider_type: providerType,
      status,
      email: email.trim() || null,
      phone: phone.trim() || null,
      home_address: homeAddress.trim() || null,
      npi: npi.trim() || null,
      employee_id: employeeId.trim() || null,
      payroll_id: payrollId.trim() || null,
      start_date: startDate || null,
      color_tag: colorTag.trim() || null,
      photo_url: photoUrl.trim() || null,
      notes_admin_only: notes.trim() || null,
    });
  };

  // Render a tiny swatch beside the color tag input so users see what they typed.
  const swatchValid = /^#[0-9A-F]{6}$/i.test(colorTag.trim());

  return (
    <div style={{ maxWidth: 760 }}>
      <SectionLabel>Identity</SectionLabel>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
        <Field label="First name *" value={firstName} onChange={setFirstName} error={errors.firstName} />
        <Field label="Last name *" value={lastName} onChange={setLastName} error={errors.lastName} />
        <Field label="Preferred display name" value={preferredDisplay} onChange={setPreferredDisplay} hint={`Defaults to "${firstName} ${lastName}"`} />
        <div>
          <label style={fieldLabelStyle}>Provider type</label>
          <select value={providerType} onChange={e => setProviderType(e.target.value)} style={fieldInputStyle}>
            {PROVIDER_TYPES.map(t => (
              <option key={t} value={t}>{TYPE_COLORS[t]?.label ?? t}</option>
            ))}
          </select>
        </div>
        <div>
          <label style={fieldLabelStyle}>Status</label>
          <select value={status} onChange={e => setStatus(e.target.value)} style={fieldInputStyle}>
            {PROVIDER_STATUSES.map(s => (
              <option key={s} value={s}>{s.replace('_', ' ')}</option>
            ))}
          </select>
        </div>
      </div>

      <SectionLabel>Contact</SectionLabel>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
        <Field label="Email" value={email} onChange={setEmail} error={errors.email} />
        <Field label="Phone" value={phone} onChange={setPhone} />
        <div style={{ gridColumn: '1 / -1' }}>
          <Field label="Home address" value={homeAddress} onChange={setHomeAddress} />
        </div>
      </div>

      <SectionLabel>Credentials & employment records</SectionLabel>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 14 }}>
        <Field label="NPI" value={npi} onChange={setNpi} />
        <Field label="Employee ID" value={employeeId} onChange={setEmployeeId} />
        <Field label="Payroll ID" value={payrollId} onChange={setPayrollId} />
        <Field label="Start date" value={startDate} onChange={setStartDate} type="date" />
        <div>
          <label style={fieldLabelStyle}>Color tag</label>
          <div style={{ display: 'flex', gap: 6, alignItems: 'stretch' }}>
            <input
              type="text"
              value={colorTag}
              onChange={(e) => setColorTag(e.target.value)}
              placeholder="#6366f1"
              style={{ ...fieldInputStyle, flex: 1, fontFamily: 'var(--font-mono), ui-monospace, monospace' }}
            />
            <div style={{
              width: 28, borderRadius: 5, border: '0.5px solid var(--border)',
              background: swatchValid ? colorTag.trim() : 'transparent',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--text-dim)', fontSize: 9,
            }}>
              {!swatchValid && '—'}
            </div>
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 2 }}>
            Used in schedule views.
          </div>
        </div>
      </div>

      <SectionLabel>Photo</SectionLabel>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 14 }}>
        <div style={{
          width: 56, height: 56, borderRadius: 6, overflow: 'hidden', flexShrink: 0,
          background: 'var(--bg-deep)', border: '0.5px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 9, color: 'var(--text-dim)', textAlign: 'center', padding: 4,
          fontFamily: 'var(--font-mono), ui-monospace, monospace',
        }}>
          {photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={photoUrl}
              alt="Photo preview"
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
            />
          ) : (
            <span>no photo</span>
          )}
        </div>
        <div style={{ flex: 1 }}>
          <Field
            label="Photo URL"
            value={photoUrl}
            onChange={setPhotoUrl}
            hint="Paste a publicly-accessible image URL. Upload-from-device coming soon."
          />
        </div>
      </div>

      <SectionLabel>Admin notes</SectionLabel>
      <textarea
        value={notes} onChange={e => setNotes(e.target.value)}
        placeholder="Internal notes visible only to admins…"
        style={{
          width: '100%', minHeight: 72, padding: '7px 10px', borderRadius: 5,
          border: '0.5px solid var(--border)', background: 'var(--bg-deep)',
          color: 'var(--text)', fontSize: 12, resize: 'vertical', marginBottom: 14,
          fontFamily: 'inherit', outline: 'none',
        }}
      />

      <SaveButton onClick={handleSave} canSave={canSave} saveState={saveState} />
    </div>
  );
}

// ── Scheduling Tab ──────────────────────────────────────────────────────────
function SchedulingTab({ profile, sites, saveState, onSave }: { profile: EmploymentProfile; sites: Array<{ id: string; name: string; short_name: string | null }>; saveState: 'idle' | 'saving' | 'saved'; onSave: (u: Record<string, unknown>) => void }) {
  const [empStatus, setEmpStatus] = useState(profile.employment_status);
  const [fte, setFte] = useState(String(profile.fte_value));
  const [ptoWeeks, setPtoWeeks] = useState(String(profile.pto_weeks ?? 0));
  const [maxWeeklyHours, setMaxWeeklyHours] = useState(profile.max_weekly_hours == null ? '' : String(profile.max_weekly_hours));
  const [isPartner, setIsPartner] = useState(profile.is_shareholder);
  const [isPartnerTrack, setIsPartnerTrack] = useState(profile.is_partner_track);
  const [isDayDoc, setIsDayDoc] = useState(profile.is_day_doc);
  const [isIcuDoc, setIsIcuDoc] = useState(profile.is_icu_doc);
  const [callTaker, setCallTaker] = useState(profile.call_taker);
  const [partialCall, setPartialCall] = useState(profile.partial_call_taker);
  const [weekendElig, setWeekendElig] = useState(profile.weekend_call_eligible);
  const [holidayElig, setHolidayElig] = useState(profile.holiday_call_eligible);
  const [nightElig, setNightElig] = useState(profile.night_call_eligible);
  const [backupElig, setBackupElig] = useState(profile.backup_call_eligible);
  const [lateElig, setLateElig] = useState(profile.late_shift_eligible);
  const [canSupervise, setCanSupervise] = useState(profile.can_supervise_crnas);
  const [canSolo, setCanSolo] = useState(profile.can_work_solo);
  const [canOffsite, setCanOffsite] = useState(profile.can_cover_offsite);
  const [traumaElig, setTraumaElig] = useState(profile.trauma_eligible);
  const [obElig, setObElig] = useState(profile.ob_eligible);
  const [cardiacElig, setCardiacElig] = useState(profile.cardiac_eligible);
  const [endoElig, setEndoElig] = useState(profile.endo_eligible);
  const [epElig, setEpElig] = useState(profile.ep_eligible);
  const [maxCalls, setMaxCalls] = useState(profile.max_monthly_calls == null ? '' : String(profile.max_monthly_calls));
  const [maxConsec, setMaxConsec] = useState(profile.max_consecutive_calls == null ? '' : String(profile.max_consecutive_calls));
  const [weekendTarget, setWeekendTarget] = useState(profile.weekend_frequency_target == null ? '' : String(profile.weekend_frequency_target));
  const [holidayTarget, setHolidayTarget] = useState(profile.holiday_frequency_target == null ? '' : String(profile.holiday_frequency_target));
  const [fridayTarget, setFridayTarget] = useState(profile.friday_frequency_target == null ? '' : String(profile.friday_frequency_target));
  const [schedulingNotes, setSchedulingNotes] = useState(profile.scheduling_notes || '');
  const [homeSite, setHomeSite] = useState(profile.home_site_id || '');
  // 7 booleans indexed Sun..Sat. Null/missing from the DB is normalized to
  // all-true so legacy rows don't suddenly appear as "unavailable every day".
  const [availableWeekdays, setAvailableWeekdays] = useState<boolean[]>(
    normalizeWeekdays(profile.available_weekdays),
  );
  const [preferredDayShifts, setPreferredDayShifts] = useState<string[]>(profile.preferred_day_shift_types || []);
  const [daysPerWeek, setDaysPerWeek] = useState<string>(profile.days_per_week == null ? '' : String(profile.days_per_week));

  useEffect(() => {
    setEmpStatus(profile.employment_status);
    setFte(String(profile.fte_value));
    setPtoWeeks(String(profile.pto_weeks ?? 0));
    setMaxWeeklyHours(profile.max_weekly_hours == null ? '' : String(profile.max_weekly_hours));
    setIsPartner(profile.is_shareholder);
    setIsPartnerTrack(profile.is_partner_track);
    setIsDayDoc(profile.is_day_doc);
    setIsIcuDoc(profile.is_icu_doc);
    setCallTaker(profile.call_taker);
    setPartialCall(profile.partial_call_taker);
    setWeekendElig(profile.weekend_call_eligible);
    setHolidayElig(profile.holiday_call_eligible);
    setNightElig(profile.night_call_eligible);
    setBackupElig(profile.backup_call_eligible);
    setLateElig(profile.late_shift_eligible);
    setCanSupervise(profile.can_supervise_crnas);
    setCanSolo(profile.can_work_solo);
    setCanOffsite(profile.can_cover_offsite);
    setTraumaElig(profile.trauma_eligible);
    setObElig(profile.ob_eligible);
    setCardiacElig(profile.cardiac_eligible);
    setEndoElig(profile.endo_eligible);
    setEpElig(profile.ep_eligible);
    setMaxCalls(profile.max_monthly_calls == null ? '' : String(profile.max_monthly_calls));
    setMaxConsec(profile.max_consecutive_calls == null ? '' : String(profile.max_consecutive_calls));
    setWeekendTarget(profile.weekend_frequency_target == null ? '' : String(profile.weekend_frequency_target));
    setHolidayTarget(profile.holiday_frequency_target == null ? '' : String(profile.holiday_frequency_target));
    setFridayTarget(profile.friday_frequency_target == null ? '' : String(profile.friday_frequency_target));
    setSchedulingNotes(profile.scheduling_notes || '');
    setHomeSite(profile.home_site_id || '');
    setAvailableWeekdays(normalizeWeekdays(profile.available_weekdays));
    setPreferredDayShifts(profile.preferred_day_shift_types || []);
    setDaysPerWeek(profile.days_per_week == null ? '' : String(profile.days_per_week));
  }, [profile]);

  const fteNum = Number(fte);
  const errors: Record<string, string> = {};
  if (fte.trim() === '' || !Number.isFinite(fteNum) || fteNum < FTE_MIN || fteNum > FTE_MAX) {
    errors.fte = `Must be between ${FTE_MIN} and ${FTE_MAX}`;
  }
  const checkInt = (s: string, key: string) => {
    if (!s) return;
    const n = Number(s);
    if (!Number.isInteger(n) || n < 0) errors[key] = 'Must be a non-negative integer';
  };
  const checkNum = (s: string, key: string) => {
    if (!s) return;
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) errors[key] = 'Must be a non-negative number';
  };
  checkInt(ptoWeeks, 'ptoWeeks');
  checkInt(maxWeeklyHours, 'maxWeeklyHours');
  checkInt(maxCalls, 'maxCalls');
  checkInt(maxConsec, 'maxConsec');
  checkNum(weekendTarget, 'weekendTarget');
  checkNum(holidayTarget, 'holidayTarget');
  checkNum(fridayTarget, 'fridayTarget');

  const canSave = Object.keys(errors).length === 0;

  // Checking either call-taker flag means the provider takes every call type
  // at the normal FTE-driven volume. We only auto-enable on check (not
  // auto-disable on uncheck) so admins can still restrict types manually
  // afterwards without having those edits undone.
  const enableAllCallTypes = () => {
    setWeekendElig(true);
    setHolidayElig(true);
    setNightElig(true);
    setBackupElig(true);
    setLateElig(true);
  };

  const handleSave = () => {
    if (!canSave) return;
    onSave({
      employment_status: empStatus,
      fte_value: fteNum,
      pto_weeks: ptoWeeks === '' ? 0 : parseInt(ptoWeeks, 10),
      max_weekly_hours: maxWeeklyHours === '' ? null : parseInt(maxWeeklyHours, 10),
      is_shareholder: isPartner, is_partner_track: isPartnerTrack,
      is_day_doc: isDayDoc,
      is_icu_doc: isIcuDoc,
      call_taker: callTaker, partial_call_taker: partialCall,
      weekend_call_eligible: weekendElig, holiday_call_eligible: holidayElig,
      night_call_eligible: nightElig, backup_call_eligible: backupElig,
      late_shift_eligible: lateElig, can_supervise_crnas: canSupervise,
      can_work_solo: canSolo, can_cover_offsite: canOffsite,
      trauma_eligible: traumaElig,
      ob_eligible: obElig, cardiac_eligible: cardiacElig,
      endo_eligible: endoElig, ep_eligible: epElig,
      max_monthly_calls: maxCalls === '' ? null : parseInt(maxCalls, 10),
      max_consecutive_calls: maxConsec === '' ? null : parseInt(maxConsec, 10),
      weekend_frequency_target: weekendTarget === '' ? null : Number(weekendTarget),
      holiday_frequency_target: holidayTarget === '' ? null : Number(holidayTarget),
      friday_frequency_target: fridayTarget === '' ? null : Number(fridayTarget),
      scheduling_notes: schedulingNotes.trim() || null,
      home_site_id: homeSite || null,
      // Day-Doc-only fields. When the role isn't Day Doc we reset them so a
      // former Day Doc who gets promoted to call doesn't carry stale
      // Mon/Tue/Wed-only days or a "3 days/week" cap.
      available_weekdays: isDayDoc
        ? availableWeekdays
        : [true, true, true, true, true, true, true],
      preferred_day_shift_types: isDayDoc ? preferredDayShifts : [],
      days_per_week: isDayDoc ? (daysPerWeek === '' ? null : parseInt(daysPerWeek, 10)) : null,
    });
  };

  return (
    <div style={{ maxWidth: 720 }}>
      <SectionLabel>Employment</SectionLabel>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
        <div>
          <label style={fieldLabelStyle}>Employment Status</label>
          <select value={empStatus} onChange={e => setEmpStatus(e.target.value)} style={fieldInputStyle}>
            {EMPLOYMENT_STATUSES.map(s => (
              <option key={s} value={s}>{EMPLOYMENT_LABELS[s] || s}</option>
            ))}
          </select>
        </div>
        <Field label="FTE" value={fte} onChange={setFte} error={errors.fte} hint={`${FTE_MIN}\u2013${FTE_MAX}`} />
        <Field label="PTO Weeks" value={ptoWeeks} onChange={setPtoWeeks} error={errors.ptoWeeks} />
        <Field label="Max Weekly Hours" value={maxWeeklyHours} onChange={setMaxWeeklyHours} error={errors.maxWeeklyHours} />
        <div style={{ gridColumn: '2 / -1' }}>
          <label style={fieldLabelStyle}>Home Hospital / Surgery Center</label>
          <select value={homeSite} onChange={e => setHomeSite(e.target.value)} style={fieldInputStyle}>
            <option value="">— None —</option>
            {sites.map(s => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
        <Toggle label="Partner" checked={isPartner} onChange={(v) => { setIsPartner(v); if (v) setIsPartnerTrack(false); }} />
        <Toggle label="Partner Track" checked={isPartnerTrack} onChange={(v) => { setIsPartnerTrack(v); if (v) setIsPartner(false); }} />
        {/* Day Doc is mutually exclusive with the call-taker flags — you're
            either in the call rotation or you're a scheduled-shift day doc. */}
        <Toggle
          label="Day Doc"
          checked={isDayDoc}
          onChange={(v) => {
            setIsDayDoc(v);
            if (v) {
              setCallTaker(false);
              setPartialCall(false);
            }
          }}
        />
        {/* ICU Doc is orthogonal to the call/day-doc split — it only reveals
            the ICU Rotation entry section on the Availability tab. */}
        <Toggle label="ICU Doc" checked={isIcuDoc} onChange={setIsIcuDoc} />
      </div>

      <SectionLabel>Call Eligibility</SectionLabel>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 10, marginTop: -4 }}>
        Checking Call Taker or Partial Call Taker auto-enables all call types below.
        Uncheck individual types to restrict after.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 16 }}>
        <Toggle
          label="Call Taker"
          checked={callTaker}
          onChange={(v) => {
            setCallTaker(v);
            if (v) {
              enableAllCallTypes();
              setIsDayDoc(false);
            }
          }}
        />
        <Toggle
          label="Partial Call Taker"
          checked={partialCall}
          onChange={(v) => {
            setPartialCall(v);
            if (v) {
              enableAllCallTypes();
              setIsDayDoc(false);
            }
          }}
        />
        <Toggle label="Weekend Call" checked={weekendElig} onChange={setWeekendElig} />
        <Toggle label="Holiday Call" checked={holidayElig} onChange={setHolidayElig} />
        <Toggle label="Night Call" checked={nightElig} onChange={setNightElig} />
        <Toggle label="Backup Call" checked={backupElig} onChange={setBackupElig} />
        <Toggle label="Late Shift" checked={lateElig} onChange={setLateElig} />
      </div>

      {/* Day Doc settings — show only when the provider is flagged Day Doc. */}
      {isDayDoc && (
        <>
          <SectionLabel>Day Doc Settings</SectionLabel>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 10, marginTop: -4 }}>
            Working days, shift preferences, and weekly-day cap for this Day Doc.
            Hidden until the Day Doc role is checked above.
          </div>

          {/* Working days */}
          <label style={{ ...fieldLabelStyle, marginBottom: 6 }}>Available Weekdays</label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
            {/* Render Mon first for readability; storage order is Sun..Sat. */}
            {[1, 2, 3, 4, 5, 6, 0].map(idx => {
              const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
              const selected = availableWeekdays[idx];
              return (
                <button
                  key={idx}
                  type="button"
                  onClick={() => setAvailableWeekdays(prev => {
                    const next = [...prev];
                    next[idx] = !next[idx];
                    return next;
                  })}
                  style={{
                    padding: '7px 14px', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer',
                    border: `1px solid ${selected ? '#0ea5e9' : 'var(--border)'}`,
                    background: selected ? 'rgba(14,165,233,0.15)' : 'transparent',
                    color: selected ? '#0ea5e9' : 'var(--text-dim)',
                    minWidth: 58,
                  }}
                >
                  {labels[idx]}
                </button>
              );
            })}
          </div>

          {/* Days per week */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
            <div>
              <label style={fieldLabelStyle}>Days per Week</label>
              <select
                value={daysPerWeek}
                onChange={e => setDaysPerWeek(e.target.value)}
                style={fieldInputStyle}
              >
                <option value="">— No cap —</option>
                {[1, 2, 3, 4, 5, 6, 7].map(n => (
                  <option key={n} value={String(n)}>{n} day{n === 1 ? '' : 's'} / week</option>
                ))}
              </select>
              <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 3 }}>
                How many days the scheduler should try to place them on each week,
                among the available weekdays above.
              </div>
            </div>
          </div>

          {/* Preferred day-shift types — scoped to the home site, category=regular,
              and D-prefixed codes are excluded because post-call D1..D9 relief
              shifts are call-taker territory (they chain off call placements). */}
          {homeSite ? (
            <SiteShiftTypePicker
              siteId={homeSite}
              label="Preferred Day Shift Types"
              values={preferredDayShifts}
              onChange={setPreferredDayShifts}
              includeCategories={['regular']}
              filter={(st) => !/^D\d+$/i.test(st.code)}
              emptyHint="No day shift types configured at this provider's home site yet."
              accent="#0ea5e9"
            />
          ) : (
            <div style={{ fontSize: 11, color: 'var(--text-dim)', padding: '8px 0', marginBottom: 14 }}>
              Set a Home Hospital above to pick preferred day-shift types.
            </div>
          )}
        </>
      )}

      <SectionLabel>Capabilities</SectionLabel>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 16 }}>
        <Toggle label="Can Supervise CRNAs" checked={canSupervise} onChange={setCanSupervise} />
        <Toggle label="Can Work Solo" checked={canSolo} onChange={setCanSolo} />
        <Toggle label="Can Cover Offsite" checked={canOffsite} onChange={setCanOffsite} />
      </div>

      <SectionLabel>Specialty Eligibility</SectionLabel>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 16 }}>
        <Toggle label="Trauma" checked={traumaElig} onChange={setTraumaElig} />
        <Toggle label="OB" checked={obElig} onChange={setObElig} />
        <Toggle label="Cardiac" checked={cardiacElig} onChange={setCardiacElig} />
        <Toggle label="Endoscopy" checked={endoElig} onChange={setEndoElig} />
        <Toggle label="EP Lab" checked={epElig} onChange={setEpElig} />
      </div>

      <SectionLabel>Limits</SectionLabel>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
        <Field label="Max Monthly Calls" value={maxCalls} onChange={setMaxCalls} error={errors.maxCalls} />
        <Field label="Max Consecutive Calls" value={maxConsec} onChange={setMaxConsec} error={errors.maxConsec} />
      </div>

      <SectionLabel>Frequency Targets</SectionLabel>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 8, marginTop: -4 }}>
        Optional ratios used by the scheduler for fairness tracking. Leave blank to let the group default apply.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 16 }}>
        <Field label="Weekend Target" value={weekendTarget} onChange={setWeekendTarget} error={errors.weekendTarget} hint="e.g. 0.75" />
        <Field label="Holiday Target" value={holidayTarget} onChange={setHolidayTarget} error={errors.holidayTarget} />
        <Field label="Friday Target" value={fridayTarget} onChange={setFridayTarget} error={errors.fridayTarget} />
      </div>

      <SectionLabel>Scheduling Notes</SectionLabel>
      <textarea
        value={schedulingNotes}
        onChange={e => setSchedulingNotes(e.target.value)}
        placeholder="Scheduling-specific notes (e.g. 'Prefers no back-to-back weekend + Monday')..."
        style={{
          width: '100%', minHeight: 70, padding: '10px 12px', borderRadius: 8,
          border: '1px solid var(--border)', background: 'var(--bg-deep)',
          color: 'var(--text)', fontSize: 13, resize: 'vertical', marginBottom: 16,
        }}
      />

      <SaveButton onClick={handleSave} canSave={canSave} saveState={saveState} />
    </div>
  );
}

// ── Preferences & Specialties Tab ───────────────────────────────────────────
function PreferencesTab({ profile, sites, saveState, onSave }: {
  profile: EmploymentProfile;
  sites: Array<{ id: string; name: string; short_name: string | null }>;
  saveState: 'idle' | 'saving' | 'saved';
  onSave: (u: Record<string, unknown>) => void;
}) {
  const [fellowshipPrimary, setFellowshipPrimary] = useState(profile.fellowship_primary || '');
  const [fellowships, setFellowships] = useState<string[]>(profile.fellowships);
  const [skills, setSkills] = useState<string[]>(profile.skills);
  const [preferredAssignments, setPreferredAssignments] = useState<string[]>(profile.preferred_assignments);
  const [undesiredAssignments, setUndesiredAssignments] = useState<string[]>(profile.undesired_assignments);
  const [preferredSites, setPreferredSites] = useState<string[]>(profile.preferred_sites);
  const [undesiredSites, setUndesiredSites] = useState<string[]>(profile.undesired_sites);
  const [blockedDates, setBlockedDates] = useState<string[]>(profile.blocked_dates);

  useEffect(() => {
    setFellowshipPrimary(profile.fellowship_primary || '');
    setFellowships(profile.fellowships);
    setSkills(profile.skills);
    setPreferredAssignments(profile.preferred_assignments);
    setUndesiredAssignments(profile.undesired_assignments);
    setPreferredSites(profile.preferred_sites);
    setUndesiredSites(profile.undesired_sites);
    setBlockedDates(profile.blocked_dates);
  }, [profile]);

  const handleSave = () => {
    onSave({
      fellowship_primary: fellowshipPrimary.trim() || null,
      fellowships, skills,
      preferred_assignments: preferredAssignments,
      undesired_assignments: undesiredAssignments,
      preferred_sites: preferredSites,
      undesired_sites: undesiredSites,
      blocked_dates: blockedDates,
    });
  };

  return (
    <div style={{ maxWidth: 720 }}>
      <SectionLabel>Specialties</SectionLabel>
      <div style={{ marginBottom: 14 }}>
        <label style={fieldLabelStyle}>Primary Fellowship / Subspecialty</label>
        <select
          value={fellowshipPrimary}
          onChange={e => setFellowshipPrimary(e.target.value)}
          style={fieldInputStyle}
        >
          <option value="">— None —</option>
          {FELLOWSHIP_OPTIONS.map(f => (
            <option key={f} value={f}>{f}</option>
          ))}
          {fellowshipPrimary && !(FELLOWSHIP_OPTIONS as readonly string[]).includes(fellowshipPrimary) && (
            // Preserve any legacy free-text value so it isn't wiped on load.
            <option value={fellowshipPrimary}>{fellowshipPrimary} (legacy)</option>
          )}
        </select>
      </div>
      <OptionPicker
        label="Additional Fellowships"
        values={fellowships}
        onChange={setFellowships}
        options={FELLOWSHIP_OPTIONS}
        excludeOptions={fellowshipPrimary ? [fellowshipPrimary] : []}
      />
      <TagInput label="Skills" values={skills} onChange={setSkills} placeholder="Add a skill (e.g. TEE, regional, ultrasound)..." />

      <SectionLabel>Assignment Preferences</SectionLabel>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 10, marginTop: -4 }}>
        Soft preferences used by the scheduler. Pick from the list of case / service assignments.
      </div>
      <OptionPicker
        label="Preferred Assignments"
        values={preferredAssignments}
        onChange={setPreferredAssignments}
        options={ASSIGNMENT_OPTIONS}
        accent="#10b981"
      />
      <OptionPicker
        label="Undesired Assignments"
        values={undesiredAssignments}
        onChange={setUndesiredAssignments}
        options={ASSIGNMENT_OPTIONS}
        accent="#f87171"
      />

      <SectionLabel>Site Preferences</SectionLabel>
      <SitePicker label="Preferred Sites" values={preferredSites} onChange={setPreferredSites} sites={sites} accent="#10b981" />
      <SitePicker label="Undesired Sites" values={undesiredSites} onChange={setUndesiredSites} sites={sites} accent="#f87171" />

      <SectionLabel>Permanently Blocked Dates</SectionLabel>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 10, marginTop: -4 }}>
        For one-off time off, use the Availability tab. This is for recurring hard-blocks like a standing academic day.
      </div>
      <DateListEditor values={blockedDates} onChange={setBlockedDates} />

      <div style={{ marginTop: 20 }}>
        <SaveButton onClick={handleSave} canSave={true} saveState={saveState} />
      </div>
    </div>
  );
}

function TagInput({ label, values, onChange, placeholder, accent = '#0ea5e9' }: {
  label: string;
  values: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  accent?: string;
}) {
  const [draft, setDraft] = useState('');

  const add = () => {
    const v = draft.trim();
    if (!v || values.includes(v)) { setDraft(''); return; }
    onChange([...values, v]);
    setDraft('');
  };

  return (
    <div style={{ marginBottom: 14 }}>
      <label style={fieldLabelStyle}>{label}</label>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          placeholder={placeholder}
          style={{ ...fieldInputStyle, flex: 1 }}
        />
        <button onClick={add} disabled={!draft.trim()} style={{
          padding: '8px 14px', borderRadius: 8, cursor: draft.trim() ? 'pointer' : 'not-allowed',
          fontSize: 12, fontWeight: 700, background: 'var(--bg-surface)', color: 'var(--text-muted)',
          border: '1px solid var(--border)', opacity: draft.trim() ? 1 : 0.5,
        }}>
          Add
        </button>
      </div>
      {values.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
          {values.map(v => (
            <span key={v} style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              fontSize: 11, fontWeight: 600, padding: '3px 4px 3px 9px', borderRadius: 6,
              background: `${accent}20`, color: accent, border: `1px solid ${accent}30`,
            }}>
              {v}
              <button
                onClick={() => onChange(values.filter(x => x !== v))}
                style={{
                  background: 'none', border: 'none', color: accent, cursor: 'pointer',
                  fontSize: 14, lineHeight: 1, padding: '0 4px',
                }}
                aria-label={`Remove ${v}`}
              >×</button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function OptionPicker({
  label, values, onChange, options, excludeOptions = [], accent = '#0ea5e9',
}: {
  label: string;
  values: string[];
  onChange: (next: string[]) => void;
  options: readonly string[];
  // Options to hide from the dropdown (but still show in selected tags if
  // present). Used e.g. to exclude the primary fellowship from the
  // additional-fellowships picker.
  excludeOptions?: string[];
  accent?: string;
}) {
  const [sel, setSel] = useState('');
  const available = options.filter(o => !values.includes(o) && !excludeOptions.includes(o));

  const add = () => {
    if (!sel || values.includes(sel)) return;
    onChange([...values, sel]);
    setSel('');
  };

  return (
    <div style={{ marginBottom: 14 }}>
      <label style={fieldLabelStyle}>{label}</label>
      <div style={{ display: 'flex', gap: 8 }}>
        <select value={sel} onChange={e => setSel(e.target.value)} style={{ ...fieldInputStyle, flex: 1 }}>
          <option value="">Select...</option>
          {available.map(o => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
        <button onClick={add} disabled={!sel} style={{
          padding: '8px 14px', borderRadius: 8, cursor: sel ? 'pointer' : 'not-allowed',
          fontSize: 12, fontWeight: 700, background: 'var(--bg-surface)', color: 'var(--text-muted)',
          border: '1px solid var(--border)', opacity: sel ? 1 : 0.5,
        }}>
          Add
        </button>
      </div>
      {values.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
          {values.map(v => {
            const known = (options as readonly string[]).includes(v);
            return (
              <span key={v} style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                fontSize: 11, fontWeight: 600, padding: '3px 4px 3px 9px', borderRadius: 6,
                background: `${accent}20`, color: accent, border: `1px solid ${accent}30`,
                opacity: known ? 1 : 0.7,
              }}>
                {v}
                {!known && <span style={{ fontStyle: 'italic', fontSize: 10 }}>(legacy)</span>}
                <button
                  onClick={() => onChange(values.filter(x => x !== v))}
                  style={{
                    background: 'none', border: 'none', color: accent, cursor: 'pointer',
                    fontSize: 14, lineHeight: 1, padding: '0 4px',
                  }}
                  aria-label={`Remove ${v}`}
                >×</button>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SitePicker({ label, values, onChange, sites, accent = '#0ea5e9' }: {
  label: string;
  values: string[];
  onChange: (next: string[]) => void;
  sites: Array<{ id: string; name: string; short_name: string | null }>;
  accent?: string;
}) {
  const [sel, setSel] = useState('');
  const available = sites.filter(s => !values.includes(s.id));

  const add = () => {
    if (!sel) return;
    onChange([...values, sel]);
    setSel('');
  };

  const nameOf = (id: string) => sites.find(s => s.id === id)?.name || id;

  return (
    <div style={{ marginBottom: 14 }}>
      <label style={fieldLabelStyle}>{label}</label>
      <div style={{ display: 'flex', gap: 8 }}>
        <select value={sel} onChange={e => setSel(e.target.value)} style={{ ...fieldInputStyle, flex: 1 }}>
          <option value="">Select a site...</option>
          {available.map(s => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        <button onClick={add} disabled={!sel} style={{
          padding: '8px 14px', borderRadius: 8, cursor: sel ? 'pointer' : 'not-allowed',
          fontSize: 12, fontWeight: 700, background: 'var(--bg-surface)', color: 'var(--text-muted)',
          border: '1px solid var(--border)', opacity: sel ? 1 : 0.5,
        }}>
          Add
        </button>
      </div>
      {values.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
          {values.map(id => (
            <span key={id} style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              fontSize: 11, fontWeight: 600, padding: '3px 4px 3px 9px', borderRadius: 6,
              background: `${accent}20`, color: accent, border: `1px solid ${accent}30`,
            }}>
              {nameOf(id)}
              <button
                onClick={() => onChange(values.filter(x => x !== id))}
                style={{
                  background: 'none', border: 'none', color: accent, cursor: 'pointer',
                  fontSize: 14, lineHeight: 1, padding: '0 4px',
                }}
                aria-label={`Remove ${nameOf(id)}`}
              >×</button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function DateListEditor({ values, onChange }: { values: string[]; onChange: (next: string[]) => void }) {
  const [draft, setDraft] = useState('');

  const add = () => {
    if (!draft || values.includes(draft)) { setDraft(''); return; }
    onChange([...values, draft].sort());
    setDraft('');
  };

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          type="date"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          style={{ ...fieldInputStyle, flex: 1 }}
        />
        <button onClick={add} disabled={!draft} style={{
          padding: '8px 14px', borderRadius: 8, cursor: draft ? 'pointer' : 'not-allowed',
          fontSize: 12, fontWeight: 700, background: 'var(--bg-surface)', color: 'var(--text-muted)',
          border: '1px solid var(--border)', opacity: draft ? 1 : 0.5,
        }}>
          Add Date
        </button>
      </div>
      {values.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
          {values.map(d => (
            <span key={d} style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              fontSize: 11, fontWeight: 600, padding: '3px 4px 3px 9px', borderRadius: 6,
              background: 'rgba(100,116,139,0.15)', color: '#94a3b8', border: '1px solid rgba(100,116,139,0.3)',
            }}>
              {d}
              <button
                onClick={() => onChange(values.filter(x => x !== d))}
                style={{
                  background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer',
                  fontSize: 14, lineHeight: 1, padding: '0 4px',
                }}
                aria-label={`Remove ${d}`}
              >×</button>
            </span>
          ))}
        </div>
      )}
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
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const credentialedSiteIds = new Set(credentials.map(c => c.site_id));
  const availableSites = sites.filter(s => !credentialedSiteIds.has(s.id));

  const post = async (body: Record<string, unknown>) => {
    const res = await fetch(`/api/scheduling/providers/${providerId}/site-credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Failed (${res.status})`);
    }
  };

  const addSite = async () => {
    if (!addSiteId) return;
    setBusy(true); setError(null);
    try {
      await post({ site_id: addSiteId, credentialed: true, is_active: true });
      setAddSiteId('');
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add');
    } finally { setBusy(false); }
  };

  const updateCred = async (cred: SiteCredential, patch: Partial<SiteCredential>) => {
    setBusy(true); setError(null);
    try {
      await post({
        site_id: cred.site_id,
        is_active: cred.is_active,
        credentialed: cred.credentialed,
        can_take_call: cred.can_take_call,
        can_take_weekend_call: cred.can_take_weekend_call,
        can_take_holiday_call: cred.can_take_holiday_call,
        can_take_backup_call: cred.can_take_backup_call,
        effective_start_date: cred.effective_start_date,
        effective_end_date: cred.effective_end_date,
        allowed_shift_types: cred.allowed_shift_types,
        excluded_shift_types: cred.excluded_shift_types,
        skill_tags: cred.skill_tags,
        notes: cred.notes,
        ...patch,
      });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update');
    } finally { setBusy(false); }
  };

  const removeSite = async (siteId: string) => {
    if (!confirm('Remove this site credential?')) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/scheduling/providers/${providerId}/site-credentials?site_id=${siteId}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to remove');
      }
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to remove');
    } finally { setBusy(false); }
  };

  return (
    <div style={{ maxWidth: 760 }}>
      {error && (
        <div style={{
          background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)',
          color: '#f87171', padding: '10px 14px', borderRadius: 8, marginBottom: 12, fontSize: 13,
        }}>{error}</div>
      )}
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
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  onClick={() => setExpanded(expanded === c.id ? null : c.id)}
                  disabled={busy}
                  style={{
                    fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', background: 'none',
                    border: '1px solid var(--border)', borderRadius: 6,
                    padding: '3px 10px', cursor: busy ? 'not-allowed' : 'pointer',
                  }}
                >
                  {expanded === c.id ? 'Less' : 'More'}
                </button>
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
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
              <Toggle label="Credentialed" checked={c.credentialed} onChange={v => updateCred(c, { credentialed: v })} />
              <Toggle label="Active" checked={c.is_active} onChange={v => updateCred(c, { is_active: v })} />
              <Toggle label="Can Take Call" checked={c.can_take_call} onChange={v => updateCred(c, { can_take_call: v })} />
              <Toggle label="Weekend Call" checked={c.can_take_weekend_call} onChange={v => updateCred(c, { can_take_weekend_call: v })} />
              <Toggle label="Holiday Call" checked={c.can_take_holiday_call} onChange={v => updateCred(c, { can_take_holiday_call: v })} />
              <Toggle label="Backup Call" checked={c.can_take_backup_call} onChange={v => updateCred(c, { can_take_backup_call: v })} />
            </div>

            {expanded === c.id && (
              <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                  <div>
                    <label style={fieldLabelStyle}>Effective Start</label>
                    <input
                      type="date"
                      value={c.effective_start_date || ''}
                      onChange={e => updateCred(c, { effective_start_date: e.target.value || null })}
                      style={fieldInputStyle}
                    />
                  </div>
                  <div>
                    <label style={fieldLabelStyle}>Effective End</label>
                    <input
                      type="date"
                      value={c.effective_end_date || ''}
                      onChange={e => updateCred(c, { effective_end_date: e.target.value || null })}
                      style={fieldInputStyle}
                    />
                  </div>
                </div>
                <SiteShiftTypePicker
                  siteId={c.site_id}
                  label="Allowed Shift Types (if set, ONLY these are allowed)"
                  values={c.allowed_shift_types}
                  onChange={next => updateCred(c, { allowed_shift_types: next })}
                  accent="#10b981"
                />
                <SiteShiftTypePicker
                  siteId={c.site_id}
                  label="Excluded Shift Types"
                  values={c.excluded_shift_types}
                  onChange={next => updateCred(c, { excluded_shift_types: next })}
                  accent="#f87171"
                />
                <TagInput
                  label="Skill Tags"
                  values={c.skill_tags}
                  onChange={next => updateCred(c, { skill_tags: next })}
                  placeholder="e.g. trauma-level-1, pediatric..."
                  accent="#a78bfa"
                />
                <div>
                  <label style={fieldLabelStyle}>Notes</label>
                  <input
                    value={c.notes || ''}
                    onChange={e => updateCred(c, { notes: e.target.value || null })}
                    placeholder="Site-specific notes..."
                    style={fieldInputStyle}
                  />
                </div>
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}

// ── Availability Tab ───────────────────────────────────────────────────────

interface AvailabilityRow {
  id: string;
  availability_type: string;
  start_date: string;
  end_date: string;
  all_day: boolean;
  reason_code: string | null;
  notes: string | null;
  approval_status: string;
  source: string | null;
}

interface RequestWindowInfo {
  id: string;
  site_id: string;
  block_start: string;
  block_end: string;
  max_no_call_requests: number;
  token: string;
  status: string;
}

const AVAILABILITY_TYPES: { value: string; label: string; color: string }[] = [
  { value: 'pto', label: 'PTO', color: '#10b981' },
  { value: 'sick', label: 'Sick', color: '#f87171' },
  { value: 'fmla', label: 'FMLA', color: '#f59e0b' },
  { value: 'conference', label: 'Conference', color: '#0ea5e9' },
  { value: 'cme', label: 'CME', color: '#6366f1' },
  { value: 'admin', label: 'Admin', color: '#8b5cf6' },
  { value: 'jury_duty', label: 'Jury Duty', color: '#64748b' },
  { value: 'parental_leave', label: 'Parental Leave', color: '#fb923c' },
  { value: 'military_leave', label: 'Military Leave', color: '#94a3b8' },
  { value: 'unavailable', label: 'Unavailable', color: '#475569' },
  { value: 'blocked', label: 'Blocked', color: '#334155' },
  { value: 'no_call_request', label: 'No-Call Request', color: '#fbbf24' },
  { value: 'call_request', label: 'Call Request', color: '#34d399' },
];

const AVAIL_TYPE_MAP: Record<string, { label: string; color: string }> = {};
AVAILABILITY_TYPES.forEach(t => { AVAIL_TYPE_MAP[t.value] = t; });

const APPROVAL_COLORS: Record<string, { color: string; bg: string }> = {
  approved: { color: '#10b981', bg: 'rgba(16,185,129,0.12)' },
  pending: { color: '#fbbf24', bg: 'rgba(251,191,36,0.12)' },
  denied: { color: '#f87171', bg: 'rgba(248,113,113,0.12)' },
  waitlisted: { color: '#8b5cf6', bg: 'rgba(139,92,246,0.12)' },
  canceled: { color: '#64748b', bg: 'rgba(100,116,139,0.12)' },
};

function AvailabilityTab({ providerId, profile }: { providerId: string; profile: EmploymentProfile | null }) {
  const [rows, setRows] = useState<AvailabilityRow[]>([]);
  const [loading, setLoading] = useState(true);

  const loadAvailability = async () => {
    const res = await fetch(`/api/scheduling/availability?provider_id=${providerId}`);
    if (res.ok) setRows(await res.json());
    setLoading(false);
  };

  useEffect(() => { loadAvailability(); }, [providerId]);

  // Open request window for the provider's HOME site — gates the No-Call
  // Requests section: no open window, no section (Gabriel's rule).
  const homeSiteId = profile?.home_site_id ?? null;
  const [openWindow, setOpenWindow] = useState<RequestWindowInfo | null>(null);
  useEffect(() => {
    if (!homeSiteId) { setOpenWindow(null); return; }
    let cancelled = false;
    fetch(`/api/scheduling/request-windows?site_id=${homeSiteId}&status=open`)
      .then(r => (r.ok ? r.json() : []))
      .then(list => { if (!cancelled) setOpenWindow(Array.isArray(list) && list.length > 0 ? list[0] : null); })
      .catch(() => { if (!cancelled) setOpenWindow(null); });
    return () => { cancelled = true; };
  }, [homeSiteId]);

  const deleteEntry = async (id: string) => {
    if (!confirm('Remove this availability entry?')) return;
    await fetch(`/api/scheduling/availability/${id}`, { method: 'DELETE' });
    await loadAvailability();
  };

  // ICU entries delete both pieces (week + post-call Monday) together.
  const deleteIds = async (ids: string[], message: string) => {
    if (!confirm(message)) return;
    for (const id of ids) {
      await fetch(`/api/scheduling/availability/${id}`, { method: 'DELETE' });
    }
    await loadAvailability();
  };

  const formatDate = (d: string) => {
    const date = new Date(d + 'T12:00:00');
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  if (loading) return <div style={{ color: 'var(--text-dim)', padding: '20px 0' }}>Loading...</div>;

  // Category split. ICU rows (blocked + icu_* reason) render in the ICU
  // section only; generic blocked rows stay in Other Leave & Blocks.
  const icuPairs = pairIcuRows(rows);
  const icuIds = new Set<string>();
  for (const p of icuPairs) {
    icuIds.add(p.week.id);
    if (p.monday) icuIds.add(p.monday.id);
  }
  // Orphaned icu_post_call rows (their week row was deleted out-of-band)
  // still shouldn't leak into Other — count them as ICU-owned.
  for (const r of rows) {
    if (r.availability_type === 'blocked' &&
        (r.reason_code === ICU_WEEK_REASON || r.reason_code === ICU_POST_CALL_REASON)) {
      icuIds.add(r.id);
    }
  }
  const ptoRows = rows.filter(r => r.availability_type === 'pto');
  const daysOffRows = rows.filter(r => r.availability_type === 'unavailable');
  const noCallRows = rows.filter(r => r.availability_type === 'no_call_request');
  const otherRows = rows.filter(r =>
    !['pto', 'unavailable', 'no_call_request'].includes(r.availability_type) && !icuIds.has(r.id));

  return (
    <div style={{ maxWidth: 720 }}>
      {/* ── PTO Schedule ─────────────────────────────────────────────────── */}
      <AvailSection
        title="PTO Schedule"
        hint="Vacation / paid time off. Counts toward PTO; blocks scheduling for the range (flanking weekends are handled by the scheduler's bookend rule)."
      >
        <PtoAddForm providerId={providerId} onAdded={loadAvailability} />
        <SectionRows rows={ptoRows} onDelete={deleteEntry} formatDate={formatDate} emptyText="No PTO entries yet." />
      </AvailSection>

      {/* ── Days Off ─────────────────────────────────────────────────────── */}
      <AvailSection
        title="Days Off"
        hint="Recurring or personal non-work days for partial-FTE and day docs. Entered as date ranges like PTO, but never counted or displayed as PTO."
      >
        <RangeAddForm
          providerId={providerId}
          availabilityType="unavailable"
          addLabel="Add Days Off"
          onAdded={loadAvailability}
        />
        <SectionRows rows={daysOffRows} onDelete={deleteEntry} formatDate={formatDate} emptyText="No days-off entries yet." />
      </AvailSection>

      {/* ── No Call Requests — only while a request window is OPEN ───────── */}
      {openWindow && (
        <AvailSection
          title="No Call Requests"
          hint={`Request window open for the block ${formatDate(openWindow.block_start)} – ${formatDate(openWindow.block_end)}. ` +
            `Up to ${openWindow.max_no_call_requests} dates; the schedule generator avoids them when it can (soft — no approval step).`}
        >
          <NoCallAddForm
            providerId={providerId}
            window={openWindow}
            usedCount={noCallRows.filter(r => r.notes === `request_window:${openWindow.id}`).length}
            onAdded={loadAvailability}
          />
          <SectionRows rows={noCallRows} onDelete={deleteEntry} formatDate={formatDate} emptyText="No no-call requests yet." />
        </AvailSection>
      )}
      {!openWindow && noCallRows.length > 0 && (
        <AvailSection
          title="No Call Requests"
          hint="No request window is currently open for this provider's home site — existing requests are shown read-only; new ones can be entered once a window opens."
        >
          <SectionRows rows={noCallRows} onDelete={deleteEntry} formatDate={formatDate} emptyText="" />
        </AvailSection>
      )}

      {/* ── ICU Rotation — only for flagged ICU docs ─────────────────────── */}
      {profile?.is_icu_doc && (
        <AvailSection
          title="ICU Rotation"
          hint="Entering an ICU week blocks the week AND the Monday immediately after it (post-ICU recovery day). Both pieces delete together."
        >
          <IcuAddForm providerId={providerId} rows={rows} onAdded={loadAvailability} />
          {icuPairs.length === 0 ? (
            <div style={{ color: 'var(--text-dim)', fontStyle: 'italic', fontSize: 12, padding: '6px 0' }}>
              No ICU weeks entered yet.
            </div>
          ) : (
            icuPairs.map(pair => (
              <div key={pair.week.id} style={{
                background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 10,
                padding: '12px 16px', marginBottom: 8,
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <span style={{
                    fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 6,
                    background: 'rgba(139,92,246,0.15)', color: '#8b5cf6',
                  }}>
                    ICU Week
                  </span>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
                      {formatDate(pair.week.start_date)} — {formatDate(pair.week.end_date)}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>
                      {pair.monday
                        ? `+ post-ICU Monday off ${formatDate(pair.monday.start_date)}`
                        : 'post-ICU Monday covered by another blocked entry'}
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => deleteIds(
                    pair.monday ? [pair.week.id, pair.monday.id] : [pair.week.id],
                    'Remove this ICU week (and its post-ICU Monday, if any)?',
                  )}
                  title="Delete ICU week + Monday"
                  style={{
                    fontSize: 11, color: '#f87171', background: 'none', border: 'none',
                    cursor: 'pointer', padding: '2px 6px',
                  }}
                >
                  x
                </button>
              </div>
            ))
          )}
        </AvailSection>
      )}

      {/* ── Everything else (sick, FMLA, conference, blocks, …) ──────────── */}
      <AvailSection
        title="Other Leave & Blocks"
        hint="Sick, FMLA, conference/CME, admin days, jury duty, parental or military leave, and hard blocks."
      >
        <OtherAddForm providerId={providerId} onAdded={loadAvailability} />
        <SectionRows rows={otherRows} onDelete={deleteEntry} formatDate={formatDate} emptyText="No other entries." />
      </AvailSection>
    </div>
  );
}

// Section wrapper: label + explanatory hint + content.
function AvailSection({ title, hint, children }: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 26 }}>
      <SectionLabel>{title}</SectionLabel>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 10, marginTop: -2, lineHeight: 1.5 }}>
        {hint}
      </div>
      {children}
    </div>
  );
}

// Entry list for one section, split into current/upcoming then past (dimmed).
function SectionRows({ rows, onDelete, formatDate, emptyText }: {
  rows: AvailabilityRow[];
  onDelete: (id: string) => void;
  formatDate: (d: string) => string;
  emptyText: string;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = rows.filter(r => r.end_date >= today);
  const past = rows.filter(r => r.end_date < today);
  if (rows.length === 0) {
    return emptyText ? (
      <div style={{ color: 'var(--text-dim)', fontStyle: 'italic', fontSize: 12, padding: '6px 0' }}>
        {emptyText}
      </div>
    ) : null;
  }
  return (
    <>
      {upcoming.map(r => <AvailabilityCard key={r.id} row={r} onDelete={onDelete} formatDate={formatDate} />)}
      {past.length > 0 && (
        <div style={{ opacity: 0.55 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-dim)', letterSpacing: 0.5, textTransform: 'uppercase', margin: '8px 0 6px' }}>
            Past
          </div>
          {past.map(r => <AvailabilityCard key={r.id} row={r} onDelete={onDelete} formatDate={formatDate} />)}
        </div>
      )}
    </>
  );
}

// Shared POST helper for the section add-forms.
async function postAvailability(body: Record<string, unknown>): Promise<string | null> {
  const res = await fetch('/api/scheduling/availability', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    return data.error || `Failed (${res.status})`;
  }
  return null;
}

// PTO add form — date-range or week-number entry. "Week 1" = the Mon-Sun
// week containing Jan 1 (even if Mon lands in the previous December). PTO
// fills Mon-Fri of that week; the weekend is blocked automatically by the
// bookend rule in the scheduler, so there's no reason to enter Sat/Sun here.
function PtoAddForm({ providerId, onAdded }: { providerId: string; onAdded: () => Promise<void> }) {
  const [mode, setMode] = useState<'date' | 'week'>('date');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [year, setYear] = useState<number>(new Date().getUTCFullYear());
  const [weekNum, setWeekNum] = useState<number>(1);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const week1Monday = (y: number): Date => {
    const jan1 = new Date(Date.UTC(y, 0, 1));
    const dow = jan1.getUTCDay(); // 0=Sun
    const daysBack = dow === 0 ? 6 : dow - 1;
    jan1.setUTCDate(jan1.getUTCDate() - daysBack);
    return jan1;
  };
  const weeksInYear = (y: number): number => {
    const w1 = week1Monday(y);
    const dec31 = new Date(Date.UTC(y, 11, 31));
    const diffDays = Math.floor((dec31.getTime() - w1.getTime()) / 86400000);
    return Math.floor(diffDays / 7) + 1;
  };
  const weekRange = (y: number, w: number): { mon: string; fri: string } => {
    const mon = week1Monday(y);
    mon.setUTCDate(mon.getUTCDate() + (w - 1) * 7);
    const fri = new Date(mon);
    fri.setUTCDate(mon.getUTCDate() + 4);
    return { mon: mon.toISOString().slice(0, 10), fri: fri.toISOString().slice(0, 10) };
  };

  useEffect(() => {
    if (mode !== 'week') return;
    const { mon, fri } = weekRange(year, weekNum);
    setStart(mon);
    setEnd(fri);
  }, [mode, year, weekNum]);

  const add = async () => {
    if (!start || !end) return;
    if (end < start) { setError('End date must be on or after start date'); return; }
    setBusy(true); setError(null);
    try {
      const err = await postAvailability({
        provider_id: providerId,
        availability_type: 'pto',
        start_date: start,
        end_date: end,
        notes: notes || null,
        approval_status: 'approved',
      });
      if (err) { setError(err); return; }
      setStart(''); setEnd(''); setNotes('');
      await onAdded();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={addFormBoxStyle}>
      {error && <div style={addFormErrorStyle}>{error}</div>}
      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        {(['date', 'week'] as const).map(m => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            style={{
              padding: '5px 10px', borderRadius: 6, cursor: 'pointer',
              fontSize: 11, fontWeight: 700,
              background: mode === m ? 'rgba(14,165,233,0.15)' : 'var(--bg-deep)',
              color: mode === m ? '#0ea5e9' : 'var(--text-muted)',
              border: `1px solid ${mode === m ? 'rgba(14,165,233,0.4)' : 'var(--border)'}`,
            }}
          >
            {m === 'date' ? 'Date Range' : 'By Week #'}
          </button>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto', gap: 10, alignItems: 'end' }}>
        {mode === 'date' ? (
          <>
            <div>
              <label style={fieldLabelStyle}>Start Date</label>
              <input type="date" value={start} onChange={e => {
                setStart(e.target.value);
                if (!end || e.target.value > end) setEnd(e.target.value);
              }} style={fieldInputStyle} />
            </div>
            <div>
              <label style={fieldLabelStyle}>End Date</label>
              <input type="date" value={end} onChange={e => setEnd(e.target.value)} min={start} style={fieldInputStyle} />
            </div>
          </>
        ) : (
          <>
            <div>
              <label style={fieldLabelStyle}>Year</label>
              <select value={year} onChange={e => setYear(parseInt(e.target.value, 10))} style={fieldInputStyle}>
                {(() => {
                  const cur = new Date().getUTCFullYear();
                  return [cur - 1, cur, cur + 1, cur + 2].map(y => (
                    <option key={y} value={y}>{y}</option>
                  ));
                })()}
              </select>
            </div>
            <div>
              <label style={fieldLabelStyle}>Week #</label>
              <select value={weekNum} onChange={e => setWeekNum(parseInt(e.target.value, 10))} style={fieldInputStyle}>
                {Array.from({ length: weeksInYear(year) }, (_, i) => i + 1).map(n => (
                  <option key={n} value={n}>Week {n}</option>
                ))}
              </select>
            </div>
          </>
        )}
        <div>
          <label style={fieldLabelStyle}>Notes</label>
          <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional" style={fieldInputStyle} />
        </div>
        <button onClick={add} disabled={busy || !start || !end} style={{
          ...saveBtnStyle, opacity: busy || !start || !end ? 0.5 : 1, whiteSpace: 'nowrap',
        }}>
          {busy ? 'Adding...' : 'Add PTO'}
        </button>
      </div>
      {mode === 'week' && start && end && (
        <div style={{
          fontSize: 11, color: 'var(--text-dim)', marginTop: 8,
          padding: '5px 9px', background: 'rgba(14,165,233,0.06)',
          border: '1px solid rgba(14,165,233,0.2)', borderRadius: 6,
        }}>
          Week {weekNum}: {new Date(start + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – {new Date(end + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} (Mon–Fri). Flanking Sat/Sun are blocked automatically.
        </div>
      )}
    </div>
  );
}

// Generic date-range add form used by the Days Off section.
function RangeAddForm({ providerId, availabilityType, addLabel, onAdded }: {
  providerId: string;
  availabilityType: string;
  addLabel: string;
  onAdded: () => Promise<void>;
}) {
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    if (!start || !end) return;
    if (end < start) { setError('End date must be on or after start date'); return; }
    setBusy(true); setError(null);
    try {
      const err = await postAvailability({
        provider_id: providerId,
        availability_type: availabilityType,
        start_date: start,
        end_date: end,
        notes: notes || null,
        approval_status: 'approved',
      });
      if (err) { setError(err); return; }
      setStart(''); setEnd(''); setNotes('');
      await onAdded();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={addFormBoxStyle}>
      {error && <div style={addFormErrorStyle}>{error}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto', gap: 10, alignItems: 'end' }}>
        <div>
          <label style={fieldLabelStyle}>Start Date</label>
          <input type="date" value={start} onChange={e => {
            setStart(e.target.value);
            if (!end || e.target.value > end) setEnd(e.target.value);
          }} style={fieldInputStyle} />
        </div>
        <div>
          <label style={fieldLabelStyle}>End Date</label>
          <input type="date" value={end} onChange={e => setEnd(e.target.value)} min={start} style={fieldInputStyle} />
        </div>
        <div>
          <label style={fieldLabelStyle}>Notes</label>
          <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional" style={fieldInputStyle} />
        </div>
        <button onClick={add} disabled={busy || !start || !end} style={{
          ...saveBtnStyle, opacity: busy || !start || !end ? 0.5 : 1, whiteSpace: 'nowrap',
        }}>
          {busy ? 'Adding...' : addLabel}
        </button>
      </div>
    </div>
  );
}

// No-call add — routes through the SAME token-gated intake endpoint the
// public form uses, so the per-window cap has exactly one enforcement point.
function NoCallAddForm({ providerId, window: win, usedCount, onAdded }: {
  providerId: string;
  window: RequestWindowInfo;
  usedCount: number;
  onAdded: () => Promise<void>;
}) {
  const [date, setDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remaining = Math.max(0, win.max_no_call_requests - usedCount);

  const add = async () => {
    if (!date) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/requests/submit/${win.token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider_id: providerId, no_call_dates: [date] }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || `Failed (${res.status})`);
        return;
      }
      setDate('');
      await onAdded();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={addFormBoxStyle}>
      {error && <div style={addFormErrorStyle}>{error}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 10, alignItems: 'end' }}>
        <div>
          <label style={fieldLabelStyle}>No-Call Date</label>
          <input
            type="date"
            value={date}
            min={win.block_start}
            max={win.block_end}
            onChange={e => setDate(e.target.value)}
            style={fieldInputStyle}
          />
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-dim)', paddingBottom: 7 }}>
          {usedCount}/{win.max_no_call_requests} used
        </div>
        <button onClick={add} disabled={busy || !date || remaining === 0} style={{
          ...saveBtnStyle, opacity: busy || !date || remaining === 0 ? 0.5 : 1, whiteSpace: 'nowrap',
        }}>
          {busy ? 'Adding...' : 'Add Request'}
        </button>
      </div>
    </div>
  );
}

// ICU week entry: default end = start + 6; creates the week row and (unless
// already covered) the post-ICU Monday row via planIcuEntry.
function IcuAddForm({ providerId, rows, onAdded }: {
  providerId: string;
  rows: AvailabilityRow[];
  onAdded: () => Promise<void>;
}) {
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveEnd = end || (start ? icuWeekEnd(start) : '');

  const add = async () => {
    if (!start) return;
    setBusy(true); setError(null);
    try {
      const plan = planIcuEntry(start, end || undefined, rows);
      const weekErr = await postAvailability({
        provider_id: providerId,
        availability_type: plan.week.availability_type,
        start_date: plan.week.start_date,
        end_date: plan.week.end_date,
        reason_code: plan.week.reason_code,
        approval_status: 'approved',
      });
      if (weekErr) { setError(weekErr); return; }
      if (plan.monday) {
        const mondayErr = await postAvailability({
          provider_id: providerId,
          availability_type: plan.monday.availability_type,
          start_date: plan.monday.start_date,
          end_date: plan.monday.end_date,
          reason_code: plan.monday.reason_code,
          approval_status: 'approved',
        });
        if (mondayErr) { setError(`Week saved, but the post-ICU Monday failed: ${mondayErr}`); return; }
      }
      setStart(''); setEnd('');
      await onAdded();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to plan ICU entry');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={addFormBoxStyle}>
      {error && <div style={addFormErrorStyle}>{error}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 10, alignItems: 'end' }}>
        <div>
          <label style={fieldLabelStyle}>Week Start</label>
          <input type="date" value={start} onChange={e => setStart(e.target.value)} style={fieldInputStyle} />
        </div>
        <div>
          <label style={fieldLabelStyle}>Week End (default +6 days)</label>
          <input type="date" value={end} min={start} placeholder="start + 6" onChange={e => setEnd(e.target.value)} style={fieldInputStyle} />
        </div>
        <button onClick={add} disabled={busy || !start} style={{
          ...saveBtnStyle, opacity: busy || !start ? 0.5 : 1, whiteSpace: 'nowrap',
        }}>
          {busy ? 'Adding...' : 'Add ICU Week'}
        </button>
      </div>
      {start && (
        <div style={{
          fontSize: 11, color: 'var(--text-dim)', marginTop: 8,
          padding: '5px 9px', background: 'rgba(139,92,246,0.06)',
          border: '1px solid rgba(139,92,246,0.2)', borderRadius: 6,
        }}>
          Blocks {start} – {effectiveEnd}, plus the following Monday off.
        </div>
      )}
    </div>
  );
}

// Add form for the remaining availability types (sick, FMLA, conference, …).
const OTHER_ENTRY_TYPES = AVAILABILITY_TYPES.filter(
  t => !['pto', 'unavailable', 'no_call_request'].includes(t.value),
);

function OtherAddForm({ providerId, onAdded }: { providerId: string; onAdded: () => Promise<void> }) {
  const [type, setType] = useState(OTHER_ENTRY_TYPES[0]?.value || 'sick');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    if (!start || !end) return;
    if (end < start) { setError('End date must be on or after start date'); return; }
    setBusy(true); setError(null);
    try {
      const err = await postAvailability({
        provider_id: providerId,
        availability_type: type,
        start_date: start,
        end_date: end,
        notes: notes || null,
        approval_status: 'approved',
      });
      if (err) { setError(err); return; }
      setStart(''); setEnd(''); setNotes('');
      await onAdded();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={addFormBoxStyle}>
      {error && <div style={addFormErrorStyle}>{error}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr auto', gap: 10, alignItems: 'end' }}>
        <div>
          <label style={fieldLabelStyle}>Type</label>
          <select value={type} onChange={e => setType(e.target.value)} style={fieldInputStyle}>
            {OTHER_ENTRY_TYPES.map(t => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label style={fieldLabelStyle}>Start Date</label>
          <input type="date" value={start} onChange={e => {
            setStart(e.target.value);
            if (!end || e.target.value > end) setEnd(e.target.value);
          }} style={fieldInputStyle} />
        </div>
        <div>
          <label style={fieldLabelStyle}>End Date</label>
          <input type="date" value={end} onChange={e => setEnd(e.target.value)} min={start} style={fieldInputStyle} />
        </div>
        <div>
          <label style={fieldLabelStyle}>Notes</label>
          <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional" style={fieldInputStyle} />
        </div>
        <button onClick={add} disabled={busy || !start || !end} style={{
          ...saveBtnStyle, opacity: busy || !start || !end ? 0.5 : 1, whiteSpace: 'nowrap',
        }}>
          {busy ? 'Adding...' : 'Add'}
        </button>
      </div>
    </div>
  );
}

const addFormBoxStyle: React.CSSProperties = {
  background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 10,
  padding: 12, marginBottom: 12,
};
const addFormErrorStyle: React.CSSProperties = {
  color: '#f87171', fontSize: 12, marginBottom: 10,
  padding: '6px 10px', background: 'rgba(248,113,113,0.1)',
  border: '1px solid rgba(248,113,113,0.3)', borderRadius: 6,
};

function AvailabilityCard({ row, onDelete, formatDate }: {
  row: AvailabilityRow;
  onDelete: (id: string) => void;
  formatDate: (d: string) => string;
}) {
  const typeInfo = AVAIL_TYPE_MAP[row.availability_type] || { label: row.availability_type, color: '#64748b' };
  const approvalInfo = APPROVAL_COLORS[row.approval_status] || APPROVAL_COLORS.pending;
  const sameDay = row.start_date === row.end_date;
  const reason = reasonCodeLabel(row.reason_code);

  return (
    <div style={{
      background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 10,
      padding: '12px 16px', marginBottom: 8,
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{
          fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 6,
          background: `${typeInfo.color}20`, color: typeInfo.color,
        }}>
          {typeInfo.label}
        </span>
        {reason && (
          <span style={{
            fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 6,
            background: 'rgba(139,92,246,0.12)', color: '#8b5cf6',
          }}>
            {reason}
          </span>
        )}
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
            {formatDate(row.start_date)}{!sameDay && ` — ${formatDate(row.end_date)}`}
          </div>
          {row.notes && (
            <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>{row.notes}</div>
          )}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {row.source === 'request_window' && (
          <span style={{
            fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 6,
            background: 'rgba(14,165,233,0.12)', color: '#0ea5e9',
          }}>
            Window
          </span>
        )}
        <span style={{
          fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 6,
          background: approvalInfo.bg, color: approvalInfo.color, textTransform: 'capitalize',
        }}>
          {row.approval_status}
        </span>
        <button
          onClick={() => onDelete(row.id)}
          title="Delete"
          style={{
            fontSize: 11, color: '#f87171', background: 'none', border: 'none',
            cursor: 'pointer', padding: '2px 6px',
          }}
        >
          x
        </button>
      </div>
    </div>
  );
}

// ── Custom Fields Tab ───────────────────────────────────────────────────────

interface CustomFieldDef {
  id: string;
  field_name: string;
  display_label: string;
  field_type: 'text' | 'number' | 'boolean' | 'select' | 'multiselect' | 'date';
  options: string[];
  required: boolean;
  admin_only: boolean;
  applies_to_provider_types: string[];
  applies_to_sites: string[];
  display_order: number;
}

function CustomFieldsTab({ providerId, providerType, homeSiteId }: { providerId: string; providerType: string; homeSiteId: string | null }) {
  const [defs, setDefs] = useState<CustomFieldDef[]>([]);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const res = await fetch(`/api/scheduling/providers/${providerId}/custom-field-values`);
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error || `Failed (${res.status})`);
      setLoading(false);
      return;
    }
    const data = await res.json();
    const rawDefs = (data.definitions || []) as CustomFieldDef[];
    const vals = (data.values || {}) as Record<string, unknown>;
    setDefs(rawDefs);
    setValues(vals);
    setDraft(vals);
    setLoading(false);
  };

  useEffect(() => { load(); }, [providerId]);

  // Show a definition only if both scope filters pass:
  //   - provider_type scope: empty list = applies to all types
  //   - site scope: empty list = applies regardless of site; otherwise the
  //     provider's home site must be in the list. Providers with no home
  //     site are hidden from site-scoped fields (there's no site to match).
  const visible = defs.filter(d => {
    if (d.applies_to_provider_types.length > 0 && !d.applies_to_provider_types.includes(providerType)) return false;
    if (d.applies_to_sites.length > 0 && (!homeSiteId || !d.applies_to_sites.includes(homeSiteId))) return false;
    return true;
  });

  const dirty = visible.some(d => !deepEqual(draft[d.id], values[d.id]));

  const save = async () => {
    // Client-side required-check — mirrors server validation but gives a
    // better immediate error.
    for (const d of visible) {
      if (d.required) {
        const v = draft[d.id];
        const empty = v === null || v === undefined || v === ''
          || (Array.isArray(v) && v.length === 0);
        if (empty) {
          setError(`"${d.display_label}" is required`);
          return;
        }
      }
    }

    setSaving(true); setError(null);
    try {
      // Only send the fields the user actually visits — unknown defs stay
      // untouched on the server.
      const payload: Record<string, unknown> = {};
      for (const d of visible) payload[d.id] = draft[d.id] ?? null;
      const res = await fetch(`/api/scheduling/providers/${providerId}/custom-field-values`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: payload }),
      });
      if (!res.ok) {
        setError((await res.json().catch(() => ({}))).error || `Failed (${res.status})`);
        return;
      }
      const data = await res.json();
      const next = (data.values || {}) as Record<string, unknown>;
      setValues(next);
      setDraft(next);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div style={{ color: 'var(--text-dim)', padding: '20px 0' }}>Loading...</div>;

  if (visible.length === 0) {
    return (
      <div style={{ maxWidth: 640, color: 'var(--text-dim)', padding: '20px 0' }}>
        <div style={{ fontStyle: 'italic', marginBottom: 8 }}>
          No custom fields apply to this provider yet.
        </div>
        <div style={{ fontSize: 12 }}>
          Define fields under <Link href="/settings" style={{ color: '#0ea5e9', textDecoration: 'none' }}>Settings → Provider Custom Fields</Link>.
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 640 }}>
      {error && (
        <div style={{
          background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)',
          color: '#f87171', padding: '10px 14px', borderRadius: 8, marginBottom: 14, fontSize: 13,
        }}>{error}</div>
      )}

      {visible.map(d => (
        <CustomFieldInput
          key={d.id}
          def={d}
          value={draft[d.id]}
          onChange={v => setDraft(prev => ({ ...prev, [d.id]: v }))}
        />
      ))}

      <button
        onClick={save}
        disabled={!dirty || saving}
        style={{ ...saveBtnStyle, opacity: (!dirty || saving) ? 0.5 : 1, cursor: (!dirty || saving) ? 'not-allowed' : 'pointer' }}
      >
        {saving ? 'Saving...' : 'Save Changes'}
      </button>
    </div>
  );
}

function CustomFieldInput({ def, value, onChange }: {
  def: CustomFieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const label = (
    <label style={{ ...fieldLabelStyle, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      {def.display_label}
      {def.required && <span style={{ color: '#f59e0b' }}>*</span>}
      {def.admin_only && (
        <span style={{
          fontSize: 9, fontWeight: 800, padding: '1px 6px', borderRadius: 4,
          background: 'rgba(245,158,11,0.15)', color: '#f59e0b', letterSpacing: 0.5,
        }}>
          ADMIN
        </span>
      )}
    </label>
  );

  switch (def.field_type) {
    case 'text':
      return (
        <div style={{ marginBottom: 14 }}>
          {label}
          <input
            value={typeof value === 'string' ? value : ''}
            onChange={e => onChange(e.target.value || null)}
            style={fieldInputStyle}
          />
        </div>
      );
    case 'number':
      return (
        <div style={{ marginBottom: 14 }}>
          {label}
          <input
            type="number"
            value={value === null || value === undefined ? '' : String(value)}
            onChange={e => onChange(e.target.value === '' ? null : Number(e.target.value))}
            style={fieldInputStyle}
          />
        </div>
      );
    case 'date':
      return (
        <div style={{ marginBottom: 14 }}>
          {label}
          <input
            type="date"
            value={typeof value === 'string' ? value : ''}
            onChange={e => onChange(e.target.value || null)}
            style={fieldInputStyle}
          />
        </div>
      );
    case 'boolean':
      return (
        <div style={{ marginBottom: 14 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-muted)', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={value === true}
              onChange={e => onChange(e.target.checked)}
              style={{ accentColor: '#0ea5e9', width: 15, height: 15 }}
            />
            {def.display_label}
            {def.required && <span style={{ color: '#f59e0b', marginLeft: 4 }}>*</span>}
            {def.admin_only && (
              <span style={{
                fontSize: 9, fontWeight: 800, padding: '1px 6px', borderRadius: 4,
                background: 'rgba(245,158,11,0.15)', color: '#f59e0b', letterSpacing: 0.5, marginLeft: 4,
              }}>
                ADMIN
              </span>
            )}
          </label>
        </div>
      );
    case 'select':
      return (
        <div style={{ marginBottom: 14 }}>
          {label}
          <select
            value={typeof value === 'string' ? value : ''}
            onChange={e => onChange(e.target.value || null)}
            style={fieldInputStyle}
          >
            <option value="">— None —</option>
            {def.options.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
      );
    case 'multiselect': {
      const arr = Array.isArray(value) ? value as string[] : [];
      return (
        <div style={{ marginBottom: 14 }}>
          {label}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {def.options.map(o => {
              const selected = arr.includes(o);
              return (
                <button
                  key={o}
                  type="button"
                  onClick={() => {
                    const next = selected ? arr.filter(x => x !== o) : [...arr, o];
                    onChange(next);
                  }}
                  style={{
                    padding: '5px 11px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                    border: `1px solid ${selected ? '#0ea5e9' : 'var(--border)'}`,
                    background: selected ? 'rgba(14,165,233,0.15)' : 'transparent',
                    color: selected ? '#0ea5e9' : 'var(--text-muted)',
                  }}
                >
                  {o}
                </button>
              );
            })}
          </div>
        </div>
      );
    }
    default:
      return null;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  // Null vs undefined should be treated equivalently for "no value set".
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  return false;
}

// ── Compensation Tab (ADMIN ONLY) ───────────────────────────────────────────

interface Compensation {
  base_salary: number | null;
  fellowship_stipend: number | null;
  admin_stipend: number | null;
  retention_bonus: number | null;
  retention_bonus_end_date: string | null;
  health_insurance_cost: number | null;
  malpractice_cost: number | null;
  retirement_401k_contribution: number | null;
  profit_share: number | null;
  notes: string | null;
}

const EMPTY_COMP: Compensation = {
  base_salary: null,
  fellowship_stipend: null,
  admin_stipend: null,
  retention_bonus: null,
  retention_bonus_end_date: null,
  health_insurance_cost: null,
  malpractice_cost: null,
  retirement_401k_contribution: null,
  profit_share: null,
  notes: null,
};

function CompensationTab({ providerId }: { providerId: string }) {
  const [comp, setComp] = useState<Compensation>(EMPTY_COMP);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/scheduling/providers/${providerId}/compensation`);
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(data.error || `Failed (${res.status})`);
          setLoading(false);
          return;
        }
        // API returns {} when no comp row exists.
        setComp({ ...EMPTY_COMP, ...(data || {}) });
        setLoading(false);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to load');
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [providerId]);

  const patch = <K extends keyof Compensation>(k: K, v: Compensation[K]) => {
    setComp(prev => ({ ...prev, [k]: v }));
    setSavedAt(null);
  };

  const save = async () => {
    setSaving(true); setError(null);
    try {
      const res = await fetch(`/api/scheduling/providers/${providerId}/compensation`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(comp),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `Failed (${res.status})`);
        return;
      }
      setComp({ ...EMPTY_COMP, ...data });
      setSavedAt(new Date().toLocaleTimeString());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div style={{ color: 'var(--text-dim)', padding: '20px 0' }}>Loading...</div>;

  return (
    <div style={{ maxWidth: 720 }}>
      <div style={{
        background: 'rgba(245,158,11,0.08)',
        border: '1px solid rgba(245,158,11,0.3)',
        color: '#f59e0b',
        padding: '12px 16px',
        borderRadius: 10,
        marginBottom: 20,
        display: 'flex',
        gap: 10,
        alignItems: 'flex-start',
      }}>
        <span style={{
          fontSize: 10, fontWeight: 800, padding: '2px 8px', borderRadius: 4,
          background: 'rgba(245,158,11,0.2)', letterSpacing: 0.5, flexShrink: 0, marginTop: 1,
        }}>
          ADMIN ONLY
        </span>
        <div style={{ fontSize: 12, lineHeight: 1.5 }}>
          Sensitive compensation data. All values are current-snapshot only — no history is retained today.
          Once authentication and role-based access are wired up, this tab will be restricted to admin users.
        </div>
      </div>

      {error && (
        <div style={{
          background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)',
          color: '#f87171', padding: '10px 14px', borderRadius: 8, marginBottom: 14, fontSize: 13,
        }}>{error}</div>
      )}

      <SectionLabel>Salary & Stipends</SectionLabel>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
        <MoneyField label="Base Salary" value={comp.base_salary} onChange={v => patch('base_salary', v)} />
        <MoneyField label="Fellowship Stipend" value={comp.fellowship_stipend} onChange={v => patch('fellowship_stipend', v)} />
        <MoneyField label="Admin Stipend" value={comp.admin_stipend} onChange={v => patch('admin_stipend', v)} />
      </div>

      <SectionLabel>Bonuses & Profit Share</SectionLabel>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
        <MoneyField label="Retention Bonus" value={comp.retention_bonus} onChange={v => patch('retention_bonus', v)} />
        <div>
          <label style={fieldLabelStyle}>Retention Bonus End Date</label>
          <input
            type="date"
            value={comp.retention_bonus_end_date ?? ''}
            onChange={e => patch('retention_bonus_end_date', e.target.value || null)}
            style={fieldInputStyle}
          />
        </div>
        <MoneyField label="Profit Share" value={comp.profit_share} onChange={v => patch('profit_share', v)} />
      </div>

      <SectionLabel>Benefits & Employer Costs</SectionLabel>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
        <MoneyField label="Health Insurance Cost" value={comp.health_insurance_cost} onChange={v => patch('health_insurance_cost', v)} hint="Annual employer cost" />
        <MoneyField label="Malpractice Cost" value={comp.malpractice_cost} onChange={v => patch('malpractice_cost', v)} hint="Annual employer cost" />
        <MoneyField label="401(k) Contribution" value={comp.retirement_401k_contribution} onChange={v => patch('retirement_401k_contribution', v)} hint="Annual employer contribution" />
      </div>

      <CompensationTotals comp={comp} />

      <SectionLabel>Notes</SectionLabel>
      <textarea
        value={comp.notes ?? ''}
        onChange={e => patch('notes', e.target.value || null)}
        placeholder="Offer letter terms, upcoming raises, special arrangements..."
        style={{
          width: '100%', minHeight: 70, padding: '10px 12px', borderRadius: 8,
          border: '1px solid var(--border)', background: 'var(--bg-deep)',
          color: 'var(--text)', fontSize: 13, resize: 'vertical', marginBottom: 16,
        }}
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button onClick={save} disabled={saving} style={{ ...saveBtnStyle, opacity: saving ? 0.5 : 1, cursor: saving ? 'not-allowed' : 'pointer' }}>
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
        {savedAt && <span style={{ fontSize: 11, color: '#10b981' }}>Saved at {savedAt}</span>}
      </div>
    </div>
  );
}

// Live-computed totals panel shown between the Benefits section and Notes.
// Reads directly from the draft state so edits are reflected as the admin
// types. Retention bonus + profit share are conceptually lumpy (one-time
// vs. variable) — noted in the footnote rather than excluded, because
// hiding them would surprise admins who just typed them into the form.
function CompensationTotals({ comp }: { comp: Compensation }) {
  const sum = (...vals: (number | null)[]) => vals.reduce<number>((a, v) => a + (v ?? 0), 0);
  const providerTotal = sum(
    comp.base_salary,
    comp.fellowship_stipend,
    comp.admin_stipend,
    comp.retention_bonus,
    comp.profit_share,
  );
  const employerExtras = sum(
    comp.health_insurance_cost,
    comp.malpractice_cost,
    comp.retirement_401k_contribution,
  );
  const employerTotal = providerTotal + employerExtras;
  const fmt = (n: number) => n === 0 ? '—' : `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

  const rowStyle: React.CSSProperties = {
    display: 'flex', justifyContent: 'space-between', gap: 16, fontSize: 13, marginBottom: 8,
  };

  return (
    <div style={{
      background: 'rgba(14,165,233,0.04)',
      border: '1px solid rgba(14,165,233,0.2)',
      borderRadius: 10,
      padding: '14px 18px',
      marginBottom: 16,
    }}>
      <SectionLabel>Totals</SectionLabel>
      <div style={rowStyle}>
        <span style={{ color: 'var(--text-muted)' }}>Provider Total Compensation</span>
        <span style={{ color: 'var(--text)', fontWeight: 700, fontFamily: 'monospace' }}>{fmt(providerTotal)}</span>
      </div>
      <div style={rowStyle}>
        <span style={{ color: 'var(--text-dim)' }}>+ Employer Costs (health, malpractice, 401k)</span>
        <span style={{ color: 'var(--text-muted)', fontFamily: 'monospace' }}>{fmt(employerExtras)}</span>
      </div>
      <div style={{ borderTop: '1px solid rgba(14,165,233,0.2)', paddingTop: 8, display: 'flex', justifyContent: 'space-between', gap: 16, fontSize: 13 }}>
        <span style={{ color: 'var(--text)', fontWeight: 700 }}>Total Cost to Employer</span>
        <span style={{ color: '#0ea5e9', fontWeight: 800, fontFamily: 'monospace' }}>{fmt(employerTotal)}</span>
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 8, lineHeight: 1.5 }}>
        Retention bonus is typically one-time; profit share varies by year. Adjust with context in the notes field.
      </div>
    </div>
  );
}

function MoneyField({ label, value, onChange, hint }: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  hint?: string;
}) {
  // Keep a local string so the user can clear the field or type `-` / `.`
  // without React snapping the value to something weird.
  const [raw, setRaw] = useState(value == null ? '' : String(value));
  useEffect(() => { setRaw(value == null ? '' : String(value)); }, [value]);

  return (
    <div>
      <label style={fieldLabelStyle}>{label}</label>
      <div style={{ position: 'relative' }}>
        <span style={{
          position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)',
          color: 'var(--text-dim)', fontSize: 13, pointerEvents: 'none',
        }}>$</span>
        <input
          value={raw}
          inputMode="decimal"
          onChange={e => {
            const next = e.target.value;
            setRaw(next);
            if (next === '') { onChange(null); return; }
            const n = Number(next);
            if (Number.isFinite(n)) onChange(n);
          }}
          style={{ ...fieldInputStyle, paddingLeft: 22 }}
        />
      </div>
      {hint && <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 3 }}>{hint}</div>}
    </div>
  );
}

// ── History / Burden Tab ───────────────────────────────────────────────────

interface BurdenData {
  period: { from: string; to: string };
  burden: Record<string, number>;
  history: Array<{
    id: string;
    slot_date: string;
    shift_code: string;
    shift_name: string;
    shift_category: string;
    day_type: string | null;
    source_type: string;
  }>;
}

const BURDEN_LABELS: Record<string, string> = {
  total_assignments: 'Total Assignments',
  total_call: 'Total Call',
  weekday_call: 'Weekday Call',
  friday_call: 'Friday Call',
  weekend_call: 'Weekend Call',
  holiday_call: 'Holiday Call',
};

const BURDEN_COLORS: Record<string, string> = {
  total_assignments: '#64748b',
  total_call: '#0ea5e9',
  weekday_call: '#6366f1',
  friday_call: '#f59e0b',
  weekend_call: '#f87171',
  holiday_call: '#10b981',
};

function HistoryTab({ providerId }: { providerId: string }) {
  const [data, setData] = useState<BurdenData | null>(null);
  const [loading, setLoading] = useState(true);
  const [year, setYear] = useState(new Date().getFullYear());

  useEffect(() => {
    setLoading(true);
    fetch(`/api/scheduling/providers/${providerId}/burden?from=${year}-01-01&to=${year}-12-31`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); });
  }, [providerId, year]);

  const formatDate = (d: string) => {
    const date = new Date(d + 'T12:00:00');
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  if (loading) return <div style={{ color: 'var(--text-dim)', padding: '20px 0' }}>Loading...</div>;
  if (!data) return <div style={{ color: 'var(--text-dim)', padding: '20px 0' }}>Failed to load data.</div>;

  return (
    <div style={{ maxWidth: 780 }}>
      {/* Year selector */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
        <button onClick={() => setYear(y => y - 1)} style={yearBtnStyle}>&larr;</button>
        <span style={{ fontSize: 15, fontWeight: 800, color: 'var(--text)', minWidth: 50, textAlign: 'center' }}>{year}</span>
        <button onClick={() => setYear(y => y + 1)} style={yearBtnStyle}>&rarr;</button>
      </div>

      {/* Burden summary cards */}
      <SectionLabel>Call Burden Summary</SectionLabel>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 24 }}>
        {Object.entries(BURDEN_LABELS).map(([key, label]) => (
          <div key={key} style={{
            background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 10,
            padding: '14px 16px', textAlign: 'center',
          }}>
            <div style={{ fontSize: 24, fontWeight: 800, color: BURDEN_COLORS[key] || 'var(--text)' }}>
              {data.burden[key] ?? 0}
            </div>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-dim)', marginTop: 4 }}>
              {label}
            </div>
          </div>
        ))}
      </div>

      {/* Assignment history list */}
      <SectionLabel>Assignments ({data.history.length})</SectionLabel>
      {data.history.length === 0 ? (
        <div style={{ color: 'var(--text-dim)', fontStyle: 'italic', padding: '12px 0' }}>
          No assignments in {year}.
        </div>
      ) : (
        <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', background: 'rgba(14,165,233,0.04)' }}>
                {['Date', 'Shift', 'Category', 'Day Type', 'Source'].map(h => (
                  <th key={h} style={{
                    padding: '8px 12px', textAlign: 'left', fontSize: 10, fontWeight: 800,
                    color: 'var(--text-dim)', letterSpacing: 1, textTransform: 'uppercase',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.history.map(a => (
                <tr key={a.id} style={{ borderBottom: '1px solid rgba(30,58,95,0.3)' }}>
                  <td style={{ padding: '8px 12px', fontWeight: 600, color: 'var(--text)' }}>
                    {formatDate(a.slot_date)}
                  </td>
                  <td style={{ padding: '8px 12px', color: 'var(--text-muted)' }}>
                    <span style={{ fontWeight: 700 }}>{a.shift_code}</span>
                    <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--text-dim)' }}>{a.shift_name}</span>
                  </td>
                  <td style={{ padding: '8px 12px', color: 'var(--text-dim)', textTransform: 'capitalize' }}>
                    {a.shift_category}
                  </td>
                  <td style={{ padding: '8px 12px', color: 'var(--text-dim)', textTransform: 'capitalize' }}>
                    {a.day_type?.replace('_', ' ') || '—'}
                  </td>
                  <td style={{ padding: '8px 12px' }}>
                    <span style={{
                      fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 4,
                      background: a.source_type === 'auto_generated' ? 'rgba(16,185,129,0.12)' : 'rgba(14,165,233,0.12)',
                      color: a.source_type === 'auto_generated' ? '#10b981' : '#0ea5e9',
                    }}>
                      {a.source_type === 'auto_generated' ? 'Auto' : a.source_type === 'manual' ? 'Manual' : a.source_type}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const yearBtnStyle: React.CSSProperties = {
  width: 28, height: 28, borderRadius: 6, border: '1px solid var(--border)',
  background: 'var(--bg-surface)', color: 'var(--text-muted)', cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14,
};

// ── Shared Components ───────────────────────────────────────────────────────
const fieldLabelStyle: React.CSSProperties = {
  fontSize: 10, color: 'var(--text-muted)', display: 'block',
  marginBottom: 4, fontWeight: 600, letterSpacing: 0.5,
  textTransform: 'uppercase',
};
const fieldInputStyle: React.CSSProperties = {
  width: '100%', padding: '6px 10px', borderRadius: 5, border: '0.5px solid var(--border)',
  background: 'var(--bg-deep)', color: 'var(--text)', fontSize: 12,
  outline: 'none',
};
const saveBtnStyle: React.CSSProperties = {
  padding: '7px 18px', borderRadius: 5, cursor: 'pointer', fontWeight: 700, fontSize: 12,
  background: 'linear-gradient(135deg,#0ea5e9,#6366f1)', color: '#fff', border: 'none',
  letterSpacing: 0.2,
};

// Unified save button for profile tabs. Shows an in-flight "Saving..." and a
// transient green "Saved ✓" so the click visibly registers — the previous
// button had no feedback and users thought it wasn't wired up.
function SaveButton({
  onClick,
  canSave,
  saveState,
  idleLabel = 'Save Changes',
}: {
  onClick: () => void;
  canSave: boolean;
  saveState: 'idle' | 'saving' | 'saved';
  idleLabel?: string;
}) {
  const isSaving = saveState === 'saving';
  const isSaved = saveState === 'saved';
  const disabled = !canSave || isSaving;
  const label = isSaving ? 'Saving...' : isSaved ? 'Saved ✓' : idleLabel;
  const style: React.CSSProperties = {
    ...saveBtnStyle,
    background: isSaved ? 'linear-gradient(135deg,#10b981,#059669)' : saveBtnStyle.background,
    opacity: disabled && !isSaving ? 0.5 : 1,
    cursor: disabled ? 'not-allowed' : 'pointer',
    minWidth: 120,
    transition: 'background 0.2s',
  };
  return (
    <button onClick={onClick} disabled={disabled} style={style}>
      {label}
    </button>
  );
}

function Field({ label, value, onChange, type, error, hint }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  error?: string;
  hint?: string;
}) {
  const borderColor = error ? 'rgba(248,113,113,0.6)' : 'var(--border)';
  return (
    <div>
      <label style={fieldLabelStyle}>{label}</label>
      <input
        type={type || 'text'}
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{ ...fieldInputStyle, border: `0.5px solid ${borderColor}` }}
      />
      {error ? (
        <div style={{ fontSize: 10, color: '#dc2626', marginTop: 2 }}>{error}</div>
      ) : hint ? (
        <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 2 }}>{hint}</div>
      ) : null}
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer', padding: '2px 0' }}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} style={{ accentColor: '#0ea5e9', width: 13, height: 13 }} />
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
        width: 13, height: 13, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 9, fontWeight: 800, cursor: 'pointer',
        background: 'rgba(14,165,233,0.12)', color: '#0ea5e9', border: '0.5px solid rgba(14,165,233,0.3)',
        flexShrink: 0, fontFamily: 'var(--font-mono), ui-monospace, monospace',
      }}>i</span>
      {show && (
        <div style={{
          position: 'absolute', top: '100%', left: '50%', transform: 'translateX(-50%)',
          marginTop: 6, padding: '8px 12px', borderRadius: 6, fontSize: 11, lineHeight: 1.5,
          background: '#1e293b', color: '#e2e8f0', border: '0.5px solid #334155',
          boxShadow: '0 4px 16px rgba(15,23,42,0.18)', width: 260, zIndex: 300,
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
    <div style={{
      fontSize: 9, fontWeight: 700, color: 'var(--text-muted)',
      letterSpacing: 1, textTransform: 'uppercase',
      marginBottom: 8, marginTop: 4,
      paddingBottom: 4, borderBottom: '0.5px solid var(--border)',
      fontFamily: 'var(--font-mono), ui-monospace, monospace',
    }}>
      {children}
    </div>
  );
}

function ChipPill({ text, fg, bg }: { text: string; fg: string; bg: string }) {
  return (
    <span style={{
      fontSize: 10, fontWeight: 600, padding: '1px 7px', borderRadius: 999,
      background: bg, color: fg, textTransform: 'capitalize',
      border: `0.5px solid ${fg}30`,
    }}>
      {text}
    </span>
  );
}

function SaveIndicator({ state }: { state: 'idle' | 'saving' | 'saved' }) {
  if (state === 'idle') return null;
  const isSaving = state === 'saving';
  return (
    <span style={{
      fontSize: 10, fontFamily: 'var(--font-mono), ui-monospace, monospace',
      color: isSaving ? '#0ea5e9' : '#10b981',
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 8px', borderRadius: 4,
      background: isSaving ? 'rgba(14,165,233,0.08)' : 'rgba(16,185,129,0.08)',
      border: `0.5px solid ${isSaving ? 'rgba(14,165,233,0.25)' : 'rgba(16,185,129,0.25)'}`,
    }}>
      {isSaving ? '⋯ saving' : '✓ saved'}
    </span>
  );
}
