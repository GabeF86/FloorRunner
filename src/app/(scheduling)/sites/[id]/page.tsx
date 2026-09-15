'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { PageHeader, Card, Badge, Button, Modal, EmptyState, Banner } from '@/components/ui';

/* ── Interfaces ──────────────────────────────────────────────────────────── */

interface ShiftType {
  id: string;
  site_id: string;
  name: string;
  code: string;
  category: string;
  provider_group: string;
  start_time: string | null;
  end_time: string | null;
  crosses_midnight: boolean;
  duration_hours: number | null;
  color_hex: string | null;
  display_order: number | null;
  counts_toward_hours: boolean;
  counts_toward_call_burden: boolean;
  counts_as_weekend_burden: boolean;
  counts_as_holiday_burden: boolean;
  requires_post_call_rule: boolean;
  requires_backup_pairing: boolean;
  can_auto_assign: boolean;
  manual_only: boolean;
  is_active: boolean;
  call_type: string | null;
  call_coverage_type: string | null;
  early_out_post_call: boolean;
}

interface ShiftTemplate {
  id: string;
  site_id: string;
  schedule_layer: string;
  day_type: string;
  shift_type_id: string;
  required_count: number;
  generation_priority: number | null;
  is_active: boolean;
  shift_types?: { name: string; code: string; color_hex: string | null };
}

interface Holiday {
  id: string;
  organization_id: string;
  site_id: string | null;
  holiday_name: string;
  holiday_date: string;
  holiday_type: string;
  color_hex: string | null;
  is_major_holiday: boolean;
}

interface SiteDetail {
  id: string;
  organization_id: string;
  name: string;
  short_name: string | null;
  site_type: string;
  address: string | null;
  timezone: string | null;
  is_active: boolean;
  display_order: number | null;
  operational_days: Record<string, boolean> | null;
  notes: string | null;
  shift_types: ShiftType[];
  shift_templates: ShiftTemplate[];
}

type Tab = 'general' | 'shift-types' | 'templates' | 'holidays';

/* ── Color Maps ──────────────────────────────────────────────────────────── */

/** A tone tint at the Badge kit's weight, derived from the token rather than
 *  hand-mixed, so it follows the accent into dark mode instead of staying a
 *  fixed rgba() tuned for one theme. */
const tint = (token: string, pct = 12) => `color-mix(in srgb, ${token} ${pct}%, transparent)`;

/* NOTE: this map is duplicated verbatim in ../page.tsx (the sites list), which
   renders the same type pill. The two are kept byte-identical — change both or
   neither.

   Site TYPE is a three-way enum, not a database colour (that is `color_hex`),
   and the literals this used to hold — #0ea5e9 / #10b981 / #f59e0b — were the
   DARK-theme values of --blue / --ok / --warn. In dark they are byte-identical
   to those tokens; on the light default they were sky-on-white, emerald-on-white
   and amber-on-white, none of which clears AA at 11px. Same hues, now AA-passing
   in light, and they follow the accent into dark. The tint keeps its original
   15% weight rather than dropping to the .10/.12 of the paired --*-bg tokens,
   so the pill's fill is unchanged. */
const SITE_TYPE_COLORS: Record<string, { color: string; bg: string; label: string }> = {
  hospital: { color: 'var(--blue)', bg: tint('var(--blue)', 15), label: 'Hospital' },
  asc:      { color: 'var(--ok)',   bg: tint('var(--ok)', 15),   label: 'ASC' },
  office:   { color: 'var(--warn)', bg: tint('var(--warn)', 15), label: 'Office' },
};

const CATEGORY_COLORS: Record<string, { color: string; bg: string; label: string }> = {
  call:        { color: 'var(--danger)',     bg: 'var(--danger-bg)',        label: 'Call' },
  regular:     { color: 'var(--blue)',       bg: tint('var(--blue)'),       label: 'Regular' },
  float:       { color: 'var(--warn)',       bg: 'var(--warn-bg)',          label: 'Float' },
  admin:       { color: 'var(--indigo)',     bg: tint('var(--indigo)'),     label: 'Admin' },
  unavailable: { color: 'var(--text-muted)', bg: 'var(--tint-surface)',     label: 'Unavailable' },
  leave:       { color: 'var(--ok)',         bg: 'var(--ok-bg)',            label: 'Leave' },
};

const PROVIDER_GROUPS = [
  { value: 'physician', label: 'Physician' },
  { value: 'crna', label: 'CRNA' },
  { value: 'both', label: 'Both' },
];

const DAY_TYPES = [
  { value: 'weekday', label: 'Weekday' },
  { value: 'friday', label: 'Friday' },
  { value: 'saturday', label: 'Saturday' },
  { value: 'sunday', label: 'Sunday' },
  { value: 'federal_holiday', label: 'Federal Holiday' },
  { value: 'major_holiday', label: 'Major Holiday' },
];

const SCHEDULE_LAYERS = [
  { value: 'call', label: 'Call' },
  { value: 'shifts', label: 'Shifts' },
  { value: 'assignments', label: 'Assignments' },
];

const HOLIDAY_TYPES = [
  { value: 'federal', label: 'Federal' },
  { value: 'religious', label: 'Religious' },
  { value: 'organizational', label: 'Organizational' },
  { value: 'custom', label: 'Custom' },
];

const HOLIDAY_TYPE_COLORS: Record<string, { color: string; bg: string }> = {
  federal:        { color: 'var(--blue)',       bg: tint('var(--blue)') },
  religious:      { color: 'var(--indigo)',     bg: tint('var(--indigo)') },
  organizational: { color: 'var(--warn)',       bg: 'var(--warn-bg)' },
  custom:         { color: 'var(--text-muted)', bg: 'var(--tint-surface)' },
};

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

/* ── Main Page ───────────────────────────────────────────────────────────── */

