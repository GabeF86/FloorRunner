import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { isValidDate } from '@/lib/validation/providers';

// Never prerender — this route hits Supabase per request.
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: providerId } = await params;
  const sb = sbSchedulingServer();
  const body = await req.json();

  if (!body.site_id || typeof body.site_id !== 'string') {
    return NextResponse.json({ error: 'site_id is required' }, { status: 400 });
  }

  // Verify the provider exists and the site belongs to the same org. Without
  // this check a client could cross orgs by submitting an arbitrary site_id.
  const [{ data: provider }, { data: site }] = await Promise.all([
    sb.from('providers').select('organization_id').eq('id', providerId).maybeSingle(),
    sb.from('sites').select('organization_id').eq('id', body.site_id).maybeSingle(),
  ]);
  if (!provider) return NextResponse.json({ error: 'Provider not found' }, { status: 404 });
  if (!site) return NextResponse.json({ error: 'Site not found' }, { status: 404 });
  if (site.organization_id !== provider.organization_id) {
    return NextResponse.json(
      { error: 'Site does not belong to this provider\u2019s organization' },
      { status: 400 },
    );
  }

  // Validate date range when provided.
  if (body.effective_start_date && !isValidDate(body.effective_start_date)) {
    return NextResponse.json({ error: 'effective_start_date must be YYYY-MM-DD' }, { status: 400 });
  }
  if (body.effective_end_date && !isValidDate(body.effective_end_date)) {
    return NextResponse.json({ error: 'effective_end_date must be YYYY-MM-DD' }, { status: 400 });
  }
  if (body.effective_start_date && body.effective_end_date &&
      body.effective_start_date > body.effective_end_date) {
    return NextResponse.json(
      { error: 'effective_end_date must be on or after effective_start_date' },
      { status: 400 },
    );
  }

  const toStringArray = (v: unknown): string[] => {
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === 'string');
  };

  const row: Record<string, unknown> = {
    provider_id: providerId,
    site_id: body.site_id,
    is_active: body.is_active ?? true,
    credentialed: body.credentialed ?? true,
    can_take_call: body.can_take_call ?? true,
    can_take_weekend_call: body.can_take_weekend_call ?? true,
    can_take_holiday_call: body.can_take_holiday_call ?? true,
    can_take_backup_call: body.can_take_backup_call ?? true,
    allowed_shift_types: toStringArray(body.allowed_shift_types),
    excluded_shift_types: toStringArray(body.excluded_shift_types),
    skill_tags: toStringArray(body.skill_tags),
  };
  // Include date fields only when present so we don't overwrite existing
  // values with null on a partial toggle update.
  if ('effective_start_date' in body) row.effective_start_date = body.effective_start_date || null;
  if ('effective_end_date' in body) row.effective_end_date = body.effective_end_date || null;
  if ('notes' in body) row.notes = body.notes || null;

  const { data, error } = await sb
    .from('provider_site_credentials')
    .upsert(row, { onConflict: 'provider_id,site_id' })
    .select('*, sites:site_id(id, name, short_name)')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: providerId } = await params;
  const sb = sbSchedulingServer();
  const { data, error } = await sb
    .from('provider_site_credentials')
    .select('*, sites:site_id(id, name, short_name)')
    .eq('provider_id', providerId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

// DELETE /api/scheduling/providers/:id/site-credentials?site_id=...
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: providerId } = await params;
  const sb = sbSchedulingServer();
  const siteId = new URL(req.url).searchParams.get('site_id');
  if (!siteId) return NextResponse.json({ error: 'site_id is required' }, { status: 400 });

  const { error } = await sb
    .from('provider_site_credentials')
    .delete()
    .eq('provider_id', providerId)
    .eq('site_id', siteId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
