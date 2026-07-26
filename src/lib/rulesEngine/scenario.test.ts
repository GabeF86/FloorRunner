// Scenario projection (Paoli block phase 2) — manifest → engine-facing
// ScenarioDoc. The stored artifact is the FULL phase-1 manifest (patch37
// decision: the DB column holds the validated import artifact verbatim; the
// engine projection is computed at load time so the audit source of truth is
// single-homed). These tests drive the projection through the REAL phase-1
// importer on the constraint-rich synthetic workbook, plus small unit cases.
import { describe, it, expect } from 'vitest';
import {
  projectScenario, scenarioBucketOf, weekendAnchorOf, scenarioProhibits,
  scenarioHasCaps, DEFAULT_SCENARIO_CODE_MAP, NEURO_KEY,
} from './scenario';
import { buildSyntheticFullWorkbook, TEST_ROSTER } from '../paoliBlock/__fixtures__/syntheticFullWorkbook';
import { importPaoliBlockWorkbook } from '../paoliBlock/importWorkbook';

function syntheticManifest() {
  const res = importPaoliBlockWorkbook(buildSyntheticFullWorkbook(), {
    workbookLabel: 'synthetic.xlsx', roster: TEST_ROSTER, defaultYear: 2026,
  });
  expect(res.hardErrors).toEqual([]);
  expect(res.manifest).not.toBeNull();
  return res.manifest!;
}

describe('scenarioBucketOf / weekendAnchorOf', () => {
  it('maps dates to workbook buckets by DAY OF WEEK (holidays included)', () => {
    expect(scenarioBucketOf('2026-08-10')).toBe('MTH'); // Monday
    expect(scenarioBucketOf('2026-08-13')).toBe('MTH'); // Thursday
    expect(scenarioBucketOf('2026-08-14')).toBe('FRI');
    expect(scenarioBucketOf('2026-08-15')).toBe('SAT');
    expect(scenarioBucketOf('2026-08-16')).toBe('SUN');
    // Labor Day 2026-09-07 is a Monday: MTH regardless of holiday day type —
    // the workbook targets are day-of-week scoped ("Monday–Thursday C1").
    expect(scenarioBucketOf('2026-09-07')).toBe('MTH');
  });
  it('weekendAnchorOf returns the Saturday of the Fri–Sun window, null off-weekend', () => {
    expect(weekendAnchorOf('2026-08-14')).toBe('2026-08-15'); // Fri -> Sat
    expect(weekendAnchorOf('2026-08-15')).toBe('2026-08-15'); // Sat
    expect(weekendAnchorOf('2026-08-16')).toBe('2026-08-15'); // Sun -> prior Sat
    expect(weekendAnchorOf('2026-08-17')).toBeNull();          // Mon
  });
});