export default function SiteDetailPage({ params }: { params: { id: string } }) {
  const { id } = params;
  const [site, setSite] = useState<SiteDetail | null>(null);
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [tab, setTab] = useState<Tab>('general');
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const loadSite = useCallback(async () => {
    try {
      const res = await fetch(`/api/scheduling/sites/${id}`, { cache: 'no-store' });
      const data = await res.json().catch(() => null);
      // The route answers a failure with `{ error }`, which is NOT a site:
      // storing it would blank the header and show every tab as empty, so a
      // failed read has to surface as an error and keep the last-known site.
      if (!res.ok) {
        setLoadError(data?.error || `Failed to load site (${res.status})`);
        return;
      }
      setLoadError(null);
      setSite(data);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Network error loading site');
    }
  }, [id]);

  const loadHolidays = useCallback(async () => {
    if (!site) return;
    const res = await fetch(`/api/scheduling/holidays?org_id=${site.organization_id}`);
    setHolidays(await res.json());
  }, [site]);

  useEffect(() => { loadSite(); }, [loadSite]);
  useEffect(() => { if (site) loadHolidays(); }, [site?.organization_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveSite = async (updates: Record<string, unknown>) => {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(`/api/scheduling/sites/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      const data = await res.json().catch(() => null);
      // Same reason as loadSite: on failure the body is `{ error }`, and
      // assigning it would replace the site with a blank header while the
      // edits the user just made silently appear to have "saved".
      if (!res.ok) {
        setSaveError(data?.error || `Save failed (${res.status})`);
        return;
      }
      setSite(data);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Network error saving site');
    } finally {
      setSaving(false);
    }
  };

  if (!site) {
    if (loadError) {
      return (
        <div style={{ padding: 'var(--space-6) var(--space-7)', maxWidth: 640 }}>
          <Banner tone="error">{loadError}</Banner>
          <div style={{ marginTop: 'var(--space-4)' }}>
            <Link href="/sites" className="fr-focus" style={{ color: 'var(--blue)', fontSize: 'var(--fs-sm)', textDecoration: 'none', borderRadius: 'var(--radius-sm)' }}>← Back to sites</Link>
          </div>
        </div>
      );
    }
    return <div style={{ padding: 'var(--space-8)', color: 'var(--text-muted)', fontSize: 'var(--fs-sm)' }}>Loading...</div>;
  }

  const tc = SITE_TYPE_COLORS[site.site_type] || SITE_TYPE_COLORS.hospital;

  const TABS: { key: Tab; label: string; info: string }[] = [
    { key: 'general', label: 'General', info: 'Basic site information — name, address, timezone, and which days this site operates.' },
    { key: 'shift-types', label: 'Shift Types', info: 'Define all possible shifts at this site (e.g. C1, C2, D1-D8, 8hr, 10hr). Each shift type has a name, code, category, times, and scheduling rules.' },
    { key: 'templates', label: 'Shift Templates', info: 'Configure how many of each shift type are needed on each day type (weekday, friday, weekend, holiday). The scheduler uses these to know how many slots to create.' },
    { key: 'holidays', label: 'Holidays', info: 'Manage the holiday calendar for this site. Holidays affect which shift templates apply and how call burden is tracked.' },
  ];

  return (
    <div style={{ padding: 'var(--space-6) var(--space-7)' }}>
      {/* Breadcrumb */}
      <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-dim)', marginBottom: 'var(--space-4)' }}>
        <Link href="/sites" className="fr-focus" style={{ color: 'var(--blue)', textDecoration: 'none', borderRadius: 'var(--radius-sm)' }}>Sites</Link>
        <span style={{ margin: '0 6px' }}>/</span>
        <span>{site.name}</span>
      </div>

      {/* Header */}
      <PageHeader
        title={site.name}
        subtitle={
          <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{
              fontSize: 'var(--fs-xs)', fontWeight: 700, padding: '2px 8px', borderRadius: 999,
              background: tc.bg, color: tc.color,
              // Hairline in the pill's own ink, matching Badge — a flat tint
              // has no edge against a light surface.
              border: `1px solid color-mix(in srgb, ${tc.color} 22%, transparent)`,
            }}>
              {tc.label}
            </span>
            <Badge tone={site.is_active ? 'ok' : 'neutral'}>{site.is_active ? 'Active' : 'Inactive'}</Badge>
            {site.timezone && <Badge tone="info">{site.timezone}</Badge>}
          </div>
        }
        actions={saving ? <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--blue)' }}>Saving...</span> : undefined}
      />

      {/* Errors — the site on screen is the last good copy, not the failed one */}
      {(saveError || loadError) && (
        <div style={{ display: 'grid', gap: 'var(--space-2)', marginBottom: 'var(--space-4)' }}>
          {saveError && <Banner tone="error" onDismiss={() => setSaveError(null)}>{saveError}</Banner>}
          {loadError && <Banner tone="error" onDismiss={() => setLoadError(null)}>{loadError} — showing the last loaded version of this site.</Banner>}
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--border)', marginBottom: 'var(--space-6)' }}>
        {TABS.map(t => (
          // fr-seg carries the transparent base, the hover tint and the 1px
          // press nudge. Background is deliberately NOT set inline — an inline
          // background outranks the class's :hover and the tab would have no
          // hover at all. The inline colour is set, so hovering the selected
          // tab cannot wash out its accent.
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            aria-pressed={tab === t.key}
            className="fr-seg"
            style={{
              padding: '10px 18px', fontSize: 'var(--fs-sm)', fontWeight: 700, cursor: 'pointer',
              fontFamily: 'inherit',
              border: 'none',
              borderBottom: `2px solid ${tab === t.key ? 'var(--blue)' : 'transparent'}`,
              borderRadius: 'var(--radius-sm) var(--radius-sm) 0 0',
              color: tab === t.key ? 'var(--blue)' : 'var(--text-muted)',
              display: 'flex', alignItems: 'center', gap: 5,
            }}
          >
            {t.label}
            {tab === t.key && <InfoTip text={t.info} />}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === 'general' && <GeneralTab site={site} onSave={saveSite} />}
      {tab === 'shift-types' && <ShiftTypesTab site={site} onReload={loadSite} />}
      {tab === 'templates' && <ShiftTemplatesTab site={site} onReload={loadSite} />}
      {tab === 'holidays' && <HolidaysTab site={site} holidays={holidays} onReload={loadHolidays} />}
    </div>
  );
}

/* ── General Tab ─────────────────────────────────────────────────────────── */

function GeneralTab({ site, onSave }: { site: SiteDetail; onSave: (u: Record<string, unknown>) => void }) {
  const [name, setName] = useState(site.name);
  const [shortName, setShortName] = useState(site.short_name || '');
  const [siteType, setSiteType] = useState(site.site_type);
  const [address, setAddress] = useState(site.address || '');
  const [timezone, setTimezone] = useState(site.timezone || 'America/New_York');
  const [notes, setNotes] = useState(site.notes || '');
  const [opDays, setOpDays] = useState<Record<string, boolean>>(
    site.operational_days || { monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: false, sunday: false }
  );

  const toggleDay = (day: string) => {
    setOpDays(prev => ({ ...prev, [day]: !prev[day] }));
  };

  const handleSave = () => {
    onSave({
      name: name.trim(),
      short_name: shortName.trim() || null,
      site_type: siteType,
      address: address.trim() || null,
      timezone,
      notes: notes.trim() || null,
      operational_days: opDays,
    });
  };

  return (
    <div style={{ maxWidth: 640 }}>
      <SectionLabel>Site Information</SectionLabel>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)', marginBottom: 'var(--space-4)' }}>
        <Field label="Site Name" value={name} onChange={setName} />
        <Field label="Short Name" value={shortName} onChange={setShortName} />
      </div>

      <label style={fieldLabelStyle}>Site Type</label>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--space-1)', marginBottom: 14 }}>
        {Object.entries(SITE_TYPE_COLORS).map(([t, c]) => (
          <SegButton key={t} on={siteType === t} tone={c.color} bg={c.bg}
            onClick={() => setSiteType(t)} style={{ padding: '8px 12px', fontSize: 'var(--fs-sm)' }}>
            {c.label}
          </SegButton>
        ))}
      </div>

      <Field label="Address" value={address} onChange={setAddress} />

      <label style={fieldLabelStyle}>Timezone</label>
      <select className="fr-field" value={timezone} onChange={e => setTimezone(e.target.value)} style={{ ...fieldInputStyle, cursor: 'pointer', marginBottom: 'var(--space-4)' }}>
        <option value="America/New_York">America/New_York (Eastern)</option>
        <option value="America/Chicago">America/Chicago (Central)</option>
        <option value="America/Denver">America/Denver (Mountain)</option>
        <option value="America/Los_Angeles">America/Los_Angeles (Pacific)</option>
        <option value="America/Phoenix">America/Phoenix (Arizona)</option>
        <option value="Pacific/Honolulu">Pacific/Honolulu (Hawaii)</option>
        <option value="America/Anchorage">America/Anchorage (Alaska)</option>
      </select>

      <SectionLabel>Operational Days</SectionLabel>
      <div style={{ display: 'flex', gap: 'var(--space-1)', marginBottom: 'var(--space-5)', flexWrap: 'wrap' }}>
        {WEEKDAYS.map(day => (
          <SegButton key={day} on={!!opDays[day]} tone="var(--blue)" bg={tint('var(--blue)', 14)}
            onClick={() => toggleDay(day)}
            style={{ padding: '8px 14px', fontSize: 'var(--fs-sm)', textTransform: 'capitalize' }}>
            {day.slice(0, 3)}
          </SegButton>
        ))}
      </div>

      <SectionLabel>Notes</SectionLabel>
      <textarea
        className="fr-field"
        value={notes}
        onChange={e => setNotes(e.target.value)}
        placeholder="Internal notes about this site..."
        style={{
          width: '100%', minHeight: 80, padding: '10px 12px', borderRadius: 'var(--radius-sm)',
          border: '1px solid var(--border)', background: 'var(--bg-deep)',
          color: 'var(--text)', fontSize: 'var(--fs-sm)', fontFamily: 'inherit',
          resize: 'vertical', marginBottom: 'var(--space-4)',
        }}
      />

      <Button onClick={handleSave}>Save Changes</Button>
    </div>
  );
}

/* ── Shift Types Tab ─────────────────────────────────────────────────────── */

function ShiftTypesTab({ site, onReload }: { site: SiteDetail; onReload: () => void }) {
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const shiftTypes = site.shift_types || [];

  const handleDelete = async (stId: string) => {
    if (!confirm('Delete this shift type?')) return;
    await fetch(`/api/scheduling/shift-types/${stId}`, { method: 'DELETE' });
    onReload();
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-4)' }}>
        <SectionLabel>Shift Types ({shiftTypes.length})</SectionLabel>
        <Button size="sm" onClick={() => { setEditId(null); setShowAdd(true); }}>+ Add Shift Type</Button>
      </div>

      <Card pad={false}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-sm)' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--tint-surface-faint)' }}>
              {['Color', 'Name', 'Code', 'Category', 'Group', 'Times', 'Duration', 'Flags', ''].map(h => (
                <th key={h} style={TH_STYLE}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shiftTypes.map(st => {
              const cat = CATEGORY_COLORS[st.category] || CATEGORY_COLORS.regular;
              return (
                <tr key={st.id} className="fr-row" style={{ borderBottom: '1px solid var(--border-faint)', cursor: 'pointer' }}
                  onClick={() => { setEditId(st.id); setShowAdd(true); }}>
                  <td style={TD_STYLE}>
                    <div style={{
                      width: 24, height: 24, borderRadius: 'var(--radius-sm)',
                      // color_hex is the shift type's stored colour — data, not style.
                      background: st.color_hex || 'var(--text-faint)',
                      border: '1px solid var(--border-subtle)',
                      boxShadow: 'var(--shadow-xs)',
                    }} />
                  </td>
                  <td style={{ ...TD_STYLE, fontWeight: 700, color: 'var(--text)' }}>{st.name}</td>
                  <td style={{ ...TD_STYLE, color: 'var(--text-muted)', fontFamily: 'var(--font-mono), ui-monospace, monospace' }}>{st.code}</td>
                  <td style={TD_STYLE}>
                    <div style={{ display: 'flex', gap: 'var(--space-1)', alignItems: 'center' }}>
                      <span style={{ ...TONE_PILL, background: cat.bg, color: cat.color, border: `1px solid ${tint(cat.color, 22)}` }}>{cat.label}</span>
                      {st.call_type && (
                        <span style={{
                          ...TONE_PILL, fontSize: 'var(--fs-xs)', fontWeight: 600,
                          background: 'var(--tint-surface)', color: 'var(--text-muted)',
                          border: '1px solid var(--border-subtle)',
                        }}>{st.call_type}</span>
                      )}
                      {st.call_coverage_type && (
                        <span style={{
                          ...TONE_PILL, fontWeight: 600,
                          background: st.call_coverage_type === 'full_beeper' ? 'var(--danger-bg)' : 'var(--warn-bg)',
                          color: st.call_coverage_type === 'full_beeper' ? 'var(--danger)' : 'var(--warn)',
                          border: `1px solid ${tint(st.call_coverage_type === 'full_beeper' ? 'var(--danger)' : 'var(--warn)', 22)}`,
                        }}>{st.call_coverage_type === 'full_beeper' ? 'Full Beeper' : 'Partial Beeper'}</span>
                      )}
                    </div>
                  </td>
                  <td style={{ ...TD_STYLE, color: 'var(--text-muted)', textTransform: 'capitalize' }}>
                    {st.provider_group}
                  </td>
                  <td style={{ ...TD_STYLE, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
                    {st.start_time && st.end_time
                      ? `${st.start_time.slice(0, 5)} - ${st.end_time.slice(0, 5)}`
                      : '—'}
                    {st.crosses_midnight && <span style={{ color: 'var(--warn)', marginLeft: 'var(--space-1)', fontSize: 'var(--fs-xs)' }}>+1d</span>}
                  </td>
                  <td style={{ ...TD_STYLE, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
                    {st.duration_hours ? `${st.duration_hours}h` : '—'}
                  </td>
                  <td style={TD_STYLE}>
                    <div style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap' }}>
                      {st.counts_toward_call_burden && <FlagBadge label="Call" />}
                      {st.counts_as_weekend_burden && <FlagBadge label="Wknd" />}
                      {st.counts_as_holiday_burden && <FlagBadge label="Hol" />}
                      {st.requires_post_call_rule && <FlagBadge label="Post" />}
                      {st.early_out_post_call && <FlagBadge label="Early Out" />}
                      {st.manual_only && <FlagBadge label="Manual" />}
                    </div>
                  </td>
                  <td style={{ ...TD_STYLE, textAlign: 'right' }}>
                    <Button variant="danger" size="sm" onClick={(e) => { e.stopPropagation(); handleDelete(st.id); }}>Delete</Button>
                  </td>
                </tr>
              );
            })}
            {shiftTypes.length === 0 && (
              <tr>
                <td colSpan={9} style={{ padding: 0 }}>
                  <EmptyState icon="◴" title="No shift types configured" hint="Add one to get started." />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      {showAdd && (
        <ShiftTypeModal
          siteId={site.id}
          existing={editId ? shiftTypes.find(st => st.id === editId) || null : null}
          onClose={() => setShowAdd(false)}
          onSaved={() => { setShowAdd(false); onReload(); }}
        />
      )}
    </div>
  );
}

function FlagBadge({ label }: { label: string }) {
  return (
    <span style={{
      fontSize: 9, fontWeight: 700, padding: '2px 5px', borderRadius: 4,
      background: tint('var(--indigo)'), color: 'var(--indigo)',
      border: `1px solid ${tint('var(--indigo)', 22)}`,
      whiteSpace: 'nowrap',
    }}>{label}</span>
  );
}

/* ── Shift Type Modal ────────────────────────────────────────────────────── */

function ShiftTypeModal({ siteId, existing, onClose, onSaved }: {
  siteId: string; existing: ShiftType | null; onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState(existing?.name || '');
  const [code, setCode] = useState(existing?.code || '');
  const [category, setCategory] = useState(existing?.category || 'regular');
  const [callType, setCallType] = useState(existing?.call_type || '');
  const [callCoverageType, setCallCoverageType] = useState(existing?.call_coverage_type || '');
  const [earlyOutPostCall, setEarlyOutPostCall] = useState(existing?.early_out_post_call ?? false);
  const [providerGroup, setProviderGroup] = useState(existing?.provider_group || 'both');
  const [startTime, setStartTime] = useState(existing?.start_time?.slice(0, 5) || '');
  const [endTime, setEndTime] = useState(existing?.end_time?.slice(0, 5) || '');
  const [durationHours, setDurationHours] = useState(String(existing?.duration_hours ?? ''));
  const [colorHex, setColorHex] = useState(existing?.color_hex || '#0ea5e9');
  const [displayOrder, setDisplayOrder] = useState(String(existing?.display_order ?? '0'));
  const [countsHours, setCountsHours] = useState(existing?.counts_toward_hours ?? true);
  const [countsCall, setCountsCall] = useState(existing?.counts_toward_call_burden ?? false);
  const [countsWeekend, setCountsWeekend] = useState(existing?.counts_as_weekend_burden ?? false);
  const [countsHoliday, setCountsHoliday] = useState(existing?.counts_as_holiday_burden ?? false);
  const [postCallRule, setPostCallRule] = useState(existing?.requires_post_call_rule ?? false);
  const [backupPairing, setBackupPairing] = useState(existing?.requires_backup_pairing ?? false);
  const [autoAssign, setAutoAssign] = useState(existing?.can_auto_assign ?? true);
  const [manualOnly, setManualOnly] = useState(existing?.manual_only ?? false);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!name.trim() || !code.trim()) return;
    setSaving(true);
    const body = {
      site_id: siteId,
      name: name.trim(),
      code: code.trim(),
      category,
      call_type: category === 'call' && callType ? callType : null,
      call_coverage_type: category === 'call' && callCoverageType ? callCoverageType : null,
      early_out_post_call: earlyOutPostCall,
      provider_group: providerGroup,
      start_time: startTime || null,
      end_time: endTime || null,
      duration_hours: durationHours ? parseFloat(durationHours) : null,
      color_hex: colorHex,
      display_order: parseInt(displayOrder) || 0,
      counts_toward_hours: countsHours,
      counts_toward_call_burden: countsCall,
      counts_as_weekend_burden: countsWeekend,
      counts_as_holiday_burden: countsHoliday,
      requires_post_call_rule: postCallRule,
      requires_backup_pairing: backupPairing,
      can_auto_assign: autoAssign,
      manual_only: manualOnly,
    };

    if (existing) {
      await fetch(`/api/scheduling/shift-types/${existing.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } else {
      await fetch('/api/scheduling/shift-types', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }
    onSaved();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={existing ? 'Edit Shift Type' : 'Add Shift Type'}
      width={540}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={saving}>{saving ? 'Saving...' : existing ? 'Save Changes' : 'Add Shift Type'}</Button>
        </>
      }
    >
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)', marginBottom: 'var(--space-1)' }}>
          <div>
            <label style={modalLabelStyle}>Name *</label>
            <input className="fr-field" style={modalInputStyle} placeholder="Call - Weekday" value={name} onChange={e => setName(e.target.value)} />
          </div>
          <div>
            <label style={modalLabelStyle}>Code *</label>
            <input className="fr-field" style={modalInputStyle} placeholder="CW" value={code} onChange={e => setCode(e.target.value)} />
          </div>
        </div>

        <label style={modalLabelStyle}>Category</label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--space-1)', marginBottom: 14 }}>
          {Object.entries(CATEGORY_COLORS).map(([c, style]) => (
            <SegButton key={c} on={category === c} tone={style.color} bg={style.bg} onClick={() => setCategory(c)}>
              {style.label}
            </SegButton>
          ))}
        </div>

        {category === 'call' && (
          <>
            <label style={modalLabelStyle}>Call Type</label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--space-1)', marginBottom: 14 }}>
              {[
                { value: 'weekday', label: 'Weekday', tone: 'var(--blue)' },
                { value: 'weekend', label: 'Weekend', tone: 'var(--indigo)' },
                { value: 'holiday', label: 'Holiday', tone: 'var(--warn)' },
                { value: 'additional', label: 'Additional', tone: 'var(--ok)' },
              ].map(ct => (
                <SegButton key={ct.value} on={callType === ct.value} tone={ct.tone} bg={tint(ct.tone, 14)}
                  onClick={() => setCallType(ct.value)} style={{ padding: '8px 10px' }}>
                  {ct.label}
                </SegButton>
              ))}
            </div>

            <label style={modalLabelStyle}>Call Coverage</label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 'var(--space-1)', marginBottom: 14 }}>
              {[
                { value: 'partial_beeper', label: 'Partial Beeper', desc: 'In-hospital shift then on-call from home', tone: 'var(--warn)' },
                { value: 'full_beeper', label: 'Full Beeper', desc: 'On-call from home entire shift', tone: 'var(--danger)' },
              ].map(cc => (
                <SegButton key={cc.value} on={callCoverageType === cc.value} tone={cc.tone} bg={tint(cc.tone, 14)}
                  onClick={() => setCallCoverageType(callCoverageType === cc.value ? '' : cc.value)}
                  style={{ padding: '10px 12px', fontSize: 'var(--fs-sm)', textAlign: 'left', display: 'block' }}>
                  <div>{cc.label}</div>
                  <div style={{ fontSize: 10, fontWeight: 500, opacity: 0.7, marginTop: 2 }}>{cc.desc}</div>
                </SegButton>
              ))}
            </div>

            <div style={{ marginBottom: 14 }}>
              <Toggle label="Early Out Post-Call" checked={earlyOutPostCall} onChange={setEarlyOutPostCall} />
              <div style={{ fontSize: 10, color: 'var(--text-dim)', marginLeft: 23, marginTop: 2 }}>
                Provider leaves early the next day after this call shift
              </div>
            </div>
          </>
        )}

        <label style={modalLabelStyle}>Provider Group</label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--space-1)', marginBottom: 14 }}>
          {PROVIDER_GROUPS.map(g => (
            <SegButton key={g.value} on={providerGroup === g.value} tone="var(--blue)" bg={tint('var(--blue)', 14)}
              onClick={() => setProviderGroup(g.value)}>
              {g.label}
            </SegButton>
          ))}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 'var(--space-3)', marginBottom: 'var(--space-1)' }}>
          <div>
            <label style={modalLabelStyle}>Start Time</label>
            <input type="time" className="fr-field" style={modalInputStyle} value={startTime} onChange={e => setStartTime(e.target.value)} />
          </div>
          <div>
            <label style={modalLabelStyle}>End Time</label>
            <input type="time" className="fr-field" style={modalInputStyle} value={endTime} onChange={e => setEndTime(e.target.value)} />
          </div>
          <div>
            <label style={modalLabelStyle}>Duration (hrs)</label>
            <input type="number" step="0.5" className="fr-field" style={modalInputStyle} value={durationHours} onChange={e => setDurationHours(e.target.value)} />
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)', marginBottom: 'var(--space-1)' }}>
          <div>
            <label style={modalLabelStyle}>Color</label>
            <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', marginBottom: 'var(--space-3)' }}>
              <input type="color" className="fr-field" value={colorHex} onChange={e => setColorHex(e.target.value)} style={{
                width: 40, height: 36, borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
                background: 'var(--bg-deep)', cursor: 'pointer', padding: 2,
              }} />
              <input className="fr-field" style={{ ...modalInputStyle, marginBottom: 0, flex: 1, fontFamily: 'var(--font-mono), ui-monospace, monospace' }} value={colorHex} onChange={e => setColorHex(e.target.value)} />
            </div>
          </div>
          <div>
            <label style={modalLabelStyle}>Display Order</label>
            <input type="number" className="fr-field" style={modalInputStyle} value={displayOrder} onChange={e => setDisplayOrder(e.target.value)} />
          </div>
        </div>

        <SectionLabel>Scheduling Flags</SectionLabel>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-2)', marginBottom: 'var(--space-4)' }}>
          <Toggle label="Counts Toward Hours" checked={countsHours} onChange={setCountsHours} />
          <Toggle label="Counts Toward Call Burden" checked={countsCall} onChange={setCountsCall} />
          <Toggle label="Counts as Weekend Burden" checked={countsWeekend} onChange={setCountsWeekend} />
          <Toggle label="Counts as Holiday Burden" checked={countsHoliday} onChange={setCountsHoliday} />
          <Toggle label="Requires Post-Call Rule" checked={postCallRule} onChange={setPostCallRule} />
          <Toggle label="Requires Backup Pairing" checked={backupPairing} onChange={setBackupPairing} />
          <Toggle label="Can Auto-Assign" checked={autoAssign} onChange={setAutoAssign} />
          <Toggle label="Manual Only" checked={manualOnly} onChange={setManualOnly} />
        </div>
    </Modal>
  );
}

