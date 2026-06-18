// Unit tests for the print-snapshot builder.
// Owned by agent A16 (Export).
//
// Run with: npx tsx src/lib/gridCalculator/__tests__/export.test.ts
// Matches the tsx + node:assert pattern used across the rest of the
// gridCalculator suite (A3, A6, A7, A8, A11).

import assert from 'node:assert/strict';

import { buildPrintSnapshot } from '../export';
import type { PrintSnapshotInput } from '../export';
import type { FloatAssignment, RoomAssignment, SolvedGrid } from '../solver';
import type { FTERecommendation, GridSite } from '../types';

// ---------------------------------------------------------------------------
// Mini test harness — same pattern as solver.test.ts.
// ---------------------------------------------------------------------------

type TestCase = { name: string; fn: () => void | Promise<void> };
const cases: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  cases.push({ name, fn });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_DATE = new Date('2026-06-17T14:30:00');

function makeSite(
  id: string,
  name: string,
  position: number,
  roomCount: number,
  overrides: Partial<GridSite> = {},
): GridSite {
  return {
    id,
    name,
    shortName: overrides.shortName ?? name.split(' ')[0],
    color: overrides.color ?? '#0ea5e9',
    icon: overrides.icon ?? '🏥',
    position,
    caption: overrides.caption,
    rooms: Array.from({ length: roomCount }, (_, i) => ({
      id: `${id}-r${i + 1}`,
      siteId: id,
      name: roomCount === 1 ? name : `${name} ${i + 1}`,
      position: i,
    })),
  };
}

function makeRoomAssignment(
  roomId: string,
  siteId: string,
  overrides: Partial<RoomAssignment> = {},
): RoomAssignment {
  return {
    roomId,
    siteId,
    anesthesiologistId: 'md-1',
    crnaIds: ['crna-1'],
    staffingPattern: 'supervised_md_crna',
    ...overrides,
  };
}

function makeGrid(overrides: Partial<SolvedGrid> = {}): SolvedGrid {
  return {
    configId: 'cfg-1',
    assignments: [],
    floats: [],
    violations: [],
    ...overrides,
  };
}

