# FloorRunner — Engineering & Product Briefing

**Purpose of this document.** A complete orientation for an AI assistant or engineer
who has never seen this codebase, so they can answer questions and propose changes
without first re-deriving the domain. It describes what the product is, how it is
built, the rules that must not be broken, what is genuinely working today versus
what is scaffolding, and where it is going next.

*Last updated: 17 September 2026. No personal data, credentials, or infrastructure
identifiers appear in this document.*

---

## 1. What FloorRunner is

FloorRunner is a departmental operations platform for a **hospital anaesthesia
group**: roughly 300 active clinicians (115 physicians, 185 CRNAs) working across
**8 sites** — four hospitals with 24/7 call, and four surgery centres that run
Monday to Friday with no overnight call.

It replaces a workflow currently run on spreadsheets, phone calls and email. It
does four distinct jobs:

| Subsystem | What it does |
|---|---|
| **Scheduling engine** | Generates call schedules from a declarative per-site "call pattern", then validates them against clinical rules |
| **Staffing board** | Daily/weekly operations view: who is short, who is spare, who is on the bench, who can be moved |
| **Clinician portal** | What each physician sees about their own call obligation, hours, PTO and credentials |
| **Floor Runner board** | A real-time OR board used on the day, with a voice assistant |

### The domain in one page

- **Call** is the overnight/weekend duty. Tiers are named `C1` (first call), `C2`
  (second), `C3` (third/neuro), and site-specific extras. A 24-hour in-house call
  is normally followed by a mandatory **post-call day off**.
- **Day work** is being in an anaesthetising site during the operating day. Shift
  codes look like `7-3` (07:00–15:00), `7-5`, `D1`–`D8`.
- **FTE** drives nearly everything: how much call you owe, how many days you work,
  how much PTO you get. Values range 0.5–1.0, plus per-diem staff at 0.
- **A block** is a scheduling period, typically 8–11 weeks. Obligations are stated
  *per block*, not per year — a critical distinction (see §5).
- **Sites share staff daily.** A physician credentialed at three hospitals may be
  moved between them as demand shifts. Credentialing is per-site and is a hard gate.

---

## 2. Current state — what is real and what is not

This matters enormously for judging suggestions. **Do not assume a feature has
data behind it.**

### Real, live data

- **300 active providers**, 8 sites, 7 active call patterns, 62 shift types
- **2,901 schedule slots / 2,879 assignments** — the group's actual published
  schedule for 1 Sep – 1 Nov 2026, imported from their master CSV
- **319 availability rows** (PTO, sick, jury duty, contracted days off)
- **145 site credentials**

### Known gaps in the data (not bugs — missing input)

| Gap | Consequence |
|---|---|
| **No CRNA is scheduled anywhere.** 185 CRNAs on the roster, zero CRNA shift types exist | Every CRNA availability count on the staffing board reads 0. CRNA schedules are expected soon |
| **134 of 135 per-diems have no phone number; none have email** | Blocks the planned "text the bench to offer a shift" feature entirely |
| **Only 32 providers hold any site credential** | The engine cannot place anyone at a site they are not credentialed for, so most of the roster is unplaceable outside their home site |
| **Room/anaesthetising-site counts are not in the system** | Demand must be entered by hand from the hospital's Epic OR schedule |
| **The imported schedule has a publication horizon** | Room detail stops 24 Sep – 23 Oct depending on site; call and vacation run the full window. October legitimately shows as "no schedule" for day work |

### Scaffolding — tables exist, deliberately empty

`pay_rates`, `committee_meetings`, `committee_action_items`, `candidates`,
`leadership_roles`, `documents`. Created by migration, rendered by
`/operations/handbook`, and **intentionally not seeded** — the design mock-ups
contained illustrative figures and seeding them would put invented money and
invented people in front of staff.

---

## 3. Technical stack

```
Next.js 14.2.5 (App Router)   TypeScript 5   React 18
Supabase (PostgreSQL)          Tailwind 3.4   Zod 4
Vitest 2.1                     Anthropic SDK (assistants)
Hosting: Vercel (auto-deploy on push to main)
```

