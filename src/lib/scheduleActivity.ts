// "Last activity" for the schedules list (Gabriel 2026-07-27).
//
// WHY THIS EXISTS: the list's `edited` line first shipped reading
// `schedules.updated_at`, and that column does NOT track scheduling work. The
// BEFORE UPDATE trigger (supabase_scheduling_schema.sql:776-803) only fires
// when the schedule ROW changes, and the row is written by exactly one route —
// PATCH /api/scheduling/schedules/[id] (rename, included_provider_ids /
// provider_limits, publish, archive) — plus creation and version creation.
// Everything a scheduler actually does lands elsewhere:
//
//   generation / regeneration → assignments ONLY
//       rulesEngine/commit.ts:232/258/268 (evictions, plan update, plan insert),
//       commit.ts:135 (metadata), dayShiftAutoGen.ts:700/709,
//       batchValidate.ts:414 (validation flags). The generate route reads
//       schedules + schedule_versions and writes neither.
//   manual grid assign / clear → assignments ONLY
//       api/scheduling/schedule-assignments/route.ts (upsert / update / delete
//       + re-insert of the open row), then sequenceAutoFill + neighbour
//       revalidation, all on assignments.
//   assistant assign / clear / revert → assignments ONLY
//       scheduleAssistant/mutations.ts:144/212/215, snapshot.ts:381/408.
//   split / unsplit a call slot → schedule_slots + assignments
//       lib/scheduleSplit.ts:216/237/244 and :312/333/345 (INSERT+DELETE).
//   slot lock / label → schedule_slots ONLY
//       api/scheduling/schedule-slots/[id]/route.ts:19-24.
//
// So on the two drafts worked in most recently, `schedules.updated_at` was
// still byte-identical to `created_at` and the suppression rule (correctly)
// hid the `edited` line — the opposite of useful. Verified against the live DB
// 2026-07-27: v5 row stamp 21:38 on the 26th vs. max assignment stamp 04:16 on
// the 27th; "Paoli 8/10-10/25 V4" 13:12 vs. 22:45.
//
// THE SOURCE, and why it's a MAX rather than any single column:
//   1. schedules.updated_at              — rename / settings / publish / archive.
//   2. max(assignments.updated_at)       — the dominant signal (every case above).
//   3. max(schedule_slots.updated_at)    — the slot lock/label PATCH writes no
//      assignment at all, and split/unsplit is slot-primary.
//   4. schedule_versions.created_at / published_at — belt and braces. Both
//      writers already bump the schedule row too (versions/route.ts:107 sets
//      current_version_number, [id]/route.ts:82+126 on publish), so this rung
//      is redundant in practice; it is free (the version rows are fetched
//      anyway for the version→schedule map) and it keeps a version that
//      somehow carries no slots from reading as "never touched".
// schedule_versions contributes no updated_at because it HAS none — it is
// absent from the trigger array and from the DDL (schema:314-325).
//
// Known blind spot, deliberate: a pure DELETE leaves no timestamp anywhere.
// Clearing a grid cell is fine (the route re-inserts an open row), but if a
// future path only removed slots the stamp would not move. Fixing that needs a
// trigger/audit column, which this read-time derivation is explicitly not.
//
// COST: three extra queries for the WHOLE list, never one per schedule. Two of
// them are PostgREST aggregates, so each returns one row per version, not one
// row per assignment (a 12-week combined draft is ~2-3k assignment rows; the
// list holds dozens of drafts). Each source degrades independently — a failure
// drops that rung and leaves the rest, so the worst case is the pre-fix
// behaviour (schedules.updated_at) rather than a broken list.

import { isMissingColumnError, type SupabaseClient } from './rulesEngine/shared';
import { maxStamp } from './scheduleStamps';

/** The only fields this resolver needs from a `scheduling.schedules` row. */
export interface ScheduleActivityRow {
  id: string;
  updated_at?: string | null;
}

