// Per-category evaluators for the rules engine.
//
// Each function inspects ctx and returns 0+ violations. Evaluators are pure
// (no I/O) — all data they need is on the context object.

import type {
  EvaluationContext,
  Evaluator,
  RuleViolation,
} from './types';
import {
  BOOKEND_EXTENDING_TYPES,
  addDays,
  isBlockingAvailability,
  isActiveNoCallRequest,
  isSellbackOverridden,
} from './shared';
import { WEIGHT_EPSILON, callBurdenWeight, parentCallCodeOf, formatCallWeight } from '@/lib/callBurden';
import { scenarioProhibits } from './scenario';

// ── Eligibility ────────────────────────────────────────────────────────────

const eligibility: Evaluator = ctx => {
  const violations: RuleViolation[] = [];
  if (!ctx.providerId) return violations;

  // Credentialing is opt-in: if there's no provider_site_credentials row
  // for this provider+site, we treat it as "not yet configured" rather than
  // "denied". Users can populate credentials later for strict enforcement.
  if (!ctx.credentials) return violations;

  if (!ctx.credentials.is_active) {
    violations.push({
      rule_id: null,
      rule_name: 'Provider inactive at site',
      category: 'eligibility',
      severity: 'hard',
      message: 'Provider is marked inactive at this site.',
    });
  }
  if (!ctx.credentials.credentialed) {
    violations.push({
      rule_id: null,
      rule_name: 'Provider not credentialed',
      category: 'eligibility',
      severity: 'hard',
      message: 'Provider is not credentialed at this site.',
    });
  }

  if (ctx.credentials.excluded_shift_types.includes(ctx.shiftType.code)) {
    violations.push({
      rule_id: null,
      rule_name: 'Shift excluded for provider',
      category: 'eligibility',
      severity: 'hard',
      message: `Shift ${ctx.shiftType.code} is in this provider's excluded list.`,
    });
  }

  if (
    ctx.credentials.allowed_shift_types.length > 0 &&
    !ctx.credentials.allowed_shift_types.includes(ctx.shiftType.code)
  ) {
    violations.push({
      rule_id: null,
      rule_name: 'Shift not in allowed list',
      category: 'eligibility',
      severity: 'hard',
      message: `Shift ${ctx.shiftType.code} is not in this provider's allowed list.`,
    });
  }

  // Implicit call eligibility based on shift category + day type
  if (ctx.shiftType.category === 'call') {
    if (!ctx.credentials.can_take_call) {
      violations.push({
        rule_id: null,
        rule_name: 'Cannot take call',
        category: 'eligibility',
        severity: 'hard',
        message: 'Provider is not approved to take call at this site.',
      });
    }
    const dt = ctx.slot.derived_day_type;
    if ((dt === 'saturday' || dt === 'sunday') && !ctx.credentials.can_take_weekend_call) {
      violations.push({
        rule_id: null,
        rule_name: 'Cannot take weekend call',
        category: 'eligibility',
        severity: 'hard',
        message: 'Provider is not approved for weekend call.',
      });
    }
    if ((dt === 'federal_holiday' || dt === 'major_holiday') && !ctx.credentials.can_take_holiday_call) {
      violations.push({
        rule_id: null,
        rule_name: 'Cannot take holiday call',
        category: 'eligibility',
        severity: 'hard',
        message: 'Provider is not approved for holiday call.',
      });
    }
  }

  return violations;
};

// ── Time Off ───────────────────────────────────────────────────────────────

// Always-on: any non-dismissed blocking unavailability overlapping the slot
// date is a hard violation (isBlockingAvailability — the canonical predicate
// from shared.ts: pending blocks, only denied/canceled are ignored).
// no_call_request isn't a blocking type; it soft-flags call assignments only.
//
// pto_sellback date-level override (2026-07-20): a LIVE sell-back row covering
// the slot date means the provider IS WORKING — an assignment there is exactly
// what the sell-back sanctions, so blocking rows (pending PTO included) must
// NOT flag it. The date decision is the single-homed isSellbackOverridden
// (shared.ts — same home isDateBlocked composes); the per-row loop is kept so
// each violation still names its own row's type and dates.

