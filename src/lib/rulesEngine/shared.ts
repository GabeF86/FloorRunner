// Shared helpers for the scheduling rules engine.
//
// Split out of autoGenerate.ts and dayShiftAutoGen.ts after both files
// ended up with their own near-identical copies of date math, availability
// constants, PTO bookend logic, etc. Everything in here is pure
// (no I/O, no mutable state) — the two schedulers own their own query
// boilerplate and call into this module for the fiddly math.

import type { CandidateProvider, AvailabilityEntry, SlotToFill } from './genTypes';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SupabaseClient = any;

// ── Pre-patch18 degraded-mode error classifiers (single home) ───────────────
// The graceful-degradation loaders (genContext, sequenceAutoFill,
// dayShiftAutoGen) distinguish "this DB predates the patch" from a genuine
// read failure. Consolidated predicates only — each caller keeps its own
// bespoke degradation behavior.

// A Supabase/PostgREST error indicating a queried COLUMN doesn't exist
// (pre-patch18 DB, or patch18 partly applied). 42703 = undefined_column.
export function isMissingColumnError(
  err: { code?: string; message?: string } | null | undefined,
): boolean {
  if (!err) return false;
  if (err.code === '42703') return true;
  return /column/i.test(err.message || '');
}

// A Supabase/PostgREST error indicating the queried RELATION doesn't exist yet
// (pre-patch18 live DB). Distinct from a plain "no row" result (data:null,
// error:null). 42P01 = undefined_table.
export function isMissingRelationError(error: unknown): boolean {
  const e = error as { message?: string; code?: string } | null;
  if (!e) return false;
  if (e.code === '42P01') return true; // undefined_table
  return /does not exist|could not find the table|schema cache/i.test(e.message || '');
}

// Availability types that block an assignment entirely. A provider with
// any entry of one of these types covering the slot date is not eligible.
export const BLOCKING_AVAIL: ReadonlySet<string> = new Set([
  'pto', 'sick', 'fmla', 'parental_leave', 'military_leave',
  'jury_duty', 'unavailable', 'blocked',
]);

// An availability entry the scheduler ignores entirely: the request was
// denied or canceled. Counterpart of isBlockingAvailability for availability
// types outside BLOCKING_AVAIL (e.g. no_call_request soft flags) that still
// need the same status semantics.
export function isDismissedAvailability(entry: { approval_status: string }): boolean {
  return entry.approval_status === 'denied' || entry.approval_status === 'canceled';
}

// Single-home predicate for a LIVE no-call request (2026-07-17). NOT a
// blocking type — the request is algorithm-arbitrated (soft): the call
// engine's scoreCall drops live requesters a sort tier (solve.ts) and
// validation soft-flags any call that still lands on one (evaluators.ts
// timeOff). Both consumers route through here so they can never disagree
// about which requests are live (pending counts; denied/canceled don't).
export function isActiveNoCallRequest(
  entry: { availability_type: string; approval_status: string },
): boolean {
  return entry.availability_type === 'no_call_request' && !isDismissedAvailability(entry);
}

// Canonical "does this availability entry block scheduling?" predicate
// (clinical invariant 2 / spec §6.7): PENDING requests BLOCK — only entries
// explicitly denied or canceled are ignored. Every engine (call gen, day-shift
// gen, eligibility, pre-PTO placement, validation) must route through this so
// no two engines can disagree about a pending request.
export function isBlockingAvailability(
  entry: { availability_type: string; approval_status: string },
): boolean {
  return !isDismissedAvailability(entry) && BLOCKING_AVAIL.has(entry.availability_type);
}

// ── PTO sell-back date-level override (2026-07-20) ──────────────────────────
// A LIVE pto_sellback row means the provider IS WORKING those dates: the chief
// bought the PTO back. It is NOT a blocking type (isBlockingAvailability stays
// the row-level classifier and never matches it) — instead it overrides other
// rows' blocking coverage at the DATE level: a date covered by a live sell-back
// row is not blocked even if PTO/other blocking rows cover it, INCLUDING
// pending PTO (invariant-2 nuance: pending still blocks everywhere else; the
// override is the feature's meaning — ALGORITHM.md §6). Sold-back weekdays are
// owed again in the working-days budget (ptoWeekdaysCovered, workDays.ts).

