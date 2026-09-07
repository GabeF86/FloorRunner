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
// Review round 2 fixes (2026-09-06) — kept documented here because every one
// of them was a real, reachable bug found by tracing render/interaction
// paths, not a hypothetical:
//
// C1 (loading prop). `rows={loading && !sorted ? undefined : (sorted ?? [])}`
// rendered the EMPTY STATE, not a skeleton, whenever `loading` was false and
// nothing had loaded yet — exactly Task 10's own first paint (its `loading`
// starts false and only flips true after two chained fetches) and exactly
// the defect AnnualTallyCard's header documents having found and removed for
// the identical reason. There is no `loading` prop anymore: `rows` alone
// (null vs [] vs an array) already carries the distinction Table wants.
//
// C2 (phantom PATCH on an untouched cell). The old dirty check compared
// `text` against the CURRENT `value` prop at commit time — but if an
// external refetch changes `value` while a cell sits focused-but-untouched
// (the resync effect skips it because it's focused), `text` and `value`
// diverge for a reason that has nothing to do with typing, and a plain
// focus-then-blur reads as "dirty" and fires a PATCH nobody asked for. Fixed
// by tracking an explicit `dirty` flag, set only in `onChange`.
//
// I1 (stale revert target). A failed commit used to revert to the `value`
// captured at commit-start. If Task 10's post-edit refetch (fired after
// EVERY commit, not just this one) lands a newer number for this same field
// while this edit's own PATCH is still in flight, reverting to that
// stale start-of-edit snapshot would stomp the newer value. `currentValueRef`
// tracks the live prop on every change; a failure only reverts if nothing
// has moved this field since OUR OWN optimistic write landed — otherwise
// something newer already won and gets left alone.
//
// I2 (resort stealing focus). Table keys `<tr>` by array index
// (components/ui/Table.tsx), not by provider, so the ONLY way to stop a
// resort from bleeding one provider's mid-flight cell state onto another's
// (see the provider-id-embedded EditableCell keys below) is to force React
// to unmount/remount whenever the provider at a given position changes.
// That fix is correct but has a cost: with several rows sharing an FTE
// value, almost any FTE edit reorders the table, and a remount at the
// FOCUSED cell's position drops focus to document.body mid-edit. Fixed by
// freezing the displayed row order while any cell is focused or saving, and
// only resorting once the roster goes idle — the reorder still happens
// eventually, just never while someone's pointing at a row.
//
// I3 (Enter exiles the chief from the table). Enter used to call
// `.blur()`, sending focus to document.body — the next Tab restarted from
// the top of the document. Enter now commits directly without blurring.
//
// I4 / I5 (unattributable errors, no screen-reader label). A card-level
// banner used to say e.g. "Must be 2 or less" with no indication of WHICH
// provider or column, while the offending cell had already snapped back
// with no visual trace. Errors are now prefixed with the provider's name and
// the field's label, and a failed cell keeps a `--danger` border until its
// next edit. `aria-label` now names the row + column so a screen reader
// doesn't announce eleven identical "Call FTE" fields.

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Badge, Banner, Button, Card, EmptyState, Table } from '@/components/ui';
import { formatCallWeight } from '@/lib/callBurden';
import {
  allotmentText, offDaysText, parseAllotmentInput, parseFteInput,
  remainingText, rosterFooterNote, sortRosterRows, WORK_DAYS_FTE_PLACEHOLDER,
  CALL_FTE_TOOLTIP, WORK_DAYS_FTE_TOOLTIP, PTO_ALLOTMENT_TOOLTIP,
  type RosterRow,
} from '@/lib/blockPrepView';

type Field = 'fte_value' | 'work_days_fte' | 'pto_weeks';

const FIELD_LABELS: Record<Field, string> = {
  fte_value: 'Call FTE',
  work_days_fte: 'Work-days FTE',
  pto_weeks: 'PTO weeks',
};

