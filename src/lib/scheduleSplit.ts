// Call split / unsplit core (2026-07-22) — the per-day action that turns a
// whole 24h call slot into 2×12 or 3×8 SEGMENT slots and back. Sanctioned I/O
// module with an injected supabase client (the sequenceAutoFill idiom); the
// schedule-slots [id]/split and [id]/unsplit routes are thin wrappers.
//
// Site structure keeps 24h calls: shift TEMPLATES never materialize segments
// (patch35 creates none — the D8/D9 lesson: slot creation keys on templates),
// so segment slots exist ONLY through splitCallSlot, and unsplitCallSlot
// restores the whole-call slot. Segment shift types are found by
// parent_call_code (the mapping column) + duration_hours (12 vs 8) — never by
// code-name patterns.
//
// Guards (route-hardening posture — clear 4xx, never a silent write):
//   • slot exists (404), category 'call' (400), NOT already a segment (409 —
//     segment-of-segment), assignment OPEN (409 — the scheduler clears
//     first), slot unlocked (409), version is the schedule's CURRENT version
//     (409 — stale drafts must not fork structure), segments not already
//     present for the date (409 — double-split).
//   • unsplit: the slot IS a segment (400); EVERY sibling segment on the
//     date must be OPEN (409, filled codes named); the parent shift type
//     must exist (409).
//
// Writes are sequential (PostgREST has no transaction seam here — repo norm):
// split creates the segment slots + their open placeholder assignments FIRST
// and deletes the parent LAST; a failed parent delete triggers a compensating
// delete of the created segments so the schedule never holds both shapes.
// scheduling.assignments cascades on slot delete (FK ON DELETE CASCADE).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;

export type SplitMode = '2x12' | '3x8';

export interface SplitOk {
  ok: true;
  createdSlotIds: string[];
  deletedSlotId: string;
  mode: SplitMode;
  segmentCodes: string[];
}

export interface UnsplitOk {
  ok: true;
  createdSlotId: string;
  deletedSlotIds: string[];
  parentCode: string;
}

export interface SplitFail {
  ok: false;
  status: 400 | 404 | 409 | 500;
  error: string;
}

export type SplitOutcome = SplitOk | SplitFail;
export type UnsplitOutcome = UnsplitOk | SplitFail;

const fail = (status: SplitFail['status'], error: string): SplitFail => ({ ok: false, status, error });

interface SlotRow {
  id: string;
  slot_date: string;
  site_id: string;
  schedule_version_id: string;
  derived_day_type: string;
  locked: boolean;
  shift_types: { id: string; code: string; category: string; parent_call_code?: string | null } | null;
  assignments: Array<{ id: string; provider_id: string | null }>;
}

// Normalize the assignments embed (UNIQUE(schedule_slot_id) → object against
// the live DB, array in dev fakes) without importing the embed helper's grid
// semantics — this module needs the rows only for the open check.
function embedArr<T>(v: T | T[] | null | undefined): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

const SLOT_SELECT =
  'id, slot_date, site_id, schedule_version_id, derived_day_type, locked, required_count, '
  + 'shift_types(id, code, category, parent_call_code), assignments(id, provider_id)';
// Pre-patch35 fallback: parent_call_code doesn't exist yet — segments cannot
// exist either, so a null parent is exact.
const SLOT_SELECT_PRE35 =
  'id, slot_date, site_id, schedule_version_id, derived_day_type, locked, required_count, '
  + 'shift_types(id, code, category), assignments(id, provider_id)';

const isColumnErr = (e: unknown) => /column/i.test((e as { message?: string } | null)?.message || '');

