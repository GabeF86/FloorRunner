'use client';

// Grid Canvas — the visual grid component.
// Owned by agent A9 (Grid Canvas).
// PRD: docs/PRD-Grid-Calculator.md §7, §8, §14 (A9).
//
// Layout (mirrors the Staffing-Calculator page chrome verbatim):
//   - Outer wrapper: `max-width: 1200, margin: 0 auto, padding: 28px 32px 48px`.
//   - Breadcrumb: `scheduling / grid calculator` in 11px mono uppercase.
//   - Header card: 24px 750-weight title + 13px subtitle, in a premium card
//     surface (`var(--bg-surface)`, `borderRadius: 14`, soft `boxShadow`).
//   - Main grid: `312px 1fr` two columns. Left column is sticky (top: 16) and
//     holds the ToggleBar + FTEPanel. Right column scrolls and shows the lanes.
//
// Re-solve flow (PRD §14, A9):
//   1. Read toggles via `useSearchParams` (handled by `useGridToggles`).
//   2. solve() → applyFloatStrategy() → assessFloatHealth() synchronously.
//   3. FTE recommendation: stub here, with a re-run button. A14 wires the API.
//   4. Shimmer: a 200ms CSS keyframe (grid-calc-shimmer) re-triggered via a
//      `key`-bump on the grid wrapper on every toggle change.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  DEMO_PAOLI_FIXTURE,
  buildFixtureFromSites,
  solveAndAssess,
  useGridToggles,
} from './state';
import type { DemoFixture, GridToggles } from './state';
import type { RoomAssignment } from '@/lib/gridCalculator/solver';
import type { FTERecommendation, GridSite } from '@/lib/gridCalculator/types';
import { formatRoomHours, totalWeeklyHours } from '@/lib/gridCalculator/operatingHours';
import ToggleBar from './ToggleBar';
import SiteLane from './SiteLane';
import FTEPanel from './FTEPanel';
import SitesPanel, { pickSiteColor } from './SitesPanel';

// Shared token object — mirrors /staffing-calculator (lines 18-35) verbatim.
const tok = {
  card: 'var(--bg-surface)',
  surface: 'var(--bg-deep)',
  border: 'var(--border)',
  hairline: '1px solid var(--border)',
  text: 'var(--text)',
  textMuted: 'var(--text-muted)',
  textDim: 'var(--text-dim)',
  mono: 'var(--font-mono), ui-monospace, monospace',
  md: { fg: '#4338CA', bg: '#EEF1FE', bd: '#CBD2F7' },
  crna: { fg: '#0A6CB4', bg: '#E7F2FB', bd: '#B2D8F1' },
  accent: '#0284c7',
  warning: '#E8C854',
  radius: 14,
  radiusSm: 9,
  shadow: '0 1px 2px rgba(15,23,42,0.05), 0 10px 28px -16px rgba(15,23,42,0.18)',
};

// One premium card surface used by every panel — generous padding, soft
// elevation, larger radius. Mirrors staffing-calculator exactly.
const cardStyle: React.CSSProperties = {
  background: tok.card,
  border: '1px solid var(--border)',
  borderRadius: tok.radius,
  boxShadow: tok.shadow,
  padding: '18px 20px',
};

export interface GridCanvasProps {
  /** Optional fixture override — falls back to the demo Paoli fixture. */
  fixture?: DemoFixture;
}

