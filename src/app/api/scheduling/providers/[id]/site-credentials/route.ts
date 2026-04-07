import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: providerId } = await params;
  const sb = sbSchedulingServer();
  const body = await req.json();

  const row: Record<string, unknown> = {
    provider_id: providerId,
    site_id: body.site_id,
    is_active: body.is_active ?? true,
    credentialed: body.credentialed ?? true,
    can_take_call: body.can_take_call ?? true,
    can_take_weekend_call: body.can_take_weekend_call ?? true,
    can_take_holiday_call: body.can_take_holiday_call ?? true,
    can_take_backup_call: body.can_take_backup_call ?? true,
    allowed_shift_types: body.allowed_shift_types ?? [],
    excluded_shift_types: body.excluded_shift_types ?? [],
    skill_tags: body.skill_tags ?? [],
  };
  if (body.effective_start_date) row.effective_start_date = body.effective_start_date;
  if (body.effective_end_date) row.effective_end_date = body.effective_end_date;
  if (body.notes) row.notes = body.notes;

  const { data, error } = await sb
    .from('provider_site_credentials')
    .upsert(row, { onConflict: 'provider_id,site_id' })
    .select()
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
