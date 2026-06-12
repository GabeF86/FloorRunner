import { describe, it, expect } from 'vitest';
import { statusForResult } from './route.helpers';

describe('statusForResult', () => {
  it('returns 200 for a successful (even partial) generation', () => {
    expect(statusForResult({ ok: true, filled: 5, skipped: 2 })).toBe(200);
    expect(statusForResult({ ok: true, filled: 0, skipped: 0 })).toBe(200);
  });
  it('returns 422 for a hard failure (ok=false)', () => {
    expect(statusForResult({ ok: false, filled: 0, skipped: 0 })).toBe(422);
  });
});