export interface LastActivityResult {
  /** schedule id → latest content-change stamp (verbatim from the DB). */
  lastActivityById: Map<string, string | null>;
  /** Non-fatal degradations, for the server log. Empty = every source read cleanly. */
  warnings: string[];
}

/**
 * `in.(…)` rides in the URL, so a few hundred uuids is ~11 KB and proxies
 * start answering 414. Chunked, which keeps the query count a function of
 * ids/CHUNK (1 for any realistic list) instead of of the list length.
 */
export const ACTIVITY_ID_CHUNK = 150;

const VERSION_SELECT = 'id, schedule_id, created_at, published_at';

// `assignments` carries no schedule or version column — schedule_slot_id is
// its only FK up the chain (schema:348-363) — so the group-by key has to come
// from the to-one slot embed, spread into the parent row. Non-aggregate
// columns in a PostgREST select are the GROUP BY, so this reads
// "max(updated_at) per schedule_version_id".
const ASSIGNMENT_MAX_SELECT = '...schedule_slots!inner(schedule_version_id), updated_at.max()';
const ASSIGNMENT_VERSION_FILTER = 'schedule_slots.schedule_version_id';

// schedule_slots owns schedule_version_id outright, so this one needs no embed.
const SLOT_MAX_SELECT = 'schedule_version_id, updated_at.max()';
const SLOT_VERSION_FILTER = 'schedule_version_id';

type Row = Record<string, unknown>;

/**
 * Resolve each schedule's last content change. Never throws: any query that fails
 * is recorded in `warnings` and its rung is skipped, so the returned map
 * always holds at least `schedules.updated_at` for every id passed in.
 */
export async function loadLastActivity(
  sb: SupabaseClient,
  schedules: ScheduleActivityRow[],
): Promise<LastActivityResult> {
  const warnings: string[] = [];
  const lastActivityById = new Map<string, string | null>();

  // Rung 1 — the schedule row itself. Seeded first so every id is present in
  // the map even if every query below fails.
  for (const s of schedules) {
    if (!s?.id) continue;
    lastActivityById.set(s.id, s.updated_at ?? null);
  }
  const bump = (scheduleId: string, stamp: string | null | undefined) => {
    if (!lastActivityById.has(scheduleId)) return;
    lastActivityById.set(scheduleId, maxStamp(lastActivityById.get(scheduleId), stamp));
  };

  const scheduleIds = [...lastActivityById.keys()];
  if (scheduleIds.length === 0) return { lastActivityById, warnings };

  // Rung 4 (+ the version→schedule map the aggregates need). Plain select, no
  // aggregate: if PostgREST can't serve this one there is nothing to join to,
  // so we stop here rather than firing two aggregates we couldn't use.
  const versions = await selectIn(sb, 'schedule_versions', VERSION_SELECT, 'schedule_id', scheduleIds);
  if (versions.error) {
    warnings.push(`schedule_versions lookup failed — last-activity degraded to the schedule row: ${errText(versions.error)}`);
    return { lastActivityById, warnings };
  }
  const versionToSchedule = new Map<string, string>();
  for (const v of versions.rows) {
    const versionId = str(v.id);
    const scheduleId = str(v.schedule_id);
    if (!versionId || !scheduleId) continue;
    versionToSchedule.set(versionId, scheduleId);
    bump(scheduleId, str(v.created_at));
    bump(scheduleId, str(v.published_at));
  }
  const versionIds = [...versionToSchedule.keys()];
  if (versionIds.length === 0) return { lastActivityById, warnings };

  // Rungs 2 and 3 are independent — fire them together, fold them separately.
  const [assignmentMax, slotMax] = await Promise.all([
    selectIn(sb, 'assignments', ASSIGNMENT_MAX_SELECT, ASSIGNMENT_VERSION_FILTER, versionIds),
    selectIn(sb, 'schedule_slots', SLOT_MAX_SELECT, SLOT_VERSION_FILTER, versionIds),
  ]);
  foldAggregate('assignments', assignmentMax, versionToSchedule, bump, warnings);
  foldAggregate('schedule_slots', slotMax, versionToSchedule, bump, warnings);

  return { lastActivityById, warnings };
}

