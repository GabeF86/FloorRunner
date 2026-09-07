'use client';

// The call-taker roster with inline FTE / working-days FTE / PTO allotment
// editing. Edits go through the EXISTING provider PATCH route — all three
// columns are on PROFILE_COLUMNS and are already range-checked there
// (validateAndSplitPatch in src/lib/validation/providers.ts), so there is no
// new write path and no second validator to drift.
//
// OPTIMISTIC WITH REVERT. A cell applies immediately and rolls back with an
// error if the PATCH fails, so a rejected value can never sit on screen
// looking saved.
//
// Every string and every parse rule comes from lib/blockPrepView.ts.
//
// CONCURRENCY NOTES (reasoned through explicitly, not just asserted):
//
// 1. SAME CELL, back-to-back edits: the input is `disabled` for the entire
//    span of an in-flight PATCH (`saving`). A disabled input cannot receive
//    focus, so a chief cannot start a second edit on the same cell until the
//    first request has settled — edits to one cell are serialized by
//    construction, and a late-arriving revert can never clobber a newer
//    keystroke in the same cell.
//
// 2. DIFFERENT CELL / row reordering: `sortRosterRows` sorts by fte_value
//    descending, so committing a new FTE can move rows to new positions in
//    the table. `Table` keys its `<tr>` by array INDEX
//    (src/components/ui/Table.tsx), not by provider — so without help, React
//    would reuse a mid-flight EditableCell's component instance (and its
//    local `saving`/`text` state) for a DIFFERENT provider who resorts into
//    the same row position. That would bleed one provider's pending-save UI
//    and revert target onto another provider's cell. Fixed below by keying
//    each EditableCell with the provider id baked in (`fte-${provider_id}`
//    etc.) — a key change forces React to unmount the old instance (any
//    setState it later performs on a full round trip is then a harmless
//    no-op on an unmounted function component) and mount a fresh one seeded
//    from the row now actually at that position.
//
//    Residual, narrow case: a single cell's own failure-revert restores the
//    value captured when ITS edit began, not necessarily "whatever the
//    latest external value is" — if a second concurrent editor changed the
//    same field on the same provider between this edit's start and its
//    failure, the revert could overwrite that external change. Closing this
//    fully would need a version/timestamp on the row to know whether the
//    "current" value is still the one this edit started from. Not built —
//    this app is effectively single-editor today (auth/RLS deferred per
//    CLAUDE.md) — but flagged rather than silently assumed away.
//
// 3. STALE LOCAL STATE vs a fresh prop: `text` is a controlled input seeded
//    from `value` only once, at mount (`useState`'s initializer runs once).
//    If the parent refetches and this exact cell survives (same key, same
//    provider), a `value` prop change would otherwise never reach `text`.
//    Fixed with an effect that resyncs `text` from `value` — but only while
//    the field is NOT focused, so an unrelated background refresh can't
//    stomp a keystroke the chief is mid-typing.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Badge, Banner, Button, Card, EmptyState, Table } from '@/components/ui';
import { formatCallWeight } from '@/lib/callBurden';
import {
  allotmentText, offDaysText, parseAllotmentInput, parseFteInput,
  remainingText, sortRosterRows, type RosterRow,
} from '@/lib/blockPrepView';

type Field = 'fte_value' | 'work_days_fte' | 'pto_weeks';

const CELL_INPUT: React.CSSProperties = {
  width: 68, padding: '4px 6px', borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--border)', background: 'var(--bg-deep)',
  color: 'var(--text)', fontSize: 'var(--fs-sm)', fontFamily: 'inherit',
};

