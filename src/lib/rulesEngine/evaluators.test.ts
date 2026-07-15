// Pure evaluator tests — hand-built EvaluationContext fixtures, no DB.
// One describe per evaluator. Violations are isolated by category (and
// rule_name where two evaluators share a category, e.g. time_off).
import { describe, it, expect } from 'vitest';
import { evaluators } from './evaluators';
import type {
  EvaluationContext,
  RuleDefinition,
  RuleViolation,
  ShiftTypeRow,
  SlotRow,
  ProviderSiteCredentials,
  AvailabilityRow,
} from './types';

// ── fixture builders ─────────────────────────────────────────────────────────
// Dates: 2026-01-05 Mon, 06 Tue, 07 Wed, 08 Thu, 09 Fri, 10 Sat, 11 Sun.

function st(
  code: string,
  category: ShiftTypeRow['category'] = 'call',
  generation_engine: string | null = null,
): ShiftTypeRow {
  return {
    id: `st-${code}`, site_id: 's1', code, name: code, category,
    requires_credential: null, requires_specific_skills: [], generation_engine,
  };
}

const SHIFT_TYPES = [st('C1'), st('C2'), st('C3'), st('D1', 'regular'), st('D2', 'regular')];

function slot(over: Partial<SlotRow> = {}): SlotRow {
  return {
    id: 'slot1', site_id: 's1', slot_date: '2026-01-07',
    shift_type_id: 'st-C1', provider_group: 'physician',
    derived_day_type: 'weekday', ...over,
  };
}

function cred(over: Partial<ProviderSiteCredentials> = {}): ProviderSiteCredentials {
  return {
    provider_id: 'p1', site_id: 's1', is_active: true, credentialed: true,
    can_take_call: true, can_take_weekend_call: true, can_take_holiday_call: true,
    can_take_backup_call: true, allowed_shift_types: [], excluded_shift_types: [],
    skill_tags: [], ...over,
  };
}

function rule(over: Partial<RuleDefinition>): RuleDefinition {
  return {
    id: 'r1', rule_set_id: 'rs1', rule_name: 'test rule',
    rule_category: 'sequence', hard_constraint: true, priority_rank: 1,
    applies_to_provider_group: 'both', applies_to_shift_types: null,
    applies_to_day_types: null, condition: {}, action: {},
    explanation_text: null, is_active: true, ...over,
  };
}

function avail(over: Partial<AvailabilityRow> = {}): AvailabilityRow {
  return {
    id: 'av1', provider_id: 'p1', availability_type: 'pto',
    start_date: '2026-01-07', end_date: '2026-01-07',
    approval_status: 'approved', ...over,
  };
}

function neighbor(date: string, code: string, over: Partial<EvaluationContext['neighborAssignments'][number]> = {}) {
  const t = SHIFT_TYPES.find(s => s.code === code);
  return {
    assignment_id: `n-${date}-${code}`, slot_date: date, shift_type_code: code,
    shift_type_category: t?.category ?? 'call',
    day_type: 'weekday' as const, ...over,
  };
}

function ctx(over: Partial<EvaluationContext> = {}): EvaluationContext {
  return {
    slot: slot(), shiftType: SHIFT_TYPES[0], providerId: 'p1',
    providerGroup: 'physician', credentials: cred(), fte_value: 1, poolFlags: null,
    neighborAssignments: [], availability: [], sameDayAssignments: [],
    crossSiteAssignments: [], scheduleVersionId: 'v1', rules: [],
    shiftTypesByCode: new Map(SHIFT_TYPES.map(s => [s.code, s])),
    shiftTypesById: new Map(SHIFT_TYPES.map(s => [s.id, s])),
    ...over,
  };
}

function run(c: EvaluationContext): RuleViolation[] {
  return evaluators.flatMap(e => e(c));
}
function byCategory(c: EvaluationContext, category: string): RuleViolation[] {
  return run(c).filter(v => v.category === category);
}

// ── timeOff ──────────────────────────────────────────────────────────────────

