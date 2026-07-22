// Call splitting (2026-07-22): split a whole 24h call slot into 2×12 or 3×8
// SEGMENT slots, and unsplit back. Core logic lives in scheduleSplit.ts with
// an injected supabase client (the sequenceAutoFill idiom) so the routes stay
// thin. Guards are pinned here: slot exists, category call, not already a
// segment, its assignment OPEN, version current — 4xx with clear messages,
// never a silent write.
import { describe, it, expect } from 'vitest';
import { makeFakeSupabase, type Filter, type TableCfg } from './rulesEngine/__fixtures__/fakeSupabase';
import { splitCallSlot, unsplitCallSlot } from './scheduleSplit';

const has = (filters: Filter[], method: string, firstArg?: unknown) =>
  filters.some(f => f.method === method && (firstArg === undefined || f.args[0] === firstArg));
const eqArg = (filters: Filter[], col: string) =>
  filters.find(f => f.method === 'eq' && f.args[0] === col)?.args[1];

// ── fixtures ────────────────────────────────────────────────────────────────

const PARENT_SLOT = {
  id: 'slot-P', slot_date: '2026-02-07', site_id: 'site1',
  schedule_version_id: 'ver1', derived_day_type: 'saturday', locked: false,
  required_count: 1,
  shift_types: { id: 'st-C1', code: 'C1', category: 'call', parent_call_code: null },
  assignments: [{ id: 'a-P', provider_id: null }],
};

const SEGMENT_TYPES = [
  { id: 'st-C1D12', code: 'C1D12', duration_hours: 12, start_time: '07:00:00', display_order: 20 },
  { id: 'st-C1N12', code: 'C1N12', duration_hours: 12, start_time: '19:00:00', display_order: 21 },
  { id: 'st-C1D8', code: 'C1D8', duration_hours: 8, start_time: '07:00:00', display_order: 22 },
  { id: 'st-C1E8', code: 'C1E8', duration_hours: 8, start_time: '15:00:00', display_order: 23 },
  { id: 'st-C1N8', code: 'C1N8', duration_hours: 8, start_time: '23:00:00', display_order: 24 },
];

function splitTables(over: Record<string, TableCfg> = {}): Record<string, TableCfg> {
  return {
    schedule_slots: (filters: Filter[]) => {
      if (has(filters, 'insert')) {
        const rows = filters.find(f => f.method === 'insert')!.args[0] as Array<Record<string, unknown>>;
        return { data: rows.map((_, i) => ({ id: `seg-${i}` })), error: null };
      }
      if (has(filters, 'delete')) return { data: null, error: null };
      if (has(filters, 'eq', 'id')) return { data: PARENT_SLOT, error: null };
      return { data: [], error: null }; // already-split guard scan
    },
    schedule_versions: (filters: Filter[]) => {
      if (has(filters, 'eq', 'id')) return { data: { schedule_id: 'sched1', version_number: 3 }, error: null };
      return { data: [{ id: 'ver1', version_number: 3 }], error: null }; // latest-version lookup
    },
    shift_types: (filters: Filter[]) => {
      if (has(filters, 'eq', 'parent_call_code')) return { data: SEGMENT_TYPES, error: null };
      return { data: { id: 'st-C1', code: 'C1' }, error: null };
    },
    assignments: { data: null, error: null },
    ...over,
  };
}

// ── split ───────────────────────────────────────────────────────────────────

