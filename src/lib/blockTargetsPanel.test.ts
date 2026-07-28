// Block Targets panel — view logic (2026-07-27).
//
// The page component is not unit-testable (vitest runs environment: 'node',
// no jsdom), so everything the panel could get WRONG lives in
// blockTargetsPanel.ts and is tested here. The load-bearing tests are:
//
//   * columnPlan never hides a typed cell, a linkage-claimed cell, or an
//     over-constrained bucket — the rule that makes a 4-of-9 default column
//     set safe at all;
//   * applySplitTwelveHour writes BOTH halves of the 12h split plus the
//     linkage in one step, and the result projects through the real engine to
//     0.5 + 0.5 on the shared Sunday;
//   * buildPanelRows carries an imported manifest's prohibitions/fixed
//     assignments/preferences through untouched, so saving from a panel that
//     cannot edit them does not delete them.
//
// The block fixture is the live Paoli one, same shape blockTargets.test.ts
// uses: 2026-08-10 → 2026-10-25, par 11.
import { describe, it, expect } from 'vitest';
import {
  BUCKET_LABELS,
  LINKABLE_BUCKETS,
  PANEL_BUCKET_ORDER,
  PRIMARY_BUCKETS,
  SECONDARY_BUCKETS,
  applyEitherOr,
  applySplitTwelveHour,
  buildPanelRows,
  bucketToSlotRef,
  cellKey,
  cellTextFromRows,
  clearEitherOr,
  clearSplitTwelveHour,
  columnPlan,
  describeLinkage,
  formatTarget,
  invalidCellKeys,
  isPanelEditableLinkage,
  overridesFromCellText,
  parseTargetCell,
  rowsWithCellText,
  strandedEdits,
  summarizePanel,
  targetEditFingerprint,
  targetWritePlan,
  type PanelRow,
  type PoolMember,
} from './blockTargetsPanel';
import {
  bucketSlotCounts,
  buildBlockManifest,
  checkFeasibility,
  eitherOrLinkage,
  resolveTargets,
  type BlockSlot,
  type DerivationBasis,
} from './blockTargets';
import { BUCKET_KEYS, validateManifest, type BucketKey } from './paoliBlock/manifest';
import { projectScenario } from './rulesEngine/scenario';
import { buildScenarioCallCaps } from './rulesEngine/providerCaps';
import { WEEKEND_V2_PATTERN } from './rulesEngine/patterns/weekendV2';
import { addDays, dayOfWeekUTC } from './rulesEngine/shared';

const NEURO = WEEKEND_V2_PATTERN.neuroWeekend!;

function paoliBlockSlots(): BlockSlot[] {
  const slots: BlockSlot[] = [];
  for (let d = '2026-08-10'; d <= '2026-10-25'; d = addDays(d, 1)) {
    const dow = dayOfWeekUTC(d);
    const derived = d === '2026-09-07'
      ? 'major_holiday'
      : dow === 6 ? 'saturday' : dow === 0 ? 'sunday' : dow === 5 ? 'friday' : 'weekday';
    slots.push({ slot_date: d, derived_day_type: derived, shift_types: { code: 'C1', category: 'call' } });
    slots.push({ slot_date: d, derived_day_type: derived, shift_types: { code: 'C2', category: 'call' } });
    if (dow === 6 || dow === 0) {
      slots.push({ slot_date: d, derived_day_type: derived, shift_types: { code: 'C3', category: 'call' } });
    }
  }
  return slots;
}

const BASIS: DerivationBasis = {
  slotCounts: bucketSlotCounts(paoliBlockSlots()),
  parLevel: 11,
  neuro: NEURO,
};

// The pool he is actually scheduling, FTEs as stated.
const POOL: PoolMember[] = [
  { providerId: 'p-horan', displayName: 'Horan', profileFte: 0.5 },
  { providerId: 'p-havildar', displayName: 'Havildar', profileFte: 0.75 },
  { providerId: 'p-simon', displayName: 'Simon', profileFte: 0.75 },
  { providerId: 'p-hussain', displayName: 'Hussain', profileFte: 0.66 },
  { providerId: 'p-amusa', displayName: 'Amusa', profileFte: 1 },
  { providerId: 'p-jones', displayName: 'Jones', profileFte: 1 },
];

const freshRows = () => buildPanelRows({ pool: POOL, storedManifest: null }).rows;

// ── labels and ordering ──────────────────────────────────────────────────────

describe('column vocabulary', () => {
  it('PANEL_BUCKET_ORDER is a permutation of BUCKET_KEYS (a new bucket cannot go unrendered)', () => {
    expect([...PANEL_BUCKET_ORDER].sort()).toEqual([...BUCKET_KEYS].sort());
    expect(PANEL_BUCKET_ORDER).toHaveLength(BUCKET_KEYS.length);
  });

  it('leads with the four buckets he speaks in, then the rest', () => {
    expect(PANEL_BUCKET_ORDER.slice(0, 4)).toEqual(['FRI_C1', 'SAT_C1', 'SUN_C1', 'NEURO_FSS']);
    expect(PRIMARY_BUCKETS).toEqual(['FRI_C1', 'SAT_C1', 'SUN_C1', 'NEURO_FSS']);
    expect(SECONDARY_BUCKETS).toEqual(['MTH_C1', 'MTH_C2', 'FRI_C2', 'SAT_C2', 'SUN_C2']);
    // Together they are still all nine — nothing is unreachable.
    expect([...PRIMARY_BUCKETS, ...SECONDARY_BUCKETS].sort()).toEqual([...BUCKET_KEYS].sort());
  });

  it('labels every bucket', () => {
    for (const k of BUCKET_KEYS) expect(BUCKET_LABELS[k]).toBeTruthy();
  });

  it('formatTarget keeps fractions and kills float noise', () => {
    expect(formatTarget(0.5)).toBe('0.5');
    expect(formatTarget(4)).toBe('4');
    expect(formatTarget(2.64)).toBe('2.64');
    expect(formatTarget(2.6400000000000006)).toBe('2.64');
  });
});

