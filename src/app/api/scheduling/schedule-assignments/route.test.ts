// POST/PATCH/DELETE /api/scheduling/schedule-assignments — Task 12: after the
// write + sequence auto-fill, the route re-selects every affected assignment
// row in the grid column shape and returns { assignment, siblings } so the
// client can patch cells in place without a full grid refetch.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { makeFakeSupabase, callsFor, type Filter } from '@/lib/rulesEngine/__fixtures__/fakeSupabase';
import { GRID_ASSIGNMENT_COLUMNS } from '../schedules/[id]/grid/route.helpers';

const holder = vi.hoisted(() => ({
  sb: null as unknown,
  fill: {
    filledSlotIds: [] as string[],
    evictedSlotIds: [] as string[],
    postCallClearedSlotIds: [] as string[],
    skips: [] as unknown[],
    patternWarnings: [] as string[],
  },
  cleanup: { clearedSlotIds: [] as string[], patternWarnings: [] as string[] },
}));
vi.mock('@/lib/supabaseScheduling', () => ({
  sbSchedulingServer: () => holder.sb,
}));
vi.mock('@/lib/rulesEngine/evaluate', () => ({
  evaluateAssignment: async () => ({
    slotId: 'slot-A', providerId: 'p1', violations: [], hardCount: 0, softCount: 0, evaluated: true,
  }),
  validationFlagsFor: () => [],
}));
vi.mock('@/lib/rulesEngine/sequenceAutoFill', () => ({
  applySequenceAutoFill: async () => holder.fill,
  cleanupSequenceAutoFill: async () => holder.cleanup,
}));

import { POST, PATCH, DELETE } from './route';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function joinedRow(slotId: string, over: Record<string, unknown> = {}) {
  return {
    id: `a-${slotId}`,
    schedule_slot_id: slotId,
    provider_id: 'p1',
    assignment_status: 'assigned',
    is_open_call: false,
    manually_overridden: false,
    validation_flags: [] as unknown[],
    providers: { id: 'p1', last_name: 'Smith', short_display_name: 'S. Smith', initials: 'SS', provider_type: 'physician' },
    ...over,
  };
}

const has = (filters: Filter[], method: string, firstArg?: unknown) =>
  filters.some(f => f.method === method && (firstArg === undefined || f.args[0] === firstArg));

function fakeReq(body: Record<string, unknown>): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  holder.sb = null;
  holder.fill = {
    filledSlotIds: [], evictedSlotIds: [], postCallClearedSlotIds: [], skips: [], patternWarnings: [],
  };
  holder.cleanup = { clearedSlotIds: [], patternWarnings: [] };
});

// ── POST ─────────────────────────────────────────────────────────────────────

