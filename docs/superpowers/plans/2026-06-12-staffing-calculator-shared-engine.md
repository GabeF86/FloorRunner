# Staffing Calculator — Shared Engine + Validation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Eliminate the duplicated break-analysis / severity / notes logic between `lankenau.ts` and `paoli.ts` by extracting a shared module, add the missing input clamping/validation and a feasibility summary — making the calculator smarter and scalable to new facilities — with characterization tests proving the per-facility outputs are unchanged.

**Architecture:** The registry (`FacilityCalculator` in `types.ts` + `index.ts`) is already data-driven and stays. Each facility keeps its own bespoke `calculate()` algorithm (the room/ratio/role logic genuinely differs), but the **shared scaffolding** — config clamping, break-analysis aggregation, severity thresholds, the break-coverage notes block, and a feasibility summary — moves into `staffingCalculator/shared.ts`. Both facilities call into it. Behavior is preserved (characterization tests lock the headline outputs); the feasibility summary is the one additive behavior (a note when planned staff exceed available).

**Tech Stack:** TypeScript (strict), Vitest. Pure functions only. No UI changes in this plan (a separate UI plan handles the page redesign).

**Scope note:** This is the "smarter/DRY/validated" half of the calculator work. The premium UI redesign of `staffing-calculator/page.tsx` is a SEPARATE plan. No behavior change to which staff get assigned — only de-duplication, validation, and an additive feasibility note.

---

## File Structure

**New files:**
- `src/lib/staffingCalculator/shared.ts` — `clampConfig`, `severityFor`, `buildBreakAnalysis`, `breakCoverageNotes`, `feasibilityNotes`, `BREAKS_PER_FLOAT`.
- `src/lib/staffingCalculator/shared.test.ts` — unit tests for the shared helpers.
- `src/lib/staffingCalculator/lankenau.test.ts` — characterization tests (headline outputs on 3 configs).
- `src/lib/staffingCalculator/paoli.test.ts` — characterization tests (headline outputs on 3 configs).

**Modified files:**
- `src/lib/staffingCalculator/lankenau.ts` — use shared clamp + break analysis + notes + feasibility.
- `src/lib/staffingCalculator/paoli.ts` — same.

---

## Task 1: Lock current behavior with characterization tests (BEFORE any refactor)

Capture the existing output of each calculator so the refactor can't silently change it. Assert headline scalars (not full snapshots) so the tests are readable.

**Files:**
- Create: `src/lib/staffingCalculator/lankenau.test.ts`, `src/lib/staffingCalculator/paoli.test.ts`

- [ ] **Step 1: Write the characterization tests**

Create `src/lib/staffingCalculator/lankenau.test.ts`. For each of three configs, run the CURRENT `lankenauCalculator.calculate(...)` and assert the headline outputs. To get the exact expected numbers, run the calculator once (e.g. a scratch `node`/`vitest` run or `console.log`) and paste the real values — the assertions must match the CURRENT code exactly:

```ts
import { describe, it, expect } from 'vitest';
import { lankenauCalculator } from './lankenau';

const avail = { mds: 12, crnas: 18 };

function headline(cfg: Record<string, number | boolean>) {
  const out = lankenauCalculator.calculate(cfg, avail);
  return {
    totalMDs: out.totalMDs, totalCRNAs: out.totalCRNAs, totalStaff: out.totalStaff,
    assignmentCount: out.assignments.length,
    breakDemand: out.breakAnalysis.demand, breakCapacity: out.breakAnalysis.capacity,
    breakPct: out.breakAnalysis.pct, severity: out.breakAnalysis.severity,
    contingencyCount: out.contingencies.length,
  };
}

describe('lankenau characterization (locks current behavior)', () => {
  it('default config', () => {
    expect(headline(lankenauCalculator.defaultConfig)).toMatchInlineSnapshot();
  });
  it('full house: 7 OR + APC 4 + cardiac 2 + endo 2 + EP 2 (TEE) + 2 C-sections', () => {
    expect(headline({
      mainOR: 7, addOnRooms: 0, apc: 4, cardiac: 2, endo: 2, ep: 2, epTEE: true, csections: 2, ir: true,
    })).toMatchInlineSnapshot();
  });
  it('minimal: 2 OR only', () => {
    expect(headline({ mainOR: 2, addOnRooms: 0, apc: 0, cardiac: 0, endo: 0, ep: 0, epTEE: false, csections: 0, ir: false })).toMatchInlineSnapshot();
  });
});
```

> Run the test ONCE with `npm test -- lankenau` and let Vitest populate the `toMatchInlineSnapshot()` calls with the real current values (it writes them into the file). Inspect the populated values for sanity (totals make sense), then they are locked. Do the same for `paoli.test.ts` below.

