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
// One 1.0-FTE call taker owes `annual slots ÷ par` in each bucket. When the
// pool's ΣFTE is below par, obligations deliberately UNDER-cover the schedule;
// the remainder is the paid-pickup layer. That is the design, not a rounding
// error, which is why this reports the site total and the per-FTE share side
// by side rather than only one of them.

import {
  derivedDayTypeFor,
  slateForDayType,
  templateSlotCount,
  type TemplateUnionRow,
} from './templateSlots';
import { dayTypeBucketOn } from './rulesEngine/shared';
import { parentCallCodeOf } from './callBurden';

/** The three columns Gabriel asked for: M-Th, F, Sat/Sun. */
export const OBLIGATION_BUCKETS = ['weekday', 'friday', 'weekend'] as const;
export type ObligationBucket = (typeof OBLIGATION_BUCKETS)[number];

export const BUCKET_LABELS: Record<ObligationBucket, string> = {
  weekday: 'M–Th',
  friday: 'Fri',
  weekend: 'Sat/Sun',
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

export interface CodeRow {
  code: string;
  /** Slots the SITE must cover in the year, per bucket. */
  byBucket: Record<ObligationBucket, number>;
  total: number;
}

export interface SiteCallObligation {
  year: number;
  parLevel: number;
  /** One row per call code, commonest first. */
  codes: CodeRow[];
  bucketTotals: Record<ObligationBucket, number>;
  grandTotal: number;
  /** True when the site has no active call templates — nothing to compute. */
  noSlate: boolean;
}

/**
 * The bucket a day type is charged to.
 *
 * `dayTypeBucketOn` already folds a holiday onto the day of the week it lands
 * on, which is what keeps Christmas-on-a-Tuesday out of the weekend column.
 * Saturday and Sunday are separate fairness buckets in the engine; they are
 * merged here only for DISPLAY, because that is the breakdown asked for.
 */
export function bucketFor(dayType: string, date: string): ObligationBucket | null {
  const b = dayTypeBucketOn(dayType, date);
  if (b === 'saturday' || b === 'sunday') return 'weekend';
  if (b === 'friday') return 'friday';
  if (b === 'weekday') return 'weekday';
  return null; // a bucket outside the fairness domain is not charged anywhere
}

function emptyBuckets(): Record<ObligationBucket, number> {
  return { weekday: 0, friday: 0, weekend: 0 };
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
    return {
      year,
      parLevel,
      codes: [],
      bucketTotals: emptyBuckets(),
      grandTotal: 0,
      noSlate: true,
    };
  }

  const byCode = new Map<string, Record<ObligationBucket, number>>();

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
      const row = byCode.get(code) ?? emptyBuckets();
      row[bucket] += n;
      byCode.set(code, row);
    }
  }

  const codes: CodeRow[] = [...byCode.entries()]
    .map(([code, byBucket]) => ({
      code,
      byBucket,
      total: byBucket.weekday + byBucket.friday + byBucket.weekend,
    }))
    .sort((a, b) => b.total - a.total || a.code.localeCompare(b.code));

  const bucketTotals = emptyBuckets();
  for (const c of codes) {
    for (const b of OBLIGATION_BUCKETS) bucketTotals[b] += c.byBucket[b];
  }

  return {
    year,
    parLevel,
    codes,
    bucketTotals,
    grandTotal: bucketTotals.weekday + bucketTotals.friday + bucketTotals.weekend,
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
