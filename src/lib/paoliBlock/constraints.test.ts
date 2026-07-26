import { describe, expect, it } from 'vitest';
import { parseConstraintText } from './constraints';

const YEAR = 2026;

function parse(noCallText: string | null, mandatoryText: string | null, extra?: object) {
  return parseConstraintText({
    noCallText,
    mandatoryText,
    defaultYear: YEAR,
    providerName: 'Test',
    ...extra,
  });
}

describe('column L — prohibition semantics', () => {
  it('inherits prohibition semantics even without the words "no call" (bare "8/13 C1")', () => {
    const r = parse('8/13 C1', null);
    expect(r.prohibitions).toHaveLength(1);
    expect(r.prohibitions[0]).toMatchObject({
      dates: ['2026-08-13'],
      callCodes: ['C1'],
    });
  });

  it('a call-type-specific prohibition ("8/24 C1") prohibits ONLY that call type on that date', () => {
    const r = parse('8/24 C1', null);
    expect(r.prohibitions[0].callCodes).toEqual(['C1']);
    expect(r.prohibitions[0].callCodes).not.toBe('all');
    expect(r.prohibitions[0].dates).toEqual(['2026-08-24']);
  });

  it('a general "No Call" date range prohibits all call types, range inclusive', () => {
    const r = parse('No call 9/11-9/13', null);
    expect(r.prohibitions).toHaveLength(1);
    expect(r.prohibitions[0].callCodes).toBe('all');
    expect(r.prohibitions[0].dates).toEqual(['2026-09-11', '2026-09-12', '2026-09-13']);
  });

  it('a bare date range in L (no "no call" words) still prohibits all call types', () => {
    const r = parse('9/18-9/20', null);
    expect(r.prohibitions[0].callCodes).toBe('all');
    expect(r.prohibitions[0].dates).toEqual(['2026-09-18', '2026-09-19', '2026-09-20']);
  });

  it('two ranges in one sentence produce two prohibitions (Farkas)', () => {
    const r = parse('No call 9/11-9/13 and 9/20-9/21', null);
    expect(r.prohibitions).toHaveLength(2);
    expect(r.prohibitions[0].dates).toEqual(['2026-09-11', '2026-09-12', '2026-09-13']);
    expect(r.prohibitions[1].dates).toEqual(['2026-09-20', '2026-09-21']);
    expect(r.prohibitions.every((p) => p.callCodes === 'all')).toBe(true);
  });

  it('per-item codes: "8/13 C1, 8/24 C1, 9/18 F/S/S" — the F/S/S item is all-call (Amusa)', () => {
    const r = parse('8/13 C1, 8/24 C1, 9/18 F/S/S', null);
    expect(r.prohibitions).toHaveLength(3);
    expect(r.prohibitions[0]).toMatchObject({ dates: ['2026-08-13'], callCodes: ['C1'] });
    expect(r.prohibitions[1]).toMatchObject({ dates: ['2026-08-24'], callCodes: ['C1'] });
    expect(r.prohibitions[2].callCodes).toBe('all');
    expect(r.prohibitions[2].dates).toEqual(['2026-09-18', '2026-09-19', '2026-09-20']);
  });

  it('documents the F/S/S weekend normalization', () => {
    const r = parse('9/18 F/S/S', null);
    const note = r.warnings.find((w) => /F\/S\/S/i.test(w));
    expect(note).toBeDefined();
    expect(note).toContain('2026-09-18');
    expect(note).toContain('2026-09-20');
  });

  it('recurring prohibition: "No Monday C1" (no dates) → weekday recurrence (Kalawadia)', () => {
    const r = parse('No Monday C1. Prefers Tuesday for C1.', null);
    expect(r.prohibitions).toHaveLength(1);
    expect(r.prohibitions[0].dates).toBeUndefined();
    expect(r.prohibitions[0].recurrence).toEqual({ weekday: 'MON' });
    expect(r.prohibitions[0].callCodes).toEqual(['C1']);
  });

  it('"Prefers"/"ideally" text is a soft preference, never a prohibition (Kalawadia Tuesday)', () => {
    const r = parse('No Monday C1. Prefers Tuesday for C1.', null);
    expect(r.preferences).toHaveLength(1);
    expect(r.preferences[0]).toMatchObject({ kind: 'weekday', weekday: 'TUE' });
  });
});

describe('dates and weekday derivation', () => {
  it('defaults omitted year to 2026 and emits ISO dates', () => {
    const r = parse('10/17', null);
    expect(r.prohibitions[0].dates).toEqual(['2026-10-17']);
  });

  it('accepts explicit years (9/5/26 and 9/5/2026)', () => {
    expect(parse('9/5/26', null).prohibitions[0].dates).toEqual(['2026-09-05']);
    expect(parse('9/5/2026', null).prohibitions[0].dates).toEqual(['2026-09-05']);
  });

  it('ALWAYS derives the weekday from the date: wrong weekday word surfaces a warning, date wins (Jones)', () => {
    const r = parse('No call 9/5 (Friday), 9/6, 9/7.', null);
    // 2026-09-05 is a Saturday. The date wins:
    expect(r.prohibitions.map((p) => p.dates)).toEqual([
      ['2026-09-05'],
      ['2026-09-06'],
      ['2026-09-07'],
    ]);
    const warn = r.warnings.find((w) => /friday/i.test(w));
    expect(warn).toBeDefined();
    expect(warn).toContain('2026-09-05');
    expect(warn).toMatch(/saturday/i);
  });

  it('a consistent weekday word produces no mismatch warning', () => {
    const r = parse('No call 9/5 (Saturday)', null);
    expect(r.warnings.filter((w) => /does not match|mismatch/i.test(w))).toEqual([]);
  });

  it('unparseable non-empty text is warned about, never silently dropped', () => {
    const r = parse('please be kind', null);
    expect(r.prohibitions).toEqual([]);
    expect(r.warnings.some((w) => /unparsed/i.test(w))).toBe(true);
  });
});

