// Manual-assignment candidate classification for the schedule grid's cell
// picker (2026-07-28).
//
// WHAT THIS IS. The grid's left-click picker used to list every active
// provider with a name search and nothing else — the scheduler hand-picked
// from ~85 people with nothing stopping him putting someone on the board who
// was on PTO, post-call, or already booked at another site. This module
// answers one question, purely: for THIS slot, who is available, who is
// available-but-flagged, and who is blocked and why.
//
// WHAT THIS IS NOT. It is not a second eligibility engine. Every decision
// below either (a) calls an engine predicate directly, or (b) is explicitly
// documented as an approximation with its reason. The canonical gate is
// rulesEngine/eligibility.ts `evaluateEligibility`; this module MIRRORS ITS
// DECISIONS for the subset a client-side picker can evaluate, and deliberately
// drops the rest. It is a CONSUMER — nothing here may be copied back into the
// engine, and nothing in the engine may be reimplemented here.
//
// ── What is mirrored, and how ───────────────────────────────────────────────
//   group-mismatch        slot.provider_group vs provider_type — the engine's
//                         own two-line rule, copied verbatim in shape.
//   availability-blocked  isDateBlocked(entries, date, {bookend:true}) — the
//                         single-homed per-date decision, PENDING INCLUDED
//                         (clinical invariant 2) and sell-back-aware.
//   same-date             overlayMayCoexist(existing, incoming) — the canonical
//                         coexistence table, consumed literally (unlike the
//                         engine's incremental SolveState form, this module has
//                         both objects in hand).
//   cross-site            a booking in a PUBLISHED version at any other
//                         schedule/site — the route hands us the dates via
//                         fetchCommittedAssignments (invariant 3).
//   credential            the engine's credential block, rule for rule,
//                         including "missing row = not yet configured = pass".
//   weekday-unavailable   normalizeWeekdays(profile)[dayOfWeekUTC(date)].
//   post-call             postCallBlockOffsets(doc, code, dayType) — see the
//                         POST-CALL note below.
//   no-call-request       isActiveNoCallRequest, SOFT (the engine drops these
//                         providers a sort tier; validation soft-flags a call
//                         that lands on one). Never a hard block — that is the
//                         whole point of the type.
//
// ── What is NOT mirrored, and why ──────────────────────────────────────────
//   bucket quota, workdays cap, scenario prohibitions/linkages, the neuro
//   remainder gate: all TARGET/FAIRNESS gates that shape auto-generation. A
//   human placing one call by hand is exactly the case those are meant to be
//   overridable for, and presenting them as "unavailable" would be wrong.
//   The weekend-adjacent-PTO exclusion is a third kind — the engine gates it
//   HARD during generation, but it is a planning preference, not a safety
//   rule, so here it is SOFT/advisory (surfaced, never blocking). Deliberate
//   divergence, called out so nobody "fixes" it into a hard block.
//
// ── Approximation risk (no SolveState) ─────────────────────────────────────
//   evaluateEligibility reads a live SolveState — the in-flight placements of
//   the run it is part of. A picker has no such thing; its only occupancy
//   evidence is the assignments PERSISTED on the grid. Everything derived
//   below therefore describes the board AS SAVED. During a normal editing
//   session that is exactly right (each assign round-trips before the next),
//   but a placement that has not yet been written is invisible to this module.
//   The three consequences are noted at their sites: post-call rest, same-date
//   occupancy, and the derived D-chain fills the server auto-fills after an
//   assignment.
//
// This module is PURE and cheap — build the index once per grid payload and
// re-run candidatesForSlot on every cell click. Nothing here fetches.
//
// (zod: callPattern.ts is a value import here, so this file pulls zod into any
// client bundle that uses it. The schedules/[id] page already carries zod via
// lib/blockTargets — no new cost on the only current consumer.)

import {
  BOOKEND_EXTENDING_TYPES,
  addDays,
  datesOverlap,
  dayOfWeekUTC,
  effectivePtoRange,
  isActiveCallRequest,
  isActiveNoCallRequest,
  isBlockingAvailability,
  isDateBlocked,
  isSellbackOverridden,
  normalizeWeekdays,
  overlayMayCoexist,
} from '@/lib/rulesEngine/shared';
import {
  CLASSIC_PATTERN,
  dayChainsFor,
  postCallBlockOffsets,
  type CallPatternDoc,
} from '@/lib/rulesEngine/callPattern';

