'use client';

// Per-provider PTO / off / no-call dates, reachable from the roster without
// visiting eleven separate provider profiles. Writes go through the SAME
// availability API (/api/scheduling/availability, /api/scheduling/
// availability/[id]) the profile's Availability tab uses — a row added here
// is indistinguishable from one added there, and there is no second write
// path to drift.
//
// Scoped to the board's year: the GET below asks for rows overlapping
// Jan 1 - Dec 31 of the selected year (blockPrepView's `availabilityQueryUrl`
// / `yearBounds` — an OVERLAP filter per the route: end_date >= from AND
// start_date <= to), matching exactly what annualTally.ts counts for the
// tally card. `dateRangeError` mirrors that SAME overlap test client-side
// (Fix 2, review 2026-09-07, corrected to overlap-not-containment in a
// second pass) so an add that could never appear on this board — or on any
// board, if typed dates land entirely in neither the previous nor the next
// year — is caught before it silently POSTs, lands in the DB, and vanishes
// from the year-scoped refetch with no error. A range spanning INTO the
// neighboring year (a Dec 28 – Jan 5 holiday PTO block, the single most
// common PTO shape in a hospital calendar) is explicitly ALLOWED — the fetch
// would show it fine on either board, and the year-scoped downstream math
// (ptoCounterStats / coveredDaysInYear, dateRanges.ts) already clips it to
// each year's own days, so nothing is double-counted or dropped.
//
// EDIT (review 2026-09-07, third pass): the product ask was PTO/off/holiday
// dates be "editable", and the design spec named "add / edit / delete" as the
// three flows to match — this drawer originally shipped POST and DELETE
// only. Remove-then-add to "edit" a range is lossy: POST defaults
// approval_status to 'approved' (silently promoting a pending request) and
// this drawer's add body never carried notes/reason_code/source (dropping a
// window-sourced row's tag). The fix is a real inline edit — PATCH
// start_date/end_date only, modeled on the profile's own AvailabilityEditForm
// (providers/[id]/page.tsx) — because the hardened PATCH whitelist route only
// updates fields present in the body: leaving approval_status/source/notes/
// reason_code out of the PATCH means they are never touched, which is what
// actually fixes the round-trip loss (no re-add, no field-preservation logic
// needed). ICU-paired rows never reach this edit, same carve-out as the
// profile's ("ICU rows never reach this form") and the same reasoning
// icuRowLockInfo's Remove-gate already uses — editing one half's dates
// without its pair would desynchronize the pairing exactly like a lone
// delete would.
//
// PROVENANCE (review 2026-09-07, third pass): 26 live rows in production
// carry source='request_window' — submitted by a provider through a request
// window, not typed by a chief. The profile flags these with a "Window"
// badge; this drawer showed nothing, so a chief could one-click Remove a
// physician's submitted request with no indication it was ever submitted.
// The per-window cap self-heals when the row is gone (nothing left to count),
// so this was never corruption — just a missing warning on a destructive
// action. Fixed by surfacing `source` as a badge and naming it in the
// removal confirmation.
//
// Every successful write calls `onChanged()` so the host (the block-prep
// page) bumps its refreshKey and the roster's PTO / off-day figures refetch —
// this drawer never recomputes those numbers itself.
//
// TESTING NOTE (read before touching the split below): Modal (components/ui/
// Modal.tsx) portals to `document.body` and renders nothing at all when
// `document` is undefined — which is exactly the case under vitest's node
// environment (no jsdom; see Modal.test.tsx's own "renders nothing without a
// document" case). Wrapping the whole drawer in <Modal> would make every
// render-path test in AvailabilityDrawer.test.tsx assert on an empty string
// no matter what state it's in. So the actual content lives in the exported,
// hook-free `AvailabilityDrawerBody` below — a pure function of its props —
// and the default-exported `AvailabilityDrawer` only wires state/effects
// around it and mounts it inside <Modal>. Tests render `AvailabilityDrawerBody`
// directly with `renderToStaticMarkup`, bypassing Modal entirely. `today` is
// threaded in as a PROP (not read via `new Date()` inside Body) for the same
// reason — Body stays a pure, deterministic function even though the
// past/upcoming split (Fix 4) is calendar-relative.

