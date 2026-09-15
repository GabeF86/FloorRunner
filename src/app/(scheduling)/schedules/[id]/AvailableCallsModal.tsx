'use client';

/* ── Available Call List overlay ─────────────────────────────────────────────
 * DYNAMICALLY IMPORTED (next/dynamic, ssr: false) by the schedule grid page.
 * It renders only behind `showAvailableCalls`, so nothing here is needed to
 * paint the grid — which is what a chief is actually waiting for. Keeping it
 * in page.tsx put its markup and its print stylesheet in the route's first
 * load for every visit that never opened it. `ssr: false` is correct: this is
 * a click-gated overlay that is never server-rendered.
 *
 * Moved verbatim out of page.tsx — same props, same logic, same rendering.
 * ───────────────────────────────────────────────────────────────────────── */

import { useState } from 'react';
import { gridTokens } from './gridTheme';
import { bucketSummaryText, formatAvailableCallText } from '@/lib/availableCalls';
// Type-only: the list itself is built by the page and handed down as a prop;
// this module never calls the builder, it only names its return shape.
import type { buildAvailableCallList } from '@/lib/availableCalls';

/* ── Available Call List ─────────────────────────────────────────────────────
 * Gabriel: "I want you to create an 'Available Call List' that lists the
 * day/date/type of call so that I know which calls i need to list up for
 * grabs". Every unfilled call slot in the block — the same slots the grid now
 * paints red, from the same predicate.
 *
 * SHAPE. A chronological worklist, because that is how it gets posted and
 * worked down, grouped BY WEEKEND: one cluster per Fri/Sat/Sun, one per
 * Mon–Thu date. A whole weekend standing open is one conversation with the
 * group; four scattered Tuesdays are four. Above them sits the count he prices
 * from: the per-DAY-TYPE breakdown (the engine's own fairness buckets, so a
 * holiday-dated call is counted under the day of the week it lands on) and the
 * per-CODE tally.
 *
 * OUTPUT. Print follows the Call Counts precedent exactly — a scoped
 * @media print block that hides everything outside the print area and pins
 * black-on-white — but PORTRAIT, since this is a narrow list rather than a
 * 27-column table. Copy puts the same document on the clipboard as plain text
 * (formatAvailableCallText), because posting it is a paste into an email or a
 * text thread, not a PDF attachment.
 *
 * This component RENDERS ONLY. Membership, ordering, bucketing, clustering and
 * the text form are all in lib/availableCalls.ts with its test — vitest runs
 * with no jsdom, so no rule may live here.
 * ───────────────────────────────────────────────────────────────────────── */
