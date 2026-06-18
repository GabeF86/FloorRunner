'use client';

// Grid Calculator Onboarding Wizard — entry route.
// Owned by agent A15 (Onboarding Wizard).
// PRD: docs/PRD-Grid-Calculator.md §2 (universality, 30-min onboarding),
//      §14 (A15 charter), §16 acceptance criterion 1.
//
// Why client-only: the wizard is interactive end-to-end, persists to
// localStorage, and POSTs to two API routes. There is no SSR benefit and
// `useReducer` + `useEffect` for hydration only run on the client anyway.

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import StepDistances from './StepDistances';
import StepGuidelines from './StepGuidelines';
import StepHospital from './StepHospital';
import StepReview from './StepReview';
import StepSites from './StepSites';
import WizardShell from './WizardShell';
import {
  STEP_TITLES,
  isStepComplete,
  useWizard,
  type WizardStepIndex,
} from './wizardState';

export default function OnboardingPage() {
  const router = useRouter();
  const { state, dispatch, resetWizard } = useWizard();

  // Save state — local to the page since it crosses step boundaries
  // (the Review step initiates it but we want to render success even after
  // the user navigates back to inspect a previous step).
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [savedConfigId, setSavedConfigId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function handleSave() {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch('/api/grid-calculator/configs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hospital: state.hospital,
          sites: state.sites,
          distances: state.distances,
          guidelines: state.guidelines,
          parsedRules: state.parsedRules.rules,
        }),
      });
      if (!res.ok) {
        const body = await safeJson(res);
        const msg =
          typeof body?.error === 'string'
            ? body.error
            : `Save failed (HTTP ${res.status}).`;
        setSaveError(msg);
        return;
      }
      const body = (await res.json()) as { configId?: string };
      setSaved(true);
      setSavedConfigId(typeof body.configId === 'string' ? body.configId : null);
      // Clear localStorage on success so the next "fresh" onboarding starts
      // empty. The user can still scroll the review page; the in-memory state
      // is preserved until they navigate away.
      if (typeof window !== 'undefined') {
        try {
          window.localStorage.removeItem('gridCalcOnboarding:v1');
        } catch {
          // ignore
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown save error.';
      setSaveError(msg);
    } finally {
      setSaving(false);
    }
  }

  function handleReset() {
    if (
      typeof window !== 'undefined' &&
      !window.confirm(
        'Wipe everything and start over? Your current progress will be lost.',
      )
    ) {
      return;
    }
    resetWizard();
    setSaved(false);
    setSavedConfigId(null);
    setSaveError(null);
  }

  // Step navigation — dispatch directly so the reducer enforces clamping.
  const goToStep = (step: WizardStepIndex) => dispatch({ type: 'goToStep', step });
  const goNext = () => dispatch({ type: 'next' });
  const goBack = () => dispatch({ type: 'back' });

  // Per-step canAdvance + body wiring.
  const step = state.step;
  const isLastStep = step === STEP_TITLES.length - 1;

  let body: React.ReactNode = null;
  let canAdvance = false;
  let advanceLabel: string | undefined;
  let subtitle: string | undefined;

  switch (step) {
    case 0:
      body = <StepHospital hospital={state.hospital} dispatch={dispatch} />;
      canAdvance = isStepComplete(state, 0);
      subtitle = 'Step 1 of 5 — name the hospital, set the timezone, give us a contact.';
      break;
    case 1:
      body = <StepSites sites={state.sites} dispatch={dispatch} />;
      canAdvance = isStepComplete(state, 1);
      subtitle = 'Step 2 of 5 — add the anesthetizing sites and rooms.';
      break;
    case 2:
      body = (
        <StepDistances
          sites={state.sites}
          distances={state.distances}
          dispatch={dispatch}
        />
      );
      canAdvance = isStepComplete(state, 2);
      subtitle =
        'Step 3 of 5 — set distance bands between sites (skipped for single-site hospitals).';
      break;
    case 3:
      body = (
        <StepGuidelines
          guidelines={state.guidelines}
          parsedRules={state.parsedRules}
          unmappedAcknowledged={state.unmappedAcknowledged}
          sites={state.sites}
          dispatch={dispatch}
        />
      );
      canAdvance = isStepComplete(state, 3);
      subtitle =
        'Step 4 of 5 — paste your free-text staffing guidelines and let Claude normalize them.';
      break;
    case 4:
      body = (
        <StepReview
          state={state}
          saved={saved}
          savedConfigId={savedConfigId}
          onSave={handleSave}
          saving={saving}
          saveError={saveError}
        />
      );
      // The review step does not "advance" — the save button lives inside it.
      // When saved, we expose a final CTA to jump to the main canvas.
      canAdvance = saved;
      advanceLabel = saved ? 'Go to grid calculator' : 'Save first';
      subtitle =
        'Step 5 of 5 — review your entries, generate a sample grid, then save.';
      break;
    default:
      body = null;
  }

  function handleAdvance() {
    if (isLastStep && saved) {
      router.push('/grid-calculator');
      return;
    }
    goNext();
  }

  return (
    <WizardShell
      state={state}
      title={`Onboarding · ${STEP_TITLES[step]?.label ?? '—'}`}
      subtitle={subtitle}
      canAdvance={canAdvance}
      advanceLabel={advanceLabel}
      canGoBack={step > 0}
      onAdvance={handleAdvance}
      onBack={goBack}
      onJumpToStep={goToStep}
      onReset={handleReset}
    >
      {body}
    </WizardShell>
  );
}

async function safeJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}
