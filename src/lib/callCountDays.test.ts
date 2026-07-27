// Call Counts modal day-math (2026-07-22): bucket day counts, Days Off,
// Working Days credit. The helpers ASSEMBLE the single-homed contracts
// (rulesEngine/workDays.ts arithmetic, plannerMath's computeScheduleActuals /
// rangeComposition) — these tests pin both the worked numbers AND the
// agreement with those contracts on identical inputs.
import { describe, it, expect } from 'vitest';
import { requiredWorkDays } from './rulesEngine/workDays';
import { addDays } from './rulesEngine/shared';
import { ICU_WEEK_REASON } from './icuRotation';
import { rangeComposition, type PlannerSlotRow } from './plannerMath';
import {
  bucketDayCounts, daysOffFor, creditedWorkingDayTotals,
  weekendObligationUnits, weekendDutiesByProvider, requiredWeekendsFor,
} from './callCountDays';

// 2026-03-02 = Monday … 2026-03-08 = Sunday (a clean holiday-free week).
const WEEK = rangeComposition('2026-03-02', '2026-03-08', []);

const slot = (slot_date: string, derived_day_type: string): { slot_date: string; derived_day_type: string } =>
  ({ slot_date, derived_day_type });

const assigned = (provider_id: string, assignment_status = 'assigned') => ({ provider_id, assignment_status });

const callSlot = (slot_date: string, derived_day_type: string, pid: string): PlannerSlotRow => ({
  slot_date,
  derived_day_type,
  shift_types: { code: 'C2', category: 'call', requires_post_call_rule: true },
  assignments: [assigned(pid)],
});

const daySlot = (slot_date: string, derived_day_type: string, pid: string): PlannerSlotRow => ({
  slot_date,
  derived_day_type,
  shift_types: { code: '7-3', category: 'day', requires_post_call_rule: false },
  assignments: [assigned(pid)],
});

/* ── bucketDayCounts ─────────────────────────────────────────────────────── */

describe('bucketDayCounts', () => {
  it('counts DISTINCT slot dates per stored day type — multiple slots on one date count once', () => {
    expect(bucketDayCounts([
      slot('2026-03-02', 'weekday'),
      slot('2026-03-02', 'weekday'), // second slot, same date
      slot('2026-03-03', 'weekday'),
      slot('2026-03-06', 'friday'),
      slot('2026-03-07', 'saturday'),
      slot('2026-03-08', 'sunday'),
    ])).toEqual({ weekday: 2, friday: 1, saturday: 1, sunday: 1 });
  });

  it('a Monday major holiday is NOT a weekday — holiday day types get no bucket count (mirrors the modal columns)', () => {
    // 2026-05-25 = Memorial Day, a Monday: stored derived_day_type is
    // 'major_holiday', so it must not inflate M–Th. Non-major federal
    // holidays ('federal_holiday') carry no bucket column either.
    expect(bucketDayCounts([
      slot('2026-05-25', 'major_holiday'),
      slot('2026-06-19', 'federal_holiday'),
      slot('2026-03-02', 'weekday'),
    ])).toEqual({ weekday: 1, friday: 0, saturday: 0, sunday: 0 });
  });

  it('empty slot list → all-zero counts', () => {
    expect(bucketDayCounts([])).toEqual({ weekday: 0, friday: 0, saturday: 0, sunday: 0 });
  });
});

/* ── daysOffFor ──────────────────────────────────────────────────────────── */

