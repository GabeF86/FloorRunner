'use client';

// FTE Panel — left-column "Staffing needs" card.
// Owned by agent A9 (Grid Canvas).
// PRD: docs/PRD-Grid-Calculator.md §7.8, §10.
//
// Visual rules (restyled to match the Staffing-Calculator `TotalsPanel`):
//   - Premium card surface (cardStyle) with a "Staffing needs" SectionTitle.
//   - 3-column grid of BigStat cards: Anesthesiologists / CRNAs / Backup-call.
//   - When `showWorstCase` is on, the panel exposes a Worst/Expected tab on
//     the Anesthesiologist + CRNA stats; when off, only Expected shows.
//   - A small placeholder block + "Re-run simulation" CTA stays at the bottom
//     until A14 wires the persisted recommendation flow.
//
// NOTE: A14 will wire the persisted FTE recommendation flow.

import { useState } from 'react';
import type { FTERecommendation } from '@/lib/gridCalculator/types';
import type { FloatHealth } from '@/lib/gridCalculator/floatStrategy';

const tok = {
  card: 'var(--bg-surface)',
  surface: 'var(--bg-deep)',
  border: 'var(--border)',
  hairline: '1px solid var(--border)',
  text: 'var(--text)',
  textMuted: 'var(--text-muted)',
  textDim: 'var(--text-dim)',
  mono: 'var(--font-mono), ui-monospace, monospace',
  // Role tone map for the three BigStats — Anesthesiologist indigo, CRNA blue,
  // backup-call indigo. Same trio as GridCanvas's `tok`, and the same family the
  // canvas legend and the CRNA chip paint, so a reader can tie the headcount
  // back to the thing being counted. Left literal as category colour; note that
  // `md.bg` / `crna.bg` are OPAQUE light tints, so these three tiles keep their
  // light face on a dark canvas (flagged in the tokenisation report).
  md: { fg: '#4338CA', bg: '#EEF1FE', bd: '#CBD2F7' },
  crna: { fg: '#0A6CB4', bg: '#E7F2FB', bd: '#B2D8F1' },
  backup: { fg: '#4F46E5', bg: 'rgba(79,70,229,0.08)', bd: 'rgba(79,70,229,0.30)' },
  accent: 'var(--blue)',
  radius: 14,
  radiusSm: 9,
  shadow: 'var(--shadow-card)',
};

const cardStyle: React.CSSProperties = {
  background: tok.card,
  border: '1px solid var(--border)',
  borderRadius: tok.radius,
  boxShadow: tok.shadow,
  padding: '18px 20px',
};

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

type ScenarioTab = 'worst' | 'expected';

