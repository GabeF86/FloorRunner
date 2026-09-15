// GET /api/scheduling/rule-sets/[id]/activity — the numbers this panel prints
// are counted client-side from row arrays, so they are only as complete as the
// reads behind them. PostgREST caps an un-ranged select at 1000 rows and
// reports no error, and this route has TWO such reads (site slots, then
// assignments per slot batch). Before the fix both were capped and the capped
// lengths were served as `assignments_checked` / `total_violations`.
//
// The fake here is local rather than the shared rulesEngine fixture because
// that fixture's chain has no `.not()`, which this route uses to skip
// never-validated rows.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const holder = vi.hoisted(() => ({ sb: null as unknown }));
vi.mock('@/lib/supabaseScheduling', () => ({
  sbSchedulingServer: () => holder.sb,
}));

import { GET } from './route';

const CHAIN = ['select', 'eq', 'neq', 'in', 'is', 'not', 'or', 'order', 'limit', 'range'] as const;

interface Filter { method: string; args: unknown[] }
interface FlagRow { severity: string; rule_id: string | null; rule_name: string }
interface AssignmentRow {
  id: string;
  schedule_slot_id: string;
  validation_flags: FlagRow[] | null;
}

interface FakeOpts {
  slots: { id: string }[];
  assignments: AssignmentRow[];
  /** Force the slots read to fail outright. */
  slotError?: { message: string };
  /** Force the slots read to report a count higher than it returns (truncation). */
  slotCount?: number;
  /** Fail the Nth (0-based) assignments page. */
  assignmentFailPage?: number;
}

function makeSb(opts: FakeOpts) {
  let assignmentPage = 0;
  const pageRanges: Record<string, [number, number][]> = { schedule_slots: [], assignments: [] };

  function builder(table: string) {
    const filters: Filter[] = [];
    const rangeOf = (): [number, number] => {
      const f = filters.find(x => x.method === 'range');
      return f ? [f.args[0] as number, f.args[1] as number] : [0, 999];
    };
    const resolve = () => {
      if (table === 'rule_sets') {
        return { data: { id: 'rs-1', site_id: 'site-1' }, error: null, count: null };
      }
      const [from, to] = rangeOf();
      if (table === 'schedule_slots') {
        pageRanges.schedule_slots.push([from, to]);
        if (opts.slotError) return { data: null, error: opts.slotError, count: null };
        return {
          data: opts.slots.slice(from, to + 1),
          error: null,
          count: opts.slotCount ?? opts.slots.length,
        };
      }
      if (table === 'assignments') {
        pageRanges.assignments.push([from, to]);
        const page = assignmentPage++;
        if (opts.assignmentFailPage === page) {
          return { data: null, error: { message: 'boom' }, count: null };
        }
        const inFilter = filters.find(x => x.method === 'in');
        const ids = new Set((inFilter?.args[1] as string[]) ?? []);
        // Mirrors `.not('validation_flags', 'is', null)` — never-validated rows
        // are excluded server-side, so they must not reach the count either.
        const matching = opts.assignments.filter(
          a => ids.has(a.schedule_slot_id) && a.validation_flags !== null,
        );
        return { data: matching.slice(from, to + 1), error: null, count: matching.length };
      }
      return { data: [], error: null, count: 0 };
    };
    const b: Record<string, unknown> = {};
    for (const m of CHAIN) {
      b[m] = (...args: unknown[]) => { filters.push({ method: m, args }); return b; };
    }
    b.single = () => Promise.resolve(resolve());
    b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(resolve()).then(onF, onR);
    return b;
  }

  return { sb: { from: (t: string) => builder(t) }, pageRanges };
}

function slots(n: number) {
  // Zero-padded so the fake's slice order matches the route's `.order('id')`.
  return Array.from({ length: n }, (_, i) => ({ id: `slot-${String(i).padStart(5, '0')}` }));
}

const req = {} as NextRequest;
const params = { params: { id: 'rs-1' } };

beforeEach(() => { holder.sb = null; });