import { useCallback, useEffect, useState } from 'react';
import { Badge, Banner, Button, EmptyState, Modal } from '@/components/ui';
import { reasonCodeLabel } from '@/lib/validation/providers';
import { isDismissedAvailability } from '@/lib/rulesEngine/shared';
import {
  ADDABLE_AVAILABILITY_TYPES, availabilityQueryUrl, availabilityStatusBadge,
  availabilityTypeDisplayLabel, availabilityTypeHint, availabilityTypeTone,
  dateRangeError, icuPairsFor, icuRowLockInfo, liveBlockingRows, monthDayYear,
  removalConfirmMessage, sellbackStandaloneNote, yearBounds,
  type AddableAvailabilityType,
} from '@/lib/blockPrepView';

/** The provider_availability columns this drawer reads and renders. */
export interface AvailabilityDrawerRow {
  id: string;
  availability_type: string;
  start_date: string;
  end_date: string;
  approval_status: string;
  reason_code: string | null;
  /** 'request_window' when a provider submitted this through a request
   *  window (requestIntake.ts), null/other for anything a chief typed
   *  directly. Drives the "Window" badge and the removal-confirmation
   *  wording — see the file-header PROVENANCE note. */
  source: string | null;
}

const INPUT: React.CSSProperties = {
  padding: '8px 10px', borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--border)', background: 'var(--bg-deep)',
  color: 'var(--text)', fontSize: 'var(--fs-sm)', fontFamily: 'inherit',
};

/** One row's date range, formatted the way the profile does (Fix 3, review
 *  2026-09-07: raw ISO read as a database dump, not a chief-facing date) —
 *  `monthDayYear` (blockPrepView.ts) is the same month/day/year formatter
 *  `coveredSpanLabel` already uses, imported rather than re-implemented.
 *  Collapses a same-day range to one date, matching the profile's own
 *  `sameDay` treatment (AvailabilityCard). */
function formatRange(startDate: string, endDate: string): string {
  const start = monthDayYear(startDate);
  if (startDate === endDate) return start;
  return `${start} → ${monthDayYear(endDate)}`;
}

/**
 * The drawer's content: no hooks, no <Modal>, a straight function of props.
 * Exported so AvailabilityDrawer.test.tsx can exercise every render path
 * (loading / empty / populated / error / pending-vs-approved / editing)
 * directly — see the file-header testing note for why the default export
 * cannot be tested this way.
 */
