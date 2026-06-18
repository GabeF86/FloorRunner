'use client';

// Grid Calculator Sidebar — sites, rooms, distance matrix editor.
// Owned by agent A1 (Site Architect).
// PRD: docs/PRD-Grid-Calculator.md §6, §7, §13, §14.
//
// Visual reference: src/app/board/Sidebar.tsx. Same color tokens
// (amber for Anesthesiologist, cyan for CRNA/accent), same card density.
// Tailwind-first here because the board uses inline styles + CSS vars and
// this surface ships before those vars are guaranteed to be loaded.

import { useState } from 'react';
import type { DistanceBand, DistanceEdge, GridRoom, GridSite } from '@/lib/gridCalculator/types';
import {
  BAND_LABELS,
  ORDERED_BANDS,
  findEdge,
  upperTrianglePairs,
} from '@/lib/gridCalculator/distanceMatrix';

export interface SidebarProps {
  /** All sites in the current config. Order is determined by `position`. */
  sites: GridSite[];
  /** Sparse list of declared distance edges. Missing pairs default to "near". */
  distanceEdges: DistanceEdge[];
  /** Fired when the user clicks "+ Add Site". A9 wires this to a modal. */
  onAddSite: () => void;
  /** Fired when the user clicks "+ Add Room" on a specific site lane. */
  onAddRoom: (siteId: string) => void;
  /** Fired when the user changes the distance band for a site pair. */
  onChangeBand: (siteAId: string, siteBId: string, band: DistanceBand) => void;
  /** Fired when the user toggles the per-edge supervisability override. */
  onToggleSupervisable?: (siteAId: string, siteBId: string, next: boolean) => void;
}

const ACCENT = '#0ea5e9'; // cyan — matches FloorRunner sidebar accent

/**
 * Sidebar layout:
 *  - Header with "Sites" title + "+ Add Site" button.
 *  - Scrollable list of site cards (icon, name, short caption, room count,
 *    inline "+ Room" button + collapsed room list).
 *  - Collapsible "Distance Matrix" footer card.
 *
 * Aesthetic notes: card density mirrors `src/app/board/Sidebar.tsx` — small
 * typography, tight padding, 1px borders with translucent accent colors.
 */
export default function Sidebar({
  sites,
  distanceEdges,
  onAddSite,
  onAddRoom,
  onChangeBand,
  onToggleSupervisable,
}: SidebarProps) {
  const [matrixOpen, setMatrixOpen] = useState(true);
  const [expandedSiteIds, setExpandedSiteIds] = useState<Set<string>>(new Set());

  const sortedSites = [...sites].sort((a, b) => a.position - b.position);

  function toggleSite(id: string) {
    setExpandedSiteIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <aside className="flex h-full w-full flex-col overflow-hidden bg-white">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex flex-shrink-0 items-center justify-between border-b border-slate-200 px-3 py-2">
        <div className="flex min-w-0 flex-col">
          <span className="text-[11px] font-extrabold uppercase tracking-[1.2px] text-slate-500">
            Sites
          </span>
          <span className="font-mono text-[9px] text-slate-400">
            {sortedSites.length} site{sortedSites.length === 1 ? '' : 's'} ·{' '}
            {sortedSites.reduce((n, s) => n + s.rooms.length, 0)} rooms
          </span>
        </div>
        <button
          type="button"
          onClick={onAddSite}
          className="rounded-md border border-cyan-300/60 bg-cyan-50 px-2.5 py-0.5 text-[10px] font-bold text-cyan-600 hover:bg-cyan-100"
          style={{ borderColor: 'rgba(14,165,233,0.3)', background: 'rgba(14,165,233,0.12)', color: ACCENT }}
        >
          + Add Site
        </button>
      </div>

      {/* ── Site list ───────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {sortedSites.length === 0 && (
          <div className="px-2 py-6 text-center text-xs italic text-slate-400">
            No sites yet. Click <span className="font-semibold text-cyan-600">+ Add Site</span> to start.
          </div>
        )}
        {sortedSites.map((site) => (
          <SiteCard
            key={site.id}
            site={site}
            expanded={expandedSiteIds.has(site.id)}
            onToggle={() => toggleSite(site.id)}
            onAddRoom={() => onAddRoom(site.id)}
          />
        ))}
      </div>

      {/* ── Distance Matrix ─────────────────────────────────────────────── */}
      <div className="flex-shrink-0 border-t border-slate-200">
        <button
          type="button"
          onClick={() => setMatrixOpen((v) => !v)}
          className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-slate-50"
        >
          <span className="text-[11px] font-extrabold uppercase tracking-[1.2px] text-slate-500">
            Distance Matrix
          </span>
          <span className="font-mono text-[10px] text-slate-400">
            {matrixOpen ? '▾' : '▸'} {distanceEdges.length} edge{distanceEdges.length === 1 ? '' : 's'}
          </span>
        </button>
        {matrixOpen && (
          <DistanceMatrix
            sites={sortedSites}
            edges={distanceEdges}
            onChangeBand={onChangeBand}
            onToggleSupervisable={onToggleSupervisable}
          />
        )}
      </div>
    </aside>
  );
}

// ── Site card ───────────────────────────────────────────────────────────────

