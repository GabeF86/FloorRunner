'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';

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

const SITE_TYPE_COLORS: Record<string, { color: string; bg: string; label: string }> = {
  hospital: { color: '#0ea5e9', bg: 'rgba(14,165,233,0.15)', label: 'Hospital' },
  asc:      { color: '#10b981', bg: 'rgba(16,185,129,0.15)', label: 'ASC' },
  office:   { color: '#f59e0b', bg: 'rgba(245,158,11,0.15)', label: 'Office' },
};

const CATEGORY_COLORS: Record<string, { color: string; bg: string; label: string }> = {
  call:        { color: '#f87171', bg: 'rgba(248,113,113,0.15)', label: 'Call' },
  regular:     { color: '#0ea5e9', bg: 'rgba(14,165,233,0.15)', label: 'Regular' },
  float:       { color: '#fbbf24', bg: 'rgba(251,191,36,0.15)', label: 'Float' },
  admin:       { color: '#a78bfa', bg: 'rgba(167,139,250,0.15)', label: 'Admin' },
  unavailable: { color: '#64748b', bg: 'rgba(100,116,139,0.15)', label: 'Unavailable' },
  leave:       { color: '#10b981', bg: 'rgba(16,185,129,0.15)', label: 'Leave' },
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
  federal:        { color: '#0ea5e9', bg: 'rgba(14,165,233,0.15)' },
  religious:      { color: '#a78bfa', bg: 'rgba(167,139,250,0.15)' },
  organizational: { color: '#f59e0b', bg: 'rgba(245,158,11,0.15)' },
  custom:         { color: '#64748b', bg: 'rgba(100,116,139,0.15)' },
};

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

/* ── Main Page ───────────────────────────────────────────────────────────── */

