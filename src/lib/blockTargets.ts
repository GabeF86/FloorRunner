// Block Targets — the DATA LAYER behind the per-block target panel
// (Gabriel 2026-07-27, verbatim: "Build a small panel to enter them per
// block").
//
// WHY THIS EXISTS. The engine has honored per-provider, per-block call targets
// since the scenario layer shipped (2026-07-26): schedules.scenario_manifest
// holds a PaoliBlockManifest, projectScenario turns it into hard caps, gates,
// linkages and steering targets, and those STATED numbers outrank the generic
// FTE quota. Until now the only producer was the workbook importer
// (paoliBlock/importWorkbook.ts) — and there is not always a workbook. This
// module builds the same artifact from hand-entered numbers, so the panel and
// the importer feed the engine ONE contract.
//
// THE DERIVATION RULE (his obligation model, verbatim): "in an 11 week block
// with 11 par call takers, there should be 4 Weekday C1 and 4 C2's, 1 Friday
// C1, Saturday C1 and Sunday C1... Always imagine there are 11 call takers and
// use that to calculate the obligatory numbers and the slots that go unfilled
// will be filled later." That is exactly the house formula
// (fteTarget.fteWeightedTarget — slots ÷ stored par × FTE, par-authoritative
// 2026-07-24), so it is IMPORTED, never restated: 44 M–Th C1 slots ÷ par 11 ×
// 1.0 = 4, and 11 Friday/Saturday/Sunday C1 slots ÷ 11 × 1.0 = 1 each.
//
// NEURO IS NOT THAT FORMULA. NEURO_FSS is a weekend-UNIT obligation set by the
// site's call pattern (`neuroWeekend.requirementBands`), so its derived value
// comes from `owedUnitsFor` — the same function the solver's steering tier and
// the generation banner's shortfall report call. The panel's default and the
// engine's default therefore cannot drift: Paoli's live bands
// ([{minFte:0.6,units:1},{minFte:0,units:0.5}]) give a 0.6+ doc one full neuro
// weekend and anyone below one weekend DAY, which is his rule stated as data:
// "every call taker should be given a neuro weekend call, except for horan".
// The boundary moved 0.75 -> 0.6 on 2026-07-27 (patch40) because at 0.75 it
// created a SECOND exception nobody asked for — Hussain is 0.66 FTE (a third
// of his time is ICU) and fell in with Horan. Do not restate these numbers
// anywhere: this module reads the live config, and its tests assert 0.6.
//
// BLANK MEANS DERIVED (the Limits-tab convention, providerLimits.ts). He
// overrides ~4 people out of ~10; a panel that made him type nine numbers for
// ten people would be worse than useless. The MANIFEST always carries the
// FINAL absolute numbers (the engine reads absolute targets and knows nothing
// about "derived"), and the panel's memory of WHICH cells he typed rides in a
// `blockTargets` sidecar on the manifest — see BlockTargetsPanelState. It
// stores KEYS ONLY, never a second copy of the numbers: providers[].targets
// stays the single home of every value, so the sidecar can never disagree with
// what the engine reads. Recomputing "was this an override?" by comparing the
// stored number against a freshly derived one was rejected — the moment a slot
// is added or the par changes, every derived cell would compare unequal and
// silently FREEZE as an override, which is precisely the failure this panel
// exists to avoid.
//
// ONLY THE PROVIDERS HE STATED ARE WRITTEN (Gabriel 2026-07-27, answering the
// question this module raised). Writing the whole roster would have made the
// six people he never looked at into HARD CAPS at their formula numbers, and a
// scenario cap BLOCKS a fill where the ordinary FTE quota only STEERS — the
// house rule is "quota never blocks fills" (scheduler_fill_overhaul). Capping
// six untouched people would refuse a full-timer who could have absorbed a
// fifth M–Th C1 to cover a gap, and drop that slot into the paid-pickup layer
// for no reason he chose. So `providers[]` carries ONLY rows with something
// stated — an override, a linkage, a prohibition, a fixed assignment or a
// preference (statedProviders) — and everyone else is ABSENT from the manifest
// entirely and keeps ordinary FTE behavior. That is legitimate downstream by
// construction: projectScenario iterates `manifest.providers` and warns only
// about rows it FINDS and cannot use (no id / not in the pool), never about a
// provider it does not find, and buildScenarioCallCaps / scenarioChargeKeys /
// applyScenarioBucketTargets all key off `scenario.providers`, so an omitted
// provider has no `S:` cap and no target override at all.
//
// THE ONE BACK-FILL: a split-12h linkage's members are provider display NAMES,
// so omitting a named partner would leave the linkage naming somebody the
// manifest never mentions — a half-Sunday belonging to nobody, the same orphan
// class strandedEdits already catches for a partner who left the pool. In the
// panel's own flow both halves are typed 0.5 so both rows qualify anyway, but
// that is a property of one code path, not of the artifact. statedProviders
// therefore pulls in any provider NAMED by an included row's split-12h linkage
// and buildBlockManifest records it as a warning — never silently. One pass is
// provably enough: a back-filled provider states nothing (that is why they were
// missing), so they carry no linkage that could name a further partner.
//
// EITHER-OR OWNS ITS BUCKETS (2026-07-27). "Take either one Friday or one
// Sunday call" is enforced by providerCaps.buildScenarioCallCaps as a GROUP
// ceiling of max(1, ceil(Σ targets of the covered buckets)) — the members'
// individual targets are deliberately folded into the group and stop binding
// on their own. So a covered bucket left at its DERIVED value (0.66 + 0.66 for
// a 0.66 FTE) would silently buy a group cap of 2 and hand the provider BOTH
// calls. resolveTargets therefore zeroes every either-or-covered bucket he did
// not type by hand (which is what the real Paoli workbook rows do), and warns
// — never silently — when explicit values still sum past one.
//
// HOLIDAY DAY TYPES (2026-07-27, deliberate deviation from a plain
// derived_day_type map). The workbook buckets are DAY-OF-WEEK columns
// ("Monday–Thursday C1"), and the engine charges a Monday-holiday placement to
// MTH|C1 via scenario.scenarioBucketOf(date) — so a 'major_holiday' slot has
// no day-type bucket but absolutely has a workbook bucket. Dropping Labor Day
// (2026-09-07, a Monday inside the live 8/10–10/25 block) would make MTH_C1 43
// instead of 44, his "4 Weekday C1" would derive as 3.909, and every MTH cap
// would be one slot short of what the engine will actually charge against it.
// So: derived_day_type decides for weekday/friday/saturday/sunday, and any
// other day type (holidays, or an unrecognized value) falls back to the DATE's
// day of week through scenarioBucketOf — the engine's own mapping, single-homed.
//
// PURE — no I/O, no DB, no schema of its own. VALIDATION LIVES AT THE ROUTE:
// schedules/[id] PATCH runs paoliBlockManifestSchema before any write, so this
// module never re-implements (or re-checks) that shape. It does import
// BUCKET_KEYS from manifest.ts, which pulls zod along into whatever bundle
// imports this — a known, accepted cost of keeping ONE list of bucket keys.

