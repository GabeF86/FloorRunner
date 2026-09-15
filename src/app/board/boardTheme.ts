// boardTheme.ts — single source of truth for the board's compact-mode scale,
// its colour vocabulary, and the dark site palette (spec 2026-07-13).
// Components import from here; no dimensional or colour literals in board
// components. Values sit on a 4px grid (radii and hairline gaps excepted).
//
// ── How colour is expressed here ─────────────────────────────────────────────
// Two forms appear below, and which one a role gets is a decision made HERE,
// once, rather than in the component:
//
//   • `var(--token)` — a global token from globals.css. It follows the app's
//     light/dark theme for free. Used wherever a board role maps cleanly onto
//     the app's token vocabulary.
//   • a `#rrggbb` string — required when the value is handed to `hexToRgb()`
//     (it parses six hex digits and cannot see through a CSS variable), and
//     used for the board's own semantic vocabularies, which mean the same
//     thing in either theme.
//
// Site colours are NOT here: they come from the `sites` DB row at runtime.
// Role colours are NOT here either: they live in `ROLE_META` (@/types).
//
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

  color: {
    // Drawn ON a site's own colour (the solid site header, a colour swatch).
    // Site colours are dark by policy — see DARK_SITE_PALETTE — so these stay
    // light in BOTH themes; they are contrast against the site fill, not
    // against the page. --on-accent is #fff and is deliberately theme-invariant.
    onSite: {
      text:         'var(--on-accent)',
      textMuted:    'rgba(255,255,255,.65)',
      buttonBg:     'rgba(255,255,255,.14)',
      buttonBorder: 'rgba(255,255,255,.3)',
      dangerBg:     'rgba(255,255,255,.12)',
      dangerText:   '#fecaca',
      dangerBorder: 'rgba(254,202,202,.4)',
      // Ring marking the chosen swatch in the site-colour picker.
      selectedRing: 'var(--on-accent)',
    },

    // MD designation vocabulary — one meaning per tone, shared by the sidebar
    // badge and the Out Order panel so a designation reads the same in both.
    // Hex (not tokens) because every use tints itself via hexToRgb().
    designation: {
      call:    '#a78bfa', // C1 — on call overnight
      lastOut: '#fb7185', // C2 — last out
      perDiem: '#94a3b8', // 8hr / 10hr
      out:     '#f59e0b', // D1…D9 — the out order itself
    },

    // Staff whose role has no ROLE_META entry. Tinted via hexToRgb(), so hex.
    roleFallback: '#94a3b8',

    // Count badge on the collapsed 44px rail — sits on --bg-sidebar in both
    // themes, and is legible against either, so it is one fixed pair.
    railBadge: { bg: '#1e3a8a', text: 'var(--on-accent)' },

    // Selected facility pill in the top bar.
    facilityPillOn: { bg: '#E1F5EE', text: '#085041', border: '#A8DBC9' },

    // Resting elevation of a room cell. --shadow-xs is exactly the value this
    // replaced, and softens correctly on dark surfaces.
    roomShadow: 'var(--shadow-xs)',
  },
} as const;

// Late-shift tones — how long someone is here past the ordinary day, amber
// through red. Keyed by ShiftHours; a shift with no entry is not "late" and
// falls back to the person's role colour. Record (not `as const`) because
// callers index it with a runtime string.
export const LATE_SHIFT_TONE: Record<string, string> = {
  '10hr': '#f59e0b',  // amber
  '12hr': '#f97316',  // orange
  '16hr': '#ef4444',  // red-orange
  '24hr': '#f87171',  // bright red
};

// ── Network view palette ─────────────────────────────────────────────────────
// The MD → CRNA → room diagram paints its own nodes rather than the board's
// card chrome, so it carries its own small palette. These values are tuned for
// a light canvas: pale fills carrying dark labels. They are NOT theme tokens —
// on a dark canvas the diagram keeps its light nodes. If the network view is
// ever asked to follow the theme, this object is the one place to change.
export const NETWORK = {
  // Cycled per attending by index — a categorical series, not UI chrome.
  // Also the colour of that attending's lines to their CRNAs and rooms.
  team: [
    '#1D9E75', // teal
    '#BA7517', // amber
    '#D85A30', // coral
    '#D4537E', // pink
    '#534AB7', // purple
    '#185FA5', // blue
    '#3B6D11', // green
    '#A32D2D', // red
  ],
  md:     { bg: '#EEEDFE', fg: '#3C3489', border: '#CECBF6', status: '#534AB7' },
  fellow: { bg: '#E5F8F4', fg: '#0F6F65', border: '#B5E5DC' },
  crna:   { bg: '#E6F1FB', fg: '#0C447C', border: '#B5D4F4' },
  room:   { bg: '#F1EFE8', fg: '#2C2C2A', surgeon: '#5F5E5A', emptyBorder: '#888780' },
  // Site section headings, their rules, and the column captions.
  label:  '#6B6B65',
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
