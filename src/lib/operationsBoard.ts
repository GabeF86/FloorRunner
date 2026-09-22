/* ───────────────────────────────────────────────────────────────────────────
 * THE OPERATIONS BOARD — the staffing big picture, for back office
 *
 * Three questions, asked every morning, currently answered by phone calls:
 *
 *   1. Which sites are short this week, and by how much?   coverageWeek()
 *   2. Who is on the bench and actually free today?        perDiemBench()
 *   3. Who is physically on the floor at each site?        siteDayBoard()
 *
 * Plus the one-line roster summary above them (rosterSummary).
 *
 * ── WHAT THIS MODULE WILL NOT DO ───────────────────────────────────────────
 * It never fills a number it does not have. A site with no schedule reads
 * "no schedule", not 0/0 and not a guess from the templates; a site closed on
 * Sunday reads "closed"; a provider group nobody schedules gets no row. The
 * whole point of the page is to show back office where coverage actually
 * stands, and a plausible-looking zero is worse than an honest blank — it is
 * the failures-render-as-zeros trap that has bitten this codebase before.
 *
 * ── THE SCHEDULE HOLDS PEOPLE AND STATUSES, NOT ROOMS ──────────────────────
 * FloorRunner's schedule says WHO is working and in what capacity — first
 * call, second call, a 7-3, post-call — and nothing about which anaesthetising
 * site they stand in. Room assignment happens on the day, on the floor.
 *
 * So AVAILABLE is a headcount by capacity, never a count of rooms covered, and
 * a slot with nobody in it is an unfilled POSITION rather than an empty room.
 * The NEEDED side is the only half that knows about rooms, and it comes from
 * outside: a scheduler reads the OR schedule in Epic, counts the anaesthetising
 * sites running, and enters how many bodies that takes. Demand knows rooms;
 * supply knows people; this module joins the two and must not pretend either
 * side knows the other's business.
 *
 * ── AVAILABILITY IS THE ENGINE'S, NOT A SECOND OPINION ─────────────────────
 * "Free today" means the same four checks the generator runs before it assigns
 * anyone: credentialed at that site, not blocked by PTO/availability, not
 * already booked somewhere that day, and not owed a post-call rest. The PTO
 * check routes through rulesEngine/shared isDateBlocked — clinical invariant 2
 * (PENDING blocks) and the sell-back date override both live in there, and a
 * second copy here would eventually disagree with the engine about who is
 * free. If this module ever says someone is available and the engine refuses
 * to place them, that is a bug in one of the two, and there is exactly one
 * predicate to go and look at.
 * ─────────────────────────────────────────────────────────────────────────── */

import { isDateBlocked, dayOfWeekUTC, addDays } from './rulesEngine/shared';
import { demandFor, type ResolvedDemand, type WeekendCall } from './staffingDemand';

// ── Row shapes ─────────────────────────────────────────────────────────────
// Deliberately loose (`?: | null`) and free of DB types: every field here is
// one PostgREST select away, and the tests build them by hand.

export interface OpsShiftType {
  code: string;
  name?: string | null;
  category: string;
  /** 'physician' | 'crna' | 'both' — who is allowed to stand this shift. */
  provider_group?: string | null;
  /** 0 = first call, 1 = second, 2 = neuro. Null for day shifts. */
  call_rank?: number | null;
  start_time?: string | null;
  end_time?: string | null;
  requires_post_call_rule?: boolean | null;
}

export interface OpsSlotRow {
  site_id: string;
  slot_date: string;
  required_count?: number | null;
  shift_types: OpsShiftType | null;
  assignments?: ReadonlyArray<{ provider_id?: string | null }> | null;
}

export interface OpsProviderRow {
  id: string;
  provider_type?: string | null;
  /** When they joined. A per diem who started in June must not be judged on a
   *  January-to-date average — see monthsWorkedThisYear. */
  start_date?: string | null;
  /** The SCHEDULE CODE (CHOD, GONJ, D.Gorelick) — this group's grid shorthand,
   *  not a name. Fine on a grid cell, useless on a list back office is reading
   *  to decide who to phone. */
  short_display_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
}

/** "D. Gorelick" where the roster has real names, falling back to the schedule
 *  code where it does not. Both forms are live in this roster. */
export function providerName(p: OpsProviderRow): string {
  const last = p.last_name?.trim();
  if (last) {
    const initial = p.first_name?.trim()?.[0];
    return initial ? `${initial}. ${last}` : last;
  }
  return p.short_display_name?.trim() || '—';
}

export interface OpsSiteRow {
  id: string;
  name: string;
  short_name?: string | null;
  /** Two shapes live in this column — see siteOpenDays. */
  operational_days?: unknown;
}

export interface OpsAvailRow {
  provider_id: string;
  availability_type: string;
  approval_status: string;
  start_date: string;
  end_date: string;
}

export interface OpsCredentialRow {
  provider_id: string;
  site_id: string;
  is_active?: boolean | null;
  credentialed?: boolean | null;
  effective_start_date?: string | null;
  effective_end_date?: string | null;
  /** Cleared to take call AT THIS SITE. A per-site VETO, not an invitation:
   *  the engine checks it (eligibility.ts, evaluators.ts, slotCandidates.ts)
   *  but it does not pull anyone into the call pool — see `call_taker`. */
  can_take_call?: boolean | null;
}

export interface OpsProfileRow {
  provider_id: string;
  employment_status?: string | null;
  home_site_id?: string | null;
  /** Per-diem contracted minimum shifts per month. NULL = no minimum stated,
   *  which is NOT zero — most of the roster has no such obligation, and a zero
   *  would mean "required to work none". Nobody with a null is ever flagged. */
  min_monthly_shifts?: number | string | null;
  /** Takes call as a matter of ROLE. This is the flag that puts somebody in the
   *  call pool at all (genContext.ts), which is why it cannot be read off the
   *  site credential alone. */
  call_taker?: boolean | null;
  partial_call_taker?: boolean | null;
}

/** The two staffing groups demand is stated in. There is no 'either' any more:
 *  once NEEDED is an explicit MD and CRNA count, an unfilled slot has nothing
 *  to contribute — availability is people, and an unfilled position is not a
 *  person. */
