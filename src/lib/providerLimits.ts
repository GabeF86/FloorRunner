// Per-provider block limits (2026-07-22, patch34) — the single home for the
// scheduling.schedules.provider_limits jsonb shape, its hardened parser, and
// the Pool-modal Limits-tab field helpers.
//
// SHAPE (stored AS-ENTERED — live-lever discipline: a daysOff entry is
// re-derived against PTO at generation time, never frozen into a converted
// number):
//   { [provider_id]: { calls?: { C1?: n, C2?: n, C3?: n, ... },
//                      workingDays?: n, daysOff?: n } }
//
// SEMANTICS (Gabriel 2026-07-22):
//   • calls[code] — hard per-code ceiling for AUTO-GENERATION call placements
//     (seeds/manual assignments count toward it; manual edits bypass it — the
//     same seam as the FTE workdays cap). Slots unfillable under caps stay
//     OPEN and are reported ('provider-cap'), never silently reassigned.
//   • workingDays — overrides the provider's required working-days budget.
//   • daysOff — required = blockWorkingDays − ptoWeekdays − daysOff
//     (single-homed netting in rulesEngine/workDays.ts).
//   • workingDays and daysOff are mutually exclusive per provider.
//   • BLANK (absent field / absent entry / absent column) — VERBATIM AND
//     BINDING (Gabriel): "if the working days allowed or days off is left
//     empty, continue to use the current FTE derived workday budget that is
//     already in place." Absent limits and {} are byte-identical to the
//     pre-limits engine (pinned in providerLimitCaps.test.ts).
//
// Consumers: schedules [id] PATCH (strict parse), rulesEngine/genContext
// (engine load), rulesEngine/loadContext + batchValidate (validation soft
// flags, in parity), scheduleAssistant loadScheduleCtx (read-only summary),
// and the PoolSelectorModal Limits tab (field helpers below).

export interface ProviderLimitEntry {
  calls?: Record<string, number>;
  workingDays?: number;
  daysOff?: number;
}

export type ProviderLimits = Record<string, ProviderLimitEntry>;

