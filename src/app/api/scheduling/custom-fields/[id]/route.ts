import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { validateDefinition } from '@/lib/validation/customFields';

// Never prerender — this route hits Supabase per request.
export const dynamic = 'force-dynamic';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sb = sbSchedulingServer();
  const body = await req.json();

  const v = validateDefinition(body, { partial: true });
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });

  // Don't let callers reparent to a different org.
  delete v.row.organization_id;
  if (Object.keys(v.row).length === 0) {
    return NextResponse.json({ error: 'no fields to update' }, { status: 400 });
  }

  // If renaming, collision-check within the org.
  if (v.row.field_name) {
    const { data: current } = await sb
      .from('provider_custom_field_definitions')
      .select('organization_id, field_name')
      .eq('id', id)
      .single();
    if (current && current.field_name !== v.row.field_name) {
      const { data: collision } = await sb
        .from('provider_custom_field_definitions')
        .select('id')
        .eq('organization_id', current.organization_id)
        .eq('field_name', v.row.field_name)
        .neq('id', id)
        .maybeSingle();
      if (collision) {
        return NextResponse.json(
          { error: `A custom field named "${v.row.field_name}" already exists` },
          { status: 409 },
        );
      }
    }
  }

  const { data, error } = await sb
    .from('provider_custom_field_definitions')
    .update(v.row)
    .eq('id', id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sb = sbSchedulingServer();
  // Hard delete — cascades to provider_custom_field_values.
  const { error } = await sb
    .from('provider_custom_field_definitions')
    .delete()
    .eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
