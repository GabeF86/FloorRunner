/**
 * RosterCard render-path tests (node environment, zero new deps).
 *
 * Same strategy as AnnualTallyCard.test.tsx / Modal.test.tsx: react-dom/
 * server's renderToStaticMarkup freezes the component at its first paint —
 * useEffect never fires under SSR, so this exercises RosterCard exactly as a
 * chief would see it before any interaction (no typing, no focus, no fetch
 * has resolved). RosterCard never wraps its content in <Modal>, so — unlike
 * AvailabilityDrawer — there is no hook-free body to import separately; the
 * default export renders real markup here.
 *
 * PRIORITY CASE: the first test in the first describe block is the one that
 * fails without the C1 fix — before this round, `rows={loading && !sorted
 * ? undefined : (sorted ?? [])}` rendered the EMPTY STATE (not a skeleton)
 * whenever `loading` was false and nothing had loaded yet, which is exactly
 * Task 10's own first paint (its `loading` starts false).
 */
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement, ReactNode } from 'react';
import RosterCard, {
  rosterCellKey, applyFrozenOrder, commitDecision, revertDecision, commitPatch,
  buildRosterTableRows, resolveDisplayRows,
  type RosterRowCallbacks, type PatchResponseLike,
} from './RosterCard';
import { allotmentText, WORK_DAYS_FTE_PLACEHOLDER, type RosterRow } from '@/lib/blockPrepView';

// Provider, Call FTE, Work-days FTE, PTO weeks, PTO this year, Off days,
// Calls, and the trailing blank actions column.
const HEADER_COUNT = 8;

function rosterRow(over: Partial<RosterRow> = {}): RosterRow {
  return {
    provider_id: 'p1',
    display_name: 'A. Jones',
    last_name: 'Jones',
    fte_value: 1,
    work_days_fte: null,
    pto_weeks: 4,
    call_taker: true,
    partial_call_taker: false,
    pto: { usedWeekdays: 0, soldWeekdays: 0, allotmentDays: 20, remainingDays: 20 },
    offDayBudget: { kind: 'none' },
    offDaysUsed: null,
    callCounts: [],
    callTotal: 0,
    ...over,
  };
}

const noop = () => {};

describe('RosterCard — loading (Fix C1 regression)', () => {
  it('rows=null renders a skeleton, never "No call takers at this site" — this is the case the removed `loading` prop got wrong', () => {
    const html = renderToStaticMarkup(
      <RosterCard siteId="site-1" rows={null} error={null} onPatched={noop} onCommitted={noop} onOpenDrawer={noop} />,
    );
    const skeletons = html.match(/fr-skeleton/g) ?? [];
    expect(skeletons.length).toBe(3 * HEADER_COUNT);
    expect(html).not.toContain('No call takers at this site');
  });
});

describe('RosterCard — no site picked', () => {
  it('shows a "Pick a site" prompt, not a permanent skeleton, when siteId is null', () => {
    const html = renderToStaticMarkup(
      <RosterCard siteId={null} rows={null} error={null} onPatched={noop} onCommitted={noop} onOpenDrawer={noop} />,
    );
    expect(html).toContain('Pick a site');
    expect(html.match(/fr-skeleton/g) ?? []).toHaveLength(0);
  });
});

describe('RosterCard — empty roster', () => {
  it('renders the empty state once loaded with zero call takers, not a skeleton', () => {
    const html = renderToStaticMarkup(
      <RosterCard siteId="site-1" rows={[]} error={null} onPatched={noop} onCommitted={noop} onOpenDrawer={noop} />,
    );
    expect(html).toContain('No call takers at this site');
    expect(html.match(/fr-skeleton/g) ?? []).toHaveLength(0);
  });
});

describe('RosterCard — error', () => {
  it('renders the error banner and not the table', () => {
    const html = renderToStaticMarkup(
      <RosterCard
        siteId="site-1"
        rows={[rosterRow({ display_name: 'SHOULD NOT APPEAR' })]}
        error="Roster boom"
        onPatched={noop}
        onCommitted={noop}
        onOpenDrawer={noop}
      />,
    );
    expect(html).toContain('Roster boom');
    expect(html).not.toContain('SHOULD NOT APPEAR');
    expect(html.match(/fr-skeleton/g) ?? []).toHaveLength(0);
  });
});

