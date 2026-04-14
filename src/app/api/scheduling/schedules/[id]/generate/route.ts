import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { autoGenerate } from '@/lib/rulesEngine/autoGenerate';

export const dynamic = 'force-dynamic';

// POST /api/scheduling/schedules/:id/generate
// Runs the auto-generation engine on the latest version of this schedule.
// Fills open slots using active rules. Does NOT overwrite manual assignments.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: scheduleId } = await params;
  const sb = sbSchedulingServer();

  // Find the latest version for this schedule
  const { data: version, error: verErr } = await sb
    .from('schedule_versions')
    .select('id')
    .eq('schedule_id', scheduleId)
    .order('version_number', { ascending: false })
    .limit(1)
    .single();

  if (verErr || !version) {
    return NextResponse.json(
      { error: 'No schedule version found' },
      { status: 404 },
    );
  }

  const result = await autoGenerate(sb, version.id);

  return NextResponse.json(result);
}
