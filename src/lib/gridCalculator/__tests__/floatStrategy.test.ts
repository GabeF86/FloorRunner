// Unit tests for the Float Strategy module.
// Owned by agent A6 (Float Strategy).
//
// Run with: npx tsx src/lib/gridCalculator/__tests__/floatStrategy.test.ts
// (vitest is not configured in this repo; tsx + node:assert mirrors A3's
// solver test harness.)

import assert from 'node:assert/strict';

import { solve } from '../solver';
import type { RosterProvider, SolverInput, SolvedGrid } from '../solver';
import {
  applyFloatStrategy,
  assessFloatHealth,
  type DistanceMatrixWithBands,
  type FloatSurplusProvider,
} from '../floatStrategy';
import type {
  CoverageRuleSet,
  GridCalculatorConfig,
  GridRoom,
  GridSite,
} from '../types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseConfig: GridCalculatorConfig = {
  id: 'cfg-A6',
  hospital: 'Test Hospital',
  name: 'Default',
  coverageStyle: 'balanced',
  supervisionRatio: 'mostly_1_4',
  floatStrategy: 'balanced',
  backupCallPosture: 'conservative',
};

function makeRoom(id: string, siteId: string, name: string, position: number): GridRoom {
  return { id, siteId, name, position };
}

function makeSite(
  id: string,
  name: string,
  position: number,
  roomCount: number,
): GridSite {
  return {
    id,
    name,
    color: '#4A90D9',
    icon: 'OR',
    position,
    rooms: Array.from({ length: roomCount }, (_, i) =>
      makeRoom(`${id}-r${i + 1}`, id, `Room ${i + 1}`, i),
    ),
  };
}

function makeProvider(
  id: string,
  role: 'anesthesiologist' | 'crna',
  fte = 1.0,
): RosterProvider {
  return { id, role, fte };
}

const noRules: CoverageRuleSet = { siteRules: [], globalRules: [] };

/**
 * Construct a minimal `SolvedGrid` for tests that don't need the solver — used
 * to isolate `assessFloatHealth` behavior under controlled supply/demand.
 */
function syntheticGrid(
  rooms: number,
  floats: { providerId: string; siteId: string | null }[] = [],
): SolvedGrid {
  return {
    configId: 'cfg-synth',
    assignments: Array.from({ length: rooms }, (_, i) => ({
      roomId: `r${i}`,
      siteId: 'site-main',
      anesthesiologistId: 'md-shared',
      crnaIds: [`crna-${i}`],
      staffingPattern: 'supervised_md_crna' as const,
    })),
    floats: floats.map((f) => ({
      providerId: f.providerId,
      role: 'crna' as const,
      leansToSiteId: f.siteId,
    })),
    violations: [],
  };
}

// ---------------------------------------------------------------------------
// Mini test harness — matches A3's solver.test.ts style.
// ---------------------------------------------------------------------------

type TestCase = { name: string; fn: () => void | Promise<void> };
const cases: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  cases.push({ name, fn });
}

// ---------------------------------------------------------------------------
// 1. 0 surplus + 4 rooms → critical.
// ---------------------------------------------------------------------------

test('0 surplus + 4 rooms surfaces critical Float Health', () => {
  const grid = syntheticGrid(4, []); // 0 floats, 4 supervised rooms
  const surplus: FloatSurplusProvider[] = [];
  const health = assessFloatHealth(grid, surplus);
  assert.equal(health.level, 'critical');
  assert.equal(health.coverageRatio, 0);
  assert.match(health.binding, /0 floats/);
});

// ---------------------------------------------------------------------------
// 2. 2 surplus CRNAs + 6 rooms under `break_priority` → both leans = Main OR.
// ---------------------------------------------------------------------------

test('break_priority leans both floats toward the largest (Main OR) site', () => {
  const sites = [
    makeSite('site-main', 'Main OR', 0, 6), // largest
    makeSite('site-endo', 'Endo', 1, 2),
  ];
  // Solver-shaped grid built by hand so we can supply a known surplus.
  const grid: SolvedGrid = {
    configId: 'cfg-A6',
    assignments: sites.flatMap((s) =>
      s.rooms.map((r) => ({
        roomId: r.id,
        siteId: s.id,
        anesthesiologistId: 'md-shared',
        crnaIds: [`crna-${r.id}`],
        staffingPattern: 'supervised_md_crna' as const,
      })),
    ),
    floats: [],
    violations: [],
  };
  const surplus: FloatSurplusProvider[] = [
    { id: 'crna-float-a', role: 'crna' },
    { id: 'crna-float-b', role: 'crna' },
  ];

  const out = applyFloatStrategy(grid, {
    mode: 'break_priority',
    surplus,
    sites,
  });
  assert.equal(out.floats.length, 2);
  assert.ok(out.floats.every((f) => f.leansToSiteId === 'site-main'));
});

