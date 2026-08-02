// Printable schedule layout (Gabriel 2026-08-02: "print in landscape a full
// version of the schedule or create a pdf for sending. It should print just the
// Schedule in the most efficently viewing possible").
//
// WHY A SEPARATE LAYOUT RATHER THAN PRINTING THE GRID. The interactive grid is
// one CSS grid inside an overflow container, with sticky headers and a column
// per date across the whole block — 77 columns at Paoli. A print stylesheet
// cannot paginate that: `position: fixed` print areas CLIP rather than scroll
// (the Call Counts sheet documents the same hazard), and 77 columns on letter
// landscape is ~13px per column, which is not a schedule anyone can read. So
// print builds its own week-per-page tables and the grid is hidden.
//
// ONE WEEK PER PAGE, and it is a considered choice rather than the obvious one:
//   • 7 columns on letter landscape is ~130px each — room for a real name, not
//     initials, which is what makes a printout usable at the board.
//   • A week is the unit people actually plan in, and a single page can be
//     pinned up or forwarded on its own.
//   • Two weeks per page halves the page count but drops each column to ~65px,
//     which forces initials and makes the sheet a decoding exercise.
// An 11-week block is therefore 11 pages. That is the honest cost of a readable
// sheet, and a PDF does not care.
//
// Weeks start MONDAY, matching how the blocks themselves are cut (2026-08-10 is
// a Monday) — a Sunday-start grid would split every weekend across two pages,
// which is the one thing a call schedule must not do.

export interface PrintSlotRow {
  code: string;
  /** shift_types.display_order — the grid's own row order. */
  displayOrder: number;
  category: string;
}

export interface PrintWeek {
  /** Monday of the week, ISO. */
  start: string;
  /** The 7 ISO dates, Monday first. Dates outside the block are dropped, so
   *  the first and last weeks may be short rather than padded with blanks. */
  dates: string[];
}

const DAY = 86_400_000;
const parse = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Monday of the week containing `date`. getUTCDay: 0=Sun … 6=Sat. */
export function mondayOf(date: string): string {
  const d = new Date(parse(date));
  const dow = d.getUTCDay();
  return iso(parse(date) - ((dow + 6) % 7) * DAY);
}

/** Split the block into Monday-start weeks, keeping only dates the block
 *  actually covers. Empty in → empty out. */
export function weeksOf(dates: readonly string[]): PrintWeek[] {
  if (dates.length === 0) return [];
  const sorted = [...dates].sort();
  const byWeek = new Map<string, string[]>();
  for (const d of sorted) {
    const wk = mondayOf(d);
    const list = byWeek.get(wk) ?? [];
    list.push(d);
    byWeek.set(wk, list);
  }
  return [...byWeek.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([start, ds]) => ({ start, dates: ds }));
}

/** Rows to print, in the grid's own order. Only shift types the block actually
 *  stands a slot for — a permanently empty row wastes a line on every page. */
export function printRows(
  slots: ReadonlyArray<{ shift_types: { code: string; display_order?: number | null; category: string } | null }>,
): PrintSlotRow[] {
  const byCode = new Map<string, PrintSlotRow>();
  for (const s of slots) {
    const st = s.shift_types;
    if (!st || byCode.has(st.code)) continue;
    byCode.set(st.code, {
      code: st.code,
      displayOrder: st.display_order ?? Number.MAX_SAFE_INTEGER,
      category: st.category,
    });
  }
  return [...byCode.values()].sort((a, b) => a.displayOrder - b.displayOrder
    || a.code.localeCompare(b.code));
}

/** Range caption for the page header, e.g. "Aug 10 – Aug 16, 2026". */
export function weekLabel(week: PrintWeek): string {
  const fmt = (d: string) => new Date(parse(d))
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const first = week.dates[0], last = week.dates[week.dates.length - 1];
  const year = new Date(parse(last)).getUTCFullYear();
  return first === last ? `${fmt(first)}, ${year}` : `${fmt(first)} – ${fmt(last)}, ${year}`;
}
