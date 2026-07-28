// Sequence auto-fill / cleanup — the manual-edit companion to the generator.
//
// When a manual assignment lands on a shift whose ACTIVE CALL PATTERN declares
// day-chain links (classic: C2 → D1 next day, D3 prior day), we auto-fill the
// linked slots for the same provider; deleting the trigger clears those
// auto-fills again. Structure comes from scheduling.call_patterns
// (CallPatternDoc) — rule_definitions are validation-only and are deliberately
// NOT consulted here (they were pre-scheduling-v2, which let manual edits and
// generation disagree about the chain shape).
//
// Sanctioned I/O module (like genContext/commit). Query budget per invocation:
// one trigger-slot fetch + the provider-wide assignments-window read (two
// committed-scope queries — published + the trigger's own version — merged in
// the helper) + one availability read + one candidate-slots read (fired in
// parallel), then in-memory evaluation (+ the writes). Callers holding a cached CallPatternDoc
// pass it via `doc`; otherwise the module loads the site's active pattern once
// (using the trigger slot's site) and surfaces load problems in
// `patternWarnings`.
//
// Suppressed fills are returned as `skips` using the SkippedDerived vocabulary
// (clinical invariant 4: left unassigned AND recorded, never silently dropped).

import { addDays, daysBetween, isDateBlocked, isMissingColumnError, overlayMayCoexist } from './shared';
import { fetchCommittedAssignments } from './committedAssignments';
import { embedArray } from '@/lib/embed';
import {
  CLASSIC_PATTERN,
  CallPatternDocSchema,
  dayChainsFor,
  type CallPatternDoc,
} from './callPattern';
import { mayEvictPreFill, preFillCodes, shiftRank } from './preFillEviction';
import type { SkippedDerived } from './genTypes';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;

export interface SequenceAutoFillResult {
  filledSlotIds: string[];
  // Slot ids whose stale auto-generated pre-fills were reverted to open by a
  // higher-precedence incoming fill — reported so an evict-then-decline
  // sequence is never silent.
  evictedSlotIds: string[];
  skips: SkippedDerived[];
  // Load problems, same convention as genContext warnings: call-pattern
  // issues (invalid doc / read error → classic fallback), pre-patch18 rank
  // degradation, and aborted reads. Deduped; never silently swallowed.
  patternWarnings: string[];
}

export interface SequenceCleanupResult {
  clearedSlotIds: string[];
  patternWarnings: string[];
}

// ── active call pattern (per-request; call sites may pass the doc in) ───────

export interface LoadedCallPattern {
  doc: CallPatternDoc;
  warnings: string[];
}

/**
 * Load the site's active CallPatternDoc. Mirrors the genContext warnings
 * convention: no active row → CLASSIC_PATTERN silently (normal pre-seed
 * state); invalid definition or query error → CLASSIC_PATTERN with a returned
 * warning (also console.warn'd for server logs).
 */
export async function loadActiveCallPattern(
  sb: SupabaseClient,
  siteId: string | null | undefined,
): Promise<LoadedCallPattern> {
  if (!siteId) return { doc: CLASSIC_PATTERN, warnings: [] };
  const { data, error } = await sb
    .from('call_patterns')
    .select('definition')
    .eq('site_id', siteId)
    .eq('status', 'active')
    .maybeSingle();
  if (error) {
    const warning = `call_patterns read failed (${error.message}) — using classic pattern`;
    console.warn(`[sequenceAutoFill] ${warning}`);
    return { doc: CLASSIC_PATTERN, warnings: [warning] };
  }
  const definition = (data as { definition?: unknown } | null)?.definition;
  if (definition == null) return { doc: CLASSIC_PATTERN, warnings: [] };
  const parsed = CallPatternDocSchema.safeParse(definition);
  if (!parsed.success) {
    const warning = `Active call pattern failed validation: ${parsed.error.issues[0]?.message ?? 'unknown error'} — using classic pattern`;
    console.warn(`[sequenceAutoFill] ${warning}`);
    return { doc: CLASSIC_PATTERN, warnings: [warning] };
  }
  return { doc: parsed.data, warnings: [] };
}

// ── internal row shapes ──────────────────────────────────────────────────────

