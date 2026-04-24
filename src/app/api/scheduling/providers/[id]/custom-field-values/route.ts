import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { coerceValue } from '@/lib/validation/customFields';

// Never prerender — this route hits Supabase per request.
export const dynamic = 'force-dynamic';

// GET returns a map of { field_definition_id: value } plus the active
// definitions for convenience, so the UI only needs one round trip to render.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: providerId } = await params;
  const sb = sbSchedulingServer();

  const { data: provider } = await sb
    .from('providers')
    .select('organization_id')
    .eq('id', providerId)
    .maybeSingle();
  if (!provider) return NextResponse.json({ error: 'Provider not found' }, { status: 404 });

  const [defsRes, valsRes] = await Promise.all([
    sb
      .from('provider_custom_field_definitions')
      .select('*')
      .eq('organization_id', provider.organization_id)
      .eq('is_active', true)
      .order('display_order')
      .order('created_at'),
    sb
      .from('provider_custom_field_values')
      .select('*')
      .eq('provider_id', providerId),
  ]);

  if (defsRes.error) return NextResponse.json({ error: defsRes.error.message }, { status: 500 });
  if (valsRes.error) return NextResponse.json({ error: valsRes.error.message }, { status: 500 });

  const valueByDef: Record<string, unknown> = {};
  for (const v of valsRes.data || []) {
    valueByDef[v.field_definition_id] = v.value;
  }

  return NextResponse.json({ definitions: defsRes.data || [], values: valueByDef });
}

// PUT replaces the full set of values for this provider. Body shape:
//   { values: { [field_definition_id]: value } }
// Values are validated against the matching definition's field_type.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: providerId } = await params;
  const sb = sbSchedulingServer();
  const body = await req.json();

  if (!body || typeof body.values !== 'object' || body.values === null) {
    return NextResponse.json({ error: 'values object is required' }, { status: 400 });
  }

  const { data: provider } = await sb
    .from('providers')
    .select('organization_id')
    .eq('id', providerId)
    .maybeSingle();
  if (!provider) return NextResponse.json({ error: 'Provider not found' }, { status: 404 });

  const submittedIds = Object.keys(body.values);
  if (submittedIds.length === 0) {
    // Nothing to upsert; still return current state.
    return fetchAndReturn(sb, providerId, provider.organization_id);
  }

  // Fetch the definitions — both to validate ownership (same org) and to
  // coerce values by type.
  const { data: defs, error: defErr } = await sb
    .from('provider_custom_field_definitions')
    .select('*')
    .in('id', submittedIds);
  if (defErr) return NextResponse.json({ error: defErr.message }, { status: 500 });

  type Def = { id: string; field_type: string; options: string[]; organization_id: string; required: boolean; display_label: string };
  const defById = new Map<string, Def>();
  for (const d of defs || []) defById.set(d.id, d as Def);

  const toUpsert: Array<{ provider_id: string; field_definition_id: string; value: unknown }> = [];
  const toDelete: string[] = [];

  for (const [defId, raw] of Object.entries(body.values)) {
    const def = defById.get(defId);
    if (!def || def.organization_id !== provider.organization_id) {
      return NextResponse.json(
        { error: `Unknown custom field: ${defId}` },
        { status: 400 },
      );
    }
    const coerced = coerceValue(def.field_type, raw, Array.isArray(def.options) ? def.options : []);
    if (!coerced.ok) {
      return NextResponse.json(
        { error: `Value for "${defId}" invalid: ${coerced.error}` },
        { status: 400 },
      );
    }
    // Required-field enforcement. The UI catches this, but anyone hitting
    // the API directly (scripts, future mobile client) would otherwise be
    // able to clear a required field. Rejecting an explicit null submission
    // is the right boundary — we don't touch fields that weren't submitted.
    if (coerced.value === null && def.required) {
      return NextResponse.json(
        { error: `"${def.display_label}" is required` },
        { status: 400 },
      );
    }
    if (coerced.value === null) {
      toDelete.push(defId);
    } else {
      toUpsert.push({ provider_id: providerId, field_definition_id: defId, value: coerced.value });
    }
  }

  if (toDelete.length) {
    const { error: delErr } = await sb
      .from('provider_custom_field_values')
      .delete()
      .eq('provider_id', providerId)
      .in('field_definition_id', toDelete);
    if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });
  }

  if (toUpsert.length) {
    const { error: upErr } = await sb
      .from('provider_custom_field_values')
      .upsert(toUpsert, { onConflict: 'provider_id,field_definition_id' });
    if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });
  }

  return fetchAndReturn(sb, providerId, provider.organization_id);
}

type SupabaseClient = ReturnType<typeof sbSchedulingServer>;

async function fetchAndReturn(sb: SupabaseClient, providerId: string, orgId: string) {
  const [defsRes, valsRes] = await Promise.all([
    sb
      .from('provider_custom_field_definitions')
      .select('*')
      .eq('organization_id', orgId)
      .eq('is_active', true)
      .order('display_order')
      .order('created_at'),
    sb
      .from('provider_custom_field_values')
      .select('*')
      .eq('provider_id', providerId),
  ]);
  if (defsRes.error) return NextResponse.json({ error: defsRes.error.message }, { status: 500 });
  if (valsRes.error) return NextResponse.json({ error: valsRes.error.message }, { status: 500 });
  const valueByDef: Record<string, unknown> = {};
  for (const v of valsRes.data || []) valueByDef[v.field_definition_id] = v.value;
  return NextResponse.json({ definitions: defsRes.data || [], values: valueByDef });
}
