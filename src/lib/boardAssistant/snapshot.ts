// Snapshot / undo for board assistant mutations (public.board_assistant_actions,
// patch20). This mirrors scheduleAssistant/snapshot.ts, adapted to the board's
// day-scoped public tables:
//
// - takeBoardSnapshot captures the FULL rows of the five day-scoped board tables
//   (daily_active, assignments, daily_designations, daily_shifts, breaks) for the
//   working date — hospital-scoped by staff id exactly like the board screen
//   (Task 4's staffInScope) — BEFORE the turn's first mutating tool, and inserts
//   one board_assistant_actions row. relief_log is NOT snapshotted wholesale
//   (it is append-only); relief rows the turn CREATES are recorded by id via
//   recordReliefInsert for targeted deletion on revert.
// - revertBoardAction wipes the current in-scope day rows, re-inserts the
//   snapshot rows, deletes the turn's relief rows, and stamps reverted_at.
//   reverted_at is stamped only on a fully clean restore, so a partial failure
//   stays visibly un-reverted and the Undo can be retried.
// - Undo model (v1): actions for a date must be reverted NEWEST-FIRST — the
//   newer-unreverted-action guard in revertBoardAction refuses out-of-order
//   undo (newerActionExists → 409). There is NO undo-of-undo in v1 (unlike the
//   schedule side, whose revert first snapshots the about-to-be-overwritten
//   state); the ordering guard IS the safety mechanism that keeps an older
//   revert from silently clobbering newer turns' changes irrecoverably. A
//   pre-revert snapshot is a possible v2.
//
// actionId visibility (a NEW pattern, no scheduling-side counterpart —
// scheduling executors never need the action id): runAssistantLoop
// (assistantCore/loop.ts) awaits takeSnapshot BEFORE any mutating executor of
// the run executes, so the adapter's takeSnapshot closure can stash the id into
// the shared BoardActionRef (tools.ts) and mark_relieved reliably reads it when
// calling recordReliefInsert.
import { scopeAllHospitals, staffInScope, type BoardCtx } from './tools';
import type { StaffMember } from '@/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BoardClient = any;
type Row = Record<string, unknown>;

// The five day-scoped tables captured + restored, in a fixed order. relief_log
// is deliberately absent (append-only; see reliefIds).
export const SNAPSHOT_TABLES = [
  'daily_active',
  'assignments',
  'daily_designations',
  'daily_shifts',
  'breaks',
] as const;
export type SnapshotTable = (typeof SNAPSHOT_TABLES)[number];

export interface BoardSnapshot {
  daily_active: Row[];
  assignments: Row[];
  daily_designations: Row[];
  daily_shifts: Row[];
  breaks: Row[];
  // Ids of relief_log rows CREATED during the turn (recordReliefInsert appends).
  // Deleted on revert — NOT a full relief_log snapshot.
  reliefIds: string[];
}

function emptyCounts(): Record<SnapshotTable, number> {
  return { daily_active: 0, assignments: 0, daily_designations: 0, daily_shifts: 0, breaks: 0 };
}

// Staff ids in the ctx's hospital scope — the exact set the board screen shows
// (staffInScope: hospital match OR null-hospital; "All" = everyone). Every
// day-scoped row references a staff_id, so this set scopes all five tables.
async function scopedStaffIds(sb: BoardClient, ctx: BoardCtx): Promise<Set<string>> {
  const { data, error } = await sb.from('staff').select('*');
  if (error) throw new Error(`staff read failed: ${error.message}`);
  const ids = new Set<string>();
  for (const s of (data ?? []) as StaffMember[]) {
    if (staffInScope(ctx, s.hospital)) ids.add(s.id);
  }
  return ids;
}

// created_at is stamped client-side with a strictly-monotonic ms clock instead
// of relying on the column's DEFAULT now(): the revert-ordering guard compares
// created_at, and two turns landing within the same millisecond must still be
// totally ordered. Monotonicity holds per process; cross-instance ordering
// falls back to wall clocks (a same-ms cross-instance race on one board date is
// negligible, and the guard's failure mode there is allowing an out-of-order
// undo — the pre-v1 status quo, not new data loss).
let lastActionMs = 0;
function monotonicNowIso(): string {
  const ms = Math.max(Date.now(), lastActionMs + 1);
  lastActionMs = ms;
  return new Date(ms).toISOString();
}

