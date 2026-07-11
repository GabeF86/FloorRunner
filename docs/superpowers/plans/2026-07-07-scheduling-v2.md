# Scheduling v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the scheduling engine data-driven (runtime-definable call structures), fix its confirmed correctness holes, remove its dominant performance bottlenecks, and add a Claude-powered schedule assistant with apply-immediately + undo.

**Architecture:** A new `scheduling.call_patterns` entity (zod-validated `CallPatternDoc` jsonb) becomes the single generation-time source for structural behavior; `solve()` interprets it generically, replacing all hard-coded weekend chains / D-chains / relief lists / `['C1','C2','C3']` literals. Golden-parity tests (new engine + seeded classic pattern ≡ old engine) guard the refactor. The assistant is a server-side Claude tool-use loop whose write tools target `call_patterns`, `shift_types`, and assignments, with a snapshot table for one-click undo. Spec: `docs/superpowers/specs/2026-07-07-scheduling-v2-design.md` — read it before starting any task.

**Tech Stack:** Next.js 14 (App Router route handlers), TypeScript, Supabase (Postgres, `scheduling` schema), vitest, `@anthropic-ai/sdk` ^0.104, `zod` (new dep).

**Conventions for every task:**
- Work on branch `scheduling-v2` (Task 1 creates it). Never commit to `main`.
- Tests: `npx vitest run <file>` for one file, `npm test` for the suite. All new tests are vitest (NOT the `npx tsx` mini-harness used by `rulesNormalizer.test.ts`).
- TDD: write the failing test first, watch it fail, implement, watch it pass, commit.
- The engine files are pure (no I/O) except `genContext.ts`, `commit.ts`, `sequenceAutoFill.ts`, `dayShiftAutoGen.ts`, `loadContext.ts`. Keep that boundary.
- SQL: new DDL goes in `supabase_scheduling_patch18_call_patterns.sql` at repo root (repo convention). Do NOT apply to the live database in Tasks 1–14; Task 15 handles that.
- Cite ALGORITHM.md sections when changing behavior it documents, and update it in Task 15.

---

### Task 1: Branch, zod, CLAUDE.md, dev agents

**Files:**
- Create: `CLAUDE.md`
- Create: `.claude/agents/schedule-engine-reviewer.md`
- Create: `.claude/agents/schedule-correctness-auditor.md`
- Create: `.claude/agents/call-structure-designer.md`
- Modify: `package.json` (zod dep via npm)

- [x] **Step 1: Create branch**

```bash
cd /Users/gabrielfarkas/Desktop/FloorRunner && git checkout -b scheduling-v2
```

- [x] **Step 2: Install zod**

```bash
npm install zod
```
Expected: `zod` appears in `package.json` dependencies; lockfile updated.

- [x] **Step 3: Verify existing suite is green before any changes**

```bash
npm test
```
Expected: PASS (record the test count — this is the baseline). If anything fails on a clean checkout, STOP and report BLOCKED with the output.

- [x] **Step 4: Write CLAUDE.md**

```markdown
# FloorRunner

Anesthesia department management: scheduling engine + staffing calculators + OR floor-runner board. Next.js 14 App Router + Supabase (`scheduling` Postgres schema).

## Commands
- `npm test` — vitest suite (engine + calculators). Single file: `npx vitest run src/lib/rulesEngine/solve.test.ts`
- `npm run dev` — dev server
- Legacy exception: `src/lib/gridCalculator/__tests__/rulesNormalizer.test.ts` runs via `npx tsx`, not vitest.

## Architecture
- `src/lib/rulesEngine/` — call-schedule generation. Pipeline: `loadGenerationContext` (all DB reads) → `solve()` (pure greedy, interprets the site's CallPatternDoc) → `optimize()` (bounded hill-climb) → `commitPlan` → batch validation. See `ALGORITHM.md`.
- **call_patterns vs rule_definitions:** `scheduling.call_patterns` (CallPatternDoc jsonb, one active per site) defines how schedules are BUILT — weekend/block chains, post/pre-call fills, post-call day-off blocks, spans, placement passes, relief config. `scheduling.rule_definitions` define what schedules must SATISFY — validation only (`evaluators.ts`). Never re-hardcode structure in the engine; extend the pattern schema instead (`src/lib/rulesEngine/callPattern.ts`).
- `src/lib/scheduleAssistant/` — Claude tool-use assistant (structure changes + assignment edits, snapshot → undo via `scheduling.assistant_actions`).
- `src/lib/gridCalculator/`, `src/lib/staffingCalculator/` — sibling engines, deliberately not shared with rulesEngine.

## Clinical invariants (violating any of these is a bug, never a tradeoff)
1. Post-call day off after a 24h in-house call (`requires_post_call_rule` shift types) — including seeded/manual assignments.
2. PTO/availability always respected; PENDING PTO blocks in every engine (`isBlockingAvailability` in `shared.ts`).
3. No cross-site double-booking (any site, any schedule version).
4. Skipped derived shifts (e.g. D1 post-C2 blocked by PTO/cross-site) must be left unassigned AND recorded (`plan.skippedDerived`), never silently dropped.
5. Call burden distributes per-FTE (bucket quotas + fairness metrics).
6. Validation must never silently report clean on failure (`EvaluateResult.evaluated`).

## Testing conventions
- Golden parity: `solve()` with the seeded classic pattern must match `solveLegacy` output on the parity fixtures (`src/lib/rulesEngine/goldenParity.test.ts`) except enumerated intentional fixes listed in that file.
- Engine tests build pure `GenerationContext` fixtures — no DB. DB-coupled modules use an injected fake supabase client.
- LLM modules use injected fake clients + fixtures; never call the network in tests.

## Migrations
Root-level `supabase_scheduling_patchN_*.sql` files, applied to the live Supabase project manually/via MCP after review. RLS exists but the app uses the service-role key (auth deferred, internal-only).
```

- [x] **Step 5: Write the three agent definitions**

`.claude/agents/schedule-engine-reviewer.md`:
```markdown
---
name: schedule-engine-reviewer
description: Reviews scheduling-engine diffs against FloorRunner's clinical invariants and architecture rules. Use after any change under src/lib/rulesEngine/ or src/lib/scheduleAssistant/.
tools: Read, Grep, Glob, Bash
---
You are a domain-aware code reviewer for FloorRunner's scheduling engine.

Review the diff you are given (or `git diff main...HEAD -- src/lib/rulesEngine src/lib/scheduleAssistant`) against:

1. **Clinical invariants** (CLAUDE.md "Clinical invariants" section — read it first): post-call day off incl. seeds; pending-PTO blocks everywhere; no cross-site double-booking; skipped derived shifts recorded, never dropped; per-FTE fairness; no silent-clean validation.
2. **No re-hardcoding:** flag ANY new literal shift-code list (`['C1','C2','C3']`, `/^D\d/`, `'D3'`, day-type literals driving structure). Structure belongs in CallPatternDoc; behavior flags belong on shift_types rows.
3. **Purity boundary:** solve/optimize/metrics/eligibility must stay I/O-free.
4. **Golden parity:** if solver behavior changed, check `goldenParity.test.ts` was updated with a cited intentional fix, not weakened silently.
5. Run `npm test` and report failures verbatim.

Report: file:line findings ordered by severity (invariant-violation > correctness > hardcoding > style), each with the invariant it violates and a concrete fix. End with APPROVE or REQUEST_CHANGES.
```

