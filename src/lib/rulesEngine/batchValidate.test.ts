// batchValidateVersion — loads a whole version's validation data in a handful
// of queries, evaluates in memory via the same pure evaluators, and persists
// with ONE bulk write. Parity requirement: per-assignment violations must be
// IDENTICAL to serial evaluateAssignment on the same canned data.
import { describe, it, expect } from 'vitest';
import { batchValidateVersion, chunk, WRITE_CHUNK } from './batchValidate';
import { evaluateAssignment } from './evaluate';
import type { SiteValidationContext } from './loadContext';
import { makeFakeSupabase, fromCount, callsFor } from './__fixtures__/fakeSupabase';
import type { Filter, TableCfg } from './__fixtures__/fakeSupabase';
import type { ShiftTypeRow } from './types';

// ── canned dataset ───────────────────────────────────────────────────────────
// Version v1 at site s1, 5 slots / 5 assignments.
//   sA 01-07 C1 → a1 (p1)   p1 pending PTO on 01-07 → time_off hard
//   sB 01-07 C2 → a2 (p2)   p2 also assigned at site s2 same day → cross_site hard
//   sC 01-08 C1 → a3 (open) → open_slot + under-covered soft
//   sD 01-08 C2 → a4 (p1)   no flags — the clean control
//   sE 01-08 C2 → a5 (p2)   decoy: p2 has a C2 on 01-07 at s2/v9. p2's stated
//                           cap is exactly its two in-scope C2s, so if neighbor
//                           scoping leaks across version/site the count hits 3
//                           and a5 picks up a false provider-limit flag
//                           (parity + content assert it stays clean).

function st(code: string, category: ShiftTypeRow['category'] = 'call'): ShiftTypeRow {
  return {
    id: `st-${code}`, site_id: 's1', code, name: code, category,
    requires_credential: null, requires_specific_skills: [], generation_engine: null,
  };
}
const SHIFT_TYPES = [st('C1'), st('C2')];

const siteCtx: SiteValidationContext = {
  shiftTypesById: new Map(SHIFT_TYPES.map(s => [s.id, s])),
  shiftTypesByCode: new Map(SHIFT_TYPES.map(s => [s.code, s])),
};

// Stated per-provider limits (patch34). p2's C2 cap is set to exactly the two
// C2s it holds INSIDE v1/s1, which is what arms the neighbor-scoping decoy
// below: the evaluator reads neighborAssignments, so a scoping leak shows up
// as a count of 3 against a cap of 2. organization_id is deliberately null so
// no holiday read is issued and the query budget below stays honest.
const SCHEDULE_ROW = {
  provider_limits: { p2: { calls: { C2: 2 } } },
  date_start: '2026-01-01', date_end: '2026-01-31', organization_id: null,
};

function slot(id: string, date: string, code: string, assignment: { id: string; provider_id: string | null; assignment_status: string }, siteId = 's1') {
  return {
    id, site_id: siteId, slot_date: date, shift_type_id: `st-${code}`,
    provider_group: 'physician', derived_day_type: 'weekday',
    schedule_version_id: 'v1', required_count: 1,
    assignments: [assignment],
  };
}

const SLOTS = [
  slot('sA', '2026-01-07', 'C1', { id: 'a1', provider_id: 'p1', assignment_status: 'assigned' }),
  slot('sB', '2026-01-07', 'C2', { id: 'a2', provider_id: 'p2', assignment_status: 'assigned' }),
  slot('sC', '2026-01-08', 'C1', { id: 'a3', provider_id: null, assignment_status: 'open' }),
  slot('sD', '2026-01-08', 'C2', { id: 'a4', provider_id: 'p1', assignment_status: 'assigned' }),
  slot('sE', '2026-01-08', 'C2', { id: 'a5', provider_id: 'p2', assignment_status: 'assigned' }),
];

const PROVIDERS = [
  { id: 'p1', provider_type: 'physician', provider_employment_profiles: { fte_value: 1 } },
  { id: 'p2', provider_type: 'physician', provider_employment_profiles: { fte_value: 0.5 } },
];

