import { describe, it, expect } from 'vitest';
import {
  HIGHLIGHT_COLORS,
  isHighlightColor,
  normalizeHighlightColor,
  parseHighlightColor,
} from './highlightColor';

describe('HIGHLIGHT_COLORS', () => {
  // The SQL CHECK constraint in patch42 lists exactly these three. If this
  // test fails because a colour was added, the patch must change too — a
  // fourth value would be refused by the DB, not stored.
  it('is exactly blue, red, yellow — the DB CHECK vocabulary', () => {
    expect([...HIGHLIGHT_COLORS]).toEqual(['blue', 'red', 'yellow']);
  });
});

describe('isHighlightColor', () => {
  it('accepts the three colours', () => {
    for (const c of HIGHLIGHT_COLORS) expect(isHighlightColor(c)).toBe(true);
  });
  it('rejects near-misses, wrong types and nullish', () => {
    for (const v of ['Blue', 'BLUE', 'green', '', ' blue', 0, 1, true, null, undefined, {}, ['blue']]) {
      expect(isHighlightColor(v)).toBe(false);
    }
  });
});

describe('normalizeHighlightColor', () => {
  it('passes a valid colour through', () => {
    expect(normalizeHighlightColor('yellow')).toBe('yellow');
  });
  it('degrades anything else to null rather than throwing', () => {
    for (const v of [null, undefined, '', 'chartreuse', 7, {}]) {
      expect(normalizeHighlightColor(v)).toBeNull();
    }
  });
});

describe('parseHighlightColor (route hardening)', () => {
  it('accepts each of the three colours', () => {
    for (const c of HIGHLIGHT_COLORS) {
      expect(parseHighlightColor(c)).toEqual({ ok: true, value: c });
    }
  });

  it('accepts null as "clear the manual mark"', () => {
    expect(parseHighlightColor(null)).toEqual({ ok: true, value: null });
  });

  // The whole point of server-side validation: the client is never trusted,
  // and a refused value is a 400 rather than a silent coercion to null (a
  // dropped colour is indistinguishable from a colour that never saved).
  it('refuses anything else — never coerces to null', () => {
    for (const v of ['green', 'Blue', '', ' ', 'blue;drop table', 0, 1, true, undefined, {}, ['blue']]) {
      const parsed = parseHighlightColor(v);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain('blue, red, yellow');
    }
  });
});
