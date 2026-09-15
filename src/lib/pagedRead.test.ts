import { describe, it, expect } from 'vitest';
import { readAllRows, truncationOf, PAGE_SIZE, MAX_PAGES } from './pagedRead';

/** A fake PostgREST page source holding `total` rows. */
function source(total: number, opts: { failOn?: number; nullCount?: boolean; stallAt?: number } = {}) {
  const calls: Array<[number, number]> = [];
  const build = async (from: number, to: number) => {
    calls.push([from, to]);
    if (opts.failOn === calls.length) return { data: null, error: { message: 'boom' }, count: null };
    if (opts.nullCount) return { data: [], error: null, count: null };
    if (opts.stallAt != null && from >= opts.stallAt) return { data: [], error: null, count: total };
    const rows = [];
    for (let i = from; i <= Math.min(to, total - 1); i++) rows.push({ id: i });
    return { data: rows, error: null, count: total };
  };
  return { build, calls };
}

describe('readAllRows', () => {
  it('returns everything in one page when it fits', async () => {
    const { build, calls } = source(42);
    const r = await readAllRows<{ id: number }>(build, 'slots');
    expect(r.error).toBeNull();
    expect(r.rows).toHaveLength(42);
    expect(calls).toHaveLength(1);
  });

  it('pages past the 1000-row cap — the bug this exists for', async () => {
    // Verified against the live database: an un-ranged select on a 1,225-row
    // table returns exactly 1,000 with error null.
    const { build, calls } = source(1225);
    const r = await readAllRows<{ id: number }>(build, 'slots');
    expect(r.error).toBeNull();
    expect(r.rows).toHaveLength(1225);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual([0, 999]);
    expect(calls[1]).toEqual([1000, 1999]);
  });

  it('loses no row and duplicates none across pages', async () => {
    const r = await readAllRows<{ id: number }>(source(2500).build, 'slots');
    expect(r.rows.map(x => x.id)).toEqual(Array.from({ length: 2500 }, (_, i) => i));
  });

  it('returns NO rows alongside an error, never a partial array', async () => {
    // The whole contract: a caller checking `error` first can never proceed on
    // half the data. A partial array with a null error is the original bug.
    const r = await readAllRows(source(2500, { failOn: 2 }).build, 'slots');
    expect(r.error).toMatch(/boom/);
    expect(r.rows).toEqual([]);
  });

  it('treats a missing count as a failure rather than trusting the array', async () => {
    const r = await readAllRows(source(10, { nullCount: true }).build, 'slots');
    expect(r.error).toMatch(/count unavailable/);
    expect(r.rows).toEqual([]);
  });

  it('fails when pagination stalls short of the count', async () => {
    const r = await readAllRows(source(2500, { stallAt: 1000 }).build, 'slots');
    expect(r.error).toMatch(/stalled at 1000 of 2500/);
    expect(r.rows).toEqual([]);
  });

  it('gives up rather than looping forever', async () => {
    // A dropped filter, not growth: the whole slots table is 1,225 rows.
    const huge = source(PAGE_SIZE * (MAX_PAGES + 5));
    const r = await readAllRows(huge.build, 'slots');
    expect(r.error).toMatch(new RegExp(`${MAX_PAGES}-page budget`));
    expect(huge.calls).toHaveLength(MAX_PAGES);
  });

  it('handles a genuinely empty table', async () => {
    const r = await readAllRows(source(0).build, 'slots');
    expect(r.error).toBeNull();
    expect(r.rows).toEqual([]);
  });

  it('labels its errors so a caller can say what failed', async () => {
    const r = await readAllRows(source(5, { failOn: 1 }).build, 'cross-site conflicts');
    expect(r.error).toMatch(/^cross-site conflicts:/);
  });
});

describe('truncationOf', () => {
  it('passes a complete read', () => {
    expect(truncationOf({ data: [1, 2, 3], count: 3 }, 'x')).toBeNull();
  });

  it('catches a short read', () => {
    expect(truncationOf({ data: new Array(1000), count: 1225 }, 'Slots'))
      .toBe('Slots: read truncated (1000 of 1225 rows)');
  });

  it('treats a null count as an anomaly, not as permission', () => {
    // A null count means the { count: 'exact' } option was dropped. Believing
    // the array at that point is exactly the mistake.
    expect(truncationOf({ data: [1], count: null }, 'Slots')).toMatch(/count unavailable/);
  });

  it('copes with a non-array body', () => {
    expect(truncationOf({ data: null, count: 5 }, 'Slots')).toMatch(/0 of 5/);
  });
});