Create `src/lib/staffingCalculator/paoli.test.ts` analogously:

```ts
import { describe, it, expect } from 'vitest';
import { paoliCalculator } from './paoli';

const avail = { mds: 10, crnas: 14 };

function headline(cfg: Record<string, number | boolean>) {
  const out = paoliCalculator.calculate(cfg, avail);
  return {
    totalMDs: out.totalMDs, totalCRNAs: out.totalCRNAs, totalStaff: out.totalStaff,
    assignmentCount: out.assignments.length,
    breakDemand: out.breakAnalysis.demand, breakCapacity: out.breakAnalysis.capacity,
    breakPct: out.breakAnalysis.pct, severity: out.breakAnalysis.severity,
    contingencyCount: out.contingencies.length,
  };
}

describe('paoli characterization (locks current behavior)', () => {
  it('default config', () => {
    expect(headline(paoliCalculator.defaultConfig)).toMatchInlineSnapshot();
  });
  it('big day: 10 OR + EP + Neuro + TEEs', () => {
    expect(headline({ mainORCount: 10, addOnRooms: 1, epLab: true, neuroLab: true, tees: true, soloPri: false })).toMatchInlineSnapshot();
  });
  it('solo priority: 8 OR + EP + Neuro solo', () => {
    expect(headline({ mainORCount: 8, addOnRooms: 0, epLab: true, neuroLab: true, tees: false, soloPri: true })).toMatchInlineSnapshot();
  });
});
```

- [ ] **Step 2: Run to populate + verify the snapshots are sane**

Run: `npm test -- lankenau paoli`
Expected: PASS (Vitest writes the inline snapshots on first run). Open both files and confirm the populated numbers are plausible (e.g. default lankenau has totalMDs/totalCRNAs > 0; severity is one of ok/tight/warning/critical).

- [ ] **Step 3: Commit**

```bash
git add src/lib/staffingCalculator/lankenau.test.ts src/lib/staffingCalculator/paoli.test.ts
git commit -m "Lock staffing-calculator behavior with characterization tests"
```

---

## Task 2: Build `shared.ts` (clamp, severity, break analysis, notes, feasibility)

**Files:**
- Create: `src/lib/staffingCalculator/shared.ts`
- Test: `src/lib/staffingCalculator/shared.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/staffingCalculator/shared.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  clampConfig, severityFor, buildBreakAnalysis, breakCoverageNotes, feasibilityNotes,
} from './shared';
import type { ConfigField, BreakSource } from './types';

describe('severityFor', () => {
  it('maps coverage pct to severity bands', () => {
    expect(severityFor(100)).toBe('ok');
    expect(severityFor(80)).toBe('tight');
    expect(severityFor(60)).toBe('warning');
    expect(severityFor(40)).toBe('critical');
  });
});

describe('clampConfig', () => {
  const schema: ConfigField[] = [
    { key: 'rooms', label: 'Rooms', section: 'x', kind: 'number', defaultValue: 7, min: 0, max: 9 },
    { key: 'flag', label: 'Flag', section: 'x', kind: 'toggle', defaultValue: false },
  ];
  it('clamps numbers into [min,max] and rounds', () => {
    expect(clampConfig(schema, { rooms: 99, flag: true }).rooms).toBe(9);
    expect(clampConfig(schema, { rooms: -5, flag: true }).rooms).toBe(0);
    expect(clampConfig(schema, { rooms: 3.7, flag: true }).rooms).toBe(4);
  });
  it('falls back to default on NaN / missing / non-number', () => {
    expect(clampConfig(schema, { rooms: NaN, flag: false }).rooms).toBe(7);
    expect(clampConfig(schema, {}).rooms).toBe(7);
    expect(clampConfig(schema, { rooms: 'abc' as unknown as number, flag: false }).rooms).toBe(7);
  });
  it('coerces toggles to boolean', () => {
    expect(clampConfig(schema, { rooms: 5, flag: 1 as unknown as boolean }).flag).toBe(true);
    expect(clampConfig(schema, { rooms: 5, flag: 0 as unknown as boolean }).flag).toBe(false);
  });
});

describe('buildBreakAnalysis', () => {
  it('aggregates capacity, gap, pct, severity from sources', () => {
    const sources: BreakSource[] = [
      { label: 'Floats', count: 2, breaks: 10, detail: '2 × 5' },
      { label: 'OB MD', count: 1, breaks: 1, detail: 'between cases' },
    ];
    const a = buildBreakAnalysis(8, sources);
    expect(a.demand).toBe(8);
    expect(a.capacity).toBe(11);
    expect(a.gap).toBe(-3);          // surplus
    expect(a.pct).toBe(100);         // capped at 100
    expect(a.severity).toBe('ok');
    expect(a.unrelieved).toBe(0);
  });
  it('reports a strained band when capacity < demand', () => {
    const sources: BreakSource[] = [{ label: 'Floats', count: 1, breaks: 5, detail: '1 × 5' }];
    const a = buildBreakAnalysis(10, sources);
    expect(a.capacity).toBe(5);
    expect(a.pct).toBe(50);
    expect(a.severity).toBe('warning');
    expect(a.unrelieved).toBe(5);
  });
  it('treats zero demand as 100% covered', () => {
    expect(buildBreakAnalysis(0, []).pct).toBe(100);
    expect(buildBreakAnalysis(0, []).severity).toBe('ok');
  });
});

describe('breakCoverageNotes', () => {
  it('produces the header + per-source + total + severity lines', () => {
    const a = buildBreakAnalysis(8, [{ label: 'Floats', count: 2, breaks: 10, detail: '2 × 5' }]);
    const notes = breakCoverageNotes(a);
    expect(notes[0]).toBe('── BREAK COVERAGE ──');
    expect(notes.some(n => n.includes('Floats'))).toBe(true);
    expect(notes.some(n => n.includes('Total:'))).toBe(true);
    expect(notes.some(n => n.includes('%'))).toBe(true);
  });
});

describe('feasibilityNotes', () => {
  it('warns when planned staff exceed available', () => {
    const notes = feasibilityNotes(10, 20, { mds: 8, crnas: 18 });
    expect(notes.some(n => n.includes('2') && n.toLowerCase().includes('md'))).toBe(true);
    expect(notes.some(n => n.includes('2') && n.toLowerCase().includes('crna'))).toBe(true);
  });
  it('is silent (empty) when the plan fits within available staff', () => {
    expect(feasibilityNotes(8, 16, { mds: 10, crnas: 18 })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- staffingCalculator/shared`