describe('timeOff evaluator', () => {
  it('PENDING PTO blocks (clinical invariant 2)', () => {
    const v = byCategory(ctx({ availability: [avail({ approval_status: 'pending' })] }), 'time_off');
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe('hard');
    expect(v[0].rule_name).toBe('Conflicts with PTO');
  });

  it('approved PTO overlapping the slot date blocks', () => {
    const v = byCategory(ctx({ availability: [avail()] }), 'time_off');
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe('hard');
  });

  it('denied PTO passes', () => {
    const v = byCategory(ctx({ availability: [avail({ approval_status: 'denied' })] }), 'time_off');
    expect(v).toHaveLength(0);
  });

  it('canceled PTO passes', () => {
    const v = byCategory(ctx({ availability: [avail({ approval_status: 'canceled' })] }), 'time_off');
    expect(v).toHaveLength(0);
  });

  it('PTO not overlapping the slot date passes', () => {
    const v = byCategory(ctx({
      availability: [avail({ start_date: '2026-01-09', end_date: '2026-01-09' })],
    }), 'time_off');
    expect(v).toHaveLength(0);
  });

  it('no_call_request is a soft violation on call shifts', () => {
    const v = byCategory(ctx({
      availability: [avail({ availability_type: 'no_call_request' })],
    }), 'time_off');
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe('soft');
  });

  it('open slot (no provider) is skipped', () => {
    const v = byCategory(ctx({ providerId: null, availability: [avail()] }), 'time_off');
    expect(v).toHaveLength(0);
  });
});

// ── weekendAdjacentPto ───────────────────────────────────────────────────────

describe('weekendAdjacentPto evaluator', () => {
  const satCtx = (availability: AvailabilityRow[]) => ctx({
    slot: slot({ slot_date: '2026-01-10', derived_day_type: 'saturday' }),
    availability,
  });
  const violations = (c: EvaluationContext) =>
    run(c).filter(v => v.rule_name === 'Weekend call adjacent to PTO');

  it('flags Saturday call when PTO covers the week before', () => {
    const v = violations(satCtx([avail({ start_date: '2026-01-05', end_date: '2026-01-07' })]));
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe('hard');
    expect(v[0].message).toContain('week before');
  });

  it('flags Sunday call when PTO covers the week after', () => {
    const c = ctx({
      slot: slot({ slot_date: '2026-01-11', derived_day_type: 'sunday' }),
      availability: [avail({ start_date: '2026-01-13', end_date: '2026-01-15' })],
    });
    const v = violations(c);
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain('week after');
  });

  it('ignores PTO two weeks away', () => {
    expect(violations(satCtx([avail({ start_date: '2026-01-26', end_date: '2026-01-30' })]))).toHaveLength(0);
  });

  it('ignores non-bookend-extending types (sick)', () => {
    expect(violations(satCtx([
      avail({ availability_type: 'sick', start_date: '2026-01-05', end_date: '2026-01-07' }),
    ]))).toHaveLength(0);
  });

  it('does not fire on Friday slots', () => {
    const c = ctx({
      slot: slot({ slot_date: '2026-01-09', derived_day_type: 'friday' }),
      availability: [avail({ start_date: '2026-01-12', end_date: '2026-01-14' })],
    });
    expect(violations(c)).toHaveLength(0);
  });
});

// ── sequence ─────────────────────────────────────────────────────────────────

