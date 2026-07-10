// batchValidateVersion — loads a whole version's validation data in a handful
// of queries, evaluates in memory via the same pure evaluators, and persists
// with ONE bulk write. Parity requirement: per-assignment violations must be
// IDENTICAL to serial evaluateAssignment on the same canned data.
import { describe, it, expect } from 'vitest';
import { batchValidateVersion, chunk, WRITE_CHUNK } from './batchValidate';
import { evaluateAssignment } from './evaluate';
import type { SiteValidationContext } from './loadContext';
import { makeFakeSupabase, fromCount, callsFor } from './__fixtures__/fakeSupabase';
import type { Filter, TableCfg } from './__fixtures__/fakeSupabase';
import type { ShiftTypeRow } from './types';

// ── canned dataset ───────────────────────────────────────────────────────────
// Version v1 at site s1, 3 slots / 3 assignments:
//   sA 2026-01-07 C1 → a1 (p1, assigned)   p1 has PENDING PTO on 01-07 → time_off hard
//   sB 2026-01-07 C2 → a2 (p2, assigned)   p2 also assigned at site s2 same day → cross_site hard
//   sC 2026-01-08 C1 → a3 (open)           → open_slot + under-covered soft

function st(code: string, category: ShiftTypeRow['category'] = 'call'): ShiftTypeRow {
  return {
    id: `st-${code}`, site_id: 's1', code, name: code, category,
    requires_credential: null, requires_specific_skills: [],
  };
}
const SHIFT_TYPES = [st('C1'), st('C2')];
const siteCtx: SiteValidationContext = {
  shiftTypesById: new Map(SHIFT_TYPES.map(s => [s.id, s])),
  shiftTypesByCode: new Map(SHIFT_TYPES.map(s => [s.code, s])),
  rules: [],
};

const SLOTS = [
  {
    id: 'sA', site_id: 's1', slot_date: '2026-01-07', shift_type_id: 'st-C1',
    provider_group: 'physician', derived_day_type: 'weekday',
    schedule_version_id: 'v1', required_count: 1,
    assignments: [{ id: 'a1', provider_id: 'p1', assignment_status: 'assigned' }],
  },
  {
    id: 'sB', site_id: 's1', slot_date: '2026-01-07', shift_type_id: 'st-C2',
    provider_group: 'physician', derived_day_type: 'weekday',
    schedule_version_id: 'v1', required_count: 1,
    assignments: [{ id: 'a2', provider_id: 'p2', assignment_status: 'assigned' }],
  },
  {
    id: 'sC', site_id: 's1', slot_date: '2026-01-08', shift_type_id: 'st-C1',
    provider_group: 'physician', derived_day_type: 'weekday',
    schedule_version_id: 'v1', required_count: 1,
    assignments: [{ id: 'a3', provider_id: null, assignment_status: 'open' }],
  },
];

const PROVIDERS = [
  { id: 'p1', provider_type: 'physician', provider_employment_profiles: { fte_value: 1 } },
  { id: 'p2', provider_type: 'physician', provider_employment_profiles: { fte_value: 0.5 } },
];

const AVAILABILITY = [
  {
    id: 'av1', provider_id: 'p1', availability_type: 'pto',
    start_date: '2026-01-07', end_date: '2026-01-07', approval_status: 'pending',
  },
];

const CREDS = ['p1', 'p2'].map(pid => ({
  provider_id: pid, site_id: 's1', is_active: true, credentialed: true,
  can_take_call: true, can_take_weekend_call: true, can_take_holiday_call: true,
  can_take_backup_call: true, allowed_shift_types: [], excluded_shift_types: [],
  skill_tags: [],
}));

