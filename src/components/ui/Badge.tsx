import type { ReactNode } from 'react';

export type BadgeTone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral';

export interface BadgeProps {
  tone: BadgeTone;
  children?: ReactNode;
}

const TONES: Record<BadgeTone, { bg: string; fg: string }> = {
  ok:      { bg: 'var(--ok-bg)',      fg: 'var(--ok)' },
  warn:    { bg: 'var(--warn-bg)',    fg: 'var(--warn)' },
  danger:  { bg: 'var(--danger-bg)',  fg: 'var(--danger)' },
  info:    { bg: 'var(--info-bg)',    fg: 'var(--info)' },
  neutral: { bg: 'var(--tint-surface)', fg: 'var(--text-muted)' },
};

/**
 * Status pill in the board's instrument-panel voice: uppercase DM Mono
 * micro-type on a soft tone tint.
 */
export function Badge({ tone, children }: BadgeProps) {
  const t = TONES[tone];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--space-1)',
        padding: '2px 8px',
        borderRadius: 999,
        background: t.bg,
        color: t.fg,
        fontSize: 'var(--fs-xs)',
        fontWeight: 500,
        fontFamily: 'var(--font-mono), ui-monospace, monospace',
        letterSpacing: 0.4,
        textTransform: 'uppercase',
        lineHeight: 1.6,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}
