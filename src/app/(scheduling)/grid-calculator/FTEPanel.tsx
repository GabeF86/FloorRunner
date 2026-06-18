'use client';

// FTE Panel — persistent right-rail card with the FTE recommendation.
// Owned by agent A9 (Grid Canvas).
// PRD: docs/PRD-Grid-Calculator.md §7.8, §10.
//
// Visual rules (PRD §7.8):
//   - Persistent right rail (never moves with the grid).
//   - Three numbers: Anesthesiologists, CRNAs, Backup-call FTE.
//   - Each number has a "Worst case / Expected" tab.
//   - When `showWorstCase` is OFF, the panel collapses to expected-value only.
//
// v1 wiring shortcut: this panel currently shows a placeholder + a
// "Re-run simulation" button that the page-level handler stubs out. Per the
// PRD §14 (A9) acceptable shortcut, this defers the persisted-recommendation
// flow to A14. Once A14 wires the route, the props here gain a real
// `FTERecommendation` and the placeholder copy goes away.
//
// NOTE: A14 will wire up the persisted FTE recommendation flow.
// Until then the panel either renders the optional injected `recommendation`
// or a placeholder structure with a re-run CTA.

import type { FTERecommendation } from '@/lib/gridCalculator/types';
import type { FloatHealth } from '@/lib/gridCalculator/floatStrategy';

export interface FTEPanelProps {
  /** Optional recommendation. Until A14 wires it, expect undefined. */
  recommendation?: FTERecommendation;
  /** Float Health badge from the canvas — surfaced as a small chip up top. */
  floatHealth: FloatHealth;
  /** Whether to expose the worst-case columns. PRD §8.5. */
  showWorstCase: boolean;
  /** Whether a simulation re-run is in progress. */
  loading?: boolean;
  /** Called when the user clicks "Re-run simulation". */
  onRerun: () => void;
}

const AMBER = '#f59e0b';
const CYAN = '#0ea5e9';
const INDIGO = '#6366f1';

export default function FTEPanel({
  recommendation,
  floatHealth,
  showWorstCase,
  loading = false,
  onRerun,
}: FTEPanelProps) {
  return (
    <aside
      aria-label="FTE Recommendation"
      style={{
        width: '100%',
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
        // Persistent — the parent gives this a sticky position when there's
        // room on screen. See page.tsx layout.
      }}
    >
      <div>
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: 8,
            marginBottom: 4,
          }}
        >
          <span
            style={{
              fontSize: 10,
              fontFamily: 'var(--font-mono), ui-monospace, monospace',
              fontWeight: 800,
              color: 'var(--text-muted)',
              letterSpacing: 0.5,
              textTransform: 'uppercase',
            }}
          >
            FTE recommendation
          </span>
          <FloatHealthChip health={floatHealth} />
        </div>
        <div
          style={{
            fontSize: 11,
            color: 'var(--text-muted)',
            lineHeight: 1.4,
          }}
        >
          Headcount that solves every weekday under worst-case rules and Monte
          Carlo p95. <span style={{ fontStyle: 'italic' }}>
            Recommendation = max(worst case, p95).
          </span>
        </div>
      </div>

      {/* ── Numbers ──────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <FTERow
          label="Anesthesiologists"
          accent={AMBER}
          showWorstCase={showWorstCase}
          worstCase={recommendation?.anesthesiologist.worstCase}
          expected={recommendation?.anesthesiologist.p95}
          p50={recommendation?.anesthesiologist.p50}
          binding={recommendation?.anesthesiologist.binding}
        />
        <FTERow
          label="CRNAs"
          accent={CYAN}
          showWorstCase={showWorstCase}
          worstCase={recommendation?.crna.worstCase}
          expected={recommendation?.crna.p95}
          p50={recommendation?.crna.p50}
          binding={recommendation?.crna.binding}
        />
        <FTERow
          label="Backup call FTE"
          accent={INDIGO}
          showWorstCase={false}
          expected={recommendation?.backupCall.fte}
        />
      </div>

      {/* ── Rationale ────────────────────────────────────────────────────── */}
      <div
        style={{
          padding: 10,
          borderRadius: 6,
          background: 'var(--bg-deep)',
          border: '1px solid var(--border)',
          fontSize: 11,
          color: 'var(--text-muted)',
          lineHeight: 1.5,
        }}
      >
        <div
          style={{
            fontSize: 9,
            fontFamily: 'var(--font-mono), ui-monospace, monospace',
            fontWeight: 800,
            color: 'var(--text-dim)',
            letterSpacing: 0.4,
            textTransform: 'uppercase',
            marginBottom: 4,
          }}
        >
          Rationale
        </div>
        {recommendation?.rationale ? (
          <span>{recommendation.rationale}</span>
        ) : (
          <span style={{ fontStyle: 'italic', color: 'var(--text-dim)' }}>
            No simulation run yet. Click <strong>Re-run simulation</strong> to
            generate a worst-case + Monte Carlo recommendation. (A14 will wire
            this up as the persisted recommendation flow.)
          </span>
        )}
      </div>

      <button
        type="button"
        onClick={onRerun}
        disabled={loading}
        style={{
          padding: '8px 12px',
          borderRadius: 6,
          fontSize: 11,
          fontWeight: 800,
          fontFamily: 'var(--font-mono), ui-monospace, monospace',
          letterSpacing: 0.5,
          color: '#0ea5e9',
          background: 'rgba(14,165,233,0.12)',
          border: '1px solid rgba(14,165,233,0.4)',
          cursor: loading ? 'wait' : 'pointer',
          opacity: loading ? 0.6 : 1,
          transition: 'all 0.15s',
        }}
      >
        {loading ? '↻ Running…' : '↻ Re-run simulation'}
      </button>
    </aside>
  );
}

