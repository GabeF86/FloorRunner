// GET /api/scheduling/schedules/:id/grid — explicit column lists (no '*')
// plus server-side validation_summary per assignment (Task 12).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { makeFakeSupabase, callsFor } from '@/lib/rulesEngine/__fixtures__/fakeSupabase';
import { CLASSIC_PATTERN } from '@/lib/rulesEngine/callPattern';
import {
  GRID_SCHEDULE_COLUMNS,
  GRID_SLOT_COLUMNS,
  GRID_SLOT_COLUMNS_PRE35,
  GRID_SLOT_COLUMNS_PRE42,
  GRID_ASSIGNMENT_COLUMNS,
  GRID_ASSIGNMENT_COLUMNS_PRE42,
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
    // call_rank added 2026-07-27: the Call Counts Obligatory Weekends column
    // identifies the PRIMARY call code by rank 0, never by a code-name literal.
    expect(GRID_SLOT_COLUMNS).toContain('shift_types(id, code, name, color_hex, category, call_type, display_order, provider_group, requires_post_call_rule, call_rank, parent_call_code, call_burden_weight)');
    expect(GRID_SLOT_COLUMNS).toContain(`assignments(${GRID_ASSIGNMENT_COLUMNS})`);
  });

  // call_rank is a patch18 column, so it survives the patch35 narrow retry —
  // a pre-patch35 DB must still be able to tell first call from second.
  it('the pre-patch35 retry keeps call_rank (patch18) while dropping only the call-split columns', () => {
    expect(GRID_SLOT_COLUMNS_PRE35).toContain('call_rank');
    expect(GRID_SLOT_COLUMNS_PRE35).not.toContain('call_burden_weight');
    expect(GRID_SLOT_COLUMNS_PRE35).not.toContain('parent_call_code');
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

  // patch42 (2026-07-28): the scheduler's hand-set billing mark. It must reach
  // the grid, so it rides on the assignment select — and it must be droppable,
  // so a pre-patch42 DB has an exact narrow variant.
  it('assignment columns carry highlight_color, and the pre-patch42 retry drops exactly that column', () => {
    expect(GRID_ASSIGNMENT_COLUMNS).toContain('highlight_color');
    expect(GRID_ASSIGNMENT_COLUMNS_PRE42).not.toContain('highlight_color');
    expect(GRID_ASSIGNMENT_COLUMNS_PRE42).not.toContain('*');
    // Nothing else differs — removing highlight_color from the wide list must
    // reproduce the narrow list byte for byte.
    expect(GRID_ASSIGNMENT_COLUMNS.replace('highlight_color, ', '')).toBe(GRID_ASSIGNMENT_COLUMNS_PRE42);
  });

  it('the pre-patch42 slot retry keeps the patch35 call-split columns — it must not degrade two patches at once', () => {
    expect(GRID_SLOT_COLUMNS_PRE42).not.toContain('highlight_color');
    expect(GRID_SLOT_COLUMNS_PRE42).toContain('call_burden_weight');
    expect(GRID_SLOT_COLUMNS_PRE42).toContain('parent_call_code');
    expect(GRID_SLOT_COLUMNS_PRE42).toContain(`assignments(${GRID_ASSIGNMENT_COLUMNS_PRE42})`);
  });

  // A pre-patch35 DB is necessarily pre-patch42 under the documented patch
  // order, so the bottom rung drops both.
  it('the pre-patch35 retry also drops highlight_color', () => {
    expect(GRID_SLOT_COLUMNS_PRE35).not.toContain('highlight_color');
    expect(GRID_SLOT_COLUMNS_PRE35).toContain(`assignments(${GRID_ASSIGNMENT_COLUMNS_PRE42})`);
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

  // ── The narrow-retry ladder: GRID_SLOT_COLUMNS → PRE42 → PRE35 ─────────────
  // `missingColumns` names the columns the simulated DB does NOT have; any
  // select mentioning one fails the way PostgREST fails (42703).
  function setupLadder(missingColumns: string[]) {
    const { sb, calls } = makeFakeSupabase({
      tables: {
        schedules: { data: { id: 'sched-1', organization_id: 'org-1', site_id: 'site-1', sites: null }, error: null },
        schedule_versions: { data: { id: 'ver-1', version_number: 1, version_status: 'draft' }, error: null },
        schedule_slots: (filters) => {
          const sel = (filters.find(f => f.method === 'select')?.args[0] as string) ?? '';
          const missing = missingColumns.find(c => sel.includes(c));
          if (missing) {
            return { data: null, error: { message: `column ${missing} does not exist`, code: '42703' } };
          }
          return { data: [{ id: 'slot-1', assignments: [] }], error: null };
        },
        providers: { data: [], error: null },
        holiday_calendars: { data: [], error: null },
      },
    });
    holder.sb = sb;
    return { calls };
  }

  it('retries with the pre-patch35 slot columns when the call-split columns are missing (narrow-retry, no 500)', async () => {
    // A pre-patch35 DB is necessarily pre-patch42 under the documented order,
    // so the ladder walks all three rungs: full → PRE42 (still names
    // call_burden_weight) → PRE35.
    const { calls } = setupLadder(['call_burden_weight', 'highlight_color']);
    const { res, json } = await get();
    expect(res.status).toBe(200);
    expect(json.slots).toHaveLength(1);
    const selects = callsFor(calls, 'schedule_slots', 'select').map(c => c.args[0] as string);
    expect(selects).toHaveLength(3);
    expect(selects[2]).not.toContain('call_burden_weight');
    expect(selects[2]).not.toContain('highlight_color');
  });

  // patch42's read-side degradation: this is what keeps the grid rendering in
  // the window between deploying the highlight code and applying the patch.
  it('retries with the pre-patch42 slot columns when highlight_color is missing, keeping the patch35 split columns', async () => {
    const { calls } = setupLadder(['highlight_color']);
    const { res, json } = await get();
    expect(res.status).toBe(200);
    expect(json.slots).toHaveLength(1);
    const selects = callsFor(calls, 'schedule_slots', 'select').map(c => c.args[0] as string);
    // Exactly two rungs — it must NOT fall all the way through to PRE35 and
    // silently drop the call-split columns a patch35 DB does have.
    expect(selects).toHaveLength(2);
    expect(selects[0]).toContain('highlight_color');
    expect(selects[1]).not.toContain('highlight_color');
    expect(selects[1]).toContain('call_burden_weight');
    expect(selects[1]).toContain('parent_call_code');
  });

  it('a fully-patched DB takes the wide select only — no needless retry round-trips', async () => {
    const { calls } = setupLadder([]);
    const { res } = await get();
    expect(res.status).toBe(200);
    const selects = callsFor(calls, 'schedule_slots', 'select').map(c => c.args[0] as string);
    expect(selects).toEqual([GRID_SLOT_COLUMNS]);
  });

  // A genuine read failure must NOT be mistaken for a pre-patch DB and retried
  // into a 200 — it still has to reach the caller as a 500.
  it('a non-column read error is not retried and still 500s', async () => {
    const { sb, calls } = makeFakeSupabase({
      tables: {
        schedules: { data: { id: 'sched-1', organization_id: 'org-1', site_id: 'site-1', sites: null }, error: null },
        schedule_versions: { data: { id: 'ver-1', version_number: 1, version_status: 'draft' }, error: null },
        schedule_slots: { data: null, error: { message: 'connection reset', code: '08006' } },
        providers: { data: [], error: null },
        holiday_calendars: { data: [], error: null },
      },
    });
    holder.sb = sb;
    const { res, json } = await get();
    expect(res.status).toBe(500);
    expect(json.error).toBe('connection reset');
    expect(callsFor(calls, 'schedule_slots', 'select')).toHaveLength(1);
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

// ── Active call pattern (2026-07-27) ─────────────────────────────────────────
// The Call Counts modal's Obligatory Weekends column needs neuroWeekend.code
// to separate the neuro duty (per Sat+Sun pair) from the primary-call duty
// (per day). Parsed server-side so zod stays out of the client bundle, and
// degrading to null on EVERY failure path — a bad pattern must never break the
// modal, it only drops the neuro term.
describe('grid payload: site active call pattern', () => {
  function setupWithPattern(definition: unknown) {
    const { sb, calls } = makeFakeSupabase({
      tables: {
        schedules: {
          data: { id: 'sched-1', organization_id: 'org-1', site_id: 'site-1', sites: null },
          error: null,
        },
        schedule_versions: { data: { id: 'ver-1', version_number: 1, version_status: 'draft' }, error: null },
        schedule_slots: { data: [], error: null },
        providers: { data: [], error: null },
        holiday_calendars: { data: [], error: null },
        call_patterns: { data: { definition }, error: null },
      },
    });
    holder.sb = sb;
    return { calls };
  }

  const NEURO_PATTERN = {
    ...CLASSIC_PATTERN,
    neuroWeekend: { code: 'C3', requirementBands: [{ minFte: 0.75, units: 1 }, { minFte: 0, units: 0.5 }] },
  };

  it('ships the parsed pattern so the modal can read neuroWeekend.code', async () => {
    const { calls } = setupWithPattern(NEURO_PATTERN);
    const { res, json } = await get();
    expect(res.status).toBe(200);
    expect(json.callPattern.neuroWeekend.code).toBe('C3');
    // Scoped to the schedule's site and the ACTIVE row.
    const eqs = callsFor(calls, 'call_patterns', 'eq').map(c => c.args);
    expect(eqs).toContainEqual(['site_id', 'site-1']);
    expect(eqs).toContainEqual(['status', 'active']);
  });

  it('a definition that fails CallPatternDocSchema degrades to null — never a 500', async () => {
    setupWithPattern({ version: 2, blocks: 'nonsense' });
    const { res, json } = await get();
    expect(res.status).toBe(200);
    expect(json.callPattern).toBeNull();
  });

  it('no active pattern row → null (sites with no stated neuro weekend keep working)', async () => {
    setup(); // no call_patterns table configured on the fake
    const { res, json } = await get();
    expect(res.status).toBe(200);
    expect(json.callPattern).toBeNull();
  });
});
