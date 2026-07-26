// Scenario layer (Paoli 8/10–10/25 block, phase 2 — 2026-07-26).
//
// A SCENARIO is a per-schedule constraint manifest (the phase-1 Paoli block
// import artifact) that reshapes ONE generation without touching master data:
//   • per-bucket call targets become HARD per-provider ceilings + the
//     fairness/steering targets (least-variance objective),
//   • prohibitions (date-specific per-code, date-specific all-call, recurring
//     weekday+code) become eligibility gates,
//   • linkages (same-weekend / same-date / either-or / split-12h) become
//     placement-time constraints per their hardness,
//   • scenarioFte overrides the provider's FTE for THIS generation only,
//   • preferences are soft (scoring tiebreak + the spacing score's last key).
//
// STORAGE DECISION (patch37): scheduling.schedules.scenario_manifest holds the
// FULL validated phase-1 manifest VERBATIM (paoliBlockManifestSchema) — not a
// trimmed projection. The manifest is the audit source of truth (source text,
// parser warnings, conflicts); trimming it in the DB would fork that truth.
// The engine-facing projection below is computed at load time (genContext) and
// versioned in code, so projection fixes never require re-importing.
//
// No manifest ⇒ ctx.scenario stays absent ⇒ the engine is byte-identical to
// the pre-scenario code (pinned by the fill-mode golden plans + goldenParity).
import { dayOfWeekUTC, addDays } from './shared';
import { paoliBlockManifestSchema } from '@/lib/paoliBlock/manifest';
import type { PaoliBlockManifest, ProviderManifest } from '@/lib/paoliBlock/manifest';

// ── workbook buckets (DAY-OF-WEEK scoped, deliberately NOT dayTypeBucket) ────
// The workbook's targets are day-of-week columns ("Monday–Thursday C1"), so a
// Monday major holiday (Labor Day 2026-09-07) belongs to MTH here even though
// the engine's fairness bucket for that slot is 'holiday'. Scenario caps and
// variance use these dow buckets exactly; the engine's own quota steering
// (ctx.bucketTarget) keeps its day-type buckets — see genContext.
export const SCENARIO_BUCKETS = ['MTH', 'FRI', 'SAT', 'SUN'] as const;
export type ScenarioBucket = (typeof SCENARIO_BUCKETS)[number];
export const NEURO_KEY = 'NEURO_FSS';

export function scenarioBucketOf(date: string): ScenarioBucket {
  const dow = dayOfWeekUTC(date); // 0=Sun..6=Sat
  if (dow === 0) return 'SUN';
  if (dow === 6) return 'SAT';
  if (dow === 5) return 'FRI';
  return 'MTH';
}

// The Saturday anchoring the Fri–Sun window containing `date`; null when the
// date is Mon–Thu (no weekend membership). Single home for "same weekend".
export function weekendAnchorOf(date: string): string | null {
  const dow = dayOfWeekUTC(date);
  if (dow === 5) return addDays(date, 1);
  if (dow === 6) return date;
  if (dow === 0) return addDays(date, -1);
  return null;
}

// ── engine-facing shapes ─────────────────────────────────────────────────────

// A linkage/preference member: weekday-scoped (FRI:C1), date-scoped
// (2026-09-05:C2), with 'ANY' matching any non-neuro call code (either-or —
// the provider's separately-targeted neuro obligation is NOT what "one
// Saturday or one Sunday call" spends).
export interface ScenarioMember {
  dow: number | null;    // 0=Sun..6=Sat
  date: string | null;   // ISO date for date-scoped members
  code: string;          // ENGINE code, or 'ANY'
}

export interface ScenarioLinkage {
  kind: 'same-weekend' | 'same-date' | 'split-12h' | 'either-or';
  members: ScenarioMember[];   // empty for split-12h (members are provider names)
  rawMembers: string[];
  source: string;
}

export interface ScenarioPreference {
  kind: 'weekday' | 'same-weekend' | 'other';
  weekday: number | null;      // 0=Sun..6=Sat
  codes: string[];             // engine codes ([] = any)
  members: ScenarioMember[];
  source: string;
}