// Reads the in-scope day rows → inserts one board_assistant_actions row →
// returns its id. Throws on any read/insert failure (the loop treats a throw as
// "snapshot failed" and refuses mutations rather than run them un-undoably).
export async function takeBoardSnapshot(sb: BoardClient, ctx: BoardCtx, summary: string): Promise<string> {
  const date = ctx.boardDate;
  const inScope = await scopedStaffIds(sb, ctx);

  const reads = await Promise.all(
    SNAPSHOT_TABLES.map((t) => sb.from(t).select('*').eq('board_date', date)),
  );
  const snapshot: BoardSnapshot = {
    daily_active: [], assignments: [], daily_designations: [], daily_shifts: [], breaks: [], reliefIds: [],
  };
  SNAPSHOT_TABLES.forEach((table, i) => {
    const { data, error } = reads[i] as { data: Row[] | null; error: { message: string } | null };
    if (error) throw new Error(`${table} snapshot read failed: ${error.message}`);
    snapshot[table] = ((data ?? []) as Row[]).filter((r) => inScope.has(r.staff_id as string));
  });

  const { data: action, error: insErr } = await sb
    .from('board_assistant_actions')
    .insert({
      board_date: date,
      hospital: scopeAllHospitals(ctx) ? null : ctx.hospital,
      summary,
      snapshot,
      created_at: monotonicNowIso(), // see monotonicNowIso — ordering guard input
    })
    .select('id')
    .single();
  if (insErr || !action) {
    throw new Error(`board_assistant_actions insert failed: ${insErr?.message ?? 'no row returned'}`);
  }
  return action.id as string;
}

// Appends a newly-created relief_log row id to the open snapshot so revert can
// delete it. Called by mark_relieved when a turn snapshot is open. No-op if the
// id is already recorded (idempotent — parallel tool-use safety).
export async function recordReliefInsert(sb: BoardClient, actionId: string, reliefId: string): Promise<void> {
  const { data, error } = await sb
    .from('board_assistant_actions')
    .select('snapshot')
    .eq('id', actionId)
    .maybeSingle();
  if (error) throw new Error(`board_assistant_actions read failed: ${error.message}`);
  if (!data) throw new Error(`board action ${actionId} not found`);
  const snapshot = (data.snapshot ?? {}) as BoardSnapshot;
  const reliefIds = Array.isArray(snapshot.reliefIds) ? snapshot.reliefIds : [];
  if (reliefIds.includes(reliefId)) return;
  const next: BoardSnapshot = { ...snapshot, reliefIds: [...reliefIds, reliefId] };
  const { error: upErr } = await sb
    .from('board_assistant_actions')
    .update({ snapshot: next })
    .eq('id', actionId);
  if (upErr) throw new Error(`board_assistant_actions relief-id update failed: ${upErr.message}`);
}

export interface BoardRevertResult {
  ok: boolean;
  // Structured not-found signal → the route maps this to 404 (no substring match).
  notFound?: boolean;
  // Structured already-reverted signal → the route maps this to 409.
  alreadyReverted?: boolean;
  // Structured ordering-guard signal → the route maps this to 409: a NEWER
  // un-reverted action exists for the same board_date, and reverting this older
  // one would clobber that turn's changes with no pre-revert snapshot to
  // recover them (no undo-of-undo in v1 — see the header). Carries the newest
  // blocker so the UI can say which turn to undo first.
  newerActionExists?: { id: string; summary: string | null };
  // Rows re-inserted per snapshot table.
  restored: Record<SnapshotTable, number>;
  // relief_log rows deleted — counts the TARGETED ids from the snapshot, not
  // confirmed row deletions (the delete returns no count; an id already gone is
  // indistinguishable from one just removed).
  reliefDeleted: number;
  errors: string[];
}

