// validateAvailabilityPatch — the PATCH /api/scheduling/availability/[id]
// hardening gate (2026-07-20 audit follow-up): whitelist-only fields, enum
// membership, ISO dates, loud 400 on unknown keys (no more raw-body mass
// assignment). Plus pins for the pto_sellback additions to the shared
// availability-type vocabulary.
import { describe, it, expect } from 'vitest';
import {
  validateAvailabilityPatch,
  AVAILABILITY_PATCH_FIELDS,
  AVAILABILITY_TYPES,
  AVAILABILITY_TYPE_LABELS,
  validateAndSplitPatch,
  PROFILE_COLUMNS,
  PROVIDER_COLUMNS,
  FTE_MAX,
  WORK_DAYS_FTE_MIN,
  WORK_DAYS_FTE_MAX,
} from './providers';

describe('validateAvailabilityPatch', () => {
  it('accepts a full valid patch and returns only whitelisted fields', () => {
    const r = validateAvailabilityPatch({
      start_date: '2026-07-06', end_date: '2026-07-10',
      notes: 'moved a day', availability_type: 'pto', approval_status: 'approved',
    });
    expect(r.ok).toBe(true);
    expect(r.fields).toEqual({
      start_date: '2026-07-06', end_date: '2026-07-10',
      notes: 'moved a day', availability_type: 'pto', approval_status: 'approved',
    });
  });

  it('accepts a partial patch (single endpoint move)', () => {
    const r = validateAvailabilityPatch({ end_date: '2026-07-11' });
    expect(r.ok).toBe(true);
    expect(r.fields).toEqual({ end_date: '2026-07-11' });
  });

  it('rejects unknown fields loudly — mass assignment is dead', () => {
    for (const key of ['provider_id', 'site_id', 'source', 'id', 'all_day', 'reason_code', 'nonsense']) {
      const r = validateAvailabilityPatch({ [key]: 'x' });
      expect(r.ok, key).toBe(false);
      expect(r.error).toContain(`unknown field: ${key}`);
    }
  });

  it('rejects a valid field alongside an unknown one (no partial acceptance)', () => {
    const r = validateAvailabilityPatch({ end_date: '2026-07-11', provider_id: 'p2' });
    expect(r.ok).toBe(false);
  });

  it('rejects malformed dates', () => {
    for (const bad of ['2026-7-6', '07/06/2026', '2026-13-01', 'tomorrow', 20260706, null]) {
      expect(validateAvailabilityPatch({ start_date: bad }).ok, String(bad)).toBe(false);
      expect(validateAvailabilityPatch({ end_date: bad }).ok, String(bad)).toBe(false);
    }
  });

  it('rejects format-valid but impossible calendar dates (JS Date rollover)', () => {
    // Date('2026-02-30') would roll over to Mar 2 and reach Postgres, which
    // rejects it with a 500 instead of the promised 400. The round-trip guard
    // in isValidDate catches these.
    for (const bad of ['2026-02-30', '2026-02-29', '2026-04-31', '2026-06-31', '2026-00-10', '2026-01-00']) {
      expect(validateAvailabilityPatch({ start_date: bad }).ok, bad).toBe(false);
      expect(validateAvailabilityPatch({ end_date: bad }).ok, bad).toBe(false);
    }
    // Real leap day stays valid.
    expect(validateAvailabilityPatch({ start_date: '2024-02-29' }).ok).toBe(true);
    expect(validateAvailabilityPatch({ end_date: '2028-02-29' }).ok).toBe(true);
  });

  it('rejects availability_type outside the allowed set; accepts every member incl. pto_sellback', () => {
    expect(validateAvailabilityPatch({ availability_type: 'vacation' }).ok).toBe(false);
    expect(validateAvailabilityPatch({ availability_type: 7 }).ok).toBe(false);
    for (const t of AVAILABILITY_TYPES) {
      expect(validateAvailabilityPatch({ availability_type: t }).ok, t).toBe(true);
    }
    expect(validateAvailabilityPatch({ availability_type: 'pto_sellback' }).ok).toBe(true);
  });

  it('rejects approval_status outside the enum', () => {
    expect(validateAvailabilityPatch({ approval_status: 'maybe' }).ok).toBe(false);
    expect(validateAvailabilityPatch({ approval_status: 'approved' }).ok).toBe(true);
    expect(validateAvailabilityPatch({ approval_status: 'pending' }).ok).toBe(true);
  });

  it('notes: string or null; empty string normalizes to null; other types rejected', () => {
    expect(validateAvailabilityPatch({ notes: 'hi' }).fields.notes).toBe('hi');
    expect(validateAvailabilityPatch({ notes: null }).fields.notes).toBe(null);
    expect(validateAvailabilityPatch({ notes: '' }).fields.notes).toBe(null);
    expect(validateAvailabilityPatch({ notes: 42 }).ok).toBe(false);
  });

  it('rejects non-object bodies and empty patches', () => {
    expect(validateAvailabilityPatch(null).ok).toBe(false);
    expect(validateAvailabilityPatch('pto').ok).toBe(false);
    expect(validateAvailabilityPatch([]).ok).toBe(false);
    const empty = validateAvailabilityPatch({});
    expect(empty.ok).toBe(false);
    expect(empty.error).toContain('no updatable fields');
  });
});