describe('bucketToSlotRef', () => {
  it('turns a bucket key into the {scope, code} the member grammar validates', () => {
    expect(bucketToSlotRef('SUN_C1')).toEqual({ scope: 'SUN', code: 'C1' });
    expect(bucketToSlotRef('FRI_C2')).toEqual({ scope: 'FRI', code: 'C2' });
  });

  it('refuses MTH and NEURO rather than inventing a weekday scope for them', () => {
    // 'MTH' is a workbook column, not one of WEEKDAY_CODES — linkageMember
    // would throw, and faking a scope would silently change the constraint.
    expect(() => bucketToSlotRef('MTH_C1')).toThrow(/cannot be named by a weekday-scoped/);
    expect(() => bucketToSlotRef('NEURO_FSS')).toThrow(/cannot be named by a weekday-scoped/);
    expect(LINKABLE_BUCKETS).toEqual(['FRI_C1', 'FRI_C2', 'SAT_C1', 'SAT_C2', 'SUN_C1', 'SUN_C2']);
  });

  it('every linkable bucket really does build a member (no throw)', () => {
    for (const b of LINKABLE_BUCKETS) {
      expect(() => eitherOrLinkage(
        [bucketToSlotRef(b), bucketToSlotRef(b === 'SAT_C1' ? 'SUN_C1' : 'SAT_C1')],
        { source: 's' },
      )).not.toThrow();
    }
  });
});

// ── cell text ────────────────────────────────────────────────────────────────

describe('parseTargetCell (blank means derived)', () => {
  it('blank and whitespace CLEAR the cell back to derived', () => {
    expect(parseTargetCell('')).toEqual({ ok: true, value: null });
    expect(parseTargetCell('   ')).toEqual({ ok: true, value: null });
  });

  it('a typed zero is a real override, not a blank', () => {
    expect(parseTargetCell('0')).toEqual({ ok: true, value: 0 });
  });

  it('accepts the fractions the split and the FTE formula produce', () => {
    expect(parseTargetCell('0.5')).toEqual({ ok: true, value: 0.5 });
    expect(parseTargetCell(' 2.64 ')).toEqual({ ok: true, value: 2.64 });
  });

  it('rejects junk, negatives and infinities instead of coercing them', () => {
    expect(parseTargetCell('abc').ok).toBe(false);
    expect(parseTargetCell('1/2').ok).toBe(false);
    expect(parseTargetCell('-1')).toEqual({ ok: false, error: 'a target cannot be negative' });
    expect(parseTargetCell('Infinity').ok).toBe(false);
  });
});

describe('cellText ↔ overrides', () => {
  it('only parseable non-blank cells become overrides', () => {
    const text = {
      [cellKey('p1', 'SAT_C1')]: '1',
      [cellKey('p1', 'SUN_C1')]: '0.5',
      [cellKey('p1', 'FRI_C1')]: '',
      [cellKey('p1', 'MTH_C1')]: 'oops',
      [cellKey('p2', 'SAT_C1')]: '2',
    };
    expect(overridesFromCellText('p1', text)).toEqual({ SAT_C1: 1, SUN_C1: 0.5 });
    expect(overridesFromCellText('p2', text)).toEqual({ SAT_C1: 2 });
    expect(invalidCellKeys(text)).toEqual([cellKey('p1', 'MTH_C1')]);
  });

  it('a typed 0 survives the round trip as an override (not dropped as falsy)', () => {
    const text = { [cellKey('p1', 'FRI_C2')]: '0' };
    expect(overridesFromCellText('p1', text)).toEqual({ FRI_C2: 0 });
    expect(resolveTargets(
      { providerId: 'p1', displayName: 'X', fte: 1, overrides: overridesFromCellText('p1', text) },
      BASIS,
    ).overridden).toEqual(['FRI_C2']);
  });

  it('a typed ZERO survives the whole save → reopen → seed round trip', () => {
    // Half of "blank means derived" is that a typed 0 is NOT blank. A
    // truthiness check anywhere on this path (cellTextFromRows' guard most of
    // all) would silently turn every stated zero back into a derived cell on
    // the next open, with no other test failing.
    const stored = buildBlockManifest({
      providers: [{
        providerId: 'p-horan', displayName: 'Horan', fte: 0.5,
        overrides: { FRI_C2: 0, SAT_C1: 1 },
      }],
      basis: BASIS,
    });
    expect(stored.providers[0].targets.FRI_C2).toBe(0);
    const reopened = buildPanelRows({ pool: POOL, storedManifest: stored });
    const horan = reopened.rows.find(r => r.providerId === 'p-horan')!;
    expect(horan.overrides).toEqual({ FRI_C2: 0, SAT_C1: 1 });
    const text = cellTextFromRows(reopened.rows);
    expect(text[cellKey('p-horan', 'FRI_C2')]).toBe('0');
    // …and it is still an OVERRIDE, not a blank that re-derives to 0.5.
    const live = rowsWithCellText(reopened.rows, text);
    const res = resolveTargets(live.find(r => r.providerId === 'p-horan')!, BASIS);
    expect(res.targets.FRI_C2).toBe(0);
    expect(res.overridden).toContain('FRI_C2');
  });

  it('cellTextFromRows seeds only the typed cells, so everything else re-derives', () => {
    const rows = freshRows().map(r =>
      r.providerId === 'p-horan' ? { ...r, overrides: { SAT_C1: 1, SUN_C1: 0.5 } } : r);
    const text = cellTextFromRows(rows);
    expect(text).toEqual({
      [cellKey('p-horan', 'SAT_C1')]: '1',
      [cellKey('p-horan', 'SUN_C1')]: '0.5',
    });
  });

  it('rowsWithCellText replaces overrides wholesale — a cleared cell really clears', () => {
    const rows = freshRows().map(r =>
      r.providerId === 'p-horan' ? { ...r, overrides: { SAT_C1: 1, MTH_C1: 9 } } : r);
    const next = rowsWithCellText(rows, { [cellKey('p-horan', 'SAT_C1')]: '1' });
    const horan = next.find(r => r.providerId === 'p-horan')!;
    expect(horan.overrides).toEqual({ SAT_C1: 1 });
    // MTH_C1 is gone from the overrides, so it derives again: 44 ÷ 11 × 0.5.
    expect(resolveTargets(horan, BASIS).targets.MTH_C1).toBe(2);
  });
});

// ── rows ─────────────────────────────────────────────────────────────────────

