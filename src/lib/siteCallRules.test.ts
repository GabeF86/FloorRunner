/**
 * Site call rules, par and the roster behind them.
 *
 * The thing worth pinning is the FRAMING of the par gap: par is authoritative
 * and a pool below it is by design, so the page must report the size of the
 * pickup layer without calling the configuration broken.
 */
import { describe, it, expect } from 'vitest';
import { siteCallRules, type RuleShiftTypeRow, type RuleProfileRow } from './siteCallRules';
import { CallPatternDocSchema, CLASSIC_PATTERN, type CallPatternDoc } from './rulesEngine/callPattern';

const PAOLI = 'paoli';
const ASC = 'asc';

const NEURO_PATTERN: CallPatternDoc = CallPatternDocSchema.parse({
  ...CLASSIC_PATTERN,
  neuroWeekend: { code: 'C3', requirementBands: [{ minFte: 0, units: 1 }] },
});

const callType = (
  site: string, code: string, rank: number, extra: Partial<RuleShiftTypeRow> = {},
): RuleShiftTypeRow =>
  ({ site_id: site, code, category: 'call', call_rank: rank, is_active: true, ...extra });

const taker = (id: string, site: string, fte: number | string): RuleProfileRow =>
  ({ provider_id: id, home_site_id: site, call_taker: true, fte_value: fte });

const PAOLI_TYPES = [
  callType(PAOLI, 'C1', 0),
  callType(PAOLI, 'C2', 1),
  callType(PAOLI, 'C3', 2),
  // Split segments — pieces of C1, not calls of their own.
  callType(PAOLI, 'C1N12', 0, { parent_call_code: 'C1' }),
  callType(PAOLI, 'C1D12', 0, { parent_call_code: 'C1' }),
  { site_id: PAOLI, code: '7-3', category: 'regular', is_active: true },
];

const run = (opts: {
  par?: number | null;
  types?: RuleShiftTypeRow[];
  profiles?: RuleProfileRow[];
  doc?: CallPatternDoc | null;
}) => siteCallRules({
  sites: [{ id: PAOLI, name: 'Paoli Hospital', short_name: 'PH',
            call_par_level: opts.par === undefined ? 11 : opts.par }],
  shiftTypes: opts.types ?? PAOLI_TYPES,
  profiles: opts.profiles ?? [],
  patterns: new Map([[PAOLI, opts.doc === undefined ? NEURO_PATTERN : opts.doc]]),
})[0];

describe('the call structure line', () => {
  it('names the weekday tiers and lifts neuro out as a weekend service', () => {
    expect(run({}).structure).toBe('C1 + C2 + Sat/Sun C3 neuro');
  });

  it('leaves SPLIT SEGMENTS out — they are pieces of a call, not calls', () => {
    // Paoli stores eleven split codes beside C1/C2. Listing them turns a
    // readable line into a wall.
    expect(run({}).structure).not.toContain('C1N12');
  });

  it('ignores day shifts', () => {
    expect(run({}).structure).not.toContain('7-3');
  });

  it('says so plainly when a site runs no call', () => {
    expect(run({ types: [{ site_id: PAOLI, code: '7-3', category: 'regular', is_active: true }] })
      .structure).toBe('No overnight call');
  });

  it('drops a retired call code', () => {
    expect(run({ types: [...PAOLI_TYPES, callType(PAOLI, 'C4', 3, { is_active: false })] })
      .structure).not.toContain('C4');
  });

  it('keeps the neuro code in the list when the site states no neuro weekend', () => {
    // Without a stated neuroWeekend there is nothing to lift out, and silently
    // dropping C3 would under-report the site's call.
    expect(run({ doc: null }).structure).toBe('C1 + C2 + C3');
  });
});

describe('the call pool behind the par', () => {
  it('sums home-site call takers only', () => {
    const r = run({ profiles: [
      taker('a', PAOLI, 1), taker('b', PAOLI, 0.75),
      // A day doc at the same site owes no call and must not inflate the pool.
      { provider_id: 'c', home_site_id: PAOLI, call_taker: false, fte_value: 1 },
      // A call taker whose home is elsewhere.
      taker('d', ASC, 1),
    ] });
    expect(r).toMatchObject({ poolFte: 1.75, poolCount: 2 });
  });

  it('counts a PARTIAL call taker', () => {
    const r = run({ profiles: [
      { provider_id: 'a', home_site_id: PAOLI, partial_call_taker: true, fte_value: 0.5 },
    ] });
    expect(r.poolCount).toBe(1);
  });

  it('reads an FTE that arrives as a STRING', () => {
    // PostgREST hands numerics back as strings or numbers depending on the
    // driver — a trap this codebase has hit before.
    expect(run({ profiles: [taker('a', PAOLI, '0.70')] }).poolFte).toBe(0.7);
  });

  it('coerces a missing FTE to 1, exactly as the engine does', () => {
    expect(run({ profiles: [taker('a', PAOLI, null as never)] }).poolFte).toBe(1);
  });
});

