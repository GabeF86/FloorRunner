/**
 * Cells + a dictionary → a plan of writes.
 *
 * The two things that would do real damage if wrong: filing a cross-site day
 * at the physician's HOME hospital instead of where the work was, and turning
 * 668 vacation cells into 668 separate absences.
 */
import { describe, it, expect } from 'vitest';
import { parseMasterCsv } from './masterCsv';
import {
  planImport, duplicatePositions, crossSiteSameDay, leaveConflicts,
  type CodeMapping,
} from './plan';

const HEADER = ',"09/01/26","09/02/26","09/03/26","09/04/26"';
const sheetOf = (...lines: string[]) => parseMasterCsv([HEADER, ...lines].join('\n'));

const MAPPINGS: CodeMapping[] = [
  { code: 'C1', kind: 'call', site: 'BMH', shiftCode: 'C1' },
  { code: 'PostC1', kind: 'post_call', shiftCode: null },
  { code: 'dayBMH', kind: 'day', site: 'BMH', shiftCode: 'DAY' },
  // Worked at Rothman by physicians homed elsewhere — the whole reason the
  // site comes from the CODE and not the row.
  { code: 'pRoth1', kind: 'day', site: 'RSH', shiftCode: 'R1' },
  { code: 'Vac', kind: 'unavailable', availabilityType: 'pto' },
  { code: 'Sick', kind: 'unavailable', availabilityType: 'sick' },
  { code: 'pOff', kind: 'off', availabilityType: 'unavailable' },
];

const ids = new Map([['ANTK', 'p-antk'], ['DAYR', 'p-dayr']]);
const run = (sheet: ReturnType<typeof sheetOf>, extra: Partial<Parameters<typeof planImport>[0]> = {}) =>
  planImport({ sheet, mappings: MAPPINGS, providerIds: ids, ...extra });

describe('the code owns the site, not the row', () => {
  it('files a Rothman day at Rothman even though the row sits under Bryn Mawr', () => {
    // 0 of 23 real pRoth1 cells are worked by a Rothman-homed physician. Using
    // the row's section would put every one of them at the wrong hospital —
    // and a cross-site double-booking is clinical invariant 3.
    const plan = run(sheetOf('Home- Physician BMH,,,,', 'ANTK,pRoth1,dayBMH,,'));
    expect(plan.assignments.map(a => [a.site, a.shiftCode])).toEqual([
      ['RSH', 'R1'], ['BMH', 'DAY'],
    ]);
  });

  it('reports a physician at two sites on one day', () => {
    const plan = run(sheetOf('Home- Physician BMH,,,,', 'ANTK,dayBMH,,,', 'ANTK,pRoth1,,,'));
    expect(crossSiteSameDay(plan)).toEqual([
      { providerCode: 'ANTK', date: '2026-09-01', sites: ['BMH', 'RSH'] },
    ]);
  });

  it('is quiet when the two assignments are at the same site', () => {
    const plan = run(sheetOf('Home- Physician BMH,,,,', 'ANTK,dayBMH,,,', 'ANTK,C1,,,'));
    expect(crossSiteSameDay(plan)).toEqual([]);
  });
});

describe('leave collapses into runs', () => {
  it('turns four consecutive cells into ONE absence', () => {
    const plan = run(sheetOf('Home- Physician BMH,,,,', 'ANTK,Vac,Vac,Vac,Vac'));
    expect(plan.availability).toEqual([{
      providerId: 'p-antk', providerCode: 'ANTK', availabilityType: 'pto',
      startDate: '2026-09-01', endDate: '2026-09-04', sourceCode: 'Vac', days: 4,
    }]);
  });

  it('breaks a run on a GAP', () => {
    const plan = run(sheetOf('Home- Physician BMH,,,,', 'ANTK,Vac,Vac,,Vac'));
    expect(plan.availability.map(a => [a.startDate, a.endDate])).toEqual([
      ['2026-09-01', '2026-09-02'], ['2026-09-04', '2026-09-04'],
    ]);
  });

  it('never merges two DIFFERENT leave codes into one run', () => {
    // Vacation followed by sick leave is two absences with two reasons, and
    // merging them would relabel one of them.
    const plan = run(sheetOf('Home- Physician BMH,,,,', 'ANTK,Vac,Vac,Sick,Sick'));
    // Ordered by start date within a provider, so the vacation comes first.
    expect(plan.availability.map(a => [a.availabilityType, a.startDate, a.endDate])).toEqual([
      ['pto', '2026-09-01', '2026-09-02'],
      ['sick', '2026-09-03', '2026-09-04'],
    ]);
  });

  it('collapses a run split across the provider\'s two rows', () => {
    const plan = run(sheetOf('Home- Physician BMH,,,,', 'ANTK,Vac,Vac,,', 'ANTK,,,Vac,Vac'));
    expect(plan.availability).toHaveLength(1);
    expect(plan.availability[0]).toMatchObject({ startDate: '2026-09-01', endDate: '2026-09-04' });
  });

  it('does not double-count the same day written on both rows', () => {
    const plan = run(sheetOf('Home- Physician BMH,,,,', 'ANTK,Vac,Vac,,', 'ANTK,Vac,,,'));
    expect(plan.availability[0].days).toBe(2);
  });

  it('keeps a work-pattern day off out of the PTO type', () => {
    const plan = run(sheetOf('Home- Physician BMH,,,,', 'ANTK,pOff,,,'));
    expect(plan.availability[0].availabilityType).toBe('unavailable');
  });
});

