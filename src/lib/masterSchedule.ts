/* ───────────────────────────────────────────────────────────────────────────
 * The master schedule — every site's assignments in one document.
 *
 * One per discipline: a Master Physician Schedule and a Master CRNA Schedule.
 * Each site's rows sit on top of one another, separated by a marker, and
 * everybody who is AWAY (PTO, off, sick, jury duty) collects at the bottom of
 * the whole thing rather than repeating inside each site.
 *
 * ── WHY AWAY SITS AT THE BOTTOM, ONCE ─────────────────────────────────────
 * Being on leave is a fact about a PERSON, not about a hospital. Paoli's block
 * does not own Gabriel's holiday; he is simply not anywhere that week. Filing
 * absences under a site would either duplicate them across every site he might
 * have worked or force a choice of which site "owns" the absence — and both
 * make the same week read differently depending on where you look.
 *
 * ── THE WINDOW ────────────────────────────────────────────────────────────
 * Twelve months: six back and six forward from today (Gabriel 2026-09-22).
 * Six back because last block is what people check against when something is
 * disputed; six forward because that is as far as a published schedule ever
 * reaches.
 *
 * The window bounds the DATA. It does not mean 365 columns on screen — see
 * `monthsOf`, which the view uses to show one month at a time.
 * ─────────────────────────────────────────────────────────────────────────── */

import type { CoverageGroup } from './operationsBoard';
import { providerName, type OpsProviderRow } from './operationsBoard';

/** Absence types that mean "not available to be scheduled anywhere". Anything
 *  outside this list is a scheduling PREFERENCE (no_call_request, call_request)
 *  or a duty that still puts the person at work (holiday_call, admin), and
 *  reporting either as time off would be wrong in opposite directions. */
export const AWAY_TYPES: ReadonlySet<string> = new Set([
  'pto', 'unavailable', 'sick', 'jury_duty', 'blocked', 'pto_sellback',
]);

/** How each away type is labelled on the sheet. */
export const AWAY_LABEL: Record<string, string> = {
  pto: 'PTO',
  unavailable: 'Off',
  sick: 'Sick',
  jury_duty: 'Jury duty',
  blocked: 'Blocked',
  pto_sellback: 'Sellback',
};

export interface MasterSlotRow {
  site_id: string;
  slot_date: string;
  shift?: {
    code?: string | null;
    display_order?: number | null;
    category?: string | null;
  } | null;
  providerIds: ReadonlyArray<string>;
}

export interface MasterAwayRow {
  provider_id: string;
  availability_type: string;
  approval_status?: string | null;
  start_date: string;
  end_date: string;
}

export interface MasterSiteRow {
  id: string;
  name: string;
  short_name?: string | null;
  display_order?: number | null;
}

/** One person in one cell. */
export interface MasterCell {
  providerId: string;
  name: string;
}

/** A row of the sheet: one shift code at one site, across the dates. */
export interface MasterShiftRow {
  code: string;
  displayOrder: number;
  isCall: boolean;
  /** date → the people on it. Absent date = nothing scheduled. */
  byDate: Map<string, MasterCell[]>;
}

export interface MasterSiteBlock {
  siteId: string;
  siteName: string;
  shortName: string;
  rows: MasterShiftRow[];
  /** People scheduled anywhere in this block, for the header count. */
  people: number;
}

/** One away spell, already clipped to the window. */
export interface MasterAwaySpell {
  providerId: string;
  name: string;
  type: string;
  label: string;
  start: string;
  end: string;
  /** Not yet approved — shown, but marked. A waitlisted request is not time
   *  off, and rendering it identically would have people believing they have
   *  leave they were never granted. */
  pending: boolean;
}

export interface MasterSchedule {
  group: CoverageGroup;
  from: string;
  to: string;
  blocks: MasterSiteBlock[];
  /** Everyone away, at the bottom of the whole sheet. */
  away: MasterAwaySpell[];
  /** True when no site has a single assignment in the window. Distinct from a
   *  failed read, which the caller reports separately — an empty master sheet
   *  is a real answer ("no CRNA schedule has been built yet") and must not be
   *  confusable with a broken one. */
  empty: boolean;
}

/** ISO date `n` months from `iso`, clamped to the end of the target month. */
function addMonths(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  // Clamp: 31 Aug minus six months must not roll into March.
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

/** The twelve-month window around `today` — six back, six forward. */
export function masterWindow(today: string): { from: string; to: string } {
  return { from: addMonths(today, -6), to: addMonths(today, 6) };
}

/** The months the window spans, as `YYYY-MM`, oldest first. The view shows one
 *  at a time: 365 columns in a single table is not a readable document, and a
 *  month is the unit people already think and talk in. */
export function monthsOf(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/** Every date in a `YYYY-MM`, as ISO strings. */
export function datesInMonth(month: string): string[] {
  const [y, m] = month.split('-').map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: days }, (_, i) =>
    `${month}-${String(i + 1).padStart(2, '0')}`);
}

