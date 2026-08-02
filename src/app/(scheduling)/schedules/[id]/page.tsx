'use client';

import { useState, useEffect, useCallback, useRef, useMemo, Fragment } from 'react';
import Link from 'next/link';
import { gridTokens, cellBackground, cellOutline, cellOpacity, manualHighlightTitle } from './gridTheme';
import {
  HIGHLIGHT_COLORS, normalizeHighlightColor, type HighlightColor,
} from '@/lib/highlightColor';
import {
  fteWeightedTarget, roundedObligation, computeCallObligationCensus,
  type CallObligationCensus,
} from '@/lib/fteTarget';
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
// Type-only: the grid route parses the site's active pattern server-side and
// ships the validated doc, so zod stays out of this client bundle.
import type { CallPatternDoc } from '@/lib/rulesEngine/callPattern';
// rangeComposition = the planner card's single-homed block composition
// (weekdays minus major holidays → the working-day set).
import { rangeComposition } from '@/lib/plannerMath';
import AssistantPanel from './AssistantPanel';
import { PageHeader, Badge, Button, Banner, scheduleStatusTone } from '@/components/ui';
import { SCHEDULE_NAME_MAX } from '@/lib/scheduleName';
import { reasonCodeLabel } from '@/lib/validation/providers';
// Pure row-level classifier for LIVE pto_sellback rows — the grid must agree
// with the engine's date-level override (rulesEngine/shared.ts isDateBlocked)
// about which dates a provider is working, so it imports the same predicate.
// (The Call Counts columns' date-aware bucket, dayTypeBucketOn, is reached
// through lib/callCountColumns rather than imported here.)
import { isActiveSellback } from '@/lib/rulesEngine/shared';
// requiredWorkDaysWithLimit = the engine's per-provider requirement
// (round(work-days FTE × WD) − PTO, overridden by a stated Limits-tab
// workingDays/daysOff entry) — the Call Counts "Working Days" column shows
// actual/required from the SAME function the generation cap uses. The
// work-days FTE (patch43) is the provider's stated work_days_fte, else their
// call fte_value; precedence is Limits tab > work_days_fte > fte_value.
import { requiredWorkDaysWithLimit } from '@/lib/rulesEngine/workDays';
// Pure, client-safe helper shared with the grid API route — one bucket rule
// (hard / soft / warning-never-soft) for both server and client counting.
import { validationSummaryFor, type ValidationSummary } from '@/app/api/scheduling/schedules/[id]/grid/route.helpers';
// Provider limits (2026-07-22, patch34): the Pool modal's Limits tab edits
// schedules.provider_limits through the single-homed shape/parse/field
// helpers — the same parser the PATCH route enforces.
import {
  parseProviderLimits, fieldsFromEntry, entryFromFields, normalizeProviderLimits,
  isInvalidLimitInput, EMPTY_LIMIT_FIELDS,
  type ProviderLimits, type LimitFields,
} from '@/lib/providerLimits';
// Grid zoom (2026-07-22): level list + localStorage round-trip for the
// toolbar's zoom segmented control. Applied as CSS `zoom` on the grid
// container ONLY — uniform scaling keeps every inline sizing literal and
// sticky header offset coupled by construction.
import { GRID_ZOOM_LEVELS, loadGridZoom, saveGridZoom, type GridZoomLevel } from './gridZoom';
// Call splits (2026-07-22): segments render STACKED inside the parent call's
// row cell (parent_call_code lookup — no new grid rows); weights fold under
// the parent for the Call Counts modal via the single-homed callBurden math.
import { isSegmentType, segmentKey, groupSegmentSlots, segmentTag } from './gridSegments';
import { WEIGHT_EPSILON, formatCallWeight } from '@/lib/callBurden';
// Block Targets (2026-07-27): the Pool modal's third tab writes
// schedules.scenario_manifest — the per-provider, per-block call targets the
// engine's scenario layer already honors. Derivation, resolution, the linkage
// grammar and the manifest build are single-homed in blockTargets.ts; the
// panel's own view logic (columns, cell text, linkage application) sits in
// blockTargetsPanel.ts with its test. NOTE: blockTargets imports BUCKET_KEYS
// from paoliBlock/manifest, which pulls zod into this bundle — a cost its
// header accepts to keep ONE list of bucket keys.
import {
  bucketSlotCounts, buildBlockManifest, statedProviders,
  type BlockSlot, type DerivationBasis,
} from '@/lib/blockTargets';
import {
  buildPanelRows, cellTextFromRows, invalidCellKeys, rowsWithCellText,
  strandedEdits, targetEditFingerprint, targetWritePlan,
  type PanelRow, type PoolMember,
} from '@/lib/blockTargetsPanel';
import { BlockTargetsTab } from './BlockTargetsTab';
// Cell picker eligibility (2026-07-28). ALL the logic lives in slotCandidates —
// a pure, tested module that mirrors evaluateEligibility's decisions for the
// subset a client can evaluate (and names the ones it cannot). This component
// only renders what it returns; never add a rule here.
import {
  buildCandidateIndex, candidatesForSlot, filterCandidateGroups, overrideConfirmMessage,
  type CandidateCredentialRow, type CrossSiteBookingRow, type DayShiftRelease,
  type SlotCandidate,
} from '@/lib/slotCandidates';
// Available Call (2026-07-29): every UNFILLED call slot — the grid's red-cell
// predicate and the Available Call List are the SAME function, so a red cell
// and a list row can never disagree. "Unfilled" is row-level (plannerMath's
// assignmentFills), because clearing a cell leaves an OPEN PLACEHOLDER row
// behind and a naive count(assignments) reports those slots as covered.
import {
  buildAvailableCallList, bucketSummaryText, formatAvailableCallText, isUnfilledCallSlot,
} from '@/lib/availableCalls';
import { computeCoverageForecast, formatCalls } from '@/lib/coverageForecast';
import { buildProviderFocusList } from '@/lib/providerFocusList';
import { observanceNotesByDate, observanceLabelFor } from '@/lib/observanceNotes';
import { auditDAssignments, placementsFor } from '@/lib/dAssignmentAudit';
import { weeksOf, printRows, weekLabel } from '@/lib/printableSchedule';
import {
  reviewTightPairs, callsByProvider, gapHistogram, rankSwapCandidates,
} from '@/lib/callSpacing';

/* ── Interfaces ──────────────────────────────────────────────────────────── */

// Auto-generate fill modes (mirrors rulesEngine FillMode; the route degrades
// unknown values to 'all'). 'weekend-only' is the staged flow: weekend call
// first, then a Continue button that runs 'all' over the committed weekend.
type GenFillMode = 'all' | 'obligatory' | 'weekend-only';

interface SiteInfo {
  name: string;
  short_name: string | null;
  timezone: string | null;
  // Optional — older deployments may not have this column on sites. Page
  // defaults to 12 when it's missing (matches the engine's fallback).
  call_par_level?: number | null;
}

interface Schedule {
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

interface EmploymentProfile {
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

interface AvailabilityEntry {
  provider_id: string;
  availability_type: string;
  start_date: string;
  end_date: string;
  approval_status: string;
  // NOTE: the grid route selects `reason_code` (the actual column name) —
  // this field previously said `reason` and silently read as undefined.
  reason_code: string | null;
}

interface Version {
  id: string;
  version_number: number;
  version_status: string;
}

interface ShiftTypeInfo {
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

interface ProviderInfo {
  id: string;
  last_name?: string;
  short_display_name: string;
  initials: string;
  provider_type: string;
}

interface ValidationFlag {
  rule_id: string | null;
  rule_name: string;
  category: string;
  // 'warning' = sentinel flags (e.g. 'validation unavailable — needs
  // re-validation') — counted separately, never as soft violations.
  severity: 'hard' | 'soft' | 'warning';
  message: string;
}

interface AssignmentInfo {
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

// An assignment row as returned by the schedule-assignments API: the grid
// cell shape plus the slot it belongs to, so edits can be patched into grid
// state in place without a full refetch.
interface AssignmentRow extends AssignmentInfo {
  schedule_slot_id: string;
}

interface Slot {
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

interface Provider {
  id: string;
  first_name: string;
  last_name: string;
  short_display_name: string;
  initials: string;
  provider_type: string;
  status: string;
}

interface Holiday {
  holiday_date: string;
  holiday_name: string;
  holiday_type: string;
  is_major_holiday: boolean;
}

interface GridData {
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

interface ActiveCell {
  slotId: string;
  assignmentId: string | null;
  x: number;
  y: number;
}

// Right-click palette target (2026-07-28, patch42). Distinct state from
// ActiveCell so the LEFT-click provider picker is untouched — the two popovers
// never share a code path, and left-click behaves exactly as it always has.
// Only ASSIGNED cells can be marked: the colour describes one provider's call,
// so it is stored on the assignment row and there is nothing to hang it on
// when the cell is open.
interface PaletteCell {
  assignmentId: string;
  current: HighlightColor | null;
  /** Existing cell comment (assignments.notes), null when none. */
  note: string | null;
  label: string;
  x: number;
  y: number;
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function toDateStr(d: Date): string {
  return d.toISOString().split('T')[0];
}

function parseDate(s: string): Date {
  return new Date(s + 'T00:00:00');
}

function formatMMDD(s: string): string {
  const d = parseDate(s);
  return `${d.getMonth() + 1}/${String(d.getDate()).padStart(2, '0')}`;
}

function formatDateRange(start: string, end: string): string {
  const s = parseDate(start);
  const e = parseDate(end);
  const mo = (d: Date) => d.toLocaleString('en-US', { month: 'short' });
  return `${mo(s)} ${s.getDate()} - ${mo(e)} ${e.getDate()}, ${e.getFullYear()}`;
}

function getDayOfWeek(s: string): number {
  return parseDate(s).getDay();
}

function allDatesInRange(start: string, end: string): string[] {
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
function callCensusFromGrid(grid: GridData): CallObligationCensus {
  return computeCallObligationCensus({
    // ?? 12 matches the engine's DEFAULT_PAR_LEVEL fallback.
    storedParLevel: grid.schedule.sites?.call_par_level ?? 12,
    siteId: grid.schedule.site_id,
    includedProviderIds: grid.schedule.included_provider_ids,
    profiles: grid.profiles || [],
    slots: grid.slots,
  });
}

function getWeekStart(dates: string[], offset: number): number {
  // Find the first Sunday on or before the start, then offset by weeks
  const first = parseDate(dates[0]);
  const dayOfWeek = first.getDay();
  const startIdx = -dayOfWeek + offset * 7;
  return Math.max(0, startIdx);
}

function colorWithAlpha(hex: string | null, alpha: number): string {
  if (!hex) return `rgba(100,116,139,${alpha})`;
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/* ── Main Page ───────────────────────────────────────────────────────────── */

export default function ScheduleGridPage({ params }: { params: { id: string } }) {
  const { id } = params;
  const [grid, setGrid] = useState<GridData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'week' | 'month' | 'calendar'>('month');
  // Month offset for calendar view — index 0 = first month touched by the
  // schedule, increments forward. Reset to 0 whenever the user picks a new
  // view mode so navigation is unambiguous.
  const [calendarMonthOffset, setCalendarMonthOffset] = useState(0);
  const [weekOffset, setWeekOffset] = useState(0);
  const [activeCell, setActiveCell] = useState<ActiveCell | null>(null);
  const [paletteCell, setPaletteCell] = useState<PaletteCell | null>(null);
  const [pickerSearch, setPickerSearch] = useState('');
  // Cell picker: is the "Unavailable (n)" section expanded? Collapsed by
  // default and reset every time the picker opens on a new cell.
  const [showBlockedCandidates, setShowBlockedCandidates] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Day-shift release partial failure (2026-07-28). DELIBERATELY a second,
  // STICKY error state rather than a flavour of actionError: this is the one
  // edit on the page that can leave TWO slots changed when only one was asked
  // for, and a 3-second auto-dismissing toast is indistinguishable from silence
  // for anyone who looked away mid-click. It stays until dismissed.
  const [swapFailure, setSwapFailure] = useState<string | null>(null);
  const [showCounts, setShowCounts] = useState(false);
  // Available Call List (2026-07-29) — sits with the other analysis views.
  const [showAvailableCalls, setShowAvailableCalls] = useState(false);
  const [showSpacing, setShowSpacing] = useState(false);
  // The schedule print area is mounted ONLY while printing it (2026-08-02
  // regression fix). It used to be mounted whenever the grid existed, and its
  // stylesheet hides `body *` then un-hides its own root — so every OTHER
  // print surface (Call Counts, Available Call, Check D) un-hid its root while
  // this one un-hid the schedule, and both printed. Mounting on demand removes
  // the collision structurally rather than asking each modal to remember to
  // suppress this one.
  const [printingSchedule, setPrintingSchedule] = useState(false);
  const [showDAudit, setShowDAudit] = useState(false);
  const [applyingD, setApplyingD] = useState(false);
  // Threshold in DAYS for "too close". A control rather than a constant: what
  // counts as tight is a judgement about this practice, and the histogram in
  // the panel shows the distribution so it can be set from the board.
  const [spacingMaxGap, setSpacingMaxGap] = useState(3);
  // PROVIDER FOCUS (Gabriel 2026-07-29): "highlight a specific provider so that
  // I can easily see which days they are on call". View state only — nothing is
  // written, so it costs nothing to leave on and clears on reload.
  const [focusPid, setFocusPid] = useState<string | null>(null);
  // Calls-only for TARGETED runs, default ON — relief day slots are a
  // whole-pool distribution decision and doing them one provider at a time
  // produces contiguous same-code blocks. Unchecking is available for a
  // deliberate full single-provider run.
  const [targetedCallsOnly, setTargetedCallsOnly] = useState(true);
  // Which call slots a run attempts. Orthogonal to the fill mode, so
  // "obligatory + weekday only" is expressible — the combination Gabriel wants
  // after entering the weekend schedule by hand.
  const [dayScope, setDayScope] = useState<'' | 'weekday' | 'weekend'>('');
  const [showAssistant, setShowAssistant] = useState(false);
  // Inline rename (Gabriel 2026-07-22): the header pencil PATCHes
  // schedule_name (route-validated: trimmed, non-empty, ≤ 120). Local grid
  // state is patched on success — every other surface (dashboard, pickers,
  // banners) reads the column, so the rename propagates on their next load.
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const paletteRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  /* ── Data Fetching ──────────────────────────────────────────────────────── */

  const loadGrid = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/scheduling/schedules/${id}/grid`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`Failed to load schedule (${res.status})`);
      const data: GridData = await res.json();
      setGrid(data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { loadGrid(); }, [loadGrid]);

  const saveRename = useCallback(async () => {
    const trimmed = renameValue.trim();
    if (!grid || !trimmed || trimmed === grid.schedule.schedule_name) {
      setRenaming(false);
      return;
    }
    setRenameBusy(true);
    try {
      const res = await fetch(`/api/scheduling/schedules/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schedule_name: trimmed }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setActionError(data.error || `Rename failed (${res.status})`);
        return;
      }
      setGrid(g => g ? { ...g, schedule: { ...g.schedule, schedule_name: trimmed } } : g);
      setRenaming(false);
    } finally {
      setRenameBusy(false);
    }
  }, [grid, id, renameValue]);

  /* ── Close picker on outside click / Escape ─────────────────────────────── */