describe('projectScenario (synthetic full workbook)', () => {
  const manifest = syntheticManifest();

  it('projects all 10 providers with exact fractional targets under engine codes', () => {
    const { scenario, warnings } = projectScenario(manifest, {});
    expect(warnings).toEqual([]);
    expect(scenario).not.toBeNull();
    expect(scenario!.providers.size).toBe(10);
    expect(scenario!.neuroCode).toBe('C3');

    const mojica = scenario!.providers.get('prov-mojica')!;
    expect(mojica.targets.get('MTH|C1')).toBe(4);
    expect(mojica.targets.get('SAT|C2')).toBe(0.5); // fractional preserved, never rounded
    expect(mojica.neuroTarget).toBe(1);

    const horan = scenario!.providers.get('prov-horan')!;
    expect(horan.targets.get('FRI|C2')).toBe(0);    // stated zero stays a stated zero
    expect(horan.scenarioFte).toBe(0.5);
  });

  it('projects prohibitions: date-specific per-code, all-call ranges, recurring weekday', () => {
    const { scenario } = projectScenario(manifest, {});
    const amusa = scenario!.providers.get('prov-amusa')!;
    expect(scenarioProhibits(amusa, '2026-08-13', 'C1')).toBe(true);
    expect(scenarioProhibits(amusa, '2026-08-13', 'C2')).toBe(false); // C1-only prohibition
    expect(scenarioProhibits(amusa, '2026-09-19', 'C2')).toBe(true);  // F/S/S all-call range
    const kala = scenario!.providers.get('prov-kalawadia')!;
    // Recurring: no Monday C1 — every Monday, C1 only.
    expect(scenarioProhibits(kala, '2026-08-10', 'C1')).toBe(true);
    expect(scenarioProhibits(kala, '2026-08-10', 'C2')).toBe(false);
    expect(scenarioProhibits(kala, '2026-08-11', 'C1')).toBe(false); // Tuesday
  });

  it('projects linkages with parsed members and either-or ANY excluding the neuro code', () => {
    const { scenario } = projectScenario(manifest, {});
    const simon = scenario!.providers.get('prov-simon')!;
    const sw = simon.linkages.find(l => l.kind === 'same-weekend' && l.rawMembers.includes('SAT:C1'))!;
    expect(sw.members).toEqual([
      { dow: 6, date: null, code: 'C1' },
      { dow: 0, date: null, code: 'C2' },
    ]);
    const hussain = scenario!.providers.get('prov-hussain')!;
    const eo = hussain.linkages.find(l => l.kind === 'either-or')!;
    expect(eo.members.map(m => m.code)).toEqual(['ANY', 'ANY']);
    const sd = hussain.linkages.find(l => l.kind === 'same-date')!;
    expect(sd.members.map(m => m.code)).toEqual(['C2', 'C3']); // NEURO mapped to C3
  });

  it('projects preferences (Kalawadia Tuesday C1) and mandatory-retained conflicts (Jones)', () => {
    const { scenario } = projectScenario(manifest, {});
    const kala = scenario!.providers.get('prov-kalawadia')!;
    expect(kala.preferences).toHaveLength(1);
    expect(kala.preferences[0]).toMatchObject({ kind: 'weekday', weekday: 2, codes: ['C1'] });
    const jones = scenario!.providers.get('prov-jones')!;
    expect(jones.mandatoryRetained).toHaveLength(3);
    expect(jones.mandatoryRetained[0]).toMatchObject({ date: '2026-09-05', code: 'C2' });
    // Jones's fixed assignments carry through under engine codes (phase 3 seeds them).
    expect(jones.fixedAssignments.map(f => `${f.date}:${f.code}`))
      .toEqual(['2026-09-05:C2', '2026-09-06:C1', '2026-09-07:C2']);
  });

  it('scenarioHasCaps is true (targets stated) and default code map is C1/C2/NEURO→C3', () => {
    const { scenario } = projectScenario(manifest, {});
    expect(scenarioHasCaps(scenario!)).toBe(true);
    expect(DEFAULT_SCENARIO_CODE_MAP).toEqual({ C1: 'C1', C2: 'C2', NEURO: 'C3' });
    expect(NEURO_KEY).toBe('NEURO_FSS');
  });
});

describe('projectScenario degradation', () => {
  it('invalid manifest -> null scenario + a loud warning, never a throw', () => {
    const { scenario, warnings } = projectScenario({ not: 'a manifest' }, {});
    expect(scenario).toBeNull();
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toMatch(/scenario manifest/i);
  });

  it('a manifest provider with null providerId is skipped with a warning', () => {
    const manifest = syntheticManifest();
    const mutated = JSON.parse(JSON.stringify(manifest));
    mutated.providers[0].providerId = null;
    const { scenario, warnings } = projectScenario(mutated, {});
    expect(scenario!.providers.size).toBe(9);
    expect(warnings.some(w => /Amusa/.test(w) && /unmatched/i.test(w))).toBe(true);
  });

  it('a manifest provider outside the known pool is skipped with a warning', () => {
    const manifest = syntheticManifest();
    const pool = new Set(TEST_ROSTER.map(r => r.id).filter(id => id !== 'prov-jones'));
    const { scenario, warnings } = projectScenario(manifest, { knownProviderIds: pool });
    expect(scenario!.providers.size).toBe(9);
    expect(scenario!.providers.has('prov-jones')).toBe(false);
    expect(warnings.some(w => /Jones/.test(w) && /pool/i.test(w))).toBe(true);
  });

  it('unknown engine code for a mapped workbook code warns (when shift codes provided)', () => {
    const manifest = syntheticManifest();
    const { warnings } = projectScenario(manifest, {
      knownShiftCodes: new Set(['C1', 'C2']), // no C3 at "this site"
    });
    expect(warnings.some(w => /C3/.test(w))).toBe(true);
  });
});