describe('splitCallSlot', () => {
  it('2x12: creates the two 12h segment slots + open assignments, then deletes the parent slot', async () => {
    const { sb, calls } = makeFakeSupabase({ tables: splitTables() });
    const out = await splitCallSlot(sb, 'slot-P', '2x12');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.createdSlotIds).toHaveLength(2);
    expect(out.deletedSlotId).toBe('slot-P');
    expect(out.segmentCodes).toEqual(['C1D12', 'C1N12']);

    // Segment slot rows: same version/site/date/derived_day_type, the two 12h
    // types in display_order, slot_index 0..1, required_count 1, unlocked.
    const insert = calls.find(c => c.table === 'schedule_slots' && c.method === 'insert')!;
    const rows = insert.args[0] as Array<Record<string, unknown>>;
    expect(rows.map(r => r.shift_type_id)).toEqual(['st-C1D12', 'st-C1N12']);
    expect(rows.every(r =>
      r.schedule_version_id === 'ver1' && r.site_id === 'site1'
      && r.slot_date === '2026-02-07' && r.derived_day_type === 'saturday'
      && r.required_count === 1 && r.locked === false)).toBe(true);
    expect(rows.map(r => r.slot_index)).toEqual([0, 1]);

    // One OPEN placeholder assignment per created slot (the creation idiom).
    const aInsert = calls.find(c => c.table === 'assignments' && c.method === 'insert')!;
    const aRows = aInsert.args[0] as Array<Record<string, unknown>>;
    expect(aRows).toEqual([
      { schedule_slot_id: 'seg-0', assignment_status: 'open', source_type: 'manual' },
      { schedule_slot_id: 'seg-1', assignment_status: 'open', source_type: 'manual' },
    ]);

    // Parent slot deleted (its open assignment rides the FK cascade).
    const del = calls.filter(c => c.table === 'schedule_slots' && c.method === 'delete');
    expect(del).toHaveLength(1);
  });

  it('3x8: creates the three 8h segment slots', async () => {
    const { sb, calls } = makeFakeSupabase({ tables: splitTables() });
    const out = await splitCallSlot(sb, 'slot-P', '3x8');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.createdSlotIds).toHaveLength(3);
    expect(out.segmentCodes).toEqual(['C1D8', 'C1E8', 'C1N8']);
    const insert = calls.find(c => c.table === 'schedule_slots' && c.method === 'insert')!;
    expect((insert.args[0] as Array<Record<string, unknown>>).map(r => r.shift_type_id))
      .toEqual(['st-C1D8', 'st-C1E8', 'st-C1N8']);
  });

  it('409 when the slot assignment is NOT open (scheduler clears first)', async () => {
    const { sb, calls } = makeFakeSupabase({ tables: splitTables({
      schedule_slots: { data: { ...PARENT_SLOT, assignments: [{ id: 'a-P', provider_id: 'p1' }] }, error: null },
    }) });
    const out = await splitCallSlot(sb, 'slot-P', '2x12');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.status).toBe(409);
    expect(out.error).toMatch(/assign/i);
    // Nothing was written.
    expect(calls.some(c => c.method === 'insert' || c.method === 'delete')).toBe(false);
  });

  it('409 when the slot is already a segment (segment-of-segment)', async () => {
    const { sb } = makeFakeSupabase({ tables: splitTables({
      schedule_slots: { data: { ...PARENT_SLOT, shift_types: { id: 'st-C1D12', code: 'C1D12', category: 'call', parent_call_code: 'C1' } }, error: null },
    }) });
    const out = await splitCallSlot(sb, 'slot-P', '2x12');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.status).toBe(409);
    expect(out.error).toMatch(/segment/i);
  });

  it('409 when segments for this parent already exist on the date (double-split)', async () => {
    const { sb } = makeFakeSupabase({ tables: splitTables({
      schedule_slots: (filters: Filter[]) => {
        if (has(filters, 'eq', 'id')) return { data: PARENT_SLOT, error: null };
        return { data: [{ id: 'seg-existing' }], error: null }; // guard scan finds segments
      },
    }) });
    const out = await splitCallSlot(sb, 'slot-P', '2x12');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.status).toBe(409);
    expect(out.error).toMatch(/already split/i);
  });

  it('400 for a non-call slot and for an unknown mode', async () => {
    const { sb } = makeFakeSupabase({ tables: splitTables({
      schedule_slots: { data: { ...PARENT_SLOT, shift_types: { id: 'st-D4', code: 'D4', category: 'regular', parent_call_code: null } }, error: null },
    }) });
    const nonCall = await splitCallSlot(sb, 'slot-P', '2x12');
    expect(nonCall.ok).toBe(false);
    if (!nonCall.ok) expect(nonCall.status).toBe(400);

    const { sb: sb2 } = makeFakeSupabase({ tables: splitTables() });
    const badMode = await splitCallSlot(sb2, 'slot-P', 'halves' as never);
    expect(badMode.ok).toBe(false);
    if (!badMode.ok) expect(badMode.status).toBe(400);
  });

  it('404 when the slot does not exist', async () => {
    const { sb } = makeFakeSupabase({ tables: splitTables({
      schedule_slots: { data: null, error: null },
    }) });
    const out = await splitCallSlot(sb, 'nope', '2x12');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.status).toBe(404);
  });

  it('409 when the slot version is not the schedule current version', async () => {
    const { sb } = makeFakeSupabase({ tables: splitTables({
      schedule_versions: (filters: Filter[]) => {
        if (has(filters, 'eq', 'id')) return { data: { schedule_id: 'sched1', version_number: 2 }, error: null };
        return { data: [{ id: 'ver9', version_number: 3 }], error: null };
      },
    }) });
    const out = await splitCallSlot(sb, 'slot-P', '2x12');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.status).toBe(409);
    expect(out.error).toMatch(/current version/i);
  });

  it('409 with an apply-patch35 hint when segment shift types are not configured', async () => {
    const { sb } = makeFakeSupabase({ tables: splitTables({
      shift_types: (filters: Filter[]) => {
        if (has(filters, 'eq', 'parent_call_code')) {
          return { data: null, error: { message: 'column shift_types.parent_call_code does not exist', code: '42703' } };
        }
        return { data: { id: 'st-C1', code: 'C1' }, error: null };
      },
    }) });
    const out = await splitCallSlot(sb, 'slot-P', '2x12');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.status).toBe(409);
    expect(out.error).toMatch(/patch35|not configured/i);
  });

  it('compensates (deletes created segment slots) when the parent delete fails', async () => {
    const { sb, calls } = makeFakeSupabase({ tables: splitTables({
      schedule_slots: (filters: Filter[]) => {
        if (has(filters, 'insert')) {
          const rows = filters.find(f => f.method === 'insert')!.args[0] as Array<Record<string, unknown>>;
          return { data: rows.map((_, i) => ({ id: `seg-${i}` })), error: null };
        }
        if (has(filters, 'delete') && has(filters, 'eq', 'id') && eqArg(filters, 'id') === 'slot-P') {
          return { data: null, error: { message: 'boom' } };
        }
        if (has(filters, 'delete')) return { data: null, error: null };
        if (has(filters, 'eq', 'id')) return { data: PARENT_SLOT, error: null };
        return { data: [], error: null };
      },
    }) });
    const out = await splitCallSlot(sb, 'slot-P', '2x12');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.status).toBe(500);
    // The compensating delete targeted the created segment ids.
    const dels = calls.filter(c => c.table === 'schedule_slots' && c.method === 'delete');
    expect(dels.length).toBeGreaterThanOrEqual(2);
    const inDel = calls.find(c => c.table === 'schedule_slots' && c.method === 'in');
    expect(inDel?.args[1]).toEqual(['seg-0', 'seg-1']);
  });
});

