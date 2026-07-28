// Manual per-cell highlight colour (Gabriel 2026-07-28), verbatim: "I need a
// way to manually highlight cells that I consider to be extra call for that
// provider so that when they look at the finalized schedule they can see which
// of their calls they will be able to bill extra for." Then, on how it should
// interact with the grid's automatic markings: "Keep everything the same, just
// give me the ability to change the color of the cell of my choosing. Options
// just be blue and red and yellow."
//
// So this is a HAND-SET annotation, not a computed state. It is stored on the
// assignment row (scheduling.assignments.highlight_color — patch42) because it
// describes ONE provider's call, and it is deliberately a closed vocabulary:
// the DB carries a CHECK constraint over exactly these three strings, so a
// typo can never become an invisible colour.
//
// This module is the single home for that vocabulary. Both sides read it:
//   * the route-hardening gate  (PATCH /api/scheduling/schedule-assignments)
//   * the grid's colour resolver (schedules/[id]/gridTheme.ts)
// Keeping it in src/lib (not next to the page) matches the established
// route-hardening parser idiom — providerLimits.ts, scheduleName.ts — and lets
// an API route import it without reaching into an app route group.
//
// ORDER MATTERS ONLY IN ONE PLACE: HIGHLIGHT_COLORS drives the palette's
// left-to-right button order in the grid UI. It must stay in sync with the SQL
// CHECK list in supabase_scheduling_patch42_assignment_highlight.sql — adding a
// fourth colour is a code change AND a patch.

export const HIGHLIGHT_COLORS = ['blue', 'red', 'yellow'] as const;

export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number];

/** Runtime membership test. Used as a belt-and-braces guard on values that
 *  arrive from the DB or the wire — the TypeScript type alone cannot stop a
 *  pre-patch row, a hand-edited row, or a future fourth value from reaching a
 *  colour lookup and resolving to `undefined`. */
export function isHighlightColor(value: unknown): value is HighlightColor {
  return typeof value === 'string' && (HIGHLIGHT_COLORS as readonly string[]).includes(value);
}

/** Coerce anything to a usable highlight or null (= no manual mark). Never
 *  throws; unknown values degrade to null, which renders as the normal
 *  computed cell background. */
export function normalizeHighlightColor(value: unknown): HighlightColor | null {
  return isHighlightColor(value) ? value : null;
}

export type HighlightColorParse =
  | { ok: true; value: HighlightColor | null } // null = clear the manual mark
  | { ok: false; error: string };

/** Route-hardening gate for a client-supplied highlight_color. Same shape and
 *  posture as parseProviderLimits / parseScheduleName: a bad value is a 400 and
 *  is NEVER written. `null` is valid and means "clear back to normal"; anything
 *  else — including the empty string, a number, an object, or a near-miss like
 *  'Blue' or 'green' — is refused rather than silently normalized, because a
 *  silently-dropped colour looks identical to a colour that never saved. */
export function parseHighlightColor(value: unknown): HighlightColorParse {
  if (value === null) return { ok: true, value: null };
  if (isHighlightColor(value)) return { ok: true, value };
  return {
    ok: false,
    error: `highlight_color must be one of ${HIGHLIGHT_COLORS.join(', ')}, or null to clear.`,
  };
}
