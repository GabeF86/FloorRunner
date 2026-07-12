// Dashboard query/aggregation tests — pure functions over canned rows plus
// loadDashboardData against the shared fake supabase client (no DB, no
// network). Flag semantics come from the grid route helpers
// (validationSummaryFor): null flags = never validated (NOT clean), and
// 'warning' severity never counts as a hard violation.
//
// Transport-truncation coverage: PostgREST caps un-ranged selects at 1000
// rows WITHOUT an error, so the attention rollup must paginate to the exact
// count and every count-style panel must come from { count: 'exact' } —
// a partial aggregate must surface a panel error, never render as fact.

import { describe, it, expect } from 'vitest';
import { makeFakeSupabase, fromCount, callsFor } from '@/lib/rulesEngine/__fixtures__/fakeSupabase';
import {
  summarizeSchedules,
  todaysCall,
  attentionFor,
  loadDashboardData,
  type TodaysCallSlotRow,
  type AttentionSlotRow,
} from './queries';

// ── Row builders ─────────────────────────────────────────────────────────────

function callSlot(over: Partial<TodaysCallSlotRow> & Record<string, unknown> = {}): TodaysCallSlotRow {
  return {
    id: 'slot-1',
    slot_date: '2026-07-10',
    sites: { name: 'Mercy General', short_name: 'MG' },
    shift_types: { code: 'C1', name: 'First call', category: 'call', display_order: 1 },
    assignments: [
      {
        provider_id: 'p1',
        assignment_status: 'assigned',
        providers: { last_name: 'Smith', short_display_name: 'J.Smith', initials: 'JS' },
      },
    ],
    schedule_versions: {
      schedule_id: 'sch-1',
      version_number: 1,
      version_status: 'published',
      schedules: { status: 'published' },
    },
    ...over,
  } as TodaysCallSlotRow;
}

function attnSlot(over: Partial<AttentionSlotRow> & Record<string, unknown> = {}): AttentionSlotRow {
  return {
    id: 'slot-1',
    assignments: [
      { provider_id: 'p1', assignment_status: 'assigned', validation_flags: [] },
    ],
    schedule_versions: { schedule_id: 'sch-1', version_number: 1 },
    ...over,
  } as AttentionSlotRow;
}

// ── summarizeSchedules ───────────────────────────────────────────────────────

describe('summarizeSchedules', () => {
  it('counts schedules by status', () => {
    const rows = [
      { status: 'draft' },
      { status: 'draft' },
      { status: 'published' },
      { status: 'review' },
    ];
    expect(summarizeSchedules(rows)).toEqual({ draft: 2, published: 1, review: 1 });
  });

  it('returns an empty record for no schedules', () => {
    expect(summarizeSchedules([])).toEqual({});
  });
});

// ── todaysCall ───────────────────────────────────────────────────────────────

