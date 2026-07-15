// revalidateNeighbors picks WHICH of a provider's nearby assignments to
// re-evaluate after an edit. Draft isolation (invariant 3): only committed
// (published) neighbors + the version being edited — an edit in one draft must
// not churn a different draft's stored flags. This asserts the query shape:
// the changed slot's version feeds includeVersionId and the published predicate
// is applied. (The merge/exclude/include semantics are unit-tested in
// committedAssignments.test.ts; the pick-only-committed behavior rides on it.)
import { describe, it, expect } from 'vitest';
import { revalidateNeighbors } from './neighborRevalidation';
import { makeFakeSupabase, callsFor } from './__fixtures__/fakeSupabase';
import type { Filter } from './__fixtures__/fakeSupabase';

describe('revalidateNeighbors — committed-scope neighbor selection', () => {
  it('reads the changed slot version and scopes the neighbor query to published + that version', async () => {
    const { sb, calls } = makeFakeSupabase({
      tables: {
        schedule_slots: { data: { slot_date: '2026-01-07', schedule_version_id: 'vEdit' }, error: null },
        // No neighbors → no evaluateAssignment recursion; we only assert shape.
        assignments: (_filters: Filter[]) => ({ data: [], error: null }),
      },
    });
    const rewritten = await revalidateNeighbors(sb, 'changed-slot', 'p1');
    expect(rewritten).toEqual([]);

    // The changed-slot read now selects schedule_version_id (needed as includeVersionId).
    const slotSelect = calls.find(c => c.table === 'schedule_slots' && c.method === 'select');
    expect(slotSelect!.args[0]).toContain('schedule_version_id');

    // Two committed-scope reads: published + the edited version.
    expect(callsFor(calls, 'assignments', 'from')).toHaveLength(2);
    const published = calls.filter(c => c.table === 'assignments' && c.method === 'eq'
      && c.args[0] === 'schedule_slots.schedule_versions.version_status' && c.args[1] === 'published');
    expect(published).toHaveLength(1);
    const currentVersion = calls.filter(c => c.table === 'assignments' && c.method === 'eq'
      && c.args[0] === 'schedule_slots.schedule_version_id' && c.args[1] === 'vEdit');
    expect(currentVersion).toHaveLength(1);
  });

  it('no provider → no work, no queries', async () => {
    const { sb, calls } = makeFakeSupabase({ tables: {} });
    const rewritten = await revalidateNeighbors(sb, 'changed-slot', null);
    expect(rewritten).toEqual([]);
    expect(callsFor(calls, 'assignments', 'from')).toHaveLength(0);
  });
});