export default function SiteDetailPage({ params }: { params: { id: string } }) {
  const { id } = params;
  const [site, setSite] = useState<SiteDetail | null>(null);
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [tab, setTab] = useState<Tab>('general');
  const [saving, setSaving] = useState(false);

  const loadSite = useCallback(async () => {
    const res = await fetch(`/api/scheduling/sites/${id}`);
    setSite(await res.json());
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
    const res = await fetch(`/api/scheduling/sites/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    setSite(await res.json());
    setSaving(false);
  };

  if (!site) return <div style={{ padding: 40, color: 'var(--text-muted)' }}>Loading...</div>;

  const tc = SITE_TYPE_COLORS[site.site_type] || SITE_TYPE_COLORS.hospital;

  const TABS: { key: Tab; label: string; info: string }[] = [
    { key: 'general', label: 'General', info: 'Basic site information — name, address, timezone, and which days this site operates.' },
    { key: 'shift-types', label: 'Shift Types', info: 'Define all possible shifts at this site (e.g. C1, C2, D1-D8, 8hr, 10hr). Each shift type has a name, code, category, times, and scheduling rules.' },
    { key: 'templates', label: 'Shift Templates', info: 'Configure how many of each shift type are needed on each day type (weekday, friday, weekend, holiday). The scheduler uses these to know how many slots to create.' },
    { key: 'holidays', label: 'Holidays', info: 'Manage the holiday calendar for this site. Holidays affect which shift templates apply and how call burden is tracked.' },
  ];

  return (
    <div style={{ padding: '24px 32px' }}>
      {/* Breadcrumb */}
      <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 16 }}>
        <Link href="/sites" style={{ color: '#0ea5e9', textDecoration: 'none' }}>Sites</Link>
        <span style={{ margin: '0 6px' }}>/</span>
        <span>{site.name}</span>
      </div>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 24 }}>
        <div style={{
          width: 56, height: 56, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 20, fontWeight: 800, background: tc.bg, color: tc.color, border: `1px solid ${tc.color}30`,
        }}>{site.short_name?.slice(0, 2) || site.name.slice(0, 2).toUpperCase()}</div>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)' }}>{site.name}</h1>
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 6, background: tc.bg, color: tc.color }}>
              {tc.label}
            </span>
            <span style={{
              fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 6,
              background: site.is_active ? 'rgba(16,185,129,0.12)' : 'rgba(100,116,139,0.12)',
              color: site.is_active ? '#10b981' : '#64748b',
            }}>{site.is_active ? 'Active' : 'Inactive'}</span>
            {site.timezone && (
              <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 6, background: 'rgba(99,102,241,0.12)', color: '#818cf8' }}>
                {site.timezone}
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
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
        <Field label="Site Name" value={name} onChange={setName} />
        <Field label="Short Name" value={shortName} onChange={setShortName} />
      </div>

      <label style={fieldLabelStyle}>Site Type</label>
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

      <Field label="Address" value={address} onChange={setAddress} />

      <label style={fieldLabelStyle}>Timezone</label>
      <select value={timezone} onChange={e => setTimezone(e.target.value)} style={{ ...fieldInputStyle, cursor: 'pointer', marginBottom: 16 }}>
        <option value="America/New_York">America/New_York (Eastern)</option>
        <option value="America/Chicago">America/Chicago (Central)</option>
        <option value="America/Denver">America/Denver (Mountain)</option>
        <option value="America/Los_Angeles">America/Los_Angeles (Pacific)</option>
        <option value="America/Phoenix">America/Phoenix (Arizona)</option>
        <option value="Pacific/Honolulu">Pacific/Honolulu (Hawaii)</option>
        <option value="America/Anchorage">America/Anchorage (Alaska)</option>
      </select>

      <SectionLabel>Operational Days</SectionLabel>
      <div style={{ display: 'flex', gap: 6, marginBottom: 20, flexWrap: 'wrap' }}>
        {WEEKDAYS.map(day => (
          <button key={day} onClick={() => toggleDay(day)} style={{
            padding: '8px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 700,
            textTransform: 'capitalize',
            border: `1px solid ${opDays[day] ? '#0ea5e9' : 'var(--border)'}`,
            background: opDays[day] ? 'rgba(14,165,233,0.15)' : 'transparent',
            color: opDays[day] ? '#0ea5e9' : 'var(--text-dim)',
          }}>{day.slice(0, 3)}</button>
        ))}
      </div>

      <SectionLabel>Notes</SectionLabel>
      <textarea
        value={notes}
        onChange={e => setNotes(e.target.value)}
        placeholder="Internal notes about this site..."
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <SectionLabel>Shift Types ({shiftTypes.length})</SectionLabel>
        <button onClick={() => { setEditId(null); setShowAdd(true); }} style={{
          padding: '8px 16px', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 12,
          background: 'linear-gradient(135deg,#0ea5e9,#6366f1)', color: '#fff', border: 'none',
        }}>+ Add Shift Type</button>
      </div>

      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)', background: 'rgba(14,165,233,0.04)' }}>
              {['Color', 'Name', 'Code', 'Category', 'Group', 'Times', 'Duration', 'Flags', ''].map(h => (
                <th key={h} style={{
                  padding: '10px 14px', textAlign: 'left', fontSize: 10, fontWeight: 800,
                  color: 'var(--text-dim)', letterSpacing: 1, textTransform: 'uppercase',
                }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shiftTypes.map(st => {
              const cat = CATEGORY_COLORS[st.category] || CATEGORY_COLORS.regular;
              return (
                <tr key={st.id} style={{ borderBottom: '1px solid rgba(30,58,95,0.4)', cursor: 'pointer' }}
                  onClick={() => { setEditId(st.id); setShowAdd(true); }}>
                  <td style={{ padding: '10px 14px' }}>
                    <div style={{
                      width: 24, height: 24, borderRadius: 6,
                      background: st.color_hex || '#64748b',
                      border: '1px solid rgba(255,255,255,0.1)',
                    }} />
                  </td>
                  <td style={{ padding: '10px 14px', fontWeight: 700, color: 'var(--text)' }}>{st.name}</td>
                  <td style={{ padding: '10px 14px', color: 'var(--text-muted)', fontFamily: 'monospace', fontSize: 12 }}>{st.code}</td>
                  <td style={{ padding: '10px 14px' }}>
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      <span style={{
                        fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 6,
                        background: cat.bg, color: cat.color,
                      }}>{cat.label}</span>
                      {st.call_type && (
                        <span style={{
                          fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 5,
                          background: 'rgba(255,255,255,0.06)', color: 'var(--text-muted)',
                          border: '1px solid rgba(255,255,255,0.08)',
                        }}>{st.call_type}</span>
                      )}
                      {st.call_coverage_type && (
                        <span style={{
                          fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 5,
                          background: st.call_coverage_type === 'full_beeper' ? 'rgba(248,113,113,0.12)' : 'rgba(251,146,60,0.12)',
                          color: st.call_coverage_type === 'full_beeper' ? '#f87171' : '#fb923c',
                        }}>{st.call_coverage_type === 'full_beeper' ? 'Full Beeper' : 'Partial Beeper'}</span>
                      )}
                    </div>
                  </td>
                  <td style={{ padding: '10px 14px', fontSize: 12, color: 'var(--text-muted)', textTransform: 'capitalize' }}>
                    {st.provider_group}
                  </td>
                  <td style={{ padding: '10px 14px', fontSize: 12, color: 'var(--text-muted)' }}>
                    {st.start_time && st.end_time
                      ? `${st.start_time.slice(0, 5)} - ${st.end_time.slice(0, 5)}`
                      : '—'}
                    {st.crosses_midnight && <span style={{ color: '#fbbf24', marginLeft: 4, fontSize: 10 }}>+1d</span>}
                  </td>
                  <td style={{ padding: '10px 14px', fontSize: 12, color: 'var(--text-muted)' }}>
                    {st.duration_hours ? `${st.duration_hours}h` : '—'}
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {st.counts_toward_call_burden && <FlagBadge label="Call" />}
                      {st.counts_as_weekend_burden && <FlagBadge label="Wknd" />}
                      {st.counts_as_holiday_burden && <FlagBadge label="Hol" />}
                      {st.requires_post_call_rule && <FlagBadge label="Post" />}
                      {st.early_out_post_call && <FlagBadge label="Early Out" />}
                      {st.manual_only && <FlagBadge label="Manual" />}
                    </div>
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    <button onClick={(e) => { e.stopPropagation(); handleDelete(st.id); }} style={{
                      padding: '4px 8px', borderRadius: 6, cursor: 'pointer', fontSize: 11,
                      background: 'rgba(248,113,113,0.1)', color: '#f87171', border: '1px solid rgba(248,113,113,0.2)',
                      fontWeight: 600,
                    }}>Delete</button>
                  </td>
                </tr>
              );
            })}
            {shiftTypes.length === 0 && (
              <tr>
                <td colSpan={9} style={{ padding: '40px 14px', textAlign: 'center', color: 'var(--text-dim)', fontStyle: 'italic' }}>
                  No shift types configured. Add one to get started.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

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
      background: 'rgba(99,102,241,0.12)', color: '#818cf8',
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
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }} onClick={onClose}>
      <div className="modal-box" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 16, padding: 28, width: 540, maxHeight: '85vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: 17, fontWeight: 800, color: '#f1f5f9', marginBottom: 22 }}>
          {existing ? 'Edit Shift Type' : 'Add Shift Type'}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 4 }}>
          <div>
            <label style={modalLabelStyle}>Name *</label>
            <input style={modalInputStyle} placeholder="Call - Weekday" value={name} onChange={e => setName(e.target.value)} />
          </div>
          <div>
            <label style={modalLabelStyle}>Code *</label>
            <input style={modalInputStyle} placeholder="CW" value={code} onChange={e => setCode(e.target.value)} />
          </div>
        </div>

        <label style={modalLabelStyle}>Category</label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginBottom: 14 }}>
          {Object.entries(CATEGORY_COLORS).map(([c, style]) => (
            <button key={c} onClick={() => setCategory(c)} style={{
              padding: '7px 10px', borderRadius: 8, cursor: 'pointer', fontSize: 11, fontWeight: 700,
              border: `1px solid ${category === c ? style.color : 'var(--border)'}`,
              background: category === c ? style.bg : 'transparent',
              color: category === c ? style.color : 'var(--text-muted)',
            }}>{style.label}</button>
          ))}
        </div>

        {category === 'call' && (
          <>
            <label style={modalLabelStyle}>Call Type</label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, marginBottom: 14 }}>
              {[
                { value: 'weekday', label: 'Weekday', color: '#0ea5e9' },
                { value: 'weekend', label: 'Weekend', color: '#a78bfa' },
                { value: 'holiday', label: 'Holiday', color: '#fbbf24' },
                { value: 'additional', label: 'Additional', color: '#10b981' },
              ].map(ct => (
                <button key={ct.value} onClick={() => setCallType(ct.value)} style={{
                  padding: '8px 10px', borderRadius: 8, cursor: 'pointer', fontSize: 11, fontWeight: 700,
                  border: `1px solid ${callType === ct.value ? ct.color : 'var(--border)'}`,
                  background: callType === ct.value ? `${ct.color}20` : 'transparent',
                  color: callType === ct.value ? ct.color : 'var(--text-muted)',
                  transition: 'all 0.15s',
                }}>{ct.label}</button>
              ))}
            </div>

            <label style={modalLabelStyle}>Call Coverage</label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6, marginBottom: 14 }}>
              {[
                { value: 'partial_beeper', label: 'Partial Beeper', desc: 'In-hospital shift then on-call from home', color: '#fb923c' },
                { value: 'full_beeper', label: 'Full Beeper', desc: 'On-call from home entire shift', color: '#f87171' },
              ].map(cc => (
                <button key={cc.value} onClick={() => setCallCoverageType(callCoverageType === cc.value ? '' : cc.value)} style={{
                  padding: '10px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 700,
                  border: `1px solid ${callCoverageType === cc.value ? cc.color : 'var(--border)'}`,
                  background: callCoverageType === cc.value ? `${cc.color}20` : 'transparent',
                  color: callCoverageType === cc.value ? cc.color : 'var(--text-muted)',
                  transition: 'all 0.15s', textAlign: 'left',
                }}>
                  <div>{cc.label}</div>
                  <div style={{ fontSize: 10, fontWeight: 500, opacity: 0.7, marginTop: 2 }}>{cc.desc}</div>
                </button>
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
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginBottom: 14 }}>
          {PROVIDER_GROUPS.map(g => (
            <button key={g.value} onClick={() => setProviderGroup(g.value)} style={{
              padding: '7px 10px', borderRadius: 8, cursor: 'pointer', fontSize: 11, fontWeight: 700,
              border: `1px solid ${providerGroup === g.value ? '#0ea5e9' : 'var(--border)'}`,
              background: providerGroup === g.value ? 'rgba(14,165,233,0.15)' : 'transparent',
              color: providerGroup === g.value ? '#0ea5e9' : 'var(--text-muted)',
            }}>{g.label}</button>
          ))}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 4 }}>
          <div>
            <label style={modalLabelStyle}>Start Time</label>
            <input type="time" style={modalInputStyle} value={startTime} onChange={e => setStartTime(e.target.value)} />
          </div>
          <div>
            <label style={modalLabelStyle}>End Time</label>
            <input type="time" style={modalInputStyle} value={endTime} onChange={e => setEndTime(e.target.value)} />
          </div>
          <div>
            <label style={modalLabelStyle}>Duration (hrs)</label>
            <input type="number" step="0.5" style={modalInputStyle} value={durationHours} onChange={e => setDurationHours(e.target.value)} />
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 4 }}>
          <div>
            <label style={modalLabelStyle}>Color</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
              <input type="color" value={colorHex} onChange={e => setColorHex(e.target.value)} style={{
                width: 40, height: 36, borderRadius: 8, border: '1px solid var(--border)',
                background: 'var(--bg-deep)', cursor: 'pointer', padding: 2,
              }} />
              <input style={{ ...modalInputStyle, marginBottom: 0, flex: 1 }} value={colorHex} onChange={e => setColorHex(e.target.value)} />
            </div>
          </div>
          <div>
            <label style={modalLabelStyle}>Display Order</label>
            <input type="number" style={modalInputStyle} value={displayOrder} onChange={e => setDisplayOrder(e.target.value)} />
          </div>
        </div>

        <SectionLabel>Scheduling Flags</SectionLabel>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 16 }}>
          <Toggle label="Counts Toward Hours" checked={countsHours} onChange={setCountsHours} />
          <Toggle label="Counts Toward Call Burden" checked={countsCall} onChange={setCountsCall} />
          <Toggle label="Counts as Weekend Burden" checked={countsWeekend} onChange={setCountsWeekend} />
          <Toggle label="Counts as Holiday Burden" checked={countsHoliday} onChange={setCountsHoliday} />
          <Toggle label="Requires Post-Call Rule" checked={postCallRule} onChange={setPostCallRule} />
          <Toggle label="Requires Backup Pairing" checked={backupPairing} onChange={setBackupPairing} />
          <Toggle label="Can Auto-Assign" checked={autoAssign} onChange={setAutoAssign} />
          <Toggle label="Manual Only" checked={manualOnly} onChange={setManualOnly} />
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button onClick={onClose} style={cancelBtnStyle}>Cancel</button>
          <button onClick={submit} disabled={saving} style={{
            ...saveBtnStyle, opacity: saving ? 0.5 : 1,
          }}>{saving ? 'Saving...' : existing ? 'Save Changes' : 'Add Shift Type'}</button>
        </div>
      </div>
    </div>
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <SectionLabel>Shift Templates ({templates.length})</SectionLabel>
        <button onClick={() => setShowAdd(true)} style={{
          padding: '8px 16px', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 12,
          background: 'linear-gradient(135deg,#0ea5e9,#6366f1)', color: '#fff', border: 'none',
        }}>+ Add Template</button>
      </div>

      {Object.keys(grouped).length === 0 && (
        <div style={{
          padding: 40, textAlign: 'center', color: 'var(--text-dim)', fontStyle: 'italic',
          background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12,
        }}>
          No shift templates configured. Add one to define daily staffing requirements.
        </div>
      )}

      {Object.entries(grouped).map(([dayType, items]) => {
        const dtLabel = DAY_TYPES.find(d => d.value === dayType)?.label || dayType;
        return (
          <div key={dayType} style={{ marginBottom: 20 }}>
            <div style={{
              fontSize: 12, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: 1,
              textTransform: 'uppercase', marginBottom: 8, paddingLeft: 2,
            }}>{dtLabel}</div>
            <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
              {items.map((t, i) => {
                const stColor = t.shift_types?.color_hex || '#64748b';
                return (
                  <div key={t.id} style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '12px 16px',
                    borderBottom: i < items.length - 1 ? '1px solid rgba(30,58,95,0.4)' : 'none',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div style={{ width: 8, height: 8, borderRadius: '50%', background: stColor, flexShrink: 0 }} />
                      <div>
                        <span style={{ fontWeight: 700, color: 'var(--text)', fontSize: 13 }}>
                          {t.shift_types?.name || 'Unknown'}
                        </span>
                        <span style={{ color: 'var(--text-dim)', fontSize: 11, marginLeft: 8, fontFamily: 'monospace' }}>
                          {t.shift_types?.code}
                        </span>
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <span style={{
                        fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 6,
                        background: 'rgba(14,165,233,0.12)', color: '#0ea5e9',
                      }}>x{t.required_count}</span>
                      <span style={{
                        fontSize: 10, fontWeight: 600, padding: '3px 8px', borderRadius: 6,
                        background: 'rgba(99,102,241,0.12)', color: '#818cf8',
                      }}>{t.schedule_layer}</span>
                      {t.generation_priority != null && (
                        <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>
                          P{t.generation_priority}
                        </span>
                      )}
                      <button onClick={() => handleDelete(t.id)} style={{
                        padding: '3px 8px', borderRadius: 6, cursor: 'pointer', fontSize: 11,
                        background: 'rgba(248,113,113,0.1)', color: '#f87171', border: '1px solid rgba(248,113,113,0.2)',
                        fontWeight: 600,
                      }}>Delete</button>
                    </div>
                  </div>
                );
              })}
            </div>
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
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }} onClick={onClose}>
      <div className="modal-box" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 16, padding: 28, width: 440, maxHeight: '85vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: 17, fontWeight: 800, color: '#f1f5f9', marginBottom: 22 }}>Add Shift Template</div>

        <label style={modalLabelStyle}>Day Type</label>
        <select value={dayType} onChange={e => setDayType(e.target.value)} style={{ ...modalInputStyle, cursor: 'pointer' }}>
          {DAY_TYPES.map(d => (
            <option key={d.value} value={d.value}>{d.label}</option>
          ))}
        </select>

        <label style={modalLabelStyle}>Shift Type</label>
        <select value={shiftTypeId} onChange={e => setShiftTypeId(e.target.value)} style={{ ...modalInputStyle, cursor: 'pointer' }}>
          {shiftTypes.length === 0 && <option value="">No shift types available</option>}
          {shiftTypes.map(st => (
            <option key={st.id} value={st.id}>{st.name} ({st.code})</option>
          ))}
        </select>

        <label style={modalLabelStyle}>Schedule Layer</label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginBottom: 14 }}>
          {SCHEDULE_LAYERS.map(l => (
            <button key={l.value} onClick={() => setScheduleLayer(l.value)} style={{
              padding: '7px 10px', borderRadius: 8, cursor: 'pointer', fontSize: 11, fontWeight: 700,
              border: `1px solid ${scheduleLayer === l.value ? '#0ea5e9' : 'var(--border)'}`,
              background: scheduleLayer === l.value ? 'rgba(14,165,233,0.15)' : 'transparent',
              color: scheduleLayer === l.value ? '#0ea5e9' : 'var(--text-muted)',
            }}>{l.label}</button>
          ))}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 4 }}>
          <div>
            <label style={modalLabelStyle}>Required Count</label>
            <input type="number" min="1" style={modalInputStyle} value={requiredCount} onChange={e => setRequiredCount(e.target.value)} />
          </div>
          <div>
            <label style={modalLabelStyle}>Generation Priority</label>
            <input type="number" style={modalInputStyle} value={genPriority} onChange={e => setGenPriority(e.target.value)} />
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button onClick={onClose} style={cancelBtnStyle}>Cancel</button>
          <button onClick={submit} disabled={saving} style={{
            ...saveBtnStyle, opacity: saving ? 0.5 : 1,
          }}>{saving ? 'Adding...' : 'Add Template'}</button>
        </div>
      </div>
    </div>
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <SectionLabel>Holidays ({relevantHolidays.length})</SectionLabel>
        <button onClick={() => setShowAdd(true)} style={{
          padding: '8px 16px', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 12,
          background: 'linear-gradient(135deg,#0ea5e9,#6366f1)', color: '#fff', border: 'none',
        }}>+ Add Holiday</button>
      </div>

      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)', background: 'rgba(14,165,233,0.04)' }}>
              {['Holiday', 'Date', 'Type', 'Major', 'Scope', ''].map(h => (
                <th key={h} style={{
                  padding: '10px 14px', textAlign: 'left', fontSize: 10, fontWeight: 800,
                  color: 'var(--text-dim)', letterSpacing: 1, textTransform: 'uppercase',
                }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {relevantHolidays.map(h => {
              const htc = HOLIDAY_TYPE_COLORS[h.holiday_type] || HOLIDAY_TYPE_COLORS.custom;
              return (
                <tr key={h.id} style={{ borderBottom: '1px solid rgba(30,58,95,0.4)' }}>
                  <td style={{ padding: '10px 14px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {h.color_hex && (
                        <div style={{ width: 8, height: 8, borderRadius: '50%', background: h.color_hex, flexShrink: 0 }} />
                      )}
                      <span style={{ fontWeight: 700, color: 'var(--text)' }}>{h.holiday_name}</span>
                    </div>
                  </td>
                  <td style={{ padding: '10px 14px', fontSize: 12, color: 'var(--text-muted)' }}>
                    {new Date(h.holiday_date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    <span style={{
                      fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 6,
                      background: htc.bg, color: htc.color, textTransform: 'capitalize',
                    }}>{h.holiday_type}</span>
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    {h.is_major_holiday ? (
                      <span style={{ fontSize: 11, fontWeight: 700, color: '#f59e0b' }}>Yes</span>
                    ) : (
                      <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>No</span>
                    )}
                  </td>
                  <td style={{ padding: '10px 14px', fontSize: 11, color: 'var(--text-muted)' }}>
                    {h.site_id ? 'Site' : 'Org-wide'}
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    <button onClick={() => handleDelete(h.id)} style={{
                      padding: '4px 8px', borderRadius: 6, cursor: 'pointer', fontSize: 11,
                      background: 'rgba(248,113,113,0.1)', color: '#f87171', border: '1px solid rgba(248,113,113,0.2)',
                      fontWeight: 600,
                    }}>Delete</button>
                  </td>
                </tr>
              );
            })}
            {relevantHolidays.length === 0 && (
              <tr>
                <td colSpan={6} style={{ padding: '40px 14px', textAlign: 'center', color: 'var(--text-dim)', fontStyle: 'italic' }}>
                  No holidays configured. Add holidays to define schedule exceptions.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

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
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }} onClick={onClose}>
      <div className="modal-box" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 16, padding: 28, width: 440, maxHeight: '85vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: 17, fontWeight: 800, color: '#f1f5f9', marginBottom: 22 }}>Add Holiday</div>

        <label style={modalLabelStyle}>Holiday Name *</label>
        <input style={modalInputStyle} placeholder="Christmas Day" value={holidayName} onChange={e => setHolidayName(e.target.value)} />

        <label style={modalLabelStyle}>Date *</label>
        <input type="date" style={modalInputStyle} value={holidayDate} onChange={e => setHolidayDate(e.target.value)} />

        <label style={modalLabelStyle}>Holiday Type</label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6, marginBottom: 14 }}>
          {HOLIDAY_TYPES.map(ht => {
            const htc = HOLIDAY_TYPE_COLORS[ht.value] || HOLIDAY_TYPE_COLORS.custom;
            return (
              <button key={ht.value} onClick={() => setHolidayType(ht.value)} style={{
                padding: '7px 10px', borderRadius: 8, cursor: 'pointer', fontSize: 11, fontWeight: 700,
                border: `1px solid ${holidayType === ht.value ? htc.color : 'var(--border)'}`,
                background: holidayType === ht.value ? htc.bg : 'transparent',
                color: holidayType === ht.value ? htc.color : 'var(--text-muted)',
              }}>{ht.label}</button>
            );
          })}
        </div>

        <label style={modalLabelStyle}>Scope</label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 14 }}>
          <button onClick={() => setScope('org')} style={{
            padding: '7px 10px', borderRadius: 8, cursor: 'pointer', fontSize: 11, fontWeight: 700,
            border: `1px solid ${scope === 'org' ? '#0ea5e9' : 'var(--border)'}`,
            background: scope === 'org' ? 'rgba(14,165,233,0.15)' : 'transparent',
            color: scope === 'org' ? '#0ea5e9' : 'var(--text-muted)',
          }}>Organization-wide</button>
          <button onClick={() => setScope('site')} style={{
            padding: '7px 10px', borderRadius: 8, cursor: 'pointer', fontSize: 11, fontWeight: 700,
            border: `1px solid ${scope === 'site' ? '#10b981' : 'var(--border)'}`,
            background: scope === 'site' ? 'rgba(16,185,129,0.15)' : 'transparent',
            color: scope === 'site' ? '#10b981' : 'var(--text-muted)',
          }}>This Site Only</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 4 }}>
          <div>
            <label style={modalLabelStyle}>Color</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
              <input type="color" value={colorHex} onChange={e => setColorHex(e.target.value)} style={{
                width: 40, height: 36, borderRadius: 8, border: '1px solid var(--border)',
                background: 'var(--bg-deep)', cursor: 'pointer', padding: 2,
              }} />
              <input style={{ ...modalInputStyle, marginBottom: 0, flex: 1 }} value={colorHex} onChange={e => setColorHex(e.target.value)} />
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 12 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-muted)', cursor: 'pointer' }}>
              <input type="checkbox" checked={isMajor} onChange={e => setIsMajor(e.target.checked)} style={{ accentColor: '#f59e0b', width: 15, height: 15 }} />
              Major Holiday
            </label>
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button onClick={onClose} style={cancelBtnStyle}>Cancel</button>
          <button onClick={submit} disabled={saving} style={{
            ...saveBtnStyle, opacity: saving ? 0.5 : 1,
          }}>{saving ? 'Adding...' : 'Add Holiday'}</button>
        </div>
      </div>
    </div>
  );
}

/* ── Shared Components ───────────────────────────────────────────────────── */

const fieldLabelStyle: React.CSSProperties = {
  fontSize: 11, color: 'var(--text-muted)', display: 'block',
  marginBottom: 5, fontWeight: 600, letterSpacing: 0.5,
};
const fieldInputStyle: React.CSSProperties = {
  width: '100%', padding: '9px 12px', borderRadius: 8,
  border: '1px solid var(--border)', background: 'var(--bg-deep)',
  color: 'var(--text)', fontSize: 13,
};
const modalLabelStyle: React.CSSProperties = {
  fontSize: 11, color: 'var(--text-muted)', display: 'block',
  marginBottom: 5, fontWeight: 600, letterSpacing: 0.5,
};
const modalInputStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px', borderRadius: 8,
  border: '1px solid var(--border)', background: 'var(--bg-deep)',
  color: 'var(--text)', fontSize: 14, marginBottom: 12,
};
const saveBtnStyle: React.CSSProperties = {
  padding: '10px 24px', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 13,
  background: 'linear-gradient(135deg,#0ea5e9,#6366f1)', color: '#fff', border: 'none',
};
const cancelBtnStyle: React.CSSProperties = {
  padding: '9px 18px', borderRadius: 8, cursor: 'pointer', background: 'transparent',
  color: 'var(--text-muted)', border: '1px solid var(--border)', fontWeight: 600, fontSize: 13,
};

function Field({ label, value, onChange, type }: { label: string; value: string; onChange: (v: string) => void; type?: string }) {
  return (
    <div>
      <label style={fieldLabelStyle}>{label}</label>
      <input type={type || 'text'} value={value} onChange={e => onChange(e.target.value)} style={fieldInputStyle} />
    </div>
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