const FIELD_TOOLTIPS: Record<Field, string> = {
  fte_value: CALL_FTE_TOOLTIP,
  work_days_fte: WORK_DAYS_FTE_TOOLTIP,
  pto_weeks: PTO_ALLOTMENT_TOOLTIP,
};

/** `field-providerId` — deterministic and unique per (row, column). Used both
 *  as the EditableCell's React `key` (so a resort remounts rather than
 *  bleeding state across providers — see the file header) and as its busy-
 *  tracking id (see `onBusyChange`). Exported so a test can pin the scheme
 *  itself without needing to render anything (`key` never appears in
 *  rendered HTML — inspecting it via a snapshot of markup is not possible). */
export function rosterCellKey(field: Field, providerId: string): string {
  return `${field}-${providerId}`;
}

const CELL_INPUT: React.CSSProperties = {
  width: 68, padding: '4px 6px', borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--border)', background: 'var(--bg-deep)',
  color: 'var(--text)', fontSize: 'var(--fs-sm)', fontFamily: 'inherit',
};

function EditableCell({
  value, field, providerId, displayName, onSaved, onError, onBusyChange,
}: {
  value: number | null;
  field: Field;
  providerId: string;
  displayName: string;
  onSaved: (field: Field, value: number | null) => void;
  /** null clears the banner — called at the start of every commit attempt. */
  onError: (message: string | null) => void;
  /** Reports focused-or-saving transitions so the parent can freeze row
   *  order while this cell is live (see the I2 note in the file header). */
  onBusyChange: (cellId: string, busy: boolean) => void;
}) {
  const cellId = rosterCellKey(field, providerId);
  const [text, setText] = useState(value == null ? '' : String(value));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [focused, setFocused] = useState(false);
  const [invalid, setInvalid] = useState(false);

  // I1: always mirrors the LATEST value prop, including across an `await` —
  // unlike a plain closure variable, which freezes at whatever `value` was
  // when the current `commit()` call began.
  const currentValueRef = useRef(value);
  useEffect(() => { currentValueRef.current = value; }, [value]);

  // C2 / stale-input fix: resync the DISPLAYED text from the server value
  // whenever it changes for a reason other than this cell's own typing (an
  // external refetch, or this exact component instance getting reused for a
  // different row after a resort) — but only while not focused, so an
  // unrelated background update can never overwrite an in-progress
  // keystroke. Clearing `dirty` here too is what makes a focus-then-blur
  // with no typing correctly read as "nothing to save" even if `value`
  // moved out from under the cell while it sat focused.
  useEffect(() => {
    if (!focused) { setText(value == null ? '' : String(value)); setDirty(false); }
  }, [value, focused]);

  useEffect(() => {
    onBusyChange(cellId, focused || saving);
    // Cleanup covers the resort-driven remount case: an instance that's
    // about to be discarded must not leave a phantom "busy" entry behind.
    return () => onBusyChange(cellId, false);
  }, [cellId, focused, saving, onBusyChange]);

  const parse = (raw: string) =>
    field === 'pto_weeks'
      ? parseAllotmentInput(raw)
      : parseFteInput(raw, field === 'work_days_fte' ? 'workDays' : 'call');

  const errorPrefix = `${displayName} · ${FIELD_LABELS[field]}: `;

  const commit = async () => {
    if (saving) return;
    // C2: the real question is "did the user type something", not "does the
    // text differ from whatever the prop currently is" — the latter can be
    // true for reasons that have nothing to do with this cell (see the
    // resync effect above), and would otherwise fire a PATCH for a value
    // nobody entered.
    if (!dirty) return;
    // Clear any previous cell error before attempting this one, or a single
    // transient failure leaves the banner up for the rest of the session and
    // the chief can't tell whether their latest edit saved.
    onError(null);
    const parsed = parse(text);
    if (!parsed.ok) {
      onError(errorPrefix + parsed.error);
      setInvalid(true);
      setText(value == null ? '' : String(value));
      setDirty(false);
      return;
    }
    const original = value; // the value THIS edit is based on
    setSaving(true);
    setDirty(false);
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
        onError(errorPrefix + (body.error || `Save failed (${res.status})`));
        setInvalid(true);
        // I1: only revert if nothing else has moved this field since our own
        // optimistic write landed. If it has (a refetch already brought in a
        // newer number), that newer number wins — reverting to `original`
        // here would stomp it with a now-stale pre-edit snapshot.
        if (currentValueRef.current === parsed.value) {
          onSaved(field, original);
          setText(original == null ? '' : String(original));
        }
      }
    } catch (e) {
      onError(errorPrefix + (e instanceof Error ? e.message : 'Network error'));
      setInvalid(true);
      if (currentValueRef.current === parsed.value) {
        onSaved(field, original);
        setText(original == null ? '' : String(original));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <input
      style={{
        ...CELL_INPUT,
        opacity: saving ? 0.6 : 1,
        border: invalid ? '1px solid var(--danger)' : CELL_INPUT.border,
      }}
      value={text}
      disabled={saving}
      aria-label={`${displayName} — ${FIELD_LABELS[field]}`}
      // The unstated-allotment affordance MUST come from allotmentText, not a
      // literal. It is the rendering of rule 1 (blank is not zero), and
      // blockPrepView tests it — a hardcoded em-dash here would let the string
      // a chief actually sees drift from the one under test while every test
      // stayed green. That is precisely the drift this module exists to stop.
      // The working-days placeholder is WORK_DAYS_FTE_PLACEHOLDER for the
      // same reason (Fix M1, review): both live in blockPrepView, which owns
      // chief-facing wording, not as literals here.
      placeholder={
        field === 'pto_weeks' ? allotmentText(null)
          : field === 'work_days_fte' ? WORK_DAYS_FTE_PLACEHOLDER
            : ''
      }
      title={FIELD_TOOLTIPS[field]}
      onFocus={() => setFocused(true)}
      onChange={e => { setText(e.target.value); setDirty(true); setInvalid(false); }}
      onBlur={() => {
        setFocused(false);
        void commit();
      }}
      onKeyDown={e => {
        // I3: commit WITHOUT blurring — the old `.blur()` sent focus to
        // document.body, so the next Tab restarted from the top of the
        // document. 11 rows × 3 columns made that punishing.
        if (e.key === 'Enter') { e.preventDefault(); void commit(); }
        // Escape restores the last SAVED value (the current `value` prop),
        // not just an empty field, and clears `dirty` so a stray subsequent
        // blur's commit() sees nothing to save rather than firing a
        // pointless PATCH.
        if (e.key === 'Escape') {
          setText(value == null ? '' : String(value));
          setDirty(false);
          setInvalid(false);
        }
      }}
    />
  );
}