describe('availability-type vocabulary (pto_sellback, patch31)', () => {
  it('AVAILABILITY_TYPES includes pto_sellback', () => {
    expect(AVAILABILITY_TYPES as readonly string[]).toContain('pto_sellback');
  });
  it('every availability type has a display label', () => {
    for (const t of AVAILABILITY_TYPES) {
      expect(typeof AVAILABILITY_TYPE_LABELS[t], t).toBe('string');
      expect(AVAILABILITY_TYPE_LABELS[t].length, t).toBeGreaterThan(0);
    }
    expect(AVAILABILITY_TYPE_LABELS.pto_sellback).toBe('PTO Sell-Back');
  });
  it('the patch whitelist is exactly the five updatable fields', () => {
    expect([...AVAILABILITY_PATCH_FIELDS].sort()).toEqual(
      ['approval_status', 'availability_type', 'end_date', 'notes', 'start_date'],
    );
  });
});

// ── work_days_fte, the WORKING-DAYS FTE (patch43) ───────────────────────────
// The write gate for the second FTE. Two things must hold or the column is
// dangerous: BLANK has to reach the DB as a real NULL ("same as FTE"), never
// as 0 ("owes no working days"); and the range has to be 0..1, narrower than
// fte_value's 0..2, because nobody can be obligated for more working days than
// the block contains.
describe('validateAndSplitPatch — work_days_fte', () => {
  const split = (v: unknown) => validateAndSplitPatch({ work_days_fte: v });

  it('routes to the employment profile, not the providers table', () => {
    expect(PROFILE_COLUMNS as readonly string[]).toContain('work_days_fte');
    expect(PROVIDER_COLUMNS as readonly string[]).not.toContain('work_days_fte');
    const r = split(1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.profileFields).toEqual({ work_days_fte: 1 });
    expect(r.providerFields).toEqual({});
  });

  it('BLANK becomes NULL — the "same as FTE" state, never 0', () => {
    for (const blank of ['', null]) {
      const r = split(blank);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.profileFields.work_days_fte).toBeNull();
      expect(r.profileFields.work_days_fte).not.toBe(0);
    }
  });

  it('accepts the range 0..1 inclusive, coercing numeric strings', () => {
    for (const v of [0, 0.5, 0.66, '0.75', 1, '1']) {
      const r = split(v);
      expect(r.ok, String(v)).toBe(true);
      if (r.ok) expect(typeof r.profileFields.work_days_fte).toBe('number');
    }
  });

  it('rejects above 1 — a working-days FTE over 1 is a typo, not a policy', () => {
    // fte_value legitimately reaches 2 (the two-jobs partner); this must not.
    expect(split(1.5).ok).toBe(false);
    expect(split(2).ok).toBe(false);
    expect(split(-0.1).ok).toBe(false);
    expect(split('abc').ok).toBe(false);
    const r = split(2);
    if (!r.ok) expect(r.error).toContain('work_days_fte');
  });

  it('the range constants are the narrower 0..1, distinct from FTE_MIN/MAX', () => {
    expect(WORK_DAYS_FTE_MIN).toBe(0);
    expect(WORK_DAYS_FTE_MAX).toBe(1);
    expect(FTE_MAX).toBe(2); // unchanged — the call FTE keeps its headroom
  });
});
