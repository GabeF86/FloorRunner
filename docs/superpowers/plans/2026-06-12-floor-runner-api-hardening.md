# Floor Runner — API Hardening Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Fix the verifiable, server-side correctness bugs in the Floor Runner board API — the room-reorder that never persists, colliding new-room positions, missing input validation, and unhandled malformed-body errors — so the board's writes are trustworthy. Pure-helper logic is unit-tested; route wiring is build-verified.

**Architecture:** The board routes (`src/app/api/{rooms,assignments,relief,breaks,daily-active,daily-shifts,designations}/route.ts`) are thin Supabase handlers that today (a) trust `id!`/`staff_id!` without validation, (b) `await req.json()` unguarded (malformed body → unhandled 500), and (c) — for rooms — write reorder data to `sort_order` while the board reads rooms by `position`, so reordering silently doesn't persist. We add a tiny shared `boardApi.ts` (pure `safeJson` + `missingFields`), fix the rooms read/write column mismatch server-side (no client change), compute non-colliding positions, and surface delete errors in the assignment move. Scope is server-side only — no changes to the realtime client (`BoardClient.tsx`), no auth (internal-use, consistent with the platform decision), no schema change.

**Tech Stack:** Next.js 14 route handlers, Supabase JS, Vitest. Out of scope (needs the live board + visual verification): touch/pointer drag-and-drop, optimistic-update rollback in `BoardClient`, a transactional move RPC, and the visual redesign.

---

## File Structure

**New files:**
- `src/lib/boardApi.ts` — `safeJson(req)`, `missingFields(obj, keys)`, `nextPosition(rows)`.
- `src/lib/boardApi.test.ts` — unit tests.

**Modified files:**
- `src/app/api/rooms/route.ts` — reorder persistence fix + non-colliding position + validation + error handling.
- `src/app/api/assignments/route.ts` — surface the delete error, validate, handle bad body.
- `src/app/api/relief/route.ts`, `breaks/route.ts`, `daily-active/route.ts`, `daily-shifts/route.ts`, `designations/route.ts` — validation + safe body parse.
- `src/app/board/BoardClient.tsx` — remove the dead `// Also need PATCH …` comment (line ~900) now that reorder works.

---

## Task 1: Shared pure helpers (`boardApi.ts`)

**Files:**
- Create: `src/lib/boardApi.ts`, `src/lib/boardApi.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/boardApi.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { missingFields, nextPosition } from './boardApi';

describe('missingFields', () => {
  it('lists keys that are absent / null / undefined / empty string', () => {
    expect(missingFields({ a: 1, b: 'x' }, ['a', 'b'])).toEqual([]);
    expect(missingFields({ a: 1 }, ['a', 'b'])).toEqual(['b']);
    expect(missingFields({ a: null, b: '' }, ['a', 'b'])).toEqual(['a', 'b']);
    expect(missingFields({ a: 0 }, ['a'])).toEqual([]); // 0 is a valid value
    expect(missingFields({ a: false }, ['a'])).toEqual([]); // false is valid
  });
});

describe('nextPosition', () => {
  it('returns max(position)+1, or 0 for an empty set', () => {
    expect(nextPosition([])).toBe(0);
    expect(nextPosition([{ position: 0 }, { position: 3 }, { position: 1 }])).toBe(4);
    expect(nextPosition([{ position: null }, { position: 2 }])).toBe(3);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- boardApi`
Expected: FAIL — cannot find module `./boardApi`.

- [ ] **Step 3: Implement**

Create `src/lib/boardApi.ts`:

```ts
import type { NextRequest } from 'next/server';

// Parse a request body as JSON, returning null instead of throwing on
// malformed input so handlers can answer 400 rather than crash with a 500.
export async function safeJson(req: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return (body && typeof body === 'object') ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

// Names of required keys that are absent, null, undefined, or empty string.
// 0 and false are valid values and are NOT reported missing.
export function missingFields(obj: Record<string, unknown>, keys: string[]): string[] {
  return keys.filter(k => {
    const v = obj[k];
    return v === undefined || v === null || v === '';
  });
}

// Next ordering position for an append: max(position)+1, 0 when empty.
export function nextPosition(rows: Array<{ position: number | null }>): number {
  let max = -1;
  for (const r of rows) {
    if (typeof r.position === 'number' && r.position > max) max = r.position;
  }
  return max + 1;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- boardApi`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/boardApi.ts src/lib/boardApi.test.ts