describe('buildPanelRows', () => {
  it('a virgin schedule gives one blank row per pool member, in pool order', () => {
    const res = buildPanelRows({ pool: POOL, storedManifest: null });
    expect(res.hasStoredManifest).toBe(false);
    expect(res.imported).toBe(false);
    expect(res.rows.map(r => r.displayName)).toEqual(
      ['Horan', 'Havildar', 'Simon', 'Hussain', 'Amusa', 'Jones']);
    expect(res.rows.every(r => r.inPool)).toBe(true);
    expect(res.rows.every(r => Object.keys(r.overrides ?? {}).length === 0)).toBe(true);
    expect(res.rows.find(r => r.providerId === 'p-horan')!.fte).toBe(0.5);
  });

  it('re-opens a PANEL-authored manifest with the typed cells still typed', () => {
    const manifest = buildBlockManifest({
      providers: [
        { providerId: 'p-horan', displayName: 'Horan', fte: 0.5, overrides: { SAT_C1: 1 } },
        { providerId: 'p-amusa', displayName: 'Amusa', fte: 1 },
      ],
      basis: BASIS,
    });
    const res = buildPanelRows({ pool: POOL, storedManifest: manifest });
    expect(res.imported).toBe(false);
    expect(res.hasStoredManifest).toBe(true);
    expect(res.rows.find(r => r.providerId === 'p-horan')!.overrides).toEqual({ SAT_C1: 1 });
    // Amusa was saved with every cell derived — it must come back BLANK, not
    // frozen at the numbers that happened to be stored.
    expect(res.rows.find(r => r.providerId === 'p-amusa')!.overrides).toEqual({});
  });

  it('flags an IMPORTED manifest, and treats its stated numbers as authored', () => {
    const imported = {
      ...buildBlockManifest({
        providers: [{ providerId: 'p-horan', displayName: 'Horan', fte: 0.5 }],
        basis: BASIS,
      }),
      source: { workbook: 'Paoli block 2026.xlsx', sheetName: 'Aug', shape: 'full' as const },
      blockTargets: undefined,
    };
    const res = buildPanelRows({ pool: POOL, storedManifest: imported });
    expect(res.imported).toBe(true);
    // Every stated cell reads as typed — a workbook cell is an author's number.
    expect(res.rows.find(r => r.providerId === 'p-horan')!.overrides!.MTH_C1).toBe(2);
  });

  it('carries an imported row’s prohibitions / fixed assignments / preferences through UNTOUCHED', () => {
    // The panel has no editor for these. Dropping them on save would delete a
    // workbook's clinical constraints without a word.
    const imported = {
      ...buildBlockManifest({
        providers: [{
          providerId: 'p-horan', displayName: 'Horan', fte: 0.5,
          prohibitions: [{ dates: ['2026-09-12'], callCodes: 'all' as const, source: 'workbook' }],
          fixedAssignments: [{ date: '2026-09-05', code: 'C1' as const, source: 'workbook' }],
          preferences: [{ kind: 'weekday' as const, weekday: 'FRI' as const, source: 'workbook' }],
        }],
        basis: BASIS,
      }),
      source: { workbook: 'Paoli block 2026.xlsx', sheetName: 'Aug', shape: 'full' as const },
      blockTargets: undefined,
    };
    const row = buildPanelRows({ pool: POOL, storedManifest: imported })
      .rows.find(r => r.providerId === 'p-horan')!;
    expect(row.prohibitions).toEqual([{ dates: ['2026-09-12'], callCodes: 'all', source: 'workbook' }]);
    expect(row.fixedAssignments).toEqual([{ date: '2026-09-05', code: 'C1', source: 'workbook' }]);
    expect(row.preferences).toEqual([{ kind: 'weekday', weekday: 'FRI', source: 'workbook' }]);

    // And they SURVIVE a save: rebuild the manifest from the rows.
    const rebuilt = buildBlockManifest({ providers: [row], basis: BASIS });
    expect(rebuilt.providers[0].prohibitions).toHaveLength(1);
    expect(rebuilt.providers[0].fixedAssignments).toHaveLength(1);
    expect(rebuilt.providers[0].preferences).toHaveLength(1);
  });

  it('keeps an IMPORTED scenarioFte that disagrees with the profile, and flags it', () => {
    const imported = {
      ...buildBlockManifest({
        providers: [{ providerId: 'p-hussain', displayName: 'Hussain', fte: 0.66 }],
        basis: BASIS,
      }),
      source: { workbook: 'wb.xlsx', sheetName: 'Aug', shape: 'full' as const },
      blockTargets: undefined,
    };
    const pool: PoolMember[] = [{ providerId: 'p-hussain', displayName: 'Hussain', profileFte: 0.75 }];
    const row = buildPanelRows({ pool, storedManifest: imported }).rows[0];
    expect(row.fte).toBe(0.66);          // the authored workbook number
    expect(row.profileFte).toBe(0.75);
    expect(row.fteFromManifest).toBe(true);
  });

  it('a PANEL-authored FTE follows the live profile instead (it was only ever a copy)', () => {
    const manifest = buildBlockManifest({
      providers: [{ providerId: 'p-hussain', displayName: 'Hussain', fte: 0.66 }],
      basis: BASIS,
    });
    const pool: PoolMember[] = [{ providerId: 'p-hussain', displayName: 'Hussain', profileFte: 0.75 }];
    const row = buildPanelRows({ pool, storedManifest: manifest }).rows[0];
    expect(row.fte).toBe(0.75);
    expect(row.fteFromManifest).toBe(false);
  });

  it('keeps stored rows for providers no longer in the pool, marked inert', () => {
    const manifest = buildBlockManifest({
      providers: [
        { providerId: 'p-horan', displayName: 'Horan', fte: 0.5, overrides: { SAT_C1: 1 } },
        { providerId: 'p-gone', displayName: 'Gone', fte: 1, overrides: { SUN_C1: 1 } },
      ],
      basis: BASIS,
    });
    const res = buildPanelRows({ pool: POOL, storedManifest: manifest });
    const gone = res.rows.find(r => r.providerId === 'p-gone')!;
    expect(gone.inPool).toBe(false);
    expect(gone.profileFte).toBeNull();
    expect(gone.overrides).toEqual({ SUN_C1: 1 });
    // …and last, after every pool row.
    expect(res.rows[res.rows.length - 1].providerId).toBe('p-gone');
  });

  it('reports (rather than silently round-trips) a stored row with no provider id', () => {
    const manifest = buildBlockManifest({
      providers: [{ providerId: '', displayName: 'Ghost', fte: 1 }],
      basis: BASIS,
    });
    const res = buildPanelRows({ pool: POOL, storedManifest: manifest });
    expect(res.droppedUnidentified).toEqual(['Ghost']);
    expect(res.rows.some(r => r.displayName === 'Ghost')).toBe(false);
  });
});

// ── column plan: the rule that makes hiding columns safe ─────────────────────

