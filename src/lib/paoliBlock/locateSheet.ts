/**
 * Locate the Paoli block worksheet BY ITS HEADERS, never by sheet name or
 * position (the prompt's workbook uses `Sheet4`; the simpler targets grid
 * uses `Sheet1`; both must resolve identically).
 *
 * Recognized header band: two consecutive rows where the upper row carries
 * the day-group labels (M-Th, Friday, Saturday, Sunday, in column order)
 * and the lower row carries FTE, a C1/C2 pair under each group, and a
 * Neuro column after Sunday C2.
 *
 * Two shapes:
 *  - `full` (prompt workbook, A:M): first target column is immediately
 *    after FTE; the two columns after Neuro are the free-text constraint
 *    columns (L = no-call/prohibitions, M = mandatory/exceptions).
 *  - `grid` (simpler targets grid): one extra column (Weeks) between FTE
 *    and the first target; no constraint columns. Trailing summary columns
 *    (Total C1, Weekend C1/C2, second "Neuro"…) must NOT be misread —
 *    bucket detection is anchored to the day-group labels and stops at the
 *    first Neuro-labelled column after Sunday C2.
 */

import type { XlsxSheet, XlsxWorkbook } from './xlsx';
import { cellValue } from './xlsx';
import type { BucketKey } from './manifest';

export type WorkbookShape = 'full' | 'grid';

export interface LocatedSheet {
  sheetName: string;
  shape: WorkbookShape;
  /** [upper, lower] 1-based header row numbers. */
  headerRows: [number, number];
  nameCol: number;
  fteCol: number;
  buckets: Record<BucketKey, number>;
  noCallCol: number | null;
  mandatoryCol: number | null;
  dataStartRow: number;
}

export interface LocateResult {
  located?: LocatedSheet;
  /** Non-fatal notes (e.g. more than one sheet matched). */
  warnings: string[];
  /** Hard errors — empty iff located is set. */
  errors: string[];
}

const GROUP_PATTERNS: Array<{ key: 'MTH' | 'FRI' | 'SAT' | 'SUN'; re: RegExp }> = [
  { key: 'MTH', re: /^(m\s*[-–]\s*th|mon(day)?\s*[-–]\s*thu(rs(day)?)?)$/i },
  { key: 'FRI', re: /^fri(day)?$/i },
  { key: 'SAT', re: /^sat(urday)?$/i },
  { key: 'SUN', re: /^sun(day)?$/i },
];

const MAX_HEADER_SCAN_ROWS = 30;
const MAX_SCAN_COLS = 40;

function textAt(sheet: XlsxSheet, col: number, row: number): string {
  const v = cellValue(sheet, col, row);
  return typeof v === 'string' ? v.trim() : '';
}

function findHeaderBand(sheet: XlsxSheet): LocatedSheet | null {
  const maxRow = Math.min(sheet.maxRow, MAX_HEADER_SCAN_ROWS);
  const maxCol = Math.min(sheet.maxCol, MAX_SCAN_COLS);

  for (let upper = 1; upper < maxRow; upper++) {
    const lower = upper + 1;

    // 1. Day-group labels on the upper row, in strictly increasing column order.
    const groupCols: number[] = [];
    let searchFrom = 1;
    let allFound = true;
    for (const g of GROUP_PATTERNS) {
      let found = -1;
      for (let c = searchFrom; c <= maxCol; c++) {
        if (g.re.test(textAt(sheet, c, upper))) {
          found = c;
          break;
        }
      }
      if (found < 0) {
        allFound = false;
        break;
      }
      groupCols.push(found);
      searchFrom = found + 1;
    }
    if (!allFound) continue;

    // 2. C1/C2 pair under each group label (bounded by the next group).
    const pairBounds = groupCols.map((g, i) =>
      i + 1 < groupCols.length ? groupCols[i + 1] : g + 4,
    );
    const pairs: Array<[number, number]> = [];
    let pairsOk = true;
    for (let i = 0; i < groupCols.length; i++) {
      let c1 = -1;
      let c2 = -1;
      for (let c = groupCols[i]; c < pairBounds[i] && c <= maxCol; c++) {
        const t = textAt(sheet, c, lower).toUpperCase();
        if (t === 'C1' && c1 < 0) c1 = c;
        else if (t === 'C2' && c1 >= 0 && c2 < 0) c2 = c;
      }
      if (c1 < 0 || c2 < 0) {
        pairsOk = false;
        break;
      }
      pairs.push([c1, c2]);
    }
    if (!pairsOk) continue;

    // 3. First Neuro-labelled column after Sunday C2 (bounded — a later
    //    summary "Neuro" column must not win).
    const sunC2 = pairs[3][1];
    let neuroCol = -1;
    for (let c = sunC2 + 1; c <= Math.min(sunC2 + 4, maxCol); c++) {
      if (/neuro/i.test(textAt(sheet, c, lower))) {
        neuroCol = c;
        break;
      }
    }
    if (neuroCol < 0) continue;

    // 4. FTE column left of the first target column.
    let fteCol = -1;
    for (let c = 1; c < pairs[0][0]; c++) {
      if (/^fte$/i.test(textAt(sheet, c, lower))) {
        fteCol = c;
        break;
      }
    }
    if (fteCol < 1 || fteCol < 2) continue; // need a name column to its left
    const nameCol = fteCol - 1;

    // 5. Shape from the FTE→first-target distance.
    const firstTarget = pairs[0][0];
    let shape: WorkbookShape;
    if (firstTarget === fteCol + 1) shape = 'full';
    else if (firstTarget === fteCol + 2) shape = 'grid';
    else continue;

    return {
      sheetName: sheet.name,
      shape,
      headerRows: [upper, lower],
      nameCol,
      fteCol,
      buckets: {
        MTH_C1: pairs[0][0],
        MTH_C2: pairs[0][1],
        FRI_C1: pairs[1][0],
        FRI_C2: pairs[1][1],
        SAT_C1: pairs[2][0],
        SAT_C2: pairs[2][1],
        SUN_C1: pairs[3][0],
        SUN_C2: pairs[3][1],
        NEURO_FSS: neuroCol,
      },
      noCallCol: shape === 'full' ? neuroCol + 1 : null,
      mandatoryCol: shape === 'full' ? neuroCol + 2 : null,
      dataStartRow: lower + 1,
    };
  }
  return null;
}

export function locateTargetSheet(wb: XlsxWorkbook): LocateResult {
  const warnings: string[] = [];
  const matches: LocatedSheet[] = [];
  for (const sheet of wb.sheets) {
    const band = findHeaderBand(sheet);
    if (band) matches.push(band);
  }
  if (!matches.length) {
    return {
      warnings,
      errors: [
        'no worksheet with the expected header band found ' +
          '(day-group labels M-Th/Friday/Saturday/Sunday over an FTE + C1/C2 + Neuro row)',
      ],
    };
  }
  if (matches.length > 1) {
    warnings.push(
      `multiple sheets matched the header band (${matches
        .map((m) => m.sheetName)
        .join(', ')}); using the first: ${matches[0].sheetName}`,
    );
  }
  return { located: matches[0], warnings, errors: [] };
}
