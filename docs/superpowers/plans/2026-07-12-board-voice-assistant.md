# Board Voice Assistant — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the board voice assistant per `docs/superpowers/specs/2026-07-12-board-voice-assistant-design.md`: mic input (Chrome `SpeechRecognition`), a tool-use Claude assistant over the board's `public`-schema tables with apply-now + per-turn undo, and board-state advice.

**Architecture:** Extract the schedule assistant's tool-loop into `src/lib/assistantCore/loop.ts` (behavior pinned by the untouched scheduleAssistant suite). New `src/lib/boardAssistant/` (tools/executors/snapshot/prompt) over a new `public`-schema server client. New SSE route `/api/board/assistant` + revert route. Voice = new `useSpeechInput` hook + optional `voice` prop on the generic `ChatDrawer`. Supervision/out-order logic relocates to `src/lib/boardLogic.ts` so screen and assistant share it. patch20 (public schema): `board_assistant_actions` + widen the `daily_designations` check constraint.

**Tech Stack:** Next.js 14, vitest (fake supabase/client injection per repo convention), zod, Anthropic SDK via existing `scheduleAssistant/client.ts`, Supabase `public` schema.

**Standing constraints (from CLAUDE.md + prior work):**
- Commit trailer on every commit: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Work on branch `board-assistant`; never push mid-plan.
- LLM tests never hit the network (inject fakes). The scheduleAssistant test suite must pass **unmodified** after the loop extraction — any test edit = behavior regression.
- Strict tools: ≤24 total optional params across strict tools and no multi-KB strict schemas (live 400s on 2026-07-12; see `weekendV2Pattern.test.ts` bounds tests as the pattern).
- Runtime-read prompt `.md` files must be added to `outputFileTracingIncludes` in `next.config.mjs` (Vercel bundling trap, fixed 2026-07-12 for the schedule assistant).
- patch20 applies to the **live DB only at the user-gated step** via the Supabase Management API with ref `qhwdbtixhzdsgwwtcfrm` verified first.

---

### Task 1: `boardLogic.ts` — relocate supervision/out-order logic (characterize → move)

**Files:**
- Create: `src/lib/boardLogic.ts`, `src/lib/boardLogic.test.ts`
- Modify: `src/app/board/BoardClient.tsx` (remove `computeSupervisionLoads`, import instead), plus any other importer of `computeSupervisionLoads` (grep: currently only BoardClient defines/uses it internally).

- [ ] **Step 1.1: Characterization tests FIRST**, importing from the CURRENT location (`import { computeSupervisionLoads } from '@/app/board/BoardClient'`):

