// autoGenerate scenario wiring (Paoli phase 2): a ctx carrying a scenario
// takes the MULTI-START path in fill-all and surfaces scenarioReport;
// scenario-free generations keep the single-run path with NO new result key.
// I/O edges are injected (the autoGenerateFillMode idiom); solve/multiStart
// run for real.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { autoGenerate } from './autoGenerate';
import { buildCtx, prov, callSlot } from './__fixtures__/buildContext';
import { sp, scen } from './__fixtures__/scenarioFixtures';
import type { GenerationContext } from './genTypes';

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

function scenarioCtx(): GenerationContext {
  return buildCtx(
    [callSlot('mon', '2026-08-10', 'C1', 'weekday'), callSlot('wed', '2026-08-12', 'C1', 'weekday')],
    [prov('p1'), prov('p2')],
    {
      scenario: scen([
        sp('p1', { targets: new Map([['MTH|C1', 1]]) }),
        sp('p2', { targets: new Map([['MTH|C1', 1]]) }),
      ]),
    },
  );
}

describe('autoGenerate — scenario multi-start wiring', () => {
  beforeEach(() => { holder.ctx = null; });

  it('scenario + fill-all runs multi-start (K threads through) and surfaces scenarioReport', async () => {
    holder.ctx = scenarioCtx();
    const result = await autoGenerate({} as never, 'ver1', { optimize: false, multiStartK: 2 });
    expect(result.ok).toBe(true);
    expect(result.scenarioReport).toBeTruthy();
    expect(result.scenarioReport!.multiStart).toMatchObject({ k: 2 });
    expect(result.scenarioReport!.multiStart!.starts).toHaveLength(2);
    expect(result.scenarioReport!.providers.map(p => p.provider_id).sort()).toEqual(['p1', 'p2']);
    // The stated 1+1 targets place one C1 each — variance 0 on the score.
    expect(result.scenarioReport!.score[0]).toBe(0);
  });

  it('a scenario-free generation has NO scenarioReport key (additive result shape)', async () => {
    holder.ctx = buildCtx(
      [callSlot('mon', '2026-08-10', 'C1', 'weekday')],
      [prov('p1')],
    );
    const result = await autoGenerate({} as never, 'ver1', { optimize: false });
    expect(result.ok).toBe(true);
    expect('scenarioReport' in result).toBe(false);
  });

  it('a scenario NON-fill-all run keeps the single greedy path but still reports (no multiStart block)', async () => {
    holder.ctx = scenarioCtx();
    const result = await autoGenerate({} as never, 'ver1', { optimize: false, fillMode: 'obligatory' });
    expect(result.ok).toBe(true);
    expect(result.scenarioReport).toBeTruthy();
    expect(result.scenarioReport!.multiStart).toBeNull();
  });
});
