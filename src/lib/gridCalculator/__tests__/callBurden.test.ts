// Unit tests for the annual call-burden distributor.
// Owned by agent A8 (Call Burden) per PRD §11, §14.
//
// Run with: npx tsx src/lib/gridCalculator/__tests__/callBurden.test.ts
// (matches A3's convention — zero-dependency tsx + node:assert.)

import assert from 'node:assert/strict';

import {
  distributeCall,
  giniCoefficient,
  SHARE_FLOAT_TOLERANCE,
} from '../callBurden';
import type {
  CallDistributionInput,
  CallRosterEntry,
} from '../callBurden';
import type { ProviderLeaveProfile } from '../providerProfile';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeProvider(
  id: string,
  fte: number,
  opts: { call_taker?: boolean; backup_call_eligible?: boolean } = {},
): CallRosterEntry {
  return {
    id,
    fte,
    call_taker: opts.call_taker ?? true,
    backup_call_eligible: opts.backup_call_eligible ?? true,
  };
}

function baseInput(
  roster: CallRosterEntry[],
  overrides: Partial<CallDistributionInput> = {},
): CallDistributionInput {
  return {
    roster,
    annualPrimarySlots: 365,
    annualBackupSlots: 365,
    posture: 'conservative',
    providerLeaveProfiles: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mini harness — mirrors solver.test.ts pattern.
// ---------------------------------------------------------------------------

type TestCase = { name: string; fn: () => void | Promise<void> };
const cases: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  cases.push({ name, fn });
}

// ---------------------------------------------------------------------------
// 1. Equal-FTE providers → ±1 night, near-zero Gini.
// ---------------------------------------------------------------------------

test('equal-FTE providers receive primary calls within ±1 night, Gini ≈ 0', () => {
  const roster = [
    makeProvider('p1', 1.0),
    makeProvider('p2', 1.0),
    makeProvider('p3', 1.0),
    makeProvider('p4', 1.0),
  ];
  // Choose a slot count that divides evenly for the cleanest possible test.
  const out = distributeCall(baseInput(roster, { annualPrimarySlots: 100 }));
  const counts = out.perProvider.map((p) => p.primaryCallNights);
  const min = Math.min(...counts);
  const max = Math.max(...counts);
  assert.ok(max - min <= 1, `spread should be ≤1 night, got [${counts.join(', ')}]`);
  assert.equal(counts.reduce((a, b) => a + b, 0), 100);
  // Equal counts → perfect Gini.
  assert.ok(out.gini < 0.01, `Gini should be ~0 for equal split, got ${out.gini}`);
  assert.deepEqual(out.violations, []);
});

// ---------------------------------------------------------------------------
// 2. Mixed FTE (0.5 / 0.8 / 1.0) → counts ratio matches FTE ratio within ±1.
// ---------------------------------------------------------------------------

test('mixed FTE (0.5 / 0.8 / 1.0) distributes proportionally within ±1', () => {
  const roster = [
    makeProvider('p-half', 0.5),
    makeProvider('p-eighty', 0.8),
    makeProvider('p-full', 1.0),
  ];
  const slots = 230; // total FTE 2.3 → 100 slots per FTE-unit
  const out = distributeCall(baseInput(roster, { annualPrimarySlots: slots }));
  const byId = new Map(out.perProvider.map((p) => [p.providerId, p.primaryCallNights]));
  const half = byId.get('p-half')!;
  const eighty = byId.get('p-eighty')!;
  const full = byId.get('p-full')!;

  // Expected: 50 / 80 / 100. The greedy may shift by ±1 per provider.
  assert.ok(Math.abs(half - 50) <= 1, `half got ${half}, expected ~50`);
  assert.ok(Math.abs(eighty - 80) <= 1, `eighty got ${eighty}, expected ~80`);
  assert.ok(Math.abs(full - 100) <= 1, `full got ${full}, expected ~100`);
  assert.equal(half + eighty + full, slots);
});

// ---------------------------------------------------------------------------
// 3. call_taker=false → zero primary call nights, still appears in output.
// ---------------------------------------------------------------------------

test('provider with call_taker=false receives zero primary calls', () => {
  const roster = [
    makeProvider('p1', 1.0),
    makeProvider('p2', 1.0, { call_taker: false }),
    makeProvider('p3', 1.0),
  ];
  const out = distributeCall(baseInput(roster, { annualPrimarySlots: 60 }));
  const p2 = out.perProvider.find((p) => p.providerId === 'p2');
  assert.ok(p2);
  assert.equal(p2!.primaryCallNights, 0);
  // The two eligible providers absorb the full 60.
  const others = out.perProvider
    .filter((p) => p.providerId !== 'p2')
    .reduce((acc, p) => acc + p.primaryCallNights, 0);
  assert.equal(others, 60);
});

// ---------------------------------------------------------------------------
// 4. Pinned backup_call_share_target → exactly that share.
// ---------------------------------------------------------------------------

test('pinned backup_call_share_target is honored exactly; remainder distributed', () => {
  const roster = [
    makeProvider('pinned', 1.0),
    makeProvider('p2', 1.0),
    makeProvider('p3', 1.0),
  ];
  const profiles: Record<string, Partial<ProviderLeaveProfile>> = {
    pinned: { backup_call_share_target: 0.5 },
  };
  const out = distributeCall(
    baseInput(roster, {
      annualBackupSlots: 200,
      providerLeaveProfiles: profiles,
      posture: 'aggressive',
    }),
  );
  const pinned = out.perProvider.find((p) => p.providerId === 'pinned')!;
  assert.equal(pinned.backupCallFteShare, 0.5);

  const rest = out.perProvider
    .filter((p) => p.providerId !== 'pinned')
    .reduce((acc, p) => acc + p.backupCallFteShare, 0);
  // Remaining 0.5 distributed across p2/p3.
  assert.ok(
    Math.abs(rest - 0.5) < 1e-9,
    `expected remainder ~0.5, got ${rest}`,
  );
});

// ---------------------------------------------------------------------------
// 5. aggressive posture touches strictly more providers than conservative.
// ---------------------------------------------------------------------------

test('aggressive posture produces more non-zero backup shares than conservative', () => {
  // Six providers — plenty of room for both postures to differ. FTE values
  // are slightly varied so the greedy doesn't tie up trivially.
  const roster = [
    makeProvider('p1', 1.0),
    makeProvider('p2', 1.0),
    makeProvider('p3', 0.8),
    makeProvider('p4', 0.8),
    makeProvider('p5', 0.5),
    makeProvider('p6', 0.5),
  ];

  const aggressive = distributeCall(
    baseInput(roster, { posture: 'aggressive' }),
  );
  const conservative = distributeCall(
    baseInput(roster, { posture: 'conservative' }),
  );

  const countNonZero = (out: typeof aggressive) =>
    out.perProvider.filter((p) => p.backupCallFteShare > SHARE_FLOAT_TOLERANCE).length;

  const aggressiveCount = countNonZero(aggressive);
  const conservativeCount = countNonZero(conservative);
  assert.ok(
    aggressiveCount > conservativeCount,
    `aggressive should reach more providers (${aggressiveCount}) than conservative (${conservativeCount})`,
  );
});

// ---------------------------------------------------------------------------
// 6. Sum of backupCallFteShare ≈ 1.0 across postures and mixed pinning.
// ---------------------------------------------------------------------------

test('backupCallFteShare sums to ~1.0 across postures and pinning scenarios', () => {
  const roster = [
    makeProvider('p1', 1.0),
    makeProvider('p2', 0.8),
    makeProvider('p3', 0.6),
    makeProvider('p4', 0.4),
  ];
  const pinScenarios: Record<string, Partial<ProviderLeaveProfile>>[] = [
    {},
    { p1: { backup_call_share_target: 0.3 } },
    { p1: { backup_call_share_target: 0.4 }, p2: { backup_call_share_target: 0.2 } },
  ];
  for (const posture of ['aggressive', 'conservative'] as const) {
    for (const pinSet of pinScenarios) {
      const out = distributeCall(
        baseInput(roster, {
          posture,
          providerLeaveProfiles: pinSet,
        }),
      );
      const sum = out.perProvider.reduce((acc, p) => acc + p.backupCallFteShare, 0);
      assert.ok(
        Math.abs(sum - 1.0) < 1e-6,
        `[${posture}] backup share sum should be ~1.0, got ${sum}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 7. Empty / fully ineligible roster → empty distribution + violation; no throw.
// ---------------------------------------------------------------------------

test('zero call-eligible providers returns violation, never throws', () => {
  // Case A: completely empty roster.
  const a = distributeCall(baseInput([]));
  assert.equal(a.perProvider.length, 0);
  assert.ok(Number.isNaN(a.gini));
  assert.ok(a.violations.some((v) => v.includes('No call-eligible providers')));

  // Case B: roster of ineligible providers — they still appear in output as
  // zeros so downstream joins don't drop them.
  const b = distributeCall(
    baseInput([
      makeProvider('p1', 1.0, { call_taker: false, backup_call_eligible: false }),
      makeProvider('p2', 1.0, { call_taker: false, backup_call_eligible: false }),
    ]),
  );
  assert.equal(b.perProvider.length, 2);
  assert.ok(b.perProvider.every((p) => p.primaryCallNights === 0));
  assert.ok(b.perProvider.every((p) => p.backupCallFteShare === 0));
  assert.ok(b.violations.some((v) => v.includes('No call-eligible providers')));
});

// ---------------------------------------------------------------------------
// 8. Pinned overshoot (>1.0) is clamped to 1.0 with a violation flagged.
// ---------------------------------------------------------------------------

test('pinned share >1.0 is clamped and surfaced as a violation', () => {
  const roster = [makeProvider('p1', 1.0), makeProvider('p2', 1.0)];
  const profiles: Record<string, Partial<ProviderLeaveProfile>> = {
    p1: { backup_call_share_target: 0.7 },
    p2: { backup_call_share_target: 0.6 },
  };
  const out = distributeCall(
    baseInput(roster, { providerLeaveProfiles: profiles }),
  );
  const sum = out.perProvider.reduce((acc, p) => acc + p.backupCallFteShare, 0);
  assert.ok(Math.abs(sum - 1.0) < 1e-6, `sum should clamp to 1.0, got ${sum}`);
  assert.ok(out.violations.some((v) => v.includes('>1.0')));
});

// ---------------------------------------------------------------------------
// 9. Gini coefficient sanity on its own — perfect equality vs total inequality.
// ---------------------------------------------------------------------------

test('giniCoefficient returns 0 on perfect equality and ~(n-1)/n on total inequality', () => {
  assert.equal(giniCoefficient([10, 10, 10, 10]), 0);
  // One person takes 100, rest take 0 → Gini = (n-1)/n for n=4 → 0.75.
  const g = giniCoefficient([100, 0, 0, 0]);
  assert.ok(Math.abs(g - 0.75) < 1e-9, `expected ~0.75, got ${g}`);
  assert.ok(Number.isNaN(giniCoefficient([])));
  assert.ok(Number.isNaN(giniCoefficient([0, 0, 0])));
});

// ---------------------------------------------------------------------------
// 10. Determinism: same input twice → identical output (matches solver.test).
// ---------------------------------------------------------------------------

test('distributeCall is deterministic across runs', () => {
  const roster = [
    makeProvider('p3', 0.8),
    makeProvider('p1', 1.0),
    makeProvider('p2', 0.6),
  ];
  const profiles: Record<string, Partial<ProviderLeaveProfile>> = {
    p2: { backup_call_share_target: 0.25 },
  };
  const input = baseInput(roster, {
    annualPrimarySlots: 200,
    posture: 'aggressive',
    providerLeaveProfiles: profiles,
  });
  const a = distributeCall(input);
  const b = distributeCall(input);
  assert.deepEqual(a, b);
});

// ---------------------------------------------------------------------------
// 11. Pinned share on backup-ineligible provider → violation + pin ignored.
// ---------------------------------------------------------------------------

test('pinned share on backup-ineligible provider is ignored and surfaces a violation', () => {
  // The director marked p-ineligible as backup_call_eligible=false but a
  // stale employment profile still pins a 0.3 share to them. The engine must
  // NOT honor the pin (eligibility wins) and must raise a clear violation so
  // the conflict is visible in the UI.
  const roster = [
    makeProvider('p-ineligible', 1.0, { backup_call_eligible: false }),
    makeProvider('p-other-1', 1.0),
    makeProvider('p-other-2', 1.0),
  ];
  const profiles: Record<string, Partial<ProviderLeaveProfile>> = {
    'p-ineligible': { backup_call_share_target: 0.3 },
  };
  const out = distributeCall(
    baseInput(roster, {
      annualBackupSlots: 200,
      providerLeaveProfiles: profiles,
      posture: 'aggressive',
    }),
  );

  // Pin must be ignored — the ineligible provider gets zero backup share.
  const ineligible = out.perProvider.find(
    (p) => p.providerId === 'p-ineligible',
  )!;
  assert.equal(
    ineligible.backupCallFteShare,
    0,
    `ineligible provider should carry zero backup share, got ${ineligible.backupCallFteShare}`,
  );

  // Violation must surface so directors see the contradiction.
  assert.ok(
    out.violations.some((v) =>
      v.includes('Pinned target on backup-ineligible provider — pin ignored'),
    ),
    `expected eligibility-bypass violation, got [${out.violations.join(', ')}]`,
  );

  // The remaining 1.0 share must still sum cleanly across the eligible
  // providers — the ignored pin doesn't break the conservation invariant.
  const sum = out.perProvider.reduce(
    (acc, p) => acc + p.backupCallFteShare,
    0,
  );
  assert.ok(
    Math.abs(sum - 1.0) < 1e-6,
    `backup shares should still sum to ~1.0 after pin is ignored, got ${sum}`,
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
