// Staffing demand — how many MDs and CRNAs a site needs on a day.
//
// GET  ?from=&to=   the rows in a window
// PUT  { site_id, demand_date, md_needed, crna_needed }
//                   upsert ONE manual cell
//
// Admin-only by the deny-by-default rule in routeAccess: this path is in no
// allow-list. A physician has no business setting their hospital's demand.

import { NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { firstOrg } from '@/lib/queries/roster';

export const dynamic = 'force-dynamic';

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** A count as it may be written: a number, or null for "not stated". Anything
 *  else is refused — storing 0 for "3x" would report a site as needing nobody. */
function readCount(v: unknown): number | null | 'invalid' {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 999) return 'invalid';
  return v;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (!from || !to || !ISO.test(from) || !ISO.test(to)) {
    return NextResponse.json({ error: 'from and to must be YYYY-MM-DD.' }, { status: 400 });
  }
  const sb = sbSchedulingServer();
  const { data, error } = await sb.from('staffing_demand')
    .select('id, site_id, demand_date, md_needed, crna_needed, source, notes, updated_at')
    .gte('demand_date', from).lte('demand_date', to)
    .order('demand_date').order('site_id');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ rows: data ?? [] });
}

export async function PUT(req: Request) {
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'Body must be JSON.' }, { status: 400 });
  }

  const siteId = typeof body.site_id === 'string' ? body.site_id : '';
  const date = typeof body.demand_date === 'string' ? body.demand_date : '';
  if (!siteId || !ISO.test(date)) {
    return NextResponse.json({ error: 'site_id and a YYYY-MM-DD demand_date are required.' },
      { status: 400 });
  }

  // PARTIAL BY DESIGN. A field absent from the body is not touched.
  //
  // This is what stops one box wiping the other. Tabbing from MD to CRNA fires
  // both saves within a few milliseconds, and when the request carried BOTH
  // fields the second one sent a copy of MD read before the first had landed —
  // so a freshly typed 7 went back as null. It is not a hypothetical: it
  // erased a real entry on Paoli 18 Sep. Sending only what changed removes the
  // race rather than narrowing the window.
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
  if (!has('md_needed') && !has('crna_needed')) {
    return NextResponse.json(
      { error: 'Provide md_needed, crna_needed, or both.' }, { status: 400 });
  }

  const md = has('md_needed') ? readCount(body.md_needed) : undefined;
  const crna = has('crna_needed') ? readCount(body.crna_needed) : undefined;
  if (md === 'invalid' || crna === 'invalid') {
    return NextResponse.json(
      { error: 'Counts must be whole numbers of 0 or more, or empty for "not stated".' },
      { status: 400 });
  }

  const sb = sbSchedulingServer();
  const org = await firstOrg(sb);
  if (!org.ok) return NextResponse.json({ error: org.error }, { status: 500 });
  const orgId = org.rows[0]?.id;
  if (!orgId) return NextResponse.json({ error: 'No organization record.' }, { status: 500 });

  // Only the provided columns go into the payload, so PostgREST's
  // ON CONFLICT ... DO UPDATE touches only those — the other column keeps
  // whatever is already stored. source is in the unique key, so a calculated
  // row for the same day is never disturbed.
  const payload: Record<string, unknown> = {
    organization_id: orgId, site_id: siteId, demand_date: date, source: 'manual',
  };
  if (md !== undefined) payload.md_needed = md;
  if (crna !== undefined) payload.crna_needed = crna;

  const { data, error } = await sb.from('staffing_demand')
    .upsert(payload, { onConflict: 'site_id,demand_date,source' })
    .select('id, site_id, demand_date, md_needed, crna_needed, source')
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Both counts now cleared: the row states nothing, so it goes rather than
  // lingering as a stated-nothing that would mask a calculated figure.
  if (data.md_needed === null && data.crna_needed === null) {
    const { error: delError } = await sb.from('staffing_demand').delete().eq('id', data.id);
    if (delError) return NextResponse.json({ error: delError.message }, { status: 500 });
    return NextResponse.json({ ok: true, cleared: true });
  }

  return NextResponse.json({ ok: true, row: data });
}