describe('daysOffFor', () => {
  it('worked example: 54 WD, 18 PTO weekdays, 0.5 FTE → required 9, days off 27', () => {
    // Pin the single-homed contract input first, then the derived column.
    expect(requiredWorkDays(0.5, 54, 18)).toBe(9); // round(0.5×54) − 18
    expect(daysOffFor(0.5, 54, 18)).toBe(27);      // 54 − 18 − 9
  });

  it('agrees with the workDays contract (WD − pto − requiredWorkDays) on a spread of inputs', () => {
    const cases: Array<[number, number, number]> = [
      [1, 54, 0], [0.8, 43, 5], [0.6, 54, 2], [0.5, 20, 0], [0.9, 61, 10], [0.75, 54, 18],
    ];
    for (const [fte, wd, pto] of cases) {
      expect(daysOffFor(fte, wd, pto)).toBe(Math.max(0, wd - pto - requiredWorkDays(fte, wd, pto)));
    }
  });

  it('full-FTE providers compute to 0, with and without PTO (modal renders —)', () => {
    expect(daysOffFor(1, 54, 0)).toBe(0);
    expect(daysOffFor(1, 54, 5)).toBe(0);
  });

  it('PTO beyond the FTE requirement: required floors at 0, days off never negative', () => {
    // 0.2 × 20 WD → required 4; 6 PTO weekdays floors required to 0.
    expect(daysOffFor(0.2, 20, 6)).toBe(14); // 20 − 6 − 0
    // Pathological: PTO exceeding the block itself still never goes negative.
    expect(daysOffFor(0.2, 5, 6)).toBe(0);
  });
});

/* ── creditedWorkingDayTotals ────────────────────────────────────────────── */

describe('creditedWorkingDayTotals', () => {
  it('credits the assignment weekday AND the post-call rest day (invariant-1 rest credits as worked)', () => {
    const totals = creditedWorkingDayTotals(
      [callSlot('2026-03-03', 'weekday', 'p1')], // Tue C2
      [], WEEK.workingDaySet, []);
    expect(totals.p1).toBe(2); // Tue worked + Wed rest credited
  });

  it('a rest day that is itself assigned counts once (disjoint credit sets)', () => {
    const totals = creditedWorkingDayTotals([
      callSlot('2026-03-03', 'weekday', 'p1'),   // Tue C2 → Wed rest
      daySlot('2026-03-04', 'weekday', 'p1'),    // Wed also assigned
    ], [], WEEK.workingDaySet, []);
    expect(totals.p1).toBe(2); // Tue + Wed, never double-counted
  });

  it('weekend calls credit nothing — Saturday call, Sunday rest are both outside the working-day set', () => {
    const totals = creditedWorkingDayTotals(
      [callSlot('2026-03-07', 'saturday', 'p1')],
      [], WEEK.workingDaySet, []);
    expect(totals.p1 ?? 0).toBe(0);
  });

  it('ICU week weekdays credit as worked', () => {
    const totals = creditedWorkingDayTotals([], [{
      provider_id: 'p2', availability_type: 'blocked', reason_code: ICU_WEEK_REASON,
      start_date: '2026-03-02', end_date: '2026-03-08', approval_status: 'approved',
    }], WEEK.workingDaySet, []);
    expect(totals.p2).toBe(5); // Mon–Fri; Sat/Sun of the ICU week are not working days
  });

  it('a major-holiday Monday assignment consumes no credit (not a working day)', () => {
    const holidays = [{ holiday_date: '2026-05-25', is_major_holiday: true }];
    const comp = rangeComposition('2026-05-25', '2026-05-29', holidays);
    const totals = creditedWorkingDayTotals(
      [daySlot('2026-05-25', 'major_holiday', 'p1')],
      [], comp.workingDaySet, holidays);
    expect(totals.p1 ?? 0).toBe(0);
  });

  it('canceled assignments credit nothing (assignmentFills predicate)', () => {
    const totals = creditedWorkingDayTotals([{
      ...daySlot('2026-03-03', 'weekday', 'p1'),
      assignments: [assigned('p1', 'canceled')],
    }], [], WEEK.workingDaySet, []);
    expect(totals.p1 ?? 0).toBe(0);
  });
});

/* ── Obligatory weekends ─────────────────────────────────────────────────── */

