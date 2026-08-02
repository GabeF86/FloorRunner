import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { evaluateAssignment, validationFlagsFor } from '@/lib/rulesEngine/evaluate';
import { applySequenceAutoFill, cleanupSequenceAutoFill } from '@/lib/rulesEngine/sequenceAutoFill';
import {
  GRID_ASSIGNMENT_COLUMNS,
  GRID_ASSIGNMENT_COLUMNS_PRE42,
  isMissingColumnErr,
  withValidationSummary,
  type ValidationSummary,
} from '../schedules/[id]/grid/route.helpers';
import { revalidateNeighbors } from '@/lib/rulesEngine/neighborRevalidation';
import { parseHighlightColor } from '@/lib/highlightColor';

// Never prerender — this route hits Supabase per request.
export const dynamic = 'force-dynamic';

// A re-selected assignment row in the same column shape the grid route
// returns, so the client can patch the affected cells in place instead of
// refetching the whole grid.
type JoinedAssignmentRow = {
  schedule_slot_id: string;
  validation_flags?: unknown;
  validation_summary: ValidationSummary | null;
  [key: string]: unknown;
};

// Re-select every affected assignment row (the edited slot + auto-filled /
// evicted / cleared siblings) in the grid column shape. Best-effort: on a
// query error it returns { assignment: null, siblings: [] } and the client
// falls back to a full grid reload.
// A grid-shape re-select with the same pre-patch42 narrow retry the grid route
// uses (route.helpers.ts): GRID_ASSIGNMENT_COLUMNS names highlight_color, so on
// a DB that predates patch42 the wide select is a missing-column error. Without
// the retry these re-selects would return null and every cell edit would fall
// back to a full grid reload — working, but a needless round-trip on every
// click for the whole deploy→patch window.
type WideRes = { data: unknown; error: { message: string; code?: string } | null };

async function selectGridShapeBySlotIds(
  sb: ReturnType<typeof sbSchedulingServer>,
  slotIds: string[],
): Promise<WideRes> {
  const run = (columns: string) => sb
    .from('assignments')
    .select(columns)
    .in('schedule_slot_id', slotIds) as unknown as Promise<WideRes>;
  const wide = await run(GRID_ASSIGNMENT_COLUMNS);
  if (wide.error && isMissingColumnErr(wide.error)) return run(GRID_ASSIGNMENT_COLUMNS_PRE42);
  return wide;
}

async function selectGridShapeById(
  sb: ReturnType<typeof sbSchedulingServer>,
  id: string,
): Promise<WideRes> {
  const run = (columns: string) => sb
    .from('assignments')
    .select(columns)
    .eq('id', id)
    .single() as unknown as Promise<WideRes>;
  const wide = await run(GRID_ASSIGNMENT_COLUMNS);
  if (wide.error && isMissingColumnErr(wide.error)) return run(GRID_ASSIGNMENT_COLUMNS_PRE42);
  return wide;
}

async function selectAffectedRows(
  sb: ReturnType<typeof sbSchedulingServer>,
  triggerSlotId: string,
  siblingSlotIds: string[],
): Promise<{ assignment: JoinedAssignmentRow | null; siblings: JoinedAssignmentRow[] }> {
  const slotIds = [...new Set([triggerSlotId, ...siblingSlotIds])];
  const { data, error } = await selectGridShapeBySlotIds(sb, slotIds);
  if (error) {
    console.error('[schedule-assignments] affected-row re-select failed:', error.message);
    return { assignment: null, siblings: [] };
  }
  const rows: JoinedAssignmentRow[] = ((data ?? []) as unknown as Array<{
    schedule_slot_id: string; validation_flags?: unknown; [key: string]: unknown;
  }>).map(withValidationSummary);
  return {
    assignment: rows.find(r => r.schedule_slot_id === triggerSlotId) ?? null,
    siblings: rows.filter(r => r.schedule_slot_id !== triggerSlotId),
  };
}

