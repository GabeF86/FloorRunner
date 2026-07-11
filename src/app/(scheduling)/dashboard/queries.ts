// Dashboard data layer: one loadDashboardData(sb) doing ≤6 selects, plus the
// pure aggregation functions it feeds (unit-tested with canned rows).
//
// Fail-soft per panel: every query's `error` is checked and surfaced on that
// panel's { data, error } envelope — a failed panel renders an error Banner,
// never fake zeros (same no-silent-clean ethos as EvaluateResult.evaluated).
//
// Validation-flag semantics are IMPORTED from the grid route helpers, not
// reimplemented: null flags = never validated (distinct from checked-and-
// clean), and 'warning' severity never counts as a hard violation.

import { validationSummaryFor } from '@/app/api/scheduling/schedules/[id]/grid/route.helpers';

// Same loose client type the other DB-coupled modules use at this seam
// (rulesEngine/shared.ts, scheduleAssistant/assistant.ts) — supabase-js's
// schema generic ('scheduling' vs 'public') otherwise rejects the injected
// client and the test fake alike.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SchedulingClient = any;

// ── Row shapes (mirror the select strings below) ─────────────────────────────

export interface ScheduleRow {
  id: string;
  schedule_name: string;
  status: string; // scheduling.schedule_status: draft | review | published | revised | archived
  date_start: string;
  date_end: string;
}

// PostgREST embeds slot→assignments as an ARRAY on databases without the
// UNIQUE(schedule_slot_id) constraint and as a single OBJECT on databases
// with it (migration 20260524000000, see the patch18 preamble). Both row
// shapes are accepted here — asArray() normalizes at the aggregation seam.
type OneOrMany<T> = T[] | T | null | undefined;

function asArray<T>(v: OneOrMany<T>): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

interface CallAssignment {
  provider_id: string | null;
  assignment_status: string;
  providers: {
    last_name: string | null;
    short_display_name: string | null;
    initials: string | null;
  } | null;
}

export interface TodaysCallSlotRow {
  id: string;
  slot_date: string;
  sites: { name: string | null; short_name: string | null } | null;
  shift_types: {
    code: string;
    name: string | null;
    category: string;
    display_order: number | null;
  } | null;
  assignments: OneOrMany<CallAssignment>;
  schedule_versions: {
    schedule_id: string;
    version_number: number;
    version_status: string;
    schedules: { status: string } | null;
  } | null;
}

interface AttentionAssignment {
  provider_id: string | null;
  assignment_status: string;
  validation_flags: unknown;
}

export interface AttentionSlotRow {
  id: string;
  assignments: OneOrMany<AttentionAssignment>;
  schedule_versions: { schedule_id: string; version_number: number } | null;
}

export interface CallEntry {
  provider_name: string;
  site_name: string;
  code: string;
}

export interface AttentionEntry {
  schedule_id: string;
  unfilled: number;
  hard: number;
  /** Provider-bearing assignments on the latest version. */
  assigned: number;
  /** How many of those have a written validation_flags column (0 with assigned > 0 = never validated, NOT clean). */
  checked: number;
}

// ── Pure aggregation ─────────────────────────────────────────────────────────

/** Counts schedules by status, e.g. { draft: 2, published: 1 }. */
export function summarizeSchedules(rows: Array<{ status: string }>): Record<string, number> {
  const byStatus: Record<string, number> = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  return byStatus;
}

// An assignment "fills" its slot only when it carries a provider and hasn't
// been canceled/declined (mirrors the grid's OPEN-cell rendering).
function fills(a: { provider_id: string | null; assignment_status: string }): boolean {
  return !!a.provider_id && a.assignment_status !== 'canceled' && a.assignment_status !== 'declined';
}

// Natural-order code compare so C2 sorts before C10.
const codeCompare = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

function siteNameOf(row: TodaysCallSlotRow): string {
  return row.sites?.short_name || row.sites?.name || 'Unknown site';
}

/**
 * "Who's on call right now": call-category slots from each schedule's latest
 * PUBLISHED version (archived schedules excluded), flattened to assigned
 * providers and sorted by code (numeric-aware) → site → provider.
 */
