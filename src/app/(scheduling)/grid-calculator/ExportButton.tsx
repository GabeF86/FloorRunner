'use client';

// Export button — small CTA the GridCanvas can render to send the user
// to the print route. Owned by agent A16 (Export) per PRD §14.
//
// This is a STUB to be wired later by the canvas owner (A9) at their
// discretion. Per the agent ownership rules in A16's charter, A16 may not
// edit `GridCanvas.tsx` directly; this component exists so A9 (or a follow-
// up integration agent) can drop a single import + element into the canvas
// without writing any export logic themselves.
//
// API contract for future wiring:
//   - `configId?: string` — when supplied, the print route loads that
//     persisted config (A11+ work). Until then, omit and the route renders
//     the Paoli demo seed.
//   - `orientation?: 'portrait' | 'landscape'` — preferred page orientation.
//     Default portrait; the print route honors `?orient=landscape`.
//   - `label?: string` — override the default "↧ Export" caption.
//
// Why this is `<a>` and not `<button>`:
//   - The print route is a real navigable URL. Using an anchor preserves
//     middle-click / cmd-click "open in new tab" behavior — which is the
//     natural UX for a print-preview link, since most admins want to keep
//     the live grid open while they review the PDF.

import type { CSSProperties } from 'react';

export interface ExportButtonProps {
  /** Persisted config id. Omit for the demo Paoli render. */
  configId?: string;
  /** Preferred page orientation. Default: portrait. */
  orientation?: 'portrait' | 'landscape';
  /** Optional caption override. Default: "↧ Export". */
  label?: string;
  /** Optional className for layout integration. */
  className?: string;
  /** Inline style override. Merged on top of the default style. */
  style?: CSSProperties;
}

const BASE_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 12px',
  borderRadius: 6,
  fontSize: 11,
  fontWeight: 700,
  fontFamily: 'var(--font-mono), ui-monospace, monospace',
  letterSpacing: 0.4,
  color: '#0ea5e9',
  background: 'rgba(14,165,233,0.10)',
  border: '1px solid rgba(14,165,233,0.35)',
  cursor: 'pointer',
  textDecoration: 'none',
  whiteSpace: 'nowrap',
  transition: 'all 0.15s',
};

export default function ExportButton({
  configId,
  orientation = 'portrait',
  label = '↧ Export',
  className,
  style,
}: ExportButtonProps) {
  const params = new URLSearchParams();
  if (configId) params.set('config', configId);
  if (orientation !== 'portrait') params.set('orient', orientation);
  const qs = params.toString();
  const href = qs ? `/grid-calculator/print?${qs}` : '/grid-calculator/print';

  return (
    <a
      href={href}
      // Open in a new tab so the live grid stays in the original tab — this
      // matches the most common admin workflow (compare PDF + live page).
      target="_blank"
      rel="noopener noreferrer"
      className={className}
      style={{ ...BASE_STYLE, ...style }}
      title={`Open print preview${configId ? ` for config ${configId}` : ' (demo)'}`}
    >
      {label}
    </a>
  );
}
