'use client';

// Grid Calculator client-side state hooks.
// Owned by agent A9 (Grid Canvas).
// PRD: docs/PRD-Grid-Calculator.md §8, §14 (A9).
//
// What lives here:
//   - `useGridToggles` — reads/writes the 5 toggles per PRD §8 from the URL
//     query string via `useSearchParams`. All toggle state is shareable.
//   - `DEMO_PAOLI_FIXTURE` — a small in-memory Paoli-like fixture (2 sites,
//     4 rooms, 4 providers) so the page renders something on first load.
//     A11 (Paoli Seed) will REPLACE this with the real persistent seed.
//   - `solveAndAssess` — composes solver + applyFloatStrategy + assessFloatHealth
//     into a single deterministic result the canvas can render. Pure function;
//     the canvas calls it synchronously on every toggle change.
//
// Aesthetic-checkpoint note: every toggle change pushes a new URL with
// `router.replace()` (no scroll), and the canvas listens to `useSearchParams()`
// so a 200ms shimmer animation can be triggered via a key-bump in the consumer.

import { useCallback, useMemo } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';

import { solve } from '@/lib/gridCalculator/solver';
import type {
  SolvedGrid,
  RosterProvider,
} from '@/lib/gridCalculator/solver';
import {
  applyFloatStrategy,
  assessFloatHealth,
} from '@/lib/gridCalculator/floatStrategy';
import type {
  FloatHealth,
  FloatSurplusProvider,
} from '@/lib/gridCalculator/floatStrategy';
import { makeSupervisabilityResolver } from '@/lib/gridCalculator/supervisability';
import type {
  BackupCallPosture,
  CoverageRuleSet,
  CoverageStyle,
  DistanceEdge,
  FloatStrategyMode,
  GridCalculatorConfig,
  GridSite,
  SupervisionRatioMode,
} from '@/lib/gridCalculator/types';

// ---------------------------------------------------------------------------
// Layout variant — locked by Gabriel 2026-06-17 to Variant C "Hybrid".
// See docs/aesthetic-checkpoints/A9-initial.md. Switching variants flips
// padding/density across SiteLane/AnesthesiologistCard via this single flag.
// ---------------------------------------------------------------------------

export type LayoutVariant = 'dense' | 'airy' | 'hybrid';

/** Locked default. Update only after a fresh aesthetic checkpoint with Gabriel. */
export const LAYOUT_VARIANT: LayoutVariant = 'hybrid';

/** Locked dimensional defaults (px) — see A9 checkpoint. */
export const LAYOUT_DIMENSIONS = {
  laneHeaderWidth: 160,
  roomCardMinWidth: 220,
  shimmerMs: 200,
} as const;

// ---------------------------------------------------------------------------
// URL-backed toggle state (PRD §8).
// ---------------------------------------------------------------------------

export interface GridToggles {
  /** `cs` — coverage style. Default: balanced. */
  coverageStyle: CoverageStyle;
  /** `sr` — supervision ratio mode. Default: mixed. */
  supervisionRatio: SupervisionRatioMode;
  /** `fs` — float strategy. Default: balanced. */
  floatStrategy: FloatStrategyMode;
  /** `bp` — backup posture. Default: conservative. */
  backupPosture: BackupCallPosture;
  /** `wc` — show worst case. Default: true. */
  showWorstCase: boolean;
}

const DEFAULT_TOGGLES: GridToggles = {
  coverageStyle: 'balanced',
  supervisionRatio: 'mixed',
  floatStrategy: 'balanced',
  backupPosture: 'conservative',
  showWorstCase: true,
};

const VALID_COVERAGE = new Set<CoverageStyle>(['md_heavy', 'balanced', 'crna_heavy']);
const VALID_SUPERVISION = new Set<SupervisionRatioMode>([
  'mostly_1_3',
  'mostly_1_4',
  'mixed',
]);
const VALID_FLOAT = new Set<FloatStrategyMode>([
  'break_priority',
  'emergency_priority',
  'balanced',
]);
const VALID_BACKUP = new Set<BackupCallPosture>(['aggressive', 'conservative']);

function parseToggle<T extends string>(
  raw: string | null,
  valid: ReadonlySet<T>,
  fallback: T,
): T {
  if (!raw) return fallback;
  return valid.has(raw as T) ? (raw as T) : fallback;
}