export interface ScenarioProvider {
  provider_id: string;
  sourceName: string;
  scenarioFte: number;
  // `${bucket}|${code}` (MTH|C1 … SUN|C2) -> EXACT fractional target. The
  // placement ceiling is ceil(target) (whole placements are indivisible);
  // variance reporting stays exact-fractional — a 0.5 target is satisfiable
  // by a 12h split segment (weight 0.5) or stays partially open, never
  // rounded.
  targets: Map<string, number>;
  // NEURO F/S/S target in UNITS: one unit = one weekend (Fri–Sun window)
  // containing ≥1 neuro-code call — the Sat+Sun chain pair (or the Hussain
  // F/S/S triple) counts ONE, matching "exactly one Saturday/Sunday pair".
  neuroTarget: number | null;
  prohibitedAllDates: Set<string>;
  prohibitedDatesByCode: Map<string, Set<string>>; // engine code -> dates
  prohibitedAllDows: Set<number>;
  prohibitedDowsByCode: Map<string, Set<number>>;  // engine code -> dows
  linkages: ScenarioLinkage[];
  preferences: ScenarioPreference[];
  // Prohibition-vs-mandatory conflicts the import already resolved
  // mandatory-retained — validation soft-flags matching assignments.
  mandatoryRetained: Array<{ date: string; code: string | 'all' }>;
  // Engine-code fixed assignments (phase 3 seeds these; the report checks them).
  fixedAssignments: Array<{ date: string; code: string }>;
}

export interface ScenarioDoc {
  neuroCode: string;                       // engine code NEURO maps to (C3)
  codeMap: Record<string, string>;         // workbook -> engine codes
  providers: Map<string, ScenarioProvider>;
}

export const DEFAULT_SCENARIO_CODE_MAP: Record<string, string> = {
  C1: 'C1', C2: 'C2', NEURO: 'C3',
};

// ── lookups ──────────────────────────────────────────────────────────────────

// Is (date, engineCode) prohibited for this provider? Call-category placements
// only — the caller scopes that. Recurring prohibitions match by TRUE day of
// week (the import already derived weekdays from dates; this is the engine
// half of the same rule).
export function scenarioProhibits(sp: ScenarioProvider, date: string, code: string): boolean {
  if (sp.prohibitedAllDates.has(date)) return true;
  if (sp.prohibitedDatesByCode.get(code)?.has(date)) return true;
  const dow = dayOfWeekUTC(date);
  if (sp.prohibitedAllDows.has(dow)) return true;
  if (sp.prohibitedDowsByCode.get(code)?.has(dow)) return true;
  return false;
}

// Does a member match a realized/prospective (date, engineCode) placement?
// 'ANY' matches any call code EXCEPT the neuro code (see ScenarioMember).
export function memberMatches(
  m: ScenarioMember, date: string, code: string, neuroCode: string,
): boolean {
  if (m.date != null && m.date !== date) return false;
  if (m.dow != null && dayOfWeekUTC(date) !== m.dow) return false;
  if (m.code === 'ANY') return code !== neuroCode;
  return m.code === code;
}

// ── realized-call ledger helpers ─────────────────────────────────────────────
// The ledger is one provider's realized CALL codes by date (SolveState's
// callCodesByDate entry — seeds + every placement so far, segments recorded
// under their parent code). All linkage decisions read it through these.
export type RealizedCallLedger = ReadonlyMap<string, ReadonlySet<string>>;

export function memberRealizedOnDate(
  led: RealizedCallLedger | undefined, m: ScenarioMember, date: string, neuroCode: string,
): boolean {
  const codes = led?.get(date);
  if (!codes) return false;
  for (const c of codes) if (memberMatches(m, date, c, neuroCode)) return true;
  return false;
}