/* ── Input row shapes ─────────────────────────────────────────────────────── */
// Structural and deliberately loose: the grid payload's own interfaces satisfy
// these without conversion, and a missing optional field degrades to the
// conservative reading rather than a type error.

export interface CandidateProviderRow {
  id: string;
  short_display_name: string;
  initials: string;
  provider_type: string;
  status: string;
  first_name?: string | null;
  last_name?: string | null;
}

export interface CandidateProfileRow {
  provider_id: string;
  /** jsonb, Sun..Sat. normalizeWeekdays coerces null/malformed to all-true. */
  available_weekdays?: unknown;
}

export interface CandidateAvailabilityRow {
  provider_id: string;
  availability_type: string;
  start_date: string;
  end_date: string;
  approval_status: string;
}

export interface CandidateShiftTypeRow {
  code: string;
  category: string;
  requires_post_call_rule?: boolean | null;
  parent_call_code?: string | null;
  is_overlay?: boolean | null;
}

export interface CandidateSlotRow {
  id: string;
  slot_date: string;
  derived_day_type: string;
  /** schedule_slots.provider_group — 'physician' | 'crna' | 'both'. */
  provider_group?: string | null;
  shift_types: CandidateShiftTypeRow | null;
  assignments: Array<{ provider_id?: string | null }>;
}

export interface CandidateCredentialRow {
  provider_id: string;
  is_active?: boolean | null;
  credentialed?: boolean | null;
  can_take_call?: boolean | null;
  can_take_weekend_call?: boolean | null;
  can_take_holiday_call?: boolean | null;
  allowed_shift_types?: string[] | null;
  excluded_shift_types?: string[] | null;
}

/** One committed booking in another schedule/site (invariant 3). */
export interface CrossSiteBookingRow {
  provider_id: string;
  slot_date: string;
  requires_post_call_rule?: boolean | null;
}

export interface SlotCandidateInputs {
  providers: readonly CandidateProviderRow[];
  profiles: readonly CandidateProfileRow[];
  availability: readonly CandidateAvailabilityRow[];
  slots: readonly CandidateSlotRow[];
  /** null = the route could not load them; credentials go UNCHECKED and say so. */
  credentials: readonly CandidateCredentialRow[] | null;
  /** null = the route could not load them; cross-site goes UNCHECKED and says so. */
  crossSite: readonly CrossSiteBookingRow[] | null;
  /** The site's active pattern. Absent → CLASSIC_PATTERN, exactly as the engine. */
  callPattern?: CallPatternDoc | null;
}

/* ── Reason vocabulary ────────────────────────────────────────────────────── */

export type CandidateBlockReason =
  | 'availability-blocked'
  | 'post-call'
  | 'same-date'
  | 'cross-site'
  | 'credential'
  | 'weekday-unavailable'
  | 'group-mismatch';

export type CandidateSoftReason = 'no-call-request' | 'weekend-adjacent-pto';

// PRESENTATION precedence, most-explanatory first. This is deliberately NOT
// evaluateEligibility's return order: that order is an internal short-circuit
// artifact (group → same-date → cross-site → weekday → post-call → …), and its
// first hit is not necessarily the most useful thing to tell a human. "On PTO"
// beats "already assigned" when both are true. Every applicable reason is
// reported; this only decides which one leads.
const BLOCK_ORDER: CandidateBlockReason[] = [
  'availability-blocked',
  'post-call',
  'same-date',
  'cross-site',
  'credential',
  'weekday-unavailable',
  'group-mismatch',
];

const SOFT_ORDER: CandidateSoftReason[] = ['no-call-request', 'weekend-adjacent-pto'];

/* ── Output ───────────────────────────────────────────────────────────────── */

export interface SlotCandidate {
  provider: CandidateProviderRow;
  group: 'available' | 'soft' | 'blocked';
  /** Applicable hard reasons in BLOCK_ORDER. Empty ⇒ not hard-blocked. */
  hard: CandidateBlockReason[];
  /** Applicable soft reasons in SOFT_ORDER. */
  soft: CandidateSoftReason[];
  /** One sentence per applicable reason, hard first, same order as above. */
  reasonTexts: string[];
  /** reasonTexts[0] ?? '' — the line the picker shows next to the name. */
  reasonText: string;
}

