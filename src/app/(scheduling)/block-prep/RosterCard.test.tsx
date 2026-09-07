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
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement, ReactNode } from 'react';
import RosterCard, {
  rosterCellKey, applyFrozenOrder, shouldCommit, shouldRevert, isNoopEdit,
  buildRosterTableRows, resolveDisplayRows, type RosterRowCallbacks,
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
      <RosterCard siteId="site-1" rows={null} error={null} onPatched={noop} onOpenDrawer={noop} />,
    );
    const skeletons = html.match(/fr-skeleton/g) ?? [];
    expect(skeletons.length).toBe(3 * HEADER_COUNT);
    expect(html).not.toContain('No call takers at this site');
  });
});

describe('RosterCard — no site picked', () => {
  it('shows a "Pick a site" prompt, not a permanent skeleton, when siteId is null', () => {
    const html = renderToStaticMarkup(
      <RosterCard siteId={null} rows={null} error={null} onPatched={noop} onOpenDrawer={noop} />,
    );
    expect(html).toContain('Pick a site');
    expect(html.match(/fr-skeleton/g) ?? []).toHaveLength(0);
  });
});

describe('RosterCard — empty roster', () => {
  it('renders the empty state once loaded with zero call takers, not a skeleton', () => {
    const html = renderToStaticMarkup(
      <RosterCard siteId="site-1" rows={[]} error={null} onPatched={noop} onOpenDrawer={noop} />,
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

describe('shouldCommit (Fix C: the C2 guard, extracted so mutation of the inline check is visible)', () => {
  it('refuses to commit when the user has not typed anything', () => {
    expect(shouldCommit(false)).toBe(false);
  });

  it('commits once the user has typed something', () => {
    expect(shouldCommit(true)).toBe(true);
  });
});

describe('shouldRevert (Fix C: the I1 guard, extracted so mutation of the inline check is visible)', () => {
  it('reverts when nothing has moved the field since our own optimistic write landed', () => {
    expect(shouldRevert(1.2, 1.2)).toBe(true);
  });

  it('refuses to revert when an external update already moved the field past our optimistic write', () => {
    // e.g. Task 10's post-edit refetch brought in a newer number while this
    // edit's own PATCH was still in flight — reverting here would stomp it.
    expect(shouldRevert(0.75, 1.2)).toBe(false);
  });

  it('treats two nulls (blank on both sides) as unmoved', () => {
    expect(shouldRevert(null, null)).toBe(true);
  });
});

describe('isNoopEdit (Fix D)', () => {
  it('is a no-op when the parsed value equals the current prop', () => {
    expect(isNoopEdit(1, 1)).toBe(true);
  });

  it('is not a no-op when the parsed value genuinely differs', () => {
    expect(isNoopEdit(1.2, 1)).toBe(false);
  });

  it('treats blank staying blank (both null) as a no-op', () => {
    expect(isNoopEdit(null, null)).toBe(true);
  });
});

function noopCallbacks(): RosterRowCallbacks {
  return { onPatched: () => {}, onCellError: () => {}, onBusyChange: () => {}, onOpenDrawer: () => {} };
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

describe('resolveDisplayRows (Fix B: pinning the applyFrozenOrder call site)', () => {
  const p1 = rosterRow({ provider_id: 'p1', display_name: 'One', last_name: 'One' });
  const p2 = rosterRow({ provider_id: 'p2', display_name: 'Two', last_name: 'Two' });

  it('passes through undefined when nothing has loaded', () => {
    expect(resolveDisplayRows(undefined, null)).toBeUndefined();
  });

  it('returns the live order when nothing is frozen', () => {
    expect(resolveDisplayRows([p1, p2], null)).toEqual([p1, p2]);
  });

  it('applies the frozen order over a differently-ordered live sort — this is the actual applyFrozenOrder call site', () => {
    const live = [p2, p1]; // live sort has since reordered
    expect(resolveDisplayRows(live, ['p1', 'p2'])).toEqual([p1, p2]);
  });
});