describe('todaysCall', () => {
  it('maps published-version call slots to {provider_name, site_name, code}', () => {
    const out = todaysCall([callSlot()]);
    expect(out).toEqual([{ provider_name: 'J.Smith', site_name: 'MG', code: 'C1' }]);
  });

  it('sorts by code (numeric-aware), then site name', () => {
    const rows = [
      callSlot({ id: 's-a', shift_types: { code: 'C10', name: null, category: 'call', display_order: 3 } }),
      callSlot({ id: 's-b', shift_types: { code: 'C2', name: null, category: 'call', display_order: 2 } }),
      callSlot({
        id: 's-c',
        shift_types: { code: 'C2', name: null, category: 'call', display_order: 2 },
        sites: { name: 'Alpha Hospital', short_name: 'AH' },
      }),
      callSlot({ id: 's-d', shift_types: { code: 'C1', name: null, category: 'call', display_order: 1 } }),
    ];
    expect(todaysCall(rows).map(e => `${e.code}@${e.site_name}`)).toEqual([
      'C1@MG', 'C2@AH', 'C2@MG', 'C10@MG',
    ]);
  });

  it('excludes non-call shift categories', () => {
    const rows = [
      callSlot({ shift_types: { code: 'OR1', name: null, category: 'regular', display_order: 1 } }),
    ];
    expect(todaysCall(rows)).toEqual([]);
  });

  it('excludes non-published versions and archived schedules', () => {
    const rows = [
      callSlot({
        schedule_versions: { schedule_id: 'sch-1', version_number: 2, version_status: 'draft', schedules: { status: 'draft' } },
      }),
      callSlot({
        schedule_versions: { schedule_id: 'sch-2', version_number: 1, version_status: 'published', schedules: { status: 'archived' } },
      }),
    ];
    expect(todaysCall(rows)).toEqual([]);
  });

  it('uses only the latest published version per schedule', () => {
    const rows = [
      callSlot({
        id: 's-old',
        assignments: [{ provider_id: 'p-old', assignment_status: 'assigned', providers: { last_name: 'Old', short_display_name: 'Dr.Old', initials: 'DO' } }],
        schedule_versions: { schedule_id: 'sch-1', version_number: 1, version_status: 'published', schedules: { status: 'published' } },
      }),
      callSlot({
        id: 's-new',
        assignments: [{ provider_id: 'p-new', assignment_status: 'assigned', providers: { last_name: 'New', short_display_name: 'Dr.New', initials: 'DN' } }],
        schedule_versions: { schedule_id: 'sch-1', version_number: 3, version_status: 'published', schedules: { status: 'published' } },
      }),
    ];
    expect(todaysCall(rows).map(e => e.provider_name)).toEqual(['Dr.New']);
  });

  it('skips unassigned, canceled, and declined assignments', () => {
    const rows = [
      callSlot({ assignments: [] }),
      callSlot({ id: 's-2', assignments: [{ provider_id: null, assignment_status: 'open', providers: null }] }),
      callSlot({
        id: 's-3',
        assignments: [{ provider_id: 'p9', assignment_status: 'canceled', providers: { last_name: 'Gone', short_display_name: null, initials: null } }],
      }),
      callSlot({
        id: 's-4',
        assignments: [{ provider_id: 'p8', assignment_status: 'declined', providers: { last_name: 'No', short_display_name: null, initials: null } }],
      }),
    ];
    expect(todaysCall(rows)).toEqual([]);
  });

  it('accepts a single-object assignments embed (UNIQUE(schedule_slot_id) makes PostgREST return to-one)', () => {
    const rows = [
      callSlot({
        assignments: {
          provider_id: 'p1',
          assignment_status: 'assigned',
          providers: { last_name: 'Smith', short_display_name: 'J.Smith', initials: 'JS' },
        },
      }),
    ];
    expect(todaysCall(rows)).toEqual([{ provider_name: 'J.Smith', site_name: 'MG', code: 'C1' }]);
  });

  it('falls back through short_display_name → last_name → initials for the provider name', () => {
    const rows = [
      callSlot({
        assignments: [{ provider_id: 'p1', assignment_status: 'assigned', providers: { last_name: 'Smith', short_display_name: null, initials: 'JS' } }],
      }),
      callSlot({
        id: 's-2',
        shift_types: { code: 'C2', name: null, category: 'call', display_order: 2 },
        assignments: [{ provider_id: 'p2', assignment_status: 'assigned', providers: { last_name: null, short_display_name: null, initials: 'QQ' } }],
      }),
    ];
    expect(todaysCall(rows).map(e => e.provider_name)).toEqual(['Smith', 'QQ']);
  });
});

// ── attentionFor ─────────────────────────────────────────────────────────────

