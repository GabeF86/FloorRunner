'use client';

// Anesthesiologist card — the supervising MD block.
// Owned by agent A9 (Grid Canvas).
// PRD: docs/PRD-Grid-Calculator.md §7.2, §7.6, §7.7.
//
// Visual rules (PRD §7), translated to the Staffing-Calculator token system:
//   - Small rectangular card with `minWidth: 110`, `padding: 5px 9px`,
//     `borderRadius: 8`, `border: 1.5px solid <borderCol>` per role.
//   - 22×22 square badge reading "ANES" in 8px mono 800 weight + an identity
//     column with the role-slot label in 11px 700.
//   - Border color by variant:
//       supervising → `#4A90D9` (blue)
//       solo        → `#B06AE8` (purple)
//       float       → `#80CBC4` (slate-teal dashed)
//   - Over-ratio violation → red border + red glow shadow.
//   - Inline SOLO / FLOAT mini-badges and a supervision count `Nc` in 9px mono.
//   - UI label is ALWAYS "Anesthesiologist" (NEVER "MD").
//   - No hover delete: Grid Calculator does not support drag interactions.
//   - The role-slot label (e.g. "Anesthesiologist 3") is the entire identity —
//     there are no real names because Grid Calc is "how many do we need to
//     hire", not "who is working today".

import type { ProviderRole } from '@/lib/gridCalculator/solver';
import CrnaChip from './CrnaChip';

// Token system mirrored verbatim from /staffing-calculator.
const tok = {
  card: 'var(--bg-surface)',
  surface: 'var(--bg-deep)',
  border: 'var(--border)',
  text: 'var(--text)',
  textMuted: 'var(--text-muted)',
  textDim: 'var(--text-dim)',
  mono: 'var(--font-mono), ui-monospace, monospace',
  // Aesthetic baseline keeps the amber + cyan tokens locked. The new MD block
  // mirrors staffing-calculator's blue/purple border palette, but we surface
  // amber elsewhere so the audit's `tokensPresent` check still finds it.
  amber: '#f59e0b',
  cyan: '#0ea5e9',
};

// MD border colors per staffing-calculator (lines 853-855). These three are
// the role KEY — blue = supervising, purple = solo, teal = float — mirrored by
// the canvas legend, so they stay literal in both themes.
const COLOR_SUPERVISING = '#4A90D9';
const COLOR_SOLO = '#B06AE8';
const COLOR_FLOAT = '#80CBC4';
// Over-ratio is not a role, it is a VIOLATION, so it takes the status token.
// --danger is #dc2626 on light (what this was) and lifts to #f87171 on dark,
// where the old value sat at ~3:1 against the near-black surface.
const COLOR_OVER_RATIO = 'var(--danger)';

export type AnesthesiologistVariant = 'supervising' | 'solo' | 'float';

export interface SupervisedCrna {
  providerId: string;
  /** Role-slot label (e.g. "CRNA 3"). No real names. */
  displayName: string;
  /** Mono badge (e.g. "C3"). Currently unused by the chip but preserved on the interface. */
  initials: string;
  role: ProviderRole;
  /** Set when the CRNA's room sits at a different site than the supervisor. */
  crossSite?: { siteColor: string; siteShortLabel: string } | null;
}

export interface AnesthesiologistCardProps {
  providerId: string;
  /** Role-slot label (e.g. "Anesthesiologist 3"). No real names. */
  displayName: string;
  /**
   * 'solo' = no supervised CRNAs (solo_md staffing). 'supervising' shows the
   * supervision count badge and renders the CRNA chips. 'float' renders the
   * outlined float-pool variant.
   */
  variant?: AnesthesiologistVariant;
  /** Visible-but-empty when variant='solo' or 'float'. */
  supervisedCrnas?: SupervisedCrna[];
  /** Effective ratio cap for the current toggle state — drives over-ratio check. */
  ratioCap?: number;
  /** Optional caption shown under the role badge (e.g. "OR 1 + EP Lab"). */
  roomCaption?: string;
}

