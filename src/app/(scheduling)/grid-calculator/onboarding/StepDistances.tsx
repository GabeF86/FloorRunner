'use client';

// Step 3 — Distance matrix.
// Owned by agent A15 (Onboarding Wizard).
// PRD: docs/PRD-Grid-Calculator.md §6, §13, §14 (A15), §17.
//
// Renders one row per unordered site pair. Each row exposes a 5-band dropdown
// (same_room / adjacent / near / far / off_campus) and a supervisability
// override checkbox. Defaults: every undeclared pair is treated as `near`.
//
// For single-site hospitals the matrix is empty and we surface a helpful
// "Skip this step" prompt — the parent route advances on Next regardless.
//
// We reuse A1's `BAND_LABELS` / `ORDERED_BANDS` / `findEdge` helpers from
// `distanceMatrix.ts` rather than reimplementing them (charter rule: import
// existing helpers when they nearly fit, do not duplicate).

import type { Dispatch } from 'react';

import {
  BAND_LABELS,
  ORDERED_BANDS,
  defaultBandLevel,
  findEdge,
  upperTrianglePairs,
} from '@/lib/gridCalculator/distanceMatrix';
import type {
  DistanceBand,
  DistanceEdge,
  GridSite,
} from '@/lib/gridCalculator/types';

import type { WizardAction } from './wizardState';

const SLATE = '#64748b';

export interface StepDistancesProps {
  sites: GridSite[];
  distances: DistanceEdge[];
  dispatch: Dispatch<WizardAction>;
}

export default function StepDistances({
  sites,
  distances,
  dispatch,
}: StepDistancesProps) {
  const pairs = upperTrianglePairs(sites);

  if (sites.length < 2) {
    return (
      <Panel>
        <Header
          title="Distance matrix"
          subtitle="Only one site so far — there's nothing to relate."
        />
        <EmptyState>
          Single-site hospitals don't need a distance matrix. Click{' '}
          <strong style={{ color: 'var(--text-strong)' }}>Next</strong> to skip
          this step. If you add more sites later, this matrix will populate
          automatically.
        </EmptyState>
      </Panel>
    );
  }

  return (
    <Panel>
      <Header
        title="Distance matrix"
        subtitle="For each site pair, pick a distance band. Pairs you skip default to “Near” (allowed but flagged). Use the supervisable checkbox to override the default policy for that band."
      />
      <BandLegend />
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        {pairs.map(([a, b]) => {
          const edge = findEdge(a.id, b.id, distances);
          const band: DistanceBand = edge?.band ?? 'near';
          const supervisable = edge?.supervisable ?? true;
          return (
            <DistanceRow
              key={`${a.id}::${b.id}`}
              siteA={a}
              siteB={b}
              band={band}
              supervisable={supervisable}
              onChangeBand={(next) =>
                dispatch({
                  type: 'setDistance',
                  siteAId: a.id,
                  siteBId: b.id,
                  band: next,
                })
              }
              onToggleSupervisable={(next) =>
                dispatch({
                  type: 'setSupervisable',
                  siteAId: a.id,
                  siteBId: b.id,
                  supervisable: next,
                })
              }
            />
          );
        })}
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Distance row — single unordered pair.
// ---------------------------------------------------------------------------

function DistanceRow({
  siteA,
  siteB,
  band,
  supervisable,
  onChangeBand,
  onToggleSupervisable,
}: {
  siteA: GridSite;
  siteB: GridSite;
  band: DistanceBand;
  supervisable: boolean;
  onChangeBand: (next: DistanceBand) => void;
  onToggleSupervisable: (next: boolean) => void;
}) {
  const level = defaultBandLevel(band);
  const levelColor =
    level === 'safe' ? '#10b981' : level === 'warning' ? '#f59e0b' : '#ef4444';

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 10px',
        background: 'var(--bg-base)',
        border: '1px solid var(--border)',
        borderRadius: 8,
      }}
    >
      <SiteChip site={siteA} />
      <span
        aria-hidden
        style={{
          color: SLATE,
          fontSize: 11,
          fontFamily: 'var(--font-mono), ui-monospace, monospace',
        }}
      >
        ↔
      </span>
      <SiteChip site={siteB} />

      <select
        value={band}
        onChange={(e) => onChangeBand(e.target.value as DistanceBand)}
        aria-label={`Distance band between ${siteA.name} and ${siteB.name}`}
        style={{
          marginLeft: 'auto',
          padding: '4px 8px',
          fontSize: 11,
          fontFamily: 'inherit',
          border: '1px solid var(--border)',
          borderRadius: 6,
          background: 'var(--bg-surface)',
          color: 'var(--text)',
          fontWeight: 600,
        }}
      >
        {ORDERED_BANDS.map((b) => (
          <option key={b} value={b}>
            {BAND_LABELS[b]}
          </option>
        ))}
      </select>

      <span
        aria-label={`Default supervisability: ${level}`}
        title={`Band default policy: ${level}`}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          fontSize: 10,
          fontFamily: 'var(--font-mono), ui-monospace, monospace',
          color: levelColor,
          fontWeight: 700,
          textTransform: 'uppercase',
          padding: '2px 6px',
          borderRadius: 4,
          background: `${levelColor}1A`,
          border: `1px solid ${levelColor}55`,
        }}
      >
        ● {level}
      </span>

      <label
        title="Allow supervision across this pair (overrides band default)."
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          fontSize: 10,
          fontFamily: 'var(--font-mono), ui-monospace, monospace',
          color: SLATE,
          cursor: 'pointer',
          fontWeight: 600,
        }}
      >
        <input
          type="checkbox"
          checked={supervisable}
          onChange={(e) => onToggleSupervisable(e.target.checked)}
          style={{ accentColor: '#0ea5e9' }}
        />
        sup
      </label>
    </div>
  );
}