interface StRow {
  code?: string;
  category?: string;
  call_rank?: number | null;
  relief_rank?: number | null;
  requires_post_call_rule?: boolean;
  is_overlay?: boolean;
}

interface TriggerSlot {
  id: string;
  site_id: string;
  slot_date: string;
  derived_day_type: string;
  schedule_version_id: string;
  st: StRow;
}

interface WindowAssignment {
  id: string;
  source_type: string;
  slot_id: string;
  slot_date: string;
  site_id: string;
  schedule_version_id: string;
  st: StRow | null;
}

interface CandidateSlot {
  id: string;
  site_id: string;
  slot_date: string;
  locked: boolean;
  st: StRow | null;
  assignments: Array<{ id: string; provider_id: string | null; assignment_status: string; source_type: string }>;
}

interface AvailRow {
  availability_type: string;
  approval_status: string;
  start_date: string;
  end_date: string;
}

// Same-day precedence (shiftRank) and the pattern's pre-fill code set
// (preFillCodes) moved to preFillEviction.ts (2026-07-21) — the single home
// they now share with the engine's seed-eviction path. Imported above.

// ── loaders — wide select, narrow retry on missing patch18 columns ──────────
//
// Pre-patch18 DBs lack shift_types.call_rank/relief_rank; the wide selects
// 42703 there. Each loader retries with the narrow shift-type embed (rank
// precedence degrades to category ranking — see shiftRank) and reports the
// degradation. NON-column errors are never swallowed: the loader returns
// `failed: true` with a warning (+ console.error) and the caller aborts —
// an empty-looking window would silently pass the rest/conflict guards.

// is_overlay is a patch18 column (like call_rank/relief_rank), so it rides in
// the WIDE embed and is dropped by the narrow retry: on a pre-patch18 DB it is
// absent → treated as non-overlay → overlay rows block same-date, the
// conservative pre-overlay behavior.
const WIDE_ST = 'code, category, call_rank, relief_rank, requires_post_call_rule, is_overlay';
const NARROW_ST = 'code, category, requires_post_call_rule';

export const RANKS_DEGRADED_WARNING =
  'shift_types rank columns missing — sequence precedence degraded to category ranking (apply patch18)';

interface LoadOutcome<T> {
  data: T;
  degradedRanks: boolean;
  warnings: string[];
  failed: boolean; // non-column read error — caller must abort loudly
}

function failedLoad<T>(label: string, err: { message?: string } | null, empty: T): LoadOutcome<T> {
  const warning = `${label} read failed (${err?.message || 'unknown error'}) — sequence auto-fill skipped`;
  console.error(`[sequenceAutoFill] ${warning}`);
  return { data: empty, degradedRanks: false, warnings: [warning], failed: true };
}

// Run `query(select)` wide, retry narrow on a missing-column error.
async function loadWithNarrowRetry<T>(
  label: string,
  empty: T,
  query: (stColumns: string) => Promise<{ data: unknown; error: { code?: string; message?: string } | null }>,
  parse: (data: unknown) => T,
): Promise<LoadOutcome<T>> {
  const wide = await query(WIDE_ST);
  if (!wide.error) return { data: parse(wide.data), degradedRanks: false, warnings: [], failed: false };
  if (!isMissingColumnError(wide.error)) return failedLoad(label, wide.error, empty);
  const narrow = await query(NARROW_ST);
  if (narrow.error) return failedLoad(label, narrow.error, empty);
  return { data: parse(narrow.data), degradedRanks: true, warnings: [RANKS_DEGRADED_WARNING], failed: false };
}

async function loadTriggerSlot(sb: SupabaseClient, slotId: string): Promise<LoadOutcome<TriggerSlot | null>> {
  return loadWithNarrowRetry<TriggerSlot | null>(
    'trigger slot', null,
    stCols => sb
      .from('schedule_slots')
      .select(`id, site_id, slot_date, derived_day_type, schedule_version_id, shift_types(${stCols})`)
      .eq('id', slotId)
      .maybeSingle(),
    data => {
      if (!data) return null;
      const raw = data as Record<string, unknown>;
      const st = (raw.shift_types as StRow | null) ?? null;
      if (!st?.code) return null;
      return {
        id: raw.id as string,
        site_id: raw.site_id as string,
        slot_date: raw.slot_date as string,
        derived_day_type: (raw.derived_day_type as string) || 'weekday',
        schedule_version_id: raw.schedule_version_id as string,
        st,
      };
    },
  );
}

