import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { validateDefinition } from '@/lib/validation/customFields';
import { listCustomFields } from '@/lib/queries/config';

// GET /api/scheduling/custom-fields?org_id=...&include_inactive=true
// Never prerender — this route hits Supabase per request.
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  // Query logic lives in lib/queries/config.ts so the /settings server
  // component that renders this same list cannot drift from it.
  const { searchParams } = new URL(req.url);
  const result = await listCustomFields(sbSchedulingServer(), {
    orgId: searchParams.get('org_id'),
    includeInactive: searchParams.get('include_inactive') === 'true',
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json(result.rows);
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
