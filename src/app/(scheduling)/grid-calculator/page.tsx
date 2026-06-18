'use client';

// Anesthesia Coverage Grid Calculator — entry route.
// Owned by agent A9 (Grid Canvas) and A1 (Site Architect, sidebar).
// PRD: docs/PRD-Grid-Calculator.md
//
// Layout:
//   The full page chrome lives inside <GridCanvas> — breadcrumb + header card +
//   the staffing-calculator's two-column (312px config rail + flex output)
//   layout. The page wrapper is intentionally thin so it composes cleanly with
//   the demo fixture today and the persisted seed (A11) tomorrow.
//
// NOTE: the live A1 sidebar (site/room/distance editor) is intentionally
// not rendered here. The Grid Calculator answers "how many do we need to
// hire" — site catalog editing belongs in the onboarding wizard (A15) and
// the dedicated site-config tools, not on the headcount-planning page.

import { Suspense } from 'react';

import GridCanvas from './GridCanvas';

export default function GridCalculatorPage() {
  return (
    <div
      style={{ background: 'var(--bg-base)', color: 'var(--text)', minHeight: '100vh' }}
    >
      <Suspense fallback={<CanvasFallback />}>
        <GridCanvas />
      </Suspense>
    </div>
  );
}

function CanvasFallback() {
  return (
    <div
      style={{
        padding: 24,
        color: 'var(--text-muted)',
        fontFamily: 'var(--font-mono), ui-monospace, monospace',
        fontSize: 11,
      }}
    >
      Loading grid…
    </div>
  );
}
