'use client';

// Wizard Shell — the chrome around every step.
// Owned by agent A15 (Onboarding Wizard).
// PRD: docs/PRD-Grid-Calculator.md §2, §14 (A15), §16 acceptance criterion 1.
//
// Composition:
//   - Top progress trail: a row of 6 dots, one per step. Current step is
//     highlighted in cyan, completed steps show a check, future steps are
//     dimmed. Trail labels live below the dots in a compact mono caption.
//   - Body: whatever the active step renders, passed as `children`.
//   - Bottom action bar: Back / Next / Save & finish (replaces Next on the
//     final review step). Both buttons live bottom-right per A15 charter.
//
// Aesthetic: inherits the locked Variant C "Hybrid" baseline. We import
// `LAYOUT_DIMENSIONS` so any baseline drift cascades automatically. The trail
// uses cyan accent (matches the FloorRunner sidebar) and amber when the user
// is editing an already-completed step (mid-flow back-edit).

import type { ReactNode } from 'react';

import { LAYOUT_DIMENSIONS } from '../state';
import {
  STEP_TITLES,
  type WizardState,
  type WizardStepIndex,
  isStepComplete,
} from './wizardState';

// The trail accent is the brand blue (was the literal #0ea5e9 — the DARK-mode
// value of that token, painted on the light default). AMBER stays literal: it
// marks a completed-but-revisited step, it is a mid-tone that reads on both a
// white and a near-black surface, and --warn's light value is a much browner
// amber-700 that would visibly re-colour the trail.
const ACCENT = 'var(--blue)';
const AMBER = '#f59e0b';

export interface WizardShellProps {
  state: WizardState;
  /** Body of the current step. */
  children: ReactNode;
  /** Header subtitle — single line under the H1. Step-specific. */
  subtitle?: string;
  /** Step-specific main title. Falls back to the trail label. */
  title?: string;
  /** Whether the "next" button is enabled. Steps own their own validation. */
  canAdvance: boolean;
  /** Label override for the primary forward button. */
  advanceLabel?: string;
  /** Loading flag — disables forward button and shows a spinner. */
  advancing?: boolean;
  /** Whether the back button should be shown (step 0 hides it). */
  canGoBack: boolean;
  /** Dispatchers — passed through from the parent route. */
  onAdvance: () => void;
  onBack: () => void;
  /** Optional jump-to-step callback (clicks on the dot trail). */
  onJumpToStep?: (step: WizardStepIndex) => void;
  /** "Start over" affordance — clears everything (top-right link). */
  onReset?: () => void;
}

export default function WizardShell({
  state,
  children,
  subtitle,
  title,
  canAdvance,
  advanceLabel = 'Next',
  advancing = false,
  canGoBack,
  onAdvance,
  onBack,
  onJumpToStep,
  onReset,
}: WizardShellProps) {
  const stepLabel = STEP_TITLES.find((s) => s.index === state.step)?.label;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: '100vh',
        background: 'var(--bg-base)',
        color: 'var(--text)',
      }}
    >
      {/* ── Header ───────────────────────────────────────────────────────── */}
      <header
        style={{
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-surface)',
          padding: '14px 24px',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <div>
            <h1
              style={{
                fontSize: 16,
                fontWeight: 700,
                color: 'var(--text-strong)',
                letterSpacing: -0.2,
              }}
            >
              {title ?? `Grid Calculator · ${stepLabel ?? 'Onboarding'}`}
            </h1>
            <p
              style={{
                fontSize: 11,
                color: 'var(--text-muted)',
                marginTop: 2,
                fontFamily: 'var(--font-mono), ui-monospace, monospace',
              }}
            >
              {subtitle ??
                'Onboard a new hospital — site/room entry → distances → guidelines → first grid.'}
            </p>
          </div>
          {onReset && (
            <button
              type="button"
              onClick={onReset}
              style={{
                fontSize: 10,
                color: 'var(--text-muted)',
                background: 'transparent',
                border: '1px solid var(--border)',
                borderRadius: 6,
                padding: '4px 8px',
                cursor: 'pointer',
                fontFamily: 'var(--font-mono), ui-monospace, monospace',
                letterSpacing: 0.4,
                textTransform: 'uppercase',
                fontWeight: 700,
              }}
              title="Wipe localStorage and start over"
            >
              Start over
            </button>
          )}
        </div>
      </header>

      {/* ── Progress trail ───────────────────────────────────────────────── */}
      <ProgressTrail
        state={state}
        onJumpToStep={onJumpToStep}
      />

      {/* ── Step body ────────────────────────────────────────────────────── */}
      <main
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          padding: '20px 24px 96px',
        }}
      >
        <div
          style={{
            maxWidth: 960,
            margin: '0 auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
          }}
        >
          {children}
        </div>
      </main>

      {/* ── Bottom action bar (fixed) ────────────────────────────────────── */}
      <footer
        style={{
          position: 'sticky',
          bottom: 0,
          background: 'var(--bg-surface)',
          borderTop: '1px solid var(--border)',
          padding: '12px 24px',
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 8,
          // Tiny shadow so the bar reads as a floating action band. Kept as a
          // literal black wash on purpose: shadows are black in BOTH themes
          // here (see the --shadow-* dark values), and the ramp has no
          // upward-cast step to borrow.
          boxShadow: '0 -2px 8px rgba(0,0,0,0.04)',
        }}
      >
        {canGoBack && (
          <button
            type="button"
            onClick={onBack}
            disabled={advancing}
            style={buttonStyle('ghost', advancing)}
          >
            ← Back
          </button>
        )}
        <button
          type="button"
          onClick={onAdvance}
          disabled={!canAdvance || advancing}
          style={buttonStyle('primary', !canAdvance || advancing)}
        >
          {advancing ? 'Working…' : advanceLabel + ' →'}
        </button>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Progress trail — 6 dots with a horizontal connector.