export type CoverageGroup = 'physician' | 'crna';

export const GROUP_LABEL: Record<CoverageGroup, string> = {
  physician: 'MD',
  crna: 'CRNA',
};

// ── Site open days ─────────────────────────────────────────────────────────

/**
 * Which days of the week a site runs, as a 7-slot array indexed 0 = Sunday to
 * match dayOfWeekUTC.
 *
 * TWO SHAPES ARE LIVE in sites.operational_days and both must be read:
 *
 *   object  {"monday": true, …, "sunday": true, "0": "Mon", "1": "Tue", …}
 *   array   ["Mon","Tue","Wed","Thu","Fri"]
 *
 * The object form carries junk NUMERIC keys beside the real named booleans —
 * ignored here, because "0": "Mon" is a label, not a flag, and treating it as
 * one would mark Sunday open at every site that has it. sites/[id] only ever
 * read the object form, so the six array-shaped sites have been rendering as
 * closed-every-day there; this parser is the shared fix.
 *
 * A missing/unrecognised value means OPEN ALL WEEK, deliberately: "not
 * configured" is not "closed", and printing CLOSED over a real Sunday would
 * hide a genuine gap. An unscheduled open day reads "no schedule" instead,
 * which is true either way.
 */
export function siteOpenDays(raw: unknown): boolean[] {
  const NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const open = [true, true, true, true, true, true, true];

  if (Array.isArray(raw)) {
    if (raw.length === 0) return open;
    const listed = new Set(
      raw.filter((d): d is string => typeof d === 'string')
        .map(d => d.trim().slice(0, 3).toLowerCase()),
    );
    if (listed.size === 0) return open;
    return NAMES.map(n => listed.has(n.slice(0, 3)));
  }

  if (raw && typeof raw === 'object') {
    const rec = raw as Record<string, unknown>;
    // Only NAMED boolean keys count. A shape with none of them (all numeric
    // junk) falls through to open-all-week rather than closing the site.
    let sawNamed = false;
    const out = NAMES.map(n => {
      const v = rec[n];
      if (typeof v === 'boolean') { sawNamed = true; return v; }
      return true;
    });
    return sawNamed ? out : open;
  }

  return open;
}

/**
 * Is this shift part of the day's FLOOR COVERAGE?
 *
 * The overnight call doctor is on the schedule but is not on the floor during
 * the day: Paoli's
 * C1 runs 15:00 → 07:00, so counting them among Friday's available staff
 * overstates the floor by one and hides a genuine gap. The schedule grid has
 * excluded weekday first call from its headline count since it was built; the
 * staffing board was not, which is why Paoli's Friday read 9 when 8 people
 * were actually there during the day.
 *
 * Stated as a TIME rather than as `code === 'C1'`, which is what the grid
 * does. The code test only works at a site whose first call happens to be
 * called C1; the time test works at every site, and it also catches the
 * evening and night split segments (C1E8 at 15:00, C1N12 at 19:00) that the
 * code test misses entirely.
 *
 * WEEKENDS COUNT EVERYTHING. There is no day roster on a Saturday — the call
 * team IS the coverage, and Paoli's weekend requirement of three is exactly
 * C1, C2 and C3. Excluding C1 there would report every weekend as a body
 * short.
 *
 * A shift with no start time counts, deliberately: several imported types
 * state none, and dropping them would silently under-report a whole site.
 */
export function countsAsFloorCoverage(
  shift: { start_time?: string | null; category?: string | null } | null,
  isWeekend: boolean,
): boolean {
  if (!shift) return false;
  if (isWeekend) return true;
  return startsOnTheFloor(shift.start_time);
}

/** The hour the OR day ends here — 7-3 finishes then, and anything starting at
 *  or after it arrives as the floor empties. One constant because the coverage
 *  matrix and the staffing calculator both split the day on it, and two copies
 *  of 15 would eventually disagree. */
export const FLOOR_DAY_ENDS_HOUR = 15;

/** Does a shift starting at this time put somebody on the daytime floor?
 *  An absent or unparseable start counts, deliberately: several imported types
 *  state none, and dropping them would silently under-report a whole site. */
export function startsOnTheFloor(startTime?: string | null): boolean {
  if (!startTime) return true;
  const hour = Number(startTime.slice(0, 2));
  if (!Number.isFinite(hour)) return true;
  return hour < FLOOR_DAY_ENDS_HOUR;
}

// ── 1. Available vs needed, by site and day ────────────────────────────────

export type CellStatus =
  | 'covered'    // supply meets demand exactly
  | 'surplus'    // MORE than demand — the pool a transfer draws from
  | 'short'      // one under
  | 'gap'        // two or more under
  | 'closed'
  | 'unstated';

export interface CoverageGroupCount {
  group: CoverageGroup;
  /** People actually on the schedule that day, by their own provider type. */
  available: number;
  /** From the demand table. NULL = nobody has stated what this day needs, and
   *  the cell reads N/A. Never defaulted to zero: a zero would paint an
   *  uncounted day green. */
  needed: number | null;
}

export interface CoverageCell {
  date: string;
  status: CellStatus;
  groups: CoverageGroupCount[];
  /** Σ over groups of max(0, needed − available), counting only groups whose
   *  need has actually been stated. */
  shortBy: number;
  /** Σ over groups of max(0, available − needed). Staff sharing is daily here,
   *  so surplus is not a curiosity — it is the supply side of a transfer, and
   *  a board that paints it plain green hides the half of the picture that
   *  makes a move possible. */
  surplusBy: number;
  /** Which row the needed figures came from, so the board can show whether a
   *  scheduler counted it or the calculator did. Null when unstated. */
  demandSource: ResolvedDemand['source'] | null;
}

export interface CoverageRow {
  siteId: string;
  siteName: string;
  shortName: string;
  cells: CoverageCell[];
  /** Σ shortBy across the week — the row's headline. */
  shortBy: number;
}

/** One short is "short"; two or more is a "gap". The split exists because a
 *  single unfilled position is a phone call and two is a staffing problem, and
 *  back
 *  office triages them differently. */
