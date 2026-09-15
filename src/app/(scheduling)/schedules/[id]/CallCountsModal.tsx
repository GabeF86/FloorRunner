'use client';

/* ── Call Counts overlay ─────────────────────────────────────────────────────
 * DYNAMICALLY IMPORTED (next/dynamic, ssr: false) by the schedule grid page.
 * It renders only behind `showCounts`. This is the single biggest overlay on
 * the route — a 27-column table at Paoli, its print stylesheet, the coverage
 * forecast — and it pulled in most of the call-accounting libraries (column
 * derivation, chain connectors, day math, workDays, coverage forecast) purely
 * to sit idle behind a button. `ssr: false` is correct: a click-gated overlay
 * that calls window.print().
 *
 * IT DECIDES NOTHING. Every number is computed by a single-homed library —
 * callCensusFromGrid (./gridShared) for the obligation census, so the grid's
 * red OVER cells and this table read the SAME selection; callCountColumns for
 * the column shape; callCountChains for the connector band; callCountDays and
 * rulesEngine/workDays for the day math. Never add a rule here.
 *
 * Moved verbatim out of page.tsx — same props, same logic, same rendering.
 * ───────────────────────────────────────────────────────────────────────── */

import { gridTokens } from './gridTheme';
import { fteWeightedTarget } from '@/lib/fteTarget';
// Day-math for the Call Counts modal (bucket day counts, Days Off, Working
// Days) — pure helpers assembling the single-homed workDays/plannerMath
// contracts; the modal only aggregates and renders.
import {
  bucketDayCounts, daysOffFor, creditedWorkingDayTotals,
  weekendObligationUnits, weekendDutiesByProvider, requiredWeekendsFor,
} from '@/lib/callCountDays';
// Call Counts COLUMN SHAPE (2026-07-28): which (day bucket, call code) columns
// this block actually has — derived from its slots, never hardcoded — and the
// extras tally broken out by day type (the pickup rate depends on the day).
// Both route the bucket through the engine's dayTypeBucketOn, so a holiday
// folds onto its day of the week exactly as the quota that placed it did.
import {
  computeCallCountColumns, extraCallsByBucketCode, extraKey, BUCKET_LABELS,
} from '@/lib/callCountColumns';
// Call Counts CHAIN CONNECTORS (2026-07-28): which of those columns the site's
// call pattern hands to ONE provider (the Sat C2 doc also holds Fri C2 and Sun
// C1), resolved onto the column indices so the band above the header can draw
// them. The rule and the offset→day-type step live in the module; this file
// only draws what it returns.
import { computeCallChainConnectors } from '@/lib/callCountChains';
// rangeComposition = the planner card's single-homed block composition
// (weekdays minus major holidays → the working-day set).
import { rangeComposition } from '@/lib/plannerMath';
// requiredWorkDaysWithLimit = the engine's per-provider requirement
// (round(work-days FTE × WD) − PTO, overridden by a stated Limits-tab
// workingDays/daysOff entry) — the Call Counts "Working Days" column shows
// actual/required from the SAME function the generation cap uses.
// ptoWeekdaysCovered = the engine's PTO-netting set, imported for the same
// reason: the PTO Days column feeds requiredWorkDaysWithLimit, so a second
// copy of the predicate here would let the modal and the engine disagree about
// which weekdays PTO covers.
import { requiredWorkDaysWithLimit, ptoWeekdaysCovered } from '@/lib/rulesEngine/workDays';
import { parseProviderLimits } from '@/lib/providerLimits';
import { WEIGHT_EPSILON, formatCallWeight } from '@/lib/callBurden';
import { computeCoverageForecast, formatCalls } from '@/lib/coverageForecast';
import {
  callCensusFromGrid,
  type GridData, type Provider, type AvailabilityEntry,
} from './gridShared';

