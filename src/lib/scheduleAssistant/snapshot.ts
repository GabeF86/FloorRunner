// Snapshot/undo for assistant mutations (scheduling.assistant_actions,
// patch18). takeSnapshot captures {active pattern, site shift_types} +
// every assignment row in the version BEFORE the first mutating tool of a
// turn; revertAction restores all three groups in bulk, re-runs batch
// validation, and stamps reverted_at. The revert itself snapshots first, so
// undo-of-undo is just reverting the revert's own action row.
import { chunk, WRITE_CHUNK, batchValidateVersion } from '@/lib/rulesEngine/batchValidate';
import { bulkWriteWithRowFallback } from '@/lib/rulesEngine/commit';
import { loadSiteValidationContext } from '@/lib/rulesEngine/loadContext';
import { replaceActivePattern } from './mutations';
import type { CallPatternDoc } from '@/lib/rulesEngine/callPattern';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SchedulingClient = any;

const READ_CHUNK = 200;

interface SnapshotAssignmentRow {
  schedule_slot_id: string;
  provider_id: string | null;
  assignment_status: string;
  source_type: string | null;
}

interface ConfigBefore {
  call_pattern: {
    name: string;
    source: string;
    definition: CallPatternDoc;
  } | null;
  shift_types: Array<Record<string, unknown>>;
  // Rows of every rule_definition in the site's active rule sets — restored
  // on revert so upsert_rule_definition changes are undoable too (and so
  // post-revert batch validation runs under the ORIGINAL rules, not the
  // mutated ones). Optional: pre-existing snapshots lack it (no-op restore).
  rule_definitions?: Array<Record<string, unknown>>;
}

async function siteIdForSchedule(sb: SchedulingClient, scheduleId: string): Promise<string> {
  const { data, error } = await sb
    .from('schedules').select('site_id').eq('id', scheduleId).maybeSingle();
  if (error) throw new Error(`schedule load failed: ${error.message}`);
  if (!data) throw new Error(`schedule ${scheduleId} not found`);
  return data.site_id as string;
}

// Reads current state → inserts one assistant_actions row → returns its id.
// Throws on any read/insert failure (callers must NOT mutate when the
// snapshot didn't land — spec §7.3: every mutating turn is snapshotted first).
export async function takeSnapshot(
  sb: SchedulingClient,
  scheduleId: string,
  versionId: string | null,
  summary: string,
  requestText: string | null,
): Promise<string> {
  const siteId = await siteIdForSchedule(sb, scheduleId);

  const { data: pattern, error: patErr } = await sb
    .from('call_patterns')
    .select('name, source, definition')
    .eq('site_id', siteId)
    .eq('status', 'active')
    .maybeSingle();
  if (patErr) throw new Error(`call_patterns snapshot read failed: ${patErr.message}`);

  const { data: shiftTypes, error: stErr } = await sb
    .from('shift_types').select('*').eq('site_id', siteId);
  if (stErr) throw new Error(`shift_types snapshot read failed: ${stErr.message}`);

  // Validation rules for the site's active rule sets — small table, full rows.
  const { data: ruleSets, error: rsErr } = await sb
    .from('rule_sets').select('id').eq('site_id', siteId).eq('status', 'active');
  if (rsErr) throw new Error(`rule_sets snapshot read failed: ${rsErr.message}`);
  const ruleSetIds = ((ruleSets ?? []) as Array<{ id: string }>).map(r => r.id);
  let ruleDefinitions: Array<Record<string, unknown>> = [];
  if (ruleSetIds.length > 0) {
    const { data, error } = await sb
      .from('rule_definitions').select('*').in('rule_set_id', ruleSetIds);
    if (error) throw new Error(`rule_definitions snapshot read failed: ${error.message}`);
    ruleDefinitions = (data ?? []) as Array<Record<string, unknown>>;
  }

  // Version assignments via slots → assignments (two flat queries; no join
  // filter, so the fake-client path in tests stays trivial).
  const assignments: SnapshotAssignmentRow[] = [];
  if (versionId) {
    const { data: slots, error: slotErr } = await sb
      .from('schedule_slots').select('id').eq('schedule_version_id', versionId);
    if (slotErr) throw new Error(`schedule_slots snapshot read failed: ${slotErr.message}`);
    const slotIds = ((slots ?? []) as Array<{ id: string }>).map(s => s.id);
    for (const ids of chunk(slotIds, READ_CHUNK)) {
      const { data, error } = await sb
        .from('assignments')
        .select('schedule_slot_id, provider_id, assignment_status, source_type')
        .in('schedule_slot_id', ids);
      if (error) throw new Error(`assignments snapshot read failed: ${error.message}`);
      assignments.push(...((data ?? []) as SnapshotAssignmentRow[]));
    }
  }

  const configBefore: ConfigBefore = {
    call_pattern: pattern
      ? {
          name: pattern.name as string,
          source: pattern.source as string,
          definition: pattern.definition as CallPatternDoc,
        }
      : null,
    shift_types: (shiftTypes ?? []) as Array<Record<string, unknown>>,
    rule_definitions: ruleDefinitions,
  };

  const { data: action, error: insErr } = await sb
    .from('assistant_actions')
    .insert({
      schedule_id: scheduleId,
      schedule_version_id: versionId,
      summary,
      request_text: requestText,
      config_before: configBefore,
      assignments_before: assignments,
    })
    .select('id')
    .single();
  if (insErr || !action) {
    throw new Error(`assistant_actions insert failed: ${insErr?.message ?? 'no row returned'}`);
  }
  return action.id as string;
}