/* ── Shift Templates Tab ─────────────────────────────────────────────────── */

function ShiftTemplatesTab({ site, onReload }: { site: SiteDetail; onReload: () => void }) {
  const [showAdd, setShowAdd] = useState(false);
  const templates = site.shift_templates || [];

  const handleDelete = async (tId: string) => {
    if (!confirm('Delete this template?')) return;
    await fetch(`/api/scheduling/shift-templates/${tId}`, { method: 'DELETE' });
    onReload();
  };

  // Group by day_type
  const grouped = DAY_TYPES.reduce<Record<string, ShiftTemplate[]>>((acc, dt) => {
    const items = templates.filter(t => t.day_type === dt.value);
    if (items.length > 0) acc[dt.value] = items;
    return acc;
  }, {});

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-4)' }}>
        <SectionLabel>Shift Templates ({templates.length})</SectionLabel>
        <Button size="sm" onClick={() => setShowAdd(true)}>+ Add Template</Button>
      </div>

      {Object.keys(grouped).length === 0 && (
        <Card>
          <EmptyState icon="▦" title="No shift templates configured" hint="Add one to define daily staffing requirements." />
        </Card>
      )}

      {Object.entries(grouped).map(([dayType, items]) => {
        const dtLabel = DAY_TYPES.find(d => d.value === dayType)?.label || dayType;
        return (
          <div key={dayType} style={{ marginBottom: 'var(--space-5)' }}>
            <div style={{
              fontSize: 'var(--fs-sm)', fontWeight: 800, color: 'var(--text-muted)', letterSpacing: 1,
              textTransform: 'uppercase', marginBottom: 'var(--space-2)', paddingLeft: 2,
            }}>{dtLabel}</div>
            <Card pad={false}>
              {items.map((t, i) => {
                // color_hex is the shift type's stored colour — data, not style.
                const stColor = t.shift_types?.color_hex || 'var(--text-faint)';
                return (
                  <div key={t.id} className="fr-row" style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: 'var(--space-3) var(--space-4)',
                    borderBottom: i < items.length - 1 ? '1px solid var(--border-faint)' : 'none',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                      <div style={{ width: 8, height: 8, borderRadius: '50%', background: stColor, flexShrink: 0 }} />
                      <div>
                        <span style={{ fontWeight: 700, color: 'var(--text)', fontSize: 'var(--fs-sm)' }}>
                          {t.shift_types?.name || 'Unknown'}
                        </span>
                        <span style={{ color: 'var(--text-dim)', fontSize: 'var(--fs-xs)', marginLeft: 'var(--space-2)', fontFamily: 'var(--font-mono), ui-monospace, monospace' }}>
                          {t.shift_types?.code}
                        </span>
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                      <span style={{
                        ...TONE_PILL, background: tint('var(--blue)'), color: 'var(--blue)',
                        border: `1px solid ${tint('var(--blue)', 22)}`, fontVariantNumeric: 'tabular-nums',
                      }}>x{t.required_count}</span>
                      <span style={{
                        ...TONE_PILL, fontWeight: 600, background: tint('var(--indigo)'), color: 'var(--indigo)',
                        border: `1px solid ${tint('var(--indigo)', 22)}`,
                      }}>{t.schedule_layer}</span>
                      {t.generation_priority != null && (
                        <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', fontVariantNumeric: 'tabular-nums' }}>
                          P{t.generation_priority}
                        </span>
                      )}
                      <Button variant="danger" size="sm" onClick={() => handleDelete(t.id)}>Delete</Button>
                    </div>
                  </div>
                );
              })}
            </Card>
          </div>
        );
      })}

      {showAdd && (
        <AddTemplateModal
          siteId={site.id}
          shiftTypes={site.shift_types || []}
          onClose={() => setShowAdd(false)}
          onSaved={() => { setShowAdd(false); onReload(); }}
        />
      )}
    </div>
  );
}

