// Grouping for the Schedules board: every site in its own box, each box split
// physician / CRNA.
//
// Pure, because the interesting parts are decisions rather than markup: which
// sites appear when they have nothing, where a 'both' schedule goes, and what
// order any of it comes in.

export interface BoardSite {
  id: string;
  name: string;
  short_name?: string | null;
}

export interface BoardSchedule {
  id: string;
  schedule_name: string;
  provider_group?: string | null;
  status: string;
  date_start: string;
  date_end: string;
  site_id?: string | null;
  sites?: { name?: string | null; short_name?: string | null } | null;
}

/** The three columns a box can hold. 'both' only renders when occupied. */
export const BOARD_GROUPS = ['physician', 'crna', 'both'] as const;
export type BoardGroup = (typeof BOARD_GROUPS)[number];

export const GROUP_LABELS: Record<BoardGroup, string> = {
  physician: 'Physician',
  crna: 'CRNA',
  both: 'Combined',
};

export interface SiteBox {
  site: BoardSite;
  /** Keyed by group; every key present, possibly empty. */
  byGroup: Record<BoardGroup, BoardSchedule[]>;
  total: number;
}

export interface ScheduleBoard {
  boxes: SiteBox[];
  /**
   * Schedules whose site is missing or unknown. Surfaced rather than dropped:
   * a schedule that silently vanishes from the only page that lists schedules
   * is the kind of thing nobody notices until it matters.
   */
  orphans: BoardSchedule[];
}

/**
 * A schedule's column.
 *
 * Anything unrecognised — including null, which older rows carry — lands in
 * 'both'. That is the permissive bucket and the column that renders only when
 * occupied, so an unexpected value shows up on screen instead of being
 * silently filed under Physician.
 */
export function groupOf(s: BoardSchedule): BoardGroup {
  return s.provider_group === 'physician' || s.provider_group === 'crna'
    ? s.provider_group
    : 'both';
}

/** Newest first: the schedule someone wants is nearly always the recent one. */
function byDateDesc(a: BoardSchedule, b: BoardSchedule): number {
  return b.date_start.localeCompare(a.date_start)
    || a.schedule_name.localeCompare(b.schedule_name);
}

/**
 * Build one box per site, in the order the sites were given.
 *
 * EVERY site gets a box, including sites with no schedules at all. Six of
 * eight are in that state, and showing them is the point: an empty Physician
 * column at Riddle is the fact worth seeing, whereas omitting the site makes
 * it look like Riddle does not exist.
 */
export function buildScheduleBoard(
  sites: readonly BoardSite[],
  schedules: readonly BoardSchedule[],
): ScheduleBoard {
  const boxById = new Map<string, SiteBox>();
  for (const site of sites) {
    boxById.set(site.id, {
      site,
      byGroup: { physician: [], crna: [], both: [] },
      total: 0,
    });
  }

  const orphans: BoardSchedule[] = [];
  for (const s of schedules) {
    const box = s.site_id ? boxById.get(s.site_id) : undefined;
    if (!box) { orphans.push(s); continue; }
    box.byGroup[groupOf(s)].push(s);
    box.total++;
  }

  for (const box of boxById.values()) {
    for (const g of BOARD_GROUPS) box.byGroup[g].sort(byDateDesc);
  }
  orphans.sort(byDateDesc);

  return { boxes: [...boxById.values()], orphans };
}

/** "3 schedules" / "1 schedule" / "No schedules yet". */
/**
 * Today as a calendar day — "2026-09-24", never an instant.
 *
 * A schedule's date_start/date_end are plain dates with no timezone, so the
 * comparison must be too. new Date().toISOString() would return the UTC day,
 * which is tomorrow for anyone east of GMT after 19:00 and would ring the
 * wrong card for several hours every evening.
 */
export function todayLocalISO(now: Date = new Date()): string {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

/**
 * Does this block cover today? (Gabriel 2026-09-24: "a navy border ring around
 * the schedules whose dates include the current date, so it's easier to pick
 * out a current schedule.")
 *
 * Inclusive at both ends — the last day of a block is still part of it — and a
 * plain string compare, which is correct for zero-padded ISO dates and avoids
 * inventing a timezone the data does not have.
 */
export function isCurrentBlock(
  s: Pick<BoardSchedule, 'date_start' | 'date_end'>,
  today: string = todayLocalISO(),
): boolean {
  return s.date_start <= today && today <= s.date_end;
}

export function boxSummary(total: number): string {
  if (total === 0) return 'No schedules yet';
  return `${total} schedule${total === 1 ? '' : 's'}`;
}
