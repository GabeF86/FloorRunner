// Snapshot/undo for assistant mutations (scheduling.assistant_actions,
// patch18). takeSnapshot captures {active pattern, site shift_types} +
// every assignment row in the version BEFORE the first mutating tool of a
// turn; revertAction restores all three groups in bulk, re-runs batch
// validation, and stamps reverted_at. The revert itself snapshots first, so
// undo-of-undo is just reverting the revert's own action row.
import { chunk, WRITE_CHUNK, batchValidateVersion } from '@/lib/rulesEngine/batchValidate';
import { bulkWriteWithRowFallback } from '@/lib/rulesEngine/commit';
import { loadSiteValidationContext } from '@/lib/rulesEngine/loadContext';
import { addDays, AVAIL_WINDOW_DAYS } from '@/lib/rulesEngine/shared';
import { replaceActivePattern } from './mutations';
import type { CallPatternDoc } from '@/lib/rulesEngine/callPattern';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SchedulingClient = any;

// Chunk size for id-list reads (.in filters ride in the query string, so keep
// batches small). Shared with tools.ts's assignment-count read.
export const READ_CHUNK = 200;

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
  // ── Intake extension (assistant-intake). Full rows, captured on every NEW
  // snapshot (possibly empty arrays) so the delete-new-availability pass has a
  // defined baseline. Pre-intake stored actions lack these keys entirely →
  // revertAction skips all three blocks (backward-compatible). ──
  //   provider_availability: org rows overlapping the schedule ± AVAIL_WINDOW_DAYS.
  //   provider_employment_profiles: ORG-WIDE (engines read profiles regardless
  //     of home site, and update_provider_profile may patch any org provider).
  //   provider_site_credentials: this site's credential rows.
  provider_availability?: Array<Record<string, unknown>>;
  provider_employment_profiles?: Array<Record<string, unknown>>;
  provider_site_credentials?: Array<Record<string, unknown>>;
}

interface ScheduleMeta {
  siteId: string;
  dateStart: string;
  dateEnd: string;
}

async function loadScheduleMeta(sb: SchedulingClient, scheduleId: string): Promise<ScheduleMeta> {
  const { data, error } = await sb
    .from('schedules').select('site_id, date_start, date_end').eq('id', scheduleId).maybeSingle();
  if (error) throw new Error(`schedule load failed: ${error.message}`);
  if (!data) throw new Error(`schedule ${scheduleId} not found`);
  return {
    siteId: data.site_id as string,
    dateStart: data.date_start as string,
    dateEnd: data.date_end as string,
  };
}

// The site's organization's provider ids — availability is a provider-level
// fact (engines read it by provider_id, never site_id), so its snapshot +
// delete-new pass scope to the whole org. Returns [] when the site/org is
// missing (nothing to capture or delete).
async function orgProviderIds(sb: SchedulingClient, siteId: string): Promise<string[]> {
  const { data: site, error: siteErr } = await sb
    .from('sites').select('organization_id').eq('id', siteId).maybeSingle();
  if (siteErr) throw new Error(`site org lookup failed: ${siteErr.message}`);
  const orgId = (site as { organization_id?: string } | null)?.organization_id;
  if (!orgId) return [];
  const { data, error } = await sb
    .from('providers').select('id').eq('organization_id', orgId);
  if (error) throw new Error(`org providers read failed: ${error.message}`);
  return ((data ?? []) as Array<{ id: string }>).map(p => p.id);
}

