import { describe, it, expect } from 'vitest';
import {
  RequestWindowCreateSchema, IntakeSubmissionSchema,
  windowNotesTag, callRequestsEnabled, countWindowRequestRows,
} from './requestIntake';

// Pure request-window helpers + zod surfaces for the call-request category
// (2026-07-22). The schemas gate bodies before Supabase; the two helpers are
// the single home for "is the call category on?" and the used-count both the
// admin forms and the profile Availability tab render.

describe('RequestWindowCreateSchema — max_call_requests', () => {
  const base = { site_id: 's1', block_start: '2026-09-07', block_end: '2026-11-22' };

  it('accepts an integer cap ≥ 1', () => {
    const r = RequestWindowCreateSchema.safeParse({ ...base, max_call_requests: 1 });
    expect(r.success).toBe(true);
  });
  it('accepts null / omitted (category off)', () => {
    expect(RequestWindowCreateSchema.safeParse({ ...base, max_call_requests: null }).success).toBe(true);
    expect(RequestWindowCreateSchema.safeParse(base).success).toBe(true);
  });
  it('rejects 0 and non-integers', () => {
    expect(RequestWindowCreateSchema.safeParse({ ...base, max_call_requests: 0 }).success).toBe(false);
    expect(RequestWindowCreateSchema.safeParse({ ...base, max_call_requests: 1.5 }).success).toBe(false);
  });
});

describe('IntakeSubmissionSchema — call_dates', () => {
  it('defaults call_dates to [] and validates date shape', () => {
    const r = IntakeSubmissionSchema.parse({ provider_id: 'p1' });
    expect(r.call_dates).toEqual([]);
    expect(IntakeSubmissionSchema.safeParse({ provider_id: 'p1', call_dates: ['nope'] }).success).toBe(false);
    expect(IntakeSubmissionSchema.safeParse({ provider_id: 'p1', call_dates: ['2026-09-10'] }).success).toBe(true);
  });
});

describe('callRequestsEnabled', () => {
  it('true only for an integer cap ≥ 1', () => {
    expect(callRequestsEnabled(1)).toBe(true);
    expect(callRequestsEnabled(6)).toBe(true);
    expect(callRequestsEnabled(0)).toBe(false);
    expect(callRequestsEnabled(null)).toBe(false);
    expect(callRequestsEnabled(undefined)).toBe(false);
  });
});

describe('countWindowRequestRows', () => {
  const rows = [
    { availability_type: 'call_request', notes: windowNotesTag('w1') },
    { availability_type: 'call_request', notes: windowNotesTag('w1') },
    { availability_type: 'call_request', notes: windowNotesTag('w2') }, // other window
    { availability_type: 'call_request', notes: null },                 // untagged
    { availability_type: 'no_call_request', notes: windowNotesTag('w1') },
  ];
  it('counts only rows of the given type tagged to the given window', () => {
    expect(countWindowRequestRows(rows, 'w1', 'call_request')).toBe(2);
    expect(countWindowRequestRows(rows, 'w1', 'no_call_request')).toBe(1);
    expect(countWindowRequestRows(rows, 'w2', 'call_request')).toBe(1);
    expect(countWindowRequestRows(rows, 'w3', 'call_request')).toBe(0);
  });
});
