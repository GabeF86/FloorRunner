import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';

export async function GET(req: NextRequest) {
  const sb = sbSchedulingServer();
  const { searchParams } = new URL(req.url);
  const orgId = searchParams.get('org_id');

  let query = sb.from('providers').select('*, provider_employment_profiles(*)').order('last_name');
  if (orgId) query = query.eq('organization_id', orgId);

  const status = searchParams.get('status');
  if (status) query = query.eq('status', status);

  const providerType = searchParams.get('provider_type');
  if (providerType) query = query.eq('provider_type', providerType);

  const search = searchParams.get('search');
  if (search) query = query.or(`first_name.ilike.%${search}%,last_name.ilike.%${search}%`);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  const sb = sbSchedulingServer();
  const body = await req.json();

  // Generate short display name and initials
  const first = body.first_name || '';
  const last = body.last_name || '';
  const shortDisplay = `${first.charAt(0)}.${last}`;
  const initials = `${first.charAt(0)}${last.charAt(0)}`.toUpperCase();

  const providerRow: Record<string, unknown> = {
    organization_id: body.organization_id,
    provider_type: body.provider_type,
    first_name: first,
    last_name: last,
    preferred_display_name: body.preferred_display_name || `${first} ${last}`,
    short_display_name: shortDisplay,
    initials,
    email: body.email || null,
    phone: body.phone || null,
    status: body.status || 'active',
  };
  if (body.home_address) providerRow.home_address = body.home_address;
  if (body.start_date) providerRow.start_date = body.start_date;

  const { data: provider, error } = await sb
    .from('providers')
    .insert(providerRow)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Create employment profile
  const profile: Record<string, unknown> = {
    provider_id: provider.id,
    employment_status: body.employment_status || 'full_time',
    call_taker: body.call_taker ?? false,
    is_shareholder: body.is_shareholder ?? false,
    home_site_id: body.home_site_id || null,
    fellowship_primary: body.fellowship_primary || null,
  };
  if (body.is_partner_track !== undefined) profile.is_partner_track = body.is_partner_track;

  const { error: profError } = await sb
    .from('provider_employment_profiles')
    .insert(profile);

  if (profError) return NextResponse.json({ error: profError.message }, { status: 500 });

  // Re-fetch with profile
  const { data: full } = await sb
    .from('providers')
    .select('*, provider_employment_profiles(*)')
    .eq('id', provider.id)
    .single();

  return NextResponse.json(full);
}
