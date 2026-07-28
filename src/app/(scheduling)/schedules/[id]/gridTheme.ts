// gridTheme.ts — presentational tokens + cell-background resolver for the schedule grid.
import { isHighlightColor, type HighlightColor } from '@/lib/highlightColor';

export const gridTokens = {
  // chrome (dark)
  chrome: '#1e293b',
  chromeWeekend: '#172230',
  chromeBorder: '#1e3a5f',
  chromeText: '#f1f5f9',
  chromeMuted: '#94a3b8',
  // accent (single, uniform)
  accent: '#38bdf8',
  accentStrong: '#0ea5e9',
  // body backgrounds
  bodyCell: '#ffffff',
  bodyCellHover: 'rgba(14,165,233,0.06)',
  bodyWeekend: '#edf1f6',
  bodyWeekendHover: '#e2e8f0',
  bodyHoliday: 'rgba(251,191,36,0.22)',
  bodyHolidayHover: 'rgba(251,191,36,0.32)',
  extraCall: 'rgba(14,165,233,0.18)',
  extraCallHover: 'rgba(14,165,233,0.28)',
  overPar: 'rgba(239,68,68,0.15)',
  overParHover: 'rgba(239,68,68,0.28)',
  // text / marks
  name: '#0f172a',
  open: '#dc2626',
  unassigned: '#cbd5e1',
  statusName: '#475569',
  line: '#e8edf3',
  hard: '#ef4444',
  soft: '#f59e0b',
  // PTO sell-back (2026-07-20): a live pto_sellback row means the provider IS
  // WORKING that date — red per Gabriel's explicit ask. `sellback` is the cell
  // wash (reads on the white/gray body cells the grid always uses in both app
  // themes), `sellbackMark` the strong marker/text red. Deliberately NOT wired
  // into cellBackground's pinned precedence — applied directly where sell-back
  // renders (Available virtual row + assignment-cell marker).
  sellback: 'rgba(220,38,38,0.14)',
  sellbackHover: 'rgba(220,38,38,0.24)',
  sellbackMark: '#dc2626',
  // Hover-free disambiguation from the over-par wash (rgba(239,68,68,0.15) is
  // visually near-identical to `sellback` at scan speed, and red elsewhere in
  // the grid means a problem): sell-back cells in the Available row carry a
  // SOLID inset outline + the same "SB" tag assignment cells use, so the
  // informational red never reads as a flat problem-wash.
  sellbackOutline: 'inset 0 0 0 1.5px rgba(220,38,38,0.5)',
  // ── Manual billing highlight (2026-07-28, patch42) ────────────────────────
  // A HAND-SET mark on one assignment ("which of their calls they will be able
  // to bill extra for"). Gabriel picked the three hues; the problem is that the
  // grid ALREADY washes cells in all three automatically — over-par red, extra-
  // call blue, holiday amber — and those mean something completely different.
  // Two hover-free discriminators keep the two families apart, both reusing the
  // existing token vocabulary rather than inventing a new one:
  //   1. SATURATION. The automatic washes sit at alpha 0.15–0.22; a manual mark
  //      sits at 0.42–0.55, ~2.5–3x. A computed state is a tint; a hand-set one
  //      is a painted block. Same base rgb triples as the washes they must be
  //      told apart from (239,68,68 / 14,165,233 / 251,191,36) — deliberately:
  //      the mark is meant to read as "that colour, on purpose", not as a
  //      fourth hue nobody has a key for.
  //   2. THE INSET RING. No computed state carries an outline. This is exactly
  //      the device `sellbackOutline` already established for "this red is
  //      informational, not a problem-wash" — reused here at neutral ink
  //      (gridTokens.name, rgb 15,23,42) so ONE rule covers all three colours:
  //      a dark ring means a human painted this cell.
  // NOT a corner glyph: all four corners of a ~20px data cell are already
  // claimed (validation badge top-left, lock top-right, SB bottom-left,
  // OVER/EXTRA bottom-right), so a fifth marker would overlap an existing one.
  manualHighlight: {
    blue: 'rgba(14,165,233,0.45)',
    red: 'rgba(239,68,68,0.42)',
    yellow: 'rgba(251,191,36,0.55)',
  } as Record<HighlightColor, string>,
  manualHighlightHover: {
    blue: 'rgba(14,165,233,0.58)',
    red: 'rgba(239,68,68,0.55)',
    yellow: 'rgba(251,191,36,0.70)',
  } as Record<HighlightColor, string>,
  manualHighlightOutline: 'inset 0 0 0 2px rgba(15,23,42,0.55)',
  // virtual-row category accents (label border only)
  category: { Available: '#10b981', 'Post-Call': '#8b5cf6', Off: '#94a3b8', PTO: '#f59e0b' } as Record<string, string>,
} as const;

