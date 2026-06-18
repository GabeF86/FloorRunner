// Universal Library starter-template tests.
// Owned by agent A17 (Universal Library) per PRD §14, §15, §16.
//
// Run with: npx tsx src/lib/gridCalculator/seeds/_templates/__tests__/templates.test.ts
// Matches the tsx + node:assert pattern used across the Grid Calculator
// agent suites (A3 solver, A6 float strategy, A7 simulator, A8 call burden,
// A11 paoliSeed).
//
// SCOPE
// -----
// Per the A17 charter the tests must cover:
//   1. Each template loads (shape sanity).
//   2. Each template has a positive site count + at least one room.
//   3. Each template has at least one default rule (via guidelinesText).
//   4. Each template runs through `solve()` with a synthetic small roster
//      (1 Anesthesiologist + 3 CRNAs + 1 spare) WITHOUT THROWING.
//   5. The registry exports LISTED_TEMPLATES + getTemplate behave sanely.
//
// The synthetic-roster smoke test is the "universality" check PRD §16
// criterion 1 ("Universality smoke test") leans on — the solver must
// produce a grid on any well-formed template + a minimal roster.

import assert from 'node:assert/strict';

import { indexEdges, isSupervisable } from '../../../distanceMatrix';
import { solve } from '../../../solver';
import type {
  DistanceMatrixLike,
  RosterProvider,
  SolvedGrid,
  SolverInput,
} from '../../../solver';
import type { CoverageRuleSet, GridCalculatorConfig } from '../../../types';
import {
  ALL_TEMPLATES,
  LISTED_TEMPLATES,
  getTemplate,
  largeAcademicTemplate,
  midRegionalTemplate,
  smallCommunityTemplate,
} from '../index';
import type { GridTemplate } from '../types';

// ---------------------------------------------------------------------------
// Mini test harness — matches the rest of the Grid Calculator suite.
// ---------------------------------------------------------------------------

type TestCase = { name: string; fn: () => void | Promise<void> };
const cases: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  cases.push({ name, fn });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal synthetic roster: 1 Anesthesiologist + 3 CRNAs + 1 spare
 * of each. Enough to satisfy the smallest template's room count when the
 * solver supervises 1:3, and at least to attempt every room without
 * throwing on the larger templates (excess rooms surface as violations,
 * not exceptions).
 */
function syntheticRoster(): RosterProvider[] {
  return [
    { id: 'syn-md-1', role: 'anesthesiologist', fte: 1.0 },
    { id: 'syn-md-2', role: 'anesthesiologist', fte: 1.0 },
    { id: 'syn-crna-1', role: 'crna', fte: 1.0 },
    { id: 'syn-crna-2', role: 'crna', fte: 1.0 },
    { id: 'syn-crna-3', role: 'crna', fte: 1.0 },
    { id: 'syn-crna-4', role: 'crna', fte: 1.0 },
  ];
}

/**
 * Build a per-template DistanceMatrix backed by the template's edges via
 * the distanceMatrix helpers. Templates that omit an explicit edge fall
 * back to the module's intra-config default (`near`).
 */
function makeDistanceMatrix(tmpl: GridTemplate): DistanceMatrixLike {
  const edgeIndex = indexEdges([...tmpl.distanceEdges]);
  return {
    isSupervisable: (from, to) => isSupervisable(from, to, edgeIndex),
  };
}

/**
 * Build a minimal CoverageRuleSet that names the template's sites. The
 * solver requires SiteRules keyed by site NAME (per the A3 contract);
 * since A17's templates ship guidelinesText (not pre-normalized rules),
 * we emit a tiny default ruleset here so the solver has something to
 * iterate. PRD §9: the wizard would normally run A4 on the
 * guidelinesText to produce the real CoverageRuleSet.
 */
function defaultRulesFor(tmpl: GridTemplate): CoverageRuleSet {
  const nonFloatSites = tmpl.sites.filter((s) => s.id !== 'site-float');
  return {
    siteRules: nonFloatSites.map((s) => ({
      site: s.name,
      defaultStaffing: 'supervised_md_crna' as const,
      maxSupervisionRatio: '1:3' as const,
    })),
    globalRules: [],
  };
}

/**
 * Build a minimal GridCalculatorConfig from the template's defaultConfig.
 */
function makeConfig(tmpl: GridTemplate): GridCalculatorConfig {
  return {
    id: `${tmpl.id}-test`,
    hospital: `Template Test — ${tmpl.id}`,
    name: `${tmpl.name} (test)`,
    ...tmpl.defaultConfig,
  };
}

// ---------------------------------------------------------------------------
// 1. Shape sanity tests — one per template + the registry.
// ---------------------------------------------------------------------------

