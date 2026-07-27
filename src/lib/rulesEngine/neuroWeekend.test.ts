// Neuro weekend vocabulary (2026-07-27): FTE bands → units owed, placements →
// units credited (pair 1.0 / single day 0.5), and the per-provider report the
// solver gates on and the generation banner shows.
import { describe, it, expect } from 'vitest';
import {
  owedUnitsFor, creditedUnitsByProvider, computeNeuroReport, isShortByHalfUnit,
  type NeuroWeekendConfig,
} from './neuroWeekend';

// Paoli's bands: 1.0 owes nothing (fairness rotates them), 0.75 owes a full
// weekend, anything below owes a single day.
const CONFIG: NeuroWeekendConfig = {
  code: 'C3',
  requirementBands: [
    { minFte: 1, units: 0 },
    { minFte: 0.75, units: 1 },
    { minFte: 0, units: 0.5 },
  ],
};

// 2026-08-15 Sat / 2026-08-16 Sun = one weekend; 2026-08-22/23 = the next.
const place = (provider_id: string, slot_date: string, code = 'C3') =>
  ({ provider_id, slot_date, code });

describe('owedUnitsFor', () => {
  it('picks the highest band the FTE clears', () => {
    expect(owedUnitsFor(1, CONFIG)).toBe(0);
    expect(owedUnitsFor(0.75, CONFIG)).toBe(1);
    expect(owedUnitsFor(0.5, CONFIG)).toBe(0.5);
  });

  it('an FTE above the top band uses the top band', () => {
    expect(owedUnitsFor(1.2, CONFIG)).toBe(0);
  });

  it('no config bands means nothing is owed', () => {
    expect(owedUnitsFor(0.75, { code: 'C3', requirementBands: [] })).toBe(0);
  });
});

describe('creditedUnitsByProvider', () => {
  it('a Sat+Sun pair is ONE unit, not two', () => {
    const credited = creditedUnitsByProvider(
      [place('p1', '2026-08-15'), place('p1', '2026-08-16')], CONFIG);
    expect(credited.get('p1')).toBe(1);
  });

  it('a single weekend day is half a unit', () => {
    const credited = creditedUnitsByProvider([place('p1', '2026-08-16')], CONFIG);
    expect(credited.get('p1')).toBe(0.5);
  });

  it('two single days in DIFFERENT weekends add to a whole unit', () => {
    const credited = creditedUnitsByProvider(
      [place('p1', '2026-08-15'), place('p1', '2026-08-23')], CONFIG);
    expect(credited.get('p1')).toBe(1);
  });

  it('ignores non-neuro codes and non-weekend dates', () => {
    const credited = creditedUnitsByProvider([
      place('p1', '2026-08-15', 'C1'),   // wrong code
      place('p1', '2026-08-12'),         // Wednesday
    ], CONFIG);
    expect(credited.get('p1') ?? 0).toBe(0);
  });
});

describe('computeNeuroReport', () => {
  const providers = [
    { id: 'full', fte_value: 1 },
    { id: 'three4', fte_value: 0.75 },
    { id: 'half', fte_value: 0.5 },
  ];

  it('reports every provider with a requirement, including those with NO placements', () => {
    const rows = computeNeuroReport(providers, [], CONFIG);
    // 'full' owes 0 — excluded. The other two are short of everything, sorted
    // by provider_id (the function's own ordering guarantee, checked directly
    // rather than through a re-sorted comparison).
    expect(rows.map(r => r.provider_id)).toEqual(['half', 'three4']);
    expect(rows.find(r => r.provider_id === 'three4')).toMatchObject(
      { fte: 0.75, owed: 1, credited: 0, short: 1 });
    expect(rows.find(r => r.provider_id === 'half')).toMatchObject(
      { owed: 0.5, credited: 0, short: 0.5 });
  });

  it('a satisfied provider reports short 0', () => {
    const rows = computeNeuroReport(providers,
      [place('three4', '2026-08-15'), place('three4', '2026-08-16')], CONFIG);
    expect(rows.find(r => r.provider_id === 'three4')).toMatchObject(
      { owed: 1, credited: 1, short: 0 });
  });

  it('a 0.75 doc holding one leftover day is short exactly half', () => {
    const rows = computeNeuroReport(providers, [place('three4', '2026-08-16')], CONFIG);
    expect(rows.find(r => r.provider_id === 'three4')).toMatchObject(
      { owed: 1, credited: 0.5, short: 0.5 });
  });
});

describe('isShortByHalfUnit', () => {
  it('a provider owing 0 (1.0 FTE) is never short, at any credited value', () => {
    expect(isShortByHalfUnit(1, 0, CONFIG)).toBe(false);
    expect(isShortByHalfUnit(1, 5, CONFIG)).toBe(false);
  });

  it('a 0.75 FTE (owes 1) with 0 credited is short', () => {
    expect(isShortByHalfUnit(0.75, 0, CONFIG)).toBe(true);
  });

  it('a 0.75 FTE with 0.5 credited is still short exactly half', () => {
    expect(isShortByHalfUnit(0.75, 0.5, CONFIG)).toBe(true);
  });

  it('a 0.75 FTE with 1 credited is not short', () => {
    expect(isShortByHalfUnit(0.75, 1, CONFIG)).toBe(false);
  });

  it('a 0.5 FTE (owes 0.5) is short with 0 credited, satisfied with 0.5', () => {
    expect(isShortByHalfUnit(0.5, 0, CONFIG)).toBe(true);
    expect(isShortByHalfUnit(0.5, 0.5, CONFIG)).toBe(false);
  });

  it('over-credited is not short — a negative gap must not read as true', () => {
    expect(isShortByHalfUnit(0.75, 1.5, CONFIG)).toBe(false);
  });
});
