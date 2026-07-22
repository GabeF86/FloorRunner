// GET /api/scheduling/schedules/:id/grid — explicit column lists (no '*')
// plus server-side validation_summary per assignment (Task 12).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { makeFakeSupabase, callsFor } from '@/lib/rulesEngine/__fixtures__/fakeSupabase';
import {
  GRID_SCHEDULE_COLUMNS,
  GRID_SLOT_COLUMNS,
  GRID_ASSIGNMENT_COLUMNS,
  validationSummaryFor,
} from './route.helpers';

const holder = vi.hoisted(() => ({ sb: null as unknown }));
vi.mock('@/lib/supabaseScheduling', () => ({
  sbSchedulingServer: () => holder.sb,
}));

import { GET } from './route';

// ── Column list constants ────────────────────────────────────────────────────

describe('grid column lists', () => {
  it('never select *', () => {
    expect(GRID_SCHEDULE_COLUMNS).not.toContain('*');
    expect(GRID_SLOT_COLUMNS).not.toContain('*');
    expect(GRID_ASSIGNMENT_COLUMNS).not.toContain('*');
  });

  it('schedule columns cover exactly what the page reads', () => {
    for (const col of [
      'id', 'organization_id', 'site_id', 'schedule_name', 'schedule_type',
      'provider_group', 'date_start', 'date_end', 'status', 'included_provider_ids',
      'provider_limits',
    ]) {
      expect(GRID_SCHEDULE_COLUMNS).toContain(col);
    }
    expect(GRID_SCHEDULE_COLUMNS).toContain('sites(name, short_name, timezone, call_par_level)');
  });

  it('slot columns cover the page Slot interface plus the shift_types and assignments joins', () => {
    for (const col of ['id', 'slot_date', 'shift_type_id', 'slot_index', 'locked', 'derived_day_type']) {
      expect(GRID_SLOT_COLUMNS).toContain(col);
    }
    expect(GRID_SLOT_COLUMNS).toContain('shift_types(id, code, name, color_hex, category, call_type, display_order, provider_group, requires_post_call_rule, parent_call_code, call_burden_weight)');
    expect(GRID_SLOT_COLUMNS).toContain(`assignments(${GRID_ASSIGNMENT_COLUMNS})`);
  });

  it('assignment columns keep validation_flags (tooltips) and the providers join, and carry schedule_slot_id for client-side patching', () => {
    for (const col of [
      'id', 'schedule_slot_id', 'provider_id', 'assignment_status',
      'is_open_call', 'manually_overridden', 'validation_flags',
    ]) {
      expect(GRID_ASSIGNMENT_COLUMNS).toContain(col);
    }
    expect(GRID_ASSIGNMENT_COLUMNS).toContain('providers(id, last_name, short_display_name, initials, provider_type)');
  });
});

// ── validationSummaryFor ─────────────────────────────────────────────────────

describe('validationSummaryFor', () => {
  it('returns null for a never-validated assignment (flags column null/undefined)', () => {
    expect(validationSummaryFor(null)).toBeNull();
    expect(validationSummaryFor(undefined)).toBeNull();
  });

  it('returns all-zero for a checked-and-clean assignment', () => {
    expect(validationSummaryFor([])).toEqual({ hard: 0, soft: 0, warning: 0 });
  });

  it('counts warnings separately — sentinel/unknown severities never inflate soft', () => {
    expect(validationSummaryFor([
      { severity: 'hard' },
      { severity: 'soft' },
      { severity: 'soft' },
      { severity: 'warning' },   // sentinel 'needs re-validation'
      { severity: 'bogus' },     // unknown → warning bucket, never soft
    ])).toEqual({ hard: 1, soft: 2, warning: 2 });
  });
});

// ── Route-level ──────────────────────────────────────────────────────────────

const ASSIGNMENT_ROW = {
  id: 'a-1', schedule_slot_id: 'slot-1', provider_id: 'p1',
  assignment_status: 'assigned', is_open_call: false, manually_overridden: false,
  validation_flags: [{ severity: 'hard' }, { severity: 'warning' }],
  providers: { id: 'p1', last_name: 'Smith', short_display_name: 'S. Smith', initials: 'SS', provider_type: 'physician' },
};

