'use client';

// Onboarding Wizard — state reducer + localStorage persistence.
// Owned by agent A15 (Onboarding Wizard).
// PRD: docs/PRD-Grid-Calculator.md §2 (universality goal), §14 (A15), §16 (criterion 1).
//
// Why a reducer (vs Zustand / Jotai / a useState soup):
//   - Single immutable transition function — easy to unit test, easy to log.
//   - The shape is small (one hospital, ≤ ~20 sites, sparse distance matrix,
//     one rule set) so re-rendering the whole tree on every step is cheap.
//   - Persistence is dead simple: stringify state on every action, parse on init.
//
// LocalStorage key: `gridCalcOnboarding:v1`. Versioned so a future schema bump
// can ignore stale state without crashing. If parse fails we silently reset.

import { useCallback, useEffect, useReducer, useRef } from 'react';

import type {
  CoverageRuleSet,
  DistanceBand,
  DistanceEdge,
  GridSite,
} from '@/lib/gridCalculator/types';

// ---------------------------------------------------------------------------
// Public state shape
// ---------------------------------------------------------------------------

/** Numeric step index. 0…4 are the five entry steps; 5 is review. */
export type WizardStepIndex = 0 | 1 | 2 | 3 | 4 | 5;

export const STEP_LABELS = [
  'Hospital',
  'Sites',
  'Distances',
  'Guidelines',
  'Review',
] as const;

/** Five guided steps + review = 6 dots on the progress trail. */
export const STEP_TITLES: ReadonlyArray<{ index: WizardStepIndex; label: string }> = [
  { index: 0, label: 'Hospital' },
  { index: 1, label: 'Sites' },
  { index: 2, label: 'Distances' },
  { index: 3, label: 'Guidelines' },
  { index: 4, label: 'Review' },
];

export interface HospitalIdentity {
  /** Display name e.g. "Paoli Hospital", "Mercy Northwest". */
  name: string;
  /** Owner / scheduler contact email. */
  contactEmail: string;
  /**
   * IANA timezone string (e.g. "America/New_York"). Used by the calendar
   * generator A7 (FTE simulator) when sampling weekday/holiday distributions.
   */
  timezone: string;
}

/** Sparse list of declared distance bands — same shape as `DistanceEdge`. */
export type DistanceMap = DistanceEdge[];

export interface ParsedRulesState {
  /** Normalized rule set returned by `/api/grid-calculator/normalize-rules`. */
  rules: CoverageRuleSet | null;
  /** Whether the system prompt was served from cache on the last parse. */
  cacheHit: boolean | null;
  /** Resolved Claude model id (e.g. "claude-opus-4-7"). */
  modelId: string | null;
  /** Last parse attempt epoch ms. Used to show "Parsed X seconds ago". */
  parsedAt: number | null;
  /** Last error message, or null on success. Surfaced inline (PRD §9). */
  error: string | null;
  /** Sentences the normalizer could not map. PRD §9 — shown to the user. */
  unmapped: string[];
}

export interface WizardState {
  /** Currently active step. 0..5. */
  step: WizardStepIndex;
  /** Hospital identity. Defaults to empty strings on first mount. */
  hospital: HospitalIdentity;
  /** Sites + rooms entered so far. Auto-positioned in order of insertion. */
  sites: GridSite[];
  /** Sparse distance matrix — missing pairs default to `near`. */
  distances: DistanceMap;
  /** Raw free-text guidelines from the textarea. */
  guidelines: string;
  /** Parsed CoverageRuleSet + parse metadata. */
  parsedRules: ParsedRulesState;
  /**
   * True when the user has acknowledged the unmapped sentences from the
   * normalizer's last response. Hides the warning chip. PRD §9.
   */
  unmappedAcknowledged: boolean;
}

export const DEFAULT_TIMEZONE = 'America/New_York';

const EMPTY_PARSED_RULES: ParsedRulesState = {
  rules: null,
  cacheHit: null,
  modelId: null,
  parsedAt: null,
  error: null,
  unmapped: [],
};

export const INITIAL_STATE: WizardState = {
  step: 0,
  hospital: { name: '', contactEmail: '', timezone: DEFAULT_TIMEZONE },
  sites: [],
  distances: [],
  guidelines: '',
  parsedRules: EMPTY_PARSED_RULES,
  unmappedAcknowledged: false,
};

// ---------------------------------------------------------------------------
// Action shapes — keep them flat & explicit, no fancy generics. This keeps
// the reducer easy to follow even for a code-review agent.
// ---------------------------------------------------------------------------