const AVAILABILITY = [
  {
    id: 'av1', provider_id: 'p1', availability_type: 'pto',
    start_date: '2026-01-07', end_date: '2026-01-07', approval_status: 'pending',
  },
];

const CREDS = ['p1', 'p2'].map(pid => ({
  provider_id: pid, site_id: 's1', is_active: true, credentialed: true,
  can_take_call: true, can_take_weekend_call: true, can_take_holiday_call: true,
  can_take_backup_call: true, allowed_shift_types: [], excluded_shift_types: [],
  skill_tags: [],
}));

// All assigned rows for p1/p2 the real DB holds. The version under validation
// (v1) is a DRAFT — its rows are seen only via the helper's includeVersionId
// variant. ax is p2's C1 at another site+version; it is PUBLISHED (committed),
// so it both cross-flags a2 and serves as the neighbor-scoping decoy.
function joined(
  id: string, pid: string, slotId: string, date: string, code: string,
  siteId = 's1', versionId = 'v1', status = 'draft',
) {
  return {
    id, provider_id: pid, schedule_slot_id: slotId, assignment_status: 'assigned',
    schedule_slots: {
      id: slotId, slot_date: date, shift_type_id: `st-${code}`,
      derived_day_type: 'weekday', site_id: siteId, schedule_version_id: versionId,
      schedule_versions: { version_status: status },
    },
  };
}
type JoinedRow = ReturnType<typeof joined>;
const ASSIGNED_ROWS = [
  joined('a1', 'p1', 'sA', '2026-01-07', 'C1'),                             // v1 draft
  joined('a2', 'p2', 'sB', '2026-01-07', 'C2'),                             // v1 draft
  joined('a4', 'p1', 'sD', '2026-01-08', 'C2'),                             // v1 draft
  joined('a5', 'p2', 'sE', '2026-01-08', 'C2'),                             // v1 draft
  joined('ax', 'p2', 'sX', '2026-01-07', 'C2', 's2', 'v9', 'published'),    // committed decoy
];

// Honest mini-DB for the assignments table: applies the recorded eq/in/gte/lte
// filters (including the published predicate and the current-version scope) so
// both the batch and serial query shapes get correctly-filtered rows. The
// helper's two-query strategy (published + current version) resolves each
// variant against this and merges.
function assignmentsTableFor(source: JoinedRow[], filters: Filter[]) {
  if (filters.some(f => f.method === 'upsert' || f.method === 'update' || f.method === 'insert')) {
    return { data: null, error: null };
  }
  let rows = source;
  for (const f of filters) {
    const [col, val] = f.args as [string, unknown];
    if (f.method === 'eq') {
      if (col === 'provider_id') rows = rows.filter(r => r.provider_id === val);
      if (col === 'assignment_status') rows = rows.filter(r => r.assignment_status === val);
      if (col === 'schedule_slots.slot_date') rows = rows.filter(r => r.schedule_slots.slot_date === val);
      if (col === 'schedule_slots.site_id') rows = rows.filter(r => r.schedule_slots.site_id === val);
      if (col === 'schedule_slots.schedule_version_id') rows = rows.filter(r => r.schedule_slots.schedule_version_id === val);
      if (col === 'schedule_slots.schedule_versions.version_status') rows = rows.filter(r => r.schedule_slots.schedule_versions.version_status === val);
    }
    if (f.method === 'in' && col === 'provider_id') {
      rows = rows.filter(r => (val as string[]).includes(r.provider_id));
    }
    if (f.method === 'gte' && col === 'schedule_slots.slot_date') {
      rows = rows.filter(r => r.schedule_slots.slot_date >= (val as string));
    }
    if (f.method === 'lte' && col === 'schedule_slots.slot_date') {
      rows = rows.filter(r => r.schedule_slots.slot_date <= (val as string));
    }
  }
  return { data: rows, error: null };
}
function assignmentsTable(filters: Filter[]) {
  return assignmentsTableFor(ASSIGNED_ROWS, filters);
}