function EditableCell({
  value, field, providerId, onSaved, onError,
}: {
  value: number | null;
  field: Field;
  providerId: string;
  onSaved: (field: Field, value: number | null) => void;
  /** null clears the banner — called at the start of every commit attempt. */
  onError: (message: string | null) => void;
}) {
  const [text, setText] = useState(value == null ? '' : String(value));
  const [saving, setSaving] = useState(false);
  const [focused, setFocused] = useState(false);

  // Resync from the server value whenever it changes for a reason other than
  // this cell's own edit (a parent refetch, or — see the file-header note —
  // this same component instance getting reused for a different row after a
  // resort). Guarded on `!focused` so an in-progress keystroke is never
  // overwritten by a background update.
  useEffect(() => {
    if (!focused) setText(value == null ? '' : String(value));
  }, [value, focused]);

  // Bounds and blank policy live in blockPrepView's FTE_FIELD_BOUNDS, sourced
  // from validation/providers.ts's FTE_MIN/FTE_MAX and WORK_DAYS_FTE_*. The
  // caller names the FIELD, never the numbers — a mismatched bound/blank-policy
  // pairing is then a type error rather than a call-site mistake.
  const parse = (raw: string) =>
    field === 'pto_weeks'
      ? parseAllotmentInput(raw)
      : parseFteInput(raw, field === 'work_days_fte' ? 'workDays' : 'call');

  const commit = async () => {
    // The disabled attribute below blocks user-initiated re-entry while a
    // save is in flight, but disabling a focused input can itself trigger a
    // native blur (and therefore a second onBlur→commit call) in some
    // browsers. Guard explicitly rather than relying only on that.
    if (saving) return;
    const original = value == null ? '' : String(value);
    if (text.trim() === original) return;
    // Clear any previous cell error before attempting this one, or a single
    // transient failure leaves the banner up for the rest of the session and
    // the chief can't tell whether their latest edit saved.
    onError(null);
    const parsed = parse(text);
    if (!parsed.ok) {
      onError(parsed.error);
      setText(original);
      return;
    }
    setSaving(true);
    // Optimistic: show it now, roll back below if the PATCH is refused.
    onSaved(field, parsed.value);
    try {
      const res = await fetch(`/api/scheduling/providers/${providerId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: parsed.value }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        onError(body.error || `Save failed (${res.status})`);
        onSaved(field, value);
        setText(original);
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Network error');
      onSaved(field, value);
      setText(original);
    } finally {
      setSaving(false);
    }
  };

  return (
    <input
      style={{ ...CELL_INPUT, opacity: saving ? 0.6 : 1 }}
      value={text}
      disabled={saving}
      // The unstated-allotment affordance MUST come from allotmentText, not a
      // literal. It is the rendering of rule 1 (blank is not zero), and
      // blockPrepView tests it — a hardcoded em-dash here would let the string
      // a chief actually sees drift from the one under test while every test
      // stayed green. That is precisely the drift this module exists to stop.
      placeholder={
        field === 'pto_weeks' ? allotmentText(null)
          : field === 'work_days_fte' ? 'same'
            : ''
      }
      title={
        field === 'work_days_fte'
          ? 'Working-days FTE — the share of working days owed. Blank means the same as call FTE.'
          : field === 'pto_weeks'
            ? 'Annual PTO allotment in weeks. Blank means not stated; 0 means genuinely none.'
            : 'Call FTE — pro-rates the call obligation.'
      }
      onFocus={() => setFocused(true)}
      onChange={e => setText(e.target.value)}
      onBlur={() => {
        setFocused(false);
        void commit();
      }}
      onKeyDown={e => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        // Escape restores the last SAVED value (the current `value` prop),
        // not just an empty field — the input stays focused so a stray
        // subsequent blur's commit() sees text === original and no-ops
        // rather than firing a pointless PATCH.
        if (e.key === 'Escape') setText(value == null ? '' : String(value));
      }}
    />
  );
}

const HEADERS = [
  'Provider', 'Call FTE', 'Work-days FTE', 'PTO weeks',
  'PTO this year', 'Off days', 'Calls', '',
];

export default function RosterCard({
  rows, error, loading, onPatched, onOpenDrawer,
}: {
  rows: RosterRow[] | null;
  error: string | null;
  loading: boolean;
  /** Applies an edit to the parent's copy so the tally can refetch. */
  onPatched: (providerId: string, field: Field, value: number | null) => void;
  onOpenDrawer: (row: RosterRow) => void;
}) {
  const [cellError, setCellError] = useState<string | null>(null);

  if (error) {
    return <Card title="Call takers" pad><Banner tone="error">{error}</Banner></Card>;
  }

  // rows === null → not loaded yet (or genuinely nothing to show before the
  // first fetch); rows === [] → loaded, confirmed zero call takers. `sorted`
  // preserves that distinction: `[]` is truthy in JS, so an already-loaded
  // empty roster still produces `sorted = []`, never `undefined`.
  const sorted = rows ? sortRosterRows(rows) : undefined;

  return (
    <Card title="Call takers" pad={false}>
      {cellError && (
        <div style={{ padding: 'var(--space-3)' }}>
          <Banner tone="error" onDismiss={() => setCellError(null)}>{cellError}</Banner>
        </div>
      )}
      <Table
        headers={HEADERS}
        minWidth={980}
        // Skeleton only while we're loading AND have no rows to show yet — a
        // background refresh that already has prior data keeps showing it
        // instead of flashing a skeleton over a fully-loaded table.
        rows={loading && !sorted ? undefined : (sorted ?? []).map(r => [
          <div key="name" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <Link
              href={`/providers/${r.provider_id}`}
              style={{ fontWeight: 700, color: 'var(--text-strong)', textDecoration: 'none' }}
            >
              {r.display_name}
            </Link>
            {r.partial_call_taker && <Badge tone="warn">partial</Badge>}
          </div>,
          <EditableCell
            key={`fte-${r.provider_id}`} value={r.fte_value} field="fte_value" providerId={r.provider_id}
            onSaved={(f, v) => onPatched(r.provider_id, f, v)} onError={setCellError}
          />,
          <EditableCell
            key={`wdf-${r.provider_id}`} value={r.work_days_fte} field="work_days_fte" providerId={r.provider_id}
            onSaved={(f, v) => onPatched(r.provider_id, f, v)} onError={setCellError}
          />,
          <EditableCell
            key={`pto-${r.provider_id}`} value={r.pto_weeks} field="pto_weeks" providerId={r.provider_id}
            onSaved={(f, v) => onPatched(r.provider_id, f, v)} onError={setCellError}
          />,
          <span key="ptofig" style={{ fontSize: 'var(--fs-sm)' }}>{remainingText(r.pto)}</span>,
          <span key="off" style={{ fontSize: 'var(--fs-sm)' }}>{offDaysText(r.offDayBudget, r.offDaysUsed)}</span>,
          <span key="calls" style={{ fontWeight: 700 }}>{formatCallWeight(r.callTotal)}</span>,
          <div key="actions" style={{ textAlign: 'right' }}>
            <Button variant="ghost" size="sm" onClick={() => onOpenDrawer(r)}>
              PTO &amp; dates
            </Button>
          </div>,
        ])}
        empty={
          <EmptyState
            icon="◆"
            title="No call takers at this site"
            hint="A provider appears here when they are active, marked as a call taker, and this site is their home site."
          />
        }
      />
      <div style={{
        padding: 'var(--space-3)', fontSize: 'var(--fs-xs)',
        color: 'var(--text-muted)', lineHeight: 1.5, borderTop: '1px solid var(--border-faint)',
      }}>
        Blank work-days FTE means the same as call FTE. A blank PTO weeks cell means no allotment
        has been stated and shows {allotmentText(null)} in the tally; a typed 0 means genuinely none.
      </div>
    </Card>
  );
}