// ⚠ SUPERSEDED NUMBERS, 2026-07-27 (later the same day as the numbers they
// replace). The first cut of this column measured a weekend's obligation as
// its WIDEST single day's call tiers (3 at Paoli → 33 per block) and credited
// a provider by their weekend call BURDEN WEIGHT capped at one per weekend.
// That was internally inconsistent — measured on live data the denominator
// counted 3 tiers per weekend while the numerator credited ~3.3 distinct docs
// per weekend, so EVERY provider rendered red — and it did not match what
// Gabriel actually owes people. His model, restated and confirmed:
//
//   • PRIMARY-CALL duty is counted PER WEEKEND DAY. "1 Friday C1, Saturday C1
//     and Sunday C1. So 3 weekend obligations" — 33 such slots in an 11-week
//     block, 3 per 1.0 FTE at par 11. Weekend C2s/C3s are not separately owed;
//     they ride along on the block chain.
//   • NEURO duty is counted PER WEEKEND PAIR. "Every call taker should be
//     given a neuro weekend call, except for horan it should only be one
//     weekend day" — 11 pairs in the block, 1 per 1.0 FTE at par 11, a lone
//     day worth 0.5.
//
// So (33 + 11) ÷ 11 = 4 per 1.0 FTE, and the requirement rounds DOWN to the
// nearest half — which ALSO supersedes the earlier nearest-half-ties-up rule,
// because his per-doc preview requires it (0.75 × 3 = 2.25 must land on 2,
// not 2.5). His preview, which these tests now reproduce:
//
//     Doc        Weekends        was (superseded)
//     Ganiyu  1.0   4 / 4        3 / 3
//     Havildar 0.75 3 / 3        2.5 / …
//     Horan   0.5   2 / 2        1.5 / …   ← and her actual read 2.5, red
//
// Every superseded expectation below is called out inline at its replacement.

// 2026-08-14/15/16 = Fri/Sat/Sun; 2026-08-21/22/23 = the next weekend.
type WkSlot = {
  slot_date: string;
  shift_types: {
    category: string; code: string;
    call_rank?: number | null;
    call_burden_weight?: number | null;
    parent_call_code?: string | null;
  } | null;
  assignments?: Array<{ provider_id?: string | null }>;
};

// Live Paoli ranks (patch18): C1 = 0 (primary/first call), C2 = 1, C3 = 2.
// C3 is ALSO the site's neuro code (patch38 neuroWeekend.code) — which is
// exactly why the two terms must be disjoint rather than additive per slot.
const RANK: Record<string, number> = { C1: 0, C2: 1, C3: 2 };
const NEURO = 'C3';

const wk = (
  slot_date: string, code: string,
  opts: { pid?: string; weight?: number; parent?: string; rank?: number | null } = {},
): WkSlot => ({
  slot_date,
  shift_types: {
    category: 'call', code,
    call_rank: opts.rank !== undefined ? opts.rank : RANK[opts.parent ?? code] ?? null,
    call_burden_weight: opts.weight ?? null,
    parent_call_code: opts.parent ?? null,
  },
  assignments: opts.pid ? [{ provider_id: opts.pid }] : [],
});

// The LIVE Paoli weekend (2026-07-27): Friday stands C1 + C2 only (Friday
// neuro lost its slot and the Friday C2 doc cross-covers it); Saturday and
// Sunday stand C1 + C2 + C3. Kept faithful to production deliberately — the
// asymmetric Friday is what proves the primary term counts DAYS with a rank-0
// slot, not tiers.
const paoliWeekend = (friday: string): WkSlot[] => {
  const sat = addDays(friday, 1), sun = addDays(friday, 2);
  return [
    wk(friday, 'C1'), wk(friday, 'C2'),
    wk(sat, 'C1'), wk(sat, 'C2'), wk(sat, 'C3'),
    wk(sun, 'C1'), wk(sun, 'C2'), wk(sun, 'C3'),
  ];
};
// The 11 Fridays of the 8/10–10/25 block.
const FRIDAYS = [
  '2026-08-14', '2026-08-21', '2026-08-28', '2026-09-04', '2026-09-11', '2026-09-18',
  '2026-09-25', '2026-10-02', '2026-10-09', '2026-10-16', '2026-10-23',
];
const PAOLI_BLOCK = FRIDAYS.flatMap(paoliWeekend);

