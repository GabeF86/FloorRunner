'use client';

// Toggle Bar — sticky top-of-canvas bar with the five PRD §8 toggles.
// Owned by agent A9 (Grid Canvas).
// PRD: docs/PRD-Grid-Calculator.md §7.7, §8.
//
// Visual rules (PRD §7.7):
//   - Sticky at the top of the canvas.
//   - On every toggle change, the grid re-solves with a 200ms shimmer animation.
//     The shimmer is owned by the canvas (a `<style jsx>` keyframe — see
//     GridCanvas.tsx); this component just exposes the toggle state.
//
// Aesthetic note: the toggle bar uses pill-shaped segmented controls. Each
// pill has a clear active color and a hairline border. Compact mono labels.

import type { GridToggles } from './state';

export interface ToggleBarProps {
  toggles: GridToggles;
  onToggle: <K extends keyof GridToggles>(key: K, value: GridToggles[K]) => void;
}

const SECTIONS: Array<{
  key: keyof GridToggles;
  label: string;
  description: string;
  options: Array<{ value: string; label: string }>;
}> = [
  {
    key: 'coverageStyle',
    label: 'Coverage',
    description: 'Bias toward solo Anesthesiologist vs supervised CRNA rooms',
    options: [
      { value: 'md_heavy', label: 'Anesthesiologist-heavy' },
      { value: 'balanced', label: 'Balanced' },
      { value: 'crna_heavy', label: 'CRNA-heavy' },
    ],
  },
  {
    key: 'supervisionRatio',
    label: 'Ratio',
    description: 'Average CRNAs per supervising Anesthesiologist',
    options: [
      { value: 'mostly_1_3', label: '1 : 3' },
      { value: 'mostly_1_4', label: '1 : 4' },
      { value: 'mixed', label: 'Mixed' },
    ],
  },
  {
    key: 'floatStrategy',
    label: 'Float',
    description: 'Where floats lean (breaks vs emergencies)',
    options: [
      { value: 'break_priority', label: 'Breaks' },
      { value: 'emergency_priority', label: 'Emergencies' },
      { value: 'balanced', label: 'Balanced' },
    ],
  },
  {
    key: 'backupPosture',
    label: 'Backup',
    description: 'Backup-call posture (aggressive = more partial-FTE backups)',
    options: [
      { value: 'aggressive', label: 'Aggressive' },
      { value: 'conservative', label: 'Conservative' },
    ],
  },
];

export default function ToggleBar({ toggles, onToggle }: ToggleBarProps) {
  return (
    <div
      role="toolbar"
      aria-label="Grid calculator toggles"
      style={{
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 12,
        padding: '10px 14px',
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        position: 'sticky',
        top: 0,
        zIndex: 5,
        boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
      }}
    >
      {SECTIONS.map((section) => (
        <ToggleGroup
          key={section.key}
          label={section.label}
          description={section.description}
          options={section.options}
          value={String(toggles[section.key])}
          onSelect={(v) => onToggle(section.key, v as never)}
        />
      ))}

      {/* Show worst case — single boolean toggle. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          marginLeft: 'auto',
        }}
      >
        <span
          style={{
            fontSize: 9,
            color: 'var(--text-muted)',
            fontFamily: 'var(--font-mono), ui-monospace, monospace',
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
          }}
          title="Show worst-case FTE column in the right rail"
        >
          Show worst case
        </span>
        <button
          type="button"
          onClick={() => onToggle('showWorstCase', !toggles.showWorstCase)}
          aria-pressed={toggles.showWorstCase}
          style={{
            padding: '3px 10px',
            borderRadius: 999,
            fontSize: 10,
            fontWeight: 800,
            fontFamily: 'var(--font-mono), ui-monospace, monospace',
            border: `1px solid ${
              toggles.showWorstCase
                ? 'rgba(14,165,233,0.5)'
                : 'var(--border)'
            }`,
            background: toggles.showWorstCase
              ? 'rgba(14,165,233,0.14)'
              : 'transparent',
            color: toggles.showWorstCase ? '#0ea5e9' : 'var(--text-muted)',
            cursor: 'pointer',
            transition: 'all 0.12s',
          }}
        >
          {toggles.showWorstCase ? 'ON' : 'OFF'}
        </button>
      </div>
    </div>
  );
}

interface ToggleGroupProps {
  label: string;
  description: string;
  options: Array<{ value: string; label: string }>;
  value: string;
  onSelect: (v: string) => void;
}

function ToggleGroup({ label, description, options, value, onSelect }: ToggleGroupProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span
        style={{
          fontSize: 9,
          fontFamily: 'var(--font-mono), ui-monospace, monospace',
          fontWeight: 800,
          color: 'var(--text-muted)',
          letterSpacing: 0.6,
          textTransform: 'uppercase',
        }}
        title={description}
      >
        {label}
      </span>
      <div
        style={{
          display: 'inline-flex',
          padding: 2,
          background: 'var(--bg-deep)',
          border: '1px solid var(--border)',
          borderRadius: 999,
          gap: 1,
        }}
      >
        {options.map((opt) => {
          const active = opt.value === value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onSelect(opt.value)}
              aria-pressed={active}
              style={{
                padding: '3px 9px',
                borderRadius: 999,
                fontSize: 10,
                fontWeight: 700,
                fontFamily: 'var(--font-mono), ui-monospace, monospace',
                border: 'none',
                background: active ? 'rgba(14,165,233,0.18)' : 'transparent',
                color: active ? '#0ea5e9' : 'var(--text-muted)',
                cursor: 'pointer',
                transition: 'all 0.12s',
                whiteSpace: 'nowrap',
              }}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