/* ── Add Template Modal ──────────────────────────────────────────────────── */

function AddTemplateModal({ siteId, shiftTypes, onClose, onSaved }: {
  siteId: string; shiftTypes: ShiftType[]; onClose: () => void; onSaved: () => void;
}) {
  const [dayType, setDayType] = useState('weekday');
  const [shiftTypeId, setShiftTypeId] = useState(shiftTypes[0]?.id || '');
  const [requiredCount, setRequiredCount] = useState('1');
  const [scheduleLayer, setScheduleLayer] = useState('call');
  const [genPriority, setGenPriority] = useState('10');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!shiftTypeId) return;
    setSaving(true);
    await fetch('/api/scheduling/shift-templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        site_id: siteId,
        day_type: dayType,
        shift_type_id: shiftTypeId,
        required_count: parseInt(requiredCount) || 1,
        schedule_layer: scheduleLayer,
        generation_priority: parseInt(genPriority) || 10,
      }),
    });
    onSaved();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Add Shift Template"
      width={440}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={saving}>{saving ? 'Adding...' : 'Add Template'}</Button>
        </>
      }
    >
        <label style={modalLabelStyle}>Day Type</label>
        <select className="fr-field" value={dayType} onChange={e => setDayType(e.target.value)} style={{ ...modalInputStyle, cursor: 'pointer' }}>
          {DAY_TYPES.map(d => (
            <option key={d.value} value={d.value}>{d.label}</option>
          ))}
        </select>

        <label style={modalLabelStyle}>Shift Type</label>
        <select className="fr-field" value={shiftTypeId} onChange={e => setShiftTypeId(e.target.value)} style={{ ...modalInputStyle, cursor: 'pointer' }}>
          {shiftTypes.length === 0 && <option value="">No shift types available</option>}
          {shiftTypes.map(st => (
            <option key={st.id} value={st.id}>{st.name} ({st.code})</option>
          ))}
        </select>

        <label style={modalLabelStyle}>Schedule Layer</label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--space-1)', marginBottom: 14 }}>
          {SCHEDULE_LAYERS.map(l => (
            <SegButton key={l.value} on={scheduleLayer === l.value} tone="var(--blue)" bg={tint('var(--blue)', 14)}
              onClick={() => setScheduleLayer(l.value)}>
              {l.label}
            </SegButton>
          ))}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)', marginBottom: 'var(--space-1)' }}>
          <div>
            <label style={modalLabelStyle}>Required Count</label>
            <input type="number" min="1" className="fr-field" style={modalInputStyle} value={requiredCount} onChange={e => setRequiredCount(e.target.value)} />
          </div>
          <div>
            <label style={modalLabelStyle}>Generation Priority</label>
            <input type="number" className="fr-field" style={modalInputStyle} value={genPriority} onChange={e => setGenPriority(e.target.value)} />
          </div>
        </div>
    </Modal>
  );
}

