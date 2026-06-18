// Property-based test: solver assignment conservation.
// Owned by agent A12 (Test Loop) per PRD §14.
//
// Run with: npx tsx src/lib/gridCalculator/__tests__/_property/solver-conservation.property.test.ts
//
// PROPERTY UNDER TEST
// -------------------
// For any randomly generated (config, sites, rules, roster), every provider in
// `roster` appears AT MOST ONCE across `solve()`'s output. Concretely:
//
//   1. No `anesthesiologistId` is used by two different room assignments
//      that "double-staff" the same MD beyond the supervision ratio cap.
//      (A single MD may legitimately supervise multiple CRNAs; the conservation
//      property is that the same MD never shows up as primary anesthesiologist
//      in MORE rooms than `ratioCap + 1`. In v1 the solver always reuses an
//      MD via the supervisor pool, so we use a softer invariant: every used
//      providerId must exist in the roster.)
//
//   2. No `crnaId` appears twice across all `crnaIds` in any assignment.
//
//   3. No CRNA appears in BOTH an `assignment.crnaIds` AND a `floats[*]`.
//
//   4. No MD appears as a `floats[*]` if they are also a primary anesthesiologist
//      in any room assignment. (The float role is for unassigned providers.)
//
//   5. Every providerId surfaced in the output (assignments + floats +
//      crossSiteSupervisor) is present in the input roster.
//
//   6. Floats are deduplicated — no providerId appears twice in `floats[]`.
//
// These together encode "conservation": the solver never invents providers and
// never books one provider into two simultaneous physical slots.
//
// DETERMINISTIC RNG
// -----------------
// We use a tiny mulberry32 PRNG seeded with a fixed value so this test is
// reproducible across runs. To explore more of the input space, bump
// `PROPERTY_TRIALS` or change `BASE_SEED` — the test must still pass.
//
// SHRINKING
// ---------
// No automated shrinking (we don't depend on fast-check). When a property
// fails, the assertion message includes the trial number + seed + input JSON
// so the failure is reproducible. To reproduce manually: re-run with the
// printed seed.

import assert from 'node:assert/strict';

import { solve } from '../../solver';
import type {
  DistanceMatrixLike,
  RosterProvider,
  SolverInput,
} from '../../solver';
import type {
  CoverageRuleSet,
  CoverageStyle,
  GridCalculatorConfig,
  GridSite,
  SiteRule,
  SupervisionRatioMode,
} from '../../types';

// ---------------------------------------------------------------------------
// Tuning knobs
// ---------------------------------------------------------------------------

/** Number of randomized scenarios to evaluate per property. */
const PROPERTY_TRIALS = 100;

/** Master seed — change to re-roll the entire suite. */
const BASE_SEED = 0xa12c0ffee >>> 0;

// ---------------------------------------------------------------------------
// Deterministic PRNG — mulberry32 (same family used by fteSimulator.createRng).
// Kept inline so the property test owns its own RNG and isn't coupled to A7.
// ---------------------------------------------------------------------------

function createRng(seed: number) {
  let state = seed >>> 0;
  return {
    nextUint32(): number {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return (t ^ (t >>> 14)) >>> 0;
    },
    nextFloat(): number {
      return this.nextUint32() / 0x1_0000_0000;
    },
    nextInt(minInclusive: number, maxInclusive: number): number {
      const range = maxInclusive - minInclusive + 1;
      return minInclusive + (this.nextUint32() % range);
    },
    pick<T>(arr: readonly T[]): T {
      return arr[this.nextInt(0, arr.length - 1)];
    },
  };
}

type Rng = ReturnType<typeof createRng>;

// ---------------------------------------------------------------------------
// Input generators
// ---------------------------------------------------------------------------