  useEffect(() => {
    if (!activeCell) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setActiveCell(null); setPickerSearch(''); }
    };
    const handleClick = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setActiveCell(null);
        setPickerSearch('');
      }
    };
    document.addEventListener('keydown', handleKey);
    document.addEventListener('mousedown', handleClick, true);
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.removeEventListener('mousedown', handleClick, true);
    };
  }, [activeCell]);

  useEffect(() => {
    if (activeCell && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [activeCell]);

  /* ── Close the highlight palette on outside click / Escape ───────────────── */
  // Same dismissal contract as the picker above, and deliberately NO focus
  // handling: the palette never moves focus in, so it cannot trap it. Escape
  // and any click elsewhere close it; tabbing away just leaves it open behind
  // you until the next click, exactly like the picker.
  useEffect(() => {
    if (!paletteCell) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPaletteCell(null);
    };
    const handleClick = (e: MouseEvent) => {
      if (paletteRef.current && !paletteRef.current.contains(e.target as Node)) {
        setPaletteCell(null);
      }
    };
    document.addEventListener('keydown', handleKey);
    document.addEventListener('mousedown', handleClick, true);
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.removeEventListener('mousedown', handleClick, true);
    };
  }, [paletteCell]);

  /* ── Clear action error after 3s ────────────────────────────────────────── */

  useEffect(() => {
    if (!actionError) return;
    const t = setTimeout(() => setActionError(null), 3000);
    return () => clearTimeout(t);
  }, [actionError]);

  /* ── Derived Data ───────────────────────────────────────────────────────── */

  const { shiftTypes, allDates, slotMap, segmentsByParent, holidayMap, assignedOnDate, availableByDate, offByDate, offTitleByDate, icuByDate, ptoByDate, postCallByDate, maxAvailable, maxOff, maxIcu, maxPto, maxPostCall, callTakerIds, sellbackByDate } = useMemo(() => {
    const empty = {
      shiftTypes: [] as ShiftTypeInfo[], allDates: [] as string[],
      slotMap: {} as Record<string, Record<string, Slot>>,
      segmentsByParent: new Map<string, Slot[]>(),
      holidayMap: {} as Record<string, Holiday>,
      assignedOnDate: {} as Record<string, Set<string>>,
      availableByDate: {} as Record<string, Provider[]>,
      offByDate: {} as Record<string, Provider[]>,
      offTitleByDate: {} as Record<string, Record<string, string>>,
      icuByDate: {} as Record<string, Provider[]>,
      maxIcu: 0,
      ptoByDate: {} as Record<string, Provider[]>,
      postCallByDate: {} as Record<string, Provider[]>,
      maxAvailable: 0, maxOff: 0, maxPto: 0, maxPostCall: 0,
      callTakerIds: new Set<string>(),
      sellbackByDate: {} as Record<string, Set<string>>,
    };
    if (!grid) return empty;

    // Unique shift types sorted by display_order. Call-split SEGMENT types
    // (parent_call_code set) get NO row of their own — their slots render
    // stacked inside the parent call's row via segmentsByParent below.
    const stMap = new Map<string, ShiftTypeInfo>();
    for (const slot of grid.slots) {
      if (isSegmentType(slot.shift_types)) continue;
      if (!stMap.has(slot.shift_type_id)) stMap.set(slot.shift_type_id, slot.shift_types);
    }
    // Orphan-parent fallback: if EVERY slot of a parent call got split (no
    // whole slot left anywhere in the block), synthesize a minimal row from
    // the segment metadata so the split cells still have a row to live in.
    for (const slot of grid.slots) {
      const st = slot.shift_types;
      if (!isSegmentType(st)) continue;
      const parentCode = st.parent_call_code!;
      const hasParentRow = [...stMap.values()].some(row => row.code === parentCode);
      if (!hasParentRow && !stMap.has(`segment-parent-${parentCode}`)) {
        stMap.set(`segment-parent-${parentCode}`, {
          id: `segment-parent-${parentCode}`, code: parentCode, name: `${parentCode} (split)`,
          color_hex: st.color_hex, category: st.category, call_type: st.call_type,
          display_order: (st.display_order ?? 999) - 1, provider_group: st.provider_group,
        });
      }
    }
    const shiftTypes = Array.from(stMap.values()).sort((a, b) => (a.display_order ?? 999) - (b.display_order ?? 999));

    // Segment slots grouped under `${parentCode}|${date}` for the stacked cell.
    const segmentsByParent = groupSegmentSlots(grid.slots);

    const allDates = allDatesInRange(grid.schedule.date_start, grid.schedule.date_end);

    const slotMap: Record<string, Record<string, Slot>> = {};
    for (const slot of grid.slots) {
      if (!slotMap[slot.shift_type_id]) slotMap[slot.shift_type_id] = {};
      slotMap[slot.shift_type_id][slot.slot_date] = slot;
    }

    const holidayMap: Record<string, Holiday> = {};
    for (const h of grid.holidays) holidayMap[h.holiday_date] = h;

    const assignedOnDate: Record<string, Set<string>> = {};
    for (const slot of grid.slots) {
      if (!assignedOnDate[slot.slot_date]) assignedOnDate[slot.slot_date] = new Set();
      for (const a of slot.assignments) {
        if (a.provider_id) assignedOnDate[slot.slot_date].add(a.provider_id);
      }
    }

    // Virtual rows: PTO / Available / Off
    //   PTO:        planned vacation-style leave (PTO / FMLA / parental /
    //               military). Narrower than before — sick and jury_duty
    //               previously bucketed into PTO are now under Off, which
    //               better matches "days of PTO used" in Call Counts and
    //               the user's mental model.
    //   Off:        unavailable / blocked / sick / jury duty, OR non-call-takers
    //   Available:  home-site call-takers with no assignment and no availability
    //               entry — the 'overflow' pool who could have worked but didn't
    //               make it into the D-slot cut
    const PTO_TYPES = new Set(['pto', 'fmla', 'parental_leave', 'military_leave']);
    const OFF_TYPES = new Set(['unavailable', 'blocked', 'sick', 'jury_duty']);
    const siteId = grid.schedule.site_id;
    const homeSiteIds = new Set<string>();
    // callTakerIds = profile-level call-taker pool. Includes both full and
    // partial call-takers; these are the providers who get auto-assigned.
    // Anyone assigned to a call slot who is NOT in this set is "picking up
    // extra call" — legal, but rendered in blue as a visual signal.
    const callTakerIds = new Set<string>();
    for (const p of grid.profiles || []) {
      if (p.home_site_id === siteId) {
        homeSiteIds.add(p.provider_id);
        if (p.call_taker || p.partial_call_taker) callTakerIds.add(p.provider_id);
      }
    }
    const providerById: Record<string, Provider> = {};
    for (const p of grid.providers) providerById[p.id] = p;

    // Expand availability entries into per-date maps. ptoByDate gets the
    // PTO/sick/etc; scheduledOffByDate gets the 'unavailable'/'blocked'
    // entries (used to mark a part-timer's regular off days).
    const ptoByDate: Record<string, Provider[]> = {};
    const scheduledOffByDate: Record<string, Set<string>> = {};
    // Off-row hover labels keyed by date→provider. Currently only reason-coded
    // blocked entries (icu_week / icu_post_call) get one, so an ICU doc's Off
    // cell reads "ICU Week" instead of looking like a generic day off.
    const offTitleByDate: Record<string, Record<string, string>> = {};
    // ICU rotation (Gabriel 2026-08-02): its own row below Off. Keyed off the
    // SAME reason codes the hover label already uses (REASON_CODE_LABELS —
    // icu_week / icu_post_call), so the row and the tooltip can never disagree
    // about what counts as ICU, and adding a third ICU code there lights this
    // up for free. These rows are blocking availability either way; this only
    // changes which row they render in.
    const icuByDate: Record<string, Provider[]> = {};
    const allDatesSet = new Set(allDates);

    // PTO sell-back coverage (2026-07-20): a LIVE pto_sellback row means the
    // provider IS WORKING those dates — it overrides blocking coverage
    // date-by-date (engine: rulesEngine/shared.ts isDateBlocked, incl.
    // pending PTO). Mirrored here so the virtual rows agree with the engine:
    // on a sold-back date the provider is excluded from PTO/Off and shows in
    // Available (red) or their assignment cell (red SB marker). Precomputed
    // BEFORE the PTO/Off expansion so those loops can consult it.
    const sellbackByDate: Record<string, Set<string>> = {};
    for (const avail of grid.availability || []) {
      if (!isActiveSellback(avail)) continue;
      const start = new Date(avail.start_date + 'T00:00:00Z');
      const end = new Date(avail.end_date + 'T00:00:00Z');
      for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
        const ds = d.toISOString().slice(0, 10);
        if (!allDatesSet.has(ds)) continue;
        if (!sellbackByDate[ds]) sellbackByDate[ds] = new Set();
        sellbackByDate[ds].add(avail.provider_id);
      }
    }

    for (const avail of grid.availability || []) {
      // Only approved entries show up in virtual rows — pending/denied
      // entries shouldn't visually occupy a slot until an admin signs off.
      if (avail.approval_status !== 'approved') continue;
      const provider = providerById[avail.provider_id];
      if (!provider) continue;
      const isPto = PTO_TYPES.has(avail.availability_type);
      const isOff = OFF_TYPES.has(avail.availability_type);
      if (!isPto && !isOff) continue;
      // PTO shows everyone regardless of home site — a cross-site doc on
      // vacation is still meaningful context on this schedule. Off-row
      // keeps the home-site gate since "non-working days" only makes
      // sense for your own pool.
      if (isOff && !homeSiteIds.has(avail.provider_id)) continue;
      const start = new Date(avail.start_date + 'T00:00:00Z');
      const end = new Date(avail.end_date + 'T00:00:00Z');
      for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
        const ds = d.toISOString().slice(0, 10);
        if (!allDatesSet.has(ds)) continue;
        // Sell-back override: a sold-back date is a WORKING date — never
        // rendered as PTO or Off, regardless of what blocking rows cover it.
        if (sellbackByDate[ds]?.has(provider.id)) continue;
        if (isPto) {
          if (!ptoByDate[ds]) ptoByDate[ds] = [];
          if (!ptoByDate[ds].some(p => p.id === provider.id)) ptoByDate[ds].push(provider);
        }
        if (isOff) {
          if (!scheduledOffByDate[ds]) scheduledOffByDate[ds] = new Set();
          scheduledOffByDate[ds].add(provider.id);
          const label = reasonCodeLabel(avail.reason_code);
          if (label && label !== avail.reason_code) {
            if (!offTitleByDate[ds]) offTitleByDate[ds] = {};
            offTitleByDate[ds][provider.id] = label;
            // A recognised reason code IS the ICU vocabulary today. Collected
            // here so the Off bucket below can exclude them.
            if (!icuByDate[ds]) icuByDate[ds] = [];
            if (!icuByDate[ds].some(x => x.id === provider.id)) icuByDate[ds].push(provider);
          }
        }
      }
    }
    for (const list of Object.values(ptoByDate)) list.sort((a, b) => a.short_display_name.localeCompare(b.short_display_name));

    // Post-call detection: a provider who had a call-category shift yesterday
    // is post-call today. The auto-gen explicitly blocks them from other
    // shifts (via in-memory markAssigned) but that doesn't persist to the
    // DB, so without this UI pass they'd otherwise silently land in the
    // Available row despite being unavailable. C2 post-call providers
    // appear in the D1 slot already (an actual assignment), so the
    // "not already assigned today" check below keeps them out of this
    // bucket — they render in their D1 slot, which is correct.
    //
    // Shift codes that do NOT trigger a post-call day off (provider
    // continues working normally the next day). Currently just C3 —
    // neuro call doesn't confer post-call relief because those docs
    // work their regular Monday schedule after Sunday neuro call.
    const NON_POST_CALL_CODES = new Set(['C3']);
    const postCallByDate: Record<string, Provider[]> = {};
    const addDaysStr = (iso: string, n: number) => {
      const d = new Date(iso + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + n);
      return d.toISOString().slice(0, 10);
    };
    for (const slot of grid.slots) {
      const st = slot.shift_types;
      if (!st || st.category !== 'call') continue;
      if (NON_POST_CALL_CODES.has(st.code)) continue;
      // Call splits (2026-07-22, decision 3): post-call rest belongs to the
      // OVERNIGHT segment holder only. A day/evening SEGMENT (parent set,
      // requires_post_call_rule false) confers no rest — its holder stays
      // Available tomorrow, never in this row. Whole-call rows (incl. C2's
      // colloquial post-call display) keep the pre-split behavior.
      if (isSegmentType(st) && !st.requires_post_call_rule) continue;
      for (const a of slot.assignments || []) {
        if (!a.provider_id) continue;
        const nextDay = addDaysStr(slot.slot_date, 1);
        if (!allDatesSet.has(nextDay)) continue;
        const provider = providerById[a.provider_id];
        if (!provider) continue;
        // Only show post-call in this row if the provider has no other
        // assignment that next day. If they do (e.g. D1 post-call-for-C2),
        // they render in that slot instead.
        if ((assignedOnDate[nextDay] || new Set()).has(a.provider_id)) continue;
        if (!postCallByDate[nextDay]) postCallByDate[nextDay] = [];
        if (!postCallByDate[nextDay].some(p => p.id === provider.id)) {
          postCallByDate[nextDay].push(provider);
        }
      }
    }
    for (const list of Object.values(postCallByDate)) list.sort((a, b) => a.short_display_name.localeCompare(b.short_display_name));

    // Categorize each home-site provider per day:
    //   - PTO entry that day      → ptoByDate (already set above)
    //   - post-call (call shift yesterday, nothing today) → postCallByDate
    //   - scheduled-off entry that day OR non-call-taker → Off
    //   - home-site call-taker with no entry, not assigned → Available
    const availableByDate: Record<string, Provider[]> = {};
    const offByDate: Record<string, Provider[]> = {};
    for (const date of allDates) {
      const assigned = assignedOnDate[date] || new Set<string>();
      const ptoSet = new Set((ptoByDate[date] || []).map(p => p.id));
      const postCallSet = new Set((postCallByDate[date] || []).map(p => p.id));
      const offSet = scheduledOffByDate[date] || new Set<string>();
      // ICU renders in its own row — a provider is in ONE bucket, never both.
      const icuSet = new Set((icuByDate[date] || []).map(p => p.id));
      const available: Provider[] = [];
      const off: Provider[] = [];
      for (const pid of homeSiteIds) {
        if (assigned.has(pid) || ptoSet.has(pid) || postCallSet.has(pid)) continue;
        // PTO stays ahead of ICU (checked above): a provider on leave is not in
        // the unit, even when an icu_week row spans their leave — which is
        // exactly Hussain's 8/31 and 9/6-9/7.
        if (icuSet.has(pid)) continue;
        const provider = providerById[pid];
        if (!provider) continue;
        // Selling back PTO today → explicitly working: force Available (red
        // treatment in the renderer) even for non-call-takers, who would
        // otherwise fall into Off. If they're assigned they never reach here
        // (they render in their assignment cell with the SB marker).
        if (sellbackByDate[date]?.has(pid)) { available.push(provider); continue; }
        // Off bucket: explicit scheduled-off that day, or a non-call-taker.
        // Everyone else at home-site goes to Available (call-taker overflow).
        if (offSet.has(pid) || !callTakerIds.has(pid)) off.push(provider);
        else available.push(provider);
      }
      available.sort((a, b) => a.short_display_name.localeCompare(b.short_display_name));
      off.sort((a, b) => a.short_display_name.localeCompare(b.short_display_name));
      availableByDate[date] = available;
      offByDate[date] = off;
    }

    for (const list of Object.values(icuByDate)) {
      list.sort((a, b) => a.short_display_name.localeCompare(b.short_display_name));
    }
    const maxIcu = Math.max(0, ...Object.values(icuByDate).map(v => v.length));
    const maxAvailable = Math.max(0, ...Object.values(availableByDate).map(v => v.length));
    const maxOff = Math.max(0, ...Object.values(offByDate).map(v => v.length));
    const maxPto = Math.max(0, ...Object.values(ptoByDate).map(v => v.length));
    const maxPostCall = Math.max(0, ...Object.values(postCallByDate).map(v => v.length));

    return { shiftTypes, allDates, slotMap, segmentsByParent, holidayMap, assignedOnDate, availableByDate, offByDate, offTitleByDate, icuByDate, ptoByDate, postCallByDate, maxAvailable, maxOff, maxIcu, maxPto, maxPostCall, callTakerIds, sellbackByDate };
  }, [grid]);

  /* ── Available Call (2026-07-29) ─────────────────────────────────────────
   * Every unfilled call slot in the block. Derived ONCE here and handed to
   * both the toolbar badge and the modal, so the count on the button and the
   * rows in the list are the same object — they cannot drift. Every rule
   * (the open-placeholder-safe predicate, the day-type buckets, the
   * consecutive-date clustering, the plain-text form) lives in the module. */
  const availableCalls = useMemo(
    () => buildAvailableCallList(grid?.slots ?? [], grid?.holidays ?? []),
    [grid],
  );

  // D-assignment audit (2026-08-02): re-derive every D1-D8 placement from the
  // calls around it. Recomputed from the grid, so it always reflects the
  // switches just made rather than a cached verdict.
  const dAudit = useMemo(
    () => (grid?.callPattern
      ? auditDAssignments(grid.slots, grid.callPattern)
      : { findings: [], placements: [] }),
    [grid],
  );

  // Print the schedule: mount the print area, let React paint it, then open
  // the dialog. Reset on `afterprint` rather than straight after print() —
  // print() does not block in every browser, and unmounting mid-print would
  // hand the printer a blank page.
  useEffect(() => {
    if (!printingSchedule) return;
    const done = () => setPrintingSchedule(false);
    window.addEventListener('afterprint', done);
    const raf = requestAnimationFrame(() => window.print());
    return () => {
      window.removeEventListener('afterprint', done);
      cancelAnimationFrame(raf);
    };
  }, [printingSchedule]);

  // Observance captions (2026-07-31). Labels ONLY — no cell tint, and
  // deliberately not holiday_calendars rows, so nothing about templates,
  // day-type buckets or the pattern chains changes.
  const observanceByDate = useMemo(() => observanceNotesByDate(), []);

  /* ── Call spacing (2026-07-31) ───────────────────────────────────────────
   * Tight FIRST-CALL adjacencies. Scoped to the primary call code (call_rank 0,
   * never a code literal) because that is the burden Gabriel asked about and
   * because same-code pairs have no structural excuse — a Sat C2 → Sun C1 is
   * one day apart by design. */
  const primaryCallCode = useMemo(() => {
    const st = (grid?.slots ?? [])
      .map(s => s.shift_types)
      .find(t => t?.category === 'call' && t?.call_rank === 0);
    return st?.parent_call_code || st?.code || 'C1';
  }, [grid]);

  const spacingReview = useMemo(
    () => (grid
      ? reviewTightPairs(grid.slots, primaryCallCode, spacingMaxGap)
      : { pairs: [], excludedChainLocked: 0 }),
    [grid, primaryCallCode, spacingMaxGap],
  );
  const spacingTightCount = spacingReview.pairs.length;

  /* ── Provider focus (2026-07-29) ─────────────────────────────────────────
   * Who the focus selector offers: providers who actually hold something in
   * this block. Offering the whole roster would list people with nothing to
   * find, and picking one would blank the grid — a control that can only
   * disappoint. Sorted by display name so the list reads like the board. */
  // Who the focus selector offers — buildProviderFocusList owns the rule and
  // its tests (the empty-fresh-schedule case regressed once already).
  const focusableProviders = useMemo(() => (grid ? buildProviderFocusList({
    providers: grid.providers,
    profiles: grid.profiles,
    slots: grid.slots,
    siteId: grid.schedule.site_id,
    includedProviderIds: grid.schedule.included_provider_ids,
  }) : []), [grid]);

  /* ── Per-date working roster + over-par detection ───────────────────────── */

  // Whole-number obligations, TOTAL level (2026-07-17): a provider's
  // obligation = round(total call slots ÷ par × FTE) — summed across every
  // call code and day bucket, then rounded half-up. Par-authoritative
  // (Gabriel 2026-07-24): the denominator is the stored call_par_level
  // verbatim — the SAME one the engine's obligatory-mode cap uses. With the
  // live shape (par 11, pool 8.75 FTE) obligations deliberately under-cover
  // the schedule; calls past someone's obligation are the paid-pickup layer
  // and get the OVER treatment. When the held call WEIGHT exceeds the
  // obligation, the OVER treatment lands on the SMALLEST-total-weight set of
  // the provider's assignments that brings the rest back to the obligation,
  // later dates winning a tie (2026-07-29 — so a 12h 0.5 split is flagged
  // ahead of a whole call when a half is all they are over by; with every
  // weight 1 this is still exactly the last N = actual − obligation).
  // Calls up to the rounded obligation are NEVER labeled extra.
  // Census + selection are single-homed in callCensusFromGrid /
  // computeCallObligationCensus (src/lib/fteTarget.ts) — the Call Counts
  // modal consumes the identical census, so grid and modal can't drift.
  // Deficit carry-forward (which the engine adds to its quota caps) is still
  // NOT included here — it requires historical data outside this schedule; a
  // provider catching up from a prior block may legitimately exceed their
  // base obligation. Treat OVER as a "look at this" flag, not a violation.
  const { mdCountByDate, crnaCountByDate, workingByDate, overParAssignmentIds } = useMemo(() => {
    const empty = {
      mdCountByDate: {} as Record<string, number>,
      crnaCountByDate: {} as Record<string, number>,
      workingByDate: {} as Record<string, Array<{
        assignmentId: string;
        providerId: string;
        last_name: string;
        initials: string;
        shortName: string;
        shiftCode: string;
        color: string;
        providerType: string;
        // Counts toward the MD/CRNA daytime total. False for weekday C1
        // (overnight call only — included in the visual list, but not in
        // the headline count). Matches the grid view's column-header rule.
        countsTowardCount: boolean;
        // Hand-set billing mark (patch42) — see CalendarWorker.
        highlight: HighlightColor | null;
      }>>,
      overParAssignmentIds: new Set<string>(),
    };
    if (!grid) return empty;

    const providerById = new Map<string, Provider>();
    for (const p of grid.providers) providerById.set(p.id, p);

    // Shared census (see callCensusFromGrid): effective-par denominator +
    // every-call-slot totals + last-N OVER selection, identical to the modal.
    const overParAssignmentIds = callCensusFromGrid(grid).overParAssignmentIds;

    // Per-date working roster. The list INCLUDES every assignment so the
    // viewer sees who's nominally on the schedule. The MD/CRNA totals are
    // a separate filtered count:
    //   - Include weekend C1 (24h call → on-floor all day)
    //   - Exclude weekday C1 from the count (overnight call → not on floor
    //     during the day) — still rendered in the list
    //   - Include everything else (C2, C3, D1-D9, day shifts, etc.)
    const mdCountByDate: Record<string, number> = {};
    const crnaCountByDate: Record<string, number> = {};
    const workingByDate: Record<string, Array<{
      assignmentId: string;
      providerId: string;
      last_name: string;
      initials: string;
      shortName: string;
      shiftCode: string;
      color: string;
      providerType: string;
      countsTowardCount: boolean;
      highlight: HighlightColor | null;
    }>> = {};

    for (const slot of grid.slots) {
      const date = slot.slot_date;
      const code = slot.shift_types.code;
      const dow = getDayOfWeek(date);
      const isWeekday = dow >= 1 && dow <= 5;
      const countsTowardCount = !(code === 'C1' && isWeekday);
      for (const a of slot.assignments) {
        if (!a.provider_id || !a.providers) continue;
        const provider = providerById.get(a.provider_id);
        const lastName = provider?.last_name || a.providers.last_name || '';
        const initials = provider?.initials || a.providers.initials || '';
        const shortName = a.providers.short_display_name;
        const type = a.providers.provider_type;
        if (!workingByDate[date]) workingByDate[date] = [];
        workingByDate[date].push({
          assignmentId: a.id,
          providerId: a.provider_id,
          last_name: lastName,
          initials,
          shortName,
          shiftCode: code,
          color: slot.shift_types.color_hex || '#64748b',
          providerType: type,
          countsTowardCount,
          highlight: normalizeHighlightColor(a.highlight_color),
        });
      }
    }

    // Stable sort rank: C-shifts first (C1 → C2 → C3), then D-shifts in
    // numeric order (D1 → D9), then everything else (Day Doc shift codes
    // like 7-3, 7-5 — these aren't part of the call/relief chain so they
    // sit at the bottom of the cell).
    const shiftRank = (code: string): number => {
      if (code === 'C1') return 1;
      if (code === 'C2') return 2;
      if (code === 'C3') return 3;
      const m = /^D(\d+)$/.exec(code);
      if (m) return 10 + parseInt(m[1], 10);
      return 100;
    };

    for (const [date, list] of Object.entries(workingByDate)) {
      const mdSet = new Set<string>();
      const crnaSet = new Set<string>();
      for (const w of list) {
        if (!w.countsTowardCount) continue;
        if (w.providerType === 'physician') mdSet.add(w.providerId);
        else if (w.providerType === 'crna' || w.providerType === 'aa') crnaSet.add(w.providerId);
      }
      mdCountByDate[date] = mdSet.size;
      crnaCountByDate[date] = crnaSet.size;
      list.sort((a, b) =>
        shiftRank(a.shiftCode) - shiftRank(b.shiftCode) ||
        a.shiftCode.localeCompare(b.shiftCode) ||
        (a.last_name || a.initials).localeCompare(b.last_name || b.initials)
      );
    }

    return { mdCountByDate, crnaCountByDate, workingByDate, overParAssignmentIds };
  }, [grid]);

  /* ── Visible dates based on view mode ───────────────────────────────────── */

  const visibleDates = useMemo(() => {
    if (viewMode === 'month') return allDates;
    if (viewMode === 'calendar') return allDates;
    if (allDates.length === 0) return [];
    const startIdx = getWeekStart(allDates, weekOffset);
    return allDates.slice(startIdx, startIdx + 7);
  }, [viewMode, weekOffset, allDates]);

  const todayStr = toDateStr(new Date());

  /* ── Assignment Actions ─────────────────────────────────────────────────── */

  // Patch API-returned assignment rows into grid state by slot id. The
  // schedule-assignments routes return every affected row (the edited cell +
  // auto-filled/evicted/cleared siblings) in the grid column shape, so cell
  // edits don't need a full loadGrid() refetch. One assignment row per slot
  // (UNIQUE schedule_slot_id), so each matched slot's array is replaced.
  const applyAssignmentRows = useCallback((rows: AssignmentRow[]) => {
    setGrid(g => {
      if (!g) return g;
      const bySlot = new Map(rows.map(r => [r.schedule_slot_id, r]));
      return {
        ...g,
        slots: g.slots.map(s => {
          const row = bySlot.get(s.id);
          return row ? { ...s, assignments: [row] } : s;
        }),
      };
    });
  }, []);

  // ── The day-shift release (2026-07-28) ──────────────────────────────────
  // Gabriel: "anyone in a D4 and up slot on a day that has an empty call slot
  // … they are technically available to be placed on call that day and taken
  // out of the D spot." slotCandidates decides WHETHER (pattern-derived — see
  // its header); this performs it. Two writes, and the ORDER is the decision:
  //
  //   CLEAR THE DAY SHIFT FIRST, THEN PLACE THE CALL.
  //
  // Place-then-clear leaves, on a failed clear, the provider on the call AND
  // on the day shift — a same-date double-booking, the exact state the engine
  // forbids. Worse, POST evaluates BEFORE it writes, so the call row would be
  // stamped with flags computed against a world that the clear was supposed to
  // change. Clear-then-place fails the other way: two OPEN slots. That is a
  // coverage gap, not a clinical violation; it is plainly visible on the grid;
  // and it is fixable with the same picker already in the scheduler's hand.
  // Under-cover over mis-cover is this app's posture everywhere else too.
  //
  // NOT ATOMIC, and deliberately not. Real atomicity needs both writes in one
  // transaction, which the Supabase JS client cannot express — it would take a
  // Postgres function behind an RPC, i.e. a migration. A new server route that
  // ran both writes in sequence would NOT be atomic either; it would only
  // shrink the window and save a round-trip. So the window is real, and the
  // answer is loudness: any partial outcome resyncs from the server and raises
  // the STICKY swapFailure banner naming exactly which slots are now open.
  const assignProvider = async (
    slotId: string, providerId: string, release?: DayShiftRelease | null,
  ) => {
    if (!grid) return;
    const shifts = release?.shifts ?? [];
    const who = grid.providers.find(p => p.id === providerId)?.short_display_name ?? 'The provider';
    const targetCode = grid.slots.find(s => s.id === slotId)?.shift_types?.code ?? 'this slot';
    const releasedSlotIds = new Set(shifts.map(s => s.slotId));

    // Optimistic update — the target cell fills, every released cell empties.
    const prevSlots = [...grid.slots];
    setGrid({
      ...grid,
      slots: grid.slots.map(s => {
        if (releasedSlotIds.has(s.id)) return { ...s, assignments: [] };
        if (s.id !== slotId) return s;
        const provider = grid.providers.find(p => p.id === providerId);
        const newAssignment: AssignmentInfo = {
          id: 'temp-' + Date.now(),
          provider_id: providerId,
          assignment_status: 'assigned',
          is_open_call: false,
          manually_overridden: true,
          providers: provider ? { id: provider.id, short_display_name: provider.short_display_name, initials: provider.initials, provider_type: provider.provider_type } : null,
        };
        return { ...s, assignments: [newAssignment] };
      }),
    });
    setActiveCell(null);
    setPickerSearch('');

    // ── Step 1: vacate the day shift(s). Any failure aborts the whole move —
    // the call is NOT placed, so nobody is ever double-booked.
    const freed: string[] = [];
    for (const rel of shifts) {
      let why: string | null = null;
      try {
        const res = await fetch(`/api/scheduling/schedule-assignments?id=${rel.assignmentId}`, { method: 'DELETE' });
        const data = await res.json().catch(() => null);
        if (!res.ok) why = data?.error || `HTTP ${res.status}`;
        else if (data?.assignment) {
          applyAssignmentRows([data.assignment as AssignmentRow, ...((data.siblings ?? []) as AssignmentRow[])]);
        }
      } catch (e) {
        why = e instanceof Error ? e.message : 'request failed';
      }
      if (why) {
        setGrid({ ...grid, slots: prevSlots });
        setSwapFailure(
          `Could not clear ${who} from ${rel.code}, so the ${targetCode} assignment was not made (${why}).`
          + (freed.length > 0
            ? ` ${who} was already cleared from ${freed.join(', ')} — ${freed.length > 1 ? 'those slots are' : 'that slot is'} open now.`
            : ' Nothing else was changed.'));
        await loadGrid();
        return;
      }
      freed.push(rel.code);
    }

    // ── Step 2: place the call.
    try {
      const res = await fetch('/api/scheduling/schedule-assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schedule_slot_id: slotId, provider_id: providerId }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setGrid({ ...grid, slots: prevSlots });
        if (freed.length > 0) {
          setSwapFailure(`${who} was cleared from ${freed.join(', ')} but could NOT be placed on ${targetCode}`
            + ` (${data?.error || `HTTP ${res.status}`}). ${freed.join(', ')} and ${targetCode} are all open now — reassign from the grid.`);
        } else {
          setActionError(data?.error || 'Failed to assign');
        }
        // The write may have partially landed (sequence auto-fill runs after
        // the upsert) — resync from the server rather than trusting local state.
        await loadGrid();
        return;
      }
      // Patch the returned rows (real ids + validation flags + auto-filled
      // siblings) over the optimistic paint; no full refetch needed.
      if (data?.assignment) {
        applyAssignmentRows([data.assignment as AssignmentRow, ...((data.siblings ?? []) as AssignmentRow[])]);
      } else {
        await loadGrid();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to assign provider';
      setGrid({ ...grid, slots: prevSlots });
      if (freed.length > 0) {
        // The POST may or may not have landed — the day shift is definitely
        // gone, so the server is the only honest source here.
        setSwapFailure(`${who} was cleared from ${freed.join(', ')} but the ${targetCode} assignment failed (${msg}).`
          + ' Check the grid — the call may not have been placed.');
        await loadGrid();
      } else {
        setActionError(msg);
      }
    }
  };

  const removeAssignment = async (assignmentId: string) => {
    if (!grid) return;
    const prevSlots = [...grid.slots];
    setGrid({
      ...grid,
      slots: grid.slots.map(s => ({
        ...s,
        assignments: s.assignments.filter(a => a.id !== assignmentId),
      })),
    });
    setActiveCell(null);

    try {
      const res = await fetch(`/api/scheduling/schedule-assignments?id=${assignmentId}`, { method: 'DELETE' });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setGrid({ ...grid, slots: prevSlots });
        setActionError(data?.error || 'Failed to remove assignment');
        // Linked auto-fills may have been cleared before the failure — resync.
        await loadGrid();
        return;
      }
      // Patch the recreated open row + any cleared auto-fill siblings in place.
      if (data?.assignment) {
        applyAssignmentRows([data.assignment as AssignmentRow, ...((data.siblings ?? []) as AssignmentRow[])]);
      } else {
        await loadGrid();
      }
    } catch {
      setGrid({ ...grid, slots: prevSlots });
      setActionError('Failed to remove assignment');
    }
  };

  // ── Manual billing highlight (2026-07-28, patch42) ──────────────────────
  // Right-click → paint a cell blue/red/yellow, or clear it. Stored on the
  // assignment row, so it is visible to everyone who opens the schedule — the
  // point being that a physician reading the finalized schedule can see which
  // of their calls they can bill extra for.
  //
  // Optimistic paint, then patch the server's row over it. The server is the
  // authority on the value (route-validated against the three colours + null);
  // a rejected write reverts and surfaces through the standard action toast —
  // including the "patch42 not applied yet" 501, so a missing column reads as
  // a clear explanation rather than a colour that silently refuses to stick.
  // Cell comment (2026-08-02). Uses window.prompt deliberately: it is one
  // short string, it must work from a context menu already anchored at the
  // cursor, and a bespoke popover would be a second floating layer competing
  // with the palette for the same corner of the screen.
  const setCellComment = async (assignmentId: string, current: string | null) => {
    const next = window.prompt('Comment for this cell (blank to clear):', current ?? '');
    if (next === null) return;                    // cancelled — leave it alone
    setPaletteCell(null);
    try {
      const res = await fetch('/api/scheduling/schedule-assignments', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: assignmentId, notes: next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not save the comment');
      await loadGrid();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not save the comment');
    }
  };

  const setHighlight = async (assignmentId: string, color: HighlightColor | null) => {
    if (!grid) return;
    const prevSlots = grid.slots;
    setPaletteCell(null);
    setGrid(g => g ? {
      ...g,
      slots: g.slots.map(s => ({
        ...s,
        assignments: s.assignments.map(a =>
          a.id === assignmentId ? { ...a, highlight_color: color } : a),
      })),
    } : g);

    try {
      const res = await fetch('/api/scheduling/schedule-assignments', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: assignmentId, highlight_color: color }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setGrid(g => g ? { ...g, slots: prevSlots } : g);
        setActionError(data?.error || `Failed to set cell colour (${res.status})`);
        return;
      }
      if (data?.assignment) applyAssignmentRows([data.assignment as AssignmentRow]);
    } catch (e) {
      setGrid(g => g ? { ...g, slots: prevSlots } : g);
      setActionError(e instanceof Error ? e.message : 'Failed to set cell colour');
    }
  };

  // ── Call splits (2026-07-22): per-day split/unsplit actions ─────────────
  // Structure changes — no optimistic paint; the grid reloads so the parent
  // row shows the stacked segment mini-cells (or the restored whole call).
  // Server guards own correctness (open assignment, current version, not a
  // segment); a 4xx surfaces through the standard action-error toast.
  const splitSlot = async (slotId: string, mode: '2x12' | '3x8') => {
    setActiveCell(null);
    setPickerSearch('');
    try {
      const res = await fetch(`/api/scheduling/schedule-slots/${slotId}/split`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setActionError(data?.error || 'Failed to split call');
        return;
      }
      await loadGrid();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Failed to split call');
    }
  };

  const unsplitSlot = async (slotId: string) => {
    setActiveCell(null);
    setPickerSearch('');
    try {
      const res = await fetch(`/api/scheduling/schedule-slots/${slotId}/unsplit`, { method: 'POST' });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setActionError(data?.error || 'Failed to unsplit call');
        return;
      }
      await loadGrid();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Failed to unsplit call');
    }
  };

  const toggleLock = async (slotId: string, currentLocked: boolean) => {
    if (!grid) return;
    setGrid({
      ...grid,
      slots: grid.slots.map(s => s.id === slotId ? { ...s, locked: !currentLocked } : s),
    });
    setActiveCell(null);
    // TODO: PATCH slot lock status when API endpoint is available
  };

  const publishSchedule = async () => {
    if (!grid) return;
    try {
      const res = await fetch(`/api/scheduling/schedules/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'published' }),
      });
      if (!res.ok) throw new Error('Failed to publish');
      // Non-blocking post-publish revalidation (draft isolation): the schedule
      // is published either way — surface hard conflicts against OTHER published
      // schedules (invisible while both were drafts), or say if it couldn't run.
      const data = await res.json().catch(() => null);
      const pv = data?.publishValidation as
        | { hardCount?: number; softCount?: number; errors?: string[] }
        | undefined;
      setPublishResult(pv ?? null);
      await loadGrid();
    } catch {
      setActionError('Failed to publish schedule');
    }
  };
  const [publishResult, setPublishResult] = useState<{
    hardCount?: number; softCount?: number; errors?: string[];
  } | null>(null);

  const [generating, setGenerating] = useState(false);
  const [genResult, setGenResult] = useState<{
    filled: number; skipped: number; errors: string[];
    warnings: string[];                              // load-time advisories (apply patch18, quota shortfalls, …)
    // Per-slot open reasons (2026-07-24): lets the obligatory banner split the
    // paid-pickup layer ('obligation-cap' — by design) from hard clinical
    // blockers, instead of lumping both as one number.
    unfilled: Array<{ reason: string }>;
    skippedDerived: Array<{ reason: string }>;       // suppressed derived fills (clinical invariant 4)
    // Stale pre-fill seeds evicted by post-call chain fills (D1 overrides
    // pre-call, 2026-07-21) — the vacated slots stay open.
    evictions: Array<{ date: string; code: string; provider_name: string }>;
    // No-call request grant report — "N/M honored" + violated detail.
    requestGrants: Array<{
      provider_id: string; provider_name: string;
      requested_dates: string[]; granted: string[]; violated: string[];
    }>;
    // Call-request grant report (2026-07-22 mirror) — "N/M granted" + the
    // not-granted detail.
    callRequestGrants: Array<{
      provider_id: string; provider_name: string;
      requested_dates: string[]; granted: string[]; not_granted: string[];
    }>;
    // FTE working-days report — per call-taker, required vs credited days,
    // over/under highlighted.
    workDayReport: Array<{
      provider_id: string; provider_name: string;
      fte: number;
      // The WORKING-DAYS FTE `required` was computed from (patch43). Equal to
      // `fte` for everyone who states no work_days_fte; optional so a payload
      // from an older deploy still parses.
      workDaysFte?: number;
      workingDays: number; ptoDays: number; required: number;
      credited: { assignments: number; postCall: number; icu: number; total: number };
      entitledOff: number; delta: number;
      // Completeness check (work-to-required): present ONLY when credited <
      // required — idle working days classified engine gap (an open compatible
      // slot remained) vs staffing reality (no open compatible slot).
      shortfall?: { days: number; engineGapDates: string[]; noSlotDates: string[] };
    }>;
    // Which fill mode produced this result — drives the staged weekend
    // banner + Continue affordance below.
    fillMode: GenFillMode;
    /** Non-null ⇒ this was a one-provider-at-a-time run, for these ids. */
    targetedProviderIds: string[] | null;
    /** True ⇒ relief/mop-up/day-shift passes were skipped. */
    callsOnly: boolean;
    /** Snapshot taken immediately BEFORE this run; null ⇒ no undo available. */
    undoActionId: string | null;
    /** Which call slots this run attempted; null = the whole block. */
    dayScope: 'weekday' | 'weekend' | null;
    // Weekend-only runs only: call slots deliberately deferred to Continue
    // (NOT failures, NOT counted in `skipped`).
    awaitingContinue: { total: number; byDayType: Record<string, number> } | null;
    // Provider call caps (patch34): placed-vs-cap per stated (provider, code)
    // limit + slots deliberately left open at a stated max ('provider-cap').
    // null when the schedule states no call caps.
    providerCapSummary: {
      rows: Array<{ provider_id: string; provider_name: string; code: string; cap: number; placed: number }>;
      cappedUnfilled: number;
    } | null;
  } | null>(null);
  const [showPoolModal, setShowPoolModal] = useState(false);

  // Generation fill mode (2026-07-17; 'weekend-only' added 2026-07-21).
  // 'all' fills every fillable slot with the available pool (default,
  // pre-change behavior); 'obligatory' fills only obligatory call slots —
  // each provider gets at most their rounded total obligation and the rest
  // stay open; 'weekend-only' is the STAGED flow — only Sat/Sun/Fri call
  // slots (+ their pattern chains) fill now, and the result banner offers a
  // Continue button that runs a normal 'all' generation over the committed
  // weekend. Persisted per browser; hydrated after mount to avoid an SSR
  // mismatch (BoardClient precedent).
  const FILL_MODE_STORAGE_KEY = 'scheduling.generateFillMode';
  const [genFillMode, setGenFillMode] = useState<GenFillMode>('all');
  useEffect(() => {
    try {
      const stored = localStorage.getItem(FILL_MODE_STORAGE_KEY);
      if (stored === 'obligatory' || stored === 'weekend-only') setGenFillMode(stored);
    } catch { /* storage unavailable — keep default */ }
  }, []);
  const changeGenFillMode = (v: GenFillMode) => {
    setGenFillMode(v);
    try { localStorage.setItem(FILL_MODE_STORAGE_KEY, v); } catch { /* non-fatal */ }
  };

  // Grid zoom (Gabriel 2026-07-22): shrink the grid so more schedule fits on
  // one screen. Lazy initializer rather than the fill-mode useEffect pattern:
  // the toolbar/grid only render after the data fetch (post-hydration — the
  // `!grid` branch returns Loading), so reading localStorage before first
  // paint restores the level without a flash AND without an SSR mismatch
  // (the server-rendered Loading markup doesn't depend on this state).
  const [gridZoom, setGridZoom] = useState<GridZoomLevel>(() => loadGridZoom());
  const changeGridZoom = (level: GridZoomLevel) => {
    setGridZoom(level);
    saveGridZoom(level); // non-fatal on storage failure
  };

  const CONFIRM_BY_MODE: Record<GenFillMode, string> = {
    all: 'Auto-generate will fill all open slots using active rules. Manual assignments will NOT be overwritten. Continue?',
    obligatory: 'Auto-generate will fill ONLY obligatory call slots — each provider receives at most their rounded call obligation; remaining call slots stay open. Manual assignments will NOT be overwritten. Continue?',
    'weekend-only': 'Auto-generate will fill ONLY the weekend call schedule (Fri/Sat/Sun + their chained shifts). The rest of the schedule waits until you press Continue. Manual assignments will NOT be overwritten. Continue?',
  };

  // One generation runner for both entry points: the Auto-Generate button
  // (uses the selected mode, confirms first) and the staged Continue button
  // (always mode 'all' — the simplest correct choice: Continue finishes the
  // WHOLE schedule; the select stays available for anything more specific —
  // and no confirm: the banner it sits in already says exactly what it does).
  // `providerIds` = a TARGETED run (Gabriel 2026-08, one provider at a time,
  // most-constrained first). The route forces obligatory mode for those and
  // echoes back what it actually ran, so the banner reports the real mode
  // rather than the one this call asked for.
  const runGeneration = async (
    mode: GenFillMode, providerIds?: string[], callsOnly?: boolean,
  ) => {
    const scope = dayScope || undefined;
    setGenerating(true);
    setGenResult(null);
    try {
      const res = await fetch(`/api/scheduling/schedules/${id}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fillMode: mode,
          ...(providerIds?.length ? { providerIds } : {}),
          ...(callsOnly ? { callsOnly: true } : {}),
          ...(scope ? { dayScope: scope } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Generation failed');
      setGenResult({
        filled: data.filled, skipped: data.skipped, errors: data.errors,
        warnings: Array.isArray(data.warnings) ? data.warnings : [],
        unfilled: Array.isArray(data.unfilled) ? data.unfilled : [],
        skippedDerived: Array.isArray(data.skippedDerived) ? data.skippedDerived : [],
        evictions: Array.isArray(data.evictions) ? data.evictions : [],
        requestGrants: Array.isArray(data.requestGrants) ? data.requestGrants : [],
        callRequestGrants: Array.isArray(data.callRequestGrants) ? data.callRequestGrants : [],
        workDayReport: Array.isArray(data.workDayReport) ? data.workDayReport : [],
        // The ROUTE's mode, not the requested one — a targeted run is forced to
        // obligatory and the banner must not claim otherwise.
        fillMode: (data.fillMode as GenFillMode) ?? mode,
        targetedProviderIds: Array.isArray(data.targetedProviderIds) ? data.targetedProviderIds : null,
        callsOnly: data.callsOnly === true,
        dayScope: data.dayScope === 'weekday' || data.dayScope === 'weekend' ? data.dayScope : null,
        undoActionId: typeof data.undoActionId === 'string' ? data.undoActionId : null,
        awaitingContinue: data.awaitingContinue && typeof data.awaitingContinue.total === 'number'
          ? data.awaitingContinue : null,
        providerCapSummary: data.providerCapSummary && Array.isArray(data.providerCapSummary.rows)
          ? data.providerCapSummary : null,
      });
      await loadGrid();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Auto-generation failed');
    } finally {
      setGenerating(false);
    }
  };

  const autoGenerateSchedule = async () => {
    if (!grid) return;
    if (!confirm(CONFIRM_BY_MODE[genFillMode])) return;
    await runGeneration(genFillMode);
  };

  // ONE PROVIDER AT A TIME (Gabriel 2026-08). Reuses the focus selector's
  // choice, so the flow is: focus the most-constrained provider → look at their
  // constraints → generate just them → move to the next. Forced obligatory by
  // the route; their stated Block Targets, if any, replace that ceiling and are
  // filled even above their FTE share.
  const generateForFocused = async () => {
    if (!grid || generating || !focusPid) return;
    const who = grid.providers.find(p => p.id === focusPid)?.short_display_name ?? 'this provider';
    if (!confirm(
      `Auto-generate for ${who} ONLY.\n\n`
      + `They will be filled up to their Block Targets if you have entered any, otherwise to their `
      + `call obligation. Everything already on the schedule is respected and nothing else is `
      + `touched — other providers are not considered for any slot in this run.\n\n`
      + (targetedCallsOnly
        ? `CALLS ONLY: their call slots and the day slots chained to them. The relief day slots `
          + `(D4 and up) are left for one whole-pool run at the end — filling those one provider `
          + `at a time hands the first doc a contiguous block of the same code.\n\n`
        : `FULL RUN: relief day slots included. One provider at a time, they will be the only `
          + `candidate for every open relief slot, so expect contiguous blocks of the same D `
          + `code.\n\n`)
      + `Generate the most-constrained providers first: whoever runs earlier gets first pick of the `
      + `dates they can actually work.\n\nContinue?`)) return;
    await runGeneration('obligatory', [focusPid], targetedCallsOnly);
  };

  // Undo the generation the banner is reporting: restore the version's
  // assignments to the snapshot taken just before it ran. ASSIGNMENTS ONLY —
  // generation writes nothing else, so a wider restore could only roll back
  // edits (PTO, FTE, targets) the run never made.
  const [undoing, setUndoing] = useState(false);
  const undoGeneration = async () => {
    const actionId = genResult?.undoActionId;
    if (!actionId || undoing) return;
    if (!confirm(
      'Undo this generation?\n\nEvery call and day assignment goes back to exactly what it was '
      + 'immediately before the run — including anything you had entered by hand.\n\n'
      + 'Availability, FTEs and block targets are NOT touched.')) return;
    setUndoing(true);
    try {
      const res = await fetch(`/api/scheduling/assistant/actions/${actionId}/revert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'assignments' }),
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) {
        throw new Error((data.errors ?? []).join('; ') || data.error || 'Undo failed');
      }
      setGenResult(null);
      await loadGrid();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Undo failed');
    } finally {
      setUndoing(false);
    }
  };

  // `placements` comes from the modal so DELETED findings are already gone —
  // never dAudit.placements, which is the unfiltered set.
  const applyDRepair = async (placements: Array<{ slotId: string; providerId: string | null }>) => {
    if (!grid || applyingD || placements.length === 0) return;
    if (!confirm(
      `Apply ${placements.length} D cell change${placements.length === 1 ? '' : 's'}?\n\n`
      + 'Only D slots change — no call assignment is touched. This is undoable.')) return;
    setApplyingD(true);
    try {
      const res = await fetch(`/api/scheduling/schedules/${id}/repair-d`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ versionId: grid.version.id, placements }),
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) {
        throw new Error((data.errors ?? []).join('; ') || data.error || 'Repair failed');
      }
      setShowDAudit(false);
      await loadGrid();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'D repair failed');
    } finally {
      setApplyingD(false);
    }
  };

  const continueGeneration = async () => {
    if (!grid || generating) return;
    await runGeneration('all');
  };

  /* ── Provider list for picker ───────────────────────────────────────────── */

  const activeSlot = activeCell && grid ? grid.slots.find(s => s.id === activeCell.slotId) ?? null : null;
  const activeAssignment = activeCell?.assignmentId && activeSlot ? activeSlot.assignments.find(a => a.id === activeCell.assignmentId) ?? null : null;
  const isAssignedCell = !!activeAssignment?.provider_id;

  // Candidate eligibility (2026-07-28). Three memos, deliberately layered so
  // the list is INSTANT and never stale: the index rebuilds only when the grid
  // payload changes (including after every optimistic assign, so yesterday's
  // C1 starts blocking today the moment it lands), the groups recompute per
  // cell, and typing only re-filters. Nothing here refetches.
  const candidateIndex = useMemo(() => {
    if (!grid) return null;
    return buildCandidateIndex({
      providers: grid.providers,
      profiles: grid.profiles || [],
      availability: grid.availability || [],
      slots: grid.slots,
      // undefined (an older cached payload) is treated exactly like a failed
      // load: unchecked, and said out loud.
      credentials: grid.credentials ?? null,
      crossSite: grid.crossSite ?? null,
      callPattern: grid.callPattern ?? null,
    });
  }, [grid]);

  const slotCandidates = useMemo(() => {
    if (!candidateIndex || !activeSlot) return null;
    return candidatesForSlot(candidateIndex, activeSlot.id);
  }, [candidateIndex, activeSlot]);

  const pickerGroups = useMemo(
    () => (slotCandidates ? filterCandidateGroups(slotCandidates, pickerSearch) : null),
    [slotCandidates, pickerSearch],
  );

  // Every new cell starts with Unavailable collapsed.
  const activeCellSlotId = activeCell?.slotId ?? null;
  useEffect(() => { setShowBlockedCandidates(false); }, [activeCellSlotId]);

  // Hard-blocked people stay SELECTABLE behind a confirm naming the reason.
  // Silently making them unassignable would be a capability regression — the
  // scheduler could get stuck whenever the data is wrong (a PTO row that should
  // have been cancelled, a stale cross-site draft). The list stops him from
  // picking someone unavailable BY ACCIDENT; it never stops him on purpose.
  //
  // c.release, when present, rides along: assigning MUST vacate the day shift
  // or the provider is double-booked. Deliberately NO extra confirm for it —
  // the consequence is already spelled out in the row the user just clicked
  // ("Currently on D6 — will be moved to C1"), and this is the common action
  // the whole change exists to make easier. The override confirm above still
  // restates the move, because a confirm must never hide a second write.
  const pickCandidate = (c: SlotCandidate) => {
    if (!activeSlot) return;
    if (c.hard.length > 0 && !confirm(overrideConfirmMessage(c))) return;
    assignProvider(activeSlot.id, c.provider.id, c.release);
  };

  // Aggregate validation_flags across every assignment so the user can verify
  // at a glance whether their active rules are firing and whether anything is
  // currently violated. Each violation is one rule firing on one assignment;
  // the same rule can violate many times across the schedule.
  const rulesSummary = useMemo(() => {
    if (!grid) return { assignmentsChecked: 0, totalViolations: 0, hardCount: 0, softCount: 0, warningCount: 0, byRule: [] as { rule_id: string | null; rule_name: string; severity: ValidationFlag['severity']; count: number }[] };
    let assignmentsChecked = 0;
    let hardCount = 0;
    let softCount = 0;
    let warningCount = 0;
    const ruleAgg = new Map<string, { rule_id: string | null; rule_name: string; severity: ValidationFlag['severity']; count: number }>();
    for (const slot of grid.slots) {
      for (const a of slot.assignments) {
        if (!a.provider_id) continue;
        // Count any assignment whose validation_flags column has been written
        // (even an empty array means it was checked and passed).
        if (a.validation_flags === null || a.validation_flags === undefined) continue;
        assignmentsChecked++;
        // Prefer the server-computed summary; fall back to counting flags with
        // the same shared bucket rule. Either way, warnings (sentinel flags)
        // never inflate the soft count. (validationSummaryFor only returns
        // null for a non-array, and flags is guarded non-null above.)
        const s = a.validation_summary
          ?? validationSummaryFor(a.validation_flags)
          ?? { hard: 0, soft: 0, warning: 0 };
        hardCount += s.hard;
        softCount += s.soft;
        warningCount += s.warning;
        for (const f of a.validation_flags) {
          const key = (f.rule_id ?? f.rule_name) + '|' + f.severity;
          const ex = ruleAgg.get(key);
          if (ex) ex.count++;
          else ruleAgg.set(key, { rule_id: f.rule_id, rule_name: f.rule_name, severity: f.severity, count: 1 });
        }
      }
    }
    const byRule = [...ruleAgg.values()].sort((a, b) => (b.severity === 'hard' ? 1 : 0) - (a.severity === 'hard' ? 1 : 0) || b.count - a.count);
    // totalViolations = every stored flag (hard + soft + warning) — same
    // definition as the activity route's total_violations; the severity
    // breakdown is what distinguishes real violations from warnings.
    return { assignmentsChecked, totalViolations: hardCount + softCount + warningCount, hardCount, softCount, warningCount, byRule };
  }, [grid]);

  const [showRulesSummary, setShowRulesSummary] = useState(false);

  /* ── Render ─────────────────────────────────────────────────────────────── */

  if (error) {
    return <div style={{ padding: 40, color: '#f87171' }}>{error}</div>;
  }
  if (!grid) return <div style={{ padding: 40, color: 'var(--text-muted)' }}>Loading schedule...</div>;

  const { schedule, version } = grid;
  const colCount = visibleDates.length;

  return (
    <div className="schedule-builder-page" style={{ padding: '4px 8px', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <style>{`
        .schedule-builder-page button:focus-visible,
        .schedule-builder-page input:focus-visible {
          outline: 2px solid ${gridTokens.accent};
          outline-offset: 1px;
          border-radius: 6px;
        }
      `}</style>
      {/* Breadcrumb */}
      <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 4 }}>
        <Link href="/schedules" style={{ color: 'var(--blue)', textDecoration: 'none' }}>Schedules</Link>
        <span style={{ margin: '0 6px' }}>/</span>
        <span style={{ color: 'var(--text-muted)' }}>{schedule.schedule_name}</span>
      </div>

      {/* Top Bar — identity row (title carries the inline-rename pencil) */}
      <PageHeader
        compact
        title={renaming ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <input
              autoFocus
              value={renameValue}
              maxLength={SCHEDULE_NAME_MAX}
              onChange={e => setRenameValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') saveRename();
                if (e.key === 'Escape') setRenaming(false);
              }}
              aria-label="Schedule name"
              style={{
                fontSize: 14, fontWeight: 700, minWidth: 280,
                padding: '3px 8px', borderRadius: 6,
                border: '1px solid var(--border)', background: 'var(--bg-deep)',
                color: 'var(--text-strong)', outline: 'none',
              }}
            />
            <Button size="sm" onClick={saveRename} disabled={renameBusy || !renameValue.trim()}>
              {renameBusy ? 'Saving…' : 'Save'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setRenaming(false)} disabled={renameBusy}>
              Cancel
            </Button>
          </span>
        ) : (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
            {schedule.schedule_name}
            <button
              onClick={() => { setRenameValue(schedule.schedule_name); setRenaming(true); }}
              title="Rename this schedule"
              aria-label="Rename schedule"
              style={{
                background: 'none', border: 'none', cursor: 'pointer', padding: 2,
                color: 'var(--text-dim)', fontSize: 13, lineHeight: 1,
              }}
            >
              ✎
            </button>
          </span>
        )}
        subtitle={
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <Badge tone={scheduleStatusTone(schedule.status)}>{schedule.status}</Badge>
            <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
              v{version.version_number} ({version.version_status})
            </span>
            <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
              {formatDateRange(schedule.date_start, schedule.date_end)}
            </span>
          </div>
        }
        actions={
        /* Rules summary — verify the algorithm is enforcing your rules */
        <div style={{ position: 'relative' }}>
          <button
            onClick={() => setShowRulesSummary(v => !v)}
            title="Aggregate of validation_flags across every assignment in this schedule"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 7,
              padding: '5px 11px', borderRadius: 999, cursor: 'pointer',
              fontSize: 11.5, fontFamily: 'var(--font-mono), ui-monospace, monospace',
              background: rulesSummary.hardCount > 0
                ? 'rgba(239,68,68,0.10)'
                : rulesSummary.softCount + rulesSummary.warningCount > 0
                ? 'rgba(245,158,11,0.10)'
                : 'rgba(16,185,129,0.10)',
              color: rulesSummary.hardCount > 0
                ? '#dc2626'
                : rulesSummary.softCount + rulesSummary.warningCount > 0
                ? '#b45309'
                : '#0e7c52',
              border: '0.5px solid ' + (
                rulesSummary.hardCount > 0
                  ? 'rgba(239,68,68,0.35)'
                  : rulesSummary.softCount + rulesSummary.warningCount > 0
                  ? 'rgba(245,158,11,0.35)'
                  : 'rgba(16,185,129,0.35)'
              ),
            }}
          >
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: rulesSummary.hardCount > 0
                ? '#dc2626'
                : rulesSummary.softCount + rulesSummary.warningCount > 0
                ? '#b45309'
                : '#16a34a',
            }} />
            checked {rulesSummary.assignmentsChecked} ·{' '}
            {rulesSummary.hardCount + rulesSummary.softCount + rulesSummary.warningCount === 0
              ? 'all clean'
              : `${rulesSummary.hardCount}H · ${rulesSummary.softCount}S${rulesSummary.warningCount > 0 ? ` · ${rulesSummary.warningCount}W` : ''}`}
          </button>
          {showRulesSummary && (
            <div
              onMouseLeave={() => setShowRulesSummary(false)}
              style={{
                position: 'absolute', top: '100%', left: 0, marginTop: 6,
                background: 'var(--bg-surface)', border: '0.5px solid var(--border)',
                borderRadius: 6, padding: '8px 10px', minWidth: 280, maxWidth: 360,
                boxShadow: '0 8px 24px rgba(15,23,42,0.18)', zIndex: 100,
              }}
            >
              <div style={{ fontSize: 9, fontFamily: 'var(--font-mono), ui-monospace, monospace', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6, paddingBottom: 4, borderBottom: '0.5px solid var(--border)' }}>
                Rule activity
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
                <span>Assignments checked</span>
                <span style={{ fontFamily: 'var(--font-mono), ui-monospace, monospace', color: 'var(--text)' }}>{rulesSummary.assignmentsChecked}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
                <span>Hard violations</span>
                <span style={{ fontFamily: 'var(--font-mono), ui-monospace, monospace', color: rulesSummary.hardCount > 0 ? '#dc2626' : 'var(--text-dim)' }}>{rulesSummary.hardCount}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
                <span>Soft violations</span>
                <span style={{ fontFamily: 'var(--font-mono), ui-monospace, monospace', color: rulesSummary.softCount > 0 ? '#b45309' : 'var(--text-dim)' }}>{rulesSummary.softCount}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
                <span>Warnings (needs re-validation)</span>
                <span style={{ fontFamily: 'var(--font-mono), ui-monospace, monospace', color: rulesSummary.warningCount > 0 ? '#b45309' : 'var(--text-dim)' }}>{rulesSummary.warningCount}</span>
              </div>
              {rulesSummary.byRule.length > 0 ? (
                <>
                  <div style={{ fontSize: 9, fontFamily: 'var(--font-mono), ui-monospace, monospace', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 8, marginBottom: 4, paddingBottom: 4, borderBottom: '0.5px solid var(--border)' }}>
                    By rule
                  </div>
                  {rulesSummary.byRule.map((r) => (
                    <div key={(r.rule_id ?? r.rule_name) + r.severity} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', fontSize: 11 }}>
                      <span style={{ width: 5, height: 5, borderRadius: '50%', background: r.severity === 'hard' ? '#dc2626' : '#b45309', flexShrink: 0 }} />
                      <span style={{ flex: 1, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.rule_name}</span>
                      <span style={{ fontFamily: 'var(--font-mono), ui-monospace, monospace', color: 'var(--text-muted)', fontSize: 10 }}>×{r.count}</span>
                    </div>
                  ))}
                </>
              ) : rulesSummary.assignmentsChecked > 0 ? (
                <div style={{ fontSize: 11, color: '#0e7c52', textAlign: 'center', padding: '6px 0', fontStyle: 'italic' }}>
                  All checked assignments pass every active rule.
                </div>
              ) : (
                <div style={{ fontSize: 11, color: 'var(--text-dim)', textAlign: 'center', padding: '6px 0', fontStyle: 'italic' }}>
                  No assignments have been validated yet — run auto-generate to populate.
                </div>
              )}
            </div>
          )}
        </div>
        }
      />

      {/* Top Bar — toolbar row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 4, paddingTop: 4, borderTop: '1px solid var(--border)' }}>

        {/* View toggle */}
        <div style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
          {(['week', 'month', 'calendar'] as const).map(m => (
            <button
              key={m}
              onClick={() => {
                setViewMode(m);
                setWeekOffset(0);
                setCalendarMonthOffset(0);
              }}
              style={{
                padding: '6px 14px', fontSize: 12, fontWeight: 600, border: 'none', cursor: 'pointer',
                background: viewMode === m ? 'rgba(56,189,248,0.18)' : 'transparent',
                color: viewMode === m ? '#7dd3fc' : 'var(--text-muted)',
              }}
            >
              {m === 'week' ? 'Week' : m === 'month' ? 'Month' : 'Calendar'}
            </button>
          ))}
        </div>

        {/* Week navigation */}
        {viewMode === 'week' && (
          <div style={{ display: 'flex', gap: 4 }}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setWeekOffset(o => Math.max(0, o - 1))}
              style={{ width: 30, height: 30, padding: 0, fontSize: 14 }}
            >
              &#8592;
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                const maxWeeks = Math.ceil(allDates.length / 7);
                setWeekOffset(o => Math.min(maxWeeks - 1, o + 1));
              }}
              style={{ width: 30, height: 30, padding: 0, fontSize: 14 }}
            >
              &#8594;
            </Button>
          </div>
        )}

        {/* Grid zoom — view more schedule per screen (Gabriel 2026-07-22).
            Segmented control in the view-toggle idiom; percentages are the
            labels so the current level doubles as the readout. Applies CSS
            zoom to the week/month grid container only, so the control hides
            in calendar view (week-nav precedent). Persisted per browser
            (floorRunner.gridZoom); print always renders at 100%. */}
        {viewMode !== 'calendar' && (
          <div
            role="group"
            aria-label="Grid zoom"
            title="Grid zoom — smaller percentages fit more of the schedule on screen"
            style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}
          >
            {GRID_ZOOM_LEVELS.map(level => (
              <button
                key={level}
                onClick={() => changeGridZoom(level)}
                aria-pressed={gridZoom === level}
                style={{
                  padding: '6px 9px', fontSize: 11, fontWeight: 700, border: 'none', cursor: 'pointer',
                  fontFamily: 'var(--font-mono), ui-monospace, monospace',
                  background: gridZoom === level ? 'rgba(56,189,248,0.18)' : 'transparent',
                  color: gridZoom === level ? '#7dd3fc' : 'var(--text-muted)',
                }}
              >
                {level}%
              </button>
            ))}
          </div>
        )}

        <div style={{ flex: 1 }} />

        {/* Call Counts button */}
        <Button variant="secondary" onClick={() => setShowCounts(true)}>
          Call Counts
        </Button>

        {/* Available Call — the unfilled-call worklist, next to Call Counts so
            it sits with the other analysis views. The count rides on the
            button because it is the number he checks constantly ("which calls
            i need to list up for grabs"), and the button goes red the moment
            the block has any; a fully covered block leaves it plain and
            unnumbered, so "no badge" always means "nothing to post". */}
        <Button
          variant="secondary"
          onClick={() => setShowAvailableCalls(true)}
          title={availableCalls.total > 0
            ? `${availableCalls.total} unfilled call slot${availableCalls.total === 1 ? '' : 's'} to list up for grabs`
            : 'Every call slot in this block is filled'}
          // Same tinted-Button idiom the Pool / Assistant buttons use, keyed to
          // the grid's own open red rather than a --var: the design system has
          // --blue and --indigo but no red token, and this button has to match
          // the cells it is about.
          style={availableCalls.total > 0 ? {
            background: `color-mix(in srgb, ${gridTokens.openCall} 15%, transparent)`,
            color: gridTokens.openCall,
            border: `1px solid color-mix(in srgb, ${gridTokens.openCall} 45%, transparent)`,
          } : undefined}
        >
          Available Call{availableCalls.total > 0 ? ` (${availableCalls.total})` : ''}
        </Button>

        {/* Call spacing review — sits with the other analysis views. */}
        <Button
          variant="secondary"
          onClick={() => setShowSpacing(true)}
          title="Find providers whose first-call assignments sit too close together, and who could take one instead"
        >
          Spacing{spacingTightCount > 0 ? ` (${spacingTightCount})` : ''}
        </Button>

        {/* Re-check D assignments after call switches. */}
        <Button
          variant="secondary"
          onClick={() => setShowDAudit(true)}
          title="Re-derive every D1–D8 placement from the calls around it, and re-order D4+ by nearest call"
          style={dAudit.findings.length > 0 ? {
            background: `color-mix(in srgb, ${gridTokens.openCall} 15%, transparent)`,
            color: gridTokens.openCall,
            border: `1px solid color-mix(in srgb, ${gridTokens.openCall} 45%, transparent)`,
          } : undefined}
        >
          Check D{dAudit.findings.length > 0 ? ` (${dAudit.findings.length})` : ''}
        </Button>

        <Button
          variant="secondary"
          onClick={() => setPrintingSchedule(true)}
          title="Print the whole block — one week per landscape page. Save as PDF to send."
        >
          Print
        </Button>

        {/* Focus a provider — rings their cells and fades the rest, so one
            person's call days read straight off an 11-week grid. Lists only
            providers who actually hold something in this block, newest state
            wins; picking the blank option clears it. Tinted violet when on so
            the control matches the ring it produces and it is obvious the grid
            is filtered rather than broken. */}
        <select
          value={focusPid ?? ''}
          onChange={e => setFocusPid(e.target.value || null)}
          title={focusPid
            ? 'Showing one provider — pick “Focus provider…” to clear'
            : 'Highlight one provider’s days across the whole block'}
          style={{
            height: 30, borderRadius: 6, padding: '0 8px', fontSize: 13, fontWeight: 600,
            cursor: 'pointer', maxWidth: 190,
            background: focusPid
              ? 'color-mix(in srgb, rgb(124,58,237) 15%, transparent)' : 'var(--surface)',
            color: focusPid ? 'rgb(124,58,237)' : 'var(--text)',
            border: `1px solid ${focusPid
              ? 'color-mix(in srgb, rgb(124,58,237) 45%, transparent)' : 'var(--border)'}`,
          }}
        >
          <option value="">Focus provider…</option>
          {focusableProviders.map(p => (
            <option key={p.id} value={p.id}>
              {p.short_display_name}{p.holdsWork ? '' : ' — none yet'}
            </option>
          ))}
        </select>

        <Button
          variant="secondary"
          onClick={() => setShowAssistant(v => !v)}
          style={showAssistant ? {
            background: 'color-mix(in srgb, var(--indigo) 16%, transparent)',
            color: 'var(--indigo)',
            border: '1px solid color-mix(in srgb, var(--indigo) 40%, transparent)',
          } : undefined}
        >Assistant ✨</Button>

        {/* Pool selector + Auto-Generate.
            A custom pool NARROWS the default rule-based pool (Gabriel
            2026-07-21: it intersects each engine's role criterion — call
            takers for call gen, Day Docs/sell-back for day gen — skipping
            only the home-site gate). When none is set, we show "Select Pool"
            as a cue that auto-gen will use the home-site call-takers. */}
        {schedule.status === 'draft' && (
          <>
            <Button
              variant="secondary"
              onClick={() => setShowPoolModal(true)}
              title="Override the default auto-gen candidate pool"
              style={(schedule.included_provider_ids && schedule.included_provider_ids.length > 0)
                ? {
                    background: 'color-mix(in srgb, var(--blue) 15%, transparent)',
                    color: 'var(--blue)',
                    border: '1px solid color-mix(in srgb, var(--blue) 40%, transparent)',
                  }
                : {
                    background: 'color-mix(in srgb, var(--indigo) 14%, transparent)',
                    color: 'var(--indigo)',
                    border: '1px solid color-mix(in srgb, var(--indigo) 35%, transparent)',
                  }}
            >
              {(schedule.included_provider_ids && schedule.included_provider_ids.length > 0)
                ? `Custom Pool (${schedule.included_provider_ids.length})`
                : 'Select Pool'}
            </Button>
            {/* Fill-mode select + Auto-Generate: a three-option control.
                'Fill all slots' = pre-change behavior; 'Obligatory only'
                caps each provider at their rounded call obligation and
                leaves the remaining call slots open; 'Weekend call only'
                stages the fill — weekend call (+ chains) now, then the
                banner's Continue button finishes the rest with 'all'.
                Persisted in localStorage (scheduling.generateFillMode). */}
            <select
              value={genFillMode}
              onChange={e => changeGenFillMode(
                e.target.value === 'obligatory' || e.target.value === 'weekend-only'
                  ? e.target.value : 'all')}
              disabled={generating}
              aria-label="Auto-generate fill mode"
              title={genFillMode === 'obligatory'
                ? 'Fill only obligatory call slots — each provider receives at most their rounded call obligation at the site par (par-authoritative); the rest stay open as the paid-pickup layer.'
                : genFillMode === 'weekend-only'
                  ? 'Fill only the weekend call schedule (Fri/Sat/Sun + chained shifts) now; press Continue in the result banner to fill the rest.'
                  : 'Fill all open slots with the available pool (default).'}
              style={{
                padding: '7px 10px', fontSize: 12.5, fontWeight: 600, borderRadius: 8,
                background: 'var(--bg)', color: 'var(--text-muted)',
                border: '1px solid var(--border)', cursor: generating ? 'not-allowed' : 'pointer',
              }}
            >
              <option value="all">Fill all slots</option>
              <option value="obligatory">Obligatory only</option>
              <option value="weekend-only">Weekend call only</option>
            </select>
            {/* Day scope — SEPARATE from the fill mode because scope and cap are
                orthogonal: "Obligatory only" + "Weekday calls" is the useful
                combination after entering the weekend schedule by hand, and a
                fourth fill-mode value could not have expressed it. Inert at
                "Whole block", which is the pre-existing behaviour. */}
            <select
              value={dayScope}
              onChange={e => setDayScope(
                e.target.value === 'weekday' || e.target.value === 'weekend' ? e.target.value : '')}
              disabled={generating || genFillMode === 'weekend-only'}
              aria-label="Which call slots to attempt"
              title={genFillMode === 'weekend-only'
                ? 'Weekend call only already scopes the run.'
                : dayScope === 'weekday'
                  ? 'Attempt only M–Th call slots (holidays included). Fri/Sat/Sun are left untouched for a later run.'
                  : dayScope === 'weekend'
                    ? 'Attempt only Fri/Sat/Sun call slots. Weekdays are left for a later run.'
                    : 'Attempt every call slot in the block (default).'}
              style={{
                padding: '7px 10px', fontSize: 12.5, fontWeight: 600, borderRadius: 8,
                background: 'var(--bg)', color: 'var(--text-muted)',
                border: '1px solid var(--border)',
                cursor: generating || genFillMode === 'weekend-only' ? 'not-allowed' : 'pointer',
                opacity: genFillMode === 'weekend-only' ? 0.5 : 1,
              }}
            >
              <option value="">Whole block</option>
              <option value="weekday">Weekday calls (M–Th)</option>
              <option value="weekend">Weekend calls (Fri–Sun)</option>
            </select>
            <Button
              variant="secondary"
              onClick={autoGenerateSchedule}
              disabled={generating}
              style={{
                background: 'var(--ok-bg)',
                color: 'var(--ok)',
                border: '1px solid color-mix(in srgb, var(--ok) 40%, transparent)',
              }}
            >
              {generating ? 'Generating...' : 'Auto-Generate'}
            </Button>
            {/* One-provider-at-a-time. Deliberately bound to the FOCUS
                selector rather than owning a second provider dropdown: the
                workflow is "look at this person, then generate this person",
                and two independent pickers would let the grid highlight one
                provider while the button generated another. Hidden until a
                provider is focused, so it can never fire with no target. */}
            {focusPid && (
              <Button
                variant="secondary"
                onClick={generateForFocused}
                disabled={generating}
                title={`Fill only ${grid.providers.find(p => p.id === focusPid)?.short_display_name ?? 'this provider'}`}
                style={{
                  background: 'color-mix(in srgb, rgb(124,58,237) 15%, transparent)',
                  color: 'rgb(124,58,237)',
                  border: '1px solid color-mix(in srgb, rgb(124,58,237) 45%, transparent)',
                }}
              >
                {generating
                  ? 'Generating...'
                  : `Generate ${grid.providers.find(p => p.id === focusPid)?.short_display_name ?? ''} only`}
              </Button>
            )}
            {focusPid && (
              <label
                title={'Calls and the day slots chained to them (a C2\u2019s next-day D1, a weekend '
                  + 'anchor\u2019s Friday D4). Leaves the relief day slots (D4 and up) for one '
                  + 'whole-pool run at the end \u2014 filling those per provider gives the first '
                  + 'doc a contiguous block of the same code.'}
                style={{
                  display: 'flex', alignItems: 'center', gap: 5, fontSize: 12,
                  fontWeight: 600, color: 'var(--text-muted)', cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                <input
                  type="checkbox"
                  checked={targetedCallsOnly}
                  disabled={generating}
                  onChange={e => setTargetedCallsOnly(e.target.checked)}
                  style={{ cursor: 'pointer' }}
                />
                calls only
              </label>
            )}
          </>
        )}

        {/* Publish button */}
        {schedule.status === 'draft' && (
          <Button onClick={publishSchedule}>
            Publish
          </Button>
        )}
      </div>

      {/* Generation result toast */}
      {genResult && (
        <div style={{ marginBottom: 8 }}>
          <Banner
            tone={genResult.errors.length > 0 ? 'error' : 'success'}
            onDismiss={() => setGenResult(null)}
          >
            {/* Targeted run: name who it was for and that the mode was forced.
                Sits ABOVE the ordinary summary so "only 3 placed" is never read
                as a failure of a whole-pool generation. */}
            {genResult.targetedProviderIds && genResult.targetedProviderIds.length > 0 && (
              <div style={{ fontWeight: 700, marginBottom: 4 }}>
                One-provider run —{' '}
                {genResult.targetedProviderIds
                  .map(pid => grid?.providers.find(p => p.id === pid)?.short_display_name ?? pid)
                  .join(', ')}
                {' '}only. Obligatory mode (forced): filled to their Block Targets where stated,
                otherwise to their call obligation. No other provider was considered.
                {genResult.callsOnly
                  ? ' Calls only — relief day slots (D4 and up) were left for a whole-pool run.'
                  : ''}
              </div>
            )}
            {genResult.fillMode === 'weekend-only' ? (
              // Staged weekend fill: the deferred (awaiting-Continue) count is
              // NOT a failure and is kept visually separate from real unfilled
              // weekend slots. The Continue button finishes the schedule with
              // an ordinary 'all' generation over the committed weekend.
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <span>
                  Weekend fill complete: {genResult.filled} placed
                  {genResult.awaitingContinue
                    ? ` · ${genResult.awaitingContinue.total} slot${genResult.awaitingContinue.total !== 1 ? 's' : ''} awaiting Continue`
                      + (genResult.awaitingContinue.total > 0
                        ? ` (${Object.entries(genResult.awaitingContinue.byDayType)
                            .map(([dt, n]) => `${n} ${dt.replace(/_/g, ' ')}`).join(', ')})`
                        : '')
                    : ''}.
                  {genResult.skipped > 0 && ` ${genResult.skipped} weekend slot${genResult.skipped !== 1 ? 's' : ''} could not be filled.`}
                  {genResult.errors.length > 0 && ` ${genResult.errors.length} error(s).`}
                </span>
                <Button
                  onClick={continueGeneration}
                  disabled={generating}
                  title="Run a normal full generation over the rest of the schedule. The weekend placements just made are kept as-is."
                >
                  {generating ? 'Generating...' : 'Continue — fill remaining slots'}
                </Button>
              </div>
            ) : (
              <span>
                Filled {genResult.filled} slot{genResult.filled !== 1 ? 's' : ''}.
                {/* Obligatory mode's leftovers are ordinary open call slots by
                    design (par-authoritative 2026-07-24): 'obligation-cap'
                    ones are the paid-pickup layer, taken after the schedule
                    is made — NOT failures — and are reported separately from
                    hard clinical blockers (PTO/cross-site/no-eligible). */}
                {genResult.skipped > 0 && (genResult.fillMode === 'obligatory'
                  ? (() => {
                      const cap = genResult.unfilled.filter(u => u.reason === 'obligation-cap').length;
                      const hard = genResult.skipped - cap;
                      return ` ${cap} left open as the paid-pickup layer (obligation caps — by design)`
                        + (hard > 0 ? `; ${hard} unfillable by hard blockers — see the unfilled report.` : '.');
                    })()
                  : ` ${genResult.skipped} could not be filled.`)}
                {genResult.errors.length > 0 && ` ${genResult.errors.length} error(s).`}
              </span>
            )}
            {genResult.warnings.length > 0 && (
              // Full list, never truncated (2026-07-16): the quota-coverage
              // warnings are the fastest structural signal — the ABSENCE of a
              // friday|C1/C2 line was the tell that Friday slots were never
              // materialized, and a "… and N more" ellipsis hid exactly that.
              <div style={{ marginTop: 4, color: 'var(--text-dim)', maxHeight: 160, overflowY: 'auto' }}>
                <div>{genResult.warnings.length} warning{genResult.warnings.length !== 1 ? 's' : ''}:</div>
                <ul style={{ margin: '2px 0 0 0', paddingLeft: 18 }}>
                  {genResult.warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              </div>
            )}
            {genResult.skippedDerived.length > 0 && (
              <div style={{ marginTop: 4, color: 'var(--text-dim)' }}>
                {genResult.skippedDerived.length} derived shift{genResult.skippedDerived.length !== 1 ? 's' : ''} skipped (
                {Object.entries(genResult.skippedDerived.reduce<Record<string, number>>((m, s) => {
                  m[s.reason] = (m[s.reason] || 0) + 1;
                  return m;
                }, {})).map(([reason, n]) => `${n} ${reason}`).join(', ')}
                ) — left unassigned, see unfilled/derived report.
              </div>
            )}
            {/* Seed evictions (2026-07-21): a regenerate's post-call chain
                displaced stale auto-generated pre-fills (D1 overrides
                pre-call). The vacated slots stay OPEN — this line is their
                report; they are never backfilled with someone else. */}
            {genResult.evictions.length > 0 && (
              <div style={{ marginTop: 4, color: 'var(--text-dim)' }}>
                {genResult.evictions.length} stale pre-call fill{genResult.evictions.length !== 1 ? 's' : ''} evicted
                (post-call coverage overrides pre-call): {genResult.evictions
                  .map(e => `${e.code} ${e.date} (${e.provider_name})`).join(', ')} — vacated slot{genResult.evictions.length !== 1 ? 's' : ''} left open.
              </div>
            )}
            {/* No-call request grant report: soft avoidance is best-effort, so
                the scheduler is told exactly which requests the engine could
                not honor (a violated date also carries the soft validation
                flag on its assignment). Hidden when nobody requested. */}
            {genResult.requestGrants.length > 0 && (
              <div style={{ marginTop: 4, color: 'var(--text-dim)' }}>
                <div>
                  {genResult.requestGrants.reduce((n, g) => n + g.granted.length, 0)}
                  /{genResult.requestGrants.reduce((n, g) => n + g.requested_dates.length, 0)}{' '}
                  no-call request{genResult.requestGrants.reduce((n, g) => n + g.requested_dates.length, 0) !== 1 ? 's' : ''} honored.
                </div>
                {genResult.requestGrants.some(g => g.violated.length > 0) && (
                  <ul style={{ margin: '2px 0 0 0', paddingLeft: 18 }}>
                    {genResult.requestGrants.filter(g => g.violated.length > 0).map(g => (
                      <li key={g.provider_id}>
                        {g.provider_name}: call landed on {g.violated.join(', ')} (requested no call)
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {/* Call-request grant report (mirror of the no-call report): soft
                preference is best-effort, so the scheduler is told exactly
                which requested call dates could not be granted. Hidden when
                nobody requested. */}
            {genResult.callRequestGrants.length > 0 && (
              <div style={{ marginTop: 4, color: 'var(--text-dim)' }}>
                <div>
                  {genResult.callRequestGrants.reduce((n, g) => n + g.granted.length, 0)}
                  /{genResult.callRequestGrants.reduce((n, g) => n + g.requested_dates.length, 0)}{' '}
                  call request{genResult.callRequestGrants.reduce((n, g) => n + g.requested_dates.length, 0) !== 1 ? 's' : ''} granted.
                </div>
                {genResult.callRequestGrants.some(g => g.not_granted.length > 0) && (
                  <ul style={{ margin: '2px 0 0 0', paddingLeft: 18 }}>
                    {genResult.callRequestGrants.filter(g => g.not_granted.length > 0).map(g => (
                      <li key={g.provider_id}>
                        {g.provider_name}: no call landed on {g.not_granted.join(', ')} (requested call)
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {/* FTE working-days report: per call-taker, credited days vs the
                round(work-days FTE × workingDays) − PTO obligation. Over/under flagged so
                the scheduler can rebalance. Hidden when the engine produced no
                budget (e.g. pre-holiday-data blocks). */}
            {genResult.workDayReport.length > 0 && (() => {
              const over = genResult.workDayReport.filter(r => r.delta > 0);
              const under = genResult.workDayReport.filter(r => r.delta < 0);
              return (
                <div style={{ marginTop: 4, color: 'var(--text-dim)' }}>
                  <div>
                    Working days: {genResult.workDayReport.length} provider{genResult.workDayReport.length !== 1 ? 's' : ''} —{' '}
                    <span style={{ color: over.length ? 'var(--danger, #c0392b)' : 'inherit' }}>{over.length} over</span>,{' '}
                    <span style={{ color: under.length ? 'var(--warn, #b8860b)' : 'inherit' }}>{under.length} under</span>{' '}
                    required.
                  </div>
                  {(over.length > 0 || under.length > 0) && (
                    <ul style={{ margin: '2px 0 0 0', paddingLeft: 18 }}>
                      {[...over, ...under]
                        .sort((a, b) => b.delta - a.delta)
                        .map(r => (
                          <li key={r.provider_id}>
                            {/* Show BOTH FTEs when they differ (patch43) —
                                otherwise "FTE 0.66 … 54 required" reads as a
                                bug rather than as the split it is. */}
                            {r.provider_name} (FTE {r.fte}
                            {r.workDaysFte != null && r.workDaysFte !== r.fte
                              ? `, work-days FTE ${r.workDaysFte}` : ''}
                            ): worked {r.credited.total} of {r.required} required{' '}
                            ({r.credited.assignments} assigned + {r.credited.postCall} post-call + {r.credited.icu} ICU),{' '}
                            entitled off {r.entitledOff} —{' '}
                            <b style={{ color: r.delta > 0 ? 'var(--danger, #c0392b)' : 'var(--warn, #b8860b)' }}>
                              {r.delta > 0 ? `over ${r.delta}` : `under ${-r.delta}`}
                            </b>
                            {/* Completeness (work-to-required): idle days classified,
                                never silent, never conflated — engine gap (an open
                                compatible slot remained) vs staffing reality. */}
                            {r.shortfall && (
                              <span>
                                {r.shortfall.engineGapDates.length > 0 && (
                                  <>
                                    {' '}· <b style={{ color: 'var(--danger, #c0392b)' }}>under-scheduled: engine gap</b>{' '}
                                    on {r.shortfall.engineGapDates.join(', ')}
                                  </>
                                )}
                                {r.shortfall.noSlotDates.length > 0 && (
                                  <>
                                    {' '}· no open compatible slots — staffing reality
                                    on {r.shortfall.noSlotDates.join(', ')}
                                  </>
                                )}
                              </span>
                            )}
                          </li>
                        ))}
                    </ul>
                  )}
                </div>
              );
            })()}
            {/* Provider call caps (patch34): placed-vs-cap per stated limit.
                Slots deliberately left open at a stated max are called out —
                they are the caps working, not a failure. */}
            {genResult.providerCapSummary && genResult.providerCapSummary.rows.length > 0 && (
              <div style={{ marginTop: 4, color: 'var(--text-dim)' }}>
                <div>
                  Provider call limits:{' '}
                  {genResult.providerCapSummary.rows.map((r, i) => (
                    <span key={`${r.provider_id}|${r.code}`}>
                      {i > 0 && ', '}
                      {r.provider_name} {r.code}{' '}
                      <b style={{ color: r.placed >= r.cap ? 'var(--warn, #b8860b)' : 'inherit' }}>
                        {r.placed}/{r.cap}
                      </b>
                    </span>
                  ))}
                </div>
                {genResult.providerCapSummary.cappedUnfilled > 0 && (
                  <div>
                    {genResult.providerCapSummary.cappedUnfilled} slot{genResult.providerCapSummary.cappedUnfilled !== 1 ? 's' : ''} left
                    open at a stated maximum (reason: provider-cap) — fill manually or raise the limit.
                  </div>
                )}
              </div>
            )}
            {genResult.dayScope && (
              <div style={{ marginTop: 6, fontSize: 12.5 }}>
                Scope: {genResult.dayScope === 'weekday'
                  ? 'weekday calls (M–Th, holidays included)'
                  : 'weekend calls (Fri–Sun)'} only
                {genResult.awaitingContinue && genResult.awaitingContinue.total > 0
                  ? ` — ${genResult.awaitingContinue.total} out-of-scope call slot${
                      genResult.awaitingContinue.total === 1 ? '' : 's'} left untouched for a later run.`
                  : '.'}
              </div>
            )}
            {/* Undo sits LAST — under the report it acts on. Absent (not
                disabled) when no snapshot was taken, so the button can never
                be present and do nothing. */}
            {genResult.undoActionId ? (
              <div style={{ marginTop: 10 }}>
                <Button
                  variant="secondary"
                  onClick={undoGeneration}
                  disabled={undoing}
                  title={'Put every assignment back exactly as it was immediately before this '
                    + 'generation, including anything entered by hand. Availability, FTEs and '
                    + 'block targets are not touched.'}
                >
                  {undoing ? 'Undoing…' : '↶ Undo this generation'}
                </Button>
              </div>
            ) : (
              <div style={{ marginTop: 8, fontSize: 12, opacity: 0.8 }}>
                Undo unavailable for this run — the pre-generation snapshot could not be taken.
              </div>
            )}
          </Banner>
        </div>
      )}

      {/* Publish revalidation result — only surfaces when there is something to
          flag: hard conflicts against other published schedules, or that
          validation could not run (never fake-clean, invariant 6). */}
      {publishResult && ((publishResult.hardCount ?? 0) > 0 || (publishResult.errors?.length ?? 0) > 0) && (
        <div style={{ marginBottom: 8 }}>
          <Banner tone="warn" onDismiss={() => setPublishResult(null)}>
            {(publishResult.errors?.length ?? 0) > 0 ? (
              <span>
                Published, but conflict validation could not run — the grid may hold
                unflagged conflicts. ({publishResult.errors!.slice(0, 2).join(' · ')})
              </span>
            ) : (
              <span>
                Published with {publishResult.hardCount} hard conflict{publishResult.hardCount !== 1 ? 's' : ''} against
                other published schedules — check the grid.
              </span>
            )}
          </Banner>
        </div>
      )}

      {/* Action error toast (3s) + the STICKY day-shift-release failure, one
          stacked container so they can never overlap. swapFailure sits on top
          and only leaves when dismissed — see the swapFailure state comment. */}
      {(actionError || swapFailure) && (
        <div style={{
          position: 'fixed', top: 20, right: 20, zIndex: 600, maxWidth: 460,
          display: 'flex', flexDirection: 'column', gap: 8,
        }}>
          {swapFailure && (
            <Banner tone="error" onDismiss={() => setSwapFailure(null)}>{swapFailure}</Banner>
          )}
          {actionError && <Banner tone="error">{actionError}</Banner>}
        </div>
      )}

      {/* Grid Container — dark chrome (headers + shift labels), white data cells */}
      {viewMode !== 'calendar' && (
      <div style={{
        flex: 1, overflow: 'auto', borderRadius: 8,
        border: '1px solid var(--border)',
        background: '#ffffff', // data cell background
      }}>
        {/* Print always renders at 100% regardless of the on-screen zoom
            level. Stylesheet !important beats the inline zoom below. (The
            Call Counts print path is additionally isolated by its own
            visibility-scoped stylesheet, so it never sees the grid.) */}
        <style>{`@media print { .fr-grid-zoom { zoom: 1 !important; } }`}</style>
        {/* CSS zoom on the grid itself (inner div, not the scroll container):
            scrollbar/border chrome stays at 100% while every cell, font, and
            sticky offset scales by the same factor — the top:22 date header
            stays glued below the (minHeight 22, now scaled) DOW row, and the
            sticky left shift-label column keeps left:0. The picker popover is
            position:fixed OUTSIDE this subtree and placed from e.clientX/Y
            (viewport px), so click-to-assign is zoom-independent. */}
        <div className="fr-grid-zoom" style={{
          zoom: gridZoom / 100,
          display: 'grid',
          gridTemplateColumns: `84px repeat(${colCount}, minmax(${viewMode === 'month' ? 82 : 74}px, 1fr))`,
          minWidth: colCount > 7 ? `${84 + colCount * (viewMode === 'month' ? 82 : 74)}px` : undefined,
        }}>

          {/* ── Row 0: Day-of-week header ─────────────────────────────────── */}

          {/* Corner cell */}
          <div style={{
            position: 'sticky', top: 0, left: 0, zIndex: 4,
            background: gridTokens.chrome, borderBottom: '1px solid #1e3a5f',
            borderRight: '1px solid #1e3a5f', padding: '6px 12px',
            minHeight: 22,
          }} />

          {/* Day-of-week labels */}
          {visibleDates.map((date, i) => {
            const dow = getDayOfWeek(date);
            const isWeekend = dow === 0 || dow === 6;
            const isHoliday = !!holidayMap[date];
            const isToday = date === todayStr;
            const isSatBorder = dow === 6 && i > 0;
            return (
              <div key={`dow-${date}`} style={{
                position: 'sticky', top: 0, zIndex: 3,
                // Holidays get a distinctly yellow-tinted dark header so
                // the whole column reads as "holiday" at a glance.
                background: isHoliday ? '#3a3010' : isWeekend ? gridTokens.chromeWeekend : gridTokens.chrome,
                borderBottom: '1px solid #1e3a5f',
                borderRight: '1px solid #1e3a5f',
                borderLeft: isToday ? '2px solid ' + gridTokens.accent : isSatBorder ? '2px solid rgba(30,58,95,0.6)' : 'none',
                padding: '2px 6px', textAlign: 'center',
                fontSize: 10, fontWeight: 700,
                color: isHoliday ? '#fbbf24' : isWeekend ? '#cbd5e1' : gridTokens.chromeMuted,
                textTransform: 'uppercase', letterSpacing: '0.05em',
                minHeight: 22, display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                {DAYS_SHORT[dow]}
              </div>
            );
          })}

          {/* ── Row 1: Date header ────────────────────────────────────────── */}

          {/* Corner cell "Shifts" */}
          <div style={{
            position: 'sticky', top: 22, left: 0, zIndex: 4,
            background: gridTokens.chrome, borderBottom: '2px solid #1e3a5f',
            borderRight: '1px solid #1e3a5f', padding: '2px 10px',
            fontSize: 11, fontWeight: 700, color: gridTokens.chromeMuted,
          }}>
            Shifts
          </div>

          {/* Date labels */}
          {visibleDates.map((date, i) => {
            const dow = getDayOfWeek(date);
            const isWeekend = dow === 0 || dow === 6;
            const holiday = holidayMap[date];
            const isToday = date === todayStr;
            const isSatBorder = dow === 6 && i > 0;
            const mdCount = mdCountByDate[date] ?? 0;
            const crnaCount = crnaCountByDate[date] ?? 0;
            return (
              <div key={`date-${date}`} title={holiday ? holiday.holiday_name : undefined} style={{
                position: 'sticky', top: 22, zIndex: 3,
                background: holiday ? '#3a3010' : isWeekend ? gridTokens.chromeWeekend : gridTokens.chrome,
                borderBottom: '2px solid #1e3a5f',
                borderRight: '1px solid #1e3a5f',
                borderLeft: isToday ? '2px solid ' + gridTokens.accent : isSatBorder ? '2px solid rgba(30,58,95,0.6)' : 'none',
                padding: '2px 6px', textAlign: 'center',
                fontSize: 12.5, fontWeight: 700,
                color: isToday ? gridTokens.accent : holiday ? '#fbbf24' : gridTokens.chromeText,
                boxShadow: isToday ? 'inset 0 -3px 0 ' + gridTokens.accentStrong : undefined,
              }}>
                {formatMMDD(date)}
                {holiday && (
                  <div style={{ fontSize: 9, color: '#fbbf24', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {holiday.holiday_name}
                  </div>
                )}
                {/* Observance caption. Deliberately the MUTED chrome colour,
                    not the holiday amber: amber means "this date is a
                    scheduling holiday" (different templates, different bucket)
                    and these are notes that change nothing. Same reason the
                    cell background is untouched. */}
                {observanceLabelFor(date, observanceByDate) && (
                  <div
                    title={observanceLabelFor(date, observanceByDate)!}
                    style={{
                      fontSize: 9, fontWeight: 500, color: gridTokens.chromeMuted,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}
                  >
                    {observanceLabelFor(date, observanceByDate)}
                  </div>
                )}
                {(mdCount > 0 || crnaCount > 0) && (
                  <div style={{
                    fontSize: 9, fontWeight: 700, color: '#94a3b8', marginTop: 2,
                    fontFamily: 'var(--font-mono), ui-monospace, monospace',
                  }} title="MDs working (weekday C1 excluded) · CRNAs working">
                    {mdCount} MD{crnaCount > 0 ? ` · ${crnaCount} CRNA` : ''}
                  </div>
                )}
              </div>
            );
          })}

          {/* ── Data Rows: one per shift type ─────────────────────────────── */}

          {shiftTypes.map(st => (
            <Fragment key={st.id}>
              {/* Shift label cell */}
              <div key={`label-${st.id}`} style={{
                position: 'sticky', left: 0, zIndex: 2,
                background: gridTokens.chrome,
                borderLeft: '4px solid ' + gridTokens.accent,
                borderBottom: '1px solid #1e3a5f',
                borderRight: '1px solid #1e3a5f',
                padding: '2px 8px', display: 'flex', flexDirection: 'column', justifyContent: 'center',
                minHeight: 20,
              }}>
                <div style={{ fontSize: 13, fontWeight: 800, color: '#ffffff', whiteSpace: 'nowrap' }}>{st.code}</div>
                <div style={{ fontSize: 9.5, color: gridTokens.chromeMuted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{st.name}</div>
              </div>

              {/* Assignment cells */}
              {visibleDates.map((date, i) => {
                const slot = slotMap[st.id]?.[date];

                // ── Call splits: stacked segment mini-cells ──────────────
                // A split day has NO whole-call slot; its segment slots render
                // stacked inside this parent row cell, each independently
                // fillable via the normal picker (click → setActiveCell on
                // the SEGMENT slot). Works at every zoom level — the cell is
                // ordinary grid content under the uniform CSS zoom.
                const segs = !slot ? segmentsByParent.get(segmentKey(st.code, date)) : undefined;
                if (segs && segs.length > 0) {
                  const dow = getDayOfWeek(date);
                  const isWeekend = dow === 0 || dow === 6;
                  const isHoliday = !!holidayMap[date];
                  const isToday = date === todayStr;
                  const isSatBorder = dow === 6 && i > 0;
                  return (
                    <div
                      key={`cell-${st.id}-${date}`}
                      style={{
                        background: cellBackground({ isOverPar: false, isExtraCall: false, isHoliday, isWeekend }),
                        borderBottom: '1px solid ' + gridTokens.line,
                        borderRight: '1px solid ' + gridTokens.line,
                        borderLeft: isToday ? '2px solid ' + gridTokens.accentStrong : isSatBorder ? '2px solid #1e3a5f' : 'none',
                        padding: 0,
                        minHeight: 20,
                        display: 'flex', flexDirection: 'column', justifyContent: 'stretch',
                        position: 'relative',
                      }}
                    >
                      {segs.map((seg, sIdx) => {
                        const segAssignment = seg.assignments?.[0] ?? null;
                        const segProvider = segAssignment?.providers ?? null;
                        const segFlags = segAssignment?.validation_flags ?? [];
                        const segHard = segFlags.some(f => f.severity === 'hard');
                        const segSoft = !segHard && segFlags.some(f => f.severity === 'soft');
                        const segOver = !!segAssignment && !!segProvider && overParAssignmentIds.has(segAssignment.id);
                        // Extra-call parity with whole call cells: a holder
                        // outside the regular call pool gets the same EXTRA
                        // signal (OVER wins, mirroring the whole-cell tag
                        // precedence) — segments must not hide pool pickups.
                        const segExtra = !!segProvider && !callTakerIds.has(segProvider.id);
                        // A split segment IS a billable call in its own right
                        // (its own slot, its own assignment, its own burden
                        // weight), so it takes the same hand-set mark. The
                        // segment wash is the shift-type colour rather than
                        // cellBackground's chain, so the override is applied
                        // directly here — same tokens, same inset ring.
                        const segHighlight = segProvider
                          ? normalizeHighlightColor(segAssignment?.highlight_color)
                          : null;
                        // A SEGMENT is a call slot in its own right (own slot,
                        // own assignment, own burden weight), so an unfilled
                        // one is an unfilled call and gets the same red cell +
                        // "open" as a whole call — same predicate, so the
                        // stacked cells and the Available Call List agree.
                        // Without this the list would carry rows the grid
                        // renders in a 0.05 near-white wash.
                        const segUnfilled = !segProvider && isUnfilledCallSlot(seg);
                        const segBg = (hover: boolean) => segHighlight
                          ? (hover ? gridTokens.manualHighlightHover : gridTokens.manualHighlight)[segHighlight]
                          : segUnfilled
                            ? (hover ? gridTokens.openCallHover : gridTokens.openCall)
                            : colorWithAlpha(seg.shift_types.color_hex, hover ? 0.26 : segProvider ? 0.14 : 0.05);
                        return (
                          <div
                            key={seg.id}
                            onClick={(e) => {
                              e.stopPropagation();
                              setActiveCell({
                                slotId: seg.id,
                                assignmentId: segAssignment?.id ?? null,
                                x: e.clientX, y: e.clientY,
                              });
                              setPickerSearch('');
                            }}
                            onContextMenu={(e) => {
                              if (!segProvider || !segAssignment?.id) return;
                              e.preventDefault();
                              e.stopPropagation();
                              setActiveCell(null);
                              setPickerSearch('');
                              setPaletteCell({
                                assignmentId: segAssignment.id,
                                current: segHighlight,
                                note: typeof segAssignment.notes === 'string' ? segAssignment.notes : null,
                                label: `${seg.shift_types.code} · ${formatMMDD(date)} — ${segProvider.short_display_name}`,
                                x: e.clientX, y: e.clientY,
                              });
                            }}
                            title={[
                              typeof segAssignment?.notes === 'string' && segAssignment.notes.trim()
                                ? segAssignment.notes.trim() : null,
                              `${seg.shift_types.name}${segProvider ? ` — ${segProvider.short_display_name}` : ' — open'}`
                                + `${segExtra ? ' — extra call (not in the regular call pool at this site)' : ''}`,
                              segHighlight ? manualHighlightTitle(segHighlight) : null,
                            ].filter(Boolean).join('\n')}
                            style={{
                              flex: 1,
                              display: 'flex', alignItems: 'center', gap: 3,
                              padding: '0 3px', minHeight: 14, cursor: 'pointer',
                              borderTop: sIdx > 0 ? '1px dashed ' + gridTokens.line : 'none',
                              background: segBg(false),
                              boxShadow: segHighlight ? gridTokens.manualHighlightOutline : undefined,
                            }}
                            onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = segBg(true); }}
                            onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = segBg(false); }}
                          >
                            <span style={{
                              fontSize: 7.5, fontWeight: 800, letterSpacing: '0.03em',
                              // The muted slate tag is unreadable on the solid
                              // open red; on an unfilled segment it goes white
                              // like the rest of that mini-cell's ink.
                              color: segUnfilled ? gridTokens.openCallText : gridTokens.chromeMuted,
                              flexShrink: 0, minWidth: 16,
                            }}>{segmentTag(seg.shift_types.code, st.code)}</span>
                            {segProvider ? (
                              <span style={{
                                fontSize: viewMode === 'month' ? 9.5 : 11, fontWeight: 800, color: gridTokens.name,
                                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1,
                              }}>{segProvider.short_display_name}</span>
                            ) : (
                              <span style={{
                                fontSize: 8.5, fontWeight: 800, letterSpacing: '0.03em',
                                color: segUnfilled ? gridTokens.openCallText : gridTokens.open,
                              }}>open</span>
                            )}
                            {segOver ? (
                              <span aria-label="Over par for this shift" style={{
                                fontSize: 6.5, fontWeight: 800, letterSpacing: '0.03em',
                                color: '#b91c1c', flexShrink: 0,
                              }}>OVER</span>
                            ) : segExtra ? (
                              <span aria-label="Extra call" style={{
                                fontSize: 6.5, fontWeight: 800, letterSpacing: '0.03em',
                                color: '#0369a1', flexShrink: 0,
                              }}>EXTRA</span>
                            ) : null}
                            {(segHard || segSoft) && (
                              <span
                                aria-label={segHard ? 'Hard rule violation' : 'Soft rule warning'}
                                title={segFlags.map(f => `${f.severity === 'hard' ? '!' : '?'} ${f.message}`).join('\n')}
                                style={{
                                  width: 6, height: 6, borderRadius: 3, flexShrink: 0,
                                  background: segHard ? gridTokens.hard : gridTokens.soft,
                                }}
                              />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                }

                const assignment = slot?.assignments?.[0] ?? null;
                const provider = assignment?.providers ?? null;
                const isAssigned = !!provider;
                const isOpenCall = assignment?.is_open_call ?? false;
                const isLocked = slot?.locked ?? false;
                const flags = assignment?.validation_flags ?? [];
                const hardFlag = flags.some(f => f.severity === 'hard');
                const softFlag = !hardFlag && flags.some(f => f.severity === 'soft');
                const dow = getDayOfWeek(date);
                const isWeekend = dow === 0 || dow === 6;
                const isHoliday = !!holidayMap[date];
                const isToday = date === todayStr;
                const isSatBorder = dow === 6 && i > 0;

                // Extra-call detection: an assignment on a call-category shift
                // where the provider is NOT in the profile-level call-taker
                // pool (neither call_taker nor partial_call_taker checked).
                // Rendered in blue as an informational notice — it's legal,
                // just flags that this person is picking up an extra.
                const isCallShift = st.category === 'call';
                const isExtraCall = isAssigned && isCallShift && !!provider && !callTakerIds.has(provider.id);
                // Over-par (2026-07-17; minimal-cover 2026-07-29): this
                // assignment is in the smallest-weight set of the provider's
                // calls that covers their overage past the rounded TOTAL
                // obligation. Calls up to the rounded obligation never carry
                // the OVER treatment.
                // Doesn't include deficit carry-forward — see useMemo notes.
                const isOverPar = isAssigned && !!assignment && overParAssignmentIds.has(assignment.id);
                // PTO sell-back: this provider has a live pto_sellback row
                // covering today — they're working a date PTO would otherwise
                // block. Red "SB" marker + tooltip (bottom-left corner is
                // unused: validation badge top-left, lock top-right,
                // OVER/EXTRA bottom-right).
                const isSellback = isAssigned && !!provider && !!sellbackByDate[date]?.has(provider.id);
                // Hand-set billing mark (patch42). Normalized, so a pre-patch
                // row (column absent → undefined) and an out-of-vocabulary
                // value both fold to "no mark" instead of blanking the cell.
                // Gated on isAssigned as belt-and-braces: the mark describes a
                // PROVIDER's call, and the writers already clear it whenever a
                // row reverts to open (sequenceAutoFill.revertToOpen) or is
                // reassigned/deleted — this makes a mark that somehow survived
                // onto an open row invisible rather than misleading.
                const manualHighlight = isAssigned
                  ? normalizeHighlightColor(assignment?.highlight_color)
                  : null;
                // Unfilled call (2026-07-29) — THE red cell Gabriel asked for:
                // a call slot nobody is working, which he has to list up for
                // grabs as a paid pickup. `isUnfilledCallSlot` is the SAME
                // predicate the Available Call List is built from, so a red
                // cell and a list row are the same fact rendered twice; it
                // scans every assignment row through plannerMath's
                // assignmentFills, so an OPEN PLACEHOLDER (the row the DELETE
                // endpoint re-inserts with a null provider) reads as empty
                // rather than as covered.
                //
                // Conjoined with !isAssigned deliberately. The cell's CONTENT
                // branch keys off isAssigned (`!!assignment.providers`), and
                // the two predicates differ on exactly one thing: a row with a
                // provider whose status is canceled/declined fills nothing but
                // still renders a name. The app writes only 'assigned' and
                // 'open' so this cannot occur today, and the conjunction
                // guarantees that if it ever did, the cell can never show a
                // red "this is empty" wash underneath somebody's name — it
                // would appear in the list (which is the more correct answer)
                // and stay quiet on the grid.
                const isUnfilledCall = !!slot && !isAssigned && isUnfilledCallSlot(slot);

                const cellFlags = {
                  isOverPar, isExtraCall, isHoliday, isWeekend, manualHighlight, isUnfilledCall,
                  // Focus is keyed on the ASSIGNED provider, so an open cell is
                  // never "theirs" and fades with the rest — which is right:
                  // an empty slot is not one of this provider's days.
                  focusActive: !!focusPid,
                  focusMatch: !!focusPid && provider?.id === focusPid,
                };
                // The computed explanation still applies even when the manual
                // colour out-ranks its wash, so the mark's tooltip is APPENDED
                // rather than replacing it.
                const computedTitle =
                  isOverPar && provider
                    ? `${provider.short_display_name} is past their rounded call obligation for this block — this is one of their extra calls.`
                    : isExtraCall && provider
                      ? `Provider picking up Extra call — ${provider.short_display_name} is not in the regular call pool at this site.`
                      : isSellback && provider
                        ? `${provider.short_display_name} is selling back PTO — working this date.`
                        : isUnfilledCall
                          ? `${st.code} on ${formatMMDD(date)} is unfilled — ${isOpenCall
                              ? 'already listed up for grabs.'
                              : 'list it up for grabs. See Available Call.'}`
                          : undefined;
                const cellNote = typeof assignment?.notes === 'string' && assignment.notes.trim()
                  ? assignment.notes.trim() : null;
                // The comment leads: it is the one line a human wrote, so it
                // should be the first thing the tooltip says. The computed
                // explanation and the manual-mark note still follow — a comment
                // adds to what the cell says, it never replaces it.
                const cellTitle = [
                  cellNote,
                  manualHighlight ? manualHighlightTitle(manualHighlight) : null,
                  computedTitle,
                ].filter(Boolean).join('\n');

                return (
                  <div
                    key={`cell-${st.id}-${date}`}
                    onClick={(e) => {
                      if (!slot) return;
                      setActiveCell({
                        slotId: slot.id,
                        assignmentId: assignment?.id ?? null,
                        x: e.clientX,
                        y: e.clientY,
                      });
                      setPickerSearch('');
                    }}
                    // Right-click → colour palette (patch42). ASSIGNED cells
                    // only: the mark lives on the assignment row, so an open
                    // cell has nothing to store it on. On an open cell we
                    // deliberately do NOT preventDefault — the browser's own
                    // menu keeps working, which is the pre-existing behaviour
                    // everywhere else on the page.
                    onContextMenu={(e) => {
                      if (!slot || !isAssigned || !assignment?.id) return;
                      e.preventDefault();
                      e.stopPropagation();
                      setActiveCell(null);
                      setPickerSearch('');
                      setPaletteCell({
                        assignmentId: assignment.id,
                        current: manualHighlight,
                        note: typeof assignment.notes === 'string' ? assignment.notes : null,
                        label: `${st.code} · ${formatMMDD(date)} — ${provider!.short_display_name}`,
                        x: e.clientX,
                        y: e.clientY,
                      });
                    }}
                    title={cellTitle}
                    style={{
                      background: cellBackground(cellFlags),
                      boxShadow: cellOutline(cellFlags),
                      opacity: cellOpacity(cellFlags),
                      borderBottom: '1px solid ' + gridTokens.line,
                      borderRight: '1px solid ' + gridTokens.line,
                      borderLeft: isToday ? '2px solid ' + gridTokens.accentStrong : isSatBorder ? '2px solid #1e3a5f' : 'none',
                      padding: '1px 3px',
                      minHeight: 20,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      cursor: slot ? 'pointer' : 'default',
                      position: 'relative',
                      transition: 'background 0.1s',
                    }}
                    onMouseEnter={(e) => {
                      if (!slot) return;
                      (e.currentTarget as HTMLDivElement).style.background = cellBackground(cellFlags, true);
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLDivElement).style.background = cellBackground(cellFlags);
                    }}
                  >
                    {/* Comment marker — a small notch in the TOP-RIGHT, the
                        spreadsheet convention for "this cell has a note". That
                        corner also carries the lock glyph, but a locked cell is
                        rare and the notch is 6px inside the corner, so the two
                        read as separate marks rather than overlapping. */}
                    {cellNote && (
                      <span
                        aria-hidden
                        style={{
                          position: 'absolute', top: 0, right: 0,
                          width: 0, height: 0,
                          borderTop: '6px solid ' + gridTokens.accentStrong,
                          borderLeft: '6px solid transparent',
                          pointerEvents: 'none',
                        }}
                      />
                    )}
                    {!slot ? null : isAssigned ? (
                      <span style={{
                        fontSize: viewMode === 'month' ? 11 : 13, fontWeight: 800, color: gridTokens.name,
                        whiteSpace: 'nowrap', maxWidth: '100%', overflow: 'hidden',
                        textOverflow: 'ellipsis', display: 'inline-block', verticalAlign: 'bottom',
                      }}>
                        {provider!.short_display_name}
                      </span>
                    ) : isUnfilledCall ? (
                      /* Gabriel's words, verbatim: "'open' should be listed in
                         it". Lower-case on purpose — this is the cell's
                         CONTENT slot, the one that otherwise holds a
                         provider's mixed-case name; the upper-case marks in
                         this grid (OVER / EXTRA / SB) all live in the corners.
                         White is the only white-on-red text on the grid. */
                      <span style={{
                        fontSize: viewMode === 'month' ? 10 : 11.5, fontWeight: 800,
                        letterSpacing: '0.02em', color: gridTokens.openCallText,
                      }}>open</span>
                    ) : isOpenCall ? (
                      /* Unreachable for a call slot (an is_open_call row with
                         no provider is by definition an unfilled call, handled
                         above); retained for a non-call shift type that was
                         somehow offered, whose prior treatment is unchanged. */
                      <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.03em', color: gridTokens.open }}>OPEN</span>
                    ) : (
                      <span style={{ fontSize: 13, color: gridTokens.unassigned }} aria-label="Unassigned">&mdash;</span>
                    )}

                    {/* ── Already listed up for grabs ──────────────────────
                        THE distinction between the two open states, preserved
                        rather than collapsed. `is_open_call` means an
                        open_call_offer row exists — a human has already posted
                        this call to the group — which is a strict SUBSET of
                        unfilled, so both share the red cell (Gabriel asked for
                        every unfilled call to be red) and the posted ones
                        carry this mark on top.

                        A dot, not a word: the corner tags this grid already
                        uses (OVER/EXTRA/SB) are 2–5 characters and a legible
                        word for "posted" is longer than a month-view cell is
                        wide, whereas the 6px dot is the device the segment
                        cells already use for their validation marks and stays
                        readable at every zoom. Bottom-right is free on an
                        unfilled cell by construction: OVER and EXTRA both
                        require an assignment, SB requires a provider. */}
                    {isUnfilledCall && isOpenCall && (
                      <span
                        aria-label="Already listed up for grabs"
                        title="Already posted to the group for pickup."
                        style={{
                          position: 'absolute', bottom: 2, right: 3,
                          width: 6, height: 6, borderRadius: 3, pointerEvents: 'none',
                          background: gridTokens.openCallText,
                        }}
                      />
                    )}

                    {/* Bottom-right status tag — over-par wins over extra-call,
                        mirroring the cell-background precedence so the two tags
                        (which can co-occur) never overlap. */}
                    {isOverPar ? (
                      <span aria-label="Over par for this shift" style={{
                        position: 'absolute', bottom: 1, right: 3,
                        fontSize: 7.5, fontWeight: 800, letterSpacing: '0.03em',
                        color: '#b91c1c', pointerEvents: 'none',
                      }}>OVER</span>
                    ) : isExtraCall ? (
                      <span aria-label="Extra call" style={{
                        position: 'absolute', bottom: 1, right: 3,
                        fontSize: 8, fontWeight: 800, letterSpacing: '0.5px',
                        color: '#0369a1', pointerEvents: 'none',
                      }}>EXTRA</span>
                    ) : null}

                    {/* Sell-back marker (bottom-LEFT — can co-occur with the
                        bottom-right OVER/EXTRA tags without overlap). Red per
                        the sell-back convention: gridTokens.sellbackMark. */}
                    {isSellback && (
                      <span aria-label="Selling back PTO — working" style={{
                        position: 'absolute', bottom: 1, left: 3,
                        fontSize: 8, fontWeight: 800, letterSpacing: '0.5px',
                        color: gridTokens.sellbackMark, pointerEvents: 'none',
                      }}>SB</span>
                    )}

                    {/* Lock icon */}
                    {isLocked && (
                      <span aria-label="Locked slot" style={{
                        position: 'absolute', top: 2, right: 4, fontSize: 10, lineHeight: 1,
                      }}>
                        &#x1F512;
                      </span>
                    )}

                    {/* Validation badge */}
                    {(hardFlag || softFlag) && (
                      <span
                        aria-label={hardFlag ? 'Hard rule violation' : 'Soft rule warning'}
                        title={flags.map(f => `${f.severity === 'hard' ? '!' : '?'} ${f.message}`).join('\n')}
                        style={{
                          position: 'absolute', top: 2, left: 2,
                          minWidth: 12, height: 12, padding: '0 1px', borderRadius: 4,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 9, fontWeight: 900, lineHeight: 1, color: '#fff',
                          background: hardFlag ? gridTokens.hard : gridTokens.soft,
                          boxShadow: hardFlag ? '0 0 4px rgba(239,68,68,0.6)' : '0 0 4px rgba(245,158,11,0.55)',
                        }}
                      >{hardFlag ? '!' : '?'}</span>
                    )}
                  </div>
                );
              })}
            </Fragment>
          ))}

          {/* ── Virtual rows: Post-Call / Off / PTO / Available ────────────
              Order per Gabriel 2026-07-20: Available moves to the LAST
              section of the grid, after PTO. zoneTop (the 2px zone-start
              border) belongs to the FIRST section that actually renders —
              Post-Call and Off skip rendering when empty, PTO always renders. */}
          {/* Post-Call row: providers who had a call shift the day before
              and have no assignment today. They're effectively off-duty
              for call rotation but we still want them visible so users
              know why they're "missing" from Available. */}
          {renderVirtualRows({
            label: 'Post-Call',
            count: maxPostCall,
            dataByDate: postCallByDate,
            color: gridTokens.category['Post-Call'],
            visibleDates,
            todayStr,
            holidayMap,
            getDayOfWeek,
            zoneTop: maxPostCall > 0,
          })}
          {renderVirtualRows({
            label: 'Off',
            count: maxOff,
            dataByDate: offByDate,
            zoneTop: maxPostCall === 0 && maxOff > 0,
            // Reason-coded blocked entries (ICU Week / ICU Post-Call) show
            // their label on hover so ICU docs read distinctly from generic
            // days off.
            titleByDate: offTitleByDate,
            color: gridTokens.category.Off,
            visibleDates,
            todayStr,
            holidayMap,
            getDayOfWeek,
          })}
          {/* ICU rotation — below Off, per Gabriel 2026-08-02. Same
              reason-coded rows that used to sit inside Off with a hover
              label; they now read at a glance instead. */}
          {renderVirtualRows({
            label: 'ICU',
            count: maxIcu,
            dataByDate: icuByDate,
            titleByDate: offTitleByDate,
            color: gridTokens.category.ICU,
            visibleDates,
            todayStr,
            holidayMap,
            getDayOfWeek,
            zoneTop: maxPostCall === 0 && maxOff === 0 && maxIcu > 0,
          })}
          {renderVirtualRows({
            label: 'PTO',
            count: maxPto,
            dataByDate: ptoByDate,
            color: gridTokens.category.PTO,
            visibleDates,
            todayStr,
            holidayMap,
            getDayOfWeek,
            zoneTop: maxPostCall === 0 && maxOff === 0 && maxIcu === 0,
            // Always show the PTO label row even when empty — a standing
            // "PTO" cue so scanners know where to look for planned leave.
            alwaysRender: true,
          })}
          {renderVirtualRows({
            label: 'Available',
            count: maxAvailable,
            dataByDate: availableByDate,
            color: gridTokens.category.Available,
            visibleDates,
            todayStr,
            holidayMap,
            getDayOfWeek,
            // Sell-back providers land in Available (they're working) with the
            // red tint + tooltip so the row reads why they're here.
            sellbackByDate,
          })}
        </div>
      </div>
      )}

      {viewMode === 'calendar' && (
        <CalendarView
          allDates={allDates}
          monthOffset={calendarMonthOffset}
          onPrevMonth={() => setCalendarMonthOffset(o => Math.max(0, o - 1))}
          onNextMonth={() => setCalendarMonthOffset(o => o + 1)}
          mdCountByDate={mdCountByDate}
          crnaCountByDate={crnaCountByDate}
          workingByDate={workingByDate}
          overParAssignmentIds={overParAssignmentIds}
          holidayMap={holidayMap}
          todayStr={todayStr}
        />
      )}

      {/* ── Highlight Palette (right-click on an assigned cell) ───────────────
          Manual billing mark, patch42. Deliberately its own popover, entirely
          separate from the left-click picker below: left-click behaviour is
          unchanged, and neither popover can be reached from the other's code
          path. Dismissable by Escape or any outside click (effect above); it
          never takes focus, so it cannot trap it. */}

      {paletteCell && (
        <div
          ref={paletteRef}
          role="menu"
          aria-label="Cell colour"
          style={{
            position: 'fixed',
            left: Math.min(paletteCell.x, window.innerWidth - 196),
            top: Math.min(paletteCell.y, window.innerHeight - 190),
            width: 184,
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            borderRadius: 12,
            boxShadow: '0 16px 40px rgba(0,0,0,0.5)',
            zIndex: 520,
            overflow: 'hidden',
          }}
        >
          <div style={{
            padding: '8px 11px', background: 'var(--bg-deep)', borderBottom: '1px solid var(--border)',
            fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase',
            color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {paletteCell.label}
          </div>
          <div style={{ padding: 7, display: 'flex', flexDirection: 'column', gap: 3 }}>
            {HIGHLIGHT_COLORS.map(color => {
              const selected = paletteCell.current === color;
              return (
                <button
                  key={color}
                  role="menuitemradio"
                  aria-checked={selected}
                  onClick={() => setHighlight(paletteCell.assignmentId, color)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 9,
                    padding: '7px 9px', borderRadius: 8, cursor: 'pointer',
                    border: '1px solid ' + (selected ? 'var(--text-dim)' : 'var(--border)'),
                    background: selected ? 'var(--bg-deep)' : 'transparent',
                    color: 'var(--text)', fontSize: 12.5, fontWeight: 700, textAlign: 'left',
                  }}
                >
                  {/* Swatch renders the EXACT token the cell will take,
                      inset ring included — what you pick is what you get. */}
                  <span aria-hidden style={{
                    width: 18, height: 18, borderRadius: 5, flexShrink: 0,
                    background: gridTokens.manualHighlight[color],
                    boxShadow: gridTokens.manualHighlightOutline,
                  }} />
                  <span style={{ textTransform: 'capitalize', flex: 1 }}>{color}</span>
                  {selected && (
                    <span aria-hidden style={{ fontSize: 11, color: 'var(--text-dim)' }}>&#10003;</span>
                  )}
                </button>
              );
            })}
            <button
              role="menuitem"
              onClick={() => setCellComment(paletteCell.assignmentId, paletteCell.note)}
              style={{
                display: 'flex', alignItems: 'center', gap: 9,
                padding: '7px 9px', borderRadius: 8, marginTop: 6,
                cursor: 'pointer', border: '1px solid var(--border)',
                background: 'transparent', color: 'var(--text-muted)',
                fontSize: 12.5, fontWeight: 700, textAlign: 'left',
                borderTop: '1px solid var(--border)',
              }}
            >
              <span aria-hidden style={{ width: 18, textAlign: 'center', fontSize: 13 }}>&#128172;</span>
              <span style={{ flex: 1 }}>{paletteCell.note ? 'Edit comment…' : 'Add comment…'}</span>
            </button>
            <button
              role="menuitem"
              onClick={() => setHighlight(paletteCell.assignmentId, null)}
              disabled={paletteCell.current === null}
              style={{
                display: 'flex', alignItems: 'center', gap: 9,
                padding: '7px 9px', borderRadius: 8, marginTop: 2,
                cursor: paletteCell.current === null ? 'default' : 'pointer',
                border: '1px solid var(--border)', background: 'transparent',
                color: paletteCell.current === null ? 'var(--text-dim)' : 'var(--text-muted)',
                fontSize: 12.5, fontWeight: 700, textAlign: 'left',
                opacity: paletteCell.current === null ? 0.5 : 1,
              }}
            >
              <span aria-hidden style={{
                width: 18, height: 18, borderRadius: 5, flexShrink: 0,
                background: gridTokens.bodyCell, border: '1px dashed var(--border)',
              }} />
              <span style={{ flex: 1 }}>Clear</span>
            </button>
          </div>
        </div>
      )}

      {/* ── Provider Picker / Action Popover ──────────────────────────────── */}

      {activeCell && (
        <div
          ref={pickerRef}
          style={{
            position: 'fixed',
            left: Math.min(activeCell.x, window.innerWidth - 280),
            top: Math.min(activeCell.y, window.innerHeight - 400),
            width: 268,
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            borderRadius: 12,
            boxShadow: '0 16px 40px rgba(0,0,0,0.5)',
            zIndex: 500,
            display: 'flex', flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          {/* ── Slot-context header (read-only label) ──────────────────────── */}
          {activeSlot && (
            <div style={{
              padding: '9px 13px', background: 'var(--bg-deep)', borderBottom: '1px solid var(--border)',
              fontSize: 10.5, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-muted)',
              display: 'flex', alignItems: 'center', gap: 7,
            }}>
              <span style={{ width: 9, height: 9, borderRadius: 3, background: gridTokens.accent, flexShrink: 0 }} />
              {activeSlot.shift_types.code} · {activeSlot.shift_types.name} — {formatMMDD(activeSlot.slot_date)}
            </div>
          )}

          {isAssignedCell ? (
            /* ── Assigned cell: action popover ──────────────────────────────── */
            <div style={{ padding: 12 }}>
              <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--text)', marginBottom: 4 }}>
                {activeAssignment?.providers?.short_display_name ?? 'Unknown'}
              </div>
              <div style={{
                fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', color: 'var(--text-dim)',
                textTransform: 'uppercase', marginBottom: 12,
              }}>
                {activeAssignment?.providers?.provider_type}
              </div>
              {activeAssignment?.validation_flags && activeAssignment.validation_flags.length > 0 && (
                <div style={{
                  marginBottom: 12, padding: 8, borderRadius: 9,
                  background: 'rgba(239,68,68,0.06)',
                  border: '1px solid rgba(239,68,68,0.28)',
                  maxHeight: 140, overflowY: 'auto',
                }}>
                  <div style={{
                    fontSize: 10, fontWeight: 700, letterSpacing: 0.5,
                    color: '#ef4444', textTransform: 'uppercase', marginBottom: 6,
                  }}>
                    Rule Violations ({activeAssignment.validation_flags.length})
                  </div>
                  {activeAssignment.validation_flags.map((f, idx) => (
                    <div key={idx} style={{
                      marginBottom: 6, lineHeight: 1.4,
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{
                          display: 'inline-block', width: 6, height: 6, borderRadius: '50%',
                          background: f.severity === 'hard' ? gridTokens.hard : gridTokens.soft,
                          flexShrink: 0,
                        }} />
                        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>{f.rule_name}</span>
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 12 }}>
                        {f.message}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <button
                  onClick={() => activeAssignment && removeAssignment(activeAssignment.id)}
                  style={{
                    padding: '9px 12px', fontSize: 12.5, fontWeight: 700, border: '1px solid rgba(239,68,68,0.35)',
                    borderRadius: 8, background: 'rgba(239,68,68,0.10)', color: '#f87171', cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  Remove Assignment
                </button>
                <button
                  onClick={() => {
                    if (activeSlot) toggleLock(activeSlot.id, activeSlot.locked);
                  }}
                  style={{
                    padding: '9px 12px', fontSize: 12.5, fontWeight: 700, border: '1px solid var(--border)',
                    borderRadius: 8, background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  {activeSlot?.locked ? 'Unlock Slot' : 'Lock Slot'}
                </button>
                {/* Unsplit stays discoverable on an ASSIGNED segment too — the
                    server 409s with "remove the segment assignments first",
                    which surfaces through the action toast. */}
                {activeSlot && isSegmentType(activeSlot.shift_types) && (
                  <button
                    onClick={() => unsplitSlot(activeSlot.id)}
                    style={{
                      padding: '9px 12px', fontSize: 12.5, fontWeight: 700, border: '1px solid var(--border)',
                      borderRadius: 8, background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer',
                      textAlign: 'left',
                    }}
                  >
                    Unsplit — restore whole {activeSlot.shift_types.parent_call_code} call
                  </button>
                )}
              </div>
            </div>
          ) : (
            /* ── Unassigned cell: provider picker ───────────────────────────── */
            <>
              {/* Call splits (2026-07-22): structure actions on the OPEN cell.
                  A whole call splits into 2×12 / 3×8 segment slots; any open
                  segment offers Unsplit (server guard: every sibling segment
                  must be open — a 409 surfaces via the action toast). */}
              {activeSlot && activeSlot.shift_types.category === 'call' && (
                isSegmentType(activeSlot.shift_types) ? (
                  <div style={{ padding: '10px 10px 0 10px' }}>
                    <button
                      onClick={() => unsplitSlot(activeSlot.id)}
                      style={{
                        width: '100%', padding: '8px 12px', fontSize: 12, fontWeight: 700,
                        border: '1px solid var(--border)', borderRadius: 8,
                        background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer',
                        textAlign: 'left',
                      }}
                    >
                      Unsplit — restore whole {activeSlot.shift_types.parent_call_code} call
                    </button>
                  </div>
                ) : (
                  <div style={{ padding: '10px 10px 0 10px', display: 'flex', gap: 6 }}>
                    <button
                      onClick={() => splitSlot(activeSlot.id, '2x12')}
                      title="Split this call into two 12-hour segments (07-19 and 19-07). Each segment counts 0.5 call."
                      style={{
                        flex: 1, padding: '8px 10px', fontSize: 12, fontWeight: 700,
                        border: '1px solid var(--border)', borderRadius: 8,
                        background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer',
                      }}
                    >
                      Split 2×12h
                    </button>
                    <button
                      onClick={() => splitSlot(activeSlot.id, '3x8')}
                      title="Split this call into three 8-hour segments (07-15, 15-23, 23-07). Each segment counts one third of a call."
                      style={{
                        flex: 1, padding: '8px 10px', fontSize: 12, fontWeight: 700,
                        border: '1px solid var(--border)', borderRadius: 8,
                        background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer',
                      }}
                    >
                      Split 3×8h
                    </button>
                  </div>
                )
              )}
              <div style={{ padding: '10px 10px 6px 10px' }}>
                <input
                  ref={searchInputRef}
                  type="text"
                  placeholder="Search providers..."
                  value={pickerSearch}
                  onChange={e => setPickerSearch(e.target.value)}
                  style={{
                    width: '100%', padding: '8px 11px', fontSize: 12.5, borderRadius: 8,
                    border: '1px solid var(--border)', background: 'var(--bg-deep)',
                    color: 'var(--text)', outline: 'none', boxSizing: 'border-box',
                  }}
                />
              </div>
              {/* Candidate list (2026-07-28). Available first, then no-call
                  requesters (soft — flagged, still one click), then everyone
                  who is blocked, collapsed behind a count. Every decision and
                  every sentence comes from slotCandidates; this is markup. */}
              <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
                {pickerGroups && pickerGroups.unchecked.length > 0 && (
                  <div style={{
                    margin: '0 10px 8px', padding: '7px 9px', borderRadius: 8,
                    border: '1px solid rgba(251,191,36,0.35)', background: 'rgba(251,191,36,0.10)',
                    fontSize: 10.5, lineHeight: 1.45, color: '#fcd34d',
                  }}>
                    {pickerGroups.unchecked.map(w => <div key={w}>{w}</div>)}
                  </div>
                )}
                {pickerGroups
                  && pickerGroups.available.length === 0
                  && pickerGroups.soft.length === 0
                  && pickerGroups.blocked.length === 0 && (
                  <div style={{ padding: '12px 14px', fontSize: 12, color: 'var(--text-dim)' }}>
                    No providers found
                  </div>
                )}

                {pickerGroups && pickerGroups.available.length > 0 && (
                  <>
                    <PickerSectionLabel text={`Available (${pickerGroups.available.length})`} />
                    {pickerGroups.available.map(c => (
                      <PickerRow key={c.provider.id} candidate={c} onPick={pickCandidate} />
                    ))}
                  </>
                )}

                {pickerGroups && pickerGroups.soft.length > 0 && (
                  <>
                    <PickerSectionLabel
                      text={`Flagged — still assignable (${pickerGroups.soft.length})`}
                      tone="#fbbf24"
                    />
                    {pickerGroups.soft.map(c => (
                      <PickerRow key={c.provider.id} candidate={c} onPick={pickCandidate} />
                    ))}
                  </>
                )}

                {pickerGroups && pickerGroups.blocked.length > 0 && (
                  <>
                    <button
                      onClick={() => setShowBlockedCandidates(v => !v)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 6, width: 'calc(100% - 20px)',
                        margin: '8px 10px 2px', padding: '6px 8px', borderRadius: 8,
                        border: '1px solid var(--border)', background: 'transparent',
                        color: 'var(--text-dim)', fontSize: 10.5, fontWeight: 800,
                        letterSpacing: 0.5, textTransform: 'uppercase', cursor: 'pointer',
                        textAlign: 'left',
                      }}
                    >
                      <span style={{ fontSize: 9 }}>{showBlockedCandidates ? '▾' : '▸'}</span>
                      Unavailable ({pickerGroups.blocked.length})
                    </button>
                    {showBlockedCandidates && pickerGroups.blocked.map(c => (
                      <PickerRow key={c.provider.id} candidate={c} onPick={pickCandidate} />
                    ))}
                  </>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* Call Counts Modal */}
      {showCounts && grid && (
        <CallCountsModal
          grid={grid}
          onClose={() => setShowCounts(false)}
          // Clicking a name here is the shortest path from "this person's
          // numbers look wrong" to "show me their days": focus them and get
          // out of the way, since the modal covers the grid it just filtered.
          onFocusProvider={pid => { setFocusPid(pid); setShowCounts(false); }}
        />
      )}

      {/* Available Call List */}
      {grid && printingSchedule && (
        <PrintableSchedule
          grid={grid}
          slotMap={slotMap}
          shiftTypes={shiftTypes}
          allDates={allDates}
          holidayMap={holidayMap}
          observanceByDate={observanceByDate}
          offByDate={offByDate}
          icuByDate={icuByDate}
          ptoByDate={ptoByDate}
          overParAssignmentIds={overParAssignmentIds}
          callTakerIds={callTakerIds}
        />
      )}
      {showDAudit && grid && (
        <DAuditModal
          grid={grid}
          audit={dAudit}
          applying={applyingD}
          onApply={applyDRepair}
          onClose={() => setShowDAudit(false)}
        />
      )}
      {showSpacing && grid && (
        <SpacingModal
          grid={grid}
          code={primaryCallCode}
          maxGap={spacingMaxGap}
          setMaxGap={setSpacingMaxGap}
          review={spacingReview}
          candidateIndex={candidateIndex}
          onClose={() => setShowSpacing(false)}
          onSwap={(slotId, providerId) => assignProvider(slotId, providerId)}
        />
      )}
      {showAvailableCalls && grid && (
        <AvailableCallsModal
          list={availableCalls}
          title={grid.schedule.schedule_name}
          onClose={() => setShowAvailableCalls(false)}
        />
      )}

      {/* Pool Selector Modal */}
      {showPoolModal && grid && (
        <PoolSelectorModal
          scheduleId={id}
          scheduleSiteId={grid.schedule.site_id}
          orgId={grid.schedule.organization_id}
          providers={grid.providers}
          profiles={grid.profiles}
          initialSelection={schedule.included_provider_ids}
          // Block Targets inputs. call_par_level is AUTHORITATIVE (2026-07-24)
          // and falls back to 12, the engine's own default, when the column is
          // missing; the neuro bands come from the site's active pattern.
          blockSlots={grid.slots}
          parLevel={grid.schedule.sites?.call_par_level ?? 12}
          neuroWeekend={grid.callPattern?.neuroWeekend ?? null}
          scheduleLabel={grid.schedule.schedule_name}
          blockStartYear={Number(grid.schedule.date_start.slice(0, 4))}
          onClose={() => setShowPoolModal(false)}
          onSaved={(next) => {
            setShowPoolModal(false);
            // Update the in-memory schedule so the button label refreshes
            // immediately without waiting for a re-fetch.
            setGrid(prev => prev ? {
              ...prev,
              schedule: { ...prev.schedule, included_provider_ids: next },
            } : prev);
          }}
        />
      )}
      {showAssistant && (
        <AssistantPanel scheduleId={id} onMutated={loadGrid} onClose={() => setShowAssistant(false)} />
      )}
    </div>
  );
}

/* ── Cell picker rows (2026-07-28) ────────────────────────────────────────── */
// Pure presentation. Grouping, reasons and wording all arrive on the
// SlotCandidate; nothing here decides anything.

function PickerSectionLabel({ text, tone }: { text: string; tone?: string }) {
  return (
    <div style={{
      padding: '8px 12px 4px', fontSize: 10, fontWeight: 800, letterSpacing: 0.6,
      textTransform: 'uppercase', color: tone ?? 'var(--text-dim)',
    }}>
      {text}
    </div>
  );
}

function PickerRow({
  candidate, onPick,
}: { candidate: SlotCandidate; onPick: (c: SlotCandidate) => void }) {
  const { provider, group, reasonText, reasonTexts, release } = candidate;
  const dimmed = group === 'blocked';
  const accent = group === 'blocked' ? '#f87171' : group === 'soft' ? '#fbbf24' : '#7dd3fc';
  return (
    <div
      onClick={() => onPick(candidate)}
      // The full reason list on hover; the row itself shows the leading one.
      title={[...reasonTexts, ...(release ? [release.text] : [])].join(' · ')}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px', borderRadius: 8, cursor: 'pointer',
        opacity: dimmed ? 0.62 : 1, transition: 'background 0.1s',
      }}
      onMouseEnter={e => (e.currentTarget.style.background = 'rgba(56,189,248,0.10)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
    >
      <div style={{
        width: 28, height: 28, borderRadius: '50%', fontSize: 10.5, fontWeight: 800,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: group === 'available' ? 'rgba(56,189,248,0.16)' : 'rgba(100,116,139,0.20)',
        color: accent, flexShrink: 0,
      }}>
        {provider.initials}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 13, fontWeight: 700, color: 'var(--text)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {provider.short_display_name}
        </div>
        {reasonText && (
          <div style={{
            fontSize: 10.5, color: accent, whiteSpace: 'nowrap',
            overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {reasonText}
          </div>
        )}
        {/* The day-shift release. Its OWN line, never folded into reasonText:
            picking this row performs a second write, and the user must see
            that before clicking — including when a soft reason owns the line
            above. Amber, because it is a consequence, not a reason. */}
        {release && (
          <div style={{
            fontSize: 10.5, color: '#fbbf24', whiteSpace: 'nowrap',
            overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {release.text}
          </div>
        )}
      </div>
      <span style={{
        fontSize: 9, fontWeight: 800, padding: '2px 6px', borderRadius: 4,
        background: 'rgba(100,116,139,0.22)', color: 'var(--text-dim)',
        textTransform: 'uppercase', flexShrink: 0,
      }}>
        {provider.provider_type}
      </span>
    </div>
  );
}

/* ── Virtual Row Renderer (PTO / Available / Off) ─────────────────────────── */

function renderVirtualRows({
  label, count, dataByDate, color, visibleDates, todayStr, holidayMap, getDayOfWeek,
  titleByDate, alwaysRender = false, zoneTop = false, sellbackByDate,
}: {
  label: string;
  count: number;
  dataByDate: Record<string, Provider[]>;
  // Optional hover labels (date → provider → title), e.g. "ICU Week" on the
  // Off row so reason-coded blocks read distinctly.
  titleByDate?: Record<string, Record<string, string>>;
  color: string;
  visibleDates: string[];
  todayStr: string;
  holidayMap: Record<string, Holiday>;
  getDayOfWeek: (s: string) => number;
  // When true, render a single empty row even if no providers occupy it,
  // so the label stays visible as a cue that nobody is on this row.
  alwaysRender?: boolean;
  // When true (first zone row only), adds a stronger top border marking the
  // assignment→status boundary.
  zoneTop?: boolean;
  // date → providers with a live pto_sellback row that day. A matching cell
  // gets the RED sell-back tint + "Selling back PTO — working" tooltip
  // (gridTokens.sellback / sellbackMark). Passed for the Available row only.
  sellbackByDate?: Record<string, Set<string>>;
}) {
  if (count === 0 && !alwaysRender) return null;
  const rowCount = Math.max(count, alwaysRender ? 1 : 0);
  const rows = [];
  for (let idx = 0; idx < rowCount; idx++) {
    const isFirstRow = idx === 0;
    rows.push(
      <div key={`virt-label-${label}-${idx}`} style={{
        position: 'sticky', left: 0, zIndex: 2,
        background: gridTokens.chrome,
        borderLeft: `4px solid ${color}`,
        borderBottom: '1px solid #1e3a5f',
        borderRight: '1px solid #1e3a5f',
        ...(zoneTop && isFirstRow ? { borderTop: '2px solid #33455f' } : {}),
        padding: '2px 8px', display: 'flex', alignItems: 'center',
        minHeight: 18,
      }}>
        <div style={{ fontSize: 11.5, fontWeight: 700, color: '#e2e8f0', whiteSpace: 'nowrap' }}>
          {label}{count > 1 ? ` ${idx + 1}` : ''}
        </div>
      </div>
    );
    for (let i = 0; i < visibleDates.length; i++) {
      const date = visibleDates[i];
      const providers = dataByDate[date] || [];
      const provider = providers[idx];
      const dow = getDayOfWeek(date);
      const isWeekend = dow === 0 || dow === 6;
      const isHoliday = !!holidayMap[date];
      const isToday = date === todayStr;
      const isSatBorder = dow === 6 && i > 0;
      // Sell-back cell: red tint + red name (Gabriel's explicit ask) — the
      // provider is here because they're WORKING a date PTO would otherwise
      // block. Applied directly (not via cellBackground, whose precedence is
      // pinned by gridTheme.test.ts). Because the tint is near-identical to
      // the over-par wash and red elsewhere means a problem, the cell ALSO
      // carries two hover-free identifiers: the same "SB" tag assignment
      // cells use, and a solid inset outline (gridTokens.sellbackOutline)
      // no flat status wash has.
      const isSellback = !!provider && !!sellbackByDate?.[date]?.has(provider.id);
      const virtCellBg = isSellback
        ? gridTokens.sellback
        : cellBackground({ isOverPar: false, isExtraCall: false, isHoliday, isWeekend });
      rows.push(
        <div key={`virt-cell-${label}-${idx}-${date}`} style={{
          background: virtCellBg,
          ...(isSellback ? { boxShadow: gridTokens.sellbackOutline } : {}),
          borderBottom: '1px solid ' + gridTokens.line,
          borderRight: '1px solid ' + gridTokens.line,
          borderLeft: isToday ? '2px solid ' + gridTokens.accentStrong : isSatBorder ? '2px solid #1e3a5f' : 'none',
          ...(zoneTop && isFirstRow ? { borderTop: '2px solid #cbd5e1' } : {}),
          padding: '1px 3px',
          minHeight: 18,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {provider ? (
            <span
              title={isSellback ? 'Selling back PTO — working' : titleByDate?.[date]?.[provider.id]}
              style={{
                fontSize: 11.5, fontWeight: isSellback ? 700 : 500,
                color: isSellback ? gridTokens.sellbackMark : gridTokens.statusName,
                whiteSpace: 'nowrap',
              }}
            >
              {provider.short_display_name}
            </span>
          ) : null}
          {isSellback && (
            <span aria-label="Selling back PTO — working" style={{
              fontSize: 8, fontWeight: 800, letterSpacing: '0.5px',
              color: gridTokens.sellbackMark, marginLeft: 3, pointerEvents: 'none',
            }}>SB</span>
          )}
        </div>
      );
    }
  }
  return <>{rows}</>;
}

/* ── Call Counts Modal ───────────────────────────────────────────────────── */

/* ── Pool Selector Modal ─────────────────────────────────────────────────────
 * Lets the user hand-pick which providers are eligible for auto-generation
 * on this schedule. Saved on the schedule row as `included_provider_ids`.
 * Null / empty array = use the default rule-based pool (home-site call-
 * takers for call, home-site Day Docs for day shifts). A non-empty array
 * NARROWS both pools (Gabriel 2026-07-21): each engine intersects the list
 * with its role criterion (call_taker/partial for call gen; is_day_doc or a
 * live PTO sell-back covering the date for day gen) — only the home-site
 * gate is skipped. It never widens eligibility.
 * ───────────────────────────────────────────────────────────────────────── */
function PoolSelectorModal({
  scheduleId,
  scheduleSiteId,
  orgId,
  providers,
  profiles,
  initialSelection,
  blockSlots,
  parLevel,
  neuroWeekend,
  scheduleLabel,
  blockStartYear,
  onClose,
  onSaved,
}: {
  scheduleId: string;
  scheduleSiteId: string;
  orgId: string;
  providers: Provider[];
  profiles: EmploymentProfile[];
  initialSelection: string[] | null;
  // ── Block Targets tab inputs (the wiring the data layer specifies) ────────
  // The stored manifest is NOT in the grid payload — it is fetched below off
  // GET /schedules/:id, alongside provider_limits, in ONE request.
  blockSlots: BlockSlot[];
  parLevel: number;
  neuroWeekend: NonNullable<CallPatternDoc['neuroWeekend']> | null;
  scheduleLabel: string;
  blockStartYear: number;
  onClose: () => void;
  onSaved: (next: string[] | null) => void;
}) {
  // Sites are loaded lazily so the button-click latency stays low. Grouping
  // everyone by home_site_id requires site display names for the headings.
  const [sites, setSites] = useState<Array<{ id: string; name: string; short_name: string | null }>>([]);
  const [sitesLoaded, setSitesLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Limits tab (2026-07-22, patch34 provider_limits) ───────────────────────
  // Per-provider block limits: expected max of each call type (C1/C2/C3) and
  // EITHER expected working days OR expected days off (mutually exclusive —
  // filling one clears/disables the other). Blank everywhere = no limit (the
  // engine keeps its FTE-derived budget — Gabriel's verbatim rule). Stored on
  // the schedule row; fetched here lazily because the grid payload doesn't
  // carry the column (and pre-patch34 DBs simply omit the field — graceful).
  const [tab, setTab] = useState<'pool' | 'limits' | 'targets'>('pool');
  const [storedLimits, setStoredLimits] = useState<ProviderLimits>({});
  const [limitDrafts, setLimitDrafts] = useState<Record<string, LimitFields>>({});
  // 'loading' → inputs held; 'ready' → editable; 'failed' → tab shows the
  // error and SAVE OMITS the provider_limits key entirely (never clobber
  // stored limits with an empty map because a fetch failed).
  const [limitsState, setLimitsState] = useState<'loading' | 'ready' | 'failed'>('loading');

  // ── Block Targets tab (2026-07-27, patch37 scenario_manifest) ─────────────
  // Same load/save discipline as Limits: the stored artifact rides in on the
  // SAME GET, and a failed fetch means the save OMITS the key entirely rather
  // than clobbering a stored manifest with an empty one. Unlike Limits, the
  // key is written only when he actually edited in this tab (`targetsDirty`):
  // a manifest is a large artifact with real engine consequences, so changing
  // the pool and pressing Save must never silently rewrite one.
  const [manifestState, setManifestState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [storedManifest, setStoredManifest] = useState<unknown>(null);
  const [cellText, setCellText] = useState<Record<string, string>>({});
  const [linkageEdits, setLinkageEdits] = useState<Record<string, PanelRow['linkages']>>({});
  const [importAcknowledged, setImportAcknowledged] = useState(false);
  const [clearTargets, setClearTargets] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/scheduling/schedules/${scheduleId}`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(data => {
        if (cancelled) return;
        const parsed = parseProviderLimits((data as { provider_limits?: unknown })?.provider_limits);
        const lim = parsed.ok && parsed.value ? parsed.value : {};
        setStoredLimits(lim);
        const drafts: Record<string, LimitFields> = {};
        for (const [pid, entry] of Object.entries(lim)) drafts[pid] = fieldsFromEntry(entry);
        setLimitDrafts(drafts);
        setLimitsState('ready');
        setStoredManifest((data as { scenario_manifest?: unknown })?.scenario_manifest ?? null);
        setManifestState('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setLimitsState('failed');
        setManifestState('failed');
      });
    return () => { cancelled = true; };
  }, [scheduleId]);

  const setLimitField = (pid: string, field: keyof LimitFields, value: string) => {
    setLimitDrafts(prev => {
      const cur = prev[pid] ?? EMPTY_LIMIT_FIELDS;
      const next: LimitFields = { ...cur, [field]: value };
      // Mutual exclusion: filling Working Days clears Days Off and vice versa.
      if (field === 'workingDays' && value.trim() !== '') next.daysOff = '';
      if (field === 'daysOff' && value.trim() !== '') next.workingDays = '';
      return { ...prev, [pid]: next };
    });
  };

  const hasInvalidLimit = Object.values(limitDrafts).some(f =>
    [f.c1, f.c2, f.c3, f.workingDays, f.daysOff].some(isInvalidLimitInput));

  // Rebuild the stored map from drafts (edited rows) + untouched stored
  // entries. Out-of-pool entries render inert below and round-trip unchanged.
  const buildLimitsPayload = (): ProviderLimits | null => {
    const out: ProviderLimits = {};
    const pids = new Set([...Object.keys(storedLimits), ...Object.keys(limitDrafts)]);
    for (const pid of pids) {
      const fields = limitDrafts[pid];
      const entry = fields ? entryFromFields(fields, storedLimits[pid]) : storedLimits[pid];
      if (entry) out[pid] = entry;
    }
    return normalizeProviderLimits(out);
  };

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/scheduling/sites?org_id=${orgId}`)
      .then(r => r.json())
      .then(data => {
        if (cancelled) return;
        setSites(Array.isArray(data) ? data : []);
        setSitesLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setSitesLoaded(true);
      });
    return () => { cancelled = true; };
  }, [orgId]);

  // Map provider_id → home_site_id for fast lookup during grouping.
  const homeSiteByPid = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const p of profiles) m.set(p.provider_id, p.home_site_id);
    return m;
  }, [profiles]);

  // Default selection = exactly whatever the current auto-gen rules would
  // pick (home_site_id === this schedule's site_id). Called-out below via a
  // "Reset to Default" button. If initialSelection is null we start with
  // this; if it's set we start with whatever was saved.
  const defaultSelection = useMemo(() => {
    const ids = new Set<string>();
    for (const p of providers) {
      if (homeSiteByPid.get(p.id) === scheduleSiteId) ids.add(p.id);
    }
    return ids;
  }, [providers, homeSiteByPid, scheduleSiteId]);

  const [checked, setChecked] = useState<Set<string>>(() => {
    if (initialSelection && initialSelection.length > 0) return new Set(initialSelection);
    return new Set(defaultSelection);
  });

  // Groups: map site_id (or '__none') → list of providers. Sorted by the
  // schedule's own site first (since it's the common case), then by site
  // short_name, then "Unassigned" last.
  const groups = useMemo(() => {
    const bySite = new Map<string, Provider[]>();
    for (const p of providers) {
      const site = homeSiteByPid.get(p.id) || '__none';
      const list = bySite.get(site) || [];
      list.push(p);
      bySite.set(site, list);
    }
    for (const list of bySite.values()) {
      list.sort((a, b) => a.last_name.localeCompare(b.last_name));
    }
    const siteName = (id: string): string => {
      if (id === '__none') return '(No home site)';
      const s = sites.find(x => x.id === id);
      return s ? (s.short_name || s.name) : '(Unknown site)';
    };
    const entries = Array.from(bySite.entries()).map(([siteId, list]) => ({
      siteId, siteName: siteName(siteId), providers: list,
    }));
    entries.sort((a, b) => {
      if (a.siteId === scheduleSiteId) return -1;
      if (b.siteId === scheduleSiteId) return 1;
      if (a.siteId === '__none') return 1;
      if (b.siteId === '__none') return -1;
      return a.siteName.localeCompare(b.siteName);
    });
    return entries;
  }, [providers, homeSiteByPid, sites, scheduleSiteId]);

  const toggle = (pid: string) => {
    setChecked(prev => {
      const next = new Set(prev);
      if (next.has(pid)) next.delete(pid); else next.add(pid);
      return next;
    });
  };

  const toggleGroup = (groupIds: string[]) => {
    setChecked(prev => {
      const next = new Set(prev);
      const allSelected = groupIds.every(id => next.has(id));
      if (allSelected) groupIds.forEach(id => next.delete(id));
      else groupIds.forEach(id => next.add(id));
      return next;
    });
  };

  const resetToDefault = () => setChecked(new Set(defaultSelection));
  const clearAll = () => setChecked(new Set());

  // ── Block Targets derived state ──────────────────────────────────────────
  const profileByPid = useMemo(() => {
    const m = new Map<string, EmploymentProfile>();
    for (const p of profiles) m.set(p.provider_id, p);
    return m;
  }, [profiles]);

  // The CALL pool, which is what block targets are about: the pool selection
  // intersected with the call-taker criterion, exactly the way the engine
  // narrows it (pool selection NARROWS, never widens — 2026-07-21). Day docs
  // in the pool have no call targets and would only be noise here.
  const poolMembersFor = useCallback((ids: ReadonlySet<string>): PoolMember[] => providers
    .filter(p => ids.has(p.id))
    .filter(p => {
      const prof = profileByPid.get(p.id);
      return !!(prof?.call_taker || prof?.partial_call_taker);
    })
    .sort((a, b) => a.last_name.localeCompare(b.last_name))
    .map(p => ({
      providerId: p.id,
      displayName: p.last_name || p.short_display_name,
      // genContext's coercion (`fte_value || 1`), NOT the page's display `?? 1`:
      // this number is written as the manifest's scenarioFte, which OVERRIDES
      // fte_value for the generation. Coercing differently here would let a 0
      // or null profile FTE reach the engine as a real 0 and zero every target.
      profileFte: profileByPid.get(p.id)?.fte_value || 1,
    })), [providers, profileByPid]);

  const nameForPid = useCallback((pid: string): string | null => {
    const p = providers.find(x => x.id === pid);
    return p ? (p.last_name || p.short_display_name) : null;
  }, [providers]);

  const callPool: PoolMember[] = useMemo(
    () => poolMembersFor(checked), [poolMembersFor, checked]);

  // The wiring the data layer specifies: weighted per-bucket capacity from the
  // block's own slots, the STORED par (authoritative — never clamped to the
  // pool's ΣFTE), and the site pattern's neuro bands.
  const targetsBasis: DerivationBasis = useMemo(() => ({
    // The site's OWN neuro code, not the C1/C2/C3 default: a site whose
    // neuroWeekend.code is not 'C3' would otherwise have every neuro slot fall
    // out of the census, NEURO_FSS capacity read 0, and the feasibility strip
    // report a permanently over-constrained bucket on a perfectly feasible block.
    slotCounts: bucketSlotCounts(blockSlots, { neuroCode: neuroWeekend?.code }),
    parLevel,
    neuro: neuroWeekend,
  }), [blockSlots, parLevel, neuroWeekend]);

  const panelRows = useMemo(
    () => buildPanelRows({ pool: callPool, storedManifest, nameFor: nameForPid }),
    [callPool, storedManifest, nameForPid]);

  // The rows a save would write for an ARBITRARY pool selection. "Use Default
  // Pool" discards the current selection, so the manifest it writes must
  // describe the DEFAULT pool — not the one being thrown away.
  const liveRowsForSelection = useCallback((ids: ReadonlySet<string>): PanelRow[] => {
    const base = buildPanelRows({
      pool: poolMembersFor(ids), storedManifest, nameFor: nameForPid,
    });
    const withLinkages = base.rows.map(r => (linkageEdits[r.providerId]
      ? { ...r, linkages: linkageEdits[r.providerId] }
      : r));
    return rowsWithCellText(withLinkages, cellText);
  }, [poolMembersFor, storedManifest, nameForPid, linkageEdits, cellText]);

  // Rows are DERIVED (pool + stored manifest + his linkage edits) rather than
  // held in state, so toggling the pool on the Pool tab can never leave a
  // stale row behind. cellText is keyed by provider id and survives on its own.
  const targetRows: PanelRow[] = useMemo(
    () => panelRows.rows.map(r => (linkageEdits[r.providerId]
      ? { ...r, linkages: linkageEdits[r.providerId] }
      : r)),
    [panelRows, linkageEdits]);

  const liveTargetRows = useMemo(
    () => rowsWithCellText(targetRows, cellText), [targetRows, cellText]);

  // Seed the typed cells ONCE, when the stored manifest lands. Re-seeding on
  // every rebuild would overwrite whatever he is in the middle of typing. The
  // signature taken here is what "dirty" is measured against.
  const targetsSeeded = useRef(false);
  const seededFingerprint = useRef<string>('');
  useEffect(() => {
    if (manifestState !== 'ready' || targetsSeeded.current) return;
    targetsSeeded.current = true;
    const seeded = cellTextFromRows(panelRows.rows);
    seededFingerprint.current = targetEditFingerprint(panelRows.rows, seeded);
    setCellText(seeded);
  }, [manifestState, panelRows]);

  // Dirty by COMPARISON, never a latch: typing a value and deleting it again
  // must leave the panel disarmed, because writing a manifest states a hard
  // ceiling for every provider in it — not only the ones he touched.
  const targetsDirty = targetsSeeded.current
    && targetEditFingerprint(targetRows, cellText) !== seededFingerprint.current;

  // Only cells belonging to a RENDERED row can block the save — an invalid
  // cell for a provider who has since left the pool is nowhere to fix.
  const visibleTargetIds = useMemo(
    () => new Set(targetRows.map(r => r.providerId)), [targetRows]);
  const invalidTargetCells = useMemo(
    () => invalidCellKeys(cellText, visibleTargetIds), [cellText, visibleTargetIds]);

  // Edits the pool selection has stranded — reported, never dropped in silence.
  const strandedTargetEdits = useMemo(
    () => strandedEdits(targetRows, cellText), [targetRows, cellText]);

  // Built from exactly the rows the panel shows, so what he reviews is what
  // gets written (only `generatedAt` is refreshed at save time).
  const targetsManifestErrors = useMemo(() => {
    if (manifestState !== 'ready' || clearTargets) return [];
    return buildBlockManifest({
      providers: liveTargetRows, basis: targetsBasis,
      scheduleLabel, defaultYear: blockStartYear,
    }).errors;
  }, [manifestState, clearTargets, liveTargetRows, targetsBasis, scheduleLabel, blockStartYear]);

  // How many rows would actually be written — only the ones with something
  // stated (blockTargets.statedProviders). Zero means the save stores NOTHING
  // rather than an empty manifest.
  const statedTargetCount = useMemo(
    () => statedProviders(liveTargetRows).written.length, [liveTargetRows]);

  // The whole scenario_manifest decision, single-homed and tested.
  const targetPlan = targetWritePlan({
    manifestState,
    dirty: targetsDirty,
    clearRequested: clearTargets,
    imported: panelRows.imported,
    unreadable: panelRows.unreadable,
    importAcknowledged,
    invalidCellCount: invalidTargetCells.length,
    manifestErrors: targetsManifestErrors,
    statedProviderCount: statedTargetCount,
  });
  const wantsTargetWrite = targetPlan.write !== 'omit';
  const targetsBlocked = targetPlan.blocked !== null;

  const commitTargetRows = (next: PanelRow[]) => {
    const edits: Record<string, PanelRow['linkages']> = {};
    for (const r of next) edits[r.providerId] = r.linkages ?? [];
    setLinkageEdits(edits);
    setClearTargets(false);
  };
  const editCellText = (next: Record<string, string>) => {
    setCellText(next);
    setClearTargets(false);
  };

  const save = async (asDefault: boolean) => {
    setSaving(true); setError(null);
    try {
      // Passing null (not []) is the signal to the server/UI that the
      // default rules should apply. A stored empty array would be
      // indistinguishable from "you deselected everyone" — which is a
      // valid but nonsensical state we don't need to represent.
      const payload: string[] | null = asDefault ? null : Array.from(checked);
      // Limits ride along on BOTH saves (they are keyed to providers, not the
      // pool — resetting to the default pool keeps them; out-of-pool entries
      // render inert but survive). If the limits fetch failed the key is
      // OMITTED so a network blip can never clobber stored limits. It is ALSO
      // omitted for a null→null no-op (nothing stored, nothing entered):
      // pre-patch34 the provider_limits column doesn't exist, and riding a
      // no-op null along would 500 the WHOLE pool save on the missing column
      // (review fix 2026-07-22). Clearing previously-stored limits still
      // sends null (storedLimits non-empty then).
      const body: Record<string, unknown> = { included_provider_ids: payload };
      if (limitsState === 'ready') {
        const limitsPayload = buildLimitsPayload();
        if (limitsPayload !== null || Object.keys(storedLimits).length > 0) {
          body.provider_limits = limitsPayload;
        }
      }
      // Block targets ride along too, but ONLY when he edited them in the tab
      // (or asked to clear them). A manifest steers the whole generation, so a
      // pool-only save must leave a stored one exactly as it was. A failed
      // fetch omits the key for the same reason the limits one does.
      if (targetPlan.write === 'clear') {
        body.scenario_manifest = null;
      } else if (targetPlan.write === 'manifest') {
        const built = buildBlockManifest({
          providers: liveRowsForSelection(asDefault ? defaultSelection : checked),
          basis: targetsBasis,
          scheduleLabel,
          defaultYear: blockStartYear,
        });
        // The plan was computed from the CURRENT selection; "save as default"
        // rebuilds from a different one, which can leave nothing stated. An
        // empty providers[] steers nobody and reads back as unreadable, so
        // store null instead — the same thing targetWritePlan decides when it
        // can see the count.
        body.scenario_manifest = built.providers.length > 0 ? built : null;
      }
      const res = await fetch(`/api/scheduling/schedules/${scheduleId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `Failed (${res.status})`);
        return;
      }
      onSaved(payload);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setSaving(false);
    }
  };

  const totalSelected = checked.size;
  const totalAvailable = providers.length;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12,
          boxShadow: '0 24px 60px rgba(0,0,0,0.5)',
          padding: 24,
          // The targets grid carries up to nine numeric columns plus a name —
          // it cannot be read at the 560 the other two tabs use.
          width: tab === 'targets' ? 'min(940px, 96vw)' : 560,
          maxHeight: '85vh', display: 'flex', flexDirection: 'column',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--text-strong)' }}>Select Pool of Physicians</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
              Auto-Generate will consider only the checked providers.
              Eligibility filters (credentials, availability, weekday) still apply.
            </div>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
            {totalSelected} / {totalAvailable} selected
          </div>
        </div>

        {/* Tabs: Pool (the existing checkbox roster) | Limits (per-provider
            expected call counts + working days / days off for this block) |
            Block Targets (per-provider, per-bucket call targets → the engine's
            scenario manifest). */}
        <div style={{ display: 'flex', gap: 4, marginTop: 8, borderBottom: '1px solid var(--border)' }}>
          {(['pool', 'limits', 'targets'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                padding: '7px 14px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
                background: 'transparent', border: 'none',
                borderBottom: tab === t ? '2px solid #0ea5e9' : '2px solid transparent',
                color: tab === t ? 'var(--text-strong)' : 'var(--text-muted)',
              }}
            >
              {t === 'pool' ? 'Pool' : t === 'limits' ? 'Limits' : 'Block Targets'}
              {t === 'targets' && targetsDirty && (
                <span
                  title="Unsaved block-target changes"
                  style={{
                    display: 'inline-block', width: 6, height: 6, borderRadius: 999,
                    background: '#0ea5e9', marginLeft: 6, verticalAlign: 'middle',
                  }}
                />
              )}
            </button>
          ))}
        </div>

        {tab === 'pool' && (
          <div style={{ display: 'flex', gap: 6, margin: '10px 0 12px' }}>
            <button onClick={resetToDefault} style={smallBtn}>Reset to Default</button>
            <button onClick={clearAll} style={smallBtn}>Clear All</button>
          </div>
        )}
        {tab === 'limits' && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', margin: '10px 0 12px' }}>
            Expected maximums per provider for this block. Blank = no limit (the engine
            keeps its FTE-derived budget — the provider&rsquo;s working-days FTE, or their call
            FTE when they state none). A value here overrides that for this block only.
            Working Days and Days Off are mutually exclusive.
          </div>
        )}
        {tab === 'targets' && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', margin: '10px 0 10px' }}>
            How many of each call each provider owes THIS block. Every cell shows the number
            the engine will get; blank cells are the formula
            (bucket slots ÷ par {parLevel} × FTE, neuro from the site pattern), and you only
            type the ones you are changing.
          </div>
        )}

        {error && (
          <div style={{
            background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)',
            color: '#f87171', padding: '8px 12px', borderRadius: 8, marginBottom: 10, fontSize: 12,
          }}>{error}</div>
        )}

        {tab === 'pool' && (
        <div style={{ flex: 1, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
          {!sitesLoaded ? (
            <div style={{ padding: 20, color: 'var(--text-dim)', fontSize: 13 }}>Loading sites...</div>
          ) : groups.length === 0 ? (
            <div style={{ padding: 20, color: 'var(--text-dim)', fontStyle: 'italic', fontSize: 13 }}>
              No physicians in this organization.
            </div>
          ) : (
            groups.map(group => {
              const groupIds = group.providers.map(p => p.id);
              const allSelected = groupIds.every(id => checked.has(id));
              const someSelected = !allSelected && groupIds.some(id => checked.has(id));
              return (
                <div key={group.siteId} style={{ borderBottom: '1px solid var(--border)' }}>
                  <div
                    style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      padding: '8px 12px', background: 'rgba(14,165,233,0.04)',
                      borderBottom: '1px solid var(--border)',
                    }}
                  >
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={allSelected}
                        ref={el => { if (el) el.indeterminate = someSelected; }}
                        onChange={() => toggleGroup(groupIds)}
                        style={{ accentColor: '#0ea5e9', width: 15, height: 15 }}
                      />
                      <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{group.siteName}</span>
                      {group.siteId === scheduleSiteId && (
                        <span style={{
                          fontSize: 10, fontWeight: 700, color: '#10b981',
                          background: 'rgba(16,185,129,0.12)',
                          padding: '1px 6px', borderRadius: 4, letterSpacing: 0.5,
                        }}>
                          THIS SITE
                        </span>
                      )}
                    </label>
                    <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                      {groupIds.filter(id => checked.has(id)).length} / {groupIds.length}
                    </span>
                  </div>
                  {group.providers.map(p => {
                    const prof = profiles.find(x => x.provider_id === p.id);
                    const callLabel = prof?.call_taker ? 'Call'
                      : prof?.partial_call_taker ? 'Partial'
                      : 'Day Doc';
                    const callColor = prof?.call_taker ? '#10b981'
                      : prof?.partial_call_taker ? '#fbbf24'
                      : '#94a3b8';
                    return (
                      <label key={p.id} style={{
                        display: 'flex', alignItems: 'center', gap: 10,
                        padding: '8px 12px 8px 34px', cursor: 'pointer', borderRadius: 8,
                      }}>
                        <input
                          type="checkbox"
                          checked={checked.has(p.id)}
                          onChange={() => toggle(p.id)}
                          style={{ accentColor: '#0ea5e9', width: 14, height: 14 }}
                        />
                        <span style={{ fontSize: 13, color: 'var(--text)', flex: 1 }}>
                          {p.first_name} {p.last_name}
                        </span>
                        <span style={{
                          fontSize: 10, fontWeight: 700, color: callColor,
                          background: `${callColor}15`, padding: '1px 6px', borderRadius: 4,
                          letterSpacing: 0.5, whiteSpace: 'nowrap',
                        }}>
                          {callLabel}
                        </span>
                      </label>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>
        )}

        {/* ── Limits tab: one row per provider in the current pool selection
            (default pool = the home-site roster when no custom pool is set);
            providers with stored limits no longer in the pool render inert
            below — their data is kept, never silently dropped. ── */}
        {tab === 'limits' && (
        <div style={{ flex: 1, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
          {limitsState === 'loading' ? (
            <div style={{ padding: 20, color: 'var(--text-dim)', fontSize: 13 }}>Loading limits...</div>
          ) : limitsState === 'failed' ? (
            <div style={{ padding: 20, color: '#f87171', fontSize: 13 }}>
              Could not load the stored limits — saving will leave them untouched.
              Close and reopen to retry.
            </div>
          ) : (() => {
            const inPool = providers
              .filter(p => checked.has(p.id))
              .sort((a, b) => a.last_name.localeCompare(b.last_name));
            const outOfPool = Object.keys(storedLimits)
              .filter(pid => !checked.has(pid))
              .map(pid => providers.find(p => p.id === pid)
                ?? ({ id: pid, first_name: '(unknown', last_name: 'provider)' } as Provider))
              .sort((a, b) => a.last_name.localeCompare(b.last_name));
            const COLS: Array<{ field: keyof LimitFields; label: string }> = [
              { field: 'c1', label: 'C1 max' },
              { field: 'c2', label: 'C2 max' },
              { field: 'c3', label: 'C3 max' },
              { field: 'workingDays', label: 'Working Days' },
              { field: 'daysOff', label: 'Days Off' },
            ];
            const limitRow = (p: Provider, inert: boolean) => {
              const fields = limitDrafts[p.id] ?? EMPTY_LIMIT_FIELDS;
              return (
                <div key={p.id} style={{
                  display: 'grid', gridTemplateColumns: '1fr repeat(5, 74px)',
                  gap: 6, alignItems: 'center', padding: '5px 12px',
                  borderBottom: '1px solid var(--border)',
                  opacity: inert ? 0.55 : 1,
                }}>
                  <span style={{ fontSize: 13, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {p.first_name} {p.last_name}
                    {inert && (
                      <span style={{
                        fontSize: 9, fontWeight: 800, marginLeft: 6, padding: '1px 5px',
                        borderRadius: 4, background: 'rgba(100,116,139,0.22)', color: 'var(--text-dim)',
                        textTransform: 'uppercase', letterSpacing: 0.5,
                      }}>not in pool</span>
                    )}
                  </span>
                  {COLS.map(({ field }) => {
                    // Mutual exclusion: the sibling day field is disabled while
                    // this one holds a value.
                    const exclusiveOff =
                      (field === 'daysOff' && fields.workingDays.trim() !== '') ||
                      (field === 'workingDays' && fields.daysOff.trim() !== '');
                    const invalid = isInvalidLimitInput(fields[field]);
                    return (
                      <input
                        key={field}
                        type="text"
                        inputMode="numeric"
                        value={fields[field]}
                        placeholder="—"
                        disabled={inert || exclusiveOff}
                        onChange={e => setLimitField(p.id, field, e.target.value)}
                        title={exclusiveOff ? 'Working Days and Days Off are mutually exclusive' : undefined}
                        style={{
                          width: '100%', padding: '4px 6px', fontSize: 12.5, textAlign: 'center',
                          borderRadius: 6,
                          border: invalid ? '1px solid #f87171' : '1px solid var(--border)',
                          background: (inert || exclusiveOff) ? 'rgba(100,116,139,0.10)' : 'var(--bg-surface)',
                          color: invalid ? '#f87171' : 'var(--text)',
                        }}
                      />
                    );
                  })}
                </div>
              );
            };
            return (
              <div>
                <div style={{
                  display: 'grid', gridTemplateColumns: '1fr repeat(5, 74px)', gap: 6,
                  padding: '7px 12px', borderBottom: '1px solid var(--border)',
                  background: 'rgba(14,165,233,0.04)', position: 'sticky', top: 0,
                }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)' }}>Provider</span>
                  {COLS.map(c => (
                    <span key={c.field} style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textAlign: 'center' }}>{c.label}</span>
                  ))}
                </div>
                {inPool.length === 0 ? (
                  <div style={{ padding: 20, color: 'var(--text-dim)', fontStyle: 'italic', fontSize: 13 }}>
                    No providers in the current pool selection.
                  </div>
                ) : inPool.map(p => limitRow(p, false))}
                {outOfPool.length > 0 && (
                  <div style={{ padding: '7px 12px 3px', fontSize: 11, fontWeight: 700, color: 'var(--text-dim)' }}>
                    Stored limits for providers not in the pool (kept, not applied to generation):
                  </div>
                )}
                {outOfPool.map(p => limitRow(p, true))}
              </div>
            );
          })()}
        </div>
        )}

        {/* ── Block Targets tab: per-provider, per-bucket call targets for
            THIS block, written to schedules.scenario_manifest. Blank = the
            house formula; an either-or linkage owns the buckets it covers. ── */}
        {tab === 'targets' && (
          <BlockTargetsTab
            liveRows={liveTargetRows}
            rows={targetRows}
            basis={targetsBasis}
            cellText={cellText}
            setCellText={editCellText}
            commitRows={commitTargetRows}
            state={manifestState}
            imported={panelRows.imported}
            importAcknowledged={importAcknowledged}
            setImportAcknowledged={setImportAcknowledged}
            droppedUnidentified={panelRows.droppedUnidentified}
            unreadable={panelRows.unreadable}
            stranded={strandedTargetEdits}
            hasStoredManifest={panelRows.hasStoredManifest}
            dirty={targetsDirty}
            clearRequested={clearTargets}
            onClearAll={() => setClearTargets(true)}
            onCancelClear={() => setClearTargets(false)}
            manifestErrors={targetsManifestErrors}
          />
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14, gap: 8 }}>
          <button
            onClick={() => save(true)}
            disabled={saving || hasInvalidLimit || targetsBlocked}
            style={{
              ...smallBtn,
              opacity: (saving || hasInvalidLimit || targetsBlocked) ? 0.5 : 1,
              cursor: (saving || hasInvalidLimit || targetsBlocked) ? 'not-allowed' : 'pointer',
            }}
            title="Revert to the default rule-based pool (home-site call-takers / day docs). Limits are kept."
          >
            Use Default Pool
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onClose} style={smallBtn}>
              Cancel
            </button>
            <button
              onClick={() => save(false)}
              disabled={saving || totalSelected === 0 || hasInvalidLimit || targetsBlocked}
              title={
                hasInvalidLimit ? 'Fix the highlighted limit values (whole numbers ≥ 0)'
                : targetPlan.blocked ?? undefined}
              style={{
                padding: '7px 16px', fontSize: 12.5, fontWeight: 700, border: 'none', borderRadius: 8,
                background: 'linear-gradient(135deg,#0ea5e9,#6366f1)',
                color: '#fff', boxShadow: '0 4px 14px rgba(56,130,246,0.35)',
                opacity: (saving || totalSelected === 0 || hasInvalidLimit || targetsBlocked) ? 0.5 : 1,
                cursor: (saving || totalSelected === 0 || hasInvalidLimit || targetsBlocked) ? 'not-allowed' : 'pointer',
              }}
            >
              {saving
                ? 'Saving...'
                : wantsTargetWrite
                  ? `Save Pool + Targets (${totalSelected})`
                  : `Save Pool (${totalSelected})`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const smallBtn: React.CSSProperties = {
  padding: '7px 15px', fontSize: 12.5, fontWeight: 700, borderRadius: 8,
  background: 'transparent', color: 'var(--text-muted)',
  border: '1px solid var(--border)', cursor: 'pointer',
};

function CallCountsModal(
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

  // Types that count as "PTO days" in the tally column. Sick / jury_duty
  // are intentionally excluded — that's unplanned or administrative, not
  // vacation. Only the planned-leave types accrue here.
  const PTO_TYPES = new Set(['pto', 'fmla', 'parental_leave', 'military_leave']);

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

  // PTO-days tally — approved planned-leave days overlapping the schedule
  // window, counted Mon-Fri only (weekends don't consume PTO).
  const scheduleStart = grid.schedule.date_start;
  const scheduleEnd = grid.schedule.date_end;
  const ptoDaysByPid: Record<string, number> = {};
  for (const a of grid.availability || []) {
    if (a.approval_status !== 'approved') continue;
    if (!PTO_TYPES.has(a.availability_type)) continue;
    // Clamp to schedule range. A PTO block that straddles the schedule
    // boundary only counts the portion inside this schedule's window.
    const start = a.start_date < scheduleStart ? scheduleStart : a.start_date;
    const end = a.end_date > scheduleEnd ? scheduleEnd : a.end_date;
    if (start > end) continue;
    let d = new Date(start + 'T12:00:00Z');
    const endD = new Date(end + 'T12:00:00Z');
    while (d.getTime() <= endD.getTime()) {
      const dow = d.getUTCDay();
      if (dow >= 1 && dow <= 5) {
        ptoDaysByPid[a.provider_id] = (ptoDaysByPid[a.provider_id] || 0) + 1;
      }
      d.setUTCDate(d.getUTCDate() + 1);
    }
  }

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

  const ptoDaysForPid = (pid: string) => ptoDaysByPid[pid] || 0;

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
  const rowObligation = (pid: string) => roundedObligation(rowExpected(pid));
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

/* ── Available Call List ─────────────────────────────────────────────────────
 * Gabriel: "I want you to create an 'Available Call List' that lists the
 * day/date/type of call so that I know which calls i need to list up for
 * grabs". Every unfilled call slot in the block — the same slots the grid now
 * paints red, from the same predicate.
 *
 * SHAPE. A chronological worklist, because that is how it gets posted and
 * worked down, grouped BY WEEKEND: one cluster per Fri/Sat/Sun, one per
 * Mon–Thu date. A whole weekend standing open is one conversation with the
 * group; four scattered Tuesdays are four. Above them sits the count he prices
 * from: the per-DAY-TYPE breakdown (the engine's own fairness buckets, so a
 * holiday-dated call is counted under the day of the week it lands on) and the
 * per-CODE tally.
 *
 * OUTPUT. Print follows the Call Counts precedent exactly — a scoped
 * @media print block that hides everything outside the print area and pins
 * black-on-white — but PORTRAIT, since this is a narrow list rather than a
 * 27-column table. Copy puts the same document on the clipboard as plain text
 * (formatAvailableCallText), because posting it is a paste into an email or a
 * text thread, not a PDF attachment.
 *
 * This component RENDERS ONLY. Membership, ordering, bucketing, clustering and
 * the text form are all in lib/availableCalls.ts with its test — vitest runs
 * with no jsdom, so no rule may live here.
 * ───────────────────────────────────────────────────────────────────────── */
function AvailableCallsModal({
  list,
  title,
  onClose,
}: {
  list: ReturnType<typeof buildAvailableCallList>;
  title: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(formatAvailableCallText(list, title));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard denied (insecure context / permission). The list is still on
      // screen and selectable, and Print / Save PDF is right there — silently
      // doing nothing is the honest outcome, but say so rather than pretend.
      setCopied(false);
      alert('Could not reach the clipboard. Select the list and copy it, or use Print / Save PDF.');
    }
  };

  const summary = bucketSummaryText(list);

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
          padding: 20, maxWidth: '95vw', maxHeight: '90vh', overflow: 'auto', minWidth: 560,
        }}
      >
        {/* Scoped print stylesheet — the Call Counts pattern (everything
            outside the print area hidden, the area pinned to the page box,
            black on white because browsers drop background colour when
            printing). PORTRAIT: this is a four-column list, not a wide table,
            and it is meant to be handed round on paper. */}
        <style>{`
          @media print {
            @page { size: portrait; margin: 0.5in; }
            body * { visibility: hidden !important; }
            #available-call-print, #available-call-print * { visibility: visible !important; }
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
            #available-call-print {
              position: absolute !important; inset: auto !important;
              left: 0 !important; top: 0 !important; width: 100% !important;
              background: #fff !important; color: #000 !important;
              padding: 0 !important; overflow: visible !important;
              max-height: none !important; max-width: none !important;
              min-width: 0 !important; border: none !important;
            }
            #available-call-print table, #available-call-print th, #available-call-print td {
              color: #000 !important; border-color: #666 !important;
              background: #fff !important;
            }
            #available-call-print table { font-size: 9pt !important; width: 100% !important; }
            #available-call-print th, #available-call-print td { padding: 2px 4px !important; }
            /* A cluster must never be split across a page break — a weekend
               that lands half on page 1 and half on page 2 reads as two
               separate offers. */
            #available-call-print .ac-cluster { break-inside: avoid; page-break-inside: avoid; }
            /* The grid's "already posted" mark is a coloured dot, which print
               drops; the list spells the word instead, so the paper copy says
               which calls are already out with the group. */
            #available-call-print .no-print { display: none !important; }
          }
        `}</style>

        <div id="available-call-print">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14, gap: 16 }}>
            <div>
              <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--text)' }}>Available Call</div>
              <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 2 }}>
                {title} — every unfilled call slot, to list up for grabs.
              </div>
              {list.total > 0 && (
                <>
                  <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 6, fontWeight: 700 }}>
                    {list.total} open call slot{list.total === 1 ? '' : 's'}
                    {list.postedCount > 0 && ` — ${list.postedCount} already posted`}
                    {summary && <> · {summary}</>}
                  </div>
                  {list.byCode.length > 0 && (
                    <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 3 }}>
                      {list.byCode.map(c => `${c.code} ${c.count}`).join(' · ')}
                    </div>
                  )}
                </>
              )}
            </div>
            <div className="no-print" style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              {list.total > 0 && (
                <button onClick={handleCopy} style={{
                  padding: '7px 15px', fontSize: 12.5, fontWeight: 700, borderRadius: 8, cursor: 'pointer',
                  background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)',
                }}>{copied ? 'Copied ✓' : 'Copy'}</button>
              )}
              {list.total > 0 && (
                <button onClick={() => window.print()} style={{
                  padding: '7px 16px', fontSize: 12.5, fontWeight: 700, border: 'none', borderRadius: 8, cursor: 'pointer',
                  background: 'linear-gradient(135deg,#0ea5e9,#6366f1)', color: '#fff', boxShadow: '0 4px 14px rgba(56,130,246,0.35)',
                }}>Print / Save PDF</button>
              )}
              <button onClick={onClose} style={{
                padding: '7px 15px', fontSize: 12.5, fontWeight: 700, borderRadius: 8, cursor: 'pointer',
                background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)',
              }}>Close</button>
            </div>
          </div>

          {list.total === 0 ? (
            <div style={{
              padding: '22px 16px', textAlign: 'center', fontSize: 13, fontWeight: 600,
              color: 'var(--text-dim)', border: '1px dashed var(--border)', borderRadius: 8,
            }}>
              No unfilled call slots — every call in this block is covered.
            </div>
          ) : (
            list.clusters.map(cluster => (
              <div key={cluster.key} className="ac-cluster" style={{ marginBottom: 14 }}>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4,
                  paddingBottom: 3, borderBottom: '1px solid var(--border)',
                }}>
                  <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--text)' }}>{cluster.label}</span>
                  <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-dim)' }}>
                    {cluster.rows.length} open
                  </span>
                  {/* The one annotation that changes what this cluster IS: a
                      whole Fri/Sat/Sun standing open is a different offer from
                      three unrelated days that happen to be adjacent. */}
                  {cluster.wholeWeekend && (
                    <span style={{
                      fontSize: 9.5, fontWeight: 800, letterSpacing: '0.06em',
                      padding: '1px 6px', borderRadius: 999,
                      color: gridTokens.openCall,
                      border: `1px solid ${gridTokens.openCall}`,
                    }}>WHOLE WEEKEND</span>
                  )}
                </div>
                <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12.5 }}>
                  <tbody>
                    {cluster.rows.map(row => (
                      <tr key={row.slotId}>
                        <td style={{ padding: '3px 8px 3px 0', width: 34, fontWeight: 700, color: 'var(--text-muted)' }}>
                          {row.dayName}
                        </td>
                        <td style={{ padding: '3px 10px 3px 0', width: 54, color: 'var(--text-muted)' }}>
                          {row.dateShort}
                        </td>
                        <td style={{ padding: '3px 10px 3px 0', width: 62, fontWeight: 800, color: 'var(--text)' }}>
                          {row.code}
                        </td>
                        <td style={{ padding: '3px 0', color: 'var(--text-dim)' }}>
                          {row.name}
                          {row.holidayName && (
                            <span style={{ marginLeft: 6, fontWeight: 700, color: '#b45309' }}>
                              ({row.holidayName})
                            </span>
                          )}
                          {row.locked && <span style={{ marginLeft: 6 }} title="Locked slot">&#x1F512;</span>}
                        </td>
                        <td style={{ padding: '3px 0', width: 68, textAlign: 'right' }}>
                          {row.posted && (
                            <span
                              title="Already posted to the group for pickup."
                              style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-dim)' }}
                            >posted</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Calendar (month grid) View ──────────────────────────────────────────── */

interface CalendarWorker {
  assignmentId: string;
  providerId: string;
  last_name: string;
  initials: string;
  shortName: string;
  shiftCode: string;
  color: string;
  providerType: string;
  countsTowardCount: boolean;
  // Hand-set billing mark (patch42) carried through so the calendar lens shows
  // the same marks the month/week grid does. A mark that vanished when the
  // user switched view mode would read as data loss.
  highlight: HighlightColor | null;
}

function CalendarView({
  allDates,
  monthOffset,
  onPrevMonth,
  onNextMonth,
  mdCountByDate,
  crnaCountByDate,
  workingByDate,
  overParAssignmentIds,
  holidayMap,
  todayStr,
}: {
  allDates: string[];
  monthOffset: number;
  onPrevMonth: () => void;
  onNextMonth: () => void;
  mdCountByDate: Record<string, number>;
  crnaCountByDate: Record<string, number>;
  workingByDate: Record<string, CalendarWorker[]>;
  overParAssignmentIds: Set<string>;
  holidayMap: Record<string, Holiday>;
  todayStr: string;
}) {
  // overParAssignmentIds is consumed in the working-list rendering below.
  // Build the list of (year, month) pairs the schedule touches so prev/next
  // never strays outside the block. Hooks must run unconditionally — guard
  // with early-return AFTER all hook calls.
  const monthsTouched = useMemoMonths(allDates);

  if (allDates.length === 0 || monthsTouched.length === 0) {
    return <div style={{ padding: 40, color: 'var(--text-muted)' }}>No dates in this schedule.</div>;
  }

  const idx = Math.max(0, Math.min(monthOffset, monthsTouched.length - 1));
  const { year, month } = monthsTouched[idx];
  const hasPrev = idx > 0;
  const hasNext = idx < monthsTouched.length - 1;

  const inScheduleSet = new Set(allDates);

  // First Sunday on or before the 1st of the month → start of grid.
  const firstOfMonth = new Date(Date.UTC(year, month, 1));
  const firstDow = firstOfMonth.getUTCDay();
  const gridStart = new Date(firstOfMonth);
  gridStart.setUTCDate(firstOfMonth.getUTCDate() - firstDow);

  // 6 rows × 7 cols = 42 cells, enough for any month layout.
  const cells: Array<{ dateStr: string; inMonth: boolean; inSchedule: boolean }> = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setUTCDate(gridStart.getUTCDate() + i);
    const ds = d.toISOString().slice(0, 10);
    cells.push({
      dateStr: ds,
      inMonth: d.getUTCMonth() === month && d.getUTCFullYear() === year,
      inSchedule: inScheduleSet.has(ds),
    });
  }
  // Trim trailing all-out-of-month row if unused for a tighter layout.
  const lastRowUsed = cells.slice(35, 42).some(c => c.inMonth);
  const visibleCells = lastRowUsed ? cells : cells.slice(0, 35);

  const monthName = firstOfMonth.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });

  return (
    <div style={{
      flex: 1, overflow: 'auto', borderRadius: 8,
      border: '1px solid var(--border)',
      background: 'var(--bg-surface)', display: 'flex', flexDirection: 'column',
    }}>
      {/* Month nav bar */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 16px', borderBottom: '1px solid var(--border)',
        background: '#0d1b30', color: '#e2e8f0',
      }}>
        <button
          onClick={onPrevMonth}
          disabled={!hasPrev}
          style={{
            width: 30, height: 30, borderRadius: 8, border: '1px solid var(--border)',
            background: 'transparent', color: hasPrev ? 'var(--text-muted)' : '#334155',
            cursor: hasPrev ? 'pointer' : 'not-allowed',
            fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          &#8592;
        </button>
        <div style={{ fontSize: 16, fontWeight: 800, letterSpacing: '0.02em' }}>
          {monthName} {year}
        </div>
        <button
          onClick={onNextMonth}
          disabled={!hasNext}
          style={{
            width: 30, height: 30, borderRadius: 8, border: '1px solid var(--border)',
            background: 'transparent', color: hasNext ? 'var(--text-muted)' : '#334155',
            cursor: hasNext ? 'pointer' : 'not-allowed',
            fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          &#8594;
        </button>
      </div>

      {/* Weekday header */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)',
        background: gridTokens.chrome, borderBottom: '1px solid ' + gridTokens.chromeBorder,
      }}>
        {DAYS_SHORT.map((d, i) => {
          const isWeekend = i === 0 || i === 6;
          return (
            <div key={d} style={{
              padding: '8px 4px', textAlign: 'center', fontSize: 11, fontWeight: 700,
              color: isWeekend ? '#cbd5e1' : gridTokens.chromeMuted,
              textTransform: 'uppercase', letterSpacing: '0.05em',
              borderRight: i < 6 ? '1px solid ' + gridTokens.chromeBorder : 'none',
            }}>
              {d}
            </div>
          );
        })}
      </div>

      {/* Month grid */}
      <div style={{
        flex: 1, display: 'grid',
        gridTemplateColumns: 'repeat(7, 1fr)',
        gridAutoRows: 'minmax(112px, 1fr)',
      }}>
        {visibleCells.map((cell) => {
          const date = cell.dateStr;
          const dow = getDayOfWeek(date);
          const isWeekend = dow === 0 || dow === 6;
          const holiday = holidayMap[date];
          const isToday = date === todayStr;
          const workers = cell.inSchedule ? (workingByDate[date] || []) : [];
          const mdCount = cell.inSchedule ? (mdCountByDate[date] ?? 0) : 0;
          const crnaCount = cell.inSchedule ? (crnaCountByDate[date] ?? 0) : 0;
          const dayNum = parseDate(date).getDate();

          const cellBg = !cell.inMonth
            ? 'rgba(15,23,42,0.4)'
            : holiday
              ? gridTokens.bodyHoliday
              : isWeekend
                ? gridTokens.bodyWeekend
                : gridTokens.bodyCell;

          return (
            <div key={date} style={{
              padding: 6,
              borderRight: '1px solid var(--border)',
              borderBottom: '1px solid var(--border)',
              background: cellBg,
              opacity: !cell.inMonth ? 0.4 : !cell.inSchedule ? 0.55 : 1,
              display: 'flex', flexDirection: 'column', gap: 4,
              overflow: 'hidden',
              outline: isToday ? ('2px solid ' + gridTokens.accentStrong) : 'none',
              outlineOffset: -2,
            }}>
              {/* Day number + holiday tag + counts */}
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 4 }}>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <span style={{
                    fontSize: 12.5, fontWeight: 700,
                    color: isToday ? '#0ea5e9' : holiday ? '#fbbf24' : 'var(--text)',
                  }}>
                    {dayNum}
                  </span>
                  {holiday && (
                    <span style={{
                      fontSize: 9, color: '#fbbf24', fontWeight: 500,
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                      maxWidth: 120,
                    }} title={holiday.holiday_name}>
                      {holiday.holiday_name}
                    </span>
                  )}
                </div>
                {cell.inSchedule && (mdCount > 0 || crnaCount > 0) && (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 1 }}>
                    <span title="MDs working (weekday C1 excluded)" style={{
                      fontSize: 10, fontWeight: 800,
                      color: '#0ea5e9',
                      background: 'rgba(14,165,233,0.12)',
                      padding: '1px 6px', borderRadius: 999,
                      fontFamily: 'var(--font-mono), ui-monospace, monospace',
                    }}>
                      {mdCount} MD
                    </span>
                    {crnaCount > 0 && (
                      <span title="CRNAs working" style={{
                        fontSize: 9, fontWeight: 700,
                        color: '#94a3b8',
                        fontFamily: 'var(--font-mono), ui-monospace, monospace',
                      }}>
                        {crnaCount} CRNA
                      </span>
                    )}
                  </div>
                )}
              </div>

              {/* Working list — last name preferred, fallback to initials,
                  then short_display_name if both blank. */}
              {workers.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 1, overflow: 'hidden' }}>
                  {workers.map((w, wi) => {
                    const display = (w.last_name && w.last_name.trim())
                      || (w.initials && w.initials.trim())
                      || w.shortName;
                    const isOverPar = overParAssignmentIds.has(w.assignmentId);
                    // Manual mark out-ranks the over-par wash here for the same
                    // reason it does in the grid: over-par is computed, this is
                    // hand-set. The chip keeps the inset ring so the two reds
                    // stay tellable apart at a glance.
                    const marked = w.highlight;
                    return (
                      <div
                        key={wi}
                        title={
                          (marked ? manualHighlightTitle(marked) + ' ' : '') +
                          (isOverPar ? 'Past rounded call obligation — one of their extra calls. ' : '') +
                          `${w.shortName} · ${w.shiftCode}`
                        }
                        style={{
                          display: 'flex', alignItems: 'center', gap: 4,
                          fontSize: 10, lineHeight: 1.25,
                          color: 'var(--text)',
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                          background: marked
                            ? gridTokens.manualHighlight[marked]
                            : isOverPar ? gridTokens.overPar : 'transparent',
                          boxShadow: marked ? gridTokens.manualHighlightOutline : undefined,
                          borderRadius: 3,
                          padding: (marked || isOverPar) ? '0 2px' : 0,
                        }}
                      >
                        <span style={{
                          flexShrink: 0, fontSize: 8, fontWeight: 700,
                          padding: '1px 4px', borderRadius: 3,
                          background: colorWithAlpha(w.color, 0.18),
                          color: w.color,
                          letterSpacing: '0.02em',
                          fontFamily: 'var(--font-mono), ui-monospace, monospace',
                        }}>
                          {w.shiftCode}
                        </span>
                        <span style={{
                          fontWeight: w.providerType === 'physician' ? 600 : 500,
                          overflow: 'hidden', textOverflow: 'ellipsis',
                          color: isOverPar ? '#ef4444' : 'var(--text)',
                        }}>
                          {display}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Walks the schedule date list and returns one entry per (year, month) the
// schedule touches. Order = chronological. Drives the calendar's prev/next
// nav so navigation never strays outside the block.
function useMemoMonths(allDates: string[]): Array<{ year: number; month: number }> {
  return useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ year: number; month: number }> = [];
    for (const d of allDates) {
      const dt = parseDate(d);
      const key = `${dt.getFullYear()}-${dt.getMonth()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ year: dt.getFullYear(), month: dt.getMonth() });
    }
    return out;
  }, [allDates]);
}

/* ── Call spacing review (Gabriel 2026-07-31) ──────────────────────────────
 * "identify providers with C1 calls that are spaced too close together and
 * options to swap with them other call takers that are available."
 *
 * The arithmetic is lib/callSpacing.ts; eligibility is the PICKER's own
 * decision (slotCandidates) so a suggestion here can never offer someone the
 * cell picker would refuse. This component only renders and dispatches.
 */
function SpacingModal({
  grid, code, maxGap, setMaxGap, review, candidateIndex, onClose, onSwap,
}: {
  grid: GridData;
  code: string;
  maxGap: number;
  setMaxGap: (n: number) => void;
  review: ReturnType<typeof reviewTightPairs>;
  candidateIndex: ReturnType<typeof buildCandidateIndex> | null;
  onClose: () => void;
  onSwap: (slotId: string, providerId: string) => void;
}) {
  const [openPair, setOpenPair] = useState<string | null>(null);
  const nameOf = (pid: string) =>
    grid.providers.find(p => p.id === pid)?.short_display_name ?? pid;
  const held = useMemo(() => callsByProvider(grid.slots, code), [grid, code]);
  // Distribution up to a week, so the threshold is chosen from the board.
  const histogram = useMemo(() => gapHistogram(grid.slots, code, 7), [grid, code]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 800,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--bg-deep)', borderRadius: 12, border: '1px solid var(--border)',
          boxShadow: '0 24px 60px rgba(0,0,0,0.5)', padding: 20,
          maxWidth: 780, width: '100%', maxHeight: '85vh', overflow: 'auto',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--text)' }}>
            {code} spacing
          </div>
          <div style={{ marginLeft: 'auto' }}>
            <button onClick={onClose} style={smallBtn}>Close</button>
          </div>
        </div>

        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
          Consecutive {code} calls held by the same provider, {maxGap} days apart or less.
          Only a <strong style={{ color: 'var(--text)' }}>weekday</strong> {code} can be moved:
          every Fri/Sat/Sun {code} is chain-locked by the pattern (a Friday {code} anchors the
          Sunday C2; the weekend {code}s ride the weekend block chains), so those ends are shown
          for context but never offered. Different codes are never paired — a Saturday C2 into a
          Sunday C1 is one day apart by design.
          <div style={{ marginTop: 6 }}>
            Whole block:{' '}
            {[...histogram].sort((a, b) => a[0] - b[0])
              .map(([gap, n]) => `${n} at ${gap}d`).join(' · ') || 'nothing under 8 days'}
            {review.excludedChainLocked > 0 && (
              <> · {review.excludedChainLocked} weekend-to-weekend pair
                {review.excludedChainLocked === 1 ? '' : 's'} not listed (both ends chain-locked)</>
            )}
          </div>
        </div>

        <label style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-muted)' }}>
          Flag gaps of{' '}
          <select
            value={maxGap}
            onChange={e => setMaxGap(Number(e.target.value))}
            style={{
              padding: '4px 8px', borderRadius: 6, fontWeight: 700,
              background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)',
            }}
          >
            {[2, 3, 4, 5, 6, 7].map(n => <option key={n} value={n}>{n} days</option>)}
          </select>{' '}
          or less
        </label>

        {review.pairs.length === 0 ? (
          <div style={{ marginTop: 16, fontSize: 13, color: 'var(--text-muted)' }}>
            No {code} calls are within {maxGap} days of each other.
          </div>
        ) : (
          <div style={{ marginTop: 14 }}>
            {review.pairs.map(pair => {
              const key = `${pair.providerId}|${pair.earlier.slotId}|${pair.later.slotId}`;
              const isOpen = openPair === key;
              return (
                <div key={key} style={{ borderTop: '1px solid var(--border)', padding: '10px 0' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <span style={{
                      fontWeight: 800,
                      color: pair.gap <= 2 ? gridTokens.openCall : 'var(--text)',
                      minWidth: 44,
                    }}>
                      {pair.gap}d
                    </span>
                    <span style={{ fontWeight: 700, color: 'var(--text)' }}>{nameOf(pair.providerId)}</span>
                    <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
                      {formatMMDD(pair.earlier.date)} {pair.earlier.code}
                      {'  →  '}
                      {formatMMDD(pair.later.date)} {pair.later.code}
                    </span>
                    <button
                      onClick={() => setOpenPair(isOpen ? null : key)}
                      style={{ ...smallBtn, marginLeft: 'auto', padding: '4px 10px' }}
                    >
                      {isOpen
                        ? 'Hide'
                        : `Swap ${pair.swappable.map(c => formatMMDD(c.date)).join(' or ')}`}
                    </button>
                  </div>

                  {isOpen && (
                    <div style={{ marginTop: 8, paddingLeft: 54 }}>
                      {!candidateIndex ? (
                        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                          Eligibility unavailable — reload the grid.
                        </div>
                      ) : pair.swappable.map(target => {
                        const groups = candidatesForSlot(candidateIndex, target.slotId);
                        const eligible = groups.available.map(c => c.provider.id)
                          .filter(pid => pid !== pair.providerId);
                        const ranked = rankSwapCandidates(eligible, held, target.date, pair.gap);
                        return (
                          <div key={target.slotId} style={{ marginBottom: 10 }}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 3 }}>
                              Move {formatMMDD(target.date)} {target.code} to:
                            </div>
                            {ranked.length === 0 ? (
                              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                                Nobody else is available.
                                {groups.blocked.length > 0
                                  && ` ${groups.blocked.length} provider(s) blocked — the cell picker says why.`}
                              </div>
                            ) : (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                {ranked.map(c => (
                                  <div key={c.providerId}
                                    style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5 }}>
                                    <span style={{ fontWeight: 700, color: 'var(--text)', minWidth: 110 }}>
                                      {nameOf(c.providerId)}
                                    </span>
                                    <span style={{ color: c.improves ? 'var(--ok)' : gridTokens.openCall }}>
                                      {Number.isFinite(c.resultingGap)
                                        ? `would sit ${c.resultingGap}d from their nearest ${code}`
                                        : `has no other ${code}`}
                                      {c.improves ? '' : ' — no better'}
                                    </span>
                                    <button
                                      onClick={() => { onSwap(target.slotId, c.providerId); onClose(); }}
                                      style={{ ...smallBtn, marginLeft: 'auto', padding: '3px 10px' }}
                                    >
                                      Give it to them
                                    </button>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── D-assignment audit (Gabriel 2026-08-02) ───────────────────────────────
 * "re-check all the placements for correct D assignments after I make
 * switches to peoples call." The arithmetic is lib/dAssignmentAudit.ts; this
 * lists what it found and dispatches the batch apply.
 */
function DAuditModal({
  grid, audit, applying, onApply, onClose,
}: {
  grid: GridData;
  audit: ReturnType<typeof auditDAssignments>;
  applying: boolean;
  onApply: (placements: Array<{ slotId: string; providerId: string | null }>) => void;
  onClose: () => void;
}) {
  // DELETED findings (Gabriel 2026-08-02: "hit delete if theres a reason for
  // it"). Kept for THIS review only, deliberately not persisted: a dismissal
  // that outlived the session would silently suppress a finding that has since
  // become a real problem. Restore puts them all back, so a mis-click costs
  // nothing.
  const [deleted, setDeleted] = useState<Set<string>>(new Set());
  const kept = audit.findings.filter(f => !deleted.has(f.key));
  const keptPlacements = placementsFor(kept);

  const nameOf = (pid: string) =>
    grid.providers.find(p => p.id === pid)?.short_display_name ?? pid;
  const KIND_LABEL: Record<string, string> = {
    'wrong-sequence-code': 'Wrong D',
    'missing-sequence-code': 'Missing D',
    'ladder-order': 'Relief order',
  };
  // Ladder details name providers by id; swap in display names for reading.
  const readable = (f: (typeof audit.findings)[number]) =>
    f.kind === 'ladder-order'
      ? f.detail.replace(/[0-9a-zA-Z-]{6,}/g, m =>
          grid.providers.some(p => p.id === m) ? nameOf(m) : m)
      : f.detail;

  return (
    <div
      className="fr-print-overlay"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 800,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}
    >
      <div
        className="fr-print-panel"
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--bg-deep)', borderRadius: 12, border: '1px solid var(--border)',
          boxShadow: '0 24px 60px rgba(0,0,0,0.5)', padding: 20,
          maxWidth: 860, width: '100%', maxHeight: '85vh', overflow: 'auto',
        }}
      >
        {/* Scoped print stylesheet — same device the Call Counts modal uses:
            everything outside the print area is hidden so Save-as-PDF captures
            just the worklist. Portrait: this is a narrow table. */}
        <style>{`
          @media print {
            @page { size: portrait; margin: 0.5in; }
            body * { visibility: hidden !important; }
            #d-audit-print, #d-audit-print * { visibility: visible !important; }
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
            #d-audit-print {
              position: absolute !important; inset: auto !important;
              left: 0 !important; top: 0 !important; width: 100% !important;
              background: #fff !important; color: #000 !important;
              padding: 0 !important; overflow: visible !important;
              max-height: none !important; max-width: none !important;
              border: none !important; box-shadow: none !important;
            }
            #d-audit-print .no-print { display: none !important; }
            #d-audit-print table { width: 100% !important; border-collapse: collapse; }
            #d-audit-print td, #d-audit-print th {
              color: #000 !important; border-bottom: 1px solid #ccc !important;
              padding: 4px 6px !important; font-size: 11px !important;
            }
          }
        `}</style>

        <div id="d-audit-print">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--text)' }}>
              D assignments — {grid.schedule.schedule_name}
            </div>
            <div className="no-print" style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              <button onClick={() => window.print()} style={smallBtn}>Print</button>
              {keptPlacements.length > 0 && (
                <button onClick={() => onApply(keptPlacements)} disabled={applying} style={{
                  ...smallBtn, fontWeight: 800,
                  background: 'var(--ok-bg)', color: 'var(--ok)',
                  border: '1px solid color-mix(in srgb, var(--ok) 40%, transparent)',
                }}>
                  {applying ? 'Applying…' : `Fix all (${keptPlacements.length} cells)`}
                </button>
              )}
              <button onClick={onClose} style={smallBtn}>Close</button>
            </div>
          </div>

          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
            Every D1–D8 placement re-derived from the calls around it, using this site&apos;s call
            pattern. Where a provider is owed two, the lower D wins. D4 and below are ordered by
            soonest next call — the first relief position leaves earliest. Call assignments are
            never changed.
          </div>

          {deleted.size > 0 && (
            <div className="no-print" style={{ fontSize: 12, marginBottom: 8, color: 'var(--text-muted)' }}>
              {deleted.size} deleted from this list — they will NOT be applied.{' '}
              <button onClick={() => setDeleted(new Set())} style={{ ...smallBtn, padding: '2px 8px' }}>
                Restore
              </button>
            </div>
          )}

          {kept.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--ok)', fontWeight: 700 }}>
              {audit.findings.length === 0
                ? 'Every D assignment matches the call pattern.'
                : 'Nothing left in the list.'}
            </div>
          ) : (
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12.5 }}>
              <tbody>
                {kept.map(f => (
                  <tr key={f.key} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '6px 10px 6px 0', fontWeight: 800, whiteSpace: 'nowrap', color: 'var(--text)' }}>
                      {formatMMDD(f.date)}
                    </td>
                    <td style={{ padding: '6px 10px', whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>
                      {KIND_LABEL[f.kind] ?? f.kind}
                    </td>
                    <td style={{ padding: '6px 10px', color: 'var(--text)' }}>
                      <strong>{f.providerIds.map(nameOf).join(', ')}</strong>{' '}
                      <span style={{ color: 'var(--text-muted)' }}>{readable(f)}</span>
                    </td>
                    <td className="no-print" style={{ padding: '6px 0 6px 10px', textAlign: 'right' }}>
                      <button
                        onClick={() => setDeleted(prev => new Set(prev).add(f.key))}
                        title="Remove from this list — it will not be applied"
                        style={{
                          ...smallBtn, padding: '2px 9px', lineHeight: 1.1,
                          color: gridTokens.openCall,
                          border: `1px solid color-mix(in srgb, ${gridTokens.openCall} 40%, transparent)`,
                        }}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Printable schedule (Gabriel 2026-08-02) ───────────────────────────────
 * "print in landscape a full version of the schedule or create a pdf for
 * sending. It should print just the Schedule in the most efficently viewing
 * possible."
 *
 * Hidden on screen, visible only in print. The interactive grid CANNOT be
 * printed directly — it is one CSS grid with sticky headers inside an overflow
 * container, 77 columns wide at Paoli, and a fixed-position print area clips
 * rather than paginates (the Call Counts sheet documents that hazard). So this
 * renders plain per-week tables the browser can break naturally, and the grid
 * is hidden for print.
 *
 * Layout rationale lives in lib/printableSchedule.ts.
 */
function PrintableSchedule({
  grid, slotMap, shiftTypes, allDates, holidayMap, observanceByDate,
  offByDate, icuByDate, ptoByDate, overParAssignmentIds, callTakerIds,
}: {
  grid: GridData;
  slotMap: Record<string, Record<string, Slot>>;
  shiftTypes: ShiftTypeInfo[];
  allDates: string[];
  holidayMap: Record<string, Holiday>;
  observanceByDate: Map<string, string[]>;
  offByDate: Record<string, Provider[]>;
  icuByDate: Record<string, Provider[]>;
  ptoByDate: Record<string, Provider[]>;
  overParAssignmentIds: Set<string>;
  callTakerIds: Set<string>;
}) {
  const weeks = useMemo(() => weeksOf(allDates), [allDates]);
  const rows = useMemo(() => printRows(grid.slots), [grid]);
  const stByCode = useMemo(() => {
    const m: Record<string, ShiftTypeInfo> = {};
    for (const st of shiftTypes) m[st.code] = st;
    return m;
  }, [shiftTypes]);

  const cellIn = (code: string, date: string) => {
    const st = stByCode[code];
    const empty = { name: '', mark: null as HighlightColor | null, extra: false, open: false };
    if (!st) return empty;
    const slot = slotMap[st.id]?.[date];
    if (!slot) return { ...empty, name: '—' };   // no slot stood that day
    const a = (slot.assignments ?? []).find(x => x.provider_id);
    const isCallSlot = st.category === 'call';
    if (!a) {
      // OPEN, and only for CALL slots — the same single-homed predicate the
      // grid's red cells and the Available Call list use, so the printout can
      // never disagree with either about what is up for grabs. An unfilled DAY
      // slot stays blank: nobody is chasing cover for a D6.
      return { ...empty, open: isCallSlot && isUnfilledCallSlot(slot) };
    }
    const provider = a.providers;
    return {
      name: provider?.short_display_name ?? '',
      mark: normalizeHighlightColor(a.highlight_color),
      // "Extra" on paper = either sense the grid paints red: past the
      // provider's rounded obligation (over-par), or picked up by someone who
      // is not in this site's call pool at all. Both are billable extras and a
      // printed sheet is where that gets checked.
      extra: isCallSlot && !!a.id
        && (overParAssignmentIds.has(a.id)
          || (!!provider && !callTakerIds.has(provider.id))),
      open: false,
    };
  };

  // Off / ICU / PTO ride BELOW the shift rows, one row each with the day's
  // names stacked. One row per category rather than the screen's N sub-rows:
  // on paper the stack is the compact form, and a printed schedule is read for
  // "who is away", not for a stable row position.
  const CATEGORY_ROWS: Array<{ label: string; data: Record<string, Provider[]>; color: string }> = [
    { label: 'Off', data: offByDate, color: gridTokens.category.Off },
    { label: 'ICU', data: icuByDate, color: gridTokens.category.ICU },
    { label: 'PTO', data: ptoByDate, color: gridTokens.category.PTO },
  ];

  return (
    <div id="schedule-print" aria-hidden>
      <style>{`
        #schedule-print { display: none; }
        @media print {
          /* Landscape, tight margins — the width is what buys a readable
             column, so it is spent on the table rather than on paper edges. */
          @page { size: landscape; margin: 0.35in; }
          body * { visibility: hidden !important; }
          #schedule-print, #schedule-print * { visibility: visible !important; }
          #schedule-print {
            display: block !important;
            position: absolute !important; left: 0 !important; top: 0 !important;
            width: 100% !important; background: #fff !important; color: #000 !important;
          }
          .sched-week { page-break-after: always; break-after: page; }
          .sched-week:last-child { page-break-after: auto; break-after: auto; }
          .sched-week table { width: 100%; border-collapse: collapse; table-layout: fixed; }
          .sched-week th, .sched-week td {
            border: 1px solid #999; padding: 3px 4px; font-size: 10px;
            overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
          }
          .sched-week th { background: #eee !important; -webkit-print-color-adjust: exact; }
          .sched-week .rowlab { font-weight: 700; text-align: left; width: 62px; background: #f6f6f6 !important; }
          .sched-week .we { background: #f2f2f2 !important; -webkit-print-color-adjust: exact; }
          .sched-week .callrow td, .sched-week .callrow th { font-weight: 700; }
          /* OVER / EXTRA and OPEN both print RED — and the signal is the TEXT
             colour, not a fill. Browsers strip backgrounds unless the reader
             ticks "Background graphics", so a fill-only cue would vanish on a
             default print; text colour always prints. The tint is a bonus for
             readers who have backgrounds on, never the signal itself. */
          .sched-week td.extra {
            color: #b91c1c !important; font-weight: 800;
            background: #fdecec !important;
          }
          .sched-week td.open {
            color: #b91c1c !important; font-weight: 800; font-style: italic;
            background: #fdecec !important;
          }
          /* Off / ICU / PTO sit visually apart from the staffed rows. */
          .sched-week .catrow td, .sched-week .catrow th {
            font-size: 9px; vertical-align: top;
          }
          .sched-week tr.catrow:first-of-type td, .sched-week tr.catrow:first-of-type th {
            border-top: 2px solid #666;
          }
          /* Colour fidelity: without this every background is stripped and the
             marks/shading vanish. The reader must ALSO tick "Background
             graphics" in the print dialog — no stylesheet can override that. */
          #schedule-print, #schedule-print * {
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
          }
          .sched-week h2 { font-size: 13px; margin: 0 0 1px 0; }
          .sched-week .sub { font-size: 9px; color: #444; margin: 0 0 5px 0; }
        }
      `}</style>

      {weeks.map(week => (
        <section className="sched-week" key={week.start}>
          <h2>{grid.schedule.schedule_name}</h2>
          <p className="sub">{weekLabel(week)}</p>
          <table>
            <thead>
              <tr>
                <th className="rowlab" />
                {week.dates.map(d => {
                  const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
                  const isWe = dow === 0 || dow === 6;
                  const note = observanceByDate.get(d)?.join(' · ');
                  return (
                    <th key={d} className={isWe ? 'we' : undefined}>
                      {DAYS_SHORT[dow]} {formatMMDD(d)}
                      {holidayMap[d] && <div style={{ fontWeight: 400 }}>{holidayMap[d].holiday_name}</div>}
                      {note && <div style={{ fontWeight: 400 }}>{note}</div>}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.code} className={r.category === 'call' ? 'callrow' : undefined}>
                  <th className="rowlab">{r.code}</th>
                  {week.dates.map(d => {
                    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
                    const isWe = dow === 0 || dow === 6;
                    const { name, mark, extra, open } = cellIn(r.code, d);
                    return (
                      <td
                        key={d}
                        className={[isWe ? 'we' : '', open ? 'open' : '', extra ? 'extra' : '']
                          .filter(Boolean).join(' ') || undefined}
                        // The hand-set billing mark survives to paper — it is
                        // the whole point of the mark, and a printed sheet is
                        // where a physician checks what they can bill. An
                        // over/extra call out-ranks it: the .extra class sets
                        // its own colour after this.
                        style={mark && !extra && !open
                          ? { background: gridTokens.manualHighlight[mark] } : undefined}
                      >
                        {open ? 'open' : name}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {CATEGORY_ROWS.map(cat => (
                <tr key={cat.label} className="catrow">
                  <th className="rowlab" style={{ borderLeft: `3px solid ${cat.color}` }}>
                    {cat.label}
                  </th>
                  {week.dates.map(d => {
                    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
                    const isWe = dow === 0 || dow === 6;
                    const people = cat.data[d] ?? [];
                    return (
                      <td key={d} className={isWe ? 'we' : undefined}>
                        {people.map(p => (
                          <div key={p.id} style={{ color: cat.color }}>{p.short_display_name}</div>
                        ))}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}