/** Clip a spell to the window, or null when it falls entirely outside. */
function clip(start: string, end: string, from: string, to: string):
  { start: string; end: string } | null {
  const s = start < from ? from : start;
  const e = end > to ? to : end;
  return s > e ? null : { start: s, end: e };
}

/**
 * Build the master sheet for one discipline.
 *
 * DISCIPLINE COMES FROM THE PROVIDER, not from the shift type's
 * provider_group: a room open to either group and worked by a CRNA is a CRNA's
 * shift, whatever the type permits. Same rule the coverage matrix and the
 * bench use, so the three cannot disagree about who is a CRNA.
 */
export function buildMasterSchedule(input: {
  group: CoverageGroup;
  from: string;
  to: string;
  sites: ReadonlyArray<MasterSiteRow>;
  slots: ReadonlyArray<MasterSlotRow>;
  away: ReadonlyArray<MasterAwayRow>;
  providers: ReadonlyArray<OpsProviderRow>;
}): MasterSchedule {
  const provider = new Map<string, OpsProviderRow>();
  for (const p of input.providers) provider.set(p.id, p);

  const isGroup = (pid: string): boolean => {
    const t = provider.get(pid)?.provider_type;
    return input.group === 'crna' ? t === 'crna' : t !== 'crna';
  };

  // site → code → row
  const bySite = new Map<string, Map<string, MasterShiftRow>>();
  const peopleAt = new Map<string, Set<string>>();

  for (const slot of input.slots) {
    if (slot.slot_date < input.from || slot.slot_date > input.to) continue;
    const code = slot.shift?.code?.trim();
    if (!code) continue;
    const mine = slot.providerIds.filter(isGroup);
    if (mine.length === 0) continue;

    let rows = bySite.get(slot.site_id);
    if (!rows) { rows = new Map(); bySite.set(slot.site_id, rows); }
    let row = rows.get(code);
    if (!row) {
      row = {
        code,
        // 999 for an unordered type, matching the grid's own fallback, so a
        // newly added shift lands at the bottom rather than silently first.
        displayOrder: slot.shift?.display_order ?? 999,
        isCall: slot.shift?.category === 'call',
        byDate: new Map(),
      };
      rows.set(code, row);
    }

    const cells = row.byDate.get(slot.slot_date) ?? [];
    for (const pid of mine) {
      // A person holding two slots of the SAME code on one day is one entry.
      if (cells.some(c => c.providerId === pid)) continue;
      const p = provider.get(pid);
      cells.push({ providerId: pid, name: p ? providerName(p) : '—' });
      let seen = peopleAt.get(slot.site_id);
      if (!seen) { seen = new Set(); peopleAt.set(slot.site_id, seen); }
      seen.add(pid);
    }
    cells.sort((a, b) => a.name.localeCompare(b.name));
    row.byDate.set(slot.slot_date, cells);
  }

  const blocks: MasterSiteBlock[] = input.sites
    .map(site => {
      const rows = [...(bySite.get(site.id)?.values() ?? [])]
        // Call first, then by the site's configured order, then by code — the
        // same shape patch63 gave the per-site grids, so a reader moving
        // between the two sees one ordering.
        .sort((a, b) => Number(b.isCall) - Number(a.isCall)
          || a.displayOrder - b.displayOrder
          || a.code.localeCompare(b.code));
      return {
        siteId: site.id,
        siteName: site.name,
        shortName: site.short_name || site.name.slice(0, 4).toUpperCase(),
        rows,
        people: peopleAt.get(site.id)?.size ?? 0,
      };
    })
    // A site with nothing in the window is left OUT rather than rendered as an
    // empty band: eight empty headers would bury the two that carry the work.
    .filter(b => b.rows.length > 0);

  // ── Away, at the bottom of the whole sheet ──────────────────────────────
  const away: MasterAwaySpell[] = [];
  for (const a of input.away) {
    if (!AWAY_TYPES.has(a.availability_type)) continue;
    if (!isGroup(a.provider_id)) continue;
    const span = clip(a.start_date, a.end_date, input.from, input.to);
    if (!span) continue;
    const p = provider.get(a.provider_id);
    away.push({
      providerId: a.provider_id,
      name: p ? providerName(p) : '—',
      type: a.availability_type,
      label: AWAY_LABEL[a.availability_type] ?? a.availability_type,
      start: span.start,
      end: span.end,
      pending: a.approval_status != null && a.approval_status !== 'approved',
    });
  }
  away.sort((x, y) => x.start.localeCompare(y.start) || x.name.localeCompare(y.name));

  return {
    group: input.group,
    from: input.from,
    to: input.to,
    blocks,
    away,
    empty: blocks.length === 0,
  };
}

/** The away spells overlapping one month — what the view actually prints under
 *  the month it is showing. */
export function awayInMonth(
  away: ReadonlyArray<MasterAwaySpell>, month: string,
): MasterAwaySpell[] {
  const dates = datesInMonth(month);
  const first = dates[0];
  const last = dates[dates.length - 1];
  return away.filter(a => a.start <= last && a.end >= first);
}