describe('RosterCard — a populated row\'s editable cells', () => {
  const html = renderToStaticMarkup(
    <RosterCard
      siteId="site-1"
      rows={[rosterRow({ provider_id: 'p1', pto_weeks: null, work_days_fte: null })]}
      error={null}
      onPatched={noop}
      onCommitted={noop}
      onOpenDrawer={noop}
    />,
  );

  it('the PTO weeks cell\'s blank placeholder comes from allotmentText(null), not a literal em dash', () => {
    expect(html).toContain(`placeholder="${allotmentText(null)}"`);
  });

  it('the work-days FTE cell\'s blank placeholder is WORK_DAYS_FTE_PLACEHOLDER ("same")', () => {
    expect(html).toContain(`placeholder="${WORK_DAYS_FTE_PLACEHOLDER}"`);
  });

  it('gives each editable cell a screen-reader label naming the row and the column', () => {
    expect(html).toContain('aria-label="A. Jones — Call FTE"');
    expect(html).toContain('aria-label="A. Jones — Work-days FTE"');
    expect(html).toContain('aria-label="A. Jones — PTO weeks"');
  });
});

describe('rosterCellKey', () => {
  it('embeds the provider id in the key, per column', () => {
    expect(rosterCellKey('fte_value', 'p1')).toContain('p1');
    expect(rosterCellKey('work_days_fte', 'p1')).toContain('p1');
    expect(rosterCellKey('pto_weeks', 'p1')).toContain('p1');
  });

  it('gives two different providers two different keys for the same column', () => {
    expect(rosterCellKey('fte_value', 'p1')).not.toBe(rosterCellKey('fte_value', 'p2'));
  });

  it('gives the same provider two different keys for two different columns', () => {
    expect(rosterCellKey('fte_value', 'p1')).not.toBe(rosterCellKey('pto_weeks', 'p1'));
  });

  it('is stable for the same (field, provider) pair', () => {
    expect(rosterCellKey('fte_value', 'p1')).toBe(rosterCellKey('fte_value', 'p1'));
  });
});

describe('applyFrozenOrder (Fix I2: freezing row order while a cell is busy)', () => {
  const p1 = rosterRow({ provider_id: 'p1', display_name: 'One', last_name: 'One' });
  const p2 = rosterRow({ provider_id: 'p2', display_name: 'Two', last_name: 'Two' });
  const p3 = rosterRow({ provider_id: 'p3', display_name: 'Three', last_name: 'Three' });

  it('passes the live order through unchanged when nothing is frozen', () => {
    expect(applyFrozenOrder([p1, p2, p3], null)).toEqual([p1, p2, p3]);
  });

  it('reorders to match the frozen order even when the live (just-resorted) order differs', () => {
    // Live order after some edit changed sort-relevant values — p3 has
    // moved to the front. The frozen snapshot (captured before that edit)
    // still says p1, p2, p3, and must win while frozen.
    const live = [p3, p1, p2];
    expect(applyFrozenOrder(live, ['p1', 'p2', 'p3'])).toEqual([p1, p2, p3]);
  });

  it('drops a frozen id that no longer exists in the live rows, without erroring', () => {
    const live = [p1, p3]; // p2 removed from the roster mid-edit
    expect(applyFrozenOrder(live, ['p1', 'p2', 'p3'])).toEqual([p1, p3]);
  });

  it('appends a row not present in the frozen order (e.g. added mid-session) rather than dropping it', () => {
    const live = [p1, p2, p3];
    expect(applyFrozenOrder(live, ['p1', 'p2'])).toEqual([p1, p2, p3]);
  });
});

// A minimal, fully-controlled stand-in for parseFteInput/parseAllotmentInput
// — commitDecision takes the parser as a callback, so any function matching
// its shape works here without dragging in FTE bounds irrelevant to these
// tests. 'bad' always fails; blank means null; anything else is Number(raw).
function fakeParse(raw: string) {
  if (raw === 'bad') return { ok: false as const, error: 'invalid input' };
  if (raw === '') return { ok: true as const, value: null };
  return { ok: true as const, value: Number(raw) };
}