import {
  BUCKET_KEYS,
  PAOLI_BLOCK_MANIFEST_VERSION,
  WEEKDAY_CODES,
  type BucketKey,
  type CallCode,
  type FixedAssignment,
  type Linkage,
  type PaoliBlockManifest,
  type Preference,
  type Prohibition,
  type ProviderManifest,
  type WeekdayCode,
} from '@/lib/paoliBlock/manifest';
import { compareChecksums, computeChecksums, type ChecksumRow } from '@/lib/paoliBlock/checksums';
import { normalizeName } from '@/lib/paoliBlock/names';
import { DEFAULT_SCENARIO_CODE_MAP, scenarioBucketOf, type ScenarioBucket } from '@/lib/rulesEngine/scenario';
import { owedUnitsFor, type NeuroWeekendConfig } from '@/lib/rulesEngine/neuroWeekend';
import { fteWeightedTarget } from '@/lib/fteTarget';
import { WEIGHT_EPSILON, callBurdenWeight, parentCallCodeOf } from '@/lib/callBurden';
import { weekendGroupKey } from '@/lib/weekendGroup';

// The neuro bucket key. Spelled here as a literal (BucketKey-typed) because
// scenario.NEURO_KEY is a widened `string`; blockTargets.test.ts pins the two
// equal so a rename cannot split them.
export const NEURO_BUCKET: BucketKey = 'NEURO_FSS';

/** Every bucket → a number. Used for targets, slot counts and sums alike. */
export type BucketNumbers = Record<BucketKey, number>;
/** A provider's stated per-bucket targets (all nine keys — the manifest's
 * `targets` record is exhaustive under zod 4). */
export type BucketTargets = BucketNumbers;
/** Only the cells the user typed. Absent = blank = derived. */
export type TargetOverrides = Partial<Record<BucketKey, number>>;

export function zeroBuckets(): BucketNumbers {
  return Object.fromEntries(BUCKET_KEYS.map(k => [k, 0])) as BucketNumbers;
}

// Binary-float hygiene, same trick and tolerance as checksums.clean: kill
// 2.6400000000000006 without disturbing a real 0.3333.
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

// ── slot counting ────────────────────────────────────────────────────────────

// One schedule slot as the grid payload already hands it over (mirrors
// fteTarget.CensusSlot deliberately — the panel lives on the schedule page and
// consumes the same rows, so no new query shape is invented here).
// call_burden_weight / parent_call_code are the patch35 split columns; absent
// means weight 1 / parent = own code (callBurden.ts defaults).
export interface BlockSlot {
  slot_date: string;
  derived_day_type?: string | null;
  shift_types: {
    code: string;
    category: string;
    call_burden_weight?: number | null;
    parent_call_code?: string | null;
  } | null;
}

export interface BucketCodeOptions {
  /** Workbook → engine call codes, same direction as ScenarioDoc.codeMap.
   * Default DEFAULT_SCENARIO_CODE_MAP (C1→C1, C2→C2, NEURO→C3). */
  codeMap?: Record<string, string>;
  /** The site pattern's `neuroWeekend.code`; wins over the code map's NEURO. */
  neuroCode?: string;
}

const DAY_TYPE_TO_BUCKET: Record<string, ScenarioBucket> = {
  weekday: 'MTH', friday: 'FRI', saturday: 'SAT', sunday: 'SUN',
};

