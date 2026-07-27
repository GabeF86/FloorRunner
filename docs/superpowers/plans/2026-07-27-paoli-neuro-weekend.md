# Paoli Neuro Weekend Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Friday neuro coverage onto the Friday C2 role (no Friday C3 slot), make the neuro weekend Sat+Sun, and shape it by FTE — 1.0/0.75 docs take the pair, sub-0.75 docs take a single day, with the leftover day going only to a doc still short of their neuro requirement.

**Architecture:** All structure is declared in the site's `CallPatternDoc` (`minFte` on a block-chain link + a new `neuroWeekend` config block) and interpreted by the engine — the codebase rule is that the solver never re-hardcodes structure. One new pure module (`neuroWeekend.ts`) owns the band/credit vocabulary and is consumed by three solver touchpoints and the generation report, so placement and reporting cannot disagree.

**Tech Stack:** TypeScript, Zod (pattern schema), Vitest (`npm test`), Supabase Postgres (`scheduling` schema, patch SQL applied via the project-scoped `supabase-floorrunner` MCP).

**Spec:** `docs/superpowers/specs/2026-07-27-paoli-neuro-weekend-design.md`

---

## Background an engineer needs before starting

- **Two call patterns exist.** `CLASSIC_PATTERN` (`src/lib/rulesEngine/callPattern.ts`) is the frozen legacy structure used by golden-parity tests; `WEEKEND_V2_PATTERN` (`src/lib/rulesEngine/patterns/weekendV2.ts`) is what Paoli actually runs. Only weekendV2 changes here. If a golden-parity test moves, STOP and report — do not re-baseline.
- **Block chains vs day chains.** A *block chain* fires when a call is placed on its anchor day type and pulls same-provider partners at date offsets (`applyBlockChains`, `src/lib/rulesEngine/solveKernel.ts:643`). A *day chain* fires on any placement and handles pre/post-call fills and blocked days. This work touches block chains only.
- **Invariant 4 (clinical):** a derived/chained shift that gets skipped must be left unassigned AND recorded in `plan.skippedDerived` — never silently dropped. Every new skip path in this plan records.
- **Fill order.** `dayTypeFillOrder` in weekendV2 is `saturday, friday, sunday, …`, so Saturday anchors claim their partners before the Sunday pass runs. That is why the 0.5 doc reaches Sunday only through the remainder path.
- **Weight vocabulary already exists.** `weekendGroupKey` (`src/lib/weekendGroup.ts`) maps any Fri/Sat/Sun date to that weekend's Saturday. Half-weekend arithmetic (pair 1.0, single day 0.5) is the same convention the Call Counts "Obligatory Weekends" column uses.
- **Run tests with** `npx vitest run <file>` for one file, `npm test` for everything. Ten `gridCalculator` files always error with "No test suite found" — that is expected and documented in CLAUDE.md.

## File structure

| File | Responsibility | Change |
|---|---|---|
| `src/lib/rulesEngine/neuroWeekend.ts` | Pure vocabulary: FTE band → owed units, placements → credited units, per-provider report | Create |
| `src/lib/rulesEngine/neuroWeekend.test.ts` | Unit tests for the above | Create |
| `src/lib/rulesEngine/callPattern.ts` | `minFte` on block-chain links; `neuroWeekend` doc field | Modify |
| `src/lib/rulesEngine/genTypes.ts` | `SkippedDerived.reason` gains `'fte-gated'`; `SolveState` re-export unchanged | Modify |
| `src/lib/rulesEngine/solveState.ts` | `neuroRemainderSlotIds` set | Modify |
| `src/lib/rulesEngine/solveKernel.ts` | FTE gate in `applyBlockChains`; reservation fix in `chainCallNeeds`; steering in `scoreCall` | Modify |
| `src/lib/rulesEngine/eligibility.ts` | `neuro-remainder` gate | Modify |
| `src/lib/rulesEngine/types.ts` | `EligibilityResult.reason` gains `'neuro-remainder'` | Modify |
| `src/lib/rulesEngine/patterns/weekendV2.ts` | Drop Fri C3 link, add `minFte`, add `neuroWeekend` config | Modify |
| `src/lib/rulesEngine/autoGenerate.ts` | Surface the neuro report + warnings | Modify |
| `supabase_scheduling_patch38_paoli_neuro_weekend.sql` | Deactivate Friday C3 template row; replace active pattern doc | Create |

---

### Task 1: Neuro band + credit vocabulary

**Files:**
- Create: `src/lib/rulesEngine/neuroWeekend.ts`
- Test: `src/lib/rulesEngine/neuroWeekend.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/rulesEngine/neuroWeekend.test.ts`:

```ts
// Neuro weekend vocabulary (2026-07-27): FTE bands → units owed, placements →
// units credited (pair 1.0 / single day 0.5), and the per-provider report the
// solver gates on and the generation banner shows.
import { describe, it, expect } from 'vitest';
import {
  owedUnitsFor, creditedUnitsByProvider, computeNeuroReport,
  type NeuroWeekendConfig,
} from './neuroWeekend';

// Paoli's bands: 1.0 owes nothing (fairness rotates them), 0.75 owes a full
// weekend, anything below owes a single day.
const CONFIG: NeuroWeekendConfig = {
  code: 'C3',
  requirementBands: [
    { minFte: 1, units: 0 },
    { minFte: 0.75, units: 1 },
    { minFte: 0, units: 0.5 },
  ],
};

// 2026-08-15 Sat / 2026-08-16 Sun = one weekend; 2026-08-22/23 = the next.
const place = (provider_id: string, slot_date: string, code = 'C3') =>
  ({ provider_id, slot_date, code });

describe('owedUnitsFor', () => {
  it('picks the highest band the FTE clears', () => {
    expect(owedUnitsFor(1, CONFIG)).toBe(0);
    expect(owedUnitsFor(0.75, CONFIG)).toBe(1);
    expect(owedUnitsFor(0.5, CONFIG)).toBe(0.5);
  });

  it('an FTE above the top band uses the top band', () => {
    expect(owedUnitsFor(1.2, CONFIG)).toBe(0);
  });

  it('no config bands means nothing is owed', () => {
    expect(owedUnitsFor(0.75, { code: 'C3', requirementBands: [] })).toBe(0);
  });
});

describe('creditedUnitsByProvider', () => {
  it('a Sat+Sun pair is ONE unit, not two', () => {
    const credited = creditedUnitsByProvider(
      [place('p1', '2026-08-15'), place('p1', '2026-08-16')], CONFIG);
    expect(credited.get('p1')).toBe(1);
  });

  it('a single weekend day is half a unit', () => {
    const credited = creditedUnitsByProvider([place('p1', '2026-08-16')], CONFIG);
    expect(credited.get('p1')).toBe(0.5);
  });

  it('two single days in DIFFERENT weekends add to a whole unit', () => {
    const credited = creditedUnitsByProvider(
      [place('p1', '2026-08-15'), place('p1', '2026-08-23')], CONFIG);
    expect(credited.get('p1')).toBe(1);
  });

  it('ignores non-neuro codes and non-weekend dates', () => {
    const credited = creditedUnitsByProvider([
      place('p1', '2026-08-15', 'C1'),   // wrong code
      place('p1', '2026-08-12'),         // Wednesday
    ], CONFIG);
    expect(credited.get('p1') ?? 0).toBe(0);
  });
});

describe('computeNeuroReport', () => {
  const providers = [
    { id: 'full', fte_value: 1 },
    { id: 'three4', fte_value: 0.75 },
    { id: 'half', fte_value: 0.5 },
  ];

  it('reports every provider with a requirement, including those with NO placements', () => {
    const rows = computeNeuroReport(providers, [], CONFIG);
    // 'full' owes 0 — excluded. The other two are short of everything.
    expect(rows.map(r => r.provider_id).sort()).toEqual(['half', 'three4']);
    expect(rows.find(r => r.provider_id === 'three4')).toMatchObject(
      { owed: 1, credited: 0, short: 1 });
    expect(rows.find(r => r.provider_id === 'half')).toMatchObject(
      { owed: 0.5, credited: 0, short: 0.5 });
  });

  it('a satisfied provider reports short 0', () => {
    const rows = computeNeuroReport(providers,
      [place('three4', '2026-08-15'), place('three4', '2026-08-16')], CONFIG);
    expect(rows.find(r => r.provider_id === 'three4')).toMatchObject(
      { owed: 1, credited: 1, short: 0 });
  });

  it('a 0.75 doc holding one leftover day is short exactly half', () => {
    const rows = computeNeuroReport(providers, [place('three4', '2026-08-16')], CONFIG);
    expect(rows.find(r => r.provider_id === 'three4')).toMatchObject(
      { owed: 1, credited: 0.5, short: 0.5 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/rulesEngine/neuroWeekend.test.ts`