/** Shortfall outranks surplus: a cell that is two MDs short and one CRNA spare
 *  is a problem, not an opportunity, and must not read as one. */
function statusFor(shortBy: number, surplusBy: number): CellStatus {
  if (shortBy === 1) return 'short';
  if (shortBy > 1) return 'gap';
  return surplusBy > 0 ? 'surplus' : 'covered';
}

/**
 * The week matrix: every site × every date, filled vs required.
 *
 * `required` is the slot census (required_count, defaulting to 1) — the
 * positions the schedule itself says exist. It is NOT read from shift
 * templates: a template says what a site USUALLY needs, and a matrix built on
 * it would report coverage for days nobody has scheduled yet.
 */
export function coverageWeek(input: {
  sites: ReadonlyArray<OpsSiteRow>;
  slots: ReadonlyArray<OpsSlotRow>;
  providers: ReadonlyArray<OpsProviderRow>;
  dates: ReadonlyArray<string>;
  /** Resolved demand by `demandKey(siteId, date)` — see staffingDemand. An
   *  absent entry is "not stated", which renders N/A. */
  demand: ReadonlyMap<string, ResolvedDemand>;
  /** Each site's standing weekend call complement, applied on Sat/Sun when
   *  nothing more specific has been stated. */
  weekendCall?: ReadonlyMap<string, WeekendCall>;
}): CoverageRow[] {
  const typeOf = new Map<string, string>();
  for (const p of input.providers) typeOf.set(p.id, p.provider_type || '');

  // AVAILABLE is people, counted by the provider type of whoever is standing
  // the slot — not by what the shift type permits. A 'both' shift worked by a
  // CRNA is a CRNA on the floor, whatever the type allows; and an UNFILLED
  // position contributes nothing at all, because the question is how many
  // bodies are there.
  const bySiteDate = new Map<string, Map<string, { physician: number; crna: number }>>();
  for (const slot of input.slots) {
    if (!slot.shift_types) continue;
    // The overnight call doctor is on the schedule but not on the floor —
    // see countsAsFloorCoverage.
    const dow = dayOfWeekUTC(slot.slot_date);
    if (!countsAsFloorCoverage(slot.shift_types, dow === 0 || dow === 6)) continue;
    for (const a of slot.assignments || []) {
      if (!a?.provider_id) continue;
      let byDate = bySiteDate.get(slot.site_id);
      if (!byDate) { byDate = new Map(); bySiteDate.set(slot.site_id, byDate); }
      let counts = byDate.get(slot.slot_date);
      if (!counts) { counts = { physician: 0, crna: 0 }; byDate.set(slot.slot_date, counts); }
      if (typeOf.get(a.provider_id) === 'crna') counts.crna++; else counts.physician++;
    }
  }

  return input.sites.map(site => {
    const open = siteOpenDays(site.operational_days);
    const byDate = bySiteDate.get(site.id);
    let rowShort = 0;

    const cells = input.dates.map<CoverageCell>(date => {
      const staffed = byDate?.get(date) ?? { physician: 0, crna: 0 };
      const dow = dayOfWeekUTC(date);

      // Closed: a site that does not run this weekday is neither short nor
      // awaiting a count, and must not pick up a weekend default.
      //
      // BUT NOT IF SOMEBODY IS ACTUALLY THERE. operational_days is config and
      // config goes stale — Riddle was stored Mon–Fri while taking call every
      // weekend of the imported block, so an unconditional close hid nine real
      // staffed days behind the word CLOSED. Real people on the floor outrank
      // a column that says they cannot be.
      const anyStaffed = staffed.physician > 0 || staffed.crna > 0;
      if (!open[dow] && !anyStaffed) {
        return { date, status: 'closed', groups: [], shortBy: 0, surplusBy: 0, demandSource: null };
      }

      // manual > calculated > the site's standing weekend call complement.
      const need = demandFor({
        siteId: site.id, date, dayOfWeek: dow,
        resolved: input.demand, weekendCall: input.weekendCall,
      });

      // Nobody has said what this day needs. The people on it are still
      // reported — the tooltip and the entry grid both want them — but the
      // cell cannot be graded, so it reads N/A rather than green.
      if (!need || (need.md === null && need.crna === null)) {
        return {
          date,
          status: 'unstated',
          groups: [
            { group: 'physician', available: staffed.physician, needed: null },
            { group: 'crna', available: staffed.crna, needed: null },
          ],
          shortBy: 0,
          surplusBy: 0,
          demandSource: null,
        };
      }

      const groups = ([
        { group: 'physician', available: staffed.physician, needed: need.md },
        { group: 'crna', available: staffed.crna, needed: need.crna },
      ] as CoverageGroupCount[]).filter(g => g.needed !== null || g.available > 0);

      let shortBy = 0;
      let surplusBy = 0;
      for (const g of groups) {
        if (g.needed === null) continue;     // that half is simply not stated
        shortBy += Math.max(0, g.needed - g.available);
        surplusBy += Math.max(0, g.available - g.needed);
      }
      rowShort += shortBy;
      return {
        date, groups, shortBy, surplusBy,
        status: statusFor(shortBy, surplusBy),
        demandSource: need.source,
      };
    });

    return {
      siteId: site.id,
      siteName: site.name,
      shortName: site.short_name || site.name.slice(0, 4).toUpperCase(),
      cells,
      shortBy: rowShort,
    };
  });
}

// ── 2. The bench ───────────────────────────────────────────────────────────

export type BenchStatus = 'available' | 'booked' | 'off';