/**
 * Read all five toggles from the current URL. Invalid values fall back to the
 * defaults so a malformed link still produces a renderable canvas.
 */
export function readTogglesFromParams(params: URLSearchParams): GridToggles {
  return {
    coverageStyle: parseToggle(
      params.get('cs'),
      VALID_COVERAGE,
      DEFAULT_TOGGLES.coverageStyle,
    ),
    supervisionRatio: parseToggle(
      params.get('sr'),
      VALID_SUPERVISION,
      DEFAULT_TOGGLES.supervisionRatio,
    ),
    floatStrategy: parseToggle(
      params.get('fs'),
      VALID_FLOAT,
      DEFAULT_TOGGLES.floatStrategy,
    ),
    backupPosture: parseToggle(
      params.get('bp'),
      VALID_BACKUP,
      DEFAULT_TOGGLES.backupPosture,
    ),
    showWorstCase: params.get('wc') !== '0',
  };
}

/**
 * Encode a single toggle change back into a query string. Round-trips through
 * `readTogglesFromParams` so a default value drops out of the URL (keeps the
 * shareable link short).
 */
export function writeTogglesToParams(
  prev: URLSearchParams,
  next: Partial<GridToggles>,
): URLSearchParams {
  const out = new URLSearchParams(prev);
  const merged: GridToggles = { ...DEFAULT_TOGGLES, ...readTogglesFromParams(prev), ...next };

  const setOrClear = (key: string, value: string, fallback: string) => {
    if (value === fallback) out.delete(key);
    else out.set(key, value);
  };

  setOrClear('cs', merged.coverageStyle, DEFAULT_TOGGLES.coverageStyle);
  setOrClear('sr', merged.supervisionRatio, DEFAULT_TOGGLES.supervisionRatio);
  setOrClear('fs', merged.floatStrategy, DEFAULT_TOGGLES.floatStrategy);
  setOrClear('bp', merged.backupPosture, DEFAULT_TOGGLES.backupPosture);
  if (merged.showWorstCase) out.delete('wc');
  else out.set('wc', '0');

  return out;
}

/**
 * React hook bundling `useSearchParams` + `router.replace` so toggle clicks
 * flow as a single function call. Caller component re-renders on URL change.
 */