```ts
// boardLogic.test.ts — written against the pre-move export to pin behavior,
// then the import is flipped to './boardLogic' in Step 1.3 (tests unchanged).
import { describe, it, expect } from 'vitest';
import { computeSupervisionLoads } from '@/app/board/BoardClient';
import type { Assignment } from '@/types';

const asg = (id: string, room_id: string, staff_id: string, role: string): Assignment =>
  ({ id, room_id, staff_id, board_date: '2026-07-12',
     staff: { id: staff_id, name: staff_id, initials: staff_id.slice(0, 2), role, hours: '8hr' } } as unknown as Assignment);

const byRoom = (rows: Assignment[]) => {
  const m: Record<string, Assignment[]> = {};
  for (const r of rows) (m[r.room_id] ??= []).push(r);
  return m;
};

describe('computeSupervisionLoads', () => {
  it('counts one crna-room and one resident-room per supervising MD', () => {
    const rows = [
      asg('a1', 'r1', 'md1', 'physician'), asg('a2', 'r1', 'c1', 'crna'),
      asg('a3', 'r2', 'md1', 'physician'), asg('a4', 'r2', 'res1', 'resident'),
    ];
    const loads = computeSupervisionLoads(rows, byRoom(rows));
    expect(loads['md1']).toMatchObject({ crnaCount: 1, residentCount: 1, overCrna: false, overResident: false });
  });
  it('flags at-limit (4 crna rooms) and over-limit (5) correctly', () => {
    const at = Array.from({ length: 4 }, (_, i) => [
      asg(`p${i}`, `r${i}`, 'md1', 'physician'), asg(`c${i}`, `r${i}`, `c${i}`, 'crna'),
    ]).flat();
    expect(computeSupervisionLoads(at, byRoom(at))['md1']).toMatchObject({ atCrna: true, overCrna: false });
    const over = [...at, asg('p4', 'r4', 'md1', 'physician'), asg('c4', 'r4', 'c9', 'crna')];
    expect(computeSupervisionLoads(over, byRoom(over))['md1']).toMatchObject({ overCrna: true });
  });
  it('srna counts toward the crna limit; an MD alone in a room counts nothing', () => {
    const rows = [asg('a1', 'r1', 'md1', 'physician'), asg('a2', 'r1', 's1', 'srna'),
                  asg('a3', 'r2', 'md1', 'physician')];
    expect(computeSupervisionLoads(rows, byRoom(rows))['md1']).toMatchObject({ crnaCount: 1, residentCount: 0 });
  });
  it('resident-over-limit at 3 (limit 2)', () => {
    const rows = Array.from({ length: 3 }, (_, i) => [
      asg(`p${i}`, `r${i}`, 'md1', 'physician'), asg(`x${i}`, `r${i}`, `x${i}`, 'resident'),
    ]).flat();
    expect(computeSupervisionLoads(rows, byRoom(rows))['md1']).toMatchObject({ overResident: true });
  });
});
```

Adjust the `Assignment` cast to the real type in `src/types/index.ts` (read it first). Run: tests pass against the current implementation (green — these pin behavior).

- [ ] **Step 1.2: Create `src/lib/boardLogic.ts`** — move `computeSupervisionLoads` and its `SUPERVISION_LIMITS` (locate the constant; if it lives in `src/types/index.ts` leave it there and import) VERBATIM from `BoardClient.tsx`. Pure module, no `'use client'`, imports only from `@/types`.

- [ ] **Step 1.3:** `BoardClient.tsx` imports `computeSupervisionLoads` from `@/lib/boardLogic` (delete the local definition; keep the re-export if anything else imported it from BoardClient — grep first). Flip the test import to `./boardLogic`. Run tests + `npx tsc --noEmit` + `npm test` (suite baseline: 582 passing + your new tests; 10 documented gridCalculator file errors).

- [ ] **Step 1.4: Commit** `feat: boardLogic — supervision/out-order logic shared between board UI and (upcoming) assistant`.

---

### Task 2: `assistantCore/loop.ts` — extract the domain-generic tool loop

**Files:**
- Create: `src/lib/assistantCore/loop.ts`, `src/lib/assistantCore/loop.test.ts`
- Modify: `src/lib/scheduleAssistant/assistant.ts` (becomes an adapter)

- [ ] **Step 2.1:** Read `src/lib/scheduleAssistant/assistant.ts` fully. The loop to extract is `runAssistant`'s core: build request → `client.stream` → `finalMessage` → accumulate usage → execute tool_use blocks (snapshot before FIRST mutating tool; refuse mutations if snapshot failed; zod errors → `is_error` tool_result; cap tool-result chars) → push results → repeat ≤16 → `done` event. Design the extraction as:

```ts
// assistantCore/loop.ts — domain-generic streaming tool loop. The schedule
// and board assistants inject their own tools/executors/snapshot; this file
// owns only the conversation mechanics. Event vocabulary unchanged.
export interface AssistantLoopDeps {
  client: AssistantClientLike;
  systemPrompt: string;
  tools: AssistantToolDef[];
  executors: Record<string, (input: unknown) => Promise<{ result: unknown; summary?: string }>>;
  mutatingTools: ReadonlySet<string>;
  // Returns the persisted action id, or null on failure (mutations then refuse).
  takeSnapshot: () => Promise<string | null>;
  messages: AssistantMessageParam[];
  onEvent: (ev: AssistantEvent) => void;
  model?: string;
  maxIterations?: number;        // default 16
  maxToolResultChars?: number;   // default 40_000
}
export interface AssistantLoopResult {
  messages: AssistantMessageParam[]; changes: string[]; actionId: string | null; usage: AssistantUsage;
}
export async function runAssistantLoop(deps: AssistantLoopDeps): Promise<AssistantLoopResult> { /* moved body */ }
```

