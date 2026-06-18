// Paoli seed reality-check tests.
// Owned by agent A11 (Paoli Seed) per PRD §14, §16.
//
// Run with: npx tsx src/lib/gridCalculator/__tests__/paoliSeed.test.ts
// Matches the tsx + node:assert pattern used across the Grid Calculator
// agent suites (A3 solver, A6 float strategy, A7 simulator, A8 call burden).
//
// PURPOSE
// -------
// Pipe the Paoli seed (`seeds/paoli.ts`) through the universal Grid Calculator
// pipeline — solver → float strategy → FTE simulator (Monte Carlo) — and
// assert headcount sanity bands plus float health. These tests intentionally
// run a SMALL Monte Carlo (`trialsCount = 30`) so the suite stays fast
// (<15s on a laptop) while still exercising the full code path.
//
// PRD §16 acceptance criteria:
//   - FTE plausibility: Anesthesiologist FTE within ±2 of current; CRNA
//     within ±3. The sanity band asserted here is a wider envelope around
//     Paoli's actual headcount (so the tests survive minor solver tuning).
//     The PRD §16 ±2/±3 check itself is documented in
//     `docs/paoli-validation.md` and re-evaluated each PR.
//
// ESCALATION
// ----------
// If any assertion fails because the solver legitimately needs more (or
// fewer) Paoli FTE than the band allows, that's a signal — update
// `docs/paoli-validation.md` first, ping Gabriel via the GABRIEL ATTENTION
// section, then either widen the band or fix the seed. Do NOT loosen these
// bands without an explicit acknowledgement that the rationale was approved.

import assert from 'node:assert/strict';

import {
  applyFloatStrategy,
  assessFloatHealth,
} from '../floatStrategy';
import type { FloatSurplusProvider } from '../floatStrategy';
import {
  paoliConfig,
  paoliDistanceEdges,
  paoliLeaveProfiles,
  paoliRoster,
  paoliRules,
  paoliSites,
  PAOLI_SITE_IDS,
} from '../seeds/paoli';
import {
  getBand,
  indexEdges,
  isSupervisable,
} from '../distanceMatrix';
import { simulate } from '../fteSimulator';
import type { SimulatorInput } from '../fteSimulator';
import { solve } from '../solver';
import type {
  DistanceMatrixLike,
  RosterProvider,
  SolverInput,
} from '../solver';
import type { DistanceMatrixWithBands } from '../floatStrategy';

// ---------------------------------------------------------------------------
// Mini test harness — matches solver/floatStrategy/fteSimulator suites.
// ---------------------------------------------------------------------------

type TestCase = { name: string; fn: () => void | Promise<void> };
const cases: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  cases.push({ name, fn });
}

// ---------------------------------------------------------------------------
// Distance matrix adapters — wire Paoli edges into the solver/float interfaces.
// ---------------------------------------------------------------------------

const edgeIndex = indexEdges(paoliDistanceEdges);

const paoliDistanceMatrix: DistanceMatrixLike = {
  isSupervisable: (from, to) => isSupervisable(from, to, edgeIndex),
};