- **~152,000 lines** across 567 TypeScript files
- **180 test files, ~3,575 tests**, all passing. `npm test` runs Vitest
- **75 API routes**, 24 pages
- **57 SQL migration files** at the repo root, named
  `supabase_scheduling_patchN_*.sql`, applied manually after review
- Database objects live in a **`scheduling` Postgres schema**, not `public`

### Repository shape

```
src/app/(scheduling)/…   pages behind the app shell
src/app/api/…            route handlers
src/lib/rulesEngine/     the scheduling engine (35 modules)
src/lib/gridCalculator/  staffing model (separate engine, deliberately not shared)
src/lib/staffingCalculator/
src/lib/scheduleImport/  CSV → database importer
src/lib/queries/         shared data-access layer
src/lib/auth/            session, roles, route access, invitations
src/components/          UI kit + app shell
ALGORITHM.md             the engine's specification, section-numbered
CLAUDE.md                working agreements for AI assistants
```

---

## 4. The scheduling engine

**Specification: `ALGORITHM.md`** (17 numbered sections). Read it before proposing
engine changes.

### Pipeline

```
loadGenerationContext()   all database reads, one place
      ↓
solve()                   pure greedy placement; interprets the site's CallPatternDoc
      ↓
optimize()                bounded hill-climb, monotonic — never worsens a solution
      ↓
commitPlan()              writes slots + assignments
      ↓
batchValidate()           always-on evaluators
```

### Call patterns are the single source of structure

`scheduling.call_patterns.definition` holds a **`CallPatternDoc`** (jsonb, Zod-strict,
one active row per site). It declares weekend/block chains, post- and pre-call
fills, post-call day-off blocks, spans, placement passes, relief configuration and
obligation bands.

> **Trap:** an invalid document does **not** raise an error. The engine silently
> falls back to `CLASSIC_PATTERN`. Always validate before writing one, and deploy
> **code before** a pattern-document migration.

Never re-hardcode structure in the engine — extend the pattern schema in
`src/lib/rulesEngine/callPattern.ts`.

### Validation

A previous configurable "rule definitions / rule sets" feature was **removed** in
September 2026. It was validation-only, never consulted during generation, and
every rule had been inactive since it shipped. Validation now runs entirely on
always-on evaluators in `src/lib/rulesEngine/evaluators.ts`:

`eligibility`, `timeOff`, `weekendAdjacentPto`, `shiftSkills`, `poolEligibility`,
`providerLimits`, `crossSite`, `scenarioProhibition`, `backupPairing`, plus the
defaults inside `coverage` / `openSlot`.

There is deliberately **no way to switch a check off**. The things worth checking
here are clinical, not policy. A new check belongs in that file, driven by a column
on `shift_types`, not by a configurable rule row.

---

## 5. Clinical invariants — violating any of these is a bug, never a trade-off

These are the load-bearing rules. Any proposal that weakens one is wrong.

1. **Post-call day off** after a 24-hour in-house call (`requires_post_call_rule`
   shift types), including seeded and manually-entered assignments.
2. **PTO and availability always block.** *Pending* requests block too — only
   explicitly denied or cancelled entries are ignored. Single-homed in
   `isDateBlocked` / `isBlockingAvailability` (`rulesEngine/shared.ts`).
3. **No cross-site double-booking** against any *published* version at any site.
   Draft-versus-draft overlap is deliberate (drafts are hypotheticals) and is
   caught at publish time. The published predicate is single-homed in
   `rulesEngine/committedAssignments.ts` — never re-inline it.
4. **Skipped derived shifts** must be left unassigned *and recorded*
   (`plan.skippedDerived`), never silently dropped.
5. **Call burden distributes per-FTE** — bucket quotas plus fairness metrics.
6. **Validation must never silently report clean on failure**
   (`EvaluateResult.evaluated`).

### Obligations: stated, not derived

Per-FTE obligation **bands** live in the call pattern. For the reference site:
1.0 FTE owes 16 calls per block, 0.75 owes 13, 0.7 owes 11, 0.5 owes 9.5. These
are *not* the FTE formula — only the 1.0 tier matches it.

**Extras are per-category with no netting.** Being over on M–Th C1 and short on
Sunday C2 are two true statements at once; the extra is never cancelled by the
shortfall. This is a stated business rule, not an implementation detail.