function SiteCard({
  site,
  expanded,
  onToggle,
  onAddRoom,
}: {
  site: GridSite;
  expanded: boolean;
  onToggle: () => void;
  onAddRoom: () => void;
}) {
  return (
    <div
      className="mb-1.5 rounded-md border border-slate-200 bg-white transition-colors hover:border-slate-300"
      style={{ borderLeft: `3px solid ${site.color}` }}
    >
      <div className="flex items-center gap-2 px-2 py-1.5">
        <button
          type="button"
          onClick={onToggle}
          className="flex flex-1 items-center gap-2 text-left"
          aria-expanded={expanded}
        >
          <span
            className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-xs font-bold"
            style={{
              background: hexA(site.color, 0.12),
              color: site.color,
              border: `1px solid ${hexA(site.color, 0.3)}`,
            }}
          >
            {site.icon}
          </span>
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-[12px] font-semibold text-slate-800">{site.name}</span>
            {site.caption && (
              <span className="truncate font-mono text-[9px] text-slate-400">{site.caption}</span>
            )}
          </div>
          <span className="ml-auto font-mono text-[10px] text-slate-400">
            {site.rooms.length} room{site.rooms.length === 1 ? '' : 's'}
          </span>
          <span className="font-mono text-[9px] text-slate-300">{expanded ? '▾' : '▸'}</span>
        </button>
      </div>
      {expanded && (
        <div className="border-t border-slate-100 px-2 py-1.5">
          {site.rooms.length === 0 && (
            <div className="py-1 text-center text-[10px] italic text-slate-400">No rooms.</div>
          )}
          {[...site.rooms]
            .sort((a, b) => a.position - b.position)
            .map((room) => (
              <RoomRow key={room.id} room={room} accent={site.color} />
            ))}
          <button
            type="button"
            onClick={onAddRoom}
            className="mt-1 w-full rounded border border-dashed border-slate-300 px-2 py-1 text-[10px] font-bold text-slate-500 hover:border-cyan-300 hover:bg-cyan-50 hover:text-cyan-600"
          >
            + Add Room
          </button>
        </div>
      )}
    </div>
  );
}

function RoomRow({ room, accent }: { room: GridRoom; accent: string }) {
  return (
    <div className="mb-1 flex items-center gap-2 rounded px-1.5 py-1 hover:bg-slate-50">
      <span
        className="h-1.5 w-1.5 flex-shrink-0 rounded-full"
        style={{ background: accent }}
      />
      <span className="truncate text-[11px] text-slate-700">{room.name}</span>
      {room.acuityHint && (
        <span className="ml-auto rounded bg-slate-100 px-1 font-mono text-[8px] uppercase tracking-wide text-slate-500">
          {room.acuityHint}
        </span>
      )}
    </div>
  );
}

// ── Distance matrix ─────────────────────────────────────────────────────────

function DistanceMatrix({
  sites,
  edges,
  onChangeBand,
  onToggleSupervisable,
}: {
  sites: GridSite[];
  edges: DistanceEdge[];
  onChangeBand: (siteAId: string, siteBId: string, band: DistanceBand) => void;
  onToggleSupervisable?: (siteAId: string, siteBId: string, next: boolean) => void;
}) {
  const pairs = upperTrianglePairs(sites);

  if (pairs.length === 0) {
    return (
      <div className="px-3 pb-3 text-[10px] italic text-slate-400">
        Add at least two sites to configure distances.
      </div>
    );
  }

  return (
    <div className="max-h-64 overflow-y-auto px-2 pb-2">
      {pairs.map(([a, b]) => {
        const edge = findEdge(a.id, b.id, edges);
        const band: DistanceBand = edge?.band ?? 'near';
        const supervisable = edge?.supervisable ?? true;
        return (
          <div
            key={`${a.id}::${b.id}`}
            className="mb-1 flex items-center gap-2 rounded border border-slate-100 bg-slate-50/60 px-2 py-1.5"
          >
            <PairChip site={a} />
            <span className="font-mono text-[10px] text-slate-400">↔</span>
            <PairChip site={b} />
            <select
              value={band}
              onChange={(e) => onChangeBand(a.id, b.id, e.target.value as DistanceBand)}
              className="ml-auto rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-slate-700 focus:border-cyan-400 focus:outline-none"
              aria-label={`Distance band between ${a.name} and ${b.name}`}
            >
              {ORDERED_BANDS.map((bnd) => (
                <option key={bnd} value={bnd}>
                  {BAND_LABELS[bnd]}
                </option>
              ))}
            </select>
            {onToggleSupervisable && (
              <label
                className="flex items-center gap-1"
                title="Allow supervision across this pair (overrides band default)."
              >
                <input
                  type="checkbox"
                  checked={supervisable}
                  onChange={(e) => onToggleSupervisable(a.id, b.id, e.target.checked)}
                  style={{ accentColor: ACCENT }}
                  className="h-3 w-3 cursor-pointer"
                />
                <span className="font-mono text-[9px] text-slate-500">sup</span>
              </label>
            )}
          </div>
        );
      })}
    </div>
  );
}

function PairChip({ site }: { site: GridSite }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold"
      style={{
        background: hexA(site.color, 0.1),
        color: site.color,
        border: `1px solid ${hexA(site.color, 0.25)}`,
      }}
    >
      <span className="text-[10px] leading-none">{site.icon}</span>
      <span className="max-w-[78px] truncate">{site.shortName ?? site.name}</span>
    </span>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Convert `#rrggbb` plus alpha (0..1) into an `rgba(...)` string. Tolerates
 * malformed input by falling back to slate-500.
 */
function hexA(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return `rgba(100,116,139,${alpha})`;
  const v = parseInt(m[1], 16);
  const r = (v >> 16) & 0xff;
  const g = (v >> 8) & 0xff;
  const b = v & 0xff;
  return `rgba(${r},${g},${b},${alpha})`;
}