export interface RevertResult {
  ok: boolean;
  // Structured not-found signal (the action id doesn't exist) — the route
  // maps this to 404 instead of substring-matching error text.
  notFound?: boolean;
  // The action created by the revert itself (undo-of-undo target). Null when
  // the revert failed before snapshotting.
  revertActionId: string | null;
  errors: string[];
  validationErrors: string[];
}

export async function revertAction(sb: SchedulingClient, actionId: string): Promise<RevertResult> {
  const errors: string[] = [];
  const validationErrors: string[] = [];

  const { data: action, error: loadErr } = await sb
    .from('assistant_actions')
    .select('id, schedule_id, schedule_version_id, summary, config_before, assignments_before, reverted_at')
    .eq('id', actionId)
    .maybeSingle();
  if (loadErr) return { ok: false, revertActionId: null, errors: [`action load failed: ${loadErr.message}`], validationErrors };
  if (!action) {
    return {
      ok: false, notFound: true, revertActionId: null,
      errors: [`assistant action ${actionId} not found`], validationErrors,
    };
  }

  const scheduleId = action.schedule_id as string;
  const versionId = (action.schedule_version_id as string | null) ?? null;
  const config = action.config_before as ConfigBefore;
  const assignmentsBefore = (action.assignments_before ?? []) as SnapshotAssignmentRow[];

  let siteId: string;
  let revertActionId: string | null = null;
  try {
    siteId = await siteIdForSchedule(sb, scheduleId);
    // Undo-of-undo: capture the CURRENT (about-to-be-overwritten) state first.
    revertActionId = await takeSnapshot(
      sb, scheduleId, versionId, `Undo of: ${action.summary}`, null,
    );
  } catch (err) {
    return {
      ok: false, revertActionId: null,
      errors: [err instanceof Error ? err.message : String(err)],
      validationErrors,
    };
  }

  // ── 1. Restore the call pattern ────────────────────────────────────────────
  if (config?.call_pattern) {
    const { error } = await replaceActivePattern(sb, siteId, config.call_pattern.definition, {
      name: config.call_pattern.name,
      source: 'assistant',
    });
    if (error) errors.push(`call pattern restore failed: ${error.message}`);
  } else {
    // Snapshot had no active pattern → archive whatever is active now.
    const { error } = await sb
      .from('call_patterns')
      .update({ status: 'archived' })
      .eq('site_id', siteId)
      .eq('status', 'active');
    if (error) errors.push(`call pattern archive failed: ${error.message}`);
  }

  // ── 2. Restore shift_types (upsert by id; rows created after the snapshot
  // are left in place — deleting them could orphan slots/assignments) ────────
  const stRows = config?.shift_types ?? [];
  for (const rows of chunk(stRows, WRITE_CHUNK)) {
    const w = await bulkWriteWithRowFallback(sb, 'shift_types', rows, {
      onConflict: 'id', label: 'assistant revert shift_types',
    });
    for (const e of w.rowErrors) errors.push(`shift_type restore failed: ${e.message}`);
  }

  // ── 3. Restore rule_definitions (upsert by id, same pattern as shift_types;
  // absent on pre-existing snapshots → no-op) ────────────────────────────────
  const rdRows = config?.rule_definitions ?? [];
  for (const rows of chunk(rdRows, WRITE_CHUNK)) {
    const w = await bulkWriteWithRowFallback(sb, 'rule_definitions', rows, {
      onConflict: 'id', label: 'assistant revert rule_definitions',
    });
    for (const e of w.rowErrors) errors.push(`rule_definition restore failed: ${e.message}`);
  }

  // ── 4. Restore assignments (upsert on UNIQUE(schedule_slot_id)) ────────────
  const aRows = assignmentsBefore.map(a => ({
    schedule_slot_id: a.schedule_slot_id,
    provider_id: a.provider_id,
    assignment_status: a.assignment_status,
    source_type: a.source_type,
  }));
  for (const rows of chunk(aRows, WRITE_CHUNK)) {
    const w = await bulkWriteWithRowFallback(sb, 'assignments', rows, {
      onConflict: 'schedule_slot_id', label: 'assistant revert assignments',
    });
    for (const e of w.rowErrors) errors.push(`assignment restore failed: ${e.message}`);
  }

  // ── 4b. Set-difference gap: a slot with NO row at snapshot time (e.g. a
  // clear that failed between delete and re-insert) is absent from
  // assignments_before; if regenerate/auto-fill assigned it afterwards, the
  // upsert above leaves it ASSIGNED — a provider the snapshot never had
  // (possible double-book). Force those slots back to open. ──────────────────
  if (versionId) {
    const { data: slots, error: slotErr } = await sb
      .from('schedule_slots').select('id').eq('schedule_version_id', versionId);
    if (slotErr) {
      errors.push(`open-slot restore failed: slot list read failed: ${slotErr.message}`);
    } else {
      const known = new Set(assignmentsBefore.map(a => a.schedule_slot_id));
      const openRows = ((slots ?? []) as Array<{ id: string }>)
        .filter(s => !known.has(s.id))
        .map(s => ({
          schedule_slot_id: s.id,
          provider_id: null,
          assignment_status: 'open',
          validation_flags: null,
        }));
      for (const rows of chunk(openRows, WRITE_CHUNK)) {
        const w = await bulkWriteWithRowFallback(sb, 'assignments', rows, {
          onConflict: 'schedule_slot_id', label: 'assistant revert open-slot restore',
        });
        for (const e of w.rowErrors) errors.push(`open-slot restore failed: ${e.message}`);
      }
    }
  }

  // ── 5. Re-run batch validation so stored flags reflect the restored state ──
  if (versionId) {
    try {
      const siteCtx = await loadSiteValidationContext(sb, siteId);
      const batch = await batchValidateVersion(sb, versionId, siteCtx);
      validationErrors.push(...batch.errors);
    } catch (err) {
      validationErrors.push(`batch validation threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── 6. Stamp reverted_at ONLY when the restore itself succeeded — a failed
  // restore must stay visibly un-reverted (spec §10) ─────────────────────────
  if (errors.length === 0) {
    const { error } = await sb
      .from('assistant_actions')
      .update({ reverted_at: new Date().toISOString() })
      .eq('id', actionId);
    if (error) errors.push(`reverted_at stamp failed: ${error.message}`);
  }

  return { ok: errors.length === 0, revertActionId, errors, validationErrors };
}
