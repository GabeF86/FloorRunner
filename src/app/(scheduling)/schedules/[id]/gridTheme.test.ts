import { describe, it, expect } from 'vitest';
import { gridTokens, cellBackground, cellOutline, manualHighlightTitle } from './gridTheme';
import { HIGHLIGHT_COLORS, type HighlightColor } from '@/lib/highlightColor';

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

  // Absence of the field must be byte-identical to the pre-patch42 behaviour —
  // every existing call site passes only the four computed flags.
  it('an absent / null manual highlight changes nothing about the computed chain', () => {
    expect(cellBackground({ ...base, isOverPar: true, manualHighlight: null })).toBe(gridTokens.overPar);
    expect(cellBackground({ ...base, isWeekend: true, manualHighlight: undefined })).toBe(gridTokens.bodyWeekend);
    expect(cellBackground({ ...base, manualHighlight: null })).toBe(gridTokens.bodyCell);
  });

  it('an absent / false unfilled-call flag changes nothing about the computed chain', () => {
    expect(cellBackground({ ...base, isWeekend: true, isUnfilledCall: false })).toBe(gridTokens.bodyWeekend);
    expect(cellBackground({ ...base, isHoliday: true, isUnfilledCall: undefined })).toBe(gridTokens.bodyHoliday);
    expect(cellBackground({ ...base })).toBe(gridTokens.bodyCell);
  });
});