/* ── Holidays Tab ────────────────────────────────────────────────────────── */

function HolidaysTab({ site, holidays, onReload }: { site: SiteDetail; holidays: Holiday[]; onReload: () => void }) {
  const [showAdd, setShowAdd] = useState(false);

  const handleDelete = async (hId: string) => {
    if (!confirm('Delete this holiday?')) return;
    await fetch(`/api/scheduling/holidays/${hId}`, { method: 'DELETE' });
    onReload();
  };

  // Show org-wide + site-specific holidays
  const relevantHolidays = holidays.filter(h => h.site_id === null || h.site_id === site.id);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-4)' }}>
        <SectionLabel>Holidays ({relevantHolidays.length})</SectionLabel>
        <Button size="sm" onClick={() => setShowAdd(true)}>+ Add Holiday</Button>
      </div>

      <Card pad={false}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-sm)' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--tint-surface-faint)' }}>
              {['Holiday', 'Date', 'Type', 'Major', 'Scope', ''].map(h => (
                <th key={h} style={TH_STYLE}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {relevantHolidays.map(h => {
              const htc = HOLIDAY_TYPE_COLORS[h.holiday_type] || HOLIDAY_TYPE_COLORS.custom;
              return (
                <tr key={h.id} className="fr-row" style={{ borderBottom: '1px solid var(--border-faint)' }}>
                  <td style={TD_STYLE}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                      {h.color_hex && (
                        // color_hex is the holiday's stored colour — data, not style.
                        <div style={{ width: 8, height: 8, borderRadius: '50%', background: h.color_hex, flexShrink: 0 }} />
                      )}
                      <span style={{ fontWeight: 700, color: 'var(--text)' }}>{h.holiday_name}</span>
                    </div>
                  </td>
                  <td style={{ ...TD_STYLE, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                    {new Date(h.holiday_date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
                  </td>
                  <td style={TD_STYLE}>
                    <span style={{
                      ...TONE_PILL, background: htc.bg, color: htc.color, textTransform: 'capitalize',
                      border: `1px solid ${tint(htc.color, 22)}`,
                    }}>{h.holiday_type}</span>
                  </td>
                  <td style={TD_STYLE}>
                    {h.is_major_holiday ? (
                      <span style={{ fontSize: 'var(--fs-xs)', fontWeight: 700, color: 'var(--warn)' }}>Yes</span>
                    ) : (
                      <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>No</span>
                    )}
                  </td>
                  <td style={{ ...TD_STYLE, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
                    {h.site_id ? 'Site' : 'Org-wide'}
                  </td>
                  <td style={{ ...TD_STYLE, textAlign: 'right' }}>
                    <Button variant="danger" size="sm" onClick={() => handleDelete(h.id)}>Delete</Button>
                  </td>
                </tr>
              );
            })}
            {relevantHolidays.length === 0 && (
              <tr>
                <td colSpan={6} style={{ padding: 0 }}>
                  <EmptyState icon="✦" title="No holidays configured" hint="Add holidays to define schedule exceptions." />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      {showAdd && (
        <AddHolidayModal
          orgId={site.organization_id}
          siteId={site.id}
          onClose={() => setShowAdd(false)}
          onSaved={() => { setShowAdd(false); onReload(); }}
        />
      )}
    </div>
  );
}

/* ── Add Holiday Modal ───────────────────────────────────────────────────── */

function AddHolidayModal({ orgId, siteId, onClose, onSaved }: {
  orgId: string; siteId: string; onClose: () => void; onSaved: () => void;
}) {
  const [holidayName, setHolidayName] = useState('');
  const [holidayDate, setHolidayDate] = useState('');
  const [holidayType, setHolidayType] = useState('federal');
  const [isMajor, setIsMajor] = useState(false);
  const [colorHex, setColorHex] = useState('#f87171');
  const [scope, setScope] = useState<'org' | 'site'>('org');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!holidayName.trim() || !holidayDate) return;
    setSaving(true);
    await fetch('/api/scheduling/holidays', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        organization_id: orgId,
        site_id: scope === 'site' ? siteId : null,
        holiday_name: holidayName.trim(),
        holiday_date: holidayDate,
        holiday_type: holidayType,
        is_major_holiday: isMajor,
        color_hex: colorHex,
      }),
    });
    onSaved();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Add Holiday"
      width={440}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={saving}>{saving ? 'Adding...' : 'Add Holiday'}</Button>
        </>
      }
    >
        <label style={modalLabelStyle}>Holiday Name *</label>
        <input className="fr-field" style={modalInputStyle} placeholder="Christmas Day" value={holidayName} onChange={e => setHolidayName(e.target.value)} />

        <label style={modalLabelStyle}>Date *</label>
        <input type="date" className="fr-field" style={modalInputStyle} value={holidayDate} onChange={e => setHolidayDate(e.target.value)} />

        <label style={modalLabelStyle}>Holiday Type</label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 'var(--space-1)', marginBottom: 14 }}>
          {HOLIDAY_TYPES.map(ht => {
            const htc = HOLIDAY_TYPE_COLORS[ht.value] || HOLIDAY_TYPE_COLORS.custom;
            return (
              <SegButton key={ht.value} on={holidayType === ht.value} tone={htc.color} bg={htc.bg}
                onClick={() => setHolidayType(ht.value)}>
                {ht.label}
              </SegButton>
            );
          })}
        </div>

        <label style={modalLabelStyle}>Scope</label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-1)', marginBottom: 14 }}>
          <SegButton on={scope === 'org'} tone="var(--blue)" bg={tint('var(--blue)', 14)} onClick={() => setScope('org')}>
            Organization-wide
          </SegButton>
          <SegButton on={scope === 'site'} tone="var(--ok)" bg="var(--ok-bg)" onClick={() => setScope('site')}>
            This Site Only
          </SegButton>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)', marginBottom: 'var(--space-1)' }}>
          <div>
            <label style={modalLabelStyle}>Color</label>
            <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', marginBottom: 'var(--space-3)' }}>
              <input type="color" className="fr-field" value={colorHex} onChange={e => setColorHex(e.target.value)} style={{
                width: 40, height: 36, borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
                background: 'var(--bg-deep)', cursor: 'pointer', padding: 2,
              }} />
              <input className="fr-field" style={{ ...modalInputStyle, marginBottom: 0, flex: 1, fontFamily: 'var(--font-mono), ui-monospace, monospace' }} value={colorHex} onChange={e => setColorHex(e.target.value)} />
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 'var(--space-3)' }}>
            <label className="fr-toggle" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', cursor: 'pointer', borderRadius: 'var(--radius-sm)' }}>
              <input type="checkbox" checked={isMajor} onChange={e => setIsMajor(e.target.checked)} style={{ accentColor: 'var(--warn)', width: 15, height: 15, cursor: 'pointer' }} />
              Major Holiday
            </label>
          </div>
        </div>
    </Modal>
  );
}

