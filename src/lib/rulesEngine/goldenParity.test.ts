import { describe, it, expect } from 'vitest';
import { solve } from './solve';
import { solveLegacy } from './solveLegacy';
import { addDays, dayOfWeekUTC, dayTypeBucket } from './shared';
import type {
  GenerationContext, SlotToFill, CandidateProvider, AvailabilityEntry, SolutionPlan,
} from './genTypes';

// ── deterministic fixture builder ──────────────────────────────────────────
// A 4-week block (2026-01-05 Mon .. 2026-02-01 Sun) at one site, mirroring the
// production slot shape so the parity net exercises the real code paths:
//   call:    C1 + C2 every day; C3 on saturdays + sundays only
//   derived: D1, D2, D3 every day
//   relief:  D4, D5, D6 on weekdays + fridays
// 10 physician providers p01..p10 with mixed FTE (1.0 x6, 0.8 x2, 0.5 x2).
//   p06 unavailable Fridays; p05 PTO 2026-01-14..2026-01-16;
//   p04 already booked at another site on 2026-01-20 and 2026-01-21.
// slotIndex covers ALL slots; slotsToFill is call-category only, pre-sorted in
// the exact structural order genContext.ts produces (weekend-first). Bucket
// targets use genContext's FTE-weighted formula, sized (see PAR_LEVEL note
// below) so the structural chains fire against real quotas — not a no-op.
// Deterministic ids: providers 'p01'..'p10', slots `${date}|${code}`.

const BLOCK_START = '2026-01-05';
const BLOCK_DAYS = 28; // 2026-01-05 (Mon) .. 2026-02-01 (Sun), inclusive

// Targets use genContext's exact FTE-weighted formula (bucketTotal / parLevel) *
// fte. NOTE the par level is 4, not the production 12: over a 4-week block the
// weekend bucket holds only 8 call slots per code, so at parLevel 12 the target
// is 8/12*fte = 0.67 < 1 and the legacy quota gate ("assigned + 1 > target")
// blocks the FIRST weekend assignment — NO weekend call slot fills and the
// weekend chain never fires (measured: parLevel 12 -> 0 weekend-chain, 48
// unfilled). That fractional-quota starvation on sparse buckets is a known
// legacy hole (spec IF-3 "quota relaxation"), NOT the behavior this parity net
// exists to freeze; a no-op harness proves nothing (step 4). parLevel 4 keeps
// the identical formula (only the tunable divisor changes) while clearing 1.0
// on the sparse buckets: weekend 8/4=2.0, friday 4/4=1.0, weekday 16/4=4.0.
// Measured at parLevel 4: 181 assignments, 17 weekend-chain, 1 unfilled — so the
// net also covers the unfilled/candidate-rejection path. Per-FTE quota
// differences stay live (0.5-FTE friday target = 4/4*0.5 = 0.5 < 1, still
// blocked). The parity result is par-level-independent (solve === solveLegacy).
const PAR_LEVEL = 4;

function derivedDayType(date: string): string {
  const dow = dayOfWeekUTC(date); // 0=Sun .. 6=Sat
  if (dow === 6) return 'saturday';
  if (dow === 0) return 'sunday';
  if (dow === 5) return 'friday';
  return 'weekday';
}

function blockDates(): string[] {
  const out: string[] = [];
  for (let i = 0; i < BLOCK_DAYS; i++) out.push(addDays(BLOCK_START, i));
  return out;
}

function mkSlot(date: string, code: string, category: string): SlotToFill {
  return {
    slot_id: `${date}|${code}`,
    slot_date: date,
    shift_type_id: `st-${code}`,
    shift_type_code: code,
    shift_type_category: category,
    derived_day_type: derivedDayType(date),
    provider_group: 'physician',
    required_count: 1,
    existing_assignment_id: null,
  };
}

