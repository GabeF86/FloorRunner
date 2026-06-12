import { describe, it, expect } from 'vitest';
import { lankenauCalculator } from './lankenau';

const avail = { mds: 12, crnas: 18 };

function headline(cfg: Record<string, number | boolean>) {
  const out = lankenauCalculator.calculate(cfg, avail);
  return {
    totalMDs: out.totalMDs, totalCRNAs: out.totalCRNAs, totalStaff: out.totalStaff,
    assignmentCount: out.assignments.length,
    breakDemand: out.breakAnalysis.demand, breakCapacity: out.breakAnalysis.capacity,
    breakPct: out.breakAnalysis.pct, severity: out.breakAnalysis.severity,
    contingencyCount: out.contingencies.length,
  };
}

describe('lankenau characterization (locks current behavior)', () => {
  it('default config', () => {
    expect(headline(lankenauCalculator.defaultConfig)).toMatchInlineSnapshot(`
      {
        "assignmentCount": 30,
        "breakCapacity": 98,
        "breakDemand": 8,
        "breakPct": 100,
        "contingencyCount": 2,
        "severity": "ok",
        "totalCRNAs": 18,
        "totalMDs": 12,
        "totalStaff": 30,
      }
    `);
  });
  it('full house: 7 OR + APC 4 + cardiac 2 + endo 2 + EP 2 (TEE) + 2 C-sections', () => {
    expect(headline({
      mainOR: 7, addOnRooms: 0, apc: 4, cardiac: 2, endo: 2, ep: 2, epTEE: true, csections: 2, ir: true,
    })).toMatchInlineSnapshot(`
      {
        "assignmentCount": 30,
        "breakCapacity": 32,
        "breakDemand": 17,
        "breakPct": 100,
        "contingencyCount": 4,
        "severity": "ok",
        "totalCRNAs": 18,
        "totalMDs": 12,
        "totalStaff": 30,
      }
    `);
  });
  it('minimal: 2 OR only', () => {
    expect(headline({ mainOR: 2, addOnRooms: 0, apc: 0, cardiac: 0, endo: 0, ep: 0, epTEE: false, csections: 0, ir: false })).toMatchInlineSnapshot(`
      {
        "assignmentCount": 30,
        "breakCapacity": 127,
        "breakDemand": 3,
        "breakPct": 100,
        "contingencyCount": 2,
        "severity": "ok",
        "totalCRNAs": 18,
        "totalMDs": 12,
        "totalStaff": 30,
      }
    `);
  });
});