export function memberRealizedInWeekend(
  led: RealizedCallLedger | undefined, m: ScenarioMember, weekendAnchor: string, neuroCode: string,
): boolean {
  for (const d of [addDays(weekendAnchor, -1), weekendAnchor, addDays(weekendAnchor, 1)]) {
    if (memberRealizedOnDate(led, m, d, neuroCode)) return true;
  }
  return false;
}

export function memberRealizedAnywhere(
  led: RealizedCallLedger | undefined, m: ScenarioMember, neuroCode: string,
): boolean {
  if (!led) return false;
  for (const d of led.keys()) {
    if (memberRealizedOnDate(led, m, d, neuroCode)) return true;
  }
  return false;
}

// HARD linkage gate (2026-07-26): would placing (date, code) for this
// provider break a hard same-weekend / same-date linkage? Violated when the
// placement matches a member while ANOTHER member is already realized (plan
// or seed) and none of that member's realizations sit in this placement's
// weekend (same-weekend) / on this date (same-date). Unrealized companions
// never gate — the pairing can still complete later; the report carries the
// final satisfaction verdict either way.
export function violatesHardLinkage(
  sp: ScenarioProvider, date: string, code: string,
  led: RealizedCallLedger | undefined, neuroCode: string,
): boolean {
  for (const l of sp.linkages) {
    if (l.members.length === 0) continue;
    if (l.kind !== 'same-weekend' && l.kind !== 'same-date') continue;
    if (!l.members.some(m => memberMatches(m, date, code, neuroCode))) continue;
    for (const other of l.members) {
      if (memberMatches(other, date, code, neuroCode)) continue; // the member being placed
      if (!memberRealizedAnywhere(led, other, neuroCode)) continue;
      if (l.kind === 'same-date') {
        if (!memberRealizedOnDate(led, other, date, neuroCode)) return true;
      } else {
        const wk = weekendAnchorOf(date);
        if (wk == null || !memberRealizedInWeekend(led, other, wk, neuroCode)) return true;
      }
    }
  }
  return false;
}

export function scenarioHasCaps(doc: ScenarioDoc): boolean {
  for (const sp of doc.providers.values()) {
    if (sp.targets.size > 0 || sp.neuroTarget != null) return true;
  }
  return false;
}

// ── engine bucket-target override ────────────────────────────────────────────
// Replace the FTE-derived fairness quota targets for manifest providers with
// the STATED scenario numbers (least-variance steering): scenario dow buckets
// map onto the engine's day-type buckets (MTH→weekday, FRI→friday, …) and the
// NEURO unit target steers each weekend C3 bucket. Values are EXACT — never
// floored (floorBucketTargets ran first; a stated 0 must stay 0, and the
// scenario HARD ceilings guarantee the quota can never admit past them
// anyway). Holiday-bucket targets stay FTE-derived: the engine buckets pool
// holidays separately, while the scenario's dow-bucket CAPS still bound any
// holiday-dated placement (a Monday holiday charges MTH).
const SCENARIO_TO_ENGINE_BUCKET: Record<ScenarioBucket, string> = {
  MTH: 'weekday', FRI: 'friday', SAT: 'saturday', SUN: 'sunday',
};

export function applyScenarioBucketTargets(
  targets: Map<string, number>, scenario: ScenarioDoc,
): Map<string, number> {
  const out = new Map(targets);
  for (const sp of scenario.providers.values()) {
    for (const [key, target] of sp.targets) {
      const sep = key.indexOf('|');
      const engineBucket = SCENARIO_TO_ENGINE_BUCKET[key.slice(0, sep) as ScenarioBucket];
      if (!engineBucket) continue;
      out.set(`${sp.provider_id}|${engineBucket}|${key.slice(sep + 1)}`, target);
    }
    if (sp.neuroTarget != null) {
      for (const eb of ['friday', 'saturday', 'sunday']) {
        out.set(`${sp.provider_id}|${eb}|${scenario.neuroCode}`, sp.neuroTarget);
      }
    }
  }
  return out;
}

// ── projection ───────────────────────────────────────────────────────────────

