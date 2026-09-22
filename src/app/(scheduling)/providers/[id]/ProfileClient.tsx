'use client';

import { useState, useEffect } from 'react';
// Imported as `nextDynamic`: `dynamic` is also the name of a Next.js
// route-segment config export, and a page module may only export `default` and
// that reserved set — so the local binding must never be able to collide with
// it. (`tsc` and vitest both pass on a collision; only `next build` catches it.)
import nextDynamic from 'next/dynamic';
import Link from 'next/link';
import {
  PROVIDER_STATUSES,
  PROVIDER_TYPES,
  isValidEmail,
} from '@/lib/validation/providers';
import { AccountCard } from './AccountCard';
import { employmentStatusLabel } from '@/lib/providerEmploymentForm';
import { Badge, Banner, Card, PageHeader, Spinner, type BadgeTone } from '@/components/ui';
import {
  fieldLabelStyle, fieldInputStyle, textAreaStyle, structureType,
  SaveButton, Field, InfoTip, ChipPill, SaveIndicator,
  FormGrid, TabStack, SaveBar,
} from './ui';
// The provider data model. It sits in its own module because a Next.js page
// may not export anything beyond `default` and the route-segment config, and
// the tab modules split out of this file need these shapes — see
// profileShared.ts. One definition, never a per-tab copy.
import type { EmploymentProfile, ProviderDetail } from './profileShared';

// ── Deferred tabs ───────────────────────────────────────────────────────────
// Eight tabs, exactly one of them on screen at a time. Everything except
// Profile is now its own chunk, fetched when the tab is first opened — or
// earlier, on hover (see TAB_LOADERS below). Profile deliberately stays a
// static import: it is what renders when the route opens, so deferring it
// would buy nothing and cost a flash of empty tab body.
const AvailabilityTab = nextDynamic(() => import('./AvailabilityTab').then(m => m.AvailabilityTab), { ssr: false });
const SchedulingTab = nextDynamic(() => import('./SchedulingTab').then(m => m.SchedulingTab), { ssr: false });
const SitesTab = nextDynamic(() => import('./SitesTab').then(m => m.SitesTab), { ssr: false });
const PreferencesTab = nextDynamic(() => import('./PreferencesTab').then(m => m.PreferencesTab), { ssr: false });
const CustomFieldsTab = nextDynamic(() => import('./CustomFieldsTab').then(m => m.CustomFieldsTab), { ssr: false });
const CompensationTab = nextDynamic(() => import('./CompensationTab').then(m => m.CompensationTab), { ssr: false });
const HistoryTab = nextDynamic(() => import('./HistoryTab').then(m => m.HistoryTab), { ssr: false });
const OverviewTab = nextDynamic(() => import('./OverviewTab').then(m => m.OverviewTab), { ssr: false });

type Tab = 'overview' | 'profile' | 'scheduling' | 'preferences' | 'sites' | 'availability' | 'custom' | 'compensation' | 'history';

// Hover / keyboard-focus prefetch for the deferred tabs. A pointer resting on a
// tab in a tab strip is about as strong a "this is the next thing I open" signal
// as a UI gets, and these are the same `import()` calls the nextDynamic loaders
// above make — webpack hands back the one in-flight chunk request rather than a
// second one, so warming it here simply moves the fetch from the click to the
// hover that precedes it. Nothing renders as a result; the only effect is that
// the chunk has usually landed by the time the click does.
//
// Profile is absent on purpose: it is a static import, already in the chunk.
const TAB_LOADERS: Partial<Record<Tab, () => Promise<unknown>>> = {
  scheduling: () => import('./SchedulingTab'),
  preferences: () => import('./PreferencesTab'),
  sites: () => import('./SitesTab'),
  availability: () => import('./AvailabilityTab'),
  custom: () => import('./CustomFieldsTab'),
  compensation: () => import('./CompensationTab'),
  history: () => import('./HistoryTab'),
  overview: () => import('./OverviewTab'),
};

// Same map the providers LIST page carries, so a provider's status reads the
// same in the table and on their profile.
const STATUS_TONES: Record<string, BadgeTone> = {
  active: 'ok',
  inactive: 'neutral',
  on_leave: 'warn',
};

