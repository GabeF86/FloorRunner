// patterns/weekendV2.ts
// Weekend call v2 for Paoli (spec 2026-07-12): weekend spread across four
// people — Fri-C1 person (Doc A) carries Sun C2 (friday-anchored +2 link,
// spec 2026-07-15 friday-first: the in-house Friday C1 is chosen FIRST and
// Sunday home-call rides along to the same doc, so a starved pool blanks
// Sun C2, never Fri C1 — previously sunday-anchored with a −2 back-link,
// where a starved Sunday anchor blanked Friday C1); Sat-C2 person carries
// Fri C2 + Sun C1; Neuro (C3) covers Fri→Sun; Sat-C1 person gets Fri D2 and
// Sunday off. dayTypeFillOrder puts friday BETWEEN saturday and sunday so
// the friday C1 anchor fires before the sunday slots would fill standalone
// (saturday still first: its anchors claim Fri C2/C3/D4/D2 ahead of the
// friday pass). callFillOrder makes in-house C1 fill before home-call within
// each date under pool pressure — the two fields compose (dayTypeFillOrder =
// across day types; callFillOrder = within a date).
//
// Neuro overlay (Doc C, spec 2026-07-15): the Sat-C3 person works a REGULAR
// DAY (D4) on Friday and starts neuro call (C3) that evening, then carries C3
// Sat + Sun. So the saturday C3 anchor links BOTH Fri C3 (−1) and Fri D4 (−1)
// onto that one provider — two −1 links on the same anchor. C3 is an
// is_overlay shift type (patch25): the overlay exemption is NARROW — it lets
// a REGULAR shift and an OVERLAY CALL coexist on one date (Fri D4 + Fri C3,
// one person, one block) and nothing more. Two same-date CALLS still collide
// (overlay or not) and post-call blocked days still bind (eligibility.ts
// call-on-call + blockedOnDate checks). Within that rule the two −1 links are
// order-independent: C3-then-D4 and D4-then-C3 both land both pieces (see
// patternEngine.test.ts both-order test).
import { CallPatternDocSchema, type CallPatternDoc } from '../callPattern';

