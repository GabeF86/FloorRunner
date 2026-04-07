import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const sb = sbSchedulingServer();
  const { id } = await params;

  const { data, error } = await sb
    .from('schedules')
    .select('*, sites(name, short_name, timezone)')
    .eq('id', id)
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const sb = sbSchedulingServer();
  const { id } = await params;
  const body = await req.json();

  const { data, error } = await sb
    .from('schedules')
    .update(body)
    .eq('id', id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // When publishing, also update the latest version
  if (body.status === 'published') {
    const { data: version, error: verErr } = await sb
      .from('schedule_versions')
      .select('id')
      .eq('schedule_id', id)
      .order('version_number', { ascending: false })
      .limit(1)
      .single();
    if (verErr) return NextResponse.json({ error: verErr.message }, { status: 500 });

    const { error: updErr } = await sb
      .from('schedule_versions')
      .update({ version_status: 'published', published_at: new Date().toISOString() })
      .eq('id', version.id);
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
  }

  return NextResponse.json(data);
}

// DELETE /api/scheduling/schedules/:id
//   default behavior: hard delete (cascades remove versions, slots, assignments)
//   ?archive=true   : soft delete by setting status='archived'
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const sb = sbSchedulingServer();
  const { id } = await params;
  const archive = new URL(req.url).searchParams.get('archive') === 'true';

  if (archive) {
    const { data, error } = await sb
      .from('schedules')
      .update({ status: 'archived' })
      .eq('id', id)
      .select()
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data);
  }

  const { error } = await sb.from('schedules').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, deleted: true });
}
