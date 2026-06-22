import { describe, it, expect } from 'vitest';
import {
  clampConfig, severityFor, buildBreakAnalysis, breakCoverageNotes, feasibilityNotes,
  resolveCrossCover, crossCoverNotes, readStaffingWeight, staffingWeightField,
} from './shared';
import type { ConfigField, BreakSource } from './types';

describe('severityFor', () => {
  it('maps coverage pct to severity bands', () => {
    expect(severityFor(100)).toBe('ok');
    expect(severityFor(80)).toBe('tight');
    expect(severityFor(60)).toBe('warning');
    expect(severityFor(40)).toBe('critical');
  });
});

describe('clampConfig', () => {
  const schema: ConfigField[] = [
    { key: 'rooms', label: 'Rooms', section: 'x', kind: 'number', defaultValue: 7, min: 0, max: 9 },
    { key: 'flag', label: 'Flag', section: 'x', kind: 'toggle', defaultValue: false },
  ];
  it('clamps numbers into [min,max] and rounds', () => {
    expect(clampConfig(schema, { rooms: 99, flag: true }).rooms).toBe(9);
    expect(clampConfig(schema, { rooms: -5, flag: true }).rooms).toBe(0);
    expect(clampConfig(schema, { rooms: 3.7, flag: true }).rooms).toBe(4);
  });
  it('falls back to default on NaN / missing / non-number', () => {
    expect(clampConfig(schema, { rooms: NaN, flag: false }).rooms).toBe(7);
    expect(clampConfig(schema, {}).rooms).toBe(7);
    expect(clampConfig(schema, { rooms: 'abc' as unknown as number, flag: false }).rooms).toBe(7);
  });
  it('coerces toggles to boolean', () => {
    expect(clampConfig(schema, { rooms: 5, flag: 1 as unknown as boolean }).flag).toBe(true);
    expect(clampConfig(schema, { rooms: 5, flag: 0 as unknown as boolean }).flag).toBe(false);
  });
});

describe('buildBreakAnalysis', () => {
  it('aggregates capacity, gap, pct, severity from sources', () => {
    const sources: BreakSource[] = [
      { label: 'Floats', count: 2, breaks: 10, detail: '2 × 5' },
      { label: 'OB MD', count: 1, breaks: 1, detail: 'between cases' },
    ];
    const a = buildBreakAnalysis(8, sources);
    expect(a.demand).toBe(8);
    expect(a.capacity).toBe(11);
    expect(a.gap).toBe(-3);          // surplus
    expect(a.pct).toBe(100);         // capped at 100
    expect(a.severity).toBe('ok');
    expect(a.unrelieved).toBe(0);
  });
  it('reports a strained band when capacity < demand', () => {
    const sources: BreakSource[] = [{ label: 'Floats', count: 1, breaks: 5, detail: '1 × 5' }];
    const a = buildBreakAnalysis(10, sources);
    expect(a.capacity).toBe(5);
    expect(a.pct).toBe(50);
    expect(a.severity).toBe('warning');
    expect(a.unrelieved).toBe(5);
  });
  it('treats zero demand as 100% covered', () => {
    expect(buildBreakAnalysis(0, []).pct).toBe(100);
    expect(buildBreakAnalysis(0, []).severity).toBe('ok');
  });
});

describe('breakCoverageNotes', () => {
  it('produces the header + per-source + total + severity lines', () => {
    const a = buildBreakAnalysis(8, [{ label: 'Floats', count: 2, breaks: 10, detail: '2 × 5' }]);
    const notes = breakCoverageNotes(a);
    expect(notes[0]).toBe('── BREAK COVERAGE ──');
    expect(notes.some(n => n.includes('Floats'))).toBe(true);
    expect(notes.some(n => n.includes('Total:'))).toBe(true);
    expect(notes.some(n => n.includes('%'))).toBe(true);
  });
});

describe('staffing weight', () => {
  it('readStaffingWeight defaults to balanced for missing/invalid values', () => {
    expect(readStaffingWeight({})).toBe('balanced');
    expect(readStaffingWeight({ staffingWeight: 'nonsense' })).toBe('balanced');
    expect(readStaffingWeight({ staffingWeight: 'solo' })).toBe('solo');
    expect(readStaffingWeight({ staffingWeight: 'crna' })).toBe('crna');
  });
  it('clampConfig keeps a valid select option and falls back otherwise', () => {
    const schema = [staffingWeightField()];
    expect(clampConfig(schema, { staffingWeight: 'crna' }).staffingWeight).toBe('crna');
    expect(clampConfig(schema, { staffingWeight: 'bogus' }).staffingWeight).toBe('balanced');
    expect(clampConfig(schema, {}).staffingWeight).toBe('balanced');
  });
});

describe('resolveCrossCover', () => {
  it('absorbs demand fully when flex capacity is sufficient', () => {
    const r = resolveCrossCover(1, [{ label: 'Floats', capacity: 3 }]);
    expect(r.flexCapacity).toBe(3);
    expect(r.absorbed).toBe(1);
    expect(r.shortfall).toBe(0);
  });
  it('reports a shortfall when flex is insufficient', () => {
    const r = resolveCrossCover(3, [{ label: 'Floats', capacity: 1 }]);
    expect(r.absorbed).toBe(1);
    expect(r.shortfall).toBe(2);
  });
  it('treats zero demand as fully covered and ignores negative capacity', () => {
    expect(resolveCrossCover(0, [{ label: 'x', capacity: 5 }]).shortfall).toBe(0);
    expect(resolveCrossCover(2, [{ label: 'x', capacity: -3 }, { label: 'y', capacity: 2 }]).flexCapacity).toBe(2);
  });
});

describe('crossCoverNotes', () => {
  it('is empty when there is no demand', () => {
    expect(crossCoverNotes('TEEs', resolveCrossCover(0, []))).toEqual([]);
  });
  it('explains full absorption with no dedicated staff', () => {
    const notes = crossCoverNotes('DCCV/TEE', resolveCrossCover(1, [{ label: 'Floats', capacity: 2 }]));
    expect(notes.some((n) => n.toLowerCase().includes('absorbed'))).toBe(true);
    expect(notes.some((n) => n.toLowerCase().includes('no dedicated'))).toBe(true);
  });
  it('flags added dedicated staffing on a shortfall', () => {
    const notes = crossCoverNotes('TEEs', resolveCrossCover(2, [{ label: 'Floats', capacity: 0 }]));
    expect(notes.some((n) => n.toLowerCase().includes('dedicated'))).toBe(true);
  });
});

describe('feasibilityNotes', () => {
  it('warns when planned staff exceed available', () => {
    const notes = feasibilityNotes(10, 20, { mds: 8, crnas: 18 });
    expect(notes.some(n => n.includes('2') && n.toLowerCase().includes('md'))).toBe(true);
    expect(notes.some(n => n.includes('2') && n.toLowerCase().includes('crna'))).toBe(true);
  });
  it('is silent (empty) when the plan fits within available staff', () => {
    expect(feasibilityNotes(8, 16, { mds: 10, crnas: 18 })).toEqual([]);
  });
});