/* ── Shared Components ───────────────────────────────────────────────────── */

const fieldLabelStyle: React.CSSProperties = {
  fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', display: 'block',
  marginBottom: 5, fontWeight: 600, letterSpacing: 0.5,
};
const fieldInputStyle: React.CSSProperties = {
  width: '100%', padding: '9px 12px', borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--border)', background: 'var(--bg-deep)',
  color: 'var(--text)', fontSize: 'var(--fs-sm)', fontFamily: 'inherit',
};
const modalLabelStyle: React.CSSProperties = {
  fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', display: 'block',
  marginBottom: 5, fontWeight: 600, letterSpacing: 0.5,
};
const modalInputStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px', borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--border)', background: 'var(--bg-deep)',
  color: 'var(--text)', fontSize: 'var(--fs-md)', fontFamily: 'inherit',
  marginBottom: 'var(--space-3)',
};

/* Both tables on this page are hand-rolled (their rows are clickable and the
   Table kit takes plain cells), so they borrow the kit's header and cell
   voice rather than inventing a second one. */
const TH_STYLE: React.CSSProperties = {
  padding: '10px 14px', textAlign: 'left',
  fontSize: 'var(--fs-xs)', fontWeight: 500,
  fontFamily: 'var(--font-mono), ui-monospace, monospace',
  color: 'var(--text-muted)', letterSpacing: 0.6,
  textTransform: 'uppercase', whiteSpace: 'nowrap',
};
const TD_STYLE: React.CSSProperties = {
  padding: '10px 14px', fontSize: 'var(--fs-sm)', verticalAlign: 'middle',
};