describe('weekendObligationUnits', () => {
  // SUPERSEDES: 'one live Paoli weekend … = 3 units — its WIDEST day'.
  it('one live Paoli weekend = 4 units — 3 primary-call days (Fri/Sat/Sun C1) + 1 neuro pair', () => {
    expect(weekendObligationUnits(paoliWeekend('2026-08-14'), NEURO)).toBe(4);
  });

  // SUPERSEDES: '11 weekends × 3 tiers = 33'.
  it("Gabriel's 11-week block = 44 units (33 primary days + 11 neuro pairs)", () => {
    expect(weekendObligationUnits(PAOLI_BLOCK, NEURO)).toBe(44);
  });

  it('the primary term alone is 33 — the neuro term is exactly the 11 pairs', () => {
    // No neuro code stated → no neuro term, the documented other-site fallback.
    expect(weekendObligationUnits(PAOLI_BLOCK)).toBe(33);
  });

  it('a site that states no neuroWeekend keeps working — primary-call days only', () => {
    expect(weekendObligationUnits(paoliWeekend('2026-08-14'))).toBe(3);
  });

  it('C2 and C3 are NOT separately owed — they ride along on the block chain', () => {
    // A weekend of nothing but second/third call owes nothing at all.
    expect(weekendObligationUnits([
      wk('2026-08-14', 'C2'), wk('2026-08-15', 'C2'), wk('2026-08-16', 'C2'),
    ], NEURO)).toBe(0);
  });

  it('a split Sunday C1 (C1D12 + C1N12, 0.5 each) is ONE primary day, not two', () => {
    expect(weekendObligationUnits([
      wk('2026-08-16', 'C1D12', { weight: 0.5, parent: 'C1' }),
      wk('2026-08-16', 'C1N12', { weight: 0.5, parent: 'C1' }),
    ])).toBe(1);
  });

  it("a segment whose own call_rank is null resolves through its parent's rank", () => {
    // patch35 copies call_rank onto segments; this is the belt-and-braces path.
    expect(weekendObligationUnits([
      wk('2026-08-15', 'C1', { rank: 0 }),                                    // seeds the code→rank map
      wk('2026-08-16', 'C1N12', { weight: 0.5, parent: 'C1', rank: null }),
    ])).toBe(1.5);
  });

  it('a neuro pair is ONE unit; a lone neuro weekend day is half', () => {
    expect(weekendObligationUnits([wk('2026-08-15', 'C3'), wk('2026-08-16', 'C3')], NEURO)).toBe(1);
    expect(weekendObligationUnits([wk('2026-08-15', 'C3')], NEURO)).toBe(0.5);
  });

  it('a neuro-code slot is never ALSO counted as primary (terms stay disjoint)', () => {
    // Pathological site: its neuro code IS its first-call code. One Sat+Sun
    // pair must be 1 neuro unit, not 1 neuro + 2 primary days.
    expect(weekendObligationUnits(
      [wk('2026-08-15', 'C1'), wk('2026-08-16', 'C1')], 'C1',
    )).toBe(1);
  });

  it('Mon–Thu call slots and weekend NON-call slots contribute nothing', () => {
    expect(weekendObligationUnits([
      wk('2026-08-12', 'C1'), // Wednesday first call — a weekday duty, not a weekend one
      { slot_date: '2026-08-15', shift_types: { category: 'day', code: '7-3', call_rank: null } },
    ], NEURO)).toBe(0);
  });
});