export interface SlotCandidateGroups {
  available: SlotCandidate[];
  soft: SlotCandidate[];
  blocked: SlotCandidate[];
  /**
   * Dimensions this classification COULD NOT check, as user-facing sentences.
   * Non-empty means the "Available" list is optimistic and the picker must say
   * so — a filtered list that silently hides a missing check is worse than no
   * filter at all.
   */
  unchecked: string[];
}

const EMPTY_GROUPS: SlotCandidateGroups = { available: [], soft: [], blocked: [], unchecked: [] };

/* ── Index ────────────────────────────────────────────────────────────────── */

interface Occupancy { slotId: string; category: string; isOverlay: boolean }

export interface CandidateIndex {
  providers: CandidateProviderRow[];
  slotById: Map<string, CandidateSlotRow>;
  availByPid: Map<string, CandidateAvailabilityRow[]>;
  weekdaysByPid: Map<string, boolean[]>;
  credByPid: Map<string, CandidateCredentialRow>;
  crossSiteByPid: Map<string, Set<string>>;
  /** pid → blocked date → the call that earned the rest day (for the label). */
  postCallByPid: Map<string, Map<string, string>>;
  /** date → pid → what that provider already holds that date. */
  occupancyByDate: Map<string, Map<string, Occupancy[]>>;
  doc: CallPatternDoc;
  unchecked: string[];
}

// 'YYYY-MM-DD' → 'M/D'. String math only — no Date, no locale, no timezone.
function mmdd(iso: string): string {
  const [, m, d] = iso.split('-');
  if (!m || !d) return iso;
  return `${Number(m)}/${Number(d)}`;
}

const DOW_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Precompute everything that depends only on the grid payload. Build once per
 * payload; candidatesForSlot() below is then a single pass over the roster.
 */
