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
// directly with `renderToStaticMarkup`, bypassing Modal entirely.

import { useCallback, useEffect, useState } from 'react';
import { Badge, Banner, Button, EmptyState, Modal } from '@/components/ui';
import {
  AVAILABILITY_TYPE_LABELS, reasonCodeLabel, type AvailabilityType,
} from '@/lib/validation/providers';
import { isDismissedAvailability } from '@/lib/rulesEngine/shared';
import {
  ADDABLE_AVAILABILITY_TYPES, availabilityQueryUrl, availabilityStatusBadge,
  availabilityTypeHint, availabilityTypeTone, dateRangeError, icuPairsFor,
  icuRowLockInfo, liveBlockingRows, removalConfirmMessage, sellbackStandaloneNote,
  yearBounds, type AddableAvailabilityType,
} from '@/lib/blockPrepView';

/** The provider_availability columns this drawer reads and renders. */
export interface AvailabilityDrawerRow {
  id: string;
  availability_type: string;
  start_date: string;
  end_date: string;
  approval_status: string;
  reason_code: string | null;
}

const INPUT: React.CSSProperties = {
  padding: '8px 10px', borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--border)', background: 'var(--bg-deep)',
  color: 'var(--text)', fontSize: 'var(--fs-sm)', fontFamily: 'inherit',
};

/**
 * The drawer's content: no hooks, no <Modal>, a straight function of props.
 * Exported so AvailabilityDrawer.test.tsx can exercise every render path
 * (loading / empty / populated / error / pending-vs-approved) directly — see
 * the file-header testing note for why the default export cannot be tested
 * this way.
 */
