# A9 Fix Pass — 2026-06-17

Follow-up to `docs/code-reviews/2026-06-17-initial.md`. A9 owned 1 ERROR and 2
WARNs; all three are now fixed inside A9's territory
(`src/app/(scheduling)/grid-calculator/{page.tsx,ToggleBar.tsx,state.ts}`).

## Changes landed

1. **page.tsx stub types (ERROR).** Replaced the bare `() => {}` stubs for
   `onAddRoom`, `onChangeBand`, and `onToggleSupervisable` with explicitly typed
   arrow functions that mirror Sidebar's `SidebarProps` signatures
   (`(siteId: string) => void`, `(siteAId, siteBId, band: DistanceBand) => void`,
   `(siteAId, siteBId, next: boolean) => void`). Added a `type` import for
   `DistanceBand` from `@/lib/gridCalculator/types`. Parameters are `void`-ed
   inside the body so the TODO bodies stay no-op without unused-arg lint noise.
   Future Sidebar signature changes will now break the build instead of silently
   discarding args.

2. **ToggleBar label (WARN).** `Anes-heavy` → `Anesthesiologist-heavy`. The
   internal enum `value: 'md_heavy'` is unchanged (PRD §5 allows internal
   identifiers to use the legacy `md_`/`crna_` prefixes). The toggle group's
   `description` (line 32, `'Bias toward solo Anesthesiologist vs supervised
   CRNA rooms'`) was already PRD-compliant and is unchanged.

3. **state.ts hospital literal (WARN).** `hospital: 'Paoli (demo)'` →
   `hospital: 'Demo Hospital'`. The fixture identifier `DEMO_PAOLI_FIXTURE`
   stays (it's an internal symbol, not user-visible). A11's Paoli seed loader
   will overwrite the entire `config` object when it ships, so the rendered
   string only matters for the demo path.

## Verification

- `npx tsc --noEmit` — clean.
- `npm run build` — clean. `/grid-calculator` is prerendered statically at
  16.2 kB / 103 kB first-load JS, unchanged from baseline.
- `npx tsx scripts/aesthetic-audit.ts` — 0 findings across 10 rules.
- The audit script's `rule-7.5-labels-canonical` rule scans for `["MD",
  "MD-heavy", "Physician"]`. The new `"Anesthesiologist-heavy"` does not match
  any of those, so no audit churn was needed.

## Note for A10 (aesthetic baseline + audit script owner)

Neither `docs/aesthetic-reviews/baseline.json` nor `scripts/aesthetic-audit.ts`
references the old `"Anes-heavy"` label string, so no update was strictly
required and I did not touch A10's files.

However, on A10's next run, consider hardening the `rule-7.5-labels-canonical`
rule to forbid the standalone contraction `"Anes"` (not `"ANES"` — that's the
allowed role badge token per the same rule). Today the rule only forbids `"MD"`,
`"MD-heavy"`, and `"Physician"`. A future agent typing `"Anes-heavy"` or
`"Anes."` would re-introduce the same PRD §7.5 violation the code review caught
manually. A safe addition:

```diff
   "forbiddenJsxText": ["MD", "MD-heavy", "Physician"],
+  "forbiddenJsxText": ["MD", "MD-heavy", "Physician", "Anes-"],
```

(Using `"Anes-"` with the trailing dash avoids false positives on the canonical
`"Anesthesiologist"` and `"Anesthesia Coverage Grid Calculator"` strings, since
both spell the word out without a dash.)

Owner decision — not blocking A9.
