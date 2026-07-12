# Weekend Call v2 + Call Counts Expectations — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the four approved items from `docs/superpowers/specs/2026-07-12-weekend-call-v2-and-callcounts-design.md`: month-view name fit, the new weekend call structure as pattern data, in-house-first/best-effort fill (proven + one opt-in engine lever), and FTE expectations in the Call Counts modal.

**Architecture:** UI items live entirely in `src/app/(scheduling)/schedules/[id]/` (one new pure helper module + edits to `page.tsx`). The weekend structure is a new `CallPatternDoc` constant (single source of truth in `src/lib/rulesEngine/patterns/weekendV2.ts`) consumed by tests and emitted into a patch19 SQL file; one opt-in schema field (`callFillOrder`) plus a scoped sort in `solve()` provides in-house priority without touching legacy behavior. Rollout is a reviewed SQL patch applied via the `supabase-floorrunner` MCP.

**Tech Stack:** Next.js 14 / React inline-styles, vitest, zod, Supabase (scheduling schema).

**Two planning discoveries baked in (amendments to spec §2/§3, pre-authorized as Risk #2 and the §3 lever):**
1. The engine fills call slots weekend-first (`saturday → sunday → friday → weekday` — see `dayOrder` in `__fixtures__/buildContext.ts`, mirroring production sort). Doc A's chain is therefore expressed as a **sunday-anchored block `C2 → {offset −2, C1}`** (same person-shape as the approved graphic) instead of a friday-anchored `+2` link that would fire after Sunday is already filled.
2. Within a date the legacy fill order is `C2, C3, C1`; under Sunday scarcity that starves in-house C1 behind home-call C2. New **opt-in** pattern field `callFillOrder: 'call_rank'` re-sorts within each date by `call_rank` (C1=0 first). Absent field = legacy order → zero golden-parity risk.

---

### Task 0: Amend the spec with the two planning discoveries

**Files:**
- Modify: `docs/superpowers/specs/2026-07-12-weekend-call-v2-and-callcounts-design.md`

- [x] **Step 0.1:** In spec §2 JSON, replace the friday-anchored block

```json
{ "anchorDayType": "friday", "chains": [
  { "trigger": "C1", "links": [{ "offset": 2, "code": "C2" }] }
]}
```

with

```json
{ "anchorDayType": "sunday", "chains": [
  { "trigger": "C2", "links": [{ "offset": -2, "code": "C1" }] }
]}
```

and add `"callFillOrder": "call_rank"` as a top-level doc field. Update the delta table row "new Friday-anchored block" → "new Sunday-anchored block (`C2 → −2 C1` = Doc A: Sun C2 person carries Fri C1)". In §3, change the priority-lever sentence to state it **is** implemented as the opt-in `callFillOrder` field. In Risks, mark risk 2 resolved by the sunday anchor.

- [x] **Step 0.2:** Commit.

```bash
git add docs/superpowers/specs/2026-07-12-weekend-call-v2-and-callcounts-design.md
git commit -m "spec: weekend-v2 — sunday-anchored Doc A chain + opt-in callFillOrder (planning discoveries, pre-authorized contingencies)"
```

---

### Task 1: Shared FTE-weighted target helper

**Files:**
- Create: `src/app/(scheduling)/schedules/[id]/fteTarget.ts`
- Test: `src/app/(scheduling)/schedules/[id]/fteTarget.test.ts`
- Modify: `src/app/(scheduling)/schedules/[id]/page.tsx:550` (grid over-par) and `page.tsx:2214` (modal `getExtra`)

- [x] **Step 1.1: Write the failing test**

```ts
// fteTarget.test.ts
import { describe, it, expect } from 'vitest';
import { fteWeightedTarget } from './fteTarget';

describe('fteWeightedTarget', () => {
  it('is (bucketTotal / parLevel) × fte', () => {
    expect(fteWeightedTarget(12, 12, 1)).toBe(1);
    expect(fteWeightedTarget(13, 12, 0.75)).toBeCloseTo(0.8125, 6);
    expect(fteWeightedTarget(9, 12, 0.5)).toBeCloseTo(0.375, 6);
  });
  it('returns 0 for empty buckets and degenerate par levels', () => {
    expect(fteWeightedTarget(0, 12, 1)).toBe(0);
    expect(fteWeightedTarget(10, 0, 1)).toBe(0);
    expect(fteWeightedTarget(10, -3, 1)).toBe(0);
  });
});
```

- [x] **Step 1.2:** Run `npx vitest run "src/app/(scheduling)/schedules/[id]/fteTarget.test.ts"` — expect FAIL (module not found).

- [x] **Step 1.3: Implement**

```ts
// fteTarget.ts
// The house FTE-weighted call-obligation formula (spec choice A):
//   target = (slots in the bucket ÷ site call_par_level) × provider FTE.
// Single source for: grid over-par red cells, modal Extra Calls, and the
// modal's expected-calls displays. Blind to eligibility by design (mirrors
// the pre-existing Extra Calls semantics).
export function fteWeightedTarget(bucketTotal: number, parLevel: number, fte: number): number {
  if (!Number.isFinite(parLevel) || parLevel <= 0) return 0;
  return (bucketTotal / parLevel) * fte;
}
```

- [x] **Step 1.4:** Run the test again — expect PASS.

- [x] **Step 1.5: Refactor the two existing call sites.** In `page.tsx` add `import { fteWeightedTarget } from './fteTarget';`. At ~line 550 (grid over-par useMemo):

```ts
// before
const target = (blockTotal / parLevel) * fte;
// after
const target = fteWeightedTarget(blockTotal, parLevel, fte);
```

At ~line 2214 (modal `getExtra`):

```ts
// before
const target = (blockTotal / parLevel) * fte;
// after
const target = fteWeightedTarget(blockTotal, parLevel, fte);
```

- [x] **Step 1.6:** `npx tsc --noEmit && npm test` — expect clean types; suite green except the 10 documented gridCalculator tsx-runner file errors.

- [x] **Step 1.7: Commit**

```bash
git add "src/app/(scheduling)/schedules/[id]/fteTarget.ts" "src/app/(scheduling)/schedules/[id]/fteTarget.test.ts" "src/app/(scheduling)/schedules/[id]/page.tsx"
git commit -m "feat: shared fteWeightedTarget helper — one formula for red cells, Extra Calls, expectations"
```

---

### Task 2: Call Counts modal — FTE label, per-cell expected, Expected row

**Files:**
- Modify: `src/app/(scheduling)/schedules/[id]/page.tsx` (`CallCountsModal`, ~lines 2099–2404)

No component test harness exists in this repo; correctness rides on Task 1's tested helper. Verification = tsc + build + manual.

- [x] **Step 2.1: Add expectation helpers** inside `CallCountsModal`, directly under the existing `getExtra` definition (which already computes `fteByPid` and `parLevel` above it):

```ts
const expectedFor = (pid: string, bucket: string, code: string) =>
  fteWeightedTarget(blockTotals[`${bucket}|${code}`] || 0, parLevel, fteByPid[pid] ?? 1);
const rowExpected = (pid: string) => {
  let t = 0;
  for (const b of BUCKETS) for (const c of CODES) t += expectedFor(pid, b.key, c);
  return t;
};
const colExpected = (bucket: string, code: string) => {
  let t = 0;
  for (const p of providers) t += expectedFor(p.id, bucket, code);
  return t;
};
const fmtFte = (fte: number) => fte.toFixed(2).replace(/\.?0+$/, '');
```

- [x] **Step 2.2: FTE next to the provider name.** Replace the provider `<td>` (~line 2340):

```tsx
<td style={{ padding: '6px 10px', color: 'var(--text)', fontWeight: 500 }}>
  {p.short_display_name}
  {fteByPid[p.id] != null && (
    <span style={{ color: 'var(--text-dim)', fontSize: 11, marginLeft: 5 }}>
      · {fmtFte(fteByPid[p.id])}
    </span>
  )}
</td>
```

- [x] **Step 2.3: Expected in parentheses in each bucket×code cell.** Replace the count-cell body (~line 2343–2352):

```tsx
{BUCKETS.map(b => CODES.map(c => {
  const n = getCount(p.id, b.key, c);
  const exp = expectedFor(p.id, b.key, c);
  return (
    <td key={`${b.key}|${c}`} style={{
      padding: '6px 8px', textAlign: 'center', whiteSpace: 'nowrap',
      color: n === 0 ? 'var(--text-dim)' : 'var(--text)',
      borderLeft: c === 'C1' ? '1px solid var(--border)' : 'none',
      fontWeight: n > 0 ? 600 : 400,
    }}>
      {n || '—'}
      {exp >= 0.05 && (
        <span style={{ fontSize: 10, color: 'var(--text-dim)', marginLeft: 3, fontWeight: 400 }}>
          ({exp.toFixed(1)})
        </span>
      )}
    </td>
  );
}))}
```

- [x] **Step 2.4: Expected row under the Total row.** Insert directly after the Totals `</tr>` (~line 2403):

```tsx
{/* Expected row — Σ of per-provider FTE-weighted targets. Below Total ⇒
    roster FTE < par level; the gap is the extra-call burden. */}
<tr style={{ color: 'var(--text-dim)', fontWeight: 600 }}
    title="Sum of each provider's FTE-weighted obligation: (column total ÷ call par level) × FTE. When this is below Total, the roster is under par and the difference must be absorbed as extra calls.">
  <td style={{ padding: '6px 10px' }}>Expected</td>
  {BUCKETS.map(b => CODES.map(c => (
    <td key={`exp-${b.key}|${c}`} style={{
      padding: '6px 8px', textAlign: 'center',
      borderLeft: c === 'C1' ? '1px solid var(--border)' : 'none',
    }}>{colExpected(b.key, c) >= 0.05 ? colExpected(b.key, c).toFixed(1) : '—'}</td>
  )))}
  {CODES.map(c => (
    <td key={`exp-extra|${c}`} style={{
      padding: '6px 8px', textAlign: 'center',
      borderLeft: c === 'C1' ? '1px solid var(--border)' : 'none',
    }}>—</td>
  ))}
  <td style={{ padding: '6px 10px', textAlign: 'center', borderLeft: '1px solid var(--border)' }}>
    {providers.reduce((s, p) => s + rowExpected(p.id), 0).toFixed(1)}
  </td>
  <td style={{ padding: '6px 10px', textAlign: 'center', borderLeft: '1px solid var(--border)' }}>—</td>
</tr>
```

- [x] **Step 2.5:** `npx tsc --noEmit` clean, then `npm run dev` → open the June schedule → Call Counts: names show `· 0.75`-style FTE, cells show `3 (2.6)`, Expected row present with the tooltip. Print preview still isolates the table.

- [x] **Step 2.6: Commit**

```bash
git add "src/app/(scheduling)/schedules/[id]/page.tsx"
git commit -m "feat: Call Counts modal — FTE labels, expected-per-cell, Expected totals row (formula A)"
```

---

### Task 3: Month view — names fit

**Files:**
- Modify: `src/app/(scheduling)/schedules/[id]/page.tsx:1186-1187` (columns), `:1368` (name span)

`viewMode` is component state (line 221) in the same scope as both edit sites (verify: it's used at lines 644 and 1028 in the same function).

- [x] **Step 3.1: View-dependent column floor.** Replace lines 1186–1187:

```ts
// before
gridTemplateColumns: `84px repeat(${colCount}, minmax(74px, 1fr))`,
minWidth: colCount > 7 ? `${84 + colCount * 74}px` : undefined,
// after — month view packs ~30 columns; give each enough floor for a name
gridTemplateColumns: `84px repeat(${colCount}, minmax(${viewMode === 'month' ? 82 : 74}px, 1fr))`,
minWidth: colCount > 7 ? `${84 + colCount * (viewMode === 'month' ? 82 : 74)}px` : undefined,
```

- [x] **Step 3.2: Smaller month-view name font + ellipsis safety net.** Replace the assigned-name span (~line 1368):

```tsx
<span style={{
  fontSize: viewMode === 'month' ? 11 : 13, fontWeight: 800, color: gridTokens.name,
  whiteSpace: 'nowrap', maxWidth: '100%', overflow: 'hidden',
  textOverflow: 'ellipsis', display: 'inline-block', verticalAlign: 'bottom',
}}>
  {provider!.short_display_name}
</span>
```

- [x] **Step 3.3:** `npx tsc --noEmit`, then visually check Month view (longest roster names fit; Week view unchanged at 13px).

- [x] **Step 3.4: Commit**

```bash
git add "src/app/(scheduling)/schedules/[id]/page.tsx"
git commit -m "fix: month view — 82px column floor + 11px names with ellipsis so names fit"
```

---

### Task 4: `callFillOrder` pattern field + in-date call_rank sort in solve()

**Files:**
- Modify: `src/lib/rulesEngine/callPattern.ts` (schema + type)
- Modify: `src/lib/rulesEngine/solve.ts` (entry sort)
- Test: `src/lib/rulesEngine/weekendV2Pattern.test.ts` (created here, extended in Task 5)

- [x] **Step 4.1: Failing schema test.** Create `src/lib/rulesEngine/weekendV2Pattern.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { CallPatternDocSchema } from './callPattern';
import { CLASSIC_PATTERN } from './callPattern';

describe('callFillOrder schema field', () => {
  it('accepts call_rank and defaults to absent', () => {
    const doc = CallPatternDocSchema.parse({ ...CLASSIC_PATTERN, callFillOrder: 'call_rank' });
    expect(doc.callFillOrder).toBe('call_rank');
    expect(CallPatternDocSchema.parse(CLASSIC_PATTERN).callFillOrder).toBeUndefined();
  });
  it('rejects unknown orders', () => {
    expect(() => CallPatternDocSchema.parse({ ...CLASSIC_PATTERN, callFillOrder: 'alphabetical' })).toThrow();
  });
});
```

(If `CLASSIC_PATTERN` is exported under a different name in `callPattern.ts`, use that export — it's the seeded classic doc constant visible at the bottom of the file.)

- [x] **Step 4.2:** Run `npx vitest run src/lib/rulesEngine/weekendV2Pattern.test.ts` — expect FAIL (`callFillOrder` stripped/rejected by `.strict()`).

- [x] **Step 4.3: Extend the schema.** In `CallPatternDocSchema` (callPattern.ts:48) add alongside the existing top-level fields:

```ts
// Opt-in within-date call fill order. 'call_rank' sorts each date's call
// slots by shift_types.call_rank ascending (C1=0 first) so in-house call
// never starves behind home-call under pool pressure. Absent = legacy
// order (C2, C3, C1) — classic docs are byte-identical in behavior.
callFillOrder: z.enum(['call_rank']).optional(),
```

Add `callFillOrder?: 'call_rank';` to the exported `CallPatternDoc` type if it is hand-written rather than inferred.

- [x] **Step 4.4:** Re-run the test — schema cases PASS.

- [x] **Step 4.5: Failing behavior probe.** Append to the same test file (uses the micro-fixture helpers exactly like `patternEngine.test.ts`; `2026-01-11` is a Sunday):

```ts
import { solve } from './solve';
import { buildCtx, prov, callSlot, shiftInfo } from './__fixtures__/buildContext';

// C1 ranks 0 in prod (C2=1, C3=2). Under Sunday scarcity, legacy order
// (C2 first) hands the last provider to home-call; call_rank order must
// protect the in-house C1 instead.
describe('callFillOrder: call_rank — in-house C1 wins under scarcity', () => {
  const sunC1 = callSlot('sunC1', '2026-01-11', 'C1', 'sunday');
  const sunC2 = callSlot('sunC2', '2026-01-11', 'C2', 'sunday');
  const providers = [prov('p1'), prov('p2')];
  const p2pto = new Map([['p2', [{
    availability_type: 'pto', start_date: '2026-01-11', end_date: '2026-01-11',
    approval_status: 'approved',
  }]]]);
  const shiftTypes = new Map([
    ['C1', shiftInfo('C1', { call_rank: 0 })],
    ['C2', shiftInfo('C2', { call_rank: 1 })],
  ]);

  it('legacy order gives the scarce provider to C2 (characterization)', () => {
    const plan = solve(buildCtx([sunC2, sunC1], providers, { availByPid: p2pto, shiftTypes }));
    expect(plan.assignments.find(a => a.slot_id === 'sunC2')?.provider_id).toBe('p1');
    expect(plan.assignments.some(a => a.slot_id === 'sunC1')).toBe(false);
  });

  it('call_rank order fills C1 first, C2 goes unfilled instead', () => {
    const doc = { ...CLASSIC_PATTERN, callFillOrder: 'call_rank' as const };
    const plan = solve(buildCtx([sunC2, sunC1], providers, { availByPid: p2pto, shiftTypes, callPattern: doc }));
    expect(plan.assignments.find(a => a.slot_id === 'sunC1')?.provider_id).toBe('p1');
    expect(plan.assignments.some(a => a.slot_id === 'sunC2')).toBe(false);
  });
});
```

Adjust two things to the codebase's actual shapes (check `genTypes.ts` / `buildContext.ts` before running): the `shiftTypes` context field name (grep `ShiftTypeInfo` in `genTypes.ts` — genContext loads full shift types since scheduling-v2) and the `shiftInfo(code, over)` helper signature. Keep the assertions identical.

- [x] **Step 4.6:** Run — the `call_rank order` case must FAIL (sort not implemented). The characterization case documents current behavior; if it fails, read the actual plan output and fix the *test's* expectation to match observed legacy behavior (it exists to prove the delta, not to pin a wish).

- [x] **Step 4.7: Implement the sort** at the top of `solve()` in `solve.ts`, where the slot list is first read from ctx:

```ts
// Opt-in in-house-first ordering (pattern doc callFillOrder: 'call_rank').
// Stable re-sort WITHIN each date only — comparator returns 0 across
// different dates, so the weekend-first day ordering from genContext is
// preserved exactly. Absent flag = untouched legacy order.
let slotsToFill = ctx.slotsToFill;
if (ctx.callPattern?.callFillOrder === 'call_rank') {
  const rankOf = (code: string) => ctx.shiftTypes?.get(code)?.call_rank ?? 99;
  slotsToFill = [...ctx.slotsToFill].sort((a, b) =>
    a.slot_date === b.slot_date
      ? rankOf(a.shift_type_code) - rankOf(b.shift_type_code)
      : 0);
}
```

…and use `slotsToFill` wherever the function previously iterated `ctx.slotsToFill`. (Adapt the `ctx.shiftTypes` accessor to the real field per Step 4.5's check; `call_rank` may be `null` → the `?? 99` keeps null-ranked codes last.)

- [x] **Step 4.8:** `npx vitest run src/lib/rulesEngine/weekendV2Pattern.test.ts` — all green. Then the full engine gate: `npx vitest run src/lib/rulesEngine` — **`goldenParity.test.ts` must be green with zero new enumerated divergences** (classic docs don't set the flag, so any parity change means the sort leaked into the legacy path — fix before proceeding).

- [x] **Step 4.9: Commit**

```bash
git add src/lib/rulesEngine/callPattern.ts src/lib/rulesEngine/solve.ts src/lib/rulesEngine/weekendV2Pattern.test.ts
git commit -m "feat: opt-in callFillOrder='call_rank' — in-house C1 fills before home call within a date"
```

---

### Task 5: WEEKEND_V2 pattern doc + golden-shape and chain-break proof suite

**Files:**
- Create: `src/lib/rulesEngine/patterns/weekendV2.ts`
- Modify: `src/lib/rulesEngine/weekendV2Pattern.test.ts` (extend)

- [x] **Step 5.1: The pattern constant** (single source of truth for tests + patch19):

```ts
// patterns/weekendV2.ts
// Weekend call v2 for Paoli (spec 2026-07-12): weekend spread across four
// people — Sun-C2 person carries Fri C1 (sunday-anchored −2 link, engine
// fills weekends before Fridays); Sat-C2 person carries Fri C2 + Sun C1;
// Neuro (C3) covers Fri→Sun; Sat-C1 person gets Fri D2 and Sunday off.
import { CallPatternDocSchema, type CallPatternDoc } from '../callPattern';

export const WEEKEND_V2_PATTERN: CallPatternDoc = CallPatternDocSchema.parse({
  version: 1,
  callFillOrder: 'call_rank',
  spans: [],
  blocks: [
    { anchorDayType: 'saturday', chains: [
      { trigger: 'C3', links: [{ offset: -1, code: 'C3' }, { offset: 1, code: 'C3' }] },
      { trigger: 'C1', links: [{ offset: -1, code: 'D2' }] },
      { trigger: 'C2', links: [{ offset: -1, code: 'C2' }, { offset: 1, code: 'C1' }] },
    ]},
    { anchorDayType: 'sunday', chains: [
      { trigger: 'C2', links: [{ offset: -2, code: 'C1' }] },
    ]},
  ],
  dayChains: [
    { trigger: 'C1', dayTypes: ['weekday', 'friday', 'federal_holiday', 'major_holiday'],
      links: [{ offset: -1, code: 'D2', unlessCallWithinDays: 2 }], blocks: [{ offset: 1 }] },
    { trigger: 'C1', dayTypes: ['saturday'], blocks: [{ offset: 1 }] },
    { trigger: 'C1', dayTypes: ['sunday'], blocks: [{ offset: 1 }] },
    { trigger: 'C2', dayTypes: ['weekday', 'friday', 'federal_holiday', 'major_holiday'],
      links: [{ offset: -1, code: 'D3', unlessCallWithinDays: 2 }, { offset: 1, code: 'D1' }] },
    { trigger: 'C2', dayTypes: ['sunday'], links: [{ offset: 1, code: 'D1' }] },
  ],
  reliefPass: { enabled: true, dayTypes: ['weekday', 'friday'] },
  placementPasses: [
    { kind: 'pre_pto', relativeDay: 'thursday_prior_week', codes: ['C1', 'C2'], maxProviders: 2, enabled: true },
  ],
  optimizerMovableDayTypes: ['weekday', 'friday'],
});
```

- [x] **Step 5.2: Golden-shape test.** Append to `weekendV2Pattern.test.ts` (Fri 2026-01-09 … Mon 2026-01-12; `dSlot` for D-codes; six 1.0-FTE providers so every chain can staff):

```ts
import { WEEKEND_V2_PATTERN } from './patterns/weekendV2';
import { dSlot } from './__fixtures__/buildContext';

describe('WEEKEND_V2_PATTERN — golden weekend shape (Doc A/B/C/E)', () => {
  const slots = [
    callSlot('friC1', '2026-01-09', 'C1', 'friday'),
    callSlot('friC2', '2026-01-09', 'C2', 'friday'),
    callSlot('friC3', '2026-01-09', 'C3', 'friday'),
    dSlot('friD2', '2026-01-09', 'D2', 'friday'),
    callSlot('satC1', '2026-01-10', 'C1', 'saturday'),
    callSlot('satC2', '2026-01-10', 'C2', 'saturday'),
    callSlot('satC3', '2026-01-10', 'C3', 'saturday'),
    callSlot('sunC1', '2026-01-11', 'C1', 'sunday'),
    callSlot('sunC2', '2026-01-11', 'C2', 'sunday'),
    callSlot('sunC3', '2026-01-11', 'C3', 'sunday'),
    dSlot('monD1', '2026-01-12', 'D1', 'weekday'),
  ];
  const providers = [prov('p1'), prov('p2'), prov('p3'), prov('p4'), prov('p5'), prov('p6')];
  const shiftTypes = new Map([
    ['C1', shiftInfo('C1', { call_rank: 0 })],
    ['C2', shiftInfo('C2', { call_rank: 1 })],
    ['C3', shiftInfo('C3', { call_rank: 2 })],
  ]);

  it('produces the four-person weekend from the approved graphic', () => {
    const plan = solve(buildCtx(slots, providers, { callPattern: WEEKEND_V2_PATTERN, shiftTypes }));
    const byId = Object.fromEntries(plan.assignments.map(a => [a.slot_id, a.provider_id]));

    // Doc A: Sun C2 person carries Fri C1, gets Mon D1, is OFF Saturday.
    expect(byId['friC1']).toBe(byId['sunC2']);
    expect(byId['monD1']).toBe(byId['sunC2']);
    expect(plan.assignments.some(a => a.provider_id === byId['friC1'] && a.slot_date === '2026-01-10')).toBe(false);

    // Doc B: Sat C2 person carries Fri C2 + Sun C1, is OFF Monday.
    expect(byId['friC2']).toBe(byId['satC2']);
    expect(byId['sunC1']).toBe(byId['satC2']);
    expect(plan.assignments.some(a => a.provider_id === byId['satC2'] && a.slot_date === '2026-01-12')).toBe(false);

    // Doc C: one person covers Neuro Fri→Sun, works Monday (no post-call).
    expect(byId['friC3']).toBe(byId['satC3']);
    expect(byId['sunC3']).toBe(byId['satC3']);

    // Doc E: Sat C1 person has Fri D2 and is OFF Sunday.
    expect(byId['friD2']).toBe(byId['satC1']);
    expect(plan.assignments.some(a => a.provider_id === byId['satC1'] && a.slot_date === '2026-01-11')).toBe(false);

    // Four distinct people carry the four rows.
    expect(new Set([byId['sunC2'], byId['satC2'], byId['satC3'], byId['satC1']]).size).toBe(4);
  });
});
```

- [x] **Step 5.3:** Run it. If the Doc-A assertions fail because a link-filled Fri C1 does not apply its friday day-chain block (Sat off), apply the spec's authorized fallback: keep the sunday-anchored chain and *also* assert/observe actual behavior, then decide with the plan-reviewer whether to add `{ offset: -1 }`-style explicit handling — do NOT silently weaken assertions. Record the outcome in the test comments.

- [x] **Step 5.4: Chain-break probes.** Append:

```ts
describe('WEEKEND_V2_PATTERN — broken chains still fill (in-house first)', () => {
  const mkSlots = () => [
    callSlot('friC1', '2026-01-09', 'C1', 'friday'),
    callSlot('friC2', '2026-01-09', 'C2', 'friday'),
    callSlot('satC1', '2026-01-10', 'C1', 'saturday'),
    callSlot('satC2', '2026-01-10', 'C2', 'saturday'),
    callSlot('sunC1', '2026-01-11', 'C1', 'sunday'),
    callSlot('sunC2', '2026-01-11', 'C2', 'sunday'),
  ];
  const shiftTypes = new Map([
    ['C1', shiftInfo('C1', { call_rank: 0 })],
    ['C2', shiftInfo('C2', { call_rank: 1 })],
  ]);

  it('every C1 is assigned even when Sunday capacity is scarce', () => {
    // p3/p4 PTO all weekend: only p1+p2 available — not enough for every
    // chain, but enough for every in-house slot.
    const pto = [{ availability_type: 'pto', start_date: '2026-01-09', end_date: '2026-01-11', approval_status: 'approved' }];
    const ctx = buildCtx(mkSlots(), [prov('p1'), prov('p2'), prov('p3'), prov('p4')], {
      callPattern: WEEKEND_V2_PATTERN, shiftTypes,
      availByPid: new Map([['p3', pto], ['p4', pto]]),
    });
    const plan = solve(ctx);
    for (const id of ['friC1', 'satC1', 'sunC1']) {
      expect(plan.assignments.some(a => a.slot_id === id), `${id} must be filled`).toBe(true);
    }
  });

  it('a Sun-C1 link broken by PTO falls through to a standalone fill', () => {
    // p2 will win satC2 by score but has Sunday PTO → its +1 C1 link fails;
    // sunC1 must still be assigned to someone else, and never to p2.
    const ctx = buildCtx(mkSlots(), [prov('p1'), prov('p2'), prov('p3')], {
      callPattern: WEEKEND_V2_PATTERN, shiftTypes,
      availByPid: new Map([['p2', [{
        availability_type: 'pto', start_date: '2026-01-11', end_date: '2026-01-11',
        approval_status: 'approved',
      }]]]),
    });
    const plan = solve(ctx);
    const sunC1 = plan.assignments.find(a => a.slot_id === 'sunC1');
    expect(sunC1).toBeDefined();
    expect(sunC1!.provider_id).not.toBe('p2');
  });

  it('a blocked Fri D2 link is recorded, Sat C1 unaffected', () => {
    // No friD2 slot exists at all → 'no-slot' skip, satC1 still assigned.
    const ctx = buildCtx(mkSlots(), [prov('p1'), prov('p2'), prov('p3')], {
      callPattern: WEEKEND_V2_PATTERN, shiftTypes,
    });
    const plan = solve(ctx);
    expect(plan.assignments.some(a => a.slot_id === 'satC1')).toBe(true);
    expect(plan.skippedDerived.some(s => s.code === 'D2' && s.reason === 'no-slot')).toBe(true);
  });
});
```

(As in Task 4: verify the exact `skippedDerived` reason vocabulary against `genTypes.ts` — ALGORITHM.md lists `pto | cross-site | occupied | no-slot | ineligible | already-handled`.)

- [x] **Step 5.5:** `npx vitest run src/lib/rulesEngine` — everything green, golden parity untouched.

- [x] **Step 5.6: Commit**

```bash
git add src/lib/rulesEngine/patterns/weekendV2.ts src/lib/rulesEngine/weekendV2Pattern.test.ts
git commit -m "feat: WEEKEND_V2_PATTERN + golden-shape and chain-break proof suite"
```

---

### Task 6: patch19 — SQL rollout file + emit script

**Files:**
- Create: `scripts/emitWeekendV2Patch.ts`
- Create: `supabase_scheduling_patch19_weekend_v2_pattern.sql`

- [x] **Step 6.1: Emit script** (guarantees the SQL's embedded JSON is byte-identical to the tested constant):

```ts
// scripts/emitWeekendV2Patch.ts — run: npx tsx scripts/emitWeekendV2Patch.ts
// Prints the patch19 SQL with the zod-validated WEEKEND_V2_PATTERN inlined.
import { WEEKEND_V2_PATTERN } from '../src/lib/rulesEngine/patterns/weekendV2';

const SITE = '2ddd2427-22fb-4290-9c4c-03a957e5af4e'; // Paoli
const doc = JSON.stringify(WEEKEND_V2_PATTERN).replace(/'/g, "''");

console.log(`-- supabase_scheduling_patch19_weekend_v2_pattern.sql
-- Weekend call v2 (spec docs/superpowers/specs/2026-07-12-weekend-call-v2-and-callcounts-design.md)
-- Applies to site ${SITE} (Paoli). Idempotence guard: aborts if already applied.
BEGIN;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM scheduling.call_patterns
             WHERE site_id = '${SITE}' AND name = 'Weekend v2 (2026-07-12)') THEN
    RAISE EXCEPTION 'patch19 already applied';
  END IF;
END $$;

-- 1. Archive the current active pattern (kept for one-click restore).
UPDATE scheduling.call_patterns
   SET status = 'archived', updated_at = now()
 WHERE site_id = '${SITE}' AND status = 'active';

-- 2. Insert the new active pattern (JSON validated by CallPatternDocSchema at emit time).
INSERT INTO scheduling.call_patterns (site_id, name, status, source, definition)
VALUES ('${SITE}', 'Weekend v2 (2026-07-12)', 'active', 'manual', '${doc}'::jsonb);

-- 3. Friday C3 (Neuro) template so future schedules materialize the slot.
--    Copies every column from the existing saturday C3 template.
INSERT INTO scheduling.shift_templates
  (site_id, schedule_layer, day_type, weekday_number, applies_on_holiday,
   shift_type_id, required_count, required_skills, generation_priority, is_active)
SELECT site_id, schedule_layer, 'friday', weekday_number, applies_on_holiday,
       shift_type_id, required_count, required_skills, generation_priority, true
  FROM scheduling.shift_templates t
 WHERE t.site_id = '${SITE}' AND t.day_type = 'saturday' AND t.is_active
   AND t.shift_type_id = (SELECT id FROM scheduling.shift_types
                           WHERE site_id = '${SITE}' AND code = 'C3')
 LIMIT 1;

COMMIT;

-- Verification (run after):
--   SELECT name, status FROM scheduling.call_patterns WHERE site_id = '${SITE}' ORDER BY created_at;
--   -- expect: Classic … archived, Weekend v2 (2026-07-12) active
--   SELECT day_type, st.code FROM scheduling.shift_templates tt
--     JOIN scheduling.shift_types st ON st.id = tt.shift_type_id
--    WHERE tt.site_id = '${SITE}' AND st.code = 'C3' AND tt.is_active ORDER BY day_type;
--   -- expect: friday, saturday, sunday
`);
```

- [x] **Step 6.2:** `npx tsx scripts/emitWeekendV2Patch.ts > supabase_scheduling_patch19_weekend_v2_pattern.sql` and read the output file end-to-end (JSON present, site id correct, guard present).

- [x] **Step 6.3: Commit** (file only — NOT applied yet):

```bash
git add scripts/emitWeekendV2Patch.ts supabase_scheduling_patch19_weekend_v2_pattern.sql
git commit -m "feat: patch19 — weekend v2 pattern + Friday C3 template (emit script keeps SQL in sync with tested constant)"
```

- [x] **Step 6.4: GATE — confirm with Gabriel, then apply via the `supabase-floorrunner` MCP** (`apply_migration` / `execute_sql`), after verifying the MCP's project ref is `qhwdbtixhzdsgwwtcfrm` (CLAUDE.md rule). Run both verification queries from the file's footer and paste results into the session.

---

### Task 7: Live end-to-end verification (throwaway schedule)

No files. Uses the running dev server against the live DB (org `3d4621c3-340f-4a16-b3fc-8529a2ccb42e`, site `2ddd2427-22fb-4290-9c4c-03a957e5af4e`).

- [x] **Step 7.1:** Create a far-future throwaway schedule (dates chosen to avoid overlapping real drafts):

```bash
curl -s -X POST http://localhost:3000/api/scheduling/schedules -H 'content-type: application/json' -d '{
  "organization_id": "3d4621c3-340f-4a16-b3fc-8529a2ccb42e",
  "site_id": "2ddd2427-22fb-4290-9c4c-03a957e5af4e",
  "schedule_type": "combined", "provider_group": "physician",
  "date_start": "2027-03-01", "date_end": "2027-03-28"
}'
```

Capture `id` and `version_id`. Confirm the response's slot creation includes Friday C3 (query the grid and look for a `C3` slot on a Friday date).

- [x] **Step 7.2:** Generate: `curl -s -X POST http://localhost:3000/api/scheduling/schedules/<id>/generate -H 'content-type: application/json' -d '{"version_id":"<version_id>"}'` (check the route's expected body first — `generate/route.ts`). Inspect the response's warnings/unfilled/skippedDerived.

- [x] **Step 7.3:** Fetch the grid and verify one weekend by hand against the Doc A/B/C/E shape (same five relationships as the Task 5 golden test).

- [x] **Step 7.4:** Delete the throwaway schedule (`DELETE /api/scheduling/schedules/<id>` — confirm the route exists in `schedules/[id]/route.ts`; otherwise delete via the MCP with cascading slot/assignment cleanup, verifying row counts before/after).

---

### Task 8: Close-out

- [x] **Step 8.1:** `npx tsc --noEmit && npm test && npx next build` — all green (10 gridCalculator file errors remain documented noise).
- [x] **Step 8.2:** Check every box in this plan; note any deviations inline.
- [x] **Step 8.3:** `git push origin main` (auto-deploys to Vercel production; UI changes go live).
- [x] **Step 8.4:** Update memory (`scheduling_v2_progress.md` or a new note): weekend v2 pattern active at Paoli since patch19, `callFillOrder` field exists, June draft intentionally left on old structure.

---

## Self-review notes

- **Spec coverage:** §1→Task 3, §2→Tasks 0/5/6, §3→Tasks 4/5 (+7 live), §4→Tasks 1/2. Rollout+verification→6/7.
- **Known adaptation points (flagged in-task, not placeholders):** the `ctx.shiftTypes` field name and `shiftInfo`/`skippedDerived` exact shapes must be read from `genTypes.ts`/`buildContext.ts` before writing test code (Steps 4.5, 5.4); the generate-route body shape (Step 7.2); `CLASSIC_PATTERN` export name (Step 4.1).
- **Type consistency:** `fteWeightedTarget(bucketTotal, parLevel, fte)` used identically in Tasks 1–2; `WEEKEND_V2_PATTERN` imported from `patterns/weekendV2` in Tasks 5–6; `callFillOrder: 'call_rank'` literal everywhere.

---

## Close-out (2026-07-12)

All 8 tasks executed via subagent-driven development (fresh implementer + spec review + quality review per task; schedule-engine-reviewer for engine tasks). Deviations from the written plan, all reviewed:

- **Task 4 review round:** comparator rewritten to a consistent total order (dateSeq first-appearance + callRank tiebreak — the planned comparator was implementation-defined per ECMA-262); `rankOf`/`?? 99` replaced by the shared `callRank` helper; added `callFillOrderWarnings` (callPattern.ts) wired into genContext load warnings for null-ranked call codes.
- **Task 5 review round:** golden-shape fixture feeds slots weekend-first (buildCtx preserves input order; production genContext sorts saturday→sunday→friday→weekday). NEW ENGINE FIX beyond plan scope, reviewer-specified: `applyBlockChains` now records `no-slot` skips for missing link targets (invariant 4 — previously a silent `continue`); pinned in patternEngine.test.ts + June-draft scenario test.
- **Task 7 findings:** patch19 applied + verified (Classic archived, Weekend v2 active, Fri/Sat/Sun C3 templates). Live control experiment (same data, in-memory solve): Classic leaves 17 C1s unfilled on a 4-week window; Weekend v2 as deployed leaves 9 (priority lever working). Residual gaps are roster-vs-par starvation (pool Σ FTE 8.82 vs call_par_level 12) — pre-existing, now visible via generation warnings and the modal's Expected row. RECOMMENDATION: revisit call_par_level or roster/quota settings.
- Final suite at close: 582 tests passing, tsc clean, next build clean, golden parity 8/8 with zero new divergences.
