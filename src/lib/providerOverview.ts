/* ───────────────────────────────────────────────────────────────────────────
 * The clinician overview — one screen that answers "where do I stand".
 *
 * This is what a physician sees when they sign in and what back office sees
 * when they open somebody's record. Five panels:
 *
 *   employment        what they are contracted for
 *   call owed vs took the block's stated obligation against what they hold
 *   hours             time on the schedule, and how it splits by site
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
 * ── AND THE OWED SIDE IS PER BLOCK ─────────────────────────────────────────
 * Obligations are stated per block (16 calls for a 1.0 FTE at Paoli), not per
 * year. So OWED is the current block's number while TAKEN is counted over a
 * calendar window. The two are different denominators and the UI has to name
 * them, or someone reads "owed 16, taken 40 this year" as being 24 over.
 * ─────────────────────────────────────────────────────────────────────────── */

import { overParBucketKey } from './fteTarget';
import { callBurdenWeight, parentCallCodeOf } from './callBurden';
import { dayTypeBucketOn, isDateBlocked, isBlockingAvailability, isActiveNoCallRequest } from './rulesEngine/shared';
import { BUCKET_LABELS } from './callCountColumns';

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

// ── Outputs ────────────────────────────────────────────────────────────────

export interface CallCategoryRow {
  key: string;
  /** "M–Th C1", "Sat C2", "Neuro weekend". */
  label: string;
  /** The block's stated obligation. Null when the site states no bands for
   *  this provider — then there is no owed number, and the UI shows a dash
   *  rather than a zero. */
  owed: number | null;
  /** Taken WITHIN the block. This is the only column comparable to `owed`:
   *  the obligation is stated per block, so measuring it against a calendar
   *  year would report a physician two weeks into a two-month block as short
   *  on everything. */
  block: number;
  ytd: number;
  mtd: number;
}