### Par is authoritative

`sites.call_par_level` is the denominator the engine divides by, and is **never**
reduced to the pool's summed FTE. When the pool is smaller than par, obligations
deliberately under-cover the schedule and the remainder is the **paid-pickup
layer**. Surfacing this gap is useful; "correcting" it is wrong.

---

## 6. Feature inventory

### `/operations` — Staffing Board *(newest, most actively developed)*

Answers the three questions back office asks every morning.

**Available vs. needed** — a site × 7-day matrix.
- **Needed** comes from a `staffing_demand` table, *not* from counting slots.
  This distinction was a deliberate correction: counting the schedule's own slots
  could only ever say "the schedule matches the schedule", so a block built two
  positions light read as fully covered.
- **Available** is people on the published schedule, counted by the assignee's
  provider type.
- Cells grade as `covered` / `surplus` / `short` (1 under) / `gap` (2+ under) /
  `closed` / `unstated` (N/A).
- **A missing demand row reads N/A, never 0.** A zero would paint an uncounted day
  green and report an unstaffed hospital as covered.

**Demand precedence:** `manual > calculated > weekend call complement > N/A`.
Manual and calculated rows coexist (`source` is part of the unique key) so an
override can be compared against what the calculator would have said. The
`calculated` source is reserved for a staffing calculator that does not yet exist.

**Weekend complement** — configured once per site (`sites.weekend_staffing`) and
applied to every Saturday and Sunday, because weekend call is structural. The UI
offers a *suggestion* derived from what actually stands on weekends, but a human
confirms it.

**Bench** — per-diem staff, filterable by site credential. Clicking a short site in
the matrix filters the bench to people who can actually be placed there.

**Transfers** — who could move from a spare site to a short one. Three
disqualifiers: not credentialed at the destination, on call, or wrong provider
group. When nobody can move, it says *why* — "nobody is credentialed there",
"the spare staff are the wrong group" and "the only spare staff are already here"
lead somewhere completely different.

### `/operations/handbook` — Group reference

Site call rules + par + roster FTE (live); pay rates, committee minutes, candidate
pipeline, leadership, document library (tables exist, empty).

### `/me` and `/providers/[id]` → Overview tab — Clinician portal

The same component in two places, deliberately: what a physician reads about their
own call must be what the office reads about them.

Panels: employment; **call owed vs taken** (per category, with `OWED / BLOCK / YTD /
MTD` columns); hours scheduled; credentialed sites; availability.

- Owed comes from the same census the schedule grid uses, so the profile and the
  grid cannot disagree.
- **Owed is per block; taken is measured over the same block window.** Comparing a
  two-month obligation against a calendar year reported physicians as short on
  everything two weeks in.
- Nothing is called *short* until the block ends; a running block reports what is
  still to come.

### `/schedules/[id]` — The grid

The main scheduling surface: generate, edit, validate, publish. Includes the **Call
Counts modal** (per-category call counts, obligations, extras, over/short) and
block-target tooling.

### `/rules` — Scheduling Logic

A read view of the live generation contract, rendered in English from the pattern
document (`src/lib/schedulingLogic.ts`), plus a **plain-English editor**: an LLM
proposes *named edits* from a closed vocabulary (`patternEdit.ts`), those edits are
validated against the schema, and an English diff is shown before anything is
written. The model's output is an input to code, never an instruction to the
database.

### `/board` — Floor Runner

Real-time OR board with a voice-driven assistant. Separate visual system
(`boardTheme`).

### Other

`/providers`, `/sites`, `/dashboard`, `/block-prep`, `/requests`,
`/staffing-calculator`, `/grid-calculator`.

---

## 6.5 Design system — typography, colour and components

The visual language was derived from a printed operations deck, and the single
biggest thing that makes the app look like that deck is the **type split**.

### Typography

| | face | used for |
|---|---|---|
| **Sans** | DM Sans (400–800), `--font-sans` | headings, prose, button labels, body copy |
| **Mono** | IBM Plex Mono (400/500/600), `--font-mono` | **every number, label, code, date and status** |

Mono is not decoration here. Site codes, shift codes, call counts, FTE figures,
dates, section labels and status pills are all mono; the sans is reserved for
headings and sentences. Getting this split right is most of the difference
between "an internal tool" and "an instrument".

