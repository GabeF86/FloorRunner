'use client';

// Step 5 — Review + first grid + save.
// Owned by agent A15 (Onboarding Wizard).
// PRD: docs/PRD-Grid-Calculator.md §2, §14 (A15), §16 acceptance criterion 1.
//
// Composition:
//   1. Summary card per section (hospital / sites / distances / guidelines).
//   2. "Generate first grid" button — synthesizes a minimal roster from the
//      configured sites, runs the existing solveAndAssess() composer, and
//      renders the inline GridCanvas.
//   3. "Save & finish" button — POSTs the full state to
//      /api/grid-calculator/configs (stubbed at A15; A14 will wire Supabase).
//   4. "Your FTE recommendation will run after you save" placeholder card.

import { useMemo, useState } from 'react';

import GridCanvas from '../GridCanvas';
import {
  solveAndAssess,
  type DemoFixture,
  type GridToggles,
  type SolveResult,
} from '../state';
import type { GridSite } from '@/lib/gridCalculator/types';
import type { RosterProvider } from '@/lib/gridCalculator/solver';

import type { WizardState } from './wizardState';

/**
 * Toggles used for the first-grid sample solve. Matches the URL-default in
 * `state.ts → DEFAULT_TOGGLES`, but inlined here so this component remains
 * independent of `useGridToggles` (the wizard route does not have search
 * params backing it). When A14 wires the persisted flow, the user's saved
 * toggle state will replace these defaults.
 */
const REVIEW_DEFAULT_TOGGLES: GridToggles = {
  coverageStyle: 'balanced',
  supervisionRatio: 'mixed',
  floatStrategy: 'balanced',
  backupPosture: 'conservative',
  showWorstCase: true,
};

const CYAN = '#0ea5e9';
const AMBER = '#f59e0b';
const SLATE = '#64748b';
const EMERALD = '#10b981';

export interface StepReviewProps {
  state: WizardState;
  /** True once the wizard has POSTed to /configs successfully. */
  saved: boolean;
  /** Returned config id from the API. */
  savedConfigId: string | null;
  /** Save action — caller owns it so it can also clear localStorage. */
  onSave: () => Promise<void> | void;
  /** Whether the save is currently in flight. */
  saving: boolean;
  /** Save error message, or null. */
  saveError: string | null;
}

