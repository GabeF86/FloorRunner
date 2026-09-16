/* ── Schedule grid: shared types, date math and chrome ──────────────────────
 * WHY THIS MODULE EXISTS. The grid route's heavy overlays (Call Counts, Pool
 * Selector, Available Call, Calendar, Spacing, D-audit, Printable) were lifted
 * out of page.tsx into their own dynamically-imported modules so they stop
 * riding on the first paint. Each of them needs some of the same payload types
 * and the same date helpers the page itself uses — so those live HERE, imported
 * by both, rather than being copied into each module.
 *
 * The no-second-copy rule is not stylistic. This codebase's characteristic
 * failure mode is a duplicated predicate that later drifts, and a second copy
 * of (say) callCensusFromGrid would let the grid's red OVER cells and the Call
 * Counts table disagree about who is over their obligation. One home, always.
 *
 * What does NOT belong here: cell styling (./gridTheme.ts), call-split segment
 * grouping (./gridSegments.ts), zoom persistence (./gridZoom.ts). Those already
 * have homes — import from them.
 *
 * Everything in this file is PURE and framework-free (no hooks, no JSX) so it
 * costs nothing to share and stays trivially testable.
 * ───────────────────────────────────────────────────────────────────────── */

import type { CSSProperties } from 'react';
import {
  computeCallObligationCensus, type CallObligationCensus,
} from '@/lib/fteTarget';
// Type-only: the grid route parses the site's active pattern server-side and
// ships the validated doc, so zod stays out of this client bundle.
import type { CallPatternDoc } from '@/lib/rulesEngine/callPattern';
import type { HighlightColor } from '@/lib/highlightColor';
import type { ValidationSummary } from '@/app/api/scheduling/schedules/[id]/grid/route.helpers';
import type { CandidateCredentialRow, CrossSiteBookingRow } from '@/lib/slotCandidates';

/* ── Interfaces ──────────────────────────────────────────────────────────── */

export interface SiteInfo {
  name: string;
  short_name: string | null;
  timezone: string | null;
  // Optional — older deployments may not have this column on sites. Page
  // defaults to 12 when it's missing (matches the engine's fallback).
  call_par_level?: number | null;
}

export interface Schedule {
  id: string;
  organization_id: string;
  site_id: string;
  schedule_name: string;
  schedule_type: string;
  provider_group: string;
  date_start: string;
  date_end: string;
  status: string;
  // null = use default rule-based pool. Array of provider UUIDs = use
  // exactly those as the auto-generate candidate pool (still subject to
  // eligibility filters).
  included_provider_ids: string[] | null;
  // Raw jsonb from schedules.provider_limits — always fed through
  // parseProviderLimits before use (the PATCH route's parser, single home).
  provider_limits?: unknown;
  sites: SiteInfo;
}

export interface EmploymentProfile {
  provider_id: string;
  home_site_id: string | null;
  call_taker: boolean;
  partial_call_taker: boolean;
  /** Day Doc role flag — the criterion day-shift generation intersects. */
  is_day_doc?: boolean | null;
  fte_value: number | null;
  // Stated WORKING-DAYS FTE (patch43) — the Working Days / Days Off columns'
  // multiplier. Absent on a payload whose profiles read fell to the pre-43
  // rung, and null for every provider who states none; both mean "use
  // fte_value", which is what the contract's fallback does.
  work_days_fte?: number | null;
  employment_status: string | null;
  // Sun..Sat jsonb — the engine's weekday-availability gate, consumed by the
  // cell picker through slotCandidates. Absent on a payload whose profiles read
  // fell to the narrow retry; normalizeWeekdays coerces that to all-true.
  available_weekdays?: unknown;
}

export interface AvailabilityEntry {
  provider_id: string;
  availability_type: string;
  start_date: string;
  end_date: string;
  approval_status: string;
  // NOTE: the grid route selects `reason_code` (the actual column name) —
  // this field previously said `reason` and silently read as undefined.
  reason_code: string | null;
}

export interface Version {
  id: string;
  version_number: number;
  version_status: string;
}

