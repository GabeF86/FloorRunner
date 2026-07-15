// The `evaluated` flag (clinical invariant 6): validation must never silently
// report clean on failure. An unloadable context or a throwing evaluator must
// yield evaluated:false, and write-sites must NOT persist validation_flags.
import { describe, it, expect, vi } from 'vitest';
import { evaluateAssignment, evaluateContext, validationFlagsFor } from './evaluate';
import { commitValidation } from './commit';
import { loadSiteValidationContext } from './loadContext';
import type { SiteValidationContext } from './loadContext';
import { makeFakeSupabase, callsFor } from './__fixtures__/fakeSupabase';
import type { Filter, TableCfg } from './__fixtures__/fakeSupabase';
import type { EvaluationContext, ShiftTypeRow } from './types';

function st(code: string, category: ShiftTypeRow['category'] = 'call'): ShiftTypeRow {
  return {
    id: `st-${code}`, site_id: 's1', code, name: code, category,
    requires_credential: null, requires_specific_skills: [], generation_engine: null,
  };
}
const C1 = st('C1');
const siteCtx: SiteValidationContext = {
  shiftTypesById: new Map([[C1.id, C1]]),
  shiftTypesByCode: new Map([[C1.code, C1]]),
  rules: [],
};

const SLOT = {
  id: 'sA', site_id: 's1', slot_date: '2026-01-07', shift_type_id: 'st-C1',
  provider_group: 'physician' as const, derived_day_type: 'weekday' as const,
  schedule_version_id: 'v1', required_count: 1,
};

function baseCtx(over: Partial<EvaluationContext> = {}): EvaluationContext {
  return {
    slot: SLOT, shiftType: C1, providerId: 'p1', providerGroup: 'physician',
    credentials: {
      provider_id: 'p1', site_id: 's1', is_active: true, credentialed: true,
      can_take_call: true, can_take_weekend_call: true, can_take_holiday_call: true,
      can_take_backup_call: true, allowed_shift_types: [], excluded_shift_types: [],
      skill_tags: [],
    },
    fte_value: 1, poolFlags: null, neighborAssignments: [], availability: [],
    sameDayAssignments: [], crossSiteAssignments: [], scheduleVersionId: 'v1',
    rules: [], shiftTypesByCode: siteCtx.shiftTypesByCode, shiftTypesById: siteCtx.shiftTypesById,
    ...over,
  };
}

describe('evaluated flag', () => {
  it('loadContext returning null → evaluated:false, zero violations', async () => {
    const { sb } = makeFakeSupabase({ tables: { schedule_slots: { data: null, error: null } } });
    const res = await evaluateAssignment(sb, 'missing-slot', 'p1', siteCtx);
    expect(res.evaluated).toBe(false);
    expect(res.violations).toEqual([]);
  });

  it('an evaluator throw → evaluated:false but other violations survive', () => {
    // availability:null makes timeOff/weekendAdjacentPto throw; the inactive
    // credential still yields an eligibility violation from an earlier evaluator.
    const poisoned = baseCtx({
      availability: null as unknown as EvaluationContext['availability'],
      credentials: { ...baseCtx().credentials!, is_active: false },
    });
    const { violations, evaluated } = evaluateContext(poisoned);
    expect(evaluated).toBe(false);
    expect(violations.some(v => v.rule_name === 'Provider inactive at site')).toBe(true);
  });

  it('clean run → evaluated:true', () => {
    const { evaluated } = evaluateContext(baseCtx());
    expect(evaluated).toBe(true);
  });

  it('dedupes repeated evaluator-throw logging by evaluator name (shared set)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const poisoned = () => baseCtx({
        availability: null as unknown as EvaluationContext['availability'],
      });
      const seen = new Set<string>();
      evaluateContext(poisoned(), seen);
      const afterFirst = spy.mock.calls.length;
      expect(afterFirst).toBeGreaterThan(0); // the throwing evaluators logged once
      evaluateContext(poisoned(), seen);
      evaluateContext(poisoned(), seen);
      expect(spy.mock.calls.length).toBe(afterFirst); // no repeat spam
      // Without a shared set, each call logs again (serial path unchanged).
      evaluateContext(poisoned());
      expect(spy.mock.calls.length).toBe(afterFirst * 2);
    } finally {
      spy.mockRestore();
    }
  });

  it('evaluateAssignment surfaces evaluated:true on a loadable context', async () => {
    const { sb } = makeFakeSupabase({
      tables: {
        schedule_slots: (filters: Filter[]) => {
          const eqId = filters.find(f => f.method === 'eq' && f.args[0] === 'id');
          if (eqId) return { data: SLOT, error: null };
          return { data: [{ ...SLOT, assignments: [{ provider_id: null }] }], error: null };
        },
        providers: { data: { id: 'p1', provider_type: 'physician', provider_employment_profiles: { fte_value: 0.5 } }, error: null },
        provider_site_credentials: { data: null, error: null },
        provider_availability: { data: [], error: null },
        assignments: { data: [], error: null },
      },
    });
    const res = await evaluateAssignment(sb, 'sA', 'p1', siteCtx);
    expect(res.evaluated).toBe(true);
  });
});

