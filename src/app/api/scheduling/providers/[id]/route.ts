import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { validateAndSplitPatch } from '@/lib/validation/providers';

// Never prerender — this route hits Supabase per request.
export const dynamic = 'force-dynamic';

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
    const status = providerRes.error.code === 'PGRST116' ? 404 : 500;
    return NextResponse.json({ error: providerRes.error.message }, { status });
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
      // Don't swallow — if auto-heal failed, surface it. The previous
      // version silently set profile=undefined, which caused downstream
      // UI crashes that were extremely hard to diagnose. Return 500 so
      // the caller sees the real error.
      console.error('[providers GET] auto-heal insert failed:', insertErr);
      return NextResponse.json(
        { error: `Failed to create employment profile: ${insertErr.message}` },
        { status: 500 },
      );
    }
    profile = inserted;
  }

  return NextResponse.json({
    ...providerRes.data,
    provider_employment_profiles: profile ? [profile] : [],
    provider_site_credentials: credsRes.data || [],
  });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sb = sbSchedulingServer();
  const body = await req.json();

  const result = validateAndSplitPatch(body);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  const { providerFields, profileFields } = result;

  // Employee-ID uniqueness — partial UNIQUE (organization_id, employee_id).
  // If the client is changing employee_id, check for a collision in the same
  // org before the update so we can return a friendly 409.
  if (typeof providerFields.employee_id === 'string' && providerFields.employee_id) {
    const { data: current } = await sb
      .from('providers')
      .select('organization_id, employee_id')
      .eq('id', id)
      .single();
    if (current && current.employee_id !== providerFields.employee_id) {
      const { data: collision } = await sb
        .from('providers')
        .select('id')
        .eq('organization_id', current.organization_id)
        .eq('employee_id', providerFields.employee_id)
        .neq('id', id)
        .maybeSingle();
      if (collision) {
        return NextResponse.json(
          { error: `Employee ID "${providerFields.employee_id}" is already in use` },
          { status: 409 },
        );
      }
    }
  }

  // If names changed, refresh the derived short_display_name + initials so
  // the list view stays in sync. Only overwrite when the caller didn't
  // explicitly pass its own values.
  if ((providerFields.first_name || providerFields.last_name) &&
      !providerFields.short_display_name && !providerFields.initials) {
    const { data: current } = await sb
      .from('providers')
      .select('first_name, last_name')
      .eq('id', id)
      .single();
    if (current) {
      const first = String(providerFields.first_name ?? current.first_name).trim();
      const last = String(providerFields.last_name ?? current.last_name).trim();
      if (first && last) {
        providerFields.short_display_name = `${first.charAt(0)}.${last}`;
        providerFields.initials = `${first.charAt(0)}${last.charAt(0)}`.toUpperCase();
      }
    }
  }

  // Validate home_site_id belongs to the same org as the provider.
  if (profileFields.home_site_id) {
    const [{ data: prov }, { data: site }] = await Promise.all([
      sb.from('providers').select('organization_id').eq('id', id).single(),
      sb.from('sites').select('organization_id').eq('id', profileFields.home_site_id).maybeSingle(),
    ]);
    if (!site || !prov || site.organization_id !== prov.organization_id) {
      return NextResponse.json(
        { error: 'home_site_id does not belong to this provider\u2019s organization' },
        { status: 400 },
      );
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
