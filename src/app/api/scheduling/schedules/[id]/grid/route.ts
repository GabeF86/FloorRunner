import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const sb = sbSchedulingServer();
  const { id } = await params;

  // 1. Fetch schedule with site join
  const { data: schedule, error: schedErr } = await sb
    .from('schedules')
    .select('*, sites(name, short_name, timezone, call_par_level)')
    .eq('id', id)
    .single();
  if (schedErr) return NextResponse.json({ error: schedErr.message }, { status: 500 });

  // 2. Fetch latest schedule version
  const { data: version, error: verErr } = await sb
    .from('schedule_versions')
    .select('id, version_number, version_status')
    .eq('schedule_id', id)
    .order('version_number', { ascending: false })
    .limit(1)
    .single();
  if (verErr) return NextResponse.json({ error: verErr.message }, { status: 500 });

  // 3. Fetch slots with shift_types and assignments->providers
  const { data: slots, error: slotErr } = await sb
    .from('schedule_slots')
    .select(
      '*, shift_types(id, code, name, color_hex, category, call_type, display_order, provider_group), assignments(id, provider_id, assignment_status, is_open_call, manually_overridden, source_type, notes, validation_flags, pre_call_activation, providers(id, last_name, short_display_name, initials, provider_type))'
    )
    .eq('schedule_version_id', version.id)
    .order('slot_date')
    .order('slot_index');
  if (slotErr) return NextResponse.json({ error: slotErr.message }, { status: 500 });

  // 4. Fetch providers for org filtered by provider_group
  let providerQuery = sb
    .from('providers')
    .select('id, first_name, last_name, short_display_name, initials, provider_type, status')
    .eq('organization_id', schedule.organization_id)
    .eq('status', 'active')
    .order('last_name');

  if (schedule.provider_group === 'physician') {
    providerQuery = providerQuery.eq('provider_type', 'physician');
  } else if (schedule.provider_group === 'crna') {
    providerQuery = providerQuery.eq('provider_type', 'crna');
  }

  const { data: providers, error: provErr } = await providerQuery;
  if (provErr) return NextResponse.json({ error: provErr.message }, { status: 500 });

  // 5. Fetch holidays within schedule date range
  const { data: holidays, error: holErr } = await sb
    .from('holiday_calendars')
    .select('holiday_date, holiday_name, holiday_type, is_major_holiday')
    .eq('organization_id', schedule.organization_id)
    .gte('holiday_date', schedule.date_start)
    .lte('holiday_date', schedule.date_end);
  if (holErr) return NextResponse.json({ error: holErr.message }, { status: 500 });

  // 6. Fetch employment profiles so the UI can tell which providers are
  //    home-site (for Off rows) and their call-taker status.
  const providerIds = (providers || []).map(p => p.id);
  const { data: profiles } = providerIds.length > 0
    ? await sb
        .from('provider_employment_profiles')
        .select('provider_id, home_site_id, call_taker, partial_call_taker, fte_value, employment_status')
        .in('provider_id', providerIds)
    : { data: [] };

  // 7. Fetch availability entries (PTO, sick, unavailable, etc.) overlapping
  //    the schedule date range.
  const { data: availability, error: availErr } = providerIds.length > 0
    ? await sb
        .from('provider_availability')
        // NOTE: column is `reason_code`, not `reason`. Supabase returns an
        // error if you select a missing column — and because the code
        // downstream only destructured `data`, the whole availability
        // array silently ended up as null/empty. That's what was hiding
        // every PTO entry from the grid, the Call Counts modal, and the
        // PTO virtual row. We now also capture `error` so a future column
        // rename fails loudly instead of silently.
        .select('provider_id, availability_type, start_date, end_date, approval_status, reason_code')
        .in('provider_id', providerIds)
        .lte('start_date', schedule.date_end)
        .gte('end_date', schedule.date_start)
    : { data: [], error: null };
  if (availErr) return NextResponse.json({ error: availErr.message }, { status: 500 });

  return NextResponse.json({
    schedule,
    version,
    slots: slots || [],
    providers: providers || [],
    holidays: holidays || [],
    profiles: profiles || [],
    availability: availability || [],
  }, {
    headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
  });
}