const WEEKDAY_TO_DOW: Record<string, number> = {
  SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6,
};

// Manifest bucket key -> scenario bucket + workbook code (NEURO_FSS handled
// separately as the unit target).
const BUCKET_KEY_MAP: Record<string, { bucket: ScenarioBucket; code: string }> = {
  MTH_C1: { bucket: 'MTH', code: 'C1' }, MTH_C2: { bucket: 'MTH', code: 'C2' },
  FRI_C1: { bucket: 'FRI', code: 'C1' }, FRI_C2: { bucket: 'FRI', code: 'C2' },
  SAT_C1: { bucket: 'SAT', code: 'C1' }, SAT_C2: { bucket: 'SAT', code: 'C2' },
  SUN_C1: { bucket: 'SUN', code: 'C1' }, SUN_C2: { bucket: 'SUN', code: 'C2' },
};

function parseMember(raw: string, codeMap: Record<string, string>): ScenarioMember | null {
  const idx = raw.lastIndexOf(':');
  if (idx < 0) return null;
  const scope = raw.slice(0, idx);
  const rawCode = raw.slice(idx + 1);
  const code = rawCode === 'ANY' ? 'ANY' : (codeMap[rawCode] ?? rawCode);
  if (/^\d{4}-\d{2}-\d{2}$/.test(scope)) return { dow: null, date: scope, code };
  const dow = WEEKDAY_TO_DOW[scope];
  if (dow === undefined) return null;
  return { dow, date: null, code };
}

export interface ProjectScenarioOptions {
  codeMap?: Record<string, string>;
  // Provider pool (generation candidates). Manifest providers outside it are
  // skipped LOUDLY — their targets can't steer anyone.
  knownProviderIds?: ReadonlySet<string>;
  // Site shift codes; a mapped engine code missing here draws a warning (the
  // cap/gate on a nonexistent code is inert, never silent).
  knownShiftCodes?: ReadonlySet<string>;
}

// Manifest (jsonb, unknown) -> engine ScenarioDoc. NEVER throws: an invalid
// manifest degrades to { scenario: null } with a loud warning (the generation
// then runs scenario-free — stated, never silent).
export function projectScenario(
  raw: unknown,
  opts: ProjectScenarioOptions,
): { scenario: ScenarioDoc | null; warnings: string[] } {
  const warnings: string[] = [];
  const parsed = paoliBlockManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    warnings.push(
      `Scenario manifest failed validation — generating WITHOUT the scenario: `
      + `${first ? `${first.path.join('.') || '(root)'}: ${first.message}` : 'unknown error'}`);
    return { scenario: null, warnings };
  }
  const manifest: PaoliBlockManifest = parsed.data;
  const codeMap = opts.codeMap ?? DEFAULT_SCENARIO_CODE_MAP;
  const neuroCode = codeMap['NEURO'] ?? 'C3';

  // Cross-check mapped engine codes against the site's shift codes.
  if (opts.knownShiftCodes) {
    for (const [wb, engine] of Object.entries(codeMap)) {
      if (!opts.knownShiftCodes.has(engine)) {
        warnings.push(`Scenario code map: workbook ${wb} maps to '${engine}' which is not a shift code at this site — its caps/gates are inert`);
      }
    }
  }

  const providers = new Map<string, ScenarioProvider>();
  for (const pm of manifest.providers) {
    const sp = projectProvider(pm, codeMap, opts, warnings);
    if (sp) providers.set(sp.provider_id, sp);
  }
  return { scenario: { neuroCode, codeMap, providers }, warnings };
}