`.claude/agents/schedule-correctness-auditor.md`:
```markdown
---
name: schedule-correctness-auditor
description: Builds fixture probes against the scheduling engine to hunt invariant violations (post-call, PTO, cross-site, quota starvation, skip tracking). Use before merging engine changes or when a generated schedule looks wrong.
tools: Read, Grep, Glob, Bash, Write, Edit
---
You are a correctness auditor for FloorRunner's call-schedule engine (`src/lib/rulesEngine/`).

Method:
1. Read CLAUDE.md invariants + ALGORITHM.md + `genTypes.ts` to understand `GenerationContext`.
2. Write throwaway vitest probes under `src/lib/rulesEngine/__audit__/*.test.ts` — pure fixtures, no DB. For each invariant, construct the adversarial case: seed C1 then open next-day call; PTO overlapping a chained D1; cross-site assignment on a linked date; ΣFTE < par_level; overlay spans; required_count>1 slots; a call code not named C1/C2/C3.
3. Run `npx vitest run src/lib/rulesEngine/__audit__/` and interpret failures: engine bug vs probe bug — read the engine code before deciding.
4. Delete the `__audit__` directory before finishing unless asked to keep it.

Report each violation with: invariant, minimal repro fixture (inline code), engine file:line at fault, suggested fix. No violation found = say so explicitly per invariant.
```

`.claude/agents/call-structure-designer.md`:
```markdown
---
name: call-structure-designer
description: Turns natural-language or image descriptions of call structures into validated CallPatternDoc JSON and dry-runs them against a fixture context. Use when designing or debugging a site's call pattern.
tools: Read, Grep, Glob, Bash, Write
---
You translate call-structure descriptions into `CallPatternDoc` JSON for FloorRunner.

1. Read `src/lib/rulesEngine/callPattern.ts` (schema + CLASSIC_PATTERN example) and the spec §5 (`docs/superpowers/specs/2026-07-07-scheduling-v2-design.md`).
2. Express the requested structure: blocks (anchor day + same-provider chains), dayChains (links/blocks per code+dayType), spans (multi-day same-provider), placementPasses, reliefPass, optimizerMovableDayTypes. List any shift types that must exist (with category/flags/call_rank/relief_rank/is_overlay).
3. Validate: write a throwaway script that imports `CallPatternDocSchema.parse()` on your JSON and run it with `npx tsx`.
4. Dry-run: build a 2-week fixture GenerationContext (copy the builder from `goldenParity.test.ts`), run `solve()`, and show the resulting grid (date × code → provider) so the human can verify the shape.
5. Output: the validated JSON, required shift-type rows, and the dry-run grid. Flag anything the schema cannot express instead of approximating silently.
```

- [x] **Step 6: Commit**

```bash
git add CLAUDE.md .claude/agents package.json package-lock.json
git commit -m "scheduling-v2: branch setup, zod, CLAUDE.md, domain agent definitions"
```

---

### Task 2: Migration SQL — call_patterns, shift_types columns, assistant_actions, RPC, indexes

**Files:**
- Create: `supabase_scheduling_patch18_call_patterns.sql`

No tests (pure DDL; not applied until Task 15). Correctness is reviewed by reading against the spec §4.

- [x] **Step 1: Write the patch file**

```sql
-- Patch 18: call patterns (data-driven call structures), shift_type engine
-- columns, assistant undo snapshots, historical-fairness aggregate, indexes.
-- Spec: docs/superpowers/specs/2026-07-07-scheduling-v2-design.md §4.

-- ── call_patterns ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scheduling.call_patterns (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id      uuid NOT NULL REFERENCES scheduling.sites(id) ON DELETE CASCADE,
  name         text NOT NULL,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','archived')),
  definition   jsonb NOT NULL,
  source       text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','assistant','seed')),
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS call_patterns_one_active
  ON scheduling.call_patterns(site_id) WHERE status = 'active';
CREATE TRIGGER set_updated_at BEFORE UPDATE ON scheduling.call_patterns
  FOR EACH ROW EXECUTE FUNCTION scheduling.tg_set_updated_at();

-- ── shift_types engine columns ──────────────────────────────────────────────
ALTER TABLE scheduling.shift_types
  ADD COLUMN IF NOT EXISTS call_rank int,
  ADD COLUMN IF NOT EXISTS relief_rank int,
  ADD COLUMN IF NOT EXISTS is_overlay boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS generation_engine text NOT NULL DEFAULT 'day_pool'
    CHECK (generation_engine IN ('call','day_pool','none'));

-- Backfill from today's naming conventions (one-time; new rows set explicitly).
UPDATE scheduling.shift_types SET call_rank = CASE code WHEN 'C1' THEN 0 WHEN 'C2' THEN 1 WHEN 'C3' THEN 2 END
  WHERE code IN ('C1','C2','C3') AND call_rank IS NULL;
UPDATE scheduling.shift_types SET relief_rank = (substring(code from '^D([4-9])$'))::int - 3
  WHERE code ~ '^D[4-9]$' AND relief_rank IS NULL;         -- D4→1 .. D9→6
UPDATE scheduling.shift_types SET generation_engine = 'call'
  WHERE category = 'call' OR code ~ '^D[0-9]+$';           -- calls + derived/relief D-codes

-- ── assistant_actions (undo snapshots) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS scheduling.assistant_actions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id         uuid NOT NULL REFERENCES scheduling.schedules(id) ON DELETE CASCADE,
  schedule_version_id uuid REFERENCES scheduling.schedule_versions(id) ON DELETE SET NULL,
  summary             text NOT NULL,
  request_text        text,
  config_before       jsonb NOT NULL,
  assignments_before  jsonb NOT NULL,
  reverted_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- ── historical fairness aggregate (replaces unbounded row fetch) ───────────
CREATE OR REPLACE FUNCTION scheduling.historical_call_counts(p_site_id uuid, p_before date)
RETURNS TABLE (provider_id uuid, bucket text, code text, n bigint)
LANGUAGE sql STABLE AS $$
  SELECT a.provider_id,
         CASE
           WHEN ss.derived_day_type IN ('saturday','sunday') THEN 'weekend'
           WHEN ss.derived_day_type IN ('federal_holiday','major_holiday') THEN 'holiday'
           ELSE ss.derived_day_type::text
         END AS bucket,
         st.code,
         count(*) AS n
  FROM scheduling.assignments a
  JOIN scheduling.schedule_slots ss ON ss.id = a.schedule_slot_id
  JOIN scheduling.shift_types st ON st.id = ss.shift_type_id
  WHERE ss.site_id = p_site_id
    AND ss.slot_date < p_before
    AND a.assignment_status = 'assigned'
    AND a.provider_id IS NOT NULL
    AND st.category = 'call'
  GROUP BY 1, 2, 3
$$;
GRANT EXECUTE ON FUNCTION scheduling.historical_call_counts(uuid, date) TO anon, authenticated, service_role;

-- ── indexes for hot query shapes (skip any that already exist) ──────────────
CREATE INDEX IF NOT EXISTS assignments_provider_status_idx
  ON scheduling.assignments (provider_id, assignment_status);
CREATE INDEX IF NOT EXISTS schedule_slots_version_date_idx
  ON scheduling.schedule_slots (schedule_version_id, slot_date, slot_index);
CREATE INDEX IF NOT EXISTS schedule_slots_date_site_idx
  ON scheduling.schedule_slots (slot_date, site_id);
CREATE INDEX IF NOT EXISTS provider_availability_pid_dates_idx
  ON scheduling.provider_availability (provider_id, start_date, end_date);

-- ── seed one classic pattern per existing site ──────────────────────────────
-- Definition JSON mirrors CLASSIC_PATTERN in src/lib/rulesEngine/callPattern.ts.
INSERT INTO scheduling.call_patterns (site_id, name, status, source, definition)
SELECT s.id, 'Classic (ported from engine)', 'active', 'seed', '{
  "version": 1,
  "blocks": [{ "anchorDayType": "saturday", "chains": [
    { "trigger": "C3", "links": [{ "offset": 1, "code": "C3" }] },
    { "trigger": "C1", "links": [{ "offset": 1, "code": "C2" }, { "offset": -1, "code": "C2" }] },
    { "trigger": "C2", "links": [{ "offset": 1, "code": "C1" }, { "offset": -1, "code": "D2" }] } ] }],
  "dayChains": [
    { "trigger": "C1", "dayTypes": ["weekday","friday"],
      "links": [{ "offset": -1, "code": "D2", "unlessCallWithinDays": 2 }], "blocks": [{ "offset": 1 }] },
    { "trigger": "C1", "dayTypes": ["sunday"], "blocks": [{ "offset": 1 }] },
    { "trigger": "C2", "dayTypes": ["weekday","friday"],
      "links": [{ "offset": -1, "code": "D3", "unlessCallWithinDays": 2 }, { "offset": 1, "code": "D1" }] },
    { "trigger": "C2", "dayTypes": ["sunday"], "links": [{ "offset": 1, "code": "D1" }] } ],
  "spans": [],
  "placementPasses": [{ "kind": "pre_pto", "relativeDay": "thursday_prior_week",
                        "codes": ["C1","C2"], "maxProviders": 2, "enabled": true }],
  "reliefPass": { "enabled": true, "dayTypes": ["weekday","friday"] },
  "optimizerMovableDayTypes": ["weekday","friday"]
}'::jsonb
FROM scheduling.sites s
WHERE NOT EXISTS (
  SELECT 1 FROM scheduling.call_patterns cp WHERE cp.site_id = s.id AND cp.status = 'active'
);
```

**Caveat for the implementer:** check whether `scheduling.tg_set_updated_at()` exists in `supabase_scheduling_schema.sql` (grep `tg_set_updated_at\|set_updated_at`). If the schema uses a different trigger-function name for `updated_at`, use that name; if none exists, drop the trigger statement.

- [x] **Step 2: Sanity-check the SQL parses (no live DB)**

```bash
npx supabase --version >/dev/null 2>&1 && echo ok
grep -c "CREATE TABLE IF NOT EXISTS scheduling" supabase_scheduling_patch18_call_patterns.sql
```
Expected: `2` (call_patterns + assistant_actions). Visual review against spec §4 — every table/column/index in the spec is present.

- [x] **Step 3: Commit**

```bash
git add supabase_scheduling_patch18_call_patterns.sql
git commit -m "scheduling-v2: patch18 DDL — call_patterns, shift_type engine columns, assistant_actions, fairness RPC, indexes"
```

---

### Task 3: CallPatternDoc — types, zod schema, classic constant, helpers

**Files:**
- Create: `src/lib/rulesEngine/callPattern.ts`
- Create: `src/lib/rulesEngine/callPattern.test.ts`

- [x] **Step 1: Write the failing test**

`src/lib/rulesEngine/callPattern.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import {
  CallPatternDocSchema, CLASSIC_PATTERN, dayChainsFor, postCallBlockOffsets,
  blockChainsFor, referencedCodes, patternWarnings,
} from './callPattern';

describe('CallPatternDocSchema', () => {
  it('accepts the classic pattern', () => {
    expect(() => CallPatternDocSchema.parse(CLASSIC_PATTERN)).not.toThrow();
  });
  it('rejects unknown keys and bad day types', () => {
    expect(() => CallPatternDocSchema.parse({ ...CLASSIC_PATTERN, bogus: 1 })).toThrow();
    expect(() => CallPatternDocSchema.parse({
      ...CLASSIC_PATTERN,
      blocks: [{ anchorDayType: 'caturday', chains: [] }],
    })).toThrow();
  });
  it('accepts the proposed weekend structure from the spec (§5.3)', () => {
    const proposed = {
      version: 1,
      blocks: [{ anchorDayType: 'friday', chains: [
        { trigger: 'C1', links: [{ offset: 2, code: 'C2' }] },
        { trigger: 'C2', links: [{ offset: 1, code: 'C2' }] } ] }],
      dayChains: [
        { trigger: 'C1', dayTypes: ['friday', 'saturday', 'sunday'], blocks: [{ offset: 1 }] },
        { trigger: 'C2', dayTypes: ['sunday'], links: [{ offset: 1, code: 'D1' }] } ],
      spans: [{ code: 'NB', anchorDayType: 'friday', offsets: [0, 1, 2] }],
      placementPasses: [],
      reliefPass: { enabled: true, dayTypes: ['weekday'] },
      optimizerMovableDayTypes: ['weekday'],
    };
    expect(() => CallPatternDocSchema.parse(proposed)).not.toThrow();
  });
});

describe('helpers', () => {
  it('dayChainsFor matches trigger + dayType scope', () => {
    expect(dayChainsFor(CLASSIC_PATTERN, 'C1', 'weekday')).toHaveLength(1);
    expect(dayChainsFor(CLASSIC_PATTERN, 'C1', 'saturday')).toHaveLength(0); // weekend block owns Saturday
    expect(dayChainsFor(CLASSIC_PATTERN, 'C2', 'sunday')[0].links?.[0].code).toBe('D1');
  });
  it('postCallBlockOffsets: C1 blocks next day on weekday/sunday, not saturday', () => {
    expect(postCallBlockOffsets(CLASSIC_PATTERN, 'C1', 'weekday')).toEqual([1]);
    expect(postCallBlockOffsets(CLASSIC_PATTERN, 'C1', 'sunday')).toEqual([1]);
    expect(postCallBlockOffsets(CLASSIC_PATTERN, 'C1', 'saturday')).toEqual([]);
    expect(postCallBlockOffsets(CLASSIC_PATTERN, 'C2', 'weekday')).toEqual([]);
  });
  it('blockChainsFor returns the saturday chain map', () => {
    const chains = blockChainsFor(CLASSIC_PATTERN, 'saturday');
    expect(chains.get('C1')).toEqual([{ offset: 1, code: 'C2' }, { offset: -1, code: 'C2' }]);
    expect(blockChainsFor(CLASSIC_PATTERN, 'friday').size).toBe(0);
  });
  it('referencedCodes lists every code the pattern mentions', () => {
    const codes = referencedCodes(CLASSIC_PATTERN);
    for (const c of ['C1', 'C2', 'C3', 'D1', 'D2', 'D3']) expect(codes).toContain(c);
  });
  it('patternWarnings flags codes missing from the known set', () => {
    const known = new Set(['C1', 'C2', 'C3', 'D1', 'D2']); // D3 missing
    const warnings = patternWarnings(CLASSIC_PATTERN, known);
    expect(warnings.some(w => w.includes('D3'))).toBe(true);
    expect(patternWarnings(CLASSIC_PATTERN, new Set([...known, 'D3']))).toEqual([]);
  });
});
```

- [x] **Step 2: Run to verify it fails**

```bash
npx vitest run src/lib/rulesEngine/callPattern.test.ts
```
Expected: FAIL — cannot resolve `./callPattern`.

- [x] **Step 3: Implement `src/lib/rulesEngine/callPattern.ts`**

```typescript
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
    { trigger: 'C1', dayTypes: ['weekday', 'friday'],
      links: [{ offset: -1, code: 'D2', unlessCallWithinDays: 2 }], blocks: [{ offset: 1 }] },
    { trigger: 'C1', dayTypes: ['sunday'], blocks: [{ offset: 1 }] },
    { trigger: 'C2', dayTypes: ['weekday', 'friday'],
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

// Offsets (relative days) this code blocks for the same provider — the
// post-call-day-off vocabulary. Empty array = no block on that day type.
export function postCallBlockOffsets(doc: CallPatternDoc, code: string, dayType: string): number[] {
  return dayChainsFor(doc, code, dayType).flatMap(c => (c.blocks ?? []).map(b => b.offset));
}

// trigger code -> same-provider links for blocks anchored on `dayType`.
export function blockChainsFor(doc: CallPatternDoc, dayType: string): Map<string, PatternBlockLink[]> {
  const out = new Map<string, PatternBlockLink[]>();
  for (const block of doc.blocks) {
    if (block.anchorDayType !== dayType) continue;
    for (const chain of block.chains) out.set(chain.trigger, chain.links);
  }
  return out;
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
```

- [x] **Step 4: Run tests**

```bash
npx vitest run src/lib/rulesEngine/callPattern.test.ts
```
Expected: PASS (all cases).

- [x] **Step 5: Commit**

```bash
git add src/lib/rulesEngine/callPattern.ts src/lib/rulesEngine/callPattern.test.ts
git commit -m "scheduling-v2: CallPatternDoc schema, classic constant, pattern helpers"
```

---

### Task 4: solveLegacy snapshot + golden-parity harness

Freeze today's behavior BEFORE touching solve. The parity test is the safety net for Tasks 5–7.

**Files:**
- Create: `src/lib/rulesEngine/solveLegacy.ts` (verbatim copy of current `solve.ts`, renamed export)
- Create: `src/lib/rulesEngine/goldenParity.test.ts`

- [x] **Step 1: Snapshot the current solver**

```bash
cp src/lib/rulesEngine/solve.ts src/lib/rulesEngine/solveLegacy.ts
```
Then in `solveLegacy.ts` rename the export: `export function solve(` → `export function solveLegacy(` and add a header comment:
```typescript
// FROZEN verbatim copy of solve.ts as of scheduling-v2 start. Used ONLY by
// goldenParity.test.ts to prove the pattern-interpreter refactor preserves
// behavior. DO NOT EDIT. Deleted in the final task of the v2 plan.
```

- [x] **Step 2: Write the parity harness**

`src/lib/rulesEngine/goldenParity.test.ts` — the fixture builder is the important part. Study `src/lib/rulesEngine/solve.test.ts` first and REUSE its context-builder helpers if they are exported or extractable; otherwise build:

```typescript
import { describe, it, expect } from 'vitest';
import { solve } from './solve';
import { solveLegacy } from './solveLegacy';
import { CLASSIC_PATTERN } from './callPattern';
import type { GenerationContext, SlotToFill, CandidateProvider } from './genTypes';

// ── deterministic fixture builder ──────────────────────────────────────────
// Builds a 4-week block (2026-01-05 Mon .. 2026-02-01 Sun) at one site with
// C1/C2/C3 call slots per day (C3 weekends only), D1-D3 derived slots, and
// D4-D6 relief slots on weekdays/fridays — mirroring production shape.
// 10 providers with mixed FTE (1.0 x6, 0.8 x2, 0.5 x2), one with PTO
// 2026-01-14..2026-01-16, one with a cross-site date set, one weekday-limited.
// Deterministic ids: p01..p10, slot ids `${date}|${code}`.
// (Write this builder concretely — ~120 lines. Derive derived_day_type from
// dayOfWeekUTC: 6→saturday, 0→sunday, 5→friday, else weekday. bucketTargets:
// FTE-weighted via the same formula genContext uses: (bucketTotal/parLevel)*fte,
// parLevel 12, no historical deficit. slotIndex covers ALL open slots.)

function buildFixtureContext(overrides?: Partial<GenerationContext>): GenerationContext { /* ... */ }

