import { describe, it, expect } from 'vitest';
import { solve } from './solve';
import { optimize } from './optimize';
import { CLASSIC_PATTERN } from './callPattern';
import { buildCtx, prov, callSlot, dSlot, shiftInfo } from './__fixtures__/buildContext';
import { mayEvictPreFill, preFillCodes, shiftRank } from './preFillEviction';
import type { GenerationContext, SeedAssignment, ShiftTypeInfo, WorkDayBudget } from './genTypes';

// ── Engine-side seed eviction (2026-07-21, the Hussain 9/30 bug) ─────────────
// Multi-pass generation froze stale derived pre-fills: run 1 gave Hussain
// 10/1 C2, whose -1 link pre-filled 9/30 D3. Run 2 (regenerate over the seeded
// grid) filled the still-open 9/29 C2 with Hussain; its +1 D1 chain found him
// 'already-assigned' on 9/30 — his own STALE auto-generated D3 seed — and left
// the D1 slot open. Gabriel's standing rule (2026-07-19, the Jones fix): D1
// (post-C2) OVERRIDES any pre-call status. sequenceAutoFill already evicts
// outranked auto-generated pre-fills; these tests pin the engine equivalent
// for SEEDS, sharing ONE eviction predicate (preFillEviction.ts).

const SHIFT_TYPES = new Map<string, ShiftTypeInfo>([
  ['C1', shiftInfo('C1', { category: 'call', call_rank: 0, generation_engine: 'call', requires_post_call_rule: true })],
  ['C2', shiftInfo('C2', { category: 'call', call_rank: 1, generation_engine: 'call', requires_post_call_rule: true })],
  ['D1', shiftInfo('D1', { generation_engine: 'call' })],
  ['D3', shiftInfo('D3', { generation_engine: 'call' })],
]);

// The stale run-1 pre-fill: Hussain's 9/30 D3, auto-generated, same version.
function staleD3Seed(over: Partial<SeedAssignment> = {}): SeedAssignment {
  return {
    slot_date: '2026-09-30', provider_id: 'hussain',
    shift_type_code: 'D3', shift_type_category: 'regular', derived_day_type: 'weekday',
    slot_id: 'slot-d3-0930', assignment_id: 'a-d3-0930',
    source_type: 'auto_generated', schedule_version_id: 'v1',
    ...over,
  };
}

// Run 1's committed 10/1 C2 (the trigger whose -1 link created the D3 seed).
function committedC2Seed(): SeedAssignment {
  return {
    slot_date: '2026-10-01', provider_id: 'hussain',
    shift_type_code: 'C2', shift_type_category: 'call', derived_day_type: 'weekday',
    slot_id: 'slot-c2-1001', assignment_id: 'a-c2-1001',
    source_type: 'auto_generated', schedule_version_id: 'v1',
  };
}

// Run 2's grid: the still-open 9/29 C2, its open 9/30 D1 chain target, and an
// open 9/28 D3 (the -1 link target of the 9/29 C2). Dates: 2026-09-28 Mon.
function hussainCtx(
  seedOver: Partial<SeedAssignment> = {},
  ctxOver: Partial<GenerationContext> = {},
): GenerationContext {
  const slots = [
    callSlot('c2-0929', '2026-09-29', 'C2'),
    dSlot('d1-0930', '2026-09-30', 'D1'),
    dSlot('d3-0928', '2026-09-28', 'D3'),
  ];
  return buildCtx(slots, [prov('hussain')], {
    seedAssignments: [staleD3Seed(seedOver), committedC2Seed()],
    shiftTypes: SHIFT_TYPES,
    ...ctxOver,
  });
}

