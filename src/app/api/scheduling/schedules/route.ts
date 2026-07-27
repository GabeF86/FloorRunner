import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { derivedDayTypeFor, slateForDayType, templateSlotCount } from '@/lib/templateSlots';
import { defaultScheduleName, parseScheduleName } from '@/lib/scheduleName';
import { loadLastActivity, withLastActivity, type ScheduleActivityRow } from '@/lib/scheduleActivity';

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
  if (slotRows.length > 0) {
    const { data: slots, error: slotErr } = await sb
      .from('schedule_slots')
      .insert(slotRows)
      .select('id');
    if (slotErr) return NextResponse.json({ error: slotErr.message }, { status: 500 });

    // Create open assignments for each slot
    const assignmentRows = (slots || []).map((s: { id: string }) => ({
      schedule_slot_id: s.id,
      assignment_status: 'open',
      source_type: 'manual',
    }));

    const { error: assignErr } = await sb.from('assignments').insert(assignmentRows);
    if (assignErr) return NextResponse.json({ error: assignErr.message }, { status: 500 });
  }

  return NextResponse.json({ ...schedule, version_id: version.id });
}