function bucketOfSlot(slot: BlockSlot): ScenarioBucket {
  const dt = slot.derived_day_type;
  // Holidays (and anything unrecognized) fall back to the DATE's day of week —
  // the engine's own charge mapping. See the module header.
  return (dt ? DAY_TYPE_TO_BUCKET[dt] : undefined) ?? scenarioBucketOf(slot.slot_date);
}

/**
 * Per-bucket capacity of a block, from its slots.
 *
 * The eight non-neuro buckets are WEIGHTED slot counts: every call-category
 * slot whose PARENT code (parentCallCodeOf — never a code-name pattern) maps
 * back to workbook C1/C2 adds its call_burden_weight, so a Sunday C1 split
 * into two 12h segments still counts as exactly one Sunday C1 (the same rule
 * fteTarget's obligation census uses). Call codes outside C1/C2/NEURO
 * (beeper/CB and friends) have no workbook bucket and are ignored.
 *
 * NEURO_FSS is counted in WEEKEND UNITS, not slots — a Sat+Sun neuro pair is
 * one unit and a lone neuro day is half, mirroring
 * neuroWeekend.creditedUnitsByProvider so capacity and credit are measured on
 * the same scale. A Mon–Thu neuro slot belongs to no F/S/S weekend and is
 * ignored.
 */
export function bucketSlotCounts(
  slots: readonly BlockSlot[],
  opts: BucketCodeOptions = {},
): BucketNumbers {
  const codeMap = opts.codeMap ?? DEFAULT_SCENARIO_CODE_MAP;
  const neuroCode = opts.neuroCode ?? codeMap.NEURO ?? 'C3';
  // engine code -> workbook C1/C2 (the only two bucketed call codes).
  const workbookOf = new Map<string, 'C1' | 'C2'>();
  for (const wb of ['C1', 'C2'] as const) workbookOf.set(codeMap[wb] ?? wb, wb);

  const out = zeroBuckets();
  const neuroDatesByWeekend = new Map<string, Set<string>>();
  for (const slot of slots) {
    const st = slot.shift_types;
    if (!st || st.category !== 'call') continue;
    const parent = parentCallCodeOf(st.code, st);
    if (parent === neuroCode) {
      const wk = weekendGroupKey(slot.slot_date);
      if (!wk) continue;
      let dates = neuroDatesByWeekend.get(wk);
      if (!dates) { dates = new Set(); neuroDatesByWeekend.set(wk, dates); }
      dates.add(slot.slot_date);
      continue;
    }
    const wb = workbookOf.get(parent);
    if (!wb) continue;
    const key = `${bucketOfSlot(slot)}_${wb}` as BucketKey;
    out[key] += callBurdenWeight(st);
  }
  for (const dates of neuroDatesByWeekend.values()) {
    out[NEURO_BUCKET] += dates.size >= 2 ? 1 : 0.5;
  }
  for (const k of BUCKET_KEYS) out[k] = round6(out[k]);
  return out;
}

// ── derivation ───────────────────────────────────────────────────────────────

/** Everything the derived column is a function of. The panel holds one of
 * these for the whole block; every row derives against it. */
export interface DerivationBasis {
  slotCounts: BucketNumbers;
  /** sites.call_par_level — AUTHORITATIVE, never clamped to the pool's ΣFTE
   * (2026-07-24). When the pool is smaller than the par the targets
   * deliberately under-cover the block; the remainder is the paid-pickup
   * layer, which checkFeasibility reports as `under`, never as an error. */
  parLevel: number;
  /** The site call pattern's `neuroWeekend`. null = the site states no neuro
   * requirement, and every derived NEURO_FSS is 0. */
  neuro: NeuroWeekendConfig | null;
}

/** The derived (blank-cell) targets for one FTE. Non-neuro buckets use the
 * house FTE formula; NEURO_FSS uses the pattern's requirement bands. */
export function derivedTargetsFor(fte: number, basis: DerivationBasis): BucketTargets {
  const out = zeroBuckets();
  for (const k of BUCKET_KEYS) {
    if (k === NEURO_BUCKET) continue;
    out[k] = round6(fteWeightedTarget(basis.slotCounts[k] ?? 0, basis.parLevel, fte));
  }
  out[NEURO_BUCKET] = basis.neuro ? owedUnitsFor(fte, basis.neuro) : 0;
  return out;
}

/** Derived targets for a whole roster, keyed by provider id. */
export function derivedTargets(
  providers: ReadonlyArray<{ providerId: string; fte: number }>,
  basis: DerivationBasis,
): Map<string, BucketTargets> {
  return new Map(providers.map(p => [p.providerId, derivedTargetsFor(p.fte, basis)]));
}

// ── linkage grammar ──────────────────────────────────────────────────────────
// Members are the manifest's slot-descriptor strings (manifest.ts header):
//   `FRI:C1`, `SAT:NEURO`, `SUN:ANY`   — weekday-scoped
//   `2026-09-05:C2`                    — date-scoped
//   provider display names             — split-12h ONLY
// scenario.parseMember splits on the LAST ':' and rejects anything that is
// neither an ISO date nor an uppercase weekday code — an unparseable member
// leaves the linkage inert (members: []) with only a warning, so the grammar
// is validated HERE, where the mistake is still fixable.

const WEEKDAY_CODE_SET = new Set<string>(WEEKDAY_CODES);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `ANY` matches any non-neuro call code (scenario.memberMatches). */
export type LinkageCode = CallCode | 'ANY';
/** A weekday code (`FRI`) or an ISO date (`2026-09-05`). */
export type LinkageScope = WeekdayCode | string;