- **Tabular numerals are global.** `table, .fr-nums, input[type=number]` set
  `font-variant-numeric: tabular-nums`. Numbers in this app are read in columns —
  proportional digits make a column ripple, which is the single most consumer-app
  tell a data-dense product can have.
- **Section labels** are mono, uppercase, ~11px, letter-spacing 0.8, in
  `--text-muted`, preceded by a small coloured dot. Captions under a figure are
  **lower case** — tracked caps are reserved for section headers so a caption
  never competes with the header above it.
- Big figures are mono SemiBold with slight negative letter-spacing.

### Colour

Themes are **light-default**. `:root` holds the light values; dark is applied as
`[data-theme='dark']` on `<html>` by a pre-paint script reading
`localStorage.theme` (`'light' | 'dark'`), so neither default-light nor saved-dark
flashes on load.

Everything is a CSS custom property. The families:

```
Backgrounds   --bg-base --bg-surface --bg-deep --bg-sidebar --bg-popover
Borders       --border --border-strong --border-faint --border-muted
                --border-subtle --border-input
Text ramp     --text --text-strong --text-bright --text-muted
                --text-dim --text-faint --text-disabled
Tints         --tint-surface --tint-surface-strong --tint-surface-faint
Accents       --blue --indigo --partner-ring --on-accent
Status        --ok --warn --danger --info, each with a soft -bg tint
Shadows       --shadow-xs --shadow-card --shadow-raised
                --shadow-popover --shadow-modal   (a 4-step elevation ramp)
```

**The dark ramp is derived from contrast, not mirrored from light.** Reusing the
light palette's slate steps is what broke it once: slate-700 reads as secondary
text on white but measures 1.67:1 on a dark surface — text you genuinely cannot
see — and it left the ramp inverted, with `--text-dim` less legible than
`--text-faint`. Each dark value now matches its light-mode contrast ratio.

`src/lib/cssTokens.test.ts` guards this automatically: every token used without a
fallback must be defined, the ramp must stay ordered `muted > dim > faint` in both
themes, body-weight text must stay readable, disabled must not out-shout
secondary, and a token must carry the same weight in both themes.

**Colour has four legitimate homes** and no others: `globals.css` tokens,
`boardTheme` (the Floor Runner board), `gridTheme` (the schedule grid), and the
print stylesheet. Anything else should use a token.

### Scales

```
Spacing   4 · 8 · 12 · 16 · 20 · 24 · 32 · 48px   (--space-1 … --space-8)
Radius    6 / 10 / 14px                            (--radius-sm/md/lg)
Type      11 / 12.5 / 14 / 17 / 22px               (--fs-xs … --fs-xl)
Motion    90 / 140 / 240ms, ease-out cubic-bezier(0.22, 1, 0.36, 1)
```

One motion scale, three speeds. Before it existed the app used 0.12s, 0.15s, .18s
and 0.3s with three different easings, so nothing moved at quite the same rate.
`prefers-reduced-motion` is honoured with **one exception** — the spinner is
slowed rather than stopped, because its rotation *is* the signal that work is in
progress and a frozen spinner reads as a hung app.

### Component kit — `src/components/ui`

`Button` · `Card` · `Badge` · `Modal` · `Table` · `EmptyState` · `Skeleton` ·
`PageHeader` · `Banner` · `Spinner` · `SectionLabel` + `SourceTag` · `StatBlock`

`SectionLabel`'s dot colour encodes **data provenance** — blue for
FloorRunner-computed, green for payroll, red for the EHR. A reader can tell at a
glance whether a number was computed here or read from elsewhere. Reusing the dot
as a generic bullet spends a signal that is doing real work.

### Interaction classes — `globals.css`

`.fr-focus` `.fr-btn*` `.fr-field` `.fr-row` `.fr-lift` `.fr-chip` `.fr-seg`
`.fr-toggle` `.fr-skeleton` `.fr-caret` `.fr-nav-item` `.fr-nav-sub`
`.fr-nav-caret`