export function CallCountsModal(
  { grid, onClose, onFocusProvider }:
  { grid: GridData; onClose: () => void; onFocusProvider?: (pid: string) => void },
) {
  // Bucket key = day_type group (weekday | friday | saturday | sunday).
  // Saturday and Sunday are SEPARATE fairness buckets (mirrors the engine's
  // dayTypeBucketOn) so per-day call burden is visible per provider. There is
  // no holiday column because the engine has no holiday bucket — a holiday
  // counts as the day of the week it falls on (Gabriel 2026-07-27).
  //
  // THE COLUMNS ARE DERIVED FROM THE BLOCK (2026-07-28) — lib/callCountColumns
  // owns the rule and the arithmetic; this component only renders what it
  // returns. A (bucket, code) column exists iff the block stands at least one
  // slot for that pair, so Paoli's retired weekday/Friday C3 columns (patch38)
  // disappear from new blocks while the older drafts that already materialized
  // Friday C3 slots keep showing those real assigned calls, and a thinner site
  // stops rendering permanently empty tiers. Nothing about the obligation /
  // over-par math changes — this is display grouping only.
  //
  // THE NEURO TIER IS ITS OWN GROUP (2026-07-28) — day-major everywhere except
  // neuro, which is code-major with a sub-column per day it is stood:
  // M–Th | Fri | Sat | Sun | Neuro Call (C3). The code comes from the site's
  // stated CallPatternDoc.neuroWeekend.code (never hardcoded), the day
  // sub-columns from the same slot-presence rule as every other column, and
  // both halves of the table render from the one `columns` array so the
  // regrouping reaches the Extra Calls side identically.

  const providerById: Record<string, Provider> = {};
  for (const p of grid.providers) providerById[p.id] = p;

  // Shared obligation census — the IDENTICAL inputs the grid's over-par memo
  // uses (callCensusFromGrid): the stored par as denominator (par-
  // authoritative 2026-07-24, matching the engine's obligatory-mode cap)
  // and an every-call-slot count — holiday-dated slots and non-C1/C2/C3 call
  // codes included. The bucketed columns below are DISPLAY grouping only
  // (C1–C3 across the four day-type buckets; a holiday-dated call shows in the
  // column for its day of the week, a call code outside C1–C3 in none) — they
  // never feed the obligation/extra/OVER math.
  const census = callCensusFromGrid(grid);

  const providersWithCalls = new Set<string>();
  for (const rec of census.callRecords) providersWithCalls.add(rec.provider_id);

  // Which (bucket, code) columns this block HAS, plus the weighted block totals
  // and per-provider counts behind them. Call splits (2026-07-22) aggregate
  // SEGMENTS under their PARENT code by weight — a split Sat C1 with both
  // halves filled shows 0.5 + 0.5 across its takers, and column totals still
  // sum to the slot-weight total. The ENGINE's bucket (dayTypeBucketOn) puts a
  // holiday-dated call in the column for the day of the week it falls on, so a
  // Labor Day (Monday) call shows under M–Th; anything the engine does not fold
  // into one of the four buckets has no column, and the census below still
  // counts every call slot regardless.
  //
  // The site's stated neuro code (CallPatternDoc.neuroWeekend.code, parsed
  // server-side by the grid route) — the SAME field the Obligatory Weekends
  // column below reads. It lifts that tier into its own column group; a site
  // that states none, or whose pattern failed to parse, gets the day-major
  // shape untouched.
  const neuroCode = grid.callPattern?.neuroWeekend?.code;
  const { columns, groups, blockTotals, counts } =
    computeCallCountColumns(grid.slots, { neuroCode });
  // Group dividers: a vertical rule at the first column of each group. Keyed on
  // groupKey, NOT the bucket — the neuro group's columns each carry a different
  // bucket, and the Sun group is followed by a neuro column bucketed saturday.
  const isGroupStart = (i: number) =>
    i === 0 || columns[i].groupKey !== columns[i - 1].groupKey;
  const codeColor = (code: string) =>
    code === 'C1' ? '#0ea5e9' : code === 'C2' ? '#34d399' : '#a855f7';

  // CHAIN CONNECTORS (Gabriel 2026-07-28) — "a small line connector on top of
  // the C1 C2 etc that connects the call shifts that are linked, so that when
  // im using the call count box to help manually fill the schedule, its a good
  // reminder of which calls are connected". A weekend here is a designed SET,
  // not one shift: the site's CallPatternDoc block chains hand Sat C2 + Fri C2
  // + Sun C1 to ONE provider, and the table used to show those as three
  // unrelated columns. lib/callCountChains resolves the pattern's day OFFSETS
  // to day types (through the engine's date helpers) and each (bucket, code)
  // member to the column that DRAWS it — which is what carries the neuro group,
  // where Sat C3 and Sun C3 sit outside the Sat/Sun groups. A site with no
  // pattern, or one that failed to parse (the grid route ships null), gets an
  // empty list and no band at all.
  const chains = computeCallChainConnectors(grid.callPattern, columns);
  // Band geometry, small by request: an 11px row per chain, the line at 5px and
  // a 9px tick crossing it. Drawn with BORDERS, never background colour —
  // browsers drop background graphics when printing unless the user opts in,
  // and this table is printed to fill in by hand.
  const CHAIN_ROW_H = 11, CHAIN_LINE_TOP = 5, CHAIN_TICK_TOP = 1, CHAIN_TICK_H = 9;
  // Single-column headers trailing the (bucket, code) pairs, each rowSpan={2}:
  // Obligation, Call Total, Over By, Obligatory Weekends, PTO Days, Days Off,
  // Working Days. A band row is 1 label + columns.length ticks + a filler
  // spanning the extras half and these, so it is exactly as wide as every other
  // row (1 + 2 × columns.length + 7) and no colSpan can drift.
  const TRAILING_HEADER_COLS = 7;

  const scheduleStart = grid.schedule.date_start;
  const scheduleEnd = grid.schedule.date_end;

  // Sort providers alphabetically, only include those with calls (or all?)
  // Show ALL home-site physician providers who could potentially take call.
  // For simplicity: show any provider with at least one call on this schedule,
  // plus any provider in grid.providers who is a physician.
  const allProviderIds = new Set<string>([
    ...providersWithCalls,
    ...grid.providers.filter(p => p.provider_type === 'physician').map(p => p.id),
  ]);
  const providers = Array.from(allProviderIds)
    .map(id => providerById[id])
    .filter(Boolean)
    .sort((a, b) => a.short_display_name.localeCompare(b.short_display_name));

  const getCount = (pid: string, key: string) => counts[pid]?.[key] || 0;

  // Call Total = EVERY call assignment (census), not just the bucketed C1–C3
  // columns — a call code outside C1–C3 counts here (and in the obligation
  // math) even though it has no bucket column of its own.
  const rowTotal = (pid: string) => census.actualCallsFor(pid);

  const colTotal = (key: string) => {
    let t = 0;
    for (const pid of providers.map(p => p.id)) t += getCount(pid, key);
    return t;
  };

  // FTE display beside the provider name only — every calculation below goes
  // through census.fteFor (engine coercion) so display quirks can't skew math.
  const fteByPid: Record<string, number> = {};
  // Stated WORKING-DAYS FTE per provider (patch43). Null / no profile / a
  // pre-43 payload all resolve to "use the call FTE" inside the contract
  // (effectiveWorkDaysFte) — this map only carries what was actually stated,
  // it never invents a fallback of its own.
  const workDaysFteByPid: Record<string, number | null> = {};
  for (const p of grid.profiles || []) {
    fteByPid[p.provider_id] = p.fte_value ?? 1;
    workDaysFteByPid[p.provider_id] = p.work_days_fte ?? null;
  }
  const workDaysFteForPid = (pid: string) => workDaysFteByPid[pid] ?? null;

  // Days-in-block per bucket header — DISTINCT stored slot dates per
  // derived_day_type, the same exact-match keys the bucket columns aggregate
  // on, so a day type with no bucket column (holiday) gets no count either.
  const bucketDays = bucketDayCounts(grid.slots);

  // Block working-day composition (weekdays minus major holidays) — the same
  // single-homed rangeComposition the planner card uses, fed by the grid's
  // holiday rows. Powers Days Off (denominator) and Working Days (credit set).
  const composition = rangeComposition(scheduleStart, scheduleEnd, grid.holidays || []);

  // PTO Days = the ENGINE's netting set (rulesEngine/workDays.ptoWeekdaysCovered)
  // measured against THIS block's working-day set — never a second copy of the
  // predicate, because the same number feeds requiredForPid / daysOffForPid
  // below and a private tally here would report different days off than the
  // engine budgeted. Routing through it also inherits the contract the inline
  // tally did not have: PENDING leave nets (invariant 2 — pending PTO blocks
  // everywhere), only denied/canceled rows are dismissed, a live pto_sellback
  // restores the day as owed again, overlapping rows dedupe by date, and major
  // holidays never count (the working-day set already excludes them). Clamping
  // to the schedule window is implicit — the working-day set IS the window.
  const availRowsByPid = new Map<string, AvailabilityEntry[]>();
  for (const a of grid.availability || []) {
    const rows = availRowsByPid.get(a.provider_id);
    if (rows) rows.push(a);
    else availRowsByPid.set(a.provider_id, [a]);
  }
  const ptoDaysByPid: Record<string, number> = {};
  for (const [pid, rows] of availRowsByPid) {
    ptoDaysByPid[pid] = ptoWeekdaysCovered(rows, composition.workingDaySet).size;
  }
  const ptoDaysForPid = (pid: string) => ptoDaysByPid[pid] || 0;

  // Working Days = credited M–F working days actually scheduled on THIS
  // draft: weekday assignments + post-call rest days credited as worked +
  // ICU weeks (disjoint), via the shared credit logic (plannerMath through
  // lib/callCountDays) — the generation banner's workDayReport semantics.
  const creditedByPid = creditedWorkingDayTotals(
    grid.slots, grid.availability || [], composition.workingDaySet, grid.holidays || []);
  const workingDaysForPid = (pid: string) => creditedByPid[pid] || 0;

  // Days Off = block working days − PTO weekdays − required, where required
  // routes through the single-homed workDays contract (round(workFTE × WD) −
  // PTO). PTO weekdays here are the SAME tally the PTO Days column shows
  // (ptoDaysForPid) so the two columns can never disagree. A full WORKING-DAYS
  // FTE → 0 → "—", whatever the call FTE is (patch43: a 0.66-call / 1.0-days
  // provider owes every working day and is entitled to no days off).
  const daysOffForPid = (pid: string) =>
    daysOffFor(census.fteFor(pid), composition.workingDays, ptoDaysForPid(pid),
      workDaysFteForPid(pid));

  // Required working days — the engine's own contract, incl. a stated
  // Limits-tab override when one exists (blank limit → the FTE formula,
  // Gabriel's verbatim fallback rule). Rendered as "actual / required".
  // Precedence is the contract's: Limits tab > work_days_fte > fte_value.
  const limitsParse = parseProviderLimits(grid.schedule.provider_limits);
  const statedLimits = limitsParse.ok ? limitsParse.value : null;
  const requiredForPid = (pid: string) => requiredWorkDaysWithLimit(
    census.fteFor(pid), composition.workingDays, ptoDaysForPid(pid),
    statedLimits?.[pid] ?? undefined, workDaysFteForPid(pid));

  // Expected = FTE-weighted base target per (provider, bucket, code) —
  // (block_total_in_bucket / par) × POOL fte (census.poolFteFor: a
  // provider outside the call pool owes 0 calls — weighting by real FTE
  // inflated the Expected row past the slot count, Gabriel 2026-07-22),
  // at the stored par (par-authoritative 2026-07-24 — the engine's
  // computeBucketTargets uses the same denominator for its category
  // targets). Category-level values stay
  // FRACTIONAL by design (they drive the engine's fairness ordering); only
  // the TOTAL-level obligation below is rounded. The WORKDAY columns
  // (Days Off / Working Days required) deliberately stay on census.fteFor —
  // the working-days contract applies to everyone, day docs included.
  // 2026-07-27: the per-cell "(1.2)" parenthetical is gone at Gabriel's
  // request — expectedFor now feeds ONLY the Expected footer row.
  const expectedFor = (pid: string, key: string) =>
    fteWeightedTarget(blockTotals[key] || 0, census.effectivePar, census.poolFteFor(pid));
  // TOTAL-level fractional expected — straight from the shared census (all
  // call slots ÷ effective par × FTE), NOT a sum of the display buckets: the
  // buckets cover only the C1–C3 codes, the obligation covers every call slot.
  const rowExpected = (pid: string) => census.totalExpectedFor(pid);
  const colExpected = (key: string) => {
    let t = 0;
    for (const p of providers) t += expectedFor(p.id, key);
    return t;
  };

  // Obligatory Weekends (Gabriel 2026-07-27, REVISED same day) — "actual /
  // required" over WEEKEND DUTIES, of which there are exactly two kinds
  // counted two different ways (lib/callCountDays.ts owns the arithmetic and
  // the full rationale):
  //   • primary call (shift_types.call_rank 0) — counted PER WEEKEND DAY, so
  //     an 11-week block stands 11 Fri C1 + 11 Sat C1 + 11 Sun C1 = 33;
  //   • neuro (the active pattern's neuroWeekend.code) — counted PER PAIR, so
  //     11 Sat+Sun pairs = 11, a lone neuro day being half.
  // 33 + 11 = 44 at par 11 → a 1.0 FTE owes 4, a 0.75 FTE 3, a 0.5 FTE 2
  // (units ÷ par × FTE, DOWN to the nearest half). Both sides come from
  // grid.slots through one classifier, so numerator and denominator cannot
  // disagree about which slots are duties — the previous column's actual bug
  // (a widest-day denominator against an every-doc-who-worked numerator, which
  // painted everyone red).
  // A site with no stated neuroWeekend simply has no neuro term. (neuroCode is
  // resolved once at the top of this component — the column grouping reads the
  // same field.)
  const weekendUnits = weekendObligationUnits(grid.slots, neuroCode);
  const weekendsByPid = weekendDutiesByProvider(grid.slots, neuroCode);
  const weekendsForPid = (pid: string) => weekendsByPid[pid] || 0;
  const requiredWeekendsForPid = (pid: string) =>
    requiredWeekendsFor(weekendUnits, census.effectivePar, census.poolFteFor(pid));
  const expectedWeekendsForPid = (pid: string) =>
    fteWeightedTarget(weekendUnits, census.effectivePar, census.poolFteFor(pid));
  // Over the obligation = the paid-pickup layer. EPSILON so a half-weekend
  // sum that lands a hair past its requirement isn't painted red.
  const weekendsOver = (pid: string) =>
    weekendsForPid(pid) > requiredWeekendsForPid(pid) + WEIGHT_EPSILON;

  // Whole-number obligations, TOTAL level (2026-07-17): a provider's
  // obligation = round(total expected) — round-half-up. The calls tagged
  // beyond it are the SMALLEST-total-weight set of their assignments that
  // brings the rest back to the obligation, later dates winning a tie
  // (2026-07-29), grouped by (day bucket, code) for the columns below. The
  // over set comes straight from the shared census — the SAME set that paints
  // the grid's red OVER cells, computed once from identical inputs, so the two
  // views always agree. (An over call with a code outside C1–C3 counts in the
  // math but has no Extra column — live call codes are only C1–C3 today.)
  //
  // The Over By column carries the FRACTIONAL overage (held weight − rounded
  // obligation) beside it, because the tagged calls' weight can exceed it: a
  // 1.0 call is the smallest cover for a 0.7 overage when nothing smaller
  // fits, and a whole red call must never be read as a whole call's worth of
  // excess. In Horan's live case they agree at 0.5 (the 12h split).
  //
  // Deficit carry-forward is NOT included (we don't have historical data
  // here), so this can over-report for part-timers legitimately catching
  // up from a prior block. Documented in the column tooltip.
  // Single-homed in the census (2026-08-03): rounded under the derived
  // formula, the band's own EXACT total under stated obligations — Paoli's
  // 0.5 FTE owes 9.5, and re-rounding here would print 10.
  const rowObligation = (pid: string) => census.obligationFor(pid);
  const rowOverBy = (pid: string) => census.overageFor(pid);
  const overIds = census.overParAssignmentIds;
  // Extra calls BY DAY TYPE (Gabriel 2026-07-28): an extra is a paid pickup and
  // the rate depends on the day, so a code-only tally was unbillable as shown.
  // The grouping lives in lib/callCountColumns (which resolves each extra's
  // bucket from its own slot, through the engine's dayTypeBucketOn — census
  // records carry the date but no day type). WHAT counts as extra is untouched:
  // this only regroups the ids the shared census selected.
  const extrasByKey = extraCallsByBucketCode(grid.slots, census.callRecords, overIds);
  const getExtra = (pid: string, bucket: string, code: string): number =>
    extrasByKey[extraKey(pid, bucket, code)] || 0;
  const colExtraTotal = (bucket: string, code: string) => {
    let t = 0;
    for (const pid of providers.map(p => p.id)) t += getExtra(pid, bucket, code);
    return t;
  };
  const fmtFte = (fte: number) => fte.toFixed(2).replace(/\.?0+$/, '');
  // Hide sub-noise expectations — anything under this rounds to 0.0 anyway.
  const EXPECTED_DISPLAY_MIN = 0.05;

  // Coverage line (par-authoritative, Gabriel 2026-07-24): Σ rounded
  // obligations vs the weighted call-slot total, straight from the shared
  // census — no new math homes. When the pool's ΣFTE is below the par the
  // obligations deliberately under-cover the schedule; the gap is the paid-
  // pickup layer, taken after the schedule is made.
  const totalObligation = providers.reduce((s, p) => s + rowObligation(p.id), 0);
  const pickupGap = Math.max(0, census.totalCallSlots - totalObligation);

  const handlePrint = () => {
    // Native print dialog → Save as PDF gets you a file. Relies on the
    // .print-area / @media print styles below to isolate the table.
    window.print();
  };

  return (
    <div
      className="fr-print-overlay"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)',
        zIndex: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}
    >
      <div
        className="fr-print-panel"
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--bg-deep)', borderRadius: 12, border: '1px solid var(--border)',
          boxShadow: '0 24px 60px rgba(0,0,0,0.5)',
          padding: 20, maxWidth: '95vw', maxHeight: '90vh', overflow: 'auto', minWidth: 720,
        }}
      >
        {/* Scoped print stylesheet: everything outside #call-counts-print is
            hidden during print so Save as PDF captures just the table. */}
        <style>{`
          @media print {
            /* LANDSCAPE + tight type (2026-07-28): breaking the extras out by
               day type took the table from 22 columns to 2 × (bucket,code) + 7
               — 27 at Paoli. Print has no horizontal pagination, so anything
               wider than the page is CLIPPED rather than scrolled: the page
               box has to be the wide one and the cells have to be small.
               Measured with headless Chrome at letter landscape: the table
               lays out at ~910px against ~1010px of printable width. */
            @page { size: landscape; margin: 0.35in; }
            body * { visibility: hidden !important; }
            #call-counts-print, #call-counts-print * { visibility: visible !important; }
            /* PAGINATION (2026-08-02). The print root used to be
               'position: fixed; inset: 0' to escape the modal's own
               'overflow: auto' clipping — but a FIXED element does not
               fragment: Chrome renders it on page one and CLIPS the rest.
               Measured at letter portrait: 15 rows → 1 page and 120 rows →
               still 1 page, i.e. 105 rows silently dropped. (The
               'break-inside: avoid' rule in the Available Call sheet was
               dead for the same reason — nothing to break.) Absolute
               positioning fragments correctly (120 rows → 3 pages), but only
               once the modal chrome stops being a clipping/positioned
               ancestor — hence neutralising the shell here. */
            .fr-print-overlay, .fr-print-panel {
              position: static !important; overflow: visible !important;
              max-height: none !important; max-width: none !important;
              min-width: 0 !important; padding: 0 !important; margin: 0 !important;
              background: #fff !important; border: none !important;
              box-shadow: none !important; display: block !important;
            }
            #call-counts-print {
              position: absolute !important; inset: auto !important;
              left: 0 !important; top: 0 !important; width: 100% !important;
              background: #fff !important; color: #000 !important;
              padding: 0 !important; overflow: visible !important;
              max-height: none !important; max-width: none !important;
              min-width: 0 !important;
              border: none !important;
            }
            #call-counts-print table, #call-counts-print th, #call-counts-print td {
              color: #000 !important; border-color: #666 !important;
              background: #fff !important;
            }
            #call-counts-print table { font-size: 7pt !important; width: 100% !important; }
            #call-counts-print th, #call-counts-print td { padding: 2px 3px !important; }
            /* The connector band's cells must stay UNPADDED or the 3px of
               horizontal padding above cuts a 6px gap into every chain line at
               each column boundary. The band is drawn in borders (not
               background colour, which browsers drop when printing) on plain
               divs, so the #000/#fff th/td overrides above leave the chain
               colours alone; the row label carries the chain's name for the
               black-and-white case. */
            #call-counts-print .cc-chain-cell { padding: 0 !important; }
            #call-counts-print .cc-chain-label { padding: 0 4px 1px 0 !important; }
            #call-counts-print .no-print { display: none !important; }
          }
        `}</style>

        <div id="call-counts-print">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--text)' }}>Call Counts</div>
            <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 2 }}>
              {grid.schedule.schedule_name} — per provider, per day bucket, per call tier. Obligatory weekends, PTO days (M–F only), FTE days off, and credited working days shown separately.
              {/* The band has tooltips on screen and none on paper, so the
                  printed sheet has to say what the brackets are. Only shown
                  when there are chains to explain. */}
              {chains.length > 0 && ' Bracketed columns above the header are calls the site’s call pattern gives to ONE provider — the ticks mark the members.'}
            </div>
            <div
              style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, fontWeight: 600 }}
              title="Par is authoritative (never reduced to the pool's summed FTE). Obligations = each provider's round(call slots ÷ par × FTE), summed. When the pool is smaller than the par they deliberately cover less than the schedule — the remainder is taken as paid pickups after the schedule is made; a pickup past someone's obligation is paid extra."
            >
              Par {fmtFte(census.effectivePar)} · pool {fmtFte(census.poolFte)} FTE · obligations
              cover Σ{totalObligation} of {formatCallWeight(census.totalCallSlots)} call
              slots{pickupGap > 0
                ? ` — ${formatCallWeight(pickupGap)} left as paid pickups`
                : ' — fully covered'}
            </div>
          </div>
          <div className="no-print" style={{ display: 'flex', gap: 6 }}>
            <button onClick={handlePrint} style={{
              padding: '7px 16px', fontSize: 12.5, fontWeight: 700, border: 'none', borderRadius: 8, cursor: 'pointer',
              background: 'linear-gradient(135deg,#0ea5e9,#6366f1)', color: '#fff', boxShadow: '0 4px 14px rgba(56,130,246,0.35)',
            }}>Print / Save PDF</button>
            <button onClick={onClose} style={{
              padding: '7px 15px', fontSize: 12.5, fontWeight: 700, borderRadius: 8, cursor: 'pointer',
              background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)',
            }}>Close</button>
          </div>
        </div>

        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
          <thead>
            {/* Chain connector band — one row per chain the site's pattern
                gives to a single provider, above the headers it connects. The
                line runs from the chain's leftmost to its rightmost column and
                the TICKS identify membership: members are usually not adjacent
                (Fri C2 … Sun C1 spans the Saturday columns), so crossing the
                columns in between is expected, not a claim about them. Empty
                when the site states no pattern. */}
            {chains.map(chain => {
              const ticks = new Set(chain.columnIndices);
              const color = codeColor(chain.triggerCode);
              return (
                <tr key={`chain|${chain.key}`} title={chain.description}>
                  <th className="cc-chain-label" style={{
                    padding: '0 10px 1px', textAlign: 'right', whiteSpace: 'nowrap',
                    fontSize: 9.5, fontWeight: 700, lineHeight: 1, color, cursor: 'help',
                  }}>{chain.triggerLabel}</th>
                  {columns.map((col, i) => {
                    const inSpan = i >= chain.firstIndex && i <= chain.lastIndex;
                    return (
                      <th key={`chain|${chain.key}|${col.key}`} className="cc-chain-cell"
                          style={{ padding: 0 }}>
                        <div style={{ position: 'relative', height: CHAIN_ROW_H }}>
                          {inSpan && (
                            <div style={{
                              position: 'absolute', top: CHAIN_LINE_TOP,
                              // The line stops at the CENTRE of the end columns,
                              // where their ticks are, and runs edge to edge
                              // through the ones between (the cells carry no
                              // padding, so the segments join into one line).
                              left: i === chain.firstIndex ? '50%' : 0,
                              right: i === chain.lastIndex ? '50%' : 0,
                              borderTop: `2px solid ${color}`,
                            }} />
                          )}
                          {ticks.has(i) && (
                            <div style={{
                              position: 'absolute', top: CHAIN_TICK_TOP, left: 'calc(50% - 1px)',
                              height: CHAIN_TICK_H, borderLeft: `2px solid ${color}`,
                            }} />
                          )}
                        </div>
                      </th>
                    );
                  })}
                  {/* Filler across the Extra Calls half and the trailing
                      single-column headers — the band never spans those. */}
                  <th colSpan={columns.length + TRAILING_HEADER_COLS} />
                </tr>
              );
            })}
            <tr style={{ background: 'var(--bg)', color: 'var(--text-muted)' }}>
              <th rowSpan={2} style={{ padding: '6px 10px', textAlign: 'left', borderBottom: '1px solid var(--border)', fontWeight: 700 }}>Provider</th>
              {groups.map(g => (
                <th key={g.key} colSpan={g.columns.length} title={g.bucket
                  ? `${bucketDays[g.bucket]} ${g.label} day${bucketDays[g.bucket] === 1 ? '' : 's'} in this block — distinct slot dates in this bucket. Holidays are INCLUDED, counted as the day of the week they fall on: Labor Day is a Monday, so it is one of the M–Th days and its calls are M–Th calls. Only the call tiers this block actually stands get a column: a tier with no slot on these days (Paoli's retired Friday C3) has none, and a tier whose slots exist but went unfilled shows an empty one.${neuroCode ? ` The ${neuroCode} neuro tier is NOT in this group — it has its own, at the end.` : ''}`
                  : `The site's stated neuro weekend call (${neuroCode}), broken out of the day groups into its own — one sub-column per day the block actually stands it, so these are neuro calls counted by the day they fell on. Paoli stands neuro Sat + Sun (patch38 retired the Friday one); a block that still holds Friday neuro slots grows a Fri sub-column here automatically. The counts are unchanged — a Saturday neuro call is the same call it was under the Sat group, drawn in a different place.`} style={{
                  padding: '6px 10px', textAlign: 'center', fontWeight: 700,
                  borderBottom: '1px solid var(--border)', borderLeft: '1px solid var(--border)',
                  color: 'var(--text-muted)', cursor: 'help',
                  // A pruned group can be as narrow as one column; keep the
                  // label from breaking mid-word ("M–" / "Th") in print.
                  whiteSpace: 'nowrap',
                }}>
                  {g.label}
                  {g.bucket && (
                    <span style={{ fontSize: 10, fontWeight: 500, opacity: 0.7, marginLeft: 4 }}>
                      {bucketDays[g.bucket]}d
                    </span>
                  )}
                </th>
              ))}
              {columns.length > 0 && (
                <th colSpan={columns.length} style={{
                  padding: '6px 10px', textAlign: 'center',
                  borderBottom: '1px solid var(--border)', borderLeft: '1px solid var(--border)',
                  color: '#ef4444',
                }} title="Calls beyond the provider's TOTAL obligation — ONE ceiling, round(total call slots ÷ par × FTE), across every call code and every day type. The day-type split is for PRICING ONLY (2026-07-28): a pickup is paid by the day it fell on, so an extra Saturday C1 is not priced like an extra Wednesday C1. A number under M–Th C1 does NOT mean the provider is over any M–Th C1 limit — there is no per-day-type or per-code cap here, only the one total. WHICH calls are tagged (2026-07-29): the SMALLEST-weight set of their assignments that brings the rest back to the obligation, later dates winning a tie — so a 12h half (0.5) is tagged ahead of a whole call when a half is all they are over by. Read the size of the overage off the Over By column, NOT off these: a tagged whole call can weigh more than the overage when no smaller combination fits. The stored call par level is the denominator (par-authoritative; never reduced to the pool's summed FTE) — the engine's obligatory-mode denominator. Every call slot counts toward the obligation — holiday-dated included, billed as the day of the week it fell on. Calls up to the obligation are never extra — extras are the paid-pickup layer. Same selection as the red grid cells. Deficit carry-forward is not included. These columns are the SAME columns, in the same order, as the counts half on the left — including the neuro group at the end, whose extras stay split by day because a Saturday neuro pickup is not priced like a Sunday one.">
                  Calls Beyond Total Obligation<br/>
                  <span style={{ fontSize: 10, fontWeight: 500, opacity: 0.8 }}>
                    tagged by day for pricing — not a per-day limit
                  </span>
                </th>
              )}
              <th rowSpan={2} style={{
                padding: '6px 10px', textAlign: 'center', fontWeight: 700,
                borderBottom: '1px solid var(--border)', borderLeft: '1px solid var(--border)',
              }} title="Rounded total obligation: round(total call slots ÷ par × FTE), rounding half up — 1.5 owes 2, 1.3 owes 1. The stored call par level is the denominator (par-authoritative; never reduced to the pool's summed FTE), matching the engine's obligatory-mode cap — assuming a full roster at par, this is what each person owes; calls past it are paid pickups. Hover a value for the fractional expected behind it.">
                Obligation
              </th>
              <th rowSpan={2} style={{
                padding: '6px 10px', textAlign: 'center', fontWeight: 700,
                borderBottom: '1px solid var(--border)', borderLeft: '1px solid var(--border)',
              }}>Call Total</th>
              {/* The SIZE of the overage, beside the calls tagged for it. A
                  tagged whole call is not a whole call's worth of excess —
                  it is the smallest assignment that covers the gap. */}
              <th rowSpan={2} style={{
                padding: '6px 10px', textAlign: 'center', fontWeight: 700,
                borderBottom: '1px solid var(--border)', borderLeft: '1px solid var(--border)',
                color: '#ef4444', cursor: 'help',
              }} title="How far past the obligation the provider actually is: Call Total − Obligation, in call units (a 12h split is 0.5, an 8h third 0.3333). THIS is the size of the overage. The tagged calls to the left are the smallest set of whole assignments that covers it, so their weight can be LARGER than this — 1.0 tagged against a 0.7 overage when no smaller combination fits. Blank at or under the obligation.">
                Over By
              </th>
              <th rowSpan={2} style={{
                padding: '6px 10px', textAlign: 'center', fontWeight: 700,
                borderBottom: '1px solid var(--border)', borderLeft: '1px solid var(--border)',
                cursor: 'help',
              }} title={`actual / required weekend DUTIES. A duty is one of two things, counted two ways: (1) one PRIMARY-call weekend day — first call (call_rank 0) on a Friday, Saturday or Sunday, counted per DAY, so an 11-week block stands 11 Fri + 11 Sat + 11 Sun = 33; a 12h split half of one counts 0.5. The weekend C2/C3 tiers are not separately owed — they ride along on the block chain. (2) one NEURO weekend${neuroCode ? ` (${neuroCode})` : ''}, counted per Sat+Sun PAIR — 11 pairs in an 11-week block = 11 units, and a single neuro weekend day is 0.5.${neuroCode ? '' : ' This site states no neuro weekend, so the column is primary-call days only.'} Required = duty units ÷ par × FTE, rounded DOWN to the nearest half: this block holds ${formatCallWeight(weekendUnits)} units at par ${fmtFte(census.effectivePar)}. At Paoli (33 + 11 = 44 ÷ 11 = 4 per full FTE) a 1.0 FTE owes 4, a 0.75 FTE 3, a 0.5 FTE 2. Red = past the obligation; with the pool below par those extra weekends are the paid-pickup layer, same as extra calls.`}>
                Obligatory Weekends<br/><span style={{ fontSize: 10, fontWeight: 500, opacity: 0.7 }}>actual / required</span>
              </th>
              <th rowSpan={2} style={{
                padding: '6px 10px', textAlign: 'center', fontWeight: 700,
                borderBottom: '1px solid var(--border)', borderLeft: '1px solid var(--border)',
                color: '#fbbf24',
              }}>PTO Days<br/><span style={{ fontSize: 10, fontWeight: 500, opacity: 0.7 }}>(M–F only)</span></th>
              <th rowSpan={2} style={{
                padding: '6px 10px', textAlign: 'center', fontWeight: 700,
                borderBottom: '1px solid var(--border)', borderLeft: '1px solid var(--border)',
                cursor: 'help',
              }} title={`Entitled weekday days off this block from the WORKING-DAYS FTE fraction: block working days (M–F minus major holidays, ${composition.workingDays} this block) − PTO days − required, where required = round(working-days FTE × working days) − PTO days (the engine's working-days contract). The working-days FTE is the provider's call FTE unless a separate one is stated on their profile — the call FTE pro-rates CALL only. PTO days = the PTO Days column's tally. A full working-days contract computes to 0 (—).`}>
                Days Off
              </th>
              <th rowSpan={2} style={{
                padding: '6px 10px', textAlign: 'center', fontWeight: 700,
                borderBottom: '1px solid var(--border)', borderLeft: '1px solid var(--border)',
                cursor: 'help',
              }} title="actual / required. Actual = credited M–F working days scheduled on this draft: distinct working days (weekdays minus major holidays) with any assignment, plus post-call rest days credited as worked, plus ICU rotation weekdays — the generation banner's working-days credit. Required = the engine's obligation: round(working-days FTE × block working days) − PTO days, or the stated Limits-tab working-days/days-off override when one is set. The working-days FTE is the provider's call FTE unless a separate one is stated on their profile (Providers → Scheduling → Employment) — the call FTE pro-rates CALL only. Red = scheduled past the requirement.">
                Working Days<br/><span style={{ fontSize: 10, fontWeight: 500, opacity: 0.7 }}>actual / required</span>
              </th>
            </tr>
            <tr style={{ background: 'var(--bg)', color: 'var(--text-muted)' }}>
              {/* Sub-header: the CODE under a day group, the DAY under the
                  neuro group — the transposition, in one field. */}
              {columns.map((col, i) => (
                <th key={col.key} style={{
                  padding: '4px 8px', textAlign: 'center', fontWeight: 700,
                  borderBottom: '1px solid var(--border)',
                  borderLeft: isGroupStart(i) ? '1px solid var(--border)' : 'none',
                  color: codeColor(col.code),
                }}>{col.subLabel}</th>
              ))}
              {/* Extra columns carry BOTH labels in their own header — no group
                  header sits above them to supply the first. Stacked on two
                  lines so 10 of them still fit a printed page, and stacked
                  group-over-sub so this half reads exactly like the counts half
                  above: "Sat / C1" in a day group, "C3 / Sat" in the neuro one. */}
              {columns.map((col, i) => (
                <th key={`extra|${col.key}`} title={col.label} style={{
                  padding: '4px 6px', textAlign: 'center', fontWeight: 700,
                  borderBottom: '1px solid var(--border)',
                  borderLeft: isGroupStart(i) ? '1px solid var(--border)' : 'none',
                  color: codeColor(col.code), whiteSpace: 'nowrap', lineHeight: 1.25,
                }}>
                  <span style={{ fontSize: 10, fontWeight: 600, opacity: 0.85, color: 'var(--text-muted)' }}>
                    {col.groupLabel}
                  </span><br/>{col.subLabel}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {providers.map(p => (
              <tr key={p.id} style={{ borderBottom: '1px solid var(--border)' }}>
                <td
                  onClick={onFocusProvider ? () => onFocusProvider(p.id) : undefined}
                  title={onFocusProvider ? `Highlight ${p.short_display_name}'s days on the grid` : undefined}
                  style={{
                    padding: '6px 10px', color: 'var(--text)', fontWeight: 500,
                    cursor: onFocusProvider ? 'pointer' : undefined,
                  }}
                >
                  {p.short_display_name}
                  {fteByPid[p.id] != null && (
                    <span style={{ opacity: 0.7, fontSize: 11, marginLeft: 5 }}>
                      · {fmtFte(fteByPid[p.id])}
                    </span>
                  )}
                </td>
                {columns.map((col, i) => {
                  const n = getCount(p.id, col.key);
                  return (
                    <td key={col.key} style={{
                      padding: '6px 8px', textAlign: 'center', whiteSpace: 'nowrap',
                      color: n === 0 ? 'var(--text-dim)' : 'var(--text)',
                      borderLeft: isGroupStart(i) ? '1px solid var(--border)' : 'none',
                      fontWeight: n > 0 ? 600 : 400,
                    }}>
                      {n ? formatCallWeight(n) : '—'}
                    </td>
                  );
                })}
                {columns.map((col, i) => {
                  const n = getExtra(p.id, col.bucket, col.code);
                  return (
                    <td key={`extra|${col.key}`}
                      title={n ? `${formatCallWeight(n)} extra ${col.code} worked on ${BUCKET_LABELS[col.bucket]} — priced as a ${BUCKET_LABELS[col.bucket]} pickup` : undefined}
                      style={{
                        padding: '6px 8px', textAlign: 'center',
                        color: n === 0 ? 'var(--text-dim)' : '#ef4444',
                        borderLeft: isGroupStart(i) ? '1px solid var(--border)' : 'none',
                        fontWeight: n > 0 ? 700 : 400,
                      }}>{n ? formatCallWeight(n) : '—'}</td>
                  );
                })}
                <td
                  title={`Fractional expected: ${rowExpected(p.id).toFixed(2)}`}
                  style={{
                    padding: '6px 10px', textAlign: 'center',
                    borderLeft: '1px solid var(--border)', fontWeight: 700,
                    color: 'var(--text)', cursor: 'help',
                  }}
                >{rowObligation(p.id)}</td>
                <td style={{
                  padding: '6px 10px', textAlign: 'center',
                  borderLeft: '1px solid var(--border)', fontWeight: 700, color: 'var(--text)',
                }}>{formatCallWeight(rowTotal(p.id))}</td>
                <td
                  title={rowOverBy(p.id) > 0
                    ? `Over the obligation by ${formatCallWeight(rowOverBy(p.id))} of a call (${formatCallWeight(rowTotal(p.id))} held − ${rowObligation(p.id)} owed). The tagged calls on the left are the smallest set that covers it.`
                    : undefined}
                  style={{
                    padding: '6px 10px', textAlign: 'center', fontWeight: 700,
                    borderLeft: '1px solid var(--border)',
                    color: rowOverBy(p.id) > 0 ? '#ef4444' : 'var(--text-dim)',
                    cursor: rowOverBy(p.id) > 0 ? 'help' : undefined,
                  }}
                >{rowOverBy(p.id) > 0 ? formatCallWeight(rowOverBy(p.id)) : '—'}</td>
                <td
                  title={`Held ${formatCallWeight(weekendsForPid(p.id))} of ${formatCallWeight(requiredWeekendsForPid(p.id))} obligatory weekend duties (unrounded requirement ${expectedWeekendsForPid(p.id).toFixed(2)}, taken DOWN to the nearest half). Actual = primary-call weekend days held (a 12h half counts 0.5) + neuro weekend units held (a Sat+Sun pair 1, a single neuro day 0.5).`}
                  style={{
                    padding: '6px 10px', textAlign: 'center', whiteSpace: 'nowrap',
                    borderLeft: '1px solid var(--border)', fontWeight: 600, cursor: 'help',
                    color: weekendsOver(p.id) ? '#ef4444'
                      : weekendsForPid(p.id) > 0 || requiredWeekendsForPid(p.id) > 0 ? 'var(--text)' : 'var(--text-dim)',
                  }}
                >
                  {weekendsForPid(p.id) || requiredWeekendsForPid(p.id)
                    ? `${formatCallWeight(weekendsForPid(p.id))} / ${formatCallWeight(requiredWeekendsForPid(p.id))}`
                    : '—'}
                </td>
                <td style={{
                  padding: '6px 10px', textAlign: 'center',
                  borderLeft: '1px solid var(--border)', fontWeight: 600,
                  color: ptoDaysForPid(p.id) > 0 ? '#fbbf24' : 'var(--text-dim)',
                }}>{ptoDaysForPid(p.id) || '—'}</td>
                <td style={{
                  padding: '6px 10px', textAlign: 'center',
                  borderLeft: '1px solid var(--border)', fontWeight: 600,
                  color: daysOffForPid(p.id) > 0 ? 'var(--text)' : 'var(--text-dim)',
                }}>{daysOffForPid(p.id) || '—'}</td>
                <td
                  title={`Scheduled ${workingDaysForPid(p.id)} of ${requiredForPid(p.id)} required working days`}
                  style={{
                    padding: '6px 10px', textAlign: 'center', whiteSpace: 'nowrap',
                    borderLeft: '1px solid var(--border)', fontWeight: 600,
                    color: workingDaysForPid(p.id) > requiredForPid(p.id) ? '#ef4444'
                      : workingDaysForPid(p.id) > 0 || requiredForPid(p.id) > 0 ? 'var(--text)' : 'var(--text-dim)',
                  }}
                >
                  {workingDaysForPid(p.id) || requiredForPid(p.id)
                    ? `${workingDaysForPid(p.id)} / ${requiredForPid(p.id)}`
                    : '—'}
                </td>
              </tr>
            ))}
            {/* Totals row */}
            <tr style={{ background: 'var(--bg)', fontWeight: 700, color: 'var(--text)' }}>
              <td style={{ padding: '8px 10px', borderTop: '2px solid var(--border)' }}>Total</td>
              {columns.map((col, i) => {
                const t = colTotal(col.key);
                return (
                  <td key={`total-${col.key}`} style={{
                    padding: '8px 10px', textAlign: 'center',
                    borderLeft: isGroupStart(i) ? '1px solid var(--border)' : 'none',
                    borderTop: '2px solid var(--border)',
                  }}>{t ? formatCallWeight(t) : '—'}</td>
                );
              })}
              {columns.map((col, i) => {
                const t = colExtraTotal(col.bucket, col.code);
                return (
                  <td key={`total-extra|${col.key}`} style={{
                    padding: '8px 10px', textAlign: 'center',
                    borderLeft: isGroupStart(i) ? '1px solid var(--border)' : 'none',
                    borderTop: '2px solid var(--border)',
                    color: '#ef4444',
                  }}>{t ? formatCallWeight(t) : '—'}</td>
                );
              })}
              <td style={{
                padding: '8px 10px', textAlign: 'center',
                borderLeft: '1px solid var(--border)', borderTop: '2px solid var(--border)',
              }}>{providers.reduce((s, p) => s + rowObligation(p.id), 0)}</td>
              <td style={{
                padding: '8px 10px', textAlign: 'center',
                borderLeft: '1px solid var(--border)', borderTop: '2px solid var(--border)',
              }}>{formatCallWeight(providers.reduce((s, p) => s + rowTotal(p.id), 0))}</td>
              <td style={{
                padding: '8px 10px', textAlign: 'center',
                borderLeft: '1px solid var(--border)', borderTop: '2px solid var(--border)',
                color: '#ef4444',
              }}>{(() => {
                const t = providers.reduce((s, p) => s + rowOverBy(p.id), 0);
                return t > 0 ? formatCallWeight(t) : '—';
              })()}</td>
              <td style={{
                padding: '8px 10px', textAlign: 'center', whiteSpace: 'nowrap',
                borderLeft: '1px solid var(--border)', borderTop: '2px solid var(--border)',
              }}>{(() => {
                const a = providers.reduce((s, p) => s + weekendsForPid(p.id), 0);
                const r = providers.reduce((s, p) => s + requiredWeekendsForPid(p.id), 0);
                return a || r ? `${formatCallWeight(a)} / ${formatCallWeight(r)}` : '—';
              })()}</td>
              <td style={{
                padding: '8px 10px', textAlign: 'center',
                borderLeft: '1px solid var(--border)', borderTop: '2px solid var(--border)',
                color: '#fbbf24',
              }}>{providers.reduce((s, p) => s + ptoDaysForPid(p.id), 0) || '—'}</td>
              <td style={{
                padding: '8px 10px', textAlign: 'center',
                borderLeft: '1px solid var(--border)', borderTop: '2px solid var(--border)',
              }}>{providers.reduce((s, p) => s + daysOffForPid(p.id), 0) || '—'}</td>
              <td style={{
                padding: '8px 10px', textAlign: 'center', whiteSpace: 'nowrap',
                borderLeft: '1px solid var(--border)', borderTop: '2px solid var(--border)',
              }}>{(() => {
                const a = providers.reduce((s, p) => s + workingDaysForPid(p.id), 0);
                const r = providers.reduce((s, p) => s + requiredForPid(p.id), 0);
                return a || r ? `${a} / ${r}` : '—';
              })()}</td>
            </tr>
            {/* Expected row — Σ of per-provider FTE-weighted targets (from slot counts,
                at the stored par — par-authoritative 2026-07-24). A gap vs Total now
                ALSO legitimately means the paid-pickup layer: with the pool's ΣFTE
                below the par, expected covers less than the slot count by design. */}
            <tr style={{ color: 'var(--text-dim)', fontWeight: 600 }}
                title="Sum of each provider's FTE-weighted target: (bucket slot count ÷ par) × FTE, at the stored call par level (par-authoritative — never reduced to the pool's summed FTE). A gap versus Total legitimately means the paid-pickup layer (pool ΣFTE below the par under-covers by design), slots in that column are unfilled, a stored par above/below the pool, or calls on a call code outside C1–C3 (which has no bucket column; holiday-dated calls DO have one — they count under the day of the week they fall on) — check the coverage line in the header and the grid before concluding under-staffing.">
              <td style={{ padding: '6px 10px' }}>Expected</td>
              {columns.map((col, i) => {
                const exp = colExpected(col.key);
                return (
                  <td key={`exp-${col.key}`} style={{
                    padding: '6px 8px', textAlign: 'center',
                    borderLeft: isGroupStart(i) ? '1px solid var(--border)' : 'none',
                  }}>{exp >= EXPECTED_DISPLAY_MIN ? exp.toFixed(1) : '—'}</td>
                );
              })}
              {columns.map((col, i) => (
                <td key={`exp-extra|${col.key}`} style={{
                  padding: '6px 8px', textAlign: 'center',
                  borderLeft: isGroupStart(i) ? '1px solid var(--border)' : 'none',
                }}>—</td>
              ))}
              <td
                title="Sum of the fractional expected values before rounding — compare with the rounded Obligation total above."
                style={{ padding: '6px 10px', textAlign: 'center', borderLeft: '1px solid var(--border)', cursor: 'help' }}
              >
                {providers.reduce((s, p) => s + rowExpected(p.id), 0).toFixed(1)}
              </td>
              <td style={{ padding: '6px 10px', textAlign: 'center', borderLeft: '1px solid var(--border)' }}>
                {providers.reduce((s, p) => s + rowExpected(p.id), 0).toFixed(1)}
              </td>
              {/* Over By has no "expected" — an overage is by definition the
                  part with no expectation behind it. */}
              <td style={{ padding: '6px 10px', textAlign: 'center', borderLeft: '1px solid var(--border)' }}>—</td>
              <td
                title={`Sum of the fractional weekend obligations before rounding, out of ${formatCallWeight(weekendUnits)} weekend units in the block — a gap is the paid-pickup layer (pool ΣFTE below the par).`}
                style={{ padding: '6px 10px', textAlign: 'center', borderLeft: '1px solid var(--border)', cursor: 'help' }}
              >
                {providers.reduce((s, p) => s + expectedWeekendsForPid(p.id), 0).toFixed(1)}
              </td>
              <td style={{ padding: '6px 10px', textAlign: 'center', borderLeft: '1px solid var(--border)' }}>—</td>
              <td style={{ padding: '6px 10px', textAlign: 'center', borderLeft: '1px solid var(--border)' }}>—</td>
              <td style={{ padding: '6px 10px', textAlign: 'center', borderLeft: '1px solid var(--border)' }}>—</td>
            </tr>
          </tbody>
        </table>

        {/* ── Coverage to find (Gabriel 2026-07-29) ──────────────────────────
            "a count of the expected total number of each call I will need to
            find coverage for based on the length of the block and the pool of
            providers". Structural, not a read of the current draft: it is the
            call NOBODY owes, computable before a single assignment exists.
            Par-authoritative — a pool below the par under-covers by design and
            the remainder is the paid-pickup layer. */}
        {(() => {
          const forecast = computeCoverageForecast(census, grid.providers.map(p => p.id));
          const bucketLabel: Record<string, string> = {
            weekday: 'M–Th', friday: 'Fri', saturday: 'Sat', sunday: 'Sun',
          };
          const pct = Math.round(forecast.uncoveredShare * 1000) / 10;
          return (
            <div style={{ marginTop: 22 }}>
              <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--text)', marginBottom: 4 }}>
                Coverage to find
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
                {forecast.poolFte.toFixed(2)} pool FTE against a par of {forecast.par} —{' '}
                {pct}% of every call has no one who owes it.{' '}
                <strong style={{ color: 'var(--text)' }}>
                  {forecast.obligationGap} call{forecast.obligationGap === 1 ? '' : 's'}
                </strong>{' '}
                to cover across the block once everyone has met their obligation.
              </div>
              {!forecast.bucketed ? (
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  Per-call breakdown unavailable — a call slot in this block has no day type.
                </div>
              ) : (
                <table style={{ borderCollapse: 'collapse', fontSize: 12.5 }}>
                  <thead>
                    <tr style={{ color: 'var(--text-muted)', textAlign: 'left' }}>
                      <th style={{ padding: '4px 12px 4px 0', fontWeight: 700 }}>Call</th>
                      <th style={{ padding: '4px 12px', fontWeight: 700, textAlign: 'center' }}>In block</th>
                      <th style={{ padding: '4px 12px', fontWeight: 700, textAlign: 'center' }}>Pool owes</th>
                      <th style={{ padding: '4px 12px', fontWeight: 700, textAlign: 'center' }}>Need coverage</th>
                    </tr>
                  </thead>
                  <tbody>
                    {forecast.rows.map(r => (
                      <tr key={`${r.bucket}|${r.code}`} style={{ borderTop: '1px solid var(--border)' }}>
                        <td style={{ padding: '4px 12px 4px 0', fontWeight: 700, color: 'var(--text)' }}>
                          {bucketLabel[r.bucket] ?? r.bucket} {r.code}
                        </td>
                        <td style={{ padding: '4px 12px', textAlign: 'center' }}>{formatCalls(r.slots)}</td>
                        <td style={{ padding: '4px 12px', textAlign: 'center', color: 'var(--text-muted)' }}>
                          {formatCalls(r.covered)}
                        </td>
                        <td style={{ padding: '4px 12px', textAlign: 'center', fontWeight: 800, color: gridTokens.openCall }}>
                          {formatCalls(r.needCoverage)}
                        </td>
                      </tr>
                    ))}
                    <tr style={{ borderTop: '2px solid var(--border)', fontWeight: 800 }}>
                      <td style={{ padding: '5px 12px 5px 0', color: 'var(--text)' }}>Total</td>
                      <td style={{ padding: '5px 12px', textAlign: 'center' }}>{formatCalls(forecast.totals.slots)}</td>
                      <td style={{ padding: '5px 12px', textAlign: 'center', color: 'var(--text-muted)' }}>
                        {formatCalls(forecast.totals.covered)}
                      </td>
                      <td
                        title={`Fractional total. Obligations round per provider, so the exact number obligatory generation leaves open is ${forecast.obligationGap}.`}
                        style={{ padding: '5px 12px', textAlign: 'center', color: gridTokens.openCall, cursor: 'help' }}
                      >
                        {formatCalls(forecast.totals.needCoverage)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              )}
            </div>
          );
        })()}
        </div>
      </div>
    </div>
  );
}
