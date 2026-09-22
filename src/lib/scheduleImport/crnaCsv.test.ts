/**
 * The CRNA sheet.
 *
 * The one that would do real damage: reading cOrthoBM as cBM. 204 cells would
 * land at the wrong hospital and nothing would look wrong — real shifts, real
 * days, real people, one site to the left.
 */
import { describe, it, expect } from 'vitest';
import { parseCrnaCsv, parseCrnaCode, duplicateRows, CRNA_SITE_PREFIXES } from './crnaCsv';

const HEADER = ',"09/01/26","09/02/26","09/03/26"';
const sheet = (...lines: string[]) => parseCrnaCsv([HEADER, ...lines].join('\n'));

describe('the code carries the site', () => {
  it('reads each site prefix', () => {
    expect(parseCrnaCode('cLank8')).toEqual({ site: 'LMC', shiftCode: 'c8', postCall: false });
    expect(parseCrnaCode('cBM10')).toEqual({ site: 'BMH', shiftCode: 'c10', postCall: false });
    expect(parseCrnaCode('cPaoli12')).toEqual({ site: 'PH', shiftCode: 'c12', postCall: false });
    expect(parseCrnaCode('cRoth8')).toEqual({ site: 'RSH', shiftCode: 'c8', postCall: false });
  });

  it('reads cOrthoBM as Orthopedic Surgical, NOT as Bryn Mawr', () => {
    // The whole reason the prefix table is ordered. 204 cells turn on it.
    expect(parseCrnaCode('cOrthoBM8')).toEqual({ site: 'OSC', shiftCode: 'c8', postCall: false });
    expect(parseCrnaCode('cOrthoBM10')).toEqual({ site: 'OSC', shiftCode: 'c10', postCall: false });
  });

  it('keeps cOrthoBM ahead of cBM in the table', () => {
    // A structural guard: reordering these silently moves a hospital.
    const keys = CRNA_SITE_PREFIXES.map(([p]) => p);
    expect(keys.indexOf('cOrthoBM')).toBeLessThan(keys.indexOf('cBM'));
  });

  it('strips the space out of a two-part code', () => {
    expect(parseCrnaCode('cPaoliTrBeep 7a-3p'))
      .toEqual({ site: 'PH', shiftCode: 'cTrBeep7a-3p', postCall: false });
  });

  it('marks PC as post-call and gives it NO shift code', () => {
    // The rest day is implied by the call shift's post-call rule. A zero-hour
    // "PC" row would put a phantom line on every grid.
    expect(parseCrnaCode('cLankPC')).toEqual({ site: 'LMC', shiftCode: '', postCall: true });
    expect(parseCrnaCode('cPaoliPC')).toEqual({ site: 'PH', shiftCode: '', postCall: true });
  });

  it('returns null for an unknown prefix rather than guessing a site', () => {
    expect(parseCrnaCode('cRiddle8')).toBeNull();
    expect(parseCrnaCode('Vac')).toBeNull();
    expect(parseCrnaCode('')).toBeNull();
  });

  it('returns null for a bare site prefix with no shift', () => {
    expect(parseCrnaCode('cLank')).toBeNull();
  });
});

describe('reading the sheet', () => {
  it('takes every row as a provider — there are no site headings', () => {
    // parseMasterCsv would skip all of these: it refuses a row before any
    // heading. Here the absence of headings IS the format.
    const s = sheet('AdamoK,cLank8,,cLankCall', 'AlexaM,cBM8,cBM8,');
    expect(s.rows.map(r => r.providerCode)).toEqual(['AdamoK', 'AlexaM']);
    expect(s.problems).toEqual([]);
  });

  it('places cells on the right dates', () => {
    const s = sheet('AdamoK,cLank8,,cLankCall');
    expect(s.cells.map(c => [c.date, c.code])).toEqual([
      ['2026-09-01', 'cLank8'],
      ['2026-09-03', 'cLankCall'],
    ]);
  });

  it('strips the note asterisk but records that it was there', () => {
    const s = sheet('AdamoK,cLank8*,,');
    expect(s.cells[0]).toMatchObject({ code: 'cLank8', starred: true });
  });

  it('keeps a provider listed TWICE as two rows', () => {
    // OdonR appears on two lines in the live sheet. Folding them here would
    // hide a duplicate that might be two different people.
    const s = sheet('OdonR,cPaoli12,,', 'OdonR,,cPaoliTrBeep,');
    expect(s.rows).toHaveLength(2);
    expect(s.rows.map(r => r.rowIndex)).toEqual([0, 1]);
    expect(duplicateRows(s)).toEqual([{ code: 'OdonR', rows: 2 }]);
  });

  it('pads a row shorter than the header instead of misaligning it', () => {
    const s = sheet('AdamoK,cLank8');
    expect(s.rows[0].cells).toHaveLength(3);
    expect(s.cells).toHaveLength(1);
  });

  it('ignores a row with no label', () => {
    const s = sheet(',cLank8,,');
    expect(s.rows).toEqual([]);
  });

  it('reports a header column that is not a date', () => {
    const s = parseCrnaCsv(',"09/01/26","notadate"\nAdamoK,cLank8,');
    expect(s.problems.join(' ')).toContain('not a date');
    expect(s.dates).toEqual(['2026-09-01']);
  });

  it('handles an empty file without throwing', () => {
    expect(parseCrnaCsv('').problems).toEqual(['The file is empty.']);
  });
});
