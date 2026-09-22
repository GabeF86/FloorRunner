'use client';

import { useState, useEffect, useCallback, useRef, useMemo, Fragment } from 'react';
// Aliased: `dynamic` is also a Next.js route-segment config export name, and
// this file may need to declare one. Importing the helper under its own name
// keeps the two from ever colliding.
import nextDynamic from 'next/dynamic';
import Link from 'next/link';
import { gridTokens, cellBackground, cellOutline, cellOpacity, manualHighlightTitle } from './gridTheme';
import {
  HIGHLIGHT_COLORS, normalizeHighlightColor, type HighlightColor,
} from '@/lib/highlightColor';
// Grid payload types + the route's pure date math, shared with the overlay
// modules this page loads dynamically (see ./gridShared.ts for why they live
// there rather than being copied into each one).
import {
  DAYS_SHORT, toDateStr, formatMMDD, formatDateRange, getDayOfWeek,
  allDatesInRange, callCensusFromGrid, getWeekStart, colorWithAlpha,
  type Schedule, type ShiftTypeInfo, type ValidationFlag, type AssignmentInfo,
  type Slot, type Provider, type Holiday, type GridData, providerLabel, byProviderLabel } from './gridShared';
import AssistantPanel from './AssistantPanel';
import { PageHeader, Badge, Button, Banner, scheduleStatusTone } from '@/components/ui';
import { SCHEDULE_NAME_MAX } from '@/lib/scheduleName';
import { reasonCodeLabel } from '@/lib/validation/providers';
// Pure row-level classifier for LIVE pto_sellback rows — the grid must agree
// with the engine's date-level override (rulesEngine/shared.ts isDateBlocked)
// about which dates a provider is working, so it imports the same predicate.
import { isActiveSellback } from '@/lib/rulesEngine/shared';
// Pure, client-safe helper shared with the grid API route — one bucket rule
// (hard / soft / warning-never-soft) for both server and client counting.
import { validationSummaryFor } from '@/app/api/scheduling/schedules/[id]/grid/route.helpers';
// Grid zoom (2026-07-22): level list + localStorage round-trip for the
// toolbar's zoom segmented control. Applied as CSS `zoom` on the grid
// container ONLY — uniform scaling keeps every inline sizing literal and
// sticky header offset coupled by construction.
import { GRID_ZOOM_LEVELS, loadGridZoom, saveGridZoom, type GridZoomLevel } from './gridZoom';
// Call splits (2026-07-22): segments render STACKED inside the parent call's
// row cell (parent_call_code lookup — no new grid rows); weights fold under
// the parent for the Call Counts modal via the single-homed callBurden math.
import { isSegmentType, segmentKey, groupSegmentSlots, segmentTag } from './gridSegments';
// Cell picker eligibility (2026-07-28). ALL the logic lives in slotCandidates —
// a pure, tested module that mirrors evaluateEligibility's decisions for the
// subset a client can evaluate (and names the ones it cannot). This component
// only renders what it returns; never add a rule here.
import {
  buildCandidateIndex, candidatesForSlot, filterCandidateGroups, overrideConfirmMessage,
  type DayShiftRelease, type SlotCandidate,
} from '@/lib/slotCandidates';
// Available Call (2026-07-29): every UNFILLED call slot — the grid's red-cell
// predicate and the Available Call List are the SAME function, so a red cell
// and a list row can never disagree. "Unfilled" is row-level (plannerMath's
// assignmentFills), because clearing a cell leaves an OPEN PLACEHOLDER row
// behind and a naive count(assignments) reports those slots as covered.
// The page builds the list; ./AvailableCallsModal only renders it.
import { buildAvailableCallList, isUnfilledCallSlot } from '@/lib/availableCalls';
import { buildProviderFocusList } from '@/lib/providerFocusList';
import { observanceNotesByDate, observanceLabelFor } from '@/lib/observanceNotes';
// The page runs the audit and the spacing review; ./DAuditModal and
// ./SpacingModal only render the results and dispatch the edits.
import { auditDAssignments } from '@/lib/dAssignmentAudit';
import { reviewTightPairs } from '@/lib/callSpacing';

/* ── Gated overlays, loaded on demand ────────────────────────────────────────
 * Every component below renders only behind a flag (a modal the user opened, a
 * view mode they switched to, a print they triggered), so none of it is needed
 * to paint the grid. Statically imported they sat in the route's first load for
 * every visit, including the overwhelming majority that never open them.
 *
 * `ssr: false` is right for all of them: they are click-gated overlay UI, never
 * server-rendered, and several reach for `window` on mount.
 * ───────────────────────────────────────────────────────────────────────── */

const PoolSelectorModal = nextDynamic(
  () => import('./PoolSelectorModal').then(m => m.PoolSelectorModal), { ssr: false });
const CallCountsModal = nextDynamic(
  () => import('./CallCountsModal').then(m => m.CallCountsModal), { ssr: false });
