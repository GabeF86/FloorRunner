// CallPatternDoc — the declarative call-structure vocabulary. This is the
// single generation-time source for structural behavior (weekend/block chains,
// post/pre-call fills and blocks, spans, placement passes, relief config).
// Validation constraints stay in rule_definitions; structure lives here.
// Spec: docs/superpowers/specs/2026-07-07-scheduling-v2-design.md §5.
import { z } from 'zod';

export const DAY_TYPES = [
  'weekday', 'friday', 'saturday', 'sunday', 'federal_holiday', 'major_holiday',
] as const;
export type DayType = (typeof DAY_TYPES)[number];
const DayTypeSchema = z.enum(DAY_TYPES);

const LinkSchema = z.object({
  offset: z.number().int().min(-7).max(7),
  code: z.string().min(1),
  unlessCallWithinDays: z.number().int().min(1).max(7).optional(),
}).strict();

const BlockEffectSchema = z.object({ offset: z.number().int().min(-7).max(7) }).strict();

const DayChainSchema = z.object({
  trigger: z.string().min(1),
  dayTypes: z.array(DayTypeSchema).min(1),
  links: z.array(LinkSchema).optional(),
  blocks: z.array(BlockEffectSchema).optional(),
}).strict();

// minFte (2026-07-27): the link fires only when the ANCHOR provider's FTE
// clears this floor — Paoli's Sat C3 → Sun C3 pair is for 0.75+ docs; a
// sub-0.75 doc takes a single neuro day and the partner slot becomes a
// remainder (see neuroWeekend.ts). Absent = always fires, so every existing
// doc, CLASSIC_PATTERN included, is byte-identical. Note: `minFte: 0` here is
// behaviorally identical to omitting it (FTE is always coerced positive, so
// `>= 0` always holds) — unlike requirementBands below, where `minFte: 0` IS
// a meaningful catch-all bottom band. Same field name, different schema,
// different meaning.
const BlockChainSchema = z.object({
  trigger: z.string().min(1),
  links: z.array(z.object({
    offset: z.number().int().min(-7).max(7),
    code: z.string().min(1),
    minFte: z.number().min(0).max(1).optional(),
  }).strict()).min(1),
}).strict();

const SpanSchema = z.object({
  code: z.string().min(1),
  anchorDayType: DayTypeSchema,
  offsets: z.array(z.number().int().min(0).max(7)).min(2),
}).strict();

const PlacementPassSchema = z.object({
  kind: z.literal('pre_pto'),
  relativeDay: z.literal('thursday_prior_week'),
  codes: z.array(z.string().min(1)).min(1),
  maxProviders: z.number().int().min(1).max(10),
  enabled: z.boolean(),
}).strict();

// Neuro weekend requirement bands (2026-07-27). Ordered by nothing in
// particular — owedUnitsFor picks the HIGHEST band the FTE clears. `units` is
// in weekend units (a Sat+Sun pair = 1, a single weekend day = 0.5); 0 means
// no requirement, which is how 1.0 docs stay on pure fairness rotation.
// requirementBands is `.min(1)`: an empty array accomplishes nothing — a
// pattern that wants "no requirement" omits the whole `neuroWeekend` key
// instead, so an empty array is almost certainly a forgotten fill-in.
// superRefine below rejects two bands sharing a minFte: owedUnitsFor resolves
// duplicates silently by array order, so a duplicated-then-half-edited band
// row would silently change a real physician's clinical obligation with no
// warning anywhere. These docs are authored by hand AND by an LLM assistant
// tool (scheduleAssistant/tools.ts has a replace-pattern tool), so the schema
// is the right place to catch it — a hard reject, unlike dayTypeFillOrder's
// deliberately non-fatal unknown-day-type handling, because a duplicate band
// is never an intentional shape.
const NeuroWeekendSchema = z.object({
  code: z.string().min(1),
  requirementBands: z.array(z.object({
    minFte: z.number().min(0).max(1),
    units: z.number().min(0).max(10),
  }).strict()).min(1),
}).strict().superRefine((doc, ctx) => {
  const seenAt = new Map<number, number>();
  doc.requirementBands.forEach((band, i) => {
    const dupeAt = seenAt.get(band.minFte);
    if (dupeAt !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: `requirementBands has duplicate minFte ${band.minFte} (bands ${dupeAt} and ${i})`,
        path: ['requirementBands', i, 'minFte'],
      });
    } else {
      seenAt.set(band.minFte, i);
    }
  });
});

