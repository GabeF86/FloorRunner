import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { derivedDayTypeFor, slateForDayType, templateSlotCount } from '@/lib/templateSlots';
import { defaultScheduleName, parseScheduleName } from '@/lib/scheduleName';
import { loadLastActivity, withLastActivity, type ScheduleActivityRow } from '@/lib/scheduleActivity';
import {
  HOLIDAY_CALL_TYPE,
  planHolidayCallSeeds,
  type HolidayCallSlot,
  type HolidayCallSeedSkip,
} from '@/lib/holidayCall';

// Never prerender — this route hits Supabase per request.
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const sb = sbSchedulingServer();
  const { searchParams } = new URL(req.url);

  let query = sb
    .from('schedules')
    .select('*, sites(name, short_name)')
    .order('date_start', { ascending: false });

  const orgId = searchParams.get('org_id');
  if (orgId) query = query.eq('organization_id', orgId);

  const siteId = searchParams.get('site_id');
  if (siteId) query = query.eq('site_id', siteId);

  const status = searchParams.get('status');
  if (status) query = query.eq('status', status);

  const scheduleType = searchParams.get('schedule_type');
  if (scheduleType) query = query.eq('schedule_type', scheduleType);

  const providerGroup = searchParams.get('provider_group');
  if (providerGroup) query = query.eq('provider_group', providerGroup);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // `last_activity_at` — the last time this schedule's CONTENT changed, which
  // is emphatically not `schedules.updated_at` (that column only moves when
  // the row itself does; generation and grid edits write assignments). ONE
  // extra round trip for the whole list — the patch39 RPC folds all four
  // sources in Postgres, because this project has PostgREST aggregates
  // disabled. Degrades to the schedule row (with a warning) if the function
  // isn't there or the call fails; the list always renders. See
  // lib/scheduleActivity.ts for the derivation and the write-path evidence.
  const rows = (data as ScheduleActivityRow[]) || [];
  const { lastActivityById, warnings } = await loadLastActivity(sb, rows);
  for (const w of warnings) console.warn(`[schedules] ${w}`);
  return NextResponse.json(withLastActivity(rows, lastActivityById));
}

