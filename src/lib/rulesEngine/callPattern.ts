// CallPatternDoc — the declarative call-structure vocabulary. This is the
// single generation-time source for structural behavior (weekend/block chains,
// post/pre-call fills and blocks, spans, placement passes, relief config).
// Validation constraints stay in rule_definitions; structure lives here.
// Spec: docs/superpowers/specs/2026-07-07-scheduling-v2-design.md §5.
import { z } from 'zod';
import { WEIGHT_EPSILON } from '@/lib/callBurden';
// Value import, not a cycle: shared.ts imports only TYPES from genTypes, which
// is erased at compile time, so nothing here imports back into this module.
import { FAIRNESS_BUCKETS } from './shared';

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
// no requirement — a band that puts its FTE range on pure fairness rotation.
// Still a legal value, but as of the 2026-07-27 revision NO shipped pattern
// uses it: Paoli's requirement is universal across call takers (weekendV2.ts).
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

// ── Stated call obligations (Gabriel 2026-08-03) ─────────────────────────────
//
// WHAT THIS REPLACES. Until now a provider's obligation was DERIVED:
// `bucket slots ÷ stored par × FTE` (fteTarget.fteWeightedTarget). That is
// still exactly right for a 1.0 FTE at Paoli — 44 M–Th C1 slots ÷ 11 = 4 — but
// it is wrong for everyone else, because it hands out FRACTIONS of a call in
// buckets that only stand whole ones. A 0.75 FTE derives to 0.75 of a Friday
// C1, and there is no such thing as three quarters of a Friday call.
//
// Gabriel's model is CHAINS, not shares (verbatim, 2026-08-03): "The 0.75 FTE
// are obligated to do 3 Weekday C1 and C2's, 1 Friday C1/Sunday C2 link, 1
// Friday C2 Sat C2 Sun C1 link, and a neuro weekend" — 13 calls, where the
// formula derives 12. So the obligation is STATED, and stated per FTE BAND:
//
//   1.0  → 4 M–Th C1, 4 M–Th C2, one of each weekend call        (16)
//   0.75 → 3 + 3, the Fri C1 chain, the Sat C2 chain             (13)
//   0.7  → 3 + 3, the Fri C1 chain, one Sat C1                   (11)
//   0.5  → 2 + 2, 1.5 Sat C1, one Fri C2, one Sun C2             (9.5)
//
// The "links" are this doc's OWN block chains read back: Paoli's friday-anchored
// C1 chain carries Sun C2 at offset +2, and its saturday-anchored C2 chain
// carries Fri C2 and Sun C1. So a band is not a new vocabulary — it names how
// many times a provider stands each (fairness bucket × call code), and the
// chains say what each one drags along. Confirmed against the live 8/10–10/25
// block: the three part-FTE call takers hold EXACTLY their band (Simon 13/13,
// Havildar 13.5/13.5 with the shared 12h Saturday, Hussain 11/11).
//
// BANDS, NOT AN FTE MAP, mirroring neuroWeekend.requirementBands above:
// `owedCallsFor` picks the HIGHEST band the FTE clears, so a roster FTE nobody
// wrote a row for (0.67, 0.8) lands on the band below it rather than falling
// through to nothing. Same resolution rule, same duplicate-minFte reject, and
// the same reason for it — a duplicated-then-half-edited band would silently
// change a real physician's clinical obligation.
//
// NEURO IS NOT HERE. It is already stated, in weekend UNITS, by
// neuroWeekend.requirementBands, and blockTargets.derivedTargetsFor reads it
// from there. Restating it as a Sat C3 + Sun C3 pair would fork that number
// (see blockTargets.ts: "Do not restate these numbers anywhere").
//
// ABSENT = TODAY'S FORMULA, EXACTLY. A pattern with no `obligations` key
// derives obligations the way it always has, so every other site, CLASSIC_PATTERN
// and every engine fixture are byte-identical and golden parity is untouched.
// This is the property that makes the change safe to ship ahead of the data.
//
// DAY TYPES ARE THE FOUR FAIRNESS BUCKETS (shared.FAIRNESS_BUCKETS), never a
// holiday: dayTypeBucketOn folds a holiday onto the day of the week it falls
// on, so a 'major_holiday' obligation row could never be charged against
// anything and would sit permanently unmet.
const ObligationCallSchema = z.object({
  dayType: z.enum(FAIRNESS_BUCKETS),
  // A PARENT call code (parentCallCodeOf) — an obligation is stated in whole
  // calls, and a 12h segment counts under the call it is a piece of.
  code: z.string().min(1),
  // Fractional on purpose: Paoli's 0.5 FTE owes 1.5 Saturday C1 because he
  // takes one whole one plus half of a 12h split shared with a 0.75.
  count: z.number().min(0).max(50),
}).strict();