export interface ParsedLinkageMember {
  scope: string;
  code: string;
  /** 0=Sun..6=Sat for weekday-scoped members; null for date-scoped. */
  dow: number | null;
  date: string | null;
}

const WEEKDAY_TO_DOW: Record<string, number> = {
  SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6,
};

/** Parse a slot-descriptor member exactly the way scenario.parseMember does;
 * null when the engine would fail to parse it (provider names included). */
export function parseLinkageMember(raw: string): ParsedLinkageMember | null {
  const idx = raw.lastIndexOf(':');
  if (idx < 0) return null;
  const scope = raw.slice(0, idx);
  const code = raw.slice(idx + 1);
  if (!code) return null;
  if (ISO_DATE_RE.test(scope)) return { scope, code, dow: null, date: scope };
  const dow = WEEKDAY_TO_DOW[scope];
  if (dow === undefined) return null;
  return { scope, code, dow, date: null };
}

/** Build one slot-descriptor member. Throws on a scope/code the engine could
 * not parse — a malformed member does not fail loudly downstream, it silently
 * changes the linkage's meaning. */
export function linkageMember(scope: LinkageScope, code: LinkageCode): string {
  const trimmed = String(scope).trim();
  const isDate = ISO_DATE_RE.test(trimmed);
  const normScope = isDate ? trimmed : trimmed.toUpperCase();
  if (!isDate && !WEEKDAY_CODE_SET.has(normScope)) {
    throw new Error(`linkageMember: scope '${scope}' must be a weekday code (SUN..SAT) or an ISO date`);
  }
  const c = String(code).trim().toUpperCase();
  if (c !== 'ANY' && c !== 'C1' && c !== 'C2' && c !== 'NEURO') {
    throw new Error(`linkageMember: code '${code}' must be C1, C2, NEURO or ANY`);
  }
  return `${normScope}:${c}`;
}

export interface LinkageSlotRef {
  scope: LinkageScope;
  code: LinkageCode;
}

/**
 * "Take EITHER of these, not both" (Hussain: one Saturday C1 plus one call
 * that is either a Friday or a Sunday — his answer to which was "engine's
 * choice"). The engine enforces it as a group ceiling over every bucket the
 * members cover; the buckets themselves are zeroed by resolveTargets so the
 * ceiling lands on exactly one call.
 */
export function eitherOrLinkage(
  members: readonly LinkageSlotRef[],
  opts: { source: string; details?: string },
): Linkage {
  if (members.length < 2) {
    throw new Error('eitherOrLinkage: an either-or needs at least two members');
  }
  return {
    kind: 'either-or',
    members: members.map(m => linkageMember(m.scope, m.code)),
    ...(opts.details ? { details: opts.details } : {}),
    source: opts.source,
  };
}

/**
 * "These two split one 24h call 12/12" (Horan takes 12 daytime hours of a
 * Sunday C1; a partner takes the other 12). Members are PROVIDER DISPLAY
 * NAMES, self first — the only linkage kind whose members are not slot
 * descriptors. projectScenario keeps them as rawMembers with members: [], and
 * the split itself is executed with the split API + seeds (the engine then
 * respects the segment weights); the generation report carries the linkage.
 * The target side is ordinary arithmetic: a 12h segment is weight 0.5, so each
 * partner's bucket cell holds 0.5 of that call.
 */
export function splitTwelveHourLinkage(
  self: string,
  partners: readonly string[],
  opts: { source: string; details?: string },
): Linkage {
  const cleanSelf = self.trim();
  if (!cleanSelf) throw new Error('splitTwelveHourLinkage: self must be a provider display name');
  const others = partners.map(p => p.trim()).filter(p => p && p.toLowerCase() !== cleanSelf.toLowerCase());
  if (others.length === 0) {
    throw new Error('splitTwelveHourLinkage: name at least one partner other than self');
  }
  return {
    kind: 'split-12h',
    members: [cleanSelf, ...new Set(others)],
    ...(opts.details ? { details: opts.details } : {}),
    source: opts.source,
  };
}

// ── target resolution (derived + overrides + either-or) ──────────────────────

/** One row of the panel. `overrides` carries ONLY the cells he typed. */
export interface BlockTargetsProvider {
  /** A REAL provider id — projectScenario skips unmatched providers with a
   * warning, so a blank id silently drops every number on the row. */
  providerId: string;
  /** Display name, as it should appear in the manifest and in split-12h
   * linkage members. */
  displayName: string;
  /** Scenario FTE for THIS block (overrides the profile FTE for this
   * generation only — ProviderManifest.scenarioFte). */
  fte: number;
  overrides?: TargetOverrides;
  linkages?: Linkage[];
  prohibitions?: Prohibition[];
  fixedAssignments?: FixedAssignment[];
  preferences?: Preference[];
}

export interface ResolvedTargets {
  targets: BucketTargets;
  /** Cells he typed, in BUCKET_KEYS order. */
  overridden: BucketKey[];
  /** Cells the formula filled in. */
  derived: BucketKey[];
  /** Cells an either-or group owns (zeroed unless explicitly typed). */
  eitherOrCovered: BucketKey[];
  warnings: string[];
}