const timeOff: Evaluator = ctx => {
  if (!ctx.providerId) return [];
  const violations: RuleViolation[] = [];
  const date = ctx.slot.slot_date;
  const soldBack = isSellbackOverridden(ctx.availability, date);

  for (const a of ctx.availability) {
    if (a.start_date > date || a.end_date < date) continue;

    if (isBlockingAvailability(a)) {
      if (soldBack) continue; // sold-back date: the provider is working
      violations.push({
        rule_id: null,
        rule_name: `Conflicts with ${a.availability_type.toUpperCase()}`,
        category: 'time_off',
        severity: 'hard',
        message: `Provider has ${a.availability_type} from ${a.start_date} to ${a.end_date}.`,
      });
    } else if (isActiveNoCallRequest(a) && ctx.shiftType.category === 'call') {
      violations.push({
        rule_id: null,
        rule_name: 'No-call request',
        category: 'time_off',
        severity: 'soft',
        message: `Provider requested no call from ${a.start_date} to ${a.end_date}.`,
      });
    }
  }
  return violations;
};

// ── Weekend adjacent-week PTO ──────────────────────────────────────────────
//
// Hard rule mirroring the eligibility check in autoGenerate.ts: a Sat or
// Sun call assignment is invalid if the provider has planned leave
// (PTO / FMLA / parental / military) covering any day of the Mon-Fri
// week immediately BEFORE the weekend or the Mon-Fri week immediately
// AFTER the weekend. Manual assignments that violate this surface the
// same warning that the auto-generator would have used to exclude them.
//
// Friday slots are intentionally not checked — a provider may take the
// Friday immediately before their PTO week in extenuating circumstances.

const weekendAdjacentPto: Evaluator = ctx => {
  if (!ctx.providerId) return [];
  const dt = ctx.slot.derived_day_type;
  if (dt !== 'saturday' && dt !== 'sunday') return [];

  const satDate = dt === 'saturday'
    ? ctx.slot.slot_date
    : addDays(ctx.slot.slot_date, -1);
  const weekBeforeStart = addDays(satDate, -5);
  const weekBeforeEnd = addDays(satDate, -1);
  const weekAfterStart = addDays(satDate, 2);
  const weekAfterEnd = addDays(satDate, 6);

  for (const a of ctx.availability) {
    // Canonical status predicate, narrowed to the bookend-extending subset —
    // only multi-day planned leave pulls the adjacent weekend out of play.
    // (BOOKEND_EXTENDING_TYPES ⊆ BLOCKING_AVAIL, so this is purely the same
    // denied/canceled skip the inline check used to do.)
    if (!isBlockingAvailability(a)) continue;
    if (!BOOKEND_EXTENDING_TYPES.has(a.availability_type)) continue;

    const overlapsBefore =
      a.start_date <= weekBeforeEnd && a.end_date >= weekBeforeStart;
    const overlapsAfter =
      a.start_date <= weekAfterEnd && a.end_date >= weekAfterStart;
    if (!overlapsBefore && !overlapsAfter) continue;

    const which = overlapsBefore ? 'week before' : 'week after';
    return [{
      rule_id: null,
      rule_name: 'Weekend call adjacent to PTO',
      category: 'time_off',
      severity: 'hard',
      message: `Provider has ${a.availability_type} (${a.start_date} to ${a.end_date}) in the ${which} this weekend — Sat/Sun call should not be placed adjacent to planned leave.`,
    }];
  }

  return [];
};

// ── Coverage ───────────────────────────────────────────────────────────────

// Checks that each shift type on the slot's date has enough assigned
// providers to meet the required_count. This runs per-cell but evaluates
// the entire day's coverage picture. Fires a violation on the CURRENT slot
// only if its own shift type is under-covered.