function batchTables(over: Record<string, TableCfg> = {}): Record<string, TableCfg> {
  return {
    schedule_slots: { data: SLOTS, error: null },
    providers: { data: PROVIDERS, error: null },
    provider_availability: { data: AVAILABILITY, error: null },
    provider_site_credentials: { data: CREDS, error: null },
    assignments: assignmentsTable,
    schedule_versions: { data: { schedule_id: 'sched1' }, error: null },
    schedules: { data: SCHEDULE_ROW, error: null },
    ...over,
  };
}

// Serial fakes must branch on the query shape (loadContext hits
// schedule_slots twice: once by id, once by version+date).
function serialTables(): Record<string, TableCfg> {
  return {
    schedule_slots: (filters: Filter[]) => {
      const eqId = filters.find(f => f.method === 'eq' && f.args[0] === 'id');
      if (eqId) return { data: SLOTS.find(s => s.id === eqId.args[1]) ?? null, error: null };
      const eqDate = filters.find(f => f.method === 'eq' && f.args[0] === 'slot_date');
      return { data: SLOTS.filter(s => s.slot_date === eqDate?.args[1]), error: null };
    },
    providers: (filters: Filter[]) => {
      const eqId = filters.find(f => f.method === 'eq' && f.args[0] === 'id');
      return { data: PROVIDERS.find(p => p.id === eqId?.args[1]) ?? null, error: null };
    },
    provider_availability: (filters: Filter[]) => {
      const eqPid = filters.find(f => f.method === 'eq' && f.args[0] === 'provider_id');
      return { data: AVAILABILITY.filter(a => a.provider_id === eqPid?.args[1]), error: null };
    },
    provider_site_credentials: (filters: Filter[]) => {
      const eqPid = filters.find(f => f.method === 'eq' && f.args[0] === 'provider_id');
      return { data: CREDS.find(c => c.provider_id === eqPid?.args[1]) ?? null, error: null };
    },
    assignments: assignmentsTable,
    schedule_versions: { data: { schedule_id: 'sched1' }, error: null },
    schedules: { data: SCHEDULE_ROW, error: null },
  };
}