// Byte-identical to the map in providers/page.tsx (and to its first three rows
// plus the `other` fallback in requests/page.tsx) — see the full note there.
// Tokens, not hexes: the seven literals this held were dark-theme values
// painted on the light default, where #f59e0b is ~2.2:1 on white and fails AA
// as 11px avatar ink.
const TYPE_COLORS: Record<string, { color: string; bg: string; label: string }> = {
  physician: { color: 'var(--warn)',       bg: 'color-mix(in srgb, var(--warn) 15%, transparent)',       label: 'Physician' },
  crna:      { color: 'var(--blue)',       bg: 'color-mix(in srgb, var(--blue) 15%, transparent)',       label: 'CRNA' },
  aa:        { color: 'var(--indigo)',     bg: 'color-mix(in srgb, var(--indigo) 15%, transparent)',     label: 'AA' },
  resident:  { color: 'var(--ok)',         bg: 'color-mix(in srgb, var(--ok) 15%, transparent)',         label: 'Resident' },
  fellow:    { color: 'var(--info)',       bg: 'color-mix(in srgb, var(--info) 15%, transparent)',       label: 'Fellow' },
  locums:    { color: 'var(--danger)',     bg: 'color-mix(in srgb, var(--danger) 15%, transparent)',     label: 'Locums' },
  other:     { color: 'var(--text-muted)', bg: 'color-mix(in srgb, var(--text-muted) 15%, transparent)', label: 'Other' },
};

// Default profile used when a provider has no employment profile row yet.
// On first save, the API will INSERT a row for them.
const EMPTY_PROFILE: EmploymentProfile = {
  employment_status: 'full_time',
  fte_value: 1.0,
  work_days_fte: null,
  is_shareholder: false,
  is_partner_track: false,
  is_employed_call_taker: false,
  is_day_doc: false,
  is_icu_doc: false,
  pto_weeks: null,
  min_monthly_shifts: null,
  max_weekly_hours: null,
  call_taker: false,
  partial_call_taker: false,
  schedule_maker: false,
  home_site_id: null,
  fellowship_primary: null,
  fellowships: [],
  skills: [],
  preferred_assignments: [],
  undesired_assignments: [],
  preferred_sites: [],
  undesired_sites: [],
  blocked_dates: [],
  scheduling_notes: null,
  available_weekdays: [true, true, true, true, true, true, true],
  preferred_day_shift_types: [],
  days_per_week: null,
};

// Keep the array reference stable so the `asArray` helper below can normalize
// incoming data coming from Supabase as jsonb (may be null or a plain array).
function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

export interface ProfileClientProps {
  id: string;
  /** Rendered by the server in the same request as the page shell. */
  initialProvider: ProviderDetail | null;
  initialSites: Array<{ id: string; name: string; short_name: string | null }>;
  /** Set when the server read failed; distinct from "provider not found". */
  initialLoadError: string | null;
}