test('smallCommunity template: loads with positive site/room count', () => {
  assert.equal(smallCommunityTemplate.id, 'small_community');
  assert.ok(smallCommunityTemplate.name.length > 0);
  assert.ok(smallCommunityTemplate.description.length > 0);

  const nonFloat = smallCommunityTemplate.sites.filter(
    (s) => s.id !== 'site-float',
  );
  assert.ok(nonFloat.length > 0, 'must have at least one non-float site');
  const totalRooms = nonFloat.reduce((sum, s) => sum + s.rooms.length, 0);
  assert.ok(totalRooms > 0, 'must have at least one room');

  // Float lane must exist + be pinned last.
  const floatLane = smallCommunityTemplate.sites.find((s) => s.id === 'site-float');
  assert.ok(floatLane, 'float lane must exist');
  const sorted = [...smallCommunityTemplate.sites].sort(
    (a, b) => a.position - b.position,
  );
  assert.equal(sorted[sorted.length - 1].id, 'site-float');

  // Default rule sanity — guidelinesText must mention at least one
  // default-staffing concept ("solo" or "supervised") so A4 has something
  // to extract.
  const text = smallCommunityTemplate.guidelinesText.toLowerCase();
  assert.ok(text.includes('solo') || text.includes('supervised'));

  // Default config must populate all four toggles.
  assert.ok(smallCommunityTemplate.defaultConfig.coverageStyle);
  assert.ok(smallCommunityTemplate.defaultConfig.supervisionRatio);
  assert.ok(smallCommunityTemplate.defaultConfig.floatStrategy);
  assert.ok(smallCommunityTemplate.defaultConfig.backupCallPosture);
});

test('midRegional template: loads with positive site/room count + cross-site shape', () => {
  assert.equal(midRegionalTemplate.id, 'mid_regional');
  const nonFloat = midRegionalTemplate.sites.filter(
    (s) => s.id !== 'site-float',
  );
  // Mid-regional should have at least 5 fixed sites (Main OR + Endo +
  // Neuro + EP + OB) to support cross-site supervision demos.
  assert.ok(
    nonFloat.length >= 5,
    `expected >= 5 fixed sites, got ${nonFloat.length}`,
  );

  // OB ↔ procedural cluster must be `far` (different wing).
  const obFarEdge = midRegionalTemplate.distanceEdges.find(
    (e) =>
      (e.siteA === 'site-ob' || e.siteB === 'site-ob') &&
      (e.siteA === 'site-ep-lab' || e.siteB === 'site-ep-lab'),
  );
  assert.ok(obFarEdge, 'OB ↔ EP edge must exist');
  assert.equal(obFarEdge!.band, 'far');
  assert.equal(obFarEdge!.supervisable, false);

  // Guidelines must mention supervised cross-site staffing (a Paoli-like
  // shape but with no Paoli-specific names).
  const text = midRegionalTemplate.guidelinesText.toLowerCase();
  assert.ok(text.includes('supervised cross-site'));
  // Generic vocabulary — must NOT leak Paoli's "Floor Runner" name.
  assert.ok(!text.includes('floor runner'));
});

test('largeAcademic template: loads with positive site/room count + offsite shape', () => {
  assert.equal(largeAcademicTemplate.id, 'large_academic');
  const nonFloat = largeAcademicTemplate.sites.filter(
    (s) => s.id !== 'site-float',
  );
  assert.ok(
    nonFloat.length >= 8,
    `expected >= 8 fixed sites, got ${nonFloat.length}`,
  );

  // Main OR ↔ Cath edge must be `off_campus` (multi-building).
  const offCampusEdge = largeAcademicTemplate.distanceEdges.find(
    (e) =>
      (e.siteA === 'site-mainor' && e.siteB === 'site-cath') ||
      (e.siteB === 'site-mainor' && e.siteA === 'site-cath'),
  );
  assert.ok(offCampusEdge, 'Main OR ↔ Cath edge must exist');
  assert.equal(offCampusEdge!.band, 'off_campus');
  assert.equal(offCampusEdge!.supervisable, false);

  // Main OR should have 25+ rooms to satisfy the "25+ ORs" descriptor.
  const mainOR = largeAcademicTemplate.sites.find((s) => s.id === 'site-mainor');
  assert.ok(mainOR);
  assert.ok(
    mainOR!.rooms.length >= 25,
    `expected >= 25 Main OR rooms, got ${mainOR!.rooms.length}`,
  );

  // Default config should suit a large center: `mixed` supervision +
  // aggressive backup-call posture.
  assert.equal(largeAcademicTemplate.defaultConfig.supervisionRatio, 'mixed');
  assert.equal(largeAcademicTemplate.defaultConfig.backupCallPosture, 'aggressive');
});