describe('batchValidateVersion', () => {
  it('issues at most 11 queries for the whole version', async () => {
    // slots + providers + availability + credentials + the committed-scope
    // assignments window (TWO reads: published + this version, draft isolation)
    // + one bulk write = 7, plus the two soft-flag contexts, which each walk
    // schedule_versions → schedules: provider limits (patch34) and the
    // scenario manifest (patch37) = 4 more. The fixture resolves a real parent
    // schedule, which is the production case — a version with no parent row
    // short-circuits each loader after its first read, which is what this
    // budget used to measure and is not what the live path does. The holiday
    // and PTO-netting reads stay out: organization_id is null and no daysOff
    // limit is stated.
    const { sb, calls } = makeFakeSupabase({ tables: batchTables() });
    await batchValidateVersion(sb, 'v1', siteCtx);
    expect(fromCount(calls)).toBeLessThanOrEqual(11);
  });

  it('per-assignment violations are identical to serial evaluateAssignment', async () => {
    const { sb } = makeFakeSupabase({ tables: batchTables() });
    const batch = await batchValidateVersion(sb, 'v1', siteCtx);
    expect(batch.results).toHaveLength(5);

    const byAssignment = new Map(batch.results.map(r => [r.assignmentId, r]));
    const targets: Array<[string, string, string | null]> = [
      ['a1', 'sA', 'p1'],
      ['a2', 'sB', 'p2'],
      ['a3', 'sC', null],
      ['a4', 'sD', 'p1'],
      ['a5', 'sE', 'p2'],
    ];
    for (const [aid, slotId, providerId] of targets) {
      const { sb: serialSb } = makeFakeSupabase({ tables: serialTables() });
      const serial = await evaluateAssignment(serialSb, slotId, providerId, siteCtx);
      const batched = byAssignment.get(aid)!;
      expect(batched.evaluated).toBe(true);
      expect(serial.evaluated).toBe(true);
      expect(batched.violations).toEqual(serial.violations);
      expect(batched.hardCount).toBe(serial.hardCount);
      expect(batched.softCount).toBe(serial.softCount);
    }

    // Guard against trivially-empty parity: the canned data must actually
    // produce the designed violations.
    expect(byAssignment.get('a1')!.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'time_off', severity: 'hard' }),
      ]),
    );
    expect(byAssignment.get('a2')!.violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ category: 'cross_site', severity: 'hard' })]),
    );
    expect(byAssignment.get('a3')!.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'open_slot', severity: 'soft' }),
        expect.objectContaining({ category: 'coverage', severity: 'soft' }),
      ]),
    );
    // a4: p1 has no stated cap and nothing else applies → the clean control.
    expect(byAssignment.get('a4')!.violations).toEqual([]);
    // a5: p2's third C2 exists ONLY at s2/v9 (decoy). Correct scoping excludes
    // it, so p2 sits AT its cap of 2 rather than over it. A scoping leak in
    // either path would fail here or break the parity loop above. The
    // positive control below proves the cap is live in this fixture, so this
    // empty result is a real pass and not a silent no-op.
    expect(byAssignment.get('a5')!.violations).toEqual([]);
  });

  // Positive control for the decoy above: drop p2's cap by one and the same
  // fixture DOES flag, through the same neighbor window. Without this, a
  // provider-limits context that silently failed to load would make the
  // scoping assertion pass for the wrong reason.
  it('the neighbor-window cap is live — one lower and the same data flags', async () => {
    const { sb } = makeFakeSupabase({ tables: batchTables({
      schedules: { data: { ...SCHEDULE_ROW, provider_limits: { p2: { calls: { C2: 1 } } } }, error: null },
    }) });
    const batch = await batchValidateVersion(sb, 'v1', siteCtx);
    const a5 = batch.results.find(r => r.assignmentId === 'a5')!;
    expect(a5.evaluated).toBe(true);
    expect(a5.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule_name: 'Provider limit (calls)', severity: 'soft' }),
      ]),
    );
  });

  // Draft isolation (invariant 3): the same-day other-site booking flags a2 as
  // cross_site ONLY when its version is committed (published). A second
  // unpublished draft must be invisible.
  describe('cross-site draft isolation', () => {
    // p1 alone: one slot in v1(draft) at s1, plus a same-day booking at s2 in a
    // separate version whose publish status is the variable under test.
    const isoSlots = [slot('sA', '2026-01-07', 'C1', { id: 'a1', provider_id: 'p1', assignment_status: 'assigned' })];
    const isoProviders = [{ id: 'p1', provider_type: 'physician', provider_employment_profiles: { fte_value: 1 } }];
    const isoCreds = [{
      provider_id: 'p1', site_id: 's1', is_active: true, credentialed: true,
      can_take_call: true, can_take_weekend_call: true, can_take_holiday_call: true,
      can_take_backup_call: true, allowed_shift_types: [], excluded_shift_types: [], skill_tags: [],
    }];
    const isoTables = (otherStatus: string): Record<string, TableCfg> => ({
      schedule_slots: { data: isoSlots, error: null },
      providers: { data: isoProviders, error: null },
      provider_availability: { data: [], error: null },
      provider_site_credentials: { data: isoCreds, error: null },
      assignments: (filters: Filter[]) => assignmentsTableFor([
        joined('a1', 'p1', 'sA', '2026-01-07', 'C1', 's1', 'v1', 'draft'),          // self (current version)
        joined('aO', 'p1', 'sO', '2026-01-07', 'C1', 's2', 'v9', otherStatus),      // other site + version
      ], filters),
    });

    it('a PUBLISHED other-site booking → cross_site hard flag', async () => {
      const { sb } = makeFakeSupabase({ tables: isoTables('published') });
      const res = await batchValidateVersion(sb, 'v1', siteCtx);
      const a1 = res.results.find(r => r.assignmentId === 'a1')!;
      expect(a1.evaluated).toBe(true);
      expect(a1.violations).toEqual(
        expect.arrayContaining([expect.objectContaining({ category: 'cross_site', severity: 'hard' })]),
      );
    });

    it('a DRAFT other-site booking → no cross_site flag', async () => {
      const { sb } = makeFakeSupabase({ tables: isoTables('draft') });
      const res = await batchValidateVersion(sb, 'v1', siteCtx);
      const a1 = res.results.find(r => r.assignmentId === 'a1')!;
      expect(a1.evaluated).toBe(true);
      expect(a1.violations.some(v => v.category === 'cross_site')).toBe(false);
    });
  });

  it('persists with ONE bulk upsert (id + validation_flags per row)', async () => {
    const { sb, calls } = makeFakeSupabase({ tables: batchTables() });
    const batch = await batchValidateVersion(sb, 'v1', siteCtx);

    const upserts = callsFor(calls, 'assignments', 'upsert');
    expect(upserts).toHaveLength(1);
    const payload = upserts[0].args[0] as Array<Record<string, unknown>>;
    expect(Array.isArray(payload)).toBe(true);
    expect(payload.map(r => r.id).sort()).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);
    for (const row of payload) {
      expect(row).toHaveProperty('validation_flags');
    }
    const a1Row = payload.find(r => r.id === 'a1')!;
    expect(a1Row.validation_flags).toEqual(
      batch.results.find(r => r.assignmentId === 'a1')!.violations,
    );
    // No per-row update fallbacks alongside the (successful) bulk write.
    expect(callsFor(calls, 'assignments', 'update')).toHaveLength(0);
  });

  it('empty version: one query, no writes', async () => {
    const { sb, calls } = makeFakeSupabase({ tables: { schedule_slots: { data: [], error: null } } });
    const res = await batchValidateVersion(sb, 'v1', siteCtx);
    expect(res.results).toHaveLength(0);
    expect(fromCount(calls)).toBe(1);
    expect(callsFor(calls, 'assignments', 'upsert')).toHaveLength(0);
  });

  // ── preload failures (invariant 6: a failed load must not fake-clean) ─────
  describe('preload query failures → all targets evaluated:false, nothing written', () => {
    const failing = { data: null, error: { message: 'db down' } };
    const cases: Array<[string, Record<string, TableCfg>]> = [
      ['providers', batchTables({ providers: failing })],
      ['provider_availability', batchTables({ provider_availability: failing })],
      ['provider_site_credentials', batchTables({ provider_site_credentials: failing })],
      // assignments read fails, but a (hypothetical) write would succeed —
      // the test proves no write is even attempted.
      ['assignments (neighbor read)', batchTables({
        assignments: (filters: Filter[]) =>
          filters.some(f => f.method === 'upsert' || f.method === 'update')
            ? { data: null, error: null }
            : failing,
      })],
    ];

    for (const [name, tables] of cases) {
      it(`${name} query fails`, async () => {
        const { sb, calls } = makeFakeSupabase({ tables });
        const res = await batchValidateVersion(sb, 'v1', siteCtx);
        expect(res.results).toHaveLength(5);
        expect(res.results.every(r => r.evaluated === false)).toBe(true);
        expect(res.results.every(r => r.violations.length === 0)).toBe(true);
        expect(res.written).toBe(0);
        expect(callsFor(calls, 'assignments', 'upsert')).toHaveLength(0);
        expect(callsFor(calls, 'assignments', 'update')).toHaveLength(0);
        expect(res.errors.join(' ')).toContain('validation-unavailable');
        expect(res.errors.join(' ')).toContain('db down');
      });
    }
  });

  // ── truncated preloads (invariant 6's quietest failure mode) ─────────────
  // Worse than a failed read, because nothing looks wrong: the rows for the
  // providers that sort last are simply absent, those providers validate
  // against an empty PTO list, `evaluated` stays TRUE and CLEAN
  // validation_flags get written over a collision nobody looked at. These
  // reads are not paged — they use truncationOf — so this detector is the
  // whole of the protection and must stay pinned.
  describe('truncated preloads → evaluated:false, nothing written', () => {
    const truncated = (rows: unknown[]) => ({ data: rows, error: null, count: rows.length + 1 });
    const cases: Array<[string, Record<string, TableCfg>]> = [
      ['providers', batchTables({ providers: truncated(PROVIDERS) })],
      ['provider_availability', batchTables({ provider_availability: truncated([]) })],
      ['provider_site_credentials', batchTables({ provider_site_credentials: truncated(CREDS) })],
    ];

    for (const [name, tables] of cases) {
      it(`${name} read is short`, async () => {
        const { sb, calls } = makeFakeSupabase({ tables });
        const res = await batchValidateVersion(sb, 'v1', siteCtx);
        expect(res.results.every(r => r.evaluated === false)).toBe(true);
        expect(res.written).toBe(0);
        expect(callsFor(calls, 'assignments', 'upsert')).toHaveLength(0);
        expect(res.errors.join(' ')).toContain('validation-unavailable');
        expect(res.errors.join(' ')).toMatch(/truncated|count unavailable/i);
      });
    }

    it('a null count aborts too — the count option was dropped', async () => {
      const { sb } = makeFakeSupabase({
        tables: batchTables({ provider_availability: { data: [], error: null, count: null } }),
      });
      const res = await batchValidateVersion(sb, 'v1', siteCtx);
      expect(res.results.every(r => r.evaluated === false)).toBe(true);
      expect(res.errors.join(' ')).toMatch(/count unavailable/i);
    });

    it('a complete read still validates — the guard is not a blanket bail', async () => {
      const { sb } = makeFakeSupabase({ tables: batchTables() });
      const res = await batchValidateVersion(sb, 'v1', siteCtx);
      expect(res.results.some(r => r.evaluated === true)).toBe(true);
    });
  });

  it('siteCtx that failed to load → declines to evaluate or write', async () => {
    const { sb, calls } = makeFakeSupabase({ tables: batchTables() });
    const res = await batchValidateVersion(sb, 'v1', {
      ...siteCtx, loadError: 'shift_types load failed: boom',
    });
    expect(res.written).toBe(0);
    expect(callsFor(calls, 'assignments', 'upsert')).toHaveLength(0);
    expect(res.errors.join(' ')).toContain('validation-unavailable');
  });

  it('off-site slots (single-site invariant broken) → those targets evaluated:false + error', async () => {
    const offSiteSlot = slot('sF', '2026-01-07', 'C1', { id: 'a6', provider_id: 'p1', assignment_status: 'assigned' }, 's2');
    const { sb, calls } = makeFakeSupabase({
      tables: batchTables({ schedule_slots: { data: [...SLOTS, offSiteSlot], error: null } }),
    });
    const res = await batchValidateVersion(sb, 'v1', siteCtx);
    const a6 = res.results.find(r => r.assignmentId === 'a6')!;
    expect(a6.evaluated).toBe(false);
    expect(res.errors.join(' ')).toContain('site');
    // The on-site assignments are still validated and written.
    const payload = callsFor(calls, 'assignments', 'upsert')[0].args[0] as Array<Record<string, unknown>>;
    expect(payload.map(r => r.id).sort()).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);
  });

  // ── bulk-write failure → per-row update fallback ───────────────────────────
  describe('upsert fallback', () => {
    it('chunk upsert failure falls back to per-row updates (no ghost inserts)', async () => {
      const { sb, calls } = makeFakeSupabase({
        tables: batchTables({
          assignments: (filters: Filter[]) => {
            if (filters.some(f => f.method === 'upsert')) return { data: null, error: { message: 'conflict' } };
            if (filters.some(f => f.method === 'update')) {
              // Per-row fallback confirms the touched row via .select();
              // only DB-confirmed rows count as written.
              const eqId = filters.find(f => f.method === 'eq' && f.args[0] === 'id');
              return { data: [{ id: eqId?.args[1] }], error: null };
            }
            return assignmentsTable(filters);
          },
        }),
      });
      const res = await batchValidateVersion(sb, 'v1', siteCtx);
      const updates = callsFor(calls, 'assignments', 'update');
      expect(updates).toHaveLength(5); // one per row in the failed chunk
      for (const u of updates) {
        expect(u.args[0]).toHaveProperty('validation_flags');
      }
      expect(res.written).toBe(5);
      expect(res.errors).toEqual([]); // fallback succeeded — data IS written
    });

    it('rows whose fallback update also fails are surfaced by id', async () => {
      const { sb } = makeFakeSupabase({
        tables: batchTables({
          assignments: (filters: Filter[]) => {
            if (filters.some(f => f.method === 'upsert')) return { data: null, error: { message: 'conflict' } };
            const upd = filters.find(f => f.method === 'update');
            if (upd) {
              const eqId = filters.find(f => f.method === 'eq' && f.args[0] === 'id');
              return eqId?.args[1] === 'a2'
                ? { data: null, error: { message: 'row gone' } }
                : { data: [{ id: eqId?.args[1] }], error: null }; // DB-confirmed row
            }
            return assignmentsTable(filters);
          },
        }),
      });
      const res = await batchValidateVersion(sb, 'v1', siteCtx);
      expect(res.written).toBe(4);
      expect(res.errors.join(' ')).toContain('a2');
      expect(res.errors.join(' ')).toContain('row gone');
    });
  });
});