export default function ProfileClient(
  { id, initialProvider, initialSites, initialLoadError }: ProfileClientProps,
) {
  // normalizeProvider, same as the mount fetch used to apply. It coerces
  // eleven jsonb columns that arrive as null into arrays; without it the first
  // tab that maps over one of them throws. Lazy initializer so it runs once
  // rather than on every render — it mutates the object it is given.
  const [provider, setProvider] = useState<ProviderDetail | null>(
    () => (initialProvider ? normalizeProvider(initialProvider) : null),
  );
  const [sites, setSites] = useState<Array<{ id: string; name: string; short_name: string | null }>>(initialSites);
  // Persist tab selection in the URL hash so reload / hard-refresh preserves
  // the current tab. The hash is the lightest-weight option — no router
  // changes, no history entries per tab switch, survives F5 / Cmd+Shift+R.
  const [tab, setTab] = useState<Tab>(() => {
    // Overview is the default: it is the one tab that answers "how is this
    // person doing" rather than "what is stored about them", and it is what
    // the clinician themself sees at /me.
    if (typeof window === 'undefined') return 'overview';
    const h = window.location.hash.replace(/^#/, '');
    const valid: Tab[] = ['overview', 'profile', 'scheduling', 'preferences', 'sites', 'availability', 'custom', 'compensation', 'history'];
    return (valid as string[]).includes(h) ? (h as Tab) : 'overview';
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
  const [loadError, setLoadError] = useState<string | null>(initialLoadError);

  // The provider used to be fetched here on mount, and the site list was
  // gated behind it (`if (!provider?.organization_id) return`) — two
  // sequential round trips behind every click on a provider chip. Both are
  // resolved by the server component now. `reload()` below still exists and is
  // what runs after a save.

  // Load all sites for the provider's org so we can offer them in dropdowns.
  useEffect(() => {
    // Seeded by the server; this covers only the case where that read failed,
    // so the dropdowns can still fill in rather than staying empty.
    if (sites.length > 0) return;
    if (!provider?.organization_id) return;
    fetch(`/api/scheduling/sites?org_id=${provider.organization_id}`)
      .then(r => r.json())
      .then(setSites);
  }, [provider?.organization_id, sites.length]);

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
      <div style={{ padding: 'var(--space-6)', maxWidth: 640 }}>
        <Banner tone="error">{loadError}</Banner>
        <div style={{ marginTop: 'var(--space-4)' }}>
          <Link href="/providers" className="fr-focus" style={{ color: 'var(--blue)', fontSize: 'var(--fs-sm)', textDecoration: 'none' }}>
            ← Back to providers
          </Link>
        </div>
      </div>
    );
  }
  if (!provider) {
    return (
      <div style={{ padding: 'var(--space-6)', display: 'flex', alignItems: 'center', gap: 'var(--space-3)', color: 'var(--text-muted)', fontSize: 'var(--fs-sm)' }}>
        <Spinner /> Loading provider…
      </div>
    );
  }

  const prof = provider.provider_employment_profiles?.[0] || null;
  const tc = TYPE_COLORS[provider.provider_type] || TYPE_COLORS.other;

  const TABS: { key: Tab; label: string; info: string }[] = [
    { key: 'overview', label: 'Overview', info: 'How this clinician is standing right now — employment, call owed against call taken, hours scheduled, credentialed sites and PTO. This is the same screen they see when they sign in.' },
    { key: 'profile', label: 'Profile', info: 'Basic provider information — name, contact details, NPI, employee ID, and admin notes.' },
    { key: 'scheduling', label: 'Employment & Scheduling', info: 'Employment status, FTE, call eligibility, specialty capabilities, and scheduling constraints. These settings determine what shifts this provider can be assigned to.' },
    { key: 'preferences', label: 'Preferences & Specialties', info: 'Preferred and undesired shift types or sites, fellowships, skills, and custom blocked dates. The scheduler uses these as soft preferences.' },
    { key: 'sites', label: 'Sites & Credentials', info: 'Which hospitals and surgery centers this provider is credentialed at, effective dates, and site-specific call / shift-type restrictions.' },
    { key: 'availability', label: 'Availability', info: 'PTO schedule, PTO sell-back, days off, no-call requests (while a request window is open), ICU rotation weeks, and other leave. The scheduler checks this before assigning shifts.' },
    { key: 'custom', label: 'Custom Fields', info: 'Organization-defined extra fields. Configure which fields exist under Settings → Provider Custom Fields.' },
    { key: 'compensation', label: 'Compensation', info: 'ADMIN ONLY — salary, stipends, bonuses, and benefits costs. Currently visible to anyone with app access; will be gated to admins once auth/RLS is in place.' },
    { key: 'history', label: 'Assignment History', info: 'Past shift and call assignments for this provider, including burden tracking and fairness metrics.' },
  ];

  return (
    <div style={{ padding: 'var(--space-5) var(--space-6) var(--space-8)', maxWidth: 1200 }}>
      {/* Breadcrumb — Register 1, so the uppercase transform does the
          lower-casing the old copy did by hand. */}
      <nav
        aria-label="Breadcrumb"
        style={{ ...structureType, display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-3)' }}
      >
        <Link href="/providers" className="fr-focus" style={{ color: 'var(--blue)', textDecoration: 'none' }}>providers</Link>
        <span aria-hidden="true" style={{ color: 'var(--text-faint)' }}>/</span>
        <span>{provider.last_name}, {provider.first_name}</span>
      </nav>

      {/* The identity header is this page's ONE loud moment, and it is the kit's
          own PageHeader rather than a bespoke bordered strip: same h1 scale
          (--fs-xl, -0.5 tracking) as every other page in the app, so the
          profile stops announcing itself as a different product. Its `title`
          is typed as ReactNode precisely so a page can decorate it, which is
          where the avatar goes.

          Exactly one hue rides here — the provider TYPE — and the rest of the
          metadata is quiet kit Badges. The old header spent four different
          hardcoded colours (#0e7c52, #534AB7, #0C447C, plus the type) on four
          chips of equal weight, so none of them meant anything. */}
      <PageHeader
        title={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-3)' }}>
            <span style={{
              width: 48, height: 48, borderRadius: 'var(--radius-md)',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 'var(--fs-lg)', fontWeight: 700, letterSpacing: 0,
              background: tc.bg, color: tc.color,
              // color-mix rather than a `${tc.color}40` suffix: the alpha
              // trick is silently tied to tc.color staying a 6-digit hex.
              border: `1px solid color-mix(in srgb, ${tc.color} 25%, transparent)`,
              overflow: 'hidden', flexShrink: 0,
              fontFamily: 'var(--font-mono), ui-monospace, monospace',
            }}>
              {provider.photo_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={provider.photo_url}
                  alt=""
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                />
              ) : (
                provider.initials
              )}
            </span>
            {provider.first_name} {provider.last_name}
          </span>
        }
        subtitle={
          <span style={{ display: 'inline-flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
            <ChipPill text={tc.label} fg={tc.color} bg={tc.bg} />
            {/* Same status→tone map the providers LIST page uses, so one
                provider reads identically in both places. */}
            <Badge tone={STATUS_TONES[provider.status] ?? 'neutral'}>{provider.status.replace('_', ' ')}</Badge>
            {prof?.employment_status && <Badge tone="neutral">{employmentStatusLabel(prof.employment_status)}</Badge>}
            {prof?.fellowship_primary && <Badge tone="neutral">{prof.fellowship_primary}</Badge>}
          </span>
        }
        actions={<SaveIndicator state={saveState} />}
      />

      {/* Tabs. Active state is carried by WEIGHT + a token underline rather
          than by recolouring the label: the old active colour was #0ea5e9,
          the dark-theme --blue, on a light background. The Compensation tab
          keeps a --warn underline because "this one is sensitive" is real
          information, not decoration.

          The hand-rolled button wears the kit's own .fr-btn classes instead of
          a hand-written transition, so it moves at the house rate (motion
          tokens) and depresses 1px on click like every other control. The
          hover contract is .fr-btn-ghost, and only the INACTIVE tabs take it —
          there is nowhere for the current tab to hover to. */}
      <div style={{
        display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap',
        borderBottom: '1px solid var(--border)', marginBottom: 'var(--space-5)',
      }}>
        {TABS.map(t => {
          const isAdminTab = t.key === 'compensation';
          const isActive = tab === t.key;
          const underline = isAdminTab ? 'var(--warn)' : 'var(--blue)';
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              // Warm the tab's chunk before the click. Keyboard users get the
              // same head start on focus, since they never generate a hover.
              onMouseEnter={() => { TAB_LOADERS[t.key]?.(); }}
              onFocus={() => { TAB_LOADERS[t.key]?.(); }}
              className={`fr-focus fr-btn${isActive ? '' : ' fr-btn-ghost'}`}
              aria-current={isActive ? 'page' : undefined}
              style={{
                padding: 'var(--space-2) var(--space-3)',
                fontSize: 'var(--fs-sm)', fontWeight: isActive ? 700 : 500,
                fontFamily: 'inherit', cursor: 'pointer',
                border: 'none',
                // The ACTIVE tab paints its own background and ink here
                // because it carries no variant class. The INACTIVE tabs must
                // NOT: .fr-btn-ghost supplies exactly these two resting values
                // (transparent / --text-muted) and then changes both on hover,
                // and an inline declaration outranks a class rule — so setting
                // them here unconditionally, as this did, is what makes a tab
                // strip that looks correct and is inert under the cursor.
                ...(isActive ? { background: 'none', color: 'var(--text-strong)' } : null),
                borderBottom: `2px solid ${isActive ? underline : 'transparent'}`,
                display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
                marginBottom: -1, // sit on top of the container border
              }}
            >
              {t.label}
              {isAdminTab && <Badge tone="warn">admin</Badge>}
              {isActive && <InfoTip text={t.info} />}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      {tab === 'overview' && <OverviewTab providerId={id} />}
      {tab === 'profile' && <ProfileTab provider={provider} saveState={saveState} onSave={save} />}
      {tab === 'scheduling' && <SchedulingTab profile={prof || EMPTY_PROFILE} sites={sites} saveState={saveState} onSave={save} />}
      {tab === 'preferences' && <PreferencesTab profile={prof || EMPTY_PROFILE} sites={sites} saveState={saveState} onSave={save} />}
      {tab === 'sites' && <SitesTab providerId={id} credentials={provider.provider_site_credentials || []} sites={sites} onChanged={reload} />}
      {tab === 'availability' && (
        <AvailabilityTab
          providerId={id}
          profile={prof}
          orgId={provider?.organization_id ?? ''}
          sites={sites}
        />
      )}
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
    <TabStack>
      {/* Photo sits inside Identity rather than in a section of its own: a
          face IS identity, and a card holding one URL field was the thinnest
          of the five sections this tab used to run down the page. */}
      <Card title="Identity">
        <FormGrid cols="1fr 1fr">
          <Field label="First name *" value={firstName} onChange={setFirstName} error={errors.firstName} />
          <Field label="Last name *" value={lastName} onChange={setLastName} error={errors.lastName} />
          <Field label="Preferred display name" value={preferredDisplay} onChange={setPreferredDisplay} hint={`Defaults to "${firstName} ${lastName}"`} />
          <div>
            <label style={fieldLabelStyle}>Provider type</label>
            <select value={providerType} onChange={e => setProviderType(e.target.value)} className="fr-field" style={fieldInputStyle}>
              {PROVIDER_TYPES.map(t => (
                <option key={t} value={t}>{TYPE_COLORS[t]?.label ?? t}</option>
              ))}
            </select>
          </div>
          <div>
            <label style={fieldLabelStyle}>Status</label>
            <select value={status} onChange={e => setStatus(e.target.value)} className="fr-field" style={fieldInputStyle}>
              {PROVIDER_STATUSES.map(s => (
                <option key={s} value={s}>{s.replace('_', ' ')}</option>
              ))}
            </select>
          </div>
        </FormGrid>

        <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-start', marginTop: 'var(--space-4)' }}>
          <div style={{
            width: 64, height: 64, borderRadius: 'var(--radius-md)', overflow: 'hidden', flexShrink: 0,
            background: 'var(--bg-deep)', border: '1px solid var(--border)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', textAlign: 'center', padding: 'var(--space-1)',
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
          <div style={{ flex: 1, minWidth: 0 }}>
            <Field
              label="Photo URL"
              value={photoUrl}
              onChange={setPhotoUrl}
              hint="Paste a publicly-accessible image URL. Upload-from-device coming soon."
            />
          </div>
        </div>
      </Card>

      <Card title="Contact">
        <FormGrid cols="1fr 1fr">
          <Field label="Email" value={email} onChange={setEmail} error={errors.email} />
          <Field label="Phone" value={phone} onChange={setPhone} />
          <div style={{ gridColumn: '1 / -1' }}>
            <Field label="Home address" value={homeAddress} onChange={setHomeAddress} />
          </div>
        </FormGrid>
      </Card>

      <Card title="Credentials & employment records">
        <FormGrid cols="1fr 1fr 1fr">
          <Field label="NPI" value={npi} onChange={setNpi} />
          <Field label="Employee ID" value={employeeId} onChange={setEmployeeId} />
          <Field label="Payroll ID" value={payrollId} onChange={setPayrollId} />
          <Field label="Start date" value={startDate} onChange={setStartDate} type="date" />
          <div style={{ minWidth: 0 }}>
            <label style={fieldLabelStyle}>Color tag</label>
            <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'stretch' }}>
              <input
                type="text"
                value={colorTag}
                onChange={(e) => setColorTag(e.target.value)}
                placeholder="#6366f1"
                className="fr-field"
                style={{ ...fieldInputStyle, flex: 1, fontFamily: 'var(--font-mono), ui-monospace, monospace' }}
              />
              <div
                aria-hidden="true"
                style={{
                  width: 36, borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
                  background: swatchValid ? colorTag.trim() : 'transparent',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: 'var(--text-dim)', fontSize: 'var(--fs-xs)', flexShrink: 0,
                }}
              >
                {!swatchValid && '—'}
              </div>
            </div>
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 'var(--space-1)' }}>
              Used in schedule views.
            </div>
          </div>
        </FormGrid>
      </Card>

      <Card title="Admin notes">
        <textarea
          value={notes} onChange={e => setNotes(e.target.value)}
          placeholder="Internal notes visible only to admins…"
          aria-label="Admin notes"
          className="fr-field"
          style={textAreaStyle}
        />
      </Card>

      <AccountCard providerId={provider.id} />

      <SaveBar>
        <SaveButton onClick={handleSave} canSave={canSave} saveState={saveState} />
      </SaveBar>
    </TabStack>
  );
}
