// Call Counts chain connectors (2026-07-28). The band above the header answers
// "which of these columns are ONE person?", and the answer has to come from the
// site's own CallPatternDoc — so the load-bearing cases are: Paoli's REAL
// pattern resolving to the right members, the neuro group (where Sat C3 and
// Sun C3 are drawn outside the Sat/Sun groups), members that have no column at
// all, and the offset → day type step.
import { describe, it, expect } from 'vitest';
import { WEEKEND_V2_PATTERN } from './rulesEngine/patterns/weekendV2';
import { CallPatternDocSchema, CLASSIC_PATTERN, type CallPatternDoc } from './rulesEngine/callPattern';
import {
  computeCallCountColumns,
  NEURO_GROUP_KEY,
  type CallCountSlotRow,
} from './callCountColumns';
import { bucketAtOffset, computeCallChainConnectors } from './callCountChains';

// The holiday-free week the sibling column tests use.
const MON = '2026-03-02', THU = '2026-03-05', FRI = '2026-03-06';
const SAT = '2026-03-07', SUN = '2026-03-08';

const slot = (slot_date: string, derived_day_type: string, code: string): CallCountSlotRow => ({
  slot_date, derived_day_type, shift_types: { code }, assignments: [],
});

// Paoli after patch38: weekday + friday C1/C2, Sat/Sun C1/C2/C3.
const paoliBlock = (): CallCountSlotRow[] => [
  slot(MON, 'weekday', 'C1'), slot(MON, 'weekday', 'C2'),
  slot(THU, 'weekday', 'C1'), slot(THU, 'weekday', 'C2'),
  slot(FRI, 'friday', 'C1'), slot(FRI, 'friday', 'C2'),
  slot(SAT, 'saturday', 'C1'), slot(SAT, 'saturday', 'C2'), slot(SAT, 'saturday', 'C3'),
  slot(SUN, 'sunday', 'C1'), slot(SUN, 'sunday', 'C2'), slot(SUN, 'sunday', 'C3'),
];

/** Paoli's live layout: the neuro tier lifted into its own group. */
const paoliColumns = (slots: CallCountSlotRow[] = paoliBlock()) =>
  computeCallCountColumns(slots, { neuroCode: 'C3' }).columns;

const labelsOf = (c: { members: ReadonlyArray<{ label: string }> }) => c.members.map(m => m.label);

/* ── Offset → day type ───────────────────────────────────────────────────── */

describe('bucketAtOffset — a stored day offset becomes a column day type', () => {
  it('resolves the offsets Paoli actually uses', () => {
    expect(bucketAtOffset('saturday', 0)).toBe('saturday');
    expect(bucketAtOffset('saturday', -1)).toBe('friday');   // Sat C2 → Fri C2
    expect(bucketAtOffset('saturday', 1)).toBe('sunday');    // Sat C2 → Sun C1
    expect(bucketAtOffset('friday', 0)).toBe('friday');
    expect(bucketAtOffset('friday', 2)).toBe('sunday');      // Fri C1 → Sun C2
  });

  it('resolves a link that lands on a WEEKDAY to the M–Th bucket', () => {
    expect(bucketAtOffset('saturday', 2)).toBe('weekday');   // Monday
    expect(bucketAtOffset('friday', 3)).toBe('weekday');     // Monday
    expect(bucketAtOffset('sunday', 4)).toBe('weekday');     // Thursday
  });

  it('leaves an offset unresolved when the anchor day type spans several days', () => {
    // 'weekday' is Mon–Thu: +1 is Friday from Thursday and a weekday from
    // Monday, so there is no one column to point at. Offset 0 still resolves —
    // every candidate lands on 'weekday'.
    expect(bucketAtOffset('weekday', 0)).toBe('weekday');
    expect(bucketAtOffset('weekday', 1)).toBeNull();
    expect(bucketAtOffset('weekday', -1)).toBeNull();
    // A holiday can fall on any day of the week, so nothing about it resolves.
    expect(bucketAtOffset('federal_holiday', 0)).toBeNull();
    expect(bucketAtOffset('major_holiday', 1)).toBeNull();
  });
});

/* ── Paoli's real pattern ────────────────────────────────────────────────── */

