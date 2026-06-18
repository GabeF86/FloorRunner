# A4 — Rules Normalizer Agent Notes

**Owner:** Agent A4 (Rules Normalizer)
**Scope:** Wrap the Anthropic SDK so free-text staffing guidelines normalize
into the `CoverageRuleSet` A3's solver consumes.
**Files owned:**
- `src/lib/gridCalculator/rulesNormalizer.ts`
- `src/lib/gridCalculator/prompts/normalizer.md`
- `src/app/api/grid-calculator/normalize-rules/route.ts`
- `src/lib/gridCalculator/__tests__/rulesNormalizer.test.ts`
- `src/lib/gridCalculator/__tests__/fixtures/normalizer-responses.json`

## Architecture

- **Model:** `claude-opus-4-7` (default), `claude-sonnet-4-6` (downshift).
  Validated in the route via `KNOWN_MODELS`. PRD §9.
- **Prompt caching:** the system prompt is loaded once from
  `prompts/normalizer.md` and sent with `cache_control: {type: "ephemeral"}`
  on every request. The prompt is large (~12KB markdown including 4 worked
  examples) — comfortably above the 4096-token minimum cacheable prefix on
  Opus 4.7. Target ≥80% cache hit rate (PRD §9).
- **Variable payload kept tiny.** Only the user message changes per request,
  and it's built deterministically: sorted site names + verbatim raw text.
  Two identical inputs render byte-identical user messages — important for
  the share-preview-before-save flow A1 is building.
- **Response parsing:** strict JSON validation with three fallback levels —
  direct `JSON.parse`, code-fence stripping (`` ```json `` blocks), and a
  `{...}` span extractor. Anything outside the contract is rejected
  (`NormalizerResponseError` → 502 from the route).
- **`unmapped` array** is part of `NormalizeRulesResult`, not
  `CoverageRuleSet`. The solver never sees unmapped sentences; they bubble
  up to the UI for clarification (PRD §9).

## Persistence boundary

This PR does **not** write to `grid_calculator_guidelines`. The PRD assigns
that table to A1/A2 and §14 says "persistence wiring is a separate task." The
route returns `{rules, unmapped, promptCacheHit, modelId}` and lets the
caller (eventually a Sidebar action) persist.

## Conflicting rules

The normalizer surfaces **both** entries (in input order) and tags the second
with a `notes` field explaining the conflict. The solver's `ruleBySiteKey =
new Map` iteration semantics make the LAST entry win, which matches the PRD
expectation ("last wins, both noted"). The UI is expected to render the
conflict warning.

## Tests

Run with:

```sh
npx tsx src/lib/gridCalculator/__tests__/rulesNormalizer.test.ts
```

Same convention as A3's `solver.test.ts` (tsx + `node:assert/strict` + tiny
harness — zero new dev dependencies). 13 cases cover the 6 mandated scenarios
plus cache-hit detection, code-fence parsing, garbage-input rejection, missing
API key, system-prompt cache_control verification, deterministic user-message
rendering, and global-rule round-trip.

Fixtures live in `__tests__/fixtures/normalizer-responses.json` — eight canned
Anthropic SDK responses. No test ever hits the real API.

## Open items A3's solver does not yet honor

I noted while reading `solver.ts` that the following parts of the
`SiteRule` / `GlobalRule` shape are emitted by the normalizer but **not yet
enforced by A3's solver:**

1. **`maxSupervisionRatio` per site.** A3 only respects the global
   `config.supervisionRatio` toggle (`mostly_1_3` / `mostly_1_4` / `mixed`).
   A per-site override like `"OB → maxSupervisionRatio: '1:3'"` is parsed and
   round-tripped through the JSON, but `solver.ts → pickSupervisor()` does
   not consult it. Escalation: surface to A3 — likely a small change to
   pass the rule's ratio cap when picking a supervisor for a room at that
   site.

2. **`auxiliaryRole: 'break_relief' | 'add_on_relief'`.** A3 does not
   consume this field at all. A6 (Float Strategy Agent) likely will when it
   replaces the placeholder float emitter. For now, the field is emitted
   into `siteRules[].auxiliaryRole` and is available for downstream
   consumers; A4 does not need to do anything else.

3. **`globalRules`.** A3 ignores them entirely. The shape is intentionally
   loose (`{kind, payload}`) so A4 can emit `max_supervision_ratio`,
   `never_solo_crna`, etc. — but the solver will not act on them until A3
   wires in a global-rule pass. The normalizer reflects what the user wrote;
   acting on it is downstream.

4. **`notes` on a SiteRule.** Round-tripped but not consumed. Intended for
   conflict surfacing in the UI (see Conflicting rules above) and for
   audit-trail display. No solver behavior depends on it.

Per the PRD §17 escalation rule, A4 should NOT extend `solver.ts` itself to
honor these. They are flagged here for the A3 / A6 owners to pick up.

## Environment

- `ANTHROPIC_API_KEY` must be present at runtime in dev/prod.
  Missing → `MissingApiKeyError` (route returns 500 with a clear message
  instead of leaking a stack trace).
- Optional: `GRID_CALCULATOR_NORMALIZER_PROMPT_PATH` overrides the
  prompt-file location for ops flexibility. Defaults work under both
  `npx tsx` (tests) and Next.js's server bundler.
