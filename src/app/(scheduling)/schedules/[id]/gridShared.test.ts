/**
 * Grid provider labelling.
 *
 * `short_display_name` is NULLABLE and 22 active physicians have no value. It
 * was typed `string`, so six grid sorts called `.localeCompare` on it
 * directly. Nothing broke while those physicians had no assignments; importing
 * the group's master schedule on 2026-09-15 gave them some, and the schedule
 * page died on hydration with "a client-side exception has occurred".
 */
import { describe, it, expect } from 'vitest';
import { providerLabel, byProviderLabel } from './gridShared';

describe('providerLabel / byProviderLabel', () => {
  it('prefers the schedule code', () => {
    expect(providerLabel({ short_display_name: 'ROSD', last_name: 'Rosenbaum' })).toBe('ROSD');
  });

  it('falls back to the surname rather than rendering a blank cell', () => {
    // A physician with no code is a roster gap worth SEEING on the grid.
    expect(providerLabel({ short_display_name: null, last_name: 'Balis' })).toBe('Balis');
  });

  it('falls back again to initials', () => {
    expect(providerLabel({ short_display_name: null, last_name: null, initials: 'KB' })).toBe('KB');
  });

  it('never returns an empty label', () => {
    expect(providerLabel({})).toBe('—');
    expect(providerLabel({ short_display_name: '  ', last_name: '' })).toBe('—');
  });

  it('SORTS a null name without throwing — the actual crash', () => {
    const people = [
      { short_display_name: 'ROSD', last_name: 'Rosenbaum' },
      { short_display_name: null, last_name: 'Balis' },
      { short_display_name: 'AHMB', last_name: 'Ahmad' },
    ];
    expect(() => [...people].sort(byProviderLabel)).not.toThrow();
    expect([...people].sort(byProviderLabel).map(p => providerLabel(p)))
      .toEqual(['AHMB', 'Balis', 'ROSD']);
  });

  it('sorts a list where EVERY name is null', () => {
    const people = [{ last_name: 'Vu' }, { last_name: 'Abdullah' }];
    expect([...people].sort(byProviderLabel).map(p => p.last_name)).toEqual(['Abdullah', 'Vu']);
  });
});
