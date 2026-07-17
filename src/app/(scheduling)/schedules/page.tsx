'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { PageHeader, Card, Badge, Button, Table, EmptyState, Banner, Modal, scheduleStatusTone, scheduleStatusLabel, SCHEDULE_STATUSES } from '@/components/ui';
import AssistantPanel from './[id]/AssistantPanel';
import RequestWindowCard from './RequestWindowCard';

interface Schedule {
  id: string;
  organization_id: string;
  site_id: string | null;
  schedule_name: string;
  schedule_type: string;
  provider_group: string;
  date_start: string;
  date_end: string;
  status: string;
  current_version_number: number;
  sites: { name: string; short_name: string | null } | null;
}

interface Site {
  id: string;
  name: string;
  short_name: string | null;
}

const TYPE_COLORS: Record<string, { color: string; bg: string; label: string }> = {
  combined: { color: '#8b5cf6', bg: 'rgba(139,92,246,0.15)', label: 'Combined' },
  call:     { color: '#f87171', bg: 'rgba(248,113,113,0.15)', label: 'Call' },
  shifts:   { color: '#0ea5e9', bg: 'rgba(14,165,233,0.15)', label: 'Shifts' },
};

const GROUP_OPTIONS: { value: string; label: string }[] = [
  { value: 'physician', label: 'Physicians' },
  { value: 'crna', label: 'CRNAs' },
  { value: 'both', label: 'Both' },
];

const TABLE_HEADERS = ['Schedule Name', 'Site', 'Type', 'Provider Group', 'Date Range', 'Status', 'Actions'];

