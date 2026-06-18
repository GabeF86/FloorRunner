'use client';

// Distance Graph — small SVG renderer for the supervisability matrix.
// Owned by agent A5 (Distance & Supervisability).
//
// Renders sites as nodes (radial layout, no force-direction needed at this
// scale) and supervision-feasible edges as colored lines:
//
//   - solid green     -> always-safe (same_room / adjacent)
//   - dashed amber    -> near with override (allowed but flagged)
//   - light gray dot  -> blocked (far / off_campus / near without override)
//
// Pure SVG, no external libraries. Receives `sites` + `edges` as props plus a
// few optional rendering knobs. Used by the sidebar (A1) and the canvas (A9).
//
// Universality contract: no hospital-specific assumptions live here.
//
// PRD: docs/PRD-Grid-Calculator.md §6, §7, §14 (A5 charter).

import { useMemo } from 'react';
import type { DistanceEdge, GridSite } from '@/lib/gridCalculator/types';
import {
  renderEdgeStyles,
  type EdgeRenderStyle,
  type SupervisabilityOptions,
} from '@/lib/gridCalculator/supervisability';

export interface DistanceGraphProps {
  /** Sites to render. Order is determined by `position`. */
  sites: GridSite[];
  /** Sparse list of declared distance edges. Missing pairs use the band defaults. */
  edges: DistanceEdge[];
  /** Overall SVG width in px. Defaults to 280 (sidebar-friendly). */
  width?: number;
  /** Overall SVG height in px. Defaults to 280. */
  height?: number;
  /** Optional supervisability resolver options (e.g. allowNearOverride). */
  options?: SupervisabilityOptions;
  /** Optional title for screen readers. Defaults to "Distance graph". */
  ariaLabel?: string;
}

interface LaidOutNode {
  siteId: string;
  name: string;
  color: string;
  shortLabel: string;
  x: number;
  y: number;
}

// Stroke styles per edge classification. Kept here as constants so the legend
// stays in sync.
const STROKE_STYLES: Record<
  EdgeRenderStyle,
  { stroke: string; strokeWidth: number; strokeDasharray?: string; opacity: number }
> = {
  safe: { stroke: '#10b981', strokeWidth: 1.75, opacity: 0.9 }, // emerald-500
  override: {
    stroke: '#f59e0b', // amber-500
    strokeWidth: 1.5,
    strokeDasharray: '5 3',
    opacity: 0.95,
  },
  blocked: {
    stroke: '#9ca3af', // gray-400
    strokeWidth: 1,
    strokeDasharray: '2 3',
    opacity: 0.55,
  },
};

/**
 * Radial layout: equally spaced around a circle, deterministic by `position`.
 * For a single site we put it dead center; for two we draw them on a horizontal
 * line so the single edge reads cleanly.
 */
function layoutNodes(sites: GridSite[], width: number, height: number): LaidOutNode[] {
  const cx = width / 2;
  const cy = height / 2;
  const padding = 28; // leave room for node labels
  const r = Math.max(20, Math.min(cx, cy) - padding);

  const ordered = [...sites].sort((a, b) => {
    if (a.position !== b.position) return a.position - b.position;
    return a.id < b.id ? -1 : 1;
  });

  if (ordered.length === 0) return [];
  if (ordered.length === 1) {
    const s = ordered[0];
    return [
      {
        siteId: s.id,
        name: s.name,
        color: s.color,
        shortLabel: s.shortName ?? firstWord(s.name),
        x: cx,
        y: cy,
      },
    ];
  }
  if (ordered.length === 2) {
    const [a, b] = ordered;
    return [
      {
        siteId: a.id,
        name: a.name,
        color: a.color,
        shortLabel: a.shortName ?? firstWord(a.name),
        x: cx - r,
        y: cy,
      },
      {
        siteId: b.id,
        name: b.name,
        color: b.color,
        shortLabel: b.shortName ?? firstWord(b.name),
        x: cx + r,
        y: cy,
      },
    ];
  }

  // Standard radial. Start at top (-π/2) so the first site is at 12 o'clock.
  const step = (Math.PI * 2) / ordered.length;
  return ordered.map((s, i) => {
    const theta = -Math.PI / 2 + step * i;
    return {
      siteId: s.id,
      name: s.name,
      color: s.color,
      shortLabel: s.shortName ?? firstWord(s.name),
      x: cx + r * Math.cos(theta),
      y: cy + r * Math.sin(theta),
    };
  });
}