// All assigned rows for p1/p2 across all sites/versions (what the real DB
// holds). sX is p2's double-booking at another site, OUTSIDE this version.
const ASSIGNED_ROWS = [
  {
    id: 'a1', provider_id: 'p1', schedule_slot_id: 'sA', assignment_status: 'assigned',
    schedule_slots: { id: 'sA', slot_date: '2026-01-07', shift_type_id: 'st-C1', derived_day_type: 'weekday', site_id: 's1', schedule_version_id: 'v1' },
  },
  {
    id: 'a2', provider_id: 'p2', schedule_slot_id: 'sB', assignment_status: 'assigned',
    schedule_slots: { id: 'sB', slot_date: '2026-01-07', shift_type_id: 'st-C2', derived_day_type: 'weekday', site_id: 's1', schedule_version_id: 'v1' },
  },
  {
    id: 'ax', provider_id: 'p2', schedule_slot_id: 'sX', assignment_status: 'assigned',
    schedule_slots: { id: 'sX', slot_date: '2026-01-07', shift_type_id: 'st-C1', derived_day_type: 'weekday', site_id: 's2', schedule_version_id: 'v9' },
  },
];

// Honest mini-DB for the assignments table: applies the recorded eq/in/gte/lte
// filters so both the batch and serial query shapes get correctly-filtered rows.
function assignmentsTable(filters: Filter[]) {
  if (filters.some(f => f.method === 'upsert' || f.method === 'update' || f.method === 'insert')) {
    return { data: null, error: null };
  }
  let rows = ASSIGNED_ROWS;
  for (const f of filters) {
    const [col, val] = f.args as [string, unknown];
    if (f.method === 'eq') {
      if (col === 'provider_id') rows = rows.filter(r => r.provider_id === val);
      if (col === 'assignment_status') rows = rows.filter(r => r.assignment_status === val);
      if (col === 'schedule_slots.slot_date') rows = rows.filter(r => r.schedule_slots.slot_date === val);
      if (col === 'schedule_slots.site_id') rows = rows.filter(r => r.schedule_slots.site_id === val);
      if (col === 'schedule_slots.schedule_version_id') rows = rows.filter(r => r.schedule_slots.schedule_version_id === val);
    }
    if (f.method === 'in' && col === 'provider_id') {
      rows = rows.filter(r => (val as string[]).includes(r.provider_id));
    }
    if (f.method === 'gte' && col === 'schedule_slots.slot_date') {
      rows = rows.filter(r => r.schedule_slots.slot_date >= (val as string));
    }
    if (f.method === 'lte' && col === 'schedule_slots.slot_date') {
      rows = rows.filter(r => r.schedule_slots.slot_date <= (val as string));
    }
  }
  return { data: rows, error: null };
}

function batchTables(): Record<string, TableCfg> {
  return {
    schedule_slots: { data: SLOTS, error: null },
    providers: { data: PROVIDERS, error: null },
    provider_availability: { data: AVAILABILITY, error: null },
    provider_site_credentials: { data: CREDS, error: null },
    assignments: assignmentsTable,
  };
}

// Serial fakes must branch on the query shape (loadContext hits
// schedule_slots twice: once by id, once by version+date).
function serialTables(): Record<string, TableCfg> {
  return {
    schedule_slots: (filters: Filter[]) => {
      const eqId = filters.find(f => f.method === 'eq' && f.args[0] === 'id');
      if (eqId) return { data: SLOTS.find(s => s.id === eqId.args[1]) ?? null, error: null };
      const eqDate = filters.find(f => f.method === 'eq' && f.args[0] === 'slot_date');
      return { data: SLOTS.filter(s => s.slot_date === eqDate?.args[1]), error: null };
    },
    providers: (filters: Filter[]) => {
      const eqId = filters.find(f => f.method === 'eq' && f.args[0] === 'id');
      return { data: PROVIDERS.find(p => p.id === eqId?.args[1]) ?? null, error: null };
    },
    provider_availability: (filters: Filter[]) => {
      const eqPid = filters.find(f => f.method === 'eq' && f.args[0] === 'provider_id');
      return { data: AVAILABILITY.filter(a => a.provider_id === eqPid?.args[1]), error: null };
    },
    provider_site_credentials: (filters: Filter[]) => {
      const eqPid = filters.find(f => f.method === 'eq' && f.args[0] === 'provider_id');
      return { data: CREDS.find(c => c.provider_id === eqPid?.args[1]) ?? null, error: null };
    },
    assignments: assignmentsTable,
  };
}