describe('computeCallChainConnectors — WEEKEND_V2_PATTERN against Paoli columns', () => {
  it('yields exactly the three chains that have two or more columned members', () => {
    const columns = paoliColumns();
    // 10 columns: M–Th C1/C2, Fri C1/C2, Sat C1/C2, Sun C1/C2, then Neuro
    // Sat C3 / Sun C3. The band must span exactly these.
    expect(columns.map(c => c.key)).toEqual([
      'weekday|C1', 'weekday|C2', 'friday|C1', 'friday|C2',
      'saturday|C1', 'saturday|C2', 'sunday|C1', 'sunday|C2',
      'saturday|C3', 'sunday|C3',
    ]);

    const chains = computeCallChainConnectors(WEEKEND_V2_PATTERN, columns);
    expect(chains.map(c => c.triggerLabel)).toEqual(['Fri C1', 'Sat C2', 'Sat C3']);

    // Doc A: the Friday C1 doc carries Sunday C2 (friday anchor, +2).
    expect(labelsOf(chains[0])).toEqual(['Fri C1', 'Sun C2']);
    expect(chains[0].columnIndices).toEqual([2, 7]);
    expect(chains[0].description).toBe('Fri C1 · Sun C2 — one provider.');

    // The Saturday C2 doc carries Friday C2 and Sunday C1 — the members are
    // NOT adjacent, and the line crossing the Saturday columns is the point.
    expect(labelsOf(chains[1])).toEqual(['Sat C2', 'Fri C2', 'Sun C1']);
    expect(chains[1].columnIndices).toEqual([3, 5, 6]);
    expect(chains[1].firstIndex).toBe(3);
    expect(chains[1].lastIndex).toBe(6);
    expect(chains[1].description).toBe('Sat C2 · Fri C2 · Sun C1 — one provider.');

    // Neuro: Sat + Sun C3, plus the Friday D4 day shift that has no column.
    expect(labelsOf(chains[2])).toEqual(['Sat C3', 'Sun C3']);
    expect(chains[2].columnIndices).toEqual([8, 9]);
    expect(chains[2].omitted).toEqual(['Fri D4']);
    // The Sunday link is FTE-gated at 0.6 (sub-0.6 docs take Saturday alone),
    // so the tooltip must not promise the pair to everybody.
    expect(chains[2].description).toBe(
      'Sat C3 · Sun C3 (FTE ≥ 0.6) — one provider. Also on this chain: Fri D4 — no column in this table.');
  });

  it('draws the Sat C3 ↔ Sun C3 chain inside the NEURO group, not the day groups', () => {
    const columns = paoliColumns();
    const chains = computeCallChainConnectors(WEEKEND_V2_PATTERN, columns);
    const neuro = chains.find(c => c.triggerLabel === 'Sat C3')!;
    expect(neuro).toBeDefined();
    // Both ticks land on columns the layout draws under "Neuro Call (C3)" —
    // the columns' buckets are saturday/sunday but they are NOT in the Sat/Sun
    // groups, which is exactly what a bucket-only match would get wrong.
    for (const m of neuro.members) {
      expect(columns[m.columnIndex].key).toBe(m.key);
      expect(columns[m.columnIndex].groupKey).toBe(NEURO_GROUP_KEY);
    }
    // ... and the day groups' own chains stay out of the neuro group.
    const satC2 = chains.find(c => c.triggerLabel === 'Sat C2')!;
    for (const m of satC2.members) {
      expect(columns[m.columnIndex].groupKey).not.toBe(NEURO_GROUP_KEY);
    }
  });

  it('draws nothing for a chain whose only other member is a day shift', () => {
    // Paoli's Saturday C1 anchor links Friday D2 — a day shift with no column,
    // leaving one columned member and nothing to connect.
    const chains = computeCallChainConnectors(WEEKEND_V2_PATTERN, paoliColumns());
    expect(chains.map(c => c.triggerLabel)).not.toContain('Sat C1');
  });

  it('is unchanged when the neuro tier is NOT lifted into its own group', () => {
    // Same pattern, day-major layout (a site that states no neuroWeekend):
    // the same three chains, resolved against the columns' own order.
    const columns = computeCallCountColumns(paoliBlock()).columns;
    const chains = computeCallChainConnectors(WEEKEND_V2_PATTERN, columns);
    expect(chains.map(c => labelsOf(c))).toEqual([
      ['Fri C1', 'Sun C2'],
      ['Sat C2', 'Fri C2', 'Sun C1'],
      ['Sat C3', 'Sun C3'],
    ]);
    for (const c of chains) {
      for (const m of c.members) expect(columns[m.columnIndex].key).toBe(m.key);
    }
  });
});

/* ── Degenerate inputs ───────────────────────────────────────────────────── */

describe('computeCallChainConnectors — nothing to draw', () => {
  it('yields no chains for a site with no call pattern', () => {
    expect(computeCallChainConnectors(null, paoliColumns())).toEqual([]);
    expect(computeCallChainConnectors(undefined, paoliColumns())).toEqual([]);
  });

  it('yields no chains when the block has no columns at all', () => {
    expect(computeCallChainConnectors(WEEKEND_V2_PATTERN, [])).toEqual([]);
  });

  it('yields no chains for a pattern that states no blocks', () => {
    const doc = CallPatternDocSchema.parse({ ...CLASSIC_PATTERN, blocks: [] });
    expect(computeCallChainConnectors(doc, paoliColumns())).toEqual([]);
  });
});

/* ── Members with no column in THIS block ────────────────────────────────── */

