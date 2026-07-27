// "Last activity" for the schedules list (Gabriel 2026-07-27).
//
// WHY THIS EXISTS: the list's `edited` line first shipped reading
// `schedules.updated_at`, and that column does NOT track scheduling work. The
// BEFORE UPDATE trigger (supabase_scheduling_schema.sql:775-802) only fires
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
//      is redundant in practice; it keeps a version that somehow carries no
//      slots from reading as "never touched".
// schedule_versions contributes no updated_at because it HAS none — it is
// absent from the trigger array and from the DDL (schema:314-325).
//
// WHERE THE MAX IS COMPUTED, and why it moved (2026-07-27, same day):
// all four rungs are folded IN POSTGRES by
// `scheduling.schedule_last_activity(uuid[])` — one RPC for the whole list,
// see supabase_scheduling_patch39_schedule_last_activity.sql. The first
// implementation did rungs 2 and 3 client-side with PostgREST's aggregate
// syntax (`updated_at.max()`), which this project REJECTS outright:
//   HTTP 400 {"code":"PGRST123","message":"Use of aggregate functions is not
//   allowed"}  (`db-aggregates-enabled` is off; tested live 2026-07-27).
// That code wasn't broken — it degraded, exactly as designed — but degrading
// on every single request means the feature silently did nothing. PostgREST's
// per-embed order+limit CAN serve rung 3, but not rung 2: assignments are a
// GRANDCHILD (version → slots → assignments) and PostgREST cannot order a
// grandchild across all its parents. Hence a function.
//
// Known blind spot, deliberate: a pure DELETE leaves no timestamp anywhere.
// Clearing a grid cell is fine (the route re-inserts an open row), but if a
// future path only removed slots the stamp would not move. Fixing that needs a
// trigger/audit column, which this read-time derivation is explicitly not.
//
// COST: ONE round trip for the WHOLE list, never one per schedule, and it
// returns one small row per schedule rather than any raw slot/assignment rows
// (a 12-week combined draft is ~2-3k assignment rows; the list holds dozens of
// drafts). The whole derivation degrades as one unit now — if the RPC is
// missing or fails, every row falls back to `schedules.updated_at`, which is
// the pre-fix behaviour rather than a broken list.

import { isMissingFunctionError, type SupabaseClient } from './rulesEngine/shared';
import { maxStamp } from './scheduleStamps';

/** The only fields this resolver needs from a `scheduling.schedules` row. */
export interface ScheduleActivityRow {
  id: string;
  updated_at?: string | null;
}

export interface LastActivityResult {
  /** schedule id → latest content-change stamp (verbatim from the DB). */
  lastActivityById: Map<string, string | null>;
  /** Non-fatal degradations, for the server log. Empty = the read was clean. */
  warnings: string[];
}

/**
 * patch39. Takes `uuid[]`, returns `(schedule_id, last_activity_at)` — one row
 * per EXISTING schedule, unknown ids simply absent.
 */
export const LAST_ACTIVITY_RPC = 'schedule_last_activity';

// NO CHUNKING, deliberately: the ids ride in the RPC's POST BODY, not the URL,
// so the 414 cliff that forced the superseded aggregate implementation to
// split its `in.(…)` filters into 150-id URLs does not exist here. A list of
// any realistic length is one request.

type Row = Record<string, unknown>;

/**
 * Resolve each schedule's last content change. Never throws: a failed or
 * missing RPC is recorded in `warnings` and skipped, so the returned map
 * always holds at least `schedules.updated_at` for every id passed in.
 */
export async function loadLastActivity(
  sb: SupabaseClient,
  schedules: ScheduleActivityRow[],
): Promise<LastActivityResult> {
  const warnings: string[] = [];
  const lastActivityById = new Map<string, string | null>();

  // Rung 1 — the schedule row itself. Seeded FIRST so every id is present in
  // the map even if the RPC never answers. This is the degradation floor.
  for (const s of schedules) {
    if (!s?.id) continue;
    lastActivityById.set(s.id, s.updated_at ?? null);
  }
  const scheduleIds = [...lastActivityById.keys()];
  if (scheduleIds.length === 0) return { lastActivityById, warnings };

  const res = await callRpc(sb, scheduleIds);
  if (res.error) {
    // Same split genContext/sequenceAutoFill draw: "this DB doesn't have it
    // yet" reads differently in the log from a genuine read failure. Both
    // degrade — the list must render either way — but only one of them is
    // worth investigating, and only one has a one-line fix.
    const why = isMissingFunctionError(res.error)
      ? 'not present on this DB (apply supabase_scheduling_patch39_schedule_last_activity.sql)'
      : 'read failed';
    warnings.push(`${LAST_ACTIVITY_RPC} RPC ${why} — last-activity degraded to the schedule row: ${errText(res.error)}`);
    return { lastActivityById, warnings };
  }

  // The function already folds all four rungs, so this max is belt-and-braces:
  // it guarantees the answer can never come back OLDER than the row stamp the
  // list showed before this feature existed, whatever the DB returns.
  let recognised = 0;
  for (const row of res.rows) {
    const id = str(row.schedule_id);
    if (!id || !lastActivityById.has(id)) continue;
    recognised++;
    const stamp = str(row.last_activity_at);
    if (stamp) lastActivityById.set(id, maxStamp(lastActivityById.get(id), stamp));
  }
  // Rows came back but none were addressable: the server answered in a shape
  // this code doesn't understand (renamed output columns, a changed
  // signature), which is a silent-wrong-answer risk, not a no-op.
  if (recognised === 0 && res.rows.length > 0) {
    warnings.push(`${LAST_ACTIVITY_RPC} returned ${res.rows.length} row(s) in an unrecognised shape — last-activity degraded to the schedule row`);
  }

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

/**
 * The one round trip. Wrapped so a throw from the client layer (DNS, socket,
 * an sb with no `.rpc`) degrades the same way an error RESULT does — this runs
 * inside a list endpoint that must render regardless.
 */
async function callRpc(
  sb: SupabaseClient, scheduleIds: string[],
): Promise<{ rows: Row[]; error: unknown }> {
  try {
    const res = await sb.rpc(LAST_ACTIVITY_RPC, { p_schedule_ids: scheduleIds });
    if (res?.error) return { rows: [], error: res.error };
    return { rows: ((res?.data as Row[]) || []), error: null };
  } catch (e) {
    return { rows: [], error: e };
  }
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function errText(error: unknown): string {
  const e = error as { message?: string; code?: string } | null;
  return e?.message || e?.code || String(error);
}