export function AvailabilityDrawerBody({
  rows, loadError, addError, deleteError, year, today, type, start, end, saving,
  editingRowId, editStart, editEnd, editSaving, editError,
  onTypeChange, onStartChange, onEndChange, onAdd, onRemove,
  onEditRow, onEditStartChange, onEditEndChange, onSaveEdit, onCancelEdit,
}: {
  rows: AvailabilityDrawerRow[] | null;
  /** Set when the GET failed. Kept distinct from `addError`/`deleteError`/
   *  `editError` so a stale load failure can never be mistaken for a fresh
   *  add, delete or edit failure, or vice versa. */
  loadError: string | null;
  /** Set when the most recent add (POST) failed. */
  addError: string | null;
  /** Set when the most recent delete (DELETE) failed. Rendered next to the
   *  list it acted on, NOT in the top load-error banner (Fix I3, review
   *  2026-09-07: a delete failure used to land in the banner above the add
   *  form, reading as "the list failed to load" while the list itself was
   *  fine). */
  deleteError: string | null;
  year: number;
  /** ISO YYYY-MM-DD "today", threaded in as a prop rather than read via
   *  `new Date()` inside this component — see the file-header testing note.
   *  Drives the past/upcoming split (Fix 4, review 2026-09-07). */
  today: string;
  /** Narrower than a general row's `AvailabilityType` (Fix 5, review
   *  2026-09-07) — the add-form can only ever hold one of the three
   *  ADDABLE_AVAILABILITY_TYPES, so a select value matching no rendered
   *  option is unrepresentable. */
  type: AddableAvailabilityType;
  start: string;
  end: string;
  saving: boolean;
  /** id of the row currently in its inline edit form, or null. At most one
   *  row edits at a time (the profile allows several independent per-card
   *  edit states; this drawer's single flat row list keeps one shared slot,
   *  a deliberate simplification, not a parity gap). */
  editingRowId: string | null;
  editStart: string;
  editEnd: string;
  editSaving: boolean;
  /** Set when the most recent edit (PATCH) failed. Rendered inline in the
   *  row being edited, not in a shared banner — an edit failure belongs next
   *  to the exact row it failed for. */
  editError: string | null;
  onTypeChange: (t: AddableAvailabilityType) => void;
  onStartChange: (v: string) => void;
  onEndChange: (v: string) => void;
  onAdd: () => void;
  onRemove: (row: AvailabilityDrawerRow) => void;
  /** Opens the inline edit form for `row`, seeded from its current dates. */
  onEditRow: (row: AvailabilityDrawerRow) => void;
  onEditStartChange: (v: string) => void;
  onEditEndChange: (v: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
}) {
  const rangeError = dateRangeError(start, end, year);
  const { start: minDate, end: maxDate } = yearBounds(year);
  const sellbackHint = availabilityTypeHint(type);
  // Hoisted ONCE per render (Fix 4 of the prior review pass) rather than
  // re-scanned inside the row loop below — icuRowLockInfo and
  // sellbackStandaloneNote both take the precomputed result so neither
  // rescans `rows` per row.
  const icuPairs = rows ? icuPairsFor(rows) : [];
  const liveBlocking = rows ? liveBlockingRows(rows) : [];

  const renderRow = (r: AvailabilityDrawerRow, isPast: boolean) => {
    if (editingRowId === r.id) {
      const editRangeError = dateRangeError(editStart, editEnd, year);
      return (
        <div
          key={r.id}
          style={{
            display: 'flex', flexDirection: 'column', gap: 'var(--space-2)',
            padding: 'var(--space-2) var(--space-3)',
            border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
          }}
        >
          {editError && <Banner tone="error">{editError}</Banner>}
          <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
            <Badge tone={availabilityTypeTone(r.availability_type)}>{availabilityTypeDisplayLabel(r.availability_type)}</Badge>
            <input
              aria-label="Edit start date"
              type="date"
              value={editStart}
              max={maxDate}
              onChange={e => onEditStartChange(e.target.value)}
              style={INPUT}
            />
            <input
              aria-label="Edit end date"
              type="date"
              value={editEnd}
              min={minDate}
              onChange={e => onEditEndChange(e.target.value)}
              style={INPUT}
            />
            <Button
              size="sm"
              onClick={onSaveEdit}
              disabled={editSaving || !editStart || !editEnd || !!editRangeError}
            >
              {editSaving ? 'Saving…' : 'Save'}
            </Button>
            <Button size="sm" variant="ghost" onClick={onCancelEdit}>Cancel</Button>
          </div>
          {editRangeError && (
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--danger)' }}>{editRangeError}</div>
          )}
        </div>
      );
    }

    const typeLabel = availabilityTypeDisplayLabel(r.availability_type);
    // ICU rows carry availability_type 'blocked' — the type badge alone
    // reads as an opaque hard block. reason_code already distinguishes
    // icu_week / icu_post_call; reasonCodeLabel is the single home for that
    // text, shown as a SECOND badge alongside the type, same as the
    // profile's own row rendering.
    const reasonLabel = reasonCodeLabel(r.reason_code);
    const typeHint = availabilityTypeHint(r.availability_type);
    const statusBadge = availabilityStatusBadge(r.approval_status);
    const standaloneNote = sellbackStandaloneNote(liveBlocking, r);
    // Dismissed (denied/canceled) OR past rows read as "not currently live" —
    // OR'd into one dimming decision rather than stacked (a past+denied row
    // dimming twice over would read as broken, not doubly irrelevant).
    const dismissed = isDismissedAvailability(r);
    const lockInfo = icuRowLockInfo(icuPairs, r, year);
    const fromWindow = r.source === 'request_window';
    return (
      <div
        key={r.id}
        style={{
          display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
          padding: 'var(--space-2) var(--space-3)',
          border: '1px solid var(--border-faint)', borderRadius: 'var(--radius-sm)',
          opacity: (dismissed || isPast) ? 0.55 : 1,
        }}
      >
        {/* A plain <span title> rather than a Badge prop — Badge
            (components/ui) doesn't accept a title, and the sell-back
            explanation needs a hover affordance without widening that
            shared component's API. */}
        <span title={typeHint ?? undefined}>
          <Badge tone={availabilityTypeTone(r.availability_type)}>{typeLabel}</Badge>
        </span>
        {reasonLabel && <Badge tone="info">{reasonLabel}</Badge>}
        {/* Window provenance (Fix 2, review 2026-09-07) — tone="info" (this
            design system's blue) rather than the profile's own hardcoded hex,
            same semantic colour through the shared Badge component instead
            of a literal. */}
        {fromWindow && <Badge tone="info">Window</Badge>}
        <div style={{ display: 'flex', flexDirection: 'column', marginRight: 'auto' }}>
          <span style={{ fontSize: 'var(--fs-sm)' }}>{formatRange(r.start_date, r.end_date)}</span>
          {standaloneNote && (
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', fontStyle: 'italic' }}>
              {standaloneNote}
            </span>
          )}
        </div>
        {statusBadge && <Badge tone={statusBadge.tone}>{statusBadge.label}</Badge>}
        {lockInfo.locked ? (
          // ICU rows are paired (week + post-call Monday); a lone delete
          // here would orphan the other half, so no Remove (or Edit) is
          // offered — see icuRowLockInfo's header in blockPrepView.ts.
          <span
            style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}
            title={lockInfo.note ?? undefined}
          >
            ICU-paired
          </span>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={() => onEditRow(r)}>
              Edit
            </Button>
            <Button variant="ghost" size="sm" style={{ color: 'var(--danger)' }} onClick={() => onRemove(r)}>
              Remove
            </Button>
          </>
        )}
      </div>
    );
  };

  return (
    <>
      {loadError && (
        <div style={{ marginBottom: 'var(--space-3)' }}><Banner tone="error">{loadError}</Banner></div>
      )}

      <div style={{
        display: 'flex', gap: 'var(--space-2)', alignItems: 'flex-start',
        flexWrap: 'wrap', marginBottom: 'var(--space-2)',
      }}>
        <select
          aria-label="Availability type"
          value={type}
          onChange={e => onTypeChange(e.target.value as AddableAvailabilityType)}
          style={{ ...INPUT, cursor: 'pointer' }}
        >
          {ADDABLE_AVAILABILITY_TYPES.map(t => (
            <option key={t} value={t}>{availabilityTypeDisplayLabel(t)}</option>
          ))}
        </select>
        {/* No `min` on start / no `max` on end (a range spanning into the
            neighboring year is accepted — see dateRangeError's overlap doc),
            so only the corner that remains a real constraint is bounded — a
            start after the year's end, or an end before the year's start,
            can never overlap it. */}
        <input
          aria-label="Start date"
          type="date"
          value={start}
          max={maxDate}
          onChange={e => onStartChange(e.target.value)}
          style={INPUT}
        />
        <input
          aria-label="End date"
          type="date"
          value={end}
          min={minDate}
          onChange={e => onEndChange(e.target.value)}
          style={INPUT}
        />
        <Button onClick={onAdd} disabled={saving || !start || !end || !!rangeError}>
          {saving ? 'Adding…' : 'Add'}
        </Button>
      </div>
      {sellbackHint && (
        <div style={{ marginBottom: 'var(--space-3)', fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
          {sellbackHint}
        </div>
      )}
      {rangeError && (
        <div style={{ marginBottom: 'var(--space-3)', fontSize: 'var(--fs-xs)', color: 'var(--danger)' }}>
          {rangeError}
        </div>
      )}
      {addError && (
        <div style={{ marginBottom: 'var(--space-3)' }}><Banner tone="error">{addError}</Banner></div>
      )}
      {deleteError && (
        <div style={{ marginBottom: 'var(--space-3)' }}><Banner tone="error">{deleteError}</Banner></div>
      )}

      {rows == null ? (
        <div style={{ color: 'var(--text-dim)' }}>Loading…</div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon="◷"
          title={`No dates in ${year}`}
          hint="PTO, sell-back and days off added here are the same entries the provider's Availability tab shows."
        />
      ) : (() => {
        // Past/upcoming split (Fix 4, review 2026-09-07): matches the
        // profile's SectionRows exactly (same >= comparison, same "Past"
        // label, same dimming) — in September a year-scoped view would
        // otherwise put ~8 months of stale rows above the ones actually
        // being planned.
        const upcoming = rows.filter(r => r.end_date >= today);
        const past = rows.filter(r => r.end_date < today);
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            {upcoming.map(r => renderRow(r, false))}
            {past.length > 0 && (
              <>
                <div style={{
                  fontSize: 'var(--fs-xs)', fontWeight: 700, color: 'var(--text-dim)',
                  letterSpacing: '0.5px', textTransform: 'uppercase',
                  margin: 'var(--space-2) 0 var(--space-1)',
                }}>
                  Past
                </div>
                {past.map(r => renderRow(r, true))}
              </>
            )}
          </div>
        );
      })()}
    </>
  );
}