async function loadSlot(sb: SupabaseClient, slotId: string): Promise<{ slot: SlotRow | null; error?: string }> {
  let res = await sb.from('schedule_slots').select(SLOT_SELECT).eq('id', slotId).maybeSingle();
  if (res.error && isColumnErr(res.error)) {
    res = await sb.from('schedule_slots').select(SLOT_SELECT_PRE35).eq('id', slotId).maybeSingle();
  }
  if (res.error) return { slot: null, error: res.error.message || 'slot load failed' };
  if (!res.data) return { slot: null };
  const raw = res.data as Record<string, unknown>;
  const st = (Array.isArray(raw.shift_types) ? (raw.shift_types as unknown[])[0] : raw.shift_types) as SlotRow['shift_types'];
  return {
    slot: {
      id: raw.id as string,
      slot_date: raw.slot_date as string,
      site_id: raw.site_id as string,
      schedule_version_id: raw.schedule_version_id as string,
      derived_day_type: (raw.derived_day_type as string) || 'weekday',
      locked: !!raw.locked,
      shift_types: st ?? null,
      assignments: embedArr(raw.assignments as SlotRow['assignments']),
    },
  };
}

// The split/unsplit target must live in the schedule's CURRENT version —
// editing structure in a superseded draft would silently fork the schedule.
async function assertCurrentVersion(sb: SupabaseClient, versionId: string): Promise<SplitFail | null> {
  const ver = await sb
    .from('schedule_versions')
    .select('schedule_id, version_number')
    .eq('id', versionId)
    .maybeSingle();
  if (ver.error || !ver.data) {
    return fail(500, `schedule version lookup failed: ${ver.error?.message || 'version not found'}`);
  }
  const scheduleId = (ver.data as { schedule_id: string }).schedule_id;
  const latest = await sb
    .from('schedule_versions')
    .select('id, version_number')
    .eq('schedule_id', scheduleId)
    .order('version_number', { ascending: false })
    .limit(1);
  if (latest.error) return fail(500, `current-version lookup failed: ${latest.error.message}`);
  const latestRow = ((latest.data as Array<{ id: string }>) || [])[0];
  if (!latestRow || latestRow.id !== versionId) {
    return fail(409, 'This slot belongs to a superseded schedule version — open the schedule\'s current version and split there.');
  }
  return null;
}

