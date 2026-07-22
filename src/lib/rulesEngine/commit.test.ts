import { describe, it, expect } from 'vitest';
import {
  partitionForWrite, buildMetadataPayload, commitMetadata, commitPlan,
  bulkWriteWithRowFallback,
} from './commit';
import { makeFakeSupabase, callsFor, fromCount } from './__fixtures__/fakeSupabase';
import type { PlannedAssignment } from './genTypes';

function pa(over: Partial<PlannedAssignment>): PlannedAssignment {
  return {
    slot_id: 's', slot_date: '2026-01-07', shift_type_code: 'C1',
    shift_type_category: 'call', derived_day_type: 'weekday',
    provider_id: 'p1', provider_name: 'P1',
    existing_assignment_id: null, source: 'main-loop', ...over,
  };
}

describe('partitionForWrite', () => {
  it('splits assignments into updates (existing row) and inserts (new row)', () => {
    const plan = [
      pa({ slot_id: 'a', existing_assignment_id: 'row-a' }),
      pa({ slot_id: 'b', existing_assignment_id: null }),
    ];
    const { updates, inserts } = partitionForWrite(plan);
    expect(updates.map(u => u.id)).toEqual(['row-a']);
    expect(updates[0].provider_id).toBe('p1');
    expect(updates[0].assignment_status).toBe('assigned');
    expect(updates[0].source_type).toBe('auto_generated');
    expect(inserts.map(i => i.schedule_slot_id)).toEqual(['b']);
    expect(inserts[0].assignment_status).toBe('assigned');
    expect(inserts[0].source_type).toBe('auto_generated');
    expect(inserts[0].assigned_at).toBeDefined();
  });
});

describe('buildMetadataPayload', () => {
  it('folds source + explanation into one jsonb payload', () => {
    const payload = buildMetadataPayload(pa({
      source: 'main-loop',
      explanation: { ratioAtAssignment: 1.5, daysSinceLastCall: 7, competingCandidates: 3 },
    }));
    expect(payload).toEqual({
      source: 'main-loop',
      ratioAtAssignment: 1.5, daysSinceLastCall: 7, competingCandidates: 3,
    });
  });

  it('handles a structural assignment with no explanation', () => {
    const payload = buildMetadataPayload(pa({ source: 'd-chain', explanation: undefined }));
    expect(payload).toEqual({ source: 'd-chain' });
  });
});