// Provider-wide assignments window: every PUBLISHED (committed) version at any
// site, PLUS the trigger's own draft version (clinical invariant 3 + draft
// isolation — cross-site double-bookings against committed schedules still
// block, but an overlapping unpublished draft does not). The trigger's version
// MUST stay visible: eviction (the post-call evict loop's
// `a.schedule_version_id !== trigger.schedule_version_id` same-version guard)
// and occupied-checks read those rows. Two committed-scope queries merged in
// the helper; all link evaluation happens in memory.
async function loadAssignmentsWindow(
  sb: SupabaseClient,
  providerId: string,
  versionId: string,
  start: string,
  end: string,
): Promise<LoadOutcome<WindowAssignment[]>> {
  return loadWithNarrowRetry<WindowAssignment[]>(
    'assignments window', [],
    stCols => fetchCommittedAssignments(
      sb,
      `id, source_type, schedule_slots!inner(id, slot_date, site_id, schedule_version_id, schedule_versions!inner(version_status), shift_types(${stCols}))`,
      { providerId, start, end, includeVersionId: versionId },
    ),
    data => {
      const out: WindowAssignment[] = [];
      for (const raw of ((data || []) as Array<Record<string, unknown>>)) {
        const ss = raw.schedule_slots as Record<string, unknown> | null;
        if (!ss) continue;
        out.push({
          id: raw.id as string,
          source_type: (raw.source_type as string) ?? 'manual',
          slot_id: ss.id as string,
          slot_date: ss.slot_date as string,
          site_id: (ss.site_id as string) ?? '',
          schedule_version_id: (ss.schedule_version_id as string) ?? '',
          st: (ss.shift_types as StRow | null) ?? null,
        });
      }
      return out;
    },
  );
}

async function loadAvailabilityWindow(
  sb: SupabaseClient,
  providerId: string,
  start: string,
  end: string,
): Promise<LoadOutcome<AvailRow[]>> {
  const { data, error } = await sb
    .from('provider_availability')
    .select('availability_type, approval_status, start_date, end_date')
    .eq('provider_id', providerId)
    .lte('start_date', end)
    .gte('end_date', start);
  if (error) return failedLoad('availability window', error, [] as AvailRow[]);
  return { data: (data || []) as AvailRow[], degradedRanks: false, warnings: [], failed: false };
}

async function loadCandidateSlots(
  sb: SupabaseClient,
  versionId: string,
  start: string,
  end: string,
): Promise<LoadOutcome<CandidateSlot[]>> {
  return loadWithNarrowRetry<CandidateSlot[]>(
    'candidate slots', [],
    stCols => sb
      .from('schedule_slots')
      .select(`id, site_id, slot_date, locked, shift_types(${stCols}), assignments(id, provider_id, assignment_status, source_type)`)
      .eq('schedule_version_id', versionId)
      .gte('slot_date', start)
      .lte('slot_date', end),
    data => ((data || []) as Array<Record<string, unknown>>).map(raw => ({
      id: raw.id as string,
      site_id: (raw.site_id as string) ?? '',
      slot_date: raw.slot_date as string,
      locked: !!raw.locked,
      st: (raw.shift_types as StRow | null) ?? null,
      // UNIQUE(schedule_slot_id) → PostgREST returns this embed as a single
      // OBJECT (or null) against the live DB; dev fakes return arrays.
      assignments: embedArray(raw.assignments) as CandidateSlot['assignments'],
    })),
  );
}

