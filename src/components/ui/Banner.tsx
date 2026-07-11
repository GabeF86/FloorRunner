'use client';

import type { ReactNode } from 'react';

export type BannerTone = 'info' | 'warn' | 'error' | 'success';

export interface BannerProps {
  tone: BannerTone;
  onDismiss?: () => void;
  children?: ReactNode;
}

const TONES: Record<BannerTone, { bg: string; accent: string }> = {
  info:    { bg: 'var(--info-bg)',   accent: 'var(--info)' },
  warn:    { bg: 'var(--warn-bg)',   accent: 'var(--warn)' },
  error:   { bg: 'var(--danger-bg)', accent: 'var(--danger)' },
  success: { bg: 'var(--ok-bg)',     accent: 'var(--ok)' },
};

/** Inline alert: soft tone tint with a 3px tone rule on the left edge. */
export function Banner({ tone, onDismiss, children }: BannerProps) {
  const t = TONES[tone];
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 'var(--space-3)',
        padding: 'var(--space-3) var(--space-4)',
        borderRadius: 'var(--radius-md)',
        background: t.bg,
        border: '1px solid var(--border-faint)',
        borderLeft: `3px solid ${t.accent}`,
      }}
    >
      <div style={{ flex: 1, fontSize: 'var(--fs-sm)', color: 'var(--text)', lineHeight: 1.5 }}>
        {children}
      </div>
      {onDismiss && (
        <button
          type="button"
          aria-label="Dismiss"
          title="Dismiss"
          className="fr-focus"
          onClick={onDismiss}
          style={{
            flexShrink: 0,
            width: 22,
            height: 22,
            display: 'grid',
            placeItems: 'center',
            background: 'transparent',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--text-muted)',
            fontSize: 'var(--fs-md)',
            lineHeight: 1,
            cursor: 'pointer',
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}
