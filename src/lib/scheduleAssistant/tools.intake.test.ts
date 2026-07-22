// Executor tests for the five intake tools (assistant-intake):
// list_availability (read) + record_availability / cancel_availability /
// update_provider_profile / update_site_credentials (writers). Canned rows via
// the shared call-recording fake supabase client. These pin: input validation
// (bad type, bad dates, empty patch, missing rows), the org guards, the
// undo-window overlap guards (a write outside the snapshot's availability
// window would be un-undoable), the honest ToolInputError copy the loop
// surfaces verbatim, and the write payloads (approved default,
// source='assistant', patch scoping). Snapshot/undo of these same writes is a
// separate round-trip in snapshot.intake.test.ts.
import { describe, it, expect } from 'vitest';
import {
  createToolExecutors,
  MUTATING_TOOLS,
  ToolInputError,
  assistantTools,
  type ScheduleCtx,
} from './tools';
import { AVAILABILITY_TYPES } from '@/lib/validation/providers';
import { BLOCKING_AVAIL } from '@/lib/rulesEngine/shared';
import {
  makeFakeSupabase,
  callsFor,
  type TableCfg,
} from '@/lib/rulesEngine/__fixtures__/fakeSupabase';

const ctx: ScheduleCtx = {
  scheduleId: 'sched-1', siteId: 'site-1', versionId: 'ver-1',
  scheduleName: 'S', dateStart: '2026-01-01', dateEnd: '2026-01-31',
};

function run(tables: Record<string, TableCfg>) {
  const { sb, calls } = makeFakeSupabase({ tables });
  const executors = createToolExecutors();
  return { executors, sb: sb as never, calls };
}
// Paginated reads (loadOrgProviders, list_availability) select count:'exact'.
function canned(rows: unknown[]): TableCfg {
  return { data: rows, count: rows.length };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const res = (out: { result: unknown }) => out.result as any;

// ── Registry ─────────────────────────────────────────────────────────────────

describe('intake tools — registry', () => {
  it('the four writers are in MUTATING_TOOLS; list_availability is read-only', () => {
    for (const w of ['record_availability', 'cancel_availability', 'update_provider_profile', 'update_site_credentials']) {
      expect(MUTATING_TOOLS.has(w), w).toBe(true);
    }
    expect(MUTATING_TOOLS.has('list_availability')).toBe(false);
  });

  it('all five intake executors are registered', () => {
    const executors = createToolExecutors();
    for (const n of ['list_availability', 'record_availability', 'cancel_availability', 'update_provider_profile', 'update_site_credentials']) {
      expect(executors[n], n).toBeTypeOf('function');
    }
  });

  it('record_availability writable types = BLOCKING_AVAIL ∪ {no_call_request, call_request, pto_sellback}, all valid AVAILABILITY_TYPES', () => {
    const tool = assistantTools.find(t => t.name === 'record_availability')!;
    const schema = tool.input_schema as { properties: { availability_type: { enum: string[] } } };
    const enumVals = schema.properties.availability_type.enum;
    // Set-equality with the engine's canonical blocking set + the three
    // engine-meaningful non-blocking levers — the write set is DERIVED from
    // BLOCKING_AVAIL, so it cannot drift. DELIBERATE EXTENSIONS:
    // pto_sellback (2026-07-20) is the date-level blocking OVERRIDE
    // (chief-entered sell-back — isDateBlocked, shared.ts; ALGORITHM.md §6);
    // call_request (2026-07-22) is the soft PREFER lever — the mirror image
    // of no_call_request (scoreCall preferred tier, solveKernel.ts).
    expect(new Set(enumVals)).toEqual(new Set([...BLOCKING_AVAIL, 'no_call_request', 'call_request', 'pto_sellback']));
    for (const v of enumVals) expect(AVAILABILITY_TYPES as readonly string[]).toContain(v);
    expect(enumVals).not.toContain('available'); // informational, not engine-meaningful
  });

  it('update_site_credentials does NOT expose can_take_backup_call (dead in the engine)', () => {
    const tool = assistantTools.find(t => t.name === 'update_site_credentials')!;
    const schema = tool.input_schema as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).not.toContain('can_take_backup_call');
  });
});

// ── record_availability ──────────────────────────────────────────────────────

