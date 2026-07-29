// Coverage forecast — Gabriel 2026-07-29: "I want a count of the expected
// total number of each call I will need to find coverage for based on the
// length of the block and the pool of providers."
//
// The fixture is his LIVE block, so the numbers here are checkable against the
// board: Paoli Aug–Oct 2026, 11 weeks, par 11, ten call takers summing 8.70
// FTE, standing 176 weighted call slots (44 M–Th C1 + 44 M–Th C2 + 11 each of
// Fri/Sat/Sun C1, Fri/Sat/Sun C2, Sat/Sun C3).
import { describe, it, expect } from 'vitest';
import { computeCoverageForecast, formatCalls } from './coverageForecast';
import {
  computeCallObligationCensus, roundedObligation,
  type CensusProfile, type CensusSlot,
} from './fteTarget';

const PAOLI_FTE: Array<[string, number]> = [
  ['amusa', 1.0], ['farkas', 1.0], ['jones', 1.0], ['kalawadia', 1.0],
  ['lin', 1.0], ['mojica', 1.0],
  ['havildar', 0.75], ['simon', 0.75], ['hussain', 0.70], ['horan', 0.50],
];
const POOL_FTE = 8.7;

const profile = (pid: string, fte: number): CensusProfile => ({
  provider_id: pid, home_site_id: 'paoli',
  call_taker: true, partial_call_taker: false, fte_value: fte,
});

const callSlot = (date: string, dayType: string, code: string): CensusSlot => ({
  slot_date: date, derived_day_type: dayType,
  shift_types: { category: 'call', code },
  assignments: [],
});

// 11 weeks starting Mon 2026-08-10. Mon–Thu carry C1+C2; Fri C1+C2;
// Sat/Sun C1+C2+C3.
function paoliSlots(): CensusSlot[] {
  const out: CensusSlot[] = [];
  const start = Date.UTC(2026, 7, 10);
  for (let w = 0; w < 11; w++) {
    for (let d = 0; d < 7; d++) {
      const t = new Date(start + (w * 7 + d) * 86400000);
      const iso = t.toISOString().slice(0, 10);
      const dow = t.getUTCDay();
      if (dow >= 1 && dow <= 4) {
        out.push(callSlot(iso, 'weekday', 'C1'), callSlot(iso, 'weekday', 'C2'));
      } else if (dow === 5) {
        out.push(callSlot(iso, 'friday', 'C1'), callSlot(iso, 'friday', 'C2'));
      } else {
        const dt = dow === 6 ? 'saturday' : 'sunday';
        out.push(callSlot(iso, dt, 'C1'), callSlot(iso, dt, 'C2'), callSlot(iso, dt, 'C3'));
      }
    }
  }
  return out;
}

const paoliCensus = () => computeCallObligationCensus({
  storedParLevel: 11, siteId: 'paoli',
  profiles: PAOLI_FTE.map(([pid, fte]) => profile(pid, fte)),
  slots: paoliSlots(),
});

const pids = PAOLI_FTE.map(([pid]) => pid);

describe('coverage forecast — Paoli Aug–Oct 2026', () => {
  it('the fixture really is his block: 176 weighted call slots, 8.70 pool FTE, par 11', () => {
    const c = paoliCensus();
    expect(c.totalCallSlots).toBe(176);
    expect(c.poolFte).toBeCloseTo(POOL_FTE, 10);
    expect(c.effectivePar).toBe(11);
  });

  it('reports what nobody owes, per call type', () => {
    const f = computeCoverageForecast(paoliCensus(), pids);
    // 8.70 / 11 = 79.09% owed, so every bucket is 20.91% uncovered.
    expect(f.uncoveredShare).toBeCloseTo(1 - 8.7 / 11, 10);

    const row = (bucket: string, code: string) =>
      f.rows.find(r => r.bucket === bucket && r.code === code)!;

    expect(row('weekday', 'C1').slots).toBe(44);
    expect(row('weekday', 'C1').covered).toBeCloseTo(44 * 8.7 / 11, 10);   // 34.8
    expect(row('weekday', 'C1').needCoverage).toBeCloseTo(9.2, 10);

    expect(row('saturday', 'C3').slots).toBe(11);
    expect(row('saturday', 'C3').needCoverage).toBeCloseTo(11 * (1 - 8.7 / 11), 10);  // 2.3

    // Every call type in the block is present exactly once.
    expect(f.rows).toHaveLength(10);
    expect(f.bucketed).toBe(true);
  });

  it('rows are ordered M–Th, Fri, Sat, Sun then by code — the Call Counts order', () => {
    const f = computeCoverageForecast(paoliCensus(), pids);
    expect(f.rows.map(r => `${r.bucket}|${r.code}`)).toEqual([
      'weekday|C1', 'weekday|C2',
      'friday|C1', 'friday|C2',
      'saturday|C1', 'saturday|C2', 'saturday|C3',
      'sunday|C1', 'sunday|C2', 'sunday|C3',
    ]);
  });

  it('the rows account for the whole block — no call type is silently dropped', () => {
    const f = computeCoverageForecast(paoliCensus(), pids);
    const summed = f.rows.reduce((s, r) => s + r.slots, 0);
    expect(summed).toBe(f.totals.slots);
    expect(f.rows.reduce((s, r) => s + r.needCoverage, 0))
      .toBeCloseTo(f.totals.needCoverage, 10);
  });

  it('obligationGap is the whole-call number obligatory generation leaves open', () => {
    const c = paoliCensus();
    const f = computeCoverageForecast(c, pids);
    // Σ rounded obligations: 6×16 + 2×12 + 11 + 8 = 139.
    const owed = pids.reduce((s, p) => s + roundedObligation(c.totalExpectedFor(p)), 0);
    expect(owed).toBe(139);
    expect(f.obligationGap).toBe(176 - 139);   // 37
    // …and it sits within rounding distance of the fractional total (36.8).
    expect(Math.abs(f.obligationGap - f.totals.needCoverage)).toBeLessThan(1);
  });

  it('a duplicated provider id cannot owe twice', () => {
    const c = paoliCensus();
    const once = computeCoverageForecast(c, pids);
    const twice = computeCoverageForecast(c, [...pids, ...pids]);
    expect(twice.obligationGap).toBe(once.obligationGap);
  });

  it('providers outside the call pool add no coverage', () => {
    // A day doc owes zero calls (poolFteFor is 0 for them), so naming them
    // must not shrink the gap — the 53.3-expected class of bug.
    const c = computeCallObligationCensus({
      storedParLevel: 11, siteId: 'paoli',
      profiles: [
        ...PAOLI_FTE.map(([pid, fte]) => profile(pid, fte)),
        { provider_id: 'chamchad', home_site_id: 'paoli', call_taker: false,
          partial_call_taker: false, fte_value: 0.75 },
      ],
      slots: paoliSlots(),
    });
    const f = computeCoverageForecast(c, [...pids, 'chamchad']);
    expect(f.poolFte).toBeCloseTo(POOL_FTE, 10);
    expect(f.obligationGap).toBe(37);
  });
});