describe('columnPlan', () => {
  const noRows: never[] = [];

  it('collapsed shows exactly the four weekend columns', () => {
    const plan = columnPlan({ expanded: false, resolved: noRows });
    expect(plan.visible).toEqual(['FRI_C1', 'SAT_C1', 'SUN_C1', 'NEURO_FSS']);
    expect(plan.hidden).toEqual(['MTH_C1', 'MTH_C2', 'FRI_C2', 'SAT_C2', 'SUN_C2']);
    expect(plan.forced).toEqual({});
  });

  it('expanded shows all nine, weekend first', () => {
    const plan = columnPlan({ expanded: true, resolved: noRows });
    expect(plan.visible).toEqual([...PANEL_BUCKET_ORDER]);
    expect(plan.hidden).toEqual([]);
  });

  it('NEVER hides a column holding a typed value', () => {
    const plan = columnPlan({
      expanded: false,
      resolved: [{ overridden: ['MTH_C2'], eitherOrCovered: [] }],
    });
    expect(plan.visible).toContain('MTH_C2');
    expect(plan.forced.MTH_C2).toBe('typed');
    expect(plan.hidden).not.toContain('MTH_C2');
  });

  it('NEVER hides a column an either-or claims', () => {
    const plan = columnPlan({
      expanded: false,
      resolved: [{ overridden: [], eitherOrCovered: ['SAT_C2'] }],
    });
    expect(plan.visible).toContain('SAT_C2');
    expect(plan.forced.SAT_C2).toBe('linked');
  });

  it('NEVER hides an over-constrained bucket', () => {
    const plan = columnPlan({ expanded: false, resolved: noRows, overConstrained: ['SUN_C2'] });
    expect(plan.visible).toContain('SUN_C2');
    expect(plan.forced.SUN_C2).toBe('over');
  });

  it('a primary column is never listed as forced (it was already visible)', () => {
    const plan = columnPlan({
      expanded: false,
      resolved: [{ overridden: ['SAT_C1'], eitherOrCovered: ['SUN_C1'] }],
      overConstrained: ['FRI_C1'],
    });
    expect(plan.forced).toEqual({});
    expect(plan.visible).toEqual(['FRI_C1', 'SAT_C1', 'SUN_C1', 'NEURO_FSS']);
  });

  it('the most actionable reason wins when several apply', () => {
    const plan = columnPlan({
      expanded: false,
      resolved: [{ overridden: ['MTH_C1'], eitherOrCovered: ['MTH_C1'] }],
      overConstrained: ['MTH_C1'],
    });
    expect(plan.forced.MTH_C1).toBe('typed');
  });

  it('visible is always in PANEL_BUCKET_ORDER, forced columns included', () => {
    const plan = columnPlan({
      expanded: false,
      resolved: [{ overridden: ['MTH_C1', 'SUN_C2'], eitherOrCovered: [] }],
    });
    expect(plan.visible).toEqual(['FRI_C1', 'SAT_C1', 'SUN_C1', 'NEURO_FSS', 'MTH_C1', 'SUN_C2']);
  });

  it('the real collapsed panel for his block hides nothing that matters', () => {
    // His four overridden rows, collapsed. Every typed cell here is a weekend
    // C1 — all PRIMARY — so this alone cannot exercise the force-show rule:
    // asserted explicitly so the weak half of this test cannot be mistaken for
    // the strong one.
    const rows = statedRows();
    const resolved = rows.map(r => resolveTargets(r, BASIS));
    const plan = columnPlan({ expanded: false, resolved });
    const typed = new Set(resolved.flatMap(r => r.overridden));
    const claimed = new Set(resolved.flatMap(r => r.eitherOrCovered));
    for (const b of [...typed, ...claimed]) expect(plan.visible).toContain(b);
    expect(plan.forced).toEqual({}); // nothing secondary is in play yet

    // Now the same panel with ONE secondary-bucket edit — the case the rule
    // exists for. Move Hussain's either-or onto the Saturday/Sunday SECOND
    // calls and give Simon a M–Th C2 override.
    const withSecondary = rowsWithCellText(
      applyEitherOr(statedState().rows, 'p-hussain', ['SAT_C2', 'SUN_C2']),
      { ...statedState().cellText, [cellKey('p-simon', 'MTH_C2')]: '2' },
    );
    const plan2 = columnPlan({
      expanded: false,
      resolved: withSecondary.map(r => resolveTargets(r, BASIS)),
    });
    expect(plan2.forced).toEqual({ MTH_C2: 'typed', SAT_C2: 'linked', SUN_C2: 'linked' });
    for (const b of ['MTH_C2', 'SAT_C2', 'SUN_C2'] as const) {
      expect(plan2.visible).toContain(b);
      expect(plan2.hidden).not.toContain(b);
    }
  });
});

// ── linkages ─────────────────────────────────────────────────────────────────

describe('either-or (Hussain: a Friday OR a Sunday call, engine’s choice)', () => {
  it('builds the linkage from bucket chips — no string grammar in the caller', () => {
    const rows = applyEitherOr(freshRows(), 'p-hussain', ['FRI_C1', 'SUN_C1']);
    const link = rows.find(r => r.providerId === 'p-hussain')!.linkages!.find(l => l.kind === 'either-or')!;
    expect(link.members).toEqual(['FRI:C1', 'SUN:C1']);
    expect(link.source).toBe("Hussain: one of Fri C1 or Sun C1 — engine's choice (Block Targets panel)");
  });

  it('zeroes the covered cells so the group ceiling admits exactly one call', () => {
    const rows = applyEitherOr(freshRows(), 'p-hussain', ['FRI_C1', 'SUN_C1']);
    const resolved = resolveTargets(rows.find(r => r.providerId === 'p-hussain')!, BASIS);
    expect(resolved.targets.FRI_C1).toBe(0);
    expect(resolved.targets.SUN_C1).toBe(0);
    expect(resolved.eitherOrCovered).toEqual(['FRI_C1', 'SUN_C1']);
    expect(resolved.warnings).toEqual([]);
  });

  it('replaces rather than stacks a second either-or on the same row', () => {
    let rows = applyEitherOr(freshRows(), 'p-hussain', ['FRI_C1', 'SUN_C1']);
    rows = applyEitherOr(rows, 'p-hussain', ['SAT_C2', 'SUN_C2']);
    const links = rows.find(r => r.providerId === 'p-hussain')!.linkages!;
    expect(links.filter(l => l.kind === 'either-or')).toHaveLength(1);
    // BY KIND, not by position — a row can carry a split-12h alongside.
    expect(links.find(l => l.kind === 'either-or')!.members).toEqual(['SAT:C2', 'SUN:C2']);
  });

  it('clearing gives the cells back to the formula', () => {
    const linked = applyEitherOr(freshRows(), 'p-hussain', ['FRI_C1', 'SUN_C1']);
    const cleared = clearEitherOr(linked, 'p-hussain');
    const row = cleared.find(r => r.providerId === 'p-hussain')!;
    expect(row.linkages).toEqual([]);
    const resolved = resolveTargets(row, BASIS);
    expect(resolved.targets.FRI_C1).toBe(0.66); // derived again
    expect(resolved.eitherOrCovered).toEqual([]);
  });

  it('refuses a one-sided either-or and an unknown provider', () => {
    expect(() => applyEitherOr(freshRows(), 'p-hussain', ['FRI_C1'])).toThrow(/at least two/);
    expect(() => applyEitherOr(freshRows(), 'nobody', ['FRI_C1', 'SUN_C1'])).toThrow(/no panel row/);
  });

  it('touches nobody else', () => {
    const rows = applyEitherOr(freshRows(), 'p-hussain', ['FRI_C1', 'SUN_C1']);
    for (const r of rows) {
      if (r.providerId !== 'p-hussain') expect(r.linkages).toEqual([]);
    }
  });
});