// The patch19/patch25 SQL seeds embed this constant (mirroring how the
// patch18 seed embeds CLASSIC_PATTERN, callPattern.ts) — keep them in sync
// via the emit scripts (scripts/emitNeuroOverlayPatch.ts).
export const WEEKEND_V2_PATTERN: CallPatternDoc = CallPatternDocSchema.parse({
  version: 1,
  callFillOrder: 'call_rank',
  // Friday-first Doc A: saturday anchors fire first (claiming Fri C2, Fri C3,
  // Fri D4, Fri D2, Sun C1, Sun C3 as links), then the friday pass places the
  // in-house Fri C1 whose anchor chains Sun C2 forward, then sunday mops up
  // leftovers. Holidays keep their default tail position.
  dayTypeFillOrder: ['saturday', 'friday', 'sunday', 'weekday', 'federal_holiday', 'major_holiday'],
  spans: [],
  blocks: [
    { anchorDayType: 'saturday', chains: [
      // Neuro block: Fri C3 (evening call) + Fri D4 (the day shift, overlay) +
      // Sun C3 — all on the saturday-C3 provider (Doc C). Two −1 links are legal
      // (BlockChainSchema.links has no offset-uniqueness) and order-independent.
      { trigger: 'C3', links: [{ offset: -1, code: 'C3' }, { offset: -1, code: 'D4' }, { offset: 1, code: 'C3' }] },
      { trigger: 'C1', links: [{ offset: -1, code: 'D2' }] },
      { trigger: 'C2', links: [{ offset: -1, code: 'C2' }, { offset: 1, code: 'C1' }] },
    ]},
    // Doc A (friday-first, spec 2026-07-15): the Fri C1 anchor chains Sun C2
    // forward. Replaces the old sunday-anchored { C2 → −2 C1 } back-link so a
    // starved Sunday can never blank Friday C1. Saturday off comes from the
    // friday C1 dayChain block (+1) firing on the anchor placement; Monday D1
    // comes from the sunday C2 dayChain (+1 D1) firing on the LINK placement
    // (dayChains fire on block-link placements — pinned in weekendV2Pattern
    // tests).
    { anchorDayType: 'friday', chains: [
      { trigger: 'C1', links: [{ offset: 2, code: 'C2' }] },
    ]},
  ],
  // Pre-call fills are UNCONDITIONAL (Gabriel 2026-07-20): "Pre-call status
  // should be given to anyone on call the following day. D1 status is only
  // dependent on the Call status from the day before, and D2 and D3 Status is
  // only for the call status on the following day." The unlessCallWithinDays:2
  // conditions previously on the C1→D2 and C2→D3 links were ported from legacy
  // behavior on 2026-07-12 (never asked for) — they waived the pre-call fill
  // after ANY call within 2 days, which cost neuro-weekend Jones (Sun C3,
  // Tue C1) her Monday D2. The schema FEATURE stays in callPattern.ts (classic
  // still uses it); this pattern's DATA drops it. D1-overrides-D2 needs no
  // waiver: a C2's +1 D1 lands first in date order, so the next day's −1 D2
  // pre-fill severs on the same-date gate (recorded 'occupied') — pinned in
  // weekendV2Pattern.test.ts (D1 OVERRIDES D2).
  dayChains: [
    { trigger: 'C1', dayTypes: ['weekday', 'friday', 'federal_holiday', 'major_holiday'],
      links: [{ offset: -1, code: 'D2' }], blocks: [{ offset: 1 }] },
    { trigger: 'C1', dayTypes: ['saturday'], blocks: [{ offset: 1 }] },
    { trigger: 'C1', dayTypes: ['sunday'], blocks: [{ offset: 1 }] },
    { trigger: 'C2', dayTypes: ['weekday', 'friday', 'federal_holiday', 'major_holiday'],
      links: [{ offset: -1, code: 'D3' }, { offset: 1, code: 'D1' }] },
    { trigger: 'C2', dayTypes: ['sunday'], links: [{ offset: 1, code: 'D1' }] },
    // ── call splits (2026-07-22, patch35): C2 OVERNIGHT segment codes mirror
    // C2's +1 D1 on the same dayTypes — a manual C2N12/C2N8 auto-fills the
    // next-day D1 via sequenceAutoFill, and seeded segments transfer D1
    // sequence ownership exactly like a seeded C2. ONLY the +1 D1 (no −1 D3
    // pre-fill: pre-call status belongs to the following day's whole-call
    // machinery, not the segment). C1's overnight segments carry NO chain
    // data — their post-call rest rides requires_post_call_rule via the rest
    // guards + the engine's segment rest inheritance (seedSolveState). Day/
    // evening segments carry no sequence structure at all.
    { trigger: 'C2N12', dayTypes: ['weekday', 'friday', 'federal_holiday', 'major_holiday'],
      links: [{ offset: 1, code: 'D1' }] },
    { trigger: 'C2N12', dayTypes: ['sunday'], links: [{ offset: 1, code: 'D1' }] },
    { trigger: 'C2N8', dayTypes: ['weekday', 'friday', 'federal_holiday', 'major_holiday'],
      links: [{ offset: 1, code: 'D1' }] },
    { trigger: 'C2N8', dayTypes: ['sunday'], links: [{ offset: 1, code: 'D1' }] },
  ],
  reliefPass: { enabled: true, dayTypes: ['weekday', 'friday'] },
  placementPasses: [
    { kind: 'pre_pto', relativeDay: 'thursday_prior_week', codes: ['C1', 'C2'], maxProviders: 2, enabled: true },
  ],
  optimizerMovableDayTypes: ['weekday', 'friday'],
});