const coverage: Evaluator = ctx => {
  const violations: RuleViolation[] = [];
  if (ctx.sameDayAssignments.length === 0) return violations;

  // Coverage check: if this slot's required_count > assigned.
  // CALL slots only — an under-staffed day (regular/float/admin) slot is
  // normal scheduler workflow, not a warning (Gabriel 2026-07-15; same
  // rationale as openSlot's call-only default).
  const mySlotAssignments = ctx.sameDayAssignments.filter(
    a => a.slot_id === ctx.slot.id,
  );
  const assignedToMySlot = mySlotAssignments.filter(a => a.provider_id).length;
  const requiredForMySlot = mySlotAssignments[0]?.required_count ?? 1;
  // Credit the assignment being evaluated: the manual-edit path evaluates
  // BEFORE writing, so the DB row for this slot still shows no provider at
  // eval time — without this, every manual call assignment is stamped with a
  // stale "needs N, only N-1 assigned" flag (live bug, 2026-07-20). Guarded
  // so a re-evaluation AFTER the write (where the row already carries this
  // provider) doesn't double-count.
  const inFlight =
    ctx.providerId && !mySlotAssignments.some(a => a.provider_id === ctx.providerId)
      ? 1
      : 0;
  if (ctx.shiftType.category === 'call' && assignedToMySlot + inFlight < requiredForMySlot) {
    violations.push({
      rule_id: null,
      rule_name: 'Slot under-covered',
      category: 'coverage',
      severity: 'soft',
      message: `This slot needs ${requiredForMySlot} provider${requiredForMySlot > 1 ? 's' : ''}, only ${assignedToMySlot} assigned.`,
    });
  }

  return violations;
};

// ── Open Slot ──────────────────────────────────────────────────────────────

// Flags slots that have no provider assigned. Always-on — it's informational,
// to help the scheduler see gaps at a glance.

const openSlot: Evaluator = ctx => {
  // If there IS a provider assigned, no violation
  if (ctx.providerId) return [];
  const violations: RuleViolation[] = [];

  // Soft warning for open CALL slots only. An open day (regular/float/admin)
  // slot is normal scheduler workflow, not a warning — Gabriel 2026-07-14.
  if (ctx.shiftType.category === 'call') {
    violations.push({
      rule_id: null,
      rule_name: 'Open slot',
      category: 'open_slot',
      severity: 'soft',
      message: `${ctx.shiftType.code} on ${ctx.slot.slot_date} has no provider assigned.`,
    });
  }

  return violations;
};

// ── Pool eligibility ─────────────────────────────────────────────────────────
//
// Always-on (Gabriel 2026-07-14; day-pool side tightened Gabriel 2026-07-21):
//   - Call-engine-owned NON-call slots (generation_engine === 'call' with
//     category !== 'call' — the derived/relief D1–D9 on live data) are
//     reserved for call takers — a day doc placed there is a hard flag.
//   - Day-pool slots (generation_engine === 'day_pool', e.g. 7-3/7-5) are
//     reserved for Day Docs. Gabriel 2026-07-21 (live-confirmed bug review,
//     SUPERSEDES the 2026-07-14 generic-pickup allowance): call takers
//     "should never be placed there unless they are selling back PTO" — the
//     holder must be a Day Doc OR have a live pto_sellback row covering the
//     slot date (shared isSellbackOverridden, same per-date predicate the
//     engines use); otherwise hard. A covering sell-back is a chief-entered
//     decision and clears the flag even with no profile on file.
// Hard-flag, never block: exceptions stay possible, nothing is hidden. Keyed
// entirely on generation_engine + category (data-driven, patch18) — never on
// code-name patterns, so a future call-derived code not named D* can't
// silently escape. Call-category slots have their own pool gating at
// generation; not this evaluator's job.

/**
 * The skills a SHIFT TYPE demands, against the skills the provider holds.
 *
 * shift_types.requires_specific_skills has been loaded into the validation
 * context for a long time and read by nothing. The only skills check that ever
 * existed lived inside the rule-definitions loop, driven by a rule's
 * `required_value` rather than by the shift's own column — so a site that
 * filled in `requires_specific_skills` and never wrote a matching rule got no
 * enforcement and no warning. The column looked like a control and was inert.
 *
 * Always-on, and a property of the shift rather than of a configurable rule:
 * "C3 needs someone neuro-eligible" is a fact about neuro call, not a policy a
 * site might reasonably switch off.
 *
 * Silent by default. Every shift type currently has an empty list, so this
 * fires for nobody until someone states a requirement — which is the right
 * default for a check being introduced over live data.
 */
const shiftSkills: Evaluator = ctx => {
  if (!ctx.providerId) return [];
  const required = ctx.shiftType.requires_specific_skills ?? [];
  if (required.length === 0) return [];

  // No credentials row means "not yet configured" rather than "denied" — the
  // same opt-in stance the eligibility evaluator takes. Flagging here would
  // light up every provider at a site that has not filled credentials in.
  if (!ctx.credentials) return [];

  const held = ctx.credentials.skill_tags ?? [];
  const missing = required.filter(r => !held.includes(r));
  if (missing.length === 0) return [];

  return [{
    rule_id: null,
    rule_name: 'Shift skill requirement',
    category: 'eligibility',
    severity: 'hard',
    message: `${ctx.shiftType.code} requires ${missing.length === 1 ? 'the skill' : 'skills'} `
      + `${missing.map(m => `"${m}"`).join(', ')}, which this provider is not marked as holding.`,
  }];
};