describe('coverage forecast — edges', () => {
  const oneSlot = (dayType = 'weekday'): CensusSlot[] =>
    [callSlot('2026-08-10', dayType, 'C1')];

  it('a pool at or above par needs no pickups — never a negative gap', () => {
    const c = computeCallObligationCensus({
      storedParLevel: 2, siteId: 'paoli',
      profiles: [profile('a', 1), profile('b', 1), profile('c', 1)],  // ΣFTE 3 > par 2
      slots: oneSlot(),
    });
    const f = computeCoverageForecast(c, ['a', 'b', 'c']);
    expect(f.uncoveredShare).toBe(0);
    expect(f.totals.needCoverage).toBe(0);
    expect(f.rows[0].needCoverage).toBe(0);
    expect(f.obligationGap).toBe(0);
  });

  it('an unbucketable call slot empties the rows but keeps the totals exact', () => {
    // Same all-or-nothing rule as bucketTargetFor: a partial bucket map would
    // understate a bucket's slate and therefore its gap.
    const c = computeCallObligationCensus({
      storedParLevel: 11, siteId: 'paoli', profiles: [profile('a', 1)],
      slots: [
        callSlot('2026-08-10', 'weekday', 'C1'),
        { slot_date: '2026-08-11', shift_types: { category: 'call', code: 'C1' }, assignments: [] },
      ],
    });
    const f = computeCoverageForecast(c, ['a']);
    expect(f.bucketed).toBe(false);
    expect(f.rows).toEqual([]);
    expect(f.totals.slots).toBe(2);
    expect(f.totals.needCoverage).toBeCloseTo(2 * (1 - 1 / 11), 10);
  });

  it('split calls count once under their parent code', () => {
    // A Saturday C1 served as C1D12 + C1N12 is ONE call to cover, not two.
    const c = computeCallObligationCensus({
      storedParLevel: 4, siteId: 'paoli', profiles: [profile('a', 1)],
      slots: [
        { slot_date: '2026-08-15', derived_day_type: 'saturday', assignments: [],
          shift_types: { category: 'call', code: 'C1D12', call_burden_weight: 0.5, parent_call_code: 'C1' } },
        { slot_date: '2026-08-15', derived_day_type: 'saturday', assignments: [],
          shift_types: { category: 'call', code: 'C1N12', call_burden_weight: 0.5, parent_call_code: 'C1' } },
      ],
    });
    const f = computeCoverageForecast(c, ['a']);
    expect(f.rows).toHaveLength(1);
    expect(f.rows[0]).toMatchObject({ bucket: 'saturday', code: 'C1', slots: 1 });
  });

  it('a holiday is charged to the weekday it falls on, not a holiday bucket', () => {
    // Labor Day 2026-09-07 is a Monday (Gabriel 2026-07-27).
    const c = computeCallObligationCensus({
      storedParLevel: 11, siteId: 'paoli', profiles: [profile('a', 1)],
      slots: [callSlot('2026-09-07', 'major_holiday', 'C1')],
    });
    const f = computeCoverageForecast(c, ['a']);
    expect(f.rows.map(r => r.bucket)).toEqual(['weekday']);
  });

  it('par of 0 means nothing is owed rather than dividing by zero', () => {
    const c = computeCallObligationCensus({
      storedParLevel: 0, siteId: 'paoli', profiles: [profile('a', 1)], slots: oneSlot(),
    });
    const f = computeCoverageForecast(c, ['a']);
    expect(f.uncoveredShare).toBe(1);
    expect(f.totals.needCoverage).toBe(1);
    expect(f.obligationGap).toBe(1);
  });
});

describe('formatCalls', () => {
  it('shows whole calls whole and fractions to one decimal', () => {
    expect(formatCalls(11)).toBe('11');
    expect(formatCalls(34.800000000000004)).toBe('34.8');
    expect(formatCalls(9.2)).toBe('9.2');
    expect(formatCalls(0)).toBe('0');
  });
});
