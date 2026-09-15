// A site's ANNUAL call load, and what one full FTE therefore owes.
//
// ── IT SIMULATES THE REAL MATERIALIZER, IT DOES NOT MODEL IT ────────────────
// The obvious implementation — read shift_templates, multiply required_count
// by how many of that day type fall in the year — is WRONG, and wrong in a way
// that looks right. Paoli has no active Friday call template yet its live
// schedule holds 19 Friday C1 and 19 Friday C2 slots, because `slateForDayType`
// implements a FRIDAY PARTIAL-OVERRIDE CONTRACT: friday rows override per
// shift type, other weekday templates still materialize onto Fridays, and a
// count-0 friday row suppresses. A naive reading reports zero Friday call.
//
// So this walks the year day by day through the SAME three helpers the
// schedule-creation route uses (`derivedDayTypeFor`, `slateForDayType`,
// `templateSlotCount`). Those are already single-homed in templateSlots.ts and
// already shared with the Physician Planner precisely so estimates cannot
// diverge from real slot creation. This is the third consumer, not a fourth
// implementation.
//
// ── WHERE PAR COMES IN ─────────────────────────────────────────────────────
// `sites.call_par_level` is THE obligation denominator, unconditionally and in
// both directions (Gabriel 2026-07-24, par-authoritative — see fteTarget.ts).
// One 1.0-FTE call taker owes `annual slots ÷ par` for each call type on each
// kind of day — that per-type figure is the number Gabriel reads this table
// for. When the pool's ΣFTE is below par, obligations deliberately UNDER-cover
// the schedule; the remainder is the paid-pickup layer. That is the design, not
// a rounding error, which is why the site's own slot count is shown beside the
// per-FTE share rather than hidden behind it.

import {
  derivedDayTypeFor,
  slateForDayType,
  templateSlotCount,
  type TemplateUnionRow,
} from './templateSlots';
import { dayTypeBucketOn } from './rulesEngine/shared';
import { parentCallCodeOf } from './callBurden';

/**
 * The day-type groups the table lists, in order.
 *
 * Saturday and Sunday are SEPARATE rather than a merged weekend column
 * (Gabriel 2026-09-15, describing the slate as "Saturday C1, C2 and C3 (Neuro)
 * and same with Sunday"). That also makes this exactly the engine's own
 * FAIRNESS_BUCKETS domain, so the table cannot describe a grouping the
 * scheduler does not actually use.
 */
export const OBLIGATION_BUCKETS = ['weekday', 'friday', 'saturday', 'sunday'] as const;
export type ObligationBucket = (typeof OBLIGATION_BUCKETS)[number];

export const BUCKET_LABELS: Record<ObligationBucket, string> = {
  weekday: 'M–Th',
  friday: 'Friday',
  saturday: 'Saturday',
  sunday: 'Sunday',
};

export interface ObligationTemplate extends TemplateUnionRow {
  /** shift_types.code, resolved by the caller. */
  code: string;
  /** shift_types.parent_call_code — split segments fold into their parent. */
  parent_call_code?: string | null;
  /**
   * Declared here because TemplateUnionRow deliberately does not: it is the
   * minimal shape `slateForDayType` needs, and `templateSlotCount` reads this
   * separately. Typed `unknown` to match that helper, which does its own
   * null/<=0 handling rather than trusting the column.
   */
  required_count?: unknown;
}

/** One call type on one kind of day — the unit Gabriel reads the table in. */
export interface ObligationRow {
  code: string;
  /** Slots the SITE must cover in the year for this code on this day type. */
  slots: number;
  /** What a 1.0 FTE owes: slots ÷ par. Fractional on purpose. */
  perFte: number;
}

export interface ObligationGroup {
  bucket: ObligationBucket;
  label: string;
  rows: ObligationRow[];
  slots: number;
  perFte: number;
}

export interface SiteCallObligation {
  year: number;
  parLevel: number;
  /** M–Th, Friday, Saturday, Sunday — only those with call in them. */
  groups: ObligationGroup[];
  totalSlots: number;
  /** Every call a 1.0 FTE owes in the year, across all groups. */
  totalPerFte: number;
  /** True when the site has no active call templates — nothing to compute. */
  noSlate: boolean;
}

