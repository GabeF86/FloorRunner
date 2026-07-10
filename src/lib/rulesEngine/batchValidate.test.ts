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
import type { RuleDefinition, ShiftTypeRow } from './types';

// ── canned dataset ───────────────────────────────────────────────────────────
// Version v1 at site s1, 5 slots / 5 assignments. Active rule: rest after C1.
//   sA 01-07 C1 → a1 (p1)   p1 pending PTO on 01-07 → time_off hard
//                           + a4 next day → rest (case A) hard
//   sB 01-07 C2 → a2 (p2)   p2 also assigned at site s2 same day → cross_site hard
//   sC 01-08 C1 → a3 (open) → open_slot + under-covered soft
//   sD 01-08 C2 → a4 (p1)   day after p1's C1 → rest (case B) hard
//   sE 01-08 C2 → a5 (p2)   decoy: p2 has C1 on 01-07 at s2/v9 — if neighbor
//                           scoping leaks across version/site, a5 would get a
//                           false rest violation (parity + content assert it).

function st(code: string, category: ShiftTypeRow['category'] = 'call'): ShiftTypeRow {
  return {
    id: `st-${code}`, site_id: 's1', code, name: code, category,
    requires_credential: null, requires_specific_skills: [],
  };
}
const SHIFT_TYPES = [st('C1'), st('C2')];

const REST_RULE: RuleDefinition = {
  id: 'r-rest', rule_set_id: 'rs1', rule_name: 'Post-C1 day off',
  rule_category: 'rest', hard_constraint: true, priority_rank: 1,
  applies_to_provider_group: 'both', applies_to_shift_types: null,
  applies_to_day_types: null,
  condition: { after_shift_code: 'C1', rest_type: 'day_off' },
  action: {}, explanation_text: null, is_active: true,
};

const siteCtx: SiteValidationContext = {
  shiftTypesById: new Map(SHIFT_TYPES.map(s => [s.id, s])),
  shiftTypesByCode: new Map(SHIFT_TYPES.map(s => [s.code, s])),
  rules: [REST_RULE],
};

function slot(id: string, date: string, code: string, assignment: { id: string; provider_id: string | null; assignment_status: string }, siteId = 's1') {
  return {
    id, site_id: siteId, slot_date: date, shift_type_id: `st-${code}`,
    provider_group: 'physician', derived_day_type: 'weekday',
    schedule_version_id: 'v1', required_count: 1,
    assignments: [assignment],
  };
}