Expected: FAIL — `Failed to resolve import "./neuroWeekend"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/rulesEngine/neuroWeekend.ts`:

```ts
// Neuro weekend vocabulary (spec 2026-07-27). ONE home for three questions:
//   - how many weekend units does this FTE owe per block? (bands)
//   - how many has a provider actually earned? (pair 1.0 / single day 0.5)
//   - who is short?  (the report the generation banner shows)
// The solver's FTE gate, its remainder eligibility gate, its scoring tier and
// the generation report ALL consume this module, so placement rules and the
// report can never drift apart.
//
// The half-weekend arithmetic deliberately matches the Call Counts
// "Obligatory Weekends" column (lib/callCountDays.ts): a weekend is the
// Fri/Sat/Sun group keyed by its Saturday, a pair is one unit, a lone
// weekend day is half. WEIGHT_EPSILON absorbs float noise on comparisons.
import { WEIGHT_EPSILON } from '@/lib/callBurden';
import { weekendGroupKey } from '@/lib/weekendGroup';

export interface NeuroRequirementBand {
  minFte: number;
  units: number;
}

export interface NeuroWeekendConfig {
  code: string;
  requirementBands: NeuroRequirementBand[];
}

export interface NeuroPlacement {
  provider_id: string;
  slot_date: string;
  code: string;
}

export interface NeuroReportRow {
  provider_id: string;
  fte: number;
  owed: number;
  credited: number;
  short: number;
}

/** Units owed per block for `fte` — the highest band whose minFte it clears.
 * 0 when no band matches (a provider below every stated band owes nothing). */
export function owedUnitsFor(fte: number, config: NeuroWeekendConfig): number {
  let best: NeuroRequirementBand | null = null;
  for (const band of config.requirementBands) {
    if (fte + WEIGHT_EPSILON < band.minFte) continue;
    if (!best || band.minFte > best.minFte) best = band;
  }
  return best?.units ?? 0;
}

/** Units earned per provider: neuro-code placements grouped into weekends,
 * each weekend capped at ONE unit and a lone day worth half. Non-neuro codes
 * and Mon–Thu dates contribute nothing. */
export function creditedUnitsByProvider(
  placements: ReadonlyArray<NeuroPlacement>,
  config: NeuroWeekendConfig,
): Map<string, number> {
  // pid -> weekend key -> distinct weekend DATES held
  const byPid = new Map<string, Map<string, Set<string>>>();
  for (const p of placements) {
    if (p.code !== config.code) continue;
    const key = weekendGroupKey(p.slot_date);
    if (!key) continue;
    let weekends = byPid.get(p.provider_id);
    if (!weekends) { weekends = new Map(); byPid.set(p.provider_id, weekends); }
    let dates = weekends.get(key);
    if (!dates) { dates = new Set(); weekends.set(key, dates); }
    dates.add(p.slot_date);
  }
  const out = new Map<string, number>();
  for (const [pid, weekends] of byPid) {
    let units = 0;
    for (const dates of weekends.values()) units += dates.size >= 2 ? 1 : 0.5;
    out.set(pid, units);
  }
  return out;
}

/** Per-provider owed/credited/short, for providers who owe anything at all.
 * Providers with NO placements are still reported — that is the case worth
 * catching, and the reason this lives here instead of in a per-assignment
 * evaluator (which would have nothing to anchor a flag on). */
export function computeNeuroReport(
  providers: ReadonlyArray<{ id: string; fte_value: number }>,
  placements: ReadonlyArray<NeuroPlacement>,
  config: NeuroWeekendConfig,
): NeuroReportRow[] {
  const credited = creditedUnitsByProvider(placements, config);
  const rows: NeuroReportRow[] = [];
  for (const p of providers) {
    const owed = owedUnitsFor(p.fte_value, config);
    if (owed <= 0) continue;
    const got = credited.get(p.id) || 0;
    rows.push({
      provider_id: p.id, fte: p.fte_value, owed, credited: got,
      short: Math.max(0, owed - got),
    });
  }
  return rows.sort((a, b) => a.provider_id.localeCompare(b.provider_id));
}

/** Is this provider still short by at least half a unit? The remainder gate's
 * question: only a short provider may take a leftover single neuro day. */
export function isShortByHalfUnit(
  fte: number, creditedUnits: number, config: NeuroWeekendConfig,
): boolean {
  return owedUnitsFor(fte, config) - creditedUnits >= 0.5 - WEIGHT_EPSILON;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/rulesEngine/neuroWeekend.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/rulesEngine/neuroWeekend.ts src/lib/rulesEngine/neuroWeekend.test.ts
git commit -m "neuro-weekend: FTE band + half-weekend credit vocabulary"
```

---

### Task 2: Pattern schema — `minFte` links and the `neuroWeekend` config

**Files:**
- Modify: `src/lib/rulesEngine/callPattern.ts:29-32` (BlockChainSchema), `:46-75` (CallPatternDocSchema)
- Test: `src/lib/rulesEngine/callPattern.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/rulesEngine/callPattern.test.ts`:

```ts
/* ── minFte links + neuroWeekend config (2026-07-27) ─────────────────────── */

describe('block-chain link minFte', () => {
  const doc = (links: unknown[]) => ({
    version: 1,
    blocks: [{ anchorDayType: 'saturday', chains: [{ trigger: 'C3', links }] }],
    dayChains: [], spans: [], placementPasses: [],
    reliefPass: null, optimizerMovableDayTypes: [],
  });

  it('accepts a link carrying minFte', () => {
    const parsed = CallPatternDocSchema.parse(doc([{ offset: 1, code: 'C3', minFte: 0.75 }]));
    expect(parsed.blocks[0].chains[0].links[0].minFte).toBe(0.75);
  });

  it('leaves minFte undefined when absent (every existing doc)', () => {
    const parsed = CallPatternDocSchema.parse(doc([{ offset: 1, code: 'C3' }]));
    expect(parsed.blocks[0].chains[0].links[0].minFte).toBeUndefined();
  });

  it('rejects an out-of-range minFte', () => {
    expect(() => CallPatternDocSchema.parse(doc([{ offset: 1, code: 'C3', minFte: 2 }]))).toThrow();
  });
});

describe('neuroWeekend config', () => {
  const base = {
    version: 1, blocks: [], dayChains: [], spans: [], placementPasses: [],
    reliefPass: null, optimizerMovableDayTypes: [],
  };

  it('parses a band list', () => {
    const parsed = CallPatternDocSchema.parse({
      ...base,
      neuroWeekend: {
        code: 'C3',
        requirementBands: [{ minFte: 1, units: 0 }, { minFte: 0.75, units: 1 }, { minFte: 0, units: 0.5 }],
      },
    });
    expect(parsed.neuroWeekend?.requirementBands).toHaveLength(3);
  });

  it('is optional — docs without it parse unchanged', () => {
    expect(CallPatternDocSchema.parse(base).neuroWeekend).toBeUndefined();
  });

  it('CLASSIC_PATTERN and WEEKEND_V2_PATTERN still parse', () => {
    expect(() => CallPatternDocSchema.parse(CLASSIC_PATTERN)).not.toThrow();
    expect(() => CallPatternDocSchema.parse(WEEKEND_V2_PATTERN)).not.toThrow();
  });
});
```

If `WEEKEND_V2_PATTERN` is not already imported in that test file, add:
`import { WEEKEND_V2_PATTERN } from './patterns/weekendV2';`

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/rulesEngine/callPattern.test.ts`
Expected: FAIL — `minFte` is stripped/rejected by `.strict()` and `neuroWeekend` is an unrecognized key.

- [ ] **Step 3: Write the implementation**

In `src/lib/rulesEngine/callPattern.ts`, replace `BlockChainSchema` (line 29):

```ts
// minFte (2026-07-27): the link fires only when the ANCHOR provider's FTE
// clears this floor — Paoli's Sat C3 → Sun C3 pair is for 0.75+ docs; a
// sub-0.75 doc takes a single neuro day and the partner slot becomes a
// remainder (see neuroWeekend.ts). Absent = always fires, so every existing
// doc, CLASSIC_PATTERN included, is byte-identical.
const BlockChainSchema = z.object({
  trigger: z.string().min(1),
  links: z.array(z.object({
    offset: z.number().int().min(-7).max(7),
    code: z.string().min(1),
    minFte: z.number().min(0).max(1).optional(),
  }).strict()).min(1),
}).strict();
```

In the same file, add the config schema above `CallPatternDocSchema`:

```ts
// Neuro weekend requirement bands (2026-07-27). Ordered by nothing in
// particular — owedUnitsFor picks the HIGHEST band the FTE clears. `units` is
// in weekend units (a Sat+Sun pair = 1, a single weekend day = 0.5); 0 means
// no requirement, which is how 1.0 docs stay on pure fairness rotation.
const NeuroWeekendSchema = z.object({
  code: z.string().min(1),
  requirementBands: z.array(z.object({
    minFte: z.number().min(0).max(1),
    units: z.number().min(0).max(10),
  }).strict()),
}).strict();
```

Add the field inside `CallPatternDocSchema` (after `dayTypeFillOrder`):

```ts
  neuroWeekend: NeuroWeekendSchema.optional(),
```

Also update `PatternBlockLink` so consumers see the new field:

```ts
export type PatternBlockLink = { offset: number; code: string; minFte?: number };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/rulesEngine/callPattern.test.ts`
Expected: PASS (all pre-existing tests plus the 6 new ones).

- [ ] **Step 5: Commit**

```bash
git add src/lib/rulesEngine/callPattern.ts src/lib/rulesEngine/callPattern.test.ts
git commit -m "callPattern: minFte block-chain links + neuroWeekend config schema"
```

---

### Task 3: Solver plumbing — remainder set and the new skip reason

**Files:**
- Modify: `src/lib/rulesEngine/solveState.ts:11-45`
- Modify: `src/lib/rulesEngine/genTypes.ts:288-301`
- Test: `src/lib/rulesEngine/solveState.test.ts` (create if absent)

This task carries no behavior on its own — it adds the two fields Task 4 writes and Task 5 reads. Its test pins the default shape so a later refactor can't drop them.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/rulesEngine/solveState.test.ts`, or create it with:

```ts
import { describe, it, expect } from 'vitest';
import { emptySolveState } from './solveState';

describe('emptySolveState', () => {
  it('starts with an empty neuro remainder set', () => {
    expect(emptySolveState().neuroRemainderSlotIds.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/rulesEngine/solveState.test.ts`
Expected: FAIL — `Cannot read properties of undefined (reading 'size')`.

- [ ] **Step 3: Write the implementation**

In `src/lib/rulesEngine/solveState.ts`, add to the `SolveState` interface (after `callCodesByDate`):

```ts
  // Slot ids the neuro FTE gate left unpaired (2026-07-27): a sub-0.75 anchor
  // suppressed its Sat→Sun partner link, so this slot is a REMAINDER — open
  // only to a provider still short of their neuro requirement (eligibility.ts
  // 'neuro-remainder'), otherwise deliberately left unfilled for the admin.
  neuroRemainderSlotIds: Set<string>;
```

and to `emptySolveState()`:

```ts
    neuroRemainderSlotIds: new Set(),
```

In `src/lib/rulesEngine/genTypes.ts`, extend the `SkippedDerived.reason` union (line 299) and document it:

```ts
  // 'fte-gated' (2026-07-27): a block-chain link carrying minFte was
  // suppressed because the anchor provider's FTE is below the floor — the
  // designed pair is intentionally half-placed (a 0.5 doc gets ONE neuro
  // day), recorded so the suppression stays observable (invariant 4).
  reason: 'pto' | 'cross-site' | 'occupied' | 'no-slot' | 'ineligible' | 'already-handled'
    | 'overridden' | 'obligation-cap' | 'fte-gated';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/rulesEngine/solveState.test.ts && npx tsc --noEmit`
Expected: PASS, and tsc silent.

- [ ] **Step 5: Commit**

```bash
git add src/lib/rulesEngine/solveState.ts src/lib/rulesEngine/genTypes.ts src/lib/rulesEngine/solveState.test.ts
git commit -m "solver: neuroRemainderSlotIds state + fte-gated skip reason"
```

---