Expected: FAIL — cannot find module `./shared`.

- [ ] **Step 3: Implement `shared.ts`**

Create `src/lib/staffingCalculator/shared.ts`:

```ts
// Shared scaffolding for the per-facility staffing calculators. The facility
// algorithms differ (rooms/ratios/roles), but config clamping, break-analysis
// aggregation, severity thresholds, the break-coverage notes block, and the
// feasibility summary are identical — they live here.

import type {
  AvailableStaff, BreakAnalysis, BreakSource, CalculatorConfig, ConfigField,
} from './types';

export const BREAKS_PER_FLOAT = 5;

type Severity = BreakAnalysis['severity'];

// Coverage-percentage → severity band. One source of truth for the thresholds.
export function severityFor(pct: number): Severity {
  if (pct >= 100) return 'ok';
  if (pct >= 75) return 'tight';
  if (pct >= 50) return 'warning';
  return 'critical';
}

// Coerce + clamp a raw config against its schema: numbers rounded into
// [min,max] (NaN/missing/non-number → defaultValue), toggles → boolean.
// The pure calculate() functions can't trust the UI to have validated input.
export function clampConfig(schema: ConfigField[], cfgIn: CalculatorConfig): CalculatorConfig {
  const out: CalculatorConfig = {};
  for (const f of schema) {
    const raw = cfgIn[f.key];
    if (f.kind === 'toggle') {
      out[f.key] = Boolean(raw);
    } else {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(n)) {
        out[f.key] = f.defaultValue;
      } else {
        const lo = f.min ?? 0;
        const hi = f.max ?? Number.MAX_SAFE_INTEGER;
        out[f.key] = Math.min(hi, Math.max(lo, Math.round(n)));
      }
    }
  }
  return out;
}

// Aggregate break demand + sources into the BreakAnalysis the UI renders.
export function buildBreakAnalysis(demand: number, sources: BreakSource[]): BreakAnalysis {
  const capacity = sources.reduce((sum, s) => sum + s.breaks, 0);
  const gap = demand - capacity;
  const pctRaw = demand > 0 ? Math.round((capacity / demand) * 100) : 100;
  return {
    demand,
    capacity,
    sources,
    gap,
    pct: Math.min(pctRaw, 100),
    severity: severityFor(pctRaw),
    unrelieved: Math.max(0, gap),
  };
}

// The "── BREAK COVERAGE ──" notes block (header + per-source + total + a
// severity line). Returned as an array the facility appends to its notes.
export function breakCoverageNotes(a: BreakAnalysis): string[] {
  const out: string[] = ['── BREAK COVERAGE ──'];
  for (const s of a.sources) {
    out.push(`  ☕ ${s.label}: ${s.breaks} break${s.breaks !== 1 ? 's' : ''} (${s.detail})`);
  }
  out.push(`  📊 Total: ${a.capacity} break slots for ${a.demand} providers needing breaks`);
  const pct = a.pct;
  if (a.severity === 'ok') out.push(`  ✅ Coverage sufficient (${pct}%).`);
  else if (a.severity === 'tight') out.push(`  ⚠️ Coverage tight (${pct}%). Some breaks may be delayed.`);
  else if (a.severity === 'warning') out.push(`  🔴 Coverage strained (${pct}%). ${a.unrelieved} providers may not get timely breaks.`);
  else out.push(`  🚨 CRITICAL (${pct}%). ${a.unrelieved} providers will not get breaks without pulling coverage.`);
  return out;
}

// Additive feasibility summary: warn when the plan needs more staff than are
// available. Empty array when the plan fits.
export function feasibilityNotes(
  totalMDs: number, totalCRNAs: number, avail: AvailableStaff,
): string[] {
  const out: string[] = [];
  const mdOver = totalMDs - avail.mds;
  const crnaOver = totalCRNAs - avail.crnas;
  if (mdOver > 0) out.push(`🚨 Plan needs ${mdOver} more MD${mdOver !== 1 ? 's' : ''} than available (${totalMDs} planned / ${avail.mds} available).`);
  if (crnaOver > 0) out.push(`🚨 Plan needs ${crnaOver} more CRNA${crnaOver !== 1 ? 's' : ''} than available (${totalCRNAs} planned / ${avail.crnas} available).`);
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- staffingCalculator/shared`
Expected: PASS (all describes).