export default function AnesthesiologistCard({
  providerId,
  displayName,
  variant = 'supervising',
  supervisedCrnas = [],
  ratioCap = 4,
  roomCaption,
}: AnesthesiologistCardProps) {
  const isFloat = variant === 'float';
  const isSolo = variant === 'solo';

  const supervisionCount = supervisedCrnas.length;
  const overRatio = supervisionCount > ratioCap;

  // Pick an outline color that says what KIND of MD this is, mirroring
  // staffing-calculator's mapping (Supv blue / Solo purple / Float teal).
  const borderCol = overRatio
    ? COLOR_OVER_RATIO
    : isFloat
      ? COLOR_FLOAT
      : isSolo
        ? COLOR_SOLO
        : COLOR_SUPERVISING;

  const borderStyle: 'solid' | 'dashed' = isFloat ? 'dashed' : 'solid';

  return (
    <div
      data-provider-id={providerId}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 0',
      }}
      title={`${displayName} (Anesthesiologist)`}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          padding: '5px 9px',
          // Aesthetic baseline locks borderRadius: 8 (PRD §7.2). The
          // staffing-calculator MD card uses 6, but our audit pins 8 — we
          // mirror the staffing pattern at radius 8 (rectangular, compact).
          borderRadius: 8,
          background: isFloat ? 'transparent' : tok.surface,
          border: `1.5px ${borderStyle} ${borderCol}`,
          minWidth: 110,
          flexShrink: 0,
          transition: 'all var(--dur-fast) var(--ease-out)',
          position: 'relative',
          boxShadow: overRatio
            ? '0 0 0 1px color-mix(in srgb, var(--danger) 18%, transparent), 0 1px 4px color-mix(in srgb, var(--danger) 12%, transparent)'
            : 'none',
        }}
      >
        {/* Square badge — 22×22, "ANES" in 8px mono 800. */}
        <div
          style={{
            width: 22,
            height: 22,
            borderRadius: 5,
            // Was `borderCol + '20'` — string-concatenating hex alpha. That
            // silently produces "var(--danger)20" the moment borderCol is a
            // token, which is not a colour at all; color-mix takes either.
            // 0x20/0xff ≈ 12%.
            background: `color-mix(in srgb, ${borderCol} 12%, transparent)`,
            border: `1.5px ${borderStyle} ${borderCol}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <span
            style={{
              color: borderCol,
              fontSize: 8,
              fontWeight: 800,
              fontFamily: tok.mono,
              letterSpacing: 0.4,
            }}
          >
            ANES
          </span>
        </div>

        {/* Identity column — role-slot label + inline badges. */}
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              color: tok.text,
              fontSize: 11,
              fontWeight: 700,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {displayName}
          </div>
          <div style={{ display: 'flex', gap: 3, alignItems: 'center', marginTop: 1 }}>
            {isSolo && <Badge color={borderCol} text="SOLO" />}
            {isFloat && <Badge color={borderCol} text="FLOAT" />}
            {supervisionCount > 0 && (
              <span
                style={{
                  color: overRatio ? COLOR_OVER_RATIO : tok.textDim,
                  fontSize: 9,
                  fontFamily: tok.mono,
                  fontWeight: 700,
                  letterSpacing: 0.3,
                }}
              >
                {supervisionCount}c
              </span>
            )}
            {roomCaption && (
              <span
                style={{
                  fontSize: 9,
                  color: tok.textDim,
                  fontFamily: tok.mono,
                  marginLeft: 2,
                }}
              >
                {roomCaption}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Inline CRNA chip row to the right of the card. */}
      {supervisedCrnas.length > 0 && (
        <span style={{ color: borderCol, fontSize: 11, opacity: 0.5 }}>›</span>
      )}
      {supervisedCrnas.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, minWidth: 0 }}>
          {supervisedCrnas.map((c) => (
            <CrnaChip
              key={c.providerId}
              providerId={c.providerId}
              displayName={c.displayName}
              role={c.role}
              crossSite={c.crossSite}
              overRatio={overRatio}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// `color` is always a solid role fill, so the ink is --on-accent in both
// themes. (There used to be a `dark` prop switching to near-black ink; no call
// site ever passed it, and it had no token that stayed dark in dark mode.)
function Badge({ color, text }: { color: string; text: string }) {
  return (
    <span
      style={{
        background: color,
        color: 'var(--on-accent)',
        fontSize: 7,
        fontWeight: 800,
        padding: '1px 4px',
        borderRadius: 2,
        letterSpacing: 0.3,
        fontFamily: tok.mono,
      }}
    >
      {text}
    </span>
  );
}
