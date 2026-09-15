/**
 * The generation contract, described in English.
 *
 * These tests matter more than most UI tests: this page's entire value is that
 * a chief can trust it. A sentence that says the engine does something it does
 * not is worse than no page, because it would be believed.
 */
import { describe, it, expect } from 'vitest';
import { describeSchedulingLogic, offsetLabel, listOf, type ShiftTypeFacts } from './schedulingLogic';
import { CLASSIC_PATTERN, type CallPatternDoc } from './rulesEngine/callPattern';

const section = (doc: CallPatternDoc, key: string, shiftTypes: ShiftTypeFacts[] = [], par: number | null = 11) =>
  describeSchedulingLogic({ doc, shiftTypes, parLevel: par }).find(s => s.key === key)!;

const textOf = (doc: CallPatternDoc, key: string, st: ShiftTypeFacts[] = [], par: number | null = 11) =>
  section(doc, key, st, par).statements.map(s => s.text);

describe('offsetLabel', () => {
  it('names the actual day when the anchor is a real weekday', () => {
    // This is the whole reason Paoli's weekend chain is readable: an offset of
    // -1 from Saturday is Friday, not "1 day earlier".
    expect(offsetLabel('saturday', -1)).toBe('Friday');
    expect(offsetLabel('saturday', 1)).toBe('Sunday');
    expect(offsetLabel('friday', 2)).toBe('Sunday');
    expect(offsetLabel('sunday', -1)).toBe('Saturday');
  });

  it('wraps across the week boundary', () => {
    expect(offsetLabel('saturday', 2)).toBe('Monday');
    expect(offsetLabel('sunday', -2)).toBe('Friday');
  });

  it('stays RELATIVE when the anchor is not one day', () => {
    // 'weekday' covers Mon-Thu, so "+1 from a weekday" has no single name.
    // Inventing one would be a lie dressed as helpfulness.
    expect(offsetLabel('weekday', 1)).toBe('1 day later');
    expect(offsetLabel('weekday', -2)).toBe('2 days earlier');
    expect(offsetLabel('major_holiday', 1)).toBe('1 day later');
  });

  it('handles the same day', () => {
    expect(offsetLabel('saturday', 0)).toBe('the same day');
  });
});

describe('listOf', () => {
  it('reads as a sentence', () => {
    expect(listOf(['A'])).toBe('A');
    expect(listOf(['A', 'B'])).toBe('A and B');
    expect(listOf(['A', 'B', 'C'])).toBe('A, B and C');
  });

  it('says "nothing" rather than producing an empty gap', () => {
    expect(listOf([])).toBe('nothing');
  });
});

describe('call chains', () => {
  it('describes a weekend chain the way it is spoken about', () => {
    const doc = {
      ...CLASSIC_PATTERN,
      blocks: [{
        anchorDayType: 'saturday' as const,
        chains: [{ trigger: 'C2', links: [{ code: 'C2', offset: -1 }, { code: 'C1', offset: 1 }] }],
      }],
    };
    expect(textOf(doc, 'chains')).toEqual([
      'Saturday C2 — the same provider also takes C2 on Friday and C1 on Sunday.',
    ]);
  });

  it('spells out an FTE floor on a link', () => {
    // Paoli's Sat C3 → Sun C3 pair is for 0.75+ providers; below that the
    // partner slot becomes a remainder. A reader must be able to see that.
    const doc = {
      ...CLASSIC_PATTERN,
      blocks: [{
        anchorDayType: 'saturday' as const,
        chains: [{ trigger: 'C3', links: [{ code: 'C3', offset: 1, minFte: 0.75 }] }],
      }],
    };
    expect(textOf(doc, 'chains')[0])
      .toBe('Saturday C3 — the same provider also takes C3 on Sunday — but only for providers at 0.75 FTE or above.');
  });

  it('does NOT invent a condition for minFte 0', () => {
    // minFte: 0 is behaviourally identical to omitting it, so a clause
    // implying a threshold would describe a rule that does not exist.
    const doc = {
      ...CLASSIC_PATTERN,
      blocks: [{
        anchorDayType: 'saturday' as const,
        chains: [{ trigger: 'C1', links: [{ code: 'C2', offset: 1, minFte: 0 }] }],
      }],
    };
    expect(textOf(doc, 'chains')[0]).not.toContain('FTE');
  });

  it('explains an absent chain instead of printing nothing', () => {
    const s = section({ ...CLASSIC_PATTERN, blocks: [] }, 'chains');
    expect(s.statements).toHaveLength(0);
    expect(s.emptyNote).toContain('filled independently');
  });
});

