// Per-category obligation accounting in the shared grid/modal census
// (Gabriel 2026-08-03, verbatim: "if someone is above any of their obligatory
// calls, it should show up in the above obligatory column for that specific
// call, regardless if they are missing a different type of call somewhere
// else").
//
// The fixtures are the LIVE 8/10–10/25 Paoli holdings for the providers whose
// rows this rule changes. Every expectation was verified against the real
// block before being written down.
import { describe, it, expect } from 'vitest';
import { computeCallObligationCensus, type CensusSlot, type CensusProfile } from './fteTarget';
import { CallPatternDocSchema, CLASSIC_PATTERN } from './rulesEngine/callPattern';

const SITE = 'site-1';

const PATTERN = CallPatternDocSchema.parse({
  ...CLASSIC_PATTERN,
  blocks: [{ anchorDayType: 'saturday', chains: [
    { trigger: 'C3', links: [{ offset: 1, code: 'C3' }] },
    ...CLASSIC_PATTERN.blocks[0].chains.filter(c => c.trigger !== 'C3'),
  ] }],
  neuroWeekend: { code: 'C3', requirementBands: [{ minFte: 0, units: 1 }] },
  obligations: { bands: [
    { minFte: 1, calls: [
      { dayType: 'weekday', code: 'C1', count: 4 }, { dayType: 'weekday', code: 'C2', count: 4 },
      { dayType: 'friday', code: 'C1', count: 1 }, { dayType: 'friday', code: 'C2', count: 1 },
      { dayType: 'saturday', code: 'C1', count: 1 }, { dayType: 'saturday', code: 'C2', count: 1 },
      { dayType: 'sunday', code: 'C1', count: 1 }, { dayType: 'sunday', code: 'C2', count: 1 } ] },
    { minFte: 0, calls: [
      { dayType: 'weekday', code: 'C1', count: 2 }, { dayType: 'weekday', code: 'C2', count: 2 },
      { dayType: 'saturday', code: 'C1', count: 1.5 },
      { dayType: 'friday', code: 'C2', count: 1 }, { dayType: 'sunday', code: 'C2', count: 1 } ] },
  ] },
});

const profile = (id: string, fte: number): CensusProfile =>
  ({ provider_id: id, home_site_id: SITE, call_taker: true, partial_call_taker: false, fte_value: fte });

/** Build the block's call slate: the live Paoli shape (44/44 weekday, 11 of
 * each weekend bucket, 11 neuro pairs = 176 weighted call slots). `held` maps
 * a bucket key to the provider ids standing those calls, in date order. */
function buildSlots(held: Record<string, string[]>): CensusSlot[] {
  const SLATE: Record<string, number> = {
    'weekday|C1': 44, 'weekday|C2': 44,
    'friday|C1': 11, 'friday|C2': 11,
    'saturday|C1': 11, 'saturday|C2': 11, 'saturday|C3': 11,
    'sunday|C1': 11, 'sunday|C2': 11, 'sunday|C3': 11,
  };
  // One distinct month per day type, one distinct day per slot within it, so
  // dates are well-formed AND strictly ordered inside each bucket — the
  // within-bucket cover uses "latest first" as its tie-break and needs
  // something real to sort on. derived_day_type (not the date's real weekday)
  // is what the census buckets on, so the calendar need not be plausible.
  const MONTH_OF: Record<string, string> = {
    weekday: '01', friday: '02', saturday: '03', sunday: '04',
  };
  const out: CensusSlot[] = [];
  let n = 0;
  for (const [key, count] of Object.entries(SLATE)) {
    const [dayType, code] = key.split('|');
    const takers = held[key] ?? [];
    for (let i = 0; i < count; i++) {
      out.push({
        slot_date: `2026-${MONTH_OF[dayType]}-${String(i + 1).padStart(2, '0')}`,
        derived_day_type: dayType,
        shift_types: { category: 'call', code, call_burden_weight: 1, parent_call_code: null },
        assignments: takers[i] ? [{ id: `a${n++}`, provider_id: takers[i] }] : [],
      });
    }
  }
  return out;
}

const census = (held: Record<string, string[]>, profiles: CensusProfile[], withBands = true) =>
  computeCallObligationCensus({
    storedParLevel: 11,
    siteId: SITE,
    profiles,
    slots: buildSlots(held),
    callPattern: withBands ? PATTERN : null,
  });