export default function StepReview({
  state,
  saved,
  savedConfigId,
  onSave,
  saving,
  saveError,
}: StepReviewProps) {
  const [generated, setGenerated] = useState<SolveResult | null>(null);
  const [generating, setGenerating] = useState(false);

  // Build a DemoFixture-shaped object from wizard state so we can feed it to
  // `solveAndAssess` and `<GridCanvas fixture=... />` without reinventing the
  // composer. Roster is synthesized — A2's full provider profile flow runs
  // post-onboarding; for the universality smoke test we just need ENOUGH
  // staff to populate every room.
  const reviewFixture: DemoFixture = useMemo(
    () => buildReviewFixture(state),
    [state],
  );

  function handleGenerate() {
    setGenerating(true);
    // synchronous solve; the small async tick + state set lets us show the
    // shimmer transition rather than blocking the main thread feeling rude.
    setTimeout(() => {
      const result = solveAndAssess(reviewFixture, REVIEW_DEFAULT_TOGGLES);
      setGenerated(result);
      setGenerating(false);
    }, 50);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Panel>
        <Header
          title={`Review — ${state.hospital.name || 'unnamed hospital'}`}
          subtitle="Glance through the summary, generate a sample grid, then save your configuration to FloorRunner."
        />

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: 10,
          }}
        >
          <SummaryCard
            label="Hospital"
            ok={state.hospital.name.length > 0}
            primary={state.hospital.name || '—'}
            secondary={state.hospital.contactEmail || 'no contact email'}
            footer={state.hospital.timezone}
          />
          <SummaryCard
            label="Sites"
            ok={state.sites.length > 0}
            primary={`${state.sites.length} site${state.sites.length === 1 ? '' : 's'}`}
            secondary={`${state.sites.reduce((n, s) => n + s.rooms.length, 0)} total rooms`}
            footer={state.sites
              .slice()
              .sort((a, b) => a.position - b.position)
              .map((s) => s.shortName ?? s.name)
              .join(' · ') || '—'}
          />
          <SummaryCard
            label="Distance matrix"
            ok={true}
            primary={`${state.distances.length} declared`}
            secondary={
              state.sites.length < 2
                ? 'single site — n/a'
                : `${pairsCount(state.sites.length)} possible pairs`
            }
            footer="missing pairs default to “near”"
          />
          <SummaryCard
            label="Guidelines"
            ok={
              state.parsedRules.rules !== null &&
              state.parsedRules.error === null
            }
            primary={`${state.parsedRules.rules?.siteRules.length ?? 0} site rules`}
            secondary={`${state.parsedRules.rules?.globalRules.length ?? 0} global rules`}
            footer={
              state.parsedRules.error
                ? 'last parse failed'
                : state.parsedRules.unmapped.length > 0
                ? `${state.parsedRules.unmapped.length} unmapped`
                : 'parse clean'
            }
          />
        </div>
      </Panel>

      {/* Generate first grid ─────────────────────────────────────────────── */}
      <Panel>
        <Header
          title="First grid (sample day)"
          subtitle="We synthesize a minimal roster from your room count and run the solver with default toggles. Use the canvas above to verify your sites and rules make sense."
        />
        {!generated && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
              flexWrap: 'wrap',
              padding: 12,
              background: 'var(--bg-base)',
              borderRadius: 8,
              border: '1px dashed var(--border)',
            }}
          >
            <span style={{ fontSize: 11, color: SLATE, lineHeight: 1.5 }}>
              No grid generated yet. Click below to solve a sample day. We use
              a synthesized roster sized to your rooms; the real roster lands
              from A2 (Provider Profile) post-onboarding.
            </span>
            <button
              type="button"
              onClick={handleGenerate}
              disabled={generating || state.sites.length === 0}
              style={primaryButtonStyle(generating || state.sites.length === 0)}
            >
              {generating ? 'Solving…' : 'Generate first grid'}
            </button>
          </div>
        )}
        {generated && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <div
              style={{
                display: 'flex',
                gap: 10,
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
              }}
            >
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <Pill label="Rooms staffed" value={`${generated.grid.assignments.length}`} color={CYAN} />
                <Pill
                  label="Floats positioned"
                  value={`${generated.grid.floats.length}`}
                  color={AMBER}
                />
                <Pill
                  label="Solver violations"
                  value={`${generated.grid.violations.length}`}
                  color={
                    generated.grid.violations.length === 0 ? EMERALD : '#ef4444'
                  }
                />
              </div>
              <button
                type="button"
                onClick={handleGenerate}
                disabled={generating}
                style={ghostButtonStyle()}
              >
                {generating ? 'Solving…' : 'Re-solve'}
              </button>
            </div>
            <div
              style={{
                border: '1px solid var(--border)',
                borderRadius: 10,
                overflow: 'hidden',
                background: 'var(--bg-base)',
              }}
            >
              <GridCanvas fixture={reviewFixture} />
            </div>
          </div>
        )}
      </Panel>

      {/* FTE recommendation placeholder ─────────────────────────────────── */}
      <Panel>
        <Header
          title="FTE recommendation"
          subtitle="Your headcount recommendation runs after you save. A7 (FTE Simulator) executes worst-case + Monte Carlo passes; results land on the grid view."
        />
        <div
          style={{
            background: 'rgba(14,165,233,0.06)',
            border: '1px solid rgba(14,165,233,0.25)',
            borderRadius: 8,
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: CYAN,
              textTransform: 'uppercase',
              letterSpacing: 0.5,
              fontFamily: 'var(--font-mono), ui-monospace, monospace',
            }}
          >
            Queued after save
          </span>
          <span style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.6 }}>
            Save your configuration and the simulator will produce both a
            worst-case deterministic recommendation and a Monte Carlo p95 for
            Anesthesiologist, CRNA, and backup-call FTE.
          </span>
        </div>
      </Panel>

      {/* Save & finish ─────────────────────────────────────────────────── */}
      <Panel>
        <Header
          title="Save & finish"
          subtitle="Persist this hospital configuration. A14 will wire the real Supabase write; for now we stub it server-side and clear your localStorage on success."
        />
        {saved ? (
          <div
            role="status"
            style={{
              background: 'rgba(16,185,129,0.08)',
              border: '1px solid rgba(16,185,129,0.3)',
              borderRadius: 8,
              padding: 12,
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            <div
              style={{
                fontSize: 10,
                fontWeight: 700,
                color: EMERALD,
                textTransform: 'uppercase',
                letterSpacing: 0.5,
                fontFamily: 'var(--font-mono), ui-monospace, monospace',
              }}
            >
              Saved ✓
            </div>
            <span style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.6 }}>
              Stub config id:{' '}
              <code
                style={{
                  fontFamily: 'var(--font-mono), ui-monospace, monospace',
                  fontSize: 11,
                  background: 'var(--bg-base)',
                  padding: '1px 6px',
                  borderRadius: 4,
                  border: '1px solid var(--border)',
                }}
              >
                {savedConfigId ?? 'unknown'}
              </code>
              . You can close this tab or jump to{' '}
              <a
                href="/grid-calculator"
                style={{
                  color: CYAN,
                  textDecoration: 'underline',
                  textUnderlineOffset: 2,
                }}
              >
                /grid-calculator
              </a>{' '}
              to see the canvas with the demo fixture (A14 will swap in your
              saved fixture once Supabase persistence is wired).
            </span>
          </div>
        ) : (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
              flexWrap: 'wrap',
            }}
          >
            <ChecklistSummary state={state} />
            <button
              type="button"
              onClick={() => void onSave()}
              disabled={saving || !isReadyToSave(state)}
              style={primaryButtonStyle(saving || !isReadyToSave(state))}
            >
              {saving ? 'Saving…' : 'Save & finish'}
            </button>
          </div>
        )}
        {saveError && (
          <div
            role="alert"
            style={{
              background: 'rgba(239,68,68,0.06)',
              border: '1px solid rgba(239,68,68,0.3)',
              borderRadius: 8,
              padding: 10,
              fontSize: 11,
              color: '#dc2626',
              lineHeight: 1.5,
            }}
          >
            {saveError}
          </div>
        )}
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Synthesized roster — sized to room count so the solver has enough people to
// staff every room. Pure function so unit tests can drive it.
// ---------------------------------------------------------------------------

