// GET /api/scheduling/planner?site_id&date_start&date_end (2026-07-20)
//
// One JSON payload the Physician Planner card computes from. The route only
// fetches + assembles — every computation lives in lib/plannerMath.ts (which
// itself only assembles the single-homed engine helpers). No engine
// invocation: actuals are reconstructed from plain reads.
//
// QUERIES (documented per the feature spec):
//   1. sites — id, name, organization_id, call_par_level for site_id.
//      404 when absent. call_par_level resolves through the engine's
//      DEFAULT_PAR_LEVEL rule (missing/<=0 → 12, genContext parity); the raw
//      stored value rides along as call_par_level_stored.
//   2. holiday_calendars — org holidays in [date_start, date_end], BOTH
//      major and federal: majors drive working days (workDays.ts contract),
//      federal rows drive day-type composition (template estimates).
//   3. shift_templates — active rows for the site (+ shift_types code/
//      category), aggregated to slot counts per (day_type, shift_type) by
//      aggregateTemplateSlotCounts. Retired templates (is_active false, e.g.
//      D8/D9) never appear. count-0 rows are kept — Friday suppression.
//   4. provider_employment_profiles — home_site_id = site_id (fte, call
//      flags, is_day_doc, is_icu_doc). The roster is home-site providers
//      with a profile; the client derives the call pool from the flags via
//      the shared census helper.
//   5. providers — active rows for those profile ids, ordered last_name
//      (roster order for the picker).
//   6. provider_availability — rows for roster providers overlapping the
//      range; dismissed (denied/canceled) rows are filtered through the
//      shared isDismissedAvailability semantics before they reach the
//      payload. Count-guarded (no silent 1000-row truncation).
//   7. schedules — most recent non-archived schedule for the site whose
//      [date_start, date_end] OVERLAPS the range (order date_start desc,
//      limit 1). None → actuals: null (legitimate pre-generation state).
//   8. schedule_versions — the schedule's current_version_number row → id.
//   9. schedule_slots — that version's slots CLIPPED to the range
//      (slot_date between date_start and date_end) with shift_types(code,
//      category, requires_post_call_rule) + assignments(provider_id,
//      assignment_status). Count-guarded. computeScheduleActuals turns these
//      into per-provider call counts by (bucket|code), assigned working
//      days, +1-day post-call rest days, and ICU-credited days.
//
// Failure posture: single payload, so any failed read is a 500 (a partial
// payload would compute wrong numbers as fact — same no-silent-clean ethos
// as the dashboard's panel guards). Only "no overlapping schedule" degrades,
// to actuals: null.

import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { isValidDate } from '@/lib/validation/providers';
import { DEFAULT_PAR_LEVEL } from '@/lib/rulesEngine/genContext';
import {
  MAX_PLANNER_RANGE_DAYS,
  aggregateTemplateSlotCounts,
  computeScheduleActuals,
  enumerateRange,
  liveAvailabilityRows,
  rangeComposition,
  type PlannerAvailabilityRow,
  type PlannerHoliday,
  type PlannerSlotRow,
  type PlannerTemplateRow,
} from '@/lib/plannerMath';

// Planner data changes out of band (availability writes, schedule edits) —
// never serve a cached payload.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const SLOT_COLUMNS =
  'slot_date, derived_day_type, shift_types(code, category, requires_post_call_rule), assignments(provider_id, assignment_status)';

// Row-fetching selects carry a count guard (dashboard queries.ts convention):
// PostgREST silently caps un-ranged selects at 1000 rows — a truncated read
// must become an error, never an undercount rendered as fact.
function truncated(res: { data: unknown; count: number | null }): boolean {
  const len = Array.isArray(res.data) ? res.data.length : 0;
  return res.count != null && len < res.count;
}

