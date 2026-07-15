import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { fetchCommittedAssignments } from '@/lib/rulesEngine/committedAssignments';

// GET /api/scheduling/providers/:id/burden?from=...&to=...
// Computes call burden from assignments on-the-fly.
// Returns per-category counts + a flat list of assignments for history display.
// Never prerender — this route hits Supabase per request.
export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: providerId } = await params;
  const sb = sbSchedulingServer();
  const { searchParams } = new URL(req.url);

  // Default period: current calendar year
  const now = new Date();
  const from = searchParams.get('from') || `${now.getFullYear()}-01-01`;
  const to = searchParams.get('to') || `${now.getFullYear()}-12-31`;

  // Fetch this provider's COMMITTED assignments in the window (draft isolation:
  // only PUBLISHED versions count toward burden — an unpublished draft is not a
  // real booking). No current-version context here — this is pure committed
  // reporting, so it funnels straight through the shared committed-scope helper.
  const { data: assignments, error } = await fetchCommittedAssignments(
    sb,
    'id, assignment_status, source_type, assigned_at, schedule_slots!inner(slot_date, derived_day_type, site_id, schedule_versions!inner(version_status), shift_types(code, name, category, counts_toward_call_burden, counts_as_weekend_burden, counts_as_holiday_burden))',
    { providerId, start: from, end: to },
  );

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Compute burden categories
  const burden: Record<string, number> = {
    total_assignments: 0,
    weekday_call: 0,
    friday_call: 0,
    weekend_call: 0,
    holiday_call: 0,
    total_call: 0,
  };

  const history: Array<{
    id: string;
    slot_date: string;
    shift_code: string;
    shift_name: string;
    shift_category: string;
    day_type: string | null;
    source_type: string;
    site_id: string;
  }> = [];

  for (const row of (assignments || []) as Array<Record<string, unknown>>) {
    const slot = row.schedule_slots as Record<string, unknown>;
    if (!slot) continue;
    const st = slot.shift_types as Record<string, unknown> | null;
    if (!st) continue;

    const dayType = (slot.derived_day_type as string) || null;
    const category = st.category as string;
    const isCalled = st.counts_toward_call_burden as boolean;

    burden.total_assignments++;

    if (isCalled || category === 'call') {
      burden.total_call++;
      if (dayType === 'weekday') burden.weekday_call++;
      else if (dayType === 'friday') burden.friday_call++;
      else if (dayType === 'saturday' || dayType === 'sunday') burden.weekend_call++;
      else if (dayType === 'federal_holiday' || dayType === 'major_holiday') burden.holiday_call++;
    }

    history.push({
      id: row.id as string,
      slot_date: slot.slot_date as string,
      shift_code: st.code as string,
      shift_name: st.name as string,
      shift_category: category,
      day_type: dayType,
      source_type: row.source_type as string,
      site_id: slot.site_id as string,
    });
  }

  // Newest-first (the helper does not order; the previous DB query did).
  history.sort((a, b) => b.slot_date.localeCompare(a.slot_date));

  return NextResponse.json({ period: { from, to }, burden, history });
}