export interface BenchRow {
  providerId: string;
  name: string;
  /** The schedule code, shown beside the name where the two differ. */
  code: string;
  providerType: string;
  status: BenchStatus;
  /** Plain English, e.g. "booked at Paoli" or "PTO". */
  detail: string;
  /** Shifts worked this calendar year, from published schedules only. */
  shiftsYtd: number;
  /** Those shifts per month, over the months they have actually been here. */
  avgShiftsPerMonth: number;
  /** Their contracted minimum, or null when none is stated. */
  minMonthlyShifts: number | null;
  /** Running below the stated minimum. False whenever no minimum is stated,
   *  and false in the first month, when the average is not yet meaningful. */
  belowMinimum: boolean;
  /** Short names of the sites they are credentialed at, in site order. */
  sites: string[];
  /** The same sites as ids — what the board filters on. Names are for reading;
   *  filtering on them would break the moment two sites shared a short name. */
  siteIds: string[];
  /** Which discipline they are counted as. Matches how the coverage matrix
   *  splits the floor: CRNA, or physician for everything else. */
  group: CoverageGroup;
  /** The sites where the engine would actually let them hold a CALL shift —
   *  a live credential there, `can_take_call` on it, AND the call-taker role.
   *  A subset of `siteIds`, and empty whenever the role flag is off. */
  callSiteIds: string[];
  /** Can take call somewhere. `callSiteIds.length > 0`, named because that is
   *  the question being asked, not the implementation of it. */
  canTakeCall: boolean;
}

/**
 * Would the engine let this provider hold a call shift at this site?
 *
 * The answer is a CONJUNCTION of two facts kept in two tables, and reading
 * either one alone gives a confidently wrong answer:
 *
 *   employment profile  `call_taker` / `partial_call_taker` — the ROLE. This is
 *                       what puts somebody in the call pool (genContext.ts).
 *                       Defaults FALSE.
 *   site credential     `can_take_call` — per-site CLEARANCE. A hard gate that
 *                       can only veto; it never pulls anyone in (the comment at
 *                       genContext.ts is explicit about this). Defaults TRUE.
 *
 * Because the defaults point in opposite directions, the single-field readings
 * fail in opposite directions too: trusting the credential alone marks almost
 * everybody call-capable, trusting the role alone marks almost nobody. Only the
 * conjunction matches what the generator will actually permit, and the bench
 * must agree with the generator — a name offered here and then refused by the
 * engine is worse than no suggestion at all.
 */
function engineAllowsCall(profile: OpsProfileRow, cred: OpsCredentialRow): boolean {
  if (!(profile.call_taker || profile.partial_call_taker)) return false;
  return cred.can_take_call !== false;
}

/**
 * The months a provider's shift average should be measured over.
 *
 * The latest of three dates, to today:
 *
 *   1 January        the year under measurement
 *   their start date a per diem who joined in June had five months during
 *                    which nothing was expected of them, and dividing by nine
 *                    would report them as failing an obligation they never had
 *   dataFrom         the earliest date FloorRunner actually holds a published
 *                    schedule for
 *
 * THE THIRD ONE IS THE ONE THAT MATTERS RIGHT NOW. The system holds September
 * onwards; everyone worked through the spring, but those months are not in the
 * database. Dividing by the whole year would put the entire bench at 0.2 a
 * month and flag all sixteen of them — measuring our data gap and calling it
 * their performance. The average must only ever cover the period we can see.
 *
 * Fractional and never zero for a valid window: somebody who started yesterday
 * gets a small positive number rather than a division by zero.
 */
export function monthsWorkedThisYear(
  today: string,
  startDate?: string | null,
  dataFrom?: string | null,
): number {
  const yearStart = `${today.slice(0, 4)}-01-01`;
  let from = yearStart;
  if (startDate && startDate > from) from = startDate;
  if (dataFrom && dataFrom > from) from = dataFrom;
  if (from > today) return 0;
  const days = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
  // 30.44 = the average month. Calendar months would make January and February
  // score differently for the same work.
  return Math.max(days / 30.44, 1 / 30.44);
}

export interface BenchSummary {
  /** The callable bench: per diems with at least one live site credential.
   *  Somebody credentialed nowhere cannot be phoned in today, and
   *  listing them by name buries the handful who can — see `uncredentialed`. */
  rows: BenchRow[];
  /** Every per diem on the roster, credentialed or not. */
  onRoster: number;
  /** On the roster but credentialed at no site — a count, not a list. It is a
   *  credentialing backlog, which is a different job on a different timescale
   *  from filling a shift this morning. */
  uncredentialed: number;
  sitesCovered: number;
  freeToday: number;
  /** How many on the bench are running under their contracted minimum. */
  belowMinimum: number;
  /** Roster and credentialing split by discipline, counted over EVERY per diem
   *  rather than the listed ones.
   *
   *  The bench lists only credentialed per diems, so a discipline can be a
   *  hundred strong on the roster and absent from the list entirely. A filter
   *  chip reading 0 then has two completely different meanings — "none of them
   *  is free today" and "none of them has ever been credentialed" — and only
   *  the second is actionable. These counts let the panel say which. */
  byGroup: Record<CoverageGroup, { onRoster: number; uncredentialed: number; free: number }>;
  /** Listed per diems the engine would let take call somewhere today. */
  callCapable: number;
  /** The window the averages actually cover, so the panel can say so rather
   *  than implying a full year. */
  averageFrom: string;
  averageMonths: number;
}

/** Is this credential row usable on this date? */
function credentialLive(c: OpsCredentialRow, date: string): boolean {
  if (c.is_active === false) return false;
  if (c.credentialed === false) return false;
  if (c.effective_start_date && date < c.effective_start_date) return false;
  if (c.effective_end_date && date > c.effective_end_date) return false;
  return true;
}

/**
 * Who on the per-diem bench is genuinely reachable for a given date.
 *
 * The four checks, in the order the engine applies them — the first one that
 * fails is the one reported, because "PTO" and "already booked at Riddle" send
 * back office to different next steps.
 *
 * POST-CALL is included in `booked`: a provider owed a post-call rest is not
 * free even though their calendar looks empty that day (invariant 1). It is
 * detected off the PRIOR day's assignments, so the caller must pass slots
 * covering date − 1.
 */