/**
 * The bucket a day type is charged to.
 *
 * `dayTypeBucketOn` already folds a holiday onto the day of the week it lands
 * on, which is what keeps Christmas-on-a-Tuesday out of the Saturday row and
 * puts it in Friday's, where the person actually works it.
 */
export function bucketFor(dayType: string, date: string): ObligationBucket | null {
  const b = dayTypeBucketOn(dayType, date);
  return (OBLIGATION_BUCKETS as readonly string[]).includes(b)
    ? (b as ObligationBucket)
    : null; // outside the fairness domain — charged nowhere rather than guessed
}

/** Every date in the calendar year, as ISO strings. Handles leap years. */
export function datesInYear(year: number): string[] {
  const out: string[] = [];
  const d = new Date(Date.UTC(year, 0, 1));
  while (d.getUTCFullYear() === year) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

export interface HolidayInfo { is_major_holiday: boolean; holiday_type: string }

/**
 * Walk the year, materializing each day exactly as schedule creation would.
 *
 * `templates` must already be filtered to ACTIVE CALL templates — the caller
 * owns that filter because it owns the shift_types join that supplies `code`.
 */
export function computeSiteCallObligation(args: {
  year: number;
  parLevel: number;
  templates: readonly ObligationTemplate[];
  holidays: ReadonlyMap<string, HolidayInfo>;
}): SiteCallObligation {
  const { year, parLevel, templates, holidays } = args;

  if (templates.length === 0) {
    return { year, parLevel, groups: [], totalSlots: 0, totalPerFte: 0, noSlate: true };
  }

  // bucket -> code -> annual slot count
  const grid = new Map<ObligationBucket, Map<string, number>>();

  for (const date of datesInYear(year)) {
    const dayType = derivedDayTypeFor(date, holidays.get(date));
    const bucket = bucketFor(dayType, date);
    if (!bucket) continue;

    for (const tmpl of slateForDayType(templates as ObligationTemplate[], dayType)) {
      const n = templateSlotCount(tmpl);
      if (n <= 0) continue;
      // Split segments (C2N12, C2N8) are charged to their PARENT so the table
      // reads in the codes Gabriel named rather than in materialization detail.
      const code = parentCallCodeOf(tmpl.code, tmpl);
      const inBucket = grid.get(bucket) ?? new Map<string, number>();
      inBucket.set(code, (inBucket.get(code) ?? 0) + n);
      grid.set(bucket, inBucket);
    }
  }

  const groups: ObligationGroup[] = [];
  for (const bucket of OBLIGATION_BUCKETS) {
    const inBucket = grid.get(bucket);
    if (!inBucket || inBucket.size === 0) continue; // a day type with no call is not listed

    const rows: ObligationRow[] = [...inBucket.entries()]
      .map(([code, slots]) => ({ code, slots, perFte: perFteShare(slots, parLevel) }))
      // Call code order, not frequency: C1 before C2 before C3 is how the
      // slate is spoken about, and a table that reorders itself per site is
      // harder to read across sites.
      .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));

    const slots = rows.reduce((acc, r) => acc + r.slots, 0);
    groups.push({
      bucket,
      label: BUCKET_LABELS[bucket],
      rows,
      slots,
      perFte: perFteShare(slots, parLevel),
    });
  }

  const totalSlots = groups.reduce((acc, g) => acc + g.slots, 0);
  return {
    year,
    parLevel,
    groups,
    totalSlots,
    totalPerFte: perFteShare(totalSlots, parLevel),
    noSlate: false,
  };
}

/**
 * What ONE 1.0-FTE call taker owes, from a site total.
 *
 * Fractional on purpose. Rounding belongs at the whole-provider level
 * (`fteTarget.roundedObligation` rounds the SUM across buckets), and rounding
 * each bucket here then summing would not agree with it.
 */
export function perFteShare(siteTotal: number, parLevel: number): number {
  if (!Number.isFinite(parLevel) || parLevel <= 0) return 0;
  return siteTotal / parLevel;
}

/** One decimal, or a whole number when it is one. */
export function formatShare(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}