export type WizardAction =
  | { type: 'goToStep'; step: WizardStepIndex }
  | { type: 'next' }
  | { type: 'back' }
  | { type: 'setHospital'; patch: Partial<HospitalIdentity> }
  | { type: 'addSite'; site: GridSite }
  | { type: 'removeSite'; siteId: string }
  | { type: 'updateSite'; siteId: string; patch: Partial<Omit<GridSite, 'rooms'>> }
  | { type: 'addRoom'; siteId: string; name: string }
  | { type: 'removeRoom'; siteId: string; roomId: string }
  | { type: 'renameRoom'; siteId: string; roomId: string; name: string }
  | {
      type: 'setDistance';
      siteAId: string;
      siteBId: string;
      band: DistanceBand;
    }
  | {
      type: 'setSupervisable';
      siteAId: string;
      siteBId: string;
      supervisable: boolean;
    }
  | { type: 'setGuidelines'; text: string }
  | {
      type: 'setParsedRules';
      rules: CoverageRuleSet | null;
      cacheHit: boolean | null;
      modelId: string | null;
      unmapped: string[];
      error: string | null;
    }
  | { type: 'acknowledgeUnmapped' }
  | { type: 'reset' }
  | { type: 'hydrate'; state: WizardState };

// ---------------------------------------------------------------------------
// Reducer — keep transitions pure; never read from window / localStorage.
// ---------------------------------------------------------------------------

const MAX_STEP: WizardStepIndex = 5;

function clampStep(n: number): WizardStepIndex {
  if (n < 0) return 0;
  if (n > MAX_STEP) return MAX_STEP;
  return n as WizardStepIndex;
}

export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case 'goToStep':
      return { ...state, step: clampStep(action.step) };

    case 'next':
      return { ...state, step: clampStep(state.step + 1) };

    case 'back':
      return { ...state, step: clampStep(state.step - 1) };

    case 'setHospital':
      return { ...state, hospital: { ...state.hospital, ...action.patch } };

    case 'addSite': {
      // Drop into the next available `position` slot.
      const maxPos = state.sites.reduce(
        (acc, s) => (s.position > acc ? s.position : acc),
        -1,
      );
      const site: GridSite = {
        ...action.site,
        position: action.site.position ?? maxPos + 1,
      };
      return { ...state, sites: [...state.sites, site] };
    }

    case 'removeSite': {
      const sites = state.sites.filter((s) => s.id !== action.siteId);
      // Drop any distance edges referencing the deleted site.
      const distances = state.distances.filter(
        (e) => e.siteA !== action.siteId && e.siteB !== action.siteId,
      );
      return { ...state, sites, distances };
    }

    case 'updateSite': {
      const sites = state.sites.map((s) =>
        s.id === action.siteId ? { ...s, ...action.patch } : s,
      );
      return { ...state, sites };
    }

    case 'addRoom': {
      const sites = state.sites.map((s) => {
        if (s.id !== action.siteId) return s;
        const nextPos = s.rooms.reduce(
          (acc, r) => (r.position > acc ? r.position : acc),
          -1,
        ) + 1;
        const room = {
          id: `room-${cryptoRandomId()}`,
          siteId: s.id,
          name: action.name,
          position: nextPos,
        };
        return { ...s, rooms: [...s.rooms, room] };
      });
      return { ...state, sites };
    }

    case 'removeRoom': {
      const sites = state.sites.map((s) => {
        if (s.id !== action.siteId) return s;
        return { ...s, rooms: s.rooms.filter((r) => r.id !== action.roomId) };
      });
      return { ...state, sites };
    }

    case 'renameRoom': {
      const sites = state.sites.map((s) => {
        if (s.id !== action.siteId) return s;
        return {
          ...s,
          rooms: s.rooms.map((r) =>
            r.id === action.roomId ? { ...r, name: action.name } : r,
          ),
        };
      });
      return { ...state, sites };
    }

    case 'setDistance': {
      const distances = upsertEdge(state.distances, {
        siteA: action.siteAId,
        siteB: action.siteBId,
        band: action.band,
        supervisable: defaultSupervisableForBand(action.band),
      });
      return { ...state, distances };
    }

    case 'setSupervisable': {
      const existing = state.distances.find((e) =>
        sameEdge(e, action.siteAId, action.siteBId),
      );
      const distances = upsertEdge(state.distances, {
        siteA: action.siteAId,
        siteB: action.siteBId,
        band: existing?.band ?? 'near',
        supervisable: action.supervisable,
      });
      return { ...state, distances };
    }

    case 'setGuidelines':
      return {
        ...state,
        guidelines: action.text,
        // Mark the parsed rules as stale — we don't auto-clear them so the
        // user can keep referring to the previous parse while editing.
      };

    case 'setParsedRules':
      return {
        ...state,
        parsedRules: {
          rules: action.rules,
          cacheHit: action.cacheHit,
          modelId: action.modelId,
          parsedAt: Date.now(),
          error: action.error,
          unmapped: action.unmapped,
        },
        unmappedAcknowledged: false,
      };

    case 'acknowledgeUnmapped':
      return { ...state, unmappedAcknowledged: true };

    case 'reset':
      return { ...INITIAL_STATE };

    case 'hydrate':
      // Trust the hydrated payload — the loader has already validated shape.
      return action.state;
  }
}