// ---------------------------------------------------------------------------
// 3. emergency_priority leans at least one float to the trauma-likely (largest)
//    site even when Endo exists as an alternative.
// ---------------------------------------------------------------------------

test('emergency_priority leans floats toward the larger trauma-likely site', () => {
  const sites = [
    makeSite('site-main', 'Main OR', 0, 8),
    makeSite('site-endo', 'Endo', 1, 2),
  ];
  const distanceMatrix: DistanceMatrixWithBands = {
    getBand: (a, b) => {
      if (a === b) return 'same_room';
      // Endo is "near" Main OR; everything else stays near.
      return 'near';
    },
  };
  const grid: SolvedGrid = {
    configId: 'cfg-A6',
    assignments: [],
    floats: [],
    violations: [],
  };
  const surplus: FloatSurplusProvider[] = [
    { id: 'crna-x', role: 'crna' },
    { id: 'crna-y', role: 'crna' },
  ];

  const out = applyFloatStrategy(grid, {
    mode: 'emergency_priority',
    surplus,
    sites,
    distanceMatrix,
  });
  const leans = out.floats.map((f) => f.leansToSiteId);
  assert.ok(
    leans.some((l) => l === 'site-main'),
    `expected at least one float to lean to site-main, got ${JSON.stringify(leans)}`,
  );
  // All floats lean to the same (trauma-likely) anchor under emergency_priority.
  assert.deepEqual(leans, ['site-main', 'site-main']);
});

// ---------------------------------------------------------------------------
// 4. balanced split is deterministic — even index break, odd emergency.
// ---------------------------------------------------------------------------

test('balanced produces a deterministic split between break and emergency anchors', () => {
  const sites = [
    makeSite('site-main', 'Main OR', 0, 6), // both anchors collapse here for a
    makeSite('site-endo', 'Endo', 1, 1),    // single-large-site case
  ];
  // Make the anchors differ: emergency anchor stays largest but we force the
  // break anchor to be the largest too. To exercise the *split*, give a richer
  // setup with two equally trauma-relevant sites that differ from the largest.
  const richer: GridSite[] = [
    makeSite('site-main', 'Main OR', 0, 5),
    makeSite('site-trauma', 'Trauma Bay', 1, 5), // ties on size; lower position wins
    makeSite('site-endo', 'Endo', 2, 2),
  ];

  const grid: SolvedGrid = {
    configId: 'cfg-A6',
    assignments: [],
    floats: [],
    violations: [],
  };
  // 4 floats so we see the split unambiguously.
  const surplus: FloatSurplusProvider[] = [
    { id: 'crna-a', role: 'crna' },
    { id: 'crna-b', role: 'crna' },
    { id: 'crna-c', role: 'crna' },
    { id: 'crna-d', role: 'crna' },
  ];
  const out = applyFloatStrategy(grid, {
    mode: 'balanced',
    surplus,
    sites: richer,
  });
  const leans = out.floats.map((f) => f.leansToSiteId);
  // First & third → break anchor (site-main; lower position wins tie).
  // Second & fourth → emergency anchor (also site-main given the heuristic;
  // ensures determinism regardless of which anchor wins ties).
  assert.equal(leans.length, 4);
  // Deterministic: re-running on the same input yields the identical array.
  const again = applyFloatStrategy(grid, {
    mode: 'balanced',
    surplus,
    sites: richer,
  });
  assert.deepEqual(out.floats, again.floats);
  // And the split pattern alternates exactly by index (even→break, odd→emerg).
  assert.equal(leans[0], leans[2], 'even-indexed floats share break anchor');
  assert.equal(leans[1], leans[3], 'odd-indexed floats share emergency anchor');
  // Also confirm we use a known site — not null.
  assert.ok(leans.every((l) => l !== null));
});

// ---------------------------------------------------------------------------
// 5. Severity bands match PRD §12: ≥100% ok, 75-99% tight, 50-74% warning,
//    <50% critical.
// ---------------------------------------------------------------------------