const AvailableCallsModal = nextDynamic(
  () => import('./AvailableCallsModal').then(m => m.AvailableCallsModal), { ssr: false });
const CalendarView = nextDynamic(
  () => import('./CalendarView').then(m => m.CalendarView), { ssr: false });
const SpacingModal = nextDynamic(
  () => import('./SpacingModal').then(m => m.SpacingModal), { ssr: false });
const DAuditModal = nextDynamic(
  () => import('./DAuditModal').then(m => m.DAuditModal), { ssr: false });
const PrintableSchedule = nextDynamic(
  () => import('./PrintableSchedule').then(m => m.PrintableSchedule), { ssr: false });

/* ── Grid ink (theme-invariant) ──────────────────────────────────────────────
 * THE ONE RULE THAT DECIDES WHICH COLOURS ON THIS PAGE ARE TOKENS.
 *
 * The page is two different surfaces. The chrome around the grid — toolbar,
 * banners, popovers, modals — is a normal themed surface and everything on it
 * takes design tokens, so it follows light/dark like the rest of the app.
 * The GRID ITSELF does not: gridTokens.chrome is #1e293b and gridTokens.bodyCell
 * is #ffffff in BOTH themes, deliberately, because a schedule is a printed-page
 * artifact that has to look the same on every screen in the department.
 * gridTheme.ts owns that decision and is frozen.
 *
 * So a mark drawn INSIDE the grid cannot use --danger / --warn / --blue: those
 * flip with the theme and would land pale-red-on-white one way and
 * deep-amber-on-near-black the other. gridTokens names most of that vocabulary
 * already; the handful below are the ones it does not, collected here instead
 * of scattered inline, and each picked to clear AA on the surface it sits on.
 * Nothing here is data — no stored colour, no provider-type map. */
const GRID_INK = {
  /** OVER tag on an over-par cell. Deeper than the wash's own #ef4444, which
   *  is ~3.3:1 at 7.5px. Same red the printed sheet uses for OVER/EXTRA. */
  over: '#b91c1c',
  /** EXTRA tag on the extra-call wash. Deep enough to read (~6.4:1) and far
   *  enough from the OVER red that the two tags never blur at scan speed. */
  extra: '#0369a1',
  /** Holiday column header — an amber-brown in the CHROME family, so the whole
   *  column reads as a holiday from the header down. Not derivable from
   *  gridTokens.bodyHoliday: that is a wash for white cells, this is a fill
   *  for a near-black bar. */
  holidayChrome: '#3a3010',
  /** Holiday ink ON that chrome. --warn is #b45309 in the light theme, which
   *  is unreadable here — the bar does not follow the theme. */
  holidayOnChrome: '#fbbf24',
  /** Weekend day-of-week label — one step brighter than gridTokens.chromeMuted
   *  so Sat/Sun read first in the header. */
  weekendChrome: '#cbd5e1',
  /** The assignment → status-row boundary, drawn twice: once across the sticky
   *  chrome labels (a lift off chromeBorder) and once across the body cells (a
   *  hairline that reads on white). */
  zoneRuleChrome: '#33455f',
  zoneRuleBody: '#cbd5e1',
  /** White ink on a SOLID grid fill — the validation badge. Named rather than
   *  '#fff' so it is obviously the same decision as gridTokens.openCallText. */
  onSolid: '#ffffff',
} as const;

/** The violet inside gridTokens.providerFocusOutline, which gridTheme exports
 *  only pre-baked into a box-shadow. The toolbar controls that TURN focus on
 *  have to match the ring they produce, so the bare value is stated once here
 *  rather than re-typed at each of the three call sites. Violet is the one hue
 *  the grid has free — see the gridTheme note on providerFocusOutline. */
const FOCUS_VIOLET = 'rgb(124,58,237)';

/* ── Interfaces ──────────────────────────────────────────────────────────── */

// Auto-generate fill modes (mirrors rulesEngine FillMode; the route degrades
// unknown values to 'all'). 'weekend-only' is the staged flow: weekend call
// first, then a Continue button that runs 'all' over the committed weekend.
type GenFillMode = 'all' | 'obligatory' | 'weekend-only';

