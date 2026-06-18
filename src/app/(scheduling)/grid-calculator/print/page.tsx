// Print-friendly export page for the Grid Calculator.
// Owned by agent A16 (Export) per PRD §14.
//
// PRIMARY EXPORT PATH (chosen per A16's escalation rule):
//
//   1. User navigates to `/grid-calculator/print` (optionally with `?config=…`
//      and `?orient=landscape`).
//   2. The route renders `PrintLayout` against a `PrintSnapshot` built from
//      a `SolvedGrid` + `FTERecommendation`.
//   3. User hits Cmd+P / Ctrl+P → "Save as PDF" (browser native).
//   4. The result is a clean, paper-friendly PDF suitable for hospital admin
//      presentations — no toggle bar, no sidebar, darker borders, page header
//      with the hospital name + date stamp.
//
// SECONDARY (PNG) FALLBACK — DOCUMENTED, NOT BUNDLED:
//   - A `<button>` hint at the top of the page tells the user how to capture
//     a PNG by right-clicking the export root or via Cmd+Shift+4 (macOS) /
//     Win+Shift+S (Windows). The PRD's A16 charter recommends `html-to-image`
//     for a true canvas capture; that install is gated on user demand and
//     would be a one-liner from this page (see notes file). For v1 we keep
//     the install footprint flat.
//
// DEMO MODE:
//   - With no `?config=…` query param, this route renders the Paoli seed
//     verbatim through the same `solve → applyFloatStrategy` pipeline as the
//     live canvas. This satisfies the PRD §14 "renders at /grid-calculator/print
//     with demo data when no config id is provided" requirement.
//   - When a future agent (A11+) wires a persistent config loader, this page
//     will switch on `config` and load the persisted SolvedGrid + recommendation.
//
// Note: Marked `'use client'` so the print button + window.print() interaction
// stays simple. The data assembly is synchronous and deterministic; there is
// no network call. A future server-side path would split the data assembly
// into a Server Component and keep this file as a thin client island.

'use client';

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

import { applyFloatStrategy } from '@/lib/gridCalculator/floatStrategy';
import type { FloatSurplusProvider } from '@/lib/gridCalculator/floatStrategy';
import { buildPrintSnapshot } from '@/lib/gridCalculator/export';
import type {
  HospitalMetadata,
  PrintOrientation,
  PrintProviderLabel,
  PrintSnapshot,
} from '@/lib/gridCalculator/export';
import {
  paoliConfig,
  paoliDistanceEdges,
  paoliRoster,
  paoliRules,
  paoliSites,
} from '@/lib/gridCalculator/seeds/paoli';
import { solve } from '@/lib/gridCalculator/solver';
import { makeSupervisabilityResolver } from '@/lib/gridCalculator/supervisability';
import type { FTERecommendation } from '@/lib/gridCalculator/types';

import PrintLayout from './PrintLayout';

export default function GridCalculatorPrintPage() {
  return (
    <Suspense fallback={<PrintLoading />}>
      <PrintPageInner />
    </Suspense>
  );
}

function PrintPageInner() {
  const searchParams = useSearchParams();

  const orientationParam = searchParams?.get('orient');
  const orientation: PrintOrientation =
    orientationParam === 'landscape' ? 'landscape' : 'portrait';

  // TODO(A11): once a persistent config loader lands, fetch the saved
  // SolvedGrid + recommendation by `config` query param here. For v1 the
  // demo render is the Paoli seed pushed through the universal pipeline.
  const configIdParam = searchParams?.get('config') ?? undefined;
  void configIdParam;

  const snapshot = useMemo(
    () => buildDemoSnapshot(orientation),
    [orientation],
  );

  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#f1f5f9',
        padding: '0 0 60px 0',
      }}
    >
      <PrintToolbar orientation={orientation} />
      <PrintLayout snapshot={snapshot} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toolbar — visible on screen, hidden on print via `.no-print`
// ---------------------------------------------------------------------------

function PrintToolbar({ orientation }: { orientation: PrintOrientation }) {
  // The button only does something when window.print exists; SSR returns
  // a non-functional but styled button so the layout is identical.
  const [canPrint, setCanPrint] = useState(false);
  useEffect(() => setCanPrint(typeof window !== 'undefined' && !!window.print), []);

  return (
    <div
      className="no-print"
      style={{
        background: 'white',
        borderBottom: '1px solid #cbd5e1',
        padding: '14px 24px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        fontFamily: 'system-ui, -apple-system, sans-serif',
        color: '#0f172a',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: -0.2 }}>
          Grid Calculator · Print Preview
        </div>
        <div
          style={{
            fontSize: 11,
            color: '#475569',
            marginTop: 2,
            lineHeight: 1.4,
          }}
        >
          Hit{' '}
          <kbd style={kbdStyle}>{macKey()}P</kbd> to save as PDF · For PNG, use{' '}
          <kbd style={kbdStyle}>{macKey()}⇧4</kbd> (macOS) or{' '}
          <kbd style={kbdStyle}>Win+⇧S</kbd> (Windows) to capture the page below.
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <a
          href={`/grid-calculator/print?orient=${orientation === 'landscape' ? 'portrait' : 'landscape'}`}
          style={{
            padding: '8px 14px',
            borderRadius: 6,
            fontSize: 12,
            fontWeight: 600,
            color: '#1e293b',
            background: '#f1f5f9',
            border: '1px solid #cbd5e1',
            textDecoration: 'none',
          }}
        >
          ↻ {orientation === 'landscape' ? 'Portrait' : 'Landscape'}
        </a>
        <button
          type="button"
          onClick={() => {
            if (typeof window !== 'undefined') window.print();
          }}
          disabled={!canPrint}
          style={{
            padding: '8px 14px',
            borderRadius: 6,
            fontSize: 12,
            fontWeight: 700,
            color: 'white',
            background: '#0ea5e9',
            border: '1px solid #0284c7',
            cursor: 'pointer',
          }}
        >
          ↧ Print / Save as PDF
        </button>
      </div>
    </div>
  );
}

