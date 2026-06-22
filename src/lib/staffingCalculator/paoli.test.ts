import { describe, it, expect } from 'vitest';
import { paoliCalculator } from './paoli';

const avail = { mds: 10, crnas: 14 };

function headline(cfg: Record<string, number | boolean | string>) {
  const out = paoliCalculator.calculate(cfg, avail);
  return {
    totalMDs: out.totalMDs, totalCRNAs: out.totalCRNAs, totalStaff: out.totalStaff,
    assignmentCount: out.assignments.length,
    breakDemand: out.breakAnalysis.demand, breakCapacity: out.breakAnalysis.capacity,
    breakPct: out.breakAnalysis.pct, severity: out.breakAnalysis.severity,
    contingencyCount: out.contingencies.length,
  };
}

describe('paoli characterization (locks current behavior)', () => {
  it('default config', () => {
    expect(headline(paoliCalculator.defaultConfig)).toMatchInlineSnapshot(`
      {
        "assignmentCount": 14,
        "breakCapacity": 11,
        "breakDemand": 9,
        "breakPct": 100,
        "contingencyCount": 2,
        "severity": "ok",
        "totalCRNAs": 9,
        "totalMDs": 5,
        "totalStaff": 14,
      }
    `);
  });
  it('big day: 10 OR + EP + Neuro + TEEs', () => {
    expect(headline({ mainORCount: 10, addOnRooms: 1, epLab: true, neuroLab: true, tees: true, staffingWeight: 'balanced' })).toMatchInlineSnapshot(`
      {
        "assignmentCount": 21,
        "breakCapacity": 15,
        "breakDemand": 16,
        "breakPct": 94,
        "contingencyCount": 1,
        "severity": "tight",
        "totalCRNAs": 14,
        "totalMDs": 7,
        "totalStaff": 21,
      }
    `);
  });
  it('solo priority: 8 OR + EP + Neuro solo', () => {
    expect(headline({ mainORCount: 8, addOnRooms: 0, epLab: true, neuroLab: true, tees: false, staffingWeight: 'solo' })).toMatchInlineSnapshot(`
      {
        "assignmentCount": 17,
        "breakCapacity": 12,
        "breakDemand": 12,
        "breakPct": 100,
        "contingencyCount": 1,
        "severity": "ok",
        "totalCRNAs": 9,
        "totalMDs": 8,
        "totalStaff": 17,
      }
    `);
  });
});

describe('paoli TEEs cross-cover', () => {
  const a = { mds: 10, crnas: 14 };
  const base = { mainORCount: 7, addOnRooms: 0, epLab: 0, neuroLab: 0, staffingWeight: 'balanced' };

  it('cross-cover OFF → a dedicated TEE CRNA in the TEEs site', () => {
    const out = paoliCalculator.calculate({ ...base, tees: 1, teesCross: false }, a);
    expect(out.assignments.some((x) => x.isTEE)).toBe(true);
    expect(out.assignments.some((x) => x.site === 'TEEs')).toBe(true);
  });

  it('cross-cover ON → absorbed by the float pool, no dedicated CRNA', () => {
    const out = paoliCalculator.calculate({ ...base, tees: 1, teesCross: true }, a);
    expect(out.assignments.some((x) => x.isTEE)).toBe(false);
    expect(out.assignments.some((x) => x.site === 'TEEs')).toBe(false);
    expect(out.notes.some((n) => n.includes('TEEs') && n.toLowerCase().includes('absorbed'))).toBe(true);
  });

  it('dedicated TEEs increase CRNA need vs cross-covered', () => {
    const dedicated = paoliCalculator.calculate({ ...base, tees: 1, teesCross: false }, a);
    const crossed = paoliCalculator.calculate({ ...base, tees: 1, teesCross: true }, a);
    expect(dedicated.totalCRNAs).toBe(crossed.totalCRNAs + 1);
  });
});

describe('paoli off-site room counts', () => {
  const a = { mds: 10, crnas: 14 };
  it('EP/Neuro as numeric counts place supervised CRNAs', () => {
    // 7 ORs → 2 OR Supv MDs with spare ratio capacity, so off-site rooms become
    // supervised CRNAs (not solo-MD fallbacks).
    const out = paoliCalculator.calculate({ mainORCount: 7, addOnRooms: 0, epLab: 2, neuroLab: 1, tees: 0, teesCross: false, staffingWeight: 'balanced' }, a);
    const ep = out.assignments.filter((x) => x.site === 'EP Lab');
    const neuro = out.assignments.filter((x) => x.site === 'Neuro Lab');
    expect(ep.length).toBe(2);
    expect(ep.every((x) => x.type === 'CRNA' && !!x.supervisedBy)).toBe(true);
    expect(neuro.length).toBe(1);
    expect(neuro.every((x) => x.type === 'CRNA' && !!x.supervisedBy)).toBe(true);
  });
  it('MD Solo Priority puts solo MDs in EP/Neuro instead of CRNAs', () => {
    const out = paoliCalculator.calculate({ mainORCount: 6, addOnRooms: 0, epLab: 1, neuroLab: 1, tees: 0, teesCross: false, staffingWeight: 'solo' }, a);
    const ep = out.assignments.find((x) => x.site === 'EP Lab');
    expect(ep?.type).toBe('MD');
    expect(ep?.isSolo).toBe(true);
  });
});

describe('paoli staffing strategy weight', () => {
  const a = { mds: 10, crnas: 14 };
  it('More Solo MD → EP/Neuro solo MDs; More CRNA → supervised CRNAs', () => {
    const base = { mainORCount: 7, addOnRooms: 0, epLab: 1, neuroLab: 1, tees: 0, teesCross: false };
    const solo = paoliCalculator.calculate({ ...base, staffingWeight: 'solo' }, a);
    const crna = paoliCalculator.calculate({ ...base, staffingWeight: 'crna' }, a);
    expect(solo.assignments.find((x) => x.site === 'EP Lab')?.type).toBe('MD');
    expect(crna.assignments.some((x) => x.site === 'EP Lab' && x.type === 'CRNA')).toBe(true);
  });
  it('More Solo MD yields more MDs / fewer CRNAs than More CRNA', () => {
    const base = { mainORCount: 7, addOnRooms: 0, epLab: 2, neuroLab: 1, tees: 0, teesCross: false };
    const solo = paoliCalculator.calculate({ ...base, staffingWeight: 'solo' }, a);
    const crna = paoliCalculator.calculate({ ...base, staffingWeight: 'crna' }, a);
    expect(solo.totalMDs).toBeGreaterThan(crna.totalMDs);
    expect(solo.totalCRNAs).toBeLessThan(crna.totalCRNAs);
  });
});