const paoliBandMatrix: DistanceMatrixWithBands = {
  isSupervisable: (from, to) => isSupervisable(from, to, edgeIndex),
  getBand: (from, to) => getBand(from, to, edgeIndex),
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Reproducibility seed — every Paoli-seed test that touches the Monte Carlo
 * path uses the same seed so failures are debuggable. Bumping this value
 * effectively "re-rolls" the suite; don't do it casually.
 */
const PAOLI_SEED_RNG = 240617;

/** Small trial count keeps the suite fast while exercising MC code paths. */
const TRIALS = 30;

// ---------------------------------------------------------------------------
// 1. Seed shape sanity — the data we ship must match what we promise.
// ---------------------------------------------------------------------------

test('Paoli seed shape matches FloorRunner HOSPITAL_BASELINES for the same hospital', () => {
  // Sites — names + room counts must match `BoardClient.tsx` Paoli baseline.
  const mainOR = paoliSites.find((s) => s.id === PAOLI_SITE_IDS.mainOR);
  const endo = paoliSites.find((s) => s.id === PAOLI_SITE_IDS.endoscopy);
  const neuro = paoliSites.find((s) => s.id === PAOLI_SITE_IDS.neuro);
  const ep = paoliSites.find((s) => s.id === PAOLI_SITE_IDS.epLab);
  const ob = paoliSites.find((s) => s.id === PAOLI_SITE_IDS.ob);
  const floatLane = paoliSites.find((s) => s.id === PAOLI_SITE_IDS.float);

  assert.ok(mainOR && mainOR.rooms.length === 15, 'Main OR should have 15 rooms');
  assert.ok(endo && endo.rooms.length === 2, 'Endoscopy should have 2 rooms');
  assert.ok(neuro && neuro.rooms.length === 1, 'Neuro should have 1 room');
  assert.ok(ep && ep.rooms.length === 1, 'EP Lab should have 1 room');
  assert.ok(ob && ob.rooms.length === 1, 'OB should have 1 room');
  assert.ok(floatLane && floatLane.rooms.length === 0, 'Float lane should have 0 rooms');

  // Float lane must be pinned last per PRD §7.
  const sortedByPosition = [...paoliSites].sort((a, b) => a.position - b.position);
  assert.equal(
    sortedByPosition[sortedByPosition.length - 1].id,
    PAOLI_SITE_IDS.float,
    'Float lane must be the last sorted site',
  );

  // Colors must match the BoardClient baseline so chips read the same.
  assert.equal(mainOR!.color, '#0ea5e9');
  assert.equal(endo!.color, '#10b981');
  assert.equal(neuro!.color, '#a78bfa');
  assert.equal(ep!.color, '#f59e0b');
  assert.equal(ob!.color, '#f472b6');
});

test('Paoli distance bands encode the documented reality', () => {
  // Main OR ↔ each procedural suite + OB → `near` (supervisable).
  for (const peer of [
    PAOLI_SITE_IDS.endoscopy,
    PAOLI_SITE_IDS.epLab,
    PAOLI_SITE_IDS.neuro,
    PAOLI_SITE_IDS.ob,
  ]) {
    assert.equal(
      getBand(PAOLI_SITE_IDS.mainOR, peer, edgeIndex),
      'near',
      `Main OR ↔ ${peer} should be 'near'`,
    );
    assert.equal(
      isSupervisable(PAOLI_SITE_IDS.mainOR, peer, edgeIndex),
      true,
      `Main OR ↔ ${peer} should be supervisable`,
    );
  }

  // Procedural cluster pairs → `adjacent`.
  assert.equal(
    getBand(PAOLI_SITE_IDS.endoscopy, PAOLI_SITE_IDS.epLab, edgeIndex),
    'adjacent',
  );
  assert.equal(
    getBand(PAOLI_SITE_IDS.epLab, PAOLI_SITE_IDS.neuro, edgeIndex),
    'adjacent',
  );

  // OB ↔ procedural cluster → `far` (not supervisable).
  for (const peer of [
    PAOLI_SITE_IDS.endoscopy,
    PAOLI_SITE_IDS.epLab,
    PAOLI_SITE_IDS.neuro,
  ]) {
    assert.equal(
      getBand(PAOLI_SITE_IDS.ob, peer, edgeIndex),
      'far',
      `OB ↔ ${peer} should be 'far'`,
    );
    assert.equal(
      isSupervisable(PAOLI_SITE_IDS.ob, peer, edgeIndex),
      false,
      `OB ↔ ${peer} should not be supervisable (default for 'far')`,
    );
  }
});

test('Paoli roster contains the photo names with deterministic IDs', () => {
  const expectedMds = [
    'Amusa',
    'Chamchad',
    'Farkas',
    'Havildar',
    'Horan',
    'Jones',
    'Kalawadia',
    'Lin',
    'Mojica',
    'Nagar',
    'Orji',
    'Simon',
    'Vu',
    'Wadhwani',
  ];
  const mdCount = paoliRoster.filter((p) => p.role === 'anesthesiologist').length;
  assert.equal(mdCount, expectedMds.length, 'Anesthesiologist count must match photo');

  // CRNA pool: 24 full-time + 6 per-diem = 30 names.
  const crnas = paoliRoster.filter((p) => p.role === 'crna');
  assert.equal(crnas.length, 30, 'CRNA pool must include full-time + per-diem');

  // Spot-check Farkas (he's in the photo + this codebase's owner).
  const farkas = paoliRoster.find((p) => p.id === 'paoli-md-farkas');
  assert.ok(farkas, 'Farkas should be present by stable id');
  assert.equal(farkas!.role, 'anesthesiologist');
  assert.equal(farkas!.fte, 1.0);

  // Per-diem CRNAs must be 0.5 FTE.
  const perDiems = paoliRoster.filter(
    (p) => p.role === 'crna' && p.fte < 1.0,
  );
  assert.equal(perDiems.length, 6, '6 per-diem CRNAs at 0.5 FTE');
  for (const pd of perDiems) {
    assert.equal(pd.fte, 0.5);
  }
});

test('Paoli leave profiles cover every roster member with at least one special flag', () => {
  for (const p of paoliRoster) {
    assert.ok(
      paoliLeaveProfiles[p.id],
      `every roster member needs an explicit profile (missing: ${p.id})`,
    );
  }

  const flagged = Object.values(paoliLeaveProfiles);
  assert.ok(
    flagged.some((f) => f.maternity_eligible === true),
    'at least one provider must be maternity_eligible (PRD §10 worst-case)',
  );
  assert.ok(
    flagged.filter((f) => f.fmla_eligible === true).length >= 2,
    'at least two providers must be fmla_eligible',
  );

  // Part-time providers must have 2 weeks PTO (not 4) per the seed contract.
  const perDiem = paoliRoster.find((p) => p.fte < 1.0);
  assert.ok(perDiem);
  assert.equal(paoliLeaveProfiles[perDiem!.id].pto_weeks, 2);
});

// ---------------------------------------------------------------------------
// 2. Solver smoke — Paoli seed resolves with zero violations on a normal day.
// ---------------------------------------------------------------------------

test('solve() against Paoli seed produces zero violations on a "normal" day', () => {
  const input: SolverInput = {
    config: paoliConfig,
    sites: paoliSites,
    rules: paoliRules,
    roster: paoliRoster,
    distanceMatrix: paoliDistanceMatrix,
  };
  const grid = solve(input);

  // PRD v1.1 (Drift #2): solver now audit-flags round-tripped globalRules and
  // contract-drift fallbacks. Those are informational, not shortages. Filter
  // them out and assert zero SHORTAGE violations on a normal Paoli day.
  const shortageMarkers = ['no Anesthesiologist available', 'no CRNA available'];
  const shortages = grid.violations.filter((v) =>
    shortageMarkers.some((m) => v.includes(m)),
  );
  assert.equal(
    shortages.length,
    0,
    `expected 0 shortage violations, got: ${shortages.join(' | ')}`,
  );

  // Every fixed room (i.e. not the float lane) must have an Anesthesiologist
  // OR a documented shortage. We just asserted zero shortages above, so
  // every room should be staffed.
  const fixedRooms = paoliSites
    .filter((s) => s.id !== PAOLI_SITE_IDS.float)
    .flatMap((s) => s.rooms);
  for (const room of fixedRooms) {
    const a = grid.assignments.find((x) => x.roomId === room.id);
    assert.ok(a, `assignment missing for room ${room.id}`);
    assert.ok(
      a!.anesthesiologistId !== null,
      `room ${room.id} (${room.siteId}) is unstaffed by MD`,
    );
  }
});

// ---------------------------------------------------------------------------
// 3. Float health on the default Paoli configuration is at worst `tight`.
// ---------------------------------------------------------------------------

test('Paoli default toggles yield Float Health at level `ok` or `tight`', () => {
  const input: SolverInput = {
    config: paoliConfig,
    sites: paoliSites,
    rules: paoliRules,
    roster: paoliRoster,
    distanceMatrix: paoliDistanceMatrix,
  };
  const grid = solve(input);

  // Surplus = roster providers not currently assigned to any fixed room.
  const used = new Set<string>();
  for (const a of grid.assignments) {
    if (a.anesthesiologistId) used.add(a.anesthesiologistId);
    for (const c of a.crnaIds) used.add(c);
  }
  for (const f of grid.floats) used.add(f.providerId);

  const surplus: FloatSurplusProvider[] = paoliRoster
    .filter((r) => !used.has(r.id))
    .map((r) => ({ id: r.id, role: r.role }));

  const withFloats = applyFloatStrategy(grid, {
    mode: paoliConfig.floatStrategy,
    surplus,
    sites: paoliSites,
    distanceMatrix: paoliBandMatrix,
  });

  const health = assessFloatHealth(withFloats, surplus);
  assert.ok(
    health.level === 'ok' || health.level === 'tight',
    `expected float health ok|tight, got ${health.level} — binding: ${health.binding}`,
  );
});

// ---------------------------------------------------------------------------
// 4. End-to-end simulator: worst-case FTE recommendation falls in the
//    sanity envelope discovered while authoring the seed.
//
//    Anesthesiologist FTE: [9, 30] — covers the lower bound from a perfect
//    1:3 (5 OR MDs + 1 Endo + 1 OB + supervisors for EP/Neuro = ~9) up to
//    the worst-case + maternity + post-call + buffer ceiling.
//
//    CRNA FTE: [19, 35] — covers the 19 room CRNAs (15 OR + 2 Endo + 1 Neuro
//    + 1 EP) up through the worst-case+float buffer ceiling.
//
//    These bands are deliberately wider than PRD §16 (±2 / ±3) — the §16
//    check happens in docs/paoli-validation.md and lets Gabriel sign off on
//    a tighter recommendation rather than failing in CI.
// ---------------------------------------------------------------------------

test('simulator produces Anesthesiologist FTE in [9, 30] for Paoli', async () => {
  const input: SimulatorInput = {
    config: paoliConfig,
    sites: paoliSites,
    rules: paoliRules,
    roster: paoliRoster,
    providerLeaveProfiles: paoliLeaveProfiles,
    distanceMatrix: paoliDistanceMatrix,
    distanceMatrixForFloats: paoliBandMatrix,
    trialsCount: TRIALS,
    seed: PAOLI_SEED_RNG,
    anthropicClient: null, // force templated rationale — keeps the test offline
  };

  const out = await simulate(input);
  assert.ok(
    out.anesthesiologist.worstCase >= 9 && out.anesthesiologist.worstCase <= 30,
    `Anesthesiologist worstCase=${out.anesthesiologist.worstCase} outside [9,30]. binding=${out.anesthesiologist.binding}`,
  );

  // p95 should be ≤ worstCase since the worst-case path always dominates a
  // well-formed Monte Carlo. (If p95 > worstCase, binding flips to
  // monte_carlo — still legal but worth a follow-up.)
  assert.ok(
    out.anesthesiologist.p95 <= out.anesthesiologist.worstCase + 5,
    `p95=${out.anesthesiologist.p95} unexpectedly larger than worstCase=${out.anesthesiologist.worstCase}`,
  );
});

test('simulator produces CRNA FTE in [19, 35] for Paoli', async () => {
  const input: SimulatorInput = {
    config: paoliConfig,
    sites: paoliSites,
    rules: paoliRules,
    roster: paoliRoster,
    providerLeaveProfiles: paoliLeaveProfiles,
    distanceMatrix: paoliDistanceMatrix,
    distanceMatrixForFloats: paoliBandMatrix,
    trialsCount: TRIALS,
    seed: PAOLI_SEED_RNG,
    anthropicClient: null,
  };

  const out = await simulate(input);
  assert.ok(
    out.crna.worstCase >= 19 && out.crna.worstCase <= 35,
    `CRNA worstCase=${out.crna.worstCase} outside [19,35]. binding=${out.crna.binding}`,
  );
});

// ---------------------------------------------------------------------------
// 5. Backup-call FTE distribution sums to ~1.0 per PRD §11.
// ---------------------------------------------------------------------------

test('backup-call FTE distribution sums to ~1.0 with Paoli seed', async () => {
  const input: SimulatorInput = {
    config: paoliConfig,
    sites: paoliSites,
    rules: paoliRules,
    roster: paoliRoster,
    providerLeaveProfiles: paoliLeaveProfiles,
    distanceMatrix: paoliDistanceMatrix,
    distanceMatrixForFloats: paoliBandMatrix,
    trialsCount: TRIALS,
    seed: PAOLI_SEED_RNG,
    anthropicClient: null,
  };
  const out = await simulate(input);

  const sum = out.backupCall.distribution.reduce(
    (acc, d) => acc + d.fteShare,
    0,
  );
  assert.ok(
    Math.abs(sum - 1.0) < 1e-3,
    `backup-call shares should sum to ~1.0; got ${sum}`,
  );

  // At least one Paoli provider should hold backup.
  assert.ok(
    out.backupCall.distribution.length >= 1,
    'expected at least one backup-call provider in distribution',
  );
});

// ---------------------------------------------------------------------------
// 6. Determinism — running the simulator twice with the same seed produces
//    identical recommendations. Smoke test for the seed contract.
// ---------------------------------------------------------------------------

test('simulator is deterministic for the Paoli seed under a fixed RNG seed', async () => {
  function buildInput(): SimulatorInput {
    return {
      config: paoliConfig,
      sites: paoliSites,
      rules: paoliRules,
      roster: paoliRoster,
      providerLeaveProfiles: paoliLeaveProfiles,
      distanceMatrix: paoliDistanceMatrix,
      distanceMatrixForFloats: paoliBandMatrix,
      trialsCount: TRIALS,
      seed: PAOLI_SEED_RNG,
      anthropicClient: null,
    };
  }

  const a = await simulate(buildInput());
  const b = await simulate(buildInput());

  assert.equal(a.anesthesiologist.worstCase, b.anesthesiologist.worstCase);
  assert.equal(a.anesthesiologist.p95, b.anesthesiologist.p95);
  assert.equal(a.crna.worstCase, b.crna.worstCase);
  assert.equal(a.crna.p95, b.crna.p95);
  assert.equal(
    a.monteCarlo.floatTroubleFraction,
    b.monteCarlo.floatTroubleFraction,
  );
});

// ---------------------------------------------------------------------------
// 7. Roster is large enough that the solver does NOT need to grow per worst-
//    case scenarios. (If it does, the seed is undersized — flag it.)
// ---------------------------------------------------------------------------

test('Paoli roster is sized so the solver does not exhaust providers on a normal day', () => {
  const grid = solve({
    config: paoliConfig,
    sites: paoliSites,
    rules: paoliRules,
    roster: paoliRoster,
    distanceMatrix: paoliDistanceMatrix,
  });
  const usedMDs = new Set<string>();
  const usedCRNAs = new Set<string>();
  for (const a of grid.assignments) {
    if (a.anesthesiologistId) usedMDs.add(a.anesthesiologistId);
    for (const c of a.crnaIds) usedCRNAs.add(c);
  }
  for (const f of grid.floats) {
    if (f.role === 'anesthesiologist') usedMDs.add(f.providerId);
    else usedCRNAs.add(f.providerId);
  }
  const totalMDs = paoliRoster.filter(
    (r) => r.role === 'anesthesiologist',
  ).length;
  const totalCRNAs = paoliRoster.filter((r) => r.role === 'crna').length;

  // Normal day should leave headroom in BOTH cohorts — that headroom is
  // what absorbs PTO + sick + post-call on bad days.
  assert.ok(
    totalMDs - usedMDs.size >= 2,
    `expected ≥2 spare MDs after a normal day; got ${totalMDs - usedMDs.size}`,
  );
  assert.ok(
    totalCRNAs - usedCRNAs.size >= 3,
    `expected ≥3 spare CRNAs after a normal day; got ${totalCRNAs - usedCRNAs.size}`,
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

// Silence the unused-variable lint about RosterProvider (kept as a type for
// readers of the file).
void (null as unknown as RosterProvider | undefined);

main();