### Task 4: FTE gate in `applyBlockChains` (and its reservation)

**Files:**
- Modify: `src/lib/rulesEngine/solveKernel.ts:155-165` (`chainCallNeeds`), `:643-660` (`applyBlockChains` link loop)
- Test: `src/lib/rulesEngine/neuroWeekendPattern.test.ts` (create)

**Why `chainCallNeeds` changes too:** in obligatory mode, an anchor reserves obligation room for every call link it is about to fire (`solve.ts:324,364`). A link the FTE gate will suppress must not be reserved, or a 0.5 doc gets charged for a Sunday they never take.

- [ ] **Step 1: Write the failing test**

Create `src/lib/rulesEngine/neuroWeekendPattern.test.ts`:

```ts
// Neuro weekend FTE gate (spec 2026-07-27): the Sat C3 → Sun C3 pair fires
// for 0.75+ docs and is suppressed for anyone below, leaving the Sunday as a
// remainder slot. Pure fixture contexts — no DB.
import { describe, it, expect } from 'vitest';
import { solve } from './solve';
import { CallPatternDocSchema } from './callPattern';
import { buildCtx, prov, callSlot } from './__fixtures__/buildContext';

// Minimal pattern: the Paoli neuro block, nothing else.
const NEURO_DOC = CallPatternDocSchema.parse({
  version: 1,
  blocks: [{ anchorDayType: 'saturday', chains: [
    { trigger: 'C3', links: [{ offset: 1, code: 'C3', minFte: 0.75 }] },
  ] }],
  dayChains: [], spans: [], placementPasses: [],
  reliefPass: null, optimizerMovableDayTypes: [],
  neuroWeekend: {
    code: 'C3',
    requirementBands: [{ minFte: 1, units: 0 }, { minFte: 0.75, units: 1 }, { minFte: 0, units: 0.5 }],
  },
});

// 2026-08-15 = Saturday, 2026-08-16 = Sunday.
const SAT = '2026-08-15';
const SUN = '2026-08-16';
const slots = () => [
  callSlot('sat-c3', SAT, 'C3', 'saturday'),
  callSlot('sun-c3', SUN, 'C3', 'sunday'),
];

const filledBy = (plan: { assignments: Array<{ slot_id: string; provider_id: string }> }, slotId: string) =>
  plan.assignments.find(a => a.slot_id === slotId)?.provider_id ?? null;

describe('neuro pair FTE gate', () => {
  it('a 1.0 anchor takes BOTH weekend days', () => {
    const ctx = buildCtx(slots(), [prov('full', 1)], { callPattern: NEURO_DOC });
    const plan = solve(ctx);
    expect(filledBy(plan, 'sat-c3')).toBe('full');
    expect(filledBy(plan, 'sun-c3')).toBe('full');
  });

  it('a 0.75 anchor takes BOTH weekend days', () => {
    const ctx = buildCtx(slots(), [prov('three4', 0.75)], { callPattern: NEURO_DOC });
    const plan = solve(ctx);
    expect(filledBy(plan, 'sat-c3')).toBe('three4');
    expect(filledBy(plan, 'sun-c3')).toBe('three4');
  });

  // CORRECTED 2026-07-27 (caught during execution): the first draft of this
  // test asserted `filledBy(plan, 'sun-c3') === null`, which CANNOT hold at
  // this task. The FTE gate suppresses the chain LINK; the main construction
  // loop then reaches the orphaned Sunday as an ordinary open call slot and
  // fills it. Only Task 5's eligibility gate produces an empty Sunday — and
  // Task 5's own tests below pin exactly that. What this task guarantees is
  // that the Sunday is no longer part of the DESIGNED PAIR, so assert that.
  it('a 0.5 anchor takes Saturday alone — the Sunday is no longer chained to them', () => {
    const ctx = buildCtx(slots(), [prov('half', 0.5)], { callPattern: NEURO_DOC });
    const plan = solve(ctx);
    expect(filledBy(plan, 'sat-c3')).toBe('half');
    expect(plan.skippedDerived).toContainEqual(
      { date: SUN, code: 'C3', provider_id: 'half', reason: 'fte-gated' });
    // Un-gated, this slot is placed by the chain with source 'weekend-chain'.
    expect(plan.assignments.find(a => a.slot_id === 'sun-c3')?.source).not.toBe('weekend-chain');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/rulesEngine/neuroWeekendPattern.test.ts`
Expected: the first two PASS; the third FAILS — with no gate, nothing is recorded in `skippedDerived` (`Received: Array []`) and the Sunday is placed by the chain with source `weekend-chain`.

- [ ] **Step 3: Write the implementation**

In `src/lib/rulesEngine/solveKernel.ts`, add the gate helper above `chainCallNeeds`:

```ts
// A minFte link fires only for an anchor provider clearing the floor
// (2026-07-27). Absent minFte = always fires, so every pre-existing pattern
// behaves byte-identically.
function linkFiresFor(link: PatternBlockLink, fte: number): boolean {
  return link.minFte == null || fte + WEIGHT_EPSILON >= link.minFte;
}
```

`PatternBlockLink` is already exported from `./callPattern`; add it to that import if it is not there yet. `WEIGHT_EPSILON` is already imported from `@/lib/callBurden`.

Change `chainCallNeeds` to take the candidate so gated links are not reserved:

```ts
export function chainCallNeeds(run: SolverRun, slot: SlotToFill, p?: CandidateProvider): number {
  let n = dayChainCallNeeds(run, slot);
  const links = blockChainsFor(run.doc, slot.derived_day_type).get(slot.shift_type_code);
  if (links) {
    for (const link of links) {
      // A link the FTE gate will suppress must not reserve obligation room.
      if (p && !linkFiresFor(link, p.fte_value)) continue;
      const t = run.ctx.slotIndex.get(addDays(slot.slot_date, link.offset))?.get(link.code);
      if (t && !run.state.handledSlotIds.has(t.slot_id) && t.shift_type_category === 'call') n++;
    }
  }
  return n;
}
```

Update both call sites in `src/lib/rulesEngine/solve.ts` to pass the provider:

- line 324: `capRoom(run, forced.id) < 1 + chainCallNeeds(run, slot, forced)`
- line 364: `capAdmitted.filter(p => capRoom(run, p.id) >= 1 + chainCallNeeds(run, slot, p))`

In `applyBlockChains`, insert the gate as the FIRST check inside the `for (const link of links)` loop, before the `const date = ...` line:

```ts
  for (const link of links) {
    const date = addDays(slot.slot_date, link.offset);
    // FTE gate (2026-07-27): the designed pair is intentionally half-placed
    // for a sub-floor anchor. Record it (invariant 4) and mark the target a
    // neuro REMAINDER so only a provider short of their requirement can take
    // it (eligibility 'neuro-remainder'); otherwise it stays open for the
    // admin, which is the stated behavior.
    if (!linkFiresFor(link, chosen.fte_value)) {
      skippedDerived.push({ date, code: link.code, provider_id: chosen.id, reason: 'fte-gated' });
      const gatedTarget = ctx.slotIndex.get(date)?.get(link.code);
      if (gatedTarget) run.state.neuroRemainderSlotIds.add(gatedTarget.slot_id);
      continue;
    }
    const target = ctx.slotIndex.get(date)?.get(link.code);
    // ... the rest of the existing loop body continues unchanged from here
    // (the !target / handledSlotIds / overrides / eligibility branches).
```

