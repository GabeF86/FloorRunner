import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { readXlsx } from './xlsx';
import { locateTargetSheet } from './locateSheet';
import { buildXlsxBytes } from './__fixtures__/buildXlsx';
import { buildSyntheticFullWorkbook } from './__fixtures__/syntheticFullWorkbook';

const REAL_GRID = readFileSync(
  path.join(__dirname, '__fixtures__', 'paoli-11-week-block.xlsx'),
);

describe('locateTargetSheet — real simpler grid (shape: grid)', () => {
  const { located, errors } = locateTargetSheet(readXlsx(REAL_GRID));

  it('locates by headers with no errors', () => {
    expect(errors).toEqual([]);
    expect(located).toBeDefined();
    expect(located!.sheetName).toBe('Sheet1');
    expect(located!.shape).toBe('grid');
  });

  it('maps the grid columns (Weeks column between FTE and first target)', () => {
    expect(located!.nameCol).toBe(1); // A
    expect(located!.fteCol).toBe(2); // B
    expect(located!.buckets).toEqual({
      MTH_C1: 4, // D
      MTH_C2: 5, // E
      FRI_C1: 6, // F
      FRI_C2: 7, // G
      SAT_C1: 8, // H
      SAT_C2: 9, // I
      SUN_C1: 10, // J
      SUN_C2: 11, // K
      NEURO_FSS: 12, // L — "Neuro F/S/S"
    });
    expect(located!.dataStartRow).toBe(3);
  });

  it('grid shape has no free-text constraint columns (trailing summary columns must not be misread)', () => {
    expect(located!.noCallCol).toBeNull();
    expect(located!.mandatoryCol).toBeNull();
  });
});

describe('locateTargetSheet — synthetic full workbook (shape: full, A:M)', () => {
  const { located, errors } = locateTargetSheet(readXlsx(buildSyntheticFullWorkbook()));

  it('finds Sheet4 by headers, not by sheet order or name', () => {
    expect(errors).toEqual([]);
    expect(located!.sheetName).toBe('Sheet4');
    expect(located!.shape).toBe('full');
  });

  it('maps A:M — name A, FTE B, targets C:K, no-call L, mandatory M', () => {
    expect(located!.nameCol).toBe(1);
    expect(located!.fteCol).toBe(2);
    expect(located!.buckets).toEqual({
      MTH_C1: 3,
      MTH_C2: 4,
      FRI_C1: 5,
      FRI_C2: 6,
      SAT_C1: 7,
      SAT_C2: 8,
      SUN_C1: 9,
      SUN_C2: 10,
      NEURO_FSS: 11,
    });
    expect(located!.noCallCol).toBe(12); // L
    expect(located!.mandatoryCol).toBe(13); // M
    expect(located!.dataStartRow).toBe(3);
  });
});

describe('locateTargetSheet — no matching headers', () => {
  it('reports a hard error instead of guessing', () => {
    const wb = readXlsx(
      buildXlsxBytes([{ name: 'Sheet4', rows: [['Totally'], ['Unrelated', 1]] }]),
    );
    const { located, errors } = locateTargetSheet(wb);
    expect(located).toBeUndefined();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toMatch(/header/i);
  });
});