// Intentional-fix allowances (spec §9). Each diff between legacy and v2 output
// MUST be explained by one of these, asserted specifically below:
//  IF-1 seed-C1 post-call blocking      IF-2 relief D6+ reachability/rescan
//  IF-3 quota relaxation                IF-4 skippedDerived reporting (additive)
const stripAdditive = (plan: any) => ({
  assignments: plan.assignments.map((a: any) => ({ ...a, explanation: undefined })),
  unfilled: plan.unfilled,
});

describe('golden parity: v2 engine + classic pattern ≡ legacy engine', () => {
  it('produces identical assignments and unfilled on the base fixture', () => {
    const ctx = buildFixtureContext();
    const legacy = solveLegacy(ctx);
    const v2 = solve(ctx); // classic pattern is the default when ctx.callPattern is absent
    expect(stripAdditive(v2)).toEqual(stripAdditive(legacy));
  });

  it('parity holds with PTO, cross-site, and weekday-limited providers', () => {
    const ctx = buildFixtureContext(); // builder already includes them
    expect(stripAdditive(solve(ctx))).toEqual(stripAdditive(solveLegacy(ctx)));
  });

  it('parity holds under callOverrides (optimizer forcing seam)', () => {
    const ctx = buildFixtureContext();
    const anyCallSlot = ctx.slotsToFill[0];
    const overrides = new Map([[anyCallSlot.slot_id, ctx.providers[3].id]]);
    expect(stripAdditive(solve(ctx, { callOverrides: overrides })))
      .toEqual(stripAdditive(solveLegacy(ctx, { callOverrides: overrides })));
  });
});
```

Note for the implementer: at this task's commit point `solve` and `solveLegacy` are the same code, so parity trivially passes — that is intentional; the harness exists so Task 5 can refactor against it. `ctx.callPattern` does not exist yet; the `solve(ctx)` call is unchanged legacy behavior.

- [x] **Step 3: Run**

```bash
npx vitest run src/lib/rulesEngine/goldenParity.test.ts && npm test
```
Expected: PASS, full suite still green.

- [x] **Step 4: Commit**

```bash
git add src/lib/rulesEngine/solveLegacy.ts src/lib/rulesEngine/goldenParity.test.ts
git commit -m "scheduling-v2: freeze solveLegacy + golden-parity harness"
```

---

### Task 5: Pattern interpreter in solve.ts + eligibility flag-driven guards

The centerpiece. `solve()` interprets `ctx.callPattern ?? CLASSIC_PATTERN`; all structural literals disappear.

**Files:**
- Modify: `src/lib/rulesEngine/genTypes.ts`
- Modify: `src/lib/rulesEngine/solve.ts`
- Modify: `src/lib/rulesEngine/eligibility.ts`
- Modify: `src/lib/rulesEngine/solve.test.ts` (only if imports/fixtures need the new optional fields — they shouldn't)
- Test: `src/lib/rulesEngine/goldenParity.test.ts` (must stay green), new `src/lib/rulesEngine/patternEngine.test.ts`

- [x] **Step 1: Extend genTypes.ts (additive, optional — old fixtures keep compiling)**

```typescript
// add imports at top:
import type { CallPatternDoc } from './callPattern';

