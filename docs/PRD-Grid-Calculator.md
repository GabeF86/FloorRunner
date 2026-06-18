# PRD — Anesthesia Coverage Grid Calculator

**Project codename:** Grid Calculator
**Owner:** Gabriel Farkas, MD
**Build target:** New module inside FloorRunner at `src/app/(scheduling)/grid-calculator`
**Status:** Draft v1.1
**Last updated:** 2026-06-17

---

## 1. One-paragraph problem statement

Hospital administrators ask anesthesia groups a deceptively simple question: *"How many anesthesiologists and CRNAs do we actually need to hire to safely staff this contract?"* Today the answer is an experience-based guess pieced together from spreadsheets, call schedules, and tribal knowledge. The Grid Calculator turns that question into a transparent, visual artifact: enter the contracted anesthetizing locations, a free-text description of how the department covers them, the desired coverage style, and leave-rate assumptions; the system returns a daily coverage grid, a recommended FTE headcount for Anesthesiologists and CRNAs, a fair call distribution, and a backup-call FTE allocation — all defensible to hospital leadership.

## 2. Goals

1. **Universal.** Any anesthesia group can onboard a new hospital in under 30 minutes by adding sites, rooms, distance markers, free-text guidelines, and a leave-rate profile. No code changes per hospital.
2. **Visual-first.** The grid is the artifact. Sites are columns/lanes, rooms are cells, Anesthesiologist cards supervise CRNA cards within and across sites. The grid is admin-presentable without further translation.
3. **Toggle-driven exploration.** Single-click toggles flip the staffing model between MD-heavy / CRNA-heavy / balanced, and between 1:3 / 1:4 / mixed supervision ratios, and the grid re-solves instantly.
4. **Claude as the staffing reasoner.** Free-text department guidelines are normalized by Claude (server-side Anthropic SDK) into a structured rule set the solver consumes. New rules added in plain English; no code change.
5. **Leave-aware FTE recommendation.** Output a concrete FTE headcount for Anesthesiologists, CRNAs, and backup-call coverage that accounts for PTO, sick, FMLA, post-call vacancies, and weekend/holiday call burden, presented as both worst-case deterministic and Monte Carlo expected-value.
6. **Float-aware.** The solver knows when to spend a float CRNA on breaks vs. trauma vs. add-ons, and surfaces float utilization in the grid.

## 3. Non-goals (v1)