export function todaysCall(rows: TodaysCallSlotRow[]): CallEntry[] {
  // Latest published version per schedule (older published versions of the
  // same schedule are superseded, drafts/reviews are not authoritative).
  const latestPublished = new Map<string, number>();
  for (const row of rows) {
    const v = row.schedule_versions;
    if (!v || v.version_status !== 'published') continue;
    if (v.schedules?.status === 'archived') continue;
    const prev = latestPublished.get(v.schedule_id);
    if (prev === undefined || v.version_number > prev) latestPublished.set(v.schedule_id, v.version_number);
  }

  const entries: CallEntry[] = [];
  for (const row of rows) {
    const v = row.schedule_versions;
    if (!v || latestPublished.get(v.schedule_id) !== v.version_number) continue;
    if (v.version_status !== 'published' || v.schedules?.status === 'archived') continue;
    if (row.shift_types?.category !== 'call') continue;
    for (const a of asArray(row.assignments)) {
      if (!fills(a)) continue;
      entries.push({
        provider_name:
          a.providers?.short_display_name || a.providers?.last_name || a.providers?.initials || 'Unknown',
        site_name: siteNameOf(row),
        code: row.shift_types.code,
      });
    }
  }

  entries.sort(
    (a, b) =>
      codeCompare.compare(a.code, b.code) ||
      a.site_name.localeCompare(b.site_name) ||
      a.provider_name.localeCompare(b.provider_name),
  );
  return entries;
}

/**
 * Per-schedule attention rollup over the LATEST version's slots: unfilled
 * slot count + hard-violation count (via validationSummaryFor — warnings
 * never count as hard; null flags count as unchecked, never as clean).
 */
export function attentionFor(rows: AttentionSlotRow[]): AttentionEntry[] {
  const latest = new Map<string, number>();
  for (const row of rows) {
    const v = row.schedule_versions;
    if (!v) continue;
    const prev = latest.get(v.schedule_id);
    if (prev === undefined || v.version_number > prev) latest.set(v.schedule_id, v.version_number);
  }

  const bySchedule = new Map<string, AttentionEntry>();
  for (const row of rows) {
    const v = row.schedule_versions;
    if (!v || latest.get(v.schedule_id) !== v.version_number) continue;
    let entry = bySchedule.get(v.schedule_id);
    if (!entry) {
      entry = { schedule_id: v.schedule_id, unfilled: 0, hard: 0, assigned: 0, checked: 0 };
      bySchedule.set(v.schedule_id, entry);
    }
    const assignments = asArray(row.assignments);
    if (!assignments.some(fills)) entry.unfilled++;
    for (const a of assignments) {
      if (!a.provider_id) continue; // same guard as the grid page's counter
      entry.assigned++;
      const summary = validationSummaryFor(a.validation_flags);
      if (summary === null) continue; // never validated ≠ clean
      entry.checked++;
      entry.hard += summary.hard;
    }
  }
  return [...bySchedule.values()];
}

/** Pending provider_availability rows (PENDING blocks every engine, so it's the actionable inbox count). */
export function pendingCount(rows: Array<{ approval_status: string }> | null | undefined): number {
  return (rows ?? []).filter(r => r.approval_status === 'pending').length;
}

// ── loadDashboardData ────────────────────────────────────────────────────────

export interface Panel<T> {
  data: T | null;
  error: string | null;
}

export type AttentionPanelEntry = AttentionEntry & { schedule_name: string; status: string };

export interface DashboardData {
  today: string;
  providers: Panel<number>;
  sites: Panel<number>;
  schedules: Panel<{ byStatus: Record<string, number>; rows: ScheduleRow[] }>;
  todaysCall: Panel<CallEntry[]>;
  pendingRequests: Panel<number>;
  attention: Panel<AttentionPanelEntry[]>;
}

const SCHEDULE_COLUMNS = 'id, schedule_name, status, date_start, date_end';

