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
import { FTE_MAX, FTE_MIN, WORK_DAYS_FTE_MAX, WORK_DAYS_FTE_MIN } from './validation/providers';
// ICU rotation rows are PAIRED (a week row + its post-call Monday); the
// availability drawer's isPairedIcuRow below needs the same two reason codes
// icuRotation.ts uses to create/remove them, imported rather than re-typed.
import { ICU_WEEK_REASON, ICU_POST_CALL_REASON } from './icuRotation';

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
 */
export function offDaysText(budget: OffDayBudget, used: number | null): string {
  switch (budget.kind) {
    case 'unknown':        return 'FTE not stated';
    case 'not-applicable': return 'n/a';
    case 'none':           return 'none';
    case 'days':
      return used == null ? `${budget.days} budgeted` : `${used} of ${budget.days} used`;
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
function monthDayYear(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${MONTHS[Number(m) - 1]} ${Number(d)}, ${y}`;
}

/**
 * The honesty caveat under the off-days column. Off days can only be counted
 * where a schedule exists; this names the span so nobody reads the figure as a
 * full-year number.
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
 */
export function coveredSpanLabel(span: CoveredSpanInfo | null): string {
  if (!span) {
    return 'No published blocks this year — off days show the budget only, with nothing counted against it.';
  }
  // A published span that contains no working days (e.g. clipped to a single
  // major holiday) is NOT the same as nothing being published, and must not
  // read as "0 days off taken". Worded number-agnostically because this
  // branch precedes the segments check below — a multi-block span can also
  // clip to zero working days.
  if (span.workingDays === 0) {
    return 'The published coverage for this year includes no working days — nothing has been counted against the off-day budget.';
  }
  const start = monthDayYear(span.start).replace(/, \d{4}$/, '');
  const range = `${start} – ${monthDayYear(span.end)}`;
  if (span.segments.length > 1) {
    return `Off days counted across ${span.segments.length} published blocks only, with gaps between them: `
      + `${range} (${span.workingDays} working days counted).`;
  }
  return `Off days counted across published blocks only: ${range} (${span.workingDays} working days).`;
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
 * subset of AVAILABILITY_TYPES (validation/providers.ts):
 *
 *  - `pto`, `pto_sellback`, `unavailable` are exactly the types
 *    annualTally.ts nets against the PTO/off-day figures this board exists to
 *    show — adding one here and watching the tally move in the same drawer is
 *    the point.
 *  - `no_call_request` is a lightweight scheduling preference with no
 *    approval workflow of its own (isActiveNoCallRequest, rulesEngine/
 *    shared.ts) — safe to state ahead of a block build.
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
 *  - `call_request`: the profile tab only allows this while the site's
 *    no-call/call request window is open (a check this drawer does not
 *    replicate); offering it unconditionally here would let a request be
 *    filed against a closed window.
 *  - `available`: the DB default state, not something anyone "adds".
 */
export const ADDABLE_AVAILABILITY_TYPES = [
  'pto', 'pto_sellback', 'unavailable', 'no_call_request',
] as const;

/**
 * Whether an availability row is one half of a PAIRED ICU rotation entry
 * (icuRotation.ts: a week row plus its post-call Monday, created and removed
 * TOGETHER by the profile's ICU Rotation section). A lone delete here would
 * silently orphan the other half — a Monday that still blocks the date with
 * no visible reason, or a week with a dangling post-call day nobody can see.
 * The drawer must not offer a plain Remove for these rows.
 */
export function isPairedIcuRow(reasonCode: string | null | undefined): boolean {
  return reasonCode === ICU_WEEK_REASON || reasonCode === ICU_POST_CALL_REASON;
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
