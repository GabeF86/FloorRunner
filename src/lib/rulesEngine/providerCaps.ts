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
import type { GenerationContext, SolutionPlan, SeedAssignment, ShiftTypeInfo } from './genTypes';

// pid -> code -> stated max.
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

// `${pid}|${code}` -> WEIGHTED count of call-category placements (plan +
// seeds). With `shiftTypes` (2026-07-22, call splits) segment rows fold under
// their PARENT code at their fractional call_burden_weight — a C1N12 seed is
// 0.5 of C1 against a stated C1 cap. Absent map (bare fixtures, pre-patch35):
// weight 1 / own code, the pre-split tally byte for byte.
export function tallyCallsByPidCode(
  assignments: SolutionPlan['assignments'],
  seeds: ReadonlyArray<SeedAssignment>,
  shiftTypes?: Map<string, ShiftTypeInfo>,
): Map<string, number> {
  const tally = new Map<string, number>();
  const inc = (pid: string, code: string) => {
    const info = shiftTypes?.get(code);
    const k = `${pid}|${parentCallCodeOf(code, info)}`;
    tally.set(k, (tally.get(k) || 0) + callBurdenWeight(info));
  };
  for (const a of assignments) if (a.shift_type_category === 'call') inc(a.provider_id, a.shift_type_code);
  for (const s of seeds) if (s.shift_type_category === 'call') inc(s.provider_id, s.shift_type_code);
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
): boolean {
  const tally = tallyCallsByPidCode(plan.assignments, seeds, shiftTypes);
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

// Null when no call caps are stated (result field stays absent — additive).
export function computeProviderCapSummary(
  ctx: GenerationContext,
  plan: SolutionPlan,
): ProviderCapSummary | null {
  const caps = buildCallCaps(ctx.providerLimits);
  if (!caps) return null;
  const tally = tallyCallsByPidCode(plan.assignments, ctx.seedAssignments, ctx.shiftTypes);
  const nameByPid = new Map(ctx.providers.map(p => [p.id, p.short_display_name]));
  const rows: ProviderCapRow[] = [];
  for (const [pid, byCode] of caps) {
    for (const [code, cap] of byCode) {
      rows.push({
        provider_id: pid,
        provider_name: nameByPid.get(pid) ?? pid,
        code,
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
