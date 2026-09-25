'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { cachedFetch } from '@/lib/clientCache';
import Link from 'next/link';
import { PageHeader, Card, Badge, Button, Table, EmptyState, Banner, Modal, scheduleStatusTone, scheduleStatusLabel, SCHEDULE_STATUSES } from '@/components/ui';
import { SiteScheduleBoard } from './SiteScheduleBoard';
import { defaultScheduleName, SCHEDULE_NAME_MAX } from '@/lib/scheduleName';
import { scheduleStamps } from '@/lib/scheduleStamps';
import AssistantPanel from './[id]/AssistantPanel';
import RequestWindowCard from './RequestWindowCard';
import HolidayCallCard from './HolidayCallCard';

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
  // Row provenance (Gabriel 2026-07-27) — several drafts can share a date
  // range, so the list shows which one is freshest. All three are read-only
  // here, hence the defensive nullability. `last_activity_at` is DERIVED by
  // the list route (lib/scheduleActivity.ts) and is the one that tracks real
  // scheduling work; `updated_at` is only the schedule ROW's stamp (a rename,
  // a settings edit) and is kept solely as the fallback when the derivation
  // degraded.
  created_at: string | null;
  updated_at: string | null;
  last_activity_at: string | null;
  sites: { name: string; short_name: string | null } | null;
}

interface Site {
  id: string;
  name: string;
  short_name: string | null;
}

/* Schedule-type pill. The literals this used to hold — #8b5cf6 / #f87171 /
   #0ea5e9 — were the DARK-theme values of --indigo / --danger / --blue (the
   latter two byte-identical), so the pills were tuned for dark and washed out
   on the light default. Same hues, AA-passing in light, and they follow the
   accent ramp into dark. `call` genuinely is the alert tone here, matching the
   `call` row in the site editor's CATEGORY_COLORS. Tints keep their original
   15% weight rather than the .10/.12 of the paired --*-bg tokens, so the pill
   fills are unchanged. */
const TYPE_COLORS: Record<string, { color: string; bg: string; label: string }> = {
  combined: { color: 'var(--indigo)', bg: 'color-mix(in srgb, var(--indigo) 15%, transparent)', label: 'Combined' },
  call:     { color: 'var(--danger)', bg: 'color-mix(in srgb, var(--danger) 15%, transparent)', label: 'Call' },
  shifts:   { color: 'var(--blue)',   bg: 'color-mix(in srgb, var(--blue) 15%, transparent)',   label: 'Shifts' },
};

const GROUP_OPTIONS: { value: string; label: string }[] = [
  { value: 'physician', label: 'Physicians' },
  { value: 'crna', label: 'CRNAs' },
  { value: 'both', label: 'Both' },
];

const TABLE_HEADERS = ['Schedule Name', 'Site', 'Type', 'Provider Group', 'Date Range', 'Status', 'Actions'];

export interface SchedulesClientProps {
  /** Rendered by the server in the same request as the page shell. */
  initialSchedules: Schedule[];
  /** Unfiltered — the board shows real state and never takes the table's filters. */
  initialAllSchedules: Schedule[];
  initialSites: Site[];
  orgId: string;
  loadError: string | null;
  /** The site the nav arrived with (?site_id=). Seeded into the filter so the
   *  control agrees with the list the server already rendered — a dropdown
   *  reading "All sites" above a single site's schedules is a screen that
   *  contradicts itself. */
  initialSiteFilter?: string;
  /** Render the delete control at all. The route re-checks the same rule — this
   *  only avoids offering a button that would come back 403. */
  canDelete?: boolean;
  /** Admins see the recycle view and can restore from it. */
  canSeeDeleted?: boolean;
}

