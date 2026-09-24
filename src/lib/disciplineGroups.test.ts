/**
 * Splitting a site card's people into MD and CRNA columns.
 *
 * Gabriel 2026-09-24, on the Lankenau card: 16 MDs and 16 CRNAs ran as one
 * 31-row list, separated only by the accident of the start-time sort putting
 * the 7am doctors above the CRNA shifts.
 *
 * The failure mode here is quiet. The card header prints "16 MD · 16 CRNA"
 * from operationsBoard's own tally; the columns underneath come from this
 * split. If the two disagree about what counts as a CRNA, the header says 16
 * and the column shows 15, and nothing throws — the "failures rendering as
 * zeros" family this codebase has already been bitten by. So the headline
 * test is that the split and the count agree on EVERY provider_type,
 * including the ones nobody has thought of yet.
 */
import { describe, it, expect } from 'vitest';
import { disciplineGroups } from './operationsBoard';
import type { BoardPerson } from './operationsBoard';

function person(providerId: string, providerType: string): BoardPerson {
  return {
    providerId, providerType,
    name: providerId.toUpperCase(),
    code: '7-3', hours: '8 h', callRank: null, startTime: '07:00:00',
  };
}

/** operationsBoard's header rule, restated: anything not 'crna' is an MD. */
const headerCounts = (people: BoardPerson[]) => ({
  md: people.filter(p => p.providerType !== 'crna').length,
  crna: people.filter(p => p.providerType === 'crna').length,
});

describe('the columns agree with the header counts', () => {
  it('matches on a mixed card', () => {
    const people = [person('a', 'physician'), person('b', 'crna'), person('c', 'physician')];
    const byLabel = Object.fromEntries(
      disciplineGroups(people).map(g => [g.label, g.people.length]));
    expect(byLabel.MD).toBe(headerCounts(people).md);
    expect(byLabel.CRNA).toBe(headerCounts(people).crna);
  });

  it('counts an unexpected provider_type as an MD, exactly as the header does', () => {
    // A resident, a fellow, a blank, a type added next year: the header folds
    // every non-'crna' value into mdCount, so the MD column must too.
    // Anything else makes a real person disappear from a card that still
    // counts them in its header.
    for (const type of ['resident', 'fellow', 'srna', '', 'locum', 'PHYSICIAN']) {
      const people = [person('x', type), person('y', 'crna')];
      const md = disciplineGroups(people).find(g => g.label === 'MD');
      expect(md?.people.map(p => p.providerId), `provider_type '${type}'`).toEqual(['x']);
      expect(headerCounts(people).md, `provider_type '${type}'`).toBe(1);
    }
  });
});

describe('nobody is ever dropped', () => {
  it('every person appears exactly once across the columns', () => {
    const people = [
      person('a', 'physician'), person('b', 'crna'), person('c', 'resident'),
      person('d', 'crna'), person('e', 'fellow'),
    ];
    const flat = disciplineGroups(people).flatMap(g => g.people.map(p => p.providerId));
    expect([...flat].sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(new Set(flat).size).toBe(flat.length);
  });

  it('an empty card produces one empty group, not a crash', () => {
    expect(disciplineGroups([])).toEqual([{ label: '', people: [] }]);
  });
});

describe('a single-discipline card renders full width', () => {
  // One group means the card draws ONE list instead of a column beside an
  // empty one. Sites on this board range from 32 people down to none.
  it('all MDs → one unlabelled group', () => {
    const people = [person('a', 'physician'), person('b', 'resident')];
    expect(disciplineGroups(people)).toEqual([{ label: '', people }]);
  });

  it('all CRNAs → one unlabelled group', () => {
    const people = [person('a', 'crna'), person('b', 'crna')];
    expect(disciplineGroups(people)).toEqual([{ label: '', people }]);
  });
});

describe('order inside a column is preserved', () => {
  it('keeps the incoming sort, which is call rank or start time', () => {
    // onCall arrives sorted by call rank, inRooms by start time. A filter
    // preserves relative order; re-sorting here would silently override the
    // ordering operationsBoard deliberately chose.
    const people = [
      person('md-first', 'physician'), person('crna-first', 'crna'),
      person('md-second', 'physician'), person('crna-second', 'crna'),
    ];
    const groups = disciplineGroups(people);
    expect(groups.find(g => g.label === 'MD')?.people.map(p => p.providerId))
      .toEqual(['md-first', 'md-second']);
    expect(groups.find(g => g.label === 'CRNA')?.people.map(p => p.providerId))
      .toEqual(['crna-first', 'crna-second']);
  });

  it('puts MD in the left column', () => {
    const groups = disciplineGroups([person('a', 'crna'), person('b', 'physician')]);
    expect(groups.map(g => g.label)).toEqual(['MD', 'CRNA']);
  });
});
