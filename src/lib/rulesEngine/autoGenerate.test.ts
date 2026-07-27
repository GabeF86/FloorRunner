import { describe, it, expect, vi } from 'vitest';
import { autoGenerate, toResultAssignment, resolveOptimizeEnabled, resolveWallClockMs } from './autoGenerate';
import { CallPatternDocSchema } from './callPattern';
import { buildCtx, prov, callSlot } from './__fixtures__/buildContext';
import type { GenerationContext, PlannedAssignment } from './genTypes';

describe('resolveOptimizeEnabled', () => {
  it('defaults to true when unset', () => {
    expect(resolveOptimizeEnabled(undefined)).toBe(true);
  });
  it('honors an explicit false (disable optimization)', () => {
    expect(resolveOptimizeEnabled(false)).toBe(false);
  });
  it('honors an explicit true', () => {
    expect(resolveOptimizeEnabled(true)).toBe(true);
  });
});

describe('resolveWallClockMs', () => {
  it('prefers an explicit param over the env var', () => {
    expect(resolveWallClockMs(500, '1000')).toBe(500);
  });
  it('falls back to the env var when no param is given', () => {
    expect(resolveWallClockMs(undefined, '1500')).toBe(1500);
  });
  it('returns undefined (optimizer default) when neither is usable', () => {
    expect(resolveWallClockMs(undefined, undefined)).toBeUndefined();
    expect(resolveWallClockMs(undefined, 'not-a-number')).toBeUndefined();
    expect(resolveWallClockMs(-5, undefined)).toBeUndefined();
  });
});

describe('toResultAssignment', () => {
  it('maps a planned assignment to the API shape including explanation + source', () => {
    const pa: PlannedAssignment = {
      slot_id: 's1', slot_date: '2026-01-07', shift_type_code: 'C1',
      shift_type_category: 'call', derived_day_type: 'weekday',
      provider_id: 'p1', provider_name: 'DOCA', existing_assignment_id: null,
      source: 'main-loop',
      explanation: { ratioAtAssignment: 1.5, daysSinceLastCall: 7, competingCandidates: 3 },
    };
    expect(toResultAssignment(pa)).toEqual({
      slot_id: 's1', slot_date: '2026-01-07', shift_type_code: 'C1',
      provider_id: 'p1', provider_name: 'DOCA',
      source: 'main-loop',
      explanation: { ratioAtAssignment: 1.5, daysSinceLastCall: 7, competingCandidates: 3 },
    });
  });
});

// ── neuro weekend report wiring (2026-07-27) ────────────────────────────────
// computeNeuroReport is unit-tested in neuroWeekend.test.ts; these cases prove
// the report is actually POPULATED on a generation result and that its
// shortfall warnings reach result.warnings. I/O edges injected (the
// autoGenerateFillMode idiom); solve() runs for real.

const holder = vi.hoisted(() => ({ ctx: null as unknown }));

vi.mock('./genContext', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadGenerationContext: async () => ({ ctx: holder.ctx, dbQueries: 0, totalSlots: 1 }),
}));
vi.mock('./commit', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  commitPlan: async () => ({ filled: 0, evicted: 0, errors: [], dbQueries: 0 }),
  commitValidation: async () => ({ dbQueries: 0, errors: [] }),
  hasGenerationMetadataColumn: async () => false,
}));

// Paoli's neuro block: 1.0 owes nothing, 0.75 owes a full weekend, below owes
// a single day. No chains — these cases are about the REPORT, not placement.
const NEURO_DOC = CallPatternDocSchema.parse({
  version: 1,
  blocks: [], dayChains: [], spans: [], placementPasses: [],
  reliefPass: null, optimizerMovableDayTypes: [],
  neuroWeekend: {
    code: 'C3',
    requirementBands: [{ minFte: 1, units: 0 }, { minFte: 0.75, units: 1 }, { minFte: 0, units: 0.5 }],
  },
});

const SAT = '2026-08-15';
const SUN = '2026-08-16';