describe('weekendDutiesByProvider', () => {
  // The live Paoli block chain spreads ONE weekend across three call takers
  // plus a neuro doc — and the new model gives each of the four exactly 1.0,
  // which is what makes a 4-unit weekend and a 4-doc weekend reconcile.
  it('one live weekend gives each of its four docs exactly 1.0', () => {
    const totals = weekendDutiesByProvider([
      wk('2026-08-14', 'C1', { pid: 'friC1' }),  // Fri anchor: Fri C1 …
      wk('2026-08-16', 'C2', { pid: 'friC1' }),  //            … + Sun C2 (rides along)
      wk('2026-08-15', 'C1', { pid: 'satC1' }),  // Sat C1
      wk('2026-08-14', 'C2', { pid: 'satC2' }),  // Sat-C2 chain: Fri C2 …
      wk('2026-08-15', 'C2', { pid: 'satC2' }),  //               … Sat C2 …
      wk('2026-08-16', 'C1', { pid: 'satC2' }),  //               … + Sun C1 ← their duty
      wk('2026-08-15', 'C3', { pid: 'neuro' }),  // neuro pair
      wk('2026-08-16', 'C3', { pid: 'neuro' }),
    ], NEURO);
    expect(totals).toEqual({ friC1: 1, satC1: 1, satC2: 1, neuro: 1 });
  });

  // THE case (Gabriel 2026-07-27): Horan is the 0.5 FTE doc, owed 2. Her
  // stated block is one Saturday C1, one 12h Sunday C1 and ONE neuro weekend
  // day — 1 + 0.5 + 0.5 — so she must land exactly on 2/2, not look short and
  // not look over. SUPERSEDES the old reading, which credited the same three
  // as three whole weekends capped at one apiece = 2.5 against a required 1.5,
  // painting her red.
  it("Horan's stated block (Sat C1 + 12h Sun C1 + one neuro day) is exactly 2.0", () => {
    const totals = weekendDutiesByProvider([
      wk('2026-08-15', 'C1', { pid: 'horan' }),                                   // 1.0
      wk('2026-09-06', 'C1N12', { pid: 'horan', weight: 0.5, parent: 'C1' }),     // 0.5
      wk('2026-10-17', 'C3', { pid: 'horan' }),                                   // 0.5 (single neuro day)
    ], NEURO);
    expect(totals.horan).toBe(2);
  });

  // SUPERSEDES: 'a Fri + Sat + Sun chain is ONE weekend, not three'. Primary
  // call is now counted PER DAY, so a doc who really does stand first call on
  // two days of one weekend owes-off two duties, not one.
  it('primary call counts PER DAY — Fri C1 + Sat C1 in one weekend is 2.0', () => {
    const totals = weekendDutiesByProvider([
      wk('2026-08-14', 'C1', { pid: 'p1' }),
      wk('2026-08-15', 'C1', { pid: 'p1' }),
    ]);
    expect(totals.p1).toBe(2);
  });

  it('neuro is still capped PER WEEKEND — a Sat+Sun neuro pair is 1.0, not 2', () => {
    const totals = weekendDutiesByProvider([
      wk('2026-08-15', 'C3', { pid: 'p1' }),
      wk('2026-08-16', 'C3', { pid: 'p1' }),
    ], NEURO);
    expect(totals.p1).toBe(1);
  });

  it('neuro pairs add across weekends (two pairs = 2.0)', () => {
    const totals = weekendDutiesByProvider([
      wk('2026-08-15', 'C3', { pid: 'p1' }), wk('2026-08-16', 'C3', { pid: 'p1' }),
      wk('2026-08-22', 'C3', { pid: 'p1' }), wk('2026-08-23', 'C3', { pid: 'p1' }),
    ], NEURO);
    expect(totals.p1).toBe(2);
  });

  it('a 12h Saturday C1 plus a 12h Sunday C1 adds back up to one duty', () => {
    const totals = weekendDutiesByProvider([
      wk('2026-08-15', 'C1D12', { pid: 'p1', weight: 0.5, parent: 'C1' }),
      wk('2026-08-16', 'C1D12', { pid: 'p1', weight: 0.5, parent: 'C1' }),
    ]);
    expect(totals.p1).toBe(1);
  });

  it('riding along on the chain (Fri C2 / Sun C2 / Sat C3 at a non-neuro site) credits nothing', () => {
    const totals = weekendDutiesByProvider([
      wk('2026-08-14', 'C2', { pid: 'p1' }),
      wk('2026-08-16', 'C2', { pid: 'p1' }),
      wk('2026-08-15', 'C3', { pid: 'p1' }),
    ]);   // no neuro code stated → C3 is just third call
    expect(totals.p1 ?? 0).toBe(0);
  });

  it('weekday first call never counts as a weekend duty', () => {
    const totals = weekendDutiesByProvider([wk('2026-08-12', 'C1', { pid: 'p1' })], NEURO);
    expect(totals.p1 ?? 0).toBe(0);
  });

  it('unfilled weekend slots credit nobody (the block still OWES them)', () => {
    const slots = [wk('2026-08-15', 'C1'), wk('2026-08-15', 'C3'), wk('2026-08-16', 'C3')];
    expect(weekendDutiesByProvider(slots, NEURO)).toEqual({});
    expect(weekendObligationUnits(slots, NEURO)).toBe(2); // 1 primary day + 1 neuro pair
  });
});

