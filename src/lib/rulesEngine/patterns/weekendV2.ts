// patterns/weekendV2.ts
// Weekend call v2 for Paoli (spec 2026-07-12): weekend spread across four
// people — Sun-C2 person carries Fri C1 (sunday-anchored −2 link; the engine
// fills weekends before Fridays, so the back-link claims Fri C1 first);
// Sat-C2 person carries Fri C2 + Sun C1; Neuro (C3) covers Fri→Sun; Sat-C1
// person gets Fri D2 and Sunday off. callFillOrder makes in-house C1 fill
// before home-call within each date under pool pressure.
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

// The upcoming patch19 SQL seed embeds this constant (mirroring how the
// patch18 seed embeds CLASSIC_PATTERN, callPattern.ts) — keep the two in sync.
export const WEEKEND_V2_PATTERN: CallPatternDoc = CallPatternDocSchema.parse({
  version: 1,
  callFillOrder: 'call_rank',
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
    { anchorDayType: 'sunday', chains: [
      { trigger: 'C2', links: [{ offset: -2, code: 'C1' }] },
    ]},
  ],
  dayChains: [
    { trigger: 'C1', dayTypes: ['weekday', 'friday', 'federal_holiday', 'major_holiday'],
      links: [{ offset: -1, code: 'D2', unlessCallWithinDays: 2 }], blocks: [{ offset: 1 }] },
    { trigger: 'C1', dayTypes: ['saturday'], blocks: [{ offset: 1 }] },
    { trigger: 'C1', dayTypes: ['sunday'], blocks: [{ offset: 1 }] },
    { trigger: 'C2', dayTypes: ['weekday', 'friday', 'federal_holiday', 'major_holiday'],
      links: [{ offset: -1, code: 'D3', unlessCallWithinDays: 2 }, { offset: 1, code: 'D1' }] },
    { trigger: 'C2', dayTypes: ['sunday'], links: [{ offset: 1, code: 'D1' }] },
  ],
  reliefPass: { enabled: true, dayTypes: ['weekday', 'friday'] },
  placementPasses: [
    { kind: 'pre_pto', relativeDay: 'thursday_prior_week', codes: ['C1', 'C2'], maxProviders: 2, enabled: true },
  ],
  optimizerMovableDayTypes: ['weekday', 'friday'],
});