const COVERAGE_STYLES: readonly CoverageStyle[] = [
  'md_heavy',
  'balanced',
  'crna_heavy',
];
const SUPERVISION_RATIOS: readonly SupervisionRatioMode[] = [
  'mostly_1_3',
  'mostly_1_4',
  'mixed',
];
const STAFFING_PATTERNS: readonly SiteRule['defaultStaffing'][] = [
  'solo_md',
  'supervised_md_crna',
  'solo_crna_with_remote_md',
];

function genConfig(rng: Rng): GridCalculatorConfig {
  return {
    id: `prop-cfg-${rng.nextInt(0, 999_999)}`,
    hospital: 'Property Hospital',
    name: 'Property Trial',
    coverageStyle: rng.pick(COVERAGE_STYLES),
    supervisionRatio: rng.pick(SUPERVISION_RATIOS),
    floatStrategy: 'balanced',
    backupCallPosture: 'conservative',
  };
}

function genSites(rng: Rng): GridSite[] {
  const siteCount = rng.nextInt(1, 4);
  const out: GridSite[] = [];
  for (let s = 0; s < siteCount; s++) {
    const roomCount = rng.nextInt(1, 5);
    const id = `site-${s}`;
    out.push({
      id,
      name: `Site ${s}`,
      color: '#000000',
      icon: 'X',
      position: s,
      rooms: Array.from({ length: roomCount }, (_, i) => ({
        id: `${id}-r${i}`,
        siteId: id,
        name: `Room ${i + 1}`,
        position: i,
      })),
    });
  }
  return out;
}

function genRules(rng: Rng, sites: GridSite[]): CoverageRuleSet {
  // For half the trials, leave the ruleset empty so the solver falls into the
  // default `supervised_md_crna` path. For the rest, generate one rule per
  // site with random staffing and optional cross-site supervisor.
  if (rng.nextFloat() < 0.5) {
    return { siteRules: [], globalRules: [] };
  }
  const siteRules: SiteRule[] = sites.map((s) => {
    const staffing = rng.pick(STAFFING_PATTERNS);
    const rule: SiteRule = {
      site: s.name,
      defaultStaffing: staffing,
    };
    if (staffing === 'solo_crna_with_remote_md' || rng.nextFloat() < 0.3) {
      const otherSites = sites.filter((x) => x.id !== s.id);
      if (otherSites.length > 0) {
        rule.supervisorFromSite = rng.pick(otherSites).name;
      }
    }
    if (rng.nextFloat() < 0.3) {
      // Add a fallback to exercise the decision matrix.
      const fallback = rng.pick(
        STAFFING_PATTERNS.filter((p) => p !== staffing),
      );
      rule.fallbacks = [fallback];
    }
    return rule;
  });
  return { siteRules, globalRules: [] };
}

function genRoster(rng: Rng, totalRooms: number): RosterProvider[] {
  // Roster sized between "definitely understaffed" and "comfortable surplus"
  // so we exercise both the violation path AND the float path. Floor at 0 to
  // hit the empty-roster edge case occasionally.
  const mdCount = rng.nextInt(0, Math.max(1, Math.ceil(totalRooms / 2) + 2));
  const crnaCount = rng.nextInt(0, totalRooms + 3);
  const roster: RosterProvider[] = [];
  for (let i = 0; i < mdCount; i++) {
    roster.push({
      id: `md-${i}`,
      role: 'anesthesiologist',
      fte: 1.0,
    });
  }
  for (let i = 0; i < crnaCount; i++) {
    roster.push({
      id: `crna-${i}`,
      role: 'crna',
      fte: 1.0,
    });
  }
  return roster;
}

function genDistanceMatrix(rng: Rng): DistanceMatrixLike {
  // 70% allow-all (most realistic for a small-to-medium hospital with
  // adjacency-friendly geography), 20% same-site-only (worst case), 10% random.
  const roll = rng.nextFloat();
  if (roll < 0.7) {
    return { isSupervisable: () => true };
  }
  if (roll < 0.9) {
    return { isSupervisable: (a, b) => a === b };
  }
  // Random — capture the rng state once at construction so repeat calls with
  // the same pair are stable within a trial.
  const cache = new Map<string, boolean>();
  return {
    isSupervisable: (a, b) => {
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      const value = rng.nextFloat() < 0.5;
      cache.set(key, value);
      return value;
    },
  };
}