const ANES_NAMES = [
  'Dr. Avery Chen', 'Dr. Morgan Reyes', 'Dr. Quinn Park',
  'Dr. Casey Singh', 'Dr. Jordan Patel', 'Dr. Riley Lee',
  'Dr. Sam Garcia', 'Dr. Drew Kim', 'Dr. Robin Wong',
  'Dr. Hayden Cole', 'Dr. Skyler Vance', 'Dr. Reese Tran',
];

const CRNA_NAMES = [
  'Riley Singh, CRNA', 'Jordan Park, CRNA', 'Casey Nguyen, CRNA',
  'Sam Patel, CRNA', 'Avery Brooks, CRNA', 'Morgan Day, CRNA',
  'Drew Bell, CRNA', 'Quinn Olsen, CRNA', 'Casey Reid, CRNA',
  'Hayden Cruz, CRNA', 'Skyler Ross, CRNA', 'Reese Diaz, CRNA',
  'Cameron Lake, CRNA', 'Eli Marsh, CRNA', 'Sloan Adair, CRNA',
];

export function buildReviewFixture(state: WizardState): DemoFixture {
  // Conservative synthesis: 1 MD per ~2 rooms (round up), 1 CRNA per room +
  // 2 floats. Keeps the canvas readable without burying the solver in surplus.
  const totalRooms = state.sites.reduce((acc, s) => acc + s.rooms.length, 0);
  const mdTarget = Math.max(2, Math.ceil(totalRooms * 0.6) + 1);
  const crnaTarget = Math.max(3, totalRooms + 2);

  const roster: RosterProvider[] = [];
  const providerLabels: Record<string, { name: string; initials: string }> = {};

  const homeOptions = state.sites.length > 0 ? state.sites : [];

  for (let i = 0; i < mdTarget; i++) {
    const id = `synth-md-${pad(i)}`;
    const home = homeOptions[i % Math.max(1, homeOptions.length)]?.id;
    roster.push({ id, role: 'anesthesiologist', fte: 1.0, homeSiteId: home });
    const name = ANES_NAMES[i % ANES_NAMES.length];
    providerLabels[id] = {
      name,
      initials: initialsOf(name),
    };
  }
  for (let i = 0; i < crnaTarget; i++) {
    const id = `synth-crna-${pad(i)}`;
    const home = homeOptions[i % Math.max(1, homeOptions.length)]?.id;
    roster.push({ id, role: 'crna', fte: 1.0, homeSiteId: home });
    const name = CRNA_NAMES[i % CRNA_NAMES.length];
    providerLabels[id] = {
      name,
      initials: initialsOf(name),
    };
  }

  return {
    configId: `wizard-${state.hospital.name || 'unnamed'}`,
    sites: assignContiguousPositions(state.sites),
    edges: state.distances,
    roster,
    rules: state.parsedRules.rules ?? { siteRules: [], globalRules: [] },
    providerLabels,
  };
}

function assignContiguousPositions(sites: GridSite[]): GridSite[] {
  return sites
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((s, idx) => ({ ...s, position: idx }));
}

