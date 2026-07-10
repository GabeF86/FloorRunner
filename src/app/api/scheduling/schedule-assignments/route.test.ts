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
  holder.fill = { filledSlotIds: [], evictedSlotIds: [], skips: [], patternWarnings: [] };
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
      skips: [{ date: '2026-01-06', code: 'D1', provider_id: 'p1', reason: 'pto' }],
      patternWarnings: ['w1'],
    };
    const { calls } = setupPost([
      joinedRow('slot-A', { validation_flags: [{ severity: 'warning' }] }),
      joinedRow('slot-B'),
      joinedRow('slot-C', { provider_id: null, assignment_status: 'open', providers: null }),
    ]);

    const res = await POST(fakeReq({ schedule_slot_id: 'slot-A', provider_id: 'p1' }));
    const json = await res.json();

    // The manual edit's row, re-selected with the grid column shape + summary.
    expect(json.assignment.schedule_slot_id).toBe('slot-A');
    expect(json.assignment.providers).toEqual({ id: 'p1', last_name: 'Smith', short_display_name: 'S. Smith', initials: 'SS', provider_type: 'physician' });
    expect(json.assignment.validation_summary).toEqual({ hard: 0, soft: 0, warning: 1 });

    // Every other affected cell rides along so the client can patch them.
    expect(json.siblings.map((s: { schedule_slot_id: string }) => s.schedule_slot_id).sort()).toEqual(['slot-B', 'slot-C']);
    expect(json.siblings.every((s: { validation_summary: unknown }) => s.validation_summary !== undefined)).toBe(true);

    // The re-select used the shared grid column shape over all affected slots.
    const reselect = callsFor(calls, 'assignments', 'select').find(c => c.args[0] === GRID_ASSIGNMENT_COLUMNS);
    expect(reselect).toBeDefined();
    const inCall = callsFor(calls, 'assignments', 'in').find(c => c.args[0] === 'schedule_slot_id');
    expect((inCall?.args[1] as string[]).sort()).toEqual(['slot-A', 'slot-B', 'slot-C']);

    // Task 10 fields stay backward compatible.
    expect(json.filledSlotIds).toEqual(['slot-B']);
    expect(json.evictedSlotIds).toEqual(['slot-C']);
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
});