export function useGridToggles(): {
  toggles: GridToggles;
  setToggle: <K extends keyof GridToggles>(key: K, value: GridToggles[K]) => void;
} {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const toggles = useMemo(
    () => readTogglesFromParams(new URLSearchParams(searchParams?.toString() ?? '')),
    [searchParams],
  );

  const setToggle = useCallback(
    <K extends keyof GridToggles>(key: K, value: GridToggles[K]) => {
      const next = writeTogglesToParams(
        new URLSearchParams(searchParams?.toString() ?? ''),
        { [key]: value } as Partial<GridToggles>,
      );
      const qs = next.toString();
      // `scroll: false` so the canvas doesn't jump on every toggle.
      router.replace(qs.length > 0 ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  return { toggles, setToggle };
}

// ---------------------------------------------------------------------------
// Demo Paoli-like fixture.
// A11 (Paoli Seed) replaces this with the real persistent fixture loaded from
// `scheduling.grid_calculator_configs`. The data structure is intentionally
// minimal so the canvas renders something the moment the page loads.
// ---------------------------------------------------------------------------

const DEMO_CONFIG_ID = 'demo-paoli-fixture';

const DEMO_SITES: GridSite[] = [
  {
    id: 'site-mainor',
    name: 'Main OR',
    shortName: 'OR',
    color: '#0ea5e9',
    icon: '🏥',
    position: 0,
    caption: 'ground floor',
    rooms: [
      { id: 'room-or-1', siteId: 'site-mainor', name: 'OR 1', position: 0 },
      { id: 'room-or-2', siteId: 'site-mainor', name: 'OR 2', position: 1 },
      { id: 'room-or-3', siteId: 'site-mainor', name: 'OR 3', position: 2 },
    ],
  },
  {
    id: 'site-endo',
    name: 'Endo',
    shortName: 'Endo',
    color: '#a855f7',
    icon: '🔬',
    position: 1,
    caption: 'tower-2',
    rooms: [
      { id: 'room-endo-a', siteId: 'site-endo', name: 'Endo A', position: 0 },
    ],
  },
];

const DEMO_EDGES: DistanceEdge[] = [
  { siteA: 'site-mainor', siteB: 'site-endo', band: 'near', supervisable: true },
];

const DEMO_ROSTER: RosterProvider[] = [
  { id: 'p-md-001', role: 'anesthesiologist', fte: 1.0, homeSiteId: 'site-mainor' },
  { id: 'p-md-002', role: 'anesthesiologist', fte: 1.0, homeSiteId: 'site-mainor' },
  { id: 'p-crna-001', role: 'crna', fte: 1.0, homeSiteId: 'site-mainor' },
  { id: 'p-crna-002', role: 'crna', fte: 1.0, homeSiteId: 'site-mainor' },
  { id: 'p-crna-003', role: 'crna', fte: 1.0, homeSiteId: 'site-endo' },
  { id: 'p-crna-004', role: 'crna', fte: 1.0, homeSiteId: 'site-mainor' },
];

const DEMO_PROVIDER_NAMES: Record<string, { name: string; initials: string }> = {
  'p-md-001': { name: 'Dr. Avery Chen', initials: 'AC' },
  'p-md-002': { name: 'Dr. Morgan Reyes', initials: 'MR' },
  'p-crna-001': { name: 'Riley Singh, CRNA', initials: 'RS' },
  'p-crna-002': { name: 'Jordan Park, CRNA', initials: 'JP' },
  'p-crna-003': { name: 'Casey Nguyen, CRNA', initials: 'CN' },
  'p-crna-004': { name: 'Sam Patel, CRNA', initials: 'SP' },
};

const DEMO_RULES: CoverageRuleSet = {
  siteRules: [
    {
      site: 'Endo',
      defaultStaffing: 'solo_crna_with_remote_md',
      supervisorFromSite: 'Main OR',
      maxSupervisionRatio: '1:3',
    },
    {
      site: 'Main OR',
      defaultStaffing: 'supervised_md_crna',
    },
  ],
  globalRules: [],
};

export interface DemoFixture {
  configId: string;
  sites: GridSite[];
  edges: DistanceEdge[];
  roster: RosterProvider[];
  rules: CoverageRuleSet;
  providerLabels: Record<string, { name: string; initials: string }>;
}

export const DEMO_PAOLI_FIXTURE: DemoFixture = {
  configId: DEMO_CONFIG_ID,
  sites: DEMO_SITES,
  edges: DEMO_EDGES,
  roster: DEMO_ROSTER,
  rules: DEMO_RULES,
  providerLabels: DEMO_PROVIDER_NAMES,
};

// ---------------------------------------------------------------------------
// Solve composition — solver → float strategy → float health.
// ---------------------------------------------------------------------------

export interface SolveResult {
  grid: SolvedGrid;
  health: FloatHealth;
  config: GridCalculatorConfig;
}

/**
 * Synchronous composer the canvas calls on every toggle change. Pure; safe
 * to memoize via `useMemo` on `[toggles, fixture]`.
 */
export function solveAndAssess(
  fixture: DemoFixture,
  toggles: GridToggles,
): SolveResult {
  const config: GridCalculatorConfig = {
    id: fixture.configId,
    hospital: 'Demo Hospital',
    name: 'Demo configuration',
    coverageStyle: toggles.coverageStyle,
    supervisionRatio: toggles.supervisionRatio,
    floatStrategy: toggles.floatStrategy,
    backupCallPosture: toggles.backupPosture,
  };

  const resolver = makeSupervisabilityResolver(fixture.edges);
  const grid = solve({
    config,
    sites: fixture.sites,
    rules: fixture.rules,
    roster: fixture.roster,
    distanceMatrix: resolver,
  });

  const used = new Set<string>();
  for (const a of grid.assignments) {
    if (a.anesthesiologistId) used.add(a.anesthesiologistId);
    for (const c of a.crnaIds) used.add(c);
  }
  for (const f of grid.floats) used.add(f.providerId);

  const surplus: FloatSurplusProvider[] = fixture.roster
    .filter((r) => !used.has(r.id))
    .map((r) => ({ id: r.id, role: r.role }));

  const gridWithFloats = applyFloatStrategy(grid, {
    mode: toggles.floatStrategy,
    surplus,
    sites: fixture.sites,
  });

  const health = assessFloatHealth(gridWithFloats, surplus);

  return { grid: gridWithFloats, health, config };
}