// Row-level: a sell-back row the engine honors (denied/canceled are ignored,
// same status semantics as every other availability row).
export function isActiveSellback(
  entry: { availability_type: string; approval_status: string },
): boolean {
  return entry.availability_type === 'pto_sellback' && !isDismissedAvailability(entry);
}

// Date-level: is `date` covered by any live sell-back row? The one home for
// the override-coverage decision — isDateBlocked composes it, and consumers
// that need the raw coverage (validation timeOff's per-row messages, the
// working-days netting) consult it directly so nothing can disagree.
// Sell-back rows are matched on their RAW dates (a working row never gets the
// PTO weekend bookend), but the override applies to bookend-EXTENDED blocking
// coverage too: selling back the Saturday a Monday-start PTO bookends over
// unblocks that Saturday.
export function isSellbackOverridden(
  entries: ReadonlyArray<{ availability_type: string; start_date: string; end_date: string; approval_status: string }>,
  date: string,
): boolean {
  for (const a of entries) {
    if (isActiveSellback(a) && datesOverlap(a.start_date, a.end_date, date)) return true;
  }
  return false;
}

// THE single-homed per-date blocking decision: `date` is blocked iff some
// non-dismissed blocking row covers it AND no live sell-back row covers it.
// Every engine consumer of isBlockingAvailability's PER-DATE decisions routes
// through here (eligibility's availability gate, dayShiftAutoGen's blocked-date
// precompute, sequenceAutoFill's linked-day check, the assistant's open-slot
// hints); isBlockingAvailability remains the ROW-level classifier for
// non-date-specific uses (pre-PTO Thursday index, weekend-adjacent-week
// exclusion — both deliberately row-based, see ALGORITHM.md §6).
// opts.bookend applies the §6 weekend-bookend extension (effectivePtoRange) to
// blocking rows — pass true where the consumer historically bookended
// (eligibility, dayShiftAutoGen); omit for RAW-range consumers (validation
// timeOff, sequence linked-day, hints). With zero sell-back rows this is
// exactly the pre-change any-blocking-row-covers decision. Byte-identical
// engine output is pinned by the FILL-MODE GOLDEN PLANS (fillAllPlan.golden
// + the obligatoryMode/noCallRequests plan pins), which run solve() with the
// live shared eligibility path. Golden parity alone CANNOT catch a change
// here: solveLegacy imports the live evaluateEligibility, so a shared-
// eligibility mutation shifts both sides identically and parity stays green.
export function isDateBlocked(
  entries: ReadonlyArray<{ availability_type: string; start_date: string; end_date: string; approval_status: string }>,
  date: string,
  opts?: { bookend?: boolean },
): boolean {
  if (isSellbackOverridden(entries, date)) return false;
  for (const a of entries) {
    if (!isBlockingAvailability(a)) continue;
    const r = opts?.bookend ? effectivePtoRange(a) : { start: a.start_date, end: a.end_date };
    if (datesOverlap(r.start, r.end, date)) return true;
  }
  return false;
}

// ── Overlay coexistence (single home for the decision table) ────────────────
// May an EXISTING same-site, same-date assignment and an INCOMING placement
// coexist? The is_overlay exemption is deliberately NARROW and two-sided —
// it exempts REGULAR↔OVERLAY-CALL pairs only (Doc C's Fri D4 day shift + Fri
// C3 evening neuro overlay call), in either placement order:
//   existing OVERLAY row + incoming NON-CALL  → coexist
//   incoming OVERLAY     + existing REGULAR   → coexist
//   call + call (either overlay)              → collide (never stack)
//   everything else                           → collide
// Missing/undefined is_overlay ⇒ non-overlay — the conservative pre-overlay
// behavior (degraded pre-patch18 loads therefore collide on every pair).
// Cross-site pairs are NEVER exempt (a genuine two-places conflict) — callers
// keep same-site scoping local.
// Consumers: sequenceAutoFill's coexists() routes through this directly.
// eligibility's same-date / call-on-call / blockedOnDate trio and
// dayShiftAutoGen's seed-time occupancy skip realize the SAME table
// incrementally against their own state shapes (SolveState maps / occupancy
// sets) where the existing side is implicit — see the cross-references there.
export function overlayMayCoexist(
  existing: { category?: string | null; is_overlay?: boolean | null },
  incoming: { category?: string | null; is_overlay?: boolean | null },
): boolean {
  return (existing.is_overlay === true && incoming.category !== 'call')
    || (incoming.is_overlay === true && existing.category === 'regular');
}