export default function SchedulesClient(
  {
    initialSchedules, initialAllSchedules, initialSites, orgId, loadError,
    initialSiteFilter = '', canDelete = false, canSeeDeleted = false,
  }: SchedulesClientProps,
) {
  // The recycle view: deleted schedules, admins only.
  const [showDeleted, setShowDeleted] = useState(false);
  const [deletedRows, setDeletedRows] = useState<Schedule[]>([]);
  const [deletedError, setDeletedError] = useState<string | null>(null);
  const [schedules, setSchedules] = useState<Schedule[]>(initialSchedules);
  const [sites, setSites] = useState<Site[]>(initialSites);
  // Starts FALSE — the rows are already on screen, and a spinner over visible
  // data is the flash this conversion removes.
  const [loading, setLoading] = useState(false);
  const [siteFilter, setSiteFilter] = useState(initialSiteFilter);
  const [typeFilter, setTypeFilter] = useState('');
  const [groupFilter, setGroupFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  // Deep link from /block-prep: open the create modal with the site pre-chosen.
  const [presetSiteId, setPresetSiteId] = useState('');
  // The board's "+ New" carries both site and group into the create modal, so
  // the column you clicked is the schedule you get.
  const [presetGroup, setPresetGroup] = useState('both');
  const [allSchedules, setAllSchedules] = useState<Schedule[]>(initialAllSchedules);
  // Mount effects below re-run on filter changes AND once on mount; the mount
  // run would refetch exactly what the server already sent, reinstating the
  // waterfall this page was converted to remove.
  const seeded = useRef(true);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('create') === '1') {
      setPresetSiteId(params.get('site_id') || '');
      setShowCreate(true);
      // Strip create/site_id from the address bar once the modal is open —
      // otherwise a refresh (or the back button landing here again) silently
      // reopens Create Schedule with no user action. Delete only THESE two
      // params rather than clearing the whole query string (round 6 nit 3) —
      // any other params this page is ever linked with (a filter, an
      // assistant target, ...) must survive the strip.
      params.delete('create');
      params.delete('site_id');
      const qs = params.toString();
      window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : ''));
    }
  }, []);
  // Assistant reach (ui-v1 Task 8): the backend contract targets ONE schedule
  // per conversation, so the list page picks a schedule first, then mounts the
  // same self-contained AssistantPanel the grid page uses.
  const [showAssistantPicker, setShowAssistantPicker] = useState(false);
  const [assistantScheduleId, setAssistantScheduleId] = useState<string | null>(null);

  // The organization used to be fetched here, with every other query gated
  // behind it — a round trip to learn an id that never changes. The server
  // component resolves it and passes it in.

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

  // The board is deliberately NOT filtered. Its whole point is the
  // physician/CRNA split per site, and running the table's group filter
  // through it would empty the very columns it exists to show. Filters belong
  // to the table below; the board always shows the real state.
  const loadAllSchedules = useCallback(async () => {
    if (!orgId) return;
    const res = await fetch('/api/scheduling/schedules?org_id=' + orgId);
    const rows = await res.json();
    setAllSchedules(Array.isArray(rows) ? rows : []);
  }, [orgId]);

  const loadSites = useCallback(async () => {
    if (!orgId) return;
    const res = await cachedFetch('/api/scheduling/sites?org_id=' + orgId);
    setSites(await res.json());
  }, [orgId]);

  useEffect(() => {
    if (seeded.current) { seeded.current = false; return; }
    loadSchedules();
  }, [loadSchedules]);
  // Kept SEPARATE from the filtered list above, because its only dependency is
  // orgId: merging the two would refetch the whole unfiltered board on every
  // filter change, which is work the board does not need and did not do
  // before. It reloads only when something else invalidates it.
  useEffect(() => {
    if (allSchedules.length > 0) return;
    loadAllSchedules();
  }, [loadAllSchedules, allSchedules.length]);
  useEffect(() => {
    if (sites.length > 0) return;
    loadSites();
  }, [loadSites, sites.length]);

  // The old copy said "cannot be undone — all versions, slots and assignments
  // will be removed", and it was true: this called a hard DELETE. It is a soft
  // delete now (patch62), so the warning has to say what actually happens —
  // an over-dire prompt teaches people to distrust the next one.
  const handleDelete = async (id: string, name: string) => {
    if (!confirm(
      `Delete "${name}"?\n\n`
      + 'It will be hidden from every list and dashboard. Nothing is erased — '
      + 'an administrator can restore it, with all its versions, slots and '
      + 'assignments intact.\n\n'
      + 'Note: while it is deleted it still counts for cross-site '
      + 'double-booking checks, so nobody it has scheduled becomes free.',
    )) return;
    const r = await fetch(`/api/scheduling/schedules/${id}`, { method: 'DELETE' });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      alert(body?.error || 'The schedule could not be deleted.');
      return;
    }
    loadSchedules();
    loadAllSchedules();
    if (showDeleted) loadDeleted();
  };

  /** The recycle view. Admin-only at the route as well as here. */
  const loadDeleted = useCallback(async () => {
    setDeletedError(null);
    try {
      const r = await fetch(`/api/scheduling/schedules?org_id=${orgId}&deleted=true`);
      if (!r.ok) throw new Error(`Request failed (${r.status})`);
      setDeletedRows(await r.json());
    } catch (e) {
      // An empty recycle view and a failed read look identical, and only one
      // of them means "nothing was deleted".
      setDeletedError(e instanceof Error ? e.message : 'Deleted schedules could not be loaded.');
      setDeletedRows([]);
    }
  }, [orgId]);

  const handleRestore = async (id: string, name: string) => {
    if (!confirm(`Restore "${name}" to the active list?`)) return;
    const r = await fetch(`/api/scheduling/schedules/${id}?restore=true`, { method: 'PUT' });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      alert(body?.error || 'The schedule could not be restored.');
      return;
    }
    loadDeleted();
    loadSchedules();
    loadAllSchedules();
  };

  const handleArchive = async (id: string, name: string) => {
    if (!confirm(`Archive "${name}"? It will be hidden from the active list but kept in the database.`)) return;
    await fetch(`/api/scheduling/schedules/${id}?archive=true`, { method: 'DELETE' });
    loadSchedules();
    loadAllSchedules();
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

  if (loadError) {
    // A failed server read must not render as "no schedules" — an empty list
    // is a claim, and this is the one case where it would be a false one.
    return (
      <div>
        <PageHeader title="Schedules" />
        <Banner tone="error">{loadError}</Banner>
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

      {/* Every site in its own box, split physician / CRNA. The filterable
          table below keeps the row-level actions (archive, delete) and the
          status/type filters the board deliberately does not carry. */}
      <SiteScheduleBoard
        sites={sites}
        schedules={allSchedules}
        onCreate={(siteId, group) => {
          setPresetSiteId(siteId);
          setPresetGroup(group);
          setShowCreate(true);
        }}
      />

      <div style={{
        fontSize: 'var(--fs-xs)', textTransform: 'uppercase', letterSpacing: 1,
        color: 'var(--text-dim)', fontWeight: 700, marginBottom: 'var(--space-2)',
      }}>
        All schedules
      </div>

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
            // "edited" is dropped when nothing happened to the draft after it
            // was created, and either line is dropped when its stamp is
            // missing/unparseable — see lib/scheduleStamps.ts. The `??` only
            // fires against an older route/response that carries no derived
            // stamp; it keeps the pre-derivation behaviour rather than blanking
            // the line.
            const stamps = scheduleStamps(s.created_at, s.last_activity_at ?? s.updated_at);
            return [
              <div key="name">
                <Link href={`/schedules/${s.id}`} style={{ textDecoration: 'none', color: 'var(--text-strong)', fontWeight: 700 }}>
                  {s.schedule_name}
                </Link>
                {(stamps.created || stamps.edited) && (
                  <div style={stampGridStyle}>
                    {stamps.created && <><span>created</span><span>{stamps.created}</span></>}
                    {stamps.edited && <><span>edited</span><span>{stamps.edited}</span></>}
                  </div>
                )}
              </div>,
              s.sites?.short_name || s.sites?.name || '—',
              <span key="type" style={{
                fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 6,
                background: tc.bg, color: tc.color, whiteSpace: 'nowrap',
              }}>{tc.label}</span>,
              <span key="group" style={{ textTransform: 'capitalize' }}>{groupLabel}</span>,
              <span key="dates" style={{ color: 'var(--navy)', fontWeight: 700 }}>
                {formatDate(s.date_start)} — {formatDate(s.date_end)}
              </span>,
              <Badge key="status" tone={scheduleStatusTone(s.status)}>{scheduleStatusLabel(s.status)}</Badge>,
              <div key="actions" style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
                <Link href={`/schedules/${s.id}`} style={{ textDecoration: 'none' }}>
                  <Button variant="ghost" size="sm" style={{ color: 'var(--blue)' }}>Open</Button>
                </Link>
                {s.status !== 'archived' && (
                  <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); handleArchive(s.id, s.schedule_name); }}>Archive</Button>
                )}
                {canDelete && (
                  <Button variant="ghost" size="sm" style={{ color: 'var(--danger)' }} onClick={(e) => { e.stopPropagation(); handleDelete(s.id, s.schedule_name); }}>Delete</Button>
                )}
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

      {/* ── Deleted schedules (admins only) ─────────────────────────────
          A deleted schedule is hidden, never erased (patch62). This is where
          an admin finds one and puts it back. Collapsed by default: it is a
          recovery tool, not part of the daily read, and a permanently-open
          list of deleted things invites treating deletion as reversible
          housekeeping rather than a decision. */}
      {canSeeDeleted && (
        <Card style={{ marginTop: 'var(--space-4)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const next = !showDeleted;
                setShowDeleted(next);
                if (next) loadDeleted();
              }}
            >
              {showDeleted ? '▾' : '▸'} Deleted schedules
            </Button>
            {showDeleted && deletedRows.length > 0 && (
              <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>
                {deletedRows.length} recoverable
              </span>
            )}
          </div>

          {showDeleted && (
            <div style={{ marginTop: 'var(--space-3)' }}>
              {deletedError ? (
                <Banner tone="error">{deletedError}</Banner>
              ) : deletedRows.length === 0 ? (
                <p style={{
                  margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--text-dim)',
                }}>
                  Nothing has been deleted.
                </p>
              ) : (
                deletedRows.map(d => (
                  <div key={d.id} style={{
                    display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
                    padding: '8px 0', borderBottom: '1px solid var(--border-faint)',
                  }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 'var(--fs-sm)', fontWeight: 600 }}>
                        {d.schedule_name}
                      </div>
                      <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>
                        {d.sites?.short_name || d.sites?.name || '—'}
                        {' · '}{formatDate(d.date_start)} — {formatDate(d.date_end)}
                        {' · '}{scheduleStatusLabel(d.status)} when deleted
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      style={{ color: 'var(--blue)' }}
                      onClick={() => handleRestore(d.id, d.schedule_name)}
                    >
                      Restore
                    </Button>
                  </div>
                ))
              )}
            </div>
          )}
        </Card>
      )}

      {/* Request-intake window management (patch29) — kept below the table so
          the schedule list stays the page's focus; see RequestWindowCard for
          the placement rationale. */}
      <RequestWindowCard sites={sites} initialSiteId={siteFilter || undefined} />

      {/* Holiday call planning (patch44) — a sibling of the request window for
          the same reason: it is operational work Gabriel does around a
          generation cycle, not durable site configuration. */}
      <HolidayCallCard orgId={orgId} sites={sites} initialSiteId={siteFilter || undefined} />

      {/* initialSiteId carries the /block-prep deep link's site through, so
          Create Schedule arrives with the site already chosen. */}
      {showCreate && (
        <CreateScheduleModal
          orgId={orgId}
          sites={sites}
          initialSiteId={presetSiteId}
          initialGroup={presetGroup}
          onClose={() => { setShowCreate(false); setPresetGroup('both'); }}
          onFailed={() => { loadSchedules(); loadAllSchedules(); }}
        />
      )}
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