describe('solve — stale auto-generated pre-fill seed is evicted by the post-call chain', () => {
  it('exact Hussain repro: 9/29 C2 fills, D1 overrides the stale D3 seed, eviction reported', () => {
    const plan = solve(hussainCtx());

    // The open 9/29 C2 goes to Hussain (the repro's run-2 placement).
    expect(plan.assignments.find(a => a.slot_id === 'c2-0929')?.provider_id).toBe('hussain');

    // The +1 D1 chain FILLS 9/30 (Gabriel 2026-07-19: D1 overrides pre-call
    // status) instead of skipping on his own stale D3 seed.
    const d1 = plan.assignments.find(a => a.slot_id === 'd1-0930');
    expect(d1?.provider_id).toBe('hussain');
    expect(d1?.source).toBe('d-chain');
    expect(plan.skippedDerived).not.toContainEqual(
      expect.objectContaining({ date: '2026-09-30', code: 'D1' }));

    // The eviction is RECORDED on the plan (invariant-4 spirit: never silent).
    expect(plan.evictions).toEqual([{
      date: '2026-09-30', code: 'D3',
      provider_id: 'hussain', provider_name: 'hussain',
      slot_id: 'slot-d3-0930', assignment_id: 'a-d3-0930',
      trigger_date: '2026-09-29', trigger_code: 'C2',
    }]);

    // The vacated D3 slot has no valid person (its designated person is
    // consumed by the D1 override): never backfilled, never counted unfilled —
    // the eviction record IS its report.
    expect(plan.assignments.some(a => a.slot_id === 'slot-d3-0930')).toBe(false);
    expect(plan.unfilled.some(u => u.slot_id === 'slot-d3-0930')).toBe(false);

    // The -1 link of the 9/29 C2 still pre-fills 9/28 D3 normally.
    expect(plan.assignments.find(a => a.slot_id === 'd3-0928')?.provider_id).toBe('hussain');
  });

  it('evicts under the degraded (no ctx.shiftTypes) category ranking too', () => {
    const plan = solve(hussainCtx({}, { shiftTypes: undefined }));
    expect(plan.assignments.find(a => a.slot_id === 'd1-0930')?.provider_id).toBe('hussain');
    expect(plan.evictions).toHaveLength(1);
    expect(plan.evictions![0]).toMatchObject({ code: 'D3', slot_id: 'slot-d3-0930' });
  });

  it('net-zero workday credit: the D1 re-credits the evicted seed date (no double count)', () => {
    const workingDaySet = new Set(['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01']);
    const budget: WorkDayBudget = {
      workingDays: 4, workingDaySet, majorHolidayDates: new Set(),
      byProvider: new Map([['hussain', {
        fte: 1, workingDays: 4, ptoWeekdays: 0, required: 4, entitledOff: 0,
      }]]),
    };
    const plan = solve(hussainCtx({}, { workDayBudget: budget }));
    // With required exactly 4, every placement lands ONLY if 9/30 nets to one
    // credit (seeded D3 credit released ≡ D1 re-credit). A double count would
    // cap out the last weekday fill.
    expect(plan.assignments.map(a => a.slot_id).sort())
      .toEqual(['c2-0929', 'd1-0930', 'd3-0928']);
    expect(plan.evictions).toHaveLength(1);
  });

  it('optimizer trial re-solves keep the eviction (deterministic; monotone fills)', () => {
    const { plan } = optimize(hussainCtx());
    expect(plan.assignments.find(a => a.slot_id === 'd1-0930')?.provider_id).toBe('hussain');
    expect(plan.evictions).toEqual([expect.objectContaining({
      code: 'D3', slot_id: 'slot-d3-0930', assignment_id: 'a-d3-0930',
    })]);
  });
});

describe('solve — seeds that must NOT be evicted', () => {
  const expectSkippedNotEvicted = (plan: ReturnType<typeof solve>) => {
    // Pre-fix behavior, byte for byte: the D1 chain skip is recorded and the
    // slot stays open; no eviction happens.
    expect(plan.evictions).toBeUndefined();
    expect(plan.assignments.some(a => a.slot_id === 'd1-0930')).toBe(false);
    expect(plan.skippedDerived).toContainEqual(
      { date: '2026-09-30', code: 'D1', provider_id: 'hussain', reason: 'occupied' });
  };

  it('a MANUAL seed is never evicted (chain skip recorded as today)', () => {
    expectSkippedNotEvicted(solve(hussainCtx({ source_type: 'manual' })));
  });

  it('a manually_overridden seed is never evicted', () => {
    expectSkippedNotEvicted(solve(hussainCtx({ source_type: 'manually_overridden' })));
  });

  it('a seed from ANOTHER schedule version is never evicted', () => {
    expectSkippedNotEvicted(solve(hussainCtx({ schedule_version_id: 'v-other' })));
  });

  it('a seed whose code is not a pattern pre-fill (e.g. D9) is never evicted', () => {
    expectSkippedNotEvicted(solve(hussainCtx({ shift_type_code: 'D9' })));
  });

  it('a bare seed without eviction provenance (fixture-shaped) is never evicted', () => {
    expectSkippedNotEvicted(solve(hussainCtx({
      slot_id: undefined, assignment_id: undefined,
      source_type: undefined, schedule_version_id: undefined,
    })));
  });

  it('an IN-PLAN same-run pre-fill is never EVICTED — the post-call repair RELOCATES instead', () => {
    // Single run, no seeds: C2 10/1 fills first and pre-fills 9/30 D3 in-plan;
    // the later 9/29 C2's +1 D1 then finds 9/30 taken by the SAME RUN's D3.
    // The seed-eviction path still refuses — a live placement is not a stale
    // seed, and nothing is evicted (plan.evictions stays undefined, and the
    // skip is still recorded at placement time, invariant 4).
    //
    // UPDATED 2026-07-29. What the run no longer ENDS with is hussain in D3
    // and D1 empty. That was the shape Gabriel reported on the live board
    // ("if there are two linked D spots for one provider, obviously the lower
    // one should have priority"), and it contradicted the project's own
    // standing rule that a post-call fill overrides pre-call status. The
    // post-call repair pass moves him — same provider, same date, same day's
    // work — into the D1 his 9/29 C2 declared, and frees the D3.
    const slots = [
      callSlot('c2-1001', '2026-10-01', 'C2'),
      callSlot('c2-0929', '2026-09-29', 'C2'),
      dSlot('d3-0930', '2026-09-30', 'D3'),
      dSlot('d1-0930', '2026-09-30', 'D1'),
    ];
    const plan = solve(buildCtx(slots, [prov('hussain')], { shiftTypes: SHIFT_TYPES }));
    // No EVICTION happened — that machinery is still seeds-only.
    expect(plan.evictions).toBeUndefined();
    // The placement-time skip is still recorded.
    expect(plan.skippedDerived).toContainEqual(
      { date: '2026-09-30', code: 'D1', provider_id: 'hussain', reason: 'occupied' });
    // …and the repair pass then put him where the pattern asked.
    expect(plan.assignments.find(a => a.slot_id === 'd1-0930')?.provider_id).toBe('hussain');
    expect(plan.assignments.some(a => a.slot_id === 'd3-0930')).toBe(false);
    expect(plan.postCallRepairs).toEqual([{
      date: '2026-09-30', provider_id: 'hussain', provider_name: 'hussain',
      from_code: 'D3', to_code: 'D1',
      trigger_date: '2026-09-29', trigger_code: 'C2',
    }]);
  });
});