describe('computeCallChainConnectors — a missing column drops the member, not the chain', () => {
  it('keeps the rest of a chain whose member column this block does not stand', () => {
    // A block with no Friday C2 slots at all: the Saturday C2 chain loses that
    // member and still connects Sat C2 ↔ Sun C1.
    const noFridayC2 = paoliBlock().filter(s => !(s.slot_date === FRI && s.shift_types?.code === 'C2'));
    const columns = paoliColumns(noFridayC2);
    expect(columns.map(c => c.key)).not.toContain('friday|C2');

    const chains = computeCallChainConnectors(WEEKEND_V2_PATTERN, columns);
    const satC2 = chains.find(c => c.triggerLabel === 'Sat C2')!;
    expect(labelsOf(satC2)).toEqual(['Sat C2', 'Sun C1']);
    expect(satC2.omitted).toEqual(['Fri C2']);
    for (const m of satC2.members) expect(columns[m.columnIndex].key).toBe(m.key);
  });

  it('drops a legacy Friday C3 member without dropping its chain', () => {
    // A pattern still naming the Friday neuro call patch38 retired: the Friday
    // member has no column on a post-patch38 block, the Sat/Sun pair still draws.
    const legacy: CallPatternDoc = CallPatternDocSchema.parse({
      ...WEEKEND_V2_PATTERN,
      blocks: [{ anchorDayType: 'saturday', chains: [
        { trigger: 'C3', links: [{ offset: -1, code: 'C3' }, { offset: 1, code: 'C3' }] },
      ] }],
    });
    const chains = computeCallChainConnectors(legacy, paoliColumns());
    expect(chains).toHaveLength(1);
    expect(labelsOf(chains[0])).toEqual(['Sat C3', 'Sun C3']);
    expect(chains[0].omitted).toEqual(['Fri C3']);
  });

  it('drops a link whose offset does not resolve, keeping the columned rest', () => {
    // A weekday-anchored chain: the trigger (offset 0) resolves to M–Th, the
    // +1 link does not resolve at all, so only one columned member survives and
    // nothing draws. Add a second offset-0 link and the chain draws inside M–Th.
    const ambiguous: CallPatternDoc = CallPatternDocSchema.parse({
      ...WEEKEND_V2_PATTERN,
      blocks: [{ anchorDayType: 'weekday', chains: [
        { trigger: 'C1', links: [{ offset: 1, code: 'C2' }] },
      ] }],
    });
    expect(computeCallChainConnectors(ambiguous, paoliColumns())).toEqual([]);

    const sameDay: CallPatternDoc = CallPatternDocSchema.parse({
      ...WEEKEND_V2_PATTERN,
      blocks: [{ anchorDayType: 'weekday', chains: [
        { trigger: 'C1', links: [{ offset: 0, code: 'C2' }, { offset: 1, code: 'C2' }] },
      ] }],
    });
    const chains = computeCallChainConnectors(sameDay, paoliColumns());
    expect(chains).toHaveLength(1);
    expect(labelsOf(chains[0])).toEqual(['M–Th C1', 'M–Th C2']);
    expect(chains[0].columnIndices).toEqual([0, 1]);
  });
});

/* ── Shape guarantees the band relies on ─────────────────────────────────── */

describe('computeCallChainConnectors — drawing invariants', () => {
  it('never points at a column index outside the array it was given', () => {
    const columns = paoliColumns();
    for (const c of computeCallChainConnectors(WEEKEND_V2_PATTERN, columns)) {
      expect(c.columnIndices).toEqual([...c.columnIndices].sort((a, b) => a - b));
      expect(c.firstIndex).toBe(c.columnIndices[0]);
      expect(c.lastIndex).toBe(c.columnIndices[c.columnIndices.length - 1]);
      expect(c.columnIndices.length).toBeGreaterThanOrEqual(2);
      for (const i of c.columnIndices) {
        expect(i).toBeGreaterThanOrEqual(0);
        expect(i).toBeLessThan(columns.length);
      }
    }
  });

  it('gives every chain a distinct React key and reads left to right', () => {
    const chains = computeCallChainConnectors(WEEKEND_V2_PATTERN, paoliColumns());
    expect(new Set(chains.map(c => c.key)).size).toBe(chains.length);
    for (let i = 1; i < chains.length; i++) {
      expect(chains[i].firstIndex).toBeGreaterThanOrEqual(chains[i - 1].firstIndex);
    }
  });

  it('collapses two identical chains into one line', () => {
    const doubled: CallPatternDoc = CallPatternDocSchema.parse({
      ...WEEKEND_V2_PATTERN,
      blocks: [
        { anchorDayType: 'saturday', chains: [{ trigger: 'C2', links: [{ offset: 1, code: 'C1' }] }] },
        { anchorDayType: 'saturday', chains: [{ trigger: 'C2', links: [{ offset: 1, code: 'C1' }] }] },
      ],
    });
    expect(computeCallChainConnectors(doubled, paoliColumns())).toHaveLength(1);
  });

  it('handles the CLASSIC pattern (the seeded default) without special-casing', () => {
    // Classic: Sat C3 → Sun C3; Sat C1 → Sun C2 + Fri C2; Sat C2 → Sun C1 + Fri D2.
    const chains = computeCallChainConnectors(CLASSIC_PATTERN, paoliColumns());
    expect(chains.map(c => labelsOf(c))).toEqual([
      ['Sat C1', 'Sun C2', 'Fri C2'],
      ['Sat C2', 'Sun C1'],
      ['Sat C3', 'Sun C3'],
    ]);
    expect(chains[1].omitted).toEqual(['Fri D2']);   // the day shift, named not drawn
  });
});
