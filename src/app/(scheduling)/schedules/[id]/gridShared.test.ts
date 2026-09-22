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
  it('prefers FIRST INITIAL + SURNAME over the schedule code', () => {
    // Gabriel 2026-09-22. The codes are a compression scheme for a paper
    // spreadsheet; the system has had these people's real names all along.
    expect(providerLabel({
      short_display_name: 'ROSD', first_name: 'David', last_name: 'Rosenbaum',
    })).toBe('D. Rosenbaum');
  });

  it('uses the surname alone when there is no first name', () => {
    expect(providerLabel({ short_display_name: null, last_name: 'Balis' })).toBe('Balis');
  });

  it('still uses the surname even when a code exists', () => {
    // A code must never win over a real name, however partial.
    expect(providerLabel({ short_display_name: 'BALK', last_name: 'Balis' })).toBe('Balis');
  });

  it('falls back to the CODE for the twelve who have no name at all', () => {
    // Created by the master-schedule import under a code. The code is all
    // there is, and showing it keeps them visible as the roster gap they are
    // rather than collapsing them to a dash.
    expect(providerLabel({ short_display_name: 'YONM', last_name: null })).toBe('YONM');
    expect(providerLabel({ short_display_name: 'NGUYN', last_name: '' })).toBe('NGUYN');
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
      { short_display_name: 'ROSD', first_name: 'David', last_name: 'Rosenbaum' },
      { short_display_name: null, last_name: 'Balis' },
      { short_display_name: 'AHMB', first_name: 'Bilal', last_name: 'Ahmad' },
    ];
    expect(() => [...people].sort(byProviderLabel)).not.toThrow();
    // Sorted by what is SHOWN, which is now the name — so Ahmad leads on "B."
    expect([...people].sort(byProviderLabel).map(p => providerLabel(p)))
      .toEqual(['B. Ahmad', 'Balis', 'D. Rosenbaum']);
  });

  it('sorts a list where EVERY name is null', () => {
    const people = [{ last_name: 'Vu' }, { last_name: 'Abdullah' }];
    expect([...people].sort(byProviderLabel).map(p => p.last_name)).toEqual(['Abdullah', 'Vu']);
  });
});