export interface ShiftTypeInfo {
  id: string;
  code: string;
  name: string;
  color_hex: string | null;
  category: string;
  call_type: string | null;
  display_order: number | null;
  provider_group: string;
  // Optional — powers the Call Counts modal's Working Days credit (post-call
  // rest days credit as worked). Older cached payloads may omit it; the
  // credit math treats absent as false.
  requires_post_call_rule?: boolean | null;
  // patch18. 0 = first (primary) call — THE identifier for the Obligatory
  // Weekends column's primary-call weekend days. Absent on a pre-patch18
  // payload; the column then simply finds no primary duties.
  call_rank?: number | null;
  // Call splits (2026-07-22, patch35): segment → parent grouping key +
  // fractional call credit. Absent (pre-patch payloads) = whole call.
  parent_call_code?: string | null;
  call_burden_weight?: number | null;
  // patch18. Feeds the cell picker's same-date check through the canonical
  // overlayMayCoexist table. Absent reads as non-overlay (conservative).
  is_overlay?: boolean | null;
}

export interface ProviderInfo {
  id: string;
  last_name?: string;
  // NULLABLE IN THE DATABASE, and 22 active physicians currently have no
  // value. It was typed `string` until 2026-09-15, when importing the group's
  // master schedule gave those physicians their first assignments and the
  // grid's `short_display_name.localeCompare(...)` sorts started throwing —
  // a client-side crash on the whole page. Route every read through
  // `providerLabel` / `byProviderLabel` below rather than dereferencing it.
  short_display_name: string | null;
  initials: string | null;
  provider_type: string;
}

export interface ValidationFlag {
  rule_id: string | null;
  rule_name: string;
  category: string;
  // 'warning' = sentinel flags (e.g. 'validation unavailable — needs
  // re-validation') — counted separately, never as soft violations.
  severity: 'hard' | 'soft' | 'warning';
  message: string;
}

export interface AssignmentInfo {
  id: string;
  provider_id: string | null;
  assignment_status: string;
  is_open_call: boolean;
  manually_overridden: boolean;
  validation_flags?: ValidationFlag[] | null;
  // Server-computed severity counts (grid route helpers' ValidationSummary).
  // null = never validated (flags column null), distinct from all-zero.
  validation_summary?: ValidationSummary | null;
  // Hand-set billing mark (patch42) — 'blue' | 'red' | 'yellow' | null. Also
  // undefined on a pre-patch42 DB, where the grid route's narrow retry drops
  // the column entirely; normalizeHighlightColor folds both to "no mark".
  highlight_color?: HighlightColor | null;
  /** Cell comment (assignments.notes) — shown on hover, marked by a corner
   *  notch. Cleared when the cell is reassigned, same contract as the mark. */
  notes?: string | null;
  providers: ProviderInfo | null;
}

export interface Slot {
  id: string;
  slot_date: string;
  shift_type_id: string;
  slot_index: number;
  locked: boolean;
  derived_day_type: string;
  // schedule_slots.provider_group — 'physician' | 'crna' | 'both'. THE column
  // evaluateEligibility's group gate reads (not the shift type's), so the cell
  // picker mirrors the engine rather than approximating it.
  provider_group?: string | null;
  shift_types: ShiftTypeInfo;
  assignments: AssignmentInfo[];
}

export interface Provider {
  id: string;
  first_name: string;
  last_name: string;
  /** Nullable — see ProviderInfo.short_display_name. */
  short_display_name: string | null;
  initials: string | null;
  provider_type: string;
  status: string;
}

/**
 * What to call a provider on the grid.
 *
 * The schedule code where there is one, then the surname, then the initials —
 * never an empty cell and never a crash. A physician with no code at all is a
 * roster gap worth seeing, so it shows their surname rather than a blank.
 */
export function providerLabel(
  p: { short_display_name?: string | null; last_name?: string | null; initials?: string | null },
): string {
  return p.short_display_name?.trim()
    || p.last_name?.trim()
    || p.initials?.trim()
    || '—';
}

/** Alphabetical by whatever the grid actually shows. Null-safe by construction:
 *  the six sorts that used to call `.localeCompare` on a nullable field are the
 *  reason this exists. */
export function byProviderLabel(
  a: { short_display_name?: string | null; last_name?: string | null; initials?: string | null },
  b: { short_display_name?: string | null; last_name?: string | null; initials?: string | null },
): number {
  return providerLabel(a).localeCompare(providerLabel(b));
}

export interface Holiday {
  holiday_date: string;
  holiday_name: string;
  holiday_type: string;
  is_major_holiday: boolean;
}

