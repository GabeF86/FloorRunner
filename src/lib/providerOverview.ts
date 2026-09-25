/* ───────────────────────────────────────────────────────────────────────────
 * The clinician overview — one screen that answers "where do I stand".
 *
 * This is what a physician sees when they sign in and what back office sees
 * when they open somebody's record. Seven panels:
 *
 *   employment        what they are contracted for
 *   call owed vs took the block's obligation against what they hold
 *   additional calls  what they picked up PAST that obligation, priced by day
 *   hours             time on the schedule, and how it splits by site
 *   shift mix         day shifts against call shifts
 *   credentials       where they may actually be placed
 *   availability      PTO used, what is coming, what is outstanding
 *
 * ── EVERY FIGURE IS SCHEDULED, NOT PAYROLL ─────────────────────────────────
 * There is no payroll integration. Hours here are the hours the SCHEDULE puts
 * a person on the floor, summed from shift start and end times — which is a
 * different number from hours paid, and the panel says so. Labelling a
 * computed figure "Paycom" would make a physician check their pay against a
 * number that has never seen their pay.
 *
 * ── THE OWED SIDE IS BLOCK-SCALED, PER CATEGORY (Gabriel 2026-09-22) ────────
 * The stated per-FTE obligation BANDS were deleted from the pattern docs on
 * 2026-09-22. What is left — and what Gabriel wants — is the house formula,
 * applied one rung down from the block total:
 *
 *     owed(bucket, code) = (that category's slot weight in the block
 *                           ÷ sites.call_par_level) × the provider's FTE
 *
 * Par is 12, read from `sites.call_par_level`, AUTHORITATIVE and never clamped
 * to the roster's ΣFTE (2026-07-24): a pool below par means the obligations
 * deliberately under-cover the schedule and the remainder is the paid-pickup
 * layer. Because the formula is linear, Σ over the categories is exactly the
 * block total obligation — the two sides of the panel cannot drift.
 *
 * The obligation is therefore PER BLOCK while YTD/MTD are calendar windows.
 * The two are different denominators and the UI has to name them, or someone
 * reads "owed 11, taken 40 this year" as being 29 over.
 *
 * ── AND NOTHING NETS ───────────────────────────────────────────────────────
 * A provider can be over on M–Th C1 and short on Sun C2 at the same time and
 * both are true: the day types price differently, so an extra weekday call and
 * a missing Sunday call are not the same money and must never cancel.
 *
 * ── NEVER A CONFIDENT ZERO ─────────────────────────────────────────────────
 * "Nothing" and "we could not read it" render identically as 0 unless the
 * payload keeps them apart, and this codebase has been bitten by that more
 * than once. So every derived figure that depends on a read carries either a
 * null ("not loaded") or a window that says how far the data actually reaches
 * — published data only starts 2026-09-01, so a bare "YTD" label is a lie.
 * ─────────────────────────────────────────────────────────────────────────── */

import { overParBucketKey, fteWeightedTarget, roundedObligation } from './fteTarget';
import { WEIGHT_EPSILON, callBurdenWeight, parentCallCodeOf } from './callBurden';
import { dayTypeBucketOn, isDateBlocked, isBlockingAvailability, isActiveNoCallRequest,
  FAIRNESS_BUCKETS } from './rulesEngine/shared';
import { BUCKET_LABELS, orderCallCodes } from './callCountColumns';

// ── Inputs ─────────────────────────────────────────────────────────────────

export interface OverviewProvider {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  short_display_name?: string | null;
  provider_type?: string | null;
  status?: string | null;
}

export interface OverviewProfile {
  employment_status?: string | null;
  fte_value?: number | string | null;
  work_days_fte?: number | string | null;
  pto_weeks?: number | string | null;
  is_shareholder?: boolean | null;
  is_partner_track?: boolean | null;
  home_site_id?: string | null;
  call_taker?: boolean | null;
  partial_call_taker?: boolean | null;
}

/** One assignment the provider holds, flattened by the loader. */
export interface OverviewAssignment {
  date: string;
  siteId: string;
  code: string;
  /** `shift_types.category` — 'call' | 'regular' | … THE day-vs-call
   *  discriminator; see the note on ShiftMixPanel for why it is this column
   *  and not `counts_toward_call_burden`. */
  category: string;
  /** Null for a day shift. */
  callRank?: number | null;
  parentCode?: string | null;
  callBurdenWeight?: number | null;
  /** Shift start/end as HH:MM:SS or HH:MM. Null where the type has none. */
  startTime?: string | null;
  endTime?: string | null;
  /** The slot's derived day type — the engine's, not recomputed here. */
  dayType?: string | null;
  countsTowardHours?: boolean | null;
  /** `shift_types.counts_toward_call_burden`. Reported, never used to decide
   *  what a call is — Lankenau's C2 is category 'call' with this false. */
  countsTowardCallBurden?: boolean | null;
  /** `shift_types.provider_group` — 'physician' | 'crna' | 'both'. The SHIFT
   *  TYPE's column, which is real; `schedule_slots.provider_group` is 'both'
   *  on all 7,188 live rows and says nothing. */
  shiftProviderGroup?: string | null;
}

