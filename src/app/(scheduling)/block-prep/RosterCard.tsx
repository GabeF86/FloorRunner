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
// WHY THE COMMIT/REVERT LOGIC LOOKS LIKE THIS (prior review rounds found
// every one of these by tracing render/interaction paths, not hypothetically
// — pruned hard, round 7 review, to the CURRENT shape rather than a history
// of every renaming since):
//
// - `rows` alone (null vs [] vs an array) drives the Table's skeleton/empty/
//   loaded states — no separate `loading` prop. A `loading &&` gate reliably
//   mis-renders the empty state on first paint, before an effect has had a
//   chance to flip it (same defect class AnnualTallyCard's header documents).
// - Dirty tracking is explicit (`dirty`, set only in `onChange`) rather than
//   comparing `text` to the `value` prop at commit time — an external
//   refetch changing `value` while a cell sits focused-but-untouched must
//   never read as "dirty" and fire a PATCH nobody asked for.
// - A failed commit reverts via `currentValueRef` (the LIVE prop, not a
//   value snapshotted at commit-start) and `revertDecision`'s check that
//   nothing else moved the field since our own optimistic write landed —
//   otherwise a newer value that arrived while our PATCH was in flight would
//   get stomped by a now-stale revert target.
// - Row order freezes (`resolveDisplayRows`) while any cell is focused or
//   saving, because Table keys `<tr>` by array index, so a resort mid-edit
//   would otherwise remount the FOCUSED cell (dropping focus) or bleed one
//   provider's mid-flight state onto another's position. The unfreeze is
//   deferred one macrotask tick so a click straight from one cell to the
//   next re-asserts "busy" before a pending unfreeze can apply. KNOWN
//   RESIDUAL: mitigates the common case but isn't provable without
//   jsdom-based interaction testing, which this repo doesn't have.
// - Enter commits WITHOUT blurring (a `.blur()` call used to exile focus to
//   document.body). A dirty cell stays FOCUSABLE during a save via
//   `readOnly`, not `disabled` — disabling a focused control blurs it too
//   (the HTML focus-fixup rule), which defeated the same fix for the one
//   case (a dirty Enter) it existed for.
// - Errors are prefixed with the provider's name and the field's label (a
//   bare "Must be 2 or less" on a card-level banner can't be attributed to
//   one of eleven rows), and `aria-label` names the row + column.
// - `commitDecision` consolidates ALL FOUR pre-flight gates (saving, dirty,
//   parse validity, whether the parsed value is actually a no-op) into ONE
//   discriminated return, and `commitPatch` (below) owns the PATCH-and-
//   settle sequence — `commit()` itself is a thin dispatcher over both, with
//   no gate or ordering logic of its own left to silently delete. Both were
//   extracted specifically because a mutation deleting an inline `if` inside
//   `commit()` is invisible to a render-only test; a mutation to
//   `commitDecision`'s/`commitPatch`'s own body is not.
//
// C1 (CRITICAL, round 5-6 review) — the one bug in this file worth its own
// section, because it was the most user-visible and the hardest to pin down.
// The post-edit refetch used to fire from `onSaved`, called OPTIMISTICALLY
// before `await fetch(PATCH)` even starts. Nothing sequenced the resulting
// GET against the PATCH it was meant to follow: the GET's profile read could
// reach the DB before the PATCH's UPDATE committed, land the PRE-EDIT value,
// and the resync effect above would silently rewrite the input back to it —
// the chief types 0.75, tabs out, and watches it snap back to 0.70, with no
// further refetch ever scheduled to self-correct. (The same bug made a
// failed edit refetch TWICE, since `onFailure` also called `onSaved`.)
//
// The fix is `onCommitted`, fired from `commitPatch`'s `finally` — i.e. only
// after `fetchFn` (and, on a non-ok response, its error-body `res.json()`)
// has fully settled, success or failure alike, exactly once per genuine
// PATCH attempt, never for a skipped/invalid/no-op commit. `onSaved` keeps
// doing the optimistic local update; `onCommitted` is the page's sole
// refetch trigger. `commitPatch` takes `fetch` itself as an INJECTED
// parameter (the same DI convention this repo uses for every DB-coupled
// module, an injected `sb` client, applied to `fetch` instead) specifically
// so this ordering — async orchestration, not DOM interaction — can be
// pinned by a plain node-environment test against a controllable promise,
// rather than resting on code inspection alone. RosterCard.test.tsx's
// `commitPatch` suite asserts `onCommitted` has NOT fired while the fetch
// (or its nested `res.json()`) is still pending; moving the call back onto
// the optimistic path reproduces C1 exactly and was verified to fail it.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Badge, Banner, Button, Card, EmptyState, Table } from '@/components/ui';
import { formatCallWeight } from '@/lib/callBurden';
import {
  allotmentText, offDaysText, parseAllotmentInput, parseFteInput,
  remainingText, rosterFooterNote, sortRosterRows, WORK_DAYS_FTE_PLACEHOLDER,
  CALL_FTE_TOOLTIP, WORK_DAYS_FTE_TOOLTIP, PTO_ALLOTMENT_TOOLTIP,
  coveredSpanLabel, NO_CALL_TAKERS_HINT,
  type ParseResult, type RosterRow,
} from '@/lib/blockPrepView';
import type { CoveredSpanInfo } from '@/lib/annualTally';

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
 *  rendered HTML — inspecting it via a snapshot of markup is not possible;
 *  `buildRosterTableRows` below is what makes the ACTUAL call site
 *  testable, by returning elements whose `.key` a test can read directly). */
