// Dashboard data layer: one loadDashboardData(sb) doing ≤6 logical selects,
// plus the pure aggregation functions it feeds (unit-tested with canned rows).
//
// Fail-soft per panel: every query's `error` is checked and surfaced on that
// panel's { data, error } envelope — a failed panel renders an error Banner,
// never fake zeros (same no-silent-clean ethos as EvaluateResult.evaluated).
//
// Transport truncation: PostgREST silently caps un-ranged selects at 1000
// rows (no error!). Count-style panels therefore use head-only exact counts,
// the attention rollup paginates with .range() until the exact count is
// assembled, and row-fetching selects carry a count guard — a truncated or
// partial result becomes a panel error, never an undercount rendered as fact.
//
// Validation-flag semantics are IMPORTED from the grid route helpers, not
// reimplemented: null flags = never validated (distinct from checked-and-
// clean), and 'warning' severity never counts as a hard violation.

import { validationSummaryFor } from '@/app/api/scheduling/schedules/[id]/grid/route.helpers';
import {
  computeSiteCallObligation,
  type ObligationTemplate,
  type SiteCallObligation,
} from '@/lib/siteCallObligation';
import { assignmentFills } from '@/lib/plannerMath';

// Same loose client type the other DB-coupled modules use at this seam
// (rulesEngine/shared.ts, scheduleAssistant/assistant.ts) — supabase-js's
// schema generic ('scheduling' vs 'public') otherwise rejects the injected
// client and the test fake alike.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SchedulingClient = any;

// ── Row shapes (mirror the select strings below) ─────────────────────────────