Note the executor signature here is `(input) => ...` — the schedule adapter closes over `(sb, ctx)` when building its executor map; the board adapter closes over `(sb, boardCtx)`. Types (`AssistantEvent`, `AssistantUsage`, `AssistantToolDef`, `AssistantMessageParam`) stay exported from their current homes (`client.ts` / `assistant.ts`) and are re-exported by `assistantCore` if that avoids churn — implementer's call, but **no import breaks** for existing consumers.

- [ ] **Step 2.2 (TDD for the new seam):** Write `loop.test.ts` BEFORE the extraction — fake client (mirror the fixtures style in `scheduleAssistant/assistant.test.ts`), asserting: (a) snapshot is taken exactly once, before the first mutating tool, and its id lands in `done.actionId`; (b) when `takeSnapshot` resolves null, a mutating tool returns is_error and executes nothing, while read tools still run; (c) executor throw → is_error tool_result, loop continues; (d) tool results longer than `maxToolResultChars` are truncated; (e) `stop_reason 'max_tokens'` appends the truncation notice event. Run — fails (module absent).

- [ ] **Step 2.3:** Move the loop body into `runAssistantLoop`; rewrite `scheduleAssistant/assistant.ts`'s `runAssistant` as an adapter that builds the deps (its existing snapshot wiring, executor map bound to `(sb, scheduleCtx)`, prompt via `loadSystemPrompt()`) and delegates. **Do not change `runAssistant`'s exported signature or events.**

- [ ] **Step 2.4:** Gates: `npx vitest run src/lib/assistantCore src/lib/scheduleAssistant` — new loop tests green AND the scheduleAssistant suite green **with zero test-file modifications** (`git diff --stat` must show no `scheduleAssistant/*.test.ts` changes). Then full `npm test` + `npx tsc --noEmit`.

- [ ] **Step 2.5: Commit** `refactor: extract domain-generic assistant tool loop to assistantCore (schedule suite pinned, unmodified)`.

---

### Task 3: board server client + patch20 files (NOT applied)

**Files:**
- Create: `src/lib/supabaseBoard.ts`, `scripts/emitBoardAssistantPatch.ts`, `supabase_scheduling_patch20_board_assistant.sql`

- [ ] **Step 3.1:** `src/lib/supabaseBoard.ts` — mirror `src/lib/supabaseScheduling.ts` exactly (read it first), but `db: { schema: 'public' }` and exported as `sbBoardServer()`. Same env vars.

- [ ] **Step 3.2:** Emit script (pattern: `scripts/emitWeekendV2Patch.ts`) printing patch20:

```sql
-- supabase_scheduling_patch20_board_assistant.sql (public schema — the BOARD tables)
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='board_assistant_actions') THEN
    RAISE EXCEPTION 'patch20 already applied';
  END IF;
END $$;

CREATE TABLE public.board_assistant_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  board_date date NOT NULL,
  hospital text,
  summary text,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  reverted_at timestamptz
);
CREATE INDEX board_assistant_actions_date_idx ON public.board_assistant_actions (board_date, created_at DESC);

-- Pre-existing drift fix: the check constraint lags the TS MDDesignation type
-- (missing D9, C3, 3pm/5pm/7pm). The UI already writes these values.
ALTER TABLE public.daily_designations DROP CONSTRAINT IF EXISTS daily_designations_designation_check;
ALTER TABLE public.daily_designations ADD CONSTRAINT daily_designations_designation_check
  CHECK (designation IN ('D1','D2','D3','D4','D5','D6','D7','D8','D9','C1','C2','C3','8hr','10hr','3pm','5pm','7pm'));
COMMIT;
-- Verify: SELECT count(*) FROM public.board_assistant_actions;   -- 0
-- Verify: INSERT a 'D9' designation row in a transaction and ROLLBACK — must not error.
```

