import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';

export async function GET(req: NextRequest) {
  const sb = sbSchedulingServer();
  const { searchParams } = new URL(req.url);
  const orgId = searchParams.get('org_id');

  // NOTE: don't join provider_employment_profiles in the main query —
  // PostgREST join rows can come back empty intermittently after writes.
  // We fetch profiles in a second query and attach them in application code.
  let query = sb.from('providers').select('*').order('last_name');
  if (orgId) query = query.eq('organization_id', orgId);

  const status = searchParams.get('status');
  if (status) query = query.eq('status', status);

  const providerType = searchParams.get('provider_type');
  if (providerType) query = query.eq('provider_type', providerType);

  const search = searchParams.get('search');
  if (search) query = query.or(`first_name.ilike.%${search}%,last_name.ilike.%${search}%`);

  // Filter by site credentialing — restricts to providers with an active
  // credentials row for the given site.
  const credentialedSiteId = searchParams.get('credentialed_site_id');
  if (credentialedSiteId) {
    const { data: credRows, error: credErr } = await sb
      .from('provider_site_credentials')
      .select('provider_id')
      .eq('site_id', credentialedSiteId)
      .eq('is_active', true)
      .eq('credentialed', true);
    if (credErr) return NextResponse.json({ error: credErr.message }, { status: 500 });
    const ids = (credRows || []).map((r: { provider_id: string }) => r.provider_id);
    if (ids.length === 0) return NextResponse.json([]);
    query = query.in('id', ids);
  }

  const { data: providers, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!providers || providers.length === 0) return NextResponse.json([]);

  // Attach employment profiles via a separate query keyed by provider_id
  const providerIds = providers.map((p: { id: string }) => p.id);
  const { data: profiles } = await sb
    .from('provider_employment_profiles')
    .select('*')
    .in('provider_id', providerIds);
  const profileByProvider = new Map<string, unknown>();
  for (const prof of (profiles || []) as Array<{ provider_id: string }>) {
    profileByProvider.set(prof.provider_id, prof);
  }

  const withProfiles = (providers as Array<{ id: string }>).map(p => ({
    ...p,
    provider_employment_profiles: profileByProvider.has(p.id) ? [profileByProvider.get(p.id)] : [],
  }));
  return NextResponse.json(withProfiles);
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

  // Create employment profile.
  const profile: Record<string, unknown> = {
    provider_id: provider.id,
    employment_status: body.employment_status || 'full_time',
    call_taker: body.call_taker ?? false,
    is_shareholder: body.is_shareholder ?? false,
    is_partner_track: body.is_partner_track ?? false,
    home_site_id: body.home_site_id || null,
    fellowship_primary: body.fellowship_primary || null,
  };

  const { error: profError } = await sb
    .from('provider_employment_profiles')
    .insert(profile);

  if (profError) return NextResponse.json({ error: profError.message }, { status: 500 });

  // Re-fetch the two pieces separately and assemble — the Supabase join
  // sometimes returns an empty relationship array right after an insert.
  const [providerRes, profileRes] = await Promise.all([
    sb.from('providers').select('*').eq('id', provider.id).single(),
    sb.from('provider_employment_profiles').select('*').eq('provider_id', provider.id).maybeSingle(),
  ]);
  return NextResponse.json({
    ...(providerRes.data || {}),
    provider_employment_profiles: profileRes.data ? [profileRes.data] : [],
  });
}