const kbdStyle: React.CSSProperties = {
  background: '#e2e8f0',
  borderRadius: 4,
  padding: '1px 4px',
  fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
  fontSize: 10,
  color: '#1e293b',
  border: '0.5px solid #94a3b8',
};

function macKey(): string {
  // Best-effort: the layout works on both platforms; the kbd hint just shows
  // the recognizable mac symbol on macOS user agents. On the server we render
  // the mac symbol; the printed page never sees this anyway.
  if (typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)) {
    return '⌘';
  }
  return 'Ctrl+';
}

function PrintLoading() {
  return (
    <div
      style={{
        padding: 32,
        color: '#64748b',
        fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
        fontSize: 11,
      }}
    >
      Preparing print preview…
    </div>
  );
}

// ---------------------------------------------------------------------------
// Demo snapshot assembly — Paoli seed via the universal solver pipeline.
// ---------------------------------------------------------------------------

function buildDemoSnapshot(orientation: PrintOrientation): PrintSnapshot {
  // Solve the Paoli grid with the seed's default toggle config. Mirrors what
  // the live canvas does at first render, minus the URL-toggle hook.
  const resolver = makeSupervisabilityResolver(paoliDistanceEdges);
  const grid = solve({
    config: paoliConfig,
    sites: paoliSites,
    rules: paoliRules,
    roster: paoliRoster,
    distanceMatrix: resolver,
  });

  // Identify unused roster providers — they become the float candidates.
  const used = new Set<string>();
  for (const a of grid.assignments) {
    if (a.anesthesiologistId) used.add(a.anesthesiologistId);
    for (const c of a.crnaIds) used.add(c);
  }
  for (const f of grid.floats) used.add(f.providerId);

  const surplus: FloatSurplusProvider[] = paoliRoster
    .filter((r) => !used.has(r.id))
    .map((r) => ({ id: r.id, role: r.role }));

  const gridWithFloats = applyFloatStrategy(grid, {
    mode: paoliConfig.floatStrategy,
    surplus,
    sites: paoliSites,
  });

  const hospital: HospitalMetadata = {
    hospitalName: paoliConfig.hospital,
    configName: paoliConfig.name,
    configId: paoliConfig.id,
  };

  // Build provider labels from the roster ids. The roster file derives ids
  // as `paoli-<prefix>-<slug>` so we can reverse-slug for the display name.
  const providerLabels = buildLabelsFromRoster();

  // Demo recommendation — placeholder numbers anchored to Paoli reality
  // (14 Anesthesiologists, 30 CRNAs per PRD §19 changelog). When A11 wires
  // the persisted FTE run, this page will load the actual numbers instead.
  const recommendation: FTERecommendation = {
    anesthesiologist: { worstCase: 16, p50: 14, p95: 15, binding: 'worst_case' },
    crna: { worstCase: 30, p50: 28, p95: 32, binding: 'monte_carlo' },
    backupCall: {
      fte: 1.5,
      distribution: [],
    },
    rationale:
      'Anesthesiologist headcount binds on the worst-case path (maternity hold-out + simultaneous PTO + post-call vacancies). CRNA headcount binds on the Monte Carlo p95 across 365 simulated days, reflecting per-diem variability and call-out rates. PRD §10.',
  };

  return buildPrintSnapshot({
    hospital,
    sites: paoliSites,
    grid: gridWithFloats,
    recommendation,
    providerLabels,
    config: paoliConfig,
    orientation,
  });
}

function buildLabelsFromRoster(): Record<string, PrintProviderLabel> {
  const out: Record<string, PrintProviderLabel> = {};
  for (const p of paoliRoster) {
    // Provider ids look like `paoli-md-amusa`, `paoli-crna-c-brenneman`,
    // `paoli-crna-pd-l-brice`. Strip the prefix and title-case the rest.
    const segments = p.id.split('-');
    // Drop leading `paoli` + role-prefix segments (`md` / `crna` / `crna-pd`).
    let nameStartIndex = 1;
    if (segments[1] === 'crna' && segments[2] === 'pd') {
      nameStartIndex = 3;
    } else if (segments[1] === 'md' || segments[1] === 'crna') {
      nameStartIndex = 2;
    }
    const rawName = segments.slice(nameStartIndex).join(' ');
    const titled = titleCase(rawName);
    const initials = deriveInitials(titled);
    out[p.id] = { name: titled, initials };
  }
  return out;
}

function titleCase(s: string): string {
  return s
    .split(/\s+/)
    .map((part) => {
      if (!part) return part;
      // Keep "srna" lowercase suffix as upper-case acronym.
      if (part.toLowerCase() === 'srna') return 'SRNA';
      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    })
    .join(' ');
}

function deriveInitials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '??';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  const first = parts[0]?.[0] ?? '';
  const last = parts[parts.length - 1]?.[0] ?? '';
  return `${first}${last}`.toUpperCase();
}