function buildFixtureContext(overrides: Partial<GenerationContext> = {}): GenerationContext {
  const dates = blockDates();

  // ── every open slot (call + derived + relief) ──
  const allSlots: SlotToFill[] = [];
  for (const date of dates) {
    const dt = derivedDayType(date);
    const isWeekend = dt === 'saturday' || dt === 'sunday';
    const isWeekdayOrFriday = dt === 'weekday' || dt === 'friday';
    allSlots.push(mkSlot(date, 'C1', 'call'));
    allSlots.push(mkSlot(date, 'C2', 'call'));
    if (isWeekend) allSlots.push(mkSlot(date, 'C3', 'call'));
    allSlots.push(mkSlot(date, 'D1', 'regular'));
    allSlots.push(mkSlot(date, 'D2', 'regular'));
    allSlots.push(mkSlot(date, 'D3', 'regular'));
    if (isWeekdayOrFriday) {
      allSlots.push(mkSlot(date, 'D4', 'regular'));
      allSlots.push(mkSlot(date, 'D5', 'regular'));
      allSlots.push(mkSlot(date, 'D6', 'regular'));
    }
  }

  // ── slotIndex: ALL slots, keyed [date][code] ──
  const slotIndex = new Map<string, Map<string, SlotToFill>>();
  for (const s of allSlots) {
    if (!slotIndex.has(s.slot_date)) slotIndex.set(s.slot_date, new Map());
    slotIndex.get(s.slot_date)!.set(s.shift_type_code, s);
  }

  // ── slotsToFill: call-category only, sorted EXACTLY as genContext.ts does
  //    (weekends first, then friday, then weekday; within a date C2/C3 before
  //    C1). Precedence: dayOrder -> date -> codeOrder. ──
  const dayOrder: Record<string, number> = {
    saturday: 0, sunday: 1, friday: 2, weekday: 3,
    federal_holiday: 4, major_holiday: 4, holiday: 4,
  };
  const codeOrder: Record<string, number> = { C2: 0, C3: 1, C1: 2 };
  const slotsToFill = allSlots.filter(s => s.shift_type_category === 'call');
  slotsToFill.sort((a, b) => {
    const da = dayOrder[a.derived_day_type] ?? 5;
    const db = dayOrder[b.derived_day_type] ?? 5;
    if (da !== db) return da - db;
    if (a.slot_date !== b.slot_date) return a.slot_date.localeCompare(b.slot_date);
    const ca = codeOrder[a.shift_type_code] ?? 9;
    const cb = codeOrder[b.shift_type_code] ?? 9;
    return ca - cb;
  });

  // ── providers p01..p10 ──
  const fteFor = (n: number): number => (n <= 6 ? 1.0 : n <= 8 ? 0.8 : 0.5);
  const providers: CandidateProvider[] = [];
  for (let n = 1; n <= 10; n++) {
    const id = `p${String(n).padStart(2, '0')}`;
    // available_weekdays is indexed Sun..Sat; index 5 is Friday.
    const available_weekdays = n === 6
      ? [true, true, true, true, true, false, true] // p06 unavailable Fridays
      : [true, true, true, true, true, true, true];
    providers.push({
      id,
      provider_type: 'physician',
      short_display_name: id,
      fte_value: fteFor(n),
      home_site_id: 'site1',
      available_weekdays,
    });
  }

  // ── availability: p05 PTO 2026-01-14 .. 2026-01-16 ──
  const availByPid = new Map<string, AvailabilityEntry[]>();
  availByPid.set('p05', [{
    availability_type: 'pto',
    start_date: '2026-01-14',
    end_date: '2026-01-16',
    approval_status: 'approved',
  }]);

  // ── cross-site: p04 already booked elsewhere on 2026-01-20 & 2026-01-21 ──
  const crossSiteByDate = new Map<string, Set<string>>();
  crossSiteByDate.set('p04', new Set(['2026-01-20', '2026-01-21']));

  // ── bucketTotals from call slots: dayTypeBucket(dt)|code ──
  const bucketTotals = new Map<string, number>();
  for (const s of slotsToFill) {
    const key = `${dayTypeBucket(s.derived_day_type)}|${s.shift_type_code}`;
    bucketTotals.set(key, (bucketTotals.get(key) || 0) + s.required_count);
  }

  // ── bucketTarget: (bucketTotal / parLevel) * fte for every provider×bucket×code
  //    (no historical deficit — historical maps are empty) ──
  const bucketTarget = new Map<string, number>();
  for (const p of providers) {
    for (const [key, total] of bucketTotals) {
      bucketTarget.set(`${p.id}|${key}`, (total / PAR_LEVEL) * p.fte_value);
    }
  }

  return {
    scheduleVersionId: 'v-golden',
    siteId: 'site1',
    parLevel: PAR_LEVEL,
    slotsToFill,
    slotIndex,
    providers,
    credByPid: new Map(),
    availByPid,
    crossSiteByDate,
    historicalAssignedByPid: new Map(),
    historicalTotalByBucket: new Map(),
    bucketTotals,
    bucketTarget,
    seedAssignments: [],
    ...overrides,
  };
}

// Drop fields the pattern-interpreter refactor is allowed to add/change. Only
// `explanation` (numeric decision detail) is stripped here; assignment identity
// (slot, provider, source) and the unfilled list must match exactly.
const stripAdditive = (plan: SolutionPlan) => ({
  assignments: plan.assignments.map(a => ({ ...a, explanation: undefined })),
  unfilled: plan.unfilled,
});

describe('golden parity: v2 engine + classic pattern ≡ legacy engine', () => {
  it('produces identical assignments and unfilled on the base fixture', () => {
    const ctx = buildFixtureContext();
    const legacy = solveLegacy(ctx);
    const v2 = solve(ctx); // classic behavior is the default (no ctx.callPattern yet)
    expect(stripAdditive(v2)).toEqual(stripAdditive(legacy));
  });

  it('parity holds with PTO, cross-site, and weekday-limited providers', () => {
    const ctx = buildFixtureContext(); // builder already includes p04/p05/p06
    expect(stripAdditive(solve(ctx))).toEqual(stripAdditive(solveLegacy(ctx)));
  });

  it('parity holds under callOverrides (optimizer forcing seam)', () => {
    const ctx = buildFixtureContext();
    const anyCallSlot = ctx.slotsToFill[0];
    const overrides = new Map([[anyCallSlot.slot_id, ctx.providers[3].id]]);
    expect(stripAdditive(solve(ctx, { callOverrides: overrides })))
      .toEqual(stripAdditive(solveLegacy(ctx, { callOverrides: overrides })));
  });
});

// A parity harness on an empty plan proves nothing: assert the fixture actually
// drives assignments AND exercises the weekend-chain path specifically.
describe('golden parity fixture — sanity (not a no-op)', () => {
  it('produces assignments, including weekend-chain-sourced ones', () => {
    const plan = solve(buildFixtureContext());
    const weekendChain = plan.assignments.filter(a => a.source === 'weekend-chain');
    expect(plan.assignments.length).toBeGreaterThan(0);
    expect(weekendChain.length).toBeGreaterThan(0);
  });
});