export default function AvailabilityDrawer({
  providerId, providerName, year, onClose, onChanged,
}: {
  providerId: string;
  providerName: string;
  year: number;
  onClose: () => void;
  /** Called after any successful write (add, edit, or delete) so the host's
   *  roster and tally refetch — this drawer never recomputes those figures
   *  itself. */
  onChanged: () => void;
}) {
  const [rows, setRows] = useState<AvailabilityDrawerRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [type, setType] = useState<AddableAvailabilityType>('pto');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [saving, setSaving] = useState(false);

  const [editingRowId, setEditingRowId] = useState<string | null>(null);
  const [editStart, setEditStart] = useState('');
  const [editEnd, setEditEnd] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch(availabilityQueryUrl(providerId, year));
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setLoadError(body.error || `Could not load dates (${res.status})`);
        setRows(null);
        return;
      }
      setRows(await res.json());
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Network error');
      setRows(null);
    }
  }, [providerId, year]);

  useEffect(() => { load(); }, [load]);

  const add = async () => {
    // The year bound is enforced HERE, not just via the (non-clamping)
    // min/max attributes — see dateRangeError's header for why min/max alone
    // are not enough.
    if (!start || !end || dateRangeError(start, end, year)) return;
    setSaving(true);
    setAddError(null);
    try {
      const res = await fetch('/api/scheduling/availability', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider_id: providerId,
          availability_type: type,
          start_date: start,
          end_date: end,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setAddError(body.error || `Could not save (${res.status})`);
        return;
      }
      setStart('');
      setEnd('');
      await load();
      onChanged();
    } catch (e) {
      setAddError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (row: AvailabilityDrawerRow) => {
    const label = availabilityTypeDisplayLabel(row.availability_type);
    // Destructive and possibly load-bearing for a published schedule — name
    // exactly what's being removed, including WHO, rather than a generic
    // "are you sure?" (this drawer's whole premise is editing eleven people
    // from one screen, so the provider's name belongs in the prompt).
    let message = removalConfirmMessage({
      providerName, typeLabel: label, startDate: row.start_date, endDate: row.end_date,
    });
    // Provenance warning (Fix 2, review 2026-09-07): composed onto the
    // library message locally rather than a `removalConfirmMessage`
    // parameter — blockPrepView.ts is owned by another agent this round.
    if (row.source === 'request_window') {
      message += ' This was submitted through a request window.';
    }
    const ok = confirm(message);
    if (!ok) return;
    setDeleteError(null);
    try {
      const res = await fetch(`/api/scheduling/availability/${row.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setDeleteError(body.error || `Could not delete (${res.status})`);
        return;
      }
      await load();
      onChanged();
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : 'Network error');
    }
  };

  const editRow = (row: AvailabilityDrawerRow) => {
    setEditingRowId(row.id);
    setEditStart(row.start_date);
    setEditEnd(row.end_date);
    setEditError(null);
  };

  const cancelEdit = () => {
    setEditingRowId(null);
    setEditError(null);
  };

  const saveEdit = async () => {
    if (!editingRowId) return;
    if (!editStart || !editEnd || dateRangeError(editStart, editEnd, year)) return;
    setEditSaving(true);
    setEditError(null);
    try {
      // PATCH only start_date/end_date — the hardened whitelist route
      // (validateAvailabilityPatch) only updates fields present in the body,
      // so approval_status/source/notes/reason_code are never touched. This
      // is what actually fixes the remove-then-add round-trip loss: there is
      // no re-add, so there is nothing to silently reset or drop.
      const res = await fetch(`/api/scheduling/availability/${editingRowId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ start_date: editStart, end_date: editEnd }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setEditError(body.error || `Could not save (${res.status})`);
        return;
      }
      setEditingRowId(null);
      await load();
      onChanged();
    } catch (e) {
      setEditError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setEditSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`${providerName} — ${year} dates`}
      width={560}
      footer={<Button variant="secondary" onClick={onClose}>Done</Button>}
    >
      <AvailabilityDrawerBody
        rows={rows}
        loadError={loadError}
        addError={addError}
        deleteError={deleteError}
        year={year}
        today={new Date().toISOString().slice(0, 10)}
        type={type}
        start={start}
        end={end}
        saving={saving}
        editingRowId={editingRowId}
        editStart={editStart}
        editEnd={editEnd}
        editSaving={editSaving}
        editError={editError}
        onTypeChange={setType}
        onStartChange={setStart}
        onEndChange={setEnd}
        onAdd={add}
        onRemove={remove}
        onEditRow={editRow}
        onEditStartChange={setEditStart}
        onEditEndChange={setEditEnd}
        onSaveEdit={saveEdit}
        onCancelEdit={cancelEdit}
      />
    </Modal>
  );
}
