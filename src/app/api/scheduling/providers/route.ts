import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import {

// Never prerender — this route hits Supabase per request.
export const dynamic = 'force-dynamic';
  buildInitials,
  buildShortDisplay,
  validateProviderCreate,
  PROVIDER_STATUSES,
  PROVIDER_TYPES,
} from '@/lib/validation/providers';

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
  if (status) {
    if (!(PROVIDER_STATUSES as readonly string[]).includes(status)) {
      return NextResponse.json({ error: `status must be one of: ${PROVIDER_STATUSES.join(', ')}` }, { status: 400 });
    }
    query = query.eq('status', status);
  }

  const providerType = searchParams.get('provider_type');
  if (providerType) {
    if (!(PROVIDER_TYPES as readonly string[]).includes(providerType)) {
      return NextResponse.json({ error: `provider_type must be one of: ${PROVIDER_TYPES.join(', ')}` }, { status: 400 });
    }
    query = query.eq('provider_type', providerType);
  }

  const search = searchParams.get('search');
  if (search) {
    // Escape PostgREST OR-filter reserved chars so a name with a comma/paren
    // can't break out of the filter expression.
    const safe = search.replace(/[,()%]/g, ' ').trim();
    if (safe) query = query.or(`first_name.ilike.%${safe}%,last_name.ilike.%${safe}%`);
  }

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

  const validation = validateProviderCreate(body);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const first = (body.first_name as string).trim();
  const last = (body.last_name as string).trim();

  // Employee-ID uniqueness is enforced by a partial UNIQUE index at the DB
  // level, but we check here to return a clear 409 instead of a generic
  // Postgres conflict.
  const employeeId = typeof body.employee_id === 'string' ? body.employee_id.trim() : '';
  if (employeeId) {
    const { data: existing } = await sb
      .from('providers')
      .select('id')
      .eq('organization_id', body.organization_id)
      .eq('employee_id', employeeId)
      .maybeSingle();
    if (existing) {
      return NextResponse.json(
        { error: `Employee ID "${employeeId}" is already in use` },
        { status: 409 },
      );
    }
  }

  const providerRow: Record<string, unknown> = {
    organization_id: body.organization_id,
    provider_type: body.provider_type,
    first_name: first,
    last_name: last,
    preferred_display_name: (typeof body.preferred_display_name === 'string' && body.preferred_display_name.trim())
      ? body.preferred_display_name.trim()
      : `${first} ${last}`,
    short_display_name: buildShortDisplay(first, last),
    initials: buildInitials(first, last),
    email: typeof body.email === 'string' && body.email.trim() ? body.email.trim() : null,
    phone: typeof body.phone === 'string' && body.phone.trim() ? body.phone.trim() : null,
    status: body.status || 'active',
  };
  if (employeeId) providerRow.employee_id = employeeId;
  if (body.npi && typeof body.npi === 'string') providerRow.npi = body.npi.trim();
  if (body.home_address) providerRow.home_address = String(body.home_address);
  if (body.start_date) providerRow.start_date = body.start_date;

  const { data: provider, error } = await sb
    .from('providers')
    .insert(providerRow)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Validate home_site_id belongs to the same org before linking it — keeps
  // stray IDs from crossing orgs even if the client is buggy.
  let homeSiteId: string | null = null;
  if (body.home_site_id) {
    const { data: site } = await sb
      .from('sites')
      .select('organization_id')
      .eq('id', body.home_site_id)
      .maybeSingle();
    if (site && site.organization_id === body.organization_id) {
      homeSiteId = body.home_site_id;
    }
  }

  // Create employment profile.
  const profile: Record<string, unknown> = {
    provider_id: provider.id,
    employment_status: body.employment_status || 'full_time',
    call_taker: body.call_taker ?? false,
    is_shareholder: body.is_shareholder ?? false,
    is_partner_track: body.is_partner_track ?? false,
    is_day_doc: body.is_day_doc ?? false,
    home_site_id: homeSiteId,
    fellowship_primary: typeof body.fellowship_primary === 'string' && body.fellowship_primary.trim()
      ? body.fellowship_primary.trim()
      : null,
  };
  if (body.fte_value !== undefined && body.fte_value !== null && body.fte_value !== '') {
    profile.fte_value = Number(body.fte_value);
  }

  const { error: profError } = await sb
    .from('provider_employment_profiles')
    .insert(profile);

  if (profError) {
    // Roll back the provider insert so we don't leave an orphaned row when
    // profile creation fails. Without this, the next retry would fail on
    // employee_id uniqueness (if set) and leave the user stuck.
    await sb.from('providers').delete().eq('id', provider.id);
    return NextResponse.json({ error: profError.message }, { status: 500 });
  }

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