describe('split-12h (Horan takes 12 hrs of a Sunday C1, Havildar the other 12)', () => {
  it('writes the linkage AND both halves in one step', () => {
    const { rows, cellText } = applySplitTwelveHour(freshRows(), {}, {
      selfId: 'p-horan', partnerId: 'p-havildar', bucket: 'SUN_C1',
    });
    const link = rows.find(r => r.providerId === 'p-horan')!.linkages!
      .find(l => l.kind === 'split-12h')!;
    expect(link.members).toEqual(['Horan', 'Havildar']);
    expect(link.details).toBe('Sun C1 12/12 split');
    expect(link.source).toBe('Horan and Havildar split one Sun C1 12/12 (Block Targets panel)');
    // Both halves — the partner does NOT keep deriving a whole Sunday.
    expect(cellText[cellKey('p-horan', 'SUN_C1')]).toBe('0.5');
    expect(cellText[cellKey('p-havildar', 'SUN_C1')]).toBe('0.5');
  });

  it('the partner’s 0.5 really replaces their derived 0.75', () => {
    const { rows, cellText } = applySplitTwelveHour(freshRows(), {}, {
      selfId: 'p-horan', partnerId: 'p-havildar', bucket: 'SUN_C1',
    });
    const live = rowsWithCellText(rows, cellText);
    const hav = live.find(r => r.providerId === 'p-havildar')!;
    expect(resolveTargets(hav, BASIS).targets.SUN_C1).toBe(0.5);
    // Guard on the guard: without the split the same row derives 0.75.
    expect(resolveTargets(freshRows().find(r => r.providerId === 'p-havildar')!, BASIS)
      .targets.SUN_C1).toBe(0.75);
  });

  it('only one split linkage per row, and only on the initiator', () => {
    let state = applySplitTwelveHour(freshRows(), {}, {
      selfId: 'p-horan', partnerId: 'p-havildar', bucket: 'SUN_C1',
    });
    state = applySplitTwelveHour(state.rows, state.cellText, {
      selfId: 'p-horan', partnerId: 'p-simon', bucket: 'SAT_C1',
    });
    const horan = state.rows.find(r => r.providerId === 'p-horan')!;
    expect(horan.linkages!.filter(l => l.kind === 'split-12h')).toHaveLength(1);
    expect(horan.linkages![0].members).toEqual(['Horan', 'Simon']);
    expect(state.rows.find(r => r.providerId === 'p-havildar')!.linkages).toEqual([]);
  });

  it('refuses splitting with oneself, an unknown partner, or an unnameable bucket', () => {
    const rows = freshRows();
    expect(() => applySplitTwelveHour(rows, {}, {
      selfId: 'p-horan', partnerId: 'p-horan', bucket: 'SUN_C1',
    })).toThrow(/with oneself/);
    expect(() => applySplitTwelveHour(rows, {}, {
      selfId: 'p-horan', partnerId: 'nobody', bucket: 'SUN_C1',
    })).toThrow(/no panel row/);
    expect(() => applySplitTwelveHour(rows, {}, {
      selfId: 'p-horan', partnerId: 'p-havildar', bucket: 'MTH_C1',
    })).toThrow(/cannot be named by a weekday-scoped/);
  });

  it('clearing removes only the linkage and LEAVES the typed halves alone', () => {
    const { rows, cellText } = applySplitTwelveHour(freshRows(), {}, {
      selfId: 'p-horan', partnerId: 'p-havildar', bucket: 'SUN_C1',
    });
    const cleared = clearSplitTwelveHour(rows, 'p-horan');
    expect(cleared.find(r => r.providerId === 'p-horan')!.linkages).toEqual([]);
    expect(cellText[cellKey('p-horan', 'SUN_C1')]).toBe('0.5'); // his to clear, not ours
  });
});

describe('describeLinkage', () => {
  it('reads back every kind in plain English — including kinds only the importer writes', () => {
    expect(describeLinkage({ kind: 'either-or', members: ['FRI:C1', 'SUN:C1'], source: 's' }))
      .toBe('Engine picks ONE of: Fri C1 or Sun C1');
    expect(describeLinkage({
      kind: 'split-12h', members: ['Horan', 'Havildar'], details: 'Sun C1 12/12 split', source: 's',
    })).toBe('Splits a 12h/12h call with Havildar — Sun C1 12/12 split');
    expect(describeLinkage({ kind: 'same-weekend', members: ['SAT:C1', 'SUN:C2'], source: 's' }))
      .toBe('Same weekend: Sat C1 + Sun C2');
    expect(describeLinkage({ kind: 'same-date', members: ['FRI:C2', 'FRI:NEURO'], source: 's' }))
      .toBe('Same day: Fri C2 + Fri NEURO');
  });

  it('marks which linkages the panel can actually edit', () => {
    expect(isPanelEditableLinkage({ kind: 'either-or', members: ['FRI:C1', 'SUN:C1'], source: 's' })).toBe(true);
    expect(isPanelEditableLinkage({ kind: 'split-12h', members: ['A', 'B'], source: 's' })).toBe(true);
    expect(isPanelEditableLinkage({ kind: 'same-weekend', members: ['SAT:C1'], source: 's' })).toBe(false);
  });
});

