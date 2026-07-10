// The `evaluated` flag (clinical invariant 6): validation must never silently
// report clean on failure. An unloadable context or a throwing evaluator must
// yield evaluated:false, and write-sites must NOT persist validation_flags.
import { describe, it, expect } from 'vitest';
import { evaluateAssignment, evaluateContext } from './evaluate';
import { commitValidation } from './commit';
import type { SiteValidationContext } from './loadContext';
import { makeFakeSupabase, callsFor } from './__fixtures__/fakeSupabase';
import type { Filter, TableCfg } from './__fixtures__/fakeSupabase';
import type { EvaluationContext, ShiftTypeRow } from './types';

function st(code: string, category: ShiftTypeRow['category'] = 'call'): ShiftTypeRow {
  return {
    id: `st-${code}`, site_id: 's1', code, name: code, category,
    requires_credential: null, requires_specific_skills: [],
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
    fte_value: 1, neighborAssignments: [], availability: [],
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
});