describe('post-call creates nothing', () => {
  it('writes no assignment for the day after call', () => {
    // The post-call day is derived from the call shift's requires_post_call_rule.
    // A zero-hour "PostC1" shift would put a phantom row on every grid.
    const plan = run(sheetOf('Home- Physician BMH,,,,', 'ANTK,C1,PostC1,,'));
    expect(plan.assignments).toHaveLength(1);
    expect(plan.assignments[0].shiftCode).toBe('C1');
  });
});

describe('open positions', () => {
  it('creates the SLOT but no assignment for a placeholder row', () => {
    // The position existed and nobody stood it — that is the finding.
    const plan = run(sheetOf('Home- Physician BMH,,,,', 'pBMOpen1,dayBMH,,,'),
      { placeholders: new Set(['pBMOpen1']) });
    expect(plan.assignments).toEqual([expect.objectContaining({
      providerId: null, shiftCode: 'DAY', site: 'BMH',
    })]);
  });

  it('never files a placeholder as being on leave', () => {
    const plan = run(sheetOf('Home- Physician BMH,,,,', 'pBMOpen1,Vac,,,'),
      { placeholders: new Set(['pBMOpen1']) });
    expect(plan.availability).toEqual([]);
    expect(plan.problems.join(' ')).toContain('pBMOpen1');
  });
});

describe('what it refuses to lose', () => {
  it('reports an unmapped code instead of dropping the cell', () => {
    const plan = run(sheetOf('Home- Physician BMH,,,,', 'ANTK,MYSTERY,MYSTERY,,'));
    expect(plan.unmapped).toEqual([{ code: 'MYSTERY', count: 2, sections: ['BMH'] }]);
    expect(plan.assignments).toEqual([]);
  });

  it('reports an unknown provider WITH the number of cells at stake', () => {
    // "12 providers losing 73 cells" is the number that decides whether the
    // import is usable; a bare list of names is not.
    const plan = run(sheetOf('Home- Physician BMH,,,,', 'NOBODY,C1,dayBMH,,'));
    expect(plan.unknownProviders).toEqual([
      { providerCode: 'NOBODY', section: 'BMH', cells: 2 },
    ]);
  });
});

describe('conflict reports', () => {
  it('flags two holders of one CALL position', () => {
    const plan = run(sheetOf('Home- Physician BMH,,,,', 'ANTK,C1,,,', 'DAYR,C1,,,'));
    expect(duplicatePositions(plan)).toEqual([
      { site: 'BMH', date: '2026-09-01', shiftCode: 'C1', providers: ['ANTK', 'DAYR'] },
    ]);
  });

  it('does NOT flag several holders of a DAY code — a day code is a status', () => {
    // Eight physicians on the Lankenau day code are eight people working a day
    // shift, not eight claims on one post. Flagging them buried four real
    // findings under 150 false ones.
    const plan = run(sheetOf('Home- Physician BMH,,,,', 'ANTK,dayBMH,,,', 'DAYR,dayBMH,,,'));
    expect(duplicatePositions(plan)).toEqual([]);
  });

  it('reports an assignment landing inside a leave block, with its note flag', () => {
    const plan = run(sheetOf('Home- Physician BMH,,,,', 'ANTK,Vac,Vac,,', 'ANTK,,C1*,,'));
    expect(leaveConflicts(plan)).toEqual([{
      providerCode: 'ANTK', date: '2026-09-02', shiftCode: 'C1',
      leaveCode: 'Vac', starred: true,
    }]);
  });
});