export function buildCandidateIndex(inputs: SlotCandidateInputs): CandidateIndex {
  const doc = inputs.callPattern ?? CLASSIC_PATTERN;
  const unchecked: string[] = [];

  const providers = inputs.providers
    .filter(p => p.status === 'active')
    .slice()
    .sort((a, b) => a.short_display_name.localeCompare(b.short_display_name));

  const slotById = new Map<string, CandidateSlotRow>();
  for (const s of inputs.slots) slotById.set(s.id, s);

  const availByPid = new Map<string, CandidateAvailabilityRow[]>();
  for (const a of inputs.availability) {
    const list = availByPid.get(a.provider_id);
    if (list) list.push(a);
    else availByPid.set(a.provider_id, [a]);
  }

  const weekdaysByPid = new Map<string, boolean[]>();
  for (const prof of inputs.profiles) {
    weekdaysByPid.set(prof.provider_id, normalizeWeekdays(prof.available_weekdays));
  }

  const credByPid = new Map<string, CandidateCredentialRow>();
  if (inputs.credentials) {
    for (const c of inputs.credentials) credByPid.set(c.provider_id, c);
  } else {
    unchecked.push('Site credentials could not be loaded — call/weekend/holiday privileges are NOT checked.');
  }

  const crossSiteByPid = new Map<string, Set<string>>();
  const postCallByPid = new Map<string, Map<string, string>>();
  const markPostCall = (pid: string, date: string, source: string) => {
    let byDate = postCallByPid.get(pid);
    if (!byDate) { byDate = new Map(); postCallByPid.set(pid, byDate); }
    if (!byDate.has(date)) byDate.set(date, source);
  };

  if (inputs.crossSite) {
    for (const b of inputs.crossSite) {
      let set = crossSiteByPid.get(b.provider_id);
      if (!set) { set = new Set(); crossSiteByPid.set(b.provider_id, set); }
      set.add(b.slot_date);
      // A rest-requiring call at ANOTHER site still earns the post-call day off
      // here (clinical invariant 1 is provider-wide, not site-wide). This is
      // dayShiftAutoGen's cross-schedule rule verbatim: requires_post_call_rule
      // on day D blocks D+1. Deliberately NOT pattern-driven — the other site's
      // slot is governed by ITS pattern, which this payload does not carry, so
      // running THIS site's dayChains over a foreign day type would be a
      // fabricated rule. +1 is the invariant's own wording and matches the
      // engine surface that already does this.
      if (b.requires_post_call_rule) {
        markPostCall(b.provider_id, addDays(b.slot_date, 1), `call at another site on ${mmdd(b.slot_date)}`);
      }
    }
  } else {
    unchecked.push('Cross-site bookings could not be loaded — a provider published at another site may still be listed as available.');
  }

  // Occupancy + post-call rest, both derived from the assignments PERSISTED on
  // this grid (see the no-SolveState note in the file header).
  const occupancyByDate = new Map<string, Map<string, Occupancy[]>>();
  for (const slot of inputs.slots) {
    const st = slot.shift_types;
    let byPid = occupancyByDate.get(slot.slot_date);
    if (!byPid) { byPid = new Map(); occupancyByDate.set(slot.slot_date, byPid); }
    for (const a of slot.assignments ?? []) {
      const pid = a.provider_id;
      if (!pid) continue;
      const occ: Occupancy = {
        slotId: slot.id,
        category: st?.category ?? 'regular',
        isOverlay: st?.is_overlay === true,
      };
      const list = byPid.get(pid);
      if (list) list.push(occ);
      else byPid.set(pid, [occ]);

      if (!st) continue;

      // (a) PATTERN-DRIVEN post-call blocks — seedSolveState's rule, verbatim.
      // The pattern's dayChain `blocks` are the post-call-day-off vocabulary,
      // so day-type scoping (the classic Saturday C1 exemption, Sunday C1's +1,
      // C2's fill-don't-block) falls out of the doc rather than a hardcoded −1.
      // SEGMENT rest inheritance (patch35 decision 3): an overnight segment
      // with no chain data of its own rides its PARENT code's blocks.
      let blockCode = st.code;
      if (st.parent_call_code && st.requires_post_call_rule
        && dayChainsFor(doc, st.code, slot.derived_day_type).length === 0) {
        blockCode = st.parent_call_code;
      }
      for (const off of postCallBlockOffsets(doc, blockCode, slot.derived_day_type)) {
        markPostCall(pid, addDays(slot.slot_date, off), `${st.code} on ${mmdd(slot.slot_date)}`);
      }

      // (b) requires_post_call_rule → the NEXT day, unconditionally. This is
      // the second engine home for invariant 1 (dayShiftAutoGen's
      // postCallRestByDate) and it is a UNION with (a), not a replacement: the
      // call engine reads the pattern, the day-shift engine reads the flag, and
      // where a site's pattern states no block for a code that nonetheless
      // carries the flag the flag still wins. Union = the picker never claims
      // someone is free on a rest day either engine would protect. Where both
      // fire they agree (classic C1 blocks +1 by pattern and by flag), so the
      // union adds nothing there.
      if (st.requires_post_call_rule) {
        markPostCall(pid, addDays(slot.slot_date, 1), `${st.code} on ${mmdd(slot.slot_date)}`);
      }
    }
  }

  return {
    providers, slotById, availByPid, weekdaysByPid, credByPid,
    crossSiteByPid, postCallByPid, occupancyByDate, doc, unchecked,
  };
}

/* ── Classification ───────────────────────────────────────────────────────── */

// Rows responsible for a block, for the LABEL only. The DECISION is
// isDateBlocked's (called first); this just re-walks to name the type, so the
// two can never disagree about whether the date is blocked — only about how it
// reads, and an empty result falls back to a generic sentence.
function blockingRowsOn(
  entries: readonly CandidateAvailabilityRow[], date: string,
): CandidateAvailabilityRow[] {
  if (isSellbackOverridden(entries, date)) return [];
  return entries.filter(a => {
    if (!isBlockingAvailability(a)) return false;
    const r = effectivePtoRange(a);
    return datesOverlap(r.start, r.end, date);
  });
}

function availabilityLabel(rows: CandidateAvailabilityRow[]): string {
  if (rows.length === 0) return 'Unavailable on this date';
  const a = rows[0];
  const type = a.availability_type.replace(/_/g, ' ').toUpperCase();
  const range = a.start_date === a.end_date
    ? mmdd(a.start_date)
    : `${mmdd(a.start_date)}–${mmdd(a.end_date)}`;
  const pending = a.approval_status === 'pending' ? ' (pending)' : '';
  return `On ${type} ${range}${pending}`;
}

/**
 * Classify every active provider against one slot. Pure; safe to call on every
 * render. Returns EMPTY_GROUPS for an unknown slot id.
 */