First READ the actual constraint name + current value list from the live DB (read-only query via Management API) and the TS `MDDesignation` union in `src/types/index.ts:15-25` — the CHECK list above must equal the TS union exactly; correct the SQL if the union differs. Emit, read the output end-to-end, commit files. **Do not apply.**

- [ ] **Step 3.3: Commit** `feat: patch20 files — board_assistant_actions + designation constraint alignment (not applied)`.

---

### Task 4: board tools — reads (`get_board`, `find_staff`)

**Files:**
- Create: `src/lib/boardAssistant/tools.ts`, `src/lib/boardAssistant/tools.test.ts`

- [ ] **Step 4.1:** Define the module skeleton: `BoardCtx { boardDate: string; hospital: string | null }`, `boardTools: AssistantToolDef[]`, `MUTATING_BOARD_TOOLS: Set<string>`, `createBoardExecutors(sb, ctx)` returning `Record<name, (input) => Promise<{result, summary}>>` (matching the Task 2 loop signature). Reuse `AssistantToolDef` from the schedule assistant's `client.ts`.

- [ ] **Step 4.2 (TDD):** Tests first, using the fake-supabase fixture (`src/lib/rulesEngine/__fixtures__/fakeSupabase.ts` — same injection style as `scheduleAssistant/tools.test.ts`; if the fake needs `public`-table shapes, seed them in the test):
  - `get_board` returns: staff with `working` flags (join of `staff` + `daily_active` for the date, hospital-filtered), sites+rooms, assignments (with staff names), designations, shifts, breaks, relief log for the date, `supervisionLoads` (via `computeSupervisionLoads` from `@/lib/boardLogic`), and `outOrder` (designated MDs sorted by `DESIGNATION_OUT_ORDER`, then undesignated).
  - `find_staff` with query "nina" returns Nina-like candidates ranked; with two "Simon"-ish rows returns both (the tool NEVER picks silently — that rule lives in the system prompt, but the tool result must expose all candidates + roles + working flags).
- [ ] **Step 4.3:** Implement both executors + their tool schemas:

```ts
{ name: 'get_board',
  description: 'Read the full board for the working date: staff (with working-today flags), sites and rooms, room assignments, MD designations, shift hours, breaks, relief log, supervision loads (limits: 4 CRNA/SRNA rooms, 2 resident rooms per MD), and the out-order. Call this before giving advice or when you need current state.',
  strict: true,
  input_schema: { type: 'object', additionalProperties: false, required: [], properties: {} } },
{ name: 'find_staff',
  description: 'Fuzzy-search the staff list by spoken name or initials (scoped to the current hospital). Returns ALL plausible candidates with roles and working flags. If zero or more than one candidate plausibly matches what the user said, ASK the user — never guess, never create people.',
  strict: true,
  input_schema: { type: 'object', additionalProperties: false, required: ['query'],
    properties: { query: { type: 'string' }, role: { type: 'string', enum: ['physician','crna','srna','resident','surgeon'] } } } },
```

`find_staff` matching: case-insensitive substring on name + initials, then a loose subsequence fallback; rank exact-prefix > substring > subsequence. Keep it dependency-free (~20 lines, unit-tested with misspellings like "kalawadia"/"kala"/"nina k").

- [ ] **Step 4.4:** Green + `tsc` clean. **Commit** `feat: board assistant read tools — get_board + find_staff (fake-supabase tested)`.

---

### Task 5: board tools — mutations

**Files:** extend `src/lib/boardAssistant/tools.ts` + tests.

