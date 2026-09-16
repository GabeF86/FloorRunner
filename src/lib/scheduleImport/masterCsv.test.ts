/**
 * The master-schedule CSV parser.
 *
 * Every test here is a shape the REAL export actually contains — a physician
 * with an empty row who is not a heading, a physician on two rows, a starred
 * cell, trailing commas. The parser's only job is to not lose or misplace a
 * cell, because a cell in the wrong row is one doctor's call night landing on
 * another doctor's record.
 */
import { describe, it, expect } from 'vitest';
import {
  parseMasterCsv, parseSheetDate, readCode, splitCsvLine,
  codeInventory, repeatedProviders,
} from './masterCsv';

const HEADER = ',"09/01/26","09/02/26","09/03/26"';

const sheet = (...lines: string[]) => parseMasterCsv([HEADER, ...lines].join('\n'));

describe('parseSheetDate', () => {
  it('reads the sheet\'s two-digit form', () => {
    expect(parseSheetDate('09/01/26')).toBe('2026-09-01');
    expect(parseSheetDate('11/01/26')).toBe('2026-11-01');
  });

  it('does NOT go through Date.parse, which drifts a day west of GMT', () => {
    // "09/01/26" parsed locally in UTC-5 is 2026-08-31T19:00Z, and
    // .toISOString().slice(0,10) on that is 08-31 — a whole day of call on the
    // wrong date, for every row.
    expect(parseSheetDate('09/01/26')).toBe('2026-09-01');
  });

  it('accepts a four-digit year and single-digit parts', () => {
    expect(parseSheetDate('9/1/2026')).toBe('2026-09-01');
  });

  it('rejects a date that does not exist', () => {
    expect(parseSheetDate('02/30/26')).toBeNull();
    expect(parseSheetDate('13/01/26')).toBeNull();
  });

  it('rejects anything that is not a date', () => {
    for (const junk of ['', 'Total', 'Sept', '09-01-26']) {
      expect(parseSheetDate(junk)).toBeNull();
    }
  });
});

describe('readCode', () => {
  it('separates the base code from the asterisk instead of deciding anything', () => {
    expect(readCode('C1*')).toEqual({ code: 'C1', starred: true });
    expect(readCode('C1')).toEqual({ code: 'C1', starred: false });
  });

  it('keeps codes whose names contain punctuation', () => {
    expect(readCode('pLank9a-4p*')).toEqual({ code: 'pLank9a-4p', starred: true });
    expect(readCode('1. Vac')).toEqual({ code: '1. Vac', starred: false });
    expect(readCode('pPaoli_LDay')).toEqual({ code: 'pPaoli_LDay', starred: false });
  });

  it('treats a blank cell as no cell', () => {
    expect(readCode('')).toBeNull();
    expect(readCode('   ')).toBeNull();
    expect(readCode('*')).toBeNull();
  });
});

describe('splitCsvLine', () => {
  it('keeps quoted fields whole', () => {
    expect(splitCsvLine('a,"b,c",d')).toEqual(['a', 'b,c', 'd']);
  });

  it('handles a doubled quote inside a field', () => {
    expect(splitCsvLine('a,"say ""hi""",b')).toEqual(['a', 'say "hi"', 'b']);
  });

  it('preserves trailing empty fields', () => {
    expect(splitCsvLine('a,,,')).toEqual(['a', '', '', '']);
  });
});