describe('sequence evaluator', () => {
  const seqRule = (over: Partial<RuleDefinition> = {}) => rule({
    rule_category: 'sequence',
    condition: { trigger_shift_code: 'C2', relationship: 'post_call' },
    action: { linked_shift_code: 'D1' },
    ...over,
  });
  const c2Ctx = (over: Partial<EvaluationContext> = {}) => ctx({
    slot: slot({ shift_type_id: 'st-C2' }),
    shiftType: SHIFT_TYPES[1], // C2
    ...over,
  });

  it('trigger with linked shift missing next day → soft violation', () => {
    const v = byCategory(c2Ctx({ rules: [seqRule()] }), 'sequence');
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe('soft');
    expect(v[0].message).toContain('2026-01-08');
  });

  it('trigger with conflicting shift next day → hard violation', () => {
    const v = byCategory(c2Ctx({
      rules: [seqRule()],
      neighborAssignments: [neighbor('2026-01-08', 'C1')],
    }), 'sequence');
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe('hard');
    expect(v[0].message).toContain('C1');
  });

  it('trigger followed by the linked shift → clean', () => {
    const v = byCategory(c2Ctx({
      rules: [seqRule()],
      neighborAssignments: [neighbor('2026-01-08', 'D1')],
    }), 'sequence');
    expect(v).toHaveLength(0);
  });

  it('honors applies_to_day_types: weekday-scoped rule does not fire on a Saturday trigger', () => {
    const v = byCategory(c2Ctx({
      rules: [seqRule({ applies_to_day_types: ['weekday'] })],
      slot: slot({ shift_type_id: 'st-C2', slot_date: '2026-01-10', derived_day_type: 'saturday' }),
    }), 'sequence');
    expect(v).toHaveLength(0);
  });

  it('honors applies_to_day_types: weekday-scoped rule still fires on a weekday trigger', () => {
    const v = byCategory(c2Ctx({
      rules: [seqRule({ applies_to_day_types: ['weekday'] })],
    }), 'sequence');
    expect(v).toHaveLength(1);
  });

  it('honors applies_to_shift_types: rule scoped to another shift code does not fire', () => {
    const v = byCategory(c2Ctx({
      rules: [seqRule({ applies_to_shift_types: ['C3'] })],
    }), 'sequence');
    expect(v).toHaveLength(0);
  });

  it('case B: non-linked shift after a trigger day → violation', () => {
    // Provider had C2 on 01-07; today (01-08) they are on C1, not D1.
    const v = byCategory(ctx({
      slot: slot({ slot_date: '2026-01-08' }),
      rules: [seqRule()],
      neighborAssignments: [neighbor('2026-01-07', 'C2')],
    }), 'sequence');
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain('should be D1');
  });

  it('case B honors applies_to_day_types of the trigger day', () => {
    // Trigger day (01-07, weekday) is out of scope for a saturday-only rule.
    const v = byCategory(ctx({
      slot: slot({ slot_date: '2026-01-08' }),
      rules: [seqRule({ applies_to_day_types: ['saturday'] })],
      neighborAssignments: [neighbor('2026-01-07', 'C2')],
    }), 'sequence');
    expect(v).toHaveLength(0);
  });
});

// ── rest ─────────────────────────────────────────────────────────────────────

describe('rest evaluator', () => {
  const restRule = (over: Partial<RuleDefinition> = {}) => rule({
    rule_category: 'rest',
    condition: { after_shift_code: 'C1', rest_type: 'day_off' },
    action: {},
    ...over,
  });

  it('case A: after-shift with next-day assignment → violation', () => {
    const v = byCategory(ctx({
      rules: [restRule()],
      neighborAssignments: [neighbor('2026-01-08', 'D2')],
    }), 'rest');
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain('D2');
  });

  it('case A: exempt next shift passes', () => {
    const v = byCategory(ctx({
      rules: [restRule({ action: { exempt_next_shift_codes: ['D2'] } })],
      neighborAssignments: [neighbor('2026-01-08', 'D2')],
    }), 'rest');
    expect(v).toHaveLength(0);
  });

  it('case B: assignment the day after the after-shift → violation', () => {
    const v = byCategory(ctx({
      slot: slot({ slot_date: '2026-01-08', shift_type_id: 'st-D2' }),
      shiftType: SHIFT_TYPES[4], // D2
      rules: [restRule()],
      neighborAssignments: [neighbor('2026-01-07', 'C1')],
    }), 'rest');
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain('rest day');
  });

  it('case B honors the prior day-type scope', () => {
    const v = byCategory(ctx({
      slot: slot({ slot_date: '2026-01-08', shift_type_id: 'st-D2' }),
      shiftType: SHIFT_TYPES[4],
      rules: [restRule({ applies_to_day_types: ['friday'] })],
      neighborAssignments: [neighbor('2026-01-07', 'C1')], // weekday trigger
    }), 'rest');
    expect(v).toHaveLength(0);
  });
});

// ── frequency ────────────────────────────────────────────────────────────────

