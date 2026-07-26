// Per-provider, per-code CALL caps (2026-07-22, patch34 provider_limits) —
// pure helpers shared by solve (admission + tally), optimize (trial
// acceptance) and autoGenerate (the result cap summary), so the counting rule
// can never drift: a provider's count for a code = their call-category
// placements of that code in the plan PLUS their call seeds of that code
// (seeded/manual assignments consume the cap; the obligation-cap precedent).
//
// Caps are HARD CEILINGS for auto-generation only — manual/assistant edits
// bypass them (same seam as the FTE workdays cap). A slot unfillable under
// caps stays OPEN and is reported with reason 'provider-cap' — never silently
// reassigned past a stated maximum, never silently dropped.

import type { ProviderLimits } from '@/lib/providerLimits';
import { WEIGHT_EPSILON, callBurdenWeight, parentCallCodeOf } from '@/lib/callBurden';
import { scenarioBucketOf, weekendAnchorOf, memberMatches, NEURO_KEY } from './scenario';
import type { ScenarioDoc, ScenarioProvider } from './scenario';
import type { GenerationContext, SolutionPlan, SeedAssignment, ShiftTypeInfo } from './genTypes';

// pid -> CAP KEY -> stated max. Cap keys were per-CODE only until 2026-07-26;
// the scenario layer generalizes the SAME machinery to richer keys — one
// vocabulary, one tally, one admission rule:
//   'C1'            — per-code cap (provider_limits), the original vocabulary
//   'S:MTH|C1'      — scenario per-(dow-bucket,code) ceiling = ceil(target)
//   'S:NEURO'       — scenario NEURO F/S/S ceiling in WEEKEND UNITS (a Sat+Sun
//                     chain pair — or a Hussain F/S/S triple — is ONE unit)
//   'S:EO#i'        — scenario either-or group cap (i = linkage index): the
//                     member (bucket,code) keys are FOLDED into this group
//                     (their individual zeros deliberately don't bind — "one
//                     Saturday or one Sunday call" is the group's discipline)
// A tally key is always `${pid}|${capKey}`; chargeKeysFor (below) is the one
// home mapping a placement to the keys it consumes.
export type CallCaps = Map<string, Map<string, number>>;

// Build the cap lookup from stored limits. Entries without a `calls` object
// are inert here (their workingDays/daysOff live in the workday budget), and
// a limits map with NO call caps at all returns null so every cap branch in
// the engine stays byte-identical to the pre-limits code (blank-fallback pin).
export function buildCallCaps(limits: ProviderLimits | undefined): CallCaps | null {
  if (!limits) return null;
  const caps: CallCaps = new Map();
  for (const [pid, entry] of Object.entries(limits)) {
    const calls = entry?.calls;
    if (!calls) continue;
    const byCode = new Map<string, number>();
    for (const [code, n] of Object.entries(calls)) {
      if (typeof n === 'number' && Number.isInteger(n) && n >= 0) byCode.set(code, n);
    }
    if (byCode.size > 0) caps.set(pid, byCode);
  }
  return caps.size > 0 ? caps : null;
}

// ── scenario cap building (2026-07-26) ──────────────────────────────────────

// Non-neuro engine call codes an 'ANY' either-or member spans: the code map's
// values minus the neuro code (the provider's separately-targeted neuro
// obligation is not what "one Saturday or one Sunday call" spends).
function anyCodesOf(scenario: ScenarioDoc): string[] {
  return [...new Set(Object.values(scenario.codeMap))]
    .filter(c => c !== scenario.neuroCode).sort();
}

// The scenario bucket keys an either-or linkage member covers (e.g. SAT:ANY →
// SAT|C1, SAT|C2). Date-scoped members cover their date's bucket.
function eitherOrCoveredKeys(scenario: ScenarioDoc, sp: ScenarioProvider): Map<number, Set<string>> {
  const out = new Map<number, Set<string>>();
  sp.linkages.forEach((l, i) => {
    if (l.kind !== 'either-or' || l.members.length === 0) return;
    const keys = new Set<string>();
    for (const m of l.members) {
      const bucket = m.date != null ? scenarioBucketOf(m.date)
        : m.dow === 0 ? 'SUN' : m.dow === 6 ? 'SAT' : m.dow === 5 ? 'FRI' : 'MTH';
      const codes = m.code === 'ANY' ? anyCodesOf(scenario) : [m.code];
      for (const c of codes) if (c !== scenario.neuroCode) keys.add(`${bucket}|${c}`);
    }
    if (keys.size > 0) out.set(i, keys);
  });
  return out;
}