// ---------------------------------------------------------------------------

function ProgressTrail({
  state,
  onJumpToStep,
}: {
  state: WizardState;
  onJumpToStep?: (step: WizardStepIndex) => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        padding: '14px 24px',
        background: 'var(--bg-surface)',
        borderBottom: '1px solid var(--border)',
        gap: 0,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 0,
          flexWrap: 'wrap',
          justifyContent: 'center',
        }}
      >
        {STEP_TITLES.map((stepDef, i) => {
          const isCurrent = stepDef.index === state.step;
          const isCompleted = isStepComplete(state, stepDef.index);
          const isPast = stepDef.index < state.step;
          const jumpable =
            onJumpToStep && (isPast || isCompleted) ? () => onJumpToStep(stepDef.index) : undefined;

          return (
            <div
              key={stepDef.index}
              style={{ display: 'flex', alignItems: 'center' }}
            >
              <button
                type="button"
                onClick={jumpable}
                disabled={!jumpable}
                aria-current={isCurrent ? 'step' : undefined}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  background: 'transparent',
                  border: 'none',
                  padding: '0 6px',
                  cursor: jumpable ? 'pointer' : 'default',
                  gap: 4,
                }}
              >
                <Dot
                  current={isCurrent}
                  completed={isCompleted && !isCurrent}
                  past={isPast && !isCompleted}
                />
                <span
                  style={{
                    fontSize: 10,
                    // A step still ahead of the user is deliberately dimmed —
                    // --text-dim is that role, and its light value is the
                    // #64748b this used to hardcode.
                    color: isCurrent ? ACCENT : isCompleted ? AMBER : 'var(--text-dim)',
                    fontWeight: isCurrent ? 700 : 500,
                    fontFamily: 'var(--font-mono), ui-monospace, monospace',
                    textTransform: 'uppercase',
                    letterSpacing: 0.5,
                  }}
                >
                  {stepDef.label}
                </span>
              </button>
              {i < STEP_TITLES.length - 1 && (
                <div
                  aria-hidden
                  style={{
                    width: 38,
                    height: 1,
                    background: 'var(--border)',
                    margin: '0 4px 16px',
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Dot({
  current,
  completed,
  past,
}: {
  current: boolean;
  completed: boolean;
  past: boolean;
}) {
  // An inert dot is a filled hairline, not a colour: --border is the hairline
  // (its light value is the #cbd5e1 this used to hardcode) and the faintest
  // surface tint stands in for the old slate-200 "not reached yet" fill.
  const bg = current ? ACCENT : completed ? AMBER : past ? 'var(--border)' : 'var(--tint-surface-strong)';
  const ring = current ? ACCENT : completed ? AMBER : null;
  return (
    <span
      style={{
        width: 18,
        height: 18,
        borderRadius: '50%',
        background: bg,
        // `${ring}22` concatenated hex alpha — which stops being a colour the
        // moment `ring` is a var(). 0x22/0xff ≈ 13%.
        boxShadow: ring ? `0 0 0 3px color-mix(in srgb, ${ring} 13%, transparent)` : undefined,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--on-accent)',
        fontSize: 10,
        fontWeight: 800,
      }}
    >
      {completed && !current ? '✓' : ''}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Button styles — kept inline to avoid a global stylesheet dependency.
// ---------------------------------------------------------------------------

function buttonStyle(variant: 'primary' | 'ghost', disabled: boolean) {
  const base = {
    minHeight: 36,
    minWidth: 92,
    fontSize: 12,
    fontWeight: 700,
    borderRadius: 8,
    padding: '6px 16px',
    border: '1px solid transparent',
    cursor: disabled ? 'not-allowed' : 'pointer',
    transition: 'all var(--dur-fast) var(--ease-out)',
    fontFamily: 'inherit',
    opacity: disabled ? 0.55 : 1,
  } as const;
  if (variant === 'primary') {
    return {
      ...base,
      background: ACCENT,
      color: 'var(--on-accent)',
      borderColor: ACCENT,
      boxShadow: '0 1px 2px color-mix(in srgb, var(--blue) 30%, transparent)',
    };
  }
  return {
    ...base,
    background: 'transparent',
    color: 'var(--text-muted)',
    borderColor: 'var(--border)',
  };
}

// ---------------------------------------------------------------------------
// Re-export the locked layout dims so steps can read them without
// double-importing from `../state`. Keeps the wizard's import graph tight.
// ---------------------------------------------------------------------------

export const WIZARD_LAYOUT = LAYOUT_DIMENSIONS;