// A lone Sunday C3 and one 0.75 doc: they take it (credited 0.5) but still owe
// half a weekend — a result that is short WITHOUT being trivially empty, so a
// report wired to the wrong source can't accidentally look right.
function loneSundayCtx(over: Partial<GenerationContext> = {}): GenerationContext {
  return buildCtx([callSlot('sun-c3', SUN, 'C3', 'sunday')], [prov('three4', 0.75)],
    { callPattern: NEURO_DOC, warnings: [], ...over });
}

describe('autoGenerate — neuro report wiring', () => {
  it('surfaces neuroReport and a shortfall warning when the pattern states a config', async () => {
    holder.ctx = loneSundayCtx();
    const result = await autoGenerate({} as never, 'ver-1', { optimize: false });
    expect(result.ok).toBe(true);
    // Credit came from a REAL placement, not an empty plan.
    expect(result.assignments.map(a => a.slot_id)).toEqual(['sun-c3']);
    expect(result.neuroReport).toEqual([
      { provider_id: 'three4', fte: 0.75, owed: 1, credited: 0.5, short: 0.5 },
    ]);
    expect(result.warnings).toContain(
      'three4 is short 0.5 of 1 neuro weekend this block (has 0.5).');
  });

  it('a pattern with NO neuroWeekend config carries no neuroReport key (additive shape)', async () => {
    holder.ctx = buildCtx([callSlot('sun-c3', SUN, 'C3', 'sunday')], [prov('three4', 0.75)]);
    const result = await autoGenerate({} as never, 'ver-1', { optimize: false });
    expect(result.ok).toBe(true);
    expect('neuroReport' in result).toBe(false);
    expect(result.warnings.some(w => w.includes('neuro weekend'))).toBe(false);
  });

  it('a satisfied provider produces the report but NO warning', async () => {
    holder.ctx = buildCtx(
      [callSlot('sat-c3', SAT, 'C3', 'saturday'), callSlot('sun-c3', SUN, 'C3', 'sunday')],
      [prov('three4', 0.75)], { callPattern: NEURO_DOC, warnings: [] });
    const result = await autoGenerate({} as never, 'ver-1', { optimize: false });
    expect(result.neuroReport).toEqual([
      { provider_id: 'three4', fte: 0.75, owed: 1, credited: 1, short: 0 },
    ]);
    expect(result.warnings.some(w => w.includes('neuro weekend'))).toBe(false);
  });

  // REGRESSION (deviation from the task plan, which credited plan.assignments
  // only): a Continue ('all') run re-solves only the OPEN slots, so a weekend
  // committed by an earlier weekend-only run arrives as SEEDS and never
  // appears in plan.assignments. Crediting the plan alone would report this
  // satisfied doc as short their whole weekend on the run that finalizes the
  // block — and would contradict the eligibility remainder gate, which reads
  // state.callCodesByDate (seed-populated) for the very same judgement.
  it('counts a neuro weekend that arrives as SEEDS — no false shortfall on a Continue run', async () => {
    const seed = (slot_date: string) => ({
      slot_date, provider_id: 'three4', shift_type_code: 'C3',
      shift_type_category: 'call', derived_day_type: slot_date === SAT ? 'saturday' : 'sunday',
      slot_id: `slot-${slot_date}`, assignment_id: `a-${slot_date}`,
      source_type: 'auto_generated', schedule_version_id: 'v1',
    });
    holder.ctx = buildCtx([], [prov('three4', 0.75)],
      { callPattern: NEURO_DOC, warnings: [], seedAssignments: [seed(SAT), seed(SUN)] });
    const result = await autoGenerate({} as never, 'ver-1', { optimize: false });
    expect(result.ok).toBe(true);
    expect(result.assignments).toEqual([]); // nothing re-solved: credit is seed-only
    expect(result.neuroReport).toEqual([
      { provider_id: 'three4', fte: 0.75, owed: 1, credited: 1, short: 0 },
    ]);
    expect(result.warnings.some(w => w.includes('neuro weekend'))).toBe(false);
  });

  // result.warnings may ALIAS ctx.warnings — the shortfall append must build a
  // NEW array rather than push into the caller's context.
  it('never mutates ctx.warnings when appending shortfall warnings', async () => {
    const ctx = loneSundayCtx();
    holder.ctx = ctx;
    const result = await autoGenerate({} as never, 'ver-1', { optimize: false });
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(ctx.warnings).toEqual([]);
  });
});
