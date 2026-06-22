import { describe, it, expect } from 'vitest';
import { lankenauCalculator } from './lankenau';

const avail = { mds: 12, crnas: 18 };

function headline(cfg: Record<string, number | boolean | string>) {
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

describe('lankenau staffing strategy weight (APC)', () => {
  // 4 OR + APC 4, plenty of staff so each mode can express itself.
  const cfg = { mainOR: 4, addOnRooms: 0, apc: 4, cardiac: 0, endo: 0, ep: 0, epTEE: 0, csections: 0, ir: 0 };
  const avail2 = { mds: 14, crnas: 18 };
  const run = (w: string) => lankenauCalculator.calculate({ ...cfg, staffingWeight: w }, avail2);
  const apc = (o: ReturnType<typeof run>, t: 'MD' | 'CRNA') => o.assignments.filter((a) => a.site === 'APC' && a.type === t).length;

  it('More Solo MD → APC runs on solo MDs (no APC CRNAs)', () => {
    const o = run('solo');
    expect(apc(o, 'MD')).toBe(4);
    expect(apc(o, 'CRNA')).toBe(0);
  });
  it('More CRNA → APC runs 1 MD supervising CRNAs', () => {
    const o = run('crna');
    expect(apc(o, 'MD')).toBe(1);
    expect(apc(o, 'CRNA')).toBe(4);
  });
  it('Balanced reproduces the original optimal split (supv + solo MD)', () => {
    const o = run('balanced');
    expect(apc(o, 'MD')).toBe(2);
    expect(apc(o, 'CRNA')).toBe(3);
  });
});

describe('lankenau DCCV/TEE cross-cover', () => {
  // 4 OR + 2 EP rooms; plenty of staff so floats exist for absorption.
  const base = { mainOR: 4, addOnRooms: 0, apc: 0, cardiac: 0, endo: 0, ep: 2, csections: 0, ir: 0 };

  it('cross-cover OFF → a dedicated DCCV/TEE CRNA is added', () => {
    const out = lankenauCalculator.calculate({ ...base, epTEE: 1, epTEECross: false }, { mds: 12, crnas: 18 });
    expect(out.assignments.some((a) => a.isTEE)).toBe(true);
    expect(out.assignments.filter((a) => a.site === 'EP Lab' && a.type === 'CRNA').length).toBe(2); // 1 proc + 1 TEE
  });

  it('cross-cover ON with float capacity → absorbed, no dedicated CRNA', () => {
    const out = lankenauCalculator.calculate({ ...base, epTEE: 1, epTEECross: true }, { mds: 12, crnas: 18 });
    expect(out.assignments.some((a) => a.isTEE)).toBe(false);
    expect(out.notes.some((n) => n.includes('DCCV/TEE') && n.toLowerCase().includes('absorbed'))).toBe(true);
  });

  it('cross-cover ON but flex insufficient → falls back to dedicated + warns', () => {
    // 2 DCCV/TEE rooms, tight staffing → 0 floats, 8101 carrying rooms → only OB
    // flex (1) for a demand of 2 → 1 absorbed, 1 dedicated.
    const out = lankenauCalculator.calculate({ ...base, ep: 2, epTEE: 2, epTEECross: true }, { mds: 3, crnas: 4 });
    expect(out.assignments.some((a) => a.isTEE)).toBe(true);
    expect(out.notes.some((n) => n.toLowerCase().includes('insufficient'))).toBe(true);
  });

  it('a dedicated DCCV/TEE CRNA is never left unsupervised (all EP rooms are TEE)', () => {
    // ep === epTEE with cross-cover ON and flex short → the fallback body must
    // still get a supervising MD (regression guard for the supervisedBy=null bug).
    const out = lankenauCalculator.calculate({ ...base, ep: 2, epTEE: 2, epTEECross: true }, { mds: 3, crnas: 4 });
    const tees = out.assignments.filter((a) => a.isTEE);
    expect(tees.length).toBeGreaterThan(0);
    expect(tees.every((a) => !!a.supervisedBy)).toBe(true);
  });
});

describe('lankenau IR cross-cover', () => {
  const base = { mainOR: 6, addOnRooms: 0, apc: 0, cardiac: 0, endo: 0, ep: 0, epTEE: 0, csections: 0 };

  it('cross-cover OFF → IR is staffed (dedicated provider in the IR site)', () => {
    const out = lankenauCalculator.calculate({ ...base, ir: 1, irCross: false }, { mds: 12, crnas: 18 });
    expect(out.assignments.some((a) => a.site === 'IR')).toBe(true);
  });

  it('cross-cover ON with spare capacity → absorbed, no dedicated IR body', () => {
    const out = lankenauCalculator.calculate({ ...base, ir: 1, irCross: true }, { mds: 12, crnas: 18 });
    expect(out.assignments.some((a) => a.site === 'IR')).toBe(false);
    expect(out.notes.some((n) => n.includes('IR') && n.toLowerCase().includes('absorbed'))).toBe(true);
  });

  it('cross-cover ON but flex insufficient → adds a dedicated IR body + warns', () => {
    // No ORs (no spare supervision), no CRNAs (no floats), 8101 idle (1 unit) vs
    // 2 IR cases → 1 absorbed, 1 dedicated.
    const out = lankenauCalculator.calculate(
      { mainOR: 0, addOnRooms: 0, apc: 0, cardiac: 0, endo: 0, ep: 0, epTEE: 0, csections: 0, ir: 2, irCross: true },
      { mds: 2, crnas: 0 },
    );
    expect(out.assignments.some((a) => a.site === 'IR')).toBe(true);
    expect(out.notes.some((n) => n.includes('IR') && n.toLowerCase().includes('insufficient'))).toBe(true);
  });
});

describe('lankenau cross-cover shared flex budget (no double-counting)', () => {
  // With DCCV/TEE and IR both cross-covered, a float consumed by TEE must not be
  // re-credited to IR. Regression guard for the shared-budget fix: the float
  // capacity reported for IR must be strictly less than for TEE once TEE draws one.
  it('a float absorbed by TEE is not also credited to IR', () => {
    const out = lankenauCalculator.calculate(
      { mainOR: 7, addOnRooms: 0, apc: 0, cardiac: 0, endo: 0, ep: 2, epTEE: 2, epTEECross: true, csections: 0, ir: 1, irCross: true },
      { mds: 5, crnas: 8 },
    );
    const floatsIn = (pred: (n: string) => boolean) => {
      const note = out.notes.find((n) => pred(n) && n.includes('Floats ×'));
      const m = note?.match(/Floats ×(\d+)/);
      return m ? Number(m[1]) : 0;
    };
    const teeFloats = floatsIn((n) => n.includes('DCCV/TEE') && n.toLowerCase().includes('absorbed'));
    const irFloats = floatsIn((n) => n.includes('IR') && n.toLowerCase().includes('absorbed'));
    expect(teeFloats).toBeGreaterThan(0);
    expect(irFloats).toBeLessThan(teeFloats);
  });
});
