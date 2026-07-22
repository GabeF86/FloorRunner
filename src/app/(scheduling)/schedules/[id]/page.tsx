'use client';

import { useState, useEffect, useCallback, useRef, useMemo, Fragment } from 'react';
import Link from 'next/link';
import { gridTokens, cellBackground } from './gridTheme';
import {
  fteWeightedTarget, roundedObligation, computeCallObligationCensus,
  type CallObligationCensus,
} from '@/lib/fteTarget';
// Day-math for the Call Counts modal (bucket day counts, Days Off, Working
// Days) — pure helpers assembling the single-homed workDays/plannerMath
// contracts; the modal only aggregates and renders.
import { bucketDayCounts, daysOffFor, creditedWorkingDayTotals } from '@/lib/callCountDays';
// rangeComposition = the planner card's single-homed block composition
// (weekdays minus major holidays → the working-day set).
import { rangeComposition } from '@/lib/plannerMath';
import AssistantPanel from './AssistantPanel';
import { PageHeader, Badge, Button, Banner, scheduleStatusTone } from '@/components/ui';
import { reasonCodeLabel } from '@/lib/validation/providers';
// Pure row-level classifier for LIVE pto_sellback rows — the grid must agree
// with the engine's date-level override (rulesEngine/shared.ts isDateBlocked)
// about which dates a provider is working, so it imports the same predicate.
import { isActiveSellback } from '@/lib/rulesEngine/shared';
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
  sites: SiteInfo;
}

interface EmploymentProfile {
  provider_id: string;
  home_site_id: string | null;
  call_taker: boolean;
  partial_call_taker: boolean;
  fte_value: number | null;
  employment_status: string | null;
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
}

interface ActiveCell {
  slotId: string;
  assignmentId: string | null;
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
//   - effectivePar = min(stored call_par_level, generation-pool ΣFTE) — the
//     same clamp solve()'s obligatory-mode cap uses (genContext
//     .effectiveParLevel). Pool = included_provider_ids override when set,
//     else home-site call/partial-call takers (loadGenerationContext's rule).
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
  const [pickerSearch, setPickerSearch] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [showCounts, setShowCounts] = useState(false);
  const [showAssistant, setShowAssistant] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
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

  /* ── Clear action error after 3s ────────────────────────────────────────── */

  useEffect(() => {
    if (!actionError) return;
    const t = setTimeout(() => setActionError(null), 3000);
    return () => clearTimeout(t);
  }, [actionError]);

  /* ── Derived Data ───────────────────────────────────────────────────────── */

