// Unit tests for the supervisability decision layer.
// Owned by agent A5 (Distance & Supervisability).
//
// Run with: npx tsx src/lib/gridCalculator/__tests__/supervisability.test.ts
// Mirrors the zero-dependency `tsx + node:assert` pattern used by solver.test.ts.

import assert from 'node:assert/strict';

import { makeSupervisabilityResolver, renderEdgeStyles } from '../supervisability';
import type { DistanceEdge } from '../types';

// ---------------------------------------------------------------------------
// Mini test harness
// ---------------------------------------------------------------------------

type TestCase = { name: string; fn: () => void | Promise<void> };
const cases: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  cases.push({ name, fn });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function edge(
  a: string,
  b: string,
  band: DistanceEdge['band'],
  supervisable = true,
): DistanceEdge {
  return { siteA: a, siteB: b, band, supervisable };
}

// ---------------------------------------------------------------------------
// 1. Same site always supervisable.
// ---------------------------------------------------------------------------

test('same site is always supervisable with no warnings', () => {
  const r = makeSupervisabilityResolver([]);
  const decision = r.explain('site-a', 'site-a');
  assert.equal(decision.allowed, true);
  assert.equal(decision.band, 'same_room');
  assert.equal(decision.level, 'safe');
  assert.deepEqual(decision.warnings, []);
  assert.equal(r.isSupervisable('site-a', 'site-a'), true);
});

// ---------------------------------------------------------------------------
// 2. Adjacent is safe; far is blocked.
// ---------------------------------------------------------------------------

test('adjacent is safe; far is blocked', () => {
  const edges = [
    edge('site-a', 'site-b', 'adjacent'),
    edge('site-a', 'site-c', 'far'),
  ];
  const r = makeSupervisabilityResolver(edges);

  const adj = r.explain('site-a', 'site-b');
  assert.equal(adj.allowed, true);
  assert.equal(adj.band, 'adjacent');
  assert.equal(adj.level, 'safe');

  const far = r.explain('site-a', 'site-c');
  assert.equal(far.allowed, false);
  assert.equal(far.band, 'far');
  assert.equal(far.level, 'blocked');
  assert.ok(far.warnings.some((w) => w.includes('immediate-availability')));
});

// ---------------------------------------------------------------------------
// 3. Near is allowed by default + always warns; edge override blocks it;
//    strictNear option blocks it.
//
//    Updated 2026-06-17 (Agent A5 fix pass): unified policy with
//    `distanceMatrix.ts` per `docs/code-reviews/2026-06-17-initial.md`. The
//    previous "near requires explicit override" behavior contradicted
//    `defaultBandSupervisability('near') === true`; the resolver now mirrors
//    the matrix and adds a structured warning on top.
// ---------------------------------------------------------------------------

test('near is allowed by default with a structured warning', () => {
  // No edge declared: defaults to `near` band, allowed with warning.
  const defaultDecision = makeSupervisabilityResolver([]).explain('site-a', 'site-b');
  assert.equal(defaultDecision.allowed, true);
  assert.equal(defaultDecision.band, 'near');
  assert.equal(defaultDecision.level, 'warning');
  assert.ok(
    defaultDecision.warnings.some((w) => w.includes('immediately available')),
    'default near pair must always carry a structured warning',
  );

  // Edge with supervisable=true: still allowed, still warns.
  const allowedEdges = [edge('site-a', 'site-b', 'near', true)];
  const allowed = makeSupervisabilityResolver(allowedEdges).explain('site-a', 'site-b');
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.band, 'near');
  assert.equal(allowed.level, 'warning');
  assert.ok(allowed.warnings.some((w) => w.includes('immediately available')));
});

test('near edge with supervisable=false blocks the pair', () => {
  const blockedEdges = [edge('site-a', 'site-b', 'near', false)];
  const blocked = makeSupervisabilityResolver(blockedEdges).explain('site-a', 'site-b');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.band, 'near');
  assert.equal(blocked.level, 'blocked');
  assert.ok(
    blocked.warnings.some((w) => w.includes('non-supervisable')),
    'admin override warning must surface',
  );
});

test('strictNear option blocks every near pair regardless of edge override', () => {
  // No edge: blocked.
  const noEdge = makeSupervisabilityResolver([], { strictNear: true }).explain('a', 'b');
  assert.equal(noEdge.allowed, false);
  assert.equal(noEdge.band, 'near');
  assert.equal(noEdge.level, 'blocked');
  assert.ok(noEdge.warnings.some((w) => w.includes('strictNear')));

  // Edge with supervisable=true: still blocked because strictNear dominates.
  const withEdge = makeSupervisabilityResolver(
    [edge('a', 'b', 'near', true)],
    { strictNear: true },
  ).explain('a', 'b');
  assert.equal(withEdge.allowed, false);
  assert.equal(withEdge.band, 'near');
  assert.equal(withEdge.level, 'blocked');
});

// ---------------------------------------------------------------------------
// 4. safestSupervisor returns same-site MDs first, then by safety.
// ---------------------------------------------------------------------------

test('safestSupervisor ranks same-site, adjacent, near-with-override in order', () => {
  const edges = [
    edge('room', 'adj', 'adjacent'),
    edge('room', 'near-on', 'near', true),
    edge('room', 'near-off', 'near', false),
    edge('room', 'far', 'far'),
    edge('room', 'off', 'off_campus', true), // override should be ignored
  ];
  const r = makeSupervisabilityResolver(edges);
  const ranked = r.safestSupervisor('room', [
    'far',
    'off',
    'near-off',
    'near-on',
    'adj',
    'room', // same-site candidate
  ]);
  assert.deepEqual(ranked, ['room', 'adj', 'near-on']);
});

