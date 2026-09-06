import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import {
  HOLIDAY_CALL_SOURCE,
  HOLIDAY_CALL_TYPE,
  holidayBlockDates,
  isHolidayCallCode,
} from '@/lib/holidayCall';
import { BLOCKING_AVAIL, isDismissedAvailability } from '@/lib/rulesEngine/shared';
import { AVAILABILITY_TYPE_LABELS, isValidDate } from '@/lib/validation/providers';

// The Holiday Call card (schedules page) reads and writes through here.
// Holiday call rows live in provider_availability — see src/lib/holidayCall.ts
// for why the decision hangs off the provider rather than a schedule version.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const NO_STORE = { 'Cache-Control': 'no-store, no-cache, must-revalidate' };

// site_id is interpolated into PostgREST `.or()` filter strings below, where a
// comma or paren would break out of the expression — so it is only ever used
// after matching a UUID exactly (same hardening the providers route applies to
// its search term).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function siteFilter(siteId: unknown): string | null {
  return typeof siteId === 'string' && UUID_RE.test(siteId) ? siteId : null;
}

interface HolidayRow {
  id: string;
  holiday_name: string;
  holiday_date: string;
  holiday_type: string;
  is_major_holiday: boolean;
}

// GET /api/scheduling/holiday-call?org_id=…&site_id=…&year=2026
//
// Returns the org's federal holidays for the year, each expanded to the days
// it covers, together with the holiday-call decisions already recorded for
// the site and any time-off conflict on those days.
export async function GET(req: NextRequest) {
  const sb = sbSchedulingServer();
  const { searchParams } = new URL(req.url);
  const orgId = searchParams.get('org_id');
  const rawSiteId = searchParams.get('site_id');
  const yearParam = searchParams.get('year');

  if (!orgId) return NextResponse.json({ error: 'org_id is required' }, { status: 400 });
  if (rawSiteId && !siteFilter(rawSiteId)) {
    return NextResponse.json({ error: 'site_id must be a UUID' }, { status: 400 });
  }
  const siteId = siteFilter(rawSiteId);
  const year = yearParam ? Number(yearParam) : new Date().getFullYear();
  if (!Number.isInteger(year) || year < 1970 || year > 2999) {
    return NextResponse.json({ error: 'year must be a 4-digit calendar year' }, { status: 400 });
  }

  const { data: holidayRows, error: holErr } = await sb
    .from('holiday_calendars')
    .select('id, holiday_name, holiday_date, holiday_type, is_major_holiday')
    .eq('organization_id', orgId)
    .gte('holiday_date', `${year}-01-01`)
    .lte('holiday_date', `${year}-12-31`)
    .order('holiday_date');
  if (holErr) return NextResponse.json({ error: holErr.message }, { status: 500 });

  // A holiday's block can spill past Dec 31 (New Year's Eve weekends), so the
  // availability window is the union of the expanded days, not the year.
  const holidays = ((holidayRows ?? []) as HolidayRow[]).map(h => ({
    ...h,
    dates: holidayBlockDates(h.holiday_date, h.holiday_name),
  }));
  const allDates = [...new Set(holidays.flatMap(h => h.dates))].sort();

  if (allDates.length === 0) {
    return NextResponse.json({ year, holidays, entries: [], conflicts: [] }, { headers: NO_STORE });
  }
  const from = allDates[0];
  const to = allDates[allDates.length - 1];

  // Recorded decisions. Scoped to the site so two sites can each staff the
  // same holiday; legacy/site-less rows (site_id null) are included so nothing
  // recorded before a site was chosen becomes invisible.
  let entryQuery = sb
    .from('provider_availability')
    .select('id, provider_id, site_id, start_date, reason_code, notes, approval_status, source, providers(first_name, last_name, short_display_name)')
    .eq('availability_type', HOLIDAY_CALL_TYPE)
    .gte('start_date', from)
    .lte('start_date', to)
    .order('start_date');
  if (siteId) entryQuery = entryQuery.or(`site_id.eq.${siteId},site_id.is.null`);

  const { data: entryRows, error: entryErr } = await entryQuery;
  if (entryErr) return NextResponse.json({ error: entryErr.message }, { status: 500 });

  const dateSet = new Set(allDates);
  const entries = (entryRows ?? [])
    .filter((r) => dateSet.has(r.start_date as string))
    .map((r) => {
      const p = embedOne(r.providers) as
        { first_name?: string; last_name?: string; short_display_name?: string } | null;
      return {
        id: r.id as string,
        provider_id: r.provider_id as string,
        provider_name: p?.short_display_name
          || [p?.first_name, p?.last_name].filter(Boolean).join(' ')
          || '—',
        date: r.start_date as string,
        code: (r.reason_code as string) ?? '',
        holiday_name: (r.notes as string) ?? null,
        site_id: (r.site_id as string) ?? null,
      };
    });

  // Time-off conflicts: a provider recorded for holiday call who also has
  // blocking leave on that day. patch44 deliberately does NOT let holiday call
  // override the leave (unlike pto_sellback) — the chief resolves it — so the
  // card has to be able to show it.
  const providerIds = [...new Set(entries.map(e => e.provider_id))];
  const conflicts: Array<{ provider_id: string; date: string; availability_type: string; label: string }> = [];
  if (providerIds.length > 0) {
    const { data: leaveRows, error: leaveErr } = await sb
      .from('provider_availability')
      .select('provider_id, availability_type, start_date, end_date, approval_status')
      .in('provider_id', providerIds)
      .lte('start_date', to)
      .gte('end_date', from);
    if (leaveErr) return NextResponse.json({ error: leaveErr.message }, { status: 500 });

    const seen = new Set<string>();
    for (const e of entries) {
      for (const l of leaveRows ?? []) {
        if (l.provider_id !== e.provider_id) continue;
        if (!BLOCKING_AVAIL.has(l.availability_type as string)) continue;
        if (isDismissedAvailability(l as { approval_status: string })) continue;
        if ((l.start_date as string) > e.date || (l.end_date as string) < e.date) continue;
        const key = `${e.provider_id}|${e.date}|${l.availability_type}`;
        if (seen.has(key)) continue;
        seen.add(key);
        conflicts.push({
          provider_id: e.provider_id,
          date: e.date,
          availability_type: l.availability_type as string,
          label: AVAILABILITY_TYPE_LABELS[
            l.availability_type as keyof typeof AVAILABILITY_TYPE_LABELS
          ] ?? (l.availability_type as string),
        });
      }
    }
    conflicts.sort((a, b) => a.date.localeCompare(b.date));
  }

  return NextResponse.json({ year, holidays, entries, conflicts }, { headers: NO_STORE });
}

