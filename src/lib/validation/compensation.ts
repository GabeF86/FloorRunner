// Validation helper for provider_compensation writes. All fields are optional
// nullable numerics except the retention_bonus_end_date (date) and notes (text).
// We normalize empty strings to null and reject negative / non-finite numbers
// so the DB's numeric(12,2) constraint is never the first line of defense.

import { isValidDate } from './providers';

const NUMERIC_FIELDS = [
  'base_salary',
  'fellowship_stipend',
  'admin_stipend',
  'retention_bonus',
  'health_insurance_cost',
  'malpractice_cost',
  'retirement_401k_contribution',
  'profit_share',
] as const;

export const COMPENSATION_FIELDS = [
  ...NUMERIC_FIELDS,
  'retention_bonus_end_date',
  'notes',
] as const;

export type CompensationField = typeof COMPENSATION_FIELDS[number];

export type CompensationValidation =
  | { ok: true; row: Record<string, unknown> }
  | { ok: false; error: string };

export function validateCompensation(body: Record<string, unknown>): CompensationValidation {
  const row: Record<string, unknown> = {};

  for (const field of NUMERIC_FIELDS) {
    if (!(field in body)) continue;
    const raw = body[field];
    if (raw === null || raw === '' || raw === undefined) {
      row[field] = null;
      continue;
    }
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n)) {
      return { ok: false, error: `${field} must be a number` };
    }
    if (n < 0) {
      return { ok: false, error: `${field} must be non-negative` };
    }
    // DB is numeric(12,2) — cap at 10 digits before the decimal.
    if (n >= 10_000_000_000) {
      return { ok: false, error: `${field} exceeds the 10-digit limit` };
    }
    row[field] = n;
  }

  if ('retention_bonus_end_date' in body) {
    const raw = body.retention_bonus_end_date;
    if (raw === null || raw === '' || raw === undefined) {
      row.retention_bonus_end_date = null;
    } else if (typeof raw !== 'string' || !isValidDate(raw)) {
      return { ok: false, error: 'retention_bonus_end_date must be YYYY-MM-DD' };
    } else {
      row.retention_bonus_end_date = raw;
    }
  }

  if ('notes' in body) {
    const raw = body.notes;
    if (raw === null || raw === '' || raw === undefined) {
      row.notes = null;
    } else if (typeof raw !== 'string') {
      return { ok: false, error: 'notes must be a string' };
    } else {
      row.notes = raw;
    }
  }

  return { ok: true, row };
}