// ── unsplit ─────────────────────────────────────────────────────────────────

const SEG_SLOT = (id: string, code: string, provider: string | null = null) => ({
  id, slot_date: '2026-02-07', site_id: 'site1',
  schedule_version_id: 'ver1', derived_day_type: 'saturday', locked: false,
  required_count: 1,
  shift_types: { id: `st-${code}`, code, category: 'call', parent_call_code: 'C1' },
  assignments: [{ id: `a-${id}`, provider_id: provider }],
});

function unsplitTables(over: Record<string, TableCfg> = {}): Record<string, TableCfg> {
  return {
    schedule_slots: (filters: Filter[]) => {
      if (has(filters, 'insert')) return { data: [{ id: 'new-parent' }], error: null };
      if (has(filters, 'delete')) return { data: null, error: null };
      if (has(filters, 'eq', 'id')) return { data: SEG_SLOT('seg-1', 'C1D12'), error: null };
      // sibling scan (version+date+site)
      return { data: [SEG_SLOT('seg-1', 'C1D12'), SEG_SLOT('seg-2', 'C1N12')], error: null };
    },
    schedule_versions: (filters: Filter[]) => {
      if (has(filters, 'eq', 'id')) return { data: { schedule_id: 'sched1', version_number: 3 }, error: null };
      return { data: [{ id: 'ver1', version_number: 3 }], error: null };
    },
    shift_types: { data: { id: 'st-C1', code: 'C1', category: 'call' }, error: null },
    assignments: { data: null, error: null },
    ...over,
  };
}