const WEEKDAY_DOW_TO_BUCKET = (dow: number): ScenarioBucket =>
  dow === 0 ? 'SUN' : dow === 6 ? 'SAT' : dow === 5 ? 'FRI' : 'MTH';

/** The manifest bucket keys one either-or linkage covers — the mirror of
 * providerCaps.eitherOrCoveredKeys in workbook-code space: an `ANY` member
 * spans C1 and C2, a NEURO member covers nothing (the group ceiling is about
 * primary call, never the separately-targeted neuro obligation), and a
 * date-scoped member covers its date's day-of-week bucket. */
function eitherOrCoveredKeys(linkage: Linkage): { keys: BucketKey[]; unparseable: string[] } {
  const keys = new Set<BucketKey>();
  const unparseable: string[] = [];
  for (const raw of linkage.members) {
    const m = parseLinkageMember(raw);
    if (!m) { unparseable.push(raw); continue; }
    const bucket = m.date != null ? scenarioBucketOf(m.date) : WEEKDAY_DOW_TO_BUCKET(m.dow!);
    const codes: string[] = m.code === 'ANY' ? ['C1', 'C2'] : [m.code];
    for (const c of codes) {
      if (c !== 'C1' && c !== 'C2') continue; // NEURO (and anything else) covers no bucket
      keys.add(`${bucket}_${c}` as BucketKey);
    }
  }
  return { keys: [...keys], unparseable };
}

/**
 * One row's FINAL numbers: derived everywhere, his typed values where he typed
 * them, and zero in every either-or-covered cell he did not type (see the
 * module header — a derived value there silently doubles the group ceiling).
 */
export function resolveTargets(
  provider: BlockTargetsProvider,
  basis: DerivationBasis,
): ResolvedTargets {
  const derivedAll = derivedTargetsFor(provider.fte, basis);
  const overrides = provider.overrides ?? {};
  const explicit = new Set<BucketKey>(
    BUCKET_KEYS.filter(k => typeof overrides[k] === 'number' && Number.isFinite(overrides[k])),
  );
  const targets = zeroBuckets();
  for (const k of BUCKET_KEYS) targets[k] = explicit.has(k) ? round6(overrides[k]!) : derivedAll[k];

  const warnings: string[] = [];
  const coveredAll = new Set<BucketKey>();
  for (const l of provider.linkages ?? []) {
    if (l.kind !== 'either-or') continue;
    const { keys, unparseable } = eitherOrCoveredKeys(l);
    for (const raw of unparseable) {
      warnings.push(
        `either-or linkage member '${raw}' is not a slot descriptor (WEEKDAY:CODE or YYYY-MM-DD:CODE) — `
        + `the engine will keep this linkage for reporting only`);
    }
    if (keys.length === 0) continue;
    for (const k of keys) {
      coveredAll.add(k);
      if (!explicit.has(k)) targets[k] = 0;
    }
    const sum = round6(keys.reduce((s, k) => s + targets[k], 0));
    if (sum > 1 + WEIGHT_EPSILON) {
      warnings.push(
        `either-or [${l.members.join(' | ')}] covers ${keys.join(', ')} totalling ${sum} — `
        + `the engine ceiling for the group will be ${Math.ceil(sum)}, so more than one of these calls can be placed`);
    }
  }

  const overridden = BUCKET_KEYS.filter(k => explicit.has(k));
  return {
    targets,
    overridden,
    derived: BUCKET_KEYS.filter(k => !explicit.has(k)),
    eitherOrCovered: BUCKET_KEYS.filter(k => coveredAll.has(k)),
    warnings,
  };
}

// ── the panel's derived-vs-overridden memory ─────────────────────────────────

export const BLOCK_TARGETS_PANEL_STATE_VERSION = 1 as const;

/**
 * The sidecar that lets the panel re-open without freezing formulas.
 *
 * It rides on the stored manifest under the `blockTargets` key. That is legal
 * and inert by construction: paoliBlockManifestSchema is a non-strict zod
 * object, so the key VALIDATES and is then STRIPPED from projectScenario's
 * parsed copy — the engine can never see it, and a manifest carrying it is
 * exactly as acceptable to the engine as one without. It survives in the DB
 * because the PATCH route writes the value verbatim (the patch37 storage
 * decision: scenario_manifest holds the artifact as authored).
 *
 * `overrides` stores KEYS ONLY. The numbers live once, in
 * providers[].targets.
 */
export interface BlockTargetsPanelState {
  version: typeof BLOCK_TARGETS_PANEL_STATE_VERSION;
  /** provider id -> the bucket cells he typed. Everything absent is blank =
   * derived, and re-derives against the CURRENT basis on every open. */
  overrides: Record<string, BucketKey[]>;
  /** What the derived column was computed from when this was saved. Display
   * and staleness only — never read by the engine, never used as truth: the
   * panel re-derives from the live slots/par/pattern each time it opens. */
  basis: {
    parLevel: number;
    slotCounts: BucketNumbers;
    neuro: NeuroWeekendConfig | null;
  };
  savedAt: string;
}

/** A manifest this module produced: the phase-1 contract plus the sidecar. */
export type BlockTargetsManifest = PaoliBlockManifest & { blockTargets: BlockTargetsPanelState };