describe('the par gap', () => {
  it('reports the gap as the PAID-PICKUP layer, not as a misconfiguration', () => {
    // Par is authoritative (2026-07-24). A pool below it under-covers the
    // schedule BY DESIGN, and the wording has to say that or a reader will
    // "fix" the par.
    const r = run({ par: 11, profiles: [taker('a', PAOLI, 1), taker('b', PAOLI, 0.7)] });
    expect(r.parGap).toBe(9.3);
    expect(r.flagged).toBe(true);
    expect(r.flagNote).toContain('paid-pickup layer');
    expect(r.flagNote).not.toMatch(/error|invalid|wrong|misconfigur/i);
  });

  it('says the opposite thing when the pool is LARGER than the par', () => {
    const profiles = Array.from({ length: 13 }, (_, i) => taker(`p${i}`, PAOLI, 1));
    const r = run({ par: 11, profiles });
    expect(r.parGap).toBe(-2);
    expect(r.flagNote).toContain('LARGER');
  });

  it('stays quiet when par and roster agree', () => {
    const profiles = Array.from({ length: 11 }, (_, i) => taker(`p${i}`, PAOLI, 1));
    expect(run({ par: 11, profiles })).toMatchObject({ parGap: 0, flagged: false, flagNote: '' });
  });

  it('does not flag float noise', () => {
    // 0.7 × 10 is 6.999999999999999 in IEEE754. A gap of 4.000000000000001
    // versus 4 is not a staffing story, but a raw compare would print one.
    const profiles = Array.from({ length: 10 }, (_, i) => taker(`p${i}`, PAOLI, 0.7));
    const r = run({ par: 7, profiles });
    expect(r.poolFte).toBe(7);
    expect(r.flagged).toBe(false);
  });

  it('flags a MISSING par, because the engine then silently uses 12', () => {
    const r = run({ par: null, profiles: [taker('a', PAOLI, 1)] });
    expect(r.parLevel).toBeNull();
    expect(r.flagged).toBe(true);
    expect(r.flagNote).toContain('default of 12');
  });

  it('flags a call site with nobody homed at it', () => {
    expect(run({ par: 11, profiles: [] }).flagNote).toContain('no provider lists it as their home');
  });

  it('never flags a site that runs no call', () => {
    // An ASC with no overnight call has no par story to tell, and a red mark
    // beside it would train people to ignore the column.
    const r = siteCallRules({
      sites: [{ id: ASC, name: 'Orthopedic Surgical', call_par_level: 12 }],
      shiftTypes: [{ site_id: ASC, code: '7-3', category: 'regular', is_active: true }],
      profiles: [],
      patterns: new Map(),
    })[0];
    expect(r).toMatchObject({ structure: 'No overnight call', flagged: false });
  });
});

describe('NOT CONFIGURED is a different claim from NO OVERNIGHT CALL', () => {
  const bare = (profiles: RuleProfileRow[]) => siteCallRules({
    sites: [{ id: 'riddle', name: 'Riddle Hospital', call_par_level: 12 }],
    shiftTypes: [],          // six of the eight live sites are in exactly this state
    profiles,
    patterns: new Map(),
  })[0];

  it('says "Not configured" for a site with NO shift types at all', () => {
    // Riddle runs call every night and has twelve call takers homed there. It
    // simply has nothing entered. "No overnight call" beside it would state
    // the opposite of the truth, in the confident voice of a fact.
    expect(bare([]).structure).toBe('Not configured');
    expect(bare([]).configured).toBe(false);
  });

  it('flags an unconfigured site that people are actually homed at', () => {
    const r = bare([taker('a', 'riddle', 1), taker('b', 'riddle', 0.5)]);
    expect(r.flagged).toBe(true);
    expect(r.flagNote).toContain('no shift types entered');
    expect(r.flagNote).toContain('2 call takers are homed here');
  });

  it('does NOT flag an unconfigured site with nobody homed at it', () => {
    // Riddle Surgery Center: two people homed, neither a call taker. Nothing
    // to say, so nothing is said.
    expect(bare([]).flagged).toBe(false);
  });

  it('never reports a par gap for a site that has nothing configured', () => {
    // A 12-vs-0 gap here is not a pickup layer, it is an empty table.
    expect(bare([]).flagNote).not.toContain('pickup');
  });

  it('still says "No overnight call" when the site HAS shift types, none of them call', () => {
    const r = siteCallRules({
      sites: [{ id: 'asc', name: 'Orthopedic Surgical', call_par_level: 12 }],
      shiftTypes: [{ site_id: 'asc', code: '7-3', category: 'regular', is_active: true }],
      profiles: [], patterns: new Map(),
    })[0];
    expect(r).toMatchObject({ structure: 'No overnight call', configured: true, flagged: false });
  });
});