export async function revertBoardAction(sb: BoardClient, id: string): Promise<BoardRevertResult> {
  const { data: action, error: loadErr } = await sb
    .from('board_assistant_actions')
    .select('id, board_date, hospital, snapshot, created_at, reverted_at')
    .eq('id', id)
    .maybeSingle();
  if (loadErr) {
    return { ok: false, restored: emptyCounts(), reliefDeleted: 0, errors: [`action load failed: ${loadErr.message}`] };
  }
  if (!action) {
    return { ok: false, notFound: true, restored: emptyCounts(), reliefDeleted: 0, errors: [`board action ${id} not found`] };
  }
  if (action.reverted_at) {
    return { ok: false, alreadyReverted: true, restored: emptyCounts(), reliefDeleted: 0, errors: [`board action ${id} already reverted`] };
  }

  // ── Ordering guard: refuse to revert past a newer un-reverted action ────────
  // Deliberately date-scoped only, IGNORING the hospital column: hospital
  // scopes overlap (null-hospital staff belong to EVERY hospital's scope, and
  // an "All" action spans everything), so any newer un-reverted action on the
  // same date conservatively counts as a blocker. Undo must run newest-first.
  {
    const { data: siblings, error: sibErr } = await sb
      .from('board_assistant_actions')
      .select('id, summary, created_at, reverted_at')
      .eq('board_date', action.board_date);
    if (sibErr) {
      return { ok: false, restored: emptyCounts(), reliefDeleted: 0, errors: [`action list read failed: ${sibErr.message}`] };
    }
    const myCreated = Date.parse(String(action.created_at ?? ''));
    const newer = ((siblings ?? []) as Array<{ id: string; summary: string | null; created_at: string; reverted_at: string | null }>)
      .filter((r) => r.id !== id && r.reverted_at == null && Date.parse(String(r.created_at ?? '')) > myCreated)
      .sort((a, b) => Date.parse(String(b.created_at)) - Date.parse(String(a.created_at)));
    if (newer.length > 0) {
      const blocker = newer[0]; // the NEWEST — the one to undo first
      return {
        ok: false,
        newerActionExists: { id: blocker.id, summary: blocker.summary ?? null },
        restored: emptyCounts(),
        reliefDeleted: 0,
        errors: [
          `a newer un-reverted assistant action exists for ${action.board_date}` +
            `${blocker.summary ? ` ("${blocker.summary}")` : ''} — undo that turn first`,
        ],
      };
    }
  }

  const date = action.board_date as string;
  const hospital = (action.hospital as string | null) ?? null;
  const snapshot = (action.snapshot ?? {}) as BoardSnapshot;
  const ctx: BoardCtx = { boardDate: date, hospital };
  const scopedIds = [...(await scopedStaffIds(sb, ctx))];

  const restored = emptyCounts();
  const errors: string[] = [];

  for (const table of SNAPSHOT_TABLES) {
    // Delete-then-reinsert is NOT a transaction (the Supabase JS client has no
    // multi-statement txn). On a mid-revert failure the day is left partially
    // restored, but reverted_at stays unstamped (below) so the Undo is
    // retryable and re-runs the whole restore — same property as the schedule
    // assistant revert.
    const rows = (snapshot[table] ?? []) as Row[];
    if (scopedIds.length === 0) {
      // Scope is computed from the CURRENT staff table, so it can be empty at
      // revert time even though the snapshot holds rows (e.g. the staff rows
      // were deleted since the snapshot). Silently skipping would "succeed" a
      // revert that restored nothing and stamp reverted_at — record an error
      // instead, so the route reports the failure and the Undo stays retryable.
      if (rows.length > 0) {
        errors.push(
          `${table} restore skipped: no in-scope staff at revert time but the snapshot holds ${rows.length} row(s)`,
        );
      }
      continue; // empty snapshot table + empty scope → genuinely nothing to do
    }
    const { error: delErr } = await sb
      .from(table)
      .delete()
      .eq('board_date', date)
      .in('staff_id', scopedIds);
    if (delErr) {
      errors.push(`${table} clear failed: ${delErr.message}`);
      continue;
    }
    if (rows.length > 0) {
      const { error: insErr } = await sb.from(table).insert(rows);
      if (insErr) {
        errors.push(`${table} restore failed: ${insErr.message}`);
        continue;
      }
    }
    restored[table] = rows.length;
  }

  // relief_log deletion runs ONLY after the table loop completed cleanly: an
  // abandoned partial revert must never drop a clinical relief record ("went
  // home" evidence) while the assignments it belongs with stay un-reverted.
  // reliefDeleted reports the TARGETED ids, not confirmed row deletions.
  let reliefDeleted = 0;
  if (errors.length === 0) {
    const reliefIds = Array.isArray(snapshot.reliefIds) ? snapshot.reliefIds : [];
    if (reliefIds.length > 0) {
      const { error: relErr } = await sb.from('relief_log').delete().in('id', reliefIds);
      if (relErr) errors.push(`relief clear failed: ${relErr.message}`);
      else reliefDeleted = reliefIds.length;
    }
  }

  // Stamp reverted_at ONLY on a fully clean restore (see the txn note above).
  if (errors.length === 0) {
    const { error: stampErr } = await sb
      .from('board_assistant_actions')
      .update({ reverted_at: new Date().toISOString() })
      .eq('id', id);
    if (stampErr) errors.push(`reverted_at stamp failed: ${stampErr.message}`);
  }

  return { ok: errors.length === 0, restored, reliefDeleted, errors };
}
