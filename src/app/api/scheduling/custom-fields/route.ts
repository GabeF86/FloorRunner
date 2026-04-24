import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { validateDefinition } from '@/lib/validation/customFields';

// GET /api/scheduling/custom-fields?org_id=...&include_inactive=true
// Never prerender — this route hits Supabase per request.
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const sb = sbSchedulingServer();
  const { searchParams } = new URL(req.url);
  const orgId = searchParams.get('org_id');
  if (!orgId) return NextResponse.json({ error: 'org_id is required' }, { status: 400 });

  let query = sb
    .from('provider_custom_field_definitions')
    .select('*')
    .eq('organization_id', orgId)
    .order('display_order')
    .order('created_at');

  if (searchParams.get('include_inactive') !== 'true') {
    query = query.eq('is_active', true);
  }

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  const sb = sbSchedulingServer();
  const body = await req.json();

  const v = validateDefinition(body);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });

  // Enforce uniqueness of field_name within an org — the DB doesn't have a
  // UNIQUE constraint on (organization_id, field_name), so we check here
  // to keep the data model sane.
  const { data: existing } = await sb
    .from('provider_custom_field_definitions')
    .select('id')
    .eq('organization_id', v.row.organization_id)
    .eq('field_name', v.row.field_name)
    .maybeSingle();
  if (existing) {
    return NextResponse.json(
      { error: `A custom field named "${v.row.field_name}" already exists` },
      { status: 409 },
    );
  }

  const { data, error } = await sb
    .from('provider_custom_field_definitions')
    .insert(v.row)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