// ── the shared predicate (single home for engine + sequenceAutoFill) ────────

describe('preFillEviction — shared predicate', () => {
  const rank = (st: Parameters<typeof shiftRank>[0]) => shiftRank(st);
  const evictable = preFillCodes(CLASSIC_PATTERN);
  const occupant = (over: Record<string, unknown> = {}) => ({
    source_type: 'auto_generated' as string | undefined,
    same_version: true,
    st: { code: 'D3', category: 'regular' },
    ...over,
  });
  const C2_RANK = shiftRank({ code: 'C2', category: 'call', call_rank: 1 });

  it('classic pattern pre-fill codes are the negative-offset link codes', () => {
    expect([...evictable].sort()).toEqual(['D2', 'D3']);
  });

  it('a realized-call trigger evicts a same-version auto-generated pre-fill', () => {
    expect(mayEvictPreFill(C2_RANK, occupant(), evictable, rank)).toBe(true);
  });

  it('never evicts manual or manually_overridden rows', () => {
    expect(mayEvictPreFill(C2_RANK, occupant({ source_type: 'manual' }), evictable, rank)).toBe(false);
    expect(mayEvictPreFill(C2_RANK, occupant({ source_type: 'manually_overridden' }), evictable, rank)).toBe(false);
    expect(mayEvictPreFill(C2_RANK, occupant({ source_type: undefined }), evictable, rank)).toBe(false);
  });

  it('never crosses schedule versions', () => {
    expect(mayEvictPreFill(C2_RANK, occupant({ same_version: false }), evictable, rank)).toBe(false);
  });

  it('never evicts a call-category occupant', () => {
    expect(mayEvictPreFill(C2_RANK, occupant({
      st: { code: 'C1', category: 'call', call_rank: 0 },
    }), evictable, rank)).toBe(false);
  });

  it('only pattern pre-fill codes are evictable', () => {
    expect(mayEvictPreFill(C2_RANK, occupant({ st: { code: 'D9', category: 'regular' } }), evictable, rank)).toBe(false);
    expect(mayEvictPreFill(C2_RANK, occupant({ st: null }), evictable, rank)).toBe(false);
  });

  it('an occupant that outranks the incoming fill survives; ties go to post-call', () => {
    // Occupant ranks strictly better (lower) than the incoming fill → keep it.
    const strongOccupant = occupant({ st: { code: 'D3', category: 'regular', call_rank: 0 } });
    expect(mayEvictPreFill(C2_RANK, strongOccupant, evictable, rank)).toBe(false);
    // Tie → the post-call side wins (the old hard-coded D1-beats-D3).
    const tie = occupant({ st: { code: 'D3', category: 'regular' } });
    expect(mayEvictPreFill(shiftRank({ code: 'D1', category: 'regular' }), tie, evictable, rank)).toBe(true);
  });

  it('degraded ranking (missing rank columns): calls outrank non-calls', () => {
    const degradedRank = (st: Parameters<typeof shiftRank>[0]) => shiftRank(st, true);
    expect(shiftRank({ code: 'C2', category: 'call' }, true)).toBe(0);
    expect(mayEvictPreFill(0, occupant(), evictable, degradedRank)).toBe(true);
  });
});