// ── Unfilled call (2026-07-29) ───────────────────────────────────────────────
// The new state beats the two AMBIENT DATE washes it can actually co-occur
// with, and sits under the three assignment-scoped states it can never be.
describe('cellBackground: an unfilled call slot', () => {
  const base = { isOverPar: false, isExtraCall: false, isHoliday: false, isWeekend: false };

  it('paints a plain cell the solid open red', () => {
    expect(cellBackground({ ...base, isUnfilledCall: true })).toBe(gridTokens.openCall);
    expect(cellBackground({ ...base, isUnfilledCall: true }, true)).toBe(gridTokens.openCallHover);
  });

  // THE MUTATION PROOF for the placement. Both ambient date washes are on at
  // once — an open call on a holiday that falls on a weekend, the loudest cell
  // on the grid. Delete the unfilled branch from cellBackground and this
  // returns the holiday amber; move it below holiday and it returns the same.
  it('beats the holiday amber AND the weekend gray', () => {
    const flags = { ...base, isHoliday: true, isWeekend: true, isUnfilledCall: true };
    expect(cellBackground(flags)).toBe(gridTokens.openCall);
    expect(cellBackground(flags)).not.toBe(gridTokens.bodyHoliday);
    expect(cellBackground(flags)).not.toBe(gridTokens.bodyWeekend);
    expect(cellBackground(flags, true)).toBe(gridTokens.openCallHover);
  });

  // Assignment-scoped states can never co-occur with it (an unfilled cell has
  // no assignment to be over-par on, pick up extra, or carry a hand-set mark),
  // so the pinned computed tail keeps its documented order for every cell that
  // can actually reach it.
  it('loses to over-par, extra-call and a hand-set mark', () => {
    expect(cellBackground({ ...base, isUnfilledCall: true, isOverPar: true })).toBe(gridTokens.overPar);
    expect(cellBackground({ ...base, isUnfilledCall: true, isExtraCall: true })).toBe(gridTokens.extraCall);
    expect(cellBackground({ ...base, isUnfilledCall: true, manualHighlight: 'red' }))
      .toBe(gridTokens.manualHighlight.red);
  });

  // It is the only SOLID fill in the chain — every other state is a tint that
  // has to stay legible under a provider's name. An unfilled cell has no name,
  // which is exactly why it may be solid.
  it('is a solid colour, unlike every rgba wash it shares the grid with', () => {
    expect(gridTokens.openCall).toMatch(/^#[0-9a-f]{6}$/i);
    expect(gridTokens.openCallHover).toMatch(/^#[0-9a-f]{6}$/i);
    for (const wash of [
      gridTokens.overPar, gridTokens.overParHover, gridTokens.extraCall,
      gridTokens.bodyHoliday, gridTokens.sellback,
      ...Object.values(gridTokens.manualHighlight),
    ]) {
      expect(gridTokens.openCall).not.toBe(wash);
      expect(gridTokens.openCallHover).not.toBe(wash);
    }
  });

  // No new hue enters the vocabulary: the fill is the red OPEN text has always
  // used, and the hover is the OVER tag's deeper red.
  it('reuses reds the grid already has', () => {
    expect(gridTokens.openCall).toBe(gridTokens.open);
  });
});

// ── Manual billing highlight (patch42) ───────────────────────────────────────
// The manual mark sits ABOVE the whole pinned chain: everything below it is a
// COMPUTED state, and a hand-set colour is an explicit override of every one.
describe('cellBackground: manual highlight out-ranks every computed state', () => {
  const base = { isOverPar: false, isExtraCall: false, isHoliday: false, isWeekend: false };

  it.each(HIGHLIGHT_COLORS)('%s beats a plain cell', (color) => {
    expect(cellBackground({ ...base, manualHighlight: color })).toBe(gridTokens.manualHighlight[color]);
  });

  // THE MUTATION PROOF. Every computed flag is true at once — the state that
  // would otherwise resolve to gridTokens.overPar, the top of the pinned
  // chain. If the manual branch is deleted from cellBackground, this returns
  // the over-par red and the assertion fails.
  it.each(HIGHLIGHT_COLORS)('%s wins on a cell that is ALSO over-par, extra-call, holiday and weekend', (color) => {
    const flags = {
      isOverPar: true, isExtraCall: true, isHoliday: true, isWeekend: true,
      manualHighlight: color,
    };
    expect(cellBackground(flags)).toBe(gridTokens.manualHighlight[color]);
    expect(cellBackground(flags)).not.toBe(gridTokens.overPar);
    expect(cellBackground(flags, true)).toBe(gridTokens.manualHighlightHover[color]);
    expect(cellBackground(flags, true)).not.toBe(gridTokens.overParHover);
  });

  // Each manual token must be unmistakable against the automatic wash of the
  // SAME hue that can sit on the same screen: manual blue vs extra-call blue,
  // manual red vs over-par red, manual yellow vs the holiday amber.
  it('is never byte-equal to the automatic wash of the same hue', () => {
    const automatic = [
      gridTokens.overPar, gridTokens.overParHover,
      gridTokens.extraCall, gridTokens.extraCallHover,
      gridTokens.bodyHoliday, gridTokens.bodyHolidayHover,
      gridTokens.sellback, gridTokens.sellbackHover,
      gridTokens.bodyCell, gridTokens.bodyCellHover,
      gridTokens.bodyWeekend, gridTokens.bodyWeekendHover,
    ];
    for (const color of HIGHLIGHT_COLORS) {
      expect(automatic).not.toContain(gridTokens.manualHighlight[color]);
      expect(automatic).not.toContain(gridTokens.manualHighlightHover[color]);
    }
  });

  // Saturation is the first of the two discriminators, and the claim is
  // per-HUE: what a manual mark can actually be confused with is the automatic
  // wash of the SAME colour sitting on the same screen. Manual blue vs the
  // extra-call blue, manual red vs the over-par red (and the sell-back red),
  // manual yellow vs the holiday amber. Each must be at least 2x its rival.
  it('each manual token is at least twice the alpha of the automatic wash it could be confused with', () => {
    const alpha = (rgba: string) => Number(rgba.match(/,\s*([0-9.]+)\)$/)?.[1]);
    const rivals: Record<HighlightColor, string[]> = {
      blue: [gridTokens.extraCall],
      red: [gridTokens.overPar, gridTokens.sellback],
      yellow: [gridTokens.bodyHoliday],
    };
    for (const color of HIGHLIGHT_COLORS) {
      const manual = alpha(gridTokens.manualHighlight[color]);
      // Every automatic wash is a TINT; every manual mark is a painted block.
      for (const rival of rivals[color]) {
        expect(alpha(rival)).toBeLessThanOrEqual(0.22);
        expect(manual).toBeGreaterThanOrEqual(alpha(rival) * 2);
      }
      expect(manual).toBeGreaterThanOrEqual(0.42);
    }
  });

  // Same base rgb triple as the wash it out-ranks, on purpose: the mark should
  // read as "that colour, deliberately", not as a fourth hue with no key.
  it('reuses the existing hue triples rather than inventing new ones', () => {
    const rgb = (rgba: string) => rgba.slice(0, rgba.lastIndexOf(','));
    expect(rgb(gridTokens.manualHighlight.blue)).toBe(rgb(gridTokens.extraCall));
    expect(rgb(gridTokens.manualHighlight.red)).toBe(rgb(gridTokens.overPar));
    expect(rgb(gridTokens.manualHighlight.yellow)).toBe(rgb(gridTokens.bodyHoliday));
  });

  // A value outside the vocabulary (pre-patch row, hand-edited DB row, a
  // future fourth colour served to old code) must fall through to the computed
  // chain, never index the token map to `undefined` and blank the cell.
  it('an out-of-vocabulary colour falls through to the computed chain', () => {
    const rogue = { ...base, isOverPar: true, manualHighlight: 'green' as unknown as HighlightColor };
    expect(cellBackground(rogue)).toBe(gridTokens.overPar);
    expect(cellOutline(rogue)).toBeUndefined();
  });
});

// The second discriminator: no computed state carries an outline, so a dark
// inset ring means exactly one thing — a human painted this cell.
describe('cellOutline', () => {
  const base = { isOverPar: false, isExtraCall: false, isHoliday: false, isWeekend: false };

  it.each(HIGHLIGHT_COLORS)('%s carries the manual inset ring', (color) => {
    expect(cellOutline({ ...base, manualHighlight: color })).toBe(gridTokens.manualHighlightOutline);
  });

  it('no computed state carries a ring — not even all five at once', () => {
    expect(cellOutline(base)).toBeUndefined();
    expect(cellOutline({
      isOverPar: true, isExtraCall: true, isHoliday: true, isWeekend: true, isUnfilledCall: true,
    })).toBeUndefined();
  });

  it('the manual ring is distinct from the sell-back ring (different marks, different meanings)', () => {
    expect(gridTokens.manualHighlightOutline).not.toBe(gridTokens.sellbackOutline);
  });
});

describe('manualHighlightTitle', () => {
  it('names the colour and says how to change it', () => {
    expect(manualHighlightTitle('blue')).toBe(
      'Manually marked blue — billable extra call. Right-click to change or clear.');
  });
});