export async function GET(req: NextRequest) {
  const sb = sbSchedulingServer();
  const { searchParams } = new URL(req.url);

  // ── Param validation (hardened-route conventions) ──────────────────────────
  const siteId = searchParams.get('site_id');
  if (!siteId) {
    return NextResponse.json({ error: 'site_id is required' }, { status: 400 });
  }
  const dateStart = searchParams.get('date_start');
  const dateEnd = searchParams.get('date_end');
  if (!dateStart || !isValidDate(dateStart)) {
    return NextResponse.json({ error: 'date_start must be YYYY-MM-DD' }, { status: 400 });
  }
  if (!dateEnd || !isValidDate(dateEnd)) {
    return NextResponse.json({ error: 'date_end must be YYYY-MM-DD' }, { status: 400 });
  }
  if (dateEnd < dateStart) {
    return NextResponse.json({ error: 'date_end must be on or after date_start' }, { status: 400 });
  }
  // Bound the range BEFORE any enumeration (enumerateRange throws past the
  // same limit — the lib guard is a backstop, this 400 is the contract).
  try {
    enumerateRange(dateStart, dateEnd);
  } catch {
    return NextResponse.json(
      { error: `date range must be at most ${MAX_PLANNER_RANGE_DAYS} days` },
      { status: 400 },
    );
  }

  // ── 1. Site ────────────────────────────────────────────────────────────────
  const { data: site, error: siteErr } = await sb
    .from('sites')
    .select('id, name, organization_id, call_par_level')
    .eq('id', siteId)
    .maybeSingle();
  if (siteErr) return NextResponse.json({ error: siteErr.message }, { status: 500 });
  if (!site) return NextResponse.json({ error: 'site not found' }, { status: 404 });

  const storedPar = site.call_par_level as number | null;
  const parLevel =
    typeof storedPar === 'number' && storedPar > 0 ? storedPar : DEFAULT_PAR_LEVEL;

  // ── 2–4 + 7: independent site/org-scoped reads in one wave ────────────────
  const [holidaysRes, templatesRes, profilesRes, scheduleRes] = await Promise.all([
    sb
      .from('holiday_calendars')
      .select('holiday_date, is_major_holiday')
      .eq('organization_id', site.organization_id)
      .gte('holiday_date', dateStart)
      .lte('holiday_date', dateEnd),
    sb
      .from('shift_templates')
      .select('day_type, shift_type_id, required_count, shift_types(code, category)')
      .eq('site_id', siteId)
      .eq('is_active', true),
    sb
      .from('provider_employment_profiles')
      .select('provider_id, fte_value, home_site_id, call_taker, partial_call_taker, is_day_doc, is_icu_doc')
      .eq('home_site_id', siteId),
    sb
      .from('schedules')
      .select('id, schedule_name, status, date_start, date_end, current_version_number')
      .eq('site_id', siteId)
      .neq('status', 'archived')
      .lte('date_start', dateEnd)
      .gte('date_end', dateStart)
      .order('date_start', { ascending: false })
      .limit(1),
  ]);
  if (holidaysRes.error) return NextResponse.json({ error: holidaysRes.error.message }, { status: 500 });
  if (templatesRes.error) return NextResponse.json({ error: templatesRes.error.message }, { status: 500 });
  if (profilesRes.error) return NextResponse.json({ error: profilesRes.error.message }, { status: 500 });
  if (scheduleRes.error) return NextResponse.json({ error: scheduleRes.error.message }, { status: 500 });

  const holidays = (holidaysRes.data ?? []) as PlannerHoliday[];
  // supabase-js's untyped client guesses to-one embeds as arrays — the real
  // shape is the single object the select string describes (grid route
  // precedent); normalize through unknown.
  const templates = aggregateTemplateSlotCounts(
    (templatesRes.data ?? []) as unknown as PlannerTemplateRow[]);
  const profiles = (profilesRes.data ?? []) as Array<{
    provider_id: string;
    fte_value: number | null;
    home_site_id: string | null;
    call_taker: boolean;
    partial_call_taker: boolean;
    is_day_doc: boolean;
    is_icu_doc: boolean;
  }>;
  const schedule = ((scheduleRes.data ?? []) as Array<Record<string, unknown>>)[0] ?? null;

  // ── 5–6: roster + availability for the profile providers ──────────────────
  const profileByPid = new Map(profiles.map(p => [p.provider_id, p]));
  const providerIds = [...profileByPid.keys()];

  const [providersRes, availabilityRes] = providerIds.length > 0
    ? await Promise.all([
        sb
          .from('providers')
          .select('id, first_name, last_name, short_display_name, initials, provider_type')
          .in('id', providerIds)
          .eq('status', 'active')
          .order('last_name'),
        sb
          .from('provider_availability')
          .select('provider_id, availability_type, start_date, end_date, approval_status, reason_code', { count: 'exact' })
          .in('provider_id', providerIds)
          .lte('start_date', dateEnd)
          .gte('end_date', dateStart),
      ])
    : [{ data: [], error: null }, { data: [], error: null, count: 0 }];
  if (providersRes.error) return NextResponse.json({ error: providersRes.error.message }, { status: 500 });
  if (availabilityRes.error) return NextResponse.json({ error: availabilityRes.error.message }, { status: 500 });
  if (truncated(availabilityRes as { data: unknown; count: number | null })) {
    return NextResponse.json({ error: 'availability results truncated' }, { status: 500 });
  }

  const roster = ((providersRes.data ?? []) as Array<{
    id: string;
    first_name: string | null;
    last_name: string | null;
    short_display_name: string | null;
    initials: string | null;
    provider_type: string | null;
  }>).map(p => {
    const prof = profileByPid.get(p.id)!;
    return {
      provider_id: p.id,
      first_name: p.first_name,
      last_name: p.last_name,
      short_display_name: p.short_display_name,
      initials: p.initials,
      provider_type: p.provider_type,
      fte_value: prof.fte_value,
      home_site_id: prof.home_site_id,
      call_taker: prof.call_taker,
      partial_call_taker: prof.partial_call_taker,
      is_day_doc: prof.is_day_doc,
      is_icu_doc: prof.is_icu_doc,
    };
  });

  const availability = liveAvailabilityRows(
    (availabilityRes.data ?? []) as PlannerAvailabilityRow[]);

  // ── 8–9: actuals from the overlapping schedule's current version ──────────
  const comp = rangeComposition(dateStart, dateEnd, holidays);
  let actuals: null | {
    schedule: Record<string, unknown>;
    byProvider: ReturnType<typeof computeScheduleActuals>;
  } = null;
  if (schedule) {
    const { data: version, error: verErr } = await sb
      .from('schedule_versions')
      .select('id')
      .eq('schedule_id', schedule.id)
      .eq('version_number', schedule.current_version_number)
      .maybeSingle();
    if (verErr) return NextResponse.json({ error: verErr.message }, { status: 500 });
    if (!version) {
      return NextResponse.json(
        { error: `schedule ${schedule.id} has no version ${schedule.current_version_number}` },
        { status: 500 },
      );
    }
    const slotsRes = await sb
      .from('schedule_slots')
      .select(SLOT_COLUMNS, { count: 'exact' })
      .eq('schedule_version_id', version.id)
      .gte('slot_date', dateStart)
      .lte('slot_date', dateEnd)
      .order('slot_date');
    if (slotsRes.error) return NextResponse.json({ error: slotsRes.error.message }, { status: 500 });
    if (truncated(slotsRes as { data: unknown; count: number | null })) {
      return NextResponse.json({ error: 'schedule slot results truncated' }, { status: 500 });
    }
    actuals = {
      schedule: {
        id: schedule.id,
        schedule_name: schedule.schedule_name,
        status: schedule.status,
        date_start: schedule.date_start,
        date_end: schedule.date_end,
        version_number: schedule.current_version_number,
      },
      byProvider: computeScheduleActuals(
        (slotsRes.data ?? []) as unknown as PlannerSlotRow[],
        availability, comp.workingDaySet, holidays),
    };
  }

  return NextResponse.json({
    site: {
      id: site.id,
      name: site.name,
      call_par_level: parLevel,
      call_par_level_stored: storedPar,
    },
    range: { date_start: dateStart, date_end: dateEnd },
    holidays,
    templates,
    roster,
    availability,
    actuals,
  }, {
    headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
  });
}
