'use client';

// Anesthesiologist card — the supervising MD block.
// Owned by agent A9 (Grid Canvas).
// PRD: docs/PRD-Grid-Calculator.md §7.2, §7.6, §7.7.
//
// Visual rules (PRD §7):
//   - Larger rectangular card; role badge + supervision count (e.g. "3c").
//   - Color from FloorRunner amber family `#f59e0b`.
//   - UI label is ALWAYS "Anesthesiologist" (NEVER "MD").
//   - Red border for over-ratio violations.
//   - Outlined variant for float-pool MDs (PRD §7.5).
//
// Composition: the card itself holds the MD identity (name + supervision count
// chip). The owning lane (SiteLane.tsx) appends the CRNA chip row to the
// right of the card.

import type { ProviderRole } from '@/lib/gridCalculator/solver';
import CrnaChip from './CrnaChip';

const AMBER = '#f59e0b';
const AMBER_BG = 'rgba(245,158,11,0.10)';
const AMBER_BORDER = 'rgba(245,158,11,0.45)';
const RED = '#ef4444';
const SLATE_DIM = 'rgba(100,116,139,0.4)';

export type AnesthesiologistVariant = 'supervising' | 'solo' | 'float';

export interface SupervisedCrna {
  providerId: string;
  displayName: string;
  initials: string;
  role: ProviderRole;
  /** Set when the CRNA's room sits at a different site than the supervisor. */
  crossSite?: { siteColor: string; siteShortLabel: string } | null;
}

export interface AnesthesiologistCardProps {
  providerId: string;
  displayName: string;
  initials: string;
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
  initials,
  variant = 'supervising',
  supervisedCrnas = [],
  ratioCap = 4,
  roomCaption,
}: AnesthesiologistCardProps) {
  const isFloat = variant === 'float';
  const isSolo = variant === 'solo';

  const supervisionCount = supervisedCrnas.length;
  const overRatio = supervisionCount > ratioCap;

  const borderColor = overRatio ? RED : isFloat ? SLATE_DIM : AMBER_BORDER;
  const borderStyle = isFloat ? 'dashed' : 'solid';
  const background = isFloat ? 'transparent' : AMBER_BG;

  return (
    <div
      data-provider-id={providerId}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '6px 10px',
        borderRadius: 8,
        background,
        border: `1.5px ${borderStyle} ${borderColor}`,
        minWidth: 168,
        flexShrink: 0,
        transition: 'all 0.15s',
        position: 'relative',
        boxShadow: overRatio
          ? '0 0 0 1px rgba(239,68,68,0.18), 0 1px 4px rgba(239,68,68,0.12)'
          : 'none',
      }}
      title={`${displayName} (Anesthesiologist)`}
    >
      {/* Role badge: square color chip with "Anes" mono label. */}
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: 6,
          background: isFloat ? 'transparent' : 'rgba(245,158,11,0.18)',
          border: `1.5px ${borderStyle} ${isFloat ? SLATE_DIM : AMBER}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <span
          style={{
            color: isFloat ? 'var(--text-muted)' : AMBER,
            fontSize: 8,
            fontWeight: 800,
            fontFamily: 'var(--font-mono), ui-monospace, monospace',
            letterSpacing: 0.5,
          }}
        >
          ANES
        </span>
      </div>

      {/* Identity column. */}
      <div style={{ minWidth: 0, flex: '0 1 auto' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 6,
            fontSize: 12,
            fontWeight: 700,
            color: isFloat ? 'var(--text-muted)' : 'var(--text)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            maxWidth: 160,
          }}
        >
          <span
            style={{
              fontSize: 9,
              fontFamily: 'var(--font-mono), ui-monospace, monospace',
              fontWeight: 800,
              color: isFloat ? 'var(--text-dim)' : AMBER,
              opacity: 0.85,
            }}
          >
            {initials}
          </span>
          <span>{shortName(displayName)}</span>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            marginTop: 2,
            fontSize: 9,
            fontFamily: 'var(--font-mono), ui-monospace, monospace',
            color: 'var(--text-muted)',
          }}
        >
          <span style={{ fontWeight: 700 }}>Anesthesiologist</span>
          {isSolo && (
            <Badge color={AMBER} text="SOLO" />
          )}
          {isFloat && (
            <Badge color={SLATE_DIM} text="FLOAT" />
          )}
          {supervisionCount > 0 && (
            <span
              style={{
                fontWeight: 800,
                color: overRatio ? RED : AMBER,
                background: overRatio
                  ? 'rgba(239,68,68,0.10)'
                  : 'rgba(245,158,11,0.10)',
                border: `0.5px solid ${overRatio ? RED : AMBER}`,
                padding: '0 4px',
                borderRadius: 3,
                letterSpacing: 0.3,
              }}
            >
              {supervisionCount}c
            </span>
          )}
        </div>
        {roomCaption && (
          <div
            style={{
              fontSize: 9,
              color: 'var(--text-dim)',
              fontFamily: 'var(--font-mono), ui-monospace, monospace',
              marginTop: 1,
            }}
          >
            {roomCaption}
          </div>
        )}
      </div>

      {/* Inline CRNA chips. The owning lane lays them out next to the card,
          but for now we render them right next to the identity column. The
          PRD §7.4 cross-site dashed connector is drawn by SiteLane via an
          SVG overlay; the chip-level "@SiteName" badge here doubles as a
          textual signal when the SVG isn't visible. */}
      {supervisedCrnas.length > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            marginLeft: 2,
            flexWrap: 'wrap',
            maxWidth: 'calc(100% - 200px)',
          }}
        >
          <span style={{ color: AMBER, opacity: 0.4, fontSize: 14, lineHeight: 1 }}>›</span>
          {supervisedCrnas.map((c) => (
            <CrnaChip
              key={c.providerId}
              providerId={c.providerId}
              displayName={c.displayName}
              initials={c.initials}
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

function Badge({ color, text }: { color: string; text: string }) {
  return (
    <span
      style={{
        background: hexA(color, 0.14),
        color,
        fontSize: 7,
        fontWeight: 800,
        padding: '1px 4px',
        borderRadius: 2,
        letterSpacing: 0.4,
        fontFamily: 'var(--font-mono), ui-monospace, monospace',
        border: `0.5px solid ${hexA(color, 0.4)}`,
      }}
    >
      {text}
    </span>
  );
}

function shortName(displayName: string): string {
  const cleaned = displayName.trim().replace(/^Dr\.\s*/i, '');
  const parts = cleaned.split(/\s+/);
  if (parts.length === 1) return parts[0];
  // "Avery Chen" -> "A. Chen" for compact display.
  return `${parts[0][0]}. ${parts.slice(1).join(' ')}`;
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