describe('post-call rest', () => {
  const types: ShiftTypeFacts[] = [
    { code: 'C1', category: 'call', requires_post_call_rule: true },
    { code: 'C1N8', category: 'call', requires_post_call_rule: true },
    { code: 'C2', category: 'call', requires_post_call_rule: false },
    { code: 'C3', category: 'call', requires_post_call_rule: false },
    { code: '7-3', category: 'regular', requires_post_call_rule: false },
  ];

  it('names which codes force a day off and which do not', () => {
    const lines = textOf(CLASSIC_PATTERN, 'rest', types);
    expect(lines[0]).toContain('Working C1 and C1N8 forces the next day off');
    expect(lines[1]).toContain('C2 and C3 do not force a day off');
  });

  it('says the rest holds for MANUAL assignments too', () => {
    // The part a chief most needs to know, and the one an editor could
    // otherwise assume applies only to generated schedules.
    expect(textOf(CLASSIC_PATTERN, 'rest', types)[0]).toContain('manual and seeded');
  });

  it('lists only CALL codes as not-forcing, never day shifts', () => {
    // "7-3 does not force a day off" is true but meaningless, and padding the
    // list with day shifts would bury the codes that matter.
    expect(textOf(CLASSIC_PATTERN, 'rest', types)[1]).not.toContain('7-3');
  });
});

describe('what a provider owes', () => {
  const banded: CallPatternDoc = {
    ...CLASSIC_PATTERN,
    obligations: {
      bands: [
        { minFte: 0, calls: [{ dayType: 'weekday', code: 'C1', count: 2 }] },
        { minFte: 1, calls: [{ dayType: 'weekday', code: 'C1', count: 4 }] },
      ],
    },
  } as CallPatternDoc;

  it('orders bands from the top down and names the catch-all', () => {
    // "at 0 FTE or above" states a threshold that is not one, and reads as a
    // data-entry error rather than as the bottom tier.
    const lines = textOf(banded, 'obligations');
    expect(lines[0]).toContain('A provider at 1 FTE or above owes 4 × C1');
    expect(lines[1]).toContain('Every other provider owes 2 × C1');
  });

  it('says stated tiers OVERRIDE the par level', () => {
    expect(textOf(banded, 'obligations').join(' ')).toContain('take precedence over it');
  });

  it('falls back to the par formula when no bands are stated', () => {
    const lines = textOf(CLASSIC_PATTERN, 'obligations', [], 11);
    expect(lines[0]).toContain('divided by 11');
    // The under-cover-by-design point, which is otherwise read as a bug.
    expect(lines.join(' ')).toContain('paid-pickup layer');
  });

  it('declines to compute anything without a par level', () => {
    const s = section(CLASSIC_PATTERN, 'obligations', [], null);
    expect(s.statements).toHaveLength(0);
    expect(s.emptyNote).toContain('No par level');
  });
});

describe('the invariants section', () => {
  it('is present regardless of configuration', () => {
    // A page claiming to show what the engine obeys would mislead if it showed
    // only the configurable part.
    const s = section({ ...CLASSIC_PATTERN, blocks: [], dayChains: [] }, 'invariants');
    expect(s.statements.length).toBeGreaterThanOrEqual(6);
  });

  it('states the PENDING-PTO rule, which is the least obvious one', () => {
    expect(textOf(CLASSIC_PATTERN, 'invariants').join(' '))
      .toContain('PENDING time off always blocks');
  });
});

describe('every statement', () => {
  it('cites where it came from, so a wrong one can be traced', () => {
    const all = describeSchedulingLogic({
      doc: CLASSIC_PATTERN,
      shiftTypes: [{ code: 'C1', category: 'call', requires_post_call_rule: true }],
      parLevel: 11,
    }).flatMap(s => s.statements);
    expect(all.length).toBeGreaterThan(5);
    expect(all.every(s => typeof s.source === 'string' && s.source.length > 0)).toBe(true);
  });

  it('renders the shipped CLASSIC pattern without throwing or leaving a blank', () => {
    for (const s of describeSchedulingLogic({ doc: CLASSIC_PATTERN, shiftTypes: [], parLevel: 11 })) {
      expect(s.title.length).toBeGreaterThan(0);
      for (const st of s.statements) expect(st.text.trim().length).toBeGreaterThan(0);
      if (s.statements.length === 0 && s.key !== 'invariants') {
        expect(s.emptyNote.length).toBeGreaterThan(0);
      }
    }
  });
});