export const CallPatternDocSchema = z.object({
  version: z.literal(1),
  blocks: z.array(z.object({
    anchorDayType: DayTypeSchema,
    chains: z.array(BlockChainSchema),
  }).strict()),
  dayChains: z.array(DayChainSchema),
  spans: z.array(SpanSchema),
  placementPasses: z.array(PlacementPassSchema),
  reliefPass: z.object({ enabled: z.boolean(), dayTypes: z.array(DayTypeSchema).min(1) }).strict().nullable(),
  optimizerMovableDayTypes: z.array(DayTypeSchema),
  // Opt-in within-date call fill order. 'call_rank' sorts each date's call
  // slots by shift_types.call_rank ascending (C1=0 first) so in-house call
  // never starves behind home-call under pool pressure. Absent = legacy
  // order (C2, C3, C1) — classic docs are byte-identical in behavior.
  callFillOrder: z.enum(['call_rank']).optional(),
  // Opt-in ACROSS-DATE fill order: an ordered list of derived_day_type values
  // (saturday, sunday, friday, weekday, federal_holiday, major_holiday).
  // genContext sorts slotsToFill so all slots of the first listed day type
  // fill before the next, and so on; day types NOT listed fall to the tail
  // (after every listed one — the default order's `?? 5` semantics). Absent =
  // the default order EXACTLY (saturday, sunday, friday, weekday, holidays) —
  // classic docs are untouched. Deliberately z.string(), not DayTypeSchema:
  // unknown names degrade to a load warning (dayTypeFillOrderWarnings), never
  // a hard validation failure that would knock the whole pattern back to
  // classic. Composes with callFillOrder: dayTypeFillOrder orders DATES (by
  // day type); callFillOrder orders call codes WITHIN a date.
  dayTypeFillOrder: z.array(z.string().min(1)).optional(),
  neuroWeekend: NeuroWeekendSchema.optional(),
}).strict();

export type CallPatternDoc = z.infer<typeof CallPatternDocSchema>;
export type PatternDayChain = z.infer<typeof DayChainSchema>;
export type PatternBlockLink = { offset: number; code: string; minFte?: number };

// The engine's historical hard-coded behavior, expressed as data. The patch18
// seed and the golden-parity tests both mirror this constant — keep in sync.
export const CLASSIC_PATTERN: CallPatternDoc = {
  version: 1,
  blocks: [{ anchorDayType: 'saturday', chains: [
    { trigger: 'C3', links: [{ offset: 1, code: 'C3' }] },
    { trigger: 'C1', links: [{ offset: 1, code: 'C2' }, { offset: -1, code: 'C2' }] },
    { trigger: 'C2', links: [{ offset: 1, code: 'C1' }, { offset: -1, code: 'D2' }] },
  ] }],
  dayChains: [
    // Holidays behave like weekdays here (legacy chainDFills treated every
    // non-Sat/Sun day type identically) — omitting them would silently lose
    // the holiday post-call day off and D-fills.
    { trigger: 'C1', dayTypes: ['weekday', 'friday', 'federal_holiday', 'major_holiday'],
      links: [{ offset: -1, code: 'D2', unlessCallWithinDays: 2 }], blocks: [{ offset: 1 }] },
    { trigger: 'C1', dayTypes: ['sunday'], blocks: [{ offset: 1 }] },
    { trigger: 'C2', dayTypes: ['weekday', 'friday', 'federal_holiday', 'major_holiday'],
      links: [{ offset: -1, code: 'D3', unlessCallWithinDays: 2 }, { offset: 1, code: 'D1' }] },
    { trigger: 'C2', dayTypes: ['sunday'], links: [{ offset: 1, code: 'D1' }] },
  ],
  spans: [],
  placementPasses: [{ kind: 'pre_pto', relativeDay: 'thursday_prior_week',
                      codes: ['C1', 'C2'], maxProviders: 2, enabled: true }],
  reliefPass: { enabled: true, dayTypes: ['weekday', 'friday'] },
  optimizerMovableDayTypes: ['weekday', 'friday'],
};

export function dayChainsFor(doc: CallPatternDoc, code: string, dayType: string): PatternDayChain[] {
  return doc.dayChains.filter(c => c.trigger === code && (c.dayTypes as string[]).includes(dayType));
}