export function perDiemBench(input: {
  date: string;
  providers: ReadonlyArray<OpsProviderRow>;
  profiles: ReadonlyArray<OpsProfileRow>;
  credentials: ReadonlyArray<OpsCredentialRow>;
  availability: ReadonlyArray<OpsAvailRow>;
  /** Slots for `date` AND the day before (for the post-call check). */
  slots: ReadonlyArray<OpsSlotRow>;
  sites: ReadonlyArray<OpsSiteRow>;
  /** Which employment statuses count as bench. Defaults to per diem only. */
  statuses?: ReadonlyArray<string>;
  /** provider id → shifts worked this calendar year, published only. Absent
   *  means zero; the caller counts them in one pass rather than this module
   *  reaching for a year of slots it does not otherwise need. */
  shiftsYtd?: ReadonlyMap<string, number>;
  /** The earliest date in the year FloorRunner holds a published schedule for.
   *  The average is measured from here, never from 1 January, so a data gap is
   *  not reported as somebody working too little. */
  scheduleDataFrom?: string | null;
}): BenchSummary {
  const bench = new Set((input.statuses ?? ['per_diem']).map(s => s));
  const siteName = new Map<string, string>();
  for (const s of input.sites) siteName.set(s.id, s.short_name || s.name);

  const profileOf = new Map<string, OpsProfileRow>();
  for (const p of input.profiles) profileOf.set(p.provider_id, p);

  const credsOf = new Map<string, string[]>();
  const credRowsOf = new Map<string, OpsCredentialRow[]>();
  for (const c of input.credentials) {
    if (!credentialLive(c, input.date)) continue;
    const list = credsOf.get(c.provider_id);
    if (list) list.push(c.site_id); else credsOf.set(c.provider_id, [c.site_id]);
    const rows = credRowsOf.get(c.provider_id);
    if (rows) rows.push(c); else credRowsOf.set(c.provider_id, [c]);
  }

  const availOf = new Map<string, OpsAvailRow[]>();
  for (const a of input.availability) {
    const list = availOf.get(a.provider_id);
    if (list) list.push(a); else availOf.set(a.provider_id, [a]);
  }

  // Bookings on the date, and post-call-generating calls the day before.
  const yesterday = addDays(input.date, -1);
  const bookedAt = new Map<string, string>();
  const postCallFrom = new Map<string, string>();
  for (const slot of input.slots) {
    for (const a of slot.assignments || []) {
      if (!a?.provider_id) continue;
      if (slot.slot_date === input.date) {
        if (!bookedAt.has(a.provider_id)) bookedAt.set(a.provider_id, slot.site_id);
      } else if (slot.slot_date === yesterday && slot.shift_types?.requires_post_call_rule) {
        postCallFrom.set(a.provider_id, slot.site_id);
      }
    }
  }

  const rows: BenchRow[] = [];
  const siteSet = new Set<string>();
  let free = 0;
  let onRoster = 0;
  let uncredentialed = 0;
  const byGroup: Record<CoverageGroup, { onRoster: number; uncredentialed: number; free: number }> = {
    physician: { onRoster: 0, uncredentialed: 0, free: 0 },
    crna: { onRoster: 0, uncredentialed: 0, free: 0 },
  };

  for (const p of input.providers) {
    const profile = profileOf.get(p.id);
    if (!profile || !bench.has(profile.employment_status || '')) continue;
    onRoster++;
    // Same binary split the coverage matrix uses: CRNA, or physician for
    // everything else. Two places counting disciplines by different rules would
    // put a different total in each half of one screen.
    const group: CoverageGroup = p.provider_type === 'crna' ? 'crna' : 'physician';
    byGroup[group].onRoster++;

    const creds = credsOf.get(p.id) || [];
    for (const s of creds) siteSet.add(s);
    const sites = input.sites.filter(s => creds.includes(s.id)).map(s => s.short_name || s.name);

    if (creds.length === 0) { uncredentialed++; byGroup[group].uncredentialed++; continue; }

    // Call clearance, per site, so it composes with the site filter: asking for
    // "call at Lankenau" must not be answered by somebody cleared for call at
    // Paoli only.
    const callSiteIds = (credRowsOf.get(p.id) || [])
      .filter(c => engineAllowsCall(profile, c))
      .map(c => c.site_id);

    let status: BenchStatus;
    let detail: string;
    if (isDateBlocked(availOf.get(p.id) || [], input.date)) {
      status = 'off';
      detail = 'time off';
    } else if (bookedAt.has(p.id)) {
      status = 'booked';
      detail = `booked at ${siteName.get(bookedAt.get(p.id)!) || 'another site'}`;
    } else if (postCallFrom.has(p.id)) {
      status = 'booked';
      detail = `post-call from ${siteName.get(postCallFrom.get(p.id)!) || 'another site'}`;
    } else {
      status = 'available';
      detail = sites.length === 1 ? `free · ${sites[0]}` : `free · ${sites.length} sites`;
      free++;
      byGroup[group].free++;
    }

    // ── Are they working enough? ─────────────────────────────────────────
    const shiftsYtd = input.shiftsYtd?.get(p.id) ?? 0;
    const months = monthsWorkedThisYear(input.date, p.start_date, input.scheduleDataFrom);
    const avg = months > 0 ? shiftsYtd / months : 0;
    const rawMin = profile.min_monthly_shifts;
    const min = rawMin === null || rawMin === undefined || rawMin === ''
      ? null
      : Number(rawMin);
    const minMonthlyShifts = min !== null && Number.isFinite(min) ? min : null;
    // Not flagged in the first month: one slow fortnight is not a pattern, and
    // a flag that fires on everybody new teaches people to ignore it.
    const belowMinimum = minMonthlyShifts !== null && months >= 1 && avg < minMonthlyShifts;

    const name = providerName(p);
    const code = p.short_display_name?.trim() || '';
    // Compared on letters alone: some codes ARE the name with the spacing
    // squeezed out ("D.Gorelick" beside "D. Gorelick"), and printing both
    // reads as two different people.
    const bare = (s: string) => s.replace(/[^a-z0-9]/gi, '').toLowerCase();
    rows.push({
      providerId: p.id,
      name,
      code: code && bare(code) !== bare(name) ? code : '',
      providerType: p.provider_type || '',
      group,
      status,
      detail,
      sites,
      siteIds: input.sites.filter(s => creds.includes(s.id)).map(s => s.id),
      callSiteIds,
      canTakeCall: callSiteIds.length > 0,
      shiftsYtd,
      avgShiftsPerMonth: Math.round(avg * 10) / 10,
      minMonthlyShifts,
      belowMinimum,
    });
  }

  // Available first, then booked, then off; alphabetical inside each. Back
  // office reads this list top-down looking for a name to call, so the
  // callable ones have to be at the top.
  const RANK: Record<BenchStatus, number> = { available: 0, booked: 1, off: 2 };
  rows.sort((a, b) => RANK[a.status] - RANK[b.status] || a.name.localeCompare(b.name));

  const yearStart = `${input.date.slice(0, 4)}-01-01`;
  const averageFrom = input.scheduleDataFrom && input.scheduleDataFrom > yearStart
    ? input.scheduleDataFrom : yearStart;

  return {
    rows, onRoster, uncredentialed, sitesCovered: siteSet.size, freeToday: free,
    belowMinimum: rows.filter(r => r.belowMinimum).length,
    byGroup,
    callCapable: rows.filter(r => r.canTakeCall).length,
    averageFrom,
    averageMonths: Math.round(monthsWorkedThisYear(input.date, null, input.scheduleDataFrom) * 10) / 10,
  };
}

