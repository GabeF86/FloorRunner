// patterns/weekendV2.ts
// Weekend call v2 for Paoli (spec 2026-07-12): weekend spread across four
// people — Fri-C1 person (Doc A) carries Sun C2 (friday-anchored +2 link,
// spec 2026-07-15 friday-first: the in-house Friday C1 is chosen FIRST and
// Sunday home-call rides along to the same doc, so a starved pool blanks
// Sun C2, never Fri C1 — previously sunday-anchored with a −2 back-link,
// where a starved Sunday anchor blanked Friday C1); Sat-C2 person carries
// Fri C2 + Sun C1; Neuro (C3) covers Sat + Sun; Sat-C1 person gets Fri D2 and
// Sunday off. dayTypeFillOrder puts friday BETWEEN saturday and sunday so
// the friday C1 anchor fires before the sunday slots would fill standalone
// (saturday still first: its anchors claim Fri C2/D4/D2 ahead of the
// friday pass). callFillOrder makes in-house C1 fill before home-call within
// each date under pool pressure — the two fields compose (dayTypeFillOrder =
// across day types; callFillOrder = within a date).
//
// Neuro weekend (Doc C, spec 2026-07-27 — supersedes the 2026-07-15 overlay
// shape): neuro call is SAT + SUN. Friday neuro call NO LONGER EXISTS as a
// slot — the Friday C2 doc cross-covers neuro that day, unnamed on the board
// (Gabriel chose this over stacking a zero-burden C3 on the C2 doc), and
// patch38 deactivates the friday/C3 shift_templates row. The saturday C3
// anchor keeps its −1 Fri D4 link ("Friday D4 should be given to the doc on
// neuro call that weekend if available"), so the neuro doc still works that
// regular day shift. The +1 Sun C3 link is FTE-gated at 0.75: a 0.75+ doc
// takes the Sat+Sun pair, a sub-0.75 doc takes Saturday alone and the Sunday
// becomes a neuro remainder (only a doc still short of their band may take
// it) — "the 0.5 FTE doc should get either a saturday or a sunday not both".
//
// HISTORY, not live behavior: C3 is an is_overlay shift type (patch25),
// which is what let the OLD shape put Fri D4 and Fri C3 on one person on one
// date. That overlay exemption was always NARROW — one REGULAR shift plus one
// OVERLAY CALL on a date and nothing more; two same-date CALLS still collide
// (overlay or not) and post-call blocked days still bind (eligibility.ts
// call-on-call + blockedOnDate checks). With Fri C3 gone the anchor has a
// single −1 link, so no same-date regular+call pairing is minted here any
// more; is_overlay stays on C3 for the Sat/Sun rows and for manual edits.
// patternEngine.test.ts still pins the two-−1-link order-independence against
// its own synthetic doc.
import { CallPatternDocSchema, type CallPatternDoc } from '../callPattern';

