import { describe, it, expect } from 'vitest';
import { partitionForWrite, buildMetadataPayload, commitMetadata } from './commit';
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

  it('surfaces write errors', async () => {
    const { sb } = makeFakeSupabase({
      tables: {
        assignments: (filters) =>
          filters.some(f => f.method === 'upsert')
            ? { data: null, error: { message: 'boom' } }
            : { data: ROWS.slice(0, 1), error: null },
      },
    });
    const res = await commitMetadata(sb, [pa({ slot_id: 'slotA', provider_id: 'p1' })]);
    expect(res.errors.join(' ')).toContain('boom');
  });
});