**Why these exist at all is the single most important styling rule in this
codebase: an inline style always outranks a CSS class.** A hover state written
inline while the property lives in a class silently does nothing — which is why
several hand-rolled pickers across the app had no hover at all until they were
moved to `.fr-seg`. If a component needs a `:hover`, `:focus-visible` or
`[data-state]` variant, its base styling must live in CSS, and the component
should pass `data-*` attributes rather than a style object.

### Navigation

The sidebar carries **no icons**. Each item has a **left spine** — a short
hairline at the row's left edge that lifts to the accent colour on hover and goes
taller and solid on the current page. It does the two jobs glyphs were doing (a
fixed left anchor that pulls labels into one column, and answering "where am I")
without asking anyone to decode a symbol. Collapsed, the rail shows a mono
abbreviation (`DASH`, `SCHD`, `PROV`) rather than a glyph.

The spine uses `currentColor`, not a border token — so it is `--text-muted` at
rest and `--blue` on hover, correct in both themes by construction. A border token
looked right until it was measured: 1.20:1 in dark mode, an invisible hairline.

### Writing style in the UI

Sentence case, not Title Case. Empty states say what belongs there rather than
"No data". Errors name what failed and what it means. Numbers that cannot be
computed render as `—` or `N/A`, never `0`.

---

## 7. Authentication and access control

- Supabase Auth. Enforcement went live September 2026; production requires login.
- **Deny by default.** `src/lib/auth/routeAccess.ts` classifies every path; anything
  not explicitly listed is admin-only. Adding a public or provider-accessible route
  requires editing a list, which is a diff a reviewer sees.
- **The provider surface is a namespace, not an allow-list.** Everything a clinician
  can reach lives under `/me` or `/api/scheduling/me/`, and those routes derive the
  provider **from the session**. This structurally prevents the obvious mistake:
  exposing `/api/scheduling/providers/[id]/…` and trusting the id in the URL.
- RLS exists on all tables, but every route uses the service-role key, so RLS is a
  guard for the future rather than today's enforcement.

---

## 8. Engineering conventions

- **Tests are the specification.** Pure logic lives in `src/lib/*` with fixture-based
  tests; DB-coupled modules take an injected client. LLM modules use injected fake
  clients and fixtures — **never** the network in tests.
- **Golden parity:** `solve()` against the seeded classic pattern must match the
  frozen `solveLegacy` on parity fixtures, except enumerated intentional fixes.
  `solveLegacy.ts` is deliberately never edited.
- **Comments explain *why*, at the density of the surrounding code.** Several
  modules carry long header blocks recording the reasoning behind a decision and
  the bug that motivated it. This is a deliberate house style — preserve it.
- `npm run build` is the last check before any push (App Router export rules fail
  the build while `tsc` and Vitest pass).

### Known traps, each of which caused a real bug

1. **PostgREST silently caps un-ranged selects at 1,000 rows with `error: null`.**
   Use `src/lib/pagedRead.ts` (`readAllRows`), which returns either a complete
   result or an error — never a partial array with a null error.
2. **Next.js caches `fetch`, and supabase-js calls the global `fetch`.** Every
   server-side database read was therefore eligible for Next's Data Cache; deleted
   rows came back and new rows did not. Fixed at `makeServerClient` by passing
   `cache: 'no-store'`. `dynamic = 'force-dynamic'` does **not** cover this.
3. **Inline styles outrank CSS classes.** A hover state written inline while the
   property lives in a class silently does nothing.
4. **Failures render as zeros.** Check every query's `error` and surface it; a
   plausible zero is worse than a visible error.
5. **Numerics arrive from PostgREST as strings or numbers** depending on the driver.
6. **Dark-value-on-a-dark-surface.** The dark palette must be derived from contrast,
   not mirrored from the light one. `cssTokens.test.ts` guards this.
7. **`crosses_midnight` must use `end <= start`.** A 07:00→07:00 shift is 24 hours,
   not zero.
8. **`sites.operational_days` has two live shapes** — an object of named booleans at
   some sites, an array of day names at others. Read it through `siteOpenDays`.
9. **Config goes stale; real data outranks it.** A site flagged Monday–Friday was
   taking call every weekend. "Closed" must never hide people who are actually
   scheduled.
10. **PostgREST embeds arrive as an object or an array** depending on a unique
    constraint. Normalise with `embedArray`.