export interface OverviewAvailability {
  availability_type: string;
  approval_status: string;
  start_date: string;
  end_date: string;
}

export interface OverviewCredential {
  site_id: string;
  is_active?: boolean | null;
  credentialed?: boolean | null;
  effective_start_date?: string | null;
  effective_end_date?: string | null;
}

export interface OverviewSite { id: string; name: string; short_name?: string | null }

/** Everything the OWED side is scaled from. Null when any of it could not be
 *  read (no block covering today, a failed par read, a failed slot read) — and
 *  then every owed figure is null, never 0. */
export interface OwedInputs {
  /** `sites.call_par_level`, verbatim. Never clamped to the pool's ΣFTE. */
  parLevel: number;
  /** The provider's CALL-POOL FTE — their FTE when they are in the site's call
   *  pool, 0 when they are not (a day doc owes no call). */
  callFte: number;
  inCallPool: boolean;
  /** `bucket|parentCode` → slot weight the BLOCK stands. Seeds the row set:
   *  every category the block stands gets a row even at zero taken, because a
   *  missing row reads as "this does not apply to me". */
  bucketSlotWeight: ReadonlyMap<string, number>;
}

// ── Outputs ────────────────────────────────────────────────────────────────

/** How far the figures on this page actually reach. Published schedules only
 *  begin in September 2026, so labelling these totals "YTD" without saying
 *  what the data covers would overstate a thin year as a whole one. */
export interface CoveredWindow {
  /** The span the loader asked the database for. */
  requestedStart: string;
  requestedEnd: string;
  /** The earliest date any PUBLISHED schedule covers, when known — the honest
   *  left edge of every total here ("Since Sep 1", not "YTD"). */
  publishedFrom: string | null;
  /** First/last date this provider actually holds an assignment on. */
  firstAssignment: string | null;
  lastAssignment: string | null;
  /** FALSE when a read behind these figures failed. A 0 under an incomplete
   *  window means "could not count", not "none". */
  complete: boolean;
}

export interface CallCategoryRow {
  /** `bucket|parentCode` — the SAME key the obligation census and the grid's
   *  over-par selection use. Never folded: the neuro tier keeps a row per day
   *  it is stood (see `neuro`). */
  key: string;
  /** 'weekday' | 'friday' | 'saturday' | 'sunday'. */
  bucket: string;
  /** The PARENT call code — a split segment counts under the call it is a
   *  piece of. */
  code: string;
  /** "M–Th C1", "Sat C2". */
  label: string;
  /** 'neuro' rows are the weekend service written on two days: their taken
   *  side is per day, their OWED is stated once, in weekends, on `neuro`. */
  group: 'call' | 'neuro';
  /** The block actually stands this category. */
  stood: boolean;
  /** The block's slot weight for this category — the formula's numerator.
   *  Null when the block could not be read. */
  slotsInBlock: number | null;
  /** (slots ÷ par) × FTE, unrounded. Null when the owed side could not be
   *  computed, and on a neuro row, whose obligation is owed per WEEKEND. */
  owed: number | null;
  /** `roundedObligation(owed)` — the whole-call threshold a pickup is charged
   *  past. Obligations of 2.6 calls are met by 3; being "extra" starts at 4. */
  owedWhole: number | null;
  /** Taken WITHIN the block. This is the only column comparable to `owed`:
   *  the obligation is stated per block, so measuring it against a calendar
   *  year would report a physician two weeks into a two-month block as short
   *  on everything. */
  block: number;
  ytd: number;
  mtd: number;
  /** Call weight held past `owedWhole` in THIS category — the paid pickup.
   *  Null when the extras could not be computed. */
  extra: number | null;
}

/** The neuro tier: ONE weekend service written on two days.
 *
 * Gabriel 2026-09-22 — the TAKEN side splits Saturday and Sunday (they are two
 * separate calls, and he wants to see which he holds); the OWED side stays one
 * unit per weekend and must NOT print 0.5 against each day.
 *
 * A weekend unit is the convention rulesEngine/neuroWeekend.ts has always
 * used: a Sat+Sun pair is 1.0, a lone weekend day is 0.5. Summing the tier's
 * day slots and halving reproduces exactly that, without needing the dates.
 *
 * WHERE THE OWED NUMBER COMES FROM. The call obligation BANDS were deleted on
 * 2026-09-22, but `neuroWeekend.requirementBands` were NOT — Paoli still
 * states "1 weekend for every call taker", and the solver still places neuro
 * weekends by it. So a stated requirement wins, and the par formula is the
 * fallback for a site that states none. Both numbers are carried, with the
 * basis named, because they disagree: the formula spreads 8 neuro weekends
 * over a par of 12 and makes every taker 0.33 over, which would flag the
 * pattern's own requirement as an overage. */