// Memoization for the two hot pattern accessors. CallPatternDoc objects are
// treated as immutable, so a doc-keyed cache is invisible to callers (pure
// semantics preserved). Callers must not mutate the returned arrays/maps.
const postCallCache = new WeakMap<CallPatternDoc, Map<string, number[]>>();
const blockChainCache = new WeakMap<CallPatternDoc, Map<string, Map<string, PatternBlockLink[]>>>();

// Offsets (relative days) this code blocks for the same provider — the
// post-call-day-off vocabulary. Empty array = no block on that day type.
export function postCallBlockOffsets(doc: CallPatternDoc, code: string, dayType: string): number[] {
  let byKey = postCallCache.get(doc);
  if (!byKey) { byKey = new Map(); postCallCache.set(doc, byKey); }
  const key = `${code}|${dayType}`;
  let cached = byKey.get(key);
  if (!cached) {
    cached = dayChainsFor(doc, code, dayType).flatMap(c => (c.blocks ?? []).map(b => b.offset));
    byKey.set(key, cached);
  }
  return cached;
}

// trigger code -> same-provider links for blocks anchored on `dayType`.
export function blockChainsFor(doc: CallPatternDoc, dayType: string): Map<string, PatternBlockLink[]> {
  let byDayType = blockChainCache.get(doc);
  if (!byDayType) { byDayType = new Map(); blockChainCache.set(doc, byDayType); }
  let cached = byDayType.get(dayType);
  if (!cached) {
    cached = new Map<string, PatternBlockLink[]>();
    for (const block of doc.blocks) {
      if (block.anchorDayType !== dayType) continue;
      for (const chain of block.chains) cached.set(chain.trigger, chain.links);
    }
    byDayType.set(dayType, cached);
  }
  return cached;
}

export function referencedCodes(doc: CallPatternDoc): string[] {
  const codes = new Set<string>();
  for (const b of doc.blocks) for (const c of b.chains) {
    codes.add(c.trigger);
    for (const l of c.links) codes.add(l.code);
  }
  for (const c of doc.dayChains) {
    codes.add(c.trigger);
    for (const l of c.links ?? []) codes.add(l.code);
  }
  for (const s of doc.spans) codes.add(s.code);
  for (const p of doc.placementPasses) for (const code of p.codes) codes.add(code);
  return Array.from(codes).sort();
}

// Load-time sanity: every code the pattern references should exist as a
// shift type at the site. Returns human-readable warnings (never throws).
export function patternWarnings(doc: CallPatternDoc, knownCodes: ReadonlySet<string>): string[] {
  return referencedCodes(doc)
    .filter(code => !knownCodes.has(code))
    .map(code => `Call pattern references shift code '${code}' which is not defined at this site`);
}

// Load-time sanity for callFillOrder='call_rank': every call-category shift
// type should carry a call_rank, otherwise it sorts by solve's legacy code
// fallback (C1=0, C2=1, else 2) — surface that instead of silently
// mis-ordering. Structural param (not ShiftTypeInfo) to avoid a genTypes
// import cycle; genContext passes ctx.shiftTypes.values().
export function callFillOrderWarnings(
  doc: CallPatternDoc,
  shiftTypes: Iterable<{ code: string; category: string; call_rank: number | null }>,
): string[] {
  if (doc.callFillOrder !== 'call_rank') return [];
  const out: string[] = [];
  for (const st of shiftTypes) {
    if (st.category === 'call' && st.call_rank == null) {
      out.push(`callFillOrder='call_rank' but shift type ${st.code} has no call_rank — it will sort by the legacy fallback`);
    }
  }
  return out;
}

// Load-time sanity for dayTypeFillOrder: every listed name should be a known
// derived_day_type — an unknown name never matches a slot, so its intended
// position silently does nothing. Warn (pattern-warning conventions, like
// callFillOrderWarnings), never fail: the rest of the order still applies.
export function dayTypeFillOrderWarnings(doc: CallPatternDoc): string[] {
  if (!doc.dayTypeFillOrder) return [];
  return doc.dayTypeFillOrder
    .filter(dt => !(DAY_TYPES as readonly string[]).includes(dt))
    .map(dt => `dayTypeFillOrder lists unknown day type '${dt}' — it will never match a slot (valid: ${DAY_TYPES.join(', ')})`);
}