/** Flags describing a single grid cell, used to resolve its background.
 *  By convention `isOverPar` and `isExtraCall` only apply to assigned cells
 *  (an assignment must exist for a provider to be over-par or on extra call).
 *  `manualHighlight` is likewise assignment-scoped — it is stored ON the
 *  assignment row, so an open/unassigned cell can never carry one. Optional so
 *  every pre-existing call site (which passes only the four computed states)
 *  keeps compiling and keeps behaving identically. */
export interface CellStateFlags {
  isOverPar: boolean;
  isExtraCall: boolean;
  isHoliday: boolean;
  isWeekend: boolean;
  /** Hand-set billing mark (patch42). null/undefined = no manual mark. */
  manualHighlight?: HighlightColor | null;
}

/** Resolve a data-cell background. The *precedence* (highest first:
 *  MANUAL HIGHLIGHT › over-par › extra-call › holiday › weekend › base). The
 *  computed tail (over-par › extra-call › holiday › weekend › base)
 *  intentionally mirrors the pre-redesign inline logic so state priority can't
 *  silently shift. The color *values* are deliberately new for the redesign
 *  (e.g. weekend is now a neutral gray instead of an indigo tint, over-par is a
 *  lighter red wash).
 *
 *  The manual mark sits ABOVE the whole chain — every state below it is
 *  COMPUTED, and a hand-set colour is an explicit override of every one of
 *  them. A manually-marked cell that is also over-par renders the manual
 *  colour (gridTheme.test.ts pins this); the OVER tag still renders, so the
 *  computed state is never hidden, only out-ranked for the wash.
 *
 *  The isHighlightColor guard is deliberate: a value that is not one of the
 *  three (a pre-patch row, a hand-edited DB row, a future fourth colour served
 *  to old code) must fall through to the computed chain, never index the token
 *  map to `undefined` and blank the cell. */
export function cellBackground(s: CellStateFlags, hover = false): string {
  if (isHighlightColor(s.manualHighlight)) {
    return hover
      ? gridTokens.manualHighlightHover[s.manualHighlight]
      : gridTokens.manualHighlight[s.manualHighlight];
  }
  if (s.isOverPar) return hover ? gridTokens.overParHover : gridTokens.overPar;
  if (s.isExtraCall) return hover ? gridTokens.extraCallHover : gridTokens.extraCall;
  if (s.isHoliday) return hover ? gridTokens.bodyHolidayHover : gridTokens.bodyHoliday;
  if (s.isWeekend) return hover ? gridTokens.bodyWeekendHover : gridTokens.bodyWeekend;
  return hover ? gridTokens.bodyCellHover : gridTokens.bodyCell;
}

/** The inset ring that identifies a HAND-PAINTED cell, or undefined for every
 *  computed state. Paired with cellBackground so the two can never disagree
 *  about whether a cell is manually marked: both key off the same guarded
 *  field. Returned as a `boxShadow` value (same mechanism as sellbackOutline —
 *  it draws inside the cell's border box without disturbing the grid's 1px
 *  separators or the today/Saturday border-left accents). */
export function cellOutline(s: CellStateFlags): string | undefined {
  return isHighlightColor(s.manualHighlight) ? gridTokens.manualHighlightOutline : undefined;
}

/** Tooltip line for a manually-marked cell, appended to whatever the cell's
 *  computed title already says so the manual mark never REPLACES the over-par /
 *  extra-call / sell-back explanation it out-ranks visually. */
export function manualHighlightTitle(color: HighlightColor): string {
  return `Manually marked ${color} — billable extra call. Right-click to change or clear.`;
}