export async function POST(req: NextRequest) {
  const sb = sbSchedulingServer();
  const body = await req.json();

  // Run rules engine BEFORE persisting so we can store violations alongside
  // the assignment in a single round-trip. If the evaluation was incomplete
  // (context unavailable / evaluator threw), the assignment still saves but
  // its flags become a SENTINEL warning ('validation unavailable — needs
  // re-validation') — never a fake-clean [], and never the previous
  // provider's stale violations on a reassignment (the conflict-update flips
  // provider_id, so omitting the column would leave provider A's flags on
  // provider B's row).
  const evalResult = await evaluateAssignment(sb, body.schedule_slot_id, body.provider_id);
  if (!evalResult.evaluated) {
    console.error(`[rulesEngine] validation unavailable for slot ${body.schedule_slot_id} — writing needs-re-validation sentinel`);
  }

  // One assignment row per slot, enforced by assignments_schedule_slot_id_key
  // (migration 20260524000000_add_assignment_unique_constraints.sql). Upsert
  // is atomic, so two concurrent edits can't both insert a duplicate row for
  // the same slot (the previous update-else-insert raced).
  const upsertRow = {
    schedule_slot_id: body.schedule_slot_id,
    provider_id: body.provider_id,
    assignment_status: 'assigned',
    source_type: 'manual',
    assigned_at: new Date().toISOString(),
    validation_flags: validationFlagsFor(evalResult),
  };

  // highlight_color: null is LOAD-BEARING, not decoration (2026-07-28,
  // patch42). ON CONFLICT DO UPDATE rewrites exactly the columns named in the
  // payload and leaves every other column untouched, so a REASSIGNMENT (this
  // upsert flipping provider_id on an existing row) would otherwise carry
  // provider A's hand-set billing mark straight onto provider B's call. That
  // is the same failure the validation_flags comment above guards against, and
  // it matters more here: the mark exists to tell a physician which of THEIR
  // calls is billable. Naming the column clears it, which is the documented
  // contract — the mark lives on the assignment and dies with it.
  //
  // Narrow retry for the same reason the reads have one: on a pre-patch42 DB
  // the column does not exist and naming it would fail the write outright,
  // turning "highlighting isn't available yet" into "you cannot assign anyone".
  // Dropping it there is exact — a column that does not exist holds no mark.
  const upsert = (row: Record<string, unknown>) => sb
    .from('assignments')
    .upsert(row, { onConflict: 'schedule_slot_id' })
    .select()
    .single() as unknown as Promise<WideRes>;

  // notes: cleared on reassignment for the SAME reason highlight_color is —
  // a cell comment describes THIS placement ("covering for Jones"), and
  // carrying it onto whoever replaces them would be a lie the scheduler never
  // wrote. Named explicitly, because an unnamed column would silently persist.
  let upsertRes = await upsert({ ...upsertRow, highlight_color: null, notes: null });
  if (upsertRes.error && isMissingColumnErr(upsertRes.error)) {
    upsertRes = await upsert({ ...upsertRow, notes: null });
  }
  if (upsertRes.error) return NextResponse.json({ error: upsertRes.error.message }, { status: 500 });
  const data = upsertRes.data as Record<string, unknown> | null;

  // Sequence auto-fill reads the site's ACTIVE CALL PATTERN (loaded once
  // inside the module off the trigger slot's site — rule_definitions are
  // validation-only). The auto-filled rows are left with validation_flags
  // null; revalidateNeighbors below evaluates them (same provider, within
  // ±7 days) and stores real flags.
  const fill = await applySequenceAutoFill(sb, body.schedule_slot_id, body.provider_id);
  const revalidatedSlotIds = await revalidateNeighbors(sb, body.schedule_slot_id, body.provider_id);
  // Re-select AFTER revalidateNeighbors so the returned rows carry fresh
  // validation_flags — and include the revalidated neighbor slots themselves,
  // whose stored flags may have just changed (e.g. a new hard violation
  // introduced by this edit).
  const { assignment, siblings } = await selectAffectedRows(
    sb, body.schedule_slot_id,
    [...fill.filledSlotIds, ...fill.evictedSlotIds, ...fill.postCallClearedSlotIds,
     ...revalidatedSlotIds]);
  // Backward-compatible response: existing fields plus the auto-fill outcome
  // (skips use the SkippedDerived vocabulary — clinical invariant 4;
  // evictedSlotIds reports pre-fills reverted by a higher-precedence fill;
  // patternWarnings surfaces call-pattern load problems, genContext-style)
  // plus the re-selected joined rows so the client can patch cells in place.
  return NextResponse.json({
    ...data,
    validation: evalResult,
    filledSlotIds: fill.filledSlotIds,
    evictedSlotIds: fill.evictedSlotIds,
    // Day shifts vacated by the post-call sweep — the client repaints these
    // cells, so a row disappearing from the grid is always visible.
    postCallClearedSlotIds: fill.postCallClearedSlotIds,
    skips: fill.skips,
    patternWarnings: fill.patternWarnings,
    assignment,
    siblings,
  });
}

// A cell comment is a tooltip, not a document. Capped so one cannot become an
// unreadable wall of text on hover, and so the grid payload stays small.
const NOTES_MAX = 500;

