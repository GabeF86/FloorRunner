'use client';

/* ── D-assignment audit overlay ──────────────────────────────────────────────
 * DYNAMICALLY IMPORTED (next/dynamic, ssr: false) by the schedule grid page.
 * It renders only behind `showDAudit`, so its markup and its print stylesheet
 * are not needed to paint the grid. `ssr: false` is correct: a click-gated
 * overlay that calls window.print().
 *
 * The arithmetic stays in lib/dAssignmentAudit.ts — the page still computes the
 * audit and passes it in, so this module only lists findings and dispatches the
 * batch apply. Moved verbatim out of page.tsx.
 * ───────────────────────────────────────────────────────────────────────── */

import { useState } from 'react';
import { gridTokens } from './gridTheme';
import { placementsFor } from '@/lib/dAssignmentAudit';
// Type-only: the audit is run by the page and handed down as a prop; this
// module never calls the auditor, it only names its return shape.
import type { auditDAssignments } from '@/lib/dAssignmentAudit';
import { formatMMDD, smallBtn, type GridData } from './gridShared';

/* ── D-assignment audit (Gabriel 2026-08-02) ───────────────────────────────
 * "re-check all the placements for correct D assignments after I make
 * switches to peoples call." The arithmetic is lib/dAssignmentAudit.ts; this
 * lists what it found and dispatches the batch apply.
 */
