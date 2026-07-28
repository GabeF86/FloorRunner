/**
 * Block Targets tab — render smoke tests (2026-07-27).
 *
 * Same strategy the component library already uses (components/ui/Modal.test.tsx):
 * react-dom/server renderToStaticMarkup in the node environment, no jsdom and
 * no @testing-library — vitest.config.ts sets the automatic JSX runtime exactly
 * so .tsx tests compile without them. Interaction is NOT tested here; every
 * decision the panel makes lives in blockTargetsPanel.ts and is tested there.
 *
 * What these DO catch, and tsc cannot: a render-time crash, and a state whose
 * markup silently loses the thing that state exists to communicate — the
 * either-or-claimed cells, the imported-manifest warning, and the
 * over-constrained callout are each asserted present in the HTML.
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BlockTargetsTab, type BlockTargetsTabProps } from './BlockTargetsTab';
import { bucketSlotCounts, type BlockSlot, type DerivationBasis } from '@/lib/blockTargets';
import {
  applyEitherOr, applySplitTwelveHour, buildPanelRows, cellKey, rowsWithCellText,
  type PanelRow, type PoolMember,
} from '@/lib/blockTargetsPanel';
import { WEEKEND_V2_PATTERN } from '@/lib/rulesEngine/patterns/weekendV2';
import { addDays, dayOfWeekUTC } from '@/lib/rulesEngine/shared';

function blockSlots(): BlockSlot[] {
  const out: BlockSlot[] = [];
  for (let d = '2026-08-10'; d <= '2026-10-25'; d = addDays(d, 1)) {
    const dow = dayOfWeekUTC(d);
    const dt = d === '2026-09-07' ? 'major_holiday'
      : dow === 6 ? 'saturday' : dow === 0 ? 'sunday' : dow === 5 ? 'friday' : 'weekday';
    out.push({ slot_date: d, derived_day_type: dt, shift_types: { code: 'C1', category: 'call' } });
    out.push({ slot_date: d, derived_day_type: dt, shift_types: { code: 'C2', category: 'call' } });
    if (dow === 6 || dow === 0) {
      out.push({ slot_date: d, derived_day_type: dt, shift_types: { code: 'C3', category: 'call' } });
    }
  }
  return out;
}

const BASIS: DerivationBasis = {
  slotCounts: bucketSlotCounts(blockSlots()), parLevel: 11, neuro: WEEKEND_V2_PATTERN.neuroWeekend!,
};

const POOL: PoolMember[] = [
  { providerId: 'p-horan', displayName: 'Horan', profileFte: 0.5 },
  { providerId: 'p-havildar', displayName: 'Havildar', profileFte: 0.75 },
  { providerId: 'p-hussain', displayName: 'Hussain', profileFte: 0.66 },
  { providerId: 'p-ganiyu', displayName: 'Ganiyu', profileFte: 1 },
];

function render(
  rows: PanelRow[],
  cellText: Record<string, string>,
  over: Partial<BlockTargetsTabProps> = {},
): string {
  return renderToStaticMarkup(
    <BlockTargetsTab
      liveRows={rowsWithCellText(rows, cellText)}
      rows={rows}
      basis={BASIS}
      cellText={cellText}
      setCellText={() => {}}
      commitRows={() => {}}
      state="ready"
      imported={false}
      importAcknowledged={false}
      setImportAcknowledged={() => {}}
      droppedUnidentified={[]}
      hasStoredManifest={false}
      dirty={false}
      onClearAll={() => {}}
      clearRequested={false}
      manifestErrors={[]}
      {...over}
    />,
  );
}

describe('BlockTargetsTab', () => {
  it('holds the inputs while loading, and never claims clean on a failed fetch', () => {
    expect(render([], {}, { state: 'loading' })).toContain('Loading block targets');
    const failed = render([], {}, { state: 'failed' });
    expect(failed).toContain('leave them untouched');
  });

  it('says so when the pool has no call takers', () => {
    expect(render([], {})).toContain('No call-takers');
  });

  it('renders his real block: typed cells, both linkages, and the claimed cells', () => {
    let rows = buildPanelRows({ pool: POOL, storedManifest: null }).rows;
    let cellText: Record<string, string> = { [cellKey('p-horan', 'SAT_C1')]: '1' };
    const split = applySplitTwelveHour(rows, cellText, {
      selfId: 'p-horan', partnerId: 'p-havildar', bucket: 'SUN_C1',
    });
    rows = split.rows;
    cellText = split.cellText;
    rows = applyEitherOr(rows, 'p-hussain', ['FRI_C1', 'SUN_C1']);

    const html = render(rows, cellText);
    expect(html).toContain('Engine picks ONE of');
    expect(html).toContain('Splits a 12h/12h call with Havildar');
    // The either-or's buckets are rendered as CLAIMED, not as editable cells —
    // the whole point (an editable 0.66 there would double the group ceiling).
    expect(html).toContain('⇄ 0');
    // Under-coverage is stated as normal, never as an error.
    expect(html).toContain('paid pickups');
    expect(html).not.toContain('Over-constrained');
  });

  it('warns before overwriting an imported manifest', () => {
    const rows = buildPanelRows({ pool: POOL, storedManifest: null }).rows;
    const html = render(rows, {}, { imported: true, hasStoredManifest: true, dirty: true });
    expect(html).toContain('came from a workbook import');
    expect(html).toContain('let me overwrite the imported manifest');
  });

  it('calls out an over-constrained bucket', () => {
    const rows = buildPanelRows({ pool: POOL, storedManifest: null }).rows;
    const over: Record<string, string> = {};
    for (const p of POOL) over[cellKey(p.providerId, 'SAT_C1')] = '5';
    expect(render(rows, over)).toContain('Over-constrained');
  });

  it('states that saving does not regenerate', () => {
    const rows = buildPanelRows({ pool: POOL, storedManifest: null }).rows;
    expect(render(rows, {})).toContain('Run Auto-Generate');
  });
});