// Scenario targets -> hard placement ceilings in the shared CallCaps
// vocabulary. Placement ceiling = ceil(target) — whole placements are
// indivisible, so a 0.5 target admits at most one whole call (or stays
// half-open for a split segment); variance reporting stays exact-fractional
// (spacingScore/scenarioReport). Bucket keys covered by an either-or member
// fold into that group's cap (max(1, ceil(Σ covered targets))) instead of
// binding individually. Null when the scenario states no targets at all.
export function buildScenarioCallCaps(scenario: ScenarioDoc | null | undefined): CallCaps | null {
  if (!scenario) return null;
  const caps: CallCaps = new Map();
  for (const sp of scenario.providers.values()) {
    const byKey = new Map<string, number>();
    const covered = eitherOrCoveredKeys(scenario, sp);
    const coveredAll = new Set<string>();
    for (const keys of covered.values()) for (const k of keys) coveredAll.add(k);
    for (const [key, target] of sp.targets) {
      if (coveredAll.has(key)) continue; // folded into the either-or group below
      byKey.set(`S:${key}`, Math.ceil(target));
    }
    for (const [i, keys] of covered) {
      let sum = 0;
      for (const k of keys) sum += sp.targets.get(k) ?? 0;
      byKey.set(`S:EO#${i}`, Math.max(1, Math.ceil(sum)));
    }
    if (sp.neuroTarget != null) byKey.set(`S:${NEURO_KEY}`, Math.ceil(sp.neuroTarget));
    if (byKey.size > 0) caps.set(sp.provider_id, byKey);
  }
  return caps.size > 0 ? caps : null;
}

// Union of two cap maps (both apply — the key spaces are disjoint: bare codes
// vs 'S:'-prefixed scenario keys). Null when both are null.
export function mergeCallCaps(a: CallCaps | null, b: CallCaps | null): CallCaps | null {
  if (!a) return b;
  if (!b) return a;
  const out: CallCaps = new Map();
  for (const [pid, byKey] of a) out.set(pid, new Map(byKey));
  for (const [pid, byKey] of b) {
    const dst = out.get(pid) ?? new Map<string, number>();
    for (const [k, v] of byKey) dst.set(k, v);
    out.set(pid, dst);
  }
  return out;
}

// Merged caps for a context: provider_limits per-code caps + scenario
// ceilings. The single builder solve() and optimize() share.
export function mergedCallCapsForCtx(ctx: GenerationContext): CallCaps | null {
  return mergeCallCaps(buildCallCaps(ctx.providerLimits), buildScenarioCallCaps(ctx.scenario));
}

// SCENARIO charge keys for one call placement (excluding the neuro unit,
// whose charge is stateful — weekend-distinct — and computed by the callers):
// the (dow-bucket, parent code) key plus every matching either-or group key.
// Weighted: a 0.5 segment charges 0.5 toward its bucket AND toward the group.
export function scenarioChargeKeys(
  scenario: ScenarioDoc, pid: string, date: string, parentCode: string,
): string[] {
  const sp = scenario.providers.get(pid);
  if (!sp) return [];
  const keys: string[] = [];
  if (parentCode !== scenario.neuroCode) {
    keys.push(`S:${scenarioBucketOf(date)}|${parentCode}`);
  }
  sp.linkages.forEach((l, i) => {
    if (l.kind !== 'either-or' || l.members.length === 0) return;
    if (l.members.some(m => memberMatches(m, date, parentCode, scenario.neuroCode))) {
      keys.push(`S:EO#${i}`);
    }
  });
  return keys;
}

// `${pid}|${capKey}` -> WEIGHTED usage of call-category placements (plan +
// seeds). Per-code keys: segment rows fold under their PARENT code at their
// fractional call_burden_weight — a C1N12 seed is 0.5 of C1 against a stated
// C1 cap (2026-07-22 call splits). Absent shiftTypes (bare fixtures,
// pre-patch35): weight 1 / own code, the pre-split tally byte for byte.
// With `scenario` (2026-07-26): ALSO emits the scenario keys — bucket/either-
// or charges per placement, and 'S:NEURO' as DISTINCT-WEEKEND units.
export function tallyCallsByPidCode(
  assignments: SolutionPlan['assignments'],
  seeds: ReadonlyArray<SeedAssignment>,
  shiftTypes?: Map<string, ShiftTypeInfo>,
  scenario?: ScenarioDoc | null,
): Map<string, number> {
  const tally = new Map<string, number>();
  const neuroWeekends = new Set<string>(); // `${pid}|${weekendAnchor}`
  const inc = (pid: string, code: string, date: string) => {
    const info = shiftTypes?.get(code);
    const parent = parentCallCodeOf(code, info);
    const weight = callBurdenWeight(info);
    const k = `${pid}|${parent}`;
    tally.set(k, (tally.get(k) || 0) + weight);
    if (scenario && scenario.providers.has(pid)) {
      for (const sk of scenarioChargeKeys(scenario, pid, date, parent)) {
        const key = `${pid}|${sk}`;
        tally.set(key, (tally.get(key) || 0) + weight);
      }
      if (parent === scenario.neuroCode) {
        const wk = weekendAnchorOf(date);
        if (wk && !neuroWeekends.has(`${pid}|${wk}`)) {
          neuroWeekends.add(`${pid}|${wk}`);
          const key = `${pid}|S:${NEURO_KEY}`;
          tally.set(key, (tally.get(key) || 0) + 1);
        }
      }
    }
  };
  for (const a of assignments) if (a.shift_type_category === 'call') inc(a.provider_id, a.shift_type_code, a.slot_date);
  for (const s of seeds) if (s.shift_type_category === 'call') inc(s.provider_id, s.shift_type_code, s.slot_date);
  return tally;
}