function makeRecommendation(overrides: Partial<FTERecommendation> = {}): FTERecommendation {
  return {
    anesthesiologist: { worstCase: 16, p50: 14, p95: 15, binding: 'worst_case' },
    crna: { worstCase: 30, p50: 28, p95: 32, binding: 'monte_carlo' },
    backupCall: { fte: 1.5, distribution: [] },
    rationale: 'Anesthesiologist binding by worst case; CRNA binding by Monte Carlo p95.',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test 1 — snapshot shape: header, lanes, FTE summary, footer all populated.
// ---------------------------------------------------------------------------

test('snapshot returns header, lanes, float lane, FTE summary, footer with the expected fields', () => {
  const sites = [
    makeSite('site-or', 'Main OR', 0, 2, { shortName: 'OR' }),
    makeSite('site-endo', 'Endo', 1, 1, { shortName: 'Endo' }),
  ];
  const grid = makeGrid({
    assignments: [
      makeRoomAssignment('site-or-r1', 'site-or'),
      makeRoomAssignment('site-or-r2', 'site-or', {
        crnaIds: ['crna-2'],
      }),
      makeRoomAssignment('site-endo-r1', 'site-endo', {
        anesthesiologistId: 'md-1',
        crnaIds: [],
        staffingPattern: 'solo_md',
      }),
    ],
    floats: [
      { providerId: 'crna-3', role: 'crna', leansToSiteId: 'site-or' },
    ] as FloatAssignment[],
    violations: [],
  });

  const input: PrintSnapshotInput = {
    hospital: { hospitalName: 'Paoli Hospital', configName: 'Default Weekday' },
    sites,
    grid,
    recommendation: makeRecommendation(),
    providerLabels: {
      'md-1': { name: 'Dr. Avery Chen', initials: 'AC' },
      'crna-1': { name: 'Riley Singh, CRNA', initials: 'RS' },
      'crna-2': { name: 'Jordan Park, CRNA', initials: 'JP' },
      'crna-3': { name: 'Casey Nguyen, CRNA', initials: 'CN' },
    },
    generatedAt: FIXED_DATE,
  };

  const snap = buildPrintSnapshot(input);

  // Header populated with hospital name, subtitle, and ISO date.
  assert.ok(snap.header.title.includes('Paoli Hospital'));
  assert.equal(snap.header.subtitle, 'Default Weekday');
  assert.equal(snap.header.dateStamp, '2026-06-17');

  // Two site lanes in position order; float lane separate with one provider.
  assert.equal(snap.siteLanes.length, 2);
  assert.deepEqual(
    snap.siteLanes.map((l) => l.siteId),
    ['site-or', 'site-endo'],
  );
  assert.equal(snap.siteLanes[0].rooms.length, 2);
  assert.equal(snap.siteLanes[1].rooms.length, 1);
  assert.equal(snap.floatLane.providers.length, 1);
  assert.equal(snap.floatLane.providers[0].provider.name, 'Casey Nguyen, CRNA');
  assert.equal(snap.floatLane.providers[0].leansToSite?.shortName, 'OR');

  // FTE summary present with three rows (Anesthesiologist, CRNA, Backup call).
  assert.equal(snap.fte.pending, false);
  assert.equal(snap.fte.rows.length, 3);
  assert.equal(snap.fte.rows[0].label, 'Anesthesiologists');
  assert.equal(snap.fte.rows[1].label, 'CRNAs');
  assert.equal(snap.fte.rows[2].label, 'Backup call FTE');

  // Footer carries the timestamp + binding note + config reference.
  assert.ok(snap.footer.caption.includes('Generated by Grid Calculator'));
  assert.ok(snap.footer.caption.includes('2026-06-17'));
  assert.ok(snap.footer.bindingNote.toLowerCase().includes('binding'));
  assert.ok(snap.footer.configReference.length > 0);

  // Orientation defaults to portrait per A16 charter.
  assert.equal(snap.orientation, 'portrait');
});

// ---------------------------------------------------------------------------
// Test 2 — hospital name surfaces in the header (admin-presentable per §2).
// ---------------------------------------------------------------------------

test('hospital name appears in the print header verbatim', () => {
  const sites = [makeSite('site-1', 'OR', 0, 1)];
  const grid = makeGrid({ assignments: [makeRoomAssignment('site-1-r1', 'site-1')] });

  const snap = buildPrintSnapshot({
    hospital: { hospitalName: 'Mount Olive Medical Center' },
    sites,
    grid,
    generatedAt: FIXED_DATE,
  });

  assert.equal(
    snap.header.title,
    'Anesthesia Coverage Grid — Mount Olive Medical Center',
  );
  // Missing config name falls back to the generic subtitle but does NOT swallow
  // the hospital name.
  assert.ok(snap.header.subtitle.length > 0);
  assert.ok(snap.header.title.includes('Mount Olive Medical Center'));
});

test('missing hospital name falls back to "Unknown Hospital" rather than rendering blank', () => {
  const sites = [makeSite('site-1', 'OR', 0, 1)];
  const grid = makeGrid({ assignments: [makeRoomAssignment('site-1-r1', 'site-1')] });

  const snap = buildPrintSnapshot({
    hospital: { hospitalName: '' },
    sites,
    grid,
    generatedAt: FIXED_DATE,
  });
  assert.equal(snap.header.title, 'Anesthesia Coverage Grid — Unknown Hospital');
});

// ---------------------------------------------------------------------------
// Test 3 — FTE numbers are formatted correctly and the recommendation is
// max(worstCase, p95) per PRD §10.
// ---------------------------------------------------------------------------

test('FTE numbers format correctly: whole numbers w/o decimals, partials w/ one decimal, recommendation = max(worst, p95)', () => {
  const sites = [makeSite('site-1', 'OR', 0, 1)];
  const grid = makeGrid({ assignments: [makeRoomAssignment('site-1-r1', 'site-1')] });

  const recommendation: FTERecommendation = {
    anesthesiologist: { worstCase: 16, p50: 14.0, p95: 15.7, binding: 'worst_case' },
    crna: { worstCase: 28.5, p50: 27.3, p95: 32, binding: 'monte_carlo' },
    backupCall: {
      fte: 1.5,
      distribution: [
        { providerId: 'md-a', fteShare: 0.18 },
        { providerId: 'md-b', fteShare: 0.42 },
      ],
    },
    rationale: 'Worst case binds Anesthesiologist headcount; p95 binds CRNA headcount.',
  };

  const snap = buildPrintSnapshot({
    hospital: { hospitalName: 'Paoli Hospital' },
    sites,
    grid,
    recommendation,
    providerLabels: {
      'md-a': { name: 'Dr. Alpha', initials: 'AA' },
      'md-b': { name: 'Dr. Bravo', initials: 'BB' },
    },
    generatedAt: FIXED_DATE,
  });

  // Recommended Anesthesiologist FTE = max(16, 15.7) = 16, formatted as integer.
  const mdRow = snap.fte.rows.find((r) => r.label === 'Anesthesiologists');
  assert.ok(mdRow);
  assert.equal(mdRow!.worstCase, '16');
  assert.equal(mdRow!.p50, '14');
  assert.equal(mdRow!.p95, '15.7');
  assert.equal(mdRow!.recommended, '16');
  assert.equal(mdRow!.binding, 'Worst case');

  // Recommended CRNA FTE = max(28.5, 32) = 32, partial p50 prints with 1 decimal.
  const crnaRow = snap.fte.rows.find((r) => r.label === 'CRNAs');
  assert.ok(crnaRow);
  assert.equal(crnaRow!.worstCase, '28.5');
  assert.equal(crnaRow!.p50, '27.3');
  assert.equal(crnaRow!.p95, '32');
  assert.equal(crnaRow!.recommended, '32');
  assert.equal(crnaRow!.binding, 'Monte Carlo p95');

  // Backup call: whole FTE prints w/o decimal.
  const backupRow = snap.fte.rows.find((r) => r.label === 'Backup call FTE');
  assert.ok(backupRow);
  assert.equal(backupRow!.recommended, '1.5');

  // Top-level recommendation numbers match what's in the rows.
  assert.equal(snap.fte.recommendedAnesthesiologist, 16);
  assert.equal(snap.fte.recommendedCrna, 32);
  assert.equal(snap.fte.recommendedBackupCall, 1.5);

  // Backup-call distribution surfaces with formatted shares + resolved names.
  assert.equal(snap.fte.backupCallDistribution.length, 2);
  assert.equal(snap.fte.backupCallDistribution[0].displayName, 'Dr. Alpha');
  assert.equal(snap.fte.backupCallDistribution[0].fteShare, '0.18');
  assert.equal(snap.fte.backupCallDistribution[1].fteShare, '0.42');

  // Rationale text appears verbatim (trimmed if present).
  assert.equal(
    snap.fte.rationale,
    'Worst case binds Anesthesiologist headcount; p95 binds CRNA headcount.',
  );
  // Binding summary is human-readable.
  assert.ok(snap.fte.bindingSummary.toLowerCase().includes('worst case'));
  assert.ok(snap.fte.bindingSummary.toLowerCase().includes('monte carlo'));
});

// ---------------------------------------------------------------------------
// Test 4 — missing recommendation renders pending state, not a crash.
// ---------------------------------------------------------------------------

test('missing FTE recommendation renders pending state with em-dash placeholders', () => {
  const sites = [makeSite('site-1', 'OR', 0, 1)];
  const grid = makeGrid({ assignments: [makeRoomAssignment('site-1-r1', 'site-1')] });

  const snap = buildPrintSnapshot({
    hospital: { hospitalName: 'Paoli Hospital' },
    sites,
    grid,
    generatedAt: FIXED_DATE,
  });

  assert.equal(snap.fte.pending, true);
  assert.equal(snap.fte.rows.length, 3);
  for (const row of snap.fte.rows) {
    assert.equal(row.worstCase, '—');
    assert.equal(row.p50, '—');
    assert.equal(row.p95, '—');
    assert.equal(row.recommended, '—');
  }
  assert.ok(snap.fte.rationale.includes('pending'));
});

// ---------------------------------------------------------------------------
// Test 5 — cross-site supervision badge propagates into the PrintRoomRow.
// ---------------------------------------------------------------------------

test('cross-site supervision propagates the supervising site short label', () => {
  const sites = [
    makeSite('site-or', 'Main OR', 0, 1, { shortName: 'OR' }),
    makeSite('site-ep', 'EP Lab', 1, 1, { shortName: 'EP' }),
  ];
  const grid = makeGrid({
    assignments: [
      makeRoomAssignment('site-or-r1', 'site-or'),
      makeRoomAssignment('site-ep-r1', 'site-ep', {
        anesthesiologistId: 'md-1',
        crossSiteSupervisor: { providerId: 'md-1', fromSiteId: 'site-or' },
      }),
    ],
  });

  const snap = buildPrintSnapshot({
    hospital: { hospitalName: 'Paoli Hospital' },
    sites,
    grid,
    providerLabels: { 'md-1': { name: 'Dr. Avery Chen', initials: 'AC' } },
    generatedAt: FIXED_DATE,
  });

  const epLane = snap.siteLanes.find((l) => l.siteId === 'site-ep');
  assert.ok(epLane);
  assert.equal(epLane!.rooms.length, 1);
  assert.deepEqual(epLane!.rooms[0].crossSite, {
    providerId: 'md-1',
    fromSiteShortLabel: 'OR',
  });
});

// ---------------------------------------------------------------------------
// Test 6 — provider labels missing entries fall back to provider id slugs.
// ---------------------------------------------------------------------------

test('missing provider label falls back to provider id + derived initials', () => {
  const sites = [makeSite('site-or', 'Main OR', 0, 1)];
  const grid = makeGrid({
    assignments: [
      makeRoomAssignment('site-or-r1', 'site-or', {
        anesthesiologistId: 'md-unknown',
        crnaIds: ['crna-unknown-12345'],
      }),
    ],
  });

  const snap = buildPrintSnapshot({
    hospital: { hospitalName: 'Paoli Hospital' },
    sites,
    grid,
    generatedAt: FIXED_DATE,
  });

  const row = snap.siteLanes[0].rooms[0];
  assert.ok(row.anesthesiologist);
  assert.equal(row.anesthesiologist!.name, 'md-unknown');
  assert.equal(row.anesthesiologist!.initials, 'MD'); // first two chars uppercased
  assert.equal(row.crnas.length, 1);
  assert.equal(row.crnas[0].name, 'crna-unknown-12345');
});

// ---------------------------------------------------------------------------
// Test 7 — orientation override is preserved.
// ---------------------------------------------------------------------------

test('landscape orientation is preserved in the snapshot', () => {
  const sites = [makeSite('site-or', 'Main OR', 0, 1)];
  const grid = makeGrid({ assignments: [makeRoomAssignment('site-or-r1', 'site-or')] });

  const snap = buildPrintSnapshot({
    hospital: { hospitalName: 'Paoli Hospital' },
    sites,
    grid,
    orientation: 'landscape',
    generatedAt: FIXED_DATE,
  });
  assert.equal(snap.orientation, 'landscape');
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