/** `source.workbook` for a hand-entered manifest. A later reader (or a future
 * importer run) can tell panel-authored numbers from imported ones by this
 * string alone — it is the only provenance the artifact carries. */
export const BLOCK_TARGETS_SOURCE_WORKBOOK = 'block-targets-panel (hand-entered — no workbook)';

const BLOCK_TARGETS_CALL_CODE_LEGEND: Record<string, string> = {
  C1: 'first call (engine code via the scenario code map — C1)',
  C2: 'late/second call (engine code via the scenario code map — C2)',
  NEURO: 'Neuro F/S/S weekend call, counted in WEEKEND UNITS (engine code C3)',
};

export function isPanelAuthored(manifest: unknown): boolean {
  const src = (manifest as { source?: { workbook?: unknown } } | null)?.source?.workbook;
  return typeof src === 'string' && src.startsWith('block-targets-panel');
}

/** Defensive read of the sidecar off a raw jsonb value; null when absent or
 * malformed (an imported manifest, or one written before the panel existed —
 * the panel then treats every cell as derived, which is the safe default). */
export function readPanelState(manifest: unknown): BlockTargetsPanelState | null {
  const raw = (manifest as { blockTargets?: unknown } | null)?.blockTargets;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;
  if (s.version !== BLOCK_TARGETS_PANEL_STATE_VERSION) return null;
  const overridesRaw = s.overrides;
  if (!overridesRaw || typeof overridesRaw !== 'object' || Array.isArray(overridesRaw)) return null;
  const valid = new Set<string>(BUCKET_KEYS);
  const overrides: Record<string, BucketKey[]> = {};
  for (const [pid, keys] of Object.entries(overridesRaw as Record<string, unknown>)) {
    if (!Array.isArray(keys)) continue;
    const kept = keys.filter((k): k is BucketKey => typeof k === 'string' && valid.has(k));
    if (kept.length > 0) overrides[pid] = kept;
  }
  const basisRaw = (s.basis ?? {}) as Record<string, unknown>;
  const slotCountsRaw = (basisRaw.slotCounts ?? {}) as Record<string, unknown>;
  const slotCounts = zeroBuckets();
  for (const k of BUCKET_KEYS) {
    const v = slotCountsRaw[k];
    if (typeof v === 'number' && Number.isFinite(v)) slotCounts[k] = v;
  }
  return {
    version: BLOCK_TARGETS_PANEL_STATE_VERSION,
    overrides,
    basis: {
      parLevel: typeof basisRaw.parLevel === 'number' ? basisRaw.parLevel : 0,
      slotCounts,
      neuro: (basisRaw.neuro ?? null) as NeuroWeekendConfig | null,
    },
    savedAt: typeof s.savedAt === 'string' ? s.savedAt : '',
  };
}

/**
 * Re-open: a stored manifest back into panel rows. The typed cells come from
 * the sidecar (keys) plus providers[].targets (values); every other cell is
 * reported blank so it re-derives against the CURRENT basis. Without a sidecar
 * — an imported manifest — every stated number is treated as typed, because it
 * WAS: a workbook cell is an author's number, not a formula's.
 */
export function readPanelProviders(manifest: unknown): BlockTargetsProvider[] {
  const m = manifest as PaoliBlockManifest | null;
  if (!m || !Array.isArray(m.providers)) return [];
  const state = readPanelState(manifest);
  const validKeys = new Set<string>(BUCKET_KEYS);
  return m.providers.map(p => {
    const typed = state
      ? (state.overrides[p.providerId ?? ''] ?? [])
      : BUCKET_KEYS.filter(k => typeof p.targets?.[k] === 'number');
    const overrides: TargetOverrides = {};
    for (const k of typed) {
      if (!validKeys.has(k)) continue;
      const v = p.targets?.[k];
      if (typeof v === 'number' && Number.isFinite(v)) overrides[k] = v;
    }
    return {
      providerId: p.providerId ?? '',
      displayName: p.sourceName,
      fte: p.scenarioFte,
      overrides,
      linkages: p.linkages ?? [],
      prohibitions: p.prohibitions ?? [],
      fixedAssignments: p.fixedAssignments ?? [],
      preferences: p.preferences ?? [],
    };
  });
}

// ── who gets written ─────────────────────────────────────────────────────────

/**
 * Does this row STATE anything, or is it purely on the formula?
 *
 * Any one of an override, a linkage, a prohibition, a fixed assignment or a
 * preference makes a row stated. The last three never come from the panel's own
 * UI (it has no editor for them) but do ride through from an imported workbook,
 * and dropping them on save would be a silent clinical change — buildPanelRows
 * carries them precisely so they survive.
 *
 * Note an either-or row qualifies on its LINKAGE, which is what makes the zeros
 * resolveTargets writes into the covered buckets safe: those zeros are stated by
 * the linkage rather than typed, so `overrides` alone would not have seen them.
 */
export function statesSomething(p: BlockTargetsProvider): boolean {
  const overrides = p.overrides ?? {};
  if (BUCKET_KEYS.some(k => typeof overrides[k] === 'number' && Number.isFinite(overrides[k]))) {
    return true;
  }
  return (p.linkages?.length ?? 0) > 0
    || (p.prohibitions?.length ?? 0) > 0
    || (p.fixedAssignments?.length ?? 0) > 0
    || (p.preferences?.length ?? 0) > 0;
}

