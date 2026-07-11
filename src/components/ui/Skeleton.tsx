import type { CSSProperties } from 'react';

export interface SkeletonProps {
  width?: number | string;
  height?: number;
  style?: CSSProperties;
}

/** Shimmering placeholder line/block (animation lives in globals.css). */
export function Skeleton({ width = '100%', height = 14, style }: SkeletonProps) {
  return (
    <span
      className="fr-skeleton"
      aria-hidden="true"
      style={{
        display: 'block',
        width,
        height,
        borderRadius: 'var(--radius-sm)',
        background: 'var(--tint-surface)',
        ...style,
      }}
    />
  );
}