// ---------------------------------------------------------------------------
// Hook — bundles reducer + localStorage persistence in one tidy API.
// ---------------------------------------------------------------------------

export const STORAGE_KEY = 'gridCalcOnboarding:v1';

export interface UseWizardResult {
  state: WizardState;
  dispatch: React.Dispatch<WizardAction>;
  /** Wipes localStorage AND resets the in-memory state. */
  resetWizard: () => void;
}

export function useWizard(): UseWizardResult {
  const [state, dispatch] = useReducer(wizardReducer, INITIAL_STATE);

  // Track whether we've finished the initial hydration. We avoid writing back
  // to localStorage until after hydration so a fresh tab doesn't overwrite
  // saved state before the load resolves.
  const hydratedRef = useRef(false);

  // Hydrate from localStorage exactly once on mount.
  useEffect(() => {
    if (typeof window === 'undefined') {
      hydratedRef.current = true;
      return;
    }
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = safeParseWizardState(raw);
        if (parsed) {
          dispatch({ type: 'hydrate', state: parsed });
        }
      }
    } catch {
      // Corrupt localStorage — silently ignore and start fresh.
    } finally {
      hydratedRef.current = true;
    }
  }, []);

  // Persist after every dispatch (skipping the initial pre-hydration write).
  useEffect(() => {
    if (!hydratedRef.current) return;
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Storage full / disabled — non-fatal.
    }
  }, [state]);

  const resetWizard = useCallback(() => {
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.removeItem(STORAGE_KEY);
      } catch {
        // ignore
      }
    }
    dispatch({ type: 'reset' });
  }, []);

  return { state, dispatch, resetWizard };
}

// ---------------------------------------------------------------------------
// Internals — small helpers kept private to this module.
// ---------------------------------------------------------------------------

function sameEdge(edge: DistanceEdge, aId: string, bId: string): boolean {
  return (
    (edge.siteA === aId && edge.siteB === bId) ||
    (edge.siteA === bId && edge.siteB === aId)
  );
}

function upsertEdge(edges: DistanceEdge[], next: DistanceEdge): DistanceEdge[] {
  const idx = edges.findIndex((e) => sameEdge(e, next.siteA, next.siteB));
  if (idx === -1) return [...edges, next];
  const copy = edges.slice();
  copy[idx] = next;
  return copy;
}

/**
 * Mirrors `defaultBandSupervisability` from `distanceMatrix.ts` without
 * importing it — keeps the wizard's compile graph thin so this state file
 * has no runtime dependency on a heavy lib module. The two helpers are
 * trivially equivalent: `near | adjacent | same_room` are supervisable.
 */
function defaultSupervisableForBand(band: DistanceBand): boolean {
  return band === 'same_room' || band === 'adjacent' || band === 'near';
}

/**
 * Returns a UUID-ish string. Uses `crypto.randomUUID()` when available
 * (modern browsers + Node 19+) and falls back to a Math.random-based id
 * otherwise. The wizard never persists these ids server-side so collision
 * risk is bounded to a single onboarding session.
 */
function cryptoRandomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback: 12 hex chars; collision-resistant within a session.
  return Math.random().toString(16).slice(2, 14);
}

/**
 * Safe JSON parse + structural validation. Returns the parsed `WizardState`
 * or null if anything is off. We intentionally do shallow structural checks
 * only — full schema validation lives server-side once A14 wires Supabase.
 */