const SLOTS = [
  slot('sA', '2026-01-07', 'C1', { id: 'a1', provider_id: 'p1', assignment_status: 'assigned' }),
  slot('sB', '2026-01-07', 'C2', { id: 'a2', provider_id: 'p2', assignment_status: 'assigned' }),
  slot('sC', '2026-01-08', 'C1', { id: 'a3', provider_id: null, assignment_status: 'open' }),
  slot('sD', '2026-01-08', 'C2', { id: 'a4', provider_id: 'p1', assignment_status: 'assigned' }),
  slot('sE', '2026-01-08', 'C2', { id: 'a5', provider_id: 'p2', assignment_status: 'assigned' }),
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
// holds). ax is p2's C1 at another site+version — the scoping decoy.
function joined(id: string, pid: string, slotId: string, date: string, code: string, siteId = 's1', versionId = 'v1') {
  return {
    id, provider_id: pid, schedule_slot_id: slotId, assignment_status: 'assigned',
    schedule_slots: {
      id: slotId, slot_date: date, shift_type_id: `st-${code}`,
      derived_day_type: 'weekday', site_id: siteId, schedule_version_id: versionId,
    },
  };
}
const ASSIGNED_ROWS = [
  joined('a1', 'p1', 'sA', '2026-01-07', 'C1'),
  joined('a2', 'p2', 'sB', '2026-01-07', 'C2'),
  joined('a4', 'p1', 'sD', '2026-01-08', 'C2'),
  joined('a5', 'p2', 'sE', '2026-01-08', 'C2'),
  joined('ax', 'p2', 'sX', '2026-01-07', 'C1', 's2', 'v9'),
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

function batchTables(over: Record<string, TableCfg> = {}): Record<string, TableCfg> {
  return {
    schedule_slots: { data: SLOTS, error: null },
    providers: { data: PROVIDERS, error: null },
    provider_availability: { data: AVAILABILITY, error: null },
    provider_site_credentials: { data: CREDS, error: null },
    assignments: assignmentsTable,
    ...over,
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
  it('issues at most 6 queries for the whole version', async () => {
    const { sb, calls } = makeFakeSupabase({ tables: batchTables() });
    await batchValidateVersion(sb, 'v1', siteCtx);
    expect(fromCount(calls)).toBeLessThanOrEqual(6);
  });

  it('per-assignment violations are identical to serial evaluateAssignment', async () => {
    const { sb } = makeFakeSupabase({ tables: batchTables() });
    const batch = await batchValidateVersion(sb, 'v1', siteCtx);
    expect(batch.results).toHaveLength(5);

    const byAssignment = new Map(batch.results.map(r => [r.assignmentId, r]));
    const targets: Array<[string, string, string | null]> = [
      ['a1', 'sA', 'p1'],
      ['a2', 'sB', 'p2'],
      ['a3', 'sC', null],
      ['a4', 'sD', 'p1'],
      ['a5', 'sE', 'p2'],
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
    // produce the designed violations — including rule-driven ones that READ
    // the neighbor window (rest), in both the fires and does-not-fire direction.
    expect(byAssignment.get('a1')!.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'time_off', severity: 'hard' }),
        expect.objectContaining({ category: 'rest', severity: 'hard' }), // case A: a4 next day
      ]),
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
    // a4: same-version prior-day C1 neighbor → rest case B fires.
    expect(byAssignment.get('a4')!.violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ category: 'rest', severity: 'hard' })]),
    );
    // a5: p2's prior-day C1 exists ONLY at s2/v9 (decoy). Correct scoping
    // excludes it → no rest violation. A scoping leak in either path would
    // fail here or break the parity loop above.
    expect(byAssignment.get('a5')!.violations).toEqual([]);
  });

  it('persists with ONE bulk upsert (id + validation_flags per row)', async () => {
    const { sb, calls } = makeFakeSupabase({ tables: batchTables() });
    const batch = await batchValidateVersion(sb, 'v1', siteCtx);

    const upserts = callsFor(calls, 'assignments', 'upsert');
    expect(upserts).toHaveLength(1);
    const payload = upserts[0].args[0] as Array<Record<string, unknown>>;
    expect(Array.isArray(payload)).toBe(true);
    expect(payload.map(r => r.id).sort()).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);
    for (const row of payload) {
      expect(row).toHaveProperty('validation_flags');
    }
    const a1Row = payload.find(r => r.id === 'a1')!;
    expect(a1Row.validation_flags).toEqual(
      batch.results.find(r => r.assignmentId === 'a1')!.violations,
    );
    // No per-row update fallbacks alongside the (successful) bulk write.
    expect(callsFor(calls, 'assignments', 'update')).toHaveLength(0);
  });

  it('empty version: one query, no writes', async () => {
    const { sb, calls } = makeFakeSupabase({ tables: { schedule_slots: { data: [], error: null } } });
    const res = await batchValidateVersion(sb, 'v1', siteCtx);
    expect(res.results).toHaveLength(0);
    expect(fromCount(calls)).toBe(1);
    expect(callsFor(calls, 'assignments', 'upsert')).toHaveLength(0);
  });

  // ── preload failures (invariant 6: a failed load must not fake-clean) ─────
  describe('preload query failures → all targets evaluated:false, nothing written', () => {
    const failing = { data: null, error: { message: 'db down' } };
    const cases: Array<[string, Record<string, TableCfg>]> = [
      ['providers', batchTables({ providers: failing })],
      ['provider_availability', batchTables({ provider_availability: failing })],
      ['provider_site_credentials', batchTables({ provider_site_credentials: failing })],
      // assignments read fails, but a (hypothetical) write would succeed —
      // the test proves no write is even attempted.
      ['assignments (neighbor read)', batchTables({
        assignments: (filters: Filter[]) =>
          filters.some(f => f.method === 'upsert' || f.method === 'update')
            ? { data: null, error: null }
            : failing,
      })],
    ];

    for (const [name, tables] of cases) {
      it(`${name} query fails`, async () => {
        const { sb, calls } = makeFakeSupabase({ tables });
        const res = await batchValidateVersion(sb, 'v1', siteCtx);
        expect(res.results).toHaveLength(5);
        expect(res.results.every(r => r.evaluated === false)).toBe(true);
        expect(res.results.every(r => r.violations.length === 0)).toBe(true);
        expect(res.written).toBe(0);
        expect(callsFor(calls, 'assignments', 'upsert')).toHaveLength(0);
        expect(callsFor(calls, 'assignments', 'update')).toHaveLength(0);
        expect(res.errors.join(' ')).toContain('validation-unavailable');
        expect(res.errors.join(' ')).toContain('db down');
      });
    }
  });

  it('siteCtx that failed to load → declines to evaluate or write', async () => {
    const { sb, calls } = makeFakeSupabase({ tables: batchTables() });
    const res = await batchValidateVersion(sb, 'v1', {
      ...siteCtx, loadError: 'rule_definitions load failed: boom',
    });
    expect(res.written).toBe(0);
    expect(callsFor(calls, 'assignments', 'upsert')).toHaveLength(0);
    expect(res.errors.join(' ')).toContain('validation-unavailable');
  });

  it('off-site slots (single-site invariant broken) → those targets evaluated:false + error', async () => {
    const offSiteSlot = slot('sF', '2026-01-07', 'C1', { id: 'a6', provider_id: 'p1', assignment_status: 'assigned' }, 's2');
    const { sb, calls } = makeFakeSupabase({
      tables: batchTables({ schedule_slots: { data: [...SLOTS, offSiteSlot], error: null } }),
    });
    const res = await batchValidateVersion(sb, 'v1', siteCtx);
    const a6 = res.results.find(r => r.assignmentId === 'a6')!;
    expect(a6.evaluated).toBe(false);
    expect(res.errors.join(' ')).toContain('site');
    // The on-site assignments are still validated and written.
    const payload = callsFor(calls, 'assignments', 'upsert')[0].args[0] as Array<Record<string, unknown>>;
    expect(payload.map(r => r.id).sort()).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);
  });

  // ── bulk-write failure → per-row update fallback ───────────────────────────
  describe('upsert fallback', () => {
    it('chunk upsert failure falls back to per-row updates (no ghost inserts)', async () => {
      const { sb, calls } = makeFakeSupabase({
        tables: batchTables({
          assignments: (filters: Filter[]) => {
            if (filters.some(f => f.method === 'upsert')) return { data: null, error: { message: 'conflict' } };
            if (filters.some(f => f.method === 'update')) return { data: null, error: null };
            return assignmentsTable(filters);
          },
        }),
      });
      const res = await batchValidateVersion(sb, 'v1', siteCtx);
      const updates = callsFor(calls, 'assignments', 'update');
      expect(updates).toHaveLength(5); // one per row in the failed chunk
      for (const u of updates) {
        expect(u.args[0]).toHaveProperty('validation_flags');
      }
      expect(res.written).toBe(5);
      expect(res.errors).toEqual([]); // fallback succeeded — data IS written
    });

    it('rows whose fallback update also fails are surfaced by id', async () => {
      const { sb } = makeFakeSupabase({
        tables: batchTables({
          assignments: (filters: Filter[]) => {
            if (filters.some(f => f.method === 'upsert')) return { data: null, error: { message: 'conflict' } };
            const upd = filters.find(f => f.method === 'update');
            if (upd) {
              const eqId = filters.find(f => f.method === 'eq' && f.args[0] === 'id');
              return eqId?.args[1] === 'a2'
                ? { data: null, error: { message: 'row gone' } }
                : { data: null, error: null };
            }
            return assignmentsTable(filters);
          },
        }),
      });
      const res = await batchValidateVersion(sb, 'v1', siteCtx);
      expect(res.written).toBe(4);
      expect(res.errors.join(' ')).toContain('a2');
      expect(res.errors.join(' ')).toContain('row gone');
    });
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