// An assignment row as returned by the schedule-assignments API: the grid
// cell shape plus the slot it belongs to, so edits can be patched into grid
// state in place without a full refetch.
interface AssignmentRow extends AssignmentInfo {
  schedule_slot_id: string;
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
  // Neuro weekends as their own run (Gabriel 2026-09-22). '' = together with
  // everything else, which is the pre-existing behaviour.
  const [neuroScope, setNeuroScope] = useState<'' | 'only' | 'exclude'>('');
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
    for (const list of Object.values(ptoByDate)) list.sort(byProviderLabel);

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
    for (const list of Object.values(postCallByDate)) list.sort(byProviderLabel);

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
      available.sort(byProviderLabel);
      off.sort(byProviderLabel);
      availableByDate[date] = available;
      offByDate[date] = off;
    }

    for (const list of Object.values(icuByDate)) {
      list.sort(byProviderLabel);
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
    providers: grid.providers.map(p => ({
        ...p, short_display_name: providerLabel(p), initials: p.initials ?? '',
      })),
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
        const shortName = providerLabel(a.providers);
        const type = a.providers.provider_type;
        if (!workingByDate[date]) workingByDate[date] = [];
        workingByDate[date].push({
          assignmentId: a.id,
          providerId: a.provider_id,
          last_name: lastName,
          initials,
          shortName,
          shiftCode: code,
          // DATA, not style: the shift type's stored colour, with the same
          // neutral fallback for a row that has none. Not a token — it is
          // handed to colorWithAlpha, which parses #rrggbb, and it has to be
          // the same value whatever theme is rendering it.
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
  // OBLIGATORY IS THE DEFAULT (Gabriel 2026-09-22). Filling every slot the
  // engine legally can also fills the calls above everybody's obligation —
  // and those are precisely the ones meant to stay open for call-takers to
  // pick up after publication. 'all' is one click away and is what the staged
  // Continue runs; the safe mode is the one you get by not choosing.
  const [genFillMode, setGenFillMode] = useState<GenFillMode>('obligatory');
  useEffect(() => {
    try {
      const stored = localStorage.getItem(FILL_MODE_STORAGE_KEY);
      // 'all' is listed explicitly now that it is no longer the default —
      // without it a saved 'all' preference silently reverted to obligatory.
      if (stored === 'all' || stored === 'obligatory' || stored === 'weekend-only') {
        setGenFillMode(stored);
      }
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
          ...(neuroScope ? { neuroScope } : {}),
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
      // Labelled at the boundary: these consumers type the name as required,
      // and 22 physicians have none stored.
      providers: grid.providers.map(p => ({
        ...p, short_display_name: providerLabel(p), initials: p.initials ?? '',
      })),
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
    return <div style={{ padding: 40, color: 'var(--danger)' }}>{error}</div>;
  }
  if (!grid) return <div style={{ padding: 40, color: 'var(--text-muted)' }}>Loading schedule...</div>;

  const { schedule, version } = grid;
  const colCount = visibleDates.length;

  return (
    <div className="schedule-builder-page" style={{ padding: '4px 8px', height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Page-wide keyboard ring. It was gridTokens.accent (#38bdf8), which is
          the grid's sky — correct against the dark chrome it was picked for,
          and ~1.9:1 against the light toolbar and white cells where nearly
          every focusable control on this page actually lives. --blue is the
          system's focus colour and tracks the theme, matching the outline that
          .fr-field / .fr-seg / .fr-focus already draw elsewhere.

          `select` is listed explicitly: the old rule covered only button and
          input, so the fill-mode, day-scope and provider-focus dropdowns had
          no visible ring at all.

          One CSS home for the ring, and no inline `outline` anywhere on this
          page, so this rule can always win. */}
      <style>{`
        .schedule-builder-page button:focus-visible,
        .schedule-builder-page select:focus-visible,
        .schedule-builder-page input:focus-visible {
          outline: 2px solid var(--blue);
          outline-offset: 1px;
          border-radius: var(--radius-sm);
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
              className="fr-field"
              style={{
                fontSize: 14, fontWeight: 700, minWidth: 280,
                padding: '3px 8px', borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--border)', background: 'var(--bg-deep)',
                color: 'var(--text-strong)',
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
              className="fr-btn fr-btn-ghost"
              style={{
                cursor: 'pointer', padding: 2, borderRadius: 'var(--radius-sm)',
                fontSize: 13, lineHeight: 1,
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
        /* Rules summary — verify the algorithm is enforcing your rules.
           ONE tone drives the whole chip: fill, ink, border and dot. It used
           to carry six values across three states — two different greens
           (#0e7c52 text, #16a34a dot) and three rgba tints on unrelated base
           triples from the ones the ink used. Now the state picks a token and
           everything derives from it, so the chip cannot half-change. */
        <div style={{ position: 'relative' }}>
          {(() => {
          const tone = rulesSummary.hardCount > 0
            ? 'var(--danger)'
            : rulesSummary.softCount + rulesSummary.warningCount > 0
              ? 'var(--warn)'
              : 'var(--ok)';
          const toneBg = rulesSummary.hardCount > 0
            ? 'var(--danger-bg)'
            : rulesSummary.softCount + rulesSummary.warningCount > 0
              ? 'var(--warn-bg)'
              : 'var(--ok-bg)';
          // No .fr-chip / .fr-focus on this button, on purpose. The chip's
          // FILL is its state and is therefore inline, and an inline value
          // always beats a class — so .fr-chip's :hover could not have fired,
          // and a rule that cannot fire is worse than none. Hover and press
          // are applied inline below instead. The keyboard ring comes from the
          // page-wide button:focus-visible outline, which is the right ring on
          // both the toolbar and a popover; .fr-focus paints its halo in
          // --bg-base and would show as a grey band on any other ground.
          return (
          <button
            onClick={() => setShowRulesSummary(v => !v)}
            aria-expanded={showRulesSummary}
            title="Aggregate of validation_flags across every assignment in this schedule"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 7,
              padding: '5px 11px', borderRadius: 999, cursor: 'pointer',
              fontSize: 11.5, fontFamily: 'var(--font-mono), ui-monospace, monospace',
              fontVariantNumeric: 'tabular-nums',
              background: toneBg,
              color: tone,
              border: `0.5px solid color-mix(in srgb, ${tone} 35%, transparent)`,
              transition: 'border-color var(--dur-fast) var(--ease-out),'
                + ' box-shadow var(--dur-fast) var(--ease-out),'
                + ' transform var(--dur-instant) var(--ease-out)',
            }}
            // Inline, not .fr-chip's own :hover — that rule repaints
            // `background`, which is set inline here (the chip's fill IS its
            // state) and would therefore lose. A border + shadow lift says
            // "pressable" without touching the tone.
            onMouseEnter={e => {
              e.currentTarget.style.borderColor = tone;
              e.currentTarget.style.boxShadow = 'var(--shadow-xs)';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.borderColor = `color-mix(in srgb, ${tone} 35%, transparent)`;
              e.currentTarget.style.boxShadow = 'none';
              e.currentTarget.style.transform = 'none';
            }}
            onMouseDown={e => { e.currentTarget.style.transform = 'translateY(1px)'; }}
            onMouseUp={e => { e.currentTarget.style.transform = 'none'; }}
          >
            <span style={{
              width: 6, height: 6, borderRadius: '50%', background: tone,
            }} />
            checked {rulesSummary.assignmentsChecked} ·{' '}
            {rulesSummary.hardCount + rulesSummary.softCount + rulesSummary.warningCount === 0
              ? 'all clean'
              : `${rulesSummary.hardCount}H · ${rulesSummary.softCount}S${rulesSummary.warningCount > 0 ? ` · ${rulesSummary.warningCount}W` : ''}`}
          </button>
          );
          })()}
          {showRulesSummary && (
            <div
              onMouseLeave={() => setShowRulesSummary(false)}
              style={{
                position: 'absolute', top: '100%', left: 0, marginTop: 6,
                background: 'var(--bg-surface)', border: '0.5px solid var(--border)',
                borderRadius: 6, padding: '8px 10px', minWidth: 280, maxWidth: 360,
                boxShadow: 'var(--shadow-popover)', zIndex: 100,
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
                <span style={{ fontFamily: 'var(--font-mono), ui-monospace, monospace', color: rulesSummary.hardCount > 0 ? 'var(--danger)' : 'var(--text-dim)' }}>{rulesSummary.hardCount}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
                <span>Soft violations</span>
                <span style={{ fontFamily: 'var(--font-mono), ui-monospace, monospace', color: rulesSummary.softCount > 0 ? 'var(--warn)' : 'var(--text-dim)' }}>{rulesSummary.softCount}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
                <span>Warnings (needs re-validation)</span>
                <span style={{ fontFamily: 'var(--font-mono), ui-monospace, monospace', color: rulesSummary.warningCount > 0 ? 'var(--warn)' : 'var(--text-dim)' }}>{rulesSummary.warningCount}</span>
              </div>
              {rulesSummary.byRule.length > 0 ? (
                <>
                  <div style={{ fontSize: 9, fontFamily: 'var(--font-mono), ui-monospace, monospace', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 8, marginBottom: 4, paddingBottom: 4, borderBottom: '0.5px solid var(--border)' }}>
                    By rule
                  </div>
                  {rulesSummary.byRule.map((r) => (
                    <div key={(r.rule_id ?? r.rule_name) + r.severity} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', fontSize: 11 }}>
                      <span style={{ width: 5, height: 5, borderRadius: '50%', background: r.severity === 'hard' ? 'var(--danger)' : 'var(--warn)', flexShrink: 0 }} />
                      <span style={{ flex: 1, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.rule_name}</span>
                      <span style={{ fontFamily: 'var(--font-mono), ui-monospace, monospace', color: 'var(--text-muted)', fontSize: 10 }}>×{r.count}</span>
                    </div>
                  ))}
                </>
              ) : rulesSummary.assignmentsChecked > 0 ? (
                <div style={{ fontSize: 11, color: 'var(--ok)', textAlign: 'center', padding: '6px 0', fontStyle: 'italic' }}>
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

        {/* View toggle. .fr-seg is the system's "row of buttons, one of them
            on", and the arrangement matters: the UNSELECTED look lives in CSS
            so its :hover and :active can exist at all — an inline
            `background: transparent` here (which is what was here) silently
            outranks the class rule, which is why this control had no hover.
            The SELECTED pill still paints inline and so correctly keeps hover
            off itself. The tone moved off #7dd3fc, a dark-theme sky that
            measured ~1.9:1 on this light-default toolbar. */}
        <div style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
          {(['week', 'month', 'calendar'] as const).map(m => (
            <button
              key={m}
              className="fr-seg"
              aria-pressed={viewMode === m}
              onClick={() => {
                setViewMode(m);
                setWeekOffset(0);
                setCalendarMonthOffset(0);
              }}
              style={{
                padding: '6px 14px', fontSize: 12, fontWeight: 600,
                border: 'none', borderRadius: 0, cursor: 'pointer',
                ...(viewMode === m ? {
                  background: 'color-mix(in srgb, var(--blue) 14%, transparent)',
                  color: 'var(--blue)',
                } : null),
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
            style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}
          >
            {GRID_ZOOM_LEVELS.map(level => (
              // Same .fr-seg arrangement as the view toggle above — see the
              // note there for why the unselected look must NOT be inline.
              <button
                key={level}
                className="fr-seg"
                onClick={() => changeGridZoom(level)}
                aria-pressed={gridZoom === level}
                style={{
                  padding: '6px 9px', fontSize: 11, fontWeight: 700,
                  border: 'none', borderRadius: 0, cursor: 'pointer',
                  fontFamily: 'var(--font-mono), ui-monospace, monospace',
                  fontVariantNumeric: 'tabular-nums',
                  ...(gridZoom === level ? {
                    background: 'color-mix(in srgb, var(--blue) 14%, transparent)',
                    color: 'var(--blue)',
                  } : null),
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
          // gridTokens.openCall rather than --danger. The system DOES have a
          // red (--danger, and --danger-bg) — this deliberately does not use it,
          // because --danger tracks the theme and the cells this button counts
          // do not. It has to be the same red as the grid it is about.
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
          className="fr-field"
          style={{
            height: 30, borderRadius: 'var(--radius-sm)', padding: '0 8px',
            fontSize: 13, fontWeight: 600,
            cursor: 'pointer', maxWidth: 190,
            background: focusPid
              ? `color-mix(in srgb, ${FOCUS_VIOLET} 15%, transparent)` : 'var(--bg-surface)',
            color: focusPid ? FOCUS_VIOLET : 'var(--text)',
            border: `1px solid ${focusPid
              ? `color-mix(in srgb, ${FOCUS_VIOLET} 45%, transparent)` : 'var(--border)'}`,
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
              className="fr-field"
              title={genFillMode === 'obligatory'
                ? 'Fill only obligatory call slots — each provider receives at most their rounded call obligation at the site par (par-authoritative); the rest stay open as the paid-pickup layer.'
                : genFillMode === 'weekend-only'
                  ? 'Fill only the weekend call schedule (Fri/Sat/Sun + chained shifts) now; press Continue in the result banner to fill the rest.'
                  : 'Fill all open slots with the available pool (default).'}
              style={{
                padding: '7px 10px', fontSize: 12.5, fontWeight: 600,
                borderRadius: 'var(--radius-md)',
                background: 'var(--bg-surface)', color: 'var(--text-muted)',
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
              className="fr-field"
              title={genFillMode === 'weekend-only'
                ? 'Weekend call only already scopes the run.'
                : dayScope === 'weekday'
                  ? 'Attempt only M–Th call slots (holidays included). Fri/Sat/Sun are left untouched for a later run.'
                  : dayScope === 'weekend'
                    ? 'Attempt only Fri/Sat/Sun call slots. Weekdays are left for a later run.'
                    : 'Attempt every call slot in the block (default).'}
              style={{
                padding: '7px 10px', fontSize: 12.5, fontWeight: 600,
                borderRadius: 'var(--radius-md)',
                background: 'var(--bg-surface)', color: 'var(--text-muted)',
                border: '1px solid var(--border)',
                cursor: generating || genFillMode === 'weekend-only' ? 'not-allowed' : 'pointer',
                opacity: genFillMode === 'weekend-only' ? 0.5 : 1,
              }}
            >
              <option value="">Whole block</option>
              <option value="weekday">Weekday calls (M–Th)</option>
              <option value="weekend">Weekend calls (Fri–Sun)</option>
            </select>
            {/* Neuro weekends as a SEPARATE run (Gabriel 2026-09-22). A third
                control rather than more options on the day scope, because this
                filters on the CODE and that one filters on the DAY — and the
                useful sequence is "everything except neuro" now, "neuro only"
                afterwards, which one enum could not hold.

                At a site whose pattern states no neuro code the run covers
                the whole block and says so in a warning on the result banner
                — the refusal lives in autoGenerate, where the pattern is
                actually loaded, rather than being guessed at here. */}
            <select
              value={neuroScope}
              onChange={e => setNeuroScope(
                e.target.value === 'only' || e.target.value === 'exclude' ? e.target.value : '')}
              disabled={generating}
              aria-label="Neuro weekend scope"
              className="fr-field"
              title={neuroScope === 'only'
                ? 'Attempt ONLY the neuro weekend calls. Everything else is left for another run.'
                : neuroScope === 'exclude'
                  ? 'Attempt every call EXCEPT neuro. The neuro weekends stay open for their own run.'
                  : 'Neuro weekends fill along with everything else (default).'}
              style={{
                padding: '7px 10px', fontSize: 12.5, fontWeight: 600,
                borderRadius: 'var(--radius-md)',
                background: 'var(--bg-surface)', color: 'var(--text-muted)',
                border: '1px solid var(--border)',
                cursor: generating ? 'not-allowed' : 'pointer',
              }}
              >
              <option value="">Neuro with the rest</option>
              <option value="exclude">Exclude neuro</option>
              <option value="only">Neuro only</option>
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
                  background: `color-mix(in srgb, ${FOCUS_VIOLET} 15%, transparent)`,
                  color: FOCUS_VIOLET,
                  border: `1px solid color-mix(in srgb, ${FOCUS_VIOLET} 45%, transparent)`,
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
                    <span style={{ color: over.length ? 'var(--danger)' : 'inherit' }}>{over.length} over</span>,{' '}
                    <span style={{ color: under.length ? 'var(--warn)' : 'inherit' }}>{under.length} under</span>{' '}
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
                            <b style={{ color: r.delta > 0 ? 'var(--danger)' : 'var(--warn)' }}>
                              {r.delta > 0 ? `over ${r.delta}` : `under ${-r.delta}`}
                            </b>
                            {/* Completeness (work-to-required): idle days classified,
                                never silent, never conflated — engine gap (an open
                                compatible slot remained) vs staffing reality. */}
                            {r.shortfall && (
                              <span>
                                {r.shortfall.engineGapDates.length > 0 && (
                                  <>
                                    {' '}· <b style={{ color: 'var(--danger)' }}>under-scheduled: engine gap</b>{' '}
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
                      <b style={{ color: r.placed >= r.cap ? 'var(--warn)' : 'inherit' }}>
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
        background: gridTokens.bodyCell, // data cell background
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
            background: gridTokens.chrome, borderBottom: '1px solid ' + gridTokens.chromeBorder,
            borderRight: '1px solid ' + gridTokens.chromeBorder, padding: '6px 12px',
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
                background: isHoliday ? GRID_INK.holidayChrome : isWeekend ? gridTokens.chromeWeekend : gridTokens.chrome,
                borderBottom: '1px solid ' + gridTokens.chromeBorder,
                borderRight: '1px solid ' + gridTokens.chromeBorder,
                borderLeft: isToday ? '2px solid ' + gridTokens.accent : isSatBorder ? '2px solid rgba(30,58,95,0.6)' : 'none',
                padding: '2px 6px', textAlign: 'center',
                fontSize: 10, fontWeight: 700,
                color: isHoliday ? GRID_INK.holidayOnChrome : isWeekend ? GRID_INK.weekendChrome : gridTokens.chromeMuted,
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
            background: gridTokens.chrome, borderBottom: '2px solid ' + gridTokens.chromeBorder,
            borderRight: '1px solid ' + gridTokens.chromeBorder, padding: '2px 10px',
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
                background: holiday ? GRID_INK.holidayChrome : isWeekend ? gridTokens.chromeWeekend : gridTokens.chrome,
                borderBottom: '2px solid ' + gridTokens.chromeBorder,
                borderRight: '1px solid ' + gridTokens.chromeBorder,
                borderLeft: isToday ? '2px solid ' + gridTokens.accent : isSatBorder ? '2px solid rgba(30,58,95,0.6)' : 'none',
                padding: '2px 6px', textAlign: 'center',
                fontSize: 12.5, fontWeight: 700,
                color: isToday ? gridTokens.accent : holiday ? GRID_INK.holidayOnChrome : gridTokens.chromeText,
                boxShadow: isToday ? 'inset 0 -3px 0 ' + gridTokens.accentStrong : undefined,
              }}>
                {formatMMDD(date)}
                {holiday && (
                  <div style={{ fontSize: 9, color: GRID_INK.holidayOnChrome, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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
                    fontSize: 9, fontWeight: 700, color: gridTokens.chromeMuted, marginTop: 2,
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
                borderBottom: '1px solid ' + gridTokens.chromeBorder,
                borderRight: '1px solid ' + gridTokens.chromeBorder,
                padding: '2px 8px', display: 'flex', flexDirection: 'column', justifyContent: 'center',
                minHeight: 20,
              }}>
                <div style={{ fontSize: 13, fontWeight: 800, color: gridTokens.chromeText, whiteSpace: 'nowrap' }}>{st.code}</div>
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
                        borderLeft: isToday ? '2px solid ' + gridTokens.accentStrong : isSatBorder ? '2px solid ' + gridTokens.chromeBorder : 'none',
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
                                color: GRID_INK.over, flexShrink: 0,
                              }}>OVER</span>
                            ) : segExtra ? (
                              <span aria-label="Extra call" style={{
                                fontSize: 6.5, fontWeight: 800, letterSpacing: '0.03em',
                                color: GRID_INK.extra, flexShrink: 0,
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
                      borderLeft: isToday ? '2px solid ' + gridTokens.accentStrong : isSatBorder ? '2px solid ' + gridTokens.chromeBorder : 'none',
                      padding: '1px 3px',
                      minHeight: 20,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      cursor: slot ? 'pointer' : 'default',
                      position: 'relative',
                      transition: 'background var(--dur-instant) var(--ease-out)',
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
                        color: GRID_INK.over, pointerEvents: 'none',
                      }}>OVER</span>
                    ) : isExtraCall ? (
                      <span aria-label="Extra call" style={{
                        position: 'absolute', bottom: 1, right: 3,
                        fontSize: 8, fontWeight: 800, letterSpacing: '0.5px',
                        color: GRID_INK.extra, pointerEvents: 'none',
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
                          fontSize: 9, fontWeight: 900, lineHeight: 1, color: GRID_INK.onSolid,
                          background: hardFlag ? gridTokens.hard : gridTokens.soft,
                          boxShadow: '0 0 4px ' + colorWithAlpha(hardFlag ? gridTokens.hard : gridTokens.soft, 0.6),
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
            borderRadius: 'var(--radius-lg)',
            boxShadow: 'var(--shadow-popover)',
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
                    padding: '7px 9px', borderRadius: 'var(--radius-md)', cursor: 'pointer',
                    border: '1px solid ' + (selected ? 'var(--text-dim)' : 'var(--border)'),
                    background: selected ? 'var(--bg-deep)' : 'transparent',
                    color: 'var(--text)', fontSize: 12.5, fontWeight: 700, textAlign: 'left',
                    transition: 'background var(--dur-fast) var(--ease-out),'
                      + ' border-color var(--dur-fast) var(--ease-out)',
                  }}
                  // Inline hover: `background` is set inline just above (the
                  // selected row carries its own fill), so a CSS :hover could
                  // never win here. Restores to whichever ground this row owns.
                  onMouseEnter={e => {
                    e.currentTarget.style.background = 'var(--tint-surface)';
                    e.currentTarget.style.borderColor = 'var(--border-strong)';
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.background = selected ? 'var(--bg-deep)' : 'transparent';
                    e.currentTarget.style.borderColor = selected ? 'var(--text-dim)' : 'var(--border)';
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
              className="fr-btn fr-btn-secondary"
              onClick={() => setCellComment(paletteCell.assignmentId, paletteCell.note)}
              style={{
                display: 'flex', alignItems: 'center', gap: 9,
                padding: '7px 9px', borderRadius: 'var(--radius-md)', marginTop: 6,
                cursor: 'pointer',
                fontSize: 12.5, textAlign: 'left',
              }}
            >
              <span aria-hidden style={{ width: 18, textAlign: 'center', fontSize: 13 }}>&#128172;</span>
              <span style={{ flex: 1 }}>{paletteCell.note ? 'Edit comment…' : 'Add comment…'}</span>
            </button>
            <button
              role="menuitem"
              onClick={() => setHighlight(paletteCell.assignmentId, null)}
              disabled={paletteCell.current === null}
              className="fr-btn fr-btn-secondary"
              style={{
                display: 'flex', alignItems: 'center', gap: 9,
                padding: '7px 9px', borderRadius: 'var(--radius-md)', marginTop: 2,
                cursor: paletteCell.current === null ? 'default' : 'pointer',
                fontSize: 12.5, textAlign: 'left',
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
            borderRadius: 'var(--radius-lg)',
            boxShadow: 'var(--shadow-popover)',
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
                  background: 'var(--danger-bg)',
                  border: '1px solid color-mix(in srgb, var(--danger) 28%, transparent)',
                  maxHeight: 140, overflowY: 'auto',
                }}>
                  <div style={{
                    fontSize: 10, fontWeight: 700, letterSpacing: 0.5,
                    color: 'var(--danger)', textTransform: 'uppercase', marginBottom: 6,
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
              {/* Popover actions on .fr-btn-* rather than hand-rolled colour.
                  None of these had a hover, a press or a focus ring, and the
                  destructive one was #f87171 — the DARK-theme danger — sitting
                  on a light popover at ~2.7:1. The classes hold background,
                  colour and border in CSS, which is the ONLY arrangement in
                  which their :hover can beat an inline style. So nothing below
                  sets those three inline; `textAlign` and padding are layout
                  and are safe to keep. */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <button
                  className="fr-btn fr-btn-danger"
                  onClick={() => activeAssignment && removeAssignment(activeAssignment.id)}
                  style={{
                    padding: '9px 12px', fontSize: 12.5,
                    borderRadius: 'var(--radius-md)', cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  Remove Assignment
                </button>
                <button
                  className="fr-btn fr-btn-secondary"
                  onClick={() => {
                    if (activeSlot) toggleLock(activeSlot.id, activeSlot.locked);
                  }}
                  style={{
                    padding: '9px 12px', fontSize: 12.5,
                    borderRadius: 'var(--radius-md)', cursor: 'pointer',
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
                    className="fr-btn fr-btn-secondary"
                    onClick={() => unsplitSlot(activeSlot.id)}
                    style={{
                      padding: '9px 12px', fontSize: 12.5,
                      borderRadius: 'var(--radius-md)', cursor: 'pointer',
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
                      className="fr-btn fr-btn-secondary"
                      style={{
                        width: '100%', padding: '8px 12px', fontSize: 12,
                        borderRadius: 'var(--radius-md)', cursor: 'pointer',
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
                      className="fr-btn fr-btn-secondary"
                      style={{
                        flex: 1, padding: '8px 10px', fontSize: 12,
                        borderRadius: 'var(--radius-md)', cursor: 'pointer',
                      }}
                    >
                      Split 2×12h
                    </button>
                    <button
                      onClick={() => splitSlot(activeSlot.id, '3x8')}
                      title="Split this call into three 8-hour segments (07-15, 15-23, 23-07). Each segment counts one third of a call."
                      className="fr-btn fr-btn-secondary"
                      style={{
                        flex: 1, padding: '8px 10px', fontSize: 12,
                        borderRadius: 'var(--radius-md)', cursor: 'pointer',
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
                  className="fr-field"
                  type="text"
                  placeholder="Search providers..."
                  value={pickerSearch}
                  onChange={e => setPickerSearch(e.target.value)}
                  style={{
                    width: '100%', padding: '8px 11px', fontSize: 12.5,
                    borderRadius: 'var(--radius-md)',
                    border: '1px solid var(--border)', background: 'var(--bg-deep)',
                    color: 'var(--text)', boxSizing: 'border-box',
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
                    border: '1px solid color-mix(in srgb, var(--warn) 35%, transparent)', background: 'var(--warn-bg)',
                    fontSize: 10.5, lineHeight: 1.45, color: 'var(--warn)',
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
                      tone="var(--warn)"
                    />
                    {pickerGroups.soft.map(c => (
                      <PickerRow key={c.provider.id} candidate={c} onPick={pickCandidate} />
                    ))}
                  </>
                )}

                {pickerGroups && pickerGroups.blocked.length > 0 && (
                  <>
                    <button
                      className="fr-btn fr-btn-secondary"
                      aria-expanded={showBlockedCandidates}
                      onClick={() => setShowBlockedCandidates(v => !v)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 6, width: 'calc(100% - 20px)',
                        margin: '8px 10px 2px', padding: '6px 8px',
                        borderRadius: 'var(--radius-md)',
                        fontSize: 10.5, letterSpacing: 0.5,
                        textTransform: 'uppercase', cursor: 'pointer',
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
  const accent = group === 'blocked' ? 'var(--danger)'
    : group === 'soft' ? 'var(--warn)' : 'var(--blue)';
  return (
    <div
      onClick={() => onPick(candidate)}
      // The full reason list on hover; the row itself shows the leading one.
      title={[...reasonTexts, ...(release ? [release.text] : [])].join(' · ')}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px', borderRadius: 8, cursor: 'pointer',
        opacity: dimmed ? 0.62 : 1, transition: 'background var(--dur-instant) var(--ease-out)',
      }}
      onMouseEnter={e => (e.currentTarget.style.background = 'var(--tint-surface)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
    >
      <div style={{
        width: 28, height: 28, borderRadius: '50%', fontSize: 10.5, fontWeight: 800,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: group === 'available'
          ? 'color-mix(in srgb, var(--blue) 16%, transparent)'
          : 'var(--tint-surface-strong)',
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
            fontSize: 10.5, color: 'var(--warn)', whiteSpace: 'nowrap',
            overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {release.text}
          </div>
        )}
      </div>
      <span style={{
        fontSize: 9, fontWeight: 800, padding: '2px 6px', borderRadius: 4,
        background: 'var(--tint-surface-strong)', color: 'var(--text-dim)',
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
        borderBottom: '1px solid ' + gridTokens.chromeBorder,
        borderRight: '1px solid ' + gridTokens.chromeBorder,
        ...(zoneTop && isFirstRow ? { borderTop: '2px solid ' + GRID_INK.zoneRuleChrome } : {}),
        padding: '2px 8px', display: 'flex', alignItems: 'center',
        minHeight: 18,
      }}>
        <div style={{ fontSize: 11.5, fontWeight: 700, color: gridTokens.chromeText, whiteSpace: 'nowrap' }}>
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
          borderLeft: isToday ? '2px solid ' + gridTokens.accentStrong : isSatBorder ? '2px solid ' + gridTokens.chromeBorder : 'none',
          ...(zoneTop && isFirstRow ? { borderTop: '2px solid ' + GRID_INK.zoneRuleBody } : {}),
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
