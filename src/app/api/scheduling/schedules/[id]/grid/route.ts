import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { embedArray } from '@/lib/embed';
import { CallPatternDocSchema, type CallPatternDoc } from '@/lib/rulesEngine/callPattern';
import { fetchCommittedAssignments } from '@/lib/rulesEngine/committedAssignments';
import { addDays } from '@/lib/rulesEngine/shared';
import type { CandidateCredentialRow, CrossSiteBookingRow } from '@/lib/slotCandidates';
import {
  GRID_CREDENTIAL_COLUMNS,
  GRID_CROSS_SITE_COLUMNS,
  GRID_PROFILE_LADDER,
  GRID_SCHEDULE_COLUMNS,
  GRID_SLOT_COLUMNS,
  GRID_SLOT_COLUMNS_PRE35,
  GRID_SLOT_COLUMNS_PRE42,
  isMissingColumnErr,
  withValidationSummary,
} from './route.helpers';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const sb = sbSchedulingServer();
  const { id } = await params;

  // 1. Fetch schedule with site join. call_par_level powers per-site over-par
  // math; if it's missing for any reason the page falls back to 12 (matches
  // the engine's default). Explicit columns — see route.helpers.ts.
  const { data: schedule, error: schedErr } = await sb
    .from('schedules')
    .select(GRID_SCHEDULE_COLUMNS)
    .eq('id', id)
    .single();
  if (schedErr) return NextResponse.json({ error: schedErr.message }, { status: 500 });

  // 2. Fetch latest schedule version
  const { data: version, error: verErr } = await sb
    .from('schedule_versions')
    .select('id, version_number, version_status')
    .eq('schedule_id', id)
    .order('version_number', { ascending: false })
    .limit(1)
    .single();
  if (verErr) return NextResponse.json({ error: verErr.message }, { status: 500 });

  // 3. Fetch slots with shift_types and assignments->providers (explicit
  // columns — the old '*' select also dragged source_type/notes/etc. the page
  // never reads). Each assignment gets a server-computed validation_summary
  // ({hard, soft, warning}) alongside its full validation_flags (the page
  // still renders per-flag messages in tooltips and the cell detail panel).
  // The two select strings infer different supabase-js row types; the route
  // treats rows structurally (embedArray + validation summaries), so widen.
  //
  // NARROW-RETRY LADDER (see route.helpers.ts for the rung definitions):
  // GRID_SLOT_COLUMNS → PRE42 (drop patch42's highlight_color) → PRE35 (drop
  // the patch35 call-split columns too). Each rung only drops columns the DB
  // does not have, and a column that does not exist can hold no data, so every
  // fallback is exact for the DB it serves. This is what keeps the grid
  // rendering in the window between a code deploy and its patch being applied
  // — degraded (the dropped feature is invisible), never a 500.
  const selectSlots = (columns: string) => sb
    .from('schedule_slots')
    .select(columns)
    .eq('schedule_version_id', version.id)
    .order('slot_date')
    .order('slot_index') as unknown as Promise<{
      data: unknown; error: { message: string; code?: string } | null;
    }>;

  let slotRes = await selectSlots(GRID_SLOT_COLUMNS);
  if (slotRes.error && isMissingColumnErr(slotRes.error)) {
    // Pre-patch42 DB: assignments.highlight_color doesn't exist yet — and can
    // hold no manual mark, so the narrow select is exact (every cell unmarked).
    slotRes = await selectSlots(GRID_SLOT_COLUMNS_PRE42);
  }
  if (slotRes.error && isMissingColumnErr(slotRes.error)) {
    // Pre-patch35 DB: the call-split columns don't exist yet — and can hold
    // no segments, so the narrow select is exact (weights default to 1).
    slotRes = await selectSlots(GRID_SLOT_COLUMNS_PRE35);
  }
  const rawSlots = slotRes.data as Array<{ assignments?: unknown }> | null;
  const slotErr = slotRes.error;
  if (slotErr) return NextResponse.json({ error: slotErr.message }, { status: 500 });

  // UNIQUE(schedule_slot_id) makes PostgREST return the assignments embed as
  // a SINGLE OBJECT (or null), not an array — embedArray normalizes both.
  type RawAssignment = { validation_flags?: unknown };
  const slots = ((rawSlots ?? []) as Array<{ assignments?: RawAssignment | RawAssignment[] | null }>).map(s => ({
    ...s,
    assignments: embedArray(s.assignments).map(withValidationSummary),
  }));

  // 4. Fetch providers for org filtered by provider_group
  let providerQuery = sb
    .from('providers')
    .select('id, first_name, last_name, short_display_name, initials, provider_type, status')
    .eq('organization_id', schedule.organization_id)
    .eq('status', 'active')
    .order('last_name');

  if (schedule.provider_group === 'physician') {
    providerQuery = providerQuery.eq('provider_type', 'physician');
  } else if (schedule.provider_group === 'crna') {
    providerQuery = providerQuery.eq('provider_type', 'crna');
  }

  const { data: providers, error: provErr } = await providerQuery;
  if (provErr) return NextResponse.json({ error: provErr.message }, { status: 500 });

  // 5. Fetch holidays within schedule date range
  const { data: holidays, error: holErr } = await sb
    .from('holiday_calendars')
    .select('holiday_date, holiday_name, holiday_type, is_major_holiday')
    .eq('organization_id', schedule.organization_id)
    .gte('holiday_date', schedule.date_start)
    .lte('holiday_date', schedule.date_end);
  if (holErr) return NextResponse.json({ error: holErr.message }, { status: 500 });

  // 6. Fetch employment profiles so the UI can tell which providers are
  //    home-site (for Off rows) and their call-taker status. available_weekdays
  //    (2026-07-28) additionally powers the picker's weekday gate.
  //
  //    work_days_fte (patch43) additionally feeds the Call Counts modal's
  //    Working Days / Days Off columns.
  //
  //    NARROW-RETRY LADDER: this read deliberately swallows its error (a
  //    profile failure must not 500 the grid), which means a missing column
  //    would blank EVERY profile and silently kill the Off/Available rows. So
  //    the wide select walks GRID_PROFILE_LADDER down on a missing-column
  //    error — an absent column can hold no value, so each rung is exact
  //    (normalizeWeekdays coerces an absent weekday pattern to all-true, i.e.
  //    "no stated restriction"; an absent work_days_fte means the working-days
  //    contract derives from fte_value — both being what a DB without the
  //    column means).
  const providerIds = (providers || []).map(p => p.id);
  const selectProfiles = (columns: string) => sb
    .from('provider_employment_profiles')
    .select(columns)
    .in('provider_id', providerIds) as unknown as Promise<{
      data: unknown; error: { message: string; code?: string } | null;
    }>;

  let profileRes: { data: unknown; error: { message: string; code?: string } | null } =
    { data: [], error: null };
  if (providerIds.length > 0) {
    for (const columns of GRID_PROFILE_LADDER) {
      profileRes = await selectProfiles(columns);
      if (!profileRes.error || !isMissingColumnErr(profileRes.error)) break;
    }
  }
  const profiles = profileRes.data as unknown[] | null;

  // 7. Fetch availability entries (PTO, sick, unavailable, etc.) overlapping
  //    the schedule date range.
  const { data: availability, error: availErr } = providerIds.length > 0
    ? await sb
        .from('provider_availability')
        // NOTE: column is `reason_code`, not `reason`. Supabase returns an
        // error if you select a missing column — and because the code
        // downstream only destructured `data`, the whole availability
        // array silently ended up as null/empty. That's what was hiding
        // every PTO entry from the grid, the Call Counts modal, and the
        // PTO virtual row. We now also capture `error` so a future column
        // rename fails loudly instead of silently.
        .select('provider_id, availability_type, start_date, end_date, approval_status, reason_code')
        .in('provider_id', providerIds)
        .lte('start_date', schedule.date_end)
        .gte('end_date', schedule.date_start)
    : { data: [], error: null };
  if (availErr) return NextResponse.json({ error: availErr.message }, { status: 500 });

  // 8. Site's ACTIVE call pattern (2026-07-27) — the Call Counts modal's
  //    Obligatory Weekends column needs `neuroWeekend.code` to separate the
  //    neuro weekend duty (counted per Sat+Sun pair) from the primary-call
  //    weekend duty (counted per day). Parsed here so zod stays out of the
  //    client bundle. Degrades to null on EVERY failure path — missing table,
  //    read error, no active row, or a definition that fails validation —
  //    mirroring genContext's loadCallPattern posture: a bad pattern must
  //    never break the modal, it only drops the neuro term (the column falls
  //    back to primary-call weekend days alone).
  let callPattern: CallPatternDoc | null = null;
  try {
    const { data: patRow } = await sb
      .from('call_patterns')
      .select('definition')
      .eq('site_id', schedule.site_id)
      .eq('status', 'active')
      .maybeSingle();
    const definition = (patRow as { definition?: unknown } | null)?.definition;
    if (definition != null) {
      const parsed = CallPatternDocSchema.safeParse(definition);
      if (parsed.success) callPattern = parsed.data;
    }
  } catch { /* table missing on a pre-patch18 DB — no neuro term */ }

  // 9. Site credentials for the roster (2026-07-28) — who may take call at all
  //    at this site, and which codes/day types they are cleared for. Same shape
  //    loadGenerationContext builds (genContext §4), so the picker can apply the
  //    engine's credential gate rule-for-rule.
  //
  //    DEGRADATION: `null`, never `[]`. An empty array means "checked, nobody
  //    is restricted"; null means "not checked", which the picker surfaces to
  //    the user. Conflating the two would let a transient read failure present
  //    an uncredentialed provider as available with no warning anywhere.
  let credentials: CandidateCredentialRow[] | null = null;
  if (providerIds.length > 0) {
    try {
      const credRes = await sb
        .from('provider_site_credentials')
        .select(GRID_CREDENTIAL_COLUMNS)
        .eq('site_id', schedule.site_id)
        .in('provider_id', providerIds);
      if (!credRes.error) credentials = (credRes.data ?? []) as CandidateCredentialRow[];
    } catch { /* relation missing on an old DB — credentials go unchecked */ }
  } else {
    credentials = [];
  }

  // 10. Cross-site bookings (2026-07-28) — clinical invariant 3: a provider
  //     assigned in a PUBLISHED version at ANY other schedule/site on a date in
  //     this block cannot also be placed here. The committed ("published")
  //     predicate is single-homed in committedAssignments.ts and MUST NOT be
  //     re-inlined; this route is a caller like the engine's.
  //
  //     Exclusion is by parent SCHEDULE, not version: sibling versions of this
  //     schedule are clones (the versions route copies slots+assignments), so
  //     counting them would make every draft self-conflict. Same choice
  //     genContext §6 and dayShiftAutoGen §5 make.
  //
  //     The window starts ONE DAY BEFORE date_start so a rest-requiring call
  //     the day before the block still earns its post-call day off on day 1
  //     (invariant 1) — the joined requires_post_call_rule flag is what carries
  //     it. Same widening dayShiftAutoGen uses.
  //
  //     DEGRADATION: `null` = not checked (see step 9).
  let crossSite: CrossSiteBookingRow[] | null = null;
  if (providerIds.length > 0) {
    try {
      const { data: crossRows, error: crossErr } = await fetchCommittedAssignments(
        sb,
        GRID_CROSS_SITE_COLUMNS,
        {
          providerIds,
          start: addDays(schedule.date_start, -1),
          end: schedule.date_end,
          excludeScheduleId: id,
        },
      );
      if (!crossErr) {
        crossSite = [];
        for (const row of (crossRows ?? []) as Array<Record<string, unknown>>) {
          const ss = row.schedule_slots as {
            slot_date?: string;
            shift_types?: { requires_post_call_rule?: boolean | null } | null;
          } | null;
          const pid = row.provider_id as string | null;
          if (!pid || !ss?.slot_date) continue;
          crossSite.push({
            provider_id: pid,
            slot_date: ss.slot_date,
            requires_post_call_rule: ss.shift_types?.requires_post_call_rule === true,
          });
        }
      }
    } catch { /* embed unsupported on an old DB — cross-site goes unchecked */ }
  } else {
    crossSite = [];
  }

  return NextResponse.json({
    schedule,
    version,
    slots: slots || [],
    providers: providers || [],
    holidays: holidays || [],
    profiles: profiles || [],
    availability: availability || [],
    callPattern,
    credentials,
    crossSite,
  }, {
    headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
  });
}