- [ ] **Step 5: Commit**

```bash
git add src/lib/staffingCalculator/shared.ts src/lib/staffingCalculator/shared.test.ts
git commit -m "Add shared staffing-calculator scaffolding (clamp/severity/breaks/feasibility)"
```

---

## Task 3: Refactor `lankenau.ts` onto the shared module

**Files:**
- Modify: `src/lib/staffingCalculator/lankenau.ts`

- [ ] **Step 1: Apply the refactor**

In `src/lib/staffingCalculator/lankenau.ts`:
- Add `import { clampConfig, buildBreakAnalysis, breakCoverageNotes, feasibilityNotes, BREAKS_PER_FLOAT } from './shared';`
- At the top of `calculateLankenau`, replace the manual coercion with a clamp pass. Change the `const cfg = { mainOR: Number(cfgIn.mainOR ?? 0), ... }` block so it reads from a clamped config: `const clamped = clampConfig(SCHEMA, cfgIn);` then build the typed `cfg` from `clamped` (e.g. `mainOR: Number(clamped.mainOR), ... epTEE: Boolean(clamped.epTEE), ...`). Keep the typed `cfg` object shape.
- Replace `const bkFloats = floats.length * 5;` with `const bkFloats = floats.length * BREAKS_PER_FLOAT;`
- Replace the entire break-analysis construction block (the `const breakAnalysis = { demand: ..., severity: (breakPct >= 100 ? ...) ..., unrelieved: ... }` object literal, currently around lines 402-410) with:
  ```ts
  const breakAnalysis = buildBreakAnalysis(breakDemand, breakSources);
  ```
  (Delete the now-unused local `breakCapacity`, `breakGap`, `breakPct` computations ONLY if they are not referenced elsewhere — note `breakSources` still needs `breakCapacity`? No: `buildBreakAnalysis` computes capacity from sources. But the `breakSources` array construction references `breakCapacity`? It does NOT. Keep the `breakSources` array build and the `provNeedingBreaks`/`breakDemand` computation; remove `breakCapacity`/`breakGap`/`breakPct` locals.)
- Replace the block that pushes the break-coverage notes (the `notes.push('── BREAK COVERAGE ──'); breakSources.forEach(...); notes.push('  📊 Total...'); if (severity...) ...` lines, around 412-418) with:
  ```ts
  notes.push(...breakCoverageNotes(breakAnalysis));
  ```
- Just before the `return`, add the feasibility note (additive): after computing `mds`/`crnas`, append `notes.push(...feasibilityNotes(mds.length, crnas.length, avail));`

- [ ] **Step 2: Run the characterization + shared tests**

Run: `npm test -- lankenau`
Expected: PASS — the characterization headline snapshots are UNCHANGED (the refactor preserved behavior). The feasibility note is additive (it adds notes only when over-allocated; the `headline()` characterization asserts scalar totals + breakAnalysis, NOT the notes array, so it stays green). If a snapshot value changed, the refactor altered behavior — fix the refactor, do NOT update the snapshot.