describe('commitMetadata (bulk)', () => {
  const ROWS = [
    { id: 'row-a', schedule_slot_id: 'slotA', provider_id: 'p1' },
    { id: 'row-b', schedule_slot_id: 'slotB', provider_id: 'p2' },
    { id: 'row-c', schedule_slot_id: 'slotC', provider_id: 'p9' }, // provider mismatch
  ];

  it('one id fetch + one bulk upsert keyed by existing assignment id', async () => {
    const { sb, calls } = makeFakeSupabase({ tables: { assignments: { data: ROWS, error: null } } });
    const plan = [
      pa({ slot_id: 'slotA', provider_id: 'p1', source: 'main-loop', explanation: { ratioAtAssignment: 1.5, daysSinceLastCall: 7, competingCandidates: 3 } }),
      pa({ slot_id: 'slotB', provider_id: 'p2', source: 'd-chain', explanation: undefined }),
      pa({ slot_id: 'slotC', provider_id: 'p3' }), // row exists but holds p9 → skipped
    ];
    const res = await commitMetadata(sb, plan);
    expect(res.errors).toEqual([]);
    expect(fromCount(calls, 'assignments')).toBe(2); // fetch + write

    const upserts = callsFor(calls, 'assignments', 'upsert');
    expect(upserts).toHaveLength(1);
    const payload = upserts[0].args[0] as Array<Record<string, unknown>>;
    expect(payload.map(r => r.id)).toEqual(['row-a', 'row-b']);
    expect(payload[0].generation_metadata).toEqual({
      source: 'main-loop', ratioAtAssignment: 1.5, daysSinceLastCall: 7, competingCandidates: 3,
    });
    expect(payload[1].generation_metadata).toEqual({ source: 'd-chain' });
    // No serial per-row updates.
    expect(callsFor(calls, 'assignments', 'update')).toHaveLength(0);
  });

  it('no plan assignments → no queries', async () => {
    const { sb, calls } = makeFakeSupabase({});
    const res = await commitMetadata(sb, []);
    expect(res.dbQueries).toBe(0);
    expect(fromCount(calls)).toBe(0);
  });

  it('chunks the id fetch at 100 slot ids per .in() query', async () => {
    const many = Array.from({ length: 101 }, (_, i) => ({
      id: `row-${i}`, schedule_slot_id: `slot-${i}`, provider_id: 'p1',
    }));
    const { sb, calls } = makeFakeSupabase({
      tables: {
        assignments: (filters) => {
          const inF = filters.find(f => f.method === 'in');
          if (inF) {
            const ids = inF.args[1] as string[];
            expect(ids.length).toBeLessThanOrEqual(100);
            return { data: many.filter(r => ids.includes(r.schedule_slot_id)), error: null };
          }
          return { data: null, error: null };
        },
      },
    });
    const plan = many.map(r => pa({ slot_id: r.schedule_slot_id, provider_id: 'p1' }));
    const res = await commitMetadata(sb, plan);
    expect(res.errors).toEqual([]);
    // 2 chunked fetches (100 + 1) + 1 bulk upsert (101 < 500)
    expect(callsFor(calls, 'assignments', 'in')).toHaveLength(2);
    expect(callsFor(calls, 'assignments', 'upsert')).toHaveLength(1);
    const payload = callsFor(calls, 'assignments', 'upsert')[0].args[0] as unknown[];
    expect(payload).toHaveLength(101);
  });

  it('falls back to per-row updates when the bulk upsert fails', async () => {
    const { sb, calls } = makeFakeSupabase({
      tables: {
        assignments: (filters) => {
          if (filters.some(f => f.method === 'upsert')) return { data: null, error: { message: 'conflict' } };
          if (filters.some(f => f.method === 'update')) return { data: null, error: null };
          return { data: ROWS.slice(0, 2), error: null };
        },
      },
    });
    const res = await commitMetadata(sb, [
      pa({ slot_id: 'slotA', provider_id: 'p1' }),
      pa({ slot_id: 'slotB', provider_id: 'p2' }),
    ]);
    expect(res.errors).toEqual([]); // fallback succeeded — data IS written
    const updates = callsFor(calls, 'assignments', 'update');
    expect(updates).toHaveLength(2);
    expect(updates[0].args[0]).toHaveProperty('generation_metadata');
  });

  it('surfaces rows whose fallback update also fails, by row id', async () => {
    const { sb } = makeFakeSupabase({
      tables: {
        assignments: (filters) => {
          if (filters.some(f => f.method === 'upsert')) return { data: null, error: { message: 'conflict' } };
          if (filters.some(f => f.method === 'update')) return { data: null, error: { message: 'row gone' } };
          return { data: ROWS.slice(0, 1), error: null };
        },
      },
    });
    const res = await commitMetadata(sb, [pa({ slot_id: 'slotA', provider_id: 'p1' })]);
    expect(res.errors.join(' ')).toContain('row gone');
    expect(res.errors.join(' ')).toContain('row-a');
  });
});