describe('attentionFor', () => {
  it('counts unfilled slots and hard violations per schedule', () => {
    const rows = [
      attnSlot({ id: 's-1', assignments: [] }), // unfilled: no assignment rows
      attnSlot({ id: 's-2', assignments: [{ provider_id: null, assignment_status: 'open', validation_flags: null }] }), // unfilled: open
      attnSlot({
        id: 's-3',
        assignments: [{ provider_id: 'p1', assignment_status: 'assigned', validation_flags: [{ severity: 'hard' }, { severity: 'soft' }] }],
      }),
      attnSlot({
        id: 's-4',
        assignments: [{ provider_id: 'p2', assignment_status: 'assigned', validation_flags: [{ severity: 'hard' }] }],
      }),
    ];
    expect(attentionFor(rows)).toEqual([
      { schedule_id: 'sch-1', unfilled: 2, hard: 2, assigned: 2, checked: 2 },
    ]);
  });

  it('treats null validation_flags as never-validated, not clean (checked stays 0)', () => {
    const rows = [
      attnSlot({ assignments: [{ provider_id: 'p1', assignment_status: 'assigned', validation_flags: null }] }),
    ];
    expect(attentionFor(rows)).toEqual([
      { schedule_id: 'sch-1', unfilled: 0, hard: 0, assigned: 1, checked: 0 },
    ]);
  });

  it('never counts warning-severity or unknown-severity flags as hard', () => {
    const rows = [
      attnSlot({
        assignments: [{
          provider_id: 'p1',
          assignment_status: 'assigned',
          validation_flags: [{ severity: 'warning' }, { severity: 'soft' }, {}],
        }],
      }),
    ];
    expect(attentionFor(rows)).toEqual([
      { schedule_id: 'sch-1', unfilled: 0, hard: 0, assigned: 1, checked: 1 },
    ]);
  });

  it('counts a slot as filled when any assignment carries a provider', () => {
    const rows = [
      attnSlot({
        assignments: [
          { provider_id: null, assignment_status: 'open', validation_flags: null },
          { provider_id: 'p1', assignment_status: 'assigned', validation_flags: [] },
        ],
      }),
    ];
    expect(attentionFor(rows)[0].unfilled).toBe(0);
  });

  it('counts a canceled provider-bearing assignment as unfilled', () => {
    const rows = [
      attnSlot({ assignments: [{ provider_id: 'p1', assignment_status: 'canceled', validation_flags: [] }] }),
    ];
    expect(attentionFor(rows)[0].unfilled).toBe(1);
  });

  it('accepts a single-object assignments embed (to-one shape from the live unique constraint)', () => {
    const rows = [
      attnSlot({
        id: 's-1',
        assignments: { provider_id: 'p1', assignment_status: 'assigned', validation_flags: [{ severity: 'hard' }] },
      }),
      attnSlot({
        id: 's-2',
        assignments: { provider_id: null, assignment_status: 'open', validation_flags: null },
      }),
    ];
    expect(attentionFor(rows)).toEqual([
      { schedule_id: 'sch-1', unfilled: 1, hard: 1, assigned: 1, checked: 1 },
    ]);
  });

  it('only counts the latest version of each schedule', () => {
    const rows = [
      attnSlot({ id: 's-1', assignments: [], schedule_versions: { schedule_id: 'sch-1', version_number: 1 } }),
      attnSlot({
        id: 's-2',
        assignments: [{ provider_id: 'p1', assignment_status: 'assigned', validation_flags: [] }],
        schedule_versions: { schedule_id: 'sch-1', version_number: 2 },
      }),
      attnSlot({ id: 's-3', assignments: [], schedule_versions: { schedule_id: 'sch-2', version_number: 1 } }),
    ];
    expect(attentionFor(rows)).toEqual([
      { schedule_id: 'sch-1', unfilled: 0, hard: 0, assigned: 1, checked: 1 },
      { schedule_id: 'sch-2', unfilled: 1, hard: 0, assigned: 0, checked: 0 },
    ]);
  });
});

// ── loadDashboardData ────────────────────────────────────────────────────────

const TODAY = '2026-07-10';

// Reads the recorded 'range' filter of the current builder to serve the right
// page — the idiom paginated consumers use against the fake.
function pageOf<T>(all: T[], filters: Array<{ method: string; args: unknown[] }>): { data: T[]; count: number } {
  const range = filters.find(f => f.method === 'range');
  const [from, to] = (range?.args ?? [0, all.length - 1]) as [number, number];
  return { data: all.slice(from, to + 1), count: all.length };
}