export function candidatesForSlot(index: CandidateIndex, slotId: string): SlotCandidateGroups {
  const slot = index.slotById.get(slotId);
  if (!slot) return EMPTY_GROUPS;

  const st = slot.shift_types;
  const date = slot.slot_date;
  const dayType = slot.derived_day_type;
  const dow = dayOfWeekUTC(date);
  const isCallSlot = st?.category === 'call';
  const incoming = { category: st?.category ?? 'regular', is_overlay: st?.is_overlay === true };
  const occupants = index.occupancyByDate.get(date);

  const available: SlotCandidate[] = [];
  const soft: SlotCandidate[] = [];
  const blocked: SlotCandidate[] = [];

  for (const p of index.providers) {
    const entries = index.availByPid.get(p.id) ?? [];
    const hard: CandidateBlockReason[] = [];
    const softReasons: CandidateSoftReason[] = [];
    const text: Partial<Record<CandidateBlockReason | CandidateSoftReason, string>> = {};

    // ── group match (engine: evaluateEligibility, first gate) ──
    // schedule_slots.provider_group 'both' (or absent) admits everyone.
    if (slot.provider_group === 'physician' && p.provider_type !== 'physician') {
      hard.push('group-mismatch');
      text['group-mismatch'] = `${p.provider_type.toUpperCase()} — this slot is for physicians`;
    } else if (slot.provider_group === 'crna' && !['crna', 'aa'].includes(p.provider_type)) {
      hard.push('group-mismatch');
      text['group-mismatch'] = `${p.provider_type.toUpperCase()} — this slot is for CRNAs/AAs`;
    }

    // ── availability (isDateBlocked: pending blocks, sell-back overrides) ──
    if (isDateBlocked(entries, date, { bookend: true })) {
      hard.push('availability-blocked');
      text['availability-blocked'] = availabilityLabel(blockingRowsOn(entries, date));
    }

    // ── post-call rest ──
    const postCallSource = index.postCallByPid.get(p.id)?.get(date);
    if (postCallSource) {
      hard.push('post-call');
      text['post-call'] = `Post-call after ${postCallSource}`;
    }

    // ── same-date occupancy (overlayMayCoexist, consumed literally) ──
    // The TARGET slot is excluded: re-picking the provider already in this cell
    // is a no-op, not a conflict. Every other same-date row is judged by the
    // canonical table — two calls never stack; an overlay call coexists with a
    // regular day shift in either placement order.
    const held = occupants?.get(p.id) ?? [];
    const collides = held.filter(o => o.slotId !== slot.id
      && !overlayMayCoexist({ category: o.category, is_overlay: o.isOverlay }, incoming));
    if (collides.length > 0) {
      hard.push('same-date');
      text['same-date'] = `Already assigned ${mmdd(date)}`;
    }

    // ── cross-site (invariant 3; overlay-blind, exactly as the engine) ──
    if (index.crossSiteByPid.get(p.id)?.has(date)) {
      hard.push('cross-site');
      text['cross-site'] = 'Booked at another site';
    }

    // ── site credentials (missing row = not yet configured = pass) ──
    const cred = index.credByPid.get(p.id);
    if (cred) {
      const code = st?.code ?? '';
      const allowed = cred.allowed_shift_types ?? [];
      const excluded = cred.excluded_shift_types ?? [];
      let credReason: string | null = null;
      if (!cred.is_active) credReason = 'Not active at this site';
      else if (!cred.credentialed) credReason = 'Not credentialed at this site';
      else if (excluded.includes(code)) credReason = `Not credentialed for ${code}`;
      else if (allowed.length > 0 && !allowed.includes(code)) credReason = `Not credentialed for ${code}`;
      else if (isCallSlot) {
        if (!cred.can_take_call) credReason = 'Not cleared to take call';
        else if ((dayType === 'saturday' || dayType === 'sunday') && !cred.can_take_weekend_call) {
          credReason = 'Not cleared for weekend call';
        } else if ((dayType === 'federal_holiday' || dayType === 'major_holiday') && !cred.can_take_holiday_call) {
          credReason = 'Not cleared for holiday call';
        }
      }
      if (credReason) {
        hard.push('credential');
        text.credential = credReason;
      }
    }

    // ── weekday availability (index is Sun..Sat) ──
    // No profile row ⇒ no stated pattern ⇒ available, matching normalizeWeekdays'
    // all-true coercion for a null column.
    const weekdays = index.weekdaysByPid.get(p.id);
    if (weekdays && weekdays[dow] === false) {
      hard.push('weekday-unavailable');
      text['weekday-unavailable'] = `Does not work ${DOW_LABELS[dow]}s`;
    }

    // ── SOFT: live no-call request (call slots only, as validation scopes it) ──
    // A provider with BOTH a live call request and a live no-call request over
    // this date asked for opposite things; solve() treats the date as NEITHER,
    // so neither does the picker.
    if (isCallSlot) {
      const noCall = entries.find(a => isActiveNoCallRequest(a) && datesOverlap(a.start_date, a.end_date, date));
      const contradicted = noCall
        && entries.some(a => isActiveCallRequest(a) && datesOverlap(a.start_date, a.end_date, date));
      if (noCall && !contradicted) {
        softReasons.push('no-call-request');
        const range = noCall.start_date === noCall.end_date
          ? mmdd(noCall.start_date)
          : `${mmdd(noCall.start_date)}–${mmdd(noCall.end_date)}`;
        text['no-call-request'] = `Requested no call ${range}`;
      }
    }

    // ── SOFT: weekend adjacent-week PTO ──
    // The engine gates this HARD during generation (evaluateEligibility,
    // 'weekend-adjacent-pto'); here it is advisory. Row-based and
    // bookend-extending-types-only, exactly as the engine scopes it — a
    // sold-back day inside the adjacent week does NOT resurrect the weekend
    // (deliberate v1 simplification, ALGORITHM.md §6), so this stays off
    // isDateBlocked.
    if (dayType === 'saturday' || dayType === 'sunday') {
      const satDate = dayType === 'saturday' ? date : addDays(date, -1);
      const windows: Array<[string, string]> = [
        [addDays(satDate, -5), addDays(satDate, -1)],
        [addDays(satDate, 2), addDays(satDate, 6)],
      ];
      const hit = entries.some(a => isBlockingAvailability(a)
        && BOOKEND_EXTENDING_TYPES.has(a.availability_type)
        && windows.some(([ws, we]) => a.start_date <= we && a.end_date >= ws));
      if (hit) {
        softReasons.push('weekend-adjacent-pto');
        text['weekend-adjacent-pto'] = 'Planned leave in an adjacent week';
      }
    }

    const orderedHard = BLOCK_ORDER.filter(r => hard.includes(r));
    const orderedSoft = SOFT_ORDER.filter(r => softReasons.includes(r));
    const reasonTexts = [...orderedHard, ...orderedSoft]
      .map(r => text[r])
      .filter((s): s is string => !!s);

    const group: SlotCandidate['group'] = orderedHard.length > 0
      ? 'blocked'
      : orderedSoft.length > 0 ? 'soft' : 'available';

    const candidate: SlotCandidate = {
      provider: p,
      group,
      hard: orderedHard,
      soft: orderedSoft,
      reasonTexts,
      reasonText: reasonTexts[0] ?? '',
    };
    if (group === 'blocked') blocked.push(candidate);
    else if (group === 'soft') soft.push(candidate);
    else available.push(candidate);
  }

  return { available, soft, blocked, unchecked: index.unchecked };
}