const poolEligibility: Evaluator = ctx => {
  if (!ctx.providerId) return [];
  const st = ctx.shiftType;
  const isDerivedCallSlot = st.generation_engine === 'call' && st.category !== 'call';
  const isDayPoolSlot = st.generation_engine === 'day_pool';
  if (!isDerivedCallSlot && !isDayPoolSlot) return [];

  // null poolFlags = no employment profile on file → ineligible for both pools
  // (never silently pass — invariant 6 spirit; the day-pool side's sole
  // exception is a covering live sell-back row, an explicit affirmative record).
  const f = ctx.poolFlags;
  const noProfile = ' (no employment profile on file)';
  const isCallTaker = !!(f?.call_taker || f?.partial_call_taker);
  const isDayDoc = !!f?.is_day_doc;
  const violations: RuleViolation[] = [];

  if (isDerivedCallSlot && !isCallTaker) {
    violations.push({
      rule_id: null,
      rule_name: 'Pool eligibility',
      category: 'eligibility',
      severity: 'hard',
      message: `${st.code} is reserved for call takers — this provider is not a call taker${f ? '' : noProfile}.`,
    });
  }
  if (isDayPoolSlot && !isDayDoc &&
      !isSellbackOverridden(ctx.availability, ctx.slot.slot_date)) {
    violations.push({
      rule_id: null,
      rule_name: 'Pool eligibility',
      category: 'eligibility',
      severity: 'hard',
      message: `${st.code} is a day shift reserved for Day Docs — a ${isCallTaker ? 'call taker' : 'non-Day-Doc'} ` +
        `may hold it only when selling back PTO covering ${ctx.slot.slot_date}${f ? '' : noProfile}.`,
    });
  }
  return violations;
};

// ── Provider limits (2026-07-22, patch34) ──────────────────────────────────
//
// SOFT flags only — never hard, never blocking. The stated per-provider caps
// (schedules.provider_limits) are hard ceilings for AUTO-GENERATION; manual /
// assistant edits legitimately bypass them, and this evaluator is how such
// overruns stay visible on the grid. Fires only when the load path resolved a
// providerLimitsCtx (absent = feature off — pre-patch34 DBs stay silent).
//
//   • Per-code call cap: this assignment's code count within the block
//     (neighbors are version+site scoped, window ±31d ≥ any monthly block)
//     exceeds the stated calls[code] max.
//   • Working-days cap: distinct ASSIGNED working days (weekdays minus major
//     holidays, deduped per date) exceed the resolved stated max. Post-call
//     rest / ICU credit deliberately do NOT count here — validation examines
//     assignment rows, and undercounting only makes the soft flag quieter.

