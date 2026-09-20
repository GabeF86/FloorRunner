// How many MDs and CRNAs the published schedule puts at a site on a date.
//
// GET ?site=<uuid|name>&date=YYYY-MM-DD
//   → { day, overnightCall, lateOther, ...codes, scheduled, siteId, siteName }
//
// Feeds the staffing calculator's "Available staff" panel, which until now
// opened on a hardcoded 12 and 14.
//
// PUBLISHED ONLY (clinical invariant 3), through filterPublishedVersions — the
// single home of that predicate. A draft is a hypothetical and must never be
// counted as staff somebody can build a grid from.

import { NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { readAllRows } from '@/lib/pagedRead';
import { embedArray } from '@/lib/embed';
import { filterPublishedVersions } from '@/lib/rulesEngine/committedAssignments';
import {
  scheduledAvailability, type AvailabilitySlot,
} from '@/lib/staffingAvailability';
import type { OpsProviderRow } from '@/lib/operationsBoard';

export const dynamic = 'force-dynamic';

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SLOT_SELECT =
  'site_id, slot_date,'
  + ' schedule_versions!inner(version_status),'
  + ' shift_types(code, category, start_time),'
  + ' assignments(provider_id)';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const site = url.searchParams.get('site');
  const date = url.searchParams.get('date');
  if (!site || !date || !ISO.test(date)) {
    return NextResponse.json(
      { error: 'site and date (YYYY-MM-DD) are required.' }, { status: 400 },
    );
  }

  const sb = sbSchedulingServer();

  // The calculator identifies a facility by its DISPLAY NAME ('Paoli
  // Hospital'), which is what its modules were written against. Accept either
  // that or an id, and resolve here — a name that matches nothing must be an
  // error, never an empty count. "No such site" and "nobody scheduled" look
  // identical downstream and only one of them is a staffing fact.
  const siteQ = sb.from('sites').select('id, name, short_name');
  const { data: siteRows, error: siteErr } = UUID.test(site)
    ? await siteQ.eq('id', site).limit(1)
    : await siteQ.or(`name.eq.${site},short_name.eq.${site}`).limit(1);
  if (siteErr) return NextResponse.json({ error: siteErr.message }, { status: 500 });
  const siteRow = (siteRows ?? [])[0];
  if (!siteRow) {
    return NextResponse.json({ error: `No site matches "${site}".` }, { status: 404 });
  }

  const slotRes = await readAllRows<Record<string, unknown>>((f, t) => filterPublishedVersions(
    sb.from('schedule_slots')
      .select(SLOT_SELECT, { count: 'exact' })
      .eq('site_id', siteRow.id).eq('slot_date', date)
      .order('id').range(f, t),
    'schedule_versions',
  ), 'schedule slots');
  // A truncated or failed slot read would not look broken, it would look like
  // an EMPTY HOSPITAL — and the calculator would size a grid for nobody.
  if (slotRes.error) {
    return NextResponse.json({ error: slotRes.error }, { status: 500 });
  }

  const slots: AvailabilitySlot[] = slotRes.rows.map(row => ({
    site_id: String(row.site_id),
    slot_date: String(row.slot_date),
    shift: embedArray(row.shift_types as never)[0] ?? null,
    providerIds: embedArray(row.assignments as never)
      .map(a => (a as { provider_id?: string | null })?.provider_id)
      .filter((p): p is string => !!p),
  }));

  // Group comes from the PROVIDER, not the shift type — read only the ids that
  // actually turned up, rather than the whole roster.
  const ids = [...new Set(slots.flatMap(s => s.providerIds))];
  let providers: OpsProviderRow[] = [];
  if (ids.length > 0) {
    const provRes = await readAllRows<OpsProviderRow>(
      (f, t) => sb.from('providers')
        .select('id, provider_type, first_name, last_name, short_display_name',
          { count: 'exact' })
        .in('id', ids).order('id').range(f, t), 'providers');
    if (provRes.error) {
      return NextResponse.json({ error: provRes.error }, { status: 500 });
    }
    providers = provRes.rows;
  }

  const availability = scheduledAvailability({
    siteId: siteRow.id, date, slots, providers,
  });

  return NextResponse.json({
    ...availability,
    siteName: siteRow.name,
    siteShortName: siteRow.short_name,
  });
}