export function rosterCellKey(field: Field, providerId: string): string {
  return `${field}-${providerId}`;
}

/**
 * The full pre-flight gate sequence for a commit attempt, as ONE opaque
 * decision (Fix R1, round 4 review) — modeled on Modal.tsx's
 * `modalCloseIntent`. `commit()` dispatches on the result and contains no
 * gate logic of its own; see the Fix R1 note in the file header for why
 * that matters (three separately-extracted booleans each still lived
 * behind an individually-deletable `if` inside the untestable `commit()`).
 *
 * ORDER IS LOAD-BEARING and is exactly what this function's own tests pin:
 * `saving` short-circuits before anything else (an in-flight save is never
 * re-evaluated); `dirty` is checked BEFORE a parse is even attempted (C2 —
 * a clean, untouched cell must report `'skip'`, never `'noop'`, even when
 * `text` happens to parse to the same value `value` already holds); a parse
 * failure is `'invalid'`; and only once parsing succeeds does a value equal
 * to the current one become `'noop'` (Fix D) rather than `'patch'`.
 */
// NOT exported (round 7 review, Fix 5): nothing outside this file imports it
// — commitDecision's own callers rely on TS inferring its return type, which
// needs no explicit import of the type name.
type CommitAction =
  | { kind: 'skip' }                      // saving, or not dirty
  | { kind: 'invalid'; error: string }
  | { kind: 'noop' }                      // parsed value equals the current one
  | { kind: 'patch'; value: number | null };

export function commitDecision(
  s: { saving: boolean; dirty: boolean; text: string; value: number | null },
  parse: (raw: string) => ParseResult<number | null>,
): CommitAction {
  if (s.saving) return { kind: 'skip' };
  if (!s.dirty) return { kind: 'skip' };
  const parsed = parse(s.text);
  if (!parsed.ok) return { kind: 'invalid', error: parsed.error };
  if (parsed.value === s.value) return { kind: 'noop' };
  return { kind: 'patch', value: parsed.value };
}