// POST /api/scheduling/holiday-call
//   { site_id?, provider_id | null, date, code, holiday_name? }
//
// Sets the provider holding `code` on `date` — the card's cells are
// single-valued, so this REPLACES whoever held it. provider_id null clears
// the cell.
export async function POST(req: NextRequest) {
  const sb = sbSchedulingServer();
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const { provider_id: providerId, date, code, holiday_name: holidayName, site_id: rawSiteId } = body;

  if (rawSiteId != null && rawSiteId !== '' && !siteFilter(rawSiteId)) {
    return NextResponse.json({ error: 'site_id must be a UUID' }, { status: 400 });
  }
  const siteId = siteFilter(rawSiteId);
  if (!isValidDate(date)) {
    return NextResponse.json({ error: 'date must be YYYY-MM-DD' }, { status: 400 });
  }
  if (!isHolidayCallCode(code)) {
    return NextResponse.json({ error: 'code must be one of: C1, C2, C3, PC' }, { status: 400 });
  }
  if (providerId != null && typeof providerId !== 'string') {
    return NextResponse.json({ error: 'provider_id must be a string or null' }, { status: 400 });
  }

  // Clear the cell first — the card is a single-valued grid, so setting a cell
  // always replaces its previous holder rather than stacking rows.
  let clear = sb
    .from('provider_availability')
    .delete()
    .eq('availability_type', HOLIDAY_CALL_TYPE)
    .eq('start_date', date)
    .eq('reason_code', code);
  clear = siteId ? clear.or(`site_id.eq.${siteId},site_id.is.null`) : clear.is('site_id', null);
  const { error: clearErr } = await clear;
  if (clearErr) return NextResponse.json({ error: clearErr.message }, { status: 500 });

  if (!providerId) return NextResponse.json({ cleared: true }, { headers: NO_STORE });

  // One call code per provider per day: a second code could never materialize
  // into a slot (planHolidayCallSeeds skips it), so refuse to record it.
  let dupQuery = sb
    .from('provider_availability')
    .select('id, reason_code')
    .eq('availability_type', HOLIDAY_CALL_TYPE)
    .eq('provider_id', providerId)
    .eq('start_date', date);
  if (siteId) dupQuery = dupQuery.or(`site_id.eq.${siteId},site_id.is.null`);
  const { data: dup, error: dupErr } = await dupQuery;
  if (dupErr) return NextResponse.json({ error: dupErr.message }, { status: 500 });
  if ((dup ?? []).length > 0) {
    return NextResponse.json(
      { error: `Already holds ${dup![0].reason_code} on ${date} — a provider can only take one call code per day.` },
      { status: 409 },
    );
  }

  const { data, error } = await sb
    .from('provider_availability')
    .insert({
      provider_id: providerId,
      site_id: siteId || null,
      availability_type: HOLIDAY_CALL_TYPE,
      start_date: date,
      end_date: date,
      all_day: true,
      reason_code: code,
      notes: typeof holidayName === 'string' && holidayName ? holidayName : null,
      source: HOLIDAY_CALL_SOURCE,
      approval_status: 'approved',
    })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { headers: NO_STORE });
}

// PostgREST returns an embedded to-one relation as an object, but a degraded
// or array-shaped read can hand back a list — same defensive unwrap the engine
// uses for embedded rows.
function embedOne(v: unknown): Record<string, unknown> | null {
  if (Array.isArray(v)) return (v[0] as Record<string, unknown>) ?? null;
  return (v as Record<string, unknown>) ?? null;
}
