// Per-category evaluators for the rules engine.
//
// Each function inspects ctx and returns 0+ violations. Evaluators are pure
// (no I/O) — all data they need is on the context object.

import type {
  EvaluationContext,
  Evaluator,
  RuleDefinition,
  RuleViolation,
  DayType,
} from './types';
import {
  BOOKEND_EXTENDING_TYPES,
  addDays,
  daysBetween,
  isBlockingAvailability,
  isActiveNoCallRequest,
  isSellbackOverridden,
} from './shared';

// ── Helpers ────────────────────────────────────────────────────────────────

function severity(rule: RuleDefinition) {
  return rule.hard_constraint ? 'hard' : 'soft';
}

function ruleAppliesToShift(rule: RuleDefinition, shiftCode: string): boolean {
  const codes = rule.applies_to_shift_types;
  if (!codes || codes.length === 0) return true;
  return codes.includes(shiftCode);
}

function ruleAppliesToDayType(rule: RuleDefinition, dayType: DayType | null): boolean {
  const types = rule.applies_to_day_types;
  if (!types || types.length === 0) return true;
  if (!dayType) return true;
  return types.includes(dayType);
}

function ruleAppliesToProvider(
  rule: RuleDefinition,
  providerGroup: 'physician' | 'crna' | 'both' | null,
): boolean {
  if (rule.applies_to_provider_group === 'both') return true;
  if (!providerGroup || providerGroup === 'both') return true;
  return rule.applies_to_provider_group === providerGroup;
}

function ruleApplies(ctx: EvaluationContext, rule: RuleDefinition): boolean {
  return (
    ruleAppliesToShift(rule, ctx.shiftType.code) &&
    ruleAppliesToDayType(rule, ctx.slot.derived_day_type) &&
    ruleAppliesToProvider(rule, ctx.providerGroup)
  );
}

function startOfMonth(iso: string): string {
  return iso.slice(0, 7) + '-01';
}