export function AvailableCallsModal({
  list,
  title,
  onClose,
}: {
  list: ReturnType<typeof buildAvailableCallList>;
  title: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(formatAvailableCallText(list, title));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard denied (insecure context / permission). The list is still on
      // screen and selectable, and Print / Save PDF is right there — silently
      // doing nothing is the honest outcome, but say so rather than pretend.
      setCopied(false);
      alert('Could not reach the clipboard. Select the list and copy it, or use Print / Save PDF.');
    }
  };

  const summary = bucketSummaryText(list);

  return (
    <div
      className="fr-print-overlay"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)',
        zIndex: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}
    >
      <div
        className="fr-print-panel"
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--bg-deep)', borderRadius: 12, border: '1px solid var(--border)',
          boxShadow: '0 24px 60px rgba(0,0,0,0.5)',
          padding: 20, maxWidth: '95vw', maxHeight: '90vh', overflow: 'auto', minWidth: 560,
        }}
      >
        {/* Scoped print stylesheet — the Call Counts pattern (everything
            outside the print area hidden, the area pinned to the page box,
            black on white because browsers drop background colour when
            printing). PORTRAIT: this is a four-column list, not a wide table,
            and it is meant to be handed round on paper. */}
        <style>{`
          @media print {
            @page { size: portrait; margin: 0.5in; }
            body * { visibility: hidden !important; }
            #available-call-print, #available-call-print * { visibility: visible !important; }
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
            #available-call-print {
              position: absolute !important; inset: auto !important;
              left: 0 !important; top: 0 !important; width: 100% !important;
              background: #fff !important; color: #000 !important;
              padding: 0 !important; overflow: visible !important;
              max-height: none !important; max-width: none !important;
              min-width: 0 !important; border: none !important;
            }
            #available-call-print table, #available-call-print th, #available-call-print td {
              color: #000 !important; border-color: #666 !important;
              background: #fff !important;
            }
            #available-call-print table { font-size: 9pt !important; width: 100% !important; }
            #available-call-print th, #available-call-print td { padding: 2px 4px !important; }
            /* A cluster must never be split across a page break — a weekend
               that lands half on page 1 and half on page 2 reads as two
               separate offers. */
            #available-call-print .ac-cluster { break-inside: avoid; page-break-inside: avoid; }
            /* The grid's "already posted" mark is a coloured dot, which print
               drops; the list spells the word instead, so the paper copy says
               which calls are already out with the group. */
            #available-call-print .no-print { display: none !important; }
          }
        `}</style>

        <div id="available-call-print">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14, gap: 16 }}>
            <div>
              <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--text)' }}>Available Call</div>
              <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 2 }}>
                {title} — every unfilled call slot, to list up for grabs.
              </div>
              {list.total > 0 && (
                <>
                  <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 6, fontWeight: 700 }}>
                    {list.total} open call slot{list.total === 1 ? '' : 's'}
                    {list.postedCount > 0 && ` — ${list.postedCount} already posted`}
                    {summary && <> · {summary}</>}
                  </div>
                  {list.byCode.length > 0 && (
                    <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 3 }}>
                      {list.byCode.map(c => `${c.code} ${c.count}`).join(' · ')}
                    </div>
                  )}
                </>
              )}
            </div>
            <div className="no-print" style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              {list.total > 0 && (
                <button onClick={handleCopy} style={{
                  padding: '7px 15px', fontSize: 12.5, fontWeight: 700, borderRadius: 8, cursor: 'pointer',
                  background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)',
                }}>{copied ? 'Copied ✓' : 'Copy'}</button>
              )}
              {list.total > 0 && (
                <button onClick={() => window.print()} style={{
                  padding: '7px 16px', fontSize: 12.5, fontWeight: 700, border: 'none', borderRadius: 8, cursor: 'pointer',
                  background: 'linear-gradient(135deg,#0ea5e9,#6366f1)', color: '#fff', boxShadow: '0 4px 14px rgba(56,130,246,0.35)',
                }}>Print / Save PDF</button>
              )}
              <button onClick={onClose} style={{
                padding: '7px 15px', fontSize: 12.5, fontWeight: 700, borderRadius: 8, cursor: 'pointer',
                background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)',
              }}>Close</button>
            </div>
          </div>

          {list.total === 0 ? (
            <div style={{
              padding: '22px 16px', textAlign: 'center', fontSize: 13, fontWeight: 600,
              color: 'var(--text-dim)', border: '1px dashed var(--border)', borderRadius: 8,
            }}>
              No unfilled call slots — every call in this block is covered.
            </div>
          ) : (
            list.clusters.map(cluster => (
              <div key={cluster.key} className="ac-cluster" style={{ marginBottom: 14 }}>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4,
                  paddingBottom: 3, borderBottom: '1px solid var(--border)',
                }}>
                  <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--text)' }}>{cluster.label}</span>
                  <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-dim)' }}>
                    {cluster.rows.length} open
                  </span>
                  {/* The one annotation that changes what this cluster IS: a
                      whole Fri/Sat/Sun standing open is a different offer from
                      three unrelated days that happen to be adjacent. */}
                  {cluster.wholeWeekend && (
                    <span style={{
                      fontSize: 9.5, fontWeight: 800, letterSpacing: '0.06em',
                      padding: '1px 6px', borderRadius: 999,
                      color: gridTokens.openCall,
                      border: `1px solid ${gridTokens.openCall}`,
                    }}>WHOLE WEEKEND</span>
                  )}
                </div>
                <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12.5 }}>
                  <tbody>
                    {cluster.rows.map(row => (
                      <tr key={row.slotId}>
                        <td style={{ padding: '3px 8px 3px 0', width: 34, fontWeight: 700, color: 'var(--text-muted)' }}>
                          {row.dayName}
                        </td>
                        <td style={{ padding: '3px 10px 3px 0', width: 54, color: 'var(--text-muted)' }}>
                          {row.dateShort}
                        </td>
                        <td style={{ padding: '3px 10px 3px 0', width: 62, fontWeight: 800, color: 'var(--text)' }}>
                          {row.code}
                        </td>
                        <td style={{ padding: '3px 0', color: 'var(--text-dim)' }}>
                          {row.name}
                          {row.holidayName && (
                            <span style={{ marginLeft: 6, fontWeight: 700, color: '#b45309' }}>
                              ({row.holidayName})
                            </span>
                          )}
                          {row.locked && <span style={{ marginLeft: 6 }} title="Locked slot">&#x1F512;</span>}
                        </td>
                        <td style={{ padding: '3px 0', width: 68, textAlign: 'right' }}>
                          {row.posted && (
                            <span
                              title="Already posted to the group for pickup."
                              style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-dim)' }}
                            >posted</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