export interface StatedProviderSelection<T extends BlockTargetsProvider> {
  /** The rows buildBlockManifest will write, in the order given. */
  written: T[];
  /** Of those, the ones present ONLY because a split-12h linkage names them —
   * they state nothing of their own. Reported, never silent. */
  splitPartnersPulledIn: T[];
}

/**
 * The providers a manifest built from these rows will actually carry.
 *
 * THE single home of that decision — buildBlockManifest writes exactly this set
 * and the panel's footer counts exactly this set, so what he is told before
 * saving cannot disagree with what is saved. See the module header for why the
 * untouched rows are omitted rather than frozen at their formula numbers.
 */
export function statedProviders<T extends BlockTargetsProvider>(
  providers: readonly T[],
): StatedProviderSelection<T> {
  const stated = new Set<T>(providers.filter(statesSomething));

  // Back-fill split-12h partners named by an included row (module header).
  const namedByASplit = new Set<string>();
  for (const p of stated) {
    for (const l of p.linkages ?? []) {
      if (l.kind !== 'split-12h') continue;
      for (const member of l.members) namedByASplit.add(member.trim().toLowerCase());
    }
  }
  const splitPartnersPulledIn: T[] = [];
  if (namedByASplit.size > 0) {
    for (const p of providers) {
      if (stated.has(p)) continue;
      if (!namedByASplit.has(p.displayName.trim().toLowerCase())) continue;
      stated.add(p);
      splitPartnersPulledIn.push(p);
    }
  }

  return { written: providers.filter(p => stated.has(p)), splitPartnersPulledIn };
}

// ── manifest build ───────────────────────────────────────────────────────────

export interface BuildBlockManifestInput {
  providers: BlockTargetsProvider[];
  basis: DerivationBasis;
  /** Free-text block label recorded as `source.sheetName` (e.g. the schedule
   * name). Provenance only. */
  scheduleLabel?: string;
  /** Year bare dates in free text default to — the block's start year.
   * Defaults to the year of `generatedAt`. */
  defaultYear?: number;
  /** Injectable for deterministic tests; defaults to now. */
  generatedAt?: string;
}

/**
 * The full manifest, ready to PATCH into schedules.scenario_manifest. Every
 * required field of paoliBlockManifestSchema is present and typed; the
 * `targets` record carries all nine buckets (zod 4's `z.record(z.enum(...))`
 * demands exhaustiveness) with the FINAL absolute numbers the engine reads.
 *
 * ONLY the rows that state something are written (statedProviders — see the
 * module header). A provider absent from `providers[]` is not capped, not
 * steered and not mentioned: the engine gives them their ordinary FTE quota,
 * which steers but never blocks a fill. An input of purely-formula rows
 * therefore yields `providers: []`, which is schema-legal and steers nobody —
 * callers store NULL rather than that (targetWritePlan), because an empty
 * providers list reads back as "stored but unreadable".
 */
export function buildBlockManifest(input: BuildBlockManifestInput): BlockTargetsManifest {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const defaultYear = input.defaultYear ?? Number(generatedAt.slice(0, 4));
  const warnings: string[] = [];
  const errors: string[] = [];

  const overrideKeys: Record<string, BucketKey[]> = {};
  const checksumRows: ChecksumRow[] = [];
  const seenIds = new Set<string>();

  const selection = statedProviders(input.providers);

  const providers: ProviderManifest[] = selection.written.map(p => {
    const resolved = resolveTargets(p, input.basis);
    const name = p.displayName.trim() || p.providerId;
    const id = p.providerId.trim();
    if (!id) {
      errors.push(
        `${name}: no provider id — the engine skips unmatched manifest providers, so every number on this row would be ignored`);
    } else if (seenIds.has(id)) {
      errors.push(`${name}: duplicate provider id ${id} — only one row per provider can steer the engine`);
    }
    if (id) seenIds.add(id);
    if (resolved.overridden.length > 0) overrideKeys[id] = resolved.overridden;
    checksumRows.push({ fte: p.fte, targets: resolved.targets });
    return {
      providerId: id || null,
      sourceName: name,
      normalizedName: normalizeName(name),
      scenarioFte: p.fte,
      targets: resolved.targets,
      prohibitions: p.prohibitions ?? [],
      fixedAssignments: p.fixedAssignments ?? [],
      linkages: p.linkages ?? [],
      preferences: p.preferences ?? [],
      sourceText: { noCall: null, mandatory: null },
      warnings: resolved.warnings,
      conflicts: [],
    };
  });

  warnings.push(
    `Entered by hand in the Block Targets panel — no workbook, so there are no expected checksums to compare `
    + `(the computed totals below are the panel's own).`,
    `Blank cells were derived: non-neuro buckets = bucket slots ÷ par ${input.basis.parLevel} × FTE; `
    + `NEURO_FSS = the site pattern's neuro weekend requirement bands.`);
  // Stated UNCONDITIONALLY and WITHOUT a count of who was left out. The number
  // omitted is a fact about one panel session, not about the constraint set —
  // recording it would also break the save → reopen → save fixed point, because
  // reopening a manifest hands back only the providers it names.
  warnings.push(
    `Only the providers with something stated are in this manifest. Everyone else on the panel is `
    + `deliberately ABSENT and keeps their ordinary FTE targets, which steer but never cap. That is the `
    + `point: a stated target is a HARD ceiling, and freezing an untouched provider at their formula `
    + `number would block fills nobody asked to block.`);
  for (const p of selection.splitPartnersPulledIn) {
    warnings.push(
      `${p.displayName.trim() || p.providerId}: stated nothing, but a 12-hour split names them as the partner — `
      + `included so the linkage does not name a provider this manifest never mentions. Their targets are all `
      + `derived, so this DOES cap them; clear the split if that is not intended.`);
  }

  return {
    manifestVersion: PAOLI_BLOCK_MANIFEST_VERSION,
    generatedAt,
    source: {
      workbook: BLOCK_TARGETS_SOURCE_WORKBOOK,
      sheetName: input.scheduleLabel?.trim() || '(no sheet — panel entry)',
      // 'full' = every bucket column is stated, which a panel row always is.
      shape: 'full',
    },
    defaultYear,
    callCodeLegend: BLOCK_TARGETS_CALL_CODE_LEGEND,
    checksums: compareChecksums(computeChecksums(checksumRows), null),
    providers,
    warnings,
    errors,
    blockTargets: {
      version: BLOCK_TARGETS_PANEL_STATE_VERSION,
      overrides: overrideKeys,
      basis: {
        parLevel: input.basis.parLevel,
        slotCounts: { ...input.basis.slotCounts },
        neuro: input.basis.neuro,
      },
      savedAt: generatedAt,
    },
  };
}

