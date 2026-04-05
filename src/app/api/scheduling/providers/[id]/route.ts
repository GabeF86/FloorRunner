import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sb = sbSchedulingServer();

  const { data, error } = await sb
    .from('providers')
    .select('*, provider_employment_profiles(*), provider_site_credentials(*, sites:site_id(id, name, short_name))')
    .eq('id', id)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sb = sbSchedulingServer();
  const body = await req.json();

  // Separate provider fields from profile fields
  const providerFields: Record<string, unknown> = {};
  const profileFields: Record<string, unknown> = {};

  const PROVIDER_COLUMNS = [
    'first_name', 'last_name', 'preferred_display_name', 'short_display_name',
    'initials', 'provider_type', 'status', 'email', 'phone', 'home_address',
    'npi', 'employee_id', 'payroll_id', 'start_date', 'years_with_group',
    'notes_admin_only', 'color_tag', 'photo_url',
  ];

  for (const [key, val] of Object.entries(body)) {
    if (PROVIDER_COLUMNS.includes(key)) {
      providerFields[key] = val;
    } else if (key !== 'id' && key !== 'organization_id') {
      profileFields[key] = val;
    }
  }

  if (Object.keys(providerFields).length > 0) {
    const { error } = await sb.from('providers').update(providerFields).eq('id', id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (Object.keys(profileFields).length > 0) {
    const { error } = await sb.from('provider_employment_profiles').update(profileFields).eq('provider_id', id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Re-fetch
  const { data } = await sb
    .from('providers')
    .select('*, provider_employment_profiles(*), provider_site_credentials(*)')
    .eq('id', id)
    .single();

  return NextResponse.json(data);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sb = sbSchedulingServer();

  // Soft delete — set status to inactive
  const { error } = await sb.from('providers').update({ status: 'inactive' }).eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