function initialsOf(name: string): string {
  const parts = name
    .replace(/, ?CRNA$/i, '')
    .replace(/^Dr\. ?/, '')
    .split(/\s+/);
  return parts
    .slice(0, 2)
    .map((p) => p[0] ?? '')
    .join('')
    .toUpperCase();
}

function pad(n: number): string {
  return String(n).padStart(3, '0');
}

function pairsCount(n: number): number {
  return (n * (n - 1)) / 2;
}

function isReadyToSave(state: WizardState): boolean {
  return (
    state.hospital.name.trim().length > 0 &&
    state.sites.length > 0 &&
    state.sites.every((s) => s.rooms.length > 0)
  );
}

// ---------------------------------------------------------------------------
// UI bits.
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
          fontSize: 14,
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

function SummaryCard({
  label,
  ok,
  primary,
  secondary,
  footer,
}: {
  label: string;
  ok: boolean;
  primary: string;
  secondary: string;
  footer: string;
}) {
  return (
    <div
      style={{
        background: 'var(--bg-base)',
        border: '1px solid var(--border)',
        borderLeft: `3px solid ${ok ? EMERALD : '#ef4444'}`,
        borderRadius: 8,
        padding: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}
    >
      <span
        style={{
          fontSize: 10,
          fontWeight: 700,
          color: ok ? EMERALD : '#ef4444',
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          fontFamily: 'var(--font-mono), ui-monospace, monospace',
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: 14,
          fontWeight: 700,
          color: 'var(--text-strong)',
        }}
      >
        {primary}
      </span>
      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{secondary}</span>
      <span
        style={{
          fontSize: 9,
          color: SLATE,
          fontFamily: 'var(--font-mono), ui-monospace, monospace',
          marginTop: 4,
          textTransform: 'uppercase',
          letterSpacing: 0.4,
        }}
      >
        {footer}
      </span>
    </div>
  );
}

function Pill({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 8px',
        borderRadius: 5,
        background: `${color}1A`,
        border: `1px solid ${color}55`,
        color,
        fontSize: 11,
        fontWeight: 700,
      }}
    >
      <span
        style={{
          fontSize: 9,
          fontFamily: 'var(--font-mono), ui-monospace, monospace',
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          opacity: 0.8,
        }}
      >
        {label}
      </span>
      <span>{value}</span>
    </span>
  );
}

function ChecklistSummary({ state }: { state: WizardState }) {
  const checks = [
    {
      ok: state.hospital.name.trim().length > 0,
      label: 'Hospital name',
    },
    {
      ok: state.sites.length > 0 && state.sites.every((s) => s.rooms.length > 0),
      label: 'At least one site with rooms',
    },
    {
      ok: true,
      label: 'Distance matrix (optional)',
    },
    {
      ok: state.parsedRules.rules !== null && state.parsedRules.error === null,
      label: 'Guidelines parsed',
    },
  ];
  return (
    <ul
      style={{
        margin: 0,
        padding: 0,
        listStyle: 'none',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        fontSize: 11,
        color: 'var(--text)',
      }}
    >
      {checks.map((c, i) => (
        <li
          key={i}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            color: c.ok ? EMERALD : SLATE,
          }}
        >
          <span
            aria-hidden
            style={{
              fontFamily: 'var(--font-mono), ui-monospace, monospace',
              fontWeight: 700,
            }}
          >
            {c.ok ? '✓' : '○'}
          </span>
          <span style={{ color: 'var(--text)' }}>{c.label}</span>
        </li>
      ))}
    </ul>
  );
}

function primaryButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    height: 36,
    padding: '0 16px',
    fontSize: 12,
    fontWeight: 700,
    borderRadius: 8,
    background: disabled ? '#cbd5e1' : CYAN,
    color: 'white',
    border: `1px solid ${disabled ? '#cbd5e1' : CYAN}`,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.6 : 1,
    fontFamily: 'inherit',
    boxShadow: disabled ? undefined : '0 1px 2px rgba(14,165,233,0.3)',
  };
}

function ghostButtonStyle(): React.CSSProperties {
  return {
    height: 28,
    padding: '0 10px',
    fontSize: 11,
    fontWeight: 700,
    borderRadius: 6,
    background: 'transparent',
    color: SLATE,
    border: '1px solid var(--border)',
    cursor: 'pointer',
    fontFamily: 'inherit',
  };
}

// Re-export helper so the page route can also bring up the synthesized fixture
// for analytics / debugging if it wants. Pure function — no React imports.
export { buildReviewFixture as __buildReviewFixture };