// ── feasibility ──────────────────────────────────────────────────────────────

export type FeasibilityStatus = 'over' | 'exact' | 'under';

export interface FeasibilityRow {
  bucket: BucketKey;
  /** Capacity: weighted slots (weekend UNITS for NEURO_FSS). */
  slots: number;
  /** Σ of the targets handed in for this bucket — for the panel's strip that is
   * the WHOLE roster's resolved demand, stated and derived alike. */
  stated: number;
  /** stated − slots. Positive = over-constrained. */
  delta: number;
  status: FeasibilityStatus;
  /** The ONLY status that is a problem — see checkFeasibility. */
  overConstrained: boolean;
}

/**
 * Per-bucket sanity of a block.
 *
 *   over  — the targets ask for MORE calls than the block contains. Something
 *           has to give: the scenario ceilings are hard, so slots go unfilled
 *           or providers sit capped. This is the row worth flagging.
 *   under — the targets leave slots over. NORMAL AND EXPECTED here, never an
 *           error: par is authoritative (2026-07-24) and when the pool's ΣFTE
 *           is below the par the obligations deliberately under-cover the
 *           block — the remainder is the paid-pickup layer, taken after the
 *           schedule is built.
 *
 * WHAT TO SUM, NOW THAT ONLY STATED PROVIDERS ARE WRITTEN (2026-07-27). The
 * panel's strip hands in every ROW's RESOLVED targets — the whole roster,
 * derived where he typed nothing — NOT the manifest's stated slice. That is
 * deliberate. The question the strip answers is "will this block hold what the
 * roster is going to ask of it", and an omitted provider still asks: the engine
 * gives them their ordinary FTE quota target, which is numerically the same
 * formula `derivedTargetsFor` uses. Summing only the four written rows would
 * answer a question nobody asked, drop every bucket far under, and turn the
 * whole strip into noise that says "we only wrote four people" in nine
 * different colours. Over-constraint is also still detected correctly this way:
 * the stated rows are the only ones that can exceed their formula share, so
 * they are exactly what pushes a bucket over.
 *
 * WEIGHT_EPSILON absorbs stored-fraction noise so three 0.3333 thirds never
 * read as over a whole call.
 */
export function checkFeasibility(
  statedTargets: ReadonlyArray<BucketTargets>,
  slotCounts: BucketNumbers,
): FeasibilityRow[] {
  return BUCKET_KEYS.map(bucket => {
    const stated = round6(statedTargets.reduce((s, t) => s + (t[bucket] ?? 0), 0));
    const slots = round6(slotCounts[bucket] ?? 0);
    const delta = round6(stated - slots);
    const status: FeasibilityStatus =
      delta > WEIGHT_EPSILON ? 'over' : delta < -WEIGHT_EPSILON ? 'under' : 'exact';
    return { bucket, slots, stated, delta, status, overConstrained: status === 'over' };
  });
}

/**
 * Feasibility of the manifest's STATED SLICE alone.
 *
 * NOT what the panel's strip shows, and not interchangeable with it: since
 * 2026-07-27 a manifest carries only the providers he stated, so this sums four
 * people where the strip sums ten. Use it to ask "do the stated constraints
 * alone already over-fill a bucket" — an `over` here is a real defect in what
 * was written. An `under` here is close to meaningless, because the providers
 * that would have filled the rest are simply not in the artifact.
 */
export function checkManifestFeasibility(
  manifest: Pick<PaoliBlockManifest, 'providers'>,
  slotCounts: BucketNumbers,
): FeasibilityRow[] {
  return checkFeasibility(
    manifest.providers.map(p => {
      const t = zeroBuckets();
      for (const k of BUCKET_KEYS) {
        const v = p.targets?.[k];
        if (typeof v === 'number' && Number.isFinite(v)) t[k] = v;
      }
      return t;
    }),
    slotCounts,
  );
}
