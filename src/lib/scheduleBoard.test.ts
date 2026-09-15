import { describe, it, expect } from 'vitest';
import {
  buildScheduleBoard,
  groupOf,
  boxSummary,
  BOARD_GROUPS,
  type BoardSchedule,
  type BoardSite,
} from './scheduleBoard';

const SITES: BoardSite[] = [
  { id: 's1', name: 'Paoli Hospital', short_name: 'PH' },
  { id: 's2', name: 'Riddle Hospital', short_name: 'RH' },
];

function sched(over: Partial<BoardSchedule> = {}): BoardSchedule {
  return {
    id: 'sch-1',
    schedule_name: 'Block',
    provider_group: 'physician',
    status: 'draft',
    date_start: '2026-08-10',
    date_end: '2026-10-25',
    site_id: 's1',
    ...over,
  };
}

describe('groupOf', () => {
  it('reads the two real groups', () => {
    expect(groupOf(sched({ provider_group: 'physician' }))).toBe('physician');
    expect(groupOf(sched({ provider_group: 'crna' }))).toBe('crna');
  });

  it('files "both" as combined', () => {
    expect(groupOf(sched({ provider_group: 'both' }))).toBe('both');
  });

  it('files null and anything unrecognised as combined, not physician', () => {
    // 'both' is the column that only renders when occupied, so an unexpected
    // value surfaces on screen rather than being silently filed under
    // Physician — where nobody would ever notice it.
    expect(groupOf(sched({ provider_group: null }))).toBe('both');
    expect(groupOf(sched({ provider_group: undefined }))).toBe('both');
    expect(groupOf(sched({ provider_group: 'nurse-practitioner' }))).toBe('both');
  });
});

describe('buildScheduleBoard', () => {
  it('gives every site a box, including sites with nothing', () => {
    // Six of eight sites are in this state. An empty Physician column at
    // Riddle is the fact worth seeing; omitting Riddle hides that it exists.
    const { boxes } = buildScheduleBoard(SITES, []);
    expect(boxes.map(b => b.site.id)).toEqual(['s1', 's2']);
    for (const b of boxes) {
      for (const g of BOARD_GROUPS) expect(b.byGroup[g]).toEqual([]);
      expect(b.total).toBe(0);
    }
  });

  it('keeps the site order it was given', () => {
    const { boxes } = buildScheduleBoard([...SITES].reverse(), []);
    expect(boxes.map(b => b.site.id)).toEqual(['s2', 's1']);
  });

  it('splits a site’s schedules by group', () => {
    const { boxes } = buildScheduleBoard(SITES, [
      sched({ id: 'a', provider_group: 'physician' }),
      sched({ id: 'b', provider_group: 'crna' }),
      sched({ id: 'c', provider_group: 'both' }),
    ]);
    const paoli = boxes.find(b => b.site.id === 's1')!;
    expect(paoli.byGroup.physician.map(s => s.id)).toEqual(['a']);
    expect(paoli.byGroup.crna.map(s => s.id)).toEqual(['b']);
    expect(paoli.byGroup.both.map(s => s.id)).toEqual(['c']);
    expect(paoli.total).toBe(3);
  });

  it('sends each schedule to its own site', () => {
    const { boxes } = buildScheduleBoard(SITES, [
      sched({ id: 'a', site_id: 's1' }),
      sched({ id: 'b', site_id: 's2' }),
    ]);
    expect(boxes.find(b => b.site.id === 's1')!.total).toBe(1);
    expect(boxes.find(b => b.site.id === 's2')!.total).toBe(1);
  });

  it('orders schedules newest first', () => {
    const { boxes } = buildScheduleBoard(SITES, [
      sched({ id: 'old', date_start: '2026-01-01' }),
      sched({ id: 'new', date_start: '2026-11-01' }),
      sched({ id: 'mid', date_start: '2026-06-01' }),
    ]);
    expect(boxes[0].byGroup.physician.map(s => s.id)).toEqual(['new', 'mid', 'old']);
  });

  it('breaks a date tie by name, so the order is stable', () => {
    const { boxes } = buildScheduleBoard(SITES, [
      sched({ id: 'b', schedule_name: 'Beta' }),
      sched({ id: 'a', schedule_name: 'Alpha' }),
    ]);
    expect(boxes[0].byGroup.physician.map(s => s.schedule_name)).toEqual(['Alpha', 'Beta']);
  });

  it('surfaces a schedule whose site is unknown rather than dropping it', () => {
    // This is the only page that lists schedules. One vanishing silently is
    // the sort of thing nobody notices until it matters.
    const { boxes, orphans } = buildScheduleBoard(SITES, [
      sched({ id: 'lost', site_id: 'deleted-site' }),
      sched({ id: 'alsoLost', site_id: null }),
      sched({ id: 'fine', site_id: 's1' }),
    ]);
    expect(orphans.map(s => s.id).sort()).toEqual(['alsoLost', 'lost']);
    expect(boxes.reduce((a, b) => a + b.total, 0)).toBe(1);
  });

  it('loses nothing: every schedule lands in a box or in orphans', () => {
    const all = [
      sched({ id: '1', site_id: 's1', provider_group: 'physician' }),
      sched({ id: '2', site_id: 's2', provider_group: 'crna' }),
      sched({ id: '3', site_id: 'gone' }),
      sched({ id: '4', site_id: 's1', provider_group: null }),
    ];
    const { boxes, orphans } = buildScheduleBoard(SITES, all);
    const placed = boxes.reduce((a, b) => a + b.total, 0) + orphans.length;
    expect(placed).toBe(all.length);
  });

  it('handles no sites at all', () => {
    const { boxes, orphans } = buildScheduleBoard([], [sched()]);
    expect(boxes).toEqual([]);
    expect(orphans).toHaveLength(1);
  });
});

describe('boxSummary', () => {
  it('names the empty case rather than saying 0', () => {
    expect(boxSummary(0)).toBe('No schedules yet');
  });
  it('singularises', () => {
    expect(boxSummary(1)).toBe('1 schedule');
  });
  it('pluralises', () => {
    expect(boxSummary(4)).toBe('4 schedules');
  });
});
