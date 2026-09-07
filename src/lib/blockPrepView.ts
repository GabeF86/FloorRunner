// Block Prep board VIEW logic — the decisions the board makes that could be
// wrong, kept next to a test. The page component is markup over these.
// (vitest runs environment:'node' with no jsdom, so a component is not
// unit-testable; same split blockTargetsPanel.ts established.)
//
// The rules that matter here:
//
// 1. BLANK IS NOT ZERO, IN BOTH DIRECTIONS. A null PTO allotment renders an
//    em-dash and a "not stated" caption; a typed 0 renders "0". Parsing goes
//    the same way: blank -> null, "0" -> 0. Collapsing either into the other
//    is the bug this board exists to stop.
//
// 2. NEVER SHOW A NUMBER THAT WASN'T COUNTED. Off days used is null when no
//    published block covers the year, and the label says so rather than
//    printing a 0 that reads as "took no days off".
//
// 3. AN OVERDRAWN BALANCE IS SHOWN, NOT CLAMPED. Someone 5 days past their
//    allotment reads "5 over", because that is a thing a chief needs to see.

// CoveredSpanInfo is annualTally's exported span shape { start, end,
// workingDays, segments }. Imported, never restated — `segments` carries the
// individual published blocks so a gapped range can never render as
// continuous coverage.
import type {
  CallCount, CoveredSpanInfo, OffDayBudget, PtoFigures,
} from './annualTally';
// FTE bounds are owned by validation/providers.ts (the DB CHECK, the API
// validator and the profile editor all key off these two pairs) — imported
// rather than hand-copied so the board is a fourth home wired to the same
// numbers, not a fourth number that happens to agree today.
import {
  AVAILABILITY_TYPE_LABELS, FTE_MAX, FTE_MIN, WORK_DAYS_FTE_MAX, WORK_DAYS_FTE_MIN,
  type AvailabilityType,
} from './validation/providers';
// ICU rotation rows are PAIRED (a week row + its post-call Monday).
// icuRowLockInfo below routes the actual pairing decision through
// icuRotation.ts's own `pairIcuRows` rather than re-deriving it, so the
// drawer can never disagree with the profile's ICU section about which rows
// are genuinely paired. `icuMondayAfter` is needed separately for the
// year-boundary proof (see icuPairsFor/icuRowLockInfo below) — the drawer's
// row set is year-scoped, so "partner absent from what I fetched" is not the
// same fact as "partner does not exist".
import {
  ICU_WEEK_REASON, ICU_POST_CALL_REASON, icuMondayAfter, pairIcuRows,
  type IcuAvailabilityRow, type IcuPair,
} from './icuRotation';
// The sell-back "standalone" note below is a straight port of the profile's
// own decision (providers/[id]/page.tsx's sellbackNotes) — same imports, so
// the two can never compute a different answer for the same rows.
import { addDays, BLOCKING_AVAIL, effectivePtoRange, isDismissedAvailability } from './rulesEngine/shared';

export interface RosterRow {
  provider_id: string;
  display_name: string;
  last_name: string;
  fte_value: number | null;
  work_days_fte: number | null;
  pto_weeks: number | null;
  call_taker: boolean;
  partial_call_taker: boolean;
  pto: PtoFigures;
  /** Tagged union — 'none' (a full-timer owes every working day) and
   *  'not-applicable' (a per diem owes none) are different facts and render
   *  differently. Never guessed from a missing FTE. */
  offDayBudget: OffDayBudget;
  offDaysUsed: number | null;
  callCounts: CallCount[];
  callTotal: number;
}

/**
 * FTE descending, then last name. A null (unstated) FTE sorts last, after
 * even a stated 0 — a per diem is a known quantity; an unstated FTE is a data
 * gap that belongs at the bottom where it reads as needing attention. Uses
 * `Number.NEGATIVE_INFINITY` rather than a magic sentinel like `-1`, which
 * would only happen to sort last because `FTE_MIN` is 0 today.
 */
export function sortRosterRows(rows: ReadonlyArray<RosterRow>): RosterRow[] {
  return [...rows].sort((a, b) => {
    const fa = a.fte_value ?? Number.NEGATIVE_INFINITY;
    const fb = b.fte_value ?? Number.NEGATIVE_INFINITY;
    if (fa !== fb) return fb - fa;
    return a.last_name.localeCompare(b.last_name);
  });
}

/** The allotment cell. Em-dash for unstated; "0" for a real zero. */
export function allotmentText(ptoWeeks: number | null): string {
  return ptoWeeks == null ? '—' : String(ptoWeeks);
}

// Shared verbatim between remainingText below and rosterFooterNote further
// down, so the roster card's legend can describe what the annual tally says
// without a second copy of the phrase drifting from this one (Fix M1,
// review 2026-09-06 — the footer used to claim the tally prints an em dash,
// which nothing does; remainingText is what the tally's PTO column actually
// calls).
const ALLOTMENT_NOT_STATED = 'allotment not stated';

