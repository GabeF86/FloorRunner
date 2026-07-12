// patterns/weekendV2.ts
// Weekend call v2 for Paoli (spec 2026-07-12): weekend spread across four
// people — Sun-C2 person carries Fri C1 (sunday-anchored −2 link; the engine
// fills weekends before Fridays, so the back-link claims Fri C1 first);
// Sat-C2 person carries Fri C2 + Sun C1; Neuro (C3) covers Fri→Sun; Sat-C1
// person gets Fri D2 and Sunday off. callFillOrder makes in-house C1 fill
// before home-call within each date under pool pressure.
import { CallPatternDocSchema, type CallPatternDoc } from '../callPattern';

export const WEEKEND_V2_PATTERN: CallPatternDoc = CallPatternDocSchema.parse({
  version: 1,
  callFillOrder: 'call_rank',
  spans: [],
  blocks: [
    { anchorDayType: 'saturday', chains: [
      { trigger: 'C3', links: [{ offset: -1, code: 'C3' }, { offset: 1, code: 'C3' }] },
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