export interface GridData {
  schedule: Schedule;
  version: Version;
  slots: Slot[];
  providers: Provider[];
  holidays: Holiday[];
  profiles: EmploymentProfile[];
  availability: AvailabilityEntry[];
  // Site's active CallPatternDoc, parsed server-side (grid route step 8) —
  // null when the site has none or its definition failed validation. The Call
  // Counts modal reads `neuroWeekend.code` from it; nothing else on this page
  // consumes the pattern. Type-only import, so zod never enters this bundle.
  callPattern?: CallPatternDoc | null;
  // Cell-picker eligibility inputs (2026-07-28). BOTH are nullable, and null
  // means "the route could not check this dimension" — never "nothing is
  // blocked". slotCandidates turns a null into a visible notice in the picker.
  credentials?: CandidateCredentialRow[] | null;
  crossSite?: CrossSiteBookingRow[] | null;
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

export const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function toDateStr(d: Date): string {
  return d.toISOString().split('T')[0];
}

export function parseDate(s: string): Date {
  return new Date(s + 'T00:00:00');
}

export function formatMMDD(s: string): string {
  const d = parseDate(s);
  return `${d.getMonth() + 1}/${String(d.getDate()).padStart(2, '0')}`;
}

export function formatDateRange(start: string, end: string): string {
  const s = parseDate(start);
  const e = parseDate(end);
  const mo = (d: Date) => d.toLocaleString('en-US', { month: 'short' });
  return `${mo(s)} ${s.getDate()} - ${mo(e)} ${e.getDate()}, ${e.getFullYear()}`;
}

export function getDayOfWeek(s: string): number {
  return parseDate(s).getDay();
}

export function allDatesInRange(start: string, end: string): string[] {
  const dates: string[] = [];
  const cur = parseDate(start);
  const last = parseDate(end);
  while (cur <= last) {
    dates.push(toDateStr(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

// THE obligation inputs for this page (2026-07-17): one adapter feeding the
// grid over-par memo AND the Call Counts modal, so the two surfaces literally
// cannot diverge on denominator or call census. computeCallObligationCensus
// (src/lib/fteTarget.ts) mirrors the engine:
//   - effectivePar = the stored call_par_level, verbatim (par-authoritative,
//     Gabriel 2026-07-24 — never clamped to the pool's ΣFTE; when the pool is
//     smaller, obligations under-cover the schedule and the remainder is the
//     paid-pickup layer). Same denominator solve()'s obligatory-mode cap uses
//     (rulesEngine/obligation.ts). Pool = included_provider_ids override when
//     set, else home-site call/partial-call takers (loadGenerationContext's
//     rule) — it scopes WHO owes calls, never the denominator.
//   - totalCallSlots = every call-category slot — holiday-dated included, any
//     call code, filled or not (the engine's open-slots + call-seeds census).
export function callCensusFromGrid(grid: GridData): CallObligationCensus {
  return computeCallObligationCensus({
    // ?? 12 matches the engine's DEFAULT_PAR_LEVEL fallback.
    storedParLevel: grid.schedule.sites?.call_par_level ?? 12,
    siteId: grid.schedule.site_id,
    includedProviderIds: grid.schedule.included_provider_ids,
    profiles: grid.profiles || [],
    slots: grid.slots,
    // The site's parsed pattern (2026-08-03). When it states obligation bands
    // the census switches to STATED, PER-CATEGORY accounting — the same doc
    // the engine builds to, so what the grid labels OVER and what the
    // generator refused to place cannot disagree. Null (no pattern, or one
    // that failed to parse — the grid route ships null) keeps the derived
    // formula and the netted cover exactly as they were.
    callPattern: grid.callPattern,
  });
}

export function getWeekStart(dates: string[], offset: number): number {
  // Find the first Sunday on or before the start, then offset by weeks
  const first = parseDate(dates[0]);
  const dayOfWeek = first.getDay();
  const startIdx = -dayOfWeek + offset * 7;
  return Math.max(0, startIdx);
}

export function colorWithAlpha(hex: string | null, alpha: number): string {
  if (!hex) return `rgba(100,116,139,${alpha})`;
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/* ── Modal chrome ────────────────────────────────────────────────────────── */

// The neutral secondary button every overlay on this route uses (Close,
// Cancel, Print, Reset to Default, the D-audit row actions). Shared by the
// Pool Selector, Spacing and D-audit modules — three separate files now, which
// is exactly why it may not be copied into any of them.
export const smallBtn: CSSProperties = {
  padding: '7px 15px', fontSize: 12.5, fontWeight: 700, borderRadius: 8,
  background: 'transparent', color: 'var(--text-muted)',
  border: '1px solid var(--border)', cursor: 'pointer',
};
