// Unit tests for the deterministic single-day grid solver.
// Owned by agent A3 (Coverage Algorithm).
//
// Run with: npx tsx src/lib/gridCalculator/__tests__/solver.test.ts
// (vitest is not configured in this repo; tsx + node:assert keeps the test
// suite zero-dependency.)

import assert from 'node:assert/strict';

import { solve } from '../solver';
import type {
  DistanceMatrixLike,
  RosterProvider,
  SolverInput,
} from '../solver';
import type {
  CoverageRuleSet,
  GridCalculatorConfig,
  GridSite,
  SiteRule,
} from '../types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseConfig: GridCalculatorConfig = {
  id: 'cfg-1',
  hospital: 'Test Hospital',
  name: 'Default',
  coverageStyle: 'balanced',
  supervisionRatio: 'mostly_1_4',
  floatStrategy: 'balanced',
  backupCallPosture: 'conservative',
};

function makeRoom(id: string, siteId: string, name: string, position: number) {
  return { id, siteId, name, position };
}

function mainOR(roomCount: number): GridSite {
  return {
    id: 'site-main',
    name: 'Main OR',
    color: '#4A90D9',
    icon: 'OR',
    position: 0,
    rooms: Array.from({ length: roomCount }, (_, i) =>
      makeRoom(`main-r${i + 1}`, 'site-main', `OR ${i + 1}`, i),
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

const allReachable: DistanceMatrixLike = { isSupervisable: () => true };
const neverReachable: DistanceMatrixLike = {
  isSupervisable: (from, to) => from === to,
};

// ---------------------------------------------------------------------------
// Mini test harness — just walk the registered cases.
// ---------------------------------------------------------------------------

type TestCase = { name: string; fn: () => void | Promise<void> };
const cases: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  cases.push({ name, fn });
}

// ---------------------------------------------------------------------------
// 1. Empty roster → violations for every room, no throw.
// ---------------------------------------------------------------------------

test('empty roster surfaces a violation for every room and does not throw', () => {
  const input: SolverInput = {
    config: baseConfig,
    sites: [mainOR(3)],
    rules: noRules,
    roster: [],
  };
  const out = solve(input);
  assert.equal(out.assignments.length, 3);
  // Default pattern is supervised_md_crna → CRNA missing → 1 violation per room
  // + ONE site-level "No rule" violation (the noRules input has no rule for
  // the Main OR site).
  const crnaViolations = out.violations.filter((v) =>
    v.includes('no CRNA available'),
  );
  const noRuleViolations = out.violations.filter((v) =>
    v.startsWith('No rule for site'),
  );
  assert.equal(crnaViolations.length, 3);
  assert.equal(noRuleViolations.length, 1);
  // No rooms staffed.
  assert.ok(out.assignments.every((a) => a.anesthesiologistId === null));
  assert.ok(out.assignments.every((a) => a.crnaIds.length === 0));
  // Per-room defaultedFromRule flag is set on every room (Bug 5 fix).
  assert.ok(out.assignments.every((a) => a.defaultedFromRule === true));
  assert.equal(out.floats.length, 0);
});

// ---------------------------------------------------------------------------
// 2. 1 MD + 4 CRNAs + 1 Main OR site (4 rooms) + mostly_1_4 → 1:4 supervised.
// ---------------------------------------------------------------------------

test('mostly_1_4 with 1 MD + 4 CRNAs covers 4 rooms 1:4', () => {
  const input: SolverInput = {
    config: { ...baseConfig, supervisionRatio: 'mostly_1_4' },
    sites: [mainOR(4)],
    rules: noRules,
    roster: [
      makeProvider('md-1', 'anesthesiologist'),
      makeProvider('crna-1', 'crna'),
      makeProvider('crna-2', 'crna'),
      makeProvider('crna-3', 'crna'),
      makeProvider('crna-4', 'crna'),
    ],
  };
  const out = solve(input);
  // Only the "no rule" defaulting violation should be present (noRules input).
  const nonDefaultViolations = out.violations.filter(
    (v) => !v.startsWith('No rule for site'),
  );
  assert.deepEqual(nonDefaultViolations, []);
  // All 4 rooms staffed by md-1 with one CRNA each.
  const mdIds = new Set(out.assignments.map((a) => a.anesthesiologistId));
  assert.deepEqual([...mdIds], ['md-1']);
  const crnasUsed = out.assignments.flatMap((a) => a.crnaIds).sort();
  assert.deepEqual(crnasUsed, ['crna-1', 'crna-2', 'crna-3', 'crna-4']);
});

// ---------------------------------------------------------------------------
// 3. Same setup under mostly_1_3 → violation flagged (1 MD can't take 4).
// ---------------------------------------------------------------------------

test('mostly_1_3 flags a violation when only 1 MD must cover 4 CRNA rooms', () => {
  const input: SolverInput = {
    config: { ...baseConfig, supervisionRatio: 'mostly_1_3' },
    sites: [mainOR(4)],
    rules: noRules,
    roster: [
      makeProvider('md-1', 'anesthesiologist'),
      makeProvider('crna-1', 'crna'),
      makeProvider('crna-2', 'crna'),
      makeProvider('crna-3', 'crna'),
      makeProvider('crna-4', 'crna'),
    ],
  };
  const out = solve(input);
  assert.ok(out.violations.length >= 1);
  // First 3 rooms staffed by md-1; the 4th can't find a supervisor.
  const firstThree = out.assignments.slice(0, 3);
  assert.ok(firstThree.every((a) => a.anesthesiologistId === 'md-1'));
  const last = out.assignments[3];
  assert.equal(last.anesthesiologistId, null);
  assert.ok(
    out.violations.some((v) => v.includes('no Anesthesiologist available to supervise')),
  );
});

// ---------------------------------------------------------------------------
// 4. Cross-site supervision blocked when distance is `far`.
// ---------------------------------------------------------------------------

test('cross-site supervision blocked when distanceMatrix returns false', () => {
  const mainOROne = mainOR(1);
  // 4th-floor MD already supervising 3 CRNAs at Main OR; EP Lab room must be
  // supervised — but distance says far → must fall back to local MD.
  const epSite: GridSite = {
    id: 'site-ep',
    name: 'EP Lab',
    color: '#29B6F6',
    icon: 'EP',
    position: 1,
    rooms: [makeRoom('ep-r1', 'site-ep', 'EP 1', 0)],
  };
  const rules: CoverageRuleSet = {
    siteRules: [
      {
        site: 'EP Lab',
        defaultStaffing: 'supervised_md_crna',
        supervisorFromSite: 'Main OR',
      },
    ],
    globalRules: [],
  };
  const input: SolverInput = {
    config: { ...baseConfig, supervisionRatio: 'mostly_1_4' },
    sites: [mainOROne, epSite],
    rules,
    roster: [
      makeProvider('md-1', 'anesthesiologist'),
      makeProvider('md-2', 'anesthesiologist'),
      makeProvider('crna-1', 'crna'),
      makeProvider('crna-2', 'crna'),
    ],
    distanceMatrix: neverReachable, // far ≡ not reachable
  };
  const out = solve(input);
  // EP Lab room must not be cross-site-supervised by md-1.
  const epAssignment = out.assignments.find((a) => a.siteId === 'site-ep');
  assert.ok(epAssignment);
  assert.equal(epAssignment!.crossSiteSupervisor, undefined);
  // It should instead consume a second MD on-site.
  assert.equal(epAssignment!.anesthesiologistId, 'md-2');
});

test('cross-site supervision allowed when distanceMatrix returns true', () => {
  const mainOROne = mainOR(1);
  const epSite: GridSite = {
    id: 'site-ep',
    name: 'EP Lab',
    color: '#29B6F6',
    icon: 'EP',
    position: 1,
    rooms: [makeRoom('ep-r1', 'site-ep', 'EP 1', 0)],
  };
  const rules: CoverageRuleSet = {
    siteRules: [
      {
        site: 'EP Lab',
        defaultStaffing: 'supervised_md_crna',
        supervisorFromSite: 'Main OR',
      },
    ],
    globalRules: [],
  };
  const input: SolverInput = {
    config: { ...baseConfig, supervisionRatio: 'mostly_1_4' },
    sites: [mainOROne, epSite],
    rules,
    roster: [
      makeProvider('md-1', 'anesthesiologist'),
      makeProvider('crna-1', 'crna'),
      makeProvider('crna-2', 'crna'),
    ],
    distanceMatrix: allReachable,
  };
  const out = solve(input);
  const epAssignment = out.assignments.find((a) => a.siteId === 'site-ep');
  assert.ok(epAssignment);
  assert.equal(epAssignment!.anesthesiologistId, 'md-1');
  assert.deepEqual(epAssignment!.crossSiteSupervisor, {
    providerId: 'md-1',
    fromSiteId: 'site-main',
  });
});

// ---------------------------------------------------------------------------
// 5. md_heavy switches an EP Lab site from supervised to solo when allowed.
// ---------------------------------------------------------------------------

test('md_heavy flips EP Lab site to solo_md when fallback permits', () => {
  const epSite: GridSite = {
    id: 'site-ep',
    name: 'EP Lab',
    color: '#29B6F6',
    icon: 'EP',
    position: 0,
    rooms: [makeRoom('ep-r1', 'site-ep', 'EP 1', 0)],
  };
  const rules: CoverageRuleSet = {
    siteRules: [
      {
        site: 'EP Lab',
        defaultStaffing: 'supervised_md_crna',
        fallbacks: ['solo_md'],
      },
    ],
    globalRules: [],
  };
  const input: SolverInput = {
    config: { ...baseConfig, coverageStyle: 'md_heavy' },
    sites: [epSite],
    rules,
    roster: [
      makeProvider('md-1', 'anesthesiologist'),
      makeProvider('crna-1', 'crna'),
    ],
  };
  const out = solve(input);
  assert.deepEqual(out.violations, []);
  const ep = out.assignments.find((a) => a.siteId === 'site-ep');
  assert.ok(ep);
  assert.equal(ep!.staffingPattern, 'solo_md');
  assert.equal(ep!.anesthesiologistId, 'md-1');
  assert.deepEqual(ep!.crnaIds, []);
});

// ---------------------------------------------------------------------------
// 6. Extra roster capacity → at least one float emitted.
// ---------------------------------------------------------------------------

test('solver emits ZERO floats regardless of roster surplus (A6 owns the float pool)', () => {
  // Surplus CRNAs are NOT allocated by the solver — A6 (Float Strategy) owns
  // the float pool and consumes the SolvedGrid + a separately-computed
  // surplus list. The solver's `floats` array is intentionally empty.
  const input: SolverInput = {
    config: { ...baseConfig, supervisionRatio: 'mostly_1_4' },
    sites: [mainOR(2)],
    rules: noRules,
    roster: [
      makeProvider('md-1', 'anesthesiologist'),
      makeProvider('crna-1', 'crna'),
      makeProvider('crna-2', 'crna'),
      makeProvider('crna-3', 'crna'), // surplus — still NOT emitted as float.
    ],
  };
  const out = solve(input);
  const nonDefaultViolations = out.violations.filter(
    (v) => !v.startsWith('No rule for site'),
  );
  assert.deepEqual(nonDefaultViolations, []);
  assert.deepEqual(out.floats, []);
});

// ---------------------------------------------------------------------------
// 7. Deterministic: same input twice → identical output.
// ---------------------------------------------------------------------------

test('deterministic: same input yields identical output across runs', () => {
  const input: SolverInput = {
    config: baseConfig,
    sites: [mainOR(4)],
    rules: noRules,
    roster: [
      makeProvider('md-2', 'anesthesiologist'),
      makeProvider('md-1', 'anesthesiologist'),
      makeProvider('crna-3', 'crna'),
      makeProvider('crna-1', 'crna'),
      makeProvider('crna-4', 'crna'),
      makeProvider('crna-2', 'crna'),
    ],
  };
  const a = solve(input);
  const b = solve(input);
  assert.deepEqual(a, b);
  // Stable sort by id: md-1 is taken first, so room 1's anesthesiologist is md-1.
  assert.equal(a.assignments[0].anesthesiologistId, 'md-1');
  assert.equal(a.assignments[0].crnaIds[0], 'crna-1');
});

// ---------------------------------------------------------------------------
// 8. Toggle change re-solves with no leftover state.
// ---------------------------------------------------------------------------

test('toggle change re-solves cleanly with no leftover state', () => {
  const roster = [
    makeProvider('md-1', 'anesthesiologist'),
    makeProvider('md-2', 'anesthesiologist'),
    makeProvider('crna-1', 'crna'),
    makeProvider('crna-2', 'crna'),
    makeProvider('crna-3', 'crna'),
    makeProvider('crna-4', 'crna'),
  ];
  const sites = [mainOR(4)];
  const out1 = solve({
    config: { ...baseConfig, supervisionRatio: 'mostly_1_4' },
    sites,
    rules: noRules,
    roster,
  });
  // All four rooms supervised by md-1 (no need for md-2).
  assert.ok(out1.assignments.every((a) => a.anesthesiologistId === 'md-1'));

  const out2 = solve({
    config: { ...baseConfig, supervisionRatio: 'mostly_1_3' },
    sites,
    rules: noRules,
    roster,
  });
  // First three rooms md-1, fourth room md-2 (cap of 3 exceeded).
  assert.equal(out2.assignments[0].anesthesiologistId, 'md-1');
  assert.equal(out2.assignments[1].anesthesiologistId, 'md-1');
  assert.equal(out2.assignments[2].anesthesiologistId, 'md-1');
  assert.equal(out2.assignments[3].anesthesiologistId, 'md-2');
  // Only the "no rule" defaulting violation is expected under noRules input.
  const out2NonDefault = out2.violations.filter(
    (v) => !v.startsWith('No rule for site'),
  );
  assert.deepEqual(out2NonDefault, []);

  // A third solve back to the original toggle should match out1 exactly.
  const out3 = solve({
    config: { ...baseConfig, supervisionRatio: 'mostly_1_4' },
    sites,
    rules: noRules,
    roster,
  });
  assert.deepEqual(out3, out1);
});

// ---------------------------------------------------------------------------
// 9. crna_heavy + balanced solver consumes MD/CRNA differently.
// ---------------------------------------------------------------------------

test('crna_heavy prefers supervised_md_crna over solo_md when both available', () => {
  const epSite: GridSite = {
    id: 'site-ep',
    name: 'EP Lab',
    color: '#29B6F6',
    icon: 'EP',
    position: 0,
    rooms: [makeRoom('ep-r1', 'site-ep', 'EP 1', 0)],
  };
  const rules: CoverageRuleSet = {
    siteRules: [
      {
        site: 'EP Lab',
        defaultStaffing: 'solo_md',
        fallbacks: ['supervised_md_crna'],
      } satisfies SiteRule,
    ],
    globalRules: [],
  };
  const input: SolverInput = {
    config: { ...baseConfig, coverageStyle: 'crna_heavy' },
    sites: [epSite],
    rules,
    roster: [
      makeProvider('md-1', 'anesthesiologist'),
      makeProvider('crna-1', 'crna'),
    ],
  };
  const out = solve(input);
  const ep = out.assignments[0];
  assert.equal(ep.staffingPattern, 'supervised_md_crna');
  assert.equal(ep.anesthesiologistId, 'md-1');
  assert.deepEqual(ep.crnaIds, ['crna-1']);
});

// ---------------------------------------------------------------------------
// 10. Sites walked in `position` order.
// ---------------------------------------------------------------------------

test('sites are walked in position order; output is stable', () => {
  const a: GridSite = {
    id: 'site-a',
    name: 'A',
    color: '#000',
    icon: 'A',
    position: 2,
    rooms: [makeRoom('a-r1', 'site-a', 'A1', 0)],
  };
  const b: GridSite = {
    id: 'site-b',
    name: 'B',
    color: '#000',
    icon: 'B',
    position: 0,
    rooms: [makeRoom('b-r1', 'site-b', 'B1', 0)],
  };
  const c: GridSite = {
    id: 'site-c',
    name: 'C',
    color: '#000',
    icon: 'C',
    position: 1,
    rooms: [makeRoom('c-r1', 'site-c', 'C1', 0)],
  };
  const input: SolverInput = {
    config: baseConfig,
    sites: [a, b, c],
    rules: noRules,
    roster: [
      makeProvider('md-1', 'anesthesiologist'),
      makeProvider('md-2', 'anesthesiologist'),
      makeProvider('md-3', 'anesthesiologist'),
      makeProvider('crna-1', 'crna'),
      makeProvider('crna-2', 'crna'),
      makeProvider('crna-3', 'crna'),
    ],
  };
  const out = solve(input);
  assert.deepEqual(
    out.assignments.map((row) => row.siteId),
    ['site-b', 'site-c', 'site-a'],
  );
});

// ---------------------------------------------------------------------------
// 11. SiteRule.maxSupervisionRatio overrides the global supervision ratio cap.
//     Per A14 Drift 2: per-site cap takes precedence over the global toggle.
// ---------------------------------------------------------------------------

test('SiteRule.maxSupervisionRatio per-site cap overrides global supervision ratio', () => {
  // Global is mostly_1_4 (cap = 4) but the site rule pins maxSupervisionRatio
  // to '1:2' — so a single MD must only supervise up to 2 CRNAs at this site.
  // With 1 MD + 3 CRNAs covering 3 rooms, room 3 must seat a fresh MD because
  // md-1 is capped at 2 by the per-site rule.
  const site = mainOR(3);
  const rules: CoverageRuleSet = {
    siteRules: [
      {
        site: 'Main OR',
        defaultStaffing: 'supervised_md_crna',
        maxSupervisionRatio: '1:2',
      },
    ],
    globalRules: [],
  };
  const input: SolverInput = {
    config: { ...baseConfig, supervisionRatio: 'mostly_1_4' },
    sites: [site],
    rules,
    roster: [
      makeProvider('md-1', 'anesthesiologist'),
      makeProvider('md-2', 'anesthesiologist'),
      makeProvider('crna-1', 'crna'),
      makeProvider('crna-2', 'crna'),
      makeProvider('crna-3', 'crna'),
    ],
  };
  const out = solve(input);
  assert.deepEqual(out.violations, []);
  // First two rooms supervised by md-1 (at cap = 2). Third room must seat md-2.
  assert.equal(out.assignments[0].anesthesiologistId, 'md-1');
  assert.equal(out.assignments[1].anesthesiologistId, 'md-1');
  assert.equal(out.assignments[2].anesthesiologistId, 'md-2');
});

// ---------------------------------------------------------------------------
// 12. Site key fallback (rule resolved by id, not name) raises a violation.
//     Per code review: the fallback rescues a normalizer contract violation
//     and we must surface it so the drift is visible.
// ---------------------------------------------------------------------------

test('site rule resolved by id (not name) raises a normalizer-contract violation', () => {
  // Rule keyed by the site's UUID, NOT its human-readable name — this is the
  // normalizer contract violation we want to surface.
  const site = mainOR(1);
  const rules: CoverageRuleSet = {
    siteRules: [
      {
        site: 'site-main', // intentionally the id, not 'Main OR'
        defaultStaffing: 'supervised_md_crna',
      },
    ],
    globalRules: [],
  };
  const input: SolverInput = {
    config: baseConfig,
    sites: [site],
    rules,
    roster: [
      makeProvider('md-1', 'anesthesiologist'),
      makeProvider('crna-1', 'crna'),
    ],
  };
  const out = solve(input);
  // The fallback worked — the room is staffed — but the violation was logged.
  assert.equal(out.assignments[0].anesthesiologistId, 'md-1');
  assert.equal(out.assignments[0].crnaIds[0], 'crna-1');
  assert.ok(
    out.violations.some((v) =>
      v.includes('Site rule resolved by id; normalizer should emit human-readable name for site-main'),
    ),
    `expected normalizer-contract violation, got: ${out.violations.join(' | ')}`,
  );
});

// ---------------------------------------------------------------------------
// 13. globalRules round-trip with an audit violation for unsupported kinds.
//     Per A14 Drift 2: the solver currently understands NO globalRule kinds,
//     so every round-tripped GlobalRule must surface a per-kind audit entry.
// ---------------------------------------------------------------------------

test('globalRules round-trip with an audit violation for unsupported kinds', () => {
  const site = mainOR(1);
  const rules: CoverageRuleSet = {
    siteRules: [
      {
        site: 'Main OR',
        defaultStaffing: 'supervised_md_crna',
      },
    ],
    globalRules: [
      { kind: 'max_supervision_ratio', payload: { ratio: '1:3' } },
      { kind: 'trauma_priority', payload: {} },
    ],
  };
  const input: SolverInput = {
    config: baseConfig,
    sites: [site],
    rules,
    roster: [
      makeProvider('md-1', 'anesthesiologist'),
      makeProvider('crna-1', 'crna'),
    ],
  };
  const out = solve(input);
  const globalRuleViolations = out.violations.filter((v) =>
    v.startsWith('GlobalRule kind='),
  );
  assert.equal(globalRuleViolations.length, 2);
  assert.ok(
    globalRuleViolations.some((v) => v.includes('max_supervision_ratio')),
  );
  assert.ok(globalRuleViolations.some((v) => v.includes('trauma_priority')));
  // Audit message format includes the "see A4 notes" pointer.
  assert.ok(globalRuleViolations.every((v) => v.includes('see A4 notes')));
});

// ---------------------------------------------------------------------------
// 14. defaultedFromRule is emitted on RoomAssignment when no rule matches.
//     Per code review INFO: the silent "no rule → supervised_md_crna" default
//     used to be invisible — now we surface it both as a per-site violation
//     and a per-room flag.
// ---------------------------------------------------------------------------

test('defaultedFromRule flag + violation surface when no SiteRule matches a site', () => {
  const site = mainOR(2);
  const input: SolverInput = {
    config: baseConfig,
    sites: [site],
    rules: noRules,
    roster: [
      makeProvider('md-1', 'anesthesiologist'),
      makeProvider('crna-1', 'crna'),
      makeProvider('crna-2', 'crna'),
    ],
  };
  const out = solve(input);
  // Every room's assignment carries the defaulted flag.
  assert.ok(out.assignments.every((a) => a.defaultedFromRule === true));
  // Exactly one per-site "No rule" violation is logged (NOT one per room).
  const defaultedViolations = out.violations.filter((v) =>
    v.startsWith('No rule for site Main OR'),
  );
  assert.equal(defaultedViolations.length, 1);
  // The staffing pattern landed on the documented supervised_md_crna default.
  assert.ok(out.assignments.every((a) => a.staffingPattern === 'supervised_md_crna'));
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
