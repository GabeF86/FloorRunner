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
}

export interface OpsProfileRow {
  provider_id: string;
  employment_status?: string | null;
  home_site_id?: string | null;
}

/** The two staffing groups demand is stated in. There is no 'either' any more:
 *  once NEEDED is an explicit MD and CRNA count, an unfilled slot has nothing
 *  to contribute — availability is people, and an empty room is not a person. */
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

// ── 1. Available vs needed, by site and day ────────────────────────────────

export type CellStatus = 'covered' | 'short' | 'gap' | 'closed' | 'unstated';

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
 *  single open room is a phone call and two is a staffing problem, and back
 *  office triages them differently. */
function statusForShortfall(shortBy: number): CellStatus {
  if (shortBy <= 0) return 'covered';
  return shortBy === 1 ? 'short' : 'gap';
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
  // the slot — not by what the shift type permits. A 'both' room filled by a
  // CRNA is a CRNA on the floor, whatever the type allows; and an EMPTY room
  // contributes nothing at all, because the question is how many bodies are
  // there, not how many chairs.
  const bySiteDate = new Map<string, Map<string, { physician: number; crna: number }>>();
  for (const slot of input.slots) {
    if (!slot.shift_types) continue;
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
        return { date, status: 'closed', groups: [], shortBy: 0, demandSource: null };
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
          demandSource: null,
        };
      }

      const groups = ([
        { group: 'physician', available: staffed.physician, needed: need.md },
        { group: 'crna', available: staffed.crna, needed: need.crna },
      ] as CoverageGroupCount[]).filter(g => g.needed !== null || g.available > 0);

      let shortBy = 0;
      for (const g of groups) {
        if (g.needed === null) continue;     // that half is simply not stated
        shortBy += Math.max(0, g.needed - g.available);
      }
      rowShort += shortBy;
      return { date, status: statusForShortfall(shortBy), groups, shortBy, demandSource: need.source };
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
  /** Short names of the sites they are credentialed at, in site order. */
  sites: string[];
  /** The same sites as ids — what the board filters on. Names are for reading;
   *  filtering on them would break the moment two sites shared a short name. */
  siteIds: string[];
}

export interface BenchSummary {
  /** The callable bench: per diems with at least one live site credential.
   *  Somebody credentialed nowhere cannot be phoned for a room today, and
   *  listing them by name buries the handful who can — see `uncredentialed`. */
  rows: BenchRow[];
  /** Every per diem on the roster, credentialed or not. */
  onRoster: number;
  /** On the roster but credentialed at no site — a count, not a list. It is a
   *  credentialing backlog, which is a different job on a different timescale
   *  from filling a room this morning. */
  uncredentialed: number;
  sitesCovered: number;
  freeToday: number;
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
}): BenchSummary {
  const bench = new Set((input.statuses ?? ['per_diem']).map(s => s));
  const siteName = new Map<string, string>();
  for (const s of input.sites) siteName.set(s.id, s.short_name || s.name);

  const profileOf = new Map<string, OpsProfileRow>();
  for (const p of input.profiles) profileOf.set(p.provider_id, p);

  const credsOf = new Map<string, string[]>();
  for (const c of input.credentials) {
    if (!credentialLive(c, input.date)) continue;
    const list = credsOf.get(c.provider_id);
    if (list) list.push(c.site_id); else credsOf.set(c.provider_id, [c.site_id]);
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

  for (const p of input.providers) {
    const profile = profileOf.get(p.id);
    if (!profile || !bench.has(profile.employment_status || '')) continue;
    onRoster++;

    const creds = credsOf.get(p.id) || [];
    for (const s of creds) siteSet.add(s);
    const sites = input.sites.filter(s => creds.includes(s.id)).map(s => s.short_name || s.name);

    if (creds.length === 0) { uncredentialed++; continue; }

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
    }

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
      status,
      detail,
      sites,
      siteIds: input.sites.filter(s => creds.includes(s.id)).map(s => s.id),
    });
  }

  // Available first, then booked, then off; alphabetical inside each. Back
  // office reads this list top-down looking for a name to call, so the
  // callable ones have to be at the top.
  const RANK: Record<BenchStatus, number> = { available: 0, booked: 1, off: 2 };
  rows.sort((a, b) => RANK[a.status] - RANK[b.status] || a.name.localeCompare(b.name));

  return { rows, onRoster, uncredentialed, sitesCovered: siteSet.size, freeToday: free };
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
    inRooms.sort((a, b) =>
      (a.providerType === 'crna' ? 1 : 0) - (b.providerType === 'crna' ? 1 : 0)
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