// add to GenerationContext (all optional; solve falls back to CLASSIC_PATTERN
// and code-derived shift info so pure fixtures stay small):
export interface ShiftTypeInfo {
  code: string;
  category: string;
  call_rank: number | null;
  relief_rank: number | null;
  is_overlay: boolean;
  generation_engine: 'call' | 'day_pool' | 'none';
  requires_post_call_rule: boolean;
  call_coverage_type: string | null;
}
// inside GenerationContext:
  callPattern?: CallPatternDoc;
  shiftTypes?: Map<string, ShiftTypeInfo>;   // by code
  warnings?: string[];                        // load-time warnings (pattern codes, quota math)

// add to SolutionPlan:
export interface SkippedDerived {
  date: string;
  code: string;
  provider_id: string;
  reason: 'pto' | 'cross-site' | 'occupied' | 'no-slot' | 'ineligible' | 'already-handled';
}
// SolutionPlan gains: skippedDerived: SkippedDerived[];
// PlacementSource gains: | 'quota-relaxed' | 'span';
// UnfilledSlot.reason stays string; relief slots now also produce entries.
```
`emptySolveState` unchanged. Update `SolutionPlan` construction sites (`solve.ts` line 11, optimize's evaluate) to include `skippedDerived: []`.

- [x] **Step 2: Write failing tests for the new behavior**

`src/lib/rulesEngine/patternEngine.test.ts` — reuse the fixture builder from goldenParity (export it from that file or a shared `__fixtures__/buildContext.ts`). Cases, each a concrete test:

```typescript
// 1. IF-1 seed post-call: seed {date: '2026-01-12'(Mon), code C1, p01} + open C2 on
//    2026-01-13 where p01 would win by scoring → p01 must NOT get the Tuesday call;
//    assert no assignment for p01 on 01-13 and (via a pool of 2) the other provider wins.
// 2. IF-4 skippedDerived: C2 assigned Mon → D1 Tue exists but p has PTO Tue →
//    plan.skippedDerived contains {date: Tue, code: 'D1', provider_id: p, reason: 'pto'}
//    and the D1 slot is NOT assigned to p.
// 3. IF-2 relief: a date whose only open relief slots are D6..D9 (no D4/D5 slot rows)
//    still gets relief assignments; a provider ineligible for D5 (excluded_shift_types)
//    but eligible for D6 receives D6.
// 4. IF-3 quota relaxation: 2 providers, bucketTarget 0.5 each for weekday|C1 →
//    slot gets assigned anyway with source 'quota-relaxed' (lowest lifetime ratio wins),
//    not left unfilled; explanation present.
// 5. NEW STRUCTURE (spec §5.3): fixture with pattern = proposed weekend doc + shift
//    types incl. NB (category 'call', is_overlay false), slots for NB fri/sat/sun:
//    - Fri C1 winner also gets Sun C2 (offset-2 block chain)
//    - every C1 day is followed by a blocked day for that provider (no assignment next day)
//    - NB fri/sat/sun all same provider (span), and that provider CAN also be scored
//      for nothing else those days (default same-date behavior)
//    - Sun C2 winner gets Mon D1 (dayChain link)
// 6. Overlay: same fixture but NB shift type is_overlay: true and one extra D2 slot
//    on Saturday: the NB provider may ALSO hold the Saturday D2 (overlay doesn't
//    consume the one-per-day budget in either direction).
// 7. Custom call code fairness plumbing: pattern referencing code 'NC' with
//    category 'call' in ctx.shiftTypes → after solve, a second NC slot 3 days later
//    prefers the OTHER provider (recency tiebreak saw the first NC) — proves
//    callDates tracking is category-driven, not ['C1','C2','C3']-driven.
// 8. Warnings: ctx.callPattern references code 'ZZ' absent from shiftTypes →
//    solve() still runs; ctx.warnings (returned via loadGenerationContext in Task 6)
//    — for THIS task assert patternWarnings() directly in the fixture instead.
```
Write all 8 concretely with the builder; keep each under ~30 lines.

- [x] **Step 3: Run to verify the new tests fail and parity still passes**

```bash
npx vitest run src/lib/rulesEngine/patternEngine.test.ts src/lib/rulesEngine/goldenParity.test.ts
```
Expected: patternEngine FAILs (behavior not implemented), goldenParity PASS.

- [x] **Step 4: Rewrite solve.ts as the pattern interpreter**

Structure (keep the file under ~400 lines; extract nothing to new files except what's listed):

```typescript
import { CLASSIC_PATTERN, dayChainsFor, postCallBlockOffsets, blockChainsFor } from './callPattern';
// ...existing imports

export function solve(ctx: GenerationContext, opts: SolveOptions = {}): SolutionPlan {
  const doc = ctx.callPattern ?? CLASSIC_PATTERN;
  const shiftInfo = (code: string) => ctx.shiftTypes?.get(code);
  const isCallCode = (code: string, category: string) =>
    category === 'call';                       // category comes from the slot/seed
  const callRank = (code: string) =>
    shiftInfo(code)?.call_rank ?? (code === 'C1' ? 0 : code === 'C2' ? 1 : 2); // legacy fallback
  const reliefCodes = ctx.shiftTypes
    ? [...ctx.shiftTypes.values()].filter(s => s.relief_rank != null)
        .sort((a, b) => a.relief_rank! - b.relief_rank!).map(s => s.code)
    : ['D4', 'D5', 'D6', 'D7', 'D8', 'D9'];    // legacy fallback
  // ...
}
```

Behavior mapping (each bullet replaces a hard-coded block of the legacy file — keep the surrounding logic identical for parity):

1. **Seed loop** (`legacy 14-21`): unchanged, PLUS for each seed apply `postCallBlockOffsets(doc, seed.shift_type_code, seed.derived_day_type)` → `markAssigned(state, addDays(seed.slot_date, off), seed.provider_id)` for each offset. This is IF-1. `addCallDate` condition becomes `seed.shift_type_category === 'call'` (was CALL_CODES literal — parity: seeds with C1/C2/C3 all have category call in fixtures; document this in the parity file's allowance comment if a fixture ever seeds a non-call code).
2. **`record()`** (`legacy 39-59`): `addCallDate` condition `slot.shift_type_category === 'call'` (same note as above).
3. **`chainDFills` → `applyDayChains(slot, p)`**: for each chain in `dayChainsFor(doc, slot.shift_type_code, slot.derived_day_type)`: links → `tryFillDerived(addDays(slot.slot_date, l.offset), l.code, p)` gated by `unlessCallWithinDays` (`hadCallWithin(state, p.id, slot.slot_date, l.unlessCallWithinDays)` — generalize the `twoDaysBefore` check: any call date `d` with `0 < daysBetween(d, slot.slot_date) <= n`); blocks → `markAssigned(state, addDays(slot.slot_date, b.offset), p.id)`. Order: apply links before blocks, and preserve legacy ordering (D2 fill before next-day block for C1; D3 then D1 for C2) by keeping link array order from the doc.
4. **`maybeWeekendBlock` → `applyBlockChains(slot, chosen)`**: `const chains = blockChainsFor(doc, slot.derived_day_type); const links = chains.get(slot.shift_type_code); if (!links) return;` then for each link, the existing `chainAssign` logic against `ctx.slotIndex.get(addDays(slot.slot_date, link.offset))?.get(link.code)` — override handling, gate selection (`call` vs `derived` by target category), `record(..., 'weekend-chain')`, then `applyDayChains(target, provider)` — verbatim from legacy.
5. **Pre-PTO pass** (`legacy 130-166`): wrap in `for (const pass of doc.placementPasses) { if (pass.kind !== 'pre_pto' || !pass.enabled) continue; ... }` — codes from `pass.codes` (ordered fill attempts per ranked provider, same `tryPlacePrePto` first-hit logic generalized to the code list), provider cap `pass.maxProviders` (legacy hard-codes 2 via `ranked[0]/ranked[1]` — generalize to a loop over `ranked.slice(0, pass.maxProviders)`).
6. **Spans (NEW)**: after the pre-PTO pass, before the main loop: for each `doc.spans`, for each date in `ctx.slotIndex` whose derived day type (from any slot on that date) === `span.anchorDayType` and which has an open `span.code` slot: score candidates eligible for ALL span slots (`evaluateEligibility` per offset slot, 'call' gate if category call else 'derived'), pick by the main-loop scoring tuple (reuse the scoring closure), `record(...,'span')` every offset's slot with the winner, apply dayChains per placement. If no candidate covers every day, record each uncoverable slot in `plan.unfilled` with reason `'No provider can cover full span'`.
7. **Main loop** (`legacy 169-235`): identical except (a) zero-candidate path: single sweep — build `candidateReasons` from one `.map()` over providers with the eligibility result captured, filter eligibles from the same sweep (no double evaluation); (b) **quota relaxation (IF-3)**: if every rejection reason is `'bucket-quota'`, pick the provider with lowest lifetime ratio (same formula as scoring), `record(slot, winner, 'quota-relaxed', explanation)` + `applyDayChains` + `applyBlockChains`, and do NOT push unfilled.
8. **Relief pass** (`legacy 237-296`): day filter from `doc.reliefPass` (`if (!doc.reliefPass?.enabled) skip; if (!doc.reliefPass.dayTypes.includes(dt)) continue;`), codes from `reliefCodes`. IF-2 fixes: iterate dates via ANY open relief-code slot (`reliefCodes.map(c => codeMap.get(c)).find(Boolean)` instead of `D4||D5`); per code, score/eligibility against THAT code's slot: keep the date-level `scored` ranking built from the first available relief slot, but replace the forward-only `idx` cursor with, per code, a scan from rank 0 skipping providers already placed that date (`state.assignedOnDate`) or ineligible for this specific slot. Un-fillable relief slots push `plan.unfilled` entries with reason `'No eligible relief provider'` (no candidates array — keep payload small).
9. **`tryFillDerived`**: on each early-return, push to `plan.skippedDerived` with the matching reason (`no-slot`, `already-handled`, `ineligible`) EXCEPT `no-slot` when the pattern simply has no slot that day (that is normal — only record `no-slot` when the trigger's link expected a slot: i.e. always record it; the UI can filter). For `ineligible`, refine: if the provider's availability blocks that date → `'pto'`; if `ctx.crossSiteByDate` hits → `'cross-site'`; if same-date conflict → `'occupied'`; else `'ineligible'`. Determine by calling `evaluateEligibility` and mapping its `reason`.
10. Delete `RELIEF_CODES`, `callTierPriority` literal (use `callRank`), and both `['C1','C2','C3']` literals. `grep -n "C1'\|C2'\|C3'\|D4'\|/\^D" src/lib/rulesEngine/solve.ts` must return ZERO structural matches (string literals may remain only in comments).

- [x] **Step 5: eligibility.ts — flag/pattern-driven guards**

Replace the C1 literal block (lines 54-62) with:
```typescript
  // Post-call day-off guard (call gate only), pattern-driven: a code whose
  // day-chain blocks the NEXT day must not be placed when the provider is
  // already busy that next day. Day-type scoping (e.g. classic Saturday C1
  // exemption) falls out of the pattern doc.
  const doc = ctx.callPattern ?? CLASSIC_PATTERN;
  if (gate === 'call' && postCallBlockOffsets(doc, slot.shift_type_code, slot.derived_day_type).includes(1)) {
    const dayAfter = addDays(slot.slot_date, 1);
    if (state.assignedOnDate.get(dayAfter)?.has(p.id)) {
      return { eligible: false, reason: 'post-call-guard' };
    }
  }