describe('frequency evaluator', () => {
  const freqRule = (period: string, max: number) => rule({
    rule_category: 'frequency',
    condition: { shift_category: 'all_call', period },
    action: { max_count: max },
  });

  it('month period: counts assignments on both month edges', () => {
    const v = byCategory(ctx({
      rules: [freqRule('month', 2)],
      neighborAssignments: [neighbor('2026-01-01', 'C2'), neighbor('2026-01-31', 'C2')],
    }), 'frequency');
    expect(v).toHaveLength(1); // 2 neighbors + current slot = 3 > 2
    expect(v[0].details).toMatchObject({
      count: 3, max: 2, period_start: '2026-01-01', period_end: '2026-01-31',
    });
  });

  it('month period: assignments just outside the month do not count', () => {
    const v = byCategory(ctx({
      rules: [freqRule('month', 2)],
      neighborAssignments: [neighbor('2025-12-31', 'C2'), neighbor('2026-02-01', 'C2'), neighbor('2026-01-15', 'C2')],
    }), 'frequency');
    expect(v).toHaveLength(0); // 1 in-month neighbor + current = 2, not > 2
  });

  it('week period: Monday counts, previous Sunday does not', () => {
    // Slot 2026-01-07 (Wed) → week = Mon 01-05 .. Sun 01-11.
    const inWeek = byCategory(ctx({
      rules: [freqRule('week', 1)],
      neighborAssignments: [neighbor('2026-01-05', 'C2')],
    }), 'frequency');
    expect(inWeek).toHaveLength(1); // 1 + current = 2 > 1

    const outOfWeek = byCategory(ctx({
      rules: [freqRule('week', 1)],
      neighborAssignments: [neighbor('2026-01-04', 'C2')],
    }), 'frequency');
    expect(outOfWeek).toHaveLength(0);
  });
});

// ── coverage ─────────────────────────────────────────────────────────────────

describe('coverage evaluator', () => {
  const sameDay = (o: { slot_id?: string; code?: string; provider_id?: string | null; required?: number }) => ({
    slot_id: o.slot_id ?? 'slot1', slot_date: '2026-01-07',
    shift_type_code: o.code ?? 'C1', shift_type_category: 'call',
    provider_id: o.provider_id ?? null, required_count: o.required ?? 1,
  });

  it('rule-driven min_providers fires on the under-covered shift', () => {
    const v = byCategory(ctx({
      rules: [rule({
        rule_category: 'coverage',
        condition: { shift_code: 'C1' },
        action: { min_providers: 2 },
      })],
      sameDayAssignments: [
        sameDay({ provider_id: 'p1' }),
        sameDay({ slot_id: 'slot2', code: 'C2', provider_id: 'p2' }),
      ],
    }), 'coverage');
    expect(v).toHaveLength(1);
    expect(v[0].details).toMatchObject({ assigned: 1, required: 2 });
  });

  it('implicit check flags an under-filled slot (soft)', () => {
    const v = byCategory(ctx({
      sameDayAssignments: [sameDay({ provider_id: 'p1', required: 2 })],
    }), 'coverage');
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe('soft');
    expect(v[0].rule_name).toBe('Slot under-covered');
  });

  it('fully covered slot is clean', () => {
    const v = byCategory(ctx({
      sameDayAssignments: [sameDay({ provider_id: 'p1' })],
    }), 'coverage');
    expect(v).toHaveLength(0);
  });

  it('implicit check does NOT flag an under-filled REGULAR slot (open day slots are normal workflow)', () => {
    const v = byCategory(ctx({
      shiftType: SHIFT_TYPES[3], // D1, regular
      sameDayAssignments: [sameDay({ code: 'D1', provider_id: null })],
    }), 'coverage');
    expect(v).toHaveLength(0);
  });

  it('implicit check still flags an under-filled CALL slot', () => {
    const v = byCategory(ctx({
      sameDayAssignments: [sameDay({ provider_id: null })],
    }), 'coverage');
    expect(v).toHaveLength(1);
    expect(v[0].rule_name).toBe('Slot under-covered');
  });

  it('rule-driven coverage rule still fires on a REGULAR shift (explicit rules stay category-blind)', () => {
    const v = byCategory(ctx({
      shiftType: SHIFT_TYPES[3], // D1, regular
      rules: [rule({
        rule_category: 'coverage',
        condition: { shift_code: 'D1' },
        action: { min_providers: 1 },
      })],
      sameDayAssignments: [sameDay({ code: 'D1', provider_id: null })],
    }), 'coverage');
    expect(v).toHaveLength(1);
    expect(v[0].details).toMatchObject({ assigned: 0, required: 1 });
  });
});

