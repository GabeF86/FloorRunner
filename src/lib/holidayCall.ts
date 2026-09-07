// Holiday call — the chief's plan of record for who covers call on each
// federal holiday, entered from the Holiday Call card on the schedules page
// (Gabriel 2026-09-06) and stored on each provider's availability profile.
//
// WHY IT LIVES IN provider_availability. A holiday call decision is made
// LONG before the schedule covering it exists — Gabriel settles Christmas in
// September. There is no schedule version to hang an assignment on yet, so
// the decision is recorded against the PROVIDER (availability_type
// 'holiday_call', patch44) and materializes into real assignments the moment
// a schedule covering that date is created (planHolidayCallSeeds below).
//
// ENGINE SEMANTICS. 'holiday_call' is deliberately NOT in BLOCKING_AVAIL
// (rulesEngine/shared.ts): it means the provider IS WORKING, so it must never
// read as time off. It reaches the generator through the EXISTING seed
// machinery rather than any new engine path — schedule creation writes the
// recorded provider onto the matching slot's assignment row as a locked
// manual assignment, and genContext's seed walk picks it up like any other
// pre-existing assignment (genContext.ts §8). That is why nothing in
// solve()/optimize()/commitPlan needed to change: a holiday call seed is
// indistinguishable from a manual placement once the slots exist, so
// post-call blocks, quota counting, cross-site checks and fairness all apply
// to it for free. source_type 'manual' also puts it out of reach of the
// pre-fill eviction gates (preFillEviction.ts gate (a) evicts auto_generated
// occupants only).

import { addDays } from './rulesEngine/shared';

/** availability_type value (patch44). */
export const HOLIDAY_CALL_TYPE = 'holiday_call';

/**
 * provider_availability.source stamp for rows the Holiday Call card wrote.
 * Lets the card own its rows without claiming every 'holiday_call' row in the
 * table — a future importer can write the same type with its own source.
 */
export const HOLIDAY_CALL_SOURCE = 'holiday_call_card';

/**
 * The call codes a holiday day can be staffed with. Fixed set (Gabriel
 * 2026-09-06) rather than a live shift_types read: the card is org-wide and
 * these four are the vocabulary every site's call slate uses. The code is
 * stored in provider_availability.reason_code and is matched against
 * shift_types.code when the seeds materialize.
 */
export const HOLIDAY_CALL_CODES = [
  { code: 'C1', label: 'C1 — In-house call' },
  { code: 'C2', label: 'C2 — Backup / late' },
  { code: 'C3', label: 'C3 — Neuro' },
  { code: 'PC', label: 'PC — Post-call' },
] as const;

export type HolidayCallCode = typeof HOLIDAY_CALL_CODES[number]['code'];

const CODE_SET: ReadonlySet<string> = new Set(HOLIDAY_CALL_CODES.map(c => c.code));

export function isHolidayCallCode(code: string | null | undefined): code is HolidayCallCode {
  return !!code && CODE_SET.has(code);
}

export function holidayCallCodeLabel(code: string): string {
  return HOLIDAY_CALL_CODES.find(c => c.code === code)?.label ?? code;
}

/** 0 = Sunday … 6 = Saturday, read in UTC so it never shifts with the runner's TZ. */
function dow(iso: string): number {
  return new Date(iso + 'T00:00:00Z').getUTCDay();
}

function isWeekend(iso: string): boolean {
  const d = dow(iso);
  return d === 0 || d === 6;
}

function isThanksgiving(name: string | null | undefined): boolean {
  return !!name && /thanksgiving/i.test(name);
}

/**
 * Every day a holiday covers for call purposes (Gabriel 2026-09-06: "some
 * holidays stretch over a few days, like weekends").
 *
 * The rule, deliberately mechanical so the card and the seeder can never
 * disagree about which days exist:
 *   • the holiday date itself, always;
 *   • walking BACKWARD, each contiguous Sat/Sun immediately before it — so a
 *     Monday holiday pulls in the Sunday and Saturday ahead of it;
 *   • walking FORWARD, each contiguous Sat/Sun immediately after it — so a
 *     Friday holiday pulls in the Saturday and Sunday behind it;
 *   • Thanksgiving additionally takes the Friday after (it is always a
 *     Thursday, and the Friday is worked as part of the holiday block), and
 *     the forward weekend walk then continues through that Friday.
 *
 * Worked examples on the seeded calendar (patch23):
 *   Thanksgiving  Thu 2026-11-26 → 11-26, 11-27, 11-28, 11-29
 *   Christmas     Fri 2026-12-25 → 12-25, 12-26, 12-27
 *   New Year's    Fri 2027-01-01 → 01-01, 01-02, 01-03
 *   Memorial Day  Mon 2026-05-25 → 05-23, 05-24, 05-25
 *   Veterans Day  Wed 2026-11-11 → 11-11 alone
 *
 * Returns ascending, de-duplicated ISO dates.
 */
