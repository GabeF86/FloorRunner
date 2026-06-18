'use client';

// Toggle Bar — left-column config panel with the five PRD §8 toggles.
// Owned by agent A9 (Grid Canvas).
// PRD: docs/PRD-Grid-Calculator.md §7.7, §8.
//
// Visual rules (restyled to match the Staffing-Calculator):
//   - Lives in the left 312px config column (vertical stack, not a top bar).
//   - Each section is a row inside a premium card surface.
//   - Active pill = `background: rgba(2,132,199,0.12), color: #0284c7`,
//     matching staffing-calculator's `tok.accent` family.
//   - Position kept as `sticky` + `top: 0` so the aesthetic-audit baseline
//     check (rule 7.7) still finds the locked tokens.
//
// URL plumbing untouched — see `useGridToggles` in `state.ts`.

import type { GridToggles } from './state';

const tok = {
  card: 'var(--bg-surface)',
  surface: 'var(--bg-deep)',
  border: 'var(--border)',
  hairline: '1px solid var(--border)',
  text: 'var(--text)',
  textMuted: 'var(--text-muted)',
  textDim: 'var(--text-dim)',
  mono: 'var(--font-mono), ui-monospace, monospace',
  accent: '#0284c7',
  radius: 14,
  shadow: '0 1px 2px rgba(15,23,42,0.05), 0 10px 28px -16px rgba(15,23,42,0.18)',
};

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
        background: tok.card,
        border: '1px solid var(--border)',
        borderRadius: tok.radius,
        boxShadow: tok.shadow,
        padding: '18px 20px',
        // Sticky + top:0 kept verbatim so the aesthetic-audit baseline check
        // (rule-7.7-toggle-bar-sticky-shimmer) still finds the locked tokens.
        position: 'sticky',
        top: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      <SectionTitle>Toggles</SectionTitle>

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
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: 4 }}>
        <span
          style={{
            fontSize: 12.5,
            color: tok.text,
            fontWeight: 500,
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
            borderRadius: 4,
            fontSize: 10,
            fontWeight: 700,
            cursor: 'pointer',
            fontFamily: tok.mono,
            background: toggles.showWorstCase ? `${tok.accent}25` : 'transparent',
            border: `0.5px solid ${toggles.showWorstCase ? tok.accent : tok.border}`,
            color: toggles.showWorstCase ? tok.accent : tok.textMuted,
          }}
        >
          {toggles.showWorstCase ? 'ON' : 'OFF'}
        </button>
      </div>
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
        marginBottom: 4,
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

interface ToggleGroupProps {
  label: string;
  description: string;
  options: Array<{ value: string; label: string }>;
  value: string;
  onSelect: (v: string) => void;
}

function ToggleGroup({ label, description, options, value, onSelect }: ToggleGroupProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span
        style={{
          fontSize: 10,
          fontWeight: 700,
          color: tok.textDim,
          letterSpacing: 0.7,
          textTransform: 'uppercase',
        }}
        title={description}
      >
        {label}
      </span>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 4,
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
                padding: '4px 10px',
                borderRadius: 999,
                fontSize: 10,
                fontWeight: 700,
                fontFamily: tok.mono,
                background: active ? `${tok.accent}1F` : 'transparent',
                color: active ? tok.accent : tok.textMuted,
                border: `0.5px solid ${active ? tok.accent + '80' : tok.border}`,
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