function fullFake() {
  return makeFakeSupabase({
    tables: {
      // Stat panels are head-only exact counts — no rows come back.
      providers: { data: null, count: 3 },
      sites: { data: null, count: 2 },
      provider_availability: { data: null, count: 1 },
      schedules: {
        data: [
          { id: 'sch-1', schedule_name: 'July Call', status: 'published', date_start: '2026-07-01', date_end: '2026-07-31', current_version_number: 1 },
          { id: 'sch-2', schedule_name: 'August Call', status: 'draft', date_start: '2026-08-01', date_end: '2026-08-31', current_version_number: 2 },
        ],
        count: 2,
      },
      // schedule_slots serves both query shapes: today's call (eq slot_date)
      // vs the attention rollup (or-scoped to latest versions, ranged).
      schedule_slots: (filters) => {
        const isToday = filters.some(f => f.method === 'eq' && f.args[0] === 'slot_date');
        if (isToday) return { data: [callSlot()], count: 1 };
        return pageOf(
          [
            attnSlot({ id: 's-open', assignments: [] }),
            attnSlot({
              id: 's-hard',
              assignments: [{ provider_id: 'p1', assignment_status: 'assigned', validation_flags: [{ severity: 'hard' }] }],
            }),
          ],
          filters,
        );
      },
    },
  });
}