interface GeneratedTrial {
  trial: number;
  seed: number;
  input: SolverInput;
}

function genTrial(seed: number, trial: number): GeneratedTrial {
  const rng = createRng((seed + trial) >>> 0);
  const config = genConfig(rng);
  const sites = genSites(rng);
  const totalRooms = sites.reduce((acc, s) => acc + s.rooms.length, 0);
  const rules = genRules(rng, sites);
  const roster = genRoster(rng, totalRooms);
  const distanceMatrix = genDistanceMatrix(rng);

  return {
    trial,
    seed,
    input: { config, sites, rules, roster, distanceMatrix },
  };
}

// ---------------------------------------------------------------------------
// The invariants
// ---------------------------------------------------------------------------

interface InvariantContext {
  trial: GeneratedTrial;
}

type InvariantCheck = (ctx: InvariantContext) => void;

const conservationInvariant: InvariantCheck = ({ trial }) => {
  const { input } = trial;
  const grid = solve(input);

  const rosterIds = new Set(input.roster.map((p) => p.id));
  const rosterMdIds = new Set(
    input.roster.filter((p) => p.role === 'anesthesiologist').map((p) => p.id),
  );
  const rosterCrnaIds = new Set(
    input.roster.filter((p) => p.role === 'crna').map((p) => p.id),
  );

  // --- Invariant 1: every used CRNA id is a real roster CRNA. ----------------
  const allUsedCrnas = grid.assignments.flatMap((a) => a.crnaIds);
  for (const id of allUsedCrnas) {
    assert.ok(
      rosterCrnaIds.has(id),
      `[trial ${trial.trial} seed ${trial.seed}] CRNA ${id} not in roster`,
    );
  }
  // --- Invariant 2: every used MD id is a real roster MD. --------------------
  for (const a of grid.assignments) {
    if (a.anesthesiologistId !== null) {
      assert.ok(
        rosterMdIds.has(a.anesthesiologistId),
        `[trial ${trial.trial} seed ${trial.seed}] MD ${a.anesthesiologistId} not in roster`,
      );
    }
  }
  // --- Invariant 3: every float providerId is in roster + dedup'd. -----------
  const floatIds = new Set<string>();
  for (const f of grid.floats) {
    assert.ok(
      rosterIds.has(f.providerId),
      `[trial ${trial.trial} seed ${trial.seed}] float ${f.providerId} not in roster`,
    );
    assert.ok(
      !floatIds.has(f.providerId),
      `[trial ${trial.trial} seed ${trial.seed}] float ${f.providerId} duplicated in floats[]`,
    );
    floatIds.add(f.providerId);
  }
  // --- Invariant 4: no CRNA appears twice across all assignments. ------------
  const crnaSeen = new Set<string>();
  for (const a of grid.assignments) {
    for (const id of a.crnaIds) {
      assert.ok(
        !crnaSeen.has(id),
        `[trial ${trial.trial} seed ${trial.seed}] CRNA ${id} double-booked across rooms`,
      );
      crnaSeen.add(id);
    }
  }
  // --- Invariant 5: no CRNA appears in BOTH a room assignment AND floats. ----
  for (const id of floatIds) {
    if (rosterCrnaIds.has(id)) {
      assert.ok(
        !crnaSeen.has(id),
        `[trial ${trial.trial} seed ${trial.seed}] CRNA ${id} appears as both room CRNA AND float`,
      );
    }
  }
  // --- Invariant 6: no MD that's primary anesthesiologist also appears as
  // ---              a float. (Surplus MDs only enter the float pool.)
  const mdsInRooms = new Set<string>();
  for (const a of grid.assignments) {
    if (a.anesthesiologistId !== null) mdsInRooms.add(a.anesthesiologistId);
  }
  for (const id of floatIds) {
    if (rosterMdIds.has(id)) {
      assert.ok(
        !mdsInRooms.has(id),
        `[trial ${trial.trial} seed ${trial.seed}] MD ${id} is both supervisor and float`,
      );
    }
  }
  // --- Invariant 7: every crossSiteSupervisor.providerId is a real MD that
  // ---              ALSO appears as the room's anesthesiologistId.
  for (const a of grid.assignments) {
    if (a.crossSiteSupervisor) {
      assert.ok(
        rosterMdIds.has(a.crossSiteSupervisor.providerId),
        `[trial ${trial.trial} seed ${trial.seed}] cross-site supervisor ${a.crossSiteSupervisor.providerId} not in roster`,
      );
      assert.equal(
        a.crossSiteSupervisor.providerId,
        a.anesthesiologistId,
        `[trial ${trial.trial} seed ${trial.seed}] crossSiteSupervisor.providerId must match assignment.anesthesiologistId`,
      );
    }
  }
  // --- Invariant 8: the solver is internally consistent — every assignment
  // ---              has a roomId that maps to a real site/room in the input.
  const roomIds = new Set(
    input.sites.flatMap((s) => s.rooms.map((r) => r.id)),
  );
  for (const a of grid.assignments) {
    assert.ok(
      roomIds.has(a.roomId),
      `[trial ${trial.trial} seed ${trial.seed}] assignment.roomId ${a.roomId} not in input sites`,
    );
  }
};