```
And add the same-date overlay exemption at the top (replacing lines 38-41):
```typescript
  const slotOverlay = ctx.shiftTypes?.get(slot.shift_type_code)?.is_overlay ?? false;
  if (!slotOverlay && state.assignedOnDate.get(slot.slot_date)?.has(p.id)) {
    return { eligible: false, reason: 'same-date' };
  }
```
(Overlay-vs-overlay stacking on one date is allowed; a non-overlay slot still can't be given to someone holding a non-overlay assignment. `markAssigned` for overlay placements must NOT add to `assignedOnDate` — do this in `record()`: `if (!isOverlay(slot)) markAssigned(...)` — but blocks from dayChains always mark.) Note: the symmetric "had a post-call-flagged shift yesterday" case is covered structurally by the seed/dayChain `blocks` marking the next day in `assignedOnDate` — no extra eligibility check needed; verify test 1 passes through that path.

- [x] **Step 6: Run everything**

```bash
npx vitest run src/lib/rulesEngine/ && npm test
```
Expected: patternEngine PASS; goldenParity PASS (the parity fixtures must not exercise IF-1..IF-4 paths — if a parity fixture trips one (e.g. its PTO provider chains a skipped D1, changing nothing in output but adding skippedDerived entries), `stripAdditive` already ignores additive fields; if an actual assignment diff appears, verify it maps to IF-1/2/3 and split that fixture into its own test with the legacy expectation replaced and a comment citing the IF number). Existing solve.test.ts expectations that change must each cite an IF number in the updated test.

- [x] **Step 7: Commit**

```bash
git add -A src/lib/rulesEngine
git commit -m "scheduling-v2: solve() interprets CallPatternDoc; seed post-call fix, skippedDerived, quota relaxation, relief fixes, overlay support"
```

---

### Task 6: genContext loads pattern + shift types + precomputed invariants; RPC fairness; cross-site window fix

**Files:**
- Modify: `src/lib/rulesEngine/genContext.ts`
- Modify: `src/lib/rulesEngine/genTypes.ts` (promote precomputed fields)
- Test: `src/lib/rulesEngine/genContext.test.ts` (new — fake supabase client)

- [x] **Step 1: Failing tests** — build a fake supabase client (chainable `{from, select, eq, in, lt, gte, lte, order, rpc}` returning canned rows; copy the fake-client pattern from `src/lib/boardApi.test.ts` if one exists, else write a ~40-line builder). Cases:

```typescript
// 1. loads full shift_types rows into ctx.shiftTypes keyed by code (call_rank,
//    relief_rank, is_overlay, generation_engine, requires_post_call_rule present).
// 2. loads active call_patterns row for the site → ctx.callPattern (zod-parsed);
//    invalid jsonb → ctx.callPattern undefined + warning in ctx.warnings.
// 3. no active pattern row → ctx.callPattern undefined (engine falls back to classic), no crash.
// 4. historical counts come from rpc('historical_call_counts', {p_site_id, p_before})
//    and populate historicalAssignedByPid/historicalTotalByBucket identically to the
//    old row-scan for the same data.
// 5. cross-site window: given slotIndex dates 2026-01-05..2026-02-01, the cross-site
//    query filters slot_date >= 2026-01-04 AND <= 2026-02-02 (±1 day) — assert via
//    the fake client's recorded filters.
// 6. warnings: pattern referencing unknown code produces a warning; Σ bucketTarget
//    < bucketTotal for any bucket produces the quota warning string.
```

- [x] **Step 2: Implement.** Key edits in `genContext.ts`:
- shift_types select: replace `shift_types(code, category)` narrow selects with a dedicated site-wide query `from('shift_types').select('code, category, call_rank, relief_rank, is_overlay, generation_engine, requires_post_call_rule, call_coverage_type').eq('site_id', siteId).eq('is_active', true)` → build `shiftTypes` map. (Keep the nested join for slots as-is.)
- pattern: `from('call_patterns').select('definition').eq('site_id', siteId).eq('status','active').maybeSingle()` → `CallPatternDocSchema.safeParse`; on failure push warning `'Active call pattern failed validation: <first issue>'`.
- historical: replace the unbounded select (lines ~365-393) with `sb.rpc('historical_call_counts', { p_site_id: siteId, p_before: minDate })`; rows `{provider_id, bucket, code, n}` → same maps (`key = \`${bucket}|${code}\``). If the RPC errors (function not yet applied to live DB), FALL BACK to the legacy query and push a warning — this keeps dev environments working before Task 15 applies patch18.
- cross-site window: derive `minDate/maxDate` from ALL `slotIndex` keys, then widen by 1 day each side (`addDays(minDate,-1)`, `addDays(maxDate,1)`).
- precompute and attach: `providerById`, `prePtoByThursday`, sorted `scheduleDates` — add to `GenerationContext` as optional fields; `solve()` uses them when present, else computes locally (keeps pure fixtures working). Move the construction code out of solve into genContext (solve keeps a tiny fallback).
- quota warning: after computing bucketTarget, for each bucket compare `Σ targets` vs `bucketTotals` and warn: `'Bucket <bucket>: FTE-weighted quota (<sum>) cannot cover <total> slots — check call_par_level vs pool FTE'`.
- `warnings` array flows into the GenerationResult in `autoGenerate.ts` (add `warnings: ctx.warnings ?? []` to the result object) — grep `GenerationResult` in `genTypes.ts`/`autoGenerate.ts` and add the field.