Run: `npx tsc --noEmit 2>&1 | grep -E "lankenau" || echo "no lankenau type errors"`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/staffingCalculator/lankenau.ts
git commit -m "Refactor Lankenau calculator onto shared scaffolding"
```

---

## Task 4: Refactor `paoli.ts` onto the shared module

**Files:**
- Modify: `src/lib/staffingCalculator/paoli.ts`

- [ ] **Step 1: Apply the refactor**

In `src/lib/staffingCalculator/paoli.ts`, mirror Task 3:
- Add `import { clampConfig, buildBreakAnalysis, breakCoverageNotes, feasibilityNotes, BREAKS_PER_FLOAT } from './shared';`
- Replace the manual coercion `const cfg = { mainORCount: Number(cfgIn.mainORCount ?? 0), ... }` with `const clamped = clampConfig(SCHEMA, cfgIn);` then build the typed `cfg` from `clamped`.
- Replace `const bkFloats = totalFloats * 5;` with `const bkFloats = totalFloats * BREAKS_PER_FLOAT;`
- Replace the `const breakAnalysis = { demand: ..., severity: (...), unrelieved: ... }` object (around lines 352-360) with `const breakAnalysis = buildBreakAnalysis(breakDemand, breakSources);` and delete the now-unused `breakCapacity`/`breakGap`/`breakPct` locals (note paoli already computes `breakCapacity` via `breakSources.reduce(...)` — remove it; `buildBreakAnalysis` does that).
- Replace the break-coverage notes push block (lines ~362-368) with `notes.push(...breakCoverageNotes(breakAnalysis));`
- Before the `return`, append `notes.push(...feasibilityNotes(mds.length, crnas.length, avail));`

- [ ] **Step 2: Run tests**

Run: `npm test -- paoli`
Expected: PASS — characterization snapshots unchanged.
Run: `npx tsc --noEmit 2>&1 | grep -E "paoli" || echo "no paoli type errors"`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/staffingCalculator/paoli.ts
git commit -m "Refactor Paoli calculator onto shared scaffolding"
```

---

## Task 5: Full verification + LOC check

**Files:**
- Verify only.

- [ ] **Step 1: Full suite + typecheck + build**

Run: `npm test && npx tsc --noEmit && npm run build`
Expected: all tests pass (engine + calculator characterization + shared); tsc clean; production build succeeds.

- [ ] **Step 2: Confirm duplication is gone**

Run: `grep -n "BREAK COVERAGE" src/lib/staffingCalculator/lankenau.ts src/lib/staffingCalculator/paoli.ts`
Expected: NO matches (the literal string now lives only in `shared.ts`).
Run: `grep -n "breakPct >= 100" src/lib/staffingCalculator/*.ts`
Expected: NO matches in lankenau/paoli (the severity ternary is now only `severityFor` in shared.ts).

- [ ] **Step 3: Commit (only if a verification fix was needed)**

```bash
git add <fixed files>
git commit -m "Fix calculator shared-engine verification issues"
```

---

## Self-Review (completed during planning)

**Spec coverage:**
- Duplication removal (break analysis, severity, notes, ×5 magic number) → Tasks 2 (shared) + 3/4 (refactor); verified gone in Task 5. ✓
- Input validation/clamping (review finding) → `clampConfig` (Task 2) wired in Tasks 3/4. ✓
- Feasibility / over-allocation warning (review finding) → `feasibilityNotes` (Task 2), additive in Tasks 3/4. ✓
- Behavior preservation → characterization tests locked FIRST (Task 1), asserted unchanged after each refactor. ✓
- Registry/data-driven structure already exists (`FacilityCalculator`) — not re-litigated; the shared module makes adding a facility lighter (no copy-paste of break logic). ✓

**Placeholder scan:** No TBD/placeholder steps. The one Vitest-populated-snapshot step (Task 1) is an explicit "run to populate then verify sane" instruction, not a placeholder. All shared.ts code is complete.

**Type consistency:** `clampConfig(schema, cfg)`, `severityFor(pct)`, `buildBreakAnalysis(demand, sources)`, `breakCoverageNotes(analysis)`, `feasibilityNotes(totalMDs, totalCRNAs, avail)`, `BREAKS_PER_FLOAT` defined once in Task 2 and consumed identically in Tasks 3/4. Uses existing `BreakAnalysis`/`BreakSource`/`ConfigField`/`AvailableStaff`/`CalculatorConfig` from `types.ts`.
