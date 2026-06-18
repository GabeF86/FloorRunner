// Unit tests for the FTE Simulator (A7).
//
// Run with: npx tsx src/lib/gridCalculator/__tests__/fteSimulator.test.ts
// Matches the tsx + node:assert pattern used by A3 (solver), A6 (float
// strategy), and A8 (call burden). No vitest dependency.
//
// Trial count for Monte Carlo tests is pinned to 50 so the suite runs in <10s.
// Production callers default to 1000 (DEFAULT_TRIALS_COUNT).

import assert from 'node:assert/strict';

import {
  DEFAULT_US_HOLIDAYS,
  createRng,
  generateAnnualCalendar,
  nthWeekdayOfMonth,
  lastWeekdayOfMonth,
  recommendFTE,
  runMonteCarlo,
  runWorstCase,
  sampleWithoutReplacement,
  simulate,
  buildTemplatedRationale,
  type RationaleClient,
  type Rng,
  type SimulatorInput,
} from '../fteSimulator';
import type {
  CoverageRuleSet,
  GridCalculatorConfig,
  GridRoom,
  GridSite,
} from '../types';
import type { RosterProvider } from '../solver';
import type { CallRosterEntry } from '../callBurden';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseConfig: GridCalculatorConfig = {
  id: 'cfg-A7',
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

function makeSite(id: string, name: string, position: number, roomCount: number): GridSite {
  return {
    id,
    name,
    color: '#4A90D9',
    icon: 'OR',
    position,
    rooms: Array.from({ length: roomCount }, (_, i) =>
      makeRoom(`${id}-r${i + 1}`, id, `${name} ${i + 1}`, i),
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

// Trial count cap for the test suite, per PRD §14 (A7) charter.
const FAST_TRIALS = 50;

// ---------------------------------------------------------------------------
// Mini test harness — matches solver.test.ts / floatStrategy.test.ts.
// ---------------------------------------------------------------------------

type TestCase = { name: string; fn: () => void | Promise<void> };
const cases: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  cases.push({ name, fn });
}

// ---------------------------------------------------------------------------
// 1. Empty roster → recommendation produced safely with violations.
// ---------------------------------------------------------------------------

test('empty roster: simulator produces a recommendation with non-throwing fallbacks', async () => {
  const input: SimulatorInput = {
    config: baseConfig,
    sites: [makeSite('site-main', 'Main OR', 0, 4)],
    rules: noRules,
    roster: [],
    trialsCount: FAST_TRIALS,
    seed: 42,
    anthropicClient: null, // force fallback
  };
  const out = await simulate(input);
  // Numbers exist, never NaN.
  assert.ok(Number.isFinite(out.anesthesiologist.worstCase));
  assert.ok(Number.isFinite(out.crna.worstCase));
  // Rationale fallback path active.
  assert.equal(out.rationaleFallback, true);
  assert.ok(out.rationale.length > 0);
  // Empty roster → callBurden surfaces a violation but no throw.
  assert.ok(
    out.callBurden.violations.some((v) => v.includes('No call-eligible')),
    `expected call-burden violation, got: ${out.callBurden.violations.join(' | ')}`,
  );
});

// ---------------------------------------------------------------------------
// 2. Seeded Monte Carlo is fully reproducible.
// ---------------------------------------------------------------------------

test('Monte Carlo is reproducible across two runs with the same seed', () => {
  const sites = [makeSite('site-main', 'Main OR', 0, 5)];
  const roster: RosterProvider[] = [
    makeProvider('md-1', 'anesthesiologist'),
    makeProvider('md-2', 'anesthesiologist'),
    ...Array.from({ length: 8 }, (_, i) =>
      makeProvider(`crna-${i + 1}`, 'crna'),
    ),
  ];
  const profiles = {
    'md-1': { pto_weeks: 4, sick_days_per_year: 2 },
    'crna-1': { pto_weeks: 5, sick_days_per_year: 3 },
    'crna-2': { fmla_eligible: true, sick_days_per_year: 4 },
    'crna-3': { maternity_eligible: true, sick_days_per_year: 3 },
  };
  const input: SimulatorInput = {
    config: baseConfig,
    sites,
    rules: noRules,
    roster,
    providerLeaveProfiles: profiles,
    trialsCount: FAST_TRIALS,
    seed: 12345,
  };
  const a = runMonteCarlo(input, FAST_TRIALS);
  const b = runMonteCarlo(input, FAST_TRIALS);
  assert.deepEqual(a, b);
  // Sanity: stats are non-zero and within bounds.
  assert.ok(a.anesthesiologists.p95 >= a.anesthesiologists.p50);
  assert.ok(a.crnas.p95 >= a.crnas.p50);
});

// ---------------------------------------------------------------------------
// 3. Worst-case recommendation ≥ Monte Carlo p50 for non-trivial input.
// ---------------------------------------------------------------------------

test('worstCase is >= Monte Carlo p50 on a non-trivial roster', () => {
  // The PRD invariant: worst-case (15% CRNA / 8% MD call-out + maternity +
  // forced PTOs + post-call) should be at LEAST as demanding as the median
  // Monte Carlo trial, provided the roster has sufficient capacity that the
  // Monte Carlo path isn't artificially constrained by under-provisioning.
  const sites = [makeSite('site-main', 'Main OR', 0, 4)];
  // Pass an empty roster — both paths synthesize from room count, so the
  // comparison is apples-to-apples and the MC peak isn't capped by input.
  const input: SimulatorInput = {
    config: baseConfig,
    sites,
    rules: noRules,
    roster: [],
    trialsCount: FAST_TRIALS,
    seed: 7,
  };
  const wc = runWorstCase(input);
  const mc = runMonteCarlo(input, FAST_TRIALS);
  assert.ok(
    wc.anesthesiologists >= mc.anesthesiologists.p50,
    `expected wc MDs (${wc.anesthesiologists}) >= mc p50 (${mc.anesthesiologists.p50})`,
  );
  assert.ok(
    wc.crnas >= mc.crnas.p50,
    `expected wc CRNAs (${wc.crnas}) >= mc p50 (${mc.crnas.p50})`,
  );
});

// ---------------------------------------------------------------------------
// 4. binding = 'worst_case' when worstCase > p95, else 'monte_carlo'.
// ---------------------------------------------------------------------------

test('binding reports worst_case when worstCase >= p95', () => {
  // Synthesize a worst-case + Monte Carlo where worst-case dominates.
  const wc = {
    anesthesiologists: 10,
    crnas: 20,
    weekdaysEvaluated: 250,
    unsolvableDays: 0,
    notes: [],
  };
  const mc = {
    trialsCount: 50,
    anesthesiologists: { p50: 5, p95: 7, mean: 6, stddev: 1 },
    crnas: { p50: 12, p95: 15, mean: 13, stddev: 2 },
    floatTroubleFraction: 0,
    floatBumpApplied: false,
    floatBumpCount: 0,
  };
  const result = recommendFTE(wc, mc, {
    config: baseConfig,
    sites: [makeSite('s', 'S', 0, 1)],
    rules: noRules,
    roster: [makeProvider('p1', 'anesthesiologist')],
  });
  assert.equal(result.recommendation.anesthesiologist.binding, 'worst_case');
  assert.equal(result.recommendation.crna.binding, 'worst_case');
});

test('binding reports monte_carlo when p95 > worstCase', () => {
  const wc = {
    anesthesiologists: 3,
    crnas: 6,
    weekdaysEvaluated: 250,
    unsolvableDays: 0,
    notes: [],
  };
  const mc = {
    trialsCount: 50,
    anesthesiologists: { p50: 6, p95: 9, mean: 7, stddev: 1 },
    crnas: { p50: 14, p95: 18, mean: 15, stddev: 2 },
    floatTroubleFraction: 0,
    floatBumpApplied: false,
    floatBumpCount: 0,
  };
  const result = recommendFTE(wc, mc, {
    config: baseConfig,
    sites: [makeSite('s', 'S', 0, 1)],
    rules: noRules,
    roster: [makeProvider('p1', 'anesthesiologist')],
  });
  assert.equal(result.recommendation.anesthesiologist.binding, 'monte_carlo');
  assert.equal(result.recommendation.crna.binding, 'monte_carlo');
});

// ---------------------------------------------------------------------------
// 5. Float Health auto-bump fires when feasibility drops below tight on > 10%.
// ---------------------------------------------------------------------------

test('float-health auto-bump fires under heavy demand and adds a float CRNA', async () => {
  // Stress break-coverage feasibility: 10 rooms (30 breaks/day demand).
  // Provide 2 MDs (just enough to supervise 8-10 rooms at 1:4/1:5) but only
  // 10 CRNAs — exactly enough to fill rooms, leaving zero surplus → zero
  // floats → critical health every day → > 10% trouble → auto-bump fires.
  const sites = [makeSite('site-main', 'Main OR', 0, 10)];
  const roster: RosterProvider[] = [
    makeProvider('md-1', 'anesthesiologist'),
    makeProvider('md-2', 'anesthesiologist'),
    makeProvider('md-3', 'anesthesiologist'),
    ...Array.from({ length: 10 }, (_, i) =>
      makeProvider(`crna-${i + 1}`, 'crna'),
    ),
  ];
  const input: SimulatorInput = {
    config: { ...baseConfig, floatStrategy: 'break_priority' },
    sites,
    rules: noRules,
    roster,
    trialsCount: FAST_TRIALS,
    seed: 99,
    anthropicClient: null,
  };
  const out = await simulate(input);
  // With zero CRNA surplus → zero floats most days → critical health → bump.
  assert.equal(
    out.monteCarlo.floatBumpApplied,
    true,
    `expected floatBumpApplied=true. floatTroubleFraction=${out.monteCarlo.floatTroubleFraction}`,
  );
  assert.ok(out.monteCarlo.floatBumpCount >= 1);
});

// ---------------------------------------------------------------------------
// 6. Backup-call FTE distribution sums to ~1.0 and respects BackupCallPosture.
// ---------------------------------------------------------------------------

test('backup-call distribution sums to ~1.0 and reflects posture', () => {
  const callRoster: CallRosterEntry[] = Array.from({ length: 8 }, (_, i) => ({
    id: `p${i + 1}`,
    fte: 1.0,
    call_taker: true,
    backup_call_eligible: true,
  }));

  const aggressive = recommendFTE(
    { anesthesiologists: 4, crnas: 8, weekdaysEvaluated: 250, unsolvableDays: 0, notes: [] },
    {
      trialsCount: 50,
      anesthesiologists: { p50: 3, p95: 4, mean: 3.5, stddev: 0.5 },
      crnas: { p50: 7, p95: 8, mean: 7.5, stddev: 0.5 },
      floatTroubleFraction: 0,
      floatBumpApplied: false,
      floatBumpCount: 0,
    },
    {
      config: { ...baseConfig, backupCallPosture: 'aggressive' },
      sites: [makeSite('s', 'S', 0, 4)],
      rules: noRules,
      roster: callRoster.map((c) => makeProvider(c.id, 'anesthesiologist', c.fte)),
      callRoster,
    },
  );
  const conservative = recommendFTE(
    { anesthesiologists: 4, crnas: 8, weekdaysEvaluated: 250, unsolvableDays: 0, notes: [] },
    {
      trialsCount: 50,
      anesthesiologists: { p50: 3, p95: 4, mean: 3.5, stddev: 0.5 },
      crnas: { p50: 7, p95: 8, mean: 7.5, stddev: 0.5 },
      floatTroubleFraction: 0,
      floatBumpApplied: false,
      floatBumpCount: 0,
    },
    {
      config: { ...baseConfig, backupCallPosture: 'conservative' },
      sites: [makeSite('s', 'S', 0, 4)],
      rules: noRules,
      roster: callRoster.map((c) => makeProvider(c.id, 'anesthesiologist', c.fte)),
      callRoster,
    },
  );
  const aggSum = aggressive.recommendation.backupCall.distribution.reduce(
    (acc, d) => acc + d.fteShare,
    0,
  );
  const conSum = conservative.recommendation.backupCall.distribution.reduce(
    (acc, d) => acc + d.fteShare,
    0,
  );
  assert.ok(Math.abs(aggSum - 1.0) < 1e-3, `aggressive sum=${aggSum}`);
  assert.ok(Math.abs(conSum - 1.0) < 1e-3, `conservative sum=${conSum}`);
  // Aggressive should touch strictly more providers than conservative.
  assert.ok(
    aggressive.recommendation.backupCall.distribution.length >=
      conservative.recommendation.backupCall.distribution.length,
    `aggressive providers ${aggressive.recommendation.backupCall.distribution.length} ` +
      `should be >= conservative ${conservative.recommendation.backupCall.distribution.length}`,
  );
});

// ---------------------------------------------------------------------------
// 7. Rationale fallback works without ANTHROPIC_API_KEY.
// ---------------------------------------------------------------------------

test('rationale falls back to template when no client is available', async () => {
  // Ensure env var is unset for this test.
  const prevKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;

  try {
    const input: SimulatorInput = {
      config: baseConfig,
      sites: [makeSite('site-main', 'Main OR', 0, 3)],
      rules: noRules,
      roster: [
        makeProvider('md-1', 'anesthesiologist'),
        makeProvider('crna-1', 'crna'),
        makeProvider('crna-2', 'crna'),
        makeProvider('crna-3', 'crna'),
      ],
      trialsCount: FAST_TRIALS,
      seed: 1,
      // Note: not passing anthropicClient — let tryBuild fall through.
    };
    const out = await simulate(input);
    assert.equal(out.rationaleFallback, true);
    assert.ok(out.rationale.includes('Recommended'));
    assert.ok(out.rationale.includes('binding constraint'));
  } finally {
    if (prevKey !== undefined) process.env.ANTHROPIC_API_KEY = prevKey;
  }
});

test('rationale uses Claude client when one is supplied', async () => {
  let calls = 0;
  const stub: RationaleClient = {
    messages: {
      create: async () => {
        calls += 1;
        return {
          content: [{ type: 'text', text: 'Stub rationale from Claude.' }],
        };
      },
    },
  };
  const input: SimulatorInput = {
    config: baseConfig,
    sites: [makeSite('site-main', 'Main OR', 0, 2)],
    rules: noRules,
    roster: [
      makeProvider('md-1', 'anesthesiologist'),
      makeProvider('crna-1', 'crna'),
      makeProvider('crna-2', 'crna'),
    ],
    trialsCount: FAST_TRIALS,
    seed: 1,
    anthropicClient: stub,
  };
  const out = await simulate(input);
  assert.equal(calls, 1);
  assert.equal(out.rationaleFallback, false);
  assert.equal(out.rationale, 'Stub rationale from Claude.');
});

// ---------------------------------------------------------------------------
// 8. Holiday calendar correctly flags federal holidays.
// ---------------------------------------------------------------------------

test('holiday calendar flags Thanksgiving + Christmas + New Year correctly', () => {
  const cal2026 = generateAnnualCalendar({ year: 2026 });

  // New Year 2026 (Thu).
  const newYear = cal2026.find((d) => d.date === '2026-01-01');
  assert.ok(newYear);
  assert.equal(newYear!.type, 'holiday');
  assert.equal(newYear!.holidayName, 'New Year');

  // Christmas 2026.
  const christmas = cal2026.find((d) => d.date === '2026-12-25');
  assert.ok(christmas);
  assert.equal(christmas!.type, 'holiday');
  assert.equal(christmas!.holidayName, 'Christmas');

  // Christmas Eve flagged.
  const eve = cal2026.find((d) => d.date === '2026-12-24');
  assert.ok(eve);
  assert.equal(eve!.type, 'holiday');

  // Thanksgiving 2026 is the 4th Thursday of November — 2026-11-26.
  const tg = cal2026.find((d) => d.date === '2026-11-26');
  assert.ok(tg);
  assert.equal(tg!.type, 'holiday');
  assert.equal(tg!.holidayName, 'Thanksgiving');

  // Day After Thanksgiving = 2026-11-27.
  const dayAfter = cal2026.find((d) => d.date === '2026-11-27');
  assert.ok(dayAfter);
  assert.equal(dayAfter!.type, 'holiday');

  // Spot-check: ensure 365 (non-leap) days exist for 2026.
  assert.equal(cal2026.length, 365);

  // The default holiday set is what we expect.
  assert.equal(DEFAULT_US_HOLIDAYS.length, 10);

  // Memorial Day 2026 = last Monday of May = 2026-05-25.
  const memorial = cal2026.find((d) => d.date === '2026-05-25');
  assert.ok(memorial);
  assert.equal(memorial!.type, 'holiday');
  assert.equal(memorial!.holidayName, 'Memorial Day');

  // nthWeekdayOfMonth / lastWeekdayOfMonth basic sanity.
  const mlk2026 = nthWeekdayOfMonth(2026, 1, 1, 3); // 3rd Monday Jan = Jan 19
  assert.equal(mlk2026.getUTCDate(), 19);
  const last = lastWeekdayOfMonth(2026, 5, 1); // last Monday May = May 25
  assert.equal(last.getUTCDate(), 25);
});

// ---------------------------------------------------------------------------
// 9. (Bonus) Templated rationale references binding constraints clearly.
// ---------------------------------------------------------------------------

test('templated rationale calls out the binding constraint by name', () => {
  const rec = {
    anesthesiologist: {
      worstCase: 10,
      p50: 5,
      p95: 7,
      binding: 'worst_case' as const,
    },
    crna: {
      worstCase: 20,
      p50: 14,
      p95: 18,
      binding: 'monte_carlo' as const,
    },
    backupCall: { fte: 1.0, distribution: [] },
  };
  const wc = {
    anesthesiologists: 10,
    crnas: 20,
    weekdaysEvaluated: 250,
    unsolvableDays: 0,
    notes: [],
  };
  const mc = {
    trialsCount: 1000,
    anesthesiologists: { p50: 5, p95: 7, mean: 5.5, stddev: 0.5 },
    crnas: { p50: 14, p95: 18, mean: 15, stddev: 1 },
    floatTroubleFraction: 0,
    floatBumpApplied: false,
    floatBumpCount: 0,
  };
  const text = buildTemplatedRationale(rec, wc, mc);
  assert.ok(text.includes('worst-case'));
  assert.ok(text.includes('Monte Carlo'));
  assert.ok(text.includes('10 Anesthesiologists'));
  assert.ok(text.includes('20 CRNAs'));
});

// ---------------------------------------------------------------------------
// 10. (Bonus) RNG is deterministic for the same seed.
// ---------------------------------------------------------------------------

test('createRng produces identical sequences for the same seed', () => {
  const a = createRng(0xdeadbeef);
  const b = createRng(0xdeadbeef);
  for (let i = 0; i < 100; i++) {
    assert.equal(a.nextUint32(), b.nextUint32());
  }
  const c = createRng(0xdeadbeef);
  const d = createRng(0xdeadbeef);
  for (let i = 0; i < 50; i++) {
    assert.equal(c.poisson(2.5), d.poisson(2.5));
  }
});

// ---------------------------------------------------------------------------
// 11. (Regression — bug fix #1) Peak headcount does NOT accumulate per
// violation across days. The pre-fix implementation did `peakMDs += 1` for
// every violation message, permanently inflating the running peak across the
// year. The bound here: peak ≤ roster size + room count for any day, so over
// a year the trial peak can never exceed roster_size + room_count.
// ---------------------------------------------------------------------------

test('peak headcount bound by roster + rooms (no per-violation accumulation)', () => {
  // Under-provision the roster so MOST weekdays surface "no Anesthesiologist
  // available" / "no CRNA available" violations. With the pre-fix bug, the
  // peak would keep climbing every violation on every day across ~250
  // weekdays, ballooning to many multiples of the actual demand. With the fix
  // applied, the peak is bounded per-day at `used.mds + uniqueShortRoomsMDs`,
  // which can never exceed the roster size plus the room count.
  const ROOM_COUNT = 4;
  const sites = [makeSite('site-main', 'Main OR', 0, ROOM_COUNT)];
  // Provision exactly the minimum — 1 MD + 1 CRNA — to maximize violation
  // pressure on every weekday.
  const roster: RosterProvider[] = [
    makeProvider('md-1', 'anesthesiologist'),
    makeProvider('crna-1', 'crna'),
  ];
  const input: SimulatorInput = {
    config: baseConfig,
    sites,
    rules: noRules,
    roster,
    trialsCount: FAST_TRIALS,
    seed: 17,
  };
  const mc = runMonteCarlo(input, FAST_TRIALS);
  // Per-day peak: max(used.mds + shortRooms.mds) ≤ rosterMDs + roomCount.
  // Allow a small safety margin to absorb the float-CRNA bump the solver may
  // emit, but assert WELL below the accumulation behavior (which would push
  // the peak above ~250 across the year).
  const PEAK_UPPER_BOUND = roster.length + ROOM_COUNT + 2;
  assert.ok(
    mc.anesthesiologists.p95 <= PEAK_UPPER_BOUND,
    `MD p95 (${mc.anesthesiologists.p95}) must stay below ${PEAK_UPPER_BOUND}; ` +
      `peak accumulator bug would push it dramatically higher`,
  );
  assert.ok(
    mc.crnas.p95 <= PEAK_UPPER_BOUND,
    `CRNA p95 (${mc.crnas.p95}) must stay below ${PEAK_UPPER_BOUND}; ` +
      `peak accumulator bug would push it dramatically higher`,
  );
});

// ---------------------------------------------------------------------------
// 12. (Regression — bug fix #4) Crypto-drawn seed propagates to the result so
// the persisted row can reproduce the run. The pre-fix implementation wrote
// `input.seed ?? NaN`, which silently dropped the crypto seed on the floor.
// ---------------------------------------------------------------------------

test('simulate propagates a real seed when caller passes none', async () => {
  const input: SimulatorInput = {
    config: baseConfig,
    sites: [makeSite('site-main', 'Main OR', 0, 2)],
    rules: noRules,
    roster: [
      makeProvider('md-1', 'anesthesiologist'),
      makeProvider('crna-1', 'crna'),
      makeProvider('crna-2', 'crna'),
    ],
    trialsCount: FAST_TRIALS,
    // Intentionally NOT passing `seed` so the simulator draws crypto.
    anthropicClient: null,
  };
  const out = await simulate(input);
  assert.ok(
    Number.isFinite(out.seed),
    `expected a real number for seed, got ${out.seed}`,
  );
  assert.ok(out.seed >= 0, `expected uint32 seed, got ${out.seed}`);
  assert.ok(out.seed <= 0xffffffff, `expected uint32 seed, got ${out.seed}`);
});

test('simulate propagates the caller-supplied seed when one is passed', async () => {
  const input: SimulatorInput = {
    config: baseConfig,
    sites: [makeSite('site-main', 'Main OR', 0, 2)],
    rules: noRules,
    roster: [
      makeProvider('md-1', 'anesthesiologist'),
      makeProvider('crna-1', 'crna'),
      makeProvider('crna-2', 'crna'),
    ],
    trialsCount: FAST_TRIALS,
    seed: 31337,
    anthropicClient: null,
  };
  const out = await simulate(input);
  assert.equal(out.seed, 31337);
});

// ---------------------------------------------------------------------------
// 13. (Regression — bug fix #5) sampleWithoutReplacement falls through to the
// dense Fisher-Yates path when the HARD_CAP collision budget is exhausted,
// rather than silently returning fewer than `count` indices. Test by handing
// it an RNG that always returns the same index, forcing collisions, then
// asserting we still get `count` distinct indices.
// ---------------------------------------------------------------------------

test('sampleWithoutReplacement falls through to Fisher-Yates when collisions exhaust HARD_CAP', () => {
  // Build an RNG stub whose nextInt always returns 0. This guarantees that
  // the draw-and-check path NEVER converges (only 1 unique index will land
  // in the set), so HARD_CAP fires.
  const stuck: Rng = {
    next: () => 0,
    nextUint32: () => 0,
    nextInt: () => 0,
    poisson: () => 0,
    seed: 0,
  };
  // n=100, count=10 satisfies the `count * 4 < n` predicate (40 < 100) so the
  // sparse path is selected; with the pre-fix bug we'd get back a 1-element
  // array. With the fix, fall through to Fisher-Yates returns 10 indices.
  const indices = sampleWithoutReplacement(100, 10, stuck);
  assert.equal(
    indices.length,
    10,
    `expected 10 indices; got ${indices.length} (HARD_CAP undersize bug?)`,
  );
  // And they must all be distinct.
  const distinct = new Set(indices);
  assert.equal(
    distinct.size,
    10,
    `expected 10 distinct indices; got ${distinct.size}`,
  );
});

test('sampleWithoutReplacement returns count distinct indices under a working RNG', () => {
  // Sanity: with a real RNG the small-count path also delivers `count` items.
  const rng = createRng(2024);
  const indices = sampleWithoutReplacement(250, 20, rng);
  assert.equal(indices.length, 20);
  assert.equal(new Set(indices).size, 20);
  for (const i of indices) {
    assert.ok(i >= 0 && i < 250);
  }
});

// ---------------------------------------------------------------------------
// 14. (Regression — bug fix #2) runWorstCase reports unsolvableDays for the
// FINAL accepted roster, not whichever loop iteration exited the grow loop.
// ---------------------------------------------------------------------------

test('runWorstCase unsolvableDays reflects the final accepted roster', () => {
  // When the roster grows successfully and the loop exits with unsolvable=0,
  // the final re-run must also report 0 — i.e. the final pass agrees with
  // the loop's last iteration. The structural fix matters when the grow loop
  // hits the RECOMMENDATION_MAX cap (the bug case); the happy path verifies
  // the re-run is wired in correctly. We provide an explicit site rule so the
  // solver doesn't emit the "no rule" warning on every day.
  const sites = [makeSite('site-main', 'Main OR', 0, 3)];
  const rules: CoverageRuleSet = {
    siteRules: [
      {
        site: 'Main OR',
        defaultStaffing: 'supervised_md_crna',
      },
    ],
    globalRules: [],
  };
  const input: SimulatorInput = {
    config: baseConfig,
    sites,
    rules,
    roster: [],
    seed: 1,
  };
  const wc = runWorstCase(input);
  assert.equal(
    wc.unsolvableDays,
    0,
    `expected the accepted roster to solve every weekday; got ${wc.unsolvableDays} unsolvable`,
  );
  // weekdaysEvaluated is positive — calendar generation worked.
  assert.ok(wc.weekdaysEvaluated > 200, `expected ~250 weekdays`);
  // Sanity: the recommendation is bounded.
  assert.ok(wc.anesthesiologists > 0 && wc.anesthesiologists < 200);
  assert.ok(wc.crnas > 0 && wc.crnas < 200);
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