// ── 3. Who is on the floor ─────────────────────────────────────────────────

export interface BoardPerson {
  providerId: string;
  name: string;
  /** The shift code as scheduled — "7-3", "C1", "D2". */
  code: string;
  /** Hours as scheduled, e.g. "24 h"; blank when the times are not set. */
  hours: string;
  providerType: string;
  /** call_rank for a call shift — 1 = first call. null for a day shift.
   *  Carried through so the card can tint C1/C2/C3 apart instead of painting
   *  every call chip the same red, which made three different jobs on one card
   *  read as one. */
  callRank: number | null;
  /** Shift start as scheduled, "HH:MM:SS" or null. The ordering key for the
   *  day list — see the sort below. */
  startTime: string | null;
}

export interface SiteDayBoard {
  siteId: string;
  siteName: string;
  shortName: string;
  /** Call, first call first. Empty at a site that runs no overnight call. */
  onCall: BoardPerson[];
  /** Day shifts, physicians then CRNAs, alphabetical. */
  inRooms: BoardPerson[];
  /** Positions with nobody in them — the cell the grid would show open. */
  openPositions: number;
  mdCount: number;
  crnaCount: number;
  /** True when the site has no slots at all on this date. */
  unscheduled: boolean;
  /** True when the site does not run on this weekday. */
  closed: boolean;
}

/** "07:00"–"19:00" → "12 h". Blank when either end is missing, rather than
 *  printing a made-up duration. Wraps past midnight (15:00→07:00 = 16 h). */
export function shiftHours(start?: string | null, end?: string | null): string {
  if (!start || !end) return '';
  const mins = (t: string) => {
    const [h, m] = t.split(':');
    const hh = Number(h), mm = Number(m);
    return Number.isFinite(hh) && Number.isFinite(mm) ? hh * 60 + mm : NaN;
  };
  const a = mins(start), b = mins(end);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return '';
  // Equal times mean a full 24 h shift (Paoli's C3 runs 07:00→07:00), not a
  // zero-length one.
  let span = b - a;
  if (span <= 0) span += 24 * 60;
  const h = span / 60;
  return `${Number.isInteger(h) ? h : h.toFixed(1)} h`;
}

/**
 * Every person on the board at one site on one date.
 *
 * Call is sorted by call_rank so first call is always the top line; day shifts
 * are sorted by provider type then name. An unfilled slot is not a person and
 * never appears as one — it is counted in openPositions, which is what makes
 * the card agree with the coverage matrix above it.
 */
export function siteDayBoard(input: {
  date: string;
  sites: ReadonlyArray<OpsSiteRow>;
  slots: ReadonlyArray<OpsSlotRow>;
  providers: ReadonlyArray<OpsProviderRow>;
}): SiteDayBoard[] {
  const providerById = new Map<string, OpsProviderRow>();
  for (const p of input.providers) providerById.set(p.id, p);

  const bySite = new Map<string, OpsSlotRow[]>();
  for (const slot of input.slots) {
    if (slot.slot_date !== input.date) continue;
    const list = bySite.get(slot.site_id);
    if (list) list.push(slot); else bySite.set(slot.site_id, [slot]);
  }

  return input.sites.map(site => {
    const open = siteOpenDays(site.operational_days);
    const slots = bySite.get(site.id) || [];
    const onCall: Array<BoardPerson & { rank: number }> = [];
    const inRooms: BoardPerson[] = [];
    let openPositions = 0;
    let mdCount = 0, crnaCount = 0;

    for (const slot of slots) {
      const st = slot.shift_types;
      if (!st) continue;
      const held = (slot.assignments || []).filter(a => a?.provider_id);
      openPositions += Math.max(0, (slot.required_count ?? 1) - held.length);

      for (const a of held) {
        const provider = providerById.get(a.provider_id as string);
        const person: BoardPerson = {
          providerId: a.provider_id as string,
          name: provider ? providerName(provider) : '—',
          code: st.code,
          hours: shiftHours(st.start_time, st.end_time),
          providerType: provider?.provider_type || '',
          callRank: st.category === 'call' ? (st.call_rank ?? null) : null,
          startTime: st.start_time ?? null,
        };
        if (person.providerType === 'crna') crnaCount++; else mdCount++;
        if (st.category === 'call') {
          onCall.push({ ...person, rank: st.call_rank ?? 99 });
        } else {
          inRooms.push(person);
        }
      }
    }

    onCall.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
    // BY SHIFT, NOT BY NAME (Gabriel 2026-09-22). Alphabetical order scatters
    // the 7-3s among the D-shifts and the late starts, so the one question the
    // card is opened with — "who is on days" — has to be answered by reading
    // every line. Sorting on start time puts the day block together, then the
    // later starts, and identical codes land adjacent. Name only breaks ties
    // inside one code, where it is genuinely the useful order.
    //
    // A missing start time sorts LAST rather than first: several imported
    // types state none, and a null is "unknown", which does not belong at the
    // head of a list that reads as a timeline.
    inRooms.sort((a, b) =>
      (a.startTime ?? '99').localeCompare(b.startTime ?? '99')
      || a.code.localeCompare(b.code)
      || (a.providerType === 'crna' ? 1 : 0) - (b.providerType === 'crna' ? 1 : 0)
      || a.name.localeCompare(b.name));

    return {
      siteId: site.id,
      siteName: site.name,
      shortName: site.short_name || site.name.slice(0, 4).toUpperCase(),
      onCall: onCall.map(({ rank: _rank, ...p }) => p),
      inRooms,
      openPositions,
      mdCount,
      crnaCount,
      unscheduled: slots.length === 0 && open[dayOfWeekUTC(input.date)],
      closed: !open[dayOfWeekUTC(input.date)],
    };
  });
}