describe('Farkas — the case that started this', () => {
  // 5 M–Th C1 (owes 4), 5 M–Th C2 (owes 4), no Sunday C2 (owes 1).
  // 17 held against 16 owed: netted that is ONE extra, per category it is TWO.
  const held = {
    'weekday|C1': ['f', 'f', 'f', 'f', 'f'],
    'weekday|C2': ['f', 'f', 'f', 'f', 'f'],
    'friday|C1': ['f'], 'friday|C2': ['f'],
    'saturday|C1': ['f'], 'saturday|C2': ['f'], 'saturday|C3': ['f'],
    'sunday|C1': ['f'], 'sunday|C3': ['f'],
    // sunday|C2 deliberately empty — he is short one.
  };
  const profiles = [profile('f', 1)];

  it('owes 16 and holds 17', () => {
    const c = census(held, profiles);
    expect(c.obligationFor('f')).toBe(16);
    expect(c.actualCallsFor('f')).toBe(17);
  });

  it('is TWO over per category, not one — the missing Sunday C2 does not cancel', () => {
    expect(census(held, profiles).overageFor('f')).toBeCloseTo(2, 6);
  });

  it('flags one M–Th C1 AND one M–Th C2', () => {
    const c = census(held, profiles);
    const flagged = c.callRecords
      .filter(r => c.overParAssignmentIds.has(r.id))
      .map(r => `${r.bucket}|${r.parent_code}`)
      .sort();
    expect(flagged).toEqual(['weekday|C1', 'weekday|C2']);
  });

  it('the DERIVED formula still nets it to one — the old behavior is intact', () => {
    const c = census(held, profiles, false);
    expect(c.overageFor('f')).toBeCloseTo(1, 6);
    expect(c.callRecords.filter(r => c.overParAssignmentIds.has(r.id))).toHaveLength(1);
  });
});

describe('a provider dead on their total but mal-distributed', () => {
  // V.Lin, live: exactly 16 calls, but a second weekday C2 in place of his
  // Sunday C2. Netted he is not over at all; per category he owes one.
  const held = {
    'weekday|C1': ['v', 'v', 'v', 'v'],
    'weekday|C2': ['v', 'v', 'v', 'v', 'v'],
    'friday|C1': ['v'], 'friday|C2': ['v'],
    'saturday|C1': ['v'], 'saturday|C2': ['v'], 'saturday|C3': ['v'],
    'sunday|C1': ['v'], 'sunday|C3': ['v'],
  };
  const profiles = [profile('v', 1)];

  it('holds exactly its obligation', () => {
    const c = census(held, profiles);
    expect(c.actualCallsFor('v')).toBe(c.obligationFor('v'));
  });

  it('is still 1 over, on the weekday C2 it doubled up', () => {
    const c = census(held, profiles);
    expect(c.overageFor('v')).toBeCloseTo(1, 6);
    const flagged = c.callRecords.filter(r => c.overParAssignmentIds.has(r.id));
    expect(flagged).toHaveLength(1);
    expect(`${flagged[0].bucket}|${flagged[0].parent_code}`).toBe('weekday|C2');
  });

  it('the derived formula reports it clean — this is the behavior change', () => {
    expect(census(held, profiles, false).overageFor('v')).toBe(0);
  });
});

describe('the stated total is exact, never re-rounded', () => {
  // Horan: the 0.5 band totals 9.5 (2+2+1.5+1+1 = 7.5 calls, + 1 neuro unit
  // × 2 calls). roundedObligation would print 10 and invent half a call.
  it('a 0.5 FTE owes exactly 9.5', () => {
    const c = census({}, [profile('h', 0.5)]);
    expect(c.obligationFor('h')).toBe(9.5);
  });

  it('under-filling never produces a negative or an extra', () => {
    const c = census({ 'weekday|C1': ['h'] }, [profile('h', 0.5)]);
    expect(c.overageFor('h')).toBe(0);
    expect(c.overParAssignmentIds.size).toBe(0);
  });
});

describe('non-pool providers and ungoverned codes', () => {
  it('a day doc owes nothing and every call they hold is extra', () => {
    const dayDoc: CensusProfile = {
      provider_id: 'd', home_site_id: SITE, call_taker: false,
      partial_call_taker: false, fte_value: 1,
    };
    const c = census({ 'saturday|C1': ['d'] }, [dayDoc]);
    expect(c.obligationFor('d')).toBe(0);
    expect(c.overageFor('d')).toBeCloseTo(1, 6);
  });

  it('neuro is owed in weekend units — one pair is on target, two is one over', () => {
    const onTarget = census(
      { 'saturday|C3': ['n'], 'sunday|C3': ['n'] }, [profile('n', 1)]);
    expect(onTarget.overageFor('n')).toBe(0);

    const doubled = census(
      { 'saturday|C3': ['n', 'n'], 'sunday|C3': ['n'] }, [profile('n', 1)]);
    expect(doubled.overageFor('n')).toBeCloseTo(1, 6);
  });
});

describe('no bands = byte-identical to the derived census', () => {
  it('every reported number matches when the pattern states none', () => {
    const held = { 'weekday|C1': ['a', 'a', 'a', 'a', 'a'], 'sunday|C1': ['a'] };
    const profiles = [profile('a', 1)];
    const withNull = census(held, profiles, false);
    const withClassic = computeCallObligationCensus({
      storedParLevel: 11, siteId: SITE, profiles, slots: buildSlots(held),
      callPattern: CallPatternDocSchema.parse(CLASSIC_PATTERN),
    });
    expect(withClassic.obligationFor('a')).toBe(withNull.obligationFor('a'));
    expect(withClassic.overageFor('a')).toBe(withNull.overageFor('a'));
    expect([...withClassic.overParAssignmentIds].sort())
      .toEqual([...withNull.overParAssignmentIds].sort());
  });
});