  const { shiftTypes, allDates, slotMap, holidayMap, assignedOnDate, availableByDate, offByDate, offTitleByDate, ptoByDate, postCallByDate, maxAvailable, maxOff, maxPto, maxPostCall, callTakerIds, sellbackByDate } = useMemo(() => {
    const empty = {
      shiftTypes: [] as ShiftTypeInfo[], allDates: [] as string[],
      slotMap: {} as Record<string, Record<string, Slot>>,
      holidayMap: {} as Record<string, Holiday>,
      assignedOnDate: {} as Record<string, Set<string>>,
      availableByDate: {} as Record<string, Provider[]>,
      offByDate: {} as Record<string, Provider[]>,
      offTitleByDate: {} as Record<string, Record<string, string>>,
      ptoByDate: {} as Record<string, Provider[]>,
      postCallByDate: {} as Record<string, Provider[]>,
      maxAvailable: 0, maxOff: 0, maxPto: 0, maxPostCall: 0,
      callTakerIds: new Set<string>(),
      sellbackByDate: {} as Record<string, Set<string>>,
    };
    if (!grid) return empty;

    // Unique shift types sorted by display_order
    const stMap = new Map<string, ShiftTypeInfo>();
    for (const slot of grid.slots) {
      if (!stMap.has(slot.shift_type_id)) stMap.set(slot.shift_type_id, slot.shift_types);
    }
    const shiftTypes = Array.from(stMap.values()).sort((a, b) => (a.display_order ?? 999) - (b.display_order ?? 999));

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
      const available: Provider[] = [];
      const off: Provider[] = [];
      for (const pid of homeSiteIds) {
        if (assigned.has(pid) || ptoSet.has(pid) || postCallSet.has(pid)) continue;
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

    const maxAvailable = Math.max(0, ...Object.values(availableByDate).map(v => v.length));
    const maxOff = Math.max(0, ...Object.values(offByDate).map(v => v.length));
    const maxPto = Math.max(0, ...Object.values(ptoByDate).map(v => v.length));
    const maxPostCall = Math.max(0, ...Object.values(postCallByDate).map(v => v.length));

    return { shiftTypes, allDates, slotMap, holidayMap, assignedOnDate, availableByDate, offByDate, offTitleByDate, ptoByDate, postCallByDate, maxAvailable, maxOff, maxPto, maxPostCall, callTakerIds, sellbackByDate };
  }, [grid]);

  /* ── Per-date working roster + over-par detection ───────────────────────── */

  // Whole-number obligations, TOTAL level (2026-07-17): a provider's
  // obligation = round(total call slots ÷ effective par × FTE) — summed
  // across every call code and day bucket, then rounded half-up. Effective
  // par clamps the stored call_par_level to the generation pool's ΣFTE, the
  // SAME denominator the engine's obligatory-mode cap uses — at the stored
  // par (live: 11 vs pool 8.82) the UI would owe less than the engine and
  // mislabel in-obligation calls as extra. When actual count exceeds the
  // obligation, only the LAST N call assignments (chronological by slot_date,
  // shift-code tiebreak) get the OVER treatment, N = actual − rounded
  // obligation. Calls up to the rounded obligation are NEVER labeled extra.
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

  const assignProvider = async (slotId: string, providerId: string) => {
    if (!grid) return;
    // Optimistic update
    const prevSlots = [...grid.slots];
    setGrid({
      ...grid,
      slots: grid.slots.map(s => {
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

    try {
      const res = await fetch('/api/scheduling/schedule-assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schedule_slot_id: slotId, provider_id: providerId }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setGrid({ ...grid, slots: prevSlots });
        setActionError(data?.error || 'Failed to assign');
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
      setGrid({ ...grid, slots: prevSlots });
      setActionError(e instanceof Error ? e.message : 'Failed to assign provider');
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
    skippedDerived: Array<{ reason: string }>;       // suppressed derived fills (clinical invariant 4)
    // Stale pre-fill seeds evicted by post-call chain fills (D1 overrides
    // pre-call, 2026-07-21) — the vacated slots stay open.
    evictions: Array<{ date: string; code: string; provider_name: string }>;
    // No-call request grant report — "N/M honored" + violated detail.
    requestGrants: Array<{
      provider_id: string; provider_name: string;
      requested_dates: string[]; granted: string[]; violated: string[];
    }>;
    // FTE working-days report — per call-taker, required vs credited days,
    // over/under highlighted.
    workDayReport: Array<{
      provider_id: string; provider_name: string;
      fte: number; workingDays: number; ptoDays: number; required: number;
      credited: { assignments: number; postCall: number; icu: number; total: number };
      entitledOff: number; delta: number;
    }>;
    // Which fill mode produced this result — drives the staged weekend
    // banner + Continue affordance below.
    fillMode: GenFillMode;
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
  const runGeneration = async (mode: GenFillMode) => {
    setGenerating(true);
    setGenResult(null);
    try {
      const res = await fetch(`/api/scheduling/schedules/${id}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fillMode: mode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Generation failed');
      setGenResult({
        filled: data.filled, skipped: data.skipped, errors: data.errors,
        warnings: Array.isArray(data.warnings) ? data.warnings : [],
        skippedDerived: Array.isArray(data.skippedDerived) ? data.skippedDerived : [],
        evictions: Array.isArray(data.evictions) ? data.evictions : [],
        requestGrants: Array.isArray(data.requestGrants) ? data.requestGrants : [],
        workDayReport: Array.isArray(data.workDayReport) ? data.workDayReport : [],
        fillMode: mode,
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

  const continueGeneration = async () => {
    if (!grid || generating) return;
    await runGeneration('all');
  };

  /* ── Provider list for picker ───────────────────────────────────────────── */

  const activeSlot = activeCell && grid ? grid.slots.find(s => s.id === activeCell.slotId) ?? null : null;
  const activeAssignment = activeCell?.assignmentId && activeSlot ? activeSlot.assignments.find(a => a.id === activeCell.assignmentId) ?? null : null;
  const isAssignedCell = !!activeAssignment?.provider_id;

  const filteredProviders = useMemo(() => {
    if (!grid || !activeSlot) return [];
    const search = pickerSearch.toLowerCase();
    return grid.providers
      .filter(p => p.status === 'active')
      .filter(p => {
        if (!search) return true;
        return p.short_display_name.toLowerCase().includes(search)
          || p.first_name.toLowerCase().includes(search)
          || p.last_name.toLowerCase().includes(search)
          || p.initials.toLowerCase().includes(search);
      })
      .sort((a, b) => a.short_display_name.localeCompare(b.short_display_name));
  }, [grid, activeSlot, pickerSearch]);

  const activeSlotDate = activeSlot?.slot_date ?? '';

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
  const assignedOnActiveDate = assignedOnDate[activeSlotDate] ?? new Set<string>();

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

      {/* Top Bar — identity row */}
      <PageHeader
        compact
        title={schedule.schedule_name}
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

        <div style={{ flex: 1 }} />

        {/* Call Counts button */}
        <Button variant="secondary" onClick={() => setShowCounts(true)}>
          Call Counts
        </Button>

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
                ? 'Fill only obligatory call slots — each provider receives at most their rounded call obligation; the rest stay open.'
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
                {genResult.skipped > 0 && ` ${genResult.skipped} could not be filled.`}
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
            {/* FTE working-days report: per call-taker, credited days vs the
                round(FTE × workingDays) − PTO obligation. Over/under flagged so
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
                            {r.provider_name} (FTE {r.fte}): worked {r.credited.total} of {r.required} required{' '}
                            ({r.credited.assignments} assigned + {r.credited.postCall} post-call + {r.credited.icu} ICU),{' '}
                            entitled off {r.entitledOff} —{' '}
                            <b style={{ color: r.delta > 0 ? 'var(--danger, #c0392b)' : 'var(--warn, #b8860b)' }}>
                              {r.delta > 0 ? `over ${r.delta}` : `under ${-r.delta}`}
                            </b>
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

      {/* Action error toast */}
      {actionError && (
        <div style={{ position: 'fixed', top: 20, right: 20, zIndex: 600, maxWidth: 420 }}>
          <Banner tone="error">{actionError}</Banner>
        </div>
      )}

      {/* Grid Container — dark chrome (headers + shift labels), white data cells */}
      {viewMode !== 'calendar' && (
      <div style={{
        flex: 1, overflow: 'auto', borderRadius: 8,
        border: '1px solid var(--border)',
        background: '#ffffff', // data cell background
      }}>
        <div style={{
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
                // Over-par (2026-07-17): this assignment is one of the
                // provider's LAST N calls beyond their rounded TOTAL
                // obligation (N = actual − round(total expected)). Calls up
                // to the rounded obligation never carry the OVER treatment.
                // Doesn't include deficit carry-forward — see useMemo notes.
                const isOverPar = isAssigned && !!assignment && overParAssignmentIds.has(assignment.id);
                // PTO sell-back: this provider has a live pto_sellback row
                // covering today — they're working a date PTO would otherwise
                // block. Red "SB" marker + tooltip (bottom-left corner is
                // unused: validation badge top-left, lock top-right,
                // OVER/EXTRA bottom-right).
                const isSellback = isAssigned && !!provider && !!sellbackByDate[date]?.has(provider.id);

                const cellFlags = { isOverPar, isExtraCall, isHoliday, isWeekend };

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
                    title={
                      isOverPar && provider
                        ? `${provider.short_display_name} is past their rounded call obligation for this block — this is one of their extra calls.`
                        : isExtraCall && provider
                          ? `Provider picking up Extra call — ${provider.short_display_name} is not in the regular call pool at this site.`
                          : isSellback && provider
                            ? `${provider.short_display_name} is selling back PTO — working this date.`
                            : undefined
                    }
                    style={{
                      background: cellBackground(cellFlags),
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
                    {!slot ? null : isAssigned ? (
                      <span style={{
                        fontSize: viewMode === 'month' ? 11 : 13, fontWeight: 800, color: gridTokens.name,
                        whiteSpace: 'nowrap', maxWidth: '100%', overflow: 'hidden',
                        textOverflow: 'ellipsis', display: 'inline-block', verticalAlign: 'bottom',
                      }}>
                        {provider!.short_display_name}
                      </span>
                    ) : isOpenCall ? (
                      <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.03em', color: gridTokens.open }}>OPEN</span>
                    ) : (
                      <span style={{ fontSize: 13, color: gridTokens.unassigned }} aria-label="Unassigned">&mdash;</span>
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
          {renderVirtualRows({
            label: 'PTO',
            count: maxPto,
            dataByDate: ptoByDate,
            color: gridTokens.category.PTO,
            visibleDates,
            todayStr,
            holidayMap,
            getDayOfWeek,
            zoneTop: maxPostCall === 0 && maxOff === 0,
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
              </div>
            </div>
          ) : (
            /* ── Unassigned cell: provider picker ───────────────────────────── */
            <>
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
              <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
                {filteredProviders.length === 0 && (
                  <div style={{ padding: '12px 14px', fontSize: 12, color: 'var(--text-dim)' }}>
                    No providers found
                  </div>
                )}
                {filteredProviders.map(p => {
                  const alreadyAssigned = assignedOnActiveDate.has(p.id);
                  return (
                    <div
                      key={p.id}
                      onClick={() => {
                        if (alreadyAssigned) return;
                        if (activeSlot) assignProvider(activeSlot.id, p.id);
                      }}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10,
                        padding: '8px', borderRadius: 8,
                        cursor: alreadyAssigned ? 'not-allowed' : 'pointer',
                        opacity: alreadyAssigned ? 0.4 : 1,
                        transition: 'background 0.1s',
                      }}
                      onMouseEnter={e => { if (!alreadyAssigned) e.currentTarget.style.background = 'rgba(56,189,248,0.10)'; }}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >
                      {/* Initials avatar */}
                      <div style={{
                        width: 28, height: 28, borderRadius: '50%', fontSize: 10.5, fontWeight: 800,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: 'rgba(56,189,248,0.16)', color: '#7dd3fc',
                        flexShrink: 0,
                      }}>
                        {p.initials}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {p.short_display_name}
                          {alreadyAssigned && <span style={{ fontWeight: 400, color: 'var(--text-dim)', marginLeft: 4 }}>(assigned)</span>}
                        </div>
                      </div>
                      <span style={{
                        fontSize: 9, fontWeight: 800, padding: '2px 6px', borderRadius: 4,
                        background: 'rgba(100,116,139,0.22)', color: 'var(--text-dim)',
                        textTransform: 'uppercase', flexShrink: 0,
                      }}>
                        {p.provider_type}
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}

      {/* Call Counts Modal */}
      {showCounts && grid && (
        <CallCountsModal grid={grid} onClose={() => setShowCounts(false)} />
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
  onClose,
  onSaved,
}: {
  scheduleId: string;
  scheduleSiteId: string;
  orgId: string;
  providers: Provider[];
  profiles: EmploymentProfile[];
  initialSelection: string[] | null;
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
  const [tab, setTab] = useState<'pool' | 'limits'>('pool');
  const [storedLimits, setStoredLimits] = useState<ProviderLimits>({});
  const [limitDrafts, setLimitDrafts] = useState<Record<string, LimitFields>>({});
  // 'loading' → inputs held; 'ready' → editable; 'failed' → tab shows the
  // error and SAVE OMITS the provider_limits key entirely (never clobber
  // stored limits with an empty map because a fetch failed).
  const [limitsState, setLimitsState] = useState<'loading' | 'ready' | 'failed'>('loading');

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
      })
      .catch(() => { if (!cancelled) setLimitsState('failed'); });
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
          padding: 24, width: 560, maxHeight: '85vh', display: 'flex', flexDirection: 'column',
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
            expected call counts + working days / days off for this block). */}
        <div style={{ display: 'flex', gap: 4, marginTop: 8, borderBottom: '1px solid var(--border)' }}>
          {(['pool', 'limits'] as const).map(t => (
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
              {t === 'pool' ? 'Pool' : 'Limits'}
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
            keeps its FTE-derived budget). Working Days and Days Off are mutually exclusive.
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

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14, gap: 8 }}>
          <button
            onClick={() => save(true)}
            disabled={saving || hasInvalidLimit}
            style={{
              ...smallBtn,
              opacity: (saving || hasInvalidLimit) ? 0.5 : 1,
              cursor: (saving || hasInvalidLimit) ? 'not-allowed' : 'pointer',
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
              disabled={saving || totalSelected === 0 || hasInvalidLimit}
              title={hasInvalidLimit ? 'Fix the highlighted limit values (whole numbers ≥ 0)' : undefined}
              style={{
                padding: '7px 16px', fontSize: 12.5, fontWeight: 700, border: 'none', borderRadius: 8,
                background: 'linear-gradient(135deg,#0ea5e9,#6366f1)',
                color: '#fff', boxShadow: '0 4px 14px rgba(56,130,246,0.35)',
                opacity: (saving || totalSelected === 0 || hasInvalidLimit) ? 0.5 : 1,
                cursor: (saving || totalSelected === 0 || hasInvalidLimit) ? 'not-allowed' : 'pointer',
              }}
            >
              {saving ? 'Saving...' : `Save Pool (${totalSelected})`}
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

function CallCountsModal({ grid, onClose }: { grid: GridData; onClose: () => void }) {
  // Bucket key = day_type group (weekday | friday | saturday | sunday).
  // Saturday and Sunday are SEPARATE fairness buckets (mirrors the engine's
  // dayTypeBucket) so per-day call burden is visible per provider.
  const BUCKETS = [
    { key: 'weekday',  label: 'M–Th' },
    { key: 'friday',   label: 'Fri' },
    { key: 'saturday', label: 'Sat' },
    { key: 'sunday',   label: 'Sun' },
  ] as const;
  const CODES = ['C1', 'C2', 'C3'] as const;

  // Types that count as "PTO days" in the tally column. Sick / jury_duty
  // are intentionally excluded — that's unplanned or administrative, not
  // vacation. Only the planned-leave types accrue here.
  const PTO_TYPES = new Set(['pto', 'fmla', 'parental_leave', 'military_leave']);

  // Aggregate counts: counts[providerId][bucket|code] = n
  const counts: Record<string, Record<string, number>> = {};
  // Block totals per (bucket, code) — drives the FTE-weighted target math.
  const blockTotals: Record<string, number> = {};
  const providerById: Record<string, Provider> = {};
  for (const p of grid.providers) providerById[p.id] = p;

  // Shared obligation census — the IDENTICAL inputs the grid's over-par memo
  // uses (callCensusFromGrid): effective-par denominator (stored par clamped
  // to the generation pool's ΣFTE, matching the engine's obligatory-mode cap)
  // and an every-call-slot count — holiday-dated slots and non-C1/C2/C3 call
  // codes included. The bucketed columns below are DISPLAY grouping only
  // (C1–C3 across the four day-type buckets; holiday-dated calls have no
  // column) — they never feed the obligation/extra/OVER math.
  const census = callCensusFromGrid(grid);

  const providersWithCalls = new Set<string>();
  for (const rec of census.callRecords) providersWithCalls.add(rec.provider_id);

  for (const slot of grid.slots) {
    const code = slot.shift_types?.code;
    if (!code || !CODES.includes(code as typeof CODES[number])) continue;
    const dt = slot.derived_day_type;
    let bucket: string;
    if (dt === 'weekday') bucket = 'weekday';
    else if (dt === 'friday') bucket = 'friday';
    else if (dt === 'saturday') bucket = 'saturday';
    else if (dt === 'sunday') bucket = 'sunday';
    else continue; // no holiday display column — the census above still counts these slots
    const key = `${bucket}|${code}`;
    blockTotals[key] = (blockTotals[key] || 0) + 1;
    for (const a of slot.assignments || []) {
      if (!a.provider_id) continue;
      if (!counts[a.provider_id]) counts[a.provider_id] = {};
      counts[a.provider_id][key] = (counts[a.provider_id][key] || 0) + 1;
    }
  }

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

  const getCount = (pid: string, bucket: string, code: string) =>
    counts[pid]?.[`${bucket}|${code}`] || 0;

  // Call Total = EVERY call assignment (census), not just the bucketed C1–C3
  // columns — a holiday-dated call counts here (and in the obligation math)
  // even though it has no bucket column of its own.
  const rowTotal = (pid: string) => census.actualCallsFor(pid);

  const colTotal = (bucket: string, code: string) => {
    let t = 0;
    for (const pid of providers.map(p => p.id)) t += getCount(pid, bucket, code);
    return t;
  };

  const ptoDaysForPid = (pid: string) => ptoDaysByPid[pid] || 0;

  // FTE display beside the provider name only — every calculation below goes
  // through census.fteFor (engine coercion) so display quirks can't skew math.
  const fteByPid: Record<string, number> = {};
  for (const p of grid.profiles || []) {
    fteByPid[p.provider_id] = p.fte_value ?? 1;
  }

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
  // routes through the single-homed workDays contract (round(FTE × WD) − PTO).
  // PTO weekdays here are the SAME tally the PTO Days column shows
  // (ptoDaysForPid) so the two columns can never disagree. Full FTE → 0 → "—".
  const daysOffForPid = (pid: string) =>
    daysOffFor(census.fteFor(pid), composition.workingDays, ptoDaysForPid(pid));

  // Expected = FTE-weighted base target per (provider, bucket, code) —
  // (block_total_in_bucket / effective par) × fte_value, using the census's
  // clamped denominator (the engine's computeBucketTargets uses the same
  // clamp for its category targets). Category-level values stay FRACTIONAL
  // by design (they drive the engine's fairness ordering); only the
  // TOTAL-level obligation below is rounded.
  const expectedFor = (pid: string, bucket: string, code: string) =>
    fteWeightedTarget(blockTotals[`${bucket}|${code}`] || 0, census.effectivePar, census.fteFor(pid));
  // TOTAL-level fractional expected — straight from the shared census (all
  // call slots ÷ effective par × FTE), NOT a sum of the display buckets: the
  // buckets exclude holiday-dated calls, the obligation never does.
  const rowExpected = (pid: string) => census.totalExpectedFor(pid);
  const colExpected = (bucket: string, code: string) => {
    let t = 0;
    for (const p of providers) t += expectedFor(p.id, bucket, code);
    return t;
  };

  // Whole-number obligations, TOTAL level (2026-07-17): a provider's
  // obligation = round(total expected) — round-half-up. Extra Calls = only
  // their LAST N call assignments beyond that rounded obligation
  // (chronological, shift-code tiebreak; N = actual − obligation), grouped by
  // code for the columns below. The over set comes straight from the shared
  // census — the SAME set that paints the grid's red OVER cells, computed
  // once from identical inputs, so the two views always agree. (An over call
  // with a code outside C1–C3 counts in the math but has no Extra column —
  // live call codes are only C1–C3 today.)
  //
  // Deficit carry-forward is NOT included (we don't have historical data
  // here), so this can over-report for part-timers legitimately catching
  // up from a prior block. Documented in the column tooltip.
  const rowObligation = (pid: string) => roundedObligation(rowExpected(pid));
  const overIds = census.overParAssignmentIds;
  const overByPidCode: Record<string, number> = {};
  for (const rec of census.callRecords) {
    if (!overIds.has(rec.id)) continue;
    const k = `${rec.provider_id}|${rec.shift_type_code}`;
    overByPidCode[k] = (overByPidCode[k] || 0) + 1;
  }
  const getExtra = (pid: string, code: string): number =>
    overByPidCode[`${pid}|${code}`] || 0;
  const colExtraTotal = (code: string) => {
    let t = 0;
    for (const pid of providers.map(p => p.id)) t += getExtra(pid, code);
    return t;
  };
  const fmtFte = (fte: number) => fte.toFixed(2).replace(/\.?0+$/, '');
  // Hide sub-noise expectations — anything under this rounds to 0.0 anyway.
  const EXPECTED_DISPLAY_MIN = 0.05;

  const handlePrint = () => {
    // Native print dialog → Save as PDF gets you a file. Relies on the
    // .print-area / @media print styles below to isolate the table.
    window.print();
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)',
        zIndex: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}
    >
      <div
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
            body * { visibility: hidden !important; }
            #call-counts-print, #call-counts-print * { visibility: visible !important; }
            #call-counts-print {
              position: fixed !important; inset: 0 !important;
              background: #fff !important; color: #000 !important;
              padding: 0.4in !important; overflow: visible !important;
              max-height: none !important; max-width: none !important;
              min-width: 0 !important;
              border: none !important;
            }
            #call-counts-print table, #call-counts-print th, #call-counts-print td {
              color: #000 !important; border-color: #666 !important;
              background: #fff !important;
            }
            #call-counts-print .no-print { display: none !important; }
          }
        `}</style>

        <div id="call-counts-print">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--text)' }}>Call Counts</div>
            <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 2 }}>
              {grid.schedule.schedule_name} — per provider, per day bucket, per call tier. PTO days (M–F only), FTE days off, and credited working days shown separately.
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
            <tr style={{ background: 'var(--bg)', color: 'var(--text-muted)' }}>
              <th rowSpan={2} style={{ padding: '6px 10px', textAlign: 'left', borderBottom: '1px solid var(--border)', fontWeight: 700 }}>Provider</th>
              {BUCKETS.map(b => (
                <th key={b.key} colSpan={3} title={`${bucketDays[b.key]} ${b.label} day${bucketDays[b.key] === 1 ? '' : 's'} in this block — distinct slot dates by stored day type. Holiday-dated days are excluded (they have no bucket column).`} style={{
                  padding: '6px 10px', textAlign: 'center', fontWeight: 700,
                  borderBottom: '1px solid var(--border)', borderLeft: '1px solid var(--border)',
                  color: 'var(--text-muted)', cursor: 'help',
                }}>
                  {b.label}
                  <span style={{ fontSize: 10, fontWeight: 500, opacity: 0.7, marginLeft: 4 }}>
                    {bucketDays[b.key]}d
                  </span>
                </th>
              ))}
              <th colSpan={3} style={{
                padding: '6px 10px', textAlign: 'center',
                borderBottom: '1px solid var(--border)', borderLeft: '1px solid var(--border)',
                color: '#ef4444',
              }} title="Calls beyond the provider's ROUNDED total obligation — round(total call slots ÷ effective par × FTE). Effective par = call par level clamped down to the generation pool's summed FTE (the engine's obligatory-mode denominator). Every call slot counts — holiday-dated included. Only their LAST N calls (chronological) count as extra, N = actual − obligation; calls up to the obligation are never extra. Same selection as the red grid cells. Deficit carry-forward is not included.">
                Extra Calls
              </th>
              <th rowSpan={2} style={{
                padding: '6px 10px', textAlign: 'center', fontWeight: 700,
                borderBottom: '1px solid var(--border)', borderLeft: '1px solid var(--border)',
              }} title="Rounded total obligation: round(total call slots ÷ effective par × FTE), rounding half up — 1.5 owes 2, 1.3 owes 1. Effective par = call par level clamped down to the generation pool's summed FTE, matching the engine's obligatory-mode cap. Hover a value for the fractional expected behind it.">
                Obligation
              </th>
              <th rowSpan={2} style={{
                padding: '6px 10px', textAlign: 'center', fontWeight: 700,
                borderBottom: '1px solid var(--border)', borderLeft: '1px solid var(--border)',
              }}>Call Total</th>
              <th rowSpan={2} style={{
                padding: '6px 10px', textAlign: 'center', fontWeight: 700,
                borderBottom: '1px solid var(--border)', borderLeft: '1px solid var(--border)',
                color: '#fbbf24',
              }}>PTO Days<br/><span style={{ fontSize: 10, fontWeight: 500, opacity: 0.7 }}>(M–F only)</span></th>
              <th rowSpan={2} style={{
                padding: '6px 10px', textAlign: 'center', fontWeight: 700,
                borderBottom: '1px solid var(--border)', borderLeft: '1px solid var(--border)',
                cursor: 'help',
              }} title={`Entitled weekday days off this block from the FTE fraction: block working days (M–F minus major holidays, ${composition.workingDays} this block) − PTO days − required, where required = round(FTE × working days) − PTO days (the engine's working-days contract). PTO days = the PTO Days column's tally. Full-FTE providers compute to 0 (—).`}>
                Days Off
              </th>
              <th rowSpan={2} style={{
                padding: '6px 10px', textAlign: 'center', fontWeight: 700,
                borderBottom: '1px solid var(--border)', borderLeft: '1px solid var(--border)',
                cursor: 'help',
              }} title="Credited M–F working days scheduled on this draft: distinct working days (weekdays minus major holidays) with any assignment, plus post-call rest days credited as worked, plus ICU rotation weekdays — the generation banner's working-days credit.">
                Working Days
              </th>
            </tr>
            <tr style={{ background: 'var(--bg)', color: 'var(--text-muted)' }}>
              {BUCKETS.map(b => CODES.map(c => (
                <th key={`${b.key}|${c}`} style={{
                  padding: '4px 8px', textAlign: 'center', fontWeight: 700,
                  borderBottom: '1px solid var(--border)',
                  borderLeft: c === 'C1' ? '1px solid var(--border)' : 'none',
                  color: c === 'C1' ? '#0ea5e9' : c === 'C2' ? '#34d399' : '#a855f7',
                }}>{c}</th>
              )))}
              {CODES.map(c => (
                <th key={`extra|${c}`} style={{
                  padding: '4px 8px', textAlign: 'center', fontWeight: 700,
                  borderBottom: '1px solid var(--border)',
                  borderLeft: c === 'C1' ? '1px solid var(--border)' : 'none',
                  color: c === 'C1' ? '#0ea5e9' : c === 'C2' ? '#34d399' : '#a855f7',
                }}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {providers.map(p => (
              <tr key={p.id} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={{ padding: '6px 10px', color: 'var(--text)', fontWeight: 500 }}>
                  {p.short_display_name}
                  {fteByPid[p.id] != null && (
                    <span style={{ opacity: 0.7, fontSize: 11, marginLeft: 5 }}>
                      · {fmtFte(fteByPid[p.id])}
                    </span>
                  )}
                </td>
                {BUCKETS.map(b => CODES.map(c => {
                  const n = getCount(p.id, b.key, c);
                  const exp = expectedFor(p.id, b.key, c);
                  return (
                    <td key={`${b.key}|${c}`} style={{
                      padding: '6px 8px', textAlign: 'center', whiteSpace: 'nowrap',
                      color: n === 0 ? 'var(--text-dim)' : 'var(--text)',
                      borderLeft: c === 'C1' ? '1px solid var(--border)' : 'none',
                      fontWeight: n > 0 ? 600 : 400,
                    }}>
                      {n || '—'}
                      {exp >= EXPECTED_DISPLAY_MIN && (
                        <span style={{ fontSize: 10, opacity: 0.7, marginLeft: 3, fontWeight: 400 }}>
                          ({exp.toFixed(1)})
                        </span>
                      )}
                    </td>
                  );
                }))}
                {CODES.map(c => {
                  const n = getExtra(p.id, c);
                  return (
                    <td key={`extra|${c}`} style={{
                      padding: '6px 8px', textAlign: 'center',
                      color: n === 0 ? 'var(--text-dim)' : '#ef4444',
                      borderLeft: c === 'C1' ? '1px solid var(--border)' : 'none',
                      fontWeight: n > 0 ? 700 : 400,
                    }}>{n || '—'}</td>
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
                }}>{rowTotal(p.id)}</td>
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
                <td style={{
                  padding: '6px 10px', textAlign: 'center',
                  borderLeft: '1px solid var(--border)', fontWeight: 600,
                  color: workingDaysForPid(p.id) > 0 ? 'var(--text)' : 'var(--text-dim)',
                }}>{workingDaysForPid(p.id) || '—'}</td>
              </tr>
            ))}
            {/* Totals row */}
            <tr style={{ background: 'var(--bg)', fontWeight: 700, color: 'var(--text)' }}>
              <td style={{ padding: '8px 10px', borderTop: '2px solid var(--border)' }}>Total</td>
              {BUCKETS.map(b => CODES.map(c => (
                <td key={`total-${b.key}|${c}`} style={{
                  padding: '8px 10px', textAlign: 'center',
                  borderLeft: c === 'C1' ? '1px solid var(--border)' : 'none',
                  borderTop: '2px solid var(--border)',
                }}>{colTotal(b.key, c) || '—'}</td>
              )))}
              {CODES.map(c => (
                <td key={`total-extra|${c}`} style={{
                  padding: '8px 10px', textAlign: 'center',
                  borderLeft: c === 'C1' ? '1px solid var(--border)' : 'none',
                  borderTop: '2px solid var(--border)',
                  color: '#ef4444',
                }}>{colExtraTotal(c) || '—'}</td>
              ))}
              <td style={{
                padding: '8px 10px', textAlign: 'center',
                borderLeft: '1px solid var(--border)', borderTop: '2px solid var(--border)',
              }}>{providers.reduce((s, p) => s + rowObligation(p.id), 0)}</td>
              <td style={{
                padding: '8px 10px', textAlign: 'center',
                borderLeft: '1px solid var(--border)', borderTop: '2px solid var(--border)',
              }}>{providers.reduce((s, p) => s + rowTotal(p.id), 0)}</td>
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
                padding: '8px 10px', textAlign: 'center',
                borderLeft: '1px solid var(--border)', borderTop: '2px solid var(--border)',
              }}>{providers.reduce((s, p) => s + workingDaysForPid(p.id), 0) || '—'}</td>
            </tr>
            {/* Expected row — Σ of per-provider FTE-weighted targets (from slot counts,
                at the effective par). A gap vs Total means unfilled slots in that column,
                a stored par below the pool's FTE, or holiday-dated calls (counted in the
                Call Total column but carrying no bucket column). */}
            <tr style={{ color: 'var(--text-dim)', fontWeight: 600 }}
                title="Sum of each provider's FTE-weighted target: (bucket slot count ÷ effective par) × FTE, where effective par = call par level clamped down to the generation pool's summed FTE. A gap versus Total means slots in that column are unfilled, the stored par is below the pool's FTE, or calls sit on holiday dates (no bucket column) — check the grid for open slots before concluding under-staffing.">
              <td style={{ padding: '6px 10px' }}>Expected</td>
              {BUCKETS.map(b => CODES.map(c => {
                const exp = colExpected(b.key, c);
                return (
                  <td key={`exp-${b.key}|${c}`} style={{
                    padding: '6px 8px', textAlign: 'center',
                    borderLeft: c === 'C1' ? '1px solid var(--border)' : 'none',
                  }}>{exp >= EXPECTED_DISPLAY_MIN ? exp.toFixed(1) : '—'}</td>
                );
              }))}
              {CODES.map(c => (
                <td key={`exp-extra|${c}`} style={{
                  padding: '6px 8px', textAlign: 'center',
                  borderLeft: c === 'C1' ? '1px solid var(--border)' : 'none',
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
              <td style={{ padding: '6px 10px', textAlign: 'center', borderLeft: '1px solid var(--border)' }}>—</td>
              <td style={{ padding: '6px 10px', textAlign: 'center', borderLeft: '1px solid var(--border)' }}>—</td>
              <td style={{ padding: '6px 10px', textAlign: 'center', borderLeft: '1px solid var(--border)' }}>—</td>
            </tr>
          </tbody>
        </table>
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
                    return (
                      <div
                        key={wi}
                        title={
                          (isOverPar ? 'Past rounded call obligation — one of their extra calls. ' : '') +
                          `${w.shortName} · ${w.shiftCode}`
                        }
                        style={{
                          display: 'flex', alignItems: 'center', gap: 4,
                          fontSize: 10, lineHeight: 1.25,
                          color: 'var(--text)',
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                          background: isOverPar ? gridTokens.overPar : 'transparent',
                          borderRadius: 3,
                          padding: isOverPar ? '0 2px' : 0,
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
