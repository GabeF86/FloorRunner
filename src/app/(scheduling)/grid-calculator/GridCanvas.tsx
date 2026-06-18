'use client';

// Grid Canvas — the visual grid component.
// Owned by agent A9 (Grid Canvas).
// PRD: docs/PRD-Grid-Calculator.md §7, §8, §14 (A9).
//
// Composition:
//   - <ToggleBar> at the top (sticky).
//   - One <SiteLane> per site, in `position` order.
//   - A pinned <SiteLane variant='float'> last.
//   - All wrapped by a 200ms shimmer animation on every solve.
//
// Re-solve flow (PRD §14, A9, points 1-4):
//   1. Read toggles via `useSearchParams` (handled by `useGridToggles`).
//   2. solve() → applyFloatStrategy() → assessFloatHealth() synchronously.
//   3. FTE recommendation: stub here, with a re-run button. A14 wires the API.
//   4. Shimmer: a CSS keyframe re-triggered via a `key`-bump on the grid wrapper.
//
// Drag-to-rebalance (PRD §14, A9): documented as v2 polish — Gabriel approves
// the static layout first, drag interaction lands once aesthetics are signed off.

import { useEffect, useMemo, useRef, useState } from 'react';

import { DEMO_PAOLI_FIXTURE, solveAndAssess, useGridToggles } from './state';
import type { DemoFixture, GridToggles } from './state';
import type { RoomAssignment } from '@/lib/gridCalculator/solver';
import type { FTERecommendation, GridSite } from '@/lib/gridCalculator/types';
import ToggleBar from './ToggleBar';
import SiteLane from './SiteLane';
import FTEPanel from './FTEPanel';

export interface GridCanvasProps {
  /** Optional fixture override — falls back to the demo Paoli fixture. */
  fixture?: DemoFixture;
}

export default function GridCanvas({ fixture = DEMO_PAOLI_FIXTURE }: GridCanvasProps) {
  const { toggles, setToggle } = useGridToggles();

  // Re-solve every toggle change. Pure / fast / synchronous.
  const solveResult = useMemo(
    () => solveAndAssess(fixture, toggles),
    [fixture, toggles],
  );

  // Shimmer key: bumps every time `toggles` change, which re-mounts the
  // keyframe and replays the 200ms animation. Avoids a setTimeout.
  const shimmerKey = useShimmerKey(toggles);

  // Sites lookup for cross-site badges.
  const siteLookup = useMemo(() => {
    const m = new Map<string, GridSite>();
    for (const s of fixture.sites) m.set(s.id, s);
    return m;
  }, [fixture.sites]);

  // Group assignments by site id for the lane renderer.
  const assignmentsBySite = useMemo(() => {
    const m = new Map<string, RoomAssignment[]>();
    for (const a of solveResult.grid.assignments) {
      const arr = m.get(a.siteId) ?? [];
      arr.push(a);
      m.set(a.siteId, arr);
    }
    return m;
  }, [solveResult.grid.assignments]);

  // Map roomId -> name from the fixture for the lane row header.
  const roomNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of fixture.sites) {
      for (const r of s.rooms) m.set(r.id, r.name);
    }
    return m;
  }, [fixture.sites]);

  const ratioCap = supervisionRatioCap(toggles);

  // FTE recommendation: placeholder for v1. Locally cached re-runs land here.
  // A14 will replace this hook with a real /api/grid-calculator/fte-run call.
  const [recommendation, setRecommendation] = useState<FTERecommendation | undefined>();
  const [loading, setLoading] = useState(false);
  const handleRerun = async () => {
    setLoading(true);
    // TODO(A14): POST to /api/grid-calculator/fte-run with the current config.
    // Until then, we synthesize a quick mocked recommendation so the rail
    // doesn't stay empty after the user clicks. Cleared on next toggle change.
    await new Promise((r) => setTimeout(r, 350));
    setRecommendation(makeMockedRecommendation(fixture));
    setLoading(false);
  };
  // Clear the mocked recommendation when toggles change so the placeholder
  // copy returns. A14 will replace this with a fresh fetch.
  useEffect(() => {
    setRecommendation(undefined);
  }, [toggles]);

  // Float lane label — synthesized; floats themselves come from the solver.
  const floatLaneLabel = {
    name: 'Float',
    shortName: 'Float',
    icon: '✦',
    color: '#64748b',
    caption: 'breaks · add-ons · standby',
  };

  return (
    <div
      data-grid-canvas-root
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) 340px',
        gap: 14,
        alignItems: 'start',
        padding: '12px 16px 24px',
        minHeight: '100%',
      }}
    >
      {/* ── Center: toggle bar + lanes ────────────────────────────────────── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
        <ToggleBar toggles={toggles} onToggle={setToggle} />

        {solveResult.grid.violations.length > 0 && (
          <ViolationBanner violations={solveResult.grid.violations} />
        )}

        <div
          key={shimmerKey}
          className="grid-shimmer"
          style={{
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
            gap: 0,
            minWidth: 0,
          }}
        >
          {fixture.sites
            .slice()
            .sort((a, b) => a.position - b.position)
            .map((site) => {
              const rooms = (assignmentsBySite.get(site.id) ?? []).map((a) => ({
                assignment: a,
                roomName: roomNameById.get(a.roomId) ?? a.roomId,
                roomId: a.roomId,
              }));
              return (
                <SiteLane
                  key={site.id}
                  site={site}
                  variant="site"
                  roomAssignments={rooms}
                  providerLabels={fixture.providerLabels}
                  siteLookup={siteLookup}
                  ratioCap={ratioCap}
                />
              );
            })}

          {/* Float lane always last per PRD §7.5. */}
          <SiteLane
            laneLabel={floatLaneLabel}
            variant="float"
            floats={solveResult.grid.floats}
            providerLabels={fixture.providerLabels}
            siteLookup={siteLookup}
            ratioCap={ratioCap}
          />
        </div>
      </div>

      {/* ── Right rail: FTE recommendation ────────────────────────────────── */}
      <div style={{ position: 'sticky', top: 12 }}>
        <FTEPanel
          recommendation={recommendation}
          floatHealth={solveResult.health}
          showWorstCase={toggles.showWorstCase}
          loading={loading}
          onRerun={handleRerun}
        />
      </div>

      {/* Shimmer keyframe. 200ms per PRD §7.7. */}
      <style jsx global>{`
        @keyframes grid-calc-shimmer {
          0% {
            opacity: 0.55;
            transform: translateY(2px);
            filter: blur(0.5px);
          }
          50% {
            opacity: 0.9;
            transform: translateY(0);
            filter: blur(0px);
          }
          100% {
            opacity: 1;
            transform: translateY(0);
            filter: blur(0px);
          }
        }
        .grid-shimmer {
          animation: grid-calc-shimmer 200ms ease-out;
        }
      `}</style>
    </div>
  );
}