// ── pairing ──────────────────────────────────────────────────────────────────

describe('pairing evaluator', () => {
  const pairRule = () => rule({
    rule_category: 'pairing',
    condition: { primary_shift_code: 'C1' },
    action: { required_backup_code: 'C2' },
  });
  const sameDay = (code: string, provider_id: string | null) => ({
    slot_id: `slot-${code}`, slot_date: '2026-01-07', shift_type_code: code,
    shift_type_category: 'call', provider_id, required_count: 1,
  });

  it('primary without an assigned backup on the same day → violation', () => {
    const v = byCategory(ctx({
      rules: [pairRule()],
      sameDayAssignments: [sameDay('C1', 'p1'), sameDay('C2', null)],
    }), 'pairing');
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain('C2');
  });

  it('primary with backup assigned → clean', () => {
    const v = byCategory(ctx({
      rules: [pairRule()],
      sameDayAssignments: [sameDay('C1', 'p1'), sameDay('C2', 'p2')],
    }), 'pairing');
    expect(v).toHaveLength(0);
  });
});

// ── fairness (per-FTE) ───────────────────────────────────────────────────────

describe('fairness evaluator', () => {
  const fairRule = () => rule({
    rule_category: 'fairness',
    condition: { burden_category: 'all_call' },
    action: { distribution_method: 'equal' },
  });
  const fourCalls = (over: Partial<EvaluationContext> = {}) => ctx({
    rules: [fairRule()],
    // 3 in-month call neighbors + the current call slot = 4
    neighborAssignments: [
      neighbor('2026-01-10', 'C2'), neighbor('2026-01-15', 'C2'), neighbor('2026-01-20', 'C2'),
    ],
    ...over,
  });

  it('scales by FTE: 0.5-FTE provider with 4 calls flags (threshold ceil(6*0.5)=3)', () => {
    const v = byCategory(fourCalls({ fte_value: 0.5 }), 'fairness');
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe('soft');
    expect(v[0].details).toMatchObject({ count: 4, threshold: 3 });
  });

  it('1.0-FTE provider with 4 calls does not flag (threshold 6)', () => {
    expect(byCategory(fourCalls({ fte_value: 1.0 }), 'fairness')).toHaveLength(0);
  });

  it('missing fte_value is treated as 1.0', () => {
    expect(byCategory(fourCalls({ fte_value: null }), 'fairness')).toHaveLength(0);
  });

  it('1.0-FTE provider over the base threshold still flags', () => {
    const neighbors = ['2026-01-02', '2026-01-05', '2026-01-10', '2026-01-15', '2026-01-20', '2026-01-25']
      .map(d => neighbor(d, 'C2'));
    const v = byCategory(fourCalls({ fte_value: 1.0, neighborAssignments: neighbors }), 'fairness');
    expect(v).toHaveLength(1); // 6 + current = 7 > 6
    expect(v[0].details).toMatchObject({ count: 7, threshold: 6 });
  });
});

// ── openSlot ─────────────────────────────────────────────────────────────────