function projectProvider(
  pm: ProviderManifest,
  codeMap: Record<string, string>,
  opts: ProjectScenarioOptions,
  warnings: string[],
): ScenarioProvider | null {
  const name = pm.sourceName.trim();
  if (!pm.providerId) {
    warnings.push(`Scenario provider "${name}" is unmatched (no provider id) — skipped`);
    return null;
  }
  if (opts.knownProviderIds && !opts.knownProviderIds.has(pm.providerId)) {
    warnings.push(`Scenario provider "${name}" (${pm.providerId}) is not in the generation pool — skipped`);
    return null;
  }
  const mapCode = (wb: string) => codeMap[wb] ?? wb;

  const targets = new Map<string, number>();
  let neuroTarget: number | null = null;
  for (const [key, value] of Object.entries(pm.targets)) {
    if (typeof value !== 'number') continue;
    if (key === NEURO_KEY) { neuroTarget = value; continue; }
    const mapped = BUCKET_KEY_MAP[key];
    if (!mapped) {
      warnings.push(`Scenario provider "${name}": unknown target bucket '${key}' — ignored`);
      continue;
    }
    targets.set(`${mapped.bucket}|${mapCode(mapped.code)}`, value);
  }

  const prohibitedAllDates = new Set<string>();
  const prohibitedDatesByCode = new Map<string, Set<string>>();
  const prohibitedAllDows = new Set<number>();
  const prohibitedDowsByCode = new Map<string, Set<number>>();
  for (const proh of pm.prohibitions) {
    const codes = proh.callCodes === 'all' ? 'all' : proh.callCodes.map(mapCode);
    if (proh.dates) {
      for (const d of proh.dates) {
        if (codes === 'all') prohibitedAllDates.add(d);
        else for (const c of codes) {
          if (!prohibitedDatesByCode.has(c)) prohibitedDatesByCode.set(c, new Set());
          prohibitedDatesByCode.get(c)!.add(d);
        }
      }
    }
    if (proh.recurrence) {
      const dow = WEEKDAY_TO_DOW[proh.recurrence.weekday];
      if (dow === undefined) continue;
      if (codes === 'all') prohibitedAllDows.add(dow);
      else for (const c of codes) {
        if (!prohibitedDowsByCode.has(c)) prohibitedDowsByCode.set(c, new Set());
        prohibitedDowsByCode.get(c)!.add(dow);
      }
    }
  }

  const linkages: ScenarioLinkage[] = [];
  for (const l of pm.linkages) {
    if (l.kind === 'split-12h') {
      // Members are provider display names — executed via the split API +
      // seeds in phase 3; the engine respects seeded segments through the
      // weight machinery, and the report carries this linkage as detail.
      linkages.push({ kind: l.kind, members: [], rawMembers: l.members, source: l.source });
      continue;
    }
    const members: ScenarioMember[] = [];
    let ok = true;
    for (const rawM of l.members) {
      const m = parseMember(rawM, codeMap);
      if (!m) {
        warnings.push(`Scenario provider "${name}": unparseable linkage member '${rawM}' — linkage kept for reporting only`);
        ok = false;
        break;
      }
      members.push(m);
    }
    linkages.push({ kind: l.kind, members: ok ? members : [], rawMembers: l.members, source: l.source });
  }

  const preferences: ScenarioPreference[] = [];
  for (const pref of pm.preferences) {
    const members: ScenarioMember[] = [];
    for (const rawM of pref.members ?? []) {
      const m = parseMember(rawM, codeMap);
      if (m) members.push(m);
    }
    preferences.push({
      kind: pref.kind,
      weekday: pref.weekday != null ? (WEEKDAY_TO_DOW[pref.weekday] ?? null) : null,
      codes: (pref.callCodes ?? []).map(mapCode),
      members,
      source: pref.source,
    });
  }

  return {
    provider_id: pm.providerId,
    sourceName: name,
    scenarioFte: pm.scenarioFte,
    targets,
    neuroTarget,
    prohibitedAllDates,
    prohibitedDatesByCode,
    prohibitedAllDows,
    prohibitedDowsByCode,
    linkages,
    preferences,
    mandatoryRetained: pm.conflicts.map(c => ({
      date: c.date, code: c.code === 'all' ? 'all' : mapCode(c.code),
    })),
    fixedAssignments: pm.fixedAssignments.map(f => ({ date: f.date, code: mapCode(f.code) })),
  };
}
