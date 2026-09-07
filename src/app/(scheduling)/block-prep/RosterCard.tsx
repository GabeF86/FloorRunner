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
// by tracking an explicit `dirty` flag, set only in `onChange` — extracted as
// `shouldCommit` below so the guard itself is unit-testable (round 2 review:
// deleting the guard left all render tests green, since interaction can't be
// exercised without jsdom).
//
// I1 (stale revert target). A failed commit used to revert to the `value`
// captured at commit-start. If Task 10's post-edit refetch (fired after
// EVERY commit, not just this one) lands a newer number for this same field
// while this edit's own PATCH is still in flight, reverting to that stale
// start-of-edit snapshot would stomp the newer value. `currentValueRef`
// tracks the live prop on every change; `shouldRevert` below only says yes
// if nothing has moved this field since OUR OWN optimistic write landed —
// otherwise something newer already won and gets left alone. Extracted for
// the same reason as `shouldCommit` (forcing this guard to always return
// true also left every test green).
//
// I2 (resort stealing focus). Table keys `<tr>` by array index
// (components/ui/Table.tsx), not by provider, so the ONLY way to stop a
// resort from bleeding one provider's mid-flight cell state onto another's
// (see the provider-id-embedded EditableCell keys below) is to force React
// to unmount/remount whenever the provider at a given position changes.
// That fix is correct but has a cost: with several rows sharing an FTE
// value, almost any FTE edit reorders the table, and a remount at the
// FOCUSED cell's position drops focus to document.body mid-edit. Fixed by
// freezing the displayed row order while any cell is focused or saving
// (`resolveDisplayRows` below), and only resorting once the roster goes
// idle — the reorder still happens eventually, just never while someone's
// pointing at a row. The unfreeze is deferred by a macrotask tick (plain
// `setTimeout(0)`, cancelled on the next busy transition): a quick click
// from one cell straight into another blurs the first (busy count 0 → 1 → 0)
// before focusing the second, and an immediate unfreeze in that split-second
// gap could apply a pending resort right as the second cell was about to
// receive focus. A `setTimeout(0)` callback runs strictly after the current
// synchronous event dispatch (and any batched updates from it), so a focus
// event that follows synchronously — as it does for a plain click from one
// cell to the next — gets to re-assert "busy" first. KNOWN RESIDUAL: this
// mitigates the common case but is not proven, and cannot be, without
// jsdom-based interaction testing (round 2 review) — React's passive-effect
// flush timing relative to the browser's blur/focus pair isn't something
// this project's render-only test strategy can pin down.
//
// I3 (Enter exiles the chief from the table). Enter used to call `.blur()`,
// sending focus to document.body — the next Tab restarted from the top of
// the document. Enter now commits directly without blurring.
//
// Fix A (round 3 review): removing the `.blur()` call fixed Enter on a
// CLEAN cell, but not a DIRTY one — `commit()` on a dirty cell sets `saving`,
// which drove `disabled={saving}`, and disabling a focused control is itself
// what blurs it (the HTML focus-fixup rule), sending focus to document.body
// anyway, with no restoration once `saving` clears. Switched to
// `readOnly={saving}`: it blocks typing (`onChange` still can't fire
// mid-save, so this doesn't reopen C2) while leaving the control focusable,
// and reentrancy is already handled by the explicit `if (saving) return` at
// the top of `commit()` — `disabled` was never load-bearing for that.
//
// I4 / I5 (unattributable errors, no screen-reader label). A card-level
// banner used to say e.g. "Must be 2 or less" with no indication of WHICH
// provider or column, while the offending cell had already snapped back
// with no visual trace. Errors are now prefixed with the provider's name and
// the field's label, and a failed cell keeps a `--danger` border until its
// next edit. `aria-label` now names the row + column so a screen reader
// doesn't announce eleven identical "Call FTE" fields.
//
// Fix D (round 3 review, minor): `commit()` used to gate ONLY on `dirty`,
// never on whether the freshly PARSED value actually differs from the
// current one — type a character and delete it and `dirty` stays true, and
// through Task 10's post-edit refetch that turns into a full year-wide
// `/block-prep` re-fetch for nothing. Folded into `commitDecision` below as
// the `'noop'` outcome (compares the PARSED value, not raw text, so this
// can't reopen C2).
//
// Fix B (round 3 review): the two fixes above (I2's provider-id-embedded
// keys, and the frozen-order call) were both invisible to the test suite —
// reverting the keys to a static string, or deleting the frozen-order call
// entirely, left all tests green, because nothing exercised the actual
// WIRING (as opposed to the standalone helpers, which were already tested).
// `buildRosterTableRows` and `resolveDisplayRows` below exist so a test can
// call the real call sites directly and inspect the result — including
// `.key` on the returned React elements, which is a plain property on the
// element object even though it never appears in rendered HTML.
//
// Fix R1 (round 4 review): round 3 extracted C2's and I1's guards as named,
// individually-tested booleans (`shouldCommit`, `shouldRevert`, plus Fix D's
// `isNoopEdit`) — but each remained a SEPARATE `if` living inside the
// untestable, interactive `commit()`. Mutation testing proved this still
// didn't cover the WIRING, the same gap Fix B closed for the keys and the
// freeze: deleting `if (!shouldCommit(dirty)) return;`, or forcing both
// `if (shouldRevert(...))` call sites to `if (true)`, left all 29 tests
// green, because a test on the boolean helper's OWN body can't see a
// mutation of the call site that invokes it.
//
// The fix consolidates ALL FOUR pre-flight gates (saving, dirty, parse
// validity, no-op) into ONE call, `commitDecision`, returning a
// discriminated `CommitAction` — modeled on Modal.tsx's `modalCloseIntent`.
// `commit()` becomes a thin dispatcher with no gate logic of its own left to
// silently delete: the only way to reproduce "drop the dirty check" is to
// mutate `commitDecision`'s OWN body, which IS covered directly, including
// the gate ORDERING (dirty must be checked before a would-be no-op is even
// evaluated, or a clean-but-untouched cell could report "noop" instead of
// "skip" — same effect today, but a real divergence the moment either
// branch grows its own side effects).
//
// The post-failure revert decision (I1) can't fold into the SAME call —
// it needs the fetch's outcome and the live ref, neither known until after
// the `await`. `revertDecision` gets the same treatment on its own: it
// returns `{ kind: 'stay' }` or `{ kind: 'revert'; to }`, and `to` is only
// reachable by narrowing `action.kind === 'revert'` first. That makes the
// exact surviving mutation (collapsing the check to an unconditional
// revert) a COMPILE ERROR rather than a silent behavior change — TypeScript
// won't narrow `action` to the `'revert'` variant unless the condition
// actually tests `action.kind`, so `action.to` doesn't exist otherwise.
// `shouldCommit`, `shouldRevert`, and `isNoopEdit` are gone — folded in.
//
// C1 / I5 (round 5 review, CRITICAL): Task 10 used to trigger its post-edit
// refetch from `onSaved` — called OPTIMISTICALLY, before `await fetch(PATCH)`
// even starts. Nothing sequenced the resulting GET against the PATCH it was
// meant to follow: the GET's profile read could reach the DB before the
// PATCH's UPDATE committed, land the PRE-EDIT value, and the resync effect
// above would then silently rewrite the input back to it — the chief types
// 0.75, tabs out, and watches it snap back to 0.70, with no further refetch
// ever scheduled to self-correct. Comparable to the standalone helpers
// above: page.tsx observes only `onSaved`, so this defect lived at the
// call-site level, not inside any single unit-tested function. The same bug
// also explains I5: `onFailure` ALSO calls `onSaved` (to revert), so a
// rejected edit fired the page's refetch TWICE.
//
// The fix adds `onCommitted`, called ONLY from the `finally` block below —
// i.e. only after `await fetch(...)` (and any `await res.json()` reading its
// body) has fully settled, success or failure alike, and exactly once per
// PATCH attempt. `onSaved` keeps doing the optimistic local update (instant
// feel); `onCommitted` is the page's sole refetch trigger now. Because
// `onCommitted` cannot run before the `try` block's promise chain resolves —
// a JS `finally` is ordered strictly after everything in its `try`/`catch` —
// the GET it triggers can never be dispatched while the PATCH is still in
// flight. It is never called for `'skip'`, `'invalid'`, or `'noop'`, since
// none of those ever reach the server and there is nothing new to refetch.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Badge, Banner, Button, Card, EmptyState, Table } from '@/components/ui';
import { formatCallWeight } from '@/lib/callBurden';
import {
  allotmentText, offDaysText, parseAllotmentInput, parseFteInput,
  remainingText, rosterFooterNote, sortRosterRows, WORK_DAYS_FTE_PLACEHOLDER,
  CALL_FTE_TOOLTIP, WORK_DAYS_FTE_TOOLTIP, PTO_ALLOTMENT_TOOLTIP,
  type ParseResult, type RosterRow,
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
export type CommitAction =
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
export type RevertAction =
  | { kind: 'stay' }
  | { kind: 'revert'; to: number | null };

export function revertDecision(
  currentValue: number | null, attempted: number | null, original: number | null,
): RevertAction {
  return currentValue === attempted ? { kind: 'revert', to: original } : { kind: 'stay' };
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
    try {
      const res = await fetch(`/api/scheduling/providers/${providerId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: attempted }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        onFailure(body.error || `Save failed (${res.status})`);
      }
    } catch (e) {
      onFailure(e instanceof Error ? e.message : 'Network error');
    } finally {
      setSaving(false);
      // C1: fires ONCE, and only once every await above (the fetch itself,
      // plus a failed response's `res.json()`) has settled — a `finally`
      // runs strictly after its `try`/`catch`, so the page's refetch this
      // triggers can never be dispatched while the PATCH is still in flight.
      onCommitted();
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
  siteId, rows, error, onPatched, onCommitted, onOpenDrawer,
}: {
  siteId: string | null;
  rows: RosterRow[] | null;
  error: string | null;
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