export async function PATCH(req: NextRequest) {
  const sb = sbSchedulingServer();
  const body = await req.json();
  const { id, ...rest } = body;
  const fields = rest as Record<string, unknown>;

  // highlight_color hardening (2026-07-28, patch42) — the same route-hardening
  // idiom the schedule PATCH uses for provider_limits / schedule_name /
  // scenario_manifest: when the key is PRESENT it is shape-validated before any
  // write, and a bad value is a 400 that never reaches the DB. The client is
  // never trusted here even though the DB carries a CHECK constraint: the CHECK
  // is the last line of defence, and a constraint violation surfaces as an
  // opaque 500 rather than a message anyone can act on. `null` is valid and
  // means "clear the manual mark".
  const wantsHighlight = 'highlight_color' in fields;
  if (wantsHighlight) {
    const parsed = parseHighlightColor(fields.highlight_color);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    fields.highlight_color = parsed.value;
  }

  // notes (cell comment, 2026-08-02) — same hardening idiom as highlight_color
  // above: shape-validated when PRESENT, never trusted from the client. null /
  // '' both mean "clear the comment"; whitespace is trimmed so a blank-looking
  // comment is genuinely absent rather than rendering an empty tooltip.
  if ('notes' in fields) {
    const raw = fields.notes;
    if (raw !== null && typeof raw !== 'string') {
      return NextResponse.json({ error: 'notes must be a string or null' }, { status: 400 });
    }
    const trimmed = typeof raw === 'string' ? raw.trim() : null;
    if (trimmed && trimmed.length > NOTES_MAX) {
      return NextResponse.json(
        { error: `Comment is too long (${trimmed.length}/${NOTES_MAX} characters).` },
        { status: 400 });
    }
    fields.notes = trimmed && trimmed.length > 0 ? trimmed : null;
  }

  const { data, error } = await sb
    .from('assignments')
    .update(fields)
    .eq('id', id)
    .select()
    .single();
  if (error) {
    // Pre-patch42 DB: the write cannot degrade the way a read can (there is
    // nowhere to put the mark), so say exactly that instead of surfacing a raw
    // PostgREST column error. The grid itself keeps working — its read ladder
    // drops the column — so this is the ONLY thing the user loses in the
    // deploy→patch window, and they get told why.
    if (wantsHighlight && isMissingColumnErr(error)) {
      return NextResponse.json({
        error: 'Cell highlighting is not available yet — the database is missing '
          + 'assignments.highlight_color (apply supabase_scheduling_patch42_assignment_highlight.sql).',
      }, { status: 501 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Re-select the row in the grid column shape (providers join +
  // validation_summary) so the client can patch the cell without a refetch.
  // Best-effort: on failure `assignment` is null and the client falls back.
  const { data: joinedRow, error: joinErr } = await selectGridShapeById(sb, id);
  if (joinErr) {
    console.error('[schedule-assignments] PATCH re-select failed:', joinErr.message);
  }
  return NextResponse.json({
    ...data,
    assignment: joinedRow
      ? withValidationSummary(joinedRow as Record<string, unknown> & { validation_flags?: unknown })
      : null,
  });
}

export async function DELETE(req: NextRequest) {
  const sb = sbSchedulingServer();
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

  // Get the slot ID + provider before deleting so we can recreate an open
  // assignment AND revalidate that provider's neighbors.
  const { data: existing } = await sb
    .from('assignments')
    .select('schedule_slot_id, provider_id')
    .eq('id', id)
    .single();

  // Clean up any sequence auto-fills BEFORE deleting the trigger row,
  // since cleanup needs to know which provider triggered the auto-fill.
  // Cleanup derives the linked slots from the same active call pattern the
  // fill path uses (loaded inside the module off the trigger slot's site).
  let clearedSlotIds: string[] = [];
  let patternWarnings: string[] = [];
  if (existing?.provider_id) {
    ({ clearedSlotIds, patternWarnings } = await cleanupSequenceAutoFill(
      sb, existing.schedule_slot_id, existing.provider_id));
  }

  // Delete the assignment
  const { error } = await sb.from('assignments').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Recreate as open
  if (existing) {
    const { data: newOpen, error: insertErr } = await sb
      .from('assignments')
      .insert({
        schedule_slot_id: existing.schedule_slot_id,
        assignment_status: 'open',
        source_type: 'manual',
      })
      .select()
      .single();
    if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 500 });
    let revalidatedSlotIds: string[] = [];
    if (existing.provider_id) {
      revalidatedSlotIds = await revalidateNeighbors(sb, existing.schedule_slot_id, existing.provider_id);
    }
    // Re-select the recreated open row + the cleared auto-fill rows + any
    // neighbors whose stored flags were just rewritten (a violation cleared
    // by this delete must reach the client too) in the grid column shape.
    const { assignment, siblings } = await selectAffectedRows(
      sb, existing.schedule_slot_id, [...clearedSlotIds, ...revalidatedSlotIds]);
    // Backward-compatible: the recreated open row plus which linked auto-fills
    // were cleared alongside the delete (and any call-pattern load warnings).
    return NextResponse.json({ ...newOpen, clearedSlotIds, patternWarnings, assignment, siblings });
  }

  return NextResponse.json({ ok: true, clearedSlotIds, patternWarnings });
}

// Neighbor revalidation lives in route.helpers.ts — shared with the schedule
// assistant's assignment tools so both write paths keep stored flags fresh.