export interface ScheduleRow {
  /** 'physician' | 'crna' | 'both' — how the dashboard splits the list. */
  provider_group?: string | null;
  id: string;
  schedule_name: string;
  status: string; // scheduling.schedule_status: draft | review | published | revised | archived
  date_start: string;
  date_end: string;
  // Maintained by the schedules POST (v1) and versions POST (bump) routes —
  // scopes the attention rollup to each schedule's latest version.
  current_version_number: number;
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
  // A slot's shift_type is a to-one FK (mirrors TodaysCallSlotRow.shift_types
  // above) — always a single object or null, never an array; no asArray()
  // needed here.
  shift_types: { category: string } | null;
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
export interface MixRow {
  fte_value: number | string | null;
  call_taker: boolean | null;
  employment_status: string | null;
  providers: { provider_type?: string | null } | Array<{ provider_type?: string | null }> | null;
}

/**
 * The four staffing figures, from employment profiles.
 *
 * Two are ΣFTE and two are headcount, deliberately: "how much call capacity is
 * there" and "how many CRNAs' worth of coverage" are FTE questions, while
 * "how many part-timers" and "how many per diems" are questions about people.
 *
 * fte_value arrives from a Postgres numeric as a STRING through PostgREST, so
 * it is coerced rather than added — string concatenation here would silently
 * produce something like "1.000.750.70".
 */
export function summarizeMix(rows: readonly MixRow[]): ProviderMix {
  const mix: ProviderMix = {
    callTakerFte: 0, callTakerCount: 0,
    crnaFte: 0, crnaCount: 0,
    partTimePhysicians: 0, perDiem: 0,
  };

  for (const r of rows) {
    const rel = r.providers;
    const p = (Array.isArray(rel) ? rel[0] : rel) ?? {};
    const type = p.provider_type ?? '';
    const fteNum = Number(r.fte_value);
    const fte = Number.isFinite(fteNum) && fteNum > 0 ? fteNum : 0;

    if (r.call_taker) { mix.callTakerFte += fte; mix.callTakerCount++; }
    // AAs work the CRNA slate (slotCandidates admits both for a 'crna' slot),
    // so they are counted with them rather than vanishing from every figure.
    if (type === 'crna' || type === 'aa') { mix.crnaFte += fte; mix.crnaCount++; }
    if (type === 'physician' && r.employment_status === 'part_time') mix.partTimePhysicians++;
    if (r.employment_status === 'per_diem') mix.perDiem++;
  }

  // ΣFTE accumulates float error across ~290 rows, so it is rounded — to TWO
  // decimals, not one. Quarter FTEs are real contracts here (0.75, 0.25), and
  // one decimal turns a roster of 2.25 into 2.3; Gabriel quotes these figures
  // to two places ("8.82 FTE").
  mix.callTakerFte = Math.round(mix.callTakerFte * 100) / 100;
  mix.crnaFte = Math.round(mix.crnaFte * 100) / 100;
  return mix;
}

export function summarizeSchedules(rows: Array<{ status: string }>): Record<string, number> {
  const byStatus: Record<string, number> = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  return byStatus;
}

// An assignment "fills" its slot only when it carries a provider and hasn't
// been canceled/declined (mirrors the grid's OPEN-cell rendering). The
// predicate moved to lib/plannerMath.ts (assignmentFills, imported above) so
// the Physician Planner's actuals share it — the CROSS-LINK note about the
// assistant's divergent filled-predicate lives with it there.
const fills = assignmentFills;

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
    // Unfilled counter is call-only (day/float/admin slots being open is
    // normal scheduler workflow, not a rollup warning — Gabriel 2026-07-14).
    // assigned/checked/hard stay category-blind below: they aggregate real
    // assignments and violations, which remain meaningful for day slots.
    if (row.shift_types?.category === 'call' && !assignments.some(fills)) entry.unfilled++;
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

// ── loadDashboardData ────────────────────────────────────────────────────────

export interface Panel<T> {
  data: T | null;
  error: string | null;
}

export type AttentionPanelEntry = AttentionEntry & { schedule_name: string; status: string };

/** The four staffing figures the dashboards head with. */
export interface ProviderMix {
  /** ΣFTE across call takers — capacity, not headcount. */
  callTakerFte: number;
  callTakerCount: number;
  /** ΣFTE across CRNAs. */
  crnaFte: number;
  crnaCount: number;
  /** Headcount: physicians on a part-time contract. */
  partTimePhysicians: number;
  /** Headcount: anyone per diem, physician or CRNA. */
  perDiem: number;
}

export interface DashboardData {
  today: string;
  providerMix: Panel<ProviderMix>;
  providers: Panel<number>;
  sites: Panel<number>;
  schedules: Panel<{ byStatus: Record<string, number>; rows: ScheduleRow[] }>;
  todaysCall: Panel<CallEntry[]>;
  pendingRequests: Panel<number>;
  attention: Panel<AttentionPanelEntry[]>;
}

const SCHEDULE_COLUMNS = 'id, schedule_name, status, date_start, date_end, current_version_number, provider_group';

// Join shapes mirror the grid/master-schedule routes (explicit columns, no '*').
const TODAYS_CALL_COLUMNS =
  'id, slot_date, sites(name, short_name), shift_types!inner(code, name, category, display_order), assignments(provider_id, assignment_status, providers(last_name, short_display_name, initials)), schedule_versions!inner(schedule_id, version_number, version_status, schedules!inner(status))';

const ATTENTION_COLUMNS =
  'id, assignments(provider_id, assignment_status, validation_flags), shift_types(category), schedule_versions!inner(schedule_id, version_number)';

// PostgREST's silent per-request row cap; also the .range() page size for the
// rollup. Live repro: 2,201 matching slot rows returned exactly 1,000 with no
// error until pagination was added.
const PAGE_SIZE = 1000;
const MAX_PAGES = 50;

function panel<T>(data: T | null, error: { message?: string } | null, label: string): Panel<T> {
  if (error) return { data: null, error: `${label}: ${error.message ?? 'query failed'}` };
  return { data, error: null };
}

// A head-only { count: 'exact' } result → Panel<number>. A null count without
// an error is a transport anomaly — surfaced, never rendered as zero.
function countPanel(
  res: { count: number | null; error: { message?: string } | null },
  label: string,
): Panel<number> {
  if (res.error) return panel<number>(null, res.error, label);
  if (res.count == null) return { data: null, error: `${label}: count unavailable` };
  return { data: res.count, error: null };
}

// Row-fetching select guard: rows are the data, count proves completeness.
// Returns an error message when the reported count says the page was cut off.
function truncationOf(
  res: { data: unknown; count: number | null },
  label: string,
): string | null {
  const len = Array.isArray(res.data) ? res.data.length : 0;
  if (res.count != null && len < res.count) {
    return `${label}: results truncated (${len} of ${res.count} rows)`;
  }
  return null;
}

// Fetches every attention-rollup row for the given schedules' CURRENT
// versions, paginating past the row cap. Any failure or shortfall mid-way
// returns an error — never a partial aggregate.
async function fetchRollupRows(
  sb: SchedulingClient,
  schedules: ScheduleRow[],
): Promise<{ rows: AttentionSlotRow[]; errorMsg: null } | { rows: null; errorMsg: string }> {
  // Latest-version scoping: (schedule_id, current_version_number) pairs on
  // the embedded (inner-joined) schedule_versions. Only latest-version rows
  // survive attentionFor anyway; this keeps the transfer to what's rendered.
  // NOTE: the assistant resolves the same "latest version" differently —
  // max(version_number) in loadScheduleCtx (src/lib/scheduleAssistant/tools.ts)
  // vs this denormalized column; identical as long as current_version_number
  // is maintained on version creation.
  const scope = schedules
    .map(s => `and(schedule_id.eq.${s.id},version_number.eq.${s.current_version_number})`)
    .join(',');

  const rows: AttentionSlotRow[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE;
    const res = await sb
      .from('schedule_slots')
      .select(ATTENTION_COLUMNS, { count: 'exact' })
      .or(scope, { referencedTable: 'schedule_versions' })
      .order('id') // stable order — required for coherent .range() pages
      .range(from, from + PAGE_SIZE - 1);
    if (res.error) return { rows: null, errorMsg: res.error.message ?? 'query failed' };
    if (res.count == null) return { rows: null, errorMsg: 'row count unavailable (possible truncation)' };
    const batch = (res.data ?? []) as AttentionSlotRow[];
    rows.push(...batch);
    if (rows.length >= res.count) return { rows, errorMsg: null };
    if (batch.length === 0) {
      return { rows: null, errorMsg: `pagination stalled at ${rows.length} of ${res.count} rows` };
    }
  }
  return { rows: null, errorMsg: `rollup exceeded ${MAX_PAGES}-page budget` };
}

/**
 * All dashboard reads in ≤6 logical selects (the attention rollup may issue
 * continuation pages of its one select). `today` defaults to the same UTC
 * date-string convention the board's page.tsx uses.
 */
export async function loadDashboardData(
  sb: SchedulingClient,
  today: string = new Date().toISOString().split('T')[0],
  /**
   * Scope every panel to one site. Omitted (or null) keeps the whole-group
   * view, byte-identical to what this returned before site scoping existed.
   *
   * Providers are scoped by their HOME SITE, which is the only site a provider
   * record names. A provider credentialed at a site but homed elsewhere is
   * therefore not counted here — deliberate, since the count answers "how big
   * is this site's group", not "who could theoretically work here".
   */
  siteId?: string | null,
): Promise<DashboardData> {
  const scoped = !!siteId;

  // 5 independent selects in parallel. Counts are head-only + exact — a row
  // fetch counted client-side silently understates past the 1000-row cap.
  let providersQ = sb.from('providers').select(
    scoped ? 'id, provider_employment_profiles!inner(home_site_id)' : 'id',
    { count: 'exact', head: true },
  ).eq('status', 'active');
  if (siteId) providersQ = providersQ.eq('provider_employment_profiles.home_site_id', siteId);

  let sitesQ = sb.from('sites').select('id', { count: 'exact', head: true }).eq('is_active', true);
  if (siteId) sitesQ = sitesQ.eq('id', siteId);

  let schedulesQ = sb
    .from('schedules')
    .select(SCHEDULE_COLUMNS, { count: 'exact' })
    .neq('status', 'archived')
    .order('date_start', { ascending: false });
  if (siteId) schedulesQ = schedulesQ.eq('site_id', siteId);

  let todayQ = sb
    .from('schedule_slots')
    .select(TODAYS_CALL_COLUMNS, { count: 'exact' })
    .eq('slot_date', today)
    .eq('shift_types.category', 'call')
    .eq('schedule_versions.version_status', 'published');
  if (siteId) todayQ = todayQ.eq('site_id', siteId);

  // Pending requests carry their own site_id, but a request raised before a
  // site was chosen has none. Those are group-level and stay out of a site
  // view rather than being attributed to an arbitrary site.
  let pendingQ = sb
    .from('provider_availability')
    .select('id', { count: 'exact', head: true })
    .eq('approval_status', 'pending');
  if (siteId) pendingQ = pendingQ.eq('site_id', siteId);

  const [providersRes, sitesRes, schedulesRes, todayRes, pendingRes] = await Promise.all([
    providersQ, sitesQ, schedulesQ, todayQ, pendingQ,
  ]);

  const schedulesTrunc = schedulesRes.error ? null : truncationOf(schedulesRes, 'Schedules');
  const scheduleRows = (schedulesRes.data ?? []) as ScheduleRow[];
  const schedules: DashboardData['schedules'] = schedulesRes.error
    ? panel<{ byStatus: Record<string, number>; rows: ScheduleRow[] }>(null, schedulesRes.error, 'Schedules')
    : schedulesTrunc
      ? { data: null, error: schedulesTrunc }
      : { data: { byStatus: summarizeSchedules(scheduleRows), rows: scheduleRows }, error: null };

  const todayTrunc = todayRes.error ? null : truncationOf(todayRes, "Today's call");
  const todaysCallPanel: DashboardData['todaysCall'] = todayRes.error
    ? panel<CallEntry[]>(null, todayRes.error, "Today's call")
    : todayTrunc
      ? { data: null, error: todayTrunc }
      : { data: todaysCall((todayRes.data ?? []) as unknown as TodaysCallSlotRow[]), error: null };

  // 6th logical select: attention rollup over the active schedules found
  // above (paginated). Skipped (not faked) when the schedules panel failed;
  // skipped as genuinely empty when there are no active schedules.
  let attention: DashboardData['attention'];
  if (schedules.error) {
    attention = { data: null, error: 'Needs attention: schedules could not be loaded' };
  } else if (scheduleRows.length === 0) {
    attention = { data: [], error: null };
  } else {
    const rollup = await fetchRollupRows(sb, scheduleRows);
    if (rollup.rows === null) {
      attention = { data: null, error: `Needs attention: ${rollup.errorMsg}` };
    } else {
      const rolled = new Map(attentionFor(rollup.rows).map(e => [e.schedule_id, e]));
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

  // ── Staffing mix ─────────────────────────────────────────────────────────
  // ΣFTE cannot be done in PostgREST without an RPC, so the rows come back and
  // are summed here. That makes the row cap a correctness problem rather than a
  // performance one: a truncated read would understate ΣFTE and look plausible,
  // so the count is checked and a shortfall becomes a panel error.
  let mixQ = sb
    .from('provider_employment_profiles')
    .select('fte_value, call_taker, employment_status, providers!inner(provider_type, status, organization_id)',
      { count: 'exact' })
    .eq('providers.status', 'active');
  if (siteId) mixQ = mixQ.eq('home_site_id', siteId);
  const mixRes = await mixQ.range(0, PAGE_SIZE - 1);

  const mixTrunc = mixRes.error ? null : truncationOf(mixRes, 'Staffing mix');
  const mixPanel: Panel<ProviderMix> = mixRes.error
    ? panel<ProviderMix>(null, mixRes.error, 'Staffing mix')
    : mixTrunc
      ? { data: null, error: mixTrunc }
      : { data: summarizeMix((mixRes.data ?? []) as unknown as MixRow[]), error: null };

  return {
    today,
    providerMix: mixPanel,
    providers: countPanel(providersRes, 'Providers'),
    sites: countPanel(sitesRes, 'Sites'),
    schedules,
    todaysCall: todaysCallPanel,
    pendingRequests: countPanel(pendingRes, 'Pending requests'),
    attention,
  };
}

// ── Annual call obligation (site pages only) ───────────────────────────────

/**
 * A site's annual call load, simulated through the SAME helpers that
 * materialize real slots — see siteCallObligation.ts for why a naive template
 * read gets Fridays wrong.
 *
 * Separate from loadDashboardData because only the site pages show it and it
 * costs two extra reads; the group view would pay for something it never
 * renders.
 */
export async function loadSiteCallObligation(
  sb: SchedulingClient,
  siteId: string,
  year: number,
): Promise<Panel<SiteCallObligation>> {
  const [siteRes, tmplRes, holRes] = await Promise.all([
    sb.from('sites').select('call_par_level').eq('id', siteId).maybeSingle(),
    sb
      .from('shift_templates')
      .select('day_type, shift_type_id, required_count, shift_types!inner(code, category, parent_call_code)',
        { count: 'exact' })
      .eq('site_id', siteId)
      .eq('is_active', true),
    sb
      .from('holiday_calendars')
      .select('holiday_date, is_major_holiday', { count: 'exact' })
      .gte('holiday_date', `${year}-01-01`)
      .lte('holiday_date', `${year}-12-31`),
  ]);

  if (siteRes.error) return panel<SiteCallObligation>(null, siteRes.error, 'Call obligation');
  if (tmplRes.error) return panel<SiteCallObligation>(null, tmplRes.error, 'Call obligation');
  if (holRes.error) return panel<SiteCallObligation>(null, holRes.error, 'Call obligation');

  // A truncated template or holiday read would silently understate the year.
  const trunc = truncationOf(tmplRes, 'Call obligation (templates)')
    ?? truncationOf(holRes, 'Call obligation (holidays)');
  if (trunc) return { data: null, error: trunc };

  const templates: ObligationTemplate[] = [];
  for (const row of (tmplRes.data ?? []) as Array<Record<string, unknown>>) {
    const rel = row.shift_types;
    const st = (Array.isArray(rel) ? rel[0] : rel) as
      { code?: string; category?: string; parent_call_code?: string | null } | undefined;
    if (!st || st.category !== 'call') continue;
    templates.push({
      code: st.code ?? '',
      parent_call_code: st.parent_call_code ?? null,
      day_type: row.day_type,
      shift_type_id: row.shift_type_id,
      required_count: row.required_count,
    });
  }

  const holidays = new Map<string, { is_major_holiday: boolean; holiday_type: string }>();
  for (const h of (holRes.data ?? []) as Array<Record<string, unknown>>) {
    holidays.set(h.holiday_date as string, {
      is_major_holiday: !!h.is_major_holiday,
      holiday_type: '',
    });
  }

  // `?? 12` mirrors the column default; plannerMath applies the same fallback.
  const parLevel = Number((siteRes.data as { call_par_level?: number } | null)?.call_par_level ?? 12);

  return {
    data: computeSiteCallObligation({ year, parLevel, templates, holidays }),
    error: null,
  };
}