// ── 4. The header strip ────────────────────────────────────────────────────

export interface RosterSummary {
  physicians: number;
  crnas: number;
  sites: number;
  fullTime: number;
  partTime: number;
  perDiem: number;
  /** Off today, by provider type. */
  offMd: number;
  offCrna: number;
  /** Off today but back tomorrow — the "2 return Mon" figure. */
  returning: number;
  scheduledToday: number;
  openToday: number;
  freeToday: number;
}

export function rosterSummary(input: {
  date: string;
  providers: ReadonlyArray<OpsProviderRow>;
  profiles: ReadonlyArray<OpsProfileRow>;
  availability: ReadonlyArray<OpsAvailRow>;
  slots: ReadonlyArray<OpsSlotRow>;
  freeToday: number;
}): RosterSummary {
  const out: RosterSummary = {
    physicians: 0, crnas: 0, sites: 0,
    fullTime: 0, partTime: 0, perDiem: 0,
    offMd: 0, offCrna: 0, returning: 0,
    scheduledToday: 0, openToday: 0, freeToday: input.freeToday,
  };

  const statusOf = new Map<string, string>();
  for (const p of input.profiles) statusOf.set(p.provider_id, p.employment_status || '');

  const availOf = new Map<string, OpsAvailRow[]>();
  for (const a of input.availability) {
    const list = availOf.get(a.provider_id);
    if (list) list.push(a); else availOf.set(a.provider_id, [a]);
  }

  const tomorrow = addDays(input.date, 1);
  for (const p of input.providers) {
    const isCrna = p.provider_type === 'crna';
    if (isCrna) out.crnas++; else out.physicians++;

    switch (statusOf.get(p.id)) {
      case 'full_time': out.fullTime++; break;
      case 'part_time': out.partTime++; break;
      case 'per_diem': out.perDiem++; break;
    }

    const entries = availOf.get(p.id);
    if (entries && isDateBlocked(entries, input.date)) {
      if (isCrna) out.offCrna++; else out.offMd++;
      if (!isDateBlocked(entries, tomorrow)) out.returning++;
    }
  }

  for (const slot of input.slots) {
    if (slot.slot_date !== input.date) continue;
    const held = (slot.assignments || []).filter(a => a?.provider_id).length;
    out.scheduledToday += held;
    out.openToday += Math.max(0, (slot.required_count ?? 1) - held);
  }

  return out;
}

