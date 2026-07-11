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

const BlockChainSchema = z.object({
  trigger: z.string().min(1),
  links: z.array(z.object({ offset: z.number().int().min(-7).max(7), code: z.string().min(1) }).strict()).min(1),
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
}).strict();

export type CallPatternDoc = z.infer<typeof CallPatternDocSchema>;
export type PatternDayChain = z.infer<typeof DayChainSchema>;
export type PatternBlockLink = { offset: number; code: string };

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