const providerLimits: Evaluator = ctx => {
  const plc = ctx.providerLimitsCtx;
  if (!plc || !ctx.providerId) return [];
  const entry = plc.limits[ctx.providerId];
  const wdCap = plc.workingDaysCapByProvider.get(ctx.providerId);
  if (!entry && wdCap == null) return [];
  const violations: RuleViolation[] = [];
  const inBlock = (d: string) => d >= plc.blockStart && d <= plc.blockEnd;

  // Per-code call cap — WEIGHTED + PARENT-MAPPED (2026-07-22, call splits):
  // caps are stated per PARENT code (C1/C2…); a segment assignment counts
  // against its parent's cap at its fractional call_burden_weight (a C1N12 =
  // 0.5 of C1). Whole calls: parent = own code, weight 1 — byte-identical.
  // Weight/parent come from shiftTypesByCode (loadSiteValidationContext rides
  // the patch35 columns with a pre-patch narrow retry).
  const stOf = (c: string) => ctx.shiftTypesByCode.get(c);
  const capCode = parentCallCodeOf(ctx.shiftType.code, ctx.shiftType);
  const callCap = ctx.shiftType.category === 'call' ? entry?.calls?.[capCode] : undefined;
  if (typeof callCap === 'number' && inBlock(ctx.slot.slot_date)) {
    let count = callBurdenWeight(ctx.shiftType); // this assignment
    for (const n of ctx.neighborAssignments) {
      if (n.shift_type_category === 'call' && inBlock(n.slot_date)
        && parentCallCodeOf(n.shift_type_code, stOf(n.shift_type_code)) === capCode) {
        count += callBurdenWeight(stOf(n.shift_type_code));
      }
    }
    if (count > callCap + WEIGHT_EPSILON) {
      violations.push({
        rule_id: null,
        rule_name: 'Provider limit (calls)',
        category: 'frequency',
        severity: 'soft',
        message: `Provider has ${formatCallWeight(count)} ${capCode} calls this block — stated max ${callCap}.`,
        details: { code: capCode, count, cap: callCap },
      });
    }
  }

  // Working-days cap (workingDaySet is already block-scoped).
  if (wdCap != null && plc.workingDaySet.has(ctx.slot.slot_date)) {
    const days = new Set<string>([ctx.slot.slot_date]);
    for (const n of ctx.neighborAssignments) {
      if (plc.workingDaySet.has(n.slot_date)) days.add(n.slot_date);
    }
    if (days.size > wdCap) {
      violations.push({
        rule_id: null,
        rule_name: 'Provider limit (working days)',
        category: 'frequency',
        severity: 'soft',
        message: `Provider is assigned on ${days.size} working days this block — stated max ${wdCap}.`,
        details: { workingDays: days.size, cap: wdCap },
      });
    }
  }

  return violations;
};

// ── Cross-Site ─────────────────────────────────────────────────────────────

// Detects when a provider is assigned at more than one site on the same day.
// Always a hard violation (clinical invariant 3).

const crossSite: Evaluator = ctx => {
  if (!ctx.providerId) return [];
  const violations: RuleViolation[] = [];

  // Group cross-site assignments by site
  const siteIds: string[] = [];
  for (const a of ctx.crossSiteAssignments) {
    if (!siteIds.includes(a.site_id)) siteIds.push(a.site_id);
  }

  if (siteIds.length <= 1) return violations;

  // Build the site list for the message
  const otherSites = siteIds.filter(s => s !== ctx.slot.site_id);
  violations.push({
    rule_id: null,
    rule_name: 'Cross-site conflict',
    category: 'cross_site',
    severity: 'hard',
    message: `Provider is assigned at ${siteIds.length} sites on ${ctx.slot.slot_date}. Other site(s): ${otherSites.join(', ')}.`,
    details: { sites: siteIds },
  });

  return violations;
};

// ── Scenario prohibition (2026-07-26, patch37) ─────────────────────────────
//
// SOFT flag only: a CALL assignment sitting on a scenario-manifest no-call
// prohibition for its provider. The engine's eligibility gate makes a
// GENERATED violation structurally impossible, so any hit here is a
// seeded/manual fixed assignment — the import's documented
// mandatory-retained resolution (column-M precedence). The flag keeps the
// conflict visible in the grid; it must never block (that would fight the
// retained mandatory). Inert without ctx.scenarioCtx (pre-patch37 DBs,
// manifest-free schedules).

const scenarioProhibition: Evaluator = ctx => {
  const sc = ctx.scenarioCtx;
  if (!sc || !ctx.providerId) return [];
  if (ctx.shiftType.category !== 'call') return [];
  const sp = sc.providers.get(ctx.providerId);
  if (!sp) return [];
  const code = parentCallCodeOf(ctx.shiftType.code, ctx.shiftType);
  if (!scenarioProhibits(sp, ctx.slot.slot_date, code)) return [];
  return [{
    rule_id: null,
    rule_name: 'Scenario no-call prohibition (mandatory-retained)',
    category: 'time_off',
    severity: 'soft',
    message: `The scenario manifest prohibits ${code} for this provider on ${ctx.slot.slot_date}; `
      + `the assignment stands per the mandatory-over-prohibition precedence and is flagged for review.`,
  }];
};

// ── Registry ───────────────────────────────────────────────────────────────

export const evaluators: Evaluator[] = [
  eligibility,
  timeOff,
  scenarioProhibition,
  weekendAdjacentPto,
  shiftSkills,
  coverage,
  openSlot,
  poolEligibility,
  providerLimits,
  crossSite,
];