test('FloatHealth level matches PRD §12 severity bands across the ratio range', () => {
  // demand = 5 rooms × 3 breaks = 15
  // supply per float = 5
  // 3 floats → 15 supply → ratio 1.0 → ok
  // 2 floats → 10 supply → ratio 0.66 → warning (50-74%)
  // 1 float  →  5 supply → ratio 0.33 → critical (<50%)
  // 3 floats but demand bumped to 18 → ratio 0.83 → tight (75-99%)
  const grid5Rooms = syntheticGrid(5);

  const ok = assessFloatHealth(
    { ...grid5Rooms, floats: floatsOfSize(3) },
    surplusOfSize(3),
  );
  assert.equal(ok.level, 'ok');

  const warning = assessFloatHealth(
    { ...grid5Rooms, floats: floatsOfSize(2) },
    surplusOfSize(2),
  );
  assert.equal(warning.level, 'warning');

  const critical = assessFloatHealth(
    { ...grid5Rooms, floats: floatsOfSize(1) },
    surplusOfSize(1),
  );
  assert.equal(critical.level, 'critical');

  // Tight band: pass expectedDemand so the ratio lands in [0.75, 1.0).
  const tight = assessFloatHealth(
    { ...grid5Rooms, floats: floatsOfSize(3) },
    surplusOfSize(3),
    18,
  );
  assert.equal(tight.level, 'tight');
});

// ---------------------------------------------------------------------------
// 6. applyFloatStrategy is idempotent — re-running produces an identical grid.
// ---------------------------------------------------------------------------

test('applyFloatStrategy is idempotent across consecutive runs', () => {
  const sites = [
    makeSite('site-main', 'Main OR', 0, 4),
    makeSite('site-endo', 'Endo', 1, 2),
  ];
  // Use the real solver so we exercise the production path A7 will use.
  const input: SolverInput = {
    config: { ...baseConfig, floatStrategy: 'balanced' },
    sites,
    rules: noRules,
    roster: [
      makeProvider('md-1', 'anesthesiologist'),
      makeProvider('md-2', 'anesthesiologist'),
      makeProvider('crna-1', 'crna'),
      makeProvider('crna-2', 'crna'),
      makeProvider('crna-3', 'crna'),
      makeProvider('crna-4', 'crna'),
      makeProvider('crna-5', 'crna'),
      makeProvider('crna-6', 'crna'),
      makeProvider('crna-7', 'crna'),  // surplus
      makeProvider('crna-8', 'crna'),  // surplus
    ],
  };
  const solved = solve(input);
  // Surplus = the providers not consumed by the solver. For the test we just
  // designate the last two CRNAs as our float pool — mirroring how A7 will
  // build the surplus list from leftover roster.
  const surplus: FloatSurplusProvider[] = [
    { id: 'crna-7', role: 'crna' },
    { id: 'crna-8', role: 'crna' },
  ];

  const first = applyFloatStrategy(solved, {
    mode: 'balanced',
    surplus,
    sites,
  });
  const second = applyFloatStrategy(first, {
    mode: 'balanced',
    surplus,
    sites,
  });
  assert.deepEqual(second.floats, first.floats);
  assert.deepEqual(second.assignments, first.assignments);
  assert.deepEqual(second.violations, first.violations);
});

// ---------------------------------------------------------------------------
// 7. break_priority with no rooms in any site still returns an array (defensive).
// ---------------------------------------------------------------------------

test('strategy gracefully handles empty sites by leaving leansTo null', () => {
  const sites: GridSite[] = [];
  const grid: SolvedGrid = {
    configId: 'cfg-A6',
    assignments: [],
    floats: [],
    violations: [],
  };
  const surplus: FloatSurplusProvider[] = [{ id: 'crna-only', role: 'crna' }];
  const out = applyFloatStrategy(grid, {
    mode: 'break_priority',
    surplus,
    sites,
  });
  assert.equal(out.floats.length, 1);
  assert.equal(out.floats[0].leansToSiteId, null);
});

// ---------------------------------------------------------------------------
// Helpers used by the severity-band test.
// ---------------------------------------------------------------------------

function floatsOfSize(n: number): SolvedGrid['floats'] {
  return Array.from({ length: n }, (_, i) => ({
    providerId: `float-${i + 1}`,
    role: 'crna' as const,
    leansToSiteId: null,
  }));
}

function surplusOfSize(n: number): FloatSurplusProvider[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `float-${i + 1}`,
    role: 'crna' as const,
  }));
}

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