// Multi-day planned-leave types that also trigger a weekend-bookend
// extension. Ad-hoc single-day types (sick, jury_duty, unavailable,
// blocked) are intentionally left out — extending them would swallow
// weekends for one-off days that shouldn't.
export const BOOKEND_EXTENDING_TYPES: ReadonlySet<string> = new Set([
  'pto', 'fmla', 'parental_leave', 'military_leave',
]);

// ── Validation lookback/lookahead windows (days) ────────────────────────────
// Shared by the serial (loadContext) and batch (batchValidate) validation
// paths so their windows cannot drift — batch/serial parity depends on it.
//
// NEIGHBOR_WINDOW_DAYS: a provider's other assignments around the slot; ±31
// so frequency/fairness checks see a full month on each side.
// AVAIL_WINDOW_DAYS: PTO/unavailability rows around the slot; ±14 covers the
// weekend-adjacent-PTO check's widest reach.
export const NEIGHBOR_WINDOW_DAYS = 31;
export const AVAIL_WINDOW_DAYS = 14;

// ── Date math (YYYY-MM-DD strings, no Date objects leaking) ─────────────────
// Memoized (2026-07-20 perf): Date-string parsing was ~74% of all engine CPU
// (daysBetween via daysSinceLastCall/hadCallWithin, addDays via
// evaluateEligibility + sequenceOwnership, dayOfWeekUTC). Module-level Map
// caches are observably behavior-free — pure functions of their string
// inputs, cached values computed by exactly the pre-memo expression on first
// use. Growth is bounded: a block touches only ~30-90 distinct date strings
// (plus small offset sets), and serverless processes are short-lived.

const addDaysCache = new Map<string, string>();
export function addDays(iso: string, n: number): string {
  const key = iso + '|' + n;
  let v = addDaysCache.get(key);
  if (v === undefined) {
    const d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    v = d.toISOString().slice(0, 10);
    addDaysCache.set(key, v);
  }
  return v;
}

const dayOfWeekCache = new Map<string, number>();
export function dayOfWeekUTC(iso: string): number {
  let v = dayOfWeekCache.get(iso);
  if (v === undefined) {
    v = new Date(iso + 'T00:00:00Z').getUTCDay(); // 0=Sun..6=Sat
    dayOfWeekCache.set(iso, v);
  }
  return v;
}

// Day-of-week → derived day type. Single home for the DOW fallback mapping
// (sequenceOwnership's out-of-block anchors; test fixtures). Holiday typing is
// unknowable from the DOW alone — callers relying on this fallback must scope
// holiday day types together with 'weekday' (every shipped pattern does).
export function dayTypeFromDow(dow: number): string {
  return dow === 6 ? 'saturday' : dow === 0 ? 'sunday' : dow === 5 ? 'friday' : 'weekday';
}

// Monday of the (Mon-Sun) week containing `iso`. If iso is a Sunday,
// returns the Monday 6 days prior.
export function mondayOfWeek(iso: string): string {
  const dow = dayOfWeekUTC(iso);
  const daysBack = dow === 0 ? 6 : dow - 1;
  return addDays(iso, -daysBack);
}

// Thursday of the week BEFORE the week containing `iso`. Used by the
// pre-PTO Thursday placement rule.
export function thursdayBeforeWeekOf(iso: string): string {
  return addDays(mondayOfWeek(iso), -4);
}

export function datesOverlap(rangeStart: string, rangeEnd: string, date: string): boolean {
  return rangeStart <= date && rangeEnd >= date;
}