describe('GET rule-set activity', () => {
  it('pages past the 1000-row cap on both reads instead of reporting the cap', async () => {
    const s = slots(2500);
    // 1800 flagged assignments all hang off the FIRST slot batch, so a single
    // un-ranged assignments select would have returned exactly 1000 of them.
    const assignments: AssignmentRow[] = Array.from({ length: 1800 }, (_, i) => ({
      id: `a-${i}`,
      schedule_slot_id: s[i % 900].id,
      validation_flags: [{ severity: 'hard', rule_id: 'r-1', rule_name: 'Post-call' }],
    }));
    const { sb, pageRanges } = makeSb({ slots: s, assignments });
    holder.sb = sb;

    const res = await GET(req, params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.assignments_checked).toBe(1800);
    expect(body.assignments_with_violations).toBe(1800);
    expect(body.total_violations).toBe(1800);
    expect(body.hard_count).toBe(1800);
    expect(body.per_rule).toEqual([
      { rule_id: 'r-1', rule_name: 'Post-call', hard_count: 1800, soft_count: 0, warning_count: 0, total: 1800 },
    ]);
    // 2500 slots = 3 pages; the first slot batch alone needed 2 assignment pages.
    expect(pageRanges.schedule_slots.length).toBe(3);
    expect(pageRanges.assignments.length).toBeGreaterThan(3);
  });

  it('counts every flagged assignment across multiple slot batches', async () => {
    const s = slots(1500);
    const assignments: AssignmentRow[] = [
      { id: 'a-1', schedule_slot_id: s[0].id, validation_flags: [{ severity: 'hard', rule_id: 'r-1', rule_name: 'Post-call' }] },
      { id: 'a-2', schedule_slot_id: s[1200].id, validation_flags: [{ severity: 'soft', rule_id: 'r-2', rule_name: 'Spacing' }] },
      { id: 'a-3', schedule_slot_id: s[1400].id, validation_flags: [{ severity: 'warning', rule_id: null, rule_name: 'validation unavailable' }] },
      // Validated, clean: counted as checked, never as a violation.
      { id: 'a-4', schedule_slot_id: s[1499].id, validation_flags: [] },
      // Never validated: excluded by `.not(... is null)`, so not checked either.
      { id: 'a-5', schedule_slot_id: s[1499].id, validation_flags: null },
    ];
    holder.sb = makeSb({ slots: s, assignments }).sb;

    const body = await (await GET(req, params)).json();
    expect(body.assignments_checked).toBe(4);
    expect(body.assignments_with_violations).toBe(3);
    expect(body.hard_count).toBe(1);
    expect(body.soft_count).toBe(1);
    expect(body.warning_count).toBe(1);
    expect(body.total_violations).toBe(3);
  });

  it('500s rather than reporting zeros when the slot read fails', async () => {
    holder.sb = makeSb({ slots: slots(10), assignments: [], slotError: { message: 'db down' } }).sb;
    const res = await GET(req, params);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to load slots: db down' });
  });

  it('500s rather than under-reporting when the slot read comes back short', async () => {
    // Count says 2500, the source only ever yields 1200 — a stalled/short read.
    holder.sb = makeSb({ slots: slots(1200), assignments: [], slotCount: 2500 }).sb;
    const res = await GET(req, params);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/Failed to load slots/);
  });

  it('500s when an assignments page fails mid-walk instead of serving the partial tally', async () => {
    const s = slots(1500);
    const assignments: AssignmentRow[] = s.map((sl, i) => ({
      id: `a-${i}`,
      schedule_slot_id: sl.id,
      validation_flags: [{ severity: 'hard', rule_id: 'r-1', rule_name: 'Post-call' }],
    }));
    // Page 0 is the first slot batch; page 1 is the second — fail the second so
    // a partial (batch-1-only) tally would otherwise have been returned as 200.
    holder.sb = makeSb({ slots: s, assignments, assignmentFailPage: 1 }).sb;
    const res = await GET(req, params);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/Failed to load assignments/);
  });

  it('still reports genuine zeros for a site with no slots', async () => {
    holder.sb = makeSb({ slots: [], assignments: [] }).sb;
    const res = await GET(req, params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.assignments_checked).toBe(0);
    expect(body.per_rule).toEqual([]);
  });
});