export interface NeuroWeekendSummary {
  code: string;
  label: string;
  /** Weekend units the block stands (Σ neuro day-slots ÷ 2). */
  weekendsInBlock: number | null;
  /** ONE figure for the service — never 0.5 printed against each day. */
  owedWeekends: number | null;
  owedBasis: 'stated-requirement' | 'block-par-formula' | null;
  /** What the par formula alone says — (weekends in block ÷ par) × FTE. Kept
   *  beside the stated number so the two are comparable at a glance. */
  parFormulaWeekends: number | null;
  /** `roundedObligation`-free on purpose: half a weekend is a real duty (a
   *  lone neuro day), so the threshold a pickup is charged past is the nearest
   *  half, not the nearest whole. */
  owedWholeWeekends: number | null;
  takenWeekendsBlock: number;
  takenWeekendsYtd: number;
  /** The per-day rows this service is made of, in row order. */
  rowKeys: string[];
}

/** Calls picked up PAST the obligation, which is what they are paid for.
 *
 * The day type is the price, so the per-category rows are the billable truth;
 * `weekday`/`weekend` are the coarse split for a headline figure only. Friday
 * is grouped with the weekend here because it is a weekend-chain call, but it
 * keeps its own row — do not bill off the coarse number. */
export interface AdditionalCalls {
  rows: Array<{ key: string; bucket: string; code: string; label: string; calls: number }>;
  byCode: Array<{ code: string; weekday: number; weekend: number; total: number }>;
  weekday: number;
  weekend: number;
  total: number;
}

export interface CallOwedVsTaken {
  rows: CallCategoryRow[];
  totals: { owed: number | null; block: number; ytd: number; mtd: number; extra: number | null };
  /** Categories past the obligation, and by how much. Real the moment it
   *  happens, so it is always reported. Under the no-netting rule, being short
   *  elsewhere does not cancel these. */
  over: Array<{ label: string; by: number; unit: 'calls' | 'weekends' }>;
  /** Categories still owed, itemised — but ONLY once the block has ended.
   *  Mid-block, everything not yet taken is "not yet", not "short", and listing
   *  ten owed categories a fortnight in is noise that trains people to ignore
   *  the panel. See `remaining`. */
  short: Array<{ label: string; by: number; unit: 'calls' | 'weekends' }>;
  /** Calls still to come in a block that is still running. Null once it ends
   *  (then `short` carries the detail) or when the owed side is unavailable. */
  remaining: number | null;
  /** The block OWED refers to. Null when no block covers today. */
  blockLabel: string | null;
  blockStart: string | null;
  blockEnd: string | null;
  /** How the owed column was derived, so the UI can say it. Null = it was not
   *  derived at all, and every `owed` below is null rather than zero. */
  owedBasis: 'block-par-formula' | null;
  /** The formula's two constants, echoed for the UI's "why this number". */
  parLevel: number | null;
  callFte: number | null;
  inCallPool: boolean | null;
  neuro: NeuroWeekendSummary | null;
  /** Null when the extras could not be computed (no block, no owed side). */
  additional: AdditionalCalls | null;
  /** Calls that could NOT be charged to a day bucket. `derived_day_type` was
   *  backfilled 2026-09 and is non-null everywhere today, but the previous
   *  version of this file silently `continue`d past them and lost a third of
   *  the call slots. Reported, never dropped. */
  uncounted: { calls: number; weight: number; codes: string[] };
}

export interface HoursPanel {
  totalHoursYtd: number;
  averageHoursPerWeekYtd: number;
  weeksElapsed: number;
  /** Assignments, not hours — some shifts carry no times. */
  shiftsYtd: number;
  /** Shifts whose type states no hours, so they are missing from the totals.
   *  Surfaced rather than silently under-counting. */
  shiftsWithoutTimes: number;
  bySite: Array<{ siteId: string; label: string; hours: number; shifts: number }>;
  callHoursYtd: number;
  dayHoursYtd: number;
}

/** Day shifts against call shifts.
 *
 * ── WHICH COLUMN DECIDES (the trap) ────────────────────────────────────────
 * `shift_types.category` decides, NOT `counts_toward_call_burden`. The two
 * disagree in live data: Lankenau's C2 is category 'call' with
 * counts_toward_call_burden = false. Category is the right side of that
 * disagreement here because the shared obligation census (fteTarget.ts) counts
 * a call slot on category alone — so an LMC C2 slot is already in the block's
 * OWED denominator, and excluding it from the taken side would make the two
 * halves of the panel stop reconciling. The flag is reported instead
 * (`callShiftsExemptFromBurden`) so the disagreement is visible.
 *
 * ── AND WHOSE CALL IT IS ───────────────────────────────────────────────────
 * Some category='call' codes are CRNA codes (cCall, cTr7a, cTrBeep). They are
 * told apart by `shift_types.provider_group` against the PROVIDER's own
 * `providers.provider_type`; `schedule_slots.provider_group` is 'both' on
 * every live row and cannot be used for this. */