describe('batchValidateVersion', () => {
  it('issues at most 6 queries for a 3-slot version', async () => {
    const { sb, calls } = makeFakeSupabase({ tables: batchTables() });
    await batchValidateVersion(sb, 'v1', siteCtx);
    expect(fromCount(calls)).toBeLessThanOrEqual(6);
  });

  it('per-assignment violations are identical to serial evaluateAssignment', async () => {
    const { sb } = makeFakeSupabase({ tables: batchTables() });
    const batch = await batchValidateVersion(sb, 'v1', siteCtx);
    expect(batch.results).toHaveLength(3);

    const byAssignment = new Map(batch.results.map(r => [r.assignmentId, r]));
    const targets: Array<[string, string, string | null]> = [
      ['a1', 'sA', 'p1'],
      ['a2', 'sB', 'p2'],
      ['a3', 'sC', null],
    ];
    for (const [aid, slotId, providerId] of targets) {
      const { sb: serialSb } = makeFakeSupabase({ tables: serialTables() });
      const serial = await evaluateAssignment(serialSb, slotId, providerId, siteCtx);
      const batched = byAssignment.get(aid)!;
      expect(batched.evaluated).toBe(true);
      expect(serial.evaluated).toBe(true);
      expect(batched.violations).toEqual(serial.violations);
      expect(batched.hardCount).toBe(serial.hardCount);
      expect(batched.softCount).toBe(serial.softCount);
    }

    // Guard against trivially-empty parity: the canned data must actually
    // produce the designed violations.
    expect(byAssignment.get('a1')!.violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ category: 'time_off', severity: 'hard' })]),
    );
    expect(byAssignment.get('a2')!.violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ category: 'cross_site', severity: 'hard' })]),
    );
    expect(byAssignment.get('a3')!.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'open_slot', severity: 'soft' }),
        expect.objectContaining({ category: 'coverage', severity: 'soft' }),
      ]),
    );
  });

  it('persists with ONE bulk upsert (id + validation_flags per row)', async () => {
    const { sb, calls } = makeFakeSupabase({ tables: batchTables() });
    const batch = await batchValidateVersion(sb, 'v1', siteCtx);

    const upserts = callsFor(calls, 'assignments', 'upsert');
    expect(upserts).toHaveLength(1);
    const payload = upserts[0].args[0] as Array<Record<string, unknown>>;
    expect(Array.isArray(payload)).toBe(true);
    expect(payload.map(r => r.id).sort()).toEqual(['a1', 'a2', 'a3']);
    for (const row of payload) {
      expect(row).toHaveProperty('validation_flags');
    }
    const a1Row = payload.find(r => r.id === 'a1')!;
    expect(a1Row.validation_flags).toEqual(
      batch.results.find(r => r.assignmentId === 'a1')!.violations,
    );
    // No per-row update fallbacks alongside the bulk write.
    expect(callsFor(calls, 'assignments', 'update')).toHaveLength(0);
  });

  it('empty version: one query, no writes', async () => {
    const { sb, calls } = makeFakeSupabase({ tables: { schedule_slots: { data: [], error: null } } });
    const res = await batchValidateVersion(sb, 'v1', siteCtx);
    expect(res.results).toHaveLength(0);
    expect(fromCount(calls)).toBe(1);
    expect(callsFor(calls, 'assignments', 'upsert')).toHaveLength(0);
  });
});

describe('chunk', () => {
  it('splits writes at the 500-row boundary', () => {
    const rows = Array.from({ length: WRITE_CHUNK + 1 }, (_, i) => i);
    const out = chunk(rows, WRITE_CHUNK);
    expect(out).toHaveLength(2);
    expect(out[0]).toHaveLength(WRITE_CHUNK);
    expect(out[1]).toEqual([WRITE_CHUNK]);
    expect(chunk([], WRITE_CHUNK)).toEqual([]);
  });
});
