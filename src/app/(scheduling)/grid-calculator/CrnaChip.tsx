'use client';

// CRNA chip — small pill nested under or visually linked to its supervisor.
// Owned by agent A9 (Grid Canvas).
// PRD: docs/PRD-Grid-Calculator.md §7.2, §7.6, §7.7.
//
// Visual rules (PRD §7):
//   - CRNA = smaller pill (cyan family `#0ea5e9`).
//   - UI label is ALWAYS "CRNA" (never "MD"-style nomenclature).
//   - Cross-site supervision: a destination badge with the lane color attaches
//     to the pill so the cross-site link is readable inside the chip alone.
//   - Float CRNAs: outlined (dashed-gray) — the parent renders them in the
//     float lane and passes `variant='float'` here.
//
// Aesthetic checkpoint flags (see docs/aesthetic-checkpoints/A9-initial.md):
//   - Border radius: 999 (full-pill) — confident default; mirrors the
//     staffing-calculator CRNA chip exactly.
//   - Cross-site badge: uses the destination site's color at 25% alpha for the
//     background, 100% for the text — borrowed pattern from staffing-calculator.

import type { ProviderRole } from '@/lib/gridCalculator/solver';

export type CrnaChipVariant = 'assigned' | 'float';

export interface CrnaChipProps {
  /** Provider id — used only for keys and tooltips. */
  providerId: string;
  /** Display name. Last name or full name; the chip truncates as needed. */
  displayName: string;
  /** Two-letter initials shown as a leading colored dot label. */
  initials: string;
  /** Provider role — drives color (CRNA chip is always 'crna' in practice). */
  role: ProviderRole;
  /**
   * Cross-site destination — when present, the chip is rendered with the
   * destination's accent color and a small badge. Pass null for same-site or
   * float-lane usage.
   */
  crossSite?: {
    siteColor: string;
    siteShortLabel: string;
  } | null;
  /** Pill style — 'float' adds a dashed border to read as "unassigned but available". */
  variant?: CrnaChipVariant;
  /** Set true to highlight an over-ratio supervisor's CRNA with a red border. */
  overRatio?: boolean;
}

// CRNA cyan family per PRD §7.6.
const CYAN = '#0ea5e9';
const CYAN_BG = 'rgba(14,165,233,0.12)';
const CYAN_BORDER = 'rgba(14,165,233,0.4)';
const RED = '#ef4444';
const SLATE_DIM = 'rgba(100,116,139,0.4)';

export default function CrnaChip({
  providerId,
  displayName,
  initials,
  role,
  crossSite,
  variant = 'assigned',
  overRatio = false,
}: CrnaChipProps) {
  const isFloat = variant === 'float';
  const accent = crossSite ? crossSite.siteColor : CYAN;

  // Border color decision tree:
  //   1. Over-ratio violation → red (loudest signal).
  //   2. Float lane → dashed gray (PRD §7.5).
  //   3. Cross-site → dashed in destination color (PRD §7.3).
  //   4. Default → solid cyan tint.
  const borderColor = overRatio
    ? RED
    : isFloat
      ? SLATE_DIM
      : crossSite
        ? hexA(crossSite.siteColor, 0.5)
        : CYAN_BORDER;

  const borderStyle: 'solid' | 'dashed' =
    isFloat || (crossSite && !overRatio) ? 'dashed' : 'solid';

  return (
    <div
      title={`${displayName} (CRNA${crossSite ? ` — cross-site from ${crossSite.siteShortLabel}` : ''})`}
      data-provider-id={providerId}
      data-role={role}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '3px 9px 3px 6px',
        borderRadius: 999,
        background: isFloat ? 'transparent' : CYAN_BG,
        border: `1.5px ${borderStyle} ${borderColor}`,
        fontSize: 10,
        fontWeight: 600,
        color: isFloat ? 'var(--text-muted)' : CYAN,
        whiteSpace: 'nowrap',
        cursor: 'default',
        transition: 'opacity 0.12s',
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: 999,
          background: accent,
          flexShrink: 0,
          display: 'inline-block',
        }}
      />
      <span style={{ fontWeight: 800, fontSize: 9, opacity: 0.85 }}>{initials}</span>
      <span
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          maxWidth: 96,
        }}
      >
        {lastName(displayName)}
      </span>
      <span style={{ fontFamily: 'var(--font-mono), ui-monospace, monospace', fontSize: 8, opacity: 0.7 }}>
        CRNA
      </span>
      {crossSite && (
        <span
          style={{
            fontSize: 8,
            fontFamily: 'var(--font-mono), ui-monospace, monospace',
            fontWeight: 800,
            padding: '1px 4px',
            borderRadius: 3,
            background: hexA(crossSite.siteColor, 0.18),
            color: crossSite.siteColor,
            letterSpacing: 0.3,
          }}
        >
          @{crossSite.siteShortLabel}
        </span>
      )}
    </div>
  );
}

function lastName(displayName: string): string {
  const trimmed = displayName.trim();
  if (!trimmed) return '?';
  // Strip trailing credentials like ", CRNA"
  const cleaned = trimmed.replace(/,\s*[A-Z]{2,}.*$/, '');
  const parts = cleaned.split(/\s+/);
  return parts[parts.length - 1];
}

function hexA(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return `rgba(100,116,139,${alpha})`;
  const v = parseInt(m[1], 16);
  const r = (v >> 16) & 0xff;
  const g = (v >> 8) & 0xff;
  const b = v & 0xff;
  return `rgba(${r},${g},${b},${alpha})`;
}
