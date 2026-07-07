# Scheduling v2: Data-Driven Call Structures, Engine Hardening, and the Claude Schedule Assistant

**Date:** 2026-07-07
**Status:** Approved (owner delegated design decisions; requirements confirmed in session)
**Inputs:** 44-agent full-system review (`docs/code-reviews/2026-07-07-full-system-review.json`), owner requirements (faster / more accurate / more customizable / Claude-API schedule building), proposed weekend call structure image.

---

## 1. Goals

1. **More customizable** — a new call structure (e.g. the proposed weekend structure: C1 in-house 24h with post-call day off, C2 home call, a Neuro beeper obligation spanning Fri–Sun on one provider, D1/D2 working days, across a Fri–Mon block) must be expressible as **data**, with zero code changes.
2. **Claude assistant** — an in-app assistant on the schedule page: describe a structure change in words or paste an image; Claude translates it into config changes and one-off assignment edits, **applies immediately, regenerates, and offers one-click undo** (owner's confirmed choice: apply-immediately-with-undo; scope: structure changes + one-off assignment edits, NOT provider data).
3. **More accurate** — fix the confirmed correctness holes: seed-C1 post-call violation, cross-site double-booking via sequence auto-fill, silent D1-skip drops (the mandated skip tracking), silent-green validation failures, engine disagreement on pending PTO, per-FTE fairness in validation.
4. **Faster** — kill the N+1 validation pass (~1,600–2,400 round trips/generation), batch day-shift writes, stop re-computing run-invariants 5,000× in the optimizer, stop full-grid refetches on every cell edit.
5. **Dev-side agents** — domain-aware subagent definitions in `.claude/agents/` so future engine work is reviewed against the clinical invariants.

## 2. Non-goals (explicitly deferred)

- Auth/RLS (known #1 platform blocker; separate project).
- Generalizing `staffingCalculator` (paoli.ts / lankenau.ts) into declarative config — same pattern, separate effort.
- Replacing the `day_type` enum with a per-site `day_classes` table (the Fri–Mon block works via pattern day-offsets without it).
- Background-job generation (route stays synchronous; it gets fast enough that this can wait).
- Splitting the 2,634-line schedule page into components (only the assistant panel is added as a new component; one targeted change removes the full-grid refetch).
- Provider-data editing via the assistant (FTE, credentials, PTO) — existing forms remain the path.
- Visual call-pattern editor UI — the assistant *is* the editor for now.

## 3. Architecture overview

Three pillars on one foundation:

```
                    ┌──────────────────────────────┐
                    │  scheduling.call_patterns    │  ← NEW first-class entity
                    │  (CallPatternDoc jsonb)      │     "how schedules are BUILT"
                    └──────────────┬───────────────┘
                                   │ loaded into GenerationContext
      ┌────────────────────────────┼─────────────────────────────┐
      ▼                            ▼                             ▼
 solve() pattern            sequenceAutoFill                metrics/optimize
 interpreter                (manual-edit companion,          (category-driven,
 (replaces hard-coded       reads same pattern doc)          pattern-aware burnout)
 weekend chain, D-chains,
 pre-PTO pass, relief list)
      ▲
      │ tools: update_call_pattern, upsert_shift_type,
      │        assign/move/clear, regenerate, get_grid
 ┌────┴─────────────────────────┐        ┌────────────────────────────┐
 │ Claude Schedule Assistant    │        │ scheduling.rule_definitions │
 │ (tool-use loop, images,      │        │ "what schedules must        │
 │  snapshot → undo)            │        │  SATISFY" (validation only) │
 └──────────────────────────────┘        └────────────────────────────┘
```

**The architectural line:** `call_patterns` define structure consumed at *generation* time. `rule_definitions` remain the *validation* vocabulary (rest, frequency, coverage…). The assistant writes structure to `call_patterns`/`shift_types` and constraints to `rule_definitions`. This cures the confirmed "two disconnected rule systems" defect (generator ignores the rules DB) without merging two systems that do different jobs.

## 4. Data model changes

New patch `supabase_scheduling_patch18_call_patterns.sql` (repo convention), mirrored in `supabase/migrations/`:

### 4.1 `scheduling.call_patterns`
```sql
CREATE TABLE scheduling.call_patterns (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id      uuid NOT NULL REFERENCES scheduling.sites(id) ON DELETE CASCADE,
  name         text NOT NULL,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','archived')),
  definition   jsonb NOT NULL,           -- zod-validated CallPatternDoc (see §5)
  source       text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','assistant','seed')),
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
-- exactly one active pattern per site
CREATE UNIQUE INDEX call_patterns_one_active ON scheduling.call_patterns(site_id) WHERE status = 'active';
```
Seed: one `source='seed'` active pattern per existing site whose definition reproduces today's hard-coded behavior exactly (§5.2).

### 4.2 `scheduling.shift_types` new columns
```sql
ALTER TABLE scheduling.shift_types
  ADD COLUMN call_rank int,                -- tier priority; lower = more primary. Seeded C1=0, C2=1, C3=2.
  ADD COLUMN relief_rank int,              -- non-null → participates in relief pass in this order. Seeded D4..D9 → 1..6.
  ADD COLUMN is_overlay boolean NOT NULL DEFAULT false,  -- overlay shifts (beeper) don't consume the one-assignment-per-day budget
  ADD COLUMN generation_engine text NOT NULL DEFAULT 'day_pool'
    CHECK (generation_engine IN ('call','day_pool','none'));
-- Backfill: category='call' → 'call'; code ~ '^D[0-9]+$' → 'call' (derived/relief owned by call engine); else 'day_pool'.
```
This replaces the load-bearing naming conventions (`CALL_CODES` literals, `/^D\d+$/` regex, `RELIEF_CODES` array). Existing flags (`requires_post_call_rule`, `call_coverage_type`, `crosses_midnight`, `counts_toward_call_burden`) are finally loaded and honored by the engine.

### 4.3 `scheduling.assistant_actions` (undo substrate)
```sql
CREATE TABLE scheduling.assistant_actions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id         uuid NOT NULL REFERENCES scheduling.schedules(id) ON DELETE CASCADE,
  schedule_version_id uuid REFERENCES scheduling.schedule_versions(id) ON DELETE SET NULL,
  summary             text NOT NULL,             -- human description of what the assistant did
  request_text        text,                      -- the user's message
  config_before       jsonb NOT NULL,            -- {call_pattern, shift_types[]} snapshot
  assignments_before  jsonb NOT NULL,            -- [{slot_id, provider_id, assignment_status, source_type}] for the version
  reverted_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
```
One row per assistant turn that mutates anything. Undo = restore config rows + bulk-restore assignment rows, then revalidate. A month version is ~300–600 assignment rows — comfortably jsonb-sized.

### 4.4 Historical fairness aggregate
```sql
CREATE OR REPLACE FUNCTION scheduling.historical_call_counts(p_site_id uuid, p_before date)
RETURNS TABLE (provider_id uuid, bucket text, code text, n bigint) ...
-- GROUP BY provider, dayTypeBucket(derived_day_type), shift code; assigned call-category only.
```
Replaces the unbounded fetch-every-row-ever query (which also silently corrupts fairness at Supabase's 1,000-row cap).

### 4.5 Indexes
```sql
CREATE INDEX ON scheduling.assignments (provider_id, assignment_status);
CREATE INDEX ON scheduling.schedule_slots (schedule_version_id, slot_date, slot_index);
CREATE INDEX ON scheduling.schedule_slots (slot_date, site_id);
CREATE INDEX ON scheduling.provider_availability (provider_id, start_date, end_date);
```
(Verify against live `pg_indexes`/advisors before applying; skip any that exist.)

### 4.6 `required_count` model decision
**One provider per slot** (the DB already enforces `UNIQUE(schedule_slot_id)` on assignments). Schedule creation materializes `required_count = N` templates into **N sibling slots** (distinct `slot_index`). The solver stays single-assignment. A load-time warning reports any legacy slot with `required_count > 1`.

## 5. CallPatternDoc — the structure schema

TypeScript + zod in `src/lib/rulesEngine/callPattern.ts`. This is the single vocabulary for structural generation and the assistant's primary write target.

```ts
interface CallPatternDoc {
  version: 1;
  // Multi-day blocks: instantiated once per anchor date; chains place the SAME
  // provider across (offset, code) nodes, eligibility-checked per node.
  blocks: Array<{
    anchorDayType: DayType;                  // e.g. 'saturday' (classic) or 'friday' (proposed)
    chains: Array<{
      trigger: string;                       // shift code placed on the anchor day
      links: Array<{ offset: number; code: string }>;  // same-provider placements
    }>;
  }>;
  // Per-code daily effects (replaces chainDFills): pre/post fills and blocks.
  dayChains: Array<{
    trigger: string;                         // e.g. 'C1'
    dayTypes: DayType[];                     // scope, e.g. ['weekday','friday']
    links?: Array<{ offset: number; code: string; unlessCallWithinDays?: number }>;
    blocks?: Array<{ offset: number }>;      // post-call day off = { offset: 1 }
  }>;
  // Multi-day same-provider obligations (Neuro beeper): a chain sugar —
  // anchor day + offsets, same provider throughout; overlay via shift_types.is_overlay.
  spans: Array<{ code: string; anchorDayType: DayType; offsets: number[] }>;
  // Configurable placement passes (replaces hard-coded pre-PTO Thursday).
  placementPasses: Array<{
    kind: 'pre_pto';
    relativeDay: 'thursday_prior_week';
    codes: string[];                         // fill order, e.g. ['C1','C2']
    maxProviders: number;                    // classic: 2
    enabled: boolean;
  }>;
  // Relief pass config (replaces RELIEF_CODES + weekday/friday literals).
  reliefPass: { enabled: boolean; dayTypes: DayType[] } | null;  // codes come from shift_types.relief_rank
}
```

### 5.1 Semantics
- `blocks[].chains` run when the trigger is placed on its anchor day (scored, forced, or seeded), exactly like today's `maybeWeekendBlock`: each link is eligibility-checked (`call` gate for call-category targets, `derived` otherwise), respects optimizer `callOverrides`, and no-ops on already-handled slots.
- `dayChains` run on every placement of `trigger` whose day type matches: `links` fill derived slots with the same provider (with the `unlessCallWithinDays` suppression generalizing today's "had call two days before"); `blocks` mark the provider unavailable at `date+offset` (post-call day off).
- Seeds fire `dayChains.blocks` too — this **fixes the confirmed seed-C1 post-call hole** structurally: a manually placed in-house call blocks the next day before the solver runs.
- `spans` place one provider across all offsets from the anchor (same eligibility loop); `is_overlay` shift types skip and don't consume the same-date budget.
- Unknown codes referenced by an active pattern produce load-time **warnings** in `GenerationResult` (never silent no-ops).

### 5.2 Classic pattern (seeded; golden-parity target)
```json
{ "version": 1,
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
  "reliefPass": { "enabled": true, "dayTypes": ["weekday","friday"] } }
```
**Golden-parity requirement:** with this pattern active, the new engine must produce byte-identical plans to the current engine on the existing solver test fixtures. This is the regression safety net for the whole refactor.

### 5.3 Proposed weekend structure (the image) — proof of expressiveness
```json
{ "version": 1,
  "blocks": [{ "anchorDayType": "friday", "chains": [
    { "trigger": "C1", "links": [{ "offset": 2, "code": "C2" }] },
    { "trigger": "C2", "links": [{ "offset": 1, "code": "C2" }] } ] }],
  "dayChains": [
    { "trigger": "C1", "dayTypes": ["friday","saturday","sunday"], "blocks": [{ "offset": 1 }] },
    { "trigger": "C2", "dayTypes": ["sunday"], "links": [{ "offset": 1, "code": "D1" }] } ],
  "spans": [{ "code": "NB", "anchorDayType": "friday", "offsets": [0, 1, 2] }],
  "placementPasses": [],
  "reliefPass": { "enabled": true, "dayTypes": ["weekday"] } }
```
Reading: Fri-C1 doc also takes Sun C2 (image: Doc A); Fri-C2 doc keeps C2 on Saturday (Doc B — who then wins Sun C1 by scoring); every in-house C1 night is followed by a blocked post-call day (Docs A/B/E get Off after their C1); the Neuro beeper (`NB` shift type, `call_coverage_type='partial_beeper'`, `is_overlay` as desired) spans Fri–Sun on one provider (Doc C); Monday D1 follows Sunday C2. New shift type `NB` + this pattern = the entire restructure, all data, all writable by the assistant.

## 6. Engine changes (by file)

### 6.1 `genContext.ts`
- Load **full shift_types rows** → `ctx.shiftTypesByCode: Map<code, ShiftTypeInfo>` (flags, call_rank, relief_rank, is_overlay, generation_engine).
- Load the site's **active call_pattern** (fallback: seeded classic doc constant if none — engine never crashes on missing pattern).
- Precompute run-invariants (currently rebuilt per solve, ×5,000 in optimize): `providerById`, `prePtoByThursday`, sorted `scheduleDates`, per-slot derived dates (`dow`, `dayAfter`, weekend-window bounds), per-availability-entry `effectivePtoRange` results.
- Historical fairness via the `historical_call_counts` RPC (≤ ~1,000 aggregate rows instead of every row ever).
- Cross-site window derived from **all slot dates ±1 day** (not just open call slots) — fixes the confirmed Monday-D1 double-booking window hole.
- Load-time warnings array: pattern references unknown codes; Σ bucket targets < bucket totals ("quota can't cover slots — check `call_par_level` vs pool ΣFTE"); legacy `required_count > 1` slots.

### 6.2 `solve.ts` — pattern interpreter
- `chainDFills` → generic `applyDayChains(doc, slot, provider)`; `maybeWeekendBlock` → `applyBlockChains(doc, ...)`; pre-PTO pass → driven by `placementPasses`; relief pass → codes from `relief_rank` ordering, day types from `reliefPass.dayTypes`.
- Seed loop applies `dayChains.blocks` for seeded call assignments (seed-C1 post-call fix).
- Call-date tracking (`addCallDate`), relief "next call" ranking, and tier priority keyed off `shift_type_category === 'call'` + `call_rank` — **no code literals anywhere** (custom call roles get recency, fairness, optimization, relief parity).
- **Relief pass fixes:** each code eligibility-checked against its own slot (no `D4||D5` sampling — dates whose relief slots are D6–D9 are no longer skipped); rescan candidates from the top per code (a provider ineligible for D5 is reconsidered for D6+); un-placeable relief slots recorded.
- **Quota relaxation pass:** when every candidate for a call slot fails *only* on bucket-quota, assign the lowest-lifetime-ratio candidate anyway with `source: 'quota-relaxed'` + explanation (fewer stranded slots; principled, visible).
- **`plan.skippedDerived[]`**: every suppressed derived placement (PTO / cross-site / occupied / no-slot / ineligible) recorded with reason — implements the mandated D1-skip tracking. Persisted into the run's `generation_metadata` and surfaced in the API result.
- Single-pass candidate rejection capture (no double eligibility sweep on unfilled slots); binary-insert for call dates.

### 6.3 `eligibility.ts`
- Post-call guard driven by `requires_post_call_rule` (any flagged code, not literal `'C1'`), with a **symmetric prior-day check** (provider had a post-call-flagged shift yesterday → ineligible today) so seeds and cross-engine placements are caught; day-type exemptions come from the pattern doc (classic Saturday exemption lives in the seeded doc, not code).
- Same-date check: `is_overlay` slots neither consume nor collide with the one-assignment-per-day budget.
- Weekend-call credential applies to any call slot whose derived day type is in the site's weekend set (pattern-block days included).
- Consumes precomputed slot/availability data (zero Date allocation in the hot path).

### 6.4 `metrics.ts` / `optimize.ts`
- Call-ness from category; burnout exemption = call pairs linked by the same pattern-block instance (replaces hard-coded Fri–Sun window).
- Optimizer: **eligibility pre-gating** before spending a re-solve (most (P,Q) pairs are trivially ineligible — 5–20× effective budget); build pid→slots map once per scan; add wall-clock budget (default 2s) alongside `maxResolves`. Full incremental-delta evaluation is deliberately deferred (risk > reward for now).

### 6.5 `commit.ts` / `evaluate.ts` / `loadContext.ts` / `evaluators.ts`
- **Batch validation:** load all slots/neighbors/availability for the version in ~4 bulk queries, evaluate in memory, write `validation_flags` with one bulk upsert; `generation_metadata` same. (~1,600–2,400 round trips → ~6.)
- `EvaluateResult.evaluated: boolean` — on loadContext failure or evaluator throw, callers **skip the write** instead of persisting `[]` (no more silent-green erasure of hard flags). All three call sites updated.
- Neighbor query scoped to the slot's schedule_version + site (cross-site evaluator keeps its own unscoped query) — kills phantom violations from abandoned drafts.
- Fairness evaluator: per-FTE scaling (load fte with the profile), threshold = configurable ratio over site-month mean.
- Sequence evaluator + `sequenceAutoFill`: honor `applies_to_day_types`/`applies_to_shift_types`; reject unknown `requirement_type` values loudly (warning flag, not silent skip).

### 6.6 `sequenceAutoFill.ts` (manual-edit companion)
- Reads the **same call-pattern doc** for post/pre-call links (rule_definitions sequence rows remain validation-only) — manual edits and generation can no longer disagree.
- **Cross-site fix:** same-day conflict check is provider-wide (any site, any version with `assigned` status), not version-scoped.
- Returns skip records (same vocabulary as `plan.skippedDerived`); D-code precedence from `call_rank`/`relief_rank`, not the literal `'D3'`.
- Queries batched (one assignments-window query, one availability query, rules/pattern passed in or cached per request).

### 6.7 `dayShiftAutoGen.ts`
- Slot ownership from `generation_engine === 'day_pool'` (regex retired).
- Accumulate placements in memory → bulk update+insert at the end (commitPlan-style).
- Shared `isBlockingAvailability()` predicate in `shared.ts`: **pending PTO blocks everywhere** (matches call engine; fixes the engines-disagree hole); used by dayShiftAutoGen, pre-PTO pass, eligibility, and evaluators.

### 6.8 API routes
- `generate/route.ts`: `export const maxDuration = 300`; response trims unfilled-slot candidates to top-3 reasons + counts; includes `warnings`, `skippedDerived` summary, seed-vs-final metrics.
- Assignment POST/PATCH returns the full updated row (+ any auto-filled/skipped siblings); the schedule page patches local state instead of refetching the month grid.
- `grid/route.ts`: explicit column list (drop `select('*')`); `validation_flags` summarized to `{hard, soft, messages}`.
- New CRUD: `GET/PUT /api/scheduling/call-patterns?site_id=` (zod-validated, one-active enforced).
- Zod validation added to shift-types and rule-definitions mutation routes (reject unknown keys — prerequisite for AI writes).

## 7. Claude Schedule Assistant

### 7.1 Backend — `src/lib/scheduleAssistant/`
- **`client.ts`** — one shared Anthropic wrapper consolidating the two existing seams (`AnthropicLike` / `RationaleClient`): injectable for tests, supports streaming, image blocks, and tool use. Default model `claude-fable-5`; allowlist includes `claude-opus-4-8` (per-request override, same convention as the normalizer). *Implementation must consult the `claude-api` skill for exact request shapes rather than memory.*
- **`tools.ts`** — tool definitions (JSON Schema from the zod sources — single source of truth):
  | Tool | Kind | Notes |
  |---|---|---|
  | `get_schedule_context` | read | site, date range, shift types, active pattern, metrics, warnings |
  | `get_grid` | read | compact text grid (dates × codes → provider short names) for verification |
  | `update_call_pattern` | write | full CallPatternDoc replace; zod-validated; archives prior |
  | `upsert_shift_type` | write | validated subset: code, name, category, flags, call_rank, relief_rank, is_overlay, generation_engine, times |
  | `upsert_rule_definition` | write | validation-rule vocabulary (rest/frequency/…), zod-validated |
  | `assign_provider` / `clear_assignment` | write | one-off edits; runs the same path as manual UI edits (sequence auto-fill + validation); returns violations + skips |
  | `regenerate_schedule` | action | runs autoGenerate; returns metrics, unfilled, warnings |
- **`assistant.ts`** — the tool-use loop: system prompt (`prompts/assistant.md`, following the normalizer's prompt-file convention: frozen system block with `cache_control`, canonical entity list first, volatile text last), max 16 tool iterations, token/cost accounting returned to the UI. Images arrive as base64 content blocks — the weekend-structure-PNG use case.
- **Snapshot/undo:** before the first mutating tool call of a turn, snapshot `{active pattern, shift_types, rule set}` + all version assignments into `assistant_actions`; every response reports what changed + the action id. `POST /api/scheduling/assistant/actions/[id]/revert` restores config + assignments in bulk and revalidates. Undo of an undo = the snapshot taken by the revert itself (revert also snapshots).
- **Route:** `POST /api/scheduling/assistant` `{scheduleId, messages, image?}` — streams text via SSE; tool activity emitted as progress events. Errors follow the normalizer's envelope convention; typed SDK errors (rate limit / overloaded) mapped to 429/503 with retry hints; `stop_reason === 'max_tokens'` handled explicitly.

### 7.2 UI — `src/app/(scheduling)/schedules/[id]/AssistantPanel.tsx`
Self-contained right-side drawer mounted from the schedule page (minimal monolith touch): chat thread, streaming text, image paste/upload, applied-change chips (e.g. "Call pattern updated · 3 shift types · regenerated: 0 unfilled"), per-turn **Undo** button, regenerate status. On mutation completion it triggers one grid refresh.

### 7.3 Safety properties
- Every write tool is zod-validated server-side (malformed model output → tool error fed back to the model, never persisted).
- Every mutating turn is snapshotted first → one-click undo (owner's chosen workflow).
- The engine's own eligibility/validation applies to assistant edits identically to manual ones; violations are reported back into the conversation.
- No auth in scope (repo-wide deferred decision), but the route requires `ANTHROPIC_API_KEY` server-side and never accepts a client-supplied key.

## 8. Dev-side agents (`.claude/agents/`)

1. **`schedule-engine-reviewer.md`** — reviews engine diffs against the clinical invariants: post-call day off after in-house call; D1-skip tracking; PTO always respected (pending included); no cross-site double-booking; per-FTE fairness; golden-parity for the classic pattern; no reintroduction of code literals.
2. **`schedule-correctness-auditor.md`** — builds fixture probes (seed-C1, PTO-conflict D1, cross-site, quota-starvation), runs vitest + targeted property checks, reports violations with repro fixtures.
3. **`call-structure-designer.md`** — turns NL/image structure descriptions into CallPatternDoc JSON, validates via the zod schema, dry-runs against a fixture context, and reports which slots each chain/span would touch.

Plus a root **`CLAUDE.md`** (currently missing): test commands, engine architecture pointer (ALGORITHM.md), the invariants list, migration conventions, and "call_patterns = built / rule_definitions = satisfied".

## 9. Testing strategy

- **Golden parity (the keystone):** port existing solver fixtures; assert new engine + seeded classic pattern ≡ old engine output exactly, **except** where a fixture exercises one of the enumerated intentional fixes (seed-C1 post-call blocking, relief-pass D6+ reachability/rescan, quota relaxation, `skippedDerived` reporting). Any expectation change must cite which intentional fix explains it; unexplained diffs are refactor bugs. Old `solve()` kept in-tree during the refactor as `solveLegacy` for the comparison test, deleted at the end.
- **New-structure test:** fixture with the §5.3 pattern + NB shift type; assert C1→post-call blocks on all three nights, NB same-provider Fri–Sun, Fri-C1→Sun-C2 chain, Mon D1 after Sun C2.
- **Regression tests for each accuracy fix** (TDD: failing test first — this also re-verifies the unverified review findings; any finding that won't reproduce gets reported back and skipped): seed-C1 post-call; sequence auto-fill cross-site; D1-skip tracking; validation `evaluated` flag; pending-PTO day-shift; fairness per-FTE; neighbor version-scoping; relief D6–D9-only dates; quota relaxation.
- **`evaluators.test.ts`** — per-evaluator fixtures (the 789-line module currently has zero tests).
- **`sequenceAutoFill.test.ts`** / **`dayShiftAutoGen.test.ts`** — mocked supabase client covering skip/conflict/batch paths.
- **Assistant:** fixture-client tests (canned tool-use responses) for the loop, snapshot/undo round-trip, zod rejection feedback; no live-model calls in CI.
- All tests runnable via `npm test` (vitest) — new tests use vitest, not the tsx mini-harness.

## 10. Error handling summary

- Generation: warnings array (pattern-unknown-codes, quota-vs-par mismatch, legacy required_count) always returned; never silent.
- Validation: `evaluated=false` → no write + surfaced error; unknown rule vocabulary → warning flag.
- Assistant: tool errors → fed back to model (bounded retries); SDK errors → typed HTTP responses; every mutation snapshotted before execution.
- Undo: restores are transactional per table group; failures leave the `assistant_actions` row un-reverted with error detail.

## 11. Rollout

1. Feature branch `scheduling-v2`; merge to `main` when the full suite is green.
2. Migrations are additive (new tables/columns with defaults + seeds); apply to the live Supabase project only after confirming the project ref matches `.env.local`. If ambiguous, SQL files land in-repo with apply instructions.
3. `ANTHROPIC_API_KEY` already the convention (rulesNormalizer); assistant reuses it. New dep: `zod`.
4. ALGORITHM.md updated: the "change weekend chain = edit code" table replaced with "edit the call pattern".
