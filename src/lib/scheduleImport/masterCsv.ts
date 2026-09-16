/* ───────────────────────────────────────────────────────────────────────────
 * The group's master schedule CSV → typed cells.
 *
 * The department publishes one wide sheet per block: row 1 is a run of date
 * columns, every later row is one physician's schedule code and their cell for
 * each of those dates. This module turns that into (provider, date, code)
 * triples and nothing more — it deliberately knows NOTHING about what any code
 * MEANS. Deciphering "pPaoliCall" belongs one layer up, where it can be argued
 * about and corrected; parsing belongs here, where it can be pinned by tests.
 *
 * ── THE FOUR SHAPES THAT BITE ──────────────────────────────────────────────
 * 1. SECTION HEADERS. Rows whose label is a site heading ("Home- Physician
 *    BMH") and whose body is entirely empty. They group the rows beneath them.
 *    The trap: a physician with no assignments in the window ALSO has an empty
 *    body, so "empty row" is not a safe test for a heading — HOSL and MARR are
 *    real people. Headings are matched on their text.
 * 2. REPEATED PROVIDERS. A physician can occupy two rows. The second carries a
 *    SECOND assignment on the dates it fills (a day shift plus an evening
 *    call, say). Collapsing them loses one of the two.
 * 3. THE TRAILING ASTERISK. ~200 cells carry one (`C1*`, `pPaoli2*`). Its
 *    meaning is not established, so the parser records the flag and the base
 *    code separately and refuses to decide anything on it.
 * 4. DATE COLUMNS run out before the row does. Trailing commas in the export
 *    produce cells past the last date; they are dropped, not misaligned onto
 *    dates that do not exist.
 * ─────────────────────────────────────────────────────────────────────────── */

/** A single filled cell: one physician, one day, one code. */
export interface MasterCell {
  /** The physician's schedule code as written in the sheet, e.g. "ANTK". */
  providerCode: string;
  /** The site section the row sat under, e.g. "BMH". */
  section: string;
  /** ISO date, YYYY-MM-DD. */
  date: string;
  /** The code with any trailing asterisk removed, e.g. "C1". */
  code: string;
  /** True when the cell was written with a trailing asterisk. */
  starred: boolean;
  /** Which of this physician's rows it came from — 0 is their first row. A
   *  cell on row 1+ is a SECOND assignment that day, not a correction. */
  rowIndex: number;
}

export interface MasterRow {
  providerCode: string;
  section: string;
  rowIndex: number;
  /** One entry per date column; null where the cell was blank. */
  cells: Array<{ code: string; starred: boolean } | null>;
}

export interface MasterSheet {
  /** ISO dates, in column order. */
  dates: string[];
  rows: MasterRow[];
  cells: MasterCell[];
  /** Section label → the rows under it, in file order. */
  sections: string[];
  /** Anything the parser could not make sense of, rather than silently
   *  dropping it. A non-empty list means the import is incomplete. */
  problems: string[];
}

/** Section headings, matched on text — see note 1. Kept deliberately narrow:
 *  a heading this does not recognise becomes a provider row with an empty
 *  schedule, which is visible and harmless, whereas treating a physician as a
 *  heading would silently swallow every row beneath them. */
const SECTION_RE = /^(Home\s*-\s*Physician|Non-Call\s+Physicians)\b/i;

/** "BMH" out of "Home- Physician BMH". */
function sectionName(label: string): string {
  return label
    .replace(/^Home\s*-\s*Physician/i, '')
    .replace(/^Physician/i, '')
    .trim() || label.trim();
}

/**
 * RFC4180-ish CSV split, done here rather than pulled in: the export quotes
 * date headers and nothing else, and a dependency for one regex is not worth
 * it. Handles quoted fields and doubled quotes inside them.
 */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; } else { quoted = false; }
      } else field += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(field); field = '';
    } else field += ch;
  }
  out.push(field);
  return out;
}

/**
 * "09/01/26" → "2026-09-01".
 *
 * Two-digit years are read as 2000+YY. The sheet covers a single block a few
 * weeks wide, so there is no century to get wrong — but the conversion is
 * explicit rather than handed to Date.parse, which reads "09/01/26" in the
 * server's local zone and can land a day early west of GMT.
 */
