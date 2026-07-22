import { describe, it, expect, vi, beforeEach } from 'vitest';
import { autoGenerate, resolveFillMode } from './autoGenerate';
import { buildCtx, prov, callSlot, dSlot, shiftInfo } from './__fixtures__/buildContext';
import type { GenerationContext, ShiftTypeInfo } from './genTypes';

// ── resolveFillMode (pure) ───────────────────────────────────────────────────

describe('resolveFillMode', () => {
  it("defaults to 'all' when unset", () => {
    expect(resolveFillMode(undefined)).toBe('all');
  });
  it("accepts the exact string 'obligatory'", () => {
    expect(resolveFillMode('obligatory')).toBe('obligatory');
  });
  it("accepts the exact string 'weekend-only'", () => {
    expect(resolveFillMode('weekend-only')).toBe('weekend-only');
  });
  it("any other value degrades to 'all'", () => {
    expect(resolveFillMode('all')).toBe('all');
    expect(resolveFillMode('OBLIGATORY')).toBe('all');
    expect(resolveFillMode('WEEKEND-ONLY')).toBe('all');
    expect(resolveFillMode('weekend')).toBe('all');
    expect(resolveFillMode(5)).toBe('all');
    expect(resolveFillMode(null)).toBe('all');
    expect(resolveFillMode({})).toBe('all');
  });
});

// ── fill-mode threading through autoGenerate ────────────────────────────────
// Injected fakes for the I/O edges (genContext load, commit, optimize);
// solve() runs for real so the fillMode actually reaching it is observable.

const holder = vi.hoisted(() => ({
  ctx: null as unknown,
  optimizeCalls: 0,
}));

vi.mock('./genContext', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadGenerationContext: async () => ({ ctx: holder.ctx, dbQueries: 0, totalSlots: 1 }),
}));
vi.mock('./optimize', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  optimize: () => {
    holder.optimizeCalls++;
    return {
      plan: { assignments: [], unfilled: [], skippedDerived: [], chainAnchorSlotIds: [] },
      stats: { resolves: 0, gatedSkips: 0, wallMs: 0 },
    };
  },
}));
vi.mock('./commit', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  commitPlan: async () => ({ filled: 0, evicted: 0, errors: [], dbQueries: 0 }),
  commitValidation: async () => ({ dbQueries: 0, errors: [] }),
  hasGenerationMetadataColumn: async () => false,
}));

// One weekday C1 slot with a quota-blocked (NOT cap-blocked) provider:
// fill-all relaxes and fills; obligatory leaves it open — a fill-mode litmus.
function quotaBlockedCtx(): GenerationContext {
  return buildCtx([callSlot('mon', '2026-01-05', 'C1')], [prov('p1')], {
    bucketTarget: new Map([['p1|weekday|C1', 0]]),
  });
}

beforeEach(() => {
  holder.ctx = quotaBlockedCtx();
  holder.optimizeCalls = 0;
});

describe('autoGenerate — fillMode threading', () => {
  it('default mode optimizes and relaxes the quota (control)', async () => {
    const result = await autoGenerate({}, 'ver-1');
    expect(result.ok).toBe(true);
    expect(holder.optimizeCalls).toBe(1);
    // seedMetrics reflect the REAL greedy solve: relaxation filled the slot.
    expect(result.seedMetrics?.filled).toBe(1);
  });

  it("fillMode 'obligatory' skips the optimizer entirely", async () => {
    const result = await autoGenerate({}, 'ver-1', { fillMode: 'obligatory' });
    expect(result.ok).toBe(true);
    expect(holder.optimizeCalls).toBe(0);
    expect(result.optimizeStats).toBeUndefined();
  });

  it("fillMode 'obligatory' reaches solve(): the quota-blocked slot stays open", async () => {
    const result = await autoGenerate({}, 'ver-1', { fillMode: 'obligatory' });
    expect(result.assignments).toHaveLength(0);
    expect(result.unfilled).toHaveLength(1);
    expect(result.unfilled[0].reason).toBe('No eligible providers');
    expect(result.unfilled[0].candidates?.[0]?.reason).toBe('bucket-quota');
  });

  it("explicit fillMode 'all' behaves exactly like the default", async () => {
    const result = await autoGenerate({}, 'ver-1', { fillMode: 'all' });
    expect(result.ok).toBe(true);
    expect(holder.optimizeCalls).toBe(1);
    expect(result.seedMetrics?.filled).toBe(1);
  });

  it("fillMode 'weekend-only' skips the optimizer (partial plans aren't optimized)", async () => {
    const result = await autoGenerate({}, 'ver-1', { fillMode: 'weekend-only' });
    expect(result.ok).toBe(true);
    expect(holder.optimizeCalls).toBe(0);
    expect(result.optimizeStats).toBeUndefined();
  });

  it("fillMode 'weekend-only' surfaces awaitingContinue (total + day-type breakdown), not unfilled", async () => {
    // The fixture's only slot is a weekday C1 — out of weekend scope.
    const result = await autoGenerate({}, 'ver-1', { fillMode: 'weekend-only' });
    expect(result.assignments).toHaveLength(0);
    expect(result.unfilled).toHaveLength(0);
    expect(result.skipped).toBe(0);
    expect(result.awaitingContinue).toEqual({ total: 1, byDayType: { weekday: 1 } });
  });

  it("other modes carry no awaitingContinue key", async () => {
    const result = await autoGenerate({}, 'ver-1', { fillMode: 'all' });
    expect(result.awaitingContinue).toBeUndefined();
  });

  it('a plan without evictions surfaces an empty evictions list', async () => {
    const result = await autoGenerate({}, 'ver-1', { optimize: false });
    expect(result.evictions).toEqual([]);
  });

  it('surfaces plan.evictions on the generation result (alongside skippedDerived)', async () => {
    // Minimal Hussain repro (see seedEviction.test.ts): a stale auto-generated
    // D3 seed on the +1 D1 chain day of the still-open 9/29 C2.
    holder.ctx = buildCtx(
      [callSlot('c2-0929', '2026-09-29', 'C2'), dSlot('d1-0930', '2026-09-30', 'D1')],
      [prov('hussain')],
      {
        seedAssignments: [
          {
            slot_date: '2026-09-30', provider_id: 'hussain',
            shift_type_code: 'D3', shift_type_category: 'regular', derived_day_type: 'weekday',
            slot_id: 'slot-d3-0930', assignment_id: 'a-d3-0930',
            source_type: 'auto_generated', schedule_version_id: 'v1',
          },
          {
            slot_date: '2026-10-01', provider_id: 'hussain',
            shift_type_code: 'C2', shift_type_category: 'call', derived_day_type: 'weekday',
            slot_id: 'slot-c2-1001', assignment_id: 'a-c2-1001',
            source_type: 'auto_generated', schedule_version_id: 'v1',
          },
        ],
        shiftTypes: new Map<string, ShiftTypeInfo>([
          ['C2', shiftInfo('C2', { category: 'call', call_rank: 1, generation_engine: 'call' })],
          ['D1', shiftInfo('D1', { generation_engine: 'call' })],
          ['D3', shiftInfo('D3', { generation_engine: 'call' })],
        ]),
      },
    );
    const result = await autoGenerate({}, 'ver-1', { optimize: false });
    expect(result.ok).toBe(true);
    expect(result.evictions).toEqual([expect.objectContaining({
      date: '2026-09-30', code: 'D3',
      slot_id: 'slot-d3-0930', assignment_id: 'a-d3-0930',
    })]);
  });
});