/** The PTO cell caption. */
export function remainingText(pto: PtoFigures): string {
  const sold = pto.soldWeekdays > 0 ? ` (incl. ${pto.soldWeekdays} sold back)` : '';
  // allotmentDays and remainingDays are null together or not at all — the
  // invariant PtoFigures documents. No `?? 0` fallback here: a fallback could
  // only fire if that invariant were broken, and it would silently print
  // "0 left" instead of failing loudly.
  if (pto.allotmentDays == null || pto.remainingDays == null) {
    return `${pto.usedWeekdays} used${sold} · ${ALLOTMENT_NOT_STATED}`;
  }
  const rem = pto.remainingDays;
  const tail = rem < 0 ? `${Math.abs(rem)} over` : `${rem} left`;
  return `${pto.usedWeekdays} of ${pto.allotmentDays} used${sold} · ${tail}`;
}

/**
 * The off-days cell. Four states, and the two that both mean "zero days" are
 * deliberately different strings: a 1.0 FTE has NO off days because they owe
 * every working day; a per diem has none because they owe nothing at all, so
 * the concept doesn't apply (Gabriel 2026-09-06: "n/a for gorelick").
 *
 * `used === 0` is a GENUINE counted zero here, not "nothing was counted" —
 * annualTally.computeAnnualTally returns `offDaysUsed: null` (never 0) when
 * no published block covers the year or a covered block clips to zero
 * working days, so by the time a literal `0` reaches this function it means
 * a real span was examined and the provider took none of their budgeted off
 * days across it. "0 of N used" is therefore the correct, honest string —
 * pinned by a test, not left to drift into a "not counted" reading.
 *
 * OVERDRAWN IS SHOWN, NOT CLAMPED (Fix 4, round 7 review) — this module's own
 * rule at the top of the file, but it used to be implemented in
 * `remainingText` (PTO) alone: a provider 2 days past their off-day budget
 * read as a bare "14 of 12 used", with nothing telling the reader that's an
 * overdraw, while the adjacent PTO column for the same overdraw reads
 * "25 of 20 used · 5 over". Mirrors that exact "· N over" tail so the two
 * adjacent columns read consistently.
 */