function startOfWeek(iso: string): string {
  // ISO week starting Monday
  const d = new Date(iso + 'T00:00:00Z');
  const day = d.getUTCDay(); // 0=Sun
  const offset = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

// Map a UI-level "shift category" string (e.g. "weekday_call") to a predicate.
function categoryMatcher(
  category: string,
): (shiftCategory: string, dayType: DayType | null) => boolean {
  switch (category) {
    case 'weekday_call':
      return (cat, dt) => cat === 'call' && dt === 'weekday';
    case 'friday_call':
      return (cat, dt) => cat === 'call' && dt === 'friday';
    case 'weekend_call':
      return (cat, dt) => cat === 'call' && (dt === 'saturday' || dt === 'sunday');
    case 'holiday_call':
      return (cat, dt) => cat === 'call' && (dt === 'federal_holiday' || dt === 'major_holiday');
    case 'all_call':
      return cat => cat === 'call';
    default:
      // Fallback: match the shift_type.category enum directly
      return cat => cat === category;
  }
}

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

  // Rule-driven eligibility checks
  for (const rule of ctx.rules) {
    if (rule.rule_category !== 'eligibility') continue;
    const cond = rule.condition;
    const action = rule.action;
    const ruleShiftCode = (cond.shift_code as string) || '';
    if (ruleShiftCode && ruleShiftCode !== ctx.shiftType.code) continue;
    if (!ruleAppliesToProvider(rule, ctx.providerGroup)) continue;

    const requirement = cond.requirement_type as string;
    const required = (action.required_value as string) || '';

    let ok = true;
    let why = '';
    switch (requirement) {
      case 'has_skill':
        ok = ctx.credentials.skill_tags.includes(required);
        why = `Requires skill "${required}".`;
        break;
      case 'call_taker_only':
        ok = ctx.credentials.can_take_call;
        why = 'Restricted to providers approved for call.';
        break;
      case 'credential':
        // Free-form text — placeholder until we model credentials properly
        ok = ctx.credentials.skill_tags.includes(required);
        why = `Requires credential "${required}".`;
        break;
      default:
        // Never skip silently: an unrecognized requirement_type means the
        // rule is NOT being enforced — surface that as an advisory flag.
        violations.push({
          rule_id: rule.id,
          rule_name: rule.rule_name,
          category: 'eligibility',
          severity: 'warning',
          message: `Unknown rule vocabulary: ${requirement}`,
        });
        continue;
    }
    if (!ok) {
      violations.push({
        rule_id: rule.id,
        rule_name: rule.rule_name,
        category: 'eligibility',
        severity: severity(rule),
        message: rule.explanation_text || why,
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

// ── Sequence ───────────────────────────────────────────────────────────────

// A sequence rule says: when a provider has trigger_shift on day N, the
// linked_shift should appear on day N+1 (relationship='post_call') or N-1
// (relationship='pre_call'). On a manual assignment we flag two cases:
//   1. The provider is being assigned to the trigger_shift but the linked
//      slot on the next/prev day is taken by something else for them.
//   2. The provider is being assigned to a non-linked shift on a day that
//      directly follows their trigger_shift (i.e. they should be on linked).

const sequence: Evaluator = ctx => {
  if (!ctx.providerId) return [];
  const violations: RuleViolation[] = [];

  for (const rule of ctx.rules) {
    if (rule.rule_category !== 'sequence') continue;
    if (!ruleAppliesToProvider(rule, ctx.providerGroup)) continue;

    const trigger = rule.condition.trigger_shift_code as string | undefined;
    const linked = rule.action.linked_shift_code as string | undefined;
    const relationship = (rule.condition.relationship as string) || 'post_call';
    if (!trigger || !linked) continue;

    const offset = relationship === 'pre_call' ? -1 : 1;

    // Scope gates anchor on the TRIGGER assignment: applies_to_shift_types
    // scopes which trigger codes the rule covers, applies_to_day_types scopes
    // which day the trigger falls on (e.g. weekday-only post-call chains).
    if (!ruleAppliesToShift(rule, trigger)) continue;

    // Case A: this assignment is the trigger shift
    if (ctx.shiftType.code === trigger && ruleAppliesToDayType(rule, ctx.slot.derived_day_type)) {
      const wantDate = addDays(ctx.slot.slot_date, offset);
      const conflict = ctx.neighborAssignments.find(
        n => n.slot_date === wantDate && n.shift_type_code !== linked,
      );
      const hasLinked = ctx.neighborAssignments.some(
        n => n.slot_date === wantDate && n.shift_type_code === linked,
      );
      if (conflict) {
        violations.push({
          rule_id: rule.id,
          rule_name: rule.rule_name,
          category: 'sequence',
          severity: severity(rule),
          message: `${trigger} on ${ctx.slot.slot_date} should be followed by ${linked} on ${wantDate}, but provider has ${conflict.shift_type_code} that day.`,
        });
      } else if (!hasLinked) {
        violations.push({
          rule_id: rule.id,
          rule_name: rule.rule_name,
          category: 'sequence',
          severity: 'soft',
          message: `${trigger} on ${ctx.slot.slot_date} expects ${linked} on ${wantDate} (currently unassigned for this provider).`,
        });
      }
    }

    // Case B: this assignment follows a trigger shift the day before
    // (only matters if THIS shift isn't the linked one)
    if (ctx.shiftType.code !== linked && ctx.shiftType.code !== trigger) {
      const priorDate = addDays(ctx.slot.slot_date, -offset);
      const priorTrigger = ctx.neighborAssignments.find(
        n => n.slot_date === priorDate && n.shift_type_code === trigger,
      );
      if (priorTrigger && ruleAppliesToDayType(rule, priorTrigger.day_type)) {
        violations.push({
          rule_id: rule.id,
          rule_name: rule.rule_name,
          category: 'sequence',
          severity: severity(rule),
          message: `Provider had ${trigger} on ${priorDate}; this slot should be ${linked}, not ${ctx.shiftType.code}.`,
        });
      }
    }
  }

  return violations;
};

// ── Rest ───────────────────────────────────────────────────────────────────

// A rest rule says: after a shift with `after_shift_code`, the provider needs
// either a full day off OR `min_hours` of rest before the next assignment.
// We check both directions: if THIS slot is the "after" shift, check what's
// scheduled the next day; if a prior day has the "after" shift, ensure THIS
// slot doesn't violate the rest window.

const REST_WINDOW_DAYS = 1; // simple v1: only check immediate next/prev day

const rest: Evaluator = ctx => {
  if (!ctx.providerId) return [];
  const violations: RuleViolation[] = [];

  for (const rule of ctx.rules) {
    if (rule.rule_category !== 'rest') continue;
    if (!ruleAppliesToProvider(rule, ctx.providerGroup)) continue;

    const afterCode = rule.condition.after_shift_code as string | undefined;
    const restType = (rule.condition.rest_type as string) || 'day_off';
    if (!afterCode) continue;

    // Optional exemptions: shifts allowed on the rest day despite the rule.
    // E.g. C1 → next day off, EXCEPT C3 (neuro coverage scarcity).
    const exemptCodes: string[] = Array.isArray(rule.action.exempt_next_shift_codes)
      ? (rule.action.exempt_next_shift_codes as string[])
      : [];

    // Case A: this slot IS the after-shift — check the next day
    if (ctx.shiftType.code === afterCode && ruleAppliesToDayType(rule, ctx.slot.derived_day_type)) {
      const nextDate = addDays(ctx.slot.slot_date, REST_WINDOW_DAYS);
      const next = ctx.neighborAssignments.find(n => n.slot_date === nextDate);
      if (next && restType === 'day_off' && !exemptCodes.includes(next.shift_type_code)) {
        violations.push({
          rule_id: rule.id,
          rule_name: rule.rule_name,
          category: 'rest',
          severity: severity(rule),
          message: `${afterCode} on ${ctx.slot.slot_date} requires the next day off, but provider is scheduled for ${next.shift_type_code} on ${nextDate}.`,
        });
      }
    }

    // Case B: a prior day has the after-shift — this slot may break rest.
    // Only fires if (a) the prior day-type is in rule scope and (b) this
    // slot's shift_code isn't in the exempt list.
    const priorDate = addDays(ctx.slot.slot_date, -REST_WINDOW_DAYS);
    const prior = ctx.neighborAssignments.find(
      n => n.slot_date === priorDate && n.shift_type_code === afterCode,
    );
    if (prior && restType === 'day_off' && ruleAppliesToDayType(rule, prior.day_type) &&
        !exemptCodes.includes(ctx.shiftType.code)) {
      violations.push({
        rule_id: rule.id,
        rule_name: rule.rule_name,
        category: 'rest',
        severity: severity(rule),
        message: `Provider had ${afterCode} on ${priorDate}; ${ctx.slot.slot_date} should be a rest day.`,
      });
    }
  }

  return violations;
};

// ── Frequency ──────────────────────────────────────────────────────────────

// Counts the provider's matching assignments inside the relevant period
// (week or month) and compares against max_count / min_count from the action.
// The slot under evaluation is included in the count IF it would match.

const frequency: Evaluator = ctx => {
  if (!ctx.providerId) return [];
  const violations: RuleViolation[] = [];

  for (const rule of ctx.rules) {
    if (rule.rule_category !== 'frequency') continue;
    if (!ruleApplies(ctx, rule)) continue;

    const category = (rule.condition.shift_category as string) || '';
    const period = (rule.condition.period as string) || 'month';
    const matcher = categoryMatcher(category);

    // Period bounds (inclusive)
    let periodStart: string;
    let periodEnd: string;
    if (period === 'week') {
      periodStart = startOfWeek(ctx.slot.slot_date);
      const d = new Date(periodStart + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + 6);
      periodEnd = d.toISOString().slice(0, 10);
    } else {
      periodStart = startOfMonth(ctx.slot.slot_date);
      const d = new Date(periodStart + 'T00:00:00Z');
      d.setUTCMonth(d.getUTCMonth() + 1);
      d.setUTCDate(0);
      periodEnd = d.toISOString().slice(0, 10);
    }

    // Count matching neighbor assignments in the period
    let count = 0;
    for (const n of ctx.neighborAssignments) {
      if (n.slot_date < periodStart || n.slot_date > periodEnd) continue;
      if (matcher(n.shift_type_category, n.day_type)) count++;
    }
    // Include the current slot if it matches
    if (matcher(ctx.shiftType.category, ctx.slot.derived_day_type)) {
      count++;
    }

    const max = rule.action.max_count as number | undefined;
    const min = rule.action.min_count as number | undefined;

    if (typeof max === 'number' && count > max) {
      violations.push({
        rule_id: rule.id,
        rule_name: rule.rule_name,
        category: 'frequency',
        severity: severity(rule),
        message: `Provider would have ${count} ${category} shifts in this ${period} (max ${max}).`,
        details: { count, max, period_start: periodStart, period_end: periodEnd },
      });
    }
    // min is informational only on a single-cell evaluation — we can't
    // know if the period is "complete" yet. Skip min checks for v1.
    void min;
  }

  return violations;
};

// ── Coverage ───────────────────────────────────────────────────────────────

// Checks that each shift type on the slot's date has enough assigned
// providers to meet the required_count. This runs per-cell but evaluates
// the entire day's coverage picture. Fires a violation on the CURRENT slot
// only if its own shift type is under-covered.

const coverage: Evaluator = ctx => {
  const violations: RuleViolation[] = [];
  if (ctx.sameDayAssignments.length === 0) return violations;

  // Group same-day assignments by shift type code
  const byShiftCode = new Map<string, { assigned: number; required: number }>();
  for (const a of ctx.sameDayAssignments) {
    const existing = byShiftCode.get(a.shift_type_code);
    if (!existing) {
      byShiftCode.set(a.shift_type_code, { assigned: a.provider_id ? 1 : 0, required: a.required_count });
    } else {
      if (a.provider_id) existing.assigned++;
      existing.required = Math.max(existing.required, a.required_count);
    }
  }

  // Check rule-driven coverage requirements
  for (const rule of ctx.rules) {
    if (rule.rule_category !== 'coverage') continue;
    if (!ruleApplies(ctx, rule)) continue;

    const shiftCode = rule.condition.shift_code as string | undefined;
    const minCount = rule.action.min_providers as number | undefined;
    if (!shiftCode || typeof minCount !== 'number') continue;

    // Only flag this on the cell that IS the under-covered shift
    if (ctx.shiftType.code !== shiftCode) continue;

    const entry = byShiftCode.get(shiftCode);
    const assigned = entry?.assigned ?? 0;
    if (assigned < minCount) {
      violations.push({
        rule_id: rule.id,
        rule_name: rule.rule_name,
        category: 'coverage',
        severity: severity(rule),
        message: `${shiftCode} needs ${minCount} provider${minCount > 1 ? 's' : ''} on ${ctx.slot.slot_date}, only ${assigned} assigned.`,
        details: { assigned, required: minCount },
      });
    }
  }

  // Implicit coverage check: if this slot's required_count > assigned.
  // CALL slots only — an under-staffed day (regular/float/admin) slot is
  // normal scheduler workflow, not a warning (Gabriel 2026-07-15; same
  // rationale as openSlot's call-only default). Rule-driven coverage rules
  // above remain category-blind: an explicit rule naming a day code is a
  // deliberate coverage requirement.
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

// ── Pairing ────────────────────────────────────────────────────────────────

// A pairing rule says: when primary_shift_code is assigned, there must also
// be a required_backup_code assigned on the same day. Optionally same_day=true
// means they must be on the exact same day (not just overlapping window).

const pairing: Evaluator = ctx => {
  const violations: RuleViolation[] = [];

  for (const rule of ctx.rules) {
    if (rule.rule_category !== 'pairing') continue;

    const primaryCode = rule.condition.primary_shift_code as string | undefined;
    const backupCode = rule.action.required_backup_code as string | undefined;
    if (!primaryCode || !backupCode) continue;

    // Only check when THIS assignment is the primary shift
    if (ctx.shiftType.code !== primaryCode) continue;
    if (!ruleAppliesToProvider(rule, ctx.providerGroup)) continue;

    // Look for the backup shift on the same day
    const hasBackup = ctx.sameDayAssignments.some(
      a => a.shift_type_code === backupCode && a.provider_id,
    );

    if (!hasBackup) {
      violations.push({
        rule_id: rule.id,
        rule_name: rule.rule_name,
        category: 'pairing',
        severity: severity(rule),
        message: `${primaryCode} on ${ctx.slot.slot_date} requires a ${backupCode} assignment on the same day, but none is assigned.`,
      });
    }
  }

  return violations;
};

// ── Fairness ───────────────────────────────────────────────────────────────

// Fairness rules track whether a provider's burden is trending significantly
// above or below average. This is informational (soft by default) — it won't
// block an assignment but flags inequity for the scheduler to review.
// Requires the frequency counter logic (already have neighbor data ±31 days).

const fairness: Evaluator = ctx => {
  if (!ctx.providerId) return [];
  const violations: RuleViolation[] = [];

  for (const rule of ctx.rules) {
    if (rule.rule_category !== 'fairness') continue;
    if (!ruleApplies(ctx, rule)) continue;

    const category = (rule.condition.burden_category as string) || '';
    const method = (rule.action.distribution_method as string) || 'equal';
    const matcher = categoryMatcher(category);

    // Count this provider's matching assignments in the current month
    const monthStart = startOfMonth(ctx.slot.slot_date);
    const monthEnd = (() => {
      const d = new Date(monthStart + 'T00:00:00Z');
      d.setUTCMonth(d.getUTCMonth() + 1);
      d.setUTCDate(0);
      return d.toISOString().slice(0, 10);
    })();

    let count = 0;
    for (const n of ctx.neighborAssignments) {
      if (n.slot_date < monthStart || n.slot_date > monthEnd) continue;
      if (matcher(n.shift_type_category, n.day_type)) count++;
    }
    // Include current
    if (matcher(ctx.shiftType.category, ctx.slot.derived_day_type)) count++;

    // We can't compute the group average from a single-cell evaluation, so
    // we use a heuristic: if the provider is at or above 150% of a
    // reasonable target, flag it. The target can come from the provider's
    // profile (via frequency rules) or we default to 6/month — scaled by
    // FTE so a part-timer's fair share is proportionally smaller
    // (clinical invariant 5: call burden distributes per-FTE).
    const fte = typeof ctx.fte_value === 'number' && ctx.fte_value > 0 ? ctx.fte_value : 1;
    const base = method === 'equal' ? 6 : 8;
    const maxReasonable = Math.ceil(base * fte);
    if (count > maxReasonable) {
      violations.push({
        rule_id: rule.id,
        rule_name: rule.rule_name,
        category: 'fairness',
        severity: 'soft',
        message: `Provider has ${count} ${category} shifts this month — may exceed fair share.`,
        details: { count, threshold: maxReasonable, month: monthStart },
      });
    }
  }

  return violations;
};

// ── Open Slot ──────────────────────────────────────────────────────────────

// Flags slots that have no provider assigned. This is always-on (no rule
// needed) — it's informational to help the scheduler see gaps at a glance.
// If a rule specifies a deadline (days_before_slot), violations escalate
// from soft to hard as the date approaches.

const openSlot: Evaluator = ctx => {
  // If there IS a provider assigned, no violation
  if (ctx.providerId) return [];
  const violations: RuleViolation[] = [];

  const today = new Date().toISOString().slice(0, 10);
  const daysUntil = daysBetween(today, ctx.slot.slot_date);

  // Check rule-driven deadlines
  for (const rule of ctx.rules) {
    if (rule.rule_category !== 'open_slot') continue;
    if (!ruleApplies(ctx, rule)) continue;

    const deadlineDays = rule.action.days_before_slot as number | undefined;
    if (typeof deadlineDays === 'number' && daysUntil <= deadlineDays) {
      violations.push({
        rule_id: rule.id,
        rule_name: rule.rule_name,
        category: 'open_slot',
        severity: severity(rule),
        message: `Slot on ${ctx.slot.slot_date} is unassigned and within ${deadlineDays}-day deadline (${daysUntil} days away).`,
      });
      return violations; // One deadline violation is enough
    }
  }

  // Default: soft warning for open CALL slots only. An open day (regular/
  // float/admin) slot is normal scheduler workflow, not a warning — Gabriel
  // 2026-07-14. Rule-driven deadlines above remain category-blind.
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

  // Per-code call cap.
  const code = ctx.shiftType.code;
  const callCap = ctx.shiftType.category === 'call' ? entry?.calls?.[code] : undefined;
  if (typeof callCap === 'number' && inBlock(ctx.slot.slot_date)) {
    let count = 1; // this assignment
    for (const n of ctx.neighborAssignments) {
      if (n.shift_type_category === 'call' && n.shift_type_code === code && inBlock(n.slot_date)) count++;
    }
    if (count > callCap) {
      violations.push({
        rule_id: null,
        rule_name: 'Provider limit (calls)',
        category: 'frequency',
        severity: 'soft',
        message: `Provider has ${count} ${code} calls this block — stated max ${callCap}.`,
        details: { code, count, cap: callCap },
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
// Always a hard violation unless a rule explicitly allows it.

const crossSite: Evaluator = ctx => {
  if (!ctx.providerId) return [];
  const violations: RuleViolation[] = [];

  // Group cross-site assignments by site
  const siteIds: string[] = [];
  for (const a of ctx.crossSiteAssignments) {
    if (!siteIds.includes(a.site_id)) siteIds.push(a.site_id);
  }

  if (siteIds.length <= 1) return violations;

  // Check if any cross-site rule explicitly allows multi-site on this day
  for (const rule of ctx.rules) {
    if (rule.rule_category !== 'cross_site') continue;
    const allowMultiSite = rule.action.allow_multi_site as boolean | undefined;
    if (allowMultiSite) return []; // Explicitly allowed
  }

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

// ── Registry ───────────────────────────────────────────────────────────────

export const evaluators: Evaluator[] = [
  eligibility,
  timeOff,
  weekendAdjacentPto,
  sequence,
  rest,
  frequency,
  coverage,
  pairing,
  fairness,
  openSlot,
  poolEligibility,
  providerLimits,
  crossSite,
];