const ObligationBandSchema = z.object({
  minFte: z.number().min(0).max(1),
  calls: z.array(ObligationCallSchema).min(1),
}).strict().superRefine((band, ctx) => {
  const seenAt = new Map<string, number>();
  band.calls.forEach((call, i) => {
    const key = `${call.dayType}|${call.code}`;
    const dupeAt = seenAt.get(key);
    if (dupeAt !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: `band minFte ${band.minFte} states ${key} twice (entries ${dupeAt} and ${i}) — `
          + `obligations are read as a map, so one of these silently wins`,
        path: ['calls', i],
      });
    } else {
      seenAt.set(key, i);
    }
  });
});

const ObligationsSchema = z.object({
  bands: z.array(ObligationBandSchema).min(1),
}).strict().superRefine((doc, ctx) => {
  const seenAt = new Map<number, number>();
  doc.bands.forEach((band, i) => {
    const dupeAt = seenAt.get(band.minFte);
    if (dupeAt !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: `obligations.bands has duplicate minFte ${band.minFte} (bands ${dupeAt} and ${i})`,
        path: ['bands', i, 'minFte'],
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
  obligations: ObligationsSchema.optional(),
}).strict();

export type CallPatternDoc = z.infer<typeof CallPatternDocSchema>;
export type PatternDayChain = z.infer<typeof DayChainSchema>;
export type PatternBlockLink = { offset: number; code: string; minFte?: number };
export type ObligationBand = z.infer<typeof ObligationBandSchema>;
export type PatternObligations = z.infer<typeof ObligationsSchema>;

/** The obligation band an FTE falls in: the HIGHEST band whose minFte it
 * clears, exactly as neuroWeekend's owedUnitsFor resolves its own bands. Null
 * when the pattern states no obligations, or when the FTE clears no band at
 * all (a roster FTE below every stated floor owes nothing from this feature
 * and falls back to the derived formula — never silently zero).
 *
 * WEIGHT_EPSILON on the comparison for the same reason owedUnitsFor uses it: a
 * stored 0.75 that arrives as 0.7499999 must still clear a 0.75 floor. */
export function obligationBandFor(
  doc: CallPatternDoc, fte: number,
): ObligationBand | null {
  const bands = doc.obligations?.bands;
  if (!bands) return null;
  let best: ObligationBand | null = null;
  for (const band of bands) {
    if (fte + WEIGHT_EPSILON < band.minFte) continue;
    if (!best || band.minFte > best.minFte) best = band;
  }
  return best;
}

/** Stated calls owed per `${fairness bucket}|${parent code}` for this FTE, or
 * null when the pattern states no band for it (caller keeps the derived
 * formula). Excludes neuro, which is stated in weekend UNITS by
 * neuroWeekend.requirementBands — see the ObligationCallSchema header. */
export function owedCallsFor(
  doc: CallPatternDoc, fte: number,
): Map<string, number> | null {
  const band = obligationBandFor(doc, fte);
  if (!band) return null;
  const out = new Map<string, number>();
  for (const c of band.calls) out.set(`${c.dayType}|${c.code}`, c.count);
  return out;
}

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
  // neuroWeekend.code (2026-07-27): every consumer of the neuro feature — the
  // FTE gate, the remainder eligibility gate, the steering tier, the shortfall
  // report — matches on this ONE string, and each does so by equality against
  // a code that simply never appears. So a typo here does not half-work: the
  // whole feature goes silently inert with nothing anywhere to notice. It is a
  // shift-code reference like any other in the doc and belongs in the same
  // unknown-code warning.
  if (doc.neuroWeekend) codes.add(doc.neuroWeekend.code);
  // Obligation band codes (2026-08-03). Same reasoning as neuroWeekend.code: a
  // band naming a code that does not exist at the site states an obligation
  // nothing can ever satisfy, so the provider reads as permanently short with
  // nothing anywhere to explain it.
  for (const band of doc.obligations?.bands ?? []) {
    for (const c of band.calls) codes.add(c.code);
  }
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

// Load-time coherence between the two `minFte` fields (2026-07-27). The name
// is the same in both places and the MEANING is not: a block-chain link's
// minFte is the GATE (which docs take the designed pair), a requirementBand's
// minFte is a BAND BOUNDARY (how many units a doc owes). Nothing forces them
// to line up, and a mismatch is silent and clinical: gate the Sat→Sun pair at
// 0.5 while the bands step at 0.75, and a 0.5 doc takes the whole pair —
// 1.0 unit of credit against a 0.5-unit obligation — so the remainder this
// feature exists to mint is never minted and nobody is ever reported short.
// Both fields are reachable from the assistant's update_call_pattern tool, so
// a plausible-looking edit produces exactly this.
//
// WARN, never reject — dayTypeFillOrderWarnings' stated rationale applies: a
// site may legitimately gate BETWEEN bands (bands that only separate 1.0 from
// everyone else, with the pair still reserved for 0.75+), and a hard reject
// would knock the whole pattern back to classic over an authoring choice that
// parses fine. Compared with WEIGHT_EPSILON, the same tolerance owedUnitsFor
// uses, so a floor that behaves identically to a boundary never warns.
// Load-time sanity for obligation bands (2026-08-03). Two silent failures are
// worth a warning, and NEITHER is a hard reject — the same rationale as
// dayTypeFillOrderWarnings: knocking a whole pattern back to CLASSIC over an
// authoring choice that parses fine is far worse than the mistake.
//
//   1. NO BOTTOM BAND. owedCallsFor returns null for an FTE below every stated
//      minFte, and that provider silently keeps the derived FTE formula while
//      everyone around them is on stated numbers — the one case where two
//      obligation models run side by side on one roster. A band at minFte 0
//      makes the table total.
//   2. THE NEURO CODE IN A BAND. Neuro is owed in weekend UNITS via
//      neuroWeekend.requirementBands; stating it here too double-counts it
//      (once as units, once as a pair of calls) against the same holdings.
//
// Both take the pool's FTEs where the caller has them, so warning 1 names the
// providers it actually strands rather than speaking in the abstract.
export function obligationWarnings(
  doc: CallPatternDoc,
  fteValues: Iterable<number> = [],
): string[] {
  const bands = doc.obligations?.bands;
  if (!bands || bands.length === 0) return [];
  const out: string[] = [];

  const floors = bands.map(b => b.minFte).sort((a, b) => a - b);
  const uncovered = [...new Set(fteValues)]
    .filter(fte => fte > 0 && obligationBandFor(doc, fte) === null)
    .sort((a, b) => a - b);
  if (uncovered.length > 0) {
    out.push(
      `obligations.bands states no band for FTE ${uncovered.join(', ')} (lowest band is minFte `
      + `${floors[0]}) — those providers keep the DERIVED formula while the rest of the roster is on `
      + `stated obligations. Add a band at minFte 0 to make the table total.`);
  }

  const neuroCode = doc.neuroWeekend?.code;
  if (neuroCode) {
    for (const band of bands) {
      if (!band.calls.some(c => c.code === neuroCode)) continue;
      out.push(
        `obligations band minFte ${band.minFte} states the neuro code '${neuroCode}' as calls, but neuro is `
        + `already owed in WEEKEND UNITS by neuroWeekend.requirementBands — it will be counted twice against `
        + `the same assignments. Drop it from the band.`);
    }
  }
  return out;
}

export function neuroWeekendWarnings(doc: CallPatternDoc): string[] {
  const cfg = doc.neuroWeekend;
  if (!cfg) return [];
  const boundaries = cfg.requirementBands.map(b => b.minFte);
  const listed = [...boundaries].sort((a, b) => a - b).join(', ');
  const out: string[] = [];
  for (const block of doc.blocks) for (const chain of block.chains) for (const link of chain.links) {
    const floor = link.minFte;
    if (floor == null) continue;
    if (boundaries.some(b => Math.abs(b - floor) <= WEIGHT_EPSILON)) continue;
    const msg = `Block chain ${chain.trigger} → ${link.code} (offset ${link.offset}, `
      + `${block.anchorDayType} anchor) gates on minFte ${floor}, which is not a `
      + `neuroWeekend requirementBands boundary (${listed}) — a provider at that FTE `
      + `takes the whole designed pair but owes the units of a different band, so no `
      + `remainder is ever minted. Move the link floor onto a band boundary, or add a `
      + `requirementBand at minFte ${floor}.`;
    if (!out.includes(msg)) out.push(msg);
  }
  return out;
}
