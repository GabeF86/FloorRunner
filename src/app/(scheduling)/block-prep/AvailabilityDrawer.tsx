'use client';

// Per-provider PTO / off / no-call dates, reachable from the roster without
// visiting eleven separate provider profiles. Writes go through the SAME
// availability API (/api/scheduling/availability, /api/scheduling/
// availability/[id]) the profile's Availability tab uses — a row added here
// is indistinguishable from one added there, and there is no second write
// path to drift.
//
// Scoped to the board's year: the GET below asks for rows overlapping
// Jan 1 - Dec 31 of the selected year (`from`/`to`, an OVERLAP filter per the
// route: end_date >= from AND start_date <= to), matching exactly what
// annualTally.ts counts for the tally card. Every successful write calls
// `onChanged()` so the host (the block-prep page) bumps its refreshKey and
// the roster's PTO / off-day figures refetch — this drawer never recomputes
// those numbers itself.
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
import { AVAILABILITY_TYPE_LABELS, type AvailabilityType } from '@/lib/validation/providers';
import { isDismissedAvailability } from '@/lib/rulesEngine/shared';
import {
  ADDABLE_AVAILABILITY_TYPES, availabilityStatusBadge, availabilityTypeTone,
  isPairedIcuRow,
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
  rows, loadError, addError, year, type, start, end, saving,
  onTypeChange, onStartChange, onEndChange, onAdd, onRemove,
}: {
  rows: AvailabilityDrawerRow[] | null;
  /** Set when the GET failed — distinct from `addError` so a stale load
   *  failure can never be mistaken for a fresh add failure or vice versa. */
  loadError: string | null;
  /** Set when the most recent add (POST) failed. */
  addError: string | null;
  year: number;
  type: AvailabilityType;
  start: string;
  end: string;
  saving: boolean;
  onTypeChange: (t: AvailabilityType) => void;
  onStartChange: (v: string) => void;
  onEndChange: (v: string) => void;
  onAdd: () => void;
  onRemove: (row: AvailabilityDrawerRow) => void;
}) {
  // Client-side mirror of the route's own end_date >= start_date check
  // (validation/providers.ts / the availability routes): catch it before
  // submit rather than round-tripping to learn what a string compare already
  // tells us. The server remains the actual gate — addError below still
  // surfaces its message verbatim if this is ever bypassed.
  const rangeInvalid = start !== '' && end !== '' && end < start;

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
          value={type}
          onChange={e => onTypeChange(e.target.value as AvailabilityType)}
          style={{ ...INPUT, cursor: 'pointer' }}
        >
          {ADDABLE_AVAILABILITY_TYPES.map(t => (
            <option key={t} value={t}>{AVAILABILITY_TYPE_LABELS[t]}</option>
          ))}
        </select>
        <input type="date" value={start} onChange={e => onStartChange(e.target.value)} style={INPUT} />
        <input type="date" value={end} onChange={e => onEndChange(e.target.value)} style={INPUT} />
        <Button onClick={onAdd} disabled={saving || !start || !end || rangeInvalid}>
          {saving ? 'Adding…' : 'Add'}
        </Button>
      </div>
      {rangeInvalid && (
        <div style={{ marginBottom: 'var(--space-3)', fontSize: 'var(--fs-xs)', color: 'var(--danger)' }}>
          End date must be on or after the start date.
        </div>
      )}
      {addError && (
        <div style={{ marginBottom: 'var(--space-3)' }}><Banner tone="error">{addError}</Banner></div>
      )}

      {rows == null ? (
        <div style={{ color: 'var(--text-dim)' }}>Loading…</div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon="◷"
          title={`No dates in ${year}`}
          hint="PTO, sell-back, days off and no-call requests added here are the same entries the provider's Availability tab shows."
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          {rows.map(r => {
            const typeLabel = AVAILABILITY_TYPE_LABELS[r.availability_type as AvailabilityType] ?? r.availability_type;
            const statusBadge = availabilityStatusBadge(r.approval_status);
            // Dismissed (denied/canceled) rows no longer block anything —
            // isDismissedAvailability is the single-homed predicate every
            // engine already routes through (rulesEngine/shared.ts). Dimmed
            // at the SAME opacity Button.tsx uses for `disabled`, so "this
            // doesn't apply" reads consistently across the app. A pending row
            // is NOT dismissed and stays at full opacity — see
            // availabilityStatusBadge's header for why that distinction
            // matters (clinical invariant 2: pending still blocks).
            const dismissed = isDismissedAvailability(r);
            const lockedIcu = isPairedIcuRow(r.reason_code);
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
                <Badge tone={availabilityTypeTone(r.availability_type)}>{typeLabel}</Badge>
                <span style={{ fontSize: 'var(--fs-sm)', marginRight: 'auto' }}>
                  {r.start_date} → {r.end_date}
                </span>
                {statusBadge && <Badge tone={statusBadge.tone}>{statusBadge.label}</Badge>}
                {lockedIcu ? (
                  // ICU rows are paired (week + post-call Monday) by the
                  // profile's ICU Rotation section; a lone delete here would
                  // orphan the other half, so no Remove is offered — see
                  // isPairedIcuRow's header in blockPrepView.ts.
                  <span
                    style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}
                    title="Paired with a post-call Monday — remove it from the provider's ICU Rotation section on their profile so both sides stay in sync."
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
  const [type, setType] = useState<AvailabilityType>('pto');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch(
        `/api/scheduling/availability?provider_id=${providerId}&from=${year}-01-01&to=${year}-12-31`);
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
    if (!start || !end || end < start) return;
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
    // exactly what's being removed rather than a generic "are you sure?".
    const ok = confirm(
      `Remove ${label} covering ${row.start_date} → ${row.end_date}? This cannot be undone.`);
    if (!ok) return;
    setLoadError(null);
    try {
      const res = await fetch(`/api/scheduling/availability/${row.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setLoadError(body.error || `Could not delete (${res.status})`);
        return;
      }
      await load();
      onChanged();
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Network error');
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