/**
 * The post-failure counterpart to `commitDecision` (I1, folded in per Fix
 * R1) — evaluated once a PATCH has come back rejected or errored, so it
 * can't be part of the same synchronous call: it needs the fetch's outcome
 * and the LIVE value (`currentValue`, from `currentValueRef` — the only
 * thing that survives the `await` `commitDecision`'s own inputs don't).
 * `attempted` is the value THIS edit optimistically wrote; `original` is
 * the value the edit started from. Reverting is only safe when nothing else
 * has moved the field away from our own optimistic write since it landed —
 * otherwise a newer external value already won, and stomping it with
 * `original` would be the exact bug this function exists to prevent.
 *
 * Returns a value reachable only through the `'revert'` variant rather than
 * a plain boolean deliberately: the round 3 mutation that survived —
 * collapsing the caller's `if` to an unconditional revert — no longer
 * compiles this way, because there is no `.to` to revert to on `'stay'`.
 * TypeScript only narrows `action` to `'revert'` when the condition
 * actually tests `action.kind`.
 */
// NOT exported (round 7 review, Fix 5) — same reasoning as CommitAction.
type RevertAction =
  | { kind: 'stay' }
  | { kind: 'revert'; to: number | null };

export function revertDecision(
  currentValue: number | null, attempted: number | null, original: number | null,
): RevertAction {
  return currentValue === attempted ? { kind: 'revert', to: original } : { kind: 'stay' };
}

/**
 * Minimal shape `commitPatch` needs from a resolved fetch call — satisfied
 * structurally by the real global `fetch`'s `Response` (which carries many
 * more properties `commitPatch` never touches).
 */