// ---------------------------------------------------------------------------
// 5. explain produces a stable rationale string.
// ---------------------------------------------------------------------------

test('explain produces stable rationale strings across calls', () => {
  const edges = [
    edge('a', 'b', 'adjacent'),
    edge('a', 'c', 'near', true),
    edge('a', 'd', 'near', false),
    edge('a', 'e', 'far'),
    edge('a', 'f', 'off_campus', true),
  ];
  const r = makeSupervisabilityResolver(edges);
  // Snapshot rationale strings — they must not drift.
  // Note: `near` rationale strings updated 2026-06-17 per the policy
  // unification (see `docs/code-reviews/2026-06-17-initial.md`). `near` is
  // now allowed by default with a warning; only an explicit
  // `supervisable: false` edge blocks it.
  assert.equal(r.explain('a', 'b').rationale, 'adjacent: supervision allowed');
  assert.equal(r.explain('a', 'c').rationale, 'near: allowed with warning');
  assert.equal(r.explain('a', 'd').rationale, 'near: blocked (edge override)');
  assert.equal(r.explain('a', 'e').rationale, 'far: hard-blocked (ASA immediate availability)');
  assert.equal(
    r.explain('a', 'f').rationale,
    'off_campus: hard-blocked (ASA immediate availability)',
  );
  assert.equal(r.explain('a', 'a').rationale, 'same site: supervision always allowed');

  // Same inputs twice should produce identical objects (deep equality).
  assert.deepEqual(r.explain('a', 'b'), r.explain('a', 'b'));
});

// ---------------------------------------------------------------------------
// 6. off_campus is NEVER overridable to true (hard rule).
// ---------------------------------------------------------------------------

test('off_campus is never overridable even when edge.supervisable=true', () => {
  const edges = [edge('a', 'b', 'off_campus', true)];
  const r = makeSupervisabilityResolver(edges);
  const decision = r.explain('a', 'b');
  assert.equal(decision.allowed, false);
  assert.equal(decision.band, 'off_campus');
  assert.equal(decision.level, 'blocked');
  assert.ok(
    decision.warnings.some((w) => w.includes('off-campus pair')),
    'off-campus warning must be present',
  );
  // isSupervisable mirrors the hard rule.
  assert.equal(r.isSupervisable('a', 'b'), false);
});

// ---------------------------------------------------------------------------
// 7. Rule hint overrides safety ranking (A4 → A5 escalation contract).
// ---------------------------------------------------------------------------

test('rule hint promotes the hinted supervisor site above closer candidates', () => {
  const edges = [
    edge('room', 'same-site-md', 'same_room'),
    edge('room', 'main-or', 'adjacent'),
  ];
  const r = makeSupervisabilityResolver(edges);
  // Without a hint: same-site wins.
  const noHint = r.safestSupervisor('room', ['main-or', 'same-site-md']);
  assert.deepEqual(noHint, ['same-site-md', 'main-or']);
  // With a hint pinning the supervisor to "main-or": main-or wins.
  const withHint = r.safestSupervisor(
    'room',
    ['main-or', 'same-site-md'],
    { roomSiteId: 'room', supervisorFromSiteId: 'main-or' },
  );
  assert.deepEqual(withHint, ['main-or', 'same-site-md']);
});

// ---------------------------------------------------------------------------
// 8. renderEdgeStyles emits stable, deduplicated output suitable for SVG.
// ---------------------------------------------------------------------------

test('renderEdgeStyles emits one entry per unordered pair, sorted by siteId', () => {
  const edges = [
    edge('a', 'b', 'adjacent'),
    edge('a', 'c', 'near', true),
    edge('b', 'c', 'off_campus', true),
  ];
  const out = renderEdgeStyles(['c', 'a', 'b'], edges);
  assert.equal(out.length, 3);
  // Sorted by min(id), max(id).
  assert.deepEqual(out.map((e) => [e.siteA, e.siteB]), [
    ['a', 'b'],
    ['a', 'c'],
    ['b', 'c'],
  ]);
  // Styles classified correctly.
  const byPair = new Map(out.map((e) => [`${e.siteA}::${e.siteB}`, e]));
  assert.equal(byPair.get('a::b')!.style, 'safe');
  assert.equal(byPair.get('a::c')!.style, 'override');
  assert.equal(byPair.get('b::c')!.style, 'blocked');
});

// ---------------------------------------------------------------------------
// 9. Resolver implements DistanceMatrixLike so the solver consumes it unchanged.
// ---------------------------------------------------------------------------

test('resolver implements DistanceMatrixLike via isSupervisable', () => {
  const r = makeSupervisabilityResolver([
    edge('main', 'ep', 'adjacent'),
    edge('main', 'remote', 'off_campus', true),
  ]);
  // Structural duck-typing check.
  const matrix: { isSupervisable: (a: string, b: string) => boolean } = r;
  assert.equal(matrix.isSupervisable('main', 'ep'), true);
  assert.equal(matrix.isSupervisable('main', 'remote'), false);
  assert.equal(matrix.isSupervisable('main', 'main'), true);
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