/** Soft tone tint + solid tone ink, at the Badge kit's weight. */
const TONE_PILL: React.CSSProperties = {
  display: 'inline-block',
  fontSize: 'var(--fs-xs)', fontWeight: 700,
  padding: '2px 8px', borderRadius: 999,
  lineHeight: 1.5, whiteSpace: 'nowrap',
};

function Field({ label, value, onChange, type }: { label: string; value: string; onChange: (v: string) => void; type?: string }) {
  return (
    <div>
      <label style={fieldLabelStyle}>{label}</label>
      <input className="fr-field" type={type || 'text'} value={value} onChange={e => onChange(e.target.value)} style={fieldInputStyle} />
    </div>
  );
}

/**
 * One option in a segmented picker (site type, category, day type, scope…).
 * The ON look is inline because each option owns a meaning colour; the OFF
 * look, its hover and its press nudge come from .fr-seg — an inline
 * background would outrank the class's :hover and kill it, which is exactly
 * what the hand-rolled versions of this button used to do.
 */
function SegButton({ on, tone, bg, onClick, style, children }: {
  on: boolean;
  tone: string;
  bg: string;
  onClick: () => void;
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className="fr-seg"
      style={{
        padding: '7px 10px', borderRadius: 'var(--radius-sm)',
        fontSize: 'var(--fs-xs)', fontWeight: 700, fontFamily: 'inherit',
        // borderColor, not the border shorthand: the 1px solid width lives in
        // .fr-seg and must survive the ON state.
        ...(on ? { background: bg, borderColor: tone, color: tone } : null),
        ...style,
      }}
    >
      {children}
    </button>
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
        background: tint('var(--blue)', 14), color: 'var(--blue)',
        border: `1px solid ${tint('var(--blue)', 30)}`,
        flexShrink: 0,
      }}>i</span>
      {show && (
        <div style={{
          position: 'absolute', top: '100%', left: '50%', transform: 'translateX(-50%)',
          marginTop: 'var(--space-2)', padding: '10px 14px', borderRadius: 'var(--radius-md)',
          fontSize: 'var(--fs-sm)', lineHeight: 1.5,
          background: 'var(--bg-popover)', color: 'var(--text)', border: '1px solid var(--border)',
          boxShadow: 'var(--shadow-popover)', width: 280, zIndex: 300,
          fontWeight: 500, whiteSpace: 'normal', textAlign: 'left',
          // Opacity-only fade: fade-up would animate `transform`, which is
          // already carrying this tip's translateX(-50%) centring.
          animation: 'fr-backdrop-in var(--dur-fast) var(--ease-out)',
        }}>
          {text}
        </div>
      )}
    </span>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="fr-toggle" data-on={checked} style={{
      display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
      fontSize: 'var(--fs-sm)', color: checked ? 'var(--text)' : 'var(--text-muted)',
      cursor: 'pointer', padding: '4px 0', borderRadius: 'var(--radius-sm)',
    }}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)}
        style={{ accentColor: 'var(--blue)', width: 15, height: 15, cursor: 'pointer' }} />
      {label}
    </label>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 'var(--fs-xs)', fontWeight: 800, color: 'var(--text-dim)', letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 10, marginTop: 'var(--space-2)' }}>
      {children}
    </div>
  );
}
