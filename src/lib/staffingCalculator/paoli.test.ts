import { describe, it, expect } from 'vitest';
import { paoliCalculator } from './paoli';

const avail = { mds: 10, crnas: 14 };

function headline(cfg: Record<string, number | boolean>) {
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
    expect(headline({ mainORCount: 10, addOnRooms: 1, epLab: true, neuroLab: true, tees: true, soloPri: false })).toMatchInlineSnapshot(`
      {
        "assignmentCount": 20,
        "breakCapacity": 13,
        "breakDemand": 17,
        "breakPct": 76,
        "contingencyCount": 2,
        "severity": "tight",
        "totalCRNAs": 13,
        "totalMDs": 7,
        "totalStaff": 20,
      }
    `);
  });
  it('solo priority: 8 OR + EP + Neuro solo', () => {
    expect(headline({ mainORCount: 8, addOnRooms: 0, epLab: true, neuroLab: true, tees: false, soloPri: true })).toMatchInlineSnapshot(`
      {
        "assignmentCount": 17,
        "breakCapacity": 12,
        "breakDemand": 12,
        "breakPct": 100,
        "contingencyCount": 1,
        "severity": "ok",
        "totalCRNAs": 10,
        "totalMDs": 7,
        "totalStaff": 17,
      }
    `);
  });
});