/**
 * Attach the derived stamp to the rows the list route returns. Falls back to
 * the row's own `updated_at` so `last_activity_at` is never emptier than what
 * the list showed before this feature existed.
 */
export function withLastActivity<T extends ScheduleActivityRow>(
  rows: T[],
  lastActivityById: Map<string, string | null>,
): Array<T & { last_activity_at: string | null }> {
  return rows.map(row => ({
    ...row,
    last_activity_at: lastActivityById.get(row.id) ?? row.updated_at ?? null,
  }));
}

// ── internals ───────────────────────────────────────────────────────────────

interface ChunkedResult { rows: Row[]; error: unknown }

/** One `.in()` select, split into ACTIVITY_ID_CHUNK-sized URLs. First error wins. */
async function selectIn(
  sb: SupabaseClient, table: string, select: string, column: string, ids: string[],
): Promise<ChunkedResult> {
  const rows: Row[] = [];
  for (let i = 0; i < ids.length; i += ACTIVITY_ID_CHUNK) {
    const res = await sb.from(table).select(select).in(column, ids.slice(i, i + ACTIVITY_ID_CHUNK));
    if (res?.error) return { rows: [], error: res.error };
    rows.push(...(((res?.data as Row[]) || [])));
  }
  return { rows, error: null };
}

/**
 * Fold one aggregate result into the map. A failed query, an unsupported
 * aggregate/spread syntax (older PostgREST, `db-aggregates-enabled` off), or a
 * row shape we don't recognise all warn and skip — never throw, never poison
 * the other rungs.
 */
function foldAggregate(
  table: string,
  result: ChunkedResult,
  versionToSchedule: Map<string, string>,
  bump: (scheduleId: string, stamp: string | null | undefined) => void,
  warnings: string[],
): void {
  if (result.error) {
    // Same split genContext/sequenceAutoFill draw with isMissingColumnError:
    // "this DB doesn't have what we asked for" reads differently in the log
    // from a genuine read failure. Both degrade — the list must render either
    // way — but only one of them is worth investigating.
    const why = isMissingColumnError(result.error as { code?: string; message?: string })
      ? 'column/aggregate not available on this DB'
      : 'read failed';
    warnings.push(`${table} max(updated_at) aggregate ${why} — that source is excluded from last-activity: ${errText(result.error)}`);
    return;
  }
  let used = 0;
  for (const row of result.rows) {
    const versionId = aggVersionId(row);
    const stamp = aggStamp(row);
    if (!versionId || !stamp) continue;
    const scheduleId = versionToSchedule.get(versionId);
    if (!scheduleId) continue;
    bump(scheduleId, stamp);
    used++;
  }
  // Rows came back but none were usable: the server answered in a shape this
  // code doesn't understand, which is a silent-wrong-answer risk, not a no-op.
  if (used === 0 && result.rows.length > 0) {
    warnings.push(`${table} max(updated_at) returned ${result.rows.length} row(s) in an unrecognised shape — that source is excluded from last-activity`);
  }
}

/**
 * `updated_at.max()` comes back under the `max` key. The spread form is read
 * defensively too: if a server ignores `...` the version id arrives nested
 * under the embed instead of flattened, and either is fine to consume.
 */
function aggVersionId(row: Row): string | null {
  const flat = str(row.schedule_version_id);
  if (flat) return flat;
  const embed = row.schedule_slots;
  const nested = Array.isArray(embed) ? embed[0] : embed;
  if (nested && typeof nested === 'object') return str((nested as Row).schedule_version_id);
  return null;
}

function aggStamp(row: Row): string | null {
  return str(row.max) ?? str(row.updated_at);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function errText(error: unknown): string {
  const e = error as { message?: string; code?: string } | null;
  return e?.message || e?.code || String(error);
}
