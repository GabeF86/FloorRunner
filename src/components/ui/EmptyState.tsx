import type { ReactNode } from 'react';

export interface EmptyStateProps {
  /** Small glyph (e.g. '◎', '⬡') shown in a quiet tile above the title. */
  icon?: string;
  title: string;
  hint?: string;
  action?: ReactNode;
}

export function EmptyState({ icon, title, hint, action }: EmptyStateProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        textAlign: 'center',
        padding: 'var(--space-8) var(--space-6)',
      }}
    >
      {icon && (
        <div
          aria-hidden="true"
          style={{
            width: 40,
            height: 40,
            display: 'grid',
            placeItems: 'center',
            borderRadius: 'var(--radius-md)',
            background: 'var(--tint-surface)',
            border: '1px solid var(--border-faint)',
            color: 'var(--text-muted)',
            fontSize: 'var(--fs-lg)',
            marginBottom: 'var(--space-3)',
          }}
        >
          {icon}
        </div>
      )}
      <div style={{ fontSize: 'var(--fs-md)', fontWeight: 700, color: 'var(--text-strong)' }}>
        {title}
      </div>
      {hint && (
        <div
          style={{
            marginTop: 'var(--space-1)',
            fontSize: 'var(--fs-sm)',
            color: 'var(--text-muted)',
            lineHeight: 1.5,
            maxWidth: 380,
          }}
        >
          {hint}
        </div>
      )}
      {action != null && <div style={{ marginTop: 'var(--space-4)' }}>{action}</div>}
    </div>
  );
}
