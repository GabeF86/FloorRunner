// Pure evaluator tests — hand-built EvaluationContext fixtures, no DB.
// One describe per evaluator. Violations are isolated by category (and
// rule_name where two evaluators share a category, e.g. time_off).
import { describe, it, expect } from 'vitest';
import { evaluators } from './evaluators';
import type {
  EvaluationContext,
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
    crossSiteAssignments: [], scheduleVersionId: 'v1',
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

  // pto_sellback date-level override (2026-07-20): a live sell-back row on the
  // slot date means the provider IS WORKING — a PTO violation on that date
  // would be wrong (the assignment is exactly what the sell-back sanctions).
  it('a live pto_sellback covering the slot date suppresses the PTO flag', () => {
    const v = byCategory(ctx({
      availability: [
        avail({ start_date: '2026-01-05', end_date: '2026-01-09' }), // PTO week over slot 01-07
        avail({ id: 'av2', availability_type: 'pto_sellback' }),      // sold-back 01-07
      ],
    }), 'time_off');
    expect(v).toHaveLength(0);
  });

  it('sell-back suppresses PENDING PTO too, but only on covered dates', () => {
    // Slot on 01-07 sold back → clean; identical ctx on 01-08 still flags.
    const rows = (slotDate: string) => ctx({
      slot: slot({ slot_date: slotDate }),
      availability: [
        avail({ start_date: '2026-01-05', end_date: '2026-01-09', approval_status: 'pending' }),
        avail({ id: 'av2', availability_type: 'pto_sellback' }), // covers 01-07 only
      ],
    });
    expect(byCategory(rows('2026-01-07'), 'time_off')).toHaveLength(0);
    expect(byCategory(rows('2026-01-08'), 'time_off')).toHaveLength(1);
  });

  it('a dismissed sell-back row does not suppress the PTO flag', () => {
    const v = byCategory(ctx({
      availability: [
        avail({ start_date: '2026-01-05', end_date: '2026-01-09' }),
        avail({ id: 'av2', availability_type: 'pto_sellback', approval_status: 'canceled' }),
      ],
    }), 'time_off');
    expect(v).toHaveLength(1);
  });

  it('a sell-back row alone raises no time_off violation', () => {
    const v = byCategory(ctx({
      availability: [avail({ availability_type: 'pto_sellback' })],
    }), 'time_off');
    expect(v).toHaveLength(0);
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

// ── coverage ─────────────────────────────────────────────────────────────────

describe('coverage evaluator', () => {
  const sameDay = (o: { slot_id?: string; code?: string; provider_id?: string | null; required?: number }) => ({
    slot_id: o.slot_id ?? 'slot1', slot_date: '2026-01-07',
    shift_type_code: o.code ?? 'C1', shift_type_category: 'call',
    provider_id: o.provider_id ?? null, required_count: o.required ?? 1,
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

  // 2026-07-20 live bug: the manual-edit path evaluates BEFORE writing, so
  // the slot's DB row shows no provider at eval time. The being-assigned
  // provider (ctx.providerId) must count toward coverage or every manual
  // call assignment gets a stale "0 assigned" flag.
  it('implicit check credits the in-flight assignment (evaluate-before-write)', () => {
    const v = byCategory(ctx({
      providerId: 'p1',
      sameDayAssignments: [sameDay({ provider_id: null })], // DB row pre-write
    }), 'coverage');
    expect(v).toHaveLength(0);
  });

  it('in-flight credit does not double-count a post-write re-evaluation', () => {
    // required 2, DB already shows p1 (post-write): still under-covered by 1.
    const v = byCategory(ctx({
      providerId: 'p1',
      sameDayAssignments: [
        sameDay({ provider_id: 'p1', required: 2 }),
      ],
    }), 'coverage');
    expect(v).toHaveLength(1);
    expect(v[0].rule_name).toBe('Slot under-covered');
  });

  it('implicit check still flags a genuinely OPEN under-filled CALL slot', () => {
    // providerId null = evaluating the open row itself (batch validation) —
    // no in-flight assignment to credit; the previous version of this test
    // set a ctx provider against an empty slot, which pinned the very
    // evaluate-before-write bug fixed on 2026-07-20.
    const v = byCategory(ctx({
      providerId: null,
      sameDayAssignments: [sameDay({ provider_id: null })],
    }), 'coverage');
    expect(v).toHaveLength(1);
    expect(v[0].rule_name).toBe('Slot under-covered');
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

});

// ── poolEligibility ──────────────────────────────────────────────────────────
// Rule keyed on generation_engine + category, never code names:
// call-engine-owned NON-call slots (D1–D9 on live data) are reserved for call
// takers. Day-pool slots (generation_engine 'day_pool', e.g. 7-3/7-5) are
// reserved for Day Docs — Gabriel 2026-07-21 (supersedes the 2026-07-14
// generic-pickup allowance): call takers "should never be placed there unless
// they are selling back PTO", so a non-Day-Doc holder is clean ONLY when a
// live pto_sellback row covers the slot date (shared isSellbackOverridden).

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

  it('call taker on a day-pool slot with NO sell-back → HARD (Gabriel 2026-07-21)', () => {
    const v = poolViolations(ctx({ shiftType: dayPool, poolFlags: CALL_TAKER }));
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe('hard');
    expect(v[0].category).toBe('eligibility');
    expect(v[0].message).toContain('selling back PTO');
  });

  it('call taker on a day-pool slot WITH a live sell-back covering the date → clean', () => {
    const v = poolViolations(ctx({
      shiftType: dayPool, poolFlags: CALL_TAKER,
      // avail() default dates cover the slot date 2026-01-07.
      availability: [avail({ availability_type: 'pto_sellback' })],
    }));
    expect(v).toHaveLength(0);
  });

  it('a sell-back on a DIFFERENT date does not excuse the day shift → hard', () => {
    const v = poolViolations(ctx({
      shiftType: dayPool, poolFlags: CALL_TAKER,
      availability: [avail({ availability_type: 'pto_sellback', start_date: '2026-01-09', end_date: '2026-01-09' })],
    }));
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe('hard');
  });

  it('a DENIED sell-back row is dead → hard (isActiveSellback polarity)', () => {
    const v = poolViolations(ctx({
      shiftType: dayPool, poolFlags: CALL_TAKER,
      availability: [avail({ availability_type: 'pto_sellback', approval_status: 'denied' })],
    }));
    expect(v).toHaveLength(1);
  });

  it('day doc on a day-pool slot → no violation', () => {
    expect(poolViolations(ctx({ shiftType: dayPool, poolFlags: DAY_DOC }))).toHaveLength(0);
  });

  it('call taker on a D-code → no violation (D-code side unchanged)', () => {
    expect(poolViolations(ctx({ shiftType: dCode, poolFlags: CALL_TAKER }))).toHaveLength(0);
  });

  it('partial call taker: D-code clean, day-pool hard without a sell-back', () => {
    expect(poolViolations(ctx({ shiftType: dCode, poolFlags: PARTIAL }))).toHaveLength(0);
    const v = poolViolations(ctx({ shiftType: dayPool, poolFlags: PARTIAL }));
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe('hard');
  });

  it('neither-flag provider on a day-pool slot → hard', () => {
    const v = poolViolations(ctx({ shiftType: dayPool, poolFlags: NEITHER }));
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe('hard');
    expect(v[0].message).toContain('selling back PTO');
  });

  it('no profile but a live sell-back covering the date → clean (chief-entered decision wins)', () => {
    const v = poolViolations(ctx({
      shiftType: dayPool, poolFlags: null,
      availability: [avail({ availability_type: 'pto_sellback' })],
    }));
    expect(v).toHaveLength(0);
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

// ── shiftSkills ──────────────────────────────────────────────────────────────
//
// Replaces the skills check that used to live inside the rule-definitions
// loop. The difference that matters: it reads the SHIFT TYPE's own
// requires_specific_skills column, so filling that column is now sufficient.
// Before, a site could fill it in and get no enforcement, because the check
// was driven by a separate rule's required_value and the column was inert.
describe('shiftSkills evaluator', () => {
  const neuro = { ...SHIFT_TYPES[0], code: 'C3', requires_specific_skills: ['neuro_call'] };

  it('flags a provider who lacks a required skill', () => {
    const v = byCategory(ctx({ shiftType: neuro, credentials: cred({ skill_tags: [] }) }), 'eligibility');
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe('hard');
    expect(v[0].message).toContain('"neuro_call"');
    expect(v[0].message).toContain('C3');
  });

  it('passes a provider who holds it', () => {
    const v = byCategory(ctx({ shiftType: neuro, credentials: cred({ skill_tags: ['neuro_call'] }) }), 'eligibility');
    expect(v).toHaveLength(0);
  });

  it('names only the MISSING skills when several are required', () => {
    const both = { ...neuro, requires_specific_skills: ['neuro_call', 'peds'] };
    const v = byCategory(ctx({ shiftType: both, credentials: cred({ skill_tags: ['neuro_call'] }) }), 'eligibility');
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain('"peds"');
    expect(v[0].message).not.toContain('neuro_call');
  });

  it('is SILENT when the shift requires nothing', () => {
    // Every shift type in the live database has an empty list today, so this
    // is the case that must stay quiet — a check introduced over live data
    // that immediately flags everyone is a check people switch off.
    const v = byCategory(ctx({ credentials: cred({ skill_tags: [] }) }), 'eligibility');
    expect(v.filter(x => x.rule_name === 'Shift skill requirement')).toHaveLength(0);
  });

  it('stays silent when the provider has no credentials row at all', () => {
    // "Not yet configured" rather than "denied" — the same opt-in stance the
    // eligibility evaluator takes. Flagging here would light up every provider
    // at a site that has not filled credentials in.
    const v = byCategory(ctx({ shiftType: neuro, credentials: null }), 'eligibility');
    expect(v.filter(x => x.rule_name === 'Shift skill requirement')).toHaveLength(0);
  });

  it('does not fire on an unassigned slot', () => {
    const v = byCategory(ctx({ shiftType: neuro, providerId: null }), 'eligibility');
    expect(v.filter(x => x.rule_name === 'Shift skill requirement')).toHaveLength(0);
  });
});

// ── backupPairing ────────────────────────────────────────────────────────────
//
// Replaces the old "C1 Requires C2 Backup" rule, which named its partner
// explicitly and therefore only ever worked at the one site that wrote it. The
// partner is derived from call_rank here, so "first call needs second call
// behind it" holds anywhere without restating which code that is.
describe('backupPairing evaluator', () => {
  const C1 = { ...st('C1'), call_rank: 0, requires_backup_pairing: true };
  const C2 = { ...st('C2'), call_rank: 1 };
  const C3 = { ...st('C3'), call_rank: 2 };
  const byCode = new Map<string, ShiftTypeRow>([['C1', C1], ['C2', C2], ['C3', C3]]);

  const sameDay = (over: Array<{ code: string; provider: string | null }>) =>
    over.map((o, i) => ({
      slot_id: `s${i}`, slot_date: '2026-01-07', shift_type_code: o.code,
      shift_type_category: 'call', provider_id: o.provider, required_count: 1,
    }));

  const at = (over: Partial<EvaluationContext> = {}) =>
    byCategory(ctx({ shiftType: C1, shiftTypesByCode: byCode, ...over }), 'pairing');

  it('flags a filled C1 whose C2 slot is open', () => {
    // The live case: the published Paoli schedule has 9 days like this.
    const v = at({ sameDayAssignments: sameDay([{ code: 'C1', provider: 'p1' }, { code: 'C2', provider: null }]) });
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe('hard');
    expect(v[0].message).toContain('no C2 beside it');
  });

  it('passes when the C2 is filled', () => {
    expect(at({ sameDayAssignments: sameDay([{ code: 'C1', provider: 'p1' }, { code: 'C2', provider: 'p2' }]) }))
      .toHaveLength(0);
  });

  it('derives the partner from RANK, not from the code name', () => {
    // A site whose second call is called something else must still be covered.
    const alt = { ...st('BACKUP'), call_rank: 1 };
    const v = byCategory(ctx({
      shiftType: C1,
      shiftTypesByCode: new Map<string, ShiftTypeRow>([['C1', C1], ['BACKUP', alt]]),
      sameDayAssignments: sameDay([{ code: 'BACKUP', provider: null }]),
    }), 'pairing');
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain('no BACKUP beside it');
  });

  it('picks the NEXT rank down, not the lowest-ranked call', () => {
    // With C2 filled, an empty C3 must not be read as the missing backup.
    expect(at({ sameDayAssignments: sameDay([
      { code: 'C2', provider: 'p2' }, { code: 'C3', provider: null },
    ]) })).toHaveLength(0);
  });

  it('is SILENT when no backup slot exists that day', () => {
    // A missing SLOT is a template question, and coverage/openSlot already
    // speak to it. Saying it twice in different words trains people to skim.
    expect(at({ sameDayAssignments: sameDay([{ code: 'C1', provider: 'p1' }]) })).toHaveLength(0);
  });

  it('does not fire for a shift that needs no backup', () => {
    // C2 at Paoli — it IS the backup, and flagging it would have produced a
    // false alarm on every single C2 day.
    expect(byCategory(ctx({
      shiftType: C2, shiftTypesByCode: byCode,
      sameDayAssignments: sameDay([{ code: 'C3', provider: null }]),
    }), 'pairing')).toHaveLength(0);
  });

  it('does not fire on an unassigned slot', () => {
    expect(at({ providerId: null, sameDayAssignments: sameDay([{ code: 'C2', provider: null }]) }))
      .toHaveLength(0);
  });

  it('stays quiet when call_rank is absent (pre-patch18 load)', () => {
    const noRank = { ...st('C1'), requires_backup_pairing: true };
    expect(byCategory(ctx({
      shiftType: noRank,
      shiftTypesByCode: new Map<string, ShiftTypeRow>([['C1', noRank], ['C2', C2]]),
      sameDayAssignments: sameDay([{ code: 'C2', provider: null }]),
    }), 'pairing')).toHaveLength(0);
  });
});