describe('requiredWeekendsFor', () => {
  // Gabriel's confirmed preview, 2026-07-27: a 1.0 FTE owes 4, a 0.75 FTE 3,
  // a 0.5 FTE 2 — from (33 primary + 11 neuro) ÷ 11 par = 4 per full FTE,
  // rounded DOWN to the nearest half.
  const UNITS = 44;
  // Pin the denominator against the block fixture, so a change to either the
  // fixture or the unit math can't quietly leave these numbers stranded.
  it('the block fixture really does hold 44 units', () => {
    expect(weekendObligationUnits(PAOLI_BLOCK, NEURO)).toBe(UNITS);
  });

  // SUPERSEDES: '1.0 FTE owes three weekends' (33 units, nearest half).
  it('Ganiyu, 1.0 FTE → 4', () => {
    expect(requiredWeekendsFor(UNITS, 11, 1)).toBe(4);
  });

  // SUPERSEDES: '0.75 FTE owes 2.5 (2.25 → nearest half, ties up)'. Rounding
  // DOWN is exactly what this row forced: 0.75 × 4 = 3.0 here, but on any
  // block where it lands on .25 he wants the lower half, not the higher.
  it('Havildar, 0.75 FTE → 3', () => {
    expect(requiredWeekendsFor(UNITS, 11, 0.75)).toBe(3);
  });

  // SUPERSEDES: '0.5 FTE owes 1.5 weekends'.
  it('Horan, 0.5 FTE → 2 (the number her Sat C1 + 12h Sun C1 + single neuro day lands on)', () => {
    expect(requiredWeekendsFor(UNITS, 11, 0.5)).toBe(2);
  });

  // SUPERSEDES: 'resolves to half-weekend granularity' with ties-up values
  // (0.6 → 2, 0.4 → 1, 0.3 → 1, 0.2 → 0.5 against 33 units).
  it('rounds DOWN to the nearest half, never up', () => {
    expect(requiredWeekendsFor(UNITS, 11, 0.9)).toBe(3.5);   // 3.6 → 3.5, not 3.5-up-to-4
    expect(requiredWeekendsFor(UNITS, 11, 0.8)).toBe(3);     // 3.2 → 3
    expect(requiredWeekendsFor(UNITS, 11, 0.6)).toBe(2);     // 2.4 → 2
    expect(requiredWeekendsFor(UNITS, 11, 0.4)).toBe(1.5);   // 1.6 → 1.5, NOT 2
    expect(requiredWeekendsFor(UNITS, 11, 0.2)).toBe(0.5);   // 0.8 → 0.5, NOT 1
  });

  it('a raw value a hair under a half-step still lands ON it (WEIGHT_EPSILON)', () => {
    // 3 × 0.3333 arithmetic: 0.9999 of a unit must not floor a whole half down.
    expect(requiredWeekendsFor(3.9999, 11, 11)).toBe(4);
  });

  it('a provider outside the call pool (weight 0) owes none', () => {
    expect(requiredWeekendsFor(UNITS, 11, 0)).toBe(0);
  });

  it('a missing/zero par owes none rather than dividing by zero', () => {
    expect(requiredWeekendsFor(UNITS, 0, 1)).toBe(0);
  });
});