describe('openSlot evaluator', () => {
  it('flags an unassigned slot (soft)', () => {
    const v = byCategory(ctx({ providerId: null, credentials: null, providerGroup: null }), 'open_slot');
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe('soft');
    expect(v[0].rule_name).toBe('Open slot');
  });

  it('assigned slot is clean', () => {
    expect(byCategory(ctx(), 'open_slot')).toHaveLength(0);
  });

  it('escalates via a rule deadline', () => {
    const v = byCategory(ctx({
      providerId: null, credentials: null, providerGroup: null,
      rules: [rule({
        rule_category: 'open_slot',
        action: { days_before_slot: 100000 },
        hard_constraint: true,
      })],
    }), 'open_slot');
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe('hard');
  });

  it('open CALL slot → soft violation still emitted', () => {
    const v = byCategory(ctx({
      providerId: null, credentials: null, providerGroup: null,
      shiftType: st('C1', 'call'),
    }), 'open_slot');
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe('soft');
    expect(v[0].rule_name).toBe('Open slot');
  });

  it('open REGULAR (day) slot → NO soft open_slot violation', () => {
    const v = byCategory(ctx({
      providerId: null, credentials: null, providerGroup: null,
      shiftType: st('D1', 'regular'),
    }), 'open_slot');
    expect(v).toHaveLength(0);
  });

  it('deadline escalation is category-blind — fires for an open regular slot', () => {
    const v = byCategory(ctx({
      providerId: null, credentials: null, providerGroup: null,
      shiftType: st('D1', 'regular'),
      rules: [rule({
        rule_category: 'open_slot',
        action: { days_before_slot: 100000 },
        hard_constraint: true,
      })],
    }), 'open_slot');
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe('hard');
  });
});

// ── crossSite ────────────────────────────────────────────────────────────────

describe('crossSite evaluator', () => {
  const xs = (site: string) => ({
    assignment_id: `x-${site}`, site_id: site, slot_date: '2026-01-07', shift_type_code: 'C1',
  });

  it('two sites on the same day → hard violation', () => {
    const v = byCategory(ctx({ crossSiteAssignments: [xs('s1'), xs('s2')] }), 'cross_site');
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe('hard');
    expect(v[0].details).toMatchObject({ sites: ['s1', 's2'] });
  });

  it('allow_multi_site rule suppresses the violation', () => {
    const v = byCategory(ctx({
      crossSiteAssignments: [xs('s1'), xs('s2')],
      rules: [rule({ rule_category: 'cross_site', action: { allow_multi_site: true } })],
    }), 'cross_site');
    expect(v).toHaveLength(0);
  });

  it('single site is clean', () => {
    expect(byCategory(ctx({ crossSiteAssignments: [xs('s1')] }), 'cross_site')).toHaveLength(0);
  });
});

// ── eligibility ──────────────────────────────────────────────────────────────

describe('eligibility evaluator', () => {
  it('inactive provider → hard violation', () => {
    const v = byCategory(ctx({ credentials: cred({ is_active: false }) }), 'eligibility');
    expect(v.some(x => x.rule_name === 'Provider inactive at site' && x.severity === 'hard')).toBe(true);
  });

  it('missing credentials row is treated as not-yet-configured (clean)', () => {
    expect(byCategory(ctx({ credentials: null }), 'eligibility')).toHaveLength(0);
  });

  it('has_skill requirement missing from skill_tags → violation', () => {
    const v = byCategory(ctx({
      rules: [rule({
        rule_category: 'eligibility',
        condition: { requirement_type: 'has_skill' },
        action: { required_value: 'hearts' },
        hard_constraint: false,
      })],
    }), 'eligibility');
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe('soft');
  });

  it('unknown requirement_type → warning-severity violation, never a silent skip', () => {
    const v = byCategory(ctx({
      rules: [rule({
        rule_category: 'eligibility',
        condition: { requirement_type: 'quantum_flux' },
        action: {},
      })],
    }), 'eligibility');
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe('warning');
    expect(v[0].message).toBe('Unknown rule vocabulary: quantum_flux');
  });
});

// ── poolEligibility ──────────────────────────────────────────────────────────
// Asymmetric rule keyed on generation_engine + category, never code names:
// call-engine-owned NON-call slots (D1–D9 on live data) are reserved for call
// takers; day-pool slots (generation_engine 'day_pool', e.g. 7-3/7-5) are
// auto-generated for day docs but call takers may legitimately hold them.