// ── bulkWriteWithRowFallback (shared write idiom) ────────────────────────────
describe('bulkWriteWithRowFallback', () => {
  it('bulk success → one call, every index landed', async () => {
    const { sb, calls } = makeFakeSupabase({ tables: { t: { data: null, error: null } } });
    const out = await bulkWriteWithRowFallback(sb, 't',
      [{ id: 'a', v: 1 }, { id: 'b', v: 2 }], { onConflict: 'id', label: 'test' });
    expect(out.landedIdx).toEqual([0, 1]);
    expect(out.rowErrors).toEqual([]);
    expect(out.dbQueries).toBe(1);
    expect(callsFor(calls, 't', 'upsert')).toHaveLength(1);
    expect(callsFor(calls, 't', 'update')).toHaveLength(0);
  });

  it('empty rows → no queries at all', async () => {
    const { sb, calls } = makeFakeSupabase({});
    const out = await bulkWriteWithRowFallback(sb, 't', [], { label: 'test' });
    expect(out.landedIdx).toEqual([]);
    expect(out.dbQueries).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('upsert-mode fallback: only rows the DB confirms count as landed (zero-row = no-op, not landed)', async () => {
    const { sb, calls } = makeFakeSupabase({
      tables: {
        t: (filters) => {
          if (filters.some(f => f.method === 'upsert')) return { data: null, error: { message: 'conflict' } };
          const eqId = filters.find(f => f.method === 'eq' && f.args[0] === 'id')?.args[1];
          if (eqId === 'a') return { data: [{ id: 'a' }], error: null }; // confirmed
          if (eqId === 'b') return { data: [], error: null };            // vanished row → no-op
          return { data: null, error: { message: 'row gone' } };          // c → hard failure
        },
      },
    });
    const out = await bulkWriteWithRowFallback(sb, 't',
      [{ id: 'a', v: 1 }, { id: 'b', v: 2 }, { id: 'c', v: 3 }],
      { onConflict: 'id', label: 'test' });
    expect(out.landedIdx).toEqual([0]);
    expect(out.rowErrors).toEqual([{ index: 2, message: 'row gone' }]);
    expect(out.dbQueries).toBe(4); // 1 bulk + 3 per-row
    // per-row update payload excludes the conflict key, and confirms via select
    const upd = callsFor(calls, 't', 'update');
    expect(upd).toHaveLength(3);
    expect(upd[0].args[0]).toEqual({ v: 1 });
    expect(callsFor(calls, 't', 'select').length).toBeGreaterThanOrEqual(3);
  });

  it('insert-mode fallback: per-row inserts with per-row outcomes', async () => {
    const { sb, calls } = makeFakeSupabase({
      tables: {
        t: (filters) => {
          const ins = filters.find(f => f.method === 'insert');
          if (ins && Array.isArray(ins.args[0])) return { data: null, error: { message: 'unique violation' } };
          const row = ins?.args[0] as { id: string };
          return row.id === 'b'
            ? { data: null, error: { message: 'dup' } }
            : { data: null, error: null };
        },
      },
    });
    const out = await bulkWriteWithRowFallback(sb, 't',
      [{ id: 'a' }, { id: 'b' }], { label: 'test' });
    expect(out.landedIdx).toEqual([0]);
    expect(out.rowErrors).toEqual([{ index: 1, message: 'dup' }]);
    expect(callsFor(calls, 't', 'insert')).toHaveLength(3); // 1 bulk + 2 per-row
  });
});

// ── commitPlan gains the fallback (was: whole batch lost on one bad row) ────
describe('commitPlan — bulk failure resilience', () => {
  it('recovers per-row when the bulk update batch fails; surviving rows still count as filled', async () => {
    const { sb, calls } = makeFakeSupabase({
      tables: {
        assignments: (filters) => {
          if (filters.some(f => f.method === 'upsert')) return { data: null, error: { message: 'conflict' } };
          const eqId = filters.find(f => f.method === 'eq' && f.args[0] === 'id')?.args[1];
          return eqId === 'row-b'
            ? { data: null, error: { message: 'row gone' } }
            : { data: [{ id: eqId }], error: null };
        },
      },
    });
    const plan = {
      assignments: [
        pa({ slot_id: 'sA', existing_assignment_id: 'row-a' }),
        pa({ slot_id: 'sB', existing_assignment_id: 'row-b' }),
      ],
      unfilled: [],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await commitPlan(sb, plan as any);
    expect(res.filled).toBe(1); // row-a landed via fallback, row-b did not
    expect(res.errors.join(' ')).toContain('row gone');
    expect(callsFor(calls, 'assignments', 'update')).toHaveLength(2);
  });
});

// ── commitPlan executes seed evictions BEFORE the fill writes (2026-07-21) ──
describe('commitPlan — seed evictions', () => {
  const eviction = {
    date: '2026-09-30', code: 'D3',
    provider_id: 'hussain', provider_name: 'hussain',
    slot_id: 'slot-d3-0930', assignment_id: 'a-d3-0930',
    trigger_date: '2026-09-29', trigger_code: 'C2',
  };

  it('reverts the evicted seed row to open BEFORE any fill write lands', async () => {
    const { sb, calls } = makeFakeSupabase({ tables: { assignments: { data: [], error: null } } });
    const plan = {
      assignments: [pa({
        slot_id: 'd1-0930', slot_date: '2026-09-30', shift_type_code: 'D1',
        shift_type_category: 'regular', provider_id: 'hussain',
        existing_assignment_id: 'row-d1', source: 'd-chain' as const,
      })],
      unfilled: [],
      evictions: [eviction],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await commitPlan(sb, plan as any);
    expect(res.evicted).toBe(1);
    expect(res.filled).toBe(1);
    expect(res.errors).toEqual([]);

    const upserts = callsFor(calls, 'assignments', 'upsert');
    expect(upserts).toHaveLength(2);
    // FIRST write = the eviction revert (provider null, open, source manual —
    // mirroring sequenceAutoFill's revertToOpen), THEN the fill batch.
    const revertRows = upserts[0].args[0] as Array<Record<string, unknown>>;
    expect(revertRows).toEqual([{
      id: 'a-d3-0930', schedule_slot_id: 'slot-d3-0930',
      provider_id: null, assignment_status: 'open', source_type: 'manual',
      assigned_at: null, validation_flags: null,
    }]);
    const fillRows = upserts[1].args[0] as Array<Record<string, unknown>>;
    expect(fillRows.map(r => r.id)).toEqual(['row-d1']);
  });

  it('withholds the dependent post-call fill when the eviction revert fails (no double-booking)', async () => {
    const { sb, calls } = makeFakeSupabase({
      tables: {
        assignments: (filters) => {
          // Fail every REVERT write (bulk upsert of provider_id:null rows AND
          // its per-row update fallback); let everything else succeed.
          const up = filters.find(f => f.method === 'upsert');
          if (up && Array.isArray(up.args[0])
            && (up.args[0] as Array<Record<string, unknown>>)[0]?.provider_id === null) {
            return { data: null, error: { message: 'revert boom' } };
          }
          const upd = filters.find(f => f.method === 'update');
          if (upd && (upd.args[0] as Record<string, unknown>)?.provider_id === null) {
            return { data: null, error: { message: 'revert boom' } };
          }
          return { data: [], error: null };
        },
      },
    });
    const plan = {
      assignments: [
        // Dependent fill: same provider + date as the failed eviction → must
        // NOT be written (it would double-book against the surviving D3 row).
        pa({
          slot_id: 'd1-0930', slot_date: '2026-09-30', shift_type_code: 'D1',
          shift_type_category: 'regular', provider_id: 'hussain',
          existing_assignment_id: 'row-d1', source: 'd-chain' as const,
        }),
        // Unrelated fill: different date — still written.
        pa({
          slot_id: 'c2-0929', slot_date: '2026-09-29', shift_type_code: 'C2',
          provider_id: 'hussain', existing_assignment_id: 'row-c2',
        }),
      ],
      unfilled: [],
      evictions: [eviction],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await commitPlan(sb, plan as any);
    expect(res.evicted).toBe(0);
    expect(res.filled).toBe(1); // only the unrelated fill landed
    expect(res.errors.join(' ')).toContain('revert boom');
    expect(res.errors.join(' ')).toContain('Withheld the C2-chain fill on 2026-09-30');

    // The fill batch never contains the withheld row.
    const upserts = callsFor(calls, 'assignments', 'upsert');
    const fillBatches = upserts
      .map(u => u.args[0] as Array<Record<string, unknown>>)
      .filter(rows => rows[0]?.provider_id !== null);
    expect(fillBatches).toHaveLength(1);
    expect(fillBatches[0].map(r => r.id)).toEqual(['row-c2']);
  });

  it('a plan without evictions issues no revert write (pre-change byte path)', async () => {
    const { sb, calls } = makeFakeSupabase({ tables: { assignments: { data: [], error: null } } });
    const plan = {
      assignments: [pa({ slot_id: 'sA', existing_assignment_id: 'row-a' })],
      unfilled: [],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await commitPlan(sb, plan as any);
    expect(res.evicted).toBe(0);
    expect(callsFor(calls, 'assignments', 'upsert')).toHaveLength(1); // fills only
  });
});
