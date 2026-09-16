/**
 * The group handbook.
 *
 * These tests are mostly about dates: a rate that starts next month, a meeting
 * happening today, a contract that lapsed on Friday. Every one of them is a
 * case where the obvious implementation (take the latest row) quietly tells
 * somebody the wrong number.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveRates, formatMoney, groupCandidates, splitMeetings, openActionCount,
  type RateRow, type CandidateRow,
} from './handbook';

const TODAY = '2026-09-15';

const rate = (
  id: string, label: string, dollars: number, effective: string,
  extra: Partial<RateRow> = {},
): RateRow => ({
  id, label, amount_cents: dollars * 100, effective_date: effective, ...extra,
});

describe('resolveRates', () => {
  it('collapses the log to the row IN FORCE, not the latest row', () => {
    // The trap: a raise agreed in March to start in July would be billed in
    // April by anything that just takes max(effective_date).
    const lines = resolveRates([
      rate('a', 'Saturday C1', 2600, '2026-01-01'),
      rate('b', 'Saturday C1', 2800, '2026-12-01'),   // future
    ], TODAY);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ amountCents: 260000, effectiveDate: '2026-01-01' });
  });

  it('carries the row it replaced, so the page can say WHEN it moved', () => {
    const lines = resolveRates([
      rate('a', 'Saturday C1', 2600, '2026-01-01'),
      rate('b', 'Saturday C1', 2800, '2026-06-02'),
    ], TODAY);
    expect(lines[0]).toMatchObject({
      amountCents: 280000,
      effectiveDate: '2026-06-02',
      previous: { amountCents: 260000, effectiveDate: '2026-01-01' },
    });
  });

  it('reports a future rate as PENDING rather than applying it', () => {
    const lines = resolveRates([
      rate('a', 'Weekday C1', 2400, '2026-01-01'),
      rate('b', 'Weekday C1', 2500, '2026-10-01'),
    ], TODAY);
    expect(lines[0]).toMatchObject({
      amountCents: 240000,
      pending: { amountCents: 250000, effectiveDate: '2026-10-01' },
    });
  });

  it('refuses to borrow tomorrow\'s number for a rate with no history', () => {
    // Every row in the future = there IS no current rate. Showing next month's
    // figure as today's is the whole failure this table exists to prevent.
    const lines = resolveRates([rate('a', 'New premium', 900, '2026-11-01')], TODAY);
    expect(lines[0]).toMatchObject({ amountCents: 0, effectiveDate: '' });
    expect(lines[0].pending?.amountCents).toBe(90000);
  });

  it('applies a rate that starts TODAY', () => {
    expect(resolveRates([rate('a', 'X', 100, TODAY)], TODAY)[0].amountCents).toBe(10000);
  });

  it('keeps a site rate separate from the group rate of the same name', () => {
    const lines = resolveRates([
      rate('a', 'Pick-up day', 1600, '2026-01-01'),
      rate('b', 'Pick-up day', 1800, '2026-01-01', { site_id: 'paoli' }),
    ], TODAY);
    expect(lines).toHaveLength(2);
    expect(lines.map(l => l.siteId).sort()).toEqual([null, 'paoli']);
  });

  it('reads a bigint that arrives as a STRING', () => {
    const lines = resolveRates(
      [{ id: 'a', label: 'X', amount_cents: '240000', effective_date: '2026-01-01' }], TODAY);
    expect(lines[0].amountCents).toBe(240000);
  });

  it('returns nothing for an empty log rather than a placeholder', () => {
    expect(resolveRates([], TODAY)).toEqual([]);
  });
});

describe('formatMoney', () => {
  it('prints whole dollars without cents', () => {
    expect(formatMoney(240000)).toBe('$2,400');
  });

  it('keeps cents when there are any', () => {
    expect(formatMoney(240050)).toBe('$2,400.50');
  });

  it('prints zero as zero', () => {
    expect(formatMoney(0)).toBe('$0');
  });
});

describe('groupCandidates', () => {
  const cand = (
    id: string, initials: string, stage: string, stageOn: string,
    extra: Partial<CandidateRow> = {},
  ): CandidateRow => ({ id, initials, stage, stage_on: stageOn, ...extra });

  it('buckets by stage and counts only the ACTIVE ones', () => {
    const g = groupCandidates([
      cand('1', 'A.W.', 'interviewed', '2026-09-08'),
      cand('2', 'R.F.', 'interviewed', '2026-09-12'),
      cand('3', 'X.Y.', 'screened', '2026-09-01', { status: 'hired' }),
    ], TODAY);
    expect(g.active).toBe(2);
    expect(g.stages.find(s => s.stage === 'interviewed')!.candidates.map(c => c.initials))
      .toEqual(['A.W.', 'R.F.']);
    expect(g.stages.find(s => s.stage === 'screened')!.candidates).toEqual([]);
  });

  it('DROPS an unrecognised stage rather than filing it under the first one', () => {
    const g = groupCandidates([cand('1', 'A.W.', 'chatting', '2026-09-01')], TODAY);
    expect(g.active).toBe(0);
  });

  it('flags a contract about to lapse', () => {
    const g = groupCandidates(
      [cand('1', 'J.L.', 'contract_sent', '2026-09-05', { expires_on: '2026-09-26' })], TODAY);
    expect(g.needAttention.map(c => c.attention)).toEqual(['expires 2026-09-26']);
  });

  it('flags one that ALREADY lapsed differently from one about to', () => {
    const g = groupCandidates(
      [cand('1', 'J.L.', 'contract_sent', '2026-08-01', { expires_on: '2026-09-11' })], TODAY);
    expect(g.needAttention[0].attention).toBe('lapsed 2026-09-11');
  });

  it('leaves a far-off expiry alone', () => {
    const g = groupCandidates(
      [cand('1', 'J.L.', 'contract_sent', '2026-09-05', { expires_on: '2026-12-01' })], TODAY);
    expect(g.needAttention).toEqual([]);
  });

  it('flags credentialing that has stopped being "in progress"', () => {
    const g = groupCandidates([cand('1', 'T.B.', 'credentialing', '2026-07-15')], TODAY);
    expect(g.needAttention[0].attention).toContain('day 62');
  });

  it('does not flag credentialing that only just started', () => {
    const g = groupCandidates([cand('1', 'T.B.', 'credentialing', '2026-09-10')], TODAY);
    expect(g.needAttention).toEqual([]);
  });

  it('always returns every stage, so an empty column still shows', () => {
    const g = groupCandidates([], TODAY);
    expect(g.stages.map(s => s.stage)).toEqual([
      'screened', 'interviewed', 'references',
      'contract_sent', 'credentialing', 'start_date_set',
    ]);
  });
});

describe('splitMeetings', () => {
  const m = (id: string, on: string, items: Array<{ status?: string }> = []) =>
    ({ id, meets_on: on, committee_action_items: items });

  it('treats a meeting TODAY as the next one, not as history', () => {
    // The morning of the meeting is exactly when somebody needs the room.
    const s = splitMeetings([m('a', '2026-08-27'), m('b', TODAY)], TODAY);
    expect(s.next?.id).toBe('b');
    expect(s.past.map(p => p.id)).toEqual(['a']);
  });

  it('picks the EARLIEST upcoming meeting', () => {
    const s = splitMeetings([m('a', '2026-11-01'), m('b', '2026-09-24')], TODAY);
    expect(s.next?.id).toBe('b');
  });

  it('lists history newest first', () => {
    const s = splitMeetings(
      [m('a', '2026-05-28'), m('b', '2026-08-27'), m('c', '2026-06-25')], TODAY);
    expect(s.past.map(p => p.id)).toEqual(['b', 'c', 'a']);
  });

  it('has no next meeting when none is scheduled', () => {
    expect(splitMeetings([m('a', '2026-08-27')], TODAY).next).toBeNull();
  });
});

describe('openActionCount', () => {
  it('counts open items across every meeting', () => {
    expect(openActionCount([
      { id: 'a', meets_on: '2026-08-27',
        committee_action_items: [{ status: 'open' }, { status: 'done' }, { status: 'open' }] },
      { id: 'b', meets_on: '2026-07-30', committee_action_items: [{ status: 'open' }] },
    ])).toBe(3);
  });

  it('treats a missing status as open, never as closed', () => {
    // A row with no status is unfinished business, and defaulting it to done
    // would make the open count quietly too low.
    expect(openActionCount([
      { id: 'a', meets_on: '2026-08-27', committee_action_items: [{}] },
    ])).toBe(1);
  });

  it('counts a meeting with no items as zero', () => {
    expect(openActionCount([{ id: 'a', meets_on: '2026-08-27' }])).toBe(0);
  });
});