// Revert an assignment row to an open slot. validation_flags goes to null —
// "not validated", never a fake-clean [] the UI would read as checked-and-
// passed (clinical invariant 6 / carried Task 8 finding).
//
// highlight_color goes to null for the same family of reason (2026-07-28,
// patch42): it is the scheduler's HAND-SET "this call is billable extra" mark,
// and it belongs to the provider whose call it described. This function is the
// single chokepoint through which an assignment row becomes OPEN again while
// SURVIVING as a row (both the pre-fill eviction path and the cleanup path go
// through it; the manual DELETE route instead drops the row outright). Leaving
// the mark behind would strand it on an unassigned cell — and worse, the fill
// path below writes into exactly these reopened rows with an .update(), so the
// next provider filled into this slot would inherit the previous one's billing
// mark.
//
// Retried without the column on a pre-patch42 DB: a column that does not exist
// holds no mark, so dropping it is exact — and the revert itself must never
// fail for a presentation column, since failing it would leave a derived shift
// wrongly assigned.
async function revertToOpen(sb: SupabaseClient, assignmentId: string): Promise<boolean> {
  const openFields = {
    provider_id: null,
    assignment_status: 'open',
    source_type: 'manual',
    assigned_at: null,
    validation_flags: null,
  };
  const revert = (fields: Record<string, unknown>) =>
    sb.from('assignments').update(fields).eq('id', assignmentId);

  let { error } = await revert({ ...openFields, highlight_color: null });
  if (error && isMissingColumnError(error)) {
    ({ error } = await revert(openFields));
  }
  if (error) {
    console.error(`[sequenceAutoFill] failed to revert assignment ${assignmentId} to open: ${error.message}`);
    return false;
  }
  return true;
}

// ── apply ────────────────────────────────────────────────────────────────────

/**
 * After a manual assignment is saved, interpret the site's call pattern and
 * auto-fill the linked slots (dayChain links) for the same provider.
 *
 * Resolution rules:
 *   - Linked slot must exist in the SAME schedule version as the trigger,
 *     match the link code, and currently be unassigned and unlocked. When
 *     several sites have a matching slot, the trigger's own site is preferred;
 *     otherwise a single candidate wins and an ambiguous set is skipped.
 *   - Pre-call links (negative offset) decline when a prior-day call of
 *     equal-or-lower call_rank owns the linked day (post-call beats pre-call).
 *   - Post-call links (positive offset) evict an OUTRANKED auto-generated
 *     pre-fill occupying the day (same version only; never manual rows) —
 *     after the structural checks, before the provider-level declines.
 *   - PTO/unavailability (pending included), provider-wide same-day conflicts
 *     (any site, any version), and the post-call rest day of another
 *     rest-requiring call all block the fill.
 *   - Every suppressed fill is recorded in `skips` (SkippedDerived
 *     vocabulary); a failed DB write is console.error'd and appears in
 *     neither filledSlotIds nor skips.
 *
 * `doc`: the site's active call pattern, loaded once per request by the route
 * (loadActiveCallPattern). When omitted, it is loaded here as a fallback.
 */