export async function POST(req: NextRequest) {
  const sb = sbSchedulingServer();
  const body = await req.json();

  // Optional custom name (Gabriel 2026-07-22): overrides the generated
  // default when non-empty; blank/absent keeps the historical generated
  // name. Route-hardened (trimmed, ≤ 120 chars) BEFORE any write.
  const customName = parseScheduleName(body.schedule_name, { blankIsDefault: true });
  if (!customName.ok) {
    return NextResponse.json({ error: customName.error }, { status: 400 });
  }

  // 1. Fetch site name for schedule_name generation
  const { data: site, error: siteErr } = await sb
    .from('sites')
    .select('name')
    .eq('id', body.site_id)
    .single();
  if (siteErr) return NextResponse.json({ error: siteErr.message }, { status: 500 });

  const scheduleName = customName.value ?? defaultScheduleName(site.name, body.date_start);

  // 2. Insert schedule
  const { data: schedule, error: schedErr } = await sb
    .from('schedules')
    .insert({
      organization_id: body.organization_id,
      site_id: body.site_id,
      schedule_type: body.schedule_type,
      provider_group: body.provider_group,
      date_start: body.date_start,
      date_end: body.date_end,
      schedule_name: scheduleName,
      status: 'draft',
    })
    .select()
    .single();
  if (schedErr) return NextResponse.json({ error: schedErr.message }, { status: 500 });

  // 3. Insert schedule version
  const { data: version, error: verErr } = await sb
    .from('schedule_versions')
    .insert({
      schedule_id: schedule.id,
      version_number: 1,
      version_status: 'draft',
    })
    .select()
    .single();
  if (verErr) return NextResponse.json({ error: verErr.message }, { status: 500 });

  // 4. Fetch ALL active shift templates for site (call + shifts combined)
  const { data: templates, error: tmplErr } = await sb
    .from('shift_templates')
    .select('*, shift_types(name, display_order)')
    .eq('site_id', body.site_id)
    .eq('is_active', true);
  if (tmplErr) return NextResponse.json({ error: tmplErr.message }, { status: 500 });

  // 5. Fetch holiday calendars for org within date range
  const { data: holidays, error: holErr } = await sb
    .from('holiday_calendars')
    .select('*')
    .eq('organization_id', body.organization_id)
    .gte('holiday_date', body.date_start)
    .lte('holiday_date', body.date_end);
  if (holErr) return NextResponse.json({ error: holErr.message }, { status: 500 });

  const holidayMap = new Map<string, { is_major_holiday: boolean; holiday_type: string }>();
  for (const h of holidays || []) {
    holidayMap.set(h.holiday_date, { is_major_holiday: h.is_major_holiday, holiday_type: h.holiday_type });
  }

  // 6. For each date in range, generate slots and assignments
  const slotRows: Record<string, unknown>[] = [];
  const current = new Date(body.date_start + 'T12:00:00');
  const end = new Date(body.date_end + 'T12:00:00');

  while (current <= end) {
    const dateStr = current.toISOString().split('T')[0];

    // Day typing + template matching are single-homed in lib/templateSlots.ts
    // (shared with the Physician Planner's estimates so they can never diverge
    // from real slot creation): derivedDayTypeFor carries the major/federal/
    // DOW precedence; slateForDayType carries the FRIDAY PARTIAL-OVERRIDE
    // CONTRACT (2026-07-16 — friday rows override per shift type, other
    // weekday templates still materialize, count-0 friday rows suppress);
    // templateSlotCount carries the required_count semantics.
    const dayType = derivedDayTypeFor(dateStr, holidayMap.get(dateStr));
    const matching = slateForDayType(
      (templates || []) as Array<Record<string, unknown>>, dayType);
    // required_count materializes as SIBLING slot rows (slot_index 0..N-1),
    // each with required_count: 1 and its own open assignment row —
    // scheduling.assignments has UNIQUE(schedule_slot_id), so one assignment
    // per slot is the data model and siblings are how multi-coverage works.
    for (const tmpl of matching) {
      // required_count <= 0 means "no slots for this template" — never coerce
      // 0 to 1 (Task 11 review finding). null/undefined keep the default of 1.
      const count = templateSlotCount(tmpl);
      for (let i = 0; i < count; i++) {
        slotRows.push({
          schedule_version_id: version.id,
          site_id: body.site_id,
          slot_date: dateStr,
          shift_type_id: tmpl.shift_type_id,
          slot_index: i,
          required_count: 1,
          derived_day_type: dayType,
          locked: false,
        });
      }
    }

    current.setDate(current.getDate() + 1);
  }

  // Batch insert slots
  let createdSlots: SlotRow[] = [];
  let createdAssignments: AssignmentRow[] = [];
  if (slotRows.length > 0) {
    const { data: slots, error: slotErr } = await sb
      .from('schedule_slots')
      .insert(slotRows)
      .select('id, slot_date, shift_type_id, slot_index');
    if (slotErr) return NextResponse.json({ error: slotErr.message }, { status: 500 });
    createdSlots = (slots || []) as SlotRow[];

    // Create open assignments for each slot
    const assignmentRows = createdSlots.map((s) => ({
      schedule_slot_id: s.id,
      assignment_status: 'open',
      source_type: 'manual',
    }));

    const { data: created, error: assignErr } = await sb
      .from('assignments')
      .insert(assignmentRows)
      .select('id, schedule_slot_id');
    if (assignErr) return NextResponse.json({ error: assignErr.message }, { status: 500 });
    createdAssignments = (created || []) as AssignmentRow[];
  }

  // 7. Materialize the chief's recorded holiday call plan (patch44).
  //
  // Holiday call decisions are made months before the schedule covering them
  // exists, so they live on provider_availability. This is where they become
  // real: matched onto the slots just created and written as LOCKED MANUAL
  // assignments, which the engine's existing seed walk (genContext §8) then
  // treats like any other pre-existing placement — no new engine path, and
  // source_type 'manual' keeps them out of reach of the pre-fill eviction
  // gates. See src/lib/holidayCall.ts.
  //
  // Never fatal: the schedule itself is already created and correct, so a
  // seeding failure is REPORTED on the response rather than 500-ing a
  // successful create. Unplaceable decisions come back in `skipped` — they
  // are not dropped silently (clinical invariant 4's discipline).
  const holidayCall = await seedHolidayCall(
    sb, body.site_id, body.date_start, body.date_end, createdSlots, createdAssignments,
  );

  return NextResponse.json({ ...schedule, version_id: version.id, holiday_call: holidayCall });
}