export async function splitCallSlot(
  sb: SupabaseClient,
  slotId: string,
  mode: SplitMode,
): Promise<SplitOutcome> {
  if (mode !== '2x12' && mode !== '3x8') {
    return fail(400, `Unknown split mode '${String(mode)}' — expected '2x12' or '3x8'.`);
  }

  const { slot, error: loadErr } = await loadSlot(sb, slotId);
  if (loadErr) return fail(500, `slot load failed: ${loadErr}`);
  if (!slot) return fail(404, 'Slot not found.');
  const st = slot.shift_types;
  if (!st) return fail(400, 'Slot has no shift type.');
  if (st.category !== 'call') return fail(400, `Only call slots can be split — ${st.code} is category '${st.category}'.`);
  if (st.parent_call_code) {
    return fail(409, `${st.code} is already a call segment (of ${st.parent_call_code}) — segments cannot be split again. Use unsplit to restore the whole call.`);
  }
  if (slot.locked) return fail(409, 'Slot is locked — unlock it before splitting.');
  const holder = slot.assignments.find(a => a.provider_id);
  if (holder) {
    return fail(409, `${st.code} on ${slot.slot_date} is assigned — remove the assignment first, then split the open call.`);
  }

  const versionFail = await assertCurrentVersion(sb, slot.schedule_version_id);
  if (versionFail) return versionFail;

  // Segment shift types: parent_call_code IS the mapping; mode picks the
  // duration tier (2x12 → the 12h pair, 3x8 → the 8h trio).
  const segRes = await sb
    .from('shift_types')
    .select('id, code, duration_hours, start_time, display_order')
    .eq('site_id', slot.site_id)
    .eq('parent_call_code', st.code)
    .eq('is_active', true);
  if (segRes.error) {
    if (isColumnErr(segRes.error)) {
      return fail(409, 'Call-segment shift types are not configured for this site (apply patch35).');
    }
    return fail(500, `segment shift-type load failed: ${segRes.error.message}`);
  }
  const wantHours = mode === '2x12' ? 12 : 8;
  const wantCount = mode === '2x12' ? 2 : 3;
  const segments = (((segRes.data as Array<Record<string, unknown>>) || []))
    .filter(r => Number(r.duration_hours) === wantHours)
    .sort((a, b) =>
      (Number(a.display_order ?? 999) - Number(b.display_order ?? 999))
      || String(a.start_time ?? '').localeCompare(String(b.start_time ?? '')));
  if (segments.length !== wantCount) {
    return fail(409,
      `Call-segment shift types for ${st.code} ${mode} are not configured — expected ${wantCount} ${wantHours}h segment types, found ${segments.length} (apply patch35).`);
  }

  // Double-split guard: any live segment slot for this parent on this date.
  const existing = await sb
    .from('schedule_slots')
    .select('id, shift_types!inner(parent_call_code)')
    .eq('schedule_version_id', slot.schedule_version_id)
    .eq('slot_date', slot.slot_date)
    .eq('shift_types.parent_call_code', st.code);
  if (existing.error) return fail(500, `segment scan failed: ${existing.error.message}`);
  if (((existing.data as unknown[]) || []).length > 0) {
    return fail(409, `${st.code} on ${slot.slot_date} is already split — unsplit it first.`);
  }

  // 1. Create the segment slots (same version/site/date/day-type; sibling
  //    slot_index 0..N-1; required_count 1 — the slot-creation idiom).
  const slotRows = segments.map((seg, i) => ({
    schedule_version_id: slot.schedule_version_id,
    site_id: slot.site_id,
    slot_date: slot.slot_date,
    shift_type_id: seg.id as string,
    slot_index: i,
    required_count: 1,
    derived_day_type: slot.derived_day_type,
    locked: false,
  }));
  const created = await sb.from('schedule_slots').insert(slotRows).select('id');
  if (created.error) return fail(500, `segment slot creation failed: ${created.error.message}`);
  const createdIds = (((created.data as Array<{ id: string }>) || [])).map(r => r.id);

  const rollback = async () => {
    const undo = await sb.from('schedule_slots').delete().in('id', createdIds);
    if (undo.error) {
      console.error(`[scheduleSplit] rollback failed — orphaned segment slots ${createdIds.join(', ')}: ${undo.error.message}`);
    }
  };
  if (createdIds.length !== segments.length) {
    await rollback();
    return fail(500, 'segment slot creation returned unexpected rows — rolled back.');
  }

  // 2. Open placeholder assignment per created slot (creation idiom).
  const aRows = createdIds.map(id => ({
    schedule_slot_id: id,
    assignment_status: 'open',
    source_type: 'manual',
  }));
  const aRes = await sb.from('assignments').insert(aRows);
  if (aRes.error) {
    await rollback();
    return fail(500, `segment assignment creation failed — rolled back: ${aRes.error.message}`);
  }

  // 3. Delete the parent slot LAST (its open assignment rides the cascade).
  const del = await sb.from('schedule_slots').delete().eq('id', slot.id);
  if (del.error) {
    await rollback();
    return fail(500, `parent slot delete failed — segments rolled back: ${del.error.message}`);
  }

  return {
    ok: true,
    createdSlotIds: createdIds,
    deletedSlotId: slot.id,
    mode,
    segmentCodes: segments.map(s => s.code as string),
  };
}

