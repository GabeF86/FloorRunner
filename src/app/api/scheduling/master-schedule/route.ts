import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';

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
    const { data: version } = await sb
      .from('schedule_versions')
      .select('id')
      .eq('schedule_id', sched.id as string)
      .eq('version_status', 'published')
      .order('version_number', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!version) continue;

    const { data: slots } = await sb
      .from('schedule_slots')
      .select(
        '*, shift_types(id, code, name, color_hex, category, display_order, provider_group), assignments(id, provider_id, assignment_status, is_open_call, source_type, providers(id, short_display_name, initials, provider_type))',
      )
      .eq('schedule_version_id', (version as { id: string }).id)
      .gte('slot_date', from)
      .lte('slot_date', to)
      .order('slot_date')
      .order('slot_index');

    if (slots) {
      allSlots.push(
        ...(slots as Array<Record<string, unknown>>).map(s => ({
          ...s,
          schedule_id: sched.id,
          schedule_name: sched.schedule_name,
          schedule_type: sched.schedule_type,
        })),
      );
    }
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
    const { data: prov } = await sb
      .from('providers')
      .select('id, first_name, last_name, short_display_name, initials, provider_type')
      .in('id', Array.from(providerIds));
    providers = (prov || []) as Array<Record<string, unknown>>;
  }

  return NextResponse.json({
    schedules,
    slots: allSlots,
    providers,
  });
}