export default function FTEPanel({
  recommendation,
  showWorstCase,
  loading = false,
  onRerun,
}: FTEPanelProps) {
  // When showWorstCase is on we expose a Worst/Expected tab. The tab is local
  // state so the user can flip without thrashing the URL.
  const [scenario, setScenario] = useState<ScenarioTab>(showWorstCase ? 'worst' : 'expected');
  const activeTab: ScenarioTab = showWorstCase ? scenario : 'expected';

  const anes = pickValue(recommendation?.anesthesiologist, activeTab);
  const crna = pickValue(recommendation?.crna, activeTab);
  const backup = typeof recommendation?.backupCall.fte === 'number'
    ? recommendation.backupCall.fte
    : null;

  return (
    <div style={cardStyle}>
      <SectionTitle>Staffing needs</SectionTitle>
      <p
        style={{
          fontSize: 11.5,
          color: tok.textMuted,
          margin: '0 0 12px 0',
          lineHeight: 1.45,
        }}
      >
        Headcount that solves every weekday under worst-case rules and Monte
        Carlo p95. The number you take to HR.
      </p>

      {showWorstCase && recommendation && (
        <div
          style={{
            display: 'inline-flex',
            padding: 2,
            background: tok.surface,
            border: '1px solid var(--border)',
            borderRadius: 999,
            gap: 1,
            marginBottom: 10,
          }}
        >
          {(['worst', 'expected'] as ScenarioTab[]).map((t) => {
            const active = t === scenario;
            return (
              <button
                key={t}
                type="button"
                onClick={() => setScenario(t)}
                style={{
                  padding: '3px 10px',
                  borderRadius: 999,
                  fontSize: 9,
                  fontWeight: 800,
                  fontFamily: tok.mono,
                  letterSpacing: 0.5,
                  textTransform: 'uppercase',
                  border: 'none',
                  // `${tok.accent}1F` concatenated hex alpha onto what is now a
                  // var() — 0x1F/0xff ≈ 12%.
                  background: active
                    ? 'color-mix(in srgb, var(--blue) 12%, transparent)'
                    : 'transparent',
                  color: active ? tok.accent : tok.textMuted,
                  cursor: 'pointer',
                  transition: 'all var(--dur-fast) var(--ease-out)',
                }}
              >
                {t === 'worst' ? 'Worst case' : 'Expected'}
              </button>
            );
          })}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
        <BigStat
          label="Anesthesiologists"
          value={formatValue(anes)}
          fg={tok.md.fg}
          bg={tok.md.bg}
          bd={tok.md.bd}
          subtitle={recommendation?.anesthesiologist.binding === 'worst_case' ? 'WC binding' : recommendation?.anesthesiologist.binding === 'monte_carlo' ? 'p95 binding' : 'pending'}
        />
        <BigStat
          label="CRNAs"
          value={formatValue(crna)}
          fg={tok.crna.fg}
          bg={tok.crna.bg}
          bd={tok.crna.bd}
          subtitle={recommendation?.crna.binding === 'worst_case' ? 'WC binding' : recommendation?.crna.binding === 'monte_carlo' ? 'p95 binding' : 'pending'}
        />
        <BigStat
          label="Backup call FTE"
          value={formatValue(backup)}
          fg={tok.backup.fg}
          bg={tok.backup.bg}
          bd={tok.backup.bd}
          subtitle="annualized"
        />
      </div>

      {/* Rationale + re-run CTA. */}
      <div
        style={{
          marginTop: 14,
          padding: 12,
          borderRadius: tok.radiusSm,
          background: tok.surface,
          border: tok.hairline,
          fontSize: 11,
          color: tok.textMuted,
          lineHeight: 1.5,
        }}
      >
        <div
          style={{
            fontSize: 9,
            fontFamily: tok.mono,
            fontWeight: 800,
            color: tok.textDim,
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
          <span style={{ fontStyle: 'italic', color: tok.textDim }}>
            No simulation run yet. Click <strong>Re-run simulation</strong> to
            generate a worst-case + Monte Carlo recommendation.
          </span>
        )}
      </div>

      <button
        type="button"
        onClick={onRerun}
        disabled={loading}
        style={{
          marginTop: 10,
          padding: '8px 12px',
          borderRadius: tok.radiusSm,
          fontSize: 11,
          fontWeight: 800,
          fontFamily: tok.mono,
          letterSpacing: 0.5,
          color: tok.accent,
          // 0x14/0xff ≈ 8%, 0x66/0xff ≈ 40%.
          background: 'color-mix(in srgb, var(--blue) 8%, transparent)',
          border: '1px solid color-mix(in srgb, var(--blue) 40%, transparent)',
          cursor: loading ? 'wait' : 'pointer',
          opacity: loading ? 0.6 : 1,
          transition: 'all var(--dur-fast) var(--ease-out)',
          width: '100%',
        }}
      >
        {loading ? '↻ Running…' : '↻ Re-run simulation'}
      </button>
    </div>
  );
}

function pickValue(
  rec: { worstCase: number; p50: number; p95: number; binding: string } | undefined,
  scenario: ScenarioTab,
): number | null {
  if (!rec) return null;
  return scenario === 'worst' ? rec.worstCase : rec.p95;
}

function formatValue(v: number | null): string {
  if (v == null) return '—';
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
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

function BigStat({
  label,
  value,
  fg,
  bg,
  bd,
  subtitle,
}: {
  label: string;
  value: string;
  fg: string;
  bg: string;
  bd: string;
  subtitle: string;
}) {
  return (
    <div
      style={{
        padding: '12px 12px 10px',
        borderRadius: tok.radiusSm,
        background: bg,
        border: `1px solid ${bd}`,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        minWidth: 0,
      }}
    >
      <div
        style={{
          fontSize: 9.5,
          color: fg,
          opacity: 0.8,
          textTransform: 'uppercase',
          letterSpacing: 0.6,
          fontWeight: 700,
          fontFamily: tok.mono,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 30,
          fontWeight: 800,
          color: fg,
          lineHeight: 0.95,
          letterSpacing: -1,
          fontVariantNumeric: 'tabular-nums',
          fontFamily: tok.mono,
        }}
      >
        {value}
      </div>
      <div
        style={{
          fontSize: 9,
          color: fg,
          fontFamily: tok.mono,
          opacity: 0.7,
          fontWeight: 600,
        }}
      >
        {subtitle}
      </div>
    </div>
  );
}