export function DAuditModal({
  grid, audit, applying, onApply, onClose,
}: {
  grid: GridData;
  audit: ReturnType<typeof auditDAssignments>;
  applying: boolean;
  onApply: (placements: Array<{ slotId: string; providerId: string | null }>) => void;
  onClose: () => void;
}) {
  // DELETED findings (Gabriel 2026-08-02: "hit delete if theres a reason for
  // it"). Kept for THIS review only, deliberately not persisted: a dismissal
  // that outlived the session would silently suppress a finding that has since
  // become a real problem. Restore puts them all back, so a mis-click costs
  // nothing.
  const [deleted, setDeleted] = useState<Set<string>>(new Set());
  const kept = audit.findings.filter(f => !deleted.has(f.key));
  const keptPlacements = placementsFor(kept);

  const nameOf = (pid: string) =>
    grid.providers.find(p => p.id === pid)?.short_display_name ?? pid;
  const KIND_LABEL: Record<string, string> = {
    'wrong-sequence-code': 'Wrong D',
    'missing-sequence-code': 'Missing D',
    'ladder-order': 'Relief order',
  };
  // Ladder details name providers by id; swap in display names for reading.
  const readable = (f: (typeof audit.findings)[number]) =>
    f.kind === 'ladder-order'
      ? f.detail.replace(/[0-9a-zA-Z-]{6,}/g, m =>
          grid.providers.some(p => p.id === m) ? nameOf(m) : m)
      : f.detail;

  return (
    <div
      className="fr-print-overlay"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 800,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}
    >
      <div
        className="fr-print-panel"
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--bg-deep)', borderRadius: 12, border: '1px solid var(--border)',
          boxShadow: '0 24px 60px rgba(0,0,0,0.5)', padding: 20,
          maxWidth: 860, width: '100%', maxHeight: '85vh', overflow: 'auto',
        }}
      >
        {/* Scoped print stylesheet — same device the Call Counts modal uses:
            everything outside the print area is hidden so Save-as-PDF captures
            just the worklist. Portrait: this is a narrow table. */}
        <style>{`
          @media print {
            @page { size: portrait; margin: 0.5in; }
            body * { visibility: hidden !important; }
            #d-audit-print, #d-audit-print * { visibility: visible !important; }
            /* PAGINATION (2026-08-02). The print root used to be
               'position: fixed; inset: 0' to escape the modal's own
               'overflow: auto' clipping — but a FIXED element does not
               fragment: Chrome renders it on page one and CLIPS the rest.
               Measured at letter portrait: 15 rows → 1 page and 120 rows →
               still 1 page, i.e. 105 rows silently dropped. (The
               'break-inside: avoid' rule in the Available Call sheet was
               dead for the same reason — nothing to break.) Absolute
               positioning fragments correctly (120 rows → 3 pages), but only
               once the modal chrome stops being a clipping/positioned
               ancestor — hence neutralising the shell here. */
            .fr-print-overlay, .fr-print-panel {
              position: static !important; overflow: visible !important;
              max-height: none !important; max-width: none !important;
              min-width: 0 !important; padding: 0 !important; margin: 0 !important;
              background: #fff !important; border: none !important;
              box-shadow: none !important; display: block !important;
            }
            #d-audit-print {
              position: absolute !important; inset: auto !important;
              left: 0 !important; top: 0 !important; width: 100% !important;
              background: #fff !important; color: #000 !important;
              padding: 0 !important; overflow: visible !important;
              max-height: none !important; max-width: none !important;
              border: none !important; box-shadow: none !important;
            }
            #d-audit-print .no-print { display: none !important; }
            #d-audit-print table { width: 100% !important; border-collapse: collapse; }
            #d-audit-print td, #d-audit-print th {
              color: #000 !important; border-bottom: 1px solid #ccc !important;
              padding: 4px 6px !important; font-size: 11px !important;
            }
          }
        `}</style>

        <div id="d-audit-print">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--text)' }}>
              D assignments — {grid.schedule.schedule_name}
            </div>
            <div className="no-print" style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              <button onClick={() => window.print()} style={smallBtn}>Print</button>
              {keptPlacements.length > 0 && (
                <button onClick={() => onApply(keptPlacements)} disabled={applying} style={{
                  ...smallBtn, fontWeight: 800,
                  background: 'var(--ok-bg)', color: 'var(--ok)',
                  border: '1px solid color-mix(in srgb, var(--ok) 40%, transparent)',
                }}>
                  {applying ? 'Applying…' : `Fix all (${keptPlacements.length} cells)`}
                </button>
              )}
              <button onClick={onClose} style={smallBtn}>Close</button>
            </div>
          </div>

          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
            Every D1–D8 placement re-derived from the calls around it, using this site&apos;s call
            pattern. Where a provider is owed two, the lower D wins. D4 and below are ordered by
            soonest next call — the first relief position leaves earliest. Call assignments are
            never changed.
          </div>

          {deleted.size > 0 && (
            <div className="no-print" style={{ fontSize: 12, marginBottom: 8, color: 'var(--text-muted)' }}>
              {deleted.size} deleted from this list — they will NOT be applied.{' '}
              <button onClick={() => setDeleted(new Set())} style={{ ...smallBtn, padding: '2px 8px' }}>
                Restore
              </button>
            </div>
          )}

          {kept.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--ok)', fontWeight: 700 }}>
              {audit.findings.length === 0
                ? 'Every D assignment matches the call pattern.'
                : 'Nothing left in the list.'}
            </div>
          ) : (
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12.5 }}>
              <tbody>
                {kept.map(f => (
                  <tr key={f.key} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '6px 10px 6px 0', fontWeight: 800, whiteSpace: 'nowrap', color: 'var(--text)' }}>
                      {formatMMDD(f.date)}
                    </td>
                    <td style={{ padding: '6px 10px', whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>
                      {KIND_LABEL[f.kind] ?? f.kind}
                    </td>
                    <td style={{ padding: '6px 10px', color: 'var(--text)' }}>
                      <strong>{f.providerIds.map(nameOf).join(', ')}</strong>{' '}
                      <span style={{ color: 'var(--text-muted)' }}>{readable(f)}</span>
                    </td>
                    <td className="no-print" style={{ padding: '6px 0 6px 10px', textAlign: 'right' }}>
                      <button
                        onClick={() => setDeleted(prev => new Set(prev).add(f.key))}
                        title="Remove from this list — it will not be applied"
                        style={{
                          ...smallBtn, padding: '2px 9px', lineHeight: 1.1,
                          color: gridTokens.openCall,
                          border: `1px solid color-mix(in srgb, ${gridTokens.openCall} 40%, transparent)`,
                        }}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