const HEADERS = [
  'Provider', 'Call FTE', 'Work-days FTE', 'PTO weeks',
  'PTO this year', 'Off days', 'Calls', '',
];

/** Reorders `sorted` to match `frozenOrder` where possible (I2: keeps a row
 *  from jumping to a new position while any cell is mid-edit). A provider
 *  no longer present is silently dropped; a provider not yet in the frozen
 *  order (e.g. added mid-session) is appended in its live-sorted position —
 *  this is an interaction-preservation detail of THIS component's rendering
 *  strategy, not a chief-facing ordering rule, so it stays local rather than
 *  moving to blockPrepView. */
export function applyFrozenOrder(sorted: RosterRow[], frozenOrder: string[] | null): RosterRow[] {
  if (!frozenOrder) return sorted;
  const byId = new Map(sorted.map(r => [r.provider_id, r]));
  const kept = frozenOrder.map(id => byId.get(id)).filter((r): r is RosterRow => r != null);
  const keptIds = new Set(kept.map(r => r.provider_id));
  const added = sorted.filter(r => !keptIds.has(r.provider_id));
  return [...kept, ...added];
}

export default function RosterCard({
  siteId, rows, error, onPatched, onOpenDrawer,
}: {
  siteId: string | null;
  rows: RosterRow[] | null;
  error: string | null;
  /** Applies an edit to the parent's copy so the tally can refetch. */
  onPatched: (providerId: string, field: Field, value: number | null) => void;
  onOpenDrawer: (row: RosterRow) => void;
}) {
  const [cellError, setCellError] = useState<string | null>(null);

  // I2: which cells are currently focused or saving, keyed by rosterCellKey.
  // `anyBusy` is the only thing derived from it that triggers a re-render —
  // membership changes that don't cross the empty/non-empty boundary don't
  // need to (two cells busy at once behaves identically to one, for the
  // purpose of freezing order).
  const busyCells = useRef<Set<string>>(new Set());
  const [anyBusy, setAnyBusy] = useState(false);
  const onBusyChange = useCallback((cellId: string, busy: boolean) => {
    const set = busyCells.current;
    const hadAny = set.size > 0;
    if (busy) set.add(cellId); else set.delete(cellId);
    const hasAny = set.size > 0;
    if (hadAny !== hasAny) setAnyBusy(hasAny);
  }, []);

  const [frozenOrder, setFrozenOrder] = useState<string[] | null>(null);

  // rows === null → not loaded yet; rows === [] → loaded, confirmed zero call
  // takers. `sorted` preserves that distinction: `[]` is truthy in JS, so an
  // already-loaded empty roster still produces `sorted = []`, never
  // `undefined` — this alone is what Table's skeleton-vs-empty gate keys off,
  // with no separate `loading` flag (see the C1 note in the file header).
  const sorted = rows ? sortRosterRows(rows) : undefined;

  useEffect(() => {
    if (anyBusy) {
      // Capture the CURRENT order the first time we go busy; while already
      // busy, keep whatever was captured — don't let a later `rows` change
      // (e.g. this very edit's own optimistic update) re-freeze on a
      // now-reordered snapshot, which would defeat the freeze entirely.
      setFrozenOrder(prev => prev ?? (sorted ? sorted.map(r => r.provider_id) : null));
    } else {
      setFrozenOrder(null);
    }
    // `sorted` deliberately excluded — see the comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anyBusy]);

  if (!siteId) {
    return (
      <Card title="Call takers">
        <EmptyState
          icon="◆"
          title="Pick a site"
          hint="Call takers are tracked per site — choose one to see the roster."
        />
      </Card>
    );
  }

  if (error) {
    return <Card title="Call takers" pad><Banner tone="error">{error}</Banner></Card>;
  }

  const displayRows = sorted ? applyFrozenOrder(sorted, frozenOrder) : undefined;

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
        rows={displayRows === undefined ? undefined : displayRows.map(r => [
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
            key={rosterCellKey('fte_value', r.provider_id)}
            value={r.fte_value} field="fte_value" providerId={r.provider_id} displayName={r.display_name}
            onSaved={(f, v) => onPatched(r.provider_id, f, v)} onError={setCellError} onBusyChange={onBusyChange}
          />,
          <EditableCell
            key={rosterCellKey('work_days_fte', r.provider_id)}
            value={r.work_days_fte} field="work_days_fte" providerId={r.provider_id} displayName={r.display_name}
            onSaved={(f, v) => onPatched(r.provider_id, f, v)} onError={setCellError} onBusyChange={onBusyChange}
          />,
          <EditableCell
            key={rosterCellKey('pto_weeks', r.provider_id)}
            value={r.pto_weeks} field="pto_weeks" providerId={r.provider_id} displayName={r.display_name}
            onSaved={(f, v) => onPatched(r.provider_id, f, v)} onError={setCellError} onBusyChange={onBusyChange}
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
        {rosterFooterNote()}
      </div>
    </Card>
  );
}