describe('loadDashboardData', () => {
  it('loads every panel in ≤6 logical selects and shapes the results', async () => {
    const { sb, calls } = fullFake();
    const data = await loadDashboardData(sb, TODAY);

    expect(fromCount(calls)).toBeLessThanOrEqual(6);
    expect(data.today).toBe(TODAY);
    expect(data.providers).toEqual({ data: 3, error: null });
    expect(data.sites).toEqual({ data: 2, error: null });
    expect(data.schedules.error).toBeNull();
    expect(data.schedules.data?.byStatus).toEqual({ published: 1, draft: 1 });
    expect(data.todaysCall).toEqual({
      data: [{ provider_name: 'J.Smith', site_name: 'MG', code: 'C1' }],
      error: null,
    });
    expect(data.pendingRequests).toEqual({ data: 1, error: null });
    expect(data.attention.error).toBeNull();
    // Every active schedule gets an entry — sch-2 has no slot rows yet and
    // shows genuine zeros (assigned 0 = "no slots yet", never validated-clean).
    expect(data.attention.data).toEqual([
      { schedule_id: 'sch-1', schedule_name: 'July Call', status: 'published', unfilled: 1, hard: 1, assigned: 1, checked: 1 },
      { schedule_id: 'sch-2', schedule_name: 'August Call', status: 'draft', unfilled: 0, hard: 0, assigned: 0, checked: 0 },
    ]);
  });

  it('uses head-only exact counts for the providers/sites/pending stat panels', async () => {
    const { sb, calls } = fullFake();
    await loadDashboardData(sb, TODAY);
    for (const table of ['providers', 'sites', 'provider_availability']) {
      const select = callsFor(calls, table, 'select')[0];
      expect(select.args[1]).toEqual({ count: 'exact', head: true });
    }
  });

  it('errors a stat panel when the count comes back null (no zeros-as-fact)', async () => {
    const { sb } = makeFakeSupabase({
      tables: {
        providers: { data: null, count: null }, // transport anomaly: no error, no count
        sites: { data: null, count: 0 },
        schedules: { data: [], count: 0 },
        provider_availability: { data: null, count: 0 },
        schedule_slots: { data: [], count: 0 },
      },
    });
    const data = await loadDashboardData(sb, TODAY);
    expect(data.providers.data).toBeNull();
    expect(data.providers.error).toContain('count unavailable');
    expect(data.sites).toEqual({ data: 0, error: null });
  });

  it("filters today's call slots on the provided date", async () => {
    const { sb, calls } = fullFake();
    await loadDashboardData(sb, TODAY);
    const eqs = callsFor(calls, 'schedule_slots', 'eq');
    expect(eqs.some(c => c.args[0] === 'slot_date' && c.args[1] === TODAY)).toBe(true);
  });

  it("errors the today's-call panel when the row count says the page was truncated", async () => {
    const { sb } = makeFakeSupabase({
      tables: {
        providers: { data: null, count: 0 },
        sites: { data: null, count: 0 },
        schedules: { data: [], count: 0 },
        provider_availability: { data: null, count: 0 },
        // 1 row returned but 5 matched — must NOT render a partial panel.
        schedule_slots: { data: [callSlot()], count: 5 },
      },
    });
    const data = await loadDashboardData(sb, TODAY);
    expect(data.todaysCall.data).toBeNull();
    expect(data.todaysCall.error).toContain('truncated');
  });

  it('scopes the attention rollup to each schedule\'s current version via an embedded or-filter', async () => {
    const { sb, calls } = fullFake();
    await loadDashboardData(sb, TODAY);
    const ors = callsFor(calls, 'schedule_slots', 'or');
    expect(ors.length).toBeGreaterThan(0);
    expect(ors[0].args[0]).toBe(
      'and(schedule_id.eq.sch-1,version_number.eq.1),and(schedule_id.eq.sch-2,version_number.eq.2)',
    );
    expect(ors[0].args[1]).toEqual({ referencedTable: 'schedule_versions' });
  });

  it('paginates the attention rollup past the 1000-row page cap and aggregates every page', async () => {
    // 1500 matching slots: 1499 unfilled + one hard-flagged assignment that
    // only exists on page 2 — proving continuation rows reach the aggregate.
    const bigRollup: AttentionSlotRow[] = [];
    for (let i = 0; i < 1499; i++) bigRollup.push(attnSlot({ id: `s-${i}`, assignments: [] }));
    bigRollup.push(attnSlot({
      id: 's-1499',
      assignments: [{ provider_id: 'p1', assignment_status: 'assigned', validation_flags: [{ severity: 'hard' }] }],
    }));

    const { sb, calls } = makeFakeSupabase({
      tables: {
        providers: { data: null, count: 0 },
        sites: { data: null, count: 0 },
        provider_availability: { data: null, count: 0 },
        schedules: {
          data: [{ id: 'sch-1', schedule_name: 'July Call', status: 'draft', date_start: '2026-07-01', date_end: '2026-07-31', current_version_number: 1 }],
          count: 1,
        },
        schedule_slots: (filters) => {
          const isToday = filters.some(f => f.method === 'eq' && f.args[0] === 'slot_date');
          if (isToday) return { data: [], count: 0 };
          return pageOf(bigRollup, filters);
        },
      },
    });
    const data = await loadDashboardData(sb, TODAY);
    expect(data.attention.error).toBeNull();
    expect(data.attention.data).toEqual([
      { schedule_id: 'sch-1', schedule_name: 'July Call', status: 'draft', unfilled: 1499, hard: 1, assigned: 1, checked: 1 },
    ]);
    // 1 today's-call select + 2 rollup pages.
    expect(fromCount(calls, 'schedule_slots')).toBe(3);
  });

  it('surfaces a panel error on a mid-pagination failure — never a partial aggregate', async () => {
    const bigRollup: AttentionSlotRow[] = [];
    for (let i = 0; i < 1500; i++) bigRollup.push(attnSlot({ id: `s-${i}`, assignments: [] }));

    const { sb } = makeFakeSupabase({
      tables: {
        providers: { data: null, count: 0 },
        sites: { data: null, count: 0 },
        provider_availability: { data: null, count: 0 },
        schedules: {
          data: [{ id: 'sch-1', schedule_name: 'July Call', status: 'draft', date_start: '2026-07-01', date_end: '2026-07-31', current_version_number: 1 }],
          count: 1,
        },
        schedule_slots: (filters) => {
          const isToday = filters.some(f => f.method === 'eq' && f.args[0] === 'slot_date');
          if (isToday) return { data: [], count: 0 };
          const range = filters.find(f => f.method === 'range');
          const from = (range?.args?.[0] as number) ?? 0;
          if (from >= 1000) return { data: null, error: { message: 'page 2 exploded' } };
          return pageOf(bigRollup, filters);
        },
      },
    });
    const data = await loadDashboardData(sb, TODAY);
    expect(data.attention.data).toBeNull();
    expect(data.attention.error).toContain('page 2 exploded');
  });

  it('surfaces a panel error when pagination stalls short of the reported count', async () => {
    const { sb } = makeFakeSupabase({
      tables: {
        providers: { data: null, count: 0 },
        sites: { data: null, count: 0 },
        provider_availability: { data: null, count: 0 },
        schedules: {
          data: [{ id: 'sch-1', schedule_name: 'July Call', status: 'draft', date_start: '2026-07-01', date_end: '2026-07-31', current_version_number: 1 }],
          count: 1,
        },
        schedule_slots: (filters) => {
          const isToday = filters.some(f => f.method === 'eq' && f.args[0] === 'slot_date');
          if (isToday) return { data: [], count: 0 };
          const range = filters.find(f => f.method === 'range');
          const from = (range?.args?.[0] as number) ?? 0;
          // count promises 1500 but page 2 comes back empty.
          if (from >= 1000) return { data: [], count: 1500 };
          return { data: Array.from({ length: 1000 }, (_, i) => attnSlot({ id: `s-${i}`, assignments: [] })), count: 1500 };
        },
      },
    });
    const data = await loadDashboardData(sb, TODAY);
    expect(data.attention.data).toBeNull();
    expect(data.attention.error).toBeTruthy();
  });

  it('errors the attention panel when the rollup count is unavailable (possible truncation)', async () => {
    const { sb } = makeFakeSupabase({
      tables: {
        providers: { data: null, count: 0 },
        sites: { data: null, count: 0 },
        provider_availability: { data: null, count: 0 },
        schedules: {
          data: [{ id: 'sch-1', schedule_name: 'July Call', status: 'draft', date_start: '2026-07-01', date_end: '2026-07-31', current_version_number: 1 }],
          count: 1,
        },
        schedule_slots: (filters) => {
          const isToday = filters.some(f => f.method === 'eq' && f.args[0] === 'slot_date');
          if (isToday) return { data: [], count: 0 };
          return { data: [attnSlot()], count: null };
        },
      },
    });
    const data = await loadDashboardData(sb, TODAY);
    expect(data.attention.data).toBeNull();
    expect(data.attention.error).toContain('count unavailable');
  });

  it('fails soft per panel: a providers error leaves other panels intact', async () => {
    const { sb } = makeFakeSupabase({
      tables: {
        providers: { data: null, error: { message: 'boom' } },
        sites: { data: null, count: 1 },
        schedules: { data: [], count: 0 },
        provider_availability: { data: null, count: 0 },
        schedule_slots: { data: [], count: 0 },
      },
    });
    const data = await loadDashboardData(sb, TODAY);
    expect(data.providers.data).toBeNull();
    expect(data.providers.error).toContain('boom');
    expect(data.sites).toEqual({ data: 1, error: null });
    expect(data.pendingRequests).toEqual({ data: 0, error: null });
  });

  it('propagates a schedules error to the attention panel and skips the rollup query', async () => {
    const { sb, calls } = makeFakeSupabase({
      tables: {
        providers: { data: null, count: 0 },
        sites: { data: null, count: 0 },
        schedules: { data: null, error: { message: 'schedules unavailable' } },
        provider_availability: { data: null, count: 0 },
        schedule_slots: { data: [], count: 0 },
      },
    });
    const data = await loadDashboardData(sb, TODAY);
    expect(data.schedules.data).toBeNull();
    expect(data.schedules.error).toContain('schedules unavailable');
    expect(data.attention.data).toBeNull();
    expect(data.attention.error).toBeTruthy();
    // Only the today's-call query hit schedule_slots — no rollup without schedules.
    expect(fromCount(calls, 'schedule_slots')).toBe(1);
  });

  it('skips the rollup query when there are no active schedules', async () => {
    const { sb, calls } = makeFakeSupabase({
      tables: {
        providers: { data: null, count: 0 },
        sites: { data: null, count: 0 },
        schedules: { data: [], count: 0 },
        provider_availability: { data: null, count: 0 },
        schedule_slots: { data: [], count: 0 },
      },
    });
    const data = await loadDashboardData(sb, TODAY);
    expect(data.attention).toEqual({ data: [], error: null });
    expect(fromCount(calls, 'schedule_slots')).toBe(1);
    expect(fromCount(calls)).toBeLessThanOrEqual(6);
  });

  it("reports a today's-call query error without faking an empty panel", async () => {
    const { sb } = makeFakeSupabase({
      tables: {
        providers: { data: null, count: 0 },
        sites: { data: null, count: 0 },
        schedules: { data: [], count: 0 },
        provider_availability: { data: null, count: 0 },
        schedule_slots: { data: null, error: { message: 'slots query failed' } },
      },
    });
    const data = await loadDashboardData(sb, TODAY);
    expect(data.todaysCall.data).toBeNull();
    expect(data.todaysCall.error).toContain('slots query failed');
  });
});