// ── his block, end to end through the real engine ────────────────────────────

/** Exactly the panel state his words describe, built the way the UI builds it. */
function statedState(): { rows: PanelRow[]; cellText: Record<string, string> } {
  let rows = freshRows();
  let cellText: Record<string, string> = {};

  // Horan: 1 Saturday C1.
  cellText[cellKey('p-horan', 'SAT_C1')] = '1';
  // Horan + Havildar split a Sunday C1 12/12.
  const split = applySplitTwelveHour(rows, cellText, {
    selfId: 'p-horan', partnerId: 'p-havildar', bucket: 'SUN_C1',
  });
  rows = split.rows;
  cellText = split.cellText;
  // Havildar and Simon: 1 Friday C1 and 1 Saturday C1 each.
  for (const pid of ['p-havildar', 'p-simon']) {
    cellText[cellKey(pid, 'FRI_C1')] = '1';
    cellText[cellKey(pid, 'SAT_C1')] = '1';
  }
  // Hussain: 1 Saturday C1 + either a Friday or a Sunday call.
  cellText[cellKey('p-hussain', 'SAT_C1')] = '1';
  rows = applyEitherOr(rows, 'p-hussain', ['FRI_C1', 'SUN_C1']);

  return { rows, cellText };
}

function statedRows(): PanelRow[] {
  const { rows, cellText } = statedState();
  return rowsWithCellText(rows, cellText);
}

describe('his block, stated through the panel API', () => {
  it('summarizes what he changed: 4 of 6 providers, 8 cells, 2 linkages, no warnings', () => {
    const summary = summarizePanel(statedRows(), BASIS);
    expect(summary).toEqual({
      providerCount: 6,
      touchedProviderCount: 4,
      // Horan SAT+SUN, Havildar FRI+SAT+SUN, Simon FRI+SAT, Hussain SAT.
      typedCellCount: 8,
      linkageCount: 2,
      warnings: [],
    });
  });

  it('the manifest the panel builds PASSES the validator the PATCH route runs', () => {
    // schedules/[id] PATCH rejects an invalid scenario_manifest with a 400, so
    // a panel row shape that failed validateManifest would make Save fail on
    // the wire. PanelRow carries extra fields (inPool, profileFte,
    // fteFromManifest) that must not leak into the artifact.
    const manifest = buildBlockManifest({
      providers: statedRows(), basis: BASIS, scheduleLabel: 'Paoli 8/10–10/25',
    });
    expect(validateManifest(manifest)).toEqual({ ok: true, errors: [] });
    const serialized = JSON.parse(JSON.stringify(manifest));
    expect(validateManifest(serialized).ok).toBe(true);
    for (const p of serialized.providers) {
      expect(p).not.toHaveProperty('inPool');
      expect(p).not.toHaveProperty('profileFte');
      expect(p).not.toHaveProperty('fteFromManifest');
    }
    // The sidecar survives serialization — it is what makes re-opening not
    // freeze every formula, and a non-strict schema keeps it legal.
    expect(serialized.blockTargets.overrides['p-horan']).toEqual(['SAT_C1', 'SUN_C1']);
  });

  it('the two he never touched arrive at the engine on the FORMULA', () => {
    const manifest = buildBlockManifest({ providers: statedRows(), basis: BASIS });
    const amusa = manifest.providers.find(p => p.providerId === 'p-amusa')!;
    // All NINE, not a subset: a toMatchObject here would let the weekend
    // second calls derive to anything at all.
    expect(amusa.targets).toEqual({
      MTH_C1: 4, MTH_C2: 4,
      FRI_C1: 1, FRI_C2: 1,
      SAT_C1: 1, SAT_C2: 1,
      SUN_C1: 1, SUN_C2: 1,
      NEURO_FSS: 1,
    });
  });

  it('projects through projectScenario + buildScenarioCallCaps to the ceilings he meant', () => {
    const manifest = buildBlockManifest({ providers: statedRows(), basis: BASIS });
    const projected = projectScenario(manifest, {
      knownProviderIds: new Set(POOL.map(p => p.providerId)),
    });
    expect(projected.warnings).toEqual([]);
    const scen = projected.scenario!;

    // Horan: one Saturday, half a Sunday, one neuro weekend DAY (0.5 FTE band).
    const horan = scen.providers.get('p-horan')!;
    expect(horan.targets.get('SAT|C1')).toBe(1);
    expect(horan.targets.get('SUN|C1')).toBe(0.5);
    expect(horan.targets.get('MTH|C1')).toBe(2); // derived
    expect(horan.neuroTarget).toBe(0.5);
    expect(horan.linkages.find(l => l.kind === 'split-12h')!.rawMembers)
      .toEqual(['Horan', 'Havildar']);

    // Havildar holds the other 12h; Simon's Sunday is untouched → derived.
    expect(scen.providers.get('p-havildar')!.targets.get('SUN|C1')).toBe(0.5);
    expect(scen.providers.get('p-simon')!.targets.get('SUN|C1')).toBe(0.75);
    for (const pid of ['p-havildar', 'p-simon']) {
      expect(scen.providers.get(pid)!.targets.get('FRI|C1')).toBe(1);
      expect(scen.providers.get(pid)!.targets.get('SAT|C1')).toBe(1);
      expect(scen.providers.get(pid)!.neuroTarget).toBe(1);
    }

    // Hussain: the either-or folds FRI|C1 and SUN|C1 into ONE group cap of 1.
    const caps = buildScenarioCallCaps(scen)!;
    const hussain = caps.get('p-hussain')!;
    expect(hussain.get('S:EO#0')).toBe(1);
    expect(hussain.has('S:FRI|C1')).toBe(false);
    expect(hussain.has('S:SUN|C1')).toBe(false);
    expect(hussain.get('S:SAT|C1')).toBe(1);
    // Horan's half-Sunday still admits one placement (or a 0.5 segment).
    expect(caps.get('p-horan')!.get('S:SUN|C1')).toBe(1);
  });

  it('feasibility: everything UNDER (the paid-pickup layer), nothing over-constrained', () => {
    const rows = statedRows();
    const feas = checkFeasibility(rows.map(r => resolveTargets(r, BASIS).targets), BASIS.slotCounts);
    expect(feas.filter(f => f.overConstrained)).toEqual([]);
    const sat = feas.find(f => f.bucket === 'SAT_C1')!;
    // Horan 1 + Havildar 1 + Simon 1 + Hussain 1 + Amusa 1 + Jones 1 = 6 of 11.
    expect(sat).toMatchObject({ slots: 11, stated: 6, status: 'under' });
    const sun = feas.find(f => f.bucket === 'SUN_C1')!;
    // 0.5 + 0.5 (the split) + 0.75 Simon + 0 Hussain (claimed) + 1 + 1 = 3.75.
    expect(sun).toMatchObject({ slots: 11, stated: 3.75, status: 'under' });
  });

  it('over-constraining a bucket surfaces AND force-shows its column', () => {
    // Six providers each told to take a Saturday C2 in a block with 11 — fine.
    // Push it past the slots and both the warning and the column must appear.
    const rows = freshRows();
    const cellText: Record<string, string> = {};
    for (const p of POOL) cellText[cellKey(p.providerId, 'SAT_C2')] = '2';
    const live = rowsWithCellText(rows, cellText);
    const feas = checkFeasibility(live.map(r => resolveTargets(r, BASIS).targets), BASIS.slotCounts);
    const satC2 = feas.find(f => f.bucket === 'SAT_C2')!;
    expect(satC2).toMatchObject({ slots: 11, stated: 12, delta: 1, overConstrained: true });
    const plan = columnPlan({
      expanded: false,
      resolved: live.map(r => resolveTargets(r, BASIS)),
      overConstrained: feas.filter(f => f.overConstrained).map(f => f.bucket),
    });
    expect(plan.visible).toContain('SAT_C2');
  });

  it('save → reopen → save is a fixed point (nothing drifts, nothing freezes)', () => {
    const first = buildBlockManifest({
      providers: statedRows(), basis: BASIS,
      scheduleLabel: 'Paoli 8/10–10/25', defaultYear: 2026,
      generatedAt: '2026-07-27T12:00:00.000Z',
    });
    const reopened = buildPanelRows({ pool: POOL, storedManifest: first });
    expect(reopened.imported).toBe(false);
    const text = cellTextFromRows(reopened.rows);
    const second = buildBlockManifest({
      providers: rowsWithCellText(reopened.rows, text), basis: BASIS,
      scheduleLabel: 'Paoli 8/10–10/25', defaultYear: 2026,
      generatedAt: '2026-07-27T12:00:00.000Z',
    });
    expect(second).toEqual(first);
  });

  it('re-opening after the BLOCK changed re-derives the untouched cells', () => {
    const stored = buildBlockManifest({ providers: statedRows(), basis: BASIS });
    const reopened = buildPanelRows({ pool: POOL, storedManifest: stored });
    const text = cellTextFromRows(reopened.rows);
    const biggerBlock: DerivationBasis = {
      ...BASIS, slotCounts: { ...BASIS.slotCounts, MTH_C1: 55 },
    };
    const rebuilt = buildBlockManifest({
      providers: rowsWithCellText(reopened.rows, text), basis: biggerBlock,
    });
    const amusa = rebuilt.providers.find(p => p.providerId === 'p-amusa')!;
    expect(amusa.targets.MTH_C1).toBe(5);  // followed the block
    const horan = rebuilt.providers.find(p => p.providerId === 'p-horan')!;
    expect(horan.targets.MTH_C1).toBe(2.5); // derived, followed the block
    expect(horan.targets.SAT_C1).toBe(1);   // typed, held
    expect(horan.targets.SUN_C1).toBe(0.5); // typed, held
  });
});

