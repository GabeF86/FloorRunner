// Observance notes — captions only, never scheduling holidays.
import { describe, it, expect } from 'vitest';
import {
  OBSERVANCE_NOTES, observanceNotesByDate, observanceLabelFor,
} from './observanceNotes';

const dow = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay(); // 0=Sun

describe('the 5787 table is internally consistent', () => {
  // These are the checks a wrong YEAR would most likely fail. They cannot
  // prove the table right, but an inconsistent one cannot pass them.
  const byDate = observanceNotesByDate();
  const dateOf = (label: string) =>
    OBSERVANCE_NOTES.find(n => n.label === label)!.date;

  it('Rosh Hashanah does not fall on Sunday, Wednesday or Friday (lo ADU rosh)', () => {
    expect([0, 3, 5]).not.toContain(dow(dateOf('RH day 1')));
  });

  it('Yom Kippur does not fall on Sunday, Tuesday or Friday', () => {
    expect([0, 2, 5]).not.toContain(dow(dateOf('YK day')));
  });

  it('Yom Kippur is exactly 9 days after Rosh Hashanah day 1', () => {
    const rh = Date.parse(`${dateOf('RH day 1')}T00:00:00Z`);
    const yk = Date.parse(`${dateOf('YK day')}T00:00:00Z`);
    expect((yk - rh) / 86_400_000).toBe(9);
  });

  it('Sukkot day 1 is 14 days after Rosh Hashanah day 1 (15 Tishrei)', () => {
    const rh = Date.parse(`${dateOf('RH day 1')}T00:00:00Z`);
    const su = Date.parse(`${dateOf('Sukkot day 1')}T00:00:00Z`);
    expect((su - rh) / 86_400_000).toBe(14);
  });

  it('Shemini Atzeret is 21 days after RH day 1, Simchat Torah the day after', () => {
    const rh = Date.parse(`${dateOf('RH day 1')}T00:00:00Z`);
    const sa = Date.parse(`${dateOf('Sh. Atzeret')}T00:00:00Z`);
    const st = Date.parse(`${dateOf('S. Torah')}T00:00:00Z`);
    expect((sa - rh) / 86_400_000).toBe(21);
    expect((st - sa) / 86_400_000).toBe(1);
  });

  it('every SUNDOWN entry is the day before its day entry', () => {
    for (const [eve, day] of [
      ['RH sundown', 'RH day 1'], ['YK sundown', 'YK day'],
      ['Sukkot sundown', 'Sukkot day 1'],
      ['Sh. Atzeret sundown', 'Sh. Atzeret'], ['S. Torah sundown', 'S. Torah'],
    ] as const) {
      const gap = (Date.parse(`${dateOf(day)}T00:00:00Z`)
        - Date.parse(`${dateOf(eve)}T00:00:00Z`)) / 86_400_000;
      expect(gap, `${eve} → ${day}`).toBe(1);
    }
  });

  it('3 Oct 2026 carries BOTH Shemini Atzeret and the eve of Simchat Torah', () => {
    expect(byDate.get('2026-10-03')).toEqual(['Sh. Atzeret', 'S. Torah sundown']);
  });
});

describe('lookup', () => {
  it('joins multiple observances into one caption', () => {
    const byDate = observanceNotesByDate();
    expect(observanceLabelFor('2026-10-03', byDate)).toBe('Sh. Atzeret · S. Torah sundown');
  });

  it('is null for an ordinary date', () => {
    expect(observanceLabelFor('2026-09-15', observanceNotesByDate())).toBeNull();
  });

  it('takes a custom table — the app data is a default, not a hard-coding', () => {
    const byDate = observanceNotesByDate([{ date: '2027-01-01', label: 'Test' }]);
    expect(observanceLabelFor('2027-01-01', byDate)).toBe('Test');
    expect(observanceLabelFor('2026-09-21', byDate)).toBeNull();
  });

  it('labels stay short enough for a 9px caption', () => {
    for (const n of OBSERVANCE_NOTES) expect(n.label.length).toBeLessThanOrEqual(20);
  });
});