export type ParseLimitsResult =
  | { ok: true; value: ProviderLimits | null }
  | { ok: false; error: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/**
 * Hardened parse (route-hardening style): shape-validate, integers >= 0 only,
 * strip unknown keys, reject NaN. `null` clears. Success returns the
 * NORMALIZED value — unknown keys stripped, empty entries dropped, an empty
 * map collapsed to null (blank everywhere = no limit).
 */
export function parseProviderLimits(input: unknown): ParseLimitsResult {
  if (input == null) return { ok: true, value: null };
  if (!isPlainObject(input)) {
    return { ok: false, error: 'provider_limits must be an object keyed by provider id (or null to clear)' };
  }
  const out: ProviderLimits = {};
  for (const [pid, rawEntry] of Object.entries(input)) {
    if (rawEntry == null) continue; // tolerate a nulled-out provider entry
    if (!isPlainObject(rawEntry)) {
      return { ok: false, error: `provider_limits.${pid} must be an object` };
    }
    const entry: ProviderLimitEntry = {};
    const rawCalls = rawEntry.calls;
    if (rawCalls != null) {
      if (!isPlainObject(rawCalls)) {
        return { ok: false, error: `provider_limits.${pid}.calls must be an object of shift code → max` };
      }
      const calls: Record<string, number> = {};
      for (const [code, n] of Object.entries(rawCalls)) {
        if (n == null) continue;
        if (!code || !isCount(n)) {
          return { ok: false, error: `provider_limits.${pid}.calls.${code || '(empty)'} must be an integer >= 0` };
        }
        calls[code] = n;
      }
      if (Object.keys(calls).length > 0) entry.calls = calls;
    }
    const wd = rawEntry.workingDays;
    if (wd != null) {
      if (!isCount(wd)) return { ok: false, error: `provider_limits.${pid}.workingDays must be an integer >= 0` };
      entry.workingDays = wd;
    }
    const off = rawEntry.daysOff;
    if (off != null) {
      if (!isCount(off)) return { ok: false, error: `provider_limits.${pid}.daysOff must be an integer >= 0` };
      entry.daysOff = off;
    }
    if (entry.workingDays != null && entry.daysOff != null) {
      return { ok: false, error: `provider_limits.${pid}: workingDays and daysOff are mutually exclusive` };
    }
    // Unknown keys are stripped by construction (only the three fields above
    // are ever copied). Empty entries are dropped.
    if (entry.calls || entry.workingDays != null || entry.daysOff != null) out[pid] = entry;
  }
  return { ok: true, value: Object.keys(out).length > 0 ? out : null };
}

// ── Pool-modal Limits-tab field helpers (pure) ───────────────────────────────

export interface LimitFields {
  c1: string;
  c2: string;
  c3: string;
  workingDays: string;
  daysOff: string;
}

export const EMPTY_LIMIT_FIELDS: LimitFields = { c1: '', c2: '', c3: '', workingDays: '', daysOff: '' };

/** '' → no limit; a non-negative integer string → its number; anything else → undefined. */
export function parseLimitInput(s: string): number | undefined {
  const t = s.trim();
  if (t === '') return undefined;
  if (!/^\d+$/.test(t)) return undefined;
  return Number(t);
}

/** Non-blank input that does not parse — for inline invalid styling. */
export function isInvalidLimitInput(s: string): boolean {
  return s.trim() !== '' && parseLimitInput(s) === undefined;
}

export function fieldsFromEntry(e: ProviderLimitEntry | undefined): LimitFields {
  const n = (v: number | undefined) => (v == null ? '' : String(v));
  return {
    c1: n(e?.calls?.C1),
    c2: n(e?.calls?.C2),
    c3: n(e?.calls?.C3),
    workingDays: n(e?.workingDays),
    daysOff: n(e?.daysOff),
  };
}

/**
 * Build an entry from the five column inputs. Blank everywhere → undefined
 * (no limit). workingDays wins if both day fields are somehow filled (the UI
 * enforces mutual exclusion; this keeps the helper deterministic). Call codes
 * outside C1–C3 on the EXISTING entry are preserved — the tab edits only its
 * three columns.
 */
export function entryFromFields(
  f: LimitFields,
  existing?: ProviderLimitEntry,
): ProviderLimitEntry | undefined {
  const calls: Record<string, number> = {};
  for (const [code, n] of Object.entries(existing?.calls ?? {})) {
    if (code !== 'C1' && code !== 'C2' && code !== 'C3') calls[code] = n;
  }
  const c1 = parseLimitInput(f.c1);
  const c2 = parseLimitInput(f.c2);
  const c3 = parseLimitInput(f.c3);
  if (c1 != null) calls.C1 = c1;
  if (c2 != null) calls.C2 = c2;
  if (c3 != null) calls.C3 = c3;
  const entry: ProviderLimitEntry = {};
  if (Object.keys(calls).length > 0) entry.calls = calls;
  const wd = parseLimitInput(f.workingDays);
  const off = parseLimitInput(f.daysOff);
  if (wd != null) entry.workingDays = wd;
  else if (off != null) entry.daysOff = off;
  return entry.calls || entry.workingDays != null || entry.daysOff != null ? entry : undefined;
}

/** Drop empty entries; an empty map is stored as null (= no limits). */
export function normalizeProviderLimits(l: ProviderLimits): ProviderLimits | null {
  const out: ProviderLimits = {};
  for (const [pid, e] of Object.entries(l)) {
    const hasCalls = !!e.calls && Object.keys(e.calls).length > 0;
    if (!hasCalls && e.workingDays == null && e.daysOff == null) continue;
    const entry: ProviderLimitEntry = {};
    if (hasCalls) entry.calls = e.calls;
    if (e.workingDays != null) entry.workingDays = e.workingDays;
    else if (e.daysOff != null) entry.daysOff = e.daysOff;
    out[pid] = entry;
  }
  return Object.keys(out).length > 0 ? out : null;
}