describe('poolEligibility evaluator', () => {
  const DAY_DOC = { call_taker: false, partial_call_taker: false, is_day_doc: true };
  const CALL_TAKER = { call_taker: true, partial_call_taker: false, is_day_doc: false };
  const PARTIAL = { call_taker: false, partial_call_taker: true, is_day_doc: false };
  const NEITHER = { call_taker: false, partial_call_taker: false, is_day_doc: false };

  const dCode = st('D5', 'regular', 'call'); // derived/relief D-code owned by call engine
  const dayPool = st('7-3', 'regular', 'day_pool'); // day-doc slot
  const poolViolations = (c: EvaluationContext) =>
    run(c).filter(v => v.rule_name === 'Pool eligibility');

  it('day doc on a D-code → hard, message mentions call takers', () => {
    const v = poolViolations(ctx({ shiftType: dCode, poolFlags: DAY_DOC }));
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe('hard');
    expect(v[0].category).toBe('eligibility');
    expect(v[0].message).toContain('reserved for call takers');
    expect(v[0].message).toContain('D5');
  });

  it('call taker on a day-pool slot → NO violation (legitimate pickup)', () => {
    expect(poolViolations(ctx({ shiftType: dayPool, poolFlags: CALL_TAKER }))).toHaveLength(0);
  });

  it('day doc on a day-pool slot → no violation', () => {
    expect(poolViolations(ctx({ shiftType: dayPool, poolFlags: DAY_DOC }))).toHaveLength(0);
  });

  it('call taker on a D-code → no violation', () => {
    expect(poolViolations(ctx({ shiftType: dCode, poolFlags: CALL_TAKER }))).toHaveLength(0);
  });

  it('partial call taker satisfies both pools', () => {
    expect(poolViolations(ctx({ shiftType: dCode, poolFlags: PARTIAL }))).toHaveLength(0);
    expect(poolViolations(ctx({ shiftType: dayPool, poolFlags: PARTIAL }))).toHaveLength(0);
  });

  it('neither-flag provider on a day-pool slot → hard (neither Day Doc nor call taker)', () => {
    const v = poolViolations(ctx({ shiftType: dayPool, poolFlags: NEITHER }));
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe('hard');
    expect(v[0].message).toContain('neither a Day Doc nor a call taker');
  });

  it('neither-flag provider on a D-code → hard', () => {
    const v = poolViolations(ctx({ shiftType: dCode, poolFlags: NEITHER }));
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe('hard');
    expect(v[0].message).toContain('reserved for call takers');
  });

  it('null poolFlags (no profile) on a D-code → hard, mentions missing profile', () => {
    const v = poolViolations(ctx({ shiftType: dCode, poolFlags: null }));
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe('hard');
    expect(v[0].message).toContain('no employment profile');
  });

  it('null poolFlags (no profile) on a day-pool slot → hard, mentions missing profile', () => {
    const v = poolViolations(ctx({ shiftType: dayPool, poolFlags: null }));
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe('hard');
    expect(v[0].message).toContain('no employment profile');
  });

  it('open slot (no provider) → no violation', () => {
    const v = poolViolations(ctx({
      providerId: null, credentials: null, providerGroup: null,
      shiftType: dCode, poolFlags: null,
    }));
    expect(v).toHaveLength(0);
  });

  it('a call-CATEGORY slot (C1, engine call) → no violation regardless of flags', () => {
    // Call slots have their own pool gating at generation — excluded here by
    // category, not by code name.
    const c1 = st('C1', 'call', 'call');
    expect(poolViolations(ctx({ shiftType: c1, poolFlags: DAY_DOC }))).toHaveLength(0);
    expect(poolViolations(ctx({ shiftType: c1, poolFlags: NEITHER }))).toHaveLength(0);
    expect(poolViolations(ctx({ shiftType: c1, poolFlags: null }))).toHaveLength(0);
  });

  it('a regular slot without a generation_engine is not gated (engine+category key the rule)', () => {
    const orphanD = st('D5', 'regular', null);
    expect(poolViolations(ctx({ shiftType: orphanD, poolFlags: DAY_DOC }))).toHaveLength(0);
  });

  it('a call-owned non-call slot NOT named D* is still gated (no code-name pattern)', () => {
    const r1 = st('R1', 'regular', 'call'); // future call-derived code
    const v = poolViolations(ctx({ shiftType: r1, poolFlags: DAY_DOC }));
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe('hard');
    expect(v[0].message).toContain('reserved for call takers');
  });
});
