'use client';

/* ── Call spacing review overlay ─────────────────────────────────────────────
 * DYNAMICALLY IMPORTED (next/dynamic, ssr: false) by the schedule grid page.
 * It renders only behind `showSpacing`, so none of it is needed to paint the
 * grid. `ssr: false` is correct: a click-gated overlay.
 *
 * The arithmetic stays in lib/callSpacing.ts and eligibility stays the cell
 * picker's own decision (lib/slotCandidates) — the page computes the review and
 * the candidate index and passes both in, so a suggestion here can never offer
 * someone the picker would refuse. Moved verbatim out of page.tsx.
 * ───────────────────────────────────────────────────────────────────────── */

import { useState, useMemo } from 'react';
import { gridTokens } from './gridTheme';
import { callsByProvider, gapHistogram, rankSwapCandidates } from '@/lib/callSpacing';
import { candidatesForSlot } from '@/lib/slotCandidates';
// Type-only: the page runs both of these and hands the results down as props;
// this module only names their return shapes.
import type { reviewTightPairs } from '@/lib/callSpacing';
import type { buildCandidateIndex } from '@/lib/slotCandidates';
import { formatMMDD, smallBtn, type GridData } from './gridShared';

/* ── Call spacing review (Gabriel 2026-07-31) ──────────────────────────────
 * "identify providers with C1 calls that are spaced too close together and
 * options to swap with them other call takers that are available."
 *
 * The arithmetic is lib/callSpacing.ts; eligibility is the PICKER's own
 * decision (slotCandidates) so a suggestion here can never offer someone the
 * cell picker would refuse. This component only renders and dispatches.
 */
export function SpacingModal({
  grid, code, maxGap, setMaxGap, review, candidateIndex, onClose, onSwap,
}: {
  grid: GridData;
  code: string;
  maxGap: number;
  setMaxGap: (n: number) => void;
  review: ReturnType<typeof reviewTightPairs>;
  candidateIndex: ReturnType<typeof buildCandidateIndex> | null;
  onClose: () => void;
  onSwap: (slotId: string, providerId: string) => void;
}) {
  const [openPair, setOpenPair] = useState<string | null>(null);
  const nameOf = (pid: string) =>
    grid.providers.find(p => p.id === pid)?.short_display_name ?? pid;
  const held = useMemo(() => callsByProvider(grid.slots, code), [grid, code]);
  // Distribution up to a week, so the threshold is chosen from the board.
  const histogram = useMemo(() => gapHistogram(grid.slots, code, 7), [grid, code]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 800,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--bg-deep)', borderRadius: 12, border: '1px solid var(--border)',
          boxShadow: '0 24px 60px rgba(0,0,0,0.5)', padding: 20,
          maxWidth: 780, width: '100%', maxHeight: '85vh', overflow: 'auto',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--text)' }}>
            {code} spacing
          </div>
          <div style={{ marginLeft: 'auto' }}>
            <button onClick={onClose} style={smallBtn}>Close</button>
          </div>
        </div>

        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
          Consecutive {code} calls held by the same provider, {maxGap} days apart or less.
          Only a <strong style={{ color: 'var(--text)' }}>weekday</strong> {code} can be moved:
          every Fri/Sat/Sun {code} is chain-locked by the pattern (a Friday {code} anchors the
          Sunday C2; the weekend {code}s ride the weekend block chains), so those ends are shown
          for context but never offered. Different codes are never paired — a Saturday C2 into a
          Sunday C1 is one day apart by design.
          <div style={{ marginTop: 6 }}>
            Whole block:{' '}
            {[...histogram].sort((a, b) => a[0] - b[0])
              .map(([gap, n]) => `${n} at ${gap}d`).join(' · ') || 'nothing under 8 days'}
            {review.excludedChainLocked > 0 && (
              <> · {review.excludedChainLocked} weekend-to-weekend pair
                {review.excludedChainLocked === 1 ? '' : 's'} not listed (both ends chain-locked)</>
            )}
          </div>
        </div>

        <label style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-muted)' }}>
          Flag gaps of{' '}
          <select
            value={maxGap}
            onChange={e => setMaxGap(Number(e.target.value))}
            style={{
              padding: '4px 8px', borderRadius: 6, fontWeight: 700,
              background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)',
            }}
          >
            {[2, 3, 4, 5, 6, 7].map(n => <option key={n} value={n}>{n} days</option>)}
          </select>{' '}
          or less
        </label>

        {review.pairs.length === 0 ? (
          <div style={{ marginTop: 16, fontSize: 13, color: 'var(--text-muted)' }}>
            No {code} calls are within {maxGap} days of each other.
          </div>
        ) : (
          <div style={{ marginTop: 14 }}>
            {review.pairs.map(pair => {
              const key = `${pair.providerId}|${pair.earlier.slotId}|${pair.later.slotId}`;
              const isOpen = openPair === key;
              return (
                <div key={key} style={{ borderTop: '1px solid var(--border)', padding: '10px 0' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <span style={{
                      fontWeight: 800,
                      color: pair.gap <= 2 ? gridTokens.openCall : 'var(--text)',
                      minWidth: 44,
                    }}>
                      {pair.gap}d
                    </span>
                    <span style={{ fontWeight: 700, color: 'var(--text)' }}>{nameOf(pair.providerId)}</span>
                    <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
                      {formatMMDD(pair.earlier.date)} {pair.earlier.code}
                      {'  →  '}
                      {formatMMDD(pair.later.date)} {pair.later.code}
                    </span>
                    <button
                      onClick={() => setOpenPair(isOpen ? null : key)}
                      style={{ ...smallBtn, marginLeft: 'auto', padding: '4px 10px' }}
                    >
                      {isOpen
                        ? 'Hide'
                        : `Swap ${pair.swappable.map(c => formatMMDD(c.date)).join(' or ')}`}
                    </button>
                  </div>

                  {isOpen && (
                    <div style={{ marginTop: 8, paddingLeft: 54 }}>
                      {!candidateIndex ? (
                        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                          Eligibility unavailable — reload the grid.
                        </div>
                      ) : pair.swappable.map(target => {
                        const groups = candidatesForSlot(candidateIndex, target.slotId);
                        const eligible = groups.available.map(c => c.provider.id)
                          .filter(pid => pid !== pair.providerId);
                        const ranked = rankSwapCandidates(eligible, held, target.date, pair.gap);
                        return (
                          <div key={target.slotId} style={{ marginBottom: 10 }}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 3 }}>
                              Move {formatMMDD(target.date)} {target.code} to:
                            </div>
                            {ranked.length === 0 ? (
                              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                                Nobody else is available.
                                {groups.blocked.length > 0
                                  && ` ${groups.blocked.length} provider(s) blocked — the cell picker says why.`}
                              </div>
                            ) : (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                {ranked.map(c => (
                                  <div key={c.providerId}
                                    style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5 }}>
                                    <span style={{ fontWeight: 700, color: 'var(--text)', minWidth: 110 }}>
                                      {nameOf(c.providerId)}
                                    </span>
                                    <span style={{ color: c.improves ? 'var(--ok)' : gridTokens.openCall }}>
                                      {Number.isFinite(c.resultingGap)
                                        ? `would sit ${c.resultingGap}d from their nearest ${code}`
                                        : `has no other ${code}`}
                                      {c.improves ? '' : ' — no better'}
                                    </span>
                                    <button
                                      onClick={() => { onSwap(target.slotId, c.providerId); onClose(); }}
                                      style={{ ...smallBtn, marginLeft: 'auto', padding: '3px 10px' }}
                                    >
                                      Give it to them
                                    </button>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
