// Pre-fill eviction — the SINGLE HOME for the "may this post-call fill evict
// this occupant?" decision (project rule: never two divergent copies).
//
// Gabriel's standing rule (2026-07-19, the Jones fix): a post-call fill fired
// by a REALIZED call (classic C2 → next-day D1) OVERRIDES any pre-call status
// on that day. Both writers of that rule consume this module:
//   • sequenceAutoFill.ts — a manual call's +offset link evicts an outranked
//     auto-generated pre-fill row occupying the linked day (DB rows).
//   • solveKernel.ts (2026-07-21, the Hussain 9/30 bug) — a positive-offset
//     dayChain link fill evicts the SAME provider's stale auto-generated
//     pre-fill SEED from a previous generation pass (in-plan eviction,
//     executed by commitPlan).
//
// The gates, exactly (all data-driven — no shift-code literals):
//   (a) occupant is auto_generated — never manual / manually_overridden;
//   (b) same schedule version (never touch other drafts);
//   (c) occupant's code is a pattern PRE-FILL code (negative-offset dayChain
//       link codes derived from the doc — preFillCodes below);
//   (d) the incoming fill's trigger outranks-or-ties the occupant (shiftRank
//       semantics: realized-call trigger beats derived pre-fill; ties go to
//       the post-call side — the old hard-coded D1-beats-D3, without
//       literals). Call-category occupants are never evicted.
import type { CallPatternDoc } from './callPattern';

// Structural shift-type shape both callers can supply: sequenceAutoFill's
// StRow (embedded shift_types row) and the engine's ShiftTypeInfo both fit.
export interface RankableShiftType {
  code?: string;
  category?: string;
  call_rank?: number | null;
  relief_rank?: number | null;
}

// Same-day precedence between pattern fills, from the shift_types rows (never
// code literals): ranked calls (call_rank, lower wins) beat relief shifts
// (relief_rank) beat plain derived codes (D1/D2/D3/…, both ranks null).
// "Lower call_rank trigger wins"; a realized call trigger therefore always
// outranks a derived pre-fill — the old hard-coded "D1 beats D3".
//
// `degradedRanks` = the rank columns were unreadable (pre-patch18 DB narrow
// retry / no ctx.shiftTypes in the engine): calls outrank non-calls, ties
// within a class are stable.
export function shiftRank(st: RankableShiftType | null | undefined, degradedRanks = false): number {
  if (degradedRanks) {
    return st?.category === 'call' ? 0 : Number.MAX_SAFE_INTEGER;
  }
  if (st?.call_rank != null) return st.call_rank;
  if (st?.relief_rank != null) return 1000 + st.relief_rank;
  return Number.MAX_SAFE_INTEGER;
}

// Codes the pattern fills via NEGATIVE offsets (pre-call fills). These are the
// only occupants a positive-offset (post-call) fill may evict — replaces the
// old literal `code === 'D3'`. Memoized on doc identity (docs are immutable;
// same idiom as callPattern's accessor caches) so the engine's per-link calls
// across the optimizer's thousands of re-solves stay O(1).
const preFillCodesCache = new WeakMap<CallPatternDoc, Set<string>>();
export function preFillCodes(doc: CallPatternDoc): Set<string> {
  let cached = preFillCodesCache.get(doc);
  if (!cached) {
    cached = new Set<string>();
    for (const chain of doc.dayChains) {
      for (const link of chain.links ?? []) {
        if (link.offset < 0) cached.add(link.code);
      }
    }
    preFillCodesCache.set(doc, cached);
  }
  return cached;
}

// The occupant a positive-offset fill is considering evicting, normalized by
// the caller: sequenceAutoFill passes a window assignment row; the engine
// passes a GenerationContext seed.
export interface PreFillOccupant {
  source_type: string | null | undefined;
  // Occupant row lives in the SAME schedule version as the incoming fill.
  // Callers compute this (missing provenance must resolve to false — the
  // conservative default: never evict what you can't attribute).
  same_version: boolean;
  st: RankableShiftType | null | undefined;
}

/**
 * May a positive-offset (post-call) pattern fill with trigger rank
 * `incomingRank` evict `occupant`? `evictableCodes` = preFillCodes(doc);
 * `rank` = the caller's shiftRank closure (carries its degraded-mode flag).
 * Pure; both writers (sequenceAutoFill row eviction, engine seed eviction)
 * MUST route their decision through here.
 */
export function mayEvictPreFill(
  incomingRank: number,
  occupant: PreFillOccupant,
  evictableCodes: ReadonlySet<string>,
  rank: (st: RankableShiftType | null | undefined) => number,
): boolean {
  if (!occupant.same_version) return false;               // (b) never touch other versions
  if (occupant.source_type !== 'auto_generated') return false; // (a) never manual rows
  if (occupant.st?.category === 'call') return false;     // calls are never pre-fill occupants
  if (!occupant.st?.code || !evictableCodes.has(occupant.st.code)) return false; // (c)
  return incomingRank <= rank(occupant.st);               // (d) outrank-or-tie wins
}