describe('loadContext fail-closed (serial provider-section query failures)', () => {
  // A transient failure on ANY context query must yield evaluated:false —
  // silently-empty availability would validate clean over PTO (invariants 2/6),
  // a failed cross-site query would hide double-booking (invariant 3).
  const failure = { data: null, error: { message: 'db down' } };
  const okTables = (): Record<string, TableCfg> => ({
    schedule_slots: (filters: Filter[]) => {
      const eqId = filters.find(f => f.method === 'eq' && f.args[0] === 'id');
      if (eqId) return { data: SLOT, error: null };
      return { data: [], error: null }; // sameDay branch
    },
    providers: { data: { id: 'p1', provider_type: 'physician', provider_employment_profiles: { fte_value: 1 } }, error: null },
    provider_site_credentials: { data: null, error: null },
    provider_availability: { data: [], error: null },
    assignments: { data: [], error: null },
  });

  const cases: Array<[string, Record<string, TableCfg>]> = [
    ['provider row', { ...okTables(), providers: failure }],
    ['credentials', { ...okTables(), provider_site_credentials: failure }],
    ['availability', { ...okTables(), provider_availability: failure }],
    ['neighbors', {
      ...okTables(),
      assignments: (filters: Filter[]) =>
        filters.some(f => f.method === 'gte') ? failure : { data: [], error: null },
    }],
    ['cross-site', {
      ...okTables(),
      assignments: (filters: Filter[]) =>
        filters.some(f => f.method === 'gte') ? { data: [], error: null } : failure,
    }],
    ['same-day slots', {
      ...okTables(),
      schedule_slots: (filters: Filter[]) => {
        const eqId = filters.find(f => f.method === 'eq' && f.args[0] === 'id');
        return eqId ? { data: SLOT, error: null } : failure;
      },
    }],
  ];

  for (const [name, tables] of cases) {
    it(`${name} query failure → evaluated:false, no clean flags to write`, async () => {
      const { sb, calls } = makeFakeSupabase({ tables });
      const res = await evaluateAssignment(sb, 'sA', 'p1', siteCtx);
      expect(res.evaluated).toBe(false);
      expect(res.violations).toEqual([]);
      // evaluateAssignment never writes; the guarded write-sites skip on
      // !evaluated (tested elsewhere) — but assert nothing wrote here either.
      expect(callsFor(calls, 'assignments', 'update')).toHaveLength(0);
      expect(callsFor(calls, 'assignments', 'upsert')).toHaveLength(0);
    });
  }

  it('sanity: same fake with no failures → evaluated:true', async () => {
    const { sb } = makeFakeSupabase({ tables: okTables() });
    const res = await evaluateAssignment(sb, 'sA', 'p1', siteCtx);
    expect(res.evaluated).toBe(true);
  });

  // Live DB: UNIQUE(schedule_slot_id) → PostgREST returns the same-day slots'
  // assignments embed as ONE OBJECT, not an array. The sameDayAssignments
  // parse seam must normalize (an object here used to throw → evaluation dead).
  it('single-OBJECT assignments embed on the same-day slots read (live one-to-one shape) still evaluates', async () => {
    const { sb } = makeFakeSupabase({
      tables: {
        ...okTables(),
        schedule_slots: (filters: Filter[]) => {
          const eqId = filters.find(f => f.method === 'eq' && f.args[0] === 'id');
          if (eqId) return { data: SLOT, error: null };
          // sameDay branch: object-shaped embed, as the live DB returns it
          return { data: [{ ...SLOT, assignments: { provider_id: 'p1' } }], error: null };
        },
      },
    });
    const res = await evaluateAssignment(sb, 'sA', 'p1', siteCtx);
    expect(res.evaluated).toBe(true);
  });
});