export interface ShiftMixPanel {
  callShifts: number;
  dayShifts: number;
  /** A category that is neither — counted separately rather than folded into
   *  one of the two and quietly changing what they mean. */
  otherShifts: number;
  otherCategories: string[];
  /** Call shifts whose type says it does not count toward call burden. They
   *  ARE call shifts and are counted as such; this is the audit trail. */
  callShiftsExemptFromBurden: number;
  /** Call shifts on the other discipline's codes ('both' never counts). */
  crossDisciplineCallShifts: number;
  providerType: string | null;
}

export interface AvailabilityPanel {
  /** Whole days of approved PTO taken this calendar year. */
  ptoDaysUsed: number;
  ptoWeeksUsed: number;
  ptoWeeksAllotted: number | null;
  nextPto: { start: string; end: string } | null;
  sellbackWeeks: number;
  openNoCallRequests: number;
  /** PTO requested but not yet approved — waitlisted or pending. */
  pendingPtoBlocks: number;
}

export interface ProviderOverview {
  employment: {
    status: string | null;
    fte: number | null;
    workDaysFte: number | null;
    ptoWeeks: number | null;
    partner: boolean;
    partnerTrack: boolean;
    callTaker: boolean;
    homeSiteId: string | null;
  };
  call: CallOwedVsTaken;
  hours: HoursPanel;
  shiftMix: ShiftMixPanel;
  credentialedSiteIds: string[];
  availability: AvailabilityPanel;
  /** The span every YTD/MTD figure above actually covers. */
  window: CoveredWindow;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function num(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
}

/** Hours between two clock times, wrapping past midnight. Equal times are a
 *  full 24 hours — Paoli's C3 is stored 07:00→07:00 — and treating that as
 *  zero is the crosses_midnight bug in another guise. */
export function shiftHours(start?: string | null, end?: string | null): number | null {
  if (!start || !end) return null;
  const mins = (t: string) => {
    const [h, m] = t.split(':');
    const hh = Number(h), mm = Number(m);
    return Number.isFinite(hh) && Number.isFinite(mm) ? hh * 60 + mm : NaN;
  };
  const a = mins(start), b = mins(end);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  let span = b - a;
  if (span <= 0) span += 24 * 60;
  return span / 60;
}

function daysInclusive(start: string, end: string): number {
  const a = Date.parse(`${start}T00:00:00Z`);
  const b = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
  return Math.round((b - a) / 86_400_000) + 1;
}

const splitKey = (key: string): { bucket: string; code: string } => {
  const i = key.lastIndexOf('|');
  return { bucket: key.slice(0, i), code: key.slice(i + 1) };
};

/** "weekday|C1" → "M–Th C1". Day-then-code always, whichever group the row is
 *  drawn in, so a row names its pair unambiguously — the neuro tier is named
 *  by its GROUP (see NeuroWeekendSummary), not by relabelling its days. */
export function categoryLabel(key: string): string {
  const { bucket, code } = splitKey(key);
  const day = BUCKET_LABELS[bucket as keyof typeof BUCKET_LABELS] ?? bucket;
  return `${day} ${code}`;
}

export const NEURO_LABEL = 'Neuro weekend';

/** THE per-category obligation: (this category's block slot weight ÷ par) ×
 *  FTE, for every category the block stands.
 *
 * One rung below the block total, and linear, so Σ of these IS the block total
 * obligation — which is what lets the panel show a per-category table and a
 * total that agree. The formula itself is fteTarget's, never re-implemented.
 *
 * Exported because the extras selection has to judge each category against the
 * SAME numbers the panel prints (see providerOverviewQuery). */
export function perCategoryOwed(
  bucketSlotWeight: ReadonlyMap<string, number>, parLevel: number, fte: number,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const [key, slotWeight] of bucketSlotWeight) {
    out.set(key, fteWeightedTarget(slotWeight, parLevel, fte));
  }
  return out;
}

/** Row order: the four fairness buckets in engine order, each with its codes
 *  in the Call Counts modal's order (C1/C2/C3 first, then alphabetical), and
 *  the neuro tier last — the layout the call table already uses. */
function sortRows(rows: CallCategoryRow[]): CallCategoryRow[] {
  const bucketRank = new Map(FAIRNESS_BUCKETS.map((b, i) => [b as string, i]));
  const codeRank = new Map(orderCallCodes(rows.map(r => r.code)).map((c, i) => [c, i]));
  return rows.sort((a, b) =>
    (a.group === b.group ? 0 : a.group === 'neuro' ? 1 : -1)
    || (bucketRank.get(a.bucket) ?? 99) - (bucketRank.get(b.bucket) ?? 99)
    || (codeRank.get(a.code) ?? 99) - (codeRank.get(b.code) ?? 99)
    || a.key.localeCompare(b.key));
}

