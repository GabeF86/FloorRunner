// boardTheme.ts — single source of truth for the board's compact-mode scale
// and dark site palette (spec 2026-07-13). Components import from here; no
// dimensional literals in components. values sit on a 4px grid (radii and
// hairline gaps excepted).
// Short name by design — consumed pervasively in JSX styles.
export const BT = {
  // room cards (compact — spec §1, mockup option B)
  room: { minWidth: 112, minHeight: 88, radius: 8, headerPad: '4px 8px', bodyPad: 4, gap: 2 },
  roomsArea: { gap: 8, pad: '8px 12px' },
  // site header (solid bar — spec §3)
  siteHeader: { pad: '4px 12px', nameSize: 13, countSize: 10, radius: 10 },
  // type scale: exactly two content sizes + the header (spec §7).
  // chipSub: sub-elements inside a chip — initials, badges, remove ×; must
  // stay below font.chip so the chip's name dominates.
  font: { roomName: 11, chip: 10, chipSub: 9 },
  // chip.minHeight is 32 (not 20) — spec risk #1: 20px fails the ≥32px
  // pointer-target floor once padding is border-box'd (see Task 2 report).
  chip: { radius: 4, pad: '2px 6px', minHeight: 32 },
  railWidth: 44,
} as const;

// Dark site palette (spec §4). Keyed by site NAME for the one-off data update
// + AddSiteModal choices; at runtime components always read site.color from
// the DB row — this map is not a runtime lookup table.
export const DARK_SITE_PALETTE: Record<string, string> = {
  'Main OR': '#1e3a8a', 'Endoscopy': '#065f46', 'OB': '#5b21b6',
  'Neuro': '#0e7490', 'EP Lab': '#92400e', 'Float / Breaks': '#334155',
};
// AddSiteModal swatches (order = suggestion order for new sites)
export const SITE_COLOR_CHOICES = ['#1e3a8a', '#065f46', '#5b21b6', '#0e7490', '#92400e', '#9d174d', '#3f6212', '#334155'];