function SiteChip({ site }: { site: GridSite }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 8px',
        borderRadius: 5,
        background: hexA(site.color, 0.1),
        border: `1px solid ${hexA(site.color, 0.3)}`,
        color: site.color,
        fontSize: 11,
        fontWeight: 700,
        maxWidth: 180,
      }}
    >
      <span aria-hidden style={{ fontSize: 12 }}>
        {site.icon}
      </span>
      <span
        style={{
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {site.name}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Legend strip — explains the safe / warning / blocked color coding.
// ---------------------------------------------------------------------------

function BandLegend() {
  return (
    <div
      style={{
        display: 'flex',
        gap: 10,
        flexWrap: 'wrap',
        padding: '6px 0 2px',
        fontSize: 10,
        fontFamily: 'var(--font-mono), ui-monospace, monospace',
        color: SLATE,
      }}
    >
      <LegendChip color="#10b981" label="safe — supervise freely" />
      <LegendChip color="#f59e0b" label="warning — flagged, solver biases away" />
      <LegendChip color="#ef4444" label="blocked — not supervisable by default" />
    </div>
  );
}

function LegendChip({ color, label }: { color: string; label: string }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
      }}
    >
      <span
        style={{
          display: 'inline-block',
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: color,
        }}
      />
      <span>{label}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Local helpers.
// ---------------------------------------------------------------------------

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      {children}
    </div>
  );
}

function Header({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <h2
        style={{
          fontSize: 13,
          fontWeight: 700,
          color: 'var(--text-strong)',
          letterSpacing: -0.1,
          marginBottom: 2,
        }}
      >
        {title}
      </h2>
      <p
        style={{
          fontSize: 11,
          color: 'var(--text-muted)',
          margin: 0,
          lineHeight: 1.5,
        }}
      >
        {subtitle}
      </p>
    </div>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: '20px 12px',
        color: SLATE,
        fontSize: 12,
        textAlign: 'center',
        lineHeight: 1.6,
        background: 'var(--bg-base)',
        border: '1px dashed var(--border)',
        borderRadius: 8,
      }}
    >
      {children}
    </div>
  );
}

function hexA(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return `rgba(100,116,139,${alpha})`;
  const v = parseInt(m[1], 16);
  const r = (v >> 16) & 0xff;
  const g = (v >> 8) & 0xff;
  const b = v & 0xff;
  return `rgba(${r},${g},${b},${alpha})`;
}