test('registry: LISTED_TEMPLATES exports metadata for every template + getTemplate resolves', () => {
  assert.equal(LISTED_TEMPLATES.length, ALL_TEMPLATES.length);
  assert.equal(LISTED_TEMPLATES.length, 3);

  for (const meta of LISTED_TEMPLATES) {
    assert.ok(meta.id);
    assert.ok(meta.name.length > 0);
    assert.ok(meta.description.length > 0);
    assert.ok(meta.siteCount > 0, `template ${meta.id} must have siteCount > 0`);
    assert.ok(meta.roomCount > 0, `template ${meta.id} must have roomCount > 0`);

    const tmpl = getTemplate(meta.id);
    assert.equal(tmpl.id, meta.id);
    assert.equal(tmpl.name, meta.name);
  }

  // Unknown id throws.
  assert.throws(
    // @ts-expect-error — runtime check that the resolver guards on unknown ids.
    () => getTemplate('not-a-template'),
    /Unknown template id/,
  );

  // siteCount on the small community template equals 3 (Main OR + Endo + OB,
  // not the float lane).
  const smallMeta = LISTED_TEMPLATES.find((m) => m.id === 'small_community');
  assert.equal(smallMeta!.siteCount, 3);
});

// ---------------------------------------------------------------------------
// 2. Universality smoke — solve() runs on every template + minimal roster
//    without throwing. (Excess rooms vs. roster surface as violations, NOT
//    exceptions — that's the solver contract.)
// ---------------------------------------------------------------------------

test('solve() on each template + synthetic roster does not throw', () => {
  for (const tmpl of ALL_TEMPLATES) {
    const input: SolverInput = {
      config: makeConfig(tmpl),
      sites: tmpl.sites,
      rules: defaultRulesFor(tmpl),
      roster: syntheticRoster(),
      distanceMatrix: makeDistanceMatrix(tmpl),
    };

    // The contract is "solve() never throws" — unresolvable conflicts
    // surface as violations on the SolvedGrid, never as exceptions. The
    // synthetic roster is intentionally too small for the larger templates;
    // that's expected to produce violations but must not throw.
    let grid: SolvedGrid | undefined;
    try {
      grid = solve(input);
    } catch (err) {
      assert.fail(`solve() threw on template ${tmpl.id}: ${(err as Error).message}`);
    }

    // Sanity: every non-float room must produce an assignment record (even
    // if the assignment is empty + violation-laden because the synthetic
    // roster is small).
    const fixedRooms = tmpl.sites
      .filter((s) => s.id !== 'site-float')
      .flatMap((s) => s.rooms);
    assert.ok(grid, 'solve() must return a SolvedGrid');
    assert.equal(
      grid!.assignments.length,
      fixedRooms.length,
      `template ${tmpl.id}: expected one assignment per fixed room`,
    );
    assert.equal(
      grid!.configId,
      `${tmpl.id}-test`,
      `template ${tmpl.id}: configId must round-trip through solve()`,
    );
  }
});

test('solve() on smallCommunity + synthetic roster staffs the supervised rooms', () => {
  // Small community is 6 rooms total (4 OR + 1 Endo + 1 OB). With 2 MDs +
  // 4 CRNAs and supervised_md_crna defaults, the solver can supervise 4
  // CRNAs under 1 MD at 1:3 → 1 MD covers Main OR's 4 rooms (4 CRNAs), but
  // Endo + OB run out of CRNAs. That's expected. The smoke is that the
  // *supervisable* portion of the grid gets assigned cleanly and the rest
  // surfaces as deterministic violations.
  const tmpl = smallCommunityTemplate;
  const input: SolverInput = {
    config: makeConfig(tmpl),
    sites: tmpl.sites,
    rules: defaultRulesFor(tmpl),
    roster: syntheticRoster(),
    distanceMatrix: makeDistanceMatrix(tmpl),
  };
  const grid = solve(input);

  // The 4 Main OR rooms should all be staffed under a single supervising
  // MD (1:4 cap, 1:3 target — the solver allows climbing to the cap).
  // Actually we requested mostly_1_3, so cap=3 → first 3 OR rooms share an
  // MD, then the 4th gets a fresh MD. Either way the 4 OR rooms should
  // get a CRNA + an MD.
  const mainOR = tmpl.sites.find((s) => s.id === 'site-mainor');
  assert.ok(mainOR);
  for (const room of mainOR!.rooms) {
    const a = grid.assignments.find((x) => x.roomId === room.id);
    assert.ok(a, `assignment missing for ${room.name}`);
    assert.ok(
      a!.anesthesiologistId !== null,
      `room ${room.name} missing Anesthesiologist`,
    );
    assert.equal(
      a!.crnaIds.length,
      1,
      `room ${room.name} should have 1 CRNA assigned`,
    );
  }

  // Any out-of-roster violations must be informative strings (deterministic
  // shape — not crashes).
  for (const v of grid.violations) {
    assert.equal(typeof v, 'string');
    assert.ok(v.length > 0);
  }
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

main();