interface FTERowProps {
  label: string;
  accent: string;
  showWorstCase: boolean;
  worstCase?: number;
  expected?: number;
  p50?: number;
  binding?: 'worst_case' | 'monte_carlo';
}

function FTERow({ label, accent, showWorstCase, worstCase, expected, p50, binding }: FTERowProps) {
  const showBoth = showWorstCase && typeof worstCase === 'number' && typeof expected === 'number';
  const expectedValue = typeof expected === 'number' ? expected : '—';
  const worstValue = typeof worstCase === 'number' ? worstCase : '—';

  return (
    <div
      style={{
        padding: '10px 12px',
        borderRadius: 8,
        background: hexA(accent, 0.07),
        border: `1px solid ${hexA(accent, 0.25)}`,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 8,
          marginBottom: 6,
        }}
      >
        <span
          style={{
            fontSize: 10,
            fontFamily: 'var(--font-mono), ui-monospace, monospace',
            fontWeight: 800,
            color: accent,
            letterSpacing: 0.4,
            textTransform: 'uppercase',
          }}
        >
          {label}
        </span>
        {binding && (
          <span
            title={`Binding constraint: ${binding === 'worst_case' ? 'worst case' : 'Monte Carlo p95'}`}
            style={{
              fontSize: 8,
              fontFamily: 'var(--font-mono), ui-monospace, monospace',
              padding: '1px 5px',
              borderRadius: 3,
              background: hexA(accent, 0.14),
              color: accent,
              fontWeight: 700,
              letterSpacing: 0.3,
            }}
          >
            {binding === 'worst_case' ? 'WC' : 'P95'}
          </span>
        )}
      </div>
      {showBoth ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          <Stat color={accent} kind="worst" value={worstValue} />
          <Stat color={accent} kind="expected" value={expectedValue} />
        </div>
      ) : (
        <Stat color={accent} kind="expected" value={expectedValue} large />
      )}
      {typeof p50 === 'number' && (
        <div
          style={{
            fontSize: 9,
            fontFamily: 'var(--font-mono), ui-monospace, monospace',
            color: 'var(--text-dim)',
            marginTop: 4,
          }}
        >
          p50 {p50.toFixed(1)} · p95 {typeof expected === 'number' ? expected.toFixed(1) : '—'}
        </div>
      )}
    </div>
  );
}

function Stat({
  color,
  kind,
  value,
  large = false,
}: {
  color: string;
  kind: 'worst' | 'expected';
  value: number | string;
  large?: boolean;
}) {
  const labels = {
    worst: 'Worst case',
    expected: 'Expected',
  };
  return (
    <div style={{ padding: '4px 0' }}>
      <div
        style={{
          fontSize: 8,
          fontFamily: 'var(--font-mono), ui-monospace, monospace',
          color: 'var(--text-muted)',
          letterSpacing: 0.4,
          textTransform: 'uppercase',
          fontWeight: 700,
        }}
      >
        {labels[kind]}
      </div>
      <div
        style={{
          fontSize: large ? 28 : 22,
          fontWeight: 800,
          color,
          fontFamily: 'var(--font-mono), ui-monospace, monospace',
          lineHeight: 1.1,
          marginTop: 1,
        }}
      >
        {value}
      </div>
    </div>
  );
}

function FloatHealthChip({ health }: { health: FloatHealth }) {
  const COLORS = {
    ok: { color: '#16a34a', bg: 'rgba(22,163,74,0.10)', label: 'Float ok' },
    tight: { color: '#ca8a04', bg: 'rgba(202,138,4,0.12)', label: 'Float tight' },
    warning: { color: '#ea580c', bg: 'rgba(234,88,12,0.12)', label: 'Float warning' },
    critical: { color: '#dc2626', bg: 'rgba(220,38,38,0.12)', label: 'Float critical' },
  } as const;
  const c = COLORS[health.level];
  return (
    <span
      title={health.binding}
      style={{
        fontSize: 9,
        fontFamily: 'var(--font-mono), ui-monospace, monospace',
        fontWeight: 800,
        padding: '2px 7px',
        borderRadius: 999,
        background: c.bg,
        color: c.color,
        border: `1px solid ${hexA(c.color, 0.35)}`,
        letterSpacing: 0.4,
        textTransform: 'uppercase',
      }}
    >
      {c.label}
    </span>
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
