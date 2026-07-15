// Unit tests for the committed-assignment scope helper — the ONE place the
// "committed = published" predicate lives. Pins: the published predicate is
// applied, the exclusions (schedule/site), the two-query includeVersionId merge
// + dedupe, and error passthrough (so fail-closed callers keep failing closed).
import { describe, it, expect } from 'vitest';
import { fetchCommittedAssignments } from './committedAssignments';
import { makeFakeSupabase, callsFor } from './__fixtures__/fakeSupabase';
import type { Filter } from './__fixtures__/fakeSupabase';

interface Row {
  id: string;
  provider_id: string;
  schedule_slots: {
    slot_date: string;
    site_id: string;
    schedule_version_id: string;
    schedule_versions: { schedule_id: string; version_status: string };
  };
}

const row = (
  id: string, o: { pid?: string; date?: string; site?: string; version?: string; schedule?: string; status?: string } = {},
): Row => ({
  id,
  provider_id: o.pid ?? 'p1',
  schedule_slots: {
    slot_date: o.date ?? '2026-01-07',
    site_id: o.site ?? 's1',
    schedule_version_id: o.version ?? 'vDraft',
    schedule_versions: { schedule_id: o.schedule ?? 'sched1', version_status: o.status ?? 'draft' },
  },
});

// Mini-DB honoring exactly the filters the helper emits.
function assignmentsFor(all: Row[]) {
  return (filters: Filter[]) => {
    let rows = all;
    for (const f of filters) {
      const [col, val] = f.args as [string, unknown];
      if (f.method === 'eq') {
        if (col === 'assignment_status') continue; // all rows are assigned
        if (col === 'provider_id') rows = rows.filter(r => r.provider_id === val);
        if (col === 'schedule_slots.schedule_version_id') rows = rows.filter(r => r.schedule_slots.schedule_version_id === val);
        if (col === 'schedule_slots.schedule_versions.version_status') rows = rows.filter(r => r.schedule_slots.schedule_versions.version_status === val);
      }
      if (f.method === 'in' && col === 'provider_id') rows = rows.filter(r => (val as string[]).includes(r.provider_id));
      if (f.method === 'neq' && col === 'schedule_slots.schedule_versions.schedule_id') rows = rows.filter(r => r.schedule_slots.schedule_versions.schedule_id !== val);
      if (f.method === 'neq' && col === 'schedule_slots.site_id') rows = rows.filter(r => r.schedule_slots.site_id !== val);
      if (f.method === 'gte' && col === 'schedule_slots.slot_date') rows = rows.filter(r => r.schedule_slots.slot_date >= (val as string));
      if (f.method === 'lte' && col === 'schedule_slots.slot_date') rows = rows.filter(r => r.schedule_slots.slot_date <= (val as string));
    }
    return { data: rows, error: null };
  };
}

const SELECT = 'id, provider_id, schedule_slots!inner(slot_date, site_id, schedule_version_id, schedule_versions!inner(schedule_id, version_status))';
const ids = (data: Array<Record<string, unknown>> | null) => (data ?? []).map(r => r.id as string).sort();

