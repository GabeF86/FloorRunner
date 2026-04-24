import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';

export const dynamic = 'force-dynamic';

// GET /api/scheduling/debug/provider-availability?q=SH
//
// Diagnostic-only. Given a search fragment (matches initials, short display
// name, or last name), returns everything the grid endpoint uses to decide
// whether a provider's PTO makes it into the virtual PTO row:
//
//   - provider row (id, status, provider_type, ...)
//   - all employment profile fields
//   - all availability entries (verbatim from the DB)
//
// The virtual PTO row drops an entry if any of:
//   - providers.status !== 'active'
//   - providers.provider_type doesn't match the schedule's provider_group
//   - availability.approval_status !== 'approved'
//   - availability.availability_type not in {pto, fmla, parental_leave, military_leave}
//   - schedule's date range doesn't overlap [start_date, end_date]
//
// So the shape we return here maps directly to those checks.
export async function GET(req: NextRequest) {
  const sb = sbSchedulingServer();
  const url = new URL(req.url);
  const q = url.searchParams.get('q');
  const providerId = url.searchParams.get('provider_id');

  // Two modes:
  //   ?provider_id=<uuid>  — direct lookup of one provider by id
  //   ?q=<fragment>        — search by initials / display name / last / first
  let providers: Array<{ id: string }> | null = null;
  let error: { message: string } | null = null;

  if (providerId) {
    const r = await sb
      .from('providers')
      .select('id, organization_id, first_name, last_name, initials, short_display_name, provider_type, status, employee_id')
      .eq('id', providerId);
    providers = r.data as Array<{ id: string }> | null;
    error = r.error;
  } else if (q && q.trim().length > 0) {
    const search = q.trim();
    const r = await sb
      .from('providers')
      .select('id, organization_id, first_name, last_name, initials, short_display_name, provider_type, status, employee_id')
      .or(
        [
          `initials.ilike.%${search}%`,
          `short_display_name.ilike.%${search}%`,
          `last_name.ilike.%${search}%`,
          `first_name.ilike.%${search}%`,
        ].join(','),
      );
    providers = r.data as Array<{ id: string }> | null;
    error = r.error;
  } else {
    return NextResponse.json({ error: 'provider_id or q parameter required' }, { status: 400 });
  }

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!providers || providers.length === 0) {
    return NextResponse.json({ query: q || providerId, matches: [], note: 'no providers matched' });
  }

  const providerIds = providers.map((p: { id: string }) => p.id);

  const [{ data: profiles }, { data: availability }] = await Promise.all([
    sb
      .from('provider_employment_profiles')
      .select('provider_id, home_site_id, call_taker, partial_call_taker, is_day_doc, employment_status, fte_value')
      .in('provider_id', providerIds),
    sb
      .from('provider_availability')
      // SELECT * avoids repeating the column names and guards against
      // future schema drift. A previous version listed "reason" here —
      // the column is actually "reason_code" and the bad SELECT returned
      // an error we weren't checking, so this endpoint reported empty
      // availability even when rows existed.
      .select('*')
      .in('provider_id', providerIds)
      .order('start_date', { ascending: true }),
  ]);

  const profileByPid = new Map<string, unknown>();
  for (const p of (profiles || []) as Array<{ provider_id: string }>) {
    profileByPid.set(p.provider_id, p);
  }
  const availByPid = new Map<string, unknown[]>();
  for (const a of (availability || []) as Array<{ provider_id: string }>) {
    const list = availByPid.get(a.provider_id) || [];
    list.push(a);
    availByPid.set(a.provider_id, list);
  }

  const matches = providers.map((p: { id: string }) => ({
    provider: p,
    profile: profileByPid.get(p.id) ?? null,
    availability: availByPid.get(p.id) ?? [],
  }));

  return NextResponse.json({ query: q || providerId, matches });
}