describe('commitDecision (Fix R1: the full pre-flight gate sequence, as one call)', () => {
  it('skips while a save is already in flight, regardless of dirty or content', () => {
    // dirty is true and the text would otherwise patch — an in-flight save
    // must never be re-evaluated on top of itself.
    expect(commitDecision({ saving: true, dirty: true, text: '2', value: 1 }, fakeParse))
      .toEqual({ kind: 'skip' });
  });

  it('ORDERING: dirty is checked before a parsed no-op is even considered', () => {
    // text parses to the SAME value `value` already holds — a clean,
    // untouched cell must report 'skip', not 'noop'. If the no-op check
    // ran BEFORE the dirty check, this would (wrongly) come back 'noop'.
    // 'skip' and 'noop' both currently no-op in commit(), but they are
    // different facts (nothing was typed vs. something was typed and
    // reverted), and this is the one test that can tell them apart.
    const decision = commitDecision({ saving: false, dirty: false, text: '1', value: 1 }, fakeParse);
    expect(decision.kind).toBe('skip');
  });

  it('reports invalid with the parser\'s own error message when the text fails to parse', () => {
    expect(commitDecision({ saving: false, dirty: true, text: 'bad', value: 1 }, fakeParse))
      .toEqual({ kind: 'invalid', error: 'invalid input' });
  });

  it('reports noop when the freshly parsed value equals the current one, even though dirty is true', () => {
    // e.g. a character typed then deleted (Fix D).
    expect(commitDecision({ saving: false, dirty: true, text: '1', value: 1 }, fakeParse))
      .toEqual({ kind: 'noop' });
  });

  it('reports patch with the parsed value when it genuinely differs', () => {
    expect(commitDecision({ saving: false, dirty: true, text: '1.5', value: 1 }, fakeParse))
      .toEqual({ kind: 'patch', value: 1.5 });
  });

  it('treats blank staying blank (both null) as a noop, not a patch', () => {
    expect(commitDecision({ saving: false, dirty: true, text: '', value: null }, fakeParse))
      .toEqual({ kind: 'noop' });
  });
});

describe('revertDecision (Fix R1: the post-failure counterpart to commitDecision)', () => {
  it('reverts to the original value when nothing has moved the field since our own optimistic write landed', () => {
    expect(revertDecision(1.2, 1.2, 1)).toEqual({ kind: 'revert', to: 1 });
  });

  it('stays put when an external update already moved the field past our optimistic write', () => {
    // e.g. Task 10's post-edit refetch brought in a newer number while this
    // edit's own PATCH was still in flight — reverting here would stomp it.
    expect(revertDecision(0.75, 1.2, 1)).toEqual({ kind: 'stay' });
  });

  it('treats two nulls (blank on both sides) as unmoved, and reverts to the original', () => {
    expect(revertDecision(null, null, 0)).toEqual({ kind: 'revert', to: 0 });
  });

  it('carries no `to` on the "stay" variant — the payload only exists on "revert"', () => {
    const stayed = revertDecision(0.75, 1.2, 1);
    expect('to' in stayed).toBe(false);
  });
});

/** A promise plus its resolve/reject, so a test can control exactly when an
 *  injected `fetchFn` (or its `res.json()`) settles. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Lets a pending microtask queue drain without resolving anything — used to
 *  prove `onCommitted` has NOT fired yet while a controlled promise sits
 *  unresolved. Multiple awaits because `commitPatch` chains more than one
 *  microtask (the `fetchFn` call, then — on a non-ok response — its
 *  `res.json()` call) before it would next observe our promise settling. */
