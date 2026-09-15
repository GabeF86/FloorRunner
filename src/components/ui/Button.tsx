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

// Colour lives ENTIRELY in globals.css (.fr-btn-*), not here.
//
// An earlier pass moved only :hover to CSS and left the variant's base colours
// inline — which silently removed hover from secondary, ghost and danger
// everywhere in the app, because an inline `background` outranks a class rule.
// Only primary kept working, and only because it hovers via `filter`, a
// property nothing set inline. The lesson is the rule: a state cannot live in
// CSS while the property it overrides lives inline.
//
// What stays inline here is LAYOUT only. A caller's `style` prop still wins
// over both, which is intended — that is how a caller stretches a button to
// full width without forking the variant.

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
        ...style,
      }}
    >
      {children}
    </button>
  );
}
