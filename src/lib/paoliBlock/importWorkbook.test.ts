import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { importPaoliBlockWorkbook } from './importWorkbook';
import { PROMPT_EXPECTED_CHECKSUMS } from './checksums';
import { validateManifest } from './manifest';
import {
  buildSyntheticFullWorkbook,
  TEST_ROSTER,
} from './__fixtures__/syntheticFullWorkbook';

const REAL_GRID = readFileSync(
  path.join(__dirname, '__fixtures__', 'paoli-11-week-block.xlsx'),
);

describe('importPaoliBlockWorkbook — synthetic full workbook (A:M, Sheet4)', () => {
  const result = importPaoliBlockWorkbook(buildSyntheticFullWorkbook(), {
    workbookLabel: 'synthetic-full.xlsx',
    roster: TEST_ROSTER,
    expectedChecksums: PROMPT_EXPECTED_CHECKSUMS,
  });
  const manifest = result.manifest!;
  const byName = (n: string) =>
    manifest.providers.find((p) => p.normalizedName === n)!;

  it('imports all 10 providers uniquely with no hard errors', () => {
    expect(result.hardErrors).toEqual([]);
    expect(manifest.providers).toHaveLength(10);
    expect(new Set(manifest.providers.map((p) => p.providerId)).size).toBe(10);
  });

  it('matches all the prompt checksums exactly', () => {
    expect(result.checksums.ok).toBe(true);
    expect(result.checksums.computed.totalFte).toBe(8.75);
    expect(result.checksums.computed.targets.SUN_C1).toBe(8.5);
  });

  it('produces a manifest that passes its own validator', () => {
    const res = validateManifest(manifest);
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it('trims and matches `Simon ` while preserving the raw source name', () => {
    const simon = byName('simon');
    expect(simon.sourceName).toBe('Simon ');
    expect(simon.providerId).toBe('prov-simon');
    expect(simon.scenarioFte).toBe(0.75);
  });

  it('preserves 0.5 decimal targets (never rounded to 0 or 1)', () => {
    expect(byName('havildar').targets.FRI_C2).toBe(0.5);
    expect(byName('lin').targets.SUN_C2).toBe(0.5);
    expect(byName('horan').scenarioFte).toBe(0.5);
  });

  it('Amusa: two C1-specific date prohibitions + an all-call F/S/S weekend', () => {
    const amusa = byName('amusa');
    expect(amusa.prohibitions).toHaveLength(3);
    expect(amusa.prohibitions[0]).toMatchObject({ dates: ['2026-08-13'], callCodes: ['C1'] });
    expect(amusa.prohibitions[1]).toMatchObject({ dates: ['2026-08-24'], callCodes: ['C1'] });
    expect(amusa.prohibitions[2].callCodes).toBe('all');
    expect(amusa.prohibitions[2].dates).toEqual(['2026-09-18', '2026-09-19', '2026-09-20']);
  });

  it('Farkas: two inclusive all-call ranges', () => {
    const farkas = byName('farkas');
    expect(farkas.providerId).toBe('prov-farkas');
    expect(farkas.prohibitions.map((p) => p.dates)).toEqual([
      ['2026-09-11', '2026-09-12', '2026-09-13'],
      ['2026-09-20', '2026-09-21'],
    ]);
  });

  it('Kalawadia: recurring Monday-C1 prohibition + Tuesday soft preference', () => {
    const k = byName('kalawadia');
    expect(k.prohibitions[0].recurrence).toEqual({ weekday: 'MON' });
    expect(k.prohibitions[0].callCodes).toEqual(['C1']);
    expect(k.preferences[0]).toMatchObject({ kind: 'weekday', weekday: 'TUE' });
  });

  it('Mojica: three no-call windows + mandatory C1 on Labor Day 2026-09-07', () => {
    const m = byName('mojica');
    expect(m.prohibitions).toHaveLength(3);
    expect(m.prohibitions[2].dates).toEqual(['2026-10-17']);
    expect(m.fixedAssignments).toEqual([
      expect.objectContaining({ date: '2026-09-07', code: 'C1' }),
    ]);
  });

  it('Lin: fixed C1 2026-09-04 and Neuro 2026-09-05/06', () => {
    expect(byName('lin').fixedAssignments).toEqual([
      expect.objectContaining({ date: '2026-09-04', code: 'C1' }),
      expect.objectContaining({ date: '2026-09-05', code: 'NEURO' }),
      expect.objectContaining({ date: '2026-09-06', code: 'NEURO' }),
    ]);
  });

  it('Havildar: exactly-one Sat/Sun Neuro pair linkage', () => {
    const link = byName('havildar').linkages.find((l) => l.kind === 'same-weekend')!;
    expect(link.members).toEqual(['SAT:NEURO', 'SUN:NEURO']);
    expect(link.details).toMatch(/exactly-one/);
  });

  it('Horan: fixed 9/5 C1 + 9/6 C2, and Friday C1 linked to his Sat/Sun Neuro weekend', () => {
    const h = byName('horan');
    expect(h.fixedAssignments).toEqual([
      expect.objectContaining({ date: '2026-09-05', code: 'C1' }),
      expect.objectContaining({ date: '2026-09-06', code: 'C2' }),
    ]);
    const link = h.linkages.find((l) => l.kind === 'same-weekend')!;
    expect(link.members).toEqual(['FRI:C1', 'SAT:NEURO', 'SUN:NEURO']);
  });

  it('Simon: same-weekend Sat C1/Sun C2, 12h split with Horan, Neuro pair + ideally-Fri-C1 preference', () => {
    const s = byName('simon');
    const kinds = s.linkages.map((l) => l.kind);
    expect(kinds).toContain('same-weekend');
    expect(kinds).toContain('split-12h');
    const sw = s.linkages.filter((l) => l.kind === 'same-weekend');
    expect(sw[0].members).toEqual(['SAT:C1', 'SUN:C2']);
    expect(sw[1].members).toEqual(['SAT:NEURO', 'SUN:NEURO']);
    const split = s.linkages.find((l) => l.kind === 'split-12h')!;
    expect(split.members).toContain('Horan');
    const pref = s.preferences.find((p) => p.kind === 'same-weekend')!;
    expect(pref.members).toEqual(['FRI:C1']);
  });

  it('Hussain: Fri C2+Neuro combined (same-date), same-weekend with Sat/Sun Neuro, either-Sat-or-Sun', () => {
    const h = byName('hussain');
    expect(h.linkages.find((l) => l.kind === 'same-date')!.members).toEqual([
      'FRI:C2',
      'FRI:NEURO',
    ]);
    expect(h.linkages.find((l) => l.kind === 'same-weekend')).toBeDefined();
    expect(h.linkages.find((l) => l.kind === 'either-or')!.members).toEqual([
      'SAT:ANY',
      'SUN:ANY',
    ]);
  });

  it('Jones: mandatory wins over the no-call cell, conflicts recorded, wrong weekday word warned', () => {
    const j = byName('jones');
    expect(j.fixedAssignments).toHaveLength(3);
    expect(j.prohibitions).toHaveLength(3);
    expect(j.conflicts).toHaveLength(3);
    expect(j.conflicts.every((c) => c.resolution === 'mandatory-retained')).toBe(true);
    expect(j.warnings.some((w) => /friday/i.test(w) && /saturday/i.test(w))).toBe(true);
  });

  it('records original source text verbatim', () => {
    expect(byName('jones').sourceText.noCall).toBe('No call 9/5 (Friday), 9/6, 9/7.');
    expect(byName('amusa').sourceText.mandatory).toBeNull();
  });
});

describe('importPaoliBlockWorkbook — unmatched roster name is a hard error', () => {
  it('Amusa missing from the roster fails the import', () => {
    const noAmusa = TEST_ROSTER.filter((r) => r.id !== 'prov-amusa');
    const result = importPaoliBlockWorkbook(buildSyntheticFullWorkbook(), {
      workbookLabel: 'synthetic-full.xlsx',
      roster: noAmusa,
    });
    expect(result.hardErrors.length).toBeGreaterThan(0);
    expect(result.hardErrors.join(' ')).toMatch(/Amusa/);
  });
});

describe('importPaoliBlockWorkbook — REAL simpler targets grid', () => {
  const result = importPaoliBlockWorkbook(REAL_GRID, {
    workbookLabel: 'paoli-11-week-block.xlsx',
    roster: TEST_ROSTER,
    expectedChecksums: PROMPT_EXPECTED_CHECKSUMS,
  });
  const manifest = result.manifest!;

  it('imports the 10 providers from the grid shape with no hard errors', () => {
    expect(result.hardErrors).toEqual([]);
    expect(manifest.source.shape).toBe('grid');
    expect(manifest.providers).toHaveLength(10);
    expect(manifest.providers.map((p) => p.sourceName)[7]).toBe('Simon ');
  });

  it('computes the grid totals (FTE 8.75, M-Th C1/C2 35) with fractional weekend targets', () => {
    const c = result.checksums.computed;
    expect(c.providerRows).toBe(10);
    expect(c.totalFte).toBe(8.75);
    expect(c.targets.MTH_C1).toBe(35);
    expect(c.targets.MTH_C2).toBe(35);
    expect(c.targets.FRI_C1).toBe(8.75);
    expect(c.targets.NEURO_FSS).toBe(8.75);
  });

  it('reports the mismatches against the full-workbook checksums instead of failing silently', () => {
    expect(result.checksums.ok).toBe(false);
    const bad = result.checksums.comparisons.filter((c) => !c.ok).map((c) => c.key);
    expect(bad.sort()).toEqual([
      'FRI_C1',
      'FRI_C2',
      'NEURO_FSS',
      'SAT_C1',
      'SAT_C2',
      'SUN_C1',
      'SUN_C2',
    ]);
    const ok = result.checksums.comparisons.filter((c) => c.ok).map((c) => c.key);
    expect(ok.sort()).toEqual(['MTH_C1', 'MTH_C2', 'provider_rows', 'total_fte']);
  });

  it('grid shape yields empty constraint records (no L/M columns) and a valid manifest', () => {
    expect(manifest.providers.every((p) => p.prohibitions.length === 0)).toBe(true);
    expect(manifest.providers.every((p) => p.fixedAssignments.length === 0)).toBe(true);
    expect(validateManifest(manifest).ok).toBe(true);
  });

  it('never rounds the fractional targets (Horan row is 0.5 across the weekend buckets)', () => {
    const horan = manifest.providers.find((p) => p.normalizedName === 'horan')!;
    expect(horan.scenarioFte).toBe(0.5);
    expect(horan.targets.FRI_C1).toBe(0.5);
    expect(horan.targets.SUN_C2).toBe(0.5);
  });
});