describe('unsplitCallSlot', () => {
  it('deletes ALL sibling segment slots and recreates the whole-call slot + open assignment', async () => {
    const { sb, calls } = makeFakeSupabase({ tables: unsplitTables() });
    const out = await unsplitCallSlot(sb, 'seg-1');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.createdSlotId).toBe('new-parent');
    expect(out.deletedSlotIds.sort()).toEqual(['seg-1', 'seg-2']);
    expect(out.parentCode).toBe('C1');

    const insert = calls.find(c => c.table === 'schedule_slots' && c.method === 'insert')!;
    const rows = insert.args[0] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      schedule_version_id: 'ver1', site_id: 'site1', slot_date: '2026-02-07',
      shift_type_id: 'st-C1', derived_day_type: 'saturday',
      required_count: 1, locked: false,
    });
    const aInsert = calls.find(c => c.table === 'assignments' && c.method === 'insert')!;
    expect(aInsert.args[0]).toEqual([
      { schedule_slot_id: 'new-parent', assignment_status: 'open', source_type: 'manual' },
    ]);
    // Both segment slots deleted via one in() delete.
    const inDel = calls.find(c => c.table === 'schedule_slots' && c.method === 'in');
    expect((inDel?.args[1] as string[]).sort()).toEqual(['seg-1', 'seg-2']);
  });

  it('409 when ANY sibling segment is still assigned — names the filled codes', async () => {
    const { sb, calls } = makeFakeSupabase({ tables: unsplitTables({
      schedule_slots: (filters: Filter[]) => {
        if (has(filters, 'eq', 'id')) return { data: SEG_SLOT('seg-1', 'C1D12'), error: null };
        return { data: [SEG_SLOT('seg-1', 'C1D12'), SEG_SLOT('seg-2', 'C1N12', 'p1')], error: null };
      },
    }) });
    const out = await unsplitCallSlot(sb, 'seg-1');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.status).toBe(409);
    expect(out.error).toContain('C1N12');
    expect(calls.some(c => c.method === 'insert' || c.method === 'delete')).toBe(false);
  });

  it('400 when the slot is not a segment', async () => {
    const { sb } = makeFakeSupabase({ tables: unsplitTables({
      schedule_slots: { data: PARENT_SLOT, error: null },
    }) });
    const out = await unsplitCallSlot(sb, 'slot-P');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.status).toBe(400);
    expect(out.error).toMatch(/segment/i);
  });

  it('409 when the segment version is not the schedule current version', async () => {
    const { sb } = makeFakeSupabase({ tables: unsplitTables({
      schedule_versions: (filters: Filter[]) => {
        if (has(filters, 'eq', 'id')) return { data: { schedule_id: 'sched1', version_number: 1 }, error: null };
        return { data: [{ id: 'ver9', version_number: 3 }], error: null };
      },
    }) });
    const out = await unsplitCallSlot(sb, 'seg-1');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.status).toBe(409);
  });
});
