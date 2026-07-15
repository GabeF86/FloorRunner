# FloorRunner

Anesthesia department management: scheduling engine + staffing calculators + OR floor-runner board. Next.js 14 App Router + Supabase (`scheduling` Postgres schema).

## Commands
- `npm test` — vitest suite (engine + calculators). Single file: `npx vitest run src/lib/rulesEngine/solve.test.ts`
- `npm run dev` — dev server
- Legacy exception: the tsx-based test files under `src/lib/gridCalculator/` (its `__tests__` directories, incl. `seeds/_templates/__tests__`) run via `npx tsx`, not vitest — they surface as 10 "No test suite found" file errors in `npm test`; that's expected.

## Architecture
- `src/lib/rulesEngine/` — call-schedule generation. Pipeline: `loadGenerationContext` (all DB reads) → `solve()` (pure greedy, interprets the site's CallPatternDoc) → `optimize()` (bounded hill-climb) → `commitPlan` → batch validation. See `ALGORITHM.md`.
- **call_patterns vs rule_definitions:** `scheduling.call_patterns` (CallPatternDoc jsonb, one active per site) defines how schedules are BUILT — weekend/block chains, post/pre-call fills, post-call day-off blocks, spans, placement passes, relief config. `scheduling.rule_definitions` define what schedules must SATISFY — validation only (`evaluators.ts`). Never re-hardcode structure in the engine; extend the pattern schema instead (`src/lib/rulesEngine/callPattern.ts`).
- `src/lib/scheduleAssistant/` — Claude tool-use assistant (structure changes + assignment edits, snapshot → undo via `scheduling.assistant_actions`).
- `src/lib/gridCalculator/`, `src/lib/staffingCalculator/` — sibling engines, deliberately not shared with rulesEngine.

## Clinical invariants (violating any of these is a bug, never a tradeoff)
1. Post-call day off after a 24h in-house call (`requires_post_call_rule` shift types) — including seeded/manual assignments.
2. PTO/availability always respected; PENDING PTO blocks in every engine (`isBlockingAvailability` in `shared.ts`).
3. No cross-site double-booking against any PUBLISHED version (any site), plus the version under generation/validation. Draft-vs-draft overlap is deliberate (drafts are hypotheticals, Gabriel 2026-07-15) and is caught by publish-time revalidation. Committed = `schedule_versions.version_status = 'published'`; the predicate is single-homed in `committedAssignments.ts` — never re-inline it.
4. Skipped derived shifts (e.g. D1 post-C2 blocked by PTO/cross-site) must be left unassigned AND recorded (`plan.skippedDerived`), never silently dropped.
5. Call burden distributes per-FTE (bucket quotas + fairness metrics).
6. Validation must never silently report clean on failure (`EvaluateResult.evaluated`).

## Testing conventions
- Golden parity: `solve()` with the seeded classic pattern must match `solveLegacy` output on the parity fixtures (`src/lib/rulesEngine/goldenParity.test.ts`) except enumerated intentional fixes listed in that file.
- `solveLegacy.ts` is kept in-tree deliberately (frozen, never edited) — parity remains valuable until the first real-world v2 generation is validated.
- Engine tests build pure `GenerationContext` fixtures — no DB. DB-coupled modules use an injected fake supabase client.
- LLM modules use injected fake clients + fixtures; never call the network in tests.

## Migrations
Root-level `supabase_scheduling_patchN_*.sql` files, applied to the live Supabase project manually/via MCP after review. RLS exists but the app uses the service-role key (auth deferred, internal-only).
patch18 was applied manually 2026-07-12 (see its header for the spot-check record). The live project is Supabase "Floor Runner", ref `qhwdbtixhzdsgwwtcfrm` (matches `.env.local`); the project-scoped `supabase-floorrunner` MCP server points at it and is the right channel for future patches — always verify the ref before applying. The `supabase` (atlas-staging) and `supabase-chiefos` (ChiefOS) MCP servers and the Railway "chiefos" project belong to OTHER apps — never run FloorRunner DDL or ops through them.

## Deployment
Production is https://floor-runner.vercel.app — Vercel auto-deploys on push to `origin/main` (GitHub `GabeF86/FloorRunner`, public repo: never commit secrets). After a DB patch is applied, push `main` promptly so deployed code matches the live schema.
