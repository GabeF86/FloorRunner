import { describe, it, expect, vi, beforeEach } from 'vitest';
import { autoGenerate, resolveFillMode } from './autoGenerate';
import { buildCtx, prov, callSlot } from './__fixtures__/buildContext';
import type { GenerationContext } from './genTypes';

// ── resolveFillMode (pure) ───────────────────────────────────────────────────

describe('resolveFillMode', () => {
  it("defaults to 'all' when unset", () => {
    expect(resolveFillMode(undefined)).toBe('all');
  });
  it("accepts the exact string 'obligatory'", () => {
    expect(resolveFillMode('obligatory')).toBe('obligatory');
  });
  it("any other value degrades to 'all'", () => {
    expect(resolveFillMode('all')).toBe('all');
    expect(resolveFillMode('OBLIGATORY')).toBe('all');
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
  commitPlan: async () => ({ filled: 0, errors: [], dbQueries: 0 }),
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
});