// Provider-availability rows for the org, overlapping [dateStart −, dateEnd +]
// AVAIL_WINDOW_DAYS. record_availability / cancel_availability ENFORCE that
// every write overlaps this exact window (assertOverlapsUndoWindow, tools.ts),
// so nothing the tools touch can escape this baseline or the delete-new pass
// that re-reads it on revert. Chunked .in for URL safety.
async function readOrgAvailabilityWindow(
  sb: SchedulingClient,
  orgPids: string[],
  dateStart: string,
  dateEnd: string,
  columns: string,
): Promise<Array<Record<string, unknown>>> {
  const availStart = addDays(dateStart, -AVAIL_WINDOW_DAYS);
  const availEnd = addDays(dateEnd, AVAIL_WINDOW_DAYS);
  const out: Array<Record<string, unknown>> = [];
  for (const ids of chunk(orgPids, READ_CHUNK)) {
    const { data, error } = await sb
      .from('provider_availability')
      .select(columns)
      .in('provider_id', ids)
      .lte('start_date', availEnd)
      .gte('end_date', availStart);
    if (error) throw new Error(`provider_availability read failed: ${error.message}`);
    out.push(...((data ?? []) as Array<Record<string, unknown>>));
  }
  return out;
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
  const { siteId, dateStart, dateEnd } = await loadScheduleMeta(sb, scheduleId);

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

  // ── Intake extension: availability (org, windowed), profiles (ORG-WIDE —
  // engines read employment profiles regardless of home site, and
  // update_provider_profile may patch any org provider, so a home-site-only
  // capture would let a non-home profile edit escape undo), credentials (this
  // site). Full rows for a verbatim upsert restore. Always captured (possibly
  // empty) so the delete-new-availability pass on revert has a defined
  // baseline. ──
  const orgPids = await orgProviderIds(sb, siteId);
  const availabilityRows = orgPids.length > 0
    ? await readOrgAvailabilityWindow(sb, orgPids, dateStart, dateEnd, '*')
    : [];

  const profiles: Array<Record<string, unknown>> = [];
  for (const ids of chunk(orgPids, READ_CHUNK)) {
    const { data, error } = await sb
      .from('provider_employment_profiles').select('*').in('provider_id', ids);
    if (error) throw new Error(`provider_employment_profiles snapshot read failed: ${error.message}`);
    profiles.push(...((data ?? []) as Array<Record<string, unknown>>));
  }

  const { data: credentials, error: credErr } = await sb
    .from('provider_site_credentials').select('*').eq('site_id', siteId);
  if (credErr) throw new Error(`provider_site_credentials snapshot read failed: ${credErr.message}`);

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
    provider_availability: availabilityRows,
    provider_employment_profiles: profiles,
    provider_site_credentials: (credentials ?? []) as Array<Record<string, unknown>>,
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

  let meta: ScheduleMeta;
  let revertActionId: string | null = null;
  try {
    meta = await loadScheduleMeta(sb, scheduleId);
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
    const { error } = await replaceActivePattern(sb, meta.siteId, config.call_pattern.definition, {
      name: config.call_pattern.name,
      source: 'assistant',
    });
    if (error) errors.push(`call pattern restore failed: ${error.message}`);
  } else {
    // Snapshot had no active pattern → archive whatever is active now.
    const { error } = await sb
      .from('call_patterns')
      .update({ status: 'archived' })
      .eq('site_id', meta.siteId)
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

  // ── 3b–3d. Restore intake state BEFORE assignments — availability feeds the
  // step-5 revalidation, so it must be correct first. All three blocks are
  // skipped on pre-intake snapshots (key absent → backward-compatible). ──────

  // 3b. provider_availability: upsert captured rows by id, THEN delete any
  // current window row the snapshot did not have — a row recorded after the
  // snapshot (record_availability). Mirrors step-4b's open-slot set-difference;
  // like it, this is org+window scoped, so an unrelated availability row
  // inserted after the snapshot within the window is also removed (undo =
  // restore-to-snapshot). Restore first so a row that existed at snapshot time
  // (e.g. a cancel_availability status flip) is upserted, never deleted.
  if (config?.provider_availability !== undefined) {
    const availRows = config.provider_availability;
    for (const rows of chunk(availRows, WRITE_CHUNK)) {
      const w = await bulkWriteWithRowFallback(sb, 'provider_availability', rows, {
        onConflict: 'id', label: 'assistant revert provider_availability',
      });
      for (const e of w.rowErrors) errors.push(`availability restore failed: ${e.message}`);
    }
    try {
      const orgPids = await orgProviderIds(sb, meta.siteId);
      if (orgPids.length > 0) {
        const current = await readOrgAvailabilityWindow(
          sb, orgPids, meta.dateStart, meta.dateEnd, 'id',
        );
        const known = new Set(availRows.map(r => r.id as string));
        const newIds = current.map(r => r.id as string).filter(id => !known.has(id));
        for (const ids of chunk(newIds, WRITE_CHUNK)) {
          const { error } = await sb.from('provider_availability').delete().in('id', ids);
          if (error) errors.push(`availability delete-new failed: ${error.message}`);
        }
      }
    } catch (err) {
      errors.push(`availability delete-new failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 3c. provider_employment_profiles: pure upsert by id (tools never insert new
  // profile rows, so no delete pass — update_provider_profile UPDATEs only).
  if (config?.provider_employment_profiles !== undefined) {
    for (const rows of chunk(config.provider_employment_profiles, WRITE_CHUNK)) {
      const w = await bulkWriteWithRowFallback(sb, 'provider_employment_profiles', rows, {
        onConflict: 'id', label: 'assistant revert provider_employment_profiles',
      });
      for (const e of w.rowErrors) errors.push(`employment profile restore failed: ${e.message}`);
    }
  }

  // 3d. provider_site_credentials: pure upsert by id (same rationale —
  // update_site_credentials UPDATEs an existing row only).
  if (config?.provider_site_credentials !== undefined) {
    for (const rows of chunk(config.provider_site_credentials, WRITE_CHUNK)) {
      const w = await bulkWriteWithRowFallback(sb, 'provider_site_credentials', rows, {
        onConflict: 'id', label: 'assistant revert provider_site_credentials',
      });
      for (const e of w.rowErrors) errors.push(`site credential restore failed: ${e.message}`);
    }
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
      const siteCtx = await loadSiteValidationContext(sb, meta.siteId);
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