// ── The build ──────────────────────────────────────────────────────────────

export function buildProviderOverview(input: {
  today: string;
  provider: OverviewProvider;
  profile: OverviewProfile | null;
  assignments: ReadonlyArray<OverviewAssignment>;
  availability: ReadonlyArray<OverviewAvailability>;
  credentials: ReadonlyArray<OverviewCredential>;
  sites: ReadonlyArray<OverviewSite>;
  /** The block-scaled owed side. Null ⇒ the UI shows dashes, never zeros. */
  owed?: OwedInputs | null;
  /** `bucket|code` → call weight held PAST the obligation, from the shared
   *  over-par machinery (fteTarget.selectOverParAssignmentIds +
   *  callCountColumns.extraCallsByBucketCode). Null ⇒ not computed. */
  extrasByCategory?: ReadonlyMap<string, number> | null;
  blockLabel?: string | null;
  /** The block's dates, so "taken" can be measured over the same window the
   *  obligation is stated for. */
  blockRange?: { start: string; end: string } | null;
  neuroCode?: string | null;
  /** The site's STATED neuro requirement for this provider, in weekend units
   *  (`rulesEngine/neuroWeekend.owedUnitsFor`). Null when the site states no
   *  requirement bands — then the neuro tier falls back to the par formula. */
  neuroOwedWeekends?: number | null;
  /** The earliest date any published schedule covers. */
  publishedFrom?: string | null;
  /** FALSE when a read behind the assignments failed — every count below is
   *  then a floor, not a total. */
  readsComplete?: boolean;
}): ProviderOverview {
  const { today, profile } = input;
  const yearStart = `${today.slice(0, 4)}-01-01`;
  const monthStart = `${today.slice(0, 7)}-01`;
  const neuro = input.neuroCode || null;
  const owedInputs = input.owed ?? null;

  // ── Call, by category ───────────────────────────────────────────────────
  // Keys are `bucket|parentCode`, the engine's own — dayTypeBucketOn charges a
  // holiday-dated call to the day of the week it lands on, and parentCallCodeOf
  // folds a split segment under the call it is a piece of.
  const ytd = new Map<string, number>();
  const mtd = new Map<string, number>();
  const blk = new Map<string, number>();
  const range = input.blockRange ?? null;
  const uncountedCodes = new Set<string>();
  let uncountedCalls = 0, uncountedWeight = 0;
  let firstAssignment: string | null = null, lastAssignment: string | null = null;

  for (const a of input.assignments) {
    if (a.date >= yearStart && a.date <= today) {
      if (!firstAssignment || a.date < firstAssignment) firstAssignment = a.date;
      if (!lastAssignment || a.date > lastAssignment) lastAssignment = a.date;
    }
    if (a.category !== 'call') continue;
    if (a.date < yearStart || a.date > today) continue;
    const w = callBurdenWeight({ call_burden_weight: a.callBurdenWeight ?? null });
    const bucket = a.dayType ? dayTypeBucketOn(a.dayType, a.date) : null;
    // A call the engine cannot bucket is REPORTED, not skipped. The old code
    // dropped these silently, and when derived_day_type was partly null that
    // quietly deleted a third of the call slots from this page.
    if (!bucket || !(FAIRNESS_BUCKETS as readonly string[]).includes(bucket)) {
      uncountedCalls++;
      uncountedWeight += w;
      uncountedCodes.add(a.code);
      continue;
    }
    const code = parentCallCodeOf(a.code, { parent_call_code: a.parentCode ?? null });
    const key = overParBucketKey(bucket, code);
    ytd.set(key, (ytd.get(key) || 0) + w);
    if (a.date >= monthStart) mtd.set(key, (mtd.get(key) || 0) + w);
    if (range && a.date >= range.start && a.date <= range.end) {
      blk.set(key, (blk.get(key) || 0) + w);
    }
  }

  // OWED, per category, straight off the block's own slate. Seeding the row
  // set from the categories the BLOCK STANDS is the point: a category with
  // nothing taken still gets a row, because a missing row reads as "this does
  // not apply to me" when the truth is "you owe this and hold none of it".
  const owedByCategory = owedInputs
    ? perCategoryOwed(owedInputs.bucketSlotWeight, owedInputs.parLevel, owedInputs.callFte)
    : null;
  const extras = input.extrasByCategory ?? null;

  const keys = new Set<string>([
    ...(owedInputs ? owedInputs.bucketSlotWeight.keys() : []),
    ...ytd.keys(),
  ]);

  const rows: CallCategoryRow[] = sortRows([...keys].map(key => {
    const { bucket, code } = splitKey(key);
    const isNeuro = !!neuro && code === neuro;
    const owed = isNeuro ? null : owedByCategory?.get(key) ?? null;
    return {
      key, bucket, code,
      label: categoryLabel(key),
      group: isNeuro ? 'neuro' as const : 'call' as const,
      stood: !!owedInputs?.bucketSlotWeight.has(key),
      slotsInBlock: owedInputs ? owedInputs.bucketSlotWeight.get(key) ?? 0 : null,
      owed: owed === null ? null : round2(owed),
      owedWhole: owed === null ? null : roundedObligation(owed),
      block: round2(blk.get(key) || 0),
      ytd: round2(ytd.get(key) || 0),
      mtd: round2(mtd.get(key) || 0),
      extra: extras ? round2(extras.get(key) || 0) : null,
    };
  }));

  // ── The neuro tier: taken per day, owed per WEEKEND ──────────────────────
  // Σ day-slots ÷ 2 IS the weekend-unit count under neuroWeekend.ts's rule
  // (a Sat+Sun pair 1.0, a lone weekend day 0.5), whichever shape the block
  // stands, so the dates are not needed to say it.
  const neuroRows = rows.filter(r => r.group === 'neuro');
  let neuroSummary: NeuroWeekendSummary | null = null;
  /** Unrounded, so the block total is not built out of display values. */
  let neuroOwedRaw: number | null = null;
  if (neuro && neuroRows.length > 0) {
    const slots = owedInputs
      ? neuroRows.reduce((s, r) => s + (r.slotsInBlock ?? 0), 0)
      : null;
    const weekendsInBlock = slots === null ? null : slots / 2;
    const parWeekends = weekendsInBlock === null || !owedInputs
      ? null
      : fteWeightedTarget(weekendsInBlock, owedInputs.parLevel, owedInputs.callFte);
    // The site's stated requirement wins where there is one; the formula is
    // the fallback. Both are null when the block could not be read at all.
    const stated = owedInputs ? input.neuroOwedWeekends ?? null : null;
    const owedWeekends = stated ?? parWeekends;
    neuroOwedRaw = owedWeekends;
    neuroSummary = {
      code: neuro,
      label: NEURO_LABEL,
      weekendsInBlock: weekendsInBlock === null ? null : round2(weekendsInBlock),
      owedWeekends: owedWeekends === null ? null : round2(owedWeekends),
      owedBasis: owedWeekends === null
        ? null
        : stated !== null ? 'stated-requirement' : 'block-par-formula',
      parFormulaWeekends: parWeekends === null ? null : round2(parWeekends),
      // Resolved to the nearest HALF, not the nearest whole: half a weekend is
      // a real duty (one neuro day), so rounding to whole weekends would both
      // invent and erase duties that exist.
      owedWholeWeekends: owedWeekends === null ? null : roundHalf(owedWeekends),
      takenWeekendsBlock: round2(neuroRows.reduce((s, r) => s + r.block, 0) / 2),
      takenWeekendsYtd: round2(neuroRows.reduce((s, r) => s + r.ytd, 0) / 2),
      rowKeys: neuroRows.map(r => r.key),
    };
  }

  // Totals in CALLS. The neuro tier contributes its weekend obligation as the
  // calls it is made of — one weekend IS the two days the block stands it on.
  // On the formula basis that is an identity (Σ slots ÷ 2 ÷ par × FTE × 2 is
  // just Σ slots ÷ par × FTE), so the total is still exactly the block's
  // par-scaled obligation; on the STATED basis it deliberately differs,
  // because the site has said what that tier is worth.
  const owedTotal = owedByCategory
    ? round2(
      [...owedByCategory].reduce(
        (s, [key, v]) => s + (neuro && splitKey(key).code === neuro ? 0 : v), 0)
      + (neuroOwedRaw ?? 0) * 2)
    : null;
  const totals = {
    owed: owedTotal,
    block: round2(rows.reduce((s, r) => s + r.block, 0)),
    ytd: round2(rows.reduce((s, r) => s + r.ytd, 0)),
    mtd: round2(rows.reduce((s, r) => s + r.mtd, 0)),
    extra: extras ? round2(rows.reduce((s, r) => s + (r.extra ?? 0), 0)) : null,
  };

  // Measured against the BLOCK, which is the window the obligation is stated
  // for. No netting: a provider can be over in one category and short in
  // another at the same time, and both are true.
  const blockEnded = !!range && today > range.end;
  const over: CallOwedVsTaken['over'] = [];
  const short: CallOwedVsTaken['short'] = [];
  for (const r of rows) {
    if (r.group === 'neuro' || r.owedWhole === null) continue;
    if (r.block > r.owedWhole + WEIGHT_EPSILON) {
      over.push({ label: r.label, by: round2(r.block - r.owedWhole), unit: 'calls' });
    } else if (blockEnded && r.block < r.owedWhole - WEIGHT_EPSILON) {
      short.push({ label: r.label, by: round2(r.owedWhole - r.block), unit: 'calls' });
    }
  }
  if (neuroSummary?.owedWholeWeekends != null) {
    const owedW = neuroSummary.owedWholeWeekends;
    const took = neuroSummary.takenWeekendsBlock;
    if (took > owedW + WEIGHT_EPSILON) {
      over.push({ label: neuroSummary.label, by: round2(took - owedW), unit: 'weekends' });
    } else if (blockEnded && took < owedW - WEIGHT_EPSILON) {
      short.push({ label: neuroSummary.label, by: round2(owedW - took), unit: 'weekends' });
    }
  }
  // Mid-block "still to come" is a TOTAL statement, so it uses the fractional
  // block obligation rather than the sum of the per-category whole-call
  // thresholds — those round up in every category and would overstate it.
  const remaining = owedTotal !== null && range && !blockEnded
    ? round2(Math.max(0, owedTotal - totals.block))
    : null;

  // ── Additional (picked-up) calls ────────────────────────────────────────
  const additional = extras ? buildAdditional(rows) : null;

  // ── Hours and the day/call shift mix ────────────────────────────────────
  const providerType = input.provider.provider_type ?? null;
  let totalHours = 0, callHours = 0, dayHours = 0, shifts = 0, noTimes = 0;
  let callShifts = 0, dayShifts = 0, otherShifts = 0;
  let burdenExempt = 0, crossDiscipline = 0;
  const otherCategories = new Set<string>();
  const siteAcc = new Map<string, { hours: number; shifts: number }>();
  for (const a of input.assignments) {
    if (a.date < yearStart || a.date > today) continue;
    // The mix counts every assignment on the schedule, including the ones the
    // hours total skips: "does not count toward hours" is a payroll-shaped
    // statement about a shift, not a claim that the shift did not happen.
    if (a.category === 'call') {
      callShifts++;
      if (a.countsTowardCallBurden === false) burdenExempt++;
      if (isCrossDiscipline(a.shiftProviderGroup, providerType)) crossDiscipline++;
    } else if (a.category === 'regular') {
      dayShifts++;
    } else {
      otherShifts++;
      if (a.category) otherCategories.add(a.category);
    }

    if (a.countsTowardHours === false) continue;
    shifts++;
    const h = shiftHours(a.startTime, a.endTime);
    if (h === null) { noTimes++; continue; }
    totalHours += h;
    if (a.category === 'call') callHours += h; else dayHours += h;
    const acc = siteAcc.get(a.siteId) || { hours: 0, shifts: 0 };
    acc.hours += h; acc.shifts++;
    siteAcc.set(a.siteId, acc);
  }
  const weeks = Math.max(1, daysInclusive(yearStart, today) / 7);
  const siteName = new Map(input.sites.map(s => [s.id, s.short_name || s.name]));

  const hours: HoursPanel = {
    totalHoursYtd: round1(totalHours),
    averageHoursPerWeekYtd: round1(totalHours / weeks),
    weeksElapsed: round1(weeks),
    shiftsYtd: shifts,
    shiftsWithoutTimes: noTimes,
    callHoursYtd: round1(callHours),
    dayHoursYtd: round1(dayHours),
    bySite: [...siteAcc.entries()]
      .map(([siteId, v]) => ({
        siteId, label: siteName.get(siteId) || 'Unknown site',
        hours: round1(v.hours), shifts: v.shifts,
      }))
      .sort((a, b) => b.hours - a.hours),
  };

  const shiftMix: ShiftMixPanel = {
    callShifts, dayShifts, otherShifts,
    otherCategories: [...otherCategories].sort(),
    callShiftsExemptFromBurden: burdenExempt,
    crossDisciplineCallShifts: crossDiscipline,
    providerType,
  };

  // ── Credentials ─────────────────────────────────────────────────────────
  const credentialed = input.credentials
    .filter(c => c.is_active !== false && c.credentialed !== false
      && !(c.effective_start_date && today < c.effective_start_date)
      && !(c.effective_end_date && today > c.effective_end_date))
    .map(c => c.site_id);

  // ── Availability ────────────────────────────────────────────────────────
  let ptoDays = 0, sellbackDays = 0, pendingBlocks = 0, openNoCall = 0;
  let nextPto: { start: string; end: string } | null = null;
  for (const a of input.availability) {
    if (a.availability_type === 'no_call_request') {
      if (isActiveNoCallRequest(a)) openNoCall++;
      continue;
    }
    if (a.availability_type === 'pto_sellback') {
      sellbackDays += daysInclusive(a.start_date, a.end_date);
      continue;
    }
    if (a.availability_type !== 'pto') continue;

    // Requested but not adjudicated. Counted separately: it blocks scheduling
    // but it has not been granted, and reporting it as used would tell someone
    // they have spent leave they may not get.
    if (a.approval_status !== 'approved') {
      if (a.approval_status !== 'denied' && a.approval_status !== 'canceled') pendingBlocks++;
      continue;
    }
    // Used = the part of the block already in the past.
    if (a.start_date <= today) {
      ptoDays += daysInclusive(a.start_date, a.end_date < today ? a.end_date : today);
    }
    if (a.end_date >= today && (!nextPto || a.start_date < nextPto.start)) {
      nextPto = { start: a.start_date, end: a.end_date };
    }
  }

  const availability: AvailabilityPanel = {
    ptoDaysUsed: ptoDays,
    ptoWeeksUsed: round1(ptoDays / 7),
    ptoWeeksAllotted: num(profile?.pto_weeks ?? null),
    nextPto,
    sellbackWeeks: round1(sellbackDays / 7),
    openNoCallRequests: openNoCall,
    pendingPtoBlocks: pendingBlocks,
  };

  return {
    employment: {
      status: profile?.employment_status ?? null,
      fte: num(profile?.fte_value ?? null),
      workDaysFte: num(profile?.work_days_fte ?? null),
      ptoWeeks: num(profile?.pto_weeks ?? null),
      partner: !!profile?.is_shareholder,
      partnerTrack: !!profile?.is_partner_track,
      callTaker: !!(profile?.call_taker || profile?.partial_call_taker),
      homeSiteId: profile?.home_site_id ?? null,
    },
    call: {
      rows, totals, over, short, remaining,
      blockLabel: input.blockLabel ?? null,
      blockStart: range?.start ?? null,
      blockEnd: range?.end ?? null,
      owedBasis: owedInputs ? 'block-par-formula' : null,
      parLevel: owedInputs?.parLevel ?? null,
      callFte: owedInputs?.callFte ?? null,
      inCallPool: owedInputs ? owedInputs.inCallPool : null,
      neuro: neuroSummary,
      additional,
      uncounted: {
        calls: uncountedCalls,
        weight: round2(uncountedWeight),
        codes: [...uncountedCodes].sort(),
      },
    },
    hours,
    shiftMix,
    credentialedSiteIds: credentialed,
    availability,
    window: {
      requestedStart: yearStart,
      requestedEnd: today,
      publishedFrom: input.publishedFrom ?? null,
      firstAssignment,
      lastAssignment,
      complete: input.readsComplete !== false,
    },
  };
}