git commit -m "Add pure board-API helpers (safeJson / missingFields / nextPosition)"
```

---

## Task 2: Harden `rooms/route.ts` (the reorder persistence fix)

The board reads rooms ordered by `position` (`board/page.tsx:17`, `BoardClient.tsx:210`), but the reorder PATCH writes `sort_order` (`BoardClient.tsx:256` sends `{id, sort_order}`). Result: reordering never persists. Fix server-side: mirror the order value into `position` (the column actually read), keeping `sort_order` in sync. Also give new rooms a non-colliding position and validate input.

**Files:**
- Modify: `src/app/api/rooms/route.ts`

- [ ] **Step 1: Apply the changes**

Replace the body of `src/app/api/rooms/route.ts` (keep the `server()` factory + `dynamic` export) with:

```ts
import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';
import { safeJson, missingFields, nextPosition } from '@/lib/boardApi';

function server() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const body = await safeJson(req);
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  const missing = missingFields(body, ['site_id', 'name']);
  if (missing.length) return NextResponse.json({ error: `Missing: ${missing.join(', ')}` }, { status: 400 });

  const sb = server();
  // Give the new room the next free position in its site (the client sends a
  // placeholder 99; computing max+1 prevents every new room colliding).
  const { data: siblings } = await sb.from('rooms').select('position').eq('site_id', body.site_id);
  const position = nextPosition((siblings as Array<{ position: number | null }> | null) ?? []);

  const { data, error } = await sb
    .from('rooms')
    .insert({ site_id: body.site_id, name: body.name, position, sort_order: position })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(req: NextRequest) {
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });
  const { error } = await server().from('rooms').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: NextRequest) {
  const body = await safeJson(req);
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  if (!body.id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  const updates: Record<string, unknown> = {};
  if (body.name !== undefined) updates.name = body.name;
  // Reorder fix: the board reads rooms by `position`, so an order change must
  // land in `position`. We accept either key from the client and write BOTH so
  // the two columns stay in sync and the new order actually persists.
  const order = body.sort_order ?? body.position;
  if (order !== undefined) { updates.position = order; updates.sort_order = order; }
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
  }

  const { data, error } = await server()
    .from('rooms').update(updates).eq('id', body.id).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
```

- [ ] **Step 2: Verify**

Run: `npm test -- boardApi` (still green) and `npx tsc --noEmit 2>&1 | grep -E "rooms/route" || echo "no rooms route type errors"` and `npm run build` (route compiles).
Expected: clean; build succeeds.

- [ ] **Step 3: Commit**

```bash
git add "src/app/api/rooms/route.ts"
git commit -m "Fix room reorder persistence (write position) + non-colliding new positions + validation"
```

---

## Task 3: Harden `assignments/route.ts`

Surface the delete error in the non-physician move (today it's ignored, so a failed delete silently proceeds to the upsert), validate input, and handle a malformed body.

**Files:**
- Modify: `src/app/api/assignments/route.ts`

- [ ] **Step 1: Apply the changes**

In `src/app/api/assignments/route.ts`, add `import { safeJson, missingFields } from '@/lib/boardApi';`, then replace the `POST` and `DELETE` handlers with:

```ts
export async function POST(req: NextRequest) {
  const body = await safeJson(req);
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  const missing = missingFields(body, ['staff_id', 'room_id']);
  if (missing.length) return NextResponse.json({ error: `Missing: ${missing.join(', ')}` }, { status: 400 });

  const sb = server();
  const date = (body.board_date as string) || new Date().toISOString().split('T')[0];

  // Physicians can cover multiple rooms simultaneously — keep their other
  // assignments. Everyone else moves room-to-room: clear prior, then place.
  if (body.role !== 'physician') {
    const { error: delErr } = await sb
      .from('assignments').delete()
      .eq('staff_id', body.staff_id).eq('board_date', date);
    // Surface the delete failure instead of silently upserting on top of it.
    if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });
  }

  const { data, error } = await sb
    .from('assignments')
    .upsert(
      { room_id: body.room_id, staff_id: body.staff_id, board_date: date },
      { onConflict: 'staff_id,room_id,board_date' },
    )
    .select('*, staff(*)')
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(req: NextRequest) {
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });
  const { error } = await server().from('assignments').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
