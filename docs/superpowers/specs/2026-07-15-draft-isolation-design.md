# Draft Isolation — "Committed = Published" Design

**Date:** 2026-07-15 · **Status:** approved ("go ahead") · **Scope:** rules engine conflict/validation queries, publish flow, one DB patch (historical fairness RPC), CLAUDE.md invariant wording.

Gabriel's ask: an UNPUBLISHED draft schedule with overlapping dates must not affect a new draft being made. Live repro: "July 2026" (07-20→08-30) and "August 2026" (08-09→11-01), both draft, overlap 08-09→08-30 — generating either treats the other's rows as real bookings (blocked providers, unfilled slots, cross-schedule flags).

## Semantic

An assignment is a **committed** booking iff its version has `schedule_versions.version_status = 'published'`. Conflict/validation logic sees: committed assignments + the version currently being generated/validated. Other drafts are invisible to each other.

- Authoritative predicate: `version_status = 'published'` (NOT `schedules.published_version_number` — stale via the UI publish path, see bug B1; NOT `schedules.status` — coarser).
- Clinical invariant 3 becomes: "No cross-site double-booking against any PUBLISHED version (plus the version under evaluation). Draft-vs-draft overlap is deliberate and resolved at publish time." CLAUDE.md updated accordingly.
- Safety net: publishing re-validates the version (batchValidateVersion) so draft-vs-draft overlaps surface as hard flags the moment the second one is published. Flag, never block.

## Changes

### 1. Shared helper + six query sites (engine/validation)
New helper in the rules engine (e.g. `src/lib/rulesEngine/committedAssignments.ts` or in `shared.ts` — implementer judgment): one query builder implementing "assignments with `assignment_status='assigned'`, date window, joined `schedule_slots → schedule_versions!inner` filtered `version_status = 'published'`", with options `{ providerIds | providerId, start, end, excludeScheduleId?, includeVersionId? }`. `includeVersionId` ORs in rows from the named (draft) version — used where the current version's own rows are part of the window. Note PostgREST cannot OR across an embedded filter easily — implementer may run two queries (published-only + current-version) and merge; correctness over cleverness; document the choice.

Callers (current behavior → new):
- `genContext.ts:509-521` cross-schedule conflict scan (crossSiteByDate): excludes parent schedule only → published-only + exclude parent (degraded no-parent fallback keeps site exclusion AND adds published-only).
- `dayShiftAutoGen.ts:389-401` externalConflictByDate: same shape, same fix.
- `sequenceAutoFill.ts:245-259` loadAssignmentsWindow: currently ANY version incl. current → published-only + `includeVersionId` (current version's own rows MUST stay — eviction and occupied-checks depend on them; eviction guard L491 already same-version-only).
- `loadContext.ts:318-333` crossSiteAssignments: published-only + includeVersionId (current version; self row included as today).
- `batchValidate.ts:185-201` rowsByPid: published-only + includeVersionId (neighbor split L297-314 unchanged — neighbors already re-scoped in memory to version+site).
- `neighborRevalidation.ts:38-44`: published-only + includeVersionId (only revalidate rows that are committed or in the version being edited).

### 2. Historical fairness (past drafts must not skew call burden)
- `supabase_scheduling_patch21_published_history.sql` (root, NOT applied until rollout — user-gated): CREATE OR REPLACE `historical_call_counts` (from patch18:67-88) adding `JOIN scheduling.schedule_versions sv ON sv.id = ss.schedule_version_id AND sv.version_status = 'published'`. Same signature — zero code-call changes; safe to apply before or after deploy.
- `genContext.ts:573-580` legacy fallback scan: add the same published-only join filter in code.

### 3. Publish flow
- `api/scheduling/schedules/[id]/route.ts` (UI path, PATCH status='published'): B1 fix — also set `published_version_number` on schedules (parity with the version route); then run `batchValidateVersion` on the newly published version and include `{hardCount, softCount, validationErrors}` in the response.
- `api/scheduling/schedules/[id]/versions/[versionId]/route.ts`: same post-publish revalidation + counts.
- `schedules/[id]/page.tsx` publish handler: surface the returned counts — reuse the existing Banner pattern (warn tone when hardCount > 0: "Published with N hard conflicts against other published schedules — check the grid"). Non-blocking.

### 4. Reporting cleanups (same predicate, read-only surfaces)
- Assistant `who_is_working` (tools.ts:1039-1068): published-only + current context version; tool description updated to say so.
- Provider burden report (`api/scheduling/providers/[id]/burden/route.ts`): published-only. (Reporting truthiness; small.)

## Non-goals
- No schema changes (patch21 is CREATE OR REPLACE of a function only). No blocking publishes. No UI redesign. Dashboard/master-schedule already published-only — untouched.

## Testing
- Helper unit tests (merge/dedupe of two-query strategy; excludeScheduleId; includeVersionId).
- Per-caller: extend existing fake-supabase fixtures so a DRAFT other-schedule row no longer blocks (genContext/dayShiftAutoGen/sequenceAutoFill) and a PUBLISHED one still does — both directions pinned.
- crossSite evaluator: draft-other-site row → no flag; published-other-site row → hard flag (both directions).
- Publish route tests (injected fake sb): published_version_number set; revalidation invoked; counts returned.
- Goldens untouched (pure fixtures, no DB). Full suite 693+new; tsc; build.

## Rollout
- Deploy + apply patch21 (Management API, ref qhwdbtixhzdsgwwtcfrm verified, user-gated).
- Live proof: regenerate nothing — instead re-run the genContext conflict scan logic via a probe (or simply revalidate + have Gabriel regenerate August): the August draft's overlap window should show the July draft no longer blocking. Report counts before/after (crossSiteByDate sizes or unfilled deltas if Gabriel regenerates).
- `scripts/revalidateAllVersions.ts` after deploy so stored cross-schedule flags reflect the new semantics.

---

## Close-out (2026-07-15)

Merged `c3562a9` to main and deployed. 7 branch commits; T1 (helper + six sites)
and the full branch each passed dedicated reviews; engine reviewer's findings all
addressed pre-merge: C1 → publishing now archives superseded published siblings
(demote-before-flip, .neq self-guard, mutation-pinned tests); C2 → patch21 header
documents the post-deploy/pre-apply window; S1 → CLAUDE.md wording scoped to
engine/assistant reads. 729 tests green at merge; goldens untouched.

Rollout: revalidateAllVersions run post-merge — July draft (354 rows) and August
draft (711 rows) both 0 hard flags. Live proof: 43 provider-date pairs in the
July draft's 2026-08-09→30 overlap window no longer block August generation.
Live DB had zero published versions (no sibling repair needed). patch21 NOT yet
applied — awaiting Gabriel's go (fairness history still counts drafts until then).

Deferred (reviewer nits, non-blocking): S2 setPublishResult declaration order;
S3 hardCount could be null (vs 0) in validation-unavailable payloads; display-layer
predicate inlines (dashboard/master-schedule) could route through
filterPublishedVersions.