export default function GridCanvas({ fixture = DEMO_PAOLI_FIXTURE }: GridCanvasProps) {
  const { toggles, setToggle } = useGridToggles();

  // Editable site state — initialized from the provided fixture (default = the
  // demo Paoli set) and mutated through the SitesPanel handlers below. Roster,
  // edges, and rules are all derived from the site list so the user only has
  // to think about sites + rooms; the rest cycles automatically.
  const [sites, setSites] = useState<GridSite[]>(() => fixture.sites);

  // Derive the full fixture from the current sites + the config id. Memoized
  // on the sites identity so changes propagate cleanly through the solver.
  const editableFixture = useMemo(
    () => buildFixtureFromSites(fixture.configId, sites),
    [fixture.configId, sites],
  );

  // Re-solve every toggle change OR site change. Pure / fast / synchronous.
  const solveResult = useMemo(
    () => solveAndAssess(editableFixture, toggles),
    [editableFixture, toggles],
  );

  // Site-mutation handlers. Each one assigns a fresh array so React re-renders.
  const handleAddSite = useCallback(
    (name: string) => {
      setSites((prev) => {
        const id = `site-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${prev.length + 1}`;
        const next: GridSite = {
          id,
          name,
          shortName: name.length > 8 ? name.slice(0, 8) : name,
          color: pickSiteColor(prev.length),
          icon: '⬡',
          position: prev.length,
          rooms: [
            { id: `${id}-room-1`, siteId: id, name: `${name} 1`, position: 0 },
          ],
        };
        return [...prev, next];
      });
    },
    [],
  );

  const handleAddRoom = useCallback((siteId: string, roomName: string) => {
    setSites((prev) =>
      prev.map((s) => {
        if (s.id !== siteId) return s;
        const id = `${s.id}-room-${s.rooms.length + 1}`;
        return {
          ...s,
          rooms: [
            ...s.rooms,
            { id, siteId: s.id, name: roomName, position: s.rooms.length },
          ],
        };
      }),
    );
  }, []);

  const handleDeleteSite = useCallback((siteId: string) => {
    setSites((prev) => prev.filter((s) => s.id !== siteId));
  }, []);

  const handleDeleteRoom = useCallback((siteId: string, roomId: string) => {
    setSites((prev) =>
      prev.map((s) =>
        s.id === siteId
          ? { ...s, rooms: s.rooms.filter((r) => r.id !== roomId) }
          : s,
      ),
    );
  }, []);

  const handleUpdateRoomHours = useCallback(
    (
      siteId: string,
      roomId: string,
      patch: { weekdayCloseHour?: number; weekendOpen?: boolean },
    ) => {
      setSites((prev) =>
        prev.map((s) =>
          s.id === siteId
            ? {
                ...s,
                rooms: s.rooms.map((r) =>
                  r.id === roomId ? { ...r, ...patch } : r,
                ),
              }
            : s,
        ),
      );
    },
    [],
  );

  // Shimmer key: bumps every time `toggles` change, which re-mounts the
  // keyframe and replays the 200ms animation. Avoids a setTimeout.
  const shimmerKey = useShimmerKey(toggles);

  // Sites lookup for cross-site badges.
  const siteLookup = useMemo(() => {
    const m = new Map<string, GridSite>();
    for (const s of editableFixture.sites) m.set(s.id, s);
    return m;
  }, [editableFixture.sites]);

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
    for (const s of editableFixture.sites) {
      for (const r of s.rooms) m.set(r.id, r.name);
    }
    return m;
  }, [editableFixture.sites]);

  // Map roomId -> formatted hours ("M-F 7-15") for the lane row header.
  const roomHoursById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of editableFixture.sites) {
      for (const r of s.rooms) m.set(r.id, formatRoomHours(r));
    }
    return m;
  }, [editableFixture.sites]);

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
    setRecommendation(makeMockedRecommendation(editableFixture));
    setLoading(false);
  };
  // Clear the mocked recommendation when toggles OR sites change so the
  // placeholder copy returns. A14 will replace this with a fresh fetch.
  useEffect(() => {
    setRecommendation(undefined);
  }, [toggles, sites]);

  // Float lane label — synthesized; floats themselves come from the solver.
  const floatLaneLabel = {
    name: 'Float',
    shortName: 'Float',
    icon: '✦',
    color: '#64748b',
    caption: 'breaks · add-ons · standby',
  };

  return (
    <div style={{ padding: '28px 32px 48px', maxWidth: 1200, margin: '0 auto' }}>
      {/* Breadcrumb — mirrors staffing-calculator. */}
      <div
        style={{
          fontSize: 11,
          color: tok.textDim,
          marginBottom: 14,
          fontFamily: tok.mono,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          textTransform: 'uppercase',
          letterSpacing: 0.4,
        }}
      >
        <span style={{ color: tok.textMuted }}>scheduling</span>
        <span style={{ opacity: 0.5 }}>/</span>
        <span style={{ color: tok.textMuted }}>grid calculator</span>
      </div>

      {/* Header card */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          padding: '20px 22px',
          marginBottom: 18,
          ...cardStyle,
        }}
      >
        <div>
          <h1
            style={{
              fontSize: 24,
              fontWeight: 750,
              color: tok.text,
              letterSpacing: -0.6,
              lineHeight: 1.1,
            }}
          >
            Grid Calculator
          </h1>
          <div style={{ fontSize: 13, color: tok.textMuted, marginTop: 5, lineHeight: 1.4 }}>
            How many Anesthesiologists and CRNAs do we need to hire? Adjust the
            knobs, read the lane plan, take the FTE recommendation to HR.
          </div>
        </div>

        {/* Float-health pill on the right, mirroring staffing's facility-toggle row. */}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          <FloatHealthPill level={solveResult.health.level} binding={solveResult.health.binding} />
        </div>
      </div>

      {solveResult.grid.violations.length > 0 && (
        <ViolationBanner violations={solveResult.grid.violations} />
      )}

      {/* Main grid: config (left, 312px sticky) | output (right, flex) */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '312px 1fr',
          gap: 18,
          alignItems: 'start',
        }}
      >
        {/* Left column — sites editor + toggle bar + FTE panel (config rail). */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
            position: 'sticky',
            top: 16,
          }}
        >
          <SitesPanel
            sites={sites}
            onAddSite={handleAddSite}
            onAddRoom={handleAddRoom}
            onDeleteSite={handleDeleteSite}
            onDeleteRoom={handleDeleteRoom}
            onUpdateRoomHours={handleUpdateRoomHours}
          />
          <ToggleBar toggles={toggles} onToggle={setToggle} />
          <FTEPanel
            recommendation={recommendation}
            floatHealth={solveResult.health}
            showWorstCase={toggles.showWorstCase}
            loading={loading}
            onRerun={handleRerun}
          />
        </div>

        {/* Right column — site lanes. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={cardStyle}>
            <SectionTitle>By site — supervision map</SectionTitle>
            <div
              key={shimmerKey}
              className="grid-shimmer"
              style={{
                position: 'relative',
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                marginTop: 6,
                minWidth: 0,
              }}
            >
              {editableFixture.sites
                .slice()
                .sort((a, b) => a.position - b.position)
                .map((site) => {
                  const rooms = (assignmentsBySite.get(site.id) ?? []).map((a) => ({
                    assignment: a,
                    roomName: roomNameById.get(a.roomId) ?? a.roomId,
                    roomId: a.roomId,
                    roomHours: roomHoursById.get(a.roomId),
                  }));
                  return (
                    <SiteLane
                      key={site.id}
                      site={site}
                      variant="site"
                      roomAssignments={rooms}
                      providerLabels={editableFixture.providerLabels}
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
                providerLabels={editableFixture.providerLabels}
                siteLookup={siteLookup}
                ratioCap={ratioCap}
              />
            </div>

            <Legend />
          </div>
        </div>
      </div>

      {/* Shimmer keyframe. 200ms per PRD §7.7. Locked grid-calc-shimmer name. */}
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

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 13.5,
        fontWeight: 650,
        color: tok.text,
        letterSpacing: -0.15,
        paddingBottom: 10,
        marginBottom: 14,
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}
    >
      {children}
    </div>
  );
}