export default function SchedulesPage() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [orgId, setOrgId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [siteFilter, setSiteFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [groupFilter, setGroupFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  // Assistant reach (ui-v1 Task 8): the backend contract targets ONE schedule
  // per conversation, so the list page picks a schedule first, then mounts the
  // same self-contained AssistantPanel the grid page uses.
  const [showAssistantPicker, setShowAssistantPicker] = useState(false);
  const [assistantScheduleId, setAssistantScheduleId] = useState<string | null>(null);

  // Load org
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

  const loadSchedules = useCallback(async () => {
    if (!orgId) return;
    const params = new URLSearchParams({ org_id: orgId });
    if (siteFilter) params.set('site_id', siteFilter);
    if (typeFilter) params.set('schedule_type', typeFilter);
    if (groupFilter) params.set('provider_group', groupFilter);
    if (statusFilter) params.set('status', statusFilter);
    const res = await fetch('/api/scheduling/schedules?' + params);
    setSchedules(await res.json());
  }, [orgId, siteFilter, typeFilter, groupFilter, statusFilter]);

  const loadSites = useCallback(async () => {
    if (!orgId) return;
    const res = await fetch('/api/scheduling/sites?org_id=' + orgId);
    setSites(await res.json());
  }, [orgId]);

  useEffect(() => { loadSchedules(); }, [loadSchedules]);
  useEffect(() => { loadSites(); }, [loadSites]);

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Permanently delete "${name}"? This cannot be undone — all versions, slots, and assignments will be removed.`)) return;
    await fetch(`/api/scheduling/schedules/${id}`, { method: 'DELETE' });
    loadSchedules();
  };

  const handleArchive = async (id: string, name: string) => {
    if (!confirm(`Archive "${name}"? It will be hidden from the active list but kept in the database.`)) return;
    await fetch(`/api/scheduling/schedules/${id}?archive=true`, { method: 'DELETE' });
    loadSchedules();
  };

  const formatDate = (d: string) => {
    const date = new Date(d + 'T12:00:00');
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  if (loading) {
    return (
      <div>
        <PageHeader title="Schedules" />
        <Card pad={false}>
          <Table headers={TABLE_HEADERS} rows={undefined} minWidth={760} />
        </Card>
      </div>
    );
  }

  if (!orgId) {
    return (
      <div>
        <PageHeader title="Schedules" />
        <Banner tone="warn">No organization found. Please set up your organization first.</Banner>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Schedules"
        subtitle={`${schedules.length} schedule${schedules.length !== 1 ? 's' : ''}`}
        actions={
          <>
            <Button
              variant="secondary"
              onClick={() => setShowAssistantPicker(true)}
              disabled={schedules.length === 0}
              title={schedules.length === 0 ? 'Create a schedule first' : 'Ask the assistant about a schedule'}
            >
              Assistant ✨
            </Button>
            <Button onClick={() => setShowCreate(true)}>+ Create Schedule</Button>
          </>
        }
      />

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
        <select value={siteFilter} onChange={(e) => setSiteFilter(e.target.value)} style={selectStyle}>
          <option value="">All Sites</option>
          {sites.map(s => (
            <option key={s.id} value={s.id}>{s.short_name || s.name}</option>
          ))}
        </select>
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} style={selectStyle}>
          <option value="">All Types</option>
          <option value="combined">Combined</option>
          <option value="call">Call</option>
          <option value="shifts">Shifts</option>
        </select>
        <select value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)} style={selectStyle}>
          <option value="">All Provider Groups</option>
          {GROUP_OPTIONS.map(g => (
            <option key={g.value} value={g.value}>{g.label}</option>
          ))}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={selectStyle}>
          <option value="">All Statuses</option>
          {SCHEDULE_STATUSES.map((s) => (
            <option key={s} value={s}>{scheduleStatusLabel(s)}</option>
          ))}
        </select>
      </div>

      {/* Table */}
      <Card pad={false}>
        <Table
          headers={TABLE_HEADERS}
          minWidth={760}
          rows={schedules.map((s) => {
            const tc = TYPE_COLORS[s.schedule_type] || TYPE_COLORS.shifts;
            const groupLabel = GROUP_OPTIONS.find(g => g.value === s.provider_group)?.label || s.provider_group;
            return [
              <Link key="name" href={`/schedules/${s.id}`} style={{ textDecoration: 'none', color: 'var(--text-strong)', fontWeight: 700 }}>
                {s.schedule_name}
              </Link>,
              s.sites?.short_name || s.sites?.name || '—',
              <span key="type" style={{
                fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 6,
                background: tc.bg, color: tc.color, whiteSpace: 'nowrap',
              }}>{tc.label}</span>,
              <span key="group" style={{ textTransform: 'capitalize' }}>{groupLabel}</span>,
              `${formatDate(s.date_start)} — ${formatDate(s.date_end)}`,
              <Badge key="status" tone={scheduleStatusTone(s.status)}>{scheduleStatusLabel(s.status)}</Badge>,
              <div key="actions" style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
                <Link href={`/schedules/${s.id}`} style={{ textDecoration: 'none' }}>
                  <Button variant="ghost" size="sm" style={{ color: 'var(--blue)' }}>Open</Button>
                </Link>
                {s.status !== 'archived' && (
                  <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); handleArchive(s.id, s.schedule_name); }}>Archive</Button>
                )}
                <Button variant="ghost" size="sm" style={{ color: 'var(--danger)' }} onClick={(e) => { e.stopPropagation(); handleDelete(s.id, s.schedule_name); }}>Delete</Button>
              </div>,
            ];
          })}
          empty={
            <EmptyState
              icon="▦"
              title="No schedules found"
              hint="Create one to get started — pick a site and date range and the engine will build the call grid."
              action={<Button size="sm" onClick={() => setShowCreate(true)}>+ Create Schedule</Button>}
            />
          }
        />
      </Card>

      {/* Request-intake window management (patch29) — kept below the table so
          the schedule list stays the page's focus; see RequestWindowCard for
          the placement rationale. */}
      <RequestWindowCard sites={sites} initialSiteId={siteFilter || undefined} />

      {showCreate && <CreateScheduleModal orgId={orgId} sites={sites} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); loadSchedules(); }} />}
      {showAssistantPicker && (
        <AssistantSchedulePicker
          schedules={schedules}
          onClose={() => setShowAssistantPicker(false)}
          onPick={(id) => { setShowAssistantPicker(false); setAssistantScheduleId(id); }}
        />
      )}
      {assistantScheduleId && (
        <AssistantPanel
          scheduleId={assistantScheduleId}
          onMutated={loadSchedules}
          onClose={() => setAssistantScheduleId(null)}
        />
      )}
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)',
  background: 'var(--bg-deep)', color: 'var(--text)', fontSize: 13, cursor: 'pointer',
};

// ── Assistant schedule picker ────────────────────────────────────────────────
// The assistant backend targets one schedule per conversation, so the list
// page asks which schedule to talk about before mounting AssistantPanel.
function AssistantSchedulePicker({ schedules, onClose, onPick }: {
  schedules: Schedule[];
  onClose: () => void;
  onPick: (scheduleId: string) => void;
}) {
  const [selected, setSelected] = useState(schedules[0]?.id ?? '');

  return (
    <Modal
      open
      onClose={onClose}
      title="Assistant ✨"
      width={440}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => selected && onPick(selected)} disabled={!selected}>Open Assistant</Button>
        </>
      }
    >
      <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.5 }}>
        The assistant works on one schedule at a time — pick which one to talk about.
      </p>
      <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 5, fontWeight: 600, letterSpacing: 0.5 }}>
        Schedule
      </label>
      <select
        value={selected}
        onChange={e => setSelected(e.target.value)}
        style={{ ...selectStyle, width: '100%', padding: '10px 12px', fontSize: 14 }}
      >
        {schedules.map(s => (
          <option key={s.id} value={s.id}>
            {s.schedule_name} — {s.sites?.short_name || s.sites?.name || 'no site'} ({s.date_start} → {s.date_end})
          </option>
        ))}
      </select>
    </Modal>
  );
}

// ── Create Schedule Modal ────────────────────────────────────────────────────
function CreateScheduleModal({ orgId, sites, onClose, onCreated }: { orgId: string; sites: Site[]; onClose: () => void; onCreated: () => void }) {
  const [siteId, setSiteId] = useState('');
  const [providerGroup, setProviderGroup] = useState('both');
  const [dateStart, setDateStart] = useState('');
  const [dateEnd, setDateEnd] = useState('');
  const [saving, setSaving] = useState(false);

  // Snap end date from a week count. Blocks in anesthesia are usually talked
  // about in whole weeks (e.g. "11-week block", "12-week rotation"). The
  // user can still edit End Date manually if they want something custom.
  const applyWeeks = (weeks: number) => {
    if (!dateStart) return;
    const d = new Date(dateStart + 'T00:00:00Z');
    // weeks × 7 - 1 so an 11-week block starting Monday ends on the Sunday
    // after 11 full weeks (not the start of the 12th week).
    d.setUTCDate(d.getUTCDate() + weeks * 7 - 1);
    setDateEnd(d.toISOString().slice(0, 10));
  };

  const submit = async () => {
    if (!siteId || !dateStart || !dateEnd) return;
    setSaving(true);
    const res = await fetch('/api/scheduling/schedules', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        organization_id: orgId,
        site_id: siteId,
        schedule_type: 'combined',
        provider_group: providerGroup,
        date_start: dateStart,
        date_end: dateEnd,
      }),
    });
    const data = await res.json();
    if (data.id) {
      window.location.href = `/schedules/${data.id}`;
    } else {
      setSaving(false);
      onCreated();
    }
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '10px 12px', borderRadius: 8,
    border: '1px solid var(--border)', background: 'var(--bg-deep)',
    color: 'var(--text)', fontSize: 14, marginBottom: 12,
  };
  const labelStyle: React.CSSProperties = { fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 5, fontWeight: 600, letterSpacing: 0.5 };

  const groupOptions = [
    { value: 'physician', label: 'Physicians', color: '#f59e0b' },
    { value: 'crna', label: 'CRNAs', color: '#0ea5e9' },
    { value: 'both', label: 'Both', color: '#8b5cf6' },
  ];

  return (
    <Modal
      open
      onClose={onClose}
      title="Create Schedule"
      width={480}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={saving || !siteId || !dateStart || !dateEnd}>
            {saving ? 'Creating...' : 'Create Schedule'}
          </Button>
        </>
      }
    >
      <label style={labelStyle}>Site *</label>
      <select value={siteId} onChange={e => setSiteId(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
        <option value="">— Select Site —</option>
        {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>

      <label style={labelStyle}>Provider Group *</label>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 14 }}>
        {groupOptions.map(g => (
          <Button
            key={g.value}
            variant="secondary"
            size="sm"
            onClick={() => setProviderGroup(g.value)}
            style={{
              border: `1px solid ${providerGroup === g.value ? g.color : 'var(--border)'}`,
              background: providerGroup === g.value ? `${g.color}20` : 'transparent',
              color: providerGroup === g.value ? g.color : 'var(--text-muted)',
              fontWeight: 700,
            }}
          >
            {g.label}
          </Button>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 8 }}>
        <div>
          <label style={labelStyle}>Start Date *</label>
          <input type="date" style={inputStyle} value={dateStart} onChange={e => setDateStart(e.target.value)} />
        </div>
        <div>
          <label style={labelStyle}>End Date *</label>
          <input type="date" style={inputStyle} value={dateEnd} onChange={e => setDateEnd(e.target.value)} />
        </div>
      </div>

      <label style={labelStyle}>Quick Block Length</label>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
        {[4, 6, 8, 11, 12, 13, 16].map(n => (
          <Button
            key={n}
            variant="secondary"
            size="sm"
            onClick={() => applyWeeks(n)}
            disabled={!dateStart}
            title={!dateStart ? 'Pick a start date first' : `Set end date to ${n} weeks after start`}
          >
            {n} weeks
          </Button>
        ))}
      </div>
    </Modal>
  );
}
