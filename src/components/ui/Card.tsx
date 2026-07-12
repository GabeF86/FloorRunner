import type { CSSProperties, ReactNode } from 'react';

export interface CardProps {
  title?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  /** Pad the body (default true). Turn off for flush content like tables. */
  pad?: boolean;
  style?: CSSProperties;
  children?: ReactNode;
}

/**
 * The app's one surface treatment: quiet hairline border, soft themed
 * elevation, generous radius (promoted from the staffing calculator's
 * cardStyle to the shared layer).
 */
export function Card({ title, actions, footer, pad = true, style, children }: CardProps) {
  const hasHeader = title != null || actions != null;

  return (
    <section
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-card)',
        overflow: 'hidden',
        ...style,
      }}
    >
      {hasHeader && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-3)',
            padding: 'var(--space-3) var(--space-4)',
            borderBottom: '1px solid var(--border-faint)',
          }}
        >
          <div
            style={{
              fontSize: 'var(--fs-md)',
              fontWeight: 700,
              color: 'var(--text-strong)',
              letterSpacing: -0.2,
              minWidth: 0,
            }}
          >
            {title}
          </div>
          {actions != null && (
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexShrink: 0 }}>
              {actions}
            </div>
          )}
        </div>
      )}
      <div style={{ padding: pad ? 'var(--space-4)' : 0 }}>{children}</div>
      {footer != null && (
        <div
          style={{
            padding: 'var(--space-3) var(--space-4)',
            borderTop: '1px solid var(--border-faint)',
            background: 'var(--tint-surface-faint)',
            fontSize: 'var(--fs-sm)',
            color: 'var(--text-muted)',
          }}
        >
          {footer}
        </div>
      )}
    </section>
  );
}