function safeParseWizardState(raw: string): WizardState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as Partial<WizardState>;

  if (typeof candidate.step !== 'number') return null;
  if (typeof candidate.hospital !== 'object' || candidate.hospital === null) {
    return null;
  }
  if (!Array.isArray(candidate.sites)) return null;
  if (!Array.isArray(candidate.distances)) return null;
  if (typeof candidate.guidelines !== 'string') return null;
  if (
    typeof candidate.parsedRules !== 'object' ||
    candidate.parsedRules === null
  ) {
    return null;
  }

  // Coerce so missing fields don't crash the UI on hydration.
  const hospital = candidate.hospital as Partial<HospitalIdentity>;
  const parsedRules = candidate.parsedRules as Partial<ParsedRulesState>;

  return {
    step: clampStep(candidate.step),
    hospital: {
      name: typeof hospital.name === 'string' ? hospital.name : '',
      contactEmail:
        typeof hospital.contactEmail === 'string' ? hospital.contactEmail : '',
      timezone:
        typeof hospital.timezone === 'string'
          ? hospital.timezone
          : DEFAULT_TIMEZONE,
    },
    sites: candidate.sites as GridSite[],
    distances: candidate.distances as DistanceEdge[],
    guidelines: candidate.guidelines,
    parsedRules: {
      rules: parsedRules.rules ?? null,
      cacheHit: parsedRules.cacheHit ?? null,
      modelId: parsedRules.modelId ?? null,
      parsedAt: parsedRules.parsedAt ?? null,
      error: parsedRules.error ?? null,
      unmapped: Array.isArray(parsedRules.unmapped) ? parsedRules.unmapped : [],
    },
    unmappedAcknowledged: Boolean(candidate.unmappedAcknowledged),
  };
}

// ---------------------------------------------------------------------------
// Site palette + quick-add presets — universal seed values for new hospitals.
// ---------------------------------------------------------------------------

/**
 * The 8-color palette the wizard exposes via the color picker. Chosen so they
 * all look reasonable as a 3px lane accent and 1px chip border. Hex strings
 * stored directly so the data round-trips through `GridSite.color` cleanly.
 */
export const SITE_COLOR_PALETTE: ReadonlyArray<{ name: string; hex: string }> = [
  { name: 'Sky', hex: '#0ea5e9' },
  { name: 'Violet', hex: '#a855f7' },
  { name: 'Amber', hex: '#f59e0b' },
  { name: 'Emerald', hex: '#10b981' },
  { name: 'Rose', hex: '#f43f5e' },
  { name: 'Indigo', hex: '#6366f1' },
  { name: 'Teal', hex: '#14b8a6' },
  { name: 'Slate', hex: '#64748b' },
];

/**
 * Quick-add presets — the "common five" sites every anesthesia group ships
 * with. PRD §14 (A15) calls these out explicitly. Order matches admin habit
 * (Main OR first because it's almost always present).
 */
export interface SitePreset {
  key: string;
  name: string;
  shortName: string;
  icon: string;
  color: string;
  caption?: string;
  defaultRoomCount: number;
}

export const SITE_PRESETS: ReadonlyArray<SitePreset> = [
  {
    key: 'mainor',
    name: 'Main OR',
    shortName: 'OR',
    icon: '🏥',
    color: '#0ea5e9',
    caption: 'main surgical block',
    defaultRoomCount: 6,
  },
  {
    key: 'endo',
    name: 'Endoscopy',
    shortName: 'Endo',
    icon: '🔬',
    color: '#a855f7',
    caption: 'GI suite',
    defaultRoomCount: 2,
  },
  {
    key: 'neuro',
    name: 'Neuro Lab',
    shortName: 'Neuro',
    icon: '🧠',
    color: '#6366f1',
    caption: 'interventional neuro',
    defaultRoomCount: 1,
  },
  {
    key: 'ep',
    name: 'EP Lab',
    shortName: 'EP',
    icon: '⚡',
    color: '#f59e0b',
    caption: 'electrophysiology',
    defaultRoomCount: 1,
  },
  {
    key: 'ob',
    name: 'OB',
    shortName: 'OB',
    icon: '👶',
    color: '#f43f5e',
    caption: 'L&D / C-section',
    defaultRoomCount: 1,
  },
];

/**
 * Make a fresh `GridSite` from a preset. Generates fresh ids for the site +
 * each room so re-applying the same preset doesn't collide with itself.
 */
export function buildSiteFromPreset(preset: SitePreset, position: number): GridSite {
  const siteId = `site-${cryptoRandomId()}`;
  return {
    id: siteId,
    name: preset.name,
    shortName: preset.shortName,
    color: preset.color,
    icon: preset.icon,
    position,
    caption: preset.caption,
    rooms: Array.from({ length: preset.defaultRoomCount }, (_, idx) => ({
      id: `room-${cryptoRandomId()}`,
      siteId,
      name:
        preset.defaultRoomCount === 1
          ? preset.shortName
          : `${preset.shortName} ${idx + 1}`,
      position: idx,
    })),
  };
}