function Legend() {
  return (
    <div
      style={{
        marginTop: 10,
        padding: '6px 10px',
        borderRadius: 5,
        background: tok.surface,
        border: tok.hairline,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
        fontSize: 9,
        color: tok.textDim,
        fontFamily: tok.mono,
      }}
    >
      <span style={{ fontWeight: 700, color: tok.textMuted }}>LEGEND</span>
      <LegendDot color="#4A90D9" label="Supervising Anesthesiologist" shape="square" />
      <LegendDot color="#B06AE8" label="Solo Anesthesiologist" shape="square" />
      <LegendDot color="#80CBC4" label="Float" shape="square" dashed />
      <LegendDot color={tok.crna.fg} label="CRNA" shape="round" />
      <LegendDot color="#a855f7" label="Cross-site" shape="round" dashed />
      <span style={{ marginLeft: 'auto', color: tok.textMuted }}>
        Headcount-planning view — slots are anonymous.
      </span>
    </div>
  );
}

function LegendDot({
  color,
  label,
  shape,
  dashed,
}: {
  color: string;
  label: string;
  shape: 'round' | 'square';
  dashed?: boolean;
}) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span
        style={{
          width: shape === 'round' ? 8 : 12,
          height: shape === 'round' ? 8 : 10,
          borderRadius: shape === 'round' ? 4 : 3,
          border: `1.5px ${dashed ? 'dashed' : 'solid'} ${color}`,
          background: 'transparent',
          flexShrink: 0,
        }}
      />
      <span>{label}</span>
    </span>
  );
}

function FloatHealthPill({
  level,
  binding,
}: {
  level: 'ok' | 'tight' | 'warning' | 'critical';
  binding: string;
}) {
  const COLORS = {
    ok: { fg: '#085041', bg: '#E1F5EE', bd: '#A8DBC9', label: 'Float ok' },
    tight: { fg: '#b45309', bg: 'rgba(245,158,11,0.10)', bd: 'rgba(245,158,11,0.40)', label: 'Float tight' },
    warning: { fg: '#b45309', bg: 'rgba(234,88,12,0.12)', bd: 'rgba(234,88,12,0.40)', label: 'Float warning' },
    critical: { fg: '#dc2626', bg: 'rgba(239,68,68,0.10)', bd: 'rgba(239,68,68,0.40)', label: 'Float critical' },
  } as const;
  const c = COLORS[level];
  return (
    <span
      title={binding}
      style={{
        padding: '4px 10px',
        borderRadius: 999,
        fontSize: 10,
        fontWeight: 700,
        fontFamily: tok.mono,
        background: c.bg,
        color: c.fg,
        border: `0.5px solid ${c.bd}`,
        textTransform: 'uppercase',
        letterSpacing: 0.4,
      }}
    >
      {c.label}
    </span>
  );
}

function ViolationBanner({ violations }: { violations: string[] }) {
  return (
    <div
      role="status"
      style={{
        padding: '10px 14px',
        marginBottom: 14,
        borderRadius: 6,
        background: 'rgba(245,158,11,0.10)',
        border: '0.5px solid rgba(245,158,11,0.30)',
        fontSize: 12,
        color: '#b45309',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontFamily: tok.mono,
          fontWeight: 800,
          letterSpacing: 0.5,
          textTransform: 'uppercase',
          color: '#b45309',
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
  // Hours-aware mock: rooms that run later need more FTE than rooms that
  // close early. Reflects PRD §5 "FTE hours are demand, not headcount".
  const weeklyHours = totalWeeklyHours(fixture.sites);
  const mds = Math.max(2, Math.ceil(weeklyHours / 100));
  const crnas = Math.max(2, Math.ceil(weeklyHours / 35));
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