export async function unsplitCallSlot(sb: SupabaseClient, slotId: string): Promise<UnsplitOutcome> {
  const { slot, error: loadErr } = await loadSlot(sb, slotId);
  if (loadErr) return fail(500, `slot load failed: ${loadErr}`);
  if (!slot) return fail(404, 'Slot not found.');
  const st = slot.shift_types;
  if (!st) return fail(400, 'Slot has no shift type.');
  const parentCode = st.parent_call_code;
  if (!parentCode) {
    return fail(400, `${st.code} is not a call segment — only split calls can be unsplit.`);
  }

  const versionFail = await assertCurrentVersion(sb, slot.schedule_version_id);
  if (versionFail) return versionFail;

  // Every sibling segment (same date + version + parent) must be OPEN.
  const sibRes = await sb
    .from('schedule_slots')
    .select(SLOT_SELECT)
    .eq('schedule_version_id', slot.schedule_version_id)
    .eq('slot_date', slot.slot_date)
    .eq('site_id', slot.site_id);
  if (sibRes.error) return fail(500, `sibling segment scan failed: ${sibRes.error.message}`);
  const siblings = (((sibRes.data as Array<Record<string, unknown>>) || []))
    .map(raw => ({
      id: raw.id as string,
      locked: !!raw.locked,
      st: (Array.isArray(raw.shift_types) ? (raw.shift_types as unknown[])[0] : raw.shift_types) as SlotRow['shift_types'],
      assignments: embedArr(raw.assignments as SlotRow['assignments']),
    }))
    .filter(s => s.st?.parent_call_code === parentCode);
  if (siblings.length === 0) return fail(500, 'sibling segment scan returned no segments — refusing to unsplit.');
  const filled = siblings.filter(s => s.assignments.some(a => a.provider_id));
  if (filled.length > 0) {
    const codes = filled.map(s => s.st!.code).join(', ');
    return fail(409, `Cannot unsplit — segment${filled.length > 1 ? 's' : ''} ${codes} on ${slot.slot_date} still assigned. Remove the segment assignments first.`);
  }
  const lockedSib = siblings.find(s => s.locked);
  if (lockedSib) return fail(409, `Cannot unsplit — segment ${lockedSib.st!.code} is locked.`);

  // The whole-call shift type to restore.
  const parentType = await sb
    .from('shift_types')
    .select('id, code, category')
    .eq('site_id', slot.site_id)
    .eq('code', parentCode)
    .eq('is_active', true)
    .maybeSingle();
  if (parentType.error || !parentType.data) {
    return fail(409, `Whole-call shift type ${parentCode} not found at this site — cannot restore.`);
  }
  const parentTypeId = (parentType.data as { id: string }).id;

  // 1. Recreate the whole-call slot + its open assignment (creation idiom).
  const created = await sb.from('schedule_slots').insert([{
    schedule_version_id: slot.schedule_version_id,
    site_id: slot.site_id,
    slot_date: slot.slot_date,
    shift_type_id: parentTypeId,
    slot_index: 0,
    required_count: 1,
    derived_day_type: slot.derived_day_type,
    locked: false,
  }]).select('id');
  if (created.error) return fail(500, `whole-call slot creation failed: ${created.error.message}`);
  const newSlotId = (((created.data as Array<{ id: string }>) || []))[0]?.id;
  if (!newSlotId) return fail(500, 'whole-call slot creation returned no row.');

  const rollback = async () => {
    const undo = await sb.from('schedule_slots').delete().eq('id', newSlotId);
    if (undo.error) {
      console.error(`[scheduleSplit] unsplit rollback failed — orphaned slot ${newSlotId}: ${undo.error.message}`);
    }
  };

  const aRes = await sb.from('assignments').insert([{
    schedule_slot_id: newSlotId,
    assignment_status: 'open',
    source_type: 'manual',
  }]);
  if (aRes.error) {
    await rollback();
    return fail(500, `whole-call assignment creation failed — rolled back: ${aRes.error.message}`);
  }

  // 2. Delete every sibling segment slot (open assignments ride the cascade).
  const segIds = siblings.map(s => s.id);
  const del = await sb.from('schedule_slots').delete().in('id', segIds);
  if (del.error) {
    await rollback();
    return fail(500, `segment slot delete failed — whole-call slot rolled back: ${del.error.message}`);
  }

  return { ok: true, createdSlotId: newSlotId, deletedSlotIds: segIds, parentCode };
}
