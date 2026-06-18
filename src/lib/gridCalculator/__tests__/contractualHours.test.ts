// Unit tests for the Contractual Hours Grid builder.
//
// Run with: npx tsx src/lib/gridCalculator/__tests__/contractualHours.test.ts
// (matches the repo convention; no vitest required.)
//
// Coverage:
//   1. Empty sites → no rows, zero totals.
//   2. Paoli demo sites → 20 rows (15 Main OR + 2 Endo + 1 Neuro + 1 EP + 1 OB).
//   3. weekdayCloseHour=15 → crnaHrsPerDay = 8.
//   4. weekendOpen=true → daysPerWeek = 7.
//   5. Paoli weekly CRNA hours land in a sane bracket.
//   6. crnaProjectedFte = mandated × (1 + 6/46) (float-epsilon).

import assert from 'node:assert/strict';

import {
  TIME_BLOCKS,
  buildContractualGrid,
} from '../contractualHours';
import { paoliSites } from '../seeds/paoli';
import type { GridSite } from '../types';

// ---------------------------------------------------------------------------
// Mini test harness — mirrors the rest of the gridCalculator suite.
// ---------------------------------------------------------------------------

type TestCase = { name: string; fn: () => void | Promise<void> };
const cases: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  cases.push({ name, fn });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSite(overrides: Partial<GridSite> & { rooms: GridSite['rooms'] }): GridSite {
  return {
    id: overrides.id ?? 'site-x',
    name: overrides.name ?? 'Generic',
    color: overrides.color ?? '#0ea5e9',
    icon: overrides.icon ?? '🏥',
    position: overrides.position ?? 0,
    rooms: overrides.rooms,
    shortName: overrides.shortName,
    caption: overrides.caption,
  };
}

// ---------------------------------------------------------------------------
// 1. Empty input.
// ---------------------------------------------------------------------------

test('empty sites → zero rows and zero totals', () => {
  const grid = buildContractualGrid([]);
  assert.equal(grid.rows.length, 0);
  assert.equal(grid.totals.crnaWeeklyHours, 0);
  assert.equal(grid.totals.mdWeeklyHours, 0);
  assert.equal(grid.totals.crnaFteMandated, 0);
  assert.equal(grid.totals.mdFteMandated, 0);
  assert.equal(grid.totals.crnaVacationFte, 0);
  assert.equal(grid.totals.mdVacationFte, 0);
  assert.equal(grid.totals.crnaProjectedFte, 0);
  assert.equal(grid.totals.mdProjectedFte, 0);
});

// ---------------------------------------------------------------------------
// 2. Paoli demo sites → 20 staffed rows (Float is excluded).
// ---------------------------------------------------------------------------

test('Paoli demo sites produce 20 rows (15 OR + 2 Endo + 1 Neuro + 1 EP + 1 OB)', () => {
  const grid = buildContractualGrid(paoliSites);
  assert.equal(grid.rows.length, 20);

  const byGroup = new Map<string, number>();
  for (const row of grid.rows) {
    byGroup.set(row.groupId, (byGroup.get(row.groupId) ?? 0) + 1);
  }
  assert.equal(byGroup.get('main_or'), 15, 'expected 15 Main OR rows');
  assert.equal(byGroup.get('nora'), 5, 'expected 5 NORA rows (Endo×2 + Neuro + EP + OB)');
  assert.equal(byGroup.get('float'), undefined, 'Float should be skipped entirely');
});

// ---------------------------------------------------------------------------
// 3. weekdayCloseHour=15 → crnaHrsPerDay = 8 (8h = 15-7).
// ---------------------------------------------------------------------------

test('weekdayCloseHour=15 yields crnaHrsPerDay=8', () => {
  const site = makeSite({
    id: 'site-15',
    name: 'Sub',
    rooms: [
      { id: 'r1', siteId: 'site-15', name: 'OR 1', position: 0, weekdayCloseHour: 15 },
    ],
  });
  const grid = buildContractualGrid([site]);
  assert.equal(grid.rows.length, 1);
  assert.equal(grid.rows[0].crnaHrsPerDay, 8);
  // mdHrsPerDay = 8 / 3 (mostly_1_3 divisor).
  assert.ok(
    Math.abs(grid.rows[0].mdHrsPerDay - 8 / 3) < 1e-9,
    `expected mdHrsPerDay=${8 / 3}, got ${grid.rows[0].mdHrsPerDay}`,
  );
});

// ---------------------------------------------------------------------------
// 4. weekendOpen=true → daysPerWeek=7.
// ---------------------------------------------------------------------------

test('weekendOpen room reports daysPerWeek=7', () => {
  const weekdaySite = makeSite({
    id: 'site-weekday',
    name: 'Weekday Only',
    rooms: [
      { id: 'r1', siteId: 'site-weekday', name: 'OR 1', position: 0, weekdayCloseHour: 17 },
    ],
  });
  const weekendSite = makeSite({
    id: 'site-weekend',
    name: '24/7',
    rooms: [
      {
        id: 'r1',
        siteId: 'site-weekend',
        name: 'In House',
        position: 0,
        weekdayCloseHour: 23,
        weekendOpen: true,
      },
    ],
  });
  const grid = buildContractualGrid([weekdaySite, weekendSite]);
  assert.equal(grid.rows.length, 2);
  assert.equal(grid.rows[0].daysPerWeek, 5);
  assert.equal(grid.rows[1].daysPerWeek, 7);
});

// ---------------------------------------------------------------------------
// 5. Paoli total CRNA weekly hours falls inside a sane bracket.
// ---------------------------------------------------------------------------

test('Paoli total CRNA weekly hours lands in [50, 1500]', () => {
  const grid = buildContractualGrid(paoliSites);
  assert.ok(
    grid.totals.crnaWeeklyHours >= 50 && grid.totals.crnaWeeklyHours <= 1500,
    `expected crnaWeeklyHours in [50, 1500], got ${grid.totals.crnaWeeklyHours}`,
  );
  // And the 12 time blocks must be unchanged.
  assert.equal(TIME_BLOCKS.length, 12);
});

// ---------------------------------------------------------------------------
// 6. Vacation FTE rolls into projected FTE via the 6/46 ratio.
// ---------------------------------------------------------------------------

test('crnaProjectedFte = crnaFteMandated × (1 + 6/46) within float epsilon', () => {
  const grid = buildContractualGrid(paoliSites);
  const expected = grid.totals.crnaFteMandated * (1 + 6 / 46);
  assert.ok(
    Math.abs(grid.totals.crnaProjectedFte - expected) < 1e-9,
    `expected crnaProjectedFte≈${expected}, got ${grid.totals.crnaProjectedFte}`,
  );
  const expectedMd = grid.totals.mdFteMandated * (1 + 6 / 46);
  assert.ok(
    Math.abs(grid.totals.mdProjectedFte - expectedMd) < 1e-9,
    `expected mdProjectedFte≈${expectedMd}, got ${grid.totals.mdProjectedFte}`,
  );
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main() {
  let passed = 0;
  let failed = 0;
  const failures: Array<{ name: string; err: unknown }> = [];
  for (const tc of cases) {
    try {
      await tc.fn();
      passed++;
      console.log(`  ok  ${tc.name}`);
    } catch (err) {
      failed++;
      failures.push({ name: tc.name, err });
      console.error(`  FAIL ${tc.name}`);
    }
  }
  console.log(`\n${passed}/${cases.length} passed, ${failed} failed`);
  if (failed > 0) {
    for (const f of failures) {
      console.error(`\n--- ${f.name} ---`);
      console.error(f.err);
    }
    process.exit(1);
  }
}

main();
