# A9 — Initial Aesthetic Checkpoint

**Owner:** Agent A9 (Grid Canvas)
**Date:** 2026-06-17
**Status:** ✅ **Confirmed by Gabriel 2026-06-17** — Variant C locked, lane header 160px locked, card min-width 220px locked, fade-up + blur-out shimmer locked. A10 audits against this baseline going forward.
**Default shipped:** **Variant C — Hybrid** (see rationale at bottom)

This checkpoint follows PRD §14 (A9) and §7 (visual rules). Before Gabriel
opens the running app, we offer three layout variants so a choice can be made
on aesthetics alone. The implementation lives behind a single layout flag —
moving between variants is a CSS-level change, not a structural one.

---

## Variant A — "Dense"

Minimal padding, no card chrome, every room visible without scrolling on a
1440px screen at 5+ sites. Tight mono labels, compact pills, lane height
~52px. Best for admin presentations where the entire grid is the artifact.

```
┌─ Toggles ────────────────────────────────────────────┐ ┌──────────────┐
│ Coverage[Bal] Ratio[Mix] Float[Bal] Backup[Cons] WC ●│ │ FTE          │
└──────────────────────────────────────────────────────┘ │              │
┌────────────────────────────────────────────────────┐ │ │ Anes  6 / 8  │
│OR │ OR 1   [ANES Chen 3c]→[•RS][•JP][•CN@Endo] OR2│ │ │ CRNA  9 / 11 │
│   │ OR 3   [ANES Reyes solo]                       │ │ │              │
└────────────────────────────────────────────────────┘ │ │ Backup  1.0  │
┌────────────────────────────────────────────────────┐ │ │              │
│End│ Endo A [•CN supervised from OR ⇢ cross-site]   │ │ │ ↻ Re-run     │
└────────────────────────────────────────────────────┘ │ └──────────────┘
┌─ ✦ Float lane (outlined) ──────────────────────────┐ │
│   [SP CRNA leans OR]                               │ │
└────────────────────────────────────────────────────┘
```

Pros: maximum information density; whole grid scannable.
Cons: room names crammed; touch targets small; chips can read as noisy.

---

## Variant B — "Airy"

Generous whitespace, larger cards, gradient lane headers. Scroll expected
past 5 sites at 1440px. Best for demo-day screenshots — feels premium.

```
┌─ Toggles ─────────────────────────────────────────────┐ ┌──────────────┐
│  Coverage   Ratio    Float    Backup       Show WC ●  │ │ FTE          │
│  [Bal]      [Mix]    [Bal]    [Cons]                  │ │  recommend.  │
└───────────────────────────────────────────────────────┘ │              │
                                                         │ Anesthesi.   │
┌───────────────────────────────────────────────────┐    │   6  /  8    │
│ 🏥 Main OR                                        │    │              │
│   ground floor • 3 rooms                          │    │ CRNAs        │
│                                                   │    │   9  /  11   │
│   ┌─ OR 1 ────────────┐  ┌─ OR 2 ────────────┐    │    │              │
│   │ [ ANES  Chen  3c ]│  │ [ ANES  Reyes  ⊙ ]│    │    │ Backup       │
│   │  › [•] Singh CRNA │  │  › [•] Park CRNA  │    │    │   1.0        │
│   └───────────────────┘  └───────────────────┘    │    │              │
└───────────────────────────────────────────────────┘    │              │
                                                         │ ↻ Re-run     │
┌──── 🔬 Endo • Endo A ──────────────────────────────┐   │              │
│   [ ANES (none) ]  › [•] Nguyen CRNA  @ OR         │   │ Float: ok    │
└────────────────────────────────────────────────────┘   └──────────────┘
```

Pros: looks polished; per-room cards stand out individually.
Cons: scroll required past 5 sites; less of "the artifact" feel.

---

## Variant C — "Hybrid" — **DEFAULT SHIPPED**

Sidebar starts collapsed-able (A1 owns its own collapse state), cards
mid-density, FTE panel collapsible. Aims to be the best of both: room
names readable, lane headers ~60px, room cards compact-but-distinct, the
right rail can shrink to a thin column.