export function holidayBlockDates(holidayDate: string, holidayName?: string | null): string[] {
  const before: string[] = [];
  for (let d = addDays(holidayDate, -1); isWeekend(d); d = addDays(d, -1)) {
    before.unshift(d);
  }

  const after: string[] = [];
  let cursor = holidayDate;
  // Thanksgiving's Friday is part of the block even though it is a weekday;
  // taking it first lets the ordinary weekend walk carry on into Sat/Sun.
  if (isThanksgiving(holidayName)) {
    cursor = addDays(cursor, 1);
    after.push(cursor);
  }
  for (let d = addDays(cursor, 1); isWeekend(d); d = addDays(d, 1)) {
    after.push(d);
  }

  return [...before, holidayDate, ...after];
}

// ── Seeding a new schedule ────────────────────────────────────────────────

/** One recorded holiday-call decision (a provider_availability row). */
export interface HolidayCallEntry {
  provider_id: string;
  /** Single day — holiday-call rows are always start_date === end_date. */
  date: string;
  /** Call code from reason_code. */
  code: string;
}

/** A freshly created slot and its (open) assignment row. */
export interface HolidayCallSlot {
  slot_id: string;
  assignment_id: string;
  slot_date: string;
  /** shift_types.code for the slot. */
  code: string;
  slot_index: number;
}

export interface HolidayCallSeedFill {
  slot_id: string;
  assignment_id: string;
  provider_id: string;
  slot_date: string;
  code: string;
}

export interface HolidayCallSeedSkip {
  provider_id: string;
  date: string;
  code: string;
  reason: string;
}

export interface HolidayCallSeedPlan {
  fills: HolidayCallSeedFill[];
  /**
   * Recorded decisions that could NOT be placed. Never dropped silently — the
   * same discipline clinical invariant 4 imposes on skipped derived shifts:
   * the caller surfaces these so the chief knows the holiday plan did not
   * fully materialize (e.g. the site has no PC slot on that date).
   */
  skipped: HolidayCallSeedSkip[];
}

/**
 * Match recorded holiday-call decisions onto the slots a new schedule just
 * materialized. PURE — the caller does the DB writes.
 *
 * Entries are consumed in a stable order (date, then code, then the order the
 * caller supplied) and each takes the lowest-index still-open slot for its
 * (date, code). Two providers recorded on the same date+code both land when
 * the slate has sibling slots (required_count > 1) and the second is skipped
 * when it does not — the schedule's slate stays authoritative about how much
 * coverage exists, never the holiday plan.
 */
export function planHolidayCallSeeds(
  entries: readonly HolidayCallEntry[],
  slots: readonly HolidayCallSlot[],
): HolidayCallSeedPlan {
  // (date|code) -> open slots, lowest slot_index first.
  const open = new Map<string, HolidayCallSlot[]>();
  for (const s of slots) {
    const key = `${s.slot_date}|${s.code}`;
    const list = open.get(key);
    if (list) list.push(s);
    else open.set(key, [s]);
  }
  for (const list of open.values()) list.sort((a, b) => a.slot_index - b.slot_index);

  const fills: HolidayCallSeedFill[] = [];
  const skipped: HolidayCallSeedSkip[] = [];
  const claimed = new Set<string>(); // provider|date — one call code per provider per day

  const ordered = [...entries].sort((a, b) =>
    a.date.localeCompare(b.date) || a.code.localeCompare(b.code));

  for (const e of ordered) {
    const dayKey = `${e.provider_id}|${e.date}`;
    if (claimed.has(dayKey)) {
      skipped.push({ ...e, reason: 'provider already placed on this date' });
      continue;
    }
    const list = open.get(`${e.date}|${e.code}`);
    if (!list) {
      skipped.push({ ...e, reason: `no ${e.code} slot on this date in the new schedule` });
      continue;
    }
    const slot = list.shift();
    if (!slot) {
      skipped.push({ ...e, reason: `every ${e.code} slot on this date is already taken` });
      continue;
    }
    claimed.add(dayKey);
    fills.push({
      slot_id: slot.slot_id,
      assignment_id: slot.assignment_id,
      provider_id: e.provider_id,
      slot_date: e.date,
      code: e.code,
    });
  }

  return { fills, skipped };
}
