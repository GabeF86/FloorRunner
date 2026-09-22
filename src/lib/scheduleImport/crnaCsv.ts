/* ───────────────────────────────────────────────────────────────────────────
 * The CRNA master sheet.
 *
 * A sibling of masterCsv.ts, not a replacement. The two files look alike and
 * differ in one structural way: the PHYSICIAN sheet groups rows under site
 * headings ("Home- Physician BMH"), and this one has no headings at all. Every
 * CRNA row is simply a person, and the site is carried by each CELL:
 *
 *     cLank8   Lankenau, 8-hour day
 *     cBM10    Bryn Mawr, 10-hour day
 *     cPaoli12 Paoli, 12-hour day
 *
 * Feeding this file to parseMasterCsv would skip all 162 rows — it refuses a
 * row that appears before any heading, deliberately, because in THAT sheet a
 * row with no section has no site. Here the absence of headings is the format,
 * not a fault, so it gets its own reader rather than a flag that loosens the
 * other one.
 *
 * ── cOrthoBM BEFORE cBM ───────────────────────────────────────────────────
 * The prefix table is ORDERED and must stay ordered. "cOrthoBM8" begins with
 * neither "cBM" nor "cLank", but "cOrthoBM" and "cBM" both appear inside it if
 * you match loosely — and a plain longest-first sort is not enough to make
 * that safe to reason about. 204 Orthopedic Surgical cells land at Bryn Mawr
 * if this order is disturbed, and nothing would look wrong: they are real
 * shifts on real days for real people, at the wrong hospital.
 * ─────────────────────────────────────────────────────────────────────────── */

import {
  splitCsvLine, parseSheetDate, readCode,
  type MasterSheet, type MasterRow, type MasterCell,
} from './masterCsv';

/** Source prefix → site short_name. ORDER MATTERS — see the header. */
export const CRNA_SITE_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ['cOrthoBM', 'OSC'],
  ['cLank', 'LMC'],
  ['cPaoli', 'PH'],
  ['cBM', 'BMH'],
  ['cRoth', 'RSH'],
] as const;

/** The whole sheet is one discipline, so there is no section to derive. Rows
 *  still carry one because MasterRow requires it and the reporting uses it. */
export const CRNA_SECTION = 'CRNA';

export interface CrnaCode {
  /** Site short_name the cell belongs to. */
  site: string;
  /** The shift code as created in the database — the source suffix with the
   *  site stripped and the group's own `c` kept. `cLank8` → `c8`. */
  shiftCode: string;
  /** True for the post-call MARKER codes (cLankPC, cPaoliPC). These are not
   *  shifts: the rest day is implied by the call shift's post-call rule, and
   *  writing a zero-hour row for it would put a phantom line on every grid. */
  postCall: boolean;
}

/**
 * Split a source code into its site and its shift.
 *
 * Returns null for anything that does not begin with a known site prefix —
 * reported by the caller rather than guessed at. An unrecognised code is a
 * code somebody added to the spreadsheet, and inventing a site for it would
 * file real work at the wrong hospital.
 */
export function parseCrnaCode(raw: string): CrnaCode | null {
  const code = raw.trim();
  for (const [prefix, site] of CRNA_SITE_PREFIXES) {
    if (!code.startsWith(prefix)) continue;
    const suffix = code.slice(prefix.length);
    if (!suffix) return null;
    if (suffix === 'PC') return { site, shiftCode: '', postCall: true };
    // Spaces exist in the source ("cPaoliTrBeep 7a-3p") and are not part of
    // the stored code.
    return { site, shiftCode: `c${suffix.replace(/\s+/g, '')}`, postCall: false };
  }
  return null;
}

/**
 * Read the CRNA sheet.
 *
 * Shaped as a MasterSheet so the rest of the import pipeline — planImport, the
 * conflict reports, the leave-run collapsing — is shared with the physician
 * path. Two implementations of "turn cells into assignments" would drift, and
 * the one that drifted would be the one nobody was looking at.
 */
export function parseCrnaCsv(text: string): MasterSheet {
  const problems: string[] = [];
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length === 0) {
    return { dates: [], rows: [], cells: [], sections: [], problems: ['The file is empty.'] };
  }

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

  const rows: MasterRow[] = [];
  const cells: MasterCell[] = [];
  // A provider listed twice gets a second row rather than being merged here —
  // the live sheet has one (OdonR appears on two lines) and silently folding
  // them would hide a duplicate that may be two different people.
  const seen = new Map<string, number>();

  for (let li = 1; li < lines.length; li++) {
    const fields = splitCsvLine(lines[li]);
    const label = (fields[0] ?? '').trim();
    if (!label) continue;

    const rowIndex = seen.get(label) ?? 0;
    seen.set(label, rowIndex + 1);

    const rowCells: MasterRow['cells'] = [];
    for (let d = 0; d < dates.length; d++) {
      const parsed = readCode(fields[d + 1] ?? '');
      rowCells.push(parsed);
      if (parsed) {
        cells.push({
          providerCode: label,
          section: CRNA_SECTION,
          date: dates[d],
          code: parsed.code,
          starred: parsed.starred,
          rowIndex,
        });
      }
    }
    rows.push({ providerCode: label, section: CRNA_SECTION, rowIndex, cells: rowCells });
  }

  return { dates, rows, cells, sections: [CRNA_SECTION], problems };
}

/** Providers listed on more than one line, with how many lines each. The live
 *  sheet has one; it is a finding, not a parse error. */
export function duplicateRows(sheet: MasterSheet): Array<{ code: string; rows: number }> {
  const n = new Map<string, number>();
  for (const r of sheet.rows) n.set(r.providerCode, (n.get(r.providerCode) ?? 0) + 1);
  return [...n.entries()].filter(([, c]) => c > 1).map(([code, rows]) => ({ code, rows }));
}