describe('fetchCommittedAssignments', () => {
  it('published-only (no includeVersionId): committed rows returned, drafts excluded, ONE query', async () => {
    const { sb, calls } = makeFakeSupabase({
      tables: {
        assignments: assignmentsFor([
          row('pub', { status: 'published' }),
          row('draft', { status: 'draft' }),
        ]),
      },
    });
    const { data, error } = await fetchCommittedAssignments(sb, SELECT, {
      providerIds: ['p1'], start: '2026-01-01', end: '2026-01-31',
    });
    expect(error).toBeNull();
    expect(ids(data)).toEqual(['pub']);
    // Single query — the current-version variant does not run.
    expect(callsFor(calls, 'assignments', 'from')).toHaveLength(1);
    // The predicate is applied exactly once, here.
    const pub = calls.filter(c => c.method === 'eq' && c.args[0] === 'schedule_slots.schedule_versions.version_status' && c.args[1] === 'published');
    expect(pub).toHaveLength(1);
  });

  it('includeVersionId: merges published + current-version rows, deduped by id, TWO queries', async () => {
    const { sb, calls } = makeFakeSupabase({
      tables: {
        assignments: assignmentsFor([
          row('pubOther', { status: 'published', version: 'vPub' }),
          row('draftOther', { status: 'draft', version: 'vOtherDraft' }),
          row('mine', { status: 'draft', version: 'vDraft' }),                 // current version, draft
          row('minePub', { status: 'published', version: 'vDraft' }),          // current version AND published → dedupe
        ]),
      },
    });
    const { data, error } = await fetchCommittedAssignments(sb, SELECT, {
      providerId: 'p1', start: '2026-01-01', end: '2026-01-31', includeVersionId: 'vDraft',
    });
    expect(error).toBeNull();
    // pubOther (published), mine (current version), minePub (both, once). The
    // unrelated other draft is invisible.
    expect(ids(data)).toEqual(['mine', 'minePub', 'pubOther']);
    expect(callsFor(calls, 'assignments', 'from')).toHaveLength(2);
    // Exactly one occurrence of each row id (dedupe held).
    expect((data ?? []).filter(r => r.id === 'minePub')).toHaveLength(1);
  });

  it('excludeScheduleId drops the parent schedule from the published variant', async () => {
    const { sb } = makeFakeSupabase({
      tables: {
        assignments: assignmentsFor([
          row('parent', { status: 'published', schedule: 'sched1' }),
          row('other', { status: 'published', schedule: 'sched2' }),
        ]),
      },
    });
    const { data } = await fetchCommittedAssignments(sb, SELECT, {
      providerIds: ['p1'], start: '2026-01-01', end: '2026-01-31', excludeScheduleId: 'sched1',
    });
    expect(ids(data)).toEqual(['other']);
  });

  it('excludeSiteId (degraded fallback) drops the same-site rows from the published variant', async () => {
    const { sb } = makeFakeSupabase({
      tables: {
        assignments: assignmentsFor([
          row('sameSite', { status: 'published', site: 's1' }),
          row('otherSite', { status: 'published', site: 's2' }),
        ]),
      },
    });
    const { data } = await fetchCommittedAssignments(sb, SELECT, {
      providerIds: ['p1'], start: '2026-01-01', end: '2026-01-31', excludeSiteId: 's1',
    });
    expect(ids(data)).toEqual(['otherSite']);
  });

  it('a published-variant error → { data: null, error } (no second query)', async () => {
    const { sb, calls } = makeFakeSupabase({
      tables: { assignments: () => ({ data: null, error: { message: 'db down' } }) },
    });
    const { data, error } = await fetchCommittedAssignments(sb, SELECT, {
      providerId: 'p1', start: '2026-01-01', end: '2026-01-31', includeVersionId: 'vDraft',
    });
    expect(data).toBeNull();
    expect(error?.message).toBe('db down');
    expect(callsFor(calls, 'assignments', 'from')).toHaveLength(1); // bailed before the 2nd
  });

  it('a current-version-variant error → { data: null, error }', async () => {
    // Published query succeeds; the current-version query fails.
    const { sb } = makeFakeSupabase({
      tables: {
        assignments: (filters: Filter[]) => {
          const isCurrent = filters.some(f => f.method === 'eq' && f.args[0] === 'schedule_slots.schedule_version_id');
          return isCurrent ? { data: null, error: { message: 'boom' } } : { data: [], error: null };
        },
      },
    });
    const { data, error } = await fetchCommittedAssignments(sb, SELECT, {
      providerId: 'p1', start: '2026-01-01', end: '2026-01-31', includeVersionId: 'vDraft',
    });
    expect(data).toBeNull();
    expect(error?.message).toBe('boom');
  });

  it('providerIds → .in, providerId → .eq; date window applied via gte/lte', async () => {
    const arr = makeFakeSupabase({ tables: { assignments: assignmentsFor([]) } });
    await fetchCommittedAssignments(arr.sb, SELECT, { providerIds: ['p1', 'p2'], start: '2026-01-01', end: '2026-01-31' });
    expect(arr.calls.some(c => c.method === 'in' && c.args[0] === 'provider_id')).toBe(true);

    const one = makeFakeSupabase({ tables: { assignments: assignmentsFor([]) } });
    await fetchCommittedAssignments(one.sb, SELECT, { providerId: 'p9', start: '2026-01-01', end: '2026-01-31' });
    expect(one.calls.some(c => c.method === 'eq' && c.args[0] === 'provider_id' && c.args[1] === 'p9')).toBe(true);
    expect(one.calls.some(c => c.method === 'gte' && c.args[0] === 'schedule_slots.slot_date' && c.args[1] === '2026-01-01')).toBe(true);
    expect(one.calls.some(c => c.method === 'lte' && c.args[0] === 'schedule_slots.slot_date' && c.args[1] === '2026-01-31')).toBe(true);
  });
});