function ViolationBanner({ violations }: { violations: string[] }) {
  return (
    <div
      role="status"
      style={{
        padding: '8px 12px',
        borderRadius: 8,
        background: 'rgba(239,68,68,0.06)',
        border: '1px solid rgba(239,68,68,0.3)',
        color: '#dc2626',
        fontSize: 11,
        fontWeight: 600,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontFamily: 'var(--font-mono), ui-monospace, monospace',
          fontWeight: 800,
          letterSpacing: 0.5,
          textTransform: 'uppercase',
          color: '#b91c1c',
        }}
      >
        {violations.length} solver violation{violations.length === 1 ? '' : 's'}
      </div>
      {violations.slice(0, 3).map((v, i) => (
        <span key={i} style={{ opacity: 0.85 }}>
          • {v}
        </span>
      ))}
      {violations.length > 3 && (
        <span style={{ fontStyle: 'italic', opacity: 0.7 }}>
          …and {violations.length - 3} more.
        </span>
      )}
    </div>
  );
}

function supervisionRatioCap(toggles: GridToggles): number {
  switch (toggles.supervisionRatio) {
    case 'mostly_1_3':
      return 3;
    case 'mostly_1_4':
      return 4;
    case 'mixed':
      return 4;
  }
}

/**
 * Re-mounts the shimmer wrapper on every toggle change. We rely on the fact
 * that React replays a CSS animation when the element's key changes — no JS
 * timer, no `setTimeout` cleanup pain.
 */
function useShimmerKey(toggles: GridToggles): string {
  const ref = useRef(0);
  const key = useMemo(() => {
    ref.current += 1;
    return `${ref.current}::${toggles.coverageStyle}::${toggles.supervisionRatio}::${toggles.floatStrategy}::${toggles.backupPosture}::${toggles.showWorstCase ? 1 : 0}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toggles.coverageStyle, toggles.supervisionRatio, toggles.floatStrategy, toggles.backupPosture, toggles.showWorstCase]);
  return key;
}

/**
 * Lightweight mocked recommendation used while A14 wires the real one. Numbers
 * are derived from the fixture size so they look credible without running a
 * real Monte Carlo on the client.
 */
function makeMockedRecommendation(fixture: DemoFixture): FTERecommendation {
  const totalRooms = fixture.sites.reduce((acc, s) => acc + s.rooms.length, 0);
  const mds = Math.max(2, Math.ceil(totalRooms * 0.7));
  const crnas = Math.max(2, Math.ceil(totalRooms * 1.3));
  return {
    anesthesiologist: {
      worstCase: mds + 2,
      p50: mds + 1,
      p95: mds + 2,
      binding: 'worst_case',
    },
    crna: {
      worstCase: crnas + 2,
      p50: crnas + 1,
      p95: crnas + 2,
      binding: 'monte_carlo',
    },
    backupCall: {
      fte: 1.0,
      distribution: [],
    },
    rationale:
      'Mocked recommendation — A14 will replace this with a persisted run hitting the FTE simulator API. Worst-case binding for Anesthesiologists; Monte Carlo p95 binding for CRNAs (sample sizes).',
  };
}
