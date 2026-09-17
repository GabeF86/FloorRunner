// The standing weekend call complement per site — how many MDs and CRNAs must
// be on call every Saturday and Sunday, whatever the OR is doing.
//
// GET   every site's configured complement, plus a SUGGESTION derived from the
//       call positions actually standing on weekends in the published
//       schedule, so a scheduler confirms a number rather than inventing one.
// PUT   { site_id, md, crna }  — stores it on sites.weekend_staffing.
//
// Admin-only by the deny-by-default rule in routeAccess.

import { NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { parseWeekendCall } from '@/lib/staffingDemand';
import { siteOpenDays } from '@/lib/operationsBoard';
import { readAllRows } from '@/lib/pagedRead';
import { embedArray } from '@/lib/embed';
import { filterPublishedVersions } from '@/lib/rulesEngine/committedAssignments';

export const dynamic = 'force-dynamic';

function readCount(v: unknown): number | null | 'invalid' {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 99) return 'invalid';
  return v;
}

export async function GET() {
  const sb = sbSchedulingServer();

  const { data: allSites, error } = await sb.from('sites')
    .select('id, name, short_name, weekend_staffing, operational_days')
    .eq('is_active', true).order('display_order').order('name');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Only sites that RUN at a weekend get a complement. The surgery centres —
  // Navy Yard, Orthopedic, Rothman, Riddle Surgery Center — are Monday to
  // Friday and take no weekend call, so offering them a box invites somebody
  // to fill in a requirement that does not exist.
  const sites = (allSites ?? []).filter((s: Record<string, unknown>) => {
    const open = siteOpenDays(s.operational_days);
    return open[0] || open[6];
  });

  // The SUGGESTION: distinct base call codes standing on a weekend day in the
  // published schedule. Split segments fold into their parent, so C1N12 and
  // C1D12 count once as C1 — they are pieces of a call, not calls.
  //
  // A suggestion, deliberately, not a default. Riddle shows C1 and C2 across
  // the window but its C2 ran on exactly one Saturday, so deriving 2 would
  // overstate it. A human confirms the number; the machine only offers one.
  const slots = await readAllRows<Record<string, unknown>>((f, t) => filterPublishedVersions(
    sb.from('schedule_slots')
      .select('site_id, slot_date, shift_types!inner(code, category, provider_group,'
        + ' parent_call_code), schedule_versions!inner(version_status)', { count: 'exact' })
      .eq('shift_types.category', 'call')
      .order('slot_date').order('id').range(f, t),
    'schedule_versions',
  ), 'weekend call slots');

  const codesBySite = new Map<string, { md: Set<string>; crna: Set<string> }>();
  for (const row of slots.rows) {
    const date = String(row.slot_date);
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) continue;
    const st = embedArray(row.shift_types as never)[0] as Record<string, unknown> | undefined;
    if (!st) continue;
    const code = String(st.parent_call_code || st.code);
    const acc = codesBySite.get(String(row.site_id)) ?? { md: new Set(), crna: new Set() };
    (st.provider_group === 'crna' ? acc.crna : acc.md).add(code);
    codesBySite.set(String(row.site_id), acc);
  }

  return NextResponse.json({
    sites: (sites ?? []).map((s: Record<string, unknown>) => {
      const derived = codesBySite.get(String(s.id));
      return {
        id: s.id, name: s.name, short_name: s.short_name,
        configured: parseWeekendCall(s.weekend_staffing),
        suggestion: derived
          ? {
            md: derived.md.size || null,
            crna: derived.crna.size || null,
            codes: [...derived.md, ...derived.crna].sort(),
          }
          : null,
      };
    }),
    // Non-fatal: the suggestion is a convenience, and losing it must not stop
    // somebody entering the number themselves.
    warning: slots.error,
  });
}

export async function PUT(req: Request) {
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'Body must be JSON.' }, { status: 400 });
  }
  const siteId = typeof body.site_id === 'string' ? body.site_id : '';
  if (!siteId) return NextResponse.json({ error: 'site_id is required.' }, { status: 400 });

  // Partial, for the same reason the day grid's route is: two boxes saved a
  // few milliseconds apart must not overwrite each other.
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
  if (!has('md') && !has('crna')) {
    return NextResponse.json({ error: 'Provide md, crna, or both.' }, { status: 400 });
  }
  const md = has('md') ? readCount(body.md) : undefined;
  const crna = has('crna') ? readCount(body.crna) : undefined;
  if (md === 'invalid' || crna === 'invalid') {
    return NextResponse.json(
      { error: 'Counts must be whole numbers of 0 or more, or empty for "not configured".' },
      { status: 400 });
  }

  const sbRead = sbSchedulingServer();
  const { data: current, error: readError } = await sbRead.from('sites')
    .select('weekend_staffing').eq('id', siteId).single();
  if (readError) return NextResponse.json({ error: readError.message }, { status: 500 });
  const existing = parseWeekendCall(current?.weekend_staffing) ?? { md: null, crna: null };

  const nextMd = md === undefined ? existing.md : md;
  const nextCrna = crna === undefined ? existing.crna : crna;

  // Both cleared means the site has no standing complement, which is a real
  // state (a centre that runs no weekend call) — stored as null, so its
  // weekends fall back to N/A rather than to a zero that reads as covered.
  const value = nextMd === null && nextCrna === null ? null : { md: nextMd, crna: nextCrna };

  const { data, error } = await sbRead.from('sites')
    .update({ weekend_staffing: value }).eq('id', siteId)
    .select('id, short_name, weekend_staffing').single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, site: data });
}