/**
 * Build a blank (no rooms) `GridSite` for the "+ Add custom site" path.
 * Caller fills in name/color/icon via the StepSites form.
 */
export function buildCustomSite(
  position: number,
  init: { name: string; icon: string; color: string; roomCount: number },
): GridSite {
  const siteId = `site-${cryptoRandomId()}`;
  const shortName = init.name.split(/\s+/)[0]?.slice(0, 6) ?? init.name.slice(0, 6);
  return {
    id: siteId,
    name: init.name,
    shortName,
    color: init.color,
    icon: init.icon,
    position,
    rooms: Array.from({ length: Math.max(0, init.roomCount) }, (_, idx) => ({
      id: `room-${cryptoRandomId()}`,
      siteId,
      name: init.roomCount === 1 ? shortName : `${shortName} ${idx + 1}`,
      position: idx,
    })),
  };
}

// ---------------------------------------------------------------------------
// Common timezone choices — a short curated list keeps the field skim-friendly
// while still covering the common North American hospital timezones. Falls
// back to the platform default so non-US groups can type their own value.
// ---------------------------------------------------------------------------

export const TIMEZONE_OPTIONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'America/New_York', label: 'Eastern (America/New_York)' },
  { id: 'America/Chicago', label: 'Central (America/Chicago)' },
  { id: 'America/Denver', label: 'Mountain (America/Denver)' },
  { id: 'America/Phoenix', label: 'Mountain - AZ (America/Phoenix)' },
  { id: 'America/Los_Angeles', label: 'Pacific (America/Los_Angeles)' },
  { id: 'America/Anchorage', label: 'Alaska (America/Anchorage)' },
  { id: 'Pacific/Honolulu', label: 'Hawaii (Pacific/Honolulu)' },
  { id: 'America/Halifax', label: 'Atlantic (America/Halifax)' },
];

// ---------------------------------------------------------------------------
// Inline Paoli guideline example — shown verbatim under the "see Paoli
// example" disclosure on StepGuidelines. Lifted from
// `src/lib/gridCalculator/seeds/paoli.guidelines.md` so the wizard does NOT
// need to import the seed module at runtime (keeps universality contract).
// ---------------------------------------------------------------------------

export const PAOLI_EXAMPLE_GUIDELINES = `Paoli Hospital is a community hospital with a Main OR cluster on the 4th floor that contains 15 anesthetizing rooms, an Endoscopy suite on the same campus with two rooms, a single Neuro interventional lab, a single EP Lab, and a single OB / L&D unit one wing away from the Main OR. We staff Endoscopy as a solo Anesthesiologist who covers the GI list independently and can also provide TEEs and cardioversions when the Main OR is quiet. OB is staffed by a solo Anesthesiologist dedicated to L&D, epidurals, and C-sections; when OB is not busy that Anesthesiologist becomes a break-relief auxiliary who helps cover the Main OR. The EP Lab and Neuro Lab each run one CRNA who is supervised cross-site by an Anesthesiologist sitting in the Main OR; supervision at those off-sites is capped at 1:3 because of the walk distance. We never supervise more than 1:3 at OB. Inside the Main OR, the default supervision target is mostly 1:3 with some 1:4 acceptable when distance is trivial.`;

// ---------------------------------------------------------------------------
// Per-step completeness check — drives the "next" button enabled state and
// the dot-trail check marks.
// ---------------------------------------------------------------------------

export function isStepComplete(state: WizardState, step: WizardStepIndex): boolean {
  switch (step) {
    case 0:
      return (
        state.hospital.name.trim().length > 0 &&
        isValidEmail(state.hospital.contactEmail) &&
        state.hospital.timezone.trim().length > 0
      );
    case 1:
      return (
        state.sites.length > 0 &&
        state.sites.every((s) => s.rooms.length > 0)
      );
    case 2:
      // The distance step is optional for single-site hospitals; we treat it
      // as complete by default since "near" is the silent default.
      return true;
    case 3:
      // Guidelines step is complete when text exists AND at least one parse
      // attempt has succeeded. Empty guidelines are technically valid for
      // the solver but we want users to engage with this step.
      return (
        state.guidelines.trim().length > 0 &&
        state.parsedRules.rules !== null &&
        state.parsedRules.error === null
      );
    case 4:
      return false; // Review never auto-completes — Save & finish lives there.
    case 5:
      return false;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}