export interface PatchResponseLike {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

// NOT exported (round 7 review, Fix 5) — `PatchResponseLike` above stays
// exported (RosterCard.test.tsx imports it to type its fake responses), but
// nothing imports `PatchFetchFn` itself; commitPatch's own signature is
// enough for callers.
type PatchFetchFn = (input: string, init: RequestInit) => Promise<PatchResponseLike>;

/**
 * The PATCH-and-settle sequence behind a roster cell's commit, with the
 * fetch itself INJECTED (round 6 review) — this is what lets C1's ordering
 * guarantee be pinned by a plain node-environment test instead of resting on
 * inspection alone. The reviewer was right to push back on "unprovable
 * without jsdom": this is async orchestration, not DOM interaction, and
 * nothing about it needs a document — the pattern is the same dependency-
 * injection convention this repo already uses for every DB-coupled module
 * (an injected `sb` client), applied to `fetch` instead of Supabase.
 *
 * `onCommitted` is called EXACTLY ONCE, in a `finally` — strictly after
 * `fetchFn` (and, on a non-ok response, its error-body `res.json()`) has
 * fully settled, success or failure alike. THIS ordering is C1's whole fix.
 * RosterCard.test.tsx's `commitPatch` suite asserts `onCommitted` has NOT
 * fired while `fetchFn`'s own promise is still pending, and separately while
 * a non-ok response's `res.json()` promise is still pending (the nested-
 * await half of the guarantee) — moving the `onCommitted()` call back onto
 * the optimistic path (the original C1 bug) makes that suite fail.
 */
export async function commitPatch(
  fetchFn: PatchFetchFn,
  opts: {
    providerId: string;
    field: Field;
    value: number | null;
    onFailure: (message: string) => void;
    onCommitted: () => void;
  },
): Promise<void> {
  try {
    const res = await fetchFn(`/api/scheduling/providers/${opts.providerId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [opts.field]: opts.value }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      opts.onFailure(body.error || `Save failed (${res.status})`);
    }
  } catch (e) {
    opts.onFailure(e instanceof Error ? e.message : 'Network error');
  } finally {
    opts.onCommitted();
  }
}

const CELL_INPUT: React.CSSProperties = {
  width: 68, padding: '4px 6px', borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--border)', background: 'var(--bg-deep)',
  color: 'var(--text)', fontSize: 'var(--fs-sm)', fontFamily: 'inherit',
};

function EditableCell({
  value, field, providerId, displayName, onSaved, onCommitted, onError, onBusyChange,
}: {
  value: number | null;
  field: Field;
  providerId: string;
  displayName: string;
  /** Optimistic local UI update — called immediately, before the PATCH is
   *  even sent, so the cell feels instant. Must NOT be used to trigger a
   *  refetch (see the C1 note in the file header) — that is `onCommitted`'s
   *  job, fired only once the PATCH has actually settled. */
  onSaved: (field: Field, value: number | null) => void;
  /** Fires exactly once per genuine PATCH attempt, AFTER it has settled
   *  (success or failure) — see the C1 / I5 note in the file header. This is
   *  the only place the parent should trigger a post-edit refetch; doing so
   *  from `onSaved` instead re-races the refetch against the PATCH it was
   *  meant to follow. Never fired for a skipped, invalid, or no-op commit —
   *  nothing reached the server, so there is nothing new to refetch. */
  onCommitted: () => void;
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

  // A thin dispatcher over commitDecision/revertDecision — see the Fix R1
  // note in the file header for why NO gate logic lives here directly.
  const commit = async () => {
    const decision = commitDecision({ saving, dirty, text, value }, parse);
    if (decision.kind === 'skip') return;
    // A genuine attempt is being made — clear any previous error before
    // evaluating this one, or a single transient failure leaves the banner
    // up for the rest of the session and the chief can't tell whether their
    // latest edit saved.
    onError(null);
    if (decision.kind === 'invalid') {
      onError(errorPrefix + decision.error);
      setInvalid(true);
      setText(value == null ? '' : String(value));
      setDirty(false);
      return;
    }
    if (decision.kind === 'noop') {
      setDirty(false);
      return;
    }
    // decision.kind === 'patch'
    const attempted = decision.value;
    const original = value; // the value THIS edit is based on
    setSaving(true);
    setDirty(false);
    // Optimistic: show it now, roll back below if the PATCH is refused.
    onSaved(field, attempted);
    const onFailure = (message: string) => {
      onError(errorPrefix + message);
      setInvalid(true);
      const action = revertDecision(currentValueRef.current, attempted, original);
      if (action.kind === 'revert') {
        onSaved(field, action.to);
        setText(action.to == null ? '' : String(action.to));
      }
    };
    // C1: `commitPatch` (above) owns the ordering guarantee itself now —
    // `onCommitted` fires inside ITS `finally`, strictly after `fetch` (and
    // a non-ok response's `res.json()`) has settled, exactly once. That
    // ordering is pinned by RosterCard.test.tsx's `commitPatch` suite
    // against an injected, controllable `fetchFn`, independent of this
    // component ever rendering. `setSaving(false)` runs after `commitPatch`
    // resolves — its order relative to `onCommitted` (which already ran, by
    // then, inside `commitPatch`'s own `finally`) is inconsequential: they
    // are independent side effects on different components.
    await commitPatch(fetch, { providerId, field, value: attempted, onFailure, onCommitted });
    setSaving(false);
  };

  return (
    <input
      style={{
        ...CELL_INPUT,
        opacity: saving ? 0.6 : 1,
        border: invalid ? '1px solid var(--danger)' : CELL_INPUT.border,
      }}
      value={text}
      // Fix A: NOT `disabled` — disabling a focused control blurs it (the
      // HTML focus-fixup rule), sending focus to document.body with no way
      // back once `saving` clears, which defeated the I3 fix for the exact
      // case (a dirty cell) it existed for. `readOnly` blocks typing (and
      // therefore `onChange`, so this can't reopen C2) while staying
      // focusable. Reentrancy is guarded by `if (saving) return` in commit()
      // regardless — `disabled` was never load-bearing for that.
      readOnly={saving}
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

/**
 * The ONE call site that combines a live sort with the I2 freeze — pulled
 * out so a test can pin that this composition actually happens (round 3
 * review: deleting the `applyFrozenOrder` call at this site left every test
 * green, because `applyFrozenOrder` itself was already tested in isolation
 * but nothing tested that the component actually calls it).
 *
 * Fix R2 (round 4 review): the sort itself used to be computed separately
 * in the component (`const sorted = rows ? sortRosterRows(rows) : undefined`)
 * and handed in here pre-sorted — leaving `const displayRows = sorted;` at
 * the render call site a one-line, test-invisible way to silently bypass
 * `applyFrozenOrder` entirely. Taking raw `rows` and doing the full
 * `sortRosterRows` + `applyFrozenOrder` composition here shrinks the
 * component's call site to `resolveDisplayRows(rows, frozenOrder)` — a
 * single, unavoidable call with nothing left to substitute it with.
 */
export function resolveDisplayRows(
  rows: RosterRow[] | null, frozenOrder: string[] | null,
): RosterRow[] | undefined {
  if (!rows) return undefined;
  return applyFrozenOrder(sortRosterRows(rows), frozenOrder);
}

export interface RosterRowCallbacks {
  /** Applies an edit to the parent's copy for INSTANT local feedback. Does
   *  NOT trigger a refetch — see `onCommitted` below (C1: sequencing the
   *  refetch off this optimistic callback let it race the PATCH). */
  onPatched: (providerId: string, field: Field, value: number | null) => void;
  /** Fires once a PATCH has actually settled (success or failure) — the
   *  page's cue to refetch so PTO / off-day / call figures catch up. */
  onCommitted: () => void;
  onCellError: (message: string | null) => void;
  onBusyChange: (cellId: string, busy: boolean) => void;
  onOpenDrawer: (row: RosterRow) => void;
}

/**
 * Builds one Table row (a `ReactNode[]`) per roster row. Pulled out of the
 * component body so a test can call it directly and inspect the returned
 * elements' `.key` — a plain property on a React element object, readable
 * without rendering anything, even though `key` never appears in the HTML a
 * `renderToStaticMarkup` snapshot would show (round 3 review: reverting the
 * three EditableCell keys to static per-column strings — silently
 * reintroducing the cross-provider state bleed round 1 fixed — left every
 * render test green, because nothing inspected the keys themselves).
 */
export function buildRosterTableRows(displayRows: RosterRow[], cb: RosterRowCallbacks): ReactNode[][] {
  return displayRows.map(r => [
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
      onSaved={(f, v) => cb.onPatched(r.provider_id, f, v)} onCommitted={cb.onCommitted}
      onError={cb.onCellError} onBusyChange={cb.onBusyChange}
    />,
    <EditableCell
      key={rosterCellKey('work_days_fte', r.provider_id)}
      value={r.work_days_fte} field="work_days_fte" providerId={r.provider_id} displayName={r.display_name}
      onSaved={(f, v) => cb.onPatched(r.provider_id, f, v)} onCommitted={cb.onCommitted}
      onError={cb.onCellError} onBusyChange={cb.onBusyChange}
    />,
    <EditableCell
      key={rosterCellKey('pto_weeks', r.provider_id)}
      value={r.pto_weeks} field="pto_weeks" providerId={r.provider_id} displayName={r.display_name}
      onSaved={(f, v) => cb.onPatched(r.provider_id, f, v)} onCommitted={cb.onCommitted}
      onError={cb.onCellError} onBusyChange={cb.onBusyChange}
    />,
    <span key="ptofig" style={{ fontSize: 'var(--fs-sm)' }}>{remainingText(r.pto)}</span>,
    <span key="off" style={{ fontSize: 'var(--fs-sm)' }}>{offDaysText(r.offDayBudget, r.offDaysUsed)}</span>,
    <span key="calls" style={{ fontWeight: 700 }}>{formatCallWeight(r.callTotal)}</span>,
    <div key="actions" style={{ textAlign: 'right' }}>
      <Button variant="ghost" size="sm" onClick={() => cb.onOpenDrawer(r)}>
        PTO &amp; dates
      </Button>
    </div>,
  ]);
}

export default function RosterCard({
  siteId, rows, error, coveredSpan, onPatched, onCommitted, onOpenDrawer,
}: {
  siteId: string | null;
  rows: RosterRow[] | null;
  error: string | null;
  /**
   * The published-blocks span the roster's off-days-used figures were
   * counted over (Fix 1, round 7 review) — null when nothing is published
   * this year. Rendered via `coveredSpanLabel` in the footer, same as
   * AnnualTallyCard: without it, this card renders the identical
   * span-scoped-numerator / annual-denominator fraction `offDaysText`
   * produces with NO caption explaining the mismatch, which is exactly what
   * made a Paoli 0.7 FTE's "10 of 76 used" read as "66 off days left this
   * year" when 201 of those working days were never examined.
   */
  coveredSpan: CoveredSpanInfo | null;
  /** Optimistic local update only — see RosterRowCallbacks.onPatched. */
  onPatched: (providerId: string, field: Field, value: number | null) => void;
  /** Fires once per settled PATCH (success or failure) — the host's cue to
   *  refetch. See the C1 note in the file header for why this must be kept
   *  separate from `onPatched`. */
  onCommitted: () => void;
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

  useEffect(() => {
    if (anyBusy) {
      // Capture the CURRENT order the first time we go busy; while already
      // busy, keep whatever was captured — don't let a later `rows` change
      // (e.g. this very edit's own optimistic update) re-freeze on a
      // now-reordered snapshot, which would defeat the freeze entirely. Sorts
      // `rows` directly (rather than reading a shared `sorted` variable) now
      // that the live-sort step lives inside `resolveDisplayRows` (Fix R2) —
      // this is a snapshot of what order to freeze TO, a different question
      // from what to render, so it stays a direct call here.
      setFrozenOrder(prev => prev ?? (rows ? sortRosterRows(rows).map(r => r.provider_id) : null));
      return;
    }
    // Deferred by a tick (see the I2 note in the file header): a quick
    // click from one cell straight into another blurs the first before
    // focusing the second, transiently emptying the busy set in between. An
    // immediate unfreeze here could apply a pending resort in that gap,
    // right as the second cell was about to receive focus. Cancelled by the
    // cleanup below if busy is re-asserted before this fires.
    const t = setTimeout(() => setFrozenOrder(null), 0);
    return () => clearTimeout(t);
    // `rows` deliberately excluded — see the comment above.
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

  const displayRows = resolveDisplayRows(rows, frozenOrder);

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
        rows={displayRows === undefined ? undefined : buildRosterTableRows(displayRows, {
          onPatched, onCommitted, onCellError: setCellError, onBusyChange, onOpenDrawer,
        })}
        empty={
          <EmptyState
            icon="◆"
            title="No call takers at this site"
            // Fix 3 (round 7 review): shared with AnnualTallyCard's identical
            // empty state — see NO_CALL_TAKERS_HINT's own doc for why the two
            // used to say different, and one of them wrong, things.
            hint={NO_CALL_TAKERS_HINT}
          />
        }
      />
      <div style={{
        padding: 'var(--space-3)', fontSize: 'var(--fs-xs)',
        color: 'var(--text-muted)', lineHeight: 1.5, borderTop: '1px solid var(--border-faint)',
      }}>
        <div>{rosterFooterNote()}</div>
        {/* Fix 1 (round 7 review): the off-days column's honesty caveat,
            previously rendered ONLY by AnnualTallyCard even though RosterCard
            shows the identical span-scoped-numerator / annual-denominator
            fraction. Gated on `displayRows !== undefined` — only once the
            roster has genuinely loaded is there anything honest to say about
            what was counted, same gate AnnualTallyCard uses for its own
            covered-span caption. */}
        {displayRows !== undefined && (
          <div style={{ marginTop: 'var(--space-2)' }}>{coveredSpanLabel(coveredSpan)}</div>
        )}
      </div>
    </Card>
  );
}
