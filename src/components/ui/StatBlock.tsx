// A figure and what it is.
//
//   82.5
//   hours this period
//
// The deck's most repeated element. Two rules make it read the way it does:
//
// 1. The number is MONO and heavy — IBM Plex Mono SemiBold in the original.
//    Proportional digits make a column of figures ripple; tabular mono makes
//    a set of them line up whatever the values are, which is what lets a
//    reader compare down a column without reading each one.
//
// 2. The caption is small, muted, and NOT uppercase. The deck reserves tracked
//    caps for section labels; captions under a figure are lower case, which
//    keeps them subordinate to the number rather than competing with the
//    section header above.

import type { CSSProperties, ReactNode } from 'react';

export interface StatBlockProps {
  value: ReactNode;
  /** What the number is. Lower case — see note 2 above. */
  caption: ReactNode;
  /** Larger treatment for the one figure a card is really about. */
  size?: 'md' | 'lg';
  /** Tints the figure — use for a number that is itself a problem. */
  tone?: 'default' | 'danger' | 'ok';
  style?: CSSProperties;
}

const TONE: Record<NonNullable<StatBlockProps['tone']>, string> = {
  default: 'var(--text-strong)',
  danger: 'var(--danger)',
  ok: 'var(--ok)',
};

export function StatBlock({ value, caption, size = 'md', tone = 'default', style }: StatBlockProps) {
  return (
    <div style={{ minWidth: 0, ...style }}>
      <div style={{
        fontFamily: 'var(--font-mono), ui-monospace, monospace',
        fontVariantNumeric: 'tabular-nums',
        fontWeight: 600,
        fontSize: size === 'lg' ? 30 : 'var(--fs-xl)',
        lineHeight: 1.1,
        letterSpacing: -0.5,
        color: TONE[tone],
      }}>
        {value}
      </div>
      <div style={{
        fontSize: 'var(--fs-xs)',
        color: 'var(--text-dim)',
        marginTop: 3,
        lineHeight: 1.35,
      }}>
        {caption}
      </div>
    </div>
  );
}
