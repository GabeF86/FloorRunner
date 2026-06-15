// gridTheme.ts — presentational tokens + cell-background resolver for the schedule grid.
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
  // virtual-row category accents (label border only)
  category: { Available: '#10b981', 'Post-Call': '#8b5cf6', Off: '#94a3b8', PTO: '#f59e0b' } as Record<string, string>,
} as const;

/** Flags describing a single grid cell, used to resolve its background.
 *  By convention `isOverPar` and `isExtraCall` only apply to assigned cells
 *  (an assignment must exist for a provider to be over-par or on extra call). */
export interface CellStateFlags {
  isOverPar: boolean;
  isExtraCall: boolean;
  isHoliday: boolean;
  isWeekend: boolean;
}

/** Resolve a data-cell background. The *precedence* (highest first:
 *  over-par › extra-call › holiday › weekend › base) intentionally mirrors the
 *  pre-redesign inline logic so state priority can't silently shift. The color
 *  *values* are deliberately new for the redesign (e.g. weekend is now a neutral
 *  gray instead of an indigo tint, over-par is a lighter red wash). */
export function cellBackground(s: CellStateFlags, hover = false): string {
  if (s.isOverPar) return hover ? gridTokens.overParHover : gridTokens.overPar;
  if (s.isExtraCall) return hover ? gridTokens.extraCallHover : gridTokens.extraCall;
  if (s.isHoliday) return hover ? gridTokens.bodyHolidayHover : gridTokens.bodyHoliday;
  if (s.isWeekend) return hover ? gridTokens.bodyWeekendHover : gridTokens.bodyWeekend;
  return hover ? gridTokens.bodyCellHover : gridTokens.bodyCell;
}