export function offDaysText(budget: OffDayBudget, used: number | null): string {
  switch (budget.kind) {
    case 'unknown':        return 'FTE not stated';
    case 'not-applicable': return 'n/a';
    case 'none':           return 'none';
    case 'days': {
      if (used == null) return `${budget.days} budgeted`;
      const over = used - budget.days;
      return over > 0 ? `${used} of ${budget.days} used · ${over} over` : `${used} of ${budget.days} used`;
    }
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Deliberately NOT named `shortDate` — src/lib/availableCalls.ts already
// exports a `shortDate(iso)` with a different format ("10/17"); two
// `shortDate`s in src/lib producing different strings would be a readability
// trap. Pure string-splitting (no Date construction) so no timezone can shift
// the label off the date the row actually belongs to — the same rationale
// availableCalls.ts documents for its own. A reviewer found four other local
// closures producing this same "Aug 10, 2026" shape elsewhere in the app;
// this one is judged the best of the five for the same no-timezone reason,
// but extracting a shared home is a refactor beyond this module's scope.
//
// EXPORTED (round 7 review) — AvailabilityDrawer.tsx needs this exact
// formatting and was told it was already exported; it wasn't. If you're
// reading this while `AvailabilityDrawer.tsx` still carries its own local
// stopgap copy, that copy is meant to be deleted in favor of this import.
export function monthDayYear(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${MONTHS[Number(m) - 1]} ${Number(d)}, ${y}`;
}

/**
 * The honesty caveat under the off-days column. Off days can only be counted
 * where a schedule exists; this names the span so nobody reads the figure as a
 * full-year number.
 *
 * THE TWO TIME SCALES ARE THE ROOT CONFUSION THIS EXISTS TO NAME (Fix 1, round
 * 7 review). `offDaysText` renders "{used} of {budget} used", but the
 * NUMERATOR is counted only across published blocks while the DENOMINATOR is
 * the full calendar year — at Paoli today (one published 2026 block, Aug
 * 10 – Oct 25, ~54 of ~255 working days) a 0.7 FTE reads "10 of 76 used",
 * which reads as "66 off days left this year" when 201 working days were
 * never examined at all. Every branch below therefore says BOTH halves
 * explicitly — "the budget is for the full year" AND "used is counted only
 * across published blocks" — rather than naming just the span, which is what
 * this function used to do and why the confusion survived a caption right
 * next to the number it was supposed to explain.
 *
 * THE GAP CASE IS THE WHOLE POINT. When the year's published blocks are
 * disjoint — a draft block sitting between two published ones is enough — the
 * start–end range OVERSTATES coverage badly: two blocks at either end of the
 * year read as "Jan 5 – Dec 20" while covering half the working days. So the
 * label must say how many blocks it counted whenever there is more than one
 * segment, and never present a gapped range as a continuous one.
 *
 * INVARIANT THIS RELIES ON (enforced by the caller, not here): `span` comes
 * from `annualTally.coveredSpanFor`, which clips every segment to the
 * requested calendar year before this function ever sees it — so
 * `span.start` and `span.end` always share one year. The `.replace(/,
 * \d{4}$/, '')` below, which drops the leading year off `start` so the range
 * reads "Jan 5 – Dec 20, 2026" rather than "Jan 5, 2026 – Dec 20, 2026",
 * depends on that: a span straddling a year boundary would render backwards
 * ("Dec 28 – Jan 10, 2027"). Not reachable today because of the caller
 * invariant, but this function does not itself check it.
 *
 * Rendered by BOTH cards that show the off-days column (AnnualTallyCard and,
 * as of Fix 1, RosterCard) — a caveat this load-bearing must appear
 * everywhere the fraction it explains does, not just wherever it happened to
 * be added first.
 */
export function coveredSpanLabel(span: CoveredSpanInfo | null): string {
  if (!span) {
    return 'The off-day budget is for the full year — no published block exists yet, so nothing has been '
      + 'examined and no days are counted as used.';
  }
  // A published span that contains no working days (e.g. clipped to a single
  // major holiday) is NOT the same as nothing being published, and must not
  // read as "0 days off taken". Worded number-agnostically because this
  // branch precedes the segments check below — a multi-block span can also
  // clip to zero working days.
  if (span.workingDays === 0) {
    return 'The off-day budget is for the full year — the published coverage here includes no working days, '
      + 'so nothing has been examined and no days are counted as used.';
  }
  const start = monthDayYear(span.start).replace(/, \d{4}$/, '');
  const range = `${start} – ${monthDayYear(span.end)}`;
  if (span.segments.length > 1) {
    return `The off-day budget is for the full year; days used are counted only across ${span.segments.length} `
      + `published blocks, with gaps between them: ${range} (${span.workingDays} working days counted).`;
  }
  return `The off-day budget is for the full year; days used are counted only across the published block: `
    + `${range} (${span.workingDays} working days).`;
}

/**
 * The unrostered-provider footnote (AnnualTallyCard, Fix 3 2026-09-06): the
 * only thing standing between a chief and a silently vanished call count. Ids
 * come from `BlockPrepData.unrosteredProviderIds` — providers with published
 * call at the site who have no row on the roster (inactive mid-year, based
 * elsewhere, or not flagged a call taker; live example: Orji at Paoli).
 *
 * Null for null (the roster read failed — `unrosteredProviderIds` carries no
 * information in that case, there is nothing honest to footnote) AND for an
 * empty array (loaded fine, nobody was excluded). Those are different facts
 * one level up (`BlockPrepData` distinguishes them deliberately), but
 * downstream of THIS function they render identically: no footnote. Only a
 * non-empty array produces a sentence.
 */
export function unrosteredFootnote(ids: ReadonlyArray<string> | null): string | null {
  if (!ids || ids.length === 0) return null;
  const n = ids.length;
  const provider = n === 1 ? 'provider' : 'providers';
  const hold = n === 1 ? 'holds' : 'hold';
  const is = n === 1 ? 'is' : 'are';
  return `${n} ${provider} ${hold} published call at this site but ${is} not on the roster above — `
    + 'inactive, based at another site, or not marked a call taker. Those calls are not shown in '
    + 'any row.';
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Which FTE field is being parsed — selects both the bounds and the blank
 * policy, so a caller cannot pass a mismatched pair (e.g. a call FTE's bounds
 * with working-days FTE's blank-is-legal rule). `'call'` uses
 * FTE_MIN..FTE_MAX (0..2, the "odd partner working two jobs" headroom) and is
 * mandatory. `'workDays'` uses WORK_DAYS_FTE_MIN..WORK_DAYS_FTE_MAX (0..1,
 * narrower because nobody owes more working days than a block has) and may
 * be blank, meaning "same as call FTE".
 */
export type FteFieldKind = 'call' | 'workDays';

const FTE_FIELD_BOUNDS: Record<FteFieldKind, { min: number; max: number; allowBlank: boolean }> = {
  call: { min: FTE_MIN, max: FTE_MAX, allowBlank: false },
  workDays: { min: WORK_DAYS_FTE_MIN, max: WORK_DAYS_FTE_MAX, allowBlank: true },
};

/**
 * Parse an FTE cell. Bounds and blank policy come from `FTE_FIELD_BOUNDS`,
 * itself sourced from validation/providers.ts's FTE_MIN/FTE_MAX and
 * WORK_DAYS_FTE_MIN/WORK_DAYS_FTE_MAX — the same constants the DB CHECK, the
 * API validator and the profile editor already key off, so this is a fourth
 * home wired to one set of numbers rather than a fourth number.
 */
export function parseFteInput(raw: string, kind: FteFieldKind): ParseResult<number | null> {
  const { min, max, allowBlank } = FTE_FIELD_BOUNDS[kind];
  const s = raw.trim();
  if (s === '') {
    return allowBlank
      ? { ok: true, value: null }
      : { ok: false, error: 'FTE is required' };
  }
  const n = Number(s);
  if (!Number.isFinite(n) || n < min) return { ok: false, error: `Must be ${min} or more` };
  if (n > max) return { ok: false, error: `Must be ${max} or less` };
  return { ok: true, value: n };
}

/**
 * Parse the PTO allotment cell. Blank -> null (not stated); "0" -> 0 (real).
 *
 * Mirrors validation/providers.ts's own check for `pto_weeks`
 * (`!Number.isInteger(n) || n < 0`) rather than importing a constant, because
 * there isn't one to import: that file has no dedicated FTE_MIN/FTE_MAX-style
 * export for this field — its inline check is shared, un-exported, across
 * several unrelated integer columns (pto_weeks, max_weekly_hours,
 * max_monthly_calls, max_consecutive_calls, years_with_group). Checked as
 * part of this fix; nothing to wire to.
 */
export function parseAllotmentInput(raw: string): ParseResult<number | null> {
  const s = raw.trim();
  if (s === '') return { ok: true, value: null };
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0) return { ok: false, error: 'Must be a whole number of weeks' };
  return { ok: true, value: n };
}

// ── Roster card editable-cell copy (Task 8, Fix M1 review) ─────────────────
// Chief-facing wording for RosterCard.tsx's three inline-editable columns —
// tooltip prose and the working-days blank placeholder — pulled out of the
// component so it lives in the one file that owns chief-facing wording,
// alongside the parse rules the tooltips describe.

export const CALL_FTE_TOOLTIP = 'Call FTE — pro-rates the call obligation.';

export const WORK_DAYS_FTE_TOOLTIP =
  'Working-days FTE — the share of working days owed. Blank means the same as call FTE.';

export const PTO_ALLOTMENT_TOOLTIP =
  'Annual PTO allotment in weeks. Blank means not stated; 0 means genuinely none.';

/** The working-days FTE cell's placeholder when blank — the existing "same as
 *  call FTE" convention (validation/providers.ts's work_days_fte comment,
 *  patch43). */
export const WORK_DAYS_FTE_PLACEHOLDER = 'same';

/**
 * The roster card's footer legend. Fix M1 (review, 2026-09-06): the original
 * sentence claimed a blank PTO allotment "shows — in the tally" — false.
 * Nothing in AnnualTallyCard renders `allotmentText`; its PTO column calls
 * `remainingText`, which prints "allotment not stated" (ALLOTMENT_NOT_STATED
 * above — shared with this function so the two can't drift apart again). The
 * em dash is real, but it is what the ROSTER's OWN blank cell shows, not
 * something the tally prints — the corrected sentence says both, and gets
 * the em dash itself from `allotmentText(null)` rather than a second literal.
 */
export function rosterFooterNote(): string {
  return 'Blank work-days FTE means the same as call FTE. A blank PTO weeks cell means no '
    + `allotment has been stated — shown as "${allotmentText(null)}" here and as `
    + `"${ALLOTMENT_NOT_STATED}" in the annual tally; a typed 0 means genuinely none.`;
}

// ── Availability drawer (Task 9) ────────────────────────────────────────────
// Per-provider PTO / off / no-call dates, reachable from the roster instead of
// eleven separate profile visits. The decisions below are the ones that could
// be wrong — which types are safe to offer, and how a row's status should
// read — kept here with tests rather than as literals in the drawer's JSX.

/**
 * Availability types the drawer lets a chief ADD. Deliberately a narrow
 * subset of AVAILABILITY_TYPES (validation/providers.ts) — `pto`,
 * `pto_sellback`, `unavailable` are exactly the types annualTally.ts nets
 * against the PTO/off-day figures this board exists to show; adding one here
 * and watching the tally move in the same drawer is the point.
 *
 * `satisfies readonly AvailabilityType[]` so a typo in this list fails at the
 * declaration, not silently as a dead option nobody notices.
 *
 * Excluded, and why — each either cannot be created SAFELY from a generic
 * one-shot form, or belongs to a flow this drawer does not replicate:
 *  - `fmla`, `military_leave`, `sick`, `jury_duty`, `conference`, `admin`,
 *    `cme`: HR-sensitive or as-they-occur types, not things "prepared ahead
 *    of a block" — they stay on the profile's Availability tab, which is
 *    where the group actually enters them.
 *  - `blocked` (ICU rotation rows, reason_code icu_week / icu_post_call):
 *    ICU weeks are stored as a PAIR — the week plus its post-call Monday
 *    (icuRotation.ts). A generic add-form creates one row; doing that here
 *    would silently create HALF a pair. The profile's ICU Rotation section
 *    is the only place that creates both halves together, and stays that way.
 *  - `no_call_request` AND `call_request` (CORRECTED 2026-09-07 — an earlier
 *    version of this list wrongly included `no_call_request`; flagged
 *    Critical in review). The profile does NOT create either through THIS
 *    API. It POSTs to /api/requests/submit/{token} (requestIntake.ts), which
 *    (a) requires an OPEN request window, (b) writes ONE ROW PER DATE, never
 *    a range, and (c) tags every row's `notes` with `windowNotesTag(window.id)`.
 *    That tag is load-bearing: `countWindowRequestRows` / `windowRequestDates`
 *    count a provider's used requests by matching `notes === windowNotesTag(id)`
 *    — a range row created through this generic form carries no such tag, so
 *    it counts as ZERO against `max_no_call_requests` while still being a
 *    fully LIVE lever (`isActiveNoCallRequest` plus solve.ts / slotCandidates.ts
 *    honor it regardless of notes). One Mon–Fri row here would be five free
 *    no-call days against a cap the profile's own counter still reports as
 *    unused. What `no_call_request` actually lacks is APPROVAL, not gating —
 *    `isActiveNoCallRequest` treats pending and approved alike — and the
 *    open-window gate is the identical reason `call_request` was already
 *    excluded for.
 *  - `available`: the DB default state, not something anyone "adds".
 *
 * NONE of this affects DISPLAY — every row the API returns for the year still
 * renders in the drawer's list regardless of type; this constant only bounds
 * the type picker in the add form.
 */
export const ADDABLE_AVAILABILITY_TYPES = [
  'pto', 'pto_sellback', 'unavailable',
] as const satisfies readonly AvailabilityType[];

/**
 * Fix 5 (review 2026-09-07): the add-form's own selected type is narrower
 * than a general availability row's type — it can only ever be one of the
 * three ADDABLE_AVAILABILITY_TYPES. Using the full `AvailabilityType` for the
 * add-form's `type` state made "a select whose value matches no rendered
 * option" representable in the type system even though it can never actually
 * happen. Existing ROWS still use the general `AvailabilityType` — a fetched
 * row can be any of the full vocabulary, addable here or not.
 */
export type AddableAvailabilityType = typeof ADDABLE_AVAILABILITY_TYPES[number];

/**
 * Minimal row shape icuRowLockInfo and sellbackStandaloneNote both need —
 * satisfied structurally by AvailabilityDrawerRow (the component's row type)
 * without either side importing the other.
 */
export interface AvailabilityLikeRow {
  id: string;
  availability_type: string;
  approval_status: string;
  reason_code: string | null;
  start_date: string;
  end_date: string;
}

export interface IcuLockInfo {
  /** True only when this row is genuinely one half of an INTACT ICU pair —
   *  its partner is present in the row set passed in. The drawer must not
   *  offer a plain Remove for these; a lone delete would silently orphan the
   *  other half. */
  locked: boolean;
  /** Tooltip text for a locked row, branched by which half of the pair this
   *  row actually is — "paired with a post-call Monday" is backwards on the
   *  Monday row itself. Null when not locked. */
  note: string | null;
}

/**
 * Precompute the pairing for a whole row set ONCE (Fix 4, review
 * 2026-09-07): `icuRowLockInfo` used to call `pairIcuRows` itself, so mapping
 * it over N rows re-scanned the whole set N times. Callers hoist this outside
 * their row loop and pass the same result into `icuRowLockInfo` per row.
 */
export function icuPairsFor(
  allRows: ReadonlyArray<AvailabilityLikeRow>,
): IcuPair<IcuAvailabilityRow>[] {
  return pairIcuRows(allRows as unknown as IcuAvailabilityRow[]);
}

const ICU_MANAGED_ELSEWHERE = 'managed together from the provider’s profile — ICU Rotation section '
  + '(turn the provider’s ICU-doc flag on there if the section isn’t showing).';

/**
 * Is `row` genuinely still paired, and with what wording?
 *
 * NOT a reason-code check alone — an earlier version of this function was,
 * and it over-locked two real cases: a `blocked`/`icu_week` row whose Monday
 * was never created (icuRotation.ts skips it when an existing blocked row
 * already covers that date) has nothing to orphan, and a `blocked`/
 * `icu_post_call` row whose week no longer exists is already an ORPHAN the
 * profile itself lets a chief delete directly (providers/[id]/page.tsx's
 * `icuOrphans` list, its own Delete button) — locking it here would
 * contradict the very surface this drawer defers to. Routes the actual
 * pairing decision through icuRotation.ts's own `pairIcuRows` (via
 * `icuPairsFor`) so it can never disagree with the profile's.
 *
 * YEAR-BOUNDARY REGRESSION (CRITICAL, caught in review 2026-09-07): the first
 * version of this fix treated "partner absent from `pairs`" as "partner does
 * not exist" — wrong, because `pairs` is built from a YEAR-SCOPED fetch
 * (Fix I2's `yearBounds`). Ten consecutive week-starts (Dec 22–31) have their
 * post-call Monday in January: viewed from the 2026 board the Monday is
 * outside the fetch and the week read as unlocked (a click would create the
 * exact orphan this lock exists to prevent); viewed from 2027 the Monday
 * reads as an orphan when its week is intact in 2026. `isPairedIcuRow` (the
 * version before Task 9's rework) never had this bug because it never
 * consulted the row set at all — this is a REGRESSION, not a pre-existing
 * gap, and it lands exactly on the usage peak (a chief planning January's
 * block reads December's rows).
 *
 * THE FIX: before trusting "partner not found" as "partner does not exist",
 * prove the fetch WOULD have found it had it existed — i.e. the partner's
 * only possible date(s) fall inside `[start, end]`. If that can't be proven,
 * stay LOCKED (assume paired) rather than risk unlocking a real pair we
 * simply can't see:
 *  - Week row: `icuMondayAfter(row.end_date)` is a single deterministic
 *    date. If it's after `end` (the window's upper bound), the Monday could
 *    exist just outside the fetch — stay locked. The LOWER bound never needs
 *    checking: `icuMondayAfter` always returns a date strictly AFTER
 *    `row.end_date`, and `row.end_date >= start` always holds because `row`
 *    itself came from this fetch (the overlap filter requires
 *    `end_date >= from`) — so the computed Monday can never fall below the
 *    window's start; only whether it overshoots the window's END is ever in
 *    question.
 *  - Post-call row: the week's end date that would produce this exact Monday
 *    is one of the 7 calendar days immediately before it (icuMondayAfter's
 *    inverse spans a week — a Monday-dow end date needs +7, a Sunday-dow end
 *    date needs +1). Its EARLIEST possible date is `row.start_date - 7`; if
 *    that's before `start` (the window's lower bound), a qualifying week
 *    could exist just outside the fetch — stay locked. The upper bound never
 *    needs checking: every candidate is <= `row.start_date - 1`, and
 *    `row.start_date <= end` always holds because `row` itself came from
 *    this fetch.
 *
 * `note` deliberately does NOT promise the profile's ICU Rotation section is
 * currently visible: that section is gated on `is_icu_doc || an orphan
 * exists` (providers/[id]/page.tsx), so a genuinely INTACT pair whose
 * is_icu_doc flag was later cleared is invisible there — a fact this
 * function has no way to check (the drawer never fetches the profile). The
 * wording says how to reach AND how to restore visibility, rather than
 * asserting the section is already showing.
 */
export function icuRowLockInfo(
  pairs: ReadonlyArray<IcuPair<IcuAvailabilityRow>>,
  row: AvailabilityLikeRow,
  year: number,
): IcuLockInfo {
  const isIcu = row.availability_type === 'blocked'
    && (row.reason_code === ICU_WEEK_REASON || row.reason_code === ICU_POST_CALL_REASON);
  if (!isIcu) return { locked: false, note: null };

  const window = yearBounds(year);
  const lockedWeek: IcuLockInfo = { locked: true, note: `Paired with the post-call Monday after it — ${ICU_MANAGED_ELSEWHERE}` };
  const lockedMonday: IcuLockInfo = { locked: true, note: `The post-call rest day after an ICU week — ${ICU_MANAGED_ELSEWHERE}` };

  if (row.reason_code === ICU_WEEK_REASON) {
    const pair = pairs.find(p => p.week.id === row.id);
    if (pair?.monday) return lockedWeek;
    // Not found in the fetch. Only trust that as "genuinely no Monday" if the
    // fetch was guaranteed to include one had it existed.
    const expectedMonday = icuMondayAfter(row.end_date);
    if (expectedMonday > window.end) return lockedWeek; // could exist just outside the window
    return { locked: false, note: null }; // provably no Monday — nothing to orphan
  }

  // icu_post_call
  const paired = pairs.some(p => p.monday?.id === row.id);
  if (paired) return lockedMonday;
  // Not claimed by any week in the fetch. Only trust that as "genuinely
  // orphaned" if every week that could have produced this exact Monday was
  // guaranteed to be inside the fetch.
  const earliestPossibleWeekEnd = addDays(row.start_date, -7);
  if (earliestPossibleWeekEnd < window.start) return lockedMonday; // its week could exist just outside the window
  return { locked: false, note: null }; // provably orphaned — the profile's own delete-it-directly case
}

/**
 * Precompute the live-blocking-row subset ONCE (Fix 4, review 2026-09-07,
 * same rationale as `icuPairsFor`): `sellbackStandaloneNote` used to filter
 * the whole row set itself, so mapping it over N rows re-filtered N times.
 * Callers hoist this outside their row loop.
 */
export function liveBlockingRows(
  allRows: ReadonlyArray<AvailabilityLikeRow>,
): AvailabilityLikeRow[] {
  return allRows.filter(r => BLOCKING_AVAIL.has(r.availability_type) && !isDismissedAvailability(r));
}

/**
 * A sell-back row that doesn't overlap ANY live blocking row is legal but
 * INERT — the schedule only treats sell-back as an override where it
 * actually overlaps something it would otherwise block, so a standalone
 * entry changes nothing until it does. This is a straight port of the
 * profile's own decision (providers/[id]/page.tsx's `sellbackNotes`), using
 * the SAME imports (BLOCKING_AVAIL, isDismissedAvailability,
 * effectivePtoRange, via `liveBlockingRows`) so the two surfaces can never
 * disagree about the same rows. `effectivePtoRange`'s bookend extension
 * matters here: a sell-back on the Saturday a Monday-start PTO bookends over
 * is correctly NOT flagged as standalone (shared.test.ts pins this same
 * case).
 */
export function sellbackStandaloneNote(
  liveBlocking: ReadonlyArray<AvailabilityLikeRow>,
  row: AvailabilityLikeRow,
): string | null {
  if (row.availability_type !== 'pto_sellback') return null;
  const overlaps = liveBlocking.some(b => {
    const eff = effectivePtoRange(b);
    return eff.start <= row.end_date && eff.end >= row.start_date;
  });
  return overlaps ? null : 'Standalone — no overlapping PTO or leave, so this changes nothing yet.';
}

/**
 * A one-line explanation for types whose colour alone doesn't say enough to
 * someone seeing it for the first time — currently just `pto_sellback` (Fix
 * I4, review 2026-09-07): the red tone signals "not a day off" only to a
 * reader who already knows the convention. Null for every other type, which
 * need no elaboration beyond their label.
 */
export function availabilityTypeHint(availabilityType: string): string | null {
  if (availabilityType !== 'pto_sellback') return null;
  return 'The provider IS WORKING these dates — the group bought the PTO back.';
}

/**
 * Fix 5 (Minor, review 2026-09-07): the profile's OWN vocabulary for
 * availability_type 'unavailable' is "Days Off" at the category level — its
 * section title, its counter ("Total Days Off"), and the public intake
 * form's field are all named that way — even though the profile's per-row
 * badge still literally reads "Unavailable" (AVAILABILITY_TYPE_LABELS,
 * validation/providers.ts, shared across the whole app). The block-prep
 * drawer has no per-type sections, so its badge/picker option IS the
 * category label a chief reads, and its own empty-state hint already
 * promised "days off" — leaving the badge at "Unavailable" disagreed with
 * the drawer's OWN wording, not just the profile's.
 *
 * A LOCAL override rather than a change to AVAILABILITY_TYPE_LABELS itself:
 * that map is a foundational, cross-cutting export many unrelated surfaces
 * still key off verbatim (the profile's own per-row badge among them), and
 * retargeting it would relabel every one of those. Lives HERE, not in the
 * drawer component, because it's a chief-facing vocabulary DECISION — moved
 * from AvailabilityDrawer.tsx once this file was free to take it (review
 * 2026-09-07, fourth pass) — exactly what this module exists to hold and
 * test rather than bury in JSX.
 */
const AVAILABILITY_TYPE_DISPLAY_OVERRIDES: Partial<Record<string, string>> = {
  unavailable: 'Days Off',
};
export function availabilityTypeDisplayLabel(availabilityType: string): string {
  return AVAILABILITY_TYPE_DISPLAY_OVERRIDES[availabilityType]
    ?? AVAILABILITY_TYPE_LABELS[availabilityType as AvailabilityType]
    ?? availabilityType;
}

export interface YearBounds { start: string; end: string }

/**
 * Jan 1 – Dec 31 of `year`, as ISO date strings — the single home for "what
 * counts as this board's year". Used for the availability GET's from/to
 * (availabilityQueryUrl below), for `dateRangeError`'s overlap check, and to
 * PARTIALLY bound the add-form's date inputs: `end.start` is a legitimate
 * `min` for the END input and `end.end` is a legitimate `max` for the START
 * input (a range with no overlap at all can never validate), but NOT the
 * other two corners — the drawer accepts a range spanning into the
 * neighboring year (Fix 2's overlap correction, review 2026-09-07), so the
 * START input carries no `min` and the END input carries no `max`.
 */
export function yearBounds(year: number): YearBounds {
  return { start: `${year}-01-01`, end: `${year}-12-31` };
}

/**
 * The GET url for a provider's availability rows overlapping `year` — an
 * OVERLAP filter (end_date >= from AND start_date <= to; see
 * /api/scheduling/availability's route), matching exactly what
 * annualTally.ts counts for the tally card.
 */
export function availabilityQueryUrl(providerId: string, year: number): string {
  const { start, end } = yearBounds(year);
  return `/api/scheduling/availability?provider_id=${encodeURIComponent(providerId)}&from=${start}&to=${end}`;
}

/**
 * Client-side mirror of TWO server-side gates, checked before submit rather
 * than round-tripping to learn what the server already knows:
 *
 *  1. `end_date >= start_date` (validation/providers.ts; the POST and PATCH
 *     routes both enforce this).
 *  2. The range OVERLAPS the board's own year — NOT server-enforced at all
 *     (Fix 2, review 2026-09-07). `min`/`max` on a `<input type=date>` only
 *     set `rangeUnderflow`/`rangeOverflow`; per spec they do NOT clamp the
 *     value, and this form has no `<form>` wrapper for native constraint
 *     validation to run against anyway. A typed or pasted range with NO
 *     overlap at all reaches `add()`'s state untouched, would still POST,
 *     would still land in the DB, and would still vanish from the
 *     year-scoped refetch with no error.
 *
 *     OVERLAP, NOT CONTAINMENT (second-pass fix, review 2026-09-07): the
 *     first version of this check rejected a range unless BOTH endpoints
 *     fell inside `[start, end]` — strictly narrower than the fetch that
 *     actually decides visibility (`end_date >= from AND start_date <= to`;
 *     /api/scheduling/availability's route). That over-rejected every range
 *     spanning New Year: a Dec 28 – Jan 5 holiday PTO block — the single
 *     most common PTO shape in a hospital calendar — was rejected from BOTH
 *     the 2026 board (fails containment: end date is in 2027) AND the 2027
 *     board (fails containment: start date is in 2026), leaving no board a
 *     chief could enter it from at all. The fetch would have shown that row
 *     on both boards fine (it overlaps both years), so containment was
 *     rejecting a range the route was never going to hide. Overlap is the
 *     right question — reject ONLY a range with NO overlap at all
 *     (`end < start` OR `start > end` OF THE YEAR) — because that is the
 *     wholly-invisible case Fix 2 actually exists to catch, and it is the
 *     one case where the year-scoped downstream math (ptoCounterStats /
 *     coveredDaysInYear, dateRanges.ts; ptoWeekdaysCovered,
 *     rulesEngine/workDays.ts) has NOTHING to clip — both already clip a
 *     spanning range to its in-year days per-day, so letting the write span
 *     the boundary is safe by construction, not by luck. `year` stays
 *     required (not optional) so a call site cannot accidentally validate
 *     range order while forgetting the year check entirely.
 *
 * Null while the range is INCOMPLETE (blank isn't wrong yet, just
 * unfinished), while `end < start`, or while it's fully valid; either
 * route's message still surfaces verbatim in the drawer's add-error banner
 * if either gate is ever bypassed.
 */
export function dateRangeError(start: string, end: string, year: number): string | null {
  if (start === '' || end === '') return null;
  if (end < start) return 'End date must be on or after the start date.';
  const bounds = yearBounds(year);
  if (end < bounds.start || start > bounds.end) {
    return `Dates must overlap ${year} to appear on this board.`;
  }
  return null;
}

/**
 * The delete-confirmation prompt. Names the PROVIDER as well as the type and
 * range (Fix M12, review 2026-09-07) — the drawer's whole premise is editing
 * eleven people from one screen, so a bare "remove this entry?" carries none
 * of the context that makes this surface useful once a chief has several
 * drawers' worth of edits in a row.
 */
export function removalConfirmMessage(opts: {
  providerName: string;
  typeLabel: string;
  startDate: string;
  endDate: string;
}): string {
  const { providerName, typeLabel, startDate, endDate } = opts;
  const range = startDate === endDate ? startDate : `${startDate} → ${endDate}`;
  return `Remove ${providerName}’s ${typeLabel} covering ${range}? This cannot be undone.`;
}

/**
 * Badge tone for an availability row's TYPE (not its approval status — see
 * availabilityStatusBadge below for that).
 *
 * `pto_sellback` is RED by convention across the app — the schedule grid uses
 * the same red for sell-back cells (Gabriel 2026-07-20 / 2026-09-06: the
 * chief bought the PTO back, so the provider IS WORKING those dates). This
 * must never collapse onto `pto`'s tone: a sold-back date reading as leave
 * would be exactly backwards — it is the one date in the list the provider is
 * definitely NOT off.
 */
export function availabilityTypeTone(
  availabilityType: string,
): 'ok' | 'warn' | 'danger' | 'neutral' {
  switch (availabilityType) {
    case 'pto':             return 'ok';
    case 'pto_sellback':    return 'danger';
    case 'no_call_request': return 'warn';
    default:                return 'neutral';
  }
}

/**
 * Badge tone + label for an availability row's approval status. `null` means
 * "no badge" — reserved for `approved`, the drawer's unremarkable default.
 *
 * `pending` is deliberately NOT muted: clinical invariant 2 says a pending
 * request blocks scheduling exactly like an approved one (isBlockingAvailability,
 * rulesEngine/shared.ts — only denied/canceled are ignored), so it must read
 * as LIVE, not as an inert waiting-room state the way a dimmed/grey badge
 * would. `denied` / `canceled` get the quiet 'neutral' tone precisely because
 * they are the only two statuses the engine ignores.
 */
export function availabilityStatusBadge(
  approvalStatus: string,
): { tone: 'warn' | 'neutral' | 'info'; label: string } | null {
  switch (approvalStatus) {
    case 'approved':   return null;
    case 'pending':    return { tone: 'warn', label: 'Pending' };
    case 'waitlisted': return { tone: 'info', label: 'Waitlisted' };
    case 'denied':     return { tone: 'neutral', label: 'Denied' };
    case 'canceled':   return { tone: 'neutral', label: 'Canceled' };
    default:           return { tone: 'neutral', label: approvalStatus };
  }
}

// ── Block Prep page (Task 10) ───────────────────────────────────────────────
// The page itself is fetch/state/markup only; the one thing it decides —
// which years to offer — and its chief-facing button copy live here so a
// review of "what does this page assume" doesn't require reading JSX.

/**
 * The year picker's options for the Block Prep board: last year (checking a
 * just-finished block), this year, and next year (prepping ahead) — no
 * further-out years, since nothing this board shows (PTO, off days, calls)
 * exists yet beyond next year's horizon.
 */
export function blockPrepYearOptions(thisYear: number): number[] {
  return [thisYear - 1, thisYear, thisYear + 1];
}

export const CREATE_SCHEDULE_TOOLTIP = 'Create a schedule for this site';
export const CREATE_SCHEDULE_NO_SITE_TOOLTIP = 'Pick a site first';

/**
 * The "no call takers" empty-state hint, shared by RosterCard and
 * AnnualTallyCard (Fix 3, round 7 review) — they used to carry two DIFFERENT
 * sentences. AnnualTallyCard's said "Mark a provider as a call taker with
 * this site as their home site and they'll appear here", but the route ALSO
 * requires `providers.status = 'active'` — a chief following that instruction
 * on an inactive provider sees nothing happen. RosterCard's own hint already
 * named all three requirements correctly. Production has a site with zero
 * call takers today (Jefferson Navy Yard), so this empty state is reachable
 * on day one, not a hypothetical.
 */
export const NO_CALL_TAKERS_HINT =
  'A provider appears here when they are active, marked as a call taker, and this site is their home site.';

/**
 * The site-picker's placeholder text for the "nothing to list yet" case —
 * four distinguishable facts, never collapsed into one guess: a fetch
 * failure, no organization configured at all, "hasn't looked yet", and a
 * genuinely confirmed zero sites.
 *
 * Shared by /block-prep's site select and /dashboard's DashboardTallyCard
 * (Fix 2, round 7 review) — the `noOrg` guard was added to /block-prep alone
 * in round 6 (without it, an empty organizations list left the site select
 * reading "Loading sites…" forever, since the sites fetch is gated on having
 * an org id), and DashboardTallyCard kept its own hand-duplicated copy of the
 * same bootstrap sequence without it. Centralizing the WORDING here, on top
 * of `useOrgAndSites` centralizing the FETCHING, is what stops a future fix
 * from landing in only one of two copies again.
 */
export function siteBootstrapText(
  state: { error: string | null; noOrg: boolean; sitesLoaded: boolean },
): string {
  if (state.error) return 'Could not load sites';
  if (state.noOrg) return 'No organization configured';
  if (state.sitesLoaded) return 'No sites';
  return 'Loading sites…';
}