export function AvailabilityDrawerBody({
  rows, loadError, addError, deleteError, year, type, start, end, saving,
  onTypeChange, onStartChange, onEndChange, onAdd, onRemove,
}: {
  rows: AvailabilityDrawerRow[] | null;
  /** Set when the GET failed. Kept distinct from `addError`/`deleteError` so
   *  a stale load failure can never be mistaken for a fresh add or delete
   *  failure, or vice versa. */
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
  /** Narrower than a general row's `AvailabilityType` (Fix 5, review
   *  2026-09-07) — the add-form can only ever hold one of the three
   *  ADDABLE_AVAILABILITY_TYPES, so a select value matching no rendered
   *  option is unrepresentable. */
  type: AddableAvailabilityType;
  start: string;
  end: string;
  saving: boolean;
  onTypeChange: (t: AddableAvailabilityType) => void;
  onStartChange: (v: string) => void;
  onEndChange: (v: string) => void;
  onAdd: () => void;
  onRemove: (row: AvailabilityDrawerRow) => void;
}) {
  const rangeError = dateRangeError(start, end, year);
  const { start: minDate, end: maxDate } = yearBounds(year);
  const sellbackHint = availabilityTypeHint(type);
  // Hoisted ONCE per render (Fix 4, review 2026-09-07) rather than re-scanned
  // inside the row loop below — icuRowLockInfo and sellbackStandaloneNote
  // both take the precomputed result so neither rescans `rows` per row.
  const icuPairs = rows ? icuPairsFor(rows) : [];
  const liveBlocking = rows ? liveBlockingRows(rows) : [];

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
            <option key={t} value={t}>{AVAILABILITY_TYPE_LABELS[t]}</option>
          ))}
        </select>
        {/* No `min` on start / no `max` on end (review 2026-09-07, second
            pass): the drawer accepts a range spanning into the neighboring
            year (see dateRangeError's overlap doc), so only the corner that
            remains a real constraint is bounded — a start after the year's
            end, or an end before the year's start, can never overlap it. */}
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
          // Fix 3 (Minor, review 2026-09-07): only name what this drawer can
          // actually ADD. An earlier edit swapped in "ICU rotation dates",
          // which is exactly the one type this drawer refuses to create.
          title={`No dates in ${year}`}
          hint="PTO, sell-back and days off added here are the same entries the provider's Availability tab shows."
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          {rows.map(r => {
            const typeLabel = AVAILABILITY_TYPE_LABELS[r.availability_type as AvailabilityType] ?? r.availability_type;
            // ICU rows carry availability_type 'blocked' — the type badge
            // alone reads as an opaque hard block. reason_code already
            // distinguishes icu_week / icu_post_call (Fix M10, review
            // 2026-09-07); reasonCodeLabel is the single home for that text,
            // shown as a SECOND badge alongside the type, same as the
            // profile's own row rendering.
            const reasonLabel = reasonCodeLabel(r.reason_code);
            const typeHint = availabilityTypeHint(r.availability_type);
            const statusBadge = availabilityStatusBadge(r.approval_status);
            const standaloneNote = sellbackStandaloneNote(liveBlocking, r);
            // Dismissed (denied/canceled) rows no longer block anything —
            // isDismissedAvailability is the single-homed predicate every
            // engine already routes through (rulesEngine/shared.ts). Dimmed
            // at the SAME opacity Button.tsx uses for `disabled`, so "this
            // doesn't apply" reads consistently across the app. A pending row
            // is NOT dismissed and stays at full opacity — see
            // availabilityStatusBadge's header for why that distinction
            // matters (clinical invariant 2: pending still blocks).
            const dismissed = isDismissedAvailability(r);
            const lockInfo = icuRowLockInfo(icuPairs, r, year);
            return (
              <div
                key={r.id}
                style={{
                  display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
                  padding: 'var(--space-2) var(--space-3)',
                  border: '1px solid var(--border-faint)', borderRadius: 'var(--radius-sm)',
                  opacity: dismissed ? 0.55 : 1,
                }}
              >
                {/* A plain <span title> rather than a Badge prop — Badge
                    (components/ui) doesn't accept a title, and the sell-back
                    explanation (Fix I4) needs a hover affordance without
                    widening that shared component's API. */}
                <span title={typeHint ?? undefined}>
                  <Badge tone={availabilityTypeTone(r.availability_type)}>{typeLabel}</Badge>
                </span>
                {reasonLabel && <Badge tone="info">{reasonLabel}</Badge>}
                <div style={{ display: 'flex', flexDirection: 'column', marginRight: 'auto' }}>
                  <span style={{ fontSize: 'var(--fs-sm)' }}>{r.start_date} → {r.end_date}</span>
                  {standaloneNote && (
                    <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                      {standaloneNote}
                    </span>
                  )}
                </div>
                {statusBadge && <Badge tone={statusBadge.tone}>{statusBadge.label}</Badge>}
                {lockInfo.locked ? (
                  // ICU rows are paired (week + post-call Monday); a lone
                  // delete here would orphan the other half, so no Remove is
                  // offered — see icuRowLockInfo's header in blockPrepView.ts.
                  <span
                    style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}
                    title={lockInfo.note ?? undefined}
                  >
                    ICU-paired
                  </span>
                ) : (
                  <Button variant="ghost" size="sm" style={{ color: 'var(--danger)' }} onClick={() => onRemove(r)}>
                    Remove
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}
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
  /** Called after any successful write (add or delete) so the host's roster
   *  and tally refetch — this drawer never recomputes those figures itself. */
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
    // Fix 2 (Important, review 2026-09-07): the year bound is now enforced
    // HERE, not just via the (non-clamping) min/max attributes — see
    // dateRangeError's header for why min/max alone are not enough.
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
    const label = AVAILABILITY_TYPE_LABELS[row.availability_type as AvailabilityType] ?? row.availability_type;
    // Destructive and possibly load-bearing for a published schedule — name
    // exactly what's being removed, including WHO, rather than a generic
    // "are you sure?" (Fix M12: this drawer's whole premise is editing eleven
    // people from one screen, so the provider's name belongs in the prompt).
    const ok = confirm(removalConfirmMessage({
      providerName, typeLabel: label, startDate: row.start_date, endDate: row.end_date,
    }));
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
        type={type}
        start={start}
        end={end}
        saving={saving}
        onTypeChange={setType}
        onStartChange={setStart}
        onEndChange={setEnd}
        onAdd={add}
        onRemove={remove}
      />
    </Modal>
  );
}
