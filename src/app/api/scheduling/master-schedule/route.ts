import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { embedArray } from '@/lib/embed';
import { readAllRows } from '@/lib/pagedRead';

// GET /api/scheduling/master-schedule?site_id=...&from=...&to=...
// Returns a combined view of all published schedules for a site in the given
// date range. Merges call, shift, and assignment layers.
// Never prerender — this route hits Supabase per request.
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const sb = sbSchedulingServer();
  const { searchParams } = new URL(req.url);
  const siteId = searchParams.get('site_id');
  const from = searchParams.get('from');
  const to = searchParams.get('to');

  if (!siteId || !from || !to) {
    return NextResponse.json({ error: 'site_id, from, and to are required' }, { status: 400 });
  }

  // Find all published schedules that overlap the date range for this site
  const { data: schedules, error: schedErr } = await sb
    .from('schedules')
    .select('id, schedule_name, schedule_type, provider_group, date_start, date_end, status, published_version_number')
    .eq('site_id', siteId)
    .eq('status', 'published')
    .lte('date_start', to)
    .gte('date_end', from);
  if (schedErr) return NextResponse.json({ error: schedErr.message }, { status: 500 });

  if (!schedules || schedules.length === 0) {
    return NextResponse.json({ schedules: [], slots: [], providers: [] });
  }

  // For each published schedule, find the published version and its slots
  const allSlots: Array<Record<string, unknown>> = [];
  for (const sched of schedules as Array<Record<string, unknown>>) {
    const label = String(sched.schedule_name ?? sched.id);

    const { data: version, error: versionErr } = await sb
      .from('schedule_versions')
      .select('id')
      .eq('schedule_id', sched.id as string)
      .eq('version_status', 'published')
      .order('version_number', { ascending: false })
      .limit(1)
      .maybeSingle();
    // A failed lookup and "no published version" both arrive as a null
    // `version`. They must not share a branch: skipping on error would drop
    // this schedule's entire slate from a 200 response, and the caller would
    // read the gap as "nothing is scheduled".
    if (versionErr) {
      return NextResponse.json(
        { error: `Failed to load published version for ${label}: ${versionErr.message}` },
        { status: 500 },
      );
    }
    // Genuinely no published version yet — nothing to merge for this schedule.
    if (!version) continue;

    // PAGED. The merged view spans an arbitrary from..to range, so the row
    // count here is bounded by the caller's dates rather than by anything in
    // the schema. An un-ranged select would stop at PostgREST's silent 1000-row
    // cap and the missing tail would render as empty days on the master
    // schedule — a wrong answer that looks like a real one.
    const slotsRead = await readAllRows<Record<string, unknown>>(
      (rangeFrom, rangeTo) =>
        sb
          .from('schedule_slots')
          .select(
            '*, shift_types(id, code, name, color_hex, category, display_order, provider_group), assignments(id, provider_id, assignment_status, is_open_call, source_type, providers(id, short_display_name, initials, provider_type))',
            { count: 'exact' },
          )
          .eq('schedule_version_id', (version as { id: string }).id)
          .gte('slot_date', from)
          .lte('slot_date', to)
          .order('slot_date')
          .order('slot_index')
          // Tiebreaker: (slot_date, slot_index) alone is not guaranteed unique,
          // and paging over a non-deterministic order overlaps and drops rows.
          .order('id')
          .range(rangeFrom, rangeTo),
      `Failed to load slots for ${label}`,
    );
    if (slotsRead.error) {
      return NextResponse.json({ error: slotsRead.error }, { status: 500 });
    }

    allSlots.push(
      ...slotsRead.rows.map(s => ({
        ...s,
        // UNIQUE(schedule_slot_id) makes PostgREST return the assignments
        // embed as a SINGLE OBJECT (or null), not an array — normalize so
        // the provider-collection loop below and the JSON consumers always
        // see an array.
        assignments: embedArray(
          s.assignments as Record<string, unknown> | Record<string, unknown>[] | null,
        ),
        schedule_id: sched.id,
        schedule_name: sched.schedule_name,
        schedule_type: sched.schedule_type,
      })),
    );
  }

  // Unique providers referenced in these assignments
  const providerIds = new Set<string>();
  for (const slot of allSlots) {
    const assignments = (slot.assignments as Array<{ provider_id: string | null }>) || [];
    for (const a of assignments) {
      if (a.provider_id) providerIds.add(a.provider_id);
    }
  }

  let providers: Array<Record<string, unknown>> = [];
  if (providerIds.size > 0) {
    const { data: prov, error: provErr } = await sb
      .from('providers')
      .select('id, first_name, last_name, short_display_name, initials, provider_type')
      .in('id', Array.from(providerIds));
    // Every id here came from an assignment we just read, so a failure means
    // the lookup broke, never that the providers are absent. Returning an empty
    // roster would strip the names off slots that demonstrably have them.
    if (provErr) {
      return NextResponse.json(
        { error: `Failed to load providers: ${provErr.message}` },
        { status: 500 },
      );
    }
    providers = (prov || []) as Array<Record<string, unknown>>;
  }

  return NextResponse.json({
    schedules,
    slots: allSlots,
    providers,
  });
}
