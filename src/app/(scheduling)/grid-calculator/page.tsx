'use client';

// Anesthesia Coverage Grid Calculator — entry route.
// Owned by agent A9 (Grid Canvas) and A1 (Site Architect, sidebar).
// PRD: docs/PRD-Grid-Calculator.md
//
// Layout:
//   - Left rail (A1): Sidebar with sites / rooms / distance matrix editor.
//   - Center + Right: <GridCanvas> (A9) — the lanes, toggle bar, FTE panel.
//
// Note: this file deliberately keeps the layout shell minimal. All canvas
// composition lives in GridCanvas.tsx (sticky toggle bar, lanes, FTE rail).
// The default fixture is the in-memory Paoli-like demo defined in `state.ts`;
// A11 (Paoli Seed) replaces it with the persistent seed once the migration
// runs and the loader hook lands.
//
// Marked `'use client'` so the Sidebar (a Client Component) can receive event
// handlers from this entry point. Once A11 introduces a persistent data
// loader, we can split this back into a Server Component shell + a thin
// client island for the interactive controls.

import { Suspense } from 'react';

import type { DistanceBand } from '@/lib/gridCalculator/types';

import Sidebar from './Sidebar';
import GridCanvas from './GridCanvas';
import { DEMO_PAOLI_FIXTURE } from './state';

export default function GridCalculatorPage() {
  return (
    <div
      className="flex h-full min-h-screen flex-col"
      style={{ background: 'var(--bg-base)', color: 'var(--text)' }}
    >
      <header
        style={{
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-surface)',
          padding: '14px 24px',
        }}
      >
        <h1
          style={{
            fontSize: 16,
            fontWeight: 700,
            color: 'var(--text-strong)',
            letterSpacing: -0.2,
          }}
        >
          Anesthesia Coverage Grid Calculator
        </h1>
        <p
          style={{
            fontSize: 11,
            color: 'var(--text-muted)',
            marginTop: 2,
            fontFamily: 'var(--font-mono), ui-monospace, monospace',
          }}
        >
          Demo fixture rendering — A11 (Paoli Seed) will swap in persistent data.
          See <code>docs/PRD-Grid-Calculator.md</code> §7, §14.
        </p>
      </header>
      <main className="flex flex-1 flex-row" style={{ minHeight: 0 }}>
        <div
          className="w-72"
          style={{
            borderRight: '1px solid var(--border)',
            background: 'var(--bg-sidebar)',
            flexShrink: 0,
          }}
        >
          {/* The sidebar (A1) is fully owned by A1 and consumed here as-is.
              v1 wiring: we pass the demo fixture's sites + edges but stub all
              mutation handlers — A1's onAdd/onChange handlers are wired into
              the persistent flow by A11 later. */}
          <Sidebar
            sites={DEMO_PAOLI_FIXTURE.sites}
            distanceEdges={DEMO_PAOLI_FIXTURE.edges}
            onAddSite={() => {
              // TODO(A11): wire site creation into the persistent config.
            }}
            onAddRoom={(siteId: string) => {
              // TODO(A11): wire room creation into the persistent config.
              void siteId;
            }}
            onChangeBand={(
              siteAId: string,
              siteBId: string,
              band: DistanceBand,
            ) => {
              // TODO(A11): wire band updates into the persistent matrix.
              void siteAId;
              void siteBId;
              void band;
            }}
            onToggleSupervisable={(
              siteAId: string,
              siteBId: string,
              next: boolean,
            ) => {
              // TODO(A11): wire supervisability override into the persistent matrix.
              void siteAId;
              void siteBId;
              void next;
            }}
          />
        </div>
        <section style={{ flex: 1, minWidth: 0, overflowY: 'auto' }}>
          {/* GridCanvas reads URL toggles; wrap in <Suspense> per Next 14
              guidance for useSearchParams in client components. */}
          <Suspense fallback={<CanvasFallback />}>
            <GridCanvas />
          </Suspense>
        </section>
      </main>
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
