import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { evaluateAssignment } from '@/lib/rulesEngine/evaluate';

// Never prerender — this route hits Supabase per request.
export const dynamic = 'force-dynamic';

// POST /api/scheduling/schedule-assignments/[id]/validate
// Re-runs the rules engine for an existing assignment and persists the result.
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const sb = sbSchedulingServer();

  const { data: assignment, error: aErr } = await sb
    .from('assignments')
    .select('id, schedule_slot_id, provider_id')
    .eq('id', params.id)
    .maybeSingle();
  if (aErr || !assignment) {
    return NextResponse.json({ error: 'assignment not found' }, { status: 404 });
  }

  const result = await evaluateAssignment(
    sb,
    (assignment as { schedule_slot_id: string }).schedule_slot_id,
    (assignment as { provider_id: string | null }).provider_id,
  );

  await sb
    .from('assignments')
    .update({ validation_flags: result.violations })
    .eq('id', params.id);

  return NextResponse.json(result);
}