export async function applySequenceAutoFill(
  sb: SupabaseClient,
  triggerSlotId: string,
  providerId: string,
  doc?: CallPatternDoc,
  opts: {
    // Working-days cap seam (2026-07-17). When provided, a link fill on a date
    // the predicate reports capped is skipped (recorded, never dropped). The
    // caller builds this from the single-homed workDays.exceedsWorkDayCap; the
    // manual-edit route passes none — manual edits follow the scheduler, the cap
    // governs auto-generation.
    capExceeded?: (providerId: string, date: string) => boolean;
  } = {},
): Promise<SequenceAutoFillResult> {
  const result: SequenceAutoFillResult = {
    filledSlotIds: [], evictedSlotIds: [], skips: [], patternWarnings: [],
  };
  const skip = (date: string, code: string, reason: SkippedDerived['reason']) =>
    result.skips.push({ date, code, provider_id: providerId, reason });
  const warn = (ws: string[]) => {
    for (const w of ws) if (!result.patternWarnings.includes(w)) result.patternWarnings.push(w);
  };

  const triggerLoad = await loadTriggerSlot(sb, triggerSlotId);
  warn(triggerLoad.warnings);
  if (triggerLoad.failed) return result;
  const trigger = triggerLoad.data;
  if (!trigger) return result;

  let pattern = doc;
  if (!pattern) {
    const loaded = await loadActiveCallPattern(sb, trigger.site_id);
    pattern = loaded.doc;
    warn(loaded.warnings);
  }
  const links = dayChainsFor(pattern, trigger.st.code!, trigger.derived_day_type)
    .flatMap(c => c.links ?? []);
  if (links.length === 0) return result;

  // Window bounds: link offsets, the unlessCallWithinDays lookback, and the
  // prior-day post-call-ownership/rest checks must all land inside the window.
  const maxAbs = Math.max(...links.map(l => Math.abs(l.offset)));
  const maxUnless = Math.max(0, ...links.map(l => l.unlessCallWithinDays ?? 0));
  const windowStart = addDays(trigger.slot_date, -Math.max(maxAbs + 1, maxUnless));
  const windowEnd = addDays(trigger.slot_date, maxAbs);

  // The three reads are independent — one round-trip of latency, not three.
  const [windowLoad, availLoad, candLoad] = await Promise.all([
    loadAssignmentsWindow(sb, providerId, trigger.schedule_version_id, windowStart, windowEnd),
    loadAvailabilityWindow(sb, providerId, windowStart, windowEnd),
    loadCandidateSlots(sb, trigger.schedule_version_id, addDays(trigger.slot_date, -maxAbs), windowEnd),
  ]);
  warn([...windowLoad.warnings, ...availLoad.warnings, ...candLoad.warnings]);
  // A failed read must abort: an empty-looking window would silently pass the
  // occupancy/conflict/rest guards below and place fills it shouldn't.
  if (windowLoad.failed || availLoad.failed || candLoad.failed) return result;
  const windowAssignments = windowLoad.data;
  const availability = availLoad.data;
  const candidateSlots = candLoad.data;

  // Rank precedence degrades as a set: if ANY side's rank columns were
  // unreadable, ranks are incomparable — use category ranking throughout.
  const ranksDegraded =
    triggerLoad.degradedRanks || windowLoad.degradedRanks || candLoad.degradedRanks;
  const rank = (st: StRow | null | undefined) => shiftRank(st, ranksDegraded);

  const triggerRank = rank(trigger.st);
  const evictableCodes = preFillCodes(pattern);
  const evictedIds = new Set<string>();

  for (const link of links) {
    const linkedDate = addDays(trigger.slot_date, link.offset);
    const code = link.code;

    // Link condition (mirrors solve()): no pre-fill when a call precedes the
    // trigger within N days. A condition on the link itself, not a
    // suppression — solve() does not record it either.
    if (link.unlessCallWithinDays != null) {
      const hadRecentCall = windowAssignments.some(a => {
        if (a.st?.category !== 'call' || a.slot_id === trigger.id) return false;
        const gap = daysBetween(a.slot_date, trigger.slot_date);
        return gap > 0 && gap <= link.unlessCallWithinDays!;
      });
      if (hadRecentCall) continue;
    }

    // Pre-call fill declines when the linked day is already post-call: a call
    // on the prior day whose rank is equal-or-lower owns the day ("lower
    // call_rank trigger wins"; ties go to the post-call side — the old
    // hard-coded D1-beats-D3, without literals).
    if (link.offset < 0) {
      const priorDate = addDays(linkedDate, -1);
      const owned = windowAssignments.some(a =>
        a.slot_date === priorDate
        && a.st?.category === 'call'
        && rank(a.st) <= triggerRank);
      if (owned) { skip(linkedDate, code, 'already-handled'); continue; }
    }

    // Candidate slot on the linked date, same version, matching code.
    // STRUCTURAL checks (no slot / ambiguous / locked) run BEFORE eviction: a
    // fill that has nowhere to land must not strand the provider without
    // their pre-fill.
    const candidates = candidateSlots.filter(s => s.slot_date === linkedDate && s.st?.code === code);
    if (candidates.length === 0) { skip(linkedDate, code, 'no-slot'); continue; }
    let chosen = candidates.find(s => s.site_id === trigger.site_id);
    if (!chosen) {
      if (candidates.length === 1) chosen = candidates[0];
      else { skip(linkedDate, code, 'ineligible'); continue; } // ambiguous across sites — don't guess
    }
    if (chosen.locked) { skip(linkedDate, code, 'ineligible'); continue; }
    if (result.filledSlotIds.includes(chosen.id)) {
      skip(linkedDate, code, 'already-handled'); // duplicate link to the same slot
      continue;
    }

    // Post-call fill evicts an OUTRANKED auto-generated pre-fill occupying the
    // linked day. Same schedule version only (never touch other drafts), never
    // manual rows, never calls, and only codes the pattern marks as pre-fills.
    // This deliberately PRECEDES the provider-level declines below
    // (occupied/PTO/conflict/rest): in each of those cases the evicted
    // pre-fill was itself sitting on the provider's post-call day — and in the
    // PTO/cross-site cases on a day it independently must not occupy — so
    // removing it is self-justifying even when the incoming fill then
    // declines. Evictions are reported via evictedSlotIds, declines via
    // skips: nothing is silent.
    if (link.offset > 0) {
      for (const a of windowAssignments) {
        if (a.slot_date !== linkedDate || evictedIds.has(a.id)) continue;
        // The eviction decision itself is the SHARED predicate
        // (preFillEviction.mayEvictPreFill): auto_generated only, same
        // version only, pattern pre-fill codes only, never calls, and the
        // occupant must not outrank the incoming fill (ties to post-call).
        if (!mayEvictPreFill(triggerRank, {
          source_type: a.source_type,
          same_version: a.schedule_version_id === trigger.schedule_version_id,
          st: a.st,
        }, evictableCodes, rank)) continue;
        if (await revertToOpen(sb, a.id)) {
          evictedIds.add(a.id);
          result.evictedSlotIds.push(a.slot_id);
        }
      }
    }

    // Slot already held by someone (evicted rows no longer count).
    const occupant = chosen.assignments.find(a => a.provider_id && !evictedIds.has(a.id));
    if (occupant) { skip(linkedDate, code, 'occupied'); continue; }

    // Blocking availability — single-homed per-date decision (isDateBlocked):
    // PENDING PTO blocks (clinical invariant 2 / spec §6.7); a live
    // pto_sellback row covering the linked date overrides — the provider is
    // working, so the derived fill may land (ALGORITHM.md §6). RAW ranges as
    // before (this check never bookended).
    if (isDateBlocked(availability, linkedDate)) { skip(linkedDate, code, 'pto'); continue; }

    // Provider-wide same-day conflict — ANY site, ANY schedule version
    // (clinical invariant 3). Labeled relative to the CHOSEN slot's site
    // (where the fill would land), not the trigger's.
    //
    // Overlay coexistence is SAME-SITE (kept local — cross-site anything
    // collides, conservative per spec 2026-07-15 §Changes/2) and TWO-SIDED:
    // the shared overlayMayCoexist decision table (shared.ts), mirroring
    // solve's narrow REGULAR↔OVERLAY-CALL exemption (review findings 3+4).
    // Narrow-retry degradation stays conservative: without is_overlay both
    // predicate branches are false and every row conflicts (pre-overlay
    // behavior).
    const fillSt = chosen.st;
    const coexists = (a: WindowAssignment) =>
      a.site_id === chosen!.site_id && overlayMayCoexist(a.st ?? {}, fillSt ?? {});
    const conflicts = windowAssignments.filter(a =>
      a.slot_date === linkedDate
      && !evictedIds.has(a.id)
      && a.slot_id !== chosen!.id
      && a.slot_id !== trigger.id
      && !coexists(a));
    if (conflicts.length > 0) {
      const crossSite = conflicts.some(c => c.site_id !== chosen!.site_id);
      skip(linkedDate, code, crossSite ? 'cross-site' : 'occupied');
      continue;
    }

    // Post-call rest guard (clinical invariant 1): a rest-requiring 24h call
    // on the day BEFORE the linked date — at ANY site, in ANY version — makes
    // the linked day the provider's day off; no fill may land there. The
    // trigger slot itself is exempt: its own +1 link IS the sanctioned
    // post-call assignment (classic C2→D1) and must not self-block.
    // Reason 'ineligible' matches solve's skipReasonFrom mapping for the
    // post-call guard ('already-handled' would mislabel this as slot
    // consumption by another placement).
    const restBlocked = windowAssignments.some(a =>
      a.slot_date === addDays(linkedDate, -1)
      && a.slot_id !== trigger.id
      && !evictedIds.has(a.id)
      && a.st?.requires_post_call_rule === true);
    if (restBlocked) { skip(linkedDate, code, 'ineligible'); continue; }

    // Working-days cap (opt-in seam): the provider is already credited their
    // required working days for the block, so this link fill on a working day is
    // refused. Recorded like any other suppression (invariant 4). No predicate
    // ⇒ no cap (default), so existing behavior is byte-identical.
    if (opts.capExceeded?.(providerId, linkedDate)) { skip(linkedDate, code, 'ineligible'); continue; }

    // Write the fill. One assignment row per slot (UNIQUE on schedule_slot_id):
    // update the existing open row when present, insert otherwise.
    // validation_flags stays null — the POST route revalidates the provider's
    // neighbors (including this row) right after; null is honest "not yet
    // validated", never a fake-clean [] (invariant 6 / carried Task 8 finding).
    const fillFields = {
      provider_id: providerId,
      assignment_status: 'assigned',
      source_type: 'auto_generated',
      assigned_at: new Date().toISOString(),
      validation_flags: null,
    };
    const openRow = chosen.assignments.find(a => !a.provider_id || evictedIds.has(a.id));
    if (openRow) {
      const { error } = await sb.from('assignments').update(fillFields).eq('id', openRow.id);
      if (error) {
        console.error(`[sequenceAutoFill] fill update failed for slot ${chosen.id}: ${error.message}`);
        continue;
      }
    } else {
      const { error } = await sb.from('assignments').insert({ schedule_slot_id: chosen.id, ...fillFields });
      if (error) {
        console.error(`[sequenceAutoFill] fill insert failed for slot ${chosen.id}: ${error.message}`);
        continue;
      }
    }
    result.filledSlotIds.push(chosen.id);
  }

  return result;
}