// `assignmentsEmbed` defaults to the array shape (dev fakes / pre-constraint
// DBs); the live DB's UNIQUE(schedule_slot_id) makes PostgREST return the
// embed as a SINGLE OBJECT — tests cover both.
function setup(assignmentsEmbed: unknown = [ASSIGNMENT_ROW]) {
  const { sb, calls } = makeFakeSupabase({
    tables: {
      schedules: {
        data: {
          id: 'sched-1', organization_id: 'org-1', site_id: 'site-1',
          schedule_name: 'S', schedule_type: 'call', provider_group: 'physician',
          date_start: '2026-01-01', date_end: '2026-01-31', status: 'draft',
          included_provider_ids: null,
          sites: { name: 'Mercy', short_name: 'MG', timezone: null, call_par_level: 12 },
        },
        error: null,
      },
      schedule_versions: { data: { id: 'ver-1', version_number: 1, version_status: 'draft' }, error: null },
      schedule_slots: {
        data: [{
          id: 'slot-1', slot_date: '2026-01-05', shift_type_id: 'st-C1', slot_index: 0,
          locked: false, derived_day_type: 'weekday',
          shift_types: { id: 'st-C1', code: 'C1' },
          assignments: assignmentsEmbed,
        }],
        error: null,
      },
      providers: { data: [], error: null },
      holiday_calendars: { data: [], error: null },
    },
  });
  holder.sb = sb;
  return { calls };
}

async function get() {
  const res = await GET({} as NextRequest, { params: Promise.resolve({ id: 'sched-1' }) });
  return { res, json: await res.json() };
}

beforeEach(() => { holder.sb = null; });

describe('GET /api/scheduling/schedules/:id/grid', () => {
  it('queries with the exported explicit column lists (no select *)', async () => {
    const { calls } = setup();
    const { res } = await get();
    expect(res.status).toBe(200);
    expect(callsFor(calls, 'schedules', 'select')[0].args[0]).toBe(GRID_SCHEDULE_COLUMNS);
    expect(callsFor(calls, 'schedule_slots', 'select')[0].args[0]).toBe(GRID_SLOT_COLUMNS);
  });

  it('attaches a server-computed validation_summary to each assignment while keeping full validation_flags', async () => {
    setup();
    const { json } = await get();
    const a = json.slots[0].assignments[0];
    expect(a.validation_summary).toEqual({ hard: 1, soft: 0, warning: 1 });
    expect(a.validation_flags).toEqual([{ severity: 'hard' }, { severity: 'warning' }]);
  });

  it('retries with the pre-patch35 slot columns when the call-split columns are missing (narrow-retry, no 500)', async () => {
    const { sb, calls } = makeFakeSupabase({
      tables: {
        schedules: { data: { id: 'sched-1', organization_id: 'org-1', site_id: 'site-1', sites: null }, error: null },
        schedule_versions: { data: { id: 'ver-1', version_number: 1, version_status: 'draft' }, error: null },
        schedule_slots: (filters) => {
          const sel = (filters.find(f => f.method === 'select')?.args[0] as string) ?? '';
          if (sel.includes('call_burden_weight')) {
            return { data: null, error: { message: 'column shift_types.call_burden_weight does not exist', code: '42703' } };
          }
          return { data: [{ id: 'slot-1', assignments: [] }], error: null };
        },
        providers: { data: [], error: null },
        holiday_calendars: { data: [], error: null },
      },
    });
    holder.sb = sb;
    const { res, json } = await get();
    expect(res.status).toBe(200);
    expect(json.slots).toHaveLength(1);
    const selects = callsFor(calls, 'schedule_slots', 'select').map(c => c.args[0]);
    expect(selects).toHaveLength(2);
    expect(selects[1]).not.toContain('call_burden_weight');
  });

  // Live DB: UNIQUE(schedule_slot_id) → PostgREST returns the embed as ONE
  // OBJECT, not an array. The route must normalize instead of 500ing.
  it('normalizes a single-OBJECT assignments embed (one-to-one live shape) into an array', async () => {
    setup(ASSIGNMENT_ROW); // object, not [object]
    const { res, json } = await get();
    expect(res.status).toBe(200);
    expect(Array.isArray(json.slots[0].assignments)).toBe(true);
    const a = json.slots[0].assignments[0];
    expect(a.id).toBe('a-1');
    expect(a.validation_summary).toEqual({ hard: 1, soft: 0, warning: 1 });
  });

  it('normalizes a null assignments embed (one-to-one, no row) into an empty array', async () => {
    setup(null);
    const { res, json } = await get();
    expect(res.status).toBe(200);
    expect(json.slots[0].assignments).toEqual([]);
  });
});