function firstWord(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  return trimmed.split(/\s+/)[0];
}

/**
 * Small, dependency-free SVG visualization of the distance/supervisability
 * graph. Renders even with empty `sites` (just shows the legend), so callers
 * can drop it into any layout without conditional guards.
 */
export default function DistanceGraph({
  sites,
  edges,
  width = 280,
  height = 280,
  options,
  ariaLabel = 'Distance graph',
}: DistanceGraphProps) {
  const nodes = useMemo(() => layoutNodes(sites, width, height), [sites, width, height]);

  const renderedEdges = useMemo(
    () => renderEdgeStyles(sites.map((s) => s.id), edges, options),
    [sites, edges, options],
  );

  const nodePositions = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>();
    for (const n of nodes) m.set(n.siteId, { x: n.x, y: n.y });
    return m;
  }, [nodes]);

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={ariaLabel}
      style={{ display: 'block' }}
    >
      <title>{ariaLabel}</title>

      {/* Background card */}
      <rect
        x={0.5}
        y={0.5}
        width={width - 1}
        height={height - 1}
        rx={10}
        ry={10}
        fill="rgba(15,23,42,0.02)"
        stroke="rgba(15,23,42,0.08)"
        strokeWidth={1}
      />

      {/* Edges first, so nodes paint on top. */}
      <g>
        {renderedEdges.map((edge) => {
          const a = nodePositions.get(edge.siteA);
          const b = nodePositions.get(edge.siteB);
          if (!a || !b) return null;
          const s = STROKE_STYLES[edge.style];
          return (
            <line
              key={`${edge.siteA}::${edge.siteB}`}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={s.stroke}
              strokeWidth={s.strokeWidth}
              strokeDasharray={s.strokeDasharray}
              opacity={s.opacity}
              strokeLinecap="round"
            >
              <title>{`${edge.band} (${edge.allowed ? 'allowed' : 'blocked'})`}</title>
            </line>
          );
        })}
      </g>

      {/* Nodes */}
      <g>
        {nodes.map((n) => (
          <g key={n.siteId} transform={`translate(${n.x}, ${n.y})`}>
            <circle
              r={11}
              fill={n.color}
              fillOpacity={0.18}
              stroke={n.color}
              strokeWidth={1.5}
            />
            <text
              x={0}
              y={3}
              textAnchor="middle"
              fontSize={9}
              fontWeight={600}
              fill="rgb(15,23,42)"
              style={{ pointerEvents: 'none' }}
            >
              {n.shortLabel.slice(0, 4)}
            </text>
            <text
              x={0}
              y={22}
              textAnchor="middle"
              fontSize={9}
              fill="rgb(71,85,105)"
              style={{ pointerEvents: 'none' }}
            >
              {n.name}
            </text>
          </g>
        ))}
      </g>

      {/* Legend (always rendered — even with no sites — so the component
          has visible content on empty input). */}
      <g transform={`translate(8, ${height - 38})`}>
        <LegendSwatch x={0} label="Safe" style={STROKE_STYLES.safe} />
        <LegendSwatch x={76} label="Override" style={STROKE_STYLES.override} />
        <LegendSwatch x={170} label="Blocked" style={STROKE_STYLES.blocked} />
      </g>
    </svg>
  );
}

function LegendSwatch({
  x,
  label,
  style,
}: {
  x: number;
  label: string;
  style: (typeof STROKE_STYLES)[EdgeRenderStyle];
}) {
  return (
    <g transform={`translate(${x}, 0)`}>
      <line
        x1={0}
        y1={6}
        x2={24}
        y2={6}
        stroke={style.stroke}
        strokeWidth={style.strokeWidth}
        strokeDasharray={style.strokeDasharray}
        opacity={style.opacity}
        strokeLinecap="round"
      />
      <text x={30} y={9} fontSize={9} fill="rgb(71,85,105)">
        {label}
      </text>
    </g>
  );
}
