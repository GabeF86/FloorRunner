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