interface SlotRow { id: string; slot_date: string; shift_type_id: string; slot_index: number }
interface AssignmentRow { id: string; schedule_slot_id: string }

interface HolidayCallSeedReport {
  seeded: number;
  skipped: HolidayCallSeedSkip[];
  /** Present only when the seeding pass itself degraded. */
  error?: string;
}

async function seedHolidayCall(
  sb: ReturnType<typeof sbSchedulingServer>,
  siteId: string,
  dateStart: string,
  dateEnd: string,
  slots: SlotRow[],
  assignments: AssignmentRow[],
): Promise<HolidayCallSeedReport> {
  const empty: HolidayCallSeedReport = { seeded: 0, skipped: [] };
  if (slots.length === 0 || assignments.length === 0) return empty;
  // siteId is interpolated into a PostgREST `.or()` filter string below, where
  // a comma or paren would break out of the expression — only an exact UUID
  // is ever spliced in.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(siteId)) {
    return { seeded: 0, skipped: [], error: 'site_id is not a UUID — holiday call not seeded' };
  }

  const { data: entryRows, error: entryErr } = await sb
    .from('provider_availability')
    .select('provider_id, start_date, reason_code')
    .eq('availability_type', HOLIDAY_CALL_TYPE)
    .gte('start_date', dateStart)
    .lte('start_date', dateEnd)
    .or(`site_id.eq.${siteId},site_id.is.null`);
  // A pre-patch44 database has no 'holiday_call' enum value, so this query
  // errors rather than returning nothing. Report and carry on — schedule
  // creation must keep working before the patch lands.
  if (entryErr) return { seeded: 0, skipped: [], error: entryErr.message };
  if (!entryRows || entryRows.length === 0) return empty;

  const { data: shiftTypes, error: stErr } = await sb
    .from('shift_types')
    .select('id, code')
    .eq('site_id', siteId);
  if (stErr) return { seeded: 0, skipped: [], error: stErr.message };
  const codeById = new Map<string, string>(
    (shiftTypes || []).map((s: { id: string; code: string }) => [s.id, s.code]),
  );

  const assignmentBySlot = new Map(assignments.map(a => [a.schedule_slot_id, a.id]));
  const seedSlots: HolidayCallSlot[] = [];
  for (const s of slots) {
    const code = codeById.get(s.shift_type_id);
    const assignmentId = assignmentBySlot.get(s.id);
    if (!code || !assignmentId) continue;
    seedSlots.push({
      slot_id: s.id, assignment_id: assignmentId,
      slot_date: s.slot_date, code, slot_index: s.slot_index,
    });
  }

  const plan = planHolidayCallSeeds(
    entryRows.map((r: { provider_id: string; start_date: string; reason_code: string | null }) => ({
      provider_id: r.provider_id,
      date: r.start_date,
      code: r.reason_code ?? '',
    })),
    seedSlots,
  );
  if (plan.fills.length === 0) return { seeded: 0, skipped: plan.skipped };

  // One update per provider (each holds a handful of holiday days at most)
  // rather than per row.
  const byProvider = new Map<string, string[]>();
  for (const f of plan.fills) {
    const list = byProvider.get(f.provider_id);
    if (list) list.push(f.assignment_id);
    else byProvider.set(f.provider_id, [f.assignment_id]);
  }
  for (const [providerId, assignmentIds] of byProvider) {
    const { error } = await sb
      .from('assignments')
      .update({
        provider_id: providerId,
        assignment_status: 'assigned',
        source_type: 'manual',
        manually_overridden: true,
        assigned_at: new Date().toISOString(),
        notes: 'Holiday call (recorded plan)',
      })
      .in('id', assignmentIds);
    if (error) return { seeded: 0, skipped: plan.skipped, error: error.message };
  }

  // Lock the slots so generation treats them as fixed structure.
  const { error: lockErr } = await sb
    .from('schedule_slots')
    .update({ locked: true })
    .in('id', plan.fills.map(f => f.slot_id));
  if (lockErr) {
    return { seeded: plan.fills.length, skipped: plan.skipped, error: `assignments seeded but slots not locked: ${lockErr.message}` };
  }

  return { seeded: plan.fills.length, skipped: plan.skipped };
}