export interface CallOwedVsTaken {
  rows: CallCategoryRow[];
  totals: { owed: number | null; block: number; ytd: number; mtd: number };
  /** Categories past the stated count, and by how much. Real the moment it
   *  happens, so it is always reported. Under the no-netting rule, being short
   *  elsewhere does not cancel these. */
  over: Array<{ label: string; by: number }>;
  /** Categories still owed, itemised — but ONLY once the block has ended.
   *  Mid-block, everything not yet taken is "not yet", not "short", and listing
   *  ten owed categories a fortnight in is noise that trains people to ignore
   *  the panel. See `remaining`. */
  short: Array<{ label: string; by: number }>;
  /** Calls still to come in a block that is still running. Null once it ends
   *  (then `short` carries the detail) or when the site states no bands. */
  remaining: number | null;
  /** The block OWED refers to. Null when no block covers today. */
  blockLabel: string | null;
  blockEnd: string | null;
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
  credentialedSiteIds: string[];
  availability: AvailabilityPanel;
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

/** "weekday|C1" → "M–Th C1". The neuro tier is named as the weekend service it
 *  is rather than appearing twice as Sat C3 and Sun C3. */
export function categoryLabel(key: string, neuroCode?: string | null): string {
  const i = key.lastIndexOf('|');
  const bucket = key.slice(0, i);
  const code = key.slice(i + 1);
  // Both the folded key ('neuro|C3') and a raw bucket key land here.
  if (neuroCode && code === neuroCode) return 'Neuro weekend';
  const day = BUCKET_LABELS[bucket as keyof typeof BUCKET_LABELS] ?? bucket;
  return `${day} ${code}`;
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
  /** Stated per-category obligation for the CURRENT block, from the shared
   *  census (fteTarget statedBucketsFor). Null when the site states no bands
   *  for this provider — the UI then shows dashes, never zeros. */
  owedByCategory: ReadonlyMap<string, number> | null;
  blockLabel?: string | null;
  /** The block's dates, so "taken" can be measured over the same window the
   *  obligation is stated for. */
  blockRange?: { start: string; end: string } | null;
  neuroCode?: string | null;
}): ProviderOverview {
  const { today, profile } = input;
  const yearStart = `${today.slice(0, 4)}-01-01`;
  const monthStart = `${today.slice(0, 7)}-01`;

  // ── Call, by category ───────────────────────────────────────────────────
  // The neuro tier is ONE weekend service written on two days. Keying it by
  // its code alone folds saturday|C3 and sunday|C3 into a single row — without
  // this the table prints "Neuro weekend" twice, which reads as two different
  // obligations.
  const neuro = input.neuroCode;
  const fold = (bucket: string, code: string) =>
    (neuro && code === neuro) ? `neuro|${code}` : overParBucketKey(bucket, code);

  const ytd = new Map<string, number>();
  const mtd = new Map<string, number>();
  const blk = new Map<string, number>();
  const range = input.blockRange ?? null;
  for (const a of input.assignments) {
    if (a.category !== 'call') continue;
    if (a.date < yearStart || a.date > today) continue;
    const bucket = a.dayType ? dayTypeBucketOn(a.dayType, a.date) : null;
    if (!bucket) continue;
    const code = parentCallCodeOf(a.code, { parent_call_code: a.parentCode ?? null });
    const key = fold(bucket, code);
    const w = callBurdenWeight({ call_burden_weight: a.callBurdenWeight ?? null });
    ytd.set(key, (ytd.get(key) || 0) + w);
    if (a.date >= monthStart) mtd.set(key, (mtd.get(key) || 0) + w);
    if (range && a.date >= range.start && a.date <= range.end) {
      blk.set(key, (blk.get(key) || 0) + w);
    }
  }

  // The owed map is keyed by bucket; fold it the same way so the two sides
  // meet on one key.
  const owedFolded = new Map<string, number>();
  for (const [key, n] of input.owedByCategory ?? []) {
    const i = key.lastIndexOf('|');
    const folded = fold(key.slice(0, i), key.slice(i + 1));
    owedFolded.set(folded, (owedFolded.get(folded) || 0) + n);
  }

  // Every category with an obligation OR a holding — a stated category nobody
  // filled is a real shortfall and must not vanish from the table.
  const keys = new Set<string>([...ytd.keys(), ...owedFolded.keys()]);
  const rows: CallCategoryRow[] = [...keys].map(key => ({
    key,
    label: categoryLabel(key, neuro),
    owed: input.owedByCategory ? (owedFolded.get(key) ?? 0) : null,
    block: round2(blk.get(key) || 0),
    ytd: round2(ytd.get(key) || 0),
    mtd: round2(mtd.get(key) || 0),
  })).sort((a, b) => a.label.localeCompare(b.label));

  const totals = {
    owed: input.owedByCategory
      ? round2([...owedFolded.values()].reduce((s, v) => s + v, 0))
      : null,
    block: round2(rows.reduce((s, r) => s + r.block, 0)),
    ytd: round2(rows.reduce((s, r) => s + r.ytd, 0)),
    mtd: round2(rows.reduce((s, r) => s + r.mtd, 0)),
  };

  // Measured against the BLOCK, which is the window the obligation is stated
  // for. No netting: a provider can be over in one category and short in
  // another at the same time, and both are true.
  const blockEnded = !!range && today > range.end;
  const over: Array<{ label: string; by: number }> = [];
  const short: Array<{ label: string; by: number }> = [];
  let remaining: number | null = null;
  for (const r of rows) {
    if (r.owed === null) continue;
    if (r.block > r.owed) over.push({ label: r.label, by: round2(r.block - r.owed) });
    else if (r.block < r.owed && blockEnded) short.push({ label: r.label, by: round2(r.owed - r.block) });
  }
  if (input.owedByCategory && range && !blockEnded) {
    remaining = round2(Math.max(0, (totals.owed ?? 0) - totals.block));
  }

  // ── Hours ───────────────────────────────────────────────────────────────
  let totalHours = 0, callHours = 0, dayHours = 0, shifts = 0, noTimes = 0;
  const siteAcc = new Map<string, { hours: number; shifts: number }>();
  for (const a of input.assignments) {
    if (a.date < yearStart || a.date > today) continue;
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
      blockEnd: range?.end ?? null,
    },
    hours,
    credentialedSiteIds: credentialed,
    availability,
  };
}

function round1(n: number): number { return Math.round(n * 10) / 10; }
function round2(n: number): number { return Math.round(n * 100) / 100; }

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
