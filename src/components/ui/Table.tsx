import type { ReactNode } from 'react';
import { Skeleton } from './Skeleton';
import { EmptyState } from './EmptyState';

export interface TableProps {
  headers: ReactNode[];
  /** undefined → loading (3 skeleton rows); [] → empty state; else data rows. */
  rows: ReactNode[][] | undefined;
  empty?: ReactNode;
  minWidth?: number;
}

const SKELETON_WIDTHS = ['70%', '45%', '60%'];

const TH_STYLE: React.CSSProperties = {
  textAlign: 'left',
  padding: 'var(--space-2) var(--space-3)',
  fontSize: 'var(--fs-xs)',
  fontWeight: 500,
  fontFamily: 'var(--font-mono), ui-monospace, monospace',
  textTransform: 'uppercase',
  letterSpacing: 0.6,
  color: 'var(--text-muted)',
  borderBottom: '1px solid var(--border)',
  whiteSpace: 'nowrap',
};

const TD_STYLE: React.CSSProperties = {
  padding: 'var(--space-3)',
  fontSize: 'var(--fs-sm)',
  color: 'var(--text)',
  borderBottom: '1px solid var(--border-faint)',
  verticalAlign: 'middle',
};

export function Table({ headers, rows, empty, minWidth }: TableProps) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', minWidth, borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {headers.map((h, i) => (
              <th key={i} style={TH_STYLE}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows === undefined ? (
            [0, 1, 2].map((r) => (
              <tr key={`skeleton-${r}`}>
                {headers.map((_, c) => (
                  <td key={c} style={TD_STYLE}>
                    <Skeleton width={SKELETON_WIDTHS[(r + c) % SKELETON_WIDTHS.length]} />
                  </td>
                ))}
              </tr>
            ))
          ) : rows.length === 0 ? (
            <tr>
              <td colSpan={headers.length} style={{ ...TD_STYLE, borderBottom: 'none', padding: 0 }}>
                {empty ?? <EmptyState title="Nothing here yet" />}
              </td>
            </tr>
          ) : (
            rows.map((cells, r) => (
              <tr key={r} className="fr-row">
                {cells.map((cell, c) => (
                  <td key={c} style={TD_STYLE}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