Concretely: the loop's current first two lines are `const date = addDays(...)` followed by `const target = ctx.slotIndex.get(date)?.get(link.code);`. Insert the `if (!linkFiresFor(...))` block BETWEEN them. Nothing else in the loop changes.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/rulesEngine/neuroWeekendPattern.test.ts`
Expected: PASS, 3 tests.

Then the regression set:
Run: `npx vitest run src/lib/rulesEngine/goldenParity.test.ts src/lib/rulesEngine/patternEngine.test.ts src/lib/rulesEngine/weekendV2Pattern.test.ts`
Expected: PASS unchanged — no pattern in the repo carries `minFte` yet, so this task is inert for them. If golden parity moves, STOP and report.

- [ ] **Step 5: Commit**

```bash
git add src/lib/rulesEngine/solveKernel.ts src/lib/rulesEngine/solve.ts src/lib/rulesEngine/neuroWeekendPattern.test.ts
git commit -m "solver: FTE-gated block-chain links leave a neuro remainder slot"
```

---

### Task 5: The remainder gate in eligibility

**Files:**
- Modify: `src/lib/rulesEngine/eligibility.ts` (add gate after the scenario gates, ~line 216)
- Modify: `src/lib/rulesEngine/genTypes.ts` — `EligibilityResult.reason` is the `RejectionReason` union, which lives HERE, not in `types.ts` (corrected 2026-07-27 during execution; `types.ts` exists but is unrelated). `GenerationContext` already carries `callPattern?`, so no new context field is needed.
- Test: `src/lib/rulesEngine/neuroWeekendPattern.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

CORRECTED 2026-07-27 (caught during execution, the second fixture defect in this plan): the fixtures below MUST close Saturday availability for every doc who should not anchor. Without that shaping the 1.0 doc wins the Saturday anchor, the pair FIRES for them (1.0 clears the 0.75 floor), `neuroRemainderSlotIds` stays empty, and the gate under test is never exercised — all three tests fail on the Saturday assertion rather than the behavior they claim to check. Build the fixtures with `prov('full', 1, { available_weekdays: NO_SATURDAY })` (index 6 false), which forces the sub-floor doc onto the anchor while leaving the excluded docs fully eligible for the leftover Sunday — exactly the candidate the gate must refuse. Do NOT rely on Task 6's steering to produce this; test 3 has no `neuroWeekend` config and therefore no steering term by construction.

Append to `src/lib/rulesEngine/neuroWeekendPattern.test.ts`:

```ts
describe('neuro remainder gate', () => {
  it('a full-FTE doc may NOT take the leftover day — it stays open', () => {
    const ctx = buildCtx(slots(), [prov('half', 0.5), prov('full', 1)], { callPattern: NEURO_DOC });
    const plan = solve(ctx);
    expect(filledBy(plan, 'sat-c3')).toBe('half');
    expect(filledBy(plan, 'sun-c3')).toBe(null);           // NOT the full doc
    expect(plan.unfilled.some(u => u.slot_id === 'sun-c3')).toBe(true);
  });

  it('a 0.75 doc still short of a full weekend MAY take the leftover day', () => {
    // 'full' is in the pool precisely so the assertion below has something to
    // exclude: whoever anchors Saturday, the leftover Sunday must never fall
    // to the 1.0 doc, and a short partial doc may hold it.
    const ctx = buildCtx(slots(),
      [prov('half', 0.5), prov('three4', 0.75), prov('full', 1)], { callPattern: NEURO_DOC });
    const plan = solve(ctx);
    const sun = filledBy(plan, 'sun-c3');
    // STRENGTHENED 2026-07-27: `not.toBe('full')` plus the disjunction below
    // both pass VACUOUSLY on an empty Sunday, so as first drafted this test
    // would have passed even if the gate wrongly refused everyone. Test 1
    // pins refusal; this one must pin ADMISSION.
    expect(sun).toBe('three4');
    expect(sun).not.toBe('full');
  });

  it('the gate is inert without a neuroWeekend config', () => {
    const noConfig = CallPatternDocSchema.parse({
      version: 1,
      blocks: [{ anchorDayType: 'saturday', chains: [
        { trigger: 'C3', links: [{ offset: 1, code: 'C3', minFte: 0.75 }] },
      ] }],
      dayChains: [], spans: [], placementPasses: [],
      reliefPass: null, optimizerMovableDayTypes: [],
    });
    const ctx = buildCtx(slots(), [prov('half', 0.5), prov('full', 1)], { callPattern: noConfig });
    const plan = solve(ctx);
    // Pair still suppressed by minFte, but with no requirement vocabulary the
    // remainder is an ordinary open slot the main loop may fill.
    expect(filledBy(plan, 'sat-c3')).toBe('half');
    expect(filledBy(plan, 'sun-c3')).toBe('full');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/rulesEngine/neuroWeekendPattern.test.ts`
Expected: the first test FAILS — the full doc currently fills the leftover Sunday.

- [ ] **Step 3: Write the implementation**

`evaluateEligibility` receives `ctx` and `state` but not the pattern doc, so surface the config on the context. In `src/lib/rulesEngine/genTypes.ts`, `GenerationContext` already carries `callPattern?: CallPatternDoc` (line 126) — use it directly; no new field is needed.

In `src/lib/rulesEngine/types.ts`, add `'neuro-remainder'` to the `EligibilityResult.reason` union.

In `src/lib/rulesEngine/eligibility.ts`, add imports:

```ts
import { isShortByHalfUnit, creditedUnitsByProvider } from './neuroWeekend';
```

and insert this gate immediately AFTER the scenario prohibition/linkage block (after the closing brace of `if (ctx.scenario && slot.shift_type_category === 'call') { ... }`), before the FTE working-days cap:

```ts
  // Neuro remainder gate (2026-07-27): a slot the FTE gate left unpaired is
  // open ONLY to a provider still short of their neuro requirement by at
  // least half a unit. 1.0 docs owe 0, so a full-FTE doc can never be pulled
  // into a half neuro weekend; with nobody short the slot stays unfilled for
  // the admin, which is the stated behavior. Inert unless the pattern states
  // a neuroWeekend config AND the FTE gate actually fired.
  const neuroCfg = ctx.callPattern?.neuroWeekend;
  if (neuroCfg && state.neuroRemainderSlotIds.has(slot.slot_id)) {
    const held: Array<{ provider_id: string; slot_date: string; code: string }> = [];
    for (const [date, codes] of state.callCodesByDate.get(p.id) ?? []) {
      for (const c of codes) held.push({ provider_id: p.id, slot_date: date, code: c });
    }
    const credited = creditedUnitsByProvider(held, neuroCfg).get(p.id) || 0;
    if (!isShortByHalfUnit(p.fte_value, credited, neuroCfg)) {
      return { eligible: false, reason: 'neuro-remainder' };
    }
  }
```

Placement matters: this sits AFTER every safety gate so a safety block always wins the reported reason (the file's stated convention).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/rulesEngine/neuroWeekendPattern.test.ts src/lib/rulesEngine/eligibility.test.ts`
Expected: PASS.

Run: `npx vitest run src/lib/rulesEngine/goldenParity.test.ts`
Expected: PASS unchanged (no fixture states `neuroWeekend`). If it moves, STOP and report.

- [ ] **Step 5: Commit**

```bash
git add src/lib/rulesEngine/eligibility.ts src/lib/rulesEngine/types.ts src/lib/rulesEngine/neuroWeekendPattern.test.ts
git commit -m "eligibility: neuro remainder open only to providers short of their requirement"
```

---

### Task 6: Steering — short docs sort first for neuro anchors

**Files:**
- Modify: `src/lib/rulesEngine/solveKernel.ts:460-490` (`scoreCall`)
- Test: `src/lib/rulesEngine/neuroWeekendPattern.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `src/lib/rulesEngine/neuroWeekendPattern.test.ts`:

```ts
describe('neuro requirement steering', () => {
  // CORRECTED 2026-07-27 (caught during execution — the THIRD fixture defect
  // in this plan). As first drafted this fixture PASSED before the steering
  // existed: with one doc per weekend, per-FTE fairness already alternates
  // them (the 1.0 doc takes weekend 1, its bucket ratio rises, the 0.75 doc
  // wins weekend 2 unaided), so the tier was never exercised. Adding a second
  // full-timer is NOT enough either — the 0.75 doc then loses only on the
  // final id.localeCompare tiebreak, which is incidental rather than the
  // fairness term the steering exists to overcome. The fixture must:
  //   • give the full-timers enough weekends that fairness never reaches the
  //     0.75 doc (two full-timers for two weekends),
  //   • give the 0.75 doc PRIOR weekend C3 history so its per-FTE ratio
  //     (2/0.75 = 2.67) is strictly worse than either full-timer's 0, and
  //   • name the full-timers so the id tiebreak FAVOURS the 0.75 doc
  //     (e.g. 'zfull1'/'zfull2'), leaving the neuro tier as the only thing
  //     that can win them a weekend.
  // Verify the pre-implementation run shows the 0.75 doc holding ZERO of the
  // four slots before writing any implementation.
  const SAT2 = '2026-08-22';
  const SUN2 = '2026-08-23';
  const twoWeekends = () => [
    callSlot('sat1', SAT, 'C3', 'saturday'),
    callSlot('sun1', SUN, 'C3', 'sunday'),
    callSlot('sat2', SAT2, 'C3', 'saturday'),
    callSlot('sun2', SUN2, 'C3', 'sunday'),
  ];

  it('gives the doc who owes a neuro weekend one of them', () => {
    const ctx = buildCtx(twoWeekends(), [prov('full', 1), prov('three4', 0.75)],
      { callPattern: NEURO_DOC });
    const plan = solve(ctx);
    const held = plan.assignments.filter(a => a.provider_id === 'three4');
    // STRENGTHENED 2026-07-27: `>= 2` accepts two stray SATURDAYS — two half
    // credits that discharge nothing. Pin the designed pair by slot id.
    expect(held.map(a => a.slot_id)).toEqual(['sat1', 'sun1']);
  });

  // Two further cases the plan did not have, both required:
  //   • 'steering does not gate' — the OTHER weekend still fills, with
  //     `unfilled` and `skippedDerived` both empty. Without this, a steering
  //     term that hardened into eligibility would still pass the test above.
  //   • 'inert without a neuroWeekend config' — the identical fixture minus
  //     the config reproduces the pre-steering result exactly. Direct proof
  //     of inertness rather than inferring it from golden parity.
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/rulesEngine/neuroWeekendPattern.test.ts -t "owes a neuro weekend"`
Expected: FAIL — with no steering the 1.0 doc's fairness ratio can take both weekends.

- [ ] **Step 3: Write the implementation**

In `src/lib/rulesEngine/solveKernel.ts`, inside `scoreCall`, compute the neuro shortfall per candidate and add it as a sort term. Add before the `return cands.map(...)`:

```ts
  // Neuro requirement steering (2026-07-27): for neuro-code slots, a provider
  // still short of their band requirement sorts ahead of one who is not.
  // A TIER, never a gate — a block that cannot satisfy everyone still fills,
  // and computeNeuroReport reports the shortfall afterwards.
  const neuroCfg = ctx.callPattern?.neuroWeekend;
  const neuroSlot = neuroCfg != null && slot.shift_type_code === neuroCfg.code;
  const neuroShortOf = (pid: string, fte: number): number => {
    if (!neuroSlot || !neuroCfg) return 0;
    const held: Array<{ provider_id: string; slot_date: string; code: string }> = [];
    for (const [date, codes] of state.callCodesByDate.get(pid) ?? []) {
      for (const c of codes) held.push({ provider_id: pid, slot_date: date, code: c });
    }
    const credited = creditedUnitsByProvider(held, neuroCfg).get(pid) || 0;
    return Math.max(0, owedUnitsFor(fte, neuroCfg) - credited);
  };
```

Add `neuroShort` to the mapped object:

```ts
      neuroShort: neuroShortOf(p.id, p.fte_value),
```

and insert the term into the sort chain, immediately after `a.prefTier - b.prefTier`:

```ts
    b.neuroShort - a.neuroShort ||   // most-short first; 0 for everyone off-neuro
```

Add the import:

```ts
import { creditedUnitsByProvider, owedUnitsFor } from './neuroWeekend';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/rulesEngine/neuroWeekendPattern.test.ts`
Expected: PASS, 7 tests.

Run: `npx vitest run src/lib/rulesEngine/goldenParity.test.ts src/lib/rulesEngine/solve.test.ts src/lib/rulesEngine/optimize.test.ts`
Expected: PASS unchanged — `neuroShort` is 0 for every fixture without a `neuroWeekend` config, so the sort chain is identical. If parity moves, STOP and report.

- [ ] **Step 5: Commit**

```bash
git add src/lib/rulesEngine/solveKernel.ts src/lib/rulesEngine/neuroWeekendPattern.test.ts
git commit -m "solver: steer neuro anchors toward docs short of their requirement"
```

---

### Task 7: Surface the neuro report in generation results

**Files:**
- Modify: `src/lib/rulesEngine/autoGenerate.ts` (result shape ~line 120-135; population ~line 254)
- Test: `src/lib/rulesEngine/neuroWeekend.test.ts` (extend with the warning formatter)

- [ ] **Step 1: Write the failing test**

Append to `src/lib/rulesEngine/neuroWeekend.test.ts`:

```ts
import { neuroShortfallWarnings } from './neuroWeekend';

describe('neuroShortfallWarnings', () => {
  const nameOf = (id: string) => ({ three4: 'A.Jones', half: 'K.Horan' }[id] ?? id);

  it('names each short provider and the shortfall', () => {
    const rows = [
      { provider_id: 'three4', fte: 0.75, owed: 1, credited: 0.5, short: 0.5 },
      { provider_id: 'half', fte: 0.5, owed: 0.5, credited: 0.5, short: 0 },
    ];
    expect(neuroShortfallWarnings(rows, nameOf)).toEqual([
      'A.Jones is short 0.5 of 1 neuro weekend this block (has 0.5).',
    ]);
  });

  it('returns nothing when everyone is satisfied', () => {
    expect(neuroShortfallWarnings(
      [{ provider_id: 'three4', fte: 0.75, owed: 1, credited: 1, short: 0 }], nameOf)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/rulesEngine/neuroWeekend.test.ts`
Expected: FAIL — `neuroShortfallWarnings` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/lib/rulesEngine/neuroWeekend.ts`:

```ts
/** One human-readable warning per SHORT provider, for the generation banner.
 * Satisfied providers produce nothing. */
export function neuroShortfallWarnings(
  rows: ReadonlyArray<NeuroReportRow>,
  nameOf: (providerId: string) => string,
): string[] {
  return rows
    .filter(r => r.short > WEIGHT_EPSILON)
    .map(r => `${nameOf(r.provider_id)} is short ${r.short} of ${r.owed} `
      + `neuro weekend${r.owed === 1 ? '' : 's'} this block (has ${r.credited}).`);
}
```

In `src/lib/rulesEngine/autoGenerate.ts`, add to the `GenerationResult` interface beside `workDayReport`:

```ts
  // Neuro weekend requirement audit (2026-07-27): per-provider owed vs
  // credited weekend units. ABSENT unless the site's pattern states a
  // neuroWeekend config — additive, so pre-change consumers see no new key.
  neuroReport?: NeuroReportRow[];
```

with the import:

```ts
import { computeNeuroReport, neuroShortfallWarnings } from './neuroWeekend';
import type { NeuroReportRow } from './neuroWeekend';
```

After the block that appends `plan.requestWarnings` to `result.warnings` (~line 254), add:

```ts
  // Neuro requirement audit — same surfacing contract as requestWarnings: a
  // NEW array (result.warnings may alias ctx.warnings, so never push).
  const neuroCfg = ctx.callPattern?.neuroWeekend;
  if (neuroCfg) {
    // CORRECTED 2026-07-27 (caught during execution): credit BOTH the plan's
    // assignments AND ctx.seedAssignments. Plan-only is wrong on Paoli's
    // primary path — a Continue ('all') run re-solves only the OPEN slots, so
    // weekends committed by the earlier weekend-only run return as SEEDS
    // (genContext ~:960) and never appear in plan.assignments. Plan-only
    // would report every 0.75 doc short their entire weekend on the very run
    // that finalizes the block. It also breaks this module's stated
    // invariant: the eligibility gate and the scoring tier both judge credit
    // from state.callCodesByDate, which seedSolveState populates FROM SEEDS,
    // so the gate would refuse a remainder as "already satisfied" while the
    // banner called the same doc short. Double-counting is structurally
    // impossible — creditedUnitsByProvider folds dates into a Set.
    const placements = [...plan.assignments, ...ctx.seedAssignments].map(a => ({
      provider_id: a.provider_id,
      slot_date: a.slot_date,
      code: a.shift_type_code,
    }));
    const rows = computeNeuroReport(
      ctx.providers.map(p => ({ id: p.id, fte_value: p.fte_value })), placements, neuroCfg);
    result.neuroReport = rows;
    const nameById = new Map(ctx.providers.map(p => [p.id, p.short_display_name]));
    result.warnings = [
      ...result.warnings,
      ...neuroShortfallWarnings(rows, id => nameById.get(id) ?? id),
    ];
  }
```

(`PlannedAssignment` carries `slot_date` and `shift_type_code` directly — verified in `genTypes.ts:261-272` — so no `slotIndex` lookup is needed.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/rulesEngine/neuroWeekend.test.ts src/lib/rulesEngine/autoGenerate.test.ts && npx tsc --noEmit`
Expected: PASS, tsc silent.

- [ ] **Step 5: Commit**

```bash
git add src/lib/rulesEngine/neuroWeekend.ts src/lib/rulesEngine/neuroWeekend.test.ts src/lib/rulesEngine/autoGenerate.ts
git commit -m "autoGenerate: surface neuro weekend shortfall report and warnings"
```

---

### Task 8: Rewrite the Paoli pattern

**Files:**
- Modify: `src/lib/rulesEngine/patterns/weekendV2.ts:40-50` (the saturday C3 chain) and the doc header comment
- Test: `src/lib/rulesEngine/weekendV2Pattern.test.ts`

- [ ] **Step 1: Update the failing tests**

Three concrete edits in `src/lib/rulesEngine/weekendV2Pattern.test.ts`, all inside the `WEEKEND_V2_PATTERN — golden weekend shape (Doc A/B/C/E)` describe block:

**(a)** Delete the Friday C3 slot from the fixture list (line ~121) — the template no longer produces one:

```ts
    callSlot('friC2', '2026-01-09', 'C2', 'friday'),
    dSlot('friD2', '2026-01-09', 'D2', 'friday'),
```

(i.e. remove the `callSlot('friC3', '2026-01-09', 'C3', 'friday'),` line entirely.)

**(b)** Update the fixture's leading comment: the Saturday anchors now claim "Fri C2, Fri D4, Fri D2, Sun C1, Sun C3" — Fri C3 is gone from that list.

**(c)** Replace the Doc C assertions (line ~156) with:

```ts
    // Doc C (2026-07-27): neuro is Sat + Sun, and the neuro doc still works
    // the Friday D4 day shift. Friday NEURO CALL has no slot at all — the
    // Friday C2 doc cross-covers it.
    expect(byId['friD4']).toBe(byId['satC3']);
    expect(byId['sunC3']).toBe(byId['satC3']);
    expect(byId['friC3']).toBeUndefined();
    expect(plan.skippedDerived ?? []).not.toContainEqual(
      expect.objectContaining({ code: 'C3', reason: 'no-slot' }));
```

The `friC3` line from the old block (`expect(byId['friC3']).toBe(byId['satC3'])`) is deleted; the D4 and sunC3 lines are unchanged in meaning. The four-distinct-people assertion at the end of that test stays as-is — the weekend still has four rows.

Then grep the rest of the file for `friC3` and give each remaining hit the same treatment. Each changed expectation must be individually justified as intentional — do NOT bulk re-baseline.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/rulesEngine/weekendV2Pattern.test.ts`
Expected: FAIL — the pattern still chains Friday C3.

- [ ] **Step 3: Write the implementation**

In `src/lib/rulesEngine/patterns/weekendV2.ts`, replace the neuro block chain:

```ts
      // Neuro block (2026-07-27): the neuro doc covers Sat + Sun C3 and works
      // the Friday D4 day shift when available — Friday NEURO CALL is now
      // cross-covered by the Friday C2 doc and has no slot of its own (the
      // friday/C3 shift_templates row is deactivated in patch38). The Sunday
      // partner is FTE-gated: 0.75+ docs take the pair, a sub-0.75 doc takes
      // Saturday alone and the Sunday becomes a neuro remainder.
      { trigger: 'C3', links: [{ offset: -1, code: 'D4' }, { offset: 1, code: 'C3', minFte: 0.75 }] },
```

Add the config to the same doc, beside `optimizerMovableDayTypes`:

```ts
  // Neuro requirement (Gabriel 2026-07-27): a 0.75 doc owes one full neuro
  // weekend per block; a sub-0.75 doc owes a single weekend day; 1.0 docs owe
  // nothing and rotate through neuro on fairness alone.
  neuroWeekend: {
    code: 'C3',
    requirementBands: [
      { minFte: 1, units: 0 },
      { minFte: 0.75, units: 1 },
      { minFte: 0, units: 0.5 },
    ],
  },
```

Update the file's header comment: neuro is Sat+Sun, Friday C3 no longer exists, and the overlay note now describes history rather than live behavior.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/rulesEngine/weekendV2Pattern.test.ts src/lib/rulesEngine/patternEngine.test.ts src/lib/rulesEngine/callPattern.test.ts`
Expected: PASS.

Run: `npm test`
Expected: 10 known `gridCalculator` "No test suite found" file errors, every real test passing. Golden parity 8/8 unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/lib/rulesEngine/patterns/weekendV2.ts src/lib/rulesEngine/weekendV2Pattern.test.ts
git commit -m "weekendV2: neuro weekend is Sat+Sun, FTE-gated pair, no Friday C3"
```

---

### Task 9: DB patch

**Files:**
- Create: `supabase_scheduling_patch38_paoli_neuro_weekend.sql`
- Helper: check `scripts/emitNeuroOverlayPatch.ts` — the repo emits pattern-doc patches from the TS constant rather than hand-copying JSON. Reuse that mechanism if it fits; otherwise embed the doc literally and note that it mirrors `WEEKEND_V2_PATTERN`.

- [ ] **Step 1: Write the patch**

Create `supabase_scheduling_patch38_paoli_neuro_weekend.sql`:

```sql
-- patch38 — Paoli neuro weekend restructure (spec 2026-07-27)
--
-- 1) Friday neuro coverage moves onto the Friday C2 role: the friday/C3
--    shift_templates row is deactivated, so newly generated schedules have no
--    Friday C3 slot. Existing versions keep the rows they already have.
-- 2) The site's active call pattern is replaced with the doc that mirrors
--    src/lib/rulesEngine/patterns/weekendV2.ts (Sat+Sun neuro, FTE-gated
--    Sunday partner, neuroWeekend requirement bands).
--
-- BOTH statements must land together: a deactivated Friday C3 with the old
-- pattern logs a phantom no-slot skip every weekend, and the new pattern with
-- a live Friday C3 leaves a Friday neuro slot nothing chains.
--
-- Site: Paoli Hospital 2ddd2427-22fb-4290-9c4c-03a957e5af4e
-- Verify the project ref is qhwdbtixhzdsgwwtcfrm before applying.

begin;

update scheduling.shift_templates t
   set is_active = false, updated_at = now()
  from scheduling.shift_types st
 where st.id = t.shift_type_id
   and t.site_id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e'
   and t.day_type = 'friday'
   and st.code = 'C3'
   and t.is_active;

-- Expect: UPDATE 1

update scheduling.call_patterns
   set definition = '<<<PASTE THE JSON EMITTED FROM WEEKEND_V2_PATTERN>>>'::jsonb,
       updated_at = now()
 where site_id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e'
   and status = 'active';

-- Expect: UPDATE 1

commit;
```

Generate the JSON from the TS constant rather than typing it by hand:

```bash
npx tsx -e "import('./src/lib/rulesEngine/patterns/weekendV2.ts').then(m => console.log(JSON.stringify(m.WEEKEND_V2_PATTERN)))"
```

- [ ] **Step 2: Verify the target rows before applying**

Run this read-only check through the `supabase-floorrunner` MCP (confirm the ref is `qhwdbtixhzdsgwwtcfrm` first):

```sql
select st.code, t.day_type, t.is_active
  from scheduling.shift_templates t
  join scheduling.shift_types st on st.id = t.shift_type_id
 where t.site_id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e'
   and st.category = 'call'
 order by t.day_type, st.code;
```

Expected: `friday|C3` present and `is_active = true` — exactly one row to flip.

- [ ] **Step 3: Apply and spot-check**

Apply the patch, then re-run the query from step 2 (`friday|C3` now `is_active = false`, everything else untouched) and:

```sql
select definition -> 'neuroWeekend' as neuro,
       definition -> 'blocks' -> 0 -> 'chains' -> 0 as neuro_chain
  from scheduling.call_patterns
 where site_id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e' and status = 'active';
```

Expected: the bands are present, and the C3 chain has exactly two links (`-1 D4`, `+1 C3 minFte 0.75`) with no `-1 C3`.

- [ ] **Step 4: Record the spot-check in the patch header**

Append the applied date and the two row counts to the patch file's header comment, matching how patch18 records its spot-check.

- [ ] **Step 5: Commit**

```bash
git add supabase_scheduling_patch38_paoli_neuro_weekend.sql
git commit -m "patch38: deactivate Paoli Friday C3 template, install Sat+Sun neuro pattern"
```

---

### Task 10: Full verification and push

- [ ] **Step 1: Run the whole suite**

Run: `npm test`
Expected: 10 `gridCalculator` file errors (known), every real test passing, golden parity 8/8.

- [ ] **Step 2: Typecheck and build**

Run: `npx tsc --noEmit && npm run build`
Expected: both clean.

- [ ] **Step 3: Generate a real draft and read it**

In the app, generate a Paoli draft over a block containing at least two weekends, then confirm on the grid:
- Friday shows C1 and C2 only — no C3 line.
- The neuro doc holds Sat C3 + Sun C3, and Friday D4 when they were free.
- If a sub-0.75 doc anchored a neuro Saturday, the Sunday is either held by a doc short of their requirement or left open.
- The generation banner lists any neuro shortfall.

- [ ] **Step 4: Push**

```bash
git push origin main
```

CLAUDE.md requires pushing promptly after a DB patch so the deployed code matches the live schema.

---

## Rollback

- **Code:** `git revert` the pattern commit (Task 8). The engine changes (Tasks 1-7) are inert without a `neuroWeekend` config or a `minFte` link, so they can stay.
- **DB:** re-activate the template row and restore the previous pattern doc:

```sql
update scheduling.shift_templates t set is_active = true, updated_at = now()
  from scheduling.shift_types st
 where st.id = t.shift_type_id
   and t.site_id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e'
   and t.day_type = 'friday' and st.code = 'C3';
```

The previous pattern doc is recoverable from the archived `call_patterns` row (the assistant's replace-pattern flow archives rather than deletes) or by re-emitting the pre-change `WEEKEND_V2_PATTERN` from git history.