describe('record_availability', () => {
  const okOrg = { providers: { data: { organization_id: 'org-1' } }, sites: { data: { organization_id: 'org-1' } } };

  it('inserts an approved, all-day, source=assistant row scoped to the site', async () => {
    const { executors, sb, calls } = run({ ...okOrg, provider_availability: { data: { id: 'av-1' } } });
    const out = await executors.record_availability(sb, ctx, {
      provider_id: 'p1', availability_type: 'pto', start_date: '2026-01-10', end_date: '2026-01-12', notes: 'vacay',
    });
    expect(res(out).ok).toBe(true);
    const row = callsFor(calls, 'provider_availability', 'insert')[0].args[0] as Record<string, unknown>;
    expect(row).toMatchObject({
      provider_id: 'p1', site_id: 'site-1', availability_type: 'pto',
      start_date: '2026-01-10', end_date: '2026-01-12',
      all_day: true, approval_status: 'approved', source: 'assistant', notes: 'vacay',
    });
  });

  it('accepts no_call_request (the soft-flag lever) and defaults notes to null', async () => {
    const { executors, sb, calls } = run({ ...okOrg, provider_availability: { data: { id: 'av-2' } } });
    await executors.record_availability(sb, ctx, {
      provider_id: 'p1', availability_type: 'no_call_request', start_date: '2026-01-15', end_date: '2026-01-15',
    });
    const row = callsFor(calls, 'provider_availability', 'insert')[0].args[0] as Record<string, unknown>;
    expect(row.availability_type).toBe('no_call_request');
    expect(row.notes).toBeNull();
  });

  it('accepts call_request (the soft-prefer lever, mirror of no_call_request)', async () => {
    const { executors, sb, calls } = run({ ...okOrg, provider_availability: { data: { id: 'av-3' } } });
    await executors.record_availability(sb, ctx, {
      provider_id: 'p1', availability_type: 'call_request', start_date: '2026-01-15', end_date: '2026-01-15',
    });
    const row = callsFor(calls, 'provider_availability', 'insert')[0].args[0] as Record<string, unknown>;
    expect(row.availability_type).toBe('call_request');
    expect(row.approval_status).toBe('approved');
  });

  it('rejects a non-engine availability type (zod enum)', async () => {
    const { executors, sb } = run({});
    await expect(executors.record_availability(sb, ctx, {
      provider_id: 'p1', availability_type: 'conference', start_date: '2026-01-10', end_date: '2026-01-10',
    })).rejects.toBeInstanceOf(ToolInputError);
  });

  it('rejects a malformed date', async () => {
    const { executors, sb } = run({});
    await expect(executors.record_availability(sb, ctx, {
      provider_id: 'p1', availability_type: 'pto', start_date: '01/10/2026', end_date: '2026-01-10',
    })).rejects.toThrow(/ISO date/);
  });

  it('rejects end_date before start_date', async () => {
    const { executors, sb } = run({});
    await expect(executors.record_availability(sb, ctx, {
      provider_id: 'p1', availability_type: 'pto', start_date: '2026-01-12', end_date: '2026-01-10',
    })).rejects.toThrow(/on or after/);
  });

  it('errors when the provider does not exist', async () => {
    const { executors, sb } = run({ providers: { data: null }, sites: { data: { organization_id: 'org-1' } } });
    await expect(executors.record_availability(sb, ctx, {
      provider_id: 'p-nope', availability_type: 'pto', start_date: '2026-01-10', end_date: '2026-01-10',
    })).rejects.toThrow(/not found/);
  });

  it('rejects a provider outside the site organization (org guard)', async () => {
    const { executors, sb } = run({ providers: { data: { organization_id: 'org-2' } }, sites: { data: { organization_id: 'org-1' } } });
    await expect(executors.record_availability(sb, ctx, {
      provider_id: 'p1', availability_type: 'pto', start_date: '2026-01-10', end_date: '2026-01-10',
    })).rejects.toThrow(/organization/);
  });

  // Undo-window guard (schedule 2026-01-01 → 2026-01-31, window ±14d =
  // 2025-12-18 → 2026-02-14): a row entirely outside would escape the snapshot
  // baseline AND the revert delete-new pass — un-undoable invariant-2 data.
  it('rejects a range entirely outside the undo window (nothing inserted)', async () => {
    const { executors, sb, calls } = run({});
    await expect(executors.record_availability(sb, ctx, {
      provider_id: 'p1', availability_type: 'pto', start_date: '2026-03-01', end_date: '2026-03-05',
    })).rejects.toThrow(/undo window/);
    expect(callsFor(calls, 'provider_availability', 'insert')).toHaveLength(0);
  });

  it('accepts a range PARTIALLY overlapping the window (overlap is sufficient — the snapshot reads overlap too)', async () => {
    const { executors, sb, calls } = run({ ...okOrg, provider_availability: { data: { id: 'av-3' } } });
    const out = await executors.record_availability(sb, ctx, {
      provider_id: 'p1', availability_type: 'pto', start_date: '2026-02-10', end_date: '2026-02-20',
    });
    expect(res(out).ok).toBe(true);
    expect(callsFor(calls, 'provider_availability', 'insert')).toHaveLength(1);
  });
});

