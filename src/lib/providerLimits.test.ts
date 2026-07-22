import { describe, it, expect } from 'vitest';
import {
  parseProviderLimits,
  parseLimitInput,
  isInvalidLimitInput,
  fieldsFromEntry,
  entryFromFields,
  normalizeProviderLimits,
  type ProviderLimits,
} from './providerLimits';

// ── parseProviderLimits — the hardened route/loader gate ─────────────────────
// Route-hardening style: shape-validate, integers >= 0 only, strip unknown
// keys, reject NaN. Returns the NORMALIZED value (stripped) on success.

describe('parseProviderLimits', () => {
  it('accepts a full valid shape and returns it normalized', () => {
    const input = {
      'pid-1': { calls: { C1: 2, C2: 0 }, workingDays: 15 },
      'pid-2': { daysOff: 4 },
    };
    const r = parseProviderLimits(input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({
        'pid-1': { calls: { C1: 2, C2: 0 }, workingDays: 15 },
        'pid-2': { daysOff: 4 },
      });
    }
  });

  it('null clears (ok, value null)', () => {
    const r = parseProviderLimits(null);
    expect(r).toEqual({ ok: true, value: null });
  });

  it('an empty object normalizes to null (blank everywhere = no limit)', () => {
    const r = parseProviderLimits({});
    expect(r).toEqual({ ok: true, value: null });
  });

  it('rejects non-object roots (array, string, number)', () => {
    expect(parseProviderLimits([]).ok).toBe(false);
    expect(parseProviderLimits('nope').ok).toBe(false);
    expect(parseProviderLimits(7).ok).toBe(false);
  });

  it('rejects a non-object entry', () => {
    expect(parseProviderLimits({ 'pid-1': 3 }).ok).toBe(false);
    expect(parseProviderLimits({ 'pid-1': [1] }).ok).toBe(false);
  });

  it('rejects NaN, negatives, fractions, and string numbers in calls', () => {
    expect(parseProviderLimits({ p: { calls: { C1: NaN } } }).ok).toBe(false);
    expect(parseProviderLimits({ p: { calls: { C1: -1 } } }).ok).toBe(false);
    expect(parseProviderLimits({ p: { calls: { C1: 1.5 } } }).ok).toBe(false);
    expect(parseProviderLimits({ p: { calls: { C1: '3' } } }).ok).toBe(false);
  });

  it('rejects invalid workingDays / daysOff values', () => {
    expect(parseProviderLimits({ p: { workingDays: -2 } }).ok).toBe(false);
    expect(parseProviderLimits({ p: { workingDays: NaN } }).ok).toBe(false);
    expect(parseProviderLimits({ p: { daysOff: 2.5 } }).ok).toBe(false);
    expect(parseProviderLimits({ p: { daysOff: '4' } }).ok).toBe(false);
  });

  it('rejects workingDays and daysOff together (mutually exclusive)', () => {
    expect(parseProviderLimits({ p: { workingDays: 10, daysOff: 2 } }).ok).toBe(false);
  });

  it('strips unknown keys', () => {
    const r = parseProviderLimits({ p: { calls: { C1: 2 }, sneaky: true } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ p: { calls: { C1: 2 } } });
  });

  it('treats explicit null field values as absent', () => {
    const r = parseProviderLimits({ p: { calls: { C1: 1 }, workingDays: null, daysOff: null } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ p: { calls: { C1: 1 } } });
  });

  it('drops empty entries (and returns null when nothing is left)', () => {
    const r = parseProviderLimits({ p: {}, q: { calls: {} } });
    expect(r).toEqual({ ok: true, value: null });
    const r2 = parseProviderLimits({ p: {}, q: { calls: { C2: 3 } } });
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.value).toEqual({ q: { calls: { C2: 3 } } });
  });
});

// ── UI input helpers ─────────────────────────────────────────────────────────

describe('parseLimitInput / isInvalidLimitInput', () => {
  it('blank means no limit', () => {
    expect(parseLimitInput('')).toBeUndefined();
    expect(parseLimitInput('   ')).toBeUndefined();
    expect(isInvalidLimitInput('')).toBe(false);
  });

  it('parses non-negative integers (whitespace tolerated)', () => {
    expect(parseLimitInput('0')).toBe(0);
    expect(parseLimitInput(' 4 ')).toBe(4);
  });

  it('rejects negatives, fractions, and garbage', () => {
    expect(parseLimitInput('-1')).toBeUndefined();
    expect(parseLimitInput('1.5')).toBeUndefined();
    expect(parseLimitInput('abc')).toBeUndefined();
    expect(isInvalidLimitInput('-1')).toBe(true);
    expect(isInvalidLimitInput('abc')).toBe(true);
    expect(isInvalidLimitInput('3')).toBe(false);
  });
});

describe('fieldsFromEntry / entryFromFields', () => {
  it('round-trips an entry through field strings', () => {
    const entry = { calls: { C1: 1, C3: 2 }, daysOff: 3 };
    const fields = fieldsFromEntry(entry);
    expect(fields).toEqual({ c1: '1', c2: '', c3: '2', workingDays: '', daysOff: '3' });
    expect(entryFromFields(fields)).toEqual(entry);
  });

  it('all-blank fields mean no entry', () => {
    expect(entryFromFields({ c1: '', c2: '', c3: '', workingDays: '', daysOff: '' })).toBeUndefined();
    expect(fieldsFromEntry(undefined)).toEqual({ c1: '', c2: '', c3: '', workingDays: '', daysOff: '' });
  });

  it('workingDays wins when both fields are somehow filled (UI enforces exclusivity)', () => {
    const e = entryFromFields({ c1: '', c2: '', c3: '', workingDays: '10', daysOff: '2' });
    expect(e).toEqual({ workingDays: 10 });
  });

  it('preserves call codes outside C1–C3 from the existing entry', () => {
    const existing = { calls: { NB: 1, C1: 5 } };
    const e = entryFromFields({ c1: '2', c2: '', c3: '', workingDays: '', daysOff: '' }, existing);
    expect(e).toEqual({ calls: { NB: 1, C1: 2 } });
  });
});

describe('normalizeProviderLimits', () => {
  it('drops empty entries and returns null for an empty map', () => {
    const limits: ProviderLimits = { p: { calls: { C1: 1 } } };
    expect(normalizeProviderLimits(limits)).toEqual({ p: { calls: { C1: 1 } } });
    expect(normalizeProviderLimits({})).toBeNull();
    expect(normalizeProviderLimits({ p: {} })).toBeNull();
    expect(normalizeProviderLimits({ p: { calls: {} } })).toBeNull();
  });
});
