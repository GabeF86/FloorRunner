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
    .select('*, sites(name, short_name, timezone)')
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
      '*, shift_types(id, code, name, color_hex, category, call_type, display_order, provider_group), assignments(id, provider_id, assignment_status, is_open_call, manually_overridden, source_type, notes, providers(id, short_display_name, initials, provider_type))'
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

  return NextResponse.json({
    schedule,
    version,
    slots: slots || [],
    providers: providers || [],
    holidays: holidays || [],
  }, {
    headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
  });
}