describe('chunk', () => {
  it('splits writes at the 500-row boundary', () => {
    const rows = Array.from({ length: WRITE_CHUNK + 1 }, (_, i) => i);
    const out = chunk(rows, WRITE_CHUNK);
    expect(out).toHaveLength(2);
    expect(out[0]).toHaveLength(WRITE_CHUNK);
    expect(out[1]).toEqual([WRITE_CHUNK]);
    expect(chunk([], WRITE_CHUNK)).toEqual([]);
  });
});

// ── one-to-one assignments embed (live UNIQUE(schedule_slot_id)) ────────────
// PostgREST returns each slot's assignments embed as ONE OBJECT (or null),
// not an array, against the live DB. batchValidateVersion must normalize —
// an object here used to throw while building targets (→ validation dead).
describe('batchValidateVersion — one-to-one assignments embed', () => {
  it('object-shaped embeds still yield one target per assignment row, parity intact', async () => {
    const objSlots = SLOTS.map(s => ({ ...s, assignments: s.assignments[0] })); // live shape
    const { sb } = makeFakeSupabase({
      tables: batchTables({ schedule_slots: { data: objSlots, error: null } }),
    });
    const batch = await batchValidateVersion(sb, 'v1', siteCtx);
    expect(batch.errors).toEqual([]);
    expect(batch.results).toHaveLength(5);
    expect(batch.results.every(r => r.evaluated)).toBe(true);
    // Same-day coverage math (sameDayFor) must see the normalized rows too:
    // the open C1 slot sC still gets its open_slot violation.
    const a3 = batch.results.find(r => r.assignmentId === 'a3')!;
    expect(a3.violations.length).toBeGreaterThan(0);
  });

  it('null embed (one-to-one, no row) contributes no target and does not throw', async () => {
    const objSlots = SLOTS.map(s => ({ ...s, assignments: s.assignments[0] }));
    const withNull = [...objSlots, { ...SLOTS[0], id: 'sNull', assignments: null }];
    const { sb } = makeFakeSupabase({
      tables: batchTables({ schedule_slots: { data: withNull, error: null } }),
    });
    const batch = await batchValidateVersion(sb, 'v1', siteCtx);
    expect(batch.errors).toEqual([]);
    expect(batch.results).toHaveLength(5); // sNull adds nothing
  });
});
