import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { readXlsx, colToIndex, indexToCol } from './xlsx';
import { buildXlsxBytes } from './__fixtures__/buildXlsx';

const REAL_GRID = readFileSync(
  path.join(__dirname, '__fixtures__', 'paoli-11-week-block.xlsx'),
);

describe('readXlsx — real Google-Sheets export (DEFLATE + sharedStrings + cached formulas)', () => {
  const wb = readXlsx(REAL_GRID);
  const sheet = wb.sheets[0];

  it('lists the single sheet by its workbook name', () => {
    expect(wb.sheets.map((s) => s.name)).toEqual(['Sheet1']);
  });

  it('resolves shared strings (provider names)', () => {
    expect(sheet.cells.get('A3')?.value).toBe('Amusa');
    expect(sheet.cells.get('A12')?.value).toBe('Jones');
  });

  it('preserves trailing whitespace in shared strings (Simon )', () => {
    expect(sheet.cells.get('A10')?.value).toBe('Simon ');
  });

  it('reads numeric cells as numbers with decimals preserved', () => {
    expect(sheet.cells.get('B8')?.value).toBe(0.75);
    expect(sheet.cells.get('B9')?.value).toBe(0.5);
    expect(sheet.cells.get('B14')?.value).toBe(8.75);
  });

  it('reads the cached value of formula cells', () => {
    // D3 holds a formula; its cached <v> is 4.
    expect(sheet.cells.get('D3')?.value).toBe(4);
  });

  it('reads two-header-row labels', () => {
    expect(sheet.cells.get('D1')?.value).toBe('M-Th');
    expect(sheet.cells.get('D2')?.value).toBe('C1');
    expect(sheet.cells.get('L2')?.value).toBe('Neuro F/S/S');
  });
});

describe('readXlsx — synthetic STORE workbook (inline strings)', () => {
  it('round-trips strings, numbers, entities, and trailing spaces', () => {
    const bytes = buildXlsxBytes([
      { name: 'Decoy', rows: [['x']] },
      {
        name: 'Data',
        rows: [
          ['a & b', '<tag>', 'trail '],
          [1.5, 0.5, 42],
        ],
      },
    ]);
    const wb = readXlsx(bytes);
    expect(wb.sheets.map((s) => s.name)).toEqual(['Decoy', 'Data']);
    const data = wb.sheets[1];
    expect(data.cells.get('A1')?.value).toBe('a & b');
    expect(data.cells.get('B1')?.value).toBe('<tag>');
    expect(data.cells.get('C1')?.value).toBe('trail ');
    expect(data.cells.get('A2')?.value).toBe(1.5);
    expect(data.cells.get('B2')?.value).toBe(0.5);
    expect(data.cells.get('C2')?.value).toBe(42);
  });

  it('omitted cells are absent, maxRow reflects content', () => {
    const wb = readXlsx(buildXlsxBytes([{ name: 'S', rows: [['a'], [], ['', 7]] }]));
    const s = wb.sheets[0];
    expect(s.cells.get('A2')).toBeUndefined();
    expect(s.cells.get('A3')).toBeUndefined();
    expect(s.cells.get('B3')?.value).toBe(7);
    expect(s.maxRow).toBe(3);
  });
});

describe('column ref helpers', () => {
  it('converts letters to 1-based indices and back', () => {
    expect(colToIndex('A')).toBe(1);
    expect(colToIndex('M')).toBe(13);
    expect(colToIndex('AA')).toBe(27);
    expect(indexToCol(1)).toBe('A');
    expect(indexToCol(13)).toBe('M');
    expect(indexToCol(27)).toBe('AA');
  });
});
