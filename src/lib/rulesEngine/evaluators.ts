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

function dateDiffDays(a: string, b: string): number {
  const da = new Date(a + 'T00:00:00Z').getTime();
  const db = new Date(b + 'T00:00:00Z').getTime();
  return Math.round((da - db) / 86400000);
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

// Always-on: any approved unavailability overlapping the slot date is a hard violation.
// Rule-driven additions (like blocking on no_call_request) come from rules.
const TIME_OFF_BLOCKING = new Set([
  'pto',
  'sick',
  'fmla',
  'parental_leave',
  'military_leave',
  'jury_duty',
  'unavailable',
  'blocked',
]);

const timeOff: Evaluator = ctx => {
  if (!ctx.providerId) return [];
  const violations: RuleViolation[] = [];
  const date = ctx.slot.slot_date;

  for (const a of ctx.availability) {
    if (a.approval_status === 'denied' || a.approval_status === 'canceled') continue;
    if (a.start_date > date || a.end_date < date) continue;

    if (TIME_OFF_BLOCKING.has(a.availability_type)) {
      violations.push({
        rule_id: null,
        rule_name: `Conflicts with ${a.availability_type.toUpperCase()}`,
        category: 'time_off',
        severity: 'hard',
        message: `Provider has ${a.availability_type} from ${a.start_date} to ${a.end_date}.`,
      });
    } else if (a.availability_type === 'no_call_request' && ctx.shiftType.category === 'call') {
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

    // Case A: this assignment is the trigger shift
    if (ctx.shiftType.code === trigger) {
      const wantDate = shiftDate(ctx.slot.slot_date, offset);
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
      const priorDate = shiftDate(ctx.slot.slot_date, -offset);
      const priorTrigger = ctx.neighborAssignments.find(
        n => n.slot_date === priorDate && n.shift_type_code === trigger,
      );
      if (priorTrigger) {
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

function shiftDate(iso: string, delta: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

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

    // Case A: this slot IS the after-shift — check the next day
    if (ctx.shiftType.code === afterCode) {
      const nextDate = shiftDate(ctx.slot.slot_date, REST_WINDOW_DAYS);
      const next = ctx.neighborAssignments.find(n => n.slot_date === nextDate);
      if (next && restType === 'day_off') {
        violations.push({
          rule_id: rule.id,
          rule_name: rule.rule_name,
          category: 'rest',
          severity: severity(rule),
          message: `${afterCode} on ${ctx.slot.slot_date} requires the next day off, but provider is scheduled for ${next.shift_type_code} on ${nextDate}.`,
        });
      }
    }

    // Case B: a prior day has the after-shift — this slot may break rest
    const priorDate = shiftDate(ctx.slot.slot_date, -REST_WINDOW_DAYS);
    const prior = ctx.neighborAssignments.find(
      n => n.slot_date === priorDate && n.shift_type_code === afterCode,
    );
    if (prior && restType === 'day_off') {
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

// ── Registry ───────────────────────────────────────────────────────────────

export const evaluators: Evaluator[] = [eligibility, timeOff, sequence, rest, frequency];

// Re-export helpers used by dateDiff in tests etc.
export const __test = { dateDiffDays, startOfMonth, startOfWeek, shiftDate };
