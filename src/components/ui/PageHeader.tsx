import type { ReactNode } from 'react';

export interface PageHeaderProps {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}

export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 'var(--space-4)',
        marginBottom: 'var(--space-5)',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <h1
          style={{
            fontSize: 'var(--fs-xl)',
            fontWeight: 700,
            letterSpacing: -0.5,
            lineHeight: 1.15,
            color: 'var(--text-strong)',
          }}
        >
          {title}
        </h1>
        {subtitle != null && (
          <div
            style={{
              marginTop: 'var(--space-1)',
              fontSize: 'var(--fs-sm)',
              color: 'var(--text-muted)',
              lineHeight: 1.4,
            }}
          >
            {subtitle}
          </div>
        )}
      </div>
      {actions != null && (
        <div
          style={{
            marginLeft: 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            flexShrink: 0,
            paddingTop: 2,
          }}
        >
          {actions}
        </div>
      )}
    </header>
  );
}