describe('loadContext neighbor scoping', () => {
  it('scopes the neighbor query to the slot version+site; cross-site query stays unscoped', async () => {
    const { sb, calls } = makeFakeSupabase({
      tables: {
        schedule_slots: (filters: Filter[]) => {
          const eqId = filters.find(f => f.method === 'eq' && f.args[0] === 'id');
          if (eqId) return { data: SLOT, error: null };
          return { data: [], error: null };
        },
        providers: { data: { id: 'p1', provider_type: 'physician', provider_employment_profiles: { fte_value: 1 } }, error: null },
        provider_site_credentials: { data: null, error: null },
        provider_availability: { data: [], error: null },
        assignments: { data: [], error: null },
      },
    });
    await evaluateAssignment(sb, 'sA', 'p1', siteCtx);

    const versionScopes = calls.filter(
      c => c.table === 'assignments' && c.method === 'eq' && c.args[0] === 'schedule_slots.schedule_version_id',
    );
    const siteScopes = calls.filter(
      c => c.table === 'assignments' && c.method === 'eq' && c.args[0] === 'schedule_slots.site_id',
    );
    // Exactly one assignments query (the neighbor window) carries each scope —
    // the cross-site double-booking query must remain unscoped.
    expect(versionScopes).toHaveLength(1);
    expect(versionScopes[0].args[1]).toBe('v1');
    expect(siteScopes).toHaveLength(1);
    expect(siteScopes[0].args[1]).toBe('s1');
    expect(calls.filter(c => c.table === 'assignments' && c.method === 'from').length).toBe(2);
  });
});

describe('commitValidation (write-site guard)', () => {
  const SITE_TABLES: Record<string, TableCfg> = {
    shift_types: {
      data: [{ id: 'st-C1', site_id: 's1', code: 'C1', name: 'C1', category: 'call', requires_credential: null, requires_specific_skills: [] }],
      error: null,
    },
    rule_sets: { data: [], error: null },
  };

  it('does NOT write validation_flags when an assignment cannot be evaluated', async () => {
    const { sb, calls } = makeFakeSupabase({
      tables: {
        ...SITE_TABLES,
        // Slot references a shift type the site context doesn't know →
        // context unavailable → evaluated:false → no write.
        schedule_slots: {
          data: [{
            ...SLOT, shift_type_id: 'st-UNKNOWN',
            assignments: [{ id: 'a1', provider_id: 'p1', assignment_status: 'assigned' }],
          }],
          error: null,
        },
        providers: { data: [], error: null },
        provider_availability: { data: [], error: null },
        provider_site_credentials: { data: [], error: null },
        assignments: { data: [], error: null },
      },
    });
    const res = await commitValidation(sb, 's1', 'v1');
    expect(callsFor(calls, 'assignments', 'upsert')).toHaveLength(0);
    expect(callsFor(calls, 'assignments', 'update')).toHaveLength(0);
    expect(res.errors.length).toBeGreaterThan(0);
    expect(res.errors.join(' ')).toContain('validation-unavailable');
  });

  it('delegates to the batch path: one bulk upsert for an evaluable version', async () => {
    const { sb, calls } = makeFakeSupabase({
      tables: {
        ...SITE_TABLES,
        schedule_slots: {
          data: [{
            ...SLOT,
            assignments: [{ id: 'a1', provider_id: 'p1', assignment_status: 'assigned' }],
          }],
          error: null,
        },
        providers: { data: [{ id: 'p1', provider_type: 'physician', provider_employment_profiles: { fte_value: 1 } }], error: null },
        provider_availability: { data: [], error: null },
        provider_site_credentials: { data: [], error: null },
        assignments: { data: [], error: null },
      },
    });
    const res = await commitValidation(sb, 's1', 'v1');
    expect(res.errors).toEqual([]);
    const upserts = callsFor(calls, 'assignments', 'upsert');
    expect(upserts).toHaveLength(1);
    const payload = upserts[0].args[0] as Array<Record<string, unknown>>;
    expect(payload).toHaveLength(1);
    expect(payload[0].id).toBe('a1');
    expect(payload[0]).toHaveProperty('validation_flags');
  });

  it('declines to write when the site context itself failed to load (rule query error)', async () => {
    const { sb, calls } = makeFakeSupabase({
      tables: {
        shift_types: SITE_TABLES.shift_types,
        rule_sets: { data: null, error: { message: 'rule_sets down' } },
        schedule_slots: {
          data: [{
            ...SLOT,
            assignments: [{ id: 'a1', provider_id: 'p1', assignment_status: 'assigned' }],
          }],
          error: null,
        },
        providers: { data: [], error: null },
        provider_availability: { data: [], error: null },
        provider_site_credentials: { data: [], error: null },
        assignments: { data: [], error: null },
      },
    });
    const res = await commitValidation(sb, 's1', 'v1');
    expect(callsFor(calls, 'assignments', 'upsert')).toHaveLength(0);
    expect(callsFor(calls, 'assignments', 'update')).toHaveLength(0);
    expect(res.errors.join(' ')).toContain('validation-unavailable');
    expect(res.errors.join(' ')).toContain('rule_sets down');
  });
});