- No real-time floor management — that lives in the existing Floor Runner board.
- No EMR integration, no case-volume forecasting from surgical history (that's v2+).
- No payroll, no compliance documentation, no certification tracking.
- No multi-tenant auth beyond what FloorRunner already provides.

## 4. Users & personas

| Persona | Goal | What they touch |
|---|---|---|
| **Group medical director** | "Justify our staffing model to the hospital." | Toggles, free-text guidelines, exports. |
| **Scheduler / chief CRNA** | "Validate that the grid matches how we actually work." | Sites, rooms, distance matrix, guidelines. |
| **Hospital administrator** | "How many FTEs do you actually need?" | Final FTE recommendation card + visual grid. |
| **Gabriel (you)** | "Approve aesthetics + answer anesthesia-specific questions." | Visual review, occasional rule clarification. |

## 5. Glossary (lock the language early)

- **Site** — a logical anesthetizing location with ≥1 rooms (Main OR, Endo, Neuro Lab, EP Lab, OB, Cath, GI, Robotics, IR, etc.).
- **Room** — a single anesthetizing location within a site.
- **Anesthesiologist** — physician (replace all UI references to "MD" with "Anesthesiologist"; internal types may keep `physician` for FloorRunner compatibility but the rendered chip label is always "Anesthesiologist").
- **CRNA** — Certified Registered Nurse Anesthetist. UI label always "CRNA".
- **Supervision link** — a logical pairing between one Anesthesiologist and 1–4 CRNAs.
- **Coverage style** — `md_heavy | crna_heavy | balanced` toggle that biases the solver toward solo-MD rooms vs. supervised-CRNA rooms.
- **Supervision ratio mode** — `mostly_1_3 | mostly_1_4 | mixed` toggle.
- **Float** — a provider not assigned to a fixed room; consumed by breaks, lunches, add-ons, and emergencies.
- **Backup call** — non-primary call coverage activated when primary call-taker is exhausted or doubled.
- **Post-call** — provider just off 24-hour call; ineligible to work the next clinical day per house rules.
- **Leave bucket** — any reason a provider is unavailable: `pto | sick | fmla | maternity | cme | post_call | jury_duty`.
- **FTE** — 1.0 = full-time equivalent. Fractional FTEs (0.5, 0.6, 0.8) allowed.

## 6. Architecture overview

```
┌────────────────────────────────────────────────────────────┐
│  /grid-calculator (Next.js route, client-heavy)            │
│  ┌──────────────┐  ┌──────────────────────────────────┐   │
│  │  Sidebar     │  │   Grid Canvas                    │   │
│  │  Sites/Rooms │  │   (lanes, cards, supervision     │   │
│  │  Add/edit    │  │    arrows, drag-rebalance)       │   │
│  │  Distance    │  └──────────────────────────────────┘   │
│  │  matrix      │  ┌──────────────────────────────────┐   │
│  │              │  │   Coverage Toggle Bar            │   │
│  └──────────────┘  │   Style • Ratio • Float strategy │   │
│  ┌──────────────┐  └──────────────────────────────────┘   │
│  │ Guidelines   │  ┌──────────────────────────────────┐   │
│  │ Free-text    │  │   FTE Recommendation Panel       │   │
│  │ (Claude      │  │   Worst case | Monte Carlo       │   │
│  │  parses)     │  │   Anesthesiologist | CRNA | BC   │   │
│  └──────────────┘  └──────────────────────────────────┘   │
└────────────────────────────────────────────────────────────┘
                │
                ▼
┌────────────────────────────────────────────────────────────┐
│  src/lib/gridCalculator/                                   │
│  ├── solver.ts           — deterministic single-day solver │
│  ├── rulesNormalizer.ts  — Anthropic SDK wrapper           │
│  ├── distanceMatrix.ts   — adjacency + "supervisable from" │
│  ├── floatStrategy.ts    — float allocation policy         │
│  ├── callBurden.ts       — fair call + backup distribution │
│  ├── fteSimulator.ts     — 365-day Monte Carlo + worst case│
│  ├── seeds/paoli.ts      — Paoli seed data                 │
│  └── types.ts            — shared interfaces               │
└────────────────────────────────────────────────────────────┘
                │
                ▼
┌────────────────────────────────────────────────────────────┐
│  Supabase (scheduling schema, additive migrations)         │
│  ├── grid_calculator_configs                               │
│  ├── grid_calculator_guidelines (free text + parsed JSON)  │
│  ├── grid_calculator_distances                             │
│  └── grid_calculator_fte_runs (simulator output history)   │
└────────────────────────────────────────────────────────────┘
```

## 7. Visual design principles

These are the visual rules to apply consistently. Aesthetic decisions surface back to Gabriel; everything else the agents own.

1. **Lanes over tables.** Each site is a horizontal lane. The lane left edge carries the site name, icon, color accent, and a small distance indicator (e.g. "near OR" / "↔ 200ft").
2. **Cards over text.** Anesthesiologist = larger rectangular card with role badge + supervision count. CRNA = smaller pill nested under or visually linked to its supervisor.
3. **Cross-site supervision = dashed link.** When an Anesthesiologist supervises a CRNA at a different site, draw a dashed connector with the destination site name as a small badge.
4. **Float lane is always last.** Pinned at the bottom. Floats render as outlined cards (not solid) to read as "unassigned but available".
5. **Labels.** Always "Anesthesiologist" and "CRNA" in the rendered UI. Internal types may keep existing `physician`/`crna` enums for FloorRunner type compatibility.
6. **Color usage.** Inherit FloorRunner's existing palette (Anesthesiologist: amber #f59e0b family; CRNA: cyan #0ea5e9 family). New states: dashed-purple for cross-site supervision, dashed-gray for float, red border for over-ratio violations.
7. **Toggle bar is sticky** at the top of the canvas; the grid re-solves with a 200ms shimmer animation so changes are obvious.
8. **FTE panel never moves.** Persistent right-rail card with three numbers: Anesthesiologists, CRNAs, Backup-call FTE. Each number has a "Worst case / Expected" tab.

## 8. Coverage toggles (the heart of the UX)

| Toggle | Values | Effect on solver |
|---|---|---|
| Coverage style | `md_heavy` / `balanced` / `crna_heavy` | Adjusts weight in the room-staffing decision: bias toward solo-MD or supervised-CRNA. |
| Supervision ratio | `mostly_1_3` / `mostly_1_4` / `mixed` | Sets the target average CRNAs-per-Anesthesiologist. `mixed` accepts up to 1:4 but prefers 1:3 when distance allows. |
| Float strategy | `break_priority` / `emergency_priority` / `balanced` | Tells the float allocator how to reserve capacity. |
| Backup call posture | `aggressive` / `conservative` | Aggressive = more partial-FTE backup providers, fewer per-person nights. Conservative = fewer dedicated backups, higher individual burden. |
| Show worst case | on / off | FTE panel collapses to expected-value only when off. |

All toggle state lives in URL query params so a configuration is shareable as a link.

## 9. Free-text guidelines → normalized rules

The page exposes a **Guidelines** textarea that accepts plain English. On save, the server-side normalizer:

1. POSTs the text + the site list + the provider profile schema to Anthropic API (`claude-opus-4-7` for v1; downshift to `claude-sonnet-4-6` once stable).
2. Uses **prompt caching** on the system prompt (the rule schema + few-shot examples) — should stay ≥80% cache hit rate.
3. Returns a JSON `CoverageRuleSet` matching `src/lib/gridCalculator/types.ts → CoverageRuleSet`.
4. Persists both the raw text and the parsed JSON to `grid_calculator_guidelines`. Both are shown in the UI side-by-side so users can see what Claude understood.
5. Any parse failure surfaces inline: "I couldn't interpret this sentence — can you rephrase?" with the offending span highlighted.

**Example input:**
> "Endo is usually solo coverage by an Anesthesiologist. OB is usually staffed by a solo Anesthesiologist and when not busy can help with breaks. EP and Neuro labs are CRNAs supervised cross-site by a Main OR Anesthesiologist. We never supervise more than 1:3 at OB."

**Example normalized output (excerpt):**
```json
{
  "siteRules": [
    { "site": "Endo", "defaultStaffing": "solo_md", "fallbacks": ["supervised_md_crna"] },
    { "site": "OB", "defaultStaffing": "solo_md", "auxiliaryRole": "break_relief", "maxSupervisionRatio": "1:3" },
    { "site": "EP Lab", "defaultStaffing": "supervised_md_crna", "supervisorFromSite": "Main OR" },
    { "site": "Neuro Lab", "defaultStaffing": "supervised_md_crna", "supervisorFromSite": "Main OR" }
  ],
  "globalRules": []
}
```

## 10. FTE-demand simulator

Two outputs, both shown side by side per the user's preference:

### Worst-case deterministic
- Holds out one provider for maternity (12 weeks).
- Adds a fixed 15% same-day call-out rate among CRNAs, 8% among Anesthesiologists.
- Forces 2 simultaneous PTOs (one Anesthesiologist, one CRNA).
- Forces 1 post-call vacancy each weekday.
- The solver must still produce a complete grid; the FTE recommendation is the minimum headcount that satisfies this every weekday in the year.

### Monte Carlo over 365 simulated days
- PTO weeks per provider sampled from `pto_weeks` profile field.
- Sick/personal call-outs sampled from a per-role Poisson rate (defaults: 3 per CRNA per year, 1.5 per Anesthesiologist; configurable).
- FMLA / maternity sampled from a per-cohort probability.
- Weekends, holidays, and post-call windows generated from the year calendar.
- 1,000 trials. Report median FTE and 95th-percentile FTE.
- The recommended FTE = max(worst case, p95 of Monte Carlo). User can see both numbers; the recommendation explains the binding constraint.

Output schema:
```ts
interface FTERecommendation {
  anesthesiologist: { worstCase: number; p50: number; p95: number; binding: 'worst_case' | 'monte_carlo' };
  crna:             { worstCase: number; p50: number; p95: number; binding: 'worst_case' | 'monte_carlo' };
  backupCall:       { fte: number; distribution: Array<{ providerId: string; fteShare: number }> };
  rationale: string; // human-readable explanation generated by Claude
}
```

## 11. Call burden & backup-call allocator

- Inputs: roster (or recommended FTE if no roster yet), per-provider `call_taker` and `backup_call_eligible` flags, FTE values, weekend/holiday eligibility, max consecutive calls.
- Algorithm: FTE-weighted greedy with min-max fairness (same family as `autoGenerate.ts`'s slot allocator). Each provider's annual call count is bounded by `round(annual_call_slots × fte_share)`.
- Output: per-provider annual call count, per-provider backup-call FTE share (`backupCall.distribution`), and a fairness Gini coefficient surfaced as a small chip.

## 12. Float strategy module

Encodes the user's stated need: "use floats efficiently for breaks, lunches, emergency / add scenarios." The float strategy decides, given a day's grid:

- How many float CRNAs and float Anesthesiologists to position.
- Which site each float "leans toward" (proximity-weighted using the distance matrix).
- A break-coverage feasibility score (taking from Paoli's existing severity bands: ok / tight / warning / critical) per day in the simulation.

If feasibility drops below `tight` more than 10% of simulated days, the FTE recommendation bumps up by 1 float CRNA and re-simulates.

## 13. Data model (additive Supabase migrations)

```sql
-- scheduling.grid_calculator_configs
id UUID PRIMARY KEY,
hospital TEXT NOT NULL,
name TEXT NOT NULL,
coverage_style TEXT,
supervision_ratio TEXT,
float_strategy TEXT,
backup_call_posture TEXT,
created_by UUID,
created_at TIMESTAMPTZ,
updated_at TIMESTAMPTZ

-- scheduling.grid_calculator_guidelines
id UUID PRIMARY KEY,
config_id UUID REFERENCES grid_calculator_configs(id) ON DELETE CASCADE,
raw_text TEXT NOT NULL,
parsed_rules JSONB NOT NULL,
parsed_at TIMESTAMPTZ,
model_id TEXT,                 -- which Claude model parsed it
prompt_cache_hit BOOLEAN

-- scheduling.grid_calculator_distances
id UUID PRIMARY KEY,
config_id UUID REFERENCES grid_calculator_configs(id) ON DELETE CASCADE,
site_a UUID REFERENCES sites(id),
site_b UUID REFERENCES sites(id),
distance_band TEXT CHECK (distance_band IN ('same_room','adjacent','near','far','off_campus')),
supervisable BOOLEAN  -- derived from band but stored so admins can override

-- scheduling.grid_calculator_fte_runs
id UUID PRIMARY KEY,
config_id UUID REFERENCES grid_calculator_configs(id) ON DELETE CASCADE,
ran_at TIMESTAMPTZ,
worst_case JSONB,
monte_carlo JSONB,             -- includes trials_count, percentiles, samples
recommendation JSONB,
rationale TEXT
```

All extend `scheduling` schema. RLS mirrors existing scheduling tables.

## 14. The Agent Fleet — build orchestration

This project is built almost entirely by a fleet of specialized agent loops. Gabriel's involvement is restricted to:
- Aesthetic decisions (color, spacing, density, animation feel).
- Anesthesia staffing questions where the agents flag ambiguity.
- Final acceptance of FTE recommendations against intuition.

Each agent has a **charter** (what it owns), **inputs**, **outputs**, **loop cadence** (one-shot, on-PR, nightly, weekly), and **escalation triggers** (when it must ask Gabriel a question instead of guessing). Agents run via Claude Code; cron loops via the `schedule` skill, recurring tasks via the `loop` skill, parallel work via the `Agent` tool with explicit `subagent_type`.

### Tier 1 — Foundation agents (Week 1, parallel)

#### A1. Site Architect
- **Charter:** Owns the Universal Site model — Site, Room, Distance Matrix — and the sidebar UI for editing them.
- **Inputs:** PRD §6, §13, existing FloorRunner `sites` table.
- **Outputs:** `src/lib/gridCalculator/types.ts` (Site/Room types), the `grid_calculator_distances` migration, the sidebar component at `src/app/(scheduling)/grid-calculator/Sidebar.tsx`.
- **Loop:** one-shot for initial scaffolding, then on-PR review loop.
- **Escalation:** if it can't decide a default distance band ontology, asks Gabriel.

#### A2. Provider Profile Agent
- **Charter:** Extends provider profile schema with the leave-bucket and backup-call fields Grid Calculator needs.
- **Inputs:** `supabase_scheduling_schema.sql`, all `supabase_scheduling_patch*.sql`, PRD §5, §13.
- **Outputs:** A new migration `supabase_scheduling_patch15_provider_leave_buckets.sql` (patch14 is reserved for A1), updated TypeScript types in `src/lib/gridCalculator/providerProfile.ts`.
- **Loop:** one-shot, then on-PR.
- **Escalation:** if it would conflict with an existing column, freeze and ask Gabriel.

#### A3. Coverage Algorithm Agent
- **Charter:** Owns the deterministic single-day solver at `src/lib/gridCalculator/solver.ts`. Consumes a `CoverageRuleSet` + toggle state + roster snapshot, returns a grid assignment.
- **Inputs:** PRD §7–§9, FloorRunner's `paoli.ts` calculator logic (reuse patterns; don't import directly to keep universality).
- **Outputs:** `solver.ts`, exhaustive unit tests in `src/lib/gridCalculator/__tests__/solver.test.ts`.
- **Loop:** continuous; every PR runs a property-based test loop using `/loop` skill.
- **Escalation:** if it cannot resolve a conflict between toggle state and a parsed rule, ask Gabriel.

### Tier 2 — Reasoning & simulation agents (Week 2)

#### A4. Rules Normalizer Agent (Anthropic SDK wrapper)
- **Charter:** `src/lib/gridCalculator/rulesNormalizer.ts` — accepts free text, returns `CoverageRuleSet`.
- **Inputs:** PRD §9, the schema from A1+A2+A3.
- **Outputs:** Server-side function + API route `/api/grid-calculator/normalize-rules` + prompt cache configuration + few-shot examples file at `src/lib/gridCalculator/prompts/normalizer.md`.
- **Loop:** on-PR; re-runs few-shot evals when prompt changes.
- **Escalation:** any rule the LLM cannot map to the schema is shown to Gabriel verbatim.

#### A5. Distance & Supervisability Agent
- **Charter:** `src/lib/gridCalculator/distanceMatrix.ts`. Resolves "can Anesthesiologist X supervise CRNA Y given current site positions and distance bands?"
- **Inputs:** Distance migration from A1, ACGME and ASA supervision proximity guidance (web research allowed via WebSearch).
- **Outputs:** Pure functions + a graph visualization renderer for the sidebar.
- **Loop:** one-shot; rerun if A1's distance model changes.

#### A6. Float Strategy Agent
- **Charter:** `src/lib/gridCalculator/floatStrategy.ts`. Decides float allocation given a grid and a day's expected disruptions.
- **Inputs:** Paoli's break coverage analysis logic (study, don't copy), PRD §12.
- **Outputs:** Strategy module + a "Float Health" badge for the grid canvas.
- **Loop:** continuous; flagged by simulator (A7) when float decisions are unstable.

#### A7. FTE Simulator Agent
- **Charter:** `src/lib/gridCalculator/fteSimulator.ts`. Worst-case + Monte Carlo. Writes outputs to `grid_calculator_fte_runs`.
- **Inputs:** PRD §10, solver (A3), float strategy (A6), call burden (A8), all leave-bucket fields (A2).
- **Outputs:** Simulator module + nightly cron via `/schedule` skill that re-runs the simulation for every persisted config.
- **Loop:** nightly via cron; on-demand from UI.
- **Escalation:** if recommended FTE moves more than ±0.5 from the last accepted run for the same config, posts a notification with a diff.

#### A8. Call Burden Agent
- **Charter:** `src/lib/gridCalculator/callBurden.ts`. Computes fair call distribution and backup-call FTE share.
- **Inputs:** PRD §11, FloorRunner's `autoGenerate.ts` fairness ranking (study).
- **Outputs:** Module + a small "Call fairness" sparkline.
- **Loop:** consumed by A7; rerun on roster change.

### Tier 3 — UI & polish agents (Week 3)

#### A9. Grid Canvas Agent
- **Charter:** The visual grid component. Lanes, cards, supervision connectors, drag-to-rebalance, toggle bar shimmer.
- **Inputs:** PRD §7, FloorRunner staffing-calculator visual patterns, aesthetic guidance from Gabriel (regular check-ins).
- **Outputs:** `src/app/(scheduling)/grid-calculator/GridCanvas.tsx`, dependent components, and a Storybook-style component sandbox at `/grid-calculator/sandbox` (route group child).
- **Loop:** continuous during week 3; aesthetic review checkpoints every 2 working days where it posts 3 screenshot variants for Gabriel to pick.

#### A10. Aesthetic Review Loop
- **Charter:** Periodic visual audit. Captures screenshots of the canvas + FTE panel at several viewports, compares against PRD §7, surfaces drift to Gabriel.
- **Inputs:** The deployed preview URL.
- **Outputs:** Markdown report in `docs/aesthetic-reviews/YYYY-MM-DD-<topic>.md`, machine-readable locked-constraint snapshot at `docs/aesthetic-reviews/baseline.json`, and a static code+DOM audit script at `scripts/aesthetic-audit.ts` (invoked via `npx tsx scripts/aesthetic-audit.ts`; exit code 1 on any `severity: 'error'` finding). Weekly cadence proposed via `/loop 7d /aesthetic-audit` or `/schedule weekly mon 09:00 …`; registration is a Gabriel-side task per the A10 README.
- **Loop:** weekly via `/loop` skill.
- **Escalation:** any drift from §7 rules is flagged immediately.

#### A11. Paoli Seed Agent
- **Charter:** Populates `src/lib/gridCalculator/seeds/paoli.ts` with Paoli's sites, rooms, distances, sample guidelines, and a seed config. Validates the simulator's FTE recommendation against Paoli's actual headcount as a sanity check.
- **Inputs:** Anything in FloorRunner about Paoli, the Paoli photos at the orboard repo root, conversations with Gabriel for anything not in code.
- **Outputs:** Seed file, a "Paoli reality check" report in `docs/paoli-validation.md`.
- **Loop:** one-shot, then on-PR if Paoli configuration drifts.
- **Escalation:** any time the recommended FTE diverges from current Paoli headcount by more than ±2, ask Gabriel to explain the gap.

### Tier 4 — Quality & operations (continuous)

#### A12. Test Loop Agent
- **Charter:** Maintains property-based + scenario tests across solver, simulator, normalizer.
- **Loop:** continuous (`/loop 1h` during active development).
- **Escalation:** unknown failure modes surface as Slack-style notifications via `PushNotification`.

#### A13. Code Review Agent
- **Charter:** Runs `/code-review` on every agent's PR before merge.
- **Loop:** on-PR.

#### A14. PRD Curator Agent
- **Charter:** This document. Keeps it synced with reality. Adds an entry to the Changelog whenever any agent ships a change that contradicts the PRD.
- **Loop:** weekly; also on-demand when Gabriel asks "what changed?"

### Tier 5 — User-facing helpers (post-MVP)

- **A15. Onboarding Wizard Agent** — walks a new hospital through site/room entry → guidelines → first grid in 30 min.
- **A16. Export Agent** — generates PDF / PNG of the grid + FTE recommendation for hospital admin presentations.
- **A17. Universal Library Agent** — extracts patterns common across hospitals onboarded so far and surfaces them as starter templates.

## 15. Build sequence

| Week | Tier | Deliverable | Demo |
|---|---|---|---|
| 1 | Foundation (A1–A3) | Sites, distance matrix, solver, sidebar, basic toggles | Static grid renders for an in-memory Paoli config |
| 2 | Reasoning (A4–A8) | Guidelines parse, simulator, call burden, float strategy | Free-text → grid + FTE recommendation panel |
| 3 | UI polish (A9–A11) | Final canvas, aesthetic loop, Paoli seed reality check | Admin-presentable demo |
| 4 | Hardening (A12–A14) | Tests, reviews, PRD curator | Acceptance |
| 5+ | Post-MVP (A15+) | Onboarding wizard, export, library | New-hospital onboarding |

## 16. Acceptance criteria (MVP)

1. **Universality smoke test.** Onboard one *non-Paoli* hospital from scratch in under 30 minutes using only the UI. The grid renders and the FTE recommendation is non-zero.
2. **Toggle responsiveness.** All four toggles re-solve the grid in <500ms on a Paoli-sized config (8 sites, 20 rooms).
3. **Free-text reliability.** The Paoli seed guidelines (a paragraph Gabriel writes) parse with zero rule-loss across 10 consecutive runs.
4. **FTE plausibility.** For Paoli, the recommended Anesthesiologist FTE is within ±2 of current actual headcount; CRNA FTE within ±3. Any larger gap requires a Claude-written rationale that Gabriel signs off on.
5. **Float feasibility.** Break coverage feasibility ≥ `tight` on ≥90% of simulated weekdays.
6. **Visual review.** Gabriel approves three aesthetic checkpoints (Tier 3, A10).

## 17. Risks & open questions

- **Risk: LLM rule drift.** Different Claude model versions may parse guidelines differently. Mitigation: pin the model ID, snapshot the prompt, run nightly eval against frozen examples.
- **Risk: Distance ontology arguments.** "Near" vs "adjacent" may be ambiguous. Mitigation: A1 starts with 5 bands; collapse later if usage shows redundancy.
- **Risk: Simulator overfitting to Paoli.** A1+A11 must keep Paoli-specific assumptions out of `src/lib/gridCalculator/*` and constrained to `seeds/`.
- **Risk: Solver round-trips rule fields it does not enforce.** A4's normalizer emits per-site `maxSupervisionRatio`, `auxiliaryRole: break_relief | add_on_relief`, top-level `globalRules[]`, and per-site `notes`. v1.0 of A3's `solver.ts` parsed these but did NOT consult them. **Status as of v1.1 fix pass:** A3's fix pass wires `maxSupervisionRatio` into `pickSupervisor`, exposes `auxiliaryRole` and `notes` on `RoomAssignment` for A6 + UI consumption, and pushes audit-trail violations for unhonored `globalRules[]` kinds. Mitigation cross-ref: A4's notes (`docs/agent-notes/A4-rules-normalizer.md` "Open items") track any remaining drops.
- **Open question (for Gabriel):** Should Floor Runner's "Floor Runner" role (max 1:3 cap, schedule-mgmt) become a universal concept (e.g. "Coordinator") or remain Paoli-only via guidelines?
- **Open question (for Gabriel):** Is 24-hour call always the call unit, or do some hospitals use 12-hour call shifts? (Affects A8 and A7.)
- **Open question (for Gabriel) — solver/toggle interaction edges:**
  - When `coverage_style = crna_heavy` combines with `supervision_ratio = mostly_1_3`, what should the solver do at a site whose rules emit `solo_md` as the only staffing pattern? Today the solver picks solo_md (rule wins). Confirm this precedence.
  - May the solver use a "solo MD" Anesthesiologist as a **cross-site supervisor** when spare ratio capacity exists? PRD §7.3 mentions cross-site supervision but does not specify whether a nominally "solo" provider can absorb a CRNA at another site.
  - PRD §14 A6 owns floats end-to-end. Confirm A6 (Float Strategy) is the sole owner of float positioning decisions, including the bump logic in §12. (A7 already implements this assumption; this question pins it.)
- **Open question (for Gabriel) — Paoli seed sanity:** A11's reality-check report (`docs/paoli-validation.md` §6) requests Gabriel confirmation on three numbers that shift the effective-FTE diff:
  1. **Per-diem CRNA effective FTE.** Seed currently defaults the 6 Paoli per-diems to 0.5 FTE (v1.1 conservative default; awaiting Gabriel confirm). If their actual utilization is closer to 1.0, the +3 CRNA gap closes to 0. If closer to 0.2, it widens to +5 and lands outside §16's ±3 tolerance.
  2. **Sanity-band reconciliation.** ✅ **Resolved v1.1:** A14 recommended retiring the ≥18 sanity band; the simulator landed at 14, matching Paoli reality, and `paoliSeed.test.ts` widened test thresholds to `[9, 30]`. The PRD §16 spec "±2 of current actual headcount" remains canonical. The Paoli benchmark anchor is **14 Anesthesiologists** and **30 CRNAs by headcount** (24 FT + 6 per-diem).
  3. **SRNA staffing FTE.** "M. Corbett SRNA" and "S. Peckman SRNA" appear on the working roster and are modeled as 1.0 FTE CRNAs (v1.1 conservative default; awaiting Gabriel confirm). If SRNAs don't count toward Paoli's production schedule, the CRNA pool is over-counted by 2.
- **Open question (for FloorRunner-wide auth pass):** Patches 14 and 16 `ENABLE ROW LEVEL SECURITY` on every grid_calculator table. v1.0 shipped no policy bodies; the **v1.1 fix pass shipped patch17_grid_calculator_rls.sql** adding `org_access` policies + `organization_id` columns. Track downstream resolution via the FloorRunner auth roadmap.

## 18. Decisions log

- **2026-06-17:** Build target = new module inside FloorRunner. Rationale: schema/UX reuse, fastest time to demo.
- **2026-06-17:** Rules parsing via server-side Anthropic SDK (not Claude Code agent loop). Rationale: user-facing latency requirements.
- **2026-06-17:** FTE simulator reports both worst-case and Monte Carlo. Rationale: defensibility to hospital leadership.
- **2026-06-17:** First three agents (A1, A2, A3) dispatched in parallel at PRD signoff.
- **2026-06-17:** Aesthetic baseline locked by Gabriel — **Variant C "Hybrid"** layout, **lane header width = 160px**, **room card min-width = 220px**, shimmer = **200ms fade-up + blur-out**. Canonical baseline in `docs/aesthetic-reviews/baseline.json`; checkpoint rationale in `docs/aesthetic-checkpoints/A9-initial.md`. These values cannot drift without a new approved checkpoint.
- **2026-06-17:** A10's initial audit caught three "MD" → user-visible label drifts in `ToggleBar.tsx` (PRD §5 + §7.5 forbid user-visible "MD" outside internal enums). A9 patched: `label: 'MD-heavy'` → `label: 'Anesthesiologist-heavy'` (final form after the v1.1 fix-pass — initial fix used "Anes-heavy" which was tightened per PRD §5/§7.5 strict reading); section description "Bias toward solo MD…" → "Bias toward solo Anesthesiologist…". Internal `value: 'md_heavy'` enum preserved per PRD §5.
- **2026-06-17 (overnight v1.1 fix pass):** A13's initial code review surfaced 1 CRITICAL, 8 ERROR, 7 WARN, 5 INFO findings. Six fix agents dispatched in parallel addressing simulator math (peak accumulator, worst-case asymmetry, propagated seed, sampler cap), callBurden eligibility bypass, distance/supervisability policy unification (single source of truth in `distanceMatrix.ts`), solver Drift #2 (4 normalizer-emitted rule fields now consumed or audit-flagged), Sidebar stub types, label-strictness in `ToggleBar.tsx`, and the CRITICAL RLS gap (patch17 adds `org_access` policies + `organization_id` columns). See `docs/code-reviews/2026-06-17-initial.md` and per-agent fix-pass notes for details.

## 19. Changelog

- **v1 (2026-06-17):** Initial draft.
- **v1.1 (2026-06-17):** Footnote — for §16 acceptance criterion 4, the "current actual headcount" for the canonical Paoli benchmark is **14 Anesthesiologists** and **30 CRNAs by headcount** (24 FT + 6 per-diem). Earlier orchestrator working text used an implicit floor of ≥18 MD which was a misread of the original PRD intent; `paoli-validation.md` §3.1 confirms 14 is the correct anchor.
- **v1.1 (2026-06-17):** Tier 1 (A1 Site Architect, A2 Provider Profile, A3 Coverage Algorithm) shipped — `patch14_grid_calculator.sql`, `patch15_provider_leave_buckets.sql`, `solver.ts`, `types.ts`, Sidebar. Tier 2 (A4 Rules Normalizer, A5 Distance & Supervisability, A6 Float Strategy, A7 FTE Simulator with watchdog gap closure, A8 Call Burden) shipped — `rulesNormalizer.ts`, `supervisability.ts`, `floatStrategy.ts`, `fteSimulator.ts` + `patch16_fte_runs.sql`, `callBurden.ts`. Tier 3 (A9 Grid Canvas with Variant C layout, A11 Paoli Seed + reality check) shipped; A10 Aesthetic Review framework shipped (baseline + audit script + weekly cadence proposal). Tier 4 (A12 Test Loop, A13 Code Review, A14 PRD Curator) shipped. Overnight v1.1 fix pass shipped patch17 RLS policies + 6 owner-scoped bug fixes per A13's findings. See `docs/agent-notes/*.md` and `docs/aesthetic-checkpoints/A9-initial.md` for per-agent ship notes.
