import { describe, it, expect } from 'vitest';
import { defaultScheduleName, parseScheduleName, SCHEDULE_NAME_MAX } from './scheduleName';

// Nameable schedules (Gabriel 2026-07-22): "I also want to be able to name
// the draft schedule I am creating so I can keep track of the different
// schedules." defaultScheduleName is the single home of the auto-generated
// name the create flow has always produced (route + create-modal placeholder
// must agree byte-for-byte); parseScheduleName is the route-hardening gate
// for a custom name (POST create override + PATCH inline rename).

describe('defaultScheduleName', () => {
  it('reproduces the historical generated name byte-for-byte', () => {
    expect(defaultScheduleName('Mercy General', '2026-01-07'))
      .toBe('Mercy General - Schedule - January 2026');
    expect(defaultScheduleName('Paoli', '2026-09-07'))
      .toBe('Paoli - Schedule - September 2026');
  });
});

describe('parseScheduleName — POST create (blank falls back to the default)', () => {
  const opts = { blankIsDefault: true } as const;

  it('accepts a custom name TRIMMED', () => {
    expect(parseScheduleName('  Fall Block v2  ', opts)).toEqual({ ok: true, value: 'Fall Block v2' });
  });
  it('absent / null / empty / whitespace-only mean "use the generated default" (value null)', () => {
    expect(parseScheduleName(undefined, opts)).toEqual({ ok: true, value: null });
    expect(parseScheduleName(null, opts)).toEqual({ ok: true, value: null });
    expect(parseScheduleName('', opts)).toEqual({ ok: true, value: null });
    expect(parseScheduleName('   ', opts)).toEqual({ ok: true, value: null });
  });
  it('rejects non-strings', () => {
    expect(parseScheduleName(42, opts).ok).toBe(false);
    expect(parseScheduleName({ name: 'x' }, opts).ok).toBe(false);
  });
  it(`caps length at ${SCHEDULE_NAME_MAX} AFTER trimming`, () => {
    const exact = 'x'.repeat(SCHEDULE_NAME_MAX);
    expect(parseScheduleName(`  ${exact}  `, opts)).toEqual({ ok: true, value: exact });
    const over = parseScheduleName('x'.repeat(SCHEDULE_NAME_MAX + 1), opts);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toMatch(String(SCHEDULE_NAME_MAX));
  });
});

describe('parseScheduleName — PATCH rename (blank is an error)', () => {
  const opts = { blankIsDefault: false } as const;

  it('accepts and trims a rename', () => {
    expect(parseScheduleName(' Renamed ', opts)).toEqual({ ok: true, value: 'Renamed' });
  });
  it('rejects empty / whitespace-only / null (a schedule cannot lose its name)', () => {
    for (const bad of ['', '   ', null, undefined]) {
      const r = parseScheduleName(bad, opts);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/schedule_name/);
    }
  });
  it('rejects over-long and non-string values', () => {
    expect(parseScheduleName('x'.repeat(SCHEDULE_NAME_MAX + 1), opts).ok).toBe(false);
    expect(parseScheduleName(7, opts).ok).toBe(false);
  });
});