// Created / edited stamps under the schedule name. Same secondary-text
// treatment the page already uses for small captions (--fs-xs on --text-muted);
// the two-column grid keeps the times aligned under each other.
const stampGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'max-content max-content',
  columnGap: 'var(--space-2)',
  rowGap: 1,
  marginTop: 'var(--space-1)',
  fontSize: 'var(--fs-xs)',
  color: 'var(--text-muted)',
  whiteSpace: 'nowrap',
};

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
// `onFailed` refreshes the list WITHOUT closing the modal — the failed POST may
// have left a partial schedule the user has to see (and delete) before retrying.
function CreateScheduleModal({ orgId, sites, initialSiteId = '', initialGroup = 'both', onClose, onFailed }: { orgId: string; sites: Site[]; initialSiteId?: string; initialGroup?: string; onClose: () => void; onFailed: () => void }) {
  const [siteId, setSiteId] = useState(initialSiteId);
  const [providerGroup, setProviderGroup] = useState(initialGroup);
  const [dateStart, setDateStart] = useState('');
  const [dateEnd, setDateEnd] = useState('');
  // Optional custom name (Gabriel 2026-07-22) — blank keeps the generated
  // default, which the placeholder previews (defaultScheduleName is the same
  // single-homed helper the POST route uses, so the preview can't drift).
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const siteName = sites.find(s => s.id === siteId)?.name;
  const namePlaceholder = siteName && dateStart
    ? defaultScheduleName(siteName, dateStart)
    : 'Auto-generated from site + start month';

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

  // A failed create must never look like a successful one. The POST route
  // inserts the schedule, then its version, slots and assignments in sequence
  // and 500s at the first failure, so a rejected request can leave a PARTIAL
  // schedule behind — closing the modal silently (the old behaviour) hid both
  // the failure and the debris. On failure we keep the modal open with the
  // route's own message and refresh the list underneath, so a half-built
  // schedule is visible and can be deleted.
  const submit = async () => {
    if (!siteId || !dateStart || !dateEnd) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/scheduling/schedules', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          organization_id: orgId,
          site_id: siteId,
          schedule_type: 'combined',
          provider_group: providerGroup,
          date_start: dateStart,
          date_end: dateEnd,
          // Blank → the route falls back to the generated default.
          schedule_name: name,
        }),
      });
      // A 500 from Next can be an HTML error page, so the parse is guarded.
      const data = await res.json().catch(() => ({} as { id?: string; error?: string }));
      if (!res.ok || !data.id) {
        setSaving(false);
        // 400 is the route's name validation, which runs BEFORE any insert —
        // nothing was written, so don't send the user hunting for debris.
        const partial = res.status !== 400
          ? ' — a partially created schedule may now be in the list below; delete it before retrying.'
          : '';
        setError((data.error || `Schedule creation failed (${res.status})`) + partial);
        onFailed();
        return;
      }
      window.location.href = `/schedules/${data.id}`;
    } catch (e) {
      // The request may still have been applied server-side, so this refreshes
      // the list too rather than asserting nothing happened.
      setSaving(false);
      setError(`Schedule creation failed: ${e instanceof Error ? e.message : String(e)}`);
      onFailed();
    }
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '10px 12px', borderRadius: 8,
    border: '1px solid var(--border)', background: 'var(--bg-deep)',
    color: 'var(--text)', fontSize: 14, marginBottom: 12,
  };
  const labelStyle: React.CSSProperties = { fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 5, fontWeight: 600, letterSpacing: 0.5 };

  // Same amber / sky / violet the provider-type swatches use, but expressed as
  // tokens so the selected option is legible on the light default too — the
  // literals here were the dark-theme values. `tint` is pre-mixed rather than
  // concatenated: a `${g.color}20` suffix is a no-op against a var(), which is
  // why the fill has to be a finished color-mix string. 13% ≈ the old 0x20.
  const groupOptions = [
    { value: 'physician', label: 'Physicians', color: 'var(--warn)', tint: 'color-mix(in srgb, var(--warn) 13%, transparent)' },
    { value: 'crna', label: 'CRNAs', color: 'var(--blue)', tint: 'color-mix(in srgb, var(--blue) 13%, transparent)' },
    { value: 'both', label: 'Both', color: 'var(--indigo)', tint: 'color-mix(in srgb, var(--indigo) 13%, transparent)' },
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
      {error && (
        <div style={{ marginBottom: 12 }}>
          <Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner>
        </div>
      )}

      <label style={labelStyle}>Site *</label>
      <select value={siteId} onChange={e => setSiteId(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
        <option value="">— Select Site —</option>
        {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>

      <label style={labelStyle}>Schedule Name (optional)</label>
      <input
        type="text"
        style={inputStyle}
        value={name}
        maxLength={SCHEDULE_NAME_MAX}
        placeholder={namePlaceholder}
        title="Leave blank to use the auto-generated name shown as the placeholder"
        onChange={e => setName(e.target.value)}
      />

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
              background: providerGroup === g.value ? g.tint : 'transparent',
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
