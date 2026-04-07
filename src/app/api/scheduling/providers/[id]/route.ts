import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sb = sbSchedulingServer();

  // Fetch the three pieces separately. Using a Supabase join here was
  // unreliable (PostgREST would sometimes return an empty relationship
  // array), which caused the old auto-heal logic below to INSERT a new
  // default profile on every refresh — silently wiping user saves.
  const [providerRes, profileRes, credsRes] = await Promise.all([
    sb.from('providers').select('*').eq('id', id).single(),
    sb.from('provider_employment_profiles').select('*').eq('provider_id', id).maybeSingle(),
    sb
      .from('provider_site_credentials')
      .select('*, sites:site_id(id, name, short_name)')
      .eq('provider_id', id),
  ]);

  if (providerRes.error) {
    return NextResponse.json({ error: providerRes.error.message }, { status: 500 });
  }

  // Auto-heal: only if we definitively confirm there's no profile row via
  // a direct select. maybeSingle returns null when there's no match, so
  // data===null here is reliable (unlike the previous join-based check).
  let profile = profileRes.data;
  if (!profile) {
    const { data: inserted, error: insertErr } = await sb
      .from('provider_employment_profiles')
      .insert({ provider_id: id, employment_status: 'full_time', call_taker: false })
      .select()
      .single();
    if (insertErr) {
      console.error('[providers GET] auto-heal insert failed:', insertErr);
    }
    profile = inserted;
  }

  return NextResponse.json({
    ...(providerRes.data || {}),
    provider_employment_profiles: profile ? [profile] : [],
    provider_site_credentials: credsRes.data || [],
  });
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
    // Native upsert on the UNIQUE (provider_id) constraint — one round trip
    // instead of select-then-update-or-insert.
    const { error } = await sb
      .from('provider_employment_profiles')
      .upsert({ provider_id: id, ...profileFields }, { onConflict: 'provider_id' });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Re-fetch the three pieces separately. Supabase PostgREST occasionally
  // fails to return the joined rows right after a write in a relation,
  // so we assemble the response manually.
  const [providerRes, profileRes, credsRes] = await Promise.all([
    sb.from('providers').select('*').eq('id', id).single(),
    sb.from('provider_employment_profiles').select('*').eq('provider_id', id).maybeSingle(),
    sb
      .from('provider_site_credentials')
      .select('*, sites:site_id(id, name, short_name)')
      .eq('provider_id', id),
  ]);

  const assembled = {
    ...(providerRes.data || {}),
    provider_employment_profiles: profileRes.data ? [profileRes.data] : [],
    provider_site_credentials: credsRes.data || [],
  };

  return NextResponse.json(assembled);
}

// DELETE /api/scheduling/providers/:id
//   default behavior: hard delete (cascades remove profile + credentials)
//   ?soft=true       : soft delete by setting status='inactive'
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sb = sbSchedulingServer();
  const soft = new URL(req.url).searchParams.get('soft') === 'true';

  if (soft) {
    const { error } = await sb.from('providers').update({ status: 'inactive' }).eq('id', id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  const { error } = await sb.from('providers').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, deleted: true });
}