export function parseSheetDate(raw: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(raw.trim());
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  // Round-trip through UTC to reject 02/30 and friends, which the range check
  // above lets through.
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toISOString().slice(0, 10) === iso ? iso : null;
}

/** Strip one trailing asterisk, reporting whether there was one. Leading and
 *  trailing whitespace goes too — the export is hand-maintained. */
export function readCode(raw: string): { code: string; starred: boolean } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const starred = trimmed.endsWith('*');
  const code = (starred ? trimmed.slice(0, -1) : trimmed).trim();
  return code ? { code, starred } : null;
}

export function parseMasterCsv(text: string): MasterSheet {
  const problems: string[] = [];
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length === 0) {
    return { dates: [], rows: [], cells: [], sections: [], problems: ['The file is empty.'] };
  }

  // ── Header: every column after the first that parses as a date ───────────
  const header = splitCsvLine(lines[0]);
  const dates: string[] = [];
  for (let i = 1; i < header.length; i++) {
    const raw = header[i].trim();
    if (!raw) continue;
    const iso = parseSheetDate(raw);
    if (iso) dates.push(iso);
    else problems.push(`Header column ${i + 1} is not a date: ${JSON.stringify(raw)}`);
  }
  if (dates.length === 0) problems.push('No date columns were found in the header row.');

  const sections: string[] = [];
  const rows: MasterRow[] = [];
  const cells: MasterCell[] = [];
  const seen = new Map<string, number>();     // "section|code" → next row index
  let current = '';

  for (let li = 1; li < lines.length; li++) {
    const fields = splitCsvLine(lines[li]);
    const label = (fields[0] ?? '').trim();
    if (!label) continue;

    if (SECTION_RE.test(label)) {
      current = sectionName(label);
      if (!sections.includes(current)) sections.push(current);
      continue;
    }

    if (!current) {
      // A provider row before any heading has no site. Recorded rather than
      // guessed at: assigning it to the first section would put somebody at a
      // hospital they may not work at.
      problems.push(`Row ${li + 1} (${label}) appears before any site heading and was skipped.`);
      continue;
    }

    const key = `${current}|${label}`;
    const rowIndex = seen.get(key) ?? 0;
    seen.set(key, rowIndex + 1);

    const rowCells: MasterRow['cells'] = [];
    for (let d = 0; d < dates.length; d++) {
      // fields[0] is the label, so date d sits at field d + 1. A row shorter
      // than the header is padded with blanks rather than misaligned.
      const parsed = readCode(fields[d + 1] ?? '');
      rowCells.push(parsed);
      if (parsed) {
        cells.push({
          providerCode: label,
          section: current,
          date: dates[d],
          code: parsed.code,
          starred: parsed.starred,
          rowIndex,
        });
      }
    }

    rows.push({ providerCode: label, section: current, rowIndex, cells: rowCells });
  }

  return { dates, rows, cells, sections, problems };
}

/** Every distinct code in the sheet with its count, commonest first — the
 *  inventory a reviewer checks a proposed mapping against. */
export function codeInventory(sheet: MasterSheet): Array<{ code: string; count: number; starred: number }> {
  const counts = new Map<string, { count: number; starred: number }>();
  for (const c of sheet.cells) {
    const acc = counts.get(c.code) || { count: 0, starred: 0 };
    acc.count++;
    if (c.starred) acc.starred++;
    counts.set(c.code, acc);
  }
  return [...counts.entries()]
    .map(([code, v]) => ({ code, ...v }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

/** Provider codes that occupy more than one row — each extra row is a second
 *  assignment on the dates it fills. */
export function repeatedProviders(sheet: MasterSheet): string[] {
  const max = new Map<string, number>();
  for (const r of sheet.rows) {
    max.set(r.providerCode, Math.max(max.get(r.providerCode) ?? 0, r.rowIndex));
  }
  return [...max.entries()].filter(([, i]) => i > 0).map(([code]) => code).sort();
}
