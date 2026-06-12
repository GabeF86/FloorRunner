import { describe, it, expect } from 'vitest';
import { missingFields, nextPosition } from './boardApi';

describe('missingFields', () => {
  it('lists keys that are absent / null / undefined / empty string', () => {
    expect(missingFields({ a: 1, b: 'x' }, ['a', 'b'])).toEqual([]);
    expect(missingFields({ a: 1 }, ['a', 'b'])).toEqual(['b']);
    expect(missingFields({ a: null, b: '' }, ['a', 'b'])).toEqual(['a', 'b']);
    expect(missingFields({ a: 0 }, ['a'])).toEqual([]); // 0 is a valid value
    expect(missingFields({ a: false }, ['a'])).toEqual([]); // false is valid
  });
});

describe('nextPosition', () => {
  it('returns max(position)+1, or 0 for an empty set', () => {
    expect(nextPosition([])).toBe(0);
    expect(nextPosition([{ position: 0 }, { position: 3 }, { position: 1 }])).toBe(4);
    expect(nextPosition([{ position: null }, { position: 2 }])).toBe(3);
  });
});