// Does the plan (plus seeds) respect every stated call cap? The optimizer's
// trial-acceptance gate: greedy plans are cap-clean by construction, and this
// keeps every accepted trial cap-clean too — a pin ('call-no-quota') bypasses
// caps INSIDE a trial re-solve, so the trial itself must be rejected here.
// WEIGHT_EPSILON absorbs stored-fraction noise (a tally of exactly the cap
// built from halves/thirds must not read as over).
export function planWithinCallCaps(
  caps: CallCaps,
  plan: Pick<SolutionPlan, 'assignments'>,
  seeds: ReadonlyArray<SeedAssignment>,
  shiftTypes?: Map<string, ShiftTypeInfo>,
  scenario?: ScenarioDoc | null,
): boolean {
  const tally = tallyCallsByPidCode(plan.assignments, seeds, shiftTypes, scenario);
  for (const [pid, byCode] of caps) {
    for (const [code, cap] of byCode) {
      if ((tally.get(`${pid}|${code}`) || 0) > cap + WEIGHT_EPSILON) return false;
    }
  }
  return true;
}

// ── Generation-result cap summary (surfaced in the UI banner) ────────────────

export interface ProviderCapRow {
  provider_id: string;
  provider_name: string;
  code: string;
  cap: number;
  placed: number; // final plan + seeds
}

export interface ProviderCapSummary {
  rows: ProviderCapRow[];            // one per stated (provider, code) cap
  cappedUnfilled: number;            // slots left open with reason 'provider-cap'
}

// Human-readable label for a cap key ('C1' stays 'C1'; scenario keys get
// their bucket phrasing). Kept beside the key vocabulary so they can't drift.
export function capKeyLabel(key: string): string {
  if (!key.startsWith('S:')) return key;
  const body = key.slice(2);
  if (body === NEURO_KEY) return 'NEURO F/S/S';
  if (body.startsWith('EO#')) return 'either-or group';
  return body.replace('|', ' '); // 'MTH|C1' -> 'MTH C1'
}

// Null when no call caps are stated (result field stays absent — additive).
// Since 2026-07-26 scenario ceilings ride the same summary (merged caps).
export function computeProviderCapSummary(
  ctx: GenerationContext,
  plan: SolutionPlan,
): ProviderCapSummary | null {
  const caps = mergedCallCapsForCtx(ctx);
  if (!caps) return null;
  const tally = tallyCallsByPidCode(plan.assignments, ctx.seedAssignments, ctx.shiftTypes, ctx.scenario);
  const nameByPid = new Map(ctx.providers.map(p => [p.id, p.short_display_name]));
  const rows: ProviderCapRow[] = [];
  for (const [pid, byCode] of caps) {
    for (const [code, cap] of byCode) {
      rows.push({
        provider_id: pid,
        provider_name: nameByPid.get(pid) ?? pid,
        code: capKeyLabel(code),
        cap,
        placed: tally.get(`${pid}|${code}`) || 0,
      });
    }
  }
  rows.sort((a, b) => a.provider_name.localeCompare(b.provider_name) || a.code.localeCompare(b.code));
  // cappedUnfilled counts DISTINCT slots that truly ended OPEN. The spans pass
  // reports a cap-blocked span with 'provider-cap' BEFORE its slots fall to
  // the main loop (severed-span fallback), so a slot can carry a span-level
  // 'provider-cap' entry AND a later individual fill — or a second
  // 'provider-cap' entry when the main loop also refuses it. The banner says
  // "left open at a stated maximum", so only truly-open slots may count
  // (review fix 2026-07-22).
  const assignedSlotIds = new Set(plan.assignments.map(a => a.slot_id));
  const cappedOpenSlotIds = new Set<string>();
  for (const u of plan.unfilled) {
    if (u.reason === 'provider-cap' && !assignedSlotIds.has(u.slot_id)) cappedOpenSlotIds.add(u.slot_id);
  }
  return {
    rows,
    cappedUnfilled: cappedOpenSlotIds.size,
  };
}