/* ── Search ───────────────────────────────────────────────────────────────── */

function matchesSearch(p: CandidateProviderRow, needle: string): boolean {
  return p.short_display_name.toLowerCase().includes(needle)
    || (p.first_name ?? '').toLowerCase().includes(needle)
    || (p.last_name ?? '').toLowerCase().includes(needle)
    || p.initials.toLowerCase().includes(needle);
}

/** Name search across all three groups. Empty/whitespace query = identity. */
export function filterCandidateGroups(
  groups: SlotCandidateGroups, search: string,
): SlotCandidateGroups {
  const needle = search.trim().toLowerCase();
  if (!needle) return groups;
  const keep = (c: SlotCandidate) => matchesSearch(c.provider, needle);
  return {
    available: groups.available.filter(keep),
    soft: groups.soft.filter(keep),
    blocked: groups.blocked.filter(keep),
    unchecked: groups.unchecked,
  };
}

/**
 * The confirm() sentence for deliberately assigning a hard-blocked provider.
 * Single-homed so the wording of an override prompt can never drift from the
 * reason that produced it.
 */
export function overrideConfirmMessage(c: SlotCandidate): string {
  const why = c.reasonTexts.length > 0 ? c.reasonTexts.join('; ') : 'blocked';
  return `${c.provider.short_display_name} is unavailable for this slot:\n\n${why}\n\nAssign anyway?`;
}
