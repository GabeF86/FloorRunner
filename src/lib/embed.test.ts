import { describe, it, expect } from 'vitest';
import { embedArray } from './embed';

describe('embedArray', () => {
  it('wraps a single embedded object (one-to-one PostgREST shape) in an array', () => {
    const row = { id: 'a1', provider_id: 'p1' };
    expect(embedArray(row)).toEqual([row]);
  });

  it('returns an array unchanged (dev-fake / pre-constraint shape)', () => {
    const rows = [{ id: 'a1' }, { id: 'a2' }];
    expect(embedArray(rows)).toBe(rows);
  });

  it('returns [] for an empty array', () => {
    expect(embedArray([])).toEqual([]);
  });

  it('null → [] (one-to-one embed with no row)', () => {
    expect(embedArray(null)).toEqual([]);
  });

  it('undefined → [] (column absent from the payload)', () => {
    expect(embedArray(undefined)).toEqual([]);
  });
});
