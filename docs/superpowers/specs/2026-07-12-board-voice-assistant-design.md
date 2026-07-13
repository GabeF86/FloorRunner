# Board Voice Assistant — Design

**Date:** 2026-07-12 · **Status:** approved by Gabriel (chat) · **Scope:** the OR board (`/board`), not the scheduling app

A Claude assistant on the floor-runner board: speak the day's roster and room/role assignments instead of dragging, and ask for advice on daily staffing problems.

## Decisions (user-confirmed)

1. **Voice mode:** speak in, read replies. Mic input via the browser's built-in `SpeechRecognition` (user runs the board on desktop Chrome/Edge). No TTS in v1. Only the transcript leaves the browser.
2. **Apply mode:** mutations apply immediately (visible live via the board's existing realtime subscription) with a per-turn **Undo** chip — no confirm-first friction.
3. **Name matching:** fuzzy-resolve against the existing `staff` list; ambiguous or unknown names → the assistant asks. **Never auto-create people.**
4. **Advice scope v1:** today's board only (roster, rooms, designations, shifts, breaks, relief log, supervision ratios, out-order). No bridge to the scheduling schema.
5. Architecture: full tool-use assistant (approach A) with the tool-loop skeleton **extracted and shared** with the schedule assistant rather than duplicated.

## Non-goals (v1)

- No TTS, no wake word, no mobile/Safari path (Chrome/Edge only; the mic button hides when `SpeechRecognition` is unavailable and typing still works).
- No board↔scheduling data bridge (staff ≠ providers stays unlinked).
- No new board business rules — the assistant reasons with the SAME supervision/out-order logic the screen uses, relocated not reinvented.
- No changes to drag-and-drop or existing board routes.

## 1. Shared assistant loop (refactor)

`src/lib/scheduleAssistant/assistant.ts`'s streaming tool-loop becomes domain-generic in `src/lib/assistantCore/loop.ts`:

- `runAssistantLoop(opts)` with injected: `client` (AssistantClientLike), `tools: AssistantToolDef[]`, `executors: Record<string, ToolExecutor>`, `mutatingTools: Set<string>`, `takeSnapshot: () => Promise<string | null>` (returns actionId), `systemPrompt`, `messages`, `onEvent`, `maxIterations`, `maxToolResultChars`.
- Emits the existing `AssistantEvent` union unchanged (`text-delta` / `tool-start` / `tool-done` / `done{changes, actionId, usage}`), so `useSSEChat`/`ChatDrawer` need zero changes.
- `scheduleAssistant/assistant.ts` becomes a thin adapter (its `runAssistant` signature, snapshot wiring, and behavior unchanged — the existing test suite must stay green **unmodified**; any test edit means the refactor changed behavior and must be fixed, not accommodated).
- `client.ts` (Anthropic wrapper, buildRequest, error mapping) moves usage as-is via import — no changes.

## 2. Board assistant domain (`src/lib/boardAssistant/`)

**Server client:** the board tables live in the `public` schema; the assistant route uses a dedicated server-side client (service key, `db: { schema: 'public' }`) — new `src/lib/supabaseBoard.ts` mirroring `supabaseScheduling.ts`.

**Shared board logic:** `computeSupervisionLoads` (4 CRNA / 2 resident per MD) and `DESIGNATION_OUT_ORDER` move from `BoardClient.tsx` to `src/lib/boardLogic.ts` (pure, unit-tested); BoardClient imports from there, and the assistant's `get_board` executor uses the same functions. Screen and assistant can never disagree.

**Context (`BoardCtx`):** `{ boardDate, hospital }` — resolved once per request from the POST body. Every executor is date-scoped; `hospital` scopes staff/sites filters exactly like the UI filter.

**Tools** (zod-validated executors; strict only where schemas are small — respect the API's ~24-optional-param and grammar-size limits documented in `weekendV2Pattern.test.ts`):

| Tool | Kind | Behavior |
|---|---|---|
| `get_board` | read | Full day snapshot: staff (with working flag), sites+rooms, assignments, designations, shifts, breaks, relief log, computed supervision loads, out-order, and current time. The advice backbone. |
| `find_staff` | read | Fuzzy name/initials search over `staff` (scoped to hospital). Returns candidates + roles. Backs name resolution; the model must call this when unsure and ASK the user on 0 or ≥2 plausible hits. |
| `set_working` | mutate | Batch: `[{staff_id, working: bool}]` → upsert/delete `daily_active`. Unchecking also clears the person's room assignments (same as the UI checkbox). |
| `assign_to_room` | mutate | `{staff_id, room: string}` — room resolved by name within hospital (ambiguity → is_error asking). Non-physicians moved (prior rooms cleared), physicians stack — identical semantics to `POST /api/assignments`. Auto-adds to `daily_active` if missing (with the change reported). |
| `send_to_float` | mutate | Assign to the `is_float` site. |
| `unassign` | mutate | Clear a person's room assignment(s) for the date. |
| `set_designation` | mutate | MD designations (D1–D9, C1–C3, 3pm/5pm/7pm) → `daily_designations`. NOTE: the DB check constraint is missing D9/C3/3pm/5pm/7pm values the TS type allows — patch20 aligns it (see §5). |
| `set_shift_hours` | mutate | CRNA/SRNA/resident hours → `daily_shifts`. |
| `mark_break` | mutate | `{staff_id, break_type, taken}` → `breaks`. |
| `mark_relieved` | mutate | Unassign + insert `relief_log` (denormalized snapshot fields, same as drag-to-relieved). |

Executors return `{result, summary}`; summaries become the change chips. Multi-person spoken commands = the model calling batch/multiple tools in one turn; parallel tool-use is fine because executors are per-row upserts on distinct keys.

**System prompt:** `src/lib/boardAssistant/prompts/board.md` — floor-runner domain language (rooms, out-order, supervising, relief), the never-auto-create rule, the ask-on-ambiguity rule, "state what you changed in one line per change." Added to `outputFileTracingIncludes` in `next.config.mjs` (the Vercel bundling trap from the schedule assistant).

## 3. Snapshot / undo (patch20)

New table `public.board_assistant_actions`:

```
id uuid PK, board_date date NOT NULL, hospital text,
summary text, snapshot jsonb NOT NULL,   -- {daily_active:[...], assignments:[...], daily_designations:[...], daily_shifts:[...], breaks:[...]}
created_at timestamptz NOT NULL DEFAULT now(), reverted_at timestamptz
```

- Snapshot = full rows of the five day-scoped tables for `(board_date, hospital-scoped staff)` taken before the turn's FIRST mutating tool (loop skeleton already guarantees this ordering). `relief_log` is NOT snapshotted wholesale; relief entries created by the turn are recorded by id in the snapshot for targeted deletion on revert.
- Revert (`POST /api/board/assistant/actions/[id]/revert`): delete current rows for the date (hospital-scoped), re-insert snapshot rows, delete the turn's relief entries, stamp `reverted_at`. Realtime repaints the open board automatically.
- Snapshot failure ⇒ mutating tools refuse (is_error) rather than run un-undoably — same safety property as the schedule assistant.
- patch20 also widens the `daily_designations` check constraint to the full TS designation set (pre-existing drift the assistant would otherwise trip over; the UI writes the same values so this is a pure fix).

## 4. Route + UI

- **Route:** `POST /api/board/assistant` `{boardDate, hospital, messages, model?}` → SSE stream of `AssistantEvent`s (same protocol; `maxDuration 60` — board turns are small, no regeneration engine).
- **`BoardAssistantPanel.tsx`** (`src/app/board/`): sibling of the scheduling `AssistantPanel` — wires `useSSEChat` to the new endpoint with `{boardDate: viewDate, hospital}`, renders change chips + Undo via `renderExtras`, mounts as a drawer toggled by an "Assistant ✨" button in the board header. Cost footer (usage) comes along for free.
- **Voice:** new `src/components/chat/useSpeechInput.ts` — wraps `webkitSpeechRecognition`/`SpeechRecognition` (interim results shown live, final transcript auto-sends on end-of-speech; tapping the input before it fires cancels auto-send for editing). `ChatDrawer` gains an optional `voice?: boolean` prop rendering a mic button (pulsing while listening) next to the image button; hidden when the API is unavailable. The schedule assistant can opt in later by passing the prop.
- The board is realtime-subscribed only for **today**; the panel shows a small "viewing a past/future date — changes won't live-update this view" notice when `viewDate !== today` (writes still work; on reload they appear).

## 5. Testing

- `assistantCore/loop.ts`: the existing scheduleAssistant suite runs UNMODIFIED against the adapter (behavior pin). One new loop-level test file for injected-deps basics (snapshot-before-first-mutation, is_error feedback, truncation notice).
- `boardAssistant/tools`: fake-supabase executor tests per tool (happy path + name/room ambiguity + never-auto-create + set_working clears rooms + relieved writes denormalized fields). Strict-tool grammar-limit test extended to cover the board toolset (same bounds as `weekendV2Pattern.test.ts`).
- `boardLogic.ts`: unit tests for supervision loads + out-order (ported behavior pinned before the move via characterization tests).
- Snapshot/revert: fake-supabase round-trip (mutate → revert → day-state identical; relief entries deleted).
- `useSpeechInput`: not unit-testable (browser API) — manual verification checklist in the plan; the hook degrades to hidden-mic when the API is absent.
- Live verification: patch20 via Management API (ref-checked), then a real spoken end-to-end on the board: set roster → assign rooms → undo → advice question, watching realtime updates.

## Risks

- **Speech quality on clinical names** is the top UX risk; mitigations: fuzzy `find_staff` + ask-on-ambiguity + instant undo + editable transcript. If Chrome's recognizer proves too weak in practice, v2 swaps the hook's engine for recorded-audio + server STT without touching anything else.
- **Concurrent edits**: someone dragging while the assistant writes — last-write-wins on distinct keys, same as two humans today; undo restores the snapshot including their change (noted in the Undo chip tooltip: "restores the whole day to before this command").
- **Loop refactor regression**: guarded by running the untouched scheduleAssistant suite; any needed test edit = behavior change = fix the refactor.