// ── the write decision, and the states that must never write ─────────────────

describe('invalidCellKeys scoping', () => {
  it('ignores invalid cells belonging to no rendered row (nothing to fix on screen)', () => {
    const text = {
      [cellKey('p-horan', 'SAT_C1')]: 'abc',
      [cellKey('p-gone', 'SAT_C1')]: 'abc',
    };
    expect(invalidCellKeys(text)).toHaveLength(2);          // unscoped
    expect(invalidCellKeys(text, new Set(['p-horan'])))
      .toEqual([cellKey('p-horan', 'SAT_C1')]);             // scoped to rows
    expect(invalidCellKeys(text, new Set(['p-horan', 'p-gone']))).toHaveLength(2);
  });
});

describe('strandedEdits', () => {
  it('reports typed cells whose provider is no longer a row', () => {
    const rows = freshRows();
    const s = strandedEdits(rows, {
      [cellKey('p-horan', 'SAT_C1')]: '1',
      [cellKey('p-gone', 'SUN_C1')]: '1',
      [cellKey('p-blank', 'SUN_C1')]: '   ', // blank is not an edit
    });
    expect(s.cellProviderIds).toEqual(['p-gone']);
  });

  it('reports a 12h split whose partner has left the pool', () => {
    // The linkage lives on Horan and names Havildar; the 0.5 halves are typed
    // on both. Drop Havildar and half a Sunday call belongs to nobody —
    // resolveTargets never inspects split-12h and projectScenario keeps the
    // names unresolved, so nothing downstream would ever say so.
    const { rows, cellText } = applySplitTwelveHour(freshRows(), {}, {
      selfId: 'p-horan', partnerId: 'p-havildar', bucket: 'SUN_C1',
    });
    const withoutPartner = rows.filter(r => r.providerId !== 'p-havildar');
    const s = strandedEdits(withoutPartner, cellText);
    expect(s.orphanedSplits).toEqual([
      { providerId: 'p-horan', displayName: 'Horan', partner: 'Havildar' },
    ]);
    expect(s.cellProviderIds).toEqual(['p-havildar']);
    // With the partner present, nothing is stranded.
    expect(strandedEdits(rows, cellText)).toEqual({ cellProviderIds: [], orphanedSplits: [] });
  });
});

