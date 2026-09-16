// The deck's section header: a small coloured dot, a mono label in tracked
// caps, and an optional right-aligned source tag.
//
//   ● CALL OWED VS. TAKEN                      FLOORRUNNER  PAYCOM
//
// ── WHY THE DOT IS NOT DECORATION ──────────────────────────────────────────
// In the UAS deck the dot's colour names WHERE THE DATA CAME FROM — blue for
// FloorRunner, green for Paycom, red for Epic. A reader can tell at a glance
// whether a number was computed here or read from payroll, which is the whole
// argument that page is making. Reusing the dot as a generic bullet would
// spend a signal that is doing real work.
//
// ── AND WHY THE LABEL IS MONO ──────────────────────────────────────────────
// The deck sets every label, number, code and date in IBM Plex Mono and
// reserves the sans for headings and prose. That split is most of what makes
// it read as an instrument rather than a document.

import type { ReactNode } from 'react';

/** Where a figure came from. Determines the dot colour. */
export type SourceSystem = 'floorrunner' | 'paycom' | 'epic' | 'none';

const SOURCE_COLOR: Record<SourceSystem, string> = {
  floorrunner: 'var(--blue)',
  paycom: 'var(--ok)',
  epic: 'var(--danger)',
  // A section with no external source still gets a dot, for alignment — it
  // just does not claim a provenance it does not have.
  none: 'var(--border-strong)',
};

export interface SectionLabelProps {
  children: ReactNode;
  /** Defaults to FloorRunner: most figures in this app are computed here. */
  source?: SourceSystem;
  /** Right-aligned tags, e.g. which systems the row reconciles. */
  tags?: ReactNode;
  /** Drop the bottom rule where the caller supplies its own. */
  rule?: boolean;
}

export function SectionLabel({ children, source = 'floorrunner', tags, rule = true }: SectionLabelProps) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap',
      paddingBottom: 6,
      marginBottom: 'var(--space-2)',
      borderBottom: rule ? '1px solid var(--border-faint)' : undefined,
    }}>
      <span aria-hidden="true" style={{
        width: 6, height: 6, borderRadius: 999, flexShrink: 0,
        background: SOURCE_COLOR[source],
      }} />
      <span style={{
        fontFamily: 'var(--font-mono), ui-monospace, monospace',
        fontSize: 'var(--fs-xs)',
        fontWeight: 600,
        letterSpacing: 0.8,
        textTransform: 'uppercase',
        color: 'var(--text-muted)',
      }}>
        {children}
      </span>
      {tags && <span style={{ marginLeft: 'auto', display: 'flex', gap: 'var(--space-1)' }}>{tags}</span>}
    </div>
  );
}

/**
 * The small right-aligned pill that names a source system.
 *
 * Deliberately quiet: it is provenance, not status, and styling it like a
 * status badge would make every section look like it needed attention.
 */
export function SourceTag({ children, source = 'floorrunner' }: { children: ReactNode; source?: SourceSystem }) {
  return (
    <span style={{
      fontFamily: 'var(--font-mono), ui-monospace, monospace',
      fontSize: 'var(--fs-xs)',
      fontWeight: 500,
      letterSpacing: 0.5,
      textTransform: 'uppercase',
      color: SOURCE_COLOR[source],
      background: `color-mix(in srgb, ${SOURCE_COLOR[source]} 10%, transparent)`,
      padding: '1px 6px',
      borderRadius: 'var(--radius-sm)',
      whiteSpace: 'nowrap',
    }}>
      {children}
    </span>
  );
}