- [x] **Step 3: Run** `npx vitest run src/lib/rulesEngine/ && npm test` — all green (parity untouched: fixtures don't set the new fields).

- [x] **Step 4: Commit** — `git commit -am "scheduling-v2: genContext loads call pattern + full shift types, RPC fairness aggregate, cross-site window fix, load-time warnings"`

---

### Task 7: metrics + optimize — category-driven, pre-gated, wall-clock budget, pattern-aware burnout

**Files:**
- Modify: `src/lib/rulesEngine/metrics.ts`, `src/lib/rulesEngine/optimize.ts`
- Test: extend `src/lib/rulesEngine/metrics.test.ts`, `src/lib/rulesEngine/optimize.test.ts`

- [x] **Step 1: Failing tests**
```typescript
// metrics: a custom call code 'NC' (category call in shiftTypes) contributes to
//   fairnessStdev and burnout exactly as C1 does. Burnout exemption: two call dates
//   1 day apart both inside a saturday-anchored block window (Fri-Sun) are exempt
//   (classic parity), but Fri+Sat calls under a pattern with NO blocks are counted.
// optimize: (a) with a provider on PTO for the whole block, no resolve is spent
//   trying them (assert via an injected resolve-counter — expose `stats` on the
//   optimize return or accept an onResolve callback in opts; choose the `stats`
//   field: {resolves, gatedSkips, wallMs}); (b) a wallClockMs budget of 0 returns
//   the seed plan unchanged; (c) movable slots = main-loop assignments whose
//   dayType ∈ doc.optimizerMovableDayTypes (classic: weekday+friday — assert a
//   saturday main-loop assignment is not moved).
```

- [x] **Step 2: Implement.**
- `metrics.ts`: drop `CALL_CODES` (line 4); call-ness = `a.shift_type_category === 'call'`. Burnout exemption: replace the hard-coded Fri–Sun window with: for each `doc.blocks` (doc from `ctx.callPattern ?? CLASSIC_PATTERN` — scoreSolution already receives ctx), a pair of call dates (d1,d2) is exempt when both fall inside `[anchor + minOff, anchor + maxOff]` for the same anchor date, where anchor dates are the dates in the plan whose derived day type === `block.anchorDayType`, and minOff/maxOff = min/max link offsets in that block's chains together with 0. Classic: min −1, max +1 → Fri–Sun around each Saturday — exact parity.
- `optimize.ts`: (1) `CALL_CODES` → category check on the plan assignments; (2) movable filter uses `doc.optimizerMovableDayTypes`; (3) build `pid → movable slot ids` map once per scan (replaces per-candidate `movable.filter`); (4) pre-gate: before `evaluate(ctx, trial)`, rebuild a cheap `SolveState` snapshot of the current best ONCE per scan and check `evaluateEligibility(slotOfInterest, candidate, snapshotState, ctx, 'call').eligible` — skip the resolve when ineligible (count as `gatedSkips`); (5) wall-clock: `opts.wallClockMs ?? 2000`, checked per trial via `Date.now()` captured at entry — note vitest runs allow Date.now; add `wallClockMs` to the optimize options type and thread from autoGenerate env/param (default 2000, `SCHEDULING_OPTIMIZE_WALL_MS` env override); (6) return `stats` alongside the plan (adjust `autoGenerate.ts` call site + result type; include stats in GenerationResult for observability).

- [x] **Step 3: Run** `npx vitest run src/lib/rulesEngine/ && npm test` — green incl. parity (optimizer output for classic fixtures must be identical: pre-gating only SKIPS trials that would have been rejected as no-improvement anyway — verify: a gated trial in legacy resolves to a plan where the forced provider self-rejects → `unfilled` grows → compareMetrics rejects it. So gating cannot change the chosen plan. State this reasoning in a comment. The wall-clock default must be generous enough that fixture-sized optimizations never hit it.)

- [x] **Step 4: Commit** — `git commit -am "scheduling-v2: metrics/optimize category-driven, eligibility pre-gating, wall-clock budget, pattern-aware burnout"`

---

### Task 8: Batch validation + evaluated flag + neighbor scoping + per-FTE fairness + evaluators tests

**Files:**
- Modify: `src/lib/rulesEngine/evaluate.ts`, `src/lib/rulesEngine/loadContext.ts`, `src/lib/rulesEngine/commit.ts`, `src/lib/rulesEngine/evaluators.ts`
- Modify: `src/app/api/scheduling/schedule-assignments/[id]/validate/route.ts`, `src/app/api/scheduling/schedule-assignments/route.ts` (revalidateNeighbors)
- Create: `src/lib/rulesEngine/evaluators.test.ts`, `src/lib/rulesEngine/batchValidate.ts` (+ test)

- [x] **Step 1: Failing tests**

`evaluators.test.ts` — hand-built `EvaluationContext` fixtures (read `types.ts:99-152` for the shape), one describe per evaluator: timeOff (pending blocks, denied passes), weekendAdjacentPto, sequence (honors `applies_to_day_types` — currently dropped), rest, frequency (period edges), coverage, pairing, fairness, openSlot, crossSite (`allow_multi_site`). Plus: **fairness scales by FTE** — 0.5-FTE provider with 4 calls flags, 1.0-FTE with 4 does not (new `fte_value` on the context; threshold = `ceil(base * fte)`); **unknown requirement_type** in an eligibility rule produces a warning-severity violation `'Unknown rule vocabulary: <type>'` instead of silent skip.

`batchValidate.test.ts` — fake supabase: given a version with 3 slots/assignments, `batchValidateVersion(sb, versionId, siteCtx)` issues ≤6 queries total (assert via call-recording fake), returns per-assignment violations identical to serial `evaluateAssignment` on the same canned data, and ONE bulk write (`upsert` or `update` with array payload).

`evaluate.test.ts` addition — when loadContext returns null, result has `evaluated: false` and callers (unit-test the route handler function or commitValidation with a fake sb) do NOT write validation_flags.

- [x] **Step 2: Implement.**
- `EvaluateResult` gains `evaluated: boolean` (true only when context loaded and no evaluator threw; evaluator throw → catch, set evaluated false, still return other violations). All three write-sites (`commit.ts:151-159`, validate route, revalidateNeighbors) skip the DB write and surface `{error: 'validation-unavailable'}`/console.error when `!evaluated`.
- `loadContext.ts` neighbor query: add `.eq('schedule_slots.schedule_version_id', slotRow.schedule_version_id)` and `.eq('schedule_slots.site_id', slotRow.site_id)`; keep the crossSite evaluator's own unscoped query (lines 217-222) as-is.
- `batchValidate.ts`: load once per version — all slots+assignments (one query), all availability for assigned providers in range (one), all neighbor assignments for those providers ±31d scoped to version+site (one), credentials (one), then evaluate in memory reusing `evaluators.ts` by constructing `EvaluationContext` per assignment from the preloaded maps; bulk write with one `upsert` on `assignments` (id + validation_flags) — chunk at 500 rows. `commit.ts` `commitValidation` delegates to it; `commitMetadata` similarly becomes one bulk upsert keyed by existing assignment id (fetch ids in the same preload).
- fairness evaluator: add `fte_value` to EvaluationContext provider load (one column), scale.
- sequence evaluator + loader: select and honor `applies_to_day_types`/`applies_to_shift_types`.

- [x] **Step 3: Run** `npx vitest run src/lib/rulesEngine/ && npm test` → green.
- [x] **Step 4: Commit** — `git commit -am "scheduling-v2: batch validation (~6 queries), evaluated flag stops silent-green, neighbor scoping, per-FTE fairness, evaluators test suite"`

---

### Task 9: dayShiftAutoGen — bulk writes, shared availability predicate, generation_engine ownership

**Files:**
- Modify: `src/lib/rulesEngine/dayShiftAutoGen.ts`, `src/lib/rulesEngine/shared.ts`, `src/lib/rulesEngine/solve.ts` (pre-PTO pass predicate), `src/lib/rulesEngine/eligibility.ts` (predicate reuse)
- Create: `src/lib/rulesEngine/dayShiftAutoGen.test.ts`

- [x] **Step 1: Failing tests** (fake supabase with call recording):
```typescript
// 1. Pending PTO blocks a day-doc placement (today only approved blocks) — provider
//    with approval_status 'pending' pto over the date is NOT placed.
// 2. Writes are batched: N placements → exactly 2 write calls (one update batch for
//    existing open assignment rows, one insert batch), not N.
// 3. Slot ownership: a shift type row with generation_engine 'call' is skipped even
//    if its code doesn't match /^D\d+$/ (e.g. 'R1'); a 'day_pool' D-named code IS
//    processed (regex retired).
```

- [x] **Step 2: Implement.**
- `shared.ts`: `export function isBlockingAvailability(entry: {availability_type: string; approval_status: string}): boolean { return entry.approval_status !== 'denied' && entry.approval_status !== 'canceled' && BLOCKING_AVAIL.has(entry.availability_type); }` — use it in `eligibility.ts` (both loops), `dayShiftAutoGen.ts:298`, and solve's pre-PTO pass (replacing `approval_status !== 'approved'` — NOTE this changes pre-PTO behavior for pending PTO: pending now also earns the Thursday placement; add a patternEngine test asserting it and cite the spec §6.7 policy: pending blocks everywhere ⇒ pending also drives placement).
- `dayShiftAutoGen.ts`: fetch shift_types with `generation_engine` and filter `=== 'day_pool'` (keep the regex as a fallback ONLY when the column is missing from the row payload — i.e. `row.generation_engine ? row.generation_engine === 'day_pool' : !/^D\d+$/i.test(code)`); accumulate placements into `pendingUpdates`/`pendingInserts` arrays, write once at the end via the same shapes commit.ts uses (`.update` per-chunk with `.in('id', ids)` won't work for per-row provider ids — use one `upsert` with the full row list for updates, one `insert` for new rows; mirror `commit.ts partitionForWrite` exactly); precompute per-provider blocked-date sets once (Map<pid, Set<date>> from availability via `isBlockingAvailability` + `effectivePtoRange`).

- [x] **Step 3: Run** `npx vitest run src/lib/rulesEngine/dayShiftAutoGen.test.ts && npm test` → green.
- [x] **Step 4: Commit** — `git commit -am "scheduling-v2: day-shift engine bulk writes, shared pending-PTO predicate, generation_engine ownership"`

---

### Task 10: sequenceAutoFill — pattern-driven, cross-site fix, skip reporting, batched queries

**Files:**
- Modify: `src/lib/rulesEngine/sequenceAutoFill.ts`, its call sites in `src/app/api/scheduling/schedule-assignments/route.ts` and `[id]/route.ts` (grep `applySequenceAutoFill` / `cleanupSequenceFills` for the exact list)
- Create: `src/lib/rulesEngine/sequenceAutoFill.test.ts`

- [x] **Step 1: Failing tests** (fake supabase):
```typescript
// 1. Manual C2 on Mon at site A triggers D1 fill on Tue (classic pattern link).
// 2. CROSS-SITE FIX: provider already 'assigned' on Tue at site B (different
//    schedule_version) → D1 NOT filled; skip recorded {reason: 'cross-site'}.
// 3. PTO on Tue (pending) → skip {reason: 'pto'}.
// 4. Result shape: { filledSlotIds, skips } — skips use the SkippedDerived vocabulary.
// 5. Precedence: D1 beats D3 via relief/call rank comparison of shift_types rows,
//    not the literal 'D3' (fixture renames D3→'PRE' with same rank semantics; the
//    D1 fill still evicts/declines correctly). Read current 121-174 to mirror exact
//    semantics with callRank/relief_rank ordering: lower call_rank trigger wins.
// 6. Query budget: one assignments-window query + one availability query + one
//    slots query per invocation (≤5 total DB calls; assert via recording fake).
```

- [x] **Step 2: Implement.** Replace the rule_definitions-driven `loadActiveSequenceRulesForSite` with the site's active call pattern (`call_patterns` select, cached per-request via a parameter: call sites load it once and pass `doc` in). Links = `dayChainsFor(doc, triggerCode, triggerDayType)` links (offset ±N). Same-day conflict check becomes provider-wide: `from('assignments').select('id, schedule_slots!inner(slot_date)').eq('provider_id', pid).eq('assignment_status','assigned').eq('schedule_slots.slot_date', linkedDate)` — NO version filter (any site, any version). Batch: fetch the provider's assignments for `triggerDate ± maxOffset` once, availability once, candidate slots once; evaluate in memory. Return `{ filledSlotIds, skips }`; route handlers include `skips` in their JSON response. `cleanupSequenceFills` (delete path) mirrors the same pattern-link derivation.

- [x] **Step 3: Run** `npx vitest run src/lib/rulesEngine/sequenceAutoFill.test.ts && npm test` → green.
- [x] **Step 4: Commit** — `git commit -am "scheduling-v2: sequence auto-fill reads call pattern, provider-wide cross-site check, skip reporting, batched queries"`

---

### Task 11: required_count → sibling slots at schedule creation

**Files:**
- Modify: `src/app/api/scheduling/schedules/route.ts` (slot materialization, ~lines 108-164)
- Test: extend `src/app/api/scheduling/schedules/[id]/generate/route.test.ts` pattern — create `src/app/api/scheduling/schedules/route.test.ts` with a fake sb

- [x] **Step 1: Failing test:** a template with `required_count: 2` produces 2 slot rows for that date/shift_type with `slot_index` 0 and 1 and `required_count: 1` each; genContext load warning fires for any legacy slot row with `required_count > 1` (add to Task 6's warning block if not already: `'Slot <date> <code> has required_count>1 (legacy); generate covers only one — split into sibling slots'` — add it now in genContext with a test).
- [x] **Step 2: Implement** — in the creation loop, `for (let i = 0; i < required_count; i++)` push a slot row `{..., required_count: 1, slot_index: i}` plus its open assignment row. Keep bulk inserts (arrays).
- [x] **Step 3: Run + commit** — `git commit -am "scheduling-v2: required_count materializes sibling slots; legacy multi-count warning"`

---

### Task 12: API performance — generate route trims + maxDuration; grid route columns; assignment PATCH returns row; client patches state

**Files:**
- Modify: `src/app/api/scheduling/schedules/[id]/generate/route.ts`
- Modify: `src/app/api/scheduling/schedules/[id]/grid/route.ts`
- Modify: `src/app/api/scheduling/schedule-assignments/route.ts` (POST returns joined row + sequence fills)
- Modify: `src/app/(scheduling)/schedules/[id]/page.tsx` (assignProvider/removeAssignment: patch local state, drop `loadGrid()` refetch)

- [x] **Step 1: Tests** — route-level: extend `generate/route.test.ts`: response unfilled entries carry at most 3 candidate reasons + `omittedCandidates` count; response includes `warnings` and `skippedDerived`. Grid route: assert select string contains explicit columns and no `'*'` (unit-test the exported column list constant). Client page: no vitest harness for the monolith — make the change surgical and verify via `npm run build` type-check.
- [x] **Step 2: Implement.**
- generate route: `export const maxDuration = 300;` after the imports; before returning, map `result.unfilled` → `candidates: c.candidates?.slice(0,3), omittedCandidates: Math.max(0, (c.candidates?.length ?? 0) - 3)`; include `warnings`, `skippedDerived`, `optimizeStats` from the engine result.
- grid route: replace `select('*')`-style strings with explicit columns the page actually reads (grep the page's usage of `slot.`/`assignment.` fields first, list them, select exactly those); add `validation_summary: {hard, soft}` computed server-side per assignment from validation_flags while STILL including full `validation_flags` (the page renders messages in tooltips — verify by grepping `validation_flags` in page.tsx; if only counts + messages-on-click are used, ship summary + messages array trimmed to `severity, message`).
- assignment POST/PATCH: after write + `applySequenceAutoFill`, re-select the affected assignment row(s) (the manual one + any auto-filled/cleaned sibling ids returned by auto-fill) with the same column shape as the grid route, return `{assignment, siblings, skips}`.
- page.tsx `assignProvider` (~line 678) / `removeAssignment` (~700): replace `await loadGrid()` with applying the returned rows into the `grid` state (find the state setter — patch matching slot ids), keeping the optimistic update as the immediate paint. On response error, fall back to `loadGrid()`.
- [x] **Step 3: Verify** `npm test && npm run build` — both green. Manually trace one edit path in the code (no dev server needed).
- [x] **Step 4: Commit** — `git commit -am "scheduling-v2: generate maxDuration+trimmed payload, explicit grid columns, cell edits patch state without full refetch"`

---

### Task 13: call-patterns CRUD route + zod validation on shift-types & rule-definitions mutations

**Files:**
- Create: `src/app/api/scheduling/call-patterns/route.ts` (GET by site_id, PUT replace-active)
- Modify: `src/app/api/scheduling/shift-types/route.ts` + `[id]/route.ts`, `src/app/api/scheduling/rule-definitions/route.ts` + `[id]/route.ts`
- Create: `src/lib/validation/scheduling.ts` (zod schemas: ShiftTypeUpsert, RuleDefinitionUpsert)
- Test: `src/app/api/scheduling/call-patterns/route.test.ts` (+ validation unit tests in `src/lib/validation/scheduling.test.ts`)

- [x] **Step 1: Failing tests:** PUT with invalid CallPatternDoc → 400 with zod issue path; PUT valid doc → archives prior active (status 'archived'), inserts new active, returns it; GET returns active + recent history. ShiftTypeUpsert rejects unknown keys, wrong enum for generation_engine; RuleDefinitionUpsert requires rule_set_id/rule_name/rule_category and rejects unknown top-level keys.
- [x] **Step 2: Implement** — PUT `{site_id, definition, name?, source?}`: `CallPatternDocSchema.parse` (400 on ZodError with `{error, issues}` envelope matching the normalize-rules route's 400 convention); transactionally-ish: update current active → archived, insert new (unique partial index enforces one active — on conflict retry once). shift-types/rule-definitions POST/PATCH: `Schema.parse(body)` before insert/update; keep response shapes unchanged.
- [x] **Step 3: Run + commit** — `git commit -am "scheduling-v2: call-patterns CRUD, zod-validated shift-type and rule mutations"`

---

### Task 14: Claude schedule assistant — backend + UI

The largest task. Read spec §7 fully first. All Claude API usage follows the claude-api skill patterns already distilled here — do NOT improvise SDK shapes.

**Files:**
- Create: `src/lib/scheduleAssistant/client.ts` — shared wrapper: `export interface AssistantClientLike { stream(params): ... }` modeled as a thin injectable around `new Anthropic()`; DEFAULT_MODEL `'claude-opus-4-8'`, KNOWN_MODELS `['claude-opus-4-8','claude-fable-5']`; builds requests with `thinking: {type: 'adaptive'}`, `max_tokens: 16000`, system block array with `cache_control: {type:'ephemeral'}` on the last block (normalizer convention), NO temperature.
- Create: `src/lib/scheduleAssistant/prompts/assistant.md` — system prompt: role ("you operate FloorRunner's scheduling engine for an anesthesia group..."), the call_patterns-vs-rule_definitions architectural line, CallPatternDoc schema rendered as TypeScript (paste from callPattern.ts types) + the classic and proposed examples from spec §5.2/§5.3, tool-use guidance (read context first; snapshot happens automatically; after structural writes call regenerate_schedule; report violations honestly), prescriptive when-to-call lines per tool, output style (concise, lead with what changed).
- Create: `src/lib/scheduleAssistant/tools.ts` — tool defs, all `strict: true`, `input_schema` with `additionalProperties: false` + `required`. Table from spec §7.1: `get_schedule_context`, `get_grid`, `update_call_pattern` (input: `{definition: <CallPatternDoc JSON schema — generate via zod-to-json-schema? NO new dep: hand-write the JSON schema mirroring the zod shape; keep them adjacent with a sync comment>, name}`), `upsert_shift_type`, `upsert_rule_definition`, `assign_provider` `{slot_id, provider_id}` , `clear_assignment` `{slot_id}`, `regenerate_schedule` `{}`. Executors take `(sb, scheduleCtx, input)` and reuse EXISTING modules: call-patterns PUT logic (extract a `replaceActivePattern(sb, siteId, doc, source)` helper into `src/lib/scheduleAssistant/mutations.ts` shared with the route), assignment writes via the same code path as the manual route (extract if needed), regenerate via `autoGenerate` + `autoGenerateDayShifts` exactly as the generate route does (import its helper).
- Create: `src/lib/scheduleAssistant/snapshot.ts` — `takeSnapshot(sb, scheduleId, versionId, summary, requestText)`: reads active pattern + site shift_types + all version assignments `(slot_id, provider_id, assignment_status, source_type)` → insert `assistant_actions` row, returns id. `revertAction(sb, actionId)`: re-snapshot current state into a NEW action (undo-of-undo), restore config (archive current active pattern, re-insert config_before.call_pattern as active; upsert shift_types rows from config_before), bulk-restore assignments (upsert), re-run batch validation, stamp `reverted_at`.
- Create: `src/lib/scheduleAssistant/assistant.ts` — the loop (manual streaming loop per claude-api reference): build messages (history + optional image block `{type:'image', source:{type:'base64', media_type, data}}` placed before the text), loop max 16 iterations: `client.messages.stream(...)` → `finalMessage()`; on `tool_use` blocks: FIRST mutating tool in the turn triggers `takeSnapshot` (mutating = update_call_pattern | upsert_shift_type | upsert_rule_definition | assign_provider | clear_assignment | regenerate_schedule); execute all tool calls, results back in ONE user message (`tool_result` blocks, `is_error: true` + zod issue text on validation failure so the model self-corrects); emit progress events via an injected `onEvent` callback ({type:'text-delta'|'tool-start'|'tool-done'|'done', ...}); accumulate `changes[]` descriptions per mutating tool for the UI chips; return `{messages, changes, actionId, usage}`. `stop_reason === 'max_tokens'` → append explicit truncation notice. Typed error mapping per claude-api reference (RateLimitError → 429, APIConnectionError/529 → 503 with retry hint).
- Create: `src/app/api/scheduling/assistant/route.ts` — POST `{scheduleId, messages, image?: {media_type, data}}` → SSE stream (`new Response(new ReadableStream(...))`, `Content-Type: text/event-stream`; `export const dynamic='force-dynamic'; export const maxDuration=300;`) forwarding onEvent events as `data: {json}\n\n`; final event carries `{changes, actionId, usage}`. 500 if `!process.env.ANTHROPIC_API_KEY` with clear message.
- Create: `src/app/api/scheduling/assistant/actions/[id]/revert/route.ts` — POST → `revertAction`.
- Create: `src/app/(scheduling)/schedules/[id]/AssistantPanel.tsx` — self-contained drawer component (~300 lines): message list w/ streaming text, textarea + send, paste/upload image (FileReader → base64, cap 5MB, media_type from file.type), change chips + Undo button per assistant turn (POST revert, then call the `onMutated` prop), status line during tool runs. Consumes the SSE stream via `fetch` + `ReadableStream` reader (EventSource can't POST). Styling: match the page's existing tailwind idiom (inspect nearby components; keep it visually quiet — right-side fixed drawer, toggle button "Assistant ✨" in the page header).
- Modify: `src/app/(scheduling)/schedules/[id]/page.tsx` — mount `<AssistantPanel scheduleId={id} onMutated={loadGrid} />` + header toggle state only (≤15 lines touched).
- Tests: `src/lib/scheduleAssistant/assistant.test.ts` with a fake client emitting canned tool_use sequences (fixture pattern from rulesNormalizer fixtures, but vitest): (1) NL "make weekends the proposed structure" fixture → update_call_pattern executed with valid doc, snapshot taken BEFORE it, regenerate called after, changes[] has 2 entries; (2) invalid tool input → tool_result is_error fed back, model's corrected second call succeeds; (3) read-only conversation takes NO snapshot; (4) snapshot round-trip: revertAction restores pattern + assignments (fake sb records upserts); (5) image block passes through to the request payload verbatim.

- [x] **Step 1: tests first** (fake client + fake sb) — write all 5, watch them fail.
- [x] **Step 2: implement modules in dependency order** (client → tools/mutations → snapshot → assistant → routes → panel).
- [x] **Step 3:** `npx vitest run src/lib/scheduleAssistant/ && npm test && npm run build` — all green.
- [x] **Step 4: Commit** — `git commit -am "scheduling-v2: Claude schedule assistant — tool-use loop, snapshot/undo, SSE route, drawer UI"`

---

### Task 15: Migrations to live DB (guarded), ALGORITHM.md, docs, final verification

**Files:**
- Modify: `ALGORITHM.md`, `docs/superpowers/plans/2026-07-07-scheduling-v2.md` (check boxes)
- Delete: `src/lib/rulesEngine/solveLegacy.ts` + its parity test imports → convert goldenParity.test.ts fixtures into engine regression snapshots (inline expected plans), or keep legacy one more cycle — DECISION: keep `solveLegacy` in-tree (it's cheap, and parity remains valuable until the first real-world v2 generation is validated); just note it in CLAUDE.md. Skip deletion.
- Apply: `supabase_scheduling_patch18_call_patterns.sql`

- [ ] **Step 1: Identify the live project** — read `.env.local` (grep `SUPABASE_URL`); compare its project ref against `mcp__supabase__get_project_url` and `mcp__supabase-chiefos__get_project_url`. Apply patch18 via the MATCHING server's `apply_migration` (name `patch18_call_patterns`). If neither matches or `.env.local` is absent, DO NOT APPLY — leave the SQL file with a README note in the final summary. *(deferred: no matching MCP server — `.env.local` ref qhwdbtixhzdsgwwtcfrm matches neither connected server; apply manually — see the header in `supabase_scheduling_patch18_call_patterns.sql`)*
- [ ] **Step 2: Post-apply spot checks** (matching server): `execute_sql`: `select count(*) from scheduling.call_patterns where status='active'` (= number of sites); `select code, call_rank, relief_rank, generation_engine from scheduling.shift_types order by code limit 20` (backfill sane); `select * from scheduling.historical_call_counts((select id from scheduling.sites limit 1), current_date) limit 5` (runs without error). *(deferred with Step 1 — run after the manual apply)*
- [x] **Step 3: ALGORITHM.md** — update §7/§8/§9 to describe pattern-doc interpretation (chains/blocks/spans/placement/relief now data); REPLACE the "to change the weekend chain, edit solve.ts" change-table rows with "edit the site's call pattern (assistant or PUT /api/scheduling/call-patterns)"; add a §15 "Call patterns" section with the classic JSON and the invariants list; note `skippedDerived`, quota relaxation, warnings.
- [x] **Step 4: Full verification** — `npm test && npm run build`; run the schedule-engine-reviewer agent on the full branch diff; fix findings. *(417 tests green + tsc + build; schedule-engine-reviewer ran on the Task 15 diff — its findings (schedule-scoped conflict exclusion in both engines, assignment_status filter) fixed and re-reviewed to APPROVE)*
- [ ] **Step 5: Merge** — `git checkout main && git merge --no-ff scheduling-v2 -m "Scheduling v2: data-driven call patterns, engine hardening, Claude assistant"`. Do not push (no remote workflow established).

---

## Self-review results (spec coverage)

- Spec §4 data model → Task 2. §5 schema → Task 3. §6.1 → Task 6. §6.2/6.3 → Task 5. §6.4 → Task 7. §6.5 → Task 8. §6.6 → Task 10. §6.7 → Task 9. §6.8 → Tasks 12, 13. §7 → Task 14. §8 agents/CLAUDE.md → Task 1. §9 testing → Tasks 4, 5, 8, 9, 10, 14. §11 rollout → Tasks 1, 15.
- Known deliberate deferrals repeated from spec §2 (not tasks): auth/RLS, staffing-calculator generalization, day_classes, background jobs, page split, pattern editor UI.
- Type-consistency check: `CallPatternDoc`/`CLASSIC_PATTERN`/`dayChainsFor`/`postCallBlockOffsets`/`blockChainsFor`/`patternWarnings` names used identically in Tasks 3, 5, 6, 7, 10, 14. `SkippedDerived` vocabulary shared Tasks 5/10/12. `ShiftTypeInfo` Tasks 5/6/9. `evaluated` flag Tasks 8/14 (revert revalidation).

---

## Post-plan notes (Task 15 close-out, 2026-07-10)

**Migration disposition:** patch18 NOT applied. `.env.local` targets project `qhwdbtixhzdsgwwtcfrm`; the connected Supabase MCP servers are `nxseoevbwporxeawacmg` and `wfbccpshdbndlwvwghyy` — neither matches, so per the Step 1 guard the patch must be applied manually (SQL editor, or a matching MCP server). Full disposition + degraded-mode behavior documented in the header of `supabase_scheduling_patch18_call_patterns.sql` and CLAUDE.md's Migrations section. Until applied, the engine runs degraded-but-safe ('apply patch18' warnings); the assistant and call-pattern features require it.

**solveLegacy:** kept in-tree deliberately (frozen). Golden parity remains the safety net until the first real-world v2 generation is validated. Noted in CLAUDE.md testing conventions.

**Known-deferred items** (surfaced during the per-task reviews; consciously not fixed in this branch):
- `bulkWriteWithRowFallback`: commit.ts ⇄ batchValidate.ts function-level import cycle — safe (nothing crosses at module top level; documented in both files), but a future extraction into a small write-helpers module would remove it.
- `'pending'` / `'external_fill'` assignment/occupancy statuses — whether they count as "occupied" is a systemic convention decision across engines + UI; today only provider-bearing `assigned` rows count.
- `sequenceAutoFill`: fills made earlier in the SAME invocation are invisible to later links (misconfigured-pattern edge — a doc whose links collide within one trigger; harmless under the classic doc).
- Warning-only cells (amber dot) in the grid UI — validation warnings render in tooltips but there's no at-a-glance cell marker.
- `page.tsx` (schedules/[id]) extraction — the grid page remains a monolith; deferred with the pattern-editor UI.
- Generation-results UI consuming `warnings`/`skippedDerived` — the API returns both; the results panel doesn't render them yet.
- `DayShiftGenerationResult` has no `warnings` channel — the day-shift engine's degraded conflict-scan fallback (schedule_versions row unreadable) is silent, where genContext warns. Follow-up: add `warnings: string[]` to the result (using `errors` would falsely alarm the UI).