- [ ] **Step 5.1 (TDD, one describe per tool):** Behaviors to pin (each mirrors the existing REST routes' semantics — read `src/app/api/{assignments,daily-active,designations,daily-shifts,breaks,relief}/route.ts` first and mirror exactly):
  - `set_working` batch upserts/deletes `daily_active`; marking someone NOT working also deletes their assignments for the date (UI checkbox parity).
  - `assign_to_room` resolves the room by name within the hospital's sites (case-insensitive; ambiguity or no match → throw `ToolInputError`-style so the loop returns is_error text listing the room names); non-physicians get prior same-date assignments deleted first; physicians stack; assigns to `daily_active` if missing and reports it in the summary.
  - `send_to_float` targets the `is_float` site's first room-equivalent (read how the UI's `handleDropFloat` writes it — mirror).
  - `unassign` deletes the person's assignments for the date.
  - `set_designation` upserts `daily_designations` (validate against the `MD_DESIGNATIONS` list); `set_shift_hours` upserts `daily_shifts` (validate against `HOUR_OPTIONS`).
  - `mark_break` upserts `breaks` with `taken_at` stamping (mirror the route).
  - `mark_relieved` deletes assignments + inserts `relief_log` with the denormalized name/role/initials/designation/shift fields (read the UI's `handleDropRelieved` payload and mirror).
- [ ] **Step 5.2:** Implement executors + schemas. Schema budget: `set_working` takes `{ entries: [{staff_id, working}] }` (array, required both) — strict; `assign_to_room` `{staff_id, room}` strict; designations/shifts use enum values from the TS constants. Extend the existing strict-grammar bounds test (`weekendV2Pattern.test.ts` pattern) with a board-tools case: total optional params across strict board tools ≤ 20 and each strict schema ≤ 1000 bytes serialized.
- [ ] **Step 5.3:** All green + tsc. **Commit** `feat: board assistant mutation tools (route-parity semantics, grammar-bounded schemas)`.

---

### Task 6: snapshot / undo

**Files:**
- Create: `src/lib/boardAssistant/snapshot.ts`, `src/lib/boardAssistant/snapshot.test.ts`
- Create: `src/app/api/board/assistant/actions/[id]/revert/route.ts`

- [ ] **Step 6.1 (TDD):** fake-supabase tests: (a) `takeBoardSnapshot(sb, ctx, summary)` inserts a `board_assistant_actions` row whose `snapshot` holds full rows of `daily_active`, `assignments`, `daily_designations`, `daily_shifts`, `breaks` for the date (hospital-scoped via staff ids) plus `reliefIds: []`; returns the id. (b) `recordReliefInsert(actionId, reliefId)` appends to the snapshot's `reliefIds`. (c) `revertBoardAction(sb, id)`: deletes current date rows (same scope), re-inserts snapshot rows, deletes listed relief entries, stamps `reverted_at`; second revert is a no-op error `already reverted`. Round-trip test: seed day → snapshot → mutate via the Task 5 executors → revert → day-state deep-equals the seed.
- [ ] **Step 6.2:** Implement. Wire `mark_relieved`'s executor to call `recordReliefInsert` when an action is open (executor deps carry the actionId ref the loop set — mirror how scheduleAssistant executors learn the snapshot id; read that wiring first).
- [ ] **Step 6.3:** Revert route: POST, body-less, loads the action via `sbBoardServer()`, calls `revertBoardAction`, returns `{ok, restored: {counts per table}}`; 404 unknown id, 409 already reverted. Test with injected fake.
- [ ] **Step 6.4: Commit** `feat: board assistant snapshot/undo — day-scoped restore via board_assistant_actions`.

---

### Task 7: system prompt + SSE route

**Files:**
- Create: `src/lib/boardAssistant/prompts/board.md`, `src/lib/boardAssistant/prompt.ts` (loader, copy the `loadSystemPrompt` __dirname+cwd pattern), `src/app/api/board/assistant/route.ts`, `route.test.ts`
- Modify: `next.config.mjs` (add `'./src/lib/boardAssistant/prompts/**/*'` to the existing `outputFileTracingIncludes` array)

- [ ] **Step 7.1:** Write `board.md`. Required content: role ("You are the floor-runner's board copilot at {hospital} for {boardDate}"); the data model in floor language (working list, rooms, float, designations D1..out-order..C1 overnight, shifts, breaks, relief); THE RULES — never create staff; on 0 or ≥2 name matches ASK (list the candidates); resolve rooms by name and ask on ambiguity; apply changes immediately and end with one line per change; for advice call `get_board` first and reason with supervision limits and out-order; keep replies terse (the user is standing in a hallway).
- [ ] **Step 7.2 (TDD):** route tests with injected fake client (mirror `api/scheduling/assistant/route.test.ts` — read it first): 400 on bad body (zod `{boardDate: date-string, hospital: string|null, messages: […], model?}`), 500-style error event when ANTHROPIC_API_KEY missing (same pre-parse check as the scheduling route), happy-path streams `done` with usage, `maxDuration = 60`.
- [ ] **Step 7.3:** Implement the route: build `BoardCtx`, `createBoardExecutors(sbBoardServer(), ctx)`, snapshot fn bound to ctx, call `runAssistantLoop`, stream events as SSE (copy the scheduling route's stream/controller scaffolding including the disconnected-client guard).
- [ ] **Step 7.4:** `next.config.mjs` tracing include + verify via `npx next build` then grep the route's `.nft.json` for `board.md` (the patch18-era verification pattern).
- [ ] **Step 7.5: Commit** `feat: board assistant SSE route + system prompt (traced into serverless bundle)`.

---

### Task 8: voice input — `useSpeechInput` + ChatDrawer `voice` prop

**Files:**
- Create: `src/components/chat/useSpeechInput.ts`
- Modify: `src/components/chat/ChatDrawer.tsx`

- [ ] **Step 8.1:** The hook (no unit tests — browser API; keep ALL logic trivial):

```ts
'use client';
// Chrome/Edge SpeechRecognition wrapper. supported=false hides the mic
// entirely (Safari/Firefox); the drawer then behaves exactly as before.
import { useEffect, useRef, useState } from 'react';

export interface SpeechInput {
  supported: boolean;
  listening: boolean;
  /** Live transcript (interim + final so far) while listening. */
  transcript: string;
  start: () => void;
  stop: () => void;   // manual stop — final transcript still fires onFinal
}

export function useSpeechInput(onFinal: (text: string) => void): SpeechInput {
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const recRef = useRef<SpeechRecognition | null>(null);
  const finalRef = useRef('');
  const Ctor = typeof window !== 'undefined'
    ? (window.SpeechRecognition ?? window.webkitSpeechRecognition)
    : undefined;

  useEffect(() => () => { recRef.current?.abort(); }, []);
  if (!Ctor) return { supported: false, listening: false, transcript: '', start: () => {}, stop: () => {} };

  const start = () => {
    if (listening) return;
    const rec = new Ctor();
    rec.lang = 'en-US'; rec.continuous = true; rec.interimResults = true;
    finalRef.current = '';
    rec.onresult = (e: SpeechRecognitionEvent) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalRef.current += r[0].transcript;
        else interim += r[0].transcript;
      }
      setTranscript(finalRef.current + interim);
    };
    rec.onend = () => {
      setListening(false);
      const text = finalRef.current.trim();
      setTranscript('');
      if (text) onFinal(text);
    };
    rec.onerror = () => { setListening(false); setTranscript(''); };
    recRef.current = rec; setListening(true); rec.start();
  };
  const stop = () => recRef.current?.stop();
  return { supported: true, listening, transcript, start, stop };
}
```

Add the missing DOM lib types via a small `declare global` block if `SpeechRecognition` isn't in the TS lib (it isn't in `dom` for all TS versions — check `tsc` output and add minimal declarations in the hook file).

- [ ] **Step 8.2:** `ChatDrawer` gains `voice?: boolean`. When set and `supported`: a 🎤 button next to the 🖼 button; tap → `start()`, button pulses (CSS animation via inline style + `@keyframes` in a `<style>` tag like the print block) and shows live `transcript` in the textarea (read-only mirror while listening: `value={listening ? transcript : input}`); tap again → `stop()`. `onFinal` → `chat.send(text)` directly (auto-send), UNLESS the user focused the textarea during listening — track a `editIntentRef` set by textarea `onFocus` while `listening`; then `onFinal` populates `setInput(text)` instead of sending. While `busy`, mic is disabled.
- [ ] **Step 8.3:** `npx tsc --noEmit` clean; existing chat consumers unaffected (prop optional). Manual check deferred to Task 10. **Commit** `feat: mic input — useSpeechInput hook + ChatDrawer voice prop (auto-send, tap-to-edit escape)`.

---

### Task 9: `BoardAssistantPanel` + mount

**Files:**
- Create: `src/app/board/BoardAssistantPanel.tsx`
- Modify: `src/app/board/BoardClient.tsx` (header button + panel mount)

- [ ] **Step 9.1:** Panel = sibling of the scheduling `AssistantPanel` (read it; same structure): `useSSEChat` with `endpoint: '/api/board/assistant'`, `buildBody: ({text, history}) => ({ boardDate: viewDate, hospital, messages: [...history, {role:'user', content:text}] })`; `renderExtras` renders change chips + Undo button hitting `/api/board/assistant/actions/${actionId}/revert` (copy the undo wiring incl. one-in-flight lock and reverted strikethrough); `<ChatDrawer voice title="Board Assistant ✨" subtitle="speak or type · every change undoable" …/>`; `emptyHint` includes two example utterances (one roster+assign command, one advice question). When `viewDate !== today`, show the notice line: "Viewing a non-today date — the board won't live-update until reload."
- [ ] **Step 9.2:** Mount in `BoardClient`: an "Assistant ✨" `Button` in the header near the view toggles; `onMutated` → the board's existing refetch paths already fire via realtime for today; for non-today dates call `loadDailyData(viewDate)` after `done` (read how `loadDailyData` is invoked and reuse).
- [ ] **Step 9.3:** `tsc` + `npm test` + `npx next build` all green. **Commit** `feat: board assistant panel — voice chat drawer wired to /api/board/assistant with undo`.

---

### Task 10: gates, patch20 apply (USER GATE), live e2e, close-out

- [ ] **Step 10.1:** Full gates on the branch: `npx tsc --noEmit`, `npm test` (582 + all new tests, 10 documented file errors), `npx next build`, and the `.nft.json` grep for `board.md`.
- [ ] **Step 10.2: GATE — present patch20 to Gabriel and apply only on his confirmation** (Management API, ref `qhwdbtixhzdsgwwtcfrm` verified). Run the two verification queries from the SQL footer.
- [ ] **Step 10.3: Live e2e WITH Gabriel (voice is physically his):** on localhost, open /board → Assistant: (1) speak a roster command ("Working today: …" 3+ people) — verify daily_active + sidebar checkboxes update live; (2) speak assignments ("Farkas supervising rooms one and two, Nina in room three") — verify rooms fill; (3) an ambiguous name — verify it asks instead of acting; (4) "undo that" / Undo chip — verify day restored; (5) an advice question ("who goes home first?") — verify it reads the board and reasons about out-order. Fix-forward anything found.
- [ ] **Step 10.4:** Plan close-out note (deviations + e2e findings), merge `board-assistant` → main (--no-ff), push (deploys), verify prod deployment green + `/api/board/assistant` responds 400-on-empty-body (key check), memory update (board assistant shipped; voice = Chrome SpeechRecognition; public-schema assistant infra now exists).

---

## Self-review notes

- Spec coverage: §1→T2, §2→T1/T4/T5(+T7 prompt), §3→T3/T6(+10.2), §4→T7/T8/T9, §5 testing woven per-task + T10.
- Known adaptation points (in-task, deliberate): exact `Assignment` type shape (T1), current snapshot-id wiring pattern (T6.2), scheduling route scaffolding + route test conventions (T7), `SUPERVISION_LIMITS` location (T1.2), live designation constraint name/values (T3.2).
- Type consistency: `BoardCtx`, `createBoardExecutors(sb, ctx)`, executor signature `(input) => Promise<{result, summary}>` per T2's loop seam, used identically in T4–T7.