// Whole-day difference (to - from) in UTC days. Positive when `to` is later.
// Inputs are YYYY-MM-DD strings parsed at UTC midnight, so this is DST-safe.
// The iso→epoch-ms parse is memoized (see the date-math header note).
const epochCache = new Map<string, number>();
function epochUTC(iso: string): number {
  let v = epochCache.get(iso);
  if (v === undefined) {
    v = new Date(iso + 'T00:00:00Z').getTime();
    epochCache.set(iso, v);
  }
  return v;
}
export function daysBetween(from: string, to: string): number {
  return Math.round((epochUTC(to) - epochUTC(from)) / 86400000);
}

// ── PTO bookend extension ──────────────────────────────────────────────────

// Given an availability entry's dates + type, return the effective
// blocked range after applying the weekend-bookend rule:
//
//   - extend back 2 days if PTO starts on a Monday (captures Sat before)
//   - extend forward 2 days if PTO ends on a Friday (captures Sun after)
//
// PTO that starts/ends on a weekend day is left alone — the weekend is
// already inside the range.
export function effectivePtoRange(
  entry: { start_date: string; end_date: string; availability_type: string },
): { start: string; end: string } {
  if (!BOOKEND_EXTENDING_TYPES.has(entry.availability_type)) {
    return { start: entry.start_date, end: entry.end_date };
  }
  const startDow = dayOfWeekUTC(entry.start_date); // 0=Sun..6=Sat
  const endDow = dayOfWeekUTC(entry.end_date);
  return {
    start: startDow === 1 ? addDays(entry.start_date, -2) : entry.start_date,
    end: endDow === 5 ? addDays(entry.end_date, 2) : entry.end_date,
  };
}

// ── Provider availability normalization ────────────────────────────────────

// Coerce the jsonb `available_weekdays` into a guaranteed 7-element bool
// array indexed Sun..Sat. Nullable / malformed values collapse to all-true.
export function normalizeWeekdays(v: unknown): boolean[] {
  const out = [true, true, true, true, true, true, true];
  if (!Array.isArray(v)) return out;
  for (let i = 0; i < 7; i++) {
    if (typeof v[i] === 'boolean') out[i] = v[i];
  }
  return out;
}

// ── Bucket keys ────────────────────────────────────────────────────────────

// Collapse day-of-week into the group used for FTE-proportional call-fairness
// quotas. Saturday and Sunday each get their OWN bucket (they used to share a
// merged 'weekend' bucket) so weekend fairness is tracked per-day: a provider's
// Saturday call load no longer offsets a Sunday deficit, and across successive
// blocks call-takers rotate through Saturday and Sunday evenly instead of one
// person accumulating all the Saturdays. Friday and weekday stand alone; the two
// holiday types still lump into one 'holiday' bucket (out of scope for the split).
export function dayTypeBucket(dt: string): string {
  if (dt === 'weekday') return 'weekday';
  if (dt === 'friday') return 'friday';
  if (dt === 'saturday') return 'saturday';
  if (dt === 'sunday') return 'sunday';
  if (dt === 'federal_holiday' || dt === 'major_holiday') return 'holiday';
  return dt;
}

// ── Pre-PTO Thursday placement index ────────────────────────────────────────

// Thursday-of-prior-week -> providers with blocking leave that week. Drives
// the pre_pto placement pass (give PTO-bound providers their call before they
// leave). Pure: precomputed once in genContext, but solve keeps it as a
// fallback so bare fixtures (no precomputed field) still work.
//
// Uses isBlockingAvailability — spec §6.7: pending PTO blocks everywhere, so a
// pending request must also EARN the Thursday placement. A provider whose
// request is merely awaiting approval is treated exactly like an approved one.
export function buildPrePtoByThursday(
  providers: CandidateProvider[],
  availByPid: Map<string, AvailabilityEntry[]>,
  slotIndex: Map<string, Map<string, SlotToFill>>,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const p of providers) {
    for (const a of availByPid.get(p.id) || []) {
      if (!isBlockingAvailability(a)) continue;
      const thu = thursdayBeforeWeekOf(a.start_date);
      if (!slotIndex.has(thu)) continue;
      const set = out.get(thu) || new Set<string>();
      set.add(p.id);
      out.set(thu, set);
    }
  }
  return out;
}