// ── cancel_availability ──────────────────────────────────────────────────────

describe('cancel_availability', () => {
  const okOrg = { providers: { data: { organization_id: 'org-1' } }, sites: { data: { organization_id: 'org-1' } } };
  const inWindowRow = (over: Record<string, unknown> = {}) => ({
    id: 'av-1', approval_status: 'approved', provider_id: 'p1',
    start_date: '2026-01-10', end_date: '2026-01-12', ...over,
  });

  it('flips approval_status to canceled (soft-cancel, never hard-delete)', async () => {
    const { executors, sb, calls } = run({ ...okOrg, provider_availability: { data: inWindowRow() } });
    const out = await executors.cancel_availability(sb, ctx, { id: 'av-1' });
    expect(res(out).ok).toBe(true);
    expect(callsFor(calls, 'provider_availability', 'update')[0].args[0]).toEqual({ approval_status: 'canceled' });
    // No delete ever issued.
    expect(callsFor(calls, 'provider_availability', 'delete')).toHaveLength(0);
  });

  it('errors on an unknown id', async () => {
    const { executors, sb } = run({ provider_availability: { data: null } });
    await expect(executors.cancel_availability(sb, ctx, { id: 'nope' })).rejects.toThrow(/not found/);
  });

  it('rejects an entry entirely outside the undo window (the flip could not be reverted)', async () => {
    const { executors, sb, calls } = run({
      ...okOrg,
      provider_availability: { data: inWindowRow({ start_date: '2026-05-01', end_date: '2026-05-05' }) },
    });
    await expect(executors.cancel_availability(sb, ctx, { id: 'av-1' })).rejects.toThrow(/undo window/);
    expect(callsFor(calls, 'provider_availability', 'update')).toHaveLength(0);
  });

  it("rejects an entry whose provider is outside this site's organization", async () => {
    const { executors, sb, calls } = run({
      providers: { data: { organization_id: 'org-2' } },
      sites: { data: { organization_id: 'org-1' } },
      provider_availability: { data: inWindowRow() },
    });
    await expect(executors.cancel_availability(sb, ctx, { id: 'av-1' })).rejects.toThrow(/organization/);
    expect(callsFor(calls, 'provider_availability', 'update')).toHaveLength(0);
  });
});

// ── update_provider_profile ──────────────────────────────────────────────────

describe('update_provider_profile', () => {
  const okOrg = { providers: { data: { organization_id: 'org-1' } }, sites: { data: { organization_id: 'org-1' } } };

  it('patches only the passed live fields', async () => {
    const { executors, sb, calls } = run({
      ...okOrg,
      provider_employment_profiles: { data: [{ id: 'prof-1', provider_id: 'p1', fte_value: 0.8, call_taker: false }] },
    });
    const out = await executors.update_provider_profile(sb, ctx, { provider_id: 'p1', fte_value: 0.8, call_taker: false });
    expect(res(out).ok).toBe(true);
    expect(callsFor(calls, 'provider_employment_profiles', 'update')[0].args[0]).toEqual({ fte_value: 0.8, call_taker: false });
  });

  it('rejects an empty patch', async () => {
    const { executors, sb } = run({});
    await expect(executors.update_provider_profile(sb, ctx, { provider_id: 'p1' })).rejects.toThrow(/at least one field/);
  });

  it('rejects an out-of-range fte_value', async () => {
    const { executors, sb } = run({});
    await expect(executors.update_provider_profile(sb, ctx, { provider_id: 'p1', fte_value: 5 })).rejects.toBeInstanceOf(ToolInputError);
  });

  it("rejects a provider outside this site's organization (org guard — org-wide snapshot scope)", async () => {
    const { executors, sb, calls } = run({
      providers: { data: { organization_id: 'org-2' } },
      sites: { data: { organization_id: 'org-1' } },
    });
    await expect(executors.update_provider_profile(sb, ctx, { provider_id: 'p9', fte_value: 0.8 })).rejects.toThrow(/organization/);
    expect(callsFor(calls, 'provider_employment_profiles', 'update')).toHaveLength(0);
  });

  it('errors (never inserts) when the provider has no employment profile', async () => {
    const { executors, sb, calls } = run({ ...okOrg, provider_employment_profiles: { data: [] } });
    await expect(executors.update_provider_profile(sb, ctx, { provider_id: 'p1', fte_value: 0.8 })).rejects.toThrow(/No employment profile/);
    expect(callsFor(calls, 'provider_employment_profiles', 'insert')).toHaveLength(0);
    expect(callsFor(calls, 'provider_employment_profiles', 'upsert')).toHaveLength(0);
  });
});

