'use client';

import { useState, type CSSProperties, type ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  type?: 'button' | 'submit' | 'reset';
  title?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

const VARIANTS: Record<ButtonVariant, { base: CSSProperties; hover: CSSProperties }> = {
  // The one saturated fill in the kit — every screen gets a single clear primary action.
  primary: {
    base: {
      background: 'var(--blue)',
      color: 'var(--on-accent)',
      border: '1px solid transparent',
      fontWeight: 700,
    },
    hover: { filter: 'brightness(1.08)' },
  },
  secondary: {
    base: {
      background: 'transparent',
      color: 'var(--text)',
      border: '1px solid var(--border)',
      fontWeight: 600,
    },
    hover: { background: 'var(--tint-surface)' },
  },
  ghost: {
    base: {
      background: 'transparent',
      color: 'var(--text-muted)',
      border: '1px solid transparent',
      fontWeight: 600,
    },
    hover: { background: 'var(--tint-surface)', color: 'var(--text)' },
  },
  danger: {
    base: {
      background: 'var(--danger-bg)',
      color: 'var(--danger)',
      border: '1px solid transparent',
      fontWeight: 700,
    },
    hover: { border: '1px solid var(--danger)' },
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
  style,
  children,
}: ButtonProps) {
  const [hover, setHover] = useState(false);
  const v = VARIANTS[variant];

  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="fr-focus"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
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
        transition: 'background .12s, color .12s, border-color .12s, filter .12s',
        ...SIZES[size],
        ...v.base,
        ...(hover && !disabled ? v.hover : undefined),
        ...style,
      }}
    >
      {children}
    </button>
  );
}