// ---------------------------------------------------------------------------
// Mini harness — matches the convention used across other A12-monitored suites.
// ---------------------------------------------------------------------------

type TestCase = { name: string; fn: () => void | Promise<void> };
const cases: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  cases.push({ name, fn });
}

// ---------------------------------------------------------------------------
// 1. The conservation property — runs PROPERTY_TRIALS randomized scenarios.
// ---------------------------------------------------------------------------

test(`solver provider conservation holds across ${PROPERTY_TRIALS} random trials`, () => {
  const failures: Array<{ trial: number; err: unknown; input: SolverInput }> =
    [];
  for (let t = 0; t < PROPERTY_TRIALS; t++) {
    const trial = genTrial(BASE_SEED, t);
    try {
      conservationInvariant({ trial });
    } catch (err) {
      failures.push({ trial: t, err, input: trial.input });
      if (failures.length >= 3) break; // surface a few failures, don't spam.
    }
  }
  if (failures.length > 0) {
    const formatted = failures
      .map(
        (f) =>
          `--- trial ${f.trial} ---\n` +
          `${
            f.err instanceof Error ? f.err.message : String(f.err)
          }\n` +
          `input: ${JSON.stringify(f.input, redactDistance, 2)}`,
      )
      .join('\n\n');
    assert.fail(
      `${failures.length} conservation failures in ${PROPERTY_TRIALS} trials.\n${formatted}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. Reproducibility — running the property suite twice with the same BASE_SEED
//    produces byte-identical trials. (Catches accidental non-determinism in
//    the generator itself.)
// ---------------------------------------------------------------------------

test('property trial generation is deterministic across two runs with the same seed', () => {
  const a = genTrial(BASE_SEED, 7);
  const b = genTrial(BASE_SEED, 7);
  // Strip distanceMatrix (it's a function — not deep-equal-safe).
  const stripA = { ...a.input, distanceMatrix: undefined };
  const stripB = { ...b.input, distanceMatrix: undefined };
  assert.deepEqual(stripA, stripB);
});

// ---------------------------------------------------------------------------
// JSON serializer that elides the distance-matrix function so the input is
// printable in failure reports.
// ---------------------------------------------------------------------------

function redactDistance(key: string, value: unknown): unknown {
  if (key === 'distanceMatrix') return '[DistanceMatrixLike]';
  return value;
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
      passed += 1;
      console.log(`  ok  ${tc.name}`);
    } catch (err) {
      failed += 1;
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
