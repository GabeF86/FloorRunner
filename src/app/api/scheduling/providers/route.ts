import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { listProviders, providerFiltersFrom } from '@/lib/queries/roster';
import {
  buildInitials,
  buildShortDisplay,
  validateProviderCreate,
  PROVIDER_STATUSES,
  PROVIDER_TYPES,
} from '@/lib/validation/providers';

// Never prerender — this route hits Supabase per request.
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  // Query logic lives in lib/queries/roster.ts so the server component that
  // renders this same list cannot drift from it.
  const { searchParams } = new URL(req.url);
  const result = await listProviders(sbSchedulingServer(), providerFiltersFrom(searchParams));
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json(result.rows);
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