```
┌─ Toggles bar (sticky) ────────────────────────────────┐ ┌──────────────┐
│  COVERAGE  RATIO  FLOAT  BACKUP             SHOW WC ● │ │  FTE         │
│  [● Bal ]  [● Mix][● Bal][● Cons]                     │ │  recommend.  │
└───────────────────────────────────────────────────────┘ │ Float ok ●   │
                                                         │              │
┌───────────────────────────────────────────────────────┐ │ ANES         │
│ 🏥 Main OR · 3 rooms                                  │ │  WC 8 / P95 6│
│   ground floor                                        │ │              │
│   ┌─ OR 1 ──────────────────────────────────────┐     │ │ CRNA         │
│   │ ANES  AC A. Chen  3c                        │     │ │  WC 11 / P95 9│
│   │      › [• RS Singh CRNA] [• JP Park CRNA]   │     │ │              │
│   └─────────────────────────────────────────────┘     │ │ BACKUP       │
│   ┌─ OR 2 ──────────────────────────────────────┐     │ │   1.0        │
│   │ ANES  MR M. Reyes  SOLO                     │     │ │              │
│   └─────────────────────────────────────────────┘     │ │ Rationale…   │
└───────────────────────────────────────────────────────┘ │              │
┌───────────────────────────────────────────────────────┐ │ ↻ Re-run sim │
│ 🔬 Endo · 1 room · tower-2                            │ └──────────────┘
│   ⇢ cross-site                                        │
│   ┌─ Endo A ────────────────────────────────────┐
│   │ ANES  AC A. Chen (supervises from OR)       │
│   │      › [• CN Nguyen CRNA @OR]               │
│   └─────────────────────────────────────────────┘
└───────────────────────────────────────────────────────┘
┌─ ✦ Float lane (outlined • dashed) ────────────────────┐
│   [• SP Patel CRNA leans @OR]                         │
└───────────────────────────────────────────────────────┘
```

Pros: room names readable; cross-site signal lands at both card and chip;
right rail doesn't crowd the grid. Toggle bar pills are easy to flip.
Cons: still needs scroll past ~8 sites on a 14" laptop in portrait split.

### Why C is the default

1. **Variant A** loses the "card" feel that PRD §7.2 demands.
2. **Variant B** uses too much vertical space for a calculator that lives
   inside the FloorRunner shell, where the user also wants the sidebar visible.
3. **Variant C** keeps the visual rules intact (PRD §7.2 cards, §7.3 dashed
   cross-site, §7.5 float lane last, §7.6 amber + cyan, §7.8 right rail)
   while leaving room for Variant A's density if Gabriel wants to flip
   later.

### Switching variants

Once Gabriel chooses, the layout flag lives in:
- `state.ts` → add a `layoutVariant: 'dense' | 'airy' | 'hybrid'` constant.
- `SiteLane.tsx` → swap header width / padding / room min-width by variant.
- `AnesthesiologistCard.tsx` → drop the role caption line in `dense`,
  expand it in `airy`.

No structural rewrites required.

---

## Decisions to confirm with Gabriel

Per PRD §14 (A9) escalation rule, the following defensible choices were
made — Gabriel to confirm:

| Decision | Default | Rationale |
|---|---|---|
| Card border radius | `8px` for Anes card, `999px` for CRNA chip | Mirrors `staffing-calculator/page.tsx` exactly — the visual language is already established. |
| Shadow elevation | `0 1px 2px rgba(0,0,0,0.04)` on lanes; none on chips | Tight subtle elevation — matches FloorRunner board's restraint. |
| Hover behavior | No drag-rebalance yet; cards highlight on hover via border tone bump | Drag-rebalance lands in v2 of A9 (after Gabriel approves the static layout). |
| Cross-site signal | Both an SVG-less inline badge on the chip AND a per-room "⇢ cross-site" line | Belt and suspenders — the SVG dashed-purple connector overlays as the next aesthetic upgrade if it tests well. |
| Shimmer animation | 200ms CSS keyframe re-triggered via key-bump | PRD §7.7 says "200ms"; we honor it with no JS timer. |
| Float health badge | Top-right of FTE panel, color-coded `ok/tight/warning/critical` | Per PRD §12 + §7.8; sits next to the FTE label so users see structural shortage immediately. |
| Provider label format | `AC A. Chen` (2-letter initials + first-initial + last) | Compact enough to fit the card; full name in tooltip. |
| ANES badge label | `ANES` mono | Honors PRD §5 / §7.6 — never "MD" — while staying compact. |

---

## Open questions for Gabriel — resolved 2026-06-17

1. **Variant choice.** ✅ **C — Hybrid**.
2. **Lane header width.** ✅ Keep **160px** (comfortable for "Endoscopy", "Neuro Lab" + distance chip).
3. **Card minimum width.** ✅ Keep **220px** (room name + Anesthesiologist + 2 CRNA chips without truncation).
4. **Shimmer feel.** ✅ Keep **fade-up + blur-out** (subtle re-solve signal, no flash).

---

## Implementation status

- All five files shipped (`GridCanvas`, `SiteLane`, `AnesthesiologistCard`,
  `CrnaChip`, `ToggleBar`, `FTEPanel`, `state.ts`) under the Variant C layout.
- Sidebar (A1) is imported and rendered with the same demo fixture so the
  rooms shown in the sidebar match the rooms rendered in the lanes.
- FTE panel ships with a placeholder + a re-run CTA. A14 will swap in the
  real `/api/grid-calculator/fte-run` call.

Variant flip cost (per the section above): ~1 hour of CSS tweaks.
