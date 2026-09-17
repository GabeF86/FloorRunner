/**
 * Staffing demand.
 *
 * Two rules carry the whole module: manual beats calculated, and a missing
 * count is NOT zero. The second is the one that matters — a zero would paint
 * an uncounted day green and report an unstaffed hospital as covered, which is
 * exactly what the slot-census version of "needed" used to do.
 */
import { describe, it, expect } from 'vitest';
import { resolveDemand, demandKey, parseDemandInput } from './staffingDemand';

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