// ── cleanup ──────────────────────────────────────────────────────────────────

/**
 * When a trigger assignment is removed, clear the linked auto-generated fills
 * for that provider — same pattern-link derivation as applySequenceAutoFill.
 * Only rows with source_type='auto_generated' AND a matching provider are
 * reverted; manual edits are never touched.
 */
export async function cleanupSequenceAutoFill(
  sb: SupabaseClient,
  triggerSlotId: string,
  providerId: string,
  doc?: CallPatternDoc,
): Promise<SequenceCleanupResult> {
  const result: SequenceCleanupResult = { clearedSlotIds: [], patternWarnings: [] };
  const warn = (ws: string[]) => {
    for (const w of ws) if (!result.patternWarnings.includes(w)) result.patternWarnings.push(w);
  };

  const triggerLoad = await loadTriggerSlot(sb, triggerSlotId);
  warn(triggerLoad.warnings);
  if (triggerLoad.failed) return result;
  const trigger = triggerLoad.data;
  if (!trigger) return result;

  let pattern = doc;
  if (!pattern) {
    const loaded = await loadActiveCallPattern(sb, trigger.site_id);
    pattern = loaded.doc;
    warn(loaded.warnings);
  }
  const links = dayChainsFor(pattern, trigger.st.code!, trigger.derived_day_type)
    .flatMap(c => c.links ?? []);
  if (links.length === 0) return result;

  const maxAbs = Math.max(...links.map(l => Math.abs(l.offset)));
  const slotsLoad = await loadCandidateSlots(
    sb, trigger.schedule_version_id,
    addDays(trigger.slot_date, -maxAbs), addDays(trigger.slot_date, maxAbs));
  warn(slotsLoad.warnings);
  if (slotsLoad.failed) return result;
  const slots = slotsLoad.data;

  // Dedupe by assignment id: two links sharing date+code must not double-write.
  const processed = new Set<string>();
  for (const link of links) {
    const linkedDate = addDays(trigger.slot_date, link.offset);
    for (const s of slots) {
      if (s.slot_date !== linkedDate || s.st?.code !== link.code) continue;
      for (const a of s.assignments) {
        if (a.provider_id !== providerId || a.source_type !== 'auto_generated') continue;
        if (processed.has(a.id)) continue;
        processed.add(a.id);
        if (await revertToOpen(sb, a.id)) result.clearedSlotIds.push(s.id);
      }
    }
  }

  return result;
}