describe('targetEditFingerprint (dirty is a comparison, never a latch)', () => {
  const seed = () => targetEditFingerprint(freshRows(), {});

  it('typing a value and deleting it again returns to the seeded signature', () => {
    const rows = freshRows();
    const typed = targetEditFingerprint(rows, { [cellKey('p-horan', 'SAT_C1')]: '1' });
    expect(typed).not.toBe(seed());
    // Cleared back to blank — the panel must be DISARMED again, or a no-op
    // visit would write a manifest of hard ceilings for every provider.
    expect(targetEditFingerprint(rows, { [cellKey('p-horan', 'SAT_C1')]: '' })).toBe(seed());
    expect(targetEditFingerprint(rows, { [cellKey('p-horan', 'SAT_C1')]: '  ' })).toBe(seed());
  });

  it('adding a linkage and removing it again returns to the seeded signature', () => {
    const linked = applyEitherOr(freshRows(), 'p-hussain', ['FRI_C1', 'SUN_C1']);
    expect(targetEditFingerprint(linked, {})).not.toBe(seed());
    expect(targetEditFingerprint(clearEitherOr(linked, 'p-hussain'), {})).toBe(seed());
  });

  it('is stable under pool membership alone', () => {
    // The same edits, with two providers removed from the pool: the signature
    // must not move, or changing the pool would arm a manifest write.
    const rows = freshRows();
    const text = { [cellKey('p-horan', 'SAT_C1')]: '1' };
    const smaller = rows.filter(r => !['p-amusa', 'p-jones'].includes(r.providerId));
    expect(targetEditFingerprint(smaller, text)).toBe(targetEditFingerprint(rows, text));
  });

  it('does not depend on key insertion order', () => {
    const rows = freshRows();
    const a = { [cellKey('p-horan', 'SAT_C1')]: '1', [cellKey('p-simon', 'FRI_C1')]: '1' };
    const b = { [cellKey('p-simon', 'FRI_C1')]: '1', [cellKey('p-horan', 'SAT_C1')]: '1' };
    expect(targetEditFingerprint(rows, a)).toBe(targetEditFingerprint(rows, b));
  });
});

describe('targetWritePlan', () => {
  const base = {
    manifestState: 'ready' as const,
    dirty: false,
    clearRequested: false,
    imported: false,
    unreadable: false,
    importAcknowledged: false,
    invalidCellCount: 0,
    manifestErrors: [] as string[],
  };

  it('OMITS the key when the fetch has not landed or failed — never clobbers', () => {
    // Even a dirty panel must not write against a manifest it never read.
    expect(targetWritePlan({ ...base, manifestState: 'loading', dirty: true }))
      .toEqual({ write: 'omit', blocked: null });
    expect(targetWritePlan({ ...base, manifestState: 'failed', dirty: true }))
      .toEqual({ write: 'omit', blocked: null });
    expect(targetWritePlan({ ...base, manifestState: 'failed', clearRequested: true }))
      .toEqual({ write: 'omit', blocked: null });
  });

  it('OMITS the key for a pool-only save (nothing edited here)', () => {
    expect(targetWritePlan(base)).toEqual({ write: 'omit', blocked: null });
    // …even when a manifest is stored and imported: not touching the tab means
    // not rewriting the column.
    expect(targetWritePlan({ ...base, imported: true }))
      .toEqual({ write: 'omit', blocked: null });
  });

  it('writes the manifest once edited, and clears when asked', () => {
    expect(targetWritePlan({ ...base, dirty: true }))
      .toEqual({ write: 'manifest', blocked: null });
    expect(targetWritePlan({ ...base, clearRequested: true }))
      .toEqual({ write: 'clear', blocked: null });
  });

  it('blocks an overwrite of an imported or unreadable manifest until acknowledged', () => {
    const imported = targetWritePlan({ ...base, dirty: true, imported: true });
    expect(imported.blocked).toMatch(/imported manifest/);
    expect(targetWritePlan({ ...base, dirty: true, imported: true, importAcknowledged: true }))
      .toEqual({ write: 'manifest', blocked: null });

    const unreadable = targetWritePlan({ ...base, dirty: true, unreadable: true });
    expect(unreadable.blocked).toMatch(/could not be read/);
    // Clearing an unreadable manifest is still a destructive overwrite.
    expect(targetWritePlan({ ...base, clearRequested: true, unreadable: true }).blocked)
      .toMatch(/could not be read/);
  });

  it('blocks on invalid cells and on manifest errors, but never on a clear', () => {
    expect(targetWritePlan({ ...base, dirty: true, invalidCellCount: 1 }).blocked)
      .toMatch(/Fix the highlighted/);
    expect(targetWritePlan({ ...base, dirty: true, manifestErrors: ['Ghost: no provider id'] }).blocked)
      .toBe('Ghost: no provider id');
    // A clear does not care that a cell is unparseable — it deletes everything.
    expect(targetWritePlan({ ...base, clearRequested: true, invalidCellCount: 3 }))
      .toEqual({ write: 'clear', blocked: null });
  });
});

describe('a stored manifest that cannot be read', () => {
  it('is reported as stored-but-unreadable, never as "nothing stored"', () => {
    // Garbage jsonb, a foreign shape, and a schema-legal empty provider list
    // all yield zero rows. Treating any of them as absent would hide the
    // overwrite warning and let one edit destroy the column.
    for (const junk of [
      { hello: 'world' },
      { providers: 'not an array' },
      { manifestVersion: 1, providers: [] },
    ]) {
      const res = buildPanelRows({ pool: POOL, storedManifest: junk });
      expect(res.hasStoredManifest).toBe(true);
      expect(res.unreadable).toBe(true);
      expect(res.imported).toBe(false); // an unreadable thing is not "a workbook"
      expect(res.rows.every(r => r.inPool)).toBe(true);
    }
  });

  it('an absent manifest is genuinely absent', () => {
    for (const empty of [null, undefined]) {
      const res = buildPanelRows({ pool: POOL, storedManifest: empty });
      expect(res.hasStoredManifest).toBe(false);
      expect(res.unreadable).toBe(false);
    }
  });
});

describe('summarizePanel', () => {
  it('surfaces a resolveTargets warning with the provider’s name on it', () => {
    // An either-or whose members are BOTH explicitly 1 buys a group cap of 2.
    const rows = applyEitherOr(freshRows(), 'p-hussain', ['FRI_C1', 'SUN_C1']);
    const live = rowsWithCellText(rows, {
      [cellKey('p-hussain', 'FRI_C1')]: '1',
      [cellKey('p-hussain', 'SUN_C1')]: '1',
    });
    const summary = summarizePanel(live, BASIS);
    expect(summary.warnings).toHaveLength(1);
    expect(summary.warnings[0]).toMatch(/^Hussain: /);
    expect(summary.warnings[0]).toMatch(/ceiling for the group will be 2/);
  });

  it('an untouched roster reports nothing changed', () => {
    expect(summarizePanel(freshRows(), BASIS)).toEqual({
      providerCount: 6, touchedProviderCount: 0, typedCellCount: 0, linkageCount: 0, warnings: [],
    });
  });
});