describe('parseMasterCsv', () => {
  it('groups rows under their site heading', () => {
    const s = sheet('Home- Physician BMH,,,', 'ANTK,C1,PostC1,');
    expect(s.sections).toEqual(['BMH']);
    expect(s.rows[0]).toMatchObject({ providerCode: 'ANTK', section: 'BMH' });
  });

  it('reads the other heading spellings the export uses', () => {
    const s = sheet(
      'Home-Physician Lankenau,,,', 'AHMB,pLank1st,,',
      'Non-Call Physicians,,,', 'NAGR,Vac,,');
    expect(s.sections).toEqual(['Lankenau', 'Non-Call Physicians']);
    expect(s.rows.map(r => r.section)).toEqual(['Lankenau', 'Non-Call Physicians']);
  });

  it('does NOT treat an empty physician row as a heading', () => {
    // HOSL and MARR are real people with nothing scheduled in the window. An
    // "is the body empty" test would make them headings and swallow every row
    // beneath them into a site that does not exist.
    const s = sheet('Home- Physician BMH,,,', 'HOSL,,,', 'ANTK,C1,,');
    expect(s.sections).toEqual(['BMH']);
    expect(s.rows.map(r => r.providerCode)).toEqual(['HOSL', 'ANTK']);
    expect(s.rows.every(r => r.section === 'BMH')).toBe(true);
  });

  it('places each cell on the right date', () => {
    const s = sheet('Home- Physician BMH,,,', 'ANTK,C1,PostC1,07_15');
    expect(s.cells.map(c => [c.date, c.code])).toEqual([
      ['2026-09-01', 'C1'],
      ['2026-09-02', 'PostC1'],
      ['2026-09-03', '07_15'],
    ]);
  });

  it('skips blanks without shifting the dates after them', () => {
    // The failure mode this guards: a blank Tuesday sliding Wednesday's call
    // onto Tuesday, and every later column with it.
    const s = sheet('Home- Physician BMH,,,', 'ANTK,C1,,07_15');
    expect(s.cells.map(c => [c.date, c.code])).toEqual([
      ['2026-09-01', 'C1'],
      ['2026-09-03', '07_15'],
    ]);
  });

  it('keeps BOTH rows when a physician appears twice', () => {
    // The second row is a second assignment that day — a day shift plus an
    // evening call. Collapsing them loses one.
    const s = sheet('Home- Physician BMH,,,', 'HELD,07_19,,', 'HELD,,PostC2,');
    expect(s.rows.map(r => r.rowIndex)).toEqual([0, 1]);
    expect(repeatedProviders(s)).toEqual(['HELD']);
    const sep2 = s.cells.filter(c => c.date === '2026-09-02');
    expect(sep2).toHaveLength(1);
    expect(sep2[0]).toMatchObject({ code: 'PostC2', rowIndex: 1 });
  });

  it('counts a repeat only within the same section', () => {
    const s = sheet(
      'Home- Physician BMH,,,', 'SORM,07_15,,',
      'Home-Physician Lankenau,,,', 'SORM,pLankDay,,');
    expect(repeatedProviders(s)).toEqual([]);
    expect(s.rows.map(r => r.rowIndex)).toEqual([0, 0]);
  });

  it('records the asterisk without acting on it', () => {
    const s = sheet('Home- Physician BMH,,,', 'DAYR,C1*,C1,');
    expect(s.cells.map(c => [c.code, c.starred])).toEqual([['C1', true], ['C1', false]]);
  });

  it('pads a row that is shorter than the header', () => {
    const s = sheet('Home- Physician BMH,,,', 'ANTK,C1');
    expect(s.rows[0].cells).toHaveLength(3);
    expect(s.cells).toHaveLength(1);
  });

  it('drops cells past the last date instead of inventing dates for them', () => {
    // The export ends most rows with a run of trailing commas.
    const s = sheet('Home- Physician BMH,,,', 'ANTK,C1,,,,,,');
    expect(s.cells).toHaveLength(1);
    expect(s.rows[0].cells).toHaveLength(3);
  });

  it('REPORTS a row that appears before any heading rather than guessing a site', () => {
    // Filing it under the first section would put a physician at a hospital
    // they may not work at.
    const s = sheet('ANTK,C1,,');
    expect(s.rows).toHaveLength(0);
    expect(s.problems.join(' ')).toContain('ANTK');
  });

  it('reports a header column that is not a date', () => {
    const s = parseMasterCsv(',"09/01/26","Total"\nHome- Physician BMH,,\nANTK,C1,X');
    expect(s.dates).toEqual(['2026-09-01']);
    expect(s.problems.join(' ')).toContain('Total');
  });

  it('reports an empty file instead of returning a clean empty sheet', () => {
    expect(parseMasterCsv('').problems).toHaveLength(1);
  });

  it('ignores blank lines between sections', () => {
    const s = parseMasterCsv([HEADER, '', 'Home- Physician BMH,,,', '', 'ANTK,C1,,'].join('\n'));
    expect(s.cells).toHaveLength(1);
  });
});

describe('codeInventory', () => {
  it('counts each code and how often it is starred', () => {
    const s = sheet(
      'Home- Physician BMH,,,',
      'ANTK,C1,C1*,PostC1',
      'DAYR,C1,,PostC1');
    expect(codeInventory(s)).toEqual([
      { code: 'C1', count: 3, starred: 1 },
      { code: 'PostC1', count: 2, starred: 0 },
    ]);
  });

  it('is empty for a sheet with no cells', () => {
    expect(codeInventory(sheet('Home- Physician BMH,,,', 'HOSL,,,'))).toEqual([]);
  });
});