describe('POST /api/scheduling/schedule-assignments', () => {
  function setupPost(reselectRows: Record<string, unknown>[]) {
    const { sb, calls } = makeFakeSupabase({
      tables: {
        schedule_slots: { data: { slot_date: '2026-01-05' }, error: null },
        assignments: (filters) => {
          if (has(filters, 'upsert')) return { data: { id: 'a-slot-A', schedule_slot_id: 'slot-A', provider_id: 'p1' }, error: null };
          if (has(filters, 'in', 'schedule_slot_id')) return { data: reselectRows, error: null };
          return { data: [], error: null }; // neighbor revalidation
        },
      },
    });
    holder.sb = sb;
    return { calls };
  }

  it('returns the joined assignment row plus siblings for auto-filled and evicted slots', async () => {
    holder.fill = {
      filledSlotIds: ['slot-B'],
      evictedSlotIds: ['slot-C'],
      // Post-call sweep (2026-07-29): a day shift vacated because this
      // placement blocked the provider's next day. It must ride along in
      // siblings or the grid keeps painting a name on a cleared cell.
      postCallClearedSlotIds: ['slot-D'],
      skips: [{ date: '2026-01-06', code: 'D1', provider_id: 'p1', reason: 'pto' }],
      patternWarnings: ['w1'],
    };
    const { calls } = setupPost([
      joinedRow('slot-A', { validation_flags: [{ severity: 'warning' }] }),
      joinedRow('slot-B'),
      joinedRow('slot-C', { provider_id: null, assignment_status: 'open', providers: null }),
      joinedRow('slot-D', { provider_id: null, assignment_status: 'open', providers: null }),
    ]);

    const res = await POST(fakeReq({ schedule_slot_id: 'slot-A', provider_id: 'p1' }));
    const json = await res.json();

    // The manual edit's row, re-selected with the grid column shape + summary.
    expect(json.assignment.schedule_slot_id).toBe('slot-A');
    expect(json.assignment.providers).toEqual({ id: 'p1', last_name: 'Smith', short_display_name: 'S. Smith', initials: 'SS', provider_type: 'physician' });
    expect(json.assignment.validation_summary).toEqual({ hard: 0, soft: 0, warning: 1 });

    // Every other affected cell rides along so the client can patch them.
    expect(json.siblings.map((s: { schedule_slot_id: string }) => s.schedule_slot_id).sort()).toEqual(['slot-B', 'slot-C', 'slot-D']);
    expect(json.siblings.every((s: { validation_summary: unknown }) => s.validation_summary !== undefined)).toBe(true);

    // The re-select used the shared grid column shape over all affected slots.
    const reselect = callsFor(calls, 'assignments', 'select').find(c => c.args[0] === GRID_ASSIGNMENT_COLUMNS);
    expect(reselect).toBeDefined();
    const inCall = callsFor(calls, 'assignments', 'in').find(c => c.args[0] === 'schedule_slot_id');
    expect((inCall?.args[1] as string[]).sort()).toEqual(['slot-A', 'slot-B', 'slot-C', 'slot-D']);

    // Task 10 fields stay backward compatible.
    expect(json.filledSlotIds).toEqual(['slot-B']);
    expect(json.evictedSlotIds).toEqual(['slot-C']);
    expect(json.postCallClearedSlotIds).toEqual(['slot-D']);
    expect(json.skips).toEqual([{ date: '2026-01-06', code: 'D1', provider_id: 'p1', reason: 'pto' }]);
    expect(json.patternWarnings).toEqual(['w1']);
    expect(json.id).toBe('a-slot-A');
  });

  it('returns assignment with empty siblings when auto-fill touched nothing', async () => {
    setupPost([joinedRow('slot-A')]);
    const res = await POST(fakeReq({ schedule_slot_id: 'slot-A', provider_id: 'p1' }));
    const json = await res.json();
    expect(json.assignment.schedule_slot_id).toBe('slot-A');
    expect(json.siblings).toEqual([]);
  });

  it('includes slots revalidated as neighbors in the re-select so their fresh flags reach the client', async () => {
    // Neighbor revalidation finds slot-N (same provider, ±7 days) and rewrites
    // its stored flags — the re-select must cover it, or the client keeps
    // stale flags on that cell (freshness regression vs a full grid reload).
    const { sb, calls } = makeFakeSupabase({
      tables: {
        schedule_slots: { data: { slot_date: '2026-01-05' }, error: null },
        assignments: (filters) => {
          if (has(filters, 'upsert')) return { data: { id: 'a-slot-A', schedule_slot_id: 'slot-A', provider_id: 'p1' }, error: null };
          if (has(filters, 'in', 'schedule_slot_id')) return { data: [joinedRow('slot-A'), joinedRow('slot-N')], error: null };
          if (has(filters, 'eq', 'provider_id')) return { data: [{ id: 'a-slot-N', schedule_slot_id: 'slot-N' }], error: null };
          return { data: [], error: null }; // the flag-update write
        },
      },
    });
    holder.sb = sb;

    const res = await POST(fakeReq({ schedule_slot_id: 'slot-A', provider_id: 'p1' }));
    const json = await res.json();

    const inCall = callsFor(calls, 'assignments', 'in').find(c => c.args[0] === 'schedule_slot_id');
    expect((inCall?.args[1] as string[]).sort()).toEqual(['slot-A', 'slot-N']);
    expect(json.siblings.map((s: { schedule_slot_id: string }) => s.schedule_slot_id)).toEqual(['slot-N']);
  });

  // ── The manual billing mark dies with the assignment (2026-07-28) ──────────
  // ON CONFLICT DO UPDATE rewrites only the columns the payload names. This
  // upsert is also the REASSIGNMENT path (it flips provider_id on an existing
  // row), so without naming highlight_color, provider A's hand-set "billable"
  // mark would survive onto provider B's call — the same stale-data failure the
  // route already guards against for validation_flags, and worse here because
  // the mark's entire purpose is to tell a physician which of THEIR calls pays.
  it('clears highlight_color on the upsert so a reassignment cannot inherit the previous provider\'s mark', async () => {
    const { sb, calls } = makeFakeSupabase({
      tables: {
        schedule_slots: { data: { slot_date: '2026-01-05' }, error: null },
        assignments: (filters) => {
          if (has(filters, 'upsert')) {
            return { data: { id: 'a-slot-A', schedule_slot_id: 'slot-A', provider_id: 'p1' }, error: null };
          }
          if (has(filters, 'in', 'schedule_slot_id')) return { data: [joinedRow('slot-A')], error: null };
          return { data: [], error: null };
        },
      },
    });
    holder.sb = sb;
    await POST(fakeReq({ schedule_slot_id: 'slot-A', provider_id: 'p1' }));
    const payload = callsFor(calls, 'assignments', 'upsert')[0].args[0] as Record<string, unknown>;
    expect(payload).toHaveProperty('highlight_color', null);
    // The pre-existing payload is otherwise untouched.
    expect(payload.provider_id).toBe('p1');
    expect(payload.assignment_status).toBe('assigned');
    expect(payload.source_type).toBe('manual');
  });

  // Pre-patch42 DB: naming a column that does not exist would fail the write
  // outright, turning "highlighting isn't available yet" into "you cannot
  // assign anyone". The retry drops it — exact, since a missing column holds
  // no mark.
  it('retries the upsert without highlight_color on a pre-patch42 DB rather than failing the assignment', async () => {
    const { sb, calls } = makeFakeSupabase({
      tables: {
        schedule_slots: { data: { slot_date: '2026-01-05' }, error: null },
        assignments: (filters) => {
          const upsert = filters.find(f => f.method === 'upsert');
          if (upsert) {
            const payload = upsert.args[0] as Record<string, unknown>;
            if ('highlight_color' in payload) {
              return { data: null, error: { message: "Could not find the 'highlight_color' column of 'assignments' in the schema cache", code: 'PGRST204' } };
            }
            return { data: { id: 'a-slot-A', schedule_slot_id: 'slot-A', provider_id: 'p1' }, error: null };
          }
          if (has(filters, 'in', 'schedule_slot_id')) return { data: [joinedRow('slot-A')], error: null };
          return { data: [], error: null };
        },
      },
    });
    holder.sb = sb;

    const res = await POST(fakeReq({ schedule_slot_id: 'slot-A', provider_id: 'p1' }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.id).toBe('a-slot-A'); // the assignment still landed
    const upserts = callsFor(calls, 'assignments', 'upsert').map(c => c.args[0] as Record<string, unknown>);
    expect(upserts).toHaveLength(2);
    expect(upserts[0]).toHaveProperty('highlight_color');
    expect(upserts[1]).not.toHaveProperty('highlight_color');
    expect(upserts[1].provider_id).toBe('p1');
  });

  // A genuine write failure must not be laundered into a retry-and-succeed.
  it('does not retry the upsert on a non-column error', async () => {
    const { sb, calls } = makeFakeSupabase({
      tables: {
        schedule_slots: { data: { slot_date: '2026-01-05' }, error: null },
        assignments: (filters) => has(filters, 'upsert')
          ? { data: null, error: { message: 'duplicate key value violates unique constraint', code: '23505' } }
          : { data: [], error: null },
      },
    });
    holder.sb = sb;
    const res = await POST(fakeReq({ schedule_slot_id: 'slot-A', provider_id: 'p1' }));
    expect(res.status).toBe(500);
    expect(callsFor(calls, 'assignments', 'upsert')).toHaveLength(1);
  });
});

// ── PATCH ────────────────────────────────────────────────────────────────────

describe('PATCH /api/scheduling/schedule-assignments', () => {
  it('returns the re-selected joined row as assignment', async () => {
    const { sb, calls } = makeFakeSupabase({
      tables: {
        assignments: (filters) => has(filters, 'update')
          ? { data: { id: 'a-slot-A', notes: 'x' }, error: null }
          : { data: joinedRow('slot-A'), error: null },
      },
    });
    holder.sb = sb;

    const res = await PATCH(fakeReq({ id: 'a-slot-A', notes: 'x' }));
    const json = await res.json();
    expect(json.id).toBe('a-slot-A'); // backward-compatible raw row spread
    expect(json.assignment.schedule_slot_id).toBe('slot-A');
    expect(json.assignment.validation_summary).toEqual({ hard: 0, soft: 0, warning: 0 });
    expect(callsFor(calls, 'assignments', 'select').some(c => c.args[0] === GRID_ASSIGNMENT_COLUMNS)).toBe(true);
  });
});

// ── PATCH highlight_color (2026-07-28, patch42) ──────────────────────────────
// The manual billing mark. Route-hardened the same way the schedule PATCH
// hardens provider_limits / schedule_name / scenario_manifest: validated
// server-side BEFORE any write, a bad value is a 400, and the DB CHECK is the
// last line of defence rather than the first.
describe('PATCH highlight_color validation', () => {
  function setupPatch(updateResult?: { data?: unknown; error?: unknown }) {
    const { sb, calls } = makeFakeSupabase({
      tables: {
        assignments: (filters) => has(filters, 'update')
          ? (updateResult ?? { data: { id: 'a-slot-A', highlight_color: 'blue' }, error: null })
          : { data: joinedRow('slot-A', { highlight_color: 'blue' }), error: null },
      },
    });
    holder.sb = sb;
    return { calls };
  }

  const updatePayload = (calls: ReturnType<typeof makeFakeSupabase>['calls']) =>
    callsFor(calls, 'assignments', 'update')[0]?.args[0] as Record<string, unknown> | undefined;

  it.each(['blue', 'red', 'yellow'])('writes %s and returns the re-selected joined row', async (color) => {
    const { calls } = setupPatch();
    const res = await PATCH(fakeReq({ id: 'a-slot-A', highlight_color: color }));
    expect(res.status).toBe(200);
    expect(updatePayload(calls)).toEqual({ highlight_color: color });
    const json = await res.json();
    expect(json.assignment.highlight_color).toBe('blue'); // from the fake re-select
  });

  it('writes null to clear the manual mark', async () => {
    const { calls } = setupPatch();
    const res = await PATCH(fakeReq({ id: 'a-slot-A', highlight_color: null }));
    expect(res.status).toBe(200);
    expect(updatePayload(calls)).toEqual({ highlight_color: null });
  });

  // The client is NEVER trusted. Each of these is a 400 with nothing written —
  // a typo must not become an invisible colour, and must not be silently
  // coerced to null either (a dropped colour looks exactly like one that never
  // saved).
  it.each([
    ['an unlisted colour', 'green'],
    ['wrong case', 'Blue'],
    ['the empty string', ''],
    ['a number', 3],
    ['a boolean', true],
    ['an object', { color: 'blue' }],
    ['an array', ['blue']],
    ['an injection-shaped string', "blue'; DROP TABLE scheduling.assignments; --"],
  ])('rejects %s with a 400 and never touches the DB', async (_label, value) => {
    const { calls } = setupPatch();
    const res = await PATCH(fakeReq({ id: 'a-slot-A', highlight_color: value }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('blue, red, yellow');
    expect(callsFor(calls, 'assignments', 'update')).toHaveLength(0);
  });

  // `undefined` is indistinguishable from an absent key after JSON transit, but
  // an explicit undefined in-process must not slip past the gate either.
  it('rejects an explicit undefined rather than writing it', async () => {
    const { calls } = setupPatch();
    const res = await PATCH(fakeReq({ id: 'a-slot-A', highlight_color: undefined }));
    expect(res.status).toBe(400);
    expect(callsFor(calls, 'assignments', 'update')).toHaveLength(0);
  });

  it('leaves PATCHes that do not mention highlight_color completely untouched', async () => {
    const { calls } = setupPatch();
    const res = await PATCH(fakeReq({ id: 'a-slot-A', notes: 'x' }));
    expect(res.status).toBe(200);
    expect(updatePayload(calls)).toEqual({ notes: 'x' });
    expect(updatePayload(calls)).not.toHaveProperty('highlight_color');
  });

  // Pre-patch42 DB: a write has nowhere to go (unlike a read, which degrades by
  // dropping the column), so the route says exactly that instead of leaking a
  // raw PostgREST column error.
  it('answers a pre-patch42 DB with a 501 naming the patch, not an opaque 500', async () => {
    setupPatch({ data: null, error: { message: "Could not find the 'highlight_color' column of 'assignments' in the schema cache", code: 'PGRST204' } });
    const res = await PATCH(fakeReq({ id: 'a-slot-A', highlight_color: 'blue' }));
    expect(res.status).toBe(501);
    expect((await res.json()).error).toContain('patch42');
  });

  // The 501 branch is scoped to highlight PATCHes: an unrelated column error on
  // an unrelated PATCH must stay a plain 500.
  it('a column error on a PATCH that never mentioned highlight_color is still a 500', async () => {
    setupPatch({ data: null, error: { message: 'column assignments.bogus does not exist', code: '42703' } });
    const res = await PATCH(fakeReq({ id: 'a-slot-A', notes: 'x' }));
    expect(res.status).toBe(500);
  });
});

// ── DELETE ───────────────────────────────────────────────────────────────────

describe('DELETE /api/scheduling/schedule-assignments', () => {
  it('returns the recreated open row plus sibling rows for cleared auto-fills', async () => {
    holder.cleanup = { clearedSlotIds: ['slot-B'], patternWarnings: [] };
    const openRow = (slotId: string) =>
      joinedRow(slotId, { provider_id: null, assignment_status: 'open', providers: null, validation_flags: null });
    const { sb, calls } = makeFakeSupabase({
      tables: {
        schedule_slots: { data: { slot_date: '2026-01-05' }, error: null },
        assignments: (filters) => {
          if (has(filters, 'delete')) return { data: null, error: null };
          if (has(filters, 'insert')) return { data: { id: 'a-open', schedule_slot_id: 'slot-A', assignment_status: 'open' }, error: null };
          if (has(filters, 'in', 'schedule_slot_id')) return { data: [openRow('slot-A'), openRow('slot-B')], error: null };
          if (has(filters, 'eq', 'id')) return { data: { schedule_slot_id: 'slot-A', provider_id: 'p1' }, error: null };
          return { data: [], error: null }; // neighbor revalidation
        },
      },
    });
    holder.sb = sb;

    const res = await DELETE({ url: 'http://x/api/scheduling/schedule-assignments?id=a-slot-A' } as unknown as NextRequest);
    const json = await res.json();

    expect(json.assignment.schedule_slot_id).toBe('slot-A');
    expect(json.assignment.assignment_status).toBe('open');
    expect(json.assignment.validation_summary).toBeNull(); // flags null → never validated
    expect(json.siblings.map((s: { schedule_slot_id: string }) => s.schedule_slot_id)).toEqual(['slot-B']);
    expect(json.clearedSlotIds).toEqual(['slot-B']); // Task 10 field preserved
    expect(json.id).toBe('a-open'); // backward-compatible recreated-open spread

    const inCall = callsFor(calls, 'assignments', 'in').find(c => c.args[0] === 'schedule_slot_id');
    expect((inCall?.args[1] as string[]).sort()).toEqual(['slot-A', 'slot-B']);
  });

  // Clearing a cell takes the manual mark with it, structurally rather than by
  // any explicit clearing step: DELETE removes the whole row (mark included)
  // and re-inserts a fresh 'open' row that names only schedule_slot_id,
  // assignment_status and source_type — so highlight_color lands at its column
  // default, NULL. This test pins that the re-insert never carries one.
  it('the recreated open row carries no highlight_color — clearing a cell clears the mark', async () => {
    const { sb, calls } = makeFakeSupabase({
      tables: {
        schedule_slots: { data: { slot_date: '2026-01-05' }, error: null },
        assignments: (filters) => {
          if (has(filters, 'delete')) return { data: null, error: null };
          if (has(filters, 'insert')) return { data: { id: 'a-open', schedule_slot_id: 'slot-A', assignment_status: 'open' }, error: null };
          if (has(filters, 'in', 'schedule_slot_id')) return { data: [], error: null };
          if (has(filters, 'eq', 'id')) return { data: { schedule_slot_id: 'slot-A', provider_id: 'p1' }, error: null };
          return { data: [], error: null };
        },
      },
    });
    holder.sb = sb;

    await DELETE({ url: 'http://x/api/scheduling/schedule-assignments?id=a-slot-A' } as unknown as NextRequest);

    // The row that HELD the mark is deleted outright...
    expect(callsFor(calls, 'assignments', 'delete')).toHaveLength(1);
    // ...and the replacement is born unmarked (column default NULL).
    const insertPayload = callsFor(calls, 'assignments', 'insert')[0].args[0] as Record<string, unknown>;
    expect(insertPayload).not.toHaveProperty('highlight_color');
    expect(insertPayload).toEqual({
      schedule_slot_id: 'slot-A', assignment_status: 'open', source_type: 'manual',
    });
  });
});

// ── cell comments (Gabriel 2026-08-02) ──────────────────────────────────────
// "right click on a cell and leave a comment so that when that cell is hovered
// over, the comment appears." Stored on assignments.notes.
describe('cell comment hardening', () => {
  const patchWith = async (notes: unknown) => {
    const { sb, calls } = makeFakeSupabase({
      tables: {
        assignments: (filters) => has(filters, 'update')
          ? { data: { id: 'a-1' }, error: null }
          : { data: joinedRow('slot-A'), error: null },
      },
    });
    holder.sb = sb;
    const res = await PATCH(fakeReq({ id: 'a-1', notes }));
    const update = callsFor(calls, 'assignments', 'update')[0]?.args[0] as
      Record<string, unknown> | undefined;
    return { res, json: await res.json(), update };
  };

  it('trims, so a blank-looking comment is genuinely absent', async () => {
    const { update } = await patchWith('   covering for Jones   ');
    expect(update?.notes).toBe('covering for Jones');
  });

  it('whitespace-only clears rather than rendering an empty tooltip', async () => {
    expect((await patchWith('   ')).update?.notes).toBeNull();
    expect((await patchWith('')).update?.notes).toBeNull();
  });

  it('explicit null clears', async () => {
    expect((await patchWith(null)).update?.notes).toBeNull();
  });

  it('rejects a non-string before it reaches the DB', async () => {
    for (const bad of [42, {}, ['a'], true]) {
      const { res } = await patchWith(bad);
      expect(res.status).toBe(400);
    }
  });

  it('rejects an over-long comment with a message naming the limit', async () => {
    const { res, json } = await patchWith('x'.repeat(501));
    expect(res.status).toBe(400);
    expect(json.error).toContain('501/500');
  });

  it('accepts exactly the limit', async () => {
    const { res, update } = await patchWith('x'.repeat(500));
    expect(res.status).toBe(200);
    expect((update?.notes as string).length).toBe(500);
  });
});

describe('a reassignment clears the comment', () => {
  it('names notes in the upsert, like highlight_color', async () => {
    // Unnamed columns survive ON CONFLICT DO UPDATE, so a comment about THIS
    // placement ("covering for Jones") would otherwise ride onto whoever
    // replaces them — a line the scheduler never wrote about a person it was
    // never about.
    const { sb, calls } = makeFakeSupabase({
      tables: {
        schedule_slots: { data: { slot_date: '2026-01-05' }, error: null },
        assignments: (filters) => {
          if (has(filters, 'upsert')) {
            return { data: { id: 'a-slot-A', schedule_slot_id: 'slot-A', provider_id: 'p1' }, error: null };
          }
          if (has(filters, 'in', 'schedule_slot_id')) return { data: [joinedRow('slot-A')], error: null };
          return { data: [], error: null };
        },
      },
    });
    holder.sb = sb;
    await POST(fakeReq({ schedule_slot_id: 'slot-A', provider_id: 'p1' }));
    const upsert = callsFor(calls, 'assignments', 'upsert')[0]?.args[0] as
      Record<string, unknown>;
    expect(upsert).toHaveProperty('notes', null);
    expect(upsert).toHaveProperty('highlight_color', null);
  });
});