```

(Leave the `GET` handler unchanged.)

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit 2>&1 | grep -E "assignments/route" || echo "no assignments route type errors"` and `npm run build`.
Expected: clean; build succeeds.

- [ ] **Step 3: Commit**

```bash
git add "src/app/api/assignments/route.ts"
git commit -m "Harden assignments route: surface delete error, validate input, handle bad body"
```

---

## Task 4: Validation + safe body parse for the remaining board routes

Apply the same lightweight guard to `relief`, `breaks`, `daily-active`, `daily-shifts`, `designations`. Each: `safeJson` (400 on bad body) + `missingFields` on the route's required keys, and validate the id/staff_id on DELETE. Also delete the stale `// Also need PATCH for rooms/sites APIs - add sort_order support` comment in `BoardClient.tsx` (reorder now works).

**Files:**
- Modify: `relief/route.ts`, `breaks/route.ts`, `daily-active/route.ts`, `daily-shifts/route.ts`, `designations/route.ts`, `src/app/board/BoardClient.tsx`

- [ ] **Step 1: Apply to each route**

For each POST handler, replace `const body = await req.json();` with:
```ts
  const body = await safeJson(req);
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
```
and add the import `import { safeJson, missingFields } from '@/lib/boardApi';`. Then add a required-field check immediately after, using each route's keys:
- `relief` POST: `['staff_id', 'staff_name', 'staff_role']`
- `breaks` POST: `['staff_id', 'break_type']`
- `daily-active` POST: `['staff_id']`
- `daily-shifts` POST: `['staff_id', 'hours']`
- `designations` POST: `['staff_id', 'designation']`
```ts
  const missing = missingFields(body, [/* keys above */]);
  if (missing.length) return NextResponse.json({ error: `Missing: ${missing.join(', ')}` }, { status: 400 });
```
Then read fields from `body` (cast as needed, e.g. `body.staff_id as string`). For each DELETE handler that uses `staff_id`/`id` from query params, add a guard: if the required param is null, return `400 'Missing <param>'` instead of using `!`.

In `src/app/board/BoardClient.tsx`, delete the dead line `// Also need PATCH for rooms/sites APIs - add sort_order support` (~line 900).

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit` (clean) and `npm run build` (all routes compile).

- [ ] **Step 3: Commit**

```bash
git add "src/app/api/relief/route.ts" "src/app/api/breaks/route.ts" "src/app/api/daily-active/route.ts" "src/app/api/daily-shifts/route.ts" "src/app/api/designations/route.ts" "src/app/board/BoardClient.tsx"
git commit -m "Add validation + safe body parse to remaining board routes"
```

---

## Task 5: Full verification

- [ ] **Step 1: Suite + typecheck + build**

Run: `npm test && npx tsc --noEmit && npm run build`
Expected: all tests pass (engine + calculator + boardApi); tsc clean; production build succeeds.

- [ ] **Step 2: Confirm the reorder fix is coherent**

Run: `grep -n "updates.position" src/app/api/rooms/route.ts`
Expected: a match — the PATCH writes `position` (the column `board/page.tsx` orders by), so reorders now persist.

- [ ] **Step 3: Commit (only if a fix was needed)**

```bash
git add <fixed files>
git commit -m "Fix floor-runner hardening verification issues"
```

---

## Self-Review (completed during planning)

**Spec coverage:**
- Room reorder persistence (read `position` vs write `sort_order` mismatch) → Task 2 (PATCH writes `position`). ✓
- New-room position collision (`position: 99`) → Task 2 (`nextPosition`). ✓
- Missing input validation (`id!`/`staff_id!`, required fields) → `missingFields` + DELETE guards across Tasks 2/3/4. ✓
- Unhandled malformed body → `safeJson` across Tasks 2/3/4. ✓
- Assignment delete-then-upsert ignoring the delete error → Task 3. ✓
- Out of scope (needs live board / visual verification, stated up front): touch DnD, optimistic rollback in BoardClient, transactional move RPC, visual redesign. ✓

**Placeholder scan:** No placeholder steps; Task 4 enumerates exact required-key lists per route rather than saying "validate appropriately."

**Type consistency:** `safeJson(req)`, `missingFields(obj, keys)`, `nextPosition(rows)` defined once in Task 1 and used identically in Tasks 2–4. Routes keep their existing Supabase patterns; only the body-parse + validation lines change.
