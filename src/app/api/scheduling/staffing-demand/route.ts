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

  const md = readCount(body.md_needed);
  const crna = readCount(body.crna_needed);
  if (md === 'invalid' || crna === 'invalid') {
    return NextResponse.json(
      { error: 'Counts must be whole numbers of 0 or more, or empty for "not stated".' },
      { status: 400 });
  }

  const sb = sbSchedulingServer();

  // Both cleared: the cell is being emptied, so the row goes rather than
  // lingering as a stated-nothing that would mask a calculated figure.
  if (md === null && crna === null) {
    const { error } = await sb.from('staffing_demand').delete()
      .eq('site_id', siteId).eq('demand_date', date).eq('source', 'manual');
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, cleared: true });
  }

  const org = await firstOrg(sb);
  if (!org.ok) return NextResponse.json({ error: org.error }, { status: 500 });
  const orgId = org.rows[0]?.id;
  if (!orgId) return NextResponse.json({ error: 'No organization record.' }, { status: 500 });

  // source is part of the unique key, so this touches the MANUAL row only and
  // leaves any calculated one intact — which is what lets an override be
  // compared against what the calculator said instead of destroying it.
  const { data, error } = await sb.from('staffing_demand')
    .upsert({
      organization_id: orgId, site_id: siteId, demand_date: date,
      md_needed: md, crna_needed: crna, source: 'manual',
    }, { onConflict: 'site_id,demand_date,source' })
    .select('id, site_id, demand_date, md_needed, crna_needed, source')
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, row: data });
}