async function flushMicrotasks(times = 3) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe('commitPatch (C1 regression, CRITICAL, round 6 review) — onCommitted must not fire before the PATCH settles', () => {
  // Round 5 review accepted "this ordering can't be proven without jsdom" as
  // a residual limitation. Round 6 correctly rejected that: this is async
  // orchestration over an INJECTED fetch, not DOM interaction, and none of
  // it needs a document. These tests hand commitPatch a fetchFn whose
  // promise this test controls directly, so "onCommitted fires only after
  // the fetch settles" is asserted, not just argued from reading the code.

  it('does not call onCommitted while the fetch is pending, and calls it exactly once once the fetch resolves ok', async () => {
    const { promise, resolve } = deferred<PatchResponseLike>();
    const fetchFn = vi.fn(() => promise);
    const onFailure = vi.fn();
    const onCommitted = vi.fn();

    const settled = commitPatch(fetchFn, {
      providerId: 'p1', field: 'fte_value', value: 0.75, onFailure, onCommitted,
    });

    await flushMicrotasks();
    expect(onCommitted).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();

    resolve({ ok: true, status: 200, json: async () => ({}) });
    await settled;

    expect(onCommitted).toHaveBeenCalledTimes(1);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('does not call onCommitted while the fetch is pending, and calls onFailure + onCommitted once it rejects', async () => {
    const { promise, reject } = deferred<PatchResponseLike>();
    const fetchFn = vi.fn(() => promise);
    const onFailure = vi.fn();
    const onCommitted = vi.fn();

    const settled = commitPatch(fetchFn, {
      providerId: 'p1', field: 'fte_value', value: 0.75, onFailure, onCommitted,
    });

    await flushMicrotasks();
    expect(onCommitted).not.toHaveBeenCalled();

    reject(new Error('network down'));
    await settled;

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith('network down');
    expect(onCommitted).toHaveBeenCalledTimes(1);
  });

  it('waits for a still-pending res.json() on a non-ok response before calling onCommitted — the nested-await half of the guarantee', async () => {
    const body = deferred<{ error: string }>();
    // The fetch itself resolves promptly; its BODY does not — this is the
    // subtle half of the `finally` argument, since a naive implementation
    // could plausibly call onCommitted right after the outer `await fetchFn`
    // rather than after the inner `await res.json()` too.
    const fetchFn = vi.fn(() => Promise.resolve<PatchResponseLike>({
      ok: false, status: 422, json: () => body.promise,
    }));
    const onFailure = vi.fn();
    const onCommitted = vi.fn();

    const settled = commitPatch(fetchFn, {
      providerId: 'p1', field: 'fte_value', value: 3, onFailure, onCommitted,
    });

    await flushMicrotasks();
    expect(onCommitted).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();

    body.resolve({ error: 'Must be 2 or less' });
    await settled;

    expect(onFailure).toHaveBeenCalledWith('Must be 2 or less');
    expect(onCommitted).toHaveBeenCalledTimes(1);
  });
});

function noopCallbacks(): RosterRowCallbacks {
  return { onPatched: () => {}, onCommitted: () => {}, onCellError: () => {}, onBusyChange: () => {}, onOpenDrawer: () => {} };
}

/** React elements expose `.key` as a plain property — readable without
 *  rendering anything, even though `key` never appears in rendered HTML. */
function keyOf(node: ReactNode): React.Key | null {
  return (node as ReactElement).key;
}

describe('buildRosterTableRows (Fix B: pinning the actual key-assignment call site)', () => {
  it('embeds the row\'s provider id in all three editable cells\' keys', () => {
    const [row] = buildRosterTableRows([rosterRow({ provider_id: 'p1' })], noopCallbacks());
    // Cells: [name, fte, work-days fte, pto weeks, pto figure, off days, calls, actions].
    expect(String(keyOf(row[1]))).toContain('p1');
    expect(String(keyOf(row[2]))).toContain('p1');
    expect(String(keyOf(row[3]))).toContain('p1');
  });

  it('gives two different providers two different keys in the same column — the cross-provider-bleed regression', () => {
    const rows = buildRosterTableRows(
      [rosterRow({ provider_id: 'p1' }), rosterRow({ provider_id: 'p2' })],
      noopCallbacks(),
    );
    expect(keyOf(rows[0][1])).not.toBe(keyOf(rows[1][1]));
  });

  it('matches rosterCellKey\'s scheme exactly, not just "contains the id"', () => {
    const [row] = buildRosterTableRows([rosterRow({ provider_id: 'p7' })], noopCallbacks());
    expect(keyOf(row[1])).toBe(rosterCellKey('fte_value', 'p7'));
    expect(keyOf(row[2])).toBe(rosterCellKey('work_days_fte', 'p7'));
    expect(keyOf(row[3])).toBe(rosterCellKey('pto_weeks', 'p7'));
  });
});

describe('resolveDisplayRows (Fix B/R2: the one call site for sortRosterRows + applyFrozenOrder)', () => {
  // p2 outranks p1 on FTE, so the LIVE sort (descending FTE) puts p2 first —
  // deliberately the OPPOSITE of the frozen order below, so a test can tell
  // "sorted" apart from "sorted THEN frozen-reordered".
  const p1 = rosterRow({ provider_id: 'p1', display_name: 'One', last_name: 'One', fte_value: 0.5 });
  const p2 = rosterRow({ provider_id: 'p2', display_name: 'Two', last_name: 'Two', fte_value: 1 });

  it('passes through undefined when nothing has loaded (rows === null)', () => {
    expect(resolveDisplayRows(null, null)).toBeUndefined();
  });

  it('returns a genuine empty array, not undefined, once loaded with zero rows', () => {
    expect(resolveDisplayRows([], null)).toEqual([]);
  });

  it('sorts by FTE descending when nothing is frozen — this call site owns the sort now (Fix R2)', () => {
    // Raw input order (p1 first) must not matter — the sort decides.
    expect(resolveDisplayRows([p1, p2], null)).toEqual([p2, p1]);
  });

  it('applies the frozen order OVER what the live sort would otherwise produce', () => {
    // Absent a freeze this would sort to [p2, p1] (see above); the frozen
    // order says p1 first, and must win. This is the exact composition a
    // bypass like `const displayRows = sortRosterRows(rows);` (skipping
    // applyFrozenOrder) would get wrong.
    expect(resolveDisplayRows([p1, p2], ['p1', 'p2'])).toEqual([p1, p2]);
  });
});
