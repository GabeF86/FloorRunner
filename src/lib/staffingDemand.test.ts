/**
 * Staffing demand.
 *
 * Two rules carry the whole module: manual beats calculated, and a missing
 * count is NOT zero. The second is the one that matters — a zero would paint
 * an uncounted day green and report an unstaffed hospital as covered, which is
 * exactly what the slot-census version of "needed" used to do.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveDemand, demandKey, parseDemandInput, demandFor, parseWeekendCall,
} from './staffingDemand';

const row = (
  site: string, date: string, md: number | null, crna: number | null,
  source: 'manual' | 'calculated' = 'manual',
) => ({ site_id: site, demand_date: date, md_needed: md, crna_needed: crna, source });

describe('resolveDemand', () => {
  it('keys on site and date', () => {
    const d = resolveDemand([row('s1', '2026-09-14', 6, 13)]);
    expect(d.get(demandKey('s1', '2026-09-14'))).toMatchObject({ md: 6, crna: 13, source: 'manual' });
  });

  it('prefers MANUAL over calculated for the same day', () => {
    // A person who has looked at the OR schedule outranks a model of it.
    const d = resolveDemand([
      row('s1', '2026-09-14', 4, 9, 'calculated'),
      row('s1', '2026-09-14', 6, 13, 'manual'),
    ]);
    expect(d.get(demandKey('s1', '2026-09-14'))).toMatchObject({ md: 6, source: 'manual' });
  });

  it('prefers manual regardless of which row arrives first', () => {
    const d = resolveDemand([
      row('s1', '2026-09-14', 6, 13, 'manual'),
      row('s1', '2026-09-14', 4, 9, 'calculated'),
    ]);
    expect(d.get(demandKey('s1', '2026-09-14'))).toMatchObject({ md: 6, source: 'manual' });
  });

  it('falls back to calculated when no manual row exists', () => {
    const d = resolveDemand([row('s1', '2026-09-14', 4, 9, 'calculated')]);
    expect(d.get(demandKey('s1', '2026-09-14'))).toMatchObject({ md: 4, source: 'calculated' });
  });

  it('keeps sites and dates apart', () => {
    const d = resolveDemand([
      row('s1', '2026-09-14', 6, 13),
      row('s2', '2026-09-14', 2, 4),
      row('s1', '2026-09-15', 5, 11),
    ]);
    expect(d.size).toBe(3);
    expect(d.get(demandKey('s2', '2026-09-14'))?.md).toBe(2);
  });

  it('DROPS a row that states neither count', () => {
    // An empty cell somebody tabbed through. Keeping it would let it mask a
    // real calculated row underneath.
    const d = resolveDemand([
      row('s1', '2026-09-14', null, null, 'manual'),
      row('s1', '2026-09-14', 4, 9, 'calculated'),
    ]);
    expect(d.get(demandKey('s1', '2026-09-14'))).toMatchObject({ md: 4, source: 'calculated' });
  });

  it('keeps a half-stated row — MD counted, CRNA not', () => {
    const d = resolveDemand([row('s1', '2026-09-14', 6, null)]);
    expect(d.get(demandKey('s1', '2026-09-14'))).toMatchObject({ md: 6, crna: null });
  });

  it('keeps a genuine ZERO, which is not the same as not stated', () => {
    // "No physician needed on Sunday" is a real statement. It must survive.
    const d = resolveDemand([row('s1', '2026-09-20', 0, 2)]);
    expect(d.get(demandKey('s1', '2026-09-20'))).toMatchObject({ md: 0, crna: 2 });
  });

  it('reads a numeric that arrives as a string', () => {
    const d = resolveDemand([
      { site_id: 's1', demand_date: '2026-09-14', md_needed: '6' as never, crna_needed: null },
    ]);
    expect(d.get(demandKey('s1', '2026-09-14'))?.md).toBe(6);
  });

  it('discards a negative rather than storing nonsense', () => {
    const d = resolveDemand([row('s1', '2026-09-14', -3, 4)]);
    expect(d.get(demandKey('s1', '2026-09-14'))).toMatchObject({ md: null, crna: 4 });
  });

  it('is empty for no rows', () => {
    expect(resolveDemand([]).size).toBe(0);
  });
});

describe('parseDemandInput', () => {
  it('reads a count', () => expect(parseDemandInput('12')).toBe(12));
  it('reads a zero as a real zero', () => expect(parseDemandInput('0')).toBe(0));
  it('treats a cleared cell as not stated', () => {
    expect(parseDemandInput('')).toBeNull();
    expect(parseDemandInput('   ')).toBeNull();
  });
  it('REFUSES junk rather than storing 0 for it', () => {
    // The failure to avoid: "3x" silently becoming 0 and reporting a site as
    // needing nobody.
    for (const junk of ['3x', '-1', '1.5', 'abc', '1 2']) {
      expect(parseDemandInput(junk)).toBe('invalid');
    }
  });
  it('refuses an implausibly large count', () => {
    expect(parseDemandInput('1000')).toBe('invalid');
  });
});

describe('demandFor — the weekend call complement', () => {
  const SAT = '2026-09-19';   // dayOfWeek 6
  const SUN = '2026-09-20';   // 0
  const MON = '2026-09-21';   // 1
  const weekend = new Map([['s1', { md: 3, crna: 2 }]]);

  const ask = (date: string, dow: number, resolved = new Map()) =>
    demandFor({ siteId: 's1', date, dayOfWeek: dow, resolved, weekendCall: weekend });

  it('fills a Saturday from the standing complement', () => {
    // Paoli: C1, C2, C3 plus in-house and backup CRNA. Structural, so it
    // should not need typing in week after week.
    expect(ask(SAT, 6)).toEqual({ md: 3, crna: 2, source: 'weekend_call', notes: null });
  });

  it('fills a Sunday too', () => {
    expect(ask(SUN, 0)?.source).toBe('weekend_call');
  });

  it('does NOT touch a weekday', () => {
    expect(ask(MON, 1)).toBeNull();
  });

  it('is OUTRANKED by a count typed for that specific day', () => {
    // Somebody who looked at this particular Saturday knows something the
    // standing rule does not.
    const resolved = resolveDemand([row('s1', SAT, 5, 4, 'manual')]);
    expect(ask(SAT, 6, resolved)).toMatchObject({ md: 5, crna: 4, source: 'manual' });
  });

  it('is outranked by a calculated count as well', () => {
    const resolved = resolveDemand([row('s1', SAT, 4, 3, 'calculated')]);
    expect(ask(SAT, 6, resolved)).toMatchObject({ md: 4, source: 'calculated' });
  });

  it('gives nothing for a site with no complement configured', () => {
    expect(demandFor({
      siteId: 's2', date: SAT, dayOfWeek: 6,
      resolved: new Map(), weekendCall: weekend,
    })).toBeNull();
  });

  it('gives nothing when no complement map is passed at all', () => {
    expect(demandFor({ siteId: 's1', date: SAT, dayOfWeek: 6, resolved: new Map() })).toBeNull();
  });

  it('carries a half-configured complement through', () => {
    const half = new Map([['s1', { md: 3, crna: null }]]);
    expect(demandFor({ siteId: 's1', date: SAT, dayOfWeek: 6, resolved: new Map(), weekendCall: half }))
      .toMatchObject({ md: 3, crna: null });
  });
});

describe('parseWeekendCall', () => {
  it('reads the stored shape', () => {
    expect(parseWeekendCall({ md: 3, crna: 2 })).toEqual({ md: 3, crna: 2 });
  });
  it('reads counts that arrive as strings', () => {
    expect(parseWeekendCall({ md: '3', crna: '2' })).toEqual({ md: 3, crna: 2 });
  });
  it('keeps a genuine zero', () => {
    expect(parseWeekendCall({ md: 0, crna: 2 })).toEqual({ md: 0, crna: 2 });
  });
  it('treats an unconfigured site as null, not as zeros', () => {
    for (const junk of [null, undefined, {}, { md: null, crna: null }, 'x', 3]) {
      expect(parseWeekendCall(junk)).toBeNull();
    }
  });
});