describe('column M — mandatory semantics', () => {
  it('pairs codes to dates: "Must be C1 on 9/4 and Neuro on 9/5 and 9/6." (Lin)', () => {
    const r = parse(null, 'Must be C1 on 9/4 and Neuro on 9/5 and 9/6.');
    expect(r.fixedAssignments).toEqual([
      expect.objectContaining({ date: '2026-09-04', code: 'C1' }),
      expect.objectContaining({ date: '2026-09-05', code: 'NEURO' }),
      expect.objectContaining({ date: '2026-09-06', code: 'NEURO' }),
    ]);
  });

  it('pairs comma-separated code/date sequences: "C2 on 9/5, C1 on 9/6, and C2 on 9/7." (Jones)', () => {
    const r = parse(null, 'Must be C2 on 9/5, C1 on 9/6, and C2 on 9/7.');
    expect(r.fixedAssignments).toEqual([
      expect.objectContaining({ date: '2026-09-05', code: 'C2' }),
      expect.objectContaining({ date: '2026-09-06', code: 'C1' }),
      expect.objectContaining({ date: '2026-09-07', code: 'C2' }),
    ]);
  });

  it('same-weekend linkage: "Saturday C1 and Sunday C2 must be on the same weekend." (Simon)', () => {
    const r = parse(null, 'Saturday C1 and Sunday C2 must be on the same weekend.');
    const link = r.linkages.find((l) => l.kind === 'same-weekend');
    expect(link).toBeDefined();
    expect(link!.members).toEqual(['SAT:C1', 'SUN:C2']);
  });

  it('"combined with" emits a same-date linkage; "same weekend" a same-weekend linkage (Hussain)', () => {
    const r = parse(
      null,
      'Friday C2 is combined with Friday Neuro and must be on the same weekend as his Saturday/Sunday Neuro.',
    );
    const sameDate = r.linkages.find((l) => l.kind === 'same-date');
    expect(sameDate).toBeDefined();
    expect(sameDate!.members).toEqual(['FRI:C2', 'FRI:NEURO']);
    const sameWeekend = r.linkages.find((l) => l.kind === 'same-weekend');
    expect(sameWeekend).toBeDefined();
    expect(sameWeekend!.members).toEqual(['FRI:C2', 'FRI:NEURO', 'SAT:NEURO', 'SUN:NEURO']);
  });

  it('either/or constraint: "Must take either one Saturday or one Sunday call." (Hussain)', () => {
    const r = parse(null, 'Must take either one Saturday or one Sunday call.');
    const link = r.linkages.find((l) => l.kind === 'either-or');
    expect(link).toBeDefined();
    expect(link!.members).toEqual(['SAT:ANY', 'SUN:ANY']);
  });

  it('12-hour split coverage links the two named providers (Simon/Horan)', () => {
    const r = parse(
      null,
      'He covers the 12 hour night portion of the Sunday when Horan covers the 12 hour day portion.',
      { providerName: 'Simon', rosterNames: ['Horan', 'Jones', 'Simon'] },
    );
    const link = r.linkages.find((l) => l.kind === 'split-12h');
    expect(link).toBeDefined();
    expect(link!.members).toEqual(['Simon', 'Horan']);
  });

  it('"exactly one Saturday/Sunday Neuro pair on the same weekend" (Havildar) → same-weekend pair with exactly-one detail', () => {
    const r = parse(
      null,
      'Neuro obligation is exactly one Saturday/Sunday Neuro pair on the same weekend, no additional Neuro dates.',
    );
    const link = r.linkages.find((l) => l.kind === 'same-weekend');
    expect(link).toBeDefined();
    expect(link!.members).toEqual(['SAT:NEURO', 'SUN:NEURO']);
    expect(link!.details).toMatch(/exactly-one/);
  });

  it('an "ideally" clause inside a hard sentence becomes a preference while the hard part still binds (Simon Neuro pair)', () => {
    const r = parse(
      null,
      'His Neuro obligation is exactly one Saturday/Sunday pair, ideally on the same weekend as his Friday C1.',
    );
    const link = r.linkages.find((l) => l.kind === 'same-weekend');
    expect(link).toBeDefined();
    expect(link!.members).toEqual(['SAT:NEURO', 'SUN:NEURO']);
    const pref = r.preferences.find((p) => p.kind === 'same-weekend');
    expect(pref).toBeDefined();
    expect(pref!.members).toEqual(['FRI:C1']);
  });
});

describe('mandatory-vs-prohibition conflicts (Jones)', () => {
  const r = parse(
    'No call 9/5 (Friday), 9/6, 9/7.',
    'Must be C2 on 9/5, C1 on 9/6, and C2 on 9/7.',
  );

  it('records one conflict per colliding date, mandatory retained', () => {
    expect(r.conflicts).toHaveLength(3);
    expect(r.conflicts.map((c) => c.date)).toEqual([
      '2026-09-05',
      '2026-09-06',
      '2026-09-07',
    ]);
    expect(r.conflicts.every((c) => c.resolution === 'mandatory-retained')).toBe(true);
  });

  it('neither source rule is silently erased', () => {
    expect(r.fixedAssignments).toHaveLength(3);
    expect(r.prohibitions).toHaveLength(3);
  });
});