/** The weekday/weekend × code roll-up over the per-category extras. */
function buildAdditional(rows: ReadonlyArray<CallCategoryRow>): AdditionalCalls {
  const detail = rows
    .filter(r => (r.extra ?? 0) > WEIGHT_EPSILON)
    .map(r => ({ key: r.key, bucket: r.bucket, code: r.code, label: r.label, calls: r.extra! }));
  const byCode = new Map<string, { code: string; weekday: number; weekend: number; total: number }>();
  let weekday = 0, weekend = 0;
  for (const d of detail) {
    let entry = byCode.get(d.code);
    if (!entry) { entry = { code: d.code, weekday: 0, weekend: 0, total: 0 }; byCode.set(d.code, entry); }
    if (d.bucket === 'weekday') { entry.weekday += d.calls; weekday += d.calls; }
    else { entry.weekend += d.calls; weekend += d.calls; }
    entry.total += d.calls;
  }
  const order = orderCallCodes([...byCode.keys()]);
  return {
    rows: detail,
    byCode: order.map(c => {
      const e = byCode.get(c)!;
      return { code: c, weekday: round2(e.weekday), weekend: round2(e.weekend), total: round2(e.total) };
    }),
    weekday: round2(weekday),
    weekend: round2(weekend),
    total: round2(weekday + weekend),
  };
}

/** A CRNA code held by a physician, or the reverse. 'both' and an unstated
 *  group are never cross-discipline — only a positive disagreement counts. */
function isCrossDiscipline(
  shiftGroup: string | null | undefined, providerType: string | null,
): boolean {
  if (!shiftGroup || shiftGroup === 'both' || !providerType) return false;
  if (shiftGroup === 'crna') return providerType !== 'crna';
  if (shiftGroup === 'physician') return providerType === 'crna';
  return false;
}

function round1(n: number): number { return Math.round(n * 10) / 10; }
function round2(n: number): number { return Math.round(n * 100) / 100; }
/** To the nearest half — the finest weekend duty that exists. */
function roundHalf(n: number): number { return Math.round(n * 2) / 2; }

/** Whether this person is blocked from work on a date — the engine's own
 *  predicate, re-exported so the overview and the generator can never disagree
 *  about whether somebody is off. */
export function isOffOn(
  entries: ReadonlyArray<OverviewAvailability>, date: string,
): boolean {
  return isDateBlocked(entries, date);
}

/** Does this entry block scheduling at all? Used to separate "off" rows from
 *  soft requests in the panel. */
export { isBlockingAvailability };
