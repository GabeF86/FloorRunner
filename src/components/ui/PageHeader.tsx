import type { ReactNode } from 'react';

export interface PageHeaderProps {
  // ReactNode so a page can decorate the title (e.g. the schedule detail
  // header's inline-rename pencil, 2026-07-22); plain strings render exactly
  // as before.
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /**
   * Opt-in density reduction for space-constrained pages (e.g. the schedule
   * detail grid): smaller h1 and tighter bottom margin. Omitted/false renders
   * byte-identically to the default header used everywhere else.
   */
  compact?: boolean;
}

export function PageHeader({ title, subtitle, actions, compact }: PageHeaderProps) {
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 'var(--space-4)',
        marginBottom: compact ? 4 : 'var(--space-5)',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <h1
          style={{
            fontSize: compact ? 17 : 'var(--fs-xl)',
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
