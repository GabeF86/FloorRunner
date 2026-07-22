// Shared fixture builders for rulesEngine tests.
//   buildFixtureContext — the 4-week golden-parity block (moved here from
//     goldenParity.test.ts so both goldenParity and patternEngine reuse it).
//   buildCtx / prov / callSlot / dSlot / cred / shiftInfo — small targeted
//     helpers for the pattern-interpreter cases.
import { addDays, dayOfWeekUTC, dayTypeBucket, dayTypeFromDow } from '../shared';
import type {
  GenerationContext, SlotToFill, CandidateProvider, AvailabilityEntry,
  SiteCredentials, ShiftTypeInfo,
} from '../genTypes';

// ── the 4-week golden block ────────────────────────────────────────────────
// 2026-01-05 (Mon) .. 2026-02-01 (Sun) at one site, mirroring production slot
// shape: C1+C2 every day; C3 weekends; D1-D3 every day; D4-D6 weekdays/fridays.
// 10 physicians p01..p10 (FTE 1.0 x6, 0.8 x2, 0.5 x2); p06 unavailable Fridays;
// p05 PTO 2026-01-14..16; p04 cross-site 2026-01-20/21.
// PAR_LEVEL 4 (not 12): keeps the FTE-weighted quota formula identical while
// clearing 1.0 on sparse weekend buckets so the weekend chain actually fires.
const BLOCK_START = '2026-01-05';
const BLOCK_DAYS = 28;
const PAR_LEVEL = 4;

export function derivedDayType(date: string): string {
  return dayTypeFromDow(dayOfWeekUTC(date)); // single-homed DOW mapping (shared.ts)
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

export function buildFixtureContext(overrides: Partial<GenerationContext> = {}): GenerationContext {
  const dates = blockDates();

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

  const slotIndex = new Map<string, Map<string, SlotToFill>>();
  for (const s of allSlots) {
    if (!slotIndex.has(s.slot_date)) slotIndex.set(s.slot_date, new Map());
    slotIndex.get(s.slot_date)!.set(s.shift_type_code, s);
  }

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

  const fteFor = (n: number): number => (n <= 6 ? 1.0 : n <= 8 ? 0.8 : 0.5);
  const providers: CandidateProvider[] = [];
  for (let n = 1; n <= 10; n++) {
    const id = `p${String(n).padStart(2, '0')}`;
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

  const availByPid = new Map<string, AvailabilityEntry[]>();
  availByPid.set('p05', [{
    availability_type: 'pto',
    start_date: '2026-01-14',
    end_date: '2026-01-16',
    approval_status: 'approved',
  }]);

  const crossSiteByDate = new Map<string, Set<string>>();
  crossSiteByDate.set('p04', new Set(['2026-01-20', '2026-01-21']));

  const bucketTotals = new Map<string, number>();
  for (const s of slotsToFill) {
    const key = `${dayTypeBucket(s.derived_day_type)}|${s.shift_type_code}`;
    bucketTotals.set(key, (bucketTotals.get(key) || 0) + s.required_count);
  }

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

// ── small targeted helpers for the pattern-interpreter cases ────────────────

export function prov(id: string, fte = 1, over: Partial<CandidateProvider> = {}): CandidateProvider {
  return {
    id, provider_type: 'physician', short_display_name: id, fte_value: fte,
    home_site_id: 'site1', available_weekdays: [true, true, true, true, true, true, true],
    ...over,
  };
}

export function callSlot(id: string, date: string, code: string, dt = 'weekday'): SlotToFill {
  return {
    slot_id: id, slot_date: date, shift_type_id: 'st-' + code,
    shift_type_code: code, shift_type_category: 'call',
    derived_day_type: dt, provider_group: 'physician',
    required_count: 1, existing_assignment_id: null,
  };
}

export function dSlot(id: string, date: string, code: string, dt = 'weekday'): SlotToFill {
  return {
    slot_id: id, slot_date: date, shift_type_id: 'st-' + code,
    shift_type_code: code, shift_type_category: 'regular',
    derived_day_type: dt, provider_group: 'physician',
    required_count: 1, existing_assignment_id: null,
  };
}

export function cred(over: Partial<SiteCredentials> = {}): SiteCredentials {
  return {
    is_active: true, credentialed: true, can_take_call: true,
    can_take_weekend_call: true, can_take_holiday_call: true,
    allowed_shift_types: [], excluded_shift_types: [], skill_tags: [], ...over,
  };
}

export function shiftInfo(code: string, over: Partial<ShiftTypeInfo> = {}): ShiftTypeInfo {
  return {
    code, category: 'regular', call_rank: null, relief_rank: null,
    is_overlay: false, generation_engine: 'day_pool',
    requires_post_call_rule: false, call_coverage_type: null,
    manual_only: false, call_burden_weight: 1, parent_call_code: null, ...over,
  };
}

// Generic small-context builder: slotIndex from ALL slots, slotsToFill =
// call-category slots in input order, generous per-bucket quota (99) unless a
// test overrides bucketTarget. Mirrors solve.test.ts's local buildCtx.
export function buildCtx(
  slots: SlotToFill[], providers: CandidateProvider[],
  over: Partial<GenerationContext> = {},
): GenerationContext {
  const slotIndex = new Map<string, Map<string, SlotToFill>>();
  for (const s of slots) {
    if (!slotIndex.has(s.slot_date)) slotIndex.set(s.slot_date, new Map());
    slotIndex.get(s.slot_date)!.set(s.shift_type_code, s);
  }
  const bucketTotals = new Map<string, number>();
  const bucketTarget = new Map<string, number>();
  for (const s of slots) {
    const key = `${dayTypeBucket(s.derived_day_type)}|${s.shift_type_code}`;
    bucketTotals.set(key, (bucketTotals.get(key) || 0) + 1);
    for (const p of providers) bucketTarget.set(`${p.id}|${key}`, 99);
  }
  return {
    scheduleVersionId: 'v1', siteId: 'site1', parLevel: 12,
    slotsToFill: slots.filter(s => s.shift_type_category === 'call'),
    slotIndex, providers,
    credByPid: new Map(), availByPid: new Map(), crossSiteByDate: new Map(),
    historicalAssignedByPid: new Map(), historicalTotalByBucket: new Map(),
    bucketTotals, bucketTarget, seedAssignments: [],
    ...over,
  };
}