---

## 9. Data import

`scripts/importMasterSchedule.ts` ingests the group's master schedule CSV (a wide
sheet: providers × dates, with site sections). It is re-runnable and idempotent —
a re-import archives the previous schedule rather than duplicating it.

Architecture: `masterCsv.ts` (parse, knows nothing of meaning) → `dictionary.ts`
(what each code means, with a `certainty` flag and a stated assumption for every
inferred entry) → `plan.ts` (pure; produces a plan of writes) → the script (a thin
loop that executes it).

Notable decisions worth understanding:
- **The code owns the site, not the row.** A physician's row sits under their home
  section but the work may be elsewhere; reading the site off the row would file
  every cross-site day at the wrong hospital.
- **Leave collapses into runs.** 668 vacation cells describe ~212 actual absences.
- **Conflicts are imported as written and reported**, not silently cleaned up.
- The dictionary prints its ~25 open assumptions on every run.

---

## 10. A structural fact that shapes everything

**FloorRunner's schedule holds people and statuses, never rooms.**

It records *who* is working and in what capacity — first call, second call, a 7-3,
post-call. It says nothing about which anaesthetising site they stand in; room
assignment happens on the day, on the floor.

Consequently:
- **Availability** is a headcount by capacity, never a count of rooms covered.
- **Demand** is the only half that knows about rooms, and it comes from outside —
  someone reads the hospital's Epic OR schedule and counts.

Anything that assumes FloorRunner knows room assignments is wrong.

### Related: the overnight call doctor is not daytime coverage

A first-call physician starting at 15:00 is on the schedule but not on the floor
during the operating day. Weekday floor coverage therefore excludes shifts starting
at or after 15:00. **Weekends count everything** — there is no day roster on a
Saturday, so the call team *is* the coverage.

---

## 11. Future work

### Committed / next up

| Item | Notes |
|---|---|
| **CRNA schedules** | Being supplied. Needs CRNA shift types created per site; will make every CRNA figure on the board meaningful for the first time |
| **Staffing calculator → demand** | Derive how many anaesthetising sites each hospital runs, and write `source='calculated'` demand rows. The reader already prefers manual, and the UI already shows the calculated figure as a placeholder — nothing else changes when it lands |
| **Per-diem outreach** | Select spare per-diems and text them a shift offer. **Blocked on contact data**, not code. Also needs an SMS vendor, per-message cost and opt-out handling. `scheduling.notifications` already has the right shape |
| **Credentialing backlog** | Only 32 providers hold any credential. This is probably higher-leverage than any feature — it is what limits cross-site placement |

### Open questions / smaller items

- A flag exists for "first out the next day but still works it"
  (`early_out_post_call`) but **nothing in the engine reads it**.
- Several shift types carry assumed hours (marked in the import dictionary).
- Two near-duplicate provider records from a bulk import need merging.
- Twelve physicians were created under their schedule code because their real names
  were not in the source data.
- A second admin account cannot be created until more staff email addresses exist.

### Longer-horizon ideas

Automatic demand from the OR schedule; swap/trade marketplace between clinicians;
mobile-first clinician view; pay-rate integration so extras are costed as they are
incurred; multi-tenant support for other anaesthesia groups (the data model is
already organisation-scoped).

---

## 12. How to be useful in this codebase

1. **Check whether data exists before proposing a feature that reads it.** The
   commonest failure mode here would be designing something for CRNAs, rooms or
   phone numbers that has no source.
2. **Prefer surfacing a gap to filling it with a default.** "N/A", "not
   configured", "no schedule" are correct answers. A zero that reads as green is
   the bug class this project guards against most.
3. **Single-home a predicate.** If two surfaces can disagree about whether someone
   is available, they eventually will. Route through the engine's own helpers.
4. **Respect the invariants in §5** — they are clinical, not stylistic.
5. **Match the comment style.** Explain why a decision was made and what breaks
   otherwise.
6. **Use the design tokens and the UI kit (§6.5).** Mono for numbers and labels,
   sans for prose; never a hard-coded colour; never a `:hover` written inline.
7. **Migrations:** additive changes go DB-first; destructive changes and
   call-pattern documents go code-first.
