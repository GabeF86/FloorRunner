import { describe, it, expect } from 'vitest';
import { gridTokens, cellBackground } from './gridTheme';

describe('cellBackground precedence', () => {
  const base = { isOverPar: false, isExtraCall: false, isHoliday: false, isWeekend: false };

  it('plain weekday cell is white', () => {
    expect(cellBackground(base)).toBe(gridTokens.bodyCell);
  });
  it('weekend uses the gray wash', () => {
    expect(cellBackground({ ...base, isWeekend: true })).toBe(gridTokens.bodyWeekend);
  });
  it('holiday beats weekend', () => {
    expect(cellBackground({ ...base, isWeekend: true, isHoliday: true })).toBe(gridTokens.bodyHoliday);
  });
  it('extra-call beats holiday/weekend', () => {
    expect(cellBackground({ ...base, isWeekend: true, isHoliday: true, isExtraCall: true })).toBe(gridTokens.extraCall);
  });
  it('over-par beats everything', () => {
    expect(cellBackground({ isOverPar: true, isExtraCall: true, isHoliday: true, isWeekend: true })).toBe(gridTokens.overPar);
  });
  it('hover: base cell returns the base hover variant', () => {
    expect(cellBackground(base, true)).toBe(gridTokens.bodyCellHover);
  });
  it('hover: weekend returns the weekend hover variant', () => {
    expect(cellBackground({ ...base, isWeekend: true }, true)).toBe(gridTokens.bodyWeekendHover);
  });
  it('hover: holiday returns the holiday hover variant', () => {
    expect(cellBackground({ ...base, isHoliday: true }, true)).toBe(gridTokens.bodyHolidayHover);
  });
  it('hover: extra-call returns the extra-call hover variant', () => {
    expect(cellBackground({ ...base, isExtraCall: true }, true)).toBe(gridTokens.extraCallHover);
  });
  it('hover: over-par returns the over-par hover variant', () => {
    expect(cellBackground({ ...base, isOverPar: true }, true)).toBe(gridTokens.overParHover);
  });
});