// ── update_site_credentials ──────────────────────────────────────────────────

describe('update_site_credentials', () => {
  it('patches only the passed fields, scoped to provider + THIS site', async () => {
    const { executors, sb, calls } = run({
      provider_site_credentials: { data: [{ id: 'cred-1', provider_id: 'p1', site_id: 'site-1', can_take_weekend_call: true }] },
    });
    const out = await executors.update_site_credentials(sb, ctx, { provider_id: 'p1', can_take_weekend_call: false });
    expect(res(out).ok).toBe(true);
    expect(callsFor(calls, 'provider_site_credentials', 'update')[0].args[0]).toEqual({ can_take_weekend_call: false });
    const eqs = calls.filter(c => c.table === 'provider_site_credentials' && c.method === 'eq').map(c => c.args);
    expect(eqs).toEqual([['provider_id', 'p1'], ['site_id', 'site-1']]);
  });

  it('rejects an empty patch', async () => {
    const { executors, sb } = run({});
    await expect(executors.update_site_credentials(sb, ctx, { provider_id: 'p1' })).rejects.toThrow(/at least one field/);
  });

  it('rejects can_take_backup_call (dead field — no engine consumer; spec: never write dead fields)', async () => {
    const { executors, sb, calls } = run({});
    await expect(executors.update_site_credentials(sb, ctx, { provider_id: 'p1', can_take_backup_call: false }))
      .rejects.toBeInstanceOf(ToolInputError);
    expect(callsFor(calls, 'provider_site_credentials', 'update')).toHaveLength(0);
  });

  it('errors clearly (never invents a row) when no credential row exists for this provider+site', async () => {
    const { executors, sb, calls } = run({ provider_site_credentials: { data: [] } });
    await expect(executors.update_site_credentials(sb, ctx, { provider_id: 'p1', can_take_weekend_call: false }))
      .rejects.toThrow(/No site-credential row exists for provider p1 at this site/);
    expect(callsFor(calls, 'provider_site_credentials', 'insert')).toHaveLength(0);
    expect(callsFor(calls, 'provider_site_credentials', 'upsert')).toHaveLength(0);
  });
});

// ── list_availability ────────────────────────────────────────────────────────

describe('list_availability', () => {
  it('returns org rows over the default (schedule ± 14d) window with provider names', async () => {
    const { executors, sb } = run({
      sites: { data: { organization_id: 'org-1' } },
      providers: canned([
        { id: 'p1', last_name: 'One', short_display_name: 'A. One' },
        { id: 'p2', last_name: 'Two', short_display_name: 'B. Two' },
      ]),
      provider_availability: canned([
        { id: 'av-1', provider_id: 'p1', availability_type: 'pto', start_date: '2026-01-10', end_date: '2026-01-12', approval_status: 'approved', source: 'manual' },
      ]),
    });
    const out = await executors.list_availability(sb, ctx, {});
    expect(res(out).total).toBe(1);
    expect(res(out).rows[0]).toMatchObject({ id: 'av-1', provider: 'A. One', availability_type: 'pto', source: 'manual' });
    expect(res(out).date_start).toBe('2025-12-18');
    expect(res(out).date_end).toBe('2026-02-14');
  });

  it('rejects a provider outside the org', async () => {
    const { executors, sb } = run({
      sites: { data: { organization_id: 'org-1' } },
      providers: canned([{ id: 'p1', last_name: 'One', short_display_name: 'A. One' }]),
    });
    await expect(executors.list_availability(sb, ctx, { provider_id: 'p-nope' })).rejects.toThrow(/not in this site's organization/);
  });

  it('rejects date_start after date_end', async () => {
    const { executors, sb } = run({});
    await expect(executors.list_availability(sb, ctx, { date_start: '2026-02-01', date_end: '2026-01-01' })).rejects.toThrow(/on or before/);
  });

  it('chunks the provider-id .in read at READ_CHUNK (URL-length safety, snapshot.ts convention)', async () => {
    const many = Array.from({ length: 201 }, (_, i) => ({
      id: `p${i}`, last_name: `L${i}`, short_display_name: `P ${i}`,
    }));
    const { executors, sb, calls } = run({
      sites: { data: { organization_id: 'org-1' } },
      providers: canned(many),
      provider_availability: canned([]),
    });
    const out = await executors.list_availability(sb, ctx, {});
    expect(res(out).total).toBe(0);
    // 201 org providers → two .in chunks (200 + 1).
    expect(callsFor(calls, 'provider_availability', 'in')).toHaveLength(2);
  });
});