/** The seven dates of the week containing `date`, Monday first. */
export function weekDates(date: string): string[] {
  const dow = dayOfWeekUTC(date);          // 0 = Sunday
  const monday = addDays(date, dow === 0 ? -6 : 1 - dow);
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

// ── 5. Transfers ───────────────────────────────────────────────────────────

/**
 * Who could move from a site with spare staff to a site that is short.
 *
 * Staff are shared daily here: sites need different numbers on different days,
 * PTO lands unevenly, and a block routinely leaves one hospital with a body to
 * spare while another is a body down. The move itself is made by hand on the
 * schedule — this only answers the question that comes first, which is who is
 * actually movable.
 *
 * ── THREE THINGS DISQUALIFY A CANDIDATE ────────────────────────────────────
 * 1. NOT CREDENTIALED at the destination. The engine will not place anyone at
 *    a site they are not credentialed for, and neither should a suggestion —
 *    offering an impossible move wastes the one minute this panel exists to
 *    save.
 * 2. ON CALL. Call is a commitment to a hospital for the night, not day work
 *    that can be done somewhere else; moving first call is a different and much
 *    larger decision. Only regular day work is offered.
 * 3. WRONG GROUP. A CRNA cannot fill a physician's gap. Candidates are matched
 *    to the group the destination is actually short in.
 */
export interface TransferCandidate {
  providerId: string;
  name: string;
  providerType: string;
  /** The shift they currently hold at the surplus site. */
  shiftCode: string;
  fromSiteId: string;
  fromSite: string;
  toSiteId: string;
  toSite: string;
  /** Which group's gap this move would close. */
  group: CoverageGroup;
}

export interface TransferPicture {
  date: string;
  short: Array<{ siteId: string; shortName: string; siteName: string; by: number }>;
  surplus: Array<{ siteId: string; shortName: string; siteName: string; by: number }>;
  candidates: TransferCandidate[];
  /** Sites short with nobody movable to them, and why there is nobody. */
  unmatched: Array<{ siteId: string; shortName: string; reason: string }>;
}

export function transferPicture(input: {
  date: string;
  coverage: ReadonlyArray<CoverageRow>;
  slots: ReadonlyArray<OpsSlotRow>;
  providers: ReadonlyArray<OpsProviderRow>;
  credentials: ReadonlyArray<OpsCredentialRow>;
}): TransferPicture {
  const { date } = input;

  const cellOn = (row: CoverageRow) => row.cells.find(c => c.date === date);
  const short = input.coverage
    .map(r => ({ row: r, cell: cellOn(r) }))
    .filter(x => x.cell && x.cell.shortBy > 0)
    .map(x => ({
      siteId: x.row.siteId, shortName: x.row.shortName,
      siteName: x.row.siteName, by: x.cell!.shortBy,
    }));
  const surplus = input.coverage
    .map(r => ({ row: r, cell: cellOn(r) }))
    .filter(x => x.cell && x.cell.surplusBy > 0)
    .map(x => ({
      siteId: x.row.siteId, shortName: x.row.shortName,
      siteName: x.row.siteName, by: x.cell!.surplusBy,
    }));

  // Nothing short: nothing to say, and the panel stays silent.
  if (short.length === 0) {
    return { date, short, surplus, candidates: [], unmatched: [] };
  }
  // Short but nothing spare anywhere. Still explain it — a shortage with no
  // line under it reads as an unfinished thought, and "there is nobody" is a
  // real answer that saves somebody going to look.
  if (surplus.length === 0) {
    return {
      date, short, surplus, candidates: [],
      unmatched: short.map(t => ({
        siteId: t.siteId, shortName: t.shortName,
        reason: 'nobody is spare anywhere today',
      })),
    };
  }

  // Which group each short site actually needs, so a CRNA is never offered
  // against a physician gap.
  const shortGroups = new Map<string, Set<CoverageGroup>>();
  for (const row of input.coverage) {
    const cell = cellOn(row);
    if (!cell) continue;
    const groups = new Set<CoverageGroup>();
    for (const g of cell.groups) {
      if (g.needed !== null && g.available < g.needed) groups.add(g.group);
    }
    if (groups.size > 0) shortGroups.set(row.siteId, groups);
  }

  const credOf = new Map<string, Set<string>>();
  for (const c of input.credentials) {
    if (!credentialLive(c, date)) continue;
    const set = credOf.get(c.provider_id) ?? new Set<string>();
    set.add(c.site_id);
    credOf.set(c.provider_id, set);
  }

  const providerById = new Map(input.providers.map(p => [p.id, p]));
  const surplusSiteIds = new Set(surplus.map(s => s.siteId));

  // Which groups have a MOVABLE body at each surplus site — day work only.
  // Without this the reason cannot tell "the spare staff are all MDs" from
  // "the spare staff are all on call", and both are common.
  const movableByGroup = new Map<string, Set<CoverageGroup>>();
  for (const slot of input.slots) {
    if (slot.slot_date !== date || !slot.shift_types) continue;
    if (slot.shift_types.category === 'call') continue;
    for (const a of slot.assignments || []) {
      if (!a?.provider_id) continue;
      const g: CoverageGroup =
        providerTypeOf(input.providers, a.provider_id) === 'crna' ? 'crna' : 'physician';
      const set = movableByGroup.get(slot.site_id) ?? new Set<CoverageGroup>();
      set.add(g);
      movableByGroup.set(slot.site_id, set);
    }
  }

  const candidates: TransferCandidate[] = [];
  const seen = new Set<string>();
  for (const slot of input.slots) {
    if (slot.slot_date !== date) continue;
    if (!slot.shift_types) continue;
    // Call is not transferable — see note 2 above.
    if (slot.shift_types.category === 'call') continue;
    if (!surplusSiteIds.has(slot.site_id)) continue;

    for (const a of slot.assignments || []) {
      if (!a?.provider_id) continue;
      const provider = providerById.get(a.provider_id);
      const group: CoverageGroup = provider?.provider_type === 'crna' ? 'crna' : 'physician';
      const creds = credOf.get(a.provider_id) ?? new Set<string>();

      for (const target of short) {
        if (target.siteId === slot.site_id) continue;
        if (!shortGroups.get(target.siteId)?.has(group)) continue;
        if (!creds.has(target.siteId)) continue;
        const key = `${a.provider_id}|${slot.site_id}|${target.siteId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({
          providerId: a.provider_id,
          name: provider ? providerName(provider) : '—',
          providerType: provider?.provider_type || '',
          shiftCode: slot.shift_types.code,
          fromSiteId: slot.site_id,
          fromSite: input.coverage.find(c => c.siteId === slot.site_id)?.shortName ?? '—',
          toSiteId: target.siteId,
          toSite: target.shortName,
          group,
        });
      }
    }
  }

  candidates.sort((a, b) =>
    a.toSite.localeCompare(b.toSite) || a.fromSite.localeCompare(b.fromSite)
    || a.name.localeCompare(b.name));

  // A short site with no candidate is worth saying out loud, and WHY matters:
  // "nobody is credentialed there", "the spare staff are the wrong group" and
  // "the only spare staff are already here" lead somewhere completely
  // different. A vague reason sends somebody looking for a person who does not
  // exist.
  const unmatched = short
    .filter(t => !candidates.some(c => c.toSiteId === t.siteId))
    .map(t => {
      const elsewhere = surplus.filter(s => s.siteId !== t.siteId);
      const needs = shortGroups.get(t.siteId) ?? new Set<CoverageGroup>();
      const needLabel = [...needs].map(g => GROUP_LABEL[g]).join(' and ');

      let reason: string;
      if (surplus.length === 0) {
        reason = 'nobody is spare anywhere today';
      } else if (elsewhere.length === 0) {
        reason = `the only spare staff today are already at ${t.shortName}`;
      } else if (!spareGroups(elsewhere, movableByGroup).some(g => needs.has(g))) {
        reason = `the spare staff today are ${spareGroups(elsewhere, movableByGroup)
          .map(g => GROUP_LABEL[g]).join(' and ') || 'on call'}`
          + `, and ${t.shortName} is short of ${needLabel}`;
      } else {
        reason = 'nobody spare today is credentialed there';
      }
      return { siteId: t.siteId, shortName: t.shortName, reason };
    });

  return { date, short, surplus, candidates, unmatched };
}

function providerTypeOf(
  providers: ReadonlyArray<OpsProviderRow>, id: string,
): string {
  return providers.find(p => p.id === id)?.provider_type || '';
}

/** The groups that actually have a movable body across a set of surplus sites. */
function spareGroups(
  sites: ReadonlyArray<{ siteId: string }>,
  movable: ReadonlyMap<string, Set<CoverageGroup>>,
): CoverageGroup[] {
  const out = new Set<CoverageGroup>();
  for (const s of sites) for (const g of movable.get(s.siteId) ?? []) out.add(g);
  return [...out];
}
