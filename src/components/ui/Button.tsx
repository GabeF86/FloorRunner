'use client';

import type { CSSProperties, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  type?: 'button' | 'submit' | 'reset';
  title?: string;
  /** For disclosure buttons (aria-expanded / aria-controls passthrough). */
  ariaExpanded?: boolean;
  ariaControls?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

// Hover and :active live in globals.css (.fr-btn-*), not in React state.
// Tracking hover with useState re-rendered this component on every
// mouse-enter and mouse-leave — costly on a dense screen, and it still could
// not express :active at all.
const VARIANTS: Record<ButtonVariant, { base: CSSProperties }> = {
  // The one saturated fill in the kit — every screen gets a single clear primary action.
  primary: {
    base: {
      background: 'var(--blue)',
      color: 'var(--on-accent)',
      border: '1px solid transparent',
      fontWeight: 700,
    },
  },
  secondary: {
    base: {
      background: 'transparent',
      color: 'var(--text)',
      border: '1px solid var(--border)',
      fontWeight: 600,
    },
  },
  ghost: {
    base: {
      background: 'transparent',
      color: 'var(--text-muted)',
      border: '1px solid transparent',
      fontWeight: 600,
    },
  },
  danger: {
    base: {
      background: 'var(--danger-bg)',
      color: 'var(--danger)',
      border: '1px solid transparent',
      fontWeight: 700,
    },
  },
};

const SIZES: Record<ButtonSize, CSSProperties> = {
  sm: { padding: '4px 10px', fontSize: 'var(--fs-sm)' },
  md: { padding: '7px 14px', fontSize: 'var(--fs-md)' },
};

export function Button({
  variant = 'primary',
  size = 'md',
  disabled,
  onClick,
  type = 'button',
  title,
  ariaExpanded,
  ariaControls,
  style,
  children,
}: ButtonProps) {
  const v = VARIANTS[variant];

  return (
    <button
      type={type}
      title={title}
      aria-expanded={ariaExpanded}
      aria-controls={ariaControls}
      disabled={disabled}
      onClick={onClick}
      className={`fr-focus fr-btn fr-btn-${variant}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 'var(--space-2)',
        borderRadius: 'var(--radius-sm)',
        fontFamily: 'inherit',
        lineHeight: 1.4,
        whiteSpace: 'nowrap',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.55 : 1,
        ...SIZES[size],
        ...v.base,
        ...style,
      }}
    >
      {children}
    </button>
  );
}