// Join shapes mirror the grid/master-schedule routes (explicit columns, no '*').
const TODAYS_CALL_COLUMNS =
  'id, slot_date, sites(name, short_name), shift_types!inner(code, name, category, display_order), assignments(provider_id, assignment_status, providers(last_name, short_display_name, initials)), schedule_versions!inner(schedule_id, version_number, version_status, schedules!inner(status))';

const ATTENTION_COLUMNS =
  'id, assignments(provider_id, assignment_status, validation_flags), schedule_versions!inner(schedule_id, version_number)';

function panel<T>(data: T | null, error: { message?: string } | null, label: string): Panel<T> {
  if (error) return { data: null, error: `${label}: ${error.message ?? 'query failed'}` };
  return { data, error: null };
}

/**
 * All dashboard reads in ≤6 selects. `today` defaults to the same UTC
 * date-string convention the board's page.tsx uses.
 */
export async function loadDashboardData(
  sb: SchedulingClient,
  today: string = new Date().toISOString().split('T')[0],
): Promise<DashboardData> {
  // 5 independent selects in parallel.
  const [providersRes, sitesRes, schedulesRes, todayRes, pendingRes] = await Promise.all([
    sb.from('providers').select('id').eq('status', 'active'),
    sb.from('sites').select('id').eq('is_active', true),
    sb.from('schedules').select(SCHEDULE_COLUMNS).neq('status', 'archived').order('date_start', { ascending: false }),
    sb
      .from('schedule_slots')
      .select(TODAYS_CALL_COLUMNS)
      .eq('slot_date', today)
      .eq('shift_types.category', 'call')
      .eq('schedule_versions.version_status', 'published'),
    sb.from('provider_availability').select('id, approval_status').eq('approval_status', 'pending'),
  ]);

  const scheduleRows = (schedulesRes.data ?? []) as ScheduleRow[];
  const schedules = panel(
    schedulesRes.error ? null : { byStatus: summarizeSchedules(scheduleRows), rows: scheduleRows },
    schedulesRes.error,
    'Schedules',
  );

  // 6th select: attention rollup over the active schedules found above.
  // Skipped (not faked) when the schedules query failed; skipped as genuinely
  // empty when there are no active schedules.
  let attention: DashboardData['attention'];
  if (schedulesRes.error) {
    attention = { data: null, error: 'Needs attention: schedules could not be loaded' };
  } else if (scheduleRows.length === 0) {
    attention = { data: [], error: null };
  } else {
    const rollupRes = await sb
      .from('schedule_slots')
      .select(ATTENTION_COLUMNS)
      .in('schedule_versions.schedule_id', scheduleRows.map(s => s.id));
    if (rollupRes.error) {
      attention = panel<AttentionPanelEntry[]>(null, rollupRes.error, 'Needs attention');
    } else {
      const rolled = new Map(
        attentionFor((rollupRes.data ?? []) as unknown as AttentionSlotRow[]).map(e => [e.schedule_id, e]),
      );
      // Every active schedule gets a card — one with no slot rows yet shows
      // genuine zeros (assigned 0 / unfilled 0 renders as "no slots yet",
      // never as validated-clean).
      const entries = scheduleRows.map(s => ({
        ...(rolled.get(s.id) ?? { schedule_id: s.id, unfilled: 0, hard: 0, assigned: 0, checked: 0 }),
        schedule_name: s.schedule_name,
        status: s.status,
      }));
      attention = { data: entries, error: null };
    }
  }

  return {
    today,
    providers: panel(providersRes.error ? null : (providersRes.data ?? []).length, providersRes.error, 'Providers'),
    sites: panel(sitesRes.error ? null : (sitesRes.data ?? []).length, sitesRes.error, 'Sites'),
    schedules,
    todaysCall: panel(
      todayRes.error ? null : todaysCall((todayRes.data ?? []) as unknown as TodaysCallSlotRow[]),
      todayRes.error,
      "Today's call",
    ),
    pendingRequests: panel(
      pendingRes.error ? null : pendingCount((pendingRes.data ?? []) as Array<{ approval_status: string }>),
      pendingRes.error,
      'Pending requests',
    ),
    attention,
  };
}