// The patch19/patch25 SQL seeds embed this constant (mirroring how the
// patch18 seed embeds CLASSIC_PATTERN, callPattern.ts) — keep them in sync
// via the emit scripts (scripts/emitNeuroOverlayPatch.ts).
export const WEEKEND_V2_PATTERN: CallPatternDoc = CallPatternDocSchema.parse({
  version: 1,
  callFillOrder: 'call_rank',
  // Friday-first Doc A: saturday anchors fire first (claiming Fri C2,
  // Fri D4, Fri D2, Sun C1, Sun C3 as links), then the friday pass places the
  // in-house Fri C1 whose anchor chains Sun C2 forward, then sunday mops up
  // leftovers. Holidays keep their default tail position.
  dayTypeFillOrder: ['saturday', 'friday', 'sunday', 'weekday', 'federal_holiday', 'major_holiday'],
  spans: [],
  blocks: [
    { anchorDayType: 'saturday', chains: [
      // Neuro block (2026-07-27): the neuro doc covers Sat + Sun C3 and works
      // the Friday D4 day shift when available — Friday NEURO CALL is now
      // cross-covered by the Friday C2 doc and has no slot of its own (the
      // friday/C3 shift_templates row is deactivated in patch38).
      //
      // THE FTE GATE IS GONE (2026-08-03). It read `minFte: 0.6`, so a
      // sub-0.6 doc took Saturday alone and the Sunday was minted as a neuro
      // remainder — the "except for Horan" exception. Gabriel's stated
      // obligation table reverses that: the 0.5 FTE owes "1 Neuro Weekend"
      // like everyone else, and he already holds a full pair on the live
      // block. The requirement band below moved to a single universal
      // {minFte 0, units 1} to match, and the gate has to move with it: they
      // are one decision (neuroWeekendWarnings warns when a link floor is not
      // a band boundary, precisely to stop them splitting). An omitted minFte
      // always fires, which is what "everyone takes the pair" means.
      { trigger: 'C3', links: [{ offset: -1, code: 'D4' }, { offset: 1, code: 'C3' }] },
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
  // Neuro requirement (Gabriel 2026-07-27, REVISED TWICE the same day): "Every
  // call taker should be given a neuro weekend call, except for horan it should
  // only be one weekend day of neuro." The requirement is UNIVERSAL and Horan
  // — the site's only 0.5 — is the ONLY exception. The earlier shape carried a
  // third band, { minFte: 1, units: 0 }, exempting full-timers so they rotated
  // through neuro on fairness alone; that exemption is exactly what the first
  // revision removed and it is gone here. `units: 0` remains a legal band value
  // (callPattern.ts) — no shipped pattern uses it any more.
  //
  // THE BOUNDARY IS 0.6, NOT 0.75 (second revision, same day). At 0.75 the
  // bands quietly created a SECOND exception the rule never asked for: Hussain
  // is 0.66 FTE (he spends a third of his time in the ICU), so he fell into the
  // bottom band and owed half a neuro weekend like Horan. 0.6 puts every call
  // taker except Horan in the full band, which is what the rule actually says.
  //
  // The Sat C3 → Sun C3 link's gate above MUST carry the SAME 0.6, and does.
  // The two are one decision, not two: the band says how much a doc owes, the
  // link gate says whether they may take the Sat+Sun PAIR that discharges it in
  // one weekend. Split them and Hussain owes a full weekend he is gated out of
  // ever taking as a pair — he could only satisfy it as two separate single
  // days, which is not the duty anyone described. callPattern.ts's
  // neuroWeekendWarnings exists to catch exactly that divergence: it warns when
  // a link's minFte is not one of the band boundaries.
  //
  // Below the boundary (Horan alone today) the gate suppresses the Sunday link:
  // she anchors Saturday, the Sunday is minted as a remainder, and only a doc
  // still short of their band may take it.
  //
  // FEASIBILITY, measured 2026-07-27 against a real 11-weekend board rather
  // than argued: supply is one unit per weekend (11.0), demand is (N−1) × 1.0
  // + 0.5 for N call takers. It FITS at N ≤ 11 (10 docs = 9.5 owed, 11 = 10.5)
  // and cannot at N ≥ 12 (12 docs = 11.5 owed, 13 = 12.5). Paoli sits right on
  // that line, so a short block is expected, not a misconfiguration.
  //
  // A shortfall is REPORTED, never enforced. This is a STEERING TIER in
  // scoreCall (solveKernel.ts) — most-short-first on neuro slots — and the gap
  // surfaces as a generation-banner warning (neuroShortfallWarnings). Probed at
  // N = 12 and 13: all 22 neuro slots still filled, 0 unfilled, with the gap
  // reported (0.5 and 1.5 units). The one HARD gate that reads these bands is
  // eligibility's neuro remainder gate, and it only refuses providers who are
  // NOT short — dropping the exempt band makes MORE docs short, so it is
  // strictly more permissive than the three-band shape and cannot strand a slot
  // that used to fill.
  //
  // KNOWN CONSEQUENCE, owner's call if it ever matters: because the tier sorts
  // by units short, a full-timer (owes 1.0) always outranks Horan (owes 0.5),
  // so under scarcity Horan is the one who ends up with no neuro at all. Total
  // shortfall is identical either way — 0.5 units at N = 12 — so this is purely
  // about who absorbs it, and it is visible on the banner when it happens.
  //
  // ── UNIVERSAL SINCE 2026-08-03: THE HORAN EXCEPTION IS REVERSED ────────────
  // Everything above is HISTORY. Gabriel's stated obligation table gives the
  // 0.5 FTE "1 Neuro Weekend" like every other tier, so the two bands collapse
  // to ONE universal band and the Sat → Sun chain gate above is dropped with
  // it (they are one decision). He already holds a full Sat+Sun pair on the
  // live 8/10–10/25 block, so this ratifies what the board already does.
  //
  // FEASIBILITY re-checked on the same 11-weekend arithmetic: demand is now
  // N × 1.0 rather than (N−1) × 1.0 + 0.5, so it fits at N ≤ 11 and is short
  // by 0.5 at exactly the roster Paoli runs today (10 call takers = 10.0 owed
  // against 11.0 supply — comfortable). The shortfall stays REPORTED, never
  // enforced: the eligibility remainder gate only ever refuses providers who
  // are NOT short, and a universal band makes strictly more docs short, so it
  // cannot strand a slot that used to fill.
  neuroWeekend: {
    code: 'C3',
    requirementBands: [
      { minFte: 0, units: 1 },
    ],
  },
  // ── Stated call obligations (Gabriel 2026-08-03) ──────────────────────────
  // His table, verbatim, replacing the derived `slots ÷ par × FTE` share for
  // the codes named here. See callPattern.ts's ObligationCallSchema header for
  // why obligations are stated rather than derived; the short version is that
  // his model is whole CHAINS and the formula's is fractional shares, and only
  // the 1.0 tier is a number both agree on.
  //
  // THE WEEKEND ROWS ARE THIS DOC'S OWN CHAINS READ BACK. "1 Friday C1/Sunday
  // C2 link" is the friday-anchored C1 chain (C1 → C2 at offset +2); "1 Friday
  // C2 Sat C2 Sun C1 link" is the saturday-anchored C2 chain (C2 → Fri C2 at
  // −1, Sun C1 at +1). So a band never invents structure — it says how many
  // times a provider stands each anchor, and the chains above say what each
  // one drags along.
  //
  // NEURO IS ABSENT ON PURPOSE: it is owed in weekend UNITS by
  // requirementBands, and restating it here as a Sat C3 + Sun C3 pair would
  // fork that number (obligationWarnings rejects the attempt loudly).
  //
  // TOTALS, neuro's 2 calls included: 1.0 → 16, 0.75 → 13, 0.7 → 11,
  // 0.5 → 9.5. Verified against the live block, where the three part-FTE call
  // takers hold EXACTLY their band (Simon 13/13, Havildar 13.5/13.5 with the
  // shared 12h Saturday, Hussain 11/11).
  //
  // BLOCK-LENGTH SENSITIVE. "4 Weekday C1" is 44 M–Th C1 slots ÷ par 11; a
  // block of a different length needs different weekday counts. That is why
  // this is config a scheduler can edit and not a formula — but it does mean
  // the weekday rows want a look when the block length changes.
  obligations: {
    bands: [
      // "4 Weekday C1's and C2's, 1 Friday C1 & C2, 1 Saturday C1 & C2,
      //  1 Sunday C1 & C2 and then a neuro Weekend" — 4 weekend obligations
      //  (Fri/Sat/Sun C1 + the neuro pair), 16 calls.
      { minFte: 1, calls: [
        { dayType: 'weekday', code: 'C1', count: 4 },
        { dayType: 'weekday', code: 'C2', count: 4 },
        { dayType: 'friday', code: 'C1', count: 1 },
        { dayType: 'friday', code: 'C2', count: 1 },
        { dayType: 'saturday', code: 'C1', count: 1 },
        { dayType: 'saturday', code: 'C2', count: 1 },
        { dayType: 'sunday', code: 'C1', count: 1 },
        { dayType: 'sunday', code: 'C2', count: 1 },
      ] },
      // "3 Weekday C1 and C2's, 1 Friday C1/Sunday C2 link, 1 Friday C2 Sat C2
      //  Sun C1 link, and a neuro weekend" — 13 calls. Note this is ONE MORE
      //  than the formula's 12: two whole chains beat 0.75 of everything.
      //  One of the two 0.75s also carries half the 12h Saturday split shared
      //  with the 0.5 FTE — that is per-PROVIDER, not per-tier, so it is not
      //  in this band (see the Block Targets panel).
      { minFte: 0.75, calls: [
        { dayType: 'weekday', code: 'C1', count: 3 },
        { dayType: 'weekday', code: 'C2', count: 3 },
        { dayType: 'friday', code: 'C1', count: 1 },
        { dayType: 'sunday', code: 'C2', count: 1 },
        { dayType: 'friday', code: 'C2', count: 1 },
        { dayType: 'saturday', code: 'C2', count: 1 },
        { dayType: 'sunday', code: 'C1', count: 1 },
      ] },
      // "1 Friday and 1 Saturday C1 with associated backups + Neuro weekend,
      //  and 3 Weekday C1's and C2's" — 11 calls. The Friday C1's "backup" is
      //  its chain's Sunday C2; the Saturday C1 chain links only a Friday D2
      //  day shift, so it drags no second call. Hussain holds exactly this.
      { minFte: 0.7, calls: [
        { dayType: 'weekday', code: 'C1', count: 3 },
        { dayType: 'weekday', code: 'C2', count: 3 },
        { dayType: 'friday', code: 'C1', count: 1 },
        { dayType: 'sunday', code: 'C2', count: 1 },
        { dayType: 'saturday', code: 'C1', count: 1 },
      ] },
      // "1.5 Saturday C1's, 2 Weekday C1 and C2's, a Friday and Sunday C2 and
      //  1 Neuro Weekend" — 9.5 calls. The 1.5 is one whole Saturday C1 plus
      //  half of the 12h split shared with a 0.75. minFte 0 makes the table
      //  TOTAL: no roster FTE can fall through to the derived formula and run
      //  a second obligation model alongside everyone else's.
      { minFte: 0, calls: [
        { dayType: 'weekday', code: 'C1', count: 2 },
        { dayType: 'weekday', code: 'C2', count: 2 },
        { dayType: 'saturday', code: 'C1', count: 1.5 },
        { dayType: 'friday', code: 'C2', count: 1 },
        { dayType: 'sunday', code: 'C2', count: 1 },
      ] },
    ],
  },
});