describe('loadSiteValidationContext failure sentinel', () => {
  const OK_SHIFT_TYPES: TableCfg = {
    data: [{ id: 'st-C1', site_id: 's1', code: 'C1', name: 'C1', category: 'call', requires_credential: null, requires_specific_skills: [] }],
    error: null,
  };

  it('sets loadError when rule_definitions fails (rules:[] must not read as "no rules")', async () => {
    const { sb } = makeFakeSupabase({
      tables: {
        shift_types: OK_SHIFT_TYPES,
        rule_sets: { data: [{ id: 'rs1' }], error: null },
        rule_definitions: { data: null, error: { message: 'rule_definitions down' } },
      },
    });
    const ctx = await loadSiteValidationContext(sb, 's1');
    expect(ctx.loadError).toContain('rule_definitions down');
  });

  it('sets loadError when shift_types fails', async () => {
    const { sb } = makeFakeSupabase({
      tables: {
        shift_types: { data: null, error: { message: 'shift_types down' } },
        rule_sets: { data: [], error: null },
      },
    });
    const ctx = await loadSiteValidationContext(sb, 's1');
    expect(ctx.loadError).toContain('shift_types down');
  });

  it('clean load has no loadError', async () => {
    const { sb } = makeFakeSupabase({
      tables: { shift_types: OK_SHIFT_TYPES, rule_sets: { data: [], error: null } },
    });
    const ctx = await loadSiteValidationContext(sb, 's1');
    expect(ctx.loadError).toBeUndefined();
  });

  it('serial evaluateAssignment (no siteCtx) → evaluated:false when the rule query fails', async () => {
    const { sb, calls } = makeFakeSupabase({
      tables: {
        shift_types: OK_SHIFT_TYPES,
        rule_sets: { data: null, error: { message: 'rule_sets down' } },
        schedule_slots: { data: SLOT, error: null },
        providers: { data: null, error: null },
        provider_site_credentials: { data: null, error: null },
        provider_availability: { data: [], error: null },
        assignments: { data: [], error: null },
      },
    });
    const res = await evaluateAssignment(sb, 'sA', 'p1'); // no preloaded siteCtx
    expect(res.evaluated).toBe(false);
    expect(res.violations).toEqual([]);
    expect(callsFor(calls, 'assignments', 'update')).toHaveLength(0);
  });
});

describe('validationFlagsFor (POST write payload)', () => {
  it('returns the violations when evaluated', () => {
    const flags = [{ rule_id: null, rule_name: 'x', category: 'time_off' as const, severity: 'hard' as const, message: 'm' }];
    expect(validationFlagsFor({ evaluated: true, violations: flags })).toBe(flags);
  });

  it('returns a sentinel warning flag when not evaluated (never a fake-clean [])', () => {
    const flags = validationFlagsFor({ evaluated: false, violations: [] });
    expect(flags).toHaveLength(1);
    expect(flags[0].severity).toBe('warning');
    expect(flags[0].message).toBe('validation unavailable — needs re-validation');
  });
});
